export default function handler(req, res) {
  res.status(501).json({
    error: 'not implemented',
    route: '/api/me',
    note: 'Scaffolded route. Returns the caller\'s tier + entitlement state in step 4.'
  });
}
