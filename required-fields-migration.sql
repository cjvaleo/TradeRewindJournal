-- ===================================================================
-- REWIND · REQUIRED FIELDS MIGRATION (Session 14)
-- Run this in Supabase SQL Editor (Project → SQL → New Query)
-- Safe to run multiple times — every statement is idempotent.
-- Version: 1.0 · May 18, 2026
-- ===================================================================
--
-- Adds the `reflection` column to public.trades.
--
-- Session 14 enforces 9 required fields on the Log Trade form and the
-- Calendar edit modal. One of them — "Reflection" — is a new post-trade
-- journaling free-text field, distinct from the existing chart-focused
-- "Notes" field (which lives inside the trade_data JSONB blob).
--
-- The reflection value is ALSO carried inside trade_data (the whole
-- trade object is persisted there, mirroring how account_type works).
-- This dedicated column exists purely so the value is directly
-- queryable / indexable at the SQL level.
--
-- ────────────────────────────────────────────────────────────────────
-- WHAT'S NOT IN THIS MIGRATION (and why)
-- ────────────────────────────────────────────────────────────────────
-- • Existing trades are NOT backfilled or re-validated. Rows saved
--   before this migration simply keep reflection = NULL. The required-
--   field gate only applies to NEW manual saves and modal edits.
-- • CSV-imported trades are intentionally allowed through with an empty
--   reflection (and any other missing fields); the SPA flags them with
--   a ⚠ "incomplete data" marker in the History table instead.
-- ===================================================================

-- -------------------------------------------------------------------
-- 1 · Add reflection column to public.trades
-- -------------------------------------------------------------------
-- Nullable on purpose — existing rows stay NULL until edited, and
-- CSV-imported rows are allowed to land with a NULL reflection.
ALTER TABLE public.trades
  ADD COLUMN IF NOT EXISTS reflection TEXT;

COMMENT ON COLUMN public.trades.reflection IS
  'Post-trade journaling free text. Required on new manual saves + modal edits (Session 14). NULL = unspecified (legacy rows + CSV imports). Also mirrored inside trade_data JSONB.';

-- ===================================================================
-- DONE. Verify with the query below.
-- ===================================================================
--
-- 1. Column exists with correct type + nullable
--    SELECT column_name, data_type, is_nullable, column_default
--    FROM information_schema.columns
--    WHERE table_schema = 'public'
--      AND table_name   = 'trades'
--      AND column_name  = 'reflection';
--
--    Expected: reflection | text | YES | NULL
--
-- ===================================================================
