/* ============================================================================
   POST /api/losses/post
   Drop at: api/losses/post.js

   Posts one loss to Trading Ark #losses. Mirror of api/wins/post.js with
   the verification inverted.

   THE CLIENT IS NOT TRUSTED. It sends a trade id and nothing else — this route
   re-loads the trade, re-checks that it is a real LOSS on a real account, and
   refuses otherwise. A tampered request cannot push a paper trade or a win
   into #losses.

   Body:  { trade_id }
   Reply: { ok, discord: bool }

   ENV — set whichever you have:
     DISCORD_LOSSES_WEBHOOK     a channel webhook URL   (simplest)
     DISCORD_BOT_TOKEN          a bot token             (more control later)
     DISCORD_LOSSES_CHANNEL_ID  channel override (defaults to #losses)
   ========================================================================== */

import { createClient } from '@supabase/supabase-js';

const LOSSES_CHANNEL_ID = process.env.DISCORD_LOSSES_CHANNEL_ID || '1513725409257197650';
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
  if (!Number.isFinite(pnl) || pnl >= 0) {
    res.status(403).json({ error: 'not a loss' });
    return;
  }

  /* ---- who they are on the floor --------------------------------------- */
  const { data: profile } = await admin
    .from('profiles')
    .select('username, display_name, initials, color, avatar_image_url')
    .eq('id', userId).single();

  const handle = profile?.display_name || profile?.username || 'a member';
  const money  = n => (n < 0 ? '−$' : '+$') + Math.abs(Math.round(n)).toLocaleString();
  const rr     = Number.isFinite(Number(d.rr)) ? Number(d.rr) : null;

  /* the public line. notes are deliberately left out — same privacy
     promise the wins modal makes. */
  const bits = [d.sym, d.type === 'short' ? 'Short' : 'Long'];
  if (d.model)      bits.push(d.model);
  if (rr !== null)  bits.push((rr >= 0 ? '+' : '−') + Math.abs(rr).toFixed(2) + 'R');
  const line = bits.filter(Boolean).join(' · ');

  /* ---- Discord ---------------------------------------------------------- */
  let postedToDiscord = false;
  const webhook = process.env.DISCORD_LOSSES_WEBHOOK;
  const bot     = process.env.DISCORD_BOT_TOKEN;

  /* Deep-link the embed to the trade's auto-shared feed post when one
     exists — /community?post={id} routes through the app's gate. */
  const appUrl = process.env.PUBLIC_APP_URL || 'https://traderewindjournal.com';
  let feedPostId = null;
  try {
    const { data: fp } = await admin
      .from('community_posts')
      .select('id')
      .eq('user_id', userId)
      .like('id', `trade_${trade.id}_%`)
      .limit(1);
    if (fp && fp.length) feedPostId = fp[0].id;
  } catch { /* link is optional */ }

  const embed = {
    title: `${money(pnl)} — ${handle}`,
    description: line,
    color: 0xC95F5F,
    footer: { text: 'Logged in Rewind · traderewindjournal.com' },
    timestamp: new Date(trade.trading_day + 'T12:00:00Z').toISOString(),
  };
  if (feedPostId) embed.url = `${appUrl}/community?post=${encodeURIComponent(feedPostId)}`;
  if (d.images?.[0]) embed.image = { url: d.images[0] };

  try {
    if (webhook) {
      const r = await fetch(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ embeds: [embed], allowed_mentions: { parse: [] } }),
      });
      postedToDiscord = r.ok;
      if (!r.ok) console.warn('[losses] webhook said', r.status, await r.text());
    } else if (bot) {
      const r = await fetch(`https://discord.com/api/v10/channels/${LOSSES_CHANNEL_ID}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bot ${bot}` },
        body: JSON.stringify({ embeds: [embed], allowed_mentions: { parse: [] } }),
      });
      postedToDiscord = r.ok;
      if (!r.ok) console.warn('[losses] bot said', r.status, await r.text());
    } else {
      console.warn('[losses] no DISCORD_LOSSES_WEBHOOK or DISCORD_BOT_TOKEN set');
    }
  } catch (e) {
    console.error('[losses] discord post failed:', e && e.message);
  }

  if (!postedToDiscord) {
    res.status(502).json({ error: 'could not post to discord' });
    return;
  }
  res.status(200).json({ ok: true, discord: true });
}
