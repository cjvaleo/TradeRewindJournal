-- ===================================================================
-- REWIND · CONFLUENCES MIGRATION (Phase 1)
-- Run this in Supabase SQL Editor (Project → SQL → New Query)
-- Safe to run multiple times — every statement is idempotent.
-- Version: 1.0 · May 13, 2026
-- ===================================================================
--
-- Creates two new tables for the Confluences feature:
--
--   confluences          per-user library of custom tag labels
--                        (FVG, CISD, Order Block, etc.) with soft-
--                        delete via archived_at.
--
--   trade_confluences    many-to-many join between trades and
--                        confluences, with optional timeframe per
--                        instance so users can stack the same tag at
--                        multiple TFs on one trade (1hr · FVG +
--                        5m · FVG).
--
-- Schema note: trade_confluences.trade_id is TEXT, not UUID, because
-- the existing public.trades.id is a TEXT column storing String(Date.now())
-- timestamps from the client. Path A from the build audit: keep the
-- normalized join table for SQL-driven Phase 2 analytics, but adapt
-- the type to the existing trades.id reality.
--
-- RLS: per-user via auth.uid() on both tables. trade_confluences uses
-- an EXISTS subquery against trades(user_id) so a user can only touch
-- confluence rows attached to trades they own.
-- ===================================================================

-- -------------------------------------------------------------------
-- 1 · CONFLUENCES library
-- -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.confluences (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_at  TIMESTAMPTZ,
  CONSTRAINT confluences_name_per_user_unique UNIQUE (user_id, name)
);

COMMENT ON TABLE public.confluences IS
  'Per-user library of custom confluence/tag labels. Soft-delete via archived_at — preserves attribution on historical trade_confluences rows.';

-- Hot path: load active library for the picker.
CREATE INDEX IF NOT EXISTS idx_confluences_user_active
  ON public.confluences (user_id)
  WHERE archived_at IS NULL;

-- -------------------------------------------------------------------
-- 2 · TRADE_CONFLUENCES (many-to-many)
-- -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.trade_confluences (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trade_id       TEXT NOT NULL REFERENCES public.trades(id) ON DELETE CASCADE,
  confluence_id  UUID NOT NULL REFERENCES public.confluences(id) ON DELETE CASCADE,
  timeframe      TEXT,
  position       INT  NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.trade_confluences IS
  'Many-to-many join between trades and confluences. timeframe is optional — same confluence can appear multiple times on one trade at different TFs. position preserves user-defined ordering.';

-- Prevent exact dupes (same trade + same confluence + same TF), but allow
-- the same confluence at multiple TFs on one trade. COALESCE handles the
-- NULL-timeframe case (NULL != NULL would let dupes through).
CREATE UNIQUE INDEX IF NOT EXISTS idx_trade_confluences_unique
  ON public.trade_confluences (trade_id, confluence_id, COALESCE(timeframe, ''));

-- Hot path: load all confluences for a trade (edit / detail view).
CREATE INDEX IF NOT EXISTS idx_trade_confluences_trade
  ON public.trade_confluences (trade_id);

-- Filter by tag (History page) + future analytics queries grouping by tag.
CREATE INDEX IF NOT EXISTS idx_trade_confluences_confluence
  ON public.trade_confluences (confluence_id);

-- Filter by timeframe (Phase 2 — "show me all 1hr · FVG trades").
CREATE INDEX IF NOT EXISTS idx_trade_confluences_timeframe
  ON public.trade_confluences (timeframe);

-- -------------------------------------------------------------------
-- 3 · RLS — per-user via auth.uid()
-- -------------------------------------------------------------------
ALTER TABLE public.confluences        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trade_confluences  ENABLE ROW LEVEL SECURITY;

-- DROP first for idempotency — CREATE POLICY IF NOT EXISTS isn't
-- universally supported across Postgres versions on Supabase.
DROP POLICY IF EXISTS confluences_owner_all       ON public.confluences;
DROP POLICY IF EXISTS trade_confluences_owner_all ON public.trade_confluences;

-- Confluences library: simple ownership check.
CREATE POLICY confluences_owner_all ON public.confluences
  FOR ALL
  USING      (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- Trade_confluences: derive ownership through the parent trade.
-- A user can only insert/select/update/delete trade_confluences rows
-- whose trade_id points to a trade they own.
CREATE POLICY trade_confluences_owner_all ON public.trade_confluences
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.trades
      WHERE trades.id = trade_confluences.trade_id
        AND trades.user_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.trades
      WHERE trades.id = trade_confluences.trade_id
        AND trades.user_id = auth.uid()
    )
  );

-- -------------------------------------------------------------------
-- 4 · GRANTS — explicit baseline
-- -------------------------------------------------------------------
-- authenticated role can read/write via RLS-protected policies above.
-- anon role is denied — no public confluence access.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.confluences        TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.trade_confluences  TO authenticated;
REVOKE ALL ON public.confluences        FROM anon;
REVOKE ALL ON public.trade_confluences  FROM anon;

-- ===================================================================
-- DONE. Verify with the queries below.
-- ===================================================================

-- 1. Both tables exist with expected columns
--    SELECT column_name, data_type, is_nullable, column_default
--    FROM information_schema.columns
--    WHERE table_schema = 'public'
--      AND table_name IN ('confluences','trade_confluences')
--    ORDER BY table_name, ordinal_position;
--
--    Expected:
--    confluences:        id(uuid,NN,gen_random_uuid)
--                        user_id(uuid,NN), name(text,NN),
--                        created_at(timestamptz,NN,now()),
--                        archived_at(timestamptz,nullable)
--    trade_confluences:  id(uuid,NN,gen_random_uuid),
--                        trade_id(text,NN), confluence_id(uuid,NN),
--                        timeframe(text,nullable), position(integer,NN,0),
--                        created_at(timestamptz,NN,now())
--
-- 2. Indexes
--    SELECT indexname FROM pg_indexes
--    WHERE schemaname='public' AND tablename IN ('confluences','trade_confluences')
--    ORDER BY tablename, indexname;
--
--    Expected:
--      confluences_pkey
--      confluences_name_per_user_unique
--      idx_confluences_user_active
--      trade_confluences_pkey
--      idx_trade_confluences_unique
--      idx_trade_confluences_trade
--      idx_trade_confluences_confluence
--      idx_trade_confluences_timeframe
--
-- 3. RLS enabled
--    SELECT relname, relrowsecurity FROM pg_class
--    WHERE relname IN ('confluences','trade_confluences');
--    Expected: relrowsecurity = t for both
--
-- 4. Policies present
--    SELECT tablename, policyname FROM pg_policies
--    WHERE schemaname='public' AND tablename IN ('confluences','trade_confluences');
--    Expected:
--      confluences        confluences_owner_all
--      trade_confluences  trade_confluences_owner_all
--
-- 5. Baseline counts
--    SELECT 'confluences' AS table, COUNT(*) FROM public.confluences
--    UNION ALL
--    SELECT 'trade_confluences', COUNT(*) FROM public.trade_confluences;
--    Expected: 0 rows in each on first run.
--
-- ===================================================================
