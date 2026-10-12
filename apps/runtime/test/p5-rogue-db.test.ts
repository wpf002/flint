/**
 * What a runtime that breaks the rules still cannot do to assets, tasks and
 * reviews (P5 part 1): each attack as a regression. Raw SQL as flint_app on
 * flint_test, as a compromised or buggy runtime would send it.
 *
 *  - It cannot sign for Will, change a card after he signed it, or see or touch
 *    the record of used approvals; it cannot use one approval twice (in turn,
 *    from an old snapshot, after the card expired, by keeping the card, or by
 *    spending it without making the change).
 *  - It cannot turn an asset on, hand a task over, or change the review gate on
 *    its own, in any statement shape; nor slip one in beside the other (an
 *    asset turned off under a dispatch, a reviewer turned off as reviews become
 *    required, a card approved as they do).
 *  - It cannot set a task's times, accept on its own word, cancel what went
 *    out, or replace an output; it cannot attach a foreign review, write one
 *    after the fact, rewrite one, or change whether a card needs one.
 *  - It cannot erase what is recorded, and saying "this is a forget" does not
 *    make it one.
 * The last block pins what the database does NOT prove (what the runtime
 * writes itself), so nobody assumes more.
 * Synthetic text only.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { digestOf } from '@flint/policy';
import { NO_DB, freshDb, id, HEX } from './db';
import { p5Kit, refusal, sleep, CANARY, type AssetRow, type P5Kit, type Q } from './p5';

describe.skipIf(NO_DB)('P5 against a runtime that breaks the rules', () => {
  let k: P5Kit;
  let app: Q;
  let owner: Q;
  let w: AssetRow;
  const code = (p: Promise<unknown>) => k.code(p);
  const denied = async (p: Promise<unknown>, label = '') => expect((await refusal(p)).message, label).toMatch(/permission denied/);
  const assetOn = async (assetId: string) => (await app(`SELECT enabled FROM "Asset" WHERE id = $1`, [assetId])).rows[0].enabled as boolean;
  const status = async (taskId: string) => (await app(`SELECT status FROM "Task" WHERE id = $1`, [taskId])).rows[0].status as string;
  const uses = async () => (await owner(`SELECT count(*)::int AS n FROM "TaskApprovalUse"`)).rows[0].n as number;
  const webCard = (n: string, o: Parameters<P5Kit['file']>[2] = {}) => k.file('mcp:web.fetch_url', { url: `https://example.com/${n}` }, { kind: 'tool_call', origin: 'chat:c1', tainted: true, ...o });

  beforeAll(async () => {
    k = await p5Kit(await freshDb());
    ({ app, owner } = k);
    w = await k.onAsset();
  });

  describe('signing for Will', () => {
    it('it cannot write an approval, or read, write or clear the record of used approvals', async () => {
      await denied(app(
        `INSERT INTO "Approval" (id, "subjectType", "subjectId", decision, payload, challenge, "credentialId", signature, "expiresAt") VALUES ('apprforged', 'proposal', 'p', 'approve', '{}', $1, $2, '\\x01', now() + interval '1 minute')`,
        [HEX('c'), k.credentialId]));
      const a = await k.asset();
      const c = await k.turnOn(a);
      for (const sql of [
        `SELECT * FROM "TaskApprovalUse"`,
        `INSERT INTO "TaskApprovalUse" ("approvalId", subject, action, xact) VALUES ('apprx', 'assetId:asx', 'asset.enable', '1@1')`,
        `UPDATE "TaskApprovalUse" SET xact = '0@0'`,
        `DELETE FROM "TaskApprovalUse"`,
        `TRUNCATE "TaskApprovalUse"`,
      ]) await denied(app(sql), sql);
      // Nor through the helper: it uses nothing from outside a guard, for a live card or a made-up one, and fills nothing.
      const before = await uses();
      const live = await k.card('asset.enable', k.enableArgs(a));
      expect(await code(app(`SELECT p5_bind_approval($1, 'assetId', $2, 'asset.enable')`, [live.aid, a.id]))).toBe('42501');
      expect(await code(app(`SELECT p5_bind_approval('junk' || g, 'taskId', 'ta' || g, 'task.cancel') FROM generate_series(1, 50) g`))).toBe('42501');
      // From inside a statement that fires another table's triggers, the call is still not a guard's.
      expect(await code(app(`WITH spend AS (SELECT p5_bind_approval($1, 'assetId', $2, 'asset.enable')) UPDATE "Task" SET attempts = attempts FROM spend`, [live.aid, a.id]))).toBe('42501');
      expect(await code(app(`INSERT INTO "Asset" (id, kind, "externalRef", name, "dispatchAction", spends, "entityId")
        SELECT $3, 'local_worker', $4, 'Synthetic', 'task.dispatch.local_worker', false, p5_bind_approval($1, 'assetId', $2, 'asset.enable')::text`, [live.aid, a.id, id('as'), `test:${id('r')}`]))).toBe('42501');
      expect([await uses(), await k.used(live.aid), await k.used(c.aid)]).toEqual([before, 0, 1]);
    });

    it('it cannot run a card nobody signed, borrow an approval signed for another card, or change a card after his signature', async () => {
      const a = await k.asset();
      const own = await k.file('asset.enable', k.enableArgs(a));
      expect(await k.outcome(app(`UPDATE "Proposal" SET status = 'executing' WHERE id = $1`, [own.pid]))).not.toBe('ok');
      // Will's approval of another card (another asset's, or something else entirely) does not approve this one.
      const other = await k.asset();
      const others = await k.card('asset.enable', k.enableArgs(other), { stage: 'pending' });
      expect(await k.outcome(k.approve(app, own.pid, others.aid))).not.toBe('ok');
      const git = await k.card('world.sync.git', { source: 'git' }, { kind: 'tool_call', stage: 'pending' });
      expect(await k.outcome(k.approve(app, own.pid, git.aid))).not.toBe('ok');
      // Naming those approvals on the asset turns nothing on.
      for (const aid of [others.aid, git.aid]) expect(await code(k.switchOn(app, a.id, aid))).toBe('42501');
      // A signed card never changes: not its args, its digest, its action, its kind, where it came from, its marks or its expiry.
      const signed = await k.card('asset.enable', k.enableArgs(a));
      for (const set of [
        `args = '{"assetId":"asother"}'::jsonb`, `"argsDigest" = '${HEX('b')}'`, `action = 'review.enforce'`, `kind = 'task'`, `origin = 'cli'`, `tainted = true`, `consequential = false`,
        `"expiresAt" = now() + interval '30 days'`, `"estCostUsd" = 5`, `sensitivity = 'personal'`, `"reviewRequired" = false`,
      ]) expect(await k.outcome(app(`UPDATE "Proposal" SET ${set} WHERE id = $1`, [signed.pid])), set).not.toBe('ok');
      // A card filed under the digest of other args is never there to sign.
      expect(await code(k.file('asset.enable', k.enableArgs(a, { capabilities: ['anything'] }), { digest: digestOf(k.enableArgs(a)) }))).toBe('42501');
      expect(await assetOn(a.id)).toBe(false);
      await k.switchOn(app, a.id, signed.aid);
      expect(await assetOn(a.id)).toBe(true);
    });
  });

  describe('turning an asset on by itself', () => {
    it('in two statements, in one, through an upsert, a CTE, a merge, or as a new row born on: refused', async () => {
      const a = await k.asset();
      // Even with cards Will really signed: for another asset, for this asset as something else, and for something else that names it.
      const other = await k.asset();
      const others = await k.card('asset.enable', k.enableArgs(other));
      const wider = await k.card('asset.enable', k.enableArgs(a, { capabilities: ['draft_note', 'sort_items', 'summarize_items'] }));
      const cancel = await k.card('task.cancel', { taskId: 'tanone', assetId: a.id });
      const attempts: Array<[string, () => Promise<unknown>]> = [
        ['on', () => app(`UPDATE "Asset" SET enabled = true WHERE id = $1`, [a.id])],
        ['on, naming a made-up approval', () => k.switchOn(app, a.id, 'apprforged')],
        ['on, under another asset\'s card', () => k.switchOn(app, a.id, others.aid)],
        ['on, as more than was signed', () => k.switchOn(app, a.id, wider.aid)],
        ['on, under a card for something else', () => k.switchOn(app, a.id, cancel.aid)],
        ['an upsert', () => app(`INSERT INTO "Asset" (id, kind, "externalRef", name, "dispatchAction", spends) VALUES ($1, $2, $3, $4, $5, false)
                                 ON CONFLICT (id) DO UPDATE SET enabled = true, "approvalId" = $6`, [a.id, a.kind, a.externalRef, a.name, a.dispatchAction, others.aid])],
        ['an upsert on its reference', () => app(`INSERT INTO "Asset" (id, kind, "externalRef", name, "dispatchAction", spends) VALUES ($1, $2, $3, $4, $5, false)
                                                  ON CONFLICT (kind, "externalRef") DO UPDATE SET enabled = true`, [id('as'), a.kind, a.externalRef, a.name, a.dispatchAction])],
        ['a data-modifying CTE', () => app(`WITH sign AS (UPDATE "Asset" SET "approvalId" = $2 WHERE id = $1 RETURNING 1)
                                            UPDATE "Asset" SET enabled = true WHERE id = $1 AND EXISTS (SELECT 1 FROM sign)`, [a.id, others.aid])],
        ['a merge', () => app(`MERGE INTO "Asset" t USING (SELECT $1::text AS id) s ON t.id = s.id WHEN MATCHED THEN UPDATE SET enabled = true, "approvalId" = $2`, [a.id, others.aid])],
        ['a new row, born on', () => k.asset({ enabled: true })],
        ['a new row, born signed', () => k.asset({ approvalId: others.aid })],
        ['the same asset under another id', () => k.asset({ kind: a.kind, externalRef: a.externalRef })],
      ];
      for (const [label, attempt] of attempts) expect(await k.outcome(attempt()), label).not.toBe('ok');
      expect(await assetOn(a.id)).toBe(false);
      expect((await app(`SELECT count(*)::int AS n FROM "Asset" WHERE "externalRef" = $1`, [a.externalRef])).rows[0].n).toBe(1);
      // What it is cannot be changed to fit a card either: flint_app has no grant on those columns.
      for (const set of [`capabilities = '{draft_note,sort_items,summarize_items}'`, `name = 'Other'`, `kind = 'ci_runner'`, `spends = true`, `"dispatchAction" = 'review.local'`, `"createdAt" = now()`]) {
        await denied(app(`UPDATE "Asset" SET ${set} WHERE id = $1`, [a.id]), set);
      }
      for (const sql of [`DELETE FROM "Asset" WHERE id = '${a.id}'`, `TRUNCATE "Asset" CASCADE`]) await denied(app(sql), sql);
    });
  });

  describe('using one approval twice', () => {
    it('in turn: a card left executing never turns an asset back on after it was turned off, and never dispatches a second time', async () => {
      const a = await k.asset();
      const c = await k.card('asset.enable', k.enableArgs(a));
      await k.switchOn(app, a.id, c.aid);
      // The runtime never completes the card. The asset is turned off (unsigned).
      await k.switchOff(app, a.id);
      for (const set of [`enabled = true`, `enabled = true, "approvalId" = '${c.aid}'`, `enabled = true, "approvalId" = NULL`]) expect(await code(app(`UPDATE "Asset" SET ${set} WHERE id = $1`, [a.id])), set).toBe('42501');
      expect(await assetOn(a.id)).toBe(false);
      // Nothing is handed to it meanwhile.
      const t = await k.task(a.id);
      const d = await k.card(a.dispatchAction, k.dispatchArgs(t, a.kind));
      expect(await code(k.queue(app, t.id, d.aid, await k.forecast()))).toBe('42501');
      // A dispatch card is the card of one task: a second task with the same title, spec and bar needs its own.
      const first = await k.task(w.id);
      const twin = await k.task(w.id);
      const one = await k.card(w.dispatchAction, k.dispatchArgs(first, w.kind));
      await k.queue(app, first.id, one.aid, await k.forecast());
      expect(await code(k.queue(app, twin.id, one.aid, await k.forecast()))).toBe('42501');
      expect(await status(twin.id)).toBe('proposed');
    });

    it('from an old snapshot: a transaction opened while the card was executing gains nothing once it has run', async () => {
      for (const iso of ['REPEATABLE READ', 'SERIALIZABLE']) {
        const a = await k.asset();
        const c = await k.card('asset.enable', k.enableArgs(a));
        const t = await k.task(w.id);
        const d = await k.card(w.dispatchAction, k.dispatchArgs(t, w.kind));
        const f = await k.forecast();
        const stale = await k.client();
        try {
          await stale.query(`BEGIN ISOLATION LEVEL ${iso}`);
          await stale.query('SELECT count(*) FROM "Proposal"');
          // Meanwhile both cards complete without being used, and time passes.
          await k.finish(c.pid);
          await k.finish(d.pid);
          // The stale transaction still sees them executing: it is refused for what it is.
          expect(await code(k.switchOn(k.on(stale), a.id, c.aid)), iso).toBe('40001');
          await stale.query('ROLLBACK');
          await stale.query(`BEGIN ISOLATION LEVEL ${iso}`);
          expect(await code(k.queue(k.on(stale), t.id, d.aid, f)), iso).toBe('40001');
          await stale.query('ROLLBACK');
        } finally {
          await stale.end();
        }
        expect([await assetOn(a.id), await status(t.id)], iso).toEqual([false, 'proposed']);
      }
    });

    it('after it expired, or by keeping it: a card past its expiry, and one filed to stay good for months, act on nothing', async () => {
      const a = await k.asset();
      const brief = await k.card('asset.enable', k.enableArgs(a), { life: '2 seconds' });
      const t = await k.client();
      try {
        await t.query('BEGIN');
        await t.query('SELECT now()');
        await sleep(2300);
        // The transaction began before the card expired; the wall clock says it has.
        expect(await code(k.switchOn(k.on(t), a.id, brief.aid))).toBe('42501');
        await t.query('ROLLBACK');
      } finally {
        await t.end();
      }
      const sleeper = await k.card('asset.enable', k.enableArgs(a), { life: '170 days', stage: 'approved' });
      // Months later (here: now) the runtime claims it. The claim itself is P1's to allow; the turn-on is not.
      await app(`UPDATE "Proposal" SET status = 'executing' WHERE id = $1`, [sleeper.pid]);
      expect(await code(k.switchOn(app, a.id, sleeper.aid))).toBe('42501');
      const task = await k.task(w.id);
      const kept = await k.card(w.dispatchAction, k.dispatchArgs(task, w.kind), { life: '60 days' });
      expect(await code(k.queue(app, task.id, kept.aid, await k.forecast()))).toBe('42501');
      expect([await assetOn(a.id), await status(task.id)]).toEqual([false, 'proposed']);
    });

    it('by spending it: a change that does not land uses nothing, so it cannot burn Will\'s card', async () => {
      const a = await k.asset();
      const c = await k.card('asset.enable', k.enableArgs(a));
      // Statements that change no row.
      await app(`UPDATE "Asset" SET enabled = true, "approvalId" = $2 WHERE id = $1 AND false`, [a.id, c.aid]);
      await app(`INSERT INTO "Asset" (id, kind, "externalRef", name, "dispatchAction", spends) VALUES ($1, $2, $3, $4, $5, false) ON CONFLICT (id) DO UPDATE SET enabled = true, "approvalId" = $6 WHERE false`,
        [a.id, a.kind, a.externalRef, a.name, a.dispatchAction, c.aid]);
      // One rolled back, and one refused after its guard ran (the second row of the statement is not an asset the card signed).
      await k.inTx((q) => k.switchOn(q, a.id, c.aid), { commit: false });
      const other = await k.asset();
      expect(await k.outcome(app(`UPDATE "Asset" SET enabled = true, "approvalId" = $3 WHERE id IN ($1, $2)`, [a.id, other.id, c.aid]))).not.toBe('ok');
      expect([await k.used(c.aid), await assetOn(a.id), await assetOn(other.id)]).toEqual([0, false, false]);
      // A dispatch refused at its last check (no forecast) leaves the card unused too.
      const t = await k.task(w.id);
      const d = await k.card(w.dispatchAction, k.dispatchArgs(t, w.kind));
      expect(await code(k.queue(app, t.id, d.aid, null))).toBe('42501');
      expect(await k.used(d.aid)).toBe(0);
      await k.switchOn(app, a.id, c.aid);
      await k.queue(app, t.id, d.aid, await k.forecast());
      expect([await k.used(c.aid), await k.used(d.aid)]).toEqual([1, 1]);
    });
  });

  describe('handing over what Will did not sign', () => {
    it('it cannot change a task to fit a card, swap what a card dispatches, or dispatch in any statement shape without one', async () => {
      const t = await k.task(w.id);
      const c = await k.card(w.dispatchAction, k.dispatchArgs(t, w.kind));
      // The task Will was shown never changes: what it is (no grant at all), and its spec and bar (granted only so that retention can clear them).
      for (const set of [`title = 'Other'`, `"assetId" = '${w.id}'`, `"goalId" = 'go1'`, `"stepKey" = 's1'`, `origin = 'flint'`, `sensitivity = 'personal'`, `tainted = true`, `"entityIds" = '{}'`, `"estCostUsd" = 9`, `"dueAt" = now()`, `"createdAt" = now()`, `id = 'taother'`]) {
        await denied(app(`UPDATE "Task" SET ${set} WHERE id = $1`, [t.id]), set);
      }
      expect(await code(app(`UPDATE "Task" SET spec = '{"template":"draft_note","params":{}}' WHERE id = $1`, [t.id]))).toBe('42501');
      expect(await code(app(`UPDATE "Task" SET acceptance = '[{"id":"a1","text":"anything goes"}]' WHERE id = $1`, [t.id]))).toBe('42501');
      // Another task under this card: one with another spec, and one made to look the same.
      const harder = await k.task(w.id, { spec: { template: 'draft_note', params: { what: `${CANARY} something else` } } });
      expect(await code(k.queue(app, harder.id, c.aid, await k.forecast()))).toBe('42501');
      // Without a card, in every shape.
      const f = await k.forecast();
      const attempts: Array<[string, () => Promise<unknown>]> = [
        ['queued', () => app(`UPDATE "Task" SET status = 'queued' WHERE id = $1`, [harder.id])],
        ['queued, with a made-up approval', () => k.queue(app, harder.id, 'apprforged', f)],
        ['straight to dispatched', () => app(`UPDATE "Task" SET status = 'dispatched' WHERE id = $1`, [harder.id])],
        ['straight to accepted', () => app(`UPDATE "Task" SET status = 'accepted', "metBar" = true, "barCheckedBy" = 'flint:rule' WHERE id = $1`, [harder.id])],
        ['born queued', () => k.task(w.id, { status: 'queued', dispatchApprovalId: c.aid })],
        ['an upsert', () => app(`INSERT INTO "Task" (id, "assetId", title, spec, acceptance, origin, "estCostUsd", "updatedAt") VALUES ($1, $2, 'T', '{"template":"x"}', '[{"id":"a1"}]', 'will', 0, now())
                                 ON CONFLICT (id) DO UPDATE SET status = 'queued', "dispatchApprovalId" = $3, "predictionId" = $4`, [harder.id, w.id, c.aid, f])],
        ['a data-modifying CTE', () => app(`WITH a AS (UPDATE "Task" SET "dispatchApprovalId" = $2 WHERE id = $1 RETURNING 1)
                                            UPDATE "Task" SET status = 'queued', "predictionId" = $3 WHERE id = $1 AND EXISTS (SELECT 1 FROM a)`, [harder.id, c.aid, f])],
        ['a merge', () => app(`MERGE INTO "Task" t USING (SELECT $1::text AS id) s ON t.id = s.id WHEN MATCHED THEN UPDATE SET status = 'queued', "dispatchApprovalId" = $2, "predictionId" = $3`, [harder.id, c.aid, f])],
      ];
      for (const [label, attempt] of attempts) expect(await k.outcome(attempt()), label).not.toBe('ok');
      expect([await status(harder.id), await k.used(c.aid)]).toEqual(['proposed', 0]);
      await k.queue(app, t.id, c.aid, f);
      expect(await status(t.id)).toBe('queued');
    });

    it('an asset is not turned off under a dispatch, nor a task dispatched to an asset as it is turned off', async () => {
      // The dispatch first: turning the asset off waits for it, and the task then never goes out.
      const a = await k.onAsset();
      const t = await k.task(a.id);
      const c = await k.card(a.dispatchAction, k.dispatchArgs(t, a.kind));
      const [d, o] = [await k.client(), await k.client()];
      try {
        await d.query('BEGIN');
        await k.queue(k.on(d), t.id, c.aid, await k.forecast());
        const off = k.outcome(k.switchOff(k.on(o), a.id));
        await sleep(300);
        await d.query('COMMIT');
        expect(await off).toBe('ok');
      } finally {
        await d.end();
        await o.end();
      }
      expect([await status(t.id), await assetOn(a.id)]).toEqual(['queued', false]);
      expect(await code(k.setStatus(app, t.id, 'dispatched'))).toBe('42501');

      // The turn-off first: the dispatch waits for it, then sees the asset off.
      const b = await k.onAsset();
      const u = await k.task(b.id);
      const e = await k.card(b.dispatchAction, k.dispatchArgs(u, b.kind));
      const f = await k.forecast();
      const [o2, d2] = [await k.client(), await k.client()];
      try {
        await o2.query('BEGIN');
        await k.switchOff(k.on(o2), b.id);
        const queued = k.outcome(k.queue(k.on(d2), u.id, e.aid, f));
        await sleep(300);
        await o2.query('COMMIT');
        expect(await queued).toBe('42501');
      } finally {
        await o2.end();
        await d2.end();
      }
      expect([await status(u.id), await k.used(e.aid)]).toEqual(['proposed', 0]);
    });
  });

  describe('a task\'s times, its result and its end', () => {
    it('it cannot set when a task went out or ended, backdate one, or undo an end', async () => {
      const t = await k.taskAt('queued', w);
      for (const set of [`"dispatchedAt" = '2020-01-01'`, `"completedAt" = now()`, `status = 'dispatched', "dispatchedAt" = '2020-01-01'`, `"createdAt" = '2020-01-01'`]) await denied(app(`UPDATE "Task" SET ${set} WHERE id = $1`, [t.id]), set);
      // Born with times: refused, or overwritten by the wall clock.
      expect(await code(k.task(w.id, { dispatchedAt: '2020-01-01' }))).toBe('42501');
      const backdated = await k.task(w.id, { createdAt: '2020-01-01' });
      expect(Date.now() - new Date((await app(`SELECT "createdAt" FROM "Task" WHERE id = $1`, [backdated.id])).rows[0].createdAt).getTime()).toBeLessThan(60_000);
      // An end is an end: nothing brings a failed, cancelled, accepted or rejected task back to life.
      await k.setStatus(app, t.id, 'failed', `, failure = 'error'`);
      for (const to of ['proposed', 'queued', 'dispatched', 'checking', 'accepted']) expect(await code(k.setStatus(app, t.id, to)), to).toBe('42501');
      expect(await code(app(`UPDATE "Task" SET failure = NULL WHERE id = $1`, [t.id]))).toBe('42501');
    });

    it('it cannot accept on its own word: not with its own check on record, its own card, another task\'s card, a policy row of its own, or by redoing the check', async () => {
      const t = await k.taskAt('checked', w);
      const proof = await k.proof(t.id);
      const accept = (taskId = t.id, au = proof) => k.setStatus(app, taskId, 'accepted', `, "acceptedAuditId" = $3`, [au]);
      // Its own check, recorded by itself: not enough without Will.
      expect(await code(accept())).toBe('42501');
      // A card of its own that Will never signed: it cannot be made to execute.
      const own = await k.file('task.check_bar', { taskId: t.id, metBar: true }, { origin: 'runtime:tasks' });
      expect(await k.outcome(app(`UPDATE "Proposal" SET status = 'executing' WHERE id = $1`, [own.pid]))).not.toBe('ok');
      expect(await code(accept())).toBe('42501');
      // Will's accept card for another task; and for this one, signed but not yet claimed.
      const other = await k.taskAt('checked', w);
      const others = await k.card('task.check_bar', { taskId: other.id, metBar: true }, { origin: 'runtime:tasks' });
      await k.card('task.check_bar', { taskId: t.id, metBar: true, n: 1 }, { origin: 'runtime:tasks', stage: 'approved' });
      expect(await code(accept())).toBe('42501');
      // Promoting itself: a policy row needs the policy card Will signed.
      expect(await k.outcome(app(`INSERT INTO "ActionPolicy" (id, pattern, tier, reason, "approvalId", "expiresAt") VALUES ($1, 'task.check_bar', 'alone', 'Synthetic', $2, now() + interval '30 days')`, [id('pol'), others.aid]))).not.toBe('ok');
      // A scoped promotion Will did sign (for something narrower) does not promote every acceptance.
      const expiresAt = new Date(Date.now() + 30 * 86_400_000).toISOString();
      const scoped = { pattern: 'task.check_bar', tier: 'alone', scope: { template: 'watch_ci' }, expiresAt };
      const pc = await k.card('policy.change', { rows: [scoped] }, { kind: 'policy' });
      await app(`INSERT INTO "ActionPolicy" (id, pattern, tier, scope, reason, "approvalId", "expiresAt") VALUES ($1, 'task.check_bar', 'alone', $2::jsonb, 'Synthetic scoped promotion', $3, $4)`, [id('pol'), JSON.stringify(scoped.scope), pc.aid, expiresAt]);
      await k.finish(pc.pid);
      expect(await code(accept())).toBe('42501');
      // A check that failed is not accepted by saying it passed, by redoing it, or by calling the override its own.
      const failed = await k.taskAt('checked', w, {}, { met: false });
      const failedProof = await k.proof(failed.id);
      expect(await code(accept(failed.id, failedProof))).toBe('42501');
      expect(await code(app(`UPDATE "Task" SET "metBar" = true WHERE id = $1`, [failed.id]))).toBe('42501');
      expect(await code(app(`UPDATE "Task" SET status = 'accepted', "metBar" = true, "acceptedAuditId" = $2 WHERE id = $1`, [failed.id, failedProof]))).toBe('42501');
      expect(await code(app(`UPDATE "Task" SET status = 'accepted', "barCheckedBy" = 'will', "acceptedAuditId" = $2 WHERE id = $1`, [failed.id, await k.proof(failed.id, { action: 'task.bar_override' })]))).toBe('42501');
      expect([await status(t.id), await status(failed.id), await k.used(others.aid)]).toEqual(['checking', 'checking', 0]);
      // Rejecting what passed is not its call either, and it cannot sign the override as Will.
      expect(await code(k.setStatus(app, t.id, 'rejected'))).toBe('42501');
      expect(await code(k.setStatus(app, t.id, 'rejected', `, "barCheckedBy" = 'will'`))).toBe('42501');
    });

    it('an override does not slip in as the task\'s forecast is scored: it waits for the score, then finds the result final', async () => {
      const t = await k.taskAt('checked', w);
      await k.accept(t.id);
      const forecastId = (await app(`SELECT "predictionId" FROM "Task" WHERE id = $1`, [t.id])).rows[0].predictionId as string;
      const over = await k.card('task.bar_override', { taskId: t.id, to: 'rejected' });
      const [score, o] = [await k.client(), await k.client()];
      try {
        await score.query('BEGIN');
        await score.query(`INSERT INTO "Resolution" (id, "predictionId", outcome, "eventAt", "resolvedBy") VALUES ($1, $2, true, now(), 'auto_world')`, [id('rs'), forecastId]);
        const overridden = k.outcome(k.setStatus(k.on(o), t.id, 'rejected', `, "barCheckedBy" = 'will'`));
        await sleep(300);
        await score.query('COMMIT');
        expect(await overridden).toBe('42501');
      } finally {
        await score.end();
        await o.end();
      }
      expect([await status(t.id), await k.used(over.aid)]).toEqual(['accepted', 0]);
    });

    it('it cannot cancel what went out, replace or drop an output, or hand in a second one', async () => {
      const t = await k.taskAt('dispatched', w);
      expect(await code(k.setStatus(app, t.id, 'cancelled'))).toBe('42501');
      await k.putOutput(app, t.id);
      const other = { headline: `${CANARY} a better answer` };
      expect(await k.outcome(k.putOutput(app, t.id, other))).not.toBe('ok');
      await denied(app(`UPDATE "TaskOutput" SET body = $2::jsonb, sha256 = $3 WHERE "taskId" = $1`, [t.id, JSON.stringify(other), digestOf(other)]));
      await denied(app(`TRUNCATE "TaskOutput"`));
      // Deleted early, alone or to make room for another: refused while the task is live.
      for (const sql of [
        `DELETE FROM "TaskOutput" WHERE "taskId" = $1`,
        `WITH gone AS (DELETE FROM "TaskOutput" WHERE "taskId" = $1 RETURNING 1) SELECT count(*) FROM gone`,
        `MERGE INTO "TaskOutput" o USING (SELECT $1::text AS id) s ON o."taskId" = s.id WHEN MATCHED THEN DELETE`,
      ]) expect(await code(app(sql, [t.id])), sql).toBe('42501');
      // An output marked as trusted text is never stored.
      const u = await k.taskAt('dispatched', w);
      expect(await code(app(`INSERT INTO "TaskOutput" ("taskId", body, sha256, tainted) VALUES ($1, '{"headline":"x"}', $2, false)`, [u.id, HEX('a')]))).toBe('23514');
      // Once the task has ended its output may go (retention), and nothing takes its place.
      await k.setStatus(app, t.id, 'submitted', `, "outputRef" = 'out:abc'`);
      await k.setStatus(app, t.id, 'failed', `, failure = 'invalid'`);
      await app(`DELETE FROM "TaskOutput" WHERE "taskId" = $1`, [t.id]);
      expect(await code(k.putOutput(app, t.id, other))).toBe('42501');
    });
  });

  describe('reviews and the gate', () => {
    it('it cannot attach a foreign review, write one after the fact, rewrite one, or change whether a card needs one', async () => {
      const mine = await webCard('rogue-1');
      const theirs = await webCard('rogue-2');
      const theirReview = await k.reviewed(theirs.pid, { verdict: 'proceed' }, false);
      // Another card's review; a review "of" this card by another card's digest.
      expect(await code(app(`UPDATE "Proposal" SET "reviewId" = $2 WHERE id = $1`, [mine.pid, theirReview]))).toBe('42501');
      expect(await code(k.review({ subjectId: mine.pid, subjectDigest: theirs.digest, tainted: true }))).toBe('42501');
      // Filed already reviewed, or already not needing one though it read outside text.
      expect(await code(app(`INSERT INTO "Proposal" (id, kind, origin, action, args, "argsDigest", "argsProvenance", tainted, "reviewId", "expiresAt") VALUES ($1, 'tool_call', 'chat:c1', 'x.y', '{}', $2, '{}', true, $3, now() + interval '1 hour')`,
        [id('prop'), HEX('a'), theirReview]))).toBe('42501');
      const dodged = id('prop');
      await app(`INSERT INTO "Proposal" (id, kind, origin, action, args, "argsDigest", "argsProvenance", tainted, "reviewRequired", "expiresAt") VALUES ($1, 'tool_call', 'chat:c1', 'x.y', '{}', $2, '{}', true, false, now() + interval '1 hour')`, [dodged, HEX('a')]);
      expect((await app(`SELECT "reviewRequired" FROM "Proposal" WHERE id = $1`, [dodged])).rows[0].reviewRequired).toBe(true);
      for (const set of [`"reviewRequired" = false`, `"reviewRequired" = NULL`, `tainted = false`, `kind = 'goal'`, `action = 'review.enforce'`]) expect(await k.outcome(app(`UPDATE "Proposal" SET ${set} WHERE id = $1`, [dodged])), set).not.toBe('ok');
      // Calling a card `review.enforce` does spare it a review, and makes it a card that can only change the gate:
      // which a card from chat, with outside text in it, never does.
      const named = await k.card('review.enforce', { gate: 'proposal', enforced: true, url: 'https://example.com/x' }, { kind: 'tool_call', origin: 'chat:c1', tainted: true });
      expect((await app(`SELECT "reviewRequired" FROM "Proposal" WHERE id = $1`, [named.pid])).rows[0].reviewRequired).toBe(false);
      expect(await code(k.setGate(app, true, named.aid))).toBe('42501');

      // After the fact: once the card is approved, no review of it is written, and none is attached.
      const late = await k.reviewed(mine.pid, { verdict: 'block' }, false);
      await k.approve(app, mine.pid, await k.approval(mine.pid, 'mcp:web.fetch_url', mine.digest));
      expect(await code(k.review({ subjectId: mine.pid, subjectDigest: mine.digest, tainted: true, verdict: 'proceed' }))).toBe('42501');
      expect(await code(app(`UPDATE "Proposal" SET "reviewId" = $2 WHERE id = $1`, [mine.pid, late]))).toBe('42501');
      // Backdating one to look as if it came first: the time is the database's.
      const backdated = await k.reviewed(theirs.pid, { createdAt: '2020-01-01' });
      expect(Date.now() - new Date((await app(`SELECT "createdAt" FROM "Review" WHERE id = $1`, [backdated])).rows[0].createdAt).getTime()).toBeLessThan(60_000);

      // Rewriting: what it found (no grant), its words (cleared only), the card it is on (once).
      for (const set of [`verdict = 'proceed'`, `"subjectId" = '${mine.pid}'`, `"subjectDigest" = '${mine.digest}'`, `"reasonCodes" = '{none}'`, `findings = '[]'`, `confidence = 0.99`, `agreed = true`, `shadow = false`, `tainted = false`, `"createdAt" = '2020-01-01'`]) {
        await denied(app(`UPDATE "Review" SET ${set} WHERE id = $1`, [late]), set);
      }
      expect(await code(app(`UPDATE "Review" SET attack = 'Synthetic: nothing to worry about', "textPurgedAt" = now() WHERE id = $1`, [late]))).toBe('42501');
      for (const sql of [`DELETE FROM "Review" WHERE id = '${late}'`, `TRUNCATE "Review" CASCADE`]) await denied(app(sql), sql);
      expect(await code(app(`UPDATE "Proposal" SET "reviewId" = $2 WHERE id = $1`, [theirs.pid, theirReview]))).toBe('42501');
      // A block it would rather not have scored: the override's forecast is the reviews writer's own, attached once.
      expect(await code(app(`UPDATE "Review" SET "overridePredictionId" = $2 WHERE id = $1`, [late, await k.forecast({ type: 'effect_given_accept', createdBy: 'runtime:reviews' })]))).toBe('42501');
    });

    it('it cannot turn the gate, in any statement shape; nor approve around it', async () => {
      const reviewer = await k.onAsset({ kind: 'local_reviewer', capabilities: ['review'] });
      const unreviewed = await webCard('rogue-3');
      const signed = await k.approval(unreviewed.pid, 'mcp:web.fetch_url', unreviewed.digest);
      await k.enforce(true);
      try {
        const other = await k.card('asset.enable', k.enableArgs(await k.asset()), { stage: 'pending' });
        const attempts: Array<[string, () => Promise<unknown>]> = [
          ['off', () => app(`UPDATE "ReviewGate" SET enforced = false`)],
          ['off, naming a made-up approval', () => k.setGate(app, false, 'apprforged')],
          ['off, under a card for something else', () => k.setGate(app, false, other.aid)],
          ['a merge', () => app(`MERGE INTO "ReviewGate" g USING (SELECT 1) s ON g.id = 'proposal' WHEN MATCHED THEN UPDATE SET enforced = false, "approvalId" = 'apprforged'`)],
          ['a data-modifying CTE', () => app(`WITH a AS (UPDATE "ReviewGate" SET "approvalId" = 'apprforged' RETURNING 1) UPDATE "ReviewGate" SET enforced = false WHERE EXISTS (SELECT 1 FROM a)`)],
        ];
        for (const [label, attempt] of attempts) expect(await k.outcome(attempt()), label).not.toBe('ok');
        for (const sql of [`DELETE FROM "ReviewGate"`, `TRUNCATE "ReviewGate"`, `INSERT INTO "ReviewGate" (id, enforced) VALUES ('proposal', false) ON CONFLICT (id) DO UPDATE SET enforced = false`, `UPDATE "ReviewGate" SET "changedAt" = now() + interval '1 year'`, `UPDATE "ReviewGate" SET id = 'task'`]) {
          await denied(app(sql), sql);
        }
        expect((await k.gate()).enforced).toBe(true);
        // Around it: the unreviewed card is not approved in any shape, and Will's approval is not used up trying.
        for (const sql of [
          `UPDATE "Proposal" SET status = 'approved', "approvalId" = $2 WHERE id = $1`,
          `WITH a AS (UPDATE "Proposal" SET status = 'approved', "approvalId" = $2 WHERE id = $1 RETURNING 1) SELECT count(*) FROM a`,
          `MERGE INTO "Proposal" p USING (SELECT $1::text AS id) s ON p.id = s.id WHEN MATCHED THEN UPDATE SET status = 'approved', "approvalId" = $2`,
          `UPDATE "Proposal" SET status = 'executing', "approvalId" = $2 WHERE id = $1`,
        ]) expect(await k.outcome(app(sql, [unreviewed.pid, signed])), sql).not.toBe('ok');
        expect((await app(`SELECT p.status, a."consumedAt" FROM "Proposal" p, "Approval" a WHERE p.id = $1 AND a.id = $2`, [unreviewed.pid, signed])).rows[0]).toEqual({ status: 'pending', consumedAt: null });
        // A review written now, by the runtime, does not make the signature Will already gave name it.
        await k.reviewed(unreviewed.pid, { verdict: 'proceed' });
        expect(await code(k.approve(app, unreviewed.pid, signed))).toBe('42501');
        // The last reviewer stays on; flint_app cannot make another kind of asset count as one.
        expect(await code(k.switchOff(app, reviewer.id))).toBe('42501');
        expect((await app(`SELECT count(*)::int AS n FROM review_gate_violations`)).rows[0].n).toBe(0);
      } finally {
        await k.enforce(false);
        await k.switchOff(app, reviewer.id);
      }
    });

    it('races: a card is not approved unreviewed as reviews become required, and the last reviewer is not turned off as they do', async () => {
      const reviewer = await k.onAsset({ kind: 'local_reviewer', capabilities: ['review'] });
      try {
        // The gate first: the approval waits for it, then finds reviews required.
        const card = await webCard('race-1');
        const signed = await k.approval(card.pid, 'mcp:web.fetch_url', card.digest);
        const on = await k.card('review.enforce', { gate: 'proposal', enforced: true, n: 'race-1' });
        const [g, a] = [await k.client(), await k.client()];
        try {
          await g.query('BEGIN');
          await k.setGate(k.on(g), true, on.aid);
          const approved = k.outcome(k.approve(k.on(a), card.pid, signed));
          await sleep(300);
          await g.query('COMMIT');
          expect(await approved).toBe('42501');
        } finally {
          await g.end();
          await a.end();
        }
        await k.finish(on.pid);
        expect((await app(`SELECT count(*)::int AS n FROM review_gate_violations`)).rows[0].n).toBe(0);
        await k.enforce(false);

        // The approval first: the gate waits for it, and is stamped after it, so that card is no violation.
        const early = await webCard('race-2');
        const earlySigned = await k.approval(early.pid, 'mcp:web.fetch_url', early.digest);
        const on2 = await k.card('review.enforce', { gate: 'proposal', enforced: true, n: 'race-2' });
        const [a2, g2] = [await k.client(), await k.client()];
        try {
          await a2.query('BEGIN');
          await k.approve(k.on(a2), early.pid, earlySigned);
          const gated = k.outcome(k.setGate(k.on(g2), true, on2.aid));
          await sleep(300);
          await a2.query('COMMIT');
          expect(await gated).toBe('ok');
        } finally {
          await a2.end();
          await g2.end();
        }
        await k.finish(on2.pid);
        expect((await app(`SELECT count(*)::int AS n FROM review_gate_violations`)).rows[0].n).toBe(0);
        await k.enforce(false);

        // The reviewer's turn-off first: requiring reviews waits for it, then finds no reviewer on.
        const on3 = await k.card('review.enforce', { gate: 'proposal', enforced: true, n: 'race-3' });
        const [o, g3] = [await k.client(), await k.client()];
        try {
          await o.query('BEGIN');
          await k.switchOff(k.on(o), reviewer.id);
          const gated = k.outcome(k.setGate(k.on(g3), true, on3.aid));
          await sleep(300);
          await o.query('COMMIT');
          expect(await gated).toBe('42501');
        } finally {
          await o.end();
          await g3.end();
        }
        expect([(await k.gate()).enforced, await assetOn(reviewer.id)]).toEqual([false, false]);

        // Requiring reviews first: the turn-off waits for it, then finds reviews required.
        await k.turnOn(reviewer);
        const [g4, o4] = [await k.client(), await k.client()];
        try {
          await g4.query('BEGIN');
          await k.setGate(k.on(g4), true, on3.aid);
          const off = k.outcome(k.switchOff(k.on(o4), reviewer.id));
          await sleep(300);
          await g4.query('COMMIT');
          expect(await off).toBe('42501');
        } finally {
          await g4.end();
          await o4.end();
        }
        expect([(await k.gate()).enforced, await assetOn(reviewer.id)]).toEqual([true, true]);
      } finally {
        if ((await k.gate()).enforced) await k.enforce(false);
        await k.switchOff(app, reviewer.id);
      }
    });

    it('a review cannot land on a card as it is approved', async () => {
      const card = await webCard('race-4');
      const signed = await k.approval(card.pid, 'mcp:web.fetch_url', card.digest);
      const [a, r] = [await k.client(), await k.client()];
      try {
        await a.query('BEGIN');
        await k.approve(k.on(a), card.pid, signed);
        const written = k.outcome(k.review({ subjectId: card.pid, subjectDigest: card.digest, tainted: true }, k.on(r)));
        await sleep(300);
        await a.query('COMMIT');
        expect(await written).toBe('42501');
      } finally {
        await a.end();
        await r.end();
      }
      expect((await app(`SELECT count(*)::int AS n FROM "Review" WHERE "subjectId" = $1`, [card.pid])).rows[0].n).toBe(0);
    });
  });

  describe('erasing the record, and calling it a forget', () => {
    it('nothing recorded is deleted, truncated or rewritten, and a temp table cannot stand in for a P5 table', async () => {
      for (const t of ['Asset', 'Task', 'Review', 'ReviewGate', 'TaskApprovalUse']) {
        await denied(app(`DELETE FROM "${t}"`), t);
        await denied(app(`TRUNCATE "${t}" CASCADE`), t);
      }
      await denied(app(`UPDATE "RowChange" SET actor = 'will:console' WHERE "tableName" IN ('Asset', 'Task', 'ReviewGate')`));
      await denied(app(`DELETE FROM "RowChange" WHERE "tableName" IN ('Asset', 'Task', 'ReviewGate')`));
      await denied(app(`CREATE TEMP TABLE "Asset" (id text, enabled boolean)`));
      await denied(app(`CREATE TABLE public."AssetShadow" (id text)`));
      // Nor can it redefine what counts as a violation, or switch a guard off: it owns nothing.
      expect(await code(app(`CREATE OR REPLACE VIEW review_gate_violations AS SELECT NULL::text AS id WHERE false`))).toBe('42501');
      expect(await code(app(`ALTER TABLE "Task" DISABLE TRIGGER "Task_guard"`))).toBe('42501');
      expect(await code(app(`DROP FUNCTION p5_bind_approval(text, text, text, text)`))).toBe('42501');
    });

    it('setting the forget marker itself does not make it a forget: live text stays, outputs stay, nothing else moves', async () => {
      const t = await k.taskAt('submitted', w);
      const pretending = (sql: string, params: unknown[] = []) => k.inTx(async (q) => {
        await q(`SELECT set_config('flint.forget_approval', 'apprforged', true)`);
        await q(sql, params);
      });
      expect(await code(pretending(`UPDATE "Task" SET spec = NULL, acceptance = NULL, "textPurgedAt" = now() WHERE id = $1`, [t.id]))).toBe('42501');
      expect(await code(pretending(`DELETE FROM "TaskOutput" WHERE "taskId" = $1`, [t.id]))).toBe('42501');
      expect(await code(pretending(`UPDATE "Task" SET status = 'accepted', "metBar" = true WHERE id = $1`, [t.id]))).toBe('42501');
      const row = (await app(`SELECT spec IS NOT NULL AS spec, status FROM "Task" WHERE id = $1`, [t.id])).rows[0];
      expect(row).toEqual({ spec: true, status: 'submitted' });
    });
  });

  describe('what the database does not prove (the runtime writes these itself)', () => {
    it('that a check was honest: the bar, its evidence and the check\'s record are the runtime\'s own word, which is why accepting waits for Will', async () => {
      const t = await k.taskAt('checking', w);
      expect(await k.outcome(app(`UPDATE "Task" SET "metBar" = true, "barCheckedBy" = 'flint:rule', "barEvidence" = '[{"id":"a1","met":true}]' WHERE id = $1`, [t.id]))).toBe('ok');
      expect(await k.outcome(k.proof(t.id))).toBe('ok');
      // ...and still not accepted without his card.
      expect(await code(k.setStatus(app, t.id, 'accepted', `, "acceptedAuditId" = $3`, [await k.proof(t.id)]))).toBe('42501');
    });

    it('that a review was honest: the gate proves a review of these args came first and that Will signed its verdict, not what the engine did', async () => {
      const card = await webCard('trust-1');
      expect(await k.outcome(k.reviewed(card.pid, { verdict: 'proceed', attack: null, defense: null, verdictReason: null, modelMs: 0 }))).toBe('ok');
    });

    it('that a forecast or a cost is right: the forecast is any open one from the tasks writer, and a cost is what the runtime reports', async () => {
      const t = await k.task(w.id);
      const c = await k.card(w.dispatchAction, k.dispatchArgs(t, w.kind));
      expect(await k.outcome(k.queue(app, t.id, c.aid, await k.forecast({ probability: 0.95 })))).toBe('ok');
      const paid = await k.onAsset({ kind: 'nexus_participant' });
      const p = await k.task(paid.id, { estCostUsd: 0.25 });
      await k.dispatch(p, paid);
      await k.setStatus(app, p.id, 'dispatched');
      expect(await k.outcome(k.setStatus(app, p.id, 'failed', `, failure = 'error', "costUsd" = 0`))).toBe('ok');
    });

    it('who asked for a task, and which items it lists: neither is in what Will signs', async () => {
      const [mine, flints] = [await k.task(w.id, { origin: 'will', entityIds: [] }), await k.task(w.id, { origin: 'flint', entityIds: ['en1'] })];
      // The same card args (but for the task's id) dispatch either.
      for (const t of [mine, flints]) expect(await k.outcome(k.queue(app, t.id, (await k.card(w.dispatchAction, k.dispatchArgs(t, w.kind))).aid, await k.forecast())), t.origin).toBe('ok');
    });
  });
});
