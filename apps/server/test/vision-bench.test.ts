import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { INSTALL_PDFTOTEXT, MAX_ANSWER_TOKENS, OUT_UNDER_FLINT, PDFS, PICTURES, USAGE, defaultOut, isRight, lookAtServer, parseVisionArgs, pickModel, renderVision, runVisionBench, textOf, underFlint, type ServerLook, type VisionArgs, type VisionDeps } from '../src/vision-bench';
import { main } from '../scripts/vision-bench';
import { pdfChars } from '../src/local-media';
import type { PdfReader, PdfText } from '../src/pdf-text';
import { Sheet, crc32, png, textPdf } from '../src/synthetic-files';

/**
 * The vision benchmark (../src/vision-bench), run whole with stand-ins: a
 * model server that is a function, and a PDF reader that is a table. No model
 * is asked and no program is run. What is held here is what the benchmark
 * must never do on Will's Mac: load, swap or unload a model, ask a model
 * server that is not this Mac, or install anything.
 */

const MAIN = 'main-model:30b';
const SMALL = 'small-model:3b';
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Sent {
  method: string;
  path: string;
  body: Record<string, unknown> | undefined;
}

/** A model server as a function: Ollama's own routes, answering from `state`, and every request kept. */
function modelServer(state: { loaded: Array<{ name: string; context_length: number }>; installed: Array<{ name: string; vision: boolean; remote_host?: string; remote_model?: string }>; answer?: (body: Record<string, unknown>) => string; down?: boolean; unloadAfterChat?: boolean }) {
  const sent: Sent[] = [];
  const json = (b: unknown, status = 200): Response => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
  const f = (async (input: unknown, init?: { method?: string; body?: unknown }) => {
    const url = new URL(String(input));
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    sent.push({ method: init?.method ?? 'GET', path: url.pathname, body });
    if (state.down) throw new TypeError('fetch failed');
    if (url.pathname === '/api/version') return json({ version: '0.34.4' });
    if (url.pathname === '/api/ps') return json({ models: state.loaded });
    if (url.pathname === '/api/tags') return json({ models: state.installed.map((m) => ({ name: m.name, ...(m.remote_host ? { remote_host: m.remote_host } : {}), ...(m.remote_model ? { remote_model: m.remote_model } : {}) })) });
    if (url.pathname === '/api/show') {
      const m = state.installed.find((x) => x.name === body?.model);
      return m ? json({ capabilities: ['completion', 'tools', ...(m.vision ? ['vision'] : [])] }) : json({ error: 'not found' }, 404);
    }
    if (url.pathname === '/api/chat') {
      const text = state.answer?.(body!) ?? 'I do not know.';
      if (state.unloadAfterChat) state.loaded = [];
      const lines = [{ model: body!.model, message: { role: 'assistant', content: text }, done: false }, { model: body!.model, message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 225, eval_count: 7 }];
      return new Response(lines.map((l) => JSON.stringify(l)).join('\n') + '\n', { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
    }
    return json({ error: 'not found' }, 404);
  }) as unknown as typeof fetch;
  return { fetch: f, sent, chats: () => sent.filter((s) => s.path === '/api/chat') };
}

/** The right answer to every question, by what the question says. */
const RIGHT = (body: Record<string, unknown>): string => {
  const q = JSON.stringify(body.messages);
  if (q.includes('What is written')) return 'MAPLE 4827';
  if (q.includes('the word GATE')) return '52';
  if (q.includes('square on the left')) return 'Red';
  if (q.includes('How many black squares')) return '4';
  if (q.includes('Which bar is the tallest')) return 'B';
  if (q.includes('In which corner')) return 'Top right';
  if (q.includes('total due')) return '1,284.50';
  if (q.includes('code word')) return 'HARBOR';
  return 'unknown';
};

/** The benchmark's PDFs, written once for the whole file. */
const cases = PDFS.map((c) => ({ c, bytes: textPdf(c.pages, { compress: c.compress }) }));

/** A reader that gives back the text each PDF was written with (it finds the case by its bytes). */
function goodReader(kind: PdfReader['kind'], reads: string[] = []): PdfReader {
  return {
    kind,
    async read(bytes): Promise<PdfText> {
      const found = cases.find((x) => x.bytes.equals(Buffer.from(bytes)));
      reads.push(found?.c.id ?? '?');
      if (!found) return { ok: false, why: 'failed' };
      const text = textOf(found.c);
      return text.length === 0 ? { ok: false, why: 'no_text' } : { ok: true, text, cut: false, pages: found.c.pages.length };
    },
  };
}

function deps(server: ReturnType<typeof modelServer>, over: Partial<VisionDeps> = {}): VisionDeps & { saved: Map<string, Buffer | string>; lines: string[] } {
  const saved = new Map<string, Buffer | string>();
  const lines: string[] = [];
  let t = 0;
  return {
    env: {},
    fetch: server.fetch,
    now: () => (t += 7),
    exists: (p) => p === '/usr/bin/mdimport',
    reader: (which) => goodReader(which.reader),
    save: (name, data) => void saved.set(name, data),
    machine: { chip: 'Apple M5 Max', memoryGb: 64, os: '27.0' },
    when: '2026-10-13T12:00:00.000Z',
    log: (l) => lines.push(l),
    saved,
    lines,
    ...over,
  };
}
const ARGS: VisionArgs = { help: false, json: false, runs: 1 };
const healthy = () => modelServer({ loaded: [{ name: MAIN, context_length: 16384 }, { name: 'embed-model:latest', context_length: 2048 }], installed: [{ name: MAIN, vision: true }, { name: SMALL, vision: false }, { name: 'embed-model:latest', vision: false }], answer: RIGHT });

describe('the arguments', () => {
  it('nothing: one run, tables, the default folder', () => {
    expect(parseVisionArgs([])).toEqual({ help: false, json: false, runs: 1 });
    expect(parseVisionArgs(['--'])).toEqual({ help: false, json: false, runs: 1 });
  });

  it('each option', () => {
    expect(parseVisionArgs(['--json', '--runs', '3', '--model', MAIN, '--out', '/x/y'])).toEqual({ help: false, json: true, runs: 3, model: MAIN, out: '/x/y' });
    expect(parseVisionArgs(['--help'])).toMatchObject({ help: true });
  });

  it('what is not understood is refused, and never echoed', () => {
    for (const bad of [['--runs', '0'], ['--runs', '6'], ['--runs', 'x'], ['--runs'], ['--model'], ['--model', 'two words'], ['--model', '$(id)'], ['--out'], ['--pull'], ['extra']]) {
      const r = parseVisionArgs(bad);
      expect('error' in r, bad.join(' ')).toBe(true);
      if ('error' in r) for (const word of bad) if (!word.startsWith('--')) expect(r.error).not.toContain(word);
    }
    expect(USAGE).toContain('Nothing is downloaded, loaded or installed');
  });

  it('the default folder is under this user’s caches, never under ~/.flint', () => {
    const out = defaultOut('/Users/someone', '2026-10-13T12:00:00.000Z', join);
    expect(out).toBe('/Users/someone/Library/Caches/Flint/vision-bench/2026-10-13T12-00-00-000Z');
    expect(out).not.toContain('.flint');
  });
});

describe('the pictures and the PDFs it makes', () => {
  it('every picture is a PNG of the size it was drawn at, the same bytes each time, and every PDF starts as one', () => {
    for (const c of PICTURES) {
      const a = c.make();
      expect(a.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), c.id).toBe(true);
      expect(a.subarray(12, 16).toString('latin1')).toBe('IHDR');
      expect(a.readUInt32BE(16)).toBeGreaterThanOrEqual(480);
      expect(a.equals(c.make()), c.id).toBe(true);
      expect(a.length).toBeLessThan(64 * 1024);
    }
    expect(new Set(PICTURES.map((c) => c.id)).size).toBe(PICTURES.length);
    for (const c of PDFS) expect(textPdf(c.pages, { compress: c.compress }).subarray(0, 8).toString('latin1')).toBe('%PDF-1.4');
    expect(textOf(PDFS.find((c) => c.id === 'blank')!)).toBe('');
    expect(textOf(PDFS.find((c) => c.id === 'long')!).length).toBeGreaterThan(pdfChars(16384) * 4);
  });

  it('the PNG writer: a checksum that is the standard one, the pixels it was given, and a refusal of a size that does not fit', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
    const sheet = new Sheet(4, 2).rect(0, 0, 1, 1, [255, 0, 0]);
    expect([...sheet.rgb.subarray(0, 6)]).toEqual([255, 0, 0, 255, 255, 255]);
    expect(() => png(2, 2, new Uint8Array(5))).toThrow();
    expect(Sheet.widthOf('AB', 3)).toBe(33);
    // Drawing outside the sheet draws nothing, and a letter the font lacks is a gap.
    expect(() => new Sheet(8, 8).rect(-5, -5, 100, 100, [0, 0, 0]).text('é?', 2, 2, 1)).not.toThrow();
  });

  it('a right answer holds what it should and nothing it should not, however it is dressed', () => {
    const by = (id: string) => PICTURES.find((c) => c.id === id)!;
    expect(isRight('MAPLE 4827', by('words'))).toBe(true);
    expect(isRight('The text says "Maple 4827".', by('words'))).toBe(true);
    expect(isRight('MAPLE', by('words'))).toBe(false);
    expect(isRight('52', by('two-lines'))).toBe(true);
    expect(isRight('36 and 52', by('two-lines'))).toBe(false);
    expect(isRight('152', by('two-lines'))).toBe(false);
    expect(isRight(' Red. ', by('colours'))).toBe(true);
    expect(isRight('Blue', by('colours'))).toBe(false);
    expect(isRight('four', by('count'))).toBe(true);
    expect(isRight('14', by('count'))).toBe(false);
    expect(isRight('**B**', by('tallest'))).toBe(true);
    expect(isRight('C', by('tallest'))).toBe(false);
    expect(isRight('A, B or C', by('tallest'))).toBe(false);
    expect(isRight('top-right', by('corner'))).toBe(true);
    expect(isRight('Bottom right', by('corner'))).toBe(false);
    expect(isRight('', by('words'))).toBe(false);
    expect(isRight('1284.50', { expect: PDFS[0]!.expect! })).toBe(true);
    expect(isRight('$1,284.50', { expect: PDFS[0]!.expect! })).toBe(true);
    expect(isRight('1,284', { expect: PDFS[0]!.expect! })).toBe(false);
  });
});

describe('looking at the model server', () => {
  it('asks four things that only read, and says what is in memory, what is installed and what can see', async () => {
    const s = modelServer({ loaded: [{ name: MAIN, context_length: 16384 }], installed: [{ name: MAIN, vision: true }, { name: SMALL, vision: false }, { name: 'copied:latest', vision: true, remote_host: 'https://ollama.com' }] });
    const look = await lookAtServer(s.fetch, 'http://127.0.0.1:11434');
    expect(look).toEqual({ reachable: true, version: '0.34.4', loaded: [{ name: MAIN, context: 16384 }], installed: [MAIN, SMALL], sees: [MAIN] });
    expect(s.sent.map((x) => `${x.method} ${x.path}`)).toEqual(['GET /api/version', 'GET /api/ps', 'GET /api/tags', 'POST /api/show', 'POST /api/show']);
    // The only bodies sent name a model and nothing else: nothing that loads one.
    expect(s.sent.filter((x) => x.body).map((x) => x.body)).toEqual([{ model: MAIN }, { model: SMALL }]);
  });

  // Where a listed model runs is decided by the one rule the server itself uses (@flint/policy listedModels): a row
  // that says anything of a remote host OR a remote model runs elsewhere. A review found the benchmark reading the
  // host alone, so a row with only `remote_model` passed for a model on this Mac.
  it('a model its server says runs somewhere else is not a model on this Mac: it is not listed, not in memory, and never asked', async () => {
    for (const row of [{ remote_host: 'https://ollama.com:443' }, { remote_model: 'cloud-model:120b' }, { remote_host: 'https://ollama.com:443', remote_model: 'cloud-model:120b' }]) {
      const s = modelServer({ loaded: [{ name: 'cloudy:9b', context_length: 16384 }], installed: [{ name: 'cloudy:9b', vision: true, ...row }], answer: RIGHT });
      const look = await lookAtServer(s.fetch, 'http://127.0.0.1:11434');
      expect(look, JSON.stringify(row)).toMatchObject({ loaded: [], installed: [], sees: [] });
      // It is not even asked what it can do.
      expect(s.sent.some((x) => x.path === '/api/show')).toBe(false);
      const r = await runVisionBench(ARGS, deps(s));
      expect(s.chats(), JSON.stringify(row)).toEqual([]);
      expect(r.model).toBeUndefined();
      expect(r.notAsked).toBe('The model server has no model that it says can see, so none was asked.');
      // Named outright, it is still not asked.
      const named = await runVisionBench({ ...ARGS, model: 'cloudy:9b' }, deps(s));
      expect(named.notAsked).toBe('The model named is not on this model server, so no model was asked.');
      expect(s.chats()).toEqual([]);
    }
  });

  it('a server that does not answer is said to be unreachable, and a name that is not a model name is dropped', async () => {
    expect(await lookAtServer(modelServer({ loaded: [], installed: [], down: true }).fetch, 'http://127.0.0.1:11434')).toEqual({ reachable: false, loaded: [], installed: [], sees: [] });
    const odd = modelServer({ loaded: [{ name: 'bad name; rm -rf', context_length: 4096 }, { name: MAIN, context_length: -1 }], installed: [{ name: 'bad name; rm -rf', vision: true }] });
    expect(await lookAtServer(odd.fetch, 'http://127.0.0.1:11434')).toMatchObject({ loaded: [], installed: [], sees: [] });
  });

  const look = (over: Partial<ServerLook>): ServerLook => ({ reachable: true, loaded: [{ name: MAIN, context: 16384 }], installed: [MAIN, SMALL], sees: [MAIN], ...over });

  it('the model asked is one that is already in memory and can see, and no other', () => {
    expect(pickModel(look({}))).toEqual({ ok: true, model: MAIN, context: 16384 });
    expect(pickModel(look({}), MAIN)).toEqual({ ok: true, model: MAIN, context: 16384 });
    // In memory and blind is passed over for one that sees.
    expect(pickModel(look({ loaded: [{ name: SMALL, context: 4096 }, { name: MAIN, context: 8192 }] }))).toEqual({ ok: true, model: MAIN, context: 8192 });
    expect(pickModel(look({ loaded: [] }))).toEqual({ ok: false, why: 'none_in_memory', model: MAIN });
    expect(pickModel(look({ loaded: [{ name: SMALL, context: 4096 }] }))).toEqual({ ok: false, why: 'none_in_memory', model: MAIN });
    expect(pickModel(look({ sees: [] }))).toEqual({ ok: false, why: 'none_sees' });
    expect(pickModel(look({ loaded: [] }), MAIN)).toEqual({ ok: false, why: 'not_in_memory', model: MAIN });
    expect(pickModel(look({}), SMALL)).toEqual({ ok: false, why: 'cannot_see', model: SMALL });
    expect(pickModel(look({}), 'other:7b')).toEqual({ ok: false, why: 'not_installed', model: 'other:7b' });
    expect(pickModel(look({ reachable: false }))).toEqual({ ok: false, why: 'unreachable' });
  });
});

describe('a run', () => {
  it('asks the model in memory one question a picture and one a PDF, at the context it is loaded with, and sends nothing that loads or keeps a model', async () => {
    const s = healthy();
    const d = deps(s);
    const r = await runVisionBench(ARGS, d);
    expect(r.model).toEqual({ name: MAIN, context: 16384 });
    expect(r.pictures.map((p) => [p.id, p.answers.length, p.answers[0]!.right])).toEqual(PICTURES.map((c) => [c.id, 1, true]));
    expect(r.pdfQuestions.map((p) => [p.reader, p.id, p.answers[0]!.right])).toEqual([['spotlight', 'invoice', true], ['spotlight', 'long', true]]);
    const chats = s.chats();
    expect(chats).toHaveLength(PICTURES.length + 2);
    for (const c of chats) {
      expect(c.body).toMatchObject({ model: MAIN, think: false, stream: true });
      // The window it is loaded with (any other would load it again), room for an answer, and no word on how long it stays.
      expect(c.body!.options).toEqual({ num_ctx: 16384, num_predict: MAX_ANSWER_TOKENS });
      expect('keep_alive' in c.body!).toBe(false);
    }
    // Every request the run made: the four kinds that read, and chat. Nothing that pulls, loads, copies or deletes.
    expect([...new Set(s.sent.map((x) => x.path))].sort()).toEqual(['/api/chat', '/api/ps', '/api/show', '/api/tags', '/api/version']);
    expect(r.unchanged).toBe(true);
    expect(r.notAsked).toBeUndefined();
  });

  it('a picture goes as a picture, and a PDF as its text within the model’s share of the window, with the line that says how much', async () => {
    const s = healthy();
    await runVisionBench(ARGS, deps(s));
    const user = (c: Sent) => (c.body!.messages as Array<{ role: string; content: string; images?: string[] }>).find((m) => m.role === 'user')!;
    const chats = s.chats();
    PICTURES.forEach((c, i) => {
      expect(user(chats[i]!).images, c.id).toEqual([c.make().toString('base64')]);
      expect(user(chats[i]!).content).toBe(c.question);
    });
    const invoice = user(chats[PICTURES.length]!);
    expect(invoice.images).toBeUndefined();
    expect(invoice.content).toContain('The total due is 1,284.50 dollars by the ninth of March.');
    expect(invoice.content).toContain('[This is the text of the PDF, which has 2 pages, read on this Mac.');
    const long = user(chats[PICTURES.length + 1]!);
    const cap = pdfChars(16384);
    expect(long.content).toContain(`Only the first ${cap.toLocaleString('en-US')} of its `);
    expect(long.content).toContain('The code word of this report is HARBOR.');
    expect(long.content).not.toContain('Page 60 line 40');
    expect(long.content.length).toBeLessThan(cap + 600);
  });

  it('each PDF is read once a reader, the reads are timed and compared with what was put in, and a blank one is "no text"', async () => {
    const reads: string[] = [];
    const s = healthy();
    const r = await runVisionBench(ARGS, deps(s, { reader: (which) => goodReader(which.reader, reads) }));
    expect(reads).toEqual(PDFS.map((c) => c.id));
    expect(r.pdfReads.map((p) => [p.reader, p.id, p.outcome, p.exact, p.linesFound, p.lines, p.pagesSaid])).toEqual([
      ['spotlight', 'invoice', 'text', true, 4, 4, 2],
      ['spotlight', 'marks', 'text', true, 2, 2, 1],
      ['spotlight', 'long', 'text', true, 2401, 2401, 60],
      ['spotlight', 'blank', 'no_text', false, 0, 0, undefined],
    ]);
    for (const p of r.pdfReads) expect(p.ms).toBe(7);
  });

  it('a reader that gives back other text is said to differ, with how many lines it found; one that fails is said to have failed', async () => {
    const s = healthy();
    const worse: PdfReader = { kind: 'spotlight', read: async (bytes) => (Buffer.from(bytes).includes('QUARTZHERON') ? { ok: true, text: 'Invoice 4471 for the QUARTZHERON workshop.\nsomething else', cut: false } : { ok: false, why: 'failed' }) };
    const r = await runVisionBench(ARGS, deps(s, { reader: () => worse }));
    expect(r.pdfReads[0]).toMatchObject({ id: 'invoice', outcome: 'text', exact: false, linesFound: 1, lines: 4 });
    expect(r.pdfReads[2]).toMatchObject({ id: 'long', outcome: 'failed', exact: false });
    // A PDF that could not be read is not put to the model: its question has no answer, and says why.
    expect(r.pdfQuestions.find((q) => q.id === 'long')!.answers).toEqual([{ text: '', right: false, totalMs: 0, error: 'failed' }]);
    expect(s.chats()).toHaveLength(PICTURES.length + 1);
  });

  it('--runs asks each question that many times', async () => {
    const s = healthy();
    const r = await runVisionBench({ ...ARGS, runs: 3 }, deps(s));
    expect(s.chats()).toHaveLength((PICTURES.length + 2) * 3);
    expect(r.pictures.every((p) => p.answers.length === 3)).toBe(true);
  });

  it('a wrong answer is counted as wrong, and what the model said is kept, short', async () => {
    const s = modelServer({ loaded: [{ name: MAIN, context_length: 16384 }], installed: [{ name: MAIN, vision: true }], answer: () => `I cannot see any picture. ${'x'.repeat(500)}` });
    const r = await runVisionBench(ARGS, deps(s));
    expect(r.pictures.every((p) => p.answers[0]!.right === false)).toBe(true);
    expect(r.pictures[0]!.answers[0]!.text.length).toBeLessThanOrEqual(200);
    expect(r.pictures[0]!.answers[0]).toMatchObject({ inputTokens: 225, outputTokens: 7, firstMs: 7 });
  });

  it('NO MODEL IS LOADED: with none that can see in memory, nothing is asked at all, and the output says so', async () => {
    for (const loaded of [[], [{ name: SMALL, context_length: 4096 }]]) {
      const s = modelServer({ loaded, installed: [{ name: MAIN, vision: true }, { name: SMALL, vision: false }], answer: RIGHT });
      const r = await runVisionBench(ARGS, deps(s));
      expect(s.chats()).toEqual([]);
      expect(s.sent.every((x) => ['/api/version', '/api/ps', '/api/tags', '/api/show'].includes(x.path))).toBe(true);
      expect(r.notAsked).toBe('No model that can see is in memory, so none was asked: this benchmark never loads a model.');
      expect(r.pictures).toEqual([]);
      expect(r.model).toBeUndefined();
      // The PDFs are still read: that asks no model.
      expect(r.pdfReads).toHaveLength(PDFS.length);
    }
  });

  it('a model that is named and not in memory, cannot see, or is not installed is not asked; the last gets its download command, printed and never run', async () => {
    const s = modelServer({ loaded: [{ name: MAIN, context_length: 16384 }], installed: [{ name: MAIN, vision: true }, { name: SMALL, vision: false }, { name: 'cold:30b', vision: true }], answer: RIGHT });
    expect((await runVisionBench({ ...ARGS, model: 'cold:30b' }, deps(s))).notAsked).toBe('The model named is not in memory, so it was not asked: this benchmark never loads a model.');
    expect((await runVisionBench({ ...ARGS, model: SMALL }, deps(s))).notAsked).toBe('The model server does not say the model named can see, so it was not asked.');
    const missing = await runVisionBench({ ...ARGS, model: 'other:7b' }, deps(s));
    expect(missing.notAsked).toBe('The model named is not on this model server, so no model was asked.');
    expect(missing.hints).toContainEqual({ what: 'To download it (nothing is downloaded for you):', command: 'ollama pull other:7b' });
    expect(s.chats()).toEqual([]);
    expect(s.sent.some((x) => x.path.includes('pull'))).toBe(false);
  });

  it('a model server on another machine, or reached through a proxy, is not asked a single thing', async () => {
    for (const env of [{ OLLAMA_HOST: 'http://gpu-box.example:11434' }, { OLLAMA_HOST: 'https://gpu-box.example:11434', FLINT_LOCAL_ALLOW_REMOTE: '1' }, { NODE_USE_ENV_PROXY: '1', HTTP_PROXY: 'http://proxy.corp.example:3128' }, { OLLAMA_HOST: 'not a url' }]) {
      const s = healthy();
      const r = await runVisionBench(ARGS, deps(s, { env }));
      expect(s.sent, JSON.stringify(env)).toEqual([]);
      expect(r.notAsked).toMatch(/no model was asked/);
      expect(r.model).toBeUndefined();
    }
  });

  it('a reader that is not on this Mac is not run: the command that installs it is printed', async () => {
    const s = healthy();
    const made: string[] = [];
    const r = await runVisionBench(ARGS, deps(s, { reader: (which) => (made.push(`${which.reader}:${which.program}`), goodReader(which.reader)) }));
    expect(made).toEqual(['spotlight:/usr/bin/mdimport']);
    expect(r.hints).toContainEqual({ what: 'pdftotext is not on this Mac, so it was not measured. To install it:', command: INSTALL_PDFTOTEXT });
    expect(INSTALL_PDFTOTEXT).toBe('brew install poppler');
    // With both there, both are measured, each by its own full path.
    const both: string[] = [];
    const two = await runVisionBench(ARGS, deps(healthy(), { exists: () => true, reader: (which) => (both.push(`${which.reader}:${which.program}`), goodReader(which.reader)) }));
    expect(both).toEqual(['spotlight:/usr/bin/mdimport', 'pdftotext:/opt/homebrew/bin/pdftotext']);
    expect(two.pdfReads).toHaveLength(PDFS.length * 2);
    expect(two.pdfQuestions.map((q) => `${q.reader}/${q.id}`)).toEqual(['spotlight/invoice', 'spotlight/long', 'pdftotext/invoice', 'pdftotext/long']);
    expect(two.hints).toEqual([]);
    // With neither, nothing is read and no PDF question is asked; the pictures still are.
    const none = await runVisionBench(ARGS, deps(healthy(), { exists: () => false }));
    expect(none.pdfReads).toEqual([]);
    expect(none.pdfQuestions).toEqual([]);
    expect(none.pictures).toHaveLength(PICTURES.length);
  });

  it('it says when the models in memory are not the ones that were there when it began', async () => {
    const s = modelServer({ loaded: [{ name: MAIN, context_length: 16384 }], installed: [{ name: MAIN, vision: true }], answer: RIGHT, unloadAfterChat: true });
    const r = await runVisionBench(ARGS, deps(s));
    expect(r.unchanged).toBe(false);
    expect(r.remarks.join(' ')).toContain('This benchmark sent nothing that loads or unloads a model');
    expect(renderVision(r)).toContain('The models in memory changed during the run.');
  });

  it('what it saves is the pictures and the PDFs it made; nothing of the environment', async () => {
    const s = healthy();
    const d = deps(s, { env: { OPENAI_API_KEY: 'sk-SECRETKEY', ANTHROPIC_API_KEY: 'sk-ant-SECRETKEY' } });
    const r = await runVisionBench(ARGS, d);
    expect([...d.saved.keys()].sort()).toEqual([...PICTURES.map((c) => `${c.id}.png`), ...PDFS.map((c) => `${c.id}.pdf`)].sort());
    expect(JSON.stringify(r) + renderVision(r) + d.lines.join('\n')).not.toContain('SECRETKEY');
  });
});

describe('the page', () => {
  it('has the three tables, the numbers, and the sentence that nothing was changed; no picture’s bytes', async () => {
    const s = healthy();
    const r = await runVisionBench(ARGS, deps(s));
    const page = renderVision(r);
    expect(page).toContain('# Vision benchmark');
    expect(page).toContain(`Asked of ${MAIN} at the context it is loaded with (16384). 6 of 6 right (100%).`);
    expect(page).toContain('| words | the words MAPLE 4827 | MAPLE 4827 | yes | 7 ms |');
    expect(page).toContain('| spotlight | invoice | two pages, plain |');
    expect(page).toContain('| exact | 4 of 4 | 2 of 2 |');
    expect(page).toContain('| no text | n/a | n/a of 1 |');
    expect(page).toContain(`| spotlight | long | ${pdfChars(16384).toLocaleString('en-US')} of `);
    expect(page).toContain('The same models are in memory, with the same context, as before the run.');
    expect(page).toContain('Nothing was downloaded, loaded or installed, and no setting was changed.');
    expect(page).toContain('    brew install poppler');
    expect(page).not.toContain(PICTURES[0]!.make().toString('base64').slice(0, 40));
  });

  it('with no model asked it says why, in the place of each table', async () => {
    const s = modelServer({ loaded: [], installed: [], down: true });
    const page = renderVision(await runVisionBench(ARGS, deps(s)));
    expect(page).toContain('The model server is not answering, so no model was asked.');
    expect(page).not.toContain('| Picture |');
  });
});

describe('the command', () => {
  const run = async (argv: string[], server = healthy(), out?: string) => {
    const lines = { out: [] as string[], err: [] as string[] };
    const code = await main(out ? [...argv, '--out', out] : argv, { env: {}, home: '/nonexistent-home', out: (l) => lines.out.push(l), err: (l) => lines.err.push(l), bench: { fetch: server.fetch, exists: (p) => p === '/usr/bin/mdimport', reader: (which) => goodReader(which.reader), machine: { chip: 'Apple M5 Max', memoryGb: 64, os: '27.0' } } });
    return { code, ...lines, server };
  };

  it('arguments that are not understood: exit 2, the usage, and nothing asked', async () => {
    const r = await run(['--pull']);
    expect(r.code).toBe(2);
    expect(r.err.join('\n')).toContain('usage: pnpm --filter server vision-bench');
    expect(r.server.sent).toEqual([]);
    expect((await run(['--help'])).out.join('\n')).toContain('usage:');
  });

  it('saves the pictures, the PDFs and the results in a folder only this user can read, and prints the page', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'flint-vision-bench-'));
    dirs.push(dir);
    const out = join(dir, 'run');
    const r = await run([], healthy(), out);
    expect(r.code).toBe(0);
    expect(statSync(out).mode & 0o777).toBe(0o700);
    const files = readdirSync(out).sort();
    expect(files).toEqual([...PICTURES.map((c) => `${c.id}.png`), ...PDFS.map((c) => `${c.id}.pdf`), 'results.json', 'results.md'].sort());
    for (const f of files) expect(statSync(join(out, f)).mode & 0o777, f).toBe(0o600);
    expect(readFileSync(join(out, 'results.md'), 'utf8')).toContain('6 of 6 right');
    expect(JSON.parse(readFileSync(join(out, 'results.json'), 'utf8'))).toMatchObject({ model: { name: MAIN, context: 16384 }, unchanged: true });
    expect(r.out.join('\n')).toContain('# Vision benchmark');
    expect(r.err.join('\n')).toContain(`The pictures, the PDFs and the results are in ${out}.`);
  });

  it('--json prints the results as JSON; a folder that cannot be made is said, and the results are still printed', async () => {
    const r = await run(['--json'], healthy(), '/nonexistent-root/run');
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out.join('\n'))).toMatchObject({ model: { name: MAIN } });
    expect(r.err.join('\n')).toContain('The results could not be saved to the output folder. They are printed below.');
  });

  // ~/.flint is what the nightly and the offsite backups carry. A review ran the command with --out under it, and
  // the run's pictures and PDFs were written there.
  it('an output folder that is Flint’s own folder, or inside it, is refused: exit 2, nothing written, nothing asked', async () => {
    const home = mkdtempSync(join(tmpdir(), 'flint-vision-home-'));
    dirs.push(home);
    mkdirSync(join(home, '.flint'));
    for (const out of [join(home, '.flint'), join(home, '.flint', 'bench'), join(home, '.flint', 'a', 'b', 'c'), `${join(home, '.flint')}${sep}..${sep}.flint${sep}x`]) {
      const lines = { out: [] as string[], err: [] as string[] };
      const server = healthy();
      const code = await main(['--out', out], { env: {}, home, out: (l) => lines.out.push(l), err: (l) => lines.err.push(l), bench: { fetch: server.fetch, exists: (p) => p === '/usr/bin/mdimport', reader: (which) => goodReader(which.reader), machine: { chip: 'x', memoryGb: 1, os: '1' } } });
      expect(code, out).toBe(2);
      expect(lines.err).toEqual([OUT_UNDER_FLINT]);
      expect(lines.out).toEqual([]);
      expect(server.sent).toEqual([]);
    }
    expect(readdirSync(join(home, '.flint'))).toEqual([]);
    // A link that leads into it is it.
    const link = join(home, 'elsewhere');
    symlinkSync(join(home, '.flint'), link);
    const lines: string[] = [];
    expect(await main(['--out', join(link, 'bench')], { env: {}, home, out: () => {}, err: (l) => lines.push(l), bench: { fetch: healthy().fetch, exists: () => false, machine: { chip: 'x', memoryGb: 1, os: '1' } } })).toBe(2);
    expect(lines).toEqual([OUT_UNDER_FLINT]);
    expect(existsSync(join(home, '.flint', 'bench'))).toBe(false);
    // A folder that only looks like it is not it.
    const near = join(home, '.flint-bench');
    expect(await main(['--out', near], { env: {}, home, out: () => {}, err: () => {}, bench: { fetch: healthy().fetch, exists: () => false, machine: { chip: 'x', memoryGb: 1, os: '1' } } })).toBe(0);
    expect(existsSync(join(near, 'results.md'))).toBe(true);
  });

  it('the rule itself: by the path as written, and by where the nearest folder that exists really is', () => {
    const o = { resolve, sep };
    expect(underFlint('/Users/w/.flint', '/Users/w', o)).toBe(true);
    expect(underFlint('/Users/w/.flint/bench/run', '/Users/w', o)).toBe(true);
    expect(underFlint('/Users/w/.flint/../.flint/x', '/Users/w', o)).toBe(true);
    expect(underFlint('/Users/w/.flintstones', '/Users/w', o)).toBe(false);
    expect(underFlint('/Users/w/Library/Caches/Flint/vision-bench/x', '/Users/w', o)).toBe(false);
    expect(underFlint('/Users/other/.flint', '/Users/w', o)).toBe(false);
    // The default folder is never under it.
    expect(underFlint(defaultOut('/Users/w', '2026-10-13T12:00:00.000Z', join), '/Users/w', o)).toBe(false);
    const real = (path: string): string | undefined => {
      try {
        return realpathSync(path);
      } catch {
        return undefined;
      }
    };
    expect(underFlint('/nonexistent-root/a/b', '/nonexistent-home', { ...o, real })).toBe(false);
    expect(OUT_UNDER_FLINT).toMatch(/^vision-bench: .*\.$/);
  });

  it('nothing to measure at all: exit 1', async () => {
    const lines: string[] = [];
    const code = await main(['--out', '/nonexistent-root/run'], { env: {}, home: '/nonexistent-home', out: (l) => lines.push(l), err: () => {}, bench: { fetch: modelServer({ loaded: [], installed: [], down: true }).fetch, exists: () => false, machine: { chip: 'x', memoryGb: 1, os: '1' } } });
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('No PDF reader is on this Mac.');
  });
});
