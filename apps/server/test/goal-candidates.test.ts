/**
 * Goals and commitments from chat, from the server to the runtime (P3 part 5).
 *
 *  - The client: one POST to the runtime's /v1/goals/candidates with the
 *    server's token, 5 s at most. With the runtime down, slow, or answering an
 *    error, the suggestion is dropped and counted: nothing is written to disk
 *    to wait (no spool), and nothing is retried. A runtime that is not on this
 *    Mac is sent nothing.
 *  - The settings: FLINT_EXTRACT_CANDIDATES=1 turns goals on, and
 *    FLINT_EXTRACT_COMMITMENTS=1 commitments as well. Only for a model on this
 *    Mac, by the server's own locality rule, asked at every pass: a
 *    cloud-backed name or an Ollama on another machine is asked for facts
 *    alone, files nothing, and the log says the feature is waiting. Off, or on
 *    the frontier, the extractor is given nothing and no call is made.
 *  - The whole path, with stubs on real sockets: a turn answered with Will's
 *    goals is mined by the local model and its suggestion reaches the runtime;
 *    nothing about it reaches a stub that speaks Anthropic's wire. With the
 *    extractor on the frontier, that turn is never sent anywhere, no turn's
 *    prompt asks for suggestions, and the runtime is told nothing.
 *  - No tool reaches any of it: no built-in and no runtime-connector tool is
 *    named for either action or calls the route, and a tool call that names
 *    one is refused at the gate without a proposal, a spool file or a request.
 * Synthetic text only.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AnthropicProvider, Flint, type Tool } from '@flint/core';
import { CHAT_SUGGESTION_ACTIONS, ChatCandidate } from '@flint/policy';
import { ActionQueue } from '../src/actions';
import { calculateTool } from '../src/calculate';
import { deepResearchTool } from '../src/deep-research';
import { GoalCandidates, WAITING, candidateOptions, candidatesSetting, commitmentsSetting, serverZone } from '../src/goal-candidates';
import { GoalsChat } from '../src/goals-chat';
import { GOALS_TURN } from '../src/goals-now';
import { KnowledgeStore, rememberTool } from '../src/knowledge';
import { chooseMemoryBrain, frontierExtractBrain } from '../src/memory-brain';
import { MemoryExtractor, SUGGEST_GOALS_PROMPT, SUGGEST_PROMPT, type ChatSuggestion } from '../src/memory-extract';
import { isSafeTool } from '../src/policy';
import { RuntimeProposals } from '../src/runtime-proposals';
import { gateBuiltins, type TierEvent } from '../src/tier-gate';
import { withTurnTaint } from '../src/turn-taint';
import { HERE, cleanup, listed, storedTurn, tmpStore } from './goals-mini';

const CANARY = 'CANARY-p3wire';
const TOKEN = 'c'.repeat(64);
const downEmbedder = { embed: async () => { throw new Error('ollama down'); } } as unknown as ConstructorParameters<typeof KnowledgeStore>[1];

const suggestion = (over: Partial<ChatSuggestion> = {}): ChatSuggestion => ({
  kind: 'goal', text: 'run a half marathon', quote: `${CANARY} I want to run a half marathon by spring`, conversationId: 'console-1', turnId: 'turn_1',
  sourceAt: Date.UTC(2026, 9, 12, 15, 0, 0), staysHere: false, ...over,
});

/** A stub on a real socket that keeps every request it is sent. */
async function stub(answer: (req: IncomingMessage, body: string) => { status: number; body: unknown }): Promise<{ url: string; requests: Array<{ method: string; path: string; auth: string; body: string }>; close: () => Promise<void>; server: Server }> {
  const requests: Array<{ method: string; path: string; auth: string; body: string }> = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += String(c)));
    req.on('end', () => {
      requests.push({ method: req.method ?? '', path: req.url ?? '', auth: String(req.headers.authorization ?? req.headers['x-api-key'] ?? ''), body });
      const a = answer(req, body);
      res.writeHead(a.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(a.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, requests, server, close: () => new Promise<void>((r) => server.close(() => r())) };
}

describe('the candidates client', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'flint-cand-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const client = (fetchImpl: typeof fetch, url = 'http://[::1]:8090', timeoutMs?: number) =>
    new GoalCandidates({ runtime: () => ({ url, token: TOKEN }), fetchImpl, ...(timeoutMs ? { timeoutMs } : {}) });
  const answering = (status: number, body: unknown) => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const f = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
    }) as unknown as typeof fetch;
    return { f, calls };
  };

  it('one POST to the runtime’s candidates route, with the server’s token and exactly the contract’s body', async () => {
    const { f, calls } = answering(201, { outcome: 'filed' });
    const c = client(f);
    expect(await c.file(suggestion({ dueOn: '2027-03-20', staysHere: true }))).toBe('filed');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://[::1]:8090/v1/goals/candidates');
    expect(calls[0]!.init).toMatchObject({ method: 'POST', redirect: 'error', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' } });
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body).toEqual({ kind: 'goal', text: 'run a half marathon', quote: `${CANARY} I want to run a half marathon by spring`, dueOn: '2027-03-20', conversationId: 'console-1', turnId: 'turn_1', sourceAt: '2026-10-12T15:00:00.000Z' });
    expect(ChatCandidate.safeParse(body).success).toBe(true);
    expect(c.counts).toMatchObject({ filed: 1 });
  });

  it('what the runtime answered, as a word: added is filed, known is known, 429 is capped, 4xx is refused, anything else did not answer', async () => {
    const cases: Array<[number, unknown, string]> = [
      [201, { outcome: 'added' }, 'filed'], [200, { outcome: 'known' }, 'known'], [429, { error: 'x', code: 'suggestionCap' }, 'capped'],
      [400, { error: 'x', code: 'suggestionInvalid' }, 'refused'], [409, { error: 'forbidden' }, 'refused'], [413, {}, 'refused'],
      [500, { error: 'internal error' }, 'unreachable'], [503, {}, 'unreachable'], [401, { error: 'unauthorized' }, 'unreachable'], [403, {}, 'unreachable'], [404, {}, 'unreachable'],
      [200, 'not json', 'unreachable'], [200, { outcome: 'something else' }, 'unreachable'], [200, { ok: true }, 'unreachable'],
    ];
    const c = client((async () => new Response('{}')) as unknown as typeof fetch);
    for (const [status, body, want] of cases) {
      const { f } = answering(status, body);
      expect(await new GoalCandidates({ runtime: () => ({ url: 'http://127.0.0.1:8090', token: TOKEN }), fetchImpl: f }).file(suggestion()), `${status}`).toBe(want);
    }
    expect(c.counts).toEqual({ filed: 0, known: 0, refused: 0, capped: 0, unreachable: 0, held: 0 });
  });

  it('the runtime down, or slow: dropped and counted, never written to disk to wait, never retried', async () => {
    const home = process.env.HOME;
    process.env.HOME = dir;
    try {
      let n = 0;
      const refusedConnection = (async () => {
        n += 1;
        throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
      }) as unknown as typeof fetch;
      const down = client(refusedConnection);
      expect(await down.file(suggestion())).toBe('unreachable');
      expect(n).toBe(1);
      // A real closed port, too.
      const closed = await stub(() => ({ status: 200, body: {} }));
      await closed.close();
      expect(await new GoalCandidates({ runtime: () => ({ url: closed.url, token: TOKEN }) }).file(suggestion())).toBe('unreachable');
      // Slow: given up on at the timeout, once.
      let started = 0;
      const never = ((_u: string, init: RequestInit) => new Promise((_res, rej) => {
        started += 1;
        init.signal?.addEventListener('abort', () => rej(init.signal!.reason));
      })) as unknown as typeof fetch;
      const slow = client(never, 'http://[::1]:8090', 30);
      expect(await slow.file(suggestion())).toBe('unreachable');
      expect(started).toBe(1);
      expect(down.counts.unreachable + slow.counts.unreachable).toBe(2);
      // Nothing waits on disk: no spool, no file of any kind, anywhere under the home folder.
      expect(readdirSync(dir)).toEqual([]);
      expect(existsSync(join(dir, '.flint'))).toBe(false);
    } finally {
      process.env.HOME = home;
    }
    // The module cannot write one: it never opens a file.
    const source = readFileSync(join(__dirname, '..', 'src', 'goal-candidates.ts'), 'utf8');
    expect(source).not.toMatch(/node:fs|writeFile|appendFile|mkdir/);
    // What it imports: the contract, the runtime link's type, the extractor's types and the locality rules. No file, no spool.
    expect([...source.matchAll(/from '([^']+)'/g)].map((m) => m[1])).toEqual(['@flint/policy', './audit-sink', './memory-extract', './policy']);
  });

  it('only to a runtime on this Mac, and only what the runtime could take: otherwise no request is made', async () => {
    const { f, calls } = answering(201, { outcome: 'filed' });
    for (const url of ['http://10.0.0.5:8090', 'https://runtime.example.com', 'http://127.0.0.1.example.com:8090', 'http://studio.tailnet.ts.net:8090']) {
      const c = client(f, url);
      expect(await c.file(suggestion()), url).toBe('held');
      expect(await c.file(suggestion({ staysHere: true })), url).toBe('held');
      expect(c.counts.held).toBe(2);
    }
    // No runtime installed.
    expect(await new GoalCandidates({ runtime: () => undefined, fetchImpl: f }).file(suggestion())).toBe('unreachable');
    // An id the runtime does not name a turn by, or a time that is not one: refused here.
    const c = client(f);
    expect(await c.file(suggestion({ conversationId: 'voice chat' }))).toBe('refused');
    expect(await c.file(suggestion({ turnId: 't/1' }))).toBe('refused');
    expect(await c.file(suggestion({ sourceAt: Number.NaN })).catch(() => 'threw')).toBe('threw');
    expect(await c.file(suggestion({ quote: 'too short' }))).toBe('refused');
    expect(calls).toEqual([]);
    // On this Mac, by any of its names.
    for (const url of ['http://[::1]:8090', 'http://127.0.0.1:8090', 'http://localhost:8090']) expect(await client(f, url).file(suggestion())).toBe('filed');
    expect(calls).toHaveLength(3);
  });
});

describe('FLINT_EXTRACT_CANDIDATES', () => {
  it('is on only as "1": unset, blank and "0" are off quietly, and any other word is off and said once', () => {
    const logs: string[] = [];
    const log = (m: string) => void logs.push(m);
    expect(candidatesSetting({ FLINT_EXTRACT_CANDIDATES: '1' }, log)).toBe(true);
    expect(candidatesSetting({ FLINT_EXTRACT_CANDIDATES: ' 1 ' }, log)).toBe(true);
    for (const v of [undefined, '', '0', ' 0 ']) expect(candidatesSetting({ FLINT_EXTRACT_CANDIDATES: v }, log)).toBe(false);
    expect(logs).toEqual([]);
    for (const v of ['on', 'true', 'yes', '2', 'ON']) expect(candidatesSetting({ FLINT_EXTRACT_CANDIDATES: v }, log)).toBe(false);
    expect(logs).toHaveLength(5);
    expect(logs[0]).toBe('[memory-extract] FLINT_EXTRACT_CANDIDATES is not "1" or "0"; reading it as off (no goals or commitments are suggested from chat)');
  });

  it('gives the extractor its options only when on AND on the local model; off or on the frontier it gives none', async () => {
    const logs: string[] = [];
    const filed: ChatSuggestion[] = [];
    const candidates = { file: async (s: ChatSuggestion) => (filed.push(s), 'filed' as const) } as unknown as GoalCandidates;
    const brain = { provider: 'ollama', model: 'qwen2.5:14b', baseURL: HERE };
    const o = (kind: 'local' | 'frontier', here = true) => ({ kind, brain, candidates, tz: 'America/Chicago', log: (m: string) => void logs.push(m), here: () => here });
    expect(candidateOptions({}, o('local'))).toEqual({});
    expect(candidateOptions({ FLINT_EXTRACT_CANDIDATES: '0' }, o('local'))).toEqual({});
    expect(logs).toEqual([]);
    expect(candidateOptions({ FLINT_EXTRACT_CANDIDATES: '1' }, o('frontier'))).toEqual({});
    expect(logs).toEqual(['[memory-extract] FLINT_EXTRACT_CANDIDATES=1 needs the local model (FLINT_MEMORY_BRAIN=local): no goals or commitments are suggested from chat']);
    // On, goals alone: commitments are off until their own switch is on.
    const on = candidateOptions({ FLINT_EXTRACT_CANDIDATES: '1' }, o('local'));
    expect(on).toMatchObject({ commitments: false, tz: 'America/Chicago' });
    expect(typeof on.candidates).toBe('function');
    expect((on.candidates as () => boolean)()).toBe(true);
    expect(await on.onCandidate!(suggestion())).toBe('filed');
    expect(filed).toHaveLength(1);
    expect(logs[1]).toBe('[memory-extract] goals Will sets in chat are suggested (commitments are off: FLINT_EXTRACT_COMMITMENTS) (FLINT_EXTRACT_CANDIDATES=1): each rests on his own quoted words and waits for his approval');
    // Both on.
    logs.length = 0;
    expect(candidateOptions({ FLINT_EXTRACT_CANDIDATES: '1', FLINT_EXTRACT_COMMITMENTS: '1' }, o('local'))).toMatchObject({ commitments: true });
    expect(logs).toEqual(['[memory-extract] goals and commitments Will sets in chat are suggested (FLINT_EXTRACT_CANDIDATES=1): each rests on his own quoted words and waits for his approval']);
    // Commitments alone turn nothing on, and say so.
    logs.length = 0;
    expect(candidateOptions({ FLINT_EXTRACT_COMMITMENTS: '1' }, o('local'))).toEqual({});
    expect(logs).toEqual(['[memory-extract] FLINT_EXTRACT_COMMITMENTS=1 does nothing without FLINT_EXTRACT_CANDIDATES=1: nothing is suggested from chat']);
    expect(commitmentsSetting({ FLINT_EXTRACT_COMMITMENTS: 'yes' }, () => {})).toBe(false);
  });

  it('asks the locality rule about the extractor’s own brain, at every pass, and says when the answer changes', () => {
    const logs: string[] = [];
    let here = false;
    const seen: unknown[] = [];
    const brain = { provider: 'ollama', model: 'mine', baseURL: HERE };
    const on = candidateOptions({ FLINT_EXTRACT_CANDIDATES: '1' }, {
      kind: 'local', brain, candidates: {} as GoalCandidates, tz: 'UTC', log: (m) => void logs.push(m), here: (b) => (seen.push(b), here),
    });
    // At boot it is asked once, about the brain it was given: not here, so the feature is waiting.
    expect(seen).toEqual([brain]);
    expect(logs).toEqual([WAITING]);
    expect(WAITING).toContain('is waiting for a model on this Mac');
    const ask = on.candidates as () => boolean;
    expect(ask()).toBe(false);
    expect(ask()).toBe(false);
    expect(logs).toHaveLength(1);
    here = true;
    expect(ask()).toBe(true);
    expect(logs).toHaveLength(2);
    expect(logs[1]).toContain('goals Will sets in chat are suggested');
    here = false;
    expect(ask()).toBe(false);
    expect(logs[2]).toBe(WAITING);
    expect(seen).toHaveLength(5);
    // By default the question is the server's one locality rule: an Ollama on another machine, a cloud model, a
    // model nobody has listed, another provider, no brain at all, are all "not here".
    const real = (b: { provider: string; model: string; baseURL?: string } | undefined) =>
      (candidateOptions({ FLINT_EXTRACT_CANDIDATES: '1' }, { kind: 'local', brain: b, candidates: {} as GoalCandidates, tz: 'UTC', log: () => {} }).candidates as () => boolean)();
    listed(HERE, ['qwen2.5:14b', { name: 'mine', remote_host: 'https://ollama.com' }]);
    expect(real({ provider: 'ollama', model: 'qwen2.5:14b', baseURL: HERE })).toBe(true);
    expect(real({ provider: 'ollama', model: 'mine', baseURL: HERE })).toBe(false);
    expect(real({ provider: 'ollama', model: 'qwen2.5:14b', baseURL: 'http://10.0.0.5:11434' })).toBe(false);
    expect(real({ provider: 'ollama', model: 'not-listed:7b', baseURL: HERE })).toBe(false);
    expect(real({ provider: 'ollama', model: 'glm-4.6:cloud', baseURL: HERE })).toBe(false);
    expect(real({ provider: 'anthropic', model: 'claude-test' })).toBe(false);
    expect(real(undefined)).toBe(false);
    cleanup();
  });

  it('the server reads Will’s zone as the runtime does, and falls back on a name that is no zone instead of failing', () => {
    const logs: string[] = [];
    const log = (m: string) => void logs.push(m);
    expect(serverZone({ FLINT_TZ: 'America/New_York', FLINT_USER_TZ: 'UTC' }, log)).toBe('America/New_York');
    expect(serverZone({ FLINT_USER_TZ: 'Europe/Lisbon' }, log)).toBe('Europe/Lisbon');
    expect(serverZone({}, log)).toBe('America/Chicago');
    expect(logs).toEqual([]);
    for (const bad of ['Mars/Phobos', 'CST6CDT ']) expect(serverZone({ FLINT_TZ: bad }, log), bad).toMatch(/^(America\/Chicago|CST6CDT)$/);
    expect(serverZone({ FLINT_TZ: 'Mars/Phobos' }, log)).toBe('America/Chicago');
    expect(logs.at(-1)).toBe('[memory-extract] FLINT_TZ or FLINT_USER_TZ is not a time zone; days are read in America/Chicago');
  });
});

describe('the whole path, on real sockets: a turn that stays here is mined locally, and nothing about it reaches an outside model', () => {
  let dir: string;
  let said: string[];
  const closers: Array<() => Promise<void>> = [];
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'flint-cand-path-'));
    said = [];
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void said.push(a.map(String).join(' ')));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const c of closers.splice(0)) await c();
    rmSync(dir, { recursive: true, force: true });
    cleanup();
    expect(said.join('\n')).not.toContain(CANARY);
  });

  const GOALS_SAID = `${CANARY} I want to finish the sailing course before the summer, that is the goal now`;
  const PLAIN_SAID = `${CANARY} I will send Dana the draft contract on Friday without fail`;
  const NOW = Date.now();

  /**
   * The server's memory wiring, as main() does it, with every outside address a stub that records what it is sent.
   * `alias`: what this Mac's Ollama says of the model (a cloud-backed name carries a remote host). `elsewhere`: the
   * extractor's Ollama is named at another machine's address (its requests are routed to the stub).
   */
  async function wired(env: Record<string, string>, o: { alias?: string; elsewhere?: boolean } = {}) {
    const store = tmpStore();
    // Two finished turns: one answered with Will's goals (it stays on this Mac), one ordinary.
    await storedTurn(store, { conversationId: 'console-1', id: 'turn_goals', context: GOALS_TURN, user: GOALS_SAID, assistant: 'Noted.', at: NOW - 120_000 });
    await storedTurn(store, { conversationId: 'console-2', id: 'turn_plain', user: PLAIN_SAID, assistant: 'Noted.', at: NOW - 60_000 });
    // The runtime, the local Ollama, and something that speaks Anthropic's wire.
    const runtime = await stub(() => ({ status: 201, body: { outcome: 'filed' } }));
    const ollama = await stub((req, body) => {
      // What runs on it, when the server asks (./ollama-locality): this model, here.
      if (req.url === '/api/tags') return { status: 200, body: { models: [{ name: 'qwen2.5:14b', model: 'qwen2.5:14b', ...(o.alias ? { remote_host: o.alias, remote_model: 'big-model' } : {}) }] } };
      const prompt = String((JSON.parse(body) as { messages?: Array<{ content?: string }> }).messages?.map((m) => m.content).join('\n') ?? '');
      const suggestions = [
        ...(prompt.includes('sailing course') ? [{ turn: 1, kind: 'goal', quote: 'I want to finish the sailing course before the summer', text: 'finish the sailing course', dueOn: '' }] : []),
        ...(prompt.includes('draft contract') ? [{ turn: 1, kind: 'commitment', quote: 'I will send Dana the draft contract on Friday', text: 'send Dana the draft contract', dueOn: '' }] : []),
      ];
      return { status: 200, body: { model: 'qwen2.5:14b', message: { role: 'assistant', content: JSON.stringify({ facts: [], suggestions }) }, done: true, done_reason: 'stop', prompt_eval_count: 5, eval_count: 5 } };
    });
    const anthropic = await stub(() => ({
      status: 200,
      // A frontier that tries: its reply carries a suggestion nobody asked it for.
      body: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-test', stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 5 },
        content: [{ type: 'text', text: JSON.stringify({ facts: [], suggestions: [{ turn: 1, kind: 'commitment', quote: 'I will send Dana the draft contract on Friday', text: 'send Dana the draft contract', dueOn: '' }] }) }] },
    }));
    closers.push(runtime.close, ollama.close, anthropic.close);
    listed(ollama.url, [o.alias ? { name: 'qwen2.5:14b', remote_host: o.alias } : 'qwen2.5:14b']);
    // An Ollama named at another machine's address: what the extractor would send there lands on the stub.
    const away = 'http://10.0.0.5:11434';
    const routed = (async (url: string | URL | Request, init?: RequestInit) => fetch(String(url).replace(away, ollama.url), init)) as typeof fetch;
    const goalsChat = new GoalsChat({ memory: store, blocks: { world: false, goals: true, goalsToFrontier: false }, runtime: () => ({ url: runtime.url, token: TOKEN }), log: () => {} });
    const frontier = new Flint({ provider: new AnthropicProvider({ apiKey: 'sk-test-key', baseURL: anthropic.url, maxRetries: 0 }), model: 'claude-test' });
    const logs: string[] = [];
    const localEnv = { OLLAMA_HOST: o.elsewhere ? away : ollama.url, OLLAMA_MODEL: 'qwen2.5:14b', ...env };
    const plan = chooseMemoryBrain(localEnv, { frontier: frontierExtractBrain((input) => frontier.generate(input)), log: (m) => void logs.push(m), ...(o.elsewhere ? { fetch: routed } : {}) });
    if (plan.kind === 'none') throw new Error(plan.why);
    const candidates = new GoalCandidates({ runtime: () => ({ url: runtime.url, token: TOKEN }) });
    const extractBrain = plan.kind === 'local' ? { provider: 'ollama', model: plan.model.model, baseURL: plan.model.baseURL } : { provider: 'anthropic', model: 'claude-test' };
    const ex = new MemoryExtractor(store, new KnowledgeStore(join(dir, 'knowledge.json'), downEmbedder), plan.brain, join(dir, 'extract-state.json'), {
      kind: plan.kind,
      ...goalsChat.extractor({ brain: extractBrain, tainted: () => false }),
      ...candidateOptions(localEnv, { kind: plan.kind, brain: extractBrain, candidates, tz: 'UTC', log: (m) => void logs.push(m) }),
    });
    await ex.run();
    // The model's own calls: what the Ollama was asked to answer (not the listing of what runs on it).
    const chats = ollama.requests.filter((r) => r.path === '/api/chat');
    expect(ollama.requests.filter((r) => r.path !== '/api/chat' && r.path !== '/api/tags')).toEqual([]);
    return { runtime, ollama, chats, anthropic, candidates, ex, logs, extractBrain };
  }

  it('on the local model: both turns are mined, each suggestion reaches the runtime on this Mac, and the Anthropic stub is never called', async () => {
    const w = await wired({ FLINT_EXTRACT_CANDIDATES: '1', FLINT_EXTRACT_COMMITMENTS: '1' });
    // The turn that stays here is in a call of its own, and the local model was asked for suggestions in both.
    expect(w.chats).toHaveLength(2);
    for (const r of w.chats) expect(r.body).toContain(JSON.stringify(SUGGEST_PROMPT).slice(1, 60));
    expect(w.chats.filter((r) => r.body.includes('sailing course'))).toHaveLength(1);
    // The runtime got both, with the server's token, quoted from the right turn: his whole sentence each time.
    expect(w.runtime.requests.map((r) => [r.method, r.path, r.auth])).toEqual([['POST', '/v1/goals/candidates', `Bearer ${TOKEN}`], ['POST', '/v1/goals/candidates', `Bearer ${TOKEN}`]]);
    const bodies = w.runtime.requests.map((r) => JSON.parse(r.body) as Record<string, unknown>);
    expect(bodies.map((b) => [b.kind, b.conversationId, b.turnId, b.quote, b.text]).sort()).toEqual([
      ['commitment', 'console-2', 'turn_plain', PLAIN_SAID, 'Send Dana the draft contract'],
      ['goal', 'console-1', 'turn_goals', GOALS_SAID, 'Finish the sailing course'],
    ]);
    for (const b of bodies) expect(ChatCandidate.safeParse(b).success).toBe(true);
    expect(w.candidates.counts).toMatchObject({ filed: 2, held: 0, unreachable: 0 });
    expect(w.ex.lastStats).toMatchObject({ suggested: 2, suggestionsKept: 2, suggestionsFiled: 2 });
    // Nothing went anywhere else.
    expect(w.anthropic.requests).toEqual([]);
  });

  it('goals alone (commitments have their own switch): the model is asked for goals only, and no commitment reaches the runtime', async () => {
    const w = await wired({ FLINT_EXTRACT_CANDIDATES: '1' });
    expect(w.chats).toHaveLength(2);
    for (const r of w.chats) {
      expect(r.body).toContain(JSON.stringify(SUGGEST_GOALS_PROMPT).slice(1, 60));
      expect(r.body).not.toMatch(/commitment/);
    }
    // The stub Ollama answers with a commitment for the plain turn anyway: it is dropped, never sent on.
    expect(w.runtime.requests.map((r) => (JSON.parse(r.body) as { kind: string }).kind)).toEqual(['goal']);
    expect(w.ex.lastStats.rejected['suggestion-kind']).toBe(1);
    expect(w.candidates.counts).toMatchObject({ filed: 1 });
    expect(w.anthropic.requests).toEqual([]);
  });

  it('a local model that runs elsewhere suggests nothing: a cloud-backed name on this Mac’s Ollama is asked for facts alone, and the log says the feature is waiting', async () => {
    const w = await wired({ FLINT_EXTRACT_CANDIDATES: '1', FLINT_EXTRACT_COMMITMENTS: '1' }, { alias: 'https://ollama.com' });
    // It is still the "local" brain by its setting: that is not what decides.
    expect(w.extractBrain).toMatchObject({ provider: 'ollama', model: 'qwen2.5:14b' });
    // The turn that stays here is not sent to it at all; the plain turn is, for facts, with no suggestion lines.
    expect(w.chats).toHaveLength(1);
    expect(w.chats[0]!.body).toContain('draft contract');
    expect(w.chats[0]!.body).not.toContain('sailing course');
    expect(w.chats[0]!.body).not.toContain('suggestions');
    // The stub answered with a suggestion all the same: it is not read, and the runtime is told nothing.
    expect(w.runtime.requests).toEqual([]);
    expect(w.ex.asks()).toBeUndefined();
    expect(w.ex.lastStats).toMatchObject({ skippedTainted: 1, suggested: 0, suggestionsKept: 0 });
    expect(w.candidates.counts).toEqual({ filed: 0, known: 0, refused: 0, capped: 0, unreachable: 0, held: 0 });
    expect(w.logs).toContain(WAITING);
    expect(w.logs.some((l) => l.includes('are suggested'))).toBe(false);
  });

  it('nor does an Ollama on another machine: asked for facts alone, nothing filed, and the log says the feature is waiting', async () => {
    const w = await wired({ FLINT_EXTRACT_CANDIDATES: '1', FLINT_EXTRACT_COMMITMENTS: '1' }, { elsewhere: true });
    expect(w.extractBrain).toMatchObject({ provider: 'ollama', baseURL: 'http://10.0.0.5:11434' });
    expect(w.chats).toHaveLength(1);
    expect(w.chats[0]!.body).toContain('draft contract');
    expect(w.chats[0]!.body).not.toContain('sailing course');
    expect(w.chats[0]!.body).not.toContain('suggestions');
    expect(w.runtime.requests).toEqual([]);
    expect(w.ex.lastStats).toMatchObject({ skippedTainted: 1, suggested: 0 });
    expect(w.logs).toContain(WAITING);
    expect(w.anthropic.requests).toEqual([]);
  });

  it('on the frontier: the turn that stays here is never sent, no prompt asks for suggestions, a suggestion in the reply is not read, and the runtime is told nothing', async () => {
    const w = await wired({ FLINT_EXTRACT_CANDIDATES: '1', FLINT_MEMORY_BRAIN: 'frontier' });
    expect(w.logs.some((l) => l.includes('FLINT_EXTRACT_CANDIDATES=1 needs the local model'))).toBe(true);
    // The ordinary turn was sent to the frontier for facts, as before this part.
    expect(w.anthropic.requests.length).toBeGreaterThanOrEqual(1);
    const sent = w.anthropic.requests.map((r) => r.body).join('\n');
    expect(sent).toContain('draft contract');
    // Nothing about the turn that stays here, in any request.
    expect(sent).not.toContain('sailing course');
    expect(sent).not.toContain('turn_goals');
    // And it was not asked for suggestions.
    expect(sent).not.toContain('suggestions');
    expect(w.runtime.requests).toEqual([]);
    expect(w.chats).toEqual([]);
    expect(w.ex.suggests).toBe(false);
    expect(w.ex.lastStats).toMatchObject({ skippedTainted: 1, suggested: 0, suggestionsKept: 0 });
    expect(w.candidates.counts).toEqual({ filed: 0, known: 0, refused: 0, capped: 0, unreachable: 0, held: 0 });
  });

  it('off (how it ships): the local model is asked for facts alone, and the runtime is told nothing', async () => {
    const w = await wired({});
    expect(w.chats).toHaveLength(2);
    for (const r of w.chats) expect(r.body).not.toContain('suggestions');
    expect(w.runtime.requests).toEqual([]);
    expect(w.anthropic.requests).toEqual([]);
    expect(w.ex.suggests).toBe(false);
  });

  it('a runtime that is down: the suggestion is dropped and counted, the pass goes on, and the turn is not read again', async () => {
    const store = tmpStore();
    await storedTurn(store, { conversationId: 'console-2', id: 'turn_plain', user: PLAIN_SAID, assistant: 'Noted.', at: NOW - 60_000 });
    const gone = await stub(() => ({ status: 200, body: {} }));
    await gone.close();
    const candidates = new GoalCandidates({ runtime: () => ({ url: gone.url, token: TOKEN }) });
    let calls = 0;
    const brain = { generate: async () => (calls += 1, { facts: [], suggestions: [{ turn: 1, kind: 'commitment', quote: 'I will send Dana the draft contract on Friday', text: 'send Dana the draft contract', dueOn: '' }] }) };
    listed(HERE, ['qwen2.5:14b']);
    const ex = new MemoryExtractor(store, new KnowledgeStore(join(dir, 'knowledge.json'), downEmbedder), brain, join(dir, 'extract-state.json'), {
      ...candidateOptions({ FLINT_EXTRACT_CANDIDATES: '1', FLINT_EXTRACT_COMMITMENTS: '1' }, { kind: 'local', brain: { provider: 'ollama', model: 'qwen2.5:14b', baseURL: HERE }, candidates, tz: 'UTC', log: () => {}, here: () => true }),
    });
    await ex.run();
    expect(ex.lastStats).toMatchObject({ suggested: 1, suggestionsKept: 1, suggestionsFiled: 0, turnsSent: 1 });
    expect(ex.lastStats.rejected['suggestion-unreachable']).toBe(1);
    expect(candidates.counts.unreachable).toBe(1);
    // The watermark moved: a second pass has nothing to send, and nothing was kept to send later.
    await ex.run();
    expect(calls).toBe(1);
    expect(readdirSync(dir).sort()).toEqual(['extract-state.json']);
    expect(readFileSync(join(dir, 'extract-state.json'), 'utf8')).not.toContain('draft contract');
  });
});

describe('no tool reaches it', () => {
  const NAMES = [...CHAT_SUGGESTION_ACTIONS];

  it('no built-in tool, and no tool of the runtime connector, is named for either action or calls the candidates route', () => {
    const k = new KnowledgeStore(join(mkdtempSync(join(tmpdir(), 'flint-cand-tools-')), 'k.json'), downEmbedder);
    const builtins: Tool[] = [rememberTool(k), calculateTool(), deepResearchTool({ tools: [], embedder: downEmbedder as never, complete: async () => '' })];
    const names = builtins.map((t) => t.definition.name);
    expect(names).toEqual(expect.arrayContaining(['remember', 'calculate', 'deep_research']));
    for (const n of names) for (const a of NAMES) expect(n).not.toBe(a);
    // Every built-in main() gives a model: none is added without being looked at here.
    const index = readFileSync(join(__dirname, '..', 'src', 'index.ts'), 'utf8');
    // (They are also held to the private rule, which wraps the list: ...heldOnPrivate(gateBuiltins([ ... ], tierOpts)).)
    const made = index.slice(index.indexOf('gateBuiltins(['), index.indexOf('], tierOpts)'));
    expect(index.indexOf('gateBuiltins([')).toBeGreaterThan(-1);
    expect([...made.matchAll(/^\s{4}(\w+Tool)\(/gm)].map((m) => m[1])).toEqual(['rememberTool', 'trainingStatusTool', 'deepResearchTool', 'calculateTool', 'spendStatusTool']);
    // The runtime connector (the MCP server a model's runtime tools live in): its tools, and every route it calls.
    const connector = readFileSync(join(__dirname, '..', '..', '..', 'packages', 'mcp', 'connectors', 'runtime-server.ts'), 'utf8');
    const tools = [...connector.matchAll(/registerTool\(\s*'([^']+)'/g)].map((m) => m[1]);
    expect(tools.sort()).toEqual(['escalations_open', 'explain_decision', 'inbox_recent', 'ledger_calibration', 'ledger_open', 'ledger_record_prediction', 'world_entity', 'world_now']);
    const routes = [...connector.matchAll(/\/v1\/[A-Za-z0-9_/-]+/g)].map((m) => m[0]);
    expect(routes.length).toBeGreaterThan(5);
    for (const r of routes) expect(r).not.toMatch(/^\/v1\/(goals|proposals)/);
    for (const a of NAMES) expect(connector).not.toContain(a);
    // No tool module of the server's names the route or the client either: only main()'s extractor wiring does.
    for (const file of ['knowledge.ts', 'calculate.ts', 'deep-research.ts', 'training-status.ts', 'spend.ts', 'tier-gate.ts', 'goals-tools.ts', 'goals-chat.ts']) {
      const text = readFileSync(join(__dirname, '..', 'src', file), 'utf8');
      expect(text, file).not.toContain('goals/candidates');
      expect(text, file).not.toContain('GoalCandidates');
    }
    expect(index.match(/new GoalCandidates\(/g)).toHaveLength(1);
    expect(index).toContain('...candidateOptions(process.env, {');
    expect(index).not.toMatch(/process\.env\.FLINT_EXTRACT_CANDIDATES/);
    expect(index).not.toContain('goals/candidates');
  });

  it('a tool call that names either action is refused at the gate: nothing runs, no proposal is filed, nothing is spooled, the runtime is not asked', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'flint-cand-gate-'));
    try {
      for (const name of NAMES) {
        const ran: string[] = [];
        const asked: string[] = [];
        const proposals = new RuntimeProposals({
          runtime: () => ({ url: 'http://[::1]:8090', token: TOKEN }), spoolDir: join(dir, 'spool'), log: () => {},
          fetchImpl: (async (url: string) => (asked.push(String(url)), new Response('{}', { status: 201 }))) as unknown as typeof fetch,
        });
        const events: TierEvent[] = [];
        const tool: Tool = {
          definition: { name, description: 'a tool a model was somehow offered', inputSchema: { type: 'object', properties: {} } },
          handler: async () => (ran.push(name), 'done'),
        } as unknown as Tool;
        const [gated] = gateBuiltins([tool], { queue: new ActionQueue(isSafeTool), onDecision: (e) => void events.push(e), proposals });
        const out = await withTurnTaint(() => gated!.handler({ id: 'call_1', toolName: name, args: { title: 'Synthetic', quote: 'Synthetic words a model wrote itself' } } as never));
        expect(ran, name).toEqual([]);
        expect(JSON.stringify(out), name).toContain('was not executed');
        expect(JSON.stringify(out), name).toContain('filed only by Flint’s own check of Will’s words');
        expect(events.map((e) => [e.name, e.status, e.decision.tier]), name).toEqual([[name, 'denied', 'forbidden']]);
        expect(asked, name).toEqual([]);
        // Nothing waits in the spool either (its folder is made when the server starts; it holds no file).
        expect(existsSync(join(dir, 'spool')) ? readdirSync(join(dir, 'spool')) : [], name).toEqual([]);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
