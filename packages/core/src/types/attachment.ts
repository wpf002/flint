import { z } from 'zod';

/**
 * A file the user attached to a message — Flint's own shape, never a provider's.
 *
 *  - `image`    — a picture (png / jpeg / gif / webp). `data` is base64.
 *  - `document` — a PDF. `data` is base64.
 *  - `text`     — a plain-text file (code, markdown, csv, json …). `text` is the
 *                 decoded UTF-8 body; there is no binary form to carry.
 *
 * The payload is OPTIONAL on purpose. Stores drop it once a turn is old enough
 * that replaying a multi-megabyte image on every later turn would cost more than
 * it's worth; the metadata stays, and every adapter renders a payload-less
 * attachment as a short note ("[attached earlier: plan.pdf …]") so the model
 * still knows something was there. Validation of size and type is the
 * boundary's job (the server), not this schema's — core only guarantees shape.
 */
export const AttachmentKind = z.enum(['image', 'document', 'text']);
export type AttachmentKind = z.infer<typeof AttachmentKind>;

export const AttachmentSchema = z.object({
  kind: AttachmentKind,
  /** IANA media type, e.g. `image/png`, `application/pdf`, `text/markdown`. */
  mediaType: z.string().min(1),
  /** The original filename, for the model's benefit and for the UI. */
  name: z.string().optional(),
  /** Base64 body for `image` / `document`. Absent once a store has shed it. */
  data: z.string().optional(),
  /** Decoded UTF-8 body for `text`. Absent once a store has shed it. */
  text: z.string().optional(),
  /** Size of the original file in bytes (informational — kept after the body is shed). */
  bytes: z.number().int().nonnegative().optional(),
});

export type Attachment = z.infer<typeof AttachmentSchema>;

/** True when the attachment still carries its body. */
export function hasPayload(a: Attachment): boolean {
  return a.kind === 'text' ? typeof a.text === 'string' : typeof a.data === 'string' && a.data.length > 0;
}

/** True for attachments only a vision / document-capable model can read. */
export function needsVision(a: Attachment): boolean {
  return a.kind === 'image' || a.kind === 'document';
}

/** A short human-readable label: `plan.pdf (application/pdf, 1.2 MB)`. */
export function describeAttachment(a: Attachment): string {
  const size = a.bytes !== undefined ? `, ${formatBytes(a.bytes)}` : '';
  return `${a.name ?? 'unnamed'} (${a.mediaType}${size})`;
}

/**
 * What an adapter sends in place of an attachment it cannot deliver natively —
 * either because the body was shed from history, or because the target model
 * cannot read that kind of file. Never silently drop: the model must know.
 */
export function attachmentNote(a: Attachment, reason: 'shed' | 'unsupported'): string {
  return reason === 'shed'
    ? `[attached earlier: ${describeAttachment(a)} — the file itself is no longer in context]`
    : `[attached: ${describeAttachment(a)} — this model cannot read ${a.kind === 'image' ? 'images' : 'this file type'}]`;
}

/** Render a text attachment inline, fenced so it can't be confused with the user's own words. */
export function renderTextAttachment(a: Attachment): string {
  return `<attached_file name="${(a.name ?? 'unnamed').replace(/"/g, "'")}" type="${a.mediaType}">\n${a.text ?? ''}\n</attached_file>`;
}

/** Drop the body from an attachment, keeping what it was. */
export function shedPayload(a: Attachment): Attachment {
  const { data: _d, text: _t, ...meta } = a;
  return meta;
}

/**
 * Rough input-token cost of an attachment, for context budgeting only. Images
 * bill by pixels (~1.6k tokens for a typical photo, capped by provider-side
 * resizing); PDFs bill per page as text + an image of the page. Neither can be
 * known without decoding, so these are deliberately pessimistic constants.
 */
export function estimateAttachmentTokens(a: Attachment): number {
  if (!hasPayload(a)) return 30;
  if (a.kind === 'text') return Math.ceil((a.text?.length ?? 0) / 4);
  if (a.kind === 'image') return 1600;
  // ~3 base64 chars per 2.25 raw bytes; assume ~50 KB and ~2k tokens per page.
  const raw = Math.floor(((a.data?.length ?? 0) * 3) / 4);
  return Math.max(2000, Math.ceil(raw / 50_000) * 2000);
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
