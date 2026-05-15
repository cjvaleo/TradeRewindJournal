// RETIRED — May 2026 Trading Ark consolidation.
//
// Trading Ark Premium is now a single paid tier that includes Rewind Pro for
// FREE. There is no $9/mo Stripe step anymore: the Discord OAuth callback
// (api/oauth/discord/callback.js, Branch B) grants Pro directly when the
// Premium role is detected.
//
// This route used to be the 302 target from that callback. The callback no
// longer redirects here and no longer mints the rwd_premium_confirmed cookie,
// so nothing should reach this handler in normal flow. It's kept as a tomb-
// stone returning 410 Gone in case a stale link or bookmark hits it.
//
// The Direct ($19/mo) Stripe path is unaffected — see api/checkout/direct.js.

export default function handler(req, res) {
  res.status(410).json({
    error: 'gone',
    message: 'Premium tier is now included free with Trading Ark Premium membership. Sign in with Discord to unlock.',
  });
}
