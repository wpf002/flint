import { describe, it, expect } from 'vitest';
import { FlintError, OllamaProvider, makeAiError, type Attachment, type GenerateArgs, type Message, type ModelCapabilities, type ProviderAdapter, type StreamEvent } from '@flint/core';
import { KEPT_READS, MAX_PDF_CHARS, MIN_PDF_CHARS, NOT_SENT, PDF_SHARE, asTextFile, isPdf, localMedia, pdfChars, pdfHeading, withPdfText } from '../src/local-media';
import { FRESH_MS } from '../src/ollama-locality';
import type { PdfReader, PdfText } from '../src/pdf-text';
import { textPdf } from '../src/synthetic-files';

/**
 * A PDF for the local model (../src/local-media): the PDF is replaced by its
 * text for the one request a LOCAL adapter makes, sized to the model's window,
 * and nothing else about the request, the stored message or any other adapter
 * changes. The reader is a stand-in: no program is run.
 */

/** How long a wait for something to happen may take: an event is waited for, never a length of time, and a busy Mac is given room. */
const WAIT = { timeout: 20_000, interval: 10 };
const b64 = (lines: string[]): string => textPdf([lines]).toString('base64');
const pdf = (name: string, lines: string[] = [name]): Attachment => ({ kind: 'document', mediaType: 'application/pdf', name, data: b64(lines), bytes: 400 });
const PNG: Attachment = { kind: 'image', mediaType: 'image/png', name: 'shot.png', data: 'iVBORw0KGgo=', bytes: 8 };
const TXT: Attachment = { kind: 'text', mediaType: 'text/markdown', name: 'notes.md', text: '# notes', bytes: 7 };
const user = (content: string, attachments?: Attachment[]): Message => ({ id: 'u', role: 'user', content, timestamp: 0, ...(attachments ? { attachments } : {}) });
/** The size @flint/core gives a message: what every adapter here budgets with. */
const REFERENCE = new OllamaProvider();
const estimateMessageTokens = (messages: Message[]): number => REFERENCE.estimateTokens(messages, 'm');
const ok = (text: string, more: { cut?: boolean; pages?: number } = {}): Extract<PdfText, { ok: true }> => ({ ok: true, text, cut: more.cut === true, ...(more.pages !== undefined ? { pages: more.pages } : {}) });

/** A reader that answers from a table keyed by what the PDF says (its first line), and counts its reads. */
function reader(table: Record<string, PdfText | (() => Promise<PdfText>)>): PdfReader & { reads: string[] } {
  const reads: string[] = [];
  return {
    kind: 'spotlight',
    reads,
    async read(bytes) {
      const key = Object.keys(table).find((k) => Buffer.from(bytes).includes(`(${k})`));
      reads.push(key ?? '?');
      const a = key === undefined ? undefined : table[key];
      if (a === undefined) return { ok: false, why: 'failed' };
      return typeof a === 'function' ? a() : a;
    },
  };
}

/** An adapter that records what it was asked, with a window of `window` tokens. */
function inner(window = 16_384): ProviderAdapter & { asked: GenerateArgs[]; baseURL: string; numCtx: number } {
  const asked: GenerateArgs[] = [];
  return {
    name: 'ollama',
    baseURL: 'http://127.0.0.1:11434',
    numCtx: window,
    asked,
    getCapabilities: () => ({ maxContextTokens: window, maxOutputTokens: 1024, toolCalling: 'native' }) as ModelCapabilities,
    estimateTokens: (messages) => estimateMessageTokens(messages),
    async generate(args) {
      asked.push(args);
      return { message: { id: 'a', role: 'assistant', content: 'ok', timestamp: 0 }, usage: { input: 1, output: 1 }, reason: 'complete' };
    },
    async *stream(args) {
      asked.push(args);
      yield { type: 'text', delta: 'ok' } as StreamEvent;
      yield { type: 'done', reason: 'complete', usage: { input: 1, output: 1 } } as StreamEvent;
    },
  };
}

describe('which attachment is a PDF to read', () => {
  it('a document that still carries its bytes, and nothing else', () => {
    expect(isPdf(pdf('a.pdf'))).toBe(true);
    expect(isPdf(PNG)).toBe(false);
    expect(isPdf(TXT)).toBe(false);
    expect(isPdf({ kind: 'document', mediaType: 'application/pdf', name: 'shed.pdf', bytes: 9 })).toBe(false);
    expect(isPdf({ kind: 'document', mediaType: 'application/pdf', name: 'empty.pdf', data: '' })).toBe(false);
    expect(isPdf({ kind: 'document', mediaType: 'application/msword', name: 'x.doc', data: 'AAAA' })).toBe(false);
  });
});

describe('how much of a PDF a model is given', () => {
  it('a share of its window, never so little that nothing is read, and never so much that the first word would be late', () => {
    expect(pdfChars(16_384)).toBe(Math.floor(16_384 * PDF_SHARE) * 4);
    expect(pdfChars(16_384)).toBe(22_936);
    expect(pdfChars(8_192)).toBe(Math.floor(8_192 * PDF_SHARE) * 4);
    expect(pdfChars(1_024)).toBe(MIN_PDF_CHARS);
    expect(pdfChars(16_384)).toBeLessThan(16_384 * 4 * 0.5);
    // A larger window does not buy a longer wait: the most is the same at 32K, 128K and 1M.
    expect(MAX_PDF_CHARS).toBe(32_000);
    for (const window of [32_768, 131_072, 1_048_576]) expect(pdfChars(window)).toBe(MAX_PDF_CHARS);
  });

  it('the heading says what the model is reading, and how much of it when that is not all', () => {
    expect(pdfHeading(ok('abc', { pages: 2 }), 3)).toBe('[This is the text of the PDF, which has 2 pages, read on this Mac. Its pictures and its layout are not here.]');
    expect(pdfHeading(ok('abc', { pages: 1 }), 3)).toContain('which has 1 page,');
    expect(pdfHeading(ok('abc'), 3)).toBe('[This is the text of the PDF, read on this Mac. Its pictures and its layout are not here.]');
    expect(pdfHeading(ok('x'.repeat(50_000), { pages: 60 }), 22_936)).toBe('[This is the text of the PDF, which has 60 pages, read on this Mac. Its pictures and its layout are not here. Only the first 22,936 of its 50,000 characters are below, and the rest was left out.]');
    // The reader itself kept only part: how long the whole is, is not known, so no total is made up.
    expect(pdfHeading(ok('x'.repeat(1000), { cut: true }), 1000)).toBe('[This is the text of the PDF, read on this Mac. Its pictures and its layout are not here. Only its first 1,000 characters are below, and the rest was left out.]');
  });

  it('the PDF becomes a text file with its own name: the heading, a blank line, and no more text than allowed', () => {
    const a = pdf('plan.pdf');
    const whole = asTextFile(a, ok('The plan.', { pages: 1 }), 1000);
    expect(whole).toEqual({ kind: 'text', mediaType: 'text/plain', name: 'plan.pdf', bytes: 400, text: '[This is the text of the PDF, which has 1 page, read on this Mac. Its pictures and its layout are not here.]\n\nThe plan.' });
    const part = asTextFile(a, ok('0123456789'), 4);
    expect(part.text!.endsWith('\n\n0123')).toBe(true);
    expect(part.text).toContain('Only the first 4 of its 10 characters');
    expect('data' in part).toBe(false);
  });
});

describe('a message with its PDFs as text', () => {
  const known = (table: Record<string, PdfText>) => (a: Attachment) => table[a.name ?? ''];

  it('each PDF that was read is replaced in place; everything else on the message is as it was', () => {
    const m = user('what does it say?', [TXT, pdf('a.pdf'), PNG]);
    const out = withPdfText(m, known({ 'a.pdf': ok('Alpha.') }), 1000);
    expect(out).not.toBe(m);
    expect(out.content).toBe('what does it say?');
    expect(out.attachments![0]).toBe(TXT);
    expect(out.attachments![2]).toBe(PNG);
    expect(out.attachments![1]).toMatchObject({ kind: 'text', name: 'a.pdf' });
    expect(out.attachments![1]!.text!.endsWith('Alpha.')).toBe(true);
    // The message it was made from is untouched: the stored turn keeps the PDF.
    expect(m.attachments![1]!.kind).toBe('document');
  });

  it('a message with no PDF, or none that was read, is the same object', () => {
    const plain = user('hi', [PNG, TXT]);
    expect(withPdfText(plain, () => undefined, 1000)).toBe(plain);
    const unread = user('hi', [pdf('a.pdf')]);
    expect(withPdfText(unread, () => undefined, 1000)).toBe(unread);
    expect(withPdfText(unread, known({ 'a.pdf': { ok: false, why: 'no_text' } }), 1000)).toBe(unread);
    expect(withPdfText(user('hi'), () => undefined, 1000)).toEqual(user('hi'));
  });

  it('a PDF that could not be read stays a PDF beside one that could', () => {
    const out = withPdfText(user('q', [pdf('scan.pdf'), pdf('a.pdf')]), known({ 'scan.pdf': { ok: false, why: 'no_text' }, 'a.pdf': ok('Alpha.') }), 1000);
    expect(out.attachments!.map((a) => a.kind)).toEqual(['document', 'text']);
  });

  it('the message’s PDFs share one budget: evenly, and what a short one leaves goes to the next', () => {
    const body = (a: Attachment): string => a.text!.split('\n\n').slice(1).join('\n\n');
    const even = withPdfText(user('q', [pdf('a.pdf'), pdf('b.pdf')]), known({ 'a.pdf': ok('a'.repeat(900)), 'b.pdf': ok('b'.repeat(900)) }), 1000);
    expect(even.attachments!.map((a) => body(a).length)).toEqual([500, 500]);
    const short = withPdfText(user('q', [pdf('a.pdf'), pdf('b.pdf')]), known({ 'a.pdf': ok('a'.repeat(100)), 'b.pdf': ok('b'.repeat(5000)) }), 1000);
    expect(short.attachments!.map((a) => body(a).length)).toEqual([100, 900]);
    const three = withPdfText(user('q', [pdf('a.pdf'), pdf('b.pdf'), pdf('c.pdf')]), known({ 'a.pdf': ok('a'.repeat(5000)), 'b.pdf': ok('b'.repeat(10)), 'c.pdf': ok('c'.repeat(5000)) }), 900);
    expect(three.attachments!.map((a) => body(a).length)).toEqual([300, 10, 590]);
    // Never more than the budget in all.
    expect(three.attachments!.reduce((n, a) => n + body(a).length, 0)).toBeLessThanOrEqual(900);
  });
});

describe('reads are kept', () => {
  it('a PDF is read once, by what it holds: the same bytes under another name are the same PDF', async () => {
    const r = reader({ alpha: ok('Alpha.') });
    const media = localMedia(r);
    const a = pdf('a.pdf', ['alpha']);
    expect(await media.text(a)).toEqual(ok('Alpha.'));
    expect(await media.text(a)).toEqual(ok('Alpha.'));
    expect(await media.text({ ...a, name: 'copy.pdf' })).toEqual(ok('Alpha.'));
    expect(r.reads).toEqual(['alpha']);
  });

  it('two asks at once are one read', async () => {
    let release: (v: PdfText) => void = () => {};
    const r = reader({ alpha: () => new Promise<PdfText>((res) => (release = res)) });
    const media = localMedia(r);
    const a = pdf('a.pdf', ['alpha']);
    const both = Promise.all([media.text(a), media.text({ ...a })]);
    await expect.poll(() => r.reads.length, WAIT).toBe(1);
    release(ok('Alpha.'));
    expect(await both).toEqual([ok('Alpha.'), ok('Alpha.')]);
    expect(r.reads).toEqual(['alpha']);
  });

  it('"no text" is kept (a scan stays a scan); a read that failed, or was told to wait, is tried again', async () => {
    let n = 0;
    const r = reader({ scan: { ok: false, why: 'no_text' }, flaky: async () => (n++ === 0 ? { ok: false, why: 'failed' } : ok('Now it reads.')), busy: async () => ({ ok: false, why: 'busy' }) });
    const media = localMedia(r);
    const scan = pdf('scan.pdf', ['scan']);
    expect(await media.text(scan)).toEqual({ ok: false, why: 'no_text' });
    expect(await media.text(scan)).toEqual({ ok: false, why: 'no_text' });
    const flaky = pdf('f.pdf', ['flaky']);
    expect(await media.text(flaky)).toEqual({ ok: false, why: 'failed' });
    expect(await media.text(flaky)).toEqual(ok('Now it reads.'));
    const busy = pdf('b.pdf', ['busy']);
    await media.text(busy);
    await media.text(busy);
    expect(r.reads).toEqual(['scan', 'flaky', 'flaky', 'busy', 'busy']);
  });

  it('what a PDF IS is kept (too big, too many pages); what the moment was (busy, failed) is asked again', async () => {
    let busy = true;
    const r = reader({ big: { ok: false, why: 'too_big' }, long: { ok: false, why: 'too_long' }, later: async () => (busy ? { ok: false, why: 'busy' } : ok('Read at last.')) });
    const media = localMedia(r);
    for (const word of ['big', 'long']) {
      const a = pdf(`${word}.pdf`, [word]);
      const first = await media.text(a);
      expect(first.ok).toBe(false);
      expect(await media.text(a)).toEqual(first);
    }
    const later = pdf('later.pdf', ['later']);
    expect(await media.text(later)).toEqual({ ok: false, why: 'busy' });
    busy = false;
    expect(await media.text(later)).toEqual(ok('Read at last.'));
    expect(r.reads).toEqual(['big', 'long', 'later', 'later']);
  });

  it('a reader that throws is a failed read, never a rejection', async () => {
    const media = localMedia({ kind: 'spotlight', read: async () => Promise.reject(new Error('boom')) });
    expect(await media.text(pdf('a.pdf'))).toEqual({ ok: false, why: 'failed' });
  });

  it('something that is not a PDF with its bytes is not read at all', async () => {
    const r = reader({});
    const media = localMedia(r);
    expect(await media.text(PNG)).toEqual({ ok: false, why: 'failed' });
    expect(await media.text({ kind: 'document', mediaType: 'application/pdf', name: 'shed.pdf' })).toEqual({ ok: false, why: 'failed' });
    expect(r.reads).toEqual([]);
  });

  it('only so many are kept, and only so much text: the oldest goes first, and one asked for again is the newest', async () => {
    const table: Record<string, PdfText> = {};
    for (let i = 0; i < 6; i++) table[`doc-${i}-`] = ok(`text ${i}`);
    const r = reader(table);
    const media = localMedia(r, { kept: 3 });
    const docs = [0, 1, 2, 3, 4, 5].map((i) => pdf(`${i}.pdf`, [`doc-${i}-`]));
    for (const d of docs.slice(0, 3)) await media.text(d);
    await media.text(docs[0]!); // asked for again: now the newest of the three
    await media.text(docs[3]!); // a fourth: the oldest (1) goes
    r.reads.length = 0;
    await media.text(docs[0]!);
    await media.text(docs[2]!);
    await media.text(docs[3]!);
    expect(r.reads).toEqual([]);
    await media.text(docs[1]!);
    expect(r.reads).toEqual(['doc-1-']);

    const big = reader({ 'big-a': ok('a'.repeat(600)), 'big-b': ok('b'.repeat(600)) });
    const tight = localMedia(big, { keptChars: 1000 });
    await tight.text(pdf('a.pdf', ['big-a']));
    await tight.text(pdf('b.pdf', ['big-b']));
    big.reads.length = 0;
    await tight.text(pdf('b.pdf', ['big-b']));
    expect(big.reads).toEqual([]);
    await tight.text(pdf('a.pdf', ['big-a']));
    expect(big.reads).toEqual(['big-a']);
    expect(KEPT_READS).toBeGreaterThanOrEqual(5); // every file one message may carry (./attachments LIMITS.maxCount)
  });

  it('`chars`: how much text a turn’s PDFs come to as they would be handed over, and nothing for one that was not read', async () => {
    const r = reader({ alpha: ok('a'.repeat(900)), beta: ok('b'.repeat(90_000)), scan: { ok: false, why: 'no_text' } });
    const media = localMedia(r);
    const a = pdf('a.pdf', ['alpha']);
    const b = pdf('b.pdf', ['beta']);
    const scan = pdf('s.pdf', ['scan']);
    expect(media.chars([PNG, TXT], 16_384)).toBe(0);
    // Not read yet: nothing is counted, and counting reads nothing.
    expect(media.chars([a, b], 16_384)).toBe(0);
    expect(r.reads).toEqual([]);
    await media.reads([a, b, scan]);
    const heading = (given: number, of: number): number => asTextFile(a, ok('x'.repeat(of)), given).text!.length - given;
    expect(media.chars([a], 16_384)).toBe(900 + heading(900, 900));
    // The long one is counted as cut to the window's share, never as the 90,000 characters it holds.
    const cap = pdfChars(16_384);
    expect(media.chars([b], 16_384)).toBe(cap + heading(cap, 90_000));
    expect(media.chars([a, b, scan, PNG], 16_384)).toBeLessThanOrEqual(cap + 2 * 300);
    expect(media.chars([scan], 16_384)).toBe(0);
  });

  it('`reads` says whether every PDF among a turn’s files came out as text, and reads them on the way', async () => {
    const r = reader({ alpha: ok('Alpha.'), scan: { ok: false, why: 'no_text' } });
    const media = localMedia(r);
    expect(await media.reads([PNG, TXT])).toBe(true);
    expect(r.reads).toEqual([]);
    expect(await media.reads([pdf('a.pdf', ['alpha']), PNG])).toBe(true);
    expect(await media.reads([pdf('a.pdf', ['alpha']), pdf('s.pdf', ['scan'])])).toBe(false);
    expect(r.reads).toEqual(['alpha', 'scan']);
  });
});

describe('the local adapter, wrapped', () => {
  it('says it reads PDFs, and is otherwise the adapter it wraps: its name, its address and its window', () => {
    const base = inner(16_384);
    const p = localMedia(reader({})).provider(base) as ProviderAdapter & { baseURL?: string; numCtx?: number };
    expect(p.name).toBe('ollama');
    expect(p.baseURL).toBe('http://127.0.0.1:11434');
    expect(p.numCtx).toBe(16_384);
    expect(p.getCapabilities('m')).toEqual({ ...base.getCapabilities('m'), pdfInput: true });
    // An adapter with neither stays without them.
    const bare = localMedia(reader({})).provider({ name: 'local', getCapabilities: base.getCapabilities, estimateTokens: base.estimateTokens, generate: base.generate, stream: base.stream });
    expect('baseURL' in bare).toBe(false);
    expect('numCtx' in bare).toBe(false);
  });

  it('generate: the adapter is handed the PDF’s text in place of the PDF, and the caller’s messages are untouched', async () => {
    const base = inner();
    const r = reader({ alpha: ok('The total is 1,284.50 dollars.', { pages: 2 }) });
    const p = localMedia(r).provider(base);
    const messages = [user('earlier'), user('what is the total?', [pdf('invoice.pdf', ['alpha']), PNG])];
    await p.generate({ model: 'm', messages });
    expect(base.asked).toHaveLength(1);
    const sent = base.asked[0]!.messages;
    expect(sent[0]).toBe(messages[0]);
    expect(sent[1]!.attachments!.map((a) => a.kind)).toEqual(['text', 'image']);
    expect(sent[1]!.attachments![0]!.text).toBe('[This is the text of the PDF, which has 2 pages, read on this Mac. Its pictures and its layout are not here.]\n\nThe total is 1,284.50 dollars.');
    expect(messages[1]!.attachments![0]!.kind).toBe('document');
    expect(JSON.stringify(sent)).not.toContain(messages[1]!.attachments![0]!.data);
  });

  it('stream: the same, and every event of the adapter comes through', async () => {
    const base = inner();
    const p = localMedia(reader({ alpha: ok('Alpha.') })).provider(base);
    const events: StreamEvent[] = [];
    for await (const e of p.stream({ model: 'm', messages: [user('q', [pdf('a.pdf', ['alpha'])])] })) events.push(e);
    expect(events.map((e) => e.type)).toEqual(['text', 'done']);
    expect(base.asked[0]!.messages[0]!.attachments![0]!.text!.endsWith('Alpha.')).toBe(true);
  });

  it('a request with no PDF is passed on as the very object it was', async () => {
    const base = inner();
    const r = reader({});
    const p = localMedia(r).provider(base);
    const args: GenerateArgs = { model: 'm', messages: [user('hi', [PNG, TXT])] };
    await p.generate(args);
    for await (const _ of p.stream(args)) void _;
    expect(base.asked[0]).toBe(args);
    expect(base.asked[1]).toBe(args);
    expect(r.reads).toEqual([]);
  });

  it('a PDF in an earlier message of the history is read too, and each message has its own share of the window', async () => {
    const base = inner(16_384);
    const long = 'x'.repeat(40_000);
    const p = localMedia(reader({ alpha: ok(long), beta: ok(long) })).provider(base);
    await p.generate({ model: 'm', messages: [user('first', [pdf('a.pdf', ['alpha'])]), { id: 'a1', role: 'assistant', content: 'answer', timestamp: 0 }, user('second', [pdf('b.pdf', ['beta'])])] });
    const sent = base.asked[0]!.messages;
    const cap = pdfChars(16_384);
    for (const i of [0, 2]) {
      const text = sent[i]!.attachments![0]!.text!;
      expect(text).toContain(`Only the first ${cap.toLocaleString('en-US')} of its 40,000 characters`);
      expect(text.split('\n\n')[1]!.length).toBe(cap);
    }
  });

  it('a PDF that cannot be read is left a PDF, so the adapter tells the model a file it cannot read is there', async () => {
    const base = inner();
    const p = localMedia(reader({ scan: { ok: false, why: 'no_text' } })).provider(base);
    const messages = [user('q', [pdf('scan.pdf', ['scan'])])];
    await p.generate({ model: 'm', messages });
    expect(base.asked[0]!.messages[0]).toBe(messages[0]);
  });

  it('the size it reports is the size it will send: a read PDF counts as its text, an unread one as the most it may be', async () => {
    const base = inner(16_384);
    const media = localMedia(reader({ alpha: ok('y'.repeat(4000)), beta: ok('z'.repeat(400_000)) }));
    const p = media.provider(base);
    const small = pdf('a.pdf', ['alpha']);
    const huge = pdf('b.pdf', ['beta']);
    const cap = pdfChars(16_384);
    // Not read yet: the most a message's PDFs may come to.
    expect(p.estimateTokens([user('q', [small])], 'm')).toBe(estimateMessageTokens([user('q')]) + Math.ceil(cap / 4));
    await media.text(small);
    const sized = p.estimateTokens([user('q', [small])], 'm');
    await p.generate({ model: 'm', messages: [user('q', [small])] });
    expect(sized).toBe(estimateMessageTokens(base.asked[0]!.messages));
    expect(sized).toBeGreaterThan(1000);
    expect(sized).toBeLessThan(1100);
    // A long one is counted as cut, never as the 100,000 tokens it holds.
    await media.text(huge);
    const big = p.estimateTokens([user('q', [huge])], 'm');
    await p.generate({ model: 'm', messages: [user('q', [huge])] });
    expect(big).toBe(estimateMessageTokens(base.asked[1]!.messages));
    expect(big).toBeLessThan(Math.ceil(cap / 4) + 100);
    // One read beside one not read: the read one as its text within its half, the other as the other half.
    const mixed = p.estimateTokens([user('q', [small, pdf('c.pdf', ['gamma'])])], 'm');
    expect(mixed).toBe(estimateMessageTokens([withPdfText(user('q', [small]), () => ok('y'.repeat(4000)), cap / 2)]) + Math.ceil(cap / 2 / 4));
    // No PDF: the adapter's own number.
    expect(p.estimateTokens([user('hello', [PNG])], 'm')).toBe(estimateMessageTokens([user('hello', [PNG])]));
  });

  // Nothing of a file goes to a model server that is not this Mac: the wrapper asks, for every request.
  it('a server that is not this Mac is handed no PDF text, on any turn: the PDF stays a PDF, nothing is read, and the adapter does not say it reads PDFs', async () => {
    const base = inner();
    const r = reader({ alpha: ok('Alpha.') });
    let here = false;
    const p = localMedia(r).provider(base, { filesStayHere: () => here });
    expect(p.getCapabilities('m').pdfInput).toBeUndefined();
    const args: GenerateArgs = { model: 'm', messages: [user('q', [pdf('a.pdf', ['alpha'])])] };
    await p.generate(args);
    for await (const _ of p.stream(args)) void _;
    expect(base.asked[0]).toBe(args);
    expect(base.asked[1]).toBe(args);
    expect(r.reads).toEqual([]);
    // ...and the moment it is this Mac again, the same adapter reads.
    here = true;
    expect(p.getCapabilities('m').pdfInput).toBe(true);
    await p.generate(args);
    expect(base.asked[2]!.messages[0]!.attachments![0]!.kind).toBe('text');
  });

  // The look at the model server is the last thing before the request. A read that makes the request wait longer
  // than that look is good for has the server asked again, and the request is not made if the answer changed.
  describe('a read that makes the request wait', () => {
    /** A reader whose read takes `takes` ms of a clock the test moves. */
    const timed = (takes: number) => {
      const clock = { t: 1_000_000 };
      const r: PdfReader = {
        kind: 'spotlight',
        async read() {
          clock.t += takes;
          return ok('Alpha.');
        },
      };
      return { clock, r };
    };
    const args = (): GenerateArgs => ({ model: 'm', messages: [user('q', [pdf('a.pdf', ['alpha'])])] });

    it('a short one asks nothing more; a long one asks the model server again before anything is sent', async () => {
      for (const [takes, asks] of [[FRESH_MS - 1, 0], [FRESH_MS, 0], [FRESH_MS + 1, 1], [11_700, 1]] as const) {
        const { clock, r } = timed(takes);
        const base = inner();
        const looks: Array<{ model: string; sentYet: number }> = [];
        const p = localMedia(r).provider(base, { now: () => clock.t, lookAgain: async (_inner, model) => void looks.push({ model, sentYet: base.asked.length }) });
        await p.generate(args());
        expect(looks.length, `${takes} ms`).toBe(asks);
        if (asks) expect(looks[0]).toEqual({ model: 'm', sentYet: 0 });
        expect(base.asked).toHaveLength(1);
      }
      expect(FRESH_MS).toBe(2000);
    });

    it('a read that was kept makes nothing wait, and nothing is asked', async () => {
      const { clock, r } = timed(11_700);
      const base = inner();
      const media = localMedia(r);
      const a = args();
      await media.text(a.messages[0]!.attachments![0]!); // the route read it, before its own look
      const before = clock.t;
      let looks = 0;
      await media.provider(base, { now: () => clock.t, lookAgain: async () => void looks++ }).generate(a);
      expect(clock.t).toBe(before);
      expect(looks).toBe(0);
      expect(base.asked[0]!.messages[0]!.attachments![0]!.kind).toBe('text');
    });

    it('when the second look says no, the request is NOT made: generate throws, and a stream ends with an error event', async () => {
      const { clock, r } = timed(11_700);
      const base = inner();
      const no = new FlintError(makeAiError('provider_unavailable', 'Flint cannot confirm right now that its local model runs on this Mac, so nothing was sent to it.', { retryable: false }));
      const p = localMedia(r).provider(base, {
        now: () => clock.t,
        lookAgain: async () => {
          throw no;
        },
      });
      await expect(p.generate(args())).rejects.toBe(no);
      const events: StreamEvent[] = [];
      for await (const e of localMedia(timed(11_700).r).provider(base, { now: (() => { let t = 0; return () => (t += 6000); })(), lookAgain: async () => { throw no; } }).stream(args())) events.push(e);
      expect(events).toEqual([{ type: 'error', error: no.error }]);
      // A look that fails some other way is an error event too, in Flint's own words, never a stream that just stops.
      const odd: StreamEvent[] = [];
      for await (const e of localMedia(timed(11_700).r).provider(base, { now: (() => { let t = 0; return () => (t += 6000); })(), lookAgain: async () => { throw new Error('boom'); } }).stream(args())) odd.push(e);
      expect(odd).toEqual([{ type: 'error', error: { kind: 'provider_unavailable', message: NOT_SENT, retryable: false } }]);
      expect(base.asked).toEqual([]);
    });

    it('when the second look finds the server is no longer this Mac, an ordinary turn goes on without the PDF’s text', async () => {
      const { clock, r } = timed(11_700);
      const base = inner();
      let here = true;
      const p = localMedia(r).provider(base, { now: () => clock.t, filesStayHere: () => here, lookAgain: async () => void (here = false) });
      const a = args();
      await p.generate(a);
      expect(base.asked[0]).toBe(a);
    });
  });

  it('through the real Ollama adapter: the request carries the PDF’s text, and neither the PDF nor a picture field', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchStub = (async (_url: unknown, init?: { body?: unknown }) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ message: { role: 'assistant', content: 'It is 1,284.50 dollars.' }, done: true, done_reason: 'stop', prompt_eval_count: 5, eval_count: 5 }), { status: 200 });
    }) as unknown as typeof fetch;
    const p = localMedia(reader({ alpha: ok('The total due is 1,284.50 dollars.', { pages: 1 }) })).provider(new OllamaProvider({ baseURL: 'http://127.0.0.1:11434', fetch: fetchStub, defaultOptions: { num_ctx: 16_384 } }));
    const doc = pdf('invoice.pdf', ['alpha']);
    const out = await p.generate({ model: 'm', messages: [user('What is the total?', [doc])] });
    expect(out.message.content).toBe('It is 1,284.50 dollars.');
    const sent = (bodies[0]!.messages as Array<{ role: string; content: string; images?: unknown }>)[0]!;
    expect(sent.content).toBe('<attached_file name="invoice.pdf" type="text/plain">\n[This is the text of the PDF, which has 1 page, read on this Mac. Its pictures and its layout are not here.]\n\nThe total due is 1,284.50 dollars.\n</attached_file>\n\nWhat is the total?');
    expect(sent.images).toBeUndefined();
    expect(JSON.stringify(bodies[0])).not.toContain(doc.data);
    expect(JSON.stringify(bodies[0])).not.toContain('cannot read this file type');
  });
});
