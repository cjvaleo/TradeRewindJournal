# Agent Journal — Stdev Projections (Pine v6 indicator)

## 2026-05-30 — Full build, Stages 0–4 + final audit

**Built:** Complete `StdevProjections.pine` (~254 lines) — a 15m pivot-anchored
standard-deviation projection tool. Per the execution plan + handoff v1.

- **Stage 0 (skeleton):** header (`max_lines_count=500, max_labels_count=500,
  max_boxes_count=100`), all 7 input groups + Debug, `Pivot` UDT, `levels`
  array, `levelPrice()`, `drawLadder()` helper, TF guard + non-15m note.
- **Stage 1 (Module A):** confirmed pivot detection via `ta.pivotlow/high(5,5)`.
  Pending-low records anchored to `priorHigh` (rolling `lastPH`); `nextHigh`
  assigned reactively when the first subsequent high confirms.
- **Stage 2 (Module B):** one-shot −4.5 gate. `gatePrice = levelPrice(a0,a1,
  gateLevel)`; `qualified = nextHigh < gatePrice`. `gateSource` flips anchors.
- **Stage 3 (Module C):** 2 boxes (violet manip / teal dist) + 2 up-projecting
  ladders + right-edge labels. Key-level colors (orange/red/dashed-maroon −4.5).
  `keyLevelsOnly` override. `maxShown` prune with full handle cleanup.
- **Stage 4 (alerts):** once-per-pivot qualifying alert, `freq_once_per_bar_close`,
  behind `enableAlert` (default off).

**Key architectural decisions:**
- **Single guarded block.** A confirmed pivot HIGH is the only event that can
  complete a pending low, so detection-of-nextHigh + gate + render all live
  under `if not na(ph)`. Heavy work runs only on high-confirm bars, never every
  bar. Pending records are removed once evaluated, so the pending list stays tiny.
- **Two arrays:** `pivots` (pending lows only) and `drawn` (rendered qualified
  pivots, oldest-first → drives `maxShown`). A pivot can leave `pivots` while a
  reference lives on in `drawn` — handles are owned by the UDT object.
- **Pairing proof:** the first high after a low removes it from pending, so a
  later high never reaches it → each low gets its genuine *first* subsequent
  high. Two consecutive lows with no high between correctly share the same
  nextHigh and the same priorHigh.
- **Repaint-safe by construction:** all coordinates come from confirmed pivots
  (pivotLookback-bar lag); no `request.security`, no realtime-driven draws.

**Incident / recovery:** a session resume left my in-memory file copy stale;
a batch of edits failed against text that wasn't on disk. Recovered by
re-reading HEAD (clean Stage-2 commit `b8de913`) and doing a single consolidated
rewrite for Stages 3+4 rather than patching blind. No work lost.

**Known issues / not done:**
- **Not yet compiled in TradingView.** No local Pine compiler — needs a paste
  into the TV editor to confirm zero errors. Static checks pass (no tabs, no
  dup decls, indentation consistent, build-checklist items reviewed).
- `gateSource = Distribution` (OQ-1) is wired but unconfirmed against trader
  intent — default Manipulation is the validated path.
- Debug connectors (`debugMode`, default off) still present for diagnostics;
  harmless but can be stripped once you're happy with detection.

**Next:**
1. Paste into TradingView 15m chart → confirm compiles clean.
2. Eyeball qualified pivots: V-shaped legs, both ladders project up, −4.5 dashed,
   boxes on correct corners, only `maxShown` pivots visible.
3. Toggle `keyLevelsOnly`, flip `gateSource`, set `maxShown=1` to watch pruning.
4. If detection granularity feels off, tune `pivotLookback`.
