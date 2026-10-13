/**
 * The voice benchmark, as a command (../src/voice-bench has what it does and
 * what it never does).
 *
 *   pnpm --filter server voice-bench                      measure what is on this Mac, print the tables
 *   pnpm --silent --filter server voice-bench -- --json   the same, as JSON on stdout
 *   pnpm --filter server voice-bench -- --out ~/Desktop/voice --voices Samantha,Daniel --rates 175
 *   pnpm --filter server voice-bench -- --clips ~/Desktop/my-clips    hear clips you recorded (name.wav beside name.txt)
 *
 * It makes synthetic clips with the Mac's own `say` (into files: nothing is
 * played), transcribes them with every whisper.cpp model that is already on
 * this Mac (one run per clip, as Flint does today, and through whisper.cpp's
 * own server as Flint's local provider would), speaks ten sentences with the
 * Mac's own voices, and prints the time each took, the real-time factor and
 * the word error rate. The clips, the speech and the results (results.md,
 * results.json) are left in the output folder: a dated one under
 * ~/Library/Caches/Flint/voice-bench unless `--out` names another, which only
 * this user can read (the folder 0700, its files 0600). Never under ~/.flint:
 * the nightly and the offsite backups would carry the audio.
 *
 * Nothing is downloaded or installed: for a model or an engine that is not
 * here it prints the exact command. Nothing is sent off this Mac, unless
 * OpenAI's speech is named with `--tts ... openai` AND a cap is given with
 * `--budget-usd`: then the estimate is printed before anything is sent, and
 * without a cap that covers it the command stops and sends nothing. A paid
 * run is outside Flint's spend record (the server's budget neither counts it
 * nor stops it): it says so before it sends anything, and again afterwards
 * with what it sent and what that costs.
 *
 * It changes no setting. Exit codes: 0 done; 1 nothing could be measured; 2
 * the arguments were not understood, or a paid provider was asked for and
 * not allowed.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { cpus, homedir, platform, release, tmpdir, totalmem } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readInferenceConfig } from '../src/inference-config';
import { BENCH_SERVER_HOST, SENTENCES, USAGE, defaultOut, paidPlan, parseBenchArgs, renderBench, runBench, type BenchDeps, type BenchResult, type StartedServer } from '../src/voice-bench';
import { isFile, openAiSpeech, runFile } from '../src/voice';

type Env = Record<string, string | undefined>;

/** The servers this run started: each is stopped when it is done with, and all of them if the run ends early. */
const started = new Set<ChildProcess>();
const stopAll = (): void => {
  for (const child of started) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
  started.clear();
};

/** A port on this Mac nobody is listening on. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, SERVER_HOST, () => {
      const at = s.address();
      s.close(() => (at && typeof at === 'object' ? resolve(at.port) : reject(new Error('no port'))));
    });
  });
}

/** How long whisper.cpp's server is given to read its model and answer. */
const SERVER_START_MS = 90_000;

/** The one address the transcription server this run starts may listen on: this Mac, and nothing a network can reach. */
export const SERVER_HOST = BENCH_SERVER_HOST;

/** What whisper.cpp's server is started with: one model, this Mac alone, a port of its own, and the path an OpenAI-compatible client asks. */
export function serverArgs(model: string, port: number): string[] {
  return ['-m', model, '--host', SERVER_HOST, '--port', String(port), '--inference-path', '/v1/audio/transcriptions'];
}

/**
 * Start whisper.cpp's own server with one model: on 127.0.0.1 alone, on a
 * free port, answering the path an OpenAI-compatible client asks. Fixed
 * arguments, no shell. Undefined when it did not come up.
 */
export async function startWhisperServer(bin: string, model: string): Promise<StartedServer | undefined> {
  const port = await freePort();
  const began = performance.now();
  const child = spawn(bin, serverArgs(model, port), { stdio: 'ignore', shell: false, env: { PATH: '/usr/bin:/bin', HOME: tmpdir(), TMPDIR: tmpdir() } });
  started.add(child);
  let gone = false;
  child.once('exit', () => {
    gone = true;
    started.delete(child);
  });
  child.once('error', () => {
    gone = true;
    started.delete(child);
  });
  const stop = (): Promise<void> =>
    new Promise((resolve) => {
      if (gone) return resolve();
      const hard = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }, 3_000);
      child.once('exit', () => {
        clearTimeout(hard);
        resolve();
      });
      child.kill('SIGTERM');
    });
  while (!gone && performance.now() - began < SERVER_START_MS) {
    try {
      // Any answer at all means it is listening (its own page is at /).
      const r = await fetch(`http://${SERVER_HOST}:${port}/`, { signal: AbortSignal.timeout(1_000), redirect: 'error' });
      await r.body?.cancel().catch(() => {});
      return { baseURL: `http://${SERVER_HOST}:${port}/v1`, loadMs: performance.now() - began, stop };
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  await stop();
  return undefined;
}

/** This Mac, as the results name it: the chip, the memory, the macOS version. */
async function machine(): Promise<BenchResult['machine']> {
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
  bench?: Partial<BenchDeps>;
}

export async function main(argv: readonly string[], d: MainDeps): Promise<number> {
  const args = parseBenchArgs(argv);
  if ('error' in args) {
    d.err(`voice-bench: ${args.error}.`);
    d.err(USAGE);
    return 2;
  }
  if (args.help) {
    d.out(USAGE);
    return 0;
  }
  // The paid side first, before anything is made or sent: asked for and not allowed, the command stops here.
  const paid = paidPlan(args, SENTENCES, { model: openAiSpeech(readInferenceConfig(d.env, undefined, { home: d.home }).voice).model, hasKey: !!d.env.OPENAI_API_KEY?.trim() });
  if (paid.asked && !paid.run) {
    d.err(paid.sentence);
    return 2;
  }
  const deps: BenchDeps = {
    env: d.env,
    run: runFile,
    now: () => performance.now(),
    readFile: (p) => readFileSync(p),
    writeFile: (p, data) => writeFileSync(p, data, { mode: 0o600 }),
    mkdir: (p) => void mkdirSync(p, { recursive: true, mode: 0o700 }),
    // (whisper.cpp's program has to be one that can be run, and its model a file: the same look the server takes.)
    exists: (p, kind) => (kind ? isFile(p, kind) : existsSync(p)),
    remove: (p) => rmSync(p, { force: true }),
    list: (dir) => {
      try {
        return readdirSync(dir);
      } catch {
        return [];
      }
    },
    join,
    startServer: startWhisperServer,
    machine: await machine(),
    home: d.home,
    platform: platform(),
    log: (line) => d.err(line),
    when: new Date().toISOString(),
    ...d.bench,
  };
  let result: BenchResult;
  try {
    result = await runBench(args, deps);
  } finally {
    stopAll();
  }
  const out = args.out ?? defaultOut(d.home, result.when, join);
  const page = renderBench(result);
  try {
    deps.mkdir(out);
    deps.writeFile(join(out, 'results.json'), `${JSON.stringify(result, null, 2)}\n`);
    deps.writeFile(join(out, 'results.md'), `${page}\n`);
    d.err(`The clips, the speech and the results are in ${out}.`);
  } catch {
    d.err('The results could not be saved to the output folder. They are printed below.');
  }
  d.out(args.json ? JSON.stringify(result, null, 2) : page);
  return result.stt.length + result.tts.length > 0 ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  // Everything this run and the programs it starts leave behind is this user's alone: folders 0700, files 0600.
  process.umask(0o077);
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.once(sig, () => {
      stopAll();
      process.exit(1);
    });
  }
  process.once('exit', stopAll);
  main(process.argv.slice(2), { env: process.env, home: homedir(), out: (l) => console.log(l), err: (l) => console.error(l) }).then(
    (code) => process.exit(code),
    () => {
      // Never the error's own text: it can carry a path or a value from the environment.
      console.error('voice-bench: the benchmark could not be run.');
      process.exit(1);
    },
  );
}
