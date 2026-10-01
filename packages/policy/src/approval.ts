/**
 * Verifying Will's approval signatures (Machine plan 3.0.2).
 *
 * An approval is a signature by a key that never exists inside any Flint
 * process: a WebAuthn passkey (phone or browser on the tailnet origin) or a
 * Secure Enclave P-256 key behind Touch ID in the desktop app. Both sign
 * `challenge = sha256(canonical(payload))`, where the payload names the exact
 * action, the digest of its exact arguments, an expiry and a nonce. The server
 * verifies before it records the Approval; the runtime verifies again before it
 * executes, so a row inserted any other way does nothing.
 *
 * WHY THIS SHAPE. The threat is Flint (or the model) approving its own actions,
 * and a stolen console token being used to approve. Neither holds the key.
 */
import { createHash, createPublicKey, timingSafeEqual, verify, type KeyObject } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from './canonical.js';

export const SUBJECT_TYPES = [
  'proposal', 'goal', 'plan', 'task', 'policy', 'forget', 'void', 'correction', 'credential', 'partition_drop',
] as const;
export type SubjectType = (typeof SUBJECT_TYPES)[number];

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);

/** What Will signs. Strict: an unknown field is refused, not ignored. */
export const ApprovalPayload = z
  .object({
    v: z.literal(1),
    subjectType: z.enum(SUBJECT_TYPES),
    subjectId: z.string().min(1).max(64),
    decision: z.enum(['approve', 'reject']),
    action: z.string().min(1).max(200),
    argsDigest: hex64,
    /** The key fields the approval card showed, so the signature covers what Will saw. */
    fields: z.record(z.string().max(64), z.union([z.string().max(500), z.number(), z.boolean(), z.null()])).optional(),
    expiresAt: z.string().datetime({ offset: true }),
    nonce: z.string().regex(/^[0-9a-f]{32,64}$/),
  })
  .strict();
export type ApprovalPayload = z.infer<typeof ApprovalPayload>;

/** The 32 bytes that get signed: sha256 of the payload's canonical JSON. */
export function challengeOf(payload: ApprovalPayload): Buffer {
  return createHash('sha256').update(canonicalJson(payload)).digest();
}

export type Refused = { ok: false; reason: string };
export type Verified = { ok: true; signCount?: number } | Refused;
const no = (reason: string): Refused => ({ ok: false, reason });

/** A P-256 public key from SPKI DER, or undefined if it is not one. */
export function p256Key(spki: Uint8Array): KeyObject | undefined {
  try {
    const key = createPublicKey({ key: Buffer.from(spki), format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') return undefined;
    return key;
  } catch {
    return undefined;
  }
}

/** Is this payload still within its expiry? (The subject and decision are matched by the caller, against the row being approved.) */
export function payloadCurrent(payload: ApprovalPayload, now: Date = new Date()): Verified {
  const exp = Date.parse(payload.expiresAt);
  if (!Number.isFinite(exp)) return no('expiresAt is not a date');
  if (exp <= now.getTime()) return no('the approval has expired');
  return { ok: true };
}

/**
 * The desktop app's Secure Enclave key: `SecKeyCreateSignature` with
 * `.ecdsaSignatureMessageX962SHA256` over the 32 challenge bytes, which hashes
 * them with SHA-256 and signs; the signature is DER.
 */
export function verifySecureEnclave(opts: { publicKeySpki: Uint8Array; challenge: Uint8Array; signature: Uint8Array }): Verified {
  const key = p256Key(opts.publicKeySpki);
  if (!key) return no('not a P-256 public key');
  try {
    return verify('sha256', Buffer.from(opts.challenge), key, Buffer.from(opts.signature)) ? { ok: true } : no('bad signature');
  } catch {
    return no('malformed signature');
  }
}

const b64url = (b: Uint8Array): string => Buffer.from(b).toString('base64url');
const sha256 = (b: Uint8Array | string): Buffer => createHash('sha256').update(b).digest();
const same = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && timingSafeEqual(a, b);

/** Authenticator data flags. */
const UP = 0x01;
const UV = 0x04;
const AT = 0x40;

export interface WebAuthnRelyingParty {
  /** The RP ID the passkey was made for: the tailnet host name, e.g. flint.tailXXXX.ts.net. */
  rpId: string;
  /** The exact origins the console is served from: https://flint.tailXXXX.ts.net. */
  origins: readonly string[];
  /** Require user verification (biometric or PIN), not just presence. Default true. */
  requireUserVerification?: boolean;
}

interface ClientData {
  type?: unknown;
  challenge?: unknown;
  origin?: unknown;
  crossOrigin?: unknown;
}

function checkClientData(raw: Uint8Array, type: 'webauthn.get' | 'webauthn.create', challenge: Uint8Array, rp: WebAuthnRelyingParty): Verified {
  let cd: ClientData;
  try {
    cd = JSON.parse(Buffer.from(raw).toString('utf8')) as ClientData;
  } catch {
    return no('clientDataJSON is not JSON');
  }
  if (cd.type !== type) return no(`clientData type is not ${type}`);
  if (typeof cd.challenge !== 'string' || cd.challenge !== b64url(challenge)) return no('the challenge does not match');
  if (typeof cd.origin !== 'string' || !rp.origins.includes(cd.origin)) return no('the origin is not allowed');
  if (cd.crossOrigin === true) return no('cross-origin assertions are refused');
  return { ok: true };
}

function checkAuthData(authData: Uint8Array, rp: WebAuthnRelyingParty, needAttested: boolean): Verified & { signCount?: number } {
  if (authData.length < 37) return no('authenticatorData is too short');
  if (!same(authData.subarray(0, 32), sha256(rp.rpId))) return no('the RP ID does not match');
  const flags = authData[32]!;
  if (!(flags & UP)) return no('the user was not present');
  if ((rp.requireUserVerification ?? true) && !(flags & UV)) return no('the user was not verified');
  if (needAttested && !(flags & AT)) return no('no attested credential data');
  return { ok: true, signCount: Buffer.from(authData).readUInt32BE(33) };
}

/**
 * A passkey assertion (navigator.credentials.get) over the approval challenge.
 * `storedSignCount` is the credential's last counter: a counter that does not go
 * up (when either side is non-zero) means a cloned authenticator. Synced passkeys
 * report 0 every time, which is allowed.
 */
export function verifyWebAuthnAssertion(opts: {
  publicKeySpki: Uint8Array;
  challenge: Uint8Array;
  authenticatorData: Uint8Array;
  clientDataJson: Uint8Array;
  signature: Uint8Array;
  /**
   * The credential's last counter, for clone detection when an approval is first
   * recorded. Omit it to re-verify a stored assertion (the runtime, before it
   * executes): the counter was checked when it was recorded.
   */
  storedSignCount?: number;
  rp: WebAuthnRelyingParty;
}): Verified {
  const key = p256Key(opts.publicKeySpki);
  if (!key) return no('not a P-256 public key');
  const cd = checkClientData(opts.clientDataJson, 'webauthn.get', opts.challenge, opts.rp);
  if (!cd.ok) return cd;
  const ad = checkAuthData(opts.authenticatorData, opts.rp, false);
  if (!ad.ok) return ad;
  const count = ad.signCount ?? 0;
  const stored = opts.storedSignCount;
  if (stored !== undefined && (count !== 0 || stored !== 0) && count <= stored) return no('the signature counter did not increase');
  const signed = Buffer.concat([Buffer.from(opts.authenticatorData), sha256(opts.clientDataJson)]);
  try {
    return verify('sha256', signed, key, Buffer.from(opts.signature)) ? { ok: true, signCount: count } : no('bad signature');
  } catch {
    return no('malformed signature');
  }
}

// ---------------------------------------------------------------------------
// Enrolment: a passkey registration (navigator.credentials.create).

/** SPKI DER prefix for an uncompressed P-256 point (the 65 bytes follow). */
const P256_SPKI_PREFIX = Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex');

/**
 * The COSE_Key a WebAuthn authenticator returns, as SPKI DER. Only EC2 P-256
 * with ES256 is accepted: {1: 2, 3: -7, -1: 1, -2: x(32), -3: y(32)}.
 * A deliberately tiny CBOR reader: it accepts exactly that map and nothing else.
 */
export function coseP256ToSpki(cose: Uint8Array): { spki: Buffer; length: number } | undefined {
  const b = Buffer.from(cose);
  let i = 0;
  const head = (): { major: number; value: number } | undefined => {
    if (i >= b.length) return undefined;
    const ib = b[i++]!;
    const major = ib >> 5;
    const info = ib & 0x1f;
    if (info < 24) return { major, value: info };
    if (info === 24 && i < b.length) return { major, value: b[i++]! };
    return undefined;
  };
  const int = (): number | undefined => {
    const h = head();
    if (!h) return undefined;
    if (h.major === 0) return h.value;
    if (h.major === 1) return -1 - h.value;
    return undefined;
  };
  const map = head();
  if (!map || map.major !== 5 || map.value !== 5) return undefined;
  const got = new Map<number, number | Buffer>();
  for (let n = 0; n < 5; n++) {
    const k = int();
    if (k === undefined || got.has(k)) return undefined;
    if (k === -2 || k === -3) {
      const h = head();
      if (!h || h.major !== 2 || h.value !== 32 || i + 32 > b.length) return undefined;
      got.set(k, b.subarray(i, i + 32));
      i += 32;
    } else {
      const v = int();
      if (v === undefined) return undefined;
      got.set(k, v);
    }
  }
  if (got.get(1) !== 2 || got.get(3) !== -7 || got.get(-1) !== 1) return undefined;
  const x = got.get(-2);
  const y = got.get(-3);
  if (!Buffer.isBuffer(x) || !Buffer.isBuffer(y)) return undefined;
  const spki = Buffer.concat([P256_SPKI_PREFIX, Buffer.from([0x04]), x, y]);
  return p256Key(spki) ? { spki, length: i } : undefined;
}

/**
 * A passkey registration made over `challenge` (attestation "none": the
 * authenticator is trusted because Will enrolled it with the one-time code or an
 * existing credential's approval, not because of a vendor certificate).
 * Returns the credential id and its public key as SPKI DER.
 */
export function verifyWebAuthnRegistration(opts: {
  challenge: Uint8Array;
  authenticatorData: Uint8Array;
  clientDataJson: Uint8Array;
  rp: WebAuthnRelyingParty;
}): { ok: true; credentialId: string; publicKeySpki: Buffer; signCount: number } | Refused {
  const cd = checkClientData(opts.clientDataJson, 'webauthn.create', opts.challenge, opts.rp);
  if (!cd.ok) return no(cd.reason);
  const ad = checkAuthData(opts.authenticatorData, opts.rp, true);
  if (!ad.ok) return no(ad.reason);
  const a = Buffer.from(opts.authenticatorData);
  // rpIdHash(32) flags(1) signCount(4) aaguid(16) credIdLen(2) credId(L) COSE key
  if (a.length < 55) return no('attested credential data is truncated');
  const idLen = a.readUInt16BE(53);
  if (idLen < 16 || idLen > 1023 || a.length < 55 + idLen) return no('bad credential id length');
  const credentialId = a.subarray(55, 55 + idLen);
  const key = coseP256ToSpki(a.subarray(55 + idLen));
  if (!key) return no('the credential is not an ES256 P-256 key');
  return { ok: true, credentialId: b64url(credentialId), publicKeySpki: key.spki, signCount: ad.signCount ?? 0 };
}
