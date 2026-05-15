import { sbAnon, sbService } from './_lib/supabase.js';

// Maps profiles.pro_source → public tier label returned to the SPA.
// Valid pro_source values (post May-2026 consolidation):
//   stripe_direct   → pro_direct   ($19/mo Stripe — the only paid path)
//   discord_premium → pro_premium  (Trading Ark Premium role — free Pro)
//   discord_elite   → pro_elite    (Elite role retired; kept for safety)
// `stripe_premium` was removed — the $9/mo Premium-via-Stripe path is gone
// and the DB CHECK constraint never allowed that value anyway.
const TIER_MAP = {
  stripe_direct:   'pro_direct',
  discord_premium: 'pro_premium',
  discord_elite:   'pro_elite',
};

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'method not allowed', allowed: ['GET'] });
    return;
  }

  // ── Auth: Supabase Bearer ───────────────────────────────────────
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) {
    res.status(401).json({ error: 'auth required' });
    return;
  }

  let user;
  try {
    const { data, error } = await sbAnon().auth.getUser(token);
    if (error || !data.user) throw new Error('invalid token');
    user = data.user;
  } catch (e) {
    console.warn('[api/me] auth check failed:', e && e.message);
    res.status(401).json({ error: 'auth required' });
    return;
  }

  // ── Read profile ────────────────────────────────────────────────
  const sb = sbService();
  const { data: profile, error: readErr } = await sb
    .from('profiles')
    .select('is_pro, pro_source, pro_active_until, stripe_subscription_id, discord_user_id')
    .eq('id', user.id)
    .maybeSingle();
  if (readErr) {
    console.error('[api/me] profile read failed:', readErr.message);
    res.status(500).json({ error: 'profile read failed' });
    return;
  }

  // ── Compute tier shape ──────────────────────────────────────────
  let tier, isActive, activeUntil;
  if (!profile || !profile.is_pro || !profile.pro_source) {
    tier = 'free';
    isActive = false;
    activeUntil = null;
  } else {
    const untilMs = profile.pro_active_until
      ? new Date(profile.pro_active_until).getTime()
      : 0;
    isActive = !!(profile.is_pro && untilMs > Date.now());
    activeUntil = profile.pro_active_until || null;
    tier = isActive ? (TIER_MAP[profile.pro_source] || 'free') : 'free';
  }
  const hasDiscord = !!(profile && profile.discord_user_id);
  const hasStripe  = !!(profile && profile.stripe_subscription_id);

  // ── Respond (no-store: SPA polls this after checkout, never serve stale) ──
  res.setHeader('Cache-Control', 'no-store');
  console.log('[api/me] queried', { user_id: user.id, tier, isActive });
  res.status(200).json({ tier, isActive, activeUntil, hasDiscord, hasStripe });
}
