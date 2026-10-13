/**
 * A local model is named in ONE place: the hardware tier table
 * (packages/core/src/hardware-tiers.ts), which also names the embedding model.
 * Will's spec: "Don't hardcode model names outside that table."
 *
 * What this reads: the source of the server (src and scripts), of @flint/core
 * and of @flint/persona. Not the other apps, and not tests.
 *
 * How: each file is parsed with the TypeScript compiler, and every string,
 * template and regular-expression literal in it is looked at. A comment is not
 * a literal, so a comment may name a model (it explains a measurement); and a
 * `/*` inside a string is a string, so it cannot hide the code after it (the
 * regex this test used to strip comments with could be fooled that way).
 *
 * It fails on a literal, outside the table, that:
 *  - contains one of the table's own tags;
 *  - contains something shaped like a model tag (`name:7b`, `name:14b-q4`);
 *  - names a family of local models (llama, qwen, gemma, whisper, ...).
 * The few literals that do so for a reason are in ALLOWED, each with the
 * reason. An entry that no longer matches anything fails too.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { DEFAULT_OLLAMA_MODEL, EMBEDDING_MODEL, HARDWARE_TIERS } from '@flint/core';

const REPO = join(__dirname, '..', '..', '..');
const TABLE = 'packages/core/src/hardware-tiers.ts';
const ROOTS = ['apps/server/src', 'apps/server/scripts', 'packages/core/src', 'packages/persona/src'];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : /\.ts$/.test(name) ? [p] : [];
  });
}

interface Literal {
  line: number;
  kind: 'string' | 'template' | 'regex';
  text: string;
}

/** Every string, template part and regular expression in a TypeScript source. Comments are not among them. */
function literals(source: string, name = 'x.ts'): Literal[] {
  const sf = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true);
  const out: Literal[] = [];
  const visit = (n: ts.Node): void => {
    const line = (): number => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
    if (ts.isStringLiteral(n)) out.push({ line: line(), kind: 'string', text: n.text });
    else if (ts.isNoSubstitutionTemplateLiteral(n) || n.kind === ts.SyntaxKind.TemplateHead || n.kind === ts.SyntaxKind.TemplateMiddle || n.kind === ts.SyntaxKind.TemplateTail)
      out.push({ line: line(), kind: 'template', text: (n as ts.LiteralLikeNode).text });
    else if (n.kind === ts.SyntaxKind.RegularExpressionLiteral) out.push({ line: line(), kind: 'regex', text: n.getText(sf) });
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

const tags = [...new Set([...HARDWARE_TIERS.flatMap((t) => [t.model, t.fallbackModel]), EMBEDDING_MODEL.model].filter((m): m is string => m !== undefined))];
/** `family:7b`, `family:14b-instruct-q4_K_M`, `family:1.5b`: a name, a colon, a parameter count. */
const TAG_SHAPED = /(?<![a-z0-9._-])[a-z][a-z0-9._-]*:\d+(?:\.\d+)?[bm](?![a-z0-9])/i;
/** Families of models that run locally, as a name begins. (`ollama` does not begin with `llama`.) */
const FAMILY = /(?<![a-z0-9])(llama|qwen|gemma|mistral|mixtral|deepseek|phi-?\d|llava|granite|nomic|mxbai|minilm|whisper|ggml|gguf|glimmer)/i;

/** Why a literal names a model: undefined when it does not. */
function names(text: string): string | undefined {
  const own = tags.find((t) => text.includes(t));
  if (own) return `the table's tag ${own}`;
  const shaped = TAG_SHAPED.exec(text);
  if (shaped) return `shaped like a model tag (${shaped[0]})`;
  const family = FAMILY.exec(text);
  return family ? `names the ${family[1]!.toLowerCase()} family` : undefined;
}

/**
 * The literals outside the table that name a model or a family, and why each
 * is not a hardcoded local model. Matched by file and exact text.
 */
const ALLOWED: ReadonlyArray<{ file: string; text: string; reason: string }> = [
  {
    file: 'apps/server/src/voice.ts',
    text: '/opt/homebrew/bin/whisper-cli',
    reason: 'the speech-to-text program (whisper.cpp), a path and not a model; WHISPER_BIN names another',
  },
  {
    file: 'apps/server/src/voice.ts',
    text: 'ggml-base.en.bin',
    reason: "the speech-to-text model's file under ~/.flint/models: not a chat model, never served by the local model server, and WHISPER_MODEL names another",
  },
  {
    file: 'apps/server/src/inference-status.ts',
    text: '/^ggml-/i',
    reason: "the prefix whisper.cpp's model FILES carry (a file format's name), taken off to make the name a screen shows: a pattern over a file name Will chose, not a model",
  },
  {
    file: 'apps/server/src/inference-config.ts',
    text: 'whisper-1',
    reason: 'the model id an OpenAI-compatible speech server answers to by convention: a field of the request, not a model Flint picks, loads or downloads; FLINT_LOCAL_STT_MODEL names another',
  },
  // The voice benchmark (src/voice-bench.ts) keeps one small table of its own: whisper.cpp's published model FILES,
  // for the one thing it does with them, which is print the line that would fetch one that is not on this Mac. It
  // never fetches, loads or picks one: it measures the files that are already in the folder WHISPER_MODEL points into.
  ...['ggml-base.en.bin', 'ggml-small.en.bin', 'ggml-large-v3-turbo-q5_0.bin', 'ggml-large-v3-turbo.bin'].map((text) => ({
    file: 'apps/server/src/voice-bench.ts',
    text,
    reason: "a speech-to-text model's file as whisper.cpp publishes it, in the benchmark's table of download lines it PRINTS for Will: not a chat model, never served by the local model server, never downloaded by Flint",
  })),
  {
    file: 'apps/server/src/voice-bench.ts',
    text: '/^ggml-[A-Za-z0-9._-]{1,60}\\.bin$/',
    reason: "the shape of a whisper.cpp model FILE's name (the prefix they all carry): how the benchmark tells model files from anything else in the models folder. A pattern over files already there, not a model",
  },
  ...['apps/server/src/inference-config.ts', 'apps/server/src/local-backend.ts', 'apps/server/src/local-brains.ts'].map((file) => ({
    file,
    text: 'llamacpp',
    reason: 'a KIND of model server (llama.cpp), which FLINT_LOCAL_SERVER names: a server, not a model',
  })),
  ...['/^llama3\\.[12]/i', '/^llama3/i', '/^qwen2\\.5/i', '/^mistral|^mixtral/i', '/^phi3/i', '/^gemma2?/i'].map((text) => ({
    file: 'packages/core/src/provider/ollama/capabilities.ts',
    text,
    reason: 'what a FAMILY of models can do when Ollama cannot say: a pattern over names a model already has, never a model to run',
  })),
];

/**
 * A NAME that holds a family's word and is not a model: where it may be said.
 * A literal in one of these files is allowed when, with the name taken out, it
 * names nothing.
 */
const ALLOWED_NAMES: ReadonlyArray<{ name: string; files: readonly string[]; reason: string }> = [
  {
    name: 'whisper-cpp',
    files: ['apps/server/src/inference-config.ts', 'apps/server/src/voice.ts', 'apps/server/src/inference-status.ts', 'apps/server/src/voice-bench.ts'],
    reason: 'the name of a speech-to-text ENGINE (whisper.cpp, a program on this Mac): what FLINT_STT_PROVIDER is set to, and what a log or a status calls it. A program, not a model',
  },
  {
    name: 'whisper.cpp',
    files: ['apps/server/src/voice-bench.ts'],
    reason: "the same program by its own name, as the benchmark's sentences and its results call it: a program, not a model",
  },
  {
    name: 'whisper-server',
    files: ['apps/server/src/voice-bench.ts'],
    reason: "that program's own server, by the name of its binary: what the benchmark starts on 127.0.0.1 to measure the local provider. A program, not a model",
  },
  {
    name: 'WHISPER_MODEL',
    files: ['apps/server/src/voice-bench.ts'],
    reason: 'the name of the SETTING that says which model file transcription uses, as a sentence names it for Will: a setting, not a model',
  },
  {
    name: 'Whisper',
    files: ['apps/server/src/inference-status.ts'],
    reason: "the same engine's name as the console shows it, in front of words made from the model FILE's name (\"Whisper Base English\"): the file is Will's to choose (WHISPER_MODEL), and no model is named here",
  },
];

const sources = ROOTS.flatMap((r) => files(join(REPO, r))).map((p) => ({ rel: relative(REPO, p), text: readFileSync(p, 'utf8') }));

describe('reading the code: literals, as the TypeScript compiler sees them', () => {
  it('a comment that names a model is not code', () => {
    const src = ["// qwen2.5:7b loads in 4 s", "/* 'llama3.2:3b' was measured */", "const a = 'hello';", '/** muse-glimmer:30b */', 'const b = 1;'].join('\n');
    expect(literals(src)).toEqual([{ line: 3, kind: 'string', text: 'hello' }]);
  });

  it('a /* inside a string is a string: it cannot hide the model named after it', () => {
    const src = ["const glob = 'src/*.ts';", "const model = 'qwen2.5:7b';", "const end = '*/';"].join('\n');
    expect(literals(src).map((l) => l.text)).toEqual(['src/*.ts', 'qwen2.5:7b', '*/']);
    // What the old comment-stripping regex made of the same source: the model was gone with the "comment".
    expect(src.replace(/\/\*[\s\S]*?\*\//g, '')).not.toContain('qwen2.5:7b');
  });

  it('a // inside a string or a URL is a string too, and templates and regular expressions are read', () => {
    const src = ["const u = 'http://127.0.0.1:11434'; const m = 'llama3.2:1b';", 'const t = `model ${x} is qwen3:14b`;', 'const r = /^gemma2?/i;'].join('\n');
    const found = literals(src);
    expect(found.map((l) => l.text)).toEqual(['http://127.0.0.1:11434', 'llama3.2:1b', 'model ', ' is qwen3:14b', '/^gemma2?/i']);
    expect(found.map((l) => names(l.text) !== undefined)).toEqual([false, true, false, true, true]);
  });

  it('what counts as naming a model', () => {
    expect(names('qwen2.5:7b')).toBe("the table's tag qwen2.5:7b");
    expect(names('use nomic-embed-text here')).toBe("the table's tag nomic-embed-text");
    expect(names('some-new-model:14b-instruct-q4_K_M')).toContain('shaped like a model tag');
    expect(names('mymodel:1.5b')).toContain('shaped like a model tag');
    expect(names('Gemma 3')).toBe('names the gemma family');
    for (const fine of ['ollama', 'http://127.0.0.1:11434', 'ollama pull ', '16:9', 'at 12:30', 'local:none', 'application/json', 'philosophy']) expect(names(fine), fine).toBeUndefined();
  });
});

describe('a local model is named only in the hardware tier table', () => {
  it('reads a real set of sources, the table among them', () => {
    expect(sources.length).toBeGreaterThan(80);
    expect(sources.some((s) => s.rel === TABLE)).toBe(true);
    expect(tags.length).toBeGreaterThanOrEqual(6);
    expect(tags).toContain(EMBEDDING_MODEL.model);
  });

  const hits = sources
    .filter((s) => s.rel !== TABLE)
    .flatMap((s) => literals(s.text, s.rel).flatMap((l) => (names(l.text) ? [{ file: s.rel, line: l.line, text: l.text, why: names(l.text)! }] : [])));
  const byName = (h: { file: string; text: string }) => ALLOWED_NAMES.find((n) => n.files.includes(h.file) && h.text.includes(n.name) && names(h.text.split(n.name).join('')) === undefined);
  const allowed = (h: { file: string; text: string }): boolean => ALLOWED.some((a) => a.file === h.file && a.text === h.text) || byName(h) !== undefined;

  it('no literal outside the table names a model, a tag or a family, except the ones allowed with a reason', () => {
    expect(hits.filter((h) => !allowed(h)).map((h) => `${h.file}:${h.line}: ${JSON.stringify(h.text.slice(0, 80))} ${h.why}`)).toEqual([]);
  });

  it("none of the table's own tags appears in a literal anywhere else, allowed or not", () => {
    expect(hits.filter((h) => tags.some((t) => h.text.includes(t))).map((h) => `${h.file}:${h.line}`)).toEqual([]);
  });

  it('every allowed literal has a reason and is still there: a stale entry is removed, not kept', () => {
    for (const a of ALLOWED) {
      expect(a.reason.length, a.text).toBeGreaterThan(30);
      expect(hits.some((h) => h.file === a.file && h.text === a.text), `${a.file}: ${a.text}`).toBe(true);
    }
    for (const n of ALLOWED_NAMES) {
      expect(n.reason.length, n.name).toBeGreaterThan(30);
      for (const file of n.files) expect(hits.some((h) => h.file === file && byName(h) === n), `${file}: ${n.name}`).toBe(true);
    }
  });

  it('an allowed name does not carry a model in with it', () => {
    const file = ALLOWED_NAMES[0]!.files[0]!;
    expect(byName({ file, text: 'whisper-cpp' })).toBeDefined();
    expect(byName({ file, text: 'transcription stays on whisper-cpp, on this Mac' })).toBeDefined();
    // The engine's name next to a model is still a model named.
    expect(byName({ file, text: 'whisper-cpp with qwen2.5:7b' })).toBeUndefined();
    expect(byName({ file, text: 'whisper-cpp and whisper-large-v3' })).toBeUndefined();
    // ...and the name is allowed only in the files listed for it.
    expect(byName({ file: 'apps/server/src/index.ts', text: 'whisper-cpp' })).toBeUndefined();
  });

  it('the checks do catch a model: every row of the table is found in the table file', () => {
    const table = literals(sources.find((s) => s.rel === TABLE)!.text).map((l) => l.text);
    for (const tag of tags) expect(table, tag).toContain(tag);
    for (const tag of tags) expect(names(tag), tag).toBeDefined();
  });

  it('the default model is read from the table, not written again', () => {
    expect(DEFAULT_OLLAMA_MODEL).toBe(HARDWARE_TIERS.find((t) => t.id === '8gb')!.model);
    const src = sources.find((s) => s.rel === 'packages/core/src/provider/ollama/default-model.ts')!.text;
    expect(src).toContain("export const DEFAULT_OLLAMA_MODEL: string = hardwareTier('8gb').model;");
  });

  it('the embedding model is read from the table by the server and by the embedder', () => {
    expect(sources.find((s) => s.rel === 'packages/persona/src/embedder.ts')!.text).toContain('this.model = opts.model ?? EMBEDDING_MODEL.model;');
    expect(sources.find((s) => s.rel === 'apps/server/src/inference.ts')!.text).toContain('return this.cfg.local.embedModel ?? EMBEDDING_MODEL.model;');
    expect(sources.find((s) => s.rel === 'apps/server/src/index.ts')!.text).toContain('model: inference.embedModel,');
  });

  it('the console names no model either: it shows the display names the server gives it', () => {
    const html = readFileSync(join(REPO, 'apps', 'console', 'index.html'), 'utf8');
    for (const tag of tags) expect(html.includes(tag), tag).toBe(false);
    for (const t of HARDWARE_TIERS) expect(html.includes(t.name), t.name).toBe(false);
    expect(TAG_SHAPED.test(html.replace(/<style[\s\S]*?<\/style>/g, ''))).toBe(false);
  });
});
