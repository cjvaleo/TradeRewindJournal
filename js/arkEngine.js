/* arkEngine.js — Ark Engine (Workstream 4)
 * Deterministic, NO AI. Reads window.trades, window.acct, window.TradingDay.
 *
 * window.ArkEngine = {
 *   getRuleResults(todayTrades, userRules),     // -> [{rule, passed, auto, value}]
 *   getPlanStatus(todayTrades, ruleResults),    // -> {onPlan, violation} | {onPlan:null, status:'ARMED'}
 *   getInsights(trades, windowDays),            // -> {bestSetup, bestModel, topConfluence, emotion}
 *   getPatterns(trades),                        // -> [{type, description, count, avgImpact, months}]
 *   computeGrade(todayTrades, ruleResults),     // -> {rules, kz, risk, letter}
 *   getJournalStreak(trades),                   // -> {current, best, dots}
 *   getDeterministicDirective(insights, patterns, grade), // -> string (1 sentence)
 * }
 *
 * Side effect: getRuleResults writes window._arkRuleResults.
 */
(function () {
  'use strict';

  // ──────────────────────────────────────────────────────────────────
  // Shared helpers
  // ──────────────────────────────────────────────────────────────────

  // Killzone sessions: where disciplined trading is expected.
  var KILLZONES = { 'NY AM': 1, 'NY PM': 1, 'LONDON': 1 };

  function num(v) {
    if (v == null) return null;
    var n = typeof v === 'number' ? v : parseFloat(v);
    return isNaN(n) ? null : n;
  }

  function pnlOf(t) {
    var n = num(t && t.pnl);
    return n == null ? 0 : n;
  }

  function isWin(t) { return pnlOf(t) > 0; }
  function isLoss(t) { return pnlOf(t) < 0; }

  // Best-effort UTC timestamp (ms) for a trade. Falls back to numeric id
  // (millisecond ids) or the parsed created_at / date field.
  function tsOf(t) {
    if (!t) return null;
    var c = t.created_at;
    if (c != null) {
      if (typeof c === 'number') return c;
      var p = Date.parse(c);
      if (!isNaN(p)) return p;
    }
    if (t.id != null && Number(t.id) > 1e12) return Number(t.id);
    if (t.date) {
      var pd = Date.parse(t.date);
      if (!isNaN(pd)) return pd;
    }
    return null;
  }

  // Session of a trade. Prefer the stored label; otherwise derive from the
  // timestamp via TradingDay (Workstream 1) if available.
  function sessionOf(t) {
    if (t && t.session) return String(t.session).toUpperCase();
    var ts = tsOf(t);
    if (ts != null && window.TradingDay && window.TradingDay.getSession) {
      return window.TradingDay.getSession(ts);
    }
    return null;
  }

  // Confluence list normalized to [{name, type}].
  function confluencesOf(t) {
    var arr = (t && Array.isArray(t.confluences)) ? t.confluences : [];
    var out = [];
    for (var i = 0; i < arr.length; i++) {
      var c = arr[i];
      if (typeof c === 'string') {
        if (c) out.push({ name: c, type: null });
      } else if (c && typeof c === 'object') {
        var nm = c.name || c.label || c.text || '';
        if (nm) out.push({ name: nm, type: c.type || c.kind || null });
      }
    }
    return out;
  }

  // The "setup" tag for a trade: explicit field, else first confluence.
  function setupOf(t) {
    if (t && t.setup) return String(t.setup);
    var cf = confluencesOf(t);
    return cf.length ? cf[0].name : null;
  }

  // The "model" tag for a trade: explicit field, else a confluence typed model.
  function modelOf(t) {
    if (t && t.model) return String(t.model);
    var cf = confluencesOf(t);
    for (var i = 0; i < cf.length; i++) {
      if (cf[i].type && String(cf[i].type).toLowerCase() === 'model') return cf[i].name;
    }
    return null;
  }

  function emotionOf(t) {
    return num(t && t.emotion);
  }

  // 'YYYY-MM' month bucket for a trade.
  function monthOf(t) {
    if (t && t.date) return String(t.date).slice(0, 7);
    var ts = tsOf(t);
    if (ts != null) return new Date(ts).toISOString().slice(0, 7);
    return null;
  }

  // Sort a copy of trades chronologically (best-effort).
  function chrono(trades) {
    return (trades || []).slice().sort(function (a, b) {
      var ta = tsOf(a), tb = tsOf(b);
      if (ta == null && tb == null) return 0;
      if (ta == null) return -1;
      if (tb == null) return 1;
      return ta - tb;
    });
  }

  // ──────────────────────────────────────────────────────────────────
  // 1. getRuleResults
  // ──────────────────────────────────────────────────────────────────
  // userRules: array of rule objects. Each may carry a free-text `name`
  // (the canonical shape from /api/rules/today) plus optional saved status.
  // We parse the name with regex to decide if a rule is auto-checkable.
  function getRuleResults(todayTrades, userRules) {
    var trades = todayTrades || [];
    var rules = userRules || [];
    var results = rules.map(function (r) {
      var name = (r && (r.name || r.rule || r.text || r.title)) || String(r || '');
      var res = evalRule(name, trades, r);
      return { rule: name, passed: res.passed, auto: res.auto, value: res.value };
    });
    window._arkRuleResults = results;
    return results;
  }

  // Evaluate one rule by parsing its name. Returns {passed, auto, value}.
  function evalRule(name, trades, raw) {
    var lc = String(name).toLowerCase();
    var m;

    // "Max N trades per day"
    m = lc.match(/max\s+(\d+)\s+trade/);
    if (m) {
      var cap = parseInt(m[1], 10);
      var count = trades.length;
      return { passed: count <= cap, auto: true, value: count + '/' + cap };
    }

    // "Stop after N consecutive losses"
    m = lc.match(/(\d+)\s+consecutive\s+loss/);
    if (m) {
      var lim = parseInt(m[1], 10);
      var maxStreak = maxConsecutiveLosses(trades);
      // Passed if they never let the streak reach the stop-out limit while
      // continuing to trade (i.e. they did not exceed `lim` consecutive).
      return { passed: maxStreak < lim, auto: true, value: maxStreak + ' max streak' };
    }

    // "Trade in killzone only" / "killzone only"
    if (/killzone|kill\s*zone/.test(lc) && /only/.test(lc)) {
      var outside = 0;
      for (var i = 0; i < trades.length; i++) {
        var s = sessionOf(trades[i]);
        if (s && !KILLZONES[s]) outside++;
      }
      return { passed: outside === 0, auto: true, value: outside + ' outside KZ' };
    }

    // "Flat by HH:MM" (e.g. "Flat by 11:30")
    m = lc.match(/flat\s+by\s+(\d{1,2}):(\d{2})/);
    if (m) {
      var cutoffMin = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
      var latest = latestEtMinutes(trades);
      var ok = latest == null || latest <= cutoffMin;
      return {
        passed: ok,
        auto: latest != null || trades.length === 0,
        value: (latest == null ? '—' : etMinToStr(latest)) + ' / ' + m[1] + ':' + m[2]
      };
    }

    // "Max loss $X" / "Max daily loss $X"
    m = lc.match(/max\s+(?:daily\s+)?loss\s*\$?\s*([\d,]+(?:\.\d+)?)/);
    if (m) {
      var limit = parseFloat(m[1].replace(/,/g, ''));
      var totalLoss = 0;
      for (var k = 0; k < trades.length; k++) {
        var p = pnlOf(trades[k]);
        if (p < 0) totalLoss += -p;
      }
      return {
        passed: totalLoss <= limit,
        auto: true,
        value: '$' + Math.round(totalLoss) + ' / $' + Math.round(limit)
      };
    }

    // Not auto-checkable — fall back to a saved manual status if present.
    var status = raw && (raw.status === 'yes' || raw.status === true || raw.passed === true);
    return { passed: !!status, auto: false, value: raw && raw.status != null ? raw.status : null };
  }

  function maxConsecutiveLosses(trades) {
    var ordered = chrono(trades);
    var cur = 0, max = 0;
    for (var i = 0; i < ordered.length; i++) {
      if (isLoss(ordered[i])) { cur++; if (cur > max) max = cur; }
      else cur = 0;
    }
    return max;
  }

  // Latest trade's ET minutes-of-day (0-1439), or null.
  function latestEtMinutes(trades) {
    var latest = null;
    for (var i = 0; i < trades.length; i++) {
      var ts = tsOf(trades[i]);
      if (ts == null) continue;
      var mins = etMinutesOf(ts);
      if (mins != null && (latest == null || mins > latest)) latest = mins;
    }
    return latest;
  }

  function etMinutesOf(ts) {
    if (window.TradingDay && window.TradingDay.formatET) {
      var hhmm = window.TradingDay.formatET(ts); // 'HH:MM'
      var parts = hhmm.split(':');
      return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
    }
    var d = new Date(ts);
    return d.getUTCHours() * 60 + d.getUTCMinutes();
  }

  function etMinToStr(m) {
    var h = Math.floor(m / 60), mm = m % 60;
    return (h < 10 ? '0' : '') + h + ':' + (mm < 10 ? '0' : '') + mm;
  }

  // ──────────────────────────────────────────────────────────────────
  // 2. getPlanStatus
  // ──────────────────────────────────────────────────────────────────
  function getPlanStatus(todayTrades, ruleResults) {
    var trades = todayTrades || [];
    var results = ruleResults || [];

    if (trades.length === 0) {
      return { onPlan: null, status: 'ARMED' };
    }

    var violation = null;
    for (var i = 0; i < results.length; i++) {
      var r = results[i];
      if (r.auto && !r.passed) { violation = r.rule; break; }
    }
    return { onPlan: violation === null, violation: violation };
  }

  // ──────────────────────────────────────────────────────────────────
  // 3. getInsights
  // ──────────────────────────────────────────────────────────────────
  function getInsights(trades, windowDays) {
    var t = filterWindow(trades, windowDays);

    return {
      bestSetup: bestSetup(t),
      bestModel: bestModel(t),
      topConfluence: topConfluence(t),
      emotion: emotionInsight(t)
    };
  }

  // Filter to the trailing N days (default 30) by timestamp; if no
  // timestamps available, returns the input unchanged.
  function filterWindow(trades, windowDays) {
    var n = windowDays || 30;
    var arr = trades || [];
    var cutoff = Date.now() - n * 864e5;
    var any = false, out = [];
    for (var i = 0; i < arr.length; i++) {
      var ts = tsOf(arr[i]);
      if (ts == null) { out.push(arr[i]); continue; }
      any = true;
      if (ts >= cutoff) out.push(arr[i]);
    }
    return any ? out : arr;
  }

  function bestSetup(trades) {
    var groups = {};
    for (var i = 0; i < trades.length; i++) {
      var tag = setupOf(trades[i]);
      if (!tag) continue;
      var g = groups[tag] || (groups[tag] = { tag: tag, n: 0, w: 0 });
      g.n++;
      if (isWin(trades[i])) g.w++;
    }
    var best = null;
    Object.keys(groups).forEach(function (k) {
      var g = groups[k];
      if (g.n < 5) return; // min sample
      var wr = g.w / g.n;
      if (!best || wr > best.winRate || (wr === best.winRate && g.n > best.tradeCount)) {
        best = { tag: g.tag, winRate: Math.round(wr * 100), tradeCount: g.n };
      }
    });
    return best;
  }

  function bestModel(trades) {
    var groups = {};
    for (var i = 0; i < trades.length; i++) {
      var name = modelOf(trades[i]);
      if (!name) continue;
      var g = groups[name] || (groups[name] = { name: name, n: 0, net: 0 });
      g.n++;
      g.net += pnlOf(trades[i]);
    }
    var best = null;
    Object.keys(groups).forEach(function (k) {
      var g = groups[k];
      if (!best || g.net > best.netPnl) {
        best = { name: g.name, netPnl: Math.round(g.net), tradeCount: g.n };
      }
    });
    return best;
  }

  // Most frequent confluence name among winning trades, with the % of
  // winners that carried it.
  function topConfluence(trades) {
    var winners = trades.filter(isWin);
    if (winners.length === 0) return null;
    var counts = {};
    for (var i = 0; i < winners.length; i++) {
      var cf = confluencesOf(winners[i]);
      var seen = {};
      for (var j = 0; j < cf.length; j++) {
        var nm = cf[j].name;
        if (seen[nm]) continue; // count each winner once per name
        seen[nm] = 1;
        counts[nm] = (counts[nm] || 0) + 1;
      }
    }
    var top = null;
    Object.keys(counts).forEach(function (nm) {
      if (!top || counts[nm] > top.tradeCount) {
        top = { name: nm, tradeCount: counts[nm] };
      }
    });
    if (!top) return null;
    top.pct = Math.round((top.tradeCount / winners.length) * 100);
    return top;
  }

  function emotionInsight(trades) {
    var counts = {}, dominant = null, domN = 0;
    var lowLossClusters = 0;
    for (var i = 0; i < trades.length; i++) {
      var e = emotionOf(trades[i]);
      if (e == null) continue;
      counts[e] = (counts[e] || 0) + 1;
      if (counts[e] > domN) { domN = counts[e]; dominant = e; }
      if (e <= 2 && isLoss(trades[i])) lowLossClusters++;
    }
    var leakPattern = null;
    if (lowLossClusters >= 2) {
      leakPattern = 'Elevated/HighCortisol + Loss detected ' + lowLossClusters + ' times';
    }
    return {
      dominant: dominant,
      label: emotionLabel(dominant),
      leakPattern: leakPattern
    };
  }

  function emotionLabel(e) {
    switch (e) {
      case 1: return 'Tilted';
      case 2: return 'Anxious';
      case 3: return 'Neutral';
      case 4: return 'Focused';
      case 5: return 'Locked In';
      default: return null;
    }
  }

  // ──────────────────────────────────────────────────────────────────
  // 4. getPatterns
  // ──────────────────────────────────────────────────────────────────
  function getPatterns(trades) {
    var ordered = chrono(trades);
    var out = [];

    var revenge = detectRevenge(ordered);
    if (revenge.count >= 3) out.push(revenge);

    var oversize = detectOversize(ordered);
    if (oversize.count >= 3) out.push(oversize);

    var kz = detectKillzoneMiss(ordered);
    if (kz.count >= 3) out.push(kz);

    var leak = detectEmotionLeak(ordered);
    if (leak.count >= 3) out.push(leak);

    return out;
  }

  function makePattern(type, description, hits) {
    var totImpact = 0, months = {};
    for (var i = 0; i < hits.length; i++) {
      totImpact += pnlOf(hits[i]);
      var mo = monthOf(hits[i]);
      if (mo) months[mo] = 1;
    }
    return {
      type: type,
      description: description,
      count: hits.length,
      avgImpact: hits.length ? Math.round(totImpact / hits.length) : 0,
      months: Object.keys(months).sort()
    };
  }

  // REVENGE_TRADE: a loss immediately followed by a trade entered < 5 min later.
  function detectRevenge(ordered) {
    var hits = [];
    for (var i = 1; i < ordered.length; i++) {
      if (!isLoss(ordered[i - 1])) continue;
      var prev = tsOf(ordered[i - 1]), cur = tsOf(ordered[i]);
      if (prev == null || cur == null) continue;
      if (cur - prev < 5 * 60 * 1000 && cur - prev >= 0) hits.push(ordered[i]);
    }
    return makePattern('REVENGE_TRADE',
      'Re-entered within 5 minutes of a loss', hits);
  }

  // OVERSIZE: P&L outliers (beyond 2σ of |pnl|) on trades with no stop set.
  function detectOversize(ordered) {
    var noStop = ordered.filter(function (t) {
      var s = num(t.stop);
      return !(s != null && s > 0);
    });
    var mags = ordered.map(function (t) { return Math.abs(pnlOf(t)); });
    var mean = avg(mags);
    var sd = stdev(mags, mean);
    var threshold = mean + 2 * sd;
    var hits = noStop.filter(function (t) {
      return Math.abs(pnlOf(t)) > threshold && threshold > 0;
    });
    return makePattern('OVERSIZE',
      'Outsized P&L with no stop defined', hits);
  }

  // KILLZONE_MISS: trades taken outside killzone sessions.
  function detectKillzoneMiss(ordered) {
    var hits = ordered.filter(function (t) {
      var s = sessionOf(t);
      return s && !KILLZONES[s];
    });
    return makePattern('KILLZONE_MISS',
      'Traded outside the killzone windows', hits);
  }

  // EMOTION_LEAK: trades logged at emotion 1-2 (tilted/anxious).
  function detectEmotionLeak(ordered) {
    var hits = ordered.filter(function (t) {
      var e = emotionOf(t);
      return e != null && e <= 2;
    });
    return makePattern('EMOTION_LEAK',
      'Traded while tilted (emotion 1-2)', hits);
  }

  function avg(arr) {
    if (!arr.length) return 0;
    var s = 0;
    for (var i = 0; i < arr.length; i++) s += arr[i];
    return s / arr.length;
  }
  function stdev(arr, mean) {
    if (arr.length < 2) return 0;
    var s = 0;
    for (var i = 0; i < arr.length; i++) {
      var d = arr[i] - mean;
      s += d * d;
    }
    return Math.sqrt(s / arr.length);
  }

  // ──────────────────────────────────────────────────────────────────
  // 5. computeGrade
  // ──────────────────────────────────────────────────────────────────
  // Never based on P&L. rules 40% / kz 35% / risk 25%.
  function computeGrade(todayTrades, ruleResults) {
    var trades = todayTrades || [];
    var results = ruleResults || [];

    // rules: % of auto-checkable rules that passed.
    var autoRules = results.filter(function (r) { return r.auto; });
    var rulesScore = autoRules.length
      ? Math.round((autoRules.filter(function (r) { return r.passed; }).length / autoRules.length) * 100)
      : 100; // no auto rules to violate -> full marks

    // kz: % of trades in killzones.
    var inKz = 0, sessioned = 0;
    for (var i = 0; i < trades.length; i++) {
      var s = sessionOf(trades[i]);
      if (!s) continue;
      sessioned++;
      if (KILLZONES[s]) inKz++;
    }
    var kzScore = sessioned ? Math.round((inKz / sessioned) * 100) : 100;

    // risk: % of trades with a stop set (size-consistency proxy).
    var withStop = 0;
    for (var j = 0; j < trades.length; j++) {
      var st = num(trades[j].stop);
      if (st != null && st > 0) withStop++;
    }
    var riskScore = trades.length ? Math.round((withStop / trades.length) * 100) : 100;

    var weighted = rulesScore * 0.4 + kzScore * 0.35 + riskScore * 0.25;
    var letter;
    if (weighted >= 85) letter = 'A';
    else if (weighted >= 70) letter = 'B';
    else if (weighted >= 55) letter = 'C';
    else if (weighted >= 40) letter = 'D';
    else letter = 'F';

    return { rules: rulesScore, kz: kzScore, risk: riskScore, letter: letter };
  }

  // ──────────────────────────────────────────────────────────────────
  // 6. getJournalStreak
  // ──────────────────────────────────────────────────────────────────
  // Streak = consecutive trading days (weekends skipped) with a grade set.
  function getJournalStreak(trades) {
    // Map trading-day -> journaled? (any trade that day has a grade).
    var byDay = {};
    (trades || []).forEach(function (t) {
      var day = t.date ? String(t.date).slice(0, 10) : null;
      if (!day) {
        var ts = tsOf(t);
        if (ts != null) {
          day = (window.TradingDay && window.TradingDay.getTradingDay)
            ? window.TradingDay.getTradingDay(ts)
            : new Date(ts).toISOString().slice(0, 10);
        }
      }
      if (!day) return;
      var graded = !!t.grade;
      // A day counts as journaled if ANY trade that day has a grade.
      byDay[day] = byDay[day] || graded;
      if (graded) byDay[day] = true;
    });

    // Walk backwards over trading days from today, skipping weekends.
    var dots = [];
    var current = 0, currentBroken = false;
    var cursor = new Date();
    // Build the last 7 trading days (most recent last for display).
    var collected = [];
    var guard = 0;
    while (collected.length < 7 && guard < 30) {
      guard++;
      var dow = cursor.getUTCDay();
      if (dow !== 0 && dow !== 6) {
        var ds = cursor.toISOString().slice(0, 10);
        collected.push(ds);
      }
      cursor = new Date(cursor.getTime() - 864e5);
    }
    // collected is newest-first; build dots oldest-first.
    var ordered = collected.slice().reverse();
    for (var i = 0; i < ordered.length; i++) {
      dots.push(!!byDay[ordered[i]]);
    }

    // Current streak: walk newest-first until a gap.
    for (var c = 0; c < collected.length; c++) {
      if (byDay[collected[c]]) {
        if (!currentBroken) current++;
      } else {
        currentBroken = true;
      }
    }
    // Continue scanning further back for an accurate current streak.
    if (!currentBroken) {
      var back = new Date(cursor.getTime());
      var g2 = 0;
      while (g2 < 365) {
        g2++;
        var d2 = back.getUTCDay();
        if (d2 !== 0 && d2 !== 6) {
          var s2 = back.toISOString().slice(0, 10);
          if (byDay[s2]) current++;
          else break;
        }
        back = new Date(back.getTime() - 864e5);
      }
    }

    // Best streak: scan all known journaled trading days in order.
    var best = computeBestStreak(byDay);
    if (current > best) best = current;

    return { current: current, best: best, dots: dots };
  }

  function computeBestStreak(byDay) {
    var days = Object.keys(byDay).filter(function (d) { return byDay[d]; }).sort();
    if (!days.length) return 0;
    var best = 1, run = 1;
    for (var i = 1; i < days.length; i++) {
      if (isPrevTradingDay(days[i - 1], days[i])) run++;
      else run = 1;
      if (run > best) best = run;
    }
    return best;
  }

  // True if `next` is the trading day immediately after `prev` (skip weekends).
  function isPrevTradingDay(prev, next) {
    var p = new Date(prev + 'T00:00:00Z');
    var step = new Date(p.getTime() + 864e5);
    var guard = 0;
    while (guard < 5) {
      guard++;
      var dow = step.getUTCDay();
      if (dow !== 0 && dow !== 6) {
        return step.toISOString().slice(0, 10) === next;
      }
      step = new Date(step.getTime() + 864e5);
    }
    return false;
  }

  // ──────────────────────────────────────────────────────────────────
  // 7. getDeterministicDirective
  // ──────────────────────────────────────────────────────────────────
  // Pure decision tree. Blunt-coach tone. One sentence.
  function getDeterministicDirective(insights, patterns, grade) {
    insights = insights || {};
    patterns = patterns || [];
    grade = grade || {};

    // 1. Top repeated pattern wins.
    if (patterns.length) {
      var top = patterns.slice().sort(function (a, b) { return b.count - a.count; })[0];
      switch (top.type) {
        case 'REVENGE_TRADE':
          return 'Stop revenge trading — you re-entered within 5 minutes of a loss ' + top.count + ' times; wait for the next clean setup.';
        case 'OVERSIZE':
          return 'Size discipline is broken — ' + top.count + ' outsized trades had no stop; define your stop before every entry.';
        case 'KILLZONE_MISS':
          return 'Stay in your killzone — ' + top.count + ' trades fired outside London and NY; sit on your hands until the window opens.';
        case 'EMOTION_LEAK':
          return 'You traded tilted ' + top.count + ' times — when emotion drops to 1-2, close the platform.';
        default:
          return 'Fix your top pattern: ' + top.description + '.';
      }
    }

    // 2. Worst failing auto-rule.
    var failing = (window._arkRuleResults || []).filter(function (r) { return r.auto && !r.passed; });
    if (failing.length) {
      return 'Honor your rule — "' + failing[0].rule + '" is broken today; respect the line you drew.';
    }

    // 3. Reinforce a strong setup.
    if (insights.bestSetup && insights.bestSetup.winRate > 60) {
      return 'Lean into "' + insights.bestSetup.tag + '" — it is hitting ' + insights.bestSetup.winRate + '% over your last ' + insights.bestSetup.tradeCount + ' trades; take only A+ versions of it.';
    }

    // 4. Generic.
    return 'Trade your plan.';
  }

  // ──────────────────────────────────────────────────────────────────
  window.ArkEngine = {
    getRuleResults: getRuleResults,
    getPlanStatus: getPlanStatus,
    getInsights: getInsights,
    getPatterns: getPatterns,
    computeGrade: computeGrade,
    getJournalStreak: getJournalStreak,
    getDeterministicDirective: getDeterministicDirective
  };
})();
