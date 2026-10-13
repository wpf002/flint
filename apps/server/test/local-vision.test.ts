import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EMBEDDING_MODEL, Flint, OllamaProvider, type Attachment, type Message } from '@flint/core';
import { buildInference, type Inference, type RouteAsk } from '../src/inference';
import type { Hardware } from '../src/hardware';
import { liveOllamaOptions } from '../src/local-model';
import type { ModeRoute, OpenRoute } from '../src/mode-route';
import { LOCALITY } from '../src/ollama-locality';
import type { PdfReader, PdfText } from '../src/pdf-text';
import { setPlaceRules } from '../src/policy';
import { Sheet, textPdf } from '../src/synthetic-files';
import { mediaNeeds } from '../src/attachments';
import { startMockLocalServer, type MockLocalServer, type MockModel } from './mock-local-server';

/**
 * Pictures and PDFs for the local model, as main() holds it: the two settings
 * (FLINT_LOCAL_VISION, FLINT_LOCAL_PDF), both off unless Will sets them.
 *
 * Off (the default), every request, route and status here is what it was
 * before the settings existed. On, a local model its server says can see is
 * sent a turn's pictures on Ollama's own wire, a PDF's text is read here and
 * handed to the local model, and a turn that stays on this Mac with either is
 * answered on this Mac. A file the local model cannot read is still never
 * answered blind.
 *
 * The model server is a stand-in on 127.0.0.1 (./mock-local-server), the PDF
 * reader is a stand-in too, and the pictures and PDFs are synthetic
 * (../src/synthetic-files). No program is run and nothing leaves the test.
 */

const MAIN = 'main-model:30b';
const SMALL = 'small-model:3b';
const EMBED = EMBEDDING_MODEL.model;
const SEES = ['completion', 'tools', 'vision'];
const BLIND = ['completion', 'tools'];
const MAC: Hardware = { platform: 'darwin', arch: 'arm64', accelerator: 'apple-silicon', memoryGb: 64, systemMemoryGb: 64, chip: 'Apple M5 Max', notes: [] };

let server: MockLocalServer | undefined;
const dirs: string[] = [];
const built: Inference[] = [];
afterEach(async () => {
  for (const i of built.splice(0)) i.stop();
  await server?.close();
  server = undefined;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  LOCALITY.clear();
  setPlaceRules({});
});

/** A reader that answers by a word the PDF holds, and counts how often it was asked. */
function standInReader(table: Record<string, PdfText>): PdfReader & { reads: string[] } {
  const reads: string[] = [];
  return {
    kind: 'spotlight',
    reads,
    async read(bytes) {
      const key = Object.keys(table).find((k) => Buffer.from(bytes).includes(`(${k}`));
      reads.push(key ?? '?');
      return key === undefined ? { ok: false, why: 'failed' } : table[key]!;
    },
  };
}

async function boot(models: Record<string, MockModel>, env: Record<string, string> = {}, opts: { reader?: PdfReader; kind?: MockLocalServer['kind']; programs?: string[] } = {}) {
  server = await startMockLocalServer({ kind: opts.kind ?? 'ollama', models });
  const dir = mkdtempSync(join(tmpdir(), 'flint-local-vision-'));
  dirs.push(dir);
  const lines: string[] = [];
  const address = opts.kind === 'llamacpp' || env.FLINT_LOCAL_PROVIDER === 'openai' ? { FLINT_LOCAL_BASE_URL: server.baseURL, OLLAMA_HOST: server.origin } : { OLLAMA_HOST: server.origin };
  const inference = await buildInference({
    env: { ...address, OLLAMA_MODEL: MAIN, OLLAMA_NUM_CTX: '16384', OLLAMA_THINK: 'false', ...env },
    modeFile: join(dir, 'inference.json'),
    log: (m) => lines.push(m),
    connect: async () => undefined,
    detect: async () => MAC,
    pick: { capMs: 500 },
    fileExists: (path) => (opts.programs ?? ['/usr/bin/mdimport']).includes(path),
    ...(opts.reader ? { pdfReader: opts.reader } : {}),
  });
  built.push(inference);
  await inference.ready;
  return { inference, lines, s: server };
}

const PNG_BYTES = new Sheet(64, 32).text('HI', 4, 4, 3).png();
const PNG: Attachment = { kind: 'image', mediaType: 'image/png', name: 'shot.png', data: PNG_BYTES.toString('base64'), bytes: PNG_BYTES.length };
const pdf = (name: string, word: string): Attachment => {
  const bytes = textPdf([[`${word} is what this page says.`]]);
  return { kind: 'document', mediaType: 'application/pdf', name, data: bytes.toString('base64'), bytes: bytes.length };
};
const INVOICE = pdf('invoice.pdf', 'invoice');
const SCAN = pdf('scan.pdf', 'scan');
const FLAKY = pdf('flaky.pdf', 'flaky');
const READS: Record<string, PdfText> = { invoice: { ok: true, text: 'The total due is 1,284.50 dollars.', cut: false, pages: 1 }, scan: { ok: false, why: 'no_text' }, flaky: { ok: false, why: 'failed' } };

const user = (content: string, attachments: Attachment[]): Message => ({ id: 'u1', role: 'user', content, timestamp: 0, attachments });
const ask = (over: Partial<RouteAsk> & { files?: Attachment[] } = {}): RouteAsk => {
  const { files, ...rest } = over;
  return { message: 'what is in this?', localOnly: false, deep: false, evalMode: false, hasFrontier: true, needs: mediaNeeds(files ?? []), frontierCan: { image: true, pdf: true }, ...(files ? { attachments: files } : {}), ...rest };
};
const sentUser = (s: MockLocalServer): { content: string; images?: string[] } => {
  const body = s.chats().at(-1)!.body as { messages: Array<{ role: string; content: string; images?: string[] }> };
  return body.messages.filter((m) => m.role === 'user').at(-1)!;
};
const who = { primary: { persona: 'P-main', model: MAIN }, standby: { persona: 'P-small', model: SMALL } };
const names = (p: { steps: Array<{ kind: string; which?: string }> }) => p.steps.map((s) => (s.kind === 'cloud' ? 'cloud' : s.which === 'primary' ? 'main' : 'standby'));
const route = (over: Partial<ModeRoute>): ModeRoute => ({ brain: 'local', localFallback: true, cloudFallback: false, reason: 'mode_local', mode: 'local', private: false, ...over });

describe('pictures on Ollama’s own wire', () => {
  it('with nothing set, no picture is sent, though the model server says the model can see: the request is the plain client’s, byte for byte', async () => {
    const { inference, s } = await boot({ [MAIN]: { loaded: true, contextLength: 16384, capabilities: SEES }, [EMBED]: {} });
    expect(inference.cfg.local.vision).toBe(false);
    expect(inference.localCan()).toEqual({ image: false, pdf: false });
    const env = { OLLAMA_HOST: s.origin, OLLAMA_MODEL: MAIN, OLLAMA_NUM_CTX: '16384', OLLAMA_THINK: 'false' };
    const before = new OllamaProvider({ ...liveOllamaOptions(env), capabilities: () => ({ toolCalling: 'native', maxContextTokens: 32768 }) });
    s.requests.length = 0;
    await before.generate({ model: MAIN, messages: [user('what is this?', [PNG])] });
    await inference.primary.provider.generate({ model: MAIN, messages: [user('what is this?', [PNG])] });
    const [was, now] = s.chats();
    expect(now!.body).toEqual(was!.body);
    expect(sentUser(s).images).toBeUndefined();
    expect(sentUser(s).content).toContain('this model cannot read images');
    expect(JSON.stringify(now!.body)).not.toContain(PNG.data);
  });

  it('FLINT_LOCAL_VISION=off is the same as unset', async () => {
    const { inference, s } = await boot({ [MAIN]: { loaded: true, contextLength: 16384, capabilities: SEES }, [EMBED]: {} }, { FLINT_LOCAL_VISION: 'off' });
    expect(inference.localCan().image).toBe(false);
    await inference.primary.provider.generate({ model: MAIN, messages: [user('q', [PNG])] });
    expect(sentUser(s).images).toBeUndefined();
    expect(inference.cfg.problems).toEqual([]);
  });

  it('on, a model its server says can see is sent the picture, as Ollama takes it, and no note says it cannot be seen', async () => {
    const { inference, s } = await boot({ [MAIN]: { loaded: true, contextLength: 16384, capabilities: SEES }, [EMBED]: {} }, { FLINT_LOCAL_VISION: 'on' });
    expect(inference.localCan()).toEqual({ image: true, pdf: false });
    await inference.primary.provider.generate({ model: MAIN, messages: [user('what is this?', [PNG])] });
    expect(sentUser(s)).toEqual({ role: 'user', content: 'what is this?', images: [PNG.data] });
    // Everything else about the request is what it was: the model, the window, thinking.
    expect(s.chats().at(-1)!.body).toMatchObject({ model: MAIN, think: false, options: { num_ctx: 16384 } });
  });

  it('on, and the model server does NOT say the model can see: nothing is sent, and the local model is not said to read pictures', async () => {
    const { inference, s } = await boot({ [MAIN]: { loaded: true, contextLength: 16384, capabilities: BLIND }, [EMBED]: {} }, { FLINT_LOCAL_VISION: 'on' });
    expect(inference.localCan().image).toBe(false);
    await inference.primary.provider.generate({ model: MAIN, messages: [user('q', [PNG])] });
    expect(sentUser(s).images).toBeUndefined();
    expect(sentUser(s).content).toContain('this model cannot read images');
  });

  it('on, with a model server too old to say what its models can do: nothing is sent (not known is not yes)', async () => {
    const { inference, s } = await boot({ [MAIN]: { loaded: true, contextLength: 16384, capabilities: [] }, [EMBED]: {} }, { FLINT_LOCAL_VISION: 'on' });
    expect(inference.localCan().image).toBe(false);
    await inference.primary.provider.generate({ model: MAIN, messages: [user('q', [PNG])] });
    expect(sentUser(s).images).toBeUndefined();
  });

  it('the standby is asked of ITS model: a small one that cannot see is sent no picture while the main one is', async () => {
    const { inference, s } = await boot({ [MAIN]: { loaded: true, contextLength: 16384, capabilities: SEES }, [SMALL]: { loaded: true, contextLength: 4096, capabilities: BLIND }, [EMBED]: {} }, { FLINT_LOCAL_VISION: 'on', FLINT_INFERENCE_MODE: 'local', FLINT_LOCAL_FALLBACK_MODEL: SMALL });
    await inference.standby!.provider.generate({ model: SMALL, messages: [user('q', [PNG])] });
    expect(sentUser(s).images).toBeUndefined();
    await inference.primary.provider.generate({ model: MAIN, messages: [user('q', [PNG])] });
    expect(sentUser(s).images).toEqual([PNG.data]);
  });

  it('through the whole client: a picture turn reaches the model with its picture, and the answer comes back', async () => {
    const { inference, s } = await boot({ [MAIN]: { loaded: true, contextLength: 16384, capabilities: SEES, replies: [{ text: 'It says HI.' }] }, [EMBED]: {} }, { FLINT_LOCAL_VISION: 'on' });
    const flint = new Flint({ provider: inference.primary.provider, defaultModel: MAIN });
    const out = await flint.generate({ messages: [user('what does it say?', [PNG])] });
    expect(out.text).toBe('It says HI.');
    expect(sentUser(s).images).toEqual([PNG.data]);
  });
});

describe('a turn the standby would answer', () => {
  const models = (standbySees: boolean): Record<string, MockModel> => ({
    [MAIN]: { loaded: false, loadMs: 50, capabilities: SEES },
    [SMALL]: { loaded: true, contextLength: 4096, capabilities: standbySees ? SEES : BLIND },
    [EMBED]: {},
  });

  it('with a picture the standby cannot see, the standby is not asked: the turn waits for the main model, or goes to the cloud when it may', async () => {
    const { inference } = await boot(models(false), { FLINT_LOCAL_VISION: 'on', FLINT_INFERENCE_MODE: 'local', FLINT_LOCAL_FALLBACK_MODEL: SMALL });
    // The main model is not in memory: a plain turn is the standby's.
    expect(names(inference.planLocal(route({}), who))).toEqual(['standby']);
    expect(names(inference.planLocal(route({}), { ...who, needs: {} }))).toEqual(['standby']);
    // A picture turn is not: the standby would answer without having seen it.
    const plan = inference.planLocal(route({}), { ...who, needs: { image: true } });
    expect(plan.steps).toEqual([]);
    expect(plan.refusal).toBe("Flint's local model is still loading. Try again in a moment.");
    expect(names(inference.planLocal(route({ mode: 'hybrid', reason: 'default', cloudFallback: true }), { ...who, needs: { image: true } }))).toEqual(['cloud']);
  });

  it('with a picture the standby can see, it answers as for any turn', async () => {
    const { inference } = await boot(models(true), { FLINT_LOCAL_VISION: 'on', FLINT_INFERENCE_MODE: 'local', FLINT_LOCAL_FALLBACK_MODEL: SMALL });
    expect(names(inference.planLocal(route({}), { ...who, needs: { image: true } }))).toEqual(['standby']);
  });

  it('a PDF is text to any local model once it is read here: the standby may answer it; with no reader it may not', async () => {
    const on = await boot(models(false), { FLINT_LOCAL_PDF: 'spotlight', FLINT_INFERENCE_MODE: 'local', FLINT_LOCAL_FALLBACK_MODEL: SMALL }, { reader: standInReader(READS) });
    expect(names(on.inference.planLocal(route({}), { ...who, needs: { pdf: true } }))).toEqual(['standby']);
    expect(on.inference.planLocal(route({}), { ...who, needs: { image: true, pdf: true } }).steps).toEqual([]);
    on.inference.stop();
    await server?.close();
    const off = await boot(models(false), { FLINT_INFERENCE_MODE: 'local', FLINT_LOCAL_FALLBACK_MODEL: SMALL });
    expect(off.inference.planLocal(route({}), { ...who, needs: { pdf: true } }).steps).toEqual([]);
  });
});

describe('a PDF for the local model', () => {
  const models: Record<string, MockModel> = { [MAIN]: { loaded: true, contextLength: 16384, capabilities: BLIND, replies: [{ text: 'It is 1,284.50 dollars.' }] }, [SMALL]: { loaded: true, contextLength: 4096, capabilities: BLIND }, [EMBED]: {} };

  it('with nothing set no PDF is read: no reader is built or asked, and the local model is told a file it cannot read is there, as before', async () => {
    const reader = standInReader(READS);
    const { inference, s } = await boot(models, {}, { reader });
    expect(inference.cfg.local.pdf).toBeUndefined();
    expect(inference.localCan()).toEqual({ image: false, pdf: false });
    await inference.primary.provider.generate({ model: MAIN, messages: [user('what is the total?', [INVOICE])] });
    expect(sentUser(s).content).toContain('this model cannot read this file type');
    expect(reader.reads).toEqual([]);
  });

  it('on, the local model is handed the PDF’s text, the standby too, and the PDF itself goes nowhere', async () => {
    const reader = standInReader(READS);
    const { inference, s } = await boot(models, { FLINT_LOCAL_PDF: 'spotlight', FLINT_LOCAL_FALLBACK_MODEL: SMALL, FLINT_INFERENCE_MODE: 'local' }, { reader });
    expect(inference.cfg.local.pdf).toEqual({ reader: 'spotlight', program: '/usr/bin/mdimport' });
    expect(inference.localCan()).toEqual({ image: false, pdf: true });
    const flint = new Flint({ provider: inference.primary.provider, defaultModel: MAIN });
    const out = await flint.generate({ messages: [user('what is the total?', [INVOICE])] });
    expect(out.text).toBe('It is 1,284.50 dollars.');
    expect(sentUser(s).content).toBe('<attached_file name="invoice.pdf" type="text/plain">\n[This is the text of the PDF, which has 1 page, read on this Mac. Its pictures and its layout are not here.]\n\nThe total due is 1,284.50 dollars.\n</attached_file>\n\nwhat is the total?');
    await inference.standby!.provider.generate({ model: SMALL, messages: [user('and again?', [INVOICE])] });
    expect(sentUser(s).content).toContain('The total due is 1,284.50 dollars.');
    // One read for both models: it is kept by what the PDF holds.
    expect(reader.reads).toEqual(['invoice']);
    for (const c of s.requests) expect(JSON.stringify(c.body ?? {})).not.toContain(INVOICE.data);
  });

  it('the wrapped adapter is still the local adapter to everything that asks where it is: its name, its address, its window', async () => {
    const { inference, s } = await boot(models, { FLINT_LOCAL_PDF: 'spotlight' }, { reader: standInReader(READS) });
    const p = inference.primary.provider as { name: string; baseURL?: string; numCtx?: number };
    expect(p.name).toBe('ollama');
    expect(p.baseURL).toBe(s.origin);
    expect(p.numCtx).toBe(16384);
    expect(inference.confined).toEqual({ ok: true });
  });

  it('a reader that is named and not on this Mac: refused by name, no PDF is read, and the stand-in is never asked', async () => {
    const reader = standInReader(READS);
    const { inference, lines } = await boot(models, { FLINT_LOCAL_PDF: 'pdftotext' }, { reader });
    expect(inference.cfg.local.pdf).toBeUndefined();
    expect(inference.localCan().pdf).toBe(false);
    expect(lines.join('\n')).toContain('FLINT_LOCAL_PDF is set to pdftotext, which is not installed on this Mac');
    expect((await inference.status()).notices).toContain("The PDF reader named in Flint's setup isn't on this Mac, so no PDF is read here.");
  });

  it('on the OpenAI-compatible wire too', async () => {
    const reader = standInReader(READS);
    const { inference, s } = await boot(models, { FLINT_LOCAL_PROVIDER: 'openai', FLINT_LOCAL_PDF: 'spotlight' }, { reader });
    expect(inference.localCan().pdf).toBe(true);
    await inference.primary.provider.generate({ model: MAIN, messages: [user('what is the total?', [INVOICE])] });
    const body = JSON.stringify(s.chats().at(-1)!.body);
    expect(body).toContain('The total due is 1,284.50 dollars.');
    expect(body).not.toContain(INVOICE.data);
  });
});

describe('routing a turn with a picture or a PDF', () => {
  const sees: Record<string, MockModel> = { [MAIN]: { loaded: true, contextLength: 16384, capabilities: SEES }, [EMBED]: {} };

  it('with nothing set, every answer is what it was: Local mode refuses, Local Only refuses, the cloud answers', async () => {
    const { inference } = await boot(sees, {});
    expect(await inference.routeFirst(ask({ files: [PNG] }))).toMatchObject({ brain: 'frontier', localFallback: false, reason: 'mode_cloud' });
    expect(await inference.routeFirst(ask({ files: [PNG], localOnly: true }))).toEqual({ error: "Local-only is on, and the on-device brain can't read images. Turn Local-only off to send the file to the frontier brain, or remove the attachment.", status: 422 });
    expect(await inference.routeFirst(ask({ files: [INVOICE], hasFrontier: false }))).toEqual({ error: "The local brain can't read PDFs, and no frontier brain is configured. Send it as text instead.", status: 422 });
    inference.mode.set('local', 'console');
    expect(await inference.routeFirst(ask({ files: [PNG] }))).toEqual({ error: "The local model can't read images, and Local mode never uses the cloud. Send it as text instead.", status: 422 });
    expect(await inference.routeFirst(ask({ files: [INVOICE] }))).toEqual({ error: "The local model can't read PDFs, and Local mode never uses the cloud. Send it as text instead.", status: 422 });
    inference.mode.set('hybrid', 'console');
    expect(await inference.routeFirst(ask({ files: [PNG] }))).toMatchObject({ open: true, mediaLocalCannotRead: true });
    expect((await inference.localReads(ask({ files: [PNG] }))).keptCan).toBeUndefined();
  });

  it('pictures on: Local mode answers a picture turn here, and so does a turn Will kept private, in every mode', async () => {
    const { inference } = await boot(sees, { FLINT_LOCAL_VISION: 'on' });
    // Cloud mode: a turn a cloud model answers goes to it as before.
    expect(await inference.routeFirst(ask({ files: [PNG] }))).toMatchObject({ brain: 'frontier', localFallback: false, reason: 'mode_cloud' });
    expect(await inference.routeFirst(ask({ files: [PNG], localOnly: true }))).toEqual({ brain: 'local', localFallback: true, cloudFallback: false, reason: 'mode_cloud', mode: 'cloud', private: true });
    expect(await inference.routeFirst(ask({ files: [PNG], message: 'keep this private: what is it?' }))).toMatchObject({ brain: 'local', private: true });
    expect(await inference.routeFirst(ask({ files: [PNG], hasFrontier: false }))).toMatchObject({ brain: 'local', private: false });
    inference.mode.set('local', 'console');
    expect(await inference.routeFirst(ask({ files: [PNG] }))).toMatchObject({ brain: 'local', reason: 'mode_local', cloudFallback: false });
    inference.mode.set('hybrid', 'console');
    const open = (await inference.routeFirst(ask({ files: [PNG] }))) as OpenRoute;
    expect(open).toMatchObject({ open: true, mediaLocalCannotRead: false });
    const priv = (await inference.routeFirst(ask({ files: [PNG], localOnly: true }))) as OpenRoute;
    expect(inference.finishRoute(priv, { tier: 'standard', toolsLikely: false, promptChars: 40 })).toEqual({ brain: 'local', localFallback: true, cloudFallback: false, reason: 'private', mode: 'hybrid', private: true });
  });

  it('pictures on, and a PDF on the same turn with no reader: still refused, and the words name the PDF alone', async () => {
    const { inference } = await boot(sees, { FLINT_LOCAL_VISION: 'on', FLINT_INFERENCE_MODE: 'local' });
    expect(await inference.routeFirst(ask({ files: [PNG, INVOICE] }))).toEqual({ error: "The local model can't read PDFs, and Local mode never uses the cloud. Send it as text instead.", status: 422 });
  });

  it('pictures on, and a model that cannot see: refused exactly as with the setting off', async () => {
    const { inference } = await boot({ [MAIN]: { loaded: true, contextLength: 16384, capabilities: BLIND }, [EMBED]: {} }, { FLINT_LOCAL_VISION: 'on', FLINT_INFERENCE_MODE: 'local' });
    expect(await inference.routeFirst(ask({ files: [PNG] }))).toEqual({ error: "The local model can't read images, and Local mode never uses the cloud. Send it as text instead.", status: 422 });
  });

  it('PDFs on: a PDF with text is answered here; it is read once, before the route, and the request finds it read', async () => {
    const reader = standInReader(READS);
    const { inference, s } = await boot({ [MAIN]: { loaded: true, contextLength: 16384, capabilities: BLIND }, [EMBED]: {} }, { FLINT_LOCAL_PDF: 'spotlight', FLINT_INFERENCE_MODE: 'local' }, { reader });
    expect(await inference.routeFirst(ask({ files: [INVOICE] }))).toMatchObject({ brain: 'local', reason: 'mode_local' });
    expect(reader.reads).toEqual(['invoice']);
    await inference.primary.provider.generate({ model: MAIN, messages: [user('what is the total?', [INVOICE])] });
    expect(reader.reads).toEqual(['invoice']);
    expect(sentUser(s).content).toContain('The total due is 1,284.50 dollars.');
  });

  it('PDFs on: a PDF with no text in it, or one the read failed on, is refused in words that say which, in every mode that keeps it here', async () => {
    const reader = standInReader(READS);
    const { inference, s } = await boot({ [MAIN]: { loaded: true, contextLength: 16384, capabilities: BLIND }, [EMBED]: {} }, { FLINT_LOCAL_PDF: 'spotlight', FLINT_INFERENCE_MODE: 'local' }, { reader });
    expect(await inference.routeFirst(ask({ files: [SCAN] }))).toEqual({ error: 'This PDF has no text in it that Flint can read on this Mac, and Local mode never uses the cloud. Send it as text instead.', status: 422 });
    expect(await inference.routeFirst(ask({ files: [FLAKY] }))).toEqual({ error: "Flint couldn't read this PDF on this Mac just now, and Local mode never uses the cloud. Send it as text instead.", status: 422 });
    // One good PDF beside one that cannot be read: the turn is not answered on half of what was sent.
    expect(await inference.routeFirst(ask({ files: [INVOICE, SCAN] }))).toMatchObject({ error: expect.stringContaining('This PDF has no text in it'), status: 422 });
    inference.mode.set('cloud', 'console');
    expect(await inference.routeFirst(ask({ files: [SCAN], localOnly: true }))).toEqual({
      error: 'Local-only is on, and this PDF has no text in it that Flint can read on this Mac. Turn Local-only off to send the file to the frontier brain, or remove the attachment.',
      status: 422,
    });
    expect(await inference.routeFirst(ask({ files: [SCAN], hasFrontier: false }))).toEqual({ error: 'This PDF has no text in it that Flint can read on this Mac, and no frontier brain is configured. Send it as text instead.', status: 422 });
    inference.mode.set('hybrid', 'console');
    expect(await inference.routeFirst(ask({ files: [SCAN], localOnly: true }))).toMatchObject({ error: expect.stringContaining('this PDF has no text in it'), status: 422 });
    // Not private, in Hybrid: it goes to a cloud model that reads PDFs, by the rule for a file the local model cannot read.
    const open = (await inference.routeFirst(ask({ files: [SCAN] }))) as OpenRoute;
    expect(open).toMatchObject({ open: true, mediaLocalCannotRead: true });
    expect(inference.finishRoute(open, { tier: 'standard', toolsLikely: false, promptChars: 40 })).toMatchObject({ brain: 'frontier', localFallback: false, reason: 'media' });
    // Nothing of any refused turn reached the model.
    expect(s.chats()).toEqual([]);
  });

  it('PDFs on, Cloud mode: a turn a cloud model answers is not read here at all; one Will kept private is, and is answered here', async () => {
    const reader = standInReader(READS);
    const { inference } = await boot({ [MAIN]: { loaded: true, contextLength: 16384, capabilities: BLIND }, [EMBED]: {} }, { FLINT_LOCAL_PDF: 'spotlight' }, { reader });
    expect(await inference.routeFirst(ask({ files: [INVOICE] }))).toMatchObject({ brain: 'frontier', localFallback: false, reason: 'mode_cloud' });
    expect(reader.reads).toEqual([]);
    expect(await inference.routeFirst(ask({ files: [INVOICE], localOnly: true }))).toEqual({ brain: 'local', localFallback: true, cloudFallback: false, reason: 'mode_cloud', mode: 'cloud', private: true });
    expect(reader.reads).toEqual(['invoice']);
  });

  it('an eval replay that names its own local model is asked through a client of its own: nothing is said to be readable by it, and it is refused as before', async () => {
    const reader = standInReader(READS);
    const { inference } = await boot(sees, { FLINT_LOCAL_VISION: 'on', FLINT_LOCAL_PDF: 'spotlight' }, { reader });
    const replay = { evalMode: true, localOnly: true };
    // The main model's own replay runs here, with what it can read.
    expect(await inference.routeFirst(ask({ ...replay, files: [PNG] }))).toMatchObject({ brain: 'local', reason: 'eval' });
    expect(await inference.routeFirst(ask({ ...replay, files: [INVOICE] }))).toMatchObject({ brain: 'local', reason: 'eval' });
    reader.reads.length = 0;
    // One that names another model: refused in the old words, and no PDF is read for it.
    expect(await inference.routeFirst(ask({ ...replay, files: [PNG], ownLocalModel: true }))).toEqual({ error: "Local-only is on, and the on-device brain can't read images. Turn Local-only off to send the file to the frontier brain, or remove the attachment.", status: 422 });
    expect(await inference.routeFirst(ask({ ...replay, files: [INVOICE], ownLocalModel: true }))).toEqual({ error: "Local-only is on, and the on-device brain can't read PDFs. Turn Local-only off to send the file to the frontier brain, or remove the attachment.", status: 422 });
    expect(reader.reads).toEqual([]);
    expect(await inference.localReads(ask({ ...replay, files: [PNG], ownLocalModel: true }))).toEqual({ localCan: {} });
    // A replay with no file is routed as ever.
    expect(await inference.routeFirst(ask({ ...replay, ownLocalModel: true }))).toMatchObject({ brain: 'local', reason: 'eval' });
  });

  it('a PDF the local model is handed counts toward how long the prompt is: in Hybrid a long one with a long thread goes to the cloud', async () => {
    const long: PdfText = { ok: true, text: 'word '.repeat(20_000), cut: false, pages: 40 };
    const reader = standInReader({ ...READS, invoice: long });
    const { inference } = await boot({ [MAIN]: { loaded: true, contextLength: 16384, capabilities: BLIND }, [EMBED]: {} }, { FLINT_LOCAL_PDF: 'spotlight', FLINT_INFERENCE_MODE: 'hybrid' }, { reader });
    // Before the turn's PDFs are read, and with no reader at all, a PDF adds nothing.
    expect(inference.pdfTextChars([INVOICE])).toBe(0);
    const open = (await inference.routeFirst(ask({ files: [INVOICE] }))) as OpenRoute;
    expect(open).toMatchObject({ open: true, mediaLocalCannotRead: false });
    const chars = inference.pdfTextChars([INVOICE]);
    expect(chars).toBeGreaterThan(22_936);
    expect(chars).toBeLessThan(22_936 + 400);
    expect(inference.pdfTextChars([PNG])).toBe(0);
    // On its own it fits the local window, and is answered here...
    expect(inference.finishRoute(open, { tier: 'standard', toolsLikely: false, promptChars: 40 + chars })).toMatchObject({ brain: 'local', reason: 'default' });
    // ...and with a thread behind it that fills the rest, the long-context rule sends it to the cloud, as for any long prompt.
    expect(inference.finishRoute(open, { tier: 'standard', toolsLikely: false, promptChars: 40 + chars + 20_000 })).toMatchObject({ brain: 'frontier', reason: 'long_context' });
    expect(inference.finishRoute(open, { tier: 'standard', toolsLikely: false, promptChars: 40 + 20_000 })).toMatchObject({ brain: 'local' });
  });

  it('with no reader a PDF adds nothing to the prompt’s size', async () => {
    const { inference } = await boot(sees, {});
    expect(inference.pdfTextChars([INVOICE, PNG])).toBe(0);
  });

  it('PDFs on, and the route is told of a PDF it was not handed: nothing was read, so nothing is said to be readable', async () => {
    const reader = standInReader(READS);
    const { inference } = await boot({ [MAIN]: { loaded: true, contextLength: 16384, capabilities: BLIND }, [EMBED]: {} }, { FLINT_LOCAL_PDF: 'spotlight', FLINT_INFERENCE_MODE: 'local' }, { reader });
    expect(await inference.routeFirst(ask({ needs: { pdf: true } }))).toEqual({ error: "The local model can't read PDFs, and Local mode never uses the cloud. Send it as text instead.", status: 422 });
    expect(await inference.routeFirst(ask({ needs: { pdf: true }, files: [PNG] }))).toMatchObject({ error: expect.stringContaining("can't read") });
    expect(reader.reads).toEqual([]);
  });

  it('both on: a turn with a picture and a PDF is answered here, with the picture as a picture and the PDF as text', async () => {
    const reader = standInReader(READS);
    const { inference, s } = await boot(sees, { FLINT_LOCAL_VISION: 'on', FLINT_LOCAL_PDF: 'spotlight', FLINT_INFERENCE_MODE: 'local' }, { reader });
    expect(await inference.routeFirst(ask({ files: [PNG, INVOICE] }))).toMatchObject({ brain: 'local', reason: 'mode_local' });
    await inference.primary.provider.generate({ model: MAIN, messages: [user('compare them', [PNG, INVOICE])] });
    const sent = sentUser(s);
    expect(sent.images).toEqual([PNG.data]);
    expect(sent.content).toContain('The total due is 1,284.50 dollars.');
    expect(sent.content).not.toContain('cannot read');
  });

  it('the OpenAI-compatible wire with nothing set is as it was: Local mode answers a picture a model can see, and a turn Cloud mode keeps is still refused', async () => {
    const { inference } = await boot(sees, { FLINT_LOCAL_PROVIDER: 'openai' });
    expect(inference.localCan().image).toBe(true);
    expect(await inference.routeFirst(ask({ files: [PNG], localOnly: true }))).toEqual({ error: "Local-only is on, and the on-device brain can't read images. Turn Local-only off to send the file to the frontier brain, or remove the attachment.", status: 422 });
    inference.mode.set('local', 'console');
    expect(await inference.routeFirst(ask({ files: [PNG] }))).toMatchObject({ brain: 'local', reason: 'mode_local' });
  });
});

describe('what the console is told the local model reads (GET /health `localReads`)', () => {
  const sees: Record<string, MockModel> = { [MAIN]: { loaded: true, contextLength: 16384, capabilities: SEES }, [EMBED]: {} };

  it('nothing at all with both settings off, whatever the model can do: the console says what it always said', async () => {
    expect((await boot(sees, {})).inference.readsForConsole()).toBeUndefined();
    built.splice(0).forEach((i) => i.stop());
    await server?.close();
    expect((await boot(sees, { FLINT_LOCAL_PROVIDER: 'openai' })).inference.readsForConsole()).toBeUndefined();
  });

  it('with one on: each kind, as the local model reads it now', async () => {
    expect((await boot(sees, { FLINT_LOCAL_VISION: 'on' })).inference.readsForConsole()).toEqual({ images: true, pdfs: false });
    built.splice(0).forEach((i) => i.stop());
    await server?.close();
    expect((await boot({ [MAIN]: { loaded: true, contextLength: 16384, capabilities: BLIND }, [EMBED]: {} }, { FLINT_LOCAL_VISION: 'on' })).inference.readsForConsole()).toEqual({ images: false, pdfs: false });
    built.splice(0).forEach((i) => i.stop());
    await server?.close();
    expect((await boot(sees, { FLINT_LOCAL_PDF: 'spotlight' }, { reader: standInReader(READS) })).inference.readsForConsole()).toEqual({ images: false, pdfs: true });
    built.splice(0).forEach((i) => i.stop());
    await server?.close();
    expect((await boot(sees, { FLINT_LOCAL_VISION: 'on', FLINT_LOCAL_PDF: 'spotlight' }, { reader: standInReader(READS) })).inference.readsForConsole()).toEqual({ images: true, pdfs: true });
  });
});

describe('the status', () => {
  const sees: Record<string, MockModel> = { [MAIN]: { loaded: true, contextLength: 16384, capabilities: SEES }, [EMBED]: {} };
  const ABOUT = /picture|PDF/i;

  it('with nothing set says nothing of pictures or PDFs, and off is the same as unset, field for field', async () => {
    const unset = await (await boot(sees, {})).inference.status();
    expect(unset.lines.filter((l) => ABOUT.test(l))).toEqual([]);
    expect('pictures' in unset.local).toBe(false);
    expect('pdfReader' in unset.local).toBe(false);
    built.splice(0).forEach((i) => i.stop());
    await server?.close();
    const off = await (await boot(sees, { FLINT_LOCAL_VISION: 'off', FLINT_LOCAL_PDF: 'off' })).inference.status();
    const plain = (st: typeof unset) => JSON.parse(JSON.stringify(st).replaceAll(/127\.0\.0\.1:\d+/g, 'HOST')) as unknown;
    expect(plain(off)).toEqual(plain(unset));
  });

  it('with both on says each, in a sentence and as a field', async () => {
    const st = await (await boot(sees, { FLINT_LOCAL_VISION: 'on', FLINT_LOCAL_PDF: 'spotlight' }, { reader: standInReader(READS) })).inference.status();
    expect(st.lines).toContain('Pictures are sent to the local model, which its server says can see.');
    expect(st.lines).toContain("A PDF's text is read on this Mac for the local model, by the Mac's own PDF importer.");
    expect(st.local.pictures).toBe(true);
    expect(st.local.pdfReader).toBe('spotlight');
    expect(st.problems).toEqual([]);
    expect(st.notices.filter((n) => ABOUT.test(n))).toEqual([]);
  });

  it('pictures on with a model that cannot see: the status says none is sent', async () => {
    const st = await (await boot({ [MAIN]: { loaded: true, contextLength: 16384, capabilities: BLIND }, [EMBED]: {} }, { FLINT_LOCAL_VISION: 'on' })).inference.status();
    expect(st.lines).toContain('Pictures for the local model are turned on, and its server does not say this model can see, so none is sent to it.');
    expect(st.local.pictures).toBe(false);
  });

  it('a value that was refused is a plain sentence for the console, with no key and no value in it', async () => {
    const st = await (await boot(sees, { FLINT_LOCAL_VISION: 'maybe', FLINT_LOCAL_PDF: '/usr/bin/mdimport' })).inference.status();
    expect(st.notices).toContain("The pictures setting in Flint's setup isn't valid, so no picture is sent to the local model.");
    expect(st.notices).toContain("The PDF setting in Flint's setup isn't one it knows, so no PDF is read here.");
    expect(st.notices.join('\n')).not.toMatch(/FLINT_|maybe|mdimport/);
    expect(st.local.pictures).toBeUndefined();
  });

  it('the status command builds no reader and reads nothing: it only says what the settings are', async () => {
    server = await startMockLocalServer({ models: sees });
    const dir = mkdtempSync(join(tmpdir(), 'flint-local-vision-'));
    dirs.push(dir);
    const reader = standInReader(READS);
    const inference = await buildInference({ env: { OLLAMA_HOST: server.origin, OLLAMA_MODEL: MAIN, FLINT_LOCAL_PDF: 'spotlight' }, modeFile: join(dir, 'inference.json'), connect: async () => undefined, detect: async () => MAC, pick: { capMs: 500 }, fileExists: () => true, observeOnly: true, pdfReader: reader });
    built.push(inference);
    await inference.ready;
    const st = await inference.status();
    expect(st.local.pdfReader).toBe('spotlight');
    expect(inference.localCan().pdf).toBe(false);
    expect(reader.reads).toEqual([]);
  });
});
