// POST /api/rules/seed-defaults
// Idempotent — seeds the 5 starter rules for the caller, but only if they
// currently have zero rules. Pro-gated. Called by the Rules tab on first
// visit when GET /api/rules comes back empty.

import { sbService } from '../_lib/supabase.js';
import { requirePro } from '../_lib/auth.js';
import { DEFAULT_RULES } from '../_lib/rule-templates.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed', allowed: ['POST'] });
    return;
  }
  const user = await requirePro(req, res);
  if (!user) return;
  const sb = sbService();

  // Idempotency guard — never seed twice.
  const { count, error: cErr } = await sb
    .from('rules')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', user.id);
  if (cErr) {
    console.error('[rules/seed-defaults] count failed:', cErr.message);
    res.status(500).json({ error: 'rule count failed' });
    return;
  }
  if (count && count > 0) {
    res.status(200).json({ seeded: false, reason: 'user already has rules', rule_count: count });
    return;
  }

  const rows = DEFAULT_RULES.map(d => ({
    user_id: user.id,
    name: d.name,
    description: d.description,
    cadence: d.cadence,
    condition: d.condition,
    is_active: true,
    is_template: false,
  }));
  const { data, error } = await sb.from('rules').insert(rows).select();
  if (error) {
    console.error('[rules/seed-defaults] insert failed:', error.message);
    res.status(500).json({ error: 'seed failed' });
    return;
  }
  console.log('[rules/seed-defaults] seeded', { user_id: user.id, count: data.length });
  res.status(201).json({ seeded: true, rules: data });
}
