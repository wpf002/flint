/**
 * The status command: this machine's hardware tier, the local model that was
 * chosen and its state, and the routing mode.
 *
 *   pnpm --filter server inference-status                 what Flint is running on, in sentences
 *   pnpm --silent --filter server inference-status -- --json   the same, as the object GET /inference returns
 *                                                         (--silent: pnpm prints two lines of its own on stdout otherwise)
 *   pnpm --filter server inference-status -- --mode local   switch the running server (local | hybrid | cloud | reset)
 *
 * With the server running it asks the server (GET /inference), so the mode,
 * the settings and the cloud side are the live ones. Its token is read the way
 * Flint's other commands read it: FLINT_TOKEN, else the file ~/.flint/token.
 *
 * With the server stopped, or with no token, it still answers: it detects the
 * hardware, reads the tier table, and takes one read-only look at the local
 * model server. That answer is built from THIS SHELL's settings, which may not
 * be the running server's, and it says so. A server that refuses the token
 * (401, 403) is not that case: the command says the token was refused and
 * stops, so a wrong token is never mistaken for a status.
 *
 * `--mode` changes the running server (POST /inference/mode), so it needs the
 * server and the token. With `--json`, only the object is on stdout: every
 * other line ("The mode is now ...", the notes) goes to stderr. The object
 * says whose answer it is in its first field, `view`: `running_server`, or
 * `this_shell` when it was built here from this shell's settings.
 *
 * It never downloads a model. For one that is not installed it prints the
 * exact `ollama pull` line and the size of the download, for Will to run.
 *
 * Exit codes: 0 done; 1 it could not be done (the sentence on stderr says
 * why); 2 the arguments were not understood.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MODES, readEnvProxy, viaProxy, type InferenceMode } from '../src/inference-config';
import { buildInference } from '../src/inference';
import type { InferenceStatus } from '../src/inference-status';

type Env = Record<string, string | undefined>;

export interface Args {
  json: boolean;
  /** A mode to switch to, or `reset` to go back to FLINT_INFERENCE_MODE. */
  mode?: InferenceMode | 'reset';
}

const USAGE = `use --json, or --mode <${MODES.join('|')}|reset>`;

/**
 * The arguments, or a sentence saying what is wrong with them. An argument
 * that is not understood is never repeated back: what was pasted there may be
 * a token.
 */
export function parseArgs(argv: readonly string[]): Args | { error: string } {
  const args: Args = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--') continue;
    if (a === '--json') args.json = true;
    else if (a === '--mode') {
      const v = argv[++i];
      if (v !== 'reset' && !(MODES as readonly string[]).includes(v ?? '')) return { error: `--mode is one of ${MODES.join(', ')}, or reset` };
      args.mode = v as InferenceMode | 'reset';
    } else return { error: `an argument was not understood (${USAGE})` };
  }
  return args;
}

/** Whose answer a status is: the running server's, or one built in this process from this shell's settings. */
export type View = 'running_server' | 'this_shell';

/**
 * What is printed: the sentences, or the object. The object says whose answer
 * it is (`view`, first), because nothing else in it does: the sentence that
 * says so to a person goes to stderr, where a script does not read it.
 */
export function render(status: InferenceStatus, args: Pick<Args, 'json'>, note?: string, view: View = 'running_server'): string {
  if (args.json) return JSON.stringify({ view, ...status }, null, 2);
  return [...status.lines, ...(note ? [note] : [])].join('\n');
}

/** The running server's address on this Mac: it binds loopback (::1) on PORT. */
export function serverUrl(env: Env): string {
  const port = /^\d{2,5}$/.test(env.PORT?.trim() ?? '') ? env.PORT!.trim() : '8080';
  return `http://[::1]:${port}`;
}

/** Flint's bearer token: FLINT_TOKEN, then the file ~/.flint/token (as apps/parity and apps/evolve read it). Never printed. */
export function flintToken(env: Env, home: string): string | undefined {
  const fromEnv = env.FLINT_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  const file = join(home, '.flint', 'token');
  try {
    if (existsSync(file)) {
      const t = readFileSync(file, 'utf8').trim();
      if (t) return t;
    }
  } catch {
    /* a file that cannot be read is no token */
  }
  return undefined;
}

/** What asking the running server came to. */
export type Asked = { kind: 'no_token' } | { kind: 'proxied' } | { kind: 'down' } | { kind: 'answer'; status: number; json: Record<string, unknown> };

/**
 * Ask the running server. Never throws: no token and a server that is not
 * answering are answers of their own. So is `proxied`: with Node's env proxy
 * on (NODE_USE_ENV_PROXY) and this Mac not in NO_PROXY, the request, bearer
 * token and all, would go to the proxy first. It is not sent.
 */
export async function askServer(env: Env, token: string | undefined, path: string, body?: unknown, f: typeof fetch = fetch, execArgv?: readonly string[]): Promise<Asked> {
  if (!token) return { kind: 'no_token' };
  if (viaProxy(new URL(serverUrl(env)).host, readEnvProxy(env, execArgv))) return { kind: 'proxied' };
  try {
    const res = await f(`${serverUrl(env)}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    });
    return { kind: 'answer', status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  } catch {
    return { kind: 'down' };
  }
}

const TOKEN_HOW = 'Set FLINT_TOKEN, or put the token in the file ~/.flint/token.';
const PROXY_HOW = "Node's env proxy is on (NODE_USE_ENV_PROXY) and NO_PROXY does not name this Mac, so this command's token would go to the proxy first. Add ::1 to NO_PROXY, or run it without the proxy.";
const refused = (status: number): boolean => status === 401 || status === 403;
/** A mode's name as the server gave it, when it is one; never an arbitrary string from a response. */
const modeName = (v: unknown): string => (typeof v === 'string' && (MODES as readonly string[]).includes(v) ? v : 'unknown');

export interface RunDeps {
  env: Env;
  home: string;
  fetch?: typeof fetch;
  /** The status built without the server (tests: nothing is detected or probed). */
  offline?: () => Promise<InferenceStatus>;
  out: (line: string) => void;
  err: (line: string) => void;
}

/** The status built in this process: detect, read the table, look at the model server. Nothing is written or loaded. */
async function offlineStatus(env: Env, home: string): Promise<InferenceStatus> {
  // observeOnly: no timer, no warm-up and no asking again, so a status never starts a model load, whatever the mode.
  const inference = await buildInference({ env, modeFile: join(home, '.flint', 'inference.json'), observeOnly: true });
  try {
    // The machine and the model server are looked at behind the build: a status waits for that look (each part of it is cut off by the clock).
    await inference.ready;
    return await inference.status();
  } finally {
    inference.stop();
  }
}

/** The command. Returns its exit code; every line it prints goes through `out` (stdout) or `err` (stderr). */
export async function run(argv: readonly string[], deps: RunDeps): Promise<number> {
  const { env, out, err } = deps;
  const args = parseArgs(argv);
  if ('error' in args) {
    err(`inference-status: ${args.error}`);
    return 2;
  }
  const token = flintToken(env, deps.home);
  // With --json, stdout is the object and nothing else.
  const say = args.json ? err : out;

  if (args.mode) {
    const changed = await askServer(env, token, '/inference/mode', args.mode === 'reset' ? { reset: true, by: 'cli' } : { mode: args.mode, by: 'cli' }, deps.fetch);
    if (changed.kind === 'no_token') {
      err(`The mode was not changed: this command has no token for the running server. ${TOKEN_HOW}`);
      return 1;
    }
    if (changed.kind === 'proxied') {
      err(`The mode was not changed: the running server was not asked. ${PROXY_HOW}`);
      return 1;
    }
    if (changed.kind === 'down') {
      err("The mode was not changed: Flint isn't answering on this Mac. Start Flint and run this again.");
      return 1;
    }
    if (refused(changed.status)) {
      err(`The mode was not changed: Flint refused this command's token (${changed.status}). ${TOKEN_HOW}`);
      return 1;
    }
    if (changed.status !== 200) {
      // The server's own sentence when it sent one (a mode that could not be saved), never anything else of the response.
      const why = typeof changed.json.error === 'string' && changed.json.error.length <= 200 ? changed.json.error : `Flint answered ${changed.status}.`;
      err(`The mode was not changed: ${why}`);
      return 1;
    }
    say(`The mode is now ${modeName(changed.json.mode)} (it was ${modeName(changed.json.previous)}).`);
  }

  const live = await askServer(env, token, '/inference', undefined, deps.fetch);
  if (live.kind === 'answer') {
    if (live.status === 200 && Array.isArray(live.json.lines)) {
      out(render(live.json as unknown as InferenceStatus, args));
      return 0;
    }
    if (refused(live.status)) {
      err(`Flint refused this command's token (${live.status}), so its status was not read. ${TOKEN_HOW}`);
      return 1;
    }
    err(`Flint answered ${live.status}, so its status was not read.`);
    return 1;
  }

  // Without the server: detect, read the table, look at the model server. Nothing is written.
  const status = await (deps.offline ?? (() => offlineStatus(env, deps.home)))();
  const why =
    live.kind === 'no_token'
      ? `this command has no token for the running server. ${TOKEN_HOW}`
      : live.kind === 'proxied'
        ? `the running server was not asked. ${PROXY_HOW}`
        : "Flint isn't answering on this Mac.";
  const note = `This shows this shell's settings, not the running server's, and no cloud side: ${why}`;
  if (args.json) {
    out(render(status, args, undefined, 'this_shell'));
    err(note);
  } else {
    out(render(status, args, note));
  }
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  run(process.argv.slice(2), { env: process.env, home: homedir(), out: (l) => console.log(l), err: (l) => console.error(l) }).then(
    (code) => process.exit(code),
    () => {
      // Never the error's own text: it can carry an address or a value from the environment.
      console.error('inference-status: the status could not be read.');
      process.exit(1);
    },
  );
}
