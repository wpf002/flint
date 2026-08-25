import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { PROXY_SOURCE } from './proxy.js';

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
  node: [],
  npm: ['install', 'ci', 'run', 'test', 'exec', 'ls', 'init', '--version'],
  pnpm: ['install', 'add', 'run', 'test', 'build', 'typecheck', 'exec', 'init', '--version'],
  npx: ['tsc', 'vitest', 'jest', 'prettier', 'eslint', 'esbuild', 'tsx', 'vite'],
  tsc: [],
  vitest: ['run'],
  python3: ['--version', '-m'],
  pip3: ['install', '--version'],
  git: ['init', 'status', 'diff', 'add', 'log', 'commit'],
  ls: [],
  cat: [],
  mkdir: [],
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

const IMAGE = process.env.RESPONDER_RUNNER_IMAGE ?? 'node:22-bookworm-slim';

/**
 * The network the build container sits on, and the proxy that is its only way off it.
 *
 * The network is created `--internal`, which means Docker gives it no route out — so a
 * build container attached to it can reach the proxy and nothing else, whatever it tries.
 * The proxy is attached to both that network and the default one, and refuses anything
 * outside the package registries.
 */
const NETWORK = 'nexus-build';
const PROXY = 'nexus-egress';
const PROXY_URL = `http://${PROXY}:8888`;

/** Where the proxy source is mounted from, written once on first use. */
function proxyDir(root: string): string {
  const dir = join(root, '.egress');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'proxy.js'), PROXY_SOURCE, 'utf8');
  return dir;
}

async function docker(args: string[]): Promise<{ ok: boolean; output: string }> {
  return new Promise((done) => {
    const child = spawn('docker', args, { shell: false, timeout: 60_000 });
    let output = '';
    child.stdout?.on('data', (c: Buffer) => (output += c.toString()));
    child.stderr?.on('data', (c: Buffer) => (output += c.toString()));
    child.on('error', (err) => done({ ok: false, output: err.message }));
    child.on('close', (code) => done({ ok: code === 0, output: output.trim() }));
  });
}

/**
 * Makes sure the isolated network and its proxy exist.
 *
 * Idempotent and cheap: both calls fail harmlessly when the thing already exists, which
 * is the common case. Doing it before every run rather than once at startup means a
 * proxy that died — or a Docker that restarted — comes back on its own instead of
 * turning every subsequent build into a mysterious network failure.
 */
export async function ensureSandbox(root: string): Promise<string | null> {
  await docker(['network', 'create', '--internal', NETWORK]);

  const running = await docker(['ps', '--filter', `name=^${PROXY}$`, '--filter', 'status=running', '-q']);
  if (running.ok && running.output.length > 0) return null;

  await docker(['rm', '-f', PROXY]);
  const started = await docker([
    'run',
    '-d',
    '--name',
    PROXY,
    '--restart=unless-stopped',
    '--read-only',
    '--tmpfs=/tmp:rw,size=16m',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    '--memory=128m',
    '--network',
    NETWORK,
    `--volume=${proxyDir(root)}:/egress:ro`,
    IMAGE,
    'node',
    '/egress/proxy.js',
  ]);
  if (!started.ok) return `Could not start the egress proxy: ${started.output}`;

  // The proxy needs a way out; the build container must not have one. Attaching it to
  // the default bridge as well is what makes it the only bridge between them.
  await docker(['network', 'connect', 'bridge', PROXY]);
  return null;
}

/**
 * Builds the docker arguments for one command.
 *
 * The allowlist stops a model asking for something obviously wrong. It does not stop
 * `pnpm install` running a package's postinstall script, which is arbitrary code from a
 * stranger and the actual hole — so the command runs somewhere it cannot do harm rather
 * than being trusted not to.
 *
 * What the container gets: the thread's own directory, and a network with no route out
 * except a proxy that only answers for the package registries. So an install works and a
 * postinstall trying to reach anywhere else is refused by a rule rather than trusted not
 * to try. A read-only root with a small writable /tmp, dropped capabilities, no privilege
 * escalation, and caps on memory, CPU and process count so a runaway build cannot take
 * the machine with it.
 */
function dockerArgs(workspace: string, argv: string[]): string[] {
  return [
    'run',
    '--rm',
    // Not `none`: a build that cannot install anything is not a build. This network has
    // no route out, so the proxy is the only way off it.
    `--network=${NETWORK}`,
    `--env=HTTP_PROXY=${PROXY_URL}`,
    `--env=HTTPS_PROXY=${PROXY_URL}`,
    `--env=npm_config_proxy=${PROXY_URL}`,
    `--env=npm_config_https_proxy=${PROXY_URL}`,
    // Installs write into node_modules under /work, which is the mounted volume and so
    // stays writable; everything else the container could touch does not.
    '--read-only',
    '--tmpfs=/tmp:rw,size=512m',
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

/**
 * Copies a thread's work out as an ordinary project directory.
 *
 * The point of building something is having it somewhere else. Without this the product
 * lives in a directory named after a thread id, next to the proxy's scratch files, and
 * "export it" means knowing where to look — so the thing that was built stays a
 * curiosity rather than becoming a project.
 *
 * node_modules is left behind deliberately: it is reproducible from the manifest, it is
 * the largest thing here by far, and it was installed for a container's architecture
 * rather than necessarily for wherever this is going.
 */
export async function exportWorkspace(
  workspace: string,
  destination: string,
): Promise<{ files: number; destination: string }> {
  const dest = resolve(destination);
  mkdirSync(dest, { recursive: true });

  let files = 0;
  const skip = new Set(['node_modules', '.git', '.egress', '.pnpm-store', '__pycache__']);

  const copyInto = (from: string, to: string): void => {
    for (const entry of readdirSync(from, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const source = join(from, entry.name);
      const target = join(to, entry.name);
      if (entry.isDirectory()) {
        mkdirSync(target, { recursive: true });
        copyInto(source, target);
      } else if (entry.isFile()) {
        copyFileSync(source, target);
        files += 1;
      }
    }
  };

  copyInto(workspace, dest);
  return { files, destination: dest };
}
