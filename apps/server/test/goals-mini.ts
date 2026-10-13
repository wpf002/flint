/**
 * The server in miniature, for the tests of Will's goals in chat: real Flint
 * clients and personas, the real conversation store on a temp file, a real tier
 * set, and the module index.ts hands every goals decision to (../src/goals-chat
 * GoalsChat): which history a brain reads, each ask's context, tools and mark,
 * which asks run as a local model's turn. What is left here is /chat's shape
 * (the pump, the tier chain, the fall back to the local model) and nothing that
 * decides what a brain is given. Behind it, providers that keep every request
 * they are given. No network. Synthetic text only.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Flint, makeAiError, type GenerateArgs, type ProviderAdapter, type StreamEvent, type Tool } from '@flint/core';
import { Persona } from '@flint/persona';
import { BrainSet, NoFallback, runWithFallback, type BrainTier } from '../src/brains';
import { GoalsChat, type KeptTools, type StaysHereEvent } from '../src/goals-chat';
import { recallContext } from '../src/grounding';
import type { KnowledgeStore } from '../src/knowledge';
import { LOCALITY, type ListedModel } from '../src/ollama-locality';
import { PersistentStore } from '../src/persistent-store';
import type { StayRoute } from '../src/private-turns';
import { asLocalTurn, isLocalTurn } from '../src/turn-taint';

export const CANARY = 'CANARY-p3goals';
export const RT = { url: 'http://[::1]:8090', token: 'c'.repeat(64) };
export const HERE = 'http://127.0.0.1:11434';
export const RECALL = 'RECALL-MARK what Flint remembers';
export const WORLD = 'WORLD-MARK services: all ok';
/** The persona's guide in the miniature server (its length is part of every prompt's size). */
export const GUIDE = 'Be brief.';

const dirs: string[] = [];

export const goal = (n: number, over: Record<string, unknown> = {}) => ({
  ref: `goal#g${String(n).padStart(5, '0')}`,
  title: `${CANARY} goal ${n}`,
  checks: { met: 2, total: 3, unknown: 0 },
  onTrack: { likelihood: 'likely', percent: 70, by: '2026-12-01' },
  finishBy: '2026-12-01',
  steps: { open: 3, overdue: 1 },
  ...over,
});
export const answer = (goals: unknown[] = [goal(1)], more = 0) => ({ goals, more });

/** A fresh temp directory (removed by `cleanup`). */
export function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'flint-goals-'));
  dirs.push(dir);
  return dir;
}

/** A fresh conversation store on a temp file (removed by `cleanup`). */
export function tmpStore(opts: ConstructorParameters<typeof PersistentStore>[1] = { history: null }): PersistentStore {
  return new PersistentStore(join(tmpDir(), 'conversations.json'), opts);
}

/** A complete turn in the store as Flint.chat writes one: with this call context (the mark), these words. */
export async function storedTurn(store: PersistentStore, o: { conversationId?: string; id: string; context?: unknown; user: string; assistant: string; at?: number }): Promise<void> {
  const at = o.at ?? Date.now();
  const conversationId = o.conversationId ?? 'c1';
  await store.beginTurn({ conversationId, turnId: o.id, createdAt: at, ...(o.context !== undefined ? { context: o.context } : {}), userMessage: { id: `${o.id}_u`, role: 'user', content: o.user, timestamp: at } });
  await store.commitTurn({ conversationId, turnId: o.id, updatedAt: at, usage: { input: 1, output: 1 }, responseMessages: [{ id: `${o.id}_a`, role: 'assistant', content: o.assistant, timestamp: at }] });
}

/** What a scripted provider does with one request: answer, fail before any text, or say these words. */
export type Step = 'answer' | 'fail' | { say: string };

export interface Recorded {
  provider: ProviderAdapter & { baseURL?: string; numCtx?: number };
  requests: GenerateArgs[];
  /** For each request, whether it was made as a local model's turn (./turn-taint isLocalTurn): what a tool it called would see. */
  localTurns: boolean[];
  /** Everything this provider was ever sent, as text: the system prompt, every message, every tool. */
  seen: () => string;
}

/** A provider that keeps every request it is given and plays `script`, one step per request. */
export function recording(name: string, script: Step[], o: { baseURL?: string; numCtx?: number; maxContext?: number; maxOutput?: number } = {}): Recorded {
  const requests: GenerateArgs[] = [];
  const localTurns: boolean[] = [];
  const provider: Recorded['provider'] = {
    name,
    ...(o.baseURL ? { baseURL: o.baseURL } : {}),
    ...(o.numCtx ? { numCtx: o.numCtx } : {}),
    getCapabilities: () => ({ toolCalling: 'native', structuredOutput: 'native', streaming: 'full', maxContextTokens: o.maxContext ?? 100_000, maxOutputTokens: o.maxOutput ?? 1_000 }),
    estimateTokens: () => 1,
    generate: () => Promise.reject(new Error('stream only')),
    async *stream(args: GenerateArgs): AsyncIterable<StreamEvent> {
      requests.push(args);
      localTurns.push(isLocalTurn());
      const step = script[Math.min(requests.length - 1, script.length - 1)]!;
      if (step === 'fail') {
        yield { type: 'error', error: makeAiError('provider_unavailable', '529 Overloaded', { retryable: false, providerCode: '529' }) };
        return;
      }
      yield { type: 'text', delta: step === 'answer' ? `answer from ${name}` : step.say };
      yield { type: 'done', reason: 'complete', usage: { input: 3, output: 2 } };
    },
  };
  return { provider, requests, localTurns, seen: () => JSON.stringify(requests.map(({ signal: _signal, ...rest }) => rest)) };
}

/** Remove the temp stores the miniature servers made, and forget what their Ollamas listed (call from afterEach). */
export function cleanup(): void {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  LOCALITY.clear();
}

/**
 * What an Ollama says runs on it (its /api/tags), as the server would have
 * learned it (../src/ollama-locality): these models, on this Mac unless a row
 * says otherwise. Known for good, whatever the test does to the clock.
 */
export function listed(baseURL: string, models: Array<string | ListedModel>): void {
  LOCALITY.learn(baseURL, models.map((m) => (typeof m === 'string' ? { name: m } : m)), Number.POSITIVE_INFINITY);
}

export interface BrainSpec {
  name: string;
  model: string;
  script?: Step[];
  baseURL?: string;
  numCtx?: number;
  maxContext?: number;
  maxOutput?: number;
}

export interface MiniOptions {
  /** The frontier chain, in order: the first is every tier's brain, the second the last resort. */
  frontier: BrainSpec[];
  /** The local brain. Default: an Ollama model on this Mac. */
  local?: BrainSpec;
  /** The standby local model (it answers while the main one loads), named for the gate beside the local brain. Default: none. */
  standby?: BrainSpec;
  toFrontier?: boolean;
  /** What the runtime answers for /v1/goals/now. Default: two goals. */
  goals?: unknown;
  /** The runtime does not answer: its fetch fails. */
  runtimeDown?: boolean;
  /** The tools every turn offers (the router's selection). */
  tools?: Tool[];
  /** What an ask that carries what stays here is offered (./goals-tools), by the marks its turn carries. */
  goalsTools?: KeptTools;
  /** FLINT_GOALS_NOW: is the goals block on? Default: on. */
  goalsOn?: boolean;
  /** Long-term memory, recalled into each turn's context as main() does. Default: none (the context is the RECALL mark alone). */
  knowledge?: KnowledgeStore;
  /** The conversation store's file, to reopen one a server before this one wrote. */
  storePath?: string;
  /**
   * What each Ollama lists, by address. Default: every `ollama` brain here is
   * listed by its own Ollama as running on it (a real model, pulled). Pass an
   * address to say otherwise: no rows (it lists nothing), or a row with a
   * `remote_host` (a cloud model under a local-looking name).
   */
  listings?: Record<string, Array<string | ListedModel>>;
  /** How long the conversation store's history window is. Default: every complete turn. */
  history?: { maxTurns: number; maxAgeMs: number } | null;
}

export function miniServer(o: MiniOptions) {
  const dir = o.storePath ? undefined : mkdtempSync(join(tmpdir(), 'flint-goals-'));
  if (dir) dirs.push(dir);
  const storePath = o.storePath ?? join(dir!, 'conversations.json');
  // Every complete turn is history here unless a test says otherwise: the window has its own tests.
  const store = new PersistentStore(storePath, { history: o.history ?? null });
  const toFrontier = o.toFrontier ?? false;
  const retryPolicy = { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 };
  const logs: string[] = [];
  let fetched = 0;
  // As main(): one GoalsChat, built before any brain.
  const goalsChat = new GoalsChat<Persona>({
    memory: store,
    blocks: { goals: o.goalsOn ?? true, goalsToFrontier: toFrontier },
    runtime: () => RT,
    log: (m) => logs.push(m),
    // What each Ollama lists is given below: nothing here asks one.
    locality: { watch: () => Promise.resolve() },
    fetchImpl: (async () => {
      fetched++;
      if (o.runtimeDown) throw new Error('connect ECONNREFUSED');
      return new Response(JSON.stringify(o.goals ?? answer([goal(1), goal(2)])));
    }) as unknown as typeof fetch,
  });
  // As main(): each brain reads the conversation through the module's history.
  const personaOn = (p: ProviderAdapter, model: string) =>
    new Persona(new Flint({ provider: p, defaultModel: model, memory: goalsChat.history(p, model), retryPolicy }), { name: 'Flint', styleGuide: GUIDE });
  const made = (b: BrainSpec) => ({ ...recording(b.name, b.script ?? ['answer'], b), model: b.model });
  const tiers = o.frontier.map(made);
  const localSpec = o.local ?? { name: 'ollama', model: 'qwen2.5:14b', baseURL: HERE };
  const local = made(localSpec);
  // What each brain's Ollama lists: by default, every model a brain here names.
  const byHost = new Map<string, string[]>();
  for (const b of [...o.frontier, localSpec]) if (b.name === 'ollama' && b.baseURL) byHost.set(b.baseURL, [...(byHost.get(b.baseURL) ?? []), b.model]);
  for (const [url, models] of byHost) if (!o.listings || !(url in o.listings)) listed(url, models);
  for (const [url, rows] of Object.entries(o.listings ?? {})) listed(url, rows);
  const brains: BrainTier<Persona>[] = tiers.map((t) => ({ tier: 'standard', provider: t.provider, model: t.model, label: `${t.provider.name}:${t.model}`, persona: personaOn(t.provider, t.model) }));
  const localPersona = personaOn(local.provider, local.model);
  const standby = o.standby ? made(o.standby) : undefined;
  if (standby && o.standby!.name === 'ollama' && o.standby!.baseURL && !(o.listings && o.standby!.baseURL in o.listings)) listed(o.standby!.baseURL, [...(byHost.get(o.standby!.baseURL) ?? []), o.standby!.model]);
  const standbyPersona = standby ? personaOn(standby.provider, standby.model) : undefined;
  const first = brains[0];
  const set = first ? new BrainSet<Persona>({ routine: first, standard: first, hard: first, code: first }, brains[1]) : undefined;
  const chain = set ? set.chain('standard') : [];
  // As main(): every brain /chat can ask is named for the gate.
  goalsChat.name(
    { persona: localPersona, provider: local.provider, model: local.model },
    set,
    o.goalsTools ?? ((offered) => offered),
    standby && standbyPersona ? [{ persona: standbyPersona, provider: standby.provider, model: standby.model }] : [],
  );
  const selected = o.tools ?? [];

  /**
   * One /chat turn: `brain` is the route's choice; a frontier turn that fails before any text falls back to the
   * local model (`standby`: the standby local model answers it). `route`: how the turn was routed, when it is one
   * Will kept private or one taken in Local mode (./private-turns).
   */
  async function chat(brain: 'frontier' | 'local' | 'standby', message = 'how are my goals going?', conversationId = 'c1', route?: StayRoute) {
    const base = `[Context] ${RECALL}`;
    // Recall, as contextFor: the whole block, its twin without the facts that stay on this Mac, and the one
    // without only the facts from a turn Will kept private.
    const recalled = o.knowledge ? await recallContext(base, message, o.knowledge) : { block: base, outside: { block: base }, lifted: { block: base } };
    const ctxBlock = recalled.block;
    const outsideCtx = recalled.outside.block;
    const liftedCtx = recalled.lifted.block;
    // World now is the frontier's only; what stays here is decided for whichever brain ends up asked.
    const [world, goals] = await Promise.all([brain === 'frontier' ? WORLD : '', goalsChat.forTurn(conversationId, message, route)]);
    const frontierCtx = world ? `${ctxBlock}\n\n${world}` : ctxBlock;
    let goalsTokens = 0;
    let answerText = '';
    let answeredBy: 'frontier' | 'local' | 'standby' = brain;
    /** The `meta` events the client was sent about the reply staying here, in order. */
    const metas: StaysHereEvent[] = [];
    /** Each ask the turn made: the tools it was offered and the mark its turn was stored with. */
    const asks: Array<{ tools: string[]; mark: unknown; offered: readonly Tool[] }> = [];
    const pump = async (persona: Persona, _recoverable = false, tried?: number, context = ctxBlock) => {
      const asked = goals.ask(persona, { context, whole: ctxBlock, outside: outsideCtx, lifted: liftedCtx, tools: selected });
      asks.push({ tools: asked.tools.map((t) => t.definition.name), mark: asked.mark.context, offered: asked.tools });
      goalsTokens = asked.tokens;
      const events = persona.chat(
        { conversationId, message, context: asked.context, ...(asked.tools.length ? { tools: [...asked.tools] } : {}) },
        { ...asked.mark },
      );
      for await (const ev of events) {
        const here = asked.meta();
        if (here) metas.push(here);
        if (ev.type === 'text') answerText += ev.delta;
        if (tried !== undefined && ev.type === 'error' && answerText.length === 0) throw new Error(ev.error.message);
      }
    };
    if (brain === 'frontier') {
      try {
        await runWithFallback(chain, async (b) => {
          try {
            await goalsChat.run(b, async () => {
              await pump(b.persona, b !== chain[chain.length - 1], chain.indexOf(b) + 1, frontierCtx);
            });
          } catch (err) {
            if (answerText.length > 0) throw new NoFallback(err);
            throw err;
          }
        });
      } catch {
        answeredBy = 'local';
        await asLocalTurn(() => pump(localPersona));
      }
    } else if (brain === 'standby') {
      if (!standbyPersona) throw new Error('this miniature server has no standby model');
      await asLocalTurn(() => pump(standbyPersona));
    } else {
      await asLocalTurn(() => pump(localPersona));
    }
    // As /chat: once the turn is answered, the mark its entry in the training corpus carries.
    return { answer: answerText, answeredBy, goalsTokens, metas, asks, corpus: goals.corpus() };
  }
  return { chat, tiers, local, standby, logs, goalsChat, store, storePath, chain, set, localPersona, fetched: () => fetched };
}
