// POST /api/rules/review  { reviews: [{ rule_id, status }] }
// Saves a subjective YES/NO review. intra_day rules anchor to today;
// weekly rules anchor to this week's Friday — and weekly submissions
// are rejected unless today actually is Friday. Re-saving replaces the
// prior evaluation for that rule + cycle. Pro-gated.

import { sbService } from '../_lib/supabase.js';
import { requirePro } from '../_lib/auth.js';

const VALID_STATUS = ['followed', 'broken'];
function utcToday() { return new Date().toISOString().slice(0, 10); }
function weekAnchor() {
  const d = new Date();
  const day = d.getUTCDay();
  const delta = day === 0 ? -2 : (day === 6 ? -1 : 5 - day);
  return new Date(d.getTime() + delta * 864e5).toISOString().slice(0, 10);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed', allowed: ['POST'] });
    return;
  }
  const user = await requirePro(req, res);
  if (!user) return;
  const sb = sbService();

  const reviews = Array.isArray(req.body) ? req.body
    : (req.body && Array.isArray(req.body.reviews) ? req.body.reviews : null);
  if (!reviews || !reviews.length) {
    res.status(400).json({ error: 'reviews array required' });
    return;
  }
  for (const r of reviews) {
    if (!r || !r.rule_id) { res.status(400).json({ error: 'each review needs a rule_id' }); return; }
    if (VALID_STATUS.indexOf(r.status) < 0) {
      res.status(400).json({ error: 'invalid status', allowed: VALID_STATUS, got: r.status });
      return;
    }
  }

  // Resolve each rule's cadence (and confirm the caller owns it).
  const ids = reviews.map(function (r) { return String(r.rule_id); });
  const { data: ruleRows, error: rErr } = await sb
    .from('rules').select('id, cadence').eq('user_id', user.id).in('id', ids);
  if (rErr) {
    console.error('[rules/review] rules read failed:', rErr.message);
    res.status(500).json({ error: 'rules read failed' });
    return;
  }
  const ruleMap = {};
  (ruleRows || []).forEach(function (r) { ruleMap[r.id] = r; });

  const isFri = new Date().getUTCDay() === 5;
  for (const rv of reviews) {
    const rule = ruleMap[String(rv.rule_id)];
    if (!rule) { res.status(400).json({ error: 'unknown rule', rule_id: rv.rule_id }); return; }
    if (rule.cadence === 'weekly' && !isFri) {
      res.status(400).json({ error: 'weekly_not_friday', message: 'Weekly review available on Friday.' });
      return;
    }
  }

  const today = utcToday();
  const friAnchor = weekAnchor();
  const now = new Date().toISOString();
  const saved = [];
  for (const rv of reviews) {
    const cad = ruleMap[String(rv.rule_id)].cadence;
    const td = cad === 'weekly' ? friAnchor : today;
    // Replace any prior evaluation for this rule on this cycle.
    await sb.from('rule_evaluations').delete()
      .eq('user_id', user.id).eq('rule_id', rv.rule_id).eq('trading_day', td);
    const { data, error } = await sb.from('rule_evaluations')
      .insert({ user_id: user.id, rule_id: rv.rule_id, trading_day: td, status: rv.status, reviewed_at: now })
      .select('id, rule_id, trading_day, status').single();
    if (error) {
      console.error('[rules/review] insert failed:', error.message);
      res.status(500).json({ error: 'review save failed' });
      return;
    }
    saved.push(data);
  }
  console.log('[rules/review]', { user_id: user.id, saved: saved.length });
  res.status(200).json({ ok: true, saved });
}
