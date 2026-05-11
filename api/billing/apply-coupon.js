import { sbAnon, sbService } from '../_lib/supabase.js';
import { getStripe } from '../_lib/stripe.js';

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
    console.warn('[billing/apply-coupon] auth failed:', e && e.message);
    res.status(401).json({ error: 'auth required' });
    return;
  }

  // ── Env ─────────────────────────────────────────────────────────
  const couponId = process.env.STRIPE_COUPON_50_OFF_3MO;
  if (!couponId || !process.env.STRIPE_SECRET_KEY) {
    console.error('[billing/apply-coupon] missing env', {
      hasCoupon: !!couponId, hasStripeKey: !!process.env.STRIPE_SECRET_KEY,
    });
    res.status(500).json({ error: 'server misconfigured' });
    return;
  }

  // ── Look up sub_id on profile ───────────────────────────────────
  const sb = sbService();
  const { data: profile, error: pErr } = await sb
    .from('profiles')
    .select('stripe_subscription_id')
    .eq('id', user.id)
    .maybeSingle();
  if (pErr) {
    console.error('[billing/apply-coupon] profile read failed:', pErr.message);
    res.status(500).json({ error: 'profile read failed' });
    return;
  }
  if (!profile || !profile.stripe_subscription_id) {
    res.status(400).json({ error: 'no active subscription' });
    return;
  }

  // ── Apply coupon to sub ─────────────────────────────────────────
  const stripe = getStripe();
  try {
    await stripe.subscriptions.update(profile.stripe_subscription_id, {
      coupon: couponId,
    });
  } catch (e) {
    console.error('[billing/apply-coupon] stripe update failed:', e && e.message);
    res.status(500).json({ error: 'stripe update failed' });
    return;
  }

  // ── Log the save (don't fail request if log insert fails) ───────
  const { error: insErr } = await sb.from('cancellation_reasons').insert({
    user_id: user.id,
    reason: 'too_expensive',
    prevented_by_offer: true,
    save_offer_type: 'discount_50_3mo',
  });
  if (insErr) {
    console.warn('[billing/apply-coupon] cancellation_reasons insert failed:', insErr.message);
  }

  console.log('[billing/apply-coupon] applied', {
    user_id: user.id, subscription_id: profile.stripe_subscription_id,
  });
  res.status(200).json({ ok: true });
}
