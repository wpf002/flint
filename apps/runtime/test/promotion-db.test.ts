/**
 * The P2 promotion table: refused before the shadow week is over; its rows
 * meet the policy rules (and the database's, once signed); what must stay at
 * APPROVAL is never in it; Will can drop a row; filing it twice is one card.
 * Nexus's backup table: refused until its dump, copy and test are each good.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FORECAST_SIGNED_ACTIONS, GOAL_SIGNED_ACTIONS, PREDICT_JOB_ACTIONS, PROPHET_ACTIONS, resolveTier } from '@flint/policy';
import { NO_DB, freshDb, withClient, type TestUrls } from './db';
import { enrollTestKey } from './sign';
import { createDb, type Db } from '../src/db';
import { approveProposal, activePolicies, completeProposal, Refused } from '../src/governance/proposals';
import { runInternal, PolicyArgs } from '../src/governance/internal';
import { markProcessed, recordEvent } from '../src/events/record';
import { promotionTable, NEVER_PROMOTED, NEXUS_PROMOTIONS, P1_PROMOTIONS, P2_PROMOTIONS, P25_PROMOTIONS, P26_PROMOTIONS } from '../src/governance/promotion';
import { gate } from '../src/backup/nightly';
import { appendAudit } from '../src/governance/audit';

const DAY = 86_400_000;

describe('P3 and the promotion tables', () => {
  it('no passkey action (the six goal and plan actions, the Nexus write) is in any table, whatever is asked', () => {
    const passkey = [...GOAL_SIGNED_ACTIONS, 'nexus.remember_goal_decision'];
    for (const a of passkey) {
      expect(NEVER_PROMOTED.has(a), a).toBe(true);
      for (const rows of [P1_PROMOTIONS, P2_PROMOTIONS, P25_PROMOTIONS, P26_PROMOTIONS]) expect(rows.map((r) => r.pattern), a).not.toContain(a);
    }
  });
});

describe('P4 and the promotion tables', () => {
  it('the signed predictions card and the outside forecaster\'s names are in no table, whatever is asked; no table offers a P4 job yet', () => {
    for (const a of [...FORECAST_SIGNED_ACTIONS, ...PROPHET_ACTIONS]) {
      expect(NEVER_PROMOTED.has(a), a).toBe(true);
      for (const rows of [P1_PROMOTIONS, P2_PROMOTIONS, P25_PROMOTIONS, P26_PROMOTIONS]) expect(rows.map((r) => r.pattern), a).not.toContain(a);
      // A signed policy row naming one does not make it run alone, in any context.
      const policies = [{ pattern: a, tier: 'alone' as const, active: true, expiresAt: new Date(Date.now() + DAY) }];
      for (const context of ['console', 'chat', 'autonomous'] as const) {
        expect(resolveTier(a, { context, tainted: false, policies }).tier, `${a} ${context}`).not.toBe('alone');
      }
    }
    // The prediction jobs get their own table once they have run in shadow (a later part): none is promoted by an older one.
    for (const a of PREDICT_JOB_ACTIONS) {
      for (const rows of [P1_PROMOTIONS, P2_PROMOTIONS, P25_PROMOTIONS, P26_PROMOTIONS]) expect(rows.map((r) => r.pattern), a).not.toContain(a);
    }
  });
});

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
    await expect(promotionTable(db, { tz: 'UTC' })).rejects.toThrow(/shadow week is not over: 0 of 7/);
    await shadowDecision(3);
    await expect(promotionTable(db, { tz: 'UTC' })).rejects.toThrow(Refused);
  });

  it('after the week: rows meet the policy rules, keep push at 3 a day, and leave out what stays at APPROVAL', async () => {
    await shadowDecision(8);
    const t = await promotionTable(db, { drop: ['world.sync.knowledge'], tz: 'UTC' });
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
    const again = await promotionTable(db, { drop: ['world.sync.knowledge'], now: new Date(Date.now() + 90_000), tz: 'UTC' });
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
    await expect(promotionTable(db, { phase: 'p1', tz: 'UTC' })).rejects.toThrow(/shadow week is not over: 0 of 7 days of chat reads/);
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
    await expect(promotionTable(db, { phase: 'p1', tz: 'UTC' })).rejects.toThrow(/shadow week is not over: 2\.\d of 7 days of chat reads/);
    await read(8, 'ledger_open');
    await read(1, 'world_entity', true);
    const t = await promotionTable(db, { phase: 'p1', tz: 'UTC' });
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

describe.skipIf(NO_DB)('the Nexus backup promotion table', () => {
  let urls: TestUrls;
  let db: Db;
  beforeAll(async () => {
    urls = await freshDb();
    db = createDb(urls.app);
  });
  afterAll(async () => db?.$disconnect());

  // A run of a step as the nightly command ends it: one action entry in the audit trail, ok or failed.
  const run = (action: string, outcome: 'ok' | 'failed', hoursAgo: number) =>
    appendAudit(db, [{ actor: 'will:cli', context: 'console', kind: 'action', action, decision: 'act', outcome, inputs: {}, at: new Date(Date.now() - hoursAgo * 3_600_000).toISOString() }]);

  it('is refused until the newest run of the dump, the copy and the restore test each worked; then one card of three rules, each by name', async () => {
    const nexus = () => promotionTable(db, { phase: 'nexus', tz: 'UTC' });
    await expect(nexus()).rejects.toThrow(/^Nexus has not been backed up yet$/);
    // A first-ever dump that failed is still no backup.
    await run('backup.nexus', 'failed', 60);
    await expect(nexus()).rejects.toThrow(/^Nexus has not been backed up yet$/);
    await run('backup.nexus', 'ok', 50);
    await expect(nexus()).rejects.toThrow(/^not yet: Nexus has had no encrypted copy to iCloud yet$/);
    await run('backup.nexus.offsite', 'ok', 49);
    await expect(nexus()).rejects.toThrow(/^not yet: Nexus has had no restore test yet$/);
    // A restore test that could not start leaves no result on any backup's record; its run is still a failure.
    await run('restore.drill.nexus', 'failed', 40);
    await expect(nexus()).rejects.toThrow(/^not yet: the last Nexus restore test failed$/);
    await run('restore.drill.nexus', 'ok', 30);
    await run('backup.nexus.offsite', 'failed', 20);
    await expect(nexus()).rejects.toThrow(/^not yet: the last Nexus encrypted copy to iCloud failed$/);
    await run('backup.nexus.offsite', 'ok', 10);
    await run('backup.nexus', 'failed', 5);
    await expect(nexus()).rejects.toThrow(/^not yet: the last Nexus backup failed$/);
    await run('backup.nexus', 'ok', 2);
    // A run that went to Flint's own database is not Nexus's.
    await run('backup.local', 'failed', 1);

    const t = await nexus();
    expect(PolicyArgs.safeParse({ rows: t.rows }).success).toBe(true);
    expect(t.rows.map((r) => r.pattern)).toEqual(NEXUS_PROMOTIONS.map((r) => r.pattern));
    for (const r of t.rows) expect(r).toMatchObject({ tier: 'alone', reason: 'Nexus backup promotion table, after a good backup, copy and restore test' });
    for (const r of t.rows) expect(r.dailyCap).toBeUndefined();
    const card = await db.proposal.findUniqueOrThrow({ where: { id: t.proposalId } });
    expect(card.templateId).toBe('nexus.promotion');
    expect(card.consequential).toBe(true);
    // The first failed dump is before the first good one, so it is not counted; the other three failures are.
    expect(card.reason).toMatch(/^This lets Flint back up Nexus each night, send the encrypted copy to iCloud and test a restore each week without asking until [A-Z][a-z]{2} \d{1,2}, \d{4}\. Since [A-Z][a-z]{2} \d{1,2}, Flint backed up Nexus 2 times, sent 2 encrypted copies to iCloud, and tested a restore 1 time\. 3 runs failed before a later one passed\.$/);
    // Filing it again is the same card.
    expect(await promotionTable(db, { phase: 'nexus', tz: 'UTC', now: new Date(Date.now() + 60_000) })).toMatchObject({ proposalId: t.proposalId, deduped: true });
    // A step Will drops stays on its nightly card: that table is another card.
    const dropped = await promotionTable(db, { phase: 'nexus', drop: ['backup.nexus.offsite'], tz: 'UTC' });
    expect(dropped.proposalId).not.toBe(t.proposalId);
    expect(dropped.rows.map((r) => r.pattern)).toEqual(['backup.nexus', 'restore.drill.nexus']);

    // Signed: each of the three runs on its own under its own cap, from the nightly job; Flint's own backups and chat do not.
    const key = await enrollTestKey(urls);
    await approveProposal(db, card.id, await key.approve({ subjectId: card.id, action: 'policy.change', argsDigest: card.argsDigest }), undefined, 'test');
    expect(await runInternal(db, card.id, undefined, 'UTC', 'test')).toEqual({ rows: 3 });
    const policies = await activePolicies(db);
    const auto = (a: string) => resolveTier(a, { context: 'autonomous', tainted: false, policies });
    expect(auto('backup.nexus')).toMatchObject({ tier: 'alone', cap: { limit: 1, period: 'day' } });
    expect(auto('backup.nexus.offsite')).toMatchObject({ tier: 'alone', cap: { limit: 1, period: 'day' } });
    expect(auto('restore.drill.nexus')).toMatchObject({ tier: 'alone', cap: { limit: 1, period: 'week' } });
    for (const a of ['backup.local', 'backup.offsite', 'restore.drill', 'backup.prune']) expect(auto(a).tier, a).not.toBe('alone');
    for (const a of NEXUS_PROMOTIONS.map((r) => r.pattern)) expect(resolveTier(a, { context: 'chat', tainted: false, policies }).tier, a).not.toBe('alone');
    expect(await gate(db, 'nexus-backup', 'UTC', undefined, new Date())).toMatchObject({ go: true, why: 'promoted' });
    // Its cap: a second run the same day does not go.
    expect(await gate(db, 'nexus-backup', 'UTC', undefined, new Date())).toMatchObject({ go: false });
  });

  it('a run on a card is one run, though the card and the command each write an entry; the command says how it ended', async () => {
    const own = await freshDb();
    const fresh = createDb(own.app);
    try {
      const byHand = (action: string, outcome: 'ok' | 'failed') => appendAudit(fresh, [{ actor: 'will:cli', context: 'console', kind: 'action', action, decision: 'act', outcome, inputs: {} }]);
      for (const a of NEXUS_PROMOTIONS.map((r) => r.pattern)) await byHand(a, 'ok');
      // Tonight's dump, as the nightly command runs it: the card is filed, Will approves it, the run claims it,
      // completes it (the card's entry), and writes its own entry.
      expect(await gate(fresh, 'nexus-backup', 'UTC', undefined, new Date())).toMatchObject({ go: false });
      const card = await fresh.proposal.findFirstOrThrow({ where: { origin: 'runtime:nexus-backup', status: 'pending' } });
      const key = await enrollTestKey(own);
      await approveProposal(fresh, card.id, await key.approve({ subjectId: card.id, action: 'backup.nexus', argsDigest: card.argsDigest }), undefined, 'test');
      const g = await gate(fresh, 'nexus-backup', 'UTC', undefined, new Date());
      expect(g).toMatchObject({ go: true, proposalId: card.id });
      await completeProposal(fresh, card.id, { ok: true, result: { bytes: 1 } }, 'runtime');
      await appendAudit(fresh, [{ actor: 'runtime', context: 'autonomous', kind: 'action', action: 'backup.nexus', decision: 'act', outcome: 'ok', inputs: { bytes: 1 }, correlationId: card.id }]);
      expect(await fresh.auditEntry.count({ where: { kind: 'action', action: 'backup.nexus' } })).toBe(3);
      // A card swept later as unknown (its completion never came) does not undo what the command said.
      await appendAudit(fresh, [{ actor: 'runtime', context: 'autonomous', kind: 'action', action: 'backup.nexus', decision: 'act', outcome: 'failed', inputs: { proposalId: card.id, outcomeUnknown: true }, correlationId: card.id }]);
      const t = await promotionTable(fresh, { phase: 'nexus', tz: 'UTC' });
      const filed = await fresh.proposal.findUniqueOrThrow({ where: { id: t.proposalId } });
      expect(filed.reason).toMatch(/\. Since [A-Z][a-z]{2} \d{1,2}, Flint backed up Nexus 2 times, sent 1 encrypted copy to iCloud, and tested a restore 1 time\. None failed\.$/);
      // A card's entry alone (the command was killed before it wrote its own) is a run, and here a failed one.
      await appendAudit(fresh, [{ actor: 'runtime', context: 'autonomous', kind: 'action', action: 'backup.nexus', decision: 'act', outcome: 'failed', inputs: { proposalId: 'gone', outcomeUnknown: true }, correlationId: 'gone' }]);
      await expect(promotionTable(fresh, { phase: 'nexus', tz: 'UTC' })).rejects.toThrow(/^not yet: the last Nexus backup failed$/);
    } finally {
      await fresh.$disconnect();
    }
  });

  it('one good run of each, nothing failed: the sentence says so in the singular', async () => {
    const fresh = createDb((await freshDb()).app);
    try {
      for (const a of NEXUS_PROMOTIONS.map((r) => r.pattern)) await appendAudit(fresh, [{ actor: 'will:cli', context: 'console', kind: 'action', action: a, decision: 'act', outcome: 'ok', inputs: {} }]);
      const t = await promotionTable(fresh, { phase: 'nexus', tz: 'UTC' });
      const card = await fresh.proposal.findUniqueOrThrow({ where: { id: t.proposalId } });
      expect(card.reason).toMatch(/\. Since [A-Z][a-z]{2} \d{1,2}, Flint backed up Nexus 1 time, sent 1 encrypted copy to iCloud, and tested a restore 1 time\. None failed\.$/);
    } finally {
      await fresh.$disconnect();
    }
  });
});
