import { sbAnon, sbService } from '../_lib/supabase.js';
import { getStripe } from '../_lib/stripe.js';

const ALLOWED_REASONS = new Set([
  'too_expensive',
  'not_using',
  'missing_features',
  'switching',
  'exploring',
  'other',
]);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed', allowed: ['POST'] });
    return;
  }

  // ── Auth ────────────────────────────────────────────────────────
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) { res.status(401).json({ error: 'auth required' }); return; }

  let user;
  try {
    const { data, error } = await sbAnon().auth.getUser(token);
    if (error || !data.user) throw new Error('invalid token');
    user = data.user;
  } catch (e) {
    console.warn('[billing/cancel] auth failed:', e && e.message);
    res.status(401).json({ error: 'auth required' });
    return;
  }

  // ── Validate body ───────────────────────────────────────────────
  const reason = req.body && req.body.reason;
  if (!reason || !ALLOWED_REASONS.has(reason)) {
    res.status(400).json({
      error: 'invalid reason',
      allowed: Array.from(ALLOWED_REASONS),
    });
    return;
  }

  // ── Env ─────────────────────────────────────────────────────────
  if (!process.env.STRIPE_SECRET_KEY) {
    console.error('[billing/cancel] missing STRIPE_SECRET_KEY');
    res.status(500).json({ error: 'server misconfigured' });
    return;
  }

  // ── Look up sub + pro_active_until ──────────────────────────────
  const sb = sbService();
  const { data: profile, error: pErr } = await sb
    .from('profiles')
    .select('stripe_subscription_id, pro_active_until')
    .eq('id', user.id)
    .maybeSingle();
  if (pErr) {
    console.error('[billing/cancel] profile read failed:', pErr.message);
    res.status(500).json({ error: 'profile read failed' });
    return;
  }
  if (!profile || !profile.stripe_subscription_id) {
    res.status(400).json({ error: 'no active subscription' });
    return;
  }

  // ── Cancel at period end (keeps Pro until then) ─────────────────
  // We don't delete the sub now — Stripe runs it out to period_end then
  // fires customer.subscription.deleted, which our webhook handles
  // (carve-out preserves Pro for discord_elite users).
  const stripe = getStripe();
  try {
    await stripe.subscriptions.update(profile.stripe_subscription_id, {
      cancel_at_period_end: true,
    });
  } catch (e) {
    console.error('[billing/cancel] stripe update failed:', e && e.message);
    res.status(500).json({ error: 'stripe update failed' });
    return;
  }

  // ── Log the cancellation ────────────────────────────────────────
  const { error: insErr } = await sb.from('cancellation_reasons').insert({
    user_id: user.id,
    reason,
    prevented_by_offer: false,
    save_offer_type: null,
  });
  if (insErr) {
    console.warn('[billing/cancel] cancellation_reasons insert failed:', insErr.message);
  }

  console.log('[billing/cancel] scheduled', {
    user_id: user.id,
    subscription_id: profile.stripe_subscription_id,
    reason,
  });
  // active_until = profile.pro_active_until (period_end + 7d grace from
  // last invoice.paid webhook). What the SPA shows the user.
  res.status(200).json({
    ok: true,
    active_until: profile.pro_active_until,
  });
}
