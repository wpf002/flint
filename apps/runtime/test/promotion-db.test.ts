/**
 * The P2 promotion table: refused before the shadow week is over; its rows
 * meet the policy rules (and the database's, once signed); what must stay at
 * APPROVAL is never in it; Will can drop a row; filing it twice is one card.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolveTier } from '@flint/policy';
import { NO_DB, freshDb, withClient, type TestUrls } from './db';
import { enrollTestKey } from './sign';
import { createDb, type Db } from '../src/db';
import { approveProposal, activePolicies, Refused } from '../src/governance/proposals';
import { runInternal, PolicyArgs } from '../src/governance/internal';
import { markProcessed, recordEvent } from '../src/events/record';
import { promotionTable, NEVER_PROMOTED, P2_PROMOTIONS } from '../src/governance/promotion';

const DAY = 86_400_000;

describe.skipIf(NO_DB)('the P2 promotion table', () => {
  let urls: TestUrls;
  let db: Db;
  beforeAll(async () => {
    urls = await freshDb();
    db = createDb(urls.app);
  });
  afterAll(async () => db?.$disconnect());

  async function shadowDecision(daysAgo: number) {
    const at = new Date(Date.now() - daysAgo * DAY);
    const ev = await db.$transaction(async (tx) => {
      const id = (await recordEvent(tx, { source: 'runtime', sourceRef: `p:${daysAgo}:${Math.random()}`, type: 'backup.stale', occurredAt: at, sensitivity: 'ops', tainted: false, payload: {} }, at))!;
      await markProcessed(tx, id, 'applied', at);
      return id;
    });
    await db.triageDecision.create({ data: { id: `tdp${daysAgo}x${Math.random().toString(36).slice(2, 7)}`, sourceEventId: ev, action: 'log', lane: 'relevant', decidedBy: 'default', sensitivity: 'ops', shadow: true, createdAt: at } });
  }

  it('is refused before 7 days of shadow decisions', async () => {
    await expect(promotionTable(db)).rejects.toThrow(/shadow week is not over: 0 of 7/);
    await shadowDecision(3);
    await expect(promotionTable(db)).rejects.toThrow(Refused);
  });

  it('after the week: rows meet the policy rules, keep push at 3 a day, and leave out what stays at APPROVAL', async () => {
    await shadowDecision(8);
    const t = await promotionTable(db, { drop: ['world.sync.knowledge'] });
    expect(PolicyArgs.safeParse({ rows: t.rows }).success).toBe(true);
    const patterns = t.rows.map((r) => r.pattern);
    for (const never of NEVER_PROMOTED) expect(patterns).not.toContain(never);
    expect(patterns).not.toContain('world.sync.knowledge');
    expect(patterns).toHaveLength(P2_PROMOTIONS.length - 1);
    expect(t.rows.find((r) => r.pattern === 'notify.push')).toMatchObject({ dailyCap: 3, tier: 'alone' });
    expect(t.rows.every((r) => /^P2 shadow week: [\d.]+ relevant a day; precision (n\/a|\d+%) over \d+ marked$/.test(r.reason))).toBe(true);
    // Filing it again is the same card.
    const again = await promotionTable(db, { drop: ['world.sync.knowledge'] });
    expect(again).toMatchObject({ proposalId: t.proposalId, deduped: true });

    // Signed, the database takes every row, and the actions resolve to ALONE.
    const key = await enrollTestKey(urls);
    const p = await db.proposal.findUniqueOrThrow({ where: { id: t.proposalId } });
    await approveProposal(db, p.id, await key.approve({ subjectId: p.id, action: 'policy.change', argsDigest: p.argsDigest }), undefined, 'test');
    expect(await runInternal(db, p.id, undefined, 'UTC', 'test')).toEqual({ rows: t.rows.length });
    const policies = await activePolicies(db);
    expect(resolveTier('triage.rule', { context: 'autonomous', tainted: false, policies }).tier).toBe('alone');
    // Never ALONE: on its own, neither is an autonomous action at all.
    for (const a of NEVER_PROMOTED) expect(resolveTier(a, { context: 'autonomous', tainted: false, policies }).tier).not.toBe('alone');
    expect(Number((await withClient(urls.owner, (c) => c.query(`SELECT count(*) AS n FROM "ActionPolicy" WHERE tier = 'alone'`))).rows[0].n)).toBe(t.rows.length);
  });
});
