// GET /api/personal/overview
// Powers the Equity Curve hero on the Personal tab — a 30-day summary
// (net P&L / win rate / avg R:R / trade count) plus a daily cumulative
// P&L curve. Pro-gated.

import { sbService } from '../_lib/supabase.js';
import { requirePro } from '../_lib/auth.js';

const WINDOW_DAYS = 30;

function num(v){ const n = Number(v); return Number.isFinite(n) ? n : null; }
function effDate(t){
  if(typeof t.date==='string' && /^\d{4}-\d{2}-\d{2}/.test(t.date)) return t.date.slice(0,10);
  if(typeof t.created_at==='string' && t.created_at.length>=10) return t.created_at.slice(0,10);
  return null;
}
function normTrade(row){
  let td = row.trade_data;
  if(typeof td==='string'){ try{ td = JSON.parse(td); }catch(e){ td = {}; } }
  if(!td || typeof td!=='object') td = {};
  return { ...td, created_at: row.created_at };
}

export default async function handler(req, res){
  if(req.method !== 'GET'){
    res.status(405).json({ error:'method not allowed', allowed:['GET'] });
    return;
  }
  const user = await requirePro(req, res);
  if(!user) return;

  const { data: rows, error } = await sbService()
    .from('trades')
    .select('trade_data, created_at')
    .eq('user_id', user.id);
  if(error){
    console.error('[personal/overview] read failed:', error.message);
    res.status(500).json({ error:'trades read failed' });
    return;
  }

  const nowMs = Date.now();
  const cutoff = nowMs - WINDOW_DAYS*864e5;
  const trades = (rows||[])
    .map(normTrade)
    .filter(function(t){
      const d = effDate(t); const ms = d ? Date.parse(d+'T12:00:00Z') : 0;
      return ms >= cutoff;
    })
    .sort(function(a,b){ return (effDate(a)||'').localeCompare(effDate(b)||''); });

  // ── Summary ──────────────────────────────────────────────────────
  const pnls = trades.map(function(t){ return num(t.pnl) || 0; });
  const wins = trades.filter(function(t){ return (num(t.pnl)||0) > 0; }).length;
  const rrs  = trades.map(function(t){ return num(t.rr); }).filter(function(r){ return r!=null && r!==0; });
  const netPnl = pnls.reduce(function(s,x){ return s+x; }, 0);
  // Session 20a — total points over the window (signed; setup quality).
  const totalPoints = trades.reduce(function(s,t){ return s + (num(t.points)||0); }, 0);
  const summary = {
    net_pnl: Math.round(netPnl*100)/100,
    win_rate: trades.length ? Math.round(wins/trades.length*100) : null,
    avg_rr: rrs.length ? Math.round(rrs.reduce(function(s,x){ return s+Math.abs(x); },0)/rrs.length*100)/100 : null,
    trade_count: trades.length,
    total_points: Math.round(totalPoints*10)/10,
  };

  // ── Daily cumulative curve ───────────────────────────────────────
  const byDay = {};
  trades.forEach(function(t){
    const d = effDate(t); if(!d) return;
    byDay[d] = (byDay[d] || 0) + (num(t.pnl) || 0);
  });
  let running = 0;
  const curve = Object.keys(byDay).sort().map(function(d){
    running += byDay[d];
    return { date: d, cumulative: Math.round(running*100)/100 };
  });

  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({ window_days: WINDOW_DAYS, summary, curve });
}
