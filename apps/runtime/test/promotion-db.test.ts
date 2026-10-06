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
import { promotionTable, NEVER_PROMOTED, P1_PROMOTIONS, P2_PROMOTIONS } from '../src/governance/promotion';

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
    const card = await db.proposal.findUniqueOrThrow({ where: { id: t.proposalId } });
    expect(card.reason).toMatch(/^This lets Flint sort events, send its notes and run its upkeep without asking until [A-Z][a-z]{2} \d{1,2}, \d{4}\. Lately [\d.]+ items a day were important, and (you haven’t rated any yet|the one you rated (was|wasn’t) useful|\d+ of the \d+ you rated were useful)\.$/);
    // Filing it again, later and after more decisions, is the same card.
    await shadowDecision(1);
    const again = await promotionTable(db, { drop: ['world.sync.knowledge'], now: new Date(Date.now() + 90_000) });
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

  it('P1: refused before a week of chat reads; then chat\'s reads of the world model and the ledger, predictions kept at 10 a day', async () => {
    await expect(promotionTable(db, { phase: 'p1' })).rejects.toThrow(/shadow week is not over: 0 of 7 days of chat reads/);
    // A chat read as chat files it, dated in the past (createProposal dates a card now, and the database refuses one born expired).
    const read = (daysAgo: number, tool = 'world_now', tainted = false) => {
      const at = new Date(Date.now() - daysAgo * DAY);
      return withClient(urls.owner, (c) => c.query(
        `INSERT INTO "Proposal" (id, kind, origin, action, args, "argsDigest", "argsProvenance", tainted, sensitivity, "expiresAt", "createdAt")
         VALUES ($1, 'tool_call', 'chat:t1', $2, '{}'::jsonb, $3, '{}'::jsonb, $4, 'ops', $5, $6)`,
        [`prp1${daysAgo}${tool.length}${Math.random().toString(36).slice(2, 8)}`, `mcp:runtime.${tool}`, 'a'.repeat(64), tainted, new Date(at.getTime() + DAY), at],
      ));
    };
    await read(2);
    await expect(promotionTable(db, { phase: 'p1' })).rejects.toThrow(/shadow week is not over: 2\.\d of 7 days of chat reads/);
    await read(8, 'ledger_open');
    await read(1, 'world_entity', true);
    const t = await promotionTable(db, { phase: 'p1' });
    expect(PolicyArgs.safeParse({ rows: t.rows }).success).toBe(true);
    expect(t.rows.map((r) => r.pattern).sort()).toEqual(P1_PROMOTIONS.map((r) => r.pattern).sort());
    expect(t.rows.find((r) => r.pattern === 'ledger_record_prediction')).toMatchObject({ dailyCap: 10, tier: 'alone' });
    const card = await db.proposal.findUniqueOrThrow({ where: { id: t.proposalId } });
    expect(card.templateId).toBe('p1.promotion');
    expect(card.reason).toMatch(/^This lets chat look things up and record predictions without asking until [A-Z][a-z]{2} \d{1,2}, \d{4}\. This week chat asked 2 times: 0 ran, 0 were rejected, 0 expired, and 1 had outside text\.$/);

    // Signed: a chat read of the world model no longer asks, and a tainted turn still cannot reach past its floor.
    const key = await enrollTestKey(urls);
    await approveProposal(db, card.id, await key.approve({ subjectId: card.id, action: 'policy.change', argsDigest: card.argsDigest }), undefined, 'test');
    expect(await runInternal(db, card.id, undefined, 'UTC', 'test')).toEqual({ rows: t.rows.length });
    const policies = await activePolicies(db);
    const chat = (tool: string) => resolveTier(`mcp:runtime.${tool}`, { context: 'chat', tainted: false, policies, mcp: { server: 'runtime', tool, destructiveHint: false } });
    expect(chat('world_now').tier).toBe('alone');
    expect(chat('ledger_record_prediction')).toMatchObject({ tier: 'alone', cap: { limit: 10, period: 'day' } });
  });
});
