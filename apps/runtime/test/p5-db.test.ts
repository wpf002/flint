/**
 * P5's store on flint_test, the way the runtime will use it (migration
 * p5_assets): raw SQL as flint_app, each signed change under a card Will
 * signed, in one transaction. The happy paths, and what each table keeps.
 *
 *  - An asset is born off, is turned on as the exact asset its card signed, and
 *    is turned off freely; who did each is in history.
 *  - A task goes from proposed to accepted: dispatched under its signed card
 *    with its forecast, stamped by the wall clock, its output written once, its
 *    bar set once, accepted on Will's card with its proof. Or rejected, failed
 *    or cancelled. A spending asset's task rides a spend card and ends with its
 *    cost. Once Will promotes the check, Flint accepts on its own.
 *  - A review is written of a waiting card and attached to it; with reviews
 *    required, the card is approved by a signature that names that review.
 *  - A plan step that is a Flint task is done once its task is accepted.
 *  - A forget clears task and review words and keeps outcomes; history keeps
 *    lengths, never words.
 * Synthetic text only.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { digestOf } from '@flint/policy';
import { NO_DB, freshDb, id } from './db';
import { p5Kit, CANARY, OUTPUT, SPEC, type P5Kit, type Q } from './p5';

describe.skipIf(NO_DB)('P5 assets, tasks and reviews on flint_test', () => {
  let k: P5Kit;
  let app: Q;
  let owner: Q;
  const row = async (table: string, rid: string, key = 'id') => (await owner(`SELECT * FROM "${table}" WHERE "${key}" = $1`, [rid])).rows[0];
  const history = async (table: string, rid: string) => (await owner(`SELECT actor, changed FROM "RowChange" WHERE "tableName" = $1 AND "rowId" = $2 ORDER BY at`, [table, rid])).rows;
  const recent = (t: unknown) => Math.abs(Date.now() - new Date(t as string).getTime()) < 60_000;

  beforeAll(async () => {
    k = await p5Kit(await freshDb());
    ({ app, owner } = k);
  });

  describe('what the migration leaves', () => {
    it('no assets, no tasks, no reviews, and reviews not required', async () => {
      for (const t of ['Asset', 'Task', 'TaskOutput', 'Review', 'TaskApprovalUse']) expect((await owner(`SELECT count(*)::int AS n FROM "${t}"`)).rows[0].n, t).toBe(0);
      expect((await app(`SELECT id, enforced, "approvalId" FROM "ReviewGate"`)).rows).toEqual([{ id: 'proposal', enforced: false, approvalId: null }]);
      expect((await app(`SELECT count(*)::int AS n FROM review_gate_violations`)).rows[0].n).toBe(0);
      // A card already there needs no review and has none: nothing changed for it.
      const { pid } = await k.file('world.sync.git', { source: 'git' }, { kind: 'tool_call' });
      expect(await row('Proposal', pid)).toMatchObject({ reviewRequired: false, reviewId: null, status: 'pending' });
    });
  });

  describe('assets', () => {
    it('one of each kind can be listed, off; each kind has its own dispatch action and its own answer to "does it spend"', async () => {
      const kinds: Array<[string, string, boolean]> = [
        ['local_worker', 'task.dispatch.local_worker', false], ['local_reviewer', 'review.local', false], ['ci_runner', 'task.dispatch.ci_runner', false],
        ['nexus_participant', 'task.dispatch.nexus_participant', true], ['trident_panel', 'review.trident_panel', true], ['hive_bot', 'hive.dispatch_job', false],
      ];
      for (const [kind, action, spends] of kinds) {
        const a = await k.asset({ kind, createdAt: '2020-01-01' });
        const r = await row('Asset', a.id);
        expect(r, kind).toMatchObject({ kind, dispatchAction: action, spends, enabled: false, approvalId: null, entityId: null });
        // Made now, whatever the writer said.
        expect(recent(r.createdAt), kind).toBe(true);
      }
      // The same asset is listed once.
      const a = await k.asset();
      expect(await k.code(k.asset({ externalRef: a.externalRef }))).toBe('23505');
    });

    it('is turned on as the exact asset its card signed, off without a signature, and on again only with a new card; history says who', async () => {
      const a = await k.asset();
      const c = await k.card('asset.enable', k.enableArgs(a));
      await k.inTx((q) => k.switchOn(q, a.id, c.aid), { actor: 'will:console' });
      await k.finish(c.pid);
      expect(await row('Asset', a.id)).toMatchObject({ enabled: true, approvalId: c.aid });
      expect(await k.used(c.aid)).toBe(1);
      expect(await row('TaskApprovalUse', c.aid, 'approvalId')).toMatchObject({ subject: `assetId:${a.id}`, action: 'asset.enable' });
      await k.inTx((q) => k.switchOff(q, a.id), { actor: 'will:console' });
      expect(await row('Asset', a.id)).toMatchObject({ enabled: false, approvalId: c.aid });
      const again = await k.turnOn(a);
      expect(await row('Asset', a.id)).toMatchObject({ enabled: true, approvalId: again.aid });
      const h = await history('Asset', a.id);
      expect(h.map((r) => [r.actor, r.changed.enabled])).toEqual([['will:console', [false, true]], ['will:console', [true, false]], ['flint_app', [false, true]]]);
      expect(h[0]!.changed.approvalId).toEqual([null, c.aid]);
    });
  });

  describe('a task, from proposed to accepted', () => {
    it('is dispatched under its signed card with its forecast, stamped by the wall clock, its output and bar written once, and accepted on Will\'s card', async () => {
      const a = await k.onAsset();
      const due = new Date(Date.now() + 86_400_000).toISOString();
      const t = await k.task(a.id, { dueAt: due, createdAt: '2020-01-01' });
      const born = await row('Task', t.id);
      expect(born).toMatchObject({ status: 'proposed', dispatchApprovalId: null, predictionId: null, metBar: null, attempts: 0, costIsEstimate: true, dispatchedAt: null, completedAt: null });
      expect(recent(born.createdAt)).toBe(true);

      // The dispatch: one transaction holds the forecast, the move and the card's completion.
      const c = await k.card(a.dispatchAction, k.dispatchArgs(t, a.kind));
      const fid = await k.inTx(async (q) => {
        const f = await k.forecast({ taskId: t.id }, q);
        await k.queue(q, t.id, c.aid, f);
        await q(`UPDATE "Proposal" SET status = 'executed', "executedAt" = now() WHERE id = $1`, [c.pid]);
        return f;
      }, { actor: 'runtime:tasks' });
      expect(await row('Task', t.id)).toMatchObject({ status: 'queued', dispatchApprovalId: c.aid, predictionId: fid, dispatchedAt: null });
      expect(await row('TaskApprovalUse', c.aid, 'approvalId')).toMatchObject({ subject: `taskId:${t.id}`, action: a.dispatchAction });

      // Out: the time is the database's.
      await app(`UPDATE "Task" SET status = 'dispatched', attempts = 1, "externalJobId" = 'ollama:job-1' WHERE id = $1`, [t.id]);
      expect(recent((await row('Task', t.id)).dispatchedAt)).toBe(true);
      await app(`UPDATE "Task" SET status = 'running' WHERE id = $1`, [t.id]);

      // Its output and the hand-in, together.
      await k.inTx(async (q) => {
        await k.putOutput(q, t.id);
        await k.setStatus(q, t.id, 'submitted', `, "outputRef" = $3, "outputSummary" = $4`, [`out:${k.outputDigest().slice(0, 12)}`, `${CANARY} summary`]);
      });
      const out = await row('TaskOutput', t.id, 'taskId');
      expect(out).toMatchObject({ body: OUTPUT, sha256: digestOf(OUTPUT), tainted: true });
      expect(recent(out.createdAt)).toBe(true);

      // The check: the bar, its evidence and who checked it, once.
      await k.setStatus(app, t.id, 'checking');
      await app(`UPDATE "Task" SET "metBar" = true, "barCheckedBy" = 'flint:rule', "barEvidence" = $2::jsonb WHERE id = $1`, [t.id, JSON.stringify([{ id: 'a1', met: true, by: 'rule' }])]);

      // Accepted: Will's accept card, and the check's own record.
      const au = await k.accept(t.id);
      const done = await row('Task', t.id);
      expect(done).toMatchObject({ status: 'accepted', metBar: true, barCheckedBy: 'flint:rule', acceptedAuditId: au, costUsd: null, failure: null });
      expect(recent(done.completedAt)).toBe(true);
      expect(new Date(done.dueAt).toISOString()).toBe(due);

      // History kept every move, and of the words only their length.
      const h = await history('Task', t.id);
      expect(h.map((r) => r.changed.status?.[1]).filter(Boolean)).toEqual(['queued', 'dispatched', 'running', 'submitted', 'checking', 'accepted']);
      expect(h[0]!.actor).toBe('runtime:tasks');
      expect(h.find((r) => r.changed.outputSummary)!.changed.outputSummary).toEqual([null, { chars: `${CANARY} summary`.length }]);
      expect(JSON.stringify(h)).not.toContain('CANARY');

      // Retention, later: an ended task's words may be cleared and its output deleted; its outcome stays.
      await app(`UPDATE "Task" SET spec = NULL, acceptance = NULL, "outputSummary" = NULL, "barEvidence" = NULL, "textPurgedAt" = now() WHERE id = $1`, [t.id]);
      await app(`DELETE FROM "TaskOutput" WHERE "taskId" = $1`, [t.id]);
      expect(await row('Task', t.id)).toMatchObject({ status: 'accepted', metBar: true, spec: null, acceptance: null, outputSummary: null, barEvidence: null });
      const chars = (await owner(`SELECT char_length($1::jsonb::text) AS n`, [JSON.stringify(SPEC)])).rows[0].n as number;
      expect((await history('Task', t.id)).at(-1)!.changed.spec).toEqual([{ chars }, null]);
    });

    it('a failed check is rejected on Flint\'s own record; a run that gave up fails with a class; a task nothing went out for is cancelled freely', async () => {
      const a = await k.onAsset();
      const failed = await k.taskAt('checked', a, {}, { met: false });
      await k.setStatus(app, failed.id, 'rejected');
      expect(await row('Task', failed.id)).toMatchObject({ status: 'rejected', metBar: false, acceptedAuditId: null });
      expect(recent((await row('Task', failed.id)).completedAt)).toBe(true);

      for (const [at, failure] of [['queued', 'asset_off'], ['dispatched', 'timeout'], ['submitted', 'error'], ['checking', 'invalid']] as const) {
        const t = await k.taskAt(at, a);
        await k.setStatus(app, t.id, 'failed', `, failure = $3`, [failure]);
        expect(await row('Task', t.id), at).toMatchObject({ status: 'failed', failure });
      }

      const idle = await k.task(a.id);
      await k.setStatus(app, idle.id, 'cancelled');
      expect(await row('Task', idle.id)).toMatchObject({ status: 'cancelled', dispatchApprovalId: null });

      // One that went out is cancelled on Will's signed card.
      const out = await k.taskAt('dispatched', a);
      const c = await k.card('task.cancel', { taskId: out.id });
      await k.setStatus(app, out.id, 'cancelled');
      await k.finish(c.pid);
      expect((await row('Task', out.id)).status).toBe('cancelled');
      expect(await row('TaskApprovalUse', c.aid, 'approvalId')).toMatchObject({ subject: `taskId:${out.id}`, action: 'task.cancel' });
    });

    it('Will overrides the check either way on a signed card, and it says the call was his', async () => {
      const a = await k.onAsset();
      // Accepted by the check, then rejected by Will.
      const t = await k.taskAt('checked', a);
      const au = await k.accept(t.id);
      const no = await k.card('task.bar_override', { taskId: t.id, to: 'rejected' });
      await k.setStatus(app, t.id, 'rejected', `, "barCheckedBy" = 'will'`);
      await k.finish(no.pid);
      const first = await row('Task', t.id);
      expect(first).toMatchObject({ status: 'rejected', metBar: true, barCheckedBy: 'will', acceptedAuditId: au });
      // And back, on another card: the time it ended is the first one.
      const yes = await k.card('task.bar_override', { taskId: t.id, to: 'accepted' });
      await k.setStatus(app, t.id, 'accepted');
      await k.finish(yes.pid);
      const second = await row('Task', t.id);
      expect(second).toMatchObject({ status: 'accepted', barCheckedBy: 'will' });
      expect(second.completedAt).toEqual(first.completedAt);

      // Failed by the check, accepted by Will while it is still being checked: his override is its proof.
      const f = await k.taskAt('checked', a, {}, { met: false });
      const anyway = await k.card('task.bar_override', { taskId: f.id, to: 'accepted' });
      const proof = await k.proof(f.id, { action: 'task.bar_override' });
      await k.setStatus(app, f.id, 'accepted', `, "barCheckedBy" = 'will', "acceptedAuditId" = $3`, [proof]);
      await k.finish(anyway.pid);
      expect(await row('Task', f.id)).toMatchObject({ status: 'accepted', metBar: false, barCheckedBy: 'will', acceptedAuditId: proof });
    });

    it('a spending asset\'s task rides a spend card with its estimate, and ends with its cost', async () => {
      const a = await k.onAsset({ kind: 'nexus_participant' });
      const t = await k.task(a.id, { estCostUsd: 0.25 });
      const c = await k.dispatch(t, a);
      // A spend card always needs a review, whatever its writer said.
      expect(await row('Proposal', c.pid)).toMatchObject({ kind: 'spend', reviewRequired: true });
      await k.setStatus(app, t.id, 'dispatched');
      await k.setStatus(app, t.id, 'failed', `, failure = 'timeout', "costUsd" = 0.19, "costIsEstimate" = false`);
      expect(await row('Task', t.id)).toMatchObject({ status: 'failed', estCostUsd: '0.2500', costUsd: '0.1900', costIsEstimate: false });
      // One that never went out owes nothing.
      const idle = await k.task(a.id, { estCostUsd: 0.1 });
      await k.dispatch(idle, a);
      await k.setStatus(app, idle.id, 'failed', `, failure = 'budget'`);
      expect(await row('Task', idle.id)).toMatchObject({ status: 'failed', costUsd: null });
    });

    it('once Will promotes the check, Flint accepts what passed on its own, with its proof; a row that holds it back brings the card back', async () => {
      const a = await k.onAsset();
      const before = await k.taskAt('checked', a);
      const proofBefore = await k.proof(before.id);
      expect(await k.code(k.setStatus(app, before.id, 'accepted', `, "acceptedAuditId" = $3`, [proofBefore]))).toBe('42501');

      // The promotion table: a policy row Will signed.
      const expiresAt = new Date(Date.now() + 30 * 86_400_000).toISOString();
      const rows = [{ pattern: 'task.check_bar', tier: 'alone', expiresAt }, { pattern: 'task.*', tier: 'approval', expiresAt }];
      const pc = await k.card('policy.change', { rows }, { kind: 'policy' });
      const alone = id('pol');
      await app(`INSERT INTO "ActionPolicy" (id, pattern, tier, reason, "approvalId", "expiresAt") VALUES ($1, 'task.check_bar', 'alone', 'Synthetic promotion', $2, $3)`, [alone, pc.aid, expiresAt]);
      await k.setStatus(app, before.id, 'accepted', `, "acceptedAuditId" = $3`, [proofBefore]);
      expect((await row('Task', before.id)).status).toBe('accepted');

      // A wider row at APPROVAL holds it back: the card is needed again.
      const held = id('pol');
      await app(`INSERT INTO "ActionPolicy" (id, pattern, tier, reason, "approvalId", "expiresAt") VALUES ($1, 'task.*', 'approval', 'Synthetic hold', $2, $3)`, [held, pc.aid, expiresAt]);
      await k.finish(pc.pid);
      const after = await k.taskAt('checked', a);
      const proofAfter = await k.proof(after.id);
      expect(await k.code(k.setStatus(app, after.id, 'accepted', `, "acceptedAuditId" = $3`, [proofAfter]))).toBe('42501');
      await app(`UPDATE "ActionPolicy" SET active = false WHERE id = $1`, [held]);
      await k.setStatus(app, after.id, 'accepted', `, "acceptedAuditId" = $3`, [proofAfter]);
      // Switched off again (as Will can at any time), it is back to his card.
      await app(`UPDATE "ActionPolicy" SET active = false WHERE id = $1`, [alone]);
      const later = await k.taskAt('checked', a);
      expect(await k.code(k.setStatus(app, later.id, 'accepted', `, "acceptedAuditId" = $3`, [await k.proof(later.id)]))).toBe('42501');
    });
  });

  describe('reviews', () => {
    // A review is taken only while a reviewer is on.
    beforeAll(async () => {
      await k.reviewer();
    });

    it('which cards need one is decided when a card is filed: the floor, the writer\'s own ask, and never the card that turns the requirement', async () => {
      const needs = async (action: string, o: Parameters<P5Kit['file']>[2], asked?: boolean) => {
        const pid = id('prop');
        // (A spend card says its estimate: the card's own rules ask for one above nothing.)
        await app(
          `INSERT INTO "Proposal" (id, kind, origin, action, args, "argsDigest", "argsProvenance", tainted, sensitivity, destructive, "reviewRequired", "estCostUsd", "expiresAt")
           VALUES ($1, $2, $9, $3, '{"a":1}', $4, '{}', $5, $6, $7, $8, $10, now() + interval '1 hour')`,
          [pid, o?.kind ?? 'tool_call', action, digestOf({ a: 1 }), o?.tainted ?? false, o?.sensitivity ?? 'ops', o?.destructive ?? false, asked === undefined ? false : asked,
            o?.origin ?? 'console', o?.kind === 'spend' ? 1 : null],
        );
        return (await row('Proposal', pid)).reviewRequired as boolean;
      };
      expect(await needs('mcp:web.fetch_url', {})).toBe(false);
      // The floor, whatever the writer said.
      expect(await needs('mcp:web.fetch_url', { tainted: true })).toBe(true);
      expect(await needs('mcp:files.remove', { destructive: true })).toBe(true);
      expect(await needs('mcp:bank.read', { sensitivity: 'financial' })).toBe(true);
      for (const kind of ['spend', 'policy', 'rule', 'pr', 'forget', 'void']) expect(await needs('x.y', { kind }), kind).toBe(true);
      for (const kind of ['tool_call', 'goal', 'plan', 'task']) expect(await needs('x.y', { kind }), kind).toBe(false);
      // The writer (the runtime's own classifier) may ask for more.
      expect(await needs('mcp:mail.send', {}, true)).toBe(true);
      // The card that turns the requirement on or off never needs one, though it is a policy card.
      expect(await needs('review.enforce', { kind: 'policy' }, true)).toBe(false);
      expect(await needs('review.enforce', { kind: 'policy', origin: 'cli' }, true)).toBe(false);
      // Only that card: anything else under its name (another kind, from chat or a job) is held to the floor like any card.
      expect(await needs('review.enforce', { kind: 'policy', origin: 'chat:c1' })).toBe(true);
      expect(await needs('review.enforce', { kind: 'tool_call', tainted: true })).toBe(true);
      expect(await needs('review.enforce', { kind: 'tool_call' }, true)).toBe(true);
      expect(await needs('review.enforce', { kind: 'spend' })).toBe(true);
      // A card filed without saying is not required (and is never left empty).
      const pid = id('prop');
      await app(`INSERT INTO "Proposal" (id, kind, origin, action, args, "argsDigest", "argsProvenance", "reviewRequired", "expiresAt") VALUES ($1, 'tool_call', 'console', 'x.y', '{"a":1}', $2, '{}', NULL, now() + interval '1 hour')`, [pid, digestOf({ a: 1 })]);
      expect((await row('Proposal', pid)).reviewRequired).toBe(false);
    });

    it('a review is written of a waiting card, by its digest, and attached once; coverage counts it', async () => {
      const { pid, digest } = await k.file('mcp:web.fetch_url', { url: 'https://example.com/' }, { kind: 'tool_call', origin: 'chat:c1', tainted: true });
      const rid = await k.reviewed(pid, { verdict: 'proceed_with_changes', reasonCodes: ['outside_text_steers'], createdAt: '2020-01-01' });
      const r = await row('Review', rid);
      expect(r).toMatchObject({ subjectType: 'proposal', subjectId: pid, subjectDigest: digest, verdict: 'proceed_with_changes', tainted: true, shadow: true, textPurgedAt: null, overridePredictionId: null });
      expect(recent(r.createdAt)).toBe(true);
      expect((await row('Proposal', pid)).reviewId).toBe(rid);
      // Approved after its review, while reviews are not required: any signature will do.
      await k.approve(app, pid, await k.approval(pid, 'mcp:web.fetch_url', digest));
      expect((await app(`SELECT "reviewedFirst" FROM review_coverage WHERE id = $1`, [pid])).rows).toEqual([{ reviewedFirst: true }]);
      // One approved with no review is counted too, as not reviewed first; neither is a violation while reviews are not required.
      const bare = await k.card('mcp:web.fetch_url', { url: 'https://example.org/' }, { kind: 'tool_call', origin: 'chat:c1', tainted: true, stage: 'approved' });
      expect((await app(`SELECT "reviewedFirst", "reviewedAt" FROM review_coverage WHERE id = $1`, [bare.pid])).rows).toEqual([{ reviewedFirst: false, reviewedAt: null }]);
      expect((await app(`SELECT count(*)::int AS n FROM review_gate_violations`)).rows[0].n).toBe(0);
      // Retention, later: its words may be cleared; what it found stays.
      await app(`UPDATE "Review" SET attack = NULL, defense = NULL, "verdictReason" = NULL, "textPurgedAt" = now() WHERE id = $1`, [rid]);
      expect(await row('Review', rid)).toMatchObject({ attack: null, defense: null, verdictReason: null, verdict: 'proceed_with_changes', reasonCodes: ['outside_text_steers'] });
    });

    it('requiring reviews: a signed card turns it on (a reviewer is on), cards that need one are approved by a signature naming it, and a signed card turns it off', async () => {
      const reviewer = await k.onAsset({ kind: 'local_reviewer', capabilities: ['review'] });
      // A card approved unreviewed before reviews are required.
      const early = await k.card('mcp:web.fetch_url', { url: 'https://example.net/' }, { kind: 'tool_call', origin: 'chat:c1', tainted: true, stage: 'approved' });

      const onCard = await k.card('review.enforce', { gate: 'proposal', enforced: true });
      expect((await row('Proposal', onCard.pid)).reviewRequired).toBe(false);
      await k.inTx((q) => k.setGate(q, true, onCard.aid), { actor: 'will:console' });
      await k.finish(onCard.pid);
      const g = await row('ReviewGate', 'proposal');
      expect(g).toMatchObject({ enforced: true, approvalId: onCard.aid });
      expect(recent(g.changedAt)).toBe(true);

      // A card that needs a review: Will is shown the block, and signs past it.
      const { pid, digest } = await k.file('mcp:web.fetch_url', { url: 'https://example.com/a' }, { kind: 'tool_call', origin: 'chat:c1', tainted: true });
      const rid = await k.reviewed(pid, { verdict: 'block', reasonCodes: ['sends_off_box'] });
      const signed = await k.approval(pid, 'mcp:web.fetch_url', digest, { fields: { tainted: true, reviewId: rid, verdict: 'block' } });
      await k.approve(app, pid, signed);
      expect(await row('Proposal', pid)).toMatchObject({ status: 'approved', approvalId: signed, reviewId: rid });
      // A card that needs none is approved as before.
      const plain = await k.card('world.sync.git', { source: 'git' }, { kind: 'tool_call', stage: 'approved' });
      expect((await row('Proposal', plain.pid)).status).toBe('approved');
      // The invariant holds: nothing since then was approved unreviewed. The early card is coverage, not a violation.
      expect((await app(`SELECT count(*)::int AS n FROM review_gate_violations`)).rows[0].n).toBe(0);
      expect((await app(`SELECT "reviewedFirst" FROM review_coverage WHERE id = ANY ($1) ORDER BY "reviewedFirst"`, [[early.pid, pid]])).rows).toEqual([{ reviewedFirst: false }, { reviewedFirst: true }]);

      // His approval past the block is scored: the forecast is attached to the review, once.
      const f = await k.forecast({ type: 'effect_given_accept', method: 'model_reasoning', resolver: 'will', resolveIn: '14 days', createdBy: 'runtime:reviews', claim: 'block_holds {review: review#000000}', probability: 0.7 });
      await app(`UPDATE "Review" SET "overridePredictionId" = $2 WHERE id = $1`, [rid, f]);
      expect((await row('Review', rid)).overridePredictionId).toBe(f);

      // Stopping: the card is approved with no review while reviews are required, and turns it off.
      const offCard = await k.card('review.enforce', { gate: 'proposal', enforced: false });
      await k.setGate(app, false, offCard.aid);
      await k.finish(offCard.pid);
      expect(await k.gate()).toEqual({ enforced: false, approvalId: offCard.aid });
      await k.switchOff(app, reviewer.id);
      const h = await history('ReviewGate', 'proposal');
      expect(h.map((r) => [r.actor, r.changed.enforced])).toEqual([['will:console', [false, true]], ['flint_app', [true, false]]]);
    });

    it('a task\'s own check may be a review of its output, by the output\'s digest', async () => {
      const a = await k.onAsset();
      const t = await k.taskAt('checking', a, { sensitivity: 'personal' });
      const rid = await k.review({ subjectType: 'task', subjectId: t.id, subjectDigest: k.outputDigest(), tainted: true, sensitivity: 'personal' });
      expect(await row('Review', rid)).toMatchObject({ subjectType: 'task', subjectId: t.id, tainted: true });
      await app(`UPDATE "Task" SET "metBar" = true, "barCheckedBy" = 'ollama:test-model:30b', "barEvidence" = '[{"id":"a1","met":true,"by":"judge"}]' WHERE id = $1`, [t.id]);
      await k.accept(t.id);
      expect(await row('Task', t.id)).toMatchObject({ status: 'accepted', barCheckedBy: 'ollama:test-model:30b' });
    });
  });

  describe('a plan step that is a Flint task', () => {
    it('names its task while it runs, and is done once that task is accepted; Will\'s own steps are ticked as before', async () => {
      const a = await k.onAsset();
      const { gid, steps } = await k.goalWithPlan({ s1: 'asset_task', s2: 'will_task' });
      const [s1, s2] = [steps.s1!, steps.s2!];

      await app(`UPDATE "PlanStep" SET status = 'done', "doneAt" = now() WHERE id = $1`, [s2]);
      const t = await k.taskAt('checked', a, { goalId: gid, stepKey: 's1', sensitivity: 'personal' });
      await app(`UPDATE "PlanStep" SET "taskId" = $2, status = 'in_progress' WHERE id = $1`, [s1, t.id]);
      expect(await k.code(app(`UPDATE "PlanStep" SET status = 'done', "doneAt" = now() WHERE id = $1`, [s1]))).toBe('42501');
      await k.accept(t.id);
      await app(`UPDATE "PlanStep" SET status = 'done', "doneAt" = now() WHERE id = $1`, [s1]);
      expect(await row('PlanStep', s1)).toMatchObject({ status: 'done', taskId: t.id });
      // A second task for the same step is refused while the first stands (one live task per step).
      expect(await k.code(k.task(a.id, { goalId: gid, stepKey: 's1', sensitivity: 'personal' }))).toBe('23505');
    });
  });

  describe('forget', () => {
    it('clears the words of tasks about the item, their outputs, and the reviews that read them; outcomes stay', async () => {
      const a = await k.onAsset();
      await k.reviewer();
      const [eid, other] = [await k.entity(), await k.entity()];
      const spec = (items: string[]) => ({ template: 'summarize_items', params: { items, note: `${CANARY} spec` } });
      // Named in its items list; named only inside its spec; and one about something else.
      const listed = await k.taskAt('checking', a, { spec: spec([eid]), entityIds: [eid] });
      const inSpec = await k.taskAt('submitted', a, { spec: spec([eid, other]), entityIds: [] });
      const apart = await k.taskAt('submitted', a, { spec: spec([other]), entityIds: [other] });
      const taskReview = await k.review({ subjectType: 'task', subjectId: listed.id, subjectDigest: k.outputDigest(), tainted: true });
      // A waiting card whose args name the item, with its review.
      const { pid } = await k.file('mcp:notes.update', { entityId: eid, text: `${CANARY} args` }, { kind: 'tool_call', origin: 'chat:c1' });
      const cardReview = await k.reviewed(pid);
      const otherCard = await k.file('mcp:notes.update', { entityId: other }, { kind: 'tool_call', origin: 'chat:c1' });
      const keptReview = await k.reviewed(otherCard.pid);

      await k.forget(eid);

      for (const t of [listed, inSpec]) {
        expect(await row('Task', t.id), t.id).toMatchObject({ spec: null, acceptance: null, outputSummary: null, barEvidence: null, title: t.title });
        expect((await row('Task', t.id)).textPurgedAt).toBeTruthy();
        expect(await row('TaskOutput', t.id, 'taskId')).toBeUndefined();
      }
      // Where each stood is untouched.
      expect((await row('Task', listed.id)).status).toBe('checking');
      expect((await row('Task', inSpec.id)).status).toBe('submitted');
      for (const rid of [taskReview, cardReview]) expect(await row('Review', rid), rid).toMatchObject({ attack: null, defense: null, verdictReason: null, verdict: 'proceed', reasonCodes: ['none'] });
      expect((await row('Proposal', pid)).args).toBeNull();
      // What named something else kept its words.
      expect((await row('Task', apart.id)).spec).toEqual(spec([other]));
      expect(await row('TaskOutput', apart.id, 'taskId')).toBeTruthy();
      expect((await row('Review', keptReview)).attack).toContain('CANARY');
    });
  });

  describe('what is kept for good', () => {
    it('carries no task\'s or review\'s words: history, audit entries, jobs, the record of used approvals', async () => {
      const leaks = await owner(`
        SELECT 'history' AS t, count(*)::int AS n FROM "RowChange" WHERE coalesce(changed::text, '') LIKE '%CANARY%'
        UNION ALL SELECT 'audit', count(*)::int FROM "AuditEntry" WHERE inputs::text LIKE '%CANARY%' OR coalesce(reasoning, '') LIKE '%CANARY%' OR coalesce("outcomeDetail"::text, '') LIKE '%CANARY%'
        UNION ALL SELECT 'uses', count(*)::int FROM "TaskApprovalUse" WHERE subject LIKE '%CANARY%' OR action LIKE '%CANARY%'
        UNION ALL SELECT 'jobs', count(*)::int FROM pgboss.job WHERE coalesce(data::text, '') LIKE '%CANARY%'`);
      expect(leaks.rows).toEqual([{ t: 'history', n: 0 }, { t: 'audit', n: 0 }, { t: 'uses', n: 0 }, { t: 'jobs', n: 0 }]);
      // ...while the tasks, their outputs and the reviews themselves (until retention) do hold them, and have a history.
      expect((await owner(`SELECT count(*)::int AS n FROM "Task" WHERE title LIKE '%CANARY%'`)).rows[0].n).toBeGreaterThan(0);
      expect((await owner(`SELECT count(*)::int AS n FROM "TaskOutput" WHERE body::text LIKE '%CANARY%'`)).rows[0].n).toBeGreaterThan(0);
      expect((await owner(`SELECT count(*)::int AS n FROM "Review" WHERE attack LIKE '%CANARY%'`)).rows[0].n).toBeGreaterThan(0);
      expect((await owner(`SELECT count(*)::int AS n FROM "RowChange" WHERE "tableName" = 'Task'`)).rows[0].n).toBeGreaterThan(0);
    });
  });
});
