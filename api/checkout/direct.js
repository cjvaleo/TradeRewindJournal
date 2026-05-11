import { sbAnon, sbService } from '../_lib/supabase.js';
import { getStripe } from '../_lib/stripe.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed', allowed: ['POST'] });
    return;
  }

  // ── Auth ────────────────────────────────────────────────────────
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) {
    res.status(401).json({ error: 'auth required' });
    return;
  }

  let user;
  try {
    const { data, error } = await sbAnon().auth.getUser(token);
    if (error || !data.user) throw new Error('invalid token');
    user = data.user;
  } catch (e) {
    console.warn('[checkout/direct] auth failed:', e && e.message);
    res.status(401).json({ error: 'auth required' });
    return;
  }

  // ── Env ─────────────────────────────────────────────────────────
  const siteUrl   = process.env.NEXT_PUBLIC_SITE_URL;
  const priceId   = process.env.STRIPE_PRICE_DIRECT_ID;
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!siteUrl || !priceId || !stripeKey) {
    console.error('[checkout/direct] missing env', {
      hasSiteUrl: !!siteUrl, hasPriceId: !!priceId, hasStripeKey: !!stripeKey,
    });
    res.status(500).json({ error: 'server misconfigured' });
    return;
  }

  const stripe = getStripe();
  const sb = sbService();

  // ── Look up existing Stripe customer for this profile ───────────
  let customerId;
  try {
    const { data: profile, error: pErr } = await sb
      .from('profiles')
      .select('stripe_customer_id')
      .eq('id', user.id)
      .maybeSingle();
    if (pErr) throw pErr;
    customerId = (profile && profile.stripe_customer_id) || null;
  } catch (e) {
    console.error('[checkout/direct] profile lookup failed:', e && e.message);
    res.status(500).json({ error: 'profile lookup failed' });
    return;
  }

  // ── Create + persist customer if none exists ────────────────────
  if (!customerId) {
    try {
      const customer = await stripe.customers.create({
        email: user.email,
        metadata: { user_id: user.id },
      });
      customerId = customer.id;
    } catch (e) {
      console.error('[checkout/direct] customer create failed:', e && e.message);
      res.status(500).json({ error: 'stripe customer create failed' });
      return;
    }
    // Persist immediately so checkout retries reuse this customer.
    // If the write fails, the customer still exists in Stripe — webhook
    // will reconcile on completion. Log + proceed.
    const { error: upErr } = await sb
      .from('profiles')
      .update({ stripe_customer_id: customerId })
      .eq('id', user.id);
    if (upErr) {
      console.warn('[checkout/direct] save customer_id failed:', upErr.message);
    }
  }

  // ── Create Checkout Session ─────────────────────────────────────
  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      customer: customerId,
      // Required for automatic_tax when reusing a customer — Checkout
      // captures address/name at checkout and writes back to the customer.
      customer_update: { address: 'auto', name: 'auto' },
      client_reference_id: user.id,
      subscription_data: {
        metadata: { user_id: user.id, plan: 'direct' },
      },
      success_url: `${siteUrl}/welcome/direct`,
      cancel_url:  `${siteUrl}/upgrade?canceled=1`,
      automatic_tax: { enabled: true },
      allow_promotion_codes: false,
    });
    res.status(200).json({ url: session.url });
  } catch (e) {
    console.error('[checkout/direct] session create failed:', e && e.message);
    res.status(500).json({ error: 'checkout session create failed' });
  }
}
