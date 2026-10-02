/**
 * P2's event-only sources: deploy events read from where they stopped (new
 * file, cut-short file, half a line, malformed lines); knowledge facts matched
 * exactly on identifiers, never storing words or naming a person; Nexus
 * handoffs through check_inbox only, raised once past 24 hours. On flint_test:
 * once per sha and stage, a failed migration is one escalation, and an
 * approved knowledge link writes a tainted Relation.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digestOf } from '@flint/policy';
import { NO_DB, freshDb, withClient, type TestUrls } from '../db';
import { enrollTestKey } from '../sign';
import { createDb, type Db } from '../../src/db';
import { loadConfig, type Config } from '../../src/config';
import { syncOnce } from '../../src/sources/sync';
import { createProposal, approveProposal } from '../../src/governance/proposals';
import { runInternal } from '../../src/governance/internal';
import { processEvent, type WorkerDeps } from '../../src/triage/worker';
import { deploySource, parseCursor } from '../../src/sources/deploy';
import { knowledgeSource, matchFact } from '../../src/sources/knowledge';
import { nexusInboxSource, parseInbox } from '../../src/sources/nexus-inbox';
import type { Source, SourceRun } from '../../src/sources/types';
import type { Bus } from '../../src/bus';

const NOW = new Date('2026-10-02T15:00:00Z');
const run = (cursor?: string, now = NOW): SourceRun => ({ now, signal: new AbortController().signal, fetch: async () => new Response(null, { status: 599 }), ...(cursor !== undefined ? { cursor: { cursor, etag: null } } : {}) });
const sha = (c: string) => c.repeat(40);
const line = (o: Record<string, unknown>) => `${JSON.stringify({ id: 'a'.repeat(32), at: NOW.toISOString(), component: 'runtime', stage: 'gate', outcome: 'failed', sha: sha('1'), ...o })}\n`;

describe('the deploy source', () => {
  it('reads whole lines from where it stopped; a new or shorter file is read from its start', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'deploy-'));
    const file = join(dir, 'deploy-events.jsonl');
    const src = deploySource({ file });
    expect((await src.run(run())).events).toEqual([]);
    writeFileSync(file, line({}) + line({ stage: 'migrate', sha: sha('2') }) + '{"half": ');
    const a = await src.run(run());
    expect(a.events!.map((e) => [e.type, e.sourceRef])).toEqual([['gate.failed', `runtime:gate:failed:${sha('1')}`], ['migrate.failed', `runtime:migrate:failed:${sha('2')}`]]);
    expect(a.events![0]!.payload).toEqual({ component: 'runtime', stage: 'gate', outcome: 'failed', sha: sha('1') });
    // The half line waits; once whole, it is the only thing read next.
    appendFileSync(file, '"x"}\n' + line({ stage: 'deploy', outcome: 'ok', sha: sha('3') }));
    const b = await src.run(run(a.cursor));
    expect(b.events!.map((e) => e.type)).toEqual(['deploy.ok']);
    expect(b.errors).toEqual(['1 line(s) of deploy-events.jsonl are not deploy events; set aside']);
    expect((await src.run(run(b.cursor))).events).toEqual([]);
    // Replaced (another inode): from the start of the new one.
    renameSync(file, `${file}.old`);
    writeFileSync(file, line({ stage: 'health', sha: sha('4') }));
    expect((await src.run(run(b.cursor))).events!.map((e) => e.type)).toEqual(['health.failed']);
    expect(parseCursor('garbage')).toEqual({ offset: 0, inode: '' });
  });

  it('refuses lines that are not the contract: a short sha, an unknown stage, log text', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'deploy-')), 'deploy-events.jsonl');
    writeFileSync(file, line({ sha: 'abc' }) + line({ stage: 'build' }) + line({ log: 'npm ERR! token sk-ant-xyz' }) + 'not json\n');
    const r = await deploySource({ file }).run(run());
    expect(r.events).toEqual([]);
    expect(r.errors?.[0]).toMatch(/^4 line/);
  });
});

describe('the knowledge source', () => {
  const things = [
    { id: 'crepo00000001', kind: 'repo', name: 'wpf002/flint' },
    { id: 'csvc000000002', kind: 'service', name: 'com.flint.server' },
    { id: 'csvc000000003', kind: 'service', name: 'flint' },
  ];
  it('matches identifiers exactly, as whole words, and a relation only between two of them, in order', () => {
    expect(matchFact('com.flint.server depends on wpf002/flint.', things)).toEqual({ entityIds: ['csvc000000002', 'crepo00000001'], relation: { type: 'depends_on', fromId: 'csvc000000002', toId: 'crepo00000001' } });
    expect(matchFact('wpf002/flint is where com.flint.server lives', things)).toEqual({ entityIds: ['crepo00000001', 'csvc000000002'] });
    expect(matchFact('Flint runs on the Mac', things)).toEqual({ entityIds: [] });
    expect(matchFact('see wpf002/flintlock and com.flint.serverless', things)).toEqual({ entityIds: [] });
    expect(matchFact('it depends on wpf002/flint and com.flint.server', things).relation).toBeUndefined();
  });

  it('raises tainted events of ids only; skips a person\'s fact and superseded ones; reads on from the last fact', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'know-')), 'knowledge.json');
    const facts = [
      { id: 'k1', text: 'com.flint.server deploys wpf002/flint', ts: NOW.getTime(), vector: [1] },
      { id: 'k2', text: 'Jane Doe owns com.flint.server', ts: NOW.getTime(), vector: [1], category: 'person' },
      { id: 'k3', text: 'com.flint.server was slow', ts: NOW.getTime(), vector: [1], supersededBy: 'k4' },
      { id: 'k4', text: 'nothing structural here', ts: NOW.getTime(), vector: [1] },
    ];
    writeFileSync(file, JSON.stringify({ seq: 4, facts }));
    const src = knowledgeSource({ file, things: async () => things });
    const r = await src.run(run());
    expect(r.events).toEqual([{ sourceRef: 'fact:k1', type: 'knowledge.fact', occurredAt: NOW, sensitivity: 'ops', tainted: true, payload: { knowledgeId: 'k1', entityIds: ['csvc000000002', 'crepo00000001'], relation: 'deploys', fromId: 'csvc000000002', toId: 'crepo00000001' } }]);
    expect(JSON.stringify(r.events)).not.toMatch(/deploys wpf|Jane/);
    expect(r.cursor).toBe('4');
    expect((await src.run(run('4'))).events).toEqual([]);
  });
});

describe('the nexus_inbox source', () => {
  const reply = (body: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(body) }] });
  function fakeNexus(handoffs: unknown[]) {
    const seen: Array<{ tool?: string; args?: unknown }> = [];
    const fetch = async (_url: string, init: RequestInit = {}) => {
      if ((init.method ?? 'GET') !== 'POST') return new Response(null, { status: 405 });
      const msg = JSON.parse(String(init.body)) as { id?: number; method: string; params: { name: string; arguments: Record<string, unknown>; protocolVersion?: string } };
      if (msg.id === undefined) return new Response(null, { status: 202 });
      if (msg.method === 'initialize') return Response.json({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'nexus', version: '1' } } });
      seen.push({ tool: msg.params.name, args: msg.params.arguments });
      return Response.json({ jsonrpc: '2.0', id: msg.id, result: reply({ direction: 'incoming', status: 'PENDING', count: handoffs.length, handoffs }) });
    };
    return { fetch, seen };
  }
  const h = (id: string, hoursAgo: number, slug = 'trident') => ({ id, subject: 'SECRET SUBJECT', content: 'SECRET CONTENT', status: 'PENDING', createdAt: new Date(NOW.getTime() - hoursAgo * 3_600_000).toISOString(), from: { slug, label: 'Trident' } });

  it('calls only check_inbox; 23 h → nothing, 25 h → one event; never the subject or the content', async () => {
    const n = fakeNexus([h('h23', 23), h('h25', 25), h('bad id!', 30), h('hx', 26, 'Not A Slug')]);
    const r = await nexusInboxSource({ url: 'https://nexus.example/mcp', token: 'nexus-read-token-0123' }).run({ ...run(), fetch: n.fetch as SourceRun['fetch'] });
    expect(n.seen).toEqual([{ tool: 'check_inbox', args: { status: 'PENDING', direction: 'incoming', limit: 100 } }]);
    expect(r.events!.map((e) => [e.sourceRef, e.payload])).toEqual([
      ['handoff:h25:unaccepted_24h', { handoffId: 'h25', kind: 'handoff', hours: 25, namespace: 'trident' }],
      ['handoff:hx:unaccepted_24h', { handoffId: 'hx', kind: 'handoff', hours: 26 }],
    ]);
    expect(JSON.stringify(r.events)).not.toMatch(/SECRET/);
    expect(() => parseInbox(reply({ count: 0 }))).toThrow(/no handoffs list/);
  });
});

describe.skipIf(NO_DB)('P2 sources on flint_test', () => {
  let urls: TestUrls;
  let db: Db;
  let config: Config;
  let home: string;
  let key: Awaited<ReturnType<typeof enrollTestKey>>;
  const noBus = { boss: { send: async () => null } } as unknown as Bus;
  const deps = (): WorkerDeps => ({ db, config, bus: noBus, load: async () => 'proceed' });
  async function signed(action: string, args: Record<string, unknown>, kind: 'tool_call' | 'policy' = 'tool_call', id?: string) {
    let pid = id;
    if (!pid) pid = (await createProposal(db, { kind, origin: 'console', action, args, argsProvenance: { source: { source: 'will', tainted: false } }, tainted: false, sensitivity: 'ops', destructive: false, consequential: false, ttlMinutes: 60 }, 'test')).id;
    await approveProposal(db, pid, await key.approve({ subjectId: pid, action, argsDigest: digestOf(args) }), undefined, 'test');
    return runInternal(db, pid, undefined, 'UTC', 'test');
  }

  beforeAll(async () => {
    urls = await freshDb();
    db = createDb(urls.app);
    home = mkdtempSync(join(tmpdir(), 'p2src-'));
    mkdirSync(join(home, '.flint', 'memory'), { recursive: true });
    config = loadConfig({ DATABASE_URL: urls.app, HOME: home, FLINT_TZ: 'UTC', FLINT_RUNTIME_TRIAGE: 'on' });
    key = await enrollTestKey(urls);
    for (const source of ['deploy', 'knowledge', 'launchd']) await signed('world.source.enable', { source });
  });
  afterAll(async () => db?.$disconnect());

  it('deploy: once per sha and stage; a failed migration is one critical escalation', async () => {
    const file = join(home, '.flint', 'deploy-events.jsonl');
    writeFileSync(file, line({ stage: 'migrate', sha: sha('9') }) + line({ id: 'b'.repeat(32), stage: 'migrate', sha: sha('9') }));
    const src = deploySource({ file });
    await syncOnce(db, src, run(undefined, new Date()), 'UTC');
    await syncOnce(db, { ...src, run: (r) => src.run({ ...r, cursor: { cursor: '0:0', etag: null } }) } as Source, run(undefined, new Date()), 'UTC');
    const evs = await db.sourceEvent.findMany({ where: { source: 'deploy' } });
    expect(evs).toHaveLength(1);
    expect(await processEvent({ eventId: evs[0]!.id }, deps())).toBe('decided');
    const d = await db.triageDecision.findUniqueOrThrow({ where: { sourceEventId: evs[0]!.id }, include: { escalation: true } });
    expect(d).toMatchObject({ action: 'escalate', critical: true, decidedBy: 'code:migrate.failed' });
    expect(d.escalation).toMatchObject({ templateId: 'migrate_failed', title: 'A database migration failed' });
  });

  it('knowledge: in shadow nothing is filed; an approved link writes a tainted relation', async () => {
    const svc = { type: 'service.status', kind: 'service', key: 'service:launchd:com.flint.server', name: 'com.flint.server', sensitivity: 'ops' as const, externalId: 'com.flint.server', state: { managedBy: 'launchd', loaded: true, running: true } };
    const other = { ...svc, key: 'service:launchd:com.flint.runtime', name: 'com.flint.runtime', externalId: 'com.flint.runtime' };
    await syncOnce(db, { name: 'launchd', cadenceMs: 1, run: async () => ({ observations: [svc, other], metrics: [] }) }, run(undefined, new Date()), 'UTC');
    writeFileSync(join(home, '.flint', 'memory', 'knowledge.json'), JSON.stringify({ seq: 1, facts: [{ id: 'k1', text: 'com.flint.server depends on com.flint.runtime', ts: Date.now(), vector: [] }] }));
    const src = knowledgeSource({ file: join(home, '.flint', 'memory', 'knowledge.json'), things: async () => db.entity.findMany({ where: { kind: { in: ['repo', 'service'] } }, select: { id: true, kind: true, name: true } }) });
    await syncOnce(db, src, run(undefined, new Date()), 'UTC');
    const ev = await db.sourceEvent.findFirstOrThrow({ where: { source: 'knowledge' } });
    expect(ev.tainted).toBe(true);
    await processEvent({ eventId: ev.id }, deps());
    const d = await db.triageDecision.findUniqueOrThrow({ where: { sourceEventId: ev.id } });
    expect(d.action).toBe('act');
    expect((await db.auditEntry.findFirstOrThrow({ where: { correlationId: d.id } })).inputs).toMatchObject({ wouldPropose: 'knowledge.link' });
    expect(await db.proposal.count({ where: { action: 'world.relation.write' } })).toBe(0);

    // Will approves such a link (filed here as triage would once promoted): a tainted relation, ids only.
    const [from, to] = [(ev.payload as { fromId: string }).fromId, (ev.payload as { toId: string }).toId];
    const args = { type: 'depends_on', fromId: from, toId: to, knowledgeId: 'k1' };
    const p = await createProposal(db, { kind: 'tool_call', origin: 'runtime:triage', action: 'world.relation.write', templateId: 'knowledge.link', args, argsProvenance: { type: { source: 'event', tainted: true } }, tainted: true, sensitivity: 'ops', destructive: false, consequential: false, ttlMinutes: 60 }, 'runtime:triage');
    const done = (await signed('world.relation.write', args, 'tool_call', p.id)) as { relationId: string };
    expect(await db.relation.findUniqueOrThrow({ where: { id: done.relationId } })).toMatchObject({ type: 'depends_on', fromId: from, toId: to, tainted: true, attrs: { knowledgeId: 'k1' } });
    // Only that template: a hand-made relation proposal is not the runtime's to write.
    const q = await createProposal(db, { kind: 'tool_call', origin: 'console', action: 'world.relation.write', args: { ...args, knowledgeId: 'k2' }, argsProvenance: { type: { source: 'will', tainted: false } }, tainted: false, sensitivity: 'ops', destructive: false, consequential: false, ttlMinutes: 60 }, 'test');
    await expect(signed('world.relation.write', { ...args, knowledgeId: 'k2' }, 'tool_call', q.id)).rejects.toThrow(/knowledge\.link/);
    expect(await withClient(urls.owner, (c) => c.query(`SELECT count(*)::int AS n FROM "Relation"`)).then((r) => r.rows[0].n)).toBe(1);
  });

  it('one failed migration, told by its deploy event and by its marker, is one escalation', async () => {
    const shaX = 'e'.repeat(40);
    writeFileSync(join(home, '.flint', 'deploy-events.jsonl'), line({ id: 'c'.repeat(32), stage: 'migrate', sha: shaX }));
    await syncOnce(db, deploySource({ file: join(home, '.flint', 'deploy-events.jsonl') }), run(undefined, new Date()), 'UTC');
    const { raise } = await import('../../src/health/watchdog');
    await raise(db, [{ type: 'migrate.failed', ref: shaX, occurredAt: new Date(), payload: { sha: shaX } }], new Date());
    const evs = await db.sourceEvent.findMany({ where: { type: 'migrate.failed', OR: [{ sourceRef: { contains: shaX } }] } });
    expect(evs).toHaveLength(2);
    for (const e of evs) await processEvent({ eventId: e.id }, deps());
    expect(await db.escalation.count({ where: { templateId: 'migrate_failed', fields: { path: ['sha'], equals: shaX.slice(0, 12) } } })).toBe(1);
  });

  it('a link that exists already is not proposed again, and an approved duplicate completes without a second row', async () => {
    const rel = await db.relation.findFirstOrThrow();
    const ev = await db.$transaction(async (tx) => {
      const { recordEvent, markProcessed } = await import('../../src/events/record');
      const id = (await recordEvent(tx, { source: 'knowledge', sourceRef: 'fact:k77', type: 'knowledge.fact', occurredAt: new Date(), sensitivity: 'ops', tainted: true, payload: { knowledgeId: 'k77', entityIds: [rel.fromId, rel.toId], relation: rel.type, fromId: rel.fromId, toId: rel.toId } }, new Date()))!;
      await markProcessed(tx, id, 'applied', new Date());
      return id;
    });
    await processEvent({ eventId: ev }, deps());
    const d = await db.triageDecision.findUniqueOrThrow({ where: { sourceEventId: ev } });
    expect((await db.auditEntry.findFirstOrThrow({ where: { correlationId: d.id } })).inputs).not.toHaveProperty('wouldPropose');
    // Approved anyway (filed before the link existed): done, the same relation.
    const args = { type: rel.type, fromId: rel.fromId, toId: rel.toId, knowledgeId: 'k78' };
    const p = await createProposal(db, { kind: 'tool_call', origin: 'runtime:triage', action: 'world.relation.write', templateId: 'knowledge.link', args, argsProvenance: { type: { source: 'event', tainted: true } }, tainted: true, sensitivity: 'ops', destructive: false, consequential: false, ttlMinutes: 60 }, 'runtime:triage');
    expect(await signed('world.relation.write', args, 'tool_call', p.id)).toEqual({ relationId: rel.id, existed: true });
    expect(await db.relation.count()).toBe(1);
  });

  it('a rule whose name is taken, or whose predicate is over 4 KB, is refused before Will is asked', async () => {
    const { ruleProblems, RuleArgs } = await import('../../src/triage/rules');
    const big = RuleArgs.parse({ name: 'big', source: 'github', eventType: 'issue.state', createdBy: 'will', action: 'log', lane: 'quiet', predicate: { any: Array.from({ length: 10 }, () => ({ path: 'entity.state.labels', op: 'in', value: Array.from({ length: 20 }, (_, i) => `${'x'.repeat(100)}${i}`) })) } });
    expect(ruleProblems(big).join()).toMatch(/over 4 KB/);
  });
});
