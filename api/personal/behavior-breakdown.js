// GET /api/personal/behavior-breakdown
// How the user's logged states correlate with outcomes. Three dimensions —
// Discipline (confidence), Emotion (cortisol), Setup Grade — each with a
// state distribution, per-state win rates, and a 4-week win-rate trend.
// Pro-gated. Computed from the trades table, last 30 days.

import { sbService } from '../_lib/supabase.js';
import { requirePro } from '../_lib/auth.js';

const WINDOW_DAYS = 30;

// confidence 1-5 / emotion 1-5 → 4 display buckets.
const CONF_BUCKET  = { 5:'locked_in', 4:'confident', 3:'hesitant', 2:'hesitant', 1:'tilted' };
const EMO_BUCKET   = { 5:'low', 4:'low', 3:'neutral', 2:'elevated', 1:'high' };
const GRADE_BUCKET = { 'A+':'A+', 'A':'A', 'B':'B', 'C':'C', 'D':'C', 'F':'C' };
const ORDER = {
  discipline: ['locked_in','confident','hesitant','tilted'],
  emotion:    ['low','neutral','elevated','high'],
  grade:      ['A+','A','B','C'],
};

function num(v){ const n = Number(v); return Number.isFinite(n) ? n : null; }
function isWin(t){ const p = num(t.pnl); return p != null && p > 0; }
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

// One dimension → { distribution, win_rates, trend_4_week }.
function buildDimension(trades, order, bucketFn, nowMs){
  const buckets = {};
  order.forEach(function(s){ buckets[s] = []; });
  trades.forEach(function(t){
    const b = bucketFn(t);
    if(b && buckets[b]) buckets[b].push(t);
  });
  const total = order.reduce(function(s,k){ return s + buckets[k].length; }, 0);
  const distribution = order.map(function(s){
    return { state:s, pct: total ? Math.round(buckets[s].length/total*100) : 0 };
  });
  const win_rates = order.map(function(s){
    const ts = buckets[s], w = ts.filter(isWin).length;
    return { state:s, win_rate: ts.length ? Math.round(w/ts.length*100) : null, count: ts.length };
  });
  // 4-week win-rate trend (week 1 oldest → week 4 most recent).
  const trend_4_week = [];
  for(let w=0; w<4; w++){
    const hi = nowMs - (3-w)*7*864e5;
    const lo = hi - 7*864e5;
    const ts = trades.filter(function(t){
      const d = effDate(t); const ms = d ? Date.parse(d+'T12:00:00Z') : 0;
      return ms > lo && ms <= hi && bucketFn(t);
    });
    const win = ts.filter(isWin).length;
    trend_4_week.push({ week: w+1, pct: ts.length ? Math.round(win/ts.length*100) : 0 });
  }
  return { distribution, win_rates, trend_4_week, total };
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
    console.error('[personal/behavior-breakdown] read failed:', error.message);
    res.status(500).json({ error:'trades read failed' });
    return;
  }

  const nowMs = Date.now();
  const cutoff = nowMs - WINDOW_DAYS*864e5;
  const trades = (rows||[]).map(normTrade).filter(function(t){
    const d = effDate(t); const ms = d ? Date.parse(d+'T12:00:00Z') : 0;
    return ms >= cutoff;
  });

  const payload = {
    window_days: WINDOW_DAYS,
    trade_count: trades.length,
    discipline: buildDimension(trades, ORDER.discipline, function(t){ return CONF_BUCKET[num(t.confidence)]; }, nowMs),
    emotion:    buildDimension(trades, ORDER.emotion,    function(t){ return EMO_BUCKET[num(t.emotion)]; }, nowMs),
    grade:      buildDimension(trades, ORDER.grade,      function(t){ return GRADE_BUCKET[String(t.grade||'').toUpperCase()]; }, nowMs),
  };
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json(payload);
}
