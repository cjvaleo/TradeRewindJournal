// Shared crypto + cookie helpers for OAuth routes.
//
// Files under api/_lib/ are private (underscore-prefixed names are not
// exposed as serverless functions by Vercel).

import {
  randomBytes,
  createHmac,
  createCipheriv,
  createDecipheriv,
  timingSafeEqual,
} from 'node:crypto';

// ── base64url ─────────────────────────────────────────────────────
export function b64url(input) {
  return Buffer.from(input).toString('base64')
    .replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

export function fromB64url(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}

// ── HMAC-signed state ─────────────────────────────────────────────
// Format: <base64url(JSON payload)>.<base64url(HMAC-SHA256 sig)>
// Verifier uses constant-time comparison.

export function signState(payload, keyHex) {
  const key = Buffer.from(keyHex, 'hex');
  const json = JSON.stringify(payload);
  const sig = createHmac('sha256', key).update(json).digest();
  return b64url(json) + '.' + b64url(sig);
}

export function verifyState(state, keyHex) {
  if (typeof state !== 'string' || !state.includes('.')) return null;
  const dot = state.indexOf('.');
  const payloadB64 = state.slice(0, dot);
  const sigB64 = state.slice(dot + 1);
  let payload, sig;
  try {
    payload = fromB64url(payloadB64);
    sig = fromB64url(sigB64);
  } catch { return null; }
  const key = Buffer.from(keyHex, 'hex');
  const expected = createHmac('sha256', key).update(payload).digest();
  if (sig.length !== expected.length) return null;
  if (!timingSafeEqual(sig, expected)) return null;
  try { return JSON.parse(payload.toString('utf8')); }
  catch { return null; }
}

// ── AES-256-GCM token encryption ──────────────────────────────────
// Blob layout: iv(12) || ciphertext(N) || authTag(16), base64-encoded.
// IV is a fresh random 12 bytes per encryption — NEVER reused.
// GCM auth tag guarantees integrity; decryptToken() throws on tamper.

export function encryptToken(plaintext, keyHex) {
  if (typeof plaintext !== 'string') throw new Error('plaintext must be string');
  const key = Buffer.from(keyHex, 'hex');
  if (key.length !== 32) throw new Error('encryption key must be 32 bytes (64 hex chars)');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ct, tag]).toString('base64');
}

export function decryptToken(b64, keyHex) {
  const key = Buffer.from(keyHex, 'hex');
  if (key.length !== 32) throw new Error('encryption key must be 32 bytes (64 hex chars)');
  const blob = Buffer.from(b64, 'base64');
  if (blob.length < 12 + 16) throw new Error('encrypted blob too short');
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(blob.length - 16);
  const ct = blob.subarray(12, blob.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

// ── Cookie helpers ────────────────────────────────────────────────
export function readCookie(req, name) {
  const header = req.headers && req.headers.cookie;
  if (!header) return null;
  const pairs = header.split(';');
  for (const pair of pairs) {
    const idx = pair.indexOf('=');
    if (idx < 0) continue;
    const k = pair.slice(0, idx).trim();
    if (k === name) return pair.slice(idx + 1).trim();
  }
  return null;
}

export function serializeCookie(name, value, opts = {}) {
  const parts = [`${name}=${value}`];
  if (opts.httpOnly) parts.push('HttpOnly');
  if (opts.sameSite) parts.push(`SameSite=${opts.sameSite}`);
  if (opts.path) parts.push(`Path=${opts.path}`);
  if (opts.maxAge != null) parts.push(`Max-Age=${opts.maxAge}`);
  if (opts.secure) parts.push('Secure');
  return parts.join('; ');
}
