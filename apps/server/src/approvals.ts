/**
 * Will's approval factor on the server side (Machine plan 3.0.2).
 *
 * The console token is enough to see and propose; it is NOT enough to approve
 * once proposals live in the runtime. An approval is a signature by a key that
 * never exists inside any Flint process: a passkey (WebAuthn, on the tailnet
 * HTTPS origin) or the desktop app's Secure Enclave key behind Touch ID. Both
 * sign sha256(canonical(payload)), where the payload names the exact action,
 * the digest of its exact args, an expiry and a nonce.
 *
 *   enroll: a one-time code from ~/.flint/enroll-code (written by
 *           `pnpm --filter @flint/runtime enroll`) registers the first
 *           credential; any further one also needs an existing credential's
 *           approval.
 *   approve: begin() builds the payload and a challenge; finish() verifies the
 *           signature and records the Approval as flint_approver, the only role
 *           that can. The runtime verifies again before anything executes.
 *
 * Challenges live five minutes and are used once.
 */
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import {
  ApprovalPayload,
  challengeOf,
  p256Key,
  verifySecureEnclave,
  verifyWebAuthnAssertion,
  verifyWebAuthnRegistration,
  type SubjectType,
  type WebAuthnRelyingParty,
} from '@flint/policy';

export interface Credential {
  credentialId: string;
  factor: 'webauthn' | 'secure_enclave';
  publicKey: Buffer;
  label: string;
  signCount: number;
  revokedAt: Date | null;
}

export interface NewApproval {
  id: string;
  payload: ApprovalPayload;
  challengeHex: string;
  credentialId: string;
  authenticatorData?: Buffer;
  clientDataJson?: Buffer;
  signature: Buffer;
  expiresAt: Date;
}

/** What flint_approver may do: read and add credentials and approvals, bump a counter. */
export interface ApproverStore {
  credentials(): Promise<Credential[]>;
  addCredential(c: Omit<Credential, 'revokedAt' | 'signCount'> & { signCount: number; enrolledVia: string }): Promise<void>;
  addApproval(a: NewApproval): Promise<void>;
  setSignCount(credentialId: string, n: number): Promise<void>;
}

export class ApprovalError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

type Pending =
  | { kind: 'enroll'; challenge: Buffer; label: string; expires: number; viaCode: boolean }
  | { kind: 'approve'; challenge: Buffer; payload: ApprovalPayload; expires: number };

const b64url = (b: Buffer) => b.toString('base64url');
const fromB64 = (s: unknown, what: string): Buffer => {
  if (typeof s !== 'string' || s.length > 8192 || !/^[A-Za-z0-9_-]*={0,2}$/.test(s)) throw new ApprovalError(400, `${what} must be base64url`);
  return Buffer.from(s, 'base64url');
};
/**
 * authData out of a WebAuthn attestationObject (CBOR `{fmt, attStmt, authData}`),
 * for browsers without getAuthenticatorData(). Finds the "authData" key and
 * reads the byte string after it; anything else is refused.
 */
export function authDataFromAttestation(att: Buffer): Buffer {
  const key = Buffer.from([0x68, ...Buffer.from('authData')]);
  const i = att.indexOf(key);
  if (i < 0) throw new ApprovalError(400, 'attestationObject has no authData');
  let j = i + key.length;
  const head = att[j++];
  if (head === undefined || head >> 5 !== 2) throw new ApprovalError(400, 'authData is not a byte string');
  let len = head & 0x1f;
  if (len === 24) len = att[j++] ?? -1;
  else if (len === 25) {
    len = att.readUInt16BE(j);
    j += 2;
  } else if (len > 23) throw new ApprovalError(400, 'authData length is unsupported');
  if (len < 37 || j + len > att.length) throw new ApprovalError(400, 'authData is truncated');
  return att.subarray(j, j + len);
}

const same = (a: string, b: string) => {
  const x = createHash('sha256').update(a).digest();
  const y = createHash('sha256').update(b).digest();
  return timingSafeEqual(x, y);
};

export interface ApprovalsOptions {
  store: ApproverStore;
  rp?: WebAuthnRelyingParty;
  enrollCodeFile: string;
  now?: () => Date;
  ttlMs?: number;
}

export class Approvals {
  private readonly pending = new Map<string, Pending>();
  private readonly ttl: number;

  constructor(private readonly o: ApprovalsOptions) {
    this.ttl = o.ttlMs ?? 5 * 60_000;
  }

  private now(): Date {
    return this.o.now?.() ?? new Date();
  }

  private put(p: Pending): string {
    const id = randomBytes(16).toString('hex');
    // Expired challenges go; at most 100 outstanding.
    const t = this.now().getTime();
    for (const [k, v] of this.pending) if (v.expires <= t) this.pending.delete(k);
    if (this.pending.size >= 100) throw new ApprovalError(409, 'too many approvals in flight');
    this.pending.set(id, p);
    return id;
  }

  private take(id: unknown, kind: Pending['kind']): Pending {
    if (typeof id !== 'string') throw new ApprovalError(400, 'challengeId required');
    const p = this.pending.get(id);
    this.pending.delete(id); // used once, success or not
    if (!p || p.kind !== kind) throw new ApprovalError(404, 'no such challenge');
    if (p.expires <= this.now().getTime()) throw new ApprovalError(409, 'the challenge expired');
    return p;
  }

  private enrollCode(): string | undefined {
    if (!existsSync(this.o.enrollCodeFile)) return undefined;
    const c = readFileSync(this.o.enrollCodeFile, 'utf8').trim();
    return /^[A-Za-z0-9-]{12,64}$/.test(c) ? c : undefined;
  }

  /** Who may approve right now (for the console: which credentials to offer). */
  async credentials(): Promise<Array<Pick<Credential, 'credentialId' | 'factor' | 'label'>>> {
    return (await this.o.store.credentials()).filter((c) => !c.revokedAt).map(({ credentialId, factor, label }) => ({ credentialId, factor, label }));
  }

  /**
   * Start enrolling a credential. The first needs the one-time code; later ones
   * need the code too, and finishEnroll() also wants an existing credential's
   * signature over the new key.
   */
  async beginEnroll(body: { code?: unknown; label?: unknown }): Promise<{ challengeId: string; challenge: string; rp?: { id: string }; user: { id: string; name: string } }> {
    const label = typeof body.label === 'string' ? body.label.trim().slice(0, 100) : '';
    if (!label) throw new ApprovalError(400, 'label required');
    const code = this.enrollCode();
    if (!code || typeof body.code !== 'string' || !same(body.code.trim(), code)) {
      throw new ApprovalError(403, 'the enrolment code is missing or wrong (run: pnpm --filter @flint/runtime enroll)');
    }
    const existing = (await this.o.store.credentials()).filter((c) => !c.revokedAt);
    const challenge = randomBytes(32);
    const challengeId = this.put({ kind: 'enroll', challenge, label, expires: this.now().getTime() + this.ttl, viaCode: existing.length === 0 });
    return {
      challengeId,
      challenge: b64url(challenge),
      ...(this.o.rp ? { rp: { id: this.o.rp.rpId } } : {}),
      user: { id: b64url(createHash('sha256').update('will').digest().subarray(0, 16)), name: 'will' },
    };
  }

  /**
   * Finish enrolling: a passkey registration (attestation "none"), or a Secure
   * Enclave public key with a signature over the challenge (proof it holds the
   * key). The code is spent on success.
   */
  async finishEnroll(body: Record<string, unknown>): Promise<{ credentialId: string }> {
    const p = this.take(body.challengeId, 'enroll') as Extract<Pending, { kind: 'enroll' }>;
    let credentialId: string;
    let publicKey: Buffer;
    let signCount = 0;
    let factor: Credential['factor'];
    if (body.factor === 'secure_enclave') {
      factor = 'secure_enclave';
      publicKey = fromB64(body.publicKey, 'publicKey');
      if (!p256Key(publicKey)) throw new ApprovalError(400, 'not a P-256 public key');
      const v = verifySecureEnclave({ publicKeySpki: publicKey, challenge: p.challenge, signature: fromB64(body.signature, 'signature') });
      if (!v.ok) throw new ApprovalError(403, `the key did not sign the challenge: ${v.reason}`);
      credentialId = `se_${createHash('sha256').update(publicKey).digest('hex').slice(0, 32)}`;
    } else {
      factor = 'webauthn';
      if (!this.o.rp) throw new ApprovalError(409, 'passkeys need FLINT_RP_ID and FLINT_RP_ORIGINS (the tailnet HTTPS origin)');
      const r = verifyWebAuthnRegistration({
        challenge: p.challenge,
        authenticatorData: body.authenticatorData !== undefined ? fromB64(body.authenticatorData, 'authenticatorData') : authDataFromAttestation(fromB64(body.attestationObject, 'attestationObject')),
        clientDataJson: fromB64(body.clientDataJSON, 'clientDataJSON'),
        rp: this.o.rp,
      });
      if (!r.ok) throw new ApprovalError(403, `the passkey registration did not verify: ${r.reason}`);
      credentialId = r.credentialId;
      publicKey = r.publicKeySpki;
      signCount = r.signCount;
    }
    if (!p.viaCode) {
      // A second credential: an existing one must have approved this exact key.
      const approvalId = await this.verifyApprovalOf({ subjectType: 'credential', subjectId: credentialId, action: 'approval.enroll' }, body.approval);
      await this.o.store.addCredential({ credentialId, factor, publicKey, label: p.label, signCount, enrolledVia: `approval:${approvalId}` });
    } else {
      await this.o.store.addCredential({ credentialId, factor, publicKey, label: p.label, signCount, enrolledVia: 'enroll_code' });
    }
    rmSync(this.o.enrollCodeFile, { force: true });
    return { credentialId };
  }

  /** Start an approval: the payload Will will see and sign, and its challenge. */
  begin(subject: { subjectType: SubjectType; subjectId: string; decision: 'approve' | 'reject'; action: string; argsDigest: string; fields?: Record<string, string | number | boolean | null> }) {
    const expiresAt = new Date(this.now().getTime() + this.ttl).toISOString();
    const parsed = ApprovalPayload.safeParse({ v: 1, ...subject, expiresAt, nonce: randomBytes(16).toString('hex') });
    if (!parsed.success) throw new ApprovalError(400, `cannot approve that: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`);
    const challenge = challengeOf(parsed.data);
    const challengeId = this.put({ kind: 'approve', challenge, payload: parsed.data, expires: Date.parse(expiresAt) });
    return { challengeId, payload: parsed.data, challenge: b64url(challenge) };
  }

  /** Verify Will's signature over a begun approval and record it. Returns the Approval id. */
  async finish(body: Record<string, unknown>): Promise<{ approvalId: string; payload: ApprovalPayload }> {
    const p = this.take(body.challengeId, 'approve') as Extract<Pending, { kind: 'approve' }>;
    const approvalId = await this.verifyAndRecord(p.payload, p.challenge, body);
    return { approvalId, payload: p.payload };
  }

  private async verifyApprovalOf(expected: { subjectType: SubjectType; subjectId: string; action: string }, raw: unknown): Promise<string> {
    if (!raw || typeof raw !== 'object') throw new ApprovalError(403, 'a further credential needs an existing credential\'s approval');
    const a = raw as Record<string, unknown>;
    const p = this.take(a.challengeId, 'approve') as Extract<Pending, { kind: 'approve' }>;
    if (p.payload.subjectType !== expected.subjectType || p.payload.subjectId !== expected.subjectId || p.payload.action !== expected.action || p.payload.decision !== 'approve') {
      throw new ApprovalError(403, 'that approval was for something else');
    }
    return this.verifyAndRecord(p.payload, p.challenge, a);
  }

  private async verifyAndRecord(payload: ApprovalPayload, challenge: Buffer, body: Record<string, unknown>): Promise<string> {
    const credentialId = typeof body.credentialId === 'string' ? body.credentialId : '';
    const cred = (await this.o.store.credentials()).find((c) => c.credentialId === credentialId);
    if (!cred || cred.revokedAt) throw new ApprovalError(403, 'unknown or revoked credential');
    const signature = fromB64(body.signature, 'signature');
    let authenticatorData: Buffer | undefined;
    let clientDataJson: Buffer | undefined;
    if (cred.factor === 'secure_enclave') {
      const v = verifySecureEnclave({ publicKeySpki: cred.publicKey, challenge, signature });
      if (!v.ok) throw new ApprovalError(403, `the signature did not verify: ${v.reason}`);
    } else {
      if (!this.o.rp) throw new ApprovalError(409, 'passkeys need FLINT_RP_ID and FLINT_RP_ORIGINS');
      authenticatorData = fromB64(body.authenticatorData, 'authenticatorData');
      clientDataJson = fromB64(body.clientDataJSON, 'clientDataJSON');
      const v = verifyWebAuthnAssertion({ publicKeySpki: cred.publicKey, challenge, authenticatorData, clientDataJson, signature, storedSignCount: cred.signCount, rp: this.o.rp });
      if (!v.ok) throw new ApprovalError(403, `the passkey did not verify: ${v.reason}`);
      if (v.signCount !== undefined && v.signCount > cred.signCount) await this.o.store.setSignCount(cred.credentialId, v.signCount);
    }
    const id = `ap${Date.now().toString(36)}${randomBytes(6).toString('hex')}`;
    await this.o.store.addApproval({
      id, payload, challengeHex: challenge.toString('hex'), credentialId, signature, expiresAt: new Date(payload.expiresAt),
      ...(authenticatorData ? { authenticatorData } : {}), ...(clientDataJson ? { clientDataJson } : {}),
    });
    return id;
  }
}
