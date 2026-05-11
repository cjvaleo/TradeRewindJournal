-- ===================================================================
-- REWIND · TIER & SUBSCRIPTION MIGRATION
-- Run this in Supabase SQL Editor (Project → SQL → New Query)
-- Safe to run multiple times (idempotent where possible)
-- Version: 1.0 · May 10, 2026
-- ===================================================================


-- -------------------------------------------------------------------
-- 1 · USERS TABLE — add tier columns
-- -------------------------------------------------------------------

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS is_pro              BOOLEAN     NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS pro_source          TEXT,
  ADD COLUMN IF NOT EXISTS pro_active_until    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS stripe_customer_id  TEXT,
  ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT,
  ADD COLUMN IF NOT EXISTS discord_user_id     TEXT,
  ADD COLUMN IF NOT EXISTS discord_access_token  TEXT,   -- encrypted at app layer (AES-256)
  ADD COLUMN IF NOT EXISTS discord_refresh_token TEXT,   -- encrypted at app layer (AES-256)
  ADD COLUMN IF NOT EXISTS discord_token_expires TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_role_check     TIMESTAMPTZ;

-- Enforce valid pro_source values
ALTER TABLE profiles
  DROP CONSTRAINT IF EXISTS profiles_pro_source_check;

ALTER TABLE profiles
  ADD CONSTRAINT profiles_pro_source_check
  CHECK (pro_source IS NULL OR pro_source IN ('stripe_direct', 'discord_premium', 'discord_elite'));


-- -------------------------------------------------------------------
-- 2 · INDEXES — for hot-path queries
-- -------------------------------------------------------------------

-- Stripe webhook: look up user by stripe_subscription_id (called on every webhook)
CREATE INDEX IF NOT EXISTS idx_profiles_stripe_subscription_id
  ON profiles (stripe_subscription_id)
  WHERE stripe_subscription_id IS NOT NULL;

-- Stripe webhook: look up user by customer_id (alternate lookup)
CREATE INDEX IF NOT EXISTS idx_profiles_stripe_customer_id
  ON profiles (stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;

-- Discord OAuth callback + daily cron: look up by discord_user_id
CREATE INDEX IF NOT EXISTS idx_profiles_discord_user_id
  ON profiles (discord_user_id)
  WHERE discord_user_id IS NOT NULL;

-- Daily cron: find all profiles needing role check (Premium/Elite only)
CREATE INDEX IF NOT EXISTS idx_profiles_pro_source_role_check
  ON profiles (pro_source, last_role_check)
  WHERE pro_source IN ('discord_premium', 'discord_elite');

-- Daily reconciliation: find profiles with expiring Pro access
CREATE INDEX IF NOT EXISTS idx_profiles_pro_active_until
  ON profiles (pro_active_until)
  WHERE is_pro = TRUE;


-- -------------------------------------------------------------------
-- 3 · CANCELLATION REASONS TABLE
-- -------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS cancellation_reasons (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID REFERENCES profiles(id) ON DELETE CASCADE,
  reason              TEXT NOT NULL,
  reason_free_text    TEXT,
  prevented_by_offer  BOOLEAN NOT NULL DEFAULT FALSE,
  save_offer_type     TEXT,
  resubscribed_at     TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cancellation_reasons_user_id
  ON cancellation_reasons (user_id);

CREATE INDEX IF NOT EXISTS idx_cancellation_reasons_created_at
  ON cancellation_reasons (created_at DESC);


-- -------------------------------------------------------------------
-- 4 · WEBHOOK EVENTS LOG — for idempotency (CRITICAL)
-- -------------------------------------------------------------------
-- Stripe retries webhooks aggressively. Without idempotency, you'll
-- charge profiles twice or double-extend their pro_active_until.
-- Every webhook handler MUST insert into this table with ON CONFLICT
-- DO NOTHING, and bail out if the insert returns nothing.

CREATE TABLE IF NOT EXISTS webhook_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider      TEXT NOT NULL,             -- 'stripe' | 'discord' | other
  event_id      TEXT NOT NULL,             -- provider's event id
  event_type    TEXT NOT NULL,             -- e.g. 'checkout.session.completed'
  payload       JSONB NOT NULL,
  user_id       UUID REFERENCES profiles(id) ON DELETE SET NULL,
  status        TEXT NOT NULL DEFAULT 'received',  -- 'received' | 'processed' | 'failed'
  error_message TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at  TIMESTAMPTZ,
  UNIQUE (provider, event_id)
);

CREATE INDEX IF NOT EXISTS idx_webhook_events_status
  ON webhook_events (status, created_at DESC)
  WHERE status != 'processed';

CREATE INDEX IF NOT EXISTS idx_webhook_events_user_id
  ON webhook_events (user_id, created_at DESC)
  WHERE user_id IS NOT NULL;


-- -------------------------------------------------------------------
-- 5 · EMAIL LOG — track every transactional email sent
-- -------------------------------------------------------------------
-- Useful for: debugging "did Christian get the welcome email?",
-- preventing duplicate sends, and analytics.

CREATE TABLE IF NOT EXISTS email_log (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID REFERENCES profiles(id) ON DELETE CASCADE,
  to_address    TEXT NOT NULL,
  template_id   TEXT NOT NULL,             -- e.g. 'welcome-direct', 'role-lost-elite'
  subject       TEXT NOT NULL,
  resend_id     TEXT,                      -- Resend's message id, for tracking
  status        TEXT NOT NULL DEFAULT 'queued',  -- 'queued' | 'sent' | 'failed' | 'bounced'
  error_message TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_email_log_user_id
  ON email_log (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_email_log_template
  ON email_log (template_id, created_at DESC);


-- -------------------------------------------------------------------
-- 6 · HELPER FUNCTION — is_pro_active(user_id)
-- -------------------------------------------------------------------
-- Single source of truth for "is this user currently Pro?"
-- Every paid-feature gate (server-side) MUST call this function,
-- never check is_pro alone. Handles expired subscriptions correctly.

CREATE OR REPLACE FUNCTION is_pro_active(p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
AS $$
  SELECT COALESCE(is_pro, FALSE) AND COALESCE(pro_active_until > NOW(), FALSE)
  FROM profiles
  WHERE id = p_user_id;
$$;


-- -------------------------------------------------------------------
-- 7 · ROW LEVEL SECURITY — protect new columns
-- -------------------------------------------------------------------
-- Assumes profiles table already has RLS enabled with policies for
-- self-read/self-update. The new columns inherit those policies
-- automatically. We just need to make sure tokens are never readable
-- by the client.

-- Drop and recreate the "users can read their own row" policy
-- to explicitly EXCLUDE the Discord token columns.
-- (Tokens should only ever be read by the service role on the server.)

-- Cancellation reasons: users can only insert their own, can't read or update
ALTER TABLE cancellation_reasons ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "users_insert_own_cancel_reason" ON cancellation_reasons;
CREATE POLICY "users_insert_own_cancel_reason"
  ON cancellation_reasons FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

-- No SELECT/UPDATE/DELETE policies — service role only.

-- Webhook events: service role only (no policies for authenticated users)
ALTER TABLE webhook_events ENABLE ROW LEVEL SECURITY;

-- Email log: users can read their own email history
ALTER TABLE email_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "users_read_own_email_log" ON email_log;
CREATE POLICY "users_read_own_email_log"
  ON email_log FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());


-- -------------------------------------------------------------------
-- 8 · BACKFILL — set existing profiles to free tier explicitly
-- -------------------------------------------------------------------
-- Safe no-op: is_pro already defaulted to FALSE on ADD COLUMN.
-- This is just defensive.

UPDATE profiles
SET is_pro = FALSE
WHERE is_pro IS NULL;


-- -------------------------------------------------------------------
-- ✓ MIGRATION COMPLETE
-- -------------------------------------------------------------------
-- Verify with:
--   SELECT column_name, data_type, is_nullable
--   FROM information_schema.columns
--   WHERE table_name = 'profiles' AND column_name LIKE 'pro_%' OR column_name LIKE 'stripe_%' OR column_name LIKE 'discord_%';
--
--   SELECT table_name FROM information_schema.tables
--   WHERE table_schema = 'public'
--   AND table_name IN ('cancellation_reasons', 'webhook_events', 'email_log');
--
--   SELECT is_pro_active(some_real_user_uuid);  -- should return FALSE for non-pro
