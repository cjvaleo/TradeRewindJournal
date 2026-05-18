// Shared aggregation for the Review → Community tab endpoints.
// Communities + memberships live in the `communities` table (owner_id +
// a `members` uuid[] array — no junction table). Every endpoint resolves
// a community to its real member set and aggregates that set's trades
// over the last 7 days. Deterministic, no AI.

import { sbService } from './supabase.js';
import { requirePro } from './auth.js';

const WINDOW_DAYS = 7;
const SESSIONS = ['Asia', 'London', 'NY AM', 'Lunch', 'NY PM'];

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

// ── membership ──────────────────────────────────────────────────────
// A community's full member set — the members[] array plus the owner
// (the union; the owner is not always present in members[]).
export function communityMemberIds(row) {
  const ids = {};
  if (row && Array.isArray(row.members)) {
    row.members.forEach(function (id) { if (id) ids[id] = 1; });
  }
  if (row && row.owner_id) ids[row.owner_id] = 1;
  return Object.keys(ids);
}

// One community row by id, or null.
export async function loadCommunity(id) {
  const { data, error } = await sbService()
    .from('communities').select('id, name, owner_id, members, created_at')
    .eq('id', id).maybeSingle();
  if (error) throw new Error('community read failed: ' + error.message);
  return data || null;
}

// Last-7-day trades for a set of member user_ids.
export async function loadMemberTrades(memberIds) {
  if (!memberIds || !memberIds.length) return [];
  const { data, error } = await sbService()
    .from('trades').select('trade_data, account_type, created_at, user_id')
    .in('user_id', memberIds);
  if (error) throw new Error('trades read failed: ' + error.message);
  const cutoff = Date.now() - WINDOW_DAYS * 864e5;
  return (data || []).map(normTrade).filter(function (t) {
    const d = effDate(t); const ms = d ? Date.parse(d + 'T12:00:00Z') : 0;
    return ms >= cutoff;
  });
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
    : 'Members are still building this week — not enough tagged setups yet to surface a standout combo.';
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

// ── endpoint wrapper ────────────────────────────────────────────────
// Auth + Pro, resolve community_id → member set, authorize the caller is
// a member, then aggregate that set's last-7-day trades via realFn.
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
      const trades = await loadMemberTrades(memberIds);
      payload = realFn(trades, { memberCount: memberIds.length });
    } catch (e) {
      console.error('[community] aggregation failed:', e && e.message);
      res.status(500).json({ error: 'aggregation failed' });
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json(payload);
  };
}
