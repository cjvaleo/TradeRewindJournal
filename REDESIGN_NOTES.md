# Rewind (TradeRewind) — Redesign Handoff

This doc covers the in-progress visual redesign of the trading journal app. The whole app lives in a single monolithic HTML file (`index-6.html`, ~9700 lines) — backend is Supabase, vanilla JS throughout, no build step.

The brand is shifting from "TradeRewind" (synthwave/neon) to **"Rewind"** (minimalist, chrome/luxe, Notion-vibe). The legal entity / domain stays TradeRewind; only the visual brand changes.

---

## Status

**✅ Done in new aesthetic:**
- Login page (glass rewind icon, VHS-style 5s glitch animation, see auth-screen)
- Dashboard (full rebuild — hero P&L, stats row, equity card, recent trades, win rate, best/worst, mini calendar)
- Sidebar (Rewind wordmark, refined nav, chrome avatar profile chip)

**🐛 Known issue — DEBUG FIRST:**
- **Calendar page renders completely blank.** pg-calendar exists in DOM, but something is hiding it. Forcing visibility via runtime JS `setAttribute('style', 'display:block !important; ...')` works, so the element is fine — some CSS selector with high specificity is winning over `.page.on{display:block !important}`. Open the file, click Calendar in the sidebar, right-click the blank area → Inspect → look at "Computed" tab in dev tools to see what's setting display:none. Should be a 30-second fix with local devtools.
- Calendar page itself is in original synthwave style (HTML untouched). Once display issue is fixed, the full redesign pass still needs to happen.

**⏳ Not yet redesigned (still synthwave):**
- Calendar (full page — mini cal on dashboard works in new style already)
- Log Trade (biggest single-page lift — heavy form styling)
- History
- Equity Curve (chart already partially recolored — needs full pass)
- Analytics
- Broker Sync
- Community (most complex — feed, member calendars, replies, likes UI)
- Account settings
- All modals (share trade, edit trade, member cal, group create/edit, etc.)

**🧹 Cleanup deferred:**
- Hard-remove dormant code for Goals/Rules/Risk Calc/Prop Firms (soft-removed from nav, code intact)
- Console.log/warn cleanup (~19 in production)
- `_sessionCountdownInterval` never cleared
- `save()` writes ALL trades on every change (perf)
- Mobile responsive pass (only one media query in the whole file)
- Stripe integration / paid plan gating

---

## Design System

### Fonts (loaded via Google Fonts in <head>)
- `var(--n-font-sans)` → **Geist** — UI text, labels, body
- `var(--n-font-mono)` → **Geist Mono** — small caps labels, numbers, metadata
- `var(--n-font-display)` → **Instrument Serif** italic — large monetary numbers, page titles ("Dashboard", "Calendar"), date titles

### Color tokens (defined in `:root` near top of `<style>`)
```
--n-bg:            #0a0a0a     page bg
--n-surface:       #121212     card bg
--n-surface-2:     #181818     elevated card / inset bg
--n-surface-3:     #1f1f1f     hover state / deepest inset
--n-border:        rgba(255,255,255,0.06)    hairline borders
--n-border-2:      stronger border (~0.10)
--n-border-3:      strongest border (~0.15)
--n-text:          #f5f5f5     primary text
--n-text-2:        #a1a1a1     secondary text
--n-text-3:        #6b6b6b     tertiary / labels
--n-text-4:        #4a4a4a     placeholder / faintest
--n-chrome:        linear-gradient silver       avatar / accent surface
--n-accent-cool:   #6ea8ff     cool blue accent (use sparingly)
--n-profit:        #5fb389     sage green (the ONLY green)
--n-loss:          #c95f5f     muted rose (the ONLY red)
```

**Color discipline:** ONE profit color, ONE loss color, ONE cool accent. No more 6-color neon rainbow. Black background, 5 surface greys, monetary tints only on profit/loss.

### Typography pattern (the rhythm that makes it feel coherent)
- **Section labels** → Geist Mono, 9–10.5px, uppercase, letter-spacing 0.18em, color `--n-text-3` or `--n-text-4`
- **UI / button text** → Geist sans, 11–13px, weight 500, no letter-spacing
- **Big monetary numbers** → Instrument Serif italic, sizes from 18px (cell P&L) → 36px (stat cards) → 64px (hero)
- **Cents** → wrapped in `<span class="cents">.XX</span>` — 0.65em, opacity 0.7
- **Units** (R, days) → wrapped in `<span class="unit">R</span>` — 0.55em, opacity 0.6

---

## File patterns I used (so you can match style)

### How redesigns are baked in
The file is too monolithic for clean component extraction in this pass. Pattern:

1. **Add new CSS** in a labeled block near top of `<style>` (e.g. `/* ── DASHBOARD COMPONENTS ── */`). Keep old CSS in place — don't delete legacy classes since other pages still use them.
2. **Replace HTML markup** for the page (`<div id="pg-X" class="page">...</div>`). PRESERVE all `id="..."` attributes — JS hooks depend on them.
3. **Refactor render functions** that inject inline styles (e.g. `renderDashboard`, `refreshCalendarStats`, `openDayReview`) to write the new class-based markup instead of `style="font-family:'Bebas Neue';color:var(--cyan)"` etc.

### Critical JS hook IDs — never rename these
The render functions write text/HTML into these by ID. Most of them aren't optional.

**Dashboard:** `dash-date`, `dash-stats`, `dash-cal`, `dash-cal-lbl`, `eq-total`, `wr-wins`, `wr-loss`, `wr-be`, `wr-streak`, `wr-pct`, `wr-circle`, `best-val`, `best-sub`, `worst-val`, `worst-sub`, `recent-list`, `mini-eq-canvas`, `mini-eq-tooltip`, `mini-eq-crosshair`, `eq-labels`, `journal-select`, `journal-badge`, `session-badge`, `session-dot`, `session-name`, `session-detail`, `hero-amount`, `hero-trades`, `hero-winrate`, `hero-streak`, `hero-avg`, `hero-label`

**Calendar:** `cal-lbl`, `big-cal`, `cm-pnl`, `cm-green`, `cm-red`, `cm-avg`, `cm-streak`, `day-panel`, `cal-day-title`, `cal-day-body`

**Sidebar:** `sb-avatar`, `sb-avatar-txt`, `sb-name`, `sb-username`

### Function name collisions I hit
- There's an existing `buildMiniCal(tData)` for community member-cals at ~line 4450. I renamed my dashboard mini-cal helper to `buildDashMiniCal(y,m,container)` to avoid JS hoisting collision. Watch for this when adding new utility functions — grep before naming.

### Known onclick handlers / global functions called from HTML
- `goTo(pageName)` — main navigation handler. Adds `.on` class. Page must be `id="pg-{name}"`.
- `setPeriod(p, el)` — dashboard time-window tabs (Today/Week/Month)
- `switchJournal(j)` — dashboard journal selector
- `calPrev()`, `calNext()` — calendar month nav
- `showDay(d)`, `openEditDay(d, e)` — calendar day click handlers
- `showWeekSummary(y, m, dayStart)` — calendar week-num click
- `openImgLightbox(src)` — screenshot fullscreen viewer
- `openCalEdit(id)` — edit trade from calendar day panel

---

## How to redesign a page (recipe)

Using Calendar as the example since it's next:

1. **Find the page section** — search for `<!-- CALENDAR -->` or `id="pg-calendar"`. The full block is ~70 lines for calendar.

2. **Find every render function that writes into it** — for calendar that's `renderCalPage`, `buildCal` (the `clickable=true` branch only — `clickable=false` is the dashboard mini), `refreshCalendarStats`, `openDayReview`. Use grep liberally.

3. **Build a standalone preview HTML first** if it's a complex page. I shipped `dashboard-preview.html` and `login-preview.html` to outputs — same pattern works. Open in browser, iterate on design without touching the live monolith. Once approved, port to live file.

4. **Bake in via Python script** for any change touching > 3 separate places. Pattern at `/tmp/dashboard_patch.py` — uses `replace_once()` helper that errors if the marker doesn't match exactly once. Way safer than sequential `str_replace` calls because it'll fail loudly if any anchor is off, instead of silently mis-editing.

5. **After every bake**, run sanity checks:
   ```python
   # Brace balance
   opens = content.count('{'); closes = content.count('}')
   assert opens == closes
   # No duplicate function definitions
   assert content.count('function buildCal') == 1
   # All critical IDs preserved
   for did in [...]: assert f'id="{did}"' in content
   ```

6. **Refresh and click around BEFORE moving on.** I learned this the hard way with calendar. Test the page itself, then test other pages too — sidebar/dashboard CSS changes can subtly break unrelated pages.

---

## Backups & file locations

- `/home/claude/index-6-cap25.html` — working file (in this session's container — won't persist)
- `/home/claude/index-6-cap25.PRECAL.html` — backup before calendar attempt
- `/home/claude/index-6-cap25.BACKUP.html` — backup before dashboard fix
- `/mnt/user-data/outputs/index-6.html` — current shipped state
- `/mnt/user-data/uploads/index-6.html` — original synthwave version (May 7)

---

## Supabase migrations the user still needs to run

These were authored earlier in the session but may not have been applied to Supabase yet:

- `/mnt/user-data/outputs/likes-replies-migration.sql` — feed likes & replies tables
- `/mnt/user-data/outputs/account-delete-migration.sql` — atomic `delete_my_account()` RPC
- `/mnt/user-data/outputs/image-storage-migration.sql` — `trade-images` bucket + RLS
- `/mnt/user-data/outputs/user-settings-migration.sql` — generic K/V `user_settings` table

Verify the `trade-images` bucket exists in Supabase Storage dashboard. The image upload code expects it.

---

## Final notes

- The redesign pattern works — dashboard + sidebar + login prove it. The system is consistent enough that subsequent pages should mostly be re-skinning, not rethinking.
- The calendar bug is the priority blocker. Once fixed, the calendar redesign itself is half-done — the new CSS classes (`.cal-head`, `.cal-stats`, `.cal-grid-wrap`, `.cal-card`, etc.) and refactored `buildCal`/`refreshCalendarStats`/`openDayReview` are all in `/tmp/calendar_patch.py` from this session. They didn't apply because of the underlying display issue, not because the patch itself was wrong.
- If working on this in Claude Code, commit between each bake — git diffs are way easier to reason about than line-number-shifted patches.
- Resist the urge to redesign the whole monolith into components in this pass. Re-skinning is the goal; restructuring is a separate project.

Good luck. The chrome looks good.
