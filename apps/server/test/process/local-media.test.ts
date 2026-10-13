/**
 * The real server, run as a process, with pictures and PDFs for the local
 * model set three ways (../../src/local-media): nothing set, pictures on, and
 * PDFs on.
 *
 * What a unit test cannot see is here: what the running server really puts on
 * each wire for a turn that carries a file. A turn Will kept on this Mac with
 * a picture goes to the model server on this Mac WITH the picture, and the
 * outside brain is sent neither the picture nor a word of the turn, then or on
 * the next turn of the conversation. With nothing set, the same turn is
 * refused in the words it always was, and nothing is sent anywhere.
 *
 * Three servers, each on its own scratch HOME, against loopback stand-ins
 * (./stubs), fenced so that nothing else can be reached (./guard.mjs):
 *  - `plain`:  no setting. The model server says its model can see;
 *  - `vision`: FLINT_LOCAL_VISION=on, same model server;
 *  - `pdf`:    FLINT_LOCAL_PDF=spotlight: NOT in the default run (see below).
 *
 * THE TESTS THAT READ A PDF FOR REAL ARE OPT-IN. The server runs the Mac's own
 * PDF importer by its full path (/usr/bin/mdimport), never by a name a PATH
 * could answer, so it cannot be a stand-in here; and this file is part of
 * `pnpm --filter server test`, which the deploy gate runs on the live Mac,
 * where a busy moment must not fail a deploy. They run only with
 * FLINT_TEST_REAL_PDF=1, on a Mac:
 *
 *   FLINT_TEST_REAL_PDF=1 pnpm --filter server test:process
 *
 * (install-server.sh clears that name before the gate's tests.) The importer
 * is asked for a test import of a synthetic PDF in a folder that is the
 * server's own (its TMPDIR, which is this test's): nothing is stored in
 * Spotlight's index, nothing is shown, and the folder is checked to be empty
 * afterwards. In the default run the same code is held by stand-ins
 * (../pdf-text.test.ts, ../local-media.test.ts, ../local-vision.test.ts).
 *
 * The pictures and PDFs are synthetic (../../src/synthetic-files).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Sheet, textPdf } from '../../src/synthetic-files';
import { makePdfReader } from '../../src/pdf-text';
import { startCloudStub, startOllamaStub, type CloudStub, type OllamaStub } from './stubs';
import { scratch, startServer, type Reply, type Running } from './rig';

const MAIN = 'main-model:30b';
const models = (): Record<string, { loaded?: boolean; contextLength?: number; family?: string; capabilities?: string[] }> => ({ [MAIN]: { loaded: true, contextLength: 16384, capabilities: ['completion', 'tools', 'vision'] }, 'nomic-embed-text': { family: 'nomic-bert' } });
/** Words that are in a message, a picture's name or a PDF and nowhere else, so a wire or a log can be searched for them. */
const SECRET = 'ZEBRAQUARTZ';
const PDF_SECRET = 'GARNETHERON';
const ON_A_MAC = process.platform === 'darwin';
/** The tests that run the Mac's own PDF importer for real: only when asked for by name, and never by the deploy gate. */
const REAL_PDF = ON_A_MAC && process.env.FLINT_TEST_REAL_PDF === '1';
// The room this file has under `test:process` (vitest.process.config.ts), when it runs with every other test.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const PNG_B64 = new Sheet(160, 48).text('MAPLE 48', 8, 8, 4).png().toString('base64');
const picture = (name = 'shot.png') => ({ name, type: 'image/png', data: PNG_B64 });
const PDF_B64 = textPdf([[`The ${PDF_SECRET} invoice is for 1,284.50 dollars.`, 'It is due on the ninth of March.'], ['Page two: deliver to 18 Larch Lane.']]).toString('base64');
const BLANK_PDF_B64 = textPdf([[]]).toString('base64');
const pdfFile = (data = PDF_B64, name = 'invoice.pdf') => ({ name, type: 'application/pdf', data });

const cloudEnv = (cloud: CloudStub): Record<string, string> => ({ ANTHROPIC_API_KEY: 'sk-ant-process-test-not-a-key', ANTHROPIC_BASE_URL: cloud.origin });
const blocked = (srv: Running): Array<{ kind: string; hostname?: string }> => srv.guard().filter((e) => e.kind.endsWith('blocked'));
const lastUser = (ollama: OllamaStub): { content?: string; images?: string[] } | undefined => {
  const body = ollama.chats().at(-1)?.body as { messages?: Array<{ role: string; content?: string; images?: string[] }> } | undefined;
  return body?.messages?.filter((m) => m.role === 'user').at(-1);
};
const meta = (r: Reply): Record<string, unknown> | undefined => r.events?.find((e) => e.type === 'meta' && typeof e.staysHere === 'boolean');
const REFUSED_LOCAL_ONLY = "Local-only is on, and the on-device brain can't read images. Turn Local-only off to send the file to the frontier brain, or remove the attachment.";

interface Booted {
  ollama: OllamaStub;
  cloud: CloudStub;
  srv: Running;
}
async function boot(dir: string, env: Record<string, string>): Promise<Booted> {
  const [ollama, cloud] = await Promise.all([startOllamaStub(models()), startCloudStub()]);
  const srv = await startServer({ dir, env: { OLLAMA_HOST: ollama.origin, OLLAMA_MODEL: MAIN, OLLAMA_NUM_CTX: '16384', ...cloudEnv(cloud), ...env } });
  return { ollama, cloud, srv };
}

const runs = { plain: scratch('lm-plain'), vision: scratch('lm-vision'), pdf: scratch('lm-pdf') };
let plain: Booted;
let vision: Booted;
let pdf: (Booted & { tmp: string }) | undefined;
const temps: string[] = [];

beforeAll(async () => {
  const pdfTmp = REAL_PDF ? mkdtempSync(join(tmpdir(), 'lm-')) : undefined;
  if (pdfTmp) temps.push(pdfTmp);
  const [a, b, c] = await Promise.all([
    boot(runs.plain.dir, {}),
    boot(runs.vision.dir, { FLINT_LOCAL_VISION: 'on' }),
    pdfTmp ? boot(runs.pdf.dir, { FLINT_LOCAL_PDF: 'spotlight', TMPDIR: pdfTmp }) : Promise.resolve(undefined),
  ]);
  plain = a;
  vision = b;
  pdf = c && pdfTmp ? { ...c, tmp: pdfTmp } : undefined;
});

afterAll(async () => {
  for (const b of [plain, vision, pdf]) {
    await b?.srv.stop();
    await b?.ollama.close();
    await b?.cloud.close();
  }
  for (const r of Object.values(runs)) r.cleanup();
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});

describe('nothing set: a turn with a picture or a PDF is what it always was', () => {
  it('Cloud mode: the outside brain answers a picture turn, and the model server on this Mac is sent no picture', async () => {
    const { srv, ollama, cloud } = plain;
    const r = await srv.post('/chat', { conversationId: 'plain-open', message: 'what does this say?', attachments: [picture()] });
    expect(r.status).toBe(200);
    expect(r.text).toContain('CLOUD(');
    expect(cloud.saw(PNG_B64)).toBe(true);
    expect(ollama.saw(PNG_B64)).toBe(false);
  });

  it('Local Only with a picture is refused in the old words, though the model server says its model can see, and nothing is sent anywhere', async () => {
    const { srv, ollama, cloud } = plain;
    const [chats, clouds] = [ollama.chats().length, cloud.requests.length];
    const r = await srv.post('/chat', { conversationId: 'plain-kept', message: `${SECRET} what does this say?`, localOnly: true, attachments: [picture()] });
    expect(r).toMatchObject({ status: 422, json: { error: REFUSED_LOCAL_ONLY } });
    const g = await srv.post('/generate', { prompt: `${SECRET} what does this say?`, localOnly: true, attachments: [picture()] });
    expect(g).toMatchObject({ status: 422, json: { error: REFUSED_LOCAL_ONLY } });
    const p = await srv.post('/chat', { conversationId: 'plain-kept', message: `${SECRET} what is the total?`, localOnly: true, attachments: [pdfFile()] });
    expect(p).toMatchObject({ status: 422, json: { error: "Local-only is on, and the on-device brain can't read PDFs. Turn Local-only off to send the file to the frontier brain, or remove the attachment." } });
    expect(ollama.chats().length).toBe(chats);
    expect(cloud.requests.length).toBe(clouds);
    expect(ollama.saw(SECRET)).toBe(false);
    expect(cloud.saw(SECRET)).toBe(false);
  });

  it('Local mode refuses a picture and a PDF in its own old words', async () => {
    const { srv, ollama } = plain;
    expect((await srv.post('/inference/mode', { mode: 'local' })).status).toBe(200);
    const chats = ollama.chats().length;
    expect(await srv.post('/chat', { conversationId: 'plain-local', message: 'what does this say?', attachments: [picture()] })).toMatchObject({ status: 422, json: { error: "The local model can't read images, and Local mode never uses the cloud. Send it as text instead." } });
    expect(await srv.post('/chat', { conversationId: 'plain-local', message: 'what is the total?', attachments: [pdfFile()] })).toMatchObject({ status: 422, json: { error: "The local model can't read PDFs, and Local mode never uses the cloud. Send it as text instead." } });
    expect(ollama.chats().length).toBe(chats);
    expect((await srv.post('/inference/mode', { mode: 'cloud' })).status).toBe(200);
  });

  it('the status says nothing of pictures or PDFs, and no connection was refused', async () => {
    const { srv } = plain;
    const st = (await srv.get('/inference')).json as { local?: Record<string, unknown>; lines?: string[] };
    expect(st.local).toBeDefined();
    expect('pictures' in st.local!).toBe(false);
    expect('pdfReader' in st.local!).toBe(false);
    expect((st.lines ?? []).length).toBeGreaterThan(3);
    expect((st.lines ?? []).filter((l) => /picture|PDF/i.test(l))).toEqual([]);
    expect(blocked(srv)).toEqual([]);
  });
});

describe('FLINT_LOCAL_VISION=on', () => {
  it('a turn a cloud model answers is unchanged: the picture goes to it, and not to the model server', async () => {
    const { srv, ollama, cloud } = vision;
    const r = await srv.post('/chat', { conversationId: 'vision-open', message: 'what does this say?', attachments: [picture()] });
    expect(r.status).toBe(200);
    expect(r.text).toContain('CLOUD(');
    expect(cloud.saw(PNG_B64)).toBe(true);
    expect(ollama.saw(PNG_B64)).toBe(false);
  });

  it('Local Only with a picture is answered by the model on this Mac, which is sent the picture; the outside brain is sent nothing of the turn', async () => {
    const { srv, ollama, cloud } = vision;
    const clouds = cloud.requests.length;
    const r = await srv.post('/chat', { conversationId: 'vision-kept', message: `${SECRET} what does this say?`, localOnly: true, attachments: [picture(`${SECRET}-shot.png`)] });
    expect(r.status).toBe(200);
    expect(r.text).toBe(`LOCAL(${MAIN}) reply.`);
    expect(meta(r)).toMatchObject({ staysHere: true });
    const sent = lastUser(ollama)!;
    expect(sent.images).toEqual([PNG_B64]);
    expect(sent.content).toContain(`${SECRET} what does this say?`);
    expect(sent.content).not.toContain('cannot read images');
    expect(cloud.requests.length).toBe(clouds);
    expect(cloud.saw(SECRET)).toBe(false);
    // The log names the file at most: never its bytes.
    expect(srv.log()).not.toContain(PNG_B64.slice(0, 60));
  });

  it('the next turn of that conversation goes to the outside brain without the picture and without a word of the private turn', async () => {
    const { srv, cloud } = vision;
    const from = cloud.requests.length;
    const r = await srv.post('/chat', { conversationId: 'vision-kept', message: 'and what is two plus two?' });
    expect(r.status).toBe(200);
    expect(r.text).toContain('CLOUD(');
    expect(cloud.requests.length).toBeGreaterThan(from);
    expect(cloud.saw(PNG_B64, from)).toBe(false);
    expect(cloud.saw(SECRET, from)).toBe(false);
    expect(cloud.saw('shot.png', from)).toBe(false);
  });

  it('a one-shot answer is the same: kept here, with the picture, and nothing outside', async () => {
    const { srv, ollama, cloud } = vision;
    const clouds = cloud.requests.length;
    const r = await srv.post('/generate', { prompt: `${SECRET} read this to me`, localOnly: true, attachments: [picture()] });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ text: `LOCAL(${MAIN}) reply.`, brain: 'local' });
    expect(lastUser(ollama)!.images).toEqual([PNG_B64]);
    expect(cloud.requests.length).toBe(clouds);
  });

  it('the words alone keep it here too', async () => {
    const { srv, ollama, cloud } = vision;
    const clouds = cloud.requests.length;
    const r = await srv.post('/chat', { conversationId: 'vision-words', message: 'keep this private: what does this say?', attachments: [picture()] });
    expect(r.status).toBe(200);
    expect(r.text).toBe(`LOCAL(${MAIN}) reply.`);
    expect(lastUser(ollama)!.images).toEqual([PNG_B64]);
    expect(cloud.requests.length).toBe(clouds);
  });

  it('a PDF on a private turn is still refused (nothing reads PDFs here), and a picture with it does not get the turn through', async () => {
    const { srv, ollama } = vision;
    const chats = ollama.chats().length;
    const r = await srv.post('/chat', { conversationId: 'vision-pdf', message: 'compare these', localOnly: true, attachments: [picture(), pdfFile()] });
    expect(r).toMatchObject({ status: 422, json: { error: "Local-only is on, and the on-device brain can't read PDFs. Turn Local-only off to send the file to the frontier brain, or remove the attachment." } });
    expect(ollama.chats().length).toBe(chats);
  });

  it('Local mode answers a picture turn on this Mac, and the outside brain is not asked', async () => {
    const { srv, ollama, cloud } = vision;
    expect((await srv.post('/inference/mode', { mode: 'local' })).status).toBe(200);
    const clouds = cloud.requests.length;
    const r = await srv.post('/chat', { conversationId: 'vision-local', message: 'what does this say?', attachments: [picture()] });
    expect(r.status).toBe(200);
    expect(r.text).toBe(`LOCAL(${MAIN}) reply.`);
    expect(lastUser(ollama)!.images).toEqual([PNG_B64]);
    expect(cloud.requests.length).toBe(clouds);
    expect((await srv.post('/inference/mode', { mode: 'cloud' })).status).toBe(200);
  });

  it('the status says so, and no connection was refused', async () => {
    const { srv } = vision;
    const st = (await srv.get('/inference')).json as { local: Record<string, unknown>; lines: string[] };
    expect(st.local.pictures).toBe(true);
    expect(st.lines).toContain('Pictures are sent to the local model, which its server says can see.');
    expect(blocked(srv)).toEqual([]);
  });
});

describe.runIf(REAL_PDF)('FLINT_LOCAL_PDF=spotlight, with the Mac’s own importer (opt-in: FLINT_TEST_REAL_PDF=1)', () => {
  it('Local Only with a PDF: the model on this Mac is handed its text, and the outside brain neither the PDF nor a word of it', async () => {
    const { srv, ollama, cloud, tmp } = pdf!;
    const clouds = cloud.requests.length;
    const r = await srv.post('/chat', { conversationId: 'pdf-kept', message: 'what is the total?', localOnly: true, attachments: [pdfFile()] });
    expect(r.status).toBe(200);
    expect(r.text).toBe(`LOCAL(${MAIN}) reply.`);
    const sent = lastUser(ollama)!;
    expect(sent.content).toContain('<attached_file name="invoice.pdf" type="text/plain">');
    expect(sent.content).toContain('[This is the text of the PDF, which has 2 pages, read on this Mac. Its pictures and its layout are not here.]');
    expect(sent.content).toContain(`The ${PDF_SECRET} invoice is for 1,284.50 dollars.\nIt is due on the ninth of March.\nPage two: deliver to 18 Larch Lane.`);
    expect(sent.images).toBeUndefined();
    expect(ollama.saw(PDF_B64)).toBe(false);
    expect(cloud.requests.length).toBe(clouds);
    expect(cloud.saw(PDF_SECRET)).toBe(false);
    expect(srv.log()).not.toContain(PDF_SECRET);
    // The folder the PDF was read in is gone.
    expect(readdirSync(tmp).filter((n) => n.startsWith('flint-pdf-'))).toEqual([]);
  });

  it('the next turn goes to the outside brain without the PDF and without its text', async () => {
    const { srv, cloud } = pdf!;
    const from = cloud.requests.length;
    const r = await srv.post('/chat', { conversationId: 'pdf-kept', message: 'and what is two plus two?' });
    expect(r.text).toContain('CLOUD(');
    expect(cloud.saw(PDF_SECRET, from)).toBe(false);
    expect(cloud.saw(PDF_B64, from)).toBe(false);
  });

  it('a turn a cloud model answers is sent the PDF itself, as before, and it is not read here', async () => {
    const { srv, ollama, cloud } = pdf!;
    const chats = ollama.chats().length;
    const r = await srv.post('/chat', { conversationId: 'pdf-open', message: 'what is the total?', attachments: [pdfFile()] });
    expect(r.text).toContain('CLOUD(');
    expect(cloud.saw(PDF_B64)).toBe(true);
    expect(ollama.chats().length).toBe(chats);
  });

  it('a PDF with no text in it is refused in words that say so, and the model is not asked', async () => {
    const { srv, ollama, tmp } = pdf!;
    const chats = ollama.chats().length;
    const r = await srv.post('/chat', { conversationId: 'pdf-blank', message: 'what does it say?', localOnly: true, attachments: [pdfFile(BLANK_PDF_B64, 'scan.pdf')] });
    expect(r).toMatchObject({ status: 422, json: { error: 'Local-only is on, and this PDF has no text in it that Flint can read on this Mac. Turn Local-only off to send the file to the frontier brain, or remove the attachment.' } });
    expect(ollama.chats().length).toBe(chats);
    expect(readdirSync(tmp).filter((n) => n.startsWith('flint-pdf-'))).toEqual([]);
  });

  it('Local mode answers a PDF turn here; the status names the reader; no connection was refused', async () => {
    const { srv, ollama, cloud } = pdf!;
    expect((await srv.post('/inference/mode', { mode: 'local' })).status).toBe(200);
    const clouds = cloud.requests.length;
    const r = await srv.post('/generate', { prompt: 'what is the total?', attachments: [pdfFile()] });
    expect(r.json).toMatchObject({ text: `LOCAL(${MAIN}) reply.`, brain: 'local' });
    expect(lastUser(ollama)!.content).toContain(`The ${PDF_SECRET} invoice`);
    expect(cloud.requests.length).toBe(clouds);
    const st = (await srv.get('/inference')).json as { local: Record<string, unknown>; lines: string[] };
    expect(st.local.pdfReader).toBe('spotlight');
    expect(st.lines).toContain("A PDF's text is read on this Mac for the local model, by the Mac's own PDF importer.");
    expect(blocked(srv)).toEqual([]);
  });
});

// The reader itself against the real importer, with no server: what it makes of synthetic PDFs on this Mac.
describe.runIf(REAL_PDF)('the Mac’s own importer, asked directly (opt-in: FLINT_TEST_REAL_PDF=1)', () => {
  const tmp = (): string => {
    const t = mkdtempSync(join(tmpdir(), 'lm-'));
    temps.push(t);
    return t;
  };

  it('two pages of text, compressed or not: the words, in order, and the page count', async () => {
    const dir = tmp();
    const reader = makePdfReader({ reader: 'spotlight', program: '/usr/bin/mdimport' }, { tmp: dir });
    const pages = [['Invoice 4471 for the QUARTZHERON workshop.', 'The total due is 1,284.50 dollars.'], ['Page two: "quoted", (bracketed) and a \\ backslash.']];
    for (const compress of [false, true]) {
      expect(await reader.read(textPdf(pages, { compress }))).toEqual({ ok: true, text: 'Invoice 4471 for the QUARTZHERON workshop.\nThe total due is 1,284.50 dollars.\nPage two: "quoted", (bracketed) and a \\ backslash.', cut: false, pages: 2 });
    }
    expect(readdirSync(dir)).toEqual([]);
  });

  it('a long PDF comes back whole: sixty pages', async () => {
    const dir = tmp();
    const reader = makePdfReader({ reader: 'spotlight', program: '/usr/bin/mdimport' }, { tmp: dir });
    const pages = Array.from({ length: 60 }, (_, p) => Array.from({ length: 40 }, (_, l) => `Page ${p + 1} line ${l + 1}: the quick brown fox jumps over the lazy dog near the river bank.`));
    const got = await reader.read(textPdf(pages, { compress: true }));
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.pages).toBe(60);
    expect(got.cut).toBe(false);
    expect(got.text.startsWith('Page 1 line 1: the quick brown fox')).toBe(true);
    expect(got.text.endsWith('Page 60 line 40: the quick brown fox jumps over the lazy dog near the river bank.')).toBe(true);
    expect(got.text.split('\n').length).toBe(60 * 40);
  });

  it('a blank page, and bytes that are no PDF at all: no text, said as that, and never an error thrown', async () => {
    const dir = tmp();
    const reader = makePdfReader({ reader: 'spotlight', program: '/usr/bin/mdimport' }, { tmp: dir });
    expect(await reader.read(textPdf([[]]))).toEqual({ ok: false, why: 'no_text' });
    expect(await reader.read(Buffer.from('%PDF-1.4\nthis is not really a PDF\n'))).toEqual({ ok: false, why: 'no_text' });
    expect(readdirSync(dir)).toEqual([]);
  });
});
