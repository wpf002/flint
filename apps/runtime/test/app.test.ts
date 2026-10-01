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
      expect(r.json()).toEqual({ ok: true, db: 'up' });
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
      const used = await owner(`SELECT "consumedAt" FROM "Approval" WHERE id = $1`, [approvalId]);
      expect(used.rows[0].consumedAt).toBeNull();
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
      expect(r.json().error).toMatch(/no longer verifies/);
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
      expect(r.json().error).toMatch(/forbidden/);
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

    it('emit rejects missing criteria, a horizon over 180 days and a non-human probability outside [0.05, 0.95]', async () => {
      const base = {
        claim: 'the server stays up', probability: 0.8, method: 'rule', domain: 'services', type: 'event_occurs', evidence: [],
        resolutionCriteria: 'health ok', resolver: 'auto_world', resolveBy: new Date(Date.now() + 86400_000).toISOString(),
      };
      expect((await call('POST', '/v1/ledger/predictions', base)).statusCode).toBe(201);
      const bad = async (over: Record<string, unknown>) => (await call('POST', '/v1/ledger/predictions', { ...base, ...over })).json().error as string;
      expect(await bad({ resolutionCriteria: ' ' })).toMatch(/criteria/);
      expect(await bad({ resolveBy: new Date(Date.now() + 181 * 86400_000).toISOString() })).toMatch(/180 days/);
      expect(await bad({ probability: 0.97 })).toMatch(/5%/);
      expect(await bad({ probability: 0.02, method: 'model_reasoning' })).toMatch(/5%/);
      expect(await bad({ tainted: true })).toMatch(/template/);
      const templated = await call('POST', '/v1/ledger/predictions', { ...base, claim: undefined, tainted: true, template: { id: 'closed_by', params: { entity: 'issue#abc123' } } });
      expect(templated.json().claim).toBe('issue#abc123 is closed by the resolve time');
      expect((await call('GET', '/v1/ledger/open')).json().predictions.length).toBeGreaterThanOrEqual(2);
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
