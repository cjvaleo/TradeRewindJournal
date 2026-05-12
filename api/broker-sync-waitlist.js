import { sbAnon, sbService } from './_lib/supabase.js';

// Conservative email regex — catches obvious garbage without being so strict
// it rejects valid edge cases. Server-side last line of defense; the SPA
// also validates client-side before POSTing.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed', allowed: ['POST'] });
    return;
  }

  // ── Body ──────────────────────────────────────────────────────
  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const emailRaw = (body.email || '').trim().toLowerCase();
  if (!emailRaw || !EMAIL_RE.test(emailRaw) || emailRaw.length > 254) {
    res.status(400).json({ error: 'invalid email' });
    return;
  }

  // ── Optional auth — capture user_id if a Bearer token is present ──
  // Anonymous signups are allowed (visitors might land directly on the
  // page before signing in). We only set user_id when we can verify it.
  let userId = null;
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (token) {
    try {
      const { data, error } = await sbAnon().auth.getUser(token);
      if (!error && data && data.user) userId = data.user.id;
    } catch (e) {
      // Auth failure is non-fatal — proceed as anonymous signup.
      console.warn('[broker-sync-waitlist] auth check threw:', e && e.message);
    }
  }

  // ── Upsert with ignoreDuplicates so a re-submit returns cleanly ──
  // The .select() returns the row only when an INSERT actually happened;
  // an empty array signals "row already existed" → alreadyOnList=true.
  const sb = sbService();
  let data, error;
  try {
    const r = await sb
      .from('broker_sync_waitlist')
      .upsert(
        { email: emailRaw, user_id: userId },
        { onConflict: 'email', ignoreDuplicates: true }
      )
      .select('id');
    data = r.data;
    error = r.error;
  } catch (e) {
    console.error('[broker-sync-waitlist] insert threw:', e && e.message);
    res.status(500).json({ error: 'waitlist write failed' });
    return;
  }

  if (error) {
    console.error('[broker-sync-waitlist] insert failed:', error.message);
    res.status(500).json({ error: 'waitlist write failed' });
    return;
  }

  const alreadyOnList = !data || data.length === 0;
  console.log('[broker-sync-waitlist] signup', {
    email: emailRaw, user_id: userId, alreadyOnList,
  });
  res.status(200).json({ ok: true, alreadyOnList });
}
