// Server-side Supabase client factories.
// Anon client: for verifying user-supplied JWTs via auth.getUser(token).
// Service client: for writes that bypass RLS (e.g. profile upserts from
// the OAuth callback). NEVER expose the service client to the browser.

import { createClient } from '@supabase/supabase-js';

let _service;
let _anon;

const SERVER_AUTH_OPTS = {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
    detectSessionInUrl: false,
  },
};

export function sbService() {
  if (_service) return _service;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('supabase service env missing');
  _service = createClient(url, key, SERVER_AUTH_OPTS);
  return _service;
}

export function sbAnon() {
  if (_anon) return _anon;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error('supabase anon env missing');
  _anon = createClient(url, key, SERVER_AUTH_OPTS);
  return _anon;
}
