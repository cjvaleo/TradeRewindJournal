// POST /api/rules/evaluate  { trade_id }
// Runs the auto-eval engine for one trade against the caller's active
// rules, persists the results to rule_evaluations (idempotent — prior
// evaluations for the same trade are replaced), and returns them.

import { sbService } from '../_lib/supabase.js';
import { requirePro } from '../_lib/auth.js';
import { evaluateTrade } from '../_lib/rule-engine.js';

// Effective trading day for a trade — its logged date, else created_at.
function tradeDay(td, createdAt){
  if (td && typeof td.date === 'string' && /^\d{4}-\d{2}-\d{2}/.test(td.date)) return td.date.slice(0,10);
  if (typeof createdAt === 'string' && createdAt.length >= 10) return createdAt.slice(0,10);
  return null;
}
function normTrade(row){
  let td = row.trade_data;
  if (typeof td === 'string') { try { td = JSON.parse(td); } catch(e){ td = {}; } }
  if (!td || typeof td !== 'object') td = {};
  return { ...td, id: row.id, created_at: row.created_at };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed', allowed: ['POST'] });
    return;
  }
  const user = await requirePro(req, res);
  if (!user) return;

  const tradeId = req.body && req.body.trade_id != null ? String(req.body.trade_id) : null;
  if (!tradeId) { res.status(400).json({ error: 'trade_id required' }); return; }
  const sb = sbService();

  // ── The trade being evaluated ───────────────────────────────────
  const { data: tradeRow, error: tErr } = await sb
    .from('trades')
    .select('id, trade_data, created_at')
    .eq('id', tradeId)
    .eq('user_id', user.id)
    .maybeSingle();
  if (tErr) {
    console.error('[rules/evaluate] trade read failed:', tErr.message);
    res.status(500).json({ error: 'trade read failed' });
    return;
  }
  if (!tradeRow) { res.status(404).json({ error: 'trade not found' }); return; }
  const trade = normTrade(tradeRow);
  const trading_day = tradeDay(trade, tradeRow.created_at);
  if (!trading_day) { res.status(422).json({ error: 'trade has no resolvable date' }); return; }

  // ── Active rules ────────────────────────────────────────────────
  const { data: rules, error: rErr } = await sb
    .from('rules')
    .select('id, rule_type, condition')
    .eq('user_id', user.id)
    .eq('is_active', true);
  if (rErr) {
    console.error('[rules/evaluate] rules read failed:', rErr.message);
    res.status(500).json({ error: 'rules read failed' });
    return;
  }
  if (!rules || !rules.length) {
    res.status(200).json({ trade_id: tradeId, trading_day, evaluations: [], note: 'no active rules' });
    return;
  }

  // ── Day context — every trade on the same trading day, chronological ──
  const { data: allRows, error: aErr } = await sb
    .from('trades')
    .select('id, trade_data, created_at')
    .eq('user_id', user.id);
  if (aErr) {
    console.error('[rules/evaluate] day trades read failed:', aErr.message);
    res.status(500).json({ error: 'day trades read failed' });
    return;
  }
  const dayTrades = (allRows || [])
    .map(normTrade)
    .filter(t => tradeDay(t, t.created_at) === trading_day)
    .sort((a,b) => Date.parse(a.created_at||'') - Date.parse(b.created_at||''));

  // ── Run the engine ──────────────────────────────────────────────
  const results = evaluateTrade(trade, rules, { dayTrades });

  // ── Persist — replace any prior evaluations for this trade ──────
  await sb.from('rule_evaluations').delete()
    .eq('user_id', user.id).eq('trade_id', tradeId);

  // Every fresh evaluation lands as pending_review — the engine's verdict
  // is kept in auto_detected_status; the user confirms it in Today's Review.
  const rows = results.map(r => ({
    user_id: user.id,
    rule_id: r.rule_id,
    trading_day,
    trade_id: tradeId,
    status: 'pending_review',
    auto_detected_status: r.auto_detected_status,
    user_overrode: false,
    cost_impact: r.cost_impact,
  }));
  const { data: inserted, error: iErr } = await sb
    .from('rule_evaluations').insert(rows).select();
  if (iErr) {
    console.error('[rules/evaluate] eval insert failed:', iErr.message);
    res.status(500).json({ error: 'evaluation save failed' });
    return;
  }

  console.log('[rules/evaluate]', { user_id: user.id, trade_id: tradeId, rules: rules.length });
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({ trade_id: tradeId, trading_day, evaluations: inserted || [] });
}
