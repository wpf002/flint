/**
 * The vision benchmark: how well and how fast the local model ON THIS MAC
 * answers about a picture, and how well and how fast a PDF's text is read
 * here, measured through the same adapter and the same PDF reader a turn
 * uses (./local-brains, ./local-media, ./pdf-text). It reports numbers and
 * changes nothing: no setting is written, and no default is switched.
 *
 *   pictures  each synthetic picture is put to the model with one question
 *             whose answer is known; whether the answer is right, the time
 *             to its first word and to its last, and the tokens it cost;
 *   PDFs      each synthetic PDF is read by every reader that is on this Mac;
 *             whether the text that came back is the text that was put in,
 *             how long the read took, and then one question about it to the
 *             model, which is handed the text as a turn would hand it.
 *
 * WHAT IT RUNS, AND WHAT IT NEVER DOES
 *  - The pictures and the PDFs are SYNTHETIC: drawn and written by
 *    ./synthetic-files from fixed words. Nobody's file is read.
 *  - Only a model that is ALREADY IN MEMORY on the model server is asked,
 *    with the context it is loaded with, and nothing about how long it stays
 *    loaded is sent. So nothing is downloaded, loaded, swapped or unloaded:
 *    a model that is not in memory is not measured, and the output says so.
 *    The model server is looked at again when the run ends, and the output
 *    says whether the same models are in memory.
 *  - Only a model server on this Mac is asked (a loopback address, not
 *    through a proxy). The requests are a handful: one a picture, one a PDF.
 *  - Only a PDF reader that is already on this Mac is run. For one that is
 *    not, the command that installs it is printed, and never run.
 *  - Nothing is shown and nothing is opened.
 *  - What it leaves behind (the pictures, the PDFs, the results) goes in a
 *    folder only this user can read, under ~/Library/Caches: never under
 *    ~/.flint, which the nightly and the offsite backups carry.
 *
 * Everything that touches the machine is handed in (`VisionDeps`), so the
 * whole run is unit-tested with stand-ins: the tests ask no model and run no
 * program.
 */
import { OllamaProvider, type Attachment, type Message, type ProviderAdapter } from '@flint/core';
import { listedModels } from '@flint/policy';
import { PDF_READER_PROGRAMS, readInferenceConfig, viaProxy, type FileCheck, type PdfReaderKind } from './inference-config';
import { localMedia, pdfChars } from './local-media';
import { makePdfReader, plainText, type PdfReader, type PdfText } from './pdf-text';
import { BLACK, BLUE, GREEN, RED, Sheet, textPdf } from './synthetic-files';

type Env = Record<string, string | undefined>;

// ---------------------------------------------------------------------------
// what is asked

export interface PictureCase {
  id: string;
  /** What the picture shows, for the results. */
  shows: string;
  question: string;
  /** Every one of these is in a right answer... */
  expect: readonly RegExp[];
  /** ...and none of these. */
  reject?: readonly RegExp[];
  make(): Buffer;
}

/** The pictures: each is drawn here, so what it shows is known exactly. */
export const PICTURES: readonly PictureCase[] = [
  {
    id: 'words',
    shows: 'the words MAPLE 4827',
    question: 'What is written in this picture? Reply with the text only.',
    expect: [/maple/i, /4827/],
    make: () => new Sheet(640, 200).text('MAPLE 4827', 40, 60, 9).png(),
  },
  {
    id: 'two-lines',
    shows: 'two lines: ROOM 36 and GATE 52',
    question: 'Which number is on the same line as the word GATE? Reply with the number only.',
    expect: [/\b52\b/],
    reject: [/\b36\b/],
    make: () => new Sheet(480, 260).text('ROOM 36', 40, 40, 8).text('GATE 52', 40, 150, 8).png(),
  },
  {
    id: 'colours',
    shows: 'a red square on the left and a blue square on the right',
    question: 'What colour is the square on the left? Reply with one word.',
    expect: [/\bred\b/i],
    reject: [/\bblue\b/i],
    make: () => new Sheet(640, 320).rect(60, 60, 200, 200, RED).rect(380, 60, 200, 200, BLUE).png(),
  },
  {
    id: 'count',
    shows: 'four black squares in a row',
    question: 'How many black squares are in this picture? Reply with the number only.',
    expect: [/\b(4|four)\b/i],
    make: () => {
      const s = new Sheet(640, 200);
      for (let i = 0; i < 4; i++) s.rect(60 + i * 140, 60, 80, 80, BLACK);
      return s.png();
    },
  },
  {
    id: 'tallest',
    shows: 'three bars labelled A, B and C, of which B is the tallest',
    question: 'Which bar is the tallest: A, B or C? Reply with one letter.',
    expect: [/\bB\b/],
    reject: [/\b[AC]\b/],
    make: () => {
      const s = new Sheet(480, 360);
      const bars: Array<[string, number]> = [['A', 90], ['B', 240], ['C', 150]];
      bars.forEach(([name, height], i) => {
        const x = 70 + i * 130;
        s.rect(x, 280 - height, 80, height, BLUE).text(name, x + 25, 300, 6);
      });
      return s.png();
    },
  },
  {
    id: 'corner',
    shows: 'a green square in the top right corner',
    question: 'In which corner is the green square: top left, top right, bottom left or bottom right? Reply with the corner only.',
    expect: [/top[\s-]*right/i],
    reject: [/bottom|top[\s-]*left/i],
    make: () => new Sheet(480, 360).rect(360, 20, 100, 100, GREEN).png(),
  },
];

export interface PdfCase {
  id: string;
  shows: string;
  pages: ReadonlyArray<readonly string[]>;
  compress: boolean;
  /** The question put to the model about it, and what a right answer holds. Left out: the PDF is only read. */
  question?: string;
  expect?: readonly RegExp[];
}

const LONG_PAGES: ReadonlyArray<readonly string[]> = Array.from({ length: 60 }, (_, p) => [
  ...(p === 0 ? ['The code word of this report is HARBOR.'] : []),
  ...Array.from({ length: 40 }, (_, l) => `Page ${p + 1} line ${l + 1}: the quick brown fox jumps over the lazy dog near the river bank.`),
]);

/** The PDFs: each is written here, so the text it holds is known exactly. */
export const PDFS: readonly PdfCase[] = [
  {
    id: 'invoice',
    shows: 'two pages, plain',
    pages: [
      ['Invoice 4471 for the QUARTZHERON workshop.', 'The total due is 1,284.50 dollars by the ninth of March.'],
      ['Page two: the delivery address is 18 Larch Lane.', 'The contact is Mira Osei.'],
    ],
    compress: false,
    question: 'What is the total due on this invoice, in dollars? Reply with the number only.',
    expect: [/1,?284\.50/],
  },
  {
    id: 'marks',
    shows: 'one page, compressed, with quotes, brackets and a backslash',
    pages: [['She said "the gate code is 5291" (twice).', 'The path is C:\\reports\\march and the rate is 50% off; see <notes> & more.']],
    compress: true,
  },
  {
    id: 'long',
    shows: 'sixty pages, compressed: more text than the model is given',
    pages: LONG_PAGES,
    compress: true,
    question: 'What is the code word of this report? Reply with the one word.',
    expect: [/harbor/i],
  },
  { id: 'blank', shows: 'one page with no text on it: what a scan is to a reader of text', pages: [[]], compress: false },
];

/** The text a PDF case holds, as a reader should give it back. */
export function textOf(c: Pick<PdfCase, 'pages'>): string {
  return plainText(c.pages.map((lines) => lines.join('\n')).join('\n'));
}

/** Is an answer right: everything it should hold, and nothing it should not. */
export function isRight(answer: string, c: { expect?: readonly RegExp[]; reject?: readonly RegExp[] }): boolean {
  const said = answer.trim();
  return (c.expect ?? []).every((re) => re.test(said)) && !(c.reject ?? []).some((re) => re.test(said));
}

// ---------------------------------------------------------------------------
// arguments

export interface VisionArgs {
  help: boolean;
  json: boolean;
  out?: string;
  /** The model to ask. Left out: the first model in memory that its server says can see. */
  model?: string;
  /** How many times each question is asked. */
  runs: number;
}

export const USAGE = [
  'usage: pnpm --filter server vision-bench [-- options]',
  '  --model <name>   the model to ask (default: the model in memory that can see); it is asked only if it is already in memory',
  '  --runs <n>       how many times each question is asked, 1 to 5 (default 1)',
  '  --out <folder>   where the pictures, the PDFs and results go (default: a dated folder under ~/Library/Caches/Flint/vision-bench)',
  '  --json           print the results as JSON',
  '  --help           this text',
  'Nothing is downloaded, loaded or installed, and no setting is changed.',
].join('\n');

const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/;

export function parseVisionArgs(argv: readonly string[]): VisionArgs | { error: string } {
  const args: VisionArgs = { help: false, json: false, runs: 1 };
  const list = argv.filter((a) => a !== '--');
  for (let i = 0; i < list.length; i++) {
    const a = list[i]!;
    const value = (): string | undefined => {
      const v = list[i + 1];
      if (v === undefined || v.startsWith('--')) return undefined;
      i++;
      return v;
    };
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--json') args.json = true;
    else if (a === '--out') {
      const v = value();
      if (!v) return { error: '--out needs a folder' };
      args.out = v;
    } else if (a === '--model') {
      const v = value();
      if (!v || !MODEL_NAME.test(v)) return { error: '--model needs a model name' };
      args.model = v;
    } else if (a === '--runs') {
      const n = Number(value());
      if (!Number.isInteger(n) || n < 1 || n > 5) return { error: '--runs needs a number from 1 to 5' };
      args.runs = n;
    } else return { error: 'an option was not understood' };
  }
  return args;
}

/**
 * Is this output folder Flint's own folder, or inside it? `~/.flint` is what
 * the nightly and the offsite backups carry: a run's pictures and PDFs do not
 * belong in it, so the command refuses such a folder. By the path as written
 * and, when `real` is given, by where the nearest folder that exists really is
 * (a link into ~/.flint is ~/.flint).
 */
export function underFlint(out: string, home: string, o: { resolve: (...parts: string[]) => string; sep: string; real?: (path: string) => string | undefined }): boolean {
  const inside = (path: string, root: string): boolean => path === root || path.startsWith(root.endsWith(o.sep) ? root : `${root}${o.sep}`);
  const flint = o.resolve(home, '.flint');
  const target = o.resolve(out);
  if (inside(target, flint)) return true;
  if (!o.real) return false;
  const realFlint = o.real(flint) ?? flint;
  // The nearest ancestor that exists, as the file system has it.
  let at = target;
  for (;;) {
    const real = o.real(at);
    if (real !== undefined) return inside(real, realFlint) || inside(real, flint);
    const up = o.resolve(at, '..');
    if (up === at) return false;
    at = up;
  }
}

/** What the command says when it refuses such a folder. */
export const OUT_UNDER_FLINT = "vision-bench: the output folder may not be Flint's own folder or inside it: the backups carry that folder. Name another with --out, or leave --out off.";

/** Where a run's files go when no folder is named: under this user's caches, never under ~/.flint (a backup would carry them). */
export function defaultOut(home: string, when: string, join: (...parts: string[]) => string): string {
  return join(home, 'Library', 'Caches', 'Flint', 'vision-bench', when.replace(/[:.]/g, '-'));
}

// ---------------------------------------------------------------------------
// the model server, looked at and never changed

export interface LoadedModel {
  name: string;
  /** The context it is loaded with. */
  context: number;
}

export interface ServerLook {
  reachable: boolean;
  version?: string;
  loaded: LoadedModel[];
  installed: string[];
  /** Which installed models the server says can see. */
  sees: string[];
}

/** One GET or POST that only reads: its JSON, or undefined. */
async function ask(f: typeof fetch, url: string, body?: unknown): Promise<unknown> {
  try {
    const r = await f(url, { ...(body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), redirect: 'error', signal: AbortSignal.timeout(5_000) });
    if (!r.ok) {
      await r.body?.cancel().catch(() => {});
      return undefined;
    }
    return (await r.json()) as unknown;
  } catch {
    return undefined;
  }
}

const safeName = (v: unknown): string | undefined => (typeof v === 'string' && MODEL_NAME.test(v) ? v : undefined);

/**
 * What the model server has: its version, what is in memory and with which
 * context, what is installed, and which of those it says can see. Four kinds
 * of request, all of which only read (`/api/version`, `/api/ps`, `/api/tags`,
 * `/api/show`): none of them loads a model.
 */
export async function lookAtServer(f: typeof fetch, origin: string): Promise<ServerLook> {
  const version = (await ask(f, `${origin}/api/version`)) as { version?: unknown } | undefined;
  if (!version) return { reachable: false, loaded: [], installed: [], sees: [] };
  const ps = (await ask(f, `${origin}/api/ps`)) as { models?: Array<{ name?: unknown; context_length?: unknown }> } | undefined;
  const tags = (await ask(f, `${origin}/api/tags`)) as { models?: unknown } | undefined;
  // Which of its models run ON it, by the one rule the server itself uses (@flint/policy listedModels): a row that
  // says anything of a remote host or a remote model runs elsewhere. Such a model is not listed here, and is never
  // asked, in memory or not.
  const installed = listedModels(Array.isArray(tags?.models) ? tags.models : [])
    .filter((m) => m.here)
    .map((m) => safeName(m.name))
    .filter((n): n is string => n !== undefined);
  const loaded: LoadedModel[] = [];
  for (const m of Array.isArray(ps?.models) ? ps.models : []) {
    const name = safeName(m.name);
    const context = typeof m.context_length === 'number' && Number.isInteger(m.context_length) && m.context_length > 0 ? m.context_length : undefined;
    if (name && context && installed.includes(name)) loaded.push({ name, context });
  }
  const sees: string[] = [];
  for (const name of installed) {
    const shown = (await ask(f, `${origin}/api/show`, { model: name })) as { capabilities?: unknown } | undefined;
    if (Array.isArray(shown?.capabilities) && shown.capabilities.includes('vision')) sees.push(name);
  }
  const v = typeof version.version === 'string' ? version.version.replace(/[^0-9.]/g, '').slice(0, 20) : '';
  return { reachable: true, ...(v ? { version: v } : {}), loaded, installed, sees };
}

export type ModelPick =
  | { ok: true; model: string; context: number }
  | { ok: false; why: 'unreachable' | 'not_installed' | 'cannot_see' | 'not_in_memory' | 'none_in_memory' | 'none_sees'; model?: string };

/**
 * The model the pictures are put to: the one named, or the first in memory
 * that can see. Only ever one that is in memory already: asking any other
 * would load it, and could push out the model Flint is using.
 */
export function pickModel(look: ServerLook, wanted?: string): ModelPick {
  if (!look.reachable) return { ok: false, why: 'unreachable' };
  if (wanted) {
    if (!look.installed.includes(wanted)) return { ok: false, why: 'not_installed', model: wanted };
    if (!look.sees.includes(wanted)) return { ok: false, why: 'cannot_see', model: wanted };
    const m = look.loaded.find((l) => l.name === wanted);
    return m ? { ok: true, model: m.name, context: m.context } : { ok: false, why: 'not_in_memory', model: wanted };
  }
  const m = look.loaded.find((l) => look.sees.includes(l.name));
  if (m) return { ok: true, model: m.name, context: m.context };
  return look.sees.length > 0 ? { ok: false, why: 'none_in_memory', model: look.sees[0]! } : { ok: false, why: 'none_sees' };
}

// ---------------------------------------------------------------------------
// results

export interface Asked {
  id: string;
  shows: string;
  question: string;
  /** One entry a run. */
  answers: Array<{ text: string; right: boolean; firstMs?: number; totalMs: number; inputTokens?: number; outputTokens?: number; error?: string }>;
}

export interface PdfRead {
  reader: PdfReaderKind;
  id: string;
  shows: string;
  bytes: number;
  pages: number;
  /** Characters of text the PDF holds. */
  chars: number;
  ms: number;
  /** `text`: it came back; anything else: it did not, and why (./pdf-text PdfText). */
  outcome: 'text' | Extract<PdfText, { ok: false }>['why'];
  /** The text that came back is exactly the text that was put in. */
  exact: boolean;
  /** Of the lines put in, how many are in what came back, word for word. */
  linesFound: number;
  lines: number;
  /** The page count the reader gave, when it gave one. */
  pagesSaid?: number;
}

export interface Hint {
  what: string;
  /** The exact command, for Will to run. Never run here. */
  command?: string;
}

export interface VisionResult {
  when: string;
  machine: { chip: string; memoryGb: number; os: string };
  server: { host: string; version?: string; loaded: LoadedModel[]; sees: string[] };
  model?: { name: string; context: number };
  /** Why no model was asked, when none was. */
  notAsked?: string;
  pictures: Asked[];
  pdfReads: PdfRead[];
  pdfQuestions: Array<Asked & { reader: PdfReaderKind; given: number; chars: number }>;
  /** The same models are in memory after the run as before it. Absent when nothing was asked. */
  unchanged?: boolean;
  hints: Hint[];
  remarks: string[];
}

export interface VisionDeps {
  env: Env;
  fetch: typeof fetch;
  now: () => number;
  /** Is this program on this Mac, and may it be run? */
  exists: FileCheck;
  /** The PDF reader for a kind and its program (tests: a stand-in). */
  reader: (which: { reader: PdfReaderKind; program: string }) => PdfReader;
  /** Save one of the run's files. A failure is the caller's to swallow. */
  save: (name: string, data: Buffer | string) => void;
  machine: VisionResult['machine'];
  when: string;
  log: (line: string) => void;
}

/** Whoever asks the model: the adapter a turn uses, with the window the model is loaded with and nothing else changed. */
export function benchProvider(o: { origin: string; context: number; fetch: typeof fetch; sees: boolean }): ProviderAdapter {
  return new OllamaProvider({
    baseURL: o.origin,
    fetch: o.fetch,
    // The context the model is ALREADY loaded with: any other number would have Ollama load it again.
    defaultOptions: { num_ctx: o.context },
    // Thinking off: the answers are a word or a number, and a thinking model's reasoning is not what is being timed.
    think: false,
    capabilities: () => (o.sees ? { vision: true, maxContextTokens: o.context } : { maxContextTokens: o.context }),
  });
}

/**
 * The most tokens one answer may take. The answers are a word or a number, but a thinking model spends tokens
 * before its first word even with thinking off (Ollama drops them): measured here, forty to sixty of them. A cap
 * of 64 left one question with no answer at all.
 */
export const MAX_ANSWER_TOKENS = 256;

/** Put one message to the model and time it: the first word, the last, and what it cost. Never throws. */
export async function askModel(p: ProviderAdapter, model: string, message: Message, now: () => number): Promise<Asked['answers'][number]> {
  const began = now();
  let text = '';
  let firstMs: number | undefined;
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let error: string | undefined;
  try {
    for await (const ev of p.stream({ model, messages: [message], maxTokens: MAX_ANSWER_TOKENS })) {
      if (ev.type === 'text') {
        if (firstMs === undefined && ev.delta.length > 0) firstMs = now() - began;
        text += ev.delta;
      } else if (ev.type === 'done') {
        inputTokens = ev.usage?.input;
        outputTokens = ev.usage?.output;
      } else if (ev.type === 'error') {
        // The kind only: an error's own text can carry an address.
        error = ev.error.kind;
      }
    }
  } catch {
    error = 'failed';
  }
  return {
    text: text.trim().slice(0, 200),
    right: false,
    ...(firstMs !== undefined ? { firstMs: Math.round(firstMs) } : {}),
    totalMs: Math.round(now() - began),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(error ? { error } : {}),
  };
}

/** `brew install poppler`: what puts pdftotext on a Mac. Printed, never run. */
export const INSTALL_PDFTOTEXT = 'brew install poppler';

/** Run the benchmark. Never throws for a model or a reader that fails: that is a result. */
export async function runVisionBench(args: VisionArgs, deps: VisionDeps): Promise<VisionResult> {
  const cfg = readInferenceConfig(deps.env);
  const at = cfg.local.ollama;
  const result: VisionResult = { when: deps.when, machine: deps.machine, server: { host: at?.host ?? 'unknown', loaded: [], sees: [] }, pictures: [], pdfReads: [], pdfQuestions: [], hints: [], remarks: [] };

  // ---- the PDFs, and the readers that are on this Mac
  const files = PDFS.map((c) => ({ c, bytes: textPdf(c.pages, { compress: c.compress }), text: textOf(c) }));
  for (const f of files) deps.save(`${f.c.id}.pdf`, f.bytes);
  const readers: Array<{ kind: PdfReaderKind; reader: PdfReader }> = [];
  for (const kind of Object.keys(PDF_READER_PROGRAMS) as PdfReaderKind[]) {
    const program = PDF_READER_PROGRAMS[kind].find((p) => deps.exists(p, 'program'));
    if (!program) {
      if (kind === 'pdftotext') result.hints.push({ what: 'pdftotext is not on this Mac, so it was not measured. To install it:', command: INSTALL_PDFTOTEXT });
      else result.hints.push({ what: "The Mac's own PDF importer is not on this machine, so it was not measured." });
      continue;
    }
    readers.push({ kind, reader: deps.reader({ reader: kind, program }) });
  }
  const read = new Map<string, PdfText>();
  for (const { kind, reader } of readers) {
    for (const f of files) {
      deps.log(`Reading ${f.c.id}.pdf with ${kind}.`);
      const began = deps.now();
      const got = await reader.read(f.bytes).catch((): PdfText => ({ ok: false, why: 'failed' }));
      const ms = Math.round(deps.now() - began);
      read.set(`${kind}/${f.c.id}`, got);
      const lines = f.c.pages.flat().map((l) => plainText(l)).filter((l) => l.length > 0);
      // (Whole lines, looked up in a set: sixty pages are 2,400 of them.)
      const back = new Set(got.ok ? got.text.split('\n').map((l) => l.trim()) : []);
      result.pdfReads.push({
        reader: kind,
        id: f.c.id,
        shows: f.c.shows,
        bytes: f.bytes.length,
        pages: f.c.pages.length,
        chars: f.text.length,
        ms,
        outcome: got.ok ? 'text' : got.why,
        exact: got.ok && !got.cut && got.text === f.text,
        linesFound: lines.filter((l) => back.has(l)).length,
        lines: lines.length,
        ...(got.ok && got.pages !== undefined ? { pagesSaid: got.pages } : {}),
      });
    }
  }

  // ---- the model server
  if (!at) {
    result.notAsked = "The model server's address was refused, so no model was asked.";
    return result;
  }
  if (!at.loopback || viaProxy(at.host, cfg.local.proxy)) {
    result.notAsked = at.loopback ? 'The model server is reached through a proxy, so no model was asked: this benchmark only asks a model on this Mac.' : 'The model server is on another machine, so no model was asked: this benchmark only asks a model on this Mac.';
    return result;
  }
  const origin = `${at.origin}${at.path}`;
  const look = await lookAtServer(deps.fetch, origin);
  result.server = { host: at.host, ...(look.version ? { version: look.version } : {}), loaded: look.loaded, sees: look.sees };
  const pick = pickModel(look, args.model);
  if (!pick.ok) {
    const NOT: Record<typeof pick.why, string> = {
      unreachable: 'The model server is not answering, so no model was asked.',
      not_installed: 'The model named is not on this model server, so no model was asked.',
      cannot_see: 'The model server does not say the model named can see, so it was not asked.',
      not_in_memory: 'The model named is not in memory, so it was not asked: this benchmark never loads a model.',
      none_in_memory: 'No model that can see is in memory, so none was asked: this benchmark never loads a model.',
      none_sees: 'The model server has no model that it says can see, so none was asked.',
    };
    result.notAsked = NOT[pick.why];
    if (pick.why === 'none_in_memory' || pick.why === 'not_in_memory') {
      result.hints.push({ what: `${pick.model} can see and is not in memory. It is measured once it is: Flint loads its local model when a message needs it.` });
    }
    if (pick.why === 'none_sees' || pick.why === 'not_installed') {
      const model = pick.why === 'not_installed' ? pick.model! : undefined;
      if (model) result.hints.push({ what: 'To download it (nothing is downloaded for you):', command: `ollama pull ${model}` });
      else result.hints.push({ what: 'Flint does not download a model. A model that can see has `vision` among its capabilities: `ollama show <model>` says so.' });
    }
    return result;
  }
  result.model = { name: pick.model, context: pick.context };

  // ---- the pictures
  const sees = benchProvider({ origin, context: pick.context, fetch: deps.fetch, sees: true });
  for (const c of PICTURES) {
    const bytes = c.make();
    deps.save(`${c.id}.png`, bytes);
    const picture: Attachment = { kind: 'image', mediaType: 'image/png', name: `${c.id}.png`, data: bytes.toString('base64'), bytes: bytes.length };
    const row: Asked = { id: c.id, shows: c.shows, question: c.question, answers: [] };
    for (let n = 0; n < args.runs; n++) {
      deps.log(`Asking about ${c.id}.png.`);
      const a = await askModel(sees, pick.model, { id: `bench-${c.id}-${n}`, role: 'user', content: c.question, timestamp: 0, attachments: [picture] }, deps.now);
      row.answers.push({ ...a, right: !a.error && isRight(a.text, c) });
    }
    result.pictures.push(row);
  }

  // ---- a question about each PDF that has one, through the wrapper a turn's adapter wears
  for (const { kind, reader } of readers) {
    // (The reads above are handed over, so a PDF is not read a second time for its question.)
    const kept: PdfReader = { kind, read: async (bytes) => read.get(`${kind}/${files.find((f) => f.bytes.equals(Buffer.from(bytes)))?.c.id ?? ''}`) ?? reader.read(bytes) };
    const media = localMedia(kept);
    const provider = media.provider(benchProvider({ origin, context: pick.context, fetch: deps.fetch, sees: false }));
    for (const f of files) {
      if (!f.c.question) continue;
      const doc: Attachment = { kind: 'document', mediaType: 'application/pdf', name: `${f.c.id}.pdf`, data: f.bytes.toString('base64'), bytes: f.bytes.length };
      const got = await media.text(doc);
      const row: VisionResult['pdfQuestions'][number] = { reader: kind, id: f.c.id, shows: f.c.shows, question: f.c.question, answers: [], given: 0, chars: f.text.length };
      if (!got.ok) {
        row.answers.push({ text: '', right: false, totalMs: 0, error: got.why });
        result.pdfQuestions.push(row);
        continue;
      }
      // How much of the text the model is handed: a share of its window at most (./local-media PDF_SHARE).
      row.given = Math.min(got.text.length, pdfChars(pick.context));
      for (let n = 0; n < args.runs; n++) {
        deps.log(`Asking about ${f.c.id}.pdf, read by ${kind}.`);
        const a = await askModel(provider, pick.model, { id: `bench-${f.c.id}-${n}`, role: 'user', content: f.c.question, timestamp: 0, attachments: [doc] }, deps.now);
        row.answers.push({ ...a, right: !a.error && isRight(a.text, { expect: f.c.expect ?? [] }) });
      }
      result.pdfQuestions.push(row);
    }
  }

  // ---- the model server, looked at again
  const after = await lookAtServer(deps.fetch, origin);
  const names = (l: ServerLook): string => l.loaded.map((m) => `${m.name}@${m.context}`).sort().join(' ');
  result.unchanged = after.reachable && names(after) === names(look);
  result.remarks.push(`Thinking was off for every question, and each answer was held to ${MAX_ANSWER_TOKENS} tokens.`);
  if (!result.unchanged) result.remarks.push('The models in memory are not the ones that were there when the run began. This benchmark sent nothing that loads or unloads a model; something else did.');
  return result;
}

// ---------------------------------------------------------------------------
// the page

const pct = (n: number, of: number): string => (of === 0 ? 'n/a' : `${Math.round((n / of) * 100)}%`);
const median = (list: number[]): number | undefined => {
  if (list.length === 0) return undefined;
  const s = [...list].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : Math.round((s[s.length / 2 - 1]! + s[s.length / 2]!) / 2);
};
const ms = (n: number | undefined): string => (n === undefined ? 'n/a' : n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${n} ms`);
const cell = (s: string): string => s.replace(/\|/g, '/').replace(/\s+/g, ' ').trim();

/** The results as a page of text: what was measured, in tables, and what was not, in sentences. */
export function renderVision(r: VisionResult): string {
  const out: string[] = [];
  out.push('# Vision benchmark', '');
  out.push(`${r.machine.chip}, ${r.machine.memoryGb} GB, macOS ${r.machine.os}. Run at ${r.when}.`);
  out.push(`Model server at ${r.server.host}${r.server.version ? `, version ${r.server.version}` : ''}. In memory: ${r.server.loaded.length ? r.server.loaded.map((m) => `${m.name} (context ${m.context})`).join(', ') : 'nothing'}.`);
  if (r.server.sees.length) out.push(`Installed models that can see: ${r.server.sees.join(', ')}.`);
  out.push('');

  out.push('## Pictures', '');
  if (r.model && r.pictures.length) {
    const all = r.pictures.flatMap((p) => p.answers);
    out.push(`Asked of ${r.model.name} at the context it is loaded with (${r.model.context}). ${all.filter((a) => a.right).length} of ${all.length} right (${pct(all.filter((a) => a.right).length, all.length)}). Median time to the first word ${ms(median(all.flatMap((a) => (a.firstMs === undefined ? [] : [a.firstMs]))))}, to the whole answer ${ms(median(all.map((a) => a.totalMs)))}.`, '');
    out.push('| Picture | Shows | Answer | Right | First word | Whole answer | Tokens in / out |', '|---|---|---|---|---|---|---|');
    for (const p of r.pictures) for (const a of p.answers) out.push(`| ${p.id} | ${cell(p.shows)} | ${cell(a.error ? `(${a.error})` : a.text) || '(nothing)'} | ${a.right ? 'yes' : 'no'} | ${ms(a.firstMs)} | ${ms(a.totalMs)} | ${a.inputTokens ?? 'n/a'} / ${a.outputTokens ?? 'n/a'} |`);
  } else {
    out.push(r.notAsked ?? 'No model was asked.');
  }
  out.push('');

  out.push('## PDFs: reading the text', '');
  if (r.pdfReads.length) {
    out.push('| Reader | PDF | Holds | Size | Read in | Text back | Lines found | Pages |', '|---|---|---|---|---|---|---|---|');
    for (const p of r.pdfReads) {
      const backed = p.outcome === 'text' ? (p.exact ? 'exact' : 'differs') : p.outcome === 'no_text' ? 'no text' : p.outcome;
      out.push(`| ${p.reader} | ${p.id} | ${cell(p.shows)} | ${Math.round(p.bytes / 1024) || 1} KB, ${p.chars.toLocaleString('en-US')} characters | ${ms(p.ms)} | ${backed} | ${p.lines === 0 ? 'n/a' : `${p.linesFound} of ${p.lines}`} | ${p.pagesSaid ?? 'n/a'} of ${p.pages} |`);
    }
  } else {
    out.push('No PDF reader is on this Mac.');
  }
  out.push('');

  out.push('## PDFs: a question about the text', '');
  if (r.model && r.pdfQuestions.length) {
    out.push(`Asked of ${r.model.name}, which was handed each PDF as its text, as a turn would hand it.`, '');
    out.push('| Reader | PDF | Text given | Answer | Right | First word | Whole answer | Tokens in / out |', '|---|---|---|---|---|---|---|---|');
    for (const p of r.pdfQuestions) for (const a of p.answers) out.push(`| ${p.reader} | ${p.id} | ${p.given.toLocaleString('en-US')} of ${p.chars.toLocaleString('en-US')} characters | ${cell(a.error ? `(${a.error})` : a.text) || '(nothing)'} | ${a.right ? 'yes' : 'no'} | ${ms(a.firstMs)} | ${ms(a.totalMs)} | ${a.inputTokens ?? 'n/a'} / ${a.outputTokens ?? 'n/a'} |`);
  } else {
    out.push(r.model ? 'No PDF reader is on this Mac, so no question was asked.' : (r.notAsked ?? 'No model was asked.'));
  }
  out.push('');

  if (r.unchanged !== undefined) out.push(r.unchanged ? 'The same models are in memory, with the same context, as before the run.' : 'The models in memory changed during the run.', '');
  for (const line of r.remarks) out.push(line);
  if (r.hints.length) {
    out.push('', '## Not measured', '');
    for (const h of r.hints) out.push(h.command ? `${h.what}\n\n    ${h.command}\n` : h.what);
  }
  out.push('', 'Nothing was downloaded, loaded or installed, and no setting was changed.');
  return out.join('\n');
}

/** The real PDF reader, for the command. */
export const realReader: VisionDeps['reader'] = (which) => makePdfReader(which);
