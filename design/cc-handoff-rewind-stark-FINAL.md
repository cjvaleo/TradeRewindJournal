# REWIND — STARK REMODEL · FULL HANDOFF (build to the mocks, exactly)

## READ THIS FIRST — why the last attempt failed

The previous build came out **nothing like the approved design** because the prompt described pages in prose and you reinterpreted them. That is the one thing that must not happen again.

**The mock HTML files in `design/mocks/` are the literal, pixel-level source of truth.** They are not inspiration, not "a direction," not a rough idea. They are the spec. Every page you build must look **identical** to its mock — same layout, same Stark tokens, same fonts, same glass panels, same watermark, same spacing, same colors, same components, same interactions.

**Your job is to PORT each mock into the live app, then wire it to real data. You are not designing anything.** If your output diverges visually from the mock, the workstream has failed — regardless of whether the code "works."

The hard rule: **open the mock, replicate its DOM structure + CSS + JS interactions verbatim into the app, then replace the dummy data with real data.** Do not paraphrase the markup. Do not "improve" the design. Do not substitute your own components. Match it.

---

## STEP 0 — Christian copies these files into the repo before you start

Place the approved mocks here (rename exactly as shown):

```
design/mocks/dashboard.html      ← rewind-dash-holo.html
design/mocks/calendar.html       ← rewind-calendar-page.html
design/mocks/history.html        ← rewind-history-page.html
design/mocks/review.html         ← rewind-review-page.html
design/mocks/community.html      ← rewind-community-preview.html
design/mocks/settings.html       ← rewind-settings-page.html
design/mocks/theme-preview.html  ← rewind-theme-preview.html
design/app-audit.md              ← output of the audit prompt (see Step 1)
```

Every workstream below names its mock. **Open it first. It is the answer to "what should this look like."**

---

## STEP 1 — Audit before you touch anything (read-only)

If `design/app-audit.md` does not already exist, generate it first. Walk the current Rewind repo read-only and document, per page:
- file path(s) and how the page is structured today
- every function, Supabase read/write, and serverless route it uses
- the auth flow, session handling, and tier/plan gating (Free / Pro Direct $19 / Pro Premium $9 / grandfather cutoff `2026-05-22`, `window._userTier`, freemium field locks, 30-day trial gates, sidebar lock icons)
- the share-card pipeline (`@napi-rs/canvas`, `/api/eod/render-card`, font registration)
- the Community backend (groups, invites, feed, leaderboard, `group-stats` API, `requirePro()`, tables: communities / community_posts / trades / invites / profiles)
- Supabase schema, Stripe wiring, Discord OAuth, Vercel config, date/timezone handling

This audit is **binding**. Any page that already works (everything except the net-new systems) is a **reskin** — you swap the markup/CSS to match the mock and rebind the SAME functions and data. Breaking working backend to ship a skin is a failed workstream.

---

## REMODEL RULES — reskin vs net-new

**RESKIN (logic already exists — match the mock's look, keep the wiring):**
log-trade flow, all Supabase reads/writes, auth + sessions, tier/plan gating + freemium locks, share-card canvas pipeline, Community (groups/invites/feed/leaderboard/group-stats/requirePro), History data, Settings persistence. → Replace markup + CSS with the mock; rebind existing functions; preserve every gate, table op, route, and copy string the audit documents.

**NET-NEW (real engineering):**
trading_day timezone foundation + migration; the entire Ark engine (Tier-1 math + Claude API + `ark_reads` cache); the theme system; new views (calendar GRID/YEAR, Review page, alternate-timeline curves, process scores, Community Analytics view).

Regression rule: after each reskin, every feature in the audit for that page still works.

---

## THE STARK DESIGN SYSTEM — lift it verbatim from the mocks

Do **not** reinvent tokens. Copy the `:root` block and component CSS straight out of the mocks into a shared stylesheet (`design/tokens.css` or equivalent) and reuse it on every page. The mocks all share the exact same system:

- **Background:** `--bg:#1C1D20` (grey default) with the layered radial-gradient ground (jewelry lighting) — copy the `body` background stack from any mock verbatim.
- **Ink:** `--ink:#F2F2F0`, `--ink70:rgba(242,242,240,.9)`, `--ink45:rgba(242,242,240,.68)`.
- **Champagne gold:** `--gold:#D8B26A`, `--gold-grad:linear-gradient(160deg,#F2DCA4,#D8B26A 45%,#A8843E)`, `--gold-soft:rgba(216,178,106,.55)`.
- **Panels (liquid glass):** `--panel:rgba(255,255,255,.045)`, `--panel-border:rgba(255,255,255,.22)`, `backdrop-filter:blur(9px) saturate(1.6)`, `box-shadow: inset 0 1.5px 0 var(--spec), 0 14px 30px -18px rgba(0,0,0,.7)`. The `.glass` class is identical across all mocks — reuse it.
- **Win/Loss:** `--win:#2FAE78` / `--win-text:#7BE8B8`; `--loss:#C96A6A` / `--loss-text:#E8A0A0`.
- **Type:** ONE font, **Archivo** (italic). Display/brand = weight 900, `font-stretch:125%`; labels/body = 600/108%; data numbers = 900, `font-stretch:118%`. `font-variant-numeric:tabular-nums` globally. Load from Google Fonts exactly as the mocks do.
- **Watermark:** the fixed `REWIND × ARK` background watermark (`.wm`, `clamp(64px,9.5vw,150px)`, ~3.5–4% ink) — present on every page.
- **Shared top bar:** `« REWIND` brand left, centered nav (Dashboard · Calendar · History · Review · Community), `+ Log Trade` gold pill + `CV` avatar right, with the gold underline on the active item and the gold hairline glow under the bar. Identical markup in every mock — build it once as a shared component.
- **Layout convention:** desktop is `100vh` with no page scroll; only inner regions (feeds, tables, content panels) scroll. Under 1080px, stack and unlock scroll. Every mock already implements this — copy its media query.

**Performance law (enforce everywhere):** animate transform/opacity only. No animated blurs/filters, no conic gradients, no particles, no mousemove handlers. Static `backdrop-filter` on glass is fine.

---

## TRADING DAY FOUNDATION (Workstream 1 — build FIRST, everything depends on it)

America/New_York. A trade's `trading_day`: timestamp `< 17:00` ET → same calendar date; `>= 18:00` ET → next date; **Sunday `>= 18:00` ET → the upcoming Monday** (futures open Sunday 6PM; Sunday-evening trades belong to Monday). Add a `trading_day` column, backfill all existing trades, and expose a `display_tz` setting (Settings → Trading). Daily rules reset at 18:00 ET. Calendars render Sundays as visible quiet cells with an `OPENS 6PM` hint that never hold P&L.

---

## PAGE-BY-PAGE — each maps to ONE mock, build it to match

For every page: **open the mock in `design/mocks/`, build the page to look exactly like it, then wire the data.** Notes below are wiring guidance, not permission to deviate from the mock's appearance.

### Dashboard — `design/mocks/dashboard.html`
LEFT: P&L hero block (TODAY'S P&L + statline; SESSION · GREEN STREAK · LAST 3 TRADES modules) and the calendar filling to the bottom. RIGHT top→bottom: P&L share-card box → DAILY RULES → ARK BOT card (three.js hologram with LIVE / YDA / WK tabs). The hologram + Ark card are net-new UI over the Ark engine; everything else binds to existing trade data. Three.js hologram lives ONLY here.

### Calendar — `design/mocks/calendar.html`
Header: `‹ MONTH YYYY ›` + mini month day-strip + gold `SHARE MONTH CARD →` + `MONTH / GRID / YEAR` toggle. MONTH view: centered calendar (`max-width:1020px`, stretches to fill height), win/loss tinted cells, today gold, Sundays visible with `OPENS 6PM`, week tiles → weekly-read modal. GRID view: day-grouped screenshot gallery + working filter chips (All/NQ/ES/Wins/Losses/Shorts/Longs). YEAR view: 12-month heatmap. RIGHT column = two cards: THIS WEEK panel (with the inline week share-card visual + `WK READ →` + `SHARE WEEK CARD →`) and MONTH panel (6-stat grid + inline `● ARK BOT · MONTH READ` line). The three share-card scales (day/week/month) all come from the ONE `@napi-rs/canvas` generator.

### History — `design/mocks/history.html`
LEFT: title + search + `MONTH YYYY ▾` + chips (All/NQ/ES/Wins/Losses/Shorts/Longs/NY AM/NY PM) + a **live summary strip** (Trades / Net P&L / WR / Avg R / Best) that recomputes on every filter/search, over a scrollable table (sticky header; Date/Time/Symbol/Side/Setup/Session-dot/Mood/R/P&L; row click selects). RIGHT: TRADE DETAIL preview (gold brackets, screenshot thumb, 2-col meta, Ark trade read, OPEN FULL TRADE →, SHARE TRADE →). Reskin — rebind the existing history data layer; compute filters/summary client-side over the loaded set.

### Review — `design/mocks/review.html` (NET-NEW page)
HUD strip: pulsing dot + `ARK · EDGE REPORT` + gold grade chip + `MONTH YYYY ▾` + scan readout + stats incl. EXPECTANCY. LEFT = THE DOSSIER (one tall glass panel, gold brackets, `AUTHORED BY ARK BOT`): exactly four sections — ▲ What's Working (3 numbered, receipts) → ▼ What's Leaking (3, #01 has `BIGGEST LEAK` badge) → ◆ HIDDEN PATTERN (one non-obvious correlation w/ receipts) → directive command card pinned bottom. RIGHT = ANALYTICS: Equity Curve · Alternate Timelines (actual curve + two dashed ghost curves RULES ONLY / A+ ONLY + legend) over a 2×2 (BY SETUP / BY KILLZONE / EXTREMES / PROCESS SCORES gold gauges). **No three.js on this page.** The dossier is the cached month read (see Ark architecture) — same generation the calendar quotes.

### Community — `design/mocks/community.html`
Title row with a **Dash / Analytics view toggle** (top right). 
- **DASH view:** full-width **headliner** (Group P&L + Total Points / Win Rate / Avg RR / Active + a live equity sparkline + `⬡ Share Group Card`), then tabs (**All Trades / Teachers / My Activity**) with a live count, then the **feed as a 2-up gallery grid** of trade cards. Each card = chart screenshot (with WIN/LOSS chip + R tag floating on it) + meta block (avatar · name · role · time, then symbol · side · session · P&L). Whole card clickable → **Full Trade Recap modal** (big chart, Net P&L / Return / Risked, 6-field grid, confluences, trader notes, `● Ark Bot · Trade Read`, share row with Discord / IG Story / Copy Card / Open in My Journal). 
- **ANALYTICS view:** group equity curve + By Trader / By Killzone breakdown bars + Leaderboard (Return% / Consistency / Biggest Win tabs) + mini month calendar + `● Ark Bot · Group Read` card.
Reskin the existing Community backend per the audit (groups, invites, feed, leaderboard, group-stats, requirePro, 25-member cap, period mechanics, empty states, toast copy) — the look changes, the logic does not. In the mock the trade charts are generated placeholders; **in the app, render the trader's real uploaded screenshot** in that slot.

### Settings — `design/mocks/settings.html`
Left section nav → right panel: **Account** (avatar/name/username/email/password), **Subscription** (gold plan card = Pro · Premium $9/mo via Trading Ark Whop; three-tier ladder Free / Pro Premium ★current / Pro Direct $19 — **no Elite tier**; Ark Indicator access badge; Manage Billing → Stripe; Cancel), **Appearance** (Grey/Dark/Light theme swatches + accent), **Trading** (display timezone w/ 6PM reset note, default symbol, account size, default risk, default contracts), **Connections** (Discord + role verify, TradingView invite sync, Whop), **Notifications** (Ark brief/debrief/weekly + community/email toggles), **Data** (CSV import/export + danger-zone delete). Reskin/bind to the existing settings + tier + Stripe + Discord/Whop wiring.

### Themes — `design/mocks/theme-preview.html`
Three token sets: Grey (default), Dark, Light. Build a theme system that swaps the `:root` tokens, persists to localStorage + Supabase, and pre-paints on boot (no flash). Surfaced in Settings → Appearance.

---

## ARK — ONE BRAIN, FIVE ZOOMS (net-new, read before any Ark feature)

A single engine, results cached in an `ark_reads` table (`scope` ∈ trade/day/week/month/community, `scope_key`, `json`, generated_at). Grades & process scores are **process-based only — never P&L-based.**

- **Trade read** — Haiku, ~2 lines. Shown in History trade detail + Community trade recap.
- **Daily** — Sonnet. Dashboard Ark card YDA tab + daily debrief + tomorrow's focus.
- **Weekly** — Sonnet. Dashboard WK tab; Sundays it takes over the LIVE slot; opened from calendar week tiles in the weekly-read modal.
- **Month** — Sonnet. Calendar shows the one-liner; Review shows the FULL dossier — **same cached generation serves both.**
- **Community** — Sonnet, one call per group per week over `group-stats` aggregates → the Community Analytics "Group Read."

**Tier-1 (deterministic, no LLM):** rule/AUTO checks, insights, pattern detection, grades, process scores (Rules/Discipline/Patience/Risk Mgmt 0–100 gauges), counterfactual equity curves (RULES ONLY, A+ ONLY), streaks. **Tier-2 (LLM):** the prose reads above, including the explicit instruction in the edge-report prompt to surface ONE non-obvious correlation with receipts. Degrade gracefully if the API is unavailable (show Tier-1, skip prose).

---

## STATES & QA GATES

Every data view needs: loading (skeleton), empty (first-run copy), and error states — match the mock's existing empty/skeleton treatment where present. 

QA gates before a workstream is "done":
1. The page is **visually identical** to its mock (side-by-side check — this is the gate that failed last time).
2. Stark tokens/fonts/glass/watermark/top-bar all correct.
3. Desktop = 100vh no page scroll; inner regions scroll; <1080px stacks.
4. Every audit-documented function/route/gate on that page still works.
5. Performance law respected (no animated filters/particles/mousemove).
6. Trading-day attribution correct (incl. Sunday→Monday, Sundays empty).

---

## WORKSTREAMS (orchestrate; commit per workstream)

1. **(Opus)** tradingDay module + Supabase migration/backfill + `display_tz`
2. **(Sonnet)** Shared shell from the mocks: tokens.css (lifted verbatim), top bar, watermark, ground, glass, 100vh/stack convention
3. **(Sonnet)** Dashboard — port `dashboard.html`, bind P&L/calendar/rules, scaffold Ark card
4. **(Opus)** Ark Tier-1 engine: rules/AUTO, insights, patterns, grades, scores, counterfactual curves, streak
5. **(Opus)** Ark Claude API + `ark_reads` cache (trade/day/week/month/community), prompts incl. hidden-pattern instruction, debrief, degradation
6. **(Sonnet)** Dashboard hologram (three.js) + Ark card UI (LIVE/YDA/WK) + debrief UI
7. **(Sonnet)** Calendar — port `calendar.html` (MONTH centered/stretch + Sundays, GRID + filters, YEAR heatmap, 2-card right column, week-tile modal, week/month share-card templates off the one generator)
8. **(Sonnet)** History — port `history.html` (search + chips + live summary strip + table + trade-detail preview + trade share card)
9. **(Sonnet)** Review — port `review.html` (HUD + four-section dossier + alternate-timeline curves + 2×2 tiles + process gauges; no three.js)
10. **(Sonnet)** Community — port `community.html` (Dash: headliner + sparkline + tabs + 2-up gallery grid + recap modal; Analytics view: equity + breakdowns + leaderboard + mini calendar + group read) over the EXISTING community backend per audit; render real uploaded screenshots
11. **(Sonnet)** Settings — port `settings.html` (all sections) + Theme system from `theme-preview.html` (Grey/Dark/Light, localStorage+Supabase, pre-paint)
12. **(Sonnet)** States, mobile reflow, QA gates (esp. side-by-side mock fidelity), final integration

Order: **1 → (2,3) → 4 → (5,6,7) → (8,9,10,11) → 12.**

---

## THE ONE THING TO REMEMBER

For each page: **open the mock in `design/mocks/`, build the page to look exactly like it, then wire the data.** If it doesn't match the mock, it's not done. Ship.
One thing I'd add before it starts cutting code: tell it to commit after each workstream so you can roll back a single one if it drifts:

Commit to git after completing each workstream, with the workstream number in the message, so we can roll back individually.

Get the handoff in front of it, let it confirm the split + workstream order back to you, and then it starts WS1. Paste me its confirmation when it comes back — I want to see that it correctly classifies the reskins vs net-new before it builds.
