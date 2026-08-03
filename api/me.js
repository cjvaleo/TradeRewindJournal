import { sbAnon, sbService } from './_lib/supabase.js';

// Maps profiles.pro_source → public tier label returned to the SPA.
// Access comes solely from the Discord role gate (Stripe removed Aug 2026):
//   discord_premium → pro_premium  (Trading Ark Premium role)
//   discord_elite   → pro_elite    (OG/Elite role)
const TIER_MAP = {
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
    .select('is_pro, pro_source, pro_active_until, discord_user_id')
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

  // ── Respond (no-store: welcome pages poll this, never serve stale) ──
  res.setHeader('Cache-Control', 'no-store');
  console.log('[api/me] queried', { user_id: user.id, tier, isActive });
  res.status(200).json({ tier, isActive, activeUntil, hasDiscord });
}
