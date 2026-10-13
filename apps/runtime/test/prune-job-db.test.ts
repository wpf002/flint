/**
 * `prune` as it is run (src/backup/prune-job.ts; the action `backup.prune`),
 * on flint_test with a scratch home:
 *  - by hand it lists what would go and removes nothing without `--remove`;
 *  - the nightly job files one card on a night there is something to remove,
 *    and removes nothing until Will approves it. The card says how much would
 *    go, cannot be undone, and a run on it removes no more than it said;
 *  - a promotion signed for the backups as a group does not let it run: only
 *    one that names it does, and then once a day;
 *  - what was removed is in the audit trail by count and size, never by name.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { noteProblems } from '@flint/policy';
import { NO_DB, freshDb, withClient, type TestUrls } from './db';
import { enrollTestKey } from './sign';
import { createDb, type Db } from '../src/db';
import { approveProposal, createProposal } from '../src/governance/proposals';
import { runInternal } from '../src/governance/internal';
import { preMigrateDir } from '../src/backup/prune';
import { PRUNE_ACTION, pruneJob, pruneLines, type PruneOutcome } from '../src/backup/prune-job';

const DAY = 86_400_000;
const sha = (n: number): string => n.toString(16).padStart(40, '0');

describe.skipIf(NO_DB)('removing old backups, as it is run (flint_test)', () => {
  let urls: TestUrls;
  let db: Db;
  let home: string;
  let dir: string;
  let key: Awaited<ReturnType<typeof enrollTestKey>>;
  const names = () => readdirSync(dir).sort();
  /** Fourteen copies, 40 to 53 days old, 2 MB each: the oldest four may go. */
  const fourteen = (now: Date) => {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 14; i++) {
      const file = join(dir, `${sha(i)}.dump`);
      writeFileSync(file, Buffer.alloc(2_000_000));
      utimesSync(file, (now.getTime() - (40 + i) * DAY) / 1000, (now.getTime() - (40 + i) * DAY) / 1000);
    }
  };
  const run = (mode: 'auto' | 'list' | 'remove', now: Date) => pruneJob(db, { home, tz: 'UTC', rp: undefined, now, mode, warn: () => {} });
  const cards = () => db.proposal.findMany({ where: { action: PRUNE_ACTION }, orderBy: { createdAt: 'asc' } });
  const audits = () => db.auditEntry.findMany({ where: { action: PRUNE_ACTION, kind: 'action' }, orderBy: { at: 'asc' }, select: { actor: true, context: true, outcome: true, inputs: true, correlationId: true } });

  beforeAll(async () => {
    urls = await freshDb();
    db = createDb(urls.app);
    key = await enrollTestKey(urls);
    home = mkdtempSync(join(tmpdir(), 'flint-prune-job-'));
    dir = preMigrateDir(home);
    const release = join(home, '.flint', 'runtime', 'releases', sha(999));
    mkdirSync(release, { recursive: true });
    symlinkSync(release, join(home, '.flint', 'runtime', 'current'));
  });
  afterAll(async () => {
    await db?.$disconnect();
    if (home) rmSync(home, { recursive: true, force: true });
  });

  it('by hand: it lists what would go, by count and size, and removes nothing until told to', async () => {
    const now = new Date();
    fourteen(now);
    const listed = await run('list', now);
    expect(listed).toEqual({ did: 'listed', would: 4, megabytes: 8, kept: 10, removed: 0, failed: 0 });
    expect(names()).toHaveLength(14);
    expect(pruneLines(listed)).toEqual(['Flint would remove 4 old update backups, which frees 8 MB. It keeps 10.', 'To remove them, run this again with --remove.']);
    expect(await cards()).toEqual([]);
    expect(await audits()).toEqual([]);
    const removed = await run('remove', now);
    expect(removed).toEqual({ did: 'removed', would: 4, megabytes: 8, kept: 10, removed: 4, failed: 0 });
    expect(names()).toEqual(Array.from({ length: 10 }, (_, i) => `${sha(i)}.dump`));
    expect(pruneLines(removed)).toEqual(['Flint removed 4 old update backups, which freed 8 MB. It keeps 10.']);
    // It is Will acting, at the keyboard: no card, and an audit entry that says so.
    expect(await cards()).toEqual([]);
    expect(await audits()).toEqual([{ actor: 'will:cli', context: 'console', outcome: 'ok', inputs: { removed: 4, megabytes: 8, kept: 10, failed: 0 }, correlationId: null }]);
    // Again, there is nothing left to remove, and nothing more is written down.
    const again = await run('remove', now);
    expect(again).toMatchObject({ did: 'nothing', would: 0, kept: 10 });
    expect(pruneLines(again)).toEqual(['There is nothing to remove. Flint keeps all 10 update backups it has.']);
    expect(await audits()).toHaveLength(1);
  });

  it('the nightly job: no card for nothing; one card on a night there is something to remove; nothing goes until Will approves it', async () => {
    const now = new Date();
    // Ten copies, nothing to remove: it ends at once.
    expect(await run('auto', now)).toMatchObject({ did: 'nothing' });
    expect(await cards()).toEqual([]);
    fourteen(now);
    const waiting = await run('auto', now);
    expect(waiting).toMatchObject({ did: 'waiting', would: 4, megabytes: 8, removed: 0, why: 'waiting for Will to approve (or promote) it' });
    expect(names()).toHaveLength(14);
    const [card, ...more] = await cards();
    expect(more).toEqual([]);
    expect(card).toMatchObject({
      origin: 'runtime:prune', templateId: 'nightly.prune', status: 'pending', tainted: false, consequential: false,
      // It deletes: the console marks the card as one that cannot be undone, and asks for it on its own.
      destructive: true,
      args: { day: now.toISOString().slice(0, 10), copies: 4, megabytes: 8 },
      reason: 'It waits for your approval each night there are old backups to remove, until you let it run on its own.',
    });
    expect(card!.expiresAt.getTime() - card!.createdAt.getTime()).toBeGreaterThanOrEqual(26 * 3_600_000 - 1000);
    // Later the same night: the same card, and still nothing removed.
    expect(await run('auto', new Date(now.getTime() + 60_000))).toMatchObject({ did: 'waiting' });
    expect(await cards()).toHaveLength(1);
    expect(names()).toHaveLength(14);

    // He approves it. Before the job runs again, two more copies grow old enough to go (six now, the card said four).
    await approveProposal(db, card!.id, await key.approve({ subjectId: card!.id, action: PRUNE_ACTION, argsDigest: card!.argsDigest }), undefined, 'test');
    for (const i of [8, 9]) utimesSync(join(dir, `${sha(i)}.dump`), (now.getTime() - 90 * DAY) / 1000, (now.getTime() - 90 * DAY) / 1000);
    for (const i of [20, 21]) {
      writeFileSync(join(dir, `${sha(i)}.dump`), Buffer.alloc(1000));
      utimesSync(join(dir, `${sha(i)}.dump`), (now.getTime() - DAY) / 1000, (now.getTime() - DAY) / 1000);
    }
    const before = names();
    const done = await run('auto', new Date(now.getTime() + 120_000));
    // No more than the card said: the four oldest, and the other two wait for their own card.
    expect(done).toEqual({ did: 'removed', would: 6, megabytes: 8, kept: 12, removed: 4, failed: 0 });
    expect(before.filter((f) => !names().includes(f))).toEqual([8, 9, 13, 12].map((i) => `${sha(i)}.dump`).sort());
    expect((await db.proposal.findUniqueOrThrow({ where: { id: card!.id } })).status).toBe('executed');
    const audit = await audits();
    expect(audit.at(-1)).toEqual({ actor: 'runtime', context: 'autonomous', outcome: 'ok', inputs: { removed: 4, megabytes: 8, kept: 12, failed: 0 }, correlationId: card!.id });
    // Nothing in the audit or on the card is a file's name or a commit.
    expect(JSON.stringify([audit.map((a) => a.inputs), (await cards()).map((c) => [c.args, c.reason, c.result])])).not.toMatch(/\b[0-9a-f]{40}\b|\.dump|pre-migrate/);
    // The next night: a new card, for what is left.
    const next = await run('auto', new Date(now.getTime() + DAY));
    expect(next).toMatchObject({ did: 'waiting', would: 2 });
    expect((await cards()).filter((c) => c.status === 'pending').map((c) => (c.args as { copies: number }).copies)).toEqual([2]);
  });

  it('a card that says nothing it can count removes nothing: what he signed is the most that goes', async () => {
    const now = new Date();
    fourteen(now);
    // (As on another day: the one run a day it may have, on a card or not, is counted in the database.)
    await withClient(urls.owner, (c) => c.query(`DELETE FROM "ActionCounter" WHERE action = $1`, [PRUNE_ACTION]));
    // A card for this action filed some other way, with no count on it (an older Flint's, say), and approved.
    const bare = await createProposal(db, {
      kind: 'tool_call', origin: 'runtime:prune', templateId: 'nightly.prune', action: PRUNE_ACTION, args: { day: now.toISOString().slice(0, 10) },
      argsProvenance: { day: { source: 'template', ref: 'nightly.prune', tainted: false } }, tainted: false, sensitivity: 'ops', destructive: true, consequential: false, ttlMinutes: 60,
    }, 'runtime');
    await approveProposal(db, bare.id, await key.approve({ subjectId: bare.id, action: PRUNE_ACTION, argsDigest: bare.argsDigest }), undefined, 'test');
    const ran = await run('auto', now);
    expect(ran, ran.why).toMatchObject({ did: 'removed', removed: 0, kept: 14 });
    expect(names()).toHaveLength(14);
  });

  it('a promotion signed for the backups as a group does not let it run on its own; one that names it does, once a day', async () => {
    const expiresAt = new Date(Date.now() + 60 * DAY).toISOString();
    const promote = async (rows: Array<Record<string, unknown>>) => {
      const card = await createProposal(db, { kind: 'policy', origin: 'console', action: 'policy.change', args: { rows }, argsProvenance: {}, tainted: false, sensitivity: 'ops', destructive: false, consequential: true, ttlMinutes: 60 }, 'test');
      await approveProposal(db, card.id, await key.approve({ subjectId: card.id, action: 'policy.change', argsDigest: card.argsDigest }), undefined, 'test');
      await runInternal(db, card.id, undefined, 'UTC', 'test');
    };
    const now = new Date(Date.now() + 10 * DAY);
    fourteen(now);
    await promote([{ pattern: 'backup.*', tier: 'alone', dailyCap: 5, expiresAt }]);
    expect(await run('auto', now)).toMatchObject({ did: 'waiting', why: 'waiting for Will to approve (or promote) it', removed: 0 });
    expect(names()).toHaveLength(14);
    await promote([{ pattern: PRUNE_ACTION, tier: 'alone', dailyCap: 1, expiresAt }]);
    const done = await run('auto', new Date(now.getTime() + 60_000));
    expect(done).toEqual({ did: 'removed', would: 4, megabytes: 8, kept: 10, removed: 4, failed: 0 });
    expect((await audits()).at(-1)).toMatchObject({ actor: 'runtime', context: 'autonomous', outcome: 'ok', correlationId: null });
    // More to remove the same day: it has had its one run.
    fourteen(now);
    expect(await run('auto', new Date(now.getTime() + 120_000))).toMatchObject({ did: 'waiting', why: 'the daily cap is reached', removed: 0 });
    expect(names()).toHaveLength(14);
    // A rule of Will's own that forbids it is honoured, by hand's own path too (the card gate is the job's alone).
    await promote([{ pattern: PRUNE_ACTION, tier: 'forbidden', expiresAt }]);
    const forbidden = await run('auto', new Date(now.getTime() + DAY));
    expect(forbidden.did).toBe('waiting');
    expect(forbidden.why).toMatch(/^forbidden: /);
    expect(names()).toHaveLength(14);
  });

  it('when the running release cannot be told, it removes nothing and files no card', async () => {
    const now = new Date(Date.now() + 20 * DAY);
    fourteen(now);
    const current = join(home, '.flint', 'runtime', 'current');
    rmSync(current);
    try {
      const pending = (await cards()).filter((c) => c.status === 'pending').length;
      for (const mode of ['auto', 'remove', 'list'] as const) expect(await run(mode, now)).toMatchObject({ did: 'held', removed: 0 });
      expect(names()).toHaveLength(14);
      expect((await cards()).filter((c) => c.status === 'pending')).toHaveLength(pending);
    } finally {
      symlinkSync(join(home, '.flint', 'runtime', 'releases', sha(999)), current);
    }
    expect(existsSync(current)).toBe(true);
  });

  it('what it says by hand is whole sentences, with counts and sizes and never a name', () => {
    const base = { would: 0, megabytes: 0, kept: 0, removed: 0, failed: 0 };
    const outcomes: PruneOutcome[] = [
      { ...base, did: 'nothing' }, { ...base, did: 'nothing', kept: 1 }, { ...base, did: 'nothing', kept: 9 }, { ...base, did: 'held', kept: 14 },
      { ...base, did: 'listed', would: 1, megabytes: 1, kept: 10 }, { ...base, did: 'listed', would: 12, megabytes: 4096, kept: 10 },
      { ...base, did: 'waiting', would: 4, why: 'x' }, { ...base, did: 'removed', removed: 1, megabytes: 3, kept: 10 }, { ...base, did: 'failed', removed: 3, failed: 1, kept: 11 },
    ];
    for (const o of outcomes) {
      const lines = pruneLines(o);
      for (const l of lines) {
        expect(l, l).toMatch(/^[A-Z].*\.$/);
        // (The one line that names the option to add is a sentence too; the rest are held to the rules for a note.)
        if (!l.includes('--remove')) expect(noteProblems('Remove Old Backups', l), l).toEqual([]);
      }
      expect(lines.join(' ')).not.toMatch(/\(s\)|[()]|backup\.prune|pre-migrate|\.dump/);
    }
    expect(pruneLines(outcomes[4]!)[0]).toBe('Flint would remove 1 old update backup, which frees 1 MB. It keeps 10.');
    expect(pruneLines(outcomes[1]!)).toEqual(['There is nothing to remove. Flint keeps the 1 update backup it has.']);
    expect(pruneLines(outcomes[0]!)).toEqual(['There are no update backups to remove.']);
  });
});
