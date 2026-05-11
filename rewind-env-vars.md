# Rewind · Vercel Environment Variables Checklist

Set every variable below in **Vercel → Project → Settings → Environment Variables**. Mark each as Production, Preview, and Development unless otherwise noted. Anything labeled `(server only)` should NOT have the `NEXT_PUBLIC_` prefix and must never be sent to the client.

**Total: 24 vars across 6 categories.**

---

## ☐ Site (3)

| Var | Value | Where to find |
|---|---|---|
| `NEXT_PUBLIC_SITE_URL` | `https://traderewindjournal.com` | hardcode |
| `CRON_SECRET` | Random 32-byte hex | Generate: `openssl rand -hex 32` |
| `ENCRYPTION_KEY` | Random 32-byte hex (AES-256 for Discord tokens) | Generate: `openssl rand -hex 32` · **save this in 1Password — losing it bricks every linked Discord** |

---

## ☐ Supabase (3)

| Var | Value | Where to find |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `https://<project>.supabase.co` | Supabase → Project Settings → API → Project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | eyJ… | Supabase → Project Settings → API → Project API keys → `anon` `public` |
| `SUPABASE_SERVICE_ROLE_KEY` *(server only)* | eyJ… | Same page → `service_role` `secret` · **never expose to client** |

---

## ☐ Stripe (6)

Set up both **test mode** and **live mode** values. Use test mode keys in Preview/Development environments, live in Production.

| Var | Value | Where to find |
|---|---|---|
| `STRIPE_SECRET_KEY` *(server only)* | `sk_test_…` or `sk_live_…` | Stripe → Developers → API keys → Secret key |
| `STRIPE_WEBHOOK_SECRET` *(server only)* | `whsec_…` | Stripe → Developers → Webhooks → click your endpoint → Signing secret · **different per environment** |
| `STRIPE_PRICE_DIRECT_ID` | `price_…` | Stripe → Products → Rewind Pro · Direct → Pricing → API ID |
| `STRIPE_PRICE_PREMIUM_ID` | `price_…` | Stripe → Products → Rewind Pro · Premium → Pricing → API ID |
| `STRIPE_COUPON_50_OFF_3MO` | `coupon_…` | Stripe → Products → Coupons → "50% off · 3 months" (create this) |
| `STRIPE_COUPON_PAUSE_30D` | `coupon_…` (optional) | Stripe → Coupons → "Pause 30 days" or use Stripe sub-pause API instead |

**Stripe products to create before launch:**
- Product: **Rewind Pro · Direct** · Recurring · $19.00 USD / month · metadata: `plan=direct`
- Product: **Rewind Pro · Premium** · Recurring · $9.00 USD / month · metadata: `plan=premium`
- Coupon: **50% off · 3 months** · % off, duration: 3 months · ID: `save_50_3mo` (or auto)

---

## ☐ Discord (6)

Create your Discord app at `discord.com/developers/applications` → "New Application" → name it `Rewind`.

| Var | Value | Where to find |
|---|---|---|
| `DISCORD_CLIENT_ID` | numeric ID | Discord App → OAuth2 → Client ID |
| `DISCORD_CLIENT_SECRET` *(server only)* | random string | Discord App → OAuth2 → Client Secret |
| `DISCORD_BOT_TOKEN` *(server only)* | `MT…` | Discord App → Bot → Reset Token (then "Yes, do it!") · **for the daily cron — uses bot creds, not user creds** |
| `TRADING_ARK_GUILD_ID` | numeric ID | Right-click the Trading Ark server icon in Discord (with Developer Mode on) → Copy Server ID |
| `TRADING_ARK_PREMIUM_ROLE_ID` | numeric ID | Trading Ark server → Server Settings → Roles → right-click the Premium role → Copy Role ID |
| `TRADING_ARK_ELITE_ROLE_ID` | numeric ID | Same as above but for the Elite role |

**Discord app config:**
- OAuth2 redirect URI: `https://traderewindjournal.com/oauth/discord/callback` (add `http://localhost:3000/oauth/discord/callback` for local dev)
- OAuth2 scopes used at runtime: `identify`, `guilds.members.read`
- Bot must be invited to Trading Ark with: `View Channels` only (no admin)
- Bot invite URL: `https://discord.com/api/oauth2/authorize?client_id=YOUR_CLIENT_ID&permissions=1024&scope=bot`

---

## ☐ Resend (3)

Sign up at `resend.com` → verify your domain (`traderewindjournal.com`) → add SPF, DKIM, DMARC DNS records they give you.

| Var | Value | Where to find |
|---|---|---|
| `RESEND_API_KEY` *(server only)* | `re_…` | Resend → API Keys → Create API Key (full access, server) |
| `EMAIL_FROM_NAME` | `Christian from Rewind` | hardcode |
| `EMAIL_FROM_ADDRESS` | `hello@traderewindjournal.com` | hardcode (set up `hello@` as a forwarding alias to your real inbox) |

**DNS records to add at your domain registrar** (Resend will show you the exact values):
- `TXT` record on root for SPF: `v=spf1 include:amazonses.com ~all` (or what Resend specifies)
- `CNAME` records for DKIM (3 records, Resend-specific)
- `TXT` record on `_dmarc.traderewindjournal.com` for DMARC: `v=DMARC1; p=none; rua=mailto:dmarc@traderewindjournal.com`

After DNS propagates (5 min – 24 hr), verify in Resend dashboard. Don't send emails until verification shows green.

---

## ☐ Whop (2 — optional, can hardcode in app)

| Var | Value | Where to find |
|---|---|---|
| `NEXT_PUBLIC_WHOP_PREMIUM_URL` | `https://whop.com/checkout/plan_tRNqykRyLXsKv?a=christianvaleo` | Your locked affiliate URL · **MUST include `?a=christianvaleo`** |
| `NEXT_PUBLIC_WHOP_ELITE_URL` | `https://whop.com/checkout/plan_KY7CY81vHFic1?a=christianvaleo` | Your locked affiliate URL · **MUST include `?a=christianvaleo`** |

You can also just hardcode these in your app constants — they don't change often. Env vars only matter if you want to swap them per environment.

---

## ☐ Pre-launch verification

Before flipping any of these to live values:

- [ ] Run `rewind-migration.sql` in Supabase SQL editor → no errors
- [ ] Stripe test mode: complete one full Direct checkout end-to-end → webhook fires → user shows `is_pro=true`
- [ ] Stripe test mode: cancel from /account → user shows correctly transitioning to free at period end
- [ ] Discord: link Discord on a test account → role check returns expected branch
- [ ] Resend: send yourself a test welcome email → arrives in inbox (not spam)
- [ ] Cron: manually trigger the daily role check → completes without errors

Once all 6 boxes are checked, swap test keys for live keys in Production env only, leave Preview/Development on test keys.

---

## ☐ What NOT to put in env vars

Don't add these — they're metadata, not secrets:

- Stripe product/price metadata (e.g. `plan=direct`) — set in Stripe dashboard, read via API
- Email template HTML — store in code, not env
- User-visible copy strings — store in code
- Database table names — read from migrations
