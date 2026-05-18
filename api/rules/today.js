// GET /api/rules/today
// The caller's rules to review now — split by cadence. intra_day rules
// are always returned; weekly rules surface only on Friday (the weekly
// review day). Each rule carries its saved status for the current cycle
// (today for intra_day, this week's Friday anchor for weekly) so the
// frontend can pre-select the YES/NO toggles. Pro-gated.

import { sbService } from '../_lib/supabase.js';
import { requirePro } from '../_lib/auth.js';

function utcToday() { return new Date().toISOString().slice(0, 10); }
// Friday (YYYY-MM-DD) of the current Mon–Sun week.
function weekAnchor() {
  const d = new Date();
  const day = d.getUTCDay();              // 0 Sun … 6 Sat
  const delta = day === 0 ? -2 : (day === 6 ? -1 : 5 - day);
  return new Date(d.getTime() + delta * 864e5).toISOString().slice(0, 10);
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'method not allowed', allowed: ['GET'] });
    return;
  }
  const user = await requirePro(req, res);
  if (!user) return;
  const sb = sbService();

  const { data: rules, error } = await sb
    .from('rules')
    .select('id, name, cadence, is_active')
    .eq('user_id', user.id)
    .eq('is_active', true);
  if (error) {
    console.error('[rules/today] rules read failed:', error.message);
    res.status(500).json({ error: 'rules read failed' });
    return;
  }

  const today = utcToday();
  const isFri = new Date().getUTCDay() === 5;
  const friAnchor = weekAnchor();
  const days = isFri ? [today, friAnchor] : [today];

  const { data: evals, error: eErr } = await sb
    .from('rule_evaluations')
    .select('rule_id, trading_day, status, evaluated_at')
    .eq('user_id', user.id)
    .in('trading_day', days);
  if (eErr) console.error('[rules/today] eval read failed:', eErr.message);
  // latest status per rule_id|trading_day
  const statusFor = {};
  (evals || []).forEach(function (e) {
    const k = e.rule_id + '|' + e.trading_day;
    const cur = statusFor[k];
    if (!cur || String(e.evaluated_at || '') > String(cur.evaluated_at || '')) statusFor[k] = e;
  });

  const intra_day = [], weekly = [];
  (rules || []).forEach(function (r) {
    if (r.cadence === 'weekly') {
      if (!isFri) return;                   // weekly section surfaces only on Friday
      const e = statusFor[r.id + '|' + friAnchor];
      weekly.push({ id: r.id, name: r.name, status: e ? e.status : null });
    } else {
      const e = statusFor[r.id + '|' + today];
      intra_day.push({ id: r.id, name: r.name, status: e ? e.status : null });
    }
  });

  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({
    trading_day: today,
    is_friday: isFri,
    week_anchor: friAnchor,
    intra_day: intra_day,
    weekly: weekly,
  });
}
