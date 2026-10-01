/**
 * The governance tables enforce their rules in the database (plan P1 exit
 * criterion 6), whatever the runtime's code does: approvals only through
 * flint_approver, a proposal is approved only by a matching unused approval,
 * policy rows only from a signed policy proposal, append-only audit, atomic caps.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import pg from 'pg';
import { NO_DB, URLS, freshDb, withClient, pgConfig, pgError, id, HEX } from './db';

type Q = (sql: string, params?: unknown[]) => Promise<pg.QueryResult>;
const as = (url: string): Q => (sql, params) => withClient(url, (c) => c.query(sql, params));

const DIGEST = HEX('a');

describe.skipIf(NO_DB)('governance in the database', () => {
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

  /** A pending proposal, as the runtime would create it. */
  async function proposal(over: { action?: string; kind?: string; args?: unknown; digest?: string; expiresIn?: string } = {}): Promise<string> {
    const pid = id('prop');
    await app(
      `INSERT INTO "Proposal" (id, kind, origin, action, args, "argsDigest", "argsProvenance", "expiresAt")
       VALUES ($1, $2, 'console', $3, $4, $5, '{}', now() + $6::interval)`,
      [pid, over.kind ?? 'tool_call', over.action ?? 'world.sync.github', JSON.stringify(over.args ?? { a: 1 }), over.digest ?? DIGEST, over.expiresIn ?? '1 hour'],
    );
    return pid;
  }

  /** An approval row as the server writes it after verifying Will's signature. */
  async function approval(subjectType: string, subjectId: string, o: { action?: string; digest?: string; decision?: string; expiresIn?: string } = {}): Promise<string> {
    const aid = id('appr');
    const decision = o.decision ?? 'approve';
    const expires = (await owner(`SELECT to_char((now() + $1::interval) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS t`, [o.expiresIn ?? '10 minutes'])).rows[0].t as string;
    const payload = { v: 1, subjectType, subjectId, decision, action: o.action ?? 'world.sync.github', argsDigest: o.digest ?? DIGEST, expiresAt: expires, nonce: HEX('0').slice(0, 32) };
    await approver(
      `INSERT INTO "Approval" (id, "subjectType", "subjectId", decision, payload, challenge, "credentialId", signature, "expiresAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, '\\x01', $8)`,
      [aid, subjectType, subjectId, decision, JSON.stringify(payload), HEX('c'), credentialId, expires],
    );
    return aid;
  }

  describe('approvals', () => {
    it('flint_app cannot create an approval; flint_approver can', async () => {
      const e = await pgError(app(`INSERT INTO "Approval" (id, "subjectType", "subjectId", decision, payload, challenge, "credentialId", signature, "expiresAt") VALUES ('x', 'proposal', 'p', 'approve', '{}', $1, $2, '\\x01', now() + interval '1 minute')`, [HEX('c'), credentialId]));
      expect(e.message).toMatch(/permission denied/);
      expect(await approval('proposal', 'p1')).toBeTruthy();
    });

    it('flint_approver touches nothing but approvals and credentials', async () => {
      expect((await pgError(approver(`SELECT * FROM "Proposal"`))).message).toMatch(/permission denied/);
      expect((await pgError(approver(`INSERT INTO "AuditEntry" (id, actor, context, kind, action, inputs, outcome) VALUES ('a', 'x', 'chat', 'action', 'x', '{}', 'ok')`))).message).toMatch(/permission denied/);
    });

    it('an approval must come from a live credential, match its payload and expire within a day', async () => {
      const revoked = id('cred');
      await approver(`INSERT INTO "ApprovalCredential" (id, "credentialId", factor, "publicKey", label, "enrolledVia") VALUES ($1, $2, 'secure_enclave', '\\x00', 'old', 'enroll_code')`, [id(), revoked]);
      await approver(`UPDATE "ApprovalCredential" SET "revokedAt" = now() WHERE "credentialId" = $1`, [revoked]);
      const base = [HEX('c'), 'proposal', 'p'];
      const payload = (exp: string, extra: Record<string, unknown> = {}) => JSON.stringify({ v: 1, subjectType: 'proposal', subjectId: 'p', decision: 'approve', action: 'x', argsDigest: DIGEST, expiresAt: exp, nonce: 'n', ...extra });
      const ins = (cred: string, p: string, exp: string) => approver(`INSERT INTO "Approval" (id, "subjectType", "subjectId", decision, payload, challenge, "credentialId", signature, "expiresAt") VALUES ($1, $3, $4, 'approve', $5, $2, $6, '\\x01', $7)`, [id(), ...base, p, cred, exp]);
      const soon = new Date(Date.now() + 60_000).toISOString();
      expect((await pgError(ins(revoked, payload(soon), soon))).message).toMatch(/revoked/);
      expect((await pgError(ins(credentialId, payload(soon), new Date(Date.now() + 120_000).toISOString()))).message).toMatch(/payload/);
      const far = new Date(Date.now() + 3 * 86400_000).toISOString();
      expect((await pgError(ins(credentialId, payload(far), far))).message).toMatch(/24 hours/);
      expect((await pgError(ins(credentialId, payload(soon, { subjectId: 'other' }), soon))).message).toMatch(/Approval_payload_check/);
    });

    it('only consumedAt changes, once; approvals are never deleted', async () => {
      const a = await approval('proposal', 'p2');
      expect((await pgError(app(`UPDATE "Approval" SET note = 'x' WHERE id = $1`, [a]))).message).toMatch(/permission denied/);
      expect((await pgError(owner(`UPDATE "Approval" SET note = 'x' WHERE id = $1`, [a]))).message).toMatch(/only consumedAt/);
      await app(`UPDATE "Approval" SET "consumedAt" = now() WHERE id = $1`, [a]);
      expect((await pgError(app(`UPDATE "Approval" SET "consumedAt" = now() WHERE id = $1`, [a]))).message).toMatch(/already used/);
      expect((await pgError(owner(`DELETE FROM "Approval" WHERE id = $1`, [a]))).message).toMatch(/never deleted/);
    });

    it('a credential counter only rises and a revocation sticks', async () => {
      const c = id('cred');
      await approver(`INSERT INTO "ApprovalCredential" (id, "credentialId", factor, "publicKey", label, "enrolledVia") VALUES ($1, $2, 'webauthn', '\\x00', 'k', 'enroll_code')`, [id(), c]);
      await approver(`UPDATE "ApprovalCredential" SET "signCount" = 5 WHERE "credentialId" = $1`, [c]);
      expect((await pgError(approver(`UPDATE "ApprovalCredential" SET "signCount" = 4 WHERE "credentialId" = $1`, [c]))).message).toMatch(/cannot go down/);
      expect((await pgError(approver(`UPDATE "ApprovalCredential" SET label = 'x' WHERE "credentialId" = $1`, [c]))).message).toMatch(/permission denied/);
      await approver(`UPDATE "ApprovalCredential" SET "revokedAt" = now() WHERE "credentialId" = $1`, [c]);
      expect((await pgError(approver(`UPDATE "ApprovalCredential" SET "revokedAt" = NULL WHERE "credentialId" = $1`, [c]))).message).toMatch(/permanent/);
    });
  });

  describe('proposals', () => {
    it('APPROVED needs a matching approval, which it consumes', async () => {
      const p = await proposal();
      expect((await pgError(app(`UPDATE "Proposal" SET status = 'approved' WHERE id = $1`, [p]))).message).toMatch(/needs an approval/);
      const wrongDigest = await approval('proposal', p, { digest: HEX('b') });
      expect((await pgError(app(`UPDATE "Proposal" SET status = 'approved', "approvalId" = $2 WHERE id = $1`, [p, wrongDigest]))).message).toMatch(/no matching/);
      const wrongAction = await approval('proposal', p, { action: 'world.forget' });
      expect((await pgError(app(`UPDATE "Proposal" SET status = 'approved', "approvalId" = $2 WHERE id = $1`, [p, wrongAction]))).message).toMatch(/no matching/);
      const rejection = await approval('proposal', p, { decision: 'reject' });
      expect((await pgError(app(`UPDATE "Proposal" SET status = 'approved', "approvalId" = $2 WHERE id = $1`, [p, rejection]))).message).toMatch(/no matching/);
      const other = await approval('proposal', await proposal());
      expect((await pgError(app(`UPDATE "Proposal" SET status = 'approved', "approvalId" = $2 WHERE id = $1`, [p, other]))).message).toMatch(/no matching/);

      const good = await approval('proposal', p);
      await app(`UPDATE "Proposal" SET status = 'approved', "approvalId" = $2 WHERE id = $1`, [p, good]);
      const used = await owner(`SELECT "consumedAt" FROM "Approval" WHERE id = $1`, [good]);
      expect(used.rows[0].consumedAt).not.toBeNull();
    });

    it('an approval is used once: replaying it on a second proposal fails', async () => {
      const p1 = await proposal();
      const a = await approval('proposal', p1);
      await app(`UPDATE "Proposal" SET status = 'approved', "approvalId" = $2 WHERE id = $1`, [p1, a]);
      const p2 = await proposal();
      // Same subject is impossible (ids differ) and the approval is consumed: both checks refuse it.
      expect((await pgError(app(`UPDATE "Proposal" SET status = 'approved', "approvalId" = $2 WHERE id = $1`, [p2, a]))).message).toMatch(/no matching|unique/);
    });

    it('an expired approval does nothing', async () => {
      const p = await proposal();
      const a = await approval('proposal', p, { expiresIn: '1 second' });
      await new Promise((r) => setTimeout(r, 1100));
      expect((await pgError(app(`UPDATE "Proposal" SET status = 'approved', "approvalId" = $2 WHERE id = $1`, [p, a]))).message).toMatch(/no matching/);
    });

    it('walks pending -> approved -> executing -> executed, and nowhere else', async () => {
      const p = await proposal();
      expect((await pgError(app(`UPDATE "Proposal" SET status = 'executing' WHERE id = $1`, [p]))).message).toMatch(/not allowed/);
      await app(`UPDATE "Proposal" SET status = 'approved', "approvalId" = $2 WHERE id = $1`, [p, await approval('proposal', p)]);
      expect((await pgError(app(`UPDATE "Proposal" SET status = 'executed' WHERE id = $1`, [p]))).message).toMatch(/not allowed/);
      await app(`UPDATE "Proposal" SET status = 'executing' WHERE id = $1`, [p]);
      await app(`UPDATE "Proposal" SET status = 'executed', "executedAt" = now(), result = '{"ok":true}' WHERE id = $1`, [p]);
      expect((await pgError(app(`UPDATE "Proposal" SET status = 'pending' WHERE id = $1`, [p]))).message).toMatch(/not allowed/);
      expect((await pgError(app(`UPDATE "Proposal" SET result = '{"ok":false}' WHERE id = $1`, [p]))).message).toMatch(/set once/);
    });

    it('what was proposed never changes', async () => {
      const p = await proposal();
      expect((await pgError(app(`UPDATE "Proposal" SET args = '{"a":2}' WHERE id = $1`, [p]))).message).toMatch(/args never change/);
      expect((await pgError(app(`UPDATE "Proposal" SET action = 'world.forget' WHERE id = $1`, [p]))).message).toMatch(/cannot change/);
      expect((await pgError(app(`UPDATE "Proposal" SET "argsDigest" = $2 WHERE id = $1`, [p, HEX('d')]))).message).toMatch(/cannot change/);
      expect((await pgError(app(`UPDATE "Proposal" SET "expiresAt" = now() + interval '9 days' WHERE id = $1`, [p]))).message).toMatch(/cannot change/);
    });

    it('ids are never reused: no delete, no second insert', async () => {
      const p = await proposal();
      expect((await pgError(app(`DELETE FROM "Proposal" WHERE id = $1`, [p]))).message).toMatch(/permission denied/);
      expect((await pgError(owner(`DELETE FROM "Proposal" WHERE id = $1`, [p]))).message).toMatch(/never deleted/);
      expect((await pgError(owner(`TRUNCATE "Proposal" CASCADE`))).message).toMatch(/never deleted/);
      expect((await pgError(app(`INSERT INTO "Proposal" (id, kind, origin, action, args, "argsDigest", "argsProvenance", "expiresAt") VALUES ($1, 'tool_call', 'console', 'x', '{}', $2, '{}', now() + interval '1 hour')`, [p, DIGEST]))).code).toBe('23505');
    });

    it('a proposal starts pending and runtime proposals name their template', async () => {
      expect((await pgError(app(`INSERT INTO "Proposal" (id, kind, origin, action, args, "argsDigest", "argsProvenance", "expiresAt", status) VALUES ($1, 'tool_call', 'console', 'x', '{}', $2, '{}', now() + interval '1 hour', 'approved')`, [id(), DIGEST]))).message).toMatch(/starts pending/);
      expect((await pgError(app(`INSERT INTO "Proposal" (id, kind, origin, action, args, "argsDigest", "argsProvenance", "expiresAt") VALUES ($1, 'tool_call', 'runtime:triage', 'x', '{}', $2, '{}', now() + interval '1 hour')`, [id(), DIGEST]))).message).toMatch(/template/);
    });

    it('expires only once past expiresAt; retention clears args only when terminal', async () => {
      const p = await proposal({ expiresIn: '1 second' });
      expect((await pgError(app(`UPDATE "Proposal" SET args = NULL, "argsPurgedAt" = now() WHERE id = $1`, [p]))).message).toMatch(/args never change/);
      await new Promise((r) => setTimeout(r, 1100));
      await app(`UPDATE "Proposal" SET status = 'expired' WHERE id = $1`, [p]);
      await app(`UPDATE "Proposal" SET args = NULL, "argsPurgedAt" = now() WHERE id = $1`, [p]);
      const fresh = await proposal();
      expect((await pgError(app(`UPDATE "Proposal" SET status = 'expired' WHERE id = $1`, [fresh]))).message).toMatch(/not expired/);
    });

    it('a runtime refusal rejects without an approval; Will\'s signed rejection must match', async () => {
      const p = await proposal();
      await app(`UPDATE "Proposal" SET status = 'rejected', error = 'forbidden at execution' WHERE id = $1`, [p]);
      const q = await proposal();
      const approveNotReject = await approval('proposal', q);
      expect((await pgError(app(`UPDATE "Proposal" SET status = 'rejected', "approvalId" = $2 WHERE id = $1`, [q, approveNotReject]))).message).toMatch(/no matching/);
      await app(`UPDATE "Proposal" SET status = 'rejected', "approvalId" = $2 WHERE id = $1`, [q, await approval('proposal', q, { decision: 'reject' })]);
    });
  });

  describe('action policies', () => {
    /** A signed policy.change proposal listing rows, approved and being executed. */
    async function policyProposal(rows: unknown[]): Promise<{ proposalId: string; approvalId: string }> {
      const p = await proposal({ kind: 'policy', action: 'policy.change', args: { rows } });
      const a = await approval('proposal', p, { action: 'policy.change' });
      await app(`UPDATE "Proposal" SET status = 'approved', "approvalId" = $2 WHERE id = $1`, [p, a]);
      await app(`UPDATE "Proposal" SET status = 'executing' WHERE id = $1`, [p]);
      return { proposalId: p, approvalId: a };
    }
    const expires = new Date(Date.now() + 90 * 86400_000).toISOString();
    const insert = (approvalId: string, pattern: string, tier: string, cap: number | null) =>
      app(`INSERT INTO "ActionPolicy" (id, pattern, tier, "dailyCap", reason, "approvalId", "expiresAt") VALUES ($1, $2, $3, $4, 'promotion', $5, $6) RETURNING id`, [id(), pattern, tier, cap, approvalId, expires]);

    it('a row exists only if the signed proposal lists exactly it', async () => {
      const { approvalId } = await policyProposal([{ pattern: 'world.sync.git', tier: 'alone', dailyCap: 720, expiresAt: expires }]);
      expect((await pgError(insert(approvalId, 'world.sync.git', 'alone', 9999))).message).toMatch(/not in the signed proposal/);
      expect((await pgError(insert(approvalId, 'world.sync.*', 'alone', 720))).message).toMatch(/not in the signed proposal/);
      expect((await pgError(insert(approvalId, 'world.sync.git', 'forbidden', 720))).message).toMatch(/not in the signed proposal/);
      expect((await insert(approvalId, 'world.sync.git', 'alone', 720)).rowCount).toBe(1);
    });

    it('an approval for anything other than an executing policy change creates nothing', async () => {
      const p = await proposal();
      const a = await approval('proposal', p);
      await app(`UPDATE "Proposal" SET status = 'approved', "approvalId" = $2 WHERE id = $1`, [p, a]);
      expect((await pgError(insert(a, 'world.sync.git', 'alone', null))).message).toMatch(/not an approved policy change/);
    });

    it('can only be switched off, and every change is in RowChange', async () => {
      const { approvalId } = await policyProposal([{ pattern: 'world.sync.health', tier: 'alone', expiresAt: expires }]);
      const rid = (await insert(approvalId, 'world.sync.health', 'alone', null)).rows[0].id as string;
      expect((await pgError(app(`UPDATE "ActionPolicy" SET tier = 'forbidden' WHERE id = $1`, [rid]))).message).toMatch(/permission denied/);
      expect((await pgError(owner(`UPDATE "ActionPolicy" SET tier = 'alone', "dailyCap" = 1 WHERE id = $1`, [rid]))).message).toMatch(/switched off/);
      await withClient(URLS!.app, async (c) => {
        await c.query('BEGIN');
        await c.query(`SELECT set_config('flint.actor', 'will:console', true)`);
        await c.query(`UPDATE "ActionPolicy" SET active = false WHERE id = $1`, [rid]);
        await c.query('COMMIT');
      });
      expect((await pgError(app(`UPDATE "ActionPolicy" SET active = true WHERE id = $1`, [rid]))).message).toMatch(/switched off/);
      const h = await app(`SELECT actor, changed FROM "RowChange" WHERE "rowId" = $1`, [rid]);
      expect(h.rows).toEqual([{ actor: 'will:console', changed: { active: [true, false] } }]);
      expect((await pgError(app(`INSERT INTO "RowChange" (id, "tableName", "rowId", actor, changed) VALUES ('x', 'ActionPolicy', $1, 'me', '{}')`, [rid]))).message).toMatch(/permission denied/);
      expect((await pgError(owner(`UPDATE "RowChange" SET actor = 'someone' WHERE "rowId" = $1`, [rid]))).message).toMatch(/append-only/);
    });
  });

  describe('audit', () => {
    it('is append-only for every role', async () => {
      const aid = id('au');
      await app(`INSERT INTO "AuditEntry" (id, actor, context, kind, action, inputs, outcome) VALUES ($1, 'flint', 'autonomous', 'action', 'world.sync.git', '{"n":1}', 'ok')`, [aid]);
      expect((await pgError(app(`UPDATE "AuditEntry" SET outcome = 'failed' WHERE id = $1`, [aid]))).message).toMatch(/permission denied/);
      expect((await pgError(app(`DELETE FROM "AuditEntry" WHERE id = $1`, [aid]))).message).toMatch(/permission denied/);
      expect((await pgError(owner(`UPDATE "AuditEntry" SET outcome = 'failed' WHERE id = $1`, [aid]))).message).toMatch(/append-only/);
      expect((await pgError(owner(`DELETE FROM "AuditEntry" WHERE id = $1`, [aid]))).message).toMatch(/append-only/);
      expect((await pgError(owner(`TRUNCATE "AuditEntry"`))).message).toMatch(/append-only/);
    });

    it('even the redactable columns change only inside a forget', async () => {
      const aid = id('au');
      await app(`INSERT INTO "AuditEntry" (id, actor, context, kind, action, inputs, reasoning, outcome) VALUES ($1, 'flint', 'chat', 'action', 'x', '{}', 'why', 'ok')`, [aid]);
      expect((await pgError(owner(`UPDATE "AuditEntry" SET reasoning = NULL WHERE id = $1`, [aid]))).message).toMatch(/append-only/);
    });

    it('lands in this month\'s partition, in flint_part', async () => {
      const aid = id('au');
      await app(`INSERT INTO "AuditEntry" (id, actor, context, kind, action, inputs, outcome) VALUES ($1, 'flint', 'chat', 'action', 'calculate', '{}', 'ok')`, [aid]);
      const r = await owner(`SELECT tableoid::regclass::text AS part FROM "AuditEntry" WHERE id = $1`, [aid]);
      expect(r.rows[0].part).toMatch(/^flint_part\."AuditEntry_\d{4}_\d{2}"$/);
      expect((await pgError(app(`SELECT * FROM flint_part."AuditEntry_default"`))).message).toMatch(/permission denied/);
    });

    it('caps its inputs and refuses unknown kinds', async () => {
      expect((await pgError(app(`INSERT INTO "AuditEntry" (id, actor, context, kind, action, inputs, outcome) VALUES ($1, 'f', 'chat', 'gossip', 'x', '{}', 'ok')`, [id()]))).message).toMatch(/kind_check/);
      const big = JSON.stringify({ blob: 'x'.repeat(17000) });
      expect((await pgError(app(`INSERT INTO "AuditEntry" (id, actor, context, kind, action, inputs, outcome) VALUES ($1, 'f', 'chat', 'action', 'x', $2, 'ok')`, [id(), big]))).message).toMatch(/inputs_check/);
    });

    it('an intent with no outcome after an hour shows in audit_open_intents', async () => {
      const corr = id('corr');
      // Backdated straight into the table as the owner would never do; the trigger allows inserts.
      await owner(`INSERT INTO "AuditEntry" (id, at, actor, context, kind, action, inputs, outcome, "correlationId") VALUES ($1, now() - interval '2 hours', 'flint', 'chat', 'intent', 'gcal.create_event', '{}', 'pending', $2)`, [id(), corr]);
      expect((await app(`SELECT 1 FROM audit_open_intents WHERE "correlationId" = $1`, [corr])).rowCount).toBe(1);
      await app(`INSERT INTO "AuditEntry" (id, actor, context, kind, action, inputs, outcome, "correlationId") VALUES ($1, 'flint', 'chat', 'action', 'gcal.create_event', '{}', 'ok', $2)`, [id(), corr]);
      expect((await app(`SELECT 1 FROM audit_open_intents WHERE "correlationId" = $1`, [corr])).rowCount).toBe(0);
    });

    it('a partition is dropped only with approval, and never a recent one', async () => {
      const recent = (await owner(`SELECT to_char(now(), 'YYYY-MM') AS m`)).rows[0].m as string;
      expect((await pgError(app(`SELECT drop_audit_partition($1, 'nope')`, [recent]))).message).toMatch(/kept for 24 months/);
      expect((await pgError(app(`SELECT drop_audit_partition('2020-01', 'nope')`))).message).toMatch(/no matching/);
      // A real, attached partition with a row in it.
      await owner(`CREATE TABLE flint_part."AuditEntry_2020_01" PARTITION OF "AuditEntry" FOR VALUES FROM ('2020-01-01T00:00:00Z') TO ('2020-02-01T00:00:00Z')`);
      await owner(`INSERT INTO "AuditEntry" (id, at, actor, context, kind, action, inputs, outcome) VALUES ($1, '2020-01-15T00:00:00Z', 'x', 'chat', 'action', 'old', '{}', 'ok')`, [id('au')]);
      const a = await approval('partition_drop', '2020-01', { action: 'maintenance.partition_drop' });
      await app(`SELECT drop_audit_partition('2020-01', $1)`, [a]);
      expect((await owner(`SELECT to_regclass('flint_part."AuditEntry_2020_01"') AS t`)).rows[0].t).toBeNull();
      expect((await owner(`SELECT count(*)::int AS n FROM "AuditEntry" WHERE action = 'old'`)).rows[0].n).toBe(0);
      expect((await pgError(app(`SELECT drop_audit_partition('2020-01', $1)`, [a]))).message).toMatch(/no matching/);
    });

    it('a TEMP table cannot stand in for a governance table (search_path is pinned; flint_app has no TEMP)', async () => {
      expect((await pgError(app(`CREATE TEMP TABLE "Approval" (LIKE public."Approval")`))).message).toMatch(/permission denied/);
      // The owner can make temp tables; the guards still read the real ones.
      const p = await proposal();
      await withClient(URLS!.owner, async (c) => {
        await c.query('BEGIN');
        await c.query('SET LOCAL search_path = pg_temp, public');
        await c.query(`CREATE TEMP TABLE "ApprovalCredential" (LIKE public."ApprovalCredential") ON COMMIT DROP`);
        await c.query(`CREATE TEMP TABLE "Approval" (LIKE public."Approval") ON COMMIT DROP`);
        await c.query(`INSERT INTO pg_temp."ApprovalCredential" (id, "credentialId", factor, "publicKey", label, "enrolledVia", "createdAt", "signCount") VALUES ('f', 'fakecred', 'webauthn', '\\x00', 'fake', 'x', now(), 0)`);
        await c.query(`INSERT INTO pg_temp."Approval" (id, "subjectType", "subjectId", decision, payload, challenge, "credentialId", signature, "expiresAt", "createdAt") VALUES ('forged', 'proposal', $1, 'approve', $2, $3, 'fakecred', '\\x01', now() + interval '5 minutes', now())`, [
          p, JSON.stringify({ argsDigest: DIGEST, action: 'world.sync.github' }), HEX('c'),
        ]);
        const err = await c.query(`UPDATE public."Proposal" SET status = 'approved', "approvalId" = 'forged' WHERE id = $1`, [p]).then(() => null, (e: Error) => e.message);
        await c.query('ROLLBACK');
        expect(err).toMatch(/no matching/);
      });
    });
  });

  describe('caps', () => {
    it('100 concurrent claims against a cap of 5 succeed exactly 5 times', async () => {
      const pool = new pg.Pool({ ...pgConfig(URLS!.app), max: 20 });
      try {
        const action = id('cap');
        const results = await Promise.all(
          Array.from({ length: 100 }, () => pool.query(`SELECT claim_action($1, '2026-10-01', 5) AS n`, [action]).then((r) => r.rows[0].n as number | null)),
        );
        expect(results.filter((n) => n !== null).sort((a, b) => a! - b!)).toEqual([1, 2, 3, 4, 5]);
        const zero = await pool.query(`SELECT claim_action($1, '2026-10-01', 0) AS n`, [id('cap')]);
        expect(zero.rows[0].n).toBeNull();
      } finally {
        await pool.end();
      }
    });
  });
});
