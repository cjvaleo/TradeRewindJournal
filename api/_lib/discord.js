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
