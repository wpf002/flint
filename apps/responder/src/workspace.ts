import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

/*
 * Where a thread's work actually lives, and what it is allowed to do there.
 *
 * Artifacts alone produce files nobody has run. A product needs the other half of the
 * loop — write it, run it, see it fail, fix it — and that requires executing something a
 * model wrote, which is the most dangerous thing in this system by a wide margin.
 *
 * So the posture is deliberately narrow rather than clever:
 *
 *   It runs in a container, not on the machine. The allowlist stops a model asking for
 *   something obviously wrong; it does nothing about `pnpm install` running a package's
 *   postinstall script, which is arbitrary code from a stranger. That is the real hole,
 *   and the only honest fix is for the command to run somewhere it cannot do harm —
 *   this loop is unattended, on a machine holding API keys and every repository.
 *
 *   No shell. Commands are spawned as argv arrays, so there is no string for a model to
 *   smuggle `; rm -rf ~` through.
 *
 *   An allowlist of binaries AND their first argument. `pnpm` is not permitted; `pnpm
 *   install` is. A permitted binary with an arbitrary subcommand is barely a restriction.
 *
 *   Pinned to the thread's own directory, checked after resolution so a path containing
 *   `..` cannot climb out.
 *
 *   Off unless switched on. Nothing here runs by default.
 */

/** Binary to the subcommands it may be given. An empty list means the bare binary only. */
const ALLOWED: Record<string, string[]> = {
  node: ['--version'],
  npm: ['install', 'ci', 'run', 'test', '--version'],
  pnpm: ['install', 'run', 'test', 'build', 'typecheck', '--version'],
  npx: ['tsc', 'vitest', 'prettier', 'eslint'],
  tsc: ['--noEmit', '--version'],
  vitest: ['run'],
  python3: ['--version', '-m'],
  git: ['init', 'status', 'diff', 'add', 'log'],
  ls: [],
  cat: [],
};

const TIMEOUT_MS = 180_000;
/** Enough to see a failure; not enough to bury a turn in build noise. */
const MAX_OUTPUT = 6_000;

export interface RunResult {
  command: string;
  ok: boolean;
  code: number | null;
  output: string;
}

export function workspaceFor(root: string, threadId: string): string {
  const dir = join(root, threadId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Writes an artifact into the workspace as a real file.
 *
 * The name is resolved and then checked to be inside the workspace, rather than
 * inspected for `..` beforehand — the check that matters is where a path actually
 * lands, not what it looks like.
 */
export function materialise(workspace: string, name: string, content: string): string {
  const target = resolve(workspace, name);
  if (target !== workspace && !target.startsWith(workspace + sep)) {
    throw new Error(`'${name}' resolves outside the thread's workspace.`);
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, 'utf8');
  return target;
}

/** Why a command is not allowed, or null if it is. */
export function refuse(argv: string[]): string | null {
  const [binary, first] = argv;
  if (!binary) return 'no command given';

  const allowed = ALLOWED[binary];
  if (!allowed) {
    return `'${binary}' is not one of: ${Object.keys(ALLOWED).join(', ')}`;
  }
  if (allowed.length > 0 && (!first || !allowed.includes(first))) {
    return `'${binary}' may only be used with: ${allowed.join(', ')}`;
  }
  return null;
}

/** Image with node, pnpm and python already present, so no install step needs network. */
const IMAGE = process.env.RESPONDER_RUNNER_IMAGE ?? 'node:22-bookworm-slim';

/**
 * Builds the docker arguments for one command.
 *
 * The allowlist stops a model asking for something obviously wrong. It does not stop
 * `pnpm install` running a package's postinstall script, which is arbitrary code from a
 * stranger and the actual hole — so the command runs somewhere it cannot do harm rather
 * than being trusted not to.
 *
 * What the container gets: the thread's own directory, and nothing else. No network,
 * so a postinstall cannot phone home or pull a second payload — which does mean an
 * install of new dependencies fails, and that is the trade being made. A read-only root
 * with a small writable /tmp, dropped capabilities, no privilege escalation, and caps on
 * memory, CPU and process count so a runaway build cannot take the machine with it.
 */
function dockerArgs(workspace: string, argv: string[]): string[] {
  return [
    'run',
    '--rm',
    '--network=none',
    '--read-only',
    '--tmpfs=/tmp:rw,size=256m',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    '--memory=1g',
    '--cpus=1',
    '--pids-limit=256',
    // Never root, and never the host's root either: files it writes stay owned by you.
    `--user=${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
    `--volume=${workspace}:/work`,
    '--workdir=/work',
    '--env=CI=1',
    '--env=NO_COLOR=1',
    '--env=HOME=/tmp',
    IMAGE,
    ...argv,
  ];
}

/**
 * Runs one command against a thread's files, inside a container.
 *
 * Never rejects: a command that fails is a result the thread needs to see, not an error
 * for the loop to handle. Failure is the interesting case — it is what the next
 * participant fixes.
 */
export async function run(workspace: string, argv: string[]): Promise<RunResult> {
  const command = argv.join(' ');
  const why = refuse(argv);
  if (why) return { command, ok: false, code: null, output: `Refused: ${why}` };

  return new Promise<RunResult>((done) => {
    const child = spawn('docker', dockerArgs(workspace, argv), {
      // No shell: argv goes to docker as arguments, never through a parser that would
      // interpret a semicolon or a backtick.
      shell: false,
      timeout: TIMEOUT_MS,
    });

    let output = '';
    const collect = (chunk: Buffer) => {
      if (output.length < MAX_OUTPUT) output += chunk.toString();
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);

    child.on('error', (err) =>
      done({
        command,
        ok: false,
        code: null,
        // Naming docker matters: "could not run it" would send a participant off
        // rewriting perfectly good code to fix a machine problem.
        output: `Could not start the container: ${err.message}. Is Docker running?`,
      }),
    );
    child.on('close', (code) =>
      done({
        command,
        ok: code === 0,
        code,
        output:
          output.length > MAX_OUTPUT ? `${output.slice(0, MAX_OUTPUT)}\n… (truncated)` : output.trim(),
      }),
    );
  });
}
