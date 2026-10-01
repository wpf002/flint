/**
 * The nightly backup gate (plan P1 backups; review of #41): one card a night,
 * living 26 hours so the next run claims it whenever Will approved it; older
 * pending cards withdrawn; an approved card claimed and run.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NO_DB, freshDb, type TestUrls } from './db';
import { enrollTestKey } from './sign';
import { createDb, type Db } from '../src/db';
import { gate } from '../src/backup/nightly';
import { approveProposal, createProposal } from '../src/governance/proposals';

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
    // A second run the same night files nothing new.
    await gate(db, 'backup', 'UTC', undefined, new Date());
    expect(await db.proposal.count({ where: { origin: 'runtime:backup', status: 'pending' } })).toBe(1);
    // Will approves it; the run claims it.
    const key = await enrollTestKey(urls);
    await approveProposal(db, tonight.id, await key.approve({ subjectId: tonight.id, action: 'backup.local', argsDigest: tonight.argsDigest }), undefined, 'test');
    expect(await gate(db, 'backup', 'UTC', undefined, new Date())).toMatchObject({ go: true, proposalId: tonight.id });
  });
});
