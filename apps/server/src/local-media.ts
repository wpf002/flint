/**
 * Pictures and PDFs for the local model: what it can be handed, and how a
 * PDF's text gets to it.
 *
 * A PICTURE needs nothing from here: a local model its server says can see is
 * sent the picture by its own adapter (@flint/core; on Ollama's own wire with
 * FLINT_LOCAL_VISION=on, ./local-brains).
 *
 * A PDF no local model reads. With FLINT_LOCAL_PDF set, a program on this Mac
 * reads its text (./pdf-text), and the local model's adapter is wrapped here
 * (`provider`): each PDF on a message is replaced, for that one request, by
 * its text as a text file the model reads like any other. So:
 *  - only a LOCAL adapter is ever wrapped, and the text exists only inside its
 *    request. The stored turn keeps the PDF as it was sent, an outside model
 *    is handed the PDF itself or nothing, as before, and the text is never
 *    logged, embedded or saved;
 *  - the text is sized to the model's window (`PDF_SHARE` of it for one
 *    message, and never more than `MAX_PDF_CHARS`), and a PDF that does not
 *    fit is cut with a line that says how much of it the model was given;
 *  - a PDF with no text (a scan), or one the program could not read, is left
 *    as it was: the adapter then tells the model a file it cannot read was
 *    attached, as it always did. The route does not let it get that far for a
 *    new turn (`reads`: such a turn is refused with a sentence, or goes to a
 *    cloud model that reads PDFs when it may); it is what an earlier turn's
 *    PDF in the history comes to;
 *  - NOTHING OF A FILE GOES TO A SERVER THAT IS NOT THIS MAC. The wrapper asks
 *    (`filesStayHere`) each time: when the local model server is on another
 *    machine that Will has not vouched for, reached through a proxy, or its
 *    model is one that runs on Ollama's servers, no PDF becomes text, on an
 *    ordinary turn as much as a private one, and the wrapper does not say it
 *    reads PDFs;
 *  - THE LOOK AT THE MODEL SERVER IS THE LAST THING BEFORE THE REQUEST. A turn
 *    that stays here is decided on what the model server said a moment ago
 *    (./inference routeFirst). A PDF is read before that look (the route reads
 *    this turn's, and the history's), so the request finds every read kept
 *    and waits for nothing. If it does have to wait (a read that was not
 *    kept), and the wait is longer than the server's word is good for, the
 *    server is asked again before anything is sent (`lookAgain`), and the
 *    request is not made if the answer has changed.
 *
 * A read is kept for a while, by the PDF's contents (a SHA-256 of its bytes,
 * in memory only): the route reads a turn's PDFs once, before it decides who
 * answers, and the request finds them read.
 *
 * Kept free of index.ts so it is unit-testable (index.ts runs main() on import).
 */
import { createHash } from 'node:crypto';
import { isFlintError, makeAiError, type Attachment, type GenerateArgs, type Message, type ProviderAdapter } from '@flint/core';
import { FRESH_MS } from './ollama-locality';
import type { PdfReader, PdfText } from './pdf-text';

/** The share of a model's window one message's PDFs may take, as text. The rest is the reply, the system prompt, the tools and the history. */
export const PDF_SHARE = 0.35;
/** Characters to a token, as @flint/core estimates text (estimateAttachmentTokens). */
const CHARS_PER_TOKEN = 4;
/** The least text a PDF is given, however small the window: a cut that leaves nothing is not a read. */
export const MIN_PDF_CHARS = 2_000;
/**
 * ...and the most, however large the window. A local model reads a prompt before it says a word, and a turn
 * waits only so long for that first word (FLINT_LOCAL_FIRST_OUTPUT_TIMEOUT_MS, twenty seconds unless set). On
 * this Mac the main model read 22,936 characters of a PDF (6,108 tokens) in about ten seconds; 32,000 is about
 * fourteen. Past that a larger window would buy a PDF turn that times out.
 */
export const MAX_PDF_CHARS = 32_000;
/** How many reads are kept, and how much text in all. The oldest goes first. */
export const KEPT_READS = 16;
export const KEPT_CHARS = 4_000_000;

/** Is this attachment a PDF that still carries its bytes? (The attachment boundary makes a `document` only of a PDF: ./attachments.) */
export function isPdf(a: Attachment): boolean {
  return a.kind === 'document' && a.mediaType === 'application/pdf' && typeof a.data === 'string' && a.data.length > 0;
}

/** How much text one message's PDFs may come to, for a model with this window. */
export function pdfChars(windowTokens: number): number {
  return Math.min(MAX_PDF_CHARS, Math.max(MIN_PDF_CHARS, Math.floor(windowTokens * PDF_SHARE) * CHARS_PER_TOKEN));
}

/** The line a PDF's text begins with: what the model is reading, and how much of it. */
export function pdfHeading(read: Extract<PdfText, { ok: true }>, given: number): string {
  const pages = read.pages === undefined ? '' : read.pages === 1 ? ', which has 1 page' : `, which has ${read.pages} pages`;
  const all = given >= read.text.length && !read.cut;
  const part = all
    ? ''
    : read.cut
      ? ` Only its first ${given.toLocaleString('en-US')} characters are below, and the rest was left out.`
      : ` Only the first ${given.toLocaleString('en-US')} of its ${read.text.length.toLocaleString('en-US')} characters are below, and the rest was left out.`;
  return `[This is the text of the PDF${pages}, read on this Mac. Its pictures and its layout are not here.${part}]`;
}

/** A PDF as the text file the model is handed: its name kept, its text under the heading, `allow` characters of it at most. */
export function asTextFile(a: Attachment, read: Extract<PdfText, { ok: true }>, allow: number): Attachment {
  const given = Math.min(read.text.length, Math.max(0, Math.floor(allow)));
  return {
    kind: 'text',
    mediaType: 'text/plain',
    ...(a.name !== undefined ? { name: a.name } : {}),
    text: `${pdfHeading(read, given)}\n\n${read.text.slice(0, given)}`,
    ...(a.bytes !== undefined ? { bytes: a.bytes } : {}),
  };
}

/**
 * A message with each PDF that has been read replaced by its text, within
 * `budget` characters for the message's PDFs together (shared out evenly, and
 * what a short one leaves goes to the next). A PDF `known` has no read for is
 * left as it is. The same object when nothing changes.
 */
export function withPdfText(m: Message, known: (a: Attachment) => PdfText | undefined, budget: number): Message {
  const list = m.attachments;
  if (!list || !list.some(isPdf)) return m;
  const reads = list.map((a) => (isPdf(a) ? known(a) : undefined));
  let left = reads.filter((r) => r?.ok).length;
  if (left === 0) return m;
  let remaining = budget;
  const attachments = list.map((a, i) => {
    const r = reads[i];
    if (!r || !r.ok) return a;
    const file = asTextFile(a, r, Math.floor(remaining / left));
    remaining -= Math.min(r.text.length, Math.floor(remaining / left));
    left--;
    return file;
  });
  return { ...m, attachments };
}

/** What a request that was not made says, when nothing more particular is known. */
export const NOT_SENT = 'Flint could not confirm that its local model runs on this Mac, so nothing was sent to it.';

export interface LocalMedia {
  /** Which program reads a PDF here. */
  readonly reader: PdfReader['kind'];
  /** A PDF attachment's text, read once and kept. Never rejects. */
  text(a: Attachment, signal?: AbortSignal): Promise<PdfText>;
  /** Can every PDF among these be read here? Reads them (and keeps the reads). True when there is none. */
  reads(attachments: readonly Attachment[], signal?: AbortSignal): Promise<boolean>;
  /**
   * How many characters of text these files' PDFs come to for a model with this window, as it would be handed
   * them: what has been read, cut as a message's PDFs are cut. A PDF that has not been read counts for nothing.
   */
  chars(attachments: readonly Attachment[], windowTokens: number): number;
  /** A local model's adapter that is handed a PDF as its text. */
  provider(inner: ProviderAdapter, o?: WrapOptions): ProviderAdapter;
  /** Why the first of these PDFs that was read here could not be, from what is kept: nothing is read for this. */
  refused(attachments: readonly Attachment[]): Exclude<PdfText, { ok: true }>['why'] | undefined;
}

/** What the wrapper asks of whoever knows where the adapter's server is (./inference). */
export interface WrapOptions {
  /**
   * May a file's content be handed to this adapter's server right now: is it
   * this Mac, or the one server Will vouched for? Asked for every request.
   * Left out: yes (a test, a caller with one server it knows is here).
   */
  filesStayHere?: () => boolean;
  /**
   * The request had to wait for a read for longer than the model server's
   * word is good for: ask the server again, and THROW if this turn may no
   * longer be sent to this model. Left out: nothing is asked.
   */
  lookAgain?: (inner: ProviderAdapter, model: string) => Promise<void>;
  /** How long a wait may be before the server is asked again. Default: as long as its word is good for (./ollama-locality FRESH_MS). */
  freshMs?: number;
  now?: () => number;
}

/** The PDF reading for the local model, around one reader. */
export function localMedia(reader: PdfReader, opts: { kept?: number; keptChars?: number } = {}): LocalMedia {
  const most = opts.kept ?? KEPT_READS;
  const mostChars = opts.keptChars ?? KEPT_CHARS;
  /** Reads by the PDF's digest, oldest first (a Map keeps the order things were set in). */
  const kept = new Map<string, PdfText>();
  const under = new Map<string, Promise<PdfText>>();
  /** An attachment's digest, worked out once for the object: a PDF can be 20 MB, and a turn asks many times. */
  const digests = new WeakMap<Attachment, string>();
  const digestOf = (a: Attachment): string => {
    let d = digests.get(a);
    if (d === undefined) {
      d = createHash('sha256').update(a.data ?? '', 'latin1').digest('hex');
      digests.set(a, d);
    }
    return d;
  };
  const charsOf = (r: PdfText): number => (r.ok ? r.text.length : 0);
  const keep = (d: string, r: PdfText): void => {
    kept.delete(d);
    kept.set(d, r);
    let total = 0;
    for (const v of kept.values()) total += charsOf(v);
    for (const k of kept.keys()) {
      if (kept.size <= most && total <= mostChars) break;
      if (k === d) continue; // the read just made is the one being asked for
      total -= charsOf(kept.get(k)!);
      kept.delete(k);
    }
  };
  const known = (a: Attachment): PdfText | undefined => (isPdf(a) ? kept.get(digestOf(a)) : undefined);

  const text = (a: Attachment, signal?: AbortSignal): Promise<PdfText> => {
    if (!isPdf(a)) return Promise.resolve({ ok: false, why: 'failed' });
    const d = digestOf(a);
    const have = kept.get(d);
    if (have) {
      keep(d, have); // asked for again: the newest once more
      return Promise.resolve(have);
    }
    const running = under.get(d);
    if (running) return running;
    const p = reader
      .read(Buffer.from(a.data!, 'base64'), signal)
      .catch((): PdfText => ({ ok: false, why: 'failed' }))
      .then((r) => {
        under.delete(d);
        // What a PDF is does not change: its text, that it has none, that it is too big or too long, is kept. A
        // read that did not work, or was told the reader is busy, is tried again.
        if (r.ok || r.why === 'no_text' || r.why === 'too_big' || r.why === 'too_long') keep(d, r);
        return r;
      });
    under.set(d, p);
    return p;
  };

  const swapped = async (args: GenerateArgs, inner: ProviderAdapter, o: WrapOptions): Promise<GenerateArgs> => {
    const pdfs = args.messages.flatMap((m) => (m.attachments ?? []).filter(isPdf));
    if (pdfs.length === 0) return args;
    // A server that is not this Mac is handed no file's text: the PDFs stay PDFs, which its adapter cannot send.
    if (o.filesStayHere && !o.filesStayHere()) return args;
    const now = o.now ?? Date.now;
    const began = now();
    await Promise.all(pdfs.map((a) => text(a, args.signal)));
    if (now() - began > (o.freshMs ?? FRESH_MS)) {
      // The wait outlasted what the model server last said of where its models run: it is asked again, now, and
      // this throws if the turn may no longer go to this model. Nothing has been sent yet.
      await o.lookAgain?.(inner, args.model);
      if (o.filesStayHere && !o.filesStayHere()) return args;
    }
    const budget = pdfChars(inner.getCapabilities(args.model).maxContextTokens);
    return { ...args, messages: args.messages.map((m) => withPdfText(m, known, budget)) };
  };

  return {
    reader: reader.kind,
    text,
    async reads(attachments, signal) {
      const pdfs = attachments.filter(isPdf);
      if (pdfs.length === 0) return true;
      return (await Promise.all(pdfs.map((a) => text(a, signal)))).every((r) => r.ok);
    },
    refused(attachments) {
      for (const a of attachments) {
        const r = known(a);
        if (r && !r.ok) return r.why;
      }
      return undefined;
    },
    chars(attachments, windowTokens) {
      if (!attachments.some(isPdf)) return 0;
      const as = withPdfText({ id: 'size', role: 'user', content: '', timestamp: 0, attachments: [...attachments] }, known, pdfChars(windowTokens));
      return (as.attachments ?? []).reduce((n, a, i) => n + (a !== attachments[i] && a.kind === 'text' ? (a.text?.length ?? 0) : 0), 0);
    },
    provider(inner, o = {}) {
      // Where the adapter's server is, and the window it asks for, stay readable through the wrapper: ./policy
      // brainOf reads them to tell a model on this Mac from one elsewhere (brainIsLocal).
      const { baseURL, numCtx } = inner as { readonly baseURL?: unknown; readonly numCtx?: unknown };
      return {
        name: inner.name,
        ...(typeof baseURL === 'string' ? { baseURL } : {}),
        ...(typeof numCtx === 'number' ? { numCtx } : {}),
        // (It reads PDFs only while their text may be handed to its server.)
        getCapabilities: (model) => (!o.filesStayHere || o.filesStayHere() ? { ...inner.getCapabilities(model), pdfInput: true } : inner.getCapabilities(model)),
        // Sized as it will be sent: a PDF that has been read counts as its text. One that has not been read yet
        // counts as the most it may come to, so nothing is planned on a guess that turns out too small.
        estimateTokens: (messages, model) => {
          if (!messages.some((m) => m.attachments?.some(isPdf))) return inner.estimateTokens(messages, model);
          const budget = pdfChars(inner.getCapabilities(model).maxContextTokens);
          let unread = 0;
          const sized = messages.map((m) => {
            const list = m.attachments;
            if (!list || !list.some(isPdf)) return m;
            const missing = list.filter((a) => isPdf(a) && known(a) === undefined);
            if (missing.length === 0) return withPdfText(m, known, budget);
            const pdfsHere = list.filter(isPdf).length;
            unread += Math.ceil(((budget / pdfsHere) * missing.length) / CHARS_PER_TOKEN);
            // (The ones not read yet are counted above, and taken out here so the adapter's own flat guess is not added.)
            return withPdfText({ ...m, attachments: list.filter((a) => !missing.includes(a)) }, known, (budget / pdfsHere) * (pdfsHere - missing.length));
          });
          return inner.estimateTokens(sized, model) + unread;
        },
        async generate(args) {
          return inner.generate(await swapped(args, inner, o));
        },
        async *stream(args) {
          let ready: GenerateArgs;
          try {
            ready = await swapped(args, inner, o);
          } catch (err) {
            // A stream always ends with `done` or `error`: the look that said no is an error event, not a throw.
            yield { type: 'error', error: isFlintError(err) ? err.error : makeAiError('provider_unavailable', NOT_SENT, { retryable: false }) };
            return;
          }
          yield* inner.stream(ready);
        },
      };
    },
  };
}
