/**
 * P4's one card on flint_test, the way the runtime runs it: filed
 * (createProposal), signed with a test key, approved (approveProposal) and run
 * (runInternal), as P3's goal cards are.
 *
 *  - Turn On Predictions is filed once, with a fixed reason and the listed
 *    numbers' sensitivity, from the console or the CLI only; a key outside the
 *    registry and a card that changes nothing are never filed.
 *  - It runs only signed, in one transaction: the numbers' series rows are made
 *    as the registry says, the switches turn on under the card's approval, and
 *    a fault leaves nothing on and the card approved.
 *  - No card lets a series leave this Mac, and none calls an outside forecaster.
 *  - A forecast's predictions go through emitPrediction with their range and
 *    their run, and the database has the last word on the method.
 *  - A calibration snapshot is one row per group and kind.
 * Log lines, audit entries, results and errors carry keys and counts only.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { digestOf } from '@flint/policy';
import { NO_DB, freshDb, withClient, id, type TestUrls } from './db';
import { enrollTestKey } from './sign';
import { createDb, type Db } from '../src/db';
import { approveProposal, createProposal } from '../src/governance/proposals';
import { INTERNAL_ACTIONS, runInternal } from '../src/governance/internal';
import { SAY, runForecast, runForecastCard } from '../src/predict/enable';
import { FORECAST_SERIES, forecastSeries, freqOf } from '../src/predict/series';
import { emitPrediction } from '../src/ledger/emit';
import { snapshotCalibration } from '../src/ledger/calibration';

const SPEND = 'daily.spend.anthropic.usd';
const DEPLOYS = 'daily.deploys.count';
const HOURS = 'daily.calendar.hours';
const COMMITS = 'weekly.commits.flint.count';
const DOWNTIME = 'daily.services.incident_minutes';

describe.skipIf(NO_DB)('P4: Turn On Predictions, as the runtime runs it', () => {
  let urls: TestUrls;
  let db: Db;
  let key: Awaited<ReturnType<typeof enrollTestKey>>;
  let said: string[] = [];
  const owner = (sql: string, params: unknown[] = []) => withClient(urls.owner, (c) => c.query(sql, params));
  const asApp = (sql: string, params: unknown[] = []) => withClient(urls.app, (c) => c.query(sql, params));

  beforeAll(async () => {
    urls = await freshDb();
    db = createDb(urls.app);
    key = await enrollTestKey(urls);
  });
  afterAll(async () => db?.$disconnect());
  beforeEach(() => {
    said = [];
    for (const level of ['error', 'warn', 'log', 'info'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void said.push(args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : String(a))).join(' ')));
    }
  });
  afterEach(() => vi.restoreAllMocks());

  const file = (args: Record<string, unknown>, over: Record<string, unknown> = {}) =>
    createProposal(db, {
      kind: 'tool_call', origin: 'console', action: 'forecast.series.enable', args,
      argsProvenance: { series: { source: 'will', tainted: false }, reason: { source: 'will', tainted: false } },
      tainted: false, sensitivity: 'ops', destructive: false, consequential: false, ttlMinutes: 60, ...over,
    } as Parameters<typeof createProposal>[1], 'test');
  async function sign(pid: string) {
    const p = await db.proposal.findUniqueOrThrow({ where: { id: pid } });
    await approveProposal(db, pid, await key.approve({ subjectId: pid, action: p.action, argsDigest: p.argsDigest }), undefined, 'test');
  }
  const run = (pid: string) => runInternal(db, pid, undefined, 'UTC', 'test');
  const switches = async (keys: string[]) =>
    Object.fromEntries((await db.forecastSeries.findMany({ where: { seriesKey: { in: keys } } })).map((r) => [r.seriesKey, { on: r.on, reason: r.reason }]));

  describe('filing', () => {
    it('is from the console or the CLI, with a fixed reason, the numbers\' own sensitivity and a mark for Will\'s own touch; the same request is the same card', async () => {
      const p = await file({ series: [DEPLOYS, SPEND, DEPLOYS], reason: [DEPLOYS] }, { reason: 'a reason of the caller\'s own, with 12.34 in it' });
      const card = await db.proposal.findUniqueOrThrow({ where: { id: p.id } });
      expect(card).toMatchObject({
        kind: 'tool_call', action: 'forecast.series.enable', status: 'pending', tainted: false, destructive: false, consequential: true,
        reason: 'Approving turns on Flint’s forecasts of these numbers, on this Mac.', sensitivity: 'financial',
        args: { series: [SPEND, DEPLOYS].sort(), reason: [DEPLOYS] },
        // Where each list came from, as the card shows it.
        argsProvenance: { series: { source: 'will', tainted: false }, reason: { source: 'will', tainted: false } },
      });
      expect(card.argsDigest).toBe(digestOf({ series: [SPEND, DEPLOYS].sort(), reason: [DEPLOYS] }));
      // Another order, from the CLI: the same card.
      expect(await file({ reason: [DEPLOYS], series: [SPEND, DEPLOYS] }, { origin: 'cli' })).toMatchObject({ id: p.id, deduped: true });
      // Its sensitivity is the most sensitive number it names.
      const ops = await db.proposal.findUniqueOrThrow({ where: { id: (await file({ series: [DEPLOYS, COMMITS], reason: [] })).id } });
      expect(ops.sensitivity).toBe('ops');
      const personal = await db.proposal.findUniqueOrThrow({ where: { id: (await file({ series: [DEPLOYS, HOURS], reason: [] })).id } });
      expect(personal.sensitivity).toBe('personal');
    });

    it('refuses what could not apply, each with a sentence: chat, a job, a key outside the registry, a bad shape', async () => {
      await expect(file({ series: [DEPLOYS], reason: [] }, { origin: 'chat:conv1' })).rejects.toMatchObject({ status: 409, message: SAY.fromConsole });
      // From a job: the tier engine refuses it (it is not an autonomous action), and audits that.
      await expect(file({ series: [DEPLOYS], reason: [] }, { origin: 'runtime:forecast', templateId: 'x' })).rejects.toMatchObject({ status: 409, message: 'forbidden: forecast.series.enable is not an autonomous action' });
      expect(await db.auditEntry.count({ where: { action: 'forecast.series.enable', outcome: 'denied', tier: 'forbidden' } })).toBe(1);
      for (const series of [['daily.spend.acme.usd'], ['spend.anthropic.day.usd'], [DEPLOYS, 'test.made_up.count']]) {
        await expect(file({ series, reason: [] }), series.join()).rejects.toMatchObject({ status: 400, message: SAY.unknown });
      }
      for (const args of [{ series: [], reason: [] }, { series: [DEPLOYS] }, { series: [DEPLOYS], reason: [HOURS] }, { series: [DEPLOYS], reason: [], also: true }, { series: ['Deploys Today'], reason: [] }, { series: DEPLOYS, reason: [] }]) {
        await expect(file(args as Record<string, unknown>), JSON.stringify(args)).rejects.toMatchObject({ status: 400, message: SAY.invalid });
      }
      await expect(file({ series: [DEPLOYS], reason: [] }, { kind: 'policy' })).rejects.toMatchObject({ status: 400, message: SAY.kind });
      await expect(file({ series: [DEPLOYS], reason: [] }, { templateId: 'nightly.predictions' })).rejects.toMatchObject({ status: 400, message: SAY.template });
      await expect(file({ series: [DEPLOYS], reason: [] }, { tainted: true })).rejects.toMatchObject({ status: 400, message: SAY.invalid });
      await expect(file({ series: [DEPLOYS], reason: [] }, { argsProvenance: { series: { source: 'event', tainted: true } } })).rejects.toMatchObject({ status: 400, message: SAY.provenance });
      await expect(file({ series: [DEPLOYS], reason: [] }, { argsProvenance: { series: { source: 'model', tainted: false } } })).rejects.toMatchObject({ status: 400, message: SAY.provenance });
      await expect(file({ series: [DEPLOYS], reason: [] }, { argsProvenance: { series: { source: 'will', ref: 'he said: turn it all on', tainted: false } } })).rejects.toMatchObject({ status: 400, message: SAY.provenance });
      // Every sentence Will might read is a sentence, with no number in it.
      for (const s of Object.values(SAY)) {
        expect(s).toMatch(/^[A-Z].*\.$/);
        expect(s).not.toMatch(/\d/);
      }
    });
  });

  describe('running', () => {
    it('runs only signed, in one transaction: the series as the registry says, the switches on under the card\'s approval, ids and counts in the record', async () => {
      const args = { series: [SPEND, DEPLOYS, HOURS], reason: [DEPLOYS] };
      const p = await file(args);
      // Not signed: nothing runs, nothing is made.
      await expect(run(p.id)).rejects.toMatchObject({ status: 409, message: 'It isn’t approved yet.' });
      expect(await db.forecastSeries.count()).toBe(0);
      expect(await db.metricSeries.count({ where: { key: { in: args.series } } })).toBe(0);
      await sign(p.id);
      expect(await run(p.id)).toEqual({ on: 3, reason: 1 });
      const card = await db.proposal.findUniqueOrThrow({ where: { id: p.id } });
      expect(card).toMatchObject({ status: 'executed', result: { on: 3, reason: 1 }, error: null });
      expect(await switches(args.series)).toEqual({ [SPEND]: { on: true, reason: false }, [DEPLOYS]: { on: true, reason: true }, [HOURS]: { on: true, reason: false } });
      for (const r of await db.forecastSeries.findMany({ where: { seriesKey: { in: args.series } } })) {
        expect(r.approvalId, r.seriesKey).toBe(card.approvalId);
        expect(Date.now() - r.enabledAt.getTime(), r.seriesKey).toBeLessThan(60_000);
      }
      // Each series row is what the registry says it is, and on this Mac only.
      for (const s of await db.metricSeries.findMany({ where: { key: { in: args.series } } })) {
        const d = forecastSeries(s.key)!;
        expect(s, s.key).toMatchObject({ unit: d.unit, freq: freqOf(d), sensitivity: d.sensitivity, description: d.description, offBoxAllowed: false, entityId: null });
      }
      expect((await db.metricSeries.findUniqueOrThrow({ where: { key: SPEND } })).sensitivity).toBe('financial');
      expect((await db.metricSeries.findUniqueOrThrow({ where: { key: HOURS } })).sensitivity).toBe('personal');
      // Who turned each on, in the history; the approval, used once; the audit trail, with ids only.
      const history = (await owner(`SELECT "rowId", actor, changed FROM "RowChange" WHERE "tableName" = 'ForecastSeries' ORDER BY "rowId"`)).rows;
      expect(history.map((h) => [h.rowId, h.actor, h.changed.on])).toEqual(args.series.slice().sort().map((k) => [k, `will:approval:${card.approvalId}`, [null, true]]));
      expect((await owner(`SELECT action FROM "ForecastApprovalUse" WHERE "approvalId" = $1`, [card.approvalId])).rows).toEqual([{ action: 'forecast.series.enable' }]);
      const audit = await db.auditEntry.findMany({ where: { correlationId: p.id }, orderBy: { seq: 'asc' } });
      expect(audit.map((a) => `${a.kind}:${a.outcome}`)).toEqual(['decision:pending', 'approval:ok', 'intent:pending', 'action:ok']);
      for (const a of audit) expect(Object.keys(a.inputs as object).sort().join(), a.kind).toMatch(/^(approvalId,)?argsDigest,proposalId(,rule)?$/);
      // Running it again does nothing more.
      await expect(run(p.id)).rejects.toMatchObject({ status: 409, message: 'It already ran.' });
      // The same numbers, the same way: there is nothing to sign.
      await expect(file(args)).rejects.toMatchObject({ status: 400, message: SAY.nothing });
    });

    it('a later card changes exactly what it lists: the estimate on where it says, off where it does not, other numbers untouched', async () => {
      const second = await file({ series: [SPEND, DEPLOYS], reason: [SPEND] });
      await sign(second.id);
      expect(await run(second.id)).toEqual({ on: 2, reason: 1 });
      expect(await switches([SPEND, DEPLOYS, HOURS])).toEqual({ [SPEND]: { on: true, reason: true }, [DEPLOYS]: { on: true, reason: false }, [HOURS]: { on: true, reason: false } });
      const approvals = Object.fromEntries((await db.forecastSeries.findMany()).map((r) => [r.seriesKey, r.approvalId]));
      const signed = (await db.proposal.findUniqueOrThrow({ where: { id: second.id } })).approvalId;
      expect([approvals[SPEND], approvals[DEPLOYS]]).toEqual([signed, signed]);
      expect(approvals[HOURS]).not.toBe(signed);
      // Turning one off (as the console will, unsigned) makes the card worth filing again.
      await db.forecastSeries.update({ where: { seriesKey: DEPLOYS }, data: { on: false, reason: false } });
      expect(await file({ series: [SPEND, DEPLOYS], reason: [SPEND] })).toMatchObject({ deduped: false });
    });

    it('a fault after the writes leaves nothing turned on and the card approved; it then runs', async () => {
      const args = { series: [COMMITS, DOWNTIME], reason: [] };
      const p = await file(args);
      await sign(p.id);
      await expect(runForecastCard(db, p.id, undefined, 'UTC', 'test', { afterWrites: async () => { throw new Error(`boom at ${COMMITS} with 31337.4242`); } }))
        .rejects.toMatchObject({ status: 409, message: 'Flint couldn’t carry it out.' });
      expect(await switches(args.series)).toEqual({});
      expect(await db.metricSeries.count({ where: { key: { in: args.series } } })).toBe(0);
      expect((await db.proposal.findUniqueOrThrow({ where: { id: p.id } })).status).toBe('approved');
      // The log has a reference, the failure's class and where it failed: never the error's words.
      expect(said.join('\n')).toMatch(/\[runtime\] err\w+ running proposal \w+ failed: Error/);
      expect(said.join('\n')).not.toMatch(/boom|31337/);
      expect(await run(p.id)).toEqual({ on: 2, reason: 0 });
      expect(await switches(args.series)).toEqual({ [COMMITS]: { on: true, reason: false }, [DOWNTIME]: { on: true, reason: false } });
    });

    it('a series stored under another label, or forgotten, stops the card with a sentence: nothing is turned on under the registry\'s name', async () => {
      const mislabeled = 'daily.threads.open';
      const p = await file({ series: [mislabeled, 'weekly.commits.nexus.count'], reason: [] });
      await sign(p.id);
      // Between filing and running, a row appears under the registry's key with another sensitivity.
      await asApp(`INSERT INTO "MetricSeries" (key, unit, freq, sensitivity, description) VALUES ($1, 'count', 'D', 'personal', 'not what the registry says')`, [mislabeled]);
      await expect(run(p.id)).rejects.toMatchObject({ status: 409, message: SAY.mislabeled });
      expect(await db.proposal.findUniqueOrThrow({ where: { id: p.id } })).toMatchObject({ status: 'failed', error: SAY.mislabeled });
      expect(await switches([mislabeled, 'weekly.commits.nexus.count'])).toEqual({});
      expect(await db.metricSeries.count({ where: { key: 'weekly.commits.nexus.count' } })).toBe(0);
      await expect(file({ series: [mislabeled], reason: [] })).rejects.toMatchObject({ status: 409, message: SAY.mislabeled });
      // A number whose entity Will forgot (his signed forget marks its series).
      const gone = 'weekly.commits.helm.count';
      const repo = id('en');
      await owner(`INSERT INTO "Entity" (id, kind, key, name, state, "stateHash", "lastObservedAt", "updatedAt") VALUES ($1, 'repo', $2, 'synthetic', '{}', $3, now(), now())`, [repo, `repo:test:${repo}`, 'd'.repeat(64)]);
      await asApp(`INSERT INTO "MetricSeries" (key, "entityId", unit, freq, sensitivity, description) VALUES ($1, $2, 'count', 'W', 'ops', 'How many commits land in Helm each week.')`, [gone, repo]);
      // Before any forget: a registered number is about no single item, so a row made under its key and tied to one
      // (the tie is fixed at birth) is not turned on. Its forget would otherwise stop the number for good.
      await expect(file({ series: [gone], reason: [] })).rejects.toMatchObject({ status: 409, message: SAY.mislabeled });
      expect(await switches([gone])).toEqual({});
      await asApp(`SELECT forget_entity($1, $2)`, [repo, await key.approve({ subjectType: 'forget', subjectId: repo, action: 'world.forget', argsDigest: 'a'.repeat(64) })]);
      expect((await db.metricSeries.findUniqueOrThrow({ where: { key: gone } })).description).toBe('[forgotten]');
      await expect(file({ series: [gone], reason: [] })).rejects.toMatchObject({ status: 409, message: SAY.forgotten });
    });

    it('a predictions card that did not come from the console never runs, even signed; one whose args no longer read the same is refused', async () => {
      const raw = async (origin: string, args: Record<string, unknown>) => {
        const pid = id('prop');
        await asApp(`INSERT INTO "Proposal" (id, kind, origin, action, args, "argsDigest", "argsProvenance", "expiresAt") VALUES ($1, 'tool_call', $2, 'forecast.series.enable', $3::jsonb, $4, '{}', now() + interval '1 hour')`,
          [pid, origin, JSON.stringify(args), digestOf(args)]);
        await sign(pid);
        return pid;
      };
      const chat = await raw('chat:conv1', { series: ['weekly.commits.trident.count'], reason: [] });
      await expect(run(chat)).rejects.toMatchObject({ status: 409, message: SAY.fromConsole });
      expect(await db.proposal.findUniqueOrThrow({ where: { id: chat } })).toMatchObject({ status: 'failed', error: SAY.fromConsole });
      // Signed as filed, but not in the contract's own form (unsorted): what would be written is not what was signed.
      const unsorted = await raw('console', { series: ['weekly.commits.trident.count', 'daily.spend.openai.usd'], reason: [] });
      await expect(run(unsorted)).rejects.toMatchObject({ status: 409, message: SAY.reshaped });
      // A key outside the registry, signed all the same.
      const unknown = await raw('console', { series: ['spend.eval.day.usd'], reason: [] });
      await expect(run(unknown)).rejects.toMatchObject({ status: 409, message: SAY.unknown });
      expect(await switches(['weekly.commits.trident.count', 'daily.spend.openai.usd', 'spend.eval.day.usd'])).toEqual({});
    });

    it('there is no card that lets a series leave this Mac, and no call to an outside forecaster: nothing is listed, filed or run for either', async () => {
      expect([...INTERNAL_ACTIONS].filter((a) => /forecast|prophet|offbox/.test(a))).toEqual(['forecast.series.enable']);
      // An outside forecaster's card is refused when it is filed, from anywhere, and the refusal is audited.
      for (const action of ['prophet.forecast_adhoc', 'prophet.calibration', 'prophet.models']) {
        for (const origin of ['console', 'cli', 'chat:conv1', 'runtime:forecast']) {
          await expect(createProposal(db, { kind: 'tool_call', origin, action, args: { series: [DEPLOYS] }, argsProvenance: {}, tainted: false, sensitivity: 'ops', destructive: false, consequential: true, ttlMinutes: 60, ...(origin.startsWith('runtime:') ? { templateId: 'x' } : {}) }, 'test'))
            .rejects.toMatchObject({ status: 409, message: 'forbidden: Flint forecasts on this Mac and calls no outside forecaster' });
        }
        expect(await db.proposal.count({ where: { action } })).toBe(0);
        expect(await db.auditEntry.count({ where: { action, outcome: 'denied', tier: 'forbidden' } })).toBe(4);
      }
      // The forecast executor runs the on-switch and nothing else: handed another signed card, it fails it.
      const pid = id('prop');
      const args = { series: [DEPLOYS], reason: [] };
      await asApp(`INSERT INTO "Proposal" (id, kind, origin, action, args, "argsDigest", "argsProvenance", "expiresAt") VALUES ($1, 'tool_call', 'console', 'world.sync.git', $2::jsonb, $3, '{}', now() + interval '1 hour')`,
        [pid, JSON.stringify(args), digestOf(args)]);
      await sign(pid);
      await expect(runForecast(db, pid, undefined, 'UTC', 'test')).rejects.toMatchObject({ status: 409, message: SAY.invalid });
      // After every card above, no series is marked as allowed to leave this Mac, and none can be.
      expect(await db.metricSeries.count({ where: { offBoxAllowed: true } })).toBe(0);
      await expect(db.metricSeries.update({ where: { key: DEPLOYS }, data: { offBoxAllowed: true } })).rejects.toMatchObject({ name: expect.stringMatching(/^PrismaClient/) });
      expect((await db.metricSeries.findUniqueOrThrow({ where: { key: DEPLOYS } })).offBoxAllowed).toBe(false);
    });
  });

  describe('a forecast\'s predictions and the snapshot', () => {
    const points = [{ at: '2026-10-14T04:00:00.000Z', mean: 4, lo: 2, hi: 6 }];
    const newRun = (seriesKey: string, beatsNaive: boolean) =>
      db.forecastRun.create({
        data: {
          id: id('fr'), seriesKey, provider: 'local', endpoint: 'local:fc.v1', requestDigest: digestOf({ r: id() }), horizon: 1, level: 0.8,
          beatsNaive, naiveMase: 1, modelMase: beatsNaive ? 0.8 : 1.1, scale: 2, points, latencyMs: 4, ok: true,
        },
      });
    const soon = () => new Date(Date.now() + 86_400_000).toISOString();

    it('emitPrediction records a range and its yes/no question on a run; the method is what the run earned', async () => {
      // SPEND is on (the cards above); its run beat naive.
      const beat = await newRun(SPEND, true);
      const common = { domain: 'spend' as const, evidence: [{ kind: 'forecast_run', ref: beat.id }], resolver: 'auto_metric' as const, resolveBy: soon(), seriesKey: SPEND, forecastRunId: beat.id, unit: 'usd' };
      const range = await emitPrediction(db, {
        ...common, template: { id: 'series_range', params: { series: SPEND, lo: 2, hi: 6, on: '2026-10-14' } }, kind: 'interval', method: 'statistical', type: 'trend',
        resolutionCriteria: 'The series\' value for that day is inside the range.', resolverSpec: { seriesKey: SPEND, at: '2026-10-14T04:00:00.000Z', op: 'range' },
        pointEstimate: 4, lower: 2, upper: 6, level: 0.8, tainted: false,
      }, 'runtime:forecast');
      expect(range).toMatchObject({ claim: `${SPEND} is between 2 and 6 on 2026-10-14`, kind: 'interval', probability: null, method: 'statistical', pointEstimate: 4, lower: 2, upper: 6, level: 0.8, unit: 'usd', seriesKey: SPEND, forecastRunId: beat.id, createdBy: 'runtime:forecast' });
      const question = await emitPrediction(db, {
        ...common, template: { id: 'threshold', params: { series: SPEND, op: 'above', value: 3 } }, kind: 'binary', probability: 0.7, method: 'statistical', type: 'threshold_cross',
        resolutionCriteria: 'The series\' value for that day is above the threshold.', tainted: false,
      }, 'runtime:forecast');
      expect(question).toMatchObject({ kind: 'binary', probability: 0.7, pointEstimate: null, lower: null, upper: null, level: null, forecastRunId: beat.id });
      // A run that did not beat naive: the code's own checks pass, and the database refuses the label.
      const lost = await newRun(SPEND, false);
      await expect(emitPrediction(db, { ...common, forecastRunId: lost.id, claim: 'a synthetic claim', kind: 'binary', probability: 0.6, method: 'statistical', type: 'threshold_cross', resolutionCriteria: 'synthetic', tainted: false }, 'runtime:forecast'))
        .rejects.toMatchObject({ name: expect.stringMatching(/^PrismaClient/) });
      expect(await db.prediction.count({ where: { forecastRunId: lost.id } })).toBe(0);
      expect((await emitPrediction(db, { ...common, forecastRunId: lost.id, claim: 'a synthetic claim', kind: 'binary', probability: 0.6, method: 'base_rate', type: 'threshold_cross', resolutionCriteria: 'synthetic', tainted: false }, 'runtime:forecast')).method).toBe('base_rate');
    });

    it('a calibration snapshot is one row per group and kind, and a second run rewrites it instead of adding one', async () => {
      const start = new Date(Date.now() - 86_400_000);
      const end = new Date(Date.now() + 86_400_000);
      const first = await snapshotCalibration(db, start, end);
      expect(first.length).toBeGreaterThan(0);
      // Yes/no groups have a Brier score and no coverage; the range the test above recorded is a row of its own kind,
      // with nothing scored yet (ledger/calibration-db.test.ts has the scores).
      for (const r of first.filter((x) => x.kind === 'binary')) expect([r.brier !== null, r.baseRate !== null, r.ece, r.intervalCoverage]).toEqual([true, true, null, null]);
      expect(first.filter((x) => x.kind === 'interval').map((r) => [r.domain, r.type, r.method, r.n, r.nOpen, r.brier, r.intervalCoverage, r.pinball])).toEqual([['spend', 'trend', 'statistical', 0, 1, null, 0, null]]);
      const again = await snapshotCalibration(db, start, end);
      expect(again.map((r) => r.id).sort()).toEqual(first.map((r) => r.id).sort());
      expect(await db.calibrationSnapshot.count()).toBe(first.length);
    });
  });

  it('one card can turn on every number still stored as the registry says (ten here: one was mislabeled above, one forgotten)', async () => {
    const p = await file({ series: FORECAST_SERIES.map((s) => s.key).filter((k) => k !== 'daily.threads.open' && k !== 'weekly.commits.helm.count'), reason: [] });
    await sign(p.id);
    expect(await run(p.id)).toEqual({ on: 10, reason: 0 });
    expect(await db.forecastSeries.count({ where: { on: true } })).toBe(10);
  });
});
