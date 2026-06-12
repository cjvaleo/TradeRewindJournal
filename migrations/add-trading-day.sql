-- Migration: add trading_day column to trades
-- Run in Supabase SQL editor AFTER reviewing
-- 1. Add column
ALTER TABLE public.trades ADD COLUMN IF NOT EXISTS trading_day date;

-- 2. Create index
CREATE INDEX IF NOT EXISTS idx_trades_trading_day ON public.trades(user_id, trading_day);

-- 3. Backfill: use the same trading-day logic (ET cutover)
-- For rows where created_at is between 17:00-17:59 ET, attribute to next day
UPDATE public.trades
SET trading_day = CASE
  WHEN EXTRACT(DOW FROM (created_at AT TIME ZONE 'America/New_York')) = 6 THEN NULL  -- Saturday
  WHEN EXTRACT(DOW FROM (created_at AT TIME ZONE 'America/New_York')) = 0
    AND EXTRACT(HOUR FROM (created_at AT TIME ZONE 'America/New_York')) < 18 THEN NULL  -- Sunday before 6pm
  WHEN EXTRACT(HOUR FROM (created_at AT TIME ZONE 'America/New_York')) >= 18
    THEN (created_at AT TIME ZONE 'America/New_York' + INTERVAL '1 day')::date
  WHEN EXTRACT(HOUR FROM (created_at AT TIME ZONE 'America/New_York')) = 17
    THEN (created_at AT TIME ZONE 'America/New_York' + INTERVAL '1 day')::date
  ELSE (created_at AT TIME ZONE 'America/New_York')::date
END
WHERE trading_day IS NULL;

-- 4. Verification query (run separately, expect 0 for 6pm ET trades on wrong day)
-- SELECT id, created_at AT TIME ZONE 'America/New_York' as et_time, trading_day FROM trades
-- WHERE EXTRACT(HOUR FROM (created_at AT TIME ZONE 'America/New_York')) >= 18
-- AND trading_day = (created_at AT TIME ZONE 'America/New_York')::date LIMIT 10;
