/**
 * Re-verifying Will's approval before anything executes (plan 3.0.2: the server
 * verifies, the runtime verifies again). The database already guarantees the
 * approval is for this subject, unused and unexpired when it is consumed; this
 * checks the SIGNATURE, which the database cannot: a row inserted any way other
 * than through a real signature does nothing.
 */
import {
  ApprovalPayload,
  challengeOf,
  verifySecureEnclave,
  verifyWebAuthnAssertion,
  type WebAuthnRelyingParty,
} from '@flint/policy';
import type { Db, Tx } from '../db.js';

export type Reverified = { ok: true; payload: ApprovalPayload } | { ok: false; reason: string };

export async function reverifyApproval(db: Db | Tx, approvalId: string, rp: WebAuthnRelyingParty | undefined): Promise<Reverified> {
  const a = await db.approval.findUnique({ where: { id: approvalId }, include: { credential: true } });
  if (!a) return { ok: false, reason: 'no such approval' };
  if (a.credential.revokedAt) return { ok: false, reason: 'the credential was revoked' };
  const parsed = ApprovalPayload.safeParse(a.payload);
  if (!parsed.success) return { ok: false, reason: 'the stored payload is not a valid approval payload' };
  const challenge = challengeOf(parsed.data);
  if (challenge.toString('hex') !== a.challenge) return { ok: false, reason: 'the stored challenge does not match the payload' };
  if (a.subjectType !== parsed.data.subjectType || a.subjectId !== parsed.data.subjectId || a.decision !== parsed.data.decision) {
    return { ok: false, reason: 'the row does not match what was signed' };
  }
  const key = a.credential.publicKey;
  if (a.credential.factor === 'secure_enclave') {
    const v = verifySecureEnclave({ publicKeySpki: key, challenge, signature: a.signature });
    return v.ok ? { ok: true, payload: parsed.data } : { ok: false, reason: v.reason };
  }
  if (!rp) return { ok: false, reason: 'passkey approvals need FLINT_RP_ID and FLINT_RP_ORIGINS' };
  if (!a.authenticatorData || !a.clientDataJson) return { ok: false, reason: 'a passkey approval is missing its assertion' };
  const v = verifyWebAuthnAssertion({
    publicKeySpki: key,
    challenge,
    authenticatorData: a.authenticatorData,
    clientDataJson: a.clientDataJson,
    signature: a.signature,
    rp,
  });
  return v.ok ? { ok: true, payload: parsed.data } : { ok: false, reason: v.reason };
}
