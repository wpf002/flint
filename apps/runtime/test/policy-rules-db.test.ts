/**
 * Policy changes as the runtime files and carries them out (governance/
 * internal.ts, proposals.ts), and the `rules` command (governance/rules.ts),
 * on flint_test with a real signing key.
 *
 *  - A switch-off: filed only as Will's own card for rows that are there and
 *    on; signed and run, the rows go off whole; a refusal by the database is
 *    one sentence and an audit entry, never a retry.
 *  - A rule card says one thing, at filing and again when it is carried out.
 *  - A rule that forbids policy changes can be signed away: the card that
 *    switches rules off is judged by the code alone, and no new rule may cover
 *    a policy change at all.
 *  - A signed table is carried out whole and once; one the database would
 *    make no row under (not Will's own policy card) is never filed, and each
 *    rule's end is a time written in full, with its zone; a refusal by the
 *    database is one sentence and an audit entry, never a retry.
 *  - The `rules` command: Will's rules in sentences, and the card it files.
 * What the database itself holds is policy-off-guard-db.test.ts and
 * policy-rows-guard-db.test.ts. Synthetic text only.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { POLICY_CHANGE_SHAPE, digestOf, noteProblems, type Tier } from '@flint/policy';
import { NO_DB, RUNTIME, freshDb, id, type TestUrls } from './db';
import { enrollTestKey } from './sign';
import { policyKit, type PolicyKit } from './policy';
import { createDb } from '../src/db';
import { approveProposal, createProposal } from '../src/governance/proposals';
import { POLICY_OFF_REFUSED, POLICY_OFF_SAYS, POLICY_ROWS_REFUSED, POLICY_SAYS, POLICY_TIME, policyArgsSignable, runInternal } from '../src/governance/internal';
import { NO_ID, RULES_SAY, proposeRulesOff, ruleSays, rulesLines, rulesOffFiledSays, rulesOffTitle, rulesOn } from '../src/governance/rules';

describe.skipIf(NO_DB)('policy changes, as the runtime files and carries them out', () => {
  let urls: TestUrls;
  let db: ReturnType<typeof createDb>;
  let key: Awaited<ReturnType<typeof enrollTestKey>>;
  let pk: PolicyKit;
  const fam = () => pk.fam('run');

  beforeAll(async () => {
    urls = await freshDb();
    db = createDb(urls.app);
    key = await enrollTestKey(urls);
    pk = await policyKit(urls);
  });
  afterAll(async () => db?.$disconnect());

  const file = (args: Record<string, unknown>, over: Record<string, unknown> = {}) => createProposal(db, {
    kind: 'policy', origin: 'cli', action: 'policy.change', args, argsProvenance: {}, tainted: false, sensitivity: 'ops', destructive: false, consequential: false, ttlMinutes: 60, ...over,
  } as Parameters<typeof createProposal>[1], 'will:cli');
  const sign = async (p: { id: string; argsDigest: string }) => {
    const approvalId = await key.approve({ subjectId: p.id, action: 'policy.change', argsDigest: p.argsDigest });
    await approveProposal(db, p.id, approvalId, undefined, 'will:console');
    return approvalId;
  };
  const run = (pid: string) => runInternal(db, pid, undefined, 'UTC', 'will:console');
  const rowsArgs = (rows: Array<{ pattern: string; tier: Tier; dailyCap?: number; scope?: Record<string, unknown> }>) => {
    const expiresAt = pk.inDays(30);
    return { rows: rows.map((r) => ({ ...r, expiresAt })) };
  };
  /** Rules Will signed, through the runtime itself: a policy change filed, approved with his key and run. */
  async function rules(rows: Array<{ pattern: string; tier: Tier; dailyCap?: number }>) {
    const p = await file(rowsArgs(rows));
    const approvalId = await sign(p);
    await run(p.id);
    const made = await db.actionPolicy.findMany({ where: { approvalId } });
    // In the order asked for (rows written in one transaction share their time).
    return rows.map((r) => made.find((m) => m.pattern === r.pattern && m.tier === r.tier)!);
  }
  const offArgs = (rows: Array<{ id: string; pattern: string; tier: string }>) => ({ off: rows.map((r) => ({ id: r.id, pattern: r.pattern, tier: r.tier })) });
  const entries = async (pid: string) => (await pk.owner(`SELECT kind, outcome FROM "AuditEntry" WHERE "correlationId" = $1 ORDER BY seq`, [pid])).rows as Array<{ kind: string; outcome: string }>;
  const quiet = async <T>(fn: () => Promise<T>): Promise<{ out: T | undefined; err: unknown; logged: string[] }> => {
    const logged: string[] = [];
    const error = console.error;
    console.error = (...a: unknown[]) => void logged.push(a.join(' '));
    try {
      return { out: await fn(), err: undefined, logged };
    } catch (err) {
      return { out: undefined, err, logged };
    } finally {
      console.error = error;
    }
  };

  describe('a switch-off', () => {
    it('filed, signed and run: the rows it names go off whole, the card says how many, and each row’s history names the approval', async () => {
      const f = fam();
      const [wide, brake, never, capped] = await rules([{ pattern: `${f}.*`, tier: 'alone' }, { pattern: `${f}.propose`, tier: 'approval' }, { pattern: `${f}.void`, tier: 'forbidden' }, { pattern: `${f}.send`, tier: 'alone', dailyCap: 3 }]);
      const p = await file(offArgs([brake!, never!, capped!]));
      // It asks on its own, whatever the filer said.
      expect((await db.proposal.findUniqueOrThrow({ where: { id: p.id } })).consequential).toBe(true);
      // Filed is not switched off: the rows hold until it is signed and run.
      const on = () => db.actionPolicy.count({ where: { id: { in: [brake!.id, never!.id, capped!.id] }, active: true } });
      expect(await on()).toBe(3);
      const approvalId = await sign(p);
      expect(await on()).toBe(3);
      expect(await run(p.id)).toEqual({ off: 3 });
      expect(await on()).toBe(0);
      expect((await db.actionPolicy.findUniqueOrThrow({ where: { id: wide!.id } })).active).toBe(true);
      const card = await db.proposal.findUniqueOrThrow({ where: { id: p.id } });
      expect([card.status, card.result]).toEqual(['executed', { off: 3 }]);
      expect((await entries(p.id)).map((e) => `${e.kind} ${e.outcome}`)).toEqual(['decision pending', 'approval ok', 'intent pending', 'action ok']);
      expect((await pk.owner(`SELECT DISTINCT actor FROM "RowChange" WHERE "rowId" = ANY ($1)`, [[brake!.id, never!.id, capped!.id]])).rows).toEqual([{ actor: `will:approval:${approvalId}` }]);
      // Run once: asked again, the card has already run, and nothing more happens.
      await expect(run(p.id)).rejects.toMatchObject({ status: 409, message: 'It already ran.' });
    });

    it('a card that could not apply is never filed: not Will’s own card, a row that is not there or not as written, or one already off', async () => {
      const f = fam();
      const [brake, gone] = await rules([{ pattern: `${f}.propose`, tier: 'approval' }, { pattern: `${f}.gone`, tier: 'alone' }]);
      await pk.switchOff(gone!.id);
      const ok = offArgs([brake!]);
      await expect(file(ok, { kind: 'tool_call' })).rejects.toMatchObject({ status: 400, message: POLICY_OFF_SAYS.card });
      await expect(file(ok, { origin: 'chat:console-1' })).rejects.toMatchObject({ status: 400, message: POLICY_OFF_SAYS.card });
      await expect(file(ok, { origin: 'runtime:goals', templateId: 'x' })).rejects.toMatchObject({ status: 400, message: POLICY_OFF_SAYS.card });
      await expect(file(ok, { tainted: true })).rejects.toMatchObject({ status: 400, message: POLICY_OFF_SAYS.card });
      await expect(file({ off: [{ id: 'no-such-row', pattern: `${f}.propose`, tier: 'approval' }] })).rejects.toMatchObject({ status: 400, message: POLICY_OFF_SAYS.unknown });
      await expect(file({ off: [{ ...ok.off[0]!, tier: 'forbidden' }] })).rejects.toMatchObject({ status: 400, message: POLICY_OFF_SAYS.unknown });
      await expect(file({ off: [{ ...ok.off[0]!, pattern: `${f}.*` }] })).rejects.toMatchObject({ status: 400, message: POLICY_OFF_SAYS.unknown });
      await expect(file(offArgs([gone!]))).rejects.toMatchObject({ status: 409, message: POLICY_OFF_SAYS.alreadyOff });
      for (const bad of [{ off: [ok.off[0], ok.off[0]] }, { off: [{ id: brake!.id }] }, { off: [{ ...ok.off[0]!, note: 'x' }] }, { off: [{ ...ok.off[0]!, id: 'not an id' }] }]) {
        await expect(file(bad as Record<string, unknown>), JSON.stringify(bad)).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/^invalid policy change: /) });
      }
      expect(await db.proposal.count({ where: { action: 'policy.change', status: 'pending' } })).toBe(0);
      expect((await db.actionPolicy.findUniqueOrThrow({ where: { id: brake!.id } })).active).toBe(true);
    });

    it('a row that went off after the card was filed is left as it is, and the rest still go', async () => {
      const f = fam();
      const [a, b] = await rules([{ pattern: `${f}.a`, tier: 'alone' }, { pattern: `${f}.b`, tier: 'approval' }]);
      const p = await file(offArgs([a!, b!]));
      await pk.switchOff(a!.id);
      await sign(p);
      expect(await run(p.id)).toEqual({ off: 1 });
      expect(await db.actionPolicy.count({ where: { id: { in: [a!.id, b!.id] }, active: true } })).toBe(0);
    });

    it('refused by the database: one sentence, the card failed and on record as failed, the row still on, and no second try', async () => {
      const f = fam();
      const [brake, free] = await rules([{ pattern: `${f}.propose`, tier: 'approval' }, { pattern: `${f}.free`, tier: 'alone' }]);
      // A card the runtime would never file (from a chat), written straight into the table as a runtime gone wrong could,
      // and signed: the runtime's own checks pass it on, and the database is what refuses.
      const args = offArgs([free!, brake!]);
      const pid = id('prop');
      await pk.app(
        `INSERT INTO "Proposal" (id, kind, origin, action, args, "argsDigest", "argsProvenance", sensitivity, consequential, "expiresAt") VALUES ($1, 'policy', 'chat:console-1', 'policy.change', $2::jsonb, $3, '{}', 'ops', true, now() + interval '1 hour')`,
        [pid, JSON.stringify(args), digestOf(args)],
      );
      await sign({ id: pid, argsDigest: digestOf(args) });
      const r = await quiet(() => run(pid));
      expect(r.err).toMatchObject({ name: 'Refused', status: 409, message: POLICY_OFF_REFUSED });
      // All rows or none: the row at alone named beside it stays on too.
      expect(await db.actionPolicy.count({ where: { id: { in: [brake!.id, free!.id] }, active: true } })).toBe(2);
      const card = await db.proposal.findUniqueOrThrow({ where: { id: pid } });
      expect(card.status).toBe('failed');
      expect(card.error).toMatch(/^could not carry it out \(err[a-z0-9]+\)$/);
      expect((await entries(pid)).map((e) => `${e.kind} ${e.outcome}`)).toEqual(['approval ok', 'intent pending', 'action failed']);
      // The log says what failed by its class and SQLSTATE, never the database's own words.
      expect(r.logged.join('\n')).toMatch(/running policy\.change failed: .*42501/);
      expect(r.logged.join('\n')).not.toMatch(/holds something back|policy row/);
      // Asked again, it has failed: nothing is retried.
      await expect(run(pid)).rejects.toMatchObject({ status: 409, message: 'It already failed.' });
      expect((await entries(pid)).length).toBe(3);
    });
  });

  describe('a rule card says one thing', () => {
    it('neither both, nor an empty list, nor anything beside the one list, is ever filed; nor a card the database could not read again', async () => {
      const f = fam();
      const [brake] = await rules([{ pattern: `${f}.propose`, tier: 'approval' }]);
      const off = offArgs([brake!]);
      const rows = rowsArgs([{ pattern: `${f}.*`, tier: 'alone' }]);
      for (const bad of [{ ...off, ...rows }, { ...off, rows: [] }, { ...rows, off: [] }, { off: [] }, { rows: [] }, { ...off, also: 1 }, { ...rows, note: 'x' }, { off: 'all' }, { rows: rows.rows[0] }, {}, { switchOff: off.off }]) {
        await expect(file(bad as Record<string, unknown>), JSON.stringify(bad)).rejects.toMatchObject({ status: 400, message: POLICY_CHANGE_SHAPE });
      }
      // Whole numbers and plain names only, a few levels deep: the database computes the digest again when the card runs.
      let deep: unknown = 'bottom';
      for (let i = 0; i < 20; i++) deep = { in: deep };
      for (const scope of [{ weight: 0.5 }, { 'naïve': 1 }, { big: 2 ** 60 }, { deep }]) {
        await expect(file(rowsArgs([{ pattern: `${f}.sync`, tier: 'alone', scope }])), JSON.stringify(scope).slice(0, 40)).rejects.toMatchObject({ status: 400, message: POLICY_SAYS.unsignable });
      }
      expect(policyArgsSignable(rowsArgs([{ pattern: `${f}.sync`, tier: 'alone', dailyCap: 3, scope: { endpoints: ['https://example.test/ä'], n: 2, deep: { a: { b: [1, 2] } } } }]))).toBe(true);
      expect(await db.proposal.count({ where: { action: 'policy.change', status: 'pending' } })).toBe(0);
      for (const s of [POLICY_CHANGE_SHAPE, ...Object.values(POLICY_SAYS), POLICY_OFF_REFUSED, POLICY_ROWS_REFUSED, ...Object.values(POLICY_OFF_SAYS)]) expect(noteProblems('Rule', s), s).toEqual([]);
    });

    it('a card that says both, filed before the database held the shape and signed, is carried out as neither', async () => {
      const f = fam();
      const [brake] = await rules([{ pattern: `${f}.propose`, tier: 'approval' }]);
      const args = { ...offArgs([brake!]), ...rowsArgs([{ pattern: `${f}.*`, tier: 'alone' }]) };
      const filed = await pk.k.without('Proposal_policy_shape', (q) => pk.k.file('policy.change', args, { kind: 'policy', origin: 'cli' }, q));
      await sign({ id: filed.pid, argsDigest: filed.digest });
      const r = await quiet(() => run(filed.pid));
      expect(r.err).toMatchObject({ name: 'Refused', status: 409, message: POLICY_CHANGE_SHAPE });
      expect((await db.proposal.findUniqueOrThrow({ where: { id: filed.pid } })).status).toBe('failed');
      expect((await db.actionPolicy.findUniqueOrThrow({ where: { id: brake!.id } })).active).toBe(true);
      expect(await db.actionPolicy.count({ where: { pattern: `${f}.*` } })).toBe(0);
    });
  });

  describe('a rule that forbids policy changes', () => {
    it('is never made: no row may cover a policy change, said as a sentence when the card is filed', async () => {
      for (const pattern of ['policy.change', 'policy.*', 'policy.change.*', 'policy.anything']) {
        for (const tier of ['forbidden', 'approval', 'alone'] as const) {
          await expect(file(rowsArgs([{ pattern: 'goal.review.local', tier: 'alone' }, { pattern, tier }])), `${pattern} ${tier}`).rejects.toMatchObject({ status: 400, message: POLICY_SAYS.coversPolicy });
        }
      }
      expect(await db.proposal.count({ where: { action: 'policy.change', status: 'pending' } })).toBe(0);
    });

    it('one from before can be signed away: the card that switches rules off is judged by the code alone', async () => {
      await pk.clear();
      const f = fam();
      // A rule from before the database refused such a row: every policy change forbidden.
      const never = await pk.forged({ id: id('pol'), pattern: 'policy.*', tier: 'forbidden' });
      // It does what it says to a card that adds rules...
      await expect(file(rowsArgs([{ pattern: `${f}.sync`, tier: 'alone' }]))).rejects.toMatchObject({ status: 409, message: 'forbidden: ActionPolicy policy.*' });
      // ...and the card that switches it off is still filed, signed and carried out.
      const filed = await proposeRulesOff(db, [never]);
      expect([filed.tier, filed.rules, filed.deduped]).toEqual(['approval', 1, false]);
      await sign(filed);
      expect(await run(filed.id)).toEqual({ off: 1 });
      expect(await pk.isOn(never)).toBe(false);
      // With it gone, rules are added again.
      expect((await rules([{ pattern: `${f}.sync`, tier: 'alone' }])).length).toBe(1);
      await pk.clear();
    });
  });

  describe('a signed table', () => {
    it('is carried out whole and once: every row together, and never again from the same card', async () => {
      const f = fam();
      const p = await file(rowsArgs([{ pattern: `${f}.*`, tier: 'alone' }, { pattern: `${f}.propose`, tier: 'approval' }, { pattern: `${f}.send`, tier: 'alone', dailyCap: 3 }]));
      const approvalId = await sign(p);
      expect(await run(p.id)).toEqual({ rows: 3 });
      expect(await db.actionPolicy.count({ where: { approvalId, active: true } })).toBe(3);
      await expect(run(p.id)).rejects.toMatchObject({ status: 409, message: 'It already ran.' });
      expect(await db.actionPolicy.count({ where: { approvalId } })).toBe(3);
    });

    it('a card the database would make no row under is never filed: not Will’s own policy card, from a chat or a job, or with outside text in it', async () => {
      const f = fam();
      const ok = rowsArgs([{ pattern: `${f}.sync`, tier: 'alone' }]);
      await expect(file(ok, { kind: 'tool_call' })).rejects.toMatchObject({ status: 400, message: POLICY_SAYS.card });
      await expect(file(ok, { origin: 'chat:console-1' })).rejects.toMatchObject({ status: 400, message: POLICY_SAYS.card });
      await expect(file(ok, { origin: 'runtime:goals', templateId: 'x' })).rejects.toMatchObject({ status: 400, message: POLICY_SAYS.card });
      await expect(file(ok, { origin: 'will' })).rejects.toMatchObject({ status: 400, message: POLICY_SAYS.card });
      await expect(file(ok, { tainted: true })).rejects.toMatchObject({ status: 400, message: POLICY_SAYS.card });
      expect(await db.proposal.count({ where: { action: 'policy.change', status: 'pending' } })).toBe(0);
      // His own card, from the CLI or the console, is filed (and asks on its own, whatever the filer said).
      for (const origin of ['cli', 'console']) {
        const p = await file(rowsArgs([{ pattern: `${f}.${origin}`, tier: 'alone' }]), { origin });
        expect((await db.proposal.findUniqueOrThrow({ where: { id: p.id } })).consequential).toBe(true);
        await db.proposal.update({ where: { id: p.id }, data: { status: 'rejected', error: 'Synthetic end' } });
      }
    });

    it('each rule ends at a time written in full, with its zone: a card that writes one any other way is never filed', async () => {
      const f = fam();
      const withEnd = (expiresAt: unknown) => ({ rows: [{ pattern: `${f}.sync`, tier: 'alone', expiresAt }] });
      const soon = pk.inDays(30);
      // No zone (read under each session's own, it was a different moment in each); a date that reads two ways; and
      // every other way of writing a time that the database's own check refuses.
      for (const end of [soon.slice(0, 19).replace('T', ' '), soon.slice(0, 19), '03/04/2027 00:00:00+00', soon.replace('Z', '+0000'), soon.replace('Z', '+00'), soon.replace('Z', 'z'), soon.replace('T', ' '),
        soon.replace('.000Z', '.0000Z'), soon.slice(0, 16) + 'Z', soon.slice(0, 10), ` ${soon}`, `${soon}\n`, 'now', 'tomorrow', 'infinity', '', null, 1798859045, soon.replace(/-\d\d-/, '-13-')]) {
        await expect(file(withEnd(end) as Record<string, unknown>), JSON.stringify(end)).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/^invalid policy change: rows\.0\.expiresAt: /) });
        if (typeof end === 'string') expect(POLICY_TIME.test(end) && !Number.isNaN(Date.parse(end)), JSON.stringify(end)).toBe(false);
      }
      expect(await db.proposal.count({ where: { action: 'policy.change', status: 'pending' } })).toBe(0);
      // In full with its zone, UTC or any other: filed.
      const there = `${new Date(Date.parse(soon) + 5.5 * 3_600_000).toISOString().slice(0, 23)}+05:30`;
      for (const end of [soon, soon.replace('.000Z', 'Z'), there]) {
        const p = await file(withEnd(end));
        await db.proposal.update({ where: { id: p.id }, data: { status: 'rejected', error: 'Synthetic end' } });
      }
    });

    it('refused by the database: one sentence, the card failed and on record as failed, no rule added, and no second try', async () => {
      const f = fam();
      // A card the runtime would never file (from a chat), written straight into the table as a runtime gone wrong
      // could, and signed: the runtime's own checks pass it on, and the database is what refuses. Its two rows are
      // a wide one that lets go and the brake beside it.
      const args = rowsArgs([{ pattern: `${f}.*`, tier: 'alone' }, { pattern: `${f}.propose`, tier: 'approval' }]);
      const pid = id('prop');
      await pk.app(
        `INSERT INTO "Proposal" (id, kind, origin, action, args, "argsDigest", "argsProvenance", sensitivity, consequential, "expiresAt") VALUES ($1, 'policy', 'chat:console-1', 'policy.change', $2::jsonb, $3, '{}', 'ops', true, now() + interval '1 hour')`,
        [pid, JSON.stringify(args), digestOf(args)],
      );
      const approvalId = await sign({ id: pid, argsDigest: digestOf(args) });
      const r = await quiet(() => run(pid));
      expect(r.err).toMatchObject({ name: 'Refused', status: 409, message: POLICY_ROWS_REFUSED });
      expect(await db.actionPolicy.count({ where: { approvalId } })).toBe(0);
      const card = await db.proposal.findUniqueOrThrow({ where: { id: pid } });
      expect(card.status).toBe('failed');
      expect(card.error).toMatch(/^could not carry it out \(err[a-z0-9]+\)$/);
      expect((await entries(pid)).map((e) => `${e.kind} ${e.outcome}`)).toEqual(['approval ok', 'intent pending', 'action failed']);
      // The log says what failed by its class and SQLSTATE, never the database's own words.
      expect(r.logged.join('\n')).toMatch(/running policy\.change failed: .*42501/);
      expect(r.logged.join('\n')).not.toMatch(/still stands|policy row/);
      // Asked again, it has failed: nothing is retried.
      await expect(run(pid)).rejects.toMatchObject({ status: 409, message: 'It already failed.' });
      expect((await entries(pid)).length).toBe(3);
      expect(await db.actionPolicy.count({ where: { approvalId } })).toBe(0);
    });
  });

  describe('the rules command', () => {
    const TZ = 'America/Chicago';
    const at = (iso: string) => new Date(iso);

    it('says each rule as a sentence, by the action’s plain name: what it does, its limit and its last day', () => {
      const now = at('2026-10-13T12:00:00Z');
      const row = (pattern: string, tier: string, more: Record<string, unknown> = {}) => ({ id: 'ap1', pattern, tier, dailyCap: null, scoped: false, expiresAt: at('2027-04-05T05:00:00Z'), ...more });
      expect(ruleSays(row('backup.local', 'alone'), TZ, now)).toBe('Flint may run Backup on its own, until April 5, 2027.');
      expect(ruleSays(row('goal.propose', 'alone', { dailyCap: 3 }), TZ, now)).toBe('Flint may run Suggest a Goal from Chat on its own, up to 3 a day, until April 5, 2027.');
      expect(ruleSays(row('world.sync.github', 'alone', { scoped: true, dailyCap: 0 }), TZ, now)).toBe('Flint may run World Sync Github on its own, within the limits you signed, up to 0 a day, until April 5, 2027.');
      expect(ruleSays(row('goal.propose', 'approval', { dailyCap: 9, scoped: true }), TZ, now)).toBe('Flint asks you each time before it runs Suggest a Goal from Chat, until April 5, 2027.');
      expect(ruleSays(row('restore.*', 'forbidden'), TZ, now)).toBe('Flint may not run Everything Under Restore, until April 5, 2027.');
      // One that has ended and is still switched on says so: it holds nothing today, and is listed until it is switched off.
      expect(ruleSays(row('goal.propose', 'approval', { expiresAt: at('2026-10-01T05:00:00Z') }), TZ, now)).toBe('Flint asks you each time before it runs Suggest a Goal from Chat, and ended on October 1, 2026.');
      // The day is Will's day, wherever the Mac's clock is.
      expect(ruleSays(row('backup.local', 'alone', { expiresAt: at('2027-04-05T03:00:00Z') }), TZ, now)).toBe('Flint may run Backup on its own, until April 4, 2027.');
      expect(rulesLines([], TZ, now)).toEqual(['You have no rules switched on.']);
      expect(rulesLines([row('backup.local', 'alone')], TZ, now)).toEqual([
        'You have 1 rule switched on.',
        '  ap1  Flint may run Backup on its own, until April 5, 2027.',
        'To switch one off, run this with its id, then approve the card it files:',
        '  cd ~/flint && pnpm --silent --filter @flint/runtime rules --off <id>',
      ]);
      expect(rulesLines([row('backup.local', 'alone'), row('restore.*', 'forbidden', { id: 'ap2' })], TZ, now)[0]).toBe('You have 2 rules switched on.');
    });

    it('never prints an id that is not shaped as one: the runtime chooses a row’s id, and a terminal reads what it is sent', () => {
      const now = at('2026-10-13T12:00:00Z');
      const row = (rid: string) => ({ id: rid, pattern: 'goal.propose', tier: 'approval', dailyCap: null, scoped: false, expiresAt: at('2027-04-05T05:00:00Z') });
      for (const rid of ['esc\u001b[31mred', 'two words', 'a\nb', '‮rtl', 'x'.repeat(65), '', 'ap;rm']) {
        const lines = rulesLines([row(rid), row('ap2')], TZ, now);
        expect(lines[1], JSON.stringify(rid)).toBe(`  ${NO_ID}  Flint asks you each time before it runs Suggest a Goal from Chat, until April 5, 2027.`);
        expect(lines[2]).toMatch(/^ {2}ap2 {2}Flint asks you/);
        expect(lines.at(-1)).toBe('A rule shown with no id can’t be named on a card. Ask Claude to switch it off.');
        // Nothing but printable ASCII and the two curly marks the sentences use reaches the terminal.
        expect(lines.join('\n')).toMatch(/^[\n -~’]*$/);
      }
      expect(rulesLines([row('ap2')], TZ, now).at(-1)).toBe('  cd ~/flint && pnpm --silent --filter @flint/runtime rules --off <id>');
    });

    it('what it says once the card is filed: the card by its title, how to approve it, and no id', () => {
      expect(rulesOffFiledSays({ deduped: false, rules: 1 })).toBe([
        'Filed: the Switch Off 1 Rule card.',
        'To approve it: open Flint, click Approvals in the top bar, open Switch Off 1 Rule, and approve it with Touch ID.',
        'It asks on its own, never in Approve All. It expires in 7 days. The rule stays on until it is approved.',
      ].join('\n'));
      expect(rulesOffFiledSays({ deduped: true, rules: 3 })).toBe([
        'Already filed: the Switch Off 3 Rules card.',
        'To approve it: open Flint, click Approvals in the top bar, open Switch Off 3 Rules, and approve it with Touch ID.',
        'It asks on its own, never in Approve All. It expires in 7 days. The rules stay on until it is approved.',
      ].join('\n'));
      for (const n of [1, 2, 60]) {
        const said = rulesOffFiledSays({ deduped: false, rules: n });
        expect(noteProblems('Rule', said.split('\n').slice(1).join('\n')), said).toEqual([]);
        expect(said).not.toMatch(/\bpr[a-z0-9]{8,}|proposal|[()]/);
      }
      // The title is the console's own for that card (its Approvals panel builds it from the same words).
      const html = readFileSync(join(RUNTIME, '..', 'console', 'index.html'), 'utf8');
      expect(html).toContain(`'Switch Off 1 Rule'`);
      expect(html).toContain(`'Switch Off '+`);
      expect([rulesOffTitle(1), rulesOffTitle(2)]).toEqual(['Switch Off 1 Rule', 'Switch Off 2 Rules']);
    });

    it('lists what is on, files one card for the rules named (the same card when filed again), and files nothing it cannot', async () => {
      await pk.clear();
      const f = fam();
      const [wide, brake, gone] = await rules([{ pattern: `${f}.*`, tier: 'alone', dailyCap: 3 }, { pattern: `${f}.propose`, tier: 'approval' }, { pattern: `${f}.gone`, tier: 'alone' }]);
      await pk.switchOff(gone!.id);
      expect((await rulesOn(db)).map((r) => [r.id, r.pattern, r.tier, r.dailyCap, r.scoped])).toEqual([[wide!.id, `${f}.*`, 'alone', 3, false], [brake!.id, `${f}.propose`, 'approval', null, false]]);
      const filed = await proposeRulesOff(db, [brake!.id, wide!.id, brake!.id]);
      expect([filed.deduped, filed.rules, filed.tier]).toEqual([false, 2, 'approval']);
      const card = await db.proposal.findUniqueOrThrow({ where: { id: filed.id } });
      expect(card).toMatchObject({
        kind: 'policy', origin: 'cli', action: 'policy.change', status: 'pending', tainted: false, consequential: true, reason: 'Approving switches these rules off.',
        args: { off: [{ id: wide!.id, pattern: `${f}.*`, tier: 'alone' }, { id: brake!.id, pattern: `${f}.propose`, tier: 'approval' }] },
      });
      expect(card.expiresAt.getTime() - card.createdAt.getTime()).toBeLessThanOrEqual(7 * 86_400_000 + 1_000);
      // Again, in any order: the card that waits.
      expect(await proposeRulesOff(db, [wide!.id, brake!.id])).toMatchObject({ id: filed.id, deduped: true, rules: 2 });
      // Nothing is switched off by filing.
      expect((await rulesOn(db)).length).toBe(2);
      await expect(proposeRulesOff(db, [])).rejects.toMatchObject({ status: 400, message: RULES_SAY.none });
      await expect(proposeRulesOff(db, ['no-such-rule'])).rejects.toMatchObject({ status: 400, message: RULES_SAY.unknown });
      await expect(proposeRulesOff(db, [brake!.id, 'no-such-rule'])).rejects.toMatchObject({ status: 400, message: RULES_SAY.unknown });
      await expect(proposeRulesOff(db, ['not an id; DROP'])).rejects.toMatchObject({ status: 400, message: RULES_SAY.unknown });
      await expect(proposeRulesOff(db, [gone!.id])).rejects.toMatchObject({ status: 409, message: POLICY_OFF_SAYS.alreadyOff });
      expect(await db.proposal.count({ where: { action: 'policy.change', status: 'pending' } })).toBe(1);
      // Signed and run, both go off, and the list is empty.
      await sign(filed);
      expect(await run(filed.id)).toEqual({ off: 2 });
      expect(await rulesOn(db)).toEqual([]);
    });

    it('run for real: it lists the rules under their ids, files the card, and says one sentence when it cannot', async () => {
      await pk.clear();
      const f = fam();
      const [brake] = await rules([{ pattern: `${f}.propose`, tier: 'approval' }]);
      // A home of its own, so the command reads no settings but the ones given here.
      const home = mkdtempSync(join(tmpdir(), 'flint-rules-'));
      try {
        const env = { PATH: process.env.PATH ?? '', HOME: home, RUNTIME_ENV_FILE: join(home, 'none.env'), DATABASE_URL: urls.app, FLINT_TZ: TZ };
        const cli = (...args: string[]) => promisify(execFile)(join(RUNTIME, 'node_modules', '.bin', 'tsx'), [join(RUNTIME, 'src', 'cli.ts'), 'rules', ...args], { cwd: RUNTIME, env })
          .then((r) => ({ code: 0, stdout: r.stdout, stderr: r.stderr }), (e: { code?: number; stdout?: string; stderr?: string }) => ({ code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }));
        const listed = await cli();
        expect(listed.code, listed.stderr).toBe(0);
        expect(listed.stdout.trim().split('\n')).toEqual(rulesLines(await rulesOn(db), TZ));
        expect(listed.stdout).toContain(`  ${brake!.id}  Flint asks you each time before it runs `);
        const none = await cli('--off');
        expect([none.code, none.stdout.trim()]).toEqual([1, `Not filed: ${RULES_SAY.none}`]);
        const unknown = await cli('--off', 'no-such-rule');
        expect([unknown.code, unknown.stdout.trim()]).toEqual([1, `Not filed: ${RULES_SAY.unknown}`]);
        const wrong = await cli('--all');
        expect(wrong.code).toBe(1);
        expect(wrong.stderr).toContain('rules: run it alone to list your rules, or with --off <id>... to file the card that switches some off');
        expect(await db.proposal.count({ where: { action: 'policy.change', status: 'pending' } })).toBe(0);
        const filed = await cli('--off', brake!.id);
        expect(filed.code, filed.stderr).toBe(0);
        const card = await db.proposal.findFirstOrThrow({ where: { action: 'policy.change', status: 'pending' } });
        expect(filed.stdout.trim()).toBe(rulesOffFiledSays({ deduped: false, rules: 1 }));
        expect(filed.stdout).not.toContain(card.id);
        expect(card.args).toEqual({ off: [{ id: brake!.id, pattern: `${f}.propose`, tier: 'approval' }] });
        expect((await cli('--off', brake!.id)).stdout.trim()).toBe(rulesOffFiledSays({ deduped: true, rules: 1 }));
        // Still on: the command files a card and switches nothing off.
        expect((await db.actionPolicy.findUniqueOrThrow({ where: { id: brake!.id } })).active).toBe(true);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  });
});
