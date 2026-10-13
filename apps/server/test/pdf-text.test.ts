import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FOLDER_PREFIX,
  LEFTOVER_AFTER_MS,
  MAX_TEXT_CHARS,
  READER_ARGS,
  makePdfReader,
  parseSpotlight,
  plainText,
  plistValue,
  runProgram,
  sweepLeftovers,
  type RunProgram,
} from '../src/pdf-text';
import { PDF_READER_PROGRAMS } from '../src/inference-config';
import { textPdf } from '../src/synthetic-files';

/**
 * A PDF's text, read on this Mac (../src/pdf-text): what the Mac's importer
 * prints and how it is read, the text as a model gets it, and the read itself:
 * a private folder made for it and gone after it, a program run by its full
 * path with fixed arguments, and an honest answer when there is no text or no
 * read.
 *
 * No program that reads a PDF is run here: the reads use a stand-in. (The
 * real importer is run by the opt-in tests in test/process/local-media.test.ts.)
 * What the importer prints is a recording from this Mac of a synthetic PDF
 * (test/fixtures/mdimport-two-pages.txt, macOS 27.0).
 */

const RECORDED = readFileSync(join(__dirname, 'fixtures', 'mdimport-two-pages.txt'), 'utf8');
const NOT_A_PDF = readFileSync(join(__dirname, 'fixtures', 'mdimport-not-a-pdf.txt'), 'utf8');
const TEXT_LINE = /^ {4}kMDItemTextContent = .*$/m;
/** The recording with its text line replaced by `value` (as the Mac would print it), or taken out. */
const recordedWith = (value: string | undefined): string => (value === undefined ? RECORDED.replace(/^ {4}kMDItemTextContent = .*\n/m, '') : RECORDED.replace(TEXT_LINE, () => `    kMDItemTextContent = ${value};`));

/** How long a wait for something to happen may take: an event is waited for, never a length of time, and a busy Mac is given room. */
const WAIT = { timeout: 20_000, interval: 10 };
const dirs: string[] = [];
const scratch = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'flint-pdf-test-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('a value as the Mac prints it', () => {
  const quoted = (s: string) => plistValue(`    k = ${s};`, 8);

  it('a quoted string has its escapes undone, each to the character it stands for', () => {
    expect(quoted('"plain words"')).toEqual({ value: 'plain words', whole: true });
    expect(quoted('"line one\\nline two"').value).toBe('line one\nline two');
    expect(quoted('"she said \\"yes\\""').value).toBe('she said "yes"');
    expect(quoted('"a \\\\ backslash"').value).toBe('a \\ backslash');
    expect(quoted('"a\\tb\\rc\\fd\\ve\\af\\bg"').value).toBe('a\tb\rc\fd\u000be\u0007f\bg');
    expect(quoted('"caf\\U00e9 \\u00e9"').value).toBe('caf\u00e9 \u00e9');
    expect(quoted('"\\033[0m and \\7"').value).toBe('\u001b[0m and \u0007');
    expect(quoted("\"it's\"").value).toBe("it's");
  });

  it('a character outside the basic plane comes as two escapes and is one character again', () => {
    const v = quoted('"smile \\Ud83d\\Ude00 done"').value;
    expect(v).toBe('smile \u{1f600} done');
    expect([...v].length).toBe('smile  done'.length + 1);
  });

  it('a quote inside the string does not end it, and what follows the closing quote is not part of it', () => {
    expect(plistValue('    k = "a\\"; b = \\"c";  trailing', 8)).toEqual({ value: 'a"; b = "c', whole: true });
  });

  it('a bare word is taken up to its semicolon', () => {
    expect(plistValue('    kMDItemTextContent = Hello;', 25)).toEqual({ value: 'Hello', whole: true });
    expect(plistValue('    kMDItemNumberOfPages = 60;', 27)).toEqual({ value: '60', whole: true });
  });

  it('a string that was cut off is what there was of it, and is said not to be whole', () => {
    expect(plistValue('    k = "cut off here', 8)).toEqual({ value: 'cut off here', whole: false });
    expect(plistValue('    k = "ends in a backslash\\', 8)).toEqual({ value: 'ends in a backslash', whole: false });
    expect(plistValue('    k = "half an escape \\U00', 8)).toEqual({ value: 'half an escape ', whole: false });
    expect(plistValue('    k = bare word with no end', 8).whole).toBe(false);
  });

  it('an escape it does not know is the character itself: nothing is made up', () => {
    expect(quoted('"a\\qb"').value).toBe('aqb');
    expect(quoted('"a\\Uzzzzb"').value).toBe('ab');
  });
});

describe("what the Mac's importer prints", () => {
  it('the recording: the text, the page count, and that the import ran', () => {
    expect(parseSpotlight(RECORDED)).toEqual({
      imported: true,
      text: 'Invoice 4471 for the QUARTZHERON workshop.\nThe total due is 1,284.50 dollars by the ninth of March.\nPage two: the delivery address is 18 Larch Lane.\nThe contact is Mira Osei.',
      whole: true,
      pages: 2,
    });
  });

  it('a file the importer found no text in: imported, and no text', () => {
    const got = parseSpotlight(NOT_A_PDF);
    expect(got.imported).toBe(true);
    expect(got.text).toBeUndefined();
    expect(parseSpotlight(recordedWith('""'))).toMatchObject({ imported: true, text: '', whole: true });
    expect(parseSpotlight(recordedWith(undefined)).text).toBeUndefined();
  });

  it('a PDF of one word is printed without quotes, and is still its text', () => {
    expect(parseSpotlight(recordedWith('Hello'))).toMatchObject({ text: 'Hello', whole: true });
  });

  it("a PDF's own text cannot pass for the importer's keys: a line's end inside it is printed as an escape", () => {
    // Recorded from a PDF whose lines were:  a";  /      kMDItemTextContent = "FAKE";  /  kMDItemNumberOfPages = 99;
    const got = parseSpotlight(recordedWith('"a\\";\\n    kMDItemTextContent = \\"FAKE\\";\\nkMDItemNumberOfPages = 99;"'));
    expect(got.text).toBe('a";\n    kMDItemTextContent = "FAKE";\nkMDItemNumberOfPages = 99;');
    expect(got.pages).toBe(2);
  });

  it('a carriage return printed raw inside the text does not end its line', () => {
    expect(parseSpotlight(recordedWith('"one\rtwo \\Ud83d\\Ude00 \u001b three"')).text).toBe('one\rtwo \u{1f600} \u001b three');
  });

  it('only a key at the top level counts: the same name deeper in, or in the middle of a line, is not it', () => {
    const nested = RECORDED.replace(TEXT_LINE, '        kMDItemTextContent = "nested";\n    other = "    kMDItemTextContent = \\"inline\\";";');
    expect(parseSpotlight(nested).text).toBeUndefined();
  });

  it('output that stops inside the text is the text so far, and not whole', () => {
    const at = RECORDED.indexOf('Page two');
    expect(parseSpotlight(RECORDED.slice(0, at))).toMatchObject({ imported: true, whole: false, text: 'Invoice 4471 for the QUARTZHERON workshop.\nThe total due is 1,284.50 dollars by the ninth of March.\n' });
    // Cut exactly after the closing quote, with no line after it: still not known to be whole.
    const line = TEXT_LINE.exec(RECORDED)![0];
    expect(parseSpotlight(RECORDED.slice(0, RECORDED.indexOf(line) + line.length - 1)).whole).toBe(false);
  });

  it('nothing an import would print: not imported', () => {
    expect(parseSpotlight('')).toEqual({ imported: false });
    expect(parseSpotlight('mdimport: usage ...\n')).toEqual({ imported: false });
  });

  it('a page count that is not a count is left out', () => {
    expect(parseSpotlight(RECORDED.replace('kMDItemNumberOfPages = 2;', 'kMDItemNumberOfPages = "many";')).pages).toBeUndefined();
    expect(parseSpotlight(RECORDED.replace('kMDItemNumberOfPages = 2;', 'kMDItemNumberOfPages = 0;')).pages).toBeUndefined();
  });
});

describe('the text as a model gets it', () => {
  it('one kind of line end, a page break as a blank line, and no run of blank lines', () => {
    expect(plainText('a\r\nb\rc\u2028d\u2029e\u0085f')).toBe('a\nb\nc\nd\ne\nf');
    expect(plainText('page one\fpage two')).toBe('page one\n\npage two');
    expect(plainText('a\n\n\n\n\nb')).toBe('a\n\nb');
    expect(plainText('  \n a  \t\nb\n\n')).toBe('a\nb');
  });

  it('control characters go, a tab stays, and half of a character pair becomes the replacement character', () => {
    expect(plainText('a\u0000b\u0007c\u001bd\u007fe\u009ff\tg')).toBe('abcdef\tg');
    expect(plainText('ok \ud83d\ude00 half \ud83d end')).toBe('ok \u{1f600} half \ufffd end');
    expect(plainText('lone \ude00 low')).toBe('lone \ufffd low');
  });
});

describe('the reader', () => {
  /** A stand-in for the program: records how it was run, and what was in the file it was pointed at. */
  const standIn = (answer: (file: string) => { stdout: string; truncated?: boolean } | Promise<{ stdout: string; truncated?: boolean }>) => {
    const runs: Array<{ program: string; args: readonly string[]; cwd: string; timeoutMs: number; maxBytes: number; bytes: Buffer; folderMode: number; innerMode: number; fileMode: number }> = [];
    const run: RunProgram = async (program, args, opts) => {
      const file = args.find((a) => a.endsWith('doc.pdf'))!;
      runs.push({
        program,
        args,
        cwd: opts.cwd,
        timeoutMs: opts.timeoutMs,
        maxBytes: opts.maxBytes,
        bytes: readFileSync(file),
        folderMode: statSync(join(opts.cwd, '..')).mode & 0o777,
        innerMode: statSync(opts.cwd).mode & 0o777,
        fileMode: statSync(file).mode & 0o777,
      });
      const out = await answer(file);
      return { stdout: out.stdout, truncated: out.truncated === true };
    };
    return { run, runs };
  };
  const PDF = textPdf([['hello']]);

  it('the spotlight reader: the program by its full path, three fixed arguments, and the text it printed', async () => {
    const tmp = scratch();
    const { run, runs } = standIn(() => ({ stdout: RECORDED }));
    const reader = makePdfReader({ reader: 'spotlight', program: '/usr/bin/mdimport' }, { run, tmp });
    const got = await reader.read(PDF);
    expect(got).toEqual({ ok: true, text: 'Invoice 4471 for the QUARTZHERON workshop.\nThe total due is 1,284.50 dollars by the ninth of March.\nPage two: the delivery address is 18 Larch Lane.\nThe contact is Mira Osei.', cut: false, pages: 2 });
    expect(runs).toHaveLength(1);
    const r = runs[0]!;
    expect(r.program).toBe('/usr/bin/mdimport');
    expect(r.args).toEqual(['-t', '-d3', join(r.cwd, 'doc.pdf')]);
    expect(r.bytes.equals(PDF)).toBe(true);
    expect(r.timeoutMs).toBe(20_000);
  });

  it('pdftotext: quiet, UTF-8, to standard output, and what it printed is the text', async () => {
    const tmp = scratch();
    const { run, runs } = standIn(() => ({ stdout: 'Page one.\n\fPage two.\n\f' }));
    const reader = makePdfReader({ reader: 'pdftotext', program: '/opt/homebrew/bin/pdftotext' }, { run, tmp });
    expect(await reader.read(PDF)).toEqual({ ok: true, text: 'Page one.\n\nPage two.', cut: false });
    expect(runs[0]!.program).toBe('/opt/homebrew/bin/pdftotext');
    expect(runs[0]!.args).toEqual(['-q', '-enc', 'UTF-8', '-eol', 'unix', join(runs[0]!.cwd, 'doc.pdf'), '-']);
  });

  it('the arguments are fixed: nothing but the path this module made varies, and each program is a full path', () => {
    expect(READER_ARGS.spotlight('/x/doc.pdf')).toEqual(['-t', '-d3', '/x/doc.pdf']);
    expect(READER_ARGS.pdftotext('/x/doc.pdf')).toEqual(['-q', '-enc', 'UTF-8', '-eol', 'unix', '/x/doc.pdf', '-']);
    for (const list of Object.values(PDF_READER_PROGRAMS)) for (const p of list) expect(p.startsWith('/')).toBe(true);
  });

  it("the PDF is in a folder of its own that only this user can read, named so Spotlight does not index it, and it is gone afterwards", async () => {
    const tmp = scratch();
    const { run, runs } = standIn(() => ({ stdout: RECORDED }));
    await makePdfReader({ reader: 'spotlight', program: '/usr/bin/mdimport' }, { run, tmp }).read(PDF);
    const r = runs[0]!;
    expect(r.cwd.startsWith(join(tmp, FOLDER_PREFIX))).toBe(true);
    expect(r.cwd.endsWith('.noindex')).toBe(true);
    expect(r.folderMode).toBe(0o700);
    expect(r.innerMode).toBe(0o700);
    expect(r.fileMode).toBe(0o600);
    expect(readdirSync(tmp)).toEqual([]);
  });

  it('the folder is gone when the program fails, too, and the read says it failed', async () => {
    const tmp = scratch();
    let seen = '';
    const reader = makePdfReader(
      { reader: 'spotlight', program: '/usr/bin/mdimport' },
      {
        tmp,
        run: async (_p, _a, opts) => {
          seen = opts.cwd;
          throw new Error('spawn ENOENT');
        },
      },
    );
    expect(await reader.read(PDF)).toEqual({ ok: false, why: 'failed' });
    expect(seen).not.toBe('');
    expect(existsSync(seen)).toBe(false);
    expect(readdirSync(tmp)).toEqual([]);
  });

  it('a PDF with no text in it is said to have none: an empty text, or no text at all', async () => {
    const tmp = scratch();
    for (const stdout of [recordedWith('""'), recordedWith(undefined), recordedWith('"\\n \\n"'), NOT_A_PDF]) {
      const { run } = standIn(() => ({ stdout }));
      expect(await makePdfReader({ reader: 'spotlight', program: '/usr/bin/mdimport' }, { run, tmp }).read(PDF)).toEqual({ ok: false, why: 'no_text' });
    }
    const { run } = standIn(() => ({ stdout: '\f\f' }));
    expect(await makePdfReader({ reader: 'pdftotext', program: '/opt/homebrew/bin/pdftotext' }, { run, tmp }).read(PDF)).toEqual({ ok: false, why: 'no_text' });
  });

  it('an importer that printed nothing an import prints did not read the PDF: failed, not "no text"', async () => {
    const tmp = scratch();
    const { run } = standIn(() => ({ stdout: 'something else entirely\n' }));
    expect(await makePdfReader({ reader: 'spotlight', program: '/usr/bin/mdimport' }, { run, tmp }).read(PDF)).toEqual({ ok: false, why: 'failed' });
  });

  it('output that was cut off: the text so far, marked as cut; and with no text so far, a failed read', async () => {
    const tmp = scratch();
    const at = RECORDED.indexOf('Page two');
    const some = standIn(() => ({ stdout: RECORDED.slice(0, at), truncated: true }));
    expect(await makePdfReader({ reader: 'spotlight', program: '/usr/bin/mdimport' }, { run: some.run, tmp }).read(PDF)).toMatchObject({ ok: true, cut: true, text: 'Invoice 4471 for the QUARTZHERON workshop.\nThe total due is 1,284.50 dollars by the ninth of March.' });
    const none = standIn(() => ({ stdout: RECORDED.slice(0, 200), truncated: true }));
    expect(await makePdfReader({ reader: 'spotlight', program: '/usr/bin/mdimport' }, { run: none.run, tmp }).read(PDF)).toEqual({ ok: false, why: 'failed' });
    const cutText = standIn(() => ({ stdout: 'half a page', truncated: true }));
    expect(await makePdfReader({ reader: 'pdftotext', program: '/opt/homebrew/bin/pdftotext' }, { run: cutText.run, tmp }).read(PDF)).toEqual({ ok: true, text: 'half a page', cut: true });
  });

  it('more text than is kept: the first of it, marked as cut', async () => {
    const tmp = scratch();
    const { run } = standIn(() => ({ stdout: 'x'.repeat(MAX_TEXT_CHARS + 10) }));
    const got = await makePdfReader({ reader: 'pdftotext', program: '/opt/homebrew/bin/pdftotext' }, { run, tmp }).read(PDF);
    expect(got.ok && got.text.length).toBe(MAX_TEXT_CHARS);
    expect(got.ok && got.cut).toBe(true);
  });

  it('reads run two at a time, the rest wait their turn in order, and one too many is told it is busy', async () => {
    const tmp = scratch();
    const gates: Array<() => void> = [];
    let running = 0;
    let most = 0;
    const started: number[] = [];
    let n = 0;
    const run: RunProgram = async () => {
      const mine = n++;
      started.push(mine);
      running++;
      most = Math.max(most, running);
      await new Promise<void>((r) => gates.push(r));
      running--;
      return { stdout: `text ${mine}`, truncated: false };
    };
    const reader = makePdfReader({ reader: 'pdftotext', program: '/opt/homebrew/bin/pdftotext' }, { run, tmp, atOnce: 2, waiting: 2 });
    const reads = [0, 1, 2, 3, 4].map(() => reader.read(PDF));
    // The fifth is one too many, and is told at once; the others are running or waiting.
    expect(await reads[4]).toEqual({ ok: false, why: 'busy' });
    await expect.poll(() => started.length, WAIT).toBe(2);
    gates[0]!();
    await expect.poll(() => started.length, WAIT).toBe(3);
    gates[1]!();
    await expect.poll(() => started.length, WAIT).toBe(4);
    gates[2]!();
    gates[3]!();
    const done = await Promise.all(reads.slice(0, 4));
    expect(done.every((d) => d.ok)).toBe(true);
    expect(most).toBe(2);
    // A place is free again afterwards.
    const again = reader.read(PDF);
    await expect.poll(() => gates.length, WAIT).toBe(5);
    gates[4]!();
    expect((await again).ok).toBe(true);
    expect(readdirSync(tmp)).toEqual([]);
  });

  it('a read that was already called off is not started', async () => {
    const tmp = scratch();
    const { run, runs } = standIn(() => ({ stdout: RECORDED }));
    const gone = new AbortController();
    gone.abort();
    expect(await makePdfReader({ reader: 'spotlight', program: '/usr/bin/mdimport' }, { run, tmp }).read(PDF, gone.signal)).toEqual({ ok: false, why: 'failed' });
    expect(runs).toHaveLength(0);
  });

  it('never rejects, whatever the stand-in does', async () => {
    const tmp = scratch();
    const reader = makePdfReader({ reader: 'spotlight', program: '/usr/bin/mdimport' }, { tmp: join(tmp, 'no', 'such', 'folder'), run: async () => ({ stdout: RECORDED, truncated: false }) });
    expect(await reader.read(PDF)).toEqual({ ok: false, why: 'failed' });
  });
});

describe('a folder a crash left behind', () => {
  it('is removed once it is older than any read, by its name, and nothing else in the temp folder is touched', async () => {
    const tmp = scratch();
    const old = join(tmp, `${FOLDER_PREFIX}old`);
    const fresh = join(tmp, `${FOLDER_PREFIX}fresh`);
    const other = join(tmp, 'someone-elses');
    const file = join(tmp, `${FOLDER_PREFIX}a-file`);
    for (const d of [old, fresh, other]) mkdirSync(join(d, 'read.noindex'), { recursive: true });
    writeFileSync(join(old, 'read.noindex', 'doc.pdf'), 'left behind');
    writeFileSync(file, 'not a folder');
    const now = Date.now();
    const before = new Date(now - LEFTOVER_AFTER_MS - 1000);
    utimesSync(old, before, before);
    utimesSync(other, before, before);
    utimesSync(file, before, before);
    expect(await sweepLeftovers(tmp, now)).toBe(1);
    expect(readdirSync(tmp).sort()).toEqual([`${FOLDER_PREFIX}a-file`, `${FOLDER_PREFIX}fresh`, 'someone-elses'].sort());
  });

  it('a temp folder that is not there is nothing to sweep', async () => {
    expect(await sweepLeftovers(join(scratch(), 'gone'))).toBe(0);
  });

  it('making a reader sweeps', async () => {
    const tmp = scratch();
    const old = join(tmp, `${FOLDER_PREFIX}old`);
    mkdirSync(old);
    const before = new Date(Date.now() - LEFTOVER_AFTER_MS - 1000);
    utimesSync(old, before, before);
    makePdfReader({ reader: 'spotlight', program: '/usr/bin/mdimport' }, { tmp, run: async () => ({ stdout: '', truncated: false }) });
    await expect.poll(() => existsSync(old), WAIT).toBe(false);
  });
});

describe('running a program', () => {
  // Three small programs every Mac and Linux has. None reads a PDF.
  it('by its path with its arguments as a list: nothing is a shell’s to read', async () => {
    const out = await runProgram('/bin/echo', ['$(id)', ';', 'a b', '`x`'], { timeoutMs: 10_000, maxBytes: 4096, cwd: tmpdir() });
    expect(out).toEqual({ stdout: '$(id) ; a b `x`\n', truncated: false });
  });

  it('with an empty environment', async () => {
    const out = await runProgram('/usr/bin/env', [], { timeoutMs: 10_000, maxBytes: 65536, cwd: tmpdir() });
    // (macOS adds one variable of its own to every process; nothing of this process's environment is there.)
    expect(out.stdout.split('\n').filter((l) => l && !l.startsWith('__CF'))).toEqual([]);
  });

  it('a program that prints past the cap is stopped, and what it printed until then is kept', async () => {
    const out = await runProgram('/usr/bin/yes', ['line'], { timeoutMs: 10_000, maxBytes: 4096, cwd: tmpdir() });
    expect(out.truncated).toBe(true);
    expect(out.stdout.startsWith('line\nline\n')).toBe(true);
  });

  it('a program that is not there, one that fails, and one that runs out of time all reject', async () => {
    await expect(runProgram('/no/such/program', [], { timeoutMs: 10_000, maxBytes: 4096, cwd: tmpdir() })).rejects.toThrow();
    await expect(runProgram('/usr/bin/false', [], { timeoutMs: 10_000, maxBytes: 4096, cwd: tmpdir() })).rejects.toThrow();
    await expect(runProgram('/bin/sleep', ['30'], { timeoutMs: 50, maxBytes: 4096, cwd: tmpdir() })).rejects.toThrow();
  });
});
