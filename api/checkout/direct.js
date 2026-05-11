export default function handler(req, res) {
  res.status(501).json({
    error: 'not implemented',
    route: '/api/checkout/direct',
    note: 'Scaffolded route. Real Stripe Checkout session lands in step 4.'
  });
}
