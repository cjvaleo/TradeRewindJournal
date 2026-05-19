// Shared aggregation for the Review → Community tab endpoints.
// Communities + memberships live in the `communities` table (owner_id +
// a `members` uuid[] array — no junction table). Every endpoint resolves
// a community to its real member set and aggregates that set's trades
// over a selectable range (7d / 30d / all). Deterministic, no AI.

import { sbService } from './supabase.js';
import { requirePro } from './auth.js';

const SESSIONS = ['Asia', 'London', 'NY AM', 'Lunch', 'NY PM'];
const CONF_LABEL = { 5: 'Locked In', 4: 'Strong Read', 3: 'Conviction', 2: 'Hesitant', 1: 'Coin Flip' };
const EMO_LABEL  = { 5: 'Low Cortisol', 4: 'Relaxed', 3: 'Neutral', 2: 'Elevated', 1: 'High Cortisol' };

// ── range ───────────────────────────────────────────────────────────
export function parseRange(v) {
  return (v === '30d' || v === 'all') ? v : '7d';
}
function rangeDays(range) {
  if (range === '30d') return 30;
  if (range === 'all') return null;   // no cutoff
  return 7;
}

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
function comboPairs(t) {
  const cs = confsOf(t), pairs = [];
  for (let i = 0; i < cs.length; i++) {
    for (let j = i + 1; j < cs.length; j++) {
      let a = cs[i], b = cs[j];
      if ((a.name + a.tf) > (b.name + b.tf)) { const tmp = a; a = b; b = tmp; }
      pairs.push({ key: a.name + '(' + a.tf + ')+' + b.name + '(' + b.tf + ')', a: a, b: b });
    }
  }
  return pairs;
}

// ── membership ──────────────────────────────────────────────────────
export function communityMemberIds(row) {
  const ids = {};
  if (row && Array.isArray(row.members)) {
    row.members.forEach(function (id) { if (id) ids[id] = 1; });
  }
  if (row && row.owner_id) ids[row.owner_id] = 1;
  return Object.keys(ids);
}

export async function loadCommunity(id) {
  const { data, error } = await sbService()
    .from('communities').select('id, name, owner_id, members, created_at')
    .eq('id', id).maybeSingle();
  if (error) throw new Error('community read failed: ' + error.message);
  return data || null;
}

// Trades for a set of member user_ids over the chosen range.
export async function loadMemberTrades(memberIds, range) {
  if (!memberIds || !memberIds.length) return [];
  const { data, error } = await sbService()
    .from('trades').select('trade_data, account_type, created_at, user_id')
    .in('user_id', memberIds);
  if (error) throw new Error('trades read failed: ' + error.message);
  let rows = (data || []).map(normTrade);
  const days = rangeDays(range);
  if (days != null) {
    const cutoff = Date.now() - days * 864e5;
    rows = rows.filter(function (t) {
      const d = effDate(t); const ms = d ? Date.parse(d + 'T12:00:00Z') : 0;
      return ms >= cutoff;
    });
  }
  return rows;
}

// ── aggregations ────────────────────────────────────────────────────
export function aggPulse(trades, ctx) {
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
    trader_count: (ctx && ctx.memberCount) || 0,
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
    comboPairs(t).forEach(function (p) {
      const e = combo[p.key] || (combo[p.key] = {
        confluence_a: p.a.name, tf_a: p.a.tf, confluence_b: p.b.name, tf_b: p.b.tf, n: 0, wins: 0, rs: [],
      });
      e.n++;
      if (isWin(t)) e.wins++;
      const r = signedR(t); if (r != null) e.rs.push(r);
    });
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

// ── group stats ─────────────────────────────────────────────────────
// Community-wide aggregate for the range. `points` lives in trade_data
// (signed: positive on wins, negative on losses); trades without a
// numeric points value are skipped from the points averages only.
export function aggGroupStats(trades, ctx) {
  const wins = trades.filter(isWin);
  const losses = trades.filter(isLoss);
  const rs = trades.map(signedR).filter(function (r) { return r != null; });
  const winPts = wins.map(function (t) { return num(t.points); }).filter(function (p) { return p != null; });
  const lossPts = losses.map(function (t) { return num(t.points); }).filter(function (p) { return p != null; });
  const net = trades.reduce(function (s, t) { return s + (num(t.pnl) || 0); }, 0);
  return {
    total_trades: trades.length,
    trader_count: (ctx && ctx.memberCount) || 0,
    win_rate: trades.length ? Math.round(wins.length / trades.length * 100) : 0,
    avg_rr: rs.length ? round(mean(rs), 1) : 0,
    avg_points_per_win: winPts.length ? round(mean(winPts), 1) : 0,
    avg_points_per_loss: lossPts.length ? round(mean(lossPts), 1) : 0,
    net_pnl: round(net, 2),
  };
}

// ── top performers ──────────────────────────────────────────────────
// Ranks community members by net P&L over the range, takes the top 25%,
// and profiles that cohort's trading behavior.
export function topPerformers(trades, ctx) {
  const memberIds = (ctx && ctx.memberIds) || [];
  const total_count = memberIds.length;
  if (total_count < 4) {
    return { insufficient: true, total_count: total_count, top_count: 0 };
  }

  const netBy = {}, tradesBy = {};
  memberIds.forEach(function (id) { netBy[id] = 0; });
  trades.forEach(function (t) {
    if (!(t.user_id in netBy)) return;
    netBy[t.user_id] += (num(t.pnl) || 0);
    (tradesBy[t.user_id] || (tradesBy[t.user_id] = [])).push(t);
  });
  const ranked = memberIds.slice().sort(function (a, b) { return netBy[b] - netBy[a]; });
  const top_count = Math.ceil(total_count * 0.25);
  const topIds = ranked.slice(0, top_count);
  const topSet = {}; topIds.forEach(function (id) { topSet[id] = 1; });
  const topTrades = trades.filter(function (t) { return topSet[t.user_id]; });

  if (!topTrades.length) {
    return { insufficient: true, total_count: total_count, top_count: top_count };
  }

  // headline
  const wins = topTrades.filter(isWin).length;
  const rs = topTrades.map(signedR).filter(function (r) { return r != null; });
  const topNet = topIds.reduce(function (s, id) { return s + (netBy[id] || 0); }, 0);
  const headline_stats = {
    win_rate: Math.round(wins / topTrades.length * 100),
    avg_rr: rs.length ? round(mean(rs), 1) : 0,
    avg_net_per_member: Math.round(topNet / top_count),
    total_trades: topTrades.length,
  };

  // trades_per_day — per member: trades ÷ distinct active days
  function memberTpd(id) {
    const ts = tradesBy[id] || [];
    if (!ts.length) return null;
    const days = {};
    ts.forEach(function (t) { const d = effDate(t); if (d) days[d] = 1; });
    return ts.length / (Object.keys(days).length || 1);
  }
  const topTpd = topIds.map(memberTpd).filter(function (v) { return v != null; }).sort(function (a, b) { return a - b; });
  let medianTpd = 0;
  if (topTpd.length) {
    const mid = Math.floor(topTpd.length / 2);
    medianTpd = topTpd.length % 2 ? topTpd[mid] : (topTpd[mid - 1] + topTpd[mid]) / 2;
  }
  const m = Math.max(1, Math.round(medianTpd));
  const allTpd = memberIds.map(memberTpd).filter(function (v) { return v != null; });
  const trades_per_day = {
    value: Math.max(0, m - 1) + '-' + (m + 1),
    community_avg: allTpd.length ? Math.round(mean(allTpd)) : 0,
  };

  // top_setup — most common confluence pair
  const comboCount = {};
  topTrades.forEach(function (t) {
    const seen = {};
    comboPairs(t).forEach(function (p) {
      if (seen[p.key]) return;
      seen[p.key] = 1;
      comboCount[p.key] = comboCount[p.key] ||
        { confluence_a: p.a.name, tf_a: p.a.tf, confluence_b: p.b.name, tf_b: p.b.tf, n: 0 };
      comboCount[p.key].n++;
    });
  });
  let topCombo = null;
  Object.keys(comboCount).forEach(function (k) { if (!topCombo || comboCount[k].n > topCombo.n) topCombo = comboCount[k]; });
  const top_setup = topCombo ? {
    confluence_a: topCombo.confluence_a, tf_a: topCombo.tf_a,
    confluence_b: topCombo.confluence_b, tf_b: topCombo.tf_b,
    percent_of_trades: Math.round(topCombo.n / topTrades.length * 100),
  } : null;

  // best_session
  const sessCount = {};
  topTrades.forEach(function (t) { const s = sessionOf(t); if (s) sessCount[s] = (sessCount[s] || 0) + 1; });
  let bestSess = null, bestN = -1;
  Object.keys(sessCount).forEach(function (s) { if (sessCount[s] > bestN) { bestN = sessCount[s]; bestSess = s; } });
  const best_session = bestSess
    ? { name: bestSess, percent_of_volume: Math.round(bestN / topTrades.length * 100) }
    : null;

  // grade_adherence
  const gradeCount = {}; let graded = 0;
  topTrades.forEach(function (t) {
    const g = typeof t.grade === 'string' ? t.grade.trim().toUpperCase() : '';
    if (!g) return;
    graded++; gradeCount[g] = (gradeCount[g] || 0) + 1;
  });
  let grade_adherence;
  if (graded) {
    const aPct = Math.round(((gradeCount['A'] || 0) + (gradeCount['A+'] || 0)) / topTrades.length * 100);
    if (aPct >= 80) {
      grade_adherence = { value: 'A or A+', percent_of_entries: aPct };
    } else {
      let topG = null, topGN = -1;
      Object.keys(gradeCount).forEach(function (g) { if (gradeCount[g] > topGN) { topGN = gradeCount[g]; topG = g; } });
      grade_adherence = { value: topG || '—', percent_of_entries: Math.round(topGN / topTrades.length * 100) };
    }
  } else {
    grade_adherence = { value: '—', percent_of_entries: 0 };
  }

  // pre_trade_state — confidence + emotion combo
  const stateCount = {};
  topTrades.forEach(function (t) {
    const c = num(t.confidence), e = num(t.emotion);
    if (c == null || e == null || !CONF_LABEL[c] || !EMO_LABEL[e]) return;
    const key = c + '|' + e;
    stateCount[key] = stateCount[key] || { label: CONF_LABEL[c] + ' + ' + EMO_LABEL[e], n: 0 };
    stateCount[key].n++;
  });
  let topState = null;
  Object.keys(stateCount).forEach(function (k) { if (!topState || stateCount[k].n > topState.n) topState = stateCount[k]; });
  const pre_trade_state = topState
    ? { value: topState.label, percent_of_entries: Math.round(topState.n / topTrades.length * 100) }
    : { value: '—', percent_of_entries: 0 };

  // takeaway — templated, framed against the community-wide volume
  const topPct = trades.length ? Math.round(topTrades.length / trades.length * 100) : 0;
  const sessionsClause = (best_session && best_session.percent_of_volume >= 40)
    ? best_session.name
    : 'specific sessions';
  const takeaway = 'Top performers concentrate ' + topPct + '% of community volume into ' +
    topTrades.length + ' trades — and produce most of the profit. They take ' +
    trades_per_day.value + ' trades a day, in ' + sessionsClause + ', with their head right.';

  return {
    top_count: top_count,
    total_count: total_count,
    headline_stats: headline_stats,
    behaviors: {
      trades_per_day: trades_per_day,
      top_setup: top_setup,
      best_session: best_session,
      grade_adherence: grade_adherence,
      pre_trade_state: pre_trade_state,
    },
    takeaway: takeaway,
  };
}

// ── trader of the day ───────────────────────────────────────────────
// The member with the highest net P&L across their trades dated today.
// `today` is the YYYY-MM-DD the caller considers "today" (the endpoint
// derives it from the viewer's tz_offset so late-evening trades land on
// the right day); falls back to the server UTC date. Tie-break: most
// recent trade (latest created_at). Returns null when no member has a
// trade dated today. Username + privacy hash are resolved by the endpoint.
export function traderOfTheDay(trades, today) {
  if (!today) today = new Date().toISOString().slice(0, 10);
  const todays = trades.filter(function (t) { return effDate(t) === today; });
  if (!todays.length) return null;

  const byUser = {};
  todays.forEach(function (t) {
    const uid = t.user_id;
    if (!uid) return;
    const e = byUser[uid] || (byUser[uid] = { user_id: uid, net: 0, trades: [] });
    e.net += (num(t.pnl) || 0);
    e.trades.push(t);
  });
  const users = Object.keys(byUser).map(function (k) { return byUser[k]; });
  if (!users.length) return null;

  function lastTs(u) {
    return u.trades.reduce(function (m, t) {
      const ms = Date.parse(t.created_at || '') || 0;
      return ms > m ? ms : m;
    }, 0);
  }
  users.sort(function (a, b) {
    if (b.net !== a.net) return b.net - a.net;        // highest net P&L
    return lastTs(b) - lastTs(a);                     // tie-break: most recent
  });
  const win = users[0];

  const ordered = win.trades.slice().sort(function (a, b) {
    return (Date.parse(a.created_at || '') || 0) - (Date.parse(b.created_at || '') || 0);
  });
  const trades_today = ordered.map(function (t, i) {
    const accts = num(t.accounts);
    return {
      trade_number: i + 1,
      symbol: (typeof t.sym === 'string' && t.sym.trim()) ? t.sym.trim() : '—',
      contracts: num(t.qty),
      accounts: (accts != null && accts > 1) ? accts : null,
      points: num(t.points),
    };
  });
  return {
    user_id: win.user_id,
    net_pnl_today: round(win.net, 2),
    trades_today: trades_today,
  };
}

// ── endpoint wrapper ────────────────────────────────────────────────
// Auth + Pro, resolve community_id → member set, authorize the caller is
// a member, then aggregate that set's trades over `range` via realFn.
export function communityEndpoint(realFn) {
  return async function (req, res) {
    if (req.method !== 'GET') {
      res.status(405).json({ error: 'method not allowed', allowed: ['GET'] });
      return;
    }
    const user = await requirePro(req, res);
    if (!user) return;
    const cid = (req.query && req.query.community_id) ? String(req.query.community_id) : null;
    if (!cid) { res.status(400).json({ error: 'community_id required' }); return; }
    const range = parseRange(req.query && req.query.range);

    let row;
    try {
      row = await loadCommunity(cid);
    } catch (e) {
      console.error('[community] community read failed:', e && e.message);
      res.status(500).json({ error: 'community read failed' });
      return;
    }
    if (!row) { res.status(404).json({ error: 'community not found' }); return; }

    const memberIds = communityMemberIds(row);
    if (memberIds.indexOf(user.id) < 0) {
      res.status(403).json({ error: 'not_a_member', message: 'You are not a member of this community.' });
      return;
    }

    let payload;
    try {
      const trades = await loadMemberTrades(memberIds, range);
      payload = realFn(trades, { memberCount: memberIds.length, memberIds: memberIds, range: range });
    } catch (e) {
      console.error('[community] aggregation failed:', e && e.message);
      res.status(500).json({ error: 'aggregation failed' });
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json(payload);
  };
}
