/**
 * The model that learns from Will's chats (./memory-extract), chosen by
 * FLINT_MEMORY_BRAIN:
 *  - unset or `local` (the default): the local Ollama model, the chat brain's
 *    own (OLLAMA_MODEL) unless FLINT_MEMORY_MODEL names another. No outside AI
 *    and no API key: with no Anthropic key at all, extraction still runs. An
 *    Ollama cloud model (`…-cloud`, `:cloud`) runs on Ollama's servers, not
 *    this Mac, so it is never used.
 *  - `frontier`: the primary frontier tier, bare, metered as `extract` and
 *    paused with the other background work at 80% of its vendor's cap. Only
 *    when Will sets it, and never a fallback either way: a local model that is
 *    down is not replaced by the frontier, nor a missing frontier by the local
 *    model.
 *  - `off`: no extraction.
 * Any other value is logged and read as `local`.
 *
 * The local client mirrors the runtime's triage judge (apps/runtime/src/triage/judge.ts):
 *  - OllamaProvider with the reply held to FACTS_SCHEMA (`format`) and checked
 *    again with factsReply; `think` off and temperature 0;
 *  - the num_ctx the chat brain sends (liveOllamaOptions), so Ollama never
 *    reloads the model to switch between Will's chat and a pass; a model of its
 *    own (FLINT_MEMORY_MODEL) is unloaded after each request instead
 *    (keep_alive 0), so it never holds memory the chat model needs;
 *  - one request a call (at temperature 0 a second would replay the first),
 *    only to /api/chat on the configured host, after checking that Will isn't
 *    chatting;
 *  - a request already running is cut off the moment a chat turn starts, so
 *    his turn never waits behind it;
 *  - failing, it says why (MemoryBrainError, see BrainFailure).
 */
import { OllamaProvider, isFlintError } from '@flint/core';
import type { ChatLoad } from './chat-load';
import { LOCAL_MODEL_MAX_LEN, LOCAL_MODEL_RE, liveOllamaOptions } from './local-model';
import { FACTS_SCHEMA, MemoryBrainError, factsReply, type BrainFailure, type ExtractBrain, type FactEntry } from './memory-extract';

type Env = Record<string, string | undefined>;

export type MemoryBrainSetting = 'local' | 'frontier' | 'off';

export function memoryBrainSetting(env: Env, log: (m: string) => void): MemoryBrainSetting {
  const raw = env.FLINT_MEMORY_BRAIN?.trim().toLowerCase();
  if (!raw || raw === 'local') return 'local';
  if (raw === 'frontier' || raw === 'off') return raw;
  log(`[memory-extract] FLINT_MEMORY_BRAIN must be local, frontier or off; ignoring ${JSON.stringify(raw.slice(0, 40))} (local)`);
  return 'local';
}

/**
 * Is this one of Ollama's cloud models (`gpt-oss:120b-cloud`, `glm-4.6:cloud`)?
 * Those run on Ollama's servers: a pull is only a pointer to them.
 */
export function isCloudModel(name: string): boolean {
  const n = name.trim().toLowerCase();
  const colon = n.lastIndexOf(':');
  const base = colon === -1 ? n : n.slice(0, colon);
  const tag = colon === -1 ? '' : n.slice(colon + 1);
  return /(^|-)cloud$/.test(tag) || /-cloud$/.test(base);
}

export interface LocalMemoryModel {
  /** Ollama's origin: OLLAMA_HOST, as the chat brain reads it. */
  baseURL: string;
  model: string;
  /** Exactly what the chat brain sends as num_ctx (liveOllamaOptions), sent as is. */
  numCtx: number | undefined;
  /** A model of its own, not the chat brain's (sameModel): unloaded after each request (keep_alive 0). */
  unloadAfter: boolean;
}

/**
 * The local model a pass asks, from the chat brain's own settings: OLLAMA_HOST,
 * OLLAMA_NUM_CTX, and FLINT_MEMORY_MODEL or else OLLAMA_MODEL. Undefined when
 * there is none on this Mac to ask (the reason is logged).
 */
export function localMemoryModel(env: Env, log: (m: string) => void): LocalMemoryModel | undefined {
  const valid = (m: string) => m.length <= LOCAL_MODEL_MAX_LEN && LOCAL_MODEL_RE.test(m);
  const chat = env.OLLAMA_MODEL?.trim() || undefined;
  if (chat && isCloudModel(chat)) {
    log('[memory-extract] warning: OLLAMA_MODEL is an Ollama cloud model, so the chat brain runs off this Mac; extraction never uses it');
  }
  let own = env.FLINT_MEMORY_MODEL?.trim() || undefined;
  if (own && !valid(own)) {
    log('[memory-extract] FLINT_MEMORY_MODEL is not an Ollama model name; ignoring it');
    own = undefined;
  } else if (own && isCloudModel(own)) {
    log('[memory-extract] FLINT_MEMORY_MODEL is an Ollama cloud model, which runs off this Mac; ignoring it');
    own = undefined;
  }
  const model = own ?? chat;
  if (!model || isCloudModel(model)) return undefined;
  if (!valid(model)) {
    log('[memory-extract] OLLAMA_MODEL is not an Ollama model name');
    return undefined;
  }
  const live = liveOllamaOptions(env);
  let baseURL: string;
  try {
    const u = new URL(live.baseURL ?? '');
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('not http');
    baseURL = u.origin;
  } catch {
    log('[memory-extract] OLLAMA_HOST is not an http(s) URL');
    return undefined;
  }
  const n = live.defaultOptions?.num_ctx;
  return { baseURL, model, numCtx: typeof n === 'number' ? n : undefined, unloadAfter: chat === undefined || !sameModel(model, chat) };
}

/**
 * Ollama's name for a model: lower case, and `:latest` when no tag is given
 * ("Llama3.1" and "llama3.1:latest" are the same model). A tag is what follows
 * the last ':' after the last '/', so a registry port isn't one.
 */
export function canonicalModel(name: string): string {
  const n = name.trim().toLowerCase();
  return n.lastIndexOf(':') > n.lastIndexOf('/') ? n : `${n}:latest`;
}

/** Are these the same Ollama model, however each is written? */
export function sameModel(a: string, b: string): boolean {
  return canonicalModel(a) === canonicalModel(b);
}

export type MemoryBrainPlan =
  | { kind: 'local'; model: LocalMemoryModel; brain: ExtractBrain }
  | { kind: 'frontier'; brain: ExtractBrain }
  | { kind: 'none'; why: string };

/**
 * Which brain extraction runs on, from FLINT_MEMORY_BRAIN. `frontier` is the
 * bare frontier client main() built (frontierExtractBrain), or undefined when
 * none is configured; it is used only when Will asked for it.
 */
export function chooseMemoryBrain(
  env: Env,
  deps: { frontier: ExtractBrain | undefined; chatActive?: () => boolean; log: (m: string) => void; fetch?: typeof fetch },
): MemoryBrainPlan {
  const setting = memoryBrainSetting(env, deps.log);
  if (setting === 'off') return { kind: 'none', why: 'FLINT_MEMORY_BRAIN=off' };
  if (setting === 'frontier') {
    return deps.frontier
      ? { kind: 'frontier', brain: deps.frontier }
      : { kind: 'none', why: 'FLINT_MEMORY_BRAIN=frontier, but no frontier is configured (the local model does not stand in)' };
  }
  const model = localMemoryModel(env, deps.log);
  if (!model) return { kind: 'none', why: 'no local model on this Mac (set OLLAMA_MODEL, or FLINT_MEMORY_MODEL)' };
  return {
    kind: 'local',
    model,
    brain: localExtractBrain(model, { ...(deps.chatActive ? { chatActive: deps.chatActive } : {}), ...(deps.fetch ? { fetch: deps.fetch } : {}) }),
  };
}

/**
 * The frontier as an ExtractBrain (FLINT_MEMORY_BRAIN=frontier): its text is
 * parsed by the extractor, and a reply cut off at its token limit says so, so
 * the batch is asked again at half its turns. A 4xx other than 404 and 429 is
 * the request's own fault (too long, malformed), so it is a server-error, a
 * strike against the batch, not an outage to wait out forever; anything else
 * it throws is `unavailable`.
 */
export function frontierExtractBrain(
  generate: (input: { system: string; prompt: string }) => Promise<{ text: string; reason?: string }>,
): ExtractBrain {
  return {
    generate: async (input) => {
      let out: { text: string; reason?: string };
      try {
        out = await generate(input);
      } catch (err) {
        const status = isFlintError(err) ? Number(err.error.providerCode) : NaN;
        if (Number.isInteger(status) && status >= 400 && status < 500 && answered(status) === 'server-error') {
          throw new MemoryBrainError('server-error', failureDetail(err));
        }
        throw err;
      }
      if (out.reason === 'max_tokens') throw new MemoryBrainError('truncated');
      return { text: out.text };
    },
  };
}

/** How long the local model stays Will's after a chat turn ends: his next message usually comes within it. */
export const MEMORY_CHAT_QUIET_MS = 2 * 60 * 1000;

/** "Is Will chatting?" for the extractor and the local brain: a /chat turn running, or one that ended under `quietMs` ago. */
export function liveChat(load: Pick<ChatLoad, 'busy'>, quietMs = MEMORY_CHAT_QUIET_MS): () => boolean {
  return () => load.busy(quietMs);
}

/** One request a call: at temperature 0 a second would replay the first. */
export const MEMORY_MODEL_REQUESTS = 1;
/** A whole call: a cold model load plus a long reply fits easily. */
export const MEMORY_CALL_TIMEOUT_MS = 5 * 60 * 1000;
/** How often a running request checks whether Will started a chat turn. */
const CHAT_POLL_MS = 500;
/** Ollama's own window, for sizing a call when the chat brain sends no usable num_ctx. */
const DEFAULT_NUM_CTX = 4096;
/** Prompt characters per token, on the low side: transcripts carry names, numbers and ids. */
const CHARS_PER_TOKEN = 3.5;

/** A reply's token budget: a quarter of the window, from 512 to 2,048 tokens (roughly 10 to 40 facts with their quotes). */
export function replyTokens(numCtx: number): number {
  return Math.min(2048, Math.max(512, Math.floor(numCtx / 4)));
}

export interface LocalBrainDeps {
  /** Is Will chatting? Checked before the request, and every pollMs while it runs. */
  chatActive?: () => boolean;
  fetch?: typeof fetch;
  timeoutMs?: number;
  pollMs?: number;
}

class Stop extends Error {}

/**
 * The local model as an ExtractBrain. `promptChars` is what its window holds
 * once the reply's tokens are set aside, so the extractor sizes each call to
 * fit rather than have Ollama silently drop the start of the prompt (the
 * instructions).
 */
export function localExtractBrain(m: LocalMemoryModel, deps: LocalBrainDeps = {}): ExtractBrain {
  const numCtx = typeof m.numCtx === 'number' && Number.isInteger(m.numCtx) && m.numCtx > 0 ? m.numCtx : DEFAULT_NUM_CTX;
  const maxTokens = replyTokens(numCtx);
  return {
    promptChars: Math.max(0, Math.floor((numCtx - maxTokens) * CHARS_PER_TOKEN)),
    generate: (input) => askLocal(m, deps, input, maxTokens),
  };
}

async function askLocal(
  m: LocalMemoryModel,
  deps: LocalBrainDeps,
  input: { system: string; prompt: string },
  maxTokens: number,
): Promise<{ facts: FactEntry[] }> {
  const chatActive = deps.chatActive ?? (() => false);
  if (chatActive()) throw new MemoryBrainError('deferred');
  const base = deps.fetch ?? fetch;
  let requests = 0;
  /** The HTTP status the server last answered with. */
  let status: number | undefined;
  let truncated = false;
  let stopped: 'deferred' | 'timeout' | undefined;
  let lastError: unknown;
  const ac = new AbortController();
  const stop = (why: 'deferred' | 'timeout') => {
    stopped ??= why;
    ac.abort();
  };
  const timer = setTimeout(() => stop('timeout'), deps.timeoutMs ?? MEMORY_CALL_TIMEOUT_MS);
  const watch = setInterval(() => {
    if (chatActive()) stop('deferred');
  }, deps.pollMs ?? CHAT_POLL_MS);
  timer.unref?.();
  watch.unref?.();
  // Every request the provider makes, its own retries included, comes through here.
  const gated = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(typeof url === 'string' || url instanceof URL ? String(url) : url.url);
    if (u.origin !== m.baseURL || u.pathname !== '/api/chat' || (init?.method ?? 'GET').toUpperCase() !== 'POST') throw new Stop('only /api/chat');
    if (requests >= MEMORY_MODEL_REQUESTS) throw new Stop('no more requests');
    if (chatActive()) {
      stop('deferred');
      throw new Stop('chat is busy');
    }
    requests += 1;
    // keep_alive is top-level in Ollama's request, outside the provider's options.
    const body = m.unloadAfter && typeof init?.body === 'string' ? JSON.stringify({ ...(JSON.parse(init.body) as object), keep_alive: 0 }) : init?.body;
    const res = await base(u.href, { ...init, ...(body !== undefined ? { body } : {}) });
    status = res.status;
    return res;
  }) as typeof fetch;
  const provider = new OllamaProvider({
    baseURL: m.baseURL,
    fetch: gated,
    think: false,
    defaultOptions: { temperature: 0, ...(m.numCtx !== undefined ? { num_ctx: m.numCtx } : {}) },
  });
  try {
    while (requests < MEMORY_MODEL_REQUESTS && !stopped) {
      try {
        const r = await provider.generate({
          model: m.model,
          system: input.system,
          messages: [{ id: 'memory-extract', role: 'user', content: input.prompt, timestamp: Date.now() }],
          responseFormat: { type: 'json_schema', name: 'memory_facts', schema: FACTS_SCHEMA as unknown as Record<string, unknown> },
          maxTokens,
          signal: ac.signal,
        });
        if (r.reason === 'max_tokens') {
          truncated = true;
          break;
        }
        if (r.reason !== 'complete' || r.message.role !== 'assistant') continue;
        let value: unknown;
        try {
          value = JSON.parse(r.message.content);
        } catch {
          continue;
        }
        const reply = factsReply(value);
        if (reply) return reply;
      } catch (err) {
        // A transport or HTTP error, an unparsable reply, the gate, or a cut-off: the loop decides.
        lastError = err;
        if (requests === 0 && !stopped) break;
      }
    }
  } finally {
    clearTimeout(timer);
    clearInterval(watch);
  }
  const why = stopped ?? (truncated ? 'truncated' : answered(status));
  throw new MemoryBrainError(why, why === 'unavailable' || why === 'server-error' ? failureDetail(lastError) : undefined);
}

/**
 * Statuses that say the server can't serve anyone right now, whatever was
 * asked: the model isn't pulled (404), too many requests (429), busy or down
 * (502, 503, 504; Ollama answers 503 when its queue is full).
 */
const OUTAGE = new Set([404, 429, 502, 503, 504]);

/**
 * What the server's last answer means when there is no usable reply: none at
 * all, or an OUTAGE status, is `unavailable`, not the batch's doing; any other
 * error status (a 4xx, a 500) is `server-error`, which may be; a 2xx is a
 * reply that wasn't the shape, `invalid`.
 */
export function answered(status: number | undefined): BrainFailure {
  if (status === undefined || OUTAGE.has(status)) return 'unavailable';
  return status >= 200 && status < 300 ? 'invalid' : 'server-error';
}

/** A failed request as a log can carry it: the error's kind and status ("validation 404", "provider_unavailable"), never its message, which holds Ollama's reply. */
function failureDetail(err: unknown): string | undefined {
  if (!isFlintError(err)) return undefined;
  const code = err.error.providerCode;
  return code && /^\d{3}$/.test(code) ? `${err.kind} ${code}` : err.kind;
}
