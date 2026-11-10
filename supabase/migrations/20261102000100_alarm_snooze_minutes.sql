-- Per-alarm Snooze interval. Existing rows receive the 10-minute default.
ALTER TABLE public.alarms
  ADD COLUMN IF NOT EXISTS snooze_minutes SMALLINT NOT NULL DEFAULT 10;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'alarms_snooze_minutes_check'
      AND conrelid = 'public.alarms'::regclass
  ) THEN
    ALTER TABLE public.alarms
      ADD CONSTRAINT alarms_snooze_minutes_check
      CHECK (snooze_minutes IN (5, 10, 15, 20, 30));
  END IF;
END;
$$;
