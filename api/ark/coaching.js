// POST /api/ark/coaching — The Ark's daily coaching endpoint.
//
// Generates a blunt, data-grounded coaching read on the trader's *previous*
// trading day: a grade comment, a directive, and highlight/lowlight pairs.
// Uses Claude (claude-sonnet-4-6) when ANTHROPIC_API_KEY is present, and
// falls back to a deterministic, data-informed result when it is not (or when
// the API call fails). Results are cached per trading_day in
// profiles.coaching_cache for 4 hours.
//
// Request:  { trading_day: 'YYYY-MM-DD' }   (the day the user is *grading*)
// Auth:     Supabase Bearer (same pattern as api/insights/generate.js)
//
// ─────────────────────────────────────────────────────────────────────────
// MIGRATION — run once in the Supabase SQL editor to add the cache column:
//
//   ALTER TABLE public.profiles
//     ADD COLUMN IF NOT EXISTS coaching_cache JSONB DEFAULT '{}';
//
// ─────────────────────────────────────────────────────────────────────────
// VERCEL ROUTING — api/* functions are auto-detected by Vercel, so no
// vercel.json rewrite entry is required. (POST /api/ark/coaching maps to
// this file automatically.) Left as a comment intentionally — do not add a
// rewrite for it.
//
// ─────────────────────────────────────────────────────────────────────────
// ENV VAR REQUIRED FOR REAL AI: ANTHROPIC_API_KEY
//   1. Vercel dashboard → Project Settings → Environment Variables
//   2. .env.local (for local dev)
// Without it, this endpoint runs in deterministic ('degraded') mode.

import { sbAnon, sbService } from '../_lib/supabase.js';

const MODEL = 'claude-sonnet-4-6';
const CACHE_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours
const NY_TZ = 'America/New_York';

// ── ET trading-day helpers (no date libs) ───────────────────────────────
// Returns 'YYYY-MM-DD' for the ET wall-clock date of a UTC timestamp.
function etDateString(d) {
  // en-CA yields YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: NY_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

// Step back one calendar day from a 'YYYY-MM-DD' string. Good enough for the
// "previous trading day" fallback (weekends simply yield empty trade sets).
function previousDay(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - 1);
  return dt.toISOString().slice(0, 10);
}

function isValidYmd(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  return true;
}

// ── Aggregate building ──────────────────────────────────────────────────
function num(v) {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

function buildPayloadFromTrades(tradingDay, trades, userRules) {
  const tradesYesterday = trades.map((t) => {
    const td = t.trade_data && typeof t.trade_data === 'object' ? t.trade_data : {};
    return {
      time: t.date || td.time || null,
      r_multiple: num(t.rr ?? td.r_multiple ?? td.rr),
      setup: t.type || td.setup || null,
      model: td.model || t.sym || null,
      confluences: t.confluences || td.confluences || [],
      emotion: t.emotion || td.emotion || null,
      rule_violations: td.rule_violations || t.rule_violations || [],
    };
  });

  const count = trades.length;
  const pnls = trades.map((t) => num(t.pnl));
  const rs = trades.map((t) => num(t.rr));
  const wins = pnls.filter((p) => p > 0).length;
  const netPnl = pnls.reduce((a, b) => a + b, 0);
  const winRate = count > 0 ? Math.round((wins / count) * 100) : 0;
  const avgR = count > 0 ? rs.reduce((a, b) => a + b, 0) / count : 0;

  // best setup by summed pnl; worst pattern surfaced as a coarse signal
  const bySetup = {};
  for (const t of trades) {
    const key = t.type || (t.trade_data && t.trade_data.setup) || 'UNKNOWN';
    bySetup[key] = (bySetup[key] || 0) + num(t.pnl);
  }
  let bestSetup = null;
  let bestSetupPnl = -Infinity;
  let worstSetup = null;
  let worstSetupPnl = Infinity;
  for (const [k, v] of Object.entries(bySetup)) {
    if (v > bestSetupPnl) { bestSetupPnl = v; bestSetup = k; }
    if (v < worstSetupPnl) { worstSetupPnl = v; worstSetup = k; }
  }

  // simple pattern surface
  const patterns = [];
  if (count > 0) {
    if (winRate >= 60) patterns.push('high_win_rate');
    if (winRate <= 35) patterns.push('low_win_rate');
    if (avgR < 0) patterns.push('negative_expectancy');
    if (avgR >= 1.5) patterns.push('strong_winners');
    const lossStreak = trades.some((t) => num(t.pnl) < 0);
    if (lossStreak && netPnl < 0) patterns.push('net_loser_day');
  }

  // grade bars (0-100) — coarse heuristics; AI may comment on them
  const violations = tradesYesterday.reduce(
    (acc, t) => acc + (Array.isArray(t.rule_violations) ? t.rule_violations.length : 0),
    0
  );
  const rulesBar = count > 0 ? Math.max(0, Math.round(100 - (violations / count) * 100)) : 0;
  const kzTrades = trades.filter((t) => {
    const s = (t.session || (t.trade_data && t.trade_data.session) || '').toUpperCase();
    return s.includes('NY') || s.includes('LONDON');
  }).length;
  const kzBar = count > 0 ? Math.round((kzTrades / count) * 100) : 0;
  const riskBar = Math.max(0, Math.min(100, Math.round(50 + avgR * 25)));

  return {
    trading_day: tradingDay,
    trades_yesterday: tradesYesterday,
    patterns,
    aggregates: {
      win_rate: winRate,
      avg_r: Math.round(avgR * 100) / 100,
      trade_count: count,
      net_pnl: Math.round(netPnl * 100) / 100,
      best_setup: bestSetup,
      worst_pattern: worstSetup,
    },
    user_rules: Array.isArray(userRules) ? userRules : [],
    grade_bars: { rules: rulesBar, kz: kzBar, risk: riskBar },
  };
}

// ── Deterministic fallback ──────────────────────────────────────────────
function deterministicFallback(input) {
  const a = input.aggregates || {};
  const count = a.trade_count || 0;

  if (count === 0) {
    return {
      grade_comment: 'No trades on the prior session — nothing to grade.',
      directive: 'Show up flat and patient; let a clean A+ setup come to you before risking anything.',
      highlights: ['No forced trades on a dead day.', 'Capital preserved into the next session.'],
      lowlights: ['No data to learn from.', 'Zero reps means zero feedback on your process.'],
    };
  }

  const winRate = a.win_rate || 0;
  const avgR = a.avg_r || 0;
  const netPnl = a.net_pnl || 0;
  const best = a.best_setup || 'your top setup';
  const worst = a.worst_pattern || 'your weakest setup';
  const green = netPnl >= 0;

  const grade_comment = green
    ? `Net ${netPnl >= 0 ? '+' : ''}${netPnl} across ${count} trade${count === 1 ? '' : 's'} at a ${winRate}% win rate — you took what the session gave you.`
    : `Net ${netPnl} across ${count} trade${count === 1 ? '' : 's'} at a ${winRate}% win rate — the session beat you and the numbers say so.`;

  const directive = avgR >= 1
    ? `Keep leaning on ${best} and cut anything that isn't ${avgR}R-or-better quality — your edge is in selectivity, not volume.`
    : `Your average was ${avgR}R — stop taking ${worst} and demand a higher-quality entry before you click.`;

  const highlights = [];
  const lowlights = [];

  if (winRate >= 50) highlights.push(`Hit rate held at ${winRate}% — your reads were mostly right.`);
  else lowlights.push(`Win rate dropped to ${winRate}% — your reads were off more than they were on.`);

  if (avgR >= 1) highlights.push(`Averaged ${avgR}R per trade — winners were paid properly.`);
  else lowlights.push(`Averaged ${avgR}R — you're not letting winners run or you're paying losers too much.`);

  if (green) highlights.push(`Closed the day net positive (${netPnl >= 0 ? '+' : ''}${netPnl}).`);
  else lowlights.push(`Closed the day net negative (${netPnl}).`);

  if (best) highlights.push(`${best} carried the session — that's your bread and butter.`);
  if (worst && worst !== best) lowlights.push(`${worst} leaked the most — tighten or drop it.`);

  return {
    grade_comment,
    directive,
    highlights: highlights.slice(0, 2).length === 2 ? highlights.slice(0, 2) : [...highlights, 'Process reps logged.'].slice(0, 2),
    lowlights: lowlights.slice(0, 2).length === 2 ? lowlights.slice(0, 2) : [...lowlights, 'Room to tighten execution.'].slice(0, 2),
  };
}

// ── Schema validation for AI output ─────────────────────────────────────
function validateResult(r) {
  if (!r || typeof r !== 'object') return null;
  const { grade_comment, directive, highlights, lowlights } = r;
  if (typeof grade_comment !== 'string' || !grade_comment.trim()) return null;
  if (typeof directive !== 'string' || !directive.trim()) return null;
  if (!Array.isArray(highlights) || highlights.length !== 2) return null;
  if (!Array.isArray(lowlights) || lowlights.length !== 2) return null;
  if (!highlights.every((h) => typeof h === 'string' && h.trim())) return null;
  if (!lowlights.every((l) => typeof l === 'string' && l.trim())) return null;
  return {
    grade_comment: grade_comment.trim(),
    directive: directive.trim(),
    highlights: highlights.map((h) => h.trim()),
    lowlights: lowlights.map((l) => l.trim()),
  };
}

// ── Claude call (raw fetch, no SDK dependency) ──────────────────────────
async function callClaude(input) {
  const systemPrompt =
    'You are Ark, a blunt trading coach. Analyze this trader\'s session data and return ONLY valid JSON with the exact schema specified. No markdown. No preamble. Process observations only — never give entry signals, never predict markets.';
  const userPrompt =
    JSON.stringify(input) +
    '\n\nReturn JSON: {grade_comment: string (1 sentence), directive: string (1 sentence, references actual data), highlights: [string, string], lowlights: [string, string]}';

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 600,
      temperature: 0.4,
      messages: [{ role: 'user', content: userPrompt }],
      system: systemPrompt,
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

  // Strip accidental code fences, then parse.
  const cleaned = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    throw new Error('anthropic returned non-JSON');
  }
  const valid = validateResult(parsed);
  if (!valid) throw new Error('anthropic JSON failed schema validation');
  return valid;
}

// ── Handler ─────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed', allowed: ['POST'] });
    return;
  }

  // ── Auth: Supabase Bearer ──────────────────────────────────────────
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) { res.status(401).json({ error: 'auth required' }); return; }

  let user;
  try {
    const { data, error } = await sbAnon().auth.getUser(token);
    if (error || !data.user) throw new Error('invalid token');
    user = data.user;
  } catch (e) {
    console.warn('[ark/coaching] auth failed:', e && e.message);
    res.status(401).json({ error: 'auth required' });
    return;
  }

  // ── Validate body ──────────────────────────────────────────────────
  const tradingDay = req.body && req.body.trading_day;
  if (!isValidYmd(tradingDay)) {
    res.status(400).json({ error: 'invalid trading_day', expected: 'YYYY-MM-DD' });
    return;
  }

  const sb = sbService();

  // ── Read profile: cache + rules ────────────────────────────────────
  let profile;
  try {
    const { data, error } = await sb
      .from('profiles')
      .select('coaching_cache, rules')
      .eq('id', user.id)
      .maybeSingle();
    if (error) throw error;
    profile = data || {};
  } catch (e) {
    console.error('[ark/coaching] profile read failed:', e && e.message);
    res.status(500).json({ error: 'profile read failed' });
    return;
  }

  // ── Cache hit? (< 4h old) ──────────────────────────────────────────
  const cache = (profile.coaching_cache && typeof profile.coaching_cache === 'object')
    ? profile.coaching_cache
    : {};
  const cached = cache[tradingDay];
  if (cached && cached.result && cached.generated_at) {
    const age = Date.now() - Date.parse(cached.generated_at);
    if (Number.isFinite(age) && age >= 0 && age < CACHE_TTL_MS) {
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({
        status: 'ok',
        source: cached.source || 'cache',
        cached: true,
        result: cached.result,
        generated_at: cached.generated_at,
      });
      return;
    }
  }

  // ── Fetch previous trading day's trades ────────────────────────────
  const prevDay = previousDay(tradingDay);
  let trades = [];
  try {
    // Preferred path: a trading_day column exists.
    const q1 = await sb
      .from('trades')
      .select('*')
      .eq('user_id', user.id)
      .eq('trading_day', prevDay);
    if (q1.error) {
      // Column likely missing — fall back to ET date on created_at.
      const startUtc = new Date(`${prevDay}T00:00:00-05:00`).toISOString();
      const endUtc = new Date(`${tradingDay}T00:00:00-05:00`).toISOString();
      const q2 = await sb
        .from('trades')
        .select('*')
        .eq('user_id', user.id)
        .gte('created_at', startUtc)
        .lt('created_at', endUtc);
      if (q2.error) throw q2.error;
      // Refine to ET date to handle the -05:00 vs -04:00 (DST) edge.
      trades = (q2.data || []).filter(
        (t) => t.created_at && etDateString(new Date(t.created_at)) === prevDay
      );
    } else {
      trades = q1.data || [];
    }
  } catch (e) {
    console.error('[ark/coaching] trades read failed:', e && e.message);
    res.status(500).json({ error: 'trades read failed' });
    return;
  }

  // ── Build the input payload ────────────────────────────────────────
  const input = buildPayloadFromTrades(tradingDay, trades, profile.rules);

  // ── Generate: AI when key present, else deterministic ──────────────
  let result;
  let source;
  let status = 'ok';

  if (!process.env.ANTHROPIC_API_KEY) {
    result = deterministicFallback(input);
    source = 'deterministic';
    status = 'degraded';
  } else {
    try {
      result = await callClaude(input);
      source = 'ai';
    } catch (e) {
      console.warn('[ark/coaching] AI call failed, falling back:', e && e.message);
      result = deterministicFallback(input);
      source = 'deterministic';
      status = 'degraded';
    }
  }

  const generatedAt = new Date().toISOString();

  // ── Cache the result ───────────────────────────────────────────────
  try {
    const nextCache = { ...cache, [tradingDay]: { result, source, generated_at: generatedAt } };
    const { error } = await sb
      .from('profiles')
      .update({ coaching_cache: nextCache })
      .eq('id', user.id);
    if (error) console.warn('[ark/coaching] cache write failed:', error.message);
  } catch (e) {
    console.warn('[ark/coaching] cache write threw:', e && e.message);
  }

  res.setHeader('Cache-Control', 'no-store');
  console.log('[ark/coaching]', {
    user_id: user.id,
    trading_day: tradingDay,
    prev_day: prevDay,
    trades: trades.length,
    source,
  });
  res.status(200).json({ status, source, cached: false, result, generated_at: generatedAt });
}
