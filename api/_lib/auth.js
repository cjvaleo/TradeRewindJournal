// Shared request auth for the Review-system endpoints.
// Mirrors the inline pattern in api/me.js / api/billing/*: verify the
// Supabase Bearer JWT, and gate on an active Pro tier.

import { sbAnon, sbService } from './supabase.js';

/**
 * Verify the Authorization: Bearer <jwt> header.
 * On success returns the auth user. On failure writes a 401 and returns null —
 * callers should `if (!user) return;` immediately.
 */
export async function authUser(req, res) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    res.status(401).json({ error: 'auth required' });
    return null;
  }
  try {
    const { data, error } = await sbAnon().auth.getUser(token);
    if (error || !data.user) throw new Error('invalid token');
    return data.user;
  } catch (e) {
    console.warn('[auth] token check failed:', e && e.message);
    res.status(401).json({ error: 'auth required' });
    return null;
  }
}

/**
 * Active-Pro check — same shape as api/me.js: is_pro AND a pro_source AND
 * pro_active_until still in the future.
 */
export async function isProUser(userId) {
  const { data: profile, error } = await sbService()
    .from('profiles')
    .select('is_pro, pro_source, pro_active_until')
    .eq('id', userId)
    .maybeSingle();
  if (error || !profile) return false;
  const untilMs = profile.pro_active_until ? Date.parse(profile.pro_active_until) : 0;
  return !!(profile.is_pro && profile.pro_source && untilMs > Date.now());
}

/**
 * Auth + Pro in one call. Returns the user, or null after writing the
 * appropriate 401 / 403 response.
 */
export async function requirePro(req, res) {
  const user = await authUser(req, res);
  if (!user) return null;
  if (!(await isProUser(user.id))) {
    res.status(403).json({
      error: 'pro_required',
      message: 'The Review system is a Pro feature — upgrade to build and track your rules.',
    });
    return null;
  }
  return user;
}
