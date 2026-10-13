/**
 * The vision benchmark, as a command (../src/vision-bench has what it does and
 * what it never does).
 *
 *   pnpm --filter server vision-bench                      measure what is on this Mac, print the tables
 *   pnpm --silent --filter server vision-bench -- --json   the same, as JSON on stdout
 *   pnpm --filter server vision-bench -- --model <name> --runs 3 --out ~/Desktop/vision
 *
 * It draws six pictures and writes four PDFs (synthetic: nobody's file is
 * read), reads the PDFs with every PDF reader that is already on this Mac,
 * and puts one question a picture, and one a PDF, to the local model: the one
 * that is ALREADY IN MEMORY on the model server and can see, at the context
 * it is loaded with. It prints whether each answer is right and how long it
 * took. The pictures, the PDFs and the results (results.md, results.json) are
 * left in the output folder: a dated one under
 * ~/Library/Caches/Flint/vision-bench unless `--out` names another, which only
 * this user can read (the folder 0700, its files 0600). Never under ~/.flint.
 *
 * Nothing is downloaded, loaded, unloaded or installed: a model that is not
 * in memory is not asked, and for a reader that is not here the command that
 * installs it is printed. Only a model server on this Mac is asked. It
 * changes no setting. Exit codes: 0 done; 1 nothing could be measured; 2 the
 * arguments were not understood.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, homedir, release, totalmem } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { USAGE, defaultOut, parseVisionArgs, realReader, renderVision, runVisionBench, type VisionDeps, type VisionResult } from '../src/vision-bench';
import { isFile, runFile } from '../src/voice';

type Env = Record<string, string | undefined>;

/** This Mac, as the results name it: the chip, the memory, the macOS version. */
async function machine(): Promise<VisionResult['machine']> {
  let os = release();
  try {
    os = (await runFile('/usr/bin/sw_vers', ['-productVersion'], { timeout: 5_000 })).stdout.trim() || os;
  } catch {
    /* not a Mac: the kernel's own version */
  }
  return { chip: cpus()[0]?.model.trim() || 'unknown', memoryGb: Math.round(totalmem() / 2 ** 30), os: /^[0-9A-Za-z. -]{1,40}$/.test(os) ? os : 'unknown' };
}

export interface MainDeps {
  env: Env;
  home: string;
  out: (line: string) => void;
  err: (line: string) => void;
  /** Everything that touches the machine. Left out: the real things. */
  bench?: Partial<VisionDeps>;
}

export async function main(argv: readonly string[], d: MainDeps): Promise<number> {
  const args = parseVisionArgs(argv);
  if ('error' in args) {
    d.err(`vision-bench: ${args.error}.`);
    d.err(USAGE);
    return 2;
  }
  if (args.help) {
    d.out(USAGE);
    return 0;
  }
  const when = new Date().toISOString();
  const out = args.out ?? defaultOut(d.home, when, join);
  let folder = false;
  try {
    mkdirSync(out, { recursive: true, mode: 0o700 });
    folder = true;
  } catch {
    /* said below */
  }
  const deps: VisionDeps = {
    env: d.env,
    fetch,
    now: () => performance.now(),
    exists: (p, kind) => isFile(p, kind),
    reader: realReader,
    save: (name, data) => {
      if (!folder) return;
      try {
        writeFileSync(join(out, name), data, { mode: 0o600 });
      } catch {
        /* a file that could not be saved is not a result */
      }
    },
    // (Asked of this Mac only when nobody handed one in: a test names its own, and runs no program.)
    machine: d.bench?.machine ?? (await machine()),
    when,
    log: (line) => d.err(line),
    ...d.bench,
  };
  const result = await runVisionBench(args, deps);
  const page = renderVision(result);
  deps.save('results.json', `${JSON.stringify(result, null, 2)}\n`);
  deps.save('results.md', `${page}\n`);
  d.err(folder ? `The pictures, the PDFs and the results are in ${out}.` : 'The results could not be saved to the output folder. They are printed below.');
  d.out(args.json ? JSON.stringify(result, null, 2) : page);
  return result.pictures.length + result.pdfReads.length > 0 ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  // Everything this run leaves behind is this user's alone: folders 0700, files 0600.
  process.umask(0o077);
  main(process.argv.slice(2), { env: process.env, home: homedir(), out: (l) => console.log(l), err: (l) => console.error(l) }).then(
    (code) => process.exit(code),
    () => {
      // Never the error's own text: it can carry a path or a value from the environment.
      console.error('vision-bench: the benchmark could not be run.');
      process.exit(1);
    },
  );
}
