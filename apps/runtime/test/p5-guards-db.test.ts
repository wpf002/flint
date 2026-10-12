/**
 * P5's rules in the database (migration p5_assets), whatever the runtime's
 * code does: every refusal, by its SQLSTATE and its message. Raw SQL as
 * flint_app on flint_test (as flint_owner where flint_app has no grant to get as
 * far as the trigger).
 *
 *  - A signed card: live, executing, unexpired, of the right action, kind and
 *    origin, naming its subject, with the args Will signed; used once.
 *  - Assets, tasks and their outputs, reviews, the review gate, which cards need
 *    a review, and a plan step that is a Flint task: each rule its guard holds.
 *  - A refused row names ids and the rule: no message, DETAIL or context here
 *    carries a title, a spec or a model's words (the kit's refusal() fails the
 *    test if one does).
 * The last test reads every RAISE out of the migration and checks that each
 * was refused somewhere above, with the SQLSTATE it declares.
 * Synthetic text only.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { digestOf } from '@flint/policy';
import { MIGRATIONS, NO_DB, freshDb, id, HEX } from './db';
import { p5Kit, refusal, sleep, CANARY, SPEC, BAR, type AssetRow, type P5Kit, type Q } from './p5';

const SQLSTATE: Record<string, string> = { insufficient_privilege: '42501', check_violation: '23514', serialization_failure: '40001' };
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

describe.skipIf(NO_DB)('P5 guards in the database', () => {
  let k: P5Kit;
  let app: Q;
  let owner: Q;
  /** A worker that is on, for the tests that need one and do not turn it off. */
  let w: AssetRow;
  const seen: Array<{ code: string | undefined; message: string }> = [];

  /** Refused with exactly this SQLSTATE and message, and with no DETAIL (nothing of the row). */
  async function refused(p: Promise<unknown>, code: string, message: string | RegExp, label = ''): Promise<void> {
    const r = await refusal(p);
    seen.push({ code: r.code, message: r.message });
    if (typeof message === 'string') expect([r.code, r.message], label).toEqual([code, message]);
    else expect([r.code, r.message], label).toEqual([code, expect.stringMatching(message)]);
    expect(r.detail, label).toBeUndefined();
  }
  const status = async (taskId: string) => (await app(`SELECT status FROM "Task" WHERE id = $1`, [taskId])).rows[0].status as string;
  const set = (q: Q, taskId: string, sets: string, params: unknown[] = []) => q(`UPDATE "Task" SET ${sets} WHERE id = $1`, [taskId, ...params]);
  const notLive = (key: string, subject: string) => new RegExp(`^${key} ${esc(subject)}: approval \\S+ is not a live signed approval of a card$`);
  const notFor = (key: string, subject: string, action: string) => new RegExp(`^${key} ${esc(subject)}: approval \\w+ is not for an executing ${esc(action)} of it$`);

  beforeAll(async () => {
    k = await p5Kit(await freshDb());
    ({ app, owner } = k);
    w = await k.onAsset();
  });

  describe('a signed card', () => {
    it('acts only while it is Will\'s live approval of an executing, unexpired card for that action, kind, origin and subject', async () => {
      const a = await k.asset();
      const on = (aid: string | null) => k.switchOn(app, a.id, aid);
      const args = k.enableArgs(a);
      // No approval, one that does not exist, and words where an approval's id goes (never repeated).
      await refused(on(null), '42501', `asset ${a.id}: turning it on needs a new approval`);
      await refused(on('apprnone'), '42501', `assetId ${a.id}: approval apprnone is not a live signed approval of a card`);
      await refused(on(`${CANARY} not an id`), '42501', `assetId ${a.id}: approval ? is not shaped as a card's approval`);
      // A signed rejection; an approval of something that is not a card; one from a credential since revoked.
      const pending = await k.file('asset.enable', args);
      await refused(on(await k.approval(pending.pid, 'asset.enable', pending.digest, { decision: 'reject' })), '42501', notLive('assetId', a.id));
      await refused(on(await k.approval(a.id, 'world.forget', HEX('a'), { subjectType: 'forget' })), '42501', notLive('assetId', a.id));
      const lost = id('cred');
      await k.approver(`INSERT INTO "ApprovalCredential" (id, "credentialId", factor, "publicKey", label, "enrolledVia") VALUES ($1, $2, 'webauthn', '\\x00', 'lost key', 'enroll_code')`, [id(), lost]);
      const byLost = await k.card('asset.enable', args, { credential: lost });
      await k.approver(`UPDATE "ApprovalCredential" SET "revokedAt" = now() WHERE "credentialId" = $1`, [lost]);
      await refused(on(byLost.aid), '42501', notLive('assetId', a.id));
      await k.finish(byLost.pid);

      const wrong = notFor('assetId', a.id, 'asset.enable');
      // Signed, but the card still waits, is only approved, or has already run.
      for (const stage of ['pending', 'approved', 'executed'] as const) await refused(on((await k.card('asset.enable', args, { stage })).aid), '42501', wrong, stage);
      // A card for another asset, and one for another action that names this asset.
      const other = await k.asset();
      await refused(on((await k.card('asset.enable', k.enableArgs(other))).aid), '42501', wrong);
      await refused(on((await k.card('task.cancel', { assetId: a.id, taskId: 'tanone' })).aid), '42501', wrong);
      // The right action under another kind, from chat or from a job, with untrusted text in the turn, or without Will's own-touch mark.
      for (const [label, o] of [
        ['kind task', { kind: 'task' }], ['kind tool_call', { kind: 'tool_call' }], ['from chat', { origin: 'chat:c1' }], ['from a job', { origin: 'runtime:assets' }],
        ['tainted', { tainted: true }], ['no own-touch mark', { consequential: false }],
      ] as const) await refused(on((await k.card('asset.enable', { ...args, n: label }, o)).aid), '42501', wrong, label);
      // Filed to outlive Will's signature by more than a week; and past its expiry, though still marked executing.
      await refused(on((await k.card('asset.enable', { ...args, n: 'long' }, { life: '60 days' })).aid), '42501', wrong);
      const brief = await k.card('asset.enable', { ...args, n: 'brief' }, { life: '1 second' });
      await sleep(1100);
      await refused(on(brief.aid), '42501', wrong);
      // A signature recorded before its card was filed is for nothing: the card was not there to say what it was about.
      const unfiled = { pid: id('prop'), args: { ...args, n: 'unfiled' } };
      const ahead = await k.approval(unfiled.pid, 'asset.enable', digestOf(unfiled.args));
      await k.file('asset.enable', unfiled.args, { id: unfiled.pid });
      await k.approve(app, unfiled.pid, ahead);
      await app(`UPDATE "Proposal" SET status = 'executing' WHERE id = $1`, [unfiled.pid]);
      await refused(on(ahead), '42501', wrong);
      expect((await app(`SELECT enabled FROM "Asset" WHERE id = $1`, [a.id])).rows[0].enabled).toBe(false);

      // What the card signed is what the asset is, field by field.
      for (const [label, over] of [
        ['kind', { kind: 'ci_runner' }], ['reference', { externalRef: 'test:other' }], ['name', { name: 'Another Name' }], ['capabilities', { capabilities: ['summarize_items'] }],
        ['capabilities, reordered', { capabilities: [...a.capabilities].reverse() }], ['action', { dispatchAction: 'task.dispatch.ci_runner' }], ['spends', { spends: true }],
        ['the item it stands for', { entityId: 'en1' }],
      ] as const) {
        const c = await k.card('asset.enable', k.enableArgs(a, over));
        await refused(on(c.aid), '42501', `asset ${a.id}: what it is is not what approval ${c.aid} signed`, label);
        expect(await k.used(c.aid), label).toBe(0);
      }
      for (const drop of ['spends', 'entityId'] as const) {
        const { [drop]: _drop, ...bare } = args;
        const missing = await k.card('asset.enable', bare);
        await refused(on(missing.aid), '42501', `asset ${a.id}: what it is is not what approval ${missing.aid} signed`, drop);
      }

      // The matching card: a week is the longest the runtime files one for, and that works.
      const c = await k.card('asset.enable', { ...args }, { life: '7 days', origin: 'cli' });
      await on(c.aid);
      expect((await app(`SELECT enabled, "approvalId" FROM "Asset" WHERE id = $1`, [a.id])).rows[0]).toEqual({ enabled: true, approvalId: c.aid });
    });

    it('the stored args are the args he signed, under any action name: a task or spend card is checked when it is filed, and its digest computed again when it is used', async () => {
      const hive = await k.onAsset({ kind: 'hive_bot', capabilities: [] });
      const t = await k.task(hive.id);
      const args = k.dispatchArgs(t, 'hive_bot');
      const other = digestOf({ ...args, title: 'Synthetic other title' });
      // Filed under a digest of other args: refused, whatever the card is called (every task and spend card is checked).
      await refused(k.file('hive.dispatch_job', args, { digest: other }), '42501', /^proposal \w+: its digest is not its args' digest$/);
      await refused(k.file('review.local', args, { digest: other }), '42501', /^proposal \w+: its digest is not its args' digest$/);
      await refused(k.file('pay.vendor', args, { kind: 'spend', estCostUsd: 1, digest: other }), '42501', /^proposal \w+: its digest is not its args' digest$/);
      // Were that check ever missing (here the owner sets it aside for one card, in one transaction), the card still acts on nothing: the digest is computed again when it is used.
      const forged = await k.sign(await k.without('Proposal_p5_digest_check', (q) => k.file('hive.dispatch_job', args, { digest: other }, q)), 'hive.dispatch_job');
      const f = await k.forecast({ taskId: t.id });
      await refused(k.queue(app, t.id, forged.aid, f), '42501', `taskId ${t.id}: the card approval ${forged.aid} signed does not hold the args he signed`);
      expect(await status(t.id)).toBe('proposed');
      const honest = await k.card('hive.dispatch_job', args);
      await k.queue(app, t.id, honest.aid, f);
      expect(await status(t.id)).toBe('queued');
    });

    it('is used once: in one transaction, for one subject and one action, and never by a call of its own', async () => {
      const a = await k.asset();
      const first = await k.card('asset.enable', k.enableArgs(a));
      // By hand: nothing is used, even for the live card and its own asset.
      await refused(app(`SELECT p5_bind_approval($1, 'assetId', $2, 'asset.enable')`, [first.aid, a.id]), '42501', 'task or asset card: an approval is used only by the change it signed');
      expect(await k.used(first.aid)).toBe(0);
      await k.switchOn(app, a.id, first.aid);
      const use = (await owner(`SELECT subject, action, xact FROM "TaskApprovalUse" WHERE "approvalId" = $1`, [first.aid])).rows[0];
      expect(use).toMatchObject({ subject: `assetId:${a.id}`, action: 'asset.enable' });
      expect(use.xact).toMatch(/^\d+@\d{16}$/);
      // The card is left executing. Off, then on again with the same approval: it needs a new one.
      await k.switchOff(app, a.id);
      await refused(k.switchOn(app, a.id, first.aid), '42501', `asset ${a.id}: turning it on needs a new approval`);
      // On under a second card (the same args, its own approval), off again: the first approval is still not usable,
      // though the row no longer names it.
      const second = await k.card('asset.enable', k.enableArgs(a));
      await k.switchOn(app, a.id, second.aid);
      await k.switchOff(app, a.id);
      await refused(k.switchOn(app, a.id, first.aid), '42501', `assetId ${a.id}: approval ${first.aid} was already used`);
      expect((await app(`SELECT enabled, "approvalId" FROM "Asset" WHERE id = $1`, [a.id])).rows[0]).toEqual({ enabled: false, approvalId: second.aid });
      // Order counts as well as use. A spare card signed before the one that was used (never used itself) decides nothing afterwards...
      const d = await k.asset();
      const spare = await k.card('asset.enable', k.enableArgs(d), { stage: 'approved' });
      const usedOne = await k.card('asset.enable', k.enableArgs(d));
      await k.switchOn(app, d.id, usedOne.aid);
      await k.finish(usedOne.pid);
      await k.switchOff(app, d.id);
      await app(`UPDATE "Proposal" SET status = 'executing' WHERE id = $1`, [spare.pid]);
      await refused(k.switchOn(app, d.id, spare.aid), '42501', `assetId ${d.id}: approval ${spare.aid} was signed before a later decision`);
      // ...and nor does one signed while the asset was on, once Will has turned it off (that needs no card, so only the asset says when).
      const whileOn = await k.card('asset.enable', k.enableArgs(d), { stage: 'approved' });
      const again = await k.card('asset.enable', k.enableArgs(d));
      await k.switchOn(app, d.id, again.aid);
      await k.finish(again.pid);
      const later = await k.card('asset.enable', k.enableArgs(d), { stage: 'approved' });
      await k.switchOff(app, d.id);
      await app(`UPDATE "Proposal" SET status = 'executing' WHERE id = ANY ($1)`, [[whileOn.pid, later.pid]]);
      await refused(k.switchOn(app, d.id, later.aid), '42501', `asset ${d.id}: approval ${later.aid} was signed before it last changed`);
      expect([(await app(`SELECT enabled FROM "Asset" WHERE id = $1`, [d.id])).rows[0].enabled, await k.used(spare.aid), await k.used(later.aid)]).toEqual([false, 0, 0]);
      // A card signed since then turns it on, as always.
      await k.turnOn(d);
      // A use that is rolled back is no use: the approval is still Will's to use.
      const b = await k.asset();
      const c = await k.card('asset.enable', k.enableArgs(b));
      await k.inTx((q) => k.switchOn(q, b.id, c.aid), { commit: false });
      expect(await k.used(c.aid)).toBe(0);
      await k.switchOn(app, b.id, c.aid);
      expect(await k.used(c.aid)).toBe(1);
    });
  });

  describe('a task, asset or gate card when it is filed', () => {
    it('its digest is its args\' digest; cards of other actions are untouched', async () => {
      const args = { taskId: 'tatest0001', title: `${CANARY} title` };
      const file = (action: string, kind: string, digest: string, a: Record<string, unknown> = args) => k.file(action, a, { kind, digest });
      for (const [action, kind] of [['task.dispatch.local_worker', 'task'], ['task.cancel', 'task'], ['task.check_bar', 'task'], ['task.bar_override', 'task'], ['asset.enable', 'policy'], ['review.enforce', 'policy']] as const) {
        await refused(file(action, kind, digestOf({ ...args, taskId: 'tatest0002' })), '42501', /^proposal \w+: its digest is not its args' digest$/, action);
        expect(await k.outcome(file(action, kind, digestOf(args))), action).toBe('ok');
      }
      expect(await k.outcome(file('world.sync.git', 'tool_call', HEX('a')))).toBe('ok');
      // Every task and spend card is checked, whatever its action: a reviewer's or the Hive's dispatch card is one a guard acts on.
      for (const action of ['review.local', 'review.trident_panel', 'hive.dispatch_job', 'x.y']) await refused(file(action, 'task', HEX('a')), '42501', /^proposal \w+: its digest is not its args' digest$/, action);
      expect(await k.code(file('review.local', 'task', HEX('a'), { taskId: 'tatest0001', x: 0.5 }))).toBe('23514');
      // Money is whole micro-dollars: a fraction has no single canonical form, so such a card is never filed.
      expect(await k.code(file('task.dispatch.local_worker', 'task', HEX('a'), { estCostMicros: 0.5 }))).toBe('23514');
    });

    it('a rule of Proposal\'s own that refuses it says which, never its args', async () => {
      const args = { taskId: 'tatest0001', title: `${CANARY} title`, spec: { template: 'draft_note', params: { what: `${CANARY} words` } } };
      const insert = (cols: Record<string, unknown>) => {
        const v: Record<string, unknown> = { id: id('prop'), kind: 'task', origin: 'console', action: 'task.dispatch.local_worker', templateId: null, args: JSON.stringify(args), argsDigest: digestOf(args),
          argsProvenance: '{}', tainted: false, sensitivity: 'ops', destructive: false, consequential: false, reason: null, estCostUsd: null, life: '1 hour', ...cols };
        return app(
          `INSERT INTO "Proposal" (id, kind, origin, action, "templateId", args, "argsDigest", "argsProvenance", tainted, sensitivity, destructive, consequential, reason, "estCostUsd", "expiresAt")
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::jsonb, $9, $10, $11, $12, $13, $14, now() + $15::interval)`,
          [v.id, v.kind, v.origin, v.action, v.templateId, v.args, v.argsDigest, v.argsProvenance, v.tainted, v.sensitivity, v.destructive, v.consequential, v.reason, v.estCostUsd, v.life]);
      };
      const big = { ...args, pad: `${CANARY} `.repeat(4000) };
      for (const [rule, cols] of [
        ['a required field', { origin: null }], ['a required field', { tainted: null }], ['a required field', { consequential: null }],
        ['kind', { kind: 'chore' }], ['sensitivity', { sensitivity: 'secret' }], ['args', { args: JSON.stringify(big), argsDigest: digestOf(big) }],
        ['reason', { reason: `${CANARY} `.repeat(60) }], ['provenance', { argsProvenance: '[]' }], ['template', { origin: 'runtime:tasks' }], ['expiry', { life: '-1 hour' }],
        // An estimate is never negative, and a spend card says one above nothing.
        ['estimate', { kind: 'spend', estCostUsd: -1 }], ['estimate', { estCostUsd: -0.01 }], ['estimate', { kind: 'spend', estCostUsd: 0 }], ['estimate', { kind: 'spend' }],
        // A card of a kind the digest check does not look at still has its digest's shape checked here.
        ['digest', { kind: 'tool_call', action: 'pay.vendor', argsDigest: 'not-a-digest' }],
      ] as const) await refused(insert(cols), '23514', new RegExp(`^proposal \\w+: its ${rule} is not valid$`), rule);
      // On update too: an error or a result too long for the card.
      const c = await k.card('task.cancel', { taskId: 'tatest0001', title: `${CANARY} title` });
      await refused(app(`UPDATE "Proposal" SET status = 'failed', error = $2 WHERE id = $1`, [c.pid, `${CANARY} `.repeat(120)]), '23514', `proposal ${c.pid}: its error is not valid`);
      await refused(app(`UPDATE "Proposal" SET status = 'executed', "executedAt" = now(), result = $2::jsonb WHERE id = $1`, [c.pid, JSON.stringify({ pad: `${CANARY} `.repeat(1200) })]), '23514', `proposal ${c.pid}: its result is not valid`);
    });
  });

  describe('assets', () => {
    it('are born off and unsigned, with an id shaped like one; what one is is held by its own checks', async () => {
      await refused(k.asset({ id: `${CANARY} id` }), '23514', 'asset: its id is not valid');
      await refused(k.asset({ id: null as unknown as string }), '23514', 'asset: its id is not valid');
      const a = id('as');
      await refused(k.asset({ id: a, enabled: true }), '42501', `asset ${a}: an asset starts off and unsigned`);
      await refused(k.asset({ id: a, approvalId: 'apprx' }), '42501', `asset ${a}: an asset starts off and unsigned`);
      await refused(k.asset({ id: a, enabled: null }), '42501', `asset ${a}: an asset starts off and unsigned`);
      // An asset holds no words of Will's, so these are plain constraints (their names say which).
      const constraint = async (over: Record<string, unknown>) => ((await refusal(k.asset(over))).message.match(/constraint "(\w+)"/) ?? [])[1];
      expect(await constraint({ kind: 'intern' })).toBe('Asset_kind_check');
      expect(await constraint({ kind: 'ci_runner', dispatchAction: 'task.dispatch.local_worker' })).toBe('Asset_dispatchAction_check');
      expect(await constraint({ kind: 'local_reviewer', dispatchAction: 'task.dispatch.local_reviewer' })).toBe('Asset_dispatchAction_check');
      expect(await constraint({ kind: 'local_worker', spends: true })).toBe('Asset_spends_check');
      expect(await constraint({ kind: 'nexus_participant', spends: false })).toBe('Asset_spends_check');
      expect(await constraint({ kind: 'trident_panel', spends: false })).toBe('Asset_spends_check');
      expect(await constraint({ capabilities: ['Not A Template'] })).toBe('Asset_capabilities_check');
      expect(await constraint({ capabilities: Array.from({ length: 21 }, (_, i) => `t${i}`) })).toBe('Asset_capabilities_check');
      expect(await constraint({ externalRef: 'Has Spaces' })).toBe('Asset_externalRef_check');
      expect(await constraint({ name: '' })).toBe('Asset_name_check');
      expect(await constraint({ entityId: 'not an id' })).toBe('Asset_entityId_check');
    });

    it('what one is never changes; it is never deleted; on and off are the only moves, both at READ COMMITTED, and on is signed', async () => {
      const a = await k.asset();
      for (const [col, value] of [['kind', 'ci_runner'], ['externalRef', 'test:renamed'], ['name', 'Renamed'], ['capabilities', '{review}'], ['dispatchAction', 'review.local'], ['spends', true], ['entityId', 'en1'], ['createdAt', '2020-01-01'], ['id', id('as')]] as const) {
        await refused(owner(`UPDATE "Asset" SET "${col}" = $2 WHERE id = $1`, [a.id, value]), '42501', `asset ${a.id}: what it is never changes`, col);
      }
      // When it last changed is the database's to say.
      await refused(owner(`UPDATE "Asset" SET "changedAt" = '2020-01-01' WHERE id = $1`, [a.id]), '42501', `asset ${a.id}: when it last changed is stamped here`);
      await refused(owner(`DELETE FROM "Asset" WHERE id = $1`, [a.id]), '42501', 'assets are never deleted (an asset is turned off)');
      await refused(owner(`TRUNCATE "Asset" CASCADE`), '42501', 'assets are never deleted (an asset is turned off)');
      await refused(app(`UPDATE "Asset" SET enabled = NULL WHERE id = $1`, [a.id]), '23514', `asset ${a.id}: it is on or off`);
      const c = await k.card('asset.enable', k.enableArgs(a));
      // Its approval is set when it is turned on, and at no other time.
      await refused(app(`UPDATE "Asset" SET "approvalId" = $2 WHERE id = $1`, [a.id, c.aid]), '42501', `asset ${a.id}: its approval changes only when it is turned on`);
      for (const iso of ['REPEATABLE READ', 'SERIALIZABLE']) {
        await refused(k.inTx((q) => k.switchOn(q, a.id, c.aid), { iso }), '40001', `asset ${a.id}: it is turned on or off at read committed only`, iso);
      }
      const made = (await app(`SELECT "changedAt" FROM "Asset" WHERE id = $1`, [a.id])).rows[0].changedAt as Date;
      await k.switchOn(app, a.id, c.aid);
      const turnedOn = (await app(`SELECT "changedAt" FROM "Asset" WHERE id = $1`, [a.id])).rows[0].changedAt as Date;
      expect(turnedOn.getTime()).toBeGreaterThan(made.getTime());
      await refused(app(`UPDATE "Asset" SET "approvalId" = NULL WHERE id = $1`, [a.id]), '42501', `asset ${a.id}: its approval changes only when it is turned on`);
      // Off needs no signature, but it reads what is committed now too (the last reviewer's rule depends on it).
      for (const iso of ['REPEATABLE READ', 'SERIALIZABLE']) {
        await refused(k.inTx((q) => k.switchOff(q, a.id), { iso }), '40001', `asset ${a.id}: it is turned on or off at read committed only`, iso);
      }
      await k.switchOff(app, a.id);
      const off = (await app(`SELECT enabled, "changedAt" FROM "Asset" WHERE id = $1`, [a.id])).rows[0];
      expect(off.enabled).toBe(false);
      expect((off.changedAt as Date).getTime()).toBeGreaterThan(turnedOn.getTime());
    });
  });

  describe('tasks: how one is born', () => {
    it('proposed, with its spec, its bar and its estimate, and nothing else set', async () => {
      await refused(k.task(w.id, { id: `${CANARY} id` }), '23514', 'task: its id is not valid');
      const t = id('ta');
      const born = `task ${t}: a task starts proposed, with its spec, its bar and its estimate, and nothing else set`;
      for (const [label, over] of [
        ['queued', { status: 'queued' }], ['no status', { status: null }], ['an approval', { dispatchApprovalId: 'apprx' }], ['a job', { externalJobId: 'job1' }], ['an output', { outputRef: 'out:abc' }],
        ['a summary', { outputSummary: `${CANARY} summary` }], ['a bar', { metBar: true }], ['evidence', { barEvidence: [] }], ['a checker', { barCheckedBy: 'will' }], ['a proof', { acceptedAuditId: 'au1' }],
        ['a forecast', { predictionId: 'pd1' }], ['a cost', { costUsd: 1 }], ['attempts', { attempts: 2 }], ['a failure', { failure: 'error' }], ['a dispatch time', { dispatchedAt: '2026-01-01' }],
        ['an end time', { completedAt: '2026-01-01' }], ['a purge time', { textPurgedAt: '2026-01-01' }], ['no spec', { spec: null }], ['no bar', { acceptance: null }], ['no estimate', { estCostUsd: null }],
      ] as const) await refused(k.task(w.id, { id: t, ...over }), '42501', born, label);
    });

    it('its own rules name the rule, never what it holds', async () => {
      const t = id('ta');
      const invalid = (rule: string) => `task ${t}: its ${rule} is not valid`;
      const goal = (await k.goalWithPlan({ s1: 'asset_task' })).gid;
      for (const [rule, over] of [
        ['a required field', { tainted: null }], ['a required field', { assetId: null }], ['id', { assetId: `${CANARY} asset` }],
        ['origin', { origin: 'chat' }], ['origin', { origin: null }], ['sensitivity', { sensitivity: 'secret' }],
        ['title', { title: '' }], ['title', { title: null }], ['title', { title: `${CANARY} `.repeat(20) }],
        ['spec', { spec: [SPEC] }], ['spec', { spec: { params: { note: `${CANARY} spec` } } }], ['spec', { spec: { template: `${CANARY} template` } }], ['spec', { spec: { template: 'draft_note', pad: `${CANARY} `.repeat(1200) } }],
        ['bar', { acceptance: { id: 'a1' } }], ['bar', { acceptance: [] }], ['bar', { acceptance: Array.from({ length: 11 }, (_, i) => ({ id: `a${i}`, text: CANARY })) }], ['bar', { acceptance: [{ id: 'a1', text: `${CANARY} `.repeat(600) }] }],
        ['items', { entityIds: Array.from({ length: 21 }, (_, i) => `en${i}`) }], ['items', { entityIds: [`${CANARY} item`] }], ['items', { entityIds: null }],
        ['step', { stepKey: 's1' }], ['step', { goalId: goal, stepKey: 'first' }], ['step', { goalId: `${CANARY} goal` }],
        ['cost', { estCostUsd: -0.01 }],
      ] as const) await refused(k.task(w.id, { id: t, ...over }), '23514', invalid(rule), `${rule} ${JSON.stringify(over).slice(0, 40)}`);
      // A JSON null is not a spec or a bar either.
      await refused(app(`INSERT INTO "Task" (id, "assetId", title, spec, acceptance, origin, "estCostUsd", "updatedAt") VALUES ($1, $2, 'T', 'null'::jsonb, $3::jsonb, 'will', 0, now())`, [t, w.id, JSON.stringify(BAR)]), '23514', invalid('spec'));
      expect((await app(`SELECT count(*)::int AS n FROM "Task" WHERE id = $1`, [t])).rows[0].n).toBe(0);
      // (The rules on what an update sets are with the moves, below. Four rules sit behind a guard that refuses
      // first, so no statement reaches them: status, approval, proof and purge. They are there for the day a guard changes.)
    });
  });

  describe('tasks: the dispatch', () => {
    it('needs the asset on, at READ COMMITTED, and Will\'s executing card for exactly this task', async () => {
      const a = await k.asset();
      const t = await k.task(a.id, { dueAt: '2026-12-01T10:00:00.000Z' });
      const f = await k.forecast({ taskId: t.id });
      await refused(k.queue(app, t.id, null, f), '42501', `task ${t.id}: dispatching it needs an approval`);
      const c = await k.card(a.dispatchAction, k.dispatchArgs(t, a.kind));
      await refused(k.queue(app, t.id, c.aid, f), '42501', `task ${t.id}: asset ${a.id} is off`);
      await k.turnOn(a);
      for (const iso of ['REPEATABLE READ', 'SERIALIZABLE']) await refused(k.inTx((q) => k.queue(q, t.id, c.aid, f), { iso }), '40001', `task ${t.id}: its status changes at read committed only`, iso);
      // Another task's card, a card for another asset's action, and an accept card for this task.
      const other = await k.task(a.id);
      const wrong = notFor('taskId', t.id, a.dispatchAction);
      await refused(k.queue(app, t.id, (await k.card(a.dispatchAction, k.dispatchArgs(other, a.kind))).aid, f), '42501', wrong);
      await refused(k.queue(app, t.id, (await k.card('task.dispatch.ci_runner', k.dispatchArgs(t, a.kind))).aid, f), '42501', wrong);
      await refused(k.queue(app, t.id, (await k.card('task.check_bar', { taskId: t.id, metBar: true })).aid, f), '42501', wrong);
      // From chat: no task card comes from there.
      await refused(k.queue(app, t.id, (await k.card(a.dispatchAction, { ...k.dispatchArgs(t, a.kind), n: 1 }, { origin: 'chat:c1' })).aid, f), '42501', wrong);

      // Signed args that differ from the task by one field, or lack one.
      const full = k.dispatchArgs(t, a.kind);
      const differs = async (label: string, args: Record<string, unknown>, o: Parameters<P5Kit['card']>[2] = {}) => {
        const d = await k.card(a.dispatchAction, args, o);
        await refused(k.queue(app, t.id, d.aid, f), '42501', `task ${t.id}: it is not the task approval ${d.aid} signed`, label);
        expect(await k.used(d.aid), label).toBe(0);
      };
      for (const [label, over] of [
        ['asset', { assetId: w.id }], ['kind of asset', { assetKind: 'ci_runner' }], ['title', { title: `${CANARY} other title` }], ['spec', { spec: { ...SPEC, params: { items: ['en9'] } } }],
        ['bar', { acceptance: [{ ...BAR[0], id: 'a2' }] }], ['goal', { goalId: 'gotest0001' }], ['step', { stepKey: 's1' }], ['due time', { dueAt: '2026-12-01T10:00:00.001Z' }], ['no due time', { dueAt: null }],
        ['sensitivity', { sensitivity: 'personal' }], ['taint', { tainted: true }], ['estimate', { estCostMicros: 1 }],
      ] as const) await differs(label, { ...full, ...over });
      const { acceptance: _drop, ...lacking } = full;
      await differs('no bar', lacking);
      // The card itself is as sensitive and as tainted as the task (so a tainted task's card always asks for a review).
      await differs('a card marked personal', { ...full, n: 1 }, { sensitivity: 'personal' });
      await differs('a card marked tainted', { ...full, n: 2 }, { tainted: true });
      // Words where the signed time or the estimate goes are never cast (a cast's error would repeat them).
      const words = await k.card(a.dispatchAction, { ...full, dueAt: `${CANARY} soon` });
      await refused(k.queue(app, t.id, words.aid, f), '42501', `task ${t.id}: the due time approval ${words.aid} signed is not a time`);
      const text = await k.card(a.dispatchAction, { ...full, estCostMicros: `${CANARY} cheap` });
      await refused(k.queue(app, t.id, text.aid, f), '42501', `task ${t.id}: the estimate approval ${text.aid} signed is not a number`);

      // Its forecast: none, another kind of prediction, one from another writer, one no longer open; and one that does
      // not carry its rule (no rule at all, another task's, another rule, or one only Will resolves).
      const needs = `task ${t.id}: dispatching it needs its open forecast, with its rule`;
      const fresh = async () => (await k.card(a.dispatchAction, { ...full })).aid;
      await refused(k.queue(app, t.id, await fresh(), null), '42501', needs);
      await refused(k.queue(app, t.id, await fresh(), 'pdnone'), '42501', needs);
      await refused(k.queue(app, t.id, await fresh(), await k.forecast({ taskId: t.id, domain: 'services' })), '42501', needs);
      await refused(k.queue(app, t.id, await fresh(), await k.forecast({ taskId: t.id, type: 'event_occurs' })), '42501', needs);
      await refused(k.queue(app, t.id, await fresh(), await k.forecast({ taskId: t.id, createdBy: 'client:server' })), '42501', needs);
      await refused(k.queue(app, t.id, await fresh(), await k.forecast()), '42501', needs);
      await refused(k.queue(app, t.id, await fresh(), await k.forecast({ taskId: other.id })), '42501', needs);
      await refused(k.queue(app, t.id, await fresh(), await k.forecast({ resolverSpec: { taskId: t.id, rule: 'goal_done_by' } })), '42501', needs);
      await refused(k.queue(app, t.id, await fresh(), await k.forecast({ resolverSpec: { owner: 'runtime:tasks', rule: 'task_meets_bar' } })), '42501', needs);
      await refused(k.queue(app, t.id, await fresh(), await k.forecast({ resolverSpec: [t.id, 'task_meets_bar'] })), '42501', needs);
      await refused(k.queue(app, t.id, await fresh(), await k.forecast({ taskId: t.id, resolver: 'will' })), '42501', needs);
      const closed = await k.forecast({ taskId: t.id, resolveIn: '1 second' });
      await sleep(1100);
      await app(`UPDATE "Prediction" SET status = 'expired' WHERE id = $1`, [closed]);
      await refused(k.queue(app, t.id, await fresh(), closed), '42501', needs);
      expect(await status(t.id)).toBe('proposed');

      // The first card matches, but Will has signed others about this task since: his latest signature is the one that counts.
      await refused(k.queue(app, t.id, c.aid, f), '42501', `taskId ${t.id}: approval ${c.aid} was signed before a later decision`);
      expect([await status(t.id), await k.used(c.aid)]).toEqual(['proposed', 0]);
      await k.queue(app, t.id, await fresh(), f);
      expect(await status(t.id)).toBe('queued');
      // A forecast belongs to one task: the one it names (and Task.predictionId is unique besides).
      const second = await k.task(a.id);
      await refused(k.queue(app, second.id, (await k.card(a.dispatchAction, k.dispatchArgs(second, a.kind))).aid, f), '42501', `task ${second.id}: dispatching it needs its open forecast, with its rule`);
    });

    it('money: a spending asset is dispatched by a spend card from the console with its estimate; any other by a task card at no cost', async () => {
      const paid = await k.onAsset({ kind: 'nexus_participant' });
      const t = await k.task(paid.id, { estCostUsd: 0.25 });
      const args = k.dispatchArgs(t, paid.kind);
      const f = await k.forecast({ taskId: t.id });
      const spendCard = `task ${t.id}: a spending asset is dispatched by a spend card with its estimate`;
      await refused(k.queue(app, t.id, (await k.card(paid.dispatchAction, args, { kind: 'task' })).aid, f), '42501', spendCard);
      await refused(k.queue(app, t.id, (await k.card(paid.dispatchAction, { ...args, n: 1 }, { kind: 'spend', estCostUsd: 0.2 })).aid, f), '42501', spendCard);
      // A spend card with no estimate, or one of nothing, is never filed at all.
      for (const estCostUsd of [null, 0]) await refused(k.file(paid.dispatchAction, { ...args, n: 2 }, { kind: 'spend', estCostUsd }), '23514', /^proposal \w+: its estimate is not valid$/, String(estCostUsd));
      // Nor does a spending asset take a task priced at nothing, under any card.
      const zero = await k.task(paid.id, { estCostUsd: 0 });
      await refused(k.queue(app, zero.id, (await k.card(paid.dispatchAction, k.dispatchArgs(zero, paid.kind), { kind: 'spend', estCostUsd: 0.01 })).aid, await k.forecast({ taskId: zero.id })), '42501', `task ${zero.id}: a spending asset is dispatched by a spend card with its estimate`);
      // A job cannot file a spending dispatch: only Will, from the console.
      await refused(k.queue(app, t.id, (await k.card(paid.dispatchAction, { ...args, n: 3 }, { kind: 'spend', estCostUsd: 0.25, origin: 'runtime:tasks' })).aid, f), '42501', spendCard);
      await k.queue(app, t.id, (await k.card(paid.dispatchAction, { ...args, n: 4 }, { kind: 'spend', estCostUsd: 0.25 })).aid, f);

      const free = `an asset that does not spend is dispatched by a task card, at no cost`;
      const local = await k.task(w.id);
      await refused(k.queue(app, local.id, (await k.card(w.dispatchAction, k.dispatchArgs(local, w.kind), { kind: 'spend', estCostUsd: 0.01 })).aid, await k.forecast({ taskId: local.id })), '42501', `task ${local.id}: ${free}`);
      const priced = await k.task(w.id, { estCostUsd: 0.01 });
      await refused(k.queue(app, priced.id, (await k.card(w.dispatchAction, k.dispatchArgs(priced, w.kind))).aid, await k.forecast({ taskId: priced.id })), '42501', `task ${priced.id}: ${free}`);

      // What went out ends with what it cost, however it ends; a cost is never negative.
      await k.setStatus(app, t.id, 'dispatched');
      const owes = `task ${t.id}: a spending task ends with its cost`;
      await refused(k.setStatus(app, t.id, 'failed', `, failure = 'timeout'`), '42501', owes);
      const cancel = await k.card('task.cancel', { taskId: t.id });
      await refused(k.setStatus(app, t.id, 'cancelled'), '42501', owes);
      expect(await k.used(cancel.aid)).toBe(0);
      await refused(k.setStatus(app, t.id, 'failed', `, failure = 'timeout', "costUsd" = -1`), '23514', `task ${t.id}: its cost is not valid`);
      // Whether a cost is an estimate is said with the cost, and not afterwards.
      await refused(set(app, t.id, `"costIsEstimate" = false`), '42501', `task ${t.id}: whether its cost is an estimate is said with its cost`);
      await k.setStatus(app, t.id, 'failed', `, failure = 'timeout', "costUsd" = 0.19`);
      await refused(set(app, t.id, `"costIsEstimate" = false`), '42501', `task ${t.id}: whether its cost is an estimate is said with its cost`);
      await refused(set(app, t.id, `"costUsd" = 0.01`), '42501', `task ${t.id}: costUsd is set once`);
    });
  });

  describe('tasks: the moves', () => {
    const ALL = ['proposed', 'queued', 'dispatched', 'running', 'submitted', 'checking', 'accepted', 'rejected', 'failed', 'cancelled'];
    const ALLOWED: Record<string, string[]> = {
      proposed: ['queued', 'cancelled'], queued: ['dispatched', 'failed', 'cancelled'], dispatched: ['running', 'submitted', 'failed', 'cancelled'], running: ['submitted', 'failed', 'cancelled'],
      submitted: ['checking', 'failed', 'cancelled'], checking: ['accepted', 'rejected', 'failed', 'cancelled'], accepted: ['rejected'], rejected: ['accepted'], failed: [], cancelled: [],
    };
    /** One task standing at each status. */
    async function atEach(): Promise<Record<string, string>> {
      const at: Record<string, string> = {};
      at.proposed = (await k.task(w.id)).id;
      for (const s of ['queued', 'dispatched', 'submitted', 'checking'] as const) at[s] = (await k.taskAt(s, w)).id;
      at.running = (await k.taskAt('dispatched', w)).id;
      await k.setStatus(app, at.running, 'running');
      at.accepted = (await k.taskAt('checked', w)).id;
      await k.accept(at.accepted);
      at.rejected = (await k.taskAt('checked', w, {}, { met: false })).id;
      await k.setStatus(app, at.rejected, 'rejected');
      at.failed = (await k.taskAt('queued', w)).id;
      await k.setStatus(app, at.failed, 'failed', `, failure = 'error'`);
      at.cancelled = (await k.task(w.id)).id;
      await k.setStatus(app, at.cancelled, 'cancelled');
      return at;
    }

    it('every move that is not on the map is refused, from every status; failed and cancelled are final', async () => {
      const at = await atEach();
      let n = 0;
      for (const from of ALL) {
        for (const to of ALL) {
          if (to === from || ALLOWED[from]!.includes(to)) continue;
          await refused(k.setStatus(app, at[from]!, to), '42501', `task ${at[from]}: ${from} -> ${to} is not allowed`, `${from} -> ${to}`);
          n++;
        }
        // A status that is not one: named only when it is shaped like one.
        await refused(k.setStatus(app, at[from]!, 'paused'), '42501', `task ${at[from]}: ${from} -> paused is not allowed`);
        await refused(k.setStatus(app, at[from]!, `${CANARY} status`), '42501', `task ${at[from]}: ${from} -> ? is not allowed`);
        await refused(app(`UPDATE "Task" SET status = NULL WHERE id = $1`, [at[from]]), '42501', `task ${at[from]}: ${from} -> ? is not allowed`);
        expect(await status(at[from]!), from).toBe(from);
      }
      expect(n).toBe(90 - Object.values(ALLOWED).flat().length);
    });

    it('queued to dispatched needs the asset still on; a task that went out is cancelled only by Will\'s signed card for it', async () => {
      const a = await k.onAsset();
      const t = await k.taskAt('queued', a);
      await k.switchOff(app, a.id);
      await refused(k.setStatus(app, t.id, 'dispatched'), '42501', `task ${t.id}: asset ${a.id} was turned off`);
      await k.turnOn(a);
      await k.setStatus(app, t.id, 'dispatched');

      const signed = `task ${t.id}: a dispatched task is cancelled only by a signed card`;
      await refused(k.setStatus(app, t.id, 'cancelled'), '42501', signed);
      // A cancel card for another task; one for this task that is not executing; one from a job.
      const other = await k.taskAt('queued', a);
      const others = await k.card('task.cancel', { taskId: other.id });
      await refused(k.setStatus(app, t.id, 'cancelled'), '42501', signed);
      await k.card('task.cancel', { taskId: t.id }, { stage: 'approved' });
      await k.card('task.cancel', { taskId: t.id, n: 1 }, { origin: 'runtime:tasks' });
      await k.card('task.cancel', { taskId: t.id, n: 2 }, { tainted: true });
      await refused(k.setStatus(app, t.id, 'cancelled'), '42501', signed);
      const mine = await k.card('task.cancel', { taskId: t.id, n: 3 });
      await k.setStatus(app, t.id, 'cancelled');
      expect([await k.used(mine.aid), await k.used(others.aid)]).toEqual([1, 0]);
      // Each card cancels its own task and no other, though both are still executing.
      await k.setStatus(app, other.id, 'cancelled');
      expect(await k.used(others.aid)).toBe(1);
      const third = await k.taskAt('queued', a);
      await refused(k.setStatus(app, third.id, 'cancelled'), '42501', `task ${third.id}: a dispatched task is cancelled only by a signed card`);
    });

    it('the bar is set once, while the task is being checked, with who checked it (never Will: his is an override)', async () => {
      const early = await k.taskAt('submitted', w);
      await refused(set(app, early.id, `"metBar" = true, "barCheckedBy" = 'flint:rule'`), '42501', `task ${early.id}: its bar is checked while it is being checked`);
      const t = await k.taskAt('checking', w);
      // Accepted or rejected before any check.
      for (const to of ['accepted', 'rejected']) await refused(k.setStatus(app, t.id, to), '42501', `task ${t.id}: it ends accepted or rejected only after its bar was checked`, to);
      // A bar without its checker, a checker without a bar, a checker that is no one Flint knows, and Will as the first checker.
      await refused(set(app, t.id, `"metBar" = true`), '23514', `task ${t.id}: its checker is not valid`);
      await refused(set(app, t.id, `"barCheckedBy" = 'flint:rule'`), '42501', `task ${t.id}: who checked it is set with its bar`);
      await refused(set(app, t.id, `"metBar" = true, "barCheckedBy" = $2`, [`${CANARY} checker`]), '23514', `task ${t.id}: its checker is not valid`);
      await refused(set(app, t.id, `"metBar" = true, "barCheckedBy" = 'will'`), '42501', `task ${t.id}: who checked it is set with its bar`);
      await refused(set(app, t.id, `"metBar" = true, "barCheckedBy" = 'flint:rule', "barEvidence" = '{"a1":true}'`), '23514', `task ${t.id}: its evidence is not valid`);
      await set(app, t.id, `"metBar" = true, "barCheckedBy" = 'flint:rule', "barEvidence" = $2::jsonb`, [JSON.stringify([{ id: 'a1', met: true, note: `${CANARY} evidence` }])]);
      // Once.
      await refused(set(app, t.id, `"metBar" = false`), '42501', `task ${t.id}: metBar is set once`);
      await refused(set(app, t.id, `"metBar" = NULL`), '42501', `task ${t.id}: metBar is set once`);
      await refused(set(app, t.id, `"barCheckedBy" = 'ollama:other'`), '42501', `task ${t.id}: who checked it is set with its bar`);
      await refused(set(app, t.id, `"barCheckedBy" = 'will'`), '42501', `task ${t.id}: who checked it is set with its bar`);
      await refused(set(app, t.id, `"barEvidence" = '[]'`), '42501', `task ${t.id}: its barEvidence is written once`);
    });

    it('accepted needs what the check found, its own successful check on record, and Will\'s signed accept card for this task', async () => {
      const t = await k.taskAt('checked', w);
      const good = await k.proof(t.id);
      const needsCard = `task ${t.id}: accepting it needs Will's signed card for this result until he lets Flint accept on its own`;
      const accept = (auditId: string | null, extra = '') => k.setStatus(app, t.id, 'accepted', `, "acceptedAuditId" = $3${extra}`, [auditId]);
      // On Flint's own word; under another task's accept card; under a cancel card for this task.
      await refused(accept(good), '42501', needsCard);
      const other = await k.taskAt('checked', w);
      const signs = await k.acceptArgs(t.id);
      await k.card('task.check_bar', await k.acceptArgs(other.id), { origin: 'runtime:tasks' });
      await k.card('task.cancel', { taskId: t.id });
      await k.card('task.check_bar', { ...signs, n: 1 }, { origin: 'chat:c1' });
      // A card for this task that does not say what it accepts: no output named, another output, or a bar that was not met.
      await k.card('task.check_bar', { taskId: t.id, metBar: true }, { origin: 'runtime:tasks' });
      await k.card('task.check_bar', { ...signs, outputRef: 'out:another' }, { origin: 'runtime:tasks' });
      await k.card('task.check_bar', { ...signs, metBar: false }, { origin: 'runtime:tasks' });
      await k.card('task.check_bar', { taskId: t.id, outputRef: signs.outputRef }, { origin: 'runtime:tasks' });
      await refused(accept(good), '42501', needsCard);

      const c = await k.card('task.check_bar', signs, { origin: 'runtime:tasks' });
      const onRecord = `task ${t.id}: it is accepted only with its own successful check on record`;
      // No proof, another task's, one that failed, one that is not an action, and an action of another name.
      await refused(accept(null), '42501', onRecord);
      await refused(accept('aunone'), '42501', onRecord);
      await refused(accept(await k.proof(other.id)), '42501', onRecord);
      await refused(accept(await k.proof(t.id, { outcome: 'failed' })), '42501', onRecord);
      await refused(accept(await k.proof(t.id, { kind: 'decision' })), '42501', onRecord);
      await refused(accept(await k.proof(t.id, { action: 'task.dispatch.local_worker' })), '42501', onRecord);
      await refused(accept(await k.proof(t.id, { correlationId: t.id })), '42501', onRecord);
      // Its proof belongs to its acceptance: not attached on the way to any other end.
      await refused(k.setStatus(app, t.id, 'failed', `, failure = 'error', "acceptedAuditId" = $3`, [good]), '42501', `task ${t.id}: its proof is attached when it is accepted`);
      await refused(set(app, t.id, `"acceptedAuditId" = $2`, [good]), '42501', `task ${t.id}: these change only with its status`);
      // Who checked it does not change on the way.
      await refused(accept(good, `, "barCheckedBy" = 'ollama:other'`), '42501', `task ${t.id}: who checked it is set with its bar, or by Will's override`);
      await refused(accept(good, `, "barCheckedBy" = 'will'`), '42501', `task ${t.id}: who checked it is set with its bar, or by Will's override`);
      expect(await k.used(c.aid)).toBe(0);
      await accept(good);
      expect([await status(t.id), await k.used(c.aid)]).toEqual(['accepted', 1]);
      await refused(set(app, t.id, `"acceptedAuditId" = $2`, [await k.proof(t.id)]), '42501', `task ${t.id}: acceptedAuditId is set once`);
      // The card that accepted it accepts nothing else: another task needs its own.
      const third = await k.taskAt('checked', w);
      await refused(k.setStatus(app, third.id, 'accepted', `, "acceptedAuditId" = $3`, [await k.proof(third.id)]), '42501', `task ${third.id}: accepting it needs Will's signed card for this result until he lets Flint accept on its own`);
    });

    it('against the check, either way, needs Will\'s signed override to that status, says it was his, and comes before the forecast is scored', async () => {
      const t = await k.taskAt('checked', w);
      const against = `task ${t.id}: ending it against its check needs Will's signed override`;
      const toRejected = (extra = `, "barCheckedBy" = 'will'`) => k.setStatus(app, t.id, 'rejected', extra);
      // The check passed: rejecting it is not Flint's to do, with or without saying it was Will.
      await refused(toRejected(''), '42501', against);
      await refused(toRejected(), '42501', against);
      // An override card for another task, one that names the other status, an accept card, and one from a job.
      const other = await k.taskAt('checked', w);
      await k.card('task.bar_override', { taskId: other.id, to: 'rejected' });
      const accepting = await k.card('task.bar_override', { taskId: t.id, to: 'accepted' });
      await k.card('task.check_bar', await k.acceptArgs(t.id), { origin: 'runtime:tasks' });
      await k.card('task.bar_override', { taskId: t.id, to: 'rejected', n: 1 }, { origin: 'runtime:tasks' });
      await refused(toRejected(), '42501', against);
      const c = await k.card('task.bar_override', { taskId: t.id, to: 'rejected' });
      // With the card, it still has to say the call was Will's.
      await refused(toRejected(''), '42501', against);
      await refused(toRejected(`, "barCheckedBy" = 'flint:rule'`), '42501', against);
      expect(await k.used(c.aid)).toBe(0);
      await toRejected();
      expect([await status(t.id), await k.used(c.aid), await k.used(accepting.aid)]).toEqual(['rejected', 1, 0]);

      // The card to accept it that was signed before that decision decides nothing now: the later one stands.
      await refused(k.setStatus(app, t.id, 'accepted', `, "acceptedAuditId" = $3`, [await k.proof(t.id, { action: 'task.bar_override' })]), '42501', against);
      // Back to accepted on a card signed since: it needs a check or an override on record, as any acceptance does.
      const back = await k.card('task.bar_override', { taskId: t.id, to: 'accepted', n: 2 });
      await refused(k.setStatus(app, t.id, 'accepted'), '42501', `task ${t.id}: it is accepted only with its own successful check on record`);
      // Once its forecast is scored (a day after it ended, as how it ended), the result is final.
      const f = (await app(`SELECT "predictionId" FROM "Task" WHERE id = $1`, [t.id])).rows[0].predictionId as string;
      await k.endedAgo(t.id);
      await app(`INSERT INTO "Resolution" (id, "predictionId", outcome, "eventAt", "resolvedBy") VALUES ($1, $2, false, now(), 'auto_world')`, [id('rs'), f]);
      await refused(k.setStatus(app, t.id, 'accepted', `, "acceptedAuditId" = $3`, [await k.proof(t.id, { action: 'task.bar_override' })]), '42501', `task ${t.id}: its forecast is already scored`);
      expect([await status(t.id), await k.used(accepting.aid), await k.used(back.aid)]).toEqual(['rejected', 0, 0]);
    });

    it('its forecast is scored only a day after it ended, and as it ended: the runtime cannot score first, early, or otherwise', async () => {
      const score = (taskId: string, outcome: boolean, by = 'auto_world') =>
        app(`INSERT INTO "Resolution" (id, "predictionId", outcome, "eventAt", "resolvedBy") SELECT $1, "predictionId", $3, now(), $4 FROM "Task" WHERE id = $2`, [id('rs'), taskId, outcome, by]);
      const early = (taskId: string) => `task ${taskId}: its forecast is scored a day after it ended as accepted, rejected or failed`;
      const asEnded = (taskId: string) => `task ${taskId}: its forecast's outcome is whether it was accepted`;
      const scored = async (taskId: string) => (await app(`SELECT r.outcome FROM "Resolution" r JOIN "Task" t ON t."predictionId" = r."predictionId" WHERE t.id = $1`, [taskId])).rows[0]?.outcome;
      // Still out, still being checked, and just accepted (the day Will has to overrule it has not passed): not yet.
      const out = await k.taskAt('dispatched', w);
      const checking = await k.taskAt('checked', w);
      const fresh = await k.taskAt('checked', w);
      await k.accept(fresh.id);
      for (const t of [out, checking, fresh]) for (const outcome of [true, false]) await refused(score(t.id, outcome), '42501', early(t.id), `${t.id} ${outcome}`);
      // So his override still lands on what Flint has just accepted.
      await k.card('task.bar_override', { taskId: fresh.id, to: 'rejected' });
      await k.setStatus(app, fresh.id, 'rejected', `, "barCheckedBy" = 'will'`);
      // A day on: scored as it ended, and no other way.
      const accepted = await k.taskAt('checked', w);
      await k.accept(accepted.id);
      const failed = await k.taskAt('dispatched', w);
      await k.setStatus(app, failed.id, 'failed', `, failure = 'timeout'`);
      for (const t of [accepted, fresh, failed]) await k.endedAgo(t.id);
      await refused(score(accepted.id, false), '42501', asEnded(accepted.id));
      await refused(score(fresh.id, true), '42501', asEnded(fresh.id));
      await refused(score(failed.id, true), '42501', asEnded(failed.id));
      await score(accepted.id, true);
      await score(fresh.id, false);
      await score(failed.id, false);
      expect([await scored(accepted.id), await scored(fresh.id), await scored(failed.id)]).toEqual([true, false, false]);
      // A cancelled task's forecast is left to expire, however long ago it was cancelled.
      const cancelled = await k.taskAt('dispatched', w);
      await k.card('task.cancel', { taskId: cancelled.id });
      await k.setStatus(app, cancelled.id, 'cancelled');
      await k.endedAgo(cancelled.id);
      for (const outcome of [true, false]) await refused(score(cancelled.id, outcome), '42501', early(cancelled.id));
      // It is the forecast that says what it is: one of this kind with no task yet is not scored, by any rule or none.
      const resolve = (predictionId: string, q: Q = app) =>
        q(`INSERT INTO "Resolution" (id, "predictionId", outcome, "eventAt", "resolvedBy") VALUES ($1, $2, true, now(), 'auto_world')`, [id('rs'), predictionId]);
      const idle = await k.task(w.id);
      for (const loose of [await k.forecast(), await k.forecast({ taskId: idle.id }), await k.forecast({ taskId: 'tanone' })]) {
        await refused(resolve(loose), '42501', `prediction ${loose}: a task's forecast is scored only for its task`);
        for (const iso of ['REPEATABLE READ', 'SERIALIZABLE']) await refused(k.inTx((q) => resolve(loose, q), { iso }), '40001', `prediction ${loose}: a task's forecast is scored at read committed only`, iso);
      }
      // Nor at any level but READ COMMITTED, even a day after its task ended as it says.
      const done = await k.taskAt('checked', w);
      await k.accept(done.id);
      await k.endedAgo(done.id);
      const doneForecast = (await app(`SELECT "predictionId" FROM "Task" WHERE id = $1`, [done.id])).rows[0].predictionId as string;
      for (const iso of ['REPEATABLE READ', 'SERIALIZABLE']) await refused(k.inTx((q) => resolve(doneForecast, q), { iso }), '40001', `prediction ${doneForecast}: a task's forecast is scored at read committed only`, iso);
      await score(done.id, true);
      // A prediction that is not there is not scored (and its id is repeated only when it is shaped like one).
      await refused(resolve('pdnone'), '23514', 'resolution: there is no prediction pdnone to score');
      await refused(resolve(`${CANARY} id`), '23514', 'resolution: there is no prediction ? to score');
      // Any other prediction is the ledger's own business, as before, at any level.
      const others = await k.forecast({ domain: 'services', type: 'event_occurs', createdBy: 'client:server' });
      await k.inTx((q) => resolve(others, q), { iso: 'REPEATABLE READ' });
      expect((await app(`SELECT status FROM "Prediction" WHERE id = $1`, [others])).rows[0].status).toBe('resolved');
    });

    it('is checked and accepted only with its result on record, under the reference that names it', async () => {
      const onRecord = (taskId: string) => `task ${taskId}: it is checked and accepted only with its result on record`;
      const digest = k.outputDigest();
      const handIn = (taskId: string, ref: string, output = true) => k.inTx(async (q) => {
        if (output) await k.putOutput(q, taskId);
        await k.setStatus(q, taskId, 'submitted', `, "outputRef" = $3`, [ref]);
      });
      // Handed in with a reference and nothing behind it: never checked.
      const bare = await k.taskAt('dispatched', w);
      await handIn(bare.id, `out:${digest.slice(0, 12)}`, false);
      await refused(k.setStatus(app, bare.id, 'checking'), '42501', onRecord(bare.id));
      // With an output the reference does not name: another digest, too short a start of it, more than all of it, or another kind of reference.
      for (const ref of ['out:000000000000', `out:${digest.slice(0, 11)}`, `out:${digest}0`, `job:${digest.slice(0, 12)}`]) {
        const t = await k.taskAt('dispatched', w);
        await handIn(t.id, ref);
        await refused(k.setStatus(app, t.id, 'checking'), '42501', onRecord(t.id), ref);
        expect(await status(t.id), ref).toBe('submitted');
      }
      // Any start of it, of 12 characters or more, names it.
      for (const n of [12, 16, 64]) {
        const t = await k.taskAt('dispatched', w);
        await handIn(t.id, `out:${digest.slice(0, n)}`);
        await k.setStatus(app, t.id, 'checking');
        expect(await status(t.id), String(n)).toBe('checking');
      }
      // An override to accepted once the output is gone (retention may take it when the task has ended): there is nothing left to accept.
      const gone = await k.taskAt('checked', w, {}, { met: false });
      await k.setStatus(app, gone.id, 'rejected');
      await app(`DELETE FROM "TaskOutput" WHERE "taskId" = $1`, [gone.id]);
      await k.card('task.bar_override', { taskId: gone.id, to: 'accepted' });
      await refused(k.setStatus(app, gone.id, 'accepted', `, "barCheckedBy" = 'will', "acceptedAuditId" = $3`, [await k.proof(gone.id, { action: 'task.bar_override' })]), '42501', onRecord(gone.id));
      expect(await status(gone.id)).toBe('rejected');
    });

    it('the times are the database\'s: nobody sets when it went out, when it was handed in or when it ended', async () => {
      // (flint_app has no grant on any of the three columns; these are the owner's own attempts.)
      const idle = await k.task(w.id);
      await refused(set(owner, idle.id, `"dispatchedAt" = now()`), '42501', `task ${idle.id}: these change only with its status`);
      await refused(set(owner, idle.id, `"submittedAt" = now()`), '42501', `task ${idle.id}: these change only with its status`);
      await refused(set(owner, idle.id, `"completedAt" = now()`), '42501', `task ${idle.id}: these change only with its status`);
      await refused(set(owner, idle.id, `status = 'cancelled', "dispatchedAt" = now()`), '42501', `task ${idle.id}: dispatchedAt is set when it is dispatched`);
      await refused(set(owner, idle.id, `status = 'cancelled', "submittedAt" = now()`), '42501', `task ${idle.id}: submittedAt is set when it is handed in`);
      await refused(k.task(w.id, { submittedAt: '2020-01-01' }, owner), '42501', /^task \w+: a task starts proposed, with its spec, its bar and its estimate, and nothing else set$/);
      const q = await k.taskAt('queued', w);
      await refused(set(owner, q.id, `status = 'dispatched', "completedAt" = now()`), '42501', `task ${q.id}: completedAt is set when it ends`);
      // Sent with the move, they are overwritten by the wall clock.
      await set(owner, q.id, `status = 'dispatched', "dispatchedAt" = '2020-01-01'`);
      expect((await app(`SELECT "submittedAt" FROM "Task" WHERE id = $1`, [q.id])).rows[0].submittedAt).toBeNull();
      await set(owner, q.id, `status = 'submitted', "outputRef" = 'out:abc', "submittedAt" = '2020-01-01'`);
      await set(owner, q.id, `status = 'failed', failure = 'error', "completedAt" = '2020-01-01'`);
      const times = (await app(`SELECT "dispatchedAt", "submittedAt", "completedAt" FROM "Task" WHERE id = $1`, [q.id])).rows[0];
      for (const at of [times.dispatchedAt, times.submittedAt, times.completedAt]) expect(Date.now() - new Date(at).getTime()).toBeLessThan(60_000);
      // When it was handed in does not move afterwards, with its status or without.
      await refused(set(owner, q.id, `"submittedAt" = now()`), '42501', `task ${q.id}: these change only with its status`);
      const sub = await k.taskAt('submitted', w);
      await refused(set(owner, sub.id, `status = 'checking', "submittedAt" = now()`), '42501', `task ${sub.id}: submittedAt is set when it is handed in`);
      // When it ended is set once: an override moves the result, not the time.
      const t = await k.taskAt('checked', w);
      await k.accept(t.id);
      await k.card('task.bar_override', { taskId: t.id, to: 'rejected' });
      await refused(set(owner, t.id, `status = 'rejected', "barCheckedBy" = 'will', "completedAt" = now()`), '42501', `task ${t.id}: completedAt is set once, when it ends`);
    });
  });

  describe('tasks: what never changes, what is written once, and its own rules', () => {
    it('what a task is never changes, and it is never deleted', async () => {
      const t = await k.task(w.id);
      const goal = (await k.goalWithPlan({ s1: 'asset_task' })).gid;
      const other = await k.asset();
      for (const [col, value] of [
        ['id', id('ta')], ['assetId', other.id], ['goalId', goal], ['stepKey', 's1'], ['title', 'Synthetic retitled'], ['origin', 'flint'], ['sensitivity', 'personal'], ['tainted', true],
        ['entityIds', '{en1}'], ['estCostUsd', 1], ['dueAt', '2027-01-01'], ['createdAt', '2020-01-01'],
      ] as const) await refused(owner(`UPDATE "Task" SET "${col}" = $2 WHERE id = $1`, [t.id, value]), '42501', `task ${t.id}: ${col} never changes`, col);
      await refused(owner(`DELETE FROM "Task" WHERE id = $1`, [t.id]), '42501', 'tasks are never deleted (a task is cancelled)');
      await refused(owner(`TRUNCATE "Task" CASCADE`), '42501', 'tasks are never deleted (a task is cancelled)');
    });

    it('its spec and bar never change; its summary and evidence are written once; all are cleared only once it has ended', async () => {
      const t = await k.taskAt('checked', w);
      await refused(set(app, t.id, `spec = $2::jsonb`, [JSON.stringify({ template: 'sort_items', params: { note: `${CANARY} new spec` } })]), '42501', `task ${t.id}: its spec is written once`);
      await refused(set(app, t.id, `acceptance = $2::jsonb`, [JSON.stringify([{ id: 'a9', text: `${CANARY} easier bar` }])]), '42501', `task ${t.id}: its acceptance is written once`);
      await refused(set(app, t.id, `"outputSummary" = $2`, [`${CANARY} rewritten`]), '42501', `task ${t.id}: its outputSummary is written once`);
      // The summary belongs to the result as it is handed in, the evidence to the check as it is made: neither is written at another step.
      const out = await k.taskAt('dispatched', w);
      await refused(set(app, out.id, `"outputSummary" = $2`, [`${CANARY} early summary`]), '42501', `task ${out.id}: its outputSummary is written at its own step`);
      await refused(set(app, out.id, `"barEvidence" = '[]'`), '42501', `task ${out.id}: its barEvidence is written at its own step`);
      const idle = await k.task(w.id);
      await refused(set(app, idle.id, `"outputSummary" = $2`, [`${CANARY} early summary`]), '42501', `task ${idle.id}: its outputSummary is written at its own step`);
      const handedIn = await k.taskAt('submitted', w);
      await refused(set(app, handedIn.id, `"barEvidence" = '[]'`), '42501', `task ${handedIn.id}: its barEvidence is written at its own step`);
      const late = await k.taskAt('checking', w, {});
      await set(app, late.id, `"metBar" = false, "barCheckedBy" = 'flint:rule'`);
      await k.setStatus(app, late.id, 'rejected');
      await refused(set(app, late.id, `"barEvidence" = '[]'`), '42501', `task ${late.id}: its barEvidence is written at its own step`);
      // Cleared while it is still live: refused, with or without the purge mark.
      for (const col of ['spec', 'acceptance', 'outputSummary', 'barEvidence']) {
        await refused(set(app, t.id, `"${col}" = NULL`), '42501', `task ${t.id}: its ${col} is cleared only once it has ended`, col);
        await refused(set(app, t.id, `"${col}" = NULL, "textPurgedAt" = now()`), '42501', `task ${t.id}: its ${col} is cleared only once it has ended`, col);
      }
      await refused(set(app, t.id, `"textPurgedAt" = now()`), '42501', `task ${t.id}: it is marked as cleared only once it has ended`);
      // Ended: cleared with the purge mark, never without it, and the mark is set once.
      await k.accept(t.id);
      await refused(set(app, t.id, `spec = NULL`), '42501', `task ${t.id}: its spec is cleared only once it has ended`);
      await set(app, t.id, `spec = NULL, acceptance = NULL, "outputSummary" = NULL, "barEvidence" = NULL, "textPurgedAt" = now()`);
      await refused(set(app, t.id, `"textPurgedAt" = now() + interval '1 day'`), '42501', `task ${t.id}: textPurgedAt is set once`);
      // Nothing is written back once its text was cleared.
      await refused(set(app, t.id, `"outputSummary" = $2`, [`${CANARY} back again`]), '42501', `task ${t.id}: its outputSummary is written once`);
      await refused(set(app, t.id, `"barEvidence" = '[]'`), '42501', `task ${t.id}: its barEvidence is written once`);
    });

    it('its approval, job, output reference, forecast and failure are each set once, and its attempts only go up', async () => {
      const t = await k.taskAt('queued', w);
      await refused(set(app, t.id, `"dispatchApprovalId" = 'approther'`), '42501', `task ${t.id}: dispatchApprovalId is set once`);
      await refused(set(app, t.id, `"predictionId" = $2`, [await k.forecast()]), '42501', `task ${t.id}: predictionId is set once`);
      await k.setStatus(app, t.id, 'dispatched', `, "externalJobId" = 'job:1', attempts = 2`);
      await refused(set(app, t.id, `"externalJobId" = 'job:2'`), '42501', `task ${t.id}: externalJobId is set once`);
      await refused(set(app, t.id, `attempts = 1`), '42501', `task ${t.id}: its attempts only go up`);
      await refused(set(app, t.id, `attempts = 101`), '23514', `task ${t.id}: its attempts is not valid`);
      await refused(set(app, t.id, `"externalJobId" = NULL`), '42501', `task ${t.id}: externalJobId is set once`);
      // A failure is said when it fails, as one of the known classes, and only then.
      await refused(set(app, t.id, `failure = 'error'`), '42501', `task ${t.id}: these change only with its status`);
      await refused(k.setStatus(app, t.id, 'running', `, failure = 'error'`), '23514', `task ${t.id}: its failure is not valid`);
      await refused(k.setStatus(app, t.id, 'failed'), '23514', `task ${t.id}: a failed task says why`);
      await refused(k.setStatus(app, t.id, 'failed', `, failure = $3`, [`${CANARY} the model said no`]), '23514', `task ${t.id}: its failure is not valid`);
      // Handing in needs a reference to the output, shaped like one.
      await refused(k.setStatus(app, t.id, 'submitted'), '23514', `task ${t.id}: its output is not valid`);
      await refused(k.setStatus(app, t.id, 'submitted', `, "outputRef" = $3`, [`${CANARY} see above`]), '23514', `task ${t.id}: its references is not valid`);
      await refused(k.setStatus(app, t.id, 'submitted', `, "outputRef" = 'out:abc', "outputSummary" = $3`, [`${CANARY} `.repeat(60)]), '23514', `task ${t.id}: its summary is not valid`);
      await k.setStatus(app, t.id, 'submitted', `, "outputRef" = 'out:abc'`);
      await refused(set(app, t.id, `"outputRef" = 'out:def'`), '42501', `task ${t.id}: outputRef is set once`);
      await k.setStatus(app, t.id, 'failed', `, failure = 'invalid'`);
      await refused(set(app, t.id, `failure = 'timeout'`), '42501', `task ${t.id}: failure is set once`);
      // A proposed task that is cancelled takes no approval and no forecast with it.
      const idle = await k.task(w.id);
      await refused(k.setStatus(app, idle.id, 'cancelled', `, "dispatchApprovalId" = 'apprx'`), '42501', `task ${idle.id}: its approval and forecast are set when it is dispatched`);
      await refused(set(app, idle.id, `"predictionId" = $2`, [await k.forecast()]), '42501', `task ${idle.id}: these change only with its status`);
    });

    it('a forget clears a task\'s text and changes nothing else', async () => {
      const t = await k.taskAt('checked', w);
      const forgetting = (sets: string) => k.inTx(async (q) => {
        await q(`SELECT set_config('flint.forget_approval', 'apprforget', true)`);
        await q(`UPDATE "Task" SET ${sets} WHERE id = $1`, [t.id]);
      }, { url: k.urls.owner, commit: false });
      await refused(forgetting(`attempts = 9`), '42501', `task ${t.id}: a forget only clears text`);
      await refused(forgetting(`status = 'cancelled'`), '42501', `task ${t.id}: a forget only clears text`);
      await refused(forgetting(`"metBar" = false`), '42501', `task ${t.id}: a forget only clears text`);
      await refused(forgetting(`"outputSummary" = 'Synthetic rewritten'`), '42501', `task ${t.id}: its outputSummary is written once`);
      await refused(forgetting(`spec = NULL`), '42501', `task ${t.id}: its spec is cleared only once it has ended`);
      expect(await k.outcome(forgetting(`spec = NULL, acceptance = NULL, "outputSummary" = NULL, "barEvidence" = NULL, "textPurgedAt" = now()`))).toBe('ok');
    });

    it('a forget runs at READ COMMITTED, blanks the task\'s own forecast, and a card it emptied takes no result when it finishes', async () => {
      const e = await k.entity();
      const t = await k.task(w.id, { entityIds: [e] });
      // The task's dispatch card is still running when the item is forgotten; so are a cancel card of the task's and a card of another kind that names the item.
      const d = await k.dispatch(t, w);
      const cancel = await k.card('task.cancel', { taskId: t.id });
      const note = await k.card('mcp:notes.write', { entityId: e, note: `${CANARY} words` }, { kind: 'tool_call' });
      const running = await k.card(w.dispatchAction, { ...k.dispatchArgs(t, w.kind), n: 1 });
      const aid = await k.approval(e, 'world.forget', HEX('a'), { subjectType: 'forget' });
      for (const iso of ['REPEATABLE READ', 'SERIALIZABLE']) {
        await refused(k.inTx((q) => q(`SELECT forget_entity($1, $2)`, [e, aid]), { iso }), '40001', `entity ${e}: it is forgotten at read committed only`, iso);
      }
      expect((await app(`SELECT status FROM "Entity" WHERE id = $1`, [e])).rows[0].status).not.toBe('forgotten');
      await app(`SELECT forget_entity($1, $2)`, [e, aid]);
      // Its forecast keeps its number and loses its words and its rule, as a forgotten item's own forecasts do.
      expect((await app(`SELECT claim, evidence, "resolutionCriteria", "resolverSpec", probability, status FROM "Prediction" WHERE id = $1`, [d.predictionId])).rows[0])
        .toEqual({ claim: '[forgotten]', evidence: [], resolutionCriteria: '[forgotten]', resolverSpec: null, probability: 0.5, status: 'open' });
      // A card of the task's finishes with no result (it may still end, and say why it failed) ...
      const done = (pid: string, result: unknown) => app(`UPDATE "Proposal" SET status = 'executed', "executedAt" = now(), result = $2::jsonb WHERE id = $1`, [pid, result === null ? null : JSON.stringify(result)]);
      for (const c of [running, cancel]) {
        expect((await app(`SELECT args IS NULL AS emptied, status FROM "Proposal" WHERE id = $1`, [c.pid])).rows[0], c.pid).toEqual({ emptied: true, status: 'executing' });
        await refused(done(c.pid, { summary: `${CANARY} what it did` }), '42501', `proposal ${c.pid}: its args were cleared, so it takes no result`);
      }
      await done(running.pid, null);
      await app(`UPDATE "Proposal" SET status = 'failed', "executedAt" = now(), error = 'Synthetic: the item was forgotten.' WHERE id = $1`, [cancel.pid]);
      // ... while a card of another kind is the ledger's own business, as before.
      await done(note.pid, { ok: true });
    });
  });

  describe('a task\'s output', () => {
    it('is written once, while the task is out, always as outside text, and kept until the task has ended; its rules name the task only', async () => {
      const body = { headline: `${CANARY} output` };
      const put = (taskId: unknown, over: { body?: string | null; sha?: string | null; tainted?: boolean | null } = {}, q: Q = app) =>
        q(`INSERT INTO "TaskOutput" ("taskId", body, sha256, tainted) VALUES ($1, $2::jsonb, $3, $4)`,
          [taskId, over.body === undefined ? JSON.stringify(body) : over.body, over.sha === undefined ? digestOf(body) : over.sha, over.tainted === undefined ? true : over.tainted]);
      await refused(put(null), '23514', `task output: the id of its task is not valid`);
      await refused(put(`${CANARY} task`), '23514', `task output: the id of its task is not valid`);
      // Only while it is out: not before, not once handed in, and not for a task that is not there.
      const out = `output is taken only while it is out`;
      await refused(put('tanone'), '42501', `task tanone: ${out}`);
      for (const at of ['queued', 'checking'] as const) {
        const t = await k.taskAt(at, w);
        await refused(put(t.id), '42501', `task ${t.id}: ${out}`, at);
      }
      const idle = await k.task(w.id);
      await refused(put(idle.id), '42501', `task ${idle.id}: ${out}`);

      const t = await k.taskAt('dispatched', w);
      const invalid = (rule: string) => `task ${t.id}: the ${rule} of its output is not valid`;
      await refused(put(t.id, { body: null }), '23514', invalid('body'));
      await refused(put(t.id, { body: JSON.stringify([body]) }), '23514', invalid('body'));
      await refused(put(t.id, { body: JSON.stringify(`${CANARY} just text`) }), '23514', invalid('body'));
      await refused(put(t.id, { body: 'null' }), '23514', invalid('body'));
      await refused(put(t.id, { body: JSON.stringify({ pad: `${CANARY} `.repeat(2400) }) }), '23514', invalid('size'));
      await refused(put(t.id, { sha: null }), '23514', invalid('digest'));
      await refused(put(t.id, { sha: `${CANARY} digest` }), '23514', invalid('digest'));
      // A model wrote it: it is never marked as anything but outside text.
      await refused(put(t.id, { tainted: false }), '23514', invalid('taint'));
      await refused(put(t.id, { tainted: null }), '23514', invalid('taint'));
      await put(t.id);
      // Once: no second one, no update (flint_app has no grant to try; the owner is refused by the guard), no truncate.
      expect(await k.code(put(t.id))).toBe('23505');
      await refused(owner(`UPDATE "TaskOutput" SET body = '{}' WHERE "taskId" = $1`, [t.id]), '42501', `a task's output is written once`);
      await refused(owner(`TRUNCATE "TaskOutput"`), '42501', `a task's output is written once`);
      // Kept until the task has ended.
      const kept = `task ${t.id}: its output is kept until it has ended`;
      await refused(app(`DELETE FROM "TaskOutput" WHERE "taskId" = $1`, [t.id]), '42501', kept);
      await k.setStatus(app, t.id, 'submitted', `, "outputRef" = 'out:abc'`);
      await refused(app(`DELETE FROM "TaskOutput" WHERE "taskId" = $1`, [t.id]), '42501', kept);
      await k.setStatus(app, t.id, 'failed', `, failure = 'invalid'`);
      await app(`DELETE FROM "TaskOutput" WHERE "taskId" = $1`, [t.id]);
      // A task whose text a forget cleared takes no output afterwards: nothing is written back.
      const item = await k.entity();
      const about = await k.taskAt('dispatched', w, { entityIds: [item] });
      await k.forget(item);
      await refused(put(about.id), '42501', `task ${about.id}: its text was cleared, so no output is taken`);
    });
  });

  describe('reviews', () => {
    let reviewer: AssetRow;
    beforeAll(async () => {
      reviewer = await k.reviewer();
    });
    afterAll(async () => {
      await k.switchOff(app, reviewer.id);
    });

    it('one is written only of a card still waiting, by its args\' digest, at least as tainted and exactly as sensitive; or of a task\'s output as it is checked', async () => {
      const { pid, digest } = await k.file('mcp:web.fetch_url', { url: 'https://example.com/', note: `${CANARY} args` }, { kind: 'tool_call', origin: 'chat:c1', tainted: true, sensitivity: 'personal' });
      const of = (over: Record<string, unknown> = {}) => k.review({ subjectId: pid, subjectDigest: digest, tainted: true, sensitivity: 'personal', ...over });
      // A review needs its reviewer: with none on, none is taken (a worker is not one); and none from the paid panel at all.
      await k.switchOff(app, reviewer.id);
      const none = id('rv');
      await refused(of({ id: none }), '42501', `review ${none}: no reviewer is on`);
      reviewer = await k.reviewer();
      await refused(of({ id: none, engine: 'trident_panel', costUsd: 0.4 }), '42501', `review ${none}: no paid review is taken yet`);
      await refused(of({ id: none, engine: 'trident_panel' }), '42501', `review ${none}: no paid review is taken yet`);
      await refused(of({ id: `${CANARY} id` }), '23514', `review: its id or its subject's is not valid`);
      await refused(of({ subjectId: `${CANARY} subject` }), '23514', `review: its id or its subject's is not valid`);
      await refused(of({ subjectId: null }), '23514', `review: its id or its subject's is not valid`);
      const rid = id('rv');
      await refused(of({ id: rid, textPurgedAt: '2026-01-01' }), '42501', `review ${rid}: these are set later`);
      await refused(of({ id: rid, overridePredictionId: 'pd1' }), '42501', `review ${rid}: these are set later`);
      const notOf = `review ${rid}: it is not of card ${pid} as it waits`;
      await refused(of({ id: rid, subjectDigest: digestOf({ other: 'args' }) }), '42501', notOf);
      await refused(of({ id: rid, subjectDigest: null }), '42501', notOf);
      await refused(of({ id: rid, tainted: false }), '42501', notOf);
      await refused(of({ id: rid, sensitivity: 'ops' }), '42501', notOf);
      await refused(of({ id: rid, sensitivity: 'financial' }), '42501', notOf);
      await refused(of({ id: rid, subjectId: 'propnone' }), '42501', `review ${rid}: it is not of card propnone as it waits`);
      // Nothing else has a reviewer yet.
      for (const subjectType of ['recommendation', 'change_request', 'goal', `${CANARY} type`, null]) await refused(of({ id: rid, subjectType }), '42501', `review ${rid}: nothing reviews that kind of subject yet`, String(subjectType));
      // A card that is no longer waiting: approved, rejected or expired.
      await of({ id: rid });
      await k.approve(app, pid, await k.approval(pid, 'mcp:web.fetch_url', digest));
      await refused(of({ id: id('rv') }), '42501', /^review \w+: it is not of card \w+ as it waits$/);
      const gone = await k.file('mcp:web.fetch_url', { url: 'https://example.org/' }, { kind: 'tool_call', origin: 'chat:c1' });
      await app(`UPDATE "Proposal" SET status = 'rejected' WHERE id = $1`, [gone.pid]);
      await refused(k.review({ subjectId: gone.pid, subjectDigest: gone.digest }), '42501', /^review \w+: it is not of card \w+ as it waits$/);
      // A more tainted review of an untainted card is fine: the review read more than the card holds.
      const clean = await k.file('mcp:notes.update', { text: 'Synthetic' }, { kind: 'tool_call', origin: 'chat:c1' });
      await k.review({ subjectId: clean.pid, subjectDigest: clean.digest, tainted: true });

      // A task's output, as it is checked.
      const t = await k.taskAt('checking', w, { sensitivity: 'personal' });
      const ofTask = (over: Record<string, unknown> = {}) => k.review({ id: rid, subjectType: 'task', subjectId: t.id, subjectDigest: k.outputDigest(), tainted: true, sensitivity: 'personal', ...over });
      const notOfTask = `review ${rid}: it is not of task ${t.id}'s output as it is checked`;
      await refused(ofTask({ subjectDigest: digestOf({ other: 'output' }) }), '42501', notOfTask);
      await refused(ofTask({ tainted: false }), '42501', notOfTask);
      await refused(ofTask({ sensitivity: 'ops' }), '42501', notOfTask);
      const early = await k.taskAt('submitted', w);
      await refused(k.review({ id: rid, subjectType: 'task', subjectId: early.id, subjectDigest: k.outputDigest(), tainted: true }), '42501', `review ${rid}: it is not of task ${early.id}'s output as it is checked`);
      // A card's digest is not a task's output: a task review needs the output's own.
      await refused(ofTask({ subjectId: pid }), '42501', `review ${rid}: it is not of task ${pid}'s output as it is checked`);
      expect(await k.outcome(ofTask({ id: id('rv') }))).toBe('ok');
      // Nothing is left to review once a forget cleared it: not a waiting card's args, not a task's result.
      const item = await k.entity();
      const emptied = await k.file('mcp:notes.update', { entityId: item, text: `${CANARY} args` }, { kind: 'tool_call', origin: 'console' });
      const about = await k.taskAt('checking', w, { entityIds: [item] });
      await k.forget(item);
      await refused(k.review({ id: rid, subjectId: emptied.pid, subjectDigest: emptied.digest }), '42501', `review ${rid}: card ${emptied.pid} has no args left to review`);
      await refused(k.review({ id: rid, subjectType: 'task', subjectId: about.id, subjectDigest: k.outputDigest(), tainted: true }), '42501', `review ${rid}: it is not of task ${about.id}'s output as it is checked`);
    });

    it('its own rules name the rule, never what it holds', async () => {
      const { pid, digest } = await k.file('mcp:notes.update', { text: 'Synthetic' }, { kind: 'tool_call', origin: 'chat:c1' });
      const rid = id('rv');
      const of = (over: Record<string, unknown>) => k.review({ id: rid, subjectId: pid, subjectDigest: digest, ...over });
      for (const [rule, over] of [
        ['a required field', { agreed: null }], ['a required field', { shadow: null }], ['engine', { engine: 'gpt_panel' }], ['engine', { engine: null }],
        ['verdict', { verdict: 'fine' }], ['verdict', { verdict: `${CANARY} verdict` }], ['verdict', { verdict: null }],
        ['confidence', { confidence: 1.5 }], ['confidence', { confidence: -0.1 }], ['confidence', { confidence: 'NaN' }], ['confidence', { confidence: null }],
        ['models', { models: ['ollama:test'] }], ['models', { models: { judge: `${CANARY} `.repeat(80) } }], ['models', { models: null }],
        ['findings', { findings: { code: 'outside_text' } }], ['findings', { findings: [`${CANARY} `.repeat(300)] }],
        ['reason codes', { reasonCodes: [`${CANARY} reason`] }], ['reason codes', { reasonCodes: Array.from({ length: 9 }, (_, i) => `c${i}`) }], ['reason codes', { reasonCodes: null }],
        ['words', { attack: `${CANARY} `.repeat(120) }], ['words', { defense: `${CANARY} `.repeat(120) }], ['words', { verdictReason: `${CANARY} `.repeat(30) }],
        // The local engine is free, and no paid review is taken yet: no review carries a cost.
        ['cost', { costUsd: 0.02 }], ['cost', { costUsd: -1 }],
        ['time', { modelMs: -5 }],
      ] as const) await refused(of(over), '23514', `review ${rid}: its ${rule} is not valid`, `${rule} ${JSON.stringify(over).slice(0, 40)}`);
      expect(await k.outcome(of({ costUsd: 0 }))).toBe('ok');
      // (Its id, subject, digest and sensitivity are held first by the check on what it reviews, in the test above.)
    });

    it('what one found never changes and it is never deleted; its words are cleared, never rewritten; an override\'s forecast is attached once, to a block Will approved past', async () => {
      const { pid, digest } = await k.file('mcp:web.fetch_url', { url: 'https://example.com/b' }, { kind: 'tool_call', origin: 'chat:c1', tainted: true });
      const rid = await k.reviewed(pid, { verdict: 'block', reasonCodes: ['sends_off_box'] });
      for (const [col, value] of [
        ['verdict', 'proceed'], ['subjectId', 'propother'], ['subjectDigest', HEX('b')], ['subjectType', 'task'], ['engine', 'trident_panel'], ['confidence', 0.1], ['agreed', false], ['shadow', false],
        ['tainted', false], ['sensitivity', 'personal'], ['reasonCodes', '{none}'], ['findings', '["x"]'], ['models', '{}'], ['modelMs', 1], ['costUsd', 0], ['createdAt', '2020-01-01'], ['id', id('rv')],
      ] as const) await refused(owner(`UPDATE "Review" SET "${col}" = $2 WHERE id = $1`, [rid, value]), '42501', `review ${rid}: what it found never changes`, col);
      await refused(owner(`DELETE FROM "Review" WHERE id = $1`, [rid]), '42501', 'reviews are never deleted');
      await refused(owner(`TRUNCATE "Review" CASCADE`), '42501', 'reviews are never deleted');
      const cleared = `review ${rid}: its words may only be cleared`;
      for (const col of ['attack', 'defense', 'verdictReason']) {
        await refused(app(`UPDATE "Review" SET "${col}" = $2 WHERE id = $1`, [rid, `${CANARY} nothing to see`]), '42501', cleared, col);
        await refused(app(`UPDATE "Review" SET "${col}" = $2, "textPurgedAt" = now() WHERE id = $1`, [rid, `${CANARY} nothing to see`]), '42501', cleared, col);
        // Cleared without the purge mark: refused.
        await refused(app(`UPDATE "Review" SET "${col}" = NULL WHERE id = $1`, [rid]), '42501', cleared, col);
      }
      // While its card still waits for Will, its words stay, purge mark or not: a block's case is there when he decides.
      const kept = `review ${rid}: its words are kept while what it reviews still waits`;
      await refused(app(`UPDATE "Review" SET attack = NULL, defense = NULL, "verdictReason" = NULL, "textPurgedAt" = now() WHERE id = $1`, [rid]), '42501', kept);
      await refused(app(`UPDATE "Review" SET "verdictReason" = NULL, "textPurgedAt" = now() WHERE id = $1`, [rid]), '42501', kept);
      await refused(app(`UPDATE "Review" SET "textPurgedAt" = now() WHERE id = $1`, [rid]), '42501', kept);
      // The same for a task's review while the task is being checked.
      const checking = await k.taskAt('checking', w);
      const ofTask = await k.review({ subjectType: 'task', subjectId: checking.id, subjectDigest: k.outputDigest(), tainted: true });
      await refused(app(`UPDATE "Review" SET attack = NULL, "textPurgedAt" = now() WHERE id = $1`, [ofTask]), '42501', `review ${ofTask}: its words are kept while what it reviews still waits`);
      await set(app, checking.id, `"metBar" = false, "barCheckedBy" = 'flint:rule'`);
      await k.setStatus(app, checking.id, 'rejected');
      await app(`UPDATE "Review" SET attack = NULL, "textPurgedAt" = now() WHERE id = $1`, [ofTask]);

      // The override's forecast: only once Will has approved the card, with this review on it.
      const attached = `review ${rid}: an override's forecast is attached once, to a block Will approved past`;
      const f = await k.forecast({ type: 'effect_given_accept', method: 'model_reasoning', resolver: 'will', createdBy: 'runtime:reviews' });
      const attach = (reviewId: string, forecastId: string | null) => app(`UPDATE "Review" SET "overridePredictionId" = $2 WHERE id = $1`, [reviewId, forecastId]);
      await refused(attach(rid, f), '42501', attached);
      await k.approve(app, pid, await k.approval(pid, 'mcp:web.fetch_url', digest));
      // A forecast of another kind, from another writer, or one that is not there.
      await refused(attach(rid, await k.forecast()), '42501', attached);
      await refused(attach(rid, await k.forecast({ type: 'effect_given_accept', createdBy: 'client:server' })), '42501', attached);
      await refused(attach(rid, await k.forecast({ type: 'effect_given_accept', domain: 'goals', createdBy: 'runtime:reviews' })), '42501', attached);
      await refused(attach(rid, 'pdnone'), '42501', attached);
      await attach(rid, f);
      await refused(attach(rid, await k.forecast({ type: 'effect_given_accept', createdBy: 'runtime:reviews' })), '42501', attached);
      await refused(attach(rid, null), '42501', attached);

      // Never to a review that did not block, to one of a card Will rejected, or to one that is not the card's own.
      const again = (verdict: string) => k.file('mcp:web.fetch_url', { url: `https://example.com/${id('u')}` }, { kind: 'tool_call', origin: 'chat:c1', tainted: true }).then(async (c) => ({ ...c, rid: await k.reviewed(c.pid, { verdict }) }));
      const passed = await again('proceed');
      await k.approve(app, passed.pid, await k.approval(passed.pid, 'mcp:web.fetch_url', passed.digest));
      const g = () => k.forecast({ type: 'effect_given_accept', createdBy: 'runtime:reviews' });
      await refused(attach(passed.rid, await g()), '42501', /an override's forecast is attached once/);
      const refusedByWill = await again('block');
      await app(`UPDATE "Proposal" SET status = 'rejected', "approvalId" = $2 WHERE id = $1`, [refusedByWill.pid, await k.approval(refusedByWill.pid, 'mcp:web.fetch_url', refusedByWill.digest, { decision: 'reject' })]);
      await refused(attach(refusedByWill.rid, await g()), '42501', /an override's forecast is attached once/);
      const loose = await k.file('mcp:web.fetch_url', { url: 'https://example.com/loose' }, { kind: 'tool_call', origin: 'chat:c1', tainted: true });
      const second = await k.reviewed(loose.pid, { verdict: 'block' }, false);
      await k.reviewed(loose.pid, { verdict: 'proceed' });
      await k.approve(app, loose.pid, await k.approval(loose.pid, 'mcp:web.fetch_url', loose.digest));
      await refused(attach(second, await g()), '42501', /an override's forecast is attached once/);

      // Retention: cleared with the purge mark, once.
      await app(`UPDATE "Review" SET attack = NULL, defense = NULL, "verdictReason" = NULL, "textPurgedAt" = now() WHERE id = $1`, [rid]);
      await refused(app(`UPDATE "Review" SET "textPurgedAt" = now() + interval '1 day' WHERE id = $1`, [rid]), '42501', `review ${rid}: its text is cleared once`);
      await refused(app(`UPDATE "Review" SET "textPurgedAt" = NULL WHERE id = $1`, [rid]), '42501', `review ${rid}: its text is cleared once`);
      await refused(app(`UPDATE "Review" SET attack = $2 WHERE id = $1`, [rid, `${CANARY} back again`]), '42501', cleared);
    });
  });

  describe('the review gate, and the cards that need a review', () => {
    it('the gate is one row that stays, and changes only as Will\'s executing review.enforce card says, with a reviewer on', async () => {
      await refused(owner(`INSERT INTO "ReviewGate" (id, enforced) VALUES ('proposal', true)`), '42501', 'the review gate is one row, and stays');
      await refused(owner(`DELETE FROM "ReviewGate"`), '42501', 'the review gate is one row, and stays');
      await refused(owner(`TRUNCATE "ReviewGate"`), '42501', 'the review gate is one row, and stays');
      // (The owner may not add a second row either: the first holds the only id there is.)
      expect(await k.code(owner(`INSERT INTO "ReviewGate" (id) VALUES ('proposal')`))).toBe('23505');
      expect(await k.code(owner(`INSERT INTO "ReviewGate" (id) VALUES ('task')`))).toBe('23514');

      const onlyNew = 'the review gate changes only with a new approval';
      await refused(k.setGate(app, true, null), '42501', onlyNew);
      await refused(app(`UPDATE "ReviewGate" SET enforced = true`), '42501', onlyNew);
      const on = await k.card('review.enforce', { gate: 'proposal', enforced: true });
      await refused(app(`UPDATE "ReviewGate" SET "approvalId" = $1`, [on.aid]), '42501', onlyNew);
      await refused(k.setGate(app, false, on.aid), '42501', onlyNew);
      await refused(app(`UPDATE "ReviewGate" SET enforced = NULL, "approvalId" = $1`, [on.aid]), '42501', onlyNew);
      for (const iso of ['REPEATABLE READ', 'SERIALIZABLE']) await refused(k.inTx((q) => k.setGate(q, true, on.aid), { iso }), '40001', 'the review gate changes at read committed only', iso);
      // A card for something else that names a gate, one for another gate, one filed without Will's own-touch mark, one from a job.
      const wrong = notFor('gate', 'proposal', 'review.enforce');
      await refused(k.setGate(app, true, (await k.card('task.cancel', { gate: 'proposal', taskId: 'tanone' })).aid), '42501', wrong);
      await refused(k.setGate(app, true, (await k.card('review.enforce', { gate: 'task', enforced: true })).aid), '42501', wrong);
      await refused(k.setGate(app, true, (await k.card('review.enforce', { gate: 'proposal', enforced: true, n: 1 }, { consequential: false })).aid), '42501', wrong);
      await refused(k.setGate(app, true, (await k.card('review.enforce', { gate: 'proposal', enforced: true, n: 2 }, { origin: 'runtime:reviews' })).aid), '42501', wrong);
      await refused(k.setGate(app, true, 'apprnone'), '42501', 'gate proposal: approval apprnone is not a live signed approval of a card');
      // The card says which way: one that stops requiring reviews does not start requiring them.
      const off = await k.card('review.enforce', { gate: 'proposal', enforced: false });
      await refused(k.setGate(app, true, off.aid), '42501', `the review gate: not what approval ${off.aid} signed`);
      // Requiring reviews with no reviewer on would leave every card that needs one waiting. (The card to require
      // them is signed again here: the first one is no longer his latest word on the gate.)
      await refused(k.setGate(app, true, on.aid), '42501', `gate proposal: approval ${on.aid} was signed before a later decision`);
      const need = await k.card('review.enforce', { gate: 'proposal', enforced: true, n: 6 });
      await refused(k.setGate(app, true, need.aid), '42501', 'the review gate: requiring reviews needs a reviewer that is on');
      expect([await k.gate(), await k.used(on.aid), await k.used(off.aid), await k.used(need.aid)]).toEqual([{ enforced: false, approvalId: null }, 0, 0, 0]);

      const [r1, r2] = [await k.onAsset({ kind: 'local_reviewer', capabilities: ['review'] }), await k.onAsset({ kind: 'local_reviewer', capabilities: ['review'] })];
      const worker = await k.onAsset();
      try {
        await k.setGate(app, true, need.aid);
        await k.finish(need.pid);
        expect(await k.gate()).toEqual({ enforced: true, approvalId: need.aid });
        // The card to stop that he signed before the one that required them decides nothing now: his later signature stands.
        await refused(k.setGate(app, false, off.aid), '42501', `gate proposal: approval ${off.aid} was signed before a later decision`);
        expect([await k.gate(), await k.used(off.aid)]).toEqual([{ enforced: true, approvalId: need.aid }, 0]);
        // Used once: stopping and starting again each take their own card, signed since.
        const stop = await k.card('review.enforce', { gate: 'proposal', enforced: false, n: 5 });
        await k.setGate(app, false, stop.aid);
        await refused(k.setGate(app, true, need.aid), '42501', notFor('gate', 'proposal', 'review.enforce'));
        const again = await k.card('review.enforce', { gate: 'proposal', enforced: true, n: 3 });
        await k.setGate(app, true, again.aid);
        // The approval that turned it on once does not turn it on again while its card is still executing.
        const offAgain = await k.card('review.enforce', { gate: 'proposal', enforced: false, n: 4 });
        await k.setGate(app, false, offAgain.aid);
        await refused(k.setGate(app, true, again.aid), '42501', `gate proposal: approval ${again.aid} was already used`);
        await k.enforce(true);

        // While reviews are required, one reviewer may go; the last one stays on.
        await k.switchOff(app, r1.id);
        await refused(k.switchOff(app, r2.id), '42501', `asset ${r2.id}: reviews are required, so the last reviewer stays on`);
        // A worker is not a reviewer: it goes off as always.
        await k.switchOff(app, worker.id);
        // Turning an asset on is a policy card: while reviews are required, it waits for its review like any other.
        const idle = await k.asset();
        const enable = await k.file('asset.enable', k.enableArgs(idle));
        await refused(k.approve(app, enable.pid, await k.approval(enable.pid, 'asset.enable', enable.digest)), '42501', `proposal ${enable.pid}: it needs a review before it is approved`);
      } finally {
        if ((await k.gate()).enforced) await k.enforce(false);
        await k.switchOff(app, r1.id);
        await k.switchOff(app, r2.id);
      }
      expect((await app(`SELECT count(*)::int AS n FROM "Asset" WHERE kind = 'local_reviewer' AND enabled`)).rows[0].n).toBe(0);
    });

    it('a card is born unreviewed; whether it needs a review never changes; its review is attached once, while it waits, and is a review of it', async () => {
      const args = { url: 'https://example.com/c' };
      await refused(app(`INSERT INTO "Proposal" (id, kind, origin, action, args, "argsDigest", "argsProvenance", "reviewId", "expiresAt") VALUES ($1, 'tool_call', 'console', 'x.y', $2::jsonb, $3, '{}', 'rv0', now() + interval '1 hour')`,
        [id('prop'), JSON.stringify(args), digestOf(args)]), '42501', /^proposal \w+: a card starts unreviewed$/);
      const needs = await k.file('mcp:web.fetch_url', args, { kind: 'tool_call', origin: 'chat:c1', tainted: true });
      const plain = await k.file('mcp:notes.update', { text: 'Synthetic' }, { kind: 'tool_call', origin: 'chat:c1' });
      await refused(app(`UPDATE "Proposal" SET "reviewRequired" = false WHERE id = $1`, [needs.pid]), '42501', `proposal ${needs.pid}: whether it needs a review never changes`);
      await refused(app(`UPDATE "Proposal" SET "reviewRequired" = NULL WHERE id = $1`, [needs.pid]), '42501', `proposal ${needs.pid}: whether it needs a review never changes`);
      await refused(app(`UPDATE "Proposal" SET "reviewRequired" = true WHERE id = $1`, [plain.pid]), '42501', `proposal ${plain.pid}: whether it needs a review never changes`);

      const reviewer = await k.reviewer();
      const mine = await k.reviewed(needs.pid, {}, false);
      const theirs = await k.reviewed(plain.pid, {}, false);
      const attach = (pid: string, rid: string | null) => app(`UPDATE "Proposal" SET "reviewId" = $2 WHERE id = $1`, [pid, rid]);
      const notOfIt = `proposal ${needs.pid}: that review is not a review of it`;
      await refused(attach(needs.pid, theirs), '42501', notOfIt);
      await refused(attach(needs.pid, 'rvnone'), '42501', notOfIt);
      await refused(attach(needs.pid, `${CANARY} review`), '42501', notOfIt);
      const t = await k.taskAt('checking', w);
      await refused(attach(needs.pid, await k.review({ subjectType: 'task', subjectId: t.id, subjectDigest: k.outputDigest(), tainted: true })), '42501', notOfIt);
      await attach(needs.pid, mine);
      const once = `proposal ${needs.pid}: its review is attached once, while it waits`;
      await refused(attach(needs.pid, null), '42501', once);
      await refused(attach(needs.pid, await k.reviewed(needs.pid, { verdict: 'proceed' }, false)), '42501', once);
      // Not attached in the statement that approves, nor afterwards.
      const late = await k.file('mcp:web.fetch_url', { url: 'https://example.com/d' }, { kind: 'tool_call', origin: 'chat:c1', tainted: true });
      const lateReview = await k.reviewed(late.pid, {}, false);
      const aid = await k.approval(late.pid, 'mcp:web.fetch_url', late.digest);
      await refused(app(`UPDATE "Proposal" SET status = 'approved', "approvalId" = $2, "reviewId" = $3 WHERE id = $1`, [late.pid, aid, lateReview]), '42501', `proposal ${late.pid}: its review is attached once, while it waits`);
      await k.approve(app, late.pid, aid);
      await refused(attach(late.pid, lateReview), '42501', `proposal ${late.pid}: its review is attached once, while it waits`);
      await k.switchOff(app, reviewer.id);
    });

    it('while reviews are required, a card that needs one is approved only with it attached, by a signature that names it and its verdict', async () => {
      const reviewer = await k.onAsset({ kind: 'local_reviewer', capabilities: ['review'] });
      const card = (n: number, o: Parameters<P5Kit['file']>[2] = {}) => k.file('mcp:web.fetch_url', { url: `https://example.com/gate/${n}` }, { kind: 'tool_call', origin: 'chat:c1', tainted: true, ...o });
      const bare = await card(1);
      const blocked = await card(2);
      const rid = await k.reviewed(blocked.pid, { verdict: 'block' });
      await k.enforce(true);
      try {
        // No review yet: refused, and the approval is still Will's to use.
        const early = await k.approval(bare.pid, 'mcp:web.fetch_url', bare.digest);
        await refused(k.approve(app, bare.pid, early), '42501', `proposal ${bare.pid}: it needs a review before it is approved`);
        expect((await app(`SELECT "consumedAt" FROM "Approval" WHERE id = $1`, [early])).rows[0].consumedAt).toBeNull();
        // Reviewed, but the signature names no review, another review, or another verdict than the one shown.
        const names = `proposal ${blocked.pid}: the approval does not name the review Will was shown`;
        const sign = (fields?: Record<string, unknown>) => k.approval(blocked.pid, 'mcp:web.fetch_url', blocked.digest, fields ? { fields } : {});
        await refused(k.approve(app, blocked.pid, await sign()), '42501', names);
        await refused(k.approve(app, blocked.pid, await sign({ tainted: true })), '42501', names);
        await refused(k.approve(app, blocked.pid, await sign({ reviewId: rid })), '42501', names);
        await refused(k.approve(app, blocked.pid, await sign({ reviewId: 'rvother', verdict: 'block' })), '42501', names);
        await refused(k.approve(app, blocked.pid, await sign({ reviewId: rid, verdict: 'proceed' })), '42501', names);
        expect((await app(`SELECT status FROM "Proposal" WHERE id = $1`, [blocked.pid])).rows[0].status).toBe('pending');
        // A signature that names a review written afterwards (its id is the runtime's to choose) was not of something he was shown.
        const unseen = await card(3);
        const lateId = id('rv');
        const tooEarly = await k.approval(unseen.pid, 'mcp:web.fetch_url', unseen.digest, { fields: { reviewId: lateId, verdict: 'proceed' } });
        await sleep(20);
        await k.reviewed(unseen.pid, { id: lateId, verdict: 'proceed' });
        await refused(k.approve(app, unseen.pid, tooEarly), '42501', `proposal ${unseen.pid}: its review was written after Will signed`);
        expect((await app(`SELECT status FROM "Proposal" WHERE id = $1`, [unseen.pid])).rows[0].status).toBe('pending');
        // Signed past the block he was shown.
        await k.approve(app, blocked.pid, await sign({ tainted: true, reviewId: rid, verdict: 'block' }));
        // Rejecting and expiring need no review; a card that needs none is approved as always; so is the card that stops requiring them.
        await app(`UPDATE "Proposal" SET status = 'rejected' WHERE id = $1`, [bare.pid]);
        const plain = await k.card('world.sync.git', { source: 'git', n: 1 }, { kind: 'tool_call', stage: 'approved' });
        expect((await app(`SELECT "reviewRequired", status FROM "Proposal" WHERE id = $1`, [plain.pid])).rows[0]).toEqual({ reviewRequired: false, status: 'approved' });
        // A policy card needs one like any other, except the one that turns the requirement.
        const policy = await k.file('policy.change', { rows: [] }, { kind: 'policy' });
        await refused(k.approve(app, policy.pid, await k.approval(policy.pid, 'policy.change', policy.digest)), '42501', `proposal ${policy.pid}: it needs a review before it is approved`);
        expect((await app(`SELECT count(*)::int AS n FROM review_gate_violations`)).rows[0].n).toBe(0);
      } finally {
        await k.enforce(false);
        await k.switchOff(app, reviewer.id);
      }
      // Not required any more: the unreviewed policy card is approved as before.
      const policy = await k.card('policy.change', { rows: [], n: 2 }, { kind: 'policy', stage: 'approved' });
      expect((await app(`SELECT status FROM "Proposal" WHERE id = $1`, [policy.pid])).rows[0].status).toBe('approved');
    });
  });

  describe('a plan step that is a Flint task', () => {
    it('names only a task of its own goal and step, and is done only when that task is accepted; a copy into a new version keeps what was done', async () => {
      const { gid, plan, steps } = await k.goalWithPlan({ s1: 'asset_task', s2: 'asset_task', s3: 'will_task', s4: 'flint_action' });
      const [s1, s2, s3, s4] = [steps.s1!, steps.s2!, steps.s3!, steps.s4!];
      const tick = (sid: string, extra = '', params: unknown[] = []) => app(`UPDATE "PlanStep" SET status = 'done', "doneAt" = now()${extra} WHERE id = $1`, [sid, ...params]);
      const notDone = (sid: string) => `step ${sid}: a Flint task is done only when its task was accepted`;
      const notItsTask = (sid: string) => `step ${sid}: its task is a task of this goal and step`;
      // Ticked with no task; P3's own rules are as they were (Will's step is his to tick, a Flint action needs its proof).
      await refused(tick(s1), '42501', notDone(s1));
      await tick(s3);
      expect(await k.code(tick(s4))).toBe('42501');

      const mine = await k.taskAt('checked', w, { goalId: gid, stepKey: 's1', sensitivity: 'personal' });
      const sibling = await k.taskAt('checked', w, { goalId: gid, stepKey: 's2', sensitivity: 'personal' });
      const other = await k.goalWithPlan({ s1: 'asset_task' });
      const foreign = await k.taskAt('checked', w, { goalId: other.gid, stepKey: 's1', sensitivity: 'personal' });
      const loose = await k.taskAt('checked', w);
      for (const t of [sibling, foreign, loose]) await k.accept(t.id);
      const name = (sid: string, taskId: string | null) => app(`UPDATE "PlanStep" SET "taskId" = $2 WHERE id = $1`, [sid, taskId]);
      // Another step's task, another goal's, one of no goal, and one that is not there: none is this step's.
      for (const taskId of [sibling.id, foreign.id, loose.id, 'tanone']) await refused(name(s1, taskId), '42501', notItsTask(s1), taskId);
      // Done by pointing at an accepted task that is not its own: refused the same way.
      await refused(tick(s1, `, "taskId" = $2`, [sibling.id]), '42501', notItsTask(s1));
      await name(s1, mine.id);
      // Its own task, not yet accepted.
      await refused(tick(s1), '42501', notDone(s1));
      await k.accept(mine.id);
      await tick(s1);
      // Done stays tied to that task: it cannot be unhooked while it stays done.
      await refused(name(s1, null), '42501', notDone(s1));
      // Will's own step takes any task id, as before (nothing holds it).
      await name(s3, loose.id);

      // A new plan version copies the steps: a done Flint task keeps what a version that was active had, and gains nothing.
      const rows = (await app(`SELECT key, ordinal, title, kind, status, tier, "dueAt", "dependsOn", "proposalId", "taskId", "doneAuditId", "doneAt" FROM "PlanStep" WHERE "planId" = $1 ORDER BY key`, [plan])).rows;
      const copy = async (q: Q, planId: string, change: (r: Record<string, unknown>) => Record<string, unknown> = (r) => r) => {
        for (const r of rows.map((x) => change({ ...x }))) {
          await q(`INSERT INTO "PlanStep" (id, "planId", key, ordinal, title, kind, status, tier, "dueAt", "dependsOn", "proposalId", "taskId", "doneAuditId", "doneAt") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
            [id('ps'), planId, r.key, r.ordinal, r.title, r.kind, r.status, r.tier, r.dueAt, r.dependsOn, r.proposalId, r.taskId, r.doneAuditId, r.doneAt]);
        }
      };
      const nextVersion = (aid: string, change?: (r: Record<string, unknown>) => Record<string, unknown>) => k.inTx(async (q) => {
        const v2 = id('pl');
        await q(`INSERT INTO "Plan" (id, "goalId", version, "createdBy") VALUES ($1, $2, (SELECT max(version) + 1 FROM "Plan" WHERE "goalId" = $2), 'will')`, [v2, gid]);
        await copy(q, v2, change);
        await q(`INSERT INTO "PlanStep" (id, "planId", key, ordinal, title, kind) VALUES ($1, $2, 's5', 5, 'Synthetic step s5', 'will_task')`, [id('ps'), v2]);
        await q(`UPDATE "Plan" SET status = 'superseded' WHERE "goalId" = $1 AND status = 'active'`, [gid]);
        await q(`UPDATE "Plan" SET status = 'active', "approvalId" = $2 WHERE id = $1`, [v2, aid]);
        return v2;
      });
      const change = () => k.card('plan.change', { goalId: gid, goalTitle: 'Synthetic goal', ops: [k.planStep('s5', 'will_task')] }, { kind: 'plan', sensitivity: 'personal' });
      // A copy that marks the other Flint task done with no task, hooks it to another step's task, or unhooks the done
      // one: each is refused as the step is written.
      const c1 = await change();
      const done = { status: 'done', doneAt: new Date().toISOString() };
      await refused(nextVersion(c1.aid, (r) => (r.key === 's2' ? { ...r, ...done } : r)), '42501', /^step \w+: a Flint task is done only when its task was accepted$/);
      await refused(nextVersion(c1.aid, (r) => (r.key === 's2' ? { ...r, ...done, taskId: mine.id } : r)), '42501', /^step \w+: its task is a task of this goal and step$/);
      await refused(nextVersion(c1.aid, (r) => (r.key === 's1' ? { ...r, taskId: null } : r)), '42501', /^step \w+: a Flint task is done only when its task was accepted$/);
      expect(await k.used(c1.aid)).toBe(0);
      // Will later overrides the task to rejected: the step it had done is no longer done, in the same transaction.
      const over = await k.card('task.bar_override', { taskId: mine.id, to: 'rejected' });
      await k.setStatus(app, mine.id, 'rejected', `, "barCheckedBy" = 'will'`);
      await k.finish(over.pid);
      expect((await app(`SELECT status, "taskId", "doneAt" FROM "PlanStep" WHERE id = $1`, [s1])).rows[0]).toEqual({ status: 'blocked', taskId: mine.id, doneAt: null });
      // The steps other tasks did, and Will's own, are as they were.
      expect((await app(`SELECT status FROM "PlanStep" WHERE id = $1`, [s3])).rows[0].status).toBe('done');
      // It is not ticked back by hand, and a copy that still says done is refused: no version that was active has it done now.
      await refused(tick(s1), '42501', notDone(s1));
      await refused(nextVersion(c1.aid), '42501', /^step \w+: a Flint task is done only when its task was accepted$/);
      // The next version copies it as it stands.
      const v2 = await nextVersion(c1.aid, (r) => (r.key === 's1' ? { ...r, status: 'blocked', doneAt: null } : r));
      expect((await app(`SELECT status, "taskId" FROM "PlanStep" WHERE "planId" = $1 AND key = 's1'`, [v2])).rows[0]).toEqual({ status: 'blocked', taskId: mine.id });
      // A task that is live for the step is the only way it is done again: one at a time (the rejected one is not live).
      const retry = await k.taskAt('checked', w, { goalId: gid, stepKey: 's1', sensitivity: 'personal' });
      expect(await k.code(k.task(w.id, { goalId: gid, stepKey: 's1', sensitivity: 'personal' }))).toBe('23505');
      // ...and the rejected one is not brought back beside it, even on a signed override.
      await k.card('task.bar_override', { taskId: mine.id, to: 'accepted', n: 2 });
      expect(await k.code(k.setStatus(app, mine.id, 'accepted'))).toBe('23505');
      expect(retry.id).toBeTruthy();
      // On the new version, the other Flint task still needs its own accepted task to be done.
      const s2v2 = (await app(`SELECT id FROM "PlanStep" WHERE "planId" = $1 AND key = 's2'`, [v2])).rows[0].id as string;
      await refused(tick(s2v2), '42501', notDone(s2v2));
      await app(`UPDATE "PlanStep" SET "taskId" = $2 WHERE id = $1`, [s2v2, sibling.id]);
      await tick(s2v2);
      expect(s2).toBeTruthy();
    });
  });

  describe('every refusal', () => {
    it('the migration can raise names its SQLSTATE, and was refused above with that SQLSTATE and that message', () => {
      const sql = readFileSync(join(MIGRATIONS, '20261014000000_p5_assets', 'migration.sql'), 'utf8');
      const p3 = readFileSync(join(MIGRATIONS, '20261009000000_p3_goals', 'migration.sql'), 'utf8');
      const raises = [...sql.matchAll(/RAISE EXCEPTION '((?:[^']|'')*)'([^;]*?);/g)];
      expect(raises.length).toBeGreaterThan(80);
      const declared = raises.map((m) => ({ format: m[1]!.replace(/''/g, "'"), state: /USING ERRCODE = '([a-z_]+)'/.exec(m[2]!)?.[1] }));
      // Every RAISE names its SQLSTATE.
      expect(declared.filter((d) => !d.state || !SQLSTATE[d.state]).map((d) => d.format)).toEqual([]);
      // No message is raised at two sites: a refusal seen above is one site's, so each site has to be reached.
      const formats = declared.map((d) => d.format);
      expect(formats.filter((f, i) => formats.indexOf(f) !== i)).toEqual([]);
      // Nor does one site's message fit another's shape (a `%` matching what another message spells out).
      const shapeOf = (f: string) => new RegExp(`^${f.split('%').map(esc).join('.+')}$`);
      const literal = (f: string) => f.replace(/%/g, 'x');
      expect(formats.flatMap((f) => formats.filter((g) => g !== f && shapeOf(f).test(literal(g))).map((g) => `${f} | ${g}`))).toEqual([]);
      // P3's own refusals inside plan_step_guard (its body is P3's, to the letter) are P3's tests' to cover.
      const own = declared.filter((d) => !p3.includes(`RAISE EXCEPTION '${d.format.replace(/'/g, "''")}'`));
      const missing = own.filter((d) => {
        const shape = new RegExp(`^${d.format.split('%').map(esc).join('.+')}$`);
        return !seen.some((s) => s.code === SQLSTATE[d.state!] && shape.test(s.message));
      });
      expect(missing.map((d) => `${d.state}: ${d.format}`)).toEqual([]);
      expect(own.length).toBeGreaterThan(70);
    });
  });
});
