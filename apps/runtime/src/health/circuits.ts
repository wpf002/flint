/**
 * Per-source circuits (Machine plan P2): a source that fails 5 times in a row
 * is open. While open it is skipped, except one try once 6 cadences have
 * passed since its last (half-open). Opening raises one event, keyed by the
 * streak (the last good run before it), and the first success after raises
 * one recovery event: one of each per streak, however long it lasts.
 */
import type { Raised } from './watchdog.js';

export const CIRCUIT_FAILURES = 5;
export const HALF_OPEN_CADENCES = 6;

export interface CursorState {
  consecutiveFailures: number;
  lastOkAt: Date | null;
  /** The cursor is written on every run: its last try. */
  updatedAt: Date;
}

export function circuitAllows(c: CursorState | null | undefined, cadenceMs: number, now: Date): boolean {
  if (!c || c.consecutiveFailures < CIRCUIT_FAILURES) return true;
  return now.getTime() - c.updatedAt.getTime() >= HALF_OPEN_CADENCES * cadenceMs;
}

/** The events a run's before and after mean: the circuit opening, or closing. */
export function circuitEvents(source: string, before: CursorState | null | undefined, after: CursorState | null | undefined, now: Date): Raised[] {
  if (!before || !after) return [];
  const streak = `${source}:${(before.lastOkAt ?? new Date(0)).toISOString()}`;
  if (before.consecutiveFailures < CIRCUIT_FAILURES && after.consecutiveFailures >= CIRCUIT_FAILURES) {
    return [{ type: 'source.circuit_open', ref: streak, occurredAt: now, payload: { source, failures: after.consecutiveFailures } }];
  }
  if (before.consecutiveFailures >= CIRCUIT_FAILURES && after.consecutiveFailures === 0) {
    return [{ type: 'source.circuit_closed', ref: streak, occurredAt: now, payload: { source } }];
  }
  return [];
}
