-- Add optional user-facing alarm names without changing existing rows or RLS.
-- Existing alarms receive the compatible fallback title "Alarm".
ALTER TABLE public.alarms
  ADD COLUMN IF NOT EXISTS title text NOT NULL DEFAULT 'Alarm';
