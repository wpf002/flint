/**
 * Will's approval factor (Machine plan 3.0.2) with real P-256 keys: enrolment
 * needs the one-time code, approvals need a valid signature by a live
 * credential over exactly the payload begun, challenges are used once and
 * expire, and nothing Flint holds can stand in for the key.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Approvals, ApprovalError, keyDigest, rpFromDisk, type ApproverStore, type Credential, type NewApproval } from '../src/approvals';

const rp = { rpId: 'flint.tail1234.ts.net', origins: ['https://flint.tail1234.ts.net'] };
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest();

function memoryStore() {
  const creds: Array<Credential & { enrolledVia: string }> = [];
  const approvals: NewApproval[] = [];
  const store: ApproverStore = {
    credentials: async () => creds,
    addCredential: async (c) => void creds.push({ ...c, revokedAt: null }),
    addApproval: async (a) => void approvals.push(a),
    setSignCount: async (id, n) => {
      const c = creds.find((x) => x.credentialId === id)!;
      c.signCount = Math.max(c.signCount, n);
    },
    revoke: async (id) => {
      const c = creds.find((x) => x.credentialId === id);
      if (c && !c.revokedAt) c.revokedAt = new Date();
    },
    replace: async (add, revoke) => {
      if (add) creds.push({ ...add, revokedAt: null });
      for (const c of creds) if (revoke.includes(c.credentialId) && !c.revokedAt) c.revokedAt = new Date();
    },
  };
  return { store, creds, approvals };
}

/** A passkey: registration and assertions over given challenges. */
function passkey() {
  const k = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = k.publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const cose = Buffer.concat([Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]), Buffer.from(jwk.x, 'base64url'), Buffer.from([0x22, 0x58, 0x20]), Buffer.from(jwk.y, 'base64url')]);
  const credId = Buffer.alloc(20, 9);
  let counter = 0;
  const authData = (flags: number, extra = Buffer.alloc(0)) => {
    const c = Buffer.alloc(4);
    c.writeUInt32BE(counter);
    return Buffer.concat([sha(rp.rpId), Buffer.from([flags]), c, extra]);
  };
  return {
    register(challenge: string) {
      const len = Buffer.alloc(2);
      len.writeUInt16BE(credId.length);
      const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge, origin: rp.origins[0] }));
      return { authenticatorData: authData(0x45, Buffer.concat([Buffer.alloc(16), len, credId, cose])).toString('base64url'), clientDataJSON: clientDataJSON.toString('base64url') };
    },
    assert(challenge: string) {
      counter += 1;
      const ad = authData(0x05);
      const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin: rp.origins[0] }));
      const signature = sign('sha256', Buffer.concat([ad, sha(clientDataJSON)]), k.privateKey);
      return { credentialId: credId.toString('base64url'), authenticatorData: ad.toString('base64url'), clientDataJSON: clientDataJSON.toString('base64url'), signature: signature.toString('base64url') };
    },
  };
}

/** The desktop app's Secure Enclave key. */
function enclave() {
  const k = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return {
    publicKey: k.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
    sign: (challenge: string) => sign('sha256', Buffer.from(challenge, 'base64url'), k.privateKey).toString('base64url'),
  };
}

const subject = { subjectType: 'proposal' as const, subjectId: 'pr1', decision: 'approve' as const, action: 'gcal.create_event', argsDigest: 'a'.repeat(64) };

describe('approvals', () => {
  let dir: string;
  let codeFile: string;
  let mem: ReturnType<typeof memoryStore>;
  let now: Date;
  let approvals: Approvals;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'flint-ap-'));
    codeFile = join(dir, 'enroll-code');
    writeFileSync(codeFile, 'abcd-efgh-ijkl-mnop\n');
    mem = memoryStore();
    now = new Date('2026-10-01T12:00:00Z');
    approvals = new Approvals({ store: mem.store, rp, enrollCodeFile: codeFile, now: () => now });
  });

  it('enrolment needs the one-time code, and spends it', async () => {
    await expect(approvals.beginEnroll({ code: 'wrong-code-0000', label: 'phone' })).rejects.toThrow('That code is wrong or missing. Get a new one with pnpm --filter @flint/runtime enroll.');
    const pk = passkey();
    const b = await approvals.beginEnroll({ code: 'abcd-efgh-ijkl-mnop', label: 'phone' });
    expect(b.rp).toEqual({ id: rp.rpId });
    await approvals.finishEnroll({ challengeId: b.challengeId, ...pk.register(b.challenge) });
    expect(mem.creds.map((c) => [c.factor, c.label, c.enrolledVia])).toEqual([['webauthn', 'phone', 'enroll_code']]);
    expect(existsSync(codeFile)).toBe(false);
    await expect(approvals.beginEnroll({ code: 'abcd-efgh-ijkl-mnop', label: 'again' })).rejects.toThrow('That code is wrong or missing. Get a new one with pnpm --filter @flint/runtime enroll.');
  });

  it('accepts a registration sent as an attestationObject (older Safari)', async () => {
    const { authDataFromAttestation } = await import('../src/approvals');
    const pk = passkey();
    const b = await approvals.beginEnroll({ code: 'abcd-efgh-ijkl-mnop', label: 'old safari' });
    const reg = pk.register(b.challenge);
    const authData = Buffer.from(reg.authenticatorData, 'base64url');
    // {"fmt": "none", "attStmt": {}, "authData": h'...'}
    const len = Buffer.alloc(2);
    len.writeUInt16BE(authData.length);
    const att = Buffer.concat([Buffer.from([0xa3, 0x63]), Buffer.from('fmt'), Buffer.from([0x64]), Buffer.from('none'), Buffer.from([0x67]), Buffer.from('attStmt'), Buffer.from([0xa0, 0x68]), Buffer.from('authData'), Buffer.from([0x59]), len, authData]);
    expect(authDataFromAttestation(att).equals(authData)).toBe(true);
    await approvals.finishEnroll({ challengeId: b.challengeId, clientDataJSON: reg.clientDataJSON, attestationObject: att.toString('base64url') });
    expect(mem.creds).toHaveLength(1);
  });

  it('a Secure Enclave key must prove it holds the key', async () => {
    const se = enclave();
    const b = await approvals.beginEnroll({ code: 'abcd-efgh-ijkl-mnop', label: 'Touch ID' });
    await expect(approvals.finishEnroll({ challengeId: b.challengeId, factor: 'secure_enclave', publicKey: se.publicKey, signature: enclave().sign(b.challenge) })).rejects.toThrow('The key couldn’t be added. Try again.');
    const b2 = await approvals.beginEnroll({ code: 'abcd-efgh-ijkl-mnop', label: 'Touch ID' });
    await approvals.finishEnroll({ challengeId: b2.challengeId, factor: 'secure_enclave', publicKey: se.publicKey, signature: se.sign(b2.challenge) });
    expect(mem.creds[0]).toMatchObject({ factor: 'secure_enclave', label: 'Touch ID' });
  });

  async function enrolled() {
    const pk = passkey();
    const b = await approvals.beginEnroll({ code: 'abcd-efgh-ijkl-mnop', label: 'phone' });
    await approvals.finishEnroll({ challengeId: b.challengeId, ...pk.register(b.challenge) });
    return pk;
  }

  it('a passkey approval over the begun payload is recorded; the counter is kept', async () => {
    const pk = await enrolled();
    const b = approvals.begin(subject);
    expect(b.payload).toMatchObject({ v: 1, ...subject, expiresAt: '2026-10-01T12:05:00.000Z' });
    const { approvalId } = await approvals.finish({ challengeId: b.challengeId, ...pk.assert(b.challenge) });
    expect(mem.approvals).toHaveLength(1);
    expect(mem.approvals[0]).toMatchObject({ id: approvalId, payload: b.payload, challengeHex: Buffer.from(b.challenge, 'base64url').toString('hex') });
    expect(mem.creds[0]!.signCount).toBe(1);
  });

  it('a challenge is used once, and expires', async () => {
    const pk = await enrolled();
    const b = approvals.begin(subject);
    const assertion = pk.assert(b.challenge);
    await approvals.finish({ challengeId: b.challengeId, ...assertion });
    await expect(approvals.finish({ challengeId: b.challengeId, ...assertion })).rejects.toThrow(/no such challenge/);
    const late = approvals.begin(subject);
    now = new Date(now.getTime() + 6 * 60_000);
    await expect(approvals.finish({ challengeId: late.challengeId, ...pk.assert(late.challenge) })).rejects.toThrow('The request expired. Try again.');
  });

  it('a signature over a different challenge, or by an unknown key, is refused and nothing is recorded', async () => {
    const pk = await enrolled();
    const a = approvals.begin(subject);
    const b = approvals.begin({ ...subject, subjectId: 'pr2' });
    await expect(approvals.finish({ challengeId: a.challengeId, ...pk.assert(b.challenge) })).rejects.toThrow(ApprovalError);
    const c = approvals.begin(subject);
    await expect(approvals.finish({ challengeId: c.challengeId, ...passkey().assert(c.challenge) })).rejects.toThrow('Your approval didn’t verify. Try again.');
    expect(mem.approvals).toEqual([]);
  });

  it('a second credential needs the code AND an existing credential\'s approval of that exact key', async () => {
    const first = await enrolled();
    writeFileSync(codeFile, 'qrst-uvwx-yz12-3456\n');
    const se = enclave();
    const b = await approvals.beginEnroll({ code: 'qrst-uvwx-yz12-3456', label: 'Touch ID' });
    expect(b.needsApproval).toBe(true);
    const reg = { challengeId: b.challengeId, factor: 'secure_enclave', publicKey: se.publicKey, signature: se.sign(b.challenge) };
    // The approval names the new credential and, as its args digest, the new key.
    const ap = await approvals.beginEnrollApproval(reg);
    expect(ap.payload).toMatchObject({ subjectType: 'credential', action: 'approval.enroll', argsDigest: keyDigest(Buffer.from(se.publicKey, 'base64url')), fields: { label: 'Touch ID', factor: 'secure_enclave' } });
    // Any device with an existing key sees it waiting, and signs it there.
    expect(approvals.pendingEnrolApprovals().map((p) => p.challengeId)).toEqual([ap.challengeId]);
    expect(approvals.enrolApproved(ap.challengeId)).toBe(false);
    await approvals.finishEnrolApproval({ challengeId: ap.challengeId, ...first.assert(ap.challenge) });
    expect(approvals.enrolApproved(ap.challengeId)).toBe(true);
    await approvals.finishEnroll({ ...reg, approval: { challengeId: ap.challengeId } });
    expect(mem.creds.map((c) => c.enrolledVia)).toEqual(['enroll_code', expect.stringMatching(/^approval:ap/)]);
    expect(existsSync(codeFile)).toBe(false);
  });

  it('without that approval, or with one for another key, the second credential is refused', async () => {
    const first = await enrolled();
    writeFileSync(codeFile, 'qrst-uvwx-yz12-3456\n');
    const se = enclave();
    const b = await approvals.beginEnroll({ code: 'qrst-uvwx-yz12-3456', label: 'Touch ID' });
    await expect(approvals.finishEnroll({ challengeId: b.challengeId, factor: 'secure_enclave', publicKey: se.publicKey, signature: se.sign(b.challenge) })).rejects.toThrow('A new key needs approval from a key you already have.');
    // An approval for a different key (same id spoofed is impossible: the id is derived from the key) does not carry over.
    const other = enclave();
    const b2 = await approvals.beginEnroll({ code: 'qrst-uvwx-yz12-3456', label: 'other' });
    const ap = await approvals.beginEnrollApproval({ challengeId: b2.challengeId, factor: 'secure_enclave', publicKey: other.publicKey, signature: other.sign(b2.challenge) });
    await approvals.finishEnrolApproval({ challengeId: ap.challengeId, ...first.assert(ap.challenge) });
    const b3 = await approvals.beginEnroll({ code: 'qrst-uvwx-yz12-3456', label: 'Touch ID' });
    await expect(approvals.finishEnroll({ challengeId: b3.challengeId, factor: 'secure_enclave', publicKey: se.publicKey, signature: se.sign(b3.challenge), approval: { challengeId: ap.challengeId } })).rejects.toThrow('That approval was for something else.');
    expect(mem.creds).toHaveLength(1);
  });

  it('one code cannot enrol two keys: whether a key exists is decided when an enrolment finishes', async () => {
    const pk = passkey();
    const se = enclave();
    // Two enrolments begun with the same code before either finishes (two devices, a double click).
    const a = await approvals.beginEnroll({ code: 'abcd-efgh-ijkl-mnop', label: 'phone' });
    const b = await approvals.beginEnroll({ code: 'abcd-efgh-ijkl-mnop', label: 'Touch ID' });
    expect(a.needsApproval).toBe(false);
    const results = await Promise.allSettled([
      approvals.finishEnroll({ challengeId: a.challengeId, ...pk.register(a.challenge) }),
      approvals.finishEnroll({ challengeId: b.challengeId, factor: 'secure_enclave', publicKey: se.publicKey, signature: se.sign(b.challenge) }),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
    expect(mem.creds.map((c) => c.enrolledVia)).toEqual(['enroll_code']);
  });

  it('a replace code (enroll --replace) registers the new key and revokes every other', async () => {
    await enrolled();
    writeFileSync(codeFile, 'rplc-0000-1111-2222 replace\n');
    const se = enclave();
    const b = await approvals.beginEnroll({ code: 'rplc-0000-1111-2222', label: 'new Touch ID' });
    expect(b.needsApproval).toBe(false);
    const events: unknown[] = [];
    const ap2 = new Approvals({ store: mem.store, rp, enrollCodeFile: codeFile, now: () => now, onEnrolled: (e) => events.push(e) });
    const b2 = await ap2.beginEnroll({ code: 'rplc-0000-1111-2222', label: 'new Touch ID' });
    await ap2.finishEnroll({ challengeId: b2.challengeId, factor: 'secure_enclave', publicKey: se.publicKey, signature: se.sign(b2.challenge) });
    expect(mem.creds.map((c) => [c.enrolledVia, !!c.revokedAt])).toEqual([['enroll_code', true], ['enroll_code_replace', false]]);
    expect(events).toEqual([expect.objectContaining({ via: 'enroll_code_replace', revoked: [mem.creds[0]!.credentialId] })]);
    expect(await ap2.hasCredentials()).toBe(true);
  });

  it('the relying party keeps the port, takes every origin, and the rp id is the host', () => {
    expect(rpFromDisk({ FLINT_RP_ORIGINS: 'https://flint.tail1234.ts.net:8443/, https://Other.ts.net' }, '/nowhere').rp).toEqual({ rpId: 'flint.tail1234.ts.net', origins: ['https://flint.tail1234.ts.net:8443', 'https://other.ts.net'] });
    expect(rpFromDisk({ FLINT_RP_ORIGINS: 'http://insecure.example' }, '/nowhere').rp).toBeUndefined();
    const home = mkdtempSync(join(tmpdir(), 'flint-rp-'));
    mkdirSync(join(home, '.flint'));
    writeFileSync(join(home, '.flint', 'tailscale-url.txt'), 'https://studio.tail1234.ts.net/\n');
    expect(rpFromDisk({}, home).rp).toEqual({ rpId: 'studio.tail1234.ts.net', origins: ['https://studio.tail1234.ts.net'] });
  });

  it('refuses a payload that is not one (bad digest)', () => {
    expect(() => approvals.begin({ ...subject, argsDigest: 'nope' })).toThrow(/cannot approve/);
  });
});
