# Rewind · Transactional Email Copy

**From-name:** `Christian from Rewind`
**From-address:** `hello@traderewindjournal.com`
**Reply-to:** `hello@traderewindjournal.com` (replies welcome — feels human)

All bodies below are written for **plain-text**. The visual mockups (`rewind-email-*.png`) show the HTML treatment — use them as design reference when building React Email components. The plain-text version should always be sent alongside the HTML version for accessibility + deliverability.

**Merge fields convention:** `{first_name}`, `{amount}`, `{next_billing_date}`, etc. — use whatever syntax Resend templates support (likely `{{first_name}}` if using their built-in templates).

---

## 1 · welcome-direct

**Template ID:** `welcome-direct`
**Triggered by:** Stripe `checkout.session.completed` where `metadata.plan = 'direct'`
**Subject:** `You're in — welcome to Pro · Direct`
**Preheader:** `Your Rewind Pro features are unlocked. Here's what's new.`

```
Hey {first_name},

You just upgraded to Pro · Direct. ${amount}/mo, next charge {next_billing_date}.

Three things you just unlocked:
  · Multi-account tracking — split futures, options, equities
  · CSV imports — bulk-load months of past trades in one go
  · Advanced stats, screenshots, and notes on every trade

If you've got a backlog of trades to import, start there:
  → {import_url}

I'm Christian — I built Rewind. Reply to this email any time if you
hit a snag or have a feature request. I read every one.

— Christian

————
Manage subscription: {account_url}
Refund within 7 days: {refund_url}
Just reply if you need anything.
```

**Required merge fields:** `first_name`, `amount` (e.g. "19.00"), `next_billing_date` (e.g. "December 7"), `import_url`, `account_url`, `refund_url`

---

## 2 · welcome-premium

**Template ID:** `welcome-premium`
**Triggered by:** Stripe `checkout.session.completed` where `metadata.plan = 'premium'`
**Subject:** `You're in — welcome to Pro · Premium (50% off)`
**Preheader:** `Your Rewind Pro features are unlocked. Trading Ark verified.`

```
Hey {first_name},

You're now on Pro · Premium — ${amount}/mo because you hold the
Trading Ark role on Discord. You save $10/mo vs. Pro · Direct.

What you just unlocked:
  · Multi-account tracking
  · CSV imports
  · Advanced stats, screenshots, notes
  · Trading Ark community (already active on Discord)

Two things to know:
  · Your $9/mo Stripe sub renews {next_billing_date}
  · Your Trading Ark membership ($50/mo) is billed separately by
    Whop — keep that active to keep your discount. If you ever lose
    the Discord role, your Rewind sub switches to Pro · Direct at
    $19/mo at next renewal (we'll email you first).

Start importing your trades:
  → {import_url}

Reply to this email any time — I read everything.

— Christian

————
Manage subscription: {account_url}
Refund within 7 days: {refund_url}
```

**Required merge fields:** `first_name`, `amount` (e.g. "9.00"), `next_billing_date`, `import_url`, `account_url`, `refund_url`

---

## 3 · welcome-elite

**Template ID:** `welcome-elite`
**Triggered by:** Server-side Elite activation (no Stripe involvement — Discord OAuth → Elite branch)
**Subject:** `You're Elite — Rewind is free for you`
**Preheader:** `Trading Ark Elite role verified. No Rewind charge, ever.`

```
Hey {first_name},

You're verified as Trading Ark Elite, which means Rewind Pro is
free for you. No subscription, no Stripe charge — Whop covers it.

Everything unlocked:
  · Multi-account tracking
  · CSV imports
  · Advanced stats, screenshots, notes
  · Trading Ark + Elite community (already active on Discord)

A few notes:
  · No Rewind charge, ever — Whop bills you $100/mo for Elite,
    that's it
  · We re-check your Elite role daily. If you lose it, you have
    14 days to get it back before Pro features pause
  · Your trades and data stay safe regardless

Get started:
  → {import_url}

I'm Christian — I built Rewind. Reply any time.

— Christian

————
Account: {account_url}
```

**Required merge fields:** `first_name`, `import_url`, `account_url`

---

## 4 · payment-failed

**Template ID:** `payment-failed`
**Triggered by:** Stripe `invoice.payment_failed`
**Subject:** `Quick note — your Rewind payment didn't go through`
**Preheader:** `Your card was declined. We'll retry, but you can fix it now.`

```
Hey {first_name},

Stripe tried to charge ${amount} for your Rewind subscription
but it didn't go through. Usually this is an expired card or
insufficient funds.

We'll retry automatically over the next few days, but you can
fix it right now in about 30 seconds:

  → {update_payment_url}

Your Pro features stay active for now. If we can't collect by
{pause_date}, Pro features will pause until payment succeeds.
Your trades and stats stay safe — nothing gets deleted.

If you wanted to cancel, no worries — just reply to this email
and I'll take care of it.

— Christian

————
Billing & subscription: {account_url}
```

**Required merge fields:** `first_name`, `amount`, `update_payment_url`, `pause_date` (e.g. "December 14"), `account_url`

---

## 5 · role-lost

**Template ID:** `role-lost`
**Triggered by:** Daily role-check cron Cases B (Premium lost) or C (Elite lost)
**Note:** Same template handles both tiers — body adapts via the `{tier}` merge field and conditional blocks. If your template system doesn't support conditionals, split into `role-lost-premium` and `role-lost-elite` and use the appropriate body below.

### Variant A — Premium lost role

**Subject:** `Heads-up — your Trading Ark role isn't showing up`
**Preheader:** `Your Premium discount ends next renewal. Here's how to fix it.`

```
Hey {first_name},

Our daily Discord check didn't find your Trading Ark Premium role
today, so a heads-up:

Starting {next_billing_date}, your Rewind subscription switches
from Pro · Premium ($9/mo) to Pro · Direct ($19/mo). You keep
all your Pro features — you just lose the 50% Discord discount
and Trading Ark community access.

Three ways to fix it:

  1. Did you cancel Whop? Re-subscribe at the same plan:
     → {whop_premium_url}

  2. Still subscribed but role missing? Ping Whop support — this
     is usually a Discord-sync issue and they can fix it fast.

  3. Want to switch to a paid Rewind plan instead?
     → {plans_url}

Nothing changes today — you have until {next_billing_date} to sort
it out.

— Christian

————
Manage subscription: {account_url}
```

### Variant B — Elite lost role

**Subject:** `Heads-up — your Elite role isn't showing up`
**Preheader:** `Your Pro features pause in 14 days unless you restore the role.`

```
Hey {first_name},

Our daily Discord check didn't find your Trading Ark Elite role
today.

What this means: you've got a 14-day grace period. If you don't
get your Elite role back by {grace_end_date}, your Rewind Pro
features will pause (your trades and data stay safe).

How to fix it:

  1. Did you cancel Whop? Re-subscribe at Elite:
     → {whop_elite_url}

  2. Downgraded to Premium on Whop? We can switch you to Pro · Premium
     ($9/mo) instead — just reply to this email and I'll set it up.

  3. Still subscribed but role missing? Ping Whop support.

Nothing changes today. You have until {grace_end_date}.

— Christian

————
Manage subscription: {account_url}
```

**Required merge fields:** `first_name`, `next_billing_date` (Premium only), `grace_end_date` (Elite only), `whop_premium_url`, `whop_elite_url`, `plans_url`, `account_url`

---

## 6 · role-upgraded

**Template ID:** `role-upgraded`
**Triggered by:** Daily role-check cron Case D (Premium → Elite)
**Subject:** `You upgraded to Elite — Rewind is free for you now`
**Preheader:** `Your Stripe sub is cancelled with a prorated refund. No more $9/mo.`

```
Hey {first_name},

We just spotted your new Trading Ark Elite role on Discord. Nice.

What's changing automatically:

  · Your $9/mo Stripe subscription is being cancelled today
  · You'll get a prorated refund for the unused portion of this
    month — usually shows up within 5–10 business days
  · Rewind Pro stays active, completely free, paid by Whop via
    your Elite membership

Nothing to do on your end. Enjoy.

— Christian

————
Account: {account_url}
```

**Required merge fields:** `first_name`, `account_url`

---

## Setup notes for the implementer

1. **Reply-to handling.** Set the reply-to on every email to `hello@traderewindjournal.com`. Resend supports per-message reply-to in their API.

2. **Log every send.** Insert a row in `email_log` (per the migration) before calling Resend, then update with the `resend_id` and `sent_at` after a successful response. This unblocks "did the user actually get the email?" debugging.

3. **Idempotency.** Same email shouldn't fire twice for the same trigger. Before sending, check `email_log` for `(user_id, template_id, related_event_id)` in the last 24 hours.

4. **Plain-text body.** Always send both `html` and `text` versions to Resend. The text version is what's in this doc — the HTML version uses the visual mockups as design reference.

5. **Unsubscribe headers.** Add `List-Unsubscribe` headers per RFC 8058, even though these are transactional. Required by Gmail/Yahoo for senders over ~5K emails/day, harmless to add now. Resend handles this automatically if you mark emails as "transactional" — verify the setting.

6. **From-name conditional.** For role-lost / role-upgraded / payment-failed emails specifically, consider using a slightly different from-name like `Christian (Rewind support)` to signal it's account-related not promotional. Optional.

7. **Test before launch.** Send each of the 6 templates to yourself in test mode. Check: subject lands properly, links work, no broken merge fields, doesn't go to spam, looks right on iOS/Gmail/Outlook mobile.
