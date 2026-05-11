export default function handler(req, res) {
  res.status(501).json({
    error: 'not implemented',
    route: '/oauth/discord/start',
    note: 'Scaffolded route. Real Discord OAuth redirect (with state + PKCE) lands in step 4.'
  });
}
