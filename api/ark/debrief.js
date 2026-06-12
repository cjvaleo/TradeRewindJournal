// POST /api/ark/debrief — The Ark's conversational session debrief (GRADE TODAY).
//
// A blunt, multi-turn debrief grounded in the trader's actual session data.
// Step 'init' fetches today's trades + rules, builds a compact context, and
// returns 2-3 pointed questions referencing real trades/patterns. Step 'answer'
// either asks one follow-up or, once the conversation has run its course,
// generates the final evaluation: a first-person journal entry, mood tags, a
// PROCESS-only letter grade, grade bars, and a tomorrow focus. The final result
// is persisted to Supabase (user_settings, keyed by trading_day).
//
// Uses Claude Sonnet (claude-sonnet-4-6) for all turns. On API failure at any
// step we degrade gracefully — returning a deterministic fallback grade built
// from the same logic ArkEngine.computeGrade() uses client-side.
//
// Request:
//   { step: 'init',   trading_day: 'YYYY-MM-DD' }
//   { step: 'answer', trading_day: 'YYYY-MM-DD', answer: string,
//                     conversation_history: [{role, content}, ...] }
// Auth: Supabase Bearer (same pattern as api/ark/coaching.js).
//
// ─────────────────────────────────────────────────────────────────────────
// VERCEL ROUTING — api/* functions are auto-detected by Vercel; no rewrite
// entry is required. (POST /api/ark/debrief maps to this file automatically.)
//
// ─────────────────────────────────────────────────────────────────────────
// PERSISTENCE — the final {journal_entry, grade, ...} is upserted into
// user_settings as { user_id, key: 'debrief:<trading_day>', value: <result> }.
// This avoids assuming a dedicated journals table exists.
//
// ─────────────────────────────────────────────────────────────────────────
// ENV VAR REQUIRED FOR REAL AI: ANTHROPIC_API_KEY
//   Without it (or on API failure), responses degrade to fallback grades.

import { sbAnon, sbService } from '../_lib/supabase.js';

const MODEL = 'claude-sonnet-4-6';
const NY_TZ = 'America/New_York';

// ── Validation helpers ──────────────────────────────────────────────────
function isValidYmd(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  return true;
}

function etDateString(d) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: NY_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

function num(v) {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
}
function pnlOf(t) { const n = num(t && t.pnl); return n == null ? 0 : n; }
function isWin(t) { return pnlOf(t) > 0; }
function isLoss(t) { return pnlOf(t) < 0; }

// Killzone sessions (mirrors ArkEngine).
const KILLZONES = { 'NY AM': 1, 'NY PM': 1, 'LONDON': 1 };

function sessionOf(t) {
  if (t && t.session) return String(t.session).toUpperCase();
  const td = t && t.trade_data && typeof t.trade_data === 'object' ? t.trade_data : {};
  if (td.session) return String(td.session).toUpperCase();
  return null;
}
function setupOf(t) {
  if (t && t.setup) return String(t.setup);
  if (t && t.type) return String(t.type);
  const td = t && t.trade_data && typeof t.trade_data === 'object' ? t.trade_data : {};
  if (td.setup) return String(td.setup);
  if (Array.isArray(t && t.confluences) && t.confluences.length) {
    const c = t.confluences[0];
    return typeof c === 'string' ? c : (c && (c.name || c.label)) || null;
  }
  return null;
}
function emotionOf(t) { return num(t && t.emotion); }
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

// ── computeGrade — server-side mirror of ArkEngine.computeGrade ──────────
// Never P&L-based. rules 40% / kz 35% / risk 25%.
function computeGrade(trades, ruleResults) {
  const results = ruleResults || [];
  const autoRules = results.filter((r) => r.auto);
  const rulesScore = autoRules.length
    ? Math.round((autoRules.filter((r) => r.passed).length / autoRules.length) * 100)
    : 100;

  let inKz = 0, sessioned = 0;
  for (const t of trades) {
    const s = sessionOf(t);
    if (!s) continue;
    sessioned++;
    if (KILLZONES[s]) inKz++;
  }
  const kzScore = sessioned ? Math.round((inKz / sessioned) * 100) : 100;

  let withStop = 0;
  for (const t of trades) {
    const st = num(t.stop);
    if (st != null && st > 0) withStop++;
  }
  const riskScore = trades.length ? Math.round((withStop / trades.length) * 100) : 100;

  const weighted = rulesScore * 0.4 + kzScore * 0.35 + riskScore * 0.25;
  let letter;
  if (weighted >= 85) letter = 'A';
  else if (weighted >= 70) letter = 'B';
  else if (weighted >= 55) letter = 'C';
  else if (weighted >= 40) letter = 'D';
  else letter = 'F';

  return { rules: rulesScore, kz: kzScore, risk: riskScore, letter };
}

// ── buildDebriefContext — server-side mirror of ArkEngine.buildDebriefContext
function buildDebriefContext(trades, ruleResults, userRules) {
  const results = ruleResults || [];

  let winCount = 0, lossCount = 0, totalPnl = 0;
  let rSum = 0, rN = 0;
  const sessions = {};
  const setups = {};
  let emotionSum = 0, emotionN = 0;

  for (const t of trades) {
    if (isWin(t)) winCount++;
    else if (isLoss(t)) lossCount++;
    totalPnl += pnlOf(t);

    const r = num(t.rr);
    if (r != null) { rSum += r; rN++; }

    const s = sessionOf(t);
    if (s) sessions[s] = (sessions[s] || 0) + 1;

    const su = setupOf(t);
    if (su) setups[su] = (setups[su] || 0) + 1;

    const e = emotionOf(t);
    if (e != null) { emotionSum += e; emotionN++; }
  }

  const violations = [];
  for (const r of results) {
    if (r.auto && !r.passed) violations.push({ rule: r.rule, times_broken: 1 });
  }

  let topSetup = null, topN = 0;
  for (const k of Object.keys(setups)) {
    if (setups[k] > topN) { topN = setups[k]; topSetup = k; }
  }

  const grade = computeGrade(trades, results);

  return {
    trade_count: trades.length,
    win_count: winCount,
    loss_count: lossCount,
    total_pnl: Math.round(totalPnl),
    avg_r: rN ? Math.round((rSum / rN) * 100) / 100 : null,
    sessions_used: Object.keys(sessions),
    rule_violations: violations,
    top_setup: topSetup,
    emotion_summary: emotionN
      ? { avg: Math.round((emotionSum / emotionN) * 10) / 10, label: emotionLabel(Math.round(emotionSum / emotionN)) }
      : null,
    user_rules: Array.isArray(userRules) ? userRules : [],
    grade_bars: { rules: grade.rules, kz: grade.kz, risk: grade.risk },
    grade_letter: grade.letter,
  };
}

// ── Rule auto-evaluation (compact subset, mirrors ArkEngine.evalRule) ────
// Used to derive grade_bars.rules and rule_violations server-side from the
// trader's saved rule names. Only auto-checkable rules contribute.
function maxConsecutiveLosses(trades) {
  let cur = 0, max = 0;
  for (const t of trades) {
    if (isLoss(t)) { cur++; if (cur > max) max = cur; } else cur = 0;
  }
  return max;
}
function evalRule(name, trades) {
  const lc = String(name).toLowerCase();
  let m;
  m = lc.match(/max\s+(\d+)\s+trade/);
  if (m) {
    const cap = parseInt(m[1], 10);
    return { passed: trades.length <= cap, auto: true };
  }
  m = lc.match(/(\d+)\s+consecutive\s+loss/);
  if (m) {
    const lim = parseInt(m[1], 10);
    return { passed: maxConsecutiveLosses(trades) < lim, auto: true };
  }
  if (/killzone|kill\s*zone/.test(lc) && /only/.test(lc)) {
    let outside = 0;
    for (const t of trades) { const s = sessionOf(t); if (s && !KILLZONES[s]) outside++; }
    return { passed: outside === 0, auto: true };
  }
  m = lc.match(/max\s+(?:daily\s+)?loss\s*\$?\s*([\d,]+(?:\.\d+)?)/);
  if (m) {
    const limit = parseFloat(m[1].replace(/,/g, ''));
    let totalLoss = 0;
    for (const t of trades) { const p = pnlOf(t); if (p < 0) totalLoss += -p; }
    return { passed: totalLoss <= limit, auto: true };
  }
  return { passed: false, auto: false };
}
function getRuleResults(trades, userRules) {
  return (userRules || []).map((r) => {
    const name = (r && (r.name || r.rule || r.text)) || String(r || '');
    const res = evalRule(name, trades);
    return { rule: name, passed: res.passed, auto: res.auto };
  });
}

// ── Deterministic fallback ──────────────────────────────────────────────
function computeFallbackGrade(ctx) {
  // ctx is the buildDebriefContext output (or a partial). Process-only.
  const bars = (ctx && ctx.grade_bars) || { rules: 100, kz: 100, risk: 100 };
  const letter = (ctx && ctx.grade_letter) ||
    (function () {
      const w = bars.rules * 0.4 + bars.kz * 0.35 + bars.risk * 0.25;
      if (w >= 85) return 'A';
      if (w >= 70) return 'B';
      if (w >= 55) return 'C';
      if (w >= 40) return 'D';
      return 'F';
    })();
  return { grade: letter, grade_bars: bars };
}

function deterministicResult(ctx) {
  const fb = computeFallbackGrade(ctx);
  const count = (ctx && ctx.trade_count) || 0;
  const net = (ctx && ctx.total_pnl) || 0;
  const violations = (ctx && ctx.rule_violations) || [];
  const journal = count === 0
    ? 'I took no trades today. I stayed flat and protected my capital.'
    : `I took ${count} trade${count === 1 ? '' : 's'} today${
        violations.length ? `, breaking ${violations.length} rule${violations.length === 1 ? '' : 's'}` : ' and stayed on plan'
      }. I'll review my process and keep executing the same way tomorrow.`;
  const moods = [];
  if (ctx && ctx.emotion_summary && ctx.emotion_summary.label) moods.push(ctx.emotion_summary.label.toLowerCase());
  if (violations.length) moods.push('undisciplined');
  else if (count > 0) moods.push('disciplined');
  if (!moods.length) moods.push('neutral');
  const focus = violations.length
    ? `Respect "${violations[0].rule}" tomorrow — no exceptions.`
    : 'Show up flat and patient; take only A+ setups.';
  return {
    done: true,
    result: {
      journal_entry: journal,
      mood_tags: moods.slice(0, 3),
      grade: fb.grade,
      grade_bars: fb.grade_bars,
      tomorrow_focus: focus,
    },
  };
}

// ── Claude calls (raw fetch, no SDK dependency) ─────────────────────────
async function callClaude({ system, userPrompt }) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 700,
      temperature: 0.4,
      messages: [{ role: 'user', content: userPrompt }],
      system,
    }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`anthropic ${response.status}: ${body.slice(0, 200)}`);
  }
  const data = await response.json();
  const text = (data.content || [])
    .filter((b) => b && b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
  const cleaned = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  return JSON.parse(cleaned);
}

// ── Output validators ───────────────────────────────────────────────────
function validateInitOutput(r) {
  if (!r || typeof r !== 'object') return null;
  let { questions, context_summary } = r;
  if (!Array.isArray(questions)) return null;
  questions = questions.filter((q) => typeof q === 'string' && q.trim()).map((q) => q.trim());
  if (questions.length < 2) return null;
  return { questions: questions.slice(0, 3), context_summary: typeof context_summary === 'string' ? context_summary.trim() : '' };
}

function validateFinalResult(r) {
  if (!r || typeof r !== 'object' || !r.result || typeof r.result !== 'object') return null;
  const res = r.result;
  const grades = ['A', 'B', 'C', 'D', 'F'];
  if (typeof res.journal_entry !== 'string' || !res.journal_entry.trim()) return null;
  if (!Array.isArray(res.mood_tags)) return null;
  if (!grades.includes(res.grade)) return null;
  const gb = res.grade_bars;
  if (!gb || typeof gb !== 'object') return null;
  const clamp = (n) => Math.max(0, Math.min(100, Math.round(num(n) || 0)));
  if (typeof res.tomorrow_focus !== 'string' || !res.tomorrow_focus.trim()) return null;
  return {
    done: true,
    result: {
      journal_entry: res.journal_entry.trim(),
      mood_tags: res.mood_tags.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim()).slice(0, 5),
      grade: res.grade,
      grade_bars: { rules: clamp(gb.rules), kz: clamp(gb.kz), risk: clamp(gb.risk) },
      tomorrow_focus: res.tomorrow_focus.trim(),
    },
  };
}

// ── Data fetch ──────────────────────────────────────────────────────────
async function fetchTodaysTrades(sb, userId, tradingDay) {
  // Preferred path: a trading_day column exists.
  const q1 = await sb.from('trades').select('*').eq('user_id', userId).eq('trading_day', tradingDay);
  if (!q1.error) return q1.data || [];

  // Fallback: filter by ET date on created_at.
  const startUtc = new Date(`${tradingDay}T00:00:00-05:00`).toISOString();
  const next = new Date(`${tradingDay}T00:00:00-05:00`);
  next.setUTCDate(next.getUTCDate() + 1);
  const endUtc = next.toISOString();
  const q2 = await sb
    .from('trades').select('*').eq('user_id', userId)
    .gte('created_at', startUtc).lt('created_at', endUtc);
  if (q2.error) throw q2.error;
  return (q2.data || []).filter((t) => t.created_at && etDateString(new Date(t.created_at)) === tradingDay);
}

async function fetchRules(sb, userId) {
  // Active rules from the rules table; fall back to profiles.rules if absent.
  const q = await sb.from('rules').select('id, name, cadence, is_active').eq('user_id', userId).eq('is_active', true);
  if (!q.error && Array.isArray(q.data)) {
    return q.data.filter((r) => r.cadence !== 'weekly').map((r) => ({ name: r.name }));
  }
  const p = await sb.from('profiles').select('rules').eq('id', userId).maybeSingle();
  if (!p.error && p.data && Array.isArray(p.data.rules)) {
    return p.data.rules.map((r) => (typeof r === 'string' ? { name: r } : r));
  }
  return [];
}

// ── Handler ─────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed', allowed: ['POST'] });
    return;
  }

  // ── Auth ────────────────────────────────────────────────────────────
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) { res.status(401).json({ error: 'auth required' }); return; }

  let user;
  try {
    const { data, error } = await sbAnon().auth.getUser(token);
    if (error || !data.user) throw new Error('invalid token');
    user = data.user;
  } catch (e) {
    console.warn('[ark/debrief] auth failed:', e && e.message);
    res.status(401).json({ error: 'auth required' });
    return;
  }

  const body = req.body || {};
  const step = body.step;
  const tradingDay = body.trading_day;
  if (step !== 'init' && step !== 'answer') {
    res.status(400).json({ error: 'invalid step', expected: ['init', 'answer'] });
    return;
  }
  if (!isValidYmd(tradingDay)) {
    res.status(400).json({ error: 'invalid trading_day', expected: 'YYYY-MM-DD' });
    return;
  }

  const sb = sbService();

  // ── Build context from today's trades + rules ─────────────────────────
  let trades = [];
  let userRules = [];
  try {
    [trades, userRules] = await Promise.all([
      fetchTodaysTrades(sb, user.id, tradingDay),
      fetchRules(sb, user.id),
    ]);
  } catch (e) {
    console.error('[ark/debrief] data read failed:', e && e.message);
    res.status(500).json({ error: 'data read failed' });
    return;
  }

  const ruleResults = getRuleResults(trades, userRules);
  const ctx = buildDebriefContext(trades, ruleResults, userRules);

  res.setHeader('Cache-Control', 'no-store');

  // ── Step: init — return 2-3 pointed questions ─────────────────────────
  if (step === 'init') {
    if (!process.env.ANTHROPIC_API_KEY) {
      res.status(200).json({
        status: 'degraded',
        ...computeFallbackGrade(ctx),
        questions: [
          ctx.trade_count
            ? `You took ${ctx.trade_count} trade${ctx.trade_count === 1 ? '' : 's'} today. Which one are you least proud of, and why?`
            : 'You took no trades today. Was that patience or fear?',
          ctx.rule_violations.length
            ? `You broke "${ctx.rule_violations[0].rule}". What was going through your head?`
            : 'Where did you follow your plan best today?',
        ],
        context_summary: `${ctx.trade_count} trades, net ${ctx.total_pnl}, grade ${ctx.grade_letter}.`,
      });
      return;
    }
    try {
      const system =
        'You are Ark, a blunt trading coach conducting a session debrief. Ask exactly 2-3 pointed questions based on the trader\'s actual data. Reference specific trades, times, or patterns. No soft-pedaling. Return JSON only.';
      const userPrompt =
        JSON.stringify({ context: ctx }) +
        '\n\nReturn JSON: {questions: [string, string, string?] (each references actual trade data), context_summary: string (1 sentence)}';
      const raw = await callClaude({ system, userPrompt });
      const valid = validateInitOutput(raw);
      if (!valid) throw new Error('init output failed schema validation');
      res.status(200).json({ status: 'ok', ...valid });
    } catch (e) {
      console.warn('[ark/debrief] init AI failed, degrading:', e && e.message);
      res.status(200).json({
        error: 'degraded',
        ...computeFallbackGrade(ctx),
        questions: [
          ctx.trade_count
            ? `You took ${ctx.trade_count} trade${ctx.trade_count === 1 ? '' : 's'} today. Which one are you least proud of?`
            : 'You took no trades today. Patience or fear?',
          'Where did your discipline hold, and where did it slip?',
        ],
        context_summary: `${ctx.trade_count} trades, net ${ctx.total_pnl}, grade ${ctx.grade_letter}.`,
      });
    }
    return;
  }

  // ── Step: answer ──────────────────────────────────────────────────────
  const history = Array.isArray(body.conversation_history) ? body.conversation_history : [];
  const answer = typeof body.answer === 'string' ? body.answer : '';
  // Count how many times the trader has answered (assistant questions are
  // separate). Final evaluation once >= 2 answers have been given.
  const answeredCount = history.filter((h) => h && h.role === 'user').length + (answer ? 1 : 0);
  const isFinal = answeredCount >= 2;

  // Graceful degradation when no key — deterministic fallback.
  if (!process.env.ANTHROPIC_API_KEY) {
    if (isFinal) {
      const det = deterministicResult(ctx);
      await persistResult(sb, user.id, tradingDay, det.result);
      res.status(200).json({ status: 'degraded', ...det });
    } else {
      res.status(200).json({
        status: 'degraded',
        done: false,
        question: 'And what will you do differently next session?',
      });
    }
    return;
  }

  try {
    if (!isFinal) {
      const system =
        'You are Ark, a blunt trading coach conducting a session debrief. Based on the conversation so far and the trader\'s data, ask ONE more pointed follow-up question. Reference specifics. No soft-pedaling. Return JSON only.';
      const userPrompt =
        JSON.stringify({ context: ctx, conversation_history: history, latest_answer: answer }) +
        '\n\nReturn JSON: {done: false, question: string}';
      const raw = await callClaude({ system, userPrompt });
      const q = raw && typeof raw.question === 'string' && raw.question.trim();
      if (!q) throw new Error('follow-up output missing question');
      res.status(200).json({ status: 'ok', done: false, question: q });
      return;
    }

    // Final evaluation.
    const system =
      'Generate the final grade and journal entry. Return ONLY the JSON schema. journal_entry should be 2-3 sentences in first person, past tense. Grade is process-only, NEVER P&L-based.';
    const userPrompt =
      JSON.stringify({ context: ctx, conversation_history: history, latest_answer: answer }) +
      '\n\nReturn JSON: {done: true, result: {journal_entry: string (2-3 sentences, first person, past tense), mood_tags: string[], grade: "A"|"B"|"C"|"D"|"F" (process-only), grade_bars: {rules: 0-100, kz: 0-100, risk: 0-100}, tomorrow_focus: string}}';
    const raw = await callClaude({ system, userPrompt });
    const valid = validateFinalResult(raw);
    if (!valid) throw new Error('final result failed schema validation');
    await persistResult(sb, user.id, tradingDay, valid.result);
    res.status(200).json({ status: 'ok', ...valid });
  } catch (e) {
    console.warn('[ark/debrief] answer AI failed, degrading:', e && e.message);
    if (isFinal) {
      const det = deterministicResult(ctx);
      await persistResult(sb, user.id, tradingDay, det.result);
      res.status(200).json({ error: 'degraded', ...det });
    } else {
      res.status(200).json({
        error: 'degraded',
        done: false,
        question: 'And what will you do differently next session?',
      });
    }
  }
}

// ── Persist the final result to Supabase ────────────────────────────────
// Saved to user_settings as { user_id, key: 'debrief:<day>', value: result }.
async function persistResult(sb, userId, tradingDay, result) {
  try {
    const { error } = await sb
      .from('user_settings')
      .upsert(
        { user_id: userId, key: `debrief:${tradingDay}`, value: result },
        { onConflict: 'user_id,key' }
      );
    if (error) console.warn('[ark/debrief] persist failed:', error.message);
  } catch (e) {
    console.warn('[ark/debrief] persist threw:', e && e.message);
  }
}
