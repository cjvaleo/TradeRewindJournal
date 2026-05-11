// Daily Discord role re-check cron. Schedule wired in vercel.json:
//   0 3 * * *   (03:00 UTC daily)
//
// Cases (per spec § 9 + Case G added during build):
//   A — still Elite     → extend Elite window (MAX-guarded)
//   B — still Premium   → extend if Stripe sub present; else 7d grace
//   C — Premium → Elite → upgrade source + extend + email "upgraded"
//   D — Elite → no role → Stripe fallback if sub present; else revoke + email
//   E — Premium → no role → Stripe fallback if sub present; else revoke + email
//   F — token revoked   → Stripe fallback if sub present; else revoke + email
//   G — Elite → Premium → Stripe fallback if sub present; else discord_premium + 7d grace + email
//
// Per-profile errors are logged + counted but never abort the cron. Rate
// limited (429) does NOT update last_role_check — retried tomorrow.

import { sbService } from '../_lib/supabase.js';
import { decryptToken, encryptToken } from '../_lib/crypto.js';
import { fetchGuildMember, refreshAccessToken } from '../_lib/discord.js';
import { getStripe } from '../_lib/stripe.js';

const ELITE_WINDOW_DAYS       = 35;
const PREMIUM_GRACE_DAYS      = 7;       // when Discord-Premium has no Stripe sub
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

// ── Stripe fallback lookup ──────────────────────────────────────
// Returns 'direct' | 'premium' | null. null = no usable Stripe sub
// (canceled, expired, missing metadata.plan, or API call threw).
async function fetchSubscriptionPlan(stripe, subId) {
  try {
    const sub = await stripe.subscriptions.retrieve(subId);
    if (sub.status === 'canceled' || sub.status === 'incomplete_expired') return null;
    const plan = sub.metadata && sub.metadata.plan;
    return (plan === 'direct' || plan === 'premium') ? plan : null;
  } catch (e) {
    console.warn('[cron] fetchSubscriptionPlan failed', { sub_id: subId, msg: e && e.message });
    return null;
  }
}

// ── Email queue with dedup ──────────────────────────────────────
// Dedup rule (per Q3.a in approved spec):
//   Skip if a row exists with same (user_id, template_id) AND
//     (status='queued') OR (status='sent' AND sent_at > NOW-24h).
// Best-effort: failures here do NOT propagate (won't sink the cron).
async function queueEmail(sb, userId, templateId, subject) {
  try {
    // Check 1: any queued row (any age — queued means undelivered)
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

    // Check 2: recently sent (within 24h)
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

    // Look up user email
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

// ── Helper: role loss (Cases D and E) ───────────────────────────
async function handleRoleLoss(sb, stripe, profile) {
  const userId    = profile.id;
  const oldSource = profile.pro_source;

  if (profile.stripe_subscription_id) {
    const planKind = await fetchSubscriptionPlan(stripe, profile.stripe_subscription_id);
    if (planKind) {
      const { error: upErr } = await sb.from('profiles').update({
        pro_source:      `stripe_${planKind}`,
        last_role_check: nowIso(),
      }).eq('id', userId);
      if (upErr) throw new Error(`fallback update failed: ${upErr.message}`);
      console.log('[cron] role-loss fallback to stripe', {
        user_id: userId, old_source: oldSource, new_source: `stripe_${planKind}`,
      });
      return oldSource === 'discord_elite' ? 'case_d_kept' : 'case_e_kept';
    }
  }

  // No Stripe fallback — revoke
  const { error: upErr } = await sb.from('profiles').update({
    is_pro:           false,
    pro_source:       null,
    pro_active_until: nowIso(),
    last_role_check:  nowIso(),
  }).eq('id', userId);
  if (upErr) throw new Error(`revoke update failed: ${upErr.message}`);

  const template = oldSource === 'discord_elite' ? 'role-lost-elite' : 'role-lost-premium';
  const subject  = oldSource === 'discord_elite'
    ? 'Your Pro · Elite access has ended'
    : 'Your Pro · Premium access has ended';
  await queueEmail(sb, userId, template, subject);

  console.log('[cron] role-loss revoked', { user_id: userId, old_source: oldSource });
  return oldSource === 'discord_elite' ? 'case_d_revoked' : 'case_e_revoked';
}

// ── Helper: token revoked (Case F) ──────────────────────────────
async function handleTokenRevoked(sb, stripe, profile) {
  const userId    = profile.id;
  const oldSource = profile.pro_source;

  if (profile.stripe_subscription_id) {
    const planKind = await fetchSubscriptionPlan(stripe, profile.stripe_subscription_id);
    if (planKind) {
      const { error: upErr } = await sb.from('profiles').update({
        pro_source:      `stripe_${planKind}`,
        last_role_check: nowIso(),
      }).eq('id', userId);
      if (upErr) throw new Error(`fallback update failed: ${upErr.message}`);
      console.log('[cron] case_f_kept (stripe fallback)', {
        user_id: userId, new_source: `stripe_${planKind}`,
      });
      return 'case_f_kept';
    }
  }

  const { error: upErr } = await sb.from('profiles').update({
    is_pro:           false,
    pro_source:       null,
    pro_active_until: nowIso(),
    last_role_check:  nowIso(),
  }).eq('id', userId);
  if (upErr) throw new Error(`revoke update failed: ${upErr.message}`);

  const template = oldSource === 'discord_elite' ? 'role-lost-elite' : 'role-lost-premium';
  await queueEmail(sb, userId, template, 'Re-link your Discord to keep your Pro');

  console.log('[cron] case_f_revoked', { user_id: userId, old_source: oldSource });
  return 'case_f_revoked';
}

// ── Main per-profile dispatcher ─────────────────────────────────
async function processProfile(sb, stripe, profile, env) {
  const userId = profile.id;

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
        return await handleTokenRevoked(sb, stripe, profile);   // CASE F
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
    return await handleTokenRevoked(sb, stripe, profile);    // CASE F
  }
  if (member.status === 404) {
    return await handleRoleLoss(sb, stripe, profile);        // CASE D or E
  }
  if (member.status !== 200) {
    console.warn('[cron] guild-member unexpected status', { user_id: userId, status: member.status });
    return 'error';
  }

  // 3. Parse roles + dispatch by (oldSource × current roles)
  const roles      = Array.isArray(member.roles) ? member.roles : [];
  const hasElite   = roles.includes(env.eliteRoleId);
  const hasPremium = roles.includes(env.premiumRoleId);
  const oldSource  = profile.pro_source;

  // No matching role at all → loss (D or E)
  if (!hasElite && !hasPremium) {
    return await handleRoleLoss(sb, stripe, profile);
  }

  // CASE A — still Elite, extend window (MAX-guarded)
  if (oldSource === 'discord_elite' && hasElite) {
    const finalIso = maxProActiveUntil(profile.pro_active_until, ELITE_WINDOW_DAYS);
    const { error: upErr } = await sb.from('profiles').update({
      pro_active_until: finalIso,
      last_role_check:  nowIso(),
    }).eq('id', userId);
    if (upErr) throw new Error(`case_a update failed: ${upErr.message}`);
    console.log('[cron] case_a', { user_id: userId, pro_active_until: finalIso });
    return 'case_a';
  }

  // CASE B — still Premium. With Stripe sub: extend window. Without: 7d grace.
  if (oldSource === 'discord_premium' && hasPremium && !hasElite) {
    const updates = { last_role_check: nowIso() };
    let result;
    if (profile.stripe_subscription_id) {
      updates.pro_active_until = maxProActiveUntil(profile.pro_active_until, ELITE_WINDOW_DAYS);
      result = 'case_b_extended';
    } else {
      // 7d grace — let pro_active_until run out naturally
      result = 'case_b_grace';
    }
    const { error: upErr } = await sb.from('profiles').update(updates).eq('id', userId);
    if (upErr) throw new Error(`case_b update failed: ${upErr.message}`);
    console.log('[cron] ' + result, {
      user_id: userId, has_stripe: !!profile.stripe_subscription_id,
    });
    return result;
  }

  // CASE C — Premium → Elite upgrade
  if (oldSource === 'discord_premium' && hasElite) {
    const finalIso = maxProActiveUntil(profile.pro_active_until, ELITE_WINDOW_DAYS);
    const { error: upErr } = await sb.from('profiles').update({
      pro_source:       'discord_elite',
      pro_active_until: finalIso,
      last_role_check:  nowIso(),
    }).eq('id', userId);
    if (upErr) throw new Error(`case_c update failed: ${upErr.message}`);
    await queueEmail(sb, userId, 'role-upgraded', "You've been upgraded to Pro · Elite");
    console.log('[cron] case_c', { user_id: userId, pro_active_until: finalIso });
    return 'case_c';
  }

  // CASE G — Elite → Premium downgrade
  if (oldSource === 'discord_elite' && hasPremium && !hasElite) {
    if (profile.stripe_subscription_id) {
      const planKind = await fetchSubscriptionPlan(stripe, profile.stripe_subscription_id);
      if (planKind) {
        const { error: upErr } = await sb.from('profiles').update({
          pro_source:      `stripe_${planKind}`,
          last_role_check: nowIso(),
        }).eq('id', userId);
        if (upErr) throw new Error(`case_g update failed: ${upErr.message}`);
        console.log('[cron] case_g_stripe_fallback', {
          user_id: userId, new_source: `stripe_${planKind}`,
        });
        return 'case_g_stripe_fallback';
      }
    }
    // No Stripe sub — switch to discord_premium with 7-day grace
    const graceIso = new Date(Date.now() + PREMIUM_GRACE_DAYS * DAY_MS).toISOString();
    const { error: upErr } = await sb.from('profiles').update({
      pro_source:       'discord_premium',
      pro_active_until: graceIso,
      last_role_check:  nowIso(),
    }).eq('id', userId);
    if (upErr) throw new Error(`case_g update failed: ${upErr.message}`);
    await queueEmail(sb, userId, 'role-downgraded-elite-to-premium',
      'Set up billing to keep Pro · Premium');
    console.log('[cron] case_g_grace', { user_id: userId, pro_active_until: graceIso });
    return 'case_g_grace';
  }

  // Shouldn't reach — defensive log.
  console.warn('[cron] unmatched case', {
    user_id: userId, old_source: oldSource, has_elite: hasElite, has_premium: hasPremium,
  });
  return 'error';
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

  const sb     = sbService();
  const stripe = getStripe();

  const { data: profiles, error: readErr } = await sb
    .from('profiles')
    .select('id, pro_source, pro_active_until, stripe_subscription_id, discord_user_id, discord_access_token, discord_refresh_token, discord_token_expires, last_role_check')
    .in('pro_source', ['discord_premium', 'discord_elite']);
  if (readErr) {
    console.error('[cron] profile query failed', readErr.message);
    res.status(500).json({ error: 'profile query failed' });
    return;
  }

  const counts = {
    case_a:                  0,
    case_b_extended:         0,
    case_b_grace:            0,
    case_c:                  0,
    case_d_kept:             0,
    case_d_revoked:          0,
    case_e_kept:             0,
    case_e_revoked:          0,
    case_f_kept:             0,
    case_f_revoked:          0,
    case_g_stripe_fallback:  0,
    case_g_grace:            0,
    rate_limited:            0,
    errors:                  0,
  };

  for (let i = 0; i < profiles.length; i++) {
    const profile = profiles[i];
    try {
      const result = await processProfile(sb, stripe, profile, env);
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
