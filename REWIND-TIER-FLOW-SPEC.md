# Rewind · Tier-Switching & Signup Flow Spec
**Version 1.0 (FINAL · all decisions locked) · May 10, 2026**

This document is the single source of truth for how a user moves between the 4 tiers (Free, Direct, Premium, Elite). It resolves the order-of-operations ambiguity between Stripe, Whop, and Discord and is intended to be handed directly to Claude Code (or any implementer).

If anything in this doc contradicts the existing mockups, the mockups are authoritative on visuals; this doc is authoritative on logic, state, and sequencing.

**Status:** all 5 open decisions resolved by Christian on May 10, 2026 — see §15. No remaining ambiguity. Ready to implement.

---

## 1 · Quick reference: the 4 tiers

| Tier | Rewind charge | Whop charge | Verifies via | Pro features |
|---|---|---|---|---|
| Free | $0 | — | — | Limited |
| Pro · Direct | $19/mo Stripe | — | Stripe webhook | Full (no Trading Ark) |
| Pro · Premium | $9/mo Stripe | $50/mo Whop | Discord role + Stripe webhook | Full + Trading Ark |
| Pro · Elite | $0 | $100/mo Whop | Discord role only | Full + Trading Ark |

**Key insight:** the *Whop subscription is entirely outside our system*. We never see it directly. Our only signal that someone has a paid Trading Ark community membership is **whether they hold the right role in our Discord server**. The role is the truth.

---

## 2 · Core design decision: Discord-first for Premium and Elite

For Premium and Elite, **Discord OAuth is the qualifying step, not Stripe**. The user must prove they hold the Trading Ark role *before* we let them pay the discounted rate or activate the free Elite plan.

Why:
1. If we let users pay $9 first then try to verify, anyone could lie and we'd have to refund.
2. The existing mockups (`rewind-oauth-loading`, `-premium`, `-elite`, `-noaccess`) already imply this — Discord OAuth is where eligibility is checked.
3. It pushes the "Buy Trading Ark on Whop" moment to a clean off-ramp (`rewind-oauth-noaccess` with 3 paths) instead of mid-checkout.

For Pro · Direct: Stripe-only. No Discord required. Linking Discord later doesn't change anything unless the user wants to claim a discount.

---

## 3 · Pricing page CTAs (locked behavior)

On `rewind-web-pricing.png`, each tier card has one CTA:

| Tier card | CTA label | What it does |
|---|---|---|
| Free | `Sign up free` | → `/signup` → account creation → dashboard |
| Pro · Direct | `Get Pro · Direct` | → start **Direct flow** (§5) |
| Pro · Premium | `Get Pro · Premium` | → start **Premium flow** (§6) |
| Pro · Elite | `Get Pro · Elite` | → start **Elite flow** (§7) |

If the user is already on Pro, the CTAs of *higher* tiers say "Upgrade to X" and *lower* tiers say "Switch to X" or are disabled. (We'll spec the upgrade/downgrade flows in §10.)

---

## 4 · State model

Database fields (already in the planned migration):

```
users.is_pro             boolean
users.pro_source         text  -- NULL | 'stripe_direct' | 'discord_premium' | 'discord_elite'
users.pro_active_until   timestamptz  -- when their Pro access expires (paid through date)
users.stripe_customer_id text
users.stripe_subscription_id text
users.discord_user_id    text
users.discord_access_token text  -- encrypted
users.discord_refresh_token text -- encrypted
users.discord_token_expires timestamptz
users.last_role_check    timestamptz
```

**Derived state — `is_pro_active(user)` server function:**
```
is_pro_active = users.is_pro AND users.pro_active_until > now()
```

Every paid-feature gate calls this function. Never trust `is_pro` alone — always check `pro_active_until` too.

---

## 5 · Pro · Direct flow (Stripe-only)

```
[Pricing] → "Get Pro · Direct"
   ↓
[Stripe redirect loading]   (rewind-loading-stripe-redirect.png · ~1s)
   ↓
[Stripe Checkout]   (Stripe-hosted, plan: prod_direct $19/mo)
   ↓
   ├── User completes payment
   │      ↓
   │   Stripe redirects to /checkout/success?session_id=xxx
   │      ↓
   │   [Stripe processing loading]   (rewind-loading-stripe-processing.png)
   │      ↓
   │   (server waits for `checkout.session.completed` webhook,
   │    then updates DB; client polls /api/me until is_pro=true)
   │      ↓
   │   [Welcome · Direct]   (rewind-welcome-direct.png)
   │      ↓
   │   → /dashboard
   │
   └── User clicks "Back" on Stripe checkout
          ↓
       Stripe redirects to /checkout/cancelled
          ↓
       [Checkout cancelled]   (rewind-stripe-cancelled.png)
          ↓
       User clicks "See plans again" → /pricing
                       or "Back to dashboard" → /dashboard
```

**Webhook handler (`checkout.session.completed`) — Direct:**
```
ON `checkout.session.completed` where metadata.plan='direct':
  users.is_pro             = TRUE
  users.pro_source         = 'stripe_direct'
  users.pro_active_until   = subscription.current_period_end
  users.stripe_customer_id = customer.id
  users.stripe_subscription_id = subscription.id
  // Send welcome email (rewind-email-welcome-direct)
```

**Webhook handler (`invoice.paid`) — Direct renewal:**
```
ON `invoice.paid` for subscription with metadata.plan='direct':
  users.pro_active_until = subscription.current_period_end  // extend
```

---

## 6 · Pro · Premium flow (Discord OAuth → Stripe)

```
[Pricing] → "Get Pro · Premium"
   ↓
[Discord redirect loading]   (rewind-loading-discord-redirect.png · ~1s)
   ↓
[Discord OAuth]   (Discord-hosted authorize screen)
  Scopes: identify, guilds.members.read
   ↓
   ├── User clicks "Authorize"
   │      ↓
   │   Discord redirects to /oauth/discord/callback?code=xxx
   │      ↓
   │   [Checking Trading Ark]   (rewind-oauth-loading.png · 2-3s)
   │      ↓
   │   Server flow:
   │     1. Exchange code → access_token, refresh_token
   │     2. Fetch user identity (discord_user_id, username)
   │     3. Fetch user's roles in the Trading Ark guild
   │        (GET /users/@me/guilds/{TRADING_ARK_GUILD_ID}/member
   │         using the user's access_token)
   │     4. Inspect roles array:
   │          ELITE_ROLE_ID present  → branch: ELITE
   │          PREMIUM_ROLE_ID present (no Elite) → branch: PREMIUM
   │          neither → branch: NO_ROLE
   │     5. Save discord_user_id, discord_tokens, last_role_check=now to user row
   │
   │      ↓
   │   ┌─────────────────┬─────────────────┬─────────────────┐
   │   ▼                 ▼                 ▼
   │ ELITE branch     PREMIUM branch    NO_ROLE branch
   │ (see §7)         (continues below) (see §8)
   │
   │   PREMIUM branch:
   │      ↓
   │   [You're in. 50% off.]   (rewind-oauth-premium.png)
   │      ↓
   │   User clicks "Continue to checkout"
   │      ↓
   │   [Stripe redirect loading]   (rewind-loading-stripe-redirect.png)
   │      ↓
   │   [Stripe Checkout]   (plan: prod_premium $9/mo)
   │      ↓
   │   On success: webhook + redirect to /welcome/premium
   │      ↓
   │   [Stripe processing] → [Welcome · Premium]   (rewind-welcome-premium.png)
   │      ↓
   │   → /dashboard
   │
   └── User clicks "Deny" on Discord
          ↓
       Discord redirects with ?error=access_denied
          ↓
       [Back to /pricing with toast: "Discord linking is required for Premium"]
```

**Webhook handler (`checkout.session.completed`) — Premium:**
```
ON `checkout.session.completed` where metadata.plan='premium':
  // discord_user_id is already populated from OAuth step
  users.is_pro             = TRUE
  users.pro_source         = 'discord_premium'
  users.pro_active_until   = subscription.current_period_end
  users.stripe_customer_id = customer.id
  users.stripe_subscription_id = subscription.id
  // Send welcome email (rewind-email-welcome-premium)
```

---

## 7 · Pro · Elite flow (Discord OAuth only, no Stripe)

Triggered either by:
- Clicking "Get Pro · Elite" on pricing → Discord redirect → ELITE branch
- OR from within the Premium flow, if Discord OAuth detects an Elite role (we route them here automatically — they shouldn't pay $9 if they qualify for free)

```
ELITE branch (continuing from §6 step 4):
   ↓
[You're Elite. It's free.]   (rewind-oauth-elite.png)
   ↓
User clicks "Activate Elite"
   ↓
Server flow:
  users.is_pro             = TRUE
  users.pro_source         = 'discord_elite'
  users.pro_active_until   = now() + 35 days  // see "grace logic" below
  // NO stripe_customer_id, NO stripe_subscription_id — Elite has no Stripe sub
  // Send welcome email (rewind-email-welcome-elite)
   ↓
[Welcome · Elite]   (rewind-welcome-elite.png)
   ↓
→ /dashboard
```

**Why `pro_active_until = now() + 35 days`?**
Elite has no Stripe subscription to define a period-end. We give them a 35-day rolling window that the daily role-check cron **extends** every time it confirms they still hold the Elite role. If the cron stops extending (because they lost the role), the 35 days runs out and they auto-revert to free. This gives us a 14-day grace period inside the window (see §9).

---

## 8 · NO_ROLE branch (Discord linked but no Trading Ark role)

```
NO_ROLE branch (continuing from §6 step 4):
   ↓
[Hmm, not in there.]   (rewind-oauth-noaccess.png — 3 paths)
   ↓
   Path A: "Get Trading Ark ($50 on Whop)"
      ↓
   Opens new tab: https://whop.com/checkout/plan_tRNqykRyLXsKv?a=christianvaleo
      ↓
   User completes Whop checkout, gets invited to Discord, joins server, gets Premium role.
      ↓
   Returns to Rewind tab → clicks "I've joined, check again"
      ↓
   Re-run role check (§6 step 4) — should now land in PREMIUM branch
   
   Path B: "Get Trading Ark Elite ($100 on Whop)"
      ↓
   Opens new tab: https://whop.com/checkout/plan_KY7CY81vHFic1?a=christianvaleo
      ↓
   Same as Path A but lands in ELITE branch on re-check
   
   Path C: "Just get Pro · Direct ($19)"
      ↓
   Discord stays linked (we have their tokens for later) but we route them to the Direct flow (§5)
```

**Both Whop links MUST include `?a=christianvaleo` for affiliate tracking. This is non-negotiable.**

The "I've joined, check again" button on the noaccess screen re-runs step 4 (role check) using the stored refresh token — no need to re-OAuth. Add a small cooldown (5s) to prevent Discord rate limit issues if users click rapidly.

---

## 9 · Daily role re-check cron

Runs daily at 03:00 UTC (low-traffic window). For each user where `pro_source IN ('discord_premium', 'discord_elite')`:

```
1. Refresh Discord access token if expired (use refresh_token)
2. Fetch user's roles in Trading Ark guild
3. Compare roles to expected:

   Case A — Still has correct role:
     users.last_role_check = now()
     IF pro_source = 'discord_elite':
        users.pro_active_until = now() + 35 days   // extend rolling window
     (Premium's pro_active_until is managed by Stripe webhooks, don't touch)
   
   Case B — Premium user lost Premium role (and didn't gain Elite):
     · Send email (rewind-email-role-lost — Premium variant)
     · Show in-app banner (rewind-role-lost.png)
     · DO NOT cancel their Stripe sub immediately — they're paid through current_period_end
     · At next invoice.upcoming webhook (3-day pre-renewal):
         - Detach the Premium discount/coupon from the sub
         - Switch the sub to the Direct $19 price (via Stripe API)
         - Update users.pro_source = 'stripe_direct'
         - Email: "Heads up — your Premium discount ends this period"
   
   Case C — Elite user lost Elite role (and didn't gain Premium):
     · Send email (rewind-email-role-lost — Elite variant)
     · Show in-app banner (rewind-role-lost.png)
     · Stop extending pro_active_until
     · They have ~14 days of remaining Pro access (35-day window minus elapsed time)
     · When pro_active_until expires:
         users.is_pro = FALSE
         users.pro_source = NULL
         Send email: "Your Pro features are paused. Re-join Trading Ark to get them back."
   
   Case D — Premium user gained Elite role (upgrade):
     · Send email (rewind-email-role-upgraded — to Elite variant)
     · Cancel their Stripe subscription immediately (with proration credit)
     · users.pro_source = 'discord_elite'
     · users.pro_active_until = now() + 35 days
     · Stripe sub cleanup will refund the unused portion of their last month
   
   Case E — Elite user lost Elite but still has Premium:
     · Email: "You're now on Pro · Premium — let's set up billing"
     · Start a Stripe checkout in the background OR redirect them on next login
     · 7-day grace before Pro features pause if they don't complete checkout
     · DO NOT auto-charge them — they need to enter a card

   Case F — Discord token expired and refresh failed:
     · Send email: "Re-link your Discord to keep your Pro · {tier}"
     · 7-day grace period
     · After grace: same as Case B/C
```

Rate limit awareness: Discord allows ~50 requests/sec global. With <10k users initially, batching 100 users per second is fine. Use exponential backoff on 429.

---

## 10 · Tier transitions from inside the app

Once a user is logged in and on a tier, the **Account & Billing** page is the entry point for all transitions. (Cancellation modal in §11.)

| From → To | Path |
|---|---|
| Free → Direct | Account · "Upgrade to Pro" button → §5 |
| Free → Premium | Account · "Upgrade to Pro" → pricing → §6 |
| Free → Elite | Account · "Upgrade to Pro" → pricing → §7 |
| Direct → Premium | Account · "Link Discord" — if Premium role found, offer to switch (prorated Stripe sub update from $19 → $9) |
| Direct → Elite | Account · "Link Discord" — if Elite role found, offer to cancel Stripe sub (refund prorated) and switch to Elite |
| Premium → Elite | Auto via daily cron (Case D §9) when role upgraded on Whop |
| Premium → Direct | Auto via cancellation modal §11 (or daily cron Case B if Whop role lost) |
| Elite → Premium | Auto via daily cron (Case E §9) when Whop role downgraded |
| Elite → Direct | Manual: user unlinks Discord → after grace, sub paused → user must start a Direct sub themselves |
| Any Pro → Free | Cancellation modal §11 |

---

## 11 · Cancellation flow (existing 3-step screens)

Entry point: Account · "Cancel" button → opens `rewind-modal-cancel-sub.png` (already designed).

If user clicks "Continue to cancel":
- → `rewind-cancel-step1.png` — reason capture (radio: too expensive / not using / found alternative / other)
- → `rewind-cancel-step2.png` — save offer based on reason:
   - "Too expensive" → offer 50% off next 3 months (apply coupon to Stripe sub)
   - "Not using" → offer 30-day pause (skip a billing cycle)
   - "Found alternative" → ask what they switched to, no offer
   - "Other" → free-text follow-up, no offer
- → `rewind-cancel-step3.png` — graceful goodbye, confirm cancel

Backend on confirm:
```
Direct: cancel Stripe sub at_period_end=true. Keep is_pro=true until period_end.
Premium: cancel Stripe sub at_period_end=true. Discord stays linked. Same as above.
Elite: just set pro_source=NULL, is_pro=false on pro_active_until expiry.
       Their Whop sub continues unless they cancel that themselves.
```

Log to `cancellation_reasons` table per the schema in the brief.

---

## 12 · Edge cases worth implementing day 1

1. **User has both Premium AND Elite roles** — Elite wins. Treat as Elite tier. This shouldn't happen if Whop is set up correctly, but defend against it.

2. **Stripe webhook arrives before the user returns to /checkout/success** — UI is polling /api/me; webhook updates DB; UI flips when poll sees `is_pro=true`. Handle race condition by showing the loading state until poll succeeds, max 30s before showing "still processing, you'll get an email" fallback.

3. **Stripe webhook fails to fire entirely** — daily reconciliation cron: for each user with `stripe_subscription_id` and `pro_active_until < now() + 1 day`, query Stripe API directly to re-sync the subscription state.

4. **User pays Stripe successfully but Discord refresh later fails** — they're still paid, but their role check might fail. Don't touch their Pro status; just email them to re-link. Use the existing `rewind-email-role-lost` template re-purposed.

5. **User cancels Whop while on Pro · Premium and Stripe charges them next** — they paid $9 expecting Trading Ark access. We caught the role loss in daily cron and emailed them. If they complain, refund the $9 charge (it's a small amount and protects goodwill).

6. **User signs up for Direct, then later wants Premium** — from Account page, "Link Discord". If Premium role detected, offer to switch billing. Use Stripe subscription update API to swap price IDs with proration enabled.

7. **Refunds within 7-day window (per refund policy)** — manual ops via Stripe dashboard for now. Don't build self-serve refund UI for v1.

---

## 13 · Discord App configuration checklist

- [ ] Create Discord application at `discord.com/developers/applications`
- [ ] Note `CLIENT_ID` and `CLIENT_SECRET` → Vercel env vars
- [ ] Add OAuth2 redirect URI: `https://traderewindjournal.com/oauth/discord/callback`
- [ ] Enable OAuth2 scopes: `identify`, `guilds.members.read`
- [ ] Create a Bot user, invite it to the Trading Ark Discord server with permission "View Server" only (no admin)
- [ ] Note the Trading Ark **Guild ID** → env var `TRADING_ARK_GUILD_ID`
- [ ] Note the **Premium role ID** → env var `TRADING_ARK_PREMIUM_ROLE_ID`
- [ ] Note the **Elite role ID** → env var `TRADING_ARK_ELITE_ROLE_ID`
- [ ] Encrypt tokens at rest (e.g. AES-256 with a key in Vercel env)

---

## 14 · Stripe configuration checklist

- [ ] Create product **Rewind Pro · Direct** with price `$19.00 USD` recurring monthly
- [ ] Note `price_direct_id` → env var
- [ ] Create product **Rewind Pro · Premium** with price `$9.00 USD` recurring monthly
- [ ] Note `price_premium_id` → env var
- [ ] In product metadata, set `plan: 'direct'` or `plan: 'premium'` (used by webhook routing)
- [ ] Enable Customer Portal (Stripe-hosted) for self-serve billing management
- [ ] Configure webhook endpoint: `https://traderewindjournal.com/api/stripe/webhook`
   - Events: `checkout.session.completed`, `invoice.paid`, `invoice.payment_failed`, `customer.subscription.updated`, `customer.subscription.deleted`
- [ ] Note webhook signing secret → env var `STRIPE_WEBHOOK_SECRET`
- [ ] Set tax behavior: "Automatic tax" with Stripe Tax (recommended) OR mark prices as "Tax inclusive" and skip
- [ ] Test in test mode first; flip to live mode only after end-to-end test passes for all 3 paid tiers

---

## 15 · Decisions (LOCKED)

All five open questions have been resolved by Christian on May 10, 2026. These are now requirements, not options.

1. **Free trial on Pro · Direct: NO.**
   - No `trial_period_days` on Stripe subscription creation.
   - Card is charged immediately on signup.
   - The 7-day money-back guarantee (refund policy) provides equivalent user safety.
   - Applies to all tiers: no trial on Direct, no trial on Premium, no trial on Elite.

2. **Email from-address: `Christian from Rewind <hello@traderewindjournal.com>`.**
   - All transactional emails use this sender (welcome, receipt, payment failed, role lost, role upgraded).
   - `hello@traderewindjournal.com` is a forwarding alias — set it up in your email provider (Google Workspace / Fastmail / etc.) to forward to your real inbox.
   - Replies are welcome; consider routing them to a shared inbox or Front/Missive when you scale beyond ~50 emails/day.
   - Resend (the planned email provider) supports custom from-names natively.

3. **Stripe Tax: ON.**
   - Enable in Stripe dashboard before going live.
   - Handles US sales tax + EU VAT automatically.
   - Prices stay as labeled ($19, $9) and tax is added at checkout based on customer location.

4. **Cancellation save offers: HARD-CODED, no A/B test for v1.**
   - "Too expensive" → 50% off next 3 months (Stripe coupon)
   - "Not using" → 30-day pause (skip a billing cycle via Stripe pause API)
   - "Found alternative" → no offer, capture free-text feedback
   - "Other" → no offer, capture free-text feedback
   - Still instrument the `cancellation_reasons.prevented_by_offer` boolean for future analysis.
   - Revisit after 30 days of cancellation data to decide whether to A/B test.

5. **Whop refunds: WHOP-OWNED.**
   - Rewind only refunds the Stripe portion of any subscription ($9 for Premium, $19 for Direct).
   - The Whop portions ($50 for Trading Ark, $100 for Trading Ark Elite) must be requested by the user directly from Whop.
   - Already documented in `refund.html` §04 and §05.
   - Support/refund email auto-responder should include this clarification.

---

## Appendix A · Email triggers map

| Trigger event | Template | Audience |
|---|---|---|
| `checkout.session.completed` plan=direct | rewind-email-welcome-direct | New Direct |
| `checkout.session.completed` plan=premium | rewind-email-welcome-premium | New Premium |
| Elite activation (no Stripe) | rewind-email-welcome-elite | New Elite |
| `invoice.payment_failed` | rewind-email-payment-failed | Any paid tier |
| Cron Case B/C | rewind-email-role-lost (variant by tier) | Premium or Elite |
| Cron Case D | rewind-email-role-upgraded | Premium → Elite |

## Appendix B · Routes summary

| Route | Purpose |
|---|---|
| `/pricing` | Pricing page (rewind-web-pricing) |
| `/checkout/direct` | Server route — creates Stripe Checkout session for Direct, 302 to Stripe |
| `/checkout/premium` | Server route — creates Stripe Checkout session for Premium, 302 to Stripe |
| `/checkout/success` | Post-Stripe return; shows loading-stripe-processing then redirects |
| `/checkout/cancelled` | Post-Stripe back-button; shows stripe-cancelled |
| `/oauth/discord/start` | Server route — 302 to Discord authorize URL with state |
| `/oauth/discord/callback` | Server route — exchanges code, runs role check, routes by branch |
| `/welcome/:tier` | Welcome screens (direct/premium/elite) |
| `/account` | Account & billing |
| `/api/stripe/webhook` | Stripe webhook handler |
| `/api/me` | Returns current user state (used by client polling) |

---

**End of spec.** Anything not covered here should default to the conservative choice (don't auto-bill, don't auto-cancel, do email the user, do log to an audit table).
