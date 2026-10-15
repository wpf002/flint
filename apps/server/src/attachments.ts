import type { IncomingMessage } from 'node:http';
import type { Attachment } from '@flint/core';

/**
 * The attachment boundary: everything a client uploads passes through here
 * before it can reach a model. Deny-by-default, same as the tool gate — a file
 * is accepted only if its BYTES prove it is one of the few types a provider
 * can actually read. The declared MIME type and the filename are hints, never
 * trusted: a `.png` that is really a PDF is a PDF, and an `.exe` renamed to
 * `.txt` fails the UTF-8 check.
 *
 * Wire shape (console → POST /chat or /generate):
 *   attachments: [{ name: "shot.png", type: "image/png", data: "<base64 or data: URL>" }]
 */

/** Hard limits. Sized to what the providers accept, not what a disk holds. */
export const LIMITS = {
  /** Files per message. */
  maxCount: 5,
  /** Per image — Anthropic's own per-image cap. */
  imageBytes: 5 * 1024 * 1024,
  /** Per PDF — well under the 32 MB request cap, leaving room for history. */
  pdfBytes: 20 * 1024 * 1024,
  /** Per text file — ~128k tokens at worst, beyond which it's not a chat attachment. */
  textBytes: 512 * 1024,
  /** All files in one message, decoded. */
  totalBytes: 24 * 1024 * 1024,
} as const;

/**
 * Largest JSON body /chat and /generate will read. Base64 inflates by 4/3; the
 * rest is headroom for the message text and JSON punctuation. Anything bigger
 * is refused with a 413 before it is ever parsed.
 */
export const MAX_BODY_BYTES = Math.ceil((LIMITS.totalBytes * 4) / 3) + 1024 * 1024;

export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;

/** Text-ish types accepted by declared MIME (anything `text/*` is accepted too). */
const TEXT_MIME = new Set([
  'application/json',
  'application/xml',
  'application/x-yaml',
  'application/yaml',
  'application/javascript',
  'application/typescript',
  'application/x-sh',
  'application/sql',
  'application/toml',
  'application/x-ndjson',
]);

/** Extensions accepted as text when the browser sends no (or a generic) MIME type. */
const TEXT_EXT: Record<string, string> = {
  txt: 'text/plain', md: 'text/markdown', markdown: 'text/markdown', csv: 'text/csv', tsv: 'text/tab-separated-values',
  json: 'application/json', jsonl: 'application/x-ndjson', ndjson: 'application/x-ndjson', xml: 'application/xml',
  yaml: 'application/yaml', yml: 'application/yaml', toml: 'application/toml', ini: 'text/plain', log: 'text/plain',
  html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript', mjs: 'text/javascript',
  cjs: 'text/javascript', ts: 'text/x-typescript', tsx: 'text/x-typescript', jsx: 'text/javascript',
  py: 'text/x-python', rb: 'text/x-ruby', go: 'text/x-go', rs: 'text/x-rust', java: 'text/x-java',
  kt: 'text/x-kotlin', swift: 'text/x-swift', c: 'text/x-c', h: 'text/x-c', cpp: 'text/x-c++',
  hpp: 'text/x-c++', cs: 'text/x-csharp', php: 'text/x-php', sh: 'text/x-shellscript', zsh: 'text/x-shellscript',
  bash: 'text/x-shellscript', sql: 'application/sql', env: 'text/plain', conf: 'text/plain', tex: 'text/x-tex',
  srt: 'text/plain', vtt: 'text/vtt', diff: 'text/x-diff', patch: 'text/x-diff',
};

export type ParseResult =
  | { ok: true; attachments: Attachment[] }
  | { ok: false; status: 400 | 413 | 415; error: string };

interface RawAttachment {
  name?: unknown;
  type?: unknown;
  data?: unknown;
}

/**
 * Validate and normalize the `attachments` field of a request body. `undefined`
 * or `[]` is simply "no attachments". Any single bad file fails the whole
 * request with a message naming it — better than silently answering about the
 * other four and leaving the user to wonder why the fifth was ignored.
 */
export function parseAttachments(raw: unknown): ParseResult {
  if (raw === undefined || raw === null) return { ok: true, attachments: [] };
  if (!Array.isArray(raw)) return { ok: false, status: 400, error: 'attachments must be an array' };
  if (raw.length === 0) return { ok: true, attachments: [] };
  if (raw.length > LIMITS.maxCount) {
    return { ok: false, status: 413, error: `too many attachments (${raw.length}); the limit is ${LIMITS.maxCount}` };
  }

  const out: Attachment[] = [];
  let total = 0;
  for (const item of raw as RawAttachment[]) {
    if (!item || typeof item !== 'object') return { ok: false, status: 400, error: 'each attachment must be an object' };
    const name = cleanName(item.name);
    const declared = typeof item.type === 'string' ? item.type.trim().toLowerCase().split(';')[0]! : '';
    if (typeof item.data !== 'string' || item.data.length === 0) {
      return { ok: false, status: 400, error: `${name}: no file data` };
    }
    const b64 = stripDataUrl(item.data);
    if (!isBase64(b64)) return { ok: false, status: 400, error: `${name}: data is not valid base64` };
    const bytes = Buffer.from(b64, 'base64');
    if (bytes.length === 0) return { ok: false, status: 400, error: `${name}: file is empty` };
    total += bytes.length;
    if (total > LIMITS.totalBytes) {
      return { ok: false, status: 413, error: `attachments total more than ${mb(LIMITS.totalBytes)}` };
    }

    const res = classify(name, declared, bytes, b64);
    if (!res.ok) return res;
    out.push(res.attachment);
  }
  return { ok: true, attachments: out };
}

type Classified = { ok: true; attachment: Attachment } | { ok: false; status: 400 | 413 | 415; error: string };

function classify(name: string, declared: string, bytes: Buffer, b64: string): Classified {
  let sniffed = sniff(bytes);
  // A text file can hold the characters `%PDF-` near its start (notes about PDFs, a script that writes one) without
  // being one. A PDF's header is at the very start of the file; readers also take one within the first kilobyte,
  // and so does `sniff`. So when the header is NOT at the start, and the file was sent as text and reads as text,
  // it is the text file it says it is. (It used to be taken for a PDF, and was then told it had no text in it.)
  if (sniffed === 'application/pdf' && !startsAsPdf(bytes) && textMediaType(name, declared) !== undefined && decodeUtf8(bytes) !== undefined) sniffed = undefined;

  if (sniffed === 'application/pdf') {
    if (bytes.length > LIMITS.pdfBytes) return tooBig(name, LIMITS.pdfBytes);
    return { ok: true, attachment: { kind: 'document', mediaType: 'application/pdf', name, data: b64, bytes: bytes.length } };
  }
  if (sniffed) {
    if (bytes.length > LIMITS.imageBytes) return tooBig(name, LIMITS.imageBytes);
    return { ok: true, attachment: { kind: 'image', mediaType: sniffed, name, data: b64, bytes: bytes.length } };
  }

  // Not a recognised binary. It claims to be an image/PDF → it's lying or it's
  // a format no provider reads (HEIC, TIFF, SVG-as-image …). Say which.
  if (declared.startsWith('image/') || declared === 'application/pdf') {
    return {
      ok: false,
      status: 415,
      error: `${name}: ${declared} isn't supported — send PNG, JPEG, GIF, WebP or PDF`,
    };
  }

  const textType = textMediaType(name, declared);
  if (!textType) {
    return {
      ok: false,
      status: 415,
      error: `${name}: unsupported file type${declared ? ` (${declared})` : ''} — images, PDFs and text files only`,
    };
  }
  if (bytes.length > LIMITS.textBytes) return tooBig(name, LIMITS.textBytes);
  const text = decodeUtf8(bytes);
  if (text === undefined) return { ok: false, status: 415, error: `${name}: not a UTF-8 text file` };
  return { ok: true, attachment: { kind: 'text', mediaType: textType, name, text, bytes: bytes.length } };
}

/** Identify a file by its magic bytes. Only the formats providers accept. */
export function sniff(b: Buffer): (typeof IMAGE_TYPES)[number] | 'application/pdf' | undefined {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6 && b.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') {
    return 'image/webp';
  }
  // %PDF- may be preceded by a little junk; the spec allows it within the first 1 KB.
  if (b.subarray(0, 1024).toString('latin1').includes('%PDF-')) return 'application/pdf';
  return undefined;
}

/** Is the PDF header at the very start of the file (after, at most, a byte-order mark and blank space)? */
export function startsAsPdf(b: Buffer): boolean {
  let at = b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf ? 3 : 0;
  while (at < b.length && at < 64 && (b[at] === 0x20 || b[at] === 0x09 || b[at] === 0x0a || b[at] === 0x0d)) at++;
  return b.subarray(at, at + 5).toString('latin1') === '%PDF-';
}

function textMediaType(name: string, declared: string): string | undefined {
  if (declared.startsWith('text/')) return declared;
  if (TEXT_MIME.has(declared)) return declared;
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  // Browsers send '' or application/octet-stream for many code files.
  if ((declared === '' || declared === 'application/octet-stream') && TEXT_EXT[ext]) return TEXT_EXT[ext];
  return undefined;
}

/** Strict UTF-8 decode; undefined on invalid bytes or on NULs (a binary in disguise). */
function decodeUtf8(bytes: Buffer): string | undefined {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (text.includes('\u0000')) return undefined;
    return text.replace(/^﻿/, '');
  } catch {
    return undefined;
  }
}

function stripDataUrl(s: string): string {
  const m = /^data:[^,]*;base64,/i.exec(s);
  return (m ? s.slice(m[0].length) : s).replace(/\s+/g, '');
}

function isBase64(s: string): boolean {
  return s.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(s);
}

function cleanName(raw: unknown): string {
  const s = typeof raw === 'string' ? raw : '';
  // Path components and control characters are never part of a name the model needs.
  const base = s.split(/[\\/]/).pop() ?? '';
  const clean = base.replace(/[\u0000-\u001f\u007f<>"]/g, '').trim().slice(0, 120);
  return clean || 'attachment';
}

function tooBig(name: string, limit: number): Classified {
  return { ok: false, status: 413, error: sizeSentence(name, limit) };
}

/** The sentence for a file that is too large: its name, and the limit. */
export function sizeSentence(name: string, limit: number): string {
  return `${name}: larger than the ${mb(limit)} limit`;
}

/** The sentence for a PDF too large for every cloud model that would be asked (pdfTooBigFor): what they can read, not the door's limit. */
export function cloudSizeSentence(name: string, limit: number): string {
  return `${name}: larger than the ${mb(limit)} the cloud model can read`;
}

/**
 * The refusal for such a PDF: the cloud's size, and, when this Mac tried it
 * first and could not read it, why (a Hybrid turn: a PDF too long to read here
 * was told only that it was too large for the cloud). `hereClause` is
 * ./policy pdfUnreadClause's words for that.
 */
export function tooBigSentence(big: { name: string; limit: number }, hereClause?: string): string {
  return hereClause ? `${cloudSizeSentence(big.name, big.limit)}, and ${hereClause}` : cloudSizeSentence(big.name, big.limit);
}

/**
 * The largest PDF, in bytes, that a model with this window can be handed, by
 * the count every prompt is sized with (@flint/core estimateAttachmentTokens:
 * 2,000 tokens for each 50 KB). The window less the room kept for the reply;
 * the system prompt and the tools are not taken off, so this errs on the side
 * of letting a PDF through.
 */
export function pdfBytesThatFit(caps: { maxContextTokens: number; maxOutputTokens: number }): number {
  return Math.max(0, Math.floor((caps.maxContextTokens - caps.maxOutputTokens) / 2000)) * 50_000;
}

/**
 * The first PDF among a turn's files that is too large for EVERY one of the
 * models that would be asked, with the most any of them takes; undefined when
 * each PDF fits at least one. Such a PDF used to be sent on anyway: the message
 * that carried it was dropped to make the prompt fit, and the model was sent
 * `"messages": []`. It is refused at the door instead, with the size sentence.
 */
export function pdfTooBigFor(attachments: readonly Attachment[], models: ReadonlyArray<{ maxContextTokens: number; maxOutputTokens: number }>): { name: string; limit: number } | undefined {
  if (models.length === 0) return undefined;
  const limit = Math.max(...models.map(pdfBytesThatFit));
  const big = attachments.find((a) => a.kind === 'document' && typeof a.data === 'string' && Math.floor((a.data.length * 3) / 4) > limit);
  return big ? { name: big.name ?? 'attachment', limit } : undefined;
}

/** "20 MB", "3.4 MB", "512 KB": rounded down, so a file under the figure said is never refused. */
function mb(n: number): string {
  if (n < 1024 * 1024) return `${Math.floor(n / 1024)} KB`;
  const m = n / (1024 * 1024);
  return m >= 10 ? `${Math.floor(m)} MB` : `${Math.floor(m * 10) / 10} MB`;
}

/** What a set of attachments demands of the model that reads it. */
export interface MediaNeeds {
  image: boolean;
  pdf: boolean;
}

export function mediaNeeds(attachments: Attachment[]): MediaNeeds {
  return {
    image: attachments.some((a) => a.kind === 'image'),
    pdf: attachments.some((a) => a.kind === 'document'),
  };
}

/** How many characters of text files a turn carries: part of how long its prompt is (the hybrid rules' long-context test). */
export function textChars(attachments: Attachment[]): number {
  return attachments.reduce((n, a) => n + (a.kind === 'text' ? a.text?.length ?? 0 : 0), 0);
}

/**
 * A one-line, body-free summary for logs, the Action Log and the training
 * corpus — which must never carry a base64 blob or a pasted file.
 */
export function summarizeAttachments(attachments: Attachment[]): string {
  if (attachments.length === 0) return '';
  return `[attached: ${attachments.map((a) => a.name ?? a.mediaType).join(', ')}]`;
}

/**
 * Read a JSON body with a size cap. Over the cap → `tooLarge` (the rest of the
 * body is drained, not buffered). Malformed JSON → `{}`, matching the
 * permissive reader the other endpoints use.
 */
export function readJsonLimited(
  req: IncomingMessage,
  maxBytes: number,
): Promise<{ tooLarge: true } | { tooLarge: false; body: Record<string, unknown> }> {
  return new Promise((resolve) => {
    const declared = Number(req.headers['content-length'] ?? NaN);
    let size = 0;
    let over = Number.isFinite(declared) && declared > maxBytes;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer | string) => {
      const buf = typeof c === 'string' ? Buffer.from(c) : c;
      size += buf.length;
      if (size > maxBytes) over = true;
      if (!over) chunks.push(buf);
    });
    req.on('end', () => {
      if (over) return resolve({ tooLarge: true });
      const data = Buffer.concat(chunks).toString('utf8');
      try {
        const parsed = data ? (JSON.parse(data) as unknown) : {};
        resolve({ tooLarge: false, body: parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {} });
      } catch {
        resolve({ tooLarge: false, body: {} });
      }
    });
    req.on('error', () => resolve({ tooLarge: false, body: {} }));
  });
}
