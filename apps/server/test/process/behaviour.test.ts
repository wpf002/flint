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
 * Three servers, each with its own scratch HOME and stand-ins, started at the
 * same time (the boot is most of what this test takes):
 *  - `modes`: Cloud mode, then Local mode, on a model server that is this Mac;
 *  - `remote`: Cloud mode with a model server on another machine;
 *  - `alias`: a main model that is a cloud model under a plain name, and a
 *    real pass of memory extraction over a stored private turn.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { ROUTE_FIELDS } from '../../src/route-log';
import { HISTORY_GAP } from '../../src/goals-now';
import { PRIVATE_TURN_NOTE } from '../../src/outside-ai';
import { chatFacts, startCloudStub, startOllamaStub, type CloudStub, type OllamaStub } from './stubs';
import { routeLines, scratch, sleep, startServer, writeMcpConfig, type Running } from './rig';

const MAIN = 'main-model:30b';
const MODELS = { [MAIN]: { loaded: true, contextLength: 16384 }, 'nomic-embed-text': { family: 'nomic-bert' } };
/** Words that are in a message and nowhere else, so a wire or a log can be searched for them. */
const SECRET = 'ZEBRAQUARTZ';
/** A fact in long-term memory from before, learned on an ordinary turn: any brain may be given it. */
const OPEN_FACT = 'Will keeps the garden shears in the OPALHERON shed.';
/** What the "model" saves with `remember`: on a private turn, and on a turn taken in Local mode. */
const KEPT_FACT = 'Will keeps the spare key at the GARNETFINCH lodge.';
const LOCAL_MODE_FACT = 'Will keeps the bike lock code in the TOPAZWREN notebook.';
const ASK_FACTS = 'Where does Will keep the spare key, the bike lock code and the garden shears?';
const memoryFile = (facts: string[]): string => JSON.stringify({ seq: facts.length, facts: facts.map((text, i) => ({ id: `k${i + 1}`, text, source: 'history', ts: 1, vector: [] })), rejected: [] });
const PAID = ['trident.perplexity_search', 'trident.web_search'];
const names = (request: { body: Record<string, unknown> | undefined } | undefined): string[] => ((request?.body?.tools ?? []) as Array<{ name?: string }>).map((t) => String(t.name).replace('__', '.'));
const cloudEnv = (cloud: CloudStub): Record<string, string> => ({ ANTHROPIC_API_KEY: 'sk-ant-process-test-not-a-key', ANTHROPIC_BASE_URL: cloud.origin });
/** The `meta` event that says whether a reply stays on this Mac, and which stored turn it is. */
const staysHere = (r: { events?: Array<Record<string, unknown>> }): { staysHere?: boolean; turn?: string } | undefined => r.events?.find((e) => e.type === 'meta' && typeof e.staysHere === 'boolean');
const blocked = (srv: Running): Array<{ kind: string; hostname?: string; host?: string }> => srv.guard().filter((e) => e.kind.endsWith('blocked'));

// ---- the three servers, started together

const runs = { modes: scratch('modes'), remote: scratch('remote'), alias: scratch('alias') };
const ELSEWHERE = '10.255.255.1';
/** The main model of the `alias` server: a cloud model under a plain name (`ollama cp gpt-oss:120b-cloud mine`). */
const ALIAS = 'mine:latest';
/** ...and the real local model its memory extraction runs on. */
const MEMORY_MODEL = 'memory-model:7b';
const EXTRACT_PRIVATE = 'Keep this private: I keep the passport in the JASPERLARK cabinet, keep that in mind.';
const EXTRACT_OPEN = 'I keep the ladder in the CORALSWIFT garage, keep that in mind.';
const PRIVATE_LEARNED = 'Will keeps the passport in the JASPERLARK cabinet.';
const OPEN_LEARNED = 'Will keeps the ladder in the CORALSWIFT garage.';

let modes: { ollama: OllamaStub; cloud: CloudStub; mcp: ReturnType<typeof writeMcpConfig>; srv: Running };
let remote: { cloud: CloudStub; srv: Running };
let alias: { ollama: OllamaStub; cloud: CloudStub; srv: Running };

/** A complete stored turn, as the conversation store writes one. */
const storedTurn = (conversationId: string, id: string, user: string, context?: unknown) => {
  const at = Date.now() - 60 * 60 * 1000;
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
      if (m[1] === 'remember') return { name: 'remember', args: { fact: last.includes('Local mode') ? LOCAL_MODE_FACT : KEPT_FACT } };
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
    // The fence refuses every connection to that address: the server finds its model server silent, and the test
    // can count each time it tried.
    const srv = await startServer({ dir: runs.remote.dir, env: { OLLAMA_HOST: `http://${ELSEWHERE}:11434`, OLLAMA_MODEL: MAIN, ...cloudEnv(cloud) } });
    return { cloud, srv };
  };
  const startAlias = async () => {
    const ollama = await startOllamaStub({ [ALIAS]: { loaded: true, contextLength: 16384, remoteHost: 'https://ollama.com:443' }, [MEMORY_MODEL]: { loaded: false }, 'nomic-embed-text': { family: 'nomic-bert' } });
    const cloud = await startCloudStub();
    // The memory curator's reply: the fact each turn it is shown holds, with Will's own words for it.
    ollama.replyFor = (body, last) => {
      if (body.format === undefined || !last.includes('TURNS:')) return undefined;
      const turns = last.split('TURNS:')[1] ?? '';
      const facts = [
        ...(turns.includes('JASPERLARK') ? [{ turn: 1, quote: 'I keep the passport in the JASPERLARK cabinet', fact: PRIVATE_LEARNED, category: 'other', supersedes: [] }] : []),
        ...(turns.includes('CORALSWIFT') ? [{ turn: 1, quote: 'I keep the ladder in the CORALSWIFT garage', fact: OPEN_LEARNED, category: 'other', supersedes: [] }] : []),
      ];
      return JSON.stringify({ facts });
    };
    const srv = await startServer({
      dir: runs.alias.dir,
      env: {
        OLLAMA_HOST: ollama.origin, OLLAMA_MODEL: 'mine', OLLAMA_NUM_CTX: '16384', ...cloudEnv(cloud), OPENAI_API_KEY: 'sk-process-test-not-a-key',
        // Memory extraction on a local model, and its first pass a moment after boot instead of a minute and a half.
        FLINT_MEMORY_BRAIN: 'local', FLINT_MEMORY_MODEL: MEMORY_MODEL, FLINT_EXTRACT_FIRST_PASS_MS: '300',
      },
      // A conversation store from before: a turn Will kept private, and an ordinary one.
      seed: [{ path: ['memory', 'conversations.json'], text: JSON.stringify({ conversations: { 'kept-1': [storedTurn('kept-1', 'turn_kept', EXTRACT_PRIVATE, { private: true })], 'open-1': [storedTurn('open-1', 'turn_open', EXTRACT_OPEN)] } }) }],
    });
    return { ollama, cloud, srv };
  };
  [modes, remote, alias] = await Promise.all([startModes(), startRemote(), startAlias()]);
});
afterAll(async () => {
  await Promise.all([modes?.srv.stop(), remote?.srv.stop(), alias?.srv.stop()]);
  await Promise.all([modes?.ollama.close(), modes?.cloud.close(), remote?.cloud.close(), alias?.ollama.close(), alias?.cloud.close()]);
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
      // The model was told there is no such tool for this turn, and nothing reached a tool server or the cloud.
      expect(lastLocal().toolResults.join(' '), tool).toMatch(/Unknown tool|private/);
      expect(mcp.calls().length, tool).toBe(calls);
      expect(cloud.requests.length, tool).toBe(cloudBefore);
    }
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

  it('the log holds none of what was asked or answered, and every [route] line is made of the fields on the list', () => {
    const log = srv.log();
    expect(log).not.toContain(SECRET);
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
  let srv: Running;
  const reached = (): number => srv.guard().filter((e) => e.host === ELSEWHERE).length;

  beforeAll(async () => {
    ({ cloud, srv } = remote);
    // The server looks at its model server once behind its boot. Wait until that look is over and nothing more is
    // being tried, so that an attempt counted below can only be one a turn caused.
    for (let i = 0; i < 200 && !srv.log().includes('[local] provider=ollama'); i++) await sleep(25);
    for (let last = -1, still = 0; still < 8; await sleep(50)) {
      const now = reached();
      still = now === last ? still + 1 : 0;
      last = now;
    }
  });

  it('a private turn is refused with a sentence, and nothing of it is sent anywhere: not to that server, not to the cloud', async () => {
    expect((await srv.get('/health', null)).json).toMatchObject({ mode: 'cloud' });
    const before = { there: reached(), cloud: cloud.requests.length };
    for (const body of [
      { conversationId: 'm1', message: `A private synthetic question ${SECRET}.`, localOnly: true },
      { conversationId: 'm1', message: `Keep this private: ${SECRET} again.` },
    ]) {
      const r = await srv.post('/chat', body);
      expect(r).toMatchObject({ status: 503, json: { error: 'The local model server is on another machine, and a private message never leaves this Mac.' } });
    }
    const viaGenerate = await srv.post('/generate', { prompt: `A private synthetic prompt ${SECRET}.`, localOnly: true });
    expect(viaGenerate).toMatchObject({ status: 503, json: { error: 'The local model server is on another machine, and a private message never leaves this Mac.' } });
    // Not one connection was even attempted to the other machine for them (no chat, no embedding of the words).
    await sleep(150);
    expect(reached()).toBe(before.there);
    expect(cloud.requests).toHaveLength(before.cloud);
    expect(cloud.saw(SECRET)).toBe(false);
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
    expect(blocked(srv)).toEqual([]);
    // The stored private turn's reply: refused by its turn, and the speech service is not looked up.
    expect(await srv.post('/speak', { text: 'Noted.', conversationId: 'kept-1', turnId: 'turn_kept' })).toMatchObject({ status: 409, json: { fallback: 'browser' } });
    expect(blocked(srv)).toEqual([]);
    const spoken = await srv.post('/speak', { text: 'Synthetic ordinary words.', conversationId: 'speak-1', turnId: staysHere(r)?.turn });
    expect(spoken.status).not.toBe(409);
    expect(blocked(srv).map((e) => [e.kind, e.hostname])).toEqual([['dns-blocked', 'api.openai.com']]);
  });

  it('the log holds none of it', () => {
    const log = srv.log();
    for (const word of [SECRET, 'JASPERLARK', 'CORALSWIFT', 'Synthetic ordinary words', 'sk-ant-process-test']) expect(log, word).not.toContain(word);
  });
});
