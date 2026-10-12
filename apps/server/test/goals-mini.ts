/**
 * The server in miniature, for the tests of Will's goals in chat: real Flint
 * clients and personas, the real conversation store on a temp file, a real tier
 * set, and /chat's own wiring (the per-ask arguments, the pump, the tier chain,
 * the fall back to the local model), built with the functions main() calls.
 * Behind them, providers that keep every request they are given. No network.
 * Synthetic text only.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Flint, makeAiError, type GenerateArgs, type ProviderAdapter, type StreamEvent, type Tool } from '@flint/core';
import { Persona } from '@flint/persona';
import { BrainSet, NoFallback, runWithFallback, type BrainTier } from '../src/brains';
import { goalsForChat, historyFor } from '../src/goals-now';
import { PersistentStore } from '../src/persistent-store';
import { brainOf } from '../src/policy';

export const CANARY = 'CANARY-p3goals';
export const RT = { url: 'http://[::1]:8090', token: 'c'.repeat(64) };
export const HERE = 'http://127.0.0.1:11434';
export const RECALL = 'RECALL-MARK what Flint remembers';
export const WORLD = 'WORLD-MARK services: all ok';
/** The persona's guide in the miniature server (its length is part of every prompt's size). */
export const GUIDE = 'Be brief.';

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

/** What a scripted provider does with one request: answer, fail before any text, or say these words. */
export type Step = 'answer' | 'fail' | { say: string };

export interface Recorded {
  provider: ProviderAdapter & { baseURL?: string; numCtx?: number };
  requests: GenerateArgs[];
  /** Everything this provider was ever sent, as text: the system prompt, every message, every tool. */
  seen: () => string;
}

/** A provider that keeps every request it is given and plays `script`, one step per request. */
export function recording(name: string, script: Step[], o: { baseURL?: string; numCtx?: number; maxContext?: number; maxOutput?: number } = {}): Recorded {
  const requests: GenerateArgs[] = [];
  const provider: Recorded['provider'] = {
    name,
    ...(o.baseURL ? { baseURL: o.baseURL } : {}),
    ...(o.numCtx ? { numCtx: o.numCtx } : {}),
    getCapabilities: () => ({ toolCalling: 'native', structuredOutput: 'native', streaming: 'full', maxContextTokens: o.maxContext ?? 100_000, maxOutputTokens: o.maxOutput ?? 1_000 }),
    estimateTokens: () => 1,
    generate: () => Promise.reject(new Error('stream only')),
    async *stream(args: GenerateArgs): AsyncIterable<StreamEvent> {
      requests.push(args);
      const step = script[Math.min(requests.length - 1, script.length - 1)]!;
      if (step === 'fail') {
        yield { type: 'error', error: makeAiError('provider_unavailable', '529 Overloaded', { retryable: false, providerCode: '529' }) };
        return;
      }
      yield { type: 'text', delta: step === 'answer' ? `answer from ${name}` : step.say };
      yield { type: 'done', reason: 'complete', usage: { input: 3, output: 2 } };
    },
  };
  return { provider, requests, seen: () => JSON.stringify(requests.map(({ signal: _signal, ...rest }) => rest)) };
}

const dirs: string[] = [];
/** Remove the temp stores the miniature servers made (call from afterEach). */
export function cleanup(): void {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
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
  toFrontier?: boolean;
  /** What the runtime answers for /v1/goals/now. Default: two goals. */
  goals?: unknown;
  /** The tools every turn offers (the router's selection). */
  tools?: Tool[];
  /** What an ask that carries the goals is offered (./goals-tools). */
  goalsTools?: (offered: readonly Tool[]) => readonly Tool[];
  /** The conversation store's file, to reopen one a server before this one wrote. */
  storePath?: string;
}

export function miniServer(o: MiniOptions) {
  const dir = o.storePath ? undefined : mkdtempSync(join(tmpdir(), 'flint-goals-'));
  if (dir) dirs.push(dir);
  const storePath = o.storePath ?? join(dir!, 'conversations.json');
  // Every complete turn is history here: the window has its own tests.
  const store = new PersistentStore(storePath, { history: null });
  const toFrontier = o.toFrontier ?? false;
  const retryPolicy = { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 };
  // As main(): each brain reads the conversation through historyFor.
  const personaOn = (p: ProviderAdapter, model: string) =>
    new Persona(new Flint({ provider: p, defaultModel: model, memory: historyFor(store, brainOf(p, model), toFrontier), retryPolicy }), { name: 'Flint', styleGuide: GUIDE });
  const made = (b: BrainSpec) => ({ ...recording(b.name, b.script ?? ['answer'], b), model: b.model });
  const tiers = o.frontier.map(made);
  const local = made(o.local ?? { name: 'ollama', model: 'qwen2.5:14b', baseURL: HERE });
  const brains: BrainTier<Persona>[] = tiers.map((t) => ({ tier: 'standard', provider: t.provider, model: t.model, label: `${t.provider.name}:${t.model}`, persona: personaOn(t.provider, t.model) }));
  const localPersona = personaOn(local.provider, local.model);
  const logs: string[] = [];
  const first = brains[0];
  const set = first ? new BrainSet<Persona>({ routine: first, standard: first, hard: first, code: first }, brains[1]) : undefined;
  const chain = set ? set.chain('standard') : [];
  const GOALS = goalsForChat<Persona>({
    runtime: () => RT,
    local: { persona: localPersona, provider: local.provider, model: local.model },
    tiers: set,
    toFrontier,
    ...(o.goalsTools ? { tools: o.goalsTools } : {}),
    log: (m) => logs.push(m),
    fetchImpl: (async () => new Response(JSON.stringify(o.goals ?? answer([goal(1), goal(2)])))) as unknown as typeof fetch,
  });
  const selected = o.tools ?? [];

  /** One /chat turn: `brain` is the route's choice; a frontier turn that fails before any text falls back to the local model. */
  async function chat(brain: 'frontier' | 'local', message = 'how are my goals going?', conversationId = 'c1') {
    const ctxBlock = `[Context] ${RECALL}`;
    // World now is the frontier's only; Will's goals are fetched for whichever brain ends up asked.
    const [world, goals] = await Promise.all([brain === 'frontier' ? WORLD : '', GOALS?.forTurn()]);
    const frontierCtx = world ? `${ctxBlock}\n\n${world}` : ctxBlock;
    let goalsTokens = 0;
    const restChars = message.length + store.historyChars(conversationId);
    // The arguments of every ask, as index.ts builds them.
    const chatArgs = (persona: Persona, context: string): Parameters<Persona['chat']> => {
      const asked = goals
        ? goals.ask(persona, { context, tools: selected, promptChars: persona.styleGuide.length + restChars })
        : { context, tools: selected, tokens: 0, mark: {} };
      goalsTokens = asked.tokens;
      return [{ conversationId, message, context: asked.context, ...(asked.tools.length ? { tools: [...asked.tools] } : {}) }, { ...asked.mark }];
    };
    let answerText = '';
    let answeredBy = brain;
    const pump = async (persona: Persona, _recoverable = false, tried?: number, context = ctxBlock) => {
      const events = persona.chat(
        ...chatArgs(persona, context),
      );
      for await (const ev of events) {
        if (ev.type === 'text') answerText += ev.delta;
        if (tried !== undefined && ev.type === 'error' && answerText.length === 0) throw new Error(ev.error.message);
      }
    };
    if (brain === 'frontier') {
      try {
        await runWithFallback(chain, async (b) => {
          try {
            await pump(b.persona, b !== chain[chain.length - 1], chain.indexOf(b) + 1, frontierCtx);
          } catch (err) {
            if (answerText.length > 0) throw new NoFallback(err);
            throw err;
          }
        });
      } catch {
        answeredBy = 'local';
        await pump(localPersona);
      }
    } else {
      await pump(localPersona);
    }
    return { answer: answerText, answeredBy, goalsTokens };
  }
  return { chat, tiers, local, logs, GOALS, store, storePath, chain, localPersona };
}
