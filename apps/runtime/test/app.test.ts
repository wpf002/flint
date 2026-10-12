/**
 * The runtime API end to end against flint_test (plan P1 tests: Fastify inject
 * for 401/403 per scope, 413 and 400; governance exit criteria 6): a real P-256
 * signature approves a proposal, the runtime re-verifies before it executes,
 * a FORBIDDEN action is refused with 409, and every step is audited.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import pg from 'pg';
import { challengeOf, digestOf, type ApprovalPayload } from '@flint/policy';
import { NO_DB, URLS, freshDb, withClient } from './db';
import { buildApp } from '../src/app';
import { createDb, type Db } from '../src/db';
import { SCOPES, type RuntimeScope } from '../src/config';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const FULL = 'full-token-0123456789abcdef';
const AUDIT_ONLY = 'audit-token-0123456789abcd';

describe.skipIf(NO_DB)('runtime API', () => {
  let db: Db;
  let app: ReturnType<typeof buildApp>;
  const key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spki = key.publicKey.export({ format: 'der', type: 'spki' });
  const credentialId = `cred${Date.now().toString(36)}`;

  const approver = (sql: string, params: unknown[]) => withClient(URLS!.approver, (c) => c.query(sql, params));
  const owner = (sql: string, params: unknown[] = []) => withClient(URLS!.owner, (c) => c.query(sql, params));
  const call = (method: 'GET' | 'POST', url: string, body?: unknown, token = FULL) =>
    app.inject({ method, url, ...(body !== undefined ? { payload: body as object } : {}), headers: token ? { authorization: `Bearer ${token}` } : {} });

  beforeAll(async () => {
    const urls = await freshDb();
    db = createDb(urls.app);
    app = buildApp({
      db,
      config: {
        tz: 'America/New_York',
        tokens: [
          { name: 'server', sha256: sha(FULL), scopes: new Set(SCOPES) },
          { name: 'auditor', sha256: sha(AUDIT_ONLY), scopes: new Set<RuntimeScope>(['audit']) },
        ],
      },
    });
    await approver(`INSERT INTO "ApprovalCredential" (id, "credentialId", factor, "publicKey", label, "enrolledVia") VALUES ($1, $2, 'secure_enclave', $3, 'Touch ID (test)', 'enroll_code')`, [
      `c${credentialId}`, credentialId, spki,
    ]);
  });
  afterAll(async () => {
    await app?.close();
    await db?.$disconnect();
  });

  /** Will signs, the server verifies and records it as flint_approver. Returns the approval id. */
  async function signApproval(o: { subjectType?: ApprovalPayload['subjectType']; subjectId: string; action: string; argsDigest: string; decision?: 'approve' | 'reject'; signer?: KeyObject; credential?: string }) {
    const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    const payload: ApprovalPayload = {
      v: 1, subjectType: o.subjectType ?? 'proposal', subjectId: o.subjectId, decision: o.decision ?? 'approve', action: o.action, argsDigest: o.argsDigest, expiresAt,
      nonce: createHash('sha256').update(String(Math.random())).digest('hex').slice(0, 32),
    };
    const challenge = challengeOf(payload);
    const signature = sign('sha256', challenge, o.signer ?? key.privateKey);
    const id = `ap${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    await approver(
      `INSERT INTO "Approval" (id, "subjectType", "subjectId", decision, payload, challenge, "credentialId", signature, "expiresAt") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [id, payload.subjectType, payload.subjectId, payload.decision, JSON.stringify(payload), challenge.toString('hex'), o.credential ?? credentialId, signature, expiresAt],
    );
    return id;
  }

  const proposal = (action = 'world.sync.github', args: Record<string, unknown> = { source: 'github' }) => ({
    kind: 'tool_call', origin: 'console', action, args, argsProvenance: { source: { source: 'will', tainted: false } },
  });

  describe('the door', () => {
    it('/health needs no token and says the database is up', async () => {
      const r = await app.inject({ method: 'GET', url: '/health' });
      expect(r.json()).toEqual({ ok: true, db: 'up', degraded: [] });
    });

    it('401 without a token or with a wrong one', async () => {
      expect((await call('GET', '/v1/audit', undefined, '')).statusCode).toBe(401);
      expect((await call('GET', '/v1/audit', undefined, 'wrong-token-0123456789abcd')).statusCode).toBe(401);
    });

    it('403 for every route outside the token\'s scopes', async () => {
      expect((await call('GET', '/v1/audit', undefined, AUDIT_ONLY)).statusCode).toBe(200);
      for (const [method, url] of [['GET', '/v1/proposals'], ['GET', '/v1/world/now'], ['GET', '/v1/ledger/open'], ['POST', '/v1/counters/claim']] as const) {
        expect((await call(method, url, method === 'POST' ? {} : undefined, AUDIT_ONLY)).statusCode, url).toBe(403);
      }
    });

    it('413 for a body over 64 KB, 400 for invalid input', async () => {
      const big = [{ actor: 'x', context: 'chat', kind: 'action', action: 'x', outcome: 'ok', inputs: { a: 'b' }, reasoning: 'x'.repeat(70_000) }];
      expect((await call('POST', '/v1/audit', big)).statusCode).toBe(413);
      const bad = await call('POST', '/v1/audit', [{ actor: 'x', context: 'gossip', kind: 'action', action: 'x', outcome: 'ok', inputs: {} }]);
      expect(bad.statusCode).toBe(400);
      expect(bad.json().issues[0].path).toBe('0.context');
      expect((await call('POST', '/v1/proposals', { ...proposal(), extra: 1 })).statusCode).toBe(400);
    });
  });

  describe('audit', () => {
    it('appends, ignores a replay, refuses long free text in inputs and old timestamps', async () => {
      const entry = { id: `au${Date.now().toString(36)}abc`, at: new Date().toISOString(), actor: 'server', context: 'chat', kind: 'action', action: 'calculate', outcome: 'ok', inputs: { n: 1 } };
      expect((await call('POST', '/v1/audit', [entry])).json()).toEqual({ written: 1 });
      expect((await call('POST', '/v1/audit', [entry])).json()).toEqual({ written: 0 });
      expect((await call('POST', '/v1/audit', [{ ...entry, id: undefined, inputs: { note: 'x'.repeat(201) } }])).statusCode).toBe(400);
      expect((await call('POST', '/v1/audit', [{ ...entry, id: undefined, at: '2020-01-01T00:00:00Z' }])).statusCode).toBe(400);
    });

    it('redacts credentials before they reach the append-only table', async () => {
      const corr = `corr${Date.now().toString(36)}`;
      await call('POST', '/v1/audit', [{ actor: 'server', context: 'chat', kind: 'error', action: 'web.fetch_url', outcome: 'failed', inputs: { k: 'sk-ant-api03-abcdefghijklmnopqrstuv' }, reasoning: 'failed with Bearer abcdefgh12345678', correlationId: corr }]);
      const res = await call('GET', `/v1/audit?correlationId=${corr}`);
      if (!res.json().entries) throw new Error(res.body);
      const r = res.json().entries[0];
      expect(JSON.stringify(r)).not.toMatch(/sk-ant|abcdefgh12345678/);
    });
  });

  describe('proposals', () => {
    it('a FORBIDDEN action is refused at creation, and the refusal is audited', async () => {
      const r = await call('POST', '/v1/proposals', proposal('mcp:broker.execute_trade', { qty: 1 }));
      expect(r.statusCode).toBe(409);
      const audit = (await call('GET', '/v1/audit?action=mcp:broker.execute_trade')).json().entries;
      expect(audit[0]).toMatchObject({ decision: 'deny', outcome: 'denied', tier: 'forbidden' });
    });

    it('approve with a real signature, claim, complete: every step audited, no open intent', async () => {
      const created = (await call('POST', '/v1/proposals', proposal())).json();
      expect(created).toMatchObject({ tier: 'approval', argsDigest: digestOf({ source: 'github' }) });
      const approvalId = await signApproval({ subjectId: created.id, action: 'world.sync.github', argsDigest: created.argsDigest });
      expect((await call('POST', `/v1/proposals/${created.id}/approve`, { approvalId })).statusCode).toBe(200);
      const claimed = await call('POST', `/v1/proposals/${created.id}/claim`, {});
      expect(claimed.json()).toMatchObject({ id: created.id, args: { source: 'github' } });
      expect((await call('POST', `/v1/proposals/${created.id}/complete`, { ok: true, result: { synced: 3 } })).statusCode).toBe(200);
      const trail = (await call('GET', `/v1/audit?correlationId=${created.id}`)).json().entries.map((e: { kind: string; outcome: string }) => `${e.kind}:${e.outcome}`);
      expect(trail.sort()).toEqual(['action:ok', 'approval:ok', 'decision:pending', 'intent:pending'].sort());
      const open = await owner(`SELECT count(*)::int AS n FROM audit_open_intents WHERE "correlationId" = $1`, [created.id]);
      expect(open.rows[0].n).toBe(0);
      // Claimed once: a second claim is refused.
      expect((await call('POST', `/v1/proposals/${created.id}/claim`, {})).statusCode).toBe(409);
    });

    it('a signature by the wrong key does not approve, and leaves the approval unused', async () => {
      const created = (await call('POST', '/v1/proposals', proposal())).json();
      const forger = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      const approvalId = await signApproval({ subjectId: created.id, action: 'world.sync.github', argsDigest: created.argsDigest, signer: forger.privateKey });
      const r = await call('POST', `/v1/proposals/${created.id}/approve`, { approvalId });
      expect(r.statusCode).toBe(403);
      // Will reads a sentence (a bad signature may be worth a retry); why is in the audit and the log, under a ref.
      expect(r.json()).toMatchObject({ error: 'Your approval didn’t verify. Try again.', ref: expect.stringMatching(/^ref[0-9a-z]+$/) });
      const audit = (await call('GET', `/v1/audit?correlationId=${created.id}`)).json().entries;
      expect(audit).toContainEqual(expect.objectContaining({ kind: 'decision', decision: 'deny', outcome: 'denied', reasoning: 'the approval does not verify: bad signature' }));
      const used = await owner(`SELECT "consumedAt" FROM "Approval" WHERE id = $1`, [approvalId]);
      expect(used.rows[0].consumedAt).toBeNull();
    });

    it('a passkey approval on a runtime without passkey settings names the fix, never "Try again", and is audited', async () => {
      // A passkey (webauthn) credential: re-verifying it needs FLINT_RP_ID and FLINT_RP_ORIGINS, which this runtime lacks.
      const pk = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      const pkId = `pk${Date.now().toString(36)}`;
      await approver(`INSERT INTO "ApprovalCredential" (id, "credentialId", factor, "publicKey", label, "enrolledVia") VALUES ($1, $2, 'webauthn', $3, 'phone', 'enroll_code')`, [`c${pkId}`, pkId, pk.publicKey.export({ format: 'der', type: 'spki' })]);
      // Args of its own: the same call still pending from an earlier test would be this very card.
      const created = (await call('POST', '/v1/proposals', proposal('world.sync.github', { source: 'github', by: 'passkey' }))).json();
      const approvalId = await signApproval({ subjectId: created.id, action: 'world.sync.github', argsDigest: created.argsDigest, signer: pk.privateKey, credential: pkId });
      const r = await call('POST', `/v1/proposals/${created.id}/approve`, { approvalId });
      expect(r.statusCode).toBe(403);
      expect(r.json().error).toBe('Passkeys aren’t set up on the runtime. Give it FLINT_RP_ID and FLINT_RP_ORIGINS, then restart it.');
      const audit = (await call('GET', `/v1/audit?correlationId=${created.id}`)).json().entries;
      expect(audit).toContainEqual(expect.objectContaining({ decision: 'deny', outcome: 'denied', reasoning: 'the approval does not verify: passkey approvals need FLINT_RP_ID and FLINT_RP_ORIGINS' }));
      // A signed rejection by the same key says the same, and is audited too; the card still waits.
      const rejection = await signApproval({ subjectId: created.id, action: 'world.sync.github', argsDigest: created.argsDigest, signer: pk.privateKey, credential: pkId, decision: 'reject' });
      const no = await call('POST', `/v1/proposals/${created.id}/reject`, { approvalId: rejection });
      expect(no.statusCode).toBe(403);
      expect(no.json().error).toBe('Passkeys aren’t set up on the runtime. Give it FLINT_RP_ID and FLINT_RP_ORIGINS, then restart it.');
      expect((await owner(`SELECT status FROM "Proposal" WHERE id = $1`, [created.id])).rows[0].status).toBe('pending');
      const after = (await call('GET', `/v1/audit?correlationId=${created.id}`)).json().entries;
      expect(after.filter((e: { decision: string; outcome: string }) => e.decision === 'deny' && e.outcome === 'denied')).toHaveLength(2);
    });

    it('a signature over different args does not approve', async () => {
      const created = (await call('POST', '/v1/proposals', proposal())).json();
      const approvalId = await signApproval({ subjectId: created.id, action: 'world.sync.github', argsDigest: digestOf({ source: 'other' }) });
      expect((await call('POST', `/v1/proposals/${created.id}/approve`, { approvalId })).statusCode).toBe(403);
    });

    it('the runtime refuses to execute when re-verification fails (credential revoked after approval)', async () => {
      const key2 = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      const cred2 = `cred2${Date.now().toString(36)}`;
      await approver(`INSERT INTO "ApprovalCredential" (id, "credentialId", factor, "publicKey", label, "enrolledVia") VALUES ($1, $2, 'secure_enclave', $3, 'second', 'enroll_code')`, [`c${cred2}`, cred2, key2.publicKey.export({ format: 'der', type: 'spki' })]);
      const created = (await call('POST', '/v1/proposals', proposal())).json();
      const approvalId = await signApproval({ subjectId: created.id, action: 'world.sync.github', argsDigest: created.argsDigest, signer: key2.privateKey, credential: cred2 });
      expect((await call('POST', `/v1/proposals/${created.id}/approve`, { approvalId })).statusCode).toBe(200);
      await approver(`UPDATE "ApprovalCredential" SET "revokedAt" = now() WHERE "credentialId" = $1`, [cred2]);
      const r = await call('POST', `/v1/proposals/${created.id}/claim`, {});
      expect(r.statusCode).toBe(403);
      expect(r.json().error).toBe('Flint didn’t run it because your approval is no longer valid.');
      const p = await owner(`SELECT status FROM "Proposal" WHERE id = $1`, [created.id]);
      expect(p.rows[0].status).toBe('failed');
    });

    it('approving an action that became FORBIDDEN returns 409 (a signed policy row tightened it)', async () => {
      const target = (await call('POST', '/v1/proposals', proposal('world.sync.railway', { source: 'railway' }))).json();
      // Will signs a policy change that forbids world.sync.railway; the runtime executes it.
      const expiresAt = new Date(Date.now() + 30 * 86400_000).toISOString();
      const rows = [{ pattern: 'world.sync.railway', tier: 'forbidden', expiresAt }];
      const pol = (await call('POST', '/v1/proposals', { kind: 'policy', origin: 'console', action: 'policy.change', args: { rows }, argsProvenance: { rows: { source: 'will', tainted: false } } })).json();
      const polApproval = await signApproval({ subjectId: pol.id, action: 'policy.change', argsDigest: pol.argsDigest });
      expect((await call('POST', `/v1/proposals/${pol.id}/approve`, { approvalId: polApproval })).statusCode).toBe(200);
      expect((await call('POST', `/v1/proposals/${pol.id}/claim`, {})).statusCode).toBe(409);
      expect((await call('POST', `/v1/proposals/${pol.id}/run`, {})).json()).toEqual({ rows: 1 });

      const approvalId = await signApproval({ subjectId: target.id, action: 'world.sync.railway', argsDigest: target.argsDigest });
      const r = await call('POST', `/v1/proposals/${target.id}/approve`, { approvalId });
      expect(r.statusCode).toBe(409);
      expect(r.json().error).toBe('Flint isn’t allowed to run this.');
      // The engine's reason is kept in the audit, not thrown away.
      const audit = (await call('GET', `/v1/audit?correlationId=${target.id}`)).json().entries;
      expect(audit).toContainEqual(expect.objectContaining({ decision: 'deny', outcome: 'denied', reasoning: expect.stringMatching(/^forbidden: /) }));
    });

    it('a signed rejection rejects', async () => {
      const created = (await call('POST', '/v1/proposals', proposal())).json();
      const approvalId = await signApproval({ subjectId: created.id, action: 'world.sync.github', argsDigest: created.argsDigest, decision: 'reject' });
      expect((await call('POST', `/v1/proposals/${created.id}/reject`, { approvalId })).statusCode).toBe(200);
      expect((await call('GET', '/v1/proposals?status=rejected')).json().proposals.some((p: { id: string }) => p.id === created.id)).toBe(true);
    });
  });

  describe('caps and ledger', () => {
    it('claims under a cap, then 429', async () => {
      const action = `test.cap.${Date.now()}`;
      expect((await call('POST', '/v1/counters/claim', { action, limit: 1, period: 'day' })).json()).toEqual({ count: 1 });
      expect((await call('POST', '/v1/counters/claim', { action, limit: 1, period: 'day' })).statusCode).toBe(429);
    });

    // The body chat's ledger_record_prediction sends (packages/mcp/connectors/runtime-server.ts), field for field.
    const chatBody = () => ({
      claim: 'the server stays up', probability: 0.8, domain: 'services', type: 'event_occurs', resolutionCriteria: 'health ok',
      resolveBy: new Date(Date.now() + 86400_000).toISOString(), method: 'model_reasoning', resolver: 'will', evidence: [], tainted: false,
    });

    it('emit rejects missing criteria, a horizon over 180 days and a probability outside [0.05, 0.95]', async () => {
      const base = chatBody();
      expect((await call('POST', '/v1/ledger/predictions', base)).statusCode).toBe(201);
      const bad = async (over: Record<string, unknown>) => (await call('POST', '/v1/ledger/predictions', { ...base, ...over })).json().error as string;
      expect(await bad({ resolutionCriteria: ' ' })).toMatch(/criteria/);
      expect(await bad({ resolveBy: new Date(Date.now() + 181 * 86400_000).toISOString() })).toMatch(/180 days/);
      expect(await bad({ probability: 0.97 })).toMatch(/5%/);
      expect(await bad({ probability: 0.02 })).toMatch(/5%/);
      expect(await bad({ tainted: true })).toMatch(/template/);
      const templated = await call('POST', '/v1/ledger/predictions', { ...base, claim: undefined, tainted: true, template: { id: 'closed_by', params: { entity: 'issue#abc123' } } });
      expect(templated.json().claim).toBe('issue#abc123 is closed by the resolve time');
      expect((await call('GET', '/v1/ledger/open')).json().predictions.length).toBeGreaterThanOrEqual(2);
    });

    it('a goal’s forecast is its review’s alone: the route takes no goal id and refuses the goal template (P3)', async () => {
      // Chat's own body (the only one the route takes, P4), in the goals domain.
      const base = { ...chatBody(), domain: 'goals', type: 'deadline_met', resolutionCriteria: 'the goal is done' };
      const before = (await call('GET', '/v1/ledger/open?limit=200')).json().predictions.length;
      // The runtime's own template, which only a review fills.
      expect((await call('POST', '/v1/ledger/predictions', { ...base, template: { id: 'goal_on_track', params: { goal: 'goal#abc123', by: '2026-12-01' } } })).statusCode).toBe(400);
      // A goal's id is not a field of the body at all (it is strict), under any name.
      for (const extra of [{ goalId: 'gotestgoal0001' }, { goal: 'gotestgoal0001' }, { own: { goalId: 'gotestgoal0001' } }]) {
        expect((await call('POST', '/v1/ledger/predictions', { ...base, claim: 'a goal is done', ...extra })).statusCode, JSON.stringify(extra)).toBe(400);
      }
      expect((await call('GET', '/v1/ledger/open?limit=200')).json().predictions.length).toBe(before);
      // A plain prediction in the goals domain, about no goal, is still chat's to record.
      expect((await call('POST', '/v1/ledger/predictions', { ...base, claim: 'a goal is done' })).statusCode).toBe(201);
    });

    it('the ledger route takes only what chat sends (P4): no other method or resolver, no range, series or run, nothing chat does not send', async () => {
      const before = (await owner(`SELECT count(*)::int AS n FROM "Prediction"`)).rows[0].n as number;
      const post = (over: Record<string, unknown>) => call('POST', '/v1/ledger/predictions', { ...chatBody(), ...over });
      // Chat's exact body is recorded, as the caller's own (the connector's token), a yes/no for Will to resolve.
      const ok = await post({ claim: 'the deploy finishes today' });
      expect(ok.statusCode).toBe(201);
      expect((await owner(`SELECT kind, method, resolver, "createdBy", "seriesKey", "forecastRunId", "pointEstimate" FROM "Prediction" WHERE id = $1`, [ok.json().id])).rows[0])
        .toEqual({ kind: 'binary', method: 'model_reasoning', resolver: 'will', createdBy: 'client:server', seriesKey: null, forecastRunId: null, pointEstimate: null });
      const refused = async (over: Record<string, unknown>, field: string) => {
        const r = await post(over);
        expect(r.statusCode, JSON.stringify(over)).toBe(400);
        // The refusal names the field, never what was sent in it.
        expect(r.json(), JSON.stringify(over)).toMatchObject({ error: 'invalid input' });
        expect(r.json().issues.map((i: { path: string }) => i.path), JSON.stringify(over)).toContain(field);
        expect(r.body, JSON.stringify(over)).not.toContain('31337');
      };
      // `human` would lift the 5% to 95% band; `statistical` and `prophet` would claim a forecast.
      for (const method of ['human', 'statistical', 'prophet', 'rule', 'base_rate']) await refused({ method }, 'method');
      await refused({ method: 'human', probability: 0.999 }, 'method');
      for (const resolver of ['auto_metric', 'auto_world', 'conditional']) await refused({ resolver }, 'resolver');
      await refused({ kind: 'interval' }, 'kind');
      for (const [field, value] of Object.entries({
        pointEstimate: 31337.4242, lower: 31337.4242, upper: 31337.4242, level: 0.8, unit: 'usd', seriesKey: 'daily.spend.anthropic.usd', forecastRunId: 'frtest31337',
        subjectEntityId: 'entest0001', supersedesId: ok.json().id, conditionRecommendationId: 'rctest0001', resolverSpec: { entityId: 'x' }, model: 'some-model', modelConfig: { t: 0 },
      })) await refused({ [field]: value }, '');
      // A whole forecast, as the forecaster would write it: not over HTTP.
      await refused({ kind: 'interval', method: 'statistical', resolver: 'auto_metric', seriesKey: 'daily.deploys.count', forecastRunId: 'frtest0001', pointEstimate: 4, lower: 2, upper: 6, level: 0.8, probability: undefined }, 'method');
      // The forecaster's template is not chat's; and the body says whether the turn read outside text.
      await refused({ claim: undefined, template: { id: 'series_range', params: { series: 'daily.deploys.count', lo: 2, hi: 6, on: '2026-10-14' } } }, 'template.id');
      await refused({ tainted: undefined }, 'tainted');
      expect((await owner(`SELECT count(*)::int AS n FROM "Prediction"`)).rows[0].n).toBe(before + 1);
    });

    it('the predictions card over HTTP (P4): filed from the console, refused from chat; run by the runtime, never claimed from outside; no card for an outside forecaster', async () => {
      const card = (origin: string, action = 'forecast.series.enable', args: Record<string, unknown> = { series: ['daily.deploys.count'], reason: [] }) =>
        call('POST', '/v1/proposals', { kind: 'tool_call', origin, action, args, argsProvenance: { series: { source: 'will', tainted: false } } });
      const fromChat = await card('chat:conv1');
      expect([fromChat.statusCode, fromChat.json().error]).toEqual([409, 'Predictions are turned on from the console.']);
      for (const action of ['prophet.forecast_adhoc', 'prophet.models']) {
        const outside = await card('console', action, { series: ['daily.deploys.count'] });
        expect([outside.statusCode, outside.json().error], action).toEqual([409, 'forbidden: Flint forecasts on this Mac and calls no outside forecaster']);
      }
      const unknown = await card('console', 'forecast.series.enable', { series: ['daily.spend.acme.usd'], reason: [] });
      expect([unknown.statusCode, unknown.json().error]).toEqual([400, 'That number can’t be forecast.']);
      // A bad shape is refused with a sentence, and why (field paths and codes) goes to the log under a ref.
      const shaped = await card('console', 'forecast.series.enable', { series: ['daily.deploys.count'], reason: ['daily.calendar.hours'] });
      expect(shaped.statusCode).toBe(400);
      expect(shaped.json()).toMatchObject({ error: 'This card isn’t valid.', ref: expect.stringMatching(/^ref[0-9a-z]+$/) });
      const filed = await card('console');
      expect(filed.statusCode).toBe(201);
      expect(filed.json()).toMatchObject({ tier: 'approval', rule: 'code', deduped: false });
      // The card is marked for Will's own touch: the console then asks for it on its own, never in Approve All.
      expect((await call('GET', `/v1/proposals/${filed.json().id}`)).json().proposal).toMatchObject({ consequential: true, sensitivity: 'ops', reason: 'Approving turns on Flint’s forecasts of these numbers, on this Mac.' });
      const approvalId = await signApproval({ subjectId: filed.json().id, action: 'forecast.series.enable', argsDigest: filed.json().argsDigest });
      expect((await call('POST', `/v1/proposals/${filed.json().id}/approve`, { approvalId })).statusCode).toBe(200);
      const claim = await call('POST', `/v1/proposals/${filed.json().id}/claim`, {});
      expect([claim.statusCode, claim.json().error]).toEqual([409, 'forecast.series.enable is carried out by the runtime: use /run']);
      expect((await call('POST', `/v1/proposals/${filed.json().id}/run`, {})).json()).toEqual({ on: 1, reason: 0 });
      expect((await owner(`SELECT "on", reason FROM "ForecastSeries" WHERE "seriesKey" = 'daily.deploys.count'`)).rows).toEqual([{ on: true, reason: false }]);
      expect((await owner(`SELECT "offBoxAllowed" FROM "MetricSeries" WHERE key = 'daily.deploys.count'`)).rows[0].offBoxAllowed).toBe(false);
    });

    it('chat\'s list of open predictions never holds a forecast (P4): a series\' numbers do not reach chat through the ledger', async () => {
      // daily.deploys.count was turned on by the card above. A run and its two predictions, as the forecaster will write them.
      const app2 = (sql: string, params: unknown[]) => withClient(URLS!.app, (c) => c.query(sql, params));
      const run = `fr${Date.now().toString(36)}`;
      await app2(
        `INSERT INTO "ForecastRun" (id, "seriesKey", provider, endpoint, "requestDigest", horizon, level, "beatsNaive", "naiveMase", "modelMase", scale, points, "latencyMs", ok)
         VALUES ($1, 'daily.deploys.count', 'local', 'local:fc.v1', $2, 1, 0.8, true, 1.2, 0.9, 2, $3::jsonb, 4, true)`,
        [run, digestOf({ r: run }), JSON.stringify([{ at: '2026-10-14T04:00:00.000Z', mean: 31337.4242, lo: 31336.4242, hi: 31338.4242 }])]);
      const forecast = (id: string, kind: string, extra: string, values: string) => app2(
        `INSERT INTO "Prediction" (id, claim, kind, method, domain, type, evidence, "resolutionCriteria", resolver, "resolveBy", "createdBy", "seriesKey", "forecastRunId", unit${extra})
         VALUES ($1, $2, $3, 'statistical', 'deploys', 'trend', '[]', 'synthetic', 'auto_metric', now() + interval '1 hour', 'runtime:forecast', 'daily.deploys.count', $4, 'count'${values})`,
        [id, 'daily.deploys.count is between 31336.4242 and 31338.4242 on 2026-10-14', kind, run]);
      await forecast(`pdr${run}`, 'interval', ', "pointEstimate", lower, upper, level', ', 31337.4242, 31336.4242, 31338.4242, 0.8');
      await forecast(`pdq${run}`, 'binary', ', probability', ', 0.7');
      const open = await call('GET', '/v1/ledger/open?limit=200');
      expect(open.statusCode).toBe(200);
      const ids = open.json().predictions.map((p: { id: string }) => p.id);
      expect(ids).not.toContain(`pdr${run}`);
      expect(ids).not.toContain(`pdq${run}`);
      expect(open.body).not.toContain('31337');
      expect(open.body).not.toContain('daily.deploys.count');
      // Chat's own predictions are still listed (the ones the tests above recorded), soonest first.
      expect(ids.length).toBeGreaterThanOrEqual(2);
      expect(open.json().predictions.every((p: { seriesKey: string | null; forecastRunId: string | null }) => p.seriesKey === null && p.forecastRunId === null)).toBe(true);
    });

    it('chat\'s list leaves a forecast out by every mark it has, not by its run and series alone: its writer, its unit, a range of any kind', async () => {
      const app2 = (sql: string, params: unknown[]) => withClient(URLS!.app, (c) => c.query(sql, params));
      const tag = Date.now().toString(36);
      const loose = (id: string, createdBy: string, cols: string, values: string, q = app2) => q(
        `INSERT INTO "Prediction" (id, claim, method, domain, type, evidence, "resolutionCriteria", resolver, "resolveBy", "createdBy"${cols})
         VALUES ($1, 'daily.spend.x.usd is near 31337.4242', 'base_rate', 'spend', 'trend', '[]', 'synthetic', 'auto_metric', now() + interval '1 hour', $2${values})`, [id, createdBy]);
      // The database refuses a forecast writer's row that names no run and no series...
      await expect(loose(`pdw${tag}`, 'runtime:forecast', ', kind, probability', `, 'binary', 0.6`)).rejects.toMatchObject({ code: '23514' });
      // ...and the route does not lean on that: a row from before the rule (here, written with the rule off) is left out by its writer.
      await owner(`ALTER TABLE "Prediction" DISABLE TRIGGER "Prediction_valid"`);
      try {
        await loose(`pdw${tag}`, 'runtime:forecast', ', kind, probability', `, 'binary', 0.6`);
        await loose(`pdv${tag}`, 'runtime:reason', ', kind, probability', `, 'binary', 0.6`);
      } finally {
        await owner(`ALTER TABLE "Prediction" ENABLE TRIGGER "Prediction_valid"`);
      }
      expect((await owner(`SELECT tgenabled FROM pg_trigger WHERE tgname = 'Prediction_valid'`)).rows).toEqual([{ tgenabled: 'O' }]);
      // Another writer's row with a unit, and another writer's range with no run: left out by the unit, and by being a range.
      await loose(`pdu${tag}`, 'runtime:other', ', kind, probability, unit', `, 'binary', 0.6, 'usd'`);
      await loose(`pdi${tag}`, 'runtime:other', ', kind, "pointEstimate", lower, upper, level', `, 'interval', 31337.4242, 1, 99999, 0.8`);
      expect((await owner(`SELECT count(*)::int AS n FROM "Prediction" WHERE id = ANY ($1) AND status = 'open'`, [[`pdw${tag}`, `pdv${tag}`, `pdu${tag}`, `pdi${tag}`]])).rows[0].n).toBe(4);
      const open = await call('GET', '/v1/ledger/open?limit=200');
      expect(open.statusCode).toBe(200);
      const ids = open.json().predictions.map((p: { id: string }) => p.id);
      for (const id of [`pdw${tag}`, `pdv${tag}`, `pdu${tag}`, `pdi${tag}`]) expect(ids, id).not.toContain(id);
      expect(open.body).not.toContain('31337');
      expect(open.json().predictions.every((p: { kind: string; unit: string | null; createdBy: string }) => p.kind === 'binary' && p.unit === null && !/^runtime:(forecast|reason)$/.test(p.createdBy))).toBe(true);
      expect(ids.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('review of the server integration (PR #41)', () => {
    it('the same call proposed again while the first is pending is that proposal: one card, one approval', async () => {
      const args = { source: 'git', n: Math.random() };
      const first = (await call('POST', '/v1/proposals', proposal('world.sync.git', args))).json();
      expect(first.deduped).toBe(false);
      const again = (await call('POST', '/v1/proposals', proposal('world.sync.git', args))).json();
      expect(again).toMatchObject({ id: first.id, deduped: true });
      // Ten at once (a replayed spool racing a retry) still agree on one row.
      const racing = await Promise.all(Array.from({ length: 10 }, () => call('POST', '/v1/proposals', proposal('world.sync.git', { ...args, race: true }))));
      expect(new Set(racing.map((r) => r.json().id)).size).toBe(1);
      // A tainted filing of the same call is its own card.
      const tainted = (await call('POST', '/v1/proposals', { ...proposal('world.sync.git', args), tainted: true })).json();
      expect(tainted.id).not.toBe(first.id);
    });

    it('one proposal by id; the live policy rows', async () => {
      const created = (await call('POST', '/v1/proposals', proposal('world.sync.health', { source: 'health', k: Math.random() }))).json();
      expect((await call('GET', `/v1/proposals/${created.id}`)).json().proposal).toMatchObject({ id: created.id, status: 'pending', origin: 'console' });
      expect((await call('GET', '/v1/proposals/prnope')).statusCode).toBe(404);
      expect((await call('GET', '/v1/proposals/prnope', undefined, AUDIT_ONLY)).statusCode).toBe(403);
      expect((await call('GET', '/v1/policies')).json()).toEqual({ policies: expect.any(Array) });
    });

    it('an execution that never reports back is failed as outcome unknown after an hour, and audited so', async () => {
      const { sweepExecuting } = await import('../src/governance/proposals');
      const args = { source: 'launchd', k: Math.random() };
      const created = (await call('POST', '/v1/proposals', proposal('world.sync.launchd', args))).json();
      await call('POST', `/v1/proposals/${created.id}/approve`, { approvalId: await signApproval({ subjectId: created.id, action: 'world.sync.launchd', argsDigest: created.argsDigest }) });
      const claimed = await call('POST', `/v1/proposals/${created.id}/claim`, {});
      expect(claimed.statusCode, claimed.body).toBe(200);
      expect(await sweepExecuting(db, new Date())).toBe(0); // not yet
      expect(await sweepExecuting(db, new Date(Date.now() + 2 * 3600_000))).toBeGreaterThanOrEqual(1);
      const p = (await call('GET', `/v1/proposals/${created.id}`)).json().proposal;
      expect(p).toMatchObject({ status: 'failed', error: expect.stringMatching(/outcome unknown/) });
      const trail = (await call('GET', `/v1/audit?correlationId=${created.id}`)).json().entries as Array<{ kind: string; outcome: string; inputs: Record<string, unknown> }>;
      expect(trail.find((e) => e.kind === 'action')).toMatchObject({ outcome: 'failed', inputs: { outcomeUnknown: true } });
      const open = await owner(`SELECT count(*)::int AS n FROM audit_open_intents WHERE "correlationId" = $1`, [created.id]);
      expect(open.rows[0].n).toBe(0);
      // It reports after all: the true outcome is recorded, correlated, and nothing is lost.
      expect((await call('POST', `/v1/proposals/${created.id}/complete`, { ok: true, result: { synced: 1 } })).statusCode).toBe(200);
      const after = (await call('GET', `/v1/audit?correlationId=${created.id}`)).json().entries as Array<{ kind: string; outcome: string; inputs: Record<string, unknown> }>;
      expect(after.find((e) => e.inputs.lateReport === true)).toMatchObject({ kind: 'action', outcome: 'ok' });
    });

    it('args are stored exactly as proposed (a long float through the ORM came back a digit short, and the claim then refused it)', async () => {
      for (let i = 0; i < 40; i++) {
        const v = Math.random();
        const created = (await call('POST', '/v1/proposals', proposal('world.sync.spend', { source: 'spend', v }))).json();
        const r = await owner(`SELECT args::text AS t FROM "Proposal" WHERE id = $1`, [created.id]);
        expect(JSON.parse(r.rows[0].t).v).toBe(v);
        expect(created.argsDigest).toBe(digestOf({ source: 'spend', v }));
      }
    });

    it('a rollup batch is counted once, however often it is resent', async () => {
      const day = new Date().toISOString().slice(0, 10);
      const action = `rollup.test.${Math.random().toString(36).slice(2, 8)}`;
      const batch = { batchId: 'ab'.repeat(16), rows: [{ day, action, context: 'chat', n: 3 }] };
      expect((await call('POST', '/v1/audit/rollup', batch)).json()).toEqual({ counted: 1 });
      expect((await call('POST', '/v1/audit/rollup', batch)).json()).toEqual({ counted: 0, duplicate: true });
      const r = await owner(`SELECT count FROM "AuditRollup" WHERE day = $1 AND action = $2`, [day, action]);
      expect(r.rows[0].count).toBe(3);
      // The first format (a bare array) still counts.
      expect((await call('POST', '/v1/audit/rollup', [{ day, action, context: 'chat', n: 1 }])).statusCode).toBe(200);
    });

    it('only a refusal for what an entry contains is the caller\'s fault; a privilege fault stays a 500', async () => {
      const { dbRefused } = await import('../src/app');
      expect(dbRefused({ code: '23514' })).toBe(true);
      expect(dbRefused({ message: 'ConnectorError ... code: "23514", message: "audit: x"' })).toBe(true);
      expect(dbRefused({ code: '42501' })).toBe(false);
      expect(dbRefused({ message: 'code: "42501"' })).toBe(false);
    });

    it('an entry the audit trigger refuses is a 400 (set aside by the server), not a 500 (resent forever)', async () => {
      const r = await call('POST', '/v1/audit', [{ id: `au${Date.now().toString(36)}x`, at: new Date().toISOString(), actor: 'will:console', context: 'console', kind: 'approval', action: 'approval.enroll', inputs: { approvalId: null }, outcome: 'ok' }]);
      expect(r.statusCode).toBe(400);
      expect(r.json().error).toMatch(/audit refused/);
    });
  });

  it('proposals stay consistent under concurrent claims', async () => {
    const created = (await call('POST', '/v1/proposals', proposal())).json();
    await call('POST', `/v1/proposals/${created.id}/approve`, { approvalId: await signApproval({ subjectId: created.id, action: 'world.sync.github', argsDigest: created.argsDigest }) });
    const results = await Promise.all(Array.from({ length: 8 }, () => call('POST', `/v1/proposals/${created.id}/claim`, {})));
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
    void pg;
  });
});
