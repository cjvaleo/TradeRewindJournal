# REWIND V3 — SPEC, DESIGN LANGUAGE, AND BUILD ANALYSIS

Consolidated from the §1–§34 wireframes and the written design doc, July 2026.
Sections marked **ANALYSIS** are my additions: conflicts, data gaps and cost.

---

## 0 · THE THROUGH-LINE

> Nothing flashy. Nothing forgotten. Everything recorded.

> Your journal belongs to you. Your lessons strengthen the room.

Reference mix: **classified records + market terminal + luxury editorial + black-box flight recorder.**

The login page is the seed. Every other page is another section of the same recorded archive.

**ANALYSIS — the ASCII wireframes are layout notation, not the visual target.** §1 draws the
existing ECHO login in ASCII and captions it "keep almost exactly as it is." The design doc
confirms it: "based on the login page, make every page feel like part of the same private,
cinematic trading archive." So the ECHO language extends. Nothing shipped is discarded.

---

## 1 · CORE VISUAL RULES

Apply to every page:

- Near-black background with subtle **vertical scan lines**
- Soft white **fog/bloom behind the page's focal point** — the login glow, reused
- **Huge geometric typography** for important words and numbers
- **Tiny monospaced labels** with wide letter-spacing
- Thin white and graphite dividers
- **Hard rectangular edges. Not rounded app cards.**
- Black, white, silver, smoke gray, transparent overlays
- Numbers read mechanical and precise. Written reflections read editorial.
- Small metadata in corners: page number, date, market, session, account
- Elements **fade, sharpen or slide into focus like a tape being rewound**
- **Never repeat the giant REWIND logo.** Each page gets ONE oversized word, number, chart or statement.
- Content area wide and cinematic, with controlled empty space
- Navigation narrow, dark, almost hidden. Selected item glows brighter with a short white line beside it.

---

## 2 · ⚠ THREE CONFLICTS WITH WHAT IS ALREADY BUILT

### 2.1 Wins and losses stop being green and red

Verbatim from the design doc:

> Profitable and losing trades should not be bright green and red. Instead: wins use solid
> white numbers. Losses use outlined or dim gray numbers. Rule violations receive a thin
> warning stripe. Shared trades receive a small community symbol.

**ANALYSIS — this is the highest-consequence line in the document.** Every shipped page uses
`--up #57BE8B` / `--dn #DE6B62`. Affected:

| File | Where |
|---|---|
| `v2/rewind-calendar.html` | day cells, month totals |
| `v2/rewind-history.html` | net and R columns |
| `v2/rewind-overview.html` | hero figure, sparkline, period cards |
| `v2/rewind-showroom.html` | card figure colour, `cls()`/`signed()` logic, both palette tokens |
| `v2/rewind-community.html` | banner, standings, post nets, cross-reference line |

Five of six shipped pages. Login is the only one untouched. It also changes the Showroom
export card and the planned Discord win card, since both encode result by colour today.

### 2.2 The "no grey text" rule is narrowly relaxed

Pure white at full opacity still governs **labels and hierarchy** — that stays. But dim gray
and outlined numerals are now the *required* encoding for **losses specifically**. Semantic
use, not de-emphasis.

### 2.3 Two navigations disagree

The design doc's sidebar is eleven items:

```
PRIVATE                COMMUNITY
  TODAY                  FEED
  LEDGER                 STANDINGS
  CALENDAR               EVENTS
  ANALYTICS              CHALLENGES
  PLAYBOOK               MEMBERS
  REVIEWS
```

§34 lists twenty-seven across PERSONAL / COMMUNITY / ACCOUNT / MODERATOR.

**ANALYSIS —** Rules, Goals, Imports, Rooms, Bookmarks, Notifications and all moderator
tooling are specified as *pages* but absent from the doc's sidebar. Either the doc's nav is
the curated surface and the rest is reached contextually, or §34 is the real map.
**Unresolved.** Renames to carry through: "Private Ledger" → **LEDGER**,
"Leaderboard" → **STANDINGS**.

**Also: Showroom appears in neither nav.** Unresolved whether it's dropped, folded into
Analytics, or simply undrawn.

Top bar: `REWIND / PRIVATE LEDGER · MARKET: NY OPEN · SEARCH · + LOG TRADE · ACTIVITY · PROFILE`

---

## 3 · THE APP SHELL

A persistent sidebar plus a live top bar (market status, activity count).

**ANALYSIS — this is the single biggest item, and it reshapes everything after it.** Today
every v2 page is a standalone HTML file with duplicated chrome and its own module script.

**Option A — one SPA with client routing.** Shell renders once and persists. Navigation is
instant, trades load once and are shared, and the "fade, sharpen, slide like a tape being
rewound" transitions become natural rather than fought for. A live market/activity bar
actually stays live. Cost: the six wired pages get refactored into route modules up front.

**Option B — a shared shell each page imports.** Each page stays its own file and imports
`rewind-shell.js`. Incremental, port one page at a time, current architecture mostly
survives. Cost: full reload on every navigation, so the shell flashes and the cinematic
transitions are impossible; trades refetch per page; the top bar restarts constantly.

**Recommendation: A.** At thirty destinations the SPA is the correct architecture, and B
means doing the work twice. Sequence it as shell + Today + Ledger first, then port the rest
behind it.

---

## 4 · PER-PAGE IDENTITY AND EXACT COPY

**Sign-in — "The Gateway."** Unchanged. REWIND acts as a doorway; more emotional than functional.

**Onboarding — "Identity Calibration."** Grayscale Discord avatar with a thin circular
scanning line. Progress as `IDENTITY ━━━ PROFILE ━━━ RISK ━━━ PRIVACY ━━━ READY`. Completed
steps become small archival stamps. Ends: `LEDGER INITIALIZED / MEMBERSHIP VERIFIED /
WELCOME TO THE ROOM`. Five steps: Discord identity, trading profile, risk plan, community
privacy, complete.

**Today — "The Daily Brief."** ONE enormous number (`+2.4R` or daily P&L, trader's
preference) on a horizontal bloom. Tiny line above: `WEDNESDAY · JUL 29 · NEW YORK SESSION`.
One summary line below: `04 TRADES · 75% WIN · 87 DISCIPLINE · PLAN FOLLOWED`. Trade
timeline left, risk-limit status right, thin equity line behind, one large reflection field.
**"Should feel calm even when the results are bad."**

**Log Trade — "The Black Box Recorder."** `01 / DETAILS  02 / EXECUTION  03 / REVIEW` as a
mechanical sequence. **Long underlined fields, not rounded inputs.** Chart upload as an empty
film frame with corner markers and a faint grid; once added, the chart dominates. Entry,
stop, target and exit as thin white lines and symbols — no bright colours. Save reads
**COMMIT TO THE RECORD**.

**Ledger — "The Archive."** Dense table, editorial spacing, rows as indexed records:
`NO. 0184   JUL 29   NQ   LONG   ORB   +1.27R   GRADE A`. Hover passes a horizontal light
streak behind the row. Filters as archive tags: `[NQ] [NY OPEN] [ORB] [PLAN FOLLOWED] [JULY]`.
Views: table, chart gallery, daily grouping, setup grouping.

**Trade Detail — "The Evidence Room."** Chart dominant in a dark frame. `RECORD NO. 0184 /
NQ · LONG · JUL 29 2026 / PRIVATE` across the top. Four sections: `CONTEXT / DECISION /
EXECUTION / LESSON`. The lesson in larger editorial type "because it matters more than the
result." Replay reads **RUN IT BACK** and darkens future candles, revealing the trade a
moment at a time.

**Calendar — "The Contact Sheet."** A sheet of film negatives. Each day a dark square: date
cornered, R or P&L centre, trade count bottom, plus a mark for whether the review was
completed. Winning days get a soft white glow; losing days stay darker with thin outlined
borders; **rule-breaking days get diagonal scan lines.** Selecting a day enlarges it to the
side. Month title large and partially cropped behind the grid.

**Analytics — "The Telemetry Room."** A few giant numbers with tiny labels
(`+18.4R  58.4%  1.84  87`). Thin monochrome charts on the scan-line background — fine white
lines, translucent gray areas, small technical annotations, crosshair on hover, monospaced
values. Sections titled `PERFORMANCE / TIME`, `/ SETUP`, `/ BEHAVIOR`, `/ SESSION`. **The
strongest insight rendered as a large written statement.**

**Playbook — "The Field Manual."** Each setup a large black-and-white file cover:
`SETUP 01 / OPENING RANGE BREAKOUT / 42 OBSERVATIONS / +0.58R EXPECTANCY`, with faint chart
fragments and oversized cropped numbers behind. Opening one gives numbered sections:
`01 / CONDITIONS · 02 / CONFIRMATION · 03 / ENTRY MODEL · 04 / INVALIDATION · 05 / EXIT PLAN
· 06 / RECORDED EXAMPLES`. Personal and community examples visually separated.

**Daily Review — "The Debrief."** Slower, more vertical space. Each question introduced by a
large faded number. Writing area like an editorial journal page, not a form field. Trade
thumbnails as small film frames alongside. Ends with the chosen focus as a large statement
and an archival stamp: `DAILY RECORD CLOSED / 21:42 ET`.

**Weekly / Monthly — "The Retrospective."** `WEEK 31` or `JULY 2026` as enormous background
typography. Charts compact, lessons weighted heavier. Patterns as an intelligence report
(`PATTERN 01 …`). Final commitment shown like a signed operating order.

**Rules — "The Operating Protocol."** Title: **PROTOCOL**. Numbered directives
(`01  MAXIMUM DAILY LOSS  $1,000`). Thick white dividers on important rules. **Approaching a
limit raises visual tension — stronger scan lines, brighter border, warning label.
Explicitly no flashing colours.** Signed commitment at the bottom.

**Goals — "The Mission Board."** `MISSION 03 / COMPLETE 20 DAILY REVIEWS / 13 / 20`. Thin
progress rails across the page, stamped dates on completions. **Behavioural goals prominent,
profit targets visually secondary.**

**Import — "The Ingestion Bay."** Dark frame, corner brackets, animated scanning line.
`AWAITING TRADE FILE / CSV · BROKER EXPORT · FILLS`. Rows decode in one by one. Ends:
`14 FILLS DETECTED / 6 TRADES RECONSTRUCTED / READY FOR REVIEW`.

**Community Home — "The Room."** `THE ROOM IS LIVE / 126 MEMBERS PRESENT`. Feed centre,
stats and Discord activity in a narrow right rail. Posts as shared journal extracts.
**Interactions are `RESPECT 24` / `DISCUSS 08` / `SAVE`** — not props or arrows.

**Feed — "The Signal Stream."** A faint vertical line down the left connects posts
chronologically; each attaches with its timestamp. Type identifiers: `TRADE RECORD / DAILY
REVIEW / LESSON / QUESTION / MODERATOR NOTE`. Trade posts emphasise the chart, reviews the
reflection, questions get more empty space and larger type.

**Create Post — "The Broadcast Desk."** Private record left, release controls right. Hidden
fields shown as **physically redacted dark bars** (`DOLLAR P&L  █████████`). True preview.
Button reads **RELEASE TO THE ROOM**.

**Standings — "The Honor Board."** Top three in large restrained columns, grayscale avatars
behind oversized `01 02 03`. Title emphasises **PROCESS OVER PROFIT**. Measures: discipline,
review streak, improvement, contribution. **No coins, trophies, flames or podium colours.**

**Group Calendar — "The Operations Schedule."** Events as thin horizontal strips with
category codes: `LIVE / NY OPEN`, `REVIEW / WEEKLY REWIND`, `EDU / SETUP LAB`, `DATA / CPI`.
Right side shows the next event with a countdown: `BEGINS IN 00:24:18`.

**Event Detail — "The Briefing."** Title large left; date, time, host, room and attendance
in a precise technical column right. Agenda, submitted trades, attending members,
discussion, Discord join. When live: **BRIEFING IN PROGRESS**.

**Challenges — "The Campaign Board."** `CAMPAIGN 004 / 10 DAYS OF DISCIPLINE`. Focus is the
collective progress line, not prizes. Completed days as punched marks, missing days empty.

**Rooms — "The Frequency Directory."** `FREQ. 01 / GENERAL`, `FREQ. 02 / NQ TRADERS`, etc.
Active room gets a brighter signal line. Pulsing waveform for live voice.

**Members — "The Registry."** Horizontal rows: grayscale avatar, username, role, instrument,
session, discipline score, status. Exclusive, not competitive.

**Member Profile — "The Trader Dossier."** `DISCIPLINE 92 / REVIEW STREAK 12 /
CONTRIBUTION 328`. **Private statistics are simply absent — never shown as locked boxes.**

**Bookmarks — "The Evidence Locker."** `LOCKER 01 / ORB EXAMPLES`. Reference numbers per item.

**Notifications — "The Activity Tape."** Narrow dark strip from the right. Timestamped tape
records. Unread glow slightly; read fade back.

**Search — "The Command Line."** Full-width overlay, one large centred input,
`SEARCH THE RECORD`. Results grouped: `PRIVATE RECORDS / PLAYBOOK / COMMUNITY / MEMBERS /
EVENTS`. Background blurred and darkened.

**Settings — "The System Console."** Thin left menu of categories. Plain rows.
**Dangerous actions in a clearly separated lower section.**

**Moderator — "The Control Room."** `07 ITEMS REQUIRE REVIEW`. Reported content shown beside
the rule it may violate. Actions as formal decisions: `CLEAR REPORT / ISSUE WARNING / LOCK
RECORD / REMOVE FROM ROOM`. Everything logged with moderator name and timestamp.

**Empty states — "Silence in the Record."** No illustrations. Darkness, scan lines, one
strong statement: `NO TRADES RECORDED / THE RECORD BEGINS WITH THE FIRST HONEST ENTRY.`

**Mobile — "The Pocket Recorder."** Bottom nav: `TODAY · LEDGER · + · ROOM · PROFILE`. The
`+` opens a hard-edged action sheet: LOG TRADE / WRITE REVIEW / SHARE ENTRY / CREATE POST.
Charts edge-to-edge. Tables become stacked transaction records. Scan lines softer so
readability holds.

---

## 5 · ANALYSIS — DATA THAT DOES NOT EXIST YET

This is the real cost of the spec. The pages are the cheap part.

### On a trade
- **Entry time and exit time.** §5 shows `09:42:18 → 09:51:06`. *This is exactly the gap that
  makes today's hold-minutes always zero — the spec fixes a real existing bug.*
- Target price
- **Commissions** — the spec splits Gross → Commissions → Net
- **MFE and MAE in R**
- Entry thesis and exit reason, as fields separate from notes
- **Per-trade visibility**: private / community / selected room
- Tags: `#ORB #VWAP #NYOPEN #DISCIPLINED`

### Review ratings
Plan followed (yes/partially/no), entry quality 1–5, exit quality 1–5, emotional control
1–5, emotion chips (calm/FOMO/hesitant/revenge/confident), mistake chips (early exit/
oversized/chased entry/moved stop), final lesson.

### Derived scores with no source
Discipline (87), consistency, review streak (12 days), contribution (328), week score
(82/100), "patterns detected" prose. **Discipline requires rule evaluation to exist first —
and the `rules` and `rule_evaluations` tables already exist, which helps a lot.**
"Improvement" is a delta, so it needs history rather than a current value.

### Sequential record numbers
`NO. 0184` is used as an identity across Ledger, Trade Detail and Notifications. Today's
trade ids are `Date.now().random` strings. A stable per-user display sequence has to be
derived or stored.

### Flags the views need
Calendar needs per-day **review-completed** and **rule-broken**. Ledger needs per-row
**rule-violation** and **shared** markers.

### New tables
goals · events + RSVPs · challenges · rooms · reviews (daily/weekly/monthly) · playbook
setups · tags · bookmarks · drafts · notifications · imports

Plus onboarding-captured profile fields (primary instruments, primary session, experience
level, time zone) and the risk plan (max daily loss, risk per trade, max trades per day,
stop after N losses, max contracts).

### Naming conflict — resolve before Playbook or Analytics
The spec says **SETUP**, with names like Opening Range Breakout, VWAP Reclaim, Reversal,
Failed Breakout. The built log modal says **MODEL**, with ICT names: OTE, CISD, FVG, Silver
Bullet, Turtle Soup, 2022 Model, Unicorn, Judas Swing. Playbook and Analytics both key off
this field.

### Standings conflict
§20 says explicitly not to rank on raw profit. The Community Standings shipped in July rank
on `gross_total`, because that is what `aggGroupStats` returns. Reranking waits on discipline
existing.

---

## 6 · ANALYSIS — SUGGESTED ORDER

1. **Decide the shell** (SPA vs shared shell). Everything downstream depends on it.
2. **Resolve SETUP vs MODEL**, and which navigation governs.
3. **Extend the trade schema** — times, commissions, target, MFE/MAE, thesis, exit reason,
   visibility, tags. Cheap now, expensive after pages are built on the old shape.
4. **Retire green/red** across the five shipped pages. Self-contained, and it makes
   everything new consistent from the start.
5. **Shell + Today + Ledger.** Proves the architecture on one new page and one port.
6. **Reviews + rule evaluation → discipline score.** Unlocks Today's discipline figure,
   Calendar's marks, Standings' ranking and Goals.
7. Port Calendar and Analytics into the shell.
8. Playbook, Rules, Goals.
9. Community: Home, Feed, Standings, Create Post, Post Detail.
10. Events, Group Calendar, Challenges, Rooms, Members, Profiles.
11. Settings, Notifications, Bookmarks, Search.
12. Moderator tooling.
13. Import.

Steps 3 and 4 are worth doing before any new page. Both get more expensive the longer
pages accumulate on the old shape.
