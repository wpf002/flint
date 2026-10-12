/**
 * What the database guarantees about forecasts (P4 part 1), whatever the
 * runtime's code does. Raw SQL as flint_app on flint_test, each rule both ways
 * (allowed and refused):
 *
 *  - a series' sensitivity never changes, and no series is ever marked as
 *    allowed to leave this Mac, by any role or under any card (exit 6);
 *  - a number is forecast only once the signed forecast.series.enable card
 *    turns it on; turning off is free;
 *  - a run is recorded only for a number that is on, and every run is local;
 *    runs are append-only;
 *  - `statistical` only on a run that beat naive, `base_rate` only on one that
 *    did not (exit 2);
 *  - Will's questions are asked once, about what only he resolves, and a
 *    resolution recorded as his needs his answer (or the card that finished
 *    its goal);
 *  - ECE and the Brier interval only at 100 scored (exit 4);
 *  - a refused metric point names its series, never its value.
 * Synthetic series only.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { digestOf } from '@flint/policy';
import { parseHealthExtra } from '../src/config';
import { healthSeries } from '../src/retention';
import { LOCAL_HEALTH } from '../src/sources/registry';
import { NO_DB, freshDb, id, HEX } from './db';
import { CANARY, p4Kit, refusal, sleep, type P4Kit, type Q } from './p4';

describe.skipIf(NO_DB)('P4 guards in the database', () => {
  let k: P4Kit;
  let app: Q;
  let owner: Q;
  const code = (p: Promise<unknown>) => k.code(p);
  const enableArgs = (series: string[], reason: string[] = []) => ({ series: [...series].sort(), reason: [...reason].sort() });

  beforeAll(async () => {
    k = await p4Kit(await freshDb());
    ({ app, owner } = k);
  });

  describe('the migration\'s own shape', () => {
    it('every function it makes pins its search_path and none can be executed by PUBLIC; only the two that must are SECURITY DEFINER', async () => {
      const fns = ['p4_signed_proposal', 'p4_bind_approval', 'metric_series_guard', 'metric_point_valid', 'forecast_series_guard', 'forecast_series_bind', 'forecast_series_history',
        'forecast_run_check', 'forecast_run_valid', 'prediction_forecast_check', 'prediction_valid', 'prediction_update_valid', 'prediction_question_guard', 'resolution_will_check', 'resolution_valid'];
      const r = await owner(
        `SELECT p.proname, p.prosecdef, coalesce(array_to_string(p.proconfig, ';'), '') AS config,
                (p.proacl IS NULL OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')) AS public
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = ANY ($1) ORDER BY 1`, [fns]);
      expect(r.rows.map((x) => x.proname)).toEqual([...fns].sort());
      for (const f of r.rows) {
        expect(f.config, f.proname).toBe('search_path=public, pg_temp');
        expect(f.public, f.proname).toBe(false);
        expect(f.prosecdef, f.proname).toBe(['p4_bind_approval', 'forecast_series_history'].includes(f.proname));
      }
      // No pattern in them uses a backslash, so none depends on a session's standard_conforming_strings.
      const bodies = await owner(`SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = ANY ($1) AND position(chr(92) in p.prosrc) > 0`, [fns]);
      expect(bodies.rows).toEqual([]);
    });

    it('flint_app has no grant at all on the record of used approvals, and no DELETE on any P4 table', async () => {
      const r = await owner(
        `SELECT table_name, string_agg(DISTINCT privilege_type, ',' ORDER BY privilege_type) AS p FROM information_schema.role_table_grants
         WHERE grantee IN ('flint_app', 'flint_approver', 'PUBLIC') AND table_name IN ('ForecastRun', 'ForecastSeries', 'PredictionQuestion', 'ForecastApprovalUse') GROUP BY 1 ORDER BY 1`);
      expect(r.rows).toEqual([{ table_name: 'ForecastRun', p: 'INSERT,SELECT' }, { table_name: 'ForecastSeries', p: 'INSERT,SELECT' }, { table_name: 'PredictionQuestion', p: 'INSERT,SELECT' }]);
      expect((await refusal(app(`SELECT * FROM "ForecastApprovalUse"`))).message).toMatch(/permission denied/);
      expect((await refusal(app(`INSERT INTO "ForecastApprovalUse" ("approvalId", action, xact) VALUES ('x', 'forecast.series.enable', '1')`))).message).toMatch(/permission denied/);
      for (const t of ['ForecastRun', 'ForecastSeries', 'PredictionQuestion']) expect((await refusal(app(`DELETE FROM "${t}"`))).message, t).toMatch(/permission denied/);
    });

    it('what Will signs is what is stored: a forecast card whose digest is not its args\' digest is never filed', async () => {
      const args = enableArgs(['daily.deploys.count']);
      const file = (action: string, digest: string, a: unknown = args) =>
        app(`INSERT INTO "Proposal" (id, kind, origin, action, args, "argsDigest", "argsProvenance", "expiresAt") VALUES ($1, 'tool_call', 'console', $2, $3::jsonb, $4, '{}', now() + interval '1 hour')`,
          [id('prop'), action, JSON.stringify(a), digest]);
      expect(await code(file('forecast.series.enable', HEX('a')))).toBe('42501');
      expect(await code(file('forecast.series.enable', digestOf(enableArgs(['daily.calendar.hours']))))).toBe('42501');
      expect(await k.outcome(file('forecast.series.enable', digestOf(args)))).toBe('ok');
      // Other kinds of card are untouched by this trigger (P1's rules for them stand).
      expect(await k.outcome(file('world.sync.git', HEX('a')))).toBe('ok');
    });
  });

  describe('series: what a number is', () => {
    it('a series is born on this Mac only, never already forgotten, and under the label the database can tell: money is financial, the calendar is never ops', async () => {
      const ins = (sensitivity: string, unit: string, offBox: boolean, key = `test.${id('k')}.x`, description = 'synthetic') =>
        app(`INSERT INTO "MetricSeries" (key, unit, freq, sensitivity, "offBoxAllowed", description) VALUES ($1, $2, 'D', $3, $4, $5)`, [key, unit, sensitivity, offBox, description]);
      expect(await code(ins('ops', 'count', true))).toBe('42501');
      expect(await code(ins('financial', 'usd', true))).toBe('42501');
      // Dollars, in any case, and anything with a `spend` segment in its key.
      for (const unit of ['usd', 'USD', 'Usd']) {
        expect(await code(ins('ops', unit, false)), unit).toBe('23514');
        expect(await code(ins('personal', unit, false)), unit).toBe('23514');
      }
      for (const key of [`daily.spend.${id('v')}.count`, `spend.${id('v')}.day.cents`, `test.${id('v')}.spend`]) {
        const e = await refusal(ins('ops', 'count', false, key));
        expect([e.code, e.message, e.detail], key).toEqual(['23514', `series ${key}: a series in dollars, or of spend, is financial`, undefined]);
        expect(await k.outcome(ins('financial', 'count', false, key)), key).toBe('ok');
      }
      expect(await k.outcome(ins('financial', 'usd', false))).toBe('ok');
      // The calendar is personal (or financial), never ops; a source that merely has "calendar" in its name is not the calendar.
      const cal = `daily.calendar.${id('v')}`;
      expect(await code(ins('ops', 'hours', false, cal))).toBe('23514');
      expect(await k.outcome(ins('personal', 'hours', false, cal))).toBe('ok');
      expect(await k.outcome(ins('ops', 'ms', false, `apple_calendar.${id('v')}`))).toBe('ok');
      expect(await k.outcome(ins('ops', 'count', false))).toBe('ok');
      expect(await k.outcome(ins('personal', 'hours', false))).toBe('ok');
      // Only a forget marks a series forgotten: not a writer at birth.
      expect(await code(ins('ops', 'count', false, `test.${id('k')}.x`, '[forgotten]'))).toBe('42501');
      // Underneath the guard, plain CHECKs say the same of every row (and did of the rows already there).
      expect((await owner(`SELECT conname FROM pg_constraint WHERE conname IN ('MetricSeries_money_check', 'MetricSeries_calendar_check') ORDER BY 1`)).rows.map((r) => r.conname))
        .toEqual(['MetricSeries_calendar_check', 'MetricSeries_money_check']);
    });

    it('every ops series the runtime already writes is still born: health checks, calendar lag, daily health shares and the daily rollups', async () => {
      // The names a health check may have (HEALTH_EXTRA refuses `spend` and `calendar`: see config.test.ts), and what is built in.
      const extra = parseHealthExtra('nexus-mcp=https://nexus.example.app/health,spend-api=https://h.example/health,calendar_sync=https://h.example/health');
      const rollups = [...readFileSync(join(__dirname, '..', 'src', 'rollup.ts'), 'utf8').matchAll(/^  '(p2\.[a-z0-9_.]+)': \{ unit: '([a-z]+)'/gm)].map((m) => [m[1]!, m[2]!] as const);
      expect(rollups.length).toBeGreaterThanOrEqual(7);
      const keys: Array<readonly [string, string, string]> = [
        ...[...LOCAL_HEALTH, ...extra].map((h) => [`health.${h.name}.latency_ms`, 'ms', 'raw'] as const),
        ...['google_calendar', 'apple_calendar'].map((source) => [`${source}.lag_ms`, 'ms', 'raw'] as const),
        ...['postgres', 'bus', 'server', 'backup', 'offsite_backup', 'triage', 'goals', 'source:spend', 'source:google_calendar', 'source:apple_calendar', 'source:health'].map((c) => [healthSeries(c), 'share', 'D'] as const),
        ...rollups.map(([key, unit]) => [key, unit, 'D'] as const),
      ];
      for (const [key, unit, freq] of keys) {
        // As the writers send it: an upsert that changes nothing when the row is there.
        const insert = () => app(`INSERT INTO "MetricSeries" (key, unit, freq, sensitivity, description) VALUES ($1, $2, $3, 'ops', 'synthetic') ON CONFLICT (key) DO NOTHING`, [key, unit, freq]);
        expect(await k.outcome(insert()), key).toBe('ok');
        expect(await k.outcome(insert()), key).toBe('ok');
      }
      expect((await app(`SELECT count(*)::int AS n FROM "MetricSeries" WHERE key = ANY ($1) AND sensitivity = 'ops'`, [keys.map(([key]) => key)])).rows[0].n).toBe(keys.length);
    });

    it('its key, unit, step, sensitivity, birth time and entity never change; its description may', async () => {
      const fin = await k.series({ unit: 'usd', sensitivity: 'financial' });
      // The hole this closes: relabel a financial series as ops (then clear it to leave).
      const e = await refusal(app(`UPDATE "MetricSeries" SET sensitivity = 'ops' WHERE key = $1`, [fin]));
      expect(e.code).toBe('42501');
      expect(e.message).toBe(`series ${fin}: its sensitivity never changes`);
      for (const [col, value] of [['key', `test.${id('k')}.y`], ['unit', 'count'], ['freq', 'W'], ['sensitivity', 'personal'], ['"createdAt"', '2020-01-01T00:00:00Z']] as const) {
        expect(await code(app(`UPDATE "MetricSeries" SET ${col} = $2 WHERE key = $1`, [fin, value])), col).toBe('42501');
      }
      // As the owner too: the rule is the table's, not a grant's.
      expect(await code(owner(`UPDATE "MetricSeries" SET sensitivity = 'ops' WHERE key = $1`, [fin]))).toBe('42501');
      expect(await k.outcome(app(`UPDATE "MetricSeries" SET description = 'another synthetic description' WHERE key = $1`, [fin]))).toBe('ok');
      expect((await app(`SELECT sensitivity, unit, freq FROM "MetricSeries" WHERE key = $1`, [fin])).rows[0]).toEqual({ sensitivity: 'financial', unit: 'usd', freq: 'D' });
      // The entity is fixed at birth, both ways. A series born about none is never tied to one later (a forget of
      // that item would then stop the number for good); one born about an item is never moved or unlinked
      // (unlinking it would hide it from a forget). For the owner too.
      const [a, b] = [await k.entity(), await k.entity()];
      const late = await refusal(app(`UPDATE "MetricSeries" SET "entityId" = $2 WHERE key = $1`, [fin, a]));
      expect([late.code, late.message]).toEqual(['42501', `series ${fin}: its entityId never changes`]);
      expect(await code(owner(`UPDATE "MetricSeries" SET "entityId" = $2 WHERE key = $1`, [fin, a]))).toBe('42501');
      const born = await k.series({ entityId: a });
      expect(await code(app(`UPDATE "MetricSeries" SET "entityId" = $2 WHERE key = $1`, [born, b]))).toBe('42501');
      expect(await code(app(`UPDATE "MetricSeries" SET "entityId" = NULL WHERE key = $1`, [born]))).toBe('42501');
      expect((await app(`SELECT key, "entityId" FROM "MetricSeries" WHERE key IN ($1, $2) ORDER BY "entityId" NULLS FIRST`, [fin, born])).rows).toEqual([{ key: fin, entityId: null }, { key: born, entityId: a }]);
    });

    it('only a forget marks a series forgotten, and a forgotten series stays forgotten', async () => {
      // A runtime cannot write the mark itself (it would stop a number for good with one statement).
      const live = await k.series();
      const forged = await refusal(app(`UPDATE "MetricSeries" SET description = '[forgotten]' WHERE key = $1`, [live]));
      expect([forged.code, forged.message]).toEqual(['42501', `series ${live}: only a forget marks a series forgotten`]);
      expect(await code(owner(`UPDATE "MetricSeries" SET description = '[forgotten]' WHERE key = $1`, [live]))).toBe('42501');
      // Setting the label a forget needs, without being the forget, changes nothing.
      expect(await code(k.inTx(async (q) => {
        await q(`SELECT set_config('flint.forget_approval', 'apprforged', true)`);
        await q(`UPDATE "MetricSeries" SET description = '[forgotten]' WHERE key = $1`, [live]);
      }))).toBe('42501');
      // Will's signed forget of its entity does, through the database's own procedure.
      const eid = await k.entity();
      const key = await k.series({ entityId: eid, description: 'spend of a synthetic account' });
      await k.forget(eid);
      expect((await app(`SELECT description FROM "MetricSeries" WHERE key = $1`, [key])).rows[0].description).toBe('[forgotten]');
      expect(await code(app(`UPDATE "MetricSeries" SET description = 'spend of a synthetic account' WHERE key = $1`, [key]))).toBe('42501');
      expect(await code(owner(`UPDATE "MetricSeries" SET description = 'back again' WHERE key = $1`, [key]))).toBe('42501');
      expect((await app(`SELECT description FROM "MetricSeries" WHERE key = $1`, [live])).rows[0].description).toBe('a synthetic series');
    });

    it('no series is ever marked as allowed to leave this Mac: not by the runtime, not by the owner, not under any card Will signed', async () => {
      const clear = (key: string, q: Q = app) => q(`UPDATE "MetricSeries" SET "offBoxAllowed" = true WHERE key = $1`, [key]);
      for (const key of [await k.series(), await k.series({ unit: 'hours', sensitivity: 'personal' }), await k.series({ unit: 'usd', sensitivity: 'financial' })]) {
        const e = await refusal(clear(key));
        expect([e.code, e.message]).toEqual(['42501', `series ${key}: no series leaves this Mac`]);
        expect(await code(clear(key, owner)), key).toBe('42501');
        // A signed, executing card changes nothing: there is no card for this. Not the on-switch, not one under the name an earlier draft had.
        await k.card('forecast.series.enable', enableArgs([key]));
        await k.card('forecast.series.offbox', { seriesKey: key });
        expect(await code(clear(key)), key).toBe('42501');
        expect(await code(k.inTx((q) => clear(key, q), { actor: 'will:console' })), key).toBe('42501');
        expect((await app(`SELECT "offBoxAllowed" FROM "MetricSeries" WHERE key = $1`, [key])).rows[0].offBoxAllowed).toBe(false);
      }
      // Underneath the guard a plain CHECK says the same of every row (P1's own allowed it for an ops series).
      expect((await owner(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'MetricSeries_onbox_check'`)).rows.map((r) => r.def)).toEqual(['CHECK ((NOT "offBoxAllowed"))']);
      expect((await app(`SELECT count(*)::int AS n FROM "MetricSeries" WHERE "offBoxAllowed"`)).rows[0].n).toBe(0);
    });

    it('a card filed to outlive Will\'s signature by more than a week acts on nothing (it cannot be signed now and kept for later)', async () => {
      const a = await k.series();
      const sleeper = await k.card('forecast.series.enable', enableArgs([a]), { life: '60 days' });
      expect(await code(k.switchOn(app, a, sleeper.aid))).toBe('42501');
      const week = await k.card('forecast.series.enable', enableArgs([a]), { life: '7 days' });
      expect(await k.outcome(k.switchOn(app, a, week.aid))).toBe('ok');
    });
  });

  describe('the on-switch: which numbers are forecast', () => {
    it('a number is turned on only as the executing, signed card whose approval the row names says', async () => {
      const [a, b, c] = [await k.series(), await k.series(), await k.series()];
      // No card at all; an approval that is not one; a card that is only approved.
      expect(await code(k.switchOn(app, a, 'apprnone'))).toBe('42501');
      const waiting = await k.card('forecast.series.enable', enableArgs([a]), { stage: 'approved' });
      expect(await code(k.switchOn(app, a, waiting.aid))).toBe('42501');
      // A card for anything else is not the on-switch, whatever its args say.
      const other = await k.card('world.sync.git', enableArgs([a]));
      expect(await code(k.switchOn(app, a, other.aid))).toBe('42501');
      const signed = await k.card('forecast.series.enable', enableArgs([a, b], [b]));
      // A number the card did not list; the local model's estimate where the card did not sign it.
      expect(await code(k.switchOn(app, c, signed.aid))).toBe('42501');
      const e = await refusal(k.switchOn(app, a, signed.aid, true));
      expect(e.code).toBe('42501');
      expect(e.message).toBe(`forecast series ${a}: approval ${signed.aid} did not sign the local model's estimate of it`);
      // As signed, in one transaction: both rows, and the database's own times.
      await k.inTx(async (q) => {
        await q(`INSERT INTO "ForecastSeries" ("seriesKey", "on", reason, "approvalId", "enabledAt", "updatedAt") VALUES ($1, true, false, $2, '2020-01-01', '2020-01-01')`, [a, signed.aid]);
        await k.switchOn(q, b, signed.aid, true);
      });
      const rows = (await app(`SELECT "seriesKey", "on", reason, "approvalId", "enabledAt" > now() - interval '1 minute' AS fresh, "updatedAt" > now() - interval '1 minute' AS touched FROM "ForecastSeries" WHERE "seriesKey" = ANY ($1) ORDER BY 1`, [[a, b]])).rows;
      expect(rows).toEqual([a, b].sort().map((key) => ({ seriesKey: key, on: true, reason: key === b, approvalId: signed.aid, fresh: true, touched: true })));
    });

    it('a row is born on: a card turns a number on, and a row that is off or has no approval is never inserted', async () => {
      const a = await k.series();
      const signed = await k.card('forecast.series.enable', enableArgs([a]));
      expect(await code(app(`INSERT INTO "ForecastSeries" ("seriesKey", "on", reason, "approvalId") VALUES ($1, false, false, $2)`, [a, signed.aid]))).toBe('42501');
      expect(await code(app(`INSERT INTO "ForecastSeries" ("seriesKey", "on", reason, "approvalId") VALUES ($1, true, false, NULL)`, [a]))).toBe('42501');
      expect(await k.outcome(k.switchOn(app, a, signed.aid))).toBe('ok');
    });

    it('the card is marked for Will\'s own touch and is at least as sensitive as the number: one filed to slip into an approve-all turns nothing on', async () => {
      const [ops, personal, fin] = [await k.series(), await k.series({ unit: 'hours', sensitivity: 'personal' }), await k.series({ unit: 'usd', sensitivity: 'financial' })];
      const all = enableArgs([ops, personal, fin]);
      // Without the mark, whatever else is right.
      const unmarked = await k.card('forecast.series.enable', all, { consequential: false });
      for (const key of [ops, personal, fin]) expect(await code(k.switchOn(app, key, unmarked.aid)), key).toBe('42501');
      // An ops card turns on ops numbers only; a personal card, not a financial number; a financial card, all three.
      const asOps = await k.card('forecast.series.enable', all, { sensitivity: 'ops' });
      const e = await refusal(k.switchOn(app, fin, asOps.aid));
      expect([e.code, e.message]).toEqual(['42501', `forecast series ${fin}: approval ${asOps.aid} signed a card less sensitive than this number`]);
      expect(await code(k.switchOn(app, personal, asOps.aid))).toBe('42501');
      expect(await k.outcome(k.switchOn(app, ops, asOps.aid))).toBe('ok');
      const asPersonal = await k.card('forecast.series.enable', all, { sensitivity: 'personal' });
      expect(await code(k.switchOn(app, fin, asPersonal.aid))).toBe('42501');
      expect(await k.outcome(k.switchOn(app, personal, asPersonal.aid))).toBe('ok');
      const asFinancial = await k.card('forecast.series.enable', all, { sensitivity: 'financial' });
      expect(await k.outcome(k.inTx(async (q) => {
        await k.switchOn(q, fin, asFinancial.aid);
        await q(`UPDATE "ForecastSeries" SET "approvalId" = $2 WHERE "seriesKey" = ANY ($1)`, [[ops, personal], asFinancial.aid]);
      }))).toBe('ok');
    });

    it('an approval is spent by a change that landed, not by one that was only tried', async () => {
      const [a, b] = [await k.series(), await k.series()];
      await k.turnOn([a]);
      const c = await k.card('forecast.series.enable', enableArgs([a, b]));
      // An insert that meets the existing row and does nothing writes nothing, so it uses nothing.
      await app(`INSERT INTO "ForecastSeries" ("seriesKey", "on", reason, "approvalId") VALUES ($1, true, false, $2) ON CONFLICT ("seriesKey") DO NOTHING`, [a, c.aid]);
      expect((await owner(`SELECT count(*)::int AS n FROM "ForecastApprovalUse" WHERE "approvalId" = $1`, [c.aid])).rows[0].n).toBe(0);
      // So is a statement refused part-way: the first row's use goes with the statement.
      expect(await code(app(`INSERT INTO "ForecastSeries" ("seriesKey", "on", reason, "approvalId") VALUES ($1, true, false, $3), ($2, true, true, $3)`, [b, `test.${id('k')}.count`, c.aid]))).not.toBeUndefined();
      expect((await owner(`SELECT count(*)::int AS n FROM "ForecastApprovalUse" WHERE "approvalId" = $1`, [c.aid])).rows[0].n).toBe(0);
      // The card still does what it signed, once.
      await k.switchOn(app, b, c.aid);
      expect((await owner(`SELECT count(*)::int AS n FROM "ForecastApprovalUse" WHERE "approvalId" = $1`, [c.aid])).rows[0].n).toBe(1);
      expect(await code(app(`UPDATE "ForecastSeries" SET "approvalId" = $2 WHERE "seriesKey" = $1`, [a, c.aid]))).toBe('42501');
    });

    it('turning off is free; turning back on needs a new card (one approval, one transaction)', async () => {
      const a = await k.series();
      const first = await k.card('forecast.series.enable', enableArgs([a], [a]));
      await k.switchOn(app, a, first.aid, true);
      // The card is left executing, as a runtime that never completes it would leave it.
      const set = (sql: string, params: unknown[] = []) => app(`UPDATE "ForecastSeries" SET ${sql} WHERE "seriesKey" = $1`, [a, ...params]);
      expect(await k.outcome(set(`reason = false`))).toBe('ok');
      expect(await code(set(`reason = true`))).toBe('42501');
      // The local model's estimate is only for a number that is forecast (a plain CHECK: the row holds no numbers).
      expect(await k.outcome(set(`reason = false, "on" = false`))).toBe('ok');
      expect(await code(set(`"on" = true`))).toBe('42501');
      expect(await code(set(`"on" = true, "approvalId" = $2`, ['apprnone']))).toBe('42501');
      // Its approval and its enabled time are the card's too: neither is rewritten without one.
      expect(await code(set(`"approvalId" = $2`, ['apprnone']))).toBe('42501');
      expect(await code(set(`"enabledAt" = '2020-01-01'`))).toBe('42501');
      const second = await k.card('forecast.series.enable', enableArgs([a]));
      expect(await code(set(`"on" = true, reason = true, "approvalId" = $2`, [second.aid]))).toBe('42501');
      expect(await k.outcome(set(`"on" = true, "approvalId" = $2`, [second.aid]))).toBe('ok');
      expect((await app(`SELECT "on", reason, "approvalId" FROM "ForecastSeries" WHERE "seriesKey" = $1`, [a])).rows[0]).toEqual({ on: true, reason: false, approvalId: second.aid });
      // Turning a number off turns its estimate off with it (the plain CHECK: on, or no estimate).
      const b = await k.onSeries({ reason: true });
      const check = await refusal(app(`UPDATE "ForecastSeries" SET "on" = false WHERE "seriesKey" = $1`, [b]));
      expect(check.code).toBe('23514');
      expect(check.message).toMatch(/ForecastSeries_reason_check/);
      expect(await k.outcome(app(`UPDATE "ForecastSeries" SET "on" = false, reason = false WHERE "seriesKey" = $1`, [b]))).toBe('ok');
    });

    it('a signed change leaves the row within what its new approval signed (a later card that drops the estimate cannot carry it along)', async () => {
      const a = await k.series();
      await k.turnOn([a], [a]);
      const plain = await k.card('forecast.series.enable', enableArgs([a]));
      expect(await code(app(`UPDATE "ForecastSeries" SET "approvalId" = $2 WHERE "seriesKey" = $1`, [a, plain.aid]))).toBe('42501');
      expect(await k.outcome(app(`UPDATE "ForecastSeries" SET "approvalId" = $2, reason = false WHERE "seriesKey" = $1`, [a, plain.aid]))).toBe('ok');
    });

    it('never for a series that is not there or was forgotten, never above READ COMMITTED, never deleted, and its key never changes', async () => {
      const ghost = `test.${id('k')}.count`;
      const g = await k.card('forecast.series.enable', enableArgs([ghost]));
      expect(await code(k.switchOn(app, ghost, g.aid))).toBe('23514');
      const gone = await k.forgottenSeries();
      const f = await k.card('forecast.series.enable', enableArgs([gone]));
      expect(await code(k.switchOn(app, gone, f.aid))).toBe('23514');
      for (const iso of ['REPEATABLE READ', 'SERIALIZABLE']) {
        const a = await k.series();
        const c = await k.card('forecast.series.enable', enableArgs([a]));
        expect(await code(k.inTx((q) => k.switchOn(q, a, c.aid), { iso })), iso).toBe('40001');
        // Turning off needs no card and reads nothing: it works at any level.
        await k.switchOn(app, a, c.aid);
        expect(await k.outcome(k.inTx((q) => q(`UPDATE "ForecastSeries" SET "on" = false WHERE "seriesKey" = $1`, [a]), { iso })), iso).toBe('ok');
      }
      const a = await k.onSeries();
      expect((await refusal(app(`UPDATE "ForecastSeries" SET "seriesKey" = $2 WHERE "seriesKey" = $1`, [a, gone]))).message).toMatch(/permission denied/);
      expect(await code(owner(`UPDATE "ForecastSeries" SET "seriesKey" = $2 WHERE "seriesKey" = $1`, [a, gone]))).toBe('42501');
      expect(await code(owner(`DELETE FROM "ForecastSeries" WHERE "seriesKey" = $1`, [a]))).toBe('42501');
      expect(await code(owner(`TRUNCATE "ForecastSeries"`))).toBe('42501');
    });

    it('a card past its expiry, though still marked executing, turns nothing on; nor does one whose signing key was revoked', async () => {
      const a = await k.series();
      const late = await k.card('forecast.series.enable', enableArgs([a]), { life: '1 second' });
      await sleep(1100);
      expect(await code(k.switchOn(app, a, late.aid))).toBe('42501');
      const lost = id('cred');
      await k.approver(`INSERT INTO "ApprovalCredential" (id, "credentialId", factor, "publicKey", label, "enrolledVia") VALUES ($1, $2, 'webauthn', '\\x00', 'a lost key', 'enroll_code')`, [id(), lost]);
      const c = await k.card('forecast.series.enable', enableArgs([a]), { credential: lost });
      await k.approver(`UPDATE "ApprovalCredential" SET "revokedAt" = now() WHERE "credentialId" = $1`, [lost]);
      expect(await code(k.switchOn(app, a, c.aid))).toBe('42501');
    });

    it('every on and off is kept in RowChange with who did it; a write that changes nothing is not history', async () => {
      const a = await k.series();
      const c = await k.card('forecast.series.enable', enableArgs([a]));
      await k.inTx((q) => k.switchOn(q, a, c.aid), { actor: `will:approval:${c.aid}` });
      await k.inTx((q) => q(`UPDATE "ForecastSeries" SET "on" = false WHERE "seriesKey" = $1`, [a]), { actor: 'will:console' });
      await app(`UPDATE "ForecastSeries" SET "on" = false WHERE "seriesKey" = $1`, [a]);
      const h = (await owner(`SELECT actor, changed FROM "RowChange" WHERE "tableName" = 'ForecastSeries' AND "rowId" = $1 ORDER BY at, id`, [a])).rows;
      expect(h).toHaveLength(2);
      expect(h[0]).toMatchObject({ actor: `will:approval:${c.aid}`, changed: { on: [null, true], reason: [null, false], approvalId: [null, c.aid] } });
      expect(Object.keys(h[0].changed).sort()).toEqual(['approvalId', 'enabledAt', 'on', 'reason']);
      expect(h[1]).toEqual({ actor: 'will:console', changed: { on: [true, false] } });
      expect((await refusal(app(`INSERT INTO "RowChange" (id, "tableName", "rowId", actor, changed) VALUES ('x', 'ForecastSeries', $1, 'will:console', '{}')`, [a]))).message).toMatch(/permission denied/);
    });

    it('an approval is used only by the change it signed: a call of its own spends nothing and fills nothing', async () => {
      const a = await k.series();
      const c = await k.card('forecast.series.enable', enableArgs([a]));
      const before = (await owner(`SELECT count(*)::int AS n FROM "ForecastApprovalUse"`)).rows[0].n as number;
      // Even for the live card and its own action: only a guarded write uses it.
      const direct = await refusal(app(`SELECT p4_bind_approval($1, 'forecast.series.enable')`, [c.aid]));
      expect([direct.code, direct.message]).toEqual(['42501', 'forecast card: an approval is used only by the change it signed']);
      expect(await code(app(`SELECT p4_bind_approval($1, 'world.sync.git')`, [c.aid]))).toBe('42501');
      expect(await code(app(`SELECT p4_bind_approval($1, 'goal.done')`, [c.aid]))).toBe('42501');
      expect(await code(app(`SELECT p4_bind_approval('junk' || g, 'forecast.series.enable') FROM generate_series(1, 50) g`))).toBe('42501');
      expect(await code(app(`SELECT p4_signed_proposal($1, 'world.source.enable')`, [c.aid]))).toBe('42501');
      expect((await owner(`SELECT count(*)::int AS n FROM "ForecastApprovalUse"`)).rows[0].n).toBe(before);
      expect(await k.outcome(k.switchOn(app, a, c.aid))).toBe('ok');
    });
  });

  describe('forecast runs', () => {
    it('a run is recorded only for a number that is on, now, and never for a forgotten series', async () => {
      const off = await k.series();
      const e = await refusal(k.run(off));
      expect(e.code).toBe('42501');
      expect(e.message).toMatch(new RegExp(`^forecast run \\w+: series ${off.replace(/\./g, '\\.')} is not turned on$`));
      expect(await code(k.run(`test.${id('k')}.count`))).toBe('23514');
      const key = await k.onSeries();
      const rid = id('fr');
      await app(
        `INSERT INTO "ForecastRun" (id, "seriesKey", provider, endpoint, "requestDigest", horizon, level, points, "latencyMs", ok, "createdAt") VALUES ($1, $2, 'local', 'local:fc.v1', $3, 1, 0.8, $4::jsonb, 3, true, '2020-01-01')`,
        [rid, key, HEX('1'), JSON.stringify([k.point(4)])],
      );
      expect((await app(`SELECT "createdAt" > now() - interval '1 minute' AS fresh FROM "ForecastRun" WHERE id = $1`, [rid])).rows[0].fresh).toBe(true);
      // Turned off again: nothing more is forecast (what exists stays).
      await app(`UPDATE "ForecastSeries" SET "on" = false WHERE "seriesKey" = $1`, [key]);
      expect(await code(k.run(key))).toBe('42501');
      const gone = await k.forgottenSeries({ on: true });
      expect(await code(k.run(gone))).toBe('23514');
      for (const iso of ['REPEATABLE READ', 'SERIALIZABLE']) {
        const s = await k.onSeries();
        expect(await code(k.inTx((q) => k.run(s, {}, q), { iso })), iso).toBe('40001');
      }
    });

    it('every run is local: one from any other provider is never recorded, for any series (exit 6)', async () => {
      for (const key of [await k.onSeries(), await k.onSeries({ unit: 'usd', sensitivity: 'financial' })]) {
        for (const over of [{ provider: 'prophet', endpoint: '/forecast/adhoc' }, { provider: 'frontier' }, { provider: 'LOCAL' }, { provider: '' }]) {
          const e = await refusal(k.run(key, over));
          expect([e.code, e.detail], JSON.stringify(over)).toEqual(['23514', undefined]);
          expect(e.message, JSON.stringify(over)).toMatch(/^forecast run \w+: its provider is not valid$/);
        }
        expect(await k.outcome(k.run(key))).toBe('ok');
        expect((await app(`SELECT DISTINCT provider FROM "ForecastRun" WHERE "seriesKey" = $1`, [key])).rows).toEqual([{ provider: 'local' }]);
      }
    });

    it('is append-only for every role, and the same input forecast twice is one run', async () => {
      const key = await k.onSeries();
      const digest = digestOf({ once: id() });
      const rid = await k.run(key, { requestDigest: digest });
      expect((await refusal(app(`UPDATE "ForecastRun" SET "beatsNaive" = false WHERE id = $1`, [rid]))).message).toMatch(/permission denied/);
      expect((await refusal(owner(`UPDATE "ForecastRun" SET "beatsNaive" = false WHERE id = $1`, [rid]))).message).toMatch(/append-only/);
      expect((await refusal(owner(`DELETE FROM "ForecastRun" WHERE id = $1`, [rid]))).message).toMatch(/append-only/);
      // CASCADE reaches the ledger's tables too: whichever table's guard speaks first, nothing is truncated.
      expect((await refusal(owner(`TRUNCATE "ForecastRun" CASCADE`))).message).toMatch(/append-only|never deleted/);
      expect((await app(`SELECT count(*)::int AS n FROM "ForecastRun" WHERE id = $1`, [rid])).rows[0].n).toBe(1);
      expect(await code(k.run(key, { requestDigest: digest }))).toBe('23505');
      // A run that failed is not "the run": the retry may record one that worked.
      const failing = digestOf({ failing: id() });
      const failed = { ...k.failedRun(), requestDigest: failing };
      expect(await k.outcome(k.run(key, failed))).toBe('ok');
      expect(await k.outcome(k.run(key, failed))).toBe('ok');
      expect(await k.outcome(k.run(key, { requestDigest: failing }))).toBe('ok');
    });

    it('every rule a run has names the run and the rule, never a number it holds (no DETAIL)', async () => {
      const key = await k.onSeries({ unit: 'usd', sensitivity: 'financial' });
      const bad = async (rule: string, over: Parameters<P4Kit['run']>[1]) => {
        const r = k.runFields({ points: [k.point(CANARY, CANARY - 1, CANARY + 1)], scale: CANARY, ...over });
        const e = await refusal(k.run(key, r));
        expect(e.code, rule).toBe('23514');
        expect(e.message, rule).toBe(`forecast run ${r.id}: its ${rule} is not valid`);
        expect(e.detail, rule).toBeUndefined();
        expect(e.text, rule).not.toContain('31337');
      };
      for (const provider of ['prophet', 'frontier']) await bad('provider', { provider });
      const failed = { ok: false, beatsNaive: null, naiveMase: null, modelMase: null };
      // A failed run says a short code, never a sentence, and carries no scores.
      await bad('error', { ...failed, error: 'it was too short', points: [], scale: null });
      await bad('outcome', { ...failed, error: 'too_short', points: [] });
      await bad('outcome', { ...failed, error: 'too_short', points: [], scale: null, naiveMase: 1 });
      expect(await k.outcome(k.run(key, k.failedRun('timeout')))).toBe('ok');
      await bad('endpoint', { endpoint: 'https://example.invalid/forecast?x=1' });
      await bad('digest', { requestDigest: 'not-a-digest' });
      for (const horizon of [0, 721]) await bad('horizon', { horizon });
      for (const level of [0, 1, NaN]) await bad('level', { level });
      await bad('latency', { latencyMs: -1 });
      for (const v of [-0.1, NaN, Infinity]) {
        await bad('error scores', { naiveMase: v });
        await bad('error scores', { modelMase: v });
        await bad('error scores', { scale: v });
      }
      // A verdict has both scores; a run that beat naive has the lower one; a failed run has no verdict.
      await bad('verdict', { beatsNaive: true, modelMase: null });
      await bad('verdict', { beatsNaive: false, naiveMase: null });
      await bad('verdict', { beatsNaive: true, naiveMase: 1, modelMase: 1 });
      await bad('verdict', { beatsNaive: true, naiveMase: 1, modelMase: 1.5 });
      await bad('verdict', { ok: false, error: 'too_short', points: [], beatsNaive: false });
      await bad('error', { ...failed, error: `it said ${CANARY}; and "more"`, points: [] });
      await bad('error', { ...failed, error: 'x'.repeat(121), points: [] });
      await bad('points', { points: { at: 'x' } });
      await bad('points', { points: 'a string' });
      await bad('points', { points: Array.from({ length: 721 }, () => k.point(CANARY)) });
      await bad('points', { points: [{ ...k.point(CANARY), note: 'x'.repeat(70_000) }] });
      await bad('outcome', { error: 'too_short' });
      await bad('outcome', { ...failed, error: null, points: [] });
      await bad('outcome', { ...failed, error: 'too_short' });
      await bad('outcome', { points: [] });
      // Its points are numbers and times only: nothing else rides in a run.
      await bad('points', { points: [CANARY] });
      await bad('points', { points: [{ ...k.point(CANARY), note: 'words' }] });
      await bad('points', { points: [{ at: '2026-10-14T04:00:00.000Z', mean: CANARY, lo: CANARY }] });
      await bad('points', { points: [{ ...k.point(CANARY), at: 'tomorrow' }] });
      await bad('points', { points: [{ ...k.point(CANARY), at: 20261014 }] });
      await bad('points', { points: [{ ...k.point(CANARY), mean: String(CANARY) }] });
      await bad('points', { points: [k.point(CANARY, CANARY + 1, CANARY + 2)] });
      await bad('points', { points: [k.point(CANARY, CANARY - 2, CANARY - 1)] });
      await bad('points', { points: [k.point(4), null] });
      await bad('a required field', { points: null });
      await bad('a required field', { ok: null });
      // An id that is not an id is not repeated either.
      const weird = await refusal(k.run(key, { id: `run ${CANARY}` }));
      expect([weird.code, weird.message, weird.detail]).toEqual(['23514', 'forecast run: its id is not valid', undefined]);
      // And the allowed shapes: too short to validate (no verdict), did not beat naive, a week of points.
      expect(await k.outcome(k.run(key, { beatsNaive: null, naiveMase: null, modelMase: null, scale: null }))).toBe('ok');
      expect(await k.outcome(k.run(key, { beatsNaive: false, naiveMase: 0.8, modelMase: 0.9 }))).toBe('ok');
      expect(await k.outcome(k.run(key, { points: Array.from({ length: 7 }, (_, i) => k.point(i, i, i, `2026-10-${14 + i}T04:00:00.000Z`)), scale: 0 }))).toBe('ok');
    });
  });

  describe('a forecast\'s predictions', () => {
    it('`statistical` only on a local run that beat naive, `base_rate` only on one that did not (exit 2)', async () => {
      const key = await k.onSeries();
      const beat = await k.run(key);
      const lost = await k.run(key, { beatsNaive: false, naiveMase: 0.8, modelMase: 0.9 });
      const short = await k.run(key, { beatsNaive: null, naiveMase: null, modelMase: null });
      expect(await k.outcome(k.question(key, beat))).toBe('ok');
      expect(await k.outcome(k.range(key, beat))).toBe('ok');
      for (const [label, runId] of [['did not beat naive', lost], ['too short to tell', short]] as const) {
        const e = await refusal(k.question(key, runId));
        expect(e.code, label).toBe('42501');
        expect(e.message, label).toMatch(new RegExp(`^prediction \\w+: statistical only on a run that beat naive \\(run ${runId}\\)$`));
        expect(await k.outcome(k.question(key, runId, { method: 'base_rate' })), label).toBe('ok');
        expect(await k.outcome(k.range(key, runId, { method: 'base_rate' })), label).toBe('ok');
      }
      const e = await refusal(k.question(key, beat, { method: 'base_rate' }));
      expect(e.code).toBe('42501');
      expect(e.message).toMatch(/base_rate only on a run that did not beat naive/);
      // Nothing is recorded as Prophet's, on a run or off one: Flint calls no outside forecaster.
      for (const attempt of [async () => k.question(key, await k.run(key), { method: 'prophet' }), () => k.prediction({ method: 'prophet' }), () => k.prediction({ method: 'prophet', createdBy: 'server', resolver: 'will' })]) {
        const p = await refusal(attempt());
        expect([p.code, p.detail]).toEqual(['23514', undefined]);
        expect(p.message).toMatch(/^prediction \w+: its method is not valid$/);
      }
    });

    it('it names an ok run of its own series; a run and a series are named together; a forecast method names its run', async () => {
      const [a, b] = [await k.onSeries(), await k.onSeries()];
      const runA = await k.run(a);
      const failed = await k.run(a, k.failedRun());
      expect(await code(k.question(b, runA))).toBe('23514');
      expect(await code(k.question(a, failed, { method: 'base_rate' }))).toBe('23514');
      expect(await code(k.question(a, 'frnone'))).toBe('23514');
      const e = await refusal(k.question(a, runA, { seriesKey: null }));
      expect([e.code, e.detail]).toEqual(['23514', undefined]);
      expect(e.message).toMatch(/^prediction \w+: its run and series is not valid$/);
      expect((await refusal(k.question(a, runA, { forecastRunId: null }))).message).toMatch(/its run and series is not valid$/);
      const none = await refusal(k.prediction({ method: 'statistical' }));
      expect([none.code, none.detail]).toEqual(['23514', undefined]);
      expect(none.message).toMatch(/its run is not valid$/);
      for (const iso of ['REPEATABLE READ', 'SERIALIZABLE']) expect(await code(k.inTx((q) => k.question(a, runA, {}, q), { iso })), iso).toBe('40001');
    });

    it('it is written by the forecaster, resolves by itself, is untainted and is about no goal and no entity', async () => {
      const key = await k.onSeries();
      const rid = await k.run(key);
      const writer = async (over: Record<string, unknown>, label: string) => {
        const e = await refusal(k.question(key, rid, over));
        expect([e.code, e.detail], label).toEqual(['23514', undefined]);
        expect(e.message, label).toMatch(/^prediction \w+: its writer is not valid$/);
      };
      await writer({ createdBy: 'runtime:triage' }, 'another writer');
      await writer({ createdBy: 'server' }, 'the chat connector');
      await writer({ createdBy: 'runtime:reason' }, 'the estimate\'s writer on the forecaster\'s method');
      await writer({ resolver: 'will' }, 'a question for Will');
      await writer({ resolver: 'auto_world' }, 'resolved from the world');
      await writer({ tainted: true }, 'tainted');
      await writer({ method: 'rule' }, 'a rule on a run');
      await writer({ method: 'human', probability: 0.99 }, 'Will\'s own on a run');
      const eid = id('en');
      await app(`INSERT INTO "Entity" (id, kind, key, name, state, "stateHash", "lastObservedAt", "updatedAt") VALUES ($1, 'service', $2, 'synthetic', '{}', $3, now(), now())`, [eid, `service:test:${eid}`, HEX('d')]);
      await writer({ subjectEntityId: eid }, 'about an entity');
      expect((await refusal(k.question(key, rid, { unit: 'US Dollars' }))).message).toMatch(/its unit is not valid$/);
    });

    it('the local model\'s estimate rides on any ok run, but only where Will signed it, and only as runtime:reason', async () => {
      const plain = await k.onSeries();
      const withEstimate = await k.onSeries({ reason: true });
      const estimate = (key: string, rid: string, over: Record<string, unknown> = {}) => k.question(key, rid, { method: 'model_reasoning', createdBy: 'runtime:reason', ...over });
      const e = await refusal(estimate(plain, await k.run(plain)));
      expect(e.code).toBe('42501');
      expect(e.message).toMatch(new RegExp(`the local model's estimate is not turned on for series ${plain.replace(/\./g, '\\.')}$`));
      for (const over of [{}, { beatsNaive: false, naiveMase: 0.8, modelMase: 0.9 }, { beatsNaive: null, naiveMase: null, modelMase: null }]) {
        expect(await k.outcome(estimate(withEstimate, await k.run(withEstimate, over)))).toBe('ok');
      }
      expect((await refusal(estimate(withEstimate, await k.run(withEstimate), { createdBy: 'runtime:forecast' }))).message).toMatch(/its writer is not valid$/);
      // Turned off again (free), the estimate stops.
      await app(`UPDATE "ForecastSeries" SET reason = false WHERE "seriesKey" = $1`, [withEstimate]);
      expect(await code(estimate(withEstimate, await k.run(withEstimate)))).toBe('42501');
    });

    it('a range has its middle, both ends and its run\'s level, in order and finite; a yes/no has none of them', async () => {
      const key = await k.onSeries({ unit: 'usd', sensitivity: 'financial' });
      const rid = await k.run(key);
      const bad = async (over: Record<string, unknown>, label: string, rule = 'range') => {
        const pid = id('pd');
        const e = await refusal(k.range(key, rid, { id: pid, pointEstimate: CANARY, lower: CANARY - 1, upper: CANARY + 1, ...over }));
        expect([e.code, e.detail], label).toEqual(['23514', undefined]);
        expect(e.message, label).toBe(`prediction ${pid}: its ${rule} is not valid`);
        expect(e.text, label).not.toContain('31337');
      };
      await bad({ pointEstimate: null }, 'no middle');
      await bad({ lower: null }, 'no lower end');
      await bad({ upper: null }, 'no upper end');
      await bad({ level: null }, 'no level');
      await bad({ lower: CANARY + 0.5 }, 'lower above the middle');
      await bad({ upper: CANARY - 0.5 }, 'upper below the middle');
      for (const v of [NaN, Infinity, -Infinity]) {
        await bad({ pointEstimate: v }, `middle ${v}`);
        await bad({ lower: v }, `lower ${v}`);
        await bad({ upper: v }, `upper ${v}`);
      }
      await bad({ pointEstimate: NaN, lower: NaN, upper: NaN }, 'all NaN');
      for (const level of [0, 1, 1.5, NaN]) await bad({ level }, `level ${level}`);
      // A range's level is its run's (0.8 here).
      const other = await refusal(k.range(key, rid, { level: 0.9 }));
      expect([other.code, other.detail]).toEqual(['23514', undefined]);
      expect(other.message).toMatch(new RegExp(`^prediction \\w+: a range carries its run's level \\(run ${rid}\\)$`));
      // A yes/no with any of a range's numbers.
      for (const col of ['pointEstimate', 'lower', 'upper', 'level']) {
        const e = await refusal(k.question(key, rid, { [col]: 0.5 }));
        expect([e.code, e.detail], col).toEqual(['23514', undefined]);
        expect(e.message, col).toMatch(/its range is not valid$/);
      }
      expect(await k.outcome(k.range(key, rid, { pointEstimate: 3, lower: 3, upper: 3 }))).toBe('ok');
      // Without a run too: a range is a range, whoever wrote it.
      expect((await refusal(k.prediction({ kind: 'interval', probability: null, method: 'human', resolver: 'will' }))).message).toMatch(/its range is not valid$/);
      expect(await k.outcome(k.prediction({ kind: 'interval', probability: null, method: 'human', resolver: 'will', pointEstimate: 2, lower: 1, upper: 3, level: 0.9 }))).toBe('ok');
    });

    it('a forecast\'s row is checked against every rule a prediction has by id, before a plain CHECK could print it; other predictions keep the plain constraints', async () => {
      const key = await k.onSeries({ unit: 'usd', sensitivity: 'financial' });
      const rid = await k.run(key);
      const named = async (rule: string, over: Record<string, unknown>) => {
        const pid = id('pd');
        const e = await refusal(k.range(key, rid, { id: pid, pointEstimate: CANARY, lower: CANARY - 1, upper: CANARY + 1, ...over }));
        expect([e.code, e.detail], rule).toEqual(['23514', undefined]);
        expect(e.message, rule).toBe(`prediction ${pid}: its ${rule} is not valid`);
        expect(e.text, rule).not.toContain('31337');
      };
      await named('probability', { probability: 0.99 });
      await named('horizon', { resolveIn: '181 days' });
      await named('horizon', { resolveIn: '-1 hour' });
      await named('claim', { claim: `${CANARY} `.repeat(40) });
      await named('criteria', { resolutionCriteria: '' });
      await named('evidence', { evidence: '{"not":"a list"}' });
      await named('domain', { domain: 'weather' });
      await named('type', { type: 'guess' });
      await named('kind', { kind: 'triple' });
      await named('a required field', { claim: null });
      await named('a required field', { createdBy: null });
      await named('probability', { kind: 'binary', probability: null, pointEstimate: null, lower: null, upper: null, level: null });
      const weird = await refusal(k.range(key, rid, { id: `pd ${CANARY}`, pointEstimate: CANARY }));
      expect([weird.code, weird.message, weird.detail]).toEqual(['23514', 'prediction: its id is not valid', undefined]);
      // An ordinary prediction is refused by P1's own constraint, as before.
      expect((await refusal(k.prediction({ probability: 0.99 }))).message).toMatch(/Prediction_probability_check/);
      expect((await refusal(k.prediction({ resolveIn: '181 days' }))).message).toMatch(/Prediction_horizon_check/);
      expect(await k.outcome(k.prediction())).toBe('ok');
      // `statistical` is a method now, and still not one a writer can make up.
      expect((await refusal(k.prediction({ method: 'oracle' }))).message).toMatch(/Prediction_method_check/);
    });

    it('only while its number is on: turning a number off stops its predictions, from an old run as much as a new one', async () => {
      const key = await k.onSeries({ reason: true });
      const [first, second] = [await k.run(key), await k.run(key)];
      expect(await k.outcome(k.question(key, first))).toBe('ok');
      await app(`UPDATE "ForecastSeries" SET "on" = false, reason = false WHERE "seriesKey" = $1`, [key]);
      for (const attempt of [
        () => k.question(key, second), () => k.range(key, first), () => k.range(key, second, { method: 'base_rate' }),
        () => k.question(key, second, { method: 'model_reasoning', createdBy: 'runtime:reason' }),
      ]) {
        const e = await refusal(attempt());
        expect(e.code).toBe('42501');
        expect(e.message).toMatch(new RegExp(`^prediction \\w+: series ${key.replace(/\./g, '\\.')} is not turned on$`));
      }
      // What was predicted while it was on stays, and can still be resolved.
      expect((await app(`SELECT count(*)::int AS n FROM "Prediction" WHERE "seriesKey" = $1`, [key])).rows[0].n).toBe(1);
    });

    it('a run backs one range and one yes/no question from the forecaster, and one estimate from the local model: nothing is recorded twice', async () => {
      const key = await k.onSeries({ reason: true });
      const rid = await k.run(key);
      const estimate = (over: Record<string, unknown> = {}) => k.question(key, rid, { method: 'model_reasoning', createdBy: 'runtime:reason', ...over });
      expect(await k.outcome(k.question(key, rid))).toBe('ok');
      expect(await k.outcome(k.range(key, rid))).toBe('ok');
      expect(await k.outcome(estimate())).toBe('ok');
      const twice = await refusal(k.question(key, rid, { probability: 0.9 }));
      expect(twice.code).toBe('23505');
      expect(twice.message).toMatch(/Prediction_run_forecast_key/);
      // A unique index names its key (the run and the kind), never the row.
      expect(twice.detail).toMatch(new RegExp(`^Key \\("forecastRunId", kind\\)=\\(${rid}, binary\\) already exists\\.$`));
      expect(await code(k.range(key, rid, { pointEstimate: 5, lower: 1, upper: 9 }))).toBe('23505');
      expect((await refusal(estimate({ probability: 0.2 }))).message).toMatch(/Prediction_run_reason_key/);
      // Another run of the same number has its own.
      const next = await k.run(key);
      expect(await k.outcome(k.question(key, next))).toBe('ok');
      expect(await k.outcome(estimate({ forecastRunId: next }))).toBe('ok');
      // Predictions that name no run are not counted against any (another writer's: a forecast writer's always names one).
      expect(await k.outcome(k.prediction())).toBe('ok');
      expect(await k.outcome(k.prediction())).toBe('ok');
      for (const createdBy of ['runtime:forecast', 'runtime:reason']) {
        const loose = await refusal(k.prediction({ createdBy }));
        expect([loose.code, loose.detail], createdBy).toEqual(['23514', undefined]);
        expect(loose.message, createdBy).toMatch(/^prediction pd[a-z0-9]+: its run and series is not valid$/);
      }
    });

    it('none for a series that was forgotten since its run', async () => {
      const eid = await k.entity();
      const key = await k.series({ entityId: eid });
      await k.turnOn([key]);
      const rid = await k.run(key);
      expect(await k.outcome(k.question(key, rid))).toBe('ok');
      await k.forget(eid);
      const e = await refusal(k.range(key, rid));
      expect([e.code, e.detail]).toEqual(['23514', undefined]);
      expect(e.message).toMatch(/^prediction \w+: its series was forgotten$/);
    });

    it('an UPDATE that empties a column is refused by id too, before NOT NULL could print the row', async () => {
      const key = await k.onSeries({ unit: 'usd', sensitivity: 'financial' });
      const pid = await k.range(key, await k.run(key), { pointEstimate: CANARY, lower: CANARY - 1, upper: CANARY + 1, claim: `${key} is between ${CANARY - 1} and ${CANARY + 1} on 2026-10-14` });
      for (const set of [`"lateSupersession" = NULL`, `status = NULL`, `"lateSupersession" = NULL, status = 'expired'`]) {
        const e = await refusal(app(`UPDATE "Prediction" SET ${set} WHERE id = $1`, [pid]));
        expect(e.detail, set).toBeUndefined();
        expect(e.text, set).not.toContain('31337');
      }
      const e = await refusal(app(`UPDATE "Prediction" SET "lateSupersession" = NULL WHERE id = $1`, [pid]));
      expect([e.code, e.message]).toEqual(['23514', `prediction ${pid}: its status and its late mark are never empty`]);
      // An ordinary prediction's words stay out of the error the same way.
      const plain = await k.prediction({ claim: 'a synthetic CANARY claim' });
      const p = await refusal(app(`UPDATE "Prediction" SET "lateSupersession" = NULL WHERE id = $1`, [plain]));
      expect([p.code, p.detail]).toEqual(['23514', undefined]);
      expect(p.text).not.toContain('CANARY');
    });

    it('its forecast fields never change after it is made', async () => {
      const key = await k.onSeries();
      const rid = await k.run(key);
      const pid = await k.range(key, rid);
      for (const set of [`"pointEstimate" = 9`, `lower = 0`, `upper = 99`, `level = 0.5`, `unit = 'usd'`, `"forecastRunId" = NULL, "seriesKey" = NULL`, `method = 'base_rate'`]) {
        expect((await refusal(app(`UPDATE "Prediction" SET ${set} WHERE id = $1`, [pid]))).message, set).toMatch(/never edited/);
      }
    });
  });

  describe('Will\'s questions and his resolutions', () => {
    const due: string[] = [];
    let early: string;
    let range: string;
    let auto: string;
    beforeAll(async () => {
      for (let i = 0; i < 12; i++) due.push(await k.prediction({ method: 'model_reasoning', resolver: 'will', resolveIn: '1 second', createdBy: 'server', probability: 0.7 }));
      range = await k.prediction({ kind: 'interval', probability: null, method: 'human', resolver: 'will', resolveIn: '1 second', pointEstimate: 2, lower: 1, upper: 3, level: 0.9 });
      auto = await k.prediction({ resolveIn: '1 second' });
      early = await k.prediction({ method: 'model_reasoning', resolver: 'will', resolveIn: '1 day', createdBy: 'server' });
      await sleep(1300);
    });
    const ask = (pid: string, q: Q = app, cols = '', vals = '') => q(`INSERT INTO "PredictionQuestion" ("predictionId"${cols}) VALUES ($1${vals})`, [pid]);
    const answer = (pid: string, a: string, actor: string | null = 'will:console') =>
      k.inTx((q) => q(`UPDATE "PredictionQuestion" SET answer = $2, "answeredAt" = '2020-01-01' WHERE "predictionId" = $1`, [pid, a]), actor ? { actor } : {});
    const resolve = (pid: string, o: boolean, by = 'will', q: Q = app) =>
      q(`INSERT INTO "Resolution" (id, "predictionId", outcome, "eventAt", "resolvedBy") VALUES ($1, $2, $3, now(), $4)`, [id('rs'), pid, o, by]);

    it('a question is asked once, about a due, unresolved yes/no prediction that only Will resolves; it starts unanswered, asked now', async () => {
      const e = await refusal(ask(early));
      expect(e.code).toBe('42501');
      expect(e.message).toBe(`question ${early}: asked only about a due, unresolved yes/no prediction that Will resolves`);
      expect(await code(ask(auto))).toBe('42501');
      expect(await code(ask(range))).toBe('42501');
      expect(await code(ask('pdnone'))).toBe('23514');
      expect(await code(ask(due[0]!, app, ', answer, "answeredAt"', `, 'yes', now()`))).toBe('42501');
      for (const iso of ['REPEATABLE READ', 'SERIALIZABLE']) expect(await code(k.inTx((q) => ask(due[0]!, q), { iso })), iso).toBe('40001');
      await ask(due[0]!, app, ', "askedAt"', `, '2020-01-01'`);
      expect((await app(`SELECT shadow, answer, "askedAt" > now() - interval '1 minute' AS fresh FROM "PredictionQuestion" WHERE "predictionId" = $1`, [due[0]])).rows[0]).toEqual({ shadow: true, answer: null, fresh: true });
      expect(await code(ask(due[0]!))).toBe('23505');
    });

    it('it is answered once, in a transaction that says it is Will\'s, stamped now; nothing else about it changes; it is never deleted', async () => {
      const pid = due[1]!;
      await ask(pid);
      const none = await refusal(answer(pid, 'yes', null));
      expect(none.code).toBe('42501');
      expect(none.message).toBe(`question ${pid}: only Will answers it`);
      expect(await code(answer(pid, 'yes', 'runtime:ledger'))).toBe('42501');
      expect((await refusal(answer(pid, 'maybe'))).message).toMatch(/PredictionQuestion_answer_check/);
      await answer(pid, 'yes');
      expect((await app(`SELECT answer, "answeredAt" > now() - interval '1 minute' AS fresh FROM "PredictionQuestion" WHERE "predictionId" = $1`, [pid])).rows[0]).toEqual({ answer: 'yes', fresh: true });
      expect(await code(answer(pid, 'no'))).toBe('42501');
      expect(await code(k.inTx((q) => q(`UPDATE "PredictionQuestion" SET answer = NULL, "answeredAt" = NULL WHERE "predictionId" = $1`, [pid]), { actor: 'will:console' }))).toBe('42501');
      // flint_app may write only the answer; as the owner, the guard says the same.
      expect((await refusal(app(`UPDATE "PredictionQuestion" SET shadow = false WHERE "predictionId" = $1`, [pid]))).message).toMatch(/permission denied/);
      expect(await code(owner(`UPDATE "PredictionQuestion" SET shadow = false WHERE "predictionId" = $1`, [pid]))).toBe('42501');
      expect(await code(owner(`UPDATE "PredictionQuestion" SET "askedAt" = '2020-01-01' WHERE "predictionId" = $1`, [pid]))).toBe('42501');
      expect(await code(owner(`DELETE FROM "PredictionQuestion" WHERE "predictionId" = $1`, [pid]))).toBe('42501');
      expect(await code(owner(`TRUNCATE "PredictionQuestion"`))).toBe('42501');
      // An answer and its time go together (a plain CHECK): a time alone is refused.
      await ask(due[2]!);
      expect(await code(k.inTx((q) => q(`UPDATE "PredictionQuestion" SET "answeredAt" = now() WHERE "predictionId" = $1`, [due[2]]), { actor: 'will:console' }))).toBe('42501');
    });

    it('a prediction only Will resolves is settled only by his answer, with that outcome', async () => {
      const pid = due[3]!;
      // No question; a question not yet answered; a skipped one.
      const e = await refusal(resolve(pid, true));
      expect(e.code).toBe('42501');
      expect(e.message).toBe(`resolution of ${pid}: recorded as Will's without his answer`);
      await ask(pid);
      expect(await code(resolve(pid, true))).toBe('42501');
      await ask(due[4]!);
      await answer(due[4]!, 'skip');
      expect(await code(resolve(due[4]!, true))).toBe('42501');
      expect(await code(resolve(due[4]!, false))).toBe('42501');
      // His yes is a true outcome, never a false one; and the other way round.
      await answer(pid, 'yes');
      const wrong = await refusal(resolve(pid, false));
      expect([wrong.code, wrong.message]).toEqual(['42501', `resolution of ${pid}: its outcome is not Will's answer`]);
      expect(await code(resolve(pid, true, 'auto_world'))).not.toBeUndefined();
      for (const iso of ['REPEATABLE READ', 'SERIALIZABLE']) expect(await code(k.inTx((q) => resolve(pid, true, 'will', q), { iso })), iso).toBe('40001');
      await resolve(pid, true);
      const r = (await app(`SELECT p.status, r.brier, r."resolvedBy" FROM "Prediction" p JOIN "Resolution" r ON r."predictionId" = p.id WHERE p.id = $1`, [pid])).rows[0];
      expect(r.status).toBe('resolved');
      expect(r.resolvedBy).toBe('will');
      expect(r.brier).toBeCloseTo(0.09, 10);
      await ask(due[5]!);
      await answer(due[5]!, 'no');
      expect(await code(resolve(due[5]!, true))).toBe('42501');
      expect(await k.outcome(resolve(due[5]!, false))).toBe('ok');
      // One transaction, as the console's answer route will do it: the answer and its resolution together.
      await ask(due[6]!);
      await k.inTx(async (q) => {
        await q(`UPDATE "PredictionQuestion" SET answer = 'yes' WHERE "predictionId" = $1`, [due[6]]);
        await resolve(due[6]!, true, 'will', q);
      }, { actor: 'will:console' });
      expect((await app(`SELECT status FROM "Prediction" WHERE id = $1`, [due[6]])).rows[0].status).toBe('resolved');
    });

    it('nobody else\'s resolution is recorded as Will\'s either; an automatic one stays as it was', async () => {
      // `auto` resolves from the world: by the world, yes; "as Will", only with his answer (and it has no question to answer).
      expect(await code(resolve(auto, true))).toBe('42501');
      expect(await k.outcome(resolve(auto, true, 'auto_world'))).toBe('ok');
      // P1's rule stands and fires first: what only Will resolves is never resolved by the world.
      expect((await refusal(resolve(due[7]!, true, 'auto_world'))).message).toMatch(/only Will resolves this one/);
    });

    it('a resolution\'s own rules name the prediction and the rule, never the number it carries (no DETAIL)', async () => {
      const key = await k.onSeries({ unit: 'usd', sensitivity: 'financial' });
      const pid = await k.range(key, await k.run(key), { resolveIn: '1 hour' });
      const ins = (over: Record<string, unknown>) => {
        const v: Record<string, unknown> = { id: id('rs'), outcome: null, outcomeValue: CANARY, eventAt: new Date().toISOString(), resolvedBy: 'auto_metric', evidence: JSON.stringify({ seriesKey: key, value: CANARY }), ...over };
        return app(`INSERT INTO "Resolution" (id, "predictionId", outcome, "outcomeValue", "eventAt", "resolvedBy", evidence) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
          [v.id, pid, v.outcome, v.outcomeValue, v.eventAt, v.resolvedBy, v.evidence]);
      };
      const bad = async (rule: string, over: Record<string, unknown>) => {
        const e = await refusal(ins(over));
        expect([e.code, e.detail], rule).toEqual(['23514', undefined]);
        expect(e.message, rule).toBe(`resolution of ${pid}: its ${rule} is not valid`);
        expect(e.text, rule).not.toContain('31337');
      };
      await bad('a required field', { eventAt: null });
      await bad('resolver', { resolvedBy: 'the_model' });
      await bad('resolver', { resolvedBy: null });
      await bad('value', { outcomeValue: NaN });
      await bad('value', { outcomeValue: Infinity });
      await bad('evidence', { evidence: JSON.stringify({ value: CANARY, pad: 'x'.repeat(17_000) }) });
      await bad('id', { id: `rs ${CANARY}` });
      // P1's leak guard says the same thing it always did about a range with no value (it names the prediction only).
      const noValue = await refusal(ins({ outcomeValue: null, outcome: true }));
      expect(noValue.text).not.toContain('31337');
      expect(noValue.detail).toBeUndefined();
      expect(await k.outcome(ins({}))).toBe('ok');
      expect((await app(`SELECT status FROM "Prediction" WHERE id = $1`, [pid])).rows[0].status).toBe('resolved');
    });

    it('a goal card marking a goal done still resolves that goal\'s forecasts as Will, whichever resolver they name; outside that card, nothing does', async () => {
      const DEF = { title: 'Synthetic goal title', description: 'Synthetic goal description', successCriteria: [{ id: 'c1', text: 'Synthetic check text', check: { kind: 'manual' } }], horizonAt: '2027-03-01T00:00:00.000Z', reviewCadence: 'P1W' };
      const goalCard = async (action: string, args: Record<string, unknown>) => (await k.card(action, args, { kind: 'goal' })).aid;
      const newGoal = async () => {
        const gid = id('go');
        await app(`INSERT INTO "Goal" (id, title, description, owner, origin, "successCriteria", "horizonAt", "reviewCadence", "updatedAt") VALUES ($1, $2, $3, 'will', 'will', $4::jsonb, $5, $6, now())`,
          [gid, DEF.title, DEF.description, JSON.stringify(DEF.successCriteria), DEF.horizonAt, DEF.reviewCadence]);
        const aid = await goalCard('goal.activate', { goalId: gid, owner: 'will', origin: 'will', sensitivity: 'personal', tainted: false, nexusProjectId: null, ...DEF, links: [], plan: null });
        await app(`UPDATE "Goal" SET status = 'active', "approvalId" = $2, "nextReviewAt" = now(), title = $3, description = $4, "successCriteria" = $5::jsonb, "horizonAt" = $6, "reviewCadence" = $7 WHERE id = $1`,
          [gid, aid, DEF.title, DEF.description, JSON.stringify(DEF.successCriteria), DEF.horizonAt, DEF.reviewCadence]);
        return gid;
      };
      const forecast = (gid: string, resolver: string) => k.prediction({ method: 'rule', domain: 'goals', type: 'deadline_met', resolver, resolveIn: '30 days', createdBy: 'runtime:goals', goalId: gid });
      const gid = await newGoal();
      const [world, wills] = [await forecast(gid, 'auto_world'), await forecast(gid, 'will')];
      // While the goal is active, nothing resolves its forecasts as Will.
      for (const pid of [world, wills]) expect(await code(resolve(pid, true)), pid).toBe('42501');
      const done = await goalCard('goal.done', { goalId: gid, goalTitle: DEF.title });
      // The executor's own statement (goals/apply.ts), in the card's transaction.
      await k.inTx(async (q) => {
        await q(`UPDATE "Goal" SET status = 'done', "approvalId" = $2 WHERE id = $1`, [gid, done]);
        const r = await q(
          `INSERT INTO "Resolution" (id, "predictionId", outcome, "eventAt", "resolvedBy", evidence)
           SELECT 'rs' || replace(gen_random_uuid()::text, '-', ''), p.id, true AND t.at <= p."resolveBy", t.at, 'will', jsonb_build_object('goalId', p."goalId", 'approvalId', $2::text, 'via', 'goal.done')
           FROM "Prediction" p CROSS JOIN (SELECT clock_timestamp() AS at) t
           WHERE p."goalId" = $1 AND p.status IN ('open', 'superseded') AND p.kind = 'binary' AND NOT EXISTS (SELECT 1 FROM "Resolution" r WHERE r."predictionId" = p.id)`, [gid, done]);
        expect(r.rowCount).toBe(2);
      });
      expect((await app(`SELECT count(*)::int AS n FROM "Resolution" r JOIN "Prediction" p ON p.id = r."predictionId" WHERE p."goalId" = $1 AND r."resolvedBy" = 'will' AND r.outcome`, [gid])).rows[0].n).toBe(2);
      // A card left executing after it finished its goal gives no cover either: only the finishing transaction does.
      const g3 = await newGoal();
      const stuck = await goalCard('goal.done', { goalId: g3, goalTitle: DEF.title });
      await app(`UPDATE "Goal" SET status = 'done', "approvalId" = $2 WHERE id = $1`, [g3, stuck]);
      // (Its forecast is one a runtime writes afterwards, as the goals writer, for Will alone to resolve.)
      const after = await forecast(g3, 'will');
      const used = await refusal(resolve(after, true));
      expect(used.code).toBe('42501');
      expect(used.message).toMatch(/was already used$/);
      // A finished goal whose card has completed gives no cover to a later resolution.
      const g2 = await newGoal();
      const late = await forecast(g2, 'auto_world');
      const done2 = await k.card('goal.done', { goalId: g2, goalTitle: DEF.title }, { kind: 'goal' });
      await app(`UPDATE "Goal" SET status = 'done', "approvalId" = $2 WHERE id = $1`, [g2, done2.aid]);
      await k.finish(done2.pid);
      expect(await code(resolve(late, false))).toBe('42501');
    });
  });

  describe('metric points', () => {
    it('a refused point names its series, never its value (no DETAIL); a good one is stored as before', async () => {
      const key = await k.series({ unit: 'usd', sensitivity: 'financial' });
      const ins = (seriesKey: string | null, at: string | null, value: number | null) => app(`INSERT INTO "MetricPoint" ("seriesKey", at, value) VALUES ($1, $2, $3)`, [seriesKey, at, value]);
      const at = '2026-10-12T04:00:00.000Z';
      for (const [label, attempt] of [
        ['no time', () => ins(key, null, CANARY)],
        ['no series', () => ins(null, at, CANARY)],
        ['no value', () => ins(key, at, null)],
      ] as const) {
        const e = await refusal(attempt());
        expect([e.code, e.detail], label).toEqual(['23514', undefined]);
        expect(e.message, label).toBe(`metric point of ${label === 'no series' ? '?' : key}: its series, time and value are required`);
        expect(e.text, label).not.toContain('31337');
      }
      expect(await k.outcome(ins(key, at, CANARY))).toBe('ok');
      // On UPDATE too; and the errors Postgres raises itself here (a point twice, a series that is not there) name keys only.
      const emptied = await refusal(app(`UPDATE "MetricPoint" SET at = NULL WHERE "seriesKey" = $1`, [key]));
      expect([emptied.code, emptied.detail]).toEqual(['23514', undefined]);
      expect(emptied.text).not.toContain('31337');
      const twice = await refusal(ins(key, at, CANARY + 1));
      expect(twice.code).toBe('23505');
      expect(twice.text).not.toContain('31337');
      const ghost = await refusal(ins(`test.${id('k')}.usd`, at, CANARY));
      expect(ghost.code).toBe('23503');
      expect(ghost.text).not.toContain('31337');
      expect((await app(`SELECT value FROM "MetricPoint" WHERE "seriesKey" = $1`, [key])).rows).toEqual([{ value: CANARY }]);
    });
  });

  describe('calibration snapshots', () => {
    const snap = (over: Record<string, unknown> = {}) => {
      const v: Record<string, unknown> = {
        domain: `d${id()}`, kind: 'binary', n: 40, brier: 0.2, baseRate: 0.5, brierSkill: 0.1, intervalCoverage: null, pinball: null, ece: null, brierCiLow: null, brierCiHigh: null, ...over,
      };
      return app(
        `INSERT INTO "CalibrationSnapshot" (id, "windowStart", "windowEnd", domain, type, method, kind, n, "nOpen", "nExpired", "nConditionUnmet", "nVoid", "nLateSuperseded",
                                            brier, "baseRate", "brierSkill", reliability, "unresolvedRate", "intervalCoverage", pinball, ece, "brierCiLow", "brierCiHigh")
         VALUES ($1, '2026-07-01', '2026-10-01', $2, 'trend', 'statistical', $3, $4, 0, 0, 0, 0, 0, $5, $6, $7, '[]', 0, $8, $9, $10, $11, $12)`,
        [id('cs'), v.domain, v.kind, v.n, v.brier, v.baseRate, v.brierSkill, v.intervalCoverage, v.pinball, v.ece, v.brierCiLow, v.brierCiHigh],
      );
    };
    const interval = { kind: 'interval', brier: null, baseRate: null, brierSkill: null, intervalCoverage: 0.79, pinball: 0.4 };
    const named = async (constraint: string, over: Record<string, unknown>) => {
      const e = await refusal(snap(over));
      expect(e.code, JSON.stringify(over)).toBe('23514');
      expect(e.message, JSON.stringify(over)).toMatch(new RegExp(`CalibrationSnapshot_${constraint}_check`));
    };

    it('ECE and the Brier interval are stored only at 100 scored: refused at 99, accepted at 100 (exit 4)', async () => {
      await named('n100', { n: 99, ece: 0.06 });
      await named('n100', { n: 99, brierCiLow: 0.18, brierCiHigh: 0.24 });
      await named('n100', { n: 0, ece: 0 });
      expect(await k.outcome(snap({ n: 99 }))).toBe('ok');
      expect(await k.outcome(snap({ n: 100, ece: 0.06, brierCiLow: 0.18, brierCiHigh: 0.24 }))).toBe('ok');
      expect(await k.outcome(snap({ n: 100 }))).toBe('ok');
    });

    it('a yes/no row has its Brier score and base rate; a range row has its coverage and neither of those', async () => {
      await named('kind', { kind: 'ordinal' });
      await named('binary', { brier: null });
      await named('binary', { baseRate: null });
      await named('binary', { intervalCoverage: 0.8 });
      await named('binary', { pinball: 0.4 });
      await named('interval', { ...interval, intervalCoverage: null });
      await named('interval', { ...interval, brier: 0.2 });
      await named('interval', { ...interval, baseRate: 0.5 });
      await named('interval', { ...interval, brierSkill: 0.1 });
      await named('interval', { ...interval, n: 120, ece: 0.05 });
      await named('interval', { ...interval, n: 120, brierCiLow: 0.1, brierCiHigh: 0.2 });
      expect(await k.outcome(snap(interval))).toBe('ok');
      expect(await k.outcome(snap({ ...interval, pinball: null }))).toBe('ok');
    });

    it('scores stay in range, the interval\'s ends come together and in order, and NaN is not a score', async () => {
      for (const intervalCoverage of [-0.01, 1.01, NaN]) await named('scores', { ...interval, intervalCoverage });
      for (const pinball of [-0.1, NaN, Infinity]) await named('scores', { ...interval, pinball });
      for (const ece of [-0.01, 1.01, NaN]) await named('scores', { n: 100, ece });
      await named('scores', { n: 100, brierCiLow: 0.2 });
      await named('scores', { n: 100, brierCiHigh: 0.2 });
      await named('scores', { n: 100, brierCiLow: 0.3, brierCiHigh: 0.2 });
      await named('scores', { n: 100, brierCiLow: -0.1, brierCiHigh: 0.2 });
      await named('scores', { n: 100, brierCiLow: 0.1, brierCiHigh: 1.2 });
      await named('scores', { n: 100, brierCiLow: NaN, brierCiHigh: NaN });
    });

    it('one row per window, domain, type, method and kind: a yes/no row and a range row for the same group both fit', async () => {
      const domain = `d${id()}`;
      expect(await k.outcome(snap({ domain }))).toBe('ok');
      expect(await k.outcome(snap({ domain, ...interval }))).toBe('ok');
      expect(await code(snap({ domain }))).toBe('23505');
      expect(await code(snap({ domain, ...interval }))).toBe('23505');
    });
  });
});
