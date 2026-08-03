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
import { joinTradingArk } from '../../lib/community.js';

/* ---- Trading Ark ---------------------------------------------------------
   Confirmed by Christian. Override via env if they ever change.           */
const GUILD_ID = process.env.DISCORD_GUILD_ID || '1423501404126970020';
const ROLES = {
  premium: process.env.DISCORD_ROLE_PREMIUM || '1462926824903540950',
  og:      process.env.DISCORD_ROLE_OG_PREM || '1517322302424092693',
};

const DISCORD_API = 'https://discord.com/api/v10';

/* Same grant window the oauth callback and nightly cron use — the cron
   re-verifies the role daily and keeps extending; if it can't, access
   lapses when this window runs out. */
const PRO_WINDOW_DAYS = 35;

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

  const admin = createClient(url, service, { auth: { persistSession: false } });

  /* ---- 3 · ask Discord about this user's membership --------------------- */
  let member, discordUserId = null, discordUsername = null;
  try {
    const me = await fetch(`${DISCORD_API}/users/@me`, {
      headers: { Authorization: `Bearer ${providerToken}` },
    });
    if (me.ok) {
      const meJson = await me.json();
      discordUserId   = meJson.id;
      discordUsername = meJson.username || null;
    }

    const r = await fetch(`${DISCORD_API}/users/@me/guilds/${GUILD_ID}/member`, {
      headers: { Authorization: `Bearer ${providerToken}` },
    });

    /* 404 = signed in with Discord but not in the server at all.
       This is the common denial and deserves its own reason. */
    if (r.status === 404) {
      /* not in the server → no nickname exists; the Discord username is
         still the profile's display name */
      await cacheDenial(admin, userId, discordUserId, providerToken, providerRefresh, discordUsername);
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

  /* The profile display name is read-only in the app and owned by Discord:
     server nickname first, plain Discord username when none is set.
     Refreshed on every gate call (and nightly by the role-check cron). */
  const displayName = member.nick
    || (member.user && member.user.username)
    || discordUsername
    || null;

  /* ---- 5 · cache it so the app doesn't re-ask Discord on every page -----
     Upsert, not update: on a brand-new Discord sign-in the SPA creates the
     profiles row AFTER this gate runs, so an update would hit 0 rows and
     the tier would silently stay free.
     pro_source must be one of the profiles_pro_source_check values
     (discord_elite / discord_premium) — tier.js, api/me and the nightly
     cron all key off exactly those strings. */
  try {
    await admin.from('profiles').upsert({
      id:                    userId,
      discord_user_id:       discordUserId,
      discord_access_token:  providerToken,
      discord_refresh_token: providerRefresh,
      discord_token_expires: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      last_role_check:       new Date().toISOString(),
      is_pro:                allowed,
      plan:                  allowed ? (tier === 'og' ? 'elite' : 'premium') : 'free',
      pro_source:            allowed ? (tier === 'og' ? 'discord_elite' : 'discord_premium') : null,
      pro_active_until:      allowed
        ? new Date(Date.now() + PRO_WINDOW_DAYS * 86400 * 1000).toISOString()
        : new Date().toISOString(),
      ...(displayName ? { display_name: displayName } : {}),
    });
  } catch (e) {
    /* a cache write failure must not change the verdict */
    console.warn('[gate] profile cache failed:', e && e.message);
  }

  /* Everyone with access is in the one community. Idempotent, and a
     failure here must not block the sign-in. */
  if (allowed) {
    try {
      const join = await joinTradingArk(admin, userId);
      if (!join.ok) console.warn('[gate] trading-ark autojoin:', join.reason, join.error || '');
    } catch (e) {
      console.warn('[gate] trading-ark autojoin threw:', e && e.message);
    }
  }

  res.status(200).json({
    allowed, tier,
    reason: allowed ? undefined : 'no_role',
    nickname: member.nick || null,
  });
}

/* record the attempt even on denial, so the nightly cron can re-check
   someone who buys a membership later */
async function cacheDenial(admin, userId, discordUserId, tok, refresh, displayName) {
  try {
    await admin.from('profiles').upsert({
      id: userId,
      discord_user_id: discordUserId,
      discord_access_token: tok,
      discord_refresh_token: refresh,
      last_role_check: new Date().toISOString(),
      is_pro: false,
      plan: 'free',
      pro_source: null,
      pro_active_until: new Date().toISOString(),
      ...(displayName ? { display_name: displayName } : {}),
    });
  } catch { /* non-fatal */ }
}
