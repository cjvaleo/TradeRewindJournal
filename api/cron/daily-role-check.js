export default function handler(req, res) {
  res.status(501).json({
    error: 'not implemented',
    route: '/api/cron/daily-role-check',
    note: 'Scaffolded route. Real handler will: (1) verify Bearer CRON_SECRET, (2) iterate Discord-linked profiles, (3) refresh each user token, (4) re-check guild roles, (5) update is_pro / pro_source / pro_active_until. Lands in step 4. Schedule wired in vercel.json: 0 3 * * * UTC.'
  });
}
