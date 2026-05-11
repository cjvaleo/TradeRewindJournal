export default function handler(req, res) {
  res.status(501).json({
    error: 'not implemented',
    route: '/api/stripe/webhook',
    note: 'Scaffolded route. Real handler will: (1) verify Stripe signature, (2) check webhook_events table for idempotency BEFORE any work, (3) apply event to profiles. Lands in step 4.'
  });
}
