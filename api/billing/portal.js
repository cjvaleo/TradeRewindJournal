import { sbAnon, sbService } from '../_lib/supabase.js';
import { getStripe } from '../_lib/stripe.js';

// ─────────────────────────────────────────────────────────────────────
// STRIPE DASHBOARD CONFIGURATION REQUIRED before this route works in
// production. The Customer Portal must be enabled + configured at:
//   Stripe Dashboard → Settings → Billing → Customer portal
//
// Settings to apply:
//   ENABLE
//   ✓ Update payment method
//   ✓ View and download invoices
//   ✓ View upcoming invoice
//   ✓ View past charges / billing history
//
//   DISABLE
//   ✗ Cancel subscriptions
//     → Users must flow through our 3-step save-offer modal in the SPA
//       (cancelModalOpen). Stripe's default cancel-anytime button
//       bypasses that flow, so it must be off.
//   ✗ Switch plans / upgrade / downgrade
//     → We handle plan changes via /upgrade with the discord_elite
//       carve-out preserved. Letting Stripe's portal switch plans
//       would skip our pro_source bookkeeping.
//   ✗ Pause subscriptions
//     → Handled by our /api/billing/pause endpoint instead.
//
// Branding: match Rewind site colors so the portal feels native.
//
// Test mode + live mode are configured SEPARATELY in Stripe Dashboard.
// Both environments need the same settings before each respective
// portal flow works end-to-end. The 'apiVersion' pin in
// api/_lib/stripe.js means SDK changes won't drift the behaviour.
// ─────────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed', allowed: ['POST'] });
    return;
  }

  // ── Auth: Supabase Bearer REQUIRED ───────────────────────────────
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
    console.warn('[billing/portal] auth check failed:', e && e.message);
    res.status(401).json({ error: 'auth required' });
    return;
  }

  // ── Env ──────────────────────────────────────────────────────────
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL;
  if (!siteUrl) {
    console.error('[billing/portal] NEXT_PUBLIC_SITE_URL missing');
    res.status(500).json({ error: 'server misconfigured' });
    return;
  }

  // ── Read profile: customer_id (preferred) + subscription_id (backfill source) ──
  const sb = sbService();
  const { data: profile, error: readErr } = await sb
    .from('profiles')
    .select('stripe_customer_id, stripe_subscription_id')
    .eq('id', user.id)
    .maybeSingle();
  if (readErr) {
    console.error('[billing/portal] profile read failed:', readErr.message);
    res.status(500).json({ error: 'profile read failed' });
    return;
  }
  if (!profile) {
    res.status(404).json({ error: 'profile not found' });
    return;
  }

  // ── Resolve customer_id (lazy backfill from subscription if missing) ──
  // Going-forward checkouts persist stripe_customer_id directly in the
  // webhook (see api/stripe/webhook.js). This branch handles pre-fix
  // legacy users + any rare case where the webhook write was lost.
  let customerId = profile.stripe_customer_id;
  const stripe = getStripe();

  if (!customerId) {
    if (!profile.stripe_subscription_id) {
      // No Stripe footprint at all — Free or Discord-only Elite. The SPA
      // shouldn't POST here for these tiers, but defend the route anyway.
      res.status(400).json({ error: 'no stripe customer' });
      return;
    }
    try {
      const sub = await stripe.subscriptions.retrieve(profile.stripe_subscription_id);
      customerId = typeof sub.customer === 'string'
        ? sub.customer
        : (sub.customer && sub.customer.id);
      if (!customerId) throw new Error('subscription has no customer');
      // Persist for next time — one-time API cost per legacy user.
      const { error: upErr } = await sb
        .from('profiles')
        .update({ stripe_customer_id: customerId })
        .eq('id', user.id);
      if (upErr) {
        // Non-fatal — log and continue. We'll lazy-fetch again next click.
        console.warn('[billing/portal] customer_id backfill write failed:', upErr.message);
      } else {
        console.log('[billing/portal] customer_id backfilled', {
          user_id: user.id, customer_id: customerId,
        });
      }
    } catch (e) {
      console.error('[billing/portal] subscription retrieve threw:', e && e.message);
      res.status(500).json({ error: 'could not resolve stripe customer' });
      return;
    }
  }

  // ── Create portal session ───────────────────────────────────────
  let session;
  try {
    session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${siteUrl}/account#billing`,
    });
  } catch (e) {
    console.error('[billing/portal] session create threw:', e && e.message);
    // Most common cause: Stripe Dashboard customer portal not configured
    // yet. See the top-of-file comment for the required settings.
    res.status(500).json({ error: 'could not open portal' });
    return;
  }

  console.log('[billing/portal] session opened', {
    user_id: user.id, customer_id: customerId,
  });
  res.status(200).json({ ok: true, url: session.url });
}
