/**
 * P5 on flint_test: what an independent review found. Before these fixes no
 * unsigned path turned an asset on, sent a task out, accepted, overruled or
 * cancelled one, or turned the review requirement; but each rule below did not
 * hold as it was stated. One test per finding, built from the steps that showed
 * it, as flint_app unless said otherwise. (The rollback's own guard is in
 * migrate-roundtrip.test.ts; the same rules are also held, refusal by refusal,
 * in p5-guards-db.test.ts.)
 *
 *  - A review written after Will signed does not pass the gate.
 *  - A card he signed earlier, kept, does not undo his later decision: the
 *    gate, an override, an asset.
 *  - A forget reaches everything, and nothing is written back after it.
 *  - A review needs its reviewer; none is taken from the paid panel.
 *  - The runtime cannot end his right to overrule a check by scoring first.
 *  - An accept card signs what it accepts.
 *  - A review's words stay while its card waits; two reviewers are not turned
 *    off at once above READ COMMITTED; only his own policy card is spared a
 *    review; every task and spend card's digest is checked when it is filed;
 *    the summary and the evidence are written at their own steps; a step whose
 *    task he rejected is no longer done; an asset's item is part of what he
 *    signs; a spending task says a price above nothing.
 *  - No card of any kind prints its args when a rule of its own refuses it,
 *    and every kind of card still files, is approved, rejected, expires, runs
 *    and is cleared as before.
 * Synthetic text only.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { digestOf } from '@flint/policy';
import { NO_DB, freshDb, id, HEX } from './db';
import { p5Kit, refusal, sleep, CANARY, type AssetRow, type P5Kit, type Q } from './p5';

describe.skipIf(NO_DB)('P5: what an independent review found', () => {
  let k: P5Kit;
  let app: Q;
  let owner: Q;
  let w: AssetRow;
  /** Refused, with this SQLSTATE and message, and with none of the row's words (refusal() throws on those). */
  const refused = async (p: Promise<unknown>, code: string, message: string | RegExp, label = '') => {
    const r = await refusal(p);
    if (typeof message === 'string') expect([r.code, r.message], label).toEqual([code, message]);
    else expect([r.code, r.message], label).toEqual([code, expect.stringMatching(message)]);
    expect(r.detail, label).toBeUndefined();
  };
  const webCard = (n: string, o: Parameters<P5Kit['file']>[2] = {}) => k.file('mcp:web.fetch_url', { url: `https://example.com/${n}` }, { kind: 'tool_call', origin: 'chat:c1', tainted: true, ...o });
  const violations = async () => (await app(`SELECT count(*)::int AS n FROM review_gate_violations`)).rows[0].n as number;
  const status = async (taskId: string) => (await app(`SELECT status FROM "Task" WHERE id = $1`, [taskId])).rows[0].status as string;
  const executing = (pid: string) => app(`UPDATE "Proposal" SET status = 'executing' WHERE id = $1`, [pid]);
  /** Reviews required for the length of `fn`, with a reviewer on; put back after. */
  async function required<T>(fn: () => Promise<T>): Promise<T> {
    const reviewer = await k.reviewer();
    await k.enforce(true);
    try {
      return await fn();
    } finally {
      if ((await k.gate()).enforced) await k.enforce(false);
      await k.switchOff(app, reviewer.id);
    }
  }

  beforeAll(async () => {
    k = await p5Kit(await freshDb());
    ({ app, owner } = k);
    w = await k.onAsset();
  });

  it('a review written after Will signed does not pass the gate, and the violations view stays empty', async () => {
    await required(async () => {
      const c = await webCard('after');
      const rid = id('rv');
      // The server records his signature naming a review that does not exist yet (a review's id is the runtime's to choose).
      const aid = await k.approval(c.pid, 'mcp:web.fetch_url', c.digest, { fields: { reviewId: rid, verdict: 'proceed' } });
      await sleep(50);
      // The runtime then writes that review and attaches it.
      await k.reviewed(c.pid, { id: rid, verdict: 'proceed' });
      await refused(k.approve(app, c.pid, aid), '42501', `proposal ${c.pid}: its review was written after Will signed`);
      expect((await app(`SELECT status, "approvalId" FROM "Proposal" WHERE id = $1`, [c.pid])).rows[0]).toEqual({ status: 'pending', approvalId: null });
      expect((await app(`SELECT "consumedAt" FROM "Approval" WHERE id = $1`, [aid])).rows[0].consumedAt).toBeNull();
      expect(await violations()).toBe(0);
      // Signed after he was shown it: approved, and still no violation.
      await k.approve(app, c.pid, await k.approval(c.pid, 'mcp:web.fetch_url', c.digest, { fields: { reviewId: rid, verdict: 'proceed' } }));
      expect(await violations()).toBe(0);
      expect((await app(`SELECT "reviewedFirst" FROM review_coverage WHERE id = $1`, [c.pid])).rows).toEqual([{ reviewedFirst: true }]);
    });
  });

  describe('a card signed earlier and kept does not undo Will\'s later decision', () => {
    it('the review requirement: a "stop requiring" card from before he required them does not stop them', async () => {
      const reviewer = await k.reviewer();
      // Signed first, never carried out: the runtime keeps it approved.
      const kept = await k.card('review.enforce', { gate: 'proposal', enforced: false }, { stage: 'approved' });
      const on = await k.enforce(true);
      try {
        await executing(kept.pid);
        await refused(k.setGate(app, false, kept.aid), '42501', `the review gate: approval ${kept.aid} was signed before it last changed`);
        expect([await k.gate(), await k.used(kept.aid)]).toEqual([{ enforced: true, approvalId: on.aid }, 0]);
      } finally {
        await k.enforce(false);
        await k.switchOff(app, reviewer.id);
      }
    });

    it('an override: an older "accept anyway" card does not flip a task back after his later "reject anyway"', async () => {
      const t = await k.taskAt('checked', w);
      await k.accept(t.id);
      const kept = await k.card('task.bar_override', { taskId: t.id, to: 'accepted' }, { stage: 'approved' });
      const later = await k.card('task.bar_override', { taskId: t.id, to: 'rejected' });
      await app(`UPDATE "Task" SET status = 'rejected', "barCheckedBy" = 'will' WHERE id = $1`, [t.id]);
      await k.finish(later.pid);
      await executing(kept.pid);
      await refused(app(`UPDATE "Task" SET status = 'accepted' WHERE id = $1`, [t.id]), '42501', `task ${t.id}: ending it against its check needs Will's signed override`);
      expect([await status(t.id), await k.used(kept.aid), await k.used(later.aid)]).toEqual(['rejected', 0, 1]);
      // One he signs after that decision does change it, as an override always could.
      const since = await k.card('task.bar_override', { taskId: t.id, to: 'accepted', n: 2 });
      await app(`UPDATE "Task" SET status = 'accepted' WHERE id = $1`, [t.id]);
      expect([await status(t.id), await k.used(since.aid)]).toEqual(['accepted', 1]);
    });

    it('an asset: a spare turn-on card does not turn it back on after he turned it off; nor on, off, on under one signature', async () => {
      const a = await k.asset();
      const c1 = await k.card('asset.enable', k.enableArgs(a));
      // On, off, on in one transaction, with the one approval.
      await refused(k.inTx(async (q) => {
        await k.switchOn(q, a.id, c1.aid);
        await k.switchOff(q, a.id);
        await k.switchOn(q, a.id, c1.aid);
      }), '42501', `asset ${a.id}: turning it on needs a new approval`);
      // Two cards signed (a duplicate); one used, the other kept approved. Will turns it off. The spare stays spare.
      const spare = await k.card('asset.enable', k.enableArgs(a), { stage: 'approved' });
      await k.switchOn(app, a.id, c1.aid);
      await k.finish(c1.pid);
      await k.switchOff(app, a.id);
      await executing(spare.pid);
      await refused(k.switchOn(app, a.id, spare.aid), '42501', `assetId ${a.id}: approval ${spare.aid} was signed before a later decision`);
      // A duplicate signed while it was on: no use on record is newer than it, but the asset's own last change is.
      const whileOn = await k.turnOn(a);
      const dup = await k.card('asset.enable', k.enableArgs(a), { stage: 'approved' });
      await k.switchOff(app, a.id);
      await executing(dup.pid);
      await refused(k.switchOn(app, a.id, dup.aid), '42501', `asset ${a.id}: approval ${dup.aid} was signed before it last changed`);
      expect((await app(`SELECT enabled, "approvalId" FROM "Asset" WHERE id = $1`, [a.id])).rows[0]).toEqual({ enabled: false, approvalId: whileOn.aid });
      expect([await k.used(spare.aid), await k.used(dup.aid)]).toEqual([0, 0]);
    });
  });

  describe('a forget reaches everything, and nothing is written back after it', () => {
    it('a task still out takes no output, no summary, no evidence and no review once its item was forgotten', async () => {
      const reviewer = await k.reviewer();
      const e = await k.entity();
      const t = await k.taskAt('dispatched', w, { entityIds: [e], spec: { template: 'summarize_items', params: { items: [e], note: `${CANARY} spec` } } });
      await k.forget(e);
      expect((await app(`SELECT spec IS NULL AS cleared, "textPurgedAt" IS NOT NULL AS marked, status FROM "Task" WHERE id = $1`, [t.id])).rows[0]).toEqual({ cleared: true, marked: true, status: 'dispatched' });
      const body = { headline: `${CANARY} words about the forgotten item`, points: [] };
      await refused(k.putOutput(app, t.id, body), '42501', `task ${t.id}: its text was cleared, so no output is taken`);
      // It can still be moved along, with a reference and nothing behind it...
      await k.setStatus(app, t.id, 'submitted', `, "outputRef" = $3`, [`out:${k.outputDigest(body).slice(0, 12)}`]);
      await refused(app(`UPDATE "Task" SET "outputSummary" = $2 WHERE id = $1`, [t.id, `${CANARY} summary`]), '42501', `task ${t.id}: its outputSummary is written once`);
      await k.setStatus(app, t.id, 'checking');
      // ...but there is nothing of it to review, and its evidence is not written back.
      const rid = id('rv');
      await refused(k.review({ id: rid, subjectType: 'task', subjectId: t.id, subjectDigest: k.outputDigest(body), tainted: true, attack: `${CANARY} attack` }), '42501', `review ${rid}: it is not of task ${t.id}'s output as it is checked`);
      await refused(app(`UPDATE "Task" SET "metBar" = true, "barCheckedBy" = 'flint:rule', "barEvidence" = $2::jsonb WHERE id = $1`, [t.id, JSON.stringify([{ id: 'a1', met: true, note: `${CANARY} evidence` }])]), '42501', `task ${t.id}: its barEvidence is written once`);
      expect((await app(`SELECT (SELECT count(*)::int FROM "TaskOutput" WHERE "taskId" = $1) AS outputs, (SELECT count(*)::int FROM "Review" WHERE "subjectId" = $1) AS reviews`, [t.id])).rows[0]).toEqual({ outputs: 0, reviews: 0 });
      await k.switchOff(app, reviewer.id);
    });

    it('a waiting card a forget emptied takes no review', async () => {
      const reviewer = await k.reviewer();
      const e = await k.entity();
      const c = await k.file('mcp:notes.write', { entityId: e, note: `${CANARY} words` }, { kind: 'tool_call', origin: 'console' });
      await k.forget(e);
      expect((await app(`SELECT status, args IS NULL AS emptied FROM "Proposal" WHERE id = $1`, [c.pid])).rows[0]).toEqual({ status: 'pending', emptied: true });
      const rid = id('rv');
      await refused(k.review({ id: rid, subjectId: c.pid, subjectDigest: c.digest, attack: `${CANARY} attack that quotes the forgotten item` }), '42501', `review ${rid}: card ${c.pid} has no args left to review`);
      await k.switchOff(app, reviewer.id);
    });

    it('an item named only in a task\'s list of items: the task\'s cards lose their args too, and their reviews their words', async () => {
      const reviewer = await k.reviewer();
      const [e, other] = [await k.entity(), await k.entity()];
      // The task lists the item; its spec (and so its dispatch card's args) never holds the item's id.
      const t = await k.task(w.id, { entityIds: [e] });
      const dispatch = await k.file(w.dispatchAction, k.dispatchArgs(t, w.kind));
      expect(JSON.stringify(k.dispatchArgs(t, w.kind))).not.toContain(e);
      const rid = await k.reviewed(dispatch.pid, { attack: `${CANARY} attack that quotes the task` });
      const aid = await k.approval(dispatch.pid, w.dispatchAction, dispatch.digest);
      await k.approve(app, dispatch.pid, aid);
      await executing(dispatch.pid);
      await k.queue(app, t.id, aid, await k.forecast());
      await k.finish(dispatch.pid);
      // A second card of the task's, waiting; and a task and card about something else.
      const cancel = await k.file('task.cancel', { taskId: t.id });
      const apart = await k.task(w.id, { entityIds: [other] });
      const apartCard = await k.file(w.dispatchAction, k.dispatchArgs(apart, w.kind));
      const apartReview = await k.reviewed(apartCard.pid);

      await k.forget(e);

      expect((await app(`SELECT spec IS NULL AS spec, acceptance IS NULL AS bar FROM "Task" WHERE id = $1`, [t.id])).rows[0]).toEqual({ spec: true, bar: true });
      for (const pid of [dispatch.pid, cancel.pid]) {
        expect((await app(`SELECT args IS NULL AS args, "argsPurgedAt" IS NOT NULL AS marked, reason, result, error FROM "Proposal" WHERE id = $1`, [pid])).rows[0], pid).toEqual({ args: true, marked: true, reason: null, result: null, error: null });
      }
      expect((await app(`SELECT attack, defense, "verdictReason", verdict, "textPurgedAt" IS NOT NULL AS marked FROM "Review" WHERE id = $1`, [rid])).rows[0]).toEqual({ attack: null, defense: null, verdictReason: null, verdict: 'proceed', marked: true });
      // What named something else kept everything.
      expect((await app(`SELECT args IS NOT NULL AS args FROM "Proposal" WHERE id = $1`, [apartCard.pid])).rows[0].args).toBe(true);
      expect((await app(`SELECT attack FROM "Review" WHERE id = $1`, [apartReview])).rows[0].attack).toContain('CANARY');
      expect((await app(`SELECT spec IS NOT NULL AS spec FROM "Task" WHERE id = $1`, [apart.id])).rows[0].spec).toBe(true);
      await k.switchOff(app, reviewer.id);
    });

    it('a known limit: a card whose args retention already cleared is not found by a later forget, so its review must be cleared with its args', async () => {
      const reviewer = await k.reviewer();
      const e = await k.entity();
      const c = await k.file('mcp:notes.write', { entityId: e, note: `${CANARY} words` }, { kind: 'tool_call', origin: 'console' });
      const rid = await k.reviewed(c.pid, { attack: `${CANARY} attack naming the item` });
      const aid = await k.approval(c.pid, 'mcp:notes.write', c.digest);
      await k.approve(app, c.pid, aid);
      await executing(c.pid);
      await k.finish(c.pid);
      // Retention done right: the review's words go no later than the card's args (the card has ended, so they may).
      await k.inTx(async (q) => {
        await q(`UPDATE "Review" SET attack = NULL, defense = NULL, "verdictReason" = NULL, "textPurgedAt" = now() WHERE "subjectType" = 'proposal' AND "subjectId" = $1`, [c.pid]);
        await q(`UPDATE "Proposal" SET args = NULL, result = NULL, "argsPurgedAt" = now() WHERE id = $1`, [c.pid]);
      });
      await k.forget(e);
      expect((await app(`SELECT attack, "textPurgedAt" IS NOT NULL AS marked FROM "Review" WHERE id = $1`, [rid])).rows[0]).toEqual({ attack: null, marked: true });
      await k.switchOff(app, reviewer.id);
    });
  });

  it('a review needs its reviewer: none with no reviewer on, none from the paid panel, and turning the reviewer off stops them', async () => {
    const c = await webCard('reviewer');
    const of = (over: Record<string, unknown> = {}) => k.review({ subjectId: c.pid, subjectDigest: c.digest, tainted: true, ...over });
    expect((await app(`SELECT count(*)::int AS n FROM "Asset" WHERE kind = 'local_reviewer' AND enabled`)).rows[0].n).toBe(0);
    const rid = id('rv');
    // A worker is on (it is not a reviewer); a reviewer that exists but is off; and the paid panel's asset, on or not.
    await refused(of({ id: rid }), '42501', `review ${rid}: no reviewer is on`);
    const idle = await k.asset({ kind: 'local_reviewer', capabilities: ['review'] });
    await refused(of({ id: rid }), '42501', `review ${rid}: no reviewer is on`);
    await k.onAsset({ kind: 'trident_panel', capabilities: ['review'] });
    await refused(of({ id: rid, engine: 'trident_panel', costUsd: 12.5 }), '42501', `review ${rid}: no paid review is taken yet`);
    await refused(of({ id: rid, engine: 'trident_panel' }), '42501', `review ${rid}: no paid review is taken yet`);
    await refused(of({ id: rid }), '42501', `review ${rid}: no reviewer is on`);
    // On: taken. Off again: none.
    await k.turnOn(idle);
    await of({ id: rid });
    await refused(of({ id: rid, costUsd: 0.01 }), '23514', `review ${rid}: its cost is not valid`);
    await k.switchOff(app, idle.id);
    const next = id('rv');
    await refused(of({ id: next }), '42501', `review ${next}: no reviewer is on`);
    expect((await app(`SELECT count(*)::int AS n FROM "Review" WHERE "subjectId" = $1`, [c.pid])).rows[0].n).toBe(1);
  });

  it('the runtime cannot end Will\'s right to overrule a check by scoring the forecast first, nor score a task that has not ended', async () => {
    const score = (taskId: string, outcome: boolean) =>
      app(`INSERT INTO "Resolution" (id, "predictionId", outcome, "eventAt", "resolvedBy") SELECT $1, "predictionId", $3, now(), 'auto_world' FROM "Task" WHERE id = $2`, [id('rs'), taskId, outcome]);
    const early = (taskId: string) => `task ${taskId}: its forecast is scored a day after it ended as accepted, rejected or failed`;
    const t = await k.taskAt('checked', w);
    await k.accept(t.id);
    // Right after the acceptance, on the runtime's own word, either way.
    for (const outcome of [true, false]) await refused(score(t.id, outcome), '42501', early(t.id), String(outcome));
    // So his override lands.
    const over = await k.card('task.bar_override', { taskId: t.id, to: 'rejected' });
    await app(`UPDATE "Task" SET status = 'rejected', "barCheckedBy" = 'will' WHERE id = $1`, [t.id]);
    expect([await status(t.id), await k.used(over.aid)]).toEqual(['rejected', 1]);
    // A task still being checked is not scored at all.
    const u = await k.taskAt('checking', w);
    await refused(score(u.id, true), '42501', early(u.id));
    // A day after it ended it is scored as it ended (rejected: false), and then the result is final.
    await k.endedAgo(t.id);
    await refused(score(t.id, true), '42501', `task ${t.id}: its forecast's outcome is whether it was accepted`);
    await score(t.id, false);
    await k.card('task.bar_override', { taskId: t.id, to: 'accepted' });
    await refused(k.setStatus(app, t.id, 'accepted'), '42501', `task ${t.id}: its forecast is already scored`);
    expect(await status(t.id)).toBe('rejected');
  });

  it('an accept card signs what it accepts: one signed before there was a result accepts nothing that came later', async () => {
    const t = await k.taskAt('dispatched', w);
    // Signed while the task was merely out, and kept: it names no output.
    const early = await k.card('task.check_bar', { taskId: t.id, metBar: true }, { origin: 'runtime:tasks', stage: 'approved' });
    await k.inTx(async (q) => {
      await k.putOutput(q, t.id);
      await k.setStatus(q, t.id, 'submitted', `, "outputRef" = $3`, [`out:${k.outputDigest().slice(0, 12)}`]);
    });
    await k.setStatus(app, t.id, 'checking');
    await app(`UPDATE "Task" SET "metBar" = true, "barCheckedBy" = 'flint:rule' WHERE id = $1`, [t.id]);
    await executing(early.pid);
    const au = await k.proof(t.id);
    const needs = `task ${t.id}: accepting it needs Will's signed card for this result until he lets Flint accept on its own`;
    const accept = () => k.setStatus(app, t.id, 'accepted', `, "acceptedAuditId" = $3`, [au]);
    await refused(accept(), '42501', needs);
    // Nor one that names another output, or says nothing of its bar.
    await k.card('task.check_bar', { taskId: t.id, outputRef: 'out:000000000000', metBar: true }, { origin: 'runtime:tasks' });
    await k.card('task.check_bar', { taskId: t.id, outputRef: `out:${k.outputDigest().slice(0, 12)}` }, { origin: 'runtime:tasks' });
    await refused(accept(), '42501', needs);
    expect([await status(t.id), await k.used(early.aid)]).toEqual(['checking', 0]);
    // The card for this output, having met its bar.
    const c = await k.card('task.check_bar', await k.acceptArgs(t.id), { origin: 'runtime:tasks' });
    await accept();
    expect([await status(t.id), await k.used(c.aid)]).toEqual(['accepted', 1]);
  });

  it('a review\'s words stay while its card still waits for Will', async () => {
    const reviewer = await k.reviewer();
    const c = await webCard('words');
    const rid = await k.reviewed(c.pid, { verdict: 'block' });
    await refused(app(`UPDATE "Review" SET attack = NULL, defense = NULL, "verdictReason" = NULL, "textPurgedAt" = now() WHERE id = $1`, [rid]), '42501', `review ${rid}: its words are kept while what it reviews still waits`);
    expect((await app(`SELECT attack IS NOT NULL AS attack, "textPurgedAt" FROM "Review" WHERE id = $1`, [rid])).rows[0]).toEqual({ attack: true, textPurgedAt: null });
    // Once he has decided, retention may clear them.
    await app(`UPDATE "Proposal" SET status = 'rejected' WHERE id = $1`, [c.pid]);
    await app(`UPDATE "Review" SET attack = NULL, defense = NULL, "verdictReason" = NULL, "textPurgedAt" = now() WHERE id = $1`, [rid]);
    await k.switchOff(app, reviewer.id);
  });

  it('two reviewers are not turned off at once above READ COMMITTED while reviews are required', async () => {
    const [r1, r2] = [await k.reviewer(), await k.reviewer()];
    await k.enforce(true);
    try {
      for (const iso of ['REPEATABLE READ', 'SERIALIZABLE']) {
        const [a, b] = [await k.client(), await k.client()];
        try {
          await a.query(`BEGIN ISOLATION LEVEL ${iso}`);
          await a.query('SELECT count(*) FROM "Asset"');
          await b.query(`BEGIN ISOLATION LEVEL ${iso}`);
          await b.query('SELECT count(*) FROM "Asset"');
          await refused(k.switchOff(k.on(a), r1.id), '40001', `asset ${r1.id}: it is turned on or off at read committed only`, iso);
          await a.query('ROLLBACK');
          await refused(k.switchOff(k.on(b), r2.id), '40001', `asset ${r2.id}: it is turned on or off at read committed only`, iso);
          await b.query('ROLLBACK');
        } finally {
          await a.end();
          await b.end();
        }
      }
      expect((await app(`SELECT count(*)::int AS n FROM "Asset" WHERE kind = 'local_reviewer' AND enabled`)).rows[0].n).toBe(2);
      // At READ COMMITTED, in turn: one goes, the last one stays.
      await k.switchOff(app, r1.id);
      await refused(k.switchOff(app, r2.id), '42501', `asset ${r2.id}: reviews are required, so the last reviewer stays on`);
    } finally {
      await k.enforce(false);
      await k.switchOff(app, r2.id);
    }
  });

  it('only Will\'s own policy card of that name is spared a review: anything else called review.enforce waits for one like any card', async () => {
    await required(async () => {
      for (const kind of ['pr', 'spend', 'forget', 'void', 'rule', 'tool_call']) {
        const c = await k.file('review.enforce', { gate: 'proposal', enforced: false, body: `${CANARY} anything` }, { kind, origin: 'chat:c1', tainted: true, destructive: true, sensitivity: 'financial', consequential: false, ...(kind === 'spend' ? { estCostUsd: 1 } : {}) });
        expect((await app(`SELECT "reviewRequired" FROM "Proposal" WHERE id = $1`, [c.pid])).rows[0].reviewRequired, kind).toBe(true);
        await refused(k.approve(app, c.pid, await k.approval(c.pid, 'review.enforce', c.digest)), '42501', `proposal ${c.pid}: it needs a review before it is approved`, kind);
      }
      // His own: a policy card from the console or the CLI. It is approved with no review, which is what lets him stop requiring them.
      for (const origin of ['console', 'cli']) {
        const c = await k.file('review.enforce', { gate: 'proposal', enforced: false, n: origin }, { origin });
        expect((await app(`SELECT "reviewRequired" FROM "Proposal" WHERE id = $1`, [c.pid])).rows[0].reviewRequired, origin).toBe(false);
        await k.approve(app, c.pid, await k.approval(c.pid, 'review.enforce', c.digest));
      }
      expect(await violations()).toBe(0);
    });
  });

  it('every task and spend card is held to its args\' digest when it is filed, whatever it is called', async () => {
    const hive = await k.asset({ kind: 'hive_bot', capabilities: ['x'], spends: false });
    const t = await k.task(hive.id);
    const args = k.dispatchArgs(t, hive.kind);
    const wrong = /^proposal \w+: its digest is not its args' digest$/;
    await refused(k.file('hive.dispatch_job', args, { digest: HEX('e') }), '42501', wrong);
    await refused(k.file('review.local', args, { digest: HEX('e') }), '42501', wrong);
    await refused(k.file('review.trident_panel', args, { kind: 'spend', estCostUsd: 1, digest: HEX('e') }), '42501', wrong);
    // A number with a fraction has no single canonical form: such a card is never filed.
    expect(await k.code(k.file('review.local', { taskId: t.id, x: 0.5 }))).toBe('23514');
    expect(await k.outcome(k.file('hive.dispatch_job', args))).toBe('ok');
  });

  it('the summary and the evidence are written at their own steps; an asset\'s item is part of what Will signs; a spending task says a price above nothing', async () => {
    // Written at any status before: now the summary only as the result is handed in, the evidence only as it is checked.
    const idle = await k.task(w.id);
    for (const col of ['outputSummary', 'barEvidence']) {
      await refused(app(`UPDATE "Task" SET "${col}" = $2 WHERE id = $1`, [idle.id, col === 'barEvidence' ? '[]' : `${CANARY} early`]), '42501', `task ${idle.id}: its ${col} is written at its own step`, col);
    }
    // An asset that stands for an item: the card signs which.
    const e = await k.entity();
    const a = await k.asset({ entityId: e });
    const without = await k.card('asset.enable', (({ entityId: _e, ...rest }) => rest)(k.enableArgs(a)));
    await refused(k.switchOn(app, a.id, without.aid), '42501', `asset ${a.id}: what it is is not what approval ${without.aid} signed`);
    const another = await k.card('asset.enable', k.enableArgs(a, { entityId: await k.entity() }));
    await refused(k.switchOn(app, a.id, another.aid), '42501', `asset ${a.id}: what it is is not what approval ${another.aid} signed`);
    const c = await k.card('asset.enable', k.enableArgs(a));
    expect(k.enableArgs(a).entityId).toBe(e);
    await k.switchOn(app, a.id, c.aid);
    // A spending asset's task at an estimate of nothing: no card dispatches it, and no spend card says nothing.
    const paid = await k.onAsset({ kind: 'nexus_participant', capabilities: ['x'] });
    const free = await k.task(paid.id, { estCostUsd: 0 });
    await refused(k.file(paid.dispatchAction, k.dispatchArgs(free, paid.kind), { kind: 'spend', estCostUsd: 0 }), '23514', /^proposal \w+: its estimate is not valid$/);
    const priced = await k.card(paid.dispatchAction, k.dispatchArgs(free, paid.kind), { kind: 'spend', estCostUsd: 0.01 });
    await refused(k.queue(app, free.id, priced.aid, await k.forecast()), '42501', `task ${free.id}: a spending asset is dispatched by a spend card with its estimate`);
    expect(await status(free.id)).toBe('proposed');
  });

  it('a step whose task Will rejected is no longer done, and only one task at a time is live for a step', async () => {
    const g = await k.goalWithPlan({ s1: 'asset_task', s2: 'will_task' });
    const [s1, s2] = [g.steps.s1!, g.steps.s2!];
    const step = async (sid: string) => (await app(`SELECT status, "taskId", "doneAt" IS NOT NULL AS dated FROM "PlanStep" WHERE id = $1`, [sid])).rows[0];
    const t = await k.taskAt('checked', w, { goalId: g.gid, stepKey: 's1', sensitivity: 'personal' });
    await k.accept(t.id);
    await app(`UPDATE "PlanStep" SET status = 'done', "doneAt" = now(), "taskId" = $2 WHERE id = $1`, [s1, t.id]);
    await app(`UPDATE "PlanStep" SET status = 'done', "doneAt" = now() WHERE id = $1`, [s2]);
    // While its task stands, no second one for the step.
    expect(await k.code(k.task(w.id, { goalId: g.gid, stepKey: 's1', sensitivity: 'personal' }))).toBe('23505');
    // He rejects the result: the step goes back, in the same transaction; his own step is untouched.
    const over = await k.card('task.bar_override', { taskId: t.id, to: 'rejected' });
    await app(`UPDATE "Task" SET status = 'rejected', "barCheckedBy" = 'will' WHERE id = $1`, [t.id]);
    await k.finish(over.pid);
    expect(await step(s1)).toEqual({ status: 'blocked', taskId: t.id, dated: false });
    expect(await step(s2)).toMatchObject({ status: 'done', dated: true });
    await refused(app(`UPDATE "PlanStep" SET status = 'done', "doneAt" = now() WHERE id = $1`, [s1]), '42501', `step ${s1}: a Flint task is done only when its task was accepted`);
    // A new task may run for the step (the rejected one is not live); with it there, the old one is not brought back beside it.
    const retry = await k.task(w.id, { goalId: g.gid, stepKey: 's1', sensitivity: 'personal' });
    await k.card('task.bar_override', { taskId: t.id, to: 'accepted' });
    expect(await k.code(app(`UPDATE "Task" SET status = 'accepted' WHERE id = $1`, [t.id]))).toBe('23505');
    expect([await status(t.id), await status(retry.id), (await step(s1)).status]).toEqual(['rejected', 'proposed', 'blocked']);
    // The history says who moved the step: the write that rejected the task.
    const moved = (await owner(`SELECT changed FROM "RowChange" WHERE "tableName" = 'PlanStep' AND "rowId" = $1 ORDER BY at DESC LIMIT 1`, [s1])).rows[0];
    expect(JSON.stringify(moved?.changed ?? {})).toContain('blocked');
  });

  describe('no card of any kind prints its args, and every kind lives its life as before', () => {
    /** One card of each kind main files today, as it is filed: [what, action, how]. Every one carries the canary in its args. */
    const KINDS: Array<[string, string, Parameters<P5Kit['file']>[2]]> = [
      ['a goal card', 'goal.activate', { kind: 'goal', sensitivity: 'personal', consequential: true }],
      ['a plan change', 'plan.change', { kind: 'plan', sensitivity: 'personal', consequential: true }],
      ['a review\'s plan change', 'plan.change', { kind: 'plan', sensitivity: 'personal', origin: 'runtime:goals', templateId: 'plan.diff.minor' }],
      ['a chat tool call', 'mcp:web.fetch_url', { kind: 'tool_call', origin: 'chat:c1', tainted: true }],
      ['a policy change', 'policy.change', { kind: 'policy', origin: 'cli', consequential: true }],
      ['a triage rule', 'triage.rule.create', { kind: 'rule' }],
      ['adding people from the calendar', 'world.person.create', { kind: 'tool_call', origin: 'runtime:calendar', templateId: 'calendar.people', sensitivity: 'personal', tainted: true }],
      ['turning a source on', 'world.source.enable', { kind: 'tool_call', origin: 'cli' }],
      ['a nightly job', 'backup.local', { kind: 'tool_call', origin: 'runtime:backup', templateId: 'nightly.backup' }],
      ['turning predictions on', 'forecast.series.enable', { kind: 'tool_call', consequential: true }],
      ['a spend card', 'pay.vendor', { kind: 'spend', estCostUsd: 2.5 }],
      ['a pull request', 'selfmod.comment_on_own_pr', { kind: 'pr' }],
      ['a forget', 'world.forget', { kind: 'forget', destructive: true }],
      ['a void', 'ledger.void', { kind: 'void' }],
    ];
    const argsOf = (what: string, n: string) => ({ note: `${CANARY} ${what}`, n });

    it('a rule of Proposal\'s own that refuses a card names the card and the rule, whatever its kind', async () => {
      for (const [what, action, o] of KINDS) {
        // On the way in: a reason too long for the card (words the filer would have put there).
        const pid = id('prop');
        const args = argsOf(what, 'refused');
        const r = await refusal(app(
          `INSERT INTO "Proposal" (id, kind, origin, action, "templateId", args, "argsDigest", "argsProvenance", tainted, sensitivity, reason, "estCostUsd", "expiresAt")
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, '{}', $8, $9, $10, $11, now() + interval '1 hour')`,
          [pid, o?.kind, o?.origin ?? 'console', action, o?.templateId ?? null, JSON.stringify(args), digestOf(args), o?.tainted ?? false, o?.sensitivity ?? 'ops', `${CANARY} `.repeat(60), o?.estCostUsd ?? null]));
        expect([r.code, r.message, r.detail], what).toEqual(['23514', `proposal ${pid}: its reason is not valid`, undefined]);
        // On the way out: an error too long for it, as it is rejected.
        const c = await k.file(action, argsOf(what, 'kept'), o);
        const e = await refusal(app(`UPDATE "Proposal" SET status = 'rejected', error = $2 WHERE id = $1`, [c.pid, `${CANARY} `.repeat(120)]));
        expect([e.code, e.message, e.detail], what).toEqual(['23514', `proposal ${c.pid}: its error is not valid`, undefined]);
        // And a result too large, as it finishes.
        const run = await k.card(action, argsOf(what, 'ran'), o);
        const big = await refusal(app(`UPDATE "Proposal" SET status = 'executed', "executedAt" = now(), result = $2::jsonb WHERE id = $1`, [run.pid, JSON.stringify({ pad: `${CANARY} `.repeat(1200) })]));
        expect([big.code, big.message, big.detail], what).toEqual(['23514', `proposal ${run.pid}: its result is not valid`, undefined]);
        await k.finish(run.pid);
      }
    });

    it('each kind still files, is approved, rejected, expires, runs, fails, and has its args cleared once it has ended', async () => {
      const statusOf = async (pid: string) => (await app(`SELECT status FROM "Proposal" WHERE id = $1`, [pid])).rows[0].status as string;
      const brief: string[] = [];
      for (const [what, action, o] of KINDS) {
        const approved = await k.card(action, argsOf(what, 'approved'), { ...o, stage: 'approved' });
        const rejected = await k.file(action, argsOf(what, 'rejected'), o);
        await app(`UPDATE "Proposal" SET status = 'rejected', "approvalId" = $2, error = 'Synthetic: turned down' WHERE id = $1`, [rejected.pid, await k.approval(rejected.pid, action, rejected.digest, { decision: 'reject' })]);
        const ran = await k.card(action, argsOf(what, 'ran'), { ...o, stage: 'executed' });
        const failed = await k.card(action, argsOf(what, 'failed'), o);
        await app(`UPDATE "Proposal" SET status = 'failed', "executedAt" = now(), error = 'Synthetic: could not' WHERE id = $1`, [failed.pid]);
        const lapsing = await k.file(action, argsOf(what, 'lapsed'), { ...o, life: '1 second' });
        brief.push(lapsing.pid);
        expect([await statusOf(approved.pid), await statusOf(rejected.pid), await statusOf(ran.pid), await statusOf(failed.pid)], what).toEqual(['approved', 'rejected', 'executed', 'failed']);
        // Retention, later: args and result cleared once it has ended, never before.
        await app(`UPDATE "Proposal" SET args = NULL, result = NULL, "argsPurgedAt" = now() WHERE id = $1`, [ran.pid]);
        expect(await k.code(app(`UPDATE "Proposal" SET args = NULL, "argsPurgedAt" = now() WHERE id = $1`, [approved.pid])), what).toBe('42501');
        // (An approved P5-kind card left behind would hold the next test file's reset back: end it.)
        await app(`UPDATE "Proposal" SET status = 'failed', "executedAt" = now(), error = 'Synthetic: ended' WHERE id = $1`, [approved.pid]);
      }
      await sleep(1100);
      for (const pid of brief) {
        await app(`UPDATE "Proposal" SET status = 'expired' WHERE id = $1`, [pid]);
        expect(await statusOf(pid), pid).toBe('expired');
      }
    });

    it('a card from before this migration whose estimate is negative still ends: the money rules hold a card as it is filed, not one already there', async () => {
      // As it could have been filed before (nothing refused it then): the owner sets the new rule aside for the one insert.
      await owner(`ALTER TABLE "Proposal" DISABLE TRIGGER "Proposal_valid_p5"`);
      const old: string[] = [];
      try {
        for (const n of ['a', 'b', 'c']) old.push((await k.file('pay.vendor', { n }, { kind: 'spend', estCostUsd: n === 'c' ? 0 : -1 })).pid);
      } finally {
        await owner(`ALTER TABLE "Proposal" ENABLE TRIGGER "Proposal_valid_p5"`);
      }
      const [a, b, c] = [old[0]!, old[1]!, old[2]!];
      const digest = async (pid: string) => (await app(`SELECT "argsDigest" FROM "Proposal" WHERE id = $1`, [pid])).rows[0].argsDigest as string;
      await k.approve(app, a, await k.approval(a, 'pay.vendor', await digest(a)));
      await app(`UPDATE "Proposal" SET status = 'failed', "executedAt" = now(), error = 'Synthetic: ended' WHERE id = $1`, [a]);
      await app(`UPDATE "Proposal" SET status = 'rejected' WHERE id = $1`, [b]);
      await app(`UPDATE "Proposal" SET status = 'rejected' WHERE id = $1`, [c]);
      expect((await app(`SELECT status FROM "Proposal" WHERE id = ANY ($1) ORDER BY status`, [[a, b, c]])).rows.map((r) => r.status)).toEqual(['failed', 'rejected', 'rejected']);
      // Filed now, neither would be.
      await refused(k.file('pay.vendor', { n: 'new' }, { kind: 'spend', estCostUsd: -1 }), '23514', /^proposal \w+: its estimate is not valid$/);
      await refused(k.file('mcp:web.fetch_url', { n: 'new' }, { kind: 'tool_call', estCostUsd: -0.5 }), '23514', /^proposal \w+: its estimate is not valid$/);
    });
  });
});
