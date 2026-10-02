/**
 * P2's rules in the database (migration p2_runtime), whatever the runtime's
 * code does: a triage rule exists only as the exact rule of a signed proposal
 * being executed and is afterwards only switched off; a decision never
 * changes but for Will's label and a purge; "acted" needs a correlated action;
 * a delivery goes out once; a critical push is counted past its cap; hours are
 * a counter period; and every refusal names its SQLSTATE (23514 for input).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import pg from 'pg';
import { NO_DB, URLS, freshDb, withClient, pgError, id, HEX } from './db';

type Q = (sql: string, params?: unknown[]) => Promise<pg.QueryResult>;
const as = (url: string): Q => (sql, params) => withClient(url, (c) => c.query(sql, params));

describe.skipIf(NO_DB)('P2 guards in the database', () => {
  let app: Q;
  let approver: Q;
  let owner: Q;
  let credentialId: string;

  beforeAll(async () => {
    const urls = await freshDb();
    app = as(urls.app);
    approver = as(urls.approver);
    owner = as(urls.owner);
    credentialId = id('cred');
    await approver(
      `INSERT INTO "ApprovalCredential" (id, "credentialId", factor, "publicKey", label, "enrolledVia") VALUES ($1, $2, 'webauthn', '\\x00', 'test key', 'enroll_code')`,
      [id(), credentialId],
    );
  });

  async function approval(subjectId: string, action: string, digest = HEX('a')): Promise<string> {
    const aid = id('appr');
    const expires = (await owner(`SELECT to_char((now() + interval '10 minutes') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS t`)).rows[0].t as string;
    const payload = { v: 1, subjectType: 'proposal', subjectId, decision: 'approve', action, argsDigest: digest, expiresAt: expires, nonce: HEX('0').slice(0, 32) };
    await approver(
      `INSERT INTO "Approval" (id, "subjectType", "subjectId", decision, payload, challenge, "credentialId", signature, "expiresAt")
       VALUES ($1, 'proposal', $2, 'approve', $3, $4, $5, '\\x01', $6)`,
      [aid, subjectId, JSON.stringify(payload), HEX('c'), credentialId, expires],
    );
    return aid;
  }

  /** A signed triage.rule.create proposal, approved and being executed. */
  async function ruleProposal(rule: Record<string, unknown>): Promise<string> {
    const pid = id('prop');
    await app(
      `INSERT INTO "Proposal" (id, kind, origin, action, args, "argsDigest", "argsProvenance", "expiresAt")
       VALUES ($1, 'rule', 'console', 'triage.rule.create', $2::jsonb, $3, '{}', now() + interval '1 hour')`,
      [pid, JSON.stringify({ rule }), HEX('a')],
    );
    const a = await approval(pid, 'triage.rule.create');
    await app(`UPDATE "Proposal" SET status = 'approved', "approvalId" = $2 WHERE id = $1`, [pid, a]);
    await app(`UPDATE "Proposal" SET status = 'executing' WHERE id = $1`, [pid]);
    return a;
  }

  const rule = (name: string) => ({ name, source: 'github', eventType: 'issue.state', predicate: { all: [{ path: 'entity.state.state', op: 'eq', value: 'open' }] }, action: 'log', lane: 'quiet', priority: 100, perSenderDailyCap: null, createdBy: 'will' });
  const insertRule = (r: Record<string, unknown>, approvalId: string) =>
    app(
      `INSERT INTO "TriageRule" (id, name, source, "eventType", predicate, action, lane, priority, "perSenderDailyCap", "createdBy", "approvalId")
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [id('tr'), r.name, r.source, r.eventType, JSON.stringify(r.predicate), r.action, r.lane, r.priority, r.perSenderDailyCap, r.createdBy, approvalId],
    );

  /** An applied source event, as a sync writes it. */
  async function event(payload: Record<string, unknown> = { a: 1 }): Promise<string> {
    const eid = id('se');
    await app(
      `INSERT INTO "SourceEvent" (id, source, "sourceRef", type, "occurredAt", sensitivity, payload, "payloadHash", status)
       VALUES ($1, 'runtime', $2, 'service.down_30m', now(), 'ops', $3::jsonb, $4, 'applied')`,
      [eid, `ref-${eid}`, JSON.stringify(payload), HEX('b')],
    );
    return eid;
  }
  async function decision(eventId: string, over: Record<string, unknown> = {}): Promise<string> {
    const did = id('td');
    await app(
      `INSERT INTO "TriageDecision" (id, "sourceEventId", action, lane, "decidedBy", sensitivity, reasoning) VALUES ($1, $2, $3, $4, $5, 'ops', $6)`,
      [did, eventId, over.action ?? 'escalate', over.lane ?? 'relevant', over.decidedBy ?? 'code:service.down_30m', over.reasoning ?? null],
    );
    return did;
  }
  async function escalation(decisionId: string): Promise<string> {
    const esid = id('es');
    await app(
      `INSERT INTO "Escalation" (id, "triageDecisionId", "templateId", fields, title, body, channels, sensitivity) VALUES ($1, $2, 'service_down', '{"minutes": 31}', 'service#abc123 is down', 'Down 31 minutes.', ARRAY['inapp'], 'ops')`,
      [esid, decisionId],
    );
    return esid;
  }

  describe('triage rules', () => {
    it('exist only as the exact rule of a signed proposal being executed', async () => {
      const a = await ruleProposal(rule('quiet-open-issues'));
      expect(await pgError(insertRule({ ...rule('quiet-open-issues'), lane: 'relevant', action: 'escalate' }, a))).toMatchObject({ message: expect.stringMatching(/not the rule in the signed proposal/) });
      expect(await pgError(insertRule(rule('another-rule'), a))).toMatchObject({ message: expect.stringMatching(/not the rule/) });
      expect((await insertRule(rule('quiet-open-issues'), a)).rowCount).toBe(1);
      // Nothing else carries a rule in: an approval for any other action.
      const pid = id('prop');
      await app(`INSERT INTO "Proposal" (id, kind, origin, action, args, "argsDigest", "argsProvenance", "expiresAt") VALUES ($1, 'tool_call', 'console', 'world.sync.git', '{"rule":{}}', $2, '{}', now() + interval '1 hour')`, [pid, HEX('a')]);
      const other = await approval(pid, 'world.sync.git');
      expect((await pgError(insertRule(rule('sneaky'), other))).message).toMatch(/not an approved rule being executed/);
    });

    it('a float in a predicate survives exact JSON and still matches', async () => {
      const r = { ...rule('threshold-rule'), predicate: { all: [{ path: 'entity.state.value', op: 'gt', value: 0.30798621616276463 }] } };
      const a = await ruleProposal(r);
      expect((await insertRule(r, a)).rowCount).toBe(1);
    });

    it('can only be switched off; every change is in RowChange', async () => {
      const a = await ruleProposal(rule('switch-me-off'));
      const rid = (await insertRule(rule('switch-me-off'), a)).rows[0].id as string;
      expect((await pgError(app(`UPDATE "TriageRule" SET lane = 'relevant' WHERE id = $1`, [rid]))).message).toMatch(/permission denied/);
      expect((await pgError(owner(`UPDATE "TriageRule" SET priority = 1 WHERE id = $1`, [rid]))).message).toMatch(/switched off/);
      await app(`UPDATE "TriageRule" SET enabled = false WHERE id = $1`, [rid]);
      expect((await pgError(app(`UPDATE "TriageRule" SET enabled = true WHERE id = $1`, [rid]))).message).toMatch(/switched off/);
      expect((await app(`SELECT changed FROM "RowChange" WHERE "rowId" = $1`, [rid])).rows).toEqual([{ changed: { enabled: [true, false] } }]);
      expect((await pgError(owner(`DELETE FROM "TriageRule" WHERE id = $1`, [rid]))).message).toMatch(/never deleted/);
    });

    it('an escalating rule is in the relevant lane; an ignoring one in the quiet lane', async () => {
      const a = await ruleProposal({ ...rule('bad-lane'), action: 'escalate', lane: 'quiet' });
      expect((await pgError(insertRule({ ...rule('bad-lane'), action: 'escalate', lane: 'quiet' }, a))).code).toBe('23514');
    });
  });

  describe('decisions', () => {
    it('never change but for Will\'s label and a purge of the reasoning (23514 for anything else)', async () => {
      const did = await decision(await event(), { reasoning: 'the model said so' });
      await app(`UPDATE "TriageDecision" SET feedback = 'ok', "feedbackAt" = now() WHERE id = $1`, [did]);
      await app(`UPDATE "TriageDecision" SET reasoning = NULL WHERE id = $1`, [did]);
      expect(await pgError(app(`UPDATE "TriageDecision" SET reasoning = 'rewritten' WHERE id = $1`, [did]))).toMatchObject({ code: '23514' });
      expect((await pgError(app(`UPDATE "TriageDecision" SET lane = 'quiet' WHERE id = $1`, [did]))).message).toMatch(/permission denied/);
      expect(await pgError(owner(`UPDATE "TriageDecision" SET lane = 'quiet' WHERE id = $1`, [did]))).toMatchObject({ code: '23514' });
      expect((await pgError(owner(`DELETE FROM "TriageDecision" WHERE id = $1`, [did]))).code).toBe('42501');
    });

    it('decidedBy is one of the known forms, never free text', async () => {
      expect((await pgError(decision(await event(), { decidedBy: 'the model thought it mattered' }))).code).toBe('23514');
      await decision(await event(), { decidedBy: 'model:ollama:muse-glimmer:30b', action: 'log', lane: 'quiet' });
      await decision(await event(), { decidedBy: 'fallback:deferred', action: 'log', lane: 'quiet' });
    });
  });

  describe('escalations', () => {
    it('"acted" needs an action with outcome ok correlated with this escalation; an unrelated ok entry is not enough', async () => {
      const esid = await escalation(await decision(await event()));
      const unrelated = id('au');
      await app(`INSERT INTO "AuditEntry" (id, actor, context, kind, action, inputs, outcome, "correlationId") VALUES ($1, 'runtime', 'autonomous', 'sync', 'world.sync.git', '{}', 'ok', 'something-else')`, [unrelated]);
      expect(await pgError(app(`UPDATE "Escalation" SET status = 'acted', "actedAuditId" = $2 WHERE id = $1`, [esid, unrelated]))).toMatchObject({ code: '23514', message: expect.stringMatching(/correlated action/) });
      const proof = id('au');
      await app(`INSERT INTO "AuditEntry" (id, actor, context, kind, action, inputs, outcome, "correlationId") VALUES ($1, 'will:console', 'console', 'action', 'service.restart', '{}', 'ok', $2)`, [proof, esid]);
      await app(`UPDATE "Escalation" SET status = 'acted', "actedAuditId" = $2 WHERE id = $1`, [esid, proof]);
      expect((await pgError(app(`UPDATE "Escalation" SET status = 'open' WHERE id = $1`, [esid]))).code).toBe('23514');
    });

    it('what it said never changes; its text is purged once, to a field-free title', async () => {
      const esid = await escalation(await decision(await event()));
      expect((await pgError(app(`UPDATE "Escalation" SET title = 'something else' WHERE id = $1`, [esid]))).code).toBe('23514');
      await app(`UPDATE "Escalation" SET title = 'A service is down', body = NULL, fields = '{}', "contentPurgedAt" = now() WHERE id = $1`, [esid]);
      expect((await pgError(app(`UPDATE "Escalation" SET "contentPurgedAt" = now() + interval '1 day' WHERE id = $1`, [esid]))).code).toBe('23514');
    });

    it('a delivery goes out once; a held one (not promoted) never does', async () => {
      const esid = await escalation(await decision(await event()));
      const d = id('ed');
      await app(`INSERT INTO "EscalationDelivery" (id, "escalationId", channel) VALUES ($1, $2, 'push')`, [d, esid]);
      await app(`UPDATE "EscalationDelivery" SET status = 'failed', attempts = 1, "lastError" = 'timeout' WHERE id = $1`, [d]);
      await app(`UPDATE "EscalationDelivery" SET status = 'sent', attempts = 2, "sentAt" = now() WHERE id = $1`, [d]);
      expect((await pgError(app(`UPDATE "EscalationDelivery" SET status = 'pending' WHERE id = $1`, [d]))).code).toBe('23514');
      const h = id('ed');
      await app(`INSERT INTO "EscalationDelivery" (id, "escalationId", channel, status) VALUES ($1, $2, 'inapp', 'held')`, [h, esid]);
      expect((await pgError(app(`UPDATE "EscalationDelivery" SET status = 'sent' WHERE id = $1`, [h]))).code).toBe('23514');
      expect((await pgError(app(`INSERT INTO "EscalationDelivery" (id, "escalationId", channel) VALUES ($1, $2, 'push')`, [id('ed'), esid]))).message).toMatch(/unique/);
    });
  });

  describe('counters', () => {
    it('an hour is a counter period, and a critical push is counted past the cap', async () => {
      const key = `2026-10-02T${String(new Date().getUTCHours()).padStart(2, '0')}`;
      expect((await app(`SELECT claim_action('triage.local_model', $1, 2) AS n`, [key])).rows[0].n).toBe(1);
      const day = new Date().toISOString().slice(0, 10);
      for (let i = 1; i <= 3; i++) expect((await app(`SELECT claim_action('notify.push.t', $1, 3) AS n`, [day])).rows[0].n).toBe(i);
      expect((await app(`SELECT claim_action('notify.push.t', $1, 3) AS n`, [day])).rows[0].n).toBeNull();
      expect((await app(`SELECT count_action('notify.push.t', $1) AS n`, [day])).rows[0].n).toBe(4);
      expect((await app(`SELECT claim_action('notify.push.t', $1, 3) AS n`, [day])).rows[0].n).toBeNull();
      expect((await pgError(app(`INSERT INTO "ActionCounter" (action, day, count) VALUES ('x', $1, 0)`, [day]))).message).toMatch(/permission denied/);
    });
  });

  describe('forget', () => {
    it('clears what P2 kept about the entity: the reasoning, the escalation text, the runtime events that named it', async () => {
      const entityId = id('en');
      await owner(`INSERT INTO "Entity" (id, kind, key, name, state, "stateHash", status, "lastObservedAt", "updatedAt") VALUES ($1, 'service', $2, 'api', '{"managedBy":"launchd"}', $3, 'active', now(), now())`, [entityId, `service:test:${entityId}`, HEX('d')]);
      const eid = await event({ entityId, downMinutes: 31 });
      const did = await decision(eid, { reasoning: 'it named the service' });
      const esid = await escalation(did);
      // The real forget, on Will's signed approval.
      const fa = id('appr');
      const expires = (await owner(`SELECT to_char((now() + interval '10 minutes') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS t`)).rows[0].t as string;
      const payload = { v: 1, subjectType: 'forget', subjectId: entityId, decision: 'approve', action: 'world.forget', argsDigest: HEX('a'), expiresAt: expires, nonce: HEX('0').slice(0, 32) };
      await approver(
        `INSERT INTO "Approval" (id, "subjectType", "subjectId", decision, payload, challenge, "credentialId", signature, "expiresAt") VALUES ($1, 'forget', $2, 'approve', $3, $4, $5, '\\x01', $6)`,
        [fa, entityId, JSON.stringify(payload), HEX('c'), credentialId, expires],
      );
      await app(`SELECT forget_entity($1, $2)`, [entityId, fa]);
      expect((await app(`SELECT payload FROM "SourceEvent" WHERE id = $1`, [eid])).rows[0].payload).toBeNull();
      expect((await app(`SELECT reasoning FROM "TriageDecision" WHERE id = $1`, [did])).rows[0].reasoning).toBeNull();
      expect((await app(`SELECT title, body, fields FROM "Escalation" WHERE id = $1`, [esid])).rows[0]).toEqual({ title: 'Something needs a look', body: null, fields: {} });
    });
  });

  it('every RAISE in a P2 function names its SQLSTATE', async () => {
    const fns = await owner(`
      SELECT p.proname, p.prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname IN ('count_action', 'triage_rule_matches_approval', 'triage_rule_update_guard', 'triage_decision_guard', 'escalation_guard', 'escalation_delivery_guard', 'entity_forgotten_p2')`);
    expect(fns.rows).toHaveLength(7);
    for (const f of fns.rows as Array<{ proname: string; prosrc: string }>) {
      const raises = f.prosrc.split(/RAISE EXCEPTION/).slice(1);
      for (const r of raises) expect(r.slice(0, r.indexOf(';')), f.proname).toMatch(/USING ERRCODE = '(check_violation|insufficient_privilege)'/);
    }
  });

  it('the app role cannot make a queue that would need DDL, and runs none', async () => {
    expect((await pgError(app(`SELECT pgboss.create_queue('p2.partitioned', '{"policy": "standard", "partition": true}'::jsonb)`))).message).toMatch(/permission denied/);
    await app(`SELECT pgboss.create_queue('p2.plain', '{"policy": "standard"}'::jsonb)`);
    expect((await app(`SELECT table_name FROM pgboss.queue WHERE name = 'p2.plain'`)).rows[0].table_name).toBe('job_common');
    expect((await pgError(app(`UPDATE pgboss.version SET version = '1'`))).message).toMatch(/permission denied/);
  });
});
