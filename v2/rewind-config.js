/* ============================================================================
   REWIND — CONFIG
   Load this BEFORE the page module. Leave blank to run on demo data.

   Both values are safe to expose in the browser — the anon key is public by
   design and row access is controlled by Supabase RLS. Make sure your RLS
   policy on the trades table is `user_id = auth.uid()`.
   ========================================================================== */
window.__REWIND_SUPABASE_URL      =https://efxjxmtjycldvovcbczg.supabase.co/rest/v1/
window.__REWIND_SUPABASE_ANON_KEY =eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVmeGp4bXRqeWNsZHZvdmNiY3pnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYyMTE4MTEsImV4cCI6MjA5MTc4NzgxMX0.82aeJ6UtcHxkifdjhLsaAXwHeAjyzI2iQ4KakHy3zik
