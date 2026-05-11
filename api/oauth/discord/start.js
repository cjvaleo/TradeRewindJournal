import { randomBytes, createHmac } from 'node:crypto';

const DISCORD_AUTHORIZE_URL = 'https://discord.com/api/oauth2/authorize';
const OAUTH_SCOPES = 'identify guilds.members.read';
const STATE_TTL_SECONDS = 600;

function b64url(input) {
  return Buffer.from(input).toString('base64')
    .replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function signState(payload, key) {
  const json = JSON.stringify(payload);
  const sig = createHmac('sha256', key).update(json).digest();
  return b64url(json) + '.' + b64url(sig);
}

export default function handler(req, res) {
  const plan = (req.query && req.query.plan) || '';
  if (plan !== 'premium' && plan !== 'elite') {
    res.status(400).json({ error: 'invalid plan', allowed: ['premium', 'elite'] });
    return;
  }

  const clientId = process.env.DISCORD_CLIENT_ID;
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL;
  const encKey = process.env.ENCRYPTION_KEY;
  if (!clientId || !siteUrl || !encKey) {
    console.error('[oauth/start] missing env', {
      hasClientId: !!clientId, hasSiteUrl: !!siteUrl, hasEncKey: !!encKey
    });
    res.status(500).json({ error: 'server misconfigured' });
    return;
  }

  const nonce = randomBytes(16).toString('hex');
  const state = signState(
    { n: nonce, p: plan, t: Math.floor(Date.now() / 1000) },
    encKey
  );

  // Bind state to this browser via httpOnly cookie. Callback compares the
  // signed nonce in `state` to this cookie — prevents OAuth CSRF.
  // Secure flag only on HTTPS so the cookie still works under `vercel dev`
  // on http://localhost:3000.
  const isHttps = siteUrl.startsWith('https://');
  const cookieParts = [
    `rwd_oauth_n=${nonce}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${STATE_TTL_SECONDS}`
  ];
  if (isHttps) cookieParts.push('Secure');
  res.setHeader('Set-Cookie', cookieParts.join('; '));

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    scope: OAUTH_SCOPES,
    redirect_uri: `${siteUrl}/oauth/discord/callback`,
    state,
    prompt: 'consent'
  });

  res.statusCode = 302;
  res.setHeader('Location', `${DISCORD_AUTHORIZE_URL}?${params.toString()}`);
  res.end();
}
