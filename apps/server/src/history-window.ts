import type { Turn } from '@flint/core';

/**
 * How much of a conversation goes back to the model with each new message.
 *
 * The console is one conversation that has run since June. Before this, every
 * message re-sent all of it: 37 turns, mistakes Flint had already owned up to
 * included, so "how are you?" came back with a status report and a list of old
 * errors, and every frontier pass paid for the whole thread again. Only the
 * most recent complete turns are sent now; anything older reaches Flint the way
 * facts always have, through long-term memory recall (./knowledge), which the
 * memory extractor fills from the FULL stored history (getTurns, unwindowed).
 * Nothing is deleted: the window decides what is sent, not what is kept.
 */
export interface HistoryWindow {
  /** At most this many of the most recent complete turns. */
  maxTurns: number;
  /** And only turns started within this many milliseconds of now. */
  maxAgeMs: number;
}

export const DEFAULT_HISTORY_TURNS = 12;
export const DEFAULT_HISTORY_MAX_AGE_HOURS = 48;

const HOUR_MS = 60 * 60 * 1000;

/**
 * FLINT_HISTORY_TURNS (default 12) and FLINT_HISTORY_MAX_AGE_HOURS (default 48);
 * a turn has to pass both, so whichever is smaller wins. 0 is allowed and means
 * "no earlier turns". Anything that isn't a non-negative number falls back to the
 * default, with a line in the log saying so.
 */
export function readHistoryWindow(
  env: Record<string, string | undefined>,
  log: (msg: string) => void = () => {},
): HistoryWindow {
  const read = (key: string, fallback: number, integer: boolean): number => {
    const raw = env[key]?.trim();
    if (raw === undefined || raw === '') return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0 || (integer && !Number.isInteger(n))) {
      log(`[memory] ${key}=${JSON.stringify(raw)} is not a ${integer ? 'whole number' : 'number'} >= 0; using ${fallback}`);
      return fallback;
    }
    return n;
  };
  return {
    maxTurns: read('FLINT_HISTORY_TURNS', DEFAULT_HISTORY_TURNS, true),
    maxAgeMs: read('FLINT_HISTORY_MAX_AGE_HOURS', DEFAULT_HISTORY_MAX_AGE_HOURS, false) * HOUR_MS,
  };
}

/** "12 turns / 48h", for the boot log. */
export function describeHistoryWindow(w: HistoryWindow): string {
  return `last ${w.maxTurns} turn(s) within ${Math.round((w.maxAgeMs / HOUR_MS) * 100) / 100}h`;
}

/**
 * The complete turns that go to the model: in order, started no earlier than
 * `now - maxAgeMs`, and at most the last `maxTurns` of those. Pending and failed
 * turns never count (only complete turns are history, invariant #4).
 */
export function windowTurns(turns: readonly Turn[], window: HistoryWindow, now: number): Turn[] {
  if (window.maxTurns <= 0) return [];
  const since = now - window.maxAgeMs;
  const recent = turns.filter((t) => t.status === 'complete' && t.createdAt >= since);
  return recent.slice(-window.maxTurns);
}
