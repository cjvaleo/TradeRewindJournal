// Daily Discord role re-check cron. Schedule wired in vercel.json:
//   0 3 * * *   (03:00 UTC daily)
//
// As of the May 2026 Trading Ark consolidation, there is ONE paid TA tier —
// Premium — and holding the Premium role grants free Rewind Pro. The cron is
// now a simple extend/revoke:
//
//   discord_premium + Premium role present  → extend pro_active_until 35d
//   discord_premium + Premium role absent   → revoke Pro
//   discord_premium + token revoked / 401   → revoke Pro
//   discord_premium + not in guild / 404    → revoke Pro
//   discord_premium + Discord 429           → skip (retried tomorrow)
//   discord_elite (any state)               → no-op + DRIFT log
//
// There is NO Stripe fallback anymore — discord_premium entitlements never
// involve Stripe (Premium is free). The Direct ($19/mo) Stripe tier carries
// pro_source='stripe_direct' and is NOT selected by this cron's query.
//
// discord_elite is retired. After the data migration there should be zero
// such rows; if one appears it's logged as drift and left untouched (neither
// extended nor revoked) so a re-created role or missed migration is visible.
//
// Per-profile errors are logged + counted but never abort the cron. Rate
// limited (429) does NOT update last_role_check — retried tomorrow.

import { sbService } from '../_lib/supabase.js';
import { decryptToken, encryptToken } from '../_lib/crypto.js';
import { fetchGuildMember, refreshAccessToken } from '../_lib/discord.js';
import { joinTradingArk } from '../../lib/community.js';

const PRO_WINDOW_DAYS         = 35;
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;
const RATE_LIMIT_DELAY_MS     = 50;
const DAY_MS                  = 86400 * 1000;

const sleep  = (ms) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();

// MAX-guarded extension — never shortens an existing longer window.
function maxProActiveUntil(existingIso, daysFromNow) {
  const newMs     = Date.now() + daysFromNow * DAY_MS;
  const currentMs = existingIso ? new Date(existingIso).getTime() : 0;
  return new Date(Math.max(currentMs, newMs)).toISOString();
}

// Idempotent + graceful Trading Ark auto-join wrapper. Never throws.
async function _fireAutojoin(sb, userId, label) {
  try {
    const joinRes = await joinTradingArk(sb, userId);
    console.log('[community-autojoin] ' + label, userId, joinRes);
  } catch (e) {
    console.warn('[community-autojoin] ' + label + ' threw', userId, e && e.message);
  }
}

// ── Email queue with dedup ──────────────────────────────────────
// Dedup rule: skip if a row exists with same (user_id, template_id) AND
//   (status='queued') OR (status='sent' AND sent_at > NOW-24h).
// Best-effort: failures here do NOT propagate (won't sink the cron).
async function queueEmail(sb, userId, templateId, subject) {
  try {
    const { data: queued } = await sb
      .from('email_log')
      .select('id')
      .eq('user_id', userId)
      .eq('template_id', templateId)
      .eq('status', 'queued')
      .limit(1);
    if (queued && queued.length) {
      console.log('[cron] email dedup: already queued', { user_id: userId, template_id: templateId });
      return;
    }

    const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const { data: recentSent } = await sb
      .from('email_log')
      .select('id')
      .eq('user_id', userId)
      .eq('template_id', templateId)
      .eq('status', 'sent')
      .gte('sent_at', cutoff)
      .limit(1);
    if (recentSent && recentSent.length) {
      console.log('[cron] email dedup: sent in last 24h', { user_id: userId, template_id: templateId });
      return;
    }

    let toAddress = 'unknown@placeholder.local';
    try {
      const { data: userData } = await sb.auth.admin.getUserById(userId);
      if (userData && userData.user && userData.user.email) toAddress = userData.user.email;
    } catch (e) {
      console.warn('[cron] queueEmail: user email lookup failed', { user_id: userId, msg: e && e.message });
    }

    const { error: insErr } = await sb.from('email_log').insert({
      user_id:     userId,
      to_address:  toAddress,
      template_id: templateId,
      subject,
      status:      'queued',
    });
    if (insErr) {
      console.warn('[cron] email_log insert failed', { user_id: userId, msg: insErr.message });
    }
  } catch (e) {
    console.warn('[cron] queueEmail threw (non-fatal)', { user_id: userId, msg: e && e.message });
  }
}

// ── Revoke Pro ──────────────────────────────────────────────────
// No Stripe fallback — discord_premium entitlements are free and never have
// a Stripe subscription behind them. Revoke is unconditional.
async function revokePro(sb, profile, reason) {
  const userId = profile.id;
  const { error: upErr } = await sb.from('profiles').update({
    is_pro:           false,
    pro_source:       null,
    pro_active_until: nowIso(),
    last_role_check:  nowIso(),
  }).eq('id', userId);
  if (upErr) throw new Error(`revoke update failed: ${upErr.message}`);
  await queueEmail(sb, userId, 'role-lost-premium', 'Your Rewind Pro access has ended');
  console.log('[cron] revoked', { user_id: userId, reason });
  return 'revoked';
}

// ── Main per-profile dispatcher ─────────────────────────────────
async function processProfile(sb, profile, env) {
  const userId = profile.id;

  // discord_elite retired May 2026. After the data migration there should be
  // ZERO discord_elite rows. If one appears: log drift and no-op — do not
  // extend, do not revoke. Surfaces a re-created Elite role or a profile that
  // missed the migration.
  if (profile.pro_source === 'discord_elite') {
    console.warn('[cron] DRIFT — discord_elite profile post-migration (no-op)', { user_id: userId });
    return 'elite_drift';
  }

  // 1. Refresh access token if expired/expiring
  const tokenExpiresMs = profile.discord_token_expires
    ? new Date(profile.discord_token_expires).getTime()
    : 0;
  const needsRefresh = tokenExpiresMs < Date.now() + TOKEN_REFRESH_BUFFER_MS;

  let accessToken;
  if (needsRefresh) {
    let refreshPlain;
    try { refreshPlain = decryptToken(profile.discord_refresh_token, env.encKey); }
    catch (e) {
      console.warn('[cron] refresh-token decrypt failed', { user_id: userId, msg: e && e.message });
      return 'error';
    }
    let refreshed;
    try { refreshed = await refreshAccessToken(refreshPlain); }
    catch (e) {
      if (e && e.kind === 'token_revoked') {
        return await revokePro(sb, profile, 'token_revoked');
      }
      console.warn('[cron] token refresh threw', { user_id: userId, msg: e && e.message });
      return 'error';
    }
    const encAccess  = encryptToken(refreshed.access,  env.encKey);
    const encRefresh = encryptToken(refreshed.refresh, env.encKey);
    const { error: tErr } = await sb.from('profiles').update({
      discord_access_token:  encAccess,
      discord_refresh_token: encRefresh,
      discord_token_expires: refreshed.expiresIso,
    }).eq('id', userId);
    if (tErr) {
      console.error('[cron] token persist failed', { user_id: userId, msg: tErr.message });
      return 'error';
    }
    accessToken = refreshed.access;
  } else {
    try { accessToken = decryptToken(profile.discord_access_token, env.encKey); }
    catch (e) {
      console.warn('[cron] access-token decrypt failed', { user_id: userId, msg: e && e.message });
      return 'error';
    }
  }

  // 2. Fetch guild member
  let member;
  try { member = await fetchGuildMember(accessToken, env.guildId); }
  catch (e) {
    console.warn('[cron] guild-member fetch threw', { user_id: userId, msg: e && e.message });
    return 'error';
  }
  if (member.status === 429) {
    console.warn('[cron] rate-limited by Discord', { user_id: userId });
    return 'rate_limited';   // do NOT update last_role_check
  }
  if (member.status === 401) {
    return await revokePro(sb, profile, 'token_revoked');
  }
  if (member.status === 404) {
    return await revokePro(sb, profile, 'not_in_guild');
  }
  if (member.status !== 200) {
    console.warn('[cron] guild-member unexpected status', { user_id: userId, status: member.status });
    return 'error';
  }

  // 3. Premium role present → extend. Absent → revoke.
  const roles      = Array.isArray(member.roles) ? member.roles : [];
  const hasPremium = roles.includes(env.premiumRoleId);

  if (!hasPremium) {
    return await revokePro(sb, profile, 'role_lost');
  }

  // Still Premium — extend the Pro window (MAX-guarded).
  const finalIso = maxProActiveUntil(profile.pro_active_until, PRO_WINDOW_DAYS);
  const { error: upErr } = await sb.from('profiles').update({
    pro_active_until: finalIso,
    last_role_check:  nowIso(),
  }).eq('id', userId);
  if (upErr) throw new Error(`extend update failed: ${upErr.message}`);
  console.log('[cron] extended', { user_id: userId, pro_active_until: finalIso });
  await _fireAutojoin(sb, userId, 'Cron extend (premium)');
  return 'extended';
}

export default async function handler(req, res) {
  const startMs = Date.now();

  if (req.method !== 'GET') {
    res.status(405).json({ error: 'method not allowed', allowed: ['GET'] });
    return;
  }

  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    console.error('[cron] missing CRON_SECRET');
    res.status(500).json({ error: 'server misconfigured' });
    return;
  }
  const authHeader = req.headers.authorization || '';
  const provided   = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!provided || provided !== cronSecret) {
    console.warn('[cron] auth failed');
    res.status(401).json({ error: 'auth required' });
    return;
  }

  // eliteRoleId is intentionally NOT required — the Elite role is retired and
  // the cron no longer checks for it.
  const env = {
    encKey:        process.env.ENCRYPTION_KEY,
    guildId:       process.env.TRADING_ARK_GUILD_ID,
    premiumRoleId: process.env.TRADING_ARK_PREMIUM_ROLE_ID,
  };
  if (!env.encKey || !env.guildId || !env.premiumRoleId) {
    console.error('[cron] missing env', {
      hasEncKey: !!env.encKey, hasGuildId: !!env.guildId,
      hasPremiumRole: !!env.premiumRoleId,
    });
    res.status(500).json({ error: 'server misconfigured' });
    return;
  }

  const sb = sbService();

  // Query still includes discord_elite so any drift rows get the DRIFT log.
  const { data: profiles, error: readErr } = await sb
    .from('profiles')
    .select('id, pro_source, pro_active_until, discord_user_id, discord_access_token, discord_refresh_token, discord_token_expires, last_role_check')
    .in('pro_source', ['discord_premium', 'discord_elite']);
  if (readErr) {
    console.error('[cron] profile query failed', readErr.message);
    res.status(500).json({ error: 'profile query failed' });
    return;
  }

  const counts = {
    extended:     0,
    revoked:      0,
    elite_drift:  0,
    rate_limited: 0,
    errors:       0,
  };

  for (let i = 0; i < profiles.length; i++) {
    const profile = profiles[i];
    try {
      const result = await processProfile(sb, profile, env);
      if (counts[result] !== undefined) counts[result]++;
      else counts.errors++;
    } catch (e) {
      console.error('[cron] processProfile threw', { user_id: profile.id, msg: e && e.message });
      counts.errors++;
    }
    if (i < profiles.length - 1) await sleep(RATE_LIMIT_DELAY_MS);
  }

  const result = {
    processed: profiles.length,
    ...counts,
    duration_ms: Date.now() - startMs,
  };
  console.log('[cron] complete', result);
  res.status(200).json(result);
}
