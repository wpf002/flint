/**
 * The nightly backup gate (plan P1 backups; review of #41): one card a night,
 * living 26 hours so the next run claims it whenever Will approved it; older
 * pending cards withdrawn; an approved card claimed and run. The drill runs on
 * Sundays only, so its card lives a week and two hours.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NO_DB, freshDb, withClient, type TestUrls } from './db';
import { enrollTestKey } from './sign';
import { createDb, type Db } from '../src/db';
import { gate, offerNextCard } from '../src/backup/nightly';
import { approveProposal, completeProposal, createProposal } from '../src/governance/proposals';
import { runInternal } from '../src/governance/internal';

describe.skipIf(NO_DB)('nightly gate', () => {
  let db: Db;
  let urls: TestUrls;
  beforeAll(async () => {
    urls = await freshDb();
    db = createDb(urls.app);
  });
  afterAll(async () => db?.$disconnect());

  it('files one card that outlives the next run, withdraws older ones, and runs the card Will approved', async () => {
    // An older card still pending (yesterday's).
    const older = await createProposal(db, {
      kind: 'tool_call', origin: 'runtime:backup', templateId: 'nightly.backup', action: 'backup.local', args: { day: '2026-09-30' },
      argsProvenance: { day: { source: 'template', ref: 'nightly.backup', tainted: false } }, tainted: false, sensitivity: 'ops', destructive: false, consequential: false, ttlMinutes: 60,
    }, 'runtime');
    await new Promise((r) => setTimeout(r, 5));
    const now = new Date();
    expect(await gate(db, 'backup', 'UTC', undefined, now)).toMatchObject({ go: false });
    const cards = await db.proposal.findMany({ where: { origin: 'runtime:backup' }, orderBy: { createdAt: 'asc' } });
    // Tonight's card filed; yesterday's withdrawn (a runtime rejection, no approval needed).
    expect(cards.map((c) => [c.id === older.id, c.status, (c.args as { day: string }).day])).toEqual([[true, 'rejected', '2026-09-30'], [false, 'pending', now.toISOString().slice(0, 10)]]);
    const tonight = cards[1]!;
    expect(tonight.expiresAt.getTime() - tonight.createdAt.getTime()).toBeGreaterThanOrEqual(26 * 3600_000 - 1000);
    expect(tonight.expiresAt.getTime() - tonight.createdAt.getTime()).toBeLessThan(27 * 3600_000);
    expect(tonight.reason).toBe('It waits for your approval each night until you let it run on its own.');
    // A second run the same night files nothing new.
    await gate(db, 'backup', 'UTC', undefined, new Date());
    expect(await db.proposal.count({ where: { origin: 'runtime:backup', status: 'pending' } })).toBe(1);
    // Will approves it; the run claims it.
    const key = await enrollTestKey(urls);
    await approveProposal(db, tonight.id, await key.approve({ subjectId: tonight.id, action: 'backup.local', argsDigest: tonight.argsDigest }), undefined, 'test');
    expect(await gate(db, 'backup', 'UTC', undefined, new Date())).toMatchObject({ go: true, proposalId: tonight.id });
  });

  it('the drill runs on Sundays only, so its card lives a week and two hours, and the next Sunday’s run claims it', async () => {
    const sunday = new Date();
    expect(await gate(db, 'drill', 'UTC', undefined, sunday)).toMatchObject({ go: false });
    const card = await db.proposal.findFirstOrThrow({ where: { origin: 'runtime:drill', status: 'pending' } });
    // Filed at 02:15 on a Sunday, it outlives 02:15 the next Sunday (a 169-hour DST week included).
    expect(card.expiresAt.getTime() - card.createdAt.getTime()).toBeGreaterThanOrEqual((7 * 24 + 2) * 3600_000 - 1000);
    expect(card.reason).toBe('It waits for your approval each week until you let it run on its own.');
    const key = await enrollTestKey(urls);
    await approveProposal(db, card.id, await key.approve({ subjectId: card.id, action: 'restore.drill', argsDigest: card.argsDigest }), undefined, 'test');
    // Approved on the day it was filed, it is still there for the run a week on.
    const nextSunday = new Date(sunday.getTime() + 7 * 24 * 3600_000);
    expect(await gate(db, 'drill', 'UTC', undefined, nextSunday)).toMatchObject({ go: true, proposalId: card.id });
  });

  it('a run on a card that fails files its next card at once, so "approve its next card in Approvals" points at one that is there', async () => {
    const pendingCards = () => db.proposal.findMany({ where: { origin: 'runtime:offsite', status: 'pending' }, orderBy: { createdAt: 'asc' } });
    const key = await enrollTestKey(urls);
    const sign = async (id: string) => {
      const p = await db.proposal.findUniqueOrThrow({ where: { id } });
      await approveProposal(db, id, await key.approve({ subjectId: id, action: 'backup.offsite', argsDigest: p.argsDigest }), undefined, 'test');
    };
    // Night one files tonight's card; Will approves it; the next run claims it and runs.
    const night1 = new Date();
    expect(await gate(db, 'offsite', 'UTC', undefined, night1)).toMatchObject({ go: false });
    const [first] = await pendingCards();
    await sign(first!.id);
    const night2 = new Date(night1.getTime() + 60_000);
    expect(await gate(db, 'offsite', 'UTC', undefined, night2)).toMatchObject({ go: true, proposalId: first!.id });
    // That run claimed its card and filed no other: until now, nothing was in Approvals after a failure.
    expect(await pendingCards()).toEqual([]);
    // It fails. cli.ts records that and files the next card straight away.
    await completeProposal(db, first!.id, { ok: false, error: 'age is not installed', result: {} }, 'runtime');
    await offerNextCard(db, 'offsite', 'UTC', undefined, night2);
    const [next, ...others] = await pendingCards();
    expect(others).toEqual([]);
    expect(next).toMatchObject({ action: 'backup.offsite', status: 'pending', reason: 'It waits for your approval each night until you let it run on its own.' });
    expect(next!.id).not.toBe(first!.id);
    // It outlives the next night's run, and offering it again is the same card.
    expect(next!.expiresAt.getTime() - next!.createdAt.getTime()).toBeGreaterThanOrEqual(26 * 3600_000 - 1000);
    await offerNextCard(db, 'offsite', 'UTC', undefined, night2);
    expect((await pendingCards()).map((c) => c.id)).toEqual([next!.id]);
    // Will approves it that day; the next night's run claims it and runs: the note's promise, kept.
    await sign(next!.id);
    // The next night is another day's cap of one (the test cannot wait a night: the owner clears today's count).
    await withClient(urls.owner, (c) => c.query(`DELETE FROM "ActionCounter" WHERE action = 'backup.offsite'`));
    expect(await gate(db, 'offsite', 'UTC', undefined, new Date())).toEqual({ go: true, proposalId: next!.id, why: 'approved by Will' });
  });

  it('promoted, a job runs once in its period, and a second run says so in real words: the daily cap, never "dayly"', async () => {
    const expiresAt = new Date(Date.now() + 30 * 86400_000).toISOString();
    const rows = [{ pattern: 'backup.local', tier: 'alone', dailyCap: 1, expiresAt }, { pattern: 'backup.offsite', tier: 'alone', dailyCap: 1, expiresAt }, { pattern: 'restore.drill', tier: 'alone', expiresAt }];
    const card = await createProposal(db, {
      kind: 'policy', origin: 'console', action: 'policy.change', args: { rows }, argsProvenance: {}, tainted: false, sensitivity: 'ops', destructive: false, consequential: true, ttlMinutes: 60,
    }, 'test');
    const key = await enrollTestKey(urls);
    await approveProposal(db, card.id, await key.approve({ subjectId: card.id, action: 'policy.change', argsDigest: card.argsDigest }), undefined, 'test');
    expect(await runInternal(db, card.id, undefined, 'UTC', 'test')).toEqual({ rows: 3 });
    // A Tuesday at least ten days on: a day and a week no other test in this file has claimed, inside the policy's life.
    const now = new Date(Date.now() + 10 * 86400_000);
    now.setUTCDate(now.getUTCDate() + ((2 - now.getUTCDay() + 7) % 7));
    for (const cmd of ['backup', 'offsite'] as const) {
      expect(await gate(db, cmd, 'UTC', undefined, now)).toEqual({ go: true, why: 'promoted' });
      expect(await gate(db, cmd, 'UTC', undefined, new Date(now.getTime() + 60_000))).toEqual({ go: false, why: 'the daily cap is reached' });
    }
    expect(await gate(db, 'drill', 'UTC', undefined, now)).toEqual({ go: true, why: 'promoted' });
    expect(await gate(db, 'drill', 'UTC', undefined, new Date(now.getTime() + 86400_000))).toEqual({ go: false, why: 'the weekly cap is reached' });
    // The next night (and the next week) it runs again by itself: what the failure note promises.
    expect(await gate(db, 'offsite', 'UTC', undefined, new Date(now.getTime() + 86400_000))).toEqual({ go: true, why: 'promoted' });
    expect(await gate(db, 'drill', 'UTC', undefined, new Date(now.getTime() + 7 * 86400_000))).toEqual({ go: true, why: 'promoted' });
  });
});
