// GET /api/community/list — communities the user belongs to + trader counts.
// v1: everyone is auto-joined to all 5; only all_rewind_users has a real
// trader count (distinct user_id in the trades table).
import { sbService } from '../_lib/supabase.js';
import { requirePro } from '../_lib/auth.js';
import { COMMUNITIES } from '../_lib/community.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'method not allowed', allowed: ['GET'] });
    return;
  }
  const user = await requirePro(req, res);
  if (!user) return;

  let realCount = 0;
  try {
    const { data, error } = await sbService().from('trades').select('user_id');
    if (error) throw new Error(error.message);
    const seen = {};
    (data || []).forEach(function (r) { if (r.user_id) seen[r.user_id] = 1; });
    realCount = Object.keys(seen).length;
  } catch (e) {
    console.error('[community/list] trader count failed:', e && e.message);
  }

  const list = COMMUNITIES.map(function (c) {
    return {
      id: c.id,
      name: c.name,
      trader_count: c.id === 'all_rewind_users' ? realCount : c.trader_count,
      joined: true,
    };
  });
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json(list);
}
