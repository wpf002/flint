/**
 * What a runtime that breaks the rules still cannot do to Will's goals: the
 * database review's attacks (P3 part 1), each kept as a regression. Raw SQL as
 * flint_app on flint_test.
 *
 *  - No step slips into a plan through an old snapshot (REPEATABLE READ,
 *    SERIALIZABLE) or through another transaction's draft.
 *  - What Will signs is what is stored: a goal or plan card's digest is its args'
 *    digest, computed in SQL exactly as digestOf computes it.
 *  - An approval moves its goal in one transaction only, and never once its card
 *    has expired; superseding a plan never leaves the goal without one.
 *  - A review cannot land on a goal being finished; locks never wait in a circle;
 *    what a goal is (owner, origin, sensitivity, taint, Nexus project) is signed.
 *  - A refused row never puts Will's words into an error (or Postgres's log).
 * Synthetic text only.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import pg from 'pg';
import { digestOf } from '@flint/policy';
import { NO_DB, freshDb, withClient, pgConfig, pgError, id, HEX, type TestUrls } from './db';

type Q = (sql: string, params?: unknown[]) => Promise<pg.QueryResult>;
const as = (url: string): Q => (sql, params) => withClient(url, (c) => c.query(sql, params));
const CANARY = 'Synthetic CANARY-rogue';
const IDENTITY = { owner: 'will', origin: 'will', sensitivity: 'personal', tainted: false, nexusProjectId: null };
const DEF = { title: 'Synthetic goal title', description: 'Synthetic goal description', successCriteria: [{ id: 'c1', text: 'Synthetic check text', check: { kind: 'manual' } }], horizonAt: '2027-03-01T00:00:00.000Z', reviewCadence: 'P1W' };
const S = (key: string, over: Record<string, unknown> = {}) => ({ key, ordinal: 100 * Number(key.slice(1)), title: `Synthetic step ${key}`, kind: 'will_task', status: 'todo', tier: 'approval', dueAt: null, dependsOn: [] as string[], ...over });
const addOp = (s: ReturnType<typeof S>) => ({ op: 'add', key: s.key, step: { ordinal: s.ordinal, title: s.title, kind: s.kind, tier: s.tier, dueAt: s.dueAt, dependsOn: s.dependsOn } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(NO_DB)('P3 against a runtime that breaks the rules', () => {
  let urls: TestUrls;
  let app: Q;
  let owner: Q;
  let approver: Q;
  let credentialId: string;
  const code = async (p: Promise<unknown>) => (await pgError(p)).code;
  const outcome = (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string; message?: string }) => e.code ?? e.message);
  const client = async () => {
    const c = new pg.Client(pgConfig(urls.app));
    await c.connect();
    return c;
  };
  const on = (c: pg.Client): Q => (sql, params) => c.query(sql, params);

  beforeAll(async () => {
    urls = await freshDb();
    app = as(urls.app);
    owner = as(urls.owner);
    approver = as(urls.approver);
    credentialId = id('cred');
    await approver(`INSERT INTO "ApprovalCredential" (id, "credentialId", factor, "publicKey", label, "enrolledVia") VALUES ($1, $2, 'webauthn', '\\x00', 'test key', 'enroll_code')`, [id(), credentialId]);
  });

  async function card(action: string, args: Record<string, unknown>, life = '1 hour') {
    const pid = id('prop');
    const digest = digestOf(args);
    await app(
      `INSERT INTO "Proposal" (id, kind, origin, action, args, "argsDigest", "argsProvenance", sensitivity, "expiresAt") VALUES ($1, $2, 'console', $3, $4::jsonb, $5, '{}', 'personal', now() + $6::interval)`,
      [pid, action === 'plan.change' ? 'plan' : 'goal', action, JSON.stringify(args), digest, life],
    );
    const aid = id('appr');
    const expires = (await owner(`SELECT to_char((now() + interval '10 minutes') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS t`)).rows[0].t as string;
    const payload = { v: 1, subjectType: 'proposal', subjectId: pid, decision: 'approve', action, argsDigest: digest, expiresAt: expires, nonce: HEX('0').slice(0, 32) };
    await approver(
      `INSERT INTO "Approval" (id, "subjectType", "subjectId", decision, payload, challenge, "credentialId", signature, "expiresAt") VALUES ($1, 'proposal', $2, 'approve', $3, $4, $5, '\\x01', $6)`,
      [aid, pid, JSON.stringify(payload), HEX('c'), credentialId, expires],
    );
    await app(`UPDATE "Proposal" SET status = 'approved', "approvalId" = $2 WHERE id = $1`, [pid, aid]);
    await app(`UPDATE "Proposal" SET status = 'executing' WHERE id = $1`, [pid]);
    return aid;
  }
  const activateArgs = (goalId: string, over: Record<string, unknown> = {}) => ({ goalId, ...IDENTITY, ...DEF, links: [], plan: null, ...over });
  async function goal(cols: Record<string, unknown> = {}): Promise<string> {
    const gid = id('go');
    const v = { owner: 'will', origin: 'will', sensitivity: 'personal', nexusProjectId: null, ...cols };
    await app(
      `INSERT INTO "Goal" (id, title, description, owner, origin, sensitivity, "nexusProjectId", "successCriteria", "horizonAt", "reviewCadence", "updatedAt") VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, now())`,
      [gid, DEF.title, DEF.description, v.owner, v.origin, v.sensitivity, v.nexusProjectId, JSON.stringify(DEF.successCriteria), DEF.horizonAt, DEF.reviewCadence],
    );
    return gid;
  }
  const activate = (q: Q, gid: string, aid: string) =>
    q(`UPDATE "Goal" SET status = 'active', "approvalId" = $2, "nextReviewAt" = now(), title = $3, description = $4, "successCriteria" = $5::jsonb, "horizonAt" = $6, "reviewCadence" = $7 WHERE id = $1`,
      [gid, aid, DEF.title, DEF.description, JSON.stringify(DEF.successCriteria), DEF.horizonAt, DEF.reviewCadence]);
  const stepCols = `(id, "planId", key, ordinal, title, kind, status, tier, "dueAt", "dependsOn")`;
  const insertSteps = async (q: Q, planId: string, steps: Array<ReturnType<typeof S>>) => {
    for (const s of steps) await q(`INSERT INTO "PlanStep" ${stepCols} VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`, [id('ps'), planId, s.key, s.ordinal, s.title, s.kind, s.status, s.tier, s.dueAt, s.dependsOn]);
  };
  async function inTx<T>(fn: (q: Q) => Promise<T>, commit = true): Promise<T> {
    return withClient(urls.app, async (c) => {
      await c.query('BEGIN');
      try {
        const r = await fn(on(c));
        await c.query(commit ? 'COMMIT' : 'ROLLBACK');
        return r;
      } catch (e) {
        await c.query('ROLLBACK').catch(() => {});
        throw e;
      }
    });
  }
  /** An active goal with plan version 1 of these steps. */
  async function goalWithPlan(steps: Array<ReturnType<typeof S>>) {
    const gid = await goal();
    const aid = await card('goal.activate', activateArgs(gid, { plan: { ops: steps.map(addOp) } }));
    const v1 = id('pl');
    await inTx(async (q) => {
      await q(`INSERT INTO "Plan" (id, "goalId", version, "createdBy") VALUES ($1, $2, 1, 'will')`, [v1, gid]);
      await insertSteps(q, v1, steps);
      await q(`UPDATE "Plan" SET status = 'active', "approvalId" = $2 WHERE id = $1`, [v1, aid]);
      await activate(q, gid, aid);
    });
    return { gid, v1 };
  }

  describe('snapshots and other transactions\' drafts', () => {
    it('no step slips into a draft from another transaction, and nothing is activated or replaced above READ COMMITTED (a1, a6)', async () => {
      for (const iso of ['REPEATABLE READ', 'SERIALIZABLE']) {
        const gid = await goal();
        const aid = await card('goal.activate', activateArgs(gid, { plan: { ops: [addOp(S('s1'))] } }));
        const t2 = await client();
        try {
          await t2.query(`BEGIN ISOLATION LEVEL ${iso}`);
          await t2.query('SELECT 1');
          const v1 = id('pl');
          await t2.query(`INSERT INTO "Plan" (id, "goalId", version, "createdBy") VALUES ($1, $2, 1, 'will')`, [v1, gid]);
          // Writing steps above READ COMMITTED is refused outright.
          expect(await code(insertSteps(on(t2), v1, [S('s1')])), iso).toBe('40001');
          await t2.query('ROLLBACK');
        } finally {
          await t2.end();
        }
      }
      // At READ COMMITTED: the draft's maker writes its steps; another transaction writes none into it.
      const gid = await goal();
      const aid = await card('goal.activate', activateArgs(gid, { plan: { ops: [addOp(S('s1'))] } }));
      const maker = await client();
      try {
        await maker.query('BEGIN');
        const v1 = id('pl');
        await maker.query(`INSERT INTO "Plan" (id, "goalId", version, "createdBy") VALUES ($1, $2, 1, 'will')`, [v1, gid]);
        await insertSteps(on(maker), v1, [S('s1')]);
        await maker.query('COMMIT');
        expect(await code(insertSteps(app, v1, [S('s9', { kind: 'flint_action', tier: 'alone', title: 'Unsigned step' })]))).toBe('42501');
        // And activating it above READ COMMITTED is refused too (an old snapshot would miss what is committed now).
        for (const iso of ['REPEATABLE READ', 'SERIALIZABLE']) {
          const t2 = await client();
          try {
            await t2.query(`BEGIN ISOLATION LEVEL ${iso}`);
            await t2.query('SELECT 1');
            expect(await code(t2.query(`UPDATE "Plan" SET status = 'active', "approvalId" = $2 WHERE id = $1`, [v1, aid])), iso).toBe('40001');
            await t2.query('ROLLBACK');
          } finally {
            await t2.end();
          }
        }
        expect((await app(`SELECT key FROM "PlanStep" WHERE "planId" = $1`, [v1])).rows.map((r) => r.key)).toEqual(['s1']);
      } finally {
        await maker.end();
      }
    });

    it('an executor above READ COMMITTED cannot replace a plan with a stale copy; at READ COMMITTED a stale copy is refused (a3 part 4)', async () => {
      const { gid, v1 } = await goalWithPlan([S('s1'), S('s2')]);
      const aid = await card('plan.change', { goalId: gid, goalTitle: DEF.title, ops: [addOp(S('s3'))] });
      const ex = await client();
      try {
        await ex.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        await ex.query('SELECT 1');
        await app(`UPDATE "PlanStep" SET status = 'done', "doneAt" = now() WHERE "planId" = $1 AND key = 's1'`, [v1]);
        expect(await code(ex.query(`UPDATE "Plan" SET status = 'superseded' WHERE id = $1`, [v1]))).toBe('40001');
        await ex.query('ROLLBACK');
      } finally {
        await ex.end();
      }
      // The same stale copy (s1 still todo) at READ COMMITTED: the check reads what is committed now.
      const v2 = id('pl');
      expect(await code(inTx(async (q) => {
        await q(`INSERT INTO "Plan" (id, "goalId", version, "createdBy") VALUES ($1, $2, 2, 'will')`, [v2, gid]);
        await insertSteps(q, v2, [S('s1'), S('s2'), S('s3')]);
        await q(`UPDATE "Plan" SET status = 'superseded' WHERE id = $1`, [v1]);
        await q(`UPDATE "Plan" SET status = 'active', "approvalId" = $2 WHERE id = $1`, [v2, aid]);
      }))).toBe('42501');
    });

    it('a step written and the plan activated in one statement (a data-modifying CTE) is still checked', async () => {
      const gid = await goal();
      const aid = await card('goal.activate', activateArgs(gid, { plan: { ops: [addOp(S('s1'))] } }));
      const r = await outcome(inTx(async (q) => {
        const v1 = id('pl');
        await q(`INSERT INTO "Plan" (id, "goalId", version, "createdBy") VALUES ($1, $2, 1, 'will')`, [v1, gid]);
        await insertSteps(q, v1, [S('s1')]);
        await q(`WITH ins AS (
            INSERT INTO "PlanStep" (id, "planId", key, ordinal, title, kind, status, tier, "dependsOn") VALUES ($3, $1, 's9', 900, 'Unsigned', 'flint_action', 'todo', 'alone', '{}') RETURNING 1)
          UPDATE "Plan" SET status = 'active', "approvalId" = $2 WHERE id = $1 AND EXISTS (SELECT 1 FROM ins)`, [v1, aid, id('ps')]);
        await activate(q, gid, aid);
      }));
      expect(r).not.toBe('ok');
      expect((await app(`SELECT count(*)::int AS n FROM "Plan" WHERE "goalId" = $1 AND status = 'active'`, [gid])).rows[0].n).toBe(0);
    });
  });

  describe('what Will signs is what is stored', () => {
    it('a goal or plan card whose digest is not its args\' digest is never filed; other kinds are untouched here', async () => {
      const args = { goalId: 'gotest0001', goalTitle: 'Synthetic' };
      const file = (kind: string, action: string, digest: string) =>
        app(`INSERT INTO "Proposal" (id, kind, origin, action, args, "argsDigest", "argsProvenance", "expiresAt") VALUES ($1, $2, 'console', $3, $4::jsonb, $5, '{}', now() + interval '1 hour')`,
          [id('prop'), kind, action, JSON.stringify(args), digest]);
      expect(await code(file('goal', 'goal.done', digestOf({ ...args, goalId: 'gotest0002' })))).toBe('42501');
      expect(await code(file('plan', 'plan.change', HEX('a')))).toBe('42501');
      expect(await outcome(file('goal', 'goal.done', digestOf(args)))).toBe('ok');
      expect(await outcome(file('tool_call', 'world.sync.git', HEX('a')))).toBe('ok');
      // Floats, unsafe integers and non-ASCII keys have no single canonical form here: refused.
      for (const v of [{ a: 1.5 }, { a: 2 ** 53 }, { 'é': 1 }]) expect(await code(app(`SELECT p3_args_digest($1::jsonb)`, [JSON.stringify(v)])), JSON.stringify(v)).toBe('23514');
    });

    it('p3_args_digest is digestOf, on hundreds of generated goal and plan args (unicode, quotes, control characters, nesting, empties)', async () => {
      let seed = 20261009;
      const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
      const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
      const chars = ['a', 'Z', ' ', '"', '\\', '/', '\n', '\t', '\r', '\b', '\f', '\u0001', '\u001f', '\u007f', 'é', 'ß', '中', '😀', ' ', ' ', '́', "'", '<', '&', '{', ']'];
      const str = () => Array.from({ length: Math.floor(rnd() * 12) }, () => pick(chars)).join('');
      const keyChars = ['a', 'b', 'Z', '_', '-', ' ', '"', '\\', '0', '~', '!', '.', '$'];
      const key = () => Array.from({ length: 1 + Math.floor(rnd() * 6) }, () => pick(keyChars)).join('');
      const value = (depth: number): unknown => {
        const r = rnd();
        if (depth > 3 || r < 0.35) {
          return pick<() => unknown>([
            () => str(), () => Math.floor(rnd() * 2000) - 1000, () => pick([0, 1, -1, 9007199254740991, -9007199254740991, 1e15]), () => rnd() < 0.5, () => null,
          ])();
        }
        if (r < 0.65) return Array.from({ length: Math.floor(rnd() * 5) }, () => value(depth + 1));
        return Object.fromEntries(Array.from({ length: Math.floor(rnd() * 5) }, () => [key(), value(depth + 1)]));
      };
      const samples: unknown[] = [
        {}, [], { a: [] }, { a: {} }, [[], {}], '', 'plain', { '"quoted"': '\\back\\slash' }, { goalId: 'gotest0001', ops: [{ op: 'add', key: 's1', step: { ordinal: 100, title: '😀 "x" \n', kind: 'will_task', tier: 'approval', dueAt: null, dependsOn: [] } }] },
      ];
      for (let i = 0; i < 400; i++) samples.push(value(0));
      const r = await app(`SELECT p3_args_digest(x::jsonb) AS d FROM unnest($1::text[]) WITH ORDINALITY AS t(x, i) ORDER BY i`, [samples.map((v) => JSON.stringify(v))]);
      const sql = r.rows.map((x) => x.d as string);
      const js = samples.map((v) => digestOf(v));
      const differ = js.map((d, i) => (d === sql[i] ? null : JSON.stringify(samples[i]))).filter(Boolean);
      expect(differ).toEqual([]);
      expect(sql).toHaveLength(samples.length);
    });
  });

  describe('one transaction per approval', () => {
    it('a resume or a criteria change cannot be replayed with an approval already used (a2)', async () => {
      const gid = await goal();
      const a = await card('goal.activate', activateArgs(gid));
      await activate(app, gid, a);
      const pause = () => app(`UPDATE "Goal" SET status = 'paused' WHERE id = $1`, [gid]);
      const resume = (aid: string) => app(`UPDATE "Goal" SET status = 'active', "approvalId" = $2 WHERE id = $1`, [gid, aid]);
      await pause();
      const b = await card('goal.activate', activateArgs(gid));
      await resume(b);
      await pause();
      expect(await code(resume(a))).toBe('42501');
      expect(await code(resume(b))).toBe('42501');
      expect((await app(`SELECT status FROM "Goal" WHERE id = $1`, [gid])).rows[0].status).toBe('paused');
      await resume(await card('goal.activate', activateArgs(gid)));
      // Two criteria cards cannot flip the title back and forth.
      const one = { title: 'Synthetic one', description: '', successCriteria: DEF.successCriteria, links: [] };
      const two = { ...one, title: 'Synthetic two' };
      const c1 = await card('goal.criteria_change', { goalId: gid, ...one });
      const c2 = await card('goal.criteria_change', { goalId: gid, ...two });
      const crit = (v: typeof one, aid: string) => app(`UPDATE "Goal" SET title = $2, description = $3, "approvalId" = $4 WHERE id = $1`, [gid, v.title, v.description, aid]);
      await crit(one, c1);
      await crit(two, c2);
      expect(await code(crit(one, c1))).toBe('42501');
      expect((await app(`SELECT title FROM "Goal" WHERE id = $1`, [gid])).rows[0].title).toBe('Synthetic two');
    });

    it('only a live card for that goal and action is ever recorded as used: a call of its own spends nothing and fills nothing (b2 §5)', async () => {
      const gid = await goal();
      const aid = await card('goal.activate', activateArgs(gid));
      const before = (await owner(`SELECT count(*)::int AS n FROM "GoalApprovalUse"`)).rows[0].n as number;
      expect(await code(app(`SELECT p3_bind_approval($1, 'goWRONG', 'goal.done')`, [aid]))).toBe('42501');
      expect(await code(app(`SELECT p3_bind_approval('junk' || g, 'x', 'y') FROM generate_series(1, 50) g`))).toBe('42501');
      expect((await owner(`SELECT count(*)::int AS n FROM "GoalApprovalUse"`)).rows[0].n).toBe(before);
      await activate(app, gid, aid);
      expect((await app(`SELECT status FROM "Goal" WHERE id = $1`, [gid])).rows[0].status).toBe('active');
    });

    it('a transaction opened before a card expired cannot use it after (b2 §4)', async () => {
      const gid = await goal();
      const aid = await card('goal.activate', activateArgs(gid), '2 seconds');
      const t = await client();
      try {
        await t.query('BEGIN');
        await t.query('SELECT now()');
        await sleep(2300);
        expect(await code(activate(on(t), gid, aid))).toBe('42501');
        await t.query('ROLLBACK');
      } finally {
        await t.end();
      }
    });

    it('a card that cannot bring the next version cannot drop the active one; an expired card moves nothing (a2)', async () => {
      const { gid, v1 } = await goalWithPlan([S('s1')]);
      await card('plan.change', { goalId: gid, goalTitle: DEF.title, ops: [{ op: 'set', key: 's7', from: { title: 'x' }, to: { title: 'y' } }] });
      expect(await code(app(`UPDATE "Plan" SET status = 'superseded' WHERE id = $1`, [v1]))).toBe('42501');
      expect((await app(`SELECT count(*)::int AS n FROM "Plan" WHERE "goalId" = $1 AND status = 'active'`, [gid])).rows[0].n).toBe(1);
      // A card past its expiry, though still marked executing, moves nothing.
      const g2 = await goal();
      const old = await card('goal.activate', activateArgs(g2), '1 second');
      await sleep(1100);
      expect(await code(activate(app, g2, old))).toBe('42501');
    });
  });

  describe('races, locks and what a goal is', () => {
    it('a review cannot land on a goal being finished (a7)', async () => {
      const gid = await goal();
      await activate(app, gid, await card('goal.activate', activateArgs(gid)));
      const pid = id('pd');
      await app(`INSERT INTO "Prediction" (id, claim, kind, probability, method, domain, type, evidence, "resolutionCriteria", resolver, "resolveBy", "createdBy", "goalId")
        VALUES ($1, 'Synthetic claim', 'binary', 0.5, 'rule', 'goals', 'deadline_met', '[]', 'Synthetic criteria', 'will', now() + interval '30 days', 'runtime:goals', $2)`, [pid, gid]);
      const done = await card('goal.done', { goalId: gid, goalTitle: DEF.title });
      const t = await client();
      try {
        await t.query('BEGIN');
        await t.query(`UPDATE "Goal" SET status = 'done', "approvalId" = $2 WHERE id = $1`, [gid, done]);
        const review = outcome(app(`INSERT INTO "GoalReview" (id, "goalId", kind, "dueAt", summary, "progressBefore", "progressAfter", "predictionId") VALUES ($1, $2, 'scheduled', now(), 'S', 0, 0, $3)`, [id('gr'), gid, pid]));
        await sleep(300);
        await t.query('COMMIT');
        expect(await review).toBe('42501');
      } finally {
        await t.end();
      }
      expect((await app(`SELECT count(*)::int AS n FROM "GoalReview" WHERE "goalId" = $1`, [gid])).rows[0].n).toBe(0);
    });

    it('two step ticks that each then record progress on the goal wait in turn, never on each other (b5)', async () => {
      const { gid, v1 } = await goalWithPlan([S('s1'), S('s2')]);
      const t1 = await client();
      const t2 = await client();
      try {
        await t1.query('BEGIN');
        await t2.query('BEGIN');
        await t1.query(`UPDATE "PlanStep" SET status = 'in_progress' WHERE "planId" = $1 AND key = 's1'`, [v1]);
        // The second tick waits at its step (the first holds the goal), not at the goal after both hold it.
        const second = outcome(t2.query(`UPDATE "PlanStep" SET status = 'in_progress' WHERE "planId" = $1 AND key = 's2'`, [v1])
          .then(() => t2.query(`UPDATE "Goal" SET progress = 0.5 WHERE id = $1`, [gid])).then(() => t2.query('COMMIT')));
        await sleep(200);
        const first = await outcome(t1.query(`UPDATE "Goal" SET progress = 0.25 WHERE id = $1`, [gid]).then(() => t1.query('COMMIT')));
        expect([first, await second]).toEqual(['ok', 'ok']);
      } finally {
        await t1.end();
        await t2.end();
      }
      expect((await app(`SELECT progress FROM "Goal" WHERE id = $1`, [gid])).rows[0].progress).toBe(0.5);
    });

    it('a step tick and a plan change take their locks in one order, goal then plan: no deadlock (a8)', async () => {
      const { gid, v1 } = await goalWithPlan([S('s1')]);
      const tick = await client();
      const ex = await client();
      try {
        await tick.query('BEGIN');
        await ex.query('BEGIN');
        await tick.query(`UPDATE "PlanStep" SET status = 'in_progress' WHERE "planId" = $1 AND key = 's1'`, [v1]);
        // The executor waits on the goal (the tick holds it for share)...
        const exGoal = outcome(ex.query(`SELECT id FROM "Goal" WHERE id = $1 FOR UPDATE`, [gid]).then(() => ex.query(`SELECT id FROM "Plan" WHERE id = $1 FOR UPDATE`, [v1])));
        await sleep(200);
        // ...while the tick records progress on the goal and commits.
        const tickGoal = await outcome(tick.query(`UPDATE "Goal" SET progress = 0.5 WHERE id = $1`, [gid]).then(() => tick.query('COMMIT')));
        expect(tickGoal).toBe('ok');
        expect(await exGoal).toBe('ok');
        await ex.query('ROLLBACK');
      } finally {
        await tick.end();
        await ex.end();
      }
    });

    it('what a goal is is signed: a goal is never ops data, and an activation signs owner, origin, sensitivity, taint and Nexus project (a5)', async () => {
      expect(await code(goal({ sensitivity: 'ops' }))).toBe('23514');
      const gid = await goal({ owner: 'flint', nexusProjectId: 'proj1' });
      expect(await code(activate(app, gid, await card('goal.activate', activateArgs(gid))))).toBe('42501');
      expect(await code(activate(app, gid, await card('goal.activate', activateArgs(gid, { owner: 'flint' }))))).toBe('42501');
      await activate(app, gid, await card('goal.activate', activateArgs(gid, { owner: 'flint', nexusProjectId: 'proj1' })));
      expect((await app(`SELECT status, owner, "nexusProjectId" FROM "Goal" WHERE id = $1`, [gid])).rows[0]).toEqual({ status: 'active', owner: 'flint', nexusProjectId: 'proj1' });
      const fin = await goal({ sensitivity: 'financial' });
      expect(await code(activate(app, fin, await card('goal.activate', activateArgs(fin))))).toBe('42501');
      await activate(app, fin, await card('goal.activate', activateArgs(fin, { sensitivity: 'financial' })));
    });
  });

  describe('versions', () => {
    it('a draft is numbered as the next version, never far ahead (b6)', async () => {
      const { gid } = await goalWithPlan([S('s1')]);
      for (const version of [2147483647, 3, 1]) {
        expect(await code(inTx((q) => q(`INSERT INTO "Plan" (id, "goalId", version, "createdBy") VALUES ($1, $2, $3, 'will')`, [id('pl'), gid, version]))), String(version)).toBe('23514');
      }
      await inTx((q) => q(`INSERT INTO "Plan" (id, "goalId", version, "createdBy") VALUES ($1, $2, 2, 'will')`, [id('pl'), gid]));
    });
  });

  describe('a refused row never puts Will\'s words in an error', () => {
    it('every rule on a goal, plan, step or review names the row and the rule, never what it holds (no DETAIL)', async () => {
      const refusal = async (p: Promise<unknown>) => {
        const e = (await pgError(p)) as { code?: string; message: string; detail?: string };
        expect(e.code, e.message).toBe('23514');
        expect(`${e.message} ${e.detail ?? ''}`).not.toContain('CANARY');
        expect(e.detail).toBeUndefined();
        return e.message;
      };
      const ins = (over: Record<string, unknown>) => {
        const v = { title: CANARY, description: `${CANARY} why`, priority: 3, criteria: JSON.stringify([{ id: 'c1', text: `${CANARY} check`, check: { kind: 'manual' } }]), sensitivity: 'personal', ...over };
        return app(`INSERT INTO "Goal" (id, title, description, owner, origin, priority, sensitivity, "successCriteria", "updatedAt") VALUES ($1, $2, $3, 'will', 'will', $4, $5, $6::jsonb, now())`,
          [id('go'), v.title, v.description, v.priority, v.sensitivity, v.criteria]);
      };
      expect(await refusal(ins({ title: `${CANARY} `.repeat(10) }))).toMatch(/^goal \w+: its title is not valid$/);
      expect(await refusal(ins({ title: null }))).toMatch(/its title is not valid/);
      await refusal(ins({ description: `${CANARY} `.repeat(60) }));
      await refusal(ins({ criteria: JSON.stringify(Array.from({ length: 11 }, (_, i) => ({ id: `c${i}`, text: CANARY }))) }));
      await refusal(ins({ criteria: JSON.stringify([{ id: 'c1', text: `${CANARY} `.repeat(500) }]) }));
      await refusal(ins({ priority: 9 }));
      await refusal(ins({ sensitivity: 'ops' }));
      // On update too, and on a plan, a step and a review.
      const gid = await goal();
      await refusal(app(`UPDATE "Goal" SET priority = 0 WHERE id = $1`, [gid]));
      await refusal(inTx(async (q) => {
        const pl = id('pl');
        await q(`INSERT INTO "Plan" (id, "goalId", version, "createdBy", rationale) VALUES ($1, $2, 1, 'will', $3)`, [pl, gid, `${CANARY} `.repeat(30)]);
      }));
      await refusal(inTx(async (q) => {
        const pl = id('pl');
        await q(`INSERT INTO "Plan" (id, "goalId", version, "createdBy") VALUES ($1, $2, 1, 'will')`, [pl, gid]);
        await insertSteps(q, pl, [S('s1', { title: `${CANARY} `.repeat(20) })]);
      }));
      await refusal(inTx(async (q) => {
        const pl = id('pl');
        await q(`INSERT INTO "Plan" (id, "goalId", version, "createdBy") VALUES ($1, $2, 1, 'will')`, [pl, gid]);
        await insertSteps(q, pl, [S('s1', { title: CANARY, ordinal: 0 })]);
      }));
      const active = await goal();
      await activate(app, active, await card('goal.activate', activateArgs(active)));
      const pid = id('pd');
      await app(`INSERT INTO "Prediction" (id, claim, kind, probability, method, domain, type, evidence, "resolutionCriteria", resolver, "resolveBy", "createdBy", "goalId")
        VALUES ($1, 'Synthetic claim', 'binary', 0.5, 'rule', 'goals', 'deadline_met', '[]', 'Synthetic criteria', 'will', now() + interval '30 days', 'runtime:goals', $2)`, [pid, active]);
      await refusal(app(`INSERT INTO "GoalReview" (id, "goalId", kind, "dueAt", summary, "progressBefore", "progressAfter", "predictionId") VALUES ($1, $2, 'scheduled', now(), $3, 0, 0, $4)`,
        [id('gr'), active, `${CANARY} `.repeat(60), pid]));
    });

    it('a goal card refused by one of Proposal\'s own rules says which, never its args (b4)', async () => {
      const args = activateArgs(id('go'), { title: CANARY });
      const file = (cols: { origin?: string | null; expires?: string; templateId?: string | null }) =>
        app(`INSERT INTO "Proposal" (id, kind, origin, action, "templateId", args, "argsDigest", "argsProvenance", sensitivity, "expiresAt") VALUES ($1, 'goal', $2, 'goal.activate', $3, $4::jsonb, $5, '{}', 'personal', now() + $6::interval)`,
          [id('prop'), cols.origin === undefined ? 'console' : cols.origin, cols.templateId ?? null, JSON.stringify(args), digestOf(args), cols.expires ?? '1 hour']);
      for (const [label, cols, rule] of [
        ['a runtime card without its template', { origin: 'runtime:goals' }, 'template'],
        ['a card born expired', { expires: '-1 hour' }, 'expiry'],
        ['a card with no origin', { origin: null }, 'a required field'],
      ] as const) {
        const e = (await pgError(file(cols))) as { code?: string; message: string; detail?: string };
        expect(e.code, label).toBe('23514');
        expect(e.message, label).toMatch(new RegExp(`^proposal \\w+: its ${rule} is not valid$`));
        expect(`${e.message} ${e.detail ?? ''}`, label).not.toContain('CANARY');
        expect(e.detail, label).toBeUndefined();
      }
      // Words where a signed time goes are never cast (a cast's error would repeat them).
      const g2 = await goal();
      const words = await card('goal.activate', activateArgs(g2, { horizonAt: `${CANARY} soon` }));
      const e1 = (await pgError(activate(app, g2, words))) as { code?: string; message: string; detail?: string };
      expect(e1.code).toBe('42501');
      expect(`${e1.message} ${e1.detail ?? ''}`).not.toContain('CANARY');
      const { gid: g3, v1 } = await goalWithPlan([S('s1')]);
      const step = await card('plan.change', { goalId: g3, goalTitle: DEF.title, ops: [{ op: 'set', key: 's1', from: { title: 'Synthetic step s1', dueAt: `${CANARY} later` }, to: { dueAt: '2027-01-01T00:00:00.000Z' } }] });
      const e2 = (await pgError(inTx(async (q) => {
        const v2 = id('pl');
        await q(`INSERT INTO "Plan" (id, "goalId", version, "createdBy") VALUES ($1, $2, 2, 'will')`, [v2, g3]);
        await insertSteps(q, v2, [S('s1', { dueAt: '2027-01-01T00:00:00.000Z' })]);
        await q(`UPDATE "Plan" SET status = 'superseded' WHERE id = $1`, [v1]);
        await q(`UPDATE "Plan" SET status = 'active', "approvalId" = $2 WHERE id = $1`, [v2, step]);
      }, false))) as { code?: string; message: string; detail?: string };
      expect(e2.code).toBe('23514');
      expect(`${e2.message} ${e2.detail ?? ''}`).not.toContain('CANARY');
    });
  });
});
