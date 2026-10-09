/**
 * Memory extraction on the local model (./memory-brain + ./memory-extract):
 * local by default with no API key, the frontier only when Will opts in, a
 * pass that yields to his chat, facts grounded in a quote of his own words, a
 * failed or invalid reply that keeps the watermark, and logs with no
 * transcript in them. Every model is a fake: no network.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Turn } from '@flint/core';
import { KnowledgeStore } from '../src/knowledge';
import { ChatLoad } from '../src/chat-load';
import { liveOllamaOptions } from '../src/local-model';
import {
  MemoryExtractor,
  MemoryBrainError,
  FACTS_SCHEMA,
  factsReply,
  locateQuote,
  normalizeQuoteText,
  quoteNeedle,
  type ExtractBrain,
  type TurnSource,
} from '../src/memory-extract';
import {
  MEMORY_CHAT_QUIET_MS,
  MEMORY_MODEL_REQUESTS,
  chooseMemoryBrain,
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

const LOCAL: LocalMemoryModel = { baseURL: 'http://127.0.0.1:11434', model: 'muse-glimmer:30b', numCtx: 8192 };

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
    expect(plan.model).toEqual({ baseURL: 'http://127.0.0.1:11434', model: 'muse-glimmer:30b', numCtx: 4096 });
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

  it("uses the chat brain's host and num_ctx, so Ollama never reloads the model between them", () => {
    const env = { OLLAMA_MODEL: 'muse-glimmer:30b', OLLAMA_HOST: 'http://127.0.0.1:11434/', OLLAMA_NUM_CTX: '16384' };
    const m = localMemoryModel(env, () => {})!;
    expect(m.numCtx).toBe(liveOllamaOptions(env).defaultOptions!.num_ctx);
    expect(m.baseURL).toBe('http://127.0.0.1:11434');
    // Unset: the chat brain's default, 4096.
    expect(localMemoryModel({ OLLAMA_MODEL: 'muse-glimmer:30b' }, () => {})!.numCtx).toBe(4096);
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
    expect(JSON.parse(out.text)).toEqual({ facts: [{ turn: 1, quote: 'my dog Biscuit', fact: "Will's dog is named Biscuit.", category: 'other', supersedes: [] }] });
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

  it('a reply that is not the schema is invalid, after at most two requests', async () => {
    for (const bad of ['not json at all', '{"facts": "nope"}', '{"facts": [{"fact": "Will has a dog."}]}', '[]']) {
      const { f, requests } = fakeOllama(() => chatReply(bad));
      const err = await localExtractBrain(LOCAL, { fetch: f }).generate({ system: 's', prompt: 'p' }).catch((e: unknown) => e);
      expect(err, bad).toBeInstanceOf(MemoryBrainError);
      expect((err as MemoryBrainError).why, bad).toBe('invalid');
      expect(requests.length, bad).toBe(MEMORY_MODEL_REQUESTS);
    }
  });

  it('a reply cut off at its token limit is invalid too', async () => {
    const { f } = fakeOllama(() => chatReply('{"facts": [{"turn": 1, "quote": "my dog', 'length'));
    await expect(localExtractBrain(LOCAL, { fetch: f }).generate({ system: 's', prompt: 'p' })).rejects.toMatchObject({ why: 'invalid' });
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

  it('a timeout keeps it, and counts the call', async () => {
    const { f } = fakeOllama((seen) => hang(seen));
    const convs = { console: [turn('console', 'My dog is named Biscuit and she is a corgi')] };
    const ex = new MemoryExtractor(source(convs), new KnowledgeStore(kpath, downEmbedder), localExtractBrain(LOCAL, { fetch: f, timeoutMs: 30 }), spath);
    await ex.run();
    expect(watermark('console')).toBeUndefined();
    expect(state().budget.calls).toBe(1);
    expect(ex.lastStats).toMatchObject({ failed: 1, unparseable: 0 });
    expect(state().failures).toBeUndefined(); // no strike against the batch
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

  it('a reply with no quote at all (a v1-style string) is not trusted', async () => {
    const convs = { console: [turn('console', 'My sister Ana lives in Austin and teaches piano')] };
    const brain: ExtractBrain = { generate: async () => ({ text: JSON.stringify(["Will's sister Ana lives in Austin."]) }) };
    const k = new KnowledgeStore(kpath, downEmbedder);
    const ex = new MemoryExtractor(source(convs), k, brain, spath);
    await ex.run();
    expect(k.all()).toHaveLength(0);
    expect(ex.lastStats.rejected).toEqual({ ungrounded: 1 });
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
