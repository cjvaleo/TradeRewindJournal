/* ============================================================================
   POST /api/wins/post
   Drop at: api/wins/post.js

   Posts one win to Trading Ark #wins AND the Rewind community feed.

   THE CLIENT IS NOT TRUSTED. It sends a trade id and nothing else — this route
   re-loads the trade, re-checks that it is a real win on a real account, and
   refuses otherwise. A tampered request cannot push a paper trade or a loss
   into a paid community.

   Body:  { trade_id }
   Reply: { ok, discord: bool, feed: bool }

   ENV — set whichever you have:
     DISCORD_WINS_WEBHOOK   a channel webhook URL   (simplest)
     DISCORD_BOT_TOKEN      a bot token             (more control later)
   With neither, it still writes the feed post and reports discord:false.
   ========================================================================== */

import { createClient } from '@supabase/supabase-js';

const WINS_CHANNEL_ID = process.env.DISCORD_WINS_CHANNEL_ID || '1463633701421318249';
const POSTABLE_ACCOUNTS = ['eval', 'funded', 'live'];   /* paper never posts */

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed', allowed: ['POST'] });
    return;
  }

  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) { res.status(401).json({ error: 'auth required' }); return; }

  const url  = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const svc  = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !anon || !svc) { res.status(500).json({ error: 'server misconfigured' }); return; }

  /* ---- who is asking ---------------------------------------------------- */
  let userId;
  try {
    const sb = createClient(url, anon);
    const { data: { user }, error } = await sb.auth.getUser(token);
    if (error || !user) throw new Error('bad token');
    userId = user.id;
  } catch { res.status(401).json({ error: 'auth required' }); return; }

  const tradeId = req.body?.trade_id;
  if (!tradeId) { res.status(400).json({ error: 'trade_id required' }); return; }

  const admin = createClient(url, svc, { auth: { persistSession: false } });

  /* ---- load the trade, scoped to its owner ------------------------------ */
  const { data: trade, error: te } = await admin
    .from('trades')
    .select('id, user_id, trading_day, account_type, trade_data')
    .eq('id', tradeId).eq('user_id', userId)
    .single();
  if (te || !trade) { res.status(404).json({ error: 'trade not found' }); return; }

  /* ---- RE-VERIFY. this is the whole point of doing it here. ------------- */
  const d = trade.trade_data || {};
  const acct = String(trade.account_type || d.account_type || '').toLowerCase();
  const pnl  = Number(d.pnl);

  if (!POSTABLE_ACCOUNTS.includes(acct)) {
    res.status(403).json({ error: 'not a postable account', account_type: acct || null });
    return;
  }
  if (!Number.isFinite(pnl) || pnl <= 0) {
    res.status(403).json({ error: 'not a win' });
    return;
  }

  /* ---- don't double-post ------------------------------------------------ */
  const { data: existing } = await admin
    .from('community_posts')
    .select('id').eq('user_id', userId)
    .contains('metadata', { trade_id: trade.id })
    .limit(1);
  if (existing && existing.length) {
    res.status(200).json({ ok: true, discord: false, feed: false, already: true });
    return;
  }

  /* ---- who they are on the floor --------------------------------------- */
  const { data: profile } = await admin
    .from('profiles')
    .select('username, display_name, initials, color, avatar_image_url')
    .eq('id', userId).single();

  const handle = profile?.username || profile?.display_name || 'a member';
  const money  = n => (n < 0 ? '−$' : '+$') + Math.abs(Math.round(n)).toLocaleString();
  const rr     = Number.isFinite(Number(d.rr)) ? Number(d.rr) : null;

  /* the public line. notes are deliberately left out — the modal promises
     the member their notes stay private. */
  const bits = [d.sym, d.type === 'short' ? 'Short' : 'Long'];
  if (d.model)      bits.push(d.model);
  if (rr !== null)  bits.push((rr >= 0 ? '+' : '−') + Math.abs(rr).toFixed(2) + 'R');
  const line = bits.filter(Boolean).join(' · ');

  /* ---- 1 · Discord ----------------------------------------------------- */
  let postedToDiscord = false;
  const webhook = process.env.DISCORD_WINS_WEBHOOK;
  const bot     = process.env.DISCORD_BOT_TOKEN;

  const embed = {
    title: `${money(pnl)} — ${handle}`,
    description: line,
    color: 0x57BE8B,
    footer: { text: 'Logged in Rewind · traderewindjournal.com' },
    timestamp: new Date(trade.trading_day + 'T12:00:00Z').toISOString(),
  };
  if (d.images?.[0]) embed.image = { url: d.images[0] };

  try {
    if (webhook) {
      const r = await fetch(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ embeds: [embed], allowed_mentions: { parse: [] } }),
      });
      postedToDiscord = r.ok;
      if (!r.ok) console.warn('[wins] webhook said', r.status, await r.text());
    } else if (bot) {
      const r = await fetch(`https://discord.com/api/v10/channels/${WINS_CHANNEL_ID}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bot ${bot}` },
        body: JSON.stringify({ embeds: [embed], allowed_mentions: { parse: [] } }),
      });
      postedToDiscord = r.ok;
      if (!r.ok) console.warn('[wins] bot said', r.status, await r.text());
    } else {
      console.warn('[wins] no DISCORD_WINS_WEBHOOK or DISCORD_BOT_TOKEN set');
    }
  } catch (e) {
    console.error('[wins] discord post failed:', e && e.message);
  }

  /* ---- 2 · the Rewind feed -------------------------------------------- */
  let postedToFeed = false;
  try {
    const { error: ce } = await admin.from('community_posts').insert({
      id: `${Date.now()}.${Math.random().toString().slice(2, 6)}`,
      user_id: userId,
      username: handle,
      initials: profile?.initials || handle.slice(0, 1).toUpperCase(),
      avatar_color: profile?.color || null,
      content: line,
      pnl_today: Math.round(pnl),
      image_url: d.images?.[0] || null,
      likes_count: 0,
      liked_by: [],
      metadata: {
        trade_id: trade.id,
        source: 'win_auto',
        sym: d.sym, side: d.type, model: d.model || null,
        rr, grade: d.grade || null,
        account_type: acct,
        trading_day: trade.trading_day,
      },
    });
    postedToFeed = !ce;
    if (ce) console.warn('[wins] feed insert failed:', ce.message);
  } catch (e) {
    console.error('[wins] feed insert threw:', e && e.message);
  }

  /* a failure on either side is reported, not hidden */
  if (!postedToDiscord && !postedToFeed) {
    res.status(502).json({ error: 'could not post to either destination' });
    return;
  }
  res.status(200).json({ ok: true, discord: postedToDiscord, feed: postedToFeed });
}
