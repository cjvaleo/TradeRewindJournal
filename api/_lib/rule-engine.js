// Review-system auto-evaluation engine — pure deterministic logic.
//
// evaluateTrade(trade, rules, ctx) inspects each rule's condition JSONB
// against one trade and returns
//   [{ rule_id, status, auto_detected_status, cost_impact }]
//
//   status               'followed' | 'broken' | 'pending_review'
//   auto_detected_status  'followed' | 'broken' | 'unknown' | null
//
// 'data' rules auto-resolve to followed/broken (or 'unknown' → pending
// when the trade lacks the field, e.g. no entry timestamp). 'subjective'
// rules always land 'pending_review' for the user to self-review.
//
// ctx = { dayTrades }  — every trade on the same trading day, chronological
// (oldest → newest), so day-level rules (max-trades, revenge) have context.

const DAY_NAMES = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];

function num(v){ const n = Number(v); return Number.isFinite(n) ? n : null; }
function tradeQty(t){ return num(t && t.qty) || 1; }
function tradePnl(t){ return num(t && t.pnl); }
function tradeDate(t){
  if(t && typeof t.date==='string' && /^\d{4}-\d{2}-\d{2}/.test(t.date)) return t.date.slice(0,10);
  if(t && typeof t.created_at==='string' && t.created_at.length>=10) return t.created_at.slice(0,10);
  return null;
}
// 'NY AM' → 'NY_AM' so trade.session and condition.allowed_sessions compare.
function normSession(s){ return String(s||'').trim().toUpperCase().replace(/\s+/g,'_'); }
function dayName(dateStr){
  if(!dateStr) return null;
  const ms = Date.parse(dateStr+'T12:00:00Z');
  if(!Number.isFinite(ms)) return null;
  return DAY_NAMES[new Date(ms).getUTCDay()];
}
// Index of this trade within the chronological day list (-1 if absent).
function dayIndex(trade, ctx){
  const list = (ctx && Array.isArray(ctx.dayTrades)) ? ctx.dayTrades : [];
  const tid = trade && (trade.id != null ? String(trade.id) : null);
  if(tid != null){
    for(let i=0;i<list.length;i++){ if(String(list[i].id)===tid) return i; }
  }
  return -1;
}

// Each evaluator → 'followed' | 'broken' | 'unknown'.
const EVALUATORS = {
  max_trades_per_day(trade, cond, ctx){
    const limit = num(cond.value) || 0;
    const idx = dayIndex(trade, ctx);
    const list = (ctx && ctx.dayTrades) || [];
    // Position in the day: 1-based. Unknown trade → fall back to day count.
    const position = idx >= 0 ? idx+1 : list.length;
    return position > limit ? 'broken' : 'followed';
  },
  session_restriction(trade, cond){
    if(!trade.session) return 'unknown';
    const allowed = (cond.allowed_sessions||[]).map(normSession);
    return allowed.indexOf(normSession(trade.session)) >= 0 ? 'followed' : 'broken';
  },
  skip_day_of_week(trade, cond){
    const d = dayName(tradeDate(trade));
    if(!d) return 'unknown';
    const skip = (cond.days||[]).map(x=>String(x).toLowerCase());
    return skip.indexOf(d) >= 0 ? 'broken' : 'followed';
  },
  min_confluences(trade, cond){
    const need = num(cond.value) || 0;
    const have = Array.isArray(trade.confluences) ? trade.confluences.length : 0;
    return have >= need ? 'followed' : 'broken';
  },
  stop_loss_required(trade){
    const s = num(trade.stop);
    return (s != null && s > 0) ? 'followed' : 'broken';
  },
  max_contract_size(trade, cond){
    const limit = num(cond.value) || 0;
    return tradeQty(trade) <= limit ? 'followed' : 'broken';
  },
  no_first_n_min_of_session(){
    // Trades carry no reliable entry timestamp — can't auto-detect.
    return 'unknown';
  },
  journal_entry_required(trade){
    const notes = (trade.notes != null ? String(trade.notes) : '').trim();
    return notes ? 'followed' : 'broken';
  },
  no_revenge_trade(trade, cond, ctx){
    const n = num(cond.after_n_losses) || 2;
    const idx = dayIndex(trade, ctx);
    const list = (ctx && ctx.dayTrades) || [];
    if(idx < n) return 'followed'; // not enough prior trades to be a revenge entry
    for(let i = idx-1; i >= idx-n; i--){
      const p = tradePnl(list[i]);
      if(p == null || p >= 0) return 'followed'; // a prior trade wasn't a loss
    }
    return 'broken'; // the n trades right before this one all lost
  },
  subjective_check(){ return 'unknown'; }, // never auto-resolved
};

function isSubjective(rule){
  return rule.rule_type === 'subjective' ||
    !!(rule.condition && rule.condition.type === 'subjective_check');
}

/**
 * Evaluate one trade against a list of rules.
 * Returns [{ rule_id, status, auto_detected_status, cost_impact }].
 */
export function evaluateTrade(trade, rules, ctx){
  ctx = ctx || {};
  const pnl = tradePnl(trade);
  const out = [];
  for(const rule of (rules || [])){
    if(isSubjective(rule)){
      out.push({ rule_id: rule.id, status: 'pending_review', auto_detected_status: null, cost_impact: null });
      continue;
    }
    const cond = rule.condition || {};
    const fn = EVALUATORS[cond.type];
    let detected = 'unknown';
    try { if(fn) detected = fn(trade, cond, ctx); }
    catch(e){ detected = 'unknown'; }

    let status, auto;
    if(detected === 'followed'){ status = 'followed'; auto = 'followed'; }
    else if(detected === 'broken'){ status = 'broken'; auto = 'broken'; }
    else { status = 'pending_review'; auto = 'unknown'; }

    // Cost of a broken rule = the dollars it lost on this trade (0 if the
    // rule was broken but the trade still won; null when not broken).
    let cost = null;
    if(status === 'broken') cost = (pnl != null && pnl < 0) ? Math.round(pnl*100)/100 : 0;

    out.push({ rule_id: rule.id, status, auto_detected_status: auto, cost_impact: cost });
  }
  return out;
}

export const CONDITION_TYPES = Object.keys(EVALUATORS);
