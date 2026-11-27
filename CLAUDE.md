# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

See `AGENTS.md` for Expo rules (versioned docs, `npx expo install`, CNG, graphify usage). They apply here too.

## Commands

npm project (`package-lock.json`), Expo SDK 57.

```bash
npx expo start            # dev server (needs dev client for native alarm module)
npm run android           # expo run:android — local dev build
npx expo lint             # lint
npx tsc --noEmit          # typecheck
graphify update .         # refresh knowledge graph after code changes
```

No test framework; regression tests are standalone Node scripts in `scripts/test-*.mjs` that import pure logic from `src/lib/` via Node's type stripping (Node 22.18+). Run one with `node scripts/test-alarm-logic.mjs`. Keep logic tested this way free of runtime native/RN imports (`import type` only). Run lint + typecheck (and relevant test scripts) before calling work done.

## What the app is

MathWake: an alarm clock where dismissing an alarm requires solving math questions. Backend is Supabase: auth plus tables `alarms`, `alarm_logs`, `attempts`, `profiles`, `questions` (SQL migrations in `supabase/migrations/`).

## Architecture

- **Routing** (`src/app/`): root `_layout.tsx` owns auth gating, splash, OAuth callback handling, and all alarm entry wiring (notification taps, native alarm launches, resuming the alarm editor draft). `(app)/` is the tabbed area (home, alarms, timer, stopwatch); `challenge.tsx` is the math-solving dismiss screen; `alarm-reminder.tsx`, `onboarding.tsx`, `profile.tsx`, `password-recovery.tsx`, and `auth/` sit at top level.
- **Logic lives in `src/lib/`**, screens stay thin. Many features split into a pure `*-logic.ts`/state file plus an I/O file (e.g. `alarm-editor-draft-logic.ts` vs `alarm-editor-draft.ts`, `challenge-state.ts`, `auth-callback-logic.ts`).
- **Two alarm backends**:
  - `src/lib/alarm-native.ts` / `timer-native.ts` → local Expo module `modules/mathwake-alarm` (Kotlin: `AlarmManager.setAlarmClock`, full-screen intent, `AlarmRingerService` ringing, plus snooze/ringer-ownership coordinators and event/pending ledgers; registered in `app.json` via `app.plugin.js`). Android dev builds only; the iOS Swift module is a stub returning `available: false`. Editing this module is expected — it is source, not generated.
  - Stopwatch (`stopwatch.ts`) is pure JS + AsyncStorage; Timer uses `timer.ts` with an optional native exact path in `timer-native.ts`.
  - `src/lib/scheduling.ts` → `expo-notifications` fallback for Expo Go, web, iOS, or when the native module reports unavailable.
  - **Never statically import native module code** — `alarm-native.ts` uses type-only imports and dynamic `import()` behind a capability check so the app stays Expo Go/web safe. Keep this pattern.
- **Auth**: `src/contexts/auth-context.tsx` (`AuthProvider`/`useAuth`) over the Supabase client in `src/lib/supabase.ts`; Google OAuth in `src/lib/auth-oauth.ts`.
- **Path aliases** (`tsconfig.json`): `@/*` → `src/*`, `@/assets/*` → `assets/*`.
- `android/` exists but is generated (CNG) — change native behavior via `app.json` or the module's config plugin, not by hand.
