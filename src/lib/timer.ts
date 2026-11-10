import AsyncStorage from '@react-native-async-storage/async-storage';

export type TimerStatus = 'idle' | 'running' | 'paused' | 'finished';

export interface TimerState {
  status: TimerStatus;
  durationMs: number;
  remainingMs: number;
  deadlineMs: number | null;
  finishedAtMs: number | null;
}

export interface KeyValueStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export const TIMER_STORAGE_KEY = 'mathwake:timer-state';

function validTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function validDuration(value: unknown): value is number {
  return validTimestamp(value) && Number.isInteger(value) && value > 0;
}

function clampRemaining(value: number, durationMs: number): number {
  return Math.min(durationMs, Math.max(0, Math.floor(value)));
}

export function createTimerState(durationMs: number): TimerState {
  if (!validDuration(durationMs)) throw new Error('Timer duration must be a positive integer');
  return {
    status: 'idle',
    durationMs,
    remainingMs: durationMs,
    deadlineMs: null,
    finishedAtMs: null,
  };
}

export function getTimerRemainingMs(state: TimerState, nowMs: number): number {
  if (state.status !== 'running' || state.deadlineMs === null) return state.remainingMs;
  return clampRemaining(state.deadlineMs - nowMs, state.durationMs);
}

/** Converts an expired running timer to finished. Repeating this is idempotent. */
export function settleTimer(state: TimerState, nowMs: number): TimerState {
  if (state.status !== 'running' || state.deadlineMs === null || state.deadlineMs > nowMs) {
    return state;
  }
  return {
    ...state,
    status: 'finished',
    remainingMs: 0,
    deadlineMs: null,
    finishedAtMs: state.finishedAtMs ?? state.deadlineMs,
  };
}

export function startTimer(state: TimerState, nowMs: number): TimerState {
  if (state.status !== 'idle') return state;
  return {
    ...state,
    status: 'running',
    deadlineMs: nowMs + state.remainingMs,
    finishedAtMs: null,
  };
}

export function pauseTimer(state: TimerState, nowMs: number): TimerState {
  if (state.status !== 'running') return state;
  const remainingMs = getTimerRemainingMs(state, nowMs);
  if (remainingMs <= 0) return settleTimer(state, nowMs);
  return { ...state, status: 'paused', remainingMs, deadlineMs: null };
}

export function resumeTimer(state: TimerState, nowMs: number): TimerState {
  if (state.status !== 'paused' || state.remainingMs <= 0) {
    return state.remainingMs <= 0 && state.status === 'paused'
      ? { ...state, status: 'finished', deadlineMs: null, finishedAtMs: state.finishedAtMs ?? nowMs }
      : state;
  }
  return {
    ...state,
    status: 'running',
    deadlineMs: nowMs + state.remainingMs,
    finishedAtMs: null,
  };
}

export function resetTimer(state: TimerState, durationMs = state.durationMs): TimerState {
  return createTimerState(durationMs);
}

function parseTimerState(value: unknown): TimerState | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Partial<TimerState>;
  const status = raw.status;
  if (status !== 'idle' && status !== 'running' && status !== 'paused' && status !== 'finished') return null;
  if (!validDuration(raw.durationMs) || !validTimestamp(raw.remainingMs)) return null;
  if (raw.remainingMs > raw.durationMs) return null;
  if (raw.deadlineMs !== null && !validTimestamp(raw.deadlineMs)) return null;
  if (raw.finishedAtMs !== null && !validTimestamp(raw.finishedAtMs)) return null;
  if (status === 'running' && raw.deadlineMs === null) return null;
  if (status !== 'running' && raw.deadlineMs !== null) return null;
  return {
    status,
    durationMs: raw.durationMs,
    remainingMs: clampRemaining(raw.remainingMs, raw.durationMs),
    deadlineMs: raw.deadlineMs ?? null,
    finishedAtMs: raw.finishedAtMs ?? null,
  };
}

export function restoreTimerState(value: unknown, nowMs: number): TimerState | null {
  const state = parseTimerState(value);
  if (!state) return null;
  if (state.status !== 'running' || state.deadlineMs === null) return state;
  if (state.deadlineMs <= nowMs) return settleTimer(state, nowMs);
  return { ...state, remainingMs: getTimerRemainingMs(state, nowMs) };
}

export async function saveTimerState(
  state: TimerState,
  storage: KeyValueStorage = AsyncStorage,
): Promise<void> {
  await storage.setItem(TIMER_STORAGE_KEY, JSON.stringify(state));
}

export async function loadTimerState(
  storage: KeyValueStorage = AsyncStorage,
  nowMs = Date.now(),
): Promise<TimerState | null> {
  try {
    const raw = await storage.getItem(TIMER_STORAGE_KEY);
    if (!raw) return null;
    return restoreTimerState(JSON.parse(raw), nowMs);
  } catch {
    return null;
  }
}

export async function clearTimerState(storage: KeyValueStorage = AsyncStorage): Promise<void> {
  await storage.removeItem(TIMER_STORAGE_KEY);
}
