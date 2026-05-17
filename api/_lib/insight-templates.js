// Insight templates — deterministic pattern detection + wording library
// for The Brief. This replaces the AI prompts entirely: every detector
// inspects the analytics object from trade-analytics.js, scores the
// patterns it finds, and renders the strongest ones with a randomly
// chosen wording variant.
//
// Tone rules (baked into the wording, not a prompt):
//   • Descriptive, never prescriptive — "your data shows X", not "do Y".
//   • Pattern-based, specific to the user's numbers, never generic.
//   • Output is structured JSON only.
//
// Return schemas (stable — Phase 1 frontend keys off these):
//   headline / heads_up → { headline_sentence, supporting_context }
//   working / off       → { cards: [{ category, statement, big_stat,
//                                      stat_color, sample_size }] }

// ── formatting helpers ──────────────────────────────────────────────
const RAND  = arr => arr[Math.floor(Math.random()*arr.length)];
const pct   = r => (r==null?'—':Math.round(r*100)+'%');
const fmtR  = r => (r==null?'—':(r>=0?'+':'')+(Math.round(r*10)/10)+'R');
const money = n => {
  if(n==null) return '—';
  const a=Math.round(Math.abs(n)).toLocaleString('en-US');
  return (n<0?'-$':'+$')+a;
};
const sample = (count, extra) => count + ' trade' + (count===1?'':'s') + (extra?' · '+extra:' · 30 days');
const cap = s => s ? s.charAt(0).toUpperCase()+s.slice(1) : s;

// A group has a usable R-multiple only when several stop-set trades back
// it and the expectancy is non-trivial. Otherwise fall back to win-rate.
const hasR = g => !!(g && g.r_sample>=3 && g.expectancy_R!=null && Math.abs(g.expectancy_R)>=0.1);

// A card: category / statement / big_stat / stat_color / sample_size.
// sampleOverride wins over the count-derived sample string when given.
function card(category, statement, big_stat, stat_color, count, extra, sampleOverride){
  return { category, statement, big_stat, stat_color, sample_size: sampleOverride || sample(count, extra) };
}

// Sort scored candidates, take top N, capping how many can come from the
// same pattern family so the cards don't all read the same.
function takeTop(cands, n, capPerFamily){
  cands.sort((x,y)=>y.score-x.score);
  const out=[], fam={};
  for(const c of cands){
    const f=c.family||'_';
    fam[f]=fam[f]||0;
    if(capPerFamily && fam[f]>=capPerFamily) continue;
    fam[f]++; out.push(c.card);
    if(out.length>=n) break;
  }
  return out;
}

// ════════════════════════════════════════════════════════════════════
// HEADLINE — one sentence, the single most interesting thing this week.
// ════════════════════════════════════════════════════════════════════
function detectHeadline(a){
  const cands=[];

  // 1 — Strong session win streak (4+).
  const ss=a.session_streak;
  if(ss && ss.streak>=4){
    cands.push({ score: 62 + ss.streak*8,
      sentence: RAND([
        `Something clicked in ${ss.session} — ${ss.streak} wins in a row.`,
        `Your ${ss.session} numbers are different lately. ${ss.streak} consecutive winners.`,
        `${ss.session} is leveling up — ${ss.streak} straight wins and counting.`
      ]),
      context: hasR(ss)
        ? `Across ${ss.count} ${ss.session} trades your expectancy sits at ${fmtR(ss.expectancy_R)}.`
        : `That run carries a ${pct(ss.win_rate)} win rate across ${ss.count} ${ss.session} trades.`
    });
  }

  // 2 — Big shift from the prior period.
  const rt=a.recent_trends;
  if(rt && rt.last_7d_count>=4 && rt.prior_count>=4 && rt.last_7d_win_rate!=null && rt.prior_win_rate!=null){
    const delta=rt.last_7d_win_rate-rt.prior_win_rate;
    if(delta>=0.12){
      const sharper=rt.prior_win_rate>0?Math.round(delta/rt.prior_win_rate*100):Math.round(delta*100);
      cands.push({ score: 58 + delta*120,
        sentence: RAND([
          `You were ${sharper}% sharper this week than your 30-day average.`,
          `This week is a clear step up — win rate jumped to ${pct(rt.last_7d_win_rate)} from ${pct(rt.prior_win_rate)}.`,
          `Whatever you changed this week is working — ${pct(rt.last_7d_win_rate)} win rate, well above your baseline.`
        ]),
        context: `Last 7 days: ${pct(rt.last_7d_win_rate)} across ${rt.last_7d_count} trades, versus ${pct(rt.prior_win_rate)} over the prior stretch.`
      });
    }
  }

  // 3 — Best day of the month (needs real volume to be the hero line).
  const bd=a.best_day;
  if(bd && bd.count>=5 && bd.avg_pnl>0){
    cands.push({ score: 50 + Math.min(bd.avg_pnl/6,35),
      sentence: RAND([
        `${bd.name}s have been your money day — ${money(bd.avg_pnl)} average per trade.`,
        `If there's a day that likes you, it's ${bd.name} — ${money(bd.net_pnl)} net this month.`,
        `Your ${bd.name} sessions stand out: ${money(bd.avg_pnl)} average across ${bd.count} trades.`
      ]),
      context: `${bd.count} ${bd.name} trades this window at a ${pct(bd.win_rate)} win rate.`
    });
  }

  // 4 — One session carrying the book.
  const bs=a.best_session;
  if(bs && bs.count>=4 && bs.net_pnl>0){
    cands.push({ score: 38 + Math.min(bs.net_pnl/40,30),
      sentence: RAND([
        `Your ${bs.name} killzone is doing the heavy lifting — ${money(bs.net_pnl)} net.`,
        `${bs.name} is where it's working: ${money(bs.net_pnl)} across ${bs.count} trades.`
      ]),
      context: `${bs.name} win rate is ${pct(bs.win_rate)} — your strongest session this window.`
    });
  }

  // 5 — One confluence carrying the book.
  const cf=(a.best_confluences||[])[0];
  if(cf && cf.count>=4 && (hasR(cf)?cf.expectancy_R>=1:cf.win_rate>=0.65)){
    cands.push({ score: 46 + cf.count*2,
      sentence: RAND([
        `Your "${cf.name}" reads are doing the heavy lifting this month.`,
        `One setup is carrying you — "${cf.name}" keeps showing up in your winners.`
      ]),
      context: hasR(cf)
        ? `${cf.count} trades tagged "${cf.name}", expectancy ${fmtR(cf.expectancy_R)}.`
        : `${cf.count} trades tagged "${cf.name}", winning ${pct(cf.win_rate)} of the time.`
    });
  }

  // 6 — Hot current streak.
  const st=a.streak;
  if(st && st.type==='win' && st.length>=4){
    cands.push({ score: 44 + st.length*5,
      sentence: RAND([
        `You're on a ${st.length}-trade win streak right now.`,
        `${st.length} winners in a row — momentum is real.`
      ]),
      context: `Your 30-day win rate sits at ${pct(a.win_rate)} across ${a.trade_count} trades.`
    });
  }

  cands.sort((x,y)=>y.score-x.score);
  const top=cands[0];
  if(top) return { headline_sentence: top.sentence, supporting_context: top.context };

  // Neutral fallback — nothing dramatic, just the baseline.
  return {
    headline_sentence: RAND([
      `${a.trade_count} trades over 30 days at a ${pct(a.win_rate)} win rate — your baseline to beat.`,
      `A steady month: ${a.trade_count} trades, ${pct(a.win_rate)} win rate, ${money(a.net_pnl)} net.`,
      `No wild swings this month — ${pct(a.win_rate)} across ${a.trade_count} trades. Consistency is its own signal.`
    ]),
    supporting_context: a.best_session
      ? `Your steadiest window is ${a.best_session.name} (${pct(a.best_session.win_rate)} across ${a.best_session.count} trades).`
      : `Net P&L for the window is ${money(a.net_pnl)}.`
  };
}

// ════════════════════════════════════════════════════════════════════
// WORKING — top 3 things the data says are going right.
// ════════════════════════════════════════════════════════════════════
function detectWorking(a){
  const overall=a.win_rate||0;
  const cands=[];

  // Sessions pulling weight — must be net positive to count as "working".
  for(const s of (a.all_sessions||[])){
    if(s.count<3 || !(s.net_pnl>0)) continue;
    const wrDelta=(s.win_rate!=null?s.win_rate-overall:0);
    cands.push({ family:'session', score: 32 + wrDelta*130 + Math.min((s.net_pnl||0)/40,30) + s.count*0.4,
      card: card('Pattern · Time',
        RAND([
          `Your ${s.name} session runs ${pct(s.win_rate)} — ${money(s.net_pnl)} net across ${s.count} trades.`,
          `${s.name} is a green window for you: ${money(s.net_pnl)} on a ${pct(s.win_rate)} win rate.`,
          `When you trade ${s.name} the book lifts — ${money(s.net_pnl)} net, ${pct(s.win_rate)} wins.`
        ]),
        s.net_pnl>0?money(s.net_pnl):pct(s.win_rate), 'sage', s.count) });
  }

  // Days pulling weight.
  for(const d of (a.all_days||[])){
    if(d.count<3 || !(d.avg_pnl>0)) continue;
    cands.push({ family:'day', score: 30 + Math.min(d.avg_pnl/7,42) + d.count*0.4,
      card: card('Pattern · Day',
        RAND([
          `${d.name}s pull their weight — ${money(d.avg_pnl)} average per trade.`,
          `${d.name} is a money day — ${money(d.avg_pnl)} average across ${d.count} trades.`,
          `Your ${d.name} sessions stand out — ${pct(d.win_rate)} win rate, ${money(d.avg_pnl)} average.`
        ]),
        money(d.avg_pnl),'sage',d.count) });
  }

  // Best confluence.
  const cf0=(a.best_confluences||[])[0];
  if(cf0 && cf0.count>=3){
    const r=hasR(cf0);
    cands.push({ family:'confluence', score: 46 + cf0.count*2 + (r?cf0.expectancy_R*12:(cf0.win_rate-overall)*90),
      card: card('Pattern · Setup',
        RAND([
          `Trades tagged "${cf0.name}" carry ${r?'an expectancy of '+fmtR(cf0.expectancy_R):'a '+pct(cf0.win_rate)+' win rate'}.`,
          `"${cf0.name}" keeps delivering — ${r?fmtR(cf0.expectancy_R)+' expectancy':pct(cf0.win_rate)+' win rate'} across ${cf0.count} trades.`,
          `Your "${cf0.name}" read is one of your sharpest — ${r?fmtR(cf0.expectancy_R):pct(cf0.win_rate)} on ${cf0.count} trades.`
        ]),
        r?fmtR(cf0.expectancy_R):pct(cf0.win_rate),'sage',cf0.count) });
  }

  // State pattern — emotion / confidence (only when differentiated).
  const states=[];
  const emoKeys=Object.keys(a.emotion_audit||{}), confKeys=Object.keys(a.confidence_audit||{});
  if(emoKeys.length>1) for(const v of Object.values(a.emotion_audit)) if(v.count>=3&&v.win_rate!=null) states.push(v);
  if(confKeys.length>1) for(const v of Object.values(a.confidence_audit)) if(v.count>=3&&v.win_rate!=null) states.push(v);
  const bestState=states.filter(s=>s.win_rate>overall+0.05).sort((x,y)=>y.win_rate-x.win_rate)[0];
  if(bestState){
    cands.push({ family:'state', score: 44 + (bestState.win_rate-overall)*130 + bestState.count,
      card: card('Pattern · State',
        RAND([
          `Trading from ${bestState.label} you win ${pct(bestState.win_rate)} of the time.`,
          `Your ${bestState.label} trades are a different animal — ${pct(bestState.win_rate)} win rate.`,
          `When you log ${bestState.label}, the result follows: ${pct(bestState.win_rate)} wins.`
        ]),
        pct(bestState.win_rate),'sage',bestState.count) });
  }

  // Symbol edge (only when more than one symbol traded).
  const sym=a.best_symbol;
  if(sym && sym.count>=3 && a.worst_symbol && a.best_symbol && a.worst_symbol.name!==a.best_symbol.name){
    const r=hasR(sym);
    cands.push({ family:'symbol', score: 38 + sym.count + (sym.net_pnl>0?Math.min(sym.net_pnl/50,25):0),
      card: card('Pattern · Symbol',
        RAND([
          `${sym.name} is your strongest instrument — ${money(sym.net_pnl)} net, ${pct(sym.win_rate)} win rate.`,
          `You read ${sym.name} well: ${r?fmtR(sym.expectancy_R)+' expectancy':money(sym.net_pnl)+' net'} across ${sym.count} trades.`
        ]),
        sym.net_pnl>0?money(sym.net_pnl):pct(sym.win_rate),'sage',sym.count) });
  }

  // Recent improvement.
  const rt=a.recent_trends;
  if(rt && rt.prior_count>=4 && rt.last_7d_count>=4 && rt.win_rate_delta!=null && rt.win_rate_delta>=0.1){
    cands.push({ family:'recent', score: 40 + rt.win_rate_delta*120,
      card: card('Pattern · Trend',
        RAND([
          `Your last 7 days are trending up — ${pct(rt.last_7d_win_rate)} vs ${pct(rt.prior_win_rate)} before.`,
          `Recent form is climbing: ${pct(rt.last_7d_win_rate)} win rate over the last week.`
        ]),
        pct(rt.last_7d_win_rate),'sage',rt.last_7d_count,'last 7 days') });
  }

  return { cards: takeTop(cands, 3, 2) };
}

// ════════════════════════════════════════════════════════════════════
// OFF — top 3 things the data says are leaking edge.
// ════════════════════════════════════════════════════════════════════
function detectOff(a){
  const overall=a.win_rate||0;
  const cands=[];

  // Sizing creep after losses.
  const sz=a.sizing_after_losses;
  if(sz && sz.occurrences>=3 && sz.creep_ratio!=null && sz.creep_ratio>=1.3){
    cands.push({ family:'sizing', score: 72 + sz.creep_ratio*15 + sz.occurrences,
      card: card('Risk · Sizing',
        RAND([
          `After two losses your size jumps to ${sz.after_2_losses_avg} contracts vs your usual ${sz.normal_avg}.`,
          `Your data shows size creep after losing trades — ${sz.after_2_losses_avg} contracts vs a ${sz.normal_avg} norm.`,
          `Two losses in, your average size climbs ${sz.creep_ratio}x — ${sz.after_2_losses_avg} vs ${sz.normal_avg} contracts.`
        ]),
        sz.creep_ratio+'x','rose',sz.occurrences,null,sz.occurrences+' occurrences · 30 days') });
  }

  // Sessions leaking — must be net negative to count as "off".
  for(const s of (a.all_sessions||[])){
    if(s.count<3 || !(s.net_pnl<0)) continue;
    cands.push({ family:'session', score: 34 + (overall-(s.win_rate||0))*130 + Math.min(Math.abs(s.net_pnl)/40,32) + s.count*0.3,
      card: card('Pattern · Time',
        RAND([
          `${s.name} is your weakest window — ${pct(s.win_rate)} win rate, ${money(s.net_pnl)} net.`,
          `The numbers dip in ${s.name}: ${pct(s.win_rate)} win rate, ${money(s.net_pnl)} across ${s.count} trades.`,
          `${s.name} keeps costing you — ${money(s.net_pnl)} on ${s.count} trades.`
        ]),
        money(s.net_pnl),'rose',s.count) });
  }

  // Days leaking.
  for(const d of (a.all_days||[])){
    if(d.count<3 || !(d.avg_pnl<0)) continue;
    cands.push({ family:'day', score: 30 + Math.min(Math.abs(d.avg_pnl)/7,40) + d.count*0.3,
      card: card('Pattern · Day',
        RAND([
          `${d.name}s run red — ${money(d.avg_pnl)} average per trade.`,
          `${d.name} is a soft spot — ${money(d.avg_pnl)} average across ${d.count} trades.`,
          `${d.name} drags the month — ${pct(d.win_rate)} win rate, ${money(d.avg_pnl)} average.`
        ]),
        money(d.avg_pnl),'rose',d.count) });
  }

  // Grade over-confidence.
  for(const g of ['A+','A']){
    const ga=a.grade_audit&&a.grade_audit[g];
    if(ga && ga.count>=4 && ga.win_rate!=null && ga.win_rate<overall-0.05){
      cands.push({ family:'grade', score: 58 + (overall-ga.win_rate)*150 + ga.count,
        card: card('Pattern · Grade',
          RAND([
            `You grade these setups ${g}, but they win just ${pct(ga.win_rate)} — below your ${pct(overall)} average.`,
            `Your ${g} setups aren't living up to the grade — ${pct(ga.win_rate)} win rate vs ${pct(overall)} overall.`
          ]),
          pct(ga.win_rate),'rose',ga.count) });
      break;
    }
  }

  // Emotion drag.
  if(Object.keys(a.emotion_audit||{}).length>1){
    const emoBad=Object.values(a.emotion_audit).filter(v=>v.count>=3&&v.win_rate!=null&&v.win_rate<overall-0.06)
      .sort((x,y)=>x.win_rate-y.win_rate)[0];
    if(emoBad){
      cands.push({ family:'state', score: 50 + (overall-emoBad.win_rate)*130 + emoBad.count,
        card: card('Pattern · State',
          RAND([
            `Trades logged from ${emoBad.label} win only ${pct(emoBad.win_rate)} of the time.`,
            `${emoBad.label} shows up in your losers — ${pct(emoBad.win_rate)} win rate in that state.`
          ]),
          pct(emoBad.win_rate),'rose',emoBad.count) });
    }
  }

  // Worst confluence.
  const wcf=(a.worst_confluences||[])[0];
  if(wcf && wcf.count>=3 && ((hasR(wcf)&&wcf.expectancy_R<0)||(wcf.win_rate!=null&&wcf.win_rate<overall-0.08))){
    const r=hasR(wcf);
    cands.push({ family:'confluence', score: 40 + wcf.count*2 + (r?Math.abs(wcf.expectancy_R)*12:(overall-wcf.win_rate)*70),
      card: card('Pattern · Setup',
        RAND([
          `Trades tagged "${wcf.name}" are underwater — ${r?fmtR(wcf.expectancy_R)+' expectancy':pct(wcf.win_rate)+' win rate'}.`,
          `"${wcf.name}" hasn't worked this window: ${r?fmtR(wcf.expectancy_R):pct(wcf.win_rate)} across ${wcf.count} trades.`
        ]),
        r?fmtR(wcf.expectancy_R):pct(wcf.win_rate),'rose',wcf.count) });
  }

  // Symbol drag (only when more than one symbol).
  const sym=a.worst_symbol;
  if(sym && sym.count>=3 && sym.net_pnl<0 && a.best_symbol && sym.name!==a.best_symbol.name){
    cands.push({ family:'symbol', score: 34 + sym.count + Math.min(Math.abs(sym.net_pnl)/80,22),
      card: card('Pattern · Symbol',
        RAND([
          `${sym.name} is bleeding — ${money(sym.net_pnl)} net across ${sym.count} trades.`,
          `${sym.name} drags the book: ${money(sym.net_pnl)}, ${pct(sym.win_rate)} win rate.`
        ]),
        money(sym.net_pnl),'rose',sym.count) });
  }

  return { cards: takeTop(cands, 3, 2) };
}

// ════════════════════════════════════════════════════════════════════
// HEADS UP — one contextual, day/time-aware nudge.
// ════════════════════════════════════════════════════════════════════
function detectHeadsUp(a){
  const ctx=a.context||{};
  const cands=[];

  // Coming off two losses.
  if(a.streak && a.streak.type==='loss' && a.streak.length>=2){
    cands.push({ score:90,
      headline_sentence: RAND([
        `You're coming off ${a.streak.length} losses in a row — size watch.`,
        `${a.streak.length} consecutive losses logged. Worth a beat before the next one.`,
        `Two-plus losses deep — this is where size tends to creep.`
      ]),
      supporting_context: (a.sizing_after_losses&&a.sizing_after_losses.creep_ratio>=1.2)
        ? `Your size has historically run ${a.sizing_after_losses.creep_ratio}x larger after back-to-back losses.`
        : `Your last ${a.streak.length} trades all closed red.`
    });
  }

  // Today is the worst day of the week.
  if(a.worst_day && ctx.today===a.worst_day.name && a.worst_day.avg_pnl<0){
    cands.push({ score:80,
      headline_sentence: RAND([
        `It's ${ctx.today} — historically your softest day.`,
        `Heads up: ${ctx.today}s have averaged ${money(a.worst_day.avg_pnl)} for you.`,
        `${ctx.today} again — the day your numbers tend to dip.`
      ]),
      supporting_context: `${a.worst_day.count} ${ctx.today} trades this window at a ${pct(a.worst_day.win_rate)} win rate.`
    });
  }

  // Best session opening soon.
  if(ctx.next_session && a.best_session && ctx.next_session.session===a.best_session.name && ctx.next_session.in_minutes<=75 && a.best_session.net_pnl>0){
    cands.push({ score:75,
      headline_sentence: RAND([
        `${a.best_session.name} opens in ${ctx.next_session.in_minutes} minutes — your best window.`,
        `${ctx.next_session.in_minutes} minutes to ${a.best_session.name}, where your numbers are sharpest.`
      ]),
      supporting_context: `${a.best_session.name}: ${pct(a.best_session.win_rate)} win rate, ${money(a.best_session.net_pnl)} net.`
    });
  }

  // Today is the best day.
  if(a.best_day && ctx.today===a.best_day.name && a.best_day.avg_pnl>0){
    cands.push({ score:68,
      headline_sentence: RAND([
        `It's ${ctx.today} — your strongest day of the week.`,
        `${ctx.today}: historically your best day, ${money(a.best_day.avg_pnl)} average per trade.`
      ]),
      supporting_context: `${a.best_day.count} ${ctx.today} trades this window, ${pct(a.best_day.win_rate)} win rate.`
    });
  }

  // Haven't logged a trade in a while.
  if(ctx.days_since_last_trade!=null && ctx.days_since_last_trade>=3){
    cands.push({ score:60,
      headline_sentence: RAND([
        `It's been ${ctx.days_since_last_trade} days since your last logged trade.`,
        `${ctx.days_since_last_trade} days without a logged trade — the window's getting thin.`
      ]),
      supporting_context: `The Brief reads your last 30 days — gaps shrink the sample it works from.`
    });
  }

  // Riding a green streak.
  if(a.streak && a.streak.type==='win' && a.streak.length>=3){
    cands.push({ score:55,
      headline_sentence: RAND([
        `You're ${a.streak.length} winners deep — momentum's with you.`,
        `${a.streak.length}-trade green streak going into today.`
      ]),
      supporting_context: `Your 30-day win rate sits at ${pct(a.win_rate)} across ${a.trade_count} trades.`
    });
  }

  cands.sort((x,y)=>y.score-x.score);
  const top=cands[0];
  if(top) return { headline_sentence: top.headline_sentence, supporting_context: top.supporting_context };

  // Neutral fallback.
  return {
    headline_sentence: RAND([
      `Nothing flagged for today — ${ctx.today}, clear runway.`,
      `No red flags on the clock. ${pct(a.win_rate)} win rate over your last ${a.trade_count} trades.`
    ]),
    supporting_context: a.best_session
      ? `Your sharpest window remains ${a.best_session.name} (${pct(a.best_session.win_rate)}).`
      : `Trade your plan — the data has no warning for right now.`
  };
}

// ── dispatch ────────────────────────────────────────────────────────
export function renderInsight(type, analytics){
  switch(type){
    case 'headline':  return detectHeadline(analytics);
    case 'working':   return detectWorking(analytics);
    case 'off':       return detectOff(analytics);
    case 'heads_up':  return detectHeadsUp(analytics);
    default: throw new Error('unknown insight type: '+type);
  }
}

export const INSIGHT_TYPES = ['headline','working','off','heads_up'];
