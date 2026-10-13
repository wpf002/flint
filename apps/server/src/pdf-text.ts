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
 * index it, and removed when the read ends: when it answers, fails, runs out
 * of time or is called off, and when Flint is stopped in the middle of it (the
 * folders of the reads under way are removed as the process exits). The one
 * case nothing in this process can cover is the process being killed outright
 * (SIGKILL, a power cut): that folder is removed the next time anything here
 * reads a PDF or Flint starts, whatever its age, because its name says which
 * process made it and that process is gone.
 *
 * The program is run by its full path with a fixed list of arguments (no
 * shell, nothing built from the PDF's name or its bytes), with an empty
 * environment, as the head of a process group of its own, with a deadline and
 * a cap on what it may print. Nothing of the PDF, its name or its text is
 * logged.
 *
 * WHAT THE DEADLINE IS, AND IS NOT. It bounds how long Flint WAITS. When it
 * passes, the program Flint started and anything that program started are
 * killed. It does NOT bound how long macOS works: the Mac's importer hands the
 * PDF to a system service, and that service goes on with it after Flint has
 * stopped waiting. So:
 *  - a PDF that is plainly too much is refused before it is handed over: one
 *    over MAX_PDF_BYTES, or with more than MAX_PDF_PAGES pages by a count of
 *    its own bytes (./pdf-limits). Each has its own sentence;
 *  - after a read runs out of time the reader is BUSY: every read is refused
 *    at once, nothing is queued behind a service that is stuck, and one small
 *    PDF of Flint's own is tried every few seconds until it comes back. Then
 *    reads go on.
 * A small PDF can still hold a great deal (a compressed page that unpacks to a
 * hundred megabytes): that is not seen before the read, and costs the Mac one
 * such episode.
 *
 * Kept free of index.ts so it is unit-testable (index.ts runs main() on import).
 */
import { spawn } from 'node:child_process';
import { lstatSync, readdirSync, rmSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { constants as zlib, inflateSync } from 'node:zlib';
import type { PdfReaderKind } from './inference-config';
import { MAX_PDF_BYTES, MAX_PDF_PAGES } from './pdf-limits';
import { textPdf } from './synthetic-files';

/**
 * What a read gives.
 *   no_text    the PDF was read and carries no text (a scan);
 *   too_big    it is over MAX_PDF_BYTES, and was not handed to the reader;
 *   too_long   it has more than MAX_PDF_PAGES pages, and was not handed over;
 *   busy       too many reads at once, or the reader is waiting for the Mac to
 *              finish with a PDF Flint stopped waiting for;
 *   failed     the program did not answer.
 */
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
  | { ok: false; why: 'no_text' | 'too_big' | 'too_long' | 'busy' | 'failed' };

/** The most text kept from one PDF. More than any local model's window holds, and a bound on what a read costs. */
export const MAX_TEXT_CHARS = 1_000_000;
/** How long Flint waits for one read. (A 60-page PDF takes a fifth of a second on this Mac.) Not how long macOS may work: see the header. */
export const READ_TIMEOUT_MS = 20_000;
/** The most a reader's program may print before it is stopped: what it printed until then is used. */
export const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
/** Reads that run at once, and how many more may wait their turn. One past that is `busy`. */
export const READS_AT_ONCE = 2;
export const READS_WAITING = 8;
/** The temp folders are named with this and the pid of the process that made them, so a leftover can be told from anything else there. */
export const FOLDER_PREFIX = 'flint-pdf-';
/** A folder whose maker cannot be told to be gone is removed once it is this old: far longer than any read may take. */
export const LEFTOVER_AFTER_MS = 10 * 60 * 1000;
/** After a read ran out of time: how long until the first try of Flint's own small PDF, how often after that, and how long each try may take. */
export const PROBE_AFTER_MS = 5_000;
export const PROBE_EVERY_MS = 15_000;
export const PROBE_TIMEOUT_MS = 5_000;
/** The most a PDF's object streams may unpack to while its pages are counted. Past it the PDF is too much to count, and is refused. */
export const COUNT_BUDGET_BYTES = 32 * 1024 * 1024;

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

/** How a program is run. Injectable for tests. Rejects when it could not be run or failed, and with `ReadTimedOut` when it ran out of time. */
export type RunProgram = (program: string, args: readonly string[], opts: { timeoutMs: number; maxBytes: number; cwd: string; signal?: AbortSignal | undefined }) => Promise<{ stdout: string; truncated: boolean }>;

/** The program was still running when Flint stopped waiting for it. */
export class ReadTimedOut extends Error {
  constructor() {
    super('the reader ran out of time');
    this.name = 'ReadTimedOut';
  }
}

/** The programs under way, each with the way to end it: ended when the process exits, so none outlives Flint. */
const RUNNING = new Set<() => void>();

/**
 * The program by its path, its arguments as a list, an empty environment, and
 * no shell. It is started as the head of a process group of its own, so that
 * when it runs out of time, prints past the cap or is called off, it AND
 * anything it started are killed together. The group is only ever signalled
 * while the program itself has not been seen to exit: after that its number
 * may belong to someone else. Output past the cap ends the program, and what
 * came before is kept. Only its standard output is read.
 */
export const runProgram: RunProgram = (program, args, opts) =>
  new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(program, [...args], { cwd: opts.cwd, env: {}, stdio: ['ignore', 'pipe', 'ignore'], detached: true, windowsHide: true });
    } catch (err) {
      return reject(err);
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let exited = false;
    let settled = false;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const killGroup = (): void => {
      if (exited || child.pid === undefined) return;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          /* gone already */
        }
      }
    };
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (grace) clearTimeout(grace);
      opts.signal?.removeEventListener('abort', onAbort);
      RUNNING.delete(killGroup);
      child.stdout?.destroy();
      fn();
    };
    const text = (): string => Buffer.concat(chunks).subarray(0, opts.maxBytes).toString('utf8');
    const onAbort = (): void => {
      killGroup();
      settle(() => reject(new Error('the read was called off')));
    };
    const timer = setTimeout(() => {
      killGroup();
      settle(() => reject(new ReadTimedOut()));
    }, opts.timeoutMs);
    RUNNING.add(killGroup);
    if (opts.signal?.aborted) return onAbort();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', (d: Buffer) => {
      chunks.push(d);
      size += d.length;
      if (size > opts.maxBytes) {
        killGroup();
        settle(() => resolve({ stdout: text(), truncated: true }));
      }
    });
    child.once('error', (err) => settle(() => reject(err)));
    let code: number | null = null;
    const ended = (): void => settle(() => (code === 0 ? resolve({ stdout: text(), truncated: false }) : reject(new Error('the reader failed'))));
    child.once('exit', (c) => {
      exited = true;
      code = c;
      // Its output ends when the last holder of the pipe lets go. Something it started and left behind may hold
      // it open: what was printed by then is taken, a moment after the program itself is gone.
      grace = setTimeout(ended, 500);
    });
    child.once('close', ended);
  });

// ---------------------------------------------------------------------------
// how many pages, by a look at the bytes

const PAGE_OBJECT = /\/Type\s*\/Page(?![A-Za-z])/g;
const PAGE_COUNT = /\/Count\s+(\d{1,12})(?!\d)/g;
const OBJECT_STREAM = /\/Type\s*\/ObjStm/g;

function pagesIn(text: string): number {
  let objects = 0;
  for (const _ of text.matchAll(PAGE_OBJECT)) objects++;
  let said = 0;
  for (const m of text.matchAll(PAGE_COUNT)) said = Math.max(said, Number(m[1]));
  return Math.max(objects, said);
}

/**
 * How many pages a PDF has, as near as a look at its bytes can tell, without
 * handing it to anything: the page objects it holds, and the largest count a
 * page tree gives. A modern PDF keeps its objects in compressed object
 * streams, so those are unpacked and looked at too, within `budget` bytes in
 * all. Infinity when they unpack to more than that: too much to count is too
 * much to read.
 *
 * It errs high on purpose (a count in an outline is taken for pages): this
 * only decides what is refused before the Mac is asked to work on it.
 */
export function countPdfPages(bytes: Uint8Array, budget: number = COUNT_BUDGET_BYTES): number {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = buf.toString('latin1');
  let most = pagesIn(text);
  let left = budget;
  for (const m of text.matchAll(OBJECT_STREAM)) {
    const at = text.indexOf('stream', m.index);
    if (at === -1) continue;
    const from = text[at + 6] === '\r' && text[at + 7] === '\n' ? at + 8 : text[at + 6] === '\n' ? at + 7 : -1;
    if (from === -1) continue;
    const end = text.indexOf('endstream', from);
    let unpacked: Buffer;
    try {
      // (Whatever unpacks is looked at: a stream that ends early is read as far as it goes.)
      unpacked = inflateSync(buf.subarray(from, end === -1 ? buf.length : end), { maxOutputLength: Math.max(1, left), finishFlush: zlib.Z_SYNC_FLUSH });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') return Infinity;
      continue; // not a stream this can unpack: its pages, if any, are not counted
    }
    left -= unpacked.length;
    most = Math.max(most, pagesIn(unpacked.toString('latin1')));
    if (left <= 0) return Infinity;
  }
  return most;
}

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
// the folders, and what is left of them

/** The folders of the reads under way in THIS process: removed when the process exits, whatever ends it that lets it say so. */
const LIVE = new Set<string>();
let hooked = false;

/**
 * End every reader's program that is still running, and remove the folder of
 * every read under way. Synchronous: it is what runs as the process exits
 * (index.ts turns SIGTERM and SIGINT into an exit, and `finally` blocks do not
 * run on one). Safe to call at any time.
 */
export function endReadsNow(): void {
  for (const kill of [...RUNNING]) kill();
  for (const folder of [...LIVE]) {
    try {
      rmSync(folder, { recursive: true, force: true });
    } catch {
      /* the next sweep takes it */
    }
    LIVE.delete(folder);
  }
}

function hookExit(): void {
  if (hooked) return;
  hooked = true;
  process.on('exit', endReadsNow);
}

/** Is there a process with this number? (One this user may not signal is still one that is there.) */
function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The folder name's prefix for this process: `flint-pdf-<pid>-`. */
export const folderPrefix = (pid: number = process.pid): string => `${FOLDER_PREFIX}${pid}-`;

/**
 * Remove the folders a reader left behind in `tmp`, by their name:
 *  - one made by a process that is gone (a crash, a kill, a power cut in the
 *    middle of a read) goes at once, whatever its age;
 *  - one made by THIS process that is not a read under way goes at once too;
 *  - one whose maker cannot be told, or is still running, goes once it is
 *    older than any read (a read under way in another Flint is not touched).
 * Only real folders: a link by that name is someone else's, and is left.
 * Never throws; a folder that cannot be removed is left.
 */
export async function sweepLeftovers(tmp: string = tmpdir(), now: number = Date.now(), running: (pid: number) => boolean = isRunning): Promise<number> {
  let removed = 0;
  try {
    for (const name of await readdir(tmp)) {
      if (!name.startsWith(FOLDER_PREFIX)) continue;
      const path = join(tmp, name);
      if (LIVE.has(path)) continue;
      try {
        const s = await lstat(path);
        if (!s.isDirectory()) continue;
        const pid = Number(/^(\d{1,10})-/.exec(name.slice(FOLDER_PREFIX.length))?.[1] ?? NaN);
        const makerGone = Number.isInteger(pid) && pid > 0 && (pid === process.pid || !running(pid));
        if (!makerGone && now - s.mtimeMs < LEFTOVER_AFTER_MS) continue;
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

/** The same, at once, for the moment a process starts: before anything else reads the temp folder. */
export function sweepLeftoversNow(tmp: string = tmpdir(), now: number = Date.now(), running: (pid: number) => boolean = isRunning): number {
  let removed = 0;
  try {
    for (const name of readdirSync(tmp)) {
      if (!name.startsWith(FOLDER_PREFIX)) continue;
      const path = join(tmp, name);
      if (LIVE.has(path)) continue;
      try {
        const s = lstatSync(path);
        if (!s.isDirectory()) continue;
        const pid = Number(/^(\d{1,10})-/.exec(name.slice(FOLDER_PREFIX.length))?.[1] ?? NaN);
        const makerGone = Number.isInteger(pid) && pid > 0 && (pid === process.pid || !running(pid));
        if (!makerGone && now - s.mtimeMs < LEFTOVER_AFTER_MS) continue;
        rmSync(path, { recursive: true, force: true });
        removed++;
      } catch {
        /* someone else's, or gone already */
      }
    }
  } catch {
    /* no such folder */
  }
  return removed;
}

// ---------------------------------------------------------------------------
// the reader

export interface PdfReader {
  readonly kind: PdfReaderKind;
  /** Read a PDF's text. Never throws, and never rejects: a read that did not work says so. */
  read(bytes: Uint8Array, signal?: AbortSignal): Promise<PdfText>;
  /** Is the reader waiting for the Mac to finish with a PDF Flint stopped waiting for? Every read is then `busy`. */
  stuck?(): boolean;
  /** Stop trying Flint's own small PDF (tests, a process that is ending). */
  close?(): void;
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
  /** Run `fn` after `ms` (tests: by hand). Default: a timer that does not keep the process alive. */
  later?: (fn: () => void, ms: number) => void;
  /** Is there a process with this number (tests)? */
  running?: (pid: number) => boolean;
}

/** Flint's own small PDF: one page, one line. What is tried while the reader is busy, to learn that the Mac is done. */
const PROBE_PDF = textPdf([['Flint reads this page.']]);

/** The reader FLINT_LOCAL_PDF names, with the program config found for it. */
export function makePdfReader(which: { reader: PdfReaderKind; program: string }, deps: PdfReaderDeps = {}): PdfReader {
  const run = deps.run ?? runProgram;
  const tmp = deps.tmp ?? tmpdir();
  const atOnce = deps.atOnce ?? READS_AT_ONCE;
  const mayWait = deps.waiting ?? READS_WAITING;
  const now = deps.now ?? Date.now;
  const later =
    deps.later ??
    ((fn: () => void, ms: number): void => {
      const t = setTimeout(fn, ms);
      t.unref?.();
    });
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
  hookExit();
  // What a process that was killed left behind goes before anything is read (at once: a start is the one moment
  // nothing else of this process is in the temp folder).
  sweepLeftoversNow(tmp, now(), deps.running);

  // ---- busy: a read ran out of time, and the Mac may still be at work on that PDF
  let stuck = false;
  let closed = false;
  let probing = false;
  let waitingToProbe = false;
  const probeLater = (ms: number): void => {
    if (waitingToProbe || closed) return;
    waitingToProbe = true;
    later(() => {
      waitingToProbe = false;
      void probe();
    }, ms);
  };
  const probe = async (): Promise<void> => {
    if (probing || !stuck || closed) return;
    probing = true;
    try {
      const got = await once(PROBE_PDF, undefined, PROBE_TIMEOUT_MS);
      if (got.ok) stuck = false;
    } finally {
      probing = false;
      if (stuck) probeLater(PROBE_EVERY_MS);
    }
  };

  /** One read: the folder, the program, what it printed. No line, no checks: `read` and `probe` decide whether it runs. */
  const once = async (bytes: Uint8Array, signal: AbortSignal | undefined, timeoutMs: number): Promise<PdfText> => {
    let folder: string | undefined;
    try {
      await sweepLeftovers(tmp, now(), deps.running);
      folder = await mkdtemp(join(tmp, folderPrefix())); // 0700, and a name nobody could guess
      LIVE.add(folder);
      // Spotlight skips a folder whose name ends `.noindex`: the PDF is read when asked, and never indexed.
      const inner = join(folder, 'read.noindex');
      await mkdir(inner, { mode: 0o700 });
      const file = join(inner, 'doc.pdf');
      await writeFile(file, bytes, { mode: 0o600, flag: 'wx' });
      const out = await run(which.program, READER_ARGS[which.reader](file), { timeoutMs, maxBytes: deps.maxBytes ?? MAX_OUTPUT_BYTES, cwd: inner, signal });
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
    } catch (err) {
      if (err instanceof ReadTimedOut && !stuck) {
        // Flint has stopped waiting. The Mac may not have stopped working: nothing more is handed to it until
        // a small PDF of Flint's own comes back.
        stuck = true;
        probeLater(PROBE_AFTER_MS);
      }
      return { ok: false, why: 'failed' };
    } finally {
      if (folder) {
        await rm(folder, { recursive: true, force: true }).catch(() => {});
        LIVE.delete(folder);
      }
    }
  };

  return {
    kind: which.reader,
    stuck: () => stuck,
    close: () => {
      closed = true;
    },
    async read(bytes, signal) {
      if (signal?.aborted) return { ok: false, why: 'failed' };
      // Refused before anything is asked to work on it (./pdf-limits).
      if (bytes.byteLength > MAX_PDF_BYTES) return { ok: false, why: 'too_big' };
      if (countPdfPages(bytes) > MAX_PDF_PAGES) return { ok: false, why: 'too_long' };
      if (!(await turn())) return { ok: false, why: 'busy' };
      try {
        // Busy (a read ran out of time, and the Mac may still be at work on it): refused here, whether this read
        // came just now or was waiting its turn when it happened. Nothing is handed to a stuck service.
        if (stuck) return { ok: false, why: 'busy' };
        return await once(bytes, signal, deps.timeoutMs ?? READ_TIMEOUT_MS);
      } finally {
        done();
      }
    },
  };
}
