/**
 * The real server, run as a process.
 *
 * index.ts runs main() when it is loaded, so no unit test can import it: the
 * rest of the suite checks its wiring by reading its text. A review showed the
 * limit of that. Four edits that left the asserted text in place passed every
 * test: the scope check switched off, turns handed the unmetered tools, the
 * history view bypassed, the filtered tool list thrown away.
 *
 * So this starts apps/server/src/index.ts itself (./rig), on a scratch HOME and
 * free ports, against loopback stand-ins (./stubs): a model server on Ollama's
 * own API, an outside brain on Anthropic's wire (reached through
 * ANTHROPIC_BASE_URL, so to the server it IS the outside), and two stdio MCP
 * servers with the real connectors' tool names. It then reads what was really
 * put on each wire. Nothing here asks a real model, a real service or a live
 * Flint, and the process is fenced so that it cannot (./guard.mjs).
 *
 * Seven servers, each with its own scratch HOME and stand-ins, started at the
 * same time (the boot is most of what this test takes):
 *  - `modes`: Cloud mode, then Local mode, on a model server that is this Mac;
 *  - `remote`: Cloud mode with a model server on another machine;
 *  - `alias`: a main model that is a cloud model under a plain name, and a
 *    real pass of memory extraction over a stored private turn;
 *  - `wire` and `late`: that cloud model asked over the OpenAI-compatible
 *    wire, with the server called a plain OpenAI-compatible one, and with the
 *    server not up when Flint booted (the privacy review's N1);
 *  - `tier`: a tier that is that cloud model on the same wire, beside one that
 *    is a real local model, on an Ollama that is not the main model's; and the
 *    main model's name re-pointed while Flint runs (N1, N5, N9);
 *  - `helper`: the local model on this Mac and OLLAMA_HOST on another machine
 *    that FLINT_LOCAL_ALLOW_REMOTE does not vouch for (N2).
 * And one more, started later on the `modes` server's own HOME once that one has
 * stopped (`again`): the same Mac restarted with goals from chat switched on,
 * mining the turns the first run really took in Local mode and with Local Only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { ROUTE_FIELDS } from '../../src/route-log';
import { HISTORY_GAP } from '../../src/goals-now';
import { PRIVATE_TOOL_REFUSED, PRIVATE_TURN_NOTE } from '../../src/outside-ai';
import { SUGGEST_GOALS_PROMPT, SUGGEST_PROMPT } from '../../src/memory-extract';
import { FRESH_MS } from '../../src/ollama-locality';
import { WAITING } from '../../src/goal-candidates';
import { startMockLocalServer, type MockLocalServer } from '../mock-local-server';
import { chatFacts, forward, reservePort, startCloudStub, startOllamaStub, startRuntimeStub, type CloudStub, type OllamaStub, type RuntimeStub } from './stubs';
import { routeLines, scratch, sleep, startServer, writeMcpConfig, type Running } from './rig';

const MAIN = 'main-model:30b';
const MODELS = { [MAIN]: { loaded: true, contextLength: 16384 }, 'nomic-embed-text': { family: 'nomic-bert' } };
/** Words that are in a message and nowhere else, so a wire or a log can be searched for them. */
const SECRET = 'ZEBRAQUARTZ';
/** A fact in long-term memory from before, learned on an ordinary turn: any brain may be given it. */
const OPEN_FACT = 'Will keeps the garden shears in the OPALHERON shed.';
/** What the "model" saves with `remember`: on a private turn, and on a turn taken in Local mode. */
const KEPT_FACT = 'Will keeps the spare key at the GARNETFINCH lodge.';
/** ...and on a private one-shot answer (/generate). */
const ONESHOT_FACT = 'Will keeps the passport copy in the AMBERKITE folder.';
const LOCAL_MODE_FACT = 'Will keeps the bike lock code in the TOPAZWREN notebook.';
const ASK_FACTS = 'Where does Will keep the spare key, the bike lock code and the garden shears?';
const memoryFile = (facts: string[]): string => JSON.stringify({ seq: facts.length, facts: facts.map((text, i) => ({ id: `k${i + 1}`, text, source: 'history', ts: 1, vector: [] })), rejected: [] });
const PAID = ['trident.perplexity_search', 'trident.web_search'];
const names = (request: { body: Record<string, unknown> | undefined } | undefined): string[] => ((request?.body?.tools ?? []) as Array<{ name?: string }>).map((t) => String(t.name).replace('__', '.'));
const cloudEnv = (cloud: CloudStub): Record<string, string> => ({ ANTHROPIC_API_KEY: 'sk-ant-process-test-not-a-key', ANTHROPIC_BASE_URL: cloud.origin });
/** The `meta` event that says whether a reply stays on this Mac, and which stored turn it is. */
const staysHere = (r: { events?: Array<Record<string, unknown>> }): { staysHere?: boolean; turn?: string } | undefined => r.events?.find((e) => e.type === 'meta' && typeof e.staysHere === 'boolean');
const blocked = (srv: Running): Array<{ kind: string; hostname?: string; host?: string }> => srv.guard().filter((e) => e.kind.endsWith('blocked'));
/** A tool result as the model is handed it (JSON text), read back. */
const told = (results: string[]): unknown[] => results.map((r) => JSON.parse(r) as unknown);
/** What a tool that was held back on a private turn answers, at the wrapper and for a tool the turn was not offered. */
const REFUSED_PRIVATE = { isError: true, content: PRIVATE_TOOL_REFUSED };
type Fact = { text: string; fromPrivate?: boolean; fromGoals?: boolean; vector?: number[] };
const factsOf = (srv: Running): Fact[] => {
  try {
    return (JSON.parse(srv.read('memory', 'knowledge.json')) as { facts: Fact[] }).facts;
  } catch {
    return [];
  }
};
const waitFor = async (what: () => boolean, ms = 8000): Promise<boolean> => {
  for (let t = 0; t < ms && !what(); t += 25) await sleep(25);
  return what();
};
const CLOUD_MODEL_PRIVATE = "The local model is one that runs on Ollama's servers, and a private message never leaves this Mac.";
const CLOUD_MODEL_LOCAL_MODE = "The local model is one that runs on Ollama's servers, and Local mode never uses the cloud.";
const CLOUD_MODEL_ROW = "The local model is an Ollama cloud model, which runs on Ollama's servers, so Local and Hybrid modes will not use it.";

// ---- the three servers, started together

const runs = { modes: scratch('modes'), remote: scratch('remote'), alias: scratch('alias'), wire: scratch('wire'), late: scratch('late'), tier: scratch('tier'), helper: scratch('helper'), repoint: scratch('repoint'), quiet: scratch('quiet') };
const ELSEWHERE = '10.255.255.1';
/** An address that stands for a second machine: the fence carries it to a stand-in on this one (./guard.mjs GUARD_REMAP). */
const OTHER_MACHINE = '10.255.255.2';
/** A real local model on the `tier` server's Ollama, beside the cloud model under a plain name. */
const REAL = 'real:7b';
const GOALS_FACT = 'Will wants the MARLINGOAL regatta entry finished by spring.';
/** What the `helper` server's model saves: on a turn that carries a private one, and on an ordinary turn. */
const HELPER_KEPT_FACT = 'Will keeps the boat keys in the SILVERTERN locker.';
const HELPER_OPEN_FACT = 'Will keeps the picnic rug in the HAZELWREN cupboard.';
const LM_MODEL = 'lm-model';
/** The main model of the `alias` server: a cloud model under a plain name (`ollama cp gpt-oss:120b-cloud mine`). */
const ALIAS = 'mine:latest';
/** ...and the real local model its memory extraction runs on. */
const MEMORY_MODEL = 'memory-model:7b';
const EXTRACT_PRIVATE = 'Keep this private: I keep the passport in the JASPERLARK cabinet, keep that in mind.';
const EXTRACT_OPEN = 'I keep the ladder in the CORALSWIFT garage, keep that in mind.';
/** The server's token for its runtime, as install-runtime.sh would have left it under the scratch HOME (a made-up one). */
const RUNTIME_TOKEN = { path: ['tokens', 'runtime.token'], text: 'ab'.repeat(32) };
/** A message that sets a goal, for a server whose extractor is asked to suggest goals from chat (FLINT_EXTRACT_CANDIDATES). */
const GOAL_SAID = 'I want to finish the PEARLFINCH boat deck by spring, keep that in mind.';
const PRIVATE_LEARNED = 'Will keeps the passport in the JASPERLARK cabinet.';
const OPEN_LEARNED = 'Will keeps the ladder in the CORALSWIFT garage.';

/** What the `repoint` server's store holds from before: an ordinary turn that sets a goal, and a turn Will kept private. */
const REPOINT_OPEN = 'I want to restore the UMBERSTOAT canoe by autumn, keep that in mind.';
const REPOINT_KEPT = 'Keep this private: I keep the deed in the ONYXPIPIT drawer, keep that in mind.';
/** ...and the `quiet` server's: a turn he kept private, and a fact from one that has no embedding yet. */
const QUIET_KEPT = 'Keep this private: I keep the will in the AGATEDUNLIN safe, keep that in mind.';
const QUIET_FACT = 'Will keeps the cash box in the FLINTSHRIKE loft.';
/** How long after "listening" a server's own first asks of its model server are over (they are a few loopback GETs). */
const BOOT_SETTLE_MS = 400;
/** A first extraction pass late enough that what the model server said at boot is too old to use without asking again. */
const LATE_FIRST_PASS_MS = '3200';
/** What the model server is asked for one ordinary turn of Local mode, when it is healthy (measured before the re-review's N3, and unchanged by it). */
const LOCAL_TURN_REQUESTS = { listing: 1, version: 1, ps: 1, embeddings: 2, chat: 1 };
const NOT_CONFIRMED = 'Flint cannot confirm right now that its local model runs on this Mac, and a private message never leaves this Mac.';
const NOT_AVAILABLE = "The local model isn't available, and a private message never leaves this Mac.";
/** ...and what a turn of Local mode is told, for the same three reasons. */
const LOCAL_MODE_TAIL = 'and Local mode never uses the cloud.';
const NOT_CONFIRMED_LOCAL = `Flint cannot confirm right now that its local model runs on this Mac, ${LOCAL_MODE_TAIL}`;
const NOT_DOWNLOADED_LOCAL = `The local model isn't downloaded yet, ${LOCAL_MODE_TAIL}`;
const NOT_AVAILABLE_LOCAL = `The local model isn't available, ${LOCAL_MODE_TAIL}`;

let modes: { ollama: OllamaStub; cloud: CloudStub; mcp: ReturnType<typeof writeMcpConfig>; srv: Running };
let repoint: { ollama: OllamaStub; cloud: CloudStub; runtime: RuntimeStub; srv: Running; flippedAt: number };
let quiet: { ollama: OllamaStub; cloud: CloudStub; srv: Running; flippedAt: number };
let remote: { cloud: CloudStub; there: OllamaStub; srv: Running };
let alias: { ollama: OllamaStub; cloud: CloudStub; runtime: RuntimeStub; srv: Running };
let wire: { mock: MockLocalServer; cloud: CloudStub; runtime: RuntimeStub; srv: Running };
let late: { mock: MockLocalServer; cloud: CloudStub; srv: Running; port: number; closers: Array<() => Promise<void>> };
let tier: { ollama: OllamaStub; mock: MockLocalServer; srv: Running };
let helper: { lm: MockLocalServer; other: OllamaStub; srv: Running };
/** The `modes` Mac, restarted (its describe starts it once `modes` has stopped). */
let again: { runtime: RuntimeStub; srv: Running } | undefined;
/** When the tiers' own Ollama last had a tier asked of it (./goals-chat run asks it what runs on it first). */
let tierAskedAt = 0;
/** What Will said in the `modes` run, for the restart to mine: a goal in each, by the kind of turn it was said on. */
const GOALS_SAID = {
  ordinary: { conversationId: 'g-open', said: 'I want to plant the IVORYLARK orchard by autumn.', quote: 'I want to plant the IVORYLARK orchard by autumn', text: 'plant the IVORYLARK orchard', word: 'IVORYLARK' },
  localMode: { conversationId: 'g-local', said: 'I want to finish the PEARLFINCH boat deck by spring.', quote: 'I want to finish the PEARLFINCH boat deck by spring', text: 'finish the PEARLFINCH boat deck', word: 'PEARLFINCH' },
  localOnly: { conversationId: 'g-private', said: 'I want to repaint the SLATEHERON fence by summer.', quote: 'I want to repaint the SLATEHERON fence by summer', text: 'repaint the SLATEHERON fence', word: 'SLATEHERON' },
  localOnlyInLocalMode: { conversationId: 'g-both', said: 'I want to restring the COPPERWREN guitar by June.', quote: 'I want to restring the COPPERWREN guitar by June', text: 'restring the COPPERWREN guitar', word: 'COPPERWREN' },
} as const;

/**
 * What a turn he ASKED to keep private held, asked about afterwards in Local mode (the follow-up review's probe A,
 * whole): the private thing said once with Local Only on, then three turns that Local mode alone kept, two of them
 * in the same conversation (so each was handed the private turn) and one in a conversation of its own.
 */
const LEAK = {
  word: 'QUARTZMOLE',
  kept: 'Keep this private: my doctor found a QUARTZMOLE lesion last week.',
  asked: 'What did I just tell you about my health, in one line?',
  restated: 'You told me your doctor found a QUARTZMOLE lesion last week.',
  after: 'I want to finish that treatment plan by spring for sure.',
  apart: 'I want to book the follow-up scan by March for sure.',
  learned: "Will's doctor found a QUARTZMOLE lesion.",
} as const;
/** A day the extraction "model" works out for every goal (none of the sentences names one): a real one, months ahead. */
const DAY_WORKED_OUT = new Date(Date.now() + 150 * 86_400_000).toISOString().slice(0, 10);

/** A complete stored turn, as the conversation store writes one. */
const storedTurn = (conversationId: string, id: string, user: string, context?: unknown, hoursAgo = 1) => {
  const at = Date.now() - hoursAgo * 60 * 60 * 1000;
  return {
    id, conversationId, status: 'complete', createdAt: at, updatedAt: at, ...(context !== undefined ? { context } : {}),
    messages: [{ id: `${id}_u`, role: 'user', content: user, timestamp: at }, { id: `${id}_a`, role: 'assistant', content: 'Noted.', timestamp: at }],
  };
};

beforeAll(async () => {
  const startModes = async () => {
    const ollama = await startOllamaStub(structuredClone(MODELS));
    const cloud = await startCloudStub();
    const mcp = writeMcpConfig(runs.modes.dir);
    // The "model" calls a tool when the message names one: CALL(<tool>).
    ollama.toolFor = (last) => {
      const m = /CALL\(([a-z_.]+)\)/.exec(last);
      if (!m) return undefined;
      if (m[1] === 'remember') return { name: 'remember', args: { fact: last.includes('Local mode') ? LOCAL_MODE_FACT : last.includes('one-shot') ? ONESHOT_FACT : KEPT_FACT } };
      return { name: m[1]!, args: m[1] === 'deep_research' ? { question: 'synthetic orchard yields' } : m[1] === 'web.fetch_url' ? { url: 'https://example.invalid/page' } : { query: 'synthetic query' } };
    };
    const srv = await startServer({
      dir: runs.modes.dir,
      env: { MCP_CONFIG: mcp.config, OLLAMA_HOST: ollama.origin, OLLAMA_MODEL: MAIN, OLLAMA_NUM_CTX: '16384', ...cloudEnv(cloud), OPENAI_API_KEY: 'sk-process-test-not-a-key' },
      seed: [{ path: ['memory', 'knowledge.json'], text: memoryFile([OPEN_FACT]) }],
    });
    return { ollama, cloud, mcp, srv };
  };
  const startRemote = async () => {
    const cloud = await startCloudStub();
    // The model server is on another machine: an address that is not this Mac's, which the fence carries to a
    // stand-in here (./guard.mjs GUARD_REMAP). So the test reads everything that machine would have been sent.
    const there = await startOllamaStub(structuredClone(MODELS));
    const srv = await startServer({ dir: runs.remote.dir, env: { GUARD_REMAP: ELSEWHERE, OLLAMA_HOST: `http://${ELSEWHERE}:${new URL(there.origin).port}`, OLLAMA_MODEL: MAIN, ...cloudEnv(cloud) } });
    return { cloud, there, srv };
  };
  const startAlias = async () => {
    const ollama = await startOllamaStub({ [ALIAS]: { loaded: true, contextLength: 16384, remoteHost: 'https://ollama.com:443' }, [MEMORY_MODEL]: { loaded: false }, 'nomic-embed-text': { family: 'nomic-bert' } });
    const cloud = await startCloudStub();
    const runtime = await startRuntimeStub();
    // The memory curator's reply: the fact each turn it is shown holds, with Will's own words for it. And, asked or
    // not, a goal it makes of each turn (P3 part 5): a model that would suggest one from a private turn too.
    ollama.replyFor = (body, last) => {
      if (body.format === undefined || !last.includes('TURNS:')) return undefined;
      const turns = last.split('TURNS:')[1] ?? '';
      const facts = [
        ...(turns.includes('JASPERLARK') ? [{ turn: 1, quote: 'I keep the passport in the JASPERLARK cabinet', fact: PRIVATE_LEARNED, category: 'other', supersedes: [] }] : []),
        ...(turns.includes('CORALSWIFT') ? [{ turn: 1, quote: 'I keep the ladder in the CORALSWIFT garage', fact: OPEN_LEARNED, category: 'other', supersedes: [] }] : []),
      ];
      const suggestions = [
        ...(turns.includes('JASPERLARK') ? [{ turn: 1, kind: 'goal', quote: 'I keep the passport in the JASPERLARK cabinet', text: 'keep the passport in the JASPERLARK cabinet', dueOn: '' }] : []),
        ...(turns.includes('CORALSWIFT') ? [{ turn: 1, kind: 'goal', quote: 'I keep the ladder in the CORALSWIFT garage', text: 'keep the ladder in the CORALSWIFT garage', dueOn: '' }] : []),
      ];
      return JSON.stringify({ facts, suggestions });
    };
    const srv = await startServer({
      dir: runs.alias.dir,
      env: {
        OLLAMA_HOST: ollama.origin, OLLAMA_MODEL: 'mine', OLLAMA_NUM_CTX: '16384', ...cloudEnv(cloud), OPENAI_API_KEY: 'sk-process-test-not-a-key',
        // Memory extraction on a local model, and its first pass a moment after boot instead of a minute and a half.
        FLINT_MEMORY_BRAIN: 'local', FLINT_MEMORY_MODEL: MEMORY_MODEL, FLINT_EXTRACT_FIRST_PASS_MS: '300',
        // ...which is also asked for the goals Will set in chat, and has a runtime on this Mac to hand them to.
        FLINT_EXTRACT_CANDIDATES: '1', FLINT_RUNTIME_URL: runtime.origin,
      },
      // A conversation store from before: a turn Will kept private, and an ordinary one.
      seed: [RUNTIME_TOKEN, { path: ['memory', 'conversations.json'], text: JSON.stringify({ conversations: { 'kept-1': [storedTurn('kept-1', 'turn_kept', EXTRACT_PRIVATE, { private: true })], 'open-1': [storedTurn('open-1', 'turn_open', EXTRACT_OPEN)] } }) }],
    });
    return { ollama, cloud, runtime, srv };
  };
  /** An Ollama whose one chat model is a cloud model under a plain name, speaking both of Ollama's wires. */
  const aliasServer = () => startMockLocalServer({ kind: 'ollama', models: { [ALIAS]: { loaded: true, remoteHost: 'https://ollama.com:443', replies: [{ text: 'ALIAS-ANSWERED-ON-OLLAMA-SERVERS.' }] } } });
  // N1 (a): the settings call that Ollama a plain OpenAI-compatible server, so nothing about its KIND says to ask its listing.
  // (Its memory extraction runs on that same cloud model under a plain name, with goals from chat switched on and a
  // runtime to file them with: P3 part 5 asks the one locality rule whether the extractor's model is on this Mac.)
  const startWire = async () => {
    const mock = await aliasServer();
    const cloud = await startCloudStub();
    const runtime = await startRuntimeStub();
    // Asked for facts or for anything else, this "model" answers with a goal it made of Will's words.
    mock.replyFor = (q) =>
      q.path === '/api/chat' && q.body?.format !== undefined
        ? { text: JSON.stringify({ facts: [], suggestions: [{ turn: 1, kind: 'goal', quote: 'I want to finish the PEARLFINCH boat deck by spring', text: 'finish the PEARLFINCH boat deck', dueOn: '' }] }) }
        : undefined;
    const srv = await startServer({
      dir: runs.wire.dir,
      env: {
        FLINT_LOCAL_PROVIDER: 'openai', FLINT_LOCAL_SERVER: 'openai', FLINT_LOCAL_BASE_URL: mock.baseURL, FLINT_LOCAL_MODEL: ALIAS, OLLAMA_HOST: mock.origin, ...cloudEnv(cloud),
        FLINT_MEMORY_BRAIN: 'local', FLINT_MEMORY_MODEL: ALIAS, FLINT_EXTRACT_FIRST_PASS_MS: '300',
        FLINT_EXTRACT_CANDIDATES: '1', FLINT_EXTRACT_COMMITMENTS: '1', FLINT_RUNTIME_URL: runtime.origin,
      },
      seed: [RUNTIME_TOKEN, { path: ['memory', 'conversations.json'], text: JSON.stringify({ conversations: { 'goal-1': [storedTurn('goal-1', 'turn_goal', GOAL_SAID)] } }) }],
    });
    return { mock, cloud, runtime, srv };
  };
  // N1 (b): nothing is listening at the model server's address when Flint boots (a login race). It comes up later (./stubs forward).
  const startLate = async () => {
    const mock = await aliasServer();
    const cloud = await startCloudStub();
    const port = await reservePort();
    const srv = await startServer({ dir: runs.late.dir, env: { FLINT_LOCAL_PROVIDER: 'openai', FLINT_LOCAL_BASE_URL: `http://127.0.0.1:${port}/v1`, FLINT_LOCAL_MODEL: ALIAS, OLLAMA_HOST: `http://127.0.0.1:${port}`, ...cloudEnv(cloud) } });
    return { mock, cloud, srv, port, closers: [] };
  };
  // N1 (d): the main model is real, on Ollama's own API. The tiers are named on the OpenAI-compatible wire, at
  // ANOTHER Ollama on this Mac (so nothing but the server's own watch of a tier's server ever hears what it lists):
  // the cloud model under a plain name for every tier but one, and a real local model for that one.
  // (The main model's Ollama has an embedding model that is a cloud model under a plain name too: N9.)
  const startTier = async () => {
    const ollama = await startOllamaStub({ [MAIN]: { loaded: true, contextLength: 16384 }, 'nomic-embed-text': { family: 'nomic-bert', remoteHost: 'https://ollama.com:443' } });
    const mock = await startMockLocalServer({
      kind: 'ollama',
      models: { [REAL]: { loaded: true, contextLength: 16384, replies: [{ text: 'REAL-LOCAL reply.' }] }, [ALIAS]: { loaded: true, remoteHost: 'https://ollama.com:443', replies: [{ text: 'ALIAS-ANSWERED-ON-OLLAMA-SERVERS.' }] } },
    });
    const tiers = { FLINT_TIER_STANDARD: `local:${ALIAS}`, FLINT_TIER_ROUTINE: `local:${ALIAS}`, FLINT_TIER_CODE: `local:${ALIAS}`, FLINT_TIER_HARD: `local:${REAL}` };
    const srv = await startServer({
      dir: runs.tier.dir,
      env: { OLLAMA_HOST: ollama.origin, OLLAMA_MODEL: MAIN, OLLAMA_NUM_CTX: '16384', FLINT_LOCAL_BASE_URL: mock.baseURL, ...tiers },
      seed: [
        {
          path: ['memory', 'knowledge.json'],
          text: JSON.stringify({
            seq: 3,
            facts: [
              { id: 'k1', text: OPEN_FACT, source: 'history', ts: 1, vector: [] },
              { id: 'k2', text: KEPT_FACT, source: 'history', ts: 1, vector: [], fromPrivate: true },
              { id: 'k3', text: GOALS_FACT, source: 'history', ts: 1, vector: [], fromGoals: true },
            ],
            rejected: [],
          }),
        },
        // A conversation from before: a turn Will kept private, and one that was answered with his goals.
        { path: ['memory', 'conversations.json'], text: JSON.stringify({ conversations: { mix: [storedTurn('mix', 't_priv', 'Keep this private: the gate code is PRIVWORDT for the yard.', { private: true }), storedTurn('mix', 't_goals', 'How is the GOALWORDT regatta goal going?', { goals: true })] } }) },
      ],
    });
    return { ollama, mock, srv };
  };
  // N2: the local model is on THIS Mac (llama.cpp, the OpenAI-compatible wire) and OLLAMA_HOST is another machine,
  // with FLINT_LOCAL_ALLOW_REMOTE on. That switch vouches for the model server, which is here: not for that machine.
  // No outside brain is configured, so in Cloud mode the local model answers ordinary turns too.
  const startHelper = async () => {
    const lm = await startMockLocalServer({ kind: 'llamacpp', models: { [LM_MODEL]: { loaded: true, replies: [{ text: 'LMLOCAL reply.' }] } } });
    // The "model" saves a fact when the message says so: CALL(remember: KEPT) or CALL(remember: OPEN).
    lm.replyFor = (q) => {
      const facts = chatFacts(q.body);
      const m = facts.toolResults.length === 0 ? /CALL\(remember: (KEPT|OPEN)\)/.exec(facts.last) : null;
      return m ? { tool: { name: 'remember', args: { fact: m[1] === 'KEPT' ? HELPER_KEPT_FACT : HELPER_OPEN_FACT } } } : undefined;
    };
    const other = await startOllamaStub({ [MAIN]: { loaded: true, contextLength: 16384 }, 'nomic-embed-text': { family: 'nomic-bert' } });
    other.replyFor = (body, last) => (body.format !== undefined && last.includes('TURNS:') ? JSON.stringify({ facts: [] }) : undefined);
    const srv = await startServer({
      dir: runs.helper.dir,
      env: {
        GUARD_REMAP: OTHER_MACHINE,
        FLINT_LOCAL_PROVIDER: 'openai', FLINT_LOCAL_BASE_URL: lm.baseURL, FLINT_LOCAL_MODEL: LM_MODEL, FLINT_LOCAL_TOOLS: 'on',
        OLLAMA_HOST: `http://${OTHER_MACHINE}:${new URL(other.origin).port}`, FLINT_LOCAL_ALLOW_REMOTE: '1', FLINT_LOCAL_ALLOW_INSECURE_REMOTE: '1',
        FLINT_MEMORY_BRAIN: 'local', FLINT_MEMORY_MODEL: MAIN, FLINT_EXTRACT_FIRST_PASS_MS: '300',
      },
      seed: [
        { path: ['memory', 'knowledge.json'], text: JSON.stringify({ seq: 2, facts: [{ id: 'k1', text: OPEN_FACT, source: 'history', ts: 1, vector: [] }, { id: 'k2', text: KEPT_FACT, source: 'history', ts: 1, vector: [], fromPrivate: true }], rejected: [] }) },
        {
          path: ['memory', 'conversations.json'],
          text: JSON.stringify({ conversations: { 'kept-1': [storedTurn('kept-1', 'turn_kept', EXTRACT_PRIVATE, { private: true })], 'open-1': [storedTurn('open-1', 'turn_open', EXTRACT_OPEN)], mix: [storedTurn('mix', 't_priv', 'Keep this private: the gate code is PRIVWORDH for the yard.', { private: true })] } }),
        },
      ],
    });
    return { lm, other, srv };
  };
  // The follow-up review's F3 and F4. Memory extraction on a real local model, with goals from chat on. A moment
  // after boot the memory model is pointed at a cloud model (`ollama cp gpt-oss:120b-cloud memory-model:7b`), and
  // nothing asks its Ollama again before the first pass, three seconds later: the pass begins on what was known.
  const startRepoint = async () => {
    const ollama = await startOllamaStub({ [MAIN]: { loaded: true, contextLength: 16384 }, [MEMORY_MODEL]: { loaded: false }, 'nomic-embed-text': { family: 'nomic-bert' } });
    const cloud = await startCloudStub();
    const runtime = await startRuntimeStub();
    // Asked for goals or not, the "model" makes one of the ordinary turn.
    ollama.replyFor = (body, last) => {
      if (body.format === undefined || !last.includes('TURNS:')) return undefined;
      const shown = (last.split('TURNS:')[1] ?? '').split('### Turn ').slice(1);
      const suggestions = shown.flatMap((text, i) => (text.includes('UMBERSTOAT') ? [{ turn: i + 1, kind: 'goal', quote: 'I want to restore the UMBERSTOAT canoe by autumn', text: 'restore the UMBERSTOAT canoe', dueOn: '' }] : []));
      return JSON.stringify({ facts: [], suggestions });
    };
    const srv = await startServer({
      dir: runs.repoint.dir,
      env: {
        OLLAMA_HOST: ollama.origin, OLLAMA_MODEL: MAIN, OLLAMA_NUM_CTX: '16384', ...cloudEnv(cloud),
        FLINT_MEMORY_BRAIN: 'local', FLINT_MEMORY_MODEL: MEMORY_MODEL, FLINT_EXTRACT_FIRST_PASS_MS: LATE_FIRST_PASS_MS, FLINT_EXTRACT_CANDIDATES: '1', FLINT_RUNTIME_URL: runtime.origin,
      },
      // (The ordinary turn is the older one: its call is made first.)
      seed: [RUNTIME_TOKEN, { path: ['memory', 'conversations.json'], text: JSON.stringify({ conversations: { 'open-1': [storedTurn('open-1', 'turn_open', REPOINT_OPEN, undefined, 2)], 'kept-1': [storedTurn('kept-1', 'turn_kept', REPOINT_KEPT, { private: true })] } }) }],
    });
    await sleep(BOOT_SETTLE_MS);
    const flippedAt = ollama.requests.length;
    ollama.models[MEMORY_MODEL]!.remoteHost = 'https://ollama.com:443';
    return { ollama, cloud, runtime, srv, flippedAt };
  };
  // The follow-up review's F2. The same Mac without goals from chat. A moment after boot EVERY name on its Ollama is
  // pointed at a cloud model and the listing begins to fail (a 500), while chat and the embedding calls go on
  // answering: what the server last said still reads "runs here", and nothing it can be asked now says otherwise.
  const startQuiet = async () => {
    const ollama = await startOllamaStub({ [MAIN]: { loaded: true, contextLength: 16384 }, [MEMORY_MODEL]: { loaded: false }, 'nomic-embed-text': { family: 'nomic-bert' } });
    const cloud = await startCloudStub();
    ollama.replyFor = (body, last) => (body.format !== undefined && last.includes('TURNS:') ? JSON.stringify({ facts: [] }) : undefined);
    const srv = await startServer({
      dir: runs.quiet.dir,
      env: { OLLAMA_HOST: ollama.origin, OLLAMA_MODEL: MAIN, OLLAMA_NUM_CTX: '16384', ...cloudEnv(cloud), FLINT_MEMORY_BRAIN: 'local', FLINT_MEMORY_MODEL: MEMORY_MODEL, FLINT_EXTRACT_FIRST_PASS_MS: LATE_FIRST_PASS_MS },
      seed: [
        { path: ['memory', 'knowledge.json'], text: JSON.stringify({ seq: 2, facts: [{ id: 'k1', text: OPEN_FACT, source: 'history', ts: 1, vector: [] }, { id: 'k2', text: QUIET_FACT, source: 'history', ts: 1, vector: [], fromPrivate: true }], rejected: [] }) },
        { path: ['memory', 'conversations.json'], text: JSON.stringify({ conversations: { 'kept-1': [storedTurn('kept-1', 'turn_kept', QUIET_KEPT, { private: true })] } }) },
      ],
    });
    await sleep(BOOT_SETTLE_MS);
    const flippedAt = ollama.requests.length;
    for (const m of Object.values(ollama.models)) m.remoteHost = 'https://ollama.com:443';
    ollama.looks = 'listing-fails';
    return { ollama, cloud, srv, flippedAt };
  };
  [modes, remote, alias, wire, late, tier, helper, repoint, quiet] = await Promise.all([startModes(), startRemote(), startAlias(), startWire(), startLate(), startTier(), startHelper(), startRepoint(), startQuiet()]);
});
afterAll(async () => {
  await Promise.all([modes, remote, alias, wire, late, tier, helper, repoint, quiet, again].map((s) => s?.srv.stop()));
  await again?.runtime.close();
  await Promise.all([
    repoint?.ollama.close(), repoint?.cloud.close(), repoint?.runtime.close(), quiet?.ollama.close(), quiet?.cloud.close(),
    modes?.ollama.close(), modes?.cloud.close(), remote?.cloud.close(), remote?.there.close(), alias?.ollama.close(), alias?.cloud.close(), alias?.runtime.close(),
    wire?.mock.close(), wire?.cloud.close(), wire?.runtime.close(), late?.mock.close(), late?.cloud.close(), ...(late?.closers ?? []).map((c) => c()), tier?.ollama.close(), tier?.mock.close(), helper?.lm.close(), helper?.other.close(),
  ]);
  for (const r of Object.values(runs)) r.cleanup();
});

describe('the real server, as a process: Cloud mode, then Local mode', () => {
  let ollama: OllamaStub;
  let cloud: CloudStub;
  let mcp: ReturnType<typeof writeMcpConfig>;
  let srv: Running;
  beforeAll(() => {
    ({ ollama, cloud, mcp, srv } = modes);
  });

  const mode = async (): Promise<unknown> => (await srv.get('/health', null)).json?.mode;
  const lastLocal = () => chatFacts(ollama.chats().at(-1)?.body);

  it('it starts in Cloud mode with both tool servers wired, and reached nothing but this machine while it booted', async () => {
    const health = (await srv.get('/health', null)).json!;
    expect(health).toMatchObject({ ok: true, mode: 'cloud', model: MAIN, servers: ['web', 'trident'] });
    expect(blocked(srv)).toEqual([]);
    // It never binds a live Flint's internal port: that listen was moved to a free one.
    expect(srv.guard().filter((e) => e.kind === 'listen').map((e) => e.port)).not.toContain(8081);
  });

  // Survivor 1: with the scope check switched off, every test passed. A voice or an eval token that reaches the
  // mode route could take Flint out of Local mode.
  it('a scoped token is refused on the mode routes, and the mode does not change; no token and a wrong one are refused too', async () => {
    for (const client of ['voice', 'evolve', 'parity']) {
      const token = srv.scoped(client);
      expect(token).toMatch(/^[0-9a-f]{32,}$/);
      expect((await srv.post('/inference/mode', { mode: 'local' }, token)).status, client).toBe(403);
      expect((await srv.post('/inference/mode', { reset: true }, token)).status, client).toBe(403);
      expect((await srv.get('/inference', token)).status, client).toBe(403);
      expect(await mode(), client).toBe('cloud');
    }
    expect((await srv.post('/inference/mode', { mode: 'local' }, null)).status).toBe(401);
    expect((await srv.post('/inference/mode', { mode: 'local' }, 'f'.repeat(64))).status).toBe(401);
    expect(await mode()).toBe('cloud');
    // The full token is refused only what is not a mode.
    expect(await srv.post('/inference/mode', { mode: 'turbo' })).toMatchObject({ status: 400, json: { error: 'The mode is Local, Hybrid or Cloud.' } });
    expect(srv.read('inference.json')).toBe(''); // nothing was saved by any of it
  });

  it('an ordinary turn in Cloud mode goes to the outside brain, with every tool, paid ones included', async () => {
    const before = cloud.requests.length;
    const r = await srv.post('/chat', { conversationId: 'open', message: 'An ordinary synthetic question about email and the web.' });
    expect(r.events?.[0]).toMatchObject({ type: 'meta', brain: 'frontier', route: { mode: 'cloud', reason: 'mode_cloud' } });
    expect(r.text).toMatch(/^CLOUD\(/);
    expect(cloud.requests).toHaveLength(before + 1);
    // The client is told, ahead of the reply, that this one may be sent out to be spoken, and which stored turn it is.
    expect(staysHere(r)).toMatchObject({ staysHere: false });
    expect(typeof staysHere(r)?.turn).toBe('string');
    // This server has no voice setting at all, so OpenAI speaks: the event is what it always was, exactly its three
    // keys. It never says the server's speech is made on this Mac (./voice.test.ts has the servers where it is).
    expect(Object.keys(staysHere(r)!).sort()).toEqual(['staysHere', 'turn', 'type']);
    const offered = names(cloud.requests.at(-1));
    expect(offered).toEqual(expect.arrayContaining(['remember', 'deep_research', 'web.web_search', 'web.fetch_url', 'trident.perplexity_search', 'trident.gmail_search']));
  });

  // M2, and survivor 4 (the list offer() filtered could be thrown away and the unfiltered one handed to the turn).
  it('a private turn is answered on this Mac, is offered ONLY tools that run here, and its model is told so', async () => {
    const before = cloud.requests.length;
    const r = await srv.post('/chat', { conversationId: 'c-private', message: `A private synthetic question ${SECRET}.`, localOnly: true });
    expect(r.events?.[0]).toMatchObject({ type: 'meta', brain: 'local', route: { mode: 'cloud', private: true } });
    expect(r.text).toBe(`LOCAL(${MAIN}) reply.`);
    // ...and the client is told, ahead of the reply, that it stays on this Mac (the console and the voice app
    // then speak it with the device's own voice).
    expect(staysHere(r)).toMatchObject({ staysHere: true });
    expect(Object.keys(staysHere(r)!).sort()).toEqual(['staysHere', 'turn', 'type']);
    // Not one request went to the outside brain for it.
    expect(cloud.requests).toHaveLength(before);
    const sent = lastLocal();
    expect(sent.last).toContain(SECRET);
    expect(sent.offered.sort()).toEqual(['calculate', 'remember', 'training_status']);
    for (const tool of sent.offered) expect(tool).not.toMatch(/^(web|trident)\.|deep_research/);
    expect(sent.system).toContain(PRIVATE_TURN_NOTE);
    // Private by its words alone, with no switch: the same.
    await srv.post('/chat', { conversationId: 'c-words', message: 'Keep this private: a second synthetic question.' });
    expect(lastLocal().offered.sort()).toEqual(['calculate', 'remember', 'training_status']);
    expect(cloud.requests).toHaveLength(before);
    // The one-shot route is held to the same list, and says the same thing to its model.
    const once = await srv.post('/generate', { prompt: `A private synthetic prompt ${SECRET}.`, localOnly: true });
    expect(once).toMatchObject({ status: 200, json: { brain: 'local', text: `LOCAL(${MAIN}) reply.`, route: { private: true } } });
    expect(lastLocal().offered.sort()).toEqual(['calculate', 'remember', 'training_status']);
    expect(lastLocal().system).toContain(PRIVATE_TURN_NOTE);
    expect(cloud.requests).toHaveLength(before);
  });

  it('a tool that reaches outside is not run on a private turn even when the model names it: no search, no page, no account, no research', async () => {
    for (const tool of ['web.web_search', 'web.fetch_url', 'trident.gmail_search', 'trident.perplexity_search', 'deep_research']) {
      const calls = mcp.calls().length;
      const cloudBefore = cloud.requests.length;
      const r = await srv.post('/chat', { conversationId: `c-tool-${tool}`, message: `CALL(${tool}) a private synthetic question.`, localOnly: true });
      expect(r.status, tool).toBe(200);
      expect(r.events?.some((e) => e.type === 'tool_call'), tool).toBe(true);
      // The model was told WHY, in the private rule's own sentence, and nothing reached a tool server or the cloud.
      // (It was once enough here that it was told "Unknown tool": that passes with the turn never marked private
      // where its tools are called, the privacy review's M33 and M34.)
      expect(told(lastLocal().toolResults), tool).toEqual([REFUSED_PRIVATE]);
      expect(mcp.calls().length, tool).toBe(calls);
      expect(cloud.requests.length, tool).toBe(cloudBefore);
    }
    // The one-shot route marks its turn the same way.
    const calls = mcp.calls().length;
    const once = await srv.post('/generate', { prompt: 'CALL(web.web_search) a private synthetic prompt.', localOnly: true });
    expect(once.status).toBe(200);
    expect(told(lastLocal().toolResults)).toEqual([REFUSED_PRIVATE]);
    expect(mcp.calls().length).toBe(calls);
    // A name that is no tool's at all still gets the plain answer, with what there is: the sentence is for a tool held back.
    await srv.post('/chat', { conversationId: 'c-tool-none', message: 'CALL(no_such_tool) a private synthetic question.', localOnly: true });
    expect(told(lastLocal().toolResults)).toEqual([{ error: expect.stringMatching(/^Unknown tool 'no_such_tool'\. Available tools: /) }]);
    expect(PRIVATE_TOOL_REFUSED).toMatch(/^This message is private/);
  });

  // Survivor 3: a brain's history view could hand every brain the raw store.
  it('the private turn never goes out later as history: the outside brain is sent a neutral line in its place, the local model reads it all', async () => {
    const before = cloud.requests.length;
    const r = await srv.post('/chat', { conversationId: 'c-private', message: 'An ordinary follow-up about gardening tools.' });
    expect(r.events?.[0]).toMatchObject({ brain: 'frontier' });
    const sent = JSON.stringify(cloud.requests.at(-1)?.body);
    expect(cloud.requests).toHaveLength(before + 1);
    expect(sent).not.toContain(SECRET);
    expect(sent).not.toContain('LOCAL(');
    expect(JSON.stringify(cloud.requests.at(-1)?.body?.messages)).toContain(HISTORY_GAP);
    // Nothing the outside brain was sent, in the whole run so far, holds the private text.
    expect(cloud.saw(SECRET)).toBe(false);
    // The local model, asked again in that conversation, is handed the private exchange back.
    await srv.post('/chat', { conversationId: 'c-private', message: 'A private follow-up.', localOnly: true });
    expect(lastLocal().text).toContain(SECRET);
    expect(lastLocal().text).not.toContain(HISTORY_GAP);
  });

  it('a turn that stays here is in the training corpus with its mark; an ordinary one has none', () => {
    const rows = srv.read('training', 'corpus.jsonl').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { input: string; brain: string; staysHere?: boolean });
    const priv = rows.find((r) => r.input.includes(SECRET))!;
    expect(priv).toMatchObject({ brain: 'local', staysHere: true });
    const open = rows.find((r) => r.input.startsWith('An ordinary synthetic question'))!;
    expect(open.brain).toBe('frontier');
    expect('staysHere' in open).toBe(false);
  });

  // The final review's H2: /speak believed the client. A client that did not say a reply was private (an older
  // console, the voice app, anything with the token) had the private reply's words sent to the speech service.
  it('a reply that stays here is never sent out to be spoken: the server refuses it by the turn it stored, whatever the client says', async () => {
    // (The store writes its file a moment after a turn: wait for it, a few seconds at most.)
    for (let i = 0; i < 100 && !srv.read('memory', 'conversations.json').includes('"private":true'); i++) await sleep(50);
    expect(srv.read('memory', 'conversations.json')).toMatch(/"context":\{"private":true\}/);
    const r = await srv.post('/chat', { conversationId: 'c-speech', message: 'A private synthetic question whose answer is to be spoken.', localOnly: true });
    const turn = staysHere(r)?.turn;
    expect(staysHere(r)).toMatchObject({ staysHere: true });
    expect(typeof turn).toBe('string');
    const text = 'Synthetic private words.';
    for (const body of [
      { text, conversationId: 'c-speech', turnId: turn }, // as the console sends it
      { text, conversationId: 'c-speech' }, // no turn named: the conversation's newest
      { text }, // nothing named at all (an older client): held to the strictest answer
      { text, conversationId: 'c-speech', turnId: 'no-such-turn' }, // a wrong name is not a weaker claim than no name
      { text, conversationId: 'c-speech', turnId: turn, private: false }, // the client's own word decides nothing
    ]) {
      expect(await srv.post('/speak', body), JSON.stringify(body)).toMatchObject({ status: 409, json: { fallback: 'browser' } });
    }
    // Not one of them reached the speech service: nothing was even looked up.
    expect(blocked(srv)).toEqual([]);
  });

  // The final review's H1, the `remember` path: what the model saved on a private turn was an ordinary fact, and
  // the next cloud turn about it was handed it as long-term memory.
  it('what the model saves on a private turn stays here: the outside brain is never given it, and the local model is', async () => {
    const saved = await srv.post('/chat', { conversationId: 'c-remember', message: 'CALL(remember) a private synthetic note about the spare key.', localOnly: true });
    expect(saved.events?.some((e) => e.type === 'tool_call')).toBe(true);
    expect(lastLocal().toolResults.join(' ')).toContain('saved');
    const stored = (JSON.parse(srv.read('memory', 'knowledge.json')) as { facts: Array<{ text: string; fromPrivate?: boolean; fromGoals?: boolean }> }).facts;
    expect(stored.find((f) => f.text === KEPT_FACT)).toMatchObject({ fromPrivate: true });
    expect(stored.find((f) => f.text === OPEN_FACT)?.fromPrivate).toBeUndefined();
    // An ordinary turn about that very thing goes to the outside brain. It is given the fact any brain may have,
    // so recall is working, and never the one that was saved on the private turn.
    const before = cloud.requests.length;
    const asked = await srv.post('/chat', { conversationId: 'c-ask', message: ASK_FACTS });
    expect(asked.events?.[0]).toMatchObject({ brain: 'frontier' });
    expect(cloud.requests).toHaveLength(before + 1);
    expect(JSON.stringify(cloud.requests.at(-1)?.body)).toContain('OPALHERON');
    expect(JSON.stringify(cloud.requests.at(-1)?.body)).not.toContain('GARNETFINCH');
    // The one-shot route has no per-ask gate: it recalls only what any brain may have, whoever answers.
    await srv.post('/generate', { prompt: ASK_FACTS });
    expect(cloud.requests).toHaveLength(before + 2);
    expect(JSON.stringify(cloud.requests.at(-1)?.body)).toContain('OPALHERON');
    await srv.post('/generate', { prompt: ASK_FACTS, localOnly: true });
    expect(lastLocal().system).toContain('OPALHERON');
    expect(lastLocal().system).not.toContain('GARNETFINCH');
    // The local model, on a private turn, is given both: recall for a brain on this Mac is whole.
    await srv.post('/chat', { conversationId: 'c-ask-private', message: ASK_FACTS, localOnly: true });
    expect(lastLocal().system).toContain('GARNETFINCH');
    expect(lastLocal().system).toContain('OPALHERON');
    // In the whole run so far the outside brain was never sent it.
    expect(cloud.saw('GARNETFINCH')).toBe(false);
  });

  // The privacy review's M25 and M32: the same two things on the one-shot route, which were checked by reading text.
  it('a private one-shot answer: what its model saves is marked, its corpus row is marked, and the outside brain gets neither', async () => {
    const r = await srv.post('/generate', { prompt: 'CALL(remember) a private one-shot synthetic note about the passport copy.', localOnly: true });
    expect(r).toMatchObject({ status: 200, json: { brain: 'local', route: { private: true } } });
    expect(lastLocal().toolResults.join(' ')).toContain('saved');
    expect(factsOf(srv).find((f) => f.text === ONESHOT_FACT)).toMatchObject({ fromPrivate: true });
    const rows = srv.read('training', 'corpus.jsonl').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { input: string; brain: string; staysHere?: boolean });
    expect(rows.find((row) => row.input.includes('one-shot synthetic note'))).toMatchObject({ brain: 'local', staysHere: true });
    // An ordinary one-shot answer's row carries no mark, so the mark means something.
    const open = rows.find((row) => row.input === ASK_FACTS && row.brain === 'frontier')!;
    expect(open).toBeDefined();
    expect('staysHere' in open).toBe(false);
    const before = cloud.requests.length;
    await srv.post('/chat', { conversationId: 'c-ask-3', message: 'Where does Will keep the passport copy and the garden shears?' });
    expect(cloud.requests).toHaveLength(before + 1);
    expect(JSON.stringify(cloud.requests.at(-1)?.body)).toContain('OPALHERON');
    expect(cloud.saw('AMBERKITE')).toBe(false);
  });

  it('the full token switches to Local mode: saved under this HOME, and the answer carries the sentences for it', async () => {
    const r = await srv.post('/inference/mode', { mode: 'local' });
    expect(r).toMatchObject({ status: 200, json: { ok: true, mode: 'local', previous: 'cloud', source: 'settings', modeSentence: 'Every answer comes from this Mac. Flint may still search the web.', localOnlySentence: 'Local mode keeps every answer on this Mac.' } });
    expect(await mode()).toBe('local');
    expect(JSON.parse(srv.read('inference.json'))).toMatchObject({ version: 1, mode: 'local', setBy: 'console' });
    expect(statSync(join(srv.home, '.flint', 'inference.json')).mode & 0o777).toBe(0o600);
    expect(srv.log()).toContain('[inference] mode cloud -> local (console)');
  });

  it('in Local mode not one request goes to the outside brain, whatever is asked', async () => {
    const before = cloud.requests.length;
    for (const body of [
      { conversationId: 'l1', message: 'An ordinary synthetic question in Local mode.' },
      { conversationId: 'l1', message: 'think hard: a deep synthetic question.', deep: true },
      { conversationId: 'l2', message: 'A long one. '.repeat(400) },
      { conversationId: 'c-private', message: 'Back in the conversation that has a private turn.' },
    ]) {
      const r = await srv.post('/chat', body);
      expect(r.events?.[0]).toMatchObject({ type: 'meta', brain: 'local', route: { mode: 'local', reason: 'mode_local' } });
      expect(r.text).toBe(`LOCAL(${MAIN}) reply.`);
    }
    // An eval replay that would go to a cloud model is refused, and one a local model answers runs.
    expect((await srv.post('/generate', { prompt: 'Synthetic eval replay.', eval: true }, srv.scoped('evolve'))).status).toBe(409);
    expect((await srv.post('/generate', { prompt: 'Synthetic eval replay, local.', eval: true, localOnly: true }, srv.scoped('evolve'))).status).toBe(200);
    // Speech is an outside service: refused, with the device's own voice as the way on.
    expect(await srv.post('/speak', { text: 'Synthetic words.' })).toMatchObject({ status: 503, json: { fallback: 'browser' } });
    expect(cloud.requests).toHaveLength(before);
    expect(blocked(srv)).toEqual([]);
  });

  // The re-review's N3 holds a turn of Local mode to the strict rule (nothing of it goes to a model that is not
  // confirmed on this Mac). On a healthy server that changes nothing: the turn is answered here, its words are
  // embedded for the router and for recall as before, and the model server is asked exactly what it was asked.
  it('a turn of Local mode on a healthy model server: answered on this Mac, with the same requests as ever', async () => {
    expect(await mode()).toBe('local');
    const counts = async (message: string) => {
      const from = ollama.requests.length;
      const r = await srv.post('/chat', { conversationId: `l-count-${from}`, message });
      expect(r.events?.[0]).toMatchObject({ brain: 'local', route: { mode: 'local', reason: 'mode_local' } });
      expect(r.text).toBe(`LOCAL(${MAIN}) reply.`);
      const made = ollama.requests.slice(from);
      const n = (method: string, path: string) => made.filter((q) => q.method === method && q.path === path).length;
      return { made, listing: n('GET', '/api/tags'), version: n('GET', '/api/version'), ps: n('GET', '/api/ps'), embeddings: n('POST', '/api/embeddings') + n('POST', '/api/embed'), chat: n('POST', '/api/chat') };
    };
    const first = await counts('A HEALTHYWORDA synthetic question about the tide tables.');
    const second = await counts('A HEALTHYWORDB synthetic question about the tide tables.');
    for (const c of [first, second]) {
      // One look (the turn asks the model server first), the turn's words embedded, one chat.
      expect({ listing: c.listing, version: c.version, ps: c.ps, embeddings: c.embeddings, chat: c.chat }).toEqual(LOCAL_TURN_REQUESTS);
    }
    // Its words were embedded on this Mac, by the model that Ollama lists as its own, and went to the main model.
    expect(first.made.some((q) => q.path === '/api/embeddings' && JSON.stringify(q.body).includes('HEALTHYWORDA'))).toBe(true);
    expect(first.made.some((q) => q.path === '/api/chat' && JSON.stringify(q.body).includes('HEALTHYWORDA'))).toBe(true);
    expect(cloud.saw('HEALTHYWORD')).toBe(false);
  });

  // M2 for Local mode, and survivor 2 (turns handed the tools without their meter: the search would have gone to
  // its paid provider, and nothing would have been refused at call time).
  it('Local mode offers the keyless search, the page fetch and the account tools, and no paid one; a search it runs is keyless', async () => {
    const calls = mcp.calls().length;
    const r = await srv.post('/chat', { conversationId: 'l-search', message: 'CALL(web.web_search) a synthetic question about email and the web.' });
    expect(r.events?.some((e) => e.type === 'tool_call')).toBe(true);
    const first = chatFacts(ollama.chats().at(-2)?.body);
    expect(first.offered).toEqual(expect.arrayContaining(['remember', 'web.web_search', 'web.fetch_url', 'trident.gmail_search']));
    for (const paid of PAID) expect(first.offered).not.toContain(paid);
    // The one call the tool server got carried the keyless switch, which only the meter sets.
    expect(mcp.calls().slice(calls)).toEqual([{ server: 'web', tool: 'web_search', args: { query: 'synthetic query', keyless: true } }]);
    // The model never sees that switch.
    const search = ((ollama.chats().at(-2)?.body?.tools ?? []) as Array<{ function: { name: string; parameters?: { properties?: Record<string, unknown> } } }>).find((t) => t.function.name === 'web.web_search')!;
    expect(Object.keys(search.function.parameters?.properties ?? {})).toEqual(['query']);
  });

  it('research in Local mode searches keyless and is refused the paid searches where they are called', async () => {
    const calls = mcp.calls().length;
    const r = await srv.post('/chat', { conversationId: 'l-research', message: 'CALL(deep_research) a synthetic research question.' });
    expect(r.status).toBe(200);
    const made = mcp.calls().slice(calls);
    expect(made.length).toBeGreaterThan(0);
    for (const c of made) {
      expect(`${c.server}.${c.tool}`).not.toBe('trident.perplexity_search');
      expect(`${c.server}.${c.tool}`).not.toBe('trident.web_search');
      if (c.tool === 'web_search') expect(c.args.keyless).toBe(true);
    }
  });

  // The other half of M33. A turn routed in Local mode keeps that mode's rule for as long as it runs: its model is
  // still thinking when the mode changes, and the search it then asks for must not become a paid one.
  it('a Local-mode turn that is still running when the mode changes keeps Local mode’s rule: its search is still keyless', async () => {
    const calls = mcp.calls().length;
    const before = cloud.requests.length;
    const asked = ollama.chats().length;
    ollama.chatDelayMs = 500;
    try {
      const turn = srv.post('/chat', { conversationId: 'l-outlives', message: 'CALL(web.web_search) a synthetic question about email and the web.' });
      // The model has been asked and has not answered yet: switch the mode under it.
      expect(await waitFor(() => ollama.chats().length > asked, 4000)).toBe(true);
      expect((await srv.post('/inference/mode', { mode: 'cloud' })).json).toMatchObject({ mode: 'cloud', previous: 'local' });
      const r = await turn;
      expect(r.events?.[0]).toMatchObject({ type: 'meta', brain: 'local', route: { mode: 'local' } });
      expect(r.events?.some((e) => e.type === 'tool_call')).toBe(true);
    } finally {
      ollama.chatDelayMs = 0;
    }
    expect(mcp.calls().slice(calls)).toEqual([{ server: 'web', tool: 'web_search', args: { query: 'synthetic query', keyless: true } }]);
    expect(cloud.requests).toHaveLength(before);
    expect((await srv.post('/inference/mode', { mode: 'local' })).json).toMatchObject({ mode: 'local', previous: 'cloud' });
  });

  it('a turn taken in Local mode stays here after the mode changes: the outside brain never gets it back, as history, as memory or as speech', async () => {
    const taken = await srv.post('/chat', { conversationId: 'l-then-cloud', message: `A Local mode synthetic question ${SECRET}LOCALMODE.` });
    expect(staysHere(taken)).toMatchObject({ staysHere: true });
    // What the model saves on a turn taken in Local mode is kept the same way (no switch was on, no words asked for it).
    await srv.post('/chat', { conversationId: 'l-remember', message: 'CALL(remember) a Local mode synthetic note about the bike lock.' });
    const stored = (JSON.parse(srv.read('memory', 'knowledge.json')) as { facts: Array<{ text: string; fromPrivate?: boolean }> }).facts;
    expect(stored.find((f) => f.text === LOCAL_MODE_FACT)).toMatchObject({ fromPrivate: true });
    expect((await srv.post('/inference/mode', { mode: 'cloud' })).json).toMatchObject({ mode: 'cloud', previous: 'local' });
    const before = cloud.requests.length;
    const r = await srv.post('/chat', { conversationId: 'l-then-cloud', message: 'An ordinary follow-up.' });
    expect(r.events?.[0]).toMatchObject({ brain: 'frontier' });
    expect(cloud.requests).toHaveLength(before + 1);
    expect(cloud.saw(`${SECRET}LOCALMODE`)).toBe(false);
    expect(JSON.stringify(cloud.requests.at(-1)?.body?.messages)).toContain(HISTORY_GAP);
    // Memory: a cloud turn about what was saved in Local mode is given the ordinary fact and not that one.
    await srv.post('/chat', { conversationId: 'c-ask-2', message: ASK_FACTS });
    expect(JSON.stringify(cloud.requests.at(-1)?.body)).toContain('OPALHERON');
    expect(cloud.saw('TOPAZWREN')).toBe(false);
    expect(cloud.saw('GARNETFINCH')).toBe(false);
    // Speech: the Local-mode turn's reply is refused by its stored turn, now that the mode itself refuses nothing.
    expect(await srv.post('/speak', { text: 'Synthetic words.', conversationId: 'l-then-cloud', turnId: staysHere(taken)?.turn })).toMatchObject({ status: 409, json: { fallback: 'browser' } });
  });

  // What the restart below mines (goals from chat): the same kind of sentence, said on each kind of turn.
  it('a goal is said on an ordinary turn, with Local Only on, in Local mode, and with Local Only on in Local mode', async () => {
    expect(await mode()).toBe('cloud');
    const open = await srv.post('/chat', { conversationId: GOALS_SAID.ordinary.conversationId, message: GOALS_SAID.ordinary.said });
    expect(open.events?.[0]).toMatchObject({ brain: 'frontier' });
    const priv = await srv.post('/chat', { conversationId: GOALS_SAID.localOnly.conversationId, message: GOALS_SAID.localOnly.said, localOnly: true });
    expect(priv.events?.[0]).toMatchObject({ brain: 'local', route: { mode: 'cloud', private: true } });
    expect((await srv.post('/inference/mode', { mode: 'local' })).json).toMatchObject({ mode: 'local' });
    const local = await srv.post('/chat', { conversationId: GOALS_SAID.localMode.conversationId, message: GOALS_SAID.localMode.said });
    expect(local.events?.[0]).toMatchObject({ brain: 'local', route: { mode: 'local', reason: 'mode_local' } });
    const both = await srv.post('/chat', { conversationId: GOALS_SAID.localOnlyInLocalMode.conversationId, message: GOALS_SAID.localOnlyInLocalMode.said, localOnly: true });
    expect(both.events?.[0]).toMatchObject({ brain: 'local', route: { mode: 'local', private: true } });
    expect((await srv.post('/inference/mode', { mode: 'cloud' })).json).toMatchObject({ mode: 'cloud' });
    // All three that stay here are told so, and only the one Local mode alone kept carries the note on its mark.
    for (const r of [priv, local, both]) expect(staysHere(r)).toMatchObject({ staysHere: true });
    expect(staysHere(open)).toMatchObject({ staysHere: false });
    await waitFor(() => Object.values(GOALS_SAID).every((g) => srv.read('memory', 'conversations.json').includes(g.word)));
    const stored = (JSON.parse(srv.read('memory', 'conversations.json')) as { conversations: Record<string, Array<{ context?: unknown }>> }).conversations;
    expect(stored[GOALS_SAID.ordinary.conversationId]!.map((t) => t.context)).toEqual([undefined]);
    expect(stored[GOALS_SAID.localOnly.conversationId]!.map((t) => t.context)).toEqual([{ private: true }]);
    expect(stored[GOALS_SAID.localMode.conversationId]!.map((t) => t.context)).toEqual([{ private: true, byMode: true }]);
    expect(stored[GOALS_SAID.localOnlyInLocalMode.conversationId]!.map((t) => t.context)).toEqual([{ private: true }]);
  });

  // The follow-up review's F1. The note "kept by Local mode alone" lets a turn be asked for the goal he set in it.
  // A turn of Local mode that was HANDED one he asked to keep private is not that: its model read the private
  // thing, and here repeats it. It is stored as his word, the same rule as outside Local mode.
  it('a turn of Local mode that was handed one he asked to keep private is stored as his word; in a conversation of its own it carries the note', async () => {
    expect(await mode()).toBe('cloud');
    // The chat "model" repeats what it was handed of the private turn, as a helpful model does.
    ollama.replyFor = (body, last) => (body.format === undefined && last === LEAK.asked && JSON.stringify(body.messages).includes(LEAK.word) ? LEAK.restated : undefined);
    try {
      const said = await srv.post('/chat', { conversationId: 'leak', message: LEAK.kept, localOnly: true });
      expect(said.events?.[0]).toMatchObject({ brain: 'local', route: { mode: 'cloud', private: true } });
      expect((await srv.post('/inference/mode', { mode: 'local' })).json).toMatchObject({ mode: 'local' });
      const asked = await srv.post('/chat', { conversationId: 'leak', message: LEAK.asked });
      const after = await srv.post('/chat', { conversationId: 'leak', message: LEAK.after });
      const apart = await srv.post('/chat', { conversationId: 'leak-apart', message: LEAK.apart });
      for (const r of [asked, after, apart]) expect(r.events?.[0]).toMatchObject({ brain: 'local', route: { mode: 'local', reason: 'mode_local' } });
      // The second turn's model was handed the first, and said it back.
      expect(asked.text).toBe(LEAK.restated);
    } finally {
      ollama.replyFor = undefined;
    }
    expect((await srv.post('/inference/mode', { mode: 'cloud' })).json).toMatchObject({ mode: 'cloud' });
    await waitFor(() => srv.read('memory', 'conversations.json').includes('follow-up scan'));
    const stored = (JSON.parse(srv.read('memory', 'conversations.json')) as { conversations: Record<string, Array<{ context?: unknown }>> }).conversations;
    expect(stored.leak!.map((t) => t.context)).toEqual([{ private: true }, { private: true }, { private: true }]);
    expect(stored['leak-apart']!.map((t) => t.context)).toEqual([{ private: true, byMode: true }]);
    expect(cloud.saw(LEAK.word)).toBe(false);
  });

  it('the log holds none of what was asked or answered, and every [route] line is made of the fields on the list', () => {
    const log = srv.log();
    expect(log).not.toContain(SECRET);
    expect(log).not.toContain(LEAK.word);
    for (const g of Object.values(GOALS_SAID)) expect(log, g.word).not.toContain(g.word);
    expect(log).not.toMatch(/LOCAL\(|CLOUD\(|synthetic question|Synthetic words|Synthetic private words/);
    for (const canary of ['GARNETFINCH', 'TOPAZWREN', 'OPALHERON']) expect(log).not.toContain(canary);
    expect(log).not.toContain('process-test-token');
    expect(log).not.toContain('sk-ant-process-test');
    const routes = routeLines(log);
    expect(routes.length).toBeGreaterThanOrEqual(12);
    const allowed = new Set<string>(['ts', ...ROUTE_FIELDS]);
    for (const line of routes) for (const key of Object.keys(line)) expect(allowed.has(key), key).toBe(true);
    // Each kind of turn left its line: an outside answer, a private one, a Local-mode one.
    expect(routes.some((r) => r.brain === 'frontier' && r.mode === 'cloud' && r.provider === 'anthropic')).toBe(true);
    expect(routes.some((r) => r.brain === 'local' && r.private === true && r.mode === 'cloud')).toBe(true);
    expect(routes.some((r) => r.brain === 'local' && r.mode === 'local' && r.reason === 'mode_local' && r.private === undefined)).toBe(true);
  });

  it('in the whole run the process reached nothing but this machine', () => {
    expect(blocked(srv)).toEqual([]);
    expect(srv.guard().some((e) => e.kind === 'connect')).toBe(true); // ...and the fence was really there
  });
});

// M1. Cloud mode with the local model server on another machine (the documented remote OLLAMA_HOST): a Local Only
// turn was sent to that server, under a Mode row that said private messages stay on this Mac.
describe('the real server, as a process: Cloud mode with a model server that is not this Mac', () => {
  let cloud: CloudStub;
  let there: OllamaStub;
  let srv: Running;

  beforeAll(async () => {
    ({ cloud, there, srv } = remote);
    // The server looks at its model server once behind its boot.
    await waitFor(() => srv.log().includes('[local] provider=ollama'));
  });

  it('a private turn is refused with a sentence, and nothing of it is sent anywhere: not to that server, not to the cloud', async () => {
    expect((await srv.get('/health', null)).json).toMatchObject({ mode: 'cloud' });
    expect(srv.log()).toMatch(/\[local\] provider=ollama wire=native server=ollama [^\n]* loopback=no/);
    // That machine is really reached (the fence carried the server's looks to the stand-in), so what follows is the
    // rule and not a dead wire.
    expect(there.requests.some((q) => q.path === '/api/tags')).toBe(true);
    const before = { there: there.requests.length, cloud: cloud.requests.length };
    for (const body of [
      { conversationId: 'm1', message: `A private synthetic question ${SECRET}.`, localOnly: true },
      { conversationId: 'm1', message: `Keep this private: ${SECRET} again.` },
    ]) {
      const r = await srv.post('/chat', body);
      expect(r).toMatchObject({ status: 503, json: { error: 'The local model server is on another machine, and a private message never leaves this Mac.' } });
    }
    const viaGenerate = await srv.post('/generate', { prompt: `A private synthetic prompt ${SECRET}.`, localOnly: true });
    expect(viaGenerate).toMatchObject({ status: 503, json: { error: 'The local model server is on another machine, and a private message never leaves this Mac.' } });
    // The other machine was sent nothing for them: no chat, no embedding of the words. (A look at whether it is
    // there is a GET that carries nothing, and is all it may have had.)
    await sleep(150);
    const during = there.requests.slice(before.there);
    expect(during.filter((q) => q.method !== 'GET')).toEqual([]);
    expect(during.filter((q) => q.body !== undefined)).toEqual([]);
    expect(there.saw(SECRET)).toBe(false);
    expect(cloud.requests).toHaveLength(before.cloud);
    expect(cloud.saw(SECRET)).toBe(false);
    expect(blocked(srv)).toEqual([]);
  });

  it('an ordinary turn is as it always was in Cloud mode: the outside brain answers', async () => {
    const r = await srv.post('/chat', { conversationId: 'm2', message: 'An ordinary synthetic question.' });
    expect(r.events?.[0]).toMatchObject({ type: 'meta', brain: 'frontier' });
    expect(r.text).toMatch(/^CLOUD\(/);
  });

  it('the status says the same thing the refusal did', async () => {
    const st = (await srv.get('/inference')).json as { local: { confined: boolean; notConfined?: string; primary: { sentence: string } } };
    expect(st.local).toMatchObject({ confined: false, notConfined: 'remote_host' });
    expect(st.local.primary.sentence).toBe('The local model server is on another machine, so Local and Hybrid modes will not use it.');
    expect(srv.log()).not.toContain(SECRET);
  });
});

// The final review's H3 and H1 (the extractor path), and the other half of H2.
//
// H3. `ollama cp gpt-oss:120b-cloud mine` gives a cloud model a plain name. Nothing in the name says so and the
// address is this Mac's, so a private turn, and every turn of Local mode, was answered on Ollama's servers. Only
// Ollama can say, and its listing does: the server takes its word.
//
// H1, the extractor. What memory extraction learned from a private turn was an ordinary fact, and the next cloud
// turn about it was handed it. Here a REAL pass runs, on a local model, over a stored private turn and an ordinary one.
describe('the real server, as a process: a cloud model under a plain name, and what memory extraction learns', () => {
  let ollama: OllamaStub;
  let cloud: CloudStub;
  let srv: Running;
  const askedOf = (model: string) => ollama.chats().filter((c) => String(c.body?.model) === model || String(c.body?.model) === model.replace(':latest', ''));
  const extractions = () => ollama.chats().filter((c) => String(c.body?.model) === MEMORY_MODEL);

  beforeAll(async () => {
    ({ ollama, cloud, srv } = alias);
    // The first pass of memory extraction runs a moment after boot: wait for it to finish (a few seconds at most).
    for (let i = 0; i < 200 && !srv.log().includes('[memory-extract] v2 local pass:'); i++) await sleep(25);
  });

  it('the pass ran on the local model, with the private turn in a call of its own', () => {
    expect(srv.log()).toMatch(/\[memory-extract\] v2 local pass: sent 2 turn\(s\) in 2 call\(s\) \(skipped synthetic=0 trivial=0 duplicate=0 tainted=0\); 2 candidate\(s\) → stored 2/);
    const prompts = extractions().map((c) => chatFacts(c.body).last);
    expect(prompts).toHaveLength(2);
    expect(prompts.filter((p) => p.includes('JASPERLARK'))).toHaveLength(1);
    expect(prompts.filter((p) => p.includes('CORALSWIFT'))).toHaveLength(1);
    // Nothing of either turn went to the outside brain to be mined.
    expect(cloud.saw('JASPERLARK')).toBe(false);
    expect(cloud.saw('CORALSWIFT')).toBe(false);
  });

  // P3 part 5 (goals from chat, FLINT_EXTRACT_CANDIDATES=1), on an extractor whose model IS on this Mac: the ordinary
  // turn is asked for a goal too, and the one whose quote is Will's own is handed to the runtime. The turn he kept
  // private is asked for facts alone: a suggestion is his own sentence on its way to being a goal.
  it('goals from chat: an ordinary turn’s suggestion is filed with the runtime on this Mac; a private turn is never asked for one', async () => {
    const { runtime } = alias;
    await waitFor(() => runtime.candidates().length > 0);
    expect(runtime.candidates()).toEqual([
      { kind: 'goal', text: 'Keep the ladder in the CORALSWIFT garage', quote: EXTRACT_OPEN, conversationId: 'open-1', turnId: 'turn_open', sourceAt: expect.stringMatching(/^20\d\d-\d\d-\d\dT/) },
    ]);
    const asked = (word: string) => extractions().find((c) => chatFacts(c.body).last.includes(word))!;
    // The ordinary turn's call asked for goals (the lines in the prompt, and the reply held to a schema with them).
    expect(chatFacts(asked('CORALSWIFT').body).last).toContain(SUGGEST_GOALS_PROMPT);
    expect(JSON.stringify(asked('CORALSWIFT').body?.format)).toContain('suggestions');
    // The private turn's call did not, and the goal its reply carried anyway was not read.
    expect(chatFacts(asked('JASPERLARK').body).last).not.toContain(SUGGEST_GOALS_PROMPT);
    expect(JSON.stringify(asked('JASPERLARK').body?.format)).not.toContain('suggestions');
    expect(runtime.saw('JASPERLARK')).toBe(false);
    // One suggestion was read (the ordinary turn's), and one turn was not asked: counts, and none of his words.
    expect(srv.log()).toMatch(/\[memory-extract\] v2 local pass: [^\n]*rejected suggestion-private-turn=1; 1 suggestion\(s\) → kept 1, filed 1; /);
  });

  it('what it learned from the private turn is marked, and what it learned from the ordinary one is not', () => {
    const facts = (JSON.parse(srv.read('memory', 'knowledge.json')) as { facts: Array<{ text: string; fromPrivate?: boolean; conversationId?: string }> }).facts;
    expect(facts.find((f) => f.text === PRIVATE_LEARNED)).toMatchObject({ fromPrivate: true, conversationId: 'kept-1' });
    const open = facts.find((f) => f.text === OPEN_LEARNED)!;
    expect(open).toMatchObject({ conversationId: 'open-1' });
    expect('fromPrivate' in open).toBe(false);
  });

  it('a cloud turn about both is given the ordinary fact and never the private one; nor is the private turn its history', async () => {
    const before = cloud.requests.length;
    const r = await srv.post('/chat', { conversationId: 'ask-1', message: 'Where does Will keep the passport and the ladder?' });
    expect(r.events?.[0]).toMatchObject({ brain: 'frontier' });
    expect(cloud.requests).toHaveLength(before + 1);
    const sent = JSON.stringify(cloud.requests.at(-1)?.body);
    expect(sent).toContain('CORALSWIFT');
    expect(sent).not.toContain('JASPERLARK');
    // The same question in the conversation that holds the private turn: a neutral line stands where it was.
    await srv.post('/chat', { conversationId: 'kept-1', message: 'Where does Will keep the passport and the ladder?' });
    expect(JSON.stringify(cloud.requests.at(-1)?.body?.messages)).toContain(HISTORY_GAP);
    await srv.post('/generate', { prompt: 'Where does Will keep the passport and the ladder?' });
    expect(cloud.saw('JASPERLARK')).toBe(false);
  });

  it('the status says the local model is a cloud model, in a sentence, though its name and its address say nothing', async () => {
    expect((await srv.get('/health', null)).json).toMatchObject({ mode: 'cloud', model: 'mine' });
    const st = (await srv.get('/inference')).json as { local: { confined: boolean; notConfined?: string; primary: { sentence: string } } };
    expect(st.local).toMatchObject({ confined: false, notConfined: 'cloud_model' });
    expect(st.local.primary.sentence).toBe("The local model is an Ollama cloud model, which runs on Ollama's servers, so Local and Hybrid modes will not use it.");
  });

  it('a private turn is refused with a sentence, and that model is never asked: not by /chat, not by /generate', async () => {
    const before = { model: askedOf(ALIAS).length, cloud: cloud.requests.length };
    const SENTENCE = "The local model is one that runs on Ollama's servers, and a private message never leaves this Mac.";
    expect(await srv.post('/chat', { conversationId: 'p-1', message: `A private synthetic question ${SECRET}.`, localOnly: true })).toMatchObject({ status: 503, json: { error: SENTENCE } });
    expect(await srv.post('/chat', { conversationId: 'p-1', message: `Keep this private: ${SECRET} again.` })).toMatchObject({ status: 503, json: { error: SENTENCE } });
    expect(await srv.post('/generate', { prompt: `A private synthetic prompt ${SECRET}.`, localOnly: true })).toMatchObject({ status: 503, json: { error: SENTENCE } });
    expect(askedOf(ALIAS)).toHaveLength(before.model);
    expect(cloud.requests).toHaveLength(before.cloud);
    expect(ollama.requests.some((q) => JSON.stringify(q.body ?? '').includes(SECRET))).toBe(false); // not even to be embedded
  });

  it('Local mode does not use it either: every turn gets the sentence, and nothing is asked of that model or of the cloud', async () => {
    expect((await srv.post('/inference/mode', { mode: 'local' })).json).toMatchObject({ mode: 'local' });
    const before = { model: askedOf(ALIAS).length, cloud: cloud.requests.length };
    const r = await srv.post('/chat', { conversationId: 'l-1', message: `An ordinary synthetic question in Local mode ${SECRET}.` });
    expect(r).toMatchObject({ status: 503, json: { error: "The local model is one that runs on Ollama's servers, and Local mode never uses the cloud." } });
    expect(askedOf(ALIAS)).toHaveLength(before.model);
    expect(cloud.requests).toHaveLength(before.cloud);
    expect((await srv.post('/inference/mode', { mode: 'cloud' })).json).toMatchObject({ mode: 'cloud' });
  });

  // The other half of H2: the rule holds a reply that stays here, and nothing else. An ordinary reply is still sent
  // to the speech service (here the fence stops the request, and that one attempt is the proof it was made).
  it('an ordinary reply may be sent out to be spoken: the speech service is asked for it, and for nothing that stays here', async () => {
    const r = await srv.post('/chat', { conversationId: 'speak-1', message: 'An ordinary synthetic question to be spoken.' });
    expect(staysHere(r)).toMatchObject({ staysHere: false });
    expect(r.text).toMatch(/^CLOUD\(/);
    expect(blocked(srv)).toEqual([]);
    // The stored private turn's reply: refused by its turn, and the speech service is not looked up.
    expect(await srv.post('/speak', { text: 'Noted.', conversationId: 'kept-1', turnId: 'turn_kept' })).toMatchObject({ status: 409, json: { fallback: 'browser' } });
    expect(blocked(srv)).toEqual([]);
    // The privacy review's N3: a turn that may be spoken vouches for its own words and no others. The private
    // reply's words under the ordinary turn's name are refused...
    expect(await srv.post('/speak', { text: 'Noted.', conversationId: 'speak-1', turnId: staysHere(r)?.turn })).toMatchObject({ status: 409, json: { fallback: 'browser' } });
    expect(await srv.post('/speak', { text: `${r.text} Noted.`, conversationId: 'speak-1', turnId: staysHere(r)?.turn })).toMatchObject({ status: 409 });
    // ...and so is a request that names only a conversation which still carries a kept turn, whatever words it sends.
    expect(await srv.post('/speak', { text: r.text, conversationId: 'kept-1' })).toMatchObject({ status: 409, json: { fallback: 'browser' } });
    expect(blocked(srv)).toEqual([]);
    // The ordinary reply's own words, under its own turn: sent (the fence stops the one lookup).
    const spoken = await srv.post('/speak', { text: r.text, conversationId: 'speak-1', turnId: staysHere(r)?.turn });
    expect(spoken.status).not.toBe(409);
    expect(blocked(srv).map((e) => [e.kind, e.hostname])).toEqual([['dns-blocked', 'api.openai.com']]);
    // A sentence of it, as the console sends one: the same.
    expect((await srv.post('/speak', { text: 'reply.', conversationId: 'speak-1', turnId: staysHere(r)?.turn })).status).not.toBe(409);
    expect(blocked(srv)).toHaveLength(2);
  });

  it('the log holds none of it', () => {
    const log = srv.log();
    for (const word of [SECRET, 'JASPERLARK', 'CORALSWIFT', 'Synthetic ordinary words', 'sk-ant-process-test']) expect(log, word).not.toContain(word);
  });
});

// The privacy review's N1. The alias check held on the OpenAI-compatible wire only once the server had been HEARD
// as an Ollama at that exact address; until then "not known to be an Ollama" was taken as "so it is local". Four
// ways in were found. Two of them here: the settings calling the server a plain OpenAI-compatible one, and the
// server not being up when Flint booted. In both a private turn, a private one-shot answer and every turn of Local
// mode were answered by the cloud model, which was sent the words.
describe('the real server, as a process: a cloud model under a plain name, asked over the OpenAI-compatible wire', () => {
  /** Everything a server could be asked for a turn that stays here, and what the model server was then sent. */
  const probe = async (srv: Running, mock: MockLocalServer, cloud: CloudStub, label: string) => {
    const before = { chats: mock.chats().length, cloud: cloud.requests.length, all: mock.requests.length };
    expect(await srv.post('/chat', { conversationId: `${label}-1`, message: `A private synthetic question ${SECRET}.`, localOnly: true }), label).toMatchObject({ status: 503, json: { error: CLOUD_MODEL_PRIVATE } });
    expect(await srv.post('/chat', { conversationId: `${label}-1`, message: `Keep this private: ${SECRET} again.` }), label).toMatchObject({ status: 503, json: { error: CLOUD_MODEL_PRIVATE } });
    expect(await srv.post('/generate', { prompt: `A private synthetic prompt ${SECRET}.`, localOnly: true }), label).toMatchObject({ status: 503, json: { error: CLOUD_MODEL_PRIVATE } });
    expect((await srv.post('/inference/mode', { mode: 'local' })).json).toMatchObject({ mode: 'local' });
    expect(await srv.post('/chat', { conversationId: `${label}-2`, message: `An ordinary synthetic question in Local mode ${SECRET}.` }), label).toMatchObject({ status: 503, json: { error: CLOUD_MODEL_LOCAL_MODE } });
    expect((await srv.post('/inference/mode', { mode: 'cloud' })).json).toMatchObject({ mode: 'cloud' });
    // The model was not asked once, and not a word of any of it reached its server (to be embedded, say) or the cloud.
    expect(mock.chats(), label).toHaveLength(before.chats);
    expect(mock.requests.slice(before.all).some((q) => JSON.stringify(q.body ?? '').includes(SECRET)), label).toBe(false);
    expect(cloud.requests, label).toHaveLength(before.cloud);
    // Settings says what it is, in the sentence the refusals gave: never "It loads when a private message needs it."
    const st = (await srv.get('/inference')).json as { local: { confined: boolean; notConfined?: string; primary: { sentence: string } } };
    expect(st.local, label).toMatchObject({ confined: false, notConfined: 'cloud_model' });
    expect(st.local.primary.sentence, label).toBe(CLOUD_MODEL_ROW);
    expect(srv.log(), label).not.toContain(SECRET);
  };

  it('N1 (a): FLINT_LOCAL_SERVER=openai says what kind of server it is; the server is asked what it is all the same, and it is an Ollama', async () => {
    const { mock, cloud, srv } = wire;
    await waitFor(() => srv.log().includes('[local] provider=openai'));
    // Taken at Will's word for how it is asked...
    expect(srv.log()).toMatch(/\[local\] provider=openai wire=openai-compatible server=openai host=127\.0\.0\.1:\d+ loopback=yes/);
    await probe(srv, mock, cloud, 'wire');
    // ...and asked the one question only an Ollama answers with a listing, at every look.
    expect(mock.requests.some((q) => q.method === 'GET' && q.path === '/api/tags')).toBe(true);
    // An ordinary turn in Cloud mode is as it always was.
    const r = await srv.post('/chat', { conversationId: 'wire-3', message: 'An ordinary synthetic question.' });
    expect(r.events?.[0]).toMatchObject({ type: 'meta', brain: 'frontier' });
    expect(blocked(srv)).toEqual([]);
  });

  // P3 part 5 meets N1. Goals from chat are asked only of an extractor whose model is on this Mac, by the one rule
  // (brainIsLocal). Here the setting is on, a runtime is there to file with, and the extractor's model is the cloud
  // model under a plain name, on a server the settings call a plain OpenAI-compatible one.
  it('goals from chat, with the local model a cloud model under a plain name: no suggestion is asked for, and nothing is filed', async () => {
    const { mock, runtime, srv } = wire;
    expect(await waitFor(() => /\[memory-extract\] v2 local pass: sent 1 turn/.test(srv.log()))).toBe(true);
    // The pass ran, on that model, as an ordinary turn's always could in Cloud mode: it was asked for facts...
    const mined = mock.requests.filter((q) => q.path === '/api/chat' && q.body?.format !== undefined);
    expect(mined.length).toBeGreaterThan(0);
    expect(mined.some((q) => chatFacts(q.body).last.includes('PEARLFINCH'))).toBe(true);
    // ...and for nothing else: no call's prompt asks for goals or commitments, and no reply is held to a schema with them.
    for (const q of mined) {
      const prompt = chatFacts(q.body).last;
      expect(prompt).not.toContain(SUGGEST_PROMPT);
      expect(prompt).not.toContain(SUGGEST_GOALS_PROMPT);
      expect(JSON.stringify(q.body?.format)).not.toContain('suggestions');
    }
    // The goal its reply carried anyway was not read: the runtime was handed nothing.
    await sleep(150);
    expect(runtime.candidates()).toEqual([]);
    expect(runtime.saw('PEARLFINCH')).toBe(false);
    // The log says the setting is waiting for a model on this Mac, and carries none of his words.
    expect(srv.log()).toContain(WAITING);
    expect(srv.log()).not.toMatch(/suggestion\(s\) → kept/);
    expect(srv.log()).not.toContain('PEARLFINCH');
  });

  it('N1 (b): the model server was not up when Flint booted: nothing is asked of it until it has said what it is, and then it is a cloud model', async () => {
    const { mock, cloud, srv, port, closers } = late;
    await waitFor(() => srv.log().includes('[local] provider=openai'));
    // Nothing answered at boot, so the wire's own guess stands for the kind of server.
    expect(srv.log()).toMatch(/\[local\] provider=openai wire=openai-compatible server=openai /);
    // Still down: a private turn has nobody to answer it, and says so. It is not sent to the cloud instead.
    const down = await srv.post('/chat', { conversationId: 'late-0', message: `A private synthetic question ${SECRET}.`, localOnly: true });
    expect(down.status).toBe(503);
    expect(String(down.json?.error)).not.toBe(CLOUD_MODEL_PRIVATE);
    expect(cloud.requests).toEqual([]);
    // It comes up. The very next turn that stays here asks it what it is before a word is sent.
    const up = await forward(port, Number(new URL(mock.origin).port));
    closers.push(() => up.close());
    await probe(srv, mock, cloud, 'late');
    expect(mock.requests.some((q) => q.method === 'GET' && q.path === '/api/tags')).toBe(true);
    expect(blocked(srv)).toEqual([]);
  });
});

// N1 (d), and the goals promise it touched. A TIER named `local:<name>` is asked over the OpenAI-compatible wire. On
// an ordinary Cloud-mode turn the cloud model under a plain name was handed the stored private turn as history and
// the private fact, and by the same rule it would have been handed Will's goals. No private message was needed.
describe('the real server, as a process: a tier on the OpenAI-compatible wire, a cloud model under a plain name beside a real local model', () => {
  let ollama: OllamaStub;
  let mock: MockLocalServer;
  let srv: Running;
  const tierChats = (model: string) => mock.chats().filter((q) => q.path === '/v1/chat/completions' && q.model === model);
  const KEPT_WORDS = ['PRIVWORDT', 'GARNETFINCH'];
  const GOALS_WORDS = ['GOALWORDT', 'MARLINGOAL'];
  const embedded = (stub: OllamaStub, word: string, from = 0) => stub.requests.slice(from).some((q) => q.path.startsWith('/api/embed') && JSON.stringify(q.body ?? '').includes(word));

  beforeAll(async () => {
    ({ ollama, mock, srv } = tier);
    await waitFor(() => srv.log().includes('[local] provider=ollama'));
    // The tiers' Ollama is not the main model's: the server asks it what it lists because a tier is named on it.
    await waitFor(() => mock.requests.some((q) => q.method === 'GET' && q.path === '/api/tags'));
  });

  it('the cloud model as a tier is asked as an outside brain: not the private turn, not the private fact, not the goals turn, not the goals fact', async () => {
    expect(srv.log()).toContain(`[brain] frontier escalation ENABLED -> local:${ALIAS}`);
    const r = await srv.post('/chat', { conversationId: 'mix', message: 'Where does Will keep the spare key, the garden shears and the regatta entry?' });
    expect(r.events?.[0]).toMatchObject({ type: 'meta', brain: 'frontier', model: `local:${ALIAS}`, route: { mode: 'cloud' } });
    expect(r.text).toBe('ALIAS-ANSWERED-ON-OLLAMA-SERVERS.');
    const asked = tierChats(ALIAS);
    expect(asked).toHaveLength(1);
    const sent = JSON.stringify(asked[0]!.body);
    for (const word of [...KEPT_WORDS, ...GOALS_WORDS]) expect(sent, word).not.toContain(word);
    // It is given what any brain may have, so recall and history are working: the ordinary fact, and a neutral line
    // where the turns that stay here were.
    expect(sent).toContain('OPALHERON');
    expect(sent).toContain(HISTORY_GAP);
    // Its reply is an ordinary one: nothing in it stays here.
    expect(staysHere(r)).toMatchObject({ staysHere: false });
  });

  it('a real local model on that same wire IS a brain on this Mac, on its Ollama’s word: it reads the turns and the facts that stay here', async () => {
    // (Told apart from the alias by nothing but what the server lists: same wire, same address, a plain name.)
    const r = await srv.post('/chat', { conversationId: 'mix', message: 'Think it through step by step: where does Will keep the spare key, the garden shears and the regatta entry?' });
    expect(r.events?.[0]).toMatchObject({ type: 'meta', brain: 'frontier', tier: 'hard', model: `local:${REAL}` });
    expect(r.text).toBe('REAL-LOCAL reply.');
    const asked = tierChats(REAL);
    expect(asked).toHaveLength(1);
    const sent = JSON.stringify(asked[0]!.body);
    // The turn he kept private and the fact from it, the turn answered with his goals and the fact from that, and the ordinary fact.
    for (const word of [...KEPT_WORDS, ...GOALS_WORDS, 'OPALHERON']) expect(sent, word).toContain(word);
    expect(staysHere(r)).toMatchObject({ staysHere: true });
    // The alias was asked nothing more.
    expect(tierChats(ALIAS)).toHaveLength(1);
    tierAskedAt = Date.now();
  });

  // N9. The embedding model here is a cloud model under a plain name: it embeds on Ollama's servers. An ordinary
  // message in Cloud mode is sent to it as it always was; a private message's words are not.
  it('N9: a private message is never sent to an embedding model that runs on Ollama’s servers, whatever its name and address say', async () => {
    const before = ollama.requests.length;
    await srv.post('/chat', { conversationId: 'n9', message: 'An ordinary synthetic question about EMBEDOPEN.' });
    expect(embedded(ollama, 'EMBEDOPEN', before)).toBe(true); // the embedder is there, and is used
    const r = await srv.post('/chat', { conversationId: 'n9', message: 'A private synthetic question about EMBEDKEPT.', localOnly: true });
    expect(r.status).toBe(200);
    expect(r.text).toBe(`LOCAL(${MAIN}) reply.`); // the chat model is a real one, and answered
    await srv.post('/generate', { prompt: 'A private synthetic prompt about EMBEDKEPT.', localOnly: true });
    expect(embedded(ollama, 'EMBEDKEPT')).toBe(false);
    expect(ollama.requests.filter((q) => q.path !== '/api/chat').some((q) => JSON.stringify(q.body ?? '').includes('EMBEDKEPT'))).toBe(false);
  });

  // N5. In Cloud mode nothing watches the model server. `ollama cp gpt-oss:120b-cloud main-model:30b` while Flint
  // runs: the name kept answering private turns until the next look, up to a minute later.
  it('N5: a name pointed at a cloud model while Flint runs is caught by the very next private turn, on either route, before a word of it is sent', async () => {
    expect((await srv.get('/health', null)).json).toMatchObject({ mode: 'cloud' });
    const chats = () => ollama.chats().length;
    const ok = await srv.post('/chat', { conversationId: 'n5', message: 'A private synthetic question REPOINTBEFORE.', localOnly: true });
    expect(ok.status).toBe(200);
    expect(ok.text).toBe(`LOCAL(${MAIN}) reply.`);
    // The one-shot route, from a state where the model was last seen to run here.
    ollama.models[MAIN]!.remoteHost = 'https://ollama.com:443';
    let before = { chats: chats(), all: ollama.requests.length };
    expect(await srv.post('/generate', { prompt: 'A private synthetic prompt REPOINTONE.', localOnly: true })).toMatchObject({ status: 503, json: { error: CLOUD_MODEL_PRIVATE } });
    expect(chats()).toBe(before.chats);
    expect(ollama.requests.slice(before.all).some((q) => q.path === '/api/tags')).toBe(true);
    // Pointed back at a model of its own: the next private turn hears that too, and is answered.
    delete ollama.models[MAIN]!.remoteHost;
    expect((await srv.post('/chat', { conversationId: 'n5', message: 'A private synthetic question REPOINTBACK.', localOnly: true })).status).toBe(200);
    // /chat, from that state.
    ollama.models[MAIN]!.remoteHost = 'https://ollama.com:443';
    before = { chats: chats(), all: ollama.requests.length };
    expect(await srv.post('/chat', { conversationId: 'n5', message: 'A private synthetic question REPOINTTWO.', localOnly: true })).toMatchObject({ status: 503, json: { error: CLOUD_MODEL_PRIVATE } });
    expect(chats()).toBe(before.chats);
    // Its server was asked what runs on it, and sent nothing else: not the words, to be answered or to be embedded.
    const during = ollama.requests.slice(before.all);
    expect(during.some((q) => q.path === '/api/tags')).toBe(true);
    expect(ollama.saw('REPOINTONE')).toBe(false);
    expect(ollama.saw('REPOINTTWO')).toBe(false);
    expect(blocked(srv)).toEqual([]);
    expect(srv.log()).not.toMatch(/PRIVWORDT|GARNETFINCH|GOALWORDT|MARLINGOAL|REPOINT|EMBEDKEPT/);
  });
});

// The privacy review's N2 (its case E2), and the embedder's own rule (M29). The local model is on this Mac, over the
// OpenAI-compatible wire, and OLLAMA_HOST is another machine with FLINT_LOCAL_ALLOW_REMOTE on. That machine was taken
// as "here": it was sent the private message and the private fact to embed and the stored private turn to mine,
// while Settings said "this Mac". The switch vouches for the model server, and for nothing else.
describe('the real server, as a process: the local model on this Mac, and OLLAMA_HOST on a machine the remote switch does not vouch for', () => {
  let lm: MockLocalServer;
  let other: OllamaStub;
  let srv: Running;
  const embeds = (from = 0) => other.requests.slice(from).filter((q) => q.path.startsWith('/api/embed'));

  beforeAll(async () => {
    ({ lm, other, srv } = helper);
    // Memory extraction's first pass runs a moment after boot, on a model at OLLAMA_HOST.
    await waitFor(() => /\[memory-extract\] v2 local pass:/.test(srv.log()));
  });

  it('that machine is really reached in Cloud mode, as it always was: it mined the ordinary turn, and never the private one', () => {
    expect(srv.guard().some((e) => e.kind === 'connect-remapped' && e.host === OTHER_MACHINE)).toBe(true);
    const mined = other.chats().map((c) => chatFacts(c.body).last).filter((p) => p.includes('TURNS:'));
    expect(mined.some((p) => p.includes('CORALSWIFT'))).toBe(true);
    expect(other.saw('JASPERLARK')).toBe(false);
    expect(other.saw('PRIVWORDH')).toBe(false);
    expect(srv.log()).toMatch(/\[memory-extract\] v2 local pass: [^\n]*tainted=2/);
  });

  it('a private turn is answered on this Mac, and that machine is sent none of it: not the message, not the private history, not the private fact', async () => {
    const before = other.requests.length;
    const r = await srv.post('/chat', { conversationId: 'mix', message: 'A private follow-up about PRIVLIVEH and the spare key.', localOnly: true });
    expect(r.status).toBe(200);
    expect(r.text).toBe('LMLOCAL reply.');
    expect(staysHere(r)).toMatchObject({ staysHere: true });
    // The model on this Mac read all of it...
    const sent = JSON.stringify(lm.chats().at(-1)?.body);
    for (const word of ['PRIVLIVEH', 'PRIVWORDH', 'GARNETFINCH']) expect(sent, word).toContain(word);
    // ...and was told the truth: nothing outside THIS MAC is asked. No sentence names a second machine, because none is used.
    expect(sent).toContain(JSON.stringify(PRIVATE_TURN_NOTE).slice(1, -1));
    expect(sent).not.toContain('the model server you allowed');
    await sleep(150);
    expect(other.requests.slice(before).filter((q) => q.method !== 'GET')).toEqual([]);
    for (const word of ['PRIVLIVEH', 'PRIVWORDH', 'GARNETFINCH']) expect(other.saw(word), word).toBe(false);
  });

  it('Settings says "this Mac", and it is true', async () => {
    const st = (await srv.get('/inference')).json as { modeSentence: string; localOnlySentence: string; local: { confined: boolean; host?: string } };
    expect(st.modeSentence).toBe('Cloud models answer, and private messages stay on this Mac.');
    expect(st.localOnlySentence).toBe('Answers stay on this Mac.');
    expect(st.local.confined).toBe(true);
    expect(JSON.stringify(st)).not.toContain(OTHER_MACHINE);
  });

  it('in Local mode that machine is sent nothing at all: an ordinary turn is answered on this Mac and none of its words leave it', async () => {
    expect((await srv.post('/inference/mode', { mode: 'local' })).json).toMatchObject({ mode: 'local', modeSentence: 'Every answer comes from this Mac. Flint may still search the web.', localOnlySentence: 'Local mode keeps every answer on this Mac.' });
    const before = other.requests.length;
    const r = await srv.post('/chat', { conversationId: 'lm-local', message: 'An ordinary synthetic question about LOCALWORDH.' });
    expect(r.status).toBe(200);
    expect(r.text).toBe('LMLOCAL reply.');
    await sleep(150);
    expect(other.requests.slice(before).filter((q) => q.method !== 'GET')).toEqual([]);
    expect(other.saw('LOCALWORDH')).toBe(false);
    expect((await srv.post('/inference/mode', { mode: 'cloud' })).json).toMatchObject({ mode: 'cloud' });
  });

  // M29. An ORDINARY turn that carries a private one is not a private request: the helpers are not switched off for
  // it in Cloud mode. What keeps the fact it saves off that machine is the embedder's own rule, and nothing else.
  it('a fact saved on a turn that carries a private one is marked and never sent to that machine to be embedded; an ordinary fact is embedded there as before', async () => {
    const before = other.requests.length;
    const kept = await srv.post('/chat', { conversationId: 'mix', message: 'CALL(remember: KEPT) an ordinary synthetic note about the boat keys.' });
    expect(kept.status).toBe(200);
    expect(kept.events?.some((e) => e.type === 'tool_call')).toBe(true);
    expect(staysHere(kept)).toMatchObject({ staysHere: true }); // it read the private turn as history
    await waitFor(() => factsOf(srv).some((f) => f.text === HELPER_KEPT_FACT));
    const stored = factsOf(srv).find((f) => f.text === HELPER_KEPT_FACT)!;
    expect(stored).toMatchObject({ fromPrivate: true });
    expect(stored.vector).toEqual([]);
    // The other half: on a turn that carries nothing kept, what the model saves is an ordinary fact, and Cloud mode
    // embeds it at OLLAMA_HOST as it always did. So the embedder there works, and the fact above was held back by rule.
    const open = await srv.post('/chat', { conversationId: 'fresh', message: 'CALL(remember: OPEN) an ordinary synthetic note about the picnic rug.' });
    expect(staysHere(open)).toMatchObject({ staysHere: false });
    await waitFor(() => (factsOf(srv).find((f) => f.text === HELPER_OPEN_FACT)?.vector?.length ?? 0) > 0);
    const ordinary = factsOf(srv).find((f) => f.text === HELPER_OPEN_FACT)!;
    expect(ordinary.fromPrivate).toBeUndefined();
    expect(ordinary.vector!.length).toBeGreaterThan(0);
    expect(embeds(before).some((q) => JSON.stringify(q.body).includes('HAZELWREN'))).toBe(true);
    expect(other.saw('SILVERTERN')).toBe(false);
    expect(srv.log()).not.toMatch(/SILVERTERN|HAZELWREN|PRIVLIVEH|PRIVWORDH|LOCALWORDH|GARNETFINCH|JASPERLARK/);
    // Nothing but this machine and that stand-in was ever reached.
    expect(blocked(srv)).toEqual([]);
  });
});

// The follow-up review's F3 and F4. Whether a pass asks for goals, and whether a turn that stays here may be mined
// at all, are read when the pass begins, off what the memory model's server last said: a minute old at worst. So
// each call is decided AGAIN where it is sent (../../src/inference helperFetch), on a listing asked for a moment
// before: a call that asks for his goals, and a call about turns that stay here, go only to a model that server
// then lists as its own. The extractor marks those calls (../../src/goals-chat extractor: `kept`); take the mark
// away and both are sent on the old word.
describe('the real server, as a process: the memory model pointed at a cloud model while Flint runs', () => {
  it('the pass asks its Ollama again where each call is sent: no call that asks for goals, and no turn that stays here, reaches that model', async () => {
    const { ollama, cloud, runtime, srv, flippedAt } = repoint;
    expect(await waitFor(() => /\[memory-extract\] v2 local pass: /.test(srv.log()), 15_000)).toBe(true);
    await sleep(200);
    const after = ollama.requests.slice(flippedAt);
    // The pass began on what was known (the model was still read as one on this Mac: no turn was skipped as one it
    // may not read), and the first call that would have carried something to it asked the listing again...
    expect(srv.log()).toMatch(/\[memory-extract\] v2 local pass: sent 0 turn\(s\) in \d+ call\(s\) \(skipped [^)]*tainted=0\)/);
    expect(after.filter((r) => r.path === '/api/tags').length).toBeGreaterThan(0);
    // ...so nothing was sent to that model at all: not the call that asks for his goals, not the turn he kept private.
    expect(after.filter((r) => r.path === '/api/chat').map((r) => r.body?.model)).toEqual([]);
    expect(ollama.saw('UMBERSTOAT', flippedAt)).toBe(false);
    expect(ollama.saw('ONYXPIPIT', flippedAt)).toBe(false);
    expect(ollama.saw(SUGGEST_GOALS_PROMPT, flippedAt)).toBe(false);
    expect(runtime.candidates()).toEqual([]);
    // The turns wait for a pass that can read them, and nothing of them is in the log or went anywhere else.
    expect(srv.log()).toMatch(/\[memory-extract\] v2 local pass: [^\n]*2 turn\(s\) still queued/);
    for (const word of ['UMBERSTOAT', 'ONYXPIPIT']) {
      expect(srv.log(), word).not.toContain(word);
      expect(cloud.saw(word), word).toBe(false);
    }
    expect(blocked(srv)).toEqual([]);
  });

  // The follow-up review's F5. Every helper request used to wait for the listing first. With a listing that hangs,
  // each ordinary Cloud-mode turn was held for as long as an ask may take (two seconds, and again for the next one),
  // though nothing the listing says would have stopped it.
  it('a model server whose looks hang does not hold up an ordinary Cloud-mode turn: its embeddings are sent as ever, with no ask before them', async () => {
    const { ollama, srv } = repoint;
    // (What that server last said is too old to use without asking: a request that waits for the listing would ask now.)
    const lastLook = ollama.requests.filter((r) => r.path === '/api/tags').at(-1)?.at ?? Date.now();
    await waitFor(() => Date.now() - lastLook > 2_100, 4_000);
    ollama.looks = 'looks-hang';
    const from = ollama.requests.length;
    const began = Date.now();
    const r = await srv.post('/chat', { conversationId: 'rp-ordinary', message: 'An ordinary synthetic question about the weather.' });
    expect(r.events?.[0]).toMatchObject({ brain: 'frontier' });
    expect(Date.now() - began).toBeLessThan(1_000);
    expect(ollama.saw('An ordinary synthetic question about the weather', from)).toBe(true);
    expect(ollama.requests.slice(from).filter((q) => q.path === '/api/tags')).toEqual([]);
    ollama.looks = 'answers';
  });
});

// The follow-up review's F2. What a model server last said used to stand for five minutes after it stopped saying
// anything: with the listing failing (or hanging) and its names pointed at cloud models, a fact that stays here was
// embedded there, a stored private turn was mined there, and a Local Only turn was answered there. Now a server
// that gives no word to an ask somebody waited for is not believed on what it said before, and the turn gets a
// plain sentence inside the two seconds one look may take.
describe('the real server, as a process: a model server that stops saying what it lists, with its names pointed at cloud models', () => {
  let ollama: OllamaStub;
  let cloud: CloudStub;
  let srv: Running;
  let flippedAt: number;
  beforeAll(() => {
    ({ ollama, cloud, srv, flippedAt } = quiet);
  });
  const REMOTE_HOST = 'https://ollama.com:443';
  const pointAway = (...names: string[]) => names.forEach((m) => (ollama.models[m]!.remoteHost = REMOTE_HOST));
  const pointBack = (...names: string[]) => names.forEach((m) => delete ollama.models[m]!.remoteHost);
  const privately = (word: string) => srv.post('/chat', { conversationId: `q-${word}`, message: `My ${word} account number is nobody else's business.`, localOnly: true });
  /**
   * The requests that carry words to a model, from request `from` on (chat and the embedding calls): not what a
   * look asks, and not a load, which names a model and carries no prompt (the monitor may make one behind a turn
   * in Local mode).
   */
  const carries = (q: { method: string; path: string; body?: Record<string, unknown> | undefined }): boolean => q.method === 'POST' && q.path !== '/api/show' && !(q.path === '/api/generate' && q.body?.prompt === undefined);
  const carried = (from: number) => ollama.requests.slice(from).filter(carries).map((q) => q.path);

  it('memory extraction: the turn he kept private is not sent to the memory model on the word of a listing that no longer answers', async () => {
    expect(await waitFor(() => /\[memory-extract\] v2 local pass: /.test(srv.log()), 15_000)).toBe(true);
    await sleep(200);
    const after = ollama.requests.slice(flippedAt);
    // The pass began on what was known, the call asked the listing again where it was sent, and got no word.
    expect(srv.log()).toMatch(/\[memory-extract\] v2 local pass: sent 0 turn\(s\) in \d+ call\(s\) \(skipped [^)]*tainted=0\)/);
    expect(after.filter((r) => r.path === '/api/tags').length).toBeGreaterThan(0);
    expect(after.filter((r) => r.path === '/api/chat')).toEqual([]);
    expect(ollama.saw('AGATEDUNLIN', flippedAt)).toBe(false);
    expect(cloud.saw('AGATEDUNLIN')).toBe(false);
  });

  it('an ordinary Cloud-mode turn: the fact that stays here is not embedded at that model, and ordinary text goes as ever', async () => {
    const r = await srv.post('/chat', { conversationId: 'q-open', message: 'Where are the garden shears and the cash box kept?' });
    expect(r.events?.[0]).toMatchObject({ brain: 'frontier' });
    await sleep(500); // facts with no embedding are embedded behind the turn
    expect(ollama.saw('FLINTSHRIKE', flippedAt)).toBe(false);
    expect(cloud.saw('FLINTSHRIKE')).toBe(false);
    expect(factsOf(srv).find((f) => f.text === QUIET_FACT)).toMatchObject({ fromPrivate: true, vector: [] });
    // The turn's own words and the ordinary fact were embedded there, as in Cloud mode they always are.
    expect(ollama.saw('garden shears and the cash box', flippedAt)).toBe(true);
    expect(factsOf(srv).find((f) => f.text === OPEN_FACT)?.vector?.length).toBeGreaterThan(0);
  });

  it('a Local Only turn gets a sentence: it is not sent to the main model, not embedded, and not sent to the cloud; on either route', async () => {
    const from = ollama.requests.length;
    expect(await privately('ZIRCONPLOVER')).toMatchObject({ status: 503, json: { error: NOT_CONFIRMED } });
    expect(await srv.post('/generate', { prompt: 'My ZIRCONPLOVER account number is nobody else’s business.', localOnly: true })).toMatchObject({ status: 503, json: { error: NOT_CONFIRMED } });
    expect(ollama.saw('ZIRCONPLOVER')).toBe(false);
    expect(cloud.saw('ZIRCONPLOVER')).toBe(false);
    // Each of them looked first, and the look came back without a listing.
    expect(ollama.requests.slice(from).filter((q) => q.path === '/api/tags').length).toBeGreaterThanOrEqual(2);
    expect(carried(from)).toEqual([]);
  });

  it('it answers again, with its names pointed back: the very next Local Only turn is answered on this Mac', async () => {
    pointBack(MAIN, MEMORY_MODEL, 'nomic-embed-text');
    ollama.looks = 'answers';
    const r = await privately('JADEPIPIT');
    expect(r.events?.[0]).toMatchObject({ brain: 'local', route: { mode: 'cloud', private: true } });
    expect(r.text).toBe(`LOCAL(${MAIN}) reply.`);
    expect(cloud.saw('JADEPIPIT')).toBe(false);
  });

  it('only its listing fails, a moment after it said the model runs here: the look a private turn waits for is enough to drop that', async () => {
    // (Inside the two seconds its word is good for: nothing but this turn's own look can know.)
    pointAway(MAIN);
    ollama.looks = 'listing-fails';
    const from = ollama.requests.length;
    expect(await privately('RUBYSANDERLING')).toMatchObject({ status: 503, json: { error: NOT_CONFIRMED } });
    expect(ollama.saw('RUBYSANDERLING')).toBe(false);
    expect(carried(from)).toEqual([]);
    expect(cloud.saw('RUBYSANDERLING')).toBe(false);
  });

  // The re-review's N4. One failed listing cost one refused turn: the turn that waited for that look got the
  // sentence and the next was answered. A listing that fails AT ONCE is asked once more inside the same look.
  it('one failed listing, then a good one: the turn is answered, and never knew; a listing that fails twice is the refusal above', async () => {
    pointBack(MAIN);
    ollama.looks = 'answers';
    expect((await privately('MOSSGODWIT')).events?.[0]).toMatchObject({ brain: 'local', route: { private: true } });
    ollama.looks = 'listing-fails-once';
    const from = ollama.requests.length;
    const r = await privately('FERNCURLEW');
    expect(r.events?.[0]).toMatchObject({ brain: 'local', route: { mode: 'cloud', private: true } });
    expect(r.text).toBe(`LOCAL(${MAIN}) reply.`);
    // The look asked for the listing twice: the bad answer, and the good one it was decided on.
    expect(ollama.requests.slice(from).filter((q) => q.path === '/api/tags').length).toBeGreaterThanOrEqual(2);
    expect(ollama.looks).toBe('answers');
    expect(cloud.saw('FERNCURLEW')).toBe(false);
    // Two failures in one look: refused (the listing never answers in this mode), and asked twice, not three times.
    pointAway(MAIN);
    ollama.looks = 'listing-fails';
    const again = ollama.requests.length;
    expect(await privately('HEATHDUNNOCK')).toMatchObject({ status: 503, json: { error: NOT_CONFIRMED } });
    const looks = ollama.requests.slice(again).filter((q) => q.path === '/api/tags').length;
    expect(looks).toBeGreaterThanOrEqual(2);
    expect(looks % 2).toBe(0); // (a look taken behind the refusal asks its own two)
    expect(carried(again)).toEqual([]);
    expect(ollama.saw('HEATHDUNNOCK')).toBe(false);
  });

  // The re-review's N3. In Local mode the helpers used to hold a turn's words only from a model KNOWN to run on
  // Ollama's servers, so with the listing silent the words of a turn that was about to be refused still went to the
  // embedding model (re-pointed or not). A turn of Local mode is now held to the strict rule, like a private one.
  it('Local mode, a server that gives no word (its listing fails, is refused, or drops the connection): the turn gets a sentence, and its words are not embedded and not sent', async () => {
    // What stands is a listing that says the main model and the embedding model run here.
    pointBack(MAIN, MEMORY_MODEL, 'nomic-embed-text');
    ollama.looks = 'answers';
    expect((await privately('SEDGEPIPIT')).events?.[0]).toMatchObject({ brain: 'local', route: { private: true } });
    expect((await srv.post('/inference/mode', { mode: 'local' })).json).toMatchObject({ mode: 'local' });
    try {
      // Every name is pointed at a cloud model, and from now on the server says nothing of what it lists.
      pointAway(MAIN, MEMORY_MODEL, 'nomic-embed-text');
      for (const [how, word] of [['listing-fails', 'LOCALWORDF'], ['listing-401', 'LOCALWORDU'], ['listing-403', 'LOCALWORDB'], ['listing-drops', 'LOCALWORDD']] as const) {
        ollama.looks = how;
        const from = ollama.requests.length;
        const began = Date.now();
        const r = await srv.post('/chat', { conversationId: `q-local-${how}`, message: `A ${word} note about the boat trailer hitch size.` });
        expect(r, how).toMatchObject({ status: 503, json: { error: NOT_CONFIRMED_LOCAL } });
        expect(Date.now() - began, how).toBeLessThan(1_500);
        // Not to the main model, and not to the embedding model for the tool router or for recall.
        expect(carried(from), how).toEqual([]);
        expect(ollama.saw(word), how).toBe(false);
        expect(cloud.saw(word), how).toBe(false);
      }
    } finally {
      expect((await srv.post('/inference/mode', { mode: 'cloud' })).json).toMatchObject({ mode: 'cloud' });
    }
  });

  it('no look is answered at all (everything it is asked hangs, and chat still answers): a sentence, within the two seconds one look may take', async () => {
    pointBack(MAIN);
    ollama.looks = 'answers';
    expect((await privately('TEALWHIMBREL')).events?.[0]).toMatchObject({ brain: 'local', route: { private: true } });
    // A moment ago it said the main model runs here. Now the name is pointed at a cloud model and no GET is answered.
    pointAway(MAIN);
    ollama.looks = 'looks-hang';
    const from = ollama.requests.length;
    const began = Date.now();
    expect(await privately('OPALDIPPER')).toMatchObject({ status: 503, json: { error: NOT_AVAILABLE } });
    // One look, two seconds: the turn waited once for that silence, not once more for each thing that asks.
    expect(Date.now() - began).toBeLessThan(3_500);
    expect(ollama.saw('OPALDIPPER')).toBe(false);
    expect(carried(from)).toEqual([]);
    expect(cloud.saw('OPALDIPPER')).toBe(false);
  });

  // The rest of the seven ways a server can give no word, in Local mode. With the whole server hung, a turn of
  // Local mode used to wait on a request to the embedding model that was never answered (no sentence inside nine
  // seconds), where a Local Only turn got its sentence at two. Both get it at two now.
  // (Two servers at once, one way each that takes the two seconds: this one, whose looks already hang, and the
  // `repoint` Mac, whose listing first answers with something that is no listing and then answers nothing at all.)
  it('Local mode, a listing that hangs, one that is no listing, and a server that answers nothing: a sentence within one look, and the words go nowhere', async () => {
    const local = async (on: { srv: Running; ollama: OllamaStub; cloud: CloudStub }, how: OllamaStub['looks'], word: string) => {
      on.ollama.looks = how;
      const from = on.ollama.requests.length;
      const began = Date.now();
      const r = await on.srv.post('/chat', { conversationId: `q-local-${how}`, message: `A ${word} note about the boat trailer hitch size.` });
      const carriedThere = on.ollama.requests.slice(from).filter(carries).map((q) => q.path);
      return { status: r.status, error: (r.json as { error?: string } | undefined)?.error, ms: Date.now() - began, carried: carriedThere, saw: on.ollama.saw(word) || on.cloud.saw(word) };
    };
    for (const on of [quiet, repoint]) expect((await on.srv.post('/inference/mode', { mode: 'local' })).json).toMatchObject({ mode: 'local' });
    try {
      for (const m of [MAIN, 'nomic-embed-text']) repoint.ollama.models[m]!.remoteHost = REMOTE_HOST;
      const [hangs, [noListing, nothing]] = await Promise.all([
        local(quiet, 'listing-hangs', 'LOCALWORDH'),
        (async () => [await local(repoint, 'listing-not-json', 'LOCALWORDJ'), await local(repoint, 'all-hang', 'LOCALWORDA')] as const)(),
      ]);
      // A listing that hangs. (This server's looks were already hanging: the turn's look is that one, or one more.)
      expect(hangs.status).toBe(503);
      expect([NOT_CONFIRMED_LOCAL, NOT_AVAILABLE_LOCAL]).toContain(hangs.error);
      expect(hangs.ms).toBeLessThan(3_500);
      expect([hangs.carried, hangs.saw]).toEqual([[], false]);
      // A 200 that is no listing: an Ollama that lists nothing has no local model, and says so at once.
      expect(noListing).toMatchObject({ status: 503, error: NOT_DOWNLOADED_LOCAL, carried: [], saw: false });
      expect(noListing.ms).toBeLessThan(1_500);
      // Nothing is answered, chat and the embedding calls included: the sentence at two seconds, and no request for
      // the turn's words was even made (one would have been kept by the stand-in, answered or not).
      expect(nothing).toMatchObject({ status: 503, error: NOT_AVAILABLE_LOCAL, carried: [], saw: false });
      expect(nothing.ms).toBeGreaterThan(1_500);
      expect(nothing.ms).toBeLessThan(3_500);
    } finally {
      for (const on of [quiet, repoint]) expect((await on.srv.post('/inference/mode', { mode: 'cloud' })).json).toMatchObject({ mode: 'cloud' });
    }
  });

  it('the log holds none of it, and the process reached nothing but this machine', () => {
    for (const word of ['AGATEDUNLIN', 'FLINTSHRIKE', 'ZIRCONPLOVER', 'JADEPIPIT', 'OPALDIPPER', 'TEALWHIMBREL', 'RUBYSANDERLING', 'MOSSGODWIT', 'FERNCURLEW', 'HEATHDUNNOCK', 'SEDGEPIPIT', 'LOCALWORD']) expect(srv.log(), word).not.toContain(word);
    expect(repoint.srv.log()).not.toContain('LOCALWORD');
    expect(blocked(srv)).toEqual([]);
    expect(blocked(repoint.srv)).toEqual([]);
  });
});

// Goals from chat (P3 part 5) and the two notions. "Stays here" is a turn Will asked to keep private OR any turn of
// Local mode; "explicitly private" is his own word for a turn. Suggestions follow the second, as tools do: a turn
// taken in Local mode is asked for the goal he set in it, and one he asked to keep private never is. Here the turns
// are the ones the server above really took, marked by its own code, and the pass is a real one after a restart.
// (Placed here, after the other servers' cases: it needs the `modes` server stopped, and nothing else of them.)
describe('the real server, as a process: the same Mac restarted with goals from chat on', () => {
  let srv: Running;
  let runtime: RuntimeStub;
  const ollama = () => modes.ollama;
  const mined = () => ollama().chats().filter((c) => c.body?.format !== undefined && chatFacts(c.body).last.includes('TURNS:'));
  const callWith = (word: string) => mined().find((c) => (chatFacts(c.body).last.split('TURNS:')[1] ?? '').includes(word))!;

  beforeAll(async () => {
    await modes.srv.stop();
    runtime = await startRuntimeStub();
    // The "model" makes a goal of every turn it is shown that holds one of the sentences, asked or not, each with a
    // day it worked out. It learns the private thing from the turn that said it. And in a goal about "that
    // treatment" or "the follow-up" it NAMES the private thing whenever its own prompt shows it the word: so the
    // word in a card could only have come from the prompt Flint sent it.
    ollama().toolFor = undefined;
    ollama().replyFor = (body, last) => {
      if (body.format === undefined || !last.includes('TURNS:')) return undefined;
      const shown = (last.split('TURNS:')[1] ?? '').split('### Turn ').slice(1).map((text) => text.split('\nWILL: ').at(-1) ?? '');
      const named = last.includes(LEAK.word) ? `${LEAK.word} ` : '';
      const facts = shown.flatMap((will, i) => (will.startsWith(LEAK.kept) ? [{ turn: i + 1, quote: 'my doctor found a QUARTZMOLE lesion last week', fact: LEAK.learned, category: 'other', supersedes: [] }] : []));
      const suggestions = shown.flatMap((will, i) => [
        ...Object.values(GOALS_SAID).filter((g) => will.includes(g.word)).map((g) => ({ turn: i + 1, kind: 'goal', quote: g.quote, text: g.text, dueOn: DAY_WORKED_OUT })),
        ...(will.startsWith(LEAK.after) ? [{ turn: i + 1, kind: 'goal', quote: 'I want to finish that treatment plan by spring', text: named ? `finish the ${named}treatment plan by spring` : 'finish that treatment plan by spring', dueOn: DAY_WORKED_OUT }] : []),
        ...(will.startsWith(LEAK.apart) ? [{ turn: i + 1, kind: 'goal', quote: 'I want to book the follow-up scan by March', text: `book the ${named}follow-up scan by March`, dueOn: DAY_WORKED_OUT }] : []),
      ]);
      return JSON.stringify({ facts, suggestions });
    };
    const before = mined().length;
    srv = await startServer({
      dir: runs.modes.dir,
      env: {
        OLLAMA_HOST: ollama().origin, OLLAMA_MODEL: MAIN, OLLAMA_NUM_CTX: '16384',
        FLINT_MEMORY_BRAIN: 'local', FLINT_EXTRACT_FIRST_PASS_MS: '300', FLINT_EXTRACT_CANDIDATES: '1', FLINT_RUNTIME_URL: runtime.origin,
      },
      seed: [RUNTIME_TOKEN],
    });
    again = { runtime, srv };
    expect(before).toBe(0);
    await waitFor(() => /\[memory-extract\] v2 local pass: /.test(srv.log()), 15_000);
  });

  it('it came back in the mode it was left in, with the turns of the first run in its store', async () => {
    expect((await srv.get('/health', null)).json).toMatchObject({ ok: true, mode: 'cloud', model: MAIN });
    expect(srv.log()).toContain('[memory-extract] goals Will sets in chat are suggested');
    expect(srv.log()).toMatch(/\[memory-extract\] v2 local pass: sent \d+ turn\(s\) in \d+ call\(s\)/);
  });

  it('a turn taken in Local mode is asked for the goal he set in it, and it is filed with the runtime on this Mac; so is an ordinary turn’s', () => {
    const filed = runtime.candidates();
    expect(filed.map((c) => c.text).sort()).toEqual(['Book the follow-up scan by March', 'Finish the PEARLFINCH boat deck', 'Plant the IVORYLARK orchard']);
    expect(filed.find((c) => c.text === 'Finish the PEARLFINCH boat deck')).toMatchObject({ kind: 'goal', quote: GOALS_SAID.localMode.said, conversationId: GOALS_SAID.localMode.conversationId });
    // The day the model worked out is its reading, and an ordinary turn's card keeps it. From a turn that stays here
    // a day is kept only when he named it in that turn: neither sentence did, so neither card has one.
    expect(filed.find((c) => c.text === 'Plant the IVORYLARK orchard')).toMatchObject({ dueOn: DAY_WORKED_OUT });
    expect(filed.find((c) => c.text === 'Finish the PEARLFINCH boat deck')).not.toHaveProperty('dueOn');
    // Its call asked for goals: the lines in the prompt, and the reply held to a schema with them.
    const asked = callWith('PEARLFINCH');
    expect(chatFacts(asked.body).last).toContain(SUGGEST_GOALS_PROMPT);
    expect(JSON.stringify(asked.body?.format)).toContain('suggestions');
  });

  it('a turn he asked to keep private is never asked for one, in Cloud mode or in Local mode: no lines, no schema, nothing filed', () => {
    for (const g of [GOALS_SAID.localOnly, GOALS_SAID.localOnlyInLocalMode]) {
      const call = callWith(g.word);
      expect(call, g.word).toBeDefined(); // it was mined for facts, on this Mac
      expect(chatFacts(call.body).last, g.word).not.toContain(SUGGEST_GOALS_PROMPT);
      expect(chatFacts(call.body).last, g.word).not.toContain(SUGGEST_PROMPT);
      expect(JSON.stringify(call.body?.format), g.word).not.toContain('suggestions');
      expect(runtime.saw(g.word), g.word).toBe(false);
      // ...and it never shared a call with the turn Local mode alone kept.
      expect(chatFacts(call.body).last, g.word).not.toContain('PEARLFINCH');
    }
    // The pass says how many turns were not asked, by a count, and none of his words is in the log.
    expect(srv.log()).toMatch(/\[memory-extract\] v2 local pass: [^\n]*suggestion-private-turn=\d+[^\n]*suggestion\(s\) → kept 3, filed 3; /);
    for (const g of Object.values(GOALS_SAID)) expect(srv.log(), g.word).not.toContain(g.word);
    expect(srv.log()).not.toContain(LEAK.word);
    expect(blocked(srv)).toEqual([]);
  });

  // The follow-up review's F1, its probe A whole (the turns are the ones the first run took and marked).
  it('what a turn he asked to keep private held reaches no call that is asked for goals, and no suggestion: not through a later turn of Local mode, not through what was learned from it', () => {
    const prompt = (c: { body?: Record<string, unknown> }) => chatFacts(c.body).last;
    const known = (c: { body?: Record<string, unknown> }) => (prompt(c).split('KNOWN FACTS (id: text):')[1] ?? '').split('TURNS:')[0]!;
    const asked = mined().filter((c) => prompt(c).includes(SUGGEST_GOALS_PROMPT) || JSON.stringify(c.body?.format).includes('suggestions'));
    // The private thing was mined, on this Mac, in a call that asked for facts alone; so were the two turns of
    // Local mode that were handed it (the one that asked about it, whose reply says it back, and the one after).
    const told = mined().filter((c) => prompt(c).includes(LEAK.word));
    expect(told.length).toBeGreaterThan(0);
    for (const c of told) expect(asked).not.toContain(c);
    for (const said of [LEAK.kept, LEAK.asked, LEAK.after]) expect(told.some((c) => (prompt(c).split('TURNS:')[1] ?? '').includes(`\nWILL: ${said}`)), said).toBe(true);
    // What it learned there is in memory, marked.
    const facts = (JSON.parse(srv.read('memory', 'knowledge.json')) as { facts: Array<{ text: string; fromPrivate?: boolean }> }).facts;
    expect(facts.find((f) => f.text === LEAK.learned)).toMatchObject({ fromPrivate: true });
    // The turn in a conversation of its own WAS asked, after that fact was learned: its call shows it no fact from
    // a private turn (this one, or the ones the first run's model saved), and the ordinary fact as ever.
    const apart = callWith('follow-up scan');
    expect(asked).toContain(apart);
    expect(mined().indexOf(apart)).toBeGreaterThan(mined().indexOf(told[0]!));
    for (const c of asked) {
      expect(prompt(c)).not.toContain(LEAK.word);
      for (const word of ['TOPAZWREN', 'GARNETFINCH']) expect(known(c), word).not.toContain(word);
    }
    expect(known(apart)).toContain('OPALHERON');
    // So its goal is filed in his own words, without the day the model worked out, and nothing filed names the private thing.
    const filed = runtime.candidates();
    expect(filed.find((c) => c.conversationId === 'leak-apart')).toEqual({ kind: 'goal', text: 'Book the follow-up scan by March', quote: LEAK.apart, conversationId: 'leak-apart', turnId: expect.any(String), sourceAt: expect.any(String) });
    expect(filed.filter((c) => c.conversationId === 'leak')).toEqual([]);
    expect(runtime.saw(LEAK.word)).toBe(false);
    expect(runtime.saw('treatment plan')).toBe(false);
  });
});

// The follow-up to N5. Only a turn that stays here by its route asked the model server first. A tier on a local
// wire answers ORDINARY turns, and its server's listing was asked once a minute: a name pointed at a cloud model in
// between stayed a brain on this Mac until the next one, and was handed the turns and the facts that stay here.
// (Last in the file, so that the tiers' Ollama was last asked more than two seconds ago without waiting for it.)
describe('the real server, as a process: a tier pointed at a cloud model while Flint runs', () => {
  it('the next ordinary turn asks its server first: the tier is asked as an outside brain, and is handed nothing that stays here', async () => {
    const { mock, srv } = tier;
    const tierChats = () => mock.chats().filter((q) => q.path === '/v1/chat/completions' && q.model === REAL);
    // `ollama cp gpt-oss:120b-cloud real:7b`, on the tiers' own Ollama. Nothing looks at that server on a timer for
    // another minute; what it last said is more than two seconds old by now.
    mock.models.get(REAL)!.remoteHost = 'https://ollama.com:443';
    await sleep(Math.max(0, tierAskedAt + FRESH_MS + 150 - Date.now()));
    const listings = mock.requests.filter((q) => q.path === '/api/tags').length;
    const before = tierChats().length;
    const r = await srv.post('/chat', { conversationId: 'mix', message: 'Think it through step by step: where is the spare key kept, and the regatta entry?' });
    expect(r.events?.[0]).toMatchObject({ type: 'meta', brain: 'frontier', tier: 'hard', model: `local:${REAL}` });
    expect(tierChats()).toHaveLength(before + 1);
    // Its server was asked what runs on it before it was asked anything...
    expect(mock.requests.filter((q) => q.path === '/api/tags').length).toBe(listings + 1);
    // ...and so it was handed what any brain may have: no private turn, no goals turn, no fact from either.
    const sent = JSON.stringify(tierChats().at(-1)!.body);
    for (const word of ['PRIVWORDT', 'GARNETFINCH', 'GOALWORDT', 'MARLINGOAL']) expect(sent, word).not.toContain(word);
    expect(sent).toContain(HISTORY_GAP);
    expect(staysHere(r)).toMatchObject({ staysHere: false });
    expect(blocked(srv)).toEqual([]);
  });
});
