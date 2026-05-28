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

// Short correlation id surfaced in logs + the X-Eod-Render-Id response
// header so the iOS client can toast it and the user can read the same
// id back to us when comparing log entries.
function _rid() {
  return Math.random().toString(36).slice(2, 8);
}

export default async function handler(req, res) {
  // Session 20i diagnostic — log every inbound request BEFORE auth so
  // we can prove the route is being hit at all.  Tag every line with
  // [eod render rid=XXXX] so a single share click's logs cluster
  // together in Vercel function logs.
  const rid = _rid();
  const tEntry = Date.now();
  // Always echo the rid back so the client can toast it.  Set early so
  // it survives all the early-return branches below.
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
    return; // 401 already written
  }
  console.log('[eod render rid=' + rid + '] auth ok | user:', user.id);

  // Body parsing — @vercel/node delivers req.body already JSON-parsed for
  // application/json requests, but we accept a raw string too for belt
  // + suspenders.
  let payload = req.body;
  if (typeof payload === 'string') {
    try { payload = JSON.parse(payload); } catch (_) { payload = null; }
  }
  if (!payload || typeof payload !== 'object') {
    console.warn('[eod render rid=' + rid + '] invalid payload — 400');
    res.status(400).json({ error: 'invalid payload' });
    return;
  }
  const type = payload.type;
  if (type !== 'personal' && type !== 'group') {
    console.warn('[eod render rid=' + rid + '] bad type:', type);
    res.status(400).json({ error: 'type must be personal|group' });
    return;
  }
  if (!payload.data || typeof payload.data !== 'object') {
    console.warn('[eod render rid=' + rid + '] data missing — 400');
    res.status(400).json({ error: 'data required' });
    return;
  }
  console.log('[eod render rid=' + rid + '] payload ok',
    '| type:', type,
    '| etDate:', payload.data.etDate,
    '| totalPnl:', payload.data.totalPnl,
    '| tradeCount:', payload.data.tradeCount);

  const t0 = Date.now();
  let html;
  try {
    html = buildHtml(payload);
  } catch (e) {
    console.error('[eod render rid=' + rid + '] template build failed:', e && e.message);
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
    // Layered font wait — covers the ways font loading can fall through
    // the cracks in @sparticuz/chromium:
    //   (1) data-fonts-ready="1" selector — set by the template boot
    //       script after Promise.all([...document.fonts.load(...)]) AND
    //       document.fonts.ready resolve.
    //   (2) Explicit document.fonts.ready await — belt-and-suspenders in
    //       case the inline script hit an error and didn't stamp (1).
    //   (3) document.fonts.check() guard — verifies the rasterizer sees
    //       Instrument Serif italic + Geist Mono + Geist as loaded.  If
    //       not, throw before screenshot so the client falls back to
    //       modern-screenshot instead of getting a Georgia PNG.
    let fontsReadyFired = false;
    try {
      await page.waitForSelector('html[data-fonts-ready="1"]', { timeout: 6000 });
      fontsReadyFired = true;
    } catch (_) {
      console.warn('[eod render rid=' + rid + '] data-fonts-ready never fired (6s timeout)');
    }
    // Explicit document.fonts.ready — drains any leftover faces.
    const fontsReadyResult = await page.evaluate(async () => {
      try {
        if (document.fonts && document.fonts.ready) {
          await document.fonts.ready;
          return { ok: true, status: document.fonts.status, size: document.fonts.size };
        }
        return { ok: false, reason: 'no-fonts-api' };
      } catch (e) {
        return { ok: false, reason: e && e.message };
      }
    });
    console.log('[eod render rid=' + rid + '] document.fonts.ready:', JSON.stringify(fontsReadyResult));
    // Read any data-fonts-error the template boot script may have stamped.
    const bootError = await page.evaluate(() =>
      document.documentElement.getAttribute('data-fonts-error') || null
    );
    if (bootError) {
      console.warn('[eod render rid=' + rid + '] template boot reported font error:', bootError);
    }
    // Tiny tick so layout settles after the fonts complete.
    await new Promise(r => setTimeout(r, 50));

    // ── FONT DIAGNOSTIC — Session 20i debug.  Dumps document.fonts state
    // and probes whether Instrument Serif italic / Geist Mono / Geist
    // actually loaded vs. silently fell back.  Uses canvas measureText
    // as the ground-truth check: if Instrument Serif loaded, "M" at 100px
    // measures noticeably narrower than the Georgia fallback (~64px vs
    // ~80px).  Logs the full set so we can see which families paint.
    const fontDiag = await page.evaluate(() => {
      const out = {
        status: document.fonts ? document.fonts.status : 'unsupported',
        size: document.fonts ? document.fonts.size : 0,
        readyAttr: document.documentElement.getAttribute('data-fonts-ready'),
        families: [],
        measurements: {},
        check: {},
      };
      if (document.fonts && document.fonts.forEach) {
        document.fonts.forEach(f => {
          out.families.push(
            f.family + '/' + (f.style || 'normal') + '/' + (f.weight || '400') + ':' + f.status
          );
        });
      }
      // FontFaceSet.check() — authoritative "is this exact face loaded
      // and usable right now?" probe.  Returns false if the browser
      // would substitute a fallback for this CSS font shorthand.
      try {
        out.check.isItalic   = !!(document.fonts && document.fonts.check && document.fonts.check('italic 16px "Instrument Serif"'));
        out.check.isRegular  = !!(document.fonts && document.fonts.check && document.fonts.check('16px "Instrument Serif"'));
        out.check.geist      = !!(document.fonts && document.fonts.check && document.fonts.check('500 16px "Geist"'));
        out.check.geistMono  = !!(document.fonts && document.fonts.check && document.fonts.check('400 16px "Geist Mono"'));
      } catch (e) {
        out.check.error = e && e.message;
      }
      // Ground-truth measurement — does the rasterizer actually shape
      // text in the expected face?  We measure a known glyph at 100px
      // in three configurations: the requested family + Italic, the
      // requested family + Roman, and the system fallback only.
      try {
        const cnv = document.createElement('canvas');
        const ctx = cnv.getContext('2d');
        const probe = 'Mg$1234';
        const cfgs = [
          ['instrument-italic',  'italic 100px "Instrument Serif", Georgia, serif'],
          ['instrument-roman',   '100px "Instrument Serif", Georgia, serif'],
          ['georgia-italic',     'italic 100px Georgia, serif'],
          ['geist-mono',         '100px "Geist Mono", ui-monospace, monospace'],
          ['mono-fallback',      '100px ui-monospace, monospace'],
          ['geist',              '500 100px "Geist", system-ui, sans-serif'],
          ['system-sans',        '500 100px system-ui, sans-serif'],
        ];
        cfgs.forEach(([key, f]) => {
          ctx.font = f;
          const m = ctx.measureText(probe);
          out.measurements[key] = Math.round(m.width * 10) / 10;
        });
      } catch (e) {
        out.measurementsError = e && e.message;
      }
      return out;
    });
    console.log('[eod render rid=' + rid + '] font diag |',
      'data-fonts-ready=' + (fontsReadyFired ? '1' : 'timeout'),
      '| document.fonts.status=' + fontDiag.status,
      '| families.size=' + fontDiag.size,
      '| boot-error=' + (bootError || 'none'),
      '| check.is-italic=' + fontDiag.check.isItalic,
      '| check.is-regular=' + fontDiag.check.isRegular,
      '| check.geist=' + fontDiag.check.geist,
      '| check.geist-mono=' + fontDiag.check.geistMono,
      '| families=' + JSON.stringify(fontDiag.families),
      '| measurements=' + JSON.stringify(fontDiag.measurements));

    // Surface a compact summary in the response header so the client
    // can toast it on the iOS UI without devtools access.  The header
    // value is a short ASCII summary — actual full diag stays in
    // server logs.
    const measIS = fontDiag.measurements['instrument-italic'];
    const measGA = fontDiag.measurements['georgia-italic'];
    const measGM = fontDiag.measurements['geist-mono'];
    const measMF = fontDiag.measurements['mono-fallback'];
    const isLoaded = (measIS != null && measGA != null) ? (Math.abs(measIS - measGA) > 4 ? 'y' : 'n') : '?';
    const gmLoaded = (measGM != null && measMF != null) ? (Math.abs(measGM - measMF) > 4 ? 'y' : 'n') : '?';
    res.setHeader(
      'X-Eod-Fonts',
      'is=' + isLoaded + ',gm=' + gmLoaded + ',count=' + fontDiag.size + ',ready=' + (fontsReadyFired ? '1' : '0')
    );

    // ── HARD FONT GUARD ──────────────────────────────────────────────
    // If document.fonts.check() says Instrument Serif italic is NOT
    // loaded, refuse to screenshot.  A 502 lets the client fall back to
    // the legacy modern-screenshot path — which produces a Georgia PNG
    // too, but at least we don't ship a confidently-wrong "server-
    // rendered" output.  Same for Geist Mono since that's the other
    // family the eye notices in the captured cards.
    if (!fontDiag.check.isItalic || !fontDiag.check.geistMono) {
      throw new Error(
        'fonts not loaded: instrument-italic=' + fontDiag.check.isItalic +
        ' geist-mono=' + fontDiag.check.geistMono +
        ' boot-error=' + (bootError || 'none') +
        ' families.size=' + fontDiag.size
      );
    }

    const card = await page.$('.eod-card');
    if (!card) throw new Error('card element not found in rendered page');
    const png = await card.screenshot({
      type: 'png',
      omitBackground: false,
    });
    const tDone = Date.now();
    console.log('[eod render rid=' + rid + '] ok',
      '| type:', type,
      '| browser-ready-ms:', tBrowserReady - t0,
      '| total-ms:', tDone - t0,
      '| bytes:', png.length,
      '| fonts.is=' + isLoaded,
      '| fonts.gm=' + gmLoaded);

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
    console.error('[eod render rid=' + rid + '] FAILED:', e && (e.stack || e.message));
    // Surface a structured error so the client knows to fall back to
    // modern-screenshot.  Status 502 — upstream renderer failed, not a
    // bad request from the caller.
    res.status(502).json({ error: 'render failed', detail: e && e.message, rid: rid });
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
