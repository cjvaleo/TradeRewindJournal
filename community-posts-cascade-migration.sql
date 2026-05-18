-- ===================================================================
-- REWIND · COMMUNITY FEED ORPHAN CLEANUP + CASCADE TRIGGER (Session 16)
-- Run in the Supabase SQL Editor (Project → SQL → New Query).
-- Version: 1.0 · May 18, 2026
-- ===================================================================
--
-- THE BUG
-- -------
-- Deleting a trade from public.trades left its auto-shared feed rows
-- behind in public.community_posts → "orphan" posts pointing at trades
-- that no longer exist.
--
-- WHY THERE'S NO FOREIGN KEY
-- --------------------------
-- community_posts has NO trade_id column. A trade post's link to its
-- trade is encoded in the PRIMARY KEY:
--
--     id = 'trade_' || <trades.id> || '_' || left(<community_id>, 8)
--
-- One row per community per trade. The id always has exactly two
-- separator underscores; <trades.id> itself never contains '_'
-- (it is Date.now() — an integer, or Date.now()+Math.random() — a
-- decimal). community_posts also stores non-trade rows that must NOT
-- be touched:
--   • check-in posts   id = 'checkin_' || <user_id> || '_' || <date>
--   • plain text posts (other id shapes)
--
-- Because there is no FK column, ON DELETE CASCADE cannot be attached.
-- Instead we use an AFTER DELETE trigger on public.trades that removes
-- the matching community_posts rows by the encoded-id pattern. This
-- catches EVERY delete path — the Rewind UI, admin tools, batch
-- scripts, future bulk-delete features — not just the app handler.
--
-- ▸ RUN THE SECTIONS IN ORDER. Review Section 1's output before
--   running Section 2's DELETE.
-- ===================================================================


-- -------------------------------------------------------------------
-- SECTION 1 · DETECT ORPHANS  (read-only — run first, review output)
-- -------------------------------------------------------------------
-- Lists every trade-post whose encoded trade id no longer exists in
-- public.trades. `id ~ '^trade_'` restricts to trade posts, so
-- check-in / plain-text posts are never considered.
-- The regexp pulls the trade id back out: everything between the
-- first '_' and the LAST '_' (greedy (.+) before '_[^_]+$').

SELECT
  cp.id,
  regexp_replace(cp.id, '^trade_(.+)_[^_]+$', '\1') AS encoded_trade_id,
  cp.community_id,
  cp.user_id,
  cp.content,
  cp.created_at
FROM public.community_posts cp
WHERE cp.id ~ '^trade_'
  AND NOT EXISTS (
    SELECT 1 FROM public.trades t
    WHERE t.id = regexp_replace(cp.id, '^trade_(.+)_[^_]+$', '\1')
  )
ORDER BY cp.created_at DESC;

-- Orphan count only:
-- SELECT count(*) AS orphan_posts
-- FROM public.community_posts cp
-- WHERE cp.id ~ '^trade_'
--   AND NOT EXISTS (
--     SELECT 1 FROM public.trades t
--     WHERE t.id = regexp_replace(cp.id, '^trade_(.+)_[^_]+$', '\1')
--   );


-- -------------------------------------------------------------------
-- SECTION 2 · CLEAN UP EXISTING ORPHANS  (destructive — run after review)
-- -------------------------------------------------------------------
-- Deletes exactly the rows Section 1 listed. Safe to re-run (a second
-- run simply matches nothing). Child rows in community_post_likes /
-- community_post_replies, if those tables FK community_posts.id with
-- ON DELETE CASCADE, are removed automatically; if not, see the note
-- at the bottom of this file.

DELETE FROM public.community_posts cp
WHERE cp.id ~ '^trade_'
  AND NOT EXISTS (
    SELECT 1 FROM public.trades t
    WHERE t.id = regexp_replace(cp.id, '^trade_(.+)_[^_]+$', '\1')
  );


-- -------------------------------------------------------------------
-- SECTION 3 · CASCADE TRIGGER  (the going-forward fix — idempotent)
-- -------------------------------------------------------------------
-- AFTER DELETE FOR EACH ROW on public.trades. For every deleted trade
-- it removes that trade's community_posts rows across all communities.
--
-- Pattern match: id LIKE 'trade\_' || OLD.id || '\_%' ESCAPE '\'
--   • The two '\_' are LITERAL underscores (the id separators).
--   • OLD.id contains only digits / '.', no LIKE metacharacters, so
--     it needs no escaping; '.' is a literal in LIKE.
--   • The trailing '%' spans the 8-char community-id suffix.
--
-- SECURITY DEFINER: the function runs as its owner so the cross-table
-- DELETE is never blocked by community_posts' row-level security —
-- this keeps the cascade working for admin/service-role/script
-- deletes, not just the post author. search_path is pinned for safety.

CREATE OR REPLACE FUNCTION public.cascade_delete_trade_community_posts()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $$
BEGIN
  DELETE FROM public.community_posts
  WHERE id LIKE ('trade\_' || OLD.id || '\_%') ESCAPE '\';
  RETURN OLD;  -- ignored by AFTER triggers; returned by convention
END;
$$;

DROP TRIGGER IF EXISTS trg_trades_cascade_community_posts ON public.trades;

CREATE TRIGGER trg_trades_cascade_community_posts
  AFTER DELETE ON public.trades
  FOR EACH ROW
  EXECUTE FUNCTION public.cascade_delete_trade_community_posts();


-- ===================================================================
-- VERIFY
-- ===================================================================
--
-- 1. Trigger installed
--    SELECT tgname, tgenabled, tgtype
--    FROM pg_trigger
--    WHERE tgrelid = 'public.trades'::regclass
--      AND tgname  = 'trg_trades_cascade_community_posts';
--
-- 2. Function present + SECURITY DEFINER
--    SELECT proname, prosecdef
--    FROM pg_proc
--    WHERE proname = 'cascade_delete_trade_community_posts';
--    Expected: prosecdef = true
--
-- 3. Live test (do this in the Rewind UI, then re-run Section 1):
--    - Note a trade that has a community post.
--    - Delete that trade from History (or the Calendar edit modal).
--    - Re-run Section 1 → 0 orphans for that trade id.
--    - The post should also vanish from the Community feed on refresh.
--
-- 4. Zero orphans remain
--    (re-run the Section 1 count query — expect 0)
--
-- ===================================================================
-- NOTE · community_post_likes / community_post_replies
-- ===================================================================
-- If those child tables reference community_posts(id) WITHOUT
-- ON DELETE CASCADE, deleting a post here can fail or strand child
-- rows. Check, and if needed add cascades (separate, optional):
--
--   ALTER TABLE public.community_post_likes
--     DROP CONSTRAINT IF EXISTS community_post_likes_post_id_fkey,
--     ADD  CONSTRAINT community_post_likes_post_id_fkey
--       FOREIGN KEY (post_id) REFERENCES public.community_posts(id)
--       ON DELETE CASCADE;
--   -- (and likewise for community_post_replies)
--
-- The Rewind app already deletes likes/replies alongside posts in its
-- own handlers, so this is a belt-and-suspenders hardening, not a
-- blocker for the orphan fix above.
-- ===================================================================
