import { describe, it, expect } from 'vitest';
import { localDay, localDayBounds, periodKey, previousDay, zoneFrom } from '../src/zone';

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
});
