/**
 * What Flint asks a local model server besides "answer this": is it there,
 * does it have the model, is the model in memory, and (when the server can be
 * told to) load it. One small interface, three servers behind it:
 *
 *   server      reachable            installed              loaded                    loading             warm
 *   Ollama      GET /api/version     name in /api/tags      name in /api/ps           (Flint's own warm)  POST /api/generate, no prompt
 *   llama.cpp   GET /health answers  id in /v1/models       /health 200 status ok     /health 503         none (it loads at start)
 *   other       GET /v1/models 200   id in /v1/models       cannot say                cannot say          POST chat/completions, 1 token
 *
 * Every call here goes through `guardedFetch`: only to the configured origin,
 * only to the paths listed, never following a redirect. Probes are GETs (and
 * Ollama's /api/show, a POST that only reads). Nothing here downloads a model:
 * there is no call to /api/pull, and the allowlist has no such path.
 *
 * Nothing is logged from here and nothing throws out of `probe`: the monitor
 * (./local-monitor) turns what it returns into states and log lines, which
 * carry enums and numbers, never a server's own words.
 *
 * Kept free of index.ts so it is unit-testable (index.ts runs main() on import).
 */
import { connect as netConnect } from 'node:net';
import { canonicalModel } from './memory-brain';
import { placeSaid, type PlaceSaid } from './ollama-locality';

export type ServerKind = 'ollama' | 'llamacpp' | 'openai';

/** What one look at the server says about one model. `undefined` means the server cannot say. */
export interface ModelProbe {
  installed?: boolean;
  loaded?: boolean;
  loading?: boolean;
  /** The context window the model is loaded with (Ollama's /api/ps). */
  contextLength?: number;
}

export interface ProbeResult {
  reachable: boolean;
  /** The server's version, digits and dots only (Ollama). */
  version?: string;
  /** Per model asked about, by the name it was asked with. */
  models: Record<string, ModelProbe>;
}

/** What the server says a model can do (Ollama's /api/show). A missing field means it did not say. */
export interface ModelFacts {
  tools?: boolean;
  vision?: boolean;
  thinking?: boolean;
  /** The largest context the model supports (not what it is loaded with). */
  contextLength?: number;
}

export interface LocalBackend {
  readonly kind: ServerKind;
  /** One cheap look. Never throws; an unreachable server is `reachable: false`. */
  probe(models: readonly string[], signal: AbortSignal): Promise<ProbeResult>;
  /** Ask the server to load a model. Resolves once it is loaded; rejects when it cannot be. */
  warm(model: string, opts: { numCtx?: number; signal: AbortSignal }): Promise<void>;
  /** What the server says the model can do; undefined when it cannot say. Never throws. */
  describe(model: string, signal: AbortSignal): Promise<ModelFacts | undefined>;
}

// ---------------------------------------------------------------------------
// the guarded fetch

/** A TCP connect to host:port that resolves when it is accepted and rejects on refusal or after `ms`. */
export function tcpConnect(host: string, port: number, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host, port });
    const done = (err?: Error): void => {
      socket.removeAllListeners();
      socket.destroy();
      if (err) reject(err);
      else resolve();
    };
    socket.setTimeout(ms, () => done(new Error('connect timed out')));
    socket.once('connect', () => done());
    socket.once('error', (e) => done(e));
  });
}

export interface GuardOptions {
  /** The only origin this fetch reaches (`http://127.0.0.1:11434`). */
  origin: string;
  /** The only pathnames it reaches, exactly. */
  paths: readonly string[];
  /**
   * ms for a TCP connect to the server before each POST; undefined (or a
   * function returning undefined) skips the check. A function is read per call,
   * so the check can follow the routing mode without rebuilding the client.
   */
  connectTimeoutMs?: number | (() => number | undefined);
  fetch?: typeof fetch;
  /** Injectable for tests: no real socket. */
  connect?: (host: string, port: number, ms: number) => Promise<void>;
}

/** Why a guarded fetch refused to send a request. Its message names the rule, never the URL. */
export class GuardRefusal extends Error {
  constructor(rule: 'origin' | 'path' | 'method' | 'query') {
    super(`local fetch refused: ${rule} not allowed`);
    this.name = 'GuardRefusal';
  }
}

/**
 * fetch, held to one server: `origin` only, the listed paths only, GET or POST
 * only, no query string, and a redirect is an error rather than followed.
 *
 * Before a POST it first checks the server accepts a TCP connection, within
 * `connectTimeoutMs`. That is the connect deadline: on a streamed call a local
 * server sends its response headers with the first token, so a deadline on
 * "time to headers" would be the first-token deadline under another name. A
 * failed check is thrown as fetch throws a refused connection (a TypeError),
 * which every adapter reads as `provider_unavailable`.
 */
export function guardedFetch(opts: GuardOptions): typeof fetch {
  const base = opts.fetch ?? fetch;
  const connect = opts.connect ?? tcpConnect;
  const origin = new URL(opts.origin);
  const allowed = new Set(opts.paths);
  const port = origin.port ? Number(origin.port) : origin.protocol === 'https:' ? 443 : 80;
  const host = origin.hostname.replace(/^\[|\]$/g, '');
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
    if (u.origin !== origin.origin) throw new GuardRefusal('origin');
    if (u.search || u.hash) throw new GuardRefusal('query');
    if (!allowed.has(u.pathname)) throw new GuardRefusal('path');
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'POST') throw new GuardRefusal('method');
    const ms = typeof opts.connectTimeoutMs === 'function' ? opts.connectTimeoutMs() : opts.connectTimeoutMs;
    if (method === 'POST' && ms !== undefined) {
      try {
        await connect(host, port, ms);
      } catch (cause) {
        throw new TypeError('fetch failed', { cause });
      }
    }
    return base(u.href, { ...init, redirect: 'error' });
  }) as typeof fetch;
}

// ---------------------------------------------------------------------------
// helpers

type Fetch = typeof fetch;

/** GET (or POST `body`) and parse JSON; undefined on any failure. The status comes back too, for /health. */
async function ask(f: Fetch, url: string, signal: AbortSignal, body?: unknown): Promise<{ status: number; json: unknown } | undefined> {
  try {
    const res = await f(url, {
      method: body === undefined ? 'GET' : 'POST',
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      signal,
    });
    const text = await res.text();
    let json: unknown;
    try {
      json = text.length <= MAX_ANSWER ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: res.status, json };
  } catch {
    return undefined;
  }
}

/** The largest answer a probe reads (a long /api/tags is a few hundred KB). */
const MAX_ANSWER = 8 * 1024 * 1024;

const rows = (json: unknown, key: 'models' | 'data'): Array<Record<string, unknown>> => {
  const list = (json as Record<string, unknown> | null | undefined)?.[key];
  return Array.isArray(list) ? list.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object') : [];
};

const positiveInt = (n: unknown): number | undefined => (typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : undefined);

/** Are these the same model, as Ollama names them (case, and `:latest` when no tag is given)? */
function same(a: string, b: string): boolean {
  return canonicalModel(a) === canonicalModel(b);
}

// ---------------------------------------------------------------------------
// Ollama

/** The paths the Ollama backend and the native adapter use. No /api/pull: Flint never downloads a model. */
export const OLLAMA_PATHS = ['/api/version', '/api/tags', '/api/ps', '/api/show', '/api/generate', '/api/chat'] as const;

/**
 * `onListing`: told every model listing the server gives (the rows of its
 * /api/tags, as they came), each time one is read. The listing is where an
 * Ollama says whether a model really runs on it (a `remote_host` on the row
 * means it does not), and ./ollama-locality keeps that for ./policy.
 *
 * `onSilent`: told every look that came back WITHOUT a listing: the server
 * did not answer at all, or it answered and its listing failed (a 500, a
 * hang, anything that is no listing). A turn that stays here waits for this
 * look before it is routed, so a look with no listing in it must not leave
 * the last one standing: a name could have been pointed at a cloud model
 * behind the silence (./ollama-locality silent).
 */
export function ollamaBackend(origin: string, f: Fetch, onListing?: (rows: ReadonlyArray<Record<string, unknown>>) => void, onSilent?: () => void): LocalBackend {
  const at = (path: string): string => `${origin}${path}`;
  const tell = (what: (() => void) | undefined): void => {
    try {
      what?.();
    } catch {
      /* whoever keeps the listing has its own trouble: a look at the server never fails for it */
    }
  };
  return {
    kind: 'ollama',
    async probe(models, signal) {
      const version = await ask(f, at('/api/version'), signal);
      const v = (version?.json as { version?: unknown } | undefined)?.version;
      if (!version || version.status !== 200 || typeof v !== 'string') {
        tell(onSilent);
        return { reachable: false, models: {} };
      }
      const [tags, ps] = await Promise.all([ask(f, at('/api/tags'), signal), ask(f, at('/api/ps'), signal)]);
      const installed = tags?.status === 200 ? rows(tags.json, 'models') : undefined;
      const loaded = ps?.status === 200 ? rows(ps.json, 'models') : undefined;
      tell(installed ? () => onListing?.(installed) : onSilent);
      const out: Record<string, ModelProbe> = {};
      for (const m of models) {
        const named = (r: Record<string, unknown>): boolean => typeof r.name === 'string' && same(r.name, m);
        const row = loaded?.find(named);
        const ctx = positiveInt(row?.context_length);
        out[m] = {
          ...(installed ? { installed: installed.some(named) } : {}),
          ...(loaded ? { loaded: row !== undefined } : {}),
          ...(ctx !== undefined ? { contextLength: ctx } : {}),
        };
      }
      return { reachable: true, version: v.replace(/[^0-9.]/g, '').slice(0, 20), models: out };
    },
    async warm(model, opts) {
      // No prompt: Ollama loads the model and answers `done_reason: "load"`. The same num_ctx
      // chat sends, or Ollama would load the model a second time for the first real turn.
      const res = await f(at('/api/generate'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, stream: false, ...(opts.numCtx !== undefined ? { options: { num_ctx: opts.numCtx } } : {}) }),
        signal: opts.signal,
      });
      await res.body?.cancel().catch(() => {});
      if (!res.ok) throw new WarmFailed(res.status);
    },
    async describe(model, signal) {
      const shown = await ask(f, at('/api/show'), signal, { model });
      if (!shown || shown.status !== 200 || !shown.json || typeof shown.json !== 'object') return undefined;
      const body = shown.json as { capabilities?: unknown; model_info?: unknown };
      const caps = Array.isArray(body.capabilities) ? body.capabilities.filter((c): c is string => typeof c === 'string') : undefined;
      const info = body.model_info && typeof body.model_info === 'object' ? (body.model_info as Record<string, unknown>) : {};
      const ctxKey = Object.keys(info).find((k) => k.endsWith('.context_length'));
      const ctx = ctxKey ? positiveInt(info[ctxKey]) : undefined;
      return {
        // An Ollama too old to list capabilities says nothing about tools: left undefined, not false.
        ...(caps ? { tools: caps.includes('tools'), vision: caps.includes('vision'), thinking: caps.includes('thinking') } : {}),
        ...(ctx !== undefined ? { contextLength: ctx } : {}),
      };
    },
  };
}

/** A load the server refused. Only the status: its body is the server's own words. */
export class WarmFailed extends Error {
  constructor(readonly status: number) {
    super(`warm-up answered ${status}`);
    this.name = 'WarmFailed';
  }
}

// ---------------------------------------------------------------------------
// which server is it, as far as "does this model run here" goes

/** The one path every local server is asked, whatever kind it was taken for: the listing only an Ollama gives. */
export const PLACE_PATH = '/api/tags';

/**
 * Ask a server whether it is an Ollama, the only way that is sure: ask for the
 * model listing an Ollama gives (./ollama-locality placeSaid reads the answer:
 * a listing, "no such thing here", or nothing either way). Never throws;
 * undefined when the server did not say. `headers`: the key the server's other
 * requests carry, so one that wants it on every path still answers.
 */
export async function askPlace(f: Fetch, origin: string, signal: AbortSignal, headers: Record<string, string> = {}): Promise<PlaceSaid | undefined> {
  try {
    const res = await f(`${origin}${PLACE_PATH}`, { headers, signal });
    if (res.status < 200 || res.status >= 300) {
      await res.body?.cancel().catch(() => {});
      return await placeSaid(res.status, async () => undefined);
    }
    const text = await res.text();
    // An answer too long to read says nothing either way: it is never taken as "no Ollama here".
    if (text.length > MAX_ANSWER) return undefined;
    return await placeSaid(res.status, async () => JSON.parse(text) as unknown);
  } catch {
    return undefined;
  }
}

/**
 * A backend whose every look ALSO asks the server what it is, and tells
 * `told`. A server on the OpenAI-compatible wire is taken for llama.cpp or a
 * plain OpenAI-compatible server by what answered at boot, or by what
 * FLINT_LOCAL_SERVER says; either can be wrong, and an Ollama behind that wire
 * serves cloud models under plain names like any other. So the question is
 * asked of every kind, at every look, and ./policy takes nothing on that wire
 * for local until the server has answered it. A look in which it did NOT
 * answer the question tells `silent`: what it said before does not stand
 * through a look that came back without it (./ollama-locality silent).
 */
export function withPlace(backend: LocalBackend, look: (signal: AbortSignal) => Promise<PlaceSaid | undefined>, told: (said: PlaceSaid) => void, silent?: () => void): LocalBackend {
  return {
    kind: backend.kind,
    async probe(models, signal) {
      const [out, said] = await Promise.all([backend.probe(models, signal), look(signal)]);
      try {
        if (said) told(said);
        else silent?.();
      } catch {
        /* whoever keeps the answer has its own trouble: a look at the server never fails for it */
      }
      return out;
    },
    warm: (model, opts) => backend.warm(model, opts),
    describe: (model, signal) => backend.describe(model, signal),
  };
}

// ---------------------------------------------------------------------------
// llama.cpp (llama-server)

export function llamaCppPaths(basePath: string): string[] {
  return ['/health', '/props', `${basePath}/models`, `${basePath}/chat/completions`];
}

export function llamaCppBackend(origin: string, basePath: string, f: Fetch): LocalBackend {
  return {
    kind: 'llamacpp',
    async probe(models, signal) {
      const health = await ask(f, `${origin}/health`, signal);
      if (!health) return { reachable: false, models: {} };
      const ready = health.status === 200;
      const loading = health.status === 503;
      const listed = ready ? await ask(f, `${origin}${basePath}/models`, signal) : undefined;
      const ids = listed?.status === 200 ? rows(listed.json, 'data').map((r) => r.id).filter((id): id is string => typeof id === 'string') : undefined;
      const out: Record<string, ModelProbe> = {};
      for (const m of models) {
        // llama-server holds one model and answers with it whatever name a request carries.
        const installed = ids ? ids.includes(m) || ids.length === 1 : loading ? true : undefined;
        out[m] = { ...(installed !== undefined ? { installed } : {}), loaded: ready && installed === true, loading };
      }
      return { reachable: true, models: out };
    },
    async warm() {
      // It loads its model when it starts; there is nothing to ask for.
    },
    async describe(_model, signal) {
      const props = await ask(f, `${origin}/props`, signal);
      const settings = (props?.json as { default_generation_settings?: { n_ctx?: unknown } } | undefined)?.default_generation_settings;
      const ctx = props?.status === 200 ? positiveInt(settings?.n_ctx) : undefined;
      // Whether tools work depends on how the server was started (its chat template): it does not say.
      return ctx !== undefined ? { contextLength: ctx } : undefined;
    },
  };
}

// ---------------------------------------------------------------------------
// any other OpenAI-compatible server

export function openAiPaths(basePath: string): string[] {
  return [`${basePath}/models`, `${basePath}/chat/completions`];
}

export function openAiBackend(origin: string, basePath: string, f: Fetch, apiKey?: string): LocalBackend {
  const auth: Record<string, string> = apiKey ? { authorization: `Bearer ${apiKey}` } : {};
  return {
    kind: 'openai',
    async probe(models, signal) {
      let listed: { status: number; json: unknown } | undefined;
      try {
        const res = await f(`${origin}${basePath}/models`, { headers: auth, signal });
        const text = await res.text();
        listed = { status: res.status, json: text.length <= MAX_ANSWER ? (JSON.parse(text) as unknown) : undefined };
      } catch {
        listed = undefined;
      }
      if (!listed || listed.status !== 200) return { reachable: false, models: {} };
      const ids = rows(listed.json, 'data').map((r) => r.id).filter((id): id is string => typeof id === 'string');
      const out: Record<string, ModelProbe> = {};
      // Whether a model is in memory is not something this API says.
      for (const m of models) out[m] = { installed: ids.includes(m) };
      return { reachable: true, models: out };
    },
    async warm(model, opts) {
      const res = await f(`${origin}${basePath}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...auth },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }),
        signal: opts.signal,
      });
      await res.body?.cancel().catch(() => {});
      if (!res.ok) throw new WarmFailed(res.status);
    },
    async describe() {
      return undefined;
    },
  };
}

// ---------------------------------------------------------------------------
// which server is this?

/** The paths `detectServer` looks at; a guarded fetch built for detection lists these. */
export const DETECT_PATHS = ['/api/version', '/health'] as const;

/**
 * Ask the server what it is, once at boot (FLINT_LOCAL_SERVER=auto): Ollama
 * answers /api/version with its version; llama-server answers /health; anything
 * else is treated as a plain OpenAI-compatible server. A server that is down
 * answers neither, so `fallback` (what the wire implies) is used.
 */
export async function detectServer(origin: string, f: Fetch, signal: AbortSignal, fallback: ServerKind): Promise<ServerKind> {
  const version = await ask(f, `${origin}/api/version`, signal);
  if (version?.status === 200 && typeof (version.json as { version?: unknown } | undefined)?.version === 'string') return 'ollama';
  const health = await ask(f, `${origin}/health`, signal);
  if (health && (health.status === 200 || health.status === 503) && health.json && typeof health.json === 'object') return 'llamacpp';
  return version || health ? 'openai' : fallback;
}
