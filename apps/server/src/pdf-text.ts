/**
 * A PDF's text, read on this Mac, for the local model.
 *
 * No local model here reads a PDF, and until this existed a PDF could only be
 * answered by a cloud model that does: in Local mode, and on a private turn,
 * it was refused. With FLINT_LOCAL_PDF set (it ships off), a program on this
 * Mac reads the PDF's text and the local model is handed that (./local-media).
 * Nothing is installed or downloaded for it:
 *
 *   spotlight   the Mac's own PDF importer, the one Spotlight indexes PDFs
 *               with, asked for a test import (`mdimport -t -d3 <file>`: the
 *               result is printed and nothing is stored in the index);
 *   pdftotext   poppler's, when Will has installed it (`brew install poppler`).
 *
 * What it reads is the text a PDF carries. A scan (pages that are pictures)
 * has none, and is said to have none: `no_text`, which the route turns into a
 * sentence. It is never answered blind.
 *
 * THE FILE STAYS HERE. The program takes a path, so the PDF is written to a
 * folder of its own under the temp folder: made for this one read, readable by
 * this user alone (0700, the file 0600), named so that Spotlight does not
 * index it, and removed when the read ends, however it ends. A folder a crash
 * left behind is removed the next time a reader is made (`sweepLeftovers`).
 * The program is run by its full path with a fixed list of arguments
 * (execFile: no shell, nothing built from the PDF's name or its bytes), with
 * an empty environment, a deadline, and a cap on what it may print. Nothing of
 * the PDF, its name or its text is logged.
 *
 * Kept free of index.ts so it is unit-testable (index.ts runs main() on import).
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PdfReaderKind } from './inference-config';

/** What a read gives. `no_text`: the PDF was read and carries no text (a scan). `failed`: the program did not answer. `busy`: too many reads at once. */
export type PdfText =
  | {
      ok: true;
      /** The PDF's text: plain, with `\n` for a line's end. At most MAX_TEXT_CHARS of it. */
      text: string;
      /** The PDF holds more text than `text`: the rest was not kept. */
      cut: boolean;
      /** How many pages it has, when the reader says. */
      pages?: number;
    }
  | { ok: false; why: 'no_text' | 'failed' | 'busy' };

/** The most text kept from one PDF. More than any local model's window holds, and a bound on what a read costs. */
export const MAX_TEXT_CHARS = 1_000_000;
/** How long one read may take. (A 60-page PDF takes a fifth of a second on this Mac.) */
export const READ_TIMEOUT_MS = 20_000;
/** The most a reader's program may print before it is stopped: what it printed until then is used. */
export const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
/** Reads that run at once, and how many more may wait their turn. One past that is `busy`. */
export const READS_AT_ONCE = 2;
export const READS_WAITING = 8;
/** The temp folders are named with this, so a leftover can be told from anything else there. */
export const FOLDER_PREFIX = 'flint-pdf-';
/** A leftover folder is removed once it is this old: far longer than any read may take, so a read under way in another Flint is not touched. */
export const LEFTOVER_AFTER_MS = 10 * 60 * 1000;

/**
 * Each reader's arguments, for a file at `file`. Fixed: the path is the only
 * thing that varies, and it is a path this module made.
 */
export const READER_ARGS: Readonly<Record<PdfReaderKind, (file: string) => string[]>> = {
  // A test import (-t) with everything it found printed (-d3 includes the text). Nothing is stored in the index.
  spotlight: (file) => ['-t', '-d3', file],
  // Quiet, UTF-8, unix line ends, to standard output.
  pdftotext: (file) => ['-q', '-enc', 'UTF-8', '-eol', 'unix', file, '-'],
};

/** How a program is run. Injectable for tests. Rejects when it could not be run, failed, or ran out of time. */
export type RunProgram = (program: string, args: readonly string[], opts: { timeoutMs: number; maxBytes: number; cwd: string; signal?: AbortSignal | undefined }) => Promise<{ stdout: string; truncated: boolean }>;

/** execFile: the program by its path, its arguments as a list, an empty environment. Output past the cap ends the program, and what came before is kept. */
export const runProgram: RunProgram = (program, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(
      program,
      [...args],
      { timeout: opts.timeoutMs, maxBuffer: opts.maxBytes, cwd: opts.cwd, env: {}, killSignal: 'SIGKILL', encoding: 'utf8', windowsHide: true, ...(opts.signal ? { signal: opts.signal } : {}) },
      (err, stdout) => {
        if (!err) return resolve({ stdout, truncated: false });
        if ((err as NodeJS.ErrnoException).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return resolve({ stdout: typeof stdout === 'string' ? stdout : '', truncated: true });
        reject(err);
      },
    );
  });

// ---------------------------------------------------------------------------
// what the Mac's importer prints

const TEXT_KEY = '    kMDItemTextContent = ';
const PAGES_KEY = '    kMDItemNumberOfPages = ';
/** A line every import that ran prints: without it the importer did not import the file. */
const IMPORTED = '    kMDItemContentType = ';

/** One escape after a backslash, as the Mac prints a string: the character it stands for. */
const ESCAPES: Readonly<Record<string, string>> = { n: '\n', t: '\t', r: '\r', a: '\u0007', b: '\b', f: '\f', v: '\u000b', '"': '"', "'": "'", '\\': '\\' };

/**
 * The value after `key = ` on a line of the importer's output: a quoted string
 * with its escapes undone (`\n`, `\"`, `\\`, `\Uxxxx` for each UTF-16 unit of
 * a character outside ASCII, `\a` `\b` `\f` `\v`, an octal `\ooo`), or a bare
 * word up to its `;` (the Mac prints a value of letters and digits unquoted).
 * `whole` is false for a quoted string with no closing quote: the output was
 * cut off inside it.
 */
export function plistValue(line: string, from: number): { value: string; whole: boolean } {
  if (line[from] !== '"') {
    const end = line.indexOf(';', from);
    return { value: (end === -1 ? line.slice(from) : line.slice(from, end)).trim(), whole: end !== -1 };
  }
  const out: string[] = [];
  let i = from + 1;
  let run = i;
  while (i < line.length) {
    const c = line[i]!;
    if (c === '"') {
      out.push(line.slice(run, i));
      return { value: out.join(''), whole: true };
    }
    if (c !== '\\') {
      i++;
      continue;
    }
    out.push(line.slice(run, i));
    const e = line[i + 1];
    if (e === undefined) {
      // A backslash at the very end: the output was cut off inside an escape.
      return { value: out.join(''), whole: false };
    }
    if (e === 'U' || e === 'u') {
      const hex = line.slice(i + 2, i + 6);
      if (/^[0-9a-fA-F]{4}$/.test(hex)) {
        out.push(String.fromCharCode(parseInt(hex, 16)));
        i += 6;
      } else {
        // Cut off inside the escape, or not one: nothing is made up for it.
        i = Math.min(line.length, i + 2 + hex.length);
      }
    } else if (e >= '0' && e <= '7') {
      const oct = /^[0-7]{1,3}/.exec(line.slice(i + 1, i + 4))![0];
      out.push(String.fromCharCode(parseInt(oct, 8)));
      i += 1 + oct.length;
    } else {
      out.push(ESCAPES[e] ?? e);
      i += 2;
    }
    run = i;
  }
  out.push(line.slice(run));
  return { value: out.join(''), whole: false };
}

/**
 * What a test import printed, read: the text, the page count, and whether the
 * importer ran at all. The text's value is on ONE line (the Mac prints a line's
 * end inside a string as `\n`), and it is found as a top-level key at the
 * start of a line, so nothing inside a PDF's own text can pass for it.
 */
export function parseSpotlight(stdout: string): { imported: boolean; text?: string; whole?: boolean; pages?: number } {
  let imported = false;
  let text: string | undefined;
  let whole: boolean | undefined;
  let pages: number | undefined;
  let at = 0;
  while (at <= stdout.length) {
    const nl = stdout.indexOf('\n', at);
    const end = nl === -1 ? stdout.length : nl;
    if (stdout.startsWith(TEXT_KEY, at)) {
      if (text === undefined) {
        const v = plistValue(stdout.slice(at, end), TEXT_KEY.length);
        text = v.value;
        // (A value that ends the output with no line after it was cut off, even if its last character is a quote.)
        whole = v.whole && nl !== -1;
      }
    } else if (stdout.startsWith(PAGES_KEY, at)) {
      const n = Number(plistValue(stdout.slice(at, end), PAGES_KEY.length).value);
      if (pages === undefined && Number.isInteger(n) && n > 0) pages = n;
    } else if (stdout.startsWith(IMPORTED, at)) {
      imported = true;
    }
    if (nl === -1) break;
    at = nl + 1;
  }
  return { imported, ...(text !== undefined ? { text, whole: whole === true } : {}), ...(pages !== undefined ? { pages } : {}) };
}

/**
 * A reader's text as plain text for a model: one kind of line end, a page
 * break as a blank line, no control characters, no half of a character pair,
 * and no run of blank lines.
 */
export function plainText(raw: string): string {
  return raw
    .replace(/\r\n?|[\u0085\u2028\u2029]/g, '\n')
    .replace(/\f/g, '\n\n')
    .replace(/[\u0000-\u0008\u000b\u000e-\u001f\u007f-\u009f]/g, '')
    .replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '\ufffd')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---------------------------------------------------------------------------
// the reader

export interface PdfReader {
  readonly kind: PdfReaderKind;
  /** Read a PDF's text. Never throws, and never rejects: a read that did not work says so. */
  read(bytes: Uint8Array, signal?: AbortSignal): Promise<PdfText>;
}

export interface PdfReaderDeps {
  run?: RunProgram;
  /** Where the temp folders are made (tests: a folder of their own). */
  tmp?: string;
  timeoutMs?: number;
  maxBytes?: number;
  atOnce?: number;
  waiting?: number;
  now?: () => number;
}

/**
 * Remove the folders a reader left behind in `tmp` (a crash in the middle of a
 * read): by their name, and only once they are older than any read. Never
 * throws; a folder that cannot be removed is left.
 */
export async function sweepLeftovers(tmp: string = tmpdir(), now: number = Date.now()): Promise<number> {
  let removed = 0;
  try {
    for (const name of await readdir(tmp)) {
      if (!name.startsWith(FOLDER_PREFIX)) continue;
      const path = join(tmp, name);
      try {
        const s = await stat(path);
        if (!s.isDirectory() || now - s.mtimeMs < LEFTOVER_AFTER_MS) continue;
        await rm(path, { recursive: true, force: true });
        removed++;
      } catch {
        /* someone else's, or gone already */
      }
    }
  } catch {
    /* no such folder: nothing was left in it */
  }
  return removed;
}

/** The reader FLINT_LOCAL_PDF names, with the program config found for it. */
export function makePdfReader(which: { reader: PdfReaderKind; program: string }, deps: PdfReaderDeps = {}): PdfReader {
  const run = deps.run ?? runProgram;
  const tmp = deps.tmp ?? tmpdir();
  const atOnce = deps.atOnce ?? READS_AT_ONCE;
  const mayWait = deps.waiting ?? READS_WAITING;
  let running = 0;
  const line: Array<() => void> = [];
  const turn = (): Promise<boolean> => {
    if (running < atOnce) {
      running++;
      return Promise.resolve(true);
    }
    if (line.length >= mayWait) return Promise.resolve(false);
    return new Promise((resolve) => line.push(() => resolve(true)));
  };
  const done = (): void => {
    const next = line.shift();
    if (next) next(); // its place is handed on: `running` stays as it is
    else running--;
  };
  void sweepLeftovers(tmp, (deps.now ?? Date.now)());

  return {
    kind: which.reader,
    async read(bytes, signal) {
      if (signal?.aborted) return { ok: false, why: 'failed' };
      if (!(await turn())) return { ok: false, why: 'busy' };
      let folder: string | undefined;
      try {
        folder = await mkdtemp(join(tmp, FOLDER_PREFIX)); // 0700, and a name nobody could guess
        // Spotlight skips a folder whose name ends `.noindex`: the PDF is read when asked, and never indexed.
        const inner = join(folder, 'read.noindex');
        await mkdir(inner, { mode: 0o700 });
        const file = join(inner, 'doc.pdf');
        await writeFile(file, bytes, { mode: 0o600, flag: 'wx' });
        const out = await run(which.program, READER_ARGS[which.reader](file), { timeoutMs: deps.timeoutMs ?? READ_TIMEOUT_MS, maxBytes: deps.maxBytes ?? MAX_OUTPUT_BYTES, cwd: inner, signal });
        let raw: string;
        let whole = !out.truncated;
        let pages: number | undefined;
        if (which.reader === 'spotlight') {
          const got = parseSpotlight(out.stdout);
          if (!got.imported && got.text === undefined) return { ok: false, why: 'failed' };
          raw = got.text ?? '';
          whole = whole && got.whole !== false;
          pages = got.pages;
        } else {
          raw = out.stdout;
        }
        const text = plainText(raw);
        // (Nothing at all from a read that was cut off is a failed read, not a PDF without text.)
        if (text.length === 0) return { ok: false, why: whole ? 'no_text' : 'failed' };
        return { ok: true, text: text.slice(0, MAX_TEXT_CHARS), cut: !whole || text.length > MAX_TEXT_CHARS, ...(pages !== undefined ? { pages } : {}) };
      } catch {
        return { ok: false, why: 'failed' };
      } finally {
        done();
        if (folder) await rm(folder, { recursive: true, force: true }).catch(() => {});
      }
    },
  };
}
