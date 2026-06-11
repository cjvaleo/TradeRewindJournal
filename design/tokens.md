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
