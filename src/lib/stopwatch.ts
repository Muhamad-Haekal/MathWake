import AsyncStorage from '@react-native-async-storage/async-storage';

import type { KeyValueStorage } from './timer';

export type StopwatchStatus = 'idle' | 'running' | 'paused';

export interface StopwatchLap {
  elapsedMs: number;
  lapMs: number;
  recordedAtMs: number;
}

export interface StopwatchState {
  status: StopwatchStatus;
  accumulatedMs: number;
  startedAtMs: number | null;
  laps: StopwatchLap[];
}

export const STOPWATCH_STORAGE_KEY = 'mathwake:stopwatch-state';

function validTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export function createStopwatchState(): StopwatchState {
  return { status: 'idle', accumulatedMs: 0, startedAtMs: null, laps: [] };
}

export function getStopwatchElapsedMs(state: StopwatchState, nowMs: number): number {
  if (state.status !== 'running' || state.startedAtMs === null) return state.accumulatedMs;
  return state.accumulatedMs + Math.max(0, nowMs - state.startedAtMs);
}

export function startStopwatch(state: StopwatchState, nowMs: number): StopwatchState {
  if (state.status !== 'idle') return state;
  return { ...state, status: 'running', startedAtMs: nowMs };
}

export function pauseStopwatch(state: StopwatchState, nowMs: number): StopwatchState {
  if (state.status !== 'running' || state.startedAtMs === null) return state;
  return {
    ...state,
    status: 'paused',
    accumulatedMs: getStopwatchElapsedMs(state, nowMs),
    startedAtMs: null,
  };
}

export function resumeStopwatch(state: StopwatchState, nowMs: number): StopwatchState {
  if (state.status !== 'paused') return state;
  return { ...state, status: 'running', startedAtMs: nowMs };
}

export function resetStopwatch(): StopwatchState {
  return createStopwatchState();
}

export function recordStopwatchLap(state: StopwatchState, nowMs: number): StopwatchState {
  if (state.status === 'idle') return state;
  const elapsedMs = getStopwatchElapsedMs(state, nowMs);
  const previousElapsedMs = state.laps.at(-1)?.elapsedMs ?? 0;
  const lap: StopwatchLap = {
    elapsedMs,
    lapMs: Math.max(0, elapsedMs - previousElapsedMs),
    recordedAtMs: nowMs,
  };
  return { ...state, laps: [...state.laps, lap] };
}

function parseStopwatchState(value: unknown): StopwatchState | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Partial<StopwatchState>;
  const status = raw.status;
  if (status !== 'idle' && status !== 'running' && status !== 'paused') return null;
  if (!validTimestamp(raw.accumulatedMs)) return null;
  if (raw.startedAtMs !== null && !validTimestamp(raw.startedAtMs)) return null;
  if (status === 'running' && raw.startedAtMs === null) return null;
  if (status !== 'running' && raw.startedAtMs !== null) return null;
  if (!Array.isArray(raw.laps)) return null;
  const laps: StopwatchLap[] = [];
  for (const entry of raw.laps) {
    if (typeof entry !== 'object' || entry === null) return null;
    const lap = entry as Partial<StopwatchLap>;
    if (!validTimestamp(lap.elapsedMs) || !validTimestamp(lap.lapMs) || !validTimestamp(lap.recordedAtMs)) {
      return null;
    }
    if (lap.lapMs > lap.elapsedMs) return null;
    laps.push({ elapsedMs: lap.elapsedMs, lapMs: lap.lapMs, recordedAtMs: lap.recordedAtMs });
  }
  return {
    status,
    accumulatedMs: raw.accumulatedMs,
    startedAtMs: raw.startedAtMs ?? null,
    laps,
  };
}

export function restoreStopwatchState(value: unknown): StopwatchState | null {
  return parseStopwatchState(value);
}

export async function saveStopwatchState(
  state: StopwatchState,
  storage: KeyValueStorage = AsyncStorage,
): Promise<void> {
  await storage.setItem(STOPWATCH_STORAGE_KEY, JSON.stringify(state));
}

export async function loadStopwatchState(
  storage: KeyValueStorage = AsyncStorage,
): Promise<StopwatchState | null> {
  try {
    const raw = await storage.getItem(STOPWATCH_STORAGE_KEY);
    if (!raw) return null;
    return restoreStopwatchState(JSON.parse(raw));
  } catch {
    return null;
  }
}

export async function clearStopwatchState(storage: KeyValueStorage = AsyncStorage): Promise<void> {
  await storage.removeItem(STOPWATCH_STORAGE_KEY);
}
