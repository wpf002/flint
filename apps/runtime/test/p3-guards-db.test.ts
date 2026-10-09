/**
 * P3's rules in the database (migration p3_goals), whatever the runtime's code
 * does: raw SQL as flint_app on flint_test (exit criterion 5 as a database test).
 *
 *  - A goal is born proposed and unsigned. It becomes active, done or abandoned,
 *    or changes what counts as done or its timing, only under a new approval of
 *    an executing card for exactly that change, with exactly those values;
 *    resuming changes nothing else; done, abandoned and rejected are final.
 *  - Links come and go only as a signed card lists them; a plan version becomes
 *    active only as the previous one plus exactly the signed ops; steps change
 *    only by their progress, a Flint action is done only with its own proof (H7).
 *  - A review needs an open forecast of its goal (exit 6); a goal's forecast
 *    comes from the goals writer only; chat's suggestions need Will's quote
 *    (exit 7); history keeps lengths, never words; every RAISE names its SQLSTATE.
 * Synthetic text only.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import pg from 'pg';
import { NO_DB, freshDb, withClient, pgConfig, pgError, id, HEX, type TestUrls } from './db';

type Q = (sql: string, params?: unknown[]) => Promise<pg.QueryResult>;
const as = (url: string): Q => (sql, params) => withClient(url, (c) => c.query(sql, params));

const DEF = {
  title: 'Synthetic goal title',
  description: 'Synthetic goal description',
  successCriteria: [{ id: 'c1', text: 'Synthetic check text', check: { kind: 'manual' } }],
  horizonAt: '2027-03-01T00:00:00.000Z',
  reviewCadence: 'P1W',
};
const NEW_DEF = { ...DEF, title: 'Synthetic goal, renamed', successCriteria: [...DEF.successCriteria, { id: 'c2', text: 'Synthetic second check', check: { kind: 'manual' } }] };
const NEW_TIMING = { horizonAt: '2027-06-01T00:00:00.000Z', reviewCadence: 'P1D' };

interface Step {
  key: string;
  ordinal: number;
  title: string;
  kind: string;
  status: string;
  tier: string;
  dueAt: string | null;
  dependsOn: string[];
  proposalId: string | null;
  taskId: string | null;
  doneAuditId: string | null;
  doneAt: string | null;
}
const S = (key: string, over: Partial<Step> = {}): Step => ({
  key, ordinal: 100 * Number(key.slice(1)), title: `Synthetic step ${key}`, kind: 'will_task', status: 'todo', tier: 'approval', dueAt: null, dependsOn: [],
  proposalId: null, taskId: null, doneAuditId: null, doneAt: null, ...over,
});
const addOp = (s: Step) => ({ op: 'add', key: s.key, step: { ordinal: s.ordinal, title: s.title, kind: s.kind, tier: s.tier, dueAt: s.dueAt, dependsOn: s.dependsOn } });

describe.skipIf(NO_DB)('P3 guards in the database', () => {
  let urls: TestUrls;
  let app: Q;
  let approver: Q;
  let owner: Q;
  let credentialId: string;

  beforeAll(async () => {
    urls = await freshDb();
    app = as(urls.app);
    approver = as(urls.approver);
    owner = as(urls.owner);
    credentialId = id('cred');
    await approver(`INSERT INTO "ApprovalCredential" (id, "credentialId", factor, "publicKey", label, "enrolledVia") VALUES ($1, $2, 'webauthn', '\\x00', 'test key', 'enroll_code')`, [id(), credentialId]);
  });

  /** Statements on one connection, in one transaction: committed, or (by default) rolled back. */
  async function inTx<T>(fn: (q: Q) => Promise<T>, commit = false): Promise<T> {
    return withClient(urls.app, async (c) => {
      await c.query('BEGIN');
      try {
        const r = await fn((sql, params) => c.query(sql, params));
        await c.query(commit ? 'COMMIT' : 'ROLLBACK');
        return r;
      } catch (e) {
        await c.query('ROLLBACK').catch(() => {});
        throw e;
      }
    });
  }
  const code = async (p: Promise<unknown>) => (await pgError(p)).code;
  /** 'ok', or the SQLSTATE it was refused with. */
  const outcome = (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string; message?: string }) => e.code ?? e.message);

  async function approval(subjectId: string, action: string, decision: 'approve' | 'reject' = 'approve'): Promise<string> {
    const aid = id('appr');
    const expires = (await owner(`SELECT to_char((now() + interval '10 minutes') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS t`)).rows[0].t as string;
    const payload = { v: 1, subjectType: 'proposal', subjectId, decision, action, argsDigest: HEX('a'), expiresAt: expires, nonce: HEX('0').slice(0, 32) };
    await approver(
      `INSERT INTO "Approval" (id, "subjectType", "subjectId", decision, payload, challenge, "credentialId", signature, "expiresAt") VALUES ($1, 'proposal', $2, $3, $4, $5, $6, '\\x01', $7)`,
      [aid, subjectId, decision, JSON.stringify(payload), HEX('c'), credentialId, expires],
    );
    return aid;
  }

  /** A card for `action` with these args, taken as far as `status` (executing by default). */
  async function card(action: string, args: Record<string, unknown>, status: 'pending' | 'approved' | 'executing' | 'executed' = 'executing') {
    const pid = id('prop');
    await app(
      `INSERT INTO "Proposal" (id, kind, origin, action, args, "argsDigest", "argsProvenance", sensitivity, "expiresAt") VALUES ($1, $2, 'console', $3, $4::jsonb, $5, '{}', 'personal', now() + interval '1 hour')`,
      [pid, action === 'plan.change' ? 'plan' : 'goal', action, JSON.stringify(args), HEX('a')],
    );
    if (status === 'pending') return { pid, aid: '' };
    const aid = await approval(pid, action);
    await app(`UPDATE "Proposal" SET status = 'approved', "approvalId" = $2 WHERE id = $1`, [pid, aid]);
    if (status === 'approved') return { pid, aid };
    await app(`UPDATE "Proposal" SET status = 'executing' WHERE id = $1`, [pid]);
    if (status === 'executed') await app(`UPDATE "Proposal" SET status = 'executed', "executedAt" = now(), result = '{}' WHERE id = $1`, [pid]);
    return { pid, aid };
  }

  const ACTION = { activate: 'goal.activate', done: 'goal.done', abandon: 'goal.abandon', criteria: 'goal.criteria_change', horizon: 'goal.horizon_change' } as const;
  type Kind = keyof typeof ACTION;
  /** The signed args of each kind of change, as the runtime files them. */
  function argsFor(kind: Kind, goalId: string, over: Record<string, unknown> = {}): Record<string, unknown> {
    if (kind === 'activate') return { goalId, ...DEF, links: [], plan: null, ...over };
    if (kind === 'criteria') return { goalId, title: NEW_DEF.title, description: NEW_DEF.description, successCriteria: NEW_DEF.successCriteria, links: [], ...over };
    if (kind === 'horizon') return { goalId, goalTitle: DEF.title, ...NEW_TIMING, ...over };
    return { goalId, goalTitle: DEF.title, ...over };
  }
  /** The update that makes each change (the values its signed args carry, unless overridden). */
  function setGoal(q: Q, kind: Kind, goalId: string, approvalId: string | null, over: Record<string, unknown> = {}) {
    if (kind === 'activate') {
      const v = { ...DEF, ...over };
      return q(
        `UPDATE "Goal" SET status = 'active', "approvalId" = $2, "nextReviewAt" = now(), title = $3, description = $4, "successCriteria" = $5::jsonb, "horizonAt" = $6, "reviewCadence" = $7 WHERE id = $1`,
        [goalId, approvalId, v.title, v.description, JSON.stringify(v.successCriteria), v.horizonAt, v.reviewCadence],
      );
    }
    if (kind === 'criteria') {
      const v = { ...NEW_DEF, ...over };
      return q(`UPDATE "Goal" SET "approvalId" = $2, title = $3, description = $4, "successCriteria" = $5::jsonb WHERE id = $1`, [goalId, approvalId, v.title, v.description, JSON.stringify(v.successCriteria)]);
    }
    if (kind === 'horizon') {
      const v = { ...NEW_TIMING, ...over };
      return q(`UPDATE "Goal" SET "approvalId" = $2, "horizonAt" = $3, "reviewCadence" = $4 WHERE id = $1`, [goalId, approvalId, v.horizonAt, v.reviewCadence]);
    }
    return q(`UPDATE "Goal" SET status = $3, "approvalId" = $2 WHERE id = $1`, [goalId, approvalId, kind === 'done' ? 'done' : 'abandoned']);
  }

  async function goal(state: 'proposed' | 'active' = 'proposed'): Promise<string> {
    const gid = id('go');
    await app(
      `INSERT INTO "Goal" (id, title, description, owner, origin, "successCriteria", "horizonAt", "reviewCadence", "updatedAt") VALUES ($1, $2, $3, 'will', 'will', $4::jsonb, $5, $6, now())`,
      [gid, DEF.title, DEF.description, JSON.stringify(DEF.successCriteria), DEF.horizonAt, DEF.reviewCadence],
    );
    if (state === 'active') await setGoal(app, 'activate', gid, (await card('goal.activate', argsFor('activate', gid))).aid);
    return gid;
  }

  async function entity(kind = 'pull_request'): Promise<string> {
    const eid = id('en');
    const state = kind === 'pull_request' ? { number: 7, state: 'open' } : { managedBy: 'launchd' };
    await owner(`INSERT INTO "Entity" (id, kind, key, name, state, "stateHash", "lastObservedAt", "updatedAt", version) VALUES ($1, $2, $3, $1, $4::jsonb, $5, now(), now(), 3)`, [eid, kind, `${kind}:test:${eid}`, JSON.stringify(state), HEX('d')]);
    return eid;
  }

  const stepCols = `(id, "planId", key, ordinal, title, kind, status, tier, "dueAt", "dependsOn", "proposalId", "taskId", "doneAuditId", "doneAt")`;
  async function insertSteps(q: Q, planId: string, steps: Step[]) {
    for (const s of steps) {
      await q(`INSERT INTO "PlanStep" ${stepCols} VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`, [
        id('ps'), planId, s.key, s.ordinal, s.title, s.kind, s.status, s.tier, s.dueAt, s.dependsOn, s.proposalId, s.taskId, s.doneAuditId, s.doneAt,
      ]);
    }
  }
  async function stepsOf(planId: string): Promise<Step[]> {
    const r = await app(`SELECT * FROM "PlanStep" WHERE "planId" = $1 ORDER BY key`, [planId]);
    return r.rows.map((x) => ({
      key: x.key, ordinal: x.ordinal, title: x.title, kind: x.kind, status: x.status, tier: x.tier, dueAt: x.dueAt ? new Date(x.dueAt).toISOString() : null,
      dependsOn: x.dependsOn, proposalId: x.proposalId, taskId: x.taskId, doneAuditId: x.doneAuditId, doneAt: x.doneAt ? new Date(x.doneAt).toISOString() : null,
    }));
  }

  /** A goal activated with a first plan of these steps (one signature), committed. */
  async function goalWithPlan(steps: Step[]): Promise<{ gid: string; v1: string; aid: string }> {
    const gid = await goal('proposed');
    const { aid } = await card('goal.activate', argsFor('activate', gid, { plan: { ops: steps.map(addOp) } }));
    const v1 = id('pl');
    await inTx(async (q) => {
      await q(`INSERT INTO "Plan" (id, "goalId", version, "createdBy") VALUES ($1, $2, 1, 'will')`, [v1, gid]);
      await insertSteps(q, v1, steps);
      await q(`UPDATE "Plan" SET status = 'active', "approvalId" = $2 WHERE id = $1`, [v1, aid]);
      await setGoal(q, 'activate', gid, aid);
    }, true);
    return { gid, v1, aid };
  }
  /** Version `version` with exactly these steps, replacing `from`, under approval `aid`. */
  async function nextVersion(q: Q, gid: string, from: string, version: number, steps: Step[], aid: string): Promise<string> {
    const pid = id('pl');
    await q(`INSERT INTO "Plan" (id, "goalId", version, "createdBy") VALUES ($1, $2, $3, 'will')`, [pid, gid, version]);
    await insertSteps(q, pid, steps);
    await q(`UPDATE "Plan" SET status = 'superseded' WHERE id = $1`, [from]);
    await q(`UPDATE "Plan" SET status = 'active', "approvalId" = $2 WHERE id = $1`, [pid, aid]);
    return pid;
  }
  const planCard = (gid: string, ops: unknown[]) => card('plan.change', { goalId: gid, goalTitle: DEF.title, ops });

  describe('goals', () => {
    it('are born proposed and unsigned, with no progress, marks or review time; a flint goal names its chat', async () => {
      const ins = (cols: string, vals: string, params: unknown[] = []) =>
        app(`INSERT INTO "Goal" (id, title, owner, origin, "updatedAt"${cols}) VALUES ($1, 'Synthetic', 'will', 'will', now()${vals})`, [id('go'), ...params]);
      expect(await code(ins(', status', ", 'active'"))).toBe('42501');
      expect(await code(ins(', "approvalId"', ", 'apx'"))).toBe('42501');
      expect(await code(ins(', progress', ', 0.5'))).toBe('42501');
      expect(await code(ins(', "criteriaMet"', `, '{"c1":"2026-10-01"}'`))).toBe('42501');
      expect(await code(ins(', "nextReviewAt"', ', now()'))).toBe('42501');
      const flint = (ref: string | null) => app(`INSERT INTO "Goal" (id, title, owner, origin, "sourceRef", "updatedAt") VALUES ($1, 'Synthetic', 'will', 'flint', $2, now())`, [id('go'), ref]);
      expect(await code(flint(null))).toBe('23514');
      expect(await code(flint('chat:not-a-digest'))).toBe('23514');
      await flint(`chat:${HEX('e')}`);
      expect(await code(app(`INSERT INTO "Goal" (id, title, owner, origin, "sourceRef", "updatedAt") VALUES ($1, 'Synthetic', 'will', 'will', $2, now())`, [id('go'), `chat:${HEX('f')}`]))).toBe('23514');
      expect(await code(app(`INSERT INTO "Goal" (id, title, owner, origin, "updatedAt") VALUES ($1, $2, 'will', 'will', now())`, [id('go'), 'x'.repeat(121)]))).toBe('23514');
      // createdAt is the wall clock's, whatever was sent.
      const gid = id('go');
      await app(`INSERT INTO "Goal" (id, title, owner, origin, "createdAt", "updatedAt") VALUES ($1, 'Synthetic', 'will', 'will', '2020-01-01', now())`, [gid]);
      expect(new Date((await app(`SELECT "createdAt" FROM "Goal" WHERE id = $1`, [gid])).rows[0].createdAt).getTime()).toBeGreaterThan(Date.now() - 60_000);
    });

    for (const kind of Object.keys(ACTION) as Kind[]) {
      it(`${ACTION[kind]}: refused (42501) without the matching executing card, allowed with it, and never twice`, async () => {
        const gid = await goal(kind === 'activate' ? 'proposed' : 'active');
        const refused = async (aid: string | null, over: Record<string, unknown> = {}) => expect(await code(setGoal(app, kind, gid, aid, over)), `${kind} ${aid}`).toBe('42501');
        // No approval at all.
        await refused(null);
        // A card for another goal.
        const other = await goal(kind === 'activate' ? 'proposed' : 'active');
        await refused((await card(ACTION[kind], argsFor(kind, other))).aid);
        // A card for another action, for this goal.
        const wrong: Kind = kind === 'done' ? 'abandon' : 'done';
        await refused((await card(ACTION[wrong], argsFor(wrong, gid))).aid);
        // A card that is approved but not executing, or already executed.
        for (const st of ['approved', 'executed'] as const) await refused((await card(ACTION[kind], argsFor(kind, gid), st)).aid);
        // An approval signed for a card still pending (never attached to it), and a signed rejection.
        const pending = await card(ACTION[kind], argsFor(kind, gid), 'pending');
        await refused(await approval(pending.pid, ACTION[kind]));
        await refused(await approval(pending.pid, ACTION[kind], 'reject'));
        // Signed args that differ by one field (done and abandon bind only the goal and the action).
        const oneOff: Partial<Record<Kind, Record<string, unknown>>> = { activate: { title: 'Synthetic, but different' }, criteria: { description: 'Synthetic, but different' }, horizon: { reviewCadence: 'P1M' } };
        if (oneOff[kind]) await refused((await card(ACTION[kind], argsFor(kind, gid, oneOff[kind]))).aid);
        // The matching card.
        const { aid } = await card(ACTION[kind], argsFor(kind, gid));
        await setGoal(app, kind, gid, aid);
        // The same approval never moves it again.
        if (kind === 'criteria') expect(await code(setGoal(app, 'criteria', gid, aid, { title: 'Synthetic, once more' }))).toBe('42501');
        if (kind === 'horizon') expect(await code(setGoal(app, 'horizon', gid, aid, { reviewCadence: 'P2W' }))).toBe('42501');
        if (kind === 'activate') {
          await app(`UPDATE "Goal" SET status = 'paused' WHERE id = $1`, [gid]);
          expect(await code(app(`UPDATE "Goal" SET status = 'active' WHERE id = $1`, [gid]))).toBe('42501');
        }
        if (kind === 'done' || kind === 'abandon') expect(await code(app(`UPDATE "Goal" SET status = 'active', "approvalId" = $2 WHERE id = $1`, [gid, aid]))).toBe('42501');
      });
    }

    it('what counts as done and its timing change on separate cards; an active goal needs a check; done, abandoned and rejected are final', async () => {
      const gid = await goal('active');
      const both = await card('goal.criteria_change', argsFor('criteria', gid));
      expect(await code(app(`UPDATE "Goal" SET "approvalId" = $2, title = $3, "reviewCadence" = 'P1D' WHERE id = $1`, [gid, both.aid, NEW_DEF.title]))).toBe('42501');
      // No checks: refused as input (23514), even when signed.
      const g2 = await goal('proposed');
      const empty = await card('goal.activate', argsFor('activate', g2, { successCriteria: [] }));
      expect(await code(setGoal(app, 'activate', g2, empty.aid, { successCriteria: [] }))).toBe('23514');
      // Final states.
      for (const kind of ['done', 'abandon'] as const) {
        const g = await goal('active');
        await setGoal(app, kind, g, (await card(ACTION[kind], argsFor(kind, g))).aid);
        expect(await code(app(`UPDATE "Goal" SET progress = 0.5 WHERE id = $1`, [g]))).toBe('42501');
        expect(await code(app(`UPDATE "Goal" SET status = 'paused' WHERE id = $1`, [g]))).toBe('42501');
      }
      const dismissed = await goal('proposed');
      await app(`UPDATE "Goal" SET status = 'rejected' WHERE id = $1`, [dismissed]);
      expect(await code(setGoal(app, 'activate', dismissed, (await card('goal.activate', argsFor('activate', dismissed))).aid))).toBe('42501');
      // A proposed goal is not paused, finished or re-scoped.
      const p = await goal('proposed');
      expect(await code(app(`UPDATE "Goal" SET status = 'paused' WHERE id = $1`, [p]))).toBe('42501');
      expect(await code(setGoal(app, 'criteria', p, (await card('goal.criteria_change', argsFor('criteria', p))).aid))).toBe('42501');
      expect(await code(setGoal(app, 'done', p, (await card('goal.done', argsFor('done', p))).aid))).toBe('42501');
    });

    it('pause, dismiss, progress, marks and priority need nothing; activatedAt is set once, by the database; what a goal is never changes', async () => {
      const gid = await goal('active');
      const first = (await app(`SELECT "activatedAt" FROM "Goal" WHERE id = $1`, [gid])).rows[0].activatedAt as Date;
      expect(first).toBeTruthy();
      await app(`UPDATE "Goal" SET progress = 0.4, priority = 1, "criteriaMet" = '{"c1":"2026-10-08"}', "nextReviewAt" = now() + interval '1 day' WHERE id = $1`, [gid]);
      expect(await code(app(`UPDATE "Goal" SET "criteriaMet" = '{"c9":"2026-10-08"}' WHERE id = $1`, [gid]))).toBe('23514');
      expect(await code(app(`UPDATE "Goal" SET "criteriaMet" = '{"c1":"yesterday"}' WHERE id = $1`, [gid]))).toBe('23514');
      await app(`UPDATE "Goal" SET status = 'paused' WHERE id = $1`, [gid]);
      await setGoal(app, 'activate', gid, (await card('goal.activate', argsFor('activate', gid))).aid);
      expect((await app(`SELECT "activatedAt" FROM "Goal" WHERE id = $1`, [gid])).rows[0].activatedAt).toEqual(first);
      // flint_app has no column grant for activatedAt or what a goal is; the owner is held by the trigger.
      expect(await code(app(`UPDATE "Goal" SET "activatedAt" = now() WHERE id = $1`, [gid]))).toBe('42501');
      for (const [col, v] of [['origin', 'flint'], ['owner', 'flint'], ['sensitivity', 'ops'], ['tainted', 'true'], ['activatedAt', '2020-01-01']]) {
        expect(await code(owner(`UPDATE "Goal" SET "${col}" = $2 WHERE id = $1`, [gid, v])), col).toBe('42501');
      }
      // A goal's approval never changes on its own.
      expect(await code(app(`UPDATE "Goal" SET "approvalId" = 'apforged' WHERE id = $1`, [gid]))).toBe('42501');
    });

    it('resuming a paused goal changes neither what counts as done, nor its timing, nor its links', async () => {
      const gid = await goal('active');
      await app(`UPDATE "Goal" SET status = 'paused' WHERE id = $1`, [gid]);
      const retitled = await card('goal.activate', argsFor('activate', gid, { title: NEW_DEF.title }));
      expect(await code(setGoal(app, 'activate', gid, retitled.aid, { title: NEW_DEF.title }))).toBe('42501');
      const retimed = await card('goal.activate', argsFor('activate', gid, NEW_TIMING));
      expect(await code(setGoal(app, 'activate', gid, retimed.aid, NEW_TIMING))).toBe('42501');
      const eid = await entity();
      const relinked = await card('goal.activate', argsFor('activate', gid, { links: [{ entityId: eid, role: 'watch', watchPaths: [] }] }));
      expect(await code(app(`INSERT INTO "GoalEntity" ("goalId", "entityId", role, "watchPaths") VALUES ($1, $2, 'watch', '{}')`, [gid, eid]))).toBe('42501');
      await setGoal(app, 'activate', gid, relinked.aid);
      expect((await app(`SELECT count(*)::int AS n FROM "GoalEntity" WHERE "goalId" = $1`, [gid])).rows[0].n).toBe(0);
    });

  });

  describe('links', () => {
    it('come in only as the executing card lists them, go only when it leaves them out, and only their cursor moves', async () => {
      const gid = await goal('proposed');
      const [pr, svc, gone] = [await entity(), await entity('service'), await entity()];
      const link = (q: Q, eid: string, role = 'watch', paths: string[] = ['state']) => q(`INSERT INTO "GoalEntity" ("goalId", "entityId", role, "watchPaths") VALUES ($1, $2, $3, $4)`, [gid, eid, role, paths]);
      expect(await code(link(app, pr))).toBe('42501');
      const links = [{ entityId: pr, role: 'watch', watchPaths: ['state'] }, { entityId: svc, role: 'target', watchPaths: [] }];
      const { aid } = await card('goal.activate', argsFor('activate', gid, { links }));
      expect(await code(link(app, pr, 'target'))).toBe('42501');
      expect(await code(link(app, pr, 'watch', ['state', 'status']))).toBe('42501');
      expect(await code(link(app, gone))).toBe('42501');
      await link(app, pr);
      await link(app, svc, 'target', []);
      // The cursor starts at the item's version, whatever was sent.
      expect((await app(`SELECT "seenVersion" FROM "GoalEntity" WHERE "goalId" = $1 AND "entityId" = $2`, [gid, pr])).rows[0].seenVersion).toBe(3);
      await setGoal(app, 'activate', gid, aid);
      // Afterwards only the cursor moves, and only forward.
      await app(`UPDATE "GoalEntity" SET "seenVersion" = 5 WHERE "goalId" = $1 AND "entityId" = $2`, [gid, pr]);
      expect(await code(app(`UPDATE "GoalEntity" SET "seenVersion" = 4 WHERE "goalId" = $1 AND "entityId" = $2`, [gid, pr]))).toBe('42501');
      expect(await code(app(`UPDATE "GoalEntity" SET role = 'target' WHERE "goalId" = $1 AND "entityId" = $2`, [gid, pr]))).toBe('42501');
      expect(await code(owner(`UPDATE "GoalEntity" SET role = 'target' WHERE "goalId" = $1 AND "entityId" = $2`, [gid, pr]))).toBe('42501');
      // goal.activate brings links only to a goal still proposed; criteria_change changes them on an active one.
      expect(await code(app(`DELETE FROM "GoalEntity" WHERE "goalId" = $1 AND "entityId" = $2`, [gid, svc]))).toBe('42501');
      const keep = await card('goal.criteria_change', argsFor('criteria', gid, { links: [links[0]] }));
      expect(await code(app(`DELETE FROM "GoalEntity" WHERE "goalId" = $1 AND "entityId" = $2`, [gid, pr]))).toBe('42501');
      await app(`DELETE FROM "GoalEntity" WHERE "goalId" = $1 AND "entityId" = $2`, [gid, svc]);
      await setGoal(app, 'criteria', gid, keep.aid);
      expect((await app(`SELECT "entityId" FROM "GoalEntity" WHERE "goalId" = $1`, [gid])).rows.map((r) => r.entityId)).toEqual([pr]);
      // A name or title is never watched, even on a card that lists it.
      await card('goal.criteria_change', argsFor('criteria', gid, { links: [links[0], { entityId: gone, role: 'watch', watchPaths: ['name'] }] }));
      expect(await code(app(`INSERT INTO "GoalEntity" ("goalId", "entityId", role, "watchPaths") VALUES ($1, $2, 'watch', '{name}')`, [gid, gone]))).toBe('23514');
    });

    it('a forgotten item is never linked', async () => {
      const gid = await goal('proposed');
      const eid = await entity();
      const fa = id('appr');
      const expires = (await owner(`SELECT to_char((now() + interval '10 minutes') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS t`)).rows[0].t as string;
      const payload = { v: 1, subjectType: 'forget', subjectId: eid, decision: 'approve', action: 'world.forget', argsDigest: HEX('a'), expiresAt: expires, nonce: HEX('0').slice(0, 32) };
      await approver(`INSERT INTO "Approval" (id, "subjectType", "subjectId", decision, payload, challenge, "credentialId", signature, "expiresAt") VALUES ($1, 'forget', $2, 'approve', $3, $4, $5, '\\x01', $6)`, [fa, eid, JSON.stringify(payload), HEX('c'), credentialId, expires]);
      await app(`SELECT forget_entity($1, $2)`, [eid, fa]);
      await card('goal.activate', argsFor('activate', gid, { links: [{ entityId: eid, role: 'watch', watchPaths: [] }] }));
      expect(await code(app(`INSERT INTO "GoalEntity" ("goalId", "entityId", role, "watchPaths") VALUES ($1, $2, 'watch', '{}')`, [gid, eid]))).toBe('23514');
    });
  });

  describe('plans', () => {
    it('a version becomes active only as the previous one plus exactly the signed ops', async () => {
      const { gid, v1 } = await goalWithPlan([S('s1'), S('s2', { dependsOn: ['s1'] }), S('s3', { dueAt: '2026-11-02T23:00:00.000Z' })]);
      // A step done on the active plan is copied as it is.
      await app(`UPDATE "PlanStep" SET status = 'done', "doneAt" = '2026-10-08T12:00:00.000Z' WHERE "planId" = $1 AND key = 's3'`, [v1]);
      const prev = await stepsOf(v1);
      const s1 = prev.find((s) => s.key === 's1')!;
      const block = { op: 'set', key: 's1', from: { title: s1.title, status: 'todo' }, to: { status: 'blocked' } };
      const overlay = (steps: Step[], key: string, to: Partial<Step>) => steps.map((s) => (s.key === key ? { ...s, ...to } : s));
      const attempt = async (ops: unknown[], steps: Step[], version = 2) => {
        const { aid } = await planCard(gid, ops);
        return outcome(inTx((q) => nextVersion(q, gid, v1, version, steps, aid)));
      };
      const blocked = overlay(prev, 's1', { status: 'blocked' });
      // Refused: an extra step; a missing previous step; an ignored op; a changed untouched step; a wrong version.
      expect(await attempt([block], [...blocked, S('s9')])).toBe('42501');
      expect(await attempt([block], blocked.filter((s) => s.key !== 's2'))).toBe('42501');
      expect(await attempt([block], prev)).toBe('42501');
      expect(await attempt([block], overlay(blocked, 's2', { title: 'Synthetic, edited' }))).toBe('42501');
      expect(await attempt([block], blocked, 3)).toBe('42501');
      // A copied step's progress is copied too: its doneAt, its proof, its card and its task.
      for (const to of [{ doneAt: '2026-10-08T12:00:00.001Z' }, { proposalId: 'prx' }, { taskId: 'tkx' }]) expect(await attempt([block], overlay(blocked, 's3', to))).toBe('42501');
      // A failed precondition; an op that makes a step done; two ops on one key; a dueAt 1 ms off; an op that changes nothing.
      expect(await attempt([{ ...block, from: { title: s1.title, status: 'in_progress' } }], blocked)).toBe('42501');
      expect(await attempt([{ op: 'set', key: 's1', from: { title: s1.title, status: 'todo' }, to: { status: 'done' } }], overlay(prev, 's1', { status: 'done', doneAt: '2026-10-09T00:00:00.000Z' }))).toBe('42501');
      expect(await attempt([block, { op: 'set', key: 's1', from: { title: s1.title }, to: { title: 'Synthetic, renamed' } }], blocked)).toBe('42501');
      const due = { op: 'set', key: 's1', from: { title: s1.title, dueAt: null }, to: { dueAt: '2026-10-20T22:00:00.000Z' } };
      expect(await attempt([due], overlay(prev, 's1', { dueAt: '2026-10-20T22:00:00.001Z' }))).toBe('42501');
      expect(await attempt([{ op: 'set', key: 's1', from: { title: s1.title, status: 'todo' }, to: { status: 'todo' } }], prev)).toBe('42501');
      // A done step stays done: reopening or skipping it is refused, whatever the draft says about its doneAt.
      const s3 = prev.find((s) => s.key === 's3')!;
      for (const to of ['todo', 'skipped'] as const) {
        const reopen = [{ op: 'set', key: 's3', from: { title: s3.title, status: 'done' }, to: { status: to } }];
        expect(await attempt(reopen, overlay(prev, 's3', { status: to, doneAt: null })), to).toBe('42501');
        // (With its doneAt kept, the draft step itself is refused first: a status other than done has no doneAt.)
        expect(await attempt(reopen, overlay(prev, 's3', { status: to })), to).toMatch(/^(23514|42501)$/);
      }
      // An op on a step the plan does not have; an add on a key it has; a dependency on no step; a circle.
      expect(await attempt([{ ...block, key: 's7' }], prev)).toBe('42501');
      expect(await attempt([addOp(S('s2'))], prev)).toBe('42501');
      expect(await attempt([addOp(S('s4', { dependsOn: ['s8'] }))], [...prev, S('s4', { dependsOn: ['s8'] })])).toBe('42501');
      const circle = { op: 'set', key: 's1', from: { title: s1.title, dependsOn: [] }, to: { dependsOn: ['s2'] } };
      expect(await attempt([circle], overlay(prev, 's1', { dependsOn: ['s2'] }))).toBe('42501');
      // Accepted: the ops as signed, a null dueAt, an empty dependsOn, and the done step copied with its doneAt.
      expect(await attempt([due], overlay(prev, 's1', { dueAt: '2026-10-20T22:00:00.000Z' }))).toBe('ok');
    });

    it('two cards on different steps both apply, in either order; one approval brings one version', async () => {
      const { gid, v1 } = await goalWithPlan([S('s1'), S('s2')]);
      const prev = await stepsOf(v1);
      const a = await planCard(gid, [{ op: 'set', key: 's1', from: { title: prev[0]!.title, status: 'todo' }, to: { status: 'blocked' } }]);
      const b = await planCard(gid, [{ op: 'set', key: 's2', from: { title: prev[1]!.title, status: 'todo' }, to: { status: 'in_progress' } }]);
      const v2 = await inTx((q) => nextVersion(q, gid, v1, 2, prev.map((s) => (s.key === 's2' ? { ...s, status: 'in_progress' } : s)), b.aid), true);
      const now2 = await stepsOf(v2);
      const v3 = await inTx((q) => nextVersion(q, gid, v2, 3, now2.map((s) => (s.key === 's1' ? { ...s, status: 'blocked' } : s)), a.aid), true);
      expect((await stepsOf(v3)).map((s) => s.status)).toEqual(['blocked', 'in_progress']);
      // The same approval cannot make a further, identical version (Plan_approvalId_key).
      expect(await code(inTx((q) => nextVersion(q, gid, v3, 4, (prev.map((s) => ({ ...s, status: s.key === 's1' ? 'blocked' : 'in_progress' }))), a.aid)))).toMatch(/^(23505|42501)$/);
    });

    it('one active version per goal; the active one is superseded only under a signed plan change; superseded is final', async () => {
      const { gid, v1, aid } = await goalWithPlan([S('s1')]);
      expect(await code(app(`UPDATE "Plan" SET status = 'superseded' WHERE id = $1`, [v1]))).toBe('42501');
      // A goal.activate card being executed is not a plan change.
      const g2 = await goal('proposed');
      await card('goal.activate', argsFor('activate', g2));
      expect(await code(app(`UPDATE "Plan" SET status = 'superseded' WHERE id = $1`, [v1]))).toBe('42501');
      // A second active version: the partial unique index.
      const other = id('pl');
      const { aid: a2 } = await planCard(gid, [addOp(S('s2'))]);
      expect(await code(inTx(async (q) => {
        await q(`INSERT INTO "Plan" (id, "goalId", version, "createdBy") VALUES ($1, $2, 2, 'will')`, [other, gid]);
        await insertSteps(q, other, [...(await stepsOf(v1)), S('s2')]);
        await q(`UPDATE "Plan" SET status = 'active', "approvalId" = $2 WHERE id = $1`, [other, a2]);
      }))).toBe('23505');
      // The approval is set only as a draft becomes active; a draft may be dropped freely.
      expect(await code(app(`UPDATE "Plan" SET "approvalId" = $2 WHERE id = $1`, [v1, a2]))).toBe('42501');
      const draft = id('pl');
      await app(`INSERT INTO "Plan" (id, "goalId", version, "createdBy") VALUES ($1, $2, 9, 'flint')`, [draft, gid]);
      await insertSteps(app, draft, [S('s1', { title: 'Synthetic, never signed' })]);
      await app(`UPDATE "Plan" SET status = 'superseded' WHERE id = $1`, [draft]);
      expect(await code(app(`UPDATE "Plan" SET status = 'active', "approvalId" = $2 WHERE id = $1`, [draft, aid]))).toBe('42501');
      // A dropped draft is never the version a change builds on: its unsigned steps cannot ride a signed card.
      const prev = await stepsOf(v1);
      const card2 = await planCard(gid, [addOp(S('s2'))]);
      expect(await code(inTx((q) => nextVersion(q, gid, v1, 10, [...prev.map((s) => ({ ...s, title: s.key === 's1' ? 'Synthetic, never signed' : s.title })), S('s2')], card2.aid)))).toBe('42501');
      expect(await outcome(inTx((q) => nextVersion(q, gid, v1, 2, [...prev, S('s2')], card2.aid), true))).toBe('ok');
      expect(await code(app(`INSERT INTO "Plan" (id, "goalId", version, "createdBy", status) VALUES ($1, $2, 10, 'will', 'active')`, [id('pl'), gid]))).toBe('42501');
      expect(await code(owner(`UPDATE "Plan" SET rationale = 'Synthetic' WHERE id = $1`, [v1]))).toBe('42501');
    });
  });

  describe('steps', () => {
    it('are written only into a draft; on the active plan only their progress changes, never into or out of skipped', async () => {
      const { gid, v1 } = await goalWithPlan([S('s1'), S('s2'), S('s3')]);
      expect(await code(app(`INSERT INTO "PlanStep" (id, "planId", key, ordinal, title, kind) VALUES ($1, $2, 's9', 900, 'Synthetic', 'will_task')`, [id('ps'), v1]))).toBe('42501');
      await app(`UPDATE "PlanStep" SET status = 'in_progress' WHERE "planId" = $1 AND key = 's1'`, [v1]);
      await app(`UPDATE "PlanStep" SET status = 'done', "doneAt" = now(), "taskId" = 'tk1' WHERE "planId" = $1 AND key = 's1'`, [v1]);
      await app(`UPDATE "PlanStep" SET status = 'todo', "doneAt" = NULL WHERE "planId" = $1 AND key = 's1'`, [v1]);
      expect(await code(app(`UPDATE "PlanStep" SET status = 'done' WHERE "planId" = $1 AND key = 's2'`, [v1]))).toBe('23514');
      expect(await code(app(`UPDATE "PlanStep" SET status = 'skipped' WHERE "planId" = $1 AND key = 's2'`, [v1]))).toBe('42501');
      expect(await code(app(`UPDATE "PlanStep" SET title = 'Synthetic' WHERE "planId" = $1 AND key = 's2'`, [v1]))).toBe('42501');
      expect(await code(owner(`UPDATE "PlanStep" SET title = 'Synthetic', "dueAt" = now() WHERE "planId" = $1 AND key = 's2'`, [v1]))).toBe('42501');
      // Skipping is a signed plan change, and a skipped step stays skipped until another one brings it back.
      const prev = await stepsOf(v1);
      const s2 = prev.find((s) => s.key === 's2')!;
      const skip = await planCard(gid, [{ op: 'set', key: 's2', from: { title: s2.title, status: 'todo' }, to: { status: 'skipped' } }]);
      const v2 = await inTx((q) => nextVersion(q, gid, v1, 2, prev.map((s) => (s.key === 's2' ? { ...s, status: 'skipped' } : s)), skip.aid), true);
      expect(await code(app(`UPDATE "PlanStep" SET status = 'todo' WHERE "planId" = $1 AND key = 's2'`, [v2]))).toBe('42501');
      expect(await code(app(`UPDATE "PlanStep" SET "taskId" = 'tk2' WHERE "planId" = $1 AND key = 's2'`, [v2]))).toBe('42501');
      // A superseded plan's steps never change (40001: the plan was replaced; try again on the new one).
      expect(await code(app(`UPDATE "PlanStep" SET status = 'blocked' WHERE "planId" = $1 AND key = 's3'`, [v1]))).toBe('40001');
    });

    it('a Flint action is done only with its own successful action on record (H7), on insert as well as update', async () => {
      const { gid, v1 } = await goalWithPlan([S('s1', { kind: 'flint_action' }), S('s2')]);
      const audit = async (correlationId: string, outcome = 'ok', kind = 'action') => {
        const aid = id('au');
        await app(`INSERT INTO "AuditEntry" (id, actor, context, kind, action, inputs, outcome, "correlationId") VALUES ($1, 'runtime', 'autonomous', $2, 'test.step', '{}', $3, $4)`, [aid, kind, outcome, correlationId]);
        return aid;
      };
      const done = (planId: string, auditId: string | null) => app(`UPDATE "PlanStep" SET status = 'done', "doneAt" = now(), "doneAuditId" = $2 WHERE "planId" = $1 AND key = 's1'`, [planId, auditId]);
      expect(await code(done(v1, null))).toBe('42501');
      expect(await code(done(v1, await audit('some-other-proposal')))).toBe('42501');
      expect(await code(done(v1, await audit(`${gid}:s1`, 'failed')))).toBe('42501');
      expect(await code(done(v1, await audit(`${gid}:s1`, 'ok', 'decision')))).toBe('42501');
      expect(await code(done(v1, await audit(`${gid}:s2`)))).toBe('42501');
      const proof = await audit(`${gid}:s1`);
      await done(v1, proof);
      // A copy into a new version keeps its proof; a copy that swaps in a foreign ok entry is refused.
      const prev = await stepsOf(v1);
      const s2 = prev.find((s) => s.key === 's2')!;
      const ops = [{ op: 'set', key: 's2', from: { title: s2.title, status: 'todo' }, to: { status: 'blocked' } }];
      const next = prev.map((s) => (s.key === 's2' ? { ...s, status: 'blocked' } : s));
      const foreign = await audit('some-other-proposal');
      expect(await code(inTx(async (q) => nextVersion(q, gid, v1, 2, next.map((s) => (s.key === 's1' ? { ...s, doneAuditId: foreign } : s)), (await planCard(gid, ops)).aid)))).toBe('42501');
      expect(await outcome(inTx(async (q) => nextVersion(q, gid, v1, 2, next, (await planCard(gid, ops)).aid), true))).toBe('ok');
    });

    it('a step ticked while its plan is replaced is refused, not lost (the executor locks the plan; the tick reads it FOR SHARE)', async () => {
      const { gid, v1 } = await goalWithPlan([S('s1'), S('s2')]);
      const prev = await stepsOf(v1);
      const { aid } = await planCard(gid, [{ op: 'set', key: 's2', from: { title: prev[1]!.title, status: 'todo' }, to: { status: 'blocked' } }]);
      const executor = new pg.Client(pgConfig(urls.app));
      await executor.connect();
      try {
        await executor.query('BEGIN');
        await executor.query(`SELECT id FROM "Plan" WHERE id = $1 FOR UPDATE`, [v1]);
        // The tick waits on the plan...
        const tick = app(`UPDATE "PlanStep" SET status = 'in_progress' WHERE "planId" = $1 AND key = 's1'`, [v1]).then(() => 'written', (e: { code?: string }) => e.code);
        await new Promise((r) => setTimeout(r, 300));
        // ...while the executor copies version 1 as it was and replaces it.
        await nextVersion((sql, params) => executor.query(sql, params), gid, v1, 2, prev.map((s) => (s.key === 's2' ? { ...s, status: 'blocked' } : s)), aid);
        await executor.query('COMMIT');
        expect(await tick).toBe('40001');
      } finally {
        await executor.end();
      }
    });
  });

  describe('reviews, forecasts, chat suggestions and history', () => {
    async function prediction(goalId: string | null, over: Record<string, unknown> = {}): Promise<string> {
      const pid = id('pd');
      const v = { domain: 'goals', createdBy: 'runtime:goals', resolveBy: "now() + interval '30 days'", supersedes: null, ...over };
      await app(
        `INSERT INTO "Prediction" (id, claim, kind, probability, method, domain, type, evidence, "resolutionCriteria", resolver, "resolveBy", "createdBy", "goalId", "supersedesId")
         VALUES ($1, 'goal#test meets its success criteria', 'binary', 0.5, 'rule', $2, 'deadline_met', '[]', 'Synthetic criteria', 'auto_world', ${v.resolveBy}, $3, $4, $5)`,
        [pid, v.domain, v.createdBy, goalId, v.supersedes],
      );
      return pid;
    }
    const review = (goalId: string, predictionId: string, over: Record<string, unknown> = {}) => {
      const v = { kind: 'scheduled', dueAt: '2026-10-09T14:00:00.000Z', triggerEventId: null, planner: null, ...over };
      return app(
        `INSERT INTO "GoalReview" (id, "goalId", kind, "triggerEventId", "dueAt", summary, criteria, "progressBefore", "progressAfter", "predictionId", planner)
         VALUES ($1, $2, $3, $4, $5, '1 of 1 checks is met.', '[{"id":"c1","state":"met"}]', 0, 1, $6, $7) RETURNING id`,
        [id('gr'), goalId, v.kind, v.triggerEventId, v.dueAt, predictionId, v.planner],
      );
    };

    it('a goal\'s forecast comes from the goals writer only, in the goals domain, and its goal never changes', async () => {
      const gid = await goal('active');
      expect(await code(prediction(gid, { domain: 'services' }))).toBe('23514');
      expect(await code(prediction(gid, { createdBy: 'client:runtime-mcp' }))).toBe('23514');
      const pid = await prediction(gid);
      expect(await code(app(`UPDATE "Prediction" SET "goalId" = NULL WHERE id = $1`, [pid]))).toBe('42501');
    });

    it('a review needs an active goal and an open forecast of that goal (exit 6); later only its plan stage is filled in, once', async () => {
      const gid = await goal('active');
      const other = await goal('active');
      expect(await code(review(gid, await prediction(null)))).toBe('42501');
      expect(await code(review(gid, await prediction(other)))).toBe('42501');
      expect(await code(review(gid, await prediction(gid), { planner: 'none:off' }))).toBe('42501');
      const old = await prediction(gid);
      await prediction(gid, { supersedes: old });
      expect(await code(review(gid, old))).toBe('42501');
      const rid = (await review(gid, await prediction(gid))).rows[0].id as string;
      // The same scheduled due time, or the same trigger, is one review.
      expect(await code(review(gid, await prediction(gid)))).toBe('23505');
      await review(gid, await prediction(gid), { kind: 'triggered', dueAt: null, triggerEventId: 'version:ev1' });
      expect(await code(review(gid, await prediction(gid), { kind: 'triggered', dueAt: null, triggerEventId: 'version:ev1' }))).toBe('23505');
      expect(await code(review(gid, await prediction(gid), { kind: 'triggered', dueAt: null, triggerEventId: 'Some words here' }))).toBe('23514');
      await app(`UPDATE "GoalReview" SET planner = 'none:off' WHERE id = $1`, [rid]);
      expect(await code(app(`UPDATE "GoalReview" SET planner = 'none:capped' WHERE id = $1`, [rid]))).toBe('42501');
      await app(`UPDATE "GoalReview" SET diff = '[]', "proposalId" = 'prx' WHERE id = $1`, [rid]);
      expect(await code(owner(`UPDATE "GoalReview" SET summary = 'Synthetic' WHERE id = $1`, [rid]))).toBe('42501');
      expect(await code(app(`UPDATE "GoalReview" SET summary = 'Synthetic' WHERE id = $1`, [rid]))).toBe('42501');
      // A paused goal is not reviewed.
      await app(`UPDATE "Goal" SET status = 'paused' WHERE id = $1`, [gid]);
      expect(await code(review(gid, await prediction(gid), { dueAt: '2026-10-10T14:00:00.000Z' }))).toBe('42501');
    });

    it('a goal or commitment card from chat needs Will\'s own untainted words, quoted, 12 to 300 characters (exit 7)', async () => {
      const file = (action: string, o: { origin?: string; tainted?: boolean; quote?: unknown; prov?: unknown } = {}) =>
        app(
          `INSERT INTO "Proposal" (id, kind, origin, action, args, "argsDigest", "argsProvenance", tainted, sensitivity, "expiresAt") VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb, $8, 'personal', now() + interval '1 day')`,
          [
            id('prop'), action === 'goal.propose' ? 'goal' : 'tool_call', o.origin ?? 'chat:c1', action,
            JSON.stringify({ text: 'Synthetic', ...(o.quote === undefined ? { quote: 'I will finish the synthetic thing' } : o.quote === null ? {} : { quote: o.quote }) }), HEX('a'),
            JSON.stringify(o.prov ?? { quote: { source: 'will', tainted: false } }), o.tainted ?? false,
          ],
        );
      for (const action of ['goal.propose', 'world.commitment.from_chat']) {
        await file(action);
        expect(await code(file(action, { quote: null })), action).toBe('23514');
        expect(await code(file(action, { quote: 'x'.repeat(11) }))).toBe('23514');
        expect(await code(file(action, { quote: 'x'.repeat(301) }))).toBe('23514');
        expect(await code(file(action, { quote: 42 }))).toBe('23514');
        expect(await code(file(action, { prov: { quote: { source: 'model', tainted: false } } }))).toBe('23514');
        expect(await code(file(action, { prov: { quote: { source: 'will', tainted: true } } }))).toBe('23514');
        expect(await code(file(action, { prov: { quote: { source: 'will' } } }))).toBe('23514');
        expect(await code(file(action, { prov: {} }))).toBe('23514');
        expect(await code(file(action, { tainted: true }))).toBe('23514');
        expect(await code(file(action, { origin: 'console' }))).toBe('23514');
        expect(await code(file(action, { origin: 'runtime:goals' }))).toBe('23514');
      }
    });

    it('history keeps the length of a goal\'s words, never the words, with the actor flint.actor names', async () => {
      const gid = await goal('active');
      const { aid } = await card('goal.criteria_change', argsFor('criteria', gid));
      await inTx(async (q) => {
        await q(`SELECT set_config('flint.actor', $1, true)`, [`will:approval:${aid}`]);
        await setGoal(q, 'criteria', gid, aid);
      }, true);
      const rows = (await app(`SELECT actor, changed FROM "RowChange" WHERE "rowId" = $1 ORDER BY at`, [gid])).rows;
      expect(JSON.stringify(rows)).not.toMatch(/Synthetic/);
      const last = rows[rows.length - 1]!;
      expect(last.actor).toBe(`will:approval:${aid}`);
      expect(last.changed.title).toEqual([{ chars: DEF.title.length }, { chars: NEW_DEF.title.length }]);
      expect(last.changed.successCriteria[1].chars).toBeGreaterThan(last.changed.successCriteria[0].chars);
      expect(last.changed.approvalId[1]).toBe(aid);
      // Plans and steps too: their history has their progress, not their words.
      const { v1 } = await goalWithPlan([S('s1')]);
      await app(`UPDATE "PlanStep" SET status = 'blocked' WHERE "planId" = $1`, [v1]);
      const steps = (await app(`SELECT changed FROM "RowChange" WHERE "tableName" IN ('Plan', 'PlanStep') AND "rowId" IN (SELECT id FROM "PlanStep" WHERE "planId" = $1 UNION SELECT $1)`, [v1])).rows;
      expect(steps.length).toBeGreaterThan(0);
      expect(JSON.stringify(steps)).not.toMatch(/Synthetic/);
    });

    it('DELETE and TRUNCATE are refused on every P3 table (each holds rows by now)', async () => {
      for (const t of ['Goal', 'GoalEntity', 'Plan', 'PlanStep', 'GoalReview']) {
        expect(Number((await owner(`SELECT count(*) AS n FROM "${t}"`)).rows[0].n), t).toBeGreaterThan(0);
        expect(await code(owner(`DELETE FROM "${t}"`)), t).toBe('42501');
        expect(await code(owner(`TRUNCATE "${t}" CASCADE`)), t).toBe('42501');
      }
      expect(await code(app(`DELETE FROM "Goal"`))).toBe('42501');
      expect(await code(app(`DELETE FROM "Plan"`))).toBe('42501');
      expect(await code(app(`DELETE FROM "PlanStep"`))).toBe('42501');
    });

    it('every RAISE in a P3 function names its SQLSTATE; the helpers run inside trigger bodies as flint_app', async () => {
      const names = ['p3_signed_proposal', 'p3_step_norm', 'goal_insert_check', 'goal_guard', 'goal_entity_guard', 'plan_insert_check', 'plan_guard', 'plan_step_guard',
        'goal_review_insert_check', 'goal_review_guard', 'row_history_masked', 'proposal_quote_check'];
      const fns = await owner(`SELECT p.proname, p.prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = ANY ($1)`, [names]);
      expect(fns.rows.map((r) => r.proname).sort()).toEqual([...names].sort());
      for (const f of fns.rows as Array<{ proname: string; prosrc: string }>) {
        for (const r of f.prosrc.split(/RAISE EXCEPTION/).slice(1)) expect(r.slice(0, r.indexOf(';')), f.proname).toMatch(/USING ERRCODE = '(check_violation|insufficient_privilege|serialization_failure)'/);
      }
      // Read-only helpers flint_app may call; the trigger functions and the history writer it may not.
      expect((await app(`SELECT p3_step_norm('{"dueAt":"2026-10-20T22:00:00.000Z","dependsOn":["s2","s1","s2"],"note":"x"}') AS n`)).rows[0].n).toEqual({ dueAt: Date.parse('2026-10-20T22:00:00.000Z'), dependsOn: ['s1', 's2'] });
      expect((await pgError(app(`SELECT row_history_masked()`))).message).toMatch(/permission denied|trigger/);
    });
  });
});
