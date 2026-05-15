import {
  verifyState,
  readCookie,
  serializeCookie,
  encryptToken,
} from '../../_lib/crypto.js';
import { exchangeCode, fetchMe, fetchGuildMember } from '../../_lib/discord.js';
import { sbService } from '../../_lib/supabase.js';
import { joinTradingArk } from '../../../lib/community.js';

const STATE_TTL_SECONDS = 600;
// 35-day Pro window. The daily cron re-checks the Discord role and pushes
// this forward each day the role is still held, so it's effectively a
// rolling entitlement that lapses ~35 days after the role is lost.
const PRO_WINDOW_DAYS = 35;

// Redirect targets are an allowlisted, fixed set. The destination is decided
// by branch logic only — never by user-controlled input.
const REDIRECT = {
  // Elite role retired May 2026 — kept for safety (Branch A is now unreachable
  // unless the Elite role is re-created in Discord).
  WELCOME_ELITE:   '/welcome/elite',
  WELCOME_PREMIUM: '/welcome/premium',
  NO_ACCESS:       '/oauth-no-access',
  // /oauth-error?reason=... — reason is from a fixed vocabulary below.
  ERROR_BASE:      '/oauth-error',
};
const ERROR_REASONS = new Set([
  'access_denied',
  'token_revoked',
  'role_check_failed',
  'profile_missing',
]);

function redirect(res, location, cookies = []) {
  if (cookies.length) res.setHeader('Set-Cookie', cookies);
  res.statusCode = 302;
  res.setHeader('Location', location);
  res.end();
}

function errorRedirect(res, reason, cookies = []) {
  const safe = ERROR_REASONS.has(reason) ? reason : 'role_check_failed';
  return redirect(res, `${REDIRECT.ERROR_BASE}?reason=${safe}`, cookies);
}

export default async function handler(req, res) {
  const q = req.query || {};
  const { code, state, error: discordErr } = q;

  // ── (i) Discord-side error (user clicked Deny on authorize page) ──
  if (discordErr) {
    return errorRedirect(res, 'access_denied');
  }

  // ── (ii) Required params ──
  if (!code || !state) {
    res.status(400).json({ error: 'missing code or state' });
    return;
  }

  // ── (iii) Env ──
  const encKey         = process.env.ENCRYPTION_KEY;
  const guildId        = process.env.TRADING_ARK_GUILD_ID;
  const eliteRoleId    = process.env.TRADING_ARK_ELITE_ROLE_ID;
  const premiumRoleId  = process.env.TRADING_ARK_PREMIUM_ROLE_ID;
  const siteUrl        = process.env.NEXT_PUBLIC_SITE_URL;
  // eliteRoleId is NOT required — the Elite role is retired. If the env var
  // is unset, Branch A simply never matches (its detection becomes a no-op).
  if (!encKey || !guildId || !premiumRoleId || !siteUrl) {
    console.error('[oauth/callback] missing env', {
      hasEncKey: !!encKey, hasGuildId: !!guildId,
      hasPremiumRole: !!premiumRoleId, hasSiteUrl: !!siteUrl,
    });
    res.status(500).json({ error: 'server misconfigured' });
    return;
  }
  const isHttps = siteUrl.startsWith('https://');

  // ── (iv) State verification: HMAC, nonce cookie match, expiry ──
  const stateData = verifyState(state, encKey);
  if (!stateData) {
    res.status(400).json({ error: 'invalid state' });
    return;
  }
  const cookieNonce = readCookie(req, 'rwd_oauth_n');
  if (!cookieNonce || stateData.n !== cookieNonce) {
    res.status(400).json({ error: 'invalid state' });
    return;
  }
  const ageSec = Math.floor(Date.now() / 1000) - (stateData.t || 0);
  if (ageSec > STATE_TTL_SECONDS) {
    res.status(400).json({ error: 'session expired, please try again' });
    return;
  }
  const { p: plan, u: userId } = stateData;
  // plan is informational only — the branch decision is role-based, not
  // plan-based. 'elite' is still accepted in the state vocabulary for
  // backward-safety even though the upgrade page no longer offers it.
  if (!userId || (plan !== 'premium' && plan !== 'elite')) {
    res.status(400).json({ error: 'invalid state' });
    return;
  }

  // Accumulator for cookies set on the final response. The nonce cookie is
  // cleared unconditionally now — it's single-use.
  const cookiesToSet = [
    serializeCookie('rwd_oauth_n', '', {
      httpOnly: true, sameSite: 'Lax', path: '/', maxAge: 0, secure: isHttps,
    }),
  ];

  // ── (v) Exchange code for tokens ──
  let tokens;
  try { tokens = await exchangeCode(code); }
  catch (e) {
    console.warn('[oauth/callback] code exchange threw:', e && e.message);
    res.status(400).json({ error: 'code invalid or expired' });
    return;
  }
  if (!tokens.ok || !tokens.access_token) {
    console.warn('[oauth/callback] code exchange failed', { status: tokens.status });
    res.status(400).json({ error: 'code invalid or expired' });
    return;
  }

  // ── (vi) Fetch identity ──
  let me;
  try { me = await fetchMe(tokens.access_token); }
  catch (e) {
    console.warn('[oauth/callback] /users/@me threw:', e && e.message);
    return errorRedirect(res, 'role_check_failed', cookiesToSet);
  }
  if (me.status === 401) {
    return errorRedirect(res, 'token_revoked', cookiesToSet);
  }
  if (!me.ok || !me.id) {
    console.warn('[oauth/callback] /users/@me unexpected', { status: me.status });
    return errorRedirect(res, 'role_check_failed', cookiesToSet);
  }
  const discordUserId = me.id;

  // ── (vii) Fetch guild membership ──
  let member;
  try { member = await fetchGuildMember(tokens.access_token, guildId); }
  catch (e) {
    console.warn('[oauth/callback] guild member fetch threw:', e && e.message);
    return errorRedirect(res, 'role_check_failed', cookiesToSet);
  }
  if (member.status === 401) {
    return errorRedirect(res, 'token_revoked', cookiesToSet);
  }

  // ── (viii) Decide branch ──
  // 200 + roles array → Elite (retired) > Premium > none
  // 404 → not in guild → Branch C
  // other → unexpected; fail safe to role_check_failed
  const roles = Array.isArray(member.roles) ? member.roles : [];
  let branch;
  if (member.status === 404) {
    branch = 'C';
  } else if (member.status === 200) {
    // Elite role retired May 2026 — kept for safety. eliteRoleId may be
    // undefined; `roles.includes(undefined)` is false, so this is inert.
    if (eliteRoleId && roles.includes(eliteRoleId)) branch = 'A';
    else if (roles.includes(premiumRoleId))         branch = 'B';
    else                                            branch = 'C';
  } else {
    console.warn('[oauth/callback] guild member unexpected status', { status: member.status });
    return errorRedirect(res, 'role_check_failed', cookiesToSet);
  }

  // ── (ix) Encrypt tokens for storage ──
  const encAccess  = encryptToken(tokens.access_token, encKey);
  const encRefresh = tokens.refresh_token
    ? encryptToken(tokens.refresh_token, encKey)
    : null;
  const tokenExpires = tokens.expires_in
    ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
    : null;
  const nowIso = new Date().toISOString();
  const proUntilIso = new Date(Date.now() + PRO_WINDOW_DAYS * 86400 * 1000).toISOString();

  // ── (x) Build profile patch (branch-specific) ──
  // Both Branch A and Branch B grant free Pro now. Branch B (Premium) is the
  // live path: Trading Ark Premium is the single paid TA tier, and holding
  // the role grants Rewind Pro at no cost. There is no Stripe step anymore.
  const patch = {
    discord_user_id:        discordUserId,
    discord_access_token:   encAccess,
    discord_refresh_token:  encRefresh,
    discord_token_expires:  tokenExpires,
    last_role_check:        nowIso,
  };
  if (branch === 'A') {
    // Elite role retired May 2026 - kept for safety. Unreachable unless the
    // Elite role is re-created in Discord; preserved so it still works if so.
    patch.is_pro           = true;
    patch.pro_source       = 'discord_elite';
    patch.pro_active_until = proUntilIso;
  } else if (branch === 'B') {
    // Trading Ark Premium → free Rewind Pro.
    patch.is_pro           = true;
    patch.pro_source       = 'discord_premium';
    patch.pro_active_until = proUntilIso;
  }
  // Branch C: only the discord_* fields are written (no Pro grant).

  // ── (xi) Update profile (RLS bypassed via service role) ──
  const sb = sbService();
  const { data, error: upErr } = await sb
    .from('profiles')
    .update(patch)
    .eq('id', userId)
    .select('id');
  if (upErr) {
    console.error('[oauth/callback] profile update failed', {
      code: upErr.code, msg: upErr.message,
    });
    res.status(500).json({ error: 'profile update failed' });
    return;
  }
  if (!data || data.length === 0) {
    // Unexpected — user is auth'd in Supabase but has no profiles row.
    console.error('[oauth/callback] profile row missing', { userId });
    return errorRedirect(res, 'profile_missing', cookiesToSet);
  }

  console.log('[oauth/callback] branch=' + branch, { userId, discordUserId, plan });

  // ── (xii) Branch-specific redirect ──
  if (branch === 'A') {
    // Elite role retired May 2026 - kept for safety.
    try {
      const joinRes = await joinTradingArk(sb, userId);
      console.log('[community-autojoin] OAuth Branch A', userId, joinRes);
    } catch (e) {
      console.warn('[community-autojoin] OAuth Branch A threw', userId, e && e.message);
    }
    return redirect(res, REDIRECT.WELCOME_ELITE, cookiesToSet);
  }
  if (branch === 'B') {
    // Auto-join Trading Ark community. Idempotent + graceful — log on failure
    // but never fail the OAuth flow over a community-membership side effect.
    try {
      const joinRes = await joinTradingArk(sb, userId);
      console.log('[community-autojoin] OAuth Branch B (premium)', userId, joinRes);
    } catch (e) {
      console.warn('[community-autojoin] OAuth Branch B threw', userId, e && e.message);
    }
    return redirect(res, REDIRECT.WELCOME_PREMIUM, cookiesToSet);
  }
  // Branch C
  return redirect(res, REDIRECT.NO_ACCESS, cookiesToSet);
}
