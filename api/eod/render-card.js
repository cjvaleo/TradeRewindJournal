// POST /api/eod/render-card
// Session 20i — server-side PNG rendering for the EOD PnL share card.
//
// Body shape:
//   { type: 'personal' | 'group',
//     data: <same payload the client renderers consume — see _template.js> }
//
// Response: image/png buffer of the card.  Mirrors the visual the client
// produces from _eodRenderPersonalCard / _eodRenderGroupCard but renders
// in a real Chromium via @sparticuz/chromium + puppeteer-core so the web
// fonts (Instrument Serif, Geist, Geist Mono) actually paint into the
// raster output.  The client-side modern-screenshot path silently falls
// back to system fonts when rasterizing the SVG foreignObject — Puppeteer
// avoids that whole pipeline.
//
// Auth: requires a valid Supabase session.  No Pro gate — the EOD modal
// is available to all logged-in users and the share button has always
// been available with it.

import { authUser } from '../_lib/auth.js';
import buildHtml from './_template.js';

// Reuse the browser instance across invocations.  Vercel Fluid Compute
// keeps Node processes warm between requests, so a singleton avoids the
// ~2s Chromium spin-up on every share.  If the browser disconnects we
// rebuild lazily on the next call.
let _browserPromise = null;

async function getBrowser() {
  if (_browserPromise) {
    try {
      const b = await _browserPromise;
      if (b && b.isConnected && b.isConnected()) return b;
    } catch (_) {
      // fall through to rebuild
    }
    _browserPromise = null;
  }
  _browserPromise = (async () => {
    // Lazy require so the chromium binary is only resolved on the actual
    // render route — keeps the cold-start cheap for every other endpoint.
    const chromium = (await import('@sparticuz/chromium')).default;
    const puppeteer = await import('puppeteer-core');
    // Disable WebGL — we never use it and dropping it shaves cold-start.
    chromium.setGraphicsMode = false;
    const browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: { width: 1280, height: 1024, deviceScaleFactor: 2 },
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
      ignoreHTTPSErrors: true,
    });
    return browser;
  })();
  try {
    return await _browserPromise;
  } catch (e) {
    _browserPromise = null;
    throw e;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed', allowed: ['POST'] });
    return;
  }
  const user = await authUser(req, res);
  if (!user) return; // 401 already written

  // Body parsing — @vercel/node delivers req.body already JSON-parsed for
  // application/json requests, but we accept a raw string too for belt
  // + suspenders.
  let payload = req.body;
  if (typeof payload === 'string') {
    try { payload = JSON.parse(payload); } catch (_) { payload = null; }
  }
  if (!payload || typeof payload !== 'object') {
    res.status(400).json({ error: 'invalid payload' });
    return;
  }
  const type = payload.type;
  if (type !== 'personal' && type !== 'group') {
    res.status(400).json({ error: 'type must be personal|group' });
    return;
  }
  if (!payload.data || typeof payload.data !== 'object') {
    res.status(400).json({ error: 'data required' });
    return;
  }

  const t0 = Date.now();
  let html;
  try {
    html = buildHtml(payload);
  } catch (e) {
    console.error('[eod render] template build failed:', e && e.message);
    res.status(500).json({ error: 'template build failed' });
    return;
  }

  let page = null;
  try {
    const browser = await getBrowser();
    const tBrowserReady = Date.now();
    page = await browser.newPage();
    // Hold a separate viewport for the page so concurrent invocations
    // can't trample each other.  Width is generous; we crop to the card
    // via element.screenshot below.
    await page.setViewport({ width: 1280, height: 1200, deviceScaleFactor: 2 });
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 15000 });
    // Belt + suspenders — the inline boot script flips
    // <html data-fonts-ready="1"> once document.fonts.ready settles.
    // networkidle0 alone doesn't guarantee font shaping is done.
    await page
      .waitForSelector('html[data-fonts-ready="1"]', { timeout: 5000 })
      .catch(() => { /* fall through — best-effort */ });
    // Tiny tick to let layout settle after fonts swap.  Without this the
    // first paint occasionally measures the fallback metrics.
    await new Promise(r => setTimeout(r, 100));

    const card = await page.$('.eod-card');
    if (!card) throw new Error('card element not found in rendered page');
    const png = await card.screenshot({
      type: 'png',
      omitBackground: false,
    });
    const tDone = Date.now();
    console.log('[eod render] ok',
      '| type:', type,
      '| browser-ready-ms:', tBrowserReady - t0,
      '| total-ms:', tDone - t0,
      '| bytes:', png.length);

    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-store');
    // Hint to the client what we'd like the filename to be when saved.
    const dateStr = (payload.data && payload.data.etDate) || '';
    res.setHeader(
      'Content-Disposition',
      'inline; filename="rewind-pnl-' + (dateStr || 'card') + '.png"'
    );
    res.status(200).send(png);
  } catch (e) {
    console.error('[eod render] FAILED:', e && (e.stack || e.message));
    // Surface a structured error so the client knows to fall back to
    // modern-screenshot.  Status 502 — upstream renderer failed, not a
    // bad request from the caller.
    res.status(502).json({ error: 'render failed', detail: e && e.message });
  } finally {
    if (page) {
      try { await page.close(); } catch (_) {}
    }
  }
}

// Vercel function config — bumped memory + extended duration so the
// chromium spawn + screenshot have headroom.  maxDuration:30 is safely
// under the 300s platform default; the long ceiling is just a safety net
// for the very first cold-start.
export const config = {
  maxDuration: 30,
};
