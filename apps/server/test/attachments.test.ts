import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import {
  parseAttachments,
  sniff,
  mediaNeeds,
  summarizeAttachments,
  readJsonLimited,
  LIMITS,
  MAX_BODY_BYTES,
} from '../src/attachments';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46]);
const GIF = Buffer.from('GIF89a\x01\x00', 'latin1');
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);
const PDF = Buffer.from('%PDF-1.7\n%âãÏÓ\n1 0 obj\n', 'latin1');

const b64 = (b: Buffer) => b.toString('base64');
const file = (name: string, type: string, bytes: Buffer) => ({ name, type, data: b64(bytes) });

describe('sniff', () => {
  it('identifies each supported format by its bytes', () => {
    expect(sniff(PNG)).toBe('image/png');
    expect(sniff(JPEG)).toBe('image/jpeg');
    expect(sniff(GIF)).toBe('image/gif');
    expect(sniff(WEBP)).toBe('image/webp');
    expect(sniff(PDF)).toBe('application/pdf');
    expect(sniff(Buffer.from('hello'))).toBeUndefined();
  });
});

describe('parseAttachments', () => {
  it('treats missing / empty as no attachments', () => {
    expect(parseAttachments(undefined)).toEqual({ ok: true, attachments: [] });
    expect(parseAttachments([])).toEqual({ ok: true, attachments: [] });
  });

  it('rejects a non-array', () => {
    expect(parseAttachments('x')).toMatchObject({ ok: false, status: 400 });
  });

  it('accepts images and PDFs, classified by their bytes', () => {
    const r = parseAttachments([file('a.png', 'image/png', PNG), file('b.pdf', 'application/pdf', PDF)]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.attachments[0]).toEqual({ kind: 'image', mediaType: 'image/png', name: 'a.png', data: b64(PNG), bytes: PNG.length });
    expect(r.attachments[1]).toMatchObject({ kind: 'document', mediaType: 'application/pdf', name: 'b.pdf' });
  });

  it('trusts the bytes over the declared type', () => {
    const r = parseAttachments([file('photo.jpg', 'image/jpeg', PNG)]);
    expect(r.ok && r.attachments[0]!.mediaType).toBe('image/png');
    const r2 = parseAttachments([file('scan.png', 'image/png', PDF)]);
    expect(r2.ok && r2.attachments[0]!.kind).toBe('document');
  });

  it('accepts a data: URL as well as bare base64', () => {
    const r = parseAttachments([{ name: 'a.png', type: 'image/png', data: `data:image/png;base64,${b64(PNG)}` }]);
    expect(r.ok && r.attachments[0]!.data).toBe(b64(PNG));
  });

  it('decodes text files to UTF-8 text, by MIME or by extension', () => {
    const r = parseAttachments([
      file('notes.md', 'text/markdown', Buffer.from('# héllo')),
      file('main.ts', '', Buffer.from('export const x = 1;')),
      file('data.json', 'application/octet-stream', Buffer.from('{"a":1}')),
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.attachments.map((a) => [a.kind, a.mediaType, a.text])).toEqual([
      ['text', 'text/markdown', '# héllo'],
      ['text', 'text/x-typescript', 'export const x = 1;'],
      ['text', 'application/json', '{"a":1}'],
    ]);
    expect(r.attachments[0]).not.toHaveProperty('data');
  });

  it('rejects an image type no provider reads (HEIC), naming the file', () => {
    const r = parseAttachments([file('IMG_1.heic', 'image/heic', Buffer.from('....ftypheic'))]);
    expect(r).toMatchObject({ ok: false, status: 415 });
    expect(!r.ok && r.error).toMatch(/IMG_1\.heic/);
  });

  it('rejects something claiming to be a PNG that is not one', () => {
    expect(parseAttachments([file('x.png', 'image/png', Buffer.from('not an image'))])).toMatchObject({ ok: false, status: 415 });
  });

  it('rejects binaries dressed as text', () => {
    expect(parseAttachments([file('evil.txt', 'text/plain', Buffer.from([0x68, 0x00, 0x69]))])).toMatchObject({ ok: false, status: 415 });
    expect(parseAttachments([file('bad.txt', 'text/plain', Buffer.from([0xc3, 0x28]))])).toMatchObject({ ok: false, status: 415 });
  });

  it('rejects unknown types', () => {
    expect(parseAttachments([file('app.exe', 'application/x-msdownload', Buffer.from('MZ'))])).toMatchObject({ ok: false, status: 415 });
    expect(parseAttachments([file('blob', 'application/octet-stream', Buffer.from('abc'))])).toMatchObject({ ok: false, status: 415 });
  });

  it('rejects invalid base64 and empty files', () => {
    expect(parseAttachments([{ name: 'a', type: 'text/plain', data: '***' }])).toMatchObject({ ok: false, status: 400 });
    expect(parseAttachments([{ name: 'a', type: 'text/plain', data: '' }])).toMatchObject({ ok: false, status: 400 });
    expect(parseAttachments([{ name: 'a', type: 'text/plain' }])).toMatchObject({ ok: false, status: 400 });
  });

  it('enforces the count limit', () => {
    const many = Array.from({ length: LIMITS.maxCount + 1 }, (_, i) => file(`${i}.png`, 'image/png', PNG));
    expect(parseAttachments(many)).toMatchObject({ ok: false, status: 413 });
  });

  it('enforces per-type size limits', () => {
    const bigImage = Buffer.concat([PNG, Buffer.alloc(LIMITS.imageBytes)]);
    expect(parseAttachments([file('big.png', 'image/png', bigImage)])).toMatchObject({ ok: false, status: 413 });
    const bigText = Buffer.alloc(LIMITS.textBytes + 1, 0x61);
    expect(parseAttachments([file('big.txt', 'text/plain', bigText)])).toMatchObject({ ok: false, status: 413 });
  });

  it('strips path components and control characters from names', () => {
    const r = parseAttachments([file('../../etc/pass\u0007wd.txt', 'text/plain', Buffer.from('x'))]);
    expect(r.ok && r.attachments[0]!.name).toBe('passwd.txt');
    const r2 = parseAttachments([{ type: 'text/plain', data: b64(Buffer.from('x')), name: 42 }]);
    expect(r2.ok && r2.attachments[0]!.name).toBe('attachment');
  });

  it('sizes the body cap to fit the attachment total after base64', () => {
    expect(MAX_BODY_BYTES).toBeGreaterThan((LIMITS.totalBytes * 4) / 3);
  });
});

describe('mediaNeeds / summarizeAttachments', () => {
  it('reports what a set of attachments needs', () => {
    const r = parseAttachments([file('a.png', 'image/png', PNG), file('n.txt', 'text/plain', Buffer.from('x'))]);
    if (!r.ok) throw new Error('parse failed');
    expect(mediaNeeds(r.attachments)).toEqual({ image: true, pdf: false });
    expect(mediaNeeds([])).toEqual({ image: false, pdf: false });
  });

  it('summarizes by name only — never the body', () => {
    const r = parseAttachments([file('a.png', 'image/png', PNG)]);
    if (!r.ok) throw new Error('parse failed');
    const s = summarizeAttachments(r.attachments);
    expect(s).toBe('[attached: a.png]');
    expect(s).not.toContain(b64(PNG));
    expect(summarizeAttachments([])).toBe('');
  });
});

function fakeReq(body: string, headers: Record<string, string> = {}): IncomingMessage {
  const r = Readable.from([Buffer.from(body)]) as unknown as IncomingMessage;
  (r as unknown as { headers: Record<string, string> }).headers = headers;
  return r;
}

describe('readJsonLimited', () => {
  it('parses a body under the cap', async () => {
    expect(await readJsonLimited(fakeReq('{"a":1}'), 100)).toEqual({ tooLarge: false, body: { a: 1 } });
  });

  it('flags a body over the cap', async () => {
    expect(await readJsonLimited(fakeReq(`{"a":"${'x'.repeat(200)}"}`), 100)).toEqual({ tooLarge: true });
  });

  it('trusts an honest Content-Length to refuse early', async () => {
    expect(await readJsonLimited(fakeReq('{}', { 'content-length': '999999' }), 100)).toEqual({ tooLarge: true });
  });

  it('treats malformed JSON as an empty object', async () => {
    expect(await readJsonLimited(fakeReq('{nope'), 100)).toEqual({ tooLarge: false, body: {} });
  });
});
