// GET /api/rules/today
// Today's rule evaluations for the caller — each joined with its rule's
// name / type so the frontend can render the daily review list. Surfaces
// pending_review items (subjective + 'unknown' auto-detections) alongside
// the auto-resolved followed / broken ones.

import { sbService } from '../_lib/supabase.js';
import { requirePro } from '../_lib/auth.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'method not allowed', allowed: ['GET'] });
    return;
  }
  const user = await requirePro(req, res);
  if (!user) return;

  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await sbService()
    .from('rule_evaluations')
    .select('id, rule_id, trading_day, trade_id, status, auto_detected_status, user_overrode, cost_impact, evaluated_at, reviewed_at, rules(name, description, rule_type, condition)')
    .eq('user_id', user.id)
    .eq('trading_day', today)
    .order('evaluated_at', { ascending: true });
  if (error) {
    console.error('[rules/today] read failed:', error.message);
    res.status(500).json({ error: 'evaluations read failed' });
    return;
  }

  const evaluations = data || [];
  const pending = evaluations.filter(e => e.status === 'pending_review').length;
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({
    trading_day: today,
    counts: {
      total: evaluations.length,
      pending_review: pending,
      followed: evaluations.filter(e => e.status === 'followed').length,
      broken: evaluations.filter(e => e.status === 'broken').length,
    },
    evaluations,
  });
}
