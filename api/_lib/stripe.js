// Stripe client factory. Pin apiVersion so behaviour is stable across
// SDK upgrades — Stripe rolls API changes per dated version.

import Stripe from 'stripe';

let _stripe;

export function getStripe() {
  if (_stripe) return _stripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('stripe secret key missing');
  _stripe = new Stripe(key, {
    apiVersion: '2024-12-18.acacia',
  });
  return _stripe;
}
