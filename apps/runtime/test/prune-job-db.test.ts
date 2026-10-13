/**
 * `prune` as it is run (src/backup/prune-job.ts; the action `backup.prune`),
 * on flint_test with a scratch home:
 *  - by hand it lists what would go and removes nothing without `--remove`;
 *  - the nightly job files one card on a night there is something to remove,
 *    and removes nothing until Will approves it. The card says how much would
 *    go and cannot be undone. It signs those copies and no others: a run on it
 *    removes only copies on its list that are still the same files and may
 *    still go, never more than it said, and nothing at all when the folder
 *    changed so that none of them may (the next night files a new card);
 *  - a promotion signed for the backups as a group does not let it run: only
 *    one that names it does, and then once a day;
 *  - a rule of Will's that forbids it is honoured by the nightly job and by
 *    hand; nothing in chat can ask for it, and no look-alike card can take a
 *    nightly job's card's place;
 *  - the audit trail says a run is starting before anything goes, and what it
 *    did after, by count and size, never by name;
 *  - what follows `prune` on the command line: nothing lists, `--remove`
 *    removes, and anything else is refused.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { noteProblems } from '@flint/policy';
import { NO_DB, freshDb, withClient, type TestUrls } from './db';
import { enrollTestKey } from './sign';
import { createDb, type Db } from '../src/db';
import { approveProposal, createProposal } from '../src/governance/proposals';
import { runInternal } from '../src/governance/internal';
import { gate } from '../src/backup/nightly';
import { planPrune, preMigrateDir, type Copy, type PrunePlan } from '../src/backup/prune';
import { PRUNE_ACTION, digestOf, keepSigned, megabytes, onCard, pruneJob, pruneLines, pruneMode, readSigned, signedDir, signedFor, type PruneOutcome } from '../src/backup/prune-job';

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
  const intents = () => db.auditEntry.findMany({ where: { action: PRUNE_ACTION, kind: 'intent' }, orderBy: { seq: 'asc' }, select: { seq: true, actor: true, context: true, outcome: true, inputs: true, correlationId: true } });
  /** A copy `days` old, `bytes` long. */
  const copy = (n: number, now: Date, days: number, bytes = 2_000_000) => {
    const file = join(dir, `${sha(n)}.dump`);
    writeFileSync(file, Buffer.alloc(bytes));
    utimesSync(file, (now.getTime() - days * DAY) / 1000, (now.getTime() - days * DAY) / 1000);
  };
  /** As on another day: the one run a day it may have, on a card or not, is counted in the database. */
  const anotherDay = () => withClient(urls.owner, (c) => c.query(`DELETE FROM "ActionCounter" WHERE action = $1`, [PRUNE_ACTION]));
  /** Tonight's card filed and approved. (A card lives by the clock: it is filed, approved and claimed now.) */
  const approvedCard = async (now: Date) => {
    await anotherDay();
    expect(await run('auto', now)).toMatchObject({ did: 'waiting' });
    const card = (await cards()).filter((c) => c.status === 'pending').at(-1)!;
    await approveProposal(db, card.id, await key.approve({ subjectId: card.id, action: PRUNE_ACTION, argsDigest: card.argsDigest }), undefined, 'test');
    return card;
  };
  const lists = () => (existsSync(signedDir(home)) ? readdirSync(signedDir(home)).sort() : []);

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
    const result = await db.auditEntry.findFirstOrThrow({ where: { action: PRUNE_ACTION, kind: 'action' }, select: { seq: true, actor: true, context: true, outcome: true, inputs: true, correlationId: true } });
    expect(result).toMatchObject({ actor: 'will:cli', context: 'console', outcome: 'ok', inputs: { removed: 4, megabytes: 8, kept: 10, failed: 0 }, correlationId: expect.stringMatching(/^prune[a-z0-9]+$/) });
    // Said before anything went: that a run was starting, how many copies and how much, under the same mark as its result.
    const began = await intents();
    expect(began).toEqual([{ seq: expect.any(BigInt), actor: 'will:cli', context: 'console', outcome: 'pending', inputs: { copies: 4, megabytes: 8 }, correlationId: result.correlationId }]);
    expect(began[0]!.seq < result.seq).toBe(true);
    // Again, there is nothing left to remove, and nothing more is written down.
    const again = await run('remove', now);
    expect(again).toMatchObject({ did: 'nothing', would: 0, kept: 10 });
    expect(pruneLines(again)).toEqual(['There is nothing to remove. Flint keeps all 10 update backups it has.']);
    expect(await audits()).toHaveLength(1);
    expect(await intents()).toHaveLength(1);
  });

  it('by hand: nothing goes unless the audit trail could first be told a run is starting', async () => {
    const now = new Date();
    fourteen(now);
    const before = (await audits()).length;
    // The database stops taking audit entries (it is down, or full) between the listing and the removal.
    const deaf = new Proxy(db, {
      get: (t, k) => (k === 'auditEntry'
        ? new Proxy(t.auditEntry, { get: (a, m) => (m === 'createMany' ? async () => { throw new Error('the audit trail is not answering'); } : Reflect.get(a, m)) })
        : Reflect.get(t, k)),
    });
    await expect(pruneJob(deaf, { home, tz: 'UTC', rp: undefined, now, mode: 'remove', warn: () => {} })).rejects.toThrow('the audit trail is not answering');
    expect(names()).toHaveLength(14);
    expect(await audits()).toHaveLength(before);
    // Listing asks nothing of it.
    expect(await pruneJob(deaf, { home, tz: 'UTC', rp: undefined, now, mode: 'list', warn: () => {} })).toMatchObject({ did: 'listed', would: 4 });
    for (const i of [10, 11, 12, 13]) rmSync(join(dir, `${sha(i)}.dump`));
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
      // How many, how much, and which: a digest of the four copies' names, sizes and times.
      args: { day: now.toISOString().slice(0, 10), copies: 4, megabytes: 8, digest: digestOf(planPrune(home, now).remove) },
      reason: 'It waits for your approval each night there are old backups to remove, until you let it run on its own.',
    });
    expect((card!.args as { digest: string }).digest).toMatch(/^[0-9a-f]{64}$/);
    expect(card!.expiresAt.getTime() - card!.createdAt.getTime()).toBeGreaterThanOrEqual(26 * 3_600_000 - 1000);
    // The list the card signs is kept beside Flint's state, for this user alone, named for its digest.
    expect(lists()).toEqual([`${(card!.args as { digest: string }).digest}.json`]);
    expect(statSync(signedDir(home)).mode & 0o777).toBe(0o700);
    expect(statSync(join(signedDir(home), lists()[0]!)).mode & 0o777).toBe(0o600);
    // Later the same night: the same card, and still nothing removed.
    expect(await run('auto', new Date(now.getTime() + 60_000))).toMatchObject({ did: 'waiting' });
    expect(await cards()).toHaveLength(1);
    expect(names()).toHaveLength(14);

    // He approves it. Before the job runs again four older, larger copies appear, and two young ones (which push
    // two more out of the newest ten): ten may go now, 24 MB, and the four the card was filed for are not the oldest.
    await approveProposal(db, card!.id, await key.approve({ subjectId: card!.id, action: PRUNE_ACTION, argsDigest: card!.argsDigest }), undefined, 'test');
    for (const i of [30, 31, 32, 33]) copy(i, now, 200 + i, 3_000_000);
    for (const i of [20, 21]) copy(i, now, 1, 1000);
    const before = names();
    const done = await run('auto', new Date(now.getTime() + 120_000));
    // Only the four he signed, and no more room than the card said: the four that appeared wait for a card of their own.
    expect(done).toEqual({ did: 'removed', would: 10, megabytes: 8, kept: 16, removed: 4, failed: 0 });
    expect(before.filter((f) => !names().includes(f))).toEqual([10, 11, 12, 13].map((i) => `${sha(i)}.dump`));
    for (const i of [30, 31, 32, 33]) expect(existsSync(join(dir, `${sha(i)}.dump`))).toBe(true);
    expect((await db.proposal.findUniqueOrThrow({ where: { id: card!.id } })).status).toBe('executed');
    const audit = await audits();
    expect(audit.at(-1)).toEqual({ actor: 'runtime', context: 'autonomous', outcome: 'ok', inputs: { removed: 4, megabytes: 8, kept: 16, failed: 0 }, correlationId: card!.id });
    // The card's claim said a run was starting before anything went.
    expect((await intents()).filter((i) => i.correlationId === card!.id)).toHaveLength(1);
    // Nothing in the audit or on the card is a file's name or a commit.
    expect(JSON.stringify([audit.map((a) => a.inputs), (await cards()).map((c) => [c.args, c.reason, c.result])])).not.toMatch(/\b[0-9a-f]{40}\b|\.dump|pre-migrate/);
    // Its list is no longer kept: no card that could still run names it.
    expect(lists()).toEqual([]);
    // The next night: a new card, for what is left.
    const next = await run('auto', new Date(now.getTime() + DAY));
    expect(next).toMatchObject({ did: 'waiting', would: 6, megabytes: 16 });
    expect((await cards()).filter((c) => c.status === 'pending').map((c) => [(c.args as { copies: number }).copies, (c.args as { megabytes: number }).megabytes])).toEqual([[6, 16]]);
    expect(lists()).toHaveLength(1);
  });

  it('a card signs its copies and no others: when none of them may go any more it removes nothing, and the next night files a new card', async () => {
    const now = new Date();
    fourteen(now);
    const card = await approvedCard(now);
    expect(card.args).toMatchObject({ copies: 4, megabytes: 8 });
    // Before the run the folder changes: the four it signed are gone (removed by hand), and four others have grown old.
    for (const i of [10, 11, 12, 13]) rmSync(join(dir, `${sha(i)}.dump`));
    for (const i of [40, 41, 42, 43]) copy(i, now, 100 + i);
    const ran = await run('auto', new Date(now.getTime() + 60_000));
    expect(ran).toEqual({ did: 'removed', would: 4, megabytes: 0, kept: 14, removed: 0, failed: 0 });
    expect(names()).toHaveLength(14);
    expect((await db.proposal.findUniqueOrThrow({ where: { id: card.id } })).status).toBe('executed');
    expect((await audits()).at(-1)).toMatchObject({ outcome: 'ok', inputs: { removed: 0, megabytes: 0, kept: 14, failed: 0 }, correlationId: card.id });
    // The next night's run files a new card, for the four that may go now.
    await anotherDay();
    const next = await run('auto', new Date(now.getTime() + DAY));
    expect(next).toMatchObject({ did: 'waiting', would: 4 });
    const pending = (await cards()).filter((c) => c.status === 'pending');
    expect(pending).toHaveLength(1);
    expect(pending[0]!.id).not.toBe(card.id);
    expect((pending[0]!.args as { digest: string }).digest).not.toBe((card.args as { digest: string }).digest);
  });

  it('on a card, a copy that is not the file it signed, or that the rule no longer lets go, stays', async () => {
    const now = new Date();
    fourteen(now);
    const card = await approvedCard(now);
    expect(card.args).toMatchObject({ copies: 4, megabytes: 8 });
    // 13: written again since (the same name, a new file). 12: the same time, another size.
    copy(13, now, 0.001);
    const was = statSync(join(dir, `${sha(12)}.dump`));
    writeFileSync(join(dir, `${sha(12)}.dump`), Buffer.alloc(9_000_000));
    utimesSync(join(dir, `${sha(12)}.dump`), was.atime, was.mtime);
    // 11: now the copy taken before the release that is running, which is always kept.
    const current = join(home, '.flint', 'runtime', 'current');
    const release = join(home, '.flint', 'runtime', 'releases', sha(11));
    mkdirSync(release, { recursive: true });
    rmSync(current);
    symlinkSync(release, current);
    try {
      const ran = await run('auto', new Date(now.getTime() + 60_000));
      // Only 10 is still what he signed and may still go.
      expect(ran).toMatchObject({ did: 'removed', removed: 1, megabytes: 2, failed: 0 });
      expect(names()).toEqual(Array.from({ length: 14 }, (_, i) => `${sha(i)}.dump`).filter((n) => n !== `${sha(10)}.dump`));
    } finally {
      rmSync(current);
      symlinkSync(join(home, '.flint', 'runtime', 'releases', sha(999)), current);
    }
  });

  it('a card whose list is gone, or is not the list it signed, removes nothing once the folder has changed', async () => {
    const tampered: Array<[string, (file: string, listed: Copy[]) => void]> = [
      ['gone', (file) => rmSync(file)],
      ['one more name', (file, listed) => writeFileSync(file, JSON.stringify([...listed, { name: `${sha(5)}.dump`, bytes: 2_000_000, mtimeMs: 1 }]))],
      ['other names', (file, listed) => writeFileSync(file, JSON.stringify(listed.map((c, i) => ({ ...c, name: `${sha(i)}.dump` }))))],
      ['not a list', (file) => writeFileSync(file, '{"name":"../../victim"}')],
      ['a link to a list', (file, listed) => {
        writeFileSync(join(home, 'elsewhere.json'), JSON.stringify(listed));
        rmSync(file);
        symlinkSync(join(home, 'elsewhere.json'), file);
      }],
    ];
    for (const [what, change] of tampered) {
      const now = new Date();
      fourteen(now);
      const card = await approvedCard(now);
      const file = join(signedDir(home), `${(card.args as { digest: string }).digest}.json`);
      change(file, JSON.parse(readFileSync(file, 'utf8')) as Copy[]);
      // One more copy has grown old since: which four he signed can no longer be told from the folder.
      copy(50, now, 300);
      const ran = await run('auto', new Date(now.getTime() + 60_000));
      expect(ran, what).toMatchObject({ did: 'removed', would: 5, removed: 0, kept: 15 });
      expect(names(), what).toHaveLength(15);
    }
    // With the folder just as it was when the card was filed, what may go tonight is the list: it gives the card's
    // digest, so nothing more is needed to know what he signed.
    const now = new Date();
    fourteen(now);
    const card = await approvedCard(now);
    rmSync(join(signedDir(home), `${(card.args as { digest: string }).digest}.json`));
    expect(await run('auto', new Date(now.getTime() + 60_000))).toMatchObject({ did: 'removed', would: 4, removed: 4, kept: 10 });
  });

  it('a card that says nothing it can count removes nothing: what he signed is the most that goes', async () => {
    const now = new Date();
    fourteen(now);
    await anotherDay();
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
    const now = new Date(Date.now() + 14 * DAY);
    fourteen(now);
    await anotherDay();
    await promote([{ pattern: 'backup.*', tier: 'alone', dailyCap: 5, expiresAt }]);
    expect(await run('auto', now)).toMatchObject({ did: 'waiting', why: 'waiting for Will to approve (or promote) it', removed: 0 });
    expect(names()).toHaveLength(14);
    await promote([{ pattern: PRUNE_ACTION, tier: 'alone', dailyCap: 1, expiresAt }]);
    const done = await run('auto', new Date(now.getTime() + 60_000));
    expect(done).toEqual({ did: 'removed', would: 4, megabytes: 8, kept: 10, removed: 4, failed: 0 });
    // On its own there is no card: the run says it is starting itself, before anything goes, and what it did after.
    const last = (await audits()).at(-1)!;
    expect(last).toMatchObject({ actor: 'runtime', context: 'autonomous', outcome: 'ok', correlationId: expect.stringMatching(/^prune[a-z0-9]+$/) });
    expect((await intents()).filter((i) => i.correlationId === last.correlationId)).toMatchObject([{ actor: 'runtime', context: 'autonomous', outcome: 'pending', inputs: { copies: 4, megabytes: 8 } }]);
    // More to remove the same day: it has had its one run.
    fourteen(now);
    expect(await run('auto', new Date(now.getTime() + 120_000))).toMatchObject({ did: 'waiting', why: 'the daily cap is reached', removed: 0 });
    expect(names()).toHaveLength(14);
    // A rule of Will's own that forbids it is honoured: by the nightly job, and by hand too.
    await promote([{ pattern: PRUNE_ACTION, tier: 'forbidden', expiresAt }]);
    const forbidden = await run('auto', new Date(now.getTime() + DAY));
    expect(forbidden.did).toBe('waiting');
    expect(forbidden.why).toMatch(/^forbidden: /);
    expect(names()).toHaveLength(14);
    const results = (await audits()).length;
    const byHand = await run('remove', new Date(now.getTime() + DAY));
    expect(byHand).toEqual({ did: 'forbidden', would: 4, megabytes: 8, kept: 10, removed: 0, failed: 0 });
    expect(names()).toHaveLength(14);
    expect(pruneLines(byHand)).toEqual(['A rule of yours says Flint never removes old update backups, so it removed nothing.']);
    // Refused, and written down as refused: no run started, and none is recorded.
    expect(await audits()).toHaveLength(results);
    expect(await db.auditEntry.findFirst({ where: { action: PRUNE_ACTION, kind: 'decision' }, orderBy: { seq: 'desc' }, select: { actor: true, context: true, decision: true, outcome: true, tier: true } }))
      .toEqual({ actor: 'will:cli', context: 'console', decision: 'deny', outcome: 'denied', tier: 'forbidden' });
    // Listing is not removing: he can still see what would go.
    expect(await run('list', new Date(now.getTime() + DAY))).toMatchObject({ did: 'listed', would: 4 });
  });

  it('nothing in chat can ask for it, and a look-alike of a nightly job’s card never takes that card’s place', async () => {
    const day = new Date().toISOString().slice(0, 10);
    const from = { source: 'template' as const, ref: 'nightly.prune', tainted: false };
    const lookalike = (origin: string, action: string, args: Record<string, unknown>) => createProposal(db, {
      kind: 'tool_call', origin, action, args, argsProvenance: Object.fromEntries(Object.keys(args).map((k) => [k, from])),
      tainted: false, sensitivity: 'ops', destructive: false, consequential: false, ttlMinutes: 60,
    }, 'test');
    // Removing old backups: forbidden from chat outright, so no card of that kind is ever filed there.
    await expect(lookalike('chat:abc', PRUNE_ACTION, { day, copies: 4, megabytes: 8, digest: 'a'.repeat(64) })).rejects.toThrow(/forbidden: backup\.prune is never asked for from chat/);
    // The restore test may be asked for in chat. A card filed there with this week's very args is pending first...
    const now = new Date();
    const fake = await lookalike('chat:abc', 'restore.drill', { day });
    expect(fake.deduped).toBe(false);
    // ...and the job still files its own card beside it, never handed the look-alike in its place.
    expect(await gate(db, 'drill', 'UTC', undefined, now)).toMatchObject({ go: false, why: 'waiting for Will to approve (or promote) it' });
    const pending = await db.proposal.findMany({ where: { action: 'restore.drill', status: 'pending' }, orderBy: { createdAt: 'asc' }, select: { id: true, origin: true } });
    expect(pending.map((p) => p.origin)).toEqual(['chat:abc', 'runtime:drill']);
    // Asked for again in chat, it is the chat card again, never the job's.
    expect(await lookalike('chat:def', 'restore.drill', { day })).toMatchObject({ id: fake.id, deduped: true });
    // Approving the look-alike runs nothing; approving the job's own card lets its run go.
    await approveProposal(db, fake.id, await key.approve({ subjectId: fake.id, action: 'restore.drill', argsDigest: fake.argsDigest }), undefined, 'test');
    expect((await gate(db, 'drill', 'UTC', undefined, now)).go).toBe(false);
    const real = pending[1]!;
    const row = await db.proposal.findUniqueOrThrow({ where: { id: real.id } });
    await approveProposal(db, real.id, await key.approve({ subjectId: real.id, action: 'restore.drill', argsDigest: row.argsDigest }), undefined, 'test');
    expect(await gate(db, 'drill', 'UTC', undefined, now)).toMatchObject({ go: true, proposalId: real.id });
    // The other way round: only the job's card is waiting, and chat asks for the same thing. It gets a card of its
    // own, never the job's card handed back as if chat had filed it.
    expect((await gate(db, 'drill', 'UTC', undefined, now)).go).toBe(false);
    const waiting = await db.proposal.findMany({ where: { action: 'restore.drill', status: 'pending' }, select: { id: true, origin: true } });
    expect(waiting.map((p) => p.origin)).toEqual(['runtime:drill']);
    const asked = await lookalike('chat:ghi', 'restore.drill', { day });
    expect(asked).toMatchObject({ deduped: false });
    expect(asked.id).not.toBe(waiting[0]!.id);
  });

  it('when the running release cannot be told, it removes nothing and files no card', async () => {
    const now = new Date(Date.now() + 30 * DAY);
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
      { ...base, did: 'forbidden', would: 4, megabytes: 8, kept: 10 }, { ...base, did: 'removed', removed: 0, kept: 14 },
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
    // Every copy changed between the listing and the removal: nothing went, and it does not say "0 backups".
    expect(pruneLines(outcomes.at(-1)!)).toEqual(['Flint removed nothing. It keeps 14.']);
  });
});

describe('what follows `prune` on the command line', () => {
  it('nothing lists, --remove removes, --auto is the nightly job, and anything else is refused', () => {
    expect(pruneMode([])).toBe('list');
    expect(pruneMode(['--remove'])).toBe('remove');
    expect(pruneMode(['--auto'])).toBe('auto');
    const refused = [
      ['--yes'], ['-r'], ['--Remove'], ['--remove '], ['remove'], ['--remove=1'], ['--removed'], ['--', '--remove'], ['--remove', '--'], ['--auto', '--remove'], ['--remove', '--auto'],
      ['--remove', '--remove'], ['--auto', '--auto'], ['--remove', 'x'], ['--list'], [''], ['--force'], ['--dry-run'], ['-'], ['--remove\n'],
    ];
    for (const argv of refused) expect(() => pruneMode(argv), JSON.stringify(argv)).toThrow('usage: cli.ts prune [--remove] | prune --auto');
  });

  it('the command reads its options there and nowhere else', () => {
    const cli = readFileSync(join(__dirname, '..', 'src', 'cli.ts'), 'utf8');
    const body = cli.slice(cli.indexOf('async function pruneOldBackups('), cli.indexOf('async function main('));
    expect(body).toContain('const mode = pruneMode(argv);');
    expect(body).not.toMatch(/argv\.includes|process\.argv/);
    expect(cli).toContain("if (process.argv[2] === 'prune') return pruneOldBackups(process.argv.slice(3));");
  });
});

describe('what a card signs', () => {
  const NOW = new Date('2026-10-12T18:00:00Z');
  const old = (n: number, bytes = 2_000_000): Copy => ({ name: `${sha(n)}.dump`, bytes, mtimeMs: NOW.getTime() - (40 + n) * DAY });
  const plan = (remove: Copy[], kept = 10): PrunePlan => ({ dir: '/nowhere', folder: { dev: 1, ino: 1 }, remove, kept, bytes: remove.reduce((n, c) => n + c.bytes, 0) });
  let home: string;
  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'flint-prune-signed-'));
  });
  afterAll(() => rmSync(home, { recursive: true, force: true }));

  it('the count, the megabytes and a digest of every copy’s name, size and time, whatever order they come in', () => {
    const four = [old(13), old(12), old(11), old(10)];
    const signed = signedFor(four);
    expect(signed).toEqual({ copies: 4, megabytes: 8, digest: digestOf([...four].reverse()) });
    expect(signed.digest).toMatch(/^[0-9a-f]{64}$/);
    // Another name, another size, another time, one more, one fewer: each is another digest.
    const others = [[old(13), old(12), old(11), old(9)], [old(13), old(12), old(11), old(10, 2_000_001)], [old(13), old(12), old(11), { ...old(10), mtimeMs: 5 }], [...four, old(14)], four.slice(1)];
    expect(new Set([signed.digest, ...others.map(digestOf)]).size).toBe(6);
    expect(signedFor([])).toMatchObject({ copies: 0, megabytes: 0 });
  });

  it('a run on a card removes only what is on its list, still the same file, and never more copies or more room than it said', () => {
    const four = [old(13), old(12), old(11), old(10)];
    const signed = { card: signedFor(four), copies: four };
    // Nothing changed: all four.
    expect(onCard(plan(four), signed)).toMatchObject({ remove: four, kept: 10, bytes: 8_000_000 });
    // Four older, larger copies appeared: they are not on the list, and stay.
    const newcomers = [old(33, 50_000_000), old(32, 50_000_000), old(31, 50_000_000), old(30, 50_000_000)];
    expect(onCard(plan([...newcomers, ...four]), signed)).toMatchObject({ remove: four, kept: 14, bytes: 8_000_000 });
    // One of the four no longer qualifies (it is not in tonight's plan): the other three.
    expect(onCard(plan([old(13), old(12), old(10)], 11), signed).remove).toEqual([old(13), old(12), old(10)]);
    // One is another file under the same name: left.
    expect(onCard(plan([old(13), { ...old(12), bytes: 9 }, { ...old(11), mtimeMs: 7 }, old(10)]), signed).remove).toEqual([old(13), old(10)]);
    // None of them may go any more: nothing.
    expect(onCard(plan(newcomers), signed)).toMatchObject({ remove: [], kept: 14, bytes: 0 });
    // No list to believe: nothing.
    expect(onCard(plan(four), undefined)).toMatchObject({ remove: [], kept: 14, bytes: 0 });
    // A card that said fewer copies, or less room, than its list holds is held to what it said.
    expect(onCard(plan(four), { card: { ...signed.card, copies: 2 }, copies: four }).remove).toEqual([old(13), old(12)]);
    expect(onCard(plan(four), { card: { ...signed.card, megabytes: 4 }, copies: four }).remove).toEqual([old(13), old(12)]);
    expect(onCard(plan(four), { card: { ...signed.card, megabytes: 0 }, copies: four }).remove).toEqual([]);
    for (const cut of [plan(four), plan([...newcomers, ...four])]) expect(megabytes(onCard(cut, signed).bytes)).toBeLessThanOrEqual(signed.card.megabytes);
  });

  it('the list is believed only when it is a plain file of this user’s that gives the card’s digest, count and megabytes', () => {
    const four = [old(13), old(12), old(11), old(10)];
    const card = signedFor(four);
    expect(readSigned(home, { day: '2026-10-12', ...card })).toBeUndefined();
    expect(keepSigned(home, four)).toBe(true);
    expect(readSigned(home, { day: '2026-10-12', ...card })).toEqual({ card, copies: four });
    // The card's own numbers: one that does not say them, or says them oddly, signed nothing.
    for (const args of [null, undefined, 'x', {}, { day: '2026-10-12' }, { ...card, copies: '4' }, { ...card, copies: 4.5 }, { ...card, copies: -1 }, { ...card, megabytes: null }, { ...card, digest: card.digest.toUpperCase() },
      { ...card, digest: `../${card.digest}` }, { ...card, digest: card.digest.slice(1) }, { ...card, copies: 3 }, { ...card, megabytes: 9 }, { ...card, digest: 'b'.repeat(64) }]) {
      expect(readSigned(home, args), JSON.stringify(args)).toBeUndefined();
    }
    // The file: anything but the list that gives the digest is not believed.
    const file = join(signedDir(home), `${card.digest}.json`);
    const good = readFileSync(file, 'utf8');
    for (const text of ['', 'not json', '[]', '{}', JSON.stringify(four.slice(1)), JSON.stringify([...four, old(9)]), JSON.stringify(four.map((c) => ({ ...c, extra: 1 }))),
      JSON.stringify([{ ...four[0]!, name: '../../victim' }, ...four.slice(1)]), JSON.stringify(four.map((c) => ({ ...c, bytes: c.bytes + 1 })))]) {
      writeFileSync(file, text);
      expect(readSigned(home, card), text.slice(0, 40)).toBeUndefined();
    }
    writeFileSync(file, good);
    expect(readSigned(home, card)?.copies).toEqual(four);
    // A link to a good list is not the list.
    writeFileSync(join(home, 'elsewhere.json'), good);
    rmSync(file);
    symlinkSync(join(home, 'elsewhere.json'), file);
    expect(readSigned(home, card)).toBeUndefined();
  });

  it('a list that cannot be kept is said, not thrown', () => {
    const blocked = mkdtempSync(join(tmpdir(), 'flint-prune-blocked-'));
    try {
      // Where the lists go is a file: nothing can be kept there.
      mkdirSync(join(blocked, '.flint'));
      writeFileSync(signedDir(blocked), 'in the way');
      expect(keepSigned(blocked, [old(1)])).toBe(false);
      expect(readSigned(blocked, signedFor([old(1)]))).toBeUndefined();
    } finally {
      rmSync(blocked, { recursive: true, force: true });
    }
  });
});
