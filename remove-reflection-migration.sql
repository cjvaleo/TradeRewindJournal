-- ===================================================================
-- REWIND · REMOVE REFLECTION COLUMN (Session 18, Part A)
-- Run in the Supabase SQL Editor (Project → SQL → New Query).
-- Version: 1.0 · May 18, 2026
-- ===================================================================
--
-- Reverses required-fields-migration.sql. The standalone "Reflection"
-- free-text field added in Session 14 has been removed from the UI —
-- users journal in "Notes" instead. This drops the now-unused column.
--
-- Safe: the column carries no data the app still reads. Any reflection
-- text also lived inside the trade_data JSONB blob; that key is simply
-- ignored going forward (harmless, no migration needed for it).
--
-- IF NOT EXISTS guard makes this idempotent / safe if already dropped.
-- ===================================================================

ALTER TABLE public.trades
  DROP COLUMN IF EXISTS reflection;

-- ===================================================================
-- VERIFY
-- ===================================================================
-- SELECT column_name
-- FROM information_schema.columns
-- WHERE table_schema = 'public' AND table_name = 'trades'
--   AND column_name = 'reflection';
-- Expected: 0 rows.
-- ===================================================================
