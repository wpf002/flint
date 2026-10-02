/**
 * The server's only database access: as flint_approver, which may read and add
 * approvals and credentials and bump a credential's counter, nothing else (the
 * grants in apps/runtime/prisma make sure of it). Parameterized queries only.
 */
import pg from 'pg';
import type { ApproverStore, Credential, NewApproval } from './approvals';

/** pg config from a URL; pg's own parser keeps an IPv6 host's brackets. */
function config(url: string): pg.PoolConfig {
  const u = new URL(url);
  return {
    host: u.hostname.replace(/^\[|\]$/g, ''),
    port: u.port ? Number(u.port) : 5432,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: decodeURIComponent(u.pathname.slice(1)),
    max: 2,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  };
}

export function pgApproverStore(url: string, log: (m: string) => void = () => {}): ApproverStore & { close(): Promise<void> } {
  const pool = new pg.Pool(config(url));
  // An idle client's connection dropping (Postgres restarting) is an 'error'
  // event; unhandled, it would take the whole chat server down.
  pool.on('error', (err) => log(`[approvals] database connection lost: ${err.message}`));
  return {
    async credentials() {
      const r = await pool.query<{ credentialId: string; factor: Credential['factor']; publicKey: Buffer; label: string; signCount: number; revokedAt: Date | null }>(
        'SELECT "credentialId", factor, "publicKey", label, "signCount", "revokedAt" FROM "ApprovalCredential" ORDER BY "createdAt"',
      );
      return r.rows;
    },
    async addCredential(c) {
      await pool.query(
        'INSERT INTO "ApprovalCredential" (id, "credentialId", factor, "publicKey", label, "signCount", "enrolledVia") VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [`ac${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`, c.credentialId, c.factor, c.publicKey, c.label, c.signCount, c.enrolledVia],
      );
    },
    async addApproval(a: NewApproval) {
      await pool.query(
        `INSERT INTO "Approval" (id, "subjectType", "subjectId", decision, payload, challenge, "credentialId", "authenticatorData", "clientDataJson", signature, "expiresAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [a.id, a.payload.subjectType, a.payload.subjectId, a.payload.decision, JSON.stringify(a.payload), a.challengeHex, a.credentialId, a.authenticatorData ?? null, a.clientDataJson ?? null, a.signature, a.expiresAt],
      );
    },
    async setSignCount(credentialId, n) {
      await pool.query('UPDATE "ApprovalCredential" SET "signCount" = $2 WHERE "credentialId" = $1 AND "signCount" < $2', [credentialId, n]);
    },
    async revoke(credentialId) {
      await pool.query('UPDATE "ApprovalCredential" SET "revokedAt" = now() WHERE "credentialId" = $1 AND "revokedAt" IS NULL', [credentialId]);
    },
    async replace(add, revoke) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        if (add) {
          await client.query(
            'INSERT INTO "ApprovalCredential" (id, "credentialId", factor, "publicKey", label, "signCount", "enrolledVia") VALUES ($1, $2, $3, $4, $5, $6, $7)',
            [`ac${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`, add.credentialId, add.factor, add.publicKey, add.label, add.signCount, add.enrolledVia],
          );
        }
        for (const id of revoke) await client.query('UPDATE "ApprovalCredential" SET "revokedAt" = now() WHERE "credentialId" = $1 AND "revokedAt" IS NULL', [id]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}
