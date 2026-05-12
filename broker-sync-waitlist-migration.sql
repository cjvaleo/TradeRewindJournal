-- ===================================================================
-- REWIND · BROKER SYNC WAITLIST MIGRATION
-- Run this in Supabase SQL Editor (Project → SQL → New Query)
-- Safe to run multiple times (idempotent — CREATE IF NOT EXISTS)
-- Version: 1.0 · May 11, 2026
-- ===================================================================
--
-- Captures emails from users who clicked "Join the waitlist" on the
-- Broker Sync page. Used to gauge demand + notify when the feature
-- ships. Write path goes through /api/broker-sync-waitlist using
-- the service role; RLS is enabled with no public policies so the
-- table is admin-only from PostgREST's perspective.
-- ===================================================================

-- -------------------------------------------------------------------
-- 1 · TABLE
-- -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.broker_sync_waitlist (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  email       TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT  broker_sync_waitlist_email_unique UNIQUE (email)
);

COMMENT ON TABLE public.broker_sync_waitlist IS
  'Email waitlist for the Broker Sync feature. Written via /api/broker-sync-waitlist (service role). RLS-locked from clients.';

-- -------------------------------------------------------------------
-- 2 · INDEXES
-- -------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS broker_sync_waitlist_user_id_idx
  ON public.broker_sync_waitlist (user_id);

CREATE INDEX IF NOT EXISTS broker_sync_waitlist_created_at_idx
  ON public.broker_sync_waitlist (created_at DESC);

-- -------------------------------------------------------------------
-- 3 · RLS — admin-only (service role bypasses RLS automatically)
-- -------------------------------------------------------------------
ALTER TABLE public.broker_sync_waitlist ENABLE ROW LEVEL SECURITY;

-- No SELECT/INSERT/UPDATE/DELETE policies for anon or authenticated
-- roles — the only legitimate writer is the API route running with
-- SUPABASE_SERVICE_ROLE_KEY, which bypasses RLS by design.

-- -------------------------------------------------------------------
-- 4 · GRANTS — explicit deny for non-service roles
-- -------------------------------------------------------------------
-- (Defaults already deny, but stated explicitly for audit clarity.)
REVOKE ALL ON public.broker_sync_waitlist FROM anon, authenticated;

-- ===================================================================
-- DONE. Verify with:
--   SELECT COUNT(*) FROM public.broker_sync_waitlist;
-- ===================================================================
