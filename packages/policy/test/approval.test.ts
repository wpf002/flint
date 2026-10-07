import { describe, it, expect } from 'vitest';
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import {
  ApprovalPayload,
  challengeOf,
  coseP256ToSpki,
  payloadCurrent,
  p256Key,
  REFUSAL,
  refusalFix,
  verifySecureEnclave,
  verifyWebAuthnAssertion,
  verifyWebAuthnRegistration,
} from '../src/approval';

const rp = { rpId: 'flint.tail1234.ts.net', origins: ['https://flint.tail1234.ts.net'] };
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest();

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return { spki: publicKey.export({ format: 'der', type: 'spki' }), privateKey, publicKey };
}

const payload = (over: Partial<ApprovalPayload> = {}): ApprovalPayload => ({
  v: 1,
  subjectType: 'proposal',
  subjectId: 'clx0proposal',
  decision: 'approve',
  action: 'world.sync.github',
  argsDigest: 'a'.repeat(64),
  expiresAt: '2026-10-01T12:10:00Z',
  nonce: '0123456789abcdef0123456789abcdef',
  ...over,
});

function authData(flags: number, count: number, attested?: Buffer): Buffer {
  const c = Buffer.alloc(4);
  c.writeUInt32BE(count);
  return Buffer.concat([sha(rp.rpId), Buffer.from([flags]), c, attested ?? Buffer.alloc(0)]);
}

function assertion(privateKey: KeyObject, challenge: Buffer, o: { flags?: number; count?: number; origin?: string; type?: string; rpId?: string; challengeB64?: string } = {}) {
  const ad = o.rpId ? Buffer.concat([sha(o.rpId), authData(o.flags ?? 0x05, o.count ?? 0).subarray(32)]) : authData(o.flags ?? 0x05, o.count ?? 0);
  const clientDataJson = Buffer.from(JSON.stringify({
    type: o.type ?? 'webauthn.get',
    challenge: o.challengeB64 ?? challenge.toString('base64url'),
    origin: o.origin ?? rp.origins[0],
    crossOrigin: false,
  }));
  const signature = sign('sha256', Buffer.concat([ad, sha(clientDataJson)]), privateKey);
  return { authenticatorData: ad, clientDataJson, signature };
}

/** A COSE_Key for a P-256 public key: {1:2, 3:-7, -1:1, -2:x, -3:y}. */
function cose(publicKey: KeyObject): Buffer {
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const x = Buffer.from(jwk.x, 'base64url');
  const y = Buffer.from(jwk.y, 'base64url');
  return Buffer.concat([Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]), x, Buffer.from([0x22, 0x58, 0x20]), y]);
}

describe('approval payload', () => {
  it('is strict: an unknown field is refused', () => {
    expect(ApprovalPayload.safeParse(payload()).success).toBe(true);
    expect(ApprovalPayload.safeParse({ ...payload(), extra: 1 }).success).toBe(false);
    expect(ApprovalPayload.safeParse({ ...payload(), argsDigest: 'xyz' }).success).toBe(false);
  });

  it('the challenge binds every field, in any key order', () => {
    const p = payload();
    const reordered = Object.fromEntries(Object.entries(p).reverse()) as ApprovalPayload;
    expect(challengeOf(reordered).equals(challengeOf(p))).toBe(true);
    expect(challengeOf(payload({ argsDigest: 'b'.repeat(64) })).equals(challengeOf(p))).toBe(false);
  });

  it('expires', () => {
    expect(payloadCurrent(payload(), new Date('2026-10-01T12:00:00Z')).ok).toBe(true);
    expect(payloadCurrent(payload(), new Date('2026-10-01T12:10:00Z')).ok).toBe(false);
  });
});

describe('Secure Enclave signatures', () => {
  it('verify over the challenge, and fail on a different challenge or key', () => {
    const k = keypair();
    const challenge = challengeOf(payload());
    const signature = sign('sha256', challenge, k.privateKey);
    expect(verifySecureEnclave({ publicKeySpki: k.spki, challenge, signature }).ok).toBe(true);
    expect(verifySecureEnclave({ publicKeySpki: k.spki, challenge: challengeOf(payload({ decision: 'reject' })), signature }).ok).toBe(false);
    expect(verifySecureEnclave({ publicKeySpki: keypair().spki, challenge, signature }).ok).toBe(false);
    expect(verifySecureEnclave({ publicKeySpki: k.spki, challenge, signature: Buffer.from('nope') })).toEqual({ ok: false, reason: 'bad signature' });
  });

  it('refuse a key that is not P-256', () => {
    const ed = generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' });
    expect(p256Key(ed)).toBeUndefined();
    expect(verifySecureEnclave({ publicKeySpki: ed, challenge: Buffer.alloc(32), signature: Buffer.alloc(64) }).ok).toBe(false);
  });
});

describe('passkey assertions', () => {
  const k = keypair();
  const challenge = challengeOf(payload());
  const base = { publicKeySpki: k.spki, challenge, storedSignCount: 0, rp };

  it('verify a good assertion', () => {
    expect(verifyWebAuthnAssertion({ ...base, ...assertion(k.privateKey, challenge) })).toEqual({ ok: true, signCount: 0 });
  });

  it('refuse the wrong challenge, origin, type, RP or key', () => {
    expect(verifyWebAuthnAssertion({ ...base, ...assertion(k.privateKey, challenge, { challengeB64: Buffer.alloc(32).toString('base64url') }) }).ok).toBe(false);
    expect(verifyWebAuthnAssertion({ ...base, ...assertion(k.privateKey, challenge, { origin: 'https://evil.example' }) }).ok).toBe(false);
    expect(verifyWebAuthnAssertion({ ...base, ...assertion(k.privateKey, challenge, { type: 'webauthn.create' }) }).ok).toBe(false);
    expect(verifyWebAuthnAssertion({ ...base, ...assertion(k.privateKey, challenge, { rpId: 'evil.example' }) }).ok).toBe(false);
    expect(verifyWebAuthnAssertion({ ...base, publicKeySpki: keypair().spki, ...assertion(k.privateKey, challenge) }).ok).toBe(false);
  });

  it('need the user present and verified', () => {
    expect(verifyWebAuthnAssertion({ ...base, ...assertion(k.privateKey, challenge, { flags: 0x01 }) })).toMatchObject({ ok: false, reason: /verified/ });
    expect(verifyWebAuthnAssertion({ ...base, ...assertion(k.privateKey, challenge, { flags: 0x04 }) })).toMatchObject({ ok: false, reason: /present/ });
    expect(verifyWebAuthnAssertion({ ...base, rp: { ...rp, requireUserVerification: false }, ...assertion(k.privateKey, challenge, { flags: 0x01 }) }).ok).toBe(true);
  });

  it('refuse a replayed or cloned counter, allow synced passkeys that always say 0', () => {
    expect(verifyWebAuthnAssertion({ ...base, storedSignCount: 5, ...assertion(k.privateKey, challenge, { count: 5 }) }).ok).toBe(false);
    expect(verifyWebAuthnAssertion({ ...base, storedSignCount: 5, ...assertion(k.privateKey, challenge, { count: 0 }) }).ok).toBe(false);
    expect(verifyWebAuthnAssertion({ ...base, storedSignCount: 5, ...assertion(k.privateKey, challenge, { count: 6 }) })).toEqual({ ok: true, signCount: 6 });
  });

  it('a re-verify (no stored counter) accepts the recorded assertion again', () => {
    const a = assertion(k.privateKey, challenge, { count: 7 });
    expect(verifyWebAuthnAssertion({ ...base, storedSignCount: 6, ...a })).toEqual({ ok: true, signCount: 7 });
    const { storedSignCount: _drop, ...noCounter } = base;
    expect(verifyWebAuthnAssertion({ ...noCounter, ...a })).toEqual({ ok: true, signCount: 7 });
  });

  it('refuse a tampered authenticatorData', () => {
    const a = assertion(k.privateKey, challenge);
    const ad = Buffer.from(a.authenticatorData);
    ad[33] = 9;
    expect(verifyWebAuthnAssertion({ ...base, ...a, authenticatorData: ad }).ok).toBe(false);
  });
});

describe('a refusal no retry can clear', () => {
  const k = keypair();
  const challenge = challengeOf(payload());
  const base = { publicKeySpki: k.spki, challenge, storedSignCount: 0, rp };
  const reason = (o: Parameters<typeof assertion>[2], stored = 0) => {
    const v = verifyWebAuthnAssertion({ ...base, storedSignCount: stored, ...assertion(k.privateKey, challenge, o) });
    return v.ok ? undefined : v.reason;
  };

  it('is the verifier’s own reason, and Will reads its fix instead of "Try again"', () => {
    // The console opened from an address that is not the RP's (localhost, a second tailnet name).
    expect(reason({ origin: 'http://localhost:8080' })).toBe(REFUSAL.origin);
    expect(refusalFix(REFUSAL.origin)).toBe('Passkeys work only at Flint’s tailnet address. Open Flint there and try again.');
    // A passkey made for another host name.
    expect(reason({ rpId: 'flint.other.ts.net' })).toBe(REFUSAL.rpId);
    expect(refusalFix(REFUSAL.rpId)).toMatch(/^This passkey is for a different address than Flint’s\. Open Flint at its tailnet address/);
    // A counter that did not go up.
    expect(reason({ count: 5 }, 5)).toBe(REFUSAL.counter);
    expect(refusalFix(REFUSAL.counter)).toMatch(/Add a new passkey in Settings\.$/);
    // The runtime re-verifies what the server accepted: its own settings are what is wrong.
    expect(refusalFix(REFUSAL.rpMissing, 'runtime')).toBe('Passkeys aren’t set up on the runtime. Give it FLINT_RP_ID and FLINT_RP_ORIGINS, then restart it.');
    expect(refusalFix(REFUSAL.origin, 'runtime')).toBe('The runtime’s passkey settings don’t match the server’s. Give it the same FLINT_RP_ID and FLINT_RP_ORIGINS, then restart it.');
    expect(refusalFix(REFUSAL.rpId, 'runtime')).toBe(refusalFix(REFUSAL.origin, 'runtime'));
    expect(refusalFix(REFUSAL.revoked, 'runtime')).toBe('The key that signed it was revoked. Use a key you have now.');
    for (const where of ['server', 'runtime'] as const) {
      for (const r of Object.values(REFUSAL)) {
        const words = refusalFix(r, where);
        if (words) expect(words).toMatch(/^[A-Z][^]*\.$/);
      }
    }
  });

  it('leaves a refusal a retry may clear to the caller', () => {
    expect(reason({ flags: 0x01 })).toBe('the user was not verified');
    expect(refusalFix('the user was not verified')).toBeUndefined();
    expect(refusalFix('bad signature')).toBeUndefined();
    expect(refusalFix('bad signature', 'runtime')).toBeUndefined();
    expect(refusalFix(REFUSAL.counter, 'runtime')).toBeUndefined();
  });
});

describe('passkey registration', () => {
  const k = keypair();
  const challenge = Buffer.alloc(32, 7);
  const credId = Buffer.alloc(20, 3);
  const attested = (key: Buffer) => {
    const len = Buffer.alloc(2);
    len.writeUInt16BE(credId.length);
    return Buffer.concat([Buffer.alloc(16), len, credId, key]);
  };
  const clientDataJson = (o: { type?: string; origin?: string } = {}) =>
    Buffer.from(JSON.stringify({ type: o.type ?? 'webauthn.create', challenge: challenge.toString('base64url'), origin: o.origin ?? rp.origins[0] }));

  it('returns the credential id and the SPKI of the COSE key', () => {
    const r = verifyWebAuthnRegistration({ challenge, rp, clientDataJson: clientDataJson(), authenticatorData: authData(0x45, 0, attested(cose(k.publicKey))) });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.credentialId).toBe(credId.toString('base64url'));
      expect(r.publicKeySpki.equals(k.spki)).toBe(true);
    }
  });

  it('refuses an assertion, a missing attested-data flag, a wrong origin or a non-ES256 key', () => {
    const ad = authData(0x45, 0, attested(cose(k.publicKey)));
    expect(verifyWebAuthnRegistration({ challenge, rp, clientDataJson: clientDataJson({ type: 'webauthn.get' }), authenticatorData: ad }).ok).toBe(false);
    expect(verifyWebAuthnRegistration({ challenge, rp, clientDataJson: clientDataJson({ origin: 'https://x.example' }), authenticatorData: ad }).ok).toBe(false);
    expect(verifyWebAuthnRegistration({ challenge, rp, clientDataJson: clientDataJson(), authenticatorData: authData(0x05, 0, attested(cose(k.publicKey))) }).ok).toBe(false);
    const rs256 = Buffer.from(cose(k.publicKey));
    rs256[4] = 0x39; // alg -258
    expect(coseP256ToSpki(rs256)).toBeUndefined();
    expect(verifyWebAuthnRegistration({ challenge, rp, clientDataJson: clientDataJson(), authenticatorData: authData(0x45, 0, attested(rs256)) }).ok).toBe(false);
  });

  it('the COSE reader refuses junk and points off the curve', () => {
    expect(coseP256ToSpki(Buffer.from([0xa0]))).toBeUndefined();
    expect(coseP256ToSpki(Buffer.alloc(0))).toBeUndefined();
    const bad = Buffer.from(cose(k.publicKey));
    bad[bad.length - 1] = bad[bad.length - 1]! ^ 0xff;
    expect(coseP256ToSpki(bad)).toBeUndefined();
  });
});
