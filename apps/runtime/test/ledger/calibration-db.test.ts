/**
 * The nightly scores on flint_test (P4 part 2): one row per domain, type,
 * method and kind; the counts beside the score; ranges scored by coverage and
 * pinball loss; ECE and the interval around a Brier score only from 100 scored,
 * and the interval only from results spread over enough days or goals.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { localDay } from '@flint/policy';
import { NO_DB, freshDb, id, HEX, type TestUrls } from '../db';
import { DAY, HOUR, TZ, dayStart, ledgerKit, type LedgerKit } from './kit';
import { goalFixture, type GoalFixture } from '../goals/fixture';
import { MIN_SCORED, WINDOW_DAYS, nightlyWindow, runSnapshot, snapshotCalibration, type SnapshotCounts } from '../../src/ledger/calibration';
import { clusterBootstrapMean, seedFrom } from '../../src/ledger/bootstrap';
import { ece, score, scoreRanges } from '../../src/ledger/scoring';
import { sweep } from '../../src/ledger/sweep';

describe.skipIf(NO_DB)('calibration snapshots on flint_test', () => {
  let urls: TestUrls;
  let k: LedgerKit;
  let g: GoalFixture;
  const zero = (): SnapshotCounts => ({ groups: 0, scored: 0, ranges: 0, unscaled: 0, withEce: 0, withInterval: 0 });
  const window = () => ({ start: new Date(Date.now() - 60 * DAY), end: new Date(Date.now() + DAY) });
  const rows = async () => (await k.owner(`SELECT * FROM "CalibrationSnapshot" ORDER BY "windowEnd", domain, type, method, kind`)).rows;
  const row = (all: Array<Record<string, unknown>>, domain: string, kind = 'binary', method = 'rule') => all.find((r) => r.domain === domain && r.kind === kind && r.method === method)!;

  /**
   * `n` yes/no predictions of one group, made 40 days ago and resolved over `days` different days (or, with goals,
   * shared between them). Probabilities walk from 5% to 95%; about as many come true as were said to.
   */
  async function scored(domain: string, n: number, days: number, goals: string[] = []): Promise<string> {
    const prefix = `pd${id('g').slice(-6)}x`;
    const made = new Date(Date.now() - 40 * DAY);
    await k.owner(`ALTER TABLE "Prediction" DISABLE TRIGGER "Prediction_insert_check"`);
    try {
      await k.app(
        `INSERT INTO "Prediction" (id, claim, kind, probability, method, domain, type, evidence, "resolutionCriteria", resolver, "resolveBy", "createdAt", "createdBy", "goalId")
         SELECT $1 || lpad(i::text, 4, '0'), 'a synthetic claim', 'binary', (0.05 + (i % 19) * 0.05)::float8, 'rule', $2, $3, '[]', 'synthetic criteria', 'auto_world',
                $4::timestamptz + interval '2 days', $4, $5, CASE WHEN $6::text[] = '{}' THEN NULL ELSE ($6::text[])[1 + i % cardinality($6::text[])] END
         FROM generate_series(1, $7::int) i`,
        [prefix, domain, goals.length ? 'deadline_met' : 'event_occurs', made, goals.length ? 'runtime:goals' : 'test', goals, n],
      );
    } finally {
      await k.owner(`ALTER TABLE "Prediction" ENABLE TRIGGER "Prediction_insert_check"`);
    }
    await k.app(
      `INSERT INTO "Resolution" (id, "predictionId", outcome, "eventAt", "resolvedBy")
       SELECT 'rs' || p.id, p.id, ((p.i * 7) % 20) < (p.probability * 20), date_trunc('day', now()) - ((p.i % $2::int) + 1) * interval '1 day' + interval '6 hours', 'auto_world'
       FROM (SELECT id, probability, right(id, 4)::int AS i FROM "Prediction" WHERE id LIKE $1 || '%') p`,
      [prefix, days],
    );
    return prefix;
  }
  /** The group's scored rows as the snapshot reads them, for an independent recomputation. */
  async function scoredRows(prefix: string) {
    const r = (await k.owner(
      `SELECT p.probability AS p, r.outcome AS o, r."eventAt" AS at, p."goalId" AS goal FROM "Prediction" p JOIN "Resolution" r ON r."predictionId" = p.id WHERE p.id LIKE $1 || '%' ORDER BY p.id`, [prefix])).rows;
    return r as Array<{ p: number; o: boolean; at: Date; goal: string | null }>;
  }

  beforeAll(async () => {
    urls = await freshDb();
    k = await ledgerKit(urls);
    g = await goalFixture(urls, k.db);
  });
  afterAll(async () => k?.db.$disconnect());

  it('the nightly window is the 90 local days up to the start of today, the same whenever in the day it is asked', () => {
    const noon = new Date('2026-10-13T17:00:00.000Z');
    expect(nightlyWindow('America/Chicago', noon)).toEqual({ windowStart: new Date('2026-07-15T05:00:00.000Z'), windowEnd: new Date('2026-10-13T05:00:00.000Z') });
    expect(nightlyWindow('America/Chicago', new Date('2026-10-13T08:45:00.000Z'))).toEqual(nightlyWindow('America/Chicago', noon));
    expect(nightlyWindow('UTC', noon).windowEnd.toISOString()).toBe('2026-10-13T00:00:00.000Z');
    expect([WINDOW_DAYS, MIN_SCORED]).toEqual([90, 100]);
  });

  it('ECE and the interval are stored only from 100 scored; the interval only when the results are spread over 10 days or more', async () => {
    const spread = await scored('services', 120, 12);
    const bunched = await scored('deploys', 120, 3);
    const few = await scored('repos', 99, 12);
    const exactly = await scored('projects', 100, 10);
    const counts = zero();
    const { start, end } = window();
    const written = await snapshotCalibration(k.db, start, end, TZ, counts);
    expect(written.map((r) => `${r.domain}/${r.type}/${r.method}/${r.kind}`).sort()).toEqual(['deploys/event_occurs/rule/binary', 'projects/event_occurs/rule/binary', 'repos/event_occurs/rule/binary', 'services/event_occurs/rule/binary']);
    expect(counts).toEqual({ groups: 4, scored: 439, ranges: 0, unscaled: 0, withEce: 3, withInterval: 2 });
    const all = await rows();
    // 120 over 12 days: everything, and each number is what the pure functions give for those rows.
    const a = row(all, 'services');
    const ra = await scoredRows(spread);
    const sa = score(ra.map((r) => ({ p: r.p, o: r.o })));
    expect(a).toMatchObject({ n: 120, nOpen: 0, nExpired: 0, nConditionUnmet: 0, nVoid: 0, nLateSuperseded: 0, unresolvedRate: 0, intervalCoverage: null, pinball: null });
    expect(a.brier as number).toBeCloseTo(sa.brier, 12);
    expect(a.baseRate as number).toBeCloseTo(sa.baseRate, 12);
    expect(a.brierSkill as number).toBeCloseTo(sa.brierSkill!, 12);
    expect(a.ece as number).toBeCloseTo(ece(ra.map((r) => ({ p: r.p, o: r.o })))!, 12);
    expect(a.reliability).toHaveLength(10);
    const ci = clusterBootstrapMean(ra.map((r) => (r.p - (r.o ? 1 : 0)) ** 2), ra.map((r) => `day:${localDay(TZ, r.at)}`), { seed: seedFrom('services|event_occurs|rule|binary') })!;
    expect(new Set(ra.map((r) => localDay(TZ, r.at))).size).toBe(12);
    // The interval is the pure function's, for those rows and the group's own seed (to the precision a float column keeps).
    expect(a.brierCiLow as number).toBeCloseTo(ci[0], 12);
    expect(a.brierCiHigh as number).toBeCloseTo(ci[1], 12);
    expect(a.brierCiLow as number).toBeLessThan(a.brier as number);
    expect(a.brierCiHigh as number).toBeGreaterThan(a.brier as number);
    // 120 over 3 days: enough for ECE; three days are not enough to say how sure the score is.
    const b = row(all, 'deploys');
    expect(b.n).toBe(120);
    expect(b.ece).not.toBeNull();
    expect([b.brierCiLow, b.brierCiHigh]).toEqual([null, null]);
    // 99: neither, however well spread.
    const c = row(all, 'repos');
    expect([c.n, c.ece, c.brierCiLow, c.brierCiHigh]).toEqual([99, null, null, null]);
    expect(c.brier).not.toBeNull();
    // Exactly 100 over exactly 10 days: both.
    const d = row(all, 'projects');
    expect(d.n).toBe(100);
    expect(d.ece).not.toBeNull();
    expect(d.brierCiLow).not.toBeNull();
    void few;
    void exactly;
    void bunched;
  });

  it('a goal is one cluster: 120 forecasts of three goals, on many days, are still three goals, and get no interval', async () => {
    const goals = [await g.activeGoal(), await g.activeGoal(), await g.activeGoal()].map((x) => x.id);
    const prefix = await scored('goals', 120, 12, goals);
    const { start, end } = window();
    await snapshotCalibration(k.db, start, end, TZ);
    const r = row(await rows(), 'goals');
    expect([r.type, r.n]).toEqual(['deadline_met', 120]);
    expect(r.ece).not.toBeNull();
    expect([r.brierCiLow, r.brierCiHigh]).toEqual([null, null]);
    const scoredGoals = await scoredRows(prefix);
    expect(new Set(scoredGoals.map((x) => x.goal)).size).toBe(3);
    expect(new Set(scoredGoals.map((x) => localDay(TZ, x.at))).size).toBe(12);
  });

  it('ranges are their own rows: the share that held, and the pinball loss over each run\'s scale; a run with no scale is left out and counted', async () => {
    const series = await k.onSeries();
    const made = { madeAgo: 3 * DAY, dueAgo: 2 * DAY };
    const settle = (pid: string, value: number) => k.app(`INSERT INTO "Resolution" (id, "predictionId", "outcomeValue", "eventAt", "resolvedBy") VALUES ($1, $2, $3, now() - interval '1 day', 'auto_metric')`, [id('rs'), pid, value]);
    // The five ranges of the scoring test's hand-computed example, each on a run with its own scale.
    const five: Array<[Record<string, unknown>, Record<string, unknown>, number]> = [
      [{ lower: 2, upper: 6, pointEstimate: 4 }, { scale: 2 }, 4],
      [{ lower: 2, upper: 6, pointEstimate: 4 }, { scale: 2 }, 9],
      [{ lower: 10, upper: 20, pointEstimate: 15 }, { scale: 4 }, 8],
      [{ lower: 0, upper: 0, pointEstimate: 0 }, { scale: 0 }, 0],
      [{ lower: 1, upper: 3, pointEstimate: 2, level: 0.5 }, { scale: 1, level: 0.5 }, 3],
    ];
    for (const [range, run, value] of five) await settle(await k.range(series, dayStart(2), range, made, run), value);
    // Beside them: one still open, and one that ran out.
    await k.range(series, dayStart(2), {}, { madeAgo: 3 * DAY, dueAgo: -DAY });
    const lapsed = await k.range(series, dayStart(2), { resolverSpec: null }, { madeAgo: 5 * DAY, dueAgo: 4 * DAY });
    await sweep(k.db, { tz: TZ, resolve: true, expire: true });
    expect(await k.status(lapsed)).toBe('expired');
    const counts = zero();
    const { start, end } = window();
    await snapshotCalibration(k.db, start, end, TZ, counts);
    expect(counts).toMatchObject({ ranges: 5, unscaled: 1 });
    const r = row(await rows(), 'deploys', 'interval', 'statistical');
    expect(r).toMatchObject({ type: 'trend', n: 5, nOpen: 1, nExpired: 1, brier: null, baseRate: null, brierSkill: null, ece: null, brierCiLow: null, brierCiHigh: null, reliability: [] });
    expect(r.intervalCoverage as number).toBeCloseTo(3 / 5, 12);
    expect(r.pinball as number).toBeCloseTo(0.39375, 12);
    expect(r.unresolvedRate as number).toBeCloseTo(1 / 6, 12);
    // The same numbers from the pure function, over the same five.
    const again = scoreRanges(five.map(([range, run, value]) => ({ lower: range.lower as number, upper: range.upper as number, level: (range.level as number | undefined) ?? 0.8, value, scale: run.scale as number })));
    expect([r.intervalCoverage, r.pinball]).toEqual([again.coverage, again.pinball]);
    // A group of ranges with nothing scored yet has n = 0 beside a coverage of 0 (as a yes/no group's Brier score has): read n first.
    const hours = await k.onSeries({ unit: 'hours', sensitivity: 'personal', key: `daily.calendar.${id('v')}` });
    await k.range(hours, dayStart(2), {}, { madeAgo: 3 * DAY, dueAgo: -DAY });
    await snapshotCalibration(k.db, start, end, TZ);
    expect(row(await rows(), 'calendar', 'interval', 'statistical')).toMatchObject({ n: 0, nOpen: 1, intervalCoverage: 0, pinball: null, unresolvedRate: 0 });
  });

  it('beside the score: open, run out, condition unmet, void and late-superseded, counted as before; a voided result is not scored', async () => {
    const said = (over: Record<string, unknown>, t: { madeAgo?: number; dueAgo?: number } = {}) => k.prediction({ domain: 'assets', ...over }, { madeAgo: 5 * DAY, dueAgo: 4 * DAY, ...t });
    const settle = (pid: string, outcome: boolean) => k.app(`INSERT INTO "Resolution" (id, "predictionId", outcome, "eventAt", "resolvedBy") VALUES ($1, $2, $3, now() - interval '1 day', 'auto_world')`, [id('rs'), pid, outcome]);
    await settle(await said({ probability: 0.8 }), true);
    await settle(await said({ probability: 0.6 }), false);
    await said({}, { dueAgo: -DAY });
    await said({ resolverSpec: null });
    await said({ resolverSpec: null });
    // Revised a day before its date: late, and still scored when its result comes.
    const revised = await said({ probability: 0.3 }, { madeAgo: 10 * DAY, dueAgo: 2 * DAY });
    await said({ supersedesId: revised, probability: 0.4 }, { madeAgo: 3 * DAY, dueAgo: -DAY });
    await settle(revised, false);
    // Scored, then set aside with Will's signature: counted as void, and out of the score.
    const voided = await said({ probability: 0.9 });
    await settle(voided, false);
    const aid = id('appr');
    const expires = (await k.owner(`SELECT to_char((now() + interval '10 minutes') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS t`)).rows[0].t as string;
    await k.approver(
      `INSERT INTO "Approval" (id, "subjectType", "subjectId", decision, payload, challenge, "credentialId", signature, "expiresAt") VALUES ($1, 'void', $2, 'approve', $3, $4, $5, '\\x01', $6)`,
      [aid, voided, JSON.stringify({ v: 1, subjectType: 'void', subjectId: voided, decision: 'approve', action: 'ledger.void', argsDigest: HEX('a'), expiresAt: expires, nonce: HEX('0').slice(0, 32) }), HEX('c'), k.credentialId, expires],
    );
    await k.app(`UPDATE "Prediction" SET status = 'void', "voidApprovalId" = $2 WHERE id = $1`, [voided, aid]);
    // Advice that was declined: its prediction's condition was never met.
    const svc = await k.service(k.serviceKey(), { running: false, disabled: false }, new Date(Date.now() - 6 * HOUR));
    await k.escalated(svc, { status: 'dismissed' });
    const swept = await sweep(k.db, { tz: TZ, resolve: true, expire: true });
    expect(swept).toMatchObject({ conditionUnmet: 1, expired: 2 });
    const { start, end } = window();
    await snapshotCalibration(k.db, start, end, TZ);
    const all = await rows();
    const r = row(all, 'assets');
    expect(r).toMatchObject({ n: 3, nOpen: 2, nExpired: 2, nConditionUnmet: 0, nVoid: 1, nLateSuperseded: 1 });
    expect(r.brier as number).toBeCloseTo((0.2 ** 2 + 0.6 ** 2 + 0.3 ** 2) / 3, 12);
    expect(r.baseRate as number).toBeCloseTo(1 / 3, 12);
    expect(r.unresolvedRate as number).toBeCloseTo(2 / 5, 12);
    expect(row(all, 'recommendation', 'binary', 'base_rate')).toMatchObject({ type: 'effect_given_accept', n: 0, nConditionUnmet: 1, nOpen: 0 });
  });

  it('scoring the same window again rewrites its rows; the nightly run says what it did in one audit entry, counts only', async () => {
    const { start, end } = window();
    const first = await snapshotCalibration(k.db, start, end, TZ);
    const before = await rows();
    const again = await snapshotCalibration(k.db, start, end, TZ);
    expect(again.map((r) => r.id).sort()).toEqual(first.map((r) => r.id).sort());
    const after = await rows();
    expect(after.length).toBe(before.length);
    const same = (x: Array<Record<string, unknown>>) => x.map(({ computedAt: _c, ...rest }) => rest);
    expect(same(after)).toEqual(same(before));
    // The nightly run: its own window (made before today, so the 40-day-old groups are in it), and its entry.
    const counts = await runSnapshot(k.db, { tz: TZ, tier: 'approval' });
    expect(counts.groups).toBeGreaterThanOrEqual(5);
    // Of the five 40-day-old groups, four reached 100 scored, and two of those were spread over 10 days or more.
    expect(counts).toMatchObject({ withEce: 4, withInterval: 2, ranges: 5, unscaled: 1 });
    const night = nightlyWindow(TZ, new Date());
    expect((await k.owner(`SELECT count(*)::int AS n FROM "CalibrationSnapshot" WHERE "windowEnd" = $1 AND "windowStart" = $2`, [night.windowEnd, night.windowStart])).rows[0].n).toBe(counts.groups);
    const audits = (await k.owner(`SELECT actor, context, kind, action, tier, outcome, inputs, reasoning, "outcomeDetail" FROM "AuditEntry" WHERE action = 'ledger.calibration.snapshot' ORDER BY seq DESC`)).rows;
    expect(audits).toHaveLength(1);
    expect(audits[0]).toEqual({
      actor: 'runtime:ledger', context: 'autonomous', kind: 'action', action: 'ledger.calibration.snapshot', tier: 'approval', outcome: 'ok', reasoning: null, outcomeDetail: null,
      inputs: { ...counts, windowDays: 90 },
    });
    // A second run that night rewrites the same rows.
    const total = (await rows()).length;
    await runSnapshot(k.db, { tz: TZ });
    expect((await rows()).length).toBe(total);
  });
});
