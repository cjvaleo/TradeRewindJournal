// Trade analytics aggregation — the deterministic "data shape" object
// that feeds The Brief's templated insights. NO AI: every number here is
// computed straight from the user's `trades` rows.
//
// Source of truth: public.trades — columns id, user_id, trade_data (JSONB),
// account_type, journal, created_at. Every trade field lives inside
// trade_data: sym, type, entry, exit, stop, qty, accounts, date, session,
// pnl, rr, points, grade (letter), emotion (1-5), confidence (1-5),
// confluences [{name,timeframe}], account_type, created_at.
//
// Window: last 30 days (by trade date, falling back to created_at).

import { sbService } from './supabase.js';

const WINDOW_DAYS = 30;
const MIN_GROUP   = 3;  // min trades for a session/symbol/confluence group to surface
const R_MIN       = 5;  // min stop-set trades before R-multiple metrics are trustworthy

const DAY_NAMES  = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const DAY_SHORT  = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const SESSIONS   = ['Asia','London','NY AM','NY Lunch','NY PM'];
const EMOTION_KEY   = {5:'low_cortisol',4:'relaxed',3:'neutral',2:'elevated',1:'high_cortisol'};
const EMOTION_LABEL = {5:'Low Cortisol',4:'Relaxed',3:'Neutral',2:'Elevated',1:'High Cortisol'};
const CONF_KEY      = {5:'locked_in',4:'strong_read',3:'conviction',2:'hesitant',1:'coin_flip'};
const CONF_LABEL    = {5:'Locked In',4:'Strong Read',3:'Conviction',2:'Hesitant',1:'Coin Flip'};
// ET start time (minutes past midnight) for each killzone — used for the
// time-aware heads-up patterns.
const SESSION_OPEN_ET = { 'Asia':20*60, 'London':2*60, 'NY AM':9*60+30, 'NY Lunch':12*60, 'NY PM':13*60+30 };

// ── tiny numeric helpers ────────────────────────────────────────────
function num(v){ const n = Number(v); return Number.isFinite(n) ? n : null; }
function mean(arr){ return arr.length ? arr.reduce((s,x)=>s+x,0)/arr.length : null; }
function round(n,d){ if(n==null||!Number.isFinite(n)) return null; const f=Math.pow(10,d==null?2:d); return Math.round(n*f)/f; }
function isWin(t){ const p=num(t.pnl); return p!=null && p>0; }
function isLoss(t){ const p=num(t.pnl); return p!=null && p<0; }
// Signed R — stored rr can be unsigned depending on the save path, so
// normalize: magnitude of rr with the sign taken from P&L. rr === 0 is
// treated as "no R" — a stop-less trade saves rr:0, not null, and a real
// R-multiple is never exactly zero.
function signedR(t){
  const rr=num(t.rr), p=num(t.pnl);
  if(rr==null||rr===0||p==null) return null;
  return Math.abs(rr)*(p>=0?1:-1);
}
function effDate(t){
  if(typeof t.date==='string' && /^\d{4}-\d{2}-\d{2}/.test(t.date)) return t.date.slice(0,10);
  if(typeof t.created_at==='string' && t.created_at.length>=10) return t.created_at.slice(0,10);
  return null;
}
function totalQty(t){ return (num(t.qty)||1) * (num(t.accounts)||1); }

// Aggregate stats for an arbitrary set of trades.
function statsFor(trades){
  const n=trades.length;
  if(!n) return { count:0, win_rate:null, expectancy_R:null, net_pnl:0, avg_pnl:null, r_sample:0 };
  const wins=trades.filter(isWin).length;
  const pnls=trades.map(t=>num(t.pnl)||0);
  const rs=trades.map(signedR).filter(r=>r!=null);
  return {
    count:n,
    win_rate:round(wins/n,3),
    expectancy_R: rs.length ? round(mean(rs),2) : null,
    net_pnl:round(pnls.reduce((s,x)=>s+x,0),2),
    avg_pnl:round(mean(pnls),2),
    r_sample:rs.length
  };
}

// Group trades by a key fn → { key: [trades] }.
function groupBy(trades, keyFn){
  const out={};
  for(const t of trades){
    const k=keyFn(t);
    if(k==null||k==='') continue;
    (out[k]||(out[k]=[])).push(t);
  }
  return out;
}

// Pick the best/worst group: prefer expectancy_R when the group has an R
// sample, otherwise fall back to win_rate, then avg_pnl.
function rankGroups(groups, minCount){
  const rows=[];
  for(const [name,trades] of Object.entries(groups)){
    if(trades.length<(minCount||MIN_GROUP)) continue;
    const s=statsFor(trades);
    rows.push({ name, ...s });
  }
  return rows;
}
function sortByEdge(rows, dir){
  // dir 1 = best first, -1 = worst first.
  return rows.slice().sort((a,b)=>{
    const am=a.expectancy_R!=null?a.expectancy_R:(a.win_rate!=null?a.win_rate*4-2:a.avg_pnl/500);
    const bm=b.expectancy_R!=null?b.expectancy_R:(b.win_rate!=null?b.win_rate*4-2:b.avg_pnl/500);
    return dir>0 ? bm-am : am-bm;
  });
}

// ── ET clock (DST-aware via Intl) for the time-of-day heads-up ──────
function etNowMinutes(nowMs){
  try{
    const parts=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hour:'2-digit',minute:'2-digit',hour12:false,weekday:'short'}).formatToParts(new Date(nowMs));
    let h=0,m=0,wd='';
    for(const p of parts){ if(p.type==='hour')h=parseInt(p.value,10)%24; if(p.type==='minute')m=parseInt(p.value,10); if(p.type==='weekday')wd=p.value; }
    return { minutes:h*60+m, weekday:wd };
  }catch(e){ return null; }
}

/**
 * buildTraderAnalytics(userId, opts?)
 * Returns the full data-shape object. opts.nowMs lets tests pin "now".
 */
export async function buildTraderAnalytics(userId, opts){
  const nowMs = (opts && opts.nowMs) || Date.now();
  const sb = sbService();

  const { data: rows, error } = await sb
    .from('trades')
    .select('id, trade_data, account_type, created_at')
    .eq('user_id', userId);
  if(error) throw new Error('trades read failed: '+error.message);

  // Normalize rows → flat trade objects. trade_data is usually a JSONB
  // object but a handful of legacy rows were stored as a JSON string.
  const all=[];
  for(const r of (rows||[])){
    let td=r.trade_data;
    if(typeof td==='string'){ try{ td=JSON.parse(td); }catch(e){ td=null; } }
    if(!td||typeof td!=='object') continue;
    all.push({
      ...td,
      account_type: r.account_type || td.account_type || null,
      created_at:   r.created_at || td.created_at || null,
      _row_id:      r.id
    });
  }

  // 30-day window by effective date.
  const todayStr = new Date(nowMs).toISOString().slice(0,10);
  const cutoffMs = nowMs - WINDOW_DAYS*864e5;
  const inWindow=[];
  for(const t of all){
    const d=effDate(t);
    if(!d) continue;
    const dms=Date.parse(d+'T12:00:00Z');
    if(Number.isFinite(dms) && dms>=cutoffMs) inWindow.push(t);
  }
  // Chronological order (oldest → newest) for streak / sizing walks.
  inWindow.sort((a,b)=>{
    const ad=Date.parse((a.created_at||effDate(a)||'')+'')||0;
    const bd=Date.parse((b.created_at||effDate(b)||'')+'')||0;
    return ad-bd;
  });

  const trades=inWindow;
  const overall=statsFor(trades);
  const dates=trades.map(effDate).filter(Boolean).sort();

  // ── Sessions ──────────────────────────────────────────────────────
  const bySession=groupBy(trades, t=>SESSIONS.includes(t.session)?t.session:null);
  const sessionRows=rankGroups(bySession, MIN_GROUP);
  const sessionBest=sortByEdge(sessionRows,1)[0]||null;
  const sessionWorst=sortByEdge(sessionRows,-1)[0]||null;

  // ── Day of week ───────────────────────────────────────────────────
  const byDay=groupBy(trades, t=>{ const d=effDate(t); if(!d) return null; const wd=new Date(d+'T12:00:00Z').getUTCDay(); return DAY_NAMES[wd]; });
  const dayRows=Object.entries(byDay).filter(([,ts])=>ts.length>=2).map(([name,ts])=>({ name, ...statsFor(ts) }));
  const dayByPnl=dayRows.slice().sort((a,b)=>b.avg_pnl-a.avg_pnl);
  const dayBest=dayByPnl[0]||null;
  const dayWorst=dayByPnl[dayByPnl.length-1]||null;

  // ── Confluences (individual tags) ─────────────────────────────────
  const cfMap={};
  for(const t of trades){
    const cfs=Array.isArray(t.confluences)?t.confluences:[];
    const seen=new Set();
    for(const c of cfs){
      const nm=(c&&typeof c.name==='string')?c.name.trim():'';
      if(!nm||seen.has(nm.toLowerCase())) continue;
      seen.add(nm.toLowerCase());
      (cfMap[nm]||(cfMap[nm]=[])).push(t);
    }
  }
  const cfRows=rankGroups(cfMap, MIN_GROUP);
  const cfBest=sortByEdge(cfRows,1).slice(0,3);
  const cfWorst=sortByEdge(cfRows,-1).slice(0,3);

  // ── Symbols ───────────────────────────────────────────────────────
  const bySym=groupBy(trades, t=>(typeof t.sym==='string'&&t.sym.trim())?t.sym.trim().toUpperCase():null);
  const symRows=rankGroups(bySym, MIN_GROUP);
  const symBest=sortByEdge(symRows,1)[0]||null;
  const symWorst=sortByEdge(symRows,-1)[0]||null;

  // ── Account type ──────────────────────────────────────────────────
  const byAcct=groupBy(trades, t=>t.account_type||null);
  const acctRows=rankGroups(byAcct, MIN_GROUP);
  const acctBest=sortByEdge(acctRows,1)[0]||null;

  // ── Grade audit ───────────────────────────────────────────────────
  const grade_audit={};
  for(const [g,ts] of Object.entries(groupBy(trades, t=>(typeof t.grade==='string'?t.grade:null)))){
    const s=statsFor(ts);
    grade_audit[g]={ count:s.count, win_rate:s.win_rate, expectancy_R:s.expectancy_R, avg_pnl:s.avg_pnl };
  }

  // ── Emotion / Confidence audits ───────────────────────────────────
  function levelAudit(field, keyMap, labelMap){
    const out={};
    for(const [lvl,ts] of Object.entries(groupBy(trades, t=>{ const v=num(t[field]); return (v!=null&&keyMap[v])?v:null; }))){
      const s=statsFor(ts);
      out[keyMap[lvl]]={ label:labelMap[lvl], count:s.count, win_rate:s.win_rate, expectancy_R:s.expectancy_R, avg_pnl:s.avg_pnl };
    }
    return out;
  }
  const emotion_audit=levelAudit('emotion', EMOTION_KEY, EMOTION_LABEL);
  const confidence_audit=levelAudit('confidence', CONF_KEY, CONF_LABEL);

  // ── Recent trends — last 7d vs the prior window ───────────────────
  const sevenAgoMs=nowMs-7*864e5;
  const last7=trades.filter(t=>{ const d=effDate(t); const ms=d?Date.parse(d+'T12:00:00Z'):0; return ms>=sevenAgoMs; });
  const prior=trades.filter(t=>{ const d=effDate(t); const ms=d?Date.parse(d+'T12:00:00Z'):0; return ms<sevenAgoMs; });
  const s7=statsFor(last7), sPrior=statsFor(prior);
  const recent_trends={
    last_7d_win_rate:s7.win_rate, last_7d_count:s7.count, last_7d_expectancy_R:s7.expectancy_R, last_7d_net_pnl:s7.net_pnl,
    prior_win_rate:sPrior.win_rate, prior_count:sPrior.count, prior_expectancy_R:sPrior.expectancy_R,
    win_rate_delta:(s7.win_rate!=null&&sPrior.win_rate!=null)?round(s7.win_rate-sPrior.win_rate,3):null
  };

  // ── Sizing creep after losses ─────────────────────────────────────
  const afterLoss=[], normal=[];
  for(let i=0;i<trades.length;i++){
    const q=totalQty(trades[i]);
    if(i>=2 && isLoss(trades[i-1]) && isLoss(trades[i-2])) afterLoss.push(q);
    else normal.push(q);
  }
  const sizing_after_losses={
    normal_avg:round(mean(normal),2),
    after_2_losses_avg:round(mean(afterLoss),2),
    occurrences:afterLoss.length,
    creep_ratio:(mean(normal)&&afterLoss.length)?round(mean(afterLoss)/mean(normal),2):null
  };

  // ── Streaks ───────────────────────────────────────────────────────
  // Current overall streak (W/L) from the most recent trades backwards.
  let curStreakType=null, curStreakLen=0;
  for(let i=trades.length-1;i>=0;i--){
    const w=isWin(trades[i]), l=isLoss(trades[i]);
    if(!w&&!l) break;
    const ty=w?'win':'loss';
    if(curStreakType==null){ curStreakType=ty; curStreakLen=1; }
    else if(curStreakType===ty) curStreakLen++;
    else break;
  }
  // Best current per-session win streak.
  let sessionStreak=null;
  for(const sName of SESSIONS){
    const sts=trades.filter(t=>t.session===sName);
    let len=0;
    for(let i=sts.length-1;i>=0;i--){ if(isWin(sts[i])) len++; else break; }
    if(len>=2 && (!sessionStreak||len>sessionStreak.streak)) sessionStreak={ session:sName, streak:len, ...statsFor(sts) };
  }

  // ── Day × Session heatmap ─────────────────────────────────────────
  const heatCells={};
  for(const t of trades){
    const d=effDate(t); if(!d||!SESSIONS.includes(t.session)) continue;
    const dayShort=DAY_SHORT[new Date(d+'T12:00:00Z').getUTCDay()];
    const key=dayShort+'|'+t.session;
    (heatCells[key]||(heatCells[key]=[])).push(t);
  }
  const day_session_heatmap=Object.entries(heatCells).map(([k,ts])=>{
    const [day,session]=k.split('|'); const s=statsFor(ts);
    return { day, session, count:s.count, win_rate:s.win_rate, expectancy_R:s.expectancy_R, pnl:s.net_pnl };
  });

  // ── Days-since-last-trade + ET clock context ──────────────────────
  let daysSinceLast=null;
  if(dates.length){
    const lastMs=Date.parse(dates[dates.length-1]+'T12:00:00Z');
    daysSinceLast=Math.floor((nowMs-lastMs)/864e5);
  }
  const et=etNowMinutes(nowMs);
  let nextSession=null;
  if(et){
    let best=null;
    for(const s of SESSIONS){
      let delta=SESSION_OPEN_ET[s]-et.minutes;
      if(delta<0) delta+=24*60;
      if(best==null||delta<best.in_minutes) best={ session:s, in_minutes:delta };
    }
    nextSession=best;
  }
  const r_sample_total=trades.map(signedR).filter(r=>r!=null).length;

  return {
    generated_at:new Date(nowMs).toISOString(),
    window_days:WINDOW_DAYS,
    trade_count:trades.length,
    total_trade_count:all.length,
    date_range:{ from:dates[0]||null, to:dates[dates.length-1]||null },
    win_rate:overall.win_rate,
    expectancy_R:overall.expectancy_R,
    net_pnl:overall.net_pnl,
    avg_pnl:overall.avg_pnl,
    r_available:r_sample_total>=R_MIN,
    r_sample:r_sample_total,
    best_session:sessionBest,
    worst_session:sessionWorst,
    all_sessions:sortByEdge(sessionRows,1),
    best_day:dayBest,
    worst_day:dayWorst,
    all_days:dayRows,
    best_confluences:cfBest,
    worst_confluences:cfWorst,
    best_symbol:symBest,
    worst_symbol:symWorst,
    best_account:acctBest,
    grade_audit,
    emotion_audit,
    confidence_audit,
    recent_trends,
    sizing_after_losses,
    streak:{ type:curStreakType, length:curStreakLen },
    session_streak:sessionStreak,
    day_session_heatmap,
    context:{
      today:DAY_NAMES[new Date(nowMs).getUTCDay()],
      today_str:todayStr,
      days_since_last_trade:daysSinceLast,
      et_minutes:et?et.minutes:null,
      next_session:nextSession
    }
  };
}

export const _internals = { statsFor, signedR, effDate, SESSIONS, DAY_NAMES };
