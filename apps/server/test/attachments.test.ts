import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import {
  parseAttachments,
  sniff,
  mediaNeeds,
  summarizeAttachments,
  textChars,
  readJsonLimited,
  pdfBytesThatFit,
  pdfTooBigFor,
  cloudSizeSentence, sizeSentence, tooBigSentence,
  startsAsPdf,
  LIMITS,
  MAX_BODY_BYTES,
} from '../src/attachments';
import { OllamaProvider, type Attachment } from '@flint/core';
import { pdfUnreadClause } from '../src/policy';

/** How @flint/core counts one file toward a prompt: what every adapter sizes a message with. */
const estimateAttachmentTokens = (a: Attachment): number => new OllamaProvider().estimateTokens([{ id: 'u', role: 'user', content: '', timestamp: 0, attachments: [a] }], 'm');

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

// A text file that MENTIONS a PDF's header is a text file. It used to be taken for a PDF (the header was looked
// for anywhere in the first kilobyte), and in Local mode was then told "This PDF has no text in it".
describe('a text file that holds the characters %PDF- near its start', () => {
  const NOTES = Buffer.from('my notes about the %PDF- header\nline two NOTPDFQ10\n');
  const kindOf = (name: string, type: string, bytes: Buffer): string => {
    const r = parseAttachments([file(name, type, bytes)]);
    return r.ok ? `${r.attachments[0]!.kind} ${r.attachments[0]!.mediaType}` : `refused ${r.status}`;
  };

  it('sent as text, and reading as text, it is the text file it says it is', () => {
    expect(kindOf('notes.txt', 'text/plain', NOTES)).toBe('text text/plain');
    expect(kindOf('notes.md', '', NOTES)).toBe('text text/markdown');
    expect(kindOf('make-pdf.py', 'application/octet-stream', Buffer.from('#!/usr/bin/env python3\nout.write(b"%PDF-1.4\\n")\n'))).toBe('text text/x-python');
    const r = parseAttachments([file('notes.txt', 'text/plain', NOTES)]);
    expect(r.ok && r.attachments[0]!.text).toContain('NOTPDFQ10');
    expect(mediaNeeds(r.ok ? r.attachments : [])).toEqual({ image: false, pdf: false });
  });

  it('a PDF is still a PDF: at the start of the file whatever it is called, and after a little junk when it is not sent as text', () => {
    expect(kindOf('plan.pdf', 'application/pdf', PDF)).toBe('document application/pdf');
    // Called a text file, and it starts as a PDF: the bytes win, as ever.
    expect(kindOf('plan.txt', 'text/plain', PDF)).toBe('document application/pdf');
    expect(kindOf('plan.txt', 'text/plain', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('\n  '), PDF]))).toBe('document application/pdf');
    // A PDF with junk before its header, sent as a PDF or as nothing in particular: taken as one, as before.
    const junk = Buffer.concat([Buffer.from('MIME-junk-before-the-header\n'), PDF]);
    expect(kindOf('plan.pdf', 'application/pdf', junk)).toBe('document application/pdf');
    expect(kindOf('plan.bin', 'application/octet-stream', junk)).toBe('document application/pdf');
    // ...and one that is binary inside is not a text file, whatever it is called: it is the PDF its bytes say.
    const binary = Buffer.concat([Buffer.from('junk\n'), PDF, Buffer.from([0x00, 0xff, 0xfe, 0x80])]);
    expect(kindOf('plan.txt', 'text/plain', binary)).toBe('document application/pdf');
  });

  it('where a PDF starts: the header first, after at most a byte-order mark and blank space', () => {
    expect(startsAsPdf(PDF)).toBe(true);
    expect(startsAsPdf(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), PDF]))).toBe(true);
    expect(startsAsPdf(Buffer.concat([Buffer.from(' \r\n\t'), PDF]))).toBe(true);
    expect(startsAsPdf(NOTES)).toBe(false);
    expect(startsAsPdf(Buffer.concat([Buffer.from('x'), PDF]))).toBe(false);
    expect(startsAsPdf(Buffer.alloc(0))).toBe(false);
  });
});

// A PDF that no model that would be asked can take used to be sent on with no message at all: the one message
// that carried it was dropped to make the prompt fit. It is refused at the door instead.
describe('a PDF too large for the model that would answer', () => {
  const pdfOf = (bytes: number, name = 'report.pdf'): Attachment => ({ kind: 'document', mediaType: 'application/pdf', name, data: 'A'.repeat(Math.ceil((bytes * 4) / 3)), bytes });
  const SONNET = { maxContextTokens: 200_000, maxOutputTokens: 64_000 };
  const OPUS = { maxContextTokens: 200_000, maxOutputTokens: 32_000 };

  it('the most a model can take is its window, less the room for its reply, by the count every prompt is sized with', () => {
    expect(pdfBytesThatFit(SONNET)).toBe(68 * 50_000);
    expect(pdfBytesThatFit(OPUS)).toBe(84 * 50_000);
    expect(pdfBytesThatFit({ maxContextTokens: 1000, maxOutputTokens: 4000 })).toBe(0);
    // It agrees with the count itself: a PDF at the limit is counted as the whole budget, and one byte more as over it.
    const at = pdfOf(pdfBytesThatFit(SONNET));
    expect(estimateAttachmentTokens(at)).toBeLessThanOrEqual(SONNET.maxContextTokens - SONNET.maxOutputTokens);
    expect(estimateAttachmentTokens(pdfOf(pdfBytesThatFit(SONNET) + 60_000))).toBeGreaterThan(SONNET.maxContextTokens - SONNET.maxOutputTokens);
  });

  it('a PDF is too large only when it fits NONE of the models that would be asked; the limit named is the most any of them takes', () => {
    const tenMb = pdfOf(10 * 1024 * 1024, 'NAMEQ1.pdf');
    expect(pdfTooBigFor([tenMb], [SONNET])).toEqual({ name: 'NAMEQ1.pdf', limit: 3_400_000, pdf: tenMb });
    expect(pdfTooBigFor([pdfOf(1_000), tenMb], [SONNET, OPUS])).toEqual({ name: 'NAMEQ1.pdf', limit: 4_200_000, pdf: tenMb });
    const fourMb = pdfOf(4_000_000);
    expect(pdfTooBigFor([fourMb], [SONNET])).toEqual({ name: 'report.pdf', limit: 3_400_000, pdf: fourMb });
    expect(pdfTooBigFor([fourMb], [SONNET, OPUS])).toBeUndefined();
    expect(pdfTooBigFor([pdfOf(1_000_000)], [SONNET])).toBeUndefined();
    // Pictures and text files are not PDFs, and no models means nothing to be too large for.
    expect(pdfTooBigFor([{ kind: 'image', mediaType: 'image/png', name: 'a.png', data: 'A'.repeat(6_000_000), bytes: 4_500_000 }], [SONNET])).toBeUndefined();
    expect(pdfTooBigFor([tenMb], [])).toBeUndefined();
    expect(pdfTooBigFor([], [SONNET])).toBeUndefined();
  });

  it('the size sentence is the one the door has always said; a PDF too large for the cloud says what the cloud reads', () => {
    expect(sizeSentence('NAMEQ1.pdf', 20 * 1024 * 1024)).toBe('NAMEQ1.pdf: larger than the 20 MB limit');
    // Rounded down, to a tenth under 10 MB: a 3.3 MB PDF is never told it is larger than "3 MB" (it was).
    expect(cloudSizeSentence('NAMEQ1.pdf', 3_550_000)).toBe('NAMEQ1.pdf: larger than the 3.3 MB the cloud model can read');
    expect(cloudSizeSentence('a.pdf', 512 * 1024)).toBe('a.pdf: larger than the 512 KB the cloud model can read');
    // Tried here first and not read (Hybrid): both reasons, in one sentence.
    expect(tooBigSentence({ name: 'long.pdf', limit: 3_550_000 }, pdfUnreadClause('too_long'))).toBe('long.pdf: larger than the 3.3 MB the cloud model can read, and this PDF looks like it has more than the 1,000 pages Flint reads on this Mac');
    expect(tooBigSentence({ name: 'a.pdf', limit: 3_550_000 })).toBe('a.pdf: larger than the 3.3 MB the cloud model can read');
    const r = parseAttachments([file('big.png', 'image/png', Buffer.concat([PNG, Buffer.alloc(LIMITS.imageBytes)]))]);
    expect(!r.ok && r.error).toBe(sizeSentence('big.png', LIMITS.imageBytes));
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

describe('textChars', () => {
  it('counts the text files a turn carries, and nothing else', () => {
    expect(textChars([])).toBe(0);
    expect(
      textChars([
        { kind: 'text', mediaType: 'text/plain', name: 'a.txt', text: 'x'.repeat(1200) },
        { kind: 'text', mediaType: 'text/markdown', name: 'b.md', text: 'y'.repeat(300) },
        { kind: 'image', mediaType: 'image/png', name: 'c.png', data: 'A'.repeat(9000) },
        { kind: 'document', mediaType: 'application/pdf', name: 'd.pdf', data: 'B'.repeat(9000) },
        { kind: 'text', mediaType: 'text/plain', name: 'shed.txt' },
      ]),
    ).toBe(1500);
  });
});
