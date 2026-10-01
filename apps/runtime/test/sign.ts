/** Will's side of an approval, for tests: a P-256 key, a signed payload, the row flint_approver records. */
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { challengeOf, type ApprovalPayload } from '@flint/policy';
import { withClient, type TestUrls } from './db';

export async function enrollTestKey(urls: TestUrls) {
  const key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const credentialId = `cred${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  await withClient(urls.approver, (c) =>
    c.query(`INSERT INTO "ApprovalCredential" (id, "credentialId", factor, "publicKey", label, "enrolledVia") VALUES ($1, $2, 'secure_enclave', $3, 'test key', 'enroll_code')`, [
      `c${credentialId}`, credentialId, key.publicKey.export({ format: 'der', type: 'spki' }),
    ]),
  );
  return {
    async approve(o: { subjectType?: ApprovalPayload['subjectType']; subjectId: string; action: string; argsDigest: string; decision?: 'approve' | 'reject' }) {
      const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
      const payload: ApprovalPayload = {
        v: 1, subjectType: o.subjectType ?? 'proposal', subjectId: o.subjectId, decision: o.decision ?? 'approve', action: o.action, argsDigest: o.argsDigest, expiresAt,
        nonce: createHash('sha256').update(String(Math.random())).digest('hex').slice(0, 32),
      };
      const challenge = challengeOf(payload);
      const id = `ap${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      await withClient(urls.approver, (c) =>
        c.query(`INSERT INTO "Approval" (id, "subjectType", "subjectId", decision, payload, challenge, "credentialId", signature, "expiresAt") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`, [
          id, payload.subjectType, payload.subjectId, payload.decision, JSON.stringify(payload), challenge.toString('hex'), credentialId, sign('sha256', challenge, key.privateKey), expiresAt,
        ]),
      );
      return id;
    },
  };
}
