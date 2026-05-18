// /api/rules
//   GET  — list the caller's rules, each with a current_streak
//   POST — create a custom subjective rule (requires a cadence)
// Pro-gated; Bearer auth.

import { sbService } from '../_lib/supabase.js';
import { requirePro } from '../_lib/auth.js';

const CADENCES = ['intra_day', 'weekly'];

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed', allowed: ['GET', 'POST'] });
    return;
  }
  const user = await requirePro(req, res);
  if (!user) return;
  const sb = sbService();

  // ── GET — list rules with streaks ───────────────────────────────
  if (req.method === 'GET') {
    const { data: rules, error } = await sb
      .from('rules')
      .select('id, name, description, cadence, condition, is_active, is_template, created_at, updated_at')
      .eq('user_id', user.id)
      .order('created_at', { ascending: true });
    if (error) {
      console.error('[rules:GET] read failed:', error.message);
      res.status(500).json({ error: 'rules read failed' });
      return;
    }

    // current_streak — consecutive followed cycles from the latest one
    // backwards (one cycle = a trading_day; weekly evals anchor on Saturday).
    const { data: evalRows, error: eErr } = await sb
      .from('rule_evaluations')
      .select('rule_id, trading_day, status, evaluated_at')
      .eq('user_id', user.id);
    if (eErr) console.error('[rules:GET] eval read failed:', eErr.message);
    const byRule = {};
    (evalRows || []).forEach(function (e) {
      (byRule[e.rule_id] || (byRule[e.rule_id] = [])).push(e);
    });
    function streakOf(rid) {
      const evs = byRule[rid] || [];
      // collapse to one status per trading_day (latest evaluated_at wins)
      const perDay = {};
      evs.forEach(function (e) {
        const cur = perDay[e.trading_day];
        if (!cur || String(e.evaluated_at || '') > String(cur.evaluated_at || '')) perDay[e.trading_day] = e;
      });
      const days = Object.keys(perDay).sort(function (a, b) { return b.localeCompare(a); });
      let s = 0;
      for (let i = 0; i < days.length; i++) {
        if (perDay[days[i]].status === 'followed') s++; else break;
      }
      return s;
    }

    const out = (rules || []).map(function (r) {
      return {
        id: r.id, name: r.name, description: r.description,
        cadence: r.cadence, condition: r.condition,
        is_active: r.is_active, is_template: r.is_template,
        created_at: r.created_at, updated_at: r.updated_at,
        current_streak: streakOf(r.id),
      };
    });
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ rules: out });
    return;
  }

  // ── POST — create a custom rule ─────────────────────────────────
  const body = req.body || {};
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const cadence = body.cadence;
  if (!name) { res.status(400).json({ error: 'name required' }); return; }
  if (CADENCES.indexOf(cadence) < 0) {
    res.status(400).json({ error: 'cadence must be intra_day | weekly' });
    return;
  }
  // Everything is subjective now — default the condition.
  let condition = body.condition;
  if (!condition || typeof condition !== 'object' || !condition.type) {
    condition = { type: 'subjective_check' };
  }
  const row = {
    user_id: user.id,
    name: name,
    description: typeof body.description === 'string' ? body.description : null,
    cadence: cadence,
    condition: condition,
    is_template: false,
    is_active: body.is_active === false ? false : true,
  };
  const { data, error } = await sb.from('rules').insert(row).select().single();
  if (error) {
    console.error('[rules:POST] insert failed:', error.message);
    res.status(500).json({ error: 'rule create failed' });
    return;
  }
  console.log('[rules:POST] created', { user_id: user.id, rule_id: data.id });
  res.status(201).json({ rule: data });
}
