/**
 * P2.5's exit report (Machine plan P2.5, five exit criteria), measured from the
 * database and the token file's date as they stand: GET /v1/p25/report and
 * `pnpm --filter @flint/runtime p25-report`. Each criterion says pass, fail, or
 * null (not enough data yet, not built yet, or checked elsewhere), with the
 * numbers behind it. Never a title, a name or an address.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../config.js';
import type { Db } from '../db.js';
import { localDay } from '@flint/policy';
import { percentile } from '../rollup.js';
import type { Criterion } from './exit.js';

const DAY = 86_400_000;
const SOURCE = 'google_calendar';
export const LAG_SERIES = 'google_calendar.lag_ms';

/** When google-login wrote the token (only its date is read). */
function tokenObtainedAt(home: string): Date | undefined {
  const file = join(home, '.flint', 'google', 'token.json');
  if (!existsSync(file)) return undefined;
  try {
    const at = (JSON.parse(readFileSync(file, 'utf8')) as { obtainedAt?: unknown }).obtainedAt;
    const t = typeof at === 'string' ? Date.parse(at) : NaN;
    return Number.isFinite(t) ? new Date(t) : undefined;
  } catch {
    return undefined;
  }
}

export async function p25Report(db: Db, config: Pick<Config, 'home' | 'tz'>, now = new Date()): Promise<{ at: string; criteria: Criterion[] }> {
  const out: Criterion[] = [];
  const cursor = await db.sourceCursor.findUnique({ where: { source: SOURCE } });

  // 1. The next 14 days of the calendar in the world model, p95 freshness under 15 min.
  const horizon = new Date(now.getTime() + 14 * DAY).toISOString();
  const ahead = await db.$queryRaw<Array<{ kind: string; n: number }>>`
    SELECT e.kind, count(*)::int AS n FROM "Entity" e
    WHERE e.kind IN ('commitment', 'deadline') AND e.status = 'active' AND e.state->>'source' = ${SOURCE}
      AND coalesce(e.state->>'startsAt', e.state->>'dueOn') <= ${horizon}
      AND ((e.kind = 'deadline' AND e.state->>'dueOn' >= ${localDay(config.tz, now)}) OR (e.kind = 'commitment' AND e.state->>'endsAt' > ${now.toISOString()}))
    GROUP BY e.kind`;
  const count = (k: string) => ahead.find((r) => r.kind === k)?.n ?? 0;
  const lags = (await db.metricPoint.findMany({ where: { seriesKey: LAG_SERIES, at: { gt: new Date(now.getTime() - 7 * DAY) } }, select: { value: true } })).map((p) => p.value);
  const p95 = lags.length ? percentile(lags, 0.95) : null;
  const lastOkMin = cursor?.lastOkAt ? (now.getTime() - cursor.lastOkAt.getTime()) / 60_000 : null;
  const fresh = lastOkMin !== null && lastOkMin < 15;
  // The Watcher may go only once the runtime's heads-up has actually reached Will.
  const delivered = await db.escalationDelivery.count({ where: { status: 'sent', escalation: { templateId: 'calendar_upcoming' } } });
  out.push({
    n: 1, name: 'calendar: the next 14 days as commitments and deadlines, p95 freshness < 15 min (and the Watcher off)',
    pass: !cursor?.enabled ? null : !fresh || (p95 !== null && p95 >= 15 * 60_000) ? false : p95 === null ? null : true,
    detail: !cursor?.enabled
      ? 'the calendar source is not on yet'
      : `${count('commitment')} commitment(s) and ${count('deadline')} deadline(s) ahead; last good sync ${lastOkMin === null ? 'never' : `${Math.round(lastOkMin)} min ago`}; p95 freshness ${p95 === null ? 'n/a (no changes seen yet)' : `${Math.round(p95 / 1000)} s`} over ${lags.length} change(s); ${delivered} heads-up(s) delivered, so the server's Watcher ${delivered ? 'may be turned off (FLINT_WATCHER=off; checked by hand)' : 'should stay on for now'}`,
    values: { enabled: cursor?.enabled ?? false, commitments: count('commitment'), deadlines: count('deadline'), p95LagS: p95 === null ? null : Math.round(p95 / 1000), lastOkMinAgo: lastOkMin === null ? null : Math.round(lastOkMin), headsUpsDelivered: delivered },
  });

  // 2. The refresh token survives 30 days (an app left in Google's Testing mode loses it after 7).
  const obtained = tokenObtainedAt(config.home);
  const age = obtained ? (now.getTime() - obtained.getTime()) / DAY : null;
  const lost = !!cursor?.lastError && /revoked|expired|invalid_grant/i.test(cursor.lastError);
  out.push({
    n: 2, name: 'the Google refresh token survives 30 days',
    pass: age === null ? null : lost ? false : age >= 30 && fresh ? true : null,
    detail: age === null ? 'no Google sign-in yet (google-login)' : `signed in ${age.toFixed(1)} days ago; ${lost ? 'the grant was lost (run google-login again, and publish the OAuth app so it is not in Testing mode)' : fresh ? 'still refreshing' : 'not refreshed in the last 15 min'}`,
    values: { tokenAgeDays: age === null ? null : Math.round(age * 10) / 10, grantLost: lost },
  });

  // 3. No Google text in a frontier prompt: a test in the deploy gate, not a measurement.
  out.push({ n: 3, name: 'quarantine: no Google text in any frontier prompt', pass: null, detail: 'checked by test/quarantine-p25.test.ts in every deploy gate', values: {} });

  // 4. Mail: step 2, built once the calendar has been stable for 30 days.
  out.push({ n: 4, name: 'mail (metadata only), commitments unconfirmed, ≥ 70% precision', pass: null, detail: 'not built yet: step 2, at least 30 days after the calendar is stable', values: {} });

  // 5. People only from the allowed source, each owned by Will.
  const people = await db.entity.count({ where: { kind: 'person' } });
  const bad = await db.$queryRaw<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM "Entity" e WHERE e.kind = 'person' AND (
      NOT EXISTS (SELECT 1 FROM "EntitySource" s WHERE s."entityId" = e.id)
      OR EXISTS (SELECT 1 FROM "EntitySource" s WHERE s."entityId" = e.id AND (s.source <> ${SOURCE} OR s."accountOwner" <> 'will')))`;
  const wrong = bad[0]?.n ?? 0;
  out.push({
    n: 5, name: 'people only from calendar attendees, each with accountOwner = will',
    pass: wrong > 0 ? false : people === 0 ? null : true,
    detail: `${people} person entit${people === 1 ? 'y' : 'ies'}; ${wrong} from anywhere else or without Will as owner`,
    values: { people, outsideRule: wrong },
  });

  return { at: now.toISOString(), criteria: out };
}
