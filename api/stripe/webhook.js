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
import { joinTradingArk } from '../../lib/community.js';

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

  // Premium plan: auto-join Trading Ark community. Direct does NOT auto-join.
  // Idempotent + graceful — log on failure but never throw (would otherwise
  // mark the whole webhook_event row 'failed' for a side-effect-only failure).
  if (plan === 'premium') {
    try {
      const joinRes = await joinTradingArk(sb, userId);
      console.log('[community-autojoin] Stripe Premium webhook', userId, joinRes);
    } catch (e) {
      console.warn('[community-autojoin] Stripe Premium webhook threw', userId, e && e.message);
    }
  }
}

async function onInvoicePaid(sb, event) {
  const inv = event.data.object;
  const subscriptionId = inv.subscription;
  if (!subscriptionId) {
    console.log('[webhook] invoice.paid: no subscription on invoice, skipping');
    return;
  }

  const { data: profile, error: readErr } = await sb
    .from('profiles')
    .select('id, pro_active_until')
    .eq('stripe_subscription_id', subscriptionId)
    .maybeSingle();
  if (readErr) throw new Error(`profile read failed: ${readErr.message}`);
  if (!profile) {
    // Common during `stripe trigger invoice.paid` (fake subscription IDs).
    // Also legitimate if subscription was created outside our flow. Ack gracefully.
    console.warn('[webhook] invoice.paid: no profile for subscription', {
      subscription_id: subscriptionId,
    });
    return;
  }

  if (typeof inv.period_end !== 'number') {
    throw new Error('invoice.paid missing period_end');
  }
  const newWindowMs = inv.period_end * 1000 + 7 * 86400 * 1000;
  const currentUntilMs = profile.pro_active_until
    ? new Date(profile.pro_active_until).getTime()
    : 0;
  const finalProUntilIso = new Date(Math.max(currentUntilMs, newWindowMs)).toISOString();

  const { error: upErr } = await sb
    .from('profiles')
    .update({
      is_pro: true,
      pro_active_until: finalProUntilIso,
    })
    .eq('id', profile.id);
  if (upErr) throw new Error(`profile update failed: ${upErr.message}`);

  console.log('[webhook] invoice.paid processed', {
    user_id: profile.id,
    subscription_id: subscriptionId,
    pro_active_until: finalProUntilIso,
  });
}

async function onInvoicePaymentFailed(sb, event) {
  const inv = event.data.object;
  const subscriptionId = inv.subscription;
  if (!subscriptionId) {
    console.log('[webhook] invoice.payment_failed: no subscription on invoice, skipping');
    return;
  }

  const { data: profile, error: readErr } = await sb
    .from('profiles')
    .select('id')
    .eq('stripe_subscription_id', subscriptionId)
    .maybeSingle();
  if (readErr) throw new Error(`profile read failed: ${readErr.message}`);
  if (!profile) {
    console.warn('[webhook] invoice.payment_failed: no profile for subscription', {
      subscription_id: subscriptionId,
    });
    return;
  }

  // Look up email from auth.users via service role admin API. If it fails,
  // queue with a placeholder rather than dropping the email — the queued row
  // is useful as a signal even without a deliverable address (manual recovery).
  let toAddress = null;
  try {
    const { data: userData, error } = await sb.auth.admin.getUserById(profile.id);
    if (!error && userData && userData.user && userData.user.email) {
      toAddress = userData.user.email;
    }
  } catch (e) {
    console.warn('[webhook] invoice.payment_failed: email lookup threw', e && e.message);
  }
  if (!toAddress) {
    console.warn('[webhook] invoice.payment_failed: email unavailable, queueing with placeholder', {
      user_id: profile.id,
    });
    toAddress = 'unknown@placeholder.local';
  }

  const { error: insErr } = await sb.from('email_log').insert({
    user_id: profile.id,
    to_address: toAddress,
    template_id: 'payment-failed',
    subject: 'Payment issue with your Rewind subscription',
    status: 'queued',
  });
  if (insErr) throw new Error(`email_log insert failed: ${insErr.message}`);

  // Deliberately do NOT touch is_pro — the 7-day grace baked into
  // pro_active_until covers Stripe's dunning retry window.
  console.log('[webhook] invoice.payment_failed: email queued', {
    user_id: profile.id,
    subscription_id: subscriptionId,
  });
}

async function onSubscriptionDeleted(sb, event) {
  const sub = event.data.object;
  const subscriptionId = sub.id;
  if (!subscriptionId) {
    console.log('[webhook] customer.subscription.deleted: missing id on event, skipping');
    return;
  }

  const { data: profile, error: readErr } = await sb
    .from('profiles')
    .select('id, pro_source, pro_active_until')
    .eq('stripe_subscription_id', subscriptionId)
    .maybeSingle();
  if (readErr) throw new Error(`profile read failed: ${readErr.message}`);
  if (!profile) {
    console.warn('[webhook] customer.subscription.deleted: no profile for subscription', {
      subscription_id: subscriptionId,
    });
    return;
  }

  // Carve-out: Discord-Elite with active window keeps Pro even after the
  // paid sub is gone. Without this, an Elite user who briefly held a Stripe
  // sub would lose Pro on Stripe cancellation, despite still holding the role.
  const currentUntilMs = profile.pro_active_until
    ? new Date(profile.pro_active_until).getTime()
    : 0;
  const keepPro =
    profile.pro_source === 'discord_elite' && currentUntilMs > Date.now();

  const { error: upErr } = await sb
    .from('profiles')
    .update({
      is_pro: keepPro,
      pro_source: keepPro ? 'discord_elite' : null,
      stripe_subscription_id: null,
    })
    .eq('id', profile.id);
  if (upErr) throw new Error(`profile update failed: ${upErr.message}`);

  // Queue cancellation email — best effort, don't fail the webhook over it.
  try {
    const { data: userData } = await sb.auth.admin.getUserById(profile.id);
    const email = userData && userData.user && userData.user.email;
    if (email) {
      await sb.from('email_log').insert({
        user_id: profile.id,
        to_address: email,
        template_id: 'subscription-canceled',
        subject: 'Your Rewind subscription has ended',
        status: 'queued',
      });
    }
  } catch (e) {
    console.warn('[webhook] customer.subscription.deleted: email queue failed', e && e.message);
  }

  console.log('[webhook] customer.subscription.deleted processed', {
    user_id: profile.id,
    subscription_id: subscriptionId,
    keepPro,
    final_is_pro: keepPro,
    final_pro_source: keepPro ? 'discord_elite' : null,
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
      case 'invoice.paid':
        await onInvoicePaid(sb, event);
        break;
      case 'invoice.payment_failed':
        await onInvoicePaymentFailed(sb, event);
        break;
      case 'customer.subscription.deleted':
        await onSubscriptionDeleted(sb, event);
        break;
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
