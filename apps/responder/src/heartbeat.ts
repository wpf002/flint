import type { Participant } from './participant.js';

/*
 * Telling Nexus that something is driving it.
 *
 * Whether the loop is alive was previously unanswerable from the console: activity was
 * inferred from recent tool calls, so a process that died overnight and a quiet Tuesday
 * looked identical — and the one that needed you looked exactly like the one that did
 * not.
 *
 * The heartbeat carries what the loop knows and the console cannot: how much of the
 * day's budget is gone, and when the last standup was. That last field lives here rather
 * than on disk because it has to survive a restart and a machine change, and Nexus is
 * already the thing that remembers across both.
 */

export interface Heartbeat {
  turnsToday: number;
  turnCap: number;
  tokensToday: number;
  tokenCap: number;
}

export interface RunnerState {
  /** UTC date of the last standup opened, from whichever runner opened it. */
  lastStandupDay: string | null;
}

/**
 * Reports a round and reads back what Nexus remembers.
 *
 * Best effort: a heartbeat that fails is a console that looks stale for a minute, and
 * failing the round over it would turn a cosmetic problem into a real one.
 */
export async function beat(
  participant: Participant,
  name: string,
  state: Heartbeat,
  standupDay?: string,
): Promise<RunnerState | null> {
  return participant
    .call<RunnerState>('report_runner', {
      name,
      ...state,
      ...(standupDay ? { lastStandupDay: standupDay } : {}),
    })
    .catch(() => null);
}
