/**
 * Surfacing on flint_test (real job bus; stub server and model): one
 * transaction per decision, so a failure at any step leaves nothing and a
 * re-run leaves exactly one of each row; shadow delivers nothing; the
 * prediction's words are the row's; the ledger cap skips a prediction, never
 * an escalation; taint reaches every row; a critical ping passes the cap and
 * is counted; a retried delivery is one ping; and a stranger's words never
 * reach the audit trail, health or the job queue.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { digestOf, periodKey } from '@flint/policy';
import { NO_DB, freshDb, withClient, type TestUrls } from '../db';
import { enrollTestKey } from '../sign';
import { createDb, type Db } from '../../src/db';
import { startBus, type Bus } from '../../src/bus';
import { loadConfig, type Config } from '../../src/config';
import { syncOnce } from '../../src/sources/sync';
import { createProposal, approveProposal } from '../../src/governance/proposals';
import { runInternal } from '../../src/governance/internal';
import { markProcessed, recordEvent, triageEnqueue } from '../../src/events/record';
import { processEvent, type WorkerDeps } from '../../src/triage/worker';
import { deliver } from '../../src/surface/deliver';
import { expireEscalations } from '../../src/surface/expire';
import { phrase } from '../../src/templates/escalations';
import type { NotifyOutcome } from '../../src/notify';
import type { Source, SourceName, SourceObservation, SourceRun } from '../../src/sources/types';

const runAt = (now: Date): Omit<SourceRun, 'cursor'> => ({ now, signal: new AbortController().signal, fetch: async () => new Response(null, { status: 599 }) });
const fakeSource = (name: SourceName, observations: () => SourceObservation[]): Source => ({ name, cadenceMs: 1, run: async () => ({ observations: observations(), metrics: [] }) });
const MARKER = 'MARKER-7f3a9c';

describe.skipIf(NO_DB)('surfacing on flint_test', () => {
  let urls: TestUrls;
  let db: Db;
  let bus: Bus;
  let config: Config;
  let key: Awaited<ReturnType<typeof enrollTestKey>>;
  let serviceId: string;
  const owner = (sql: string, params: unknown[] = []) => withClient(urls.owner, (c) => c.query(sql, params));
  const count = async (table: string, where = 'true') => Number((await owner(`SELECT count(*) AS n FROM "${table}" WHERE ${where}`)).rows[0].n);
  const deps = (over: Partial<WorkerDeps> = {}): WorkerDeps => ({
    db, config, bus, load: async () => 'proceed',
    fetch: (async () => new Response(JSON.stringify({ model: 'm', message: { role: 'assistant', content: JSON.stringify({ relevance: 0.95, reasonCode: 'needs_will', reasoning: `the title says ${MARKER}` }) }, done: true, done_reason: 'stop' }), { status: 200 })) as unknown as typeof fetch,
    ...over,
  });
  async function signed(action: string, args: Record<string, unknown>, kind: 'tool_call' | 'policy' = 'tool_call') {
    const p = await createProposal(db, { kind, origin: 'console', action, args, argsProvenance: { source: { source: 'will', tainted: false } }, tainted: false, sensitivity: 'ops', destructive: false, consequential: false, ttlMinutes: 60 }, 'test');
    await approveProposal(db, p.id, await key.approve({ subjectId: p.id, action, argsDigest: digestOf(args) }), undefined, 'test');
    return runInternal(db, p.id, undefined, 'UTC', 'test');
  }
  async function raised(source: string, type: string, payload: Record<string, unknown>, tainted = false): Promise<string> {
    return db.$transaction(async (tx) => {
      const id = (await recordEvent(tx, { source, sourceRef: `${type}:${Math.random()}`, type, occurredAt: new Date(), sensitivity: 'ops', tainted, payload }, new Date()))!;
      await markProcessed(tx, id, 'applied', new Date());
      return id;
    });
  }
  const escalationOf = async (eventId: string) => {
    const d = await db.triageDecision.findUniqueOrThrow({ where: { sourceEventId: eventId }, include: { escalation: { include: { deliveries: true } } } });
    return { decision: d, escalation: d.escalation! };
  };

  beforeAll(async () => {
    urls = await freshDb();
    db = createDb(urls.app);
    bus = await startBus(urls.app, () => {});
    config = loadConfig({ DATABASE_URL: urls.app, HOME: '/nonexistent', FLINT_RUNTIME_TRIAGE: 'on', FLINT_TRIAGE_MODEL: 'muse-glimmer:30b', FLINT_TZ: 'America/Chicago' });
    key = await enrollTestKey(urls);
    await signed('world.source.enable', { source: 'launchd' });
    await signed('world.source.enable', { source: 'github' });
    const svc: SourceObservation = { type: 'service.status', kind: 'service', key: 'service:launchd:com.flint.server', name: 'com.flint.server', sensitivity: 'ops', externalId: 'com.flint.server', state: { managedBy: 'launchd', loaded: true, running: false } };
    await syncOnce(db, fakeSource('launchd', () => [svc]), runAt(new Date()), 'UTC');
    serviceId = (await db.entity.findFirstOrThrow({ where: { key: 'service:launchd:com.flint.server' } })).id;
    await syncOnce(db, fakeSource('github', () => [{ type: 'issue.state', kind: 'issue', key: 'issue:github:wpf002/flint#1', name: 'old', sensitivity: 'ops', externalId: 'issue:wpf002/flint#1', taintedPaths: ['name', 'state.title'], state: { number: 1, state: 'open', labels: [], title: 'old' } }]), runAt(new Date()), 'UTC');
    // Fault injection: while a table is named in _fail, inserts into it fail (installed by the owner, removed in afterAll).
    await owner(`CREATE TABLE _fail (target text PRIMARY KEY)`);
    await owner(`CREATE FUNCTION _fail_once() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      BEGIN IF EXISTS (SELECT 1 FROM _fail WHERE target = TG_TABLE_NAME) THEN RAISE EXCEPTION 'injected failure'; END IF; RETURN NEW; END $$`);
    for (const t of ['Prediction', 'Escalation', 'EscalationDelivery']) await owner(`CREATE TRIGGER "_fail_${t}" BEFORE INSERT ON "${t}" FOR EACH ROW EXECUTE FUNCTION _fail_once()`);
  });
  afterAll(async () => {
    if (urls) {
      for (const t of ['Prediction', 'Escalation', 'EscalationDelivery']) await owner(`DROP TRIGGER IF EXISTS "_fail_${t}" ON "${t}"`);
      await owner(`DROP FUNCTION IF EXISTS _fail_once(); DROP TABLE IF EXISTS _fail`);
    }
    await bus?.boss.stop({ graceful: false });
    await db?.$disconnect();
  });
  afterEach(async () => {
    await owner(`DELETE FROM pgboss.job`);
  });

  it('shadow: the escalation and its prediction are recorded; nothing is delivered, queued or filed', async () => {
    const ev = await raised('runtime', 'service.down_30m', { entityId: serviceId, downMinutes: 41 });
    expect(await processEvent({ eventId: ev }, deps())).toBe('decided');
    const { decision, escalation } = await escalationOf(ev);
    expect(decision).toMatchObject({ action: 'escalate', critical: true, shadow: true });
    expect(escalation.channels).toEqual(['inapp', 'banner', 'push']);
    expect(escalation.deliveries.map((d) => d.status)).toEqual(['held', 'held', 'held']);
    expect(await count('AuditEntry', `kind = 'intent' AND "correlationId" LIKE '${escalation.id}.%'`)).toBe(0);
    expect(Number((await owner(`SELECT count(*) AS n FROM pgboss.job WHERE name = 'deliver'`)).rows[0].n)).toBe(0);
    expect(await db.proposal.count({ where: { origin: 'runtime:triage' } })).toBe(0);
    // The words name the service, and its probability is the stored row's, through phrase().
    const p = await db.prediction.findUniqueOrThrow({ where: { id: escalation.predictionId! } });
    expect(p).toMatchObject({ probability: 0.4, method: 'base_rate', claim: `service#${serviceId.slice(-6)} reports healthy at the resolve time`, subjectEntityId: serviceId });
    expect(escalation.title).toBe('com.flint.server is down');
    expect(escalation.body).toContain(phrase(p.probability!, p.resolveBy, 'America/Chicago'));
    const rec = await db.recommendation.findUniqueOrThrow({ where: { id: escalation.recommendationId! }, include: { prediction: true } });
    expect(rec).toMatchObject({ type: 'escalation_action', prediction: { resolver: 'conditional', conditionRecommendationId: rec.id, probability: 0.8 } });
  });

  it('no entity → no prediction; the escalation is still made', async () => {
    const ev = await raised('runtime', 'service.down_30m', { downMinutes: 35 });
    await processEvent({ eventId: ev }, deps());
    const { escalation } = await escalationOf(ev);
    expect(escalation).toMatchObject({ predictionId: null, recommendationId: null, title: 'A service is down' });
  });

  it('the 51st prediction of the day is skipped; the escalation is still made, and says so in its audit', async () => {
    const day = periodKey({ period: 'day' }, 'America/Chicago');
    await owner(`INSERT INTO "ActionCounter" (action, day, count) VALUES ('ledger.prediction.record', $1, 50) ON CONFLICT (action, day) DO UPDATE SET count = 50`, [day]);
    const ev = await raised('runtime', 'service.down_30m', { entityId: serviceId, downMinutes: 50 });
    await processEvent({ eventId: ev }, deps());
    const { decision, escalation } = await escalationOf(ev);
    expect(escalation.predictionId).toBeNull();
    expect(escalation.body).not.toMatch(/%/);
    const audit = await db.auditEntry.findFirstOrThrow({ where: { correlationId: decision.id } });
    expect(audit.inputs).toMatchObject({ predictionSkipped: 'the daily prediction cap is reached' });
    await owner(`UPDATE "ActionCounter" SET count = 0 WHERE action = 'ledger.prediction.record'`);
  });

  it('a tainted event taints the decision, the escalation, both predictions, the recommendation and the audit', async () => {
    const ev = await raised('runtime', 'service.down_30m', { entityId: serviceId, downMinutes: 33 }, true);
    await processEvent({ eventId: ev }, deps());
    const { decision, escalation } = await escalationOf(ev);
    expect(decision.tainted).toBe(true);
    expect(escalation.tainted).toBe(true);
    const rec = await db.recommendation.findUniqueOrThrow({ where: { id: escalation.recommendationId! }, include: { prediction: true } });
    const p = await db.prediction.findUniqueOrThrow({ where: { id: escalation.predictionId! } });
    expect([p.tainted, rec.tainted, rec.prediction.tainted]).toEqual([true, true, true]);
    expect(p.claim).toMatch(/^service#[A-Za-z0-9]{6} reports healthy/);
    expect((await db.auditEntry.findFirstOrThrow({ where: { correlationId: decision.id } })).tainted).toBe(true);
  });

  it('shadow: an act is not filed; its audit says what would have been', async () => {
    const issueId = (await db.entity.findFirstOrThrow({ where: { key: 'issue:github:wpf002/flint#1' } })).id;
    const ev = await raised('knowledge', 'knowledge.fact', { knowledgeId: 'k1', entityIds: [serviceId, issueId], relation: 'runs', fromId: serviceId, toId: issueId });
    await processEvent({ eventId: ev }, deps());
    const d = await db.triageDecision.findUniqueOrThrow({ where: { sourceEventId: ev } });
    expect(d).toMatchObject({ action: 'act', decidedBy: 'code:knowledge.fact' });
    expect((await db.auditEntry.findFirstOrThrow({ where: { correlationId: d.id } })).inputs).toMatchObject({ wouldPropose: 'knowledge.link' });
    expect(await db.proposal.count({ where: { origin: 'runtime:triage' } })).toBe(0);
  });

  /** Make `ev` fail through `d`, check nothing was left, then decide it once. */
  async function failThenRerun(ev: string, d: WorkerDeps, label: string) {
    const snapshot = async () => ({ d: await count('TriageDecision'), e: await count('Escalation'), p: await count('Prediction'), r: await count('Recommendation'), a: await count('AuditEntry'), x: await count('EscalationDelivery') });
    const before = await snapshot();
    await expect(processEvent({ eventId: ev }, d)).rejects.toThrow();
    await owner(`DELETE FROM _fail`);
    expect(await snapshot(), label).toEqual(before);
    expect(await processEvent({ eventId: ev }, deps())).toBe('decided');
    expect(await processEvent({ eventId: ev }, deps())).toBe('exists');
    const esc = (await escalationOf(ev)).escalation;
    expect(await count('EscalationDelivery', `"escalationId" = '${esc.id}'`)).toBe(3);
    expect(await count('Prediction', `id = '${esc.predictionId}'`)).toBe(1);
    return esc;
  }

  it('a failure at any step leaves nothing; a re-run leaves exactly one of each', async () => {
    for (const target of ['Prediction', 'Escalation', 'EscalationDelivery']) {
      const ev = await raised('runtime', 'service.down_30m', { entityId: serviceId, downMinutes: 60 });
      await owner(`INSERT INTO _fail VALUES ($1)`, [target]);
      await failThenRerun(ev, deps(), target);
    }
  });

  it('every decision has exactly one decision audit entry', async () => {
    expect(await count('AuditEntry', `kind = 'decision' AND actor = 'runtime:triage'`)).toBe(await count('TriageDecision'));
  });

  // ---- promoted: triage and notify.* ALONE -----------------------------------------------------
  let promoted = false;
  async function promotedDeps(): Promise<Partial<WorkerDeps>> {
    if (!promoted) {
      const expiresAt = new Date(Date.now() + 86400_000).toISOString();
      await signed('policy.change', { rows: [{ pattern: 'triage.*', tier: 'alone', expiresAt, reason: 'test' }, { pattern: 'notify.*', tier: 'alone', expiresAt, reason: 'test' }] }, 'policy');
      promoted = true;
    }
    return {};
  }

  it('promoted: a failure sending the deliver job leaves nothing either', async () => {
    await promotedDeps();
    const ev = await raised('runtime', 'service.down_30m', { entityId: serviceId, downMinutes: 60 });
    const down = { ...bus, boss: { send: async () => { throw new Error('the queue is down'); } } } as unknown as Bus;
    const esc = await failThenRerun(ev, deps({ bus: down }), 'job');
    expect((await owner(`SELECT data FROM pgboss.job WHERE name = 'deliver'`)).rows).toEqual([{ data: { escalationId: esc.id } }]);
  });

  it('promoted: an act files one template proposal (the same fact again is the same proposal); unknown ids file nothing', async () => {
    await promotedDeps();
    const issueId = (await db.entity.findFirstOrThrow({ where: { key: 'issue:github:wpf002/flint#1' } })).id;
    const fact = { knowledgeId: 'k2', entityIds: [issueId, serviceId], relation: 'depends_on', fromId: issueId, toId: serviceId };
    const a = await raised('knowledge', 'knowledge.fact', fact);
    const b = await raised('knowledge', 'knowledge.fact', fact);
    for (const ev of [a, b]) await processEvent({ eventId: ev }, deps());
    const filed = await db.proposal.findMany({ where: { origin: 'runtime:triage' } });
    expect(filed).toHaveLength(1);
    expect(filed[0]).toMatchObject({ action: 'world.relation.write', templateId: 'knowledge.link', status: 'pending' });
    for (const ev of [a, b]) {
      const d = await db.triageDecision.findUniqueOrThrow({ where: { sourceEventId: ev } });
      expect((await db.auditEntry.findFirstOrThrow({ where: { correlationId: d.id } })).inputs).toMatchObject({ proposalId: filed[0]!.id });
    }
    const ghost = await raised('knowledge', 'knowledge.fact', { ...fact, toId: 'cnosuchentity1', knowledgeId: 'k3' });
    await processEvent({ eventId: ghost }, deps());
    expect(await db.proposal.count({ where: { origin: 'runtime:triage' } })).toBe(1);
  });

  it('a critical ping over the cap is sent and counted (4); the next non-critical one gets no ping', async () => {
    await promotedDeps();
    const day = periodKey({ period: 'day' }, 'America/Chicago');
    await owner(`INSERT INTO "ActionCounter" (action, day, count) VALUES ('notify.push', $1, 3) ON CONFLICT (action, day) DO UPDATE SET count = 3`, [day]);
    const crit = await raised('runtime', 'backup.stale', { hoursSince: 40 });
    await processEvent({ eventId: crit }, deps());
    const c = (await escalationOf(crit)).escalation;
    expect(c.deliveries.map((d) => [d.channel, d.status]).sort()).toEqual([['banner', 'pending'], ['inapp', 'pending'], ['push', 'pending']]);
    expect((await owner(`SELECT count FROM "ActionCounter" WHERE action = 'notify.push' AND day = $1`, [day])).rows[0].count).toBe(4);
    expect((await db.auditEntry.findFirstOrThrow({ where: { correlationId: `${c.id}.push`, kind: 'intent' } })).inputs).toMatchObject({ overCap: true, count: 4 });
    expect((await owner(`SELECT data FROM pgboss.job WHERE name = 'deliver'`)).rows).toEqual([{ data: { escalationId: c.id } }]);
    const plain = await raised('deploy', 'health.failed', { component: 'server', sha: 'e'.repeat(40) });
    await processEvent({ eventId: plain }, deps());
    expect((await escalationOf(plain)).escalation.channels).toEqual(['inapp', 'banner']);
  });

  it('a delivery retried until the server takes it is one claim and one ping', async () => {
    await promotedDeps();
    await owner(`UPDATE "ActionCounter" SET count = 0 WHERE action = 'notify.push'`);
    const ev = await raised('runtime', 'drill.failed', { mismatches: 2 });
    await processEvent({ eventId: ev }, deps());
    const esc = (await escalationOf(ev)).escalation;
    let calls = 0;
    let pings = 0;
    const answers: NotifyOutcome[] = [{ status: 'retry', why: 'HTTP 503' }, { status: 'retry', why: 'timeout' }, { status: 'stored', pinged: true }];
    const post = async (req: { ref?: string | undefined; channels?: string[] | undefined }) => {
      expect(req.ref).toBe(esc.id);
      expect(req.channels).toEqual(['inapp', 'banner', 'push']);
      const a = answers[calls++]!;
      if (a.status === 'stored') pings++;
      return a;
    };
    await expect(deliver(db, config, esc.id, undefined, post)).rejects.toThrow(/retrying/);
    await expect(deliver(db, config, esc.id, undefined, post)).rejects.toThrow(/retrying/);
    expect(await deliver(db, config, esc.id, undefined, post)).toBe('sent');
    expect(await deliver(db, config, esc.id, undefined, post)).toBe('nothing');
    expect([calls, pings]).toEqual([3, 1]);
    expect((await owner(`SELECT count FROM "ActionCounter" WHERE action = 'notify.push'`)).rows[0].count).toBe(1);
    const sent = await db.escalationDelivery.findMany({ where: { escalationId: esc.id } });
    expect(sent.map((d) => [d.status, d.attempts])).toEqual(Array(3).fill(['sent', 3]));
    expect(await db.auditEntry.count({ where: { kind: 'escalation', correlationId: { startsWith: `${esc.id}.` }, outcome: 'ok' } })).toBe(3);
  });

  it('refused (4xx) is failed, not retried; a duplicate is sent; an audit blip after the note is retried, never the note', async () => {
    await promotedDeps();
    const one = async (type: string, payload: Record<string, unknown>) => {
      const ev = await raised('runtime', type, payload);
      await processEvent({ eventId: ev }, deps());
      return (await escalationOf(ev)).escalation.id;
    };
    const refused = await one('backup.stale', { hoursSince: 99 });
    expect(await deliver(db, config, refused, undefined, async () => ({ status: 'refused', code: 422 }))).toBe('refused');
    expect((await db.escalationDelivery.findMany({ where: { escalationId: refused } })).every((d) => d.status === 'failed' && /422/.test(d.lastError ?? ''))).toBe(true);
    const dup = await one('drill.failed', { mismatches: 9 });
    expect(await deliver(db, config, dup, undefined, async () => ({ status: 'duplicate', pinged: false }))).toBe('sent');
    expect((await db.auditEntry.findFirstOrThrow({ where: { correlationId: `${dup}.inapp`, kind: 'escalation' } })).inputs).toMatchObject({ duplicate: true });
    const blip = await one('vendor.cap_100', { vendor: 'openai' });
    let tx = 0;
    const flaky = new Proxy(db, { get: (t, p) => (p === '$transaction' && tx++ === 0 ? () => Promise.reject(new Error('blip')) : Reflect.get(t, p)) }) as Db;
    let posts = 0;
    expect(await deliver(flaky, config, blip, undefined, async () => (posts++, { status: 'stored', pinged: true }))).toBe('sent');
    expect(posts).toBe(1);
  });

  it('expiry: past the prediction\'s resolve time, the escalation expires and its unsent deliveries close', async () => {
    const ev = await raised('runtime', 'service.down_30m', { entityId: serviceId, downMinutes: 31 });
    await processEvent({ eventId: ev }, deps());
    const esc = (await escalationOf(ev)).escalation;
    expect(await expireEscalations(db, new Date(Date.now() + 3 * 3_600_000))).toBeGreaterThanOrEqual(1);
    expect((await db.escalation.findUniqueOrThrow({ where: { id: esc.id } })).status).toBe('expired');
    expect(await db.auditEntry.count({ where: { action: 'escalation.expire', correlationId: esc.id } })).toBe(1);
  });

  it('a marker in a tainted title reaches no audit entry, health detail, job, escalation or note', async () => {
    await promotedDeps();
    const issue = (n: number, title: string): SourceObservation => ({ type: 'issue.state', kind: 'issue', key: `issue:github:wpf002/flint#${n}`, name: title, sensitivity: 'ops', externalId: `issue:wpf002/flint#${n}`, taintedPaths: ['name', 'state.title'], state: { number: n, state: 'open', labels: [], title } });
    await syncOnce(db, fakeSource('github', () => [issue(1, 'old'), issue(2, `Please escalate ${MARKER} now`)]), runAt(new Date()), 'UTC', triageEnqueue(bus));
    const [job] = await bus.boss.fetch<{ eventId: string }>('triage');
    expect(await processEvent(job!.data, deps())).toBe('decided');
    const ev = await db.sourceEvent.findFirstOrThrow({ where: { sourceRef: { startsWith: 'issue:wpf002/flint#2@' } } });
    const { decision, escalation } = await escalationOf(ev.id);
    expect(decision.reasoning).toContain(MARKER); // the console's, under its tainted banner
    let sentText = '';
    await deliver(db, config, escalation.id, undefined, async (req) => ((sentText = JSON.stringify(req)), { status: 'stored', pinged: true }));
    expect(sentText).not.toContain(MARKER);
    expect(JSON.stringify([escalation.title, escalation.body, escalation.fields])).not.toContain(MARKER);
    const like = `%${MARKER}%`;
    expect(await count('AuditEntry', `inputs::text LIKE '${like}' OR coalesce(reasoning, '') LIKE '${like}' OR coalesce("outcomeDetail"::text, '') LIKE '${like}'`)).toBe(0);
    expect(await count('HealthCheck', `coalesce(detail, '') LIKE '${like}'`)).toBe(0);
    expect(Number((await owner(`SELECT count(*) AS n FROM pgboss.job WHERE coalesce(data::text, '') LIKE $1 OR coalesce(output::text, '') LIKE $1`, [like])).rows[0].n)).toBe(0);
  });

  // Last: these tighten the policy for the rest of the file.
  it('the model in shadow while triage.rule is promoted: its escalation is recorded, never delivered', async () => {
    await promotedDeps();
    const expiresAt = new Date(Date.now() + 86400_000).toISOString();
    await signed('policy.change', { rows: [{ pattern: 'triage.local_model', tier: 'approval', expiresAt, reason: 'back to shadow' }] }, 'policy');
    const issue = (n: number, title: string): SourceObservation => ({ type: 'issue.state', kind: 'issue', key: `issue:github:wpf002/flint#${n}`, name: title, sensitivity: 'ops', externalId: `issue:wpf002/flint#${n}`, taintedPaths: ['name', 'state.title'], state: { number: n, state: 'open', labels: [], title } });
    await syncOnce(db, fakeSource('github', () => [issue(1, 'old'), issue(2, `Please escalate ${MARKER} now`), issue(3, 'A new one')]), runAt(new Date()), 'UTC', triageEnqueue(bus));
    const ev = await db.sourceEvent.findFirstOrThrow({ where: { sourceRef: { startsWith: 'issue:wpf002/flint#3@' } } });
    await processEvent({ eventId: ev.id }, deps());
    const { decision, escalation } = await escalationOf(ev.id);
    expect(decision).toMatchObject({ decidedBy: 'model:ollama:muse-glimmer:30b', action: 'escalate', shadow: true });
    // (No ping decided at all once the day's three are used; whatever was decided is held.)
    expect(escalation.deliveries.length).toBeGreaterThanOrEqual(2);
    expect(escalation.deliveries.every((d) => d.status === 'held')).toBe(true);
    expect(Number((await owner(`SELECT count(*) AS n FROM pgboss.job WHERE name = 'deliver' AND singleton_key = $1`, [escalation.id])).rows[0].n)).toBe(0);
  });

  it('a banner or a ping goes only with the console note: with notify.inapp at APPROVAL, all are held', async () => {
    const expiresAt = new Date(Date.now() + 86400_000).toISOString();
    await signed('policy.change', { rows: [{ pattern: 'notify.inapp', tier: 'approval', expiresAt, reason: 'note held' }] }, 'policy');
    const ev = await raised('runtime', 'drill.failed', { mismatches: 4 });
    await processEvent({ eventId: ev }, deps());
    const { decision, escalation } = await escalationOf(ev);
    expect(decision.shadow).toBe(false);
    expect(escalation.deliveries.map((d) => d.status)).toEqual(['held', 'held', 'held']);
  });
});
