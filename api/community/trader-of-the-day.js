// GET /api/community/trader-of-the-day?community_id=X
// The community member with the highest net P&L for today, plus that
// member's day of trades. Same Pro gating + membership authorization as
// the other /api/community endpoints. "Today" = server UTC date.
import crypto from 'crypto';
import { sbService } from '../_lib/supabase.js';
import { requirePro } from '../_lib/auth.js';
import {
  loadCommunity,
  communityMemberIds,
  loadMemberTrades,
  traderOfTheDay,
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
    console.error('[trader-of-the-day] community read failed:', e && e.message);
    res.status(500).json({ error: 'community read failed' });
    return;
  }
  if (!row) { res.status(404).json({ error: 'community not found' }); return; }

  const memberIds = communityMemberIds(row);
  if (memberIds.indexOf(user.id) < 0) {
    res.status(403).json({ error: 'not_a_member', message: 'You are not a member of this community.' });
    return;
  }

  // "Today" in the VIEWER's timezone. tz_offset is minutes from UTC as
  // returned by JS Date.getTimezoneOffset() — positive west of UTC
  // (EDT = +240). Local time = UTC − offset minutes.
  const tzRaw = (req.query && req.query.tz_offset != null) ? parseInt(req.query.tz_offset, 10) : 0;
  const tzOffset = Number.isFinite(tzRaw) ? tzRaw : 0;
  const localToday = new Date(Date.now() - tzOffset * 60000).toISOString().slice(0, 10);

  let totd;
  try {
    // A 7-day window is the cheapest fetch that always contains today.
    const trades = await loadMemberTrades(memberIds, '7d');
    totd = traderOfTheDay(trades, localToday);
  } catch (e) {
    console.error('[trader-of-the-day] aggregation failed:', e && e.message);
    res.status(500).json({ error: 'aggregation failed' });
    return;
  }

  res.setHeader('Cache-Control', 'no-store');

  if (!totd) {
    res.status(200).json({ empty: true });
    return;
  }

  // Resolve the winner's username; never expose the raw user_id.
  let username = 'Trader';
  try {
    const prof = await sbService()
      .from('profiles').select('username').eq('id', totd.user_id).maybeSingle();
    if (prof && prof.data && prof.data.username) username = prof.data.username;
  } catch (e) {
    console.error('[trader-of-the-day] profile read failed:', e && e.message);
  }
  const user_id_hash = crypto.createHash('sha256')
    .update(String(totd.user_id)).digest('hex').slice(0, 12);

  res.status(200).json({
    username: username,
    user_id_hash: user_id_hash,
    net_pnl_today: totd.net_pnl_today,
    trades_today: totd.trades_today,
  });
}
