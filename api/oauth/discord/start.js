import { randomBytes } from 'node:crypto';
import { signState, serializeCookie } from '../../_lib/crypto.js';
import { sbAnon } from '../../_lib/supabase.js';

const DISCORD_AUTHORIZE_URL = 'https://discord.com/api/oauth2/authorize';
const OAUTH_SCOPES = 'identify guilds.members.read';
const STATE_TTL_SECONDS = 600;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed', allowed: ['POST'] });
    return;
  }

  // ── Require Supabase Bearer token ───────────────────────────────
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) {
    res.status(401).json({ error: 'auth required' });
    return;
  }

  let userId;
  try {
    const { data: { user }, error } = await sbAnon().auth.getUser(token);
    if (error || !user) throw new Error('invalid token');
    userId = user.id;
  } catch (e) {
    console.warn('[oauth/start] auth check failed:', e && e.message);
    res.status(401).json({ error: 'auth required' });
    return;
  }

  // ── Validate plan ───────────────────────────────────────────────
  const plan = (req.body && req.body.plan) || '';
  if (plan !== 'premium' && plan !== 'elite') {
    res.status(400).json({ error: 'invalid plan', allowed: ['premium', 'elite'] });
    return;
  }

  // ── Required env ────────────────────────────────────────────────
  const clientId = process.env.DISCORD_CLIENT_ID;
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL;
  const encKey = process.env.ENCRYPTION_KEY;
  if (!clientId || !siteUrl || !encKey) {
    console.error('[oauth/start] missing env', {
      hasClientId: !!clientId, hasSiteUrl: !!siteUrl, hasEncKey: !!encKey,
    });
    res.status(500).json({ error: 'server misconfigured' });
    return;
  }

  // ── Sign state with user_id baked in ────────────────────────────
  const nonce = randomBytes(16).toString('hex');
  const state = signState(
    { n: nonce, p: plan, u: userId, t: Math.floor(Date.now() / 1000) },
    encKey,
  );

  res.setHeader('Set-Cookie', serializeCookie('rwd_oauth_n', nonce, {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: STATE_TTL_SECONDS,
    secure: siteUrl.startsWith('https://'),
  }));

  // ── Build Discord authorize URL ─────────────────────────────────
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    scope: OAUTH_SCOPES,
    redirect_uri: `${siteUrl}/oauth/discord/callback`,
    state,
    prompt: 'consent',
  });

  res.status(200).json({ url: `${DISCORD_AUTHORIZE_URL}?${params.toString()}` });
}
