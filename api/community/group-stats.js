// GET /api/community/group-stats?community_id=X&period=Y&tz_offset=Z
// Community-wide aggregate. Standalone handler so we can resolve the
// profile (username + avatar) for top_trade and top_trader, and so the
// Community-page hero can use this endpoint as its single source of
// truth (kills the community_posts.pnl_today drift).
//
// `period` accepts: today | week | month | all (TZ-aware "today" via
// tz_offset = JS Date.getTimezoneOffset() minutes, positive west of UTC).
// Legacy `range` param (7d/30d/all) is honored too.

import { sbService } from '../_lib/supabase.js';
import { requirePro } from '../_lib/auth.js';
import {
  loadCommunity,
  communityMemberIds,
  loadMemberTrades,
  aggGroupStats,
} from '../_lib/community.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'method not allowed', allowed: ['GET'] });
    return;
  }

  const user = await requirePro(req, res);
  if (!user) return;

  const cid = (req.query && req.query.community_id) ? String(req.query.community_id) : null;
  if (!cid) { res.status(400).json({ error: 'community_id required' }); return; }

  let row;
  try {
    row = await loadCommunity(cid);
  } catch (e) {
    console.error('[group-stats] community read failed:', e && e.message);
    res.status(500).json({ error: 'community read failed' });
    return;
  }
  if (!row) { res.status(404).json({ error: 'community not found' }); return; }

  const memberIds = communityMemberIds(row);
  if (memberIds.indexOf(user.id) < 0) {
    res.status(403).json({ error: 'not_a_member', message: 'You are not a member of this community.' });
    return;
  }

  // Period → loader range. "today" piggybacks on 7d then filters by date.
  const period = (req.query && req.query.period) ? String(req.query.period) : null;
  const legacyRange = (req.query && req.query.range) ? String(req.query.range) : null;
  const rangeForLoad =
       period === 'all'   ? 'all'
     : period === 'month' ? '30d'
     : period === 'week'  ? '7d'
     : period === 'today' ? '7d'
     : (legacyRange === '30d' || legacyRange === 'all') ? legacyRange
     : '7d';
  const tzRaw = (req.query && req.query.tz_offset != null) ? parseInt(req.query.tz_offset, 10) : 0;
  const tzOffset = Number.isFinite(tzRaw) ? tzRaw : 0;

  let payload;
  try {
    let trades = await loadMemberTrades(memberIds, rangeForLoad);
    if (period === 'today') {
      const localToday = new Date(Date.now() - tzOffset * 60000).toISOString().slice(0, 10);
      trades = trades.filter(function (t) {
        const d = (typeof t.date === 'string' && /^\d{4}-\d{2}-\d{2}/.test(t.date)) ? t.date.slice(0, 10)
          : (typeof t.created_at === 'string' && t.created_at.length >= 10) ? t.created_at.slice(0, 10)
          : null;
        return d === localToday;
      });
    }
    payload = aggGroupStats(trades, { memberCount: memberIds.length, memberIds: memberIds });
  } catch (e) {
    console.error('[group-stats] aggregation failed:', e && e.message);
    res.status(500).json({ error: 'aggregation failed' });
    return;
  }

  // Resolve usernames + avatars for the top_trade taker and every
  // leaderboard entry in a single batched profiles read.  Session 20a
  // follow-up #7 — the leaderboard rail now consumes this endpoint too,
  // so the ids list includes the ranked top-N members.
  const idSet = {};
  if (payload.top_trade && payload.top_trade.user_id) idSet[payload.top_trade.user_id] = 1;
  (payload.leaderboard || []).forEach(function (row) {
    if (row && row.user_id) idSet[row.user_id] = 1;
  });
  const ids = Object.keys(idSet);
  const profMap = {};
  if (ids.length) {
    try {
      const pf = await sbService()
        .from('profiles')
        .select('id, username, display_name, avatar_image_url, avatar_finish, color, avatar_initials, initials')
        .in('id', ids);
      if (pf && pf.data) pf.data.forEach(function (p) { profMap[p.id] = p; });
    } catch (e) {
      console.error('[group-stats] profile read failed:', e && e.message);
    }
  }
  function _attach(obj) {
    if (!obj || !obj.user_id) return;
    const p = profMap[obj.user_id] || {};
    obj.username        = p.username || 'trader';
    obj.display_name    = p.display_name || null;
    obj.avatar_url      = p.avatar_image_url || null;
    obj.avatar_finish   = p.avatar_finish || p.color || null;
    obj.avatar_initials = p.avatar_initials || p.initials || null;
  }
  if (payload.top_trade) _attach(payload.top_trade);
  (payload.leaderboard || []).forEach(_attach);

  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json(payload);
}
