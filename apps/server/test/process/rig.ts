/**
 * Start the REAL server (apps/server/src/index.ts, the file no unit test can
 * import: it runs main() when it loads) as a process of its own, for a test:
 *  - on a scratch HOME, so its token files, mode file, memory and training
 *    corpus are the test's own and nothing of Will's is read or written;
 *  - on a free port, never one a live Flint listens on;
 *  - with an environment built here from nothing: no key, token or setting of
 *    the shell that runs the test reaches it;
 *  - behind ./guard.mjs, which refuses every connection that is not to this
 *    machine, and every one to a live service's port, and records what the
 *    process tried;
 *  - with the commands that show, say or open things replaced by no-ops.
 * `stop()` ends that one process (by its own pid) and nothing else.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, '..', '..');
const REPO = join(SERVER, '..', '..');
const LIVE_PORTS = new Set([8080, 8081, 8090, 3333, 3334, 11434, 5432, 55432, 8888]);
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A port nothing is listening on, and never one a live service uses. */
export async function freePort(): Promise<number> {
  for (;;) {
    const port = await new Promise<number>((resolve, reject) => {
      const s = createServer();
      s.once('error', reject);
      s.listen(0, '::1', () => {
        const p = (s.address() as { port: number }).port;
        s.close(() => resolve(p));
      });
    });
    if (!LIVE_PORTS.has(port)) return port;
  }
}

export interface ChatEvent {
  type: string;
  [key: string]: unknown;
}
export interface Reply {
  status: number;
  /** A JSON answer's body. */
  json?: Record<string, unknown>;
  /** A stream's events, in order. */
  events?: ChatEvent[];
  /** The text of a streamed reply. */
  text?: string;
}
export interface GuardEntry {
  kind: string;
  host?: string;
  hostname?: string;
  port?: number;
  why?: string;
}

export interface Running {
  base: string;
  home: string;
  token: string;
  pid: number;
  get(path: string, token?: string | null): Promise<Reply>;
  post(path: string, body: unknown, token?: string | null): Promise<Reply>;
  /** Everything the process has written to its log. */
  log(): string;
  /** What the guard recorded: every connection the process made or was refused. */
  guard(): GuardEntry[];
  /** A scoped token the server wrote under the scratch HOME (voice, evolve, parity). */
  scoped(name: string): string;
  /** A file under the scratch HOME's .flint, or '' when it is not there. */
  read(...parts: string[]): string;
  stop(): Promise<void>;
}

/** Write the MCP config for the two stdio stand-ins; `log` is where each call they receive is recorded. */
export function writeMcpConfig(dir: string): { config: string; log: string; calls: () => Array<{ server: string; tool: string; args: Record<string, unknown> }> } {
  const log = join(dir, 'mcp-calls.jsonl');
  const config = join(dir, 'mcp.json');
  const sdk = join(SERVER, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm');
  writeFileSync(
    config,
    JSON.stringify({
      servers: ['web', 'trident'].map((name) => ({ name, command: process.execPath, args: [join(HERE, 'mcp-stub.mjs'), name], env: { MCP_STUB_LOG: log, MCP_SDK: sdk, PATH: process.env.PATH ?? '' } })),
    }),
  );
  return {
    config,
    log,
    calls: () =>
      existsSync(log)
        ? readFileSync(log, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((l) => JSON.parse(l) as { server: string; tool: string; args: Record<string, unknown> })
        : [],
  };
}

/** A scratch directory for one run, removed by `cleanup`. */
export function scratch(label: string): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), `flint-process-${label}-`));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * `seed`: files put under the scratch HOME's .flint before the server starts
 * (a conversation store, a memory): path parts, then the text.
 */
export async function startServer(opts: { dir: string; env: Record<string, string>; waitMs?: number; seed?: Array<{ path: string[]; text: string }> }): Promise<Running> {
  const port = await freePort();
  const home = join(opts.dir, 'home');
  mkdirSync(home, { recursive: true });
  for (const file of opts.seed ?? []) {
    const at = join(home, '.flint', ...file.path);
    mkdirSync(dirname(at), { recursive: true });
    writeFileSync(at, file.text);
  }
  const guardLog = join(opts.dir, 'guard.jsonl');
  const token = 'process-test-token-not-a-secret';
  // Built from nothing: only what a server needs to start, then the scenario's own settings.
  const env: Record<string, string> = {
    PATH: `${join(REPO, 'test-support', 'quiet-bin')}:${process.env.PATH ?? ''}`,
    HOME: home,
    PORT: String(port),
    FLINT_TOKEN: token,
    FLINT_WATCHER: 'off',
    // Memory extraction is a background pass that starts a minute and a half after boot: not part of this test.
    FLINT_MEMORY_BRAIN: 'off',
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    LANG: 'en_US.UTF-8',
    NODE_OPTIONS: `--import=${join(HERE, 'guard.mjs')}`,
    GUARD_LOG: guardLog,
    ...opts.env,
  };
  const proc = spawn(join(SERVER, 'node_modules', '.bin', 'tsx'), ['src/index.ts'], { cwd: SERVER, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  let exited = false;
  const onData = (d: Buffer): void => void (log += d.toString());
  proc.stderr.on('data', onData);
  proc.stdout.on('data', onData);
  proc.on('exit', () => (exited = true));
  const deadline = Date.now() + (opts.waitMs ?? 40_000);
  while (!log.includes('Flint listening') && !exited && Date.now() < deadline) await sleep(40);
  const stop = async (): Promise<void> => {
    if (!exited) {
      proc.kill('SIGTERM');
      for (let i = 0; i < 60 && !exited; i++) await sleep(50);
      if (!exited) proc.kill('SIGKILL');
      for (let i = 0; i < 20 && !exited; i++) await sleep(50);
    }
  };
  if (!log.includes('Flint listening')) {
    await stop();
    throw new Error(`the server did not start:\n${log.slice(-2000)}`);
  }
  const base = `http://[::1]:${port}`;
  const headers = (t: string | null | undefined): Record<string, string> => ({ 'content-type': 'application/json', ...(t === null ? {} : { authorization: `Bearer ${t ?? token}` }) });
  const answer = async (r: Response): Promise<Reply> => {
    const type = r.headers.get('content-type') ?? '';
    if (type.includes('event-stream')) {
      const events = (await r.text())
        .split('\n\n')
        .map((part) => /^data: (.*)$/m.exec(part)?.[1])
        .filter((j): j is string => !!j)
        .map((j) => JSON.parse(j) as ChatEvent);
      return { status: r.status, events, text: events.filter((e) => e.type === 'text').map((e) => String(e.delta)).join('') };
    }
    return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown> };
  };
  return {
    base,
    home,
    token,
    pid: proc.pid!,
    get: async (path, t) => answer(await fetch(base + path, { headers: headers(t) })),
    post: async (path, body, t) => answer(await fetch(base + path, { method: 'POST', headers: headers(t), body: JSON.stringify(body) })),
    log: () => log,
    guard: () =>
      existsSync(guardLog)
        ? readFileSync(guardLog, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((l) => JSON.parse(l) as GuardEntry)
        : [],
    scoped: (name) => readFileSync(join(home, '.flint', 'tokens', `${name}.token`), 'utf8').trim(),
    read: (...parts) => {
      const file = join(home, '.flint', ...parts);
      return existsSync(file) ? readFileSync(file, 'utf8') : '';
    },
    stop,
  };
}

/** The [route] lines of a log, parsed. */
export const routeLines = (log: string): Array<Record<string, unknown>> =>
  log
    .split('\n')
    .filter((l) => l.startsWith('[route] '))
    .map((l) => JSON.parse(l.slice('[route] '.length)) as Record<string, unknown>);
