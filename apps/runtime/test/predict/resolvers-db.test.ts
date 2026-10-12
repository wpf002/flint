/**
 * How Flint settles its own predictions without Will (P4 part 2), on
 * flint_test: each resolver against rows as a source, the forecaster, triage
 * and a goal review write them.
 *
 *  - The world is read as it stood at the resolve time: the version valid then
 *    decides (validFrom), whenever it was recorded and whatever the item says
 *    now; nothing is settled until the item has been seen again; a forgotten
 *    item settles nothing.
 *  - A forecast is settled by its series' own number for that step, once the
 *    step is over and the number is there.
 *  - A prediction about advice goes to condition-unmet when the advice was
 *    declined or lapsed, and is settled as its own claim when it was taken.
 *  - A goal's forecast that reaches its date with the goal unfinished is false;
 *    a finished goal's forecasts are its card's.
 *  - Superseded predictions are settled too. The time on a resolution is the
 *    time the claim is about.
 *  - Whose a prediction is: one with no rule, or a rule that does not fit its
 *    own row, is the sweep's to count and let run out; one that carries a rule
 *    the sweep does not know, or hangs on another module's advice, is that
 *    module's and is left alone.
 *  - A row that states triage's first rule ("when it is next observed after
 *    the resolve time") is settled by that rule where the rows can tell, and
 *    left to run out where they cannot.
 *  - Rows written by the real writers (triage's, a goal review's) go through
 *    the resolvers as they are.
 *  - Nothing here is ever recorded as Will's, and Will's own are never touched.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NO_DB, freshDb, id, HEX, type TestUrls } from '../db';
import { CANARY, DAY, HOUR, MIN, TZ, dayStart, ledgerKit, type LedgerKit } from '../ledger/kit';
import { goalFixture, type GoalFixture } from '../goals/fixture';
import { recordOnTrack } from '../../src/goals/ontrack';
import { sweep } from '../../src/ledger/sweep';
import { NEXT_OBSERVED_CRITERIA, ResolverSpec, decisionOf, healthyState, ruleOwner, stepEnd, verdictFor, type DuePrediction } from '../../src/predict/resolvers';

describe.skipIf(NO_DB)('resolvers on flint_test', () => {
  let urls: TestUrls;
  let k: LedgerKit;
  let g: GoalFixture;
  const ago = (ms: number) => new Date(Date.now() - ms);
  const run = () => sweep(k.db, { tz: TZ, resolve: true, expire: false });
  /**
   * What earlier tests left that can never be settled (they wait, or carry a rule nobody knows): a sweep with nothing
   * new to do reads exactly those again. Each test counts from here.
   */
  const leftovers = async () => {
    const c = await run();
    expect(c).toMatchObject({ resolved: 0, conditionUnmet: 0, settled: 0, refused: 0 });
    return c;
  };
  /** The prediction as the sweep reads it, and what its resolver says, with nothing written. */
  async function verdict(pid: string, now = new Date()) {
    const p: DuePrediction = await k.due(pid);
    return k.db.$transaction((tx) => verdictFor(tx, p, { tz: TZ, now }));
  }

  beforeAll(async () => {
    urls = await freshDb();
    k = await ledgerKit(urls);
    g = await goalFixture(urls, k.db);
  });
  afterAll(async () => k?.db.$disconnect());

  describe('the world, as it stood at the resolve time', () => {
    it('the version valid at the resolve time decides: not when it was recorded, and not what the item says now', async () => {
      // Running five hours ago; down from two hours ago; running again ten minutes ago. Every version is recorded now.
      const key = k.serviceKey();
      const eid = await k.service(key, { running: true, disabled: false }, ago(5 * HOUR));
      await k.service(key, { running: false, disabled: false }, ago(2 * HOUR));
      await k.service(key, { running: true, disabled: false }, ago(10 * MIN));
      // Made three hours ago about "healthy an hour ago". An hour ago it was down.
      const p = await k.prediction({ probability: 0.4, resolverSpec: { entityId: eid, check: 'healthy', at: 'resolveBy' }, subjectEntityId: eid }, { madeAgo: 3 * HOUR, dueAgo: HOUR });
      const due = (await k.owner(`SELECT "resolveBy" FROM "Prediction" WHERE id = $1`, [p])).rows[0].resolveBy as Date;
      const versions = (await k.owner(`SELECT id, version, "validFrom", "recordedAt" FROM "EntityVersion" WHERE "entityId" = $1 ORDER BY version`, [eid])).rows;
      expect(versions.map((v) => v.version)).toEqual([1, 2, 3]);
      // Each was recorded after the resolve time, and the row as it is now says running.
      for (const v of versions) expect(v.recordedAt.getTime()).toBeGreaterThan(due.getTime());
      expect((await k.db.entity.findUniqueOrThrow({ where: { id: eid } })).state).toMatchObject({ running: true });
      const before = Date.now();
      expect(await run()).toMatchObject({ resolved: 1, waiting: 0, unknownSpec: 0, refused: 0 });
      expect(await leftovers()).toMatchObject({ waiting: 0, unknownSpec: 0 });
      const r = (await k.resolution(p))!;
      expect(r).toMatchObject({ outcome: false, outcomeValue: null, resolvedBy: 'auto_world', evidence: { rule: 'healthy_at', entityId: eid, versionId: versions[1].id, via: 'ledger.sweep' } });
      // The event is the time the claim is about, not the time the sweep ran.
      expect(r.eventAt.getTime()).toBe(due.getTime());
      expect(r.resolvedAt.getTime()).toBeGreaterThanOrEqual(before - 5);
      expect(r.brier).toBeCloseTo(0.16, 12);
      expect(await k.status(p)).toBe('resolved');
    });

    it('healthy at the resolve time and down now is still true; a health check that says anything but ok is not healthy', async () => {
      const key = k.serviceKey();
      const eid = await k.service(key, { running: true, disabled: false }, ago(5 * HOUR));
      await k.service(key, { running: false, disabled: false }, ago(20 * MIN));
      const p = await k.prediction({ resolverSpec: { entityId: eid, check: 'healthy', at: 'resolveBy' } }, { madeAgo: 3 * HOUR, dueAgo: HOUR });
      await run();
      expect(await k.resolution(p)).toMatchObject({ outcome: true, resolvedBy: 'auto_world' });
      // An endpoint's health decides before `running` does; unknown and degraded are not healthy.
      for (const [health, outcome] of [['ok', true], ['degraded', false], ['down', false], ['unknown', false]] as const) {
        const ek = `service:endpoint:test-${id('e').slice(-8)}`;
        const e = await k.service(ek, { managedBy: 'other', health }, ago(4 * HOUR));
        await k.service(ek, { managedBy: 'other', health: health === 'ok' ? 'down' : 'ok' }, ago(5 * MIN));
        const q = await k.prediction({ resolverSpec: { entityId: e, check: 'healthy', at: 'resolveBy' } }, { madeAgo: 3 * HOUR, dueAgo: HOUR });
        await run();
        expect((await k.resolution(q))?.outcome, health).toBe(outcome);
      }
      expect([healthyState({ health: 'ok', running: false }), healthyState({ running: true }), healthyState({ running: false }), healthyState({ managedBy: 'launchd' }), healthyState(null), healthyState([])])
        .toEqual([true, true, false, undefined, undefined, undefined]);
    });

    it('nothing is settled until the item has been seen again after the resolve time: stale news settles nothing', async () => {
      const key = k.serviceKey();
      const eid = await k.service(key, { running: true, disabled: false }, ago(5 * HOUR));
      const left = await leftovers();
      const p = await k.prediction({ resolverSpec: { entityId: eid, check: 'healthy', at: 'resolveBy' } }, { madeAgo: 3 * HOUR, dueAgo: HOUR });
      expect(await verdict(p)).toEqual({ verdict: 'wait', why: 'not_seen_since' });
      expect(await run()).toMatchObject({ resolved: 0, waiting: left.waiting + 1 });
      expect(await k.resolution(p)).toBeUndefined();
      expect(await k.status(p)).toBe('open');
      // The source reads it again, unchanged: no new version, and now Flint knows it was still running then.
      await k.service(key, { running: true, disabled: false }, ago(MIN));
      expect((await k.owner(`SELECT count(*)::int AS n FROM "EntityVersion" WHERE "entityId" = $1`, [eid])).rows[0].n).toBe(1);
      expect(await run()).toMatchObject({ resolved: 1, waiting: left.waiting });
      expect(await k.resolution(p)).toMatchObject({ outcome: true });
    });

    it('a forgotten item settles nothing, and is no fault to report; neither does a state that says neither way, or an item first seen after the resolve time', async () => {
      const key = k.serviceKey();
      const eid = await k.service(key, { running: true, disabled: false }, ago(5 * HOUR));
      await k.service(key, { running: false, disabled: false }, ago(10 * MIN));
      // One prediction is about the item (the forget blanks it); one only names it in its rule.
      const left = await leftovers();
      const about = await k.prediction({ resolverSpec: { entityId: eid, check: 'healthy', at: 'resolveBy' }, subjectEntityId: eid }, { madeAgo: 3 * HOUR, dueAgo: HOUR });
      const names = await k.prediction({ resolverSpec: { entityId: eid, check: 'healthy', at: 'resolveBy' } }, { madeAgo: 3 * HOUR, dueAgo: HOUR });
      await k.forget(eid);
      expect((await k.owner(`SELECT claim, "resolverSpec" FROM "Prediction" WHERE id = $1`, [about])).rows[0]).toEqual({ claim: '[forgotten]', resolverSpec: null });
      // The forget took the first one's rule away with its words. That is Will's doing, not a prediction Flint cannot
      // check: both wait as unknowable (and run out quietly), and neither is counted as a rule nobody knows.
      expect(await k.due(about)).toMatchObject({ forgotten: true, resolverSpec: null });
      expect(await verdict(about)).toEqual({ verdict: 'wait', why: 'unknowable' });
      expect(await verdict(names)).toEqual({ verdict: 'wait', why: 'unknowable' });
      expect(await run()).toMatchObject({ resolved: 0, unknownSpec: left.unknownSpec, waiting: left.waiting + 2 });
      for (const p of [about, names]) expect(await k.resolution(p), p).toBeUndefined();
      // A state with no health check and no running flag says neither way.
      const bare = k.serviceKey();
      const b = await k.service(bare, {}, ago(5 * HOUR));
      await k.service(bare, { loaded: true }, ago(5 * MIN));
      const q = await k.prediction({ resolverSpec: { entityId: b, check: 'healthy', at: 'resolveBy' } }, { madeAgo: 3 * HOUR, dueAgo: HOUR });
      expect(await verdict(q)).toEqual({ verdict: 'wait', why: 'unknowable' });
      // An item with no version at or before the resolve time, and one that does not exist.
      const late = await k.service(k.serviceKey(), { running: true, disabled: false }, ago(5 * MIN));
      expect(await verdict(await k.prediction({ resolverSpec: { entityId: late, check: 'healthy', at: 'resolveBy' } }, { madeAgo: 3 * HOUR, dueAgo: HOUR }))).toEqual({ verdict: 'wait', why: 'unknowable' });
      expect(await verdict(await k.prediction({ resolverSpec: { entityId: 'ennosuchitem', check: 'healthy', at: 'resolveBy' } }, { madeAgo: 3 * HOUR, dueAgo: HOUR }))).toEqual({ verdict: 'unknown' });
    });
  });

  describe('a row that states triage\'s first rule: healthy when it is next observed after the resolve time', () => {
    const old = (eid: string) => k.prediction({ resolutionCriteria: NEXT_OBSERVED_CRITERIA, resolverSpec: { entityId: eid, check: 'healthy', at: 'resolveBy' }, subjectEntityId: eid }, { madeAgo: 3 * HOUR, dueAgo: HOUR });
    /** A service seen five hours ago in one state, and again since the resolve time in another (or the same). */
    const seen = async (then: Record<string, unknown>, since: Record<string, unknown>, sinceAgo = 30 * MIN) => {
      const key = k.serviceKey();
      const eid = await k.service(key, then, ago(5 * HOUR));
      await k.service(key, since, ago(sinceAgo));
      return eid;
    };

    it('is settled by its own rule where the rows can tell, and left to run out where they cannot; never by the rule triage writes now', async () => {
      // The sentence is the one main wrote, and triage no longer writes it: a new row never takes the old rule.
      expect(NEXT_OBSERVED_CRITERIA).toBe('The service reports healthy (running, or its health check ok) when it is next observed after the resolve time.');
      expect(readFileSync(join(__dirname, '..', '..', 'src', 'surface', 'record.ts'), 'utf8')).not.toContain('when it is next observed after the resolve time');
      const left = await leftovers();
      // Down at its time and nothing changed since: whichever look came next, it saw the service down. Certain: false.
      const down = await old(await seen({ running: false, disabled: false }, { running: false, disabled: false }));
      // Healthy at its time, and healthy in the next version too (another field changed): certain: true.
      const up = await old(await seen({ running: true, disabled: false }, { running: true, disabled: false, lastExit: 0 }));
      // Down at its time, healthy in the next version. The first look after the resolve time may have been the one that
      // saw it come back (the row's rule says true) or an earlier one that saw it still down (false). Flint keeps no
      // list of its looks, so the rows cannot tell: it is left to run out, not settled by some other rule.
      const flipped = await seen({ running: false, disabled: false }, { running: true, disabled: false });
      const untold = await old(flipped);
      // The same history under the rule triage writes now (the state at the resolve time): false, and certain.
      const now = await k.prediction({ resolverSpec: { entityId: flipped, check: 'healthy', at: 'resolveBy' }, subjectEntityId: flipped }, { madeAgo: 3 * HOUR, dueAgo: HOUR });
      expect([(await k.due(down)).nextObserved, (await k.due(now)).nextObserved]).toEqual([true, false]);
      expect(await verdict(down)).toMatchObject({ verdict: 'resolve', outcome: false, evidence: { rule: 'healthy_next_observed' } });
      expect(await verdict(up)).toMatchObject({ verdict: 'resolve', outcome: true, evidence: { rule: 'healthy_next_observed' } });
      expect(await verdict(untold)).toEqual({ verdict: 'wait', why: 'unknowable' });
      expect(await verdict(now)).toMatchObject({ verdict: 'resolve', outcome: false, evidence: { rule: 'healthy_at' } });
      expect(await run()).toMatchObject({ resolved: 3, waiting: left.waiting + 1, unknownSpec: left.unknownSpec, refused: 0 });
      expect([await k.status(down), await k.status(up), await k.status(untold), await k.status(now)]).toEqual(['resolved', 'resolved', 'open', 'resolved']);
      expect(await k.resolution(untold)).toBeUndefined();
      // The time on each is the resolve time, as for every other.
      const due = (await k.owner(`SELECT "resolveBy" FROM "Prediction" WHERE id = $1`, [down])).rows[0].resolveBy as Date;
      expect((await k.resolution(down))!.eventAt.getTime()).toBe(due.getTime());
    });

    it('the advice beside it carries the same sentence, and is settled the same way once it was taken', async () => {
      const eid = await seen({ running: false, disabled: false }, { running: false, disabled: false, lastExit: 1 }, 5 * MIN);
      const e = await k.escalated(eid, { status: 'acked', ackedAgo: 2 * HOUR, criteria: NEXT_OBSERVED_CRITERIA });
      expect((await k.due(e.conditional)).nextObserved).toBe(true);
      expect(await run()).toMatchObject({ settled: 1, resolved: 2, refused: 0 });
      for (const p of [e.plain, e.conditional]) expect(await k.resolution(p), p).toMatchObject({ outcome: false, evidence: { rule: 'healthy_next_observed' } });
    });
  });

  describe('a forecast, by its series\' own number', () => {
    it('a range is settled with the number for its step, and a question with whether it was above or below; the event is the end of the step', async () => {
      const key = await k.onSeries({ unit: 'usd', sensitivity: 'financial', key: `daily.spend.${id('v')}.usd` });
      const at = dayStart(1);
      await k.point(key, at, CANARY);
      const made = { madeAgo: Date.now() - at.getTime() - 4 * HOUR, dueAgo: MIN };
      const left = await leftovers();
      const range = await k.range(key, at, { pointEstimate: 30000, lower: 20000, upper: 40000 }, made);
      const above = await k.question(key, at, 'above', 30000, { probability: 0.7 }, made);
      const below = await k.question(key, at, 'below', 30000, { probability: 0.3 }, made);
      expect(await run()).toMatchObject({ resolved: 3, waiting: left.waiting, unknownSpec: left.unknownSpec, refused: 0 });
      const r = (await k.resolution(range))!;
      expect(r).toMatchObject({ outcome: null, outcomeValue: CANARY, resolvedBy: 'auto_metric', brier: null, evidence: { rule: 'metric_range', seriesKey: key, at: at.toISOString(), via: 'ledger.sweep' } });
      // The step is yesterday (UTC): it ended at today's first instant, and that is the event's time.
      expect(r.eventAt.toISOString()).toBe(dayStart(0).toISOString());
      expect(stepEnd(TZ, at, 'D')!.toISOString()).toBe(dayStart(0).toISOString());
      expect(await k.resolution(above)).toMatchObject({ outcome: true, outcomeValue: null, resolvedBy: 'auto_metric', evidence: { rule: 'metric_threshold' } });
      expect((await k.resolution(above))!.brier).toBeCloseTo(0.09, 12);
      expect(await k.resolution(below)).toMatchObject({ outcome: false, resolvedBy: 'auto_metric' });
      // The evidence holds the series' key and the step, never the number.
      for (const p of [range, above, below]) expect(JSON.stringify((await k.resolution(p))!.evidence)).not.toMatch(/31337|4242/);
      // Exactly at the threshold is neither above nor below it.
      const edge = await k.onSeries();
      await k.point(edge, at, 5);
      const on = [await k.question(edge, at, 'above', 5, {}, made), await k.question(edge, at, 'below', 5, {}, made)];
      await run();
      for (const p of on) expect((await k.resolution(p))!.outcome).toBe(false);
    });

    it('it waits for the number, and for the step to be over; a weekly series\' step is seven days', async () => {
      const key = await k.onSeries();
      const yesterday = dayStart(1);
      const made = { madeAgo: Date.now() - yesterday.getTime() - 4 * HOUR, dueAgo: MIN };
      // No number yet for yesterday.
      const left = await leftovers();
      const p = await k.range(key, yesterday, {}, made);
      expect(await verdict(p)).toEqual({ verdict: 'wait', why: 'no_point' });
      expect(await run()).toMatchObject({ resolved: 0, waiting: left.waiting + 1 });
      await k.point(key, yesterday, 5);
      expect(await run()).toMatchObject({ resolved: 1, waiting: left.waiting });
      expect(await k.resolution(p)).toMatchObject({ outcomeValue: 5 });
      // Today's step is not over, even with a number already there and the prediction due.
      const today = dayStart(0);
      await k.point(key, today, 3);
      const early = await k.range(key, today, {}, { madeAgo: 2 * MIN, dueAgo: MIN });
      expect(await verdict(early)).toEqual({ verdict: 'wait', why: 'step_not_over' });
      // A weekly series: the step that began 3 days ago is not over; the one that began 8 days ago ended yesterday.
      const weekly = await k.onSeries({ freq: 'W', key: `weekly.commits.${id('r')}.count` });
      await k.point(weekly, dayStart(3), 2);
      await k.point(weekly, dayStart(8), 9);
      expect(await verdict(await k.range(weekly, dayStart(3), {}, { madeAgo: 3 * DAY, dueAgo: MIN }))).toEqual({ verdict: 'wait', why: 'step_not_over' });
      const week = await k.range(weekly, dayStart(8), {}, { madeAgo: 8 * DAY - HOUR, dueAgo: MIN });
      await run();
      expect(await k.resolution(week)).toMatchObject({ outcomeValue: 9 });
      expect((await k.resolution(week))!.eventAt.toISOString()).toBe(dayStart(1).toISOString());
      expect(stepEnd('America/Chicago', new Date('2026-03-08T06:00:00.000Z'), 'D')!.toISOString()).toBe('2026-03-09T05:00:00.000Z'); // a 23-hour day
      expect(stepEnd(TZ, yesterday, 'raw')).toBeUndefined();
    });

    it('a forgotten series settles nothing, and its number is not copied anywhere', async () => {
      const key = await k.forgottenSeries({ on: true });
      const at = dayStart(1);
      // The number was there before the forget; the forecast was made before it too (a forgotten series gets no new ones).
      await k.past('MetricPoint', 'USER', (q) => q(`INSERT INTO "MetricPoint" ("seriesKey", at, value) VALUES ($1, $2, $3)`, [key, at, CANARY]));
      const p = await k.prediction({
        kind: 'interval', probability: null, method: 'base_rate', domain: 'deploys', type: 'trend', resolver: 'auto_metric', pointEstimate: 4, lower: 2, upper: 6, level: 0.8,
        resolverSpec: { seriesKey: key, at: at.toISOString(), op: 'range' },
      }, { madeAgo: Date.now() - at.getTime() - 4 * HOUR, dueAgo: MIN });
      expect(await verdict(p)).toEqual({ verdict: 'wait', why: 'unknowable' });
      await run();
      expect(await k.resolution(p)).toBeUndefined();
      expect((await k.owner(`SELECT count(*)::int AS n FROM "Resolution" WHERE "outcomeValue" = $1 AND "predictionId" = $2`, [CANARY, p])).rows[0].n).toBe(0);
    });
  });

  describe('advice Will took, declined, or let lapse', () => {
    const downThenUp = async () => {
      const key = k.serviceKey();
      const eid = await k.service(key, { running: false, disabled: false }, ago(6 * HOUR));
      await k.service(key, { running: true, disabled: false }, ago(2 * HOUR));
      await k.service(key, { running: true, disabled: false, lastExit: 0 }, ago(5 * MIN));
      return eid;
    };
    const rec = async (rid: string) => (await k.owner(`SELECT status, "decidedAt", "effectObserved", "outcomeAt" FROM "Recommendation" WHERE id = $1`, [rid])).rows[0];

    it('dismissed: the advice was declined, so what it promised is never scored (condition unmet); the plain prediction still is', async () => {
      const e = await k.escalated(await downThenUp(), { status: 'dismissed' });
      const c = await run();
      expect(c).toMatchObject({ settled: 1, conditionUnmet: 1, resolved: 1, refused: 0 });
      expect(await rec(e.recommendationId)).toMatchObject({ status: 'rejected', effectObserved: null, outcomeAt: null });
      expect(await k.status(e.conditional)).toBe('condition_unmet');
      expect(await k.resolution(e.conditional)).toBeUndefined();
      expect(await k.resolution(e.plain)).toMatchObject({ outcome: true, resolvedBy: 'auto_world' });
      // Declined is declined even when he had acknowledged it first.
      const both = await k.escalated(await downThenUp(), { status: 'dismissed', ackedAgo: 2 * HOUR });
      await run();
      expect((await rec(both.recommendationId)).status).toBe('rejected');
    });

    it('acknowledged before the resolve time: taken up, and settled as its own claim (healthy at the resolve time), with the outcome on the advice', async () => {
      // The escalation itself has lapsed since (they lapse at the resolve time): the acknowledgement still counts.
      const e = await k.escalated(await downThenUp(), { status: 'expired', ackedAgo: 2 * HOUR });
      expect(await run()).toMatchObject({ settled: 1, resolved: 2, conditionUnmet: 0 });
      const r = await rec(e.recommendationId);
      expect(r).toMatchObject({ status: 'accepted', effectObserved: true });
      expect(Math.abs(r.decidedAt.getTime() - (Date.now() - 2 * HOUR))).toBeLessThan(5_000);
      const res = (await k.resolution(e.conditional))!;
      expect(res).toMatchObject({ outcome: true, resolvedBy: 'auto_world', evidence: { rule: 'healthy_at' } });
      expect(res.brier).toBeCloseTo(0.04, 12);
      expect(r.outcomeAt.getTime()).toBe(res.eventAt.getTime());
      expect(await k.status(e.conditional)).toBe('resolved');
      // Taken up, and the service was still down at the resolve time: false.
      const key = k.serviceKey();
      const down = await k.service(key, { running: false, disabled: false }, ago(6 * HOUR));
      await k.service(key, { running: false, disabled: false, lastExit: 1 }, ago(5 * MIN));
      const d = await k.escalated(down, { status: 'acked', ackedAgo: 90 * MIN });
      await run();
      expect(await k.resolution(d.conditional)).toMatchObject({ outcome: false });
      expect(await rec(d.recommendationId)).toMatchObject({ status: 'accepted', effectObserved: false });
    });

    it('left until the resolve time, acknowledged too late, or never shown: lapsed, and condition unmet; still open and not yet due: nothing is decided', async () => {
      for (const [name, o] of [['left open', { status: 'open' }], ['lapsed', { status: 'expired' }], ['acknowledged too late', { status: 'acked', ackedAgo: 10 * MIN }], ['never shown', { escalation: false }]] as const) {
        const e = await k.escalated(await downThenUp(), o);
        await run();
        expect((await rec(e.recommendationId)).status, name).toBe('expired');
        expect(await k.status(e.conditional), name).toBe('condition_unmet');
      }
      // Not due for another hour, and Will has not answered: nothing is decided, and nothing is settled.
      const waiting = await k.escalated(await downThenUp(), { status: 'open', dueAgo: -HOUR });
      await run();
      expect((await rec(waiting.recommendationId)).status).toBe('proposed');
      expect(await k.status(waiting.conditional)).toBe('open');
      // Not due yet, and he dismissed it: declined at once, and its prediction set aside with it, without waiting for the date.
      const early = await k.escalated(await downThenUp(), { status: 'dismissed', dueAgo: -HOUR });
      expect(await run()).toMatchObject({ settled: 1, conditionUnmet: 1 });
      expect((await rec(early.recommendationId)).status).toBe('rejected');
      expect([await k.status(early.conditional), await k.status(early.plain)]).toEqual(['condition_unmet', 'open']);
      expect(decisionOf({ status: 'open', ackedAt: null }, new Date(Date.now() + HOUR), new Date())).toBeUndefined();
      expect(decisionOf(null, new Date(Date.now() + HOUR), new Date())).toBeUndefined();
    });

    it('a decision is made once: a second sweep changes nothing, and advice of a kind no resolver knows is left', async () => {
      const e = await k.escalated(await downThenUp(), { status: 'acked', ackedAgo: 2 * HOUR });
      await run();
      const first = await rec(e.recommendationId);
      expect(await run()).toMatchObject({ settled: 0, resolved: 0, conditionUnmet: 0, refused: 0 });
      expect(await rec(e.recommendationId)).toEqual(first);
      // Taken up, but its template is not one a resolver settles: counted and left.
      const odd = await k.escalated(await downThenUp(), { status: 'acked', ackedAgo: 2 * HOUR, templateId: 'some_other_advice' });
      const c = await run();
      expect(c.unknownSpec).toBeGreaterThanOrEqual(1);
      expect(await k.resolution(odd.conditional)).toBeUndefined();
      expect(await k.status(odd.conditional)).toBe('open');
    });

    it('advice of another type is its own module\'s: never decided here, its prediction never set aside, counted or run out', async () => {
      const left = await leftovers();
      // Dismissed and long past its time: triage's advice would be declined, and its prediction set aside at once.
      const key = k.serviceKey();
      const eid = await k.service(key, { running: true, disabled: false }, ago(6 * DAY));
      await k.service(key, { running: true, disabled: false, lastExit: 0 }, ago(5 * MIN));
      const theirs = await k.escalated(eid, { status: 'dismissed', type: 'plan_change', madeAgo: 5 * DAY, dueAgo: 4 * DAY });
      expect(await k.due(theirs.conditional)).toMatchObject({ recType: 'plan_change', resolver: 'conditional' });
      expect(await verdict(theirs.conditional)).toEqual({ verdict: 'other' });
      const c = await sweep(k.db, { tz: TZ, resolve: true, expire: true });
      expect(c).toMatchObject({ settled: 0, conditionUnmet: 0, unknownSpec: left.unknownSpec, others: left.others + 1, refused: 0 });
      expect(await rec(theirs.recommendationId)).toMatchObject({ status: 'proposed', decidedAt: null, effectObserved: null });
      // Four days past its time, well over the 72 hours: still open, because it is not the sweep's to let run out.
      expect(await k.status(theirs.conditional)).toBe('open');
      expect(await k.resolution(theirs.conditional)).toBeUndefined();
      // The plain prediction beside it carries a rule the sweep knows: settled like any other.
      expect(await k.status(theirs.plain)).toBe('resolved');
    });

    it('acted on counts as taken up, whenever it was', async () => {
      expect(decisionOf({ status: 'acted', ackedAt: null }, ago(HOUR), new Date())).toMatchObject({ status: 'accepted' });
      const at = ago(30 * MIN);
      expect(decisionOf({ status: 'acted', ackedAt: at }, ago(HOUR), new Date())).toEqual({ status: 'accepted', decidedAt: at });
      const e = await k.escalated(await downThenUp(), { status: 'acted' });
      expect(await run()).toMatchObject({ settled: 1, resolved: 2, conditionUnmet: 0, refused: 0 });
      expect(await rec(e.recommendationId)).toMatchObject({ status: 'accepted', effectObserved: true });
      expect([await k.status(e.plain), await k.status(e.conditional)]).toEqual(['resolved', 'resolved']);
    });
  });

  describe('a goal\'s forecast, at its date', () => {
    const forecast = (goalId: string, over: Record<string, unknown> = {}, t: { madeAgo?: number; dueAgo?: number } = {}) =>
      k.prediction({ probability: 0.7, method: 'rule', domain: 'goals', type: 'deadline_met', createdBy: 'runtime:goals', goalId, resolverSpec: { goalId, rule: 'goal_done_by' }, ...over }, t);

    it('the goal is not finished by then: false, as its own words say; the superseded ones too, each at its own date', async () => {
      const goal = await g.activeGoal();
      const first = await forecast(goal.id, {}, { madeAgo: 3 * DAY, dueAgo: 2 * HOUR });
      const second = await forecast(goal.id, { supersedesId: first, probability: 0.5 }, { madeAgo: 2 * DAY, dueAgo: HOUR });
      expect(await k.status(first)).toBe('superseded');
      expect(await run()).toMatchObject({ resolved: 2, refused: 0 });
      for (const [p, brier] of [[first, 0.49], [second, 0.25]] as const) {
        const r = (await k.resolution(p))!;
        expect(r).toMatchObject({ outcome: false, resolvedBy: 'auto_world', evidence: { rule: 'goal_done_by', goalId: goal.id, goalStatus: 'active', via: 'ledger.sweep' } });
        expect(r.brier).toBeCloseTo(brier, 12);
        const due = (await k.owner(`SELECT "resolveBy" FROM "Prediction" WHERE id = $1`, [p])).rows[0].resolveBy as Date;
        expect(r.eventAt.getTime()).toBe(due.getTime());
      }
      // A superseded one stays superseded (it is scored all the same); the open one is resolved.
      expect([await k.status(first), await k.status(second)]).toEqual(['superseded', 'resolved']);
      // The goal's words are nowhere in what the sweep wrote.
      expect(JSON.stringify([await k.resolution(first), await k.sweepAudits()])).not.toContain('CANARY');
    });

    it('a forecast as the goal review itself writes it (ontrack.ts) goes through the resolver as it is, and so does the one it replaced', async () => {
      const goal = await g.activeGoal();
      const write = () => k.db.$transaction((tx) => recordOnTrack(tx, { id: goal.id, activatedAt: ago(9 * DAY), horizonAt: new Date(Date.now() + 30 * DAY) }, { progress: 0.2, overdueSteps: 0, nextReviewAt: new Date(Date.now() + 7 * DAY) }, TZ, new Date()));
      const first = await write();
      const second = await write();
      expect(second.superseded).toBe(true);
      // Their dates come: only the two times move (kit.ts backdate); the rest is the writer's own row.
      await k.backdate(first.id, { madeAgo: 9 * DAY, dueAgo: 2 * HOUR });
      await k.backdate(second.id, { madeAgo: 2 * DAY, dueAgo: HOUR });
      expect(await k.due(first.id)).toMatchObject({ kind: 'binary', resolver: 'auto_world', status: 'superseded', goalId: goal.id, resolverSpec: { goalId: goal.id, rule: 'goal_done_by' }, recType: null, forgotten: false, nextObserved: false });
      expect([ruleOwner(await k.due(first.id)), ruleOwner(await k.due(second.id))]).toEqual(['sweep', 'sweep']);
      expect(await run()).toMatchObject({ resolved: 2, refused: 0 });
      for (const p of [first, second]) {
        expect(await k.resolution(p.id), p.id).toMatchObject({ outcome: false, resolvedBy: 'auto_world', evidence: { rule: 'goal_done_by', goalId: goal.id, goalStatus: 'active', via: 'ledger.sweep' } });
      }
      expect([await k.status(first.id), await k.status(second.id)]).toEqual(['superseded', 'resolved']);
    });

    it('a finished goal\'s forecasts are its card\'s: the sweep leaves them, and the card settles them as Will', async () => {
      const goal = await g.activeGoal();
      const due = await forecast(goal.id, {}, { madeAgo: 3 * DAY, dueAgo: HOUR });
      const ahead = await forecast(goal.id, { supersedesId: due }, { madeAgo: 2 * DAY, dueAgo: -DAY });
      // The sweep settles the one whose date has passed (the goal was not done by then)...
      await run();
      expect(await k.resolution(due)).toMatchObject({ outcome: false, resolvedBy: 'auto_world' });
      expect(await k.resolution(ahead)).toBeUndefined();
      // ...and Will's card settles the rest, as Will: the one still ahead comes true.
      const done = await g.fileSignRun('goal.done', { goalId: goal.id, goalTitle: goal.title });
      expect(done.result).toMatchObject({ predictionsResolved: 1 });
      expect(await k.resolution(ahead)).toMatchObject({ outcome: true, resolvedBy: 'will' });
      // A forecast of a goal that is already finished, left unsettled (it cannot happen through the card): never the sweep's.
      const finished = await g.activeGoal();
      await g.fileSignRun('goal.abandon', { goalId: finished.id, goalTitle: finished.title });
      const stray = await forecast(finished.id, {}, { madeAgo: 2 * DAY, dueAgo: HOUR });
      expect(await verdict(stray)).toEqual({ verdict: 'wait', why: 'finished' });
      await run();
      expect(await k.resolution(stray)).toBeUndefined();
    });

    it('a goal that is being changed right now waits for the next sweep; a rule that names another goal is not a rule for this one', async () => {
      const goal = await g.activeGoal();
      const left = await leftovers();
      const p = await forecast(goal.id, {}, { madeAgo: 2 * DAY, dueAgo: HOUR });
      const holder = await k.client();
      try {
        await holder.query('BEGIN');
        await holder.query(`SELECT id FROM "Goal" WHERE id = $1 FOR UPDATE`, [goal.id]);
        expect(await verdict(p)).toEqual({ verdict: 'wait', why: 'busy' });
        expect(await run()).toMatchObject({ resolved: 0, waiting: left.waiting + 1 });
      } finally {
        await holder.query('ROLLBACK');
        await holder.end();
      }
      expect(await run()).toMatchObject({ resolved: 1 });
      const other = await g.activeGoal();
      expect(await verdict(await forecast(goal.id, { resolverSpec: { goalId: other.id, rule: 'goal_done_by' } }, { madeAgo: 2 * DAY, dueAgo: HOUR }))).toEqual({ verdict: 'unknown' });
      expect(await verdict(await k.prediction({ resolverSpec: { goalId: goal.id, rule: 'goal_done_by' } }, { madeAgo: 2 * DAY, dueAgo: HOUR }))).toEqual({ verdict: 'unknown' });
    });
  });

  describe('what is never guessed, and never Will\'s', () => {
    it('whose a prediction is: no rule or a rule that does not fit its row is counted and runs out; a rule the sweep does not know is another module\'s, and is left alone', async () => {
      const eid = await k.service(k.serviceKey(), { running: true, disabled: false }, ago(5 * HOUR));
      const series = await k.onSeries();
      const at = dayStart(1);
      await k.point(series, at, 5);
      const made = { madeAgo: Date.now() - at.getTime() - 4 * HOUR, dueAgo: MIN };
      // Nobody's, or the sweep's own shape on a row it does not fit: nothing can ever settle these.
      const unknown: Array<[string, Record<string, unknown>]> = [
        ['no rule at all', { resolverSpec: null }],
        ['a metric rule on a prediction that resolves from the world', { resolverSpec: { seriesKey: series, at: at.toISOString(), op: 'above', value: 1 } }],
        ['a world rule on a prediction that resolves from a metric', { resolver: 'auto_metric', resolverSpec: { entityId: eid, check: 'healthy', at: 'resolveBy' } }],
        ['a range rule on a yes/no prediction', { resolver: 'auto_metric', resolverSpec: { seriesKey: series, at: at.toISOString(), op: 'range' } }],
        ['a series that does not exist', { resolver: 'auto_metric', resolverSpec: { seriesKey: 'no.such.series', at: at.toISOString(), op: 'above', value: 1 } }],
      ];
      // A rule the sweep's own shapes do not parse: some other module's.
      const other: Array<[string, Record<string, unknown>]> = [
        ['a rule of another shape', { resolverSpec: { check: 'vibes' } }],
        ['a later part\'s rule', { resolverSpec: { taskId: 'tktest0001', rule: 'task_meets_bar' } }],
        ['a known rule with a field too many', { resolverSpec: { entityId: eid, check: 'healthy', at: 'resolveBy', also: 'this' } }],
        ['another check', { resolverSpec: { entityId: eid, check: 'fast', at: 'resolveBy' } }],
        ['healthy at some other time', { resolverSpec: { entityId: eid, check: 'healthy', at: '2026-10-01T00:00:00.000Z' } }],
        ['a threshold that is not a number', { resolver: 'auto_metric', resolverSpec: { seriesKey: series, at: at.toISOString(), op: 'above', value: '5' } }],
        ['a step that is not a time', { resolver: 'auto_metric', resolverSpec: { seriesKey: series, at: 'yesterday', op: 'above', value: 1 } }],
      ];
      const left = await leftovers();
      const ids: string[] = [];
      for (const [name, over] of unknown) {
        const p = await k.prediction(over, made);
        expect(await verdict(p), name).toEqual({ verdict: 'unknown' });
        expect(ruleOwner(await k.due(p)), name).toBe(over.resolverSpec === null ? 'nobody' : 'sweep');
        ids.push(p);
      }
      const theirs: string[] = [];
      for (const [name, over] of other) {
        const p = await k.prediction(over, made);
        expect(await verdict(p), name).toEqual({ verdict: 'other' });
        expect(ruleOwner(await k.due(p)), name).toBe('other');
        theirs.push(p);
      }
      const c = await run();
      expect(c).toMatchObject({ unknownSpec: left.unknownSpec + unknown.length, others: left.others + other.length, waiting: left.waiting, refused: 0 });
      expect((await k.owner(`SELECT count(*)::int AS n FROM "Resolution" WHERE "predictionId" = ANY ($1)`, [[...ids, ...theirs]])).rows[0].n).toBe(0);
      expect((await k.owner(`SELECT DISTINCT status FROM "Prediction" WHERE id = ANY ($1)`, [[...ids, ...theirs]])).rows).toEqual([{ status: 'open' }]);
      // 72 hours on: what nothing can settle has run out, and another module's is as it was (its owner may yet settle it).
      const gone = await k.prediction({ resolverSpec: null }, { madeAgo: 5 * DAY, dueAgo: 80 * HOUR });
      const kept = [await k.prediction({ resolverSpec: { taskId: 'tktest0001', rule: 'task_meets_bar' } }, { madeAgo: 5 * DAY, dueAgo: 80 * HOUR }),
        await k.prediction({ resolverSpec: { check: 'vibes' } }, { madeAgo: 40 * DAY, dueAgo: 30 * DAY })];
      const swept = await sweep(k.db, { tz: TZ, resolve: true, expire: true });
      expect(swept.refused).toBe(0);
      expect(await k.status(gone)).toBe('expired');
      for (const p of kept) expect(await k.status(p), p).toBe('open');
      // A superseded prediction with no rule cannot run out (it stays superseded), so it is not said to: it waits, uncounted.
      const before = await leftovers();
      const first = await k.prediction({ resolverSpec: null }, { madeAgo: 3 * DAY, dueAgo: HOUR });
      await k.prediction({ resolverSpec: { entityId: eid, check: 'healthy', at: 'resolveBy' }, supersedesId: first }, { madeAgo: 2 * DAY, dueAgo: -DAY });
      expect(await k.status(first)).toBe('superseded');
      expect(await run()).toMatchObject({ unknownSpec: before.unknownSpec, waiting: before.waiting + 1 });
      // A forecast's row names its series: a rule that names another series is not its rule.
      const another = await k.onSeries();
      await k.point(another, at, 7);
      const crossed = await k.range(series, at, { resolverSpec: { seriesKey: another, at: at.toISOString(), op: 'range' } }, made);
      expect(await verdict(crossed)).toEqual({ verdict: 'unknown' });
      // The shapes, said once.
      expect(ResolverSpec.safeParse({ seriesKey: series, at: at.toISOString(), op: 'range' }).success).toBe(true);
      expect(ResolverSpec.safeParse({ seriesKey: series, at: at.toISOString(), op: 'range', value: 3 }).success).toBe(false);
      expect(ResolverSpec.safeParse({ goalId: 'gotest0001', rule: 'goal_done_by' }).success).toBe(true);
      expect(ResolverSpec.safeParse({ goalId: 'gotest0001', rule: 'goal_on_track' }).success).toBe(false);
    });

    it('a claim about a step that was over before the claim was made is no forecast: the resolver leaves it, and the database refuses it as a leak', async () => {
      const series = await k.onSeries();
      const at = dayStart(3);
      await k.point(series, at, 5);
      // Made yesterday about the day that ended two days ago.
      const p = await k.range(series, at, {}, { madeAgo: 20 * HOUR, dueAgo: MIN });
      expect(await verdict(p)).toEqual({ verdict: 'unknown' });
      await run();
      expect(await k.resolution(p)).toBeUndefined();
      // Written by hand with the step's end as the event: the leak guard has the last word.
      const leak = await k.code(k.app(`INSERT INTO "Resolution" (id, "predictionId", "outcomeValue", "eventAt", "resolvedBy") VALUES ($1, $2, 5, $3, 'auto_metric')`, [id('rs'), p, dayStart(2)]));
      expect(leak).toBe('23514');
      // And an event still ahead is refused too: nothing is settled before it happened.
      const today = await k.range(series, dayStart(0), {}, { madeAgo: 2 * MIN, dueAgo: MIN });
      expect(await k.code(k.app(`INSERT INTO "Resolution" (id, "predictionId", "outcomeValue", "eventAt", "resolvedBy") VALUES ($1, $2, 5, $3, 'auto_metric')`, [id('rs'), today, new Date(Date.now() + DAY)]))).toBe('23514');
    });

    it('a prediction only Will resolves is never given to a resolver, whatever rule it carries; and the database refuses a resolver that tried', async () => {
      const eid = await k.service(k.serviceKey(), { running: true, disabled: false }, ago(5 * HOUR));
      await k.service((await k.db.entity.findUniqueOrThrow({ where: { id: eid } })).key, { running: true, disabled: false, lastExit: 0 }, ago(5 * MIN));
      const left = await leftovers();
      // Chat's kind of prediction, due, carrying a rule a resolver would know how to settle.
      const wills = await k.prediction({ method: 'model_reasoning', resolver: 'will', createdBy: 'client:server', resolverSpec: { entityId: eid, check: 'healthy', at: 'resolveBy' } }, { madeAgo: 3 * HOUR, dueAgo: HOUR });
      expect(await verdict(wills)).toEqual({ verdict: 'other' });
      expect(ruleOwner(await k.due(wills))).toBe('other');
      const before = (await k.owner(`SELECT count(*)::int AS n FROM "Resolution"`)).rows[0].n as number;
      const c = await run();
      // It is not even read: not resolved, not waiting, not counted as a rule nobody knows.
      expect(c).toEqual(left);
      expect((await k.owner(`SELECT count(*)::int AS n FROM "Resolution"`)).rows[0].n).toBe(before);
      expect(await k.status(wills)).toBe('open');
      // What a resolver could write for it, written by hand as the runtime: each refused by the database.
      const write = (resolvedBy: string) => k.code(k.app(`INSERT INTO "Resolution" (id, "predictionId", outcome, "eventAt", "resolvedBy") VALUES ($1, $2, true, $3, $4)`, [id('rs'), wills, ago(HOUR), resolvedBy]));
      // As itself: only Will resolves this one (P1's guard).
      expect(await write('auto_world')).toBe('P0001');
      expect(await write('auto_metric')).toBe('P0001');
      // As Will: he has not answered its question (P4 part 1's guard).
      expect(await write('will')).toBe('42501');
      expect(await k.resolution(wills)).toBeUndefined();
    });

    it('nothing the sweep ever wrote is recorded as Will\'s, and every one of its resolutions says where it came from', async () => {
      const rows = (await k.owner(`SELECT "resolvedBy", evidence->>'via' AS via, evidence->>'rule' AS rule, count(*)::int AS n FROM "Resolution" GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`)).rows;
      const swept = rows.filter((r) => r.via === 'ledger.sweep');
      expect(swept.length).toBeGreaterThan(0);
      expect([...new Set(swept.map((r) => r.resolvedBy))].sort()).toEqual(['auto_metric', 'auto_world']);
      expect([...new Set(swept.map((r) => r.rule))].sort()).toEqual(['goal_done_by', 'healthy_at', 'healthy_next_observed', 'metric_range', 'metric_threshold']);
      // Will's are the goal card's alone (this file wrote no answer).
      expect(rows.filter((r) => r.resolvedBy === 'will').map((r) => r.via)).toEqual(['goal.done']);
      // No prediction only Will resolves has a resolution, and none the sweep settled was voided.
      expect((await k.owner(`SELECT count(*)::int AS n FROM "Resolution" r JOIN "Prediction" p ON p.id = r."predictionId" WHERE p.resolver = 'will'`)).rows[0].n).toBe(0);
      expect((await k.owner(`SELECT count(*)::int AS n FROM "Prediction" WHERE status = 'void'`)).rows[0].n).toBe(0);
      // The audit entries: counts and switches, nothing else.
      const audits = await k.sweepAudits();
      expect(audits.length).toBeGreaterThan(5);
      for (const a of audits) {
        expect(a).toMatchObject({ actor: 'runtime:ledger', context: 'autonomous', kind: 'action', outcome: 'ok', reasoning: null, outcomeDetail: null, correlationId: null });
        expect(Object.keys(a.inputs).sort()).toEqual(['capped', 'conditionUnmet', 'expireRan', 'expired', 'others', 'refused', 'resolveRan', 'resolved', 'settled', 'unknownSpec', 'waiting']);
        for (const v of Object.values(a.inputs)) expect(['number', 'boolean']).toContain(typeof v);
      }
      expect(JSON.stringify(audits)).not.toMatch(/31337|4242|CANARY|daily\.|service:|HEX/);
      void HEX;
    });
  });
});
