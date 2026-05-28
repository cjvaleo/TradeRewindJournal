#!/usr/bin/env node
// Local-only test driver for the EOD share-card renderer.  NOT shipped
// to Vercel — purely a dev tool for Session 20i font verification.
//
// Run: node api/eod/_test-render.mjs
// Writes two PNGs to /tmp/ — one personal, one group — using system
// Chrome via puppeteer-core.  Logs font-check results inline so a
// font-loading regression surfaces immediately instead of waiting for
// a visual inspection.

import puppeteer from 'puppeteer-core';
import buildHtml from './_template.js';
import { writeFileSync } from 'node:fs';

const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const samplePersonal = {
  type: 'personal',
  data: {
    etDate: '2026-05-27',
    totalPnl: 1591.80,
    tradeCount: 3,
    winRate: 67,
    avgR: 1.4,
    avgRCount: 3,
    handle: 'cjvaleo',
    initials: 'CJ',
    trades: [
      { id:'t1', sym:'NQ', type:'long',  pnl:  856.50, rr: 2.1, stop: 23000, time: '09:32' },
      { id:'t2', sym:'ES', type:'short', pnl:  420.00, rr: 1.3, stop: 5860,  time: '10:15' },
      { id:'t3', sym:'CL', type:'long',  pnl:  315.30, rr: 1.8, stop: 78.50, time: '11:42' },
    ],
  },
};

const sampleGroup = {
  type: 'group',
  data: {
    etDate: '2026-05-27',
    totalPnl: -213.42,
    tradeCount: 7,
    winRate: 43,
    avgPerTrade: -30.49,
    community: { id:'c1', name:'Trading Ark', memberCount: 128 },
    traders: [
      { user_id:'u1', username:'kingrat',  pnl:  2640.00, isMe: false, avatar_finish:'gold' },
      { user_id:'u2', username:'cjvaleo',  pnl:  -420.50, isMe: true,  avatar_finish:'sapphire' },
      { user_id:'u3', username:'bigshort', pnl: -2432.92, isMe: false, avatar_finish:'rosegold' },
    ],
  },
};

async function render(label, payload, outPath) {
  const html = buildHtml(payload);
  console.log(`\n=== ${label} ===`);
  console.log('html bytes:', html.length);

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    defaultViewport: { width: 1280, height: 1200, deviceScaleFactor: 2 },
  });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 15000 });
    try {
      await page.waitForSelector('html[data-fonts-ready="1"]', { timeout: 6000 });
      console.log('data-fonts-ready: fired');
    } catch {
      console.warn('data-fonts-ready: timed out (6s)');
    }
    const fontReport = await page.evaluate(() => ({
      status: document.fonts.status,
      size: document.fonts.size,
      error: document.documentElement.getAttribute('data-fonts-error'),
      check: {
        isItalic:  document.fonts.check('italic 16px "Instrument Serif"'),
        isRegular: document.fonts.check('16px "Instrument Serif"'),
        geist:     document.fonts.check('500 16px "Geist"'),
        geistMono: document.fonts.check('400 16px "Geist Mono"'),
      },
      families: Array.from(document.fonts).map(f =>
        `${f.family}/${f.style}/${f.weight}:${f.status}`),
      // Width probe — Instrument Serif italic at 100px should be ~15-25%
      // narrower than Georgia italic for the same string.
      probe: (() => {
        const ctx = document.createElement('canvas').getContext('2d');
        ctx.font = 'italic 100px "Instrument Serif", Georgia, serif';
        const w1 = ctx.measureText('+$1,591.80').width;
        ctx.font = 'italic 100px Georgia, serif';
        const w2 = ctx.measureText('+$1,591.80').width;
        return { instrumentSerifItalic: Math.round(w1*10)/10, georgiaItalic: Math.round(w2*10)/10, delta: Math.round((w1 - w2) * 10) / 10 };
      })(),
    }));
    console.log('font report:', JSON.stringify(fontReport, null, 2));

    const card = await page.$('.eod-card');
    const png = await card.screenshot({ type: 'png' });
    writeFileSync(outPath, png);
    console.log('wrote', outPath, '— size', png.length, 'bytes');
  } finally {
    await browser.close();
  }
}

await render('Personal',  samplePersonal, '/tmp/rewind-test-personal.png');
await render('Group',     sampleGroup,    '/tmp/rewind-test-group.png');
console.log('\nDone. Open:');
console.log('  open /tmp/rewind-test-personal.png');
console.log('  open /tmp/rewind-test-group.png');
