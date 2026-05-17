// POST /api/rules/review  { reviews: [{ id, status, user_overrode? }] }
// Saves the user's review of their evaluations — used to resolve
// pending_review items and to override an auto-detected followed/broken.
// Each touched row gets reviewed_at stamped.

import { sbService } from '../_lib/supabase.js';
import { requirePro } from '../_lib/auth.js';

const VALID_STATUS = ['followed', 'broken', 'pending_review'];

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed', allowed: ['POST'] });
    return;
  }
  const user = await requirePro(req, res);
  if (!user) return;

  const reviews = req.body && Array.isArray(req.body.reviews) ? req.body.reviews : null;
  if (!reviews || !reviews.length) {
    res.status(400).json({ error: 'reviews array required' });
    return;
  }
  for (const r of reviews) {
    if (!r || !r.id) { res.status(400).json({ error: 'each review needs an id' }); return; }
    if (VALID_STATUS.indexOf(r.status) < 0) {
      res.status(400).json({ error: 'invalid status', allowed: VALID_STATUS, got: r.status });
      return;
    }
  }

  const sb = sbService();
  const now = new Date().toISOString();
  const updated = [];
  const failed = [];

  for (const r of reviews) {
    const patch = { status: r.status, reviewed_at: now };
    if (typeof r.user_overrode === 'boolean') patch.user_overrode = r.user_overrode;
    const { data, error } = await sb
      .from('rule_evaluations')
      .update(patch)
      .eq('id', r.id)
      .eq('user_id', user.id)        // scope to the caller's own rows
      .select('id, status, user_overrode, reviewed_at')
      .maybeSingle();
    if (error || !data) failed.push(r.id);
    else updated.push(data);
  }

  console.log('[rules/review]', { user_id: user.id, updated: updated.length, failed: failed.length });
  res.status(200).json({ ok: true, updated, failed });
}
