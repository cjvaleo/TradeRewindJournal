// /api/rules/:id
//   PATCH  — update / toggle a rule (name, description, condition, is_active)
//   DELETE — delete a rule
// Pro-gated; Bearer auth. Scoped to the caller's own rules.

import { sbService } from '../_lib/supabase.js';
import { requirePro } from '../_lib/auth.js';

export default async function handler(req, res) {
  if (req.method !== 'PATCH' && req.method !== 'DELETE') {
    res.status(405).json({ error: 'method not allowed', allowed: ['PATCH', 'DELETE'] });
    return;
  }
  const user = await requirePro(req, res);
  if (!user) return;

  const id = req.query && req.query.id;
  if (!id) { res.status(400).json({ error: 'rule id required' }); return; }
  const sb = sbService();

  // ── DELETE ──────────────────────────────────────────────────────
  if (req.method === 'DELETE') {
    const { data, error } = await sb
      .from('rules')
      .delete()
      .eq('id', id)
      .eq('user_id', user.id)
      .select('id');
    if (error) {
      console.error('[rules:DELETE] failed:', error.message);
      res.status(500).json({ error: 'rule delete failed' });
      return;
    }
    if (!data || !data.length) { res.status(404).json({ error: 'rule not found' }); return; }
    res.status(200).json({ ok: true, deleted: id });
    return;
  }

  // ── PATCH ───────────────────────────────────────────────────────
  const body = req.body || {};
  const patch = { updated_at: new Date().toISOString() };
  if (typeof body.name === 'string' && body.name.trim()) patch.name = body.name.trim();
  if (typeof body.description === 'string') patch.description = body.description;
  if (typeof body.is_active === 'boolean') patch.is_active = body.is_active;
  if (body.condition && typeof body.condition === 'object' && body.condition.type) {
    patch.condition = body.condition;
  }
  if (Object.keys(patch).length === 1) {
    res.status(400).json({ error: 'no updatable fields supplied' });
    return;
  }

  const { data, error } = await sb
    .from('rules')
    .update(patch)
    .eq('id', id)
    .eq('user_id', user.id)
    .select()
    .maybeSingle();
  if (error) {
    console.error('[rules:PATCH] failed:', error.message);
    res.status(500).json({ error: 'rule update failed' });
    return;
  }
  if (!data) { res.status(404).json({ error: 'rule not found' }); return; }
  res.status(200).json({ rule: data });
}
