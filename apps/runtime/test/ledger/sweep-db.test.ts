/**
 * The ledger's sweep on flint_test (P4 part 2): what runs out and when, what a
 * second run does, what it writes about itself, and the two jobs around it.
 *
 *  - A prediction that resolves by itself runs out 72 hours after its resolve
 *    time, never sooner. One only Will resolves runs out 14 days after Flint
 *    asked him about it, and never before he was asked. Whatever can still be
 *    settled is settled first, however late.
 *  - It never voids, and never resolves as Will.
 *  - A second run over the same rows changes nothing.
 *  - One sweep is one transaction: its rows and its audit entry are written
 *    together or not at all, and a write the database refuses is taken back
 *    alone. One sweep runs at a time.
 *  - More than a page of due rows is read once each. A sweep that stops at
 *    its limit lets what it tried run out, so the head makes way.
 *  - One audit entry per sweep: counts and switches only.
 *  - The jobs exist only while FLINT_PREDICT is on, and do nothing until Will
 *    has turned a number on with the signed card; a rule that forbids an
 *    action stops that part.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NO_DB, freshDb, id, type TestUrls } from '../db';
import { CANARY, DAY, HOUR, MIN, TZ, dayStart, ledgerKit, type LedgerKit } from './kit';
import { goalFixture, type GoalFixture } from '../goals/fixture';
import type { Config } from '../../src/config';
import type { Bus } from '../../src/bus';
import { ALL_QUEUES } from '../../src/bus';
import { FORECAST_CRON, SERIES_CRON, SNAPSHOT_CRON, SWEEP_CRON, jobSpecs, predictJobs, type JobContext } from '../../src/jobs';
import { localDay, localDayBounds, addLocalDays } from '@flint/policy';
import { withClient } from '../db';
import { AUTO_GRACE_MS, SUPERSEDED_RETRY_MS, SWEEP_LIMIT, SWEEP_LOCK, WILL_GRACE_MS, predictionsStarted, sweep } from '../../src/ledger/sweep';

describe.skipIf(NO_DB)('the ledger\'s sweep on flint_test', () => {
  let urls: TestUrls;
  let k: LedgerKit;
  let g: GoalFixture;
  const ago = (ms: number) => new Date(Date.now() - ms);
  const all = (o: Partial<Parameters<typeof sweep>[1]> = {}) => sweep(k.db, { tz: TZ, resolve: true, expire: true, ...o });
  /** A prediction that resolves by itself and can never be settled: its item has not been seen since. */
  let stale: string;
  const waiting = (dueAgo: number, over: Record<string, unknown> = {}) =>
    k.prediction({ resolverSpec: { entityId: stale, check: 'healthy', at: 'resolveBy' }, ...over }, { madeAgo: dueAgo + DAY, dueAgo });
  /**
   * One only Will resolves, due `dueAgo` ago; with `askedAgo`, Flint put its question to him that long ago. `shadow`:
   * the question was asked quietly (no dot, no line in the morning summary), so nobody was told it waits.
   */
  const wills = async (dueAgo: number, askedAgo?: number, shadow = false) => {
    const p = await k.prediction({ method: 'model_reasoning', resolver: 'will', createdBy: 'client:server' }, { madeAgo: dueAgo + DAY, dueAgo });
    if (askedAgo !== undefined) await k.asked(p, askedAgo, { shadow });
    return p;
  };
  /** A service that is running, seen six hours ago and five minutes ago: a prediction about it an hour ago can be settled. */
  const running = async () => {
    const key = k.serviceKey();
    const eid = await k.service(key, { running: true, disabled: false }, ago(6 * HOUR));
    await k.service(key, { running: true, disabled: false, lastExit: 0 }, ago(5 * MIN));
    return eid;
  };
  const ledger = async () => JSON.stringify([
    (await k.owner(`SELECT id, status, "supersededAt", "lateSupersession" FROM "Prediction" ORDER BY id`)).rows,
    (await k.owner(`SELECT id, "predictionId", outcome, "outcomeValue", "eventAt", "resolvedAt", "resolvedBy" FROM "Resolution" ORDER BY id`)).rows,
    (await k.owner(`SELECT id, status, "decidedAt", "effectObserved", "outcomeAt" FROM "Recommendation" ORDER BY id`)).rows,
  ]);

  beforeAll(async () => {
    urls = await freshDb();
    k = await ledgerKit(urls);
    g = await goalFixture(urls, k.db);
    stale = await k.service(k.serviceKey(), { running: true, disabled: false }, ago(40 * DAY));
  });
  afterAll(async () => k?.db.$disconnect());

  it('the graces are 72 hours and 14 days', () => {
    expect([AUTO_GRACE_MS / HOUR, WILL_GRACE_MS / DAY, SUPERSEDED_RETRY_MS / DAY, SWEEP_LIMIT]).toEqual([72, 14, 14, 5000]);
  });

  it('a sweep that took on exactly its limit and found no more is whole; one more of its own still due, and it says it stopped', async () => {
    const two = [await waiting(HOUR), await waiting(HOUR + MIN)];
    expect(await all({ limit: 2 })).toMatchObject({ capped: false, waiting: 2 });
    expect(await all({ limit: 1 })).toMatchObject({ capped: true, waiting: 1 });
    for (const p of two) expect(await k.status(p), p).toBe('open');
  });

  it('one that resolves by itself runs out 72 hours after its resolve time, never sooner; one only Will resolves, 14 days after he was asked, and never before', async () => {
    const auto = { fresh: await waiting(HOUR), day3: await waiting(71 * HOUR), over: await waiting(73 * HOUR), old: await waiting(20 * DAY) };
    const metric = await waiting(73 * HOUR, { resolver: 'auto_metric', resolverSpec: { seriesKey: 'no.such.series', at: dayStart(5).toISOString(), op: 'above', value: 1 } });
    const will = {
      // Never asked: however old, it stays open. Flint does not let a prediction of his lapse before putting the question to him.
      never: await wills(40 * DAY), fresh: await wills(HOUR),
      asked13: await wills(20 * DAY, 13 * DAY + 23 * HOUR), asked14: await wills(20 * DAY, 14 * DAY + HOUR),
      // Asked a moment ago about one that was due long since: his two weeks start at the question.
      justAsked: await wills(60 * DAY, MIN),
      // Asked in shadow, a month ago: nothing announced it, so its two weeks have not begun. It stays open.
      quiet: await wills(60 * DAY, 30 * DAY, true),
    };
    const ahead = await waiting(-HOUR);
    const c = await all();
    expect(c).toMatchObject({ resolved: 0, expired: 4, conditionUnmet: 0, refused: 0, capped: false });
    expect([await k.status(auto.fresh), await k.status(auto.day3), await k.status(auto.over), await k.status(auto.old), await k.status(metric)]).toEqual(['open', 'open', 'expired', 'expired', 'expired']);
    expect([await k.status(will.never), await k.status(will.fresh), await k.status(will.asked13), await k.status(will.asked14), await k.status(will.justAsked)]).toEqual(['open', 'open', 'open', 'expired', 'open']);
    expect(await k.status(will.quiet)).toBe('open');
    expect(await k.status(ahead)).toBe('open');
    // Run out is not resolved: no resolution is written for any of them, and none is void.
    for (const p of [auto.over, auto.old, metric, will.asked14]) expect(await k.resolution(p), p).toBeUndefined();
    expect((await k.owner(`SELECT count(*)::int AS n FROM "Prediction" WHERE status = 'void' OR "voidApprovalId" IS NOT NULL`)).rows[0].n).toBe(0);
    // With the clock moved on (the sweep's own), the ones inside their grace run out when it ends, and not before.
    expect(await all({ now: new Date(Date.now() + 30 * MIN) })).toMatchObject({ expired: 0 });
    expect(await all({ now: new Date(Date.now() + 70 * MIN) })).toMatchObject({ expired: 2 });
    expect([await k.status(auto.day3), await k.status(will.asked13), await k.status(auto.fresh), await k.status(will.fresh)]).toEqual(['expired', 'expired', 'open', 'open']);
    // Forty days past its date and never asked about: still open.
    expect(await k.status(will.never)).toBe('open');
  });

  it('whatever can still be settled is settled first, however late: a weekend outage is not "unresolved"', async () => {
    // Due four days ago; the sweep did not run since (the runtime was down). The facts are all there now.
    const key = k.serviceKey();
    const eid = await k.service(key, { running: false, disabled: false }, ago(6 * DAY));
    await k.service(key, { running: true, disabled: false }, ago(5 * MIN));
    const world = await k.prediction({ resolverSpec: { entityId: eid, check: 'healthy', at: 'resolveBy' } }, { madeAgo: 5 * DAY, dueAgo: 4 * DAY });
    const series = await k.onSeries();
    const at = dayStart(5);
    await k.point(series, at, CANARY);
    const range = await k.range(series, at, {}, { madeAgo: Date.now() - at.getTime() - HOUR, dueAgo: 4 * DAY - HOUR });
    const c = await all();
    expect(c).toMatchObject({ resolved: 2, expired: 0, refused: 0 });
    expect(await k.resolution(world)).toMatchObject({ outcome: false, resolvedBy: 'auto_world' });
    expect(await k.resolution(range)).toMatchObject({ outcomeValue: CANARY, resolvedBy: 'auto_metric' });
    expect([await k.status(world), await k.status(range)]).toEqual(['resolved', 'resolved']);
  });

  it('a superseded prediction never runs out (it stays superseded), and the sweep stops trying one after 14 days', async () => {
    const base = await all();
    expect(base).toMatchObject({ expired: 0, resolved: 0 });
    // Revised an hour before it was due, 73 hours ago: past the grace, still superseded, still read (it could be settled yet).
    const first = await waiting(73 * HOUR);
    await waiting(-HOUR, { supersedesId: first });
    expect(await k.status(first)).toBe('superseded');
    const within = await all();
    expect(within).toMatchObject({ expired: 0, resolved: 0, waiting: base.waiting + 1 });
    expect(await k.status(first)).toBe('superseded');
    // One whose date is over two weeks gone is not read any more: nothing changes, and nothing is counted for it.
    const old = await waiting(15 * DAY);
    await waiting(-HOUR, { supersedesId: old });
    expect(await all()).toMatchObject({ expired: 0, resolved: 0, waiting: within.waiting });
    expect([await k.status(first), await k.status(old)]).toEqual(['superseded', 'superseded']);
    for (const p of [first, old]) expect(await k.resolution(p), p).toBeUndefined();
  });

  it('a second run over the same rows changes nothing', async () => {
    // Everything a sweep can do, once: a resolution, a decision, a condition unmet, an expiry.
    const key = k.serviceKey();
    const eid = await k.service(key, { running: false, disabled: false }, ago(6 * HOUR));
    await k.service(key, { running: true, disabled: false }, ago(2 * HOUR));
    await k.service(key, { running: true, disabled: false, lastExit: 0 }, ago(5 * MIN));
    const taken = await k.escalated(eid, { status: 'acked', ackedAgo: 2 * HOUR });
    const declined = await k.escalated(eid, { status: 'dismissed' });
    const goal = await g.activeGoal();
    const forecast = await k.prediction({ method: 'rule', domain: 'goals', type: 'deadline_met', createdBy: 'runtime:goals', goalId: goal.id, resolverSpec: { goalId: goal.id, rule: 'goal_done_by' } }, { madeAgo: 2 * DAY, dueAgo: HOUR });
    const lapsed = await waiting(80 * HOUR);
    const first = await all();
    expect(first).toMatchObject({ settled: 2, resolved: 4, conditionUnmet: 1, expired: 1, refused: 0 });
    expect([await k.status(taken.plain), await k.status(taken.conditional), await k.status(declined.conditional), await k.status(forecast), await k.status(lapsed)])
      .toEqual(['resolved', 'resolved', 'condition_unmet', 'resolved', 'expired']);
    const after = await ledger();
    const second = await all();
    expect(second).toMatchObject({ settled: 0, resolved: 0, conditionUnmet: 0, expired: 0, refused: 0 });
    expect(await ledger()).toBe(after);
    // And a third, a moment later.
    expect(await all()).toEqual(second);
    expect(await ledger()).toBe(after);
  });

  it('one audit entry per sweep, with counts and switches only: no id, no key, no number a series took', async () => {
    const before = (await k.sweepAudits()).length;
    const series = await k.onSeries({ unit: 'usd', sensitivity: 'financial', key: `daily.spend.${id('v')}.usd` });
    const at = dayStart(1);
    await k.point(series, at, CANARY);
    const p = await k.range(series, at, { pointEstimate: CANARY, lower: 1, upper: 99999 }, { madeAgo: Date.now() - at.getTime() - HOUR, dueAgo: MIN });
    const said: string[] = [];
    const c = await all({ tiers: { resolve: 'approval', expire: 'alone' }, log: (m) => void said.push(m) });
    expect(c.resolved).toBe(1);
    expect(await k.resolution(p)).toMatchObject({ outcomeValue: CANARY });
    const audits = await k.sweepAudits();
    expect(audits.length).toBe(before + 1);
    const a = audits[0];
    expect(a).toMatchObject({ actor: 'runtime:ledger', context: 'autonomous', kind: 'action', action: 'ledger.sweep', outcome: 'ok', reasoning: null, outcomeDetail: null, correlationId: null });
    expect(a.inputs).toEqual({
      settled: 0, resolved: 1, conditionUnmet: 0, expired: 0, unknownSpec: c.unknownSpec, waiting: c.waiting, others: c.others, refused: 0, capped: false,
      resolveRan: true, expireRan: true, resolveTier: 'approval', expireTier: 'alone',
    });
    expect(JSON.stringify(a)).not.toMatch(/31337|4242|daily\.spend|\bpd[a-z0-9]{8}/);
    expect(said).toEqual([]);
  });

  it('a write the database refuses is counted and left, and the sweep goes on; the log has its class and the prediction\'s id, never the row', async () => {
    // With the sweep's clock a day ahead, today's step looks over; the database's own clock says the event has not happened.
    const series = await k.onSeries({ unit: 'usd', sensitivity: 'financial', key: `daily.spend.${id('v')}.usd` });
    await k.point(series, dayStart(0), CANARY);
    const early = await k.range(series, dayStart(0), { pointEstimate: CANARY, lower: 1, upper: 99999 }, { madeAgo: 2 * MIN, dueAgo: MIN });
    const fine = await k.onSeries();
    await k.point(fine, dayStart(1), 5);
    const ok = await k.range(fine, dayStart(1), {}, { madeAgo: Date.now() - dayStart(1).getTime() - HOUR, dueAgo: MIN / 2 });
    const said: string[] = [];
    const c = await sweep(k.db, { tz: TZ, resolve: true, expire: false, now: new Date(Date.now() + DAY), log: (m) => void said.push(m) });
    expect(c).toMatchObject({ resolved: 1, refused: 1 });
    expect(await k.resolution(early)).toBeUndefined();
    expect(await k.status(early)).toBe('open');
    expect(await k.resolution(ok)).toMatchObject({ outcomeValue: 5 });
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(new RegExp(`^ledger: prediction ${early} was not settled: PrismaClient[A-Za-z]+( [A-Z0-9_]+)*$`));
    expect(said[0]).toContain('23514');
    expect(said.join(' ')).not.toMatch(/31337|4242|daily\.spend|event|future/);
    expect((await k.sweepAudits())[0].inputs).toMatchObject({ refused: 1, resolved: 1 });
  });

  it('each part runs only when its action may: resolving off writes no resolution, expiring off lets nothing run out', async () => {
    const key = k.serviceKey();
    const eid = await k.service(key, { running: true, disabled: false }, ago(6 * HOUR));
    await k.service(key, { running: true, disabled: false, lastExit: 0 }, ago(5 * MIN));
    const settleable = await k.prediction({ resolverSpec: { entityId: eid, check: 'healthy', at: 'resolveBy' } }, { madeAgo: 3 * HOUR, dueAgo: HOUR });
    const lapsed = await waiting(80 * HOUR);
    const willLapsed = await wills(20 * DAY, 15 * DAY);
    expect(await sweep(k.db, { tz: TZ, resolve: false, expire: false })).toMatchObject({ resolved: 0, expired: 0, settled: 0, waiting: 0, unknownSpec: 0 });
    expect([await k.status(settleable), await k.status(lapsed), await k.status(willLapsed)]).toEqual(['open', 'open', 'open']);
    expect((await k.sweepAudits())[0].inputs).toMatchObject({ resolveRan: false, expireRan: false });
    // Resolving only.
    expect(await sweep(k.db, { tz: TZ, resolve: true, expire: false })).toMatchObject({ resolved: 1, expired: 0 });
    expect([await k.status(settleable), await k.status(lapsed), await k.status(willLapsed)]).toEqual(['resolved', 'open', 'open']);
    // Expiring only: what cannot be settled any more runs out, Will's and the rest.
    const another = await k.prediction({ resolverSpec: { entityId: eid, check: 'healthy', at: 'resolveBy' } }, { madeAgo: 3 * HOUR, dueAgo: HOUR });
    expect(await sweep(k.db, { tz: TZ, resolve: false, expire: true })).toMatchObject({ resolved: 0, expired: 2 });
    expect([await k.status(lapsed), await k.status(willLapsed), await k.status(another)]).toEqual(['expired', 'expired', 'open']);
    expect(await k.resolution(another)).toBeUndefined();
  });

  it('a sweep that stopped at its limit lets what it tried run out, and nothing it did not: a head that can never be settled makes way', async () => {
    // The three oldest due rows can never be settled, and the limit is three: before this, every sweep read the same three and nothing behind them.
    const stuck = [await waiting(100 * HOUR), await waiting(99 * HOUR), await waiting(98 * HOUR)];
    // Behind them: one past its grace that this sweep does not reach, one that can be settled, and one of Will's he was asked about 15 days ago.
    const later = await waiting(80 * HOUR);
    const behind = await k.prediction({ resolverSpec: { entityId: await running(), check: 'healthy', at: 'resolveBy' } }, { madeAgo: 3 * HOUR, dueAgo: HOUR });
    const will = await wills(20 * DAY, 15 * DAY);
    const capped = await all({ limit: 3 });
    expect(capped).toMatchObject({ capped: true, waiting: 3, resolved: 0, expired: 4, refused: 0 });
    for (const p of stuck) expect(await k.status(p), p).toBe('expired');
    expect(await k.status(will)).toBe('expired');
    // Past its 72 hours, but the sweep stopped before it: nothing runs out that was not tried first.
    expect([await k.status(later), await k.status(behind)]).toEqual(['open', 'open']);
    expect((await k.sweepAudits())[0].inputs).toMatchObject({ capped: true, expired: 4 });
    // The head is gone, so the next sweep reaches what was behind it.
    const whole = await all();
    expect(whole).toMatchObject({ capped: false, expired: 1, refused: 0 });
    expect([await k.status(later), await k.status(behind)]).toEqual(['expired', 'resolved']);
  });

  it('more than a page of due rows: each is read once, at one instant or a millisecond apart', async () => {
    const eid = await running();
    const base = await all({ expire: false });
    const apart = await k.bulk(450, { dueAgo: HOUR, entityId: eid });
    const together = await k.bulk(250, { dueAgo: 2 * HOUR, entityId: eid, sameInstant: true });
    const stuck = await k.bulk(450, { dueAgo: 3 * HOUR, entityId: stale, sameInstant: true });
    const c = await all({ expire: false });
    expect(c).toMatchObject({ resolved: 700, waiting: base.waiting + 450, refused: 0, capped: false });
    const written = (await k.owner(`SELECT count(*)::int AS n, count(DISTINCT "predictionId")::int AS d FROM "Resolution" WHERE "predictionId" LIKE $1 || '%' OR "predictionId" LIKE $2 || '%'`, [apart, together])).rows[0];
    expect(written).toEqual({ n: 700, d: 700 });
    expect((await k.owner(`SELECT count(*)::int AS n FROM "Resolution" WHERE "predictionId" LIKE $1 || '%'`, [stuck])).rows[0].n).toBe(0);
    expect(await all({ expire: false })).toMatchObject({ resolved: 0, waiting: base.waiting + 450, refused: 0 });
    // Out of the way of the tests below.
    await k.owner(`UPDATE "Prediction" SET status = 'expired' WHERE id LIKE $1 || '%'`, [stuck]);
  });

  it('one sweep at a time: one that starts while another holds the lock does nothing and writes nothing', async () => {
    const eid = await running();
    const p = await k.prediction({ resolverSpec: { entityId: eid, check: 'healthy', at: 'resolveBy' } }, { madeAgo: 3 * HOUR, dueAgo: HOUR });
    const audits = (await k.sweepAudits()).length;
    const said: string[] = [];
    // Another session holds the sweep's lock, as a sweep that is still running would.
    await withClient(urls.owner, async (c) => {
      await c.query('BEGIN');
      await c.query(`SELECT pg_advisory_xact_lock($1::int)`, [SWEEP_LOCK]);
      const busy = await all({ log: (m) => void said.push(m) });
      expect(busy).toEqual({ settled: 0, resolved: 0, conditionUnmet: 0, expired: 0, unknownSpec: 0, waiting: 0, others: 0, refused: 0, capped: false, busy: true });
      await c.query('ROLLBACK');
    });
    expect([await k.status(p), (await k.sweepAudits()).length, said]).toEqual(['open', audits, []]);
    // Three at once over the same rows: every prediction is settled once, nothing is refused, and each sweep that ran wrote one entry.
    const more = await k.bulk(60, { dueAgo: HOUR, entityId: eid });
    const goal = await g.activeGoal();
    const forecast = await k.prediction({ method: 'rule', domain: 'goals', type: 'deadline_met', createdBy: 'runtime:goals', goalId: goal.id, resolverSpec: { goalId: goal.id, rule: 'goal_done_by' } }, { madeAgo: 2 * DAY, dueAgo: HOUR });
    const runs = await Promise.all([1, 2, 3].map(() => all({ log: (m) => void said.push(m) })));
    expect(runs.reduce((t, r) => t + r.refused, 0)).toBe(0);
    expect(runs.reduce((t, r) => t + r.resolved, 0)).toBe(62);
    expect(said).toEqual([]);
    expect((await k.owner(`SELECT count(*)::int AS n FROM (SELECT "predictionId" FROM "Resolution" GROUP BY 1 HAVING count(*) > 1) x`)).rows[0].n).toBe(0);
    expect((await k.owner(`SELECT count(*)::int AS n FROM "Resolution" WHERE "predictionId" LIKE $1 || '%' OR "predictionId" = ANY ($2)`, [more, [p, forecast]])).rows[0].n).toBe(62);
    expect((await k.sweepAudits()).length).toBe(audits + runs.filter((r) => !r.busy).length);
    expect(runs.filter((r) => !r.busy).length).toBeGreaterThanOrEqual(1);
  });

  it('a write the database refuses is taken back whole, and what the sweep counted is what stands: nothing it wrote survives a refusal, and nothing it kept is uncounted', async () => {
    // A recommendation the database will not let be decided (its decision's time is refused), beside one that is fine.
    const eid = await running();
    const fine = await k.escalated(eid, { status: 'dismissed' });
    const bad = await k.escalated(eid, { status: 'dismissed' });
    await k.owner(`CREATE FUNCTION _refuse_one() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id = TG_ARGV[0] THEN RAISE EXCEPTION 'injected refusal' USING ERRCODE = 'check_violation'; END IF; RETURN NEW; END $$`);
    // The refusal lands on the SECOND write of that row's pair: its prediction. The first (the decision) must be taken back with it.
    await k.owner(`CREATE TRIGGER "_refuse_one" BEFORE UPDATE ON "Prediction" FOR EACH ROW EXECUTE FUNCTION _refuse_one('${bad.conditional}')`);
    const said: string[] = [];
    try {
      const c = await all({ expire: false, log: (m) => void said.push(m) });
      expect(c).toMatchObject({ settled: 1, conditionUnmet: 1, refused: 1 });
      const rec = async (rid: string) => (await k.owner(`SELECT status, "decidedAt" FROM "Recommendation" WHERE id = $1`, [rid])).rows[0];
      expect(await rec(fine.recommendationId)).toMatchObject({ status: 'rejected' });
      expect(await rec(bad.recommendationId)).toEqual({ status: 'proposed', decidedAt: null });
      expect([await k.status(fine.conditional), await k.status(bad.conditional)]).toEqual(['condition_unmet', 'open']);
      expect(said).toHaveLength(1);
      expect(said[0]).toMatch(new RegExp(`^ledger: recommendation ${bad.recommendationId} was not decided: `));
      expect(said[0]).not.toContain('injected');
      // The entry and the rows are one transaction: its counts are the rows that stand.
      expect((await k.sweepAudits())[0].inputs).toMatchObject({ settled: 1, conditionUnmet: 1, refused: 1 });
    } finally {
      await k.owner(`DROP TRIGGER IF EXISTS "_refuse_one" ON "Prediction"`);
      await k.owner(`DROP FUNCTION IF EXISTS _refuse_one()`);
    }
    // With the fault gone, the next sweep decides it.
    expect(await all({ expire: false })).toMatchObject({ settled: 1, conditionUnmet: 1, refused: 0 });
  });

  it('a sweep that dies leaves nothing: no row changed and no entry, and its retry does the whole of it', async () => {
    const eid = await running();
    const p = await k.prediction({ resolverSpec: { entityId: eid, check: 'healthy', at: 'resolveBy' } }, { madeAgo: 3 * HOUR, dueAgo: HOUR });
    const audits = (await k.sweepAudits()).length;
    // The audit entry is refused (an entry stamped a year ahead is): the sweep fails at its last step, after its rows.
    await k.owner(`CREATE FUNCTION _refuse_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'ledger.sweep' THEN RAISE EXCEPTION 'injected refusal' USING ERRCODE = 'check_violation'; END IF; RETURN NEW; END $$`);
    await k.owner(`CREATE TRIGGER "_refuse_audit" BEFORE INSERT ON "AuditEntry" FOR EACH ROW EXECUTE FUNCTION _refuse_audit()`);
    try {
      await expect(all({ expire: false })).rejects.toThrow();
    } finally {
      await k.owner(`DROP TRIGGER IF EXISTS "_refuse_audit" ON "AuditEntry"`);
      await k.owner(`DROP FUNCTION IF EXISTS _refuse_audit()`);
    }
    expect([await k.status(p), await k.resolution(p), (await k.sweepAudits()).length]).toEqual(['open', undefined, audits]);
    const again = await all({ expire: false });
    expect(again).toMatchObject({ resolved: 1, refused: 0 });
    expect((await k.sweepAudits())[0].inputs).toMatchObject({ resolved: 1 });
    expect(await k.status(p)).toBe('resolved');
  });

  it('in a zone that is not UTC, a daily number\'s step is that zone\'s day: settled at the local midnight that ends it', async () => {
    const zone = 'America/Chicago';
    const day = addLocalDays(localDay(zone, new Date()), -1);
    const { start, end } = localDayBounds(zone, day);
    // Not a UTC midnight: the zone's.
    expect(start.getUTCHours()).not.toBe(0);
    const series = await k.onSeries();
    await k.point(series, start, 5);
    const p = await k.range(series, start, {}, { madeAgo: Date.now() - start.getTime() + HOUR, dueAgo: MIN });
    const q = await k.question(series, start, 'above', 4, {}, { madeAgo: Date.now() - start.getTime() + HOUR, dueAgo: MIN });
    const c = await sweep(k.db, { tz: zone, resolve: true, expire: false });
    expect(c.refused).toBe(0);
    expect(await k.resolution(p)).toMatchObject({ outcomeValue: 5, resolvedBy: 'auto_metric' });
    expect(await k.resolution(q)).toMatchObject({ outcome: true, resolvedBy: 'auto_metric' });
    for (const x of [p, q]) expect((await k.resolution(x))!.eventAt.getTime(), x).toBe(end.getTime());
  });

  describe('the jobs', () => {
    const said: string[] = [];
    const ctx = (over: Partial<Config> = {}): JobContext => ({
      db: k.db, bus: {} as Bus, sources: [], log: (m) => void said.push(m),
      config: { predict: true, triage: false, planner: false, tz: TZ, home: '/nonexistent-home-for-tests', ...over } as Config,
    });
    const handler = (queue: string, c = ctx()) => predictJobs(c).find((s) => s.queue === queue)!.handler([]);
    const snapshots = async () => (await k.owner(`SELECT count(*)::int AS n FROM "CalibrationSnapshot"`)).rows[0].n as number;
    const snapshotAudits = async () => (await k.owner(`SELECT inputs, tier, outcome FROM "AuditEntry" WHERE action = 'ledger.calibration.snapshot' ORDER BY seq DESC`)).rows;

    it('exist only while FLINT_PREDICT is on, in the night\'s order: numbers 03:30, the sweep hourly at :40, scores 03:45, forecasts 03:50', () => {
      expect(predictJobs(ctx({ predict: false }))).toEqual([]);
      const specs = predictJobs(ctx());
      expect(specs.map((s) => [s.queue, s.cron, s.missed])).toEqual([
        ['forecast.series', '30 3 * * *', 'once'], ['forecast.run', '50 3 * * *', 'once'],
        // Part 5: the local model's second opinion has no schedule. The forecast job sends one for a run, and only for a
        // number whose Second Opinion switch Will signed: with none, this worker is never handed anything.
        ['forecast.reason', undefined, undefined],
        ['ledger.sweep', '40 * * * *', undefined], ['ledger.snapshot', '45 3 * * *', 'once'],
        // Part 4: the day's questions for Will, picked in the morning, ahead of the 07:30 digest.
        ['ledger.ask', '20 7 * * *', 'once'],
      ]);
      expect([SERIES_CRON, SWEEP_CRON, SNAPSHOT_CRON, FORECAST_CRON]).toEqual(['30 3 * * *', '40 * * * *', '45 3 * * *', '50 3 * * *']);
      for (const s of specs) expect(ALL_QUEUES, s.queue).toContain(s.queue);
      // They are part of the runtime's job set only when on.
      const queues = (c: JobContext) => jobSpecs(c).map((s) => s.queue);
      const four = ['forecast.series', 'forecast.run', 'forecast.reason', 'ledger.sweep', 'ledger.snapshot', 'ledger.ask'];
      expect(queues(ctx())).toEqual(expect.arrayContaining(four));
      for (const q of four) expect(queues(ctx({ predict: false })), q).not.toContain(q);
      // Yesterday's numbers, then the sweep that settles what they decide, then the scores, then today's forecasts.
      const minute = (cron: string) => Number(cron.split(' ')[0]);
      expect([minute(SERIES_CRON), minute(SWEEP_CRON), minute(SNAPSHOT_CRON), minute(FORECAST_CRON)]).toEqual([30, 40, 45, 50]);
    });

    it('do nothing until Will has turned a number on: with the switch on and no signed card, nothing is settled, run out or scored', async () => {
      // A database where no number was ever turned on (this file turned some on above: a fresh one, kept for the next test).
      await k.db.$disconnect();
      const fresh = await ledgerKit(await freshDb());
      k = fresh;
      {
        expect(await predictionsStarted(fresh.db)).toBe(false);
        const eid = await fresh.service(fresh.serviceKey(), { running: true, disabled: false }, ago(6 * HOUR));
        await fresh.service((await fresh.db.entity.findUniqueOrThrow({ where: { id: eid } })).key, { running: true, disabled: false, lastExit: 0 }, ago(5 * MIN));
        const due = await fresh.prediction({ resolverSpec: { entityId: eid, check: 'healthy', at: 'resolveBy' } }, { madeAgo: 3 * HOUR, dueAgo: HOUR });
        // One of Will's own, long past its date, that he was never asked about; and one nothing can settle, past its 72 hours.
        const wills = await fresh.prediction({ method: 'model_reasoning', resolver: 'will', createdBy: 'client:server' }, { madeAgo: 20 * DAY, dueAgo: 15 * DAY });
        const unseen = await fresh.service(fresh.serviceKey(), { running: true, disabled: false }, ago(40 * DAY));
        const lapsed = await fresh.prediction({ resolverSpec: { entityId: unseen, check: 'healthy', at: 'resolveBy' } }, { madeAgo: 5 * DAY, dueAgo: 80 * HOUR });
        said.length = 0;
        for (const queue of ['forecast.series', 'ledger.sweep', 'ledger.snapshot', 'forecast.run']) await handler(queue);
        expect((await fresh.owner(`SELECT count(*)::int AS n FROM "AuditEntry" WHERE action LIKE 'forecast.%' OR action LIKE 'ledger.%'`)).rows[0].n).toBe(0);
        expect((await fresh.owner(`SELECT (SELECT count(*) FROM "ForecastRun")::int + (SELECT count(*) FROM "MetricPoint")::int AS n`)).rows[0].n).toBe(0);
        expect([await fresh.status(due), await fresh.status(lapsed), await fresh.status(wills)]).toEqual(['open', 'open', 'open']);
        expect(await fresh.resolution(due)).toBeUndefined();
        expect(await fresh.sweepAudits()).toEqual([]);
        expect(await snapshotAudits()).toEqual([]);
        expect(await snapshots()).toBe(0);
        expect(said).toEqual([]);
        // Will signs the card (here: a number turned on the way the card turns it on). Now the same jobs do their work.
        const series = await fresh.onSeries();
        expect(await predictionsStarted(fresh.db)).toBe(true);
        await handler('ledger.sweep');
        // The first sweep checks what Flint had already predicted. Will's own old one is not run out: he has not been asked.
        expect([await fresh.status(due), await fresh.status(lapsed), await fresh.status(wills)]).toEqual(['resolved', 'expired', 'open']);
        expect((await fresh.sweepAudits())[0].inputs).toMatchObject({ resolved: 1, expired: 1, resolveRan: true, expireRan: true, resolveTier: 'approval', expireTier: 'approval' });
        await handler('ledger.snapshot');
        expect((await snapshotAudits())[0]).toMatchObject({ tier: 'approval', outcome: 'ok', inputs: { windowDays: 90 } });
        expect(said.join('\n')).toMatch(/^ledger: 1 resolved, 1 expired, 0 condition unmet; 0 with a rule no resolver knows, 0 refused, \d+ waiting$/m);
        expect(said.join('\n')).not.toMatch(/31337|service:|\bpd[a-z0-9]{8}/);
        // Turned off again: what Flint already predicted is still checked.
        await fresh.inTx((q) => q(`UPDATE "ForecastSeries" SET "on" = false WHERE "seriesKey" = $1`, [series]), { actor: 'will:console' });
        expect(await predictionsStarted(fresh.db)).toBe(true);
        const next = await fresh.prediction({ resolverSpec: { entityId: eid, check: 'healthy', at: 'resolveBy' } }, { madeAgo: 3 * HOUR, dueAgo: HOUR });
        await handler('ledger.sweep');
        expect(await fresh.status(next)).toBe('resolved');
      }
    });

    it('a rule that forbids an action stops that part, and both stop the job; the scores are not written when their action is forbidden', async () => {
      // (The fresh database from the test above: a number is on, a signing key is enrolled here.)
      const fx = await goalFixture(urls, k.db);
      const eid = await k.service(k.serviceKey(), { running: true, disabled: false }, ago(6 * HOUR));
      await k.service((await k.db.entity.findUniqueOrThrow({ where: { id: eid } })).key, { running: true, disabled: false, lastExit: 0 }, ago(5 * MIN));
      const due = () => k.prediction({ resolverSpec: { entityId: eid, check: 'healthy', at: 'resolveBy' } }, { madeAgo: 3 * HOUR, dueAgo: HOUR });
      await fx.policy('ledger.expire', 'forbidden');
      const lapsed = await k.prediction({ method: 'model_reasoning', resolver: 'will', createdBy: 'client:server' }, { madeAgo: 20 * DAY, dueAgo: 15 * DAY });
      await k.asked(lapsed, 15 * DAY);
      const first = await due();
      await handler('ledger.sweep');
      expect([await k.status(first), await k.status(lapsed)]).toEqual(['resolved', 'open']);
      expect((await k.sweepAudits())[0].inputs).toMatchObject({ resolveRan: true, expireRan: false, resolveTier: 'approval', expireTier: 'forbidden' });
      await fx.policy('ledger.resolve.auto', 'forbidden');
      const audits = (await k.sweepAudits()).length;
      const second = await due();
      await handler('ledger.sweep');
      expect([await k.status(second), await k.status(lapsed)]).toEqual(['open', 'open']);
      expect((await k.sweepAudits()).length).toBe(audits);
      await fx.policy('ledger.calibration.snapshot', 'forbidden');
      const scored = (await snapshotAudits()).length;
      await handler('ledger.snapshot');
      expect((await snapshotAudits()).length).toBe(scored);
    });
  });
});
