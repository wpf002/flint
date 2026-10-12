import { describe, it, expect } from 'vitest';
import { REVIEW_HOUR, addLocalDays, localDay, localDayBounds, localWallTime, nextReviewAt, periodKey, previousDay, zoneFrom } from '../src/zone';

describe('zone', () => {
  it('FLINT_TZ, else FLINT_USER_TZ, else Chicago; blank is unset; an unknown zone is refused', () => {
    expect(zoneFrom(' ', '')).toBe('America/Chicago');
    expect(zoneFrom(undefined, 'Europe/London')).toBe('Europe/London');
    expect(zoneFrom('Asia/Tokyo', 'Europe/London')).toBe('Asia/Tokyo');
    expect(() => zoneFrom('Mars/Olympus')).toThrow(/not a time zone/);
  });

  it('a 23-hour and a 25-hour day are exactly their length', () => {
    const spring = localDayBounds('America/Chicago', '2026-03-08');
    expect(spring.end.getTime() - spring.start.getTime()).toBe(23 * 3600_000);
    const fall = localDayBounds('America/Chicago', '2026-11-01');
    expect(fall.end.getTime() - fall.start.getTime()).toBe(25 * 3600_000);
    expect(fall.start.toISOString()).toBe('2026-11-01T05:00:00.000Z');
    expect(localDay('America/Chicago', new Date('2026-10-02T04:59:00Z'))).toBe('2026-10-01');
    expect(previousDay('2026-03-01')).toBe('2026-02-28');
  });

  it('day and week keys are local; an hour key is the UTC hour (the repeated DST hour is not counted twice)', () => {
    const at = new Date('2026-11-01T06:30:00Z'); // 01:30 CDT; the next UTC hour is 01:30 CST
    expect(periodKey({ period: 'day' }, 'America/Chicago', at)).toBe('2026-11-01');
    expect(periodKey({ period: 'hour' }, 'America/Chicago', at)).toBe('2026-11-01T06');
    expect(periodKey({ period: 'hour' }, 'America/Chicago', new Date('2026-11-01T07:30:00Z'))).toBe('2026-11-01T07');
    expect(periodKey({ period: 'week' }, 'America/Chicago', at)).toMatch(/^2026-W\d{2}$/);
  });

  // ---- The review calendar (P3): 09:00 local, whatever the clocks do ---------------------------
  const CADENCES = ['P1D', 'P3D', 'P1W', 'P2W', 'P1M'] as const;
  const wall = (tz: string, at: Date) =>
    new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);
  const hhmm = (tz: string, at: Date) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);

  it('a review always lands at 09:00 local, on every cadence, across each zone’s clock changes', () => {
    expect(REVIEW_HOUR).toBe(9);
    // Each zone, with a due time shortly before one of its changes: Chicago falls back on 2026-11-01 and springs
    // forward on 2027-03-14; London falls back on 2026-10-25; Lord Howe shifts by 30 minutes on 2026-10-04.
    const cases: Array<[string, string]> = [
      ['America/Chicago', '2026-10-28'], ['America/Chicago', '2027-03-10'], ['Europe/London', '2026-10-21'], ['Australia/Lord_Howe', '2026-10-01'], ['Australia/Lord_Howe', '2027-03-30'],
    ];
    for (const [tz, day] of cases) {
      for (const cadence of CADENCES) {
        let due = localWallTime(tz, day, 9, 0);
        // A chain of reviews, each done on time: every one at 09:00 local, each later than the last.
        for (let i = 0; i < 8; i++) {
          const next = nextReviewAt(cadence, tz, due, due, Number(day.slice(8, 10)));
          expect(hhmm(tz, next), `${tz} ${cadence} after ${wall(tz, due)}`).toBe('09:00');
          expect(next.getTime()).toBeGreaterThan(due.getTime());
          due = next;
        }
      }
    }
  });

  it('it steps calendar days, not multiples of 24 hours: the instants differ by 23, 24, 25 or 23.5 hours', () => {
    const H = 3_600_000;
    const step = (tz: string, day: string) => {
      const due = localWallTime(tz, day, 9, 0);
      return (nextReviewAt('P1D', tz, due, due).getTime() - due.getTime()) / H;
    };
    expect(step('America/Chicago', '2026-10-30')).toBe(24);
    expect(step('America/Chicago', '2026-10-31')).toBe(25); // the clocks fall back overnight
    expect(step('America/Chicago', '2027-03-13')).toBe(23); // and spring forward
    expect(step('Europe/London', '2026-10-24')).toBe(25);
    expect(step('Australia/Lord_Howe', '2026-10-03')).toBe(23.5); // a 30-minute change
    // Exact instants: 09:00 CDT is 14:00Z, 09:00 CST is 15:00Z; 09:00 BST is 08:00Z, 09:00 GMT is 09:00Z.
    expect(nextReviewAt('P1W', 'America/Chicago', localWallTime('America/Chicago', '2026-10-28', 9, 0), localWallTime('America/Chicago', '2026-10-28', 9, 0)).toISOString()).toBe('2026-11-04T15:00:00.000Z');
    expect(nextReviewAt('P1W', 'America/Chicago', localWallTime('America/Chicago', '2027-03-10', 9, 0), localWallTime('America/Chicago', '2027-03-10', 9, 0)).toISOString()).toBe('2027-03-17T14:00:00.000Z');
    expect(nextReviewAt('P1W', 'Europe/London', localWallTime('Europe/London', '2026-10-21', 9, 0), localWallTime('Europe/London', '2026-10-21', 9, 0)).toISOString()).toBe('2026-10-28T09:00:00.000Z');
    expect(nextReviewAt('P3D', 'Australia/Lord_Howe', localWallTime('Australia/Lord_Howe', '2026-10-02', 9, 0), localWallTime('Australia/Lord_Howe', '2026-10-02', 9, 0)).toISOString()).toBe('2026-10-04T22:00:00.000Z');
  });

  it('the weekday stays put across a change, and each cadence steps its own number of days', () => {
    const tz = 'America/Chicago';
    const due = localWallTime(tz, '2026-10-28', 9, 0); // a Wednesday
    const day = (cadence: (typeof CADENCES)[number]) => localDay(tz, nextReviewAt(cadence, tz, due, due));
    expect([day('P1D'), day('P3D'), day('P1W'), day('P2W'), day('P1M')]).toEqual(['2026-10-29', '2026-10-31', '2026-11-04', '2026-11-11', '2026-11-28']);
    expect(wall(tz, nextReviewAt('P1W', tz, due, due)).slice(0, 3)).toBe('Wed');
    expect(wall(tz, nextReviewAt('P2W', tz, due, due)).slice(0, 3)).toBe('Wed');
    // Monthly reviews keep the goal's own day, clamped to each month: Jan 31, Feb 28 (or 29), Mar 31.
    const jan = localWallTime(tz, '2027-01-31', 9, 0);
    const feb = nextReviewAt('P1M', tz, jan, jan, 31);
    const mar = nextReviewAt('P1M', tz, feb, feb, 31);
    expect([localDay(tz, feb), localDay(tz, mar)]).toEqual(['2027-02-28', '2027-03-31']);
    expect([hhmm(tz, feb), hhmm(tz, mar)]).toEqual(['09:00', '09:00']);
    const leap = localWallTime(tz, '2028-01-31', 9, 0);
    expect(localDay(tz, nextReviewAt('P1M', tz, leap, leap, 31))).toBe('2028-02-29');
  });

  it('it is anchored on the due time: a late run rolls past now without drifting the weekday or piling up', () => {
    const tz = 'America/Chicago';
    const due = localWallTime(tz, '2026-10-07', 9, 0); // a Wednesday
    // Run five weeks and a day late (the planner was off): one next review, the Wednesday after now, not five.
    const now = localWallTime(tz, '2026-11-12', 16, 30);
    const next = nextReviewAt('P1W', tz, due, now);
    expect(wall(tz, next)).toBe('Wed, 18/11/2026, 09:00');
    expect(next.getTime()).toBeGreaterThan(now.getTime());
    // Run a few minutes late on the day itself: the next slot, not the same one again.
    expect(localDay(tz, nextReviewAt('P1W', tz, due, new Date(due.getTime() + 3 * 60_000)))).toBe('2026-10-14');
    // Run early on a slot's own morning (07:00): that morning's 09:00 is still ahead, and is the next review.
    const early = localWallTime(tz, '2026-10-21', 7, 0);
    expect(wall(tz, nextReviewAt('P1W', tz, due, early))).toBe('Wed, 21/10/2026, 09:00');
    // Every daily slot of a year is 09:00 local and one calendar day after the last.
    let at = localWallTime(tz, '2026-01-01', 9, 0);
    for (let i = 0; i < 366; i++) {
      const n = nextReviewAt('P1D', tz, at, at);
      expect(localDay(tz, n)).toBe(addLocalDays(localDay(tz, at), 1));
      expect(hhmm(tz, n)).toBe('09:00');
      at = n;
    }
  });
});
