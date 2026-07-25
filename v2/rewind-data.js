/* ============================================================================
   REWIND — DATA LAYER
   One query, one adapter, pure derivations. Every page imports from here so
   the numbers cannot disagree between Calendar, Overview, History, Community
   and Showroom.

   ARCHITECTURE
     fetchTrades()  -> raw Supabase rows
     adaptRow()     -> the ONE place column names live  <-- CHECK THIS FIRST
     derive*()      -> pure functions, no I/O, unit-testable
     assertConsistent() -> the invariants that kept breaking in the mocks

   Everything below `adaptRow` is schema-agnostic. If BACKEND-BIBLE.md says a
   column is named differently, change adaptRow and nothing else.
   ========================================================================== */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

/* ---------------------------------------------------------------------------
   1 · CONFIG
   ------------------------------------------------------------------------- */
export const CONFIG = {
  SUPABASE_URL:      window.__REWIND_SUPABASE_URL      || '',
  SUPABASE_ANON_KEY: window.__REWIND_SUPABASE_ANON_KEY  || '',
  TABLE: 'trades',
};

export const hasBackend = () => !!(CONFIG.SUPABASE_URL && CONFIG.SUPABASE_ANON_KEY);

let _client = null;
export function client() {
  if (!hasBackend()) return null;
  if (!_client) _client = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
  return _client;
}

export async function currentUser() {
  const c = client();
  if (!c) return null;
  const { data: { session } } = await c.auth.getSession();
  return session?.user ?? null;
}

/* ---------------------------------------------------------------------------
   2 · THE ADAPTER — written against the REAL schema
   trades: id text, user_id uuid, trade_data jsonb, created_at, updated_at,
           journal text, account_type text, trading_day date

   Every trade field lives inside trade_data. Confirmed keys and how many of
   483 object-rows carry each one:
     pnl 483 · rr 483 · entry 483 · exit 483 · qty 483 · sym 483 · type 483
     date 483 · market 483 · images 483 · created_at 483 · id 483
     stop 482 · grade 482 · notes 482 · confidence 482 · emotion 482
     points 447 · account_type 343 · confluences 325 · account 222
     accounts 79 · tradingview_link 9 · reflection 1
   ------------------------------------------------------------------------- */

/* 41 rows store trade_data as a STRING (double-encoded JSON) instead of an
   object. Parsing here rescues them instead of silently dropping ~8% of the
   ledger. See fixDoubleEncoded() at the bottom for the permanent fix. */
export function parseTradeData(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const once = JSON.parse(raw);
      if (once && typeof once === 'object') return once;
      if (typeof once === 'string') { const twice = JSON.parse(once); if (twice && typeof twice === 'object') return twice; }
    } catch { /* unparseable — treated as empty below */ }
  }
  return null;
}

export function adaptRow(r) {
  const d = parseTradeData(r.trade_data);
  if (!d) return null;                     // caller filters these out

  const pnl = num(d.pnl);

  return {
    id: r.id,

    /* the trading_day COLUMN wins — it is the session day, already correct for
       a 6pm Globex open. trade_data.date is the fallback. */
    date: r.trading_day || (d.date ? String(d.date).slice(0, 10) : null),

    symbol:    d.sym ?? '—',
    side:      cap(d.type),                       // 'long'/'short' -> Long/Short
    market:    d.market ?? null,                  // 'Futures'
    session:   blankTo(d.session, 'Unspecified'),
    /* the COLUMN wins over the blob copy (343 of 483 blobs have it) */
    account:   accountLabel(r.account_type ?? d.account_type),
    accountRef: d.account ?? null,                // e.g. 'AFZEROQA20260412899'
    journal:   r.journal ?? null,
    grade:     blankTo(d.grade, null),

    entry:     num(d.entry),
    exit:      num(d.exit),
    stop:      num(d.stop),
    points:    num(d.points),
    contracts: num(d.qty) || 1,
    copies:    num(d.accounts) || null,           // copy-trade multiplier

    r:   num(d.rr),                               // rr is the R multiple
    pnl,
    fees: 0,                                      // NOT TRACKED — see notes
    holdMin: 0,                                   // NOT TRACKED — see notes

    confidence: num(d.confidence) || null,
    emotion:    num(d.emotion) || null,

    note:       d.notes ?? '',
    reflection: d.reflection ?? '',
    images:     Array.isArray(d.images) ? d.images : [],
    tvLink:     d.tradingview_link ?? null,

    /* trade_data.confluences is an array; the trade_confluences join table
       carries the per-timeframe version. Names resolve via confluences.name. */
    confluences: normaliseConfluences(d.confluences),

    /* NO MODEL FIELD EXISTS in trade_data — nothing to map. Any page that
       groups by setup needs this added when logging, or derived from
       confluences. Until then it groups as one bucket. */
    model: 'Unspecified',

    loggedAt: r.created_at ?? d.created_at ?? null,
  };
}

const ACCOUNTS = { funded: 'Funded', eval: 'Eval', paper: 'Paper', demo: 'Paper' };
function accountLabel(v) {
  const k = String(v || '').toLowerCase();
  return ACCOUNTS[k] ?? (v ? cap(v) : 'Unspecified');
}
const blankTo = (v, alt) => (v === '' || v === null || v === undefined) ? alt : v;

/* ---------------------------------------------------------------------------
   3 · FETCH — filters on the trading_day DATE COLUMN, not a timestamp
   ------------------------------------------------------------------------- */
export async function fetchTrades({ from, to } = {}) {
  const c = client();
  if (!c) throw new Error('no-backend');

  const user = await currentUser();
  if (!user) throw new Error('no-session');

  let q = c.from(CONFIG.TABLE).select('*').eq('user_id', user.id);
  if (from) q = q.gte('trading_day', from);
  if (to)   q = q.lte('trading_day', to);

  const { data, error } = await q.order('trading_day', { ascending: true });
  if (error) throw error;

  const rows = data.map(adaptRow);
  const bad  = rows.filter(x => x === null).length;
  if (bad) console.warn(`[rewind] ${bad} of ${data.length} rows had unreadable trade_data and were skipped`);
  return rows.filter(Boolean).filter(t => t.date);
}

/* ---------------------------------------------------------------------------
   4 · DERIVATIONS — pure. no fetching, no DOM, no globals.
   These are the functions every page renders from.
   ------------------------------------------------------------------------- */

/** aggregate any set of trades into the stat block every page uses */
export function aggregate(trades) {
  const wins   = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl < 0);
  const bes    = trades.filter(t => t.pnl === 0);

  const grossProfit = sum(wins.map(t => t.pnl));
  const grossLoss   = -sum(losses.map(t => t.pnl));
  const fees        = sum(trades.map(t => t.fees));   /* always 0 — not tracked in trade_data */
  const net         = sum(trades.map(t => t.pnl));

  const days      = [...new Set(trades.map(t => t.date))];
  const dayNets   = days.map(d => sum(trades.filter(t => t.date === d).map(x => x.pnl)));
  const greenDays = dayNets.filter(v => v > 0).length;

  const decided = wins.length + losses.length;

  return {
    trades: trades.length,
    wins: wins.length, losses: losses.length, bes: bes.length,
    grossProfit, grossLoss, fees, net,

    /* break-evens are EXCLUDED from win rate — state this in the UI */
    winRate:  decided ? (wins.length / decided) * 100 : null,
    pf:       grossLoss ? grossProfit / grossLoss : null,
    expectancy: trades.length ? net / trades.length : null,
    avgWin:   wins.length   ? grossProfit / wins.length   : null,
    avgLoss:  losses.length ? grossLoss   / losses.length : null,
    avgR:     trades.length ? sum(trades.map(t => t.r)) / trades.length : null,
    avgHold:  trades.length ? sum(trades.map(t => t.holdMin)) / trades.length : null,

    tradingDays: days.length,
    greenDays,
    greenDayPct: days.length ? (greenDays / days.length) * 100 : null,
    avgDaily:    days.length ? net / days.length : null,
    tradesPerDay: days.length ? trades.length / days.length : null,

    maxDrawdown: maxDrawdown(dayNets),
  };
}

/** one entry per calendar day that has trades */
export function deriveDays(trades) {
  const byDate = groupBy(trades, t => t.date);
  return Object.entries(byDate)
    .map(([date, ts]) => ({
      date,
      net: sum(ts.map(t => t.pnl)),
      trades: ts.length,
      wins: ts.filter(t => t.pnl > 0).length,
      losses: ts.filter(t => t.pnl < 0).length,
      outcome: (() => { const n = sum(ts.map(t => t.pnl)); return n > 0 ? 'up' : n < 0 ? 'dn' : 'be'; })(),
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** week buckets, Sunday-first — Globex opens Sunday 6pm ET so Sunday trades */
export function deriveWeeks(trades, year, month /* 1-12 */) {
  const weeks = [];
  const first = new Date(year, month - 1, 1);
  const start = new Date(first); start.setDate(1 - first.getDay()); // back to Sunday

  for (let w = 0; w < 6; w++) {
    const a = new Date(start); a.setDate(start.getDate() + w * 7);
    const b = new Date(a);     b.setDate(a.getDate() + 6);
    const from = iso(a), to = iso(b);
    const inWeek = trades.filter(t => t.date >= from && t.date <= to);
    weeks.push({
      index: w + 1, from, to,
      net: sum(inWeek.map(t => t.pnl)),
      trades: inWeek.length,
      days: new Set(inWeek.map(t => t.date)).size,
    });
  }
  return weeks;
}

/** the 6x8 calendar matrix the grid renders, Sunday-first, week cell last */
export function deriveCalendar(trades, year, month) {
  const days  = deriveDays(trades);
  const byDate = Object.fromEntries(days.map(d => [d.date, d]));
  const weeks = deriveWeeks(trades, year, month);

  const first = new Date(year, month - 1, 1);
  const start = new Date(first); start.setDate(1 - first.getDay());
  const maxNet = Math.max(1, ...days.map(d => Math.abs(d.net)));

  const rows = [];
  for (let w = 0; w < 6; w++) {
    const cells = [];
    for (let i = 0; i < 7; i++) {
      const dt = new Date(start); dt.setDate(start.getDate() + w * 7 + i);
      const key = iso(dt);
      const d = byDate[key];
      cells.push({
        date: key,
        dayNum: dt.getDate(),
        inMonth: dt.getMonth() === month - 1,
        ...(d ?? { net: 0, trades: 0, outcome: null }),
        /* tint strength scaled to the month's own range, not an absolute */
        intensity: d ? Math.min(1, Math.abs(d.net) / maxNet) : 0,
      });
    }
    rows.push({ cells, week: weeks[w] });
  }
  /* drop a trailing row that holds no in-month day */
  while (rows.length && !rows[rows.length - 1].cells.some(c => c.inMonth)) rows.pop();
  return { rows, weeks, days, month, year };
}

/** breakdown by any dimension, with the contribution share signed correctly */
export function deriveBreakdown(trades, key /* 'model'|'session'|'account'|'symbol' */) {
  const groups = groupBy(trades, t => t[key] ?? 'Unspecified');
  const rows = Object.entries(groups).map(([k, ts]) => ({ key: k, ...aggregate(ts) }));
  const posSum = sum(rows.filter(r => r.net > 0).map(r => r.net)) || 1;
  rows.forEach(r => { r.share = (r.net / posSum) * 100; });   // negative = drag
  return rows.sort((a, b) => b.net - a.net);
}

/** cumulative equity by trading day */
export function deriveEquity(trades) {
  const days = deriveDays(trades);
  let run = 0, peak = -Infinity;
  return days.map(d => {
    run += d.net; peak = Math.max(peak, run);
    return { date: d.date, cum: run, peak, drawdown: run - peak };
  });
}

/* ---------------------------------------------------------------------------
   5 · INVARIANTS — the checks that caught real bugs in the mocks
   Call in dev; log rather than throw so a bad row can't blank the page.
   ------------------------------------------------------------------------- */
export function assertConsistent(trades, { label = 'period' } = {}) {
  const a = aggregate(trades);
  const days = deriveDays(trades);
  const problems = [];

  const dayTotal = sum(days.map(d => d.net));
  if (round(dayTotal) !== round(a.net))
    problems.push(`day nets ${money(dayTotal)} != ${label} net ${money(a.net)}`);

  if (a.wins + a.losses + a.bes !== a.trades)
    problems.push(`W+L+BE (${a.wins}+${a.losses}+${a.bes}) != ${a.trades} trades`);

  for (const dim of ['model', 'session', 'account', 'symbol']) {
    const rows = deriveBreakdown(trades, dim);
    const n = sum(rows.map(r => r.net)), t = sum(rows.map(r => r.trades));
    if (round(n) !== round(a.net)) problems.push(`${dim} nets ${money(n)} != ${money(a.net)}`);
    if (t !== a.trades)            problems.push(`${dim} trades ${t} != ${a.trades}`);
  }

  const eq = deriveEquity(trades);
  if (eq.length && round(eq[eq.length - 1].cum) !== round(a.net))
    problems.push(`equity ends ${money(eq.at(-1).cum)} != ${money(a.net)}`);

  if (problems.length) console.warn(`[rewind] ${label} does not reconcile:`, problems);
  return { ok: !problems.length, problems };
}

/* ---------------------------------------------------------------------------
   6 · FORMATTERS — shared so every page prints a figure identically
   ------------------------------------------------------------------------- */
export const money  = n => (n < 0 ? '−$' : '$')  + Math.abs(Math.round(n)).toLocaleString();
export const signed = n => n === 0 ? '$0' : (n < 0 ? '−$' : '+$') + Math.abs(Math.round(n)).toLocaleString();
export const pct    = n => n === null || n === undefined ? '—' : Math.round(n) + '%';
export const rStr   = n => n === null || n === undefined ? '—' : (n >= 0 ? '+' : '−') + Math.abs(n).toFixed(2);
export const dir    = n => n > 0 ? 'up' : n < 0 ? 'dn' : 'be';

/* ---------------------------------------------------------------------------
   7 · helpers
   ------------------------------------------------------------------------- */
const sum   = a => a.reduce((s, v) => s + (Number(v) || 0), 0);
const num   = v => v === null || v === undefined ? 0 : Number(v);
const round = n => Math.round(n * 100) / 100;
const cap   = s => s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : '';
const iso   = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function groupBy(arr, fn) {
  return arr.reduce((acc, x) => { const k = fn(x); (acc[k] ||= []).push(x); return acc; }, {});
}
function localDate(ts) { return ts ? iso(new Date(ts)) : null; }
function localTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function holdMinutes(a, b) {
  if (!a || !b) return 0;
  return Math.max(0, Math.round((new Date(b) - new Date(a)) / 60000));
}
function maxDrawdown(dayNets) {
  let run = 0, peak = 0, worst = 0;
  for (const v of dayNets) { run += v; peak = Math.max(peak, run); worst = Math.min(worst, run - peak); }
  return worst;
}
function normaliseConfluences(c) {
  if (!c) return [];
  if (Array.isArray(c)) return c.map(x => typeof x === 'string'
    ? { timeframe: '', name: x }
    : { timeframe: x.timeframe ?? x.tf ?? '', name: x.name ?? x.label ?? String(x) });
  if (typeof c === 'object') return Object.entries(c).map(([tf, name]) => ({ timeframe: tf, name }));
  return [];
}

/* ---------------------------------------------------------------------------
   8 · DEMO DATA — so every page renders before credentials exist.
   Same 27 trades the mocks used; day nets match the Calendar exactly.
   ------------------------------------------------------------------------- */
export function demoTrades() {
  const rows = [
    ['2026-07-13','09:33','NQ','Short','CISD','NY AM','funded',-540,-1.40,6,'D'],
    ['2026-07-13','09:58','NQ','Long','OTE','NY AM','funded',310,1.20,21,'B'],
    ['2026-07-13','10:26','NQ','Short','Silver Bullet','NY AM','eval',-280,-1.00,8,'C'],
    ['2026-07-13','10:49','ES','Short','CISD','NY AM','eval',-190,-0.80,7,'C'],
    ['2026-07-13','11:15','NQ','Long','FVG','NY AM','funded',260,1.10,17,'B'],
    ['2026-07-13','13:32','NQ','Short','Silver Bullet','NY PM','funded',-540,-1.40,9,'D'],
    ['2026-07-13','14:48','NQ','Long','OTE','NY PM','paper',300,1.30,23,'B'],

    ['2026-07-14','09:44','NQ','Long','OTE','NY AM','eval',530,1.70,29,'A'],
    ['2026-07-14','10:52','NQ','Short','Turtle Soup','NY AM','eval',-220,-0.90,10,'C'],

    ['2026-07-15','09:36','NQ','Long','OTE','NY AM','funded',540,1.90,33,'A'],
    ['2026-07-15','10:11','ES','Long','FVG','NY AM','funded',610,1.50,27,'A'],
    ['2026-07-15','11:04','NQ','Short','CISD','NY AM','eval',-225,-0.80,9,'C'],
    ['2026-07-15','13:41','NQ','Long','Unicorn','NY PM','paper',0,0.00,22,'B'],

    ['2026-07-16','09:48','NQ','Long','OTE','NY AM','paper',0,0.00,31,'B'],

    ['2026-07-17','09:39','ES','Long','FVG','NY AM','eval',460,1.30,24,'B'],
    ['2026-07-17','10:22','NQ','Long','OTE','NY AM','funded',250,1.10,18,'B'],
    ['2026-07-17','03:55','NQ','Short','2022 Model','London','funded',-250,-1.00,16,'C'],

    ['2026-07-20','10:02','NQ','Long','OTE','NY AM','funded',1180,2.80,41,'A'],
    ['2026-07-20','10:47','NQ','Short','CISD','NY AM','funded',-430,-1.00,8,'C'],
    ['2026-07-20','11:18','ES','Long','FVG','NY AM','eval',200,0.60,14,'B'],
    ['2026-07-20','14:06','NQ','Short','Turtle Soup','NY PM','paper',-210,-1.00,12,'C'],

    ['2026-07-21','09:41','NQ','Long','OTE','NY AM','funded',320,1.20,22,'B'],
    ['2026-07-21','10:58','NQ','Short','Silver Bullet','NY AM','funded',-250,-1.00,11,'C'],
    ['2026-07-21','13:24','NQ','Long','Silver Bullet','NY PM','eval',-250,-1.00,9,'D'],

    ['2026-07-22','09:32','NQ','Long','OTE','NY AM','funded',900,2.10,28,'A'],
    ['2026-07-22','10:14','NQ','Short','CISD','NY AM','eval',-425,-1.00,7,'C'],
    ['2026-07-22','11:02','ES','Long','FVG','NY AM','funded',610,1.40,19,'B'],
  ];
  return rows.map(([date, time, symbol, side, model, session, journal, pnl, r, hold, grade], i) => ({
    id: 'demo-' + String(i + 1).padStart(3, '0'),
    date, time, symbol, side, model, session,
    account: accountLabel(journal), accountRef:null, market:'Futures', journal:null,
    grade, entry: 0, exit: 0, stop: 0, contracts: 2,
    r, pnl, fees: 0, holdMin: hold, points:0, copies:null, confidence:null, emotion:null,
    note: '', reflection:'', images: [], tvLink:null, confluences: [], loggedAt:null,
  }));
}

/** the loader every page calls: real data when configured, demo otherwise */
export async function loadTrades(range) {
  if (!hasBackend()) return { trades: demoTrades(), source: 'demo' };
  try {
    return { trades: await fetchTrades(range), source: 'live' };
  } catch (e) {
    if (e.message === 'no-session') return { trades: [], source: 'no-session' };
    console.error('[rewind] fetch failed', e);
    return { trades: demoTrades(), source: 'error' };
  }
}


/* ---------------------------------------------------------------------------
   9 · ONE-OFF REPAIR — the 41 double-encoded rows
   Run once from the browser console while signed in:
     import('./rewind-data.js').then(m => m.fixDoubleEncoded())
   It reads only your own rows and rewrites trade_data as a real object.
   ------------------------------------------------------------------------- */
export async function fixDoubleEncoded({ dryRun = true } = {}) {
  const c = client();
  const user = await currentUser();
  if (!c || !user) throw new Error('sign in first');

  const { data, error } = await c.from(CONFIG.TABLE).select('id, trade_data').eq('user_id', user.id);
  if (error) throw error;

  const broken = data.filter(r => typeof r.trade_data === 'string');
  const fixable = broken.map(r => ({ id: r.id, obj: parseTradeData(r.trade_data) })).filter(x => x.obj);

  console.log(`${broken.length} string rows, ${fixable.length} parse cleanly`);
  if (dryRun) { console.log('dry run — call fixDoubleEncoded({dryRun:false}) to write'); return { broken: broken.length, fixable: fixable.length }; }

  let ok = 0;
  for (const { id, obj } of fixable) {
    const { error: e } = await c.from(CONFIG.TABLE).update({ trade_data: obj }).eq('id', id).eq('user_id', user.id);
    if (e) console.error(id, e.message); else ok++;
  }
  console.log(`repaired ${ok} rows`);
  return { repaired: ok };
}
