// Discord API helpers. Uses the user's OAuth access token for identity
// and guild-member lookup (no bot token — see architecture pivot in spec).
//
// Each helper returns a normalized shape: { status, ok, ...responseBody }.
// Status is always present, even on body-parse failure.

const DISCORD_API = 'https://discord.com/api';

async function asJson(r) {
  try { return await r.json(); }
  catch { return {}; }
}

export async function exchangeCode(code) {
  const clientId = process.env.DISCORD_CLIENT_ID;
  const clientSecret = process.env.DISCORD_CLIENT_SECRET;
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL;
  if (!clientId || !clientSecret || !siteUrl) {
    throw new Error('discord env missing');
  }
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'authorization_code',
    code,
    redirect_uri: `${siteUrl}/oauth/discord/callback`,
  });
  const r = await fetch(`${DISCORD_API}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  return { status: r.status, ok: r.ok, ...(await asJson(r)) };
}

export async function fetchMe(accessToken) {
  const r = await fetch(`${DISCORD_API}/users/@me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return { status: r.status, ok: r.ok, ...(await asJson(r)) };
}

// Refresh an expired/expiring access token using the refresh_token grant.
// Throws with err.kind === 'token_revoked' on 400/401 — Discord returns 400
// "invalid_grant" when the refresh token has been revoked (e.g., user
// disconnected the app on Discord settings) or has expired (~30 days unused).
export async function refreshAccessToken(refreshToken) {
  const clientId = process.env.DISCORD_CLIENT_ID;
  const clientSecret = process.env.DISCORD_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('discord env missing');
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });
  const r = await fetch(`${DISCORD_API}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (r.status === 400 || r.status === 401) {
    const err = new Error('refresh token rejected');
    err.kind = 'token_revoked';
    throw err;
  }
  if (!r.ok) {
    const err = new Error(`refresh failed: ${r.status}`);
    err.kind = 'refresh_failed';
    throw err;
  }
  const data = await asJson(r);
  if (!data.access_token) {
    const err = new Error('refresh missing access_token');
    err.kind = 'refresh_failed';
    throw err;
  }
  return {
    access:     data.access_token,
    // Discord usually rotates refresh tokens; some flows reuse. Fall back to
    // the input if the response omits it.
    refresh:    data.refresh_token || refreshToken,
    expiresIso: data.expires_in
      ? new Date(Date.now() + data.expires_in * 1000).toISOString()
      : null,
  };
}

export async function fetchGuildMember(accessToken, guildId) {
  // Requires the `guilds.members.read` scope on the access token.
  // 200 → { roles: [...], user: {...}, nick, ... }
  // 404 → user is not a member of the guild
  // 401 → token revoked / scope missing
  const r = await fetch(`${DISCORD_API}/users/@me/guilds/${guildId}/member`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (r.status === 404) return { status: 404, ok: false };
  return { status: r.status, ok: r.ok, ...(await asJson(r)) };
}
