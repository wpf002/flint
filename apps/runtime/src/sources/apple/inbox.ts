/**
 * The Apple Calendar inbox (Machine plan P2.6): the latest snapshot Flint
 * Calendar pushed, held in this process's memory for the apple_calendar
 * source to read. One per runtime (index.ts), shared by the route and the
 * source.
 *
 *  - Never written anywhere: not to Postgres, a file or a log. A restart loses
 *    it, and the helper's next push (at most 5 minutes on) brings it back.
 *  - Dropped 60 minutes after it arrived, so titles and addresses never sit
 *    here longer than that, and dropped at once when the source is off.
 *  - A snapshot must be fresh and newer than every one accepted before it:
 *    generatedAt within 10 minutes before and 2 minutes after now, and strictly
 *    after the last accepted one (held or already dropped), so a replayed
 *    snapshot can never bring back an event Will cancelled. Across a restart,
 *    "the last one" is the one the source last applied, which its cursor keeps
 *    (restore(), at startup: index.ts).
 *  - At most one is accepted every 5 seconds.
 *  - A push turned away because the source is not turned on yet still counts
 *    as hearing from the helper (turnedAway()), so the first run after Will
 *    turns it on waits for the next push instead of failing.
 */
import type { Snapshot } from './wire.js';

/** How far a snapshot's generatedAt may be behind, or ahead of, this process's clock. */
export const SKEW_PAST_MS = 10 * 60_000;
export const SKEW_FUTURE_MS = 2 * 60_000;
/** How long a snapshot is held. */
export const HOLD_MS = 60 * 60_000;
/** At most one accepted push in this long. */
export const ACCEPT_EVERY_MS = 5_000;

export interface Held {
  snapshot: Snapshot;
  /** When the helper read the calendar (ms). */
  generatedAt: number;
  /** When it arrived here (ms). */
  receivedAt: number;
}

export type Offer = 'accepted' | 'stale' | 'too_soon';

export class CalendarInbox {
  /** When this inbox began (the runtime's start): the source's grace period counts from it. */
  readonly startedAt: number;
  private held: Held | undefined;
  /** generatedAt of the newest snapshot ever accepted: it outlives the hold. */
  private newest = Number.NEGATIVE_INFINITY;
  /** When one was last accepted (for the rate), held or not (for "hasn't reported since"). */
  private acceptedAt: number | undefined;
  /** When a push was last turned away because the source is not turned on (409). */
  private awayAt: number | undefined;

  constructor(now = Date.now()) {
    this.startedAt = now;
  }

  /** Hold this snapshot, if it is fresh, newer than the last, and not too soon after it. */
  offer(snapshot: Snapshot, now = Date.now()): Offer {
    const at = Date.parse(snapshot.generatedAt);
    if (!(at >= now - SKEW_PAST_MS && at <= now + SKEW_FUTURE_MS) || at <= this.newest) return 'stale';
    if (this.acceptedAt !== undefined && now - this.acceptedAt < ACCEPT_EVERY_MS) return 'too_soon';
    this.held = { snapshot, generatedAt: at, receivedAt: now };
    this.newest = at;
    this.acceptedAt = now;
    return 'accepted';
  }

  /** The snapshot held now, or undefined (none yet, or dropped after 60 minutes). */
  latest(now = Date.now()): Held | undefined {
    if (this.held && now - this.held.receivedAt > HOLD_MS) this.held = undefined;
    return this.held;
  }

  /** When a snapshot was last accepted (ms), held or not; undefined when none has been since the runtime started. */
  lastAcceptedAt(): number | undefined {
    return this.acceptedAt;
  }

  /** Drop what is held (the source is not turned on: it keeps no calendar in memory). */
  clear(): void {
    this.held = undefined;
  }

  /**
   * A push turned away because the source is not turned on yet: nothing is held
   * (what was is dropped), but the helper was heard from at `now`.
   */
  turnedAway(now = Date.now()): void {
    this.clear();
    this.awayAt = now;
  }

  /** When a push was last turned away because the source was not turned on; undefined when none was. */
  lastTurnedAwayAt(): number | undefined {
    return this.awayAt;
  }

  /**
   * After a restart: the generatedAt (ms) of the snapshot the source last applied,
   * from its cursor. Nothing as old as it is accepted again.
   */
  restore(appliedAt: number): void {
    if (Number.isFinite(appliedAt)) this.newest = Math.max(this.newest, appliedAt);
  }
}
