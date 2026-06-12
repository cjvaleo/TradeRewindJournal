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

## Stark Dashboard System

Added in WS2–7. Applied only when `body.stark-active` is set (dashboard page).

### Color tokens (CSS custom properties on `body.stark-active`)
```
--stark-bg:      #070708          /* near-black page background */
--stark-cream:   #F4F4F2          /* primary text */
--stark-cream70: rgba(244,244,242,.72)   /* secondary text */
--stark-cream45: rgba(244,244,242,.48)   /* dim / disabled text */
--stark-hair:    rgba(244,244,242,.10)   /* subtle borders */
--stark-hair2:   rgba(244,244,242,.20)   /* slightly stronger border */
--stark-gold:    #D9A92F          /* brand gold — use sparingly */
--stark-gold55:  rgba(217,169,47,.55)    /* HUD corner brackets */
--stark-panel:   rgba(244,244,242,.018)  /* glass panel background */
--stark-win:     #3FA577          /* profit green */
--stark-loss:    #C96A6A          /* loss red */
--stark-win-tint:  rgba(63,165,119,.05)  /* win cell background tint */
--stark-loss-tint: rgba(201,106,106,.05) /* loss cell background tint */
--stark-win-amt: #5ED1A0          /* winning P&L amount text */
--stark-gold-tint: rgba(217,169,47,.06)  /* today cell background tint */
```

### Blueprint grid
Two `repeating-linear-gradient` layers at `rgba(244,244,242,.016)` 1px lines, 44px cells, over `--stark-bg`.

### Panel component
```css
background: var(--stark-panel);
border: 1px solid var(--stark-hair);
border-radius: 12px;
```

### HUD corner brackets (`.stark-brackets`)
`::before` + `::after` pseudo-elements. 14px gold L-marks (top-left + bottom-right).  
Color: `rgba(217,169,47,.55)`.  
Applied ONLY to: hero P&L panel (`#stark-pnl-block`) and Ark card (`#stark-ark-col`).

### Typography rules
- **Archivo 900 italic stretch-125%** — brand moments: hero P&L amount, month title, month P&L, directive, grade letter, streak value, «REWIND lockup.
- **Geist Mono** — ALL data numbers, labels, nav items, stat lines, insight rows.
- **Geist** — body copy (directive paragraph text, pattern detail).

### Gold scarcity rule
Gold (`--stark-gold`) used only for:
- Brand «REWIND chevron
- Active nav item underline
- Link arrows (→)
- TODAY calendar cell border + date
- Directive left-border bar
- Streak value + filled dots
- Ark identity label + pulse dot
- HUD corner brackets

### Button variants
- **LOG TRADE**: ghost gold — `transparent` bg, `1px solid --stark-gold` border, gold Geist Mono text, `7px radius`.
- **GRADE TODAY**: solid gold pill — `--stark-gold` bg, `#070708` text, `999px radius`.
- **HISTORY →** / **YDA REPORT →**: `.stark-link` — no border, gold color, Geist Mono.

### Motion rules (hard constraints)
- Permitted: `transform`, `opacity` transitions only.
- Prohibited: `blur()`, animated `filter`, `conic-gradient`, particles, mousemove parallax.
- Three.js canvas (`#ark-hologram-canvas`) must NOT be wrapped in any CSS `filter` rule.
- Hologram: `rotate Y` + gentle float Y on `requestAnimationFrame`. Pauses on `visibilitychange` + IntersectionObserver.

### Layout
- Topbar: 56px height, `1px --stark-hair` bottom border, `background: --stark-bg`.
- Grid: `display:flex`, left `2.45fr`, right `minmax(310px,1fr)`, hairline divider.  
  Height: `calc(100vh - 56px)`.
- Left column overflow: `auto` (scrollable). Right column overflow: `auto`.
- `< 1080px`: columns stack (`flex-direction: column`), sidebar restored.

### Dashboard states (WS7)
Handled by `applyStarkState()`, called at end of `renderStarkDashboard()`:
1. **Weekend** — label shows "MARKET CLOSED · REOPENS SUN 6PM ET"; session shows "WEEKEND".
2. **First-run / no data** — hero `$0` dim, directive "Welcome. Log your first trade…", insights hidden.
3. **Pre-market** — hero `$0` dim, directive shows countdown to next open.
4. **Zero-trade live day** — hero dim, Ark status "NO TRADES YET — PLAN ARMED".
5. **Red day / stop hit** — hero in `--stark-loss`; if daily stop breached: Ark status "STOP REACHED — DONE FOR TODAY".
6. **Empty month (nav)** — calendar month P&L shows "$0" in `--stark-cream45`.
