// Shared aggregation + mock data for the Review → Community tab endpoints.
// Deterministic, no AI. Real aggregation runs for `all_rewind_users` over
// every trader's last-7-day trades; the other four communities return
// generated mock bundles (membership tables are a v2 concern).

import { sbService } from './supabase.js';
import { requirePro } from './auth.js';

const WINDOW_DAYS = 7;
const SESSIONS = ['Asia', 'London', 'NY AM', 'Lunch', 'NY PM'];

export const COMMUNITIES = [
  { id: 'all_rewind_users', name: 'All Rewind Users', trader_count: null },
  { id: 'nq_scalpers',      name: 'NQ Scalpers',      trader_count: 1240 },
  { id: 'ict_traders',      name: 'ICT Traders',      trader_count: 3180 },
  { id: 'ftmo_funded',      name: 'FTMO Funded',      trader_count: 920 },
  { id: 'mes_mini_traders', name: 'MES Mini Traders', trader_count: 670 },
];
const BY_ID = {};
COMMUNITIES.forEach(function (c) { BY_ID[c.id] = c; });
export function isCommunity(id) { return !!BY_ID[id]; }

// ── normalization helpers ───────────────────────────────────────────
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function effDate(t) {
  if (typeof t.date === 'string' && /^\d{4}-\d{2}-\d{2}/.test(t.date)) return t.date.slice(0, 10);
  if (typeof t.created_at === 'string' && t.created_at.length >= 10) return t.created_at.slice(0, 10);
  return null;
}
function normTrade(row) {
  let td = row.trade_data;
  if (typeof td === 'string') { try { td = JSON.parse(td); } catch (e) { td = {}; } }
  if (!td || typeof td !== 'object') td = {};
  return { ...td, user_id: row.user_id, account_type: row.account_type || td.account_type || null, created_at: row.created_at };
}
function isWin(t) { const p = num(t.pnl); return p != null && p > 0; }
function isLoss(t) { const p = num(t.pnl); return p != null && p < 0; }
function signedR(t) {
  const rr = num(t.rr), p = num(t.pnl);
  if (rr == null || rr === 0 || p == null) return null;
  return Math.abs(rr) * (p >= 0 ? 1 : -1);
}
function totalQty(t) { return (num(t.qty) || 1) * (num(t.accounts) || 1); }
function mean(a) { return a.length ? a.reduce(function (s, x) { return s + x; }, 0) / a.length : null; }
function round(n, d) { if (n == null || !Number.isFinite(n)) return null; const f = Math.pow(10, d || 0); return Math.round(n * f) / f; }
function sessionOf(t) {
  const s = typeof t.session === 'string' ? t.session.trim() : '';
  if (/lunch/i.test(s)) return 'Lunch';
  for (let i = 0; i < SESSIONS.length; i++) {
    if (SESSIONS[i].toLowerCase() === s.toLowerCase()) return SESSIONS[i];
  }
  return null;
}
function confsOf(t) {
  const cfs = Array.isArray(t.confluences) ? t.confluences : [];
  const out = [], seen = {};
  for (let i = 0; i < cfs.length; i++) {
    const c = cfs[i];
    const nm = (c && typeof c.name === 'string') ? c.name.trim() : '';
    if (!nm) continue;
    const tf = (c && typeof c.timeframe === 'string' && c.timeframe.trim()) ? c.timeframe.trim() : '—';
    const key = nm.toLowerCase() + '|' + tf.toLowerCase();
    if (seen[key]) continue;
    seen[key] = 1;
    out.push({ name: nm, tf: tf });
  }
  return out;
}

// Every trader's trades in the last 7 days.
export async function loadAllTrades() {
  const { data, error } = await sbService()
    .from('trades').select('trade_data, account_type, created_at, user_id');
  if (error) throw new Error('trades read failed: ' + error.message);
  const cutoff = Date.now() - WINDOW_DAYS * 864e5;
  return (data || []).map(normTrade).filter(function (t) {
    const d = effDate(t); const ms = d ? Date.parse(d + 'T12:00:00Z') : 0;
    return ms >= cutoff;
  });
}

// ── real aggregations ───────────────────────────────────────────────
export function aggPulse(trades) {
  const users = {};
  trades.forEach(function (t) { if (t.user_id) users[t.user_id] = 1; });
  const net = trades.reduce(function (s, t) { return s + (num(t.pnl) || 0); }, 0);
  const symCount = {};
  trades.forEach(function (t) {
    const s = typeof t.sym === 'string' ? t.sym.trim().toUpperCase() : '';
    if (s) symCount[s] = (symCount[s] || 0) + 1;
  });
  const dominant_symbols = Object.keys(symCount)
    .sort(function (a, b) { return symCount[b] - symCount[a]; }).slice(0, 3);
  const confCount = {}, confTf = {};
  trades.forEach(function (t) {
    confsOf(t).forEach(function (c) {
      confCount[c.name] = (confCount[c.name] || 0) + 1;
      confTf[c.name] = confTf[c.name] || {};
      confTf[c.name][c.tf] = (confTf[c.name][c.tf] || 0) + 1;
    });
  });
  let domName = null, domN = -1;
  Object.keys(confCount).forEach(function (k) { if (confCount[k] > domN) { domN = confCount[k]; domName = k; } });
  let domTf = null;
  if (domName) {
    let tn = -1;
    Object.keys(confTf[domName]).forEach(function (tf) {
      if (confTf[domName][tf] > tn) { tn = confTf[domName][tf]; domTf = tf; }
    });
  }
  return {
    trade_count: trades.length,
    trader_count: Object.keys(users).length,
    net_pnl: round(net, 2),
    dominant_symbols: dominant_symbols,
    dominant_setup: domName ? { name: domName, tf: domTf } : null,
  };
}

export function aggSessions(trades) {
  return SESSIONS.map(function (name) {
    const ts = trades.filter(function (t) { return sessionOf(t) === name; });
    const wins = ts.filter(isWin).length;
    const rs = ts.map(signedR).filter(function (r) { return r != null; });
    return {
      session: name,
      win_rate: ts.length ? Math.round(wins / ts.length * 100) : 0,
      avg_rr: rs.length ? round(mean(rs), 2) : 0,
      trade_count: ts.length,
    };
  }).sort(function (a, b) { return b.win_rate - a.win_rate; });
}

export function aggConfluence(trades) {
  const total = trades.length || 1;
  const count = {};
  trades.forEach(function (t) {
    confsOf(t).forEach(function (c) {
      const key = c.name + '|' + c.tf;
      count[key] = count[key] || { confluence: c.name, tf: c.tf, n: 0 };
      count[key].n++;
    });
  });
  return Object.keys(count).map(function (k) { return count[k]; })
    .sort(function (a, b) { return b.n - a.n; })
    .slice(0, 5)
    .map(function (x) {
      return { confluence: x.confluence, tf: x.tf, percentage_of_trades: Math.round(x.n / total * 100) };
    });
}

export function aggCombos(trades) {
  const combo = {};
  trades.forEach(function (t) {
    const cs = confsOf(t);
    for (let i = 0; i < cs.length; i++) {
      for (let j = i + 1; j < cs.length; j++) {
        let a = cs[i], b = cs[j];
        if ((a.name + a.tf) > (b.name + b.tf)) { const tmp = a; a = b; b = tmp; }
        const key = a.name + '(' + a.tf + ')+' + b.name + '(' + b.tf + ')';
        const e = combo[key] || (combo[key] = {
          confluence_a: a.name, tf_a: a.tf, confluence_b: b.name, tf_b: b.tf, n: 0, wins: 0, rs: [],
        });
        e.n++;
        if (isWin(t)) e.wins++;
        const r = signedR(t); if (r != null) e.rs.push(r);
      }
    }
  });
  return Object.keys(combo).map(function (k) { return combo[k]; })
    .filter(function (e) { return e.n >= 3; })
    .map(function (e) {
      return {
        confluence_a: e.confluence_a, tf_a: e.tf_a,
        confluence_b: e.confluence_b, tf_b: e.tf_b,
        trade_count: e.n,
        win_rate: Math.round(e.wins / e.n * 100),
        avg_rr: e.rs.length ? round(mean(e.rs), 2) : 0,
      };
    })
    .sort(function (a, b) { return b.win_rate - a.win_rate; })
    .slice(0, 6);
}

export function aggContracts(trades) {
  const avgAll = mean(trades.map(totalQty));
  const avgW = mean(trades.filter(isWin).map(totalQty));
  const avgL = mean(trades.filter(isLoss).map(totalQty));
  let pct = 0;
  if (avgW && avgL) pct = Math.round((avgL - avgW) / avgW * 100);
  return {
    avg_size: round(avgAll, 1) || 0,
    avg_on_winners: round(avgW, 1) || 0,
    avg_on_losers: round(avgL, 1) || 0,
    percent_size_up_on_losers: pct,
  };
}

export function aggCoach(trades) {
  const sessions = aggSessions(trades);
  const combos = aggCombos(trades);
  const confs = aggConfluence(trades);
  const best = sessions[0];
  const observation = combos.length
    ? 'The strongest combo across the community is ' + combos[0].confluence_a + ' (' + combos[0].tf_a +
      ') + ' + combos[0].confluence_b + ' (' + combos[0].tf_b + ') — a ' + combos[0].win_rate +
      '% win rate over ' + combos[0].trade_count + ' trades.'
    : 'Traders are still building this week — not enough tagged setups yet to surface a standout combo.';
  const trend = (best && best.trade_count)
    ? best.session + ' is carrying the community right now: ' + best.win_rate + '% win rate at ' +
      (best.avg_rr >= 0 ? '+' : '') + best.avg_rr + ' average R:R.'
    : 'Session data is still thin across the community this week.';
  const worth_trying = confs.length
    ? confs[0].confluence + ' (' + confs[0].tf + ') shows up on ' + confs[0].percentage_of_trades +
      '% of logged trades — worth checking how it performs in your own log.'
    : 'Tag confluences with timeframes on your trades to compare your edge against the community.';
  return {
    observation: { title: 'Observation', body: observation },
    trend: { title: 'Trend', body: trend },
    worth_trying: { title: 'Worth Trying', body: worth_trying },
  };
}

// ── mock bundles (the four non-real communities) ────────────────────
const MOCK_SEEDS = {
  nq_scalpers:      { traders: 1240, trades: 2840, net: 128400, syms: ['NQ', 'MNQ'],       wrTop: 73, confs: ['FVG', 'Liq Sweep', 'Order Block', 'Breaker', 'BOS'] },
  ict_traders:      { traders: 3180, trades: 6120, net: 241900, syms: ['ES', 'NQ'],        wrTop: 69, confs: ['FVG', 'Liq Sweep', 'CISD', 'Order Block', 'MSS'] },
  ftmo_funded:      { traders: 920,  trades: 1980, net: 74200,  syms: ['EURUSD', 'GBPUSD'], wrTop: 66, confs: ['Order Block', 'FVG', 'Breaker', 'Liq Sweep', 'BOS'] },
  mes_mini_traders: { traders: 670,  trades: 1340, net: 38600,  syms: ['MES', 'ES'],       wrTop: 64, confs: ['FVG', 'BOS', 'Liq Sweep', 'Order Block', 'MSS'] },
};
const MOCK_TFS = ['15m', '1H', '5m', '4H'];

export function buildMock(id) {
  const s = MOCK_SEEDS[id];
  if (!s) return null;
  const combos = [];
  for (let i = 0; i < 6; i++) {
    combos.push({
      confluence_a: s.confs[i % s.confs.length],
      tf_a: MOCK_TFS[i % MOCK_TFS.length],
      confluence_b: s.confs[(i + 2) % s.confs.length],
      tf_b: MOCK_TFS[(i + 1) % MOCK_TFS.length],
      trade_count: 184 - i * 23,
      win_rate: s.wrTop - i * 7,
      avg_rr: round(2.4 - i * 0.33, 1),
    });
  }
  const sessWR = [s.wrTop - 3, s.wrTop - 10, s.wrTop - 1, s.wrTop - 19, s.wrTop - 13];
  const sessions = SESSIONS.map(function (name, i) {
    return { session: name, win_rate: sessWR[i], avg_rr: round(1.7 - i * 0.19, 1), trade_count: 460 - i * 64 };
  }).sort(function (a, b) { return b.win_rate - a.win_rate; });
  const usage = [28, 21, 16, 11, 7];
  const confluence = s.confs.map(function (c, i) {
    return { confluence: c, tf: MOCK_TFS[i % MOCK_TFS.length], percentage_of_trades: usage[i] };
  });
  const contracts = { avg_size: 1.8, avg_on_winners: 1.4, avg_on_losers: 2.3, percent_size_up_on_losers: 64 };
  const pulse = {
    trade_count: s.trades, trader_count: s.traders, net_pnl: s.net,
    dominant_symbols: s.syms,
    dominant_setup: { name: combos[0].confluence_a + ' + ' + combos[0].confluence_b, tf: combos[0].tf_a },
  };
  const coach = {
    observation: { title: 'Observation', body: 'The strongest combo here is ' + combos[0].confluence_a + ' (' + combos[0].tf_a + ') + ' + combos[0].confluence_b + ' (' + combos[0].tf_b + ') — a ' + combos[0].win_rate + '% win rate over ' + combos[0].trade_count + ' trades.' },
    trend: { title: 'Trend', body: sessions[0].session + ' is carrying the community: ' + sessions[0].win_rate + '% win rate at +' + sessions[0].avg_rr + ' average R:R this week.' },
    worth_trying: { title: 'Worth Trying', body: confluence[0].confluence + ' (' + confluence[0].tf + ') shows up on ' + confluence[0].percentage_of_trades + '% of trades here — worth checking how it performs in your own log.' },
  };
  return { pulse: pulse, coach: coach, combos: combos, sessions: sessions, confluence: confluence, contracts: contracts };
}

// ── endpoint wrapper ────────────────────────────────────────────────
// realFn(trades) runs for all_rewind_users; mockKey selects the slice of
// the generated bundle for the other communities.
export function communityEndpoint(realFn, mockKey) {
  return async function (req, res) {
    if (req.method !== 'GET') {
      res.status(405).json({ error: 'method not allowed', allowed: ['GET'] });
      return;
    }
    const user = await requirePro(req, res);
    if (!user) return;
    const cid = String((req.query && req.query.community_id) || 'all_rewind_users');
    if (!BY_ID[cid]) { res.status(400).json({ error: 'unknown community' }); return; }
    let payload;
    try {
      if (cid === 'all_rewind_users') {
        payload = realFn(await loadAllTrades());
      } else {
        payload = buildMock(cid)[mockKey];
      }
    } catch (e) {
      console.error('[community/' + mockKey + '] failed:', e && e.message);
      res.status(500).json({ error: 'aggregation failed' });
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json(payload);
  };
}
