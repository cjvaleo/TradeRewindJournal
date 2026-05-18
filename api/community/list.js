// GET /api/community/list — the communities the current user belongs to.
// Membership is the `communities` table: owner_id, or present in the
// members uuid[] array. Sorted most-recently-created first.
import { sbService } from '../_lib/supabase.js';
import { requirePro } from '../_lib/auth.js';
import { communityMemberIds } from '../_lib/community.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'method not allowed', allowed: ['GET'] });
    return;
  }
  const user = await requirePro(req, res);
  if (!user) return;

  let rows = [];
  try {
    const { data, error } = await sbService()
      .from('communities')
      .select('id, name, owner_id, members, created_at')
      .or('owner_id.eq.' + user.id + ',members.cs.{' + user.id + '}')
      .order('created_at', { ascending: false });
    if (error) throw new Error(error.message);
    rows = data || [];
  } catch (e) {
    console.error('[community/list] read failed:', e && e.message);
    res.status(500).json({ error: 'communities read failed' });
    return;
  }

  const list = rows.map(function (r) {
    return { id: r.id, name: r.name, trader_count: communityMemberIds(r).length, joined: true };
  });
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json(list);
}
