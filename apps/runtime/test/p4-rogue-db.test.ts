/**
 * What a runtime that breaks the rules still cannot do to Flint's forecasts
 * (P4 part 1): each attack as a regression. Raw SQL as flint_app on flint_test,
 * as a compromised runtime would send it.
 *
 *  - It cannot relabel a financial series as ops, by any statement shape, and
 *    cannot mark any series as allowed to leave this Mac: there is no card for
 *    that, and nothing Will signs opens one.
 *  - It cannot sign for Will, widen what he signed, change a card after he
 *    signed it, or use one approval twice (in turn, at once, from an old
 *    snapshot, after the card expired, or by keeping a card for later).
 *  - It cannot forecast a number Will did not turn on, call a forecast
 *    statistical when its run did not earn it, or record a run made anywhere
 *    but on this Mac.
 *  - It cannot settle a prediction only Will resolves without his answer, and
 *    cannot erase or rewrite what is recorded.
 * The last block pins what the database does NOT prove (rules the runtime
 * writes itself), so nobody assumes more.
 * Synthetic series only.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { NO_DB, freshDb, id, HEX } from './db';
import { p4Kit, refusal, sleep, type P4Kit, type Q } from './p4';

describe.skipIf(NO_DB)('P4 against a runtime that breaks the rules', () => {
  let k: P4Kit;
  let app: Q;
  let owner: Q;
  const code = (p: Promise<unknown>) => k.code(p);
  const enableArgs = (series: string[], reason: string[] = []) => ({ series: [...series].sort(), reason: [...reason].sort() });
  const state = async (key: string) => (await app(`SELECT sensitivity, "offBoxAllowed" FROM "MetricSeries" WHERE key = $1`, [key])).rows[0];
  const isOn = async (key: string) => (await app(`SELECT "on", reason FROM "ForecastSeries" WHERE "seriesKey" = $1`, [key])).rows[0] ?? null;

  beforeAll(async () => {
    k = await p4Kit(await freshDb());
    ({ app, owner } = k);
  });

  describe('sending a financial series off this Mac', () => {
    it('relabel it as ops, then mark it as allowed to leave: refused in two statements, in one, through an upsert, a CTE, a merge', async () => {
      const fin = await k.series({ unit: 'usd', sensitivity: 'financial' });
      // Even with a card Will really signed that names this very key, under any action name (a runtime can file one and wait).
      await k.card('forecast.series.offbox', { seriesKey: fin });
      await k.card('forecast.series.enable', enableArgs([fin]));
      // (Each attempt starts only when its turn comes.)
      const attempts: Array<[string, () => Promise<unknown>]> = [
        ['relabel', () => app(`UPDATE "MetricSeries" SET sensitivity = 'ops' WHERE key = $1`, [fin])],
        ['clear', () => app(`UPDATE "MetricSeries" SET "offBoxAllowed" = true WHERE key = $1`, [fin])],
        ['both at once', () => app(`UPDATE "MetricSeries" SET sensitivity = 'ops', "offBoxAllowed" = true WHERE key = $1`, [fin])],
        ['an upsert', () => app(`INSERT INTO "MetricSeries" (key, unit, freq, sensitivity, description) VALUES ($1, 'usd', 'D', 'financial', 'x')
                                 ON CONFLICT (key) DO UPDATE SET sensitivity = 'ops', "offBoxAllowed" = true`, [fin])],
        ['an upsert that is born ops', () => app(`INSERT INTO "MetricSeries" (key, unit, freq, sensitivity, "offBoxAllowed", description) VALUES ($1, 'count', 'D', 'ops', true, 'x')
                                                  ON CONFLICT (key) DO UPDATE SET "offBoxAllowed" = true`, [fin])],
        ['a data-modifying CTE', () => app(`WITH relabel AS (UPDATE "MetricSeries" SET sensitivity = 'ops' WHERE key = $1 RETURNING 1)
                                            UPDATE "MetricSeries" SET "offBoxAllowed" = true WHERE key = $1 AND EXISTS (SELECT 1 FROM relabel)`, [fin])],
        ['a rename to hide it', () => app(`UPDATE "MetricSeries" SET key = $2 WHERE key = $1`, [fin, `test.${id('k')}.count`])],
        ['a new unit', () => app(`UPDATE "MetricSeries" SET unit = 'count' WHERE key = $1`, [fin])],
        ['a merge', () => app(`MERGE INTO "MetricSeries" m USING (SELECT $1::text AS key) s ON m.key = s.key WHEN MATCHED THEN UPDATE SET sensitivity = 'ops', "offBoxAllowed" = true`, [fin])],
      ];
      for (const [label, attempt] of attempts) expect(await k.outcome(attempt()), label).not.toBe('ok');
      expect(await state(fin)).toEqual({ sensitivity: 'financial', offBoxAllowed: false });
      // Born under another label: money is financial from the start, however the unit is spelled.
      expect(await code(k.series({ key: `daily.spend.${id('v')}.usd`, unit: 'usd', sensitivity: 'ops' }))).toBe('23514');
      expect(await code(k.series({ key: `daily.spend.${id('v')}.usd`, unit: 'USD', sensitivity: 'ops' }))).toBe('23514');
      expect(await code(k.series({ key: `daily.spend.${id('v')}.usd`, unit: 'dollars', sensitivity: 'ops' }))).toBe('23514');
      expect(await code(k.series({ key: `test.${id('v')}.x`, unit: 'Usd', sensitivity: 'personal' }))).toBe('23514');
      expect(await code(k.series({ key: 'daily.calendar.hours', unit: 'hours', sensitivity: 'ops' }))).toBe('23514');
      // And a run made anywhere but on this Mac is never recorded for it, on or not.
      await k.turnOn([fin]);
      for (const provider of ['prophet', 'frontier']) expect(await code(k.run(fin, { provider, endpoint: '/forecast/adhoc' })), provider).toBe('23514');
      expect((await app(`SELECT count(*)::int AS n FROM "ForecastRun" WHERE "seriesKey" = $1`, [fin])).rows[0].n).toBe(0);
    });

    it('stop a number for good by writing the forgotten mark itself: refused, at birth and afterwards (only Will\'s signed forget writes it)', async () => {
      const key = await k.onSeries();
      for (const attempt of [
        () => app(`UPDATE "MetricSeries" SET description = '[forgotten]' WHERE key = $1`, [key]),
        () => app(`INSERT INTO "MetricSeries" (key, unit, freq, sensitivity, description) VALUES ($1, 'count', 'D', 'ops', '[forgotten]') ON CONFLICT (key) DO UPDATE SET description = '[forgotten]'`, [key]),
        () => k.inTx(async (q) => {
          await q(`SELECT set_config('flint.forget_approval', 'apprforged', true)`);
          await q(`UPDATE "MetricSeries" SET description = '[forgotten]' WHERE key = $1`, [key]);
        }),
        () => k.series({ key: 'daily.deploys.count', description: '[forgotten]' }),
      ]) expect(await k.outcome(attempt())).toBe('42501');
      expect(await k.outcome(k.run(key))).toBe('ok');
    });

    it('mark an ops series as allowed to leave: refused too, for every role and whatever Will signed (there is no such card)', async () => {
      const a = await k.series();
      const clear = (q: Q = app) => q(`UPDATE "MetricSeries" SET "offBoxAllowed" = true WHERE key = $1`, [a]);
      expect(await code(clear())).toBe('42501');
      // A card under the name an earlier draft used, signed and executing: it is a card for nothing.
      await k.card('forecast.series.offbox', { seriesKey: a });
      expect(await code(clear())).toBe('42501');
      expect(await code(clear(owner))).toBe('42501');
      expect(await k.outcome(app(`INSERT INTO "MetricSeries" (key, unit, freq, sensitivity, "offBoxAllowed", description) VALUES ($1, 'count', 'D', 'ops', true, 'x')`, [`test.${id('k')}.count`]))).toBe('42501');
      expect(await state(a)).toEqual({ sensitivity: 'ops', offBoxAllowed: false });
      expect((await app(`SELECT count(*)::int AS n FROM "MetricSeries" WHERE "offBoxAllowed"`)).rows[0].n).toBe(0);
    });
  });

  describe('signing for Will', () => {
    it('it cannot write an approval, borrow one signed for another card, or run a card nobody signed', async () => {
      const a = await k.series();
      expect((await refusal(app(
        `INSERT INTO "Approval" (id, "subjectType", "subjectId", decision, payload, challenge, "credentialId", signature, "expiresAt") VALUES ('apprforged', 'proposal', 'p', 'approve', '{}', $1, $2, '\\x01', now() + interval '1 minute')`,
        [HEX('c'), k.credentialId]))).message).toMatch(/permission denied/);
      // A card of its own, never signed: it cannot be approved or made to execute.
      const own = await k.card('forecast.series.enable', enableArgs([a]), { stage: 'pending' });
      const mine = id('prop');
      await app(`INSERT INTO "Proposal" (id, kind, origin, action, args, "argsDigest", "argsProvenance", "expiresAt") SELECT $1, kind, origin, action, args, "argsDigest", '{}', "expiresAt" FROM "Proposal" WHERE id = $2`, [mine, own.pid]);
      expect(await k.outcome(app(`UPDATE "Proposal" SET status = 'executing' WHERE id = $1`, [mine]))).not.toBe('ok');
      // Will's approval of the first card does not approve the copy (it names its subject).
      expect(await k.outcome(app(`UPDATE "Proposal" SET status = 'approved', "approvalId" = $2 WHERE id = $1`, [mine, own.aid]))).not.toBe('ok');
      // Nor does his approval of something else approve a predictions card.
      const other = await k.card('world.sync.git', { source: 'git' }, { stage: 'pending' });
      expect(await k.outcome(app(`UPDATE "Proposal" SET status = 'approved', "approvalId" = $2 WHERE id = $1`, [own.pid, other.aid]))).not.toBe('ok');
      // And naming an approval of another kind of card on the row turns nothing on.
      const git = await k.card('world.sync.git', { source: 'git', n: 1 });
      expect(await code(k.switchOn(app, a, git.aid))).toBe('42501');
      expect(await isOn(a)).toBeNull();
    });

    it('it cannot widen what he signed: another number, the local model\'s estimate, or a change to the card after his signature', async () => {
      const [a, b] = [await k.series(), await k.series()];
      const signed = await k.card('forecast.series.enable', enableArgs([a]));
      expect(await code(k.switchOn(app, b, signed.aid))).toBe('42501');
      expect(await code(k.switchOn(app, a, signed.aid, true))).toBe('42501');
      // The card's args never change once filed; its digest could not be made to match other args anyway.
      for (const set of [`args = '{"series":["x.y"],"reason":[]}'::jsonb`, `"argsDigest" = '${HEX('b')}'`, `action = 'forecast.series.offbox'`, `origin = 'cli'`, `tainted = true`, `"expiresAt" = now() + interval '30 days'`]) {
        expect(await k.outcome(app(`UPDATE "Proposal" SET ${set} WHERE id = $1`, [signed.pid])), set).not.toBe('ok');
      }
      // A card filed with a digest of other args is never there to sign.
      expect(await code(app(`INSERT INTO "Proposal" (id, kind, origin, action, args, "argsDigest", "argsProvenance", "expiresAt") VALUES ($1, 'tool_call', 'console', 'forecast.series.enable', $2::jsonb, $3, '{}', now() + interval '1 hour')`,
        [id('prop'), JSON.stringify(enableArgs([a, b])), (await app(`SELECT "argsDigest" FROM "Proposal" WHERE id = $1`, [signed.pid])).rows[0].argsDigest]))).toBe('42501');
      expect(await isOn(b)).toBeNull();
      await k.switchOn(app, a, signed.aid);
      expect(await isOn(a)).toEqual({ on: true, reason: false });
    });

    it('a card filed to slip into an approve-all (no own-touch mark, or labelled ops while it lists a spend series) turns nothing on once signed', async () => {
      const [fin, hours, ops] = [await k.series({ unit: 'usd', sensitivity: 'financial' }), await k.series({ unit: 'hours', sensitivity: 'personal' }), await k.series()];
      const unmarked = await k.card('forecast.series.enable', enableArgs([fin, hours, ops]), { consequential: false, sensitivity: 'financial' });
      for (const key of [fin, hours, ops]) expect(await code(k.switchOn(app, key, unmarked.aid)), key).toBe('42501');
      const labelledOps = await k.card('forecast.series.enable', enableArgs([fin, hours, ops]), { sensitivity: 'ops' });
      expect(await code(k.switchOn(app, fin, labelledOps.aid))).toBe('42501');
      expect(await code(k.switchOn(app, hours, labelledOps.aid))).toBe('42501');
      // The marks cannot be put on afterwards: what was proposed never changes.
      for (const set of [`consequential = true`, `sensitivity = 'financial'`]) expect(await k.outcome(app(`UPDATE "Proposal" SET ${set} WHERE id IN ($1, $2)`, [unmarked.pid, labelledOps.pid])), set).not.toBe('ok');
      expect([await isOn(fin), await isOn(hours)]).toEqual([null, null]);
    });

    it('a card Will signed that was filed from chat, marked tainted or under another kind turns nothing on', async () => {
      for (const [label, o] of [['from chat', { origin: 'chat:conv1' }], ['from a job', { origin: 'runtime:forecast' }], ['tainted', { tainted: true }], ['kind policy', { kind: 'policy' }]] as const) {
        const a = await k.series();
        // (A runtime card needs a template to be filed at all: P1's rule.)
        if (o && 'origin' in o && o.origin.startsWith('runtime:')) {
          expect(await k.outcome(k.card('forecast.series.enable', enableArgs([a]), o)), label).not.toBe('ok');
          continue;
        }
        const c = await k.card('forecast.series.enable', enableArgs([a]), o);
        expect(await code(k.switchOn(app, a, c.aid)), label).toBe('42501');
        expect(await isOn(a), label).toBeNull();
      }
    });
  });

  describe('using one approval twice', () => {
    it('in turn: a card left executing never turns a number back on after Will turned it off', async () => {
      const a = await k.series();
      const c = await k.card('forecast.series.enable', enableArgs([a], [a]));
      await k.switchOn(app, a, c.aid, true);
      // The runtime never completes the card. Will turns the number off in the console (unsigned).
      await k.inTx((q) => q(`UPDATE "ForecastSeries" SET "on" = false, reason = false WHERE "seriesKey" = $1`, [a]), { actor: 'will:console' });
      for (const set of [`"on" = true`, `"on" = true, reason = true`, `"on" = true, "approvalId" = '${c.aid}'`, `"on" = true, "enabledAt" = now()`]) {
        expect(await code(app(`UPDATE "ForecastSeries" SET ${set} WHERE "seriesKey" = $1`, [a])), set).toBe('42501');
      }
      // Nor through an upsert, whose insert half is checked like any insert.
      expect(await code(app(`INSERT INTO "ForecastSeries" ("seriesKey", "on", reason, "approvalId") VALUES ($1, true, false, $2) ON CONFLICT ("seriesKey") DO UPDATE SET "on" = true`, [a, c.aid]))).toBe('42501');
      expect(await isOn(a)).toEqual({ on: false, reason: false });
      // No forecast can be recorded for it meanwhile.
      expect(await code(k.run(a))).toBe('42501');
    });

    it('at once: two transactions with the same approval, and only the first to use it turns anything on', async () => {
      const [a, b] = [await k.series(), await k.series()];
      const c = await k.card('forecast.series.enable', enableArgs([a, b]));
      const [t1, t2] = [await k.client(), await k.client()];
      try {
        await t1.query('BEGIN');
        await t2.query('BEGIN');
        await k.switchOn(k.on(t1), a, c.aid);
        // The second waits on the first's use of the approval, then is refused.
        const second = k.outcome(k.switchOn(k.on(t2), b, c.aid));
        await sleep(300);
        await t1.query('COMMIT');
        expect(await second).toBe('42501');
        await t2.query('ROLLBACK');
      } finally {
        await t1.end();
        await t2.end();
      }
      expect([await isOn(a), await isOn(b)]).toEqual([{ on: true, reason: false }, null]);
      // Had the first rolled back instead, the approval would still be Will's to use: nothing is spent by a failure.
      const [x, y] = [await k.series(), await k.series()];
      const d = await k.card('forecast.series.enable', enableArgs([x, y]));
      await k.inTx((q) => k.switchOn(q, x, d.aid), { commit: false });
      await k.inTx(async (q) => {
        await k.switchOn(q, x, d.aid);
        await k.switchOn(q, y, d.aid);
      });
      expect([await isOn(x), await isOn(y)]).toEqual([{ on: true, reason: false }, { on: true, reason: false }]);
    });

    it('from an old snapshot: a transaction opened while the card was executing gains nothing once it has run', async () => {
      for (const iso of ['REPEATABLE READ', 'SERIALIZABLE']) {
        const a = await k.series();
        const c = await k.card('forecast.series.enable', enableArgs([a]));
        const stale = await k.client();
        try {
          await stale.query(`BEGIN ISOLATION LEVEL ${iso}`);
          await stale.query('SELECT count(*) FROM "Proposal"');
          // Meanwhile the card runs and completes, and Will turns the number off.
          await k.switchOn(app, a, c.aid);
          await k.finish(c.pid);
          await app(`UPDATE "ForecastSeries" SET "on" = false WHERE "seriesKey" = $1`, [a]);
          // The stale transaction still sees the card executing and the row absent: it is refused for what it is.
          expect(await code(k.switchOn(k.on(stale), a, c.aid)), iso).toBe('40001');
          await stale.query('ROLLBACK');
        } finally {
          await stale.end();
        }
        expect(await code(app(`UPDATE "ForecastSeries" SET "on" = true WHERE "seriesKey" = $1`, [a])), iso).toBe('42501');
        expect(await isOn(a), iso).toEqual({ on: false, reason: false });
      }
    });

    it('after it expired: a transaction opened before the card\'s expiry cannot use it afterwards', async () => {
      const a = await k.series();
      const c = await k.card('forecast.series.enable', enableArgs([a]), { life: '2 seconds' });
      const t = await k.client();
      try {
        await t.query('BEGIN');
        await t.query('SELECT now()');
        await sleep(2300);
        expect(await code(k.switchOn(k.on(t), a, c.aid))).toBe('42501');
        await t.query('ROLLBACK');
      } finally {
        await t.end();
      }
      expect(await isOn(a)).toBeNull();
    });

    it('by keeping it: a card filed to stay good for months, signed today, turns nothing on', async () => {
      const a = await k.series();
      const sleeper = await k.card('forecast.series.enable', enableArgs([a]), { life: '170 days', stage: 'approved' });
      // Months later (here: now) the runtime claims it. The claim itself is P1's to allow; the turn-on is not.
      await app(`UPDATE "Proposal" SET status = 'executing' WHERE id = $1`, [sleeper.pid]);
      expect(await code(k.switchOn(app, a, sleeper.aid))).toBe('42501');
      expect(await isOn(a)).toBeNull();
    });

    it('by spending it: calling the approval helper by hand, or trying a change that does not land, uses nothing, so it cannot burn Will\'s card', async () => {
      const a = await k.series();
      const c = await k.card('forecast.series.enable', enableArgs([a]));
      expect(await code(app(`SELECT p4_bind_approval($1, 'forecast.series.enable')`, [c.aid]))).toBe('42501');
      expect(await code(app(`SELECT p4_bind_approval(p."approvalId", 'forecast.series.enable') FROM "Proposal" p WHERE p.id = $1`, [c.pid]))).toBe('42501');
      // From inside a statement that fires other tables' triggers, the call is still not a guard's.
      expect(await k.outcome(app(
        `WITH spend AS (SELECT p4_bind_approval($2, 'forecast.series.enable'))
         INSERT INTO "MetricSeries" (key, unit, freq, sensitivity, description) SELECT $1, 'count', 'D', 'ops', 'synthetic' FROM spend`, [`test.${id('k')}.count`, c.aid]))).toBe('42501');
      // A turn-on rolled back, and one that fails part-way, leave it unused.
      await k.inTx((q) => k.switchOn(q, a, c.aid), { commit: false });
      expect(await k.outcome(app(`INSERT INTO "ForecastSeries" ("seriesKey", "on", reason, "approvalId") VALUES ($1, true, false, $2), ($1, true, false, $2)`, [a, c.aid]))).not.toBe('ok');
      expect((await owner(`SELECT count(*)::int AS n FROM "ForecastApprovalUse" WHERE "approvalId" = $1`, [c.aid])).rows[0].n).toBe(0);
      await k.switchOn(app, a, c.aid);
      expect(await isOn(a)).toEqual({ on: true, reason: false });
    });
  });

  describe('forecasting what Will did not turn on, and mislabeling a forecast', () => {
    it('no run, and so no forecast prediction, for a number that is off; none for the local model where he did not sign it', async () => {
      const off = await k.series();
      expect(await code(k.run(off))).toBe('42501');
      // A prediction cannot claim a forecast without a run, or borrow another series' run.
      expect(await code(k.prediction({ method: 'statistical', seriesKey: off, createdBy: 'runtime:forecast', resolver: 'auto_metric' }))).toBe('23514');
      const on = await k.onSeries();
      const rid = await k.run(on);
      expect(await code(k.question(off, rid))).toBe('23514');
      expect(await code(k.question(on, rid, { method: 'model_reasoning', createdBy: 'runtime:reason' }))).toBe('42501');
      expect((await app(`SELECT count(*)::int AS n FROM "Prediction" WHERE "seriesKey" = $1`, [off])).rows[0].n).toBe(0);
    });

    it('a number Will turned off gets no more predictions from the runs it already has, and a run\'s record is not padded with copies', async () => {
      const key = await k.onSeries();
      const rid = await k.run(key);
      await k.question(key, rid);
      // Copies of the same call on the same run, to pad the count of scored predictions.
      for (let i = 0; i < 3; i++) expect(await code(k.question(key, rid, { probability: 0.6 + i / 100 })), String(i)).toBe('23505');
      await k.inTx((q) => q(`UPDATE "ForecastSeries" SET "on" = false WHERE "seriesKey" = $1`, [key]), { actor: 'will:console' });
      expect(await code(k.range(key, rid))).toBe('42501');
      expect(await code(k.run(key))).toBe('42501');
      expect((await app(`SELECT count(*)::int AS n FROM "Prediction" WHERE "forecastRunId" = $1`, [rid])).rows[0].n).toBe(1);
    });

    it('a forecast is called statistical only when its run beat naive, and a run cannot be edited to say it did', async () => {
      const key = await k.onSeries();
      const lost = await k.run(key, { beatsNaive: false, naiveMase: 0.8, modelMase: 0.9 });
      expect(await code(k.question(key, lost))).toBe('42501');
      expect(await code(k.range(key, lost))).toBe('42501');
      expect((await refusal(app(`UPDATE "ForecastRun" SET "beatsNaive" = true, "modelMase" = 0.1 WHERE id = $1`, [lost]))).message).toMatch(/permission denied/);
      // Nor is a made-up win hidden behind honest-looking scores: a win has the lower error.
      expect(await code(k.run(key, { beatsNaive: true, naiveMase: 0.8, modelMase: 0.9 }))).toBe('23514');
      // And a run that won cannot be played down as a base rate (the record would then understate the method).
      expect(await code(k.question(key, await k.run(key), { method: 'base_rate' }))).toBe('42501');
      expect((await app(`SELECT count(*)::int AS n FROM "Prediction" WHERE "forecastRunId" = $1`, [lost])).rows[0].n).toBe(0);
    });
  });

  describe('settling Will\'s predictions, and erasing the record', () => {
    it('a goal\'s finishing card left executing gives no cover later: a forecast written afterwards is not resolved "as Will"', async () => {
      const DEF = { title: 'Synthetic goal title', description: 'Synthetic goal description', successCriteria: [{ id: 'c1', text: 'Synthetic check text', check: { kind: 'manual' } }], horizonAt: '2027-03-01T00:00:00.000Z', reviewCadence: 'P1W' };
      const gid = id('go');
      await app(`INSERT INTO "Goal" (id, title, description, owner, origin, "successCriteria", "horizonAt", "reviewCadence", "updatedAt") VALUES ($1, $2, $3, 'will', 'will', $4::jsonb, $5, $6, now())`,
        [gid, DEF.title, DEF.description, JSON.stringify(DEF.successCriteria), DEF.horizonAt, DEF.reviewCadence]);
      const activate = await k.card('goal.activate', { goalId: gid, owner: 'will', origin: 'will', sensitivity: 'personal', tainted: false, nexusProjectId: null, ...DEF, links: [], plan: null }, { kind: 'goal' });
      await app(`UPDATE "Goal" SET status = 'active', "approvalId" = $2, "nextReviewAt" = now(), title = $3, description = $4, "successCriteria" = $5::jsonb, "horizonAt" = $6, "reviewCadence" = $7 WHERE id = $1`,
        [gid, activate.aid, DEF.title, DEF.description, JSON.stringify(DEF.successCriteria), DEF.horizonAt, DEF.reviewCadence]);
      // Will signs goal.done; the runtime finishes the goal and never completes the card.
      const done = await k.card('goal.done', { goalId: gid, goalTitle: DEF.title }, { kind: 'goal' });
      await app(`UPDATE "Goal" SET status = 'done', "approvalId" = $2 WHERE id = $1`, [gid, done.aid]);
      // Later it writes a forecast of that goal (as the goals writer, certain, for Will alone to resolve) and resolves it "as Will".
      const pid = await k.prediction({ method: 'human', probability: 1, domain: 'goals', type: 'deadline_met', resolver: 'will', createdBy: 'runtime:goals', goalId: gid });
      for (const outcome of [true, false]) {
        expect(await code(app(`INSERT INTO "Resolution" (id, "predictionId", outcome, "eventAt", "resolvedBy") VALUES ($1, $2, $3, now(), 'will')`, [id('rs'), pid, outcome])), String(outcome)).toBe('42501');
      }
      expect((await app(`SELECT status FROM "Prediction" WHERE id = $1`, [pid])).rows[0].status).toBe('open');
    });

    it('a prediction only Will resolves is not settled without his answer, by any resolver or statement shape', async () => {
      const pid = await k.prediction({ method: 'model_reasoning', resolver: 'will', resolveIn: '1 second', createdBy: 'server' });
      await sleep(1200);
      const resolve = (by: string, extra = '') => app(`INSERT INTO "Resolution" (id, "predictionId", outcome, "eventAt", "resolvedBy") VALUES ($1, $2, true, now(), $3) ${extra}`, [id('rs'), pid, by]);
      for (const by of ['will', 'auto_world', 'auto_metric']) expect(await k.outcome(resolve(by)), by).not.toBe('ok');
      expect(await k.outcome(resolve('will', 'ON CONFLICT DO NOTHING'))).not.toBe('ok');
      // A question it asks but nobody answers settles nothing; nor does an answer written without saying it is Will's.
      await app(`INSERT INTO "PredictionQuestion" ("predictionId") VALUES ($1)`, [pid]);
      expect(await code(resolve('will'))).toBe('42501');
      expect(await code(app(`UPDATE "PredictionQuestion" SET answer = 'yes', "answeredAt" = now() WHERE "predictionId" = $1`, [pid]))).toBe('42501');
      expect(await code(app(`INSERT INTO "PredictionQuestion" ("predictionId", answer, "answeredAt") VALUES ($1, 'yes', now()) ON CONFLICT ("predictionId") DO UPDATE SET answer = 'yes', "answeredAt" = now()`, [pid]))).toBe('42501');
      // It cannot close the prediction around the rule either.
      expect(await k.outcome(app(`UPDATE "Prediction" SET status = 'resolved' WHERE id = $1`, [pid]))).not.toBe('ok');
      expect(await k.outcome(app(`UPDATE "Prediction" SET resolver = 'auto_world' WHERE id = $1`, [pid]))).not.toBe('ok');
      expect((await app(`SELECT status FROM "Prediction" WHERE id = $1`, [pid])).rows[0].status).toBe('open');
    });

    it('nothing recorded is deleted, truncated or rewritten, and a temp table cannot stand in for a P4 table', async () => {
      const key = await k.onSeries();
      const rid = await k.run(key);
      for (const t of ['ForecastRun', 'ForecastSeries', 'PredictionQuestion', 'ForecastApprovalUse']) {
        expect((await refusal(app(`DELETE FROM "${t}"`))).message, t).toMatch(/permission denied/);
        expect((await refusal(app(`TRUNCATE "${t}" CASCADE`))).message, t).toMatch(/permission denied/);
      }
      expect((await refusal(app(`UPDATE "ForecastRun" SET points = '[]' WHERE id = $1`, [rid]))).message).toMatch(/permission denied/);
      expect((await refusal(app(`UPDATE "ForecastSeries" SET "seriesKey" = 'x.y' WHERE "seriesKey" = $1`, [key]))).message).toMatch(/permission denied/);
      expect((await refusal(app(`UPDATE "RowChange" SET actor = 'will:console' WHERE "tableName" = 'ForecastSeries'`))).message).toMatch(/permission denied/);
      expect((await refusal(app(`DELETE FROM "RowChange" WHERE "tableName" = 'ForecastSeries'`))).message).toMatch(/permission denied/);
      expect((await refusal(app(`CREATE TEMP TABLE "ForecastSeries" ("seriesKey" text, "on" boolean)`))).message).toMatch(/permission denied/);
      expect((await refusal(app(`CREATE TABLE public."ForecastSeriesShadow" (k text)`))).message).toMatch(/permission denied/);
      expect((await app(`SELECT count(*)::int AS n FROM "ForecastRun" WHERE id = $1`, [rid])).rows[0].n).toBe(1);
    });
  });

  describe('what the database does not prove (the runtime writes these itself)', () => {
    it('a run\'s arithmetic: for a number that is on, the runtime says whether its forecast beat naive', async () => {
      // The method on a prediction is held to the run; the run's own verdict is the forecaster's word.
      const key = await k.onSeries();
      expect(await k.outcome(k.run(key, { beatsNaive: true, naiveMase: 2, modelMase: 0.01 }))).toBe('ok');
    });

    it('that an answer is Will\'s: flint.actor is a label a session sets, so the rule catches a writer that forgot it, not one that lies', async () => {
      const pid = await k.prediction({ method: 'model_reasoning', resolver: 'will', resolveIn: '1 second', createdBy: 'server' });
      await sleep(1200);
      await app(`INSERT INTO "PredictionQuestion" ("predictionId") VALUES ($1)`, [pid]);
      expect(await k.outcome(k.inTx((q) => q(`UPDATE "PredictionQuestion" SET answer = 'yes' WHERE "predictionId" = $1`, [pid]), { actor: 'will:console' }))).toBe('ok');
    });
  });
});
