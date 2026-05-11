import { sbAnon, sbService } from '../_lib/supabase.js';
import { getStripe } from '../_lib/stripe.js';

const PAUSE_DAYS = 30;
const DAY_SEC = 86400;

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
    console.warn('[billing/pause] auth failed:', e && e.message);
    res.status(401).json({ error: 'auth required' });
    return;
  }

  // ── Env ─────────────────────────────────────────────────────────
  if (!process.env.STRIPE_SECRET_KEY) {
    console.error('[billing/pause] missing STRIPE_SECRET_KEY');
    res.status(500).json({ error: 'server misconfigured' });
    return;
  }

  // ── Look up sub_id ──────────────────────────────────────────────
  const sb = sbService();
  const { data: profile, error: pErr } = await sb
    .from('profiles')
    .select('stripe_subscription_id')
    .eq('id', user.id)
    .maybeSingle();
  if (pErr) {
    console.error('[billing/pause] profile read failed:', pErr.message);
    res.status(500).json({ error: 'profile read failed' });
    return;
  }
  if (!profile || !profile.stripe_subscription_id) {
    res.status(400).json({ error: 'no active subscription' });
    return;
  }

  // ── Pause collection for 30 days ────────────────────────────────
  // 'mark_uncollectible' marks future invoices as uncollectible (no
  // charge attempted) while sub stays active. `resumes_at` auto-resumes
  // billing at the unix timestamp. User can manually resume earlier.
  const resumesAt = Math.floor(Date.now() / 1000) + PAUSE_DAYS * DAY_SEC;
  const stripe = getStripe();
  try {
    await stripe.subscriptions.update(profile.stripe_subscription_id, {
      pause_collection: {
        behavior: 'mark_uncollectible',
        resumes_at: resumesAt,
      },
    });
  } catch (e) {
    console.error('[billing/pause] stripe update failed:', e && e.message);
    res.status(500).json({ error: 'stripe update failed' });
    return;
  }

  // ── Log the save ────────────────────────────────────────────────
  const { error: insErr } = await sb.from('cancellation_reasons').insert({
    user_id: user.id,
    reason: 'not_using',
    prevented_by_offer: true,
    save_offer_type: 'pause_30d',
  });
  if (insErr) {
    console.warn('[billing/pause] cancellation_reasons insert failed:', insErr.message);
  }

  console.log('[billing/pause] paused', {
    user_id: user.id,
    subscription_id: profile.stripe_subscription_id,
    resumes_at: resumesAt,
  });
  res.status(200).json({ ok: true, resumes_at: resumesAt });
}
