// POST /api/ark/trade-read — The Ark's per-trade instant read (Haiku).
//
// Given one trade's data alongside the trader's own averages, returns a blunt,
// two-line read on what was right or wrong about the setup/execution and the
// process implication. Uses Claude Haiku (claude-haiku-4-5) when
// ANTHROPIC_API_KEY is present; degrades silently otherwise.
//
// This endpoint is fire-and-forget from the client: a single fast call with no
// caching (each trade is unique). On any failure the client silent-skips, so
// we return 200 with a 'degraded' status and null lines rather than erroring.
//
// Request:  { trade: {sym, type, session, setup, r_multiple, emotion, confluences} }
//           — typically the output of ArkEngine.buildTradeReadContext(), which
//           the client passes in the request (its {trade, user_averages} shape
//           is accepted verbatim and forwarded as context).
// Auth:     Supabase Bearer (same pattern as api/ark/coaching.js).
//
// ─────────────────────────────────────────────────────────────────────────
// VERCEL ROUTING — api/* functions are auto-detected by Vercel, so no
// vercel.json rewrite entry is required. (POST /api/ark/trade-read maps to
// this file automatically.)
//
// ─────────────────────────────────────────────────────────────────────────
// ENV VAR REQUIRED FOR REAL AI: ANTHROPIC_API_KEY
//   Without it, this endpoint returns {status:'degraded', line1:null, line2:null}.

import { sbAnon } from '../_lib/supabase.js';

const MODEL = 'claude-haiku-4-5';

// ── Schema validation for AI output ─────────────────────────────────────
function validateResult(r) {
  if (!r || typeof r !== 'object') return null;
  const { line1, line2 } = r;
  if (typeof line1 !== 'string' || !line1.trim()) return null;
  if (typeof line2 !== 'string' || !line2.trim()) return null;
  return { line1: line1.trim(), line2: line2.trim() };
}

// ── Claude call (raw fetch, no SDK dependency) ──────────────────────────
async function callClaude(input) {
  const systemPrompt =
    'You are Ark, a blunt trading coach. Given one trade\'s data vs the trader\'s averages, return ONLY valid JSON, no prose.';
  const userPrompt =
    JSON.stringify(input) +
    '\n\nReturn: {line1: string (≤12 words, what was right or wrong about setup/execution), line2: string (≤10 words, process implication)}';

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 120,
      temperature: 0.3,
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

  try {
    const { data, error } = await sbAnon().auth.getUser(token);
    if (error || !data.user) throw new Error('invalid token');
  } catch (e) {
    console.warn('[ark/trade-read] auth failed:', e && e.message);
    res.status(401).json({ error: 'auth required' });
    return;
  }

  // ── Validate body ──────────────────────────────────────────────────
  const trade = req.body && req.body.trade;
  if (!trade || typeof trade !== 'object') {
    res.status(400).json({ error: 'invalid trade', expected: '{ trade: {...} }' });
    return;
  }

  // The client passes the output of ArkEngine.buildTradeReadContext(), which
  // is shaped { trade, user_averages }. Accept either that wrapped shape (use
  // it as context directly) or a bare trade object.
  const context = (req.body && typeof req.body.context === 'object' && req.body.context)
    ? req.body.context
    : { user_averages: (req.body && req.body.user_averages) || null };

  // ── Graceful degradation: no key → degraded, no AI ─────────────────
  if (!process.env.ANTHROPIC_API_KEY) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ status: 'degraded', line1: null, line2: null });
    return;
  }

  // ── Generate (fire-and-forget; any failure → degraded null lines) ──
  try {
    const result = await callClaude({ trade, context });
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ status: 'ok', line1: result.line1, line2: result.line2 });
  } catch (e) {
    console.warn('[ark/trade-read] AI call failed, degrading:', e && e.message);
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ status: 'degraded', line1: null, line2: null });
  }
}
