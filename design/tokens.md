# Rewind Design System — v7 "Pure Gold"

## Colors
- Background: #060606 (pure near-black, used everywhere)
- Gold (primary): #E9B23C — all primary text marks, logos, CTAs
- Deep gold: #A87E22 — secondary marks, muted accents, error text
- Highlight gold: #FFF3B0 — hover states, script text, input text
- Faint gold: rgba(233,178,60,.28) — placeholders, tertiary text
- Line: rgba(233,178,60,.18) — borders, dividers, underlines
- No other colors. No white. No grays. Gold on black only.

## Typography
- Display: Archivo — weight 900, italic, font-stretch 125%, tight tracking (-.045em), uppercase. Headlines and brand marks only.
- Script accent: Pinyon Script — sparingly, one accent per screen max.
- Body/UI: Geist 400/500.
- Data/labels: Geist Mono — letter-spaced uppercase (.2em+) for labels, buttons, stats.

## Brand marks
- «REWIND lockup: « in deep gold #A87E22 at .62em, name in #E9B23C
- Ark chevron SVG: path "M50 2 L94 98 L72 92 L50 46 L28 92 L6 98 Z", flat gold fill, small (18–24px), bottom-center placement

## Motion rules (hard constraints — performance)
- Entrance: staggered opacity/translateY fades only
- NO: blur filters, animated drop-shadows, particles, animated gradients,
  conic gradients, mousemove parallax, infinite repaint loops
- Transitions: color/border-color only, .2–.25s
- Respect prefers-reduced-motion

## Form patterns
- Inputs: borderless, bottom border 1px var(--line), gold focus border
- Buttons: transparent bg, Geist Mono uppercase letter-spaced, gold → highlight gold on hover
- Errors: inline below field, deep gold #A87E22

---

## Stark Dashboard System — v3

Added in WS2–8. Applied only when `body.stark-active` is set (dashboard and calendar pages).

### Three-theme token scheme

All colors are set via `[data-theme]` attribute on `<html>`. The three supported themes are `grey` **(DEFAULT)**, `dark`, and `light`. Theme is persisted to `localStorage` key `tr1_theme` AND to Supabase `user_settings` table (`{user_id, key:'theme', value}`) via `setTheme(mode)`.

**Default theme is `grey`.** When no `tr1_theme` key is present in localStorage, the no-flash inline script and `setTheme()` both fall back to `'grey'`. The `:root` / `[data-theme="dark"]` CSS fallback is for cascade purposes only and does not affect the JS default.

#### [data-theme="grey"] — THE DEFAULT
```css
--bg:#1C1D20; --ink:#F2F2F0; --ink70:rgba(242,242,240,.9); --ink45:rgba(242,242,240,.68);
--hair:rgba(242,242,240,.12); --hair2:rgba(242,242,240,.22);
--gold:#D9A92F; --gold-soft:rgba(217,169,47,.55);
--panel:rgba(255,255,255,.04); --panel-border:rgba(255,255,255,.16);
--win:#3FA577; --win-text:#67D6A6; --loss:#C96A6A; --loss-text:#E29595;
--glass-bright:1.1; --spec:rgba(255,255,255,.18); --btn-ink:#101010;
```

#### [data-theme="dark"] (CSS :root fallback — not JS default)
```css
--bg:#070708; --ink:#F4F4F2; --ink70:rgba(244,244,242,.88); --ink45:rgba(244,244,242,.66);
--hair:rgba(244,244,242,.1); --hair2:rgba(244,244,242,.2);
--gold:#D9A92F; --gold-soft:rgba(217,169,47,.55);
--panel:rgba(255,255,255,.028); --panel-border:rgba(255,255,255,.13);
--win:#3FA577; --win-text:#5ED1A0; --loss:#C96A6A; --loss-text:#DE8C8C;
--glass-bright:1.14; --spec:rgba(255,255,255,.16); --btn-ink:#0A0A0A;
```

#### [data-theme="light"]
```css
--bg:#F7F6F3; --ink:#141414; --ink70:rgba(20,20,20,.88); --ink45:rgba(20,20,20,.66);
--hair:rgba(20,20,20,.1); --hair2:rgba(20,20,20,.2);
--gold:#B8860B; --gold-soft:rgba(184,134,11,.55);
--panel:rgba(20,20,20,.025); --panel-border:rgba(20,20,20,.12);
--win:#1E7A52; --win-text:#1E7A52; --loss:#B04A4A; --loss-text:#B04A4A;
--glass-bright:1.0; --spec:rgba(255,255,255,.65); --btn-ink:#FFFFFF;
```

#### Ink opacity reference (lifted in v3)

| Token | dark | grey | light |
|---|---|---|---|
| `--ink70` | .88 | .9 | .88 |
| `--ink45` | .66 | .68 | .66 |

Note: `--grid-line` token has been **removed**. Dashboard and calendar backgrounds are flat `var(--bg)` + radial blobs only — no blueprint grid lines on any theme.

### Legacy aliases (migration shim)
`:root` also defines `--stark-*` aliases that map old names to new semantic tokens, e.g. `--stark-bg: var(--bg)`, `--stark-cream: var(--ink)`, etc. These exist purely for backward compatibility with older sections of the codebase not yet migrated. New code MUST use the `--bg`, `--ink`, `--hair`, etc. token names directly.

### Theme persistence
1. `setTheme(mode)` — sets `data-theme` on `<html>`, writes `localStorage.setItem('tr1_theme', mode)`, upserts `user_settings {user_id, key:'theme', value:mode}` in Supabase.
2. On page load, `localStorage.getItem('tr1_theme')` is read and `setTheme()` called before first paint (inline script, line ~25788).
3. On login, the `user_settings` row for `key:'theme'` is fetched and applied (line ~29066).

### Migration notes (--stark-* → [data-theme] semantic tokens)
| Old token | New token |
|---|---|
| `--stark-bg` | `--bg` |
| `--stark-cream` | `--ink` |
| `--stark-cream70` | `--ink70` |
| `--stark-cream45` | `--ink45` |
| `--stark-hair` | `--hair` |
| `--stark-hair2` | `--hair2` |
| `--stark-gold` | `--gold` |
| `--stark-gold55` | `--gold-soft` |
| `--stark-panel` | `--panel` |
| `--stark-win` | `--win` |
| `--stark-loss` | `--loss` |
| `--stark-win-amt` | `--win-text` |
| `--stark-loss-text` | `--loss-text` |

Rule: NO hardcoded hex/rgba colors in dashboard CSS. Every color must reference a CSS custom property from the scheme above.

---

### Glass cell spec

Calendar cells (`.stark-cal-cell`) use a layered liquid-glass effect:

1. **Base layer**: `background: var(--panel)` — theme-relative translucent fill
2. **Backdrop filter stack** (traded cells only):
   - Default (fallback): `backdrop-filter: blur(6px) saturate(1.6) brightness(var(--glass-bright))`
   - Progressive enhancement: `backdrop-filter: blur(2.5px) url(#liquidLens) saturate(1.7) brightness(var(--glass-bright))` — adds SVG displacement lens
   - Safari fallback (via `@supports not (backdrop-filter: blur(1px) url(...))`): plain `blur(6px) saturate(1.6) brightness(var(--glass-bright))`
3. **SVG liquid lens**: `<filter id="liquidLens">` inline in the page — `feTurbulence` + `feDisplacementMap` creates the liquid warp. Defined once in the dashboard HTML.
4. **Specular sheen overlay** (`.spec-sheen`): radial + linear gradient using `var(--spec)` at 50% opacity, `pointer-events:none`, sits above glass layer.
5. **Box shadow**: `inset 0 1px 0 var(--spec)` (top edge highlight) + `inset 0 -1px 0 rgba(0,0,0,.12)` (bottom edge shadow) + `0 4px 16px -8px rgba(0,0,0,.32)` (ambient drop).

Non-traded cells (future, weekend, empty): `backdrop-filter: none`, transparent background, 35% opacity.

**Constitution**: `backdrop-filter` and `-webkit-backdrop-filter` MUST NEVER appear in any `transition:` value or `@keyframes` rule. Only `border-color`, `background`, and `transform` transitions are permitted on `.stark-cal-cell`.

---

### Typography

- **Archivo 900 italic stretch-125%** — hero P&L amount, month title, month P&L, directive, grade letter, streak value, brand lockup.
- **Space Grotesk 600** — calendar cell money amounts (`.stark-cal-amount`), week rail tile amounts (`.stark-wk-amount`). These are the only uses of Space Grotesk.
- **Geist Mono** — ALL data numbers, labels, nav items, stat lines, insight rows, countdown text, status text.
- **Geist** — body copy (directive paragraph text, pattern detail).

---

### Green streak vs journal streak

These are two distinct concepts:

- **Green streak** (`#stark-streak-val`, `.stark-streak-mini-bars`): consecutive *winning trading days* (days with positive P&L). Rendered as mini-bars in the P&L panel. Uses `--win` / `--loss` colors. Computed from `window.trades`.
- **Journal streak** (future feature, separate element): consecutive days with a completed debrief/reflection entry. Would use a different element ID and source (debrief table). Currently not rendered on the dashboard.

---

### Ark card tab structure

The Ark card (`#stark-ark-col`) has three tabs selectable via `.ark-tab-btn`:

| Tab | ID | Content |
|---|---|---|
| `LIVE` | `ark-tab-live` | Today's coaching / real-time status + directive |
| `YDA` | `ark-tab-yda` | Yesterday's summary + debrief prompt |
| `WK` | `ark-tab-wk` | Rolling 5-day performance snapshot |

Tab state is stored in `window._arkActiveTab`. Tab switching calls `switchArkTab(tabId)` which shows/hides the relevant panel div. The Ark status dot (`#ark-status-dot`) and status text (`#ark-status-text`) are always visible regardless of tab.

---

### Dashboard states (WS8)

Handled by `applyStarkState()`, called at the end of `renderStarkDashboard()`:

1. **Weekend** — `pnlLabelEl` shows last trading day + "MARKET CLOSED · REOPENS SUN 6PM ET"; session element shows "WEEKEND" with dim static dot.
2. **First-run (0 total trades)** — hero shows `$0` in `var(--ink45)`. Directive: "Welcome. Log your first trade to get started." Insights section hidden. Ark status: "NO TRADES YET — PLAN ARMED" (gold dot).
3. **Pre-market** — market closed, no trades today. Hero `$0` in `var(--ink45)`. Directive: countdown to next open from `TradingDay.getNextOpen()` or fallback text.
4. **Zero-trade live day** — market open, 0 trades. Ark status: "NO TRADES YET — PLAN ARMED" (gold dot). Hero dim.
5. **Stop reached** — today P&L negative AND `Math.abs(pnl) >= stopLimit` (from `acct.daily_stop_limit` || `acct.daily_stop` || 500 fallback). Ark status: "STOP REACHED — DONE FOR TODAY" in `var(--loss-text)` with loss-colored dot.
6. **Regular red day** — today P&L negative, stop not reached. Hero in `var(--loss-text)`.
7. **Empty month nav** — handled inline in `renderStarkCalendar()`: when `daysTraded === 0`, `monthPnlEl` shows `"$0.00"` in `var(--ink45)` and days chip shows "0 DAYS TRADED".

---

### Layout

- Topbar: `56px` height, `1px var(--hair)` bottom border, `background: var(--bg)`.
- Grid: `display:flex; flex-direction:row`, left `flex:2.45`, right `min-width:310px`, hairline divider. Height: `calc(100vh - 56px)`, `overflow:hidden`.
- Left column: `overflow-y:auto` (scrolls internally). Right column: `overflow-y:auto`.
- Desktop scroll lock: `body.stark-active { overflow:hidden }` + `body.stark-active .main { overflow:hidden; height:100vh }` — the page body NEVER scrolls on desktop.
- `< 1080px`: columns stack (`flex-direction:column`), sidebar restored, blobs hidden for perf, `body.stark-active .main` gets `overflow-y:auto`.

### Ark hologram

- Three.js canvas `#ark-hologram-canvas` inside `.ark-hologram-wrap` (150×110px max, `overflow:hidden`).
- Animation: rotateY + gentle float Y on `requestAnimationFrame`. Pauses via `visibilitychange` + `IntersectionObserver`.
- The canvas MUST NOT be wrapped in any CSS `filter` rule. It is the ONLY sanctioned WebGL element.

### Background

Flat `var(--bg)` with radial blob overlays. No `repeating-linear-gradient` grid lines on any theme — `--grid-line` token is removed. Applies to both `#pg-dashboard` and `#pg-calendar`.

### HUD corner brackets (`.stark-brackets`)

`::before` + `::after` pseudo-elements. 14×14px gold L-marks (top-left + bottom-right). Color: `var(--gold-soft)`. Applied to `#stark-pnl-block` and `#stark-ark-col`.

### Gold scarcity rule

`var(--gold)` used only for:
- Brand «REWIND chevron
- Active nav item underline
- Link arrows (→)
- TODAY calendar cell border + date
- Directive left-border bar
- Streak value + filled dots
- Ark identity label + pulse dot
- HUD corner brackets

### Button variants
- **LOG TRADE**: ghost gold — `transparent` bg, `1px solid var(--gold)` border, gold Geist Mono text, `7px` radius.
- **GRADE TODAY**: solid gold pill — `var(--gold)` bg, `var(--btn-ink)` text, `999px` radius.
- **HISTORY →** / **YDA REPORT →**: `.stark-link` — no border, gold color, Geist Mono.

---

## Stark Calendar Page

Added in WS5. `body.stark-active` is toggled on for both the dashboard page and the calendar page via `goTo()`. The same design tokens, liquid glass cell recipe, and typography rules apply.

### stark-active scope

`body.stark-active` is set when `pg === 'dashboard' || pg === 'calendar'` and cleared for all other pages. This hides the sidebar and locks body scroll on desktop for both pages.

### Layout

- Shell: `.scal-shell` — `display:flex; flex-direction:row; height:calc(100vh - 56px); overflow:hidden` — no scroll on desktop MONTH view.
- Left pane: `.scal-left` — `flex:2.5; overflow:hidden` — grid rows auto-size to fill available height.
- Right rail: `.scal-right` — `flex:0 0 330px; overflow-y:auto; padding:16px` — scrolls independently.
- Desktop scroll lock: same as dashboard — `body.stark-active { overflow:hidden }`.
- `< 1080px`: `.scal-shell` stacks (`flex-direction:column; height:auto; overflow:visible`), `.scal-right` gets `flex:none; padding:12px`, `body.stark-active .main` gets `overflow-y:auto`.

### View toggle — MONTH / GRID / YEAR

Three views selectable via `.scal-view-btn` (Geist Mono 10px, letter-spacing .14em):

| View | Description |
|---|---|
| MONTH | Default. 7-column liquid glass cell grid. Day Detail + Month Stats in right rail. |
| GRID | Screenshot gallery with multi-select chip filters (symbol / setup / model / win / loss). `#scal-grid-panel`, `#scal-grid-filters`, `#scal-grid-gallery`. |
| YEAR | 12 month heatmap cards. Cell intensity = day P&L / month best day. Click a card to jump to that month view. `scalRenderYear()`. |

Active view stored in `window._scalState.view`. Switching calls `scalSetView(v)`.

### Liquid glass cells — `.scal-cell`

Same recipe as dashboard `.stark-cal-cell`. SVG filter ID on calendar page: `calLiquidLens` (separate `<filter id="calLiquidLens">` element, same `feTurbulence` + `feDisplacementMap` spec as dashboard `liquidLens`).

```css
.scal-cell {
  background: var(--panel);
  border: 1px solid var(--panel-border);
  border-radius: 13px;
  backdrop-filter: blur(6px) saturate(1.6) brightness(var(--glass-bright));
  -webkit-backdrop-filter: blur(6px) saturate(1.6) brightness(var(--glass-bright));
  box-shadow: inset 0 1px 0 var(--spec), inset 0 -1px 0 rgba(0,0,0,.12), 0 4px 16px -8px rgba(0,0,0,.32);
  transition: border-color .18s, background .18s, transform .12s;
}
.scal-cell:hover { border-color: var(--hair2); transform: translateY(-1px); }
.scal-cell.inactive { backdrop-filter:none; -webkit-backdrop-filter:none; background:transparent; border:1px solid var(--hair); opacity:.35; cursor:default; pointer-events:none; }
```

Weekend and future cells use `.inactive` — no backdrop-filter, 35% opacity.

### Typography

- **Archivo 900 italic stretch-125%** — `.scal-month-title` (month name), `.scal-month-pnl` (month P&L), `.scal-dd-pnl` (Day Detail P&L), `.scal-dd-grade` (grade letter).
- **Space Grotesk 600** — `.scal-cell-amt` (cell money amounts), `.scal-wk-amt` (week rail totals). These are the only uses of Space Grotesk 600 on the calendar page.
- **Geist Mono** — all labels, day numbers, stat rows, chip text, view toggle buttons.

### Day Detail panel (`.scal-day-detail`)

Right rail, appears when a cell is clicked. Contains:
- HUD corner brackets (`::before` / `::after`, `var(--gold-soft)`).
- `.scal-dd-label` — Geist Mono 9px label (e.g. "TUESDAY · JUN 10").
- `.scal-dd-grade` — Archivo 900 italic 32px grade letter, `var(--gold)`.
- `.scal-dd-pnl` — Archivo 900 italic 26px P&L amount.
- `.scal-dd-statrow` — Geist Mono 10px stat rows (trades, win rate, avg R).
- `.scal-trade-row` — per-trade breakdown rows, Geist Mono 10px.
- `.scal-ark-quote` — Ark coaching quote, `border-left:2px solid var(--gold)`.

### Month Stats panel (`.scal-month-stats`)

Right rail, always visible (below Day Detail). 2-column stat grid (`.scal-ms-grid`):
- `.scal-ms-label` — Geist Mono 8px uppercase labels.
- `.scal-ms-val` — Geist Mono 13px values.
- `.scal-ms-delta` — Geist Mono 9px delta/context.

### GRID view

`#scal-grid-panel` — chip filter row (`#scal-grid-filters`) + masonry-style screenshot gallery (`#scal-grid-gallery`, `grid-template-columns:repeat(auto-fill,minmax(218px,1fr))`). Multi-select chip filters for symbol, setup, model, win, loss. Active filter chips use `var(--gold)` border + `var(--panel-border)` background.

### YEAR view

`scalRenderYear()` — 12 month heatmap cards, one per calendar month. Each card shows month name + total P&L. Day cells colored by intensity: `intensity = dayPnl / monthBestDay`, mapped to `var(--win)` / `var(--loss)` with opacity. Click a heatmap card calls `scalSetMonth(year, month)` + `scalSetView('month')`.

### Background

Flat `var(--bg)` + radial blobs. No grid lines. Same blob elements as dashboard page (reused via `body.stark-active` CSS scope).

### Week rail (`.scal-week-tile`)

Right of the 7-column grid on desktop (`#scal-week-col`, `width:100px`). Hidden on mobile (`display:none`). Each tile: Geist Mono 8px week label, Space Grotesk 600 14px week total, mini day-bars (`.scal-wk-bar.win` / `.scal-wk-bar.loss`).
