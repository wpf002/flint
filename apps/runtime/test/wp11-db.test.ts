/**
 * The digest, retention, the daily rollups and the exit report on flint_test.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { digestOf, localDay, localDayBounds, previousDay } from '@flint/policy';
import { NO_DB, freshDb, withClient, type TestUrls } from './db';
import { enrollTestKey } from './sign';
import { createDb, type Db } from '../src/db';
import { loadConfig, type Config } from '../src/config';
import { createProposal, approveProposal, expireProposals } from '../src/governance/proposals';
import { runInternal } from '../src/governance/internal';
import { markProcessed, recordEvent } from '../src/events/record';
import { buildDigest, runDigest } from '../src/digest';
import { runRetention, healthSeries } from '../src/retention';
import { runRollups, percentile } from '../src/rollup';
import { p2Report } from '../src/report/exit';
import { cardGate } from '../src/backup/nightly';
import type { NotifyOutcome } from '../src/notify';

const DAY = 86_400_000;
const TZ = 'America/Chicago';

describe('percentile', () => {
  it('is the nearest rank', () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([5], 0.95)).toBe(5);
    expect(percentile(Array.from({ length: 100 }, (_, i) => i + 1), 0.95)).toBe(95);
    expect(percentile([3, 1, 2], 0.5)).toBe(2);
  });
});

describe.skipIf(NO_DB)('the digest, retention, rollups and the report', () => {
  let urls: TestUrls;
  let db: Db;
  let config: Config;
  let key: Awaited<ReturnType<typeof enrollTestKey>>;
  const owner = (sql: string, params: unknown[] = []) => withClient(urls.owner, (c) => c.query(sql, params));
  let n = 0;
  async function event(at: Date, extra: { source?: string; type?: string; tainted?: boolean; sensitivity?: 'ops' | 'personal' | 'financial'; payload?: Record<string, unknown> } = {}): Promise<string> {
    return db.$transaction(async (tx) => {
      const id = (await recordEvent(tx, { source: extra.source ?? 'runtime', sourceRef: `t:${n++}:${Math.random()}`, type: extra.type ?? 'backup.stale', occurredAt: at, sensitivity: extra.sensitivity ?? 'ops', tainted: extra.tainted ?? false, payload: extra.payload ?? { hoursSince: 40 } }, at))!;
      await markProcessed(tx, id, 'applied', at);
      return id;
    });
  }
  async function decision(at: Date, over: Record<string, unknown> = {}): Promise<string> {
    const ev = await event(at, { tainted: !!over.tainted });
    const id = `td${n++}x${Math.random().toString(36).slice(2, 8)}`;
    await db.triageDecision.create({ data: { id, sourceEventId: ev, action: 'log', lane: 'quiet', decidedBy: 'default', sensitivity: 'ops', createdAt: at, ...over } });
    return id;
  }
  async function promote(patterns: string[]) {
    const args = { rows: patterns.map((pattern) => ({ pattern, tier: 'alone', expiresAt: new Date(Date.now() + DAY).toISOString(), reason: 'test' })) };
    const p = await createProposal(db, { kind: 'policy', origin: 'console', action: 'policy.change', args, argsProvenance: { rows: { source: 'will', tainted: false } }, tainted: false, sensitivity: 'ops', destructive: false, consequential: false, ttlMinutes: 60 }, 'test');
    await approveProposal(db, p.id, await key.approve({ subjectId: p.id, action: 'policy.change', argsDigest: digestOf(args) }), undefined, 'test');
    await runInternal(db, p.id, undefined, TZ, 'test');
  }

  beforeAll(async () => {
    urls = await freshDb();
    db = createDb(urls.app);
    config = loadConfig({ DATABASE_URL: urls.app, HOME: '/nonexistent', FLINT_TZ: TZ });
    key = await enrollTestKey(urls);
  });
  afterAll(async () => db?.$disconnect());

  it('the digest covers the previous local day, 25 hours or 23', async () => {
    // 2026-11-01 is 25 hours long in Chicago (DST ends); 2026-03-08 is 23.
    for (const [day, hours] of [['2026-11-01', 25], ['2026-03-08', 23]] as const) {
      const { start, end } = localDayBounds(TZ, day);
      expect((end.getTime() - start.getTime()) / 3_600_000).toBe(hours);
      const morning = new Date(end.getTime() + 12.5 * 3_600_000);
      // Outside the day by a minute either side, and its first and last minutes.
      await decision(new Date(start.getTime() - 60_000), { lane: 'relevant' });
      await decision(new Date(start.getTime() + 60_000), { lane: 'relevant' });
      await decision(new Date(end.getTime() - 60_000), { lane: 'relevant' });
      await decision(new Date(end.getTime() + 60_000), { lane: 'relevant' });
      const d = await buildDigest(db, TZ, morning);
      expect(d.day).toBe(day);
      expect(d.counts.relevant).toBe(2);
      expect(d.body).not.toMatch(/likely|%/);
    }
  });

  it('shadow: recorded, not delivered; promoted: delivered once a day, did and queued counted, a refusal audited', async () => {
    const now = new Date();
    let posts = 0;
    const post = async (): Promise<NotifyOutcome> => (posts++, { status: 'stored', pinged: false });
    expect(await runDigest(db, config, now, post)).toBe('recorded');
    expect(posts).toBe(0);
    expect(await runDigest(db, config, now, post)).toBe('already');
    await owner(`DELETE FROM "ActionCounter" WHERE action = 'digest.daily'`);
    await promote(['digest.daily', 'notify.inapp']);
    await appendOk('backup.local');
    const sent: Array<{ title: string; body?: string; channels?: string[]; ref?: string }> = [];
    expect(await runDigest(db, config, now, async (req) => (sent.push(req as never), { status: 'stored', pinged: false }))).toBe('delivered');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ channels: ['inapp'], ref: expect.stringMatching(/^digest:\d{4}-\d{2}-\d{2}$/) });
    expect(sent[0]!.body).toMatch(/^Yesterday, (no items were|1 item was|\d+ items were) important and (none|\d+) went to Other\./);
    expect(sent[0]!.body).toMatch(/\nFlint did 1 thing on its own\. (You have (\d+ approvals?|\d+ open escalations?|\d+ approvals? and \d+ open escalations?) waiting|Nothing is waiting on you)\.\n/);
    expect(sent[0]!.body).toMatch(/\n(Everything checked is healthy|This needs a look: [^.]+|These need a look: [^.]+)\.\n(No predictions resolve today|Today, \d+ predictions? resolves?)\.$/);
    // Health by its console names, never an internal one.
    expect(sent[0]!.body).not.toMatch(/restore_drill|source:|audit_intents|quiet lane|proposal/);
    expect(await runDigest(db, config, now, async () => (sent.push({ title: 'x' }), { status: 'stored', pinged: false }))).toBe('already');
    expect(sent).toHaveLength(1);
    await owner(`DELETE FROM "ActionCounter" WHERE action = 'digest.daily'`);
    expect(await runDigest(db, config, new Date(now.getTime() + 1000), async () => ({ status: 'refused', code: 422 }))).toBe('failed');
    expect(await db.auditEntry.count({ where: { action: 'digest.daily', outcome: 'failed' } })).toBe(1);
    // A day whose delivery never ended (the server down past the retries) is closed the next day, not sent late.
    // Noon of the previous local day: "now minus 24 h" is still today in the last hour of a 25-hour fall-back day.
    const yesterdayNoon = new Date(localDayBounds(TZ, previousDay(localDay(TZ, now))).start.getTime() + 12 * 3_600_000);
    await expect(runDigest(db, config, yesterdayNoon, async () => ({ status: 'retry', why: 'unreachable' }))).rejects.toThrow(/retrying/);
    await owner(`DELETE FROM "ActionCounter" WHERE action = 'digest.daily'`);
    const posted: string[] = [];
    expect(await runDigest(db, config, now, async (req) => (posted.push(req.ref ?? ''), { status: 'stored', pinged: false }))).toBe('delivered');
    // Only today's: yesterday's is closed as failed, not sent a day late.
    expect(posted).toEqual([sent[0]!.ref]);
    expect(Number((await owner(`SELECT count(*) AS n FROM audit_open_intents WHERE action = 'digest.daily'`)).rows[0].n)).toBe(0);
    expect(await db.auditEntry.count({ where: { action: 'digest.daily', kind: 'action', outcome: 'failed', inputs: { path: ['reason'], equals: 'not delivered that day' } } })).toBe(1);
  });

  it('"Flint did N things on its own" counts what ran without Will, once each: never an approved card, never twice', async () => {
    const { appendAudit } = await import('../src/governance/audit');
    // A day of its own, 20 days back (the audit takes entries from the last 31 days only).
    const day = previousDay(localDay(TZ, new Date(Date.now() - 20 * DAY)));
    const { start, end } = localDayBounds(TZ, day);
    const at = new Date(start.getTime() + 3 * 3_600_000);
    // A card Will approved (a nightly backup): its completion and the job's own row, both ok, both under its id.
    const card = await createProposal(db, { kind: 'tool_call', origin: 'console', action: 'world.source.enable', args: { source: 'git' }, argsProvenance: { source: { source: 'will', tainted: false } }, tainted: false, sensitivity: 'ops', destructive: false, consequential: false, ttlMinutes: 60 }, 'test');
    // Actions of their own (test.did.*), so no other test here counts them.
    const row = (over: Record<string, unknown>) => ({ actor: 'runtime', context: 'autonomous' as const, kind: 'action' as const, action: 'test.did.backup', decision: 'act' as const, outcome: 'ok' as const, inputs: {}, ...over });
    await appendAudit(db, [
      row({ context: 'chat', correlationId: card.id }),
      row({ correlationId: card.id }),
      // A promoted write that ran alone, reported twice under one id; and a job's run with no id.
      row({ action: 'test.did.alone', correlationId: 'call:abc123' }),
      row({ action: 'test.did.alone', correlationId: 'call:abc123' }),
      row({ action: 'test.did.job' }),
      // Not Flint on its own: Will's click, a failure, a row that only logged.
      row({ context: 'console', action: 'test.did.click' }),
      row({ action: 'test.did.failed', outcome: 'failed' }),
      row({ action: 'test.did.logged', decision: 'log' }),
    ] as Parameters<typeof appendAudit>[1], at);
    const d = await buildDigest(db, TZ, new Date(end.getTime() + 7.5 * 3_600_000));
    expect(d.day).toBe(day);
    expect(d.counts.did).toBe(2);
    expect(d.body.split('\n')[1]).toMatch(/^Flint did 2 things on its own\./);
  });

  async function appendOk(action: string) {
    const { appendAudit } = await import('../src/governance/audit');
    const { start } = localDayBounds(TZ, (await buildDigest(db, TZ)).day);
    await appendAudit(db, [{ actor: 'runtime', context: 'autonomous', kind: 'action', action, outcome: 'ok', inputs: {} }], new Date(start.getTime() + 3_600_000));
  }

  it('retention: tainted text at 7 days, the rest at 90; a proposal ages from when it ended; a purged note keeps a title', async () => {
    const now = new Date();
    const old8 = new Date(now.getTime() - 8 * DAY);
    const tainted = await decision(old8, { tainted: true, reasoning: 'a stranger said so' });
    const clean = await decision(old8, { reasoning: 'routine' });
    const escDecision = await decision(old8, { tainted: true, action: 'escalate', lane: 'relevant' });
    await db.escalation.create({ data: { id: 'esret1', triageDecisionId: escDecision, templateId: 'backup_stale', fields: { hoursSince: 40 }, title: 'Backups have stopped', body: 'The last good database backup is 40 hours old.', channels: ['inapp'], tainted: true, sensitivity: 'ops', createdAt: old8 } });
    // Expired 13 days ago (purged at 7 days: it is tainted); made 9 days ago but expired 2 days ago (kept).
    // Made in the past, as the owner can (the API stamps the present).
    const mk = async (daysAgo: number, ttlDays: number) => {
      const id = `prold${daysAgo}x${n++}`;
      const created = new Date(now.getTime() - daysAgo * DAY);
      await owner(
        `INSERT INTO "Proposal" (id, kind, origin, action, args, "argsDigest", "argsProvenance", tainted, sensitivity, "expiresAt", "createdAt")
         VALUES ($1, 'tool_call', 'console', 'world.entity.write', $2, $3, '{"x":{"source":"event","tainted":true}}', true, 'ops', $4, $5)`,
        [id, JSON.stringify({ x: daysAgo }), digestOf({ x: daysAgo }), new Date(created.getTime() + ttlDays * DAY), created],
      );
      return id;
    };
    const longGone = await mk(20, 7);
    const justEnded = await mk(9, 7);
    await expireProposals(db, now);
    const counts = await runRetention(db, TZ, now);
    expect((await db.triageDecision.findUniqueOrThrow({ where: { id: tainted } })).reasoning).toBeNull();
    expect((await db.triageDecision.findUniqueOrThrow({ where: { id: clean } })).reasoning).toBe('routine');
    expect(await db.escalation.findUniqueOrThrow({ where: { id: 'esret1' } })).toMatchObject({ title: 'Backups have stopped', body: null, fields: {}, contentPurgedAt: expect.any(Date) });
    expect((await db.proposal.findUniqueOrThrow({ where: { id: longGone } })).args).toBeNull();
    expect((await db.proposal.findUniqueOrThrow({ where: { id: justEnded } })).args).toEqual({ x: 9 });
    expect(counts).toMatchObject({ decisionReasoning: 1, escalationText: 1, proposalArgs: 1 });
    expect(await db.auditEntry.count({ where: { action: 'maintenance.retention', kind: 'action', outcome: 'ok' } })).toBe(1);
  });

  it('retention rolls raw health and metrics into daily series equal to the raw aggregate, then deletes them', async () => {
    const now = new Date();
    const { start } = localDayBounds(TZ, '2026-08-20');
    const at = (h: number) => new Date(start.getTime() + h * 3_600_000);
    await db.healthCheck.createMany({ data: [['ok', 1], ['ok', 2], ['ok', 3], ['down', 4], ['disabled', 5]].map(([s, h]) => ({ component: 'source:github', status: s as string, at: at(h as number) })) });
    await db.metricSeries.create({ data: { key: 'test.latency.ms', unit: 'ms', freq: 'raw', sensitivity: 'ops', description: 'test latency' } });
    await db.metricSeries.create({ data: { key: 'test.spend.usd', unit: 'usd', freq: 'raw', sensitivity: 'financial', description: 'test spend' } });
    await db.metricPoint.createMany({ data: [[10, 1], [20, 2], [60, 3]].map(([v, h]) => ({ seriesKey: 'test.latency.ms', at: at(h!), value: v! })) });
    await db.metricPoint.createMany({ data: [[1, 1], [3, 2], [2.5, 23]].map(([v, h]) => ({ seriesKey: 'test.spend.usd', at: at(h!), value: v! })) });
    await runRetention(db, TZ, now);
    const point = async (key: string) => (await db.metricPoint.findUniqueOrThrow({ where: { seriesKey_at: { seriesKey: key, at: start } } })).value;
    expect(await point(healthSeries('source:github'))).toBeCloseTo(0.75);
    expect(await point('test.latency.ms.daily')).toBeCloseTo(30);
    expect(await point('test.spend.usd.daily')).toBeCloseTo(2.5);
    expect((await db.metricSeries.findUniqueOrThrow({ where: { key: 'test.spend.usd.daily' } })).freq).toBe('D');
    expect(await db.healthCheck.count({ where: { at: { lt: at(24) } } })).toBe(0);
    expect(await db.metricPoint.count({ where: { seriesKey: { in: ['test.latency.ms', 'test.spend.usd'] } } })).toBe(0);
  });

  it('at APPROVAL, retention waits on a nightly card; it runs on an approved one', async () => {
    const now = new Date();
    const g = await cardGate(db, { action: 'maintenance.retention', job: 'retention', templateId: 'nightly.retention' }, TZ, undefined, now);
    expect(g).toMatchObject({ go: false });
    const card = await db.proposal.findFirstOrThrow({ where: { origin: 'runtime:retention', status: 'pending' } });
    expect(card).toMatchObject({ action: 'maintenance.retention', templateId: 'nightly.retention' });
    await approveProposal(db, card.id, await key.approve({ subjectId: card.id, action: 'maintenance.retention', argsDigest: card.argsDigest }), undefined, 'test');
    const go = await cardGate(db, { action: 'maintenance.retention', job: 'retention', templateId: 'nightly.retention' }, TZ, undefined, now);
    expect(go).toMatchObject({ go: true, proposalId: card.id });
  });

  it('rollups: yesterday\'s chat p95, recall fallback, World now size and lanes, from the events', async () => {
    const now = new Date();
    const y = localDayBounds(TZ, (await buildDigest(db, TZ, now)).day);
    const at = new Date(y.start.getTime() + 3_600_000);
    const turns = [
      { ms: 100, recall: 'semantic', ctxTokens: { world: 200 } },
      { ms: 300, recall: 'lexical' },
      { ms: 200, recall: 'timeout', ctxTokens: { world: 100 } },
      { ms: 1000, recall: 'semantic' },
      { ms: 150, recall: 'none' },
    ];
    for (const t of turns) await event(at, { source: 'server', type: 'chat.turn', payload: { brain: 'local', outcome: 'answered', tools: [], tainted: false, ...t } });
    await runRollups(db, TZ, now);
    const v = async (k: string) => (await db.metricPoint.findUnique({ where: { seriesKey_at: { seriesKey: k, at: y.start } } }))?.value;
    expect(await v('p2.chat.p95_ms')).toBe(1000);
    expect(await v('p2.chat.recall_fallback_rate')).toBeCloseTo(0.5);
    expect(await v('p2.ctx_tokens.world')).toBeCloseTo(150);
    expect(await v('p2.ctx_tokens.recall')).toBeUndefined();
  });

  it('the exit report measures the criteria; precision needs 20 marked; deploy windows are not down time', async () => {
    const now = new Date();
    await owner(`DELETE FROM "RuntimeInstance"`);
    // Up 14 days but for a 6-minute gap that a deploy explains.
    const t0 = new Date(now.getTime() - 14 * DAY);
    const gapAt = new Date(now.getTime() - 5 * DAY);
    await owner(`INSERT INTO "RuntimeInstance" (id, "gitSha", "startedAt", "lastBeatAt", "stoppedAt") VALUES ('ri1', 'dev', $1, $2, $2), ('ri2', 'dev', $3, $4, NULL)`, [t0, gapAt, new Date(gapAt.getTime() + 8 * 60_000), now]);
    await event(new Date(gapAt.getTime() + 8 * 60_000), { source: 'deploy', type: 'deploy.ok', payload: { component: 'runtime', stage: 'deploy', outcome: 'ok', sha: 'a'.repeat(40) } });
    const r = await p2Report(db, { tz: TZ, home: '/nonexistent' }, now);
    const c = (k: number) => r.criteria.find((x) => x.n === k)!;
    expect(c(1).values.uptime).toBe(1);
    expect(c(4).pass).toBeNull();
    expect(c(4).detail).toMatch(/needs 20/);
    expect(c(5).values.unaudited).toBeGreaterThan(0); // the fixtures above wrote decisions straight in, without audits
    expect(c(6).detail).toMatch(/no baseline/);
    expect(c(8).pass).toBeNull();
    expect(r.criteria.map((x) => x.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});
