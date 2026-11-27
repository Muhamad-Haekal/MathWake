// Time-of-day greeting (pure, no platform imports; tested by scripts/test-greeting.mjs).
//
// Windows, local device time, inclusive start / exclusive end:
//   05:00–10:59 pagi · 11:00–14:59 siang · 15:00–17:59 sore · 18:00–04:59 malam

export type DayPart = 'pagi' | 'siang' | 'sore' | 'malam';

export function dayPartForHour(hour: number): DayPart {
  const h = ((Math.floor(hour) % 24) + 24) % 24;
  if (h >= 5 && h < 11) return 'pagi';
  if (h >= 11 && h < 15) return 'siang';
  if (h >= 15 && h < 18) return 'sore';
  return 'malam';
}

export function greetingForDate(at: Date): string {
  return `Selamat ${dayPartForHour(at.getHours())}!`;
}

/**
 * Greeting for a completed challenge, keyed to the occurrence's trigger time
 * (when the alarm actually rang), not the moment the user finished solving.
 * Falls back to `fallback` only when the trigger time is missing/invalid.
 */
export function greetingForOccurrence(triggerAtMs: number, fallback: Date): string {
  return greetingForDate(Number.isFinite(triggerAtMs) && triggerAtMs > 0 ? new Date(triggerAtMs) : fallback);
}
