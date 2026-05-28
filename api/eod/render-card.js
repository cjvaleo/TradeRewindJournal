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

// ── Card drawing (Session 20q full redesign) ───────────────────────────
// 16:9 landscape, 1600×900 (logical 800×450 @ 2× DPR — every spec px is
// doubled here).  Flat #0a0a0a, sharp corners, no glow / outline.  Two
// purpose-built layouts:
//   personal  — top strip + centered hero + sub-stats (no leaderboard)
//   community — top strip + centered group hero + sub-stats + bottom
//               strip with a 3-column Top Traders grid

// Centered money hero — measures (big + dimmed cents) and draws centered
// on centerX.  Returns total width.
function drawMoneyCentered(ctx, parts, centerX, baselineY, size, family, color) {
  const big = parts.sign + '$' + parts.int;
  ctx.font = size + 'px "' + family + '"';
  const bigW = ctx.measureText(big).width;
  const centsSize = Math.round(size * 0.42);
  ctx.font = centsSize + 'px "' + family + '"';
  const centsW = ctx.measureText(parts.cents).width;
  const gap = Math.round(size * 0.04);
  const totalW = bigW + gap + centsW;
  const startX = centerX - totalW / 2;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = color;
  ctx.font = size + 'px "' + family + '"';
  ctx.fillText(big, startX, baselineY);
  ctx.globalAlpha = 0.55;
  ctx.font = centsSize + 'px "' + family + '"';
  ctx.fillText(parts.cents, startX + bigW + gap, baselineY - Math.round(size * 0.20));
  ctx.globalAlpha = 1;
  return totalW;
}
function measureMoneyCenteredW(ctx, parts, size, family) {
  const big = parts.sign + '$' + parts.int;
  ctx.font = size + 'px "' + family + '"';
  const bigW = ctx.measureText(big).width;
  const centsSize = Math.round(size * 0.42);
  ctx.font = centsSize + 'px "' + family + '"';
  const centsW = ctx.measureText(parts.cents).width;
  return bigW + Math.round(size * 0.04) + centsW;
}
// Draw a sequence of colored mono-caps tokens as one centered line.
function drawTokensCentered(ctx, tokens, centerX, y, size, ls) {
  const widths = tokens.map(function (t) { return monoCapsWidth(ctx, t.t, size, ls); });
  const total = widths.reduce(function (a, b) { return a + b; }, 0);
  let x = centerX - total / 2;
  tokens.forEach(function (t, i) {
    drawMonoCaps(ctx, t.t, x, y, size, t.c, ls);
    x += widths[i];
  });
}

function drawCard(payload) {
  const W = 1600, H = 900;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // Flat background, edge-to-edge, no glow / outline.
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, H);

  if (payload.type === 'group') {
    drawCommunityCard(ctx, W, H, payload.data || {});
  } else {
    drawPersonalCard(ctx, W, H, payload.data || {});
  }
  return canvas.toBuffer('image/png');
}

// Shared top-left brand mark.  Returns the baseline Y used so callers
// can derive the strip bottom.
function drawBrandMark(ctx, padX, padTop) {
  ctx.font = '44px "InstrumentSerifItalic"';
  ctx.fillStyle = C.gold;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  const brandBaseY = padTop + 34;
  ctx.fillText('Rewind', padX, brandBaseY);
  drawMonoCaps(ctx, 'traderewindjournal.com', padX, brandBaseY + 22, 14, 'rgba(255,255,255,0.30)', 0.20);
  return brandBaseY;
}

function drawPersonalCard(ctx, W, H, data) {
  const padX = 64, padTop = 48;
  const sub = 'rgba(255,255,255,0.55)';
  const sep = 'rgba(255,255,255,0.30)';

  const total = Number(data.totalPnl) || 0;
  const parts = fmtMoneyParts(total);
  const heroCol = moneyColor(total);
  const handle = String(data.handle || 'you');

  // ── Top strip ──
  const brandBaseY = drawBrandMark(ctx, padX, padTop);
  // Right: date + handle, right-aligned.
  const dateStr = fmtDate(data.etDate);
  const dW = monoCapsWidth(ctx, dateStr, 16, 0.18);
  drawMonoCaps(ctx, dateStr, W - padX - dW, padTop + 18, 16, 'rgba(255,255,255,0.45)', 0.18);
  const hStr = '@' + handle;
  const hW = monoCapsWidth(ctx, hStr, 15, 0.16);
  drawMonoCaps(ctx, hStr, W - padX - hW, padTop + 40, 15, 'rgba(255,255,255,0.32)', 0.16);

  const topStripBottom = brandBaseY + 30;

  // ── Centered hero block ──
  let heroSize = 200;
  const maxHeroW = W - 2 * padX - 40;
  while (measureMoneyCenteredW(ctx, parts, heroSize, 'InstrumentSerifItalic') > maxHeroW && heroSize > 110) {
    heroSize -= 4;
  }
  const labelSize = 18, subSize = 20;
  const labelCap = Math.round(labelSize * 0.72);
  const heroCap  = Math.round(heroSize * 0.70);
  const subCap   = Math.round(subSize * 0.72);
  const gLH = 20, gHS = 44;
  const blockH = labelCap + gLH + heroCap + gHS + subCap;
  const blockTop = topStripBottom + (H - topStripBottom - blockH) / 2;
  const centerX = W / 2;

  const labelBase = blockTop + labelCap;
  const lbl = "Today's P&L";
  const lblW = monoCapsWidth(ctx, lbl, labelSize, 0.24);
  drawMonoCaps(ctx, lbl, centerX - lblW / 2, labelBase, labelSize, 'rgba(255,255,255,0.50)', 0.24);

  const heroBase = labelBase + gLH + heroCap;
  drawMoneyCentered(ctx, parts, centerX, heroBase, heroSize, 'InstrumentSerifItalic', heroCol);

  const subBase = heroBase + gHS + subCap;
  const wr = Number(data.winRate) || 0;
  const avgR = Number(data.avgR) || 0;
  const avgRTxt = data.avgRCount
    ? ((avgR > 0 ? '+' : avgR < 0 ? '−' : '') + Math.abs(avgR).toFixed(1) + 'R')
    : '—';
  const tokens = [
    { t: (data.tradeCount || 0) + ' trades', c: sub },
    { t: ' · ', c: sep },
    { t: wr + '%', c: wr > 0 ? C.profit : sub },
    { t: ' win rate', c: sub },
    { t: ' · ', c: sep },
    { t: avgRTxt, c: sub },
    { t: ' avg', c: sub },
  ];
  drawTokensCentered(ctx, tokens, centerX, subBase, subSize, 0.22);
}

function drawCommunityCard(ctx, W, H, data) {
  const padX = 64, padTop = 48, padBottom = 48;
  const sub = 'rgba(255,255,255,0.55)';
  const sep = 'rgba(255,255,255,0.30)';
  const community = data.community || {};

  const total = Number(data.totalPnl) || 0;
  const parts = fmtMoneyParts(total);
  const heroCol = moneyColor(total);

  // ── Top strip ──
  const brandBaseY = drawBrandMark(ctx, padX, padTop);

  // Right: community badge — logo + (name / N members · today), the
  // text block right-aligned to the edge with the logo to its left.
  const name = String(community.name || 'Community');
  const initials = String(community.icon_initials || name.slice(0, 2)).slice(0, 2).toUpperCase();
  const memberCount = (community.memberCount != null)
    ? community.memberCount
    : (Array.isArray(community.members) ? community.members.length : (data.traders || []).length);
  const membersStr = memberCount + ' members · today';

  ctx.font = '30px "InstrumentSerifItalic"';
  const nameW = ctx.measureText(name).width;
  const memW = monoCapsWidth(ctx, membersStr, 14, 0.16);
  const textBlockW = Math.max(nameW, memW);
  const rightEdge = W - padX;
  const logoR = 24, logoGap = 14;
  const logoCx = rightEdge - textBlockW - logoGap - logoR;
  const logoCy = padTop + 24;
  drawAvatar(ctx, logoCx, logoCy, logoR, 'gold', initials, 14);
  ctx.font = '30px "InstrumentSerifItalic"';
  ctx.fillStyle = C.text;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(name, rightEdge, padTop + 20);
  drawMonoCaps(ctx, membersStr, rightEdge - memW, padTop + 40, 14, 'rgba(255,255,255,0.40)', 0.16);

  const topStripBottom = brandBaseY + 30;

  // ── Bottom strip geometry (compute first so the hero centers above) ──
  const traders = (data.traders || []).slice(0, 3);
  const cellH = 120;
  const gridBottom = H - padBottom;
  const gridTop = gridBottom - cellH;
  const headerSize = 16;
  const headerBase = gridTop - 20;
  const dividerY = headerBase - headerSize - 28;

  // ── Centered hero block (between top strip and the divider) ──
  let heroSize = 136;
  const maxHeroW = W - 2 * padX - 40;
  while (measureMoneyCenteredW(ctx, parts, heroSize, 'InstrumentSerifItalic') > maxHeroW && heroSize > 80) {
    heroSize -= 4;
  }
  const labelSize = 16, subSize = 18;
  const labelCap = Math.round(labelSize * 0.72);
  const heroCap  = Math.round(heroSize * 0.70);
  const subCap   = Math.round(subSize * 0.72);
  const gLH = 20, gHS = 28;
  const blockH = labelCap + gLH + heroCap + gHS + subCap;
  const blockTop = topStripBottom + (dividerY - topStripBottom - blockH) / 2;
  const centerX = W / 2;

  const labelBase = blockTop + labelCap;
  const lbl = 'Collective P&L · Today';
  const lblW = monoCapsWidth(ctx, lbl, labelSize, 0.28);
  drawMonoCaps(ctx, lbl, centerX - lblW / 2, labelBase, labelSize, 'rgba(255,255,255,0.50)', 0.28);

  const heroBase = labelBase + gLH + heroCap;
  drawMoneyCentered(ctx, parts, centerX, heroBase, heroSize, 'InstrumentSerifItalic', heroCol);

  const subBase = heroBase + gHS + subCap;
  const wr = Number(data.winRate) || 0;
  const avgPer = Number(data.avgPerTrade) || 0;
  const ap = fmtMoneyParts(avgPer);
  const avgStr = ap.sign + '$' + ap.int + ap.cents;
  const ptsStr = fmtPoints(data.totalPoints);
  const tokens = [
    { t: (data.tradeCount || 0) + ' trades', c: sub },
    { t: ' · ', c: sep },
    { t: wr + '%', c: sub },
    { t: ' group wr', c: sub },
    { t: ' · ', c: sep },
    { t: avgStr, c: moneyColor(avgPer) },
    { t: ' avg', c: sub },
    { t: ' · ', c: sep },
    { t: ptsStr, c: pointsColor(data.totalPoints) },
    { t: ' pts', c: sub },
  ];
  drawTokensCentered(ctx, tokens, centerX, subBase, subSize, 0.22);

  // ── Bottom strip ──
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padX, dividerY + 0.5);
  ctx.lineTo(W - padX, dividerY + 0.5);
  ctx.stroke();

  drawTrophy(ctx, padX, headerBase - 12, 16, 'rgba(245,215,124,0.78)');
  drawMonoCaps(ctx, 'Top traders', padX + 28, headerBase, headerSize, 'rgba(245,215,124,0.78)', 0.24);
  const dateStr = fmtDate(data.etDate);
  const dW = monoCapsWidth(ctx, dateStr, 14, 0.18);
  drawMonoCaps(ctx, dateStr, W - padX - dW, headerBase, 14, 'rgba(255,255,255,0.32)', 0.18);

  // 3-column grid — only render the cells that exist.
  const gap = 20;
  const gridW = W - 2 * padX;
  const colW = (gridW - gap * 2) / 3;
  traders.forEach(function (tr, i) {
    const cx = padX + i * (colW + gap);
    const isRank1 = i === 0;
    if (isRank1) {
      ctx.fillStyle = 'rgba(245,215,124,0.05)';
      ctx.fillRect(cx, gridTop, colW, cellH);
    }
    ctx.lineWidth = 1;
    ctx.strokeStyle = isRank1 ? 'rgba(245,215,124,0.32)' : 'rgba(255,255,255,0.08)';
    ctx.strokeRect(cx + 0.5, gridTop + 0.5, colW - 1, cellH - 1);

    const ix = cx + 24, iy = gridTop + 20;
    const rowCy = iy + 18;
    // Rank.
    ctx.font = '36px "InstrumentSerifItalic"';
    ctx.fillStyle = isRank1 ? C.gold : 'rgba(255,255,255,0.5)';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const rankStr = String(i + 1);
    ctx.fillText(rankStr, ix, rowCy + 1);
    const rankW = ctx.measureText(rankStr).width;
    // Avatar.
    const avCx = ix + rankW + 12 + 18;
    const finish = normFinish(tr.avatar_finish || tr.color);
    const tinit = (tr.initials || tr.avatar_initials || initialsFor(tr.username));
    drawAvatar(ctx, avCx, rowCy, 18, finish, tinit, 14);
    // Handle (ellipsis on overflow).
    const handleX = avCx + 18 + 12;
    ctx.font = '20px "GeistMono"';
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    let hh = '@' + String(tr.username || 'trader');
    const maxHW = (cx + colW - 24) - handleX;
    if (ctx.measureText(hh).width > maxHW) {
      while (hh.length > 4 && ctx.measureText(hh + '…').width > maxHW) hh = hh.slice(0, -1);
      hh += '…';
    }
    ctx.fillText(hh, handleX, rowCy);
    // PnL (bottom row).
    const pp = fmtMoneyParts(tr.pnl);
    ctx.font = '40px "InstrumentSerifItalic"';
    ctx.fillStyle = moneyColor(tr.pnl);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(pp.sign + '$' + pp.int, ix, iy + 36 + 8 + 30);
  });
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
