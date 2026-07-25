/* ============================================================================
   POST /api/auth/gate
   Drop at: api/auth/gate.js   (Vercel serves it at /api/auth/gate)

   THE ONLY THING THAT DECIDES ACCESS.

   Runs server-side on purpose. A role check done in the browser is bypassed
   by anyone who opens devtools, so the client is never trusted with the
   verdict — it only receives it.

   Flow
     1. verify the caller's Supabase session (Bearer token)
     2. take the Discord provider_token from the sign-in
     3. ask Discord for that user's member object in Trading Ark
     4. look for the Premium or OG Prem role
     5. cache the result on profiles, return { allowed, tier }

   Body:  { provider_token, provider_refresh_token? }
   Reply: { allowed: bool, tier: 'premium'|'og'|null, reason?: string }
   ========================================================================== */

import { createClient } from '@supabase/supabase-js';

/* ---- Trading Ark ---------------------------------------------------------
   Confirmed by Christian. Override via env if they ever change.           */
const GUILD_ID = process.env.DISCORD_GUILD_ID || '1423501404126970020';
const ROLES = {
  premium: process.env.DISCORD_ROLE_PREMIUM || '1462926824903540950',
  og:      process.env.DISCORD_ROLE_OG_PREM || '1517322302424092693',
};

const DISCORD_API = 'https://discord.com/api/v10';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed', allowed: ['POST'] });
    return;
  }

  /* ---- 1 · who is calling? ---------------------------------------------- */
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) { res.status(401).json({ error: 'auth required' }); return; }

  const url  = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !anon || !service) {
    console.error('[gate] missing env', { url: !!url, anon: !!anon, service: !!service });
    res.status(500).json({ error: 'server misconfigured' });
    return;
  }

  let userId;
  try {
    const sb = createClient(url, anon);
    const { data: { user }, error } = await sb.auth.getUser(token);
    if (error || !user) throw new Error('invalid token');
    userId = user.id;
  } catch (e) {
    res.status(401).json({ error: 'auth required' });
    return;
  }

  /* ---- 2 · the Discord token from this sign-in -------------------------- */
  const providerToken   = req.body?.provider_token;
  const providerRefresh = req.body?.provider_refresh_token || null;
  if (!providerToken) {
    res.status(400).json({ allowed: false, tier: null, reason: 'no_discord_token' });
    return;
  }

  /* ---- 3 · ask Discord about this user's membership --------------------- */
  let member, discordUserId = null;
  try {
    const me = await fetch(`${DISCORD_API}/users/@me`, {
      headers: { Authorization: `Bearer ${providerToken}` },
    });
    if (me.ok) discordUserId = (await me.json()).id;

    const r = await fetch(`${DISCORD_API}/users/@me/guilds/${GUILD_ID}/member`, {
      headers: { Authorization: `Bearer ${providerToken}` },
    });

    /* 404 = signed in with Discord but not in the server at all.
       This is the common denial and deserves its own reason. */
    if (r.status === 404) {
      await cacheDenial(url, service, userId, discordUserId, providerToken, providerRefresh);
      res.status(200).json({ allowed: false, tier: null, reason: 'not_in_server' });
      return;
    }
    if (r.status === 401 || r.status === 403) {
      res.status(200).json({ allowed: false, tier: null, reason: 'scope_missing' });
      return;
    }
    if (!r.ok) throw new Error(`discord ${r.status}`);
    member = await r.json();
  } catch (e) {
    console.error('[gate] discord lookup failed:', e && e.message);
    /* fail CLOSED — a Discord outage must not hand out access */
    res.status(503).json({ allowed: false, tier: null, reason: 'discord_unreachable' });
    return;
  }

  /* ---- 4 · the actual gate --------------------------------------------- */
  const held = Array.isArray(member.roles) ? member.roles : [];
  const tier = held.includes(ROLES.og) ? 'og'
             : held.includes(ROLES.premium) ? 'premium'
             : null;
  const allowed = tier !== null;

  /* ---- 5 · cache it so the app doesn't re-ask Discord on every page ----- */
  try {
    const admin = createClient(url, service, { auth: { persistSession: false } });
    await admin.from('profiles').update({
      discord_user_id:       discordUserId,
      discord_access_token:  providerToken,
      discord_refresh_token: providerRefresh,
      discord_token_expires: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      last_role_check:       new Date().toISOString(),
      is_pro:                allowed,
      plan:                  allowed ? (tier === 'og' ? 'elite' : 'premium') : 'free',
      pro_source:            allowed ? 'discord_role' : null,
    }).eq('id', userId);
  } catch (e) {
    /* a cache write failure must not change the verdict */
    console.warn('[gate] profile cache failed:', e && e.message);
  }

  res.status(200).json({
    allowed, tier,
    reason: allowed ? undefined : 'no_role',
    nickname: member.nick || null,
  });
}

/* record the attempt even on denial, so the nightly cron can re-check
   someone who buys a membership later */
async function cacheDenial(url, service, userId, discordUserId, tok, refresh) {
  try {
    const admin = createClient(url, service, { auth: { persistSession: false } });
    await admin.from('profiles').update({
      discord_user_id: discordUserId,
      discord_access_token: tok,
      discord_refresh_token: refresh,
      last_role_check: new Date().toISOString(),
      is_pro: false,
      plan: 'free',
    }).eq('id', userId);
  } catch { /* non-fatal */ }
}
