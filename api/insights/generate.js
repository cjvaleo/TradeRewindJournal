// POST /api/insights/generate — The Brief's insight endpoint.
//
// Deterministic, no AI: builds a 30-day analytics object from the user's
// trades and renders one of four templated insight types. No cache (a
// few queries + math is fast) and no failure fallback (nothing to fail).
//
// Request:  { type: 'headline' | 'working' | 'off' | 'heads_up' }
// Gating:   Pro-only (403 for free). <10 trades in the window → locked.

import { sbAnon, sbService } from '../_lib/supabase.js';
import { buildTraderAnalytics } from '../_lib/trade-analytics.js';
import { renderInsight, INSIGHT_TYPES } from '../_lib/insight-templates.js';

const TRADE_THRESHOLD = 10;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed', allowed: ['POST'] });
    return;
  }

  // ── Auth: Supabase Bearer ───────────────────────────────────────
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) { res.status(401).json({ error: 'auth required' }); return; }

  let user;
  try {
    const { data, error } = await sbAnon().auth.getUser(token);
    if (error || !data.user) throw new Error('invalid token');
    user = data.user;
  } catch (e) {
    console.warn('[insights/generate] auth failed:', e && e.message);
    res.status(401).json({ error: 'auth required' });
    return;
  }

  // ── Validate body ───────────────────────────────────────────────
  const type = req.body && req.body.type;
  if (!type || INSIGHT_TYPES.indexOf(type) < 0) {
    res.status(400).json({ error: 'invalid type', allowed: INSIGHT_TYPES });
    return;
  }

  // ── Pro gate (same shape as api/me.js) ──────────────────────────
  const sb = sbService();
  const { data: profile, error: pErr } = await sb
    .from('profiles')
    .select('is_pro, pro_source, pro_active_until')
    .eq('id', user.id)
    .maybeSingle();
  if (pErr) {
    console.error('[insights/generate] profile read failed:', pErr.message);
    res.status(500).json({ error: 'profile read failed' });
    return;
  }
  const untilMs = profile && profile.pro_active_until ? Date.parse(profile.pro_active_until) : 0;
  const isPro = !!(profile && profile.is_pro && profile.pro_source && untilMs > Date.now());
  if (!isPro) {
    res.status(403).json({
      error: 'pro_required',
      message: 'The Brief is a Pro feature — upgrade to unlock insights from your trade history.',
    });
    return;
  }

  // ── Build the 30-day analytics object ───────────────────────────
  let analytics;
  try {
    analytics = await buildTraderAnalytics(user.id);
  } catch (e) {
    console.error('[insights/generate] analytics build failed:', e && e.message);
    res.status(500).json({ error: 'analytics_failed' });
    return;
  }

  // ── Trade-count lock (window count) ─────────────────────────────
  if (analytics.trade_count < TRADE_THRESHOLD) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({
      status: 'locked',
      trade_count: analytics.trade_count,
      total_trade_count: analytics.total_trade_count,
      threshold: TRADE_THRESHOLD,
    });
    return;
  }

  // ── Render the requested insight ────────────────────────────────
  let payload;
  try {
    payload = renderInsight(type, analytics);
  } catch (e) {
    console.error('[insights/generate] render failed:', e && e.message);
    res.status(500).json({ error: 'render_failed' });
    return;
  }

  res.setHeader('Cache-Control', 'no-store');
  console.log('[insights/generate]', { user_id: user.id, type, trades: analytics.trade_count });
  res.status(200).json({
    status: 'ok',
    type,
    payload,
    generated_at: new Date().toISOString(),
  });
}
