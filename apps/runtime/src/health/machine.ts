/**
 * What Health reads from the Mac itself (P7): how much room is left, whether
 * Will's phone and MacBook can reach Flint, and which local models are there.
 * Read once for each health run (`readMachine`), and nothing here changes
 * anything: no file is written, no setting touched, no program started but one.
 *
 *  - Free space: the volume the home folder is on (fs.statfs).
 *  - Remote access: Flint's own Tailscale daemon is asked for its status and
 *    for what it serves. The `tailscale` program is run by its full path, from
 *    a fixed list, with fixed arguments and a five-second limit. What it prints
 *    is parsed against a schema: a reply that is missing, cut short or not the
 *    shape expected is "unknown", never "ok". Nothing it prints is passed on:
 *    only a state, a reason from a fixed list, and the date the sign-in runs
 *    out. It is asked over its socket on this Mac, and no network call is made.
 *  - Models: Ollama's own two lists (what is installed, what is loaded), on
 *    this Mac's own address only, through the runtime's one reader of them
 *    (model/here.ts: the scoped fetch, those two paths and nothing else), so
 *    what Health sees is what every local call goes by. Asking costs nothing
 *    and loads no model.
 *
 * Each check is a sentence built here from numbers and fixed words: never a
 * path, a host's name, or anything a program said.
 */
// Network: None of its own: Ollama's two lists are read through model/here.ts, on this Mac only.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { canonicalModel, listedModels } from '@flint/policy';
import { LOCAL_MODELS, type ListPath, type LocalModels as ModelReader } from '../model/here.js';
import type { ComponentCheck } from './checks.js';

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ---------------------------------------------------------------------------
// Free space

/** Under this much free, the Mac is low on space (degraded). Decimal, as the Mac itself counts a gigabyte. */
export const DISK_LOW_BYTES = 20e9;
/** Under this much, it is nearly full (down, and one critical note): the database stops when the disk fills. */
export const DISK_FULL_BYTES = 5e9;

/** Free space on the volume `dir` is on, in bytes; undefined when it cannot be read. */
export async function freeBytes(dir: string, stat: (path: string) => Promise<{ bavail: number | bigint; bsize: number | bigint }> = statfs): Promise<number | undefined> {
  try {
    const s = await stat(dir);
    const free = Number(s.bavail) * Number(s.bsize);
    return Number.isFinite(free) && free >= 0 ? free : undefined;
  } catch {
    return undefined;
  }
}

/** "212 GB", "less than 1 GB": whole gigabytes, rounded down (never more than there is). */
export const gigabytes = (bytes: number): string => (bytes < 1e9 ? 'less than 1 GB' : `${Math.floor(bytes / 1e9)} GB`);

export function diskCheck(free: number | undefined): ComponentCheck {
  const component = 'disk';
  if (free === undefined) return { component, status: 'unknown', detail: 'Flint couldn’t read how much space is free.' };
  if (free < DISK_FULL_BYTES) return { component, status: 'down', detail: `This Mac is nearly full, with ${gigabytes(free)} free.` };
  if (free < DISK_LOW_BYTES) return { component, status: 'degraded', detail: `This Mac is low on space, with ${gigabytes(free)} free.` };
  return { component, status: 'ok', detail: `This Mac has ${gigabytes(free)} free.` };
}

// ---------------------------------------------------------------------------
// Remote access

/** Where Homebrew puts the tailscale program. The first that is there is run; nothing is looked up on the PATH. */
export const TAILSCALE_BINS = ['/opt/homebrew/bin/tailscale', '/opt/homebrew/opt/tailscale/bin/tailscale', '/usr/local/bin/tailscale'] as const;
export const TAILSCALE_TIMEOUT_MS = 5_000;
/** The port Flint's server listens on, which remote access must point at (apps/studio/finish-tailscale.sh). */
export const SERVED_PORT = '8080';
/** A sign-in that runs out within this many days is said ahead of time. */
export const EXPIRY_WARN_DAYS = 14;

export type Run = (bin: string, args: readonly string[]) => Promise<string>;

/**
 * Run one program with fixed arguments and a hard limit: no shell, no PATH
 * lookup, an environment of its own, killed outright at the limit. What it
 * printed is returned when it ran to its end, whatever it exited with (the
 * caller's schema decides what a reply is worth).
 */
export const runFixed = (bin: string, args: readonly string[], timeoutMs: number = TAILSCALE_TIMEOUT_MS): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(bin, [...args], { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024, env: { PATH: '/usr/bin:/bin' }, windowsHide: true }, (err, stdout) => {
      const out = String(stdout ?? '');
      const e = err as (Error & { killed?: boolean; code?: unknown }) | null;
      if (e && (e.killed || typeof e.code !== 'number' || !out.trim())) reject(e);
      else resolve(out);
    });
  });

/** `tailscale status --json`, as far as it is read: the rest of what it prints is ignored. */
const TailscaleStatus = z.object({
  BackendState: z.string().min(1).max(40),
  Self: z.object({
    Online: z.boolean().optional(),
    Expired: z.boolean().optional(),
    KeyExpiry: z.string().datetime({ offset: true }).optional(),
  }).passthrough(),
}).passthrough();

/** `tailscale serve status --json`: which addresses are served, and where each is sent. Nothing served is `{}`. */
const TailscaleServe = z.object({
  Web: z.record(z.object({
    Handlers: z.record(z.object({ Proxy: z.string().max(300).optional() }).passthrough()).optional(),
  }).passthrough()).optional(),
}).passthrough();

export type RemoteWhy = 'not_running' | 'signed_out' | 'offline' | 'not_served';
export type RemoteAccess =
  | { state: 'off' }
  | { state: 'unknown' }
  | { state: 'down'; why: RemoteWhy }
  | { state: 'ok'; expiresAt?: Date };

/** Does this proxy address send to Flint's server on this Mac? */
function servesFlint(proxy: string | undefined): boolean {
  if (!proxy) return false;
  try {
    const u = new URL(proxy);
    return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) && u.port === SERVED_PORT;
  } catch {
    return false;
  }
}

/**
 * Can Will's phone and MacBook reach Flint, as far as this Mac can tell?
 *  - off: remote access was never set up here (there is no address file).
 *  - down: the daemon's socket is not there, it is stopped, it needs a sign-in
 *    (or its key has run out), it is not connected, or it serves nothing that
 *    points at Flint.
 *  - unknown: it could not be asked, or what it said was not a status.
 *  - ok: running, connected, serving Flint; with the date its sign-in runs out,
 *    when it has one.
 */
export async function remoteAccess(home: string, now: Date, deps: { run?: Run; exists?: (path: string) => boolean } = {}): Promise<RemoteAccess> {
  const exists = deps.exists ?? existsSync;
  const run = deps.run ?? runFixed;
  const data = join(home, '.flint');
  if (!exists(join(data, 'tailscale-url.txt'))) return { state: 'off' };
  const socket = join(data, 'tailscaled.sock');
  if (!exists(socket)) return { state: 'down', why: 'not_running' };
  const bin = TAILSCALE_BINS.find((b) => exists(b));
  if (!bin) return { state: 'unknown' };
  const ask = async <T>(schema: z.ZodType<T>, args: readonly string[]): Promise<T | undefined> => {
    try {
      const said = schema.safeParse(JSON.parse(await run(bin, ['--socket', socket, ...args])));
      return said.success ? said.data : undefined;
    } catch {
      return undefined;
    }
  };
  const status = await ask(TailscaleStatus, ['status', '--json']);
  if (!status) return { state: 'unknown' };
  if (status.BackendState === 'Stopped') return { state: 'down', why: 'not_running' };
  if (status.BackendState === 'NeedsLogin' || status.BackendState === 'NeedsMachineAuth') return { state: 'down', why: 'signed_out' };
  if (status.BackendState !== 'Running') return { state: 'unknown' };
  const expiresAt = status.Self.KeyExpiry ? new Date(status.Self.KeyExpiry) : undefined;
  if (status.Self.Expired === true || (expiresAt && expiresAt.getTime() <= now.getTime())) return { state: 'down', why: 'signed_out' };
  if (status.Self.Online === false) return { state: 'down', why: 'offline' };
  const serve = await ask(TailscaleServe, ['serve', 'status', '--json']);
  if (!serve) return { state: 'unknown' };
  const pointsAtFlint = Object.values(serve.Web ?? {}).some((site) => Object.values(site.Handlers ?? {}).some((h) => servesFlint(h.Proxy)));
  if (!pointsAtFlint) return { state: 'down', why: 'not_served' };
  return { state: 'ok', ...(expiresAt ? { expiresAt } : {}) };
}

/** Whole days until `at` (0: it runs out today). */
export const daysUntil = (at: Date, now: Date): number => Math.max(0, Math.floor((at.getTime() - now.getTime()) / 86_400_000));

/** What Remote Access says in Settings > Health. */
export const REMOTE_HEALTH = {
  ok: 'Your phone and MacBook can reach Flint.',
  expiring: (days: number) => (days === 0 ? 'Remote access needs a new sign-in today.' : `Remote access needs a new sign-in in ${count(days, 'day')}.`),
  unknown: 'Flint couldn’t read whether remote access is working.',
  down: {
    not_running: 'Remote access isn’t running, so your phone and MacBook can’t reach Flint.',
    signed_out: 'Remote access needs a new sign-in, so your phone and MacBook can’t reach Flint.',
    offline: 'This Mac is offline, so your phone and MacBook can’t reach Flint.',
    not_served: 'Remote access is on, but it doesn’t point at Flint, so your phone and MacBook can’t reach it.',
  } satisfies Record<RemoteWhy, string>,
} as const;

export function remoteAccessCheck(r: RemoteAccess, now: Date): ComponentCheck {
  const component = 'remote_access';
  if (r.state === 'off') return { component, status: 'disabled' };
  if (r.state === 'unknown') return { component, status: 'unknown', detail: REMOTE_HEALTH.unknown };
  if (r.state === 'down') return { component, status: 'down', detail: REMOTE_HEALTH.down[r.why] };
  const days = r.expiresAt ? daysUntil(r.expiresAt, now) : undefined;
  if (days !== undefined && days <= EXPIRY_WARN_DAYS) return { component, status: 'degraded', detail: REMOTE_HEALTH.expiring(days) };
  return { component, status: 'ok', detail: REMOTE_HEALTH.ok };
}

// ---------------------------------------------------------------------------
// Local models

/** A list Health takes: every row names its model. One that does not is no list at all, never half of one. */
const ModelRows = z.array(z.object({ name: z.string().min(1).max(200) }).passthrough()).max(5000);

export interface LocalModels {
  installed: ReadonlySet<string>;
  loaded: ReadonlySet<string>;
  /**
   * Listed, and Ollama itself says it runs somewhere else: its row names a
   * remote host or a remote model. A name proves nothing either way (a cloud
   * model can be copied to a plain name), so only the listing is believed.
   */
  elsewhere: ReadonlySet<string>;
}

/** A model's name as Ollama lists it: lower case, and one with no tag is its `latest` (@flint/policy's rule, the one every local call goes by). */
export const modelName = canonicalModel;

/**
 * What Ollama has installed and what it has loaded right now. Undefined when
 * it cannot be asked or its answer is not a list. Only an address on this Mac
 * is ever asked, and only for these two lists.
 */
export async function localModels(at: string | { url: string; proxied?: boolean }, base: typeof fetch = fetch, reader: ModelReader = LOCAL_MODELS): Promise<LocalModels | undefined> {
  const ollama = typeof at === 'string' ? { url: at } : at;
  try {
    // The runtime's Ollama is plain http on this Mac (config.ts): anything else is not asked.
    if (new URL(ollama.url).protocol !== 'http:') return undefined;
  } catch {
    return undefined;
  }
  const rows = async (path: ListPath): Promise<Array<{ name: string; remote: boolean }> | undefined> => {
    const said = ModelRows.safeParse(await reader.list(ollama, path, base));
    if (!said.success) return undefined;
    // Anything at all said of a remote host or a remote model is Ollama saying the model is not run here, and a
    // model listed twice, once as run elsewhere, is run elsewhere (listedModels: the rule every local call goes by).
    return listedModels(said.data).map((m) => ({ name: modelName(m.name), remote: !m.here }));
  };
  const installed = await rows('/api/tags');
  const loaded = await rows('/api/ps');
  if (!installed || !loaded) return undefined;
  return {
    installed: new Set(installed.map((m) => m.name)),
    loaded: new Set(loaded.map((m) => m.name)),
    elsewhere: new Set(installed.filter((m) => m.remote).map((m) => m.name)),
  };
}

/** What Local Model and Standby Model say in Settings > Health. */
export const MODEL_HEALTH = {
  unread: 'Flint couldn’t check which models are installed.',
  missing: 'The local model isn’t installed.',
  elsewhere: 'The local model isn’t on this Mac.',
  loaded: 'The local model is loaded.',
  installed: 'The local model is installed, and loads when it’s needed.',
  standbyReady: 'The standby model is ready.',
  standbyMissing: 'The standby model isn’t installed.',
  standbyElsewhere: 'The standby model isn’t on this Mac.',
} as const;

/**
 * The local model, beyond "Ollama answers": is the model Flint asks installed?
 * `endpoint` is what the health source saw of Ollama itself. Only when that is
 * ok is anything added: a model that is not installed is down (nothing local
 * can answer), and a list that could not be read is unknown, never ok.
 */
export function localModelCheck(endpoint: ComponentCheck, model: string | undefined, models: LocalModels | undefined): ComponentCheck {
  if (endpoint.status !== 'ok' || !model) return endpoint;
  if (!models) return { component: endpoint.component, status: 'unknown', detail: MODEL_HEALTH.unread };
  const name = modelName(model);
  // Listed, and run on someone else's servers: nothing on this Mac answers for it, so it is not a local model at all.
  if (models.elsewhere.has(name)) return { component: endpoint.component, status: 'down', detail: MODEL_HEALTH.elsewhere };
  if (!models.installed.has(name)) return { component: endpoint.component, status: 'down', detail: MODEL_HEALTH.missing };
  return { component: endpoint.component, status: 'ok', detail: models.loaded.has(name) ? MODEL_HEALTH.loaded : MODEL_HEALTH.installed };
}

/** The server's own word for "no standby model". */
export const noStandby = (model: string | undefined): boolean => model !== undefined && /^(off|none)$/i.test(model);

/**
 * The standby model (the one that answers while the main model loads), as
 * far as the runtime is told. Named: whether it is installed, and on this Mac.
 * Named "off": off.
 * Not named at all: no line, because the server then picks a standby for this
 * Mac by itself and the runtime does not know which.
 */
export function standbyModelCheck(model: string | undefined, models: LocalModels | undefined): ComponentCheck | undefined {
  const component = 'standby_model';
  if (model === undefined) return undefined;
  if (noStandby(model)) return { component, status: 'disabled' };
  if (!models) return { component, status: 'unknown', detail: MODEL_HEALTH.unread };
  const name = modelName(model);
  if (models.elsewhere.has(name)) return { component, status: 'degraded', detail: MODEL_HEALTH.standbyElsewhere };
  return models.installed.has(name) ? { component, status: 'ok', detail: MODEL_HEALTH.standbyReady } : { component, status: 'degraded', detail: MODEL_HEALTH.standbyMissing };
}

// ---------------------------------------------------------------------------
// One reading for each health run

export interface MachineReading {
  /** Free space on the home folder's volume; undefined when it could not be read. */
  freeBytes?: number;
  remote: RemoteAccess;
  /** Ollama's lists; undefined when no local model is named, or they could not be read. */
  models?: LocalModels;
}

export interface MachineDeps {
  stat?: Parameters<typeof freeBytes>[1];
  run?: Run;
  exists?: (path: string) => boolean;
  fetch?: typeof fetch;
}

/** Everything above, read once. Each part fails on its own: one that cannot be read leaves the others as they are. */
export async function readMachine(config: { home: string; ollama?: { url: string; proxied?: boolean } }, now: Date, deps: MachineDeps = {}): Promise<MachineReading> {
  const [free, remote, models] = await Promise.all([
    freeBytes(config.home, deps.stat),
    remoteAccess(config.home, now, { ...(deps.run ? { run: deps.run } : {}), ...(deps.exists ? { exists: deps.exists } : {}) }).catch((): RemoteAccess => ({ state: 'unknown' })),
    config.ollama ? localModels(config.ollama, deps.fetch).catch(() => undefined) : Promise.resolve(undefined),
  ]);
  return { ...(free !== undefined ? { freeBytes: free } : {}), remote, ...(models ? { models } : {}) };
}
