// POST /api/eod/render-card
// Session 20j — direct canvas rendering for the EOD PnL share card.
//
// Replaces the Puppeteer + @sparticuz/chromium pipeline.  @napi-rs/canvas
// is a Node-native rasterizer (Skia underneath) that loads TTF fonts
// directly via GlobalFonts.registerFromPath() — no headless browser, no
// foreignObject rasterization tricks, no font-loading races.  Whatever
// we draw with ctx.fillText() uses the registered TTF, deterministically.
//
// Trade-off: HTML/CSS layout becomes manual canvas geometry (every x/y
// calculated by hand).  For a fixed-aspect 1200x900 share card with two
// templates (personal + group), this is a clean win — layout doesn't
// reflow per render, only the data values do.
//
// Body shape (unchanged from the Puppeteer endpoint — client contract
// stays the same):
//   { type: 'personal' | 'group',
//     data: { etDate, totalPnl, tradeCount, winRate, ...
//             personal-only: avgR, avgRCount, trades, handle, initials
//             group-only:    avgPerTrade, community, traders } }
//
// Response: image/png buffer.  Auth: Supabase Bearer.

import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { authUser } from '../_lib/auth.js';

// ── Font registration (module-load, once per Lambda warm start) ────────
const __dirname = dirname(fileURLToPath(import.meta.url));
const FONTS_DIR = join(__dirname, 'fonts');

// Register every TTF under a stable family name we can reference from
// canvas font shorthand.  @napi-rs/canvas doesn't auto-resolve italic
// variants the way browsers do — we register each face independently
// and switch by family name in the draw code.
function _register(file, family) {
  try {
    const buf = readFileSync(join(FONTS_DIR, file));
    GlobalFonts.register(buf, family);
    return true;
  } catch (e) {
    console.error('[eod render] font register failed:', file, e && e.message);
    return false;
  }
}
const _fontsLoaded = {
  serifItalic:   _register('InstrumentSerif-Italic.ttf',  'InstrumentSerifItalic'),
  serifRegular:  _register('InstrumentSerif-Regular.ttf', 'InstrumentSerif'),
  geist:         _register('Geist-Regular.ttf',           'Geist'),
  geistMedium:   _register('Geist-Medium.ttf',            'GeistMedium'),
  mono:          _register('GeistMono-Regular.ttf',       'GeistMono'),
  monoMedium:    _register('GeistMono-Medium.ttf',        'GeistMonoMedium'),
};
console.log('[eod render] fonts loaded at module init:', JSON.stringify(_fontsLoaded));

// ── Color palette (mirrors --n-* CSS variables in index-6_22.html) ─────
const C = {
  bg:         '#0a0a0a',
  surface:    '#121212',
  surface2:   '#181818',
  surface3:   '#1f1f1f',
  text:       '#f5f5f5',
  text2:      '#e8e7e2',
  text3:      '#dbdad5',
  text4:      '#a1a1a1',
  border:     'rgba(255,255,255,0.06)',
  border2:    'rgba(255,255,255,0.10)',
  profit:     '#5fb389',
  loss:       '#c95f5f',
  gold:       '#f5d77c',
  accentCool: '#6ea8ff',
};

// Avatar gradients — match .av.<finish> in the SPA's CSS.  Top-left to
// bottom-right linear, three stops.
const AVATAR_FINISHES = {
  chrome:   ['#ededed', '#9a9a9a', '#ededed'],
  gold:     ['#f5d77c', '#9a7530', '#f5d77c'],
  rosegold: ['#f0c4b0', '#b07868', '#f0c4b0'],
  gunmetal: ['#5e646c', '#252930', '#5e646c'],
  sapphire: ['#6a8fd0', '#2a4a8a', '#6a8fd0'],
  emerald:  ['#6ab488', '#2a6a4a', '#6ab488'],
  amethyst: ['#a07acc', '#5a3a8a', '#a07acc'],
  slate:    ['#a0a8b0', '#4a525c', '#a0a8b0'],
};
const AVATAR_FG = {
  chrome:'#1a1a1a', gold:'#2a1f0a', rosegold:'#2a1812', gunmetal:'#f5f5f5',
  sapphire:'#f0f5ff', emerald:'#f0fff5', amethyst:'#f5f0ff', slate:'#0f1418',
};
const FINISH_ALIASES = { pink:'rosegold', blue:'sapphire', purple:'amethyst', green:'emerald', orange:'gold', red:'rosegold', yellow:'gold', black:'gunmetal' };
function normFinish(k) {
  if (!k) return 'sapphire';
  if (AVATAR_FINISHES[k]) return k;
  if (FINISH_ALIASES[k]) return FINISH_ALIASES[k];
  return 'sapphire';
}

// ── Formatters (mirror SPA helpers) ────────────────────────────────────
function fmtMoneyParts(v) {
  const num = Number(v) || 0;
  // Unicode minus (U+2212) for negatives — matches the SPA's _eodMoney.
  const sign = num > 0 ? '+' : num < 0 ? '−' : '';
  const abs  = Math.abs(num);
  const int  = Math.floor(abs).toLocaleString('en-US');
  const cents = (abs - Math.floor(abs)).toFixed(2).slice(1);
  return { sign, int, cents, tone: num > 0 ? 'pos' : num < 0 ? 'neg' : 'zero' };
}
function moneyColor(v) {
  const n = Number(v) || 0;
  return n > 0 ? C.profit : n < 0 ? C.loss : C.text4;
}
// Points — gross price-move total, NOT a dollar value.  Signed, 1
// decimal, no $.  Colored blue (informational metric) when ≥0, rose
// when negative — distinguishes it from the sage/rose dollar stats.
function fmtPoints(v) {
  const n = Number(v) || 0;
  const sign = n > 0 ? '+' : n < 0 ? '−' : '';
  // 1 decimal, thousands-grouped integer part (e.g. "+1,250.5").
  const parts = Math.abs(n).toFixed(1).split('.');
  const grouped = Number(parts[0]).toLocaleString('en-US');
  return sign + grouped + '.' + parts[1];
}
function pointsColor(v) {
  return (Number(v) || 0) < 0 ? C.loss : C.accentCool;
}
function fmtDate(etDate) {
  if (!etDate) return '';
  const d = new Date(etDate + 'T12:00:00Z');
  if (isNaN(d)) return etDate;
  const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return days[d.getUTCDay()] + ' · ' + months[d.getUTCMonth()] + ' ' + d.getUTCDate();
}
function initialsFor(name) {
  const clean = String(name || '').replace(/[^a-zA-Z0-9]/g, '');
  return clean ? clean.slice(0, 2).toUpperCase() : '??';
}

// ── Canvas helpers ─────────────────────────────────────────────────────
function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}
function fillRoundRect(ctx, x, y, w, h, r, fill) {
  roundRectPath(ctx, x, y, w, h, r);
  ctx.fillStyle = fill;
  ctx.fill();
}
function strokeRoundRect(ctx, x, y, w, h, r, stroke, lineWidth = 1) {
  roundRectPath(ctx, x, y, w, h, r);
  ctx.lineWidth = lineWidth;
  ctx.strokeStyle = stroke;
  ctx.stroke();
}
function drawAvatar(ctx, cx, cy, radius, finish, initials, fontSize) {
  finish = normFinish(finish);
  const [c0, c1, c2] = AVATAR_FINISHES[finish];
  // 135deg linear gradient — top-left to bottom-right inside the circle.
  const gx0 = cx - radius * 0.7, gy0 = cy - radius * 0.7;
  const gx1 = cx + radius * 0.7, gy1 = cy + radius * 0.7;
  const grad = ctx.createLinearGradient(gx0, gy0, gx1, gy1);
  grad.addColorStop(0,    c0);
  grad.addColorStop(0.5,  c1);
  grad.addColorStop(1,    c2);
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fillStyle = grad;
  ctx.fill();
  // Inner highlight rim — matches the inset shadow on .av in the SPA.
  ctx.beginPath();
  ctx.arc(cx, cy, radius - 0.5, 0, Math.PI * 2);
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.stroke();
  // Initials.
  ctx.fillStyle = AVATAR_FG[finish];
  ctx.font = `600 ${fontSize}px "GeistMonoMedium"`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(initials || '??').slice(0, 2), cx, cy + 1);
}

// Measure a money value (sign + int + cents) at a given hero size.
// Cents render at 42% of base size like the SPA's .eod-pnl-cents rule.
function measureMoneyHero(ctx, parts, size, family) {
  ctx.font = `${size}px "${family}"`;
  const big = ctx.measureText(parts.sign + '$' + parts.int).width;
  ctx.font = `${Math.round(size * 0.42)}px "${family}"`;
  const small = ctx.measureText(parts.cents).width;
  return big + small + Math.round(size * 0.04); // tiny gap before cents
}
// Draw a money hero left-aligned at (x, baselineY).  Returns the right edge x.
function drawMoneyHero(ctx, parts, x, baselineY, size, family, color) {
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.fillStyle = color;
  ctx.font = `${size}px "${family}"`;
  const big = parts.sign + '$' + parts.int;
  ctx.fillText(big, x, baselineY);
  const bigW = ctx.measureText(big).width;
  const centsSize = Math.round(size * 0.42);
  ctx.globalAlpha = 0.55;
  ctx.font = `${centsSize}px "${family}"`;
  // Raise cents slightly so they sit at the cap-line — drawn cents'
  // baseline lands at ~75% of the big number's baseline.
  const centsBaseline = baselineY - Math.round(size * 0.20);
  ctx.fillText(parts.cents, x + bigW + Math.round(size * 0.04), centsBaseline);
  ctx.globalAlpha = 1;
  return x + bigW + Math.round(size * 0.04) + ctx.measureText(parts.cents).width;
}
// Draw mono caps label with letter-spacing approximation.  Canvas 2D
// doesn't have a native letterSpacing prop in @napi-rs/canvas, so we
// draw character-by-character with a calculated step.
function drawMonoCaps(ctx, text, x, y, size, color, tracking = 0.16) {
  ctx.font = `${size}px "GeistMono"`;
  ctx.fillStyle = color;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  const upper = String(text).toUpperCase();
  const trackPx = Math.round(size * tracking);
  let cursor = x;
  for (const ch of upper) {
    ctx.fillText(ch, cursor, y);
    cursor += ctx.measureText(ch).width + trackPx;
  }
  // Compensate for the trailing track on the last char so callers know
  // where the visible text ends.
  return cursor - trackPx;
}
function monoCapsWidth(ctx, text, size, tracking = 0.16) {
  ctx.font = `${size}px "GeistMono"`;
  const upper = String(text).toUpperCase();
  const trackPx = Math.round(size * tracking);
  let w = 0;
  for (const ch of upper) w += ctx.measureText(ch).width + trackPx;
  return w - trackPx;
}

// ── Card drawing ────────────────────────────────────────────────────────
// 1200x900 canvas, outer pad 50, card 1100x800.  65/35 horizontal split
// with a 30px gap; LEFT carries the hero PnL + identity + date+brand
// stack, RIGHT carries the top-traders/trades rail + stat strip.

function drawCard(payload) {
  // Session 20k — canvas tightened from 1200×900 to 1200×700 (≈12:7).
  // The old 4:3 frame left ~30% dead space below the stats row + rank-3
  // leaderboard row.  Footer is bottom-anchored (cardY + cardH - 30) so
  // reducing H pulls the brand stack + meta line up automatically; body
  // bodyH derives from innerH so the leaderboard rail naturally shrinks
  // to match.  Verified locally that the 3 leaderboard rows still fit
  // with breathing room and the hero PnL doesn't clip.
  const W = 1200, H = 700;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  const type = payload.type;
  const data = payload.data || {};
  const isGroup = type === 'group';
  const total  = Number(data.totalPnl) || 0;
  const moneyParts = fmtMoneyParts(total);
  const heroColor  = moneyColor(total);

  // (1) Flat background — pure #0a0a0a edge-to-edge.  Session 20o
  // stripped the radial glow AND the gold perimeter hairline; the hero
  // number now carries the card purely through scale, no decoration.
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, H);

  // Card spans the whole canvas — no outer pad.  Internal content
  // padding (INNER) keeps content off the edge.
  const cardX = 0, cardY = 0;
  const cardW = W, cardH = H;
  const INNER = 40;
  const x0 = cardX + INNER, y0 = cardY + INNER;
  const innerW = cardW - 2 * INNER, innerH = cardH - 2 * INNER;

  // (4) Header band — identity + date.
  const headerY = y0;
  const headerH = 64;
  if (isGroup) {
    // Pulsing gold dot in place of the avatar circle.
    const dotCx = x0 + 10, dotCy = headerY + headerH / 2;
    // Faint outer glow
    const ringGrad = ctx.createRadialGradient(dotCx, dotCy, 4, dotCx, dotCy, 22);
    ringGrad.addColorStop(0, 'rgba(245,215,124,0.55)');
    ringGrad.addColorStop(1, 'rgba(245,215,124,0)');
    ctx.beginPath(); ctx.arc(dotCx, dotCy, 22, 0, Math.PI * 2); ctx.fillStyle = ringGrad; ctx.fill();
    // Solid gold dot
    ctx.beginPath(); ctx.arc(dotCx, dotCy, 7, 0, Math.PI * 2); ctx.fillStyle = C.gold; ctx.fill();
  } else {
    // Personal — avatar with handle initials, sapphire→sage gradient.
    drawAvatar(ctx, x0 + 22, headerY + headerH / 2, 22, 'gold', data.initials || initialsFor(data.handle), 14);
  }

  const headerTextX = x0 + 56;
  // Name / handle (Instrument Serif italic, 30px)
  ctx.font = '30px "InstrumentSerifItalic"';
  ctx.fillStyle = C.text;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  const handleText = isGroup
    ? String((data.community && data.community.name) || 'Community')
    : '@' + String(data.handle || 'you');
  ctx.fillText(handleText, headerTextX, headerY + 26);

  // Subtitle (Geist Mono caps, 11px)
  const subtitle = isGroup ? 'Trading community · Today' : 'Trading journal · Today';
  drawMonoCaps(ctx, subtitle, headerTextX, headerY + 52, 11, C.text3, 0.18);

  // Date label on the right.
  const dateStr = fmtDate(data.etDate);
  const dateW = monoCapsWidth(ctx, dateStr, 13, 0.16);
  drawMonoCaps(ctx, dateStr, x0 + innerW - dateW, headerY + 30, 13, C.text2, 0.16);

  // (5) Body — 65/35 split with a 30px gap.
  const bodyY = headerY + headerH + 28;
  const bodyH = innerH - headerH - 28 - 60; // 60 reserved for the footer
  const leftW  = Math.round(innerW * 0.62);
  const gapW   = 30;
  const rightW = innerW - leftW - gapW;
  const rightX = x0 + leftW + gapW;

  // (5a) LEFT — "Today's P&L" or "Collective P&L" label + huge hero PnL.
  // Session 20l — the hero is the flex.  Bumped to 190px (was 128) so it
  // dominates the left column.  Vertical rhythm is now anchored at three
  // fixed points instead of stacking with fixed gaps: label near the top
  // of the body, hero in the upper-middle, stat strip anchored to the
  // lower portion (a fixed offset above the footer hairline) so the
  // enlarged hero + the comfortable gap below it collapse the old dead
  // band without leaving a new one.
  const leftLabel = isGroup ? 'Collective P&L' : "Today's P&L";
  const labelY = bodyY + 18;
  drawMonoCaps(ctx, leftLabel, x0, labelY, 13, C.text3, 0.18);

  // Hero PnL — Instrument Serif italic at 275px (Session 20p bumped it
  // ~17% from 235).  It's THE dominant element — the first thing the eye
  // hits.  Dynamic shrink keeps long values (e.g. "+$25,640.00") inside
  // the left column: step down 4px at a time until the measured width
  // fits leftW, floor 84px so even an extreme value stays legible-big.
  let heroSize = 275;
  let heroW = measureMoneyHero(ctx, moneyParts, heroSize, 'InstrumentSerifItalic');
  while (heroW > leftW - 6 && heroSize > 84) {
    heroSize -= 4;
    heroW = measureMoneyHero(ctx, moneyParts, heroSize, 'InstrumentSerifItalic');
  }
  // Hero baseline sits in the upper-middle — ~46px below the label, then
  // down by the cap height of the (possibly shrunk) face.
  const heroBaseline = labelY + 46 + heroSize * 0.74;
  drawMoneyHero(ctx, moneyParts, x0, heroBaseline, heroSize, 'InstrumentSerifItalic', heroColor);

  // Stat strip — anchored to the lower portion of the left column,
  // independent of the hero size, so the rhythm is stable whether the
  // hero is full 190px or shrunk for a long value.  Values land ~56px
  // above the footer hairline; labels 36px above the values.
  const footerHairlineY = cardY + cardH - 30 - 14;
  const stripY = footerHairlineY - 74;

  // Stats array first — needed to measure the group width before we can
  // center it + size the divider (Session 20p).
  let stats;
  if (isGroup) {
    const avgPer = Number(data.avgPerTrade) || 0;
    const avgParts = fmtMoneyParts(avgPer);
    stats = [
      { lbl: 'Trades',    val: String(data.tradeCount || 0),                    color: C.text },
      { lbl: 'Group WR',  val: String(data.winRate || 0) + '%',                  color: C.text },
      { lbl: 'Avg / trade', val: avgParts.sign + '$' + avgParts.int + '.' + avgParts.cents.slice(1), color: moneyColor(avgPer) },
      { lbl: 'Total Points', val: fmtPoints(data.totalPoints), color: pointsColor(data.totalPoints) },
    ];
  } else {
    const avgR = Number(data.avgR) || 0;
    const avgRTxt = data.avgRCount
      ? ((avgR > 0 ? '+' : avgR < 0 ? '−' : '') + Math.abs(avgR).toFixed(1) + 'R')
      : '—';
    stats = [
      { lbl: 'Trades',   val: String(data.tradeCount || 0),                  color: C.text },
      { lbl: 'Win Rate', val: String(data.winRate || 0) + '%',                color: C.text },
      { lbl: 'Avg R',    val: avgRTxt,                                        color: avgR > 0 ? C.profit : avgR < 0 ? C.loss : C.text },
      { lbl: 'Total Points', val: fmtPoints(data.totalPoints), color: pointsColor(data.totalPoints) },
    ];
  }

  // Session 20p — center the 4-stat group horizontally in the left
  // column.  Each cell sizes to its widest line (label vs value), a
  // fixed gap separates them, the group is centered with equal L/R
  // padding, and the divider spans exactly the group width (not the
  // full column edge-to-edge).
  const STAT_GAP = 40;
  const STAT_LABEL = 10, STAT_VALUE = 32;
  const cellW = stats.map(function (s) {
    const lw = monoCapsWidth(ctx, s.lbl, STAT_LABEL, 0.18);
    ctx.font = STAT_VALUE + 'px "InstrumentSerifItalic"';
    const vw = ctx.measureText(s.val).width;
    return Math.max(lw, vw);
  });
  const statsGroupW = cellW.reduce(function (a, b) { return a + b; }, 0) + STAT_GAP * (stats.length - 1);
  const statsX = x0 + Math.max(0, (leftW - statsGroupW) / 2);
  // Divider — spans the centered group width only.
  ctx.fillStyle = C.border;
  ctx.fillRect(statsX, stripY - 20, Math.min(statsGroupW, leftW), 1);
  // Cells — label + value, left-aligned within each content-sized cell.
  let statCursor = statsX;
  stats.forEach(function (s, i) {
    drawMonoCaps(ctx, s.lbl, statCursor, stripY, STAT_LABEL, C.text3, 0.18);
    ctx.font = STAT_VALUE + 'px "InstrumentSerifItalic"';
    ctx.fillStyle = s.color;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(s.val, statCursor, stripY + 36);
    statCursor += cellW[i] + STAT_GAP;
  });

  // (5b) RIGHT — top traders / top trades rail.
  // Subtle bg tint for the rail (slightly elevated surface).
  fillRoundRect(ctx, rightX, bodyY, rightW, bodyH, 0, 'rgba(255,255,255,0.025)');
  strokeRoundRect(ctx, rightX, bodyY, rightW, bodyH, 0, 'rgba(255,255,255,0.05)', 1);

  // Right header — trophy + "TOP TRADERS/TRADES".
  const rightHeaderY = bodyY + 28;
  drawTrophy(ctx, rightX + 22, rightHeaderY - 8, 14, C.gold);
  drawMonoCaps(ctx, isGroup ? 'Top traders' : 'Top trades', rightX + 44, rightHeaderY, 12, C.gold, 0.18);

  // Rows — 3 max.  For group: rank + avatar + handle + pnl.  For
  // personal: time + sym + side chip + RR + pnl.
  if (isGroup) {
    const traders = (data.traders || []).slice(0, 3);
    const rowH = 64;
    const rowsStartY = rightHeaderY + 24;
    if (!traders.length) {
      drawEmptyState(ctx, rightX + 16, rowsStartY, rightW - 32, 'No traders yet', 'Be the first to share a trade today');
    } else {
      traders.forEach((tr, i) => {
        const ry = rowsStartY + i * (rowH + 8);
        const isRank1 = i === 0;
        // Row chrome — rank-1 gets a soft gold tint + gold hairline.
        if (isRank1) {
          fillRoundRect(ctx, rightX + 10, ry, rightW - 20, rowH, 0, 'rgba(245,215,124,0.10)');
          strokeRoundRect(ctx, rightX + 10, ry, rightW - 20, rowH, 0, 'rgba(245,215,124,0.32)', 1);
        } else {
          fillRoundRect(ctx, rightX + 10, ry, rightW - 20, rowH, 0, C.surface2);
        }
        // Rank number (Instrument Serif italic, gold on rank 1).
        ctx.font = '26px "InstrumentSerifItalic"';
        ctx.fillStyle = isRank1 ? C.gold : C.text2;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(i + 1), rightX + 30, ry + rowH / 2);
        // Avatar.
        const finish = normFinish(tr.avatar_finish || tr.color);
        const init   = (tr.initials || tr.avatar_initials || initialsFor(tr.username));
        drawAvatar(ctx, rightX + 64, ry + rowH / 2, 18, finish, init, 11);
        // PnL — measured FIRST so the handle can be clipped against its
        // actual left edge (the handle font grew in 20n, so a static
        // reserve would over- or under-shoot).
        const pnlParts = fmtMoneyParts(tr.pnl);
        // Session 20p — pnl bumped 20px → 24px Instrument Serif italic so
        // it reads confident, paired with the 20px mono handle rather
        // than overshadowed by it.  Measured here so the handle can clip
        // against its (now wider) left edge.
        ctx.font = '24px "InstrumentSerifItalic"';
        const pnlText = pnlParts.sign + '$' + pnlParts.int;
        const pnlW = ctx.measureText(pnlText).width;

        // Handle — Session 20n bumped 14px → 20px GeistMonoMedium so the
        // names are the prominent element in each row (visibly larger
        // than the 26px condensed-serif rank).  Clipped against the pnl's
        // left edge with a 16px gutter; ellipsis on overflow.
        const handleX = rightX + 92;
        const pnlLeftEdge = rightX + rightW - 22 - pnlW;
        const maxHandleW = pnlLeftEdge - 16 - handleX;
        ctx.font = '20px "GeistMonoMedium"';
        ctx.fillStyle = tr.isMe ? C.accentCool : C.text;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        let drawnHandle = '@' + String(tr.username || 'trader');
        if (ctx.measureText(drawnHandle).width > maxHandleW) {
          while (drawnHandle.length > 4 && ctx.measureText(drawnHandle + '…').width > maxHandleW) {
            drawnHandle = drawnHandle.slice(0, -1);
          }
          drawnHandle += '…';
        }
        ctx.fillText(drawnHandle, handleX, ry + rowH / 2);

        // PnL (measured above) — 24px, right-aligned, always shown in
        // full (handle truncates, never the pnl).
        ctx.fillStyle = moneyColor(tr.pnl);
        ctx.font = '24px "InstrumentSerifItalic"';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.fillText(pnlText, rightX + rightW - 22, ry + rowH / 2);
      });
    }
  } else {
    // Personal — sort by signed pnl desc; top 3.
    const trades = (data.trades || []).slice().sort((a, b) => (Number(b.pnl) || 0) - (Number(a.pnl) || 0)).slice(0, 3);
    const rowH = 64;
    const rowsStartY = rightHeaderY + 24;
    if (!trades.length) {
      drawEmptyState(ctx, rightX + 16, rowsStartY, rightW - 32, 'No trades yet today', "Log a trade and it'll show up here live");
    } else {
      trades.forEach((t, i) => {
        const ry = rowsStartY + i * (rowH + 8);
        const isBest = i === 0;
        const pnlVal = Number(t.pnl) || 0;
        const bestPos = isBest && pnlVal > 0;
        if (bestPos) {
          fillRoundRect(ctx, rightX + 10, ry, rightW - 20, rowH, 0, 'rgba(95,179,137,0.10)');
          strokeRoundRect(ctx, rightX + 10, ry, rightW - 20, rowH, 0, 'rgba(95,179,137,0.28)', 1);
        } else if (isBest) {
          fillRoundRect(ctx, rightX + 10, ry, rightW - 20, rowH, 0, C.surface);
          strokeRoundRect(ctx, rightX + 10, ry, rightW - 20, rowH, 0, 'rgba(255,255,255,0.10)', 1);
        } else {
          fillRoundRect(ctx, rightX + 10, ry, rightW - 20, rowH, 0, C.surface2);
        }
        // Time.
        ctx.font = '11px "GeistMono"';
        ctx.fillStyle = C.text3;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(t.time || '—'), rightX + 22, ry + rowH / 2);
        // Symbol.
        ctx.font = '13px "GeistMonoMedium"';
        ctx.fillStyle = C.text;
        ctx.fillText(String(t.sym || '—'), rightX + 76, ry + rowH / 2);
        // Side chip.
        const dir = String(t.type || '').toLowerCase() === 'short' ? 'short' : 'long';
        drawSideChip(ctx, rightX + 124, ry + rowH / 2 - 11, dir);
        // PnL.
        const pnlParts = fmtMoneyParts(pnlVal);
        ctx.font = (isBest ? '22px' : '18px') + ' "InstrumentSerifItalic"';
        ctx.fillStyle = moneyColor(pnlVal);
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.fillText(pnlParts.sign + '$' + pnlParts.int, rightX + rightW - 22, ry + rowH / 2);
      });
    }
  }

  // (6) Footer band — Rewind brand + watermark left, meta right.
  const footerY = cardY + cardH - 30;
  ctx.fillStyle = C.border;
  ctx.fillRect(x0, footerY - 14, innerW, 1);
  // Rewind brand mark (Instrument Serif italic 20px).
  ctx.font = '20px "InstrumentSerifItalic"';
  ctx.fillStyle = C.text2;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('Rewind', x0, footerY);
  const brandW = ctx.measureText('Rewind').width;
  // Watermark.
  drawMonoCaps(ctx, 'traderewindjournal.com', x0 + brandW + 14, footerY - 4, 10, C.text4, 0.16);
  // Right-edge meta.
  let metaStr;
  if (isGroup) {
    const memberCount = (data.community && data.community.memberCount != null)
      ? data.community.memberCount
      : ((data.community && Array.isArray(data.community.members)) ? data.community.members.length : (data.traders || []).length);
    const tradeCount = data.tradeCount || 0;
    metaStr = memberCount + ' member' + (memberCount === 1 ? '' : 's') + ' · ' + tradeCount + ' trade' + (tradeCount === 1 ? '' : 's');
  } else {
    metaStr = 'PnL Card · ' + fmtDate(data.etDate);
  }
  const metaW = monoCapsWidth(ctx, metaStr, 10, 0.16);
  drawMonoCaps(ctx, metaStr, x0 + innerW - metaW, footerY - 4, 10, C.text3, 0.16);

  return canvas.toBuffer('image/png');
}

// ── Small drawables ────────────────────────────────────────────────────
function drawTrophy(ctx, x, y, size, color) {
  // Simple trophy glyph — bowl + handles + stem + base.  Stroked.
  ctx.save();
  ctx.translate(x, y);
  const s = size / 14;
  ctx.lineWidth = 1.6 * s;
  ctx.strokeStyle = color;
  ctx.fillStyle = 'none';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // Bowl
  ctx.beginPath();
  ctx.moveTo(2 * s, 0);
  ctx.lineTo(12 * s, 0);
  ctx.lineTo(12 * s, 4 * s);
  ctx.bezierCurveTo(12 * s, 7 * s, 9 * s, 9 * s, 7 * s, 9 * s);
  ctx.bezierCurveTo(5 * s, 9 * s, 2 * s, 7 * s, 2 * s, 4 * s);
  ctx.closePath();
  ctx.stroke();
  // Handles
  ctx.beginPath();
  ctx.moveTo(2 * s, 1 * s);
  ctx.lineTo(0, 1 * s);
  ctx.lineTo(0, 3.5 * s);
  ctx.bezierCurveTo(0, 5 * s, 1 * s, 5.5 * s, 2 * s, 5.5 * s);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(12 * s, 1 * s);
  ctx.lineTo(14 * s, 1 * s);
  ctx.lineTo(14 * s, 3.5 * s);
  ctx.bezierCurveTo(14 * s, 5 * s, 13 * s, 5.5 * s, 12 * s, 5.5 * s);
  ctx.stroke();
  // Stem + base
  ctx.beginPath();
  ctx.moveTo(7 * s, 9 * s); ctx.lineTo(7 * s, 12 * s);
  ctx.moveTo(3 * s, 14 * s); ctx.lineTo(11 * s, 14 * s);
  ctx.lineTo(9 * s, 12 * s); ctx.lineTo(5 * s, 12 * s);
  ctx.closePath();
  ctx.stroke();
  ctx.restore();
}

function drawSideChip(ctx, x, y, dir) {
  const isShort = dir === 'short';
  const bg = isShort ? 'rgba(201,95,95,0.10)' : 'rgba(95,179,137,0.10)';
  const bd = isShort ? 'rgba(201,95,95,0.20)' : 'rgba(95,179,137,0.20)';
  const fg = isShort ? C.loss : C.profit;
  const label = isShort ? '↘ SHORT' : '↗ LONG';
  ctx.font = '9px "GeistMonoMedium"';
  const trackPx = Math.round(9 * 0.18);
  let w = 0;
  for (const ch of label) w += ctx.measureText(ch).width + trackPx;
  w = w - trackPx + 14;
  const h = 22;
  fillRoundRect(ctx, x, y, w, h, 0, bg);
  strokeRoundRect(ctx, x, y, w, h, 0, bd, 1);
  ctx.fillStyle = fg;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  let cursor = x + 7;
  for (const ch of label) {
    ctx.fillText(ch, cursor, y + h / 2);
    cursor += ctx.measureText(ch).width + trackPx;
  }
}

function drawEmptyState(ctx, x, y, w, title, hint) {
  const h = 96;
  // Dashed border via stroked rounded rect with line dash.
  ctx.save();
  ctx.setLineDash([6, 6]);
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(255,255,255,0.14)';
  roundRectPath(ctx, x, y, w, h, 0);
  ctx.stroke();
  ctx.restore();
  // Title — Instrument Serif italic 18px.
  ctx.font = '20px "InstrumentSerifItalic"';
  ctx.fillStyle = C.text2;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(title, x + w / 2, y + 40);
  // Hint — Geist Mono caps 10px.
  const hw = monoCapsWidth(ctx, hint, 10, 0.16);
  drawMonoCaps(ctx, hint, x + (w - hw) / 2, y + 64, 10, C.text3, 0.16);
}

// ── Request handler ────────────────────────────────────────────────────
function _rid() { return Math.random().toString(36).slice(2, 8); }

export default async function handler(req, res) {
  const rid = _rid();
  const tEntry = Date.now();
  res.setHeader('X-Eod-Render-Id', rid);
  const ua = String(req.headers['user-agent'] || '').slice(0, 120);
  console.log('[eod render rid=' + rid + '] inbound',
    '| method:', req.method,
    '| ts:', new Date(tEntry).toISOString(),
    '| ua:', ua);

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed', allowed: ['POST'] });
    return;
  }
  const user = await authUser(req, res);
  if (!user) {
    console.log('[eod render rid=' + rid + '] auth failed — 401 written');
    return;
  }
  console.log('[eod render rid=' + rid + '] auth ok | user:', user.id);

  let payload = req.body;
  if (typeof payload === 'string') {
    try { payload = JSON.parse(payload); } catch (_) { payload = null; }
  }
  if (!payload || typeof payload !== 'object') {
    res.status(400).json({ error: 'invalid payload' });
    return;
  }
  if (payload.type !== 'personal' && payload.type !== 'group') {
    res.status(400).json({ error: 'type must be personal|group' });
    return;
  }
  if (!payload.data || typeof payload.data !== 'object') {
    res.status(400).json({ error: 'data required' });
    return;
  }
  console.log('[eod render rid=' + rid + '] payload ok',
    '| type:', payload.type,
    '| etDate:', payload.data.etDate,
    '| totalPnl:', payload.data.totalPnl,
    '| tradeCount:', payload.data.tradeCount);

  let png;
  try {
    const t0 = Date.now();
    png = drawCard(payload);
    const t1 = Date.now();
    console.log('[eod render rid=' + rid + '] ok',
      '| type:', payload.type,
      '| render-ms:', t1 - t0,
      '| bytes:', png.length,
      '| fonts:', JSON.stringify(_fontsLoaded));
    // Header summary the client toasts so the user can confirm in
    // one tap that fonts + canvas path served the response.
    res.setHeader('X-Eod-Fonts',
      'si=' + (_fontsLoaded.serifItalic ? 'y' : 'n') +
      ',gm=' + (_fontsLoaded.mono ? 'y' : 'n') +
      ',ms=' + (t1 - t0));
  } catch (e) {
    console.error('[eod render rid=' + rid + '] FAILED:', e && (e.stack || e.message));
    res.status(500).json({ error: 'render failed', detail: e && e.message, rid });
    return;
  }

  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'no-store');
  const dateStr = (payload.data && payload.data.etDate) || '';
  res.setHeader('Content-Disposition',
    'inline; filename="rewind-pnl-' + (dateStr || 'card') + '.png"');
  res.status(200).send(png);
}

export const config = {
  maxDuration: 15,
};

// Exported for the dev-only test driver (_test-render.mjs).  No
// behavioral impact on the deployed handler — Vercel ignores named
// exports from API routes.
export { drawCard };
