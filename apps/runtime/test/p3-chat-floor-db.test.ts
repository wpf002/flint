/**
 * The floor under a goal Flint takes from chat (migration p3_chat_goal_floor):
 * what a runtime that breaks its own rules still cannot do. Raw SQL as
 * flint_app on flint_test.
 *
 *  - A proposed goal with a made-up chat source is refused, whatever it says.
 *  - With its own executing card, signed by Will, it is written once, holding
 *    the card's title and quote; a card for another goal does not cover it.
 *  - Make It a Goal on a waiting suggestion: Will's signed start covers the
 *    row, and the same approval then starts the goal.
 *  - Under a rule Will signed: only with the intake's audit entry on record,
 *    only the words that entry's digest covers, and never more than twice the
 *    day's limit in any 24 hours.
 *  - Goals proposed before the floor are read, started and dismissed as before.
 *  - The runtime's role cannot switch the guard off, and an error names ids only.
 * Synthetic text only.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { SUGGESTIONS_PER_DAY, digestOf, suggestionGoalId } from '@flint/policy';
import { NO_DB, freshDb, withClient, withoutChatGoalFloor, pgConfig, pgError, id, HEX, type TestUrls } from './db';

type Q = (sql: string, params?: unknown[]) => Promise<pg.QueryResult>;
const as = (url: string): Q => (sql, params) => withClient(url, (c) => c.query(sql, params));
const CANARY = 'Synthetic CANARY-floor';
const TITLE = `${CANARY} run a half marathon`;
const QUOTE = `${CANARY} I want to run a half marathon by spring`;
const SAID = '2026-10-08T15:00:00.000Z';
const INTAKE = 'runtime:goals.candidates';
const REFUSED = (gid: string) => `goal ${gid}: a goal from chat is added only by its own signed card, or under a rule Will signed`;
const SHAPE = (gid: string) => `goal ${gid}: a goal from chat is Will's own, personal and untainted, and named by its source`;
const DEF = { successCriteria: [{ id: 'c1', text: 'Synthetic check text', check: { kind: 'manual' } }], horizonAt: null, reviewCadence: 'P1W' };

describe.skipIf(NO_DB)('a goal from chat rests on a signed card, or on a rule Will signed', () => {
  let urls: TestUrls;
  let app: Q;
  let owner: Q;
  let approver: Q;
  let credentialId: string;
  const failure = async (p: Promise<unknown>) => {
    const e = (await pgError(p)) as { code?: string; message: string; detail?: string };
    return [e.code, e.message, e.detail ?? null];
  };
  const code = async (p: Promise<unknown>) => (await pgError(p)).code;
  const on = (c: pg.Client): Q => (sql, params) => c.query(sql, params);
  /** A source no other test uses, and the goal id the runtime makes from it. */
  const source = () => `chat:${createHash('sha256').update(id()).digest('hex')}`;
  const gidOf = (src: string) => suggestionGoalId(src);
  const proposeArgs = (src: string, over: Record<string, unknown> = {}) => ({ goalId: gidOf(src), title: TITLE, quote: QUOTE, saidAt: SAID, sourceRef: src, ...over });
  const activateArgs = (src: string, over: Record<string, unknown> = {}) => ({
    goalId: gidOf(src), owner: 'will', origin: 'flint', sensitivity: 'personal', tainted: false, nexusProjectId: null, title: TITLE, description: QUOTE, ...DEF, links: [], plan: null, ...over,
  });

  beforeAll(async () => {
    urls = await freshDb();
    app = as(urls.app);
    owner = as(urls.owner);
    approver = as(urls.approver);
    credentialId = id('cred');
    await approver(`INSERT INTO "ApprovalCredential" (id, "credentialId", factor, "publicKey", label, "enrolledVia") VALUES ($1, $2, 'webauthn', '\\x00', 'test key', 'enroll_code')`, [id(), credentialId]);
  });

  /** A card as the runtime's role files one, taken as far as `stage`: Will's approval is the approver role's row. */
  async function card(action: string, args: Record<string, unknown>, o: { stage?: 'pending' | 'approved' | 'executing'; kind?: string; origin?: string; life?: string } = {}) {
    const pid = id('prop');
    const chat = action === 'goal.propose' || action === 'world.commitment.from_chat';
    const kind = o.kind ?? (action === 'policy.change' ? 'policy' : action === 'world.commitment.from_chat' ? 'tool_call' : 'goal');
    const provenance = chat ? { quote: { source: 'will', ref: 'turn:turn_1', tainted: false } } : {};
    await app(
      `INSERT INTO "Proposal" (id, kind, origin, action, "templateId", args, "argsDigest", "argsProvenance", sensitivity, consequential, "expiresAt")
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::jsonb, $9, true, now() + $10::interval)`,
      [pid, kind, o.origin ?? (chat ? 'chat:console-1' : action === 'policy.change' ? 'cli' : 'console'), action, action === 'goal.propose' ? 'chat.goal' : null,
        JSON.stringify(args), digestOf(args), JSON.stringify(provenance), action === 'policy.change' ? 'ops' : 'personal', o.life ?? '1 hour'],
    );
    const stage = o.stage ?? 'executing';
    if (stage === 'pending') return { pid, aid: '' };
    const aid = id('appr');
    const expires = (await owner(`SELECT to_char((now() + interval '10 minutes') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS t`)).rows[0].t as string;
    const payload = { v: 1, subjectType: 'proposal', subjectId: pid, decision: 'approve', action, argsDigest: digestOf(args), expiresAt: expires, nonce: HEX('0').slice(0, 32) };
    await approver(
      `INSERT INTO "Approval" (id, "subjectType", "subjectId", decision, payload, challenge, "credentialId", signature, "expiresAt") VALUES ($1, 'proposal', $2, 'approve', $3, $4, $5, '\\x01', $6)`,
      [aid, pid, JSON.stringify(payload), HEX('c'), credentialId, expires],
    );
    await app(`UPDATE "Proposal" SET status = 'approved', "approvalId" = $2 WHERE id = $1`, [pid, aid]);
    if (stage === 'executing') await app(`UPDATE "Proposal" SET status = 'executing' WHERE id = $1`, [pid]);
    return { pid, aid };
  }
  const finish = (pid: string) => app(`UPDATE "Proposal" SET status = 'executed', result = '{}'::jsonb, "executedAt" = now() WHERE id = $1`, [pid]);
  /** A goal from chat as the runtime writes one (its own card's title and quote), or as told. */
  const flintGoal = (q: Q, src: string, over: Record<string, unknown> = {}, extra = '') => {
    const v: Record<string, unknown> = { id: gidOf(src), title: TITLE, description: QUOTE, owner: 'will', origin: 'flint', sensitivity: 'personal', tainted: false, sourceRef: src, horizonAt: null, successCriteria: [], ...over };
    return q(
      `INSERT INTO "Goal" (id, title, description, owner, origin, sensitivity, tainted, "sourceRef", "horizonAt", "successCriteria", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, now()) ${extra}`,
      [v.id, v.title, v.description, v.owner, v.origin, v.sensitivity, v.tainted, v.sourceRef, v.horizonAt, JSON.stringify(v.successCriteria)],
    );
  };
  const goalRow = async (gid: string) => (await owner(`SELECT status, origin, title, description, "sourceRef", "approvalId" FROM "Goal" WHERE id = $1`, [gid])).rows[0] as Record<string, unknown> | undefined;
  const used = async (aid: string) => (await owner(`SELECT "goalId", action FROM "GoalApprovalUse" WHERE "approvalId" = $1`, [aid])).rows as Array<{ goalId: string; action: string }>;
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
  /** A rule Will signed: its policy card, approved and executing while the runtime writes the rows it lists. */
  async function rule(rows: Array<{ pattern: string; tier: string; dailyCap?: number; scope?: Record<string, unknown> }>, expiresIn = 30 * 86_400_000) {
    const expiresAt = new Date(Date.now() + expiresIn).toISOString();
    const listed = rows.map((r) => ({ ...r, expiresAt }));
    const pc = await card('policy.change', { rows: listed });
    const ids: string[] = [];
    for (const r of listed) {
      const rid = id('pol');
      ids.push(rid);
      await app(`INSERT INTO "ActionPolicy" (id, pattern, tier, "dailyCap", scope, reason, "approvalId", "expiresAt") VALUES ($1, $2, $3, $4, $5::jsonb, 'Synthetic rule', $6, $7)`, [
        rid, r.pattern, r.tier, r.dailyCap ?? null, r.scope ? JSON.stringify(r.scope) : null, pc.aid, expiresAt,
      ]);
    }
    await finish(pc.pid);
    return ids;
  }
  const retire = () => app(`UPDATE "ActionPolicy" SET active = false WHERE active`);
  /** The intake's audit entry for a goal it adds under a rule, as the runtime's role writes it (it can write any). */
  const entry = (q: Q, src: string, over: Record<string, unknown> = {}, inputs: Record<string, unknown> = {}) => {
    const v: Record<string, unknown> = { actor: INTAKE, context: 'chat', kind: 'action', action: 'goal.propose', tier: 'alone', decision: 'act', outcome: 'ok', correlationId: src, tainted: false, ...over };
    const args = proposeArgs(src);
    return q(
      `INSERT INTO "AuditEntry" (id, actor, context, kind, action, tier, inputs, decision, outcome, "correlationId", tainted) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11)`,
      [id('au'), v.actor, v.context, v.kind, v.action, v.tier, JSON.stringify({ sourceRef: src, goalId: gidOf(src), saidAt: SAID, argsDigest: digestOf(args), rule: 'policy', ...inputs }), v.decision, v.outcome, v.correlationId, v.tainted],
    );
  };
  /** Goals made here are put into the past, as the owner, so the 24 hours the database counts start empty for the next test. */
  const age = () => withClient(urls.owner, async (c) => {
    await c.query('ALTER TABLE "Goal" DISABLE TRIGGER "Goal_guard"');
    await c.query(`UPDATE "Goal" SET "createdAt" = "createdAt" - interval '3 days' WHERE "createdAt" > now() - interval '2 days'`);
    await c.query('ALTER TABLE "Goal" ENABLE TRIGGER "Goal_guard"');
  });

  describe('with no card and no rule', () => {
    it('a proposed goal with a made-up chat source is refused, whatever it says; the error names its id and nothing it holds', async () => {
      const src = source();
      expect(await failure(flintGoal(app, src))).toEqual(['42501', REFUSED(gidOf(src)), null]);
      // Nor with a card that only waits, one Will approved that is not being carried out, or one that already ran.
      const waiting = await card('goal.propose', proposeArgs(src), { stage: 'pending' });
      expect(await code(flintGoal(app, src))).toBe('42501');
      await app(`UPDATE "Proposal" SET status = 'rejected', error = 'Synthetic end' WHERE id = $1`, [waiting.pid]);
      const approved = await card('goal.propose', proposeArgs(src), { stage: 'approved' });
      expect(await code(flintGoal(app, src))).toBe('42501');
      expect(await used(approved.aid)).toEqual([]);
      // A card that says it is a goal's but is filed as a plain tool call (its digest is then never checked) covers nothing.
      const src2 = source();
      await card('goal.propose', proposeArgs(src2), { kind: 'tool_call' });
      expect(await code(flintGoal(app, src2))).toBe('42501');
      // The intake's audit entry alone, with no rule Will signed, lets nothing in.
      const src3 = source();
      await entry(app, src3);
      expect(await failure(flintGoal(app, src3))).toEqual(['42501', REFUSED(gidOf(src3)), null]);
      for (const s of [src, src2, src3]) expect(await goalRow(gidOf(s))).toBeUndefined();
    });

    it('what a goal from chat is does not bend: Will’s own, personal, untainted, and named by its source, even under its own signed card', async () => {
      const src = source();
      await card('goal.propose', proposeArgs(src));
      const gid = gidOf(src);
      for (const over of [{ owner: 'flint' }, { tainted: true }, { sensitivity: 'financial' }, { id: `go${HEX('a').slice(0, 32)}` }, { sourceRef: `chat:${HEX('b')}` }]) {
        const shown = (over as { id?: string }).id ?? gid;
        expect(await failure(flintGoal(app, src, over)), JSON.stringify(over)).toEqual(['42501', SHAPE(shown), null]);
      }
      // An id that is not shaped as one is not repeated: an error's words reach logs.
      expect(await failure(flintGoal(app, src, { id: `${CANARY} words as an id` }))).toEqual(['42501', SHAPE('?'), null]);
      // A goal called Will's own cannot carry a chat source to slip past it: a source makes it a goal from chat, held here
      // (and goal_valid refuses that pair for anyone, the owner included).
      expect(await failure(flintGoal(app, src, { origin: 'will' }))).toEqual(['42501', SHAPE(gid), null]);
      expect(await code(flintGoal(owner, src, { origin: 'will' }))).toBe('23514');
      // Nor one with no source, or a source that is not one.
      expect(await code(flintGoal(app, src, { sourceRef: null }))).toBe('42501');
      expect(await code(flintGoal(app, src, { sourceRef: 'chat:not-a-digest' }))).toBe('42501');
      expect(await goalRow(gid)).toBeUndefined();
    });

    it('the runtime’s role cannot switch the guard off, replace it, or write as if restoring', async () => {
      for (const sql of [
        'ALTER TABLE "Goal" DISABLE TRIGGER "Goal_chat_floor"',
        'ALTER TABLE "Goal" DISABLE TRIGGER USER',
        'DROP TRIGGER "Goal_chat_floor" ON "Goal"',
        `CREATE OR REPLACE FUNCTION goal_chat_floor() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RETURN NEW; END $f$`,
        'DROP FUNCTION goal_chat_floor()',
        `SET session_replication_role = replica`,
        'SELECT goal_chat_floor()',
      ]) {
        expect(await code(app(sql)), sql).toMatch(/^(42501|0A000|39P01)$/);
      }
      const src = source();
      expect(await code(inTx(async (q) => {
        await q(`SET LOCAL ROLE flint_owner`);
        await flintGoal(q, src);
      }))).toBe('42501');
      expect(await goalRow(gidOf(src))).toBeUndefined();
    });

    it('the migration owner is not held to it, as it is not held to the row clock: a fixture, or a repair by hand', async () => {
      const src = source();
      await flintGoal(owner, src, { owner: 'flint' });
      expect(await goalRow(gidOf(src))).toMatchObject({ status: 'proposed', origin: 'flint' });
      await age();
    });
  });

  describe('its own card', () => {
    it('with its real executing card it is written once, holding the card’s title and quote; the card’s approval is used for this goal', async () => {
      const src = source();
      const gid = gidOf(src);
      const c = await card('goal.propose', proposeArgs(src, { dueOn: '2027-03-20' }));
      // What it holds is what Will signed: another title, other words, checks of its own, or a day the card does not carry.
      for (const over of [{ title: `${CANARY} run a marathon` }, { description: `${CANARY} I want to run an ultra marathon by spring` }, { description: '' }, { successCriteria: DEF.successCriteria },
        { horizonAt: '2027-03-25T23:59:00.000Z' }, { horizonAt: '2027-03-19T05:00:00.000Z' }]) {
        expect(await failure(flintGoal(app, src, over)), JSON.stringify(over)).toEqual(['42501', REFUSED(gid), null]);
      }
      expect(await used(c.aid)).toEqual([]);
      // A write that lands nowhere (rolled back) uses nothing.
      await inTx((q) => flintGoal(q, src), false);
      expect(await used(c.aid)).toEqual([]);
      // The day he signed, to its end wherever Will is: 23:59 in Chicago is the next morning in UTC.
      await flintGoal(app, src, { horizonAt: '2027-03-21T04:59:00.000Z' });
      expect(await goalRow(gid)).toEqual({ status: 'proposed', origin: 'flint', title: TITLE, description: QUOTE, sourceRef: src, approvalId: null });
      expect(await used(c.aid)).toEqual([{ goalId: gid, action: 'goal.propose' }]);
      // Once: the goal is there, and its source is one goal's for good.
      expect(await code(flintGoal(app, src))).toBe('23505');
      await flintGoal(app, src, {}, 'ON CONFLICT (id) DO NOTHING');
      expect(await used(c.aid)).toHaveLength(1);
      await finish(c.pid);
      await age();
    });

    it('a card for another goal does not cover it, nor does this goal’s card cover another source', async () => {
      const [mine, other] = [source(), source()];
      const c = await card('goal.propose', proposeArgs(other));
      expect(await failure(flintGoal(app, mine))).toEqual(['42501', REFUSED(gidOf(mine)), null]);
      // The other card's goal id on this source, and this source under the other's id: neither is named by its source.
      expect(await code(flintGoal(app, mine, { id: gidOf(other) }))).toBe('42501');
      expect(await code(flintGoal(app, other, { sourceRef: mine }))).toBe('42501');
      // A card whose args name this goal's id but another source (its digest is its own; Will signed that).
      const mixed = await card('goal.propose', proposeArgs(mine, { sourceRef: other }));
      expect(await code(flintGoal(app, mine))).toBe('42501');
      expect([await used(c.aid), await used(mixed.aid)]).toEqual([[], []]);
      for (const s of [mine, other]) expect(await goalRow(gidOf(s))).toBeUndefined();
    });

    it('an insert that meets the goal already there and writes nothing spends nothing; a card whose time has passed covers nothing', async () => {
      const src = source();
      const first = await card('goal.propose', proposeArgs(src));
      await flintGoal(app, src);
      await finish(first.pid);
      // A second card for the same suggestion (as two posts once made): its insert meets the goal and writes nothing.
      const second = await card('goal.propose', proposeArgs(src));
      await flintGoal(app, src, {}, 'ON CONFLICT (id) DO NOTHING');
      expect(await used(second.aid)).toEqual([]);
      const late = source();
      const kept = await card('goal.propose', proposeArgs(late), { life: '3 seconds' });
      await new Promise((r) => setTimeout(r, 3_300));
      expect(await failure(flintGoal(app, late))).toEqual(['42501', REFUSED(gidOf(late)), null]);
      expect(await used(kept.aid)).toEqual([]);
      await age();
    });
  });

  describe('Make It a Goal on a suggestion whose card still waits', () => {
    const start = (q: Q, gid: string, aid: string) =>
      q(`UPDATE "Goal" SET status = 'active', "approvalId" = $2, "nextReviewAt" = now(), "successCriteria" = $3::jsonb, "reviewCadence" = 'P1W' WHERE id = $1`, [gid, aid, JSON.stringify(DEF.successCriteria)]);

    it('Will’s signed start covers the row while the suggestion’s own card waits, and the same approval then starts the goal', async () => {
      const src = source();
      const gid = gidOf(src);
      const waiting = await card('goal.propose', proposeArgs(src), { stage: 'pending' });
      const go = await card('goal.activate', activateArgs(src));
      // Not with other words than he signed to start.
      expect(await failure(flintGoal(app, src, { title: `${CANARY} another title`, successCriteria: DEF.successCriteria }))).toEqual(['42501', REFUSED(gid), null]);
      await inTx(async (q) => {
        await flintGoal(q, src, { successCriteria: DEF.successCriteria });
        await start(q, gid, go.aid);
        await q(`UPDATE "Proposal" SET status = 'rejected', error = 'A newer version of this card replaced it.' WHERE id = $1`, [waiting.pid]);
      });
      expect(await goalRow(gid)).toEqual({ status: 'active', origin: 'flint', title: TITLE, description: QUOTE, sourceRef: src, approvalId: go.aid });
      // One approval, one goal, one transaction: the insert and the start are the same use.
      expect(await used(go.aid)).toEqual([{ goalId: gid, action: 'goal.activate' }]);
      await finish(go.pid);
      await age();
    });

    it('not without that waiting card: none, one for another source, one that was turned down or has expired, or a start he signed as his own goal', async () => {
      const src = source();
      const gid = gidOf(src);
      const go = await card('goal.activate', activateArgs(src));
      const row = { successCriteria: DEF.successCriteria };
      // No suggestion at all behind it.
      expect(await failure(flintGoal(app, src, row))).toEqual(['42501', REFUSED(gid), null]);
      // A waiting card that names this goal under another source.
      const elsewhere = await card('goal.propose', proposeArgs(src, { sourceRef: source() }), { stage: 'pending' });
      expect(await code(flintGoal(app, src, row))).toBe('42501');
      await app(`UPDATE "Proposal" SET status = 'rejected', error = 'Synthetic end' WHERE id = $1`, [elsewhere.pid]);
      // The right one, turned down.
      const turnedDown = await card('goal.propose', proposeArgs(src), { stage: 'pending' });
      await app(`UPDATE "Proposal" SET status = 'rejected', error = 'Synthetic end' WHERE id = $1`, [turnedDown.pid]);
      expect(await code(flintGoal(app, src, row))).toBe('42501');
      // The right one, past its time.
      await card('goal.propose', proposeArgs(src), { stage: 'pending', life: '1 second' });
      await new Promise((r) => setTimeout(r, 1_300));
      expect(await code(flintGoal(app, src, row))).toBe('42501');
      expect(await used(go.aid)).toEqual([]);
      // A start signed as Will's own goal is not a start of something Flint suggested.
      const src2 = source();
      await card('goal.propose', proposeArgs(src2), { stage: 'pending' });
      const own = await card('goal.activate', activateArgs(src2, { origin: 'will' }));
      expect(await failure(flintGoal(app, src2, row))).toEqual(['42501', REFUSED(gidOf(src2)), null]);
      expect(await used(own.aid)).toEqual([]);
      for (const s of [src, src2]) expect(await goalRow(gidOf(s))).toBeUndefined();
    });
  });

  describe('under a rule Will signed', () => {
    it('only a row he signed counts: the runtime cannot write its own, and a scoped one, one held back, one switched off or one past its day lets nothing in', async () => {
      await retire();
      const src = source();
      const gid = gidOf(src);
      await entry(app, src);
      // Promoting itself: a policy row needs the policy card Will signed.
      const unrelated = await card('goal.propose', proposeArgs(source()));
      expect(await code(app(`INSERT INTO "ActionPolicy" (id, pattern, tier, reason, "approvalId", "expiresAt") VALUES ($1, 'goal.propose', 'alone', 'Synthetic', $2, now() + interval '30 days')`, [id('pol'), unrelated.aid]))).toBe('42501');
      expect(await code(flintGoal(app, src))).toBe('42501');
      // A rule he signed for something narrower does not let every goal in.
      await rule([{ pattern: 'goal.propose', tier: 'alone', dailyCap: 3, scope: { conversation: 'console-1' } }]);
      expect(await failure(flintGoal(app, src))).toEqual(['42501', REFUSED(gid), null]);
      await retire();
      // The rule, and a wider one that holds it back.
      await rule([{ pattern: 'goal.propose', tier: 'alone', dailyCap: 3 }, { pattern: 'goal.*', tier: 'approval' }]);
      expect(await code(flintGoal(app, src))).toBe('42501');
      await retire();
      // Switched off (above), and one whose day has passed.
      expect(await code(flintGoal(app, src))).toBe('42501');
      await rule([{ pattern: 'goal.propose', tier: 'alone', dailyCap: 3 }], 1_500);
      await new Promise((r) => setTimeout(r, 1_800));
      expect(await code(flintGoal(app, src))).toBe('42501');
      // A rule for another action is not this one's.
      await rule([{ pattern: 'world.commitment.from_chat', tier: 'alone', dailyCap: 10 }, { pattern: 'goal.review.local', tier: 'alone', dailyCap: 20 }]);
      expect(await code(flintGoal(app, src))).toBe('42501');
      expect(await goalRow(gid)).toBeUndefined();
      await retire();
    });

    it('with the rule and the intake’s entry on record it is written once, and only the words that entry’s digest covers', async () => {
      await retire();
      await rule([{ pattern: 'goal.propose', tier: 'alone', dailyCap: 3 }]);
      const src = source();
      const gid = gidOf(src);
      // The rule alone, with nothing on record for this goal.
      expect(await failure(flintGoal(app, src))).toEqual(['42501', REFUSED(gid), null]);
      // An entry that is not the intake's own act on this source and goal: another actor, another source, a decision that
      // only filed a card, one that failed, one that read outside text, one naming another goal, one with no digest.
      for (const [over, inputs] of [
        [{ actor: 'runtime:goals' }, {}], [{ correlationId: source() }, {}], [{ kind: 'decision', tier: 'approval', decision: 'log' }, {}], [{ outcome: 'failed' }, {}],
        [{ tainted: true }, {}], [{ context: 'autonomous' }, {}], [{}, { goalId: gidOf(source()) }], [{}, { argsDigest: null }], [{}, { saidAt: 1_791_817_200_000 }],
      ] as Array<[Record<string, unknown>, Record<string, unknown>]>) {
        await entry(app, src, over, inputs);
        expect(await code(flintGoal(app, src)), JSON.stringify([over, inputs])).toBe('42501');
      }
      // The intake's entry, written first, in the same transaction as the goal: the row is let in.
      await inTx(async (q) => {
        await entry(q, src);
        // Other words than the entry's digest covers are still refused, and a quote too short to be one.
        await q('SAVEPOINT words');
        for (const over of [{ title: `${CANARY} anything at all` }, { description: `${CANARY} words he never said` }, { successCriteria: DEF.successCriteria }, { horizonAt: '2027-03-20T23:59:00.000Z' }]) {
          expect(await code(flintGoal(q, src, over)), JSON.stringify(over)).toBe('42501');
          await q('ROLLBACK TO SAVEPOINT words');
        }
        await flintGoal(q, src);
      });
      expect(await goalRow(gid)).toEqual({ status: 'proposed', origin: 'flint', title: TITLE, description: QUOTE, sourceRef: src, approvalId: null });
      expect(await code(flintGoal(app, src))).toBe('23505');
      // A quote of 11 characters is not a quote, whatever digest is on record for it; one of 12 is.
      for (const [words, ok] of [['a'.repeat(11), false], ['b'.repeat(12), true]] as const) {
        const s = source();
        await entry(app, s, {}, { argsDigest: digestOf(proposeArgs(s, { quote: words })) });
        if (ok) await flintGoal(app, s, { description: words });
        else expect(await code(flintGoal(app, s, { description: words }))).toBe('42501');
      }
      // With a day: the entry carries it, its digest covers it, and the goal's date falls on it.
      const dated = source();
      await entry(app, dated, {}, { dueOn: '2027-03-20', argsDigest: digestOf(proposeArgs(dated, { dueOn: '2027-03-20' })) });
      expect(await code(flintGoal(app, dated, { horizonAt: '2027-04-20T23:59:00.000Z' }))).toBe('42501');
      await flintGoal(app, dated, { horizonAt: '2027-03-20T23:59:00.000Z' });
      await retire();
      await age();
    });

    it('never more than twice the day’s limit in any 24 hours, by the database’s own clock, whatever the runtime counts; a smaller cap he signed is a smaller limit', async () => {
      await retire();
      await age();
      expect(SUGGESTIONS_PER_DAY['goal.propose']).toBe(3);
      await rule([{ pattern: 'goal.propose', tier: 'alone', dailyCap: 2_147_483_647 }]);
      const add = async () => {
        const s = source();
        await entry(app, s);
        return { src: s, wrote: await flintGoal(app, s).then(() => true, (e: { code?: string }) => e.code) };
      };
      // A cap of any size: 3 a day is the limit, so 6 in 24 hours, and the seventh is refused.
      for (let i = 0; i < 6; i++) expect((await add()).wrote, `goal ${i + 1}`).toBe(true);
      const seventh = await add();
      expect(seventh.wrote).toBe('42501');
      expect(await goalRow(gidOf(seventh.src))).toBeUndefined();
      // Two at once for the last place: one lands, the other waits and is refused (the count is exact).
      await withClient(urls.owner, async (c) => {
        await c.query('ALTER TABLE "Goal" DISABLE TRIGGER "Goal_guard"');
        await c.query(`UPDATE "Goal" SET "createdAt" = "createdAt" - interval '3 days' WHERE id = (SELECT id FROM "Goal" WHERE origin = 'flint' ORDER BY "createdAt" DESC LIMIT 1)`);
        await c.query('ALTER TABLE "Goal" ENABLE TRIGGER "Goal_guard"');
      });
      const [a, b] = [source(), source()];
      await entry(app, a);
      await entry(app, b);
      const raced = await Promise.all([a, b].map((s) => flintGoal(app, s).then(() => 'ok', (e: { code?: string }) => e.code)));
      expect(raced.sort()).toEqual(['42501', 'ok']);
      // A day later (the rows are a day older) there is room again.
      await age();
      expect((await add()).wrote).toBe(true);
      // The cap he signed, when it is the smaller: 2 a day is 4 in 24 hours.
      await retire();
      await age();
      await rule([{ pattern: 'goal.*', tier: 'alone', dailyCap: 2 }]);
      for (let i = 0; i < 4; i++) expect((await add()).wrote, `goal ${i + 1} of 4`).toBe(true);
      expect((await add()).wrote).toBe('42501');
      // A goal on its own signed card is not held to the rule's limit: Will signed that one himself.
      const carded = source();
      const c = await card('goal.propose', proposeArgs(carded));
      await flintGoal(app, carded);
      await finish(c.pid);
      await retire();
      await age();
    });
  });

  describe('goals that were proposed before the floor', () => {
    it('stay as they were: read, made into goals with Will’s signature, and dismissed, with no card behind their row', async () => {
      const [first, second] = [source(), source()];
      // A database from before the migration (its own down.sql): the runtime's role writes a proposed goal with no card.
      await withoutChatGoalFloor(urls.owner, async () => {
        await flintGoal(app, first);
        await flintGoal(app, second);
      });
      // The floor is back, and it guards inserts only.
      expect(await code(flintGoal(app, source()))).toBe('42501');
      expect((await app(`SELECT id FROM "Goal" WHERE origin = 'flint' AND status = 'proposed' AND id = ANY ($1::text[]) ORDER BY id`, [[gidOf(first), gidOf(second)]])).rows.map((r) => r.id)).toEqual([gidOf(first), gidOf(second)].sort());
      // Made into a goal: Will's signed start, as before.
      const go = await card('goal.activate', activateArgs(first));
      await app(`UPDATE "Goal" SET status = 'active', "approvalId" = $2, "nextReviewAt" = now(), "successCriteria" = $3::jsonb WHERE id = $1`, [gidOf(first), go.aid, JSON.stringify(DEF.successCriteria)]);
      await finish(go.pid);
      expect(await goalRow(gidOf(first))).toMatchObject({ status: 'active', approvalId: go.aid });
      // Dismissed: unsigned, as before.
      await app(`UPDATE "Goal" SET status = 'rejected' WHERE id = $1`, [gidOf(second)]);
      expect(await goalRow(gidOf(second))).toMatchObject({ status: 'rejected' });
      await age();
    });
  });
});
