// Vercel Edge runtime — bypasses @vercel/node's automatic JSON body parsing.
// Node mode parses `application/json` regardless of `config.api.bodyParser`,
// which destroys the raw bytes Stripe needs for signature verification.
// Edge gives us request.text() returning the exact bytes off the wire.
//
// Other routes stay on the Node runtime; runtime is per-file in Vercel.
//
// Local dev: STRIPE_WEBHOOK_SECRET must match the secret printed by
// `stripe listen --forward-to localhost:3000/api/stripe/webhook`.
// Production: dashboard's signing secret. Swap before deploying.

import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

export const config = { runtime: 'edge' };

const PROVIDER = 'stripe';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

let _stripe;
function getStripe() {
  // createFetchHttpClient() makes the Stripe SDK use the global fetch
  // (Edge-compatible) instead of node:http.
  if (_stripe) return _stripe;
  _stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
    apiVersion: '2024-12-18.acacia',
    httpClient: Stripe.createFetchHttpClient(),
  });
  return _stripe;
}

// Inline a fresh service-role client here. The shared api/_lib/supabase.js
// is fine for Node routes; this Edge route avoids importing from it so the
// dependency graph stays clean (Edge bundle doesn't pull in Node-only paths).
let _sb;
function getSb() {
  if (_sb) return _sb;
  _sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
      },
    }
  );
  return _sb;
}

// Insert via UNIQUE(provider, event_id). Returns true if new, false if dup.
async function insertEvent(sb, event) {
  const { data, error } = await sb.from('webhook_events').insert({
    provider:   PROVIDER,
    event_id:   event.id,
    event_type: event.type,
    payload:    event.data,
    status:     'received',
  }).select('id');
  if (error) {
    if (error.code === '23505') return false; // unique_violation
    throw error;
  }
  return !!(data && data.length);
}

async function markEventProcessed(sb, eventId) {
  await sb.from('webhook_events')
    .update({ status: 'processed', processed_at: new Date().toISOString() })
    .eq('provider', PROVIDER).eq('event_id', eventId);
}

async function markEventFailed(sb, eventId, msg) {
  const trimmed = (msg && String(msg).slice(0, 1000)) || 'unknown error';
  await sb.from('webhook_events')
    .update({
      status: 'failed',
      error_message: trimmed,
      processed_at: new Date().toISOString(),
    })
    .eq('provider', PROVIDER).eq('event_id', eventId);
}

// ── Event handlers ──────────────────────────────────────────────

async function onCheckoutCompleted(sb, event) {
  const session = event.data.object;
  const userId = session.client_reference_id;
  const subscriptionId = session.subscription;
  if (!userId)         throw new Error('missing client_reference_id');
  if (!subscriptionId) throw new Error('missing subscription on session');

  // Fetch the subscription to read metadata.plan + current_period_end.
  // subscription_data.metadata was set at checkout creation, so .plan is here.
  const subscription = await getStripe().subscriptions.retrieve(subscriptionId);
  const plan = subscription.metadata && subscription.metadata.plan;
  if (plan !== 'direct' && plan !== 'premium') {
    throw new Error(`unknown plan in subscription metadata: ${plan}`);
  }
  if (typeof subscription.current_period_end !== 'number') {
    throw new Error('missing current_period_end on subscription');
  }
  const newWindowMs = subscription.current_period_end * 1000 + 7 * 86400 * 1000;

  // Read current row for the carve-out + MAX() computation.
  const { data: profile, error: readErr } = await sb
    .from('profiles')
    .select('pro_source, pro_active_until')
    .eq('id', userId)
    .single();
  if (readErr) throw new Error(`profile read failed: ${readErr.message}`);

  const currentUntilMs = profile.pro_active_until
    ? new Date(profile.pro_active_until).getTime()
    : 0;
  // Carve-out: if the user already holds Discord-Elite with an active window,
  // Stripe checkout (even for Premium) MUST NOT downgrade pro_source. Without
  // this, a later Stripe cancellation would incorrectly drop them off Pro
  // even though their Discord role still entitles them.
  const keepDiscordElite =
    profile.pro_source === 'discord_elite' && currentUntilMs > Date.now();
  const newProSource = keepDiscordElite ? 'discord_elite' : `stripe_${plan}`;
  const finalProUntilIso = new Date(Math.max(currentUntilMs, newWindowMs)).toISOString();

  const { error: upErr } = await sb
    .from('profiles')
    .update({
      stripe_subscription_id: subscriptionId,
      is_pro: true,
      pro_source: newProSource,
      pro_active_until: finalProUntilIso,
    })
    .eq('id', userId);
  if (upErr) throw new Error(`profile update failed: ${upErr.message}`);

  console.log('[webhook] checkout.session.completed processed', {
    user_id: userId,
    subscription_id: subscriptionId,
    plan,
    pro_source: newProSource,
    pro_active_until: finalProUntilIso,
  });
}

export default async function handler(request) {
  if (request.method !== 'POST') {
    return json({ error: 'method not allowed', allowed: ['POST'] }, 405);
  }

  const whSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!whSecret) {
    console.error('[webhook] missing STRIPE_WEBHOOK_SECRET');
    return json({ error: 'server misconfigured' }, 500);
  }

  // 1. Raw body — Edge's request.text() returns the exact bytes Stripe sent
  //    (which is pretty-printed JSON, not minified — re-serializing the parsed
  //    object would not match the signature, so the Node runtime + body-parser
  //    workaround was a dead end).
  const rawBody = await request.text();
  const sig = request.headers.get('stripe-signature');

  // 2. Signature verification — async variant uses Web Crypto (Edge-compatible).
  let event;
  try {
    event = await getStripe().webhooks.constructEventAsync(rawBody, sig, whSecret);
  } catch (e) {
    console.warn('[webhook] signature verification failed:', e && e.message);
    return json({ error: 'invalid signature' }, 400);
  }

  console.log('[webhook] received', { event_id: event.id, event_type: event.type });

  // 3. Idempotency — insert first, before any business logic.
  const sb = getSb();
  let isNew;
  try {
    isNew = await insertEvent(sb, event);
  } catch (e) {
    console.error('[webhook] event insert failed:', e && e.message);
    return json({ error: 'event insert failed' }, 500);
  }
  if (!isNew) {
    console.log('[webhook] duplicate, acking', { event_id: event.id });
    return json({ received: true, duplicate: true }, 200);
  }

  // 4. Route to handler. Phase A: all events are no-ops; just acknowledge.
  //    Phases B-E will fill these in.
  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await onCheckoutCompleted(sb, event);
        break;
      // Phase C: case 'invoice.paid':                  await onInvoicePaid(sb, event); break;
      // Phase D: case 'invoice.payment_failed':        await onPaymentFailed(sb, event); break;
      // Phase E: case 'customer.subscription.deleted': await onSubscriptionDeleted(sb, event); break;
      case 'customer.subscription.updated':
        // Logged via insertEvent; no profile mutation per spec.
        break;
      default:
        // Acknowledged via insertEvent; no-op.
        break;
    }
    await markEventProcessed(sb, event.id);
  } catch (e) {
    console.error('[webhook] handler failed', {
      event_id: event.id, event_type: event.type, msg: e && e.message,
    });
    await markEventFailed(sb, event.id, e && e.message);
  }

  return json({ received: true }, 200);
}
