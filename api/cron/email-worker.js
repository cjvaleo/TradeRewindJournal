// Email worker — drains queued rows from email_log via Resend.
// Schedule: every 5 minutes (wired in vercel.json).
//
// Edge runtime — Resend SDK supports it, no node:crypto need here.
// Auth via Bearer CRON_SECRET (same as daily-role-check).

export const config = { runtime: 'edge' };

import { Resend } from 'resend';
import { createClient } from '@supabase/supabase-js';

const BATCH_LIMIT         = 50;
const RATE_LIMIT_DELAY_MS = 150;   // Resend allows 10/sec; 150ms = safe margin

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const json  = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
});

let _sb;
function getSb() {
  if (_sb) return _sb;
  _sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } }
  );
  return _sb;
}

let _resend;
function getResend() {
  if (_resend) return _resend;
  _resend = new Resend(process.env.RESEND_API_KEY);
  return _resend;
}

async function getFirstName(sb, userId) {
  // 1. Prefer auth.users.user_metadata.full_name — that's typically a real
  //    name from OAuth or signup ("Christian Valeo"), whereas profiles.display_name
  //    is often a handle the user picked ("valeo"). Split on whitespace, first word.
  try {
    const { data: userData, error } = await sb.auth.admin.getUserById(userId);
    if (!error && userData && userData.user && userData.user.user_metadata) {
      const fullName = userData.user.user_metadata.full_name;
      if (fullName && typeof fullName === 'string') {
        const firstWord = fullName.trim().split(/\s+/)[0];
        if (firstWord) return firstWord;
      }
    }
  } catch (e) {
    console.warn('[email-worker] auth.admin.getUserById failed', { user_id: userId, msg: e && e.message });
  }

  // 2. Fall back to profiles.display_name / username (often a handle, but
  //    better than the generic 'there' fallback).
  try {
    const { data: profile } = await sb
      .from('profiles')
      .select('display_name, username')
      .eq('id', userId)
      .maybeSingle();
    const name = (profile && (profile.display_name || profile.username)) || '';
    const trimmed = name.trim();
    if (trimmed) return trimmed.split(/\s+/)[0];
  } catch (e) {
    console.warn('[email-worker] profile lookup failed', { user_id: userId, msg: e && e.message });
  }

  // 3. Final fallback
  return 'there';
}

// Standardized email footer — appended to every template via the
// renderBody wrapper. Three lines: divider, Rewind + legal links,
// unsubscribe address. Plain-text format because the renderBody
// templates are plain-text bodies (we send via Resend with the
// `text` field, not `html`).
function _legalFooter(siteUrl) {
  return `

————
Rewind  ·  ${siteUrl}/terms  ·  ${siteUrl}/privacy
Unsubscribe: mailto:cjvaleo@gmail.com?subject=Unsubscribe%20me`;
}

// Public wrapper — calls the raw body renderer then appends the legal
// footer so every outgoing email carries the same Terms / Privacy /
// Unsubscribe block. Templates not defined in _renderBodyRaw return
// null and skip the footer.
function renderBody(templateId, ctx) {
  const body = _renderBodyRaw(templateId, ctx);
  if (!body) return null;
  return body + _legalFooter(ctx.siteUrl);
}

// Plain-text bodies. Voice matched to rewind-email-copy.md.
// Only references data we actually have in scope (firstName + env URLs).
function _renderBodyRaw(templateId, ctx) {
  switch (templateId) {

    case 'subscription-canceled':
      return `Hey ${ctx.firstName},

Your Rewind subscription is canceled. Your Pro features have ended.

What this means:
  · Your trade history, journal entries, and all your data are 100% safe
  · You're back on the free plan: still log trades, still see stats, just with the free-tier limits
  · You can resubscribe any time — your data picks up right where you left off

Two things might be useful:
  · If this was an accident, restart in two clicks:
    → ${ctx.siteUrl}/upgrade
  · If something about Rewind didn't work for you, hit reply and tell me. I read everything.

Thanks for trying Rewind. Hope to see you back.

Manage your account anytime: ${ctx.siteUrl}/account

— Christian
  Rewind`;

    case 'payment-failed':
      return `Hey ${ctx.firstName},

Stripe tried to charge your Rewind subscription but the payment didn't go through. Usually this is an expired card or insufficient funds.

We'll retry automatically over the next few days, but you can fix it now in about 30 seconds:

  → ${ctx.siteUrl}/upgrade

Your Pro features stay active for now. If we can't collect within a few days, Pro will pause until payment succeeds. Your trades and data stay safe regardless — nothing gets deleted.

If you wanted to cancel, no worries — just reply to this email.

— Christian
  Rewind`;

    case 'role-upgraded':
      return `Hey ${ctx.firstName},

We just spotted your new Trading Ark Elite role on Discord. Nice.

What's changing automatically:

  · Your $9/mo Stripe subscription is being canceled today
  · You'll get a prorated refund for the unused portion of this month — usually shows up within 5–10 business days
  · Rewind Pro stays active, completely free, paid by Whop via your Elite membership

Nothing to do on your end. Enjoy.

— Christian
  Rewind`;

    case 'role-lost-elite':
      return `Hey ${ctx.firstName},

Our daily Discord check didn't find your Trading Ark Elite role today.

What this means: your Rewind Pro features have paused. Your trades and data stay safe — nothing's deleted.

How to fix it:

  1. Did you cancel Whop? Re-subscribe to Elite:
     → ${ctx.whopEliteUrl}

  2. Downgraded to Premium on Whop? Re-OAuth on Rewind to switch to Pro · Premium ($9/mo):
     → ${ctx.siteUrl}/upgrade

  3. Still subscribed but role missing? Ping Whop support — usually a Discord sync issue they can fix fast.

— Christian
  Rewind`;

    case 'role-lost-premium':
      return `Hey ${ctx.firstName},

Our daily Discord check didn't find your Trading Ark Premium role today, so a heads-up.

What's happening:
  · Your Rewind Pro · Premium has paused (your trades and data stay safe)
  · You can re-subscribe on Whop to get the role back, or switch to Pro · Direct

Three ways to fix it:

  1. Did you cancel Whop? Re-subscribe at Premium:
     → ${ctx.whopPremiumUrl}

  2. Want to switch to a Rewind-paid plan instead? Pro · Direct is $19/mo:
     → ${ctx.siteUrl}/upgrade

  3. Still subscribed but role missing? Ping Whop support.

— Christian
  Rewind`;

    case 'role-downgraded-elite-to-premium':
      return `Hey ${ctx.firstName},

You no longer have Elite access in Trading Ark Discord, but we noticed you still have the Premium role. Your Pro features will continue for 7 more days while you set up Premium billing.

  → Set up Premium ($9/mo): ${ctx.siteUrl}/upgrade

Or, if you'd like to upgrade back to Elite, rejoin via Whop: ${ctx.whopEliteUrl}

Questions? Just reply to this email.

— Christian
  Rewind`;

    default:
      return null;
  }
}

async function processRow(sb, resend, row, env) {
  const ctx = {
    firstName:      await getFirstName(sb, row.user_id),
    siteUrl:        env.siteUrl,
    whopPremiumUrl: env.whopPremiumUrl,
    whopEliteUrl:   env.whopEliteUrl,
  };

  const body = renderBody(row.template_id, ctx);
  if (!body) {
    const msg = `unknown template_id: ${row.template_id}`;
    console.error('[email-worker] ' + msg, { row_id: row.id });
    await sb.from('email_log').update({
      status: 'failed',
      error_message: msg,
    }).eq('id', row.id);
    return 'failed';
  }

  try {
    const result = await resend.emails.send({
      from:    `${env.fromName} <${env.fromAddress}>`,
      to:      row.to_address,
      subject: row.subject,
      text:    body,
      replyTo: env.fromAddress,
    });
    if (result.error) {
      throw new Error(result.error.message || JSON.stringify(result.error));
    }
    const resendId = result.data && result.data.id;
    await sb.from('email_log').update({
      status:    'sent',
      resend_id: resendId,
      sent_at:   new Date().toISOString(),
    }).eq('id', row.id);
    console.log('[email-worker] sent', {
      row_id: row.id, template_id: row.template_id, resend_id: resendId,
    });
    return 'sent';
  } catch (e) {
    const errMsg = ((e && e.message) ? e.message : String(e)).slice(0, 1000);
    await sb.from('email_log').update({
      status: 'failed',
      error_message: errMsg,
    }).eq('id', row.id);
    console.warn('[email-worker] send failed', {
      row_id: row.id, template_id: row.template_id, msg: errMsg,
    });
    return 'failed';
  }
}

export default async function handler(request) {
  const startMs = Date.now();

  if (request.method !== 'GET') {
    return json({ error: 'method not allowed', allowed: ['GET'] }, 405);
  }

  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    console.error('[email-worker] missing CRON_SECRET');
    return json({ error: 'server misconfigured' }, 500);
  }
  const authHeader = request.headers.get('authorization') || '';
  const provided = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!provided || provided !== cronSecret) {
    return json({ error: 'auth required' }, 401);
  }

  const env = {
    siteUrl:        process.env.NEXT_PUBLIC_SITE_URL,
    whopPremiumUrl: process.env.NEXT_PUBLIC_WHOP_PREMIUM_URL,
    whopEliteUrl:   process.env.NEXT_PUBLIC_WHOP_ELITE_URL,
    fromName:       process.env.EMAIL_FROM_NAME,
    fromAddress:    process.env.EMAIL_FROM_ADDRESS,
  };
  if (!env.siteUrl || !env.fromName || !env.fromAddress || !process.env.RESEND_API_KEY) {
    console.error('[email-worker] missing env', {
      hasSiteUrl: !!env.siteUrl, hasFromName: !!env.fromName,
      hasFromAddress: !!env.fromAddress, hasResendKey: !!process.env.RESEND_API_KEY,
    });
    return json({ error: 'server misconfigured' }, 500);
  }

  const sb     = getSb();
  const resend = getResend();

  const { data: rows, error: readErr } = await sb
    .from('email_log')
    .select('id, user_id, to_address, template_id, subject')
    .eq('status', 'queued')
    .order('created_at', { ascending: true })
    .limit(BATCH_LIMIT);
  if (readErr) {
    console.error('[email-worker] email_log query failed', readErr.message);
    return json({ error: 'query failed' }, 500);
  }

  const counts = { sent: 0, failed: 0 };
  for (let i = 0; i < rows.length; i++) {
    try {
      const r = await processRow(sb, resend, rows[i], env);
      if (r === 'sent') counts.sent++;
      else              counts.failed++;
    } catch (e) {
      console.error('[email-worker] processRow threw', { row_id: rows[i].id, msg: e && e.message });
      counts.failed++;
    }
    if (i < rows.length - 1) await sleep(RATE_LIMIT_DELAY_MS);
  }

  const result = {
    processed:    rows.length,
    sent:         counts.sent,
    failed:       counts.failed,
    duration_ms:  Date.now() - startMs,
  };
  console.log('[email-worker] complete', result);
  return json(result, 200);
}
