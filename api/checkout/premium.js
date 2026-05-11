import { sbService } from '../_lib/supabase.js';
import { getStripe } from '../_lib/stripe.js';
import { verifyState, readCookie, serializeCookie } from '../_lib/crypto.js';

const COOKIE_TTL_SECONDS = 600;

function redirect(res, location, cookies = []) {
  if (cookies.length) res.setHeader('Set-Cookie', cookies);
  res.statusCode = 302;
  res.setHeader('Location', location);
  res.end();
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'method not allowed', allowed: ['GET'] });
    return;
  }

  // ── Env ─────────────────────────────────────────────────────────
  const siteUrl   = process.env.NEXT_PUBLIC_SITE_URL;
  const priceId   = process.env.STRIPE_PRICE_PREMIUM_ID;
  const encKey    = process.env.ENCRYPTION_KEY;
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!siteUrl || !priceId || !encKey || !stripeKey) {
    console.error('[checkout/premium] missing env', {
      hasSiteUrl: !!siteUrl, hasPriceId: !!priceId,
      hasEncKey: !!encKey, hasStripeKey: !!stripeKey,
    });
    res.status(500).json({ error: 'server misconfigured' });
    return;
  }
  const isHttps = siteUrl.startsWith('https://');

  // ── Read + HMAC-verify the premium-confirmed cookie ─────────────
  // No Bearer auth here: this endpoint is hit via 302 from the OAuth
  // callback (top-level browser GET, no Authorization header). The
  // HMAC-signed cookie IS the auth proof — only the callback could
  // have minted it, and only for a user that just passed Branch B.
  const cookieValue = readCookie(req, 'rwd_premium_confirmed');
  if (!cookieValue) {
    return redirect(res, `/upgrade?error=verify_first`);
  }
  const payload = verifyState(cookieValue, encKey);
  if (!payload) {
    return redirect(res, `/upgrade?error=verify_first`);
  }
  if (payload.p !== 'premium' || !payload.u || !payload.did) {
    return redirect(res, `/upgrade?error=verify_first`);
  }
  const ageSec = Math.floor(Date.now() / 1000) - (payload.t || 0);
  if (ageSec > COOKIE_TTL_SECONDS) {
    return redirect(res, `/upgrade?error=verify_expired`);
  }
  const userId = payload.u;
  const discordUserId = payload.did;

  // Cookie will be cleared on EVERY path after this point — one-use
  // enforcement (prevents replay even if the cookie leaks).
  const clearCookie = serializeCookie('rwd_premium_confirmed', '', {
    httpOnly: true, sameSite: 'Lax', path: '/', maxAge: 0, secure: isHttps,
  });

  // ── Fetch profile for existing customer_id ──────────────────────
  const sb = sbService();
  let profile;
  try {
    const { data, error } = await sb
      .from('profiles')
      .select('stripe_customer_id')
      .eq('id', userId)
      .maybeSingle();
    if (error) throw error;
    profile = data;
  } catch (e) {
    console.error('[checkout/premium] profile lookup failed:', e && e.message);
    return redirect(res, `/upgrade?error=internal`, [clearCookie]);
  }
  if (!profile) {
    console.error('[checkout/premium] profile row missing', { userId });
    return redirect(res, `/upgrade?error=internal`, [clearCookie]);
  }

  let customerId = profile.stripe_customer_id || null;

  // ── Create Stripe customer if not exists (need email from auth.users) ──
  if (!customerId) {
    let email;
    try {
      const { data: userData, error } = await sb.auth.admin.getUserById(userId);
      if (error || !userData || !userData.user) throw new Error('user not found');
      email = userData.user.email;
    } catch (e) {
      console.error('[checkout/premium] user email lookup failed:', e && e.message);
      return redirect(res, `/upgrade?error=internal`, [clearCookie]);
    }

    const stripe = getStripe();
    try {
      const customer = await stripe.customers.create({
        email,
        metadata: {
          user_id: userId,
          discord_user_id: discordUserId,
          source: 'premium_discord_verified',
        },
      });
      customerId = customer.id;
    } catch (e) {
      console.error('[checkout/premium] customer create failed:', e && e.message);
      return redirect(res, `/upgrade?error=internal`, [clearCookie]);
    }
    const { error: upErr } = await sb
      .from('profiles')
      .update({ stripe_customer_id: customerId })
      .eq('id', userId);
    if (upErr) {
      console.warn('[checkout/premium] save customer_id failed:', upErr.message);
    }
  }

  // ── Create Checkout Session ─────────────────────────────────────
  const stripe = getStripe();
  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      customer: customerId,
      customer_update: { address: 'auto', name: 'auto' },
      client_reference_id: userId,
      subscription_data: {
        metadata: {
          user_id: userId,
          plan: 'premium',
          discord_user_id: discordUserId,
        },
      },
      success_url: `${siteUrl}/welcome/premium`,
      cancel_url:  `${siteUrl}/upgrade?canceled=1`,
      automatic_tax: { enabled: true },
      allow_promotion_codes: false,
    });
    return redirect(res, session.url, [clearCookie]);
  } catch (e) {
    console.error('[checkout/premium] session create failed:', e && e.message);
    return redirect(res, `/upgrade?error=internal`, [clearCookie]);
  }
}
