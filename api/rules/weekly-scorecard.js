// GET /api/rules/weekly-scorecard
// Adherence summary over the last 7 trading days — per-rule followed /
// broken / pending tallies, an adherence %, and the dollar cost of broken
// rules, plus an overall roll-up.

import { sbService } from '../_lib/supabase.js';
import { requirePro } from '../_lib/auth.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'method not allowed', allowed: ['GET'] });
    return;
  }
  const user = await requirePro(req, res);
  if (!user) return;

  const today = new Date();
  const from = new Date(today.getTime() - 6 * 864e5).toISOString().slice(0, 10); // inclusive 7-day window
  const to = today.toISOString().slice(0, 10);

  const { data, error } = await sbService()
    .from('rule_evaluations')
    .select('rule_id, status, cost_impact, trading_day, rules(name, cadence)')
    .eq('user_id', user.id)
    .gte('trading_day', from)
    .lte('trading_day', to);
  if (error) {
    console.error('[rules/weekly-scorecard] read failed:', error.message);
    res.status(500).json({ error: 'scorecard read failed' });
    return;
  }

  const evals = data || [];
  const byRule = {};
  let oFollowed = 0, oBroken = 0, oPending = 0, oCost = 0;

  for (const e of evals) {
    const r = byRule[e.rule_id] || (byRule[e.rule_id] = {
      rule_id: e.rule_id,
      name: (e.rules && e.rules.name) || 'Rule',
      cadence: (e.rules && e.rules.cadence) || null,
      followed: 0, broken: 0, pending_review: 0, total: 0, cost_impact: 0,
    });
    r.total++;
    if (e.status === 'followed') { r.followed++; oFollowed++; }
    else if (e.status === 'broken') { r.broken++; oBroken++; }
    else { r.pending_review++; oPending++; }
    const c = Number(e.cost_impact);
    if (Number.isFinite(c)) { r.cost_impact += c; oCost += c; }
  }

  const rules = Object.values(byRule).map(r => {
    const resolved = r.followed + r.broken;
    return {
      ...r,
      cost_impact: Math.round(r.cost_impact * 100) / 100,
      adherence_pct: resolved ? Math.round((r.followed / resolved) * 100) : null,
    };
  }).sort((a, b) => (a.adherence_pct ?? 101) - (b.adherence_pct ?? 101)); // weakest first

  const oResolved = oFollowed + oBroken;
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({
    window: { from, to },
    overall: {
      followed: oFollowed,
      broken: oBroken,
      pending_review: oPending,
      total: evals.length,
      adherence_pct: oResolved ? Math.round((oFollowed / oResolved) * 100) : null,
      cost_impact: Math.round(oCost * 100) / 100,
    },
    rules,
  });
}
