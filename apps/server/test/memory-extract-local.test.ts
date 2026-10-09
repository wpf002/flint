/**
 * Memory extraction on the local model (./memory-brain + ./memory-extract):
 * local by default with no API key and never a cloud model, the frontier only
 * when Will opts in, a pass that yields to his chat, facts grounded in a quote
 * of his own words that also covers what they claim, supersedes limited to
 * facts the model was shown, strikes so one bad batch can't stall the rest, a
 * cut-off reply retried at half the turns, and logs with no transcript in them.
 * Every model is a fake: no network.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Turn } from '@flint/core';
import { KnowledgeStore } from '../src/knowledge';
import { ChatLoad } from '../src/chat-load';
import { FlintError, OllamaProvider } from '@flint/core';
import { liveOllamaOptions } from '../src/local-model';
import {
  MemoryExtractor,
  MemoryBrainError,
  FACTS_SCHEMA,
  errorKind,
  factCoverage,
  factsReply,
  holdsWords,
  locateQuote,
  numbersGrounded,
  sharesContent,
  normalizeQuoteText,
  quoteNeedle,
  type ExtractBrain,
  type TurnSource,
} from '../src/memory-extract';
import {
  MEMORY_CHAT_QUIET_MS,
  MEMORY_MODEL_REQUESTS,
  answered,
  canonicalModel,
  chooseMemoryBrain,
  frontierExtractBrain,
  isCloudModel,
  sameModel,
  liveChat,
  localExtractBrain,
  localMemoryModel,
  replyTokens,
  type LocalMemoryModel,
} from '../src/memory-brain';

const downEmbedder = {
  embed: async () => {
    throw new Error('ollama down');
  },
} as unknown as ConstructorParameters<typeof KnowledgeStore>[1];

let tick = 1_790_000_000_000;
function turn(cid: string, user: string, assistant = 'ok'): Turn {
  tick += 60_000;
  return {
    id: `t${tick}`,
    conversationId: cid,
    status: 'complete',
    messages: [
      { id: `u${tick}`, role: 'user', content: user, timestamp: tick },
      { id: `a${tick}`, role: 'assistant', content: assistant, timestamp: tick },
    ],
    createdAt: tick,
    updatedAt: tick,
  };
}

function source(convs: Record<string, Turn[]>): TurnSource {
  return {
    conversationIds: () => Object.keys(convs),
    getTurns: async (cid) => structuredClone(convs[cid] ?? []),
  };
}

/** Ollama's /api/chat reply for a non-streamed call. */
function chatReply(content: string, doneReason = 'stop'): Response {
  return new Response(JSON.stringify({ message: { role: 'assistant', content }, done: true, done_reason: doneReason, prompt_eval_count: 10, eval_count: 5 }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

interface Seen {
  url: string;
  body: {
    model: string;
    messages: Array<{ role: string; content: string }>;
    format?: unknown;
    think?: boolean;
    keep_alive?: number;
    stream: boolean;
    options?: Record<string, unknown>;
  };
  signal: AbortSignal | undefined;
}

/** A fake Ollama: records each request, answers with `reply`. */
function fakeOllama(reply: (seen: Seen, n: number) => Response | Promise<Response>) {
  const requests: Seen[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const seen: Seen = { url: String(url), body: JSON.parse(String(init?.body)), signal: init?.signal ?? undefined };
    requests.push(seen);
    return reply(seen, requests.length);
  }) as typeof fetch;
  return { f, requests };
}

/** Never answers; rejects as fetch does when its signal aborts. */
function hang(seen: Seen): Promise<Response> {
  return new Promise((_, reject) => {
    seen.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
  });
}

const facts = (...fs: Array<{ turn: number; quote: string; fact: string; category?: string; supersedes?: string[] }>) =>
  JSON.stringify({ facts: fs.map((f) => ({ category: 'other', supersedes: [], ...f })) });

const LOCAL: LocalMemoryModel = { baseURL: 'http://127.0.0.1:11434', model: 'muse-glimmer:30b', numCtx: 8192, unloadAfter: false };

let dir: string;
let kpath: string;
let spath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'flint-extract-local-'));
  kpath = join(dir, 'knowledge.json');
  spath = join(dir, 'extract-state.json');
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});
const state = () => JSON.parse(readFileSync(spath, 'utf8'));
const watermark = (cid: string): number | undefined => {
  try {
    return state().watermarks?.[cid];
  } catch {
    return undefined;
  }
};

describe('which brain extraction runs on', () => {
  it('the local model by default, even with a frontier and an Anthropic key configured', async () => {
    const frontierCalls: string[] = [];
    const frontier: ExtractBrain = { generate: async (i) => (frontierCalls.push(i.prompt), { text: '{"facts": []}' }) };
    const { f, requests } = fakeOllama(() => chatReply(facts()));
    const plan = chooseMemoryBrain(
      { OLLAMA_MODEL: 'muse-glimmer:30b', ANTHROPIC_API_KEY: 'sk-ant-test-not-a-real-key' },
      { frontier, log: () => {}, fetch: f },
    );
    expect(plan.kind).toBe('local');
    if (plan.kind !== 'local') return;
    expect(plan.model).toEqual({ baseURL: 'http://127.0.0.1:11434', model: 'muse-glimmer:30b', numCtx: 4096, unloadAfter: false });
    const convs = { console: [turn('console', 'My sister Ana lives in Austin and teaches piano')] };
    await new MemoryExtractor(source(convs), new KnowledgeStore(kpath, downEmbedder), plan.brain, spath).run();
    expect(requests).toHaveLength(1);
    expect(frontierCalls).toHaveLength(0);
  });

  it('needs no API key: with no Anthropic key and no frontier at all, it still extracts and stores', async () => {
    const env = { OLLAMA_MODEL: 'muse-glimmer:30b', OLLAMA_NUM_CTX: '8192' };
    const { f, requests } = fakeOllama(() =>
      chatReply(facts({ turn: 1, quote: 'my sister Ana lives in Austin', fact: "Will's sister Ana lives in Austin.", category: 'person' })),
    );
    const plan = chooseMemoryBrain(env, { frontier: undefined, log: () => {}, fetch: f });
    expect(plan.kind).toBe('local');
    if (plan.kind !== 'local') return;
    const k = new KnowledgeStore(kpath, downEmbedder);
    const convs = { console: [turn('console', 'Remember that my sister Ana lives in Austin and teaches piano')] };
    expect(await new MemoryExtractor(source(convs), k, plan.brain, spath).run()).toBe(1);
    expect(requests[0]!.url).toBe('http://127.0.0.1:11434/api/chat');
    expect(k.all()[0]).toMatchObject({ text: "Will's sister Ana lives in Austin.", source: 'history', conversationId: 'console', category: 'person' });
  });

  it('the frontier only when Will opts in, and never in place of a missing local model (or the other way round)', () => {
    const frontier: ExtractBrain = { generate: async () => ({ text: '{"facts": []}' }) };
    const log: string[] = [];
    const opts = { frontier, log: (m: string) => log.push(m) };
    expect(chooseMemoryBrain({ OLLAMA_MODEL: 'muse-glimmer:30b', FLINT_MEMORY_BRAIN: 'frontier' }, opts)).toEqual({ kind: 'frontier', brain: frontier });
    expect(chooseMemoryBrain({ OLLAMA_MODEL: 'muse-glimmer:30b', FLINT_MEMORY_BRAIN: ' Frontier ' }, opts).kind).toBe('frontier');
    // Opted in with no frontier configured: nothing, not the local model.
    expect(chooseMemoryBrain({ OLLAMA_MODEL: 'muse-glimmer:30b', FLINT_MEMORY_BRAIN: 'frontier' }, { ...opts, frontier: undefined }).kind).toBe('none');
    // Local by default with no local model: nothing, not the frontier.
    expect(chooseMemoryBrain({ ANTHROPIC_API_KEY: 'sk-ant-test-not-a-real-key' }, opts)).toMatchObject({ kind: 'none' });
    expect(chooseMemoryBrain({ OLLAMA_MODEL: 'muse-glimmer:30b', FLINT_MEMORY_BRAIN: 'off' }, opts)).toEqual({ kind: 'none', why: 'FLINT_MEMORY_BRAIN=off' });
    // Anything else is logged and read as the default.
    expect(chooseMemoryBrain({ OLLAMA_MODEL: 'muse-glimmer:30b', FLINT_MEMORY_BRAIN: 'claude' }, opts).kind).toBe('local');
    expect(log.join('\n')).toContain('FLINT_MEMORY_BRAIN must be local, frontier or off');
  });

  it("sends what the chat brain sends (host, model, num_ctx, no keep_alive), so Ollama never reloads the model between them", async () => {
    for (const env of [
      { OLLAMA_MODEL: 'muse-glimmer:30b', OLLAMA_HOST: 'http://127.0.0.1:11434/', OLLAMA_NUM_CTX: '16384' },
      { OLLAMA_MODEL: 'muse-glimmer:30b' },
      { OLLAMA_MODEL: 'muse-glimmer:30b', OLLAMA_NUM_CTX: 'lots' },
    ]) {
      // The chat brain exactly as index.ts buildProvider makes it, on the wire.
      const chat = fakeOllama(() => chatReply('Hi Will.'));
      const chatBrain = new OllamaProvider({ ...liveOllamaOptions(env), fetch: chat.f });
      await chatBrain.generate({ model: env.OLLAMA_MODEL, messages: [{ id: 'u', role: 'user', content: 'hello there', timestamp: 0 }] });
      const mem = fakeOllama(() => chatReply(facts()));
      const plan = chooseMemoryBrain(env, { frontier: undefined, log: () => {}, fetch: mem.f });
      if (plan.kind !== 'local') throw new Error('expected the local model');
      await plan.brain.generate({ system: 's', prompt: 'p' });
      const [c, m] = [chat.requests[0]!, mem.requests[0]!];
      expect(new URL(m.url).origin, JSON.stringify(env)).toBe(new URL(c.url).origin);
      expect(m.body.model).toBe(c.body.model);
      expect(m.body.options!.num_ctx, JSON.stringify(env)).toEqual(c.body.options!.num_ctx);
      expect('keep_alive' in m.body).toBe(false);
    }
  });

  it('never an Ollama cloud model: FLINT_MEMORY_MODEL naming one is ignored, and an OLLAMA_MODEL that is one gets a warning and no extraction', () => {
    for (const name of ['gpt-oss:120b-cloud', 'glm-4.6:cloud', 'deepseek-v3.1:671b-cloud', 'qwen3-coder-cloud', 'Kimi-K2:1T-Cloud']) expect(isCloudModel(name), name).toBe(true);
    for (const name of ['muse-glimmer:30b', 'qwen3.6:35b', 'mycloud:7b', 'hf.co/org/cloudy-repo:Q4_K_M', 'nomic-embed-text']) expect(isCloudModel(name), name).toBe(false);
    const log: string[] = [];
    expect(localMemoryModel({ OLLAMA_MODEL: 'muse-glimmer:30b', FLINT_MEMORY_MODEL: 'gpt-oss:120b-cloud' }, (m) => log.push(m))!.model).toBe('muse-glimmer:30b');
    expect(log.join('\n')).toContain('FLINT_MEMORY_MODEL is an Ollama cloud model');
    log.length = 0;
    expect(chooseMemoryBrain({ OLLAMA_MODEL: 'glm-4.6:cloud' }, { frontier: undefined, log: (m) => log.push(m) }).kind).toBe('none');
    expect(log.join('\n')).toContain('warning: OLLAMA_MODEL is an Ollama cloud model');
    // A local FLINT_MEMORY_MODEL still runs beside a cloud chat brain (with the warning).
    log.length = 0;
    expect(localMemoryModel({ OLLAMA_MODEL: 'glm-4.6:cloud', FLINT_MEMORY_MODEL: 'qwen3.6:35b' }, (m) => log.push(m))!.model).toBe('qwen3.6:35b');
    expect(log.join('\n')).toContain('warning: OLLAMA_MODEL is an Ollama cloud model');
  });

  it('a model of its own (FLINT_MEMORY_MODEL) is unloaded after each request, so it never holds the chat model\'s memory', async () => {
    const m = localMemoryModel({ OLLAMA_MODEL: 'muse-glimmer:30b', FLINT_MEMORY_MODEL: 'qwen3.6:35b' }, () => {})!;
    expect(m.unloadAfter).toBe(true);
    const { f, requests } = fakeOllama(() => chatReply(facts()));
    await localExtractBrain(m, { fetch: f }).generate({ system: 's', prompt: 'p' });
    expect(requests[0]!.body).toMatchObject({ model: 'qwen3.6:35b', keep_alive: 0 });
    // The same model as the chat brain's, however it's written, stays loaded.
    expect(localMemoryModel({ OLLAMA_MODEL: 'muse-glimmer:30b', FLINT_MEMORY_MODEL: 'muse-glimmer:30b' }, () => {})!.unloadAfter).toBe(false);
    expect(localMemoryModel({ OLLAMA_MODEL: 'llama3.1', FLINT_MEMORY_MODEL: 'llama3.1:latest' }, () => {})!.unloadAfter).toBe(false);
    expect(localMemoryModel({ OLLAMA_MODEL: 'qwen3:8b', FLINT_MEMORY_MODEL: 'Qwen3:8B' }, () => {})!.unloadAfter).toBe(false);
    const same = fakeOllama(() => chatReply(facts()));
    await localExtractBrain(localMemoryModel({ OLLAMA_MODEL: 'llama3.1', FLINT_MEMORY_MODEL: 'Llama3.1:latest' }, () => {})!, { fetch: same.f }).generate({ system: 's', prompt: 'p' });
    expect('keep_alive' in same.requests[0]!.body).toBe(false);
    // A different tag is a different model.
    expect(localMemoryModel({ OLLAMA_MODEL: 'qwen3:8b', FLINT_MEMORY_MODEL: 'qwen3:14b' }, () => {})!.unloadAfter).toBe(true);
    expect(canonicalModel(' Llama3.1 ')).toBe('llama3.1:latest');
    expect(canonicalModel('registry.local:5000/org/model')).toBe('registry.local:5000/org/model:latest'); // a port is not a tag
    expect(sameModel('hf.co/Org/Repo:Q4_K_M', 'hf.co/org/repo:q4_k_m')).toBe(true);
  });

  it('FLINT_MEMORY_MODEL names another local model; a name that is not one, or a host that is not http(s), is refused', () => {
    const log: string[] = [];
    expect(localMemoryModel({ OLLAMA_MODEL: 'muse-glimmer:30b', FLINT_MEMORY_MODEL: 'qwen3.6:35b' }, (m) => log.push(m))!.model).toBe('qwen3.6:35b');
    expect(localMemoryModel({ OLLAMA_MODEL: 'muse-glimmer:30b', FLINT_MEMORY_MODEL: 'qwen; rm -rf ~' }, (m) => log.push(m))!.model).toBe('muse-glimmer:30b');
    expect(localMemoryModel({ FLINT_MEMORY_MODEL: 'qwen3.8:27b' }, (m) => log.push(m))!.model).toBe('qwen3.8:27b');
    expect(localMemoryModel({ OLLAMA_MODEL: 'muse-glimmer:30b', OLLAMA_HOST: 'file:///etc/passwd' }, (m) => log.push(m))).toBeUndefined();
    expect(localMemoryModel({ OLLAMA_MODEL: 'muse-glimmer:30b', OLLAMA_HOST: '127.0.0.1:11434' }, (m) => log.push(m))).toBeUndefined();
    expect(localMemoryModel({}, (m) => log.push(m))).toBeUndefined();
    expect(log.some((l) => l.includes('FLINT_MEMORY_MODEL is not an Ollama model name'))).toBe(true);
    expect(log.some((l) => l.includes('OLLAMA_HOST is not an http(s) URL'))).toBe(true);
  });
});

describe('the local brain', () => {
  it('asks /api/chat with the facts schema, think off, temperature 0, and a reply budget out of the window', async () => {
    const { f, requests } = fakeOllama(() => chatReply(facts({ turn: 1, quote: 'my dog Biscuit', fact: "Will's dog is named Biscuit." })));
    const brain = localExtractBrain(LOCAL, { fetch: f });
    expect(brain.promptChars).toBe(Math.floor((8192 - replyTokens(8192)) * 3.5));
    const out = await brain.generate({ system: 'SYS', prompt: 'PROMPT' });
    expect(out).toEqual({ facts: [{ turn: 1, quote: 'my dog Biscuit', fact: "Will's dog is named Biscuit.", category: 'other', supersedes: [] }] });
    expect(requests).toHaveLength(1);
    const r = requests[0]!;
    expect(r.url).toBe('http://127.0.0.1:11434/api/chat');
    expect(r.body).toMatchObject({ model: 'muse-glimmer:30b', stream: false, think: false, format: FACTS_SCHEMA });
    expect(r.body.options).toEqual({ temperature: 0, num_ctx: 8192, num_predict: 2048 });
    expect(r.body.messages).toEqual([
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'PROMPT' },
    ]);
  });

  it('a reply that is not the schema is invalid, after one request (at temperature 0 a second replays the first)', async () => {
    for (const bad of ['not json at all', '{"facts": "nope"}', '{"facts": [{"fact": "Will has a dog."}]}', '[]']) {
      const { f, requests } = fakeOllama(() => chatReply(bad));
      const err = await localExtractBrain(LOCAL, { fetch: f }).generate({ system: 's', prompt: 'p' }).catch((e: unknown) => e);
      expect(err, bad).toBeInstanceOf(MemoryBrainError);
      expect((err as MemoryBrainError).why, bad).toBe('invalid');
      expect(requests.length, bad).toBe(1);
    }
    expect(MEMORY_MODEL_REQUESTS).toBe(1);
  });

  it('a reply cut off at its token limit says so (truncated), on the local model and the frontier alike', async () => {
    const { f, requests } = fakeOllama(() => chatReply('{"facts": [{"turn": 1, "quote": "my dog', 'length'));
    await expect(localExtractBrain(LOCAL, { fetch: f }).generate({ system: 's', prompt: 'p' })).rejects.toMatchObject({ why: 'truncated' });
    expect(requests).toHaveLength(1);
    const cut = frontierExtractBrain(async () => ({ text: '{"facts": [{"turn": 1, "quo', reason: 'max_tokens' }));
    await expect(cut.generate({ system: 's', prompt: 'p' })).rejects.toMatchObject({ why: 'truncated' });
    const whole = frontierExtractBrain(async () => ({ text: '{"facts": []}', reason: 'complete' }));
    expect(await whole.generate({ system: 's', prompt: 'p' })).toEqual({ text: '{"facts": []}' });
  });

  it('no reply at all (Ollama down, the model not pulled) is unavailable', async () => {
    const refused = fakeOllama(() => {
      throw new TypeError('fetch failed');
    });
    await expect(localExtractBrain(LOCAL, { fetch: refused.f }).generate({ system: 's', prompt: 'p' })).rejects.toMatchObject({ why: 'unavailable', detail: 'provider_unavailable' });
    const notPulled = fakeOllama(() => new Response('{"error":"model \\"muse-glimmer:30b\\" not found, try pulling it first"}', { status: 404 }));
    // The status says what to fix; Ollama's own words (which can echo a request) stay out.
    await expect(localExtractBrain(LOCAL, { fetch: notPulled.f }).generate({ system: 's', prompt: 'p' })).rejects.toMatchObject({ why: 'unavailable', detail: 'validation 404' });
    expect(notPulled.requests.length).toBeLessThanOrEqual(MEMORY_MODEL_REQUESTS);
    // Too many requests, or busy or down (Ollama answers 503 when its queue is full): it can't serve anyone, so no batch's doing.
    for (const status of [429, 502, 503, 504]) {
      const busy = fakeOllama(() => new Response('{"error":"server busy, please try again"}', { status }));
      await expect(localExtractBrain(LOCAL, { fetch: busy.f }).generate({ system: 's', prompt: 'p' }), String(status)).rejects.toMatchObject({ why: 'unavailable' });
    }
  });

  it('any other error the server answered with (a 500, another 4xx) is a server-error: it may be the batch', async () => {
    expect([200, 204].map(answered)).toEqual(['invalid', 'invalid']);
    expect([undefined, 404, 429, 502, 503, 504].map(answered)).toEqual(Array(6).fill('unavailable'));
    expect([400, 413, 422, 500, 501].map(answered)).toEqual(Array(5).fill('server-error'));
    for (const status of [500, 400]) {
      const { f } = fakeOllama(() => new Response('{"error":"llama runner process has terminated"}', { status }));
      await expect(localExtractBrain(LOCAL, { fetch: f }).generate({ system: 's', prompt: 'p' }), String(status)).rejects.toMatchObject({ why: 'server-error' });
    }
  });

  it('a model still working when the time runs out is a timeout, and the request is cut off', async () => {
    const { f, requests } = fakeOllama((seen) => hang(seen));
    await expect(localExtractBrain(LOCAL, { fetch: f, timeoutMs: 40 }).generate({ system: 's', prompt: 'p' })).rejects.toMatchObject({ why: 'timeout' });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.signal?.aborted).toBe(true);
  });

  it('makes no request while Will is chatting', async () => {
    const { f, requests } = fakeOllama(() => chatReply(facts()));
    await expect(localExtractBrain(LOCAL, { fetch: f, chatActive: () => true }).generate({ system: 's', prompt: 'p' })).rejects.toMatchObject({ why: 'deferred' });
    expect(requests).toHaveLength(0);
  });

  it('cuts off a running request the moment a chat turn starts', async () => {
    let chatting = false;
    const { f, requests } = fakeOllama((seen) => {
      setTimeout(() => (chatting = true), 20); // Will sends a message mid-call
      return hang(seen);
    });
    const started = Date.now();
    await expect(localExtractBrain(LOCAL, { fetch: f, chatActive: () => chatting, pollMs: 5 }).generate({ system: 's', prompt: 'p' })).rejects.toMatchObject({ why: 'deferred' });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.signal?.aborted).toBe(true);
  });
});

describe('a pass yields to Will’s chat', () => {
  it('waits while a chat turn runs and for a quiet spell after it, then goes ahead', async () => {
    let now = 1_000_000;
    const load = new ChatLoad(() => now);
    const chatActive = liveChat(load);
    expect(chatActive()).toBe(false); // no chat yet
    let release!: () => void;
    const t = load.run(() => new Promise<void>((r) => (release = r)));
    expect(chatActive()).toBe(true);
    release();
    await t;
    expect(chatActive()).toBe(true); // just ended: his next message usually follows
    now += MEMORY_CHAT_QUIET_MS - 1;
    expect(chatActive()).toBe(true);
    now += 1;
    expect(chatActive()).toBe(false);
  });

  it('no request, no watermark, none of the day spent while he chats; it comes back in deferMs and then runs', async () => {
    let chatting = true;
    const chatActive = () => chatting;
    const { f, requests } = fakeOllama(() => chatReply(facts()));
    const convs = { console: [turn('console', 'My sister Ana lives in Austin and teaches piano')] };
    const ex = new MemoryExtractor(source(convs), new KnowledgeStore(kpath, downEmbedder), localExtractBrain(LOCAL, { fetch: f, chatActive }), spath, {
      chatActive,
      deferMs: 120_000,
    });
    for (let i = 0; i < 5; i++) {
      expect(await ex.run()).toBe(0);
      expect(ex.nextDelayMs).toBe(120_000);
    }
    expect(requests).toHaveLength(0);
    expect(watermark('console')).toBeUndefined();
    expect(state().budget.calls).toBe(0);
    expect(ex.lastStats.deferred).toBe(1);
    expect(state().totals.deferred).toBe(5);

    chatting = false;
    await ex.run();
    expect(requests).toHaveLength(1);
    expect(watermark('console')).toBeDefined();
    expect(state().budget.calls).toBe(1);
  });

  it('a chat turn that starts mid-call cuts it off: the turns wait, and the call is not one of the day’s', async () => {
    let chatting = false;
    const chatActive = () => chatting;
    const { f, requests } = fakeOllama((seen) => {
      chatting = true; // Will sends a message while the pass is asking
      return hang(seen);
    });
    const convs = { console: [turn('console', 'My sister Ana lives in Austin and teaches piano')] };
    const ex = new MemoryExtractor(source(convs), new KnowledgeStore(kpath, downEmbedder), localExtractBrain(LOCAL, { fetch: f, chatActive, pollMs: 5 }), spath, { chatActive });
    await ex.run();
    expect(requests).toHaveLength(1);
    expect(watermark('console')).toBeUndefined();
    expect(state().budget.calls).toBe(0);
    expect(ex.lastStats).toMatchObject({ calls: 0, deferred: 1, unparseable: 0, failed: 0 });
  });

  it('a deferral in the middle of a pass keeps the batches already done', async () => {
    let chatting = false;
    const chatActive = () => chatting;
    const { f, requests } = fakeOllama(() => {
      chatting = true; // after the first call, Will starts chatting
      return chatReply(facts());
    });
    const convs: Record<string, Turn[]> = {};
    for (let i = 0; i < 3; i++) convs[`c${i}`] = [turn(`c${i}`, `Distinct durable statement number ${i} about Will's projects`)];
    const ex = new MemoryExtractor(source(convs), new KnowledgeStore(kpath, downEmbedder), localExtractBrain(LOCAL, { fetch: f, chatActive }), spath, {
      chatActive,
      batchChars: 1, // one turn per call
    });
    await ex.run();
    expect(requests).toHaveLength(1);
    expect(watermark('c0')).toBeDefined();
    expect(watermark('c1')).toBeUndefined();
    expect(state().budget.calls).toBe(1);
  });
});

describe('a failed or invalid reply keeps the watermark', () => {
  it('invalid JSON: the turns wait (the call counts: the model worked), and a poison batch is skipped after 3 tries', async () => {
    const { f, requests } = fakeOllama(() => chatReply('Sure! Will has a dog named Biscuit.'));
    const convs = { console: [turn('console', 'My dog is named Biscuit and she is a corgi')] };
    const ex = new MemoryExtractor(source(convs), new KnowledgeStore(kpath, downEmbedder), localExtractBrain(LOCAL, { fetch: f }), spath);
    await ex.run();
    expect(watermark('console')).toBeUndefined();
    expect(ex.lastStats).toMatchObject({ calls: 1, unparseable: 1 });
    expect(state().budget.calls).toBe(1);
    await ex.run();
    expect(watermark('console')).toBeUndefined();
    await ex.run();
    expect(watermark('console')).toBeDefined();
    expect(requests).toHaveLength(3 * MEMORY_MODEL_REQUESTS);
  });

  it('a schema mismatch keeps it too', async () => {
    const { f } = fakeOllama(() => chatReply('{"facts": [{"fact": "Will has a corgi named Biscuit.", "turn": 1}]}'));
    const convs = { console: [turn('console', 'My dog is named Biscuit and she is a corgi')] };
    const ex = new MemoryExtractor(source(convs), new KnowledgeStore(kpath, downEmbedder), localExtractBrain(LOCAL, { fetch: f }), spath);
    await ex.run();
    expect(watermark('console')).toBeUndefined();
    expect(ex.lastStats.unparseable).toBe(1);
  });

  it('a timeout keeps it, counts the call, and is a strike against the batch', async () => {
    const { f } = fakeOllama((seen) => hang(seen));
    const convs = { console: [turn('console', 'My dog is named Biscuit and she is a corgi')] };
    const ex = new MemoryExtractor(source(convs), new KnowledgeStore(kpath, downEmbedder), localExtractBrain(LOCAL, { fetch: f, timeoutMs: 30 }), spath);
    await ex.run();
    expect(watermark('console')).toBeUndefined();
    expect(state().budget.calls).toBe(1);
    expect(ex.lastStats).toMatchObject({ failed: 1, unparseable: 0 });
    expect(state().failures).toEqual({ key: `console@${convs.console[0]!.updatedAt}`, count: 1 });
  });

  it('Ollama down: the watermark stays, none of the day is spent, and the next pass backs off', async () => {
    const { f } = fakeOllama(() => {
      throw new TypeError('fetch failed');
    });
    const convs = { console: [turn('console', 'My dog is named Biscuit and she is a corgi')] };
    const ex = new MemoryExtractor(source(convs), new KnowledgeStore(kpath, downEmbedder), localExtractBrain(LOCAL, { fetch: f }), spath, {
      backlogEveryMs: 60_000,
      everyMs: 3_600_000,
    });
    for (let i = 0; i < 30; i++) await ex.run();
    expect(watermark('console')).toBeUndefined();
    expect(state().budget.calls).toBe(0);
    expect(state().totals.failed).toBe(30);
    expect(ex.nextDelayMs).toBe(3_600_000);
  });
});

describe('each call fits the local window', () => {
  it('a small batchChars only means fewer turns a call: every turn still goes whole', async () => {
    const user = 'My homelab runs on the Mac Studio with a ZFS pool, nightly backups to the NAS, and a UPS in the closet';
    const convs = { a: [turn('a', user)], b: [turn('b', 'My sister Ana lives in Austin and teaches piano')] };
    const { f, requests } = fakeOllama(() => chatReply(facts()));
    await new MemoryExtractor(source(convs), new KnowledgeStore(kpath, downEmbedder), localExtractBrain(LOCAL, { fetch: f }), spath, { batchChars: 1 }).run();
    expect(requests).toHaveLength(2);
    expect(requests[0]!.body.messages[1]!.content).toContain(`WILL: ${user}\n`);
  });

  it('sizes the transcript and the known facts to what the model can read', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {}); // 120 "embed failed" lines
    const k = new KnowledgeStore(kpath, downEmbedder);
    const words = ['amber', 'basalt', 'cobalt', 'dune', 'ember', 'fjord', 'granite', 'harbor', 'indigo', 'jasper'];
    for (let i = 0; i < 120; i++) await k.add(`Will's rack ${words[i % 10]}${i} hosts the ${words[(i * 3) % 10]}-${i} service on port ${8000 + i}.`, 'user');
    const convs: Record<string, Turn[]> = {};
    for (let i = 0; i < 12; i++) convs[`c${i}`] = [turn(`c${i}`, `Project note ${i}: ` + 'my homelab runs on the Mac Studio with a ZFS pool and nightly backups. '.repeat(20))];
    const small: LocalMemoryModel = { ...LOCAL, numCtx: 4096 };
    const { f, requests } = fakeOllama(() => chatReply(facts()));
    const brain = localExtractBrain(small, { fetch: f });
    await new MemoryExtractor(source(convs), k, brain, spath, { maxCallsPerDay: 100 }).run();
    expect(requests.length).toBeGreaterThan(3);
    for (const r of requests) {
      const chars = r.body.messages.reduce((n, m) => n + m.content.length, 0);
      expect(chars).toBeLessThanOrEqual(brain.promptChars! + 200);
      expect(r.body.options!.num_ctx).toBe(4096);
    }
    expect(requests[0]!.body.messages[1]!.content).toContain('KNOWN FACTS');
  });
});

describe('quote grounding', () => {
  it('normalises typography, spacing and case, and nothing else', () => {
    expect(normalizeQuoteText('It’s “done” — mostly')).toBe(`it's "done" - mostly`);
    expect(normalizeQuoteText('September 25–October 3')).toBe('september 25-october 3');
    expect(normalizeQuoteText('  two\n\tlines and  spaces ')).toBe('two lines and spaces');
    expect(normalizeQuoteText('wait…')).toBe('wait...');
    expect(normalizeQuoteText('ＦＵＬＬ width')).toBe('full width');
    expect(normalizeQuoteText('`code`')).toBe('`code`'); // backticks mark code: left alone
  });

  it('takes off the wrapping a model adds, and refuses a quote too short to mean anything', () => {
    expect(quoteNeedle('"My team is the Astros."')).toBe('my team is the astros');
    expect(quoteNeedle('…the Astros, have been forever…')).toBe('the astros, have been forever');
    expect(quoteNeedle('yes')).toBeUndefined();
    expect(quoteNeedle('  ')).toBeUndefined();
    expect(quoteNeedle(undefined)).toBeUndefined();
  });

  const batch = [
    { will: ['What should I name my new corgi puppy?'], assistant: ['Biscuit is a classic. Your corgi is named Biscuit, right?'] },
    { will: ['My team is the Houston Astros, have been forever', 'earlier: I moved to Dallas in 2019'], assistant: ['Nice!'] },
  ];

  it('finds the quote in Will’s words, the cited turn first, and says which turn it is', () => {
    expect(locateQuote('my team is the Houston Astros', batch, 2)).toBe(1);
    expect(locateQuote('my team is the Houston Astros', batch, 1)).toBe(1); // mis-numbered: the quote decides
    expect(locateQuote('my team is the Houston Astros', batch, 99)).toBe(1);
    expect(locateQuote('I moved to Dallas in 2019', batch, 2)).toBe(1); // the previous turn, shown as context, is his words too
    expect(locateQuote('“My   team is the houston astros”', batch)).toBe(1);
  });

  it('a claim found only in the assistant’s words grounds nothing; one found nowhere neither', () => {
    expect(locateQuote('Your corgi is named Biscuit', batch, 1)).toBe('assistant-quote');
    expect(locateQuote('my corgi is named Biscuit', batch, 1)).toBe('ungrounded');
    expect(locateQuote(undefined, batch, 1)).toBe('ungrounded');
    expect(locateQuote('Astros', batch, 2)).toBe('ungrounded'); // one word grounds nothing
  });

  it('end to end: an assistant-only claim and an invented quote are dropped, a real one is stored where it was said', async () => {
    const convs = {
      a: [turn('a', 'What should I name my new corgi puppy?', 'Biscuit is a classic. Your corgi is named Biscuit, right?')],
      b: [turn('b', 'Heads up — my team’s the Houston Astros, have been forever', 'Noted.')],
    };
    const { f } = fakeOllama(() =>
      chatReply(
        facts(
          { turn: 1, quote: 'Your corgi is named Biscuit', fact: "Will's corgi is named Biscuit." },
          { turn: 1, quote: 'I adopted a corgi last year', fact: 'Will adopted a corgi last year.' },
          { turn: 1, quote: "my team's the Houston Astros", fact: "Will's favorite MLB team is the Houston Astros.", category: 'preference' },
        ),
      ),
    );
    const k = new KnowledgeStore(kpath, downEmbedder);
    const ex = new MemoryExtractor(source(convs), k, localExtractBrain(LOCAL, { fetch: f }), spath);
    expect(await ex.run()).toBe(1);
    expect(ex.lastStats.rejected).toEqual({ 'assistant-quote': 1, ungrounded: 1 });
    expect(k.all()).toHaveLength(1);
    // Cited as turn 1 (conversation a), but the quote is in b: stored with b's provenance.
    expect(k.all()[0]).toMatchObject({ text: "Will's favorite MLB team is the Houston Astros.", conversationId: 'b', sourceAt: convs.b[0]!.updatedAt });
  });

  it('a fact with no quote is not trusted (and a v1-style bare string is not even a candidate)', async () => {
    const convs = { console: [turn('console', 'My sister Ana lives in Austin and teaches piano')] };
    const brain: ExtractBrain = {
      generate: async () => ({ text: JSON.stringify(["Will's sister Ana lives in Austin.", { turn: 1, fact: "Will's sister Ana teaches piano." }]) }),
    };
    const k = new KnowledgeStore(kpath, downEmbedder);
    const ex = new MemoryExtractor(source(convs), k, brain, spath);
    await ex.run();
    expect(k.all()).toHaveLength(0);
    expect(ex.lastStats.rejected).toEqual({ ungrounded: 1 });
    expect(ex.lastStats.candidates).toBe(1);
  });

  it('factsReply holds the reply to the schema’s types and required fields', () => {
    const ok = { turn: 1, quote: 'my dog Biscuit', fact: "Will's dog is named Biscuit.", category: 'other', supersedes: [] };
    expect(factsReply({ facts: [ok] })).toEqual({ facts: [ok] });
    expect(factsReply({ facts: [] })).toEqual({ facts: [] });
    expect(factsReply({ facts: [{ ...ok, extra: 1 }] })).toEqual({ facts: [ok] });
    for (const bad of [null, [], 'x', { facts: 'no' }, { facts: [{ ...ok, turn: 0 }] }, { facts: [{ ...ok, turn: 1.5 }] }, { facts: [{ ...ok, quote: 3 }] }, { facts: [{ ...ok, supersedes: [1] }] }, { facts: [{ fact: 'x' }] }]) {
      expect(factsReply(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('logs carry ids and counts only', () => {
  it('no fact, quote or transcript text reaches a log line, whatever happens', async () => {
    const lines: string[] = [];
    const capture = (...args: unknown[]) => void lines.push(args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack}` : String(a))).join(' '));
    for (const m of ['error', 'warn', 'log', 'info', 'debug'] as const) vi.spyOn(console, m).mockImplementation(capture);

    const k = new KnowledgeStore(kpath, downEmbedder);
    await k.add('Will keeps the Zephyrkeep server in the zephyrcloset hall.', 'user', { sourceAt: 1 });
    const oldId = k.all()[0]!.id;
    const user = 'Zephyruser: my sister Zephyrina moved to Zephyrville, she keeps the Zephyrkeep server now';
    const convs = { console: [turn('console', user, 'Zephyrassistant says how lovely')] };
    const replies = [
      'Zephyroutput is not JSON at all', // unparseable
      facts(
        { turn: 1, quote: 'my sister Zephyrina moved to Zephyrville', fact: "Will's sister Zephyrina moved to Zephyrville.", category: 'person' },
        { turn: 1, quote: 'she keeps the Zephyrkeep server now', fact: "Will's sister Zephyrina keeps the Zephyrkeep server.", supersedes: [oldId] },
        { turn: 1, quote: 'Zephyrassistant says how lovely', fact: 'Will thinks Zephyrassistant is lovely.' },
      ),
    ];
    let n = 0;
    let chatting = false;
    let mode: 'reply' | 'throw' = 'reply';
    const brain: ExtractBrain = {
      generate: async () => {
        if (mode === 'throw') throw new Error(`Zephyrerror: provider echoed ${user}`);
        return { text: replies[Math.min(n++, replies.length - 1)]! };
      },
    };
    const ex = new MemoryExtractor(source(convs), k, brain, spath, { chatActive: () => chatting });

    chatting = true;
    await ex.run(); // deferred
    chatting = false;
    mode = 'throw';
    await ex.run(); // the brain throws text
    mode = 'reply';
    await ex.run(); // unparseable
    expect(await ex.run()).toBe(2); // stored, one supersedes, one assistant-only
    expect(ex.lastStats.superseded).toBe(1);

    // A pass that fails outright (here, the store) is logged by kind and place only.
    const convs2 = { other: [turn('other', 'Zephyruser again: my Zephyrbike is a red Zephyrcycle from 2021')] };
    const broken = {
      all: () => [],
      addDetailed: async () => {
        throw new Error(`Zephyrstore failed on ${user}`);
      },
    } as unknown as KnowledgeStore;
    const ex2 = new MemoryExtractor(source(convs2), broken, { generate: async () => ({ text: facts({ turn: 1, quote: 'my Zephyrbike is a red Zephyrcycle', fact: "Will's bike is a red Zephyrcycle." }) }) }, join(dir, 's2.json'));
    await (ex2 as unknown as { runSafe(): Promise<void> }).runSafe();

    const all = lines.join('\n');
    // The things that happened were logged...
    for (const seen of ["waiting for Will's chat", 'no reply (unavailable', 'no usable reply for batch console@', 'supersedes', 'pass failed: Error']) {
      expect(all).toContain(seen);
    }
    // ...and none of what was said.
    expect(all.toLowerCase()).not.toContain('zephyr');
  });
});

describe('a fact retires only a known fact it was shown, and only one about the same thing', () => {
  it('refuses an id copied from the prompt (never shown) and an unrelated shown one; a real update still supersedes', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {}); // 160 "embed failed" lines
    const k = new KnowledgeStore(kpath, downEmbedder);
    for (let i = 1; i <= 160; i++) {
      await k.add(i === 12 ? "Will's favorite color is teal." : `Will's homelab node n${i}x runs the s${i}y service.`, 'user', { sourceAt: 1 });
    }
    expect(k.all().find((f) => f.id === 'k12')?.text).toBe("Will's favorite color is teal."); // the id the old prompt's example named
    const user = 'My homelab node n3x now runs Plex instead of the old service, and my sister Ana lives in Austin';
    const convs = { console: [turn('console', user)] };
    const prompts: string[] = [];
    const brain: ExtractBrain = {
      generate: async (i) => {
        prompts.push(i.prompt);
        return {
          text: facts(
            { turn: 1, quote: 'My homelab node n3x now runs Plex', fact: "Will's homelab node n3x runs the Plex service.", supersedes: ['k3'] },
            { turn: 1, quote: 'runs Plex', fact: "Will's homelab streams media with Plex.", supersedes: ['k12'] },
            { turn: 1, quote: 'my sister Ana lives in Austin', fact: "Will's sister Ana lives in Austin.", supersedes: ['k5'] },
          ),
        };
      },
    };
    const ex = new MemoryExtractor(source(convs), k, brain, spath);
    expect(await ex.run()).toBe(3);
    // 160 facts, 150 shown: the teal one shares no word with the turn, so it isn't among them.
    expect(prompts[0]).not.toContain('k12: ');
    expect(prompts[0]).toContain('k3: ');
    expect(prompts[0]).toContain('k5: ');
    expect(prompts[0]).toContain('"supersedes": []');
    expect(prompts[0]).toContain('ids from KNOWN FACTS only');
    expect(ex.lastStats).toMatchObject({ stored: 3, superseded: 1, supersedeRefused: 2 });
    const active = new Set(k.all().map((f) => f.id));
    expect(active.has('k3')).toBe(false); // the real update
    expect(active.has('k12')).toBe(true); // never shown
    expect(active.has('k5')).toBe(true); // shown, but about something else
  });
});

describe('a quote must be whole words of Will’s, and his words must carry the claim', () => {
  it('holdsWords and factCoverage', () => {
    expect(holdsWords('my cardiologist is dr. patel', 'my card')).toBe(false);
    expect(holdsWords('my cardiologist is dr. patel', 'diologist is dr. patel')).toBe(false);
    expect(holdsWords('my cardiologist is dr. patel', 'my cardiologist')).toBe(true);
    expect(holdsWords("heads up - my team's the houston astros", 'my team')).toBe(true);
    expect(holdsWords('the astros', 'astros')).toBe(true);
    expect(holdsWords('anything', '')).toBe(false);
    expect(factCoverage(['is my Mac Studio fast enough'], "Will's Mac Studio has 192GB of unified memory.")).toBeCloseTo(0.4);
    expect(factCoverage(['I have a question about my car'], 'Will has a dog named Rex.')).toBe(0);
    expect(factCoverage(['Tell my friend Drew hi from me please'], 'Will has a friend named Drew.')).toBeCloseTo(2 / 3);
    expect(factCoverage(['My team is the Houston Astros'], "Will's favorite MLB team is the Houston Astros.")).toBeCloseTo(0.6);
    expect(factCoverage(['anything at all'], 'Will is.')).toBe(0); // no content words: nothing to ground
  });

  it('drops "my Mac Studio" grounding 192GB, "I have" grounding a dog named Rex, and a quote that starts mid-word; keeps the real ones', async () => {
    const convs = {
      console: [
        turn('console', 'is my Mac Studio fast enough for a 70B model?', 'Your Mac Studio has 192GB of unified memory, so yes.'),
        turn('console', 'I have a question about my car insurance renewal', 'Sure. Is this about your dog Rex too?'),
        turn('console', 'My cardiologist is Dr. Patel at Baylor', 'Noted.'),
        turn('console', 'My sister Ana lives in Austin and teaches piano', 'Lovely.'),
      ],
    };
    const { f } = fakeOllama(() =>
      chatReply(
        facts(
          { turn: 1, quote: 'my Mac Studio', fact: "Will's Mac Studio has 192GB of unified memory." },
          { turn: 2, quote: 'I have', fact: 'Will has a dog named Rex.' },
          { turn: 3, quote: 'diologist is Dr. Patel', fact: "Will's cardiologist is Dr. Patel at Baylor." },
          { turn: 3, quote: 'My cardiologist is Dr. Patel', fact: "Will's cardiologist is Dr. Patel at Baylor.", category: 'person' },
          { turn: 4, quote: 'my sister Ana lives in Austin', fact: "Will's sister Ana lives in Austin and teaches piano.", category: 'person' },
        ),
      ),
    );
    const k = new KnowledgeStore(kpath, downEmbedder);
    const ex = new MemoryExtractor(source(convs), k, localExtractBrain(LOCAL, { fetch: f }), spath);
    expect(await ex.run()).toBe(2);
    expect(ex.lastStats.rejected).toEqual({ ungrounded: 3 });
    expect(k.all().map((x) => x.text).sort()).toEqual(["Will's cardiologist is Dr. Patel at Baylor.", "Will's sister Ana lives in Austin and teaches piano."]);
    expect(k.all().find((x) => x.text.includes('Patel'))!.sourceAt).toBe(convs.console[2]!.updatedAt);
  });
});

describe('one batch that keeps failing can’t stall the rest', () => {
  it('an error the server answers with (500) is a strike: after 3 the batch is skipped, and a later conversation goes through', async () => {
    const convs = {
      a: [turn('a', 'This exact turn always crashes the runner somehow')],
      b: [turn('b', 'My sister Ana lives in Austin and teaches piano')],
    };
    const { f } = fakeOllama((seen) =>
      seen.body.messages[1]!.content.includes('crashes the runner')
        ? new Response('{"error":"llama runner process has terminated"}', { status: 500 })
        : chatReply(facts({ turn: 1, quote: 'my sister Ana lives in Austin', fact: "Will's sister Ana lives in Austin." })),
    );
    const k = new KnowledgeStore(kpath, downEmbedder);
    const ex = new MemoryExtractor(source(convs), k, localExtractBrain(LOCAL, { fetch: f }), spath, { batchChars: 1, backlogEveryMs: 60_000, everyMs: 3_600_000 });
    await ex.run();
    expect(state().failures).toEqual({ key: `a@${convs.a[0]!.updatedAt}`, count: 1 });
    expect(ex.nextDelayMs).toBe(60_000); // backed off
    await ex.run();
    expect(watermark('a')).toBeUndefined();
    await ex.run(); // the third strike: skipped
    expect(watermark('a')).toBeDefined();
    expect(state().failures).toBeUndefined();
    expect(watermark('b')).toBeUndefined(); // that pass stopped there
    await ex.run();
    expect(watermark('b')).toBeDefined();
    expect(k.all().map((x) => x.text)).toEqual(["Will's sister Ana lives in Austin."]);
    expect(state().budget.calls).toBe(4); // the server answered each time: they count
  });

  it('a 404 (the model isn’t pulled) is no strike: the turns wait as long as it takes, at none of the day’s calls', async () => {
    const { f } = fakeOllama(() => new Response('{"error":"model not found"}', { status: 404 }));
    const convs = { console: [turn('console', 'My dog is named Biscuit and she is a corgi')] };
    const ex = new MemoryExtractor(source(convs), new KnowledgeStore(kpath, downEmbedder), localExtractBrain(LOCAL, { fetch: f }), spath);
    for (let i = 0; i < 10; i++) await ex.run();
    expect(watermark('console')).toBeUndefined();
    expect(state().failures).toBeUndefined();
    expect(state().budget.calls).toBe(0);
  });
});

describe('a reply cut off at its token limit', () => {
  const turnsIn = (seen: Seen) => (seen.body.messages[1]!.content.match(/### Turn \d+/g) ?? []).length;

  it('is asked again with half the turns, which then go through: no strike', async () => {
    const convs: Record<string, Turn[]> = {};
    for (let i = 0; i < 4; i++) convs[`c${i}`] = [turn(`c${i}`, `Distinct durable statement number ${i} about Will's projects`)];
    const { f, requests } = fakeOllama((seen) => (turnsIn(seen) > 2 ? chatReply('{"facts": [{"turn": 1, "quote": "Distin', 'length') : chatReply(facts())));
    const ex = new MemoryExtractor(source(convs), new KnowledgeStore(kpath, downEmbedder), localExtractBrain(LOCAL, { fetch: f }), spath);
    await ex.run();
    expect(requests.map(turnsIn)).toEqual([4, 2, 2]);
    for (let i = 0; i < 4; i++) expect(watermark(`c${i}`)).toBeDefined();
    expect(state().failures).toBeUndefined();
    expect(state().budget.calls).toBe(3); // the model worked on each
    expect(ex.lastStats).toMatchObject({ truncated: 1, turnsSent: 4, unparseable: 0 });
  });

  it('a single turn still cut off is a strike, and is skipped after 3', async () => {
    const { f, requests } = fakeOllama(() => chatReply('{"facts": [{"turn": 1, "quote": "My dog', 'length'));
    const convs = { console: [turn('console', 'My dog is named Biscuit and she is a corgi')] };
    const ex = new MemoryExtractor(source(convs), new KnowledgeStore(kpath, downEmbedder), localExtractBrain(LOCAL, { fetch: f }), spath);
    await ex.run();
    expect(state().failures).toEqual({ key: `console@${convs.console[0]!.updatedAt}`, count: 1 });
    expect(watermark('console')).toBeUndefined();
    await ex.run();
    await ex.run();
    expect(watermark('console')).toBeDefined();
    expect(requests).toHaveLength(3);
    expect(state().totals.truncated).toBe(3);
  });
});

describe('cheap checks come first', () => {
  it('reads no history while the spend gate is closed or Will is chatting', async () => {
    let reads = 0;
    const src: TurnSource = {
      conversationIds: () => ['c'],
      getTurns: async () => {
        reads++;
        return [turn('c', 'My sister Ana lives in Austin and teaches piano')];
      },
    };
    let chatting = true;
    let paused: string | undefined;
    const { f } = fakeOllama(() => chatReply(facts()));
    const ex = new MemoryExtractor(src, new KnowledgeStore(kpath, downEmbedder), localExtractBrain(LOCAL, { fetch: f }), spath, {
      chatActive: () => chatting,
      gate: () => paused,
    });
    await ex.run();
    expect(reads).toBe(0);
    chatting = false;
    paused = 'at 80% of the cap';
    await ex.run();
    expect(reads).toBe(0);
    paused = undefined;
    await ex.run();
    expect(reads).toBe(1);
  });

  it('reads no history once the day’s calls are spent', async () => {
    let reads = 0;
    let n = 0;
    const src: TurnSource = {
      conversationIds: () => ['c'],
      getTurns: async () => {
        reads++;
        return [turn('c', `Distinct durable statement number ${n++} about Will's projects`)];
      },
    };
    const { f } = fakeOllama(() => chatReply(facts()));
    const ex = new MemoryExtractor(src, new KnowledgeStore(kpath, downEmbedder), localExtractBrain(LOCAL, { fetch: f }), spath, { maxCallsPerDay: 1 });
    await ex.run();
    expect(reads).toBe(1);
    expect(state().budget.calls).toBe(1);
    await ex.run();
    await ex.run();
    expect(reads).toBe(1);
  });
});

describe('errorKind', () => {
  it('carries a kind and a code, never the message or the stack (even a message line that looks like a frame)', () => {
    const e = new Error('Zephyr leak\n    at Will told me his sister Zephyrina lives in Zephyrville (x.ts:1:1)');
    expect(e.stack).toContain('Zephyrina'); // the stack does hold it
    expect(errorKind(e)).toBe('Error');
    expect(errorKind(Object.assign(new Error('Zephyr'), { code: 'ECONNREFUSED' }))).toBe('Error ECONNREFUSED');
    expect(errorKind({ kind: 'provider_unavailable', error: { providerCode: '503' }, message: 'Zephyr' })).toBe('provider_unavailable 503');
    expect(errorKind(Object.assign(new Error('x'), { name: 'Zephyr name\n  at secret', code: 'Zephyr code with spaces' }))).not.toMatch(/\s{2}|\n/);
    expect(errorKind('Zephyr as a string')).toBe('error');
    expect(errorKind(null)).toBe('error');
  });
});

describe('an outage costs at most a turn at a time', () => {
  const turnsIn = (seen: Seen) => (seen.body.messages[1]!.content.match(/### Turn \d+/g) ?? []).length;
  const thirty = () => {
    const convs: Record<string, Turn[]> = {};
    for (let i = 0; i < 30; i++) convs[`c${String(i).padStart(2, '0')}`] = [turn(`c${String(i).padStart(2, '0')}`, `Distinct durable statement number ${i} about Will's projects`)];
    return convs;
  };

  it('a 503 (Ollama busy) is no strike: nothing is skipped and none of the day is spent, however long it lasts', async () => {
    const { f } = fakeOllama(() => new Response('{"error":"server busy, please try again.  maximum pending requests exceeded"}', { status: 503 }));
    const ex = new MemoryExtractor(source(thirty()), new KnowledgeStore(kpath, downEmbedder), localExtractBrain(LOCAL, { fetch: f }), spath);
    for (let i = 0; i < 20; i++) await ex.run();
    expect(Object.keys(state().watermarks)).toEqual([]);
    expect(state().failures).toBeUndefined();
    expect(state().budget.calls).toBe(0);
  });

  it('500 on every request: 3 strikes halve the batch, and only a single turn is ever skipped', async () => {
    const { f, requests } = fakeOllama(() => new Response('{"error":"model requires more system memory than is available"}', { status: 500 }));
    const ex = new MemoryExtractor(source(thirty()), new KnowledgeStore(kpath, downEmbedder), localExtractBrain(LOCAL, { fetch: f }), spath);
    for (let i = 0; i < 15; i++) await ex.run();
    expect(requests.map(turnsIn)).toEqual([30, 30, 30, 15, 15, 15, 7, 7, 7, 3, 3, 3, 1, 1, 1]);
    // Fifteen failing passes, one turn lost: the oldest, alone.
    expect(Object.keys(state().watermarks)).toEqual(['c00']);
    expect(state().failures).toBeUndefined(); // the next batch starts with a clean slate
    expect(state().budget.calls).toBe(15); // the server answered each time
  });

  it('a halved batch that then goes through takes its turns, and the rest follow', async () => {
    let fail = 3; // three 500s, then the server recovers
    const { f, requests } = fakeOllama(() => (fail-- > 0 ? new Response('{"error":"runner crashed"}', { status: 500 }) : chatReply(facts())));
    const convs: Record<string, Turn[]> = {};
    for (let i = 0; i < 4; i++) convs[`c${i}`] = [turn(`c${i}`, `Distinct durable statement number ${i} about Will's projects`)];
    const ex = new MemoryExtractor(source(convs), new KnowledgeStore(kpath, downEmbedder), localExtractBrain(LOCAL, { fetch: f }), spath);
    for (let i = 0; i < 4; i++) await ex.run();
    expect(requests.map(turnsIn)).toEqual([4, 4, 4, 2, 2]);
    for (let i = 0; i < 4; i++) expect(watermark(`c${i}`)).toBeDefined();
    expect(state().failures).toBeUndefined();
  });
});

describe('a cut-off reply halves the batch for the rest of the pass', () => {
  it('8 dense turns take 6 calls, not one full-size retry after every success', async () => {
    const turnsIn = (seen: Seen) => (seen.body.messages[1]!.content.match(/### Turn \d+/g) ?? []).length;
    const convs: Record<string, Turn[]> = {};
    for (let i = 0; i < 8; i++) convs[`c${i}`] = [turn(`c${i}`, `Distinct durable statement number ${i} about Will's projects`)];
    const { f, requests } = fakeOllama((seen) => (turnsIn(seen) > 2 ? chatReply('{"facts": [{"turn": 1, "quote": "Dist', 'length') : chatReply(facts())));
    const ex = new MemoryExtractor(source(convs), new KnowledgeStore(kpath, downEmbedder), localExtractBrain(LOCAL, { fetch: f }), spath);
    await ex.run();
    expect(requests.map(turnsIn)).toEqual([8, 4, 2, 2, 2, 2]);
    expect(state().budget.calls).toBe(6);
    for (let i = 0; i < 8; i++) expect(watermark(`c${i}`)).toBeDefined();
  });
});

describe('every number in a fact must be one Will gave, or the turn’s date', () => {
  const sept21 = Date.UTC(2026, 8, 21, 15);
  it('rejects numbers the model filled in', () => {
    expect(numbersGrounded(['is my Mac Studio fast enough'], "Will's Mac Studio has 192GB.", sept21)).toBe(false);
    expect(numbersGrounded(['my Mac Studio arrived'], "Will's Mac Studio arrived on October 3.", sept21)).toBe(false);
    expect(numbersGrounded(['my daughter Mia starts school soon'], "Will's daughter Mia is 6.", sept21)).toBe(false);
    // Only the turn's year vouches for a number, never its month or day (September 21).
    expect(numbersGrounded(['my daughter Mia starts school soon'], "Will's daughter Mia is 9.", sept21)).toBe(false);
    expect(numbersGrounded(['my daughter Mia starts school soon'], "Will's daughter Mia is 21.", sept21)).toBe(false);
    // Coverage alone would pass these: the quote is his, and so are most of the words.
    expect(factCoverage(['is my Mac Studio fast enough'], "Will's Mac Studio has 192GB.")).toBeGreaterThanOrEqual(0.5);
    expect(factCoverage(['my daughter Mia starts school soon'], "Will's daughter Mia is 6.")).toBe(1);
    const turns = [{ will: ['my daughter Mia starts school soon'], assistant: ['How old is she, 6?'], at: sept21 }];
    expect(locateQuote('my daughter Mia', turns, 1, "Will's daughter Mia is 6.")).toBe('ungrounded');
  });

  it('keeps numbers he gave, however they are written, and the year from the turn’s date', () => {
    expect(numbersGrounded(['The Mac Studio is scheduled to arrive September 25 to October 3'], "Will's Mac Studio is scheduled to be delivered September 25 - October 3, 2026.", sept21)).toBe(true);
    expect(numbersGrounded(["I'm buying a Mac Studio in August"], 'Will is buying a Mac Studio in August 2026.', sept21)).toBe(true);
    expect(numbersGrounded(['the GPU cost me 1200 dollars'], "Will's GPU cost $1,200.", sept21)).toBe(true);
    expect(numbersGrounded(['it cost $1,200 in the end'], "Will's GPU cost 1200 dollars.", sept21)).toBe(true);
    expect(numbersGrounded(['my surgery is on 9/14'], "Will's surgery is scheduled for 09/14.", sept21)).toBe(true);
    expect(numbersGrounded(['can my Mac run a 70B model'], 'Will wants to run a 70B model on his Mac.', sept21)).toBe(true);
    expect(numbersGrounded(['anything'], 'A fact with no numbers in it.')).toBe(true);
    // Without the date, a year he didn't say is not his.
    expect(numbersGrounded(["I'm buying a Mac Studio in August"], 'Will is buying a Mac Studio in August 2026.')).toBe(false);
  });

  it('end to end: a filled-in number drops the fact', async () => {
    const convs = { console: [turn('console', 'my daughter Mia starts school soon and I am nervous', 'How exciting! Is she 6?')] };
    const { f } = fakeOllama(() =>
      chatReply(facts({ turn: 1, quote: 'my daughter Mia starts school soon', fact: "Will's daughter Mia is 6.", category: 'person' }, { turn: 1, quote: 'my daughter Mia', fact: "Will's daughter is named Mia.", category: 'person' })),
    );
    const k = new KnowledgeStore(kpath, downEmbedder);
    const ex = new MemoryExtractor(source(convs), k, localExtractBrain(LOCAL, { fetch: f }), spath);
    expect(await ex.run()).toBe(1);
    expect(k.all().map((x) => x.text)).toEqual(["Will's daughter is named Mia."]);
    expect(ex.lastStats.rejected).toEqual({ ungrounded: 1 });
  });
});

describe('a supersede needs two shared content words, or one between two short facts', () => {
  it('one shared word is not the same thing between longer facts; two are, and so is one between short ones', async () => {
    expect(sharesContent('Will works from home on Fridays.', "Will's sister Ana works as a nurse.")).toBe(false);
    expect(sharesContent('Will owns a Mac Studio.', 'Will owns a Tesla.')).toBe(false);
    expect(sharesContent('Will is buying a Mac Studio around August 2026.', "Will's Mac Studio is scheduled to be delivered September 25 - October 3, 2026.")).toBe(true);
    expect(sharesContent('Will lives in Dallas.', 'Will lives in Austin.')).toBe(true);
    expect(sharesContent('Will works at Acme.', 'Will works at Globex.')).toBe(true);
    expect(sharesContent('Will lives in Dallas.', 'Will owns a Tesla.')).toBe(false);
    const k = new KnowledgeStore(kpath, downEmbedder);
    await k.add('Will works from home on Fridays.', 'user', { sourceAt: 1 });
    const convs = { console: [turn('console', 'my sister Ana works as a nurse in Dallas now')] };
    const { f } = fakeOllama(() => chatReply(facts({ turn: 1, quote: 'my sister Ana works as a nurse', fact: "Will's sister Ana works as a nurse.", supersedes: ['k1'] })));
    const ex = new MemoryExtractor(source(convs), k, localExtractBrain(LOCAL, { fetch: f }), spath);
    expect(await ex.run()).toBe(1);
    expect(ex.lastStats).toMatchObject({ superseded: 0, supersedeRefused: 1 });
    expect(k.all().map((x) => x.id)).toContain('k1');
  });

  it('end to end: Dallas → Austin replaces the old fact', async () => {
    const k = new KnowledgeStore(kpath, downEmbedder);
    await k.add('Will lives in Dallas.', 'user', { sourceAt: 1 });
    const convs = { console: [turn('console', 'I moved last month, I live in Austin now')] };
    const { f } = fakeOllama(() => chatReply(facts({ turn: 1, quote: 'I live in Austin', fact: 'Will lives in Austin.', supersedes: ['k1'] })));
    const ex = new MemoryExtractor(source(convs), k, localExtractBrain(LOCAL, { fetch: f }), spath);
    expect(await ex.run()).toBe(1);
    expect(ex.lastStats).toMatchObject({ superseded: 1, supersedeRefused: 0 });
    expect(k.all().map((x) => x.text)).toEqual(['Will lives in Austin.']);
  });
});

describe('clipping never splits a character', () => {
  it('cuts by code points: an emoji at the edge goes whole or not at all', async () => {
    const user = `${'x'.repeat(1499)}😀😀 and my sister Ana lives in Austin`;
    const convs = { console: [turn('console', `${'y'.repeat(299)}🎉🎉 my brother Theo lives in Portland`), turn('console', user)] };
    const { f, requests } = fakeOllama(() => chatReply(facts()));
    await new MemoryExtractor(source(convs), new KnowledgeStore(kpath, downEmbedder), localExtractBrain(LOCAL, { fetch: f }), spath).run();
    const content = requests[0]!.body.messages[1]!.content;
    expect(content).toContain(`${'x'.repeat(1499)}😀…`); // the turn, at 1,500 code points
    expect(content).toContain(`${'y'.repeat(299)}🎉…`); // the previous turn as context, at 300
    expect(content).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });
});

describe('the frontier, opted in', () => {
  const failing = (code: string) =>
    frontierExtractBrain(async () => {
      throw new FlintError({ kind: code.startsWith('4') ? 'validation' : 'provider_unavailable', message: 'Zephyr: prompt is too long', retryable: false, providerCode: code });
    });

  it('a 4xx other than 404 and 429 is the request’s fault: a strike, not an outage to wait out forever', async () => {
    await expect(failing('400').generate({ system: 's', prompt: 'p' })).rejects.toMatchObject({ why: 'server-error', detail: 'validation 400' });
    await expect(failing('413').generate({ system: 's', prompt: 'p' })).rejects.toMatchObject({ why: 'server-error' });
    // An expired key, no permission, an unknown model, too many requests, or a 5xx: the
    // account can't be served right now, whatever is asked. The extractor reads them as unavailable.
    for (const code of ['401', '403', '404', '429', '500', '529']) {
      const err = await failing(code).generate({ system: 's', prompt: 'p' }).catch((e: unknown) => e);
      expect(err, code).toBeInstanceOf(FlintError);
    }
    // Anthropic says "credit balance is too low" with a plain 400: an outage too, told apart by its words.
    const broke = frontierExtractBrain(async () => {
      throw new FlintError({
        kind: 'validation',
        message: '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}',
        retryable: false,
        providerCode: '400',
      });
    });
    expect(await broke.generate({ system: 's', prompt: 'p' }).catch((e: unknown) => e)).toBeInstanceOf(FlintError);
    const convs0 = { console: [turn('console', 'My dog is named Biscuit and she is a corgi')] };
    const ex0 = new MemoryExtractor(source(convs0), new KnowledgeStore(join(dir, 'k0.json'), downEmbedder), broke, join(dir, 's0.json'), { kind: 'frontier' });
    for (let i = 0; i < 5; i++) await ex0.run();
    expect(JSON.parse(readFileSync(join(dir, 's0.json'), 'utf8'))).toMatchObject({ watermarks: {}, budget: { calls: 0 } });
    expect(JSON.parse(readFileSync(join(dir, 's0.json'), 'utf8')).failures).toBeUndefined();
    const convs = { console: [turn('console', 'My dog is named Biscuit and she is a corgi')] };
    const ex = new MemoryExtractor(source(convs), new KnowledgeStore(kpath, downEmbedder), failing('400'), spath, { kind: 'frontier' });
    for (let i = 0; i < 3; i++) await ex.run();
    expect(watermark('console')).toBeDefined(); // a single turn, three strikes: skipped
    expect(state().budget.calls).toBe(3);
    const ex2 = new MemoryExtractor(source(convs), new KnowledgeStore(join(dir, 'k2.json'), downEmbedder), failing('529'), join(dir, 's2.json'), { kind: 'frontier' });
    for (let i = 0; i < 5; i++) await ex2.run();
    expect(JSON.parse(readFileSync(join(dir, 's2.json'), 'utf8'))).toMatchObject({ watermarks: {}, budget: { calls: 0 } });
  });
});

describe('turns are read in time order', () => {
  it('a turn stored after a later one (another device, a double send) is still sent', async () => {
    const mk = (id: string, user: string, at: number): Turn => ({
      id,
      conversationId: 'console',
      status: 'complete',
      createdAt: at,
      updatedAt: at,
      messages: [
        { id: `u${id}`, role: 'user', content: user, timestamp: at },
        { id: `a${id}`, role: 'assistant', content: 'ok', timestamp: at },
      ],
    });
    // Stored later-first: the turn finished at 2e12 landed after the one at 3e12.
    const convs = { console: [mk('t3', 'My sister Ana lives in Austin and teaches piano', 3e12), mk('t2', 'My brother Theo lives in Portland and bakes bread', 2e12)] };
    const prompts: string[] = [];
    const brain: ExtractBrain = { generate: async (i) => (prompts.push(i.prompt), { text: '{"facts": []}' }) };
    const ex = new MemoryExtractor(source(convs), new KnowledgeStore(kpath, downEmbedder), brain, spath, { maxTurnsPerPass: 1 });
    await ex.run();
    await ex.run();
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain('Theo');
    expect(prompts[1]).toContain('Ana');
    expect(watermark('console')).toBe(3e12);
  });
});

describe('the state file is checked as it is read', () => {
  it('drops what does not fit, never the pass', async () => {
    const { writeFileSync } = await import('node:fs');
    const convs = { a: [turn('a', 'My sister Ana lives in Austin and teaches piano')], b: [turn('b', 'My brother Theo lives in Portland and bakes bread')] };
    writeFileSync(
      spath,
      JSON.stringify({
        version: 2,
        watermarks: { a: 'soon', b: convs.b[0]!.updatedAt, c: null, d: [5] },
        budget: { day: new Date().toISOString().slice(0, 10), calls: 'lots' },
        totals: { calls: 'many', stored: 3, rejected: { duplicate: 2, junk: 'x' } },
        failures: { key: 7, count: 'two' },
      }),
    );
    const prompts: string[] = [];
    const brain: ExtractBrain = { generate: async (i) => (prompts.push(i.prompt), { text: '{"facts": []}' }) };
    const ex = new MemoryExtractor(source(convs), new KnowledgeStore(kpath, downEmbedder), brain, spath);
    await ex.run();
    // a's watermark was junk, so a is read; b's was a time, so b stays done.
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('Ana');
    expect(prompts[0]).not.toContain('Theo');
    const s = state();
    expect(Object.keys(s.watermarks).sort()).toEqual(['a', 'b']);
    expect(s.budget.calls).toBe(1); // the junk count started over
    expect(s.totals).toMatchObject({ calls: 1, stored: 3, rejected: { duplicate: 2 } });
    expect(s.totals.rejected.junk).toBeUndefined();
  });
});
