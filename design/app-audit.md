# Rewind Trading Journal — Full Application Audit

> Generated: 2026-06-13  
> Purpose: Single source of truth for a full rebuild. Every table, route, function, gate, and flow documented from source.

---

## 1. Codebase Overview

### Directory Structure

```
rewind/
├── api/                         # Vercel serverless functions
│   ├── _lib/                    # Shared server-side utilities (not exposed as routes)
│   │   ├── auth.js              # authUser(), isProUser(), requirePro()
│   │   ├── community.js         # All community aggregation logic
│   │   ├── crypto.js            # HMAC state, AES-256-GCM token encryption, cookie helpers
│   │   ├── discord.js           # Discord API helpers
│   │   ├── insight-templates.js # Deterministic insight rendering
│   │   ├── rule-templates.js    # DEFAULT_RULES seed data
│   │   ├── stripe.js            # Stripe client factory
│   │   ├── supabase.js          # sbService() / sbAnon() factory
│   │   └── trade-analytics.js   # buildTraderAnalytics()
│   ├── ark/                     # Ark AI coaching (coaching.js, debrief.js, trade-read.js)
│   ├── billing/                 # apply-coupon.js, cancel.js, pause.js, portal.js
│   ├── checkout/                # direct.js, premium.js (retired 410)
│   ├── community/               # best-session, group-stats, list, most-used-confluence,
│   │                            #   pulse, setup-combinations, top-performers, trader-of-the-day
│   ├── cron/                    # daily-role-check.js, email-worker.js
│   ├── eod/                     # render-card.js (share card PNG)
│   ├── insights/                # generate.js
│   ├── oauth/discord/           # start.js, callback.js
│   ├── personal/                # behavior-breakdown.js, overview.js
│   ├── rules/                   # [id].js, index.js, review.js, seed-defaults.js, today.js,
│   │                            #   weekly-scorecard.js
│   ├── broker-sync-waitlist.js
│   ├── me.js
│   └── stripe/webhook.js
├── design/                      # Mockups and docs
│   └── mocks/                   # calendar.html, community.html, dashboard.html,
│                                #   history.html, review.html, settings.html, theme-preview.html
├── js/
│   ├── arkEngine.js             # Client-side Ark Engine (deterministic, no AI)
│   └── tradingDay.js            # ET timezone / session / trading day utilities
├── lib/
│   └── community.js             # joinTradingArk() helper (shared by webhook + oauth + cron)
├── migrations/
│   └── add-trading-day.sql
├── welcome/                     # direct.html, elite.html, premium.html
├── index-6_22.html              # Single-page application (the entire client-side app)
├── vercel.json                  # Routing rewrites + cron schedule
├── package.json
└── *.sql                        # Migration files (see §2)
```

### Tech Stack

| Layer | Technology |
|---|---|
| Hosting / Serverless | Vercel (Node >= 20, Edge runtime for webhook + email-worker) |
| Frontend | Vanilla JS SPA, single HTML file (`index-6_22.html`) |
| Auth / DB | Supabase (PostgreSQL + Auth + Storage) |
| Payments | Stripe (subscriptions, webhooks, billing portal) |
| Discord | OAuth2 via Discord REST API (no bot token) |
| Canvas / Share Cards | `@napi-rs/canvas` v1 (Skia-backed, server-side) |
| Email | Resend SDK |
| Font Hosting | Local TTFs under `api/eod/fonts/` (Instrument Serif Italic/Regular, Geist, GeistMono) |

### Key Dependencies (`package.json`)

```json
{
  "@napi-rs/canvas": "^1.0.0",
  "@supabase/supabase-js": "^2.49.0",
  "resend": "^6.12.3",
  "stripe": "^17.5.0"
}
```

Supabase JS is also loaded on the client from CDN:  
`https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2`

### Environment Variables Required

| Variable | Used By |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | All routes, client SPA |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Client SPA, `sbAnon()` factory |
| `SUPABASE_SERVICE_ROLE_KEY` | All server routes via `sbService()` |
| `STRIPE_SECRET_KEY` | Checkout, billing, webhook |
| `STRIPE_WEBHOOK_SECRET` | `api/stripe/webhook.js` |
| `STRIPE_PRICE_DIRECT_ID` | `api/checkout/direct.js` |
| `STRIPE_COUPON_50_OFF_3MO` | `api/billing/apply-coupon.js` |
| `DISCORD_CLIENT_ID` | OAuth start + callback |
| `DISCORD_CLIENT_SECRET` | OAuth callback |
| `TRADING_ARK_GUILD_ID` | OAuth callback, daily cron |
| `TRADING_ARK_PREMIUM_ROLE_ID` | OAuth callback, daily cron |
| `TRADING_ARK_ELITE_ROLE_ID` | OAuth callback (retired, optional) |
| `TRADING_ARK_COMMUNITY_ID` | `lib/community.js` joinTradingArk() |
| `ENCRYPTION_KEY` | AES-256 token encryption (64 hex chars = 32 bytes) |
| `NEXT_PUBLIC_SITE_URL` | OAuth redirects, email links |
| `CRON_SECRET` | Auth for `/api/cron/*` endpoints |
| `RESEND_API_KEY` | `api/cron/email-worker.js` |
| `EMAIL_FROM_NAME` | Email worker |
| `EMAIL_FROM_ADDRESS` | Email worker |
| `ANTHROPIC_API_KEY` | `api/ark/coaching.js`, `api/ark/debrief.js`, `api/ark/trade-read.js` |
| `NEXT_PUBLIC_WHOP_PREMIUM_URL` | Email templates |
| `NEXT_PUBLIC_WHOP_ELITE_URL` | Email templates |

---

## 2. Supabase Schema

**Project URL:** `https://efxjxmtjycldvovcbczg.supabase.co`  
**Anon key** (publishable, embedded in client): `sb_publishable_F3g-zezPLXXQ6Khe0woNhg_n1V1FORM`

### Table: `profiles`

Primary key: `id UUID` (FK -> `auth.users.id`)

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | Matches `auth.users.id` |
| `display_name` | TEXT | User's full name |
| `email` | TEXT | Copied from auth at profile creation |
| `username` | TEXT | Handle (used in community) |
| `initials` | TEXT | Legacy 2-char initials |
| `color` | TEXT | Legacy color field; mapped to finish values |
| `avatar_finish` | TEXT | One of: `chrome`, `gold`, `rosegold`, `gunmetal`, `sapphire`, `emerald`, `amethyst`, `slate` |
| `avatar_initials` | TEXT | 2-char display initials for avatar |
| `avatar_image_url` | TEXT | Custom upload URL (currently always set to null) |
| `last_seen_at` | TIMESTAMPTZ | Heartbeat on sign-in |
| `plan` | TEXT | Legacy field (`free` / `pro`) — NOT the authoritative tier |
| `is_pro` | BOOLEAN NOT NULL DEFAULT FALSE | Authoritative Pro gate |
| `pro_source` | TEXT | One of: `stripe_direct`, `discord_premium`, `discord_elite` |
| `pro_active_until` | TIMESTAMPTZ | Entitlement window; expiry means access ends |
| `stripe_customer_id` | TEXT | Stripe customer ID |
| `stripe_subscription_id` | TEXT | Active Stripe subscription ID |
| `discord_user_id` | TEXT | Discord user snowflake |
| `discord_access_token` | TEXT | AES-256-GCM encrypted |
| `discord_refresh_token` | TEXT | AES-256-GCM encrypted |
| `discord_token_expires` | TIMESTAMPTZ | Expiry of Discord access token |
| `last_role_check` | TIMESTAMPTZ | Last time daily cron ran for this user |
| `updated_at` | TIMESTAMPTZ | Set on saves |

**Indexes:** `stripe_subscription_id`, `stripe_customer_id`, `discord_user_id`, `(pro_source, last_role_check)` (where discord_premium/elite), `pro_active_until` (where is_pro=TRUE)

**RLS:** Enabled. `users_read_own_profile` — SELECT: `true` (public read). `users_update_own_profile` / `users_insert_own_profile` — auth.uid() = id.

**Database Function:** `is_pro_active(p_user_id UUID) -> BOOLEAN` — returns `is_pro AND pro_active_until > NOW()`. Server-side single source of truth.

---

### Table: `trades`

Primary key: `id TEXT` — a millisecond timestamp from the client (`String(Date.now())` or `Date.now() + Math.random()`).

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | Client-generated timestamp string |
| `user_id` | UUID | FK -> auth.users |
| `trade_data` | JSONB | The entire trade object. Keys documented below. |
| `account_type` | TEXT | `paper`, `eval`, `funded`, `live`, or NULL |
| `journal` | TEXT | Multi-journal slug (e.g. `default`) |
| `created_at` | TIMESTAMPTZ | Auto-set |
| `updated_at` | TIMESTAMPTZ | Set on upsert |
| `trading_day` | DATE | ET-adjusted date (see Date/Timezone section) |

**`trade_data` JSONB keys:**

| Key | Type | Notes |
|---|---|---|
| `id` | string | Mirror of row `id` |
| `date` | string | `YYYY-MM-DD` local date |
| `sym` | string | Symbol (e.g. `NQ1!`) |
| `market` | string | Market category |
| `type` | string | `long` or `short` |
| `qty` | number | Contracts |
| `accounts` | number | Number of prop accounts (multi-account normalization) |
| `pnl` | number | Dollar P&L |
| `points` | number | Gross price-move points |
| `rr` | number | Risk:Reward ratio |
| `stop` | number | Stop loss (Pro-gated field) |
| `session` | string | `NY AM`, `NY PM`, `London`, `Asia`, `Lunch` |
| `grade` | string | `A+`, `A`, `B`, `C`, `D`, `F` (Pro-gated) |
| `emotion` | number | 1-5 scale (Pro-gated) |
| `confidence` | number | 1-5 scale (Pro-gated) |
| `confluences` | array | `[{name, timeframe, confluence_id}]` (Pro-gated) |
| `notes` | string | Text journal notes (Pro-gated) |
| `tradingview_link` | string | TV chart link (Pro-gated) |
| `account_type` | string | Mirrors column (paper/eval/funded/live) |
| `setup` | string | Setup label |
| `model` | string | Model tag |
| `image_url` | string | Screenshot URL |

**Indexes:** `(user_id, trading_day)`, `(user_id, account_type)` (partial, where NOT NULL)

**RLS:** Enabled. SELECT: own trades OR trades of anyone sharing a community (via `communities.members[]` / `communities.owner_id`). INSERT/UPDATE/DELETE: owner only.

**Trigger:** `trg_trades_cascade_community_posts` — AFTER DELETE, removes `community_posts` rows whose `id` matches `'trade_' || OLD.id || '_%'`.

---

### Table: `communities`

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `name` | TEXT | Group name |
| `owner_id` | UUID | FK -> auth.users |
| `members` | UUID[] | Array of member user IDs (no junction table) |
| `color` | TEXT | Legacy color |
| `avatar_finish` | TEXT | One of the 8 finish values |
| `avatar_image_url` | TEXT | Custom group image |
| `icon_initials` | TEXT | 2-char group initials |
| `created_at` | TIMESTAMPTZ | |

**RLS:** Enabled. SELECT: `owner_id = auth.uid() OR auth.uid() = ANY(members)`. INSERT: `owner_id = auth.uid()`. UPDATE (owner): full access. UPDATE (invited user): via `communities_join_via_invite` policy — must have pending invite AND result has user in `members[]`. DELETE: owner.

---

### Table: `community_posts`

Primary key: `id TEXT` — encoded as `trade_<trade_id>_<8-char-community-id>` for trade posts, `checkin_<user_id>_<YYYY-MM-DD>` for check-ins.

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | Encoded ID (shape encodes post type) |
| `community_id` | UUID | FK -> communities |
| `user_id` | UUID | Post author |
| `content` | TEXT / JSONB | Post body (check-ins store `{checkin: 'trading'/'out'}`) |
| `username` | TEXT | Denormalized at write time |
| `image_url` | TEXT | Screenshot URL for trade posts |
| `metadata` | JSONB | `{grade, rr, session, market, emotion, confidence}` for trade posts |
| `created_at` | TIMESTAMPTZ | |

**RLS:** SELECT: community member. INSERT: member + `user_id = auth.uid()`. UPDATE: author. DELETE: author OR community owner.

---

### Table: `community_post_likes`

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `community_id` | UUID | |
| `post_id` | TEXT | FK -> community_posts.id |
| `user_id` | UUID | |
| `created_at` | TIMESTAMPTZ | |

**RLS:** SELECT: community member. INSERT/DELETE: own row only.

---

### Table: `community_post_replies`

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `community_id` | UUID | |
| `post_id` | TEXT | FK -> community_posts.id |
| `user_id` | UUID | |
| `content` | TEXT | |
| `created_at` | TIMESTAMPTZ | |

**RLS:** SELECT: community member. INSERT/DELETE: own row only.

---

### Table: `invites`

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `community_id` | UUID | |
| `community_name` | TEXT | Denormalized |
| `from_id` | UUID | Sender |
| `to_id` | UUID | Recipient |
| `from_username` | TEXT | Denormalized |
| `status` | TEXT | `pending`, `accepted`, `declined`, `removed`, `left` |
| `created_at` | TIMESTAMPTZ | |

**RLS:** SELECT: `from_id = auth.uid() OR to_id = auth.uid()`. INSERT: `from_id = auth.uid()`. UPDATE: `to_id = auth.uid() OR from_id = auth.uid()`. DELETE: either party.

---

### Table: `user_settings`

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `user_id` | UUID | FK -> auth.users |
| `key` | TEXT | Setting name (e.g. `display_tz`, `theme`) |
| `value` | JSONB | Setting value |
| `updated_at` | TIMESTAMPTZ | |

**Unique constraint:** `(user_id, key)` (used with `.upsert({onConflict:'user_id,key'})`)

**RLS:** All: `user_id = auth.uid()`.

---

### Table: `confluences`

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `user_id` | UUID | FK -> auth.users |
| `name` | TEXT | Confluence label (e.g. `FVG`, `Order Block`) |
| `created_at` | TIMESTAMPTZ | |
| `archived_at` | TIMESTAMPTZ | Soft-delete |

**Unique constraint:** `(user_id, name)`  
**Index:** `(user_id)` WHERE `archived_at IS NULL` (hot path for picker)  
**RLS:** All: `user_id = auth.uid()`.

---

### Table: `trade_confluences`

Many-to-many between `trades` and `confluences`.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `trade_id` | TEXT | FK -> trades.id (TEXT, not UUID) |
| `confluence_id` | UUID | FK -> confluences.id |
| `timeframe` | TEXT | Optional TF label (e.g. `1H`, `5M`) |
| `position` | INT NOT NULL DEFAULT 0 | User-defined ordering |
| `created_at` | TIMESTAMPTZ | |

**Unique index:** `(trade_id, confluence_id, COALESCE(timeframe, ''))` — allows same confluence at different TFs.  
**RLS:** All: EXISTS check through parent trade's `user_id = auth.uid()`.

---

### Table: `rules`

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `user_id` | UUID | |
| `name` | TEXT | Rule text (e.g. `1 mini per trade`) |
| `description` | TEXT | Elaboration |
| `cadence` | TEXT | `intra_day` or `weekly` |
| `condition` | JSONB | `{type: 'subjective_check'}` (all rules are now subjective) |
| `is_active` | BOOLEAN DEFAULT TRUE | |
| `is_template` | BOOLEAN DEFAULT FALSE | |
| `created_at` | TIMESTAMPTZ | |
| `updated_at` | TIMESTAMPTZ | |

---

### Table: `rule_evaluations`

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `user_id` | UUID | |
| `rule_id` | UUID | FK -> rules.id |
| `trading_day` | DATE | `YYYY-MM-DD` anchor (Friday for weekly rules) |
| `status` | TEXT | `followed` or `broken` |
| `cost_impact` | NUMERIC | Dollar cost of broken rule (optional) |
| `reviewed_at` | TIMESTAMPTZ | |
| `evaluated_at` | TIMESTAMPTZ | |

---

### Table: `cancellation_reasons`

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `user_id` | UUID | |
| `reason` | TEXT | One of: `too_expensive`, `not_using`, `missing_features`, `switching`, `exploring`, `other` |
| `reason_free_text` | TEXT | |
| `prevented_by_offer` | BOOLEAN DEFAULT FALSE | Was the churn prevented by a save offer? |
| `save_offer_type` | TEXT | `pause_30d`, `discount_50_3mo` |
| `resubscribed_at` | TIMESTAMPTZ | |
| `created_at` | TIMESTAMPTZ | |

**RLS:** INSERT: `user_id = auth.uid()`. No SELECT/UPDATE/DELETE for authenticated role (service role only).

---

### Table: `webhook_events`

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `provider` | TEXT | `stripe` |
| `event_id` | TEXT | Stripe event ID |
| `event_type` | TEXT | e.g. `checkout.session.completed` |
| `payload` | JSONB | Full event data |
| `user_id` | UUID nullable | |
| `status` | TEXT | `received`, `processed`, `failed` |
| `error_message` | TEXT | |
| `created_at` | TIMESTAMPTZ | |
| `processed_at` | TIMESTAMPTZ | |

**Unique:** `(provider, event_id)` — idempotency key.  
**RLS:** Enabled; no policies for authenticated/anon. Service role only.

---

### Table: `email_log`

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `user_id` | UUID | |
| `to_address` | TEXT | |
| `template_id` | TEXT | e.g. `welcome-direct`, `role-lost-premium`, `payment-failed` |
| `subject` | TEXT | |
| `resend_id` | TEXT | Resend message ID |
| `status` | TEXT | `queued`, `sent`, `failed`, `bounced` |
| `error_message` | TEXT | |
| `created_at` | TIMESTAMPTZ | |
| `sent_at` | TIMESTAMPTZ | |

**RLS:** SELECT for authenticated user: `user_id = auth.uid()`. No INSERT/UPDATE/DELETE from client.

---

### Table: `broker_sync_waitlist`

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `user_id` | UUID nullable | FK -> auth.users ON DELETE SET NULL |
| `email` | TEXT UNIQUE | |
| `created_at` | TIMESTAMPTZ | |

**RLS:** Enabled; no public policies. Service role writes only.

---

### Storage Buckets

| Bucket | Public | Max Size | MIME Types |
|---|---|---|---|
| `trade-images` | Yes | — | image/* |
| `avatars` | Yes | 2 MB | image/jpeg, image/png, image/webp |
| `group-avatars` | Yes | 2 MB | image/jpeg, image/png, image/webp |

Storage paths: `{user_id}/{timestamp}.jpg` for avatars. Write/update/delete requires `auth.uid()::text = (storage.foldername(name))[1]`. Group avatars require community owner.

---

## 3. Auth & Session Flow

### Client-Side Boot Sequence

1. `index-6_22.html` loads. Inline script at end of `<body>` polls until `window.supabase` is available, then calls `tryInitSupabase()`.

2. **`tryInitSupabase()`:**
   - Creates Supabase client: `_sb = supabase.createClient(SUPA_URL, SUPA_KEY)` where `SUPA_URL = 'https://efxjxmtjycldvovcbczg.supabase.co'`.
   - Wires `_sb.auth.onAuthStateChange()` listener — on `SIGNED_OUT` or `TOKEN_REFRESHED` with no session, clears `tr1_*` localStorage keys, resets globals, calls `showAuth('login')`.
   - Calls `checkSession()`.

3. **`checkSession()`:**
   - Calls `_sb.auth.getSession()`. If session exists -> `onSignedIn(session.user)`. If not -> clears `tr1_*` cache and calls `showAuth('login')`.

4. **`onSignedIn(user)`:**
   - Calls `clearUserCache()` (removes all `tr1_*` localStorage keys — never touches `sb-*-auth-token`).
   - Sets `currentUser = user`.
   - Hides auth screen, shows app.
   - Updates `profiles.last_seen_at` via Supabase.
   - Loads in sequence: `loadProfileFromDB()`, `loadTradesFromDB()`, `loadCommunityFromDB()`, `loadPendingInvitesFromDB()`, `loadUserSettings()`, `loadSentInvitesFromDB()`.
   - Calls `init()` (renders dashboard).
   - Fire-and-forget: `refreshUserTier()` -> fetches from `profiles` table -> populates `window._userTier` -> calls `applyTierGating()`, `applyFieldGates()`, `applySidebarLocks()`.

### Login / Signup

- **Email/Password Login:** `doLogin()` -> `_sb.auth.signInWithPassword({email, password})` -> on success -> `onSignedIn(r.data.user)`.
- **Signup:** Two-step. `doSignupStep1()` validates email/name. `doSignupStep2()` -> `_sb.auth.signUp({email, password, options:{data:{display_name, username}}})` -> `onSignedIn(r.data.user)`.
- Supabase session (JWT) is stored by the supabase-js library in localStorage under `sb-*-auth-token` keys. Token auto-refresh is handled by supabase-js.

### Session Persistence

- JWT stored in localStorage by supabase-js.
- SPA reads session via `_sb.auth.getSession()` (pulls from localStorage without network call).
- All API routes verify the Bearer JWT server-side via `sbAnon().auth.getUser(token)`.

### Logout

- `_sb.auth.signOut()`. Clears Supabase session; the `onAuthStateChange` listener fires `SIGNED_OUT` and resets the UI.

### Server-Side Auth Pattern (All API Routes)

```js
const header = req.headers.authorization || '';
const token = header.startsWith('Bearer ') ? header.slice(7) : null;
const { data, error } = await sbAnon().auth.getUser(token);
// user = data.user
```

`sbAnon()` creates a Supabase client with the anon key and `persistSession: false`. `getUser()` validates the JWT against Supabase Auth (network call each time — no caching server-side).

---

## 4. Tier & Plan Gating

### Tier Model

| Tier | `pro_source` | `tier` in `/api/me` | Client `_userTier.tier` | Source |
|---|---|---|---|---|
| Free | NULL | `free` | `free` | Default |
| Pro Direct | `stripe_direct` | `pro_direct` | `direct` | $19/mo Stripe |
| Pro Premium | `discord_premium` | `pro_premium` | `premium` | Free via Trading Ark Premium role |
| Pro Elite | `discord_elite` | `pro_elite` | `elite` | Retired; kept for safety |

**Authoritative server check:** `is_pro = true AND pro_source IS NOT NULL AND pro_active_until > NOW()`

### `window._userTier`

Populated async after sign-in by `refreshUserTier()` -> `getCurrentTier()`:

```js
// getCurrentTier() reads from profiles table (client-side Supabase call)
const { is_pro, pro_source, pro_active_until } = profile;
const isActive = !!(is_pro && new Date(pro_active_until).getTime() > Date.now());
const tier = { stripe_direct:'direct', discord_premium:'premium', discord_elite:'elite' }[pro_source] || 'free';
window._userTier = { tier, isActive, activeUntil };
```

### `isFreeTier()`

Returns `!window._userTier || !window._userTier.isActive`. Defaults to `true` when cache not loaded yet (safe default = free).

### Grandfather Cutoff

**`TRIAL_GRANDFATHER_CUTOFF = '2026-05-22'`**

Users who signed up **before** this date are grandfathered and never hit Calendar/History/field gates. Implemented in:
- `isGrandfathered()` — reads `currentUser.created_at`.
- `getTrialStatus()` — used by Calendar and History gates.

### 30-Day Free Trial (Calendar + History)

Free users who signed up **on or after** `2026-05-22` get 30 days of full Calendar and History access from their signup date.

**`getTrialStatus()`** returns:
```js
{
  active: boolean,        // trial is still running
  expired: boolean,       // past 30 days
  grandfathered: boolean, // pre-cutoff (no gate)
  days_remaining: number | null
}
```

Fails OPEN: paid tier -> `{active:true}`. Missing `created_at` -> `{grandfathered:true}`. Pre-cutoff -> `{grandfathered:true}`.

### Calendar Gate (`applyCalendarGate()`)

- Called from `renderCalPage()` on every calendar render.
- Expired -> adds `.cal-locked` to `#pg-calendar`, shows `#cal-paywall` overlay, hides trial banner.
- Last 3 days (days_remaining 1-3, not grandfathered) -> shows `#cal-trial-banner` with countdown. Tones: `soft` (3 days), `amber` (2 days), `urgent` (1 day).
- Active/grandfathered/paid -> normal render.

### History Gate (`applyHistoryGate()`)

- Called from `renderHistory()`. Mirrors Calendar gate exactly.
- Expired -> `.hist-locked` + `#hist-paywall`. Last 3 days -> `#hist-trial-banner`.

### Pro-Feature Field Gates (Log Trade + Edit Modal)

Gated fields for post-cutoff free users:

`PRO_GATED_FIELDS = ['tags', 'notes', 'grade', 'emotion', 'confidence', 'tv_link', 'advanced']`

**Two display modes:**
- `.field-gated` — new/empty field: blur + centered gold lock overlay + click -> `openUpgradeModal(fieldName)`.
- `.field-readonly` — existing data present: visible but locked (can read, can't edit) + microcopy strip.

**`applyFieldGates(scope, trade)`:**
- `scope = 'rw'` (Log Trade form) or `'cem'` (Edit Modal).
- Walks all `[data-gated-scope][data-gated-field]` elements.
- Grandfathered users: removes all lock chrome.
- Post-cutoff free: applies `.field-gated` or `.field-readonly` + click handler.

### Community Gate

- Sidebar nav click -> `onCommunityNavClick()` -> if `isFreeTier()` -> `openUpgradeModal('community')`, return.
- `goTo('community')` has the same guard inline.

### Analytics Gate

- `onAnalyticsTabClick(panel, el)` -> if `isFreeTier()` -> `openUpgradeModal('analytics')`.
- Free users can access: Performance + Quality tabs. Pro users: Behavior, Time, Psychology tabs.
- Locked tabs shown with `.tab-lock-icon` and `opacity: 0.65`.

### CSV Import Gate

- CSV upload pane in Log Trade has a `lock-veil` overlay when `isFree = true`.
- Toggled by `applyLogTradeTier()`.

### Data Visibility Cap (Free Tier, non-Calendar/History)

**`_visibleTrades()`** — returns last 30 days for free users, all trades for Pro:

```js
function _within30Days(t) {
  return new Date(t.date + 'T00:00:00').getTime() >= Date.now() - 30 * 86400 * 1000;
}
function _visibleTrades() {
  if (!isFreeTier()) return trades;
  return trades.filter(_within30Days);
}
```

Used by Dashboard mini-widgets and Equity curve. Calendar (`_calendarTrades()`) and History (`_historyTrades()`) both return the full `trades` array — the trial gate handles access via overlay, not a data clip.

### Upgrade Modal

`openUpgradeModal(reason)` — pops `#upgrade-modal`. `UPGRADE_REASONS` map provides per-reason title + body copy.

### Sidebar Lock Icons

**`applySidebarLocks()`** — adds/removes gold lock icons on nav items for:
- Calendar: locked when `ts.expired && !ts.grandfathered`.
- History: same as Calendar.
- Analytics (Review): locked when `!isGrandfathered()` (locked from day 1 for post-cutoff free).
- Community + Broker Sync: static lock (always shown for free tier).

### Server-Side Pro Gate

Used in: all `/api/community/*`, `/api/rules/*`, `/api/personal/*`, `/api/insights/generate`.

```js
// api/_lib/auth.js
export async function requirePro(req, res) {
  const user = await authUser(req, res);
  if (!user) return null;
  const profile = await sbService().from('profiles').select('is_pro, pro_source, pro_active_until').eq('id', user.id).maybeSingle();
  const untilMs = profile.pro_active_until ? Date.parse(profile.pro_active_until) : 0;
  const isPro = !!(profile.is_pro && profile.pro_source && untilMs > Date.now());
  if (!isPro) {
    res.status(403).json({ error: 'pro_required', message: '...' });
    return null;
  }
  return user;
}
```

### Save Handler Strip (Free Tier)

When a free post-cutoff user saves a trade, the save handler strips gated field values from the payload before writing to Supabase:
- `confluences`, `notes`, `grade`, `emotion`, `confidence`, `tradingview_link`, `stop`, `accounts` -> stripped/nulled.

---

## 5. Pages

### 5.1 Dashboard

**File:** `index-6_22.html` — `#pg-dashboard`, `renderDashboard()`

**Structure:** Hero PnL card, stats row (4 cards: Today / Avg R:R / Avg Win / Profit Factor), Win Rate donut, streak, EOD dashboard bar.

**Period filter:** `dashPeriod` in `{today, week, month}`.

**Key Functions:**
- `renderDashboard()` — computes all stats from in-memory `trades[]`. Filters by `filterByPeriod(trades, dashPeriod)`.
  - Computes: total PnL, wins, losses, breakevens, avg trade (per-account), total points, win rate, streak.
  - `perAccountPnl(t)` = `t.pnl / max(1, t.accounts)` — normalizes multi-account trades.
  - Sets hero, stats row, win rate donut.
- `filterByPeriod(trades, period)` — filters to today/week/month.
- `renderEodDashBar()` — renders the EOD mini-summary bar at the top of dashboard (today's net PnL + trade count).
- `renderEodCommBadges()` — renders P&L badges in community sidebar.

**Supabase Reads:** All data comes from in-memory `trades[]` loaded at sign-in. No per-render DB queries.

---

### 5.2 Calendar

**File:** `index-6_22.html` — `#pg-calendar`, `renderCalPage()`, `buildCal()`, `renderCalHeatmap()`

**Structure:** Month grid view + Heatmap view (toggle). Day-detail panel on cell click. Edit trade modal.

**Key Functions:**
- `renderCalPage()` — calls `applyCalendarGate()`, builds month grid via `buildCal()`, calls `showDay()` if a day is selected, calls `refreshCalendarStats()`, calls `renderCalHeatmap()`.
- `buildCal(year, month, containerId, showDots)` — renders the monthly calendar grid.
- `renderCalHeatmap()` — 13/26/52-week GitHub-style heatmap. Groups `_calendarTrades()` by day, computes P&L intensity tiers (w1-w4, l1-l4), renders win-streak cells.
- `setCalView(view)` — toggles between `'month'` and `'heatmap'`.
- `setCalHmRange(range)` — sets heatmap to `3M`, `6M`, or `1Y`.
- `applyCalendarGate()` — applies/removes `.cal-locked`, shows/hides `#cal-paywall` and `#cal-trial-banner`.
- `showDay(dateStr)` — opens the day-detail side panel for a selected date.
- `refreshCalendarStats()` — updates summary stats for the current month view.

**Supabase Reads (in day detail):**
- `window._sb.from('trade_confluences').select('confluence_id, timeframe, position, confluences(name)').eq('trade_id', tid).order('position')` — via `loadTradeConfluences()`.

**Supabase Writes:**
- Edit modal saves -> `saveTradeToSupa(trade)` -> `.from('trades').upsert({id, user_id, trade_data, account_type, journal, updated_at})`.
- Confluence updates -> `saveTradeConfluences(tradeId, pills)` -> delete + insert `trade_confluences`.

---

### 5.3 History

**File:** `index-6_22.html` — `#pg-history`, `renderHistory()`

**Structure:** Filter bar (market, direction, result, account type), summary strip, trade rows table.

**Key Functions:**
- `renderHistory()` — async. Calls `applyHistoryGate()`. Gets `_historyTrades()`. Applies filters. Computes summary. Batch-loads confluences. Renders row HTML.
- `applyHistoryGate()` — gate for expired free trial.
- `deleteTrade(id)` — deletes from memory + `_sb.from('trades').delete().eq('id').eq('user_id')`. Also deletes `community_posts` where `id LIKE 'trade_'+id+'_%'`.

**Supabase Reads:**
- Confluence batch load: `window._sb.from('trade_confluences').select('trade_id, confluence_id, timeframe, position, confluences(name)').in('trade_id', ids)`.

**Supabase Writes:**
- Delete: `_sb.from('trades').delete().eq('id', id).eq('user_id', currentUser.id)`.
- Delete community posts: `_sb.from('community_posts').delete().like('id', 'trade_'+id+'_%')`.

---

### 5.4 Review (Analytics)

**File:** `index-6_22.html` — `#pg-analytics`, `renderAnalytics()`

**Structure:** Tabs — Performance, Quality (free); Behavior, Time, Psychology (Pro-gated). Below: Rules sub-system.

**Key Functions:**
- `renderAnalytics()` — renders the active Analytics panel. Calls `renderRules()` when the rules tab is active.
- `onAnalyticsTabClick(panel, el)` — gate check then `showAnalyticsPanel()`.

**Review System (Pro-only, API-driven):**
- `renderRulesPage()` — async. Calls:
  - `GET /api/rules` -> list rules with streaks.
  - `POST /api/rules/seed-defaults` (if 0 rules returned).
  - `GET /api/rules/today` -> today's review items with current status.
  - `GET /api/rules/weekly-scorecard` -> 7-day adherence summary.
- `submitRulesReview(reviews)` -> `POST /api/rules/review`.
- `toggleRuleActive(id, makeActive)` -> `PATCH /api/rules/{id}`.
- `deleteRule(id)` -> `DELETE /api/rules/{id}`.
- `createRule({name, cadence, description})` -> `POST /api/rules`.

**Personal Analytics (Pro-only):**
- Equity Curve: `GET /api/personal/overview` -> 30-day net PnL, win rate, avg R:R, trade count, daily cumulative curve.
- Behavior Breakdown: `GET /api/personal/behavior-breakdown` -> confidence/emotion/grade distributions and win rates.

**Ark Insights (Pro-only):**
- `POST /api/insights/generate {type: 'headline'|'working'|'off'|'heads_up'}` -> deterministic pattern insight. Minimum 10 trades required.
- `POST /api/ark/debrief` -> Claude AI debrief (claude-sonnet-4-5 or claude-haiku-4-5).
- `POST /api/ark/coaching` -> AI coaching card.
- `POST /api/ark/trade-read` -> Per-trade instant read (claude-haiku-4-5). Fire-and-forget; degrades silently if no `ANTHROPIC_API_KEY`.

---

### 5.5 Community

**File:** `index-6_22.html` — `#pg-community`, `renderCommunity()`

**Structure:** Left sidebar (group list + EOD badges), main feed (posts, leaderboard, check-in strip), right rail (stats). Gate: Pro required.

**Key Functions:**
- `renderCommunity()` — calls `renderCommSidebar()`, `updateInviteBadge()`, opens feed if active group exists.
- `renderCommSidebar()` — renders group list with avatars.
- `setActiveGroup(gid)` — selects group, calls `openCommFeed(gid)`.
- `openCommFeed(gid)` — sets `_comm`, calls `renderFeedPosts()`, `renderFeedLeaderboard()`, `renderFeedMembers()`, `renderHeroPnl()`, `renderGroupStats()`, `syncAndLoadCommFeed()`, `subscribeToCommFeed()`.
- `renderFeedPosts(g)` — loads `community_posts` from DB, batch-loads member profiles, renders post cards.
- `setCheckin(status)` — upserts a check-in post to `community_posts`.
- `loadCommunityFromDB(user)` — loads communities user belongs to from `communities` table.
- `syncAndLoadCommFeed(g)` — auto-posts today's trades to `community_posts` for each community the user is in.
- `renderGroupStats(g)` — calls `GET /api/community/group-stats?community_id=X&period=Y&tz_offset=Z`.
- `acceptCommInvite(invId)` — fetches invite, reads community, appends user to `members[]`, updates community, marks invite `accepted`.
- `declineInvite(invId)` — marks invite `declined`.
- `removeMember(userId)` — owner-only: filters out member from `members[]`.
- `leaveGroup()` — marks invite as `left`, updates `communities.members`.
- `deleteGroup(id)` — owner: deletes invites, community_posts, community row.

**Supabase Reads (client-side):**
- `_sb.from('communities').select('*').or('owner_id.eq.X,members.cs.{X}')` — load user's communities.
- `_sb.from('community_posts').select(...).eq('community_id', g.id).order('created_at', desc).limit(50)` — load feed.
- `_sb.from('profiles').select('id,username,avatar_finish,...').in('id', authorIds)` — batch-load post authors.
- `_sb.from('invites').select(...).eq('to_id', userId).eq('status','pending')` — pending invites.
- `_sb.from('profiles').select('id,username').ilike('username','%q%').limit(5)` — search users for invite.

**Supabase Writes (client-side):**
- `_sb.from('community_posts').upsert({id:'checkin_'+userId+'_'+date, ...})` — check-in.
- `_sb.from('community_posts').upsert(rows, {onConflict:'id'})` — auto-share trade posts.
- `_sb.from('communities').upsert({...})` — create group.
- `_sb.from('communities').update({members: newArr}).eq('id', ...)` — add/remove members.
- `_sb.from('invites').insert({...})` — send invite.
- `_sb.from('invites').update({status:'accepted'}).eq('id', invId)` — accept.
- `_sb.from('invites').update({status:'declined'}).eq('id', invId)` — decline.

**API Routes Called (all Pro-gated):**
- `GET /api/community/list`
- `GET /api/community/group-stats?community_id=X&period=Y&tz_offset=Z`
- `GET /api/community/pulse?community_id=X&range=Y`
- `GET /api/community/top-performers?community_id=X&range=Y`
- `GET /api/community/trader-of-the-day?community_id=X&tz_offset=Z`
- `GET /api/community/best-session?community_id=X&range=Y`
- `GET /api/community/most-used-confluence?community_id=X&range=Y`
- `GET /api/community/setup-combinations?community_id=X&range=Y`

---

### 5.6 Settings / Account

**File:** `index-6_22.html` — `#pg-account`

**Structure:** Tabs — Profile, Subscription, Billing, Appearance, Journals, Broker Sync (waitlist).

**Key Functions:**
- `loadProfileFromDB(user)` — reads `profiles` table. If row missing (new user), creates it via `.upsert()`.
- `saveProfileToDB()` — updates `profiles` table with display_name, username, avatar_finish, avatar_initials, etc.
- `saveAppearanceSettings()` — upserts `user_settings` rows for `display_tz` and `theme`.
- `userSettingSet(key, value)` — upserts to `user_settings`.
- `refreshActiveSubCard()` — fetches `GET /api/me`, populates subscription summary.
- `refreshBillingTab()` — fetches `GET /api/me`, populates billing tab. Free -> upgrade CTA. Elite -> Whop link. Premium -> "Included free" copy. Direct + hasStripe -> Stripe portal button.
- `openStripePortal(btn)` — `POST /api/billing/portal` -> redirect to `session.url`.

**Cancel Flow (Pro Direct only):**
- 3-step save-offer modal. Step 1: reasons. Step 2: save offer (pause 30d or 50% discount 3mo). Step 3: confirm cancel.
- `POST /api/billing/cancel {reason}` — schedules cancel at period end.
- `POST /api/billing/pause` — pauses collection for 30 days.
- `POST /api/billing/apply-coupon` — applies `STRIPE_COUPON_50_OFF_3MO`.

**Supabase Reads:**
- `_sb.from('profiles').select('id,display_name,username,...').eq('id', user.id)`.
- `_sb.from('user_settings').select('key,value').eq('user_id', user.id)`.

**Supabase Writes:**
- `_sb.from('profiles').upsert({...})` — new profile creation.
- `_sb.from('profiles').update({...}).eq('id', user.id)` — profile updates.
- `_sb.from('user_settings').upsert({user_id, key, value, updated_at}, {onConflict:'user_id,key'})` — settings.

---

## 6. API Routes

All routes are Vercel serverless functions. Auth is Supabase Bearer JWT unless noted.

### `GET /api/me`

Returns the current user's tier status. No Pro requirement.

**Response:**
```json
{
  "tier": "free" | "pro_direct" | "pro_premium" | "pro_elite",
  "isActive": boolean,
  "activeUntil": "ISO string" | null,
  "hasDiscord": boolean,
  "hasStripe": boolean
}
```

**Supabase Reads:** `profiles.select('is_pro, pro_source, pro_active_until, stripe_subscription_id, discord_user_id')`.

---

### `POST /api/checkout/direct`

Creates a Stripe Checkout session for the Direct plan ($19/mo). Reads or creates Stripe customer, persists `stripe_customer_id`. Returns `{url: session.url}`.

---

### `GET /api/checkout/premium` — RETIRED, returns 410 Gone

---

### `POST /api/billing/portal`

Creates a Stripe Billing Portal session. Lazy-backfills `stripe_customer_id` from subscription if missing. Returns `{ok:true, url}`.

---

### `POST /api/billing/cancel`

Schedules subscription cancellation at period end via `stripe.subscriptions.update(subId, {cancel_at_period_end: true})`. Inserts to `cancellation_reasons`. Returns `{ok:true, active_until}`.

---

### `POST /api/billing/pause`

Pauses Stripe subscription 30 days via `pause_collection.behavior='mark_uncollectible'`. Inserts to `cancellation_reasons` (`prevented_by_offer:true, save_offer_type:'pause_30d'`).

---

### `POST /api/billing/apply-coupon`

Applies `STRIPE_COUPON_50_OFF_3MO` to subscription. Inserts to `cancellation_reasons` (`save_offer_type:'discount_50_3mo'`).

---

### `POST /api/stripe/webhook` (Edge Runtime)

**Auth:** Stripe-Signature header verification.

**Events Handled:**

| Event | Action |
|---|---|
| `checkout.session.completed` | Grants Pro, sets `pro_active_until = MAX(current, period_end+7d)`, auto-joins Trading Ark if Premium |
| `invoice.paid` | Extends `pro_active_until = MAX(current, period_end+7d)` |
| `invoice.payment_failed` | Queues `payment-failed` email (does NOT revoke Pro — grace period) |
| `customer.subscription.deleted` | Revokes Pro (discord_elite carve-out preserved if still active); queues `subscription-canceled` email |
| `customer.subscription.updated` | Logged only |

**Idempotency:** `webhook_events` table with `UNIQUE(provider, event_id)`. Duplicates return early.

---

### `POST /api/oauth/discord/start`

**Body:** `{plan: 'premium' | 'elite'}`.  
Signs HMAC state `{n:nonce, p:plan, u:userId, t:timestamp}`. Sets `rwd_oauth_n` cookie (HttpOnly, SameSite=Lax, 10-min TTL). Returns `{url: discordAuthorizeUrl}`.

---

### `GET /api/oauth/discord/callback`

Public redirect endpoint. Verifies HMAC state + nonce cookie + 10-min TTL. Exchanges code -> tokens. Fetches Discord identity + guild membership. Branches on role presence (Elite/Premium/None). Encrypts tokens with AES-256-GCM. Writes profile. Clears nonce cookie. Redirects to welcome or no-access page.

---

### `GET /api/community/list`

Pro-gated. Returns `[{id, name, trader_count, joined:true}]`.

---

### `GET /api/community/group-stats?community_id=X&period=Y&tz_offset=Z`

Pro-gated + membership check. Periods: `today`, `week`, `month`, `all`. Legacy `range` (`7d`, `30d`, `all`) accepted.

Returns: `{total_trades, trader_count, win_rate, avg_rr, total_points, net_pnl, leaderboard[], best_day?, trader_of_day?}`.

---

### `GET /api/community/pulse`, `best-session`, `most-used-confluence`, `setup-combinations`, `top-performers`

All: Pro-gated + membership check via `communityEndpoint()` wrapper.

| Route | Aggregation | Output |
|---|---|---|
| `/pulse` | `aggPulse` | trade_count, net_pnl, dominant_symbols, dominant_setup |
| `/best-session` | `aggSessions` | per-session win_rate, avg_rr |
| `/most-used-confluence` | `aggConfluence` | Top 5 confluence+TF combos |
| `/setup-combinations` | `aggCombos` | Top 6 confluence pairs by win rate |
| `/top-performers` | `topPerformers` | Top 25% members by net PnL (min 4 members) |

---

### `GET /api/community/trader-of-the-day?community_id=X&tz_offset=Z`

Pro-gated. Member with highest net PnL for today (in viewer's TZ). Returns username, avatar, `user_id_hash` (SHA-256, 12 chars), `net_pnl_today`, `trades_today`.

---

### `GET /api/rules`, `POST /api/rules`

Pro-gated. GET returns rules with `current_streak`. POST creates a custom rule.

---

### `PATCH /api/rules/:id`, `DELETE /api/rules/:id`

Pro-gated. Scoped to `user_id`. PATCH updates name/description/is_active/condition. DELETE removes rule.

---

### `GET /api/rules/today`

Pro-gated. Returns rules to review now, with their current status. `intra_day` always; `weekly` only on Fridays.

---

### `POST /api/rules/review`

Pro-gated. Body: `{reviews: [{rule_id, status: 'followed'|'broken'}]}`. `intra_day` anchors to UTC today; `weekly` anchors to this week's Friday (only allowed on Friday). Deletes prior eval for rule+day, inserts new eval.

---

### `GET /api/rules/weekly-scorecard`

Pro-gated. 7-day adherence summary with per-rule breakdown and cost impact.

---

### `POST /api/rules/seed-defaults`

Pro-gated. Seeds 5 default rules if user has zero (idempotent). Default rules: '1 mini per trade', '1 win = done', 'First trade loss -> half size', 'Only A+ setups', 'No trades on Friday'.

---

### `GET /api/personal/overview`

Pro-gated. 30-day equity summary + daily cumulative PnL curve array.

**Response:** `{window_days:30, summary:{net_pnl, win_rate, avg_rr, trade_count, total_points}, curve:[{date, cumulative}]}`.

---

### `GET /api/personal/behavior-breakdown`

Pro-gated. 30-day behavioral analysis.

Dimensions: discipline (confidence 1-5 bucketed to locked_in/confident/hesitant/tilted), emotion (bucketed to low/neutral/elevated/high), grade (A+/A/B/C).

Per-dimension: `{distribution, win_rates, trend_4_week, total}`.

---

### `POST /api/insights/generate`

Pro-gated (inline check). Body: `{type: 'headline'|'working'|'off'|'heads_up'}`.  
Gate: `<10 trades in 30-day window -> {locked:true, reason:'insufficient_data'}`.  
Builds `buildTraderAnalytics()` then `renderInsight(type, analytics)`. Deterministic, no AI.

---

### `POST /api/ark/trade-read`

Bearer auth only (no Pro gate enforced here). Body: `{trade: {...}, context?: {...}}`.  
Calls Claude Haiku (`claude-haiku-4-5`) for a 2-line blunt trade read.  
Degrades silently: no `ANTHROPIC_API_KEY` -> `{status:'degraded', line1:null, line2:null}`. Any AI failure -> same degraded response.

---

### `POST /api/ark/debrief`

Bearer auth + Pro gate. Uses Claude Sonnet for end-of-day debrief. Input context built by `ArkEngine.buildDebriefContext()` on client. Returns structured debrief sections.

---

### `POST /api/ark/coaching`

Bearer auth + Pro gate. Uses Claude Haiku for intra-day coaching card. Returns brief actionable coaching note.

---

### `POST /api/eod/render-card`

Bearer auth only. Renders 1600x900 PNG share card. Body: `{type: 'personal'|'group', data: {...}}`. Returns `image/png` binary.

---

### `POST /api/broker-sync-waitlist`

Optional Bearer auth. Body: `{email: string}`. Upserts to `broker_sync_waitlist` (ON CONFLICT email, ignoreDuplicates). Returns `{ok:true, alreadyOnList}`.

---

### `GET /api/cron/daily-role-check` (Cron: `0 3 * * *`)

Auth: `Authorization: Bearer CRON_SECRET`.  
Per Discord-Pro user: refresh token if expiring, check guild role, extend Pro (35d) or revoke Pro, queue email. discord_elite = no-op/DRIFT. 429 = skip. 50ms delay between profiles.

---

### `GET /api/cron/email-worker` (Cron: `*/5 * * * *`, Edge Runtime)

Auth: `Authorization: Bearer CRON_SECRET`.  
Drains up to 50 `queued` email_log rows. Resolves first name. Renders template body. Sends via Resend. Updates row to `sent` or `failed`. 150ms delay between sends.

**Templates:** `subscription-canceled`, `payment-failed`, `role-upgraded`, `role-lost-elite`, `role-lost-premium`, `role-downgraded-elite-to-premium`.

---

## 7. Share-Card Pipeline

### Trigger (Client-Side)

1. User clicks "Share" / "Export" on the EOD summary panel.
2. `_eodCaptureCardServer(card)` fires with `_eodActivePayload` (populated by the EOD data chain).
3. `fetch('POST /api/eod/render-card', {body: JSON.stringify(_eodActivePayload), ...})` with 10-second AbortController timeout.
4. On success: `r.blob()` -> builds `File` object -> caller handles share/download.
5. On failure: falls back to client-side DOM-to-image capture.

### Server-Side Rendering (`api/eod/render-card.js`)

**Fonts registered at module load:**
- `InstrumentSerifItalic`, `InstrumentSerif`, `Geist`, `GeistMedium`, `GeistMono`, `GeistMonoMedium` (all from `api/eod/fonts/*.ttf`)

**Canvas:** `createCanvas(1600, 900)` — `#0a0a0a` background.

**Personal card layout:**
- Top-left: "Rewind" brand in InstrumentSerifItalic
- Top-right: date + `@handle` in GeistMono caps
- Center hero: today's P&L in InstrumentSerifItalic (auto-sized 200px -> 110px to fit)
- Sub stats: trade count, win rate, avg R in GeistMono

**Community card layout:**
- Same background + brand mark
- Top-right: community avatar + name + member count
- Center hero: collective P&L
- Sub stats: trade count, group win rate, avg/trade, total points
- Bottom strip: "Top Traders" 3-column grid

**Response:** `Content-Type: image/png`, `Content-Disposition: inline; filename="rewind-pnl-{date}.png"`. No caching.

**Payload Shape:**
```js
{
  type: 'personal' | 'group',
  data: {
    etDate: 'YYYY-MM-DD',
    totalPnl: number,
    tradeCount: number,
    winRate: number,
    // Personal:
    avgR: number,
    handle: string,
    initials: string,
    trades: [{sym, pnl}],
    // Group:
    avgPerTrade: number,
    totalPoints: number,
    community: {name, icon_initials, memberCount, avatar_finish},
    traders: [{username, pnl, avatar_finish, avatar_initials}]
  }
}
```

---

## 8. Community Backend

### Data Model

Membership stored as `communities.members UUID[]` — no junction table. `owner_id` is also a member by convention (aggregations add owner via `communityMemberIds()`).

### `lib/community.js` — `joinTradingArk(sb, userId)`

Idempotent auto-join for the Trading Ark community (`TRADING_ARK_COMMUNITY_ID` env var).

**Fire points:** Discord OAuth callback (Branches A + B), Stripe webhook (Premium checkout), daily cron (role extension).

**Logic:**
1. Read `communities.select('members').eq('id', communityId)`.
2. If userId already in array -> `{ok:true, alreadyMember:true}`.
3. Update with `.not('members','cs','{userId}')` guard against races.

### `api/_lib/community.js` — Aggregation Library

| Function | Purpose |
|---|---|
| `parseRange(v)` | Normalizes `range` to `7d`, `30d`, or `all` |
| `communityMemberIds(row)` | Returns `[...row.members, row.owner_id]` deduplicated |
| `loadCommunity(id)` | Fetch community row from DB |
| `loadMemberTrades(memberIds, range)` | Fetch all member trades within date range |
| `aggPulse(trades, ctx)` | Net PnL, trade count, trader count, dominant symbols, setup |
| `aggSessions(trades)` | Win rate + avg R per session |
| `aggConfluence(trades)` | Top 5 confluence+TF combos by usage % |
| `aggCombos(trades)` | Top 6 confluence pair combos (min 3 trades, by win rate) |
| `aggGroupStats(trades, ctx)` | Hero stats + per-user leaderboard |
| `bestDay(trades)` | Day with highest net PnL (positive only) |
| `traderOfTheDay(trades, today)` | Member with highest net PnL for today |
| `topPerformers(trades, ctx)` | Top 25% by net PnL (min 4 members) |
| `communityEndpoint(realFn)` | Wrapper: Pro auth + community load + membership check + aggregate |

### `communityEndpoint` Wrapper Flow

1. GET only (405 otherwise).
2. `requirePro()` — 401/403 if not Pro.
3. Parse `community_id` and `range` from query.
4. `loadCommunity(cid)` — 404 if not found.
5. Check caller is in `communityMemberIds(row)` — 403 if not.
6. `loadMemberTrades(memberIds, range)` — load all member trades.
7. Call `realFn(trades, {memberCount, memberIds, range})`.
8. `Cache-Control: no-store`.

### Community Post ID Encoding

Trade posts: `trade_<trades.id>_<8-char-community-id>`  
Check-in posts: `checkin_<user_id>_<YYYY-MM-DD>`

The cascade trigger on `trades` DELETE uses LIKE `'trade\_' || OLD.id || '\_%'` to orphan-clean posts.

### Leaderboard

`aggGroupStats()` groups trades by `user_id`, sums `gross_total` (raw PnL) and `per_account_total` (divided by `accounts`). Sorted by `gross_total` descending. Top 4 in leaderboard. Profile data resolved via batched `profiles.select().in('id', ids)`.

### Trader of the Day

Filters to trades where `effDate(t) === today`. Groups by user. Picks highest net PnL, tie-break on most recent `created_at`. User ID hashed to 12-char SHA-256 prefix before returning to client.

---

## 9. Stripe Wiring

### Checkout Flow (Direct Plan, $19/mo)

1. SPA calls `POST /api/checkout/direct` with Bearer token.
2. Reads or creates Stripe customer, persists `stripe_customer_id`.
3. Creates `stripe.checkout.sessions.create()`:
   - `mode: 'subscription'`
   - `client_reference_id: user.id`
   - `subscription_data.metadata: {user_id, plan: 'direct'}`
   - `success_url: /welcome/direct`, `cancel_url: /upgrade?canceled=1`
   - `automatic_tax: {enabled: true}`
4. Returns `{url}` -> SPA redirects browser to Stripe Checkout.

### Webhook Processing (`POST /api/stripe/webhook`, Edge Runtime)

**Signature verification:** `stripe.webhooks.constructEventAsync(rawBody, sig, STRIPE_WEBHOOK_SECRET)` using raw body from `request.text()`.

**`checkout.session.completed`:**
- Fetches subscription to get `metadata.plan` and `current_period_end`.
- `pro_active_until = MAX(current_window, period_end + 7 days)`.
- Discord Elite carve-out: if user already has `discord_elite` with active window, `pro_source` stays `discord_elite`.
- Updates profiles: `{stripe_customer_id, stripe_subscription_id, is_pro:true, pro_source, pro_active_until}`.

**`invoice.paid`:**
- Looks up profile by `stripe_subscription_id`.
- Extends `pro_active_until = MAX(current, invoice.period_end + 7 days)`.

**`invoice.payment_failed`:**
- Does NOT touch `is_pro` (7-day grace covers Stripe dunning window).
- Queues `payment-failed` email.

**`customer.subscription.deleted`:**
- Discord Elite carve-out: if `pro_source === 'discord_elite'` and `pro_active_until > NOW()`, keeps Pro.
- Otherwise: `profiles.update({is_pro:false, pro_source:null, stripe_subscription_id:null})`.
- Queues `subscription-canceled` email.

### Pro Active Until Grace Period

Every Pro extension adds **+7 days** beyond the billing period end: `period_end * 1000 + 7 * 86400 * 1000`.

### Billing Portal

Configured in Stripe Dashboard. Cancel, switch plans, and pause are DISABLED (handled in-app). Enabled: update payment method, view invoices.

---

## 10. Discord OAuth

### Scopes

`identify guilds.members.read` — required to call `/users/@me/guilds/{guild_id}/member`.

### State Security

HMAC-SHA256 signed state: `<base64url(JSON)>.<base64url(HMAC-SHA256 sig)>`  
Payload: `{n: nonce, p: plan, u: userId, t: unix_seconds}`.

Nonce also stored as HttpOnly SameSite=Lax cookie `rwd_oauth_n` (10-min TTL). Callback verifies HMAC signature + constant-time nonce comparison + 600-second age check.

### Token Encryption

`encryptToken(plaintext, keyHex)` — AES-256-GCM.  
Blob layout: `IV(12 bytes) || ciphertext(N) || authTag(16)` -> base64.  
Key: `ENCRYPTION_KEY` env var (64 hex chars = 32 bytes).

### Profile Fields Written on Callback

**Always (Branches A, B, C):** `discord_user_id`, `discord_access_token` (encrypted), `discord_refresh_token` (encrypted), `discord_token_expires`, `last_role_check`.

**Branch B (Premium role) additionally:** `is_pro = true`, `pro_source = 'discord_premium'`, `pro_active_until = NOW() + 35 days`.

### Token Refresh (Daily Cron)

If `discord_token_expires < NOW() + 5 minutes`: decrypt refresh token, call Discord refresh endpoint. On 400/401 -> `revokePro()`. On success -> re-encrypt and persist.

### Role Check Results

| Status | Action |
|---|---|
| 200 + Premium role | Extend `pro_active_until` +35d (MAX-guarded) |
| 200 + no qualifying role | `revokePro()` |
| 401 | `revokePro()` (token revoked) |
| 404 | `revokePro()` (not in guild) |
| 429 | Skip (don't update `last_role_check`) |

### Auto-Join Trading Ark

Triggered on: Discord OAuth (Branches A + B), Stripe checkout (Premium plan), daily cron (role extension). All calls idempotent and fire-and-forget.

---

## 11. Date & Timezone Handling

### Storage

- `trade_data.date` — `YYYY-MM-DD` local date string (client's local timezone at time of entry).
- `trades.created_at` — UTC timestamptz (auto-set by Postgres/Supabase).
- `trades.trading_day` — DATE column, ET-adjusted.

### Trading Day Attribution (ET Timezone)

**`js/tradingDay.js` — `getTradingDay(utcMs)`:**

Uses `Intl.DateTimeFormat` with `timeZone: 'America/New_York'` (handles DST automatically).

Rules:
- **Saturday:** null (closed).
- **Sunday before 18:00 ET:** null (closed).
- **Sunday 18:00+ ET:** -> Monday (futures open Sunday 6pm ET).
- **Monday-Friday, 17:00-17:59 ET:** -> next business day (settlement hour rollover).
- **Monday-Friday, 18:00+ ET:** -> next calendar day.
- All other hours: ET date.

**Additional `tradingDay.js` functions:**
- `getSession(utcMs)` — returns `'Asia'`, `'London'`, `'NY AM'`, `'Lunch'`, `'NY PM'` based on ET hours.
- `isMarketOpen(utcMs)` — boolean.
- `getNextOpen(utcMs)` — next market open timestamp.
- `formatET(utcMs)` — `'HH:MM'` string in ET.
- `getTodayTradingDay()` — `getTradingDay(Date.now())`.

### Display Timezone

Stored in `user_settings` as `display_tz` (e.g. `'America/New_York'`, `'America/Chicago'`, `'device'`). Applied via `window.TradingDay.setDisplayTz(tz)`.

### Server-Side Date Handling

Community endpoints accept `tz_offset` (JS `Date.getTimezoneOffset()` in minutes, positive west of UTC):

```js
const localToday = new Date(Date.now() - tzOffset * 60000).toISOString().slice(0, 10);
```

### Share Card Date

```js
function fmtDate(etDate) {
  const d = new Date(etDate + 'T12:00:00Z');
  return DOW[d.getUTCDay()] + ' · ' + MONTHS[d.getUTCMonth()] + ' ' + d.getUTCDate();
}
```

Anchors at noon UTC of the ET date string.

### Effective Date for Aggregations

```js
function effDate(t) {
  if (typeof t.date === 'string' && /^\d{4}-\d{2}-\d{2}/.test(t.date)) return t.date.slice(0, 10);
  if (typeof t.created_at === 'string' && t.created_at.length >= 10) return t.created_at.slice(0, 10);
  return null;
}
```

Prefers `trade_data.date` (client local date). Falls back to `created_at` UTC date.

### Range Filtering in API

```js
const cutoff = Date.now() - days * 864e5;
rows.filter(t => {
  const ms = d ? Date.parse(d + 'T12:00:00Z') : 0;
  return ms >= cutoff;
});
```

Anchors at noon UTC to avoid off-by-one at timezone boundaries.

---

## Appendix A: Vercel Configuration

```json
{
  "rewrites": [
    { "source": "/",                        "destination": "/index-6_22.html" },
    { "source": "/account",                 "destination": "/index-6_22.html" },
    { "source": "/upgrade",                 "destination": "/index-6_22.html" },
    { "source": "/oauth/discord/start",     "destination": "/api/oauth/discord/start" },
    { "source": "/oauth/discord/callback",  "destination": "/api/oauth/discord/callback" },
    { "source": "/welcome/elite",           "destination": "/welcome/elite.html" },
    { "source": "/welcome/direct",          "destination": "/welcome/direct.html" },
    { "source": "/welcome/premium",         "destination": "/welcome/premium.html" },
    { "source": "/oauth-no-access",         "destination": "/oauth-no-access.html" },
    { "source": "/oauth-error",             "destination": "/oauth-error.html" },
    { "source": "/terms",                   "destination": "/terms.html" },
    { "source": "/privacy",                 "destination": "/privacy.html" },
    { "source": "/refund",                  "destination": "/refund.html" }
  ],
  "crons": [
    { "path": "/api/cron/daily-role-check", "schedule": "0 3 * * *" },
    { "path": "/api/cron/email-worker",     "schedule": "*/5 * * * *" }
  ],
  "functions": {
    "api/eod/render-card.js": { "maxDuration": 15, "includeFiles": "api/eod/fonts/**" }
  }
}
```

---

## Appendix B: Key Constants and Hardcoded Values

| Constant | Value | Location |
|---|---|---|
| `SUPA_URL` | `https://efxjxmtjycldvovcbczg.supabase.co` | `index-6_22.html` |
| `SUPA_KEY` (anon) | `sb_publishable_F3g-zezPLXXQ6Khe0woNhg_n1V1FORM` | `index-6_22.html` |
| `TRIAL_GRANDFATHER_CUTOFF` | `'2026-05-22'` | `index-6_22.html` |
| `PRO_WINDOW_DAYS` (Discord) | `35` | `api/oauth/discord/callback.js`, `api/cron/daily-role-check.js` |
| `INVOICE_GRACE_DAYS` | `7` | `api/stripe/webhook.js` |
| `PAUSE_DAYS` | `30` | `api/billing/pause.js` |
| `TOKEN_REFRESH_BUFFER_MS` | `5 * 60 * 1000` | `api/cron/daily-role-check.js` |
| `STATE_TTL_SECONDS` | `600` | `api/oauth/discord/start.js`, `callback.js` |
| `BATCH_LIMIT` (email worker) | `50` | `api/cron/email-worker.js` |
| `RATE_LIMIT_DELAY_MS` (cron) | `50` ms | `api/cron/daily-role-check.js` |
| `RATE_LIMIT_DELAY_MS` (email) | `150` ms | `api/cron/email-worker.js` |
| Stripe API version | `'2024-12-18.acacia'` | `api/_lib/stripe.js` |
| Ark AI model (coaching/debrief) | `claude-sonnet-4-5` | `api/ark/coaching.js`, `api/ark/debrief.js` |
| Ark AI model (trade-read) | `claude-haiku-4-5` | `api/ark/trade-read.js` |

---

## Appendix C: Pro-Gated Fields (Log Trade + Edit Modal)

| Field Name | Payload Key | `PRO_GATED_FIELDS` key |
|---|---|---|
| Confluences (tags) | `confluences` | `'tags'` |
| Notes | `notes` | `'notes'` |
| Grade | `grade` | `'grade'` |
| Emotion | `emotion` | `'emotion'` |
| Confidence | `confidence` | `'confidence'` |
| TradingView link | `tradingview_link` | `'tv_link'` |
| Stop + Accounts | `stop`, `accounts` | `'advanced'` |

On save, these fields are stripped from the payload for post-cutoff free users before writing to Supabase.

---

## Appendix D: Ark Engine (Client-Side, `js/arkEngine.js`)

Deterministic rule engine — no AI.

| Function | Purpose |
|---|---|
| `getRuleResults(todayTrades, userRules)` | Auto-checks rules by name parsing (max N trades, consecutive losses, killzone-only, flat by HH:MM, max loss $X). Saves to `window._arkRuleResults` |
| `getPlanStatus(todayTrades, ruleResults)` | Checks if any rules violated |
| `getInsights(trades, windowDays)` | bestSetup, bestModel, topConfluence, emotion patterns |
| `getPatterns(trades)` | Recurring patterns with count and avgImpact |
| `computeGrade(todayTrades, ruleResults)` | Letter grade for the day |
| `getJournalStreak(trades)` | Consecutive days with a trade logged |
| `getGreenStreak(trades)` | Consecutive green days |
| `getDeterministicDirective(insights, patterns, grade)` | One-sentence directive string |
| `buildDebriefContext()` | Context object passed to `/api/ark/debrief` |
| `buildTradeReadContext()` | Context object passed to `/api/ark/trade-read` |
