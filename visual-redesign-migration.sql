-- ===================================================================
-- REWIND · VISUAL REDESIGN MIGRATION (Chunk 1)
-- Run this in Supabase SQL Editor (Project → SQL → New Query)
-- Safe to run multiple times — every statement is idempotent.
-- Version: 1.0 · May 13, 2026
-- ===================================================================
--
-- Adds the account_type column to public.trades so each logged trade
-- can be tagged as one of:
--
--   'paper'   demo / sim
--   'eval'    prop-firm evaluation
--   'funded'  funded prop account
--   'live'    personal live capital
--   NULL      not specified (default for existing rows + new trades
--             where the user skips the field)
--
-- This single field drives the ● Eval / ● Funded / ● Paper / ● Live
-- dot+label that renders in:
--   - Sidebar trade cards (already designed)
--   - Community feed posts (Chunk 7 — amendment)
--   - History row hover, Trade detail header
--
-- ────────────────────────────────────────────────────────────────────
-- WHAT'S NOT IN THIS MIGRATION (and why)
-- ────────────────────────────────────────────────────────────────────
-- • tradingview_link — Lives at trade_data.tradingview_link (JSONB key
--   inside the existing trade_data column). No schema migration needed;
--   the Log Trade redesign just adds the input field and pushes the
--   value into the JSON blob alongside other trade fields.
-- • R-multiple chip — Computed at render time from existing entry /
--   stop / size columns. Pure UI, no schema impact.
-- • Confluences — Already migrated via confluences-migration.sql in
--   the Confluences Phase 1 work. No overlap with this redesign.
-- ===================================================================

-- -------------------------------------------------------------------
-- 1 · Add account_type column to public.trades
-- -------------------------------------------------------------------
-- Nullable on purpose — every existing row stays NULL until the user
-- backfills via Edit Modal. The Log Trade UI treats NULL as "skipped"
-- and the display layer simply omits the dot+label when value is NULL.
ALTER TABLE public.trades
  ADD COLUMN IF NOT EXISTS account_type TEXT;

-- -------------------------------------------------------------------
-- 2 · Enforce enum via CHECK constraint
-- -------------------------------------------------------------------
-- Done as a separate, named, idempotent step so a rerun doesn't fail
-- on "constraint already exists". Drop-then-add keeps semantics stable
-- if the allowed set ever shifts.
ALTER TABLE public.trades
  DROP CONSTRAINT IF EXISTS trades_account_type_check;

ALTER TABLE public.trades
  ADD CONSTRAINT trades_account_type_check
  CHECK (
    account_type IS NULL
    OR account_type IN ('paper', 'eval', 'funded', 'live')
  );

COMMENT ON COLUMN public.trades.account_type IS
  'Optional account-context tag: paper | eval | funded | live. NULL = unspecified. Drives the dot+label indicator in trade cards, feed posts, and history rows.';

-- -------------------------------------------------------------------
-- 3 · Partial index for filterable queries
-- -------------------------------------------------------------------
-- Hot path: "show me all my funded trades" or "filter history by Eval".
-- Partial index (WHERE account_type IS NOT NULL) keeps the index lean
-- since most rows will be NULL until users start tagging.
CREATE INDEX IF NOT EXISTS idx_trades_account_type
  ON public.trades (user_id, account_type)
  WHERE account_type IS NOT NULL;

-- ===================================================================
-- DONE. Verify with the queries below.
-- ===================================================================

-- 1. Column exists with correct type + nullable
--    SELECT column_name, data_type, is_nullable, column_default
--    FROM information_schema.columns
--    WHERE table_schema = 'public'
--      AND table_name   = 'trades'
--      AND column_name  = 'account_type';
--
--    Expected: account_type | text | YES | NULL
--
-- 2. CHECK constraint installed
--    SELECT conname, pg_get_constraintdef(oid) AS definition
--    FROM pg_constraint
--    WHERE conrelid = 'public.trades'::regclass
--      AND conname  = 'trades_account_type_check';
--
--    Expected: trades_account_type_check |
--      CHECK ((account_type IS NULL) OR (account_type = ANY (ARRAY['paper'::text, 'eval'::text, 'funded'::text, 'live'::text])))
--
-- 3. Partial index present
--    SELECT indexname, indexdef
--    FROM pg_indexes
--    WHERE schemaname='public'
--      AND tablename ='trades'
--      AND indexname ='idx_trades_account_type';
--
--    Expected: definition includes "WHERE (account_type IS NOT NULL)"
--
-- 4. Constraint actually rejects bad values (should ERROR)
--    -- This will fail with a check-constraint violation — that's the goal.
--    -- UPDATE public.trades
--    --   SET account_type = 'garbage'
--    --   WHERE id = (SELECT id FROM public.trades LIMIT 1);
--
-- 5. Backfill baseline — should be 0 tagged rows on first run
--    SELECT account_type, COUNT(*)
--    FROM public.trades
--    GROUP BY account_type
--    ORDER BY account_type NULLS FIRST;
--
--    Expected: one row with account_type=NULL and your total trade count.
--
-- ===================================================================
