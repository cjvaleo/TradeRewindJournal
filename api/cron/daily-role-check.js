// Daily Discord role re-check cron. Schedule wired in vercel.json:
//   0 3 * * *   (03:00 UTC daily)
//
// COMMIT 1 SCOPE: scaffold + auth + token refresh + Case A (still Elite → extend window).
// COMMIT 2 will add Cases B–G (role transitions, role loss, Stripe fallback, token revoked).
// Profiles that don't match Case A are counted as `pending` and left untouched.

import { sbService } from '../_lib/supabase.js';
import { decryptToken, encryptToken } from '../_lib/crypto.js';
import { fetchGuildMember, refreshAccessToken } from '../_lib/discord.js';

const ELITE_WINDOW_DAYS         = 35;
const TOKEN_REFRESH_BUFFER_MS   = 5 * 60 * 1000;   // refresh if expires within 5 min
const RATE_LIMIT_DELAY_MS       = 50;              // between profile checks
const DAY_MS                    = 86400 * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Returns one of: 'case_a' | 'rate_limited' | 'error' | 'pending'
async function processProfile(sb, profile, env) {
  const userId = profile.id;

  // ── 1. Refresh access token if expired/expiring ─────────────────
  const tokenExpiresMs = profile.discord_token_expires
    ? new Date(profile.discord_token_expires).getTime()
    : 0;
  const needsRefresh = tokenExpiresMs < Date.now() + TOKEN_REFRESH_BUFFER_MS;

  let accessToken;
  if (needsRefresh) {
    let refreshPlain;
    try {
      refreshPlain = decryptToken(profile.discord_refresh_token, env.encKey);
    } catch (e) {
      console.warn('[cron] refresh-token decrypt failed', { user_id: userId, msg: e && e.message });
      return 'error';
    }
    let refreshed;
    try {
      refreshed = await refreshAccessToken(refreshPlain);
    } catch (e) {
      if (e && e.kind === 'token_revoked') {
        // Case F — handled in commit 2. For now log + skip.
        console.log('[cron] token_revoked (deferred to commit 2 Case F)', { user_id: userId });
        return 'pending';
      }
      console.warn('[cron] token refresh threw', { user_id: userId, msg: e && e.message });
      return 'error';
    }
    // Persist rotated tokens immediately.
    const encAccess  = encryptToken(refreshed.access,  env.encKey);
    const encRefresh = encryptToken(refreshed.refresh, env.encKey);
    const { error: tErr } = await sb
      .from('profiles')
      .update({
        discord_access_token:  encAccess,
        discord_refresh_token: encRefresh,
        discord_token_expires: refreshed.expiresIso,
      })
      .eq('id', userId);
    if (tErr) {
      console.error('[cron] token persist failed', { user_id: userId, msg: tErr.message });
      return 'error';
    }
    accessToken = refreshed.access;
  } else {
    try {
      accessToken = decryptToken(profile.discord_access_token, env.encKey);
    } catch (e) {
      console.warn('[cron] access-token decrypt failed', { user_id: userId, msg: e && e.message });
      return 'error';
    }
  }

  // ── 2. Fetch guild member ───────────────────────────────────────
  let member;
  try {
    member = await fetchGuildMember(accessToken, env.guildId);
  } catch (e) {
    console.warn('[cron] guild-member fetch threw', { user_id: userId, msg: e && e.message });
    return 'error';
  }
  if (member.status === 429) {
    console.warn('[cron] rate-limited by Discord', { user_id: userId });
    return 'rate_limited';
  }
  if (member.status === 401) {
    // Case F — handled in commit 2.
    console.log('[cron] guild-member 401 (deferred to commit 2 Case F)', { user_id: userId });
    return 'pending';
  }
  if (member.status === 404) {
    // Case D/E (role loss) — handled in commit 2.
    console.log('[cron] guild-member 404 (deferred to commit 2 Case D/E)', { user_id: userId });
    return 'pending';
  }
  if (member.status !== 200) {
    console.warn('[cron] guild-member unexpected status', { user_id: userId, status: member.status });
    return 'error';
  }

  const roles      = Array.isArray(member.roles) ? member.roles : [];
  const hasElite   = roles.includes(env.eliteRoleId);
  const hasPremium = roles.includes(env.premiumRoleId);
  const oldSource  = profile.pro_source;

  // ── 3. CASE A — still Elite, extend window (MAX preserves longer existing) ──
  if (oldSource === 'discord_elite' && hasElite) {
    const newWindowMs    = Date.now() + ELITE_WINDOW_DAYS * DAY_MS;
    const currentUntilMs = profile.pro_active_until
      ? new Date(profile.pro_active_until).getTime()
      : 0;
    const finalProUntilIso = new Date(Math.max(currentUntilMs, newWindowMs)).toISOString();

    const { error: upErr } = await sb
      .from('profiles')
      .update({
        pro_active_until: finalProUntilIso,
        last_role_check:  new Date().toISOString(),
      })
      .eq('id', userId);
    if (upErr) {
      console.error('[cron] case_a update failed', { user_id: userId, msg: upErr.message });
      return 'error';
    }

    console.log('[cron] case_a', {
      user_id: userId,
      pro_active_until: finalProUntilIso,
      extended: finalProUntilIso !== profile.pro_active_until,
    });
    return 'case_a';
  }

  // ── Cases B–G — commit 2 will fill these in. ────────────────────
  console.log('[cron] pending (Cases B–G, deferred to commit 2)', {
    user_id: userId, pro_source: oldSource, has_elite: hasElite, has_premium: hasPremium,
  });
  return 'pending';
}

export default async function handler(req, res) {
  const startMs = Date.now();

  if (req.method !== 'GET') {
    res.status(405).json({ error: 'method not allowed', allowed: ['GET'] });
    return;
  }

  // ── Auth: Bearer CRON_SECRET ────────────────────────────────────
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    console.error('[cron] missing CRON_SECRET');
    res.status(500).json({ error: 'server misconfigured' });
    return;
  }
  const authHeader = req.headers.authorization || '';
  const provided = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!provided || provided !== cronSecret) {
    console.warn('[cron] auth failed');
    res.status(401).json({ error: 'auth required' });
    return;
  }

  // ── Required env ────────────────────────────────────────────────
  const env = {
    encKey:        process.env.ENCRYPTION_KEY,
    guildId:       process.env.TRADING_ARK_GUILD_ID,
    eliteRoleId:   process.env.TRADING_ARK_ELITE_ROLE_ID,
    premiumRoleId: process.env.TRADING_ARK_PREMIUM_ROLE_ID,
  };
  if (!env.encKey || !env.guildId || !env.eliteRoleId || !env.premiumRoleId) {
    console.error('[cron] missing env', {
      hasEncKey: !!env.encKey, hasGuildId: !!env.guildId,
      hasEliteRole: !!env.eliteRoleId, hasPremiumRole: !!env.premiumRoleId,
    });
    res.status(500).json({ error: 'server misconfigured' });
    return;
  }

  const sb = sbService();

  // ── Query Discord-source profiles ───────────────────────────────
  const { data: profiles, error: readErr } = await sb
    .from('profiles')
    .select('id, pro_source, pro_active_until, stripe_subscription_id, discord_user_id, discord_access_token, discord_refresh_token, discord_token_expires, last_role_check')
    .in('pro_source', ['discord_premium', 'discord_elite']);
  if (readErr) {
    console.error('[cron] profile query failed', readErr.message);
    res.status(500).json({ error: 'profile query failed' });
    return;
  }

  const counts = { case_a: 0, errors: 0, rate_limited: 0, pending: 0 };

  for (let i = 0; i < profiles.length; i++) {
    const profile = profiles[i];
    try {
      const result = await processProfile(sb, profile, env);
      if (result === 'case_a')            counts.case_a++;
      else if (result === 'rate_limited') counts.rate_limited++;
      else if (result === 'pending')      counts.pending++;
      else                                counts.errors++;
    } catch (e) {
      console.error('[cron] processProfile threw', { user_id: profile.id, msg: e && e.message });
      counts.errors++;
    }
    if (i < profiles.length - 1) await sleep(RATE_LIMIT_DELAY_MS);
  }

  const result = {
    processed: profiles.length,
    case_a:    counts.case_a,
    errors:    counts.errors,
    rate_limited: counts.rate_limited,
    pending:   counts.pending,   // commit-1 artifact; removed when Cases B–G land
    duration_ms: Date.now() - startMs,
  };
  console.log('[cron] complete', result);
  res.status(200).json(result);
}
