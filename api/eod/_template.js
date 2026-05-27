// Server-side HTML template for the EOD PnL share card (Session 20i).
// Produces a complete, self-contained HTML document Puppeteer can load and
// screenshot.  Mirrors the client-side _eodRenderPersonalCard /
// _eodRenderGroupCard structure in index-6_22.html but does NOT depend on
// the SPA — every helper, every CSS rule, every SVG icon lives here.
//
// Why a server-side template at all: client-side dom-to-image (modern-
// screenshot, html-to-image) rasterizes via SVG foreignObject → drawImage,
// which doesn't honor @font-face inside SVG style.  Cross-origin Google
// Fonts stylesheets are unreadable from JS so the libs silently fall back
// to system fonts in the PNG.  Puppeteer renders in a real Chromium with
// real font loading — no rasterization tricks — so Instrument Serif,
// Geist, and Geist Mono come through correctly in the captured screenshot.

// ── CSS variable palette (mirrors :root in index-6_22.html L37-L64) ────
const ROOT_CSS = `
:root {
  --n-bg:           #0a0a0a;
  --n-surface:      #121212;
  --n-surface-2:    #181818;
  --n-surface-3:    #1f1f1f;
  --n-border:       rgba(255,255,255,0.06);
  --n-border-2:     rgba(255,255,255,0.10);
  --n-border-3:     rgba(255,255,255,0.18);
  --n-text:         #f5f5f5;
  --n-text-2:       #e8e7e2;
  --n-text-3:       #dbdad5;
  --n-text-4:       #d6d5d0;
  --n-accent-cool:  #6ea8ff;
  --n-cool:         #6ea8ff;
  --n-gold:         #f5d77c;
  --n-profit:       #5fb389;
  --n-loss:         #c95f5f;
  --n-font-display: 'Instrument Serif', Georgia, serif;
  --n-font-sans:    'Geist', system-ui, sans-serif;
  --n-font-mono:    'Geist Mono', ui-monospace, monospace;
}
* { box-sizing: border-box; }
html, body {
  margin: 0; padding: 0;
  background: var(--n-bg);
  color: var(--n-text);
  font-family: var(--n-font-sans);
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}
`;

// ── EOD card CSS (mirrors index-6_22.html L30880-L31326) ───────────────
// Capture-time tweaks already baked in: action row hidden, head right-
// padding zeroed.  Cents class renamed inline-friendly because the page
// is built outside the SPA's full stylesheet.
const CARD_CSS = `
.eod-card {
  position: relative;
  background: var(--n-surface);
  border: 0.5px solid rgba(245,215,124,0.18);
  border-radius: 16px;
  padding: 24px 26px 18px;
  display: flex; flex-direction: column; gap: 18px;
  font-family: var(--n-font-sans);
  color: var(--n-text);
  overflow: hidden;
  width: 960px;
}
.eod-card > * { position: relative; z-index: 1; }

/* Avatar finishes (mirrors .av.* L96-L106) */
.av {
  border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  font-family: var(--n-font-mono); font-weight: 600; letter-spacing: 0.02em;
  position: relative; overflow: hidden; flex-shrink: 0;
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.4), inset 0 -1.5px 0 rgba(0,0,0,0.28);
}
.av.chrome   { background: linear-gradient(135deg,#ededed 0%,#9a9a9a 50%,#ededed 100%); color: #1a1a1a; }
.av.gold     { background: linear-gradient(135deg,#f5d77c 0%,#9a7530 50%,#f5d77c 100%); color: #2a1f0a; }
.av.rosegold { background: linear-gradient(135deg,#f0c4b0 0%,#b07868 50%,#f0c4b0 100%); color: #2a1812; }
.av.gunmetal { background: linear-gradient(135deg,#5e646c 0%,#252930 50%,#5e646c 100%); color: #f5f5f5; }
.av.sapphire { background: linear-gradient(135deg,#6a8fd0 0%,#2a4a8a 50%,#6a8fd0 100%); color: #f0f5ff; }
.av.emerald  { background: linear-gradient(135deg,#6ab488 0%,#2a6a4a 50%,#6ab488 100%); color: #f0fff5; }
.av.amethyst { background: linear-gradient(135deg,#a07acc 0%,#5a3a8a 50%,#a07acc 100%); color: #f5f0ff; }
.av.slate    { background: linear-gradient(135deg,#a0a8b0 0%,#4a525c 50%,#a0a8b0 100%); color: #0f1418; }

/* (1) Header */
.ev2-head {
  display: flex; align-items: center; gap: 24px;
  /* Capture-mode behavior — close button isn't in the captured DOM so
     the right-padding lane is dropped (mirrors .is-capturing rule). */
  padding-right: 0;
}
.ev2-av {
  flex-shrink: 0;
  width: 44px; height: 44px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  font-family: var(--n-font-mono); font-size: 13px;
  letter-spacing: 0.04em; color: #1a1408;
  background: linear-gradient(135deg, #f5d77c 0%, #c95f5f 100%);
  box-shadow: 0 4px 14px rgba(245,215,124,0.18);
}
.ev2-head-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
.ev2-handle {
  font-family: var(--n-font-display); font-style: italic;
  font-size: 22px; line-height: 1.1; letter-spacing: -0.01em;
  color: var(--n-text);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.ev2-subtitle {
  font-family: var(--n-font-mono); font-size: 9.5px; letter-spacing: 0.16em;
  text-transform: uppercase; color: var(--n-text-3);
}
.ev2-head-meta {
  margin-left: auto; text-align: right;
  display: flex; flex-direction: column; gap: 2px; flex-shrink: 0;
}
.ev2-head-date {
  font-family: var(--n-font-mono); font-size: 10px; letter-spacing: 0.14em;
  text-transform: uppercase; color: var(--n-text-2);
  white-space: nowrap;
}
.ev2-pulse {
  flex-shrink: 0;
  width: 10px; height: 10px; border-radius: 50%;
  background: var(--n-gold);
  box-shadow: 0 0 0 4px rgba(245,215,124,0.10), 0 0 14px rgba(245,215,124,0.55);
  align-self: center;
}

/* (2) Body */
.ev2-body {
  display: grid;
  grid-template-columns: 1fr 1px 1fr;
  gap: 22px;
  padding-top: 6px;
}
.ev2-divider {
  background: linear-gradient(180deg,
    transparent 0%,
    rgba(255,255,255,0.06) 15%,
    rgba(255,255,255,0.06) 85%,
    transparent 100%);
}

/* (3) LEFT — label + hero + stat strip */
.ev2-left { display: flex; flex-direction: column; gap: 14px; }
.ev2-pnl-label {
  font-family: var(--n-font-mono); font-size: 10px; letter-spacing: 0.16em;
  text-transform: uppercase; color: var(--n-text-3);
}
.ev2-hero {
  display: flex; align-items: baseline; gap: 14px;
  flex-wrap: nowrap; white-space: nowrap;
  font-family: var(--n-font-display); font-style: italic;
  font-size: 68px; line-height: 1; letter-spacing: -0.02em;
}
.ev2-hero .ev2-pnl-num {
  display: inline-block; white-space: nowrap; flex-shrink: 0;
}
.ev2-hero.pos  { color: var(--n-profit); }
.ev2-hero.neg  { color: var(--n-loss); }
.ev2-hero.zero { color: var(--n-text-2); }
.eod-pnl-cents {
  font-size: 0.42em; opacity: 0.55; font-style: italic; letter-spacing: -0.01em;
}

.ev2-stats {
  display: grid; grid-template-columns: 1fr 1fr 1fr;
  gap: 6px;
  padding: 14px 0 4px;
  border-top: 1px solid var(--n-border);
}
.ev2-stat { display: flex; flex-direction: column; align-items: flex-start; gap: 5px; }
.ev2-stat .lbl {
  font-family: var(--n-font-mono); font-size: 8.5px; letter-spacing: 0.18em;
  text-transform: uppercase; color: var(--n-text-3);
}
.ev2-stat .val {
  font-family: var(--n-font-display); font-style: italic;
  font-size: 22px; line-height: 1; color: var(--n-text); letter-spacing: -0.01em;
}
.ev2-stat .val.pos { color: var(--n-profit); }
.ev2-stat .val.neg { color: var(--n-loss); }
.ev2-stat .val .unit { font-size: 0.55em; opacity: 0.6; margin-left: 2px; }

/* (4) RIGHT — trophy header + rows */
.ev2-right { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.ev2-right-head {
  display: flex; align-items: center; gap: 8px;
  font-family: var(--n-font-mono); font-size: 10px; letter-spacing: 0.16em;
  text-transform: uppercase; color: var(--n-gold);
}
.ev2-right-head svg {
  width: 14px; height: 14px; stroke: currentColor; stroke-width: 1.6;
  fill: none; stroke-linecap: round; stroke-linejoin: round;
}

/* Personal trades */
.ev2-trades { display: flex; flex-direction: column; gap: 6px; }
.ev2-trade {
  display: grid;
  grid-template-columns: 42px minmax(40px,auto) auto auto 1fr;
  align-items: center; gap: 8px;
  padding: 8px 10px; border-radius: 6px;
  border: 1px solid transparent;
  background: var(--n-surface-2);
}
.ev2-trade.best.pos {
  background: linear-gradient(180deg, rgba(95,179,137,0.10) 0%, rgba(95,179,137,0.04) 100%);
  border-color: rgba(95,179,137,0.28);
}
.ev2-trade.best.neg,
.ev2-trade.best.zero {
  background: var(--n-surface);
  border-color: rgba(255,255,255,0.10);
}
.ev2-trade .ev2-time {
  font-family: var(--n-font-mono); font-size: 10px; letter-spacing: 0.04em;
  color: var(--n-text-3);
}
.ev2-trade .ev2-sym {
  font-family: var(--n-font-mono); font-size: 11.5px; color: var(--n-text);
  font-weight: 500; letter-spacing: 0.02em;
}
.ev2-trade .ev2-side {
  display: inline-block; white-space: nowrap;
  font-family: var(--n-font-mono); font-size: 8px; letter-spacing: 0.18em;
  text-transform: uppercase; padding: 2px 6px; border-radius: 3px;
  flex-shrink: 0;
}
.ev2-trade .ev2-side.long {
  background: rgba(95,179,137,0.10); color: var(--n-profit);
  border: 1px solid rgba(95,179,137,0.20);
}
.ev2-trade .ev2-side.short {
  background: rgba(201,95,95,0.10); color: var(--n-loss);
  border: 1px solid rgba(201,95,95,0.20);
}
.ev2-trade .ev2-rr {
  font-family: var(--n-font-mono); font-size: 9.5px; letter-spacing: 0.02em;
}
.ev2-trade .ev2-rr.pos { color: var(--n-accent-cool); }
.ev2-trade .ev2-rr.neg { color: var(--n-loss); }
.ev2-trade .ev2-rr.empty { color: var(--n-text-4); }
.ev2-trade .ev2-trade-pnl {
  font-family: var(--n-font-display); font-style: italic;
  font-size: 15px; line-height: 1; text-align: right; letter-spacing: -0.01em;
}
.ev2-trade.best .ev2-trade-pnl { font-size: 17px; }
.ev2-trade .ev2-trade-pnl.pos { color: var(--n-profit); }
.ev2-trade .ev2-trade-pnl.neg { color: var(--n-loss); }

/* Group leaderboard */
.ev2-lb { display: flex; flex-direction: column; gap: 6px; }
.ev2-lb-row {
  display: grid;
  grid-template-columns: 24px 28px minmax(0,1fr) 100px;
  align-items: center; gap: 10px;
  padding: 8px 14px 8px 10px; border-radius: 6px;
  border: 1px solid transparent; background: var(--n-surface-2);
  overflow: hidden;
}
.ev2-lb-row.rank-1 {
  background: linear-gradient(180deg, rgba(245,215,124,0.12) 0%, rgba(245,215,124,0.04) 100%);
  border-color: rgba(245,215,124,0.32);
}
.ev2-lb-row .ev2-lb-rank {
  font-family: var(--n-font-display); font-style: italic;
  font-size: 20px; line-height: 1; text-align: center; letter-spacing: -0.02em;
  color: var(--n-text-2);
}
.ev2-lb-row.rank-1 .ev2-lb-rank {
  color: var(--n-gold); text-shadow: 0 0 10px rgba(245,215,124,0.25);
}
.ev2-lb-row .av { flex-shrink: 0; }
.ev2-lb-handle {
  font-family: var(--n-font-mono); font-size: 11px; color: var(--n-text);
  letter-spacing: 0.01em;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  min-width: 0;
}
.ev2-lb-handle.is-me { color: var(--n-accent-cool); }
.ev2-lb-pnl {
  font-family: var(--n-font-display); font-style: italic;
  font-size: 15px; line-height: 1; text-align: right; letter-spacing: -0.01em;
}
.ev2-lb-pnl.pos { color: var(--n-profit); }
.ev2-lb-pnl.neg { color: var(--n-loss); }

/* (5) Footer */
.ev2-foot {
  display: flex; align-items: center; gap: 10px;
  padding-top: 12px; margin-top: 2px;
  border-top: 1px solid var(--n-border);
}
.ev2-foot-brand {
  display: flex; align-items: center; gap: 8px;
  font-family: var(--n-font-display); font-style: italic;
  font-size: 14px; color: var(--n-text-2); letter-spacing: -0.01em;
}
.ev2-foot-brand svg {
  width: 14px; height: 14px; stroke: var(--n-text-2); stroke-width: 1.6;
  fill: none; stroke-linecap: round; stroke-linejoin: round;
}
.ev2-wm {
  font-family: var(--n-font-mono); font-size: 9px; letter-spacing: 0.14em;
  text-transform: uppercase; color: var(--n-text-4);
}
.ev2-foot-meta {
  margin-left: auto;
  font-family: var(--n-font-mono); font-size: 9px; letter-spacing: 0.14em;
  text-transform: uppercase; color: var(--n-text-3);
  white-space: nowrap;
}

/* Empty-state placeholder (shared between personal + group flavors) */
.ev2-empty {
  padding: 18px 12px;
  border: 0.5px dashed rgba(255,255,255,0.14);
  border-radius: 6px;
  text-align: center;
}
.ev2-empty .ev2-empty-title {
  font-family: var(--n-font-display); font-style: italic;
  font-size: 18px; color: var(--n-text-2); line-height: 1.2;
}
.ev2-empty .ev2-empty-hint {
  margin-top: 6px;
  font-family: var(--n-font-mono); font-size: 9px;
  letter-spacing: 0.14em; text-transform: uppercase;
  color: var(--n-text-3);
}
`;

// SVG icons — same shapes as _EOD_SVG.trophy / _EOD_SVG.rewind in client.
const SVG_TROPHY = '<svg viewBox="0 0 24 24" width="14" height="14" style="width:14px;height:14px;display:inline-block;vertical-align:middle;stroke:currentColor;stroke-width:1.6;fill:none;stroke-linecap:round;stroke-linejoin:round"><path d="M7 4h10v4a5 5 0 0 1-10 0z"/><path d="M5 4h2v3a3 3 0 0 1-3 3 1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z"/><path d="M19 4h-2v3a3 3 0 0 0 3 3 1 1 0 0 0 1-1V5a1 1 0 0 0-1-1z"/><line x1="12" y1="13" x2="12" y2="18"/><polyline points="8 21 16 21 14 18 10 18 8 21"/></svg>';
const SVG_REWIND = '<svg viewBox="0 0 24 24" width="14" height="14" style="width:14px;height:14px;display:inline-block;vertical-align:middle;stroke:#a1a1a1;stroke-width:1.6;fill:none;stroke-linecap:round;stroke-linejoin:round"><path d="M20 11A8 8 0 1 0 4 12"/><polyline points="4 6 4 12 10 12"/><circle cx="12" cy="12" r="1.5" fill="#a1a1a1" stroke="none"/></svg>';

// ── Helpers (server-side mirrors of the SPA helpers in index-6_22.html) ─
function safeText(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
  });
}
function safeUrl(s) {
  return String(s == null ? '' : s).replace(/["'<>]/g, '');
}

// Mirrors _eodMoney + _eodMoneyHtml.  Cents wrapped in .eod-pnl-cents so
// the CSS dims them like the live card.
function moneyHtml(v) {
  const num = Number(v) || 0;
  const sign = num > 0 ? '+' : num < 0 ? '−' : '';
  const abs = Math.abs(num);
  const int = Math.floor(abs).toLocaleString('en-US');
  const cents = (abs - Math.floor(abs)).toFixed(2).slice(1); // ".50"
  return sign + '$' + int + '<span class="eod-pnl-cents">' + cents + '</span>';
}

// Mirrors _eodDateLabel.  Uses UTC math so server + client agree on the
// label even if the runtime TZ differs from the user.
function dateLabel(etDateStr) {
  if (!etDateStr) return '';
  const d = new Date(etDateStr + 'T12:00:00Z');
  if (isNaN(d)) return etDateStr;
  // Build a fixed "Wed · May 27" string without locale ambiguity.
  const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return days[d.getUTCDay()] + ' · ' + months[d.getUTCMonth()] + ' ' + d.getUTCDate();
}

// Mirrors _eodTimeOf — but the client already formats t.created_at into a
// local-zone HH:MM string before stashing it, so we just accept whatever
// label the client sends and fall back to '—'.
function timeOf(t) {
  if (t && typeof t.time === 'string' && t.time) return t.time;
  if (t && typeof t.created_at === 'string') {
    try {
      const d = new Date(t.created_at);
      if (!isNaN(d)) {
        return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: false });
      }
    } catch (_) {}
  }
  return '—';
}

function initialsFor(handle) {
  const clean = String(handle || '').replace(/[^a-zA-Z0-9]/g, '');
  return clean ? clean.slice(0, 2).toUpperCase() : '??';
}

const FINISHES = ['chrome','gold','rosegold','gunmetal','sapphire','emerald','amethyst','slate'];
const FINISH_ALIASES = { pink:'rosegold', blue:'sapphire', purple:'amethyst', green:'emerald', orange:'gold', red:'rosegold', yellow:'gold', black:'gunmetal' };
function normalizeFinish(k) {
  if (!k) return 'chrome';
  if (FINISHES.indexOf(k) >= 0) return k;
  if (FINISH_ALIASES[k]) return FINISH_ALIASES[k];
  return 'chrome';
}

// Mirrors renderUserAvatar({ size: 'sm' }) — used for group leaderboard rows.
function avatarHtml(p) {
  p = p || {};
  if (p.avatar_image_url) {
    return '<div class="av" style="width:28px;height:28px;background-image:url(\'' + safeUrl(p.avatar_image_url) + '\');background-size:cover;background-position:center"></div>';
  }
  const finish = normalizeFinish(p.avatar_finish || p.color || p.avatar_color || 'sapphire');
  let init = p.avatar_initials || p.initials;
  if (!init || !String(init).trim()) {
    const name = p.username || p.name || p.display_name || '';
    const clean = String(name).replace(/[^a-zA-Z]/g, '');
    init = clean ? clean.slice(0, 2).toUpperCase() : '??';
  }
  return '<div class="av ' + finish + '" style="width:28px;height:28px;font-size:10px">' + safeText(init) + '</div>';
}

// ── Card body builders ────────────────────────────────────────────────
function renderPersonal(data) {
  const isEmpty = !data.tradeCount || !data.trades || !data.trades.length;
  const total = Number(data.totalPnl) || 0;
  const heroTone = isEmpty ? 'zero' : (total > 0 ? 'pos' : total < 0 ? 'neg' : 'zero');
  const heroPnlCol = total > 0 ? '#5fb389' : total < 0 ? '#c95f5f' : '#a1a1a1';

  const avgR = Number(data.avgR) || 0;
  const avgRTone = isEmpty ? '' : (avgR > 0 ? 'pos' : avgR < 0 ? 'neg' : '');
  const avgRTxt = (!isEmpty && data.avgRCount)
    ? ((avgR > 0 ? '+' : '') + avgR.toFixed(1) + 'R')
    : '—';

  const sortedByPnl = isEmpty ? [] : data.trades.slice().sort(function (a, b) {
    return (Number(b.pnl) || 0) - (Number(a.pnl) || 0);
  });
  const shown = sortedByPnl.slice(0, 3);

  let tradeRowsHtml;
  if (isEmpty) {
    tradeRowsHtml =
        '<div class="ev2-empty">'
      +   '<div class="ev2-empty-title">No trades yet today</div>'
      +   '<div class="ev2-empty-hint">Log a trade and it&rsquo;ll show up here live</div>'
      + '</div>';
  } else {
    tradeRowsHtml = shown.map(function (t, idx) {
      const pnl = Number(t.pnl) || 0;
      const tone = pnl > 0 ? 'pos' : pnl < 0 ? 'neg' : 'zero';
      const dir = String(t.type || '').toLowerCase() === 'short' ? 'short' : 'long';
      const dirLabel = dir === 'short' ? '↘ Short' : '↗ Long';
      const hasStop = t.stop != null && t.stop !== '';
      const rrNum = Number(t.rr);
      let rrHtml = '<span class="ev2-rr empty">—</span>';
      if (hasStop && isFinite(rrNum) && rrNum !== 0) {
        const rrSign = pnl < 0 ? -1 : 1;
        const rrSigned = rrSign * Math.abs(rrNum);
        const rrCls = rrSigned < 0 ? 'neg' : 'pos';
        rrHtml = '<span class="ev2-rr ' + rrCls + '">' + (rrSigned > 0 ? '+' : '') + rrSigned.toFixed(1) + 'R</span>';
      }
      const bestCls = idx === 0 ? ' best' : '';
      return '<div class="ev2-trade' + bestCls + ' ' + tone + '">'
        + '<span class="ev2-time">' + safeText(timeOf(t)) + '</span>'
        + '<span class="ev2-sym">'  + safeText(t.sym || '—') + '</span>'
        + '<span class="ev2-side ' + dir + '">' + dirLabel + '</span>'
        + rrHtml
        + '<span class="ev2-trade-pnl ' + tone + '">' + moneyHtml(pnl) + '</span>'
        + '</div>';
    }).join('');
  }

  const handle = data.handle || 'you';
  const initials = data.initials || initialsFor(handle);
  const subtitle = 'Trading journal · Today';

  return '<div class="eod-card eod-card-personal">'
    + '<div class="ev2-head">'
    +   '<div class="ev2-av">' + safeText(initials) + '</div>'
    +   '<div class="ev2-head-text">'
    +     '<span class="ev2-handle">@' + safeText(handle) + '</span>'
    +     '<span class="ev2-subtitle">' + subtitle + '</span>'
    +   '</div>'
    +   '<div class="ev2-head-meta">'
    +     '<span class="ev2-head-date">' + safeText(dateLabel(data.etDate)) + '</span>'
    +   '</div>'
    + '</div>'
    + '<div class="ev2-body">'
    +   '<div class="ev2-left">'
    +     '<span class="ev2-pnl-label">Today&rsquo;s P&amp;L</span>'
    +     '<div class="ev2-hero ' + heroTone + '" style="color:' + heroPnlCol + '">'
    +       '<span class="ev2-pnl-num">' + moneyHtml(total) + '</span>'
    +     '</div>'
    +     '<div class="ev2-stats">'
    +       '<div class="ev2-stat"><span class="lbl">Trades</span><span class="val">' + (data.tradeCount || 0) + '</span></div>'
    +       '<div class="ev2-stat"><span class="lbl">Win Rate</span><span class="val">' + (data.winRate || 0) + '<span class="unit">%</span></span></div>'
    +       '<div class="ev2-stat"><span class="lbl">Avg R</span><span class="val ' + avgRTone + '">' + safeText(avgRTxt) + '</span></div>'
    +     '</div>'
    +   '</div>'
    +   '<div class="ev2-divider"></div>'
    +   '<div class="ev2-right">'
    +     '<div class="ev2-right-head">' + SVG_TROPHY + '<span>Top trades</span></div>'
    +     '<div class="ev2-trades">' + tradeRowsHtml + '</div>'
    +   '</div>'
    + '</div>'
    + '<div class="ev2-foot">'
    +   '<div class="ev2-foot-brand">' + SVG_REWIND + '<span>Rewind</span></div>'
    +   '<span class="ev2-wm">traderewindjournal.com</span>'
    +   '<span class="ev2-foot-meta">PnL Card &middot; ' + safeText(dateLabel(data.etDate)) + '</span>'
    + '</div>'
    + '</div>';
}

function renderGroup(data) {
  const community = data.community || {};
  const traders = Array.isArray(data.traders) ? data.traders : [];
  const isEmpty = !data.tradeCount || !traders.length;
  const total = Number(data.totalPnl) || 0;
  const heroTone = isEmpty ? 'zero' : (total > 0 ? 'pos' : total < 0 ? 'neg' : 'zero');
  const heroPnlCol = total > 0 ? '#5fb389' : total < 0 ? '#c95f5f' : '#a1a1a1';

  const avgPer = Number(data.avgPerTrade) || 0;
  const avgTone = isEmpty ? '' : (avgPer > 0 ? 'pos' : avgPer < 0 ? 'neg' : '');

  let lbRowsHtml;
  if (isEmpty) {
    lbRowsHtml =
        '<div class="ev2-empty">'
      +   '<div class="ev2-empty-title">No traders yet</div>'
      +   '<div class="ev2-empty-hint">Be the first to share a trade today</div>'
      + '</div>';
  } else {
    lbRowsHtml = traders.map(function (tr, i) {
      const rank = i + 1;
      const avHtml = avatarHtml({
        avatar_finish: tr.avatar_finish,
        avatar_image_url: tr.avatar_image_url,
        avatar_initials: tr.initials || tr.avatar_initials,
        username: tr.username
      });
      const pnlNum = Number(tr.pnl) || 0;
      const pnlTone = pnlNum > 0 ? 'pos' : pnlNum < 0 ? 'neg' : 'zero';
      const meCls = tr.isMe ? ' is-me' : '';
      return '<div class="ev2-lb-row rank-' + rank + '">'
        + '<span class="ev2-lb-rank">' + rank + '</span>'
        + avHtml
        + '<span class="ev2-lb-handle' + meCls + '">@' + safeText(tr.username || 'trader') + '</span>'
        + '<span class="ev2-lb-pnl ' + pnlTone + '">' + moneyHtml(pnlNum) + '</span>'
        + '</div>';
    }).join('');
  }

  const memberCount = (community.memberCount != null)
    ? community.memberCount
    : (Array.isArray(community.members) ? community.members.length : traders.length);

  return '<div class="eod-card eod-card-group">'
    + '<div class="ev2-head">'
    +   '<span class="ev2-pulse"></span>'
    +   '<div class="ev2-head-text">'
    +     '<span class="ev2-handle">' + safeText(community.name || 'Community') + '</span>'
    +     '<span class="ev2-subtitle">Trading community &middot; Today</span>'
    +   '</div>'
    +   '<div class="ev2-head-meta">'
    +     '<span class="ev2-head-date">' + safeText(dateLabel(data.etDate)) + '</span>'
    +   '</div>'
    + '</div>'
    + '<div class="ev2-body">'
    +   '<div class="ev2-left">'
    +     '<span class="ev2-pnl-label">Collective P&amp;L</span>'
    +     '<div class="ev2-hero ' + heroTone + '" style="color:' + heroPnlCol + '">'
    +       '<span class="ev2-pnl-num">' + moneyHtml(total) + '</span>'
    +     '</div>'
    +     '<div class="ev2-stats">'
    +       '<div class="ev2-stat"><span class="lbl">Trades</span><span class="val">' + (data.tradeCount || 0) + '</span></div>'
    +       '<div class="ev2-stat"><span class="lbl">Group WR</span><span class="val">' + (data.winRate || 0) + '<span class="unit">%</span></span></div>'
    +       '<div class="ev2-stat"><span class="lbl">Avg / trade</span><span class="val ' + avgTone + '">' + moneyHtml(avgPer) + '</span></div>'
    +     '</div>'
    +   '</div>'
    +   '<div class="ev2-divider"></div>'
    +   '<div class="ev2-right">'
    +     '<div class="ev2-right-head">' + SVG_TROPHY + '<span>Top traders</span></div>'
    +     '<div class="ev2-lb">' + lbRowsHtml + '</div>'
    +   '</div>'
    + '</div>'
    + '<div class="ev2-foot">'
    +   '<div class="ev2-foot-brand">' + SVG_REWIND + '<span>Rewind</span></div>'
    +   '<span class="ev2-wm">traderewindjournal.com</span>'
    +   '<span class="ev2-foot-meta">' + memberCount + ' member' + (memberCount === 1 ? '' : 's') + ' &middot; ' + (data.tradeCount || 0) + ' trade' + ((data.tradeCount || 0) === 1 ? '' : 's') + '</span>'
    + '</div>'
    + '</div>';
}

// ── Page wrapper ──────────────────────────────────────────────────────
// Google Fonts <link> loads the three families.  A tiny boot script
// resolves a Promise once document.fonts.ready settles AND sets the
// data-fonts-ready attribute so Puppeteer can wait on it deterministically.
//
// The .stage wrapper centres the card horizontally on a #0a0a0a backdrop
// so the screenshot of the body crops cleanly without baking dead pixels
// around the card.

function buildHtml(payload) {
  const type = payload && payload.type;
  const data = (payload && payload.data) || {};
  let bodyHtml;
  if (type === 'group') {
    bodyHtml = renderGroup(data);
  } else {
    bodyHtml = renderPersonal(data);
  }
  return '<!doctype html>'
    + '<html lang="en"><head>'
    + '<meta charset="utf-8">'
    + '<title>Rewind PnL Card</title>'
    // Preconnect first → keep paint blocked on the stylesheet → load the
    // family blob via a single CSS file that includes italic + the
    // weights we actually use (display 400 italic, sans 400/500/600,
    // mono 400/500).
    + '<link rel="preconnect" href="https://fonts.googleapis.com">'
    + '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>'
    + '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500&family=Instrument+Serif:ital@0;1&display=swap">'
    + '<style>' + ROOT_CSS + CARD_CSS
    + '.stage { padding: 30px; display: inline-block; background: var(--n-bg); }'
    + '</style>'
    + '</head><body>'
    + '<div class="stage">' + bodyHtml + '</div>'
    + '<script>'
    + '(function(){'
    +   'function ready(){document.documentElement.setAttribute("data-fonts-ready","1");}'
    +   'if(document.fonts&&document.fonts.ready){'
    +     'document.fonts.ready.then(ready, ready);'
    +   '}else{setTimeout(ready, 250);}'
    + '})();'
    + '</script>'
    + '</body></html>';
}

export { buildHtml, renderPersonal, renderGroup };
export default buildHtml;
