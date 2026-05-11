export default function handler(req, res) {
  res.status(501).json({
    error: 'not implemented',
    route: '/oauth/discord/callback',
    note: 'Scaffolded route. Token exchange + role check + profile upsert lands in step 4.'
  });
}
