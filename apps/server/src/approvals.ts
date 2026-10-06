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
 *           `pnpm --filter @flint/runtime enroll`) starts every enrolment. It
 *           registers a credential on its own only while none is enrolled
 *           (decided when the enrolment finishes); any further one needs an
 *           existing credential's signature over exactly the new key.
 *           `enroll --replace` writes a code that revokes every enrolled
 *           credential and registers the new one: the recovery when the only
 *           key is lost (the Mac is wiped or replaced). Whoever
 *           can write ~/.flint is Will (plan 3.0.2's boundary).
 *   approve: begin() builds the payload and a challenge; finish() verifies the
 *           signature and records the Approval as flint_approver, the only role
 *           that can. The runtime verifies again before anything executes.
 *
 * Challenges live five minutes and are used once.
 */
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  ApprovalPayload,
  challengeOf,
  p256Key,
  refusalFix,
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
  revoke(credentialId: string): Promise<void>;
  /** In one transaction: add `add` (when given) and revoke `revoke`; all or nothing. */
  replace(add: (Omit<Credential, 'revokedAt' | 'signCount'> & { signCount: number; enrolledVia: string }) | undefined, revoke: readonly string[]): Promise<void>;
}

export class ApprovalError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409,
    message: string,
    /** Why, in the verifier's own words: logged with a ref (approval-routes), never sent. The message is what Will reads. */
    readonly why?: string,
  ) {
    super(message);
  }
}

/** Passkeys need a relying party: the tailnet HTTPS origin (FLINT_RP_ORIGINS, or ~/.flint/tailscale-url.txt). */
export const NO_PASSKEYS = 'Passkeys aren’t set up on this server. Set FLINT_RP_ORIGINS to its tailnet address, then restart it.';

type Pending =
  | { kind: 'enroll'; challenge: Buffer; label: string; expires: number; codeHash: string }
  | { kind: 'approve'; challenge: Buffer; payload: ApprovalPayload; expires: number };

/** What an enrolment registers: the key Will's approval must name. */
interface Registered {
  credentialId: string;
  factor: Credential['factor'];
  publicKey: Buffer;
  signCount: number;
}

/** The args digest an approval of a new credential signs: the new key itself. */
export const keyDigest = (publicKey: Buffer) => createHash('sha256').update(publicKey).digest('hex');
/** The subject an approval of a new credential names: a fixed-length reference (credential ids run to 1023 bytes). */
export const credentialRef = (credentialId: string) => createHash('sha256').update(credentialId).digest('hex');

export interface EnrolEvent {
  credentialId: string;
  factor: Credential['factor'];
  via: 'enroll_code' | 'enroll_code_replace' | 'approval';
  approvalId?: string;
  revoked: string[];
}

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
  /** Every credential enrolled (and any revoked with it), for the audit trail. */
  onEnrolled?: (e: EnrolEvent) => void;
}

export class Approvals {
  private readonly pending = new Map<string, Pending>();
  private readonly ttl: number;
  /** Enrolments finish one at a time: "is any key enrolled yet?" and the insert must not interleave. */
  private enrolling: Promise<unknown> = Promise.resolve();
  /** New keys an existing one has signed for (approval challenge id -> the recorded approval), until the new device finishes. */
  private readonly enrolApprovals = new Map<string, { approvalId: string; payload: ApprovalPayload; expires: number }>();

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
    if (this.pending.size >= 100) throw new ApprovalError(409, 'Too many approvals are in progress. Try again shortly.');
    this.pending.set(id, p);
    return id;
  }

  private take(id: unknown, kind: Pending['kind']): Pending {
    if (typeof id !== 'string') throw new ApprovalError(400, 'challengeId required');
    const p = this.pending.get(id);
    this.pending.delete(id); // used once, success or not
    if (!p || p.kind !== kind) throw new ApprovalError(404, 'no such challenge');
    if (p.expires <= this.now().getTime()) throw new ApprovalError(409, 'The request expired. Try again.');
    return p;
  }

  /** The code in ~/.flint/enroll-code, and whether it is a replace code. */
  private enrollCode(): { code: string; replace: boolean } | undefined {
    if (!existsSync(this.o.enrollCodeFile)) return undefined;
    const [code = '', mode = ''] = readFileSync(this.o.enrollCodeFile, 'utf8').trim().split(/\s+/);
    if (!/^[A-Za-z0-9-]{12,64}$/.test(code)) return undefined;
    return { code, replace: mode === 'replace' };
  }

  private static hashOf(code: string): string {
    return createHash('sha256').update(code).digest('hex');
  }

  /** Who may approve right now (for the console: which credentials to offer). */
  async credentials(): Promise<Array<Pick<Credential, 'credentialId' | 'factor' | 'label'>>> {
    return (await this.o.store.credentials()).filter((c) => !c.revokedAt).map(({ credentialId, factor, label }) => ({ credentialId, factor, label }));
  }

  /** Has Will enrolled any key? Then the console token alone approves nothing. */
  async hasCredentials(): Promise<boolean> {
    return (await this.o.store.credentials()).some((c) => !c.revokedAt);
  }

  /**
   * Start enrolling a credential. Every enrolment needs the one-time code; once
   * a key is enrolled, finishEnroll() also wants an existing credential's
   * signature over the new key (beginEnrollApproval).
   */
  async beginEnroll(body: { code?: unknown; label?: unknown }): Promise<{ challengeId: string; challenge: string; rp?: { id: string }; user: { id: string; name: string }; needsApproval: boolean }> {
    const label = typeof body.label === 'string' ? body.label.trim().slice(0, 100) : '';
    if (!label) throw new ApprovalError(400, 'label required');
    const code = this.enrollCode();
    if (!code || typeof body.code !== 'string' || !same(body.code.trim(), code.code)) {
      throw new ApprovalError(403, 'That code is wrong or missing. Get a new one with pnpm --filter @flint/runtime enroll.');
    }
    const challenge = randomBytes(32);
    const challengeId = this.put({ kind: 'enroll', challenge, label, expires: this.now().getTime() + this.ttl, codeHash: Approvals.hashOf(code.code) });
    // A replace code, or no key yet: the code is enough. Otherwise an existing key must sign for the new one.
    const needsApproval = !code.replace && (await this.hasCredentials());
    return {
      needsApproval,
      challengeId,
      challenge: b64url(challenge),
      ...(this.o.rp ? { rp: { id: this.o.rp.rpId } } : {}),
      user: { id: b64url(createHash('sha256').update('will').digest().subarray(0, 16)), name: 'will' },
    };
  }

  /** The key an enrolment registers: a passkey registration (attestation "none"), or a Secure Enclave key that signed the challenge. */
  private registered(p: Extract<Pending, { kind: 'enroll' }>, body: Record<string, unknown>): Registered {
    if (body.factor === 'secure_enclave') {
      const publicKey = fromB64(body.publicKey, 'publicKey');
      if (!p256Key(publicKey)) throw new ApprovalError(400, 'not a P-256 public key');
      const v = verifySecureEnclave({ publicKeySpki: publicKey, challenge: p.challenge, signature: fromB64(body.signature, 'signature') });
      // The reason is crypto wording: Will reads what to do, and the log gets why.
      if (!v.ok) throw new ApprovalError(403, 'The key couldn’t be added. Try again.', `the key did not sign the challenge: ${v.reason}`);
      return { factor: 'secure_enclave', publicKey, signCount: 0, credentialId: `se_${createHash('sha256').update(publicKey).digest('hex').slice(0, 32)}` };
    }
    if (!this.o.rp) throw new ApprovalError(409, NO_PASSKEYS);
    const r = verifyWebAuthnRegistration({
      challenge: p.challenge,
      authenticatorData: body.authenticatorData !== undefined ? fromB64(body.authenticatorData, 'authenticatorData') : authDataFromAttestation(fromB64(body.attestationObject, 'attestationObject')),
      clientDataJson: fromB64(body.clientDataJSON, 'clientDataJSON'),
      rp: this.o.rp,
    });
    // A cause no retry can clear (the page is not at the RP's address) says its fix.
    if (!r.ok) throw new ApprovalError(403, refusalFix(r.reason) ?? 'The passkey couldn’t be added. Try again.', `the passkey registration did not verify: ${r.reason}`);
    return { factor: 'webauthn', publicKey: r.publicKeySpki, signCount: r.signCount, credentialId: r.credentialId };
  }

  private peekEnroll(id: unknown): Extract<Pending, { kind: 'enroll' }> {
    if (typeof id !== 'string') throw new ApprovalError(400, 'challengeId required');
    const p = this.pending.get(id);
    if (!p || p.kind !== 'enroll') throw new ApprovalError(404, 'no such challenge');
    if (p.expires <= this.now().getTime()) throw new ApprovalError(409, 'The request expired. Try again.');
    return p;
  }

  /**
   * A further credential: the approval an existing one must sign, naming the
   * new credential and (as its args digest) the new key itself. Takes the same
   * registration finishEnroll will, and does not use up the enrolment. Any
   * device with an existing key can sign it (pendingEnrolApprovals,
   * finishEnrolApproval): a passkey on the phone is approved with the Mac's
   * Touch ID key, and the other way round.
   */
  async beginEnrollApproval(body: Record<string, unknown>) {
    const p = this.peekEnroll(body.challengeId);
    const key = this.registered(p, body);
    return this.begin({
      subjectType: 'credential', subjectId: credentialRef(key.credentialId), decision: 'approve', action: 'approval.enroll', argsDigest: keyDigest(key.publicKey),
      fields: { label: p.label, factor: key.factor },
    });
  }

  /** New keys waiting for an existing key's approval (for the console of any enrolled device). */
  pendingEnrolApprovals(): Array<{ challengeId: string; challenge: string; payload: ApprovalPayload }> {
    const t = this.now().getTime();
    return [...this.pending].flatMap(([challengeId, p]) =>
      p.kind === 'approve' && p.payload.subjectType === 'credential' && p.payload.action === 'approval.enroll' && p.expires > t
        ? [{ challengeId, challenge: b64url(p.challenge), payload: p.payload }]
        : [],
    );
  }

  /** An existing key signs for a new one; the new device then finishes with this approval. */
  async finishEnrolApproval(body: Record<string, unknown>): Promise<{ approvalId: string }> {
    const p = this.take(body.challengeId, 'approve') as Extract<Pending, { kind: 'approve' }>;
    if (p.payload.subjectType !== 'credential' || p.payload.action !== 'approval.enroll') throw new ApprovalError(409, 'that is not a new key waiting for approval');
    const approvalId = await this.verifyAndRecord(p.payload, p.challenge, body);
    for (const [k, v] of this.enrolApprovals) if (v.expires <= this.now().getTime()) this.enrolApprovals.delete(k);
    this.enrolApprovals.set(String(body.challengeId), { approvalId, payload: p.payload, expires: p.expires });
    return { approvalId };
  }

  /** Has the new key waiting under this approval challenge been approved yet? */
  enrolApproved(challengeId: unknown): boolean {
    return typeof challengeId === 'string' && this.enrolApprovals.has(challengeId);
  }

  /**
   * Finish enrolling. Which path applies is decided now, not when the enrolment
   * began, and one enrolment finishes at a time:
   *  - a replace code (still the one this enrolment began with): every enrolled
   *    credential is revoked and the new one registered;
   *  - no credential enrolled and the code still there: the code registers it;
   *  - otherwise an existing credential must have signed for exactly this key.
   * The code is spent on success.
   */
  finishEnroll(body: Record<string, unknown>): Promise<{ credentialId: string }> {
    const run = this.enrolling.then(() => this.doFinishEnroll(body));
    this.enrolling = run.catch(() => {});
    return run;
  }

  private async doFinishEnroll(body: Record<string, unknown>): Promise<{ credentialId: string }> {
    const p = this.take(body.challengeId, 'enroll') as Extract<Pending, { kind: 'enroll' }>;
    const key = this.registered(p, body);
    const code = this.enrollCode();
    const codeStands = !!code && Approvals.hashOf(code.code) === p.codeHash;
    const all = await this.o.store.credentials();
    const live = all.filter((c) => !c.revokedAt);
    const known = all.find((c) => c.credentialId === key.credentialId);
    const record = (enrolledVia: string) => ({ credentialId: key.credentialId, factor: key.factor, publicKey: key.publicKey, label: p.label, signCount: key.signCount, enrolledVia });
    const add = (enrolledVia: string) => this.o.store.addCredential(record(enrolledVia));
    if (known?.revokedAt) throw new ApprovalError(409, 'That key was revoked. Use Replace This Mac’s Key to make a new one.');
    let event: EnrolEvent;
    if (codeStands && code.replace) {
      // This key becomes the only one: added (unless it is already enrolled) and every other revoked, in one transaction.
      const others = live.filter((c) => c.credentialId !== key.credentialId).map((c) => c.credentialId);
      await this.o.store.replace(known ? undefined : record('enroll_code_replace'), others);
      event = { credentialId: key.credentialId, factor: key.factor, via: 'enroll_code_replace', revoked: others };
    } else if (known) {
      throw new ApprovalError(409, 'That key is already added.');
    } else if (codeStands && live.length === 0) {
      await add('enroll_code');
      event = { credentialId: key.credentialId, factor: key.factor, via: 'enroll_code', revoked: [] };
    } else {
      if (live.length === 0) throw new ApprovalError(403, 'That code was already used. Get a new one with pnpm --filter @flint/runtime enroll.');
      const approvalId = this.approvalOfKey(key, body.approval);
      await add(`approval:${approvalId}`);
      event = { credentialId: key.credentialId, factor: key.factor, via: 'approval', approvalId, revoked: [] };
    }
    if (codeStands) rmSync(this.o.enrollCodeFile, { force: true });
    this.o.onEnrolled?.(event);
    return { credentialId: key.credentialId };
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

  /** The approval an existing key gave for exactly this new key (finishEnrolApproval), used once. */
  private approvalOfKey(key: Registered, raw: unknown): string {
    const id = raw && typeof raw === 'object' ? (raw as { challengeId?: unknown }).challengeId : undefined;
    const a = typeof id === 'string' ? this.enrolApprovals.get(id) : undefined;
    if (!a) throw new ApprovalError(403, 'A new key needs approval from a key you already have.');
    this.enrolApprovals.delete(id as string);
    if (a.expires <= this.now().getTime()) throw new ApprovalError(409, 'That approval expired. Try again.');
    if (a.payload.subjectId !== credentialRef(key.credentialId) || a.payload.argsDigest !== keyDigest(key.publicKey) || a.payload.decision !== 'approve') {
      throw new ApprovalError(403, 'That approval was for something else.');
    }
    return a.approvalId;
  }

  private async verifyAndRecord(payload: ApprovalPayload, challenge: Buffer, body: Record<string, unknown>): Promise<string> {
    const credentialId = typeof body.credentialId === 'string' ? body.credentialId : '';
    const cred = (await this.o.store.credentials()).find((c) => c.credentialId === credentialId);
    if (!cred || cred.revokedAt) {
      throw new ApprovalError(403, 'This device’s approval key was revoked or isn’t known. Add a new one in Settings.', cred ? 'the credential is revoked' : 'the credential is unknown');
    }
    const signature = fromB64(body.signature, 'signature');
    let authenticatorData: Buffer | undefined;
    let clientDataJson: Buffer | undefined;
    if (cred.factor === 'secure_enclave') {
      const v = verifySecureEnclave({ publicKeySpki: cred.publicKey, challenge, signature });
      if (!v.ok) throw new ApprovalError(403, 'Your approval didn’t verify. Try again.', `the signature did not verify: ${v.reason}`);
    } else {
      if (!this.o.rp) throw new ApprovalError(409, NO_PASSKEYS);
      authenticatorData = fromB64(body.authenticatorData, 'authenticatorData');
      clientDataJson = fromB64(body.clientDataJSON, 'clientDataJSON');
      const v = verifyWebAuthnAssertion({ publicKeySpki: cred.publicKey, challenge, authenticatorData, clientDataJson, signature, storedSignCount: cred.signCount, rp: this.o.rp });
      if (!v.ok) throw new ApprovalError(403, refusalFix(v.reason) ?? 'Your approval didn’t verify. Try again.', `the passkey did not verify: ${v.reason}`);
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

/**
 * The passkey relying party: the tailnet HTTPS origin `tailscale serve` gives
 * the console (~/.flint/tailscale-url.txt), or FLINT_RP_ID / FLINT_RP_ORIGINS.
 */
export function rpFromDisk(env: Record<string, string | undefined> = process.env, home = homedir()): { rp?: { rpId: string; origins: string[] } } {
  let raw = env.FLINT_RP_ORIGINS?.trim();
  if (!raw) {
    try {
      raw = readFileSync(join(home, '.flint', 'tailscale-url.txt'), 'utf8').trim().split('\n')[0];
    } catch {
      raw = undefined;
    }
  }
  // Every origin, scheme host AND port (what a browser puts in clientDataJSON),
  // the way install-runtime.sh gives them to the runtime.
  const origins = (raw ?? '').split(',').flatMap((o) => {
    try {
      const u = new URL(o.trim());
      return u.protocol === 'https:' && /^[a-z0-9.-]+$/i.test(u.hostname) ? [u.origin.toLowerCase()] : [];
    } catch {
      return [];
    }
  });
  if (origins.length === 0) return {};
  return { rp: { rpId: env.FLINT_RP_ID?.trim().toLowerCase() || new URL(origins[0]!).hostname, origins: [...new Set(origins)] } };
}
