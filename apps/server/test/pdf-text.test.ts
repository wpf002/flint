import { describe, it, expect, afterEach } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { deflateSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  COUNT_BUDGET_BYTES,
  COUNT_SLICE_MS,
  COUNT_STREAMS,
  COUNT_WORK_MS,
  FOLDER_PARENT,
  FOLDER_PREFIX,
  LEFTOVER_AFTER_MS,
  MAX_OUTPUT_BYTES,
  MAX_TEXT_CHARS,
  PROBE_AFTER_MS,
  PROBE_EVERY_MS,
  PROBE_TIMEOUT_MS,
  READER_ARGS,
  READ_TIMEOUT_MS,
  ReadTimedOut,
  SLOW_FOR_MS,
  SLOW_REMEMBERED,
  countPdfPages,
  endReadsNow,
  folderPrefix,
  makePdfReader,
  ownReadsFolder,
  parseSpotlight,
  plainText,
  plistValue,
  readsFolder,
  runProgram,
  sweepLeftovers,
  sweepLeftoversNow,
  type RunProgram,
} from '../src/pdf-text';
import { MAX_PDF_BYTES, MAX_PDF_PAGES } from '../src/pdf-limits';
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
/** What reads left under `tmp`: in Flint's own folder there, and beside it (where a read puts nothing at all). */
const left = (tmp: string): string[] => [...readdirSync(tmp).filter((n) => n !== FOLDER_PARENT), ...(existsSync(join(tmp, FOLDER_PARENT)) ? readdirSync(join(tmp, FOLDER_PARENT)) : [])];
/** A temp folder with Flint's own folder for reads made in it: `[the temp folder, Flint's folder]`. */
const withReadsFolder = (): [string, string] => {
  const tmp = scratch();
  mkdirSync(join(tmp, FOLDER_PARENT), { mode: 0o700 });
  return [tmp, join(tmp, FOLDER_PARENT)];
};

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
    // The wait, and the most the program may print: the two bounds every read is run with.
    expect(r.timeoutMs).toBe(READ_TIMEOUT_MS);
    expect(READ_TIMEOUT_MS).toBe(20_000);
    expect(r.maxBytes).toBe(MAX_OUTPUT_BYTES);
    expect(MAX_OUTPUT_BYTES).toBe(16 * 1024 * 1024);
  });

  it('a reader given other bounds runs its program with those', async () => {
    const tmp = scratch();
    const { run, runs } = standIn(() => ({ stdout: RECORDED }));
    await makePdfReader({ reader: 'spotlight', program: '/usr/bin/mdimport' }, { run, tmp, timeoutMs: 1234, maxBytes: 4096 }).read(PDF);
    expect(runs[0]).toMatchObject({ timeoutMs: 1234, maxBytes: 4096 });
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
    // In Flint's own folder under the temp folder, which is this user's alone too: nothing is put beside it.
    expect(readsFolder(tmp)).toBe(join(tmp, 'flint-pdf'));
    expect(r.cwd.startsWith(join(tmp, FOLDER_PARENT, FOLDER_PREFIX))).toBe(true);
    expect(statSync(join(tmp, FOLDER_PARENT)).mode & 0o777).toBe(0o700);
    expect(readdirSync(tmp)).toEqual([FOLDER_PARENT]);
    // Its name says which process made it: what is left by one that was killed can be told from a read under way.
    expect(r.cwd.startsWith(join(tmp, FOLDER_PARENT, `${FOLDER_PREFIX}${process.pid}-`))).toBe(true);
    expect(folderPrefix()).toBe(`flint-pdf-${process.pid}-`);
    expect(r.cwd.endsWith('.noindex')).toBe(true);
    expect(r.folderMode).toBe(0o700);
    expect(r.innerMode).toBe(0o700);
    expect(r.fileMode).toBe(0o600);
    expect(left(tmp)).toEqual([]);
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
    expect(left(tmp)).toEqual([]);
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

  it('an EMPTY text is "no text" only when the read was whole: cut off before a word of it came, it is a failed read', async () => {
    const tmp = scratch();
    const spot = (stdout: string, truncated: boolean) => makePdfReader({ reader: 'spotlight', program: '/usr/bin/mdimport' }, { run: standIn(() => ({ stdout, truncated })).run, tmp }).read(PDF);
    const plain = (stdout: string, truncated: boolean) => makePdfReader({ reader: 'pdftotext', program: '/opt/homebrew/bin/pdftotext' }, { run: standIn(() => ({ stdout, truncated })).run, tmp }).read(PDF);
    // The importer got as far as the text's opening quote, and no further.
    const opened = RECORDED.slice(0, RECORDED.indexOf('kMDItemTextContent = "') + 'kMDItemTextContent = "'.length);
    expect(await spot(opened, true)).toEqual({ ok: false, why: 'failed' });
    expect(await spot(opened, false)).toEqual({ ok: false, why: 'failed' }); // (the value itself was not whole)
    expect(await spot(recordedWith('""'), true)).toEqual({ ok: false, why: 'failed' });
    expect(await spot(recordedWith('""'), false)).toEqual({ ok: false, why: 'no_text' });
    expect(await plain('', true)).toEqual({ ok: false, why: 'failed' });
    expect(await plain('\n\f\n', true)).toEqual({ ok: false, why: 'failed' });
    expect(await plain('', false)).toEqual({ ok: false, why: 'no_text' });
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
    expect(left(tmp)).toEqual([]);
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

describe('what is refused before it is handed to a reader', () => {
  /** A PDF whose page objects are in a compressed object stream, as most modern PDFs keep them. */
  const objectStreamPdf = (pages: number): Buffer => {
    const inner = Buffer.from(Array.from({ length: pages }, () => '<< /Type /Page /Parent 2 0 R >>').join('\n'), 'latin1');
    const packed = deflateSync(inner);
    return Buffer.concat([Buffer.from(`%PDF-1.5\n9 0 obj\n<< /Type /ObjStm /N ${pages} /First 0 /Length ${packed.length} /Filter /FlateDecode >>\nstream\n`, 'latin1'), packed, Buffer.from('\nendstream\nendobj\n%%EOF\n', 'latin1')]);
  };
  const manyPages = (n: number): Buffer => textPdf(Array.from({ length: n }, () => ['x']));
  const PDF = textPdf([['hello']]);
  /** A stand-in for the program that answers with the recording, and counts how often it was run. */
  const standIn = (answer: () => { stdout: string }) => {
    const runs: string[] = [];
    const run: RunProgram = async (program) => {
      runs.push(program);
      return { stdout: answer().stdout, truncated: false };
    };
    return { run, runs };
  };

  const latin = (s: string): Buffer => Buffer.from(s, 'latin1');

  it('the pages are counted from the bytes: the page objects, in the file and inside compressed object streams', async () => {
    expect(await countPdfPages(textPdf([['one'], ['two'], ['three']]))).toBe(3);
    expect(await countPdfPages(textPdf([[]]))).toBe(1);
    expect(await countPdfPages(manyPages(250))).toBe(250);
    // The page TREE is not a page, nor is anything else whose name only begins like one, or like `/Type`.
    expect(await countPdfPages(latin('%PDF-1.4 /Type/Page /Type /PageLabels /Type /Pages /Type /Pag /Types /Page /Subtype /Type1 /Page /Type Page'))).toBe(1);
    expect(await countPdfPages(latin('/Type\r\n\t\f\0 /Page<</Type/Page>>[/Type/Page]/Type/Page/Type/Page'))).toBe(5);
    expect(await countPdfPages(objectStreamPdf(40))).toBe(40);
    expect(await countPdfPages(objectStreamPdf(900))).toBe(900);
    expect(await countPdfPages(Buffer.concat([manyPages(30), objectStreamPdf(40).subarray(9), objectStreamPdf(5).subarray(9), latin('<< /Type /Page >>')]))).toBe(76);
    expect(await countPdfPages(Buffer.from('not a PDF at all'))).toBe(0);
    expect(await countPdfPages(new Uint8Array(0))).toBe(0);
    for (const cut of ['/', '/T', '/Type', '/Type ', '/Type /', '/Type /Pag', '/#', '/Type /P#6']) expect(await countPdfPages(latin(cut))).toBe(0);
  });

  it('the count stops once the answer is known: one past the most that is read', async () => {
    expect(await countPdfPages(manyPages(2500))).toBe(MAX_PDF_PAGES + 1);
    expect(await countPdfPages(objectStreamPdf(2500))).toBe(MAX_PDF_PAGES + 1);
    expect(await countPdfPages(objectStreamPdf(2500), { stopAfter: 5000 })).toBe(2500);
    expect(await countPdfPages(manyPages(40), { stopAfter: 9 })).toBe(10);
    // (Nothing after that is unpacked, either.)
    const tally = { searched: 0, opened: 0, yields: 0 };
    expect(await countPdfPages(Buffer.concat([manyPages(40), objectStreamPdf(5).subarray(9)]), { stopAfter: 9, tally })).toBe(10);
    expect(tally.opened).toBe(0);
  });

  // The count used to take the largest `/Count` in the file for the pages. An outline has a `/Count` too (a review:
  // a two-page PDF with a long outline was refused as 1,500 pages), and so can an object nothing uses.
  it('a count the PDF gives of itself is not believed, an outline’s least of all: only page objects are pages', async () => {
    const outlined = Buffer.concat([textPdf([['Two pages.'], ['Second.']]), latin('\n9 0 obj\n<< /Type /Outlines /Count 1500 >>\nendobj\n')]);
    expect(await countPdfPages(outlined)).toBe(2);
    expect(await countPdfPages(latin('%PDF-1.4\n2 0 obj << /Type /Pages /Count 1000000 /Kids [2 0 R 2 0 R] >> endobj'))).toBe(0);
    const { run, runs } = standIn(() => ({ stdout: RECORDED }));
    expect((await makePdfReader({ reader: 'spotlight', program: '/usr/bin/mdimport' }, { run, tmp: scratch() }).read(outlined)).ok).toBe(true);
    expect(runs).toHaveLength(1);
  });

  // (A review: 50,000 pages written `/Type /P#61ge` were counted as none, and handed to the Mac.)
  it('a name’s escapes are decoded: `/P#61ge` is a page, `/T#79pe` is its key, `/Obj#53tm` is an object stream', async () => {
    expect(await countPdfPages(latin(`%PDF-1.5\n${'<< /Type /P#61ge >>\n'.repeat(7)}`))).toBe(7);
    expect(await countPdfPages(latin('/T#79pe/Page /#54#79#70#65 /#50#61#67#65 /#54ype/#50age /Type/Pa#67e'))).toBe(4);
    expect(await countPdfPages(latin('/Type /P#4Age /Type /P#4age'))).toBe(0); // (`J`, in either case of the digit)
    // What is not an escape is the characters themselves, and no page.
    expect(await countPdfPages(latin('/Type /Page# /Type /P#zzge /Type /P#6 /Type /Pag#65s /Typ#65s /Page'))).toBe(0);
    const escaped = objectStreamPdf(900);
    const at = escaped.indexOf('/ObjStm');
    const renamed = Buffer.concat([escaped.subarray(0, at), latin('/Obj#53tm'), escaped.subarray(at + 7)]);
    expect(await countPdfPages(renamed)).toBe(900);
    const { run, runs } = standIn(() => ({ stdout: RECORDED }));
    const reader = makePdfReader({ reader: 'spotlight', program: '/usr/bin/mdimport' }, { run, tmp: scratch() });
    expect(await reader.read(latin(`%PDF-1.5\n${'<< /Type /P#61ge >>\n'.repeat(MAX_PDF_PAGES + 1)}`))).toEqual({ ok: false, why: 'too_long' });
    expect(runs).toHaveLength(0);
  });

  it('a value too far from its key is not looked for: the white space between them is bounded', async () => {
    expect(await countPdfPages(latin(`/Type${' '.repeat(256)}/Page`))).toBe(1);
    expect(await countPdfPages(latin(`/Type${' '.repeat(257)}/Page`))).toBe(0);
    // Nor is an object stream's `stream` looked for past where a dictionary could end.
    const streamAfter = (n: number): Buffer => Buffer.concat([latin(`%PDF-1.5\n<< /Type /ObjStm${' '.repeat(n)}stream\n`), deflateSync(latin('<< /Type /Page >>')), latin('\nendstream')]);
    expect(await countPdfPages(streamAfter(4095))).toBe(1);
    expect(await countPdfPages(streamAfter(4096))).toBe(0);
  });

  it('object streams that unpack to more than the budget are more than will be counted, and so more than is read', async () => {
    const big = objectStreamPdf(900);
    expect(await countPdfPages(big, { unpack: 1024 })).toBe(Infinity);
    expect(await countPdfPages(big)).toBe(900);
    expect(COUNT_BUDGET_BYTES).toBe(32 * 1024 * 1024);
    // The budget is for all of a PDF's object streams together: every one that is opened is held to what is left of it.
    const each = 300 * '<< /Type /Page /Parent 2 0 R >>\n'.length - 1;
    const two = Buffer.concat([objectStreamPdf(300), objectStreamPdf(300).subarray(9)]);
    expect(await countPdfPages(two, { unpack: 2 * each })).toBe(600);
    expect(await countPdfPages(two, { unpack: 2 * each - 1 })).toBe(Infinity);
    expect(await countPdfPages(two, { unpack: each })).toBe(Infinity);
    // Sixteen megabytes of nothing in a few kilobytes: said to be too much, and not unpacked past the budget.
    const bomb = deflateSync(Buffer.alloc(16 * 1024 * 1024));
    expect(bomb.length).toBeLessThan(20_000);
    expect(await countPdfPages(Buffer.concat([latin(`%PDF-1.5\n<< /Type /ObjStm /Length ${bomb.length} >>\nstream\n`), bomb, latin('\nendstream')]), { unpack: 1024 * 1024 })).toBe(Infinity);
  });

  it('a stream that is not one this can unpack is passed over: the PDF is counted by what else it holds', async () => {
    const tally = { searched: 0, opened: 0, yields: 0 };
    // Not deflate at all: never handed to the unpacker.
    expect(await countPdfPages(latin('%PDF-1.5\n<< /Type /ObjStm >>\nstream\nthis is not deflate\nendstream\n<< /Type /Page >>'), { tally })).toBe(1);
    expect(tally.opened).toBe(0);
    // An object stream with no filter holds its objects as they are: they are read where they stand, and its pages
    // count (a review found 300 such pages counted as none, where the old count had all 300).
    const plainStream = `<< /Type /ObjStm /N 300 >>\nstream\n${'<< /Type /Page /Parent 2 0 R >>\n'.repeat(300)}endstream\n`;
    expect(await countPdfPages(latin(`%PDF-1.5\n${plainStream}`), { tally })).toBe(300);
    expect(tally.opened).toBe(0);
    // It begins like deflate, and is not: the unpacker says so, and the count goes on.
    expect(await countPdfPages(Buffer.concat([latin('%PDF-1.5\n<< /Type /ObjStm >>\nstream\n'), Buffer.from([0x78, 0x9c, 0xff, 0xff, 0xff, 0xff]), latin('\nendstream\n<< /Type /Page >>')]), { tally })).toBe(1);
    expect(tally.opened).toBe(1);
    // One that ends early is read as far as it goes.
    const whole = deflateSync(latin('<< /Type /Page >>\n'.repeat(50) + Array.from({ length: 4000 }, (_, i) => `${i * 7919}`).join(' ')));
    const half = whole.subarray(0, whole.length >> 1);
    expect(await countPdfPages(Buffer.concat([latin('%PDF-1.5\n<< /Type /ObjStm >>\nstream\r\n'), half, latin('\nendstream')]))).toBe(50);
    // What is inside a stream that was unpacked is not read a second time as the file's own, and an object stream inside one is not opened.
    const inner = objectStreamPdf(3).subarray(9);
    const outer = deflateSync(Buffer.concat([latin('<< /Type /Page >>'), inner]));
    const nested = { searched: 0, opened: 0, yields: 0 };
    expect(await countPdfPages(Buffer.concat([latin('%PDF-1.5\n<< /Type /ObjStm >>\nstream\n'), outer, latin('\nendstream')]), { tally: nested })).toBe(1);
    expect(nested.opened).toBe(1);
    // No `stream` after its dictionary, no line end after it, only the end of another object's stream, no `endstream`: left alone.
    for (const not of ['<< /Type /ObjStm >>\n', '<< /Type /ObjStm >>\nstream', '<< /Type /ObjStm >>\nstreamX\nxx\nendstream', '<< /Type /ObjStm >>\nendstream\nxx\nendstream', '<< /Type /ObjStm >>\nstream\nxx\n']) {
      const t = { searched: 0, opened: 0, yields: 0 };
      expect(await countPdfPages(latin(`%PDF-1.5\n${not}<< /Type /Page >>`), { tally: t })).toBe(1);
      expect(t.opened).toBe(0);
    }
  });

  // A review (2026-10-13): the count ran on the event loop and looked from each object stream's marker to the end
  // of the file. One megabyte of `/Type/ObjStm stream\nxx ` with no `endstream` held the whole server for 4.2
  // seconds, two for 16.5: about seven minutes at the ten the reader takes. These are those files.
  describe('what a count costs is bounded, whatever the bytes are', () => {
    const MB = 1024 * 1024;
    const repeated = (unit: string, bytes: number): Buffer => Buffer.concat([latin('%PDF-1.5\n'), latin(unit.repeat(Math.floor(bytes / unit.length)))]);
    const noEnd = (bytes: number): Buffer => repeated('/Type/ObjStm stream\nxx ', bytes);
    /** A bound for a count that takes a few milliseconds: generous enough for a busy Mac, and far under what it used to take. */
    const SOON_MS = 3_000;
    const counted = async (bytes: Uint8Array, limits: Parameters<typeof countPdfPages>[1] = {}) => {
      const tally = { searched: 0, opened: 0, yields: 0 };
      const began = performance.now();
      const pages = await countPdfPages(bytes, { ...limits, tally });
      return { pages, tally, ms: performance.now() - began };
    };

    it('the review’s files, one megabyte and two: counted in one pass, soon, and refused as more than will be counted', async () => {
      for (const mb of [1, 2]) {
        const file = noEnd(mb * MB);
        const got = await counted(file);
        expect(got.pages).toBe(Infinity);
        expect(got.ms).toBeLessThan(SOON_MS);
        // All the markers together: the look for a stream's start read the file's bytes once at most, and so did the
        // look for its end. (It was once from every marker to the end of the file: thousands of times over.)
        expect(got.tally.searched).toBeLessThanOrEqual(2 * file.length);
        expect(got.tally.opened).toBe(0);
      }
    });

    it('ten megabytes of the same is refused as soon, and no program is started for it', async () => {
      const file = noEnd(MAX_PDF_BYTES);
      expect(file.length).toBeGreaterThan(MAX_PDF_BYTES - 64);
      const { run, runs } = standIn(() => ({ stdout: RECORDED }));
      const tmp = scratch();
      const reader = makePdfReader({ reader: 'spotlight', program: '/usr/bin/mdimport' }, { run, tmp });
      const began = performance.now();
      expect(await reader.read(file)).toEqual({ ok: false, why: 'too_long' });
      expect(performance.now() - began).toBeLessThan(SOON_MS);
      expect(runs).toHaveLength(0);
      expect(left(tmp)).toEqual([]);
    });

    it('more object streams than any PDF that is read has are more than will be counted', async () => {
      expect(COUNT_STREAMS).toBe(4096);
      const marker = '<< /Type /ObjStm >>\n';
      expect(await countPdfPages(latin(marker.repeat(COUNT_STREAMS)))).toBe(0);
      expect(await countPdfPages(latin(marker.repeat(COUNT_STREAMS + 1)))).toBe(Infinity);
      expect(await countPdfPages(latin(marker.repeat(4)), { streams: 3 })).toBe(Infinity);
      // (Counted whether or not they have a stream to open: that is what the review's files are.)
      expect((await counted(repeated('/Type/ObjStm ', MB))).pages).toBe(Infinity);
      expect((await counted(repeated('/Type/ObjStm stream\nxx endstream ', MB))).pages).toBe(Infinity);
    });

    it('with fewer markers than that, spread over megabytes, each byte is still looked at once: nothing is searched again', async () => {
      const far = 'x'.repeat(1000);
      const shapes: Array<[string, Buffer]> = [
        ['every marker’s `stream` is the same one, at the very end', Buffer.concat([latin(`/Type/ObjStm ${far}`.repeat(4000)), latin('stream\nxx endstream')])],
        ['every marker has a `stream`, and none has an end', latin(`/Type/ObjStm stream\n${far}`.repeat(4000))],
        ['every marker has a stream of its own, of nothing', latin(`/Type/ObjStm stream\n${far}endstream `.repeat(4000))],
        ['one stream, and every marker after it inside it', Buffer.concat([latin('/Type/ObjStm stream\n'), latin(`/Type/ObjStm stream\n${far}`.repeat(4000)), latin('endstream')])],
      ];
      for (const [what, file] of shapes) {
        const got = await counted(file);
        expect(got.pages, what).toBe(0);
        expect(file.length, what).toBeGreaterThan(4_000_000);
        expect(got.tally.searched, what).toBeLessThanOrEqual(2 * file.length);
        expect(got.ms, what).toBeLessThan(SOON_MS);
      }
    });

    // A clock the test moves: each look at it is a millisecond later. Nothing here depends on how fast this Mac is.
    const ticking = (): (() => number) => {
      let t = 0;
      return () => t++;
    };

    it('it works a slice at a time and gives everything else a turn between slices; past its budget of work it stops', async () => {
      expect(COUNT_SLICE_MS).toBe(8);
      expect(COUNT_WORK_MS).toBe(2000);
      const names = latin('/Tx '.repeat(256 * 400)); // the clock is looked at once for every 256 names
      const whole = await counted(names, { now: ticking() });
      expect(whole.pages).toBe(0);
      // 400 looks at the clock, a millisecond apart: a turn is given each time eight have passed since the last.
      expect(whole.tally.yields).toBeGreaterThanOrEqual(40);
      expect(whole.tally.yields).toBeLessThanOrEqual(50);
      expect((await counted(names, { now: ticking(), sliceMs: 2 })).tally.yields).toBeGreaterThan(whole.tally.yields * 2);
      // The budget: 400 ms of work is more than 100 allows, and not more than 2,000 does.
      expect((await counted(names, { now: ticking(), workMs: 100 })).pages).toBe(Infinity);
      expect((await counted(names, { now: ticking(), workMs: 100 })).tally.yields).toBeLessThan(whole.tally.yields / 2);
      // Unpacked object streams are looked through the same way, under the same budget.
      const packed = deflateSync(names);
      const inStream = Buffer.concat([latin('%PDF-1.5\n<< /Type /ObjStm >>\nstream\n'), packed, latin('\nendstream')]);
      expect((await counted(inStream, { now: ticking() })).tally.yields).toBeGreaterThanOrEqual(40);
      expect((await counted(inStream, { now: ticking(), workMs: 100 })).pages).toBe(Infinity);
    });

    it('while a long count is under way everything else is answered: a request to this process comes back before the count ends', async () => {
      // A megabyte of names that are nearly `/Type`, by a clock that makes every look at it the end of a slice: thousands
      // of turns for everything else, however fast this Mac is.
      const file = latin('/T'.repeat(MB));
      const server = createServer((_req, res) => res.end('{"status":"ok"}'));
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      try {
        const port = (server.address() as { port: number }).port;
        const order: string[] = [];
        const count = counted(file, { now: ticking(), sliceMs: 1, workMs: Number.MAX_SAFE_INTEGER }).then((got) => (order.push('count'), got));
        const health = Array.from({ length: 3 }, () => fetch(`http://127.0.0.1:${port}/health`).then(async (r) => (order.push('health'), r.json())));
        expect(await Promise.all(health)).toEqual([{ status: 'ok' }, { status: 'ok' }, { status: 'ok' }]);
        const got = await count;
        expect(order).toEqual(['health', 'health', 'health', 'count']);
        expect(got.pages).toBe(0);
        expect(got.tally.yields).toBeGreaterThan(1000);
      } finally {
        await new Promise((r) => server.close(r));
      }
    });

    it('a reader counts one PDF at a time, takes no more of them than it lets wait, and a read called off during its count starts no program', async () => {
      const { run, runs } = standIn(() => ({ stdout: RECORDED }));
      const tmp = scratch();
      const reader = makePdfReader({ reader: 'spotlight', program: '/usr/bin/mdimport' }, { run, tmp, atOnce: 1, waiting: 2, count: { sliceMs: 0 } });
      // Each count gives a turn at every look at the clock, so all of these are asked for before the first is done.
      const pdf = (i: number): Buffer => Buffer.concat([manyPages(3), latin(`%${i} ${'/Tx '.repeat(2000)}`)]);
      const gone = new AbortController();
      const reads = [reader.read(pdf(0)), reader.read(pdf(1), gone.signal), reader.read(pdf(2)), reader.read(pdf(3))];
      gone.abort();
      expect(await Promise.all(reads)).toEqual([expect.objectContaining({ ok: true }), { ok: false, why: 'failed' }, expect.objectContaining({ ok: true }), { ok: false, why: 'busy' }]);
      expect(runs).toHaveLength(2);
      // Its place is given back when a count ends.
      expect((await reader.read(pdf(4))).ok).toBe(true);
      expect(left(tmp)).toEqual([]);
    });
  });

  it('a PDF with more pages than are read here is refused, and no program is run for it', async () => {
    const tmp = scratch();
    const { run, runs } = standIn(() => ({ stdout: RECORDED }));
    const reader = makePdfReader({ reader: 'spotlight', program: '/usr/bin/mdimport' }, { run, tmp });
    expect(MAX_PDF_PAGES).toBe(1000);
    expect(await reader.read(manyPages(MAX_PDF_PAGES + 1))).toEqual({ ok: false, why: 'too_long' });
    expect(await reader.read(objectStreamPdf(MAX_PDF_PAGES + 1))).toEqual({ ok: false, why: 'too_long' });
    expect(runs).toHaveLength(0);
    expect(left(tmp)).toEqual([]);
    // At the bound it is read.
    expect((await reader.read(manyPages(MAX_PDF_PAGES))).ok).toBe(true);
    expect(runs).toHaveLength(1);
  });

  it('a PDF larger than is read here is refused, and no program is run for it', async () => {
    const tmp = scratch();
    const { run, runs } = standIn(() => ({ stdout: RECORDED }));
    const reader = makePdfReader({ reader: 'pdftotext', program: '/opt/homebrew/bin/pdftotext' }, { run, tmp });
    expect(MAX_PDF_BYTES).toBe(10 * 1024 * 1024);
    const padded = (size: number): Buffer => Buffer.concat([PDF, Buffer.from('%'), Buffer.alloc(size - PDF.length - 1, 0x41)]);
    expect(await reader.read(padded(MAX_PDF_BYTES + 1))).toEqual({ ok: false, why: 'too_big' });
    expect(runs).toHaveLength(0);
    expect((await reader.read(padded(MAX_PDF_BYTES))).ok).toBe(true);
    expect(runs).toHaveLength(1);
  });
});

// The wait bounds how long FLINT waits. The Mac's importer does its work in a system service, which goes on after
// Flint has stopped waiting (a review: a 50,000-page PDF kept it busy three and a half minutes, and every read
// behind it timed out too). So after one read runs out of time, nothing more is handed over until a small PDF of
// Flint's own comes back.
describe('after a read runs out of time the reader is busy, and nothing is queued behind a stuck service', () => {
  /** A reader whose program times out while `slow` is true, and whose "later" is run by the test. */
  const stuckable = () => {
    const tmp = scratch();
    const state = { slow: true, runs: [] as Array<{ timeoutMs: number; bytes: number }> };
    const waits: Array<{ fn: () => void; ms: number }> = [];
    const run: RunProgram = async (_p, args, opts) => {
      state.runs.push({ timeoutMs: opts.timeoutMs, bytes: readFileSync(args.find((a) => a.endsWith('doc.pdf'))!).length });
      if (state.slow) throw new ReadTimedOut();
      return { stdout: RECORDED, truncated: false };
    };
    const reader = makePdfReader({ reader: 'spotlight', program: '/usr/bin/mdimport' }, { run, tmp, later: (fn, ms) => void waits.push({ fn, ms }) });
    return { reader, state, waits, tmp };
  };
  const PDF = textPdf([['hello']]);

  const OTHER = textPdf([['another PDF']]);

  it('the read that ran out of time says so; every read after it is told "busy" at once, and no program is run for any of them', async () => {
    const { reader, state, waits, tmp } = stuckable();
    expect(reader.stuck!()).toBe(false);
    expect(await reader.read(PDF)).toEqual({ ok: false, why: 'too_slow' });
    expect(reader.stuck!()).toBe(true);
    expect(state.runs).toHaveLength(1);
    for (let i = 0; i < 12; i++) expect(await reader.read(textPdf([[`another PDF, ${i}`]]))).toEqual({ ok: false, why: 'busy' });
    expect(state.runs).toHaveLength(1);
    // One try of Flint's own small PDF is waiting, and only one.
    expect(waits.map((w) => w.ms)).toEqual([PROBE_AFTER_MS]);
    expect(left(tmp)).toEqual([]);
  });

  it('a small PDF of Flint’s own is tried, with a short wait of its own; while it does not come back the reader stays busy and tries again later', async () => {
    const { reader, state, waits } = stuckable();
    await reader.read(PDF);
    waits.shift()!.fn();
    await expect.poll(() => waits.length, WAIT).toBe(1);
    expect(state.runs).toHaveLength(2);
    expect(state.runs[1]!.timeoutMs).toBe(PROBE_TIMEOUT_MS);
    expect(state.runs[1]!.bytes).toBeLessThan(2000); // Flint's own page, not anything of Will's
    expect(waits[0]!.ms).toBe(PROBE_EVERY_MS);
    expect(reader.stuck!()).toBe(true);
    expect(await reader.read(OTHER)).toEqual({ ok: false, why: 'busy' });
  });

  it('when the small PDF comes back the reader reads again, and nothing more is tried', async () => {
    const { reader, state, waits } = stuckable();
    await reader.read(PDF);
    state.slow = false;
    waits.shift()!.fn();
    await expect.poll(() => reader.stuck!(), WAIT).toBe(false);
    expect(waits).toEqual([]);
    expect((await reader.read(OTHER)).ok).toBe(true);
    expect(state.runs).toHaveLength(3);
  });

  it('reads that were waiting their turn when it happened are told "busy" too, and one of the same PDF that it is too slow: none of them is run', async () => {
    const tmp = scratch();
    const gates: Array<(v: 'timeout' | 'ok') => void> = [];
    let runs = 0;
    const run: RunProgram = async () => {
      runs++;
      const how = await new Promise<'timeout' | 'ok'>((r) => gates.push(r));
      if (how === 'timeout') throw new ReadTimedOut();
      return { stdout: RECORDED, truncated: false };
    };
    const reader = makePdfReader({ reader: 'spotlight', program: '/usr/bin/mdimport' }, { run, tmp, atOnce: 1, waiting: 4, later: () => {} });
    const reads = [PDF, OTHER, textPdf([['a third']]), Buffer.from(PDF)].map((pdf) => reader.read(pdf));
    await expect.poll(() => gates.length, WAIT).toBe(1);
    gates[0]!('timeout');
    expect(await Promise.all(reads)).toEqual([
      { ok: false, why: 'too_slow' },
      { ok: false, why: 'busy' },
      { ok: false, why: 'busy' },
      { ok: false, why: 'too_slow' },
    ]);
    expect(runs).toBe(1);
  });

  it('a read that fails any other way does not make the reader busy', async () => {
    const tmp = scratch();
    let n = 0;
    const run: RunProgram = async () => {
      if (n++ === 0) throw new Error('the reader failed');
      return { stdout: RECORDED, truncated: false };
    };
    const reader = makePdfReader({ reader: 'spotlight', program: '/usr/bin/mdimport' }, { run, tmp, later: () => {} });
    expect(await reader.read(PDF)).toEqual({ ok: false, why: 'failed' });
    expect(reader.stuck!()).toBe(false);
    expect((await reader.read(PDF)).ok).toBe(true);
  });

  it('a reader that is closed tries nothing more', async () => {
    const { reader, waits } = stuckable();
    reader.close!();
    await reader.read(PDF);
    expect(waits).toEqual([]);
  });
});

// A review (2026-10-13): the same heavy PDF sent a second time started the same minutes of work in macOS's services
// a second time. The reader remembers what ran out of time, by a digest of its bytes, for a few hours.
describe('a PDF whose read ran out of time is remembered, and not handed to the Mac again for a few hours', () => {
  const HEAVY = textPdf([['a PDF the Mac takes minutes over: HEAVYQ']]);
  const OTHER = textPdf([['another PDF']]);
  /** A reader whose program runs out of time on any PDF `heavy` says is one, with a clock and a "later" the test runs. */
  const forgetful = (heavy: (bytes: Buffer) => boolean = (b) => b.includes('HEAVYQ')) => {
    const tmp = scratch();
    const clock = { t: 1_000_000 };
    const runs: number[] = [];
    const waits: Array<() => void> = [];
    const run: RunProgram = async (_p, args) => {
      const bytes = readFileSync(args.find((a) => a.endsWith('doc.pdf'))!);
      runs.push(bytes.length);
      if (heavy(bytes)) throw new ReadTimedOut();
      return { stdout: RECORDED, truncated: false };
    };
    const reader = makePdfReader({ reader: 'spotlight', program: '/usr/bin/mdimport' }, { run, tmp, now: () => clock.t, later: (fn) => void waits.push(fn) });
    /** Flint's own small PDF comes back: the reader reads again. */
    const unstick = async (): Promise<void> => {
      waits.shift()!();
      await expect.poll(() => reader.stuck!(), WAIT).toBe(false);
    };
    return { reader, runs, clock, unstick, waits, tmp };
  };

  it('the same PDF sent again is refused at once, with no program run and no new wait; any other PDF is read', async () => {
    const { reader, runs, unstick, tmp } = forgetful();
    expect(reader.slow!()).toBe(0);
    expect(await reader.read(HEAVY)).toEqual({ ok: false, why: 'too_slow' });
    expect(reader.slow!()).toBe(1);
    await unstick();
    const before = runs.length;
    // The same bytes, however they are held: a copy, and a view into the middle of something larger.
    expect(await reader.read(Buffer.from(HEAVY))).toEqual({ ok: false, why: 'too_slow' });
    const within = Buffer.concat([Buffer.from('xxxxx'), HEAVY, Buffer.from('yyy')]);
    expect(await reader.read(new Uint8Array(within.buffer, within.byteOffset + 5, HEAVY.length))).toEqual({ ok: false, why: 'too_slow' });
    expect(runs).toHaveLength(before);
    expect(reader.stuck!()).toBe(false);
    expect(reader.slow!()).toBe(1);
    expect((await reader.read(OTHER)).ok).toBe(true);
    expect(runs).toHaveLength(before + 1);
    expect(left(tmp)).toEqual([]);
  });

  it('for three hours by the reader’s clock; then it is tried once more, and remembered again if it runs out of time again', async () => {
    const { reader, runs, clock, unstick } = forgetful();
    expect(SLOW_FOR_MS).toBe(3 * 60 * 60 * 1000);
    await reader.read(HEAVY);
    await unstick();
    const before = runs.length;
    clock.t += SLOW_FOR_MS - 1;
    expect(await reader.read(HEAVY)).toEqual({ ok: false, why: 'too_slow' });
    expect(runs).toHaveLength(before);
    clock.t += 1;
    expect(await reader.read(HEAVY)).toEqual({ ok: false, why: 'too_slow' }); // tried: the program ran, and ran out of time
    expect(runs).toHaveLength(before + 1);
    expect(reader.slow!()).toBe(1);
    await unstick();
    clock.t += SLOW_FOR_MS - 1;
    expect(await reader.read(HEAVY)).toEqual({ ok: false, why: 'too_slow' });
    expect(runs).toHaveLength(before + 2); // (+1: Flint's own small PDF)
    // Forgotten when its time is up, whatever is asked for next.
    clock.t += 1;
    expect((await reader.read(OTHER)).ok).toBe(true);
    expect(reader.slow!()).toBe(0);
  });

  // A review (2026-10-15): two reads run at once, and one that only waited behind a heavy PDF ran out of time too. It
  // was remembered as too slow, and a PDF that is fine was refused for three hours with advice to send less of it.
  /** A reader with two at once, each read held until the test says how it ends; Flint's own small PDF answers at once once `free`. */
  const gated = () => {
    const tmp = scratch();
    const gates: Array<{ how: (v: 'timeout' | 'ok') => void; heavy: boolean }> = [];
    const waits: Array<() => void> = [];
    const state = { free: false };
    const run: RunProgram = async (_p, args, opts) => {
      const bytes = readFileSync(args.find((a) => a.endsWith('doc.pdf'))!);
      if (!bytes.includes('HEAVYQ') && !bytes.includes('another PDF')) {
        if (!state.free) throw new ReadTimedOut();
        return { stdout: RECORDED, truncated: false };
      }
      const how = await new Promise<'timeout' | 'ok' | 'abort'>((r) => {
        gates.push({ how: r, heavy: bytes.includes('HEAVYQ') });
        opts.signal?.addEventListener('abort', () => r('abort'), { once: true });
      });
      if (how === 'abort') throw new Error('the read was called off');
      if (how === 'timeout') throw new ReadTimedOut();
      return { stdout: RECORDED, truncated: false };
    };
    const reader = makePdfReader({ reader: 'spotlight', program: '/usr/bin/mdimport' }, { run, tmp, atOnce: 2, later: (fn) => void waits.push(fn) });
    const unstick = async (): Promise<void> => {
      state.free = true;
      waits.shift()!();
      await expect.poll(() => reader.stuck!(), WAIT).toBe(false);
      state.free = false;
    };
    /** The read under way of the heavy PDF, or of the other: two reads start in either order. */
    const gate = (heavy: boolean, from = 0) => gates.slice(from).find((g) => g.heavy === heavy)!;
    return { reader, gates, gate, waits, unstick };
  };

  it('a read beside another that runs out of time is told the reader is busy, and the one behind it too; neither is remembered the first time', async () => {
    const { reader, gates, gate, unstick } = gated();
    const heavy = reader.read(HEAVY);
    const fine = reader.read(OTHER);
    await expect.poll(() => gates.length, WAIT).toBe(2);
    gate(true).how('timeout'); // the heavy one first
    expect(await heavy).toEqual({ ok: false, why: 'busy' });
    gate(false).how('timeout'); // the one that waited behind it
    expect(await fine).toEqual({ ok: false, why: 'busy' });
    expect(reader.slow!()).toBe(0);
    await unstick();
    // The same pair again: the heavy one is first to run out of time a second time, and now it is remembered. The
    // other, which only ever timed out behind it, is not.
    const heavy2 = reader.read(HEAVY);
    const fine2 = reader.read(OTHER);
    await expect.poll(() => gates.length, WAIT).toBe(4);
    gate(true, 2).how('timeout');
    expect(await heavy2).toEqual({ ok: false, why: 'too_slow' });
    gate(false, 2).how('timeout');
    expect(await fine2).toEqual({ ok: false, why: 'busy' });
    expect(reader.slow!()).toBe(1);
    await unstick();
    const other = reader.read(OTHER);
    await expect.poll(() => gates.length, WAIT).toBe(5);
    gates[4]!.how('ok');
    expect((await other).ok).toBe(true);
    expect(await reader.read(HEAVY)).toEqual({ ok: false, why: 'too_slow' });
    expect(gates).toHaveLength(5); // refused at once: not handed over
  });

  it('a read called off while it waits its turn is never handed over, and leaves the reader as it was', async () => {
    const tmp = scratch();
    const gates: Array<(v: 'ok') => void> = [];
    let runs = 0;
    const run: RunProgram = async () => {
      runs++;
      await new Promise<'ok'>((r) => gates.push(r));
      return { stdout: RECORDED, truncated: false };
    };
    const reader = makePdfReader({ reader: 'spotlight', program: '/usr/bin/mdimport' }, { run, tmp, atOnce: 1, later: () => {} });
    const first = reader.read(OTHER);
    await expect.poll(() => gates.length, WAIT).toBe(1);
    const ac = new AbortController();
    const queued = reader.read(HEAVY, ac.signal);
    ac.abort();
    gates[0]!('ok');
    expect((await first).ok).toBe(true);
    expect(await queued).toEqual({ ok: false, why: 'failed' });
    expect(runs).toBe(1); // no program for the one called off
    expect(reader.stuck!()).toBe(false);
    // ...and the next read goes ahead.
    const next = reader.read(OTHER);
    await expect.poll(() => gates.length, WAIT).toBe(2);
    gates[1]!('ok');
    expect((await next).ok).toBe(true);
  });

  it('runProgram starts nothing for a read already called off', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(runProgram('/bin/sleep', ['5'], { timeoutMs: 10_000, maxBytes: 100, signal: ac.signal })).rejects.toThrow('called off');
  });

  it('a read called off once its PDF was handed over leaves the reader busy, as a time-out does: the next PDF is not read behind it and remembered', async () => {
    const { reader, gates, unstick } = gated();
    const ac = new AbortController();
    const big = reader.read(HEAVY, ac.signal);
    await expect.poll(() => gates.length, WAIT).toBe(1);
    ac.abort();
    expect(await big).toEqual({ ok: false, why: 'failed' });
    expect(reader.stuck!()).toBe(true);
    // The next PDF is told the reader is busy, at once: it is not handed to the Mac while it may still be at work.
    expect(await reader.read(OTHER)).toEqual({ ok: false, why: 'busy' });
    expect(gates).toHaveLength(1);
    expect(reader.slow!()).toBe(0);
    await unstick();
    const other = reader.read(OTHER);
    await expect.poll(() => gates.length, WAIT).toBe(2);
    gates[1]!.how('ok');
    expect((await other).ok).toBe(true);
  });

  it('a bounded list: with more of them than it holds, the oldest is forgotten first', async () => {
    const { reader, runs, unstick } = forgetful();
    expect(SLOW_REMEMBERED).toBe(64);
    const heavy = (i: number): Buffer => textPdf([[`HEAVYQ number ${i}`]]);
    for (let i = 0; i <= SLOW_REMEMBERED; i++) {
      expect(await reader.read(heavy(i))).toEqual({ ok: false, why: 'too_slow' });
      await unstick();
    }
    expect(reader.slow!()).toBe(SLOW_REMEMBERED);
    const before = runs.length;
    expect(await reader.read(heavy(1))).toEqual({ ok: false, why: 'too_slow' });
    expect(await reader.read(heavy(SLOW_REMEMBERED))).toEqual({ ok: false, why: 'too_slow' });
    expect(runs).toHaveLength(before);
    // The first of them was let go: it is handed over again (and runs out of time again).
    expect(await reader.read(heavy(0))).toEqual({ ok: false, why: 'too_slow' });
    expect(runs).toHaveLength(before + 1);
    expect(reader.slow!()).toBe(SLOW_REMEMBERED);
  });

  it('only a PDF someone sent, and only one that ran out of time: not Flint’s own small PDF, not a read that failed some other way', async () => {
    // Everything runs out of time, Flint's own small PDF too.
    const all = forgetful(() => true);
    await all.reader.read(OTHER);
    expect(all.reader.slow!()).toBe(1);
    all.waits.shift()!();
    await expect.poll(() => all.waits.length, WAIT).toBe(1); // tried, ran out of time, and to be tried again later
    expect(all.runs).toHaveLength(2);
    expect(all.reader.stuck!()).toBe(true);
    expect(all.reader.slow!()).toBe(1);
    all.reader.close!();
    // A read that fails is tried again the next time.
    let n = 0;
    const failing = makePdfReader({ reader: 'spotlight', program: '/usr/bin/mdimport' }, { tmp: scratch(), later: () => {}, run: async () => (n++ === 0 ? Promise.reject(new Error('the reader failed')) : { stdout: RECORDED, truncated: false }) });
    expect(await failing.read(HEAVY)).toEqual({ ok: false, why: 'failed' });
    expect(failing.slow!()).toBe(0);
    expect((await failing.read(HEAVY)).ok).toBe(true);
  });
});

describe('a read under way when the process is stopped', () => {
  it('its folder is removed, and its program ended, as the process exits: what `finally` cannot do then', async () => {
    const tmp = scratch();
    let folder = '';
    let release: () => void = () => {};
    const run: RunProgram = async (_p, _a, opts) => {
      folder = join(opts.cwd, '..');
      await new Promise<void>((r) => (release = r));
      return { stdout: RECORDED, truncated: false };
    };
    const pending = makePdfReader({ reader: 'spotlight', program: '/usr/bin/mdimport' }, { run, tmp }).read(textPdf([['kept on this Mac']]));
    await expect.poll(() => folder !== '' && existsSync(join(folder, 'read.noindex', 'doc.pdf')), WAIT).toBe(true);
    // What the process's exit hook runs (index.ts turns SIGTERM and SIGINT into an exit).
    endReadsNow();
    expect(existsSync(folder)).toBe(false);
    expect(left(tmp)).toEqual([]);
    release();
    await pending;
    expect(left(tmp)).toEqual([]);
    // The hook is one listener for the process, however many readers were made.
    expect(process.listeners('exit').filter((l) => l === endReadsNow)).toHaveLength(1);
  });

  it('the real program is ended with it: nothing Flint started outlives Flint', async () => {
    const tmp = scratch();
    const pidFile = join(tmp, 'program.pid');
    const running = runProgram('/bin/sh', ['-c', `echo $$ > ${JSON.stringify(pidFile)}; exec /bin/sleep 60`], { timeoutMs: 60_000, maxBytes: 4096, cwd: tmp });
    running.catch(() => {});
    await expect.poll(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim().length > 0, WAIT).toBe(true);
    const pid = Number(readFileSync(pidFile, 'utf8'));
    const alive = (): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    expect(alive()).toBe(true);
    endReadsNow();
    await expect.poll(alive, WAIT).toBe(false);
    await expect(running).rejects.toThrow();
  });
});

describe('a folder a crash left behind', () => {
  it('is removed once it is older than any read, by its name, and nothing else is touched', async () => {
    const [tmp, mine] = withReadsFolder();
    const old = join(mine, `${FOLDER_PREFIX}old`);
    const fresh = join(mine, `${FOLDER_PREFIX}fresh`);
    const other = join(mine, 'someone-elses');
    const file = join(mine, `${FOLDER_PREFIX}a-file`);
    for (const d of [old, fresh, other]) mkdirSync(join(d, 'read.noindex'), { recursive: true });
    writeFileSync(join(old, 'read.noindex', 'doc.pdf'), 'left behind');
    writeFileSync(file, 'not a folder');
    const now = Date.now();
    const before = new Date(now - LEFTOVER_AFTER_MS - 1000);
    utimesSync(old, before, before);
    utimesSync(other, before, before);
    utimesSync(file, before, before);
    expect(await sweepLeftovers(tmp, now)).toBe(1);
    expect(readdirSync(mine).sort()).toEqual([`${FOLDER_PREFIX}a-file`, `${FOLDER_PREFIX}fresh`, 'someone-elses'].sort());
  });

  // Each read used to list the whole temp folder to find what was left (a review: about 91,000 folders of other
  // programs' on this Mac, 50 ms a read). Only Flint's own folder is listed, and only what is in it can be removed.
  it('only Flint’s own folder is looked in: a folder by that name anywhere else under the temp folder is not Flint’s to remove', async () => {
    const [tmp, mine] = withReadsFolder();
    const GONE = 4_000_001;
    const beside = join(tmp, `${FOLDER_PREFIX}${GONE}-AbCdEf`);
    const inside = join(mine, `${FOLDER_PREFIX}${GONE}-AbCdEf`);
    for (const d of [beside, inside]) mkdirSync(join(d, 'read.noindex'), { recursive: true });
    const before = new Date(Date.now() - LEFTOVER_AFTER_MS - 1000);
    utimesSync(beside, before, before);
    expect(await sweepLeftovers(tmp, Date.now(), () => false)).toBe(1);
    expect(sweepLeftoversNow(tmp, Date.now(), () => false)).toBe(0);
    expect(readdirSync(tmp).sort()).toEqual([FOLDER_PARENT, `${FOLDER_PREFIX}${GONE}-AbCdEf`].sort());
    expect(readdirSync(mine)).toEqual([]);
  });

  it('Flint’s folder is made this user’s alone, and put right if it was opened up; a link or a file by its name is not used, and nothing is read', async () => {
    const tmp = scratch();
    expect(ownReadsFolder(tmp)).toBe(join(tmp, FOLDER_PARENT));
    expect(statSync(join(tmp, FOLDER_PARENT)).mode & 0o777).toBe(0o700);
    chmodSync(join(tmp, FOLDER_PARENT), 0o755);
    expect(ownReadsFolder(tmp)).toBe(join(tmp, FOLDER_PARENT));
    expect(statSync(join(tmp, FOLDER_PARENT)).mode & 0o777).toBe(0o700);
    // A link where the folder should be: someone else's doing. It is not followed, to read in or to sweep.
    for (const plant of ['link', 'file'] as const) {
      const bad = scratch();
      const target = join(bad, 'elsewhere');
      mkdirSync(join(target, `${FOLDER_PREFIX}4000001-AbCdEf`), { recursive: true });
      if (plant === 'link') symlinkSync(target, join(bad, FOLDER_PARENT));
      else writeFileSync(join(bad, FOLDER_PARENT), 'not a folder');
      expect(ownReadsFolder(bad)).toBeUndefined();
      let runs = 0;
      const reader = makePdfReader({ reader: 'spotlight', program: '/usr/bin/mdimport' }, { tmp: bad, running: () => false, run: async () => (runs++, { stdout: RECORDED, truncated: false }) });
      expect(await reader.read(textPdf([['hello']]))).toEqual({ ok: false, why: 'failed' });
      expect(runs).toBe(0);
      expect(await sweepLeftovers(bad, Date.now(), () => false)).toBe(0);
      expect(sweepLeftoversNow(bad, Date.now(), () => false)).toBe(0);
      expect(readdirSync(target)).toEqual([`${FOLDER_PREFIX}4000001-AbCdEf`]);
    }
  });

  it('a temp folder that is not there is nothing to sweep', async () => {
    expect(await sweepLeftovers(join(scratch(), 'gone'))).toBe(0);
    expect(sweepLeftoversNow(join(scratch(), 'gone'))).toBe(0);
  });

  // A server stopped in the middle of a read left the PDF on disk, and the next start left it there too: it was
  // younger than ten minutes. A folder's name now says who made it.
  it('one made by a process that is gone is removed at once, whatever its age; one made by a process still running is left until it is old', async () => {
    for (const sweep of [(tmp: string, now: number, running: (pid: number) => boolean) => sweepLeftovers(tmp, now, running), async (tmp: string, now: number, running: (pid: number) => boolean) => sweepLeftoversNow(tmp, now, running)]) {
      const [tmp, own] = withReadsFolder();
      const GONE = 4_000_001;
      const ALIVE = 4_000_002;
      const gone = join(own, `${FOLDER_PREFIX}${GONE}-AbCdEf`);
      const alive = join(own, `${FOLDER_PREFIX}${ALIVE}-AbCdEf`);
      const aliveOld = join(own, `${FOLDER_PREFIX}${ALIVE}-GhIjKl`);
      const mine = join(own, `${FOLDER_PREFIX}${process.pid}-MnOpQr`);
      for (const d of [gone, alive, aliveOld, mine]) {
        mkdirSync(join(d, 'read.noindex'), { recursive: true });
        writeFileSync(join(d, 'read.noindex', 'doc.pdf'), 'a PDF left behind');
      }
      const now = Date.now();
      const before = new Date(now - LEFTOVER_AFTER_MS - 1000);
      utimesSync(aliveOld, before, before);
      // (`mine`: this process's own, and not a read under way: a leftover of a failed removal.)
      expect(await sweep(tmp, now, (pid) => pid === ALIVE)).toBe(3);
      expect(readdirSync(own)).toEqual([`${FOLDER_PREFIX}${ALIVE}-AbCdEf`]);
    }
  });

  it('a link by that name is not a folder this made: it is left, and so is what it points at', async () => {
    const [tmp, mine] = withReadsFolder();
    const target = join(tmp, 'precious');
    mkdirSync(target);
    writeFileSync(join(target, 'keep.txt'), 'keep');
    const link = join(mine, `${FOLDER_PREFIX}4000001-AbCdEf`);
    symlinkSync(target, link);
    const before = new Date(Date.now() - LEFTOVER_AFTER_MS - 1000);
    utimesSync(target, before, before);
    expect(await sweepLeftovers(tmp, Date.now(), () => false)).toBe(0);
    expect(sweepLeftoversNow(tmp, Date.now(), () => false)).toBe(0);
    expect(existsSync(join(target, 'keep.txt'))).toBe(true);
    expect(readdirSync(mine)).toEqual([`${FOLDER_PREFIX}4000001-AbCdEf`]);
  });

  it('every read sweeps first: what a killed process left is gone by the time the next PDF is read, with no restart', async () => {
    const [tmp, mine] = withReadsFolder();
    const run: RunProgram = async () => ({ stdout: RECORDED, truncated: false });
    const reader = makePdfReader({ reader: 'spotlight', program: '/usr/bin/mdimport' }, { run, tmp, running: () => false });
    const stale = join(mine, `${FOLDER_PREFIX}4000001-AbCdEf`);
    mkdirSync(join(stale, 'read.noindex'), { recursive: true });
    writeFileSync(join(stale, 'read.noindex', 'doc.pdf'), 'a PDF left behind');
    expect((await reader.read(textPdf([['hello']]))).ok).toBe(true);
    expect(left(tmp)).toEqual([]);
  });

  it('a read under way in this process is never swept, by this reader or another', async () => {
    const tmp = scratch();
    let release: () => void = () => {};
    let inFlight = '';
    const slow: RunProgram = async (_p, _a, opts) => {
      inFlight = opts.cwd;
      await new Promise<void>((r) => (release = r));
      return { stdout: RECORDED, truncated: false };
    };
    const first = makePdfReader({ reader: 'spotlight', program: '/usr/bin/mdimport' }, { run: slow, tmp }).read(textPdf([['one']]));
    await expect.poll(() => inFlight !== '', WAIT).toBe(true);
    // Another reader is made (it sweeps at once) and reads (it sweeps again): the first read's file is still there.
    const other = makePdfReader({ reader: 'spotlight', program: '/usr/bin/mdimport' }, { run: async () => ({ stdout: RECORDED, truncated: false }), tmp });
    expect((await other.read(textPdf([['two']]))).ok).toBe(true);
    expect(existsSync(join(inFlight, 'doc.pdf'))).toBe(true);
    release();
    expect((await first).ok).toBe(true);
    expect(left(tmp)).toEqual([]);
  });

  it('making a reader sweeps', async () => {
    const [tmp, mine] = withReadsFolder();
    const old = join(mine, `${FOLDER_PREFIX}old`);
    mkdirSync(old);
    const before = new Date(Date.now() - LEFTOVER_AFTER_MS - 1000);
    utimesSync(old, before, before);
    makePdfReader({ reader: 'spotlight', program: '/usr/bin/mdimport' }, { tmp, run: async () => ({ stdout: '', truncated: false }) });
    await expect.poll(() => existsSync(old), WAIT).toBe(false);
  });
});

// The tests that read a PDF with the Mac's own importer are in test/process/local-media.test.ts, and
// `pnpm --filter server test` is what the deploy gate runs on the live Mac: a busy moment there must not fail a
// deploy, so the gate can never be opted in to them.
describe('the tests that run the real importer are opt-in, and the deploy gate never runs them', () => {
  const file = (path: string): string => readFileSync(join(__dirname, '..', path), 'utf8');

  it('they run only when FLINT_TEST_REAL_PDF=1 says so, on a Mac; no other test names the importer as a program to run', () => {
    const tests = file('test/process/local-media.test.ts');
    expect(tests).toContain("const REAL_PDF = ON_A_MAC && process.env.FLINT_TEST_REAL_PDF === '1';");
    expect(tests.match(/describe\.runIf\(REAL_PDF\)\(/g)!.length).toBeGreaterThanOrEqual(2);
    // The one server started with a PDF reader is behind that name.
    expect(tests.match(/FLINT_LOCAL_PDF: 'spotlight'/g)).toHaveLength(1);
    expect(tests).toMatch(/pdfTmp \? boot\(runs\.pdf\.dir, \{ FLINT_LOCAL_PDF: 'spotlight'/);
    expect(tests).toContain('const pdfTmp = REAL_PDF ? ');
    // How to run them is said where they are.
    expect(tests).toContain('FLINT_TEST_REAL_PDF=1 pnpm --filter server test:process');
  });

  it('install-server.sh clears the name before the gate runs the server tests, and nothing in the repo sets it', () => {
    const gate = file('install-server.sh');
    const cleared = gate.indexOf('\n  unset FLINT_TEST_REAL_PDF\n');
    const run = gate.indexOf('pnpm --filter server test ||');
    expect(cleared).toBeGreaterThan(-1);
    expect(run).toBeGreaterThan(cleared);
    expect(gate).not.toMatch(/FLINT_TEST_REAL_PDF=/);
    for (const path of ['package.json', 'vitest.config.ts', 'vitest.process.config.ts', 'auto_deploy.sh']) expect(file(path), path).not.toContain('FLINT_TEST_REAL_PDF');
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

  it('a program that is not there, one that fails, and one that runs out of time all reject; only the last is "out of time"', async () => {
    await expect(runProgram('/no/such/program', [], { timeoutMs: 10_000, maxBytes: 4096, cwd: tmpdir() })).rejects.not.toBeInstanceOf(ReadTimedOut);
    await expect(runProgram('/usr/bin/false', [], { timeoutMs: 10_000, maxBytes: 4096, cwd: tmpdir() })).rejects.not.toBeInstanceOf(ReadTimedOut);
    await expect(runProgram('/bin/sleep', ['30'], { timeoutMs: 50, maxBytes: 4096, cwd: tmpdir() })).rejects.toBeInstanceOf(ReadTimedOut);
  });

  it('what a failing program printed, on either stream, is in no error', async () => {
    const dir = scratch();
    const failing = runProgram('/bin/sh', ['-c', 'echo STDOUTCANARY; echo STDERRCANARY >&2; exit 3'], { timeoutMs: 10_000, maxBytes: 4096, cwd: dir });
    await expect(failing).rejects.toThrow('the reader failed');
    await failing.catch((e: Error) => expect(`${e.message} ${e.stack}`).not.toMatch(/CANARY/));
  });

  it('a read that was called off ends the program', async () => {
    const off = new AbortController();
    const running = runProgram('/bin/sleep', ['30'], { timeoutMs: 60_000, maxBytes: 4096, cwd: tmpdir(), signal: off.signal });
    off.abort();
    await expect(running).rejects.toThrow('called off');
    const already = new AbortController();
    already.abort();
    await expect(runProgram('/bin/sleep', ['30'], { timeoutMs: 60_000, maxBytes: 4096, cwd: tmpdir(), signal: already.signal })).rejects.toThrow('called off');
  });

  // The program is the head of a process group of its own: when it runs out of time, whatever it started goes too.
  it('out of time: the program AND what it started are killed together', async () => {
    const dir = scratch();
    const pidFile = join(dir, 'started.pid');
    await expect(runProgram('/bin/sh', ['-c', `/bin/sleep 60 & echo $! > ${JSON.stringify(pidFile)}; wait`], { timeoutMs: 400, maxBytes: 4096, cwd: dir })).rejects.toBeInstanceOf(ReadTimedOut);
    const started = Number(readFileSync(pidFile, 'utf8'));
    expect(started).toBeGreaterThan(1);
    const alive = (): boolean => {
      try {
        process.kill(started, 0);
        return true;
      } catch {
        return false;
      }
    };
    await expect.poll(alive, WAIT).toBe(false);
  });

  it('a program that has exited is never signalled, whatever it left behind: its number may be someone else’s by then', async () => {
    const dir = scratch();
    const pidFile = join(dir, 'left.pid');
    // The program prints, leaves something running that holds its output open, and exits at once.
    const out = await runProgram('/bin/sh', ['-c', `/bin/sleep 60 & echo $! > ${JSON.stringify(pidFile)}; echo printed`], { timeoutMs: 30_000, maxBytes: 4096, cwd: dir });
    expect(out).toEqual({ stdout: 'printed\n', truncated: false });
    const left = Number(readFileSync(pidFile, 'utf8'));
    let alive = true;
    try {
      process.kill(left, 0);
    } catch {
      alive = false;
    }
    // (Ended here, by its own number, so the test leaves nothing running.)
    try {
      process.kill(left, 'SIGKILL');
    } catch {
      /* gone already */
    }
    expect(alive).toBe(true);
  });
});
