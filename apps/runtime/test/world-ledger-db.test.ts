/**
 * The world model and the ledger enforce their rules in the database (plan P1
 * exit criterion 5 and the forget procedure in 3.0.5). Criterion 3 (no junk
 * versions) is the mapper's and the sync engine's: mapper.test.ts, sources.test.ts.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import pg from 'pg';
import { NO_DB, URLS, freshDb, withClient, pgError, id, HEX } from './db';

type Q = (sql: string, params?: unknown[]) => Promise<pg.QueryResult>;
const as = (url: string): Q => (sql, params) => withClient(url, (c) => c.query(sql, params));

describe.skipIf(NO_DB)('world model and ledger in the database', () => {
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
    await approver(`INSERT INTO "ApprovalCredential" (id, "credentialId", factor, "publicKey", label, "enrolledVia") VALUES ($1, $2, 'webauthn', '\\x00', 'k', 'enroll_code')`, [id(), credentialId]);
  });

  async function approval(subjectType: string, subjectId: string, action: string, fields?: Record<string, unknown>): Promise<string> {
    const aid = id('appr');
    const expires = new Date(Date.now() + 600_000).toISOString();
    const payload = { v: 1, subjectType, subjectId, decision: 'approve', action, argsDigest: HEX('a'), expiresAt: expires, nonce: 'n', ...(fields ? { fields } : {}) };
    await approver(
      `INSERT INTO "Approval" (id, "subjectType", "subjectId", decision, payload, challenge, "credentialId", signature, "expiresAt") VALUES ($1, $2, $3, 'approve', $4, $5, $6, '\\x01', $7)`,
      [aid, subjectType, subjectId, JSON.stringify(payload), HEX('c'), credentialId, expires],
    );
    return aid;
  }

  async function entity(kind = 'service', key = id('svc:'), name = 'com.flint.server', sensitivity = 'ops'): Promise<string> {
    const eid = id('ent');
    await app(
      `INSERT INTO "Entity" (id, kind, key, name, state, "stateHash", sensitivity, "lastObservedAt", "updatedAt") VALUES ($1, $2, $3, $4, '{"health":"ok"}', $5, $6, now(), now())`,
      [eid, kind, key, name, HEX('e'), sensitivity],
    );
    await app(`INSERT INTO "EntityVersion" (id, "entityId", version, "changeKind", state, actor, "validFrom") VALUES ($1, $2, 1, 'created', '{"health":"ok"}', 'sync:launchd', now())`, [id('ev'), eid]);
    return eid;
  }

  async function prediction(o: { probability?: number; method?: string; resolveBy?: string; subject?: string; supersedes?: string; resolver?: string; conditionRec?: string } = {}): Promise<string> {
    const pid = id('pred');
    await app(
      `INSERT INTO "Prediction" (id, claim, probability, method, domain, type, evidence, "resolutionCriteria", resolver, "resolveBy", "subjectEntityId", "supersedesId", "conditionRecommendationId", "createdBy")
       VALUES ($1, 'Flint stays up', $2, $3, 'services', 'event_occurs', '[{"kind":"metric","ref":"x"}]', 'health ok at resolveBy', $4, now() + $5::interval, $6, $7, $8, 'test')`,
      [pid, o.probability ?? 0.8, o.method ?? 'rule', o.resolver ?? 'auto_world', o.resolveBy ?? '7 days', o.subject ?? null, o.supersedes ?? null, o.conditionRec ?? null],
    );
    return pid;
  }

  describe('entities, versions and relations', () => {
    it('entities are never deleted and never change kind or key outside a forget', async () => {
      const e = await entity();
      expect((await pgError(app(`DELETE FROM "Entity" WHERE id = $1`, [e]))).message).toMatch(/permission denied/);
      expect((await pgError(owner(`DELETE FROM "Entity" WHERE id = $1`, [e]))).message).toMatch(/never deleted/);
      expect((await pgError(app(`UPDATE "Entity" SET kind = 'repo' WHERE id = $1`, [e]))).message).toMatch(/never change/);
      expect((await pgError(app(`UPDATE "Entity" SET key = 'other' WHERE id = $1`, [e]))).message).toMatch(/forget_entity/);
      expect((await pgError(app(`UPDATE "Entity" SET status = 'forgotten' WHERE id = $1`, [e]))).message).toMatch(/forget_entity/);
      await app(`UPDATE "Entity" SET state = '{"health":"down"}', version = 2 WHERE id = $1`, [e]);
    });

    it('versions are append-only', async () => {
      const e = await entity();
      expect((await pgError(app(`UPDATE "EntityVersion" SET state = '{}' WHERE "entityId" = $1`, [e]))).message).toMatch(/permission denied/);
      expect((await pgError(owner(`UPDATE "EntityVersion" SET state = NULL WHERE "entityId" = $1`, [e]))).message).toMatch(/append-only/);
      expect((await pgError(owner(`DELETE FROM "EntityVersion" WHERE "entityId" = $1`, [e]))).message).toMatch(/append-only/);
      expect((await pgError(app(`INSERT INTO "EntityVersion" (id, "entityId", version, "changeKind", actor, "validFrom") VALUES ($1, $2, 1, 'updated', 'x', now())`, [id(), e]))).code).toBe('23505');
    });

    it('relations: never to self, one open per pair, closed once and never edited', async () => {
      const a = await entity();
      const b = await entity();
      expect((await pgError(app(`INSERT INTO "Relation" (id, type, "fromId", "toId", "validFrom") VALUES ($1, 'depends_on', $2, $2, now())`, [id(), a]))).message).toMatch(/not_self/);
      const r = id('rel');
      await app(`INSERT INTO "Relation" (id, type, "fromId", "toId", attrs, "validFrom") VALUES ($1, 'depends_on', $2, $3, '{"why":"x"}', now())`, [r, a, b]);
      expect((await pgError(app(`INSERT INTO "Relation" (id, type, "fromId", "toId", "validFrom") VALUES ($1, 'depends_on', $2, $3, now())`, [id(), a, b]))).code).toBe('23505');
      expect((await pgError(app(`UPDATE "Relation" SET attrs = '{}' WHERE id = $1`, [r]))).message).toMatch(/only validTo/);
      await app(`UPDATE "Relation" SET "validTo" = now() WHERE id = $1`, [r]);
      expect((await pgError(app(`UPDATE "Relation" SET "validTo" = now() + interval '1 day' WHERE id = $1`, [r]))).message).toMatch(/already closed/);
      await app(`INSERT INTO "Relation" (id, type, "fromId", "toId", "validFrom") VALUES ($1, 'depends_on', $2, $3, now())`, [id(), a, b]);
    });

    it('PersonGuard: a source row is always from Will\'s own account', async () => {
      const e = await entity();
      expect((await pgError(app(`INSERT INTO "EntitySource" (id, "entityId", source, "externalId", "accountOwner", "lastSyncedAt") VALUES ($1, $2, 'github', 'x', 'someone', now())`, [id(), e]))).message).toMatch(/owner_check/);
    });

    it('a source turns on only while its approved enable proposal executes', async () => {
      expect((await pgError(app(`INSERT INTO "SourceCursor" (source, cursor, enabled, "updatedAt") VALUES ('git', '', true, now())`))).message).toMatch(/needs an approved/);
      await app(`INSERT INTO "SourceCursor" (source, cursor, "updatedAt") VALUES ('git', '', now())`);
      expect((await pgError(app(`UPDATE "SourceCursor" SET enabled = true WHERE source = 'git'`))).message).toMatch(/needs an approved/);
      const p = id('prop');
      await app(`INSERT INTO "Proposal" (id, kind, origin, action, args, "argsDigest", "argsProvenance", "expiresAt") VALUES ($1, 'tool_call', 'console', 'world.source.enable', '{"source":"git"}', $2, '{}', now() + interval '1 hour')`, [p, HEX('a')]);
      await app(`UPDATE "Proposal" SET status = 'approved', "approvalId" = $2 WHERE id = $1`, [p, await approval('proposal', p, 'world.source.enable')]);
      expect((await pgError(app(`UPDATE "SourceCursor" SET enabled = true WHERE source = 'git'`))).message).toMatch(/needs an approved/);
      await app(`UPDATE "Proposal" SET status = 'executing' WHERE id = $1`, [p]);
      await app(`UPDATE "SourceCursor" SET enabled = true WHERE source = 'git'`);
      // Another source is not covered by git's approval.
      expect((await pgError(app(`INSERT INTO "SourceCursor" (source, cursor, enabled, "updatedAt") VALUES ('health', '', true, now())`))).message).toMatch(/needs an approved/);
    });

    it('a cursor never changes source: renaming an enabled one cannot turn on another source', async () => {
      const cursors = await app(`SELECT source FROM "SourceCursor" WHERE enabled`);
      expect(cursors.rows.map((r) => r.source)).toContain('git');
      expect((await pgError(app(`UPDATE "SourceCursor" SET source = 'google' WHERE source = 'git'`))).message).toMatch(/never changes/);
    });

    it('a merge needs an approved, executing world.entity.merge into a live entity, and is permanent', async () => {
      const dup = await entity();
      const into = await entity();
      expect((await pgError(app(`UPDATE "Entity" SET status = 'merged', "mergedIntoId" = $2 WHERE id = $1`, [dup, into]))).message).toMatch(/needs an approved world.entity.merge/);
      expect((await pgError(app(`INSERT INTO "Entity" (id, kind, key, name, state, "stateHash", status, "mergedIntoId", version, "lastObservedAt", "updatedAt") VALUES ($1, 'service', $2, 'x', '{}', $3, 'merged', $4, 2, now(), now())`, [id(), id('k:'), HEX('e'), into]))).message).toMatch(/new entity is active/);
      const p = id('prop');
      await app(`INSERT INTO "Proposal" (id, kind, origin, action, args, "argsDigest", "argsProvenance", "expiresAt") VALUES ($1, 'tool_call', 'console', 'world.entity.merge', $2, $3, '{}', now() + interval '1 hour')`, [p, JSON.stringify({ from: dup, into }), HEX('a')]);
      await app(`UPDATE "Proposal" SET status = 'approved', "approvalId" = $2 WHERE id = $1`, [p, await approval('proposal', p, 'world.entity.merge')]);
      await app(`UPDATE "Proposal" SET status = 'executing' WHERE id = $1`, [p]);
      await app(`UPDATE "Entity" SET status = 'merged', "mergedIntoId" = $2 WHERE id = $1`, [dup, into]);
      expect((await pgError(app(`UPDATE "Entity" SET status = 'active', "mergedIntoId" = NULL WHERE id = $1`, [dup]))).message).toMatch(/was merged/);
      // And a merged entity can still be forgotten.
      await app(`SELECT forget_entity($1, $2)`, [dup, await approval('forget', dup, 'world.forget')]);
      expect((await app(`SELECT status, "mergedIntoId" FROM "Entity" WHERE id = $1`, [dup])).rows[0]).toEqual({ status: 'forgotten', mergedIntoId: null });
    });

    it('only OPS series may leave the box; backups off the box are encrypted', async () => {
      expect((await pgError(app(`INSERT INTO "MetricSeries" (key, unit, freq, sensitivity, "offBoxAllowed", description) VALUES ('spend.anthropic.usd', 'usd', 'D', 'financial', true, 'x')`))).message).toMatch(/offbox/);
      expect((await pgError(app(`INSERT INTO "BackupRun" (id, kind, location, path, encrypted, status, "startedAt") VALUES ($1, 'pg_dump_flint', 'icloud', '/x', false, 'ok', now())`, [id()]))).message).toMatch(/offsite/);
    });
  });

  describe('ledger', () => {
    it('emit rules hold in the database: probability band, horizon, binary needs p', async () => {
      expect((await pgError(prediction({ probability: 0.97 }))).message).toMatch(/probability_check/);
      expect((await pgError(prediction({ probability: 0.02, method: 'model_reasoning' }))).message).toMatch(/probability_check/);
      expect(await prediction({ probability: 0.99, method: 'human', resolver: 'will' })).toBeTruthy();
      expect((await pgError(prediction({ resolveBy: '181 days' }))).message).toMatch(/horizon_check/);
      expect((await pgError(prediction({ resolveBy: '-1 hour' }))).message).toMatch(/horizon_check/);
      expect((await pgError(app(
        `INSERT INTO "Prediction" (id, claim, method, domain, type, evidence, "resolutionCriteria", resolver, "resolveBy", "createdBy") VALUES ($1, 'c', 'rule', 'services', 'event_occurs', '[]', 'r', 'auto_world', now() + interval '1 day', 't')`,
        [id()],
      ))).message).toMatch(/binary_check/);
    });

    it('createdAt cannot be backdated', async () => {
      const pid = id('pred');
      await app(
        `INSERT INTO "Prediction" (id, claim, probability, method, domain, type, evidence, "resolutionCriteria", resolver, "resolveBy", "createdBy", "createdAt")
         VALUES ($1, 'c', 0.5, 'rule', 'services', 'event_occurs', '[]', 'r', 'auto_world', now() + interval '1 day', 't', now() - interval '30 days')`,
        [pid],
      );
      const r = await app(`SELECT "createdAt" > now() - interval '1 minute' AS fresh FROM "Prediction" WHERE id = $1`, [pid]);
      expect(r.rows[0].fresh).toBe(true);
    });

    it('the leakage trigger rejects eventAt < createdAt, and the future', async () => {
      const p = await prediction();
      expect((await pgError(app(`INSERT INTO "Resolution" (id, "predictionId", outcome, "eventAt", "resolvedBy") VALUES ($1, $2, true, now() - interval '1 hour', 'auto_world')`, [id(), p]))).message).toMatch(/would leak/);
      expect((await pgError(app(`INSERT INTO "Resolution" (id, "predictionId", outcome, "eventAt", "resolvedBy") VALUES ($1, $2, true, now() + interval '1 hour', 'auto_world')`, [id(), p]))).message).toMatch(/future/);
    });

    it('a resolution scores the prediction (Brier) and closes it', async () => {
      const p = await prediction({ probability: 0.8 });
      await app(`INSERT INTO "Resolution" (id, "predictionId", outcome, "eventAt", "resolvedBy", brier) VALUES ($1, $2, false, now(), 'auto_world', 0)`, [id(), p]);
      const r = await app(`SELECT p.status, r.brier FROM "Prediction" p JOIN "Resolution" r ON r."predictionId" = p.id WHERE p.id = $1`, [p]);
      expect(r.rows[0].status).toBe('resolved');
      expect(r.rows[0].brier).toBeCloseTo(0.64, 12);
      // Resolved once: the trigger refuses a second resolution before the unique index would.
      expect((await pgError(app(`INSERT INTO "Resolution" (id, "predictionId", outcome, "eventAt", "resolvedBy") VALUES ($1, $2, true, now(), 'auto_world')`, [id(), p]))).message).toMatch(/resolved prediction is not resolved/);
      expect((await pgError(app(`UPDATE "Resolution" SET outcome = true WHERE "predictionId" = $1`, [p]))).message).toMatch(/permission denied/);
      expect((await pgError(owner(`UPDATE "Resolution" SET outcome = true WHERE "predictionId" = $1`, [p]))).message).toMatch(/append-only/);
    });

    it('only Will resolves a prediction whose resolver is will', async () => {
      const p = await prediction({ resolver: 'will' });
      expect((await pgError(app(`INSERT INTO "Resolution" (id, "predictionId", outcome, "eventAt", "resolvedBy") VALUES ($1, $2, true, now(), 'auto_world')`, [id(), p]))).message).toMatch(/only Will/);
    });

    it('a prediction is never edited or deleted', async () => {
      const p = await prediction();
      expect((await pgError(app(`UPDATE "Prediction" SET probability = 0.6 WHERE id = $1`, [p]))).message).toMatch(/never edited/);
      expect((await pgError(app(`UPDATE "Prediction" SET claim = 'other' WHERE id = $1`, [p]))).message).toMatch(/never edited/);
      expect((await pgError(app(`DELETE FROM "Prediction" WHERE id = $1`, [p]))).message).toMatch(/permission denied/);
      expect((await pgError(owner(`DELETE FROM "Prediction" WHERE id = $1`, [p]))).message).toMatch(/never deleted/);
      expect((await pgError(app(`UPDATE "Prediction" SET status = 'resolved' WHERE id = $1`, [p]))).message).toMatch(/recording a Resolution/);
      expect((await pgError(app(`UPDATE "Prediction" SET status = 'expired' WHERE id = $1`, [p]))).message).toMatch(/past resolveBy/);
    });

    it('a VOID without an approval is rejected by the database; with one it voids', async () => {
      const p = await prediction();
      expect((await pgError(app(`UPDATE "Prediction" SET status = 'void' WHERE id = $1`, [p]))).message).toMatch(/approval/);
      const wrong = await approval('void', p, 'ledger.resolve.auto');
      expect((await pgError(app(`UPDATE "Prediction" SET status = 'void', "voidApprovalId" = $2 WHERE id = $1`, [p, wrong]))).message).toMatch(/no matching/);
      await app(`UPDATE "Prediction" SET status = 'void', "voidApprovalId" = $2 WHERE id = $1`, [p, await approval('void', p, 'ledger.void')]);
    });

    it('superseding closes the old one, flags a late revision, and the old one is still scored', async () => {
      const early = await prediction({ resolveBy: '30 days' });
      await prediction({ supersedes: early, resolveBy: '30 days' });
      const late = await prediction({ resolveBy: '24 hours' });
      const lateNew = await prediction({ supersedes: late, resolveBy: '24 hours' });
      const r = await app(`SELECT id, status, "lateSupersession", "supersededAt" IS NOT NULL AS has FROM "Prediction" WHERE id IN ($1, $2)`, [early, late]);
      const byId = Object.fromEntries(r.rows.map((x) => [x.id, x]));
      expect(byId[early]).toMatchObject({ status: 'superseded', lateSupersession: false, has: true });
      expect(byId[late]).toMatchObject({ status: 'superseded', lateSupersession: true, has: true });
      expect((await pgError(prediction({ supersedes: late }))).message).toMatch(/only an open prediction|unique/);
      await app(`INSERT INTO "Resolution" (id, "predictionId", outcome, "eventAt", "resolvedBy") VALUES ($1, $2, true, now(), 'auto_world')`, [id(), late]);
      const scored = await app(`SELECT p.status, r.brier FROM "Prediction" p JOIN "Resolution" r ON r."predictionId" = p.id WHERE p.id = $1`, [late]);
      expect(scored.rows[0].status).toBe('superseded');
      expect(scored.rows[0].brier).toBeCloseTo(0.04, 12);
      expect(lateNew).toBeTruthy();
    });

    it('condition_unmet needs the linked recommendation rejected or expired', async () => {
      const effect = await prediction();
      const rec = id('rec');
      await app(`INSERT INTO "Recommendation" (id, "templateId", params, domain, type, text, rationale, "expectedEffect", "predictionId", "createdBy") VALUES ($1, 'restart_service', '{}', 'services', 'tool_call', 't', 'r', 'e', $2, 'test')`, [rec, effect]);
      const conditional = await prediction({ resolver: 'conditional', conditionRec: rec });
      expect((await pgError(app(`UPDATE "Prediction" SET status = 'condition_unmet' WHERE id = $1`, [conditional]))).message).toMatch(/not rejected or expired/);
      await app(`UPDATE "Recommendation" SET status = 'rejected', "decidedAt" = now() WHERE id = $1`, [rec]);
      await app(`UPDATE "Prediction" SET status = 'condition_unmet' WHERE id = $1`, [conditional]);
      expect((await pgError(app(`UPDATE "Recommendation" SET status = 'accepted', "decidedAt" = now() WHERE id = $1`, [rec]))).message).toMatch(/already rejected|set once/);
      expect((await pgError(app(`UPDATE "Recommendation" SET text = 'rewritten' WHERE id = $1`, [rec]))).message).toMatch(/only be cleared/);
    });

    it('a correction needs Will\'s approval, once', async () => {
      const p = await prediction();
      const res = id('res');
      await app(`INSERT INTO "Resolution" (id, "predictionId", outcome, "eventAt", "resolvedBy") VALUES ($1, $2, true, now(), 'auto_world')`, [res, p]);
      expect((await pgError(app(`INSERT INTO "ResolutionCorrection" (id, "resolutionId", outcome, reason, "approvalId") VALUES ($1, $2, false, 'wrong', 'none')`, [id(), res]))).message).toMatch(/different correction/);
      const a = await approval('correction', res, 'ledger.resolution.correct', { outcome: false, reason: 'wrong' });
      // The approval covers exactly the outcome and reason Will signed.
      expect((await pgError(app(`INSERT INTO "ResolutionCorrection" (id, "resolutionId", outcome, reason, "approvalId") VALUES ($1, $2, true, 'wrong', $3)`, [id(), res, a]))).message).toMatch(/different correction/);
      expect((await pgError(app(`INSERT INTO "ResolutionCorrection" (id, "resolutionId", outcome, reason, "approvalId") VALUES ($1, $2, false, 'anything', $3)`, [id(), res, a]))).message).toMatch(/different correction/);
      await app(`INSERT INTO "ResolutionCorrection" (id, "resolutionId", outcome, reason, "approvalId") VALUES ($1, $2, false, 'wrong', $3)`, [id(), res, a]);
      // Used once: the same signed correction cannot be recorded twice.
      expect((await pgError(app(`INSERT INTO "ResolutionCorrection" (id, "resolutionId", outcome, reason, "approvalId") VALUES ($1, $2, false, 'wrong', $3)`, [id(), res, a]))).message).toMatch(/no matching/);
    });
  });

  describe('forget (world.forget)', () => {
    it('needs a forget approval for this entity', async () => {
      const e = await entity();
      expect((await pgError(app(`SELECT forget_entity($1, 'nope')`, [e]))).message).toMatch(/no matching/);
      const other = await approval('forget', await entity(), 'world.forget');
      expect((await pgError(app(`SELECT forget_entity($1, $2)`, [e, other]))).message).toMatch(/no matching/);
    });

    it('end to end: every listed column cleared, a tombstone, and the source suppressed', async () => {
      const e = await entity('issue', 'issue:github:wpf002/flint#9', 'Private title', 'personal');
      const other = await entity();
      const ext = 'wpf002/flint#9';
      await app(`INSERT INTO "EntitySource" (id, "entityId", source, "externalId", "accountOwner", "lastSyncedAt") VALUES ($1, $2, 'github', $3, 'will', now())`, [id(), e, ext]);
      const ev = id('se');
      await app(`INSERT INTO "SourceEvent" (id, source, "sourceRef", type, "occurredAt", sensitivity, tainted, payload, "payloadHash") VALUES ($1, 'github', $2, 'issue.opened', now(), 'personal', true, '{"title":"Private title"}', $3)`, [ev, id('ref'), HEX('f')]);
      await app(`INSERT INTO "EntityVersion" (id, "entityId", version, "changeKind", state, patch, actor, "sourceEventId", "validFrom") VALUES ($1, $2, 2, 'updated', '{"title":"Private title"}', '{"title":["a","b"]}', 'sync:github', $3, now())`, [id('ev'), e, ev]);
      await app(`UPDATE "Entity" SET version = 2 WHERE id = $1`, [e]);
      await app(`INSERT INTO "Relation" (id, type, "fromId", "toId", attrs, "validFrom") VALUES ($1, 'has_issue', $2, $3, '{"label":"Private title"}', now())`, [id('rel'), other, e]);
      await app(`INSERT INTO "AuditEntry" (id, actor, context, kind, action, inputs, reasoning, "outcomeDetail", outcome, "correlationId") VALUES ($1, 'flint', 'autonomous', 'sync', 'world.sync.github', '{}', 'saw Private title', '{"t":"Private title"}', 'ok', $2)`, [id('au'), e]);
      const pred = await prediction({ subject: e });
      await app(`INSERT INTO "Resolution" (id, "predictionId", outcome, "eventAt", "resolvedBy", evidence) VALUES ($1, $2, true, now(), 'auto_world', '{"t":"Private title"}')`, [id('res'), pred]);
      const recPred = await prediction({ subject: e });
      await app(`INSERT INTO "Recommendation" (id, "templateId", params, domain, type, text, rationale, "expectedEffect", "predictionId", "createdBy") VALUES ($1, 'close_issue', '{}', 'repos', 'tool_call', 'close Private title', 'r', 'e', $2, 'test')`, [id('rec'), recPred]);
      const prop = id('prop');
      await app(`INSERT INTO "Proposal" (id, kind, origin, action, args, "argsDigest", "argsProvenance", reason, "expiresAt") VALUES ($1, 'tool_call', 'console', 'github.comment', $2, $3, '{}', 'about Private title', now() + interval '1 hour')`, [prop, JSON.stringify({ entityId: e, body: 'Private title' }), HEX('a')]);
      // A no-change repeat of the sync: never linked to a version, keyed by `<externalId>@<hash>`.
      const repeat = id('se');
      await app(`INSERT INTO "SourceEvent" (id, source, "sourceRef", type, "occurredAt", sensitivity, tainted, payload, "payloadHash", "lastError") VALUES ($1, 'github', $2, 'issue.seen', now(), 'personal', true, '{"title":"Private title"}', $3, 'Private title failed')`, [repeat, `${ext}@${HEX('1')}`, HEX('f')]);
      await app(`UPDATE "EntitySource" SET namespace = 'ns-Private title' WHERE "entityId" = $1`, [e]);
      await app(`INSERT INTO "MetricSeries" (key, "entityId", unit, freq, sensitivity, description) VALUES ($1, $2, 'h', 'raw', 'personal', 'age of Private title')`, [`issue.age.${e}`.toLowerCase().replace(/[^a-z0-9_.-]/g, '_'), e]);
      const specPred = id('pred');
      await app(
        `INSERT INTO "Prediction" (id, claim, probability, method, domain, type, evidence, "resolutionCriteria", resolver, "resolverSpec", "modelConfig", "resolveBy", "subjectEntityId", "createdBy") VALUES ($1, 'c', 0.5, 'rule', 'repos', 'event_occurs', '[]', 'r', 'auto_world', '{"match":"Private title"}', '{"prompt":"Private title"}', now() + interval '1 day', $2, 't')`,
        [specPred, e],
      );
      const corrRes = id('res');
      await app(`INSERT INTO "Resolution" (id, "predictionId", outcome, "eventAt", "resolvedBy") VALUES ($1, $2, true, now(), 'auto_world')`, [corrRes, specPred]);
      await app(`INSERT INTO "ResolutionCorrection" (id, "resolutionId", outcome, reason, "approvalId") VALUES ($1, $2, false, 'Private title reopened', $3)`, [id(), corrRes, await approval('correction', corrRes, 'ledger.resolution.correct', { outcome: false, reason: 'Private title reopened' })]);

      const a = await approval('forget', e, 'world.forget');
      const counts = (await app(`SELECT forget_entity($1, $2) AS c`, [e, a])).rows[0].c;
      expect(counts).toMatchObject({ suppressedKeys: 1, versions: 2, sources: 1, relations: 1, sourceEvents: 2, metricSeries: 1, auditEntries: 1, predictions: 3, resolutions: 1, recommendations: 1, proposals: 1 });

      const dump = JSON.stringify(
        await Promise.all([
          app(`SELECT * FROM "Entity" WHERE id = $1`, [e]),
          app(`SELECT * FROM "EntityVersion" WHERE "entityId" = $1`, [e]),
          app(`SELECT * FROM "EntitySource" WHERE "entityId" = $1`, [e]),
          app(`SELECT * FROM "Relation" WHERE "toId" = $1`, [e]),
          app(`SELECT * FROM "SourceEvent" WHERE id = $1`, [ev]),
          app(`SELECT * FROM "AuditEntry" WHERE "correlationId" = $1`, [e]),
          app(`SELECT * FROM "Prediction" WHERE "subjectEntityId" = $1`, [e]),
          app(`SELECT * FROM "Resolution" WHERE "predictionId" = $1`, [pred]),
          app(`SELECT * FROM "Recommendation" WHERE "predictionId" = $1`, [recPred]),
          app(`SELECT * FROM "Proposal" WHERE id = $1`, [prop]),
          app(`SELECT * FROM "SourceEvent" WHERE id = $1`, [repeat]),
          app(`SELECT * FROM "MetricSeries" WHERE "entityId" = $1`, [e]),
          app(`SELECT * FROM "ResolutionCorrection" WHERE "resolutionId" = $1`, [corrRes]),
        ]).then((rs) => rs.map((r) => r.rows)),
      );
      expect(dump).not.toMatch(/Private title/);
      expect(dump).not.toContain(ext);

      const ent = (await app(`SELECT status, key, name FROM "Entity" WHERE id = $1`, [e])).rows[0];
      expect(ent.status).toBe('forgotten');
      expect(ent.key).toMatch(/^forgotten:[0-9a-f]{64}$/);
      const tomb = (await app(`SELECT "changeKind", version FROM "EntityVersion" WHERE "entityId" = $1 ORDER BY version DESC LIMIT 1`, [e])).rows[0];
      expect(tomb).toEqual({ changeKind: 'forgotten', version: 3 });
      const preds = (await app(`SELECT probability, claim FROM "Prediction" WHERE "subjectEntityId" = $1`, [e])).rows;
      // The words go; the numbers stay for calibration.
      expect(preds.map((p) => p.claim)).toEqual(['[forgotten]', '[forgotten]', '[forgotten]']);
      expect(preds.map((p) => p.probability).sort()).toEqual([0.5, 0.8, 0.8]);
      const audit = (await app(`SELECT inputs FROM "AuditEntry" WHERE kind = 'forget' AND "correlationId" = $1`, [a])).rows[0];
      expect(audit.inputs).toMatchObject({ entityId: e, approvalId: a });

      // It stays forgotten: no sync can recreate its source, nothing can edit it.
      expect((await pgError(app(`INSERT INTO "EntitySource" (id, "entityId", source, "externalId", "accountOwner", "lastSyncedAt") VALUES ($1, $2, 'github', $3, 'will', now())`, [id(), other, ext]))).message).toMatch(/stays forgotten/);
      expect((await pgError(app(`UPDATE "Entity" SET name = 'back' WHERE id = $1`, [e]))).message).toMatch(/was forgotten/);
      expect((await pgError(app(`SELECT forget_entity($1, $2)`, [e, a]))).message).toMatch(/already forgotten/);
    });

    it('the guards stay shut after a forget in the same transaction', async () => {
      const e = await entity();
      const victim = await entity();
      const a = await approval('forget', e, 'world.forget');
      await withClient(URLS!.owner, async (c) => {
        await c.query('BEGIN');
        await c.query(`SELECT forget_entity($1, $2)`, [e, a]);
        const err = await c.query(`UPDATE "EntityVersion" SET state = NULL WHERE "entityId" = $1`, [victim]).then(() => null, (x: Error) => x.message);
        await c.query('ROLLBACK');
        expect(err).toMatch(/append-only/);
      });
    });
  });
});
