/**
 * A turn that has called a tool is never handed to another brain.
 *
 * A fallback starts the turn over: the next tier, or the local model, is given
 * the question again and calls the tool again. A review on 2026-10-12 showed
 * calendar.create_event run twice that way, once by the frontier tier whose next
 * request then failed and once by the fallback. So: once a tool_call has gone
 * out, a failure ends the turn as a failure; and a failure that is not the
 * provider's (a tool that threw) never falls back at all.
 *
 * Real Flint clients and a real tool (it counts its own executions) behind
 * scripted providers, wired the way index.ts wires /chat and /generate, with the
 * same functions (runWithFallback, answerWithFallback, guardAnswer, mayAskAnother,
 * providerFailure, TurnLog). No network.
 */
import { describe, it, expect } from 'vitest';
import { ActionLogObserver, Flint, FlintError, InMemoryStore, makeAiError, type AiError, type ProviderAdapter, type StreamEvent, type Tool } from '@flint/core';
import { NoFallback, TOO_LONG_FOR_THE_CLOUD, mayAskAnother, outgrewTheCloud, promptRoom, providerFailure, runWithFallback, shouldFallBack, type BrainTier } from '../src/brains';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TurnLog, recordTurnEntry } from '../src/grounding';
import { NoAnswer, answerWithFallback, guardAnswer, unansweredMessage, type Unanswered } from '../src/unanswered';

const usage = { input: 3, output: 2 };
const overloaded = (): AiError => makeAiError('provider_unavailable', '529 Overloaded', { retryable: true, providerCode: '529' });
const toolThrew = (): AiError => makeAiError('internal', "Tool 'calendar.create_event' failed: boom", { retryable: false });

type Step = 'call-tool' | 'answer' | 'refuse' | (() => AiError);

/** A provider that plays `script`, one step per request; counts its requests. */
function scripted(name: string, script: Step[]) {
  const state = { requests: 0 };
  const provider: ProviderAdapter = {
    name,
    getCapabilities: () => ({ toolCalling: 'native', structuredOutput: 'native', streaming: 'full', maxContextTokens: 100_000, maxOutputTokens: 1_000 }),
    estimateTokens: () => 1,
    generate: () => Promise.reject(new Error('stream only')),
    async *stream(): AsyncIterable<StreamEvent> {
      const step = script[Math.min(state.requests++, script.length - 1)]!;
      if (typeof step === 'function') {
        yield { type: 'error', error: step() };
      } else if (step === 'call-tool') {
        yield { type: 'tool_call', call: { id: `toolu_${state.requests}`, toolName: 'calendar.create_event', args: { title: 'Dentist' } } };
        yield { type: 'done', reason: 'tool_call', usage };
      } else if (step === 'refuse') {
        yield { type: 'done', reason: 'refusal', usage };
      } else {
        yield { type: 'text', delta: `answer from ${name}` };
        yield { type: 'done', reason: 'complete', usage };
      }
    },
  };
  return { provider, state };
}

/** The server in miniature: a frontier chain, a local brain, one tool that counts how often it really ran. */
function server(frontier: Step[][], opts: { toolThrows?: boolean } = {}) {
  const memory = new InMemoryStore();
  // As index.ts: one action log, each entry filed under the turn that produced it.
  const observer = new ActionLogObserver(recordTurnEntry, 100);
  const retryPolicy = { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 };
  const executions: unknown[] = [];
  const tool: Tool = {
    definition: { name: 'calendar.create_event', description: 'Create an event', inputSchema: { type: 'object' }, idempotent: false },
    handler: async (call) => {
      executions.push(call.args);
      if (opts.toolThrows) throw new Error('boom');
      return { id: `ev${executions.length}` };
    },
  };
  const tiers = frontier.map((script, i) => scripted(`tier${i + 1}`, script));
  const local = scripted('ollama', ['call-tool', 'answer']); // the local model would call the tool too, given the turn
  const flintOn = (p: ProviderAdapter) => new Flint({ provider: p, defaultModel: p.name, memory, observer, retryPolicy });
  const chain: BrainTier<Flint>[] = tiers.map((t) => ({ tier: 'standard', provider: t.provider, model: t.provider.name, label: t.provider.name, persona: flintOn(t.provider) }));
  const localFlint = flintOn(local.provider);

  /** /generate's frontier call and its catch, as index.ts has them. */
  async function generate() {
    const turn = new TurnLog();
    const ask = (f: Flint) => turn.run(() => f.generate({ prompt: 'book the dentist', tools: [tool] }));
    try {
      const won = await answerWithFallback(chain, (b) => ask(b.persona), { acted: () => turn.acted });
      return { brain: 'frontier', text: won.result.text, unanswered: won.unanswered };
    } catch (err) {
      if (!mayAskAnother(err, { acted: turn.acted })) return { brain: 'frontier', failed: err };
      return { brain: 'local', text: (await ask(localFlint)).text };
    }
  }

  /** /chat's pump, tier chain and catch, as index.ts has them. */
  async function chat() {
    let answer = '';
    let acted = false;
    let brain = 'frontier';
    const forwarded: StreamEvent[] = [];
    const noAnswers: Unanswered[] = [];
    const pump = async (f: Flint, recoverable = false, tried?: number) => {
      const events = f.chat({ conversationId: 'c', message: 'book the dentist', tools: [tool] });
      for await (const ev of tried === undefined ? events : guardAnswer(events, { recoverable, tried, noAnswers })) {
        if (ev.type === 'text') answer += ev.delta;
        if (ev.type === 'tool_call') acted = true;
        if ((recoverable || tried !== undefined) && ev.type === 'error' && answer.length === 0 && !acted && providerFailure(ev.error)) throw new FlintError(ev.error);
        forwarded.push(ev);
      }
    };
    try {
      await runWithFallback(
        chain,
        async (b) => {
          try {
            await pump(b.persona, b !== chain[chain.length - 1], chain.indexOf(b) + 1);
          } catch (err) {
            if (answer.length > 0) throw new NoFallback(err);
            throw err;
          }
        },
        { acted: () => acted },
      );
    } catch (err) {
      if (answer.length === 0 && mayAskAnother(err, { acted })) {
        brain = 'local';
        await pump(localFlint);
      } else {
        throw err;
      }
    }
    return { brain, answer, forwarded };
  }

  return { generate, chat, executions, tiers, local, memory };
}

describe('the rule (./brains)', () => {
  it('providerFailure: everything but the tool loop\'s own errors', () => {
    for (const e of [overloaded(), makeAiError('timeout', 't', { retryable: true }), makeAiError('rate_limit', '429'), makeAiError('validation', '400 no credit', { providerCode: '400' }), makeAiError('context_overflow', 'too long')]) {
      expect(providerFailure(e), e.kind).toBe(true);
    }
    // An `internal` error that is the provider's: an HTTP status the adapter has no kind for, a stream that broke.
    expect(providerFailure(makeAiError('internal', '413 request too large', { providerCode: '413' }))).toBe(true);
    expect(providerFailure(makeAiError('internal', 'Unexpected end of JSON input'))).toBe(true);
    expect(providerFailure(toolThrew())).toBe(false);
    expect(providerFailure(makeAiError('internal', 'Tool loop exceeded 8 iterations without completing. The answer-only call came back empty.'))).toBe(false);
  });

  it('outgrewTheCloud: a cloud window too small for a turn the local model could not fit either; then the local model is not asked after it', () => {
    const overflow = new FlintError(makeAiError('context_overflow', 'The newest message does not fit this model\'s window', { retryable: false }));
    const plain = { media: false, localRoom: 16_384 - 4_096, rooms: [200_000 - 64_000, 128_000 - 16_000] };
    expect(outgrewTheCloud(overflow, plain)).toBe(true);
    for (const e of [overloaded(), makeAiError('rate_limit', '429'), makeAiError('timeout', 't', { retryable: true }), makeAiError('internal', '413 request too large', { providerCode: '413' })]) {
      expect(outgrewTheCloud(new FlintError(e), plain), e.kind).toBe(false);
    }
    expect(outgrewTheCloud(new Error('context_overflow'), plain)).toBe(false);
    // A turn with a PDF or a picture: the local model is handed a PDF as text cut to its window, so a PDF too large
    // for the cloud may be read here (Hybrid's planned fallback). It is asked.
    expect(outgrewTheCloud(overflow, { ...plain, media: true })).toBe(false);
    // A brain with less room for the prompt than the local model (a tier on a local wire, or a 32k window keeping 20k
    // for its reply) says nothing about the local model.
    expect(outgrewTheCloud(overflow, { ...plain, rooms: [136_000, 8_192] })).toBe(false);
    expect(outgrewTheCloud(overflow, { ...plain, rooms: [promptRoom({ maxContextTokens: 32_000, maxOutputTokens: 20_000 })] })).toBe(false);
    expect(outgrewTheCloud(overflow, { ...plain, rooms: [] })).toBe(false);
    expect(promptRoom({ maxContextTokens: 1_000, maxOutputTokens: 4_000 })).toBe(0);
    // Every place a cloud failure can fall to the local model asks it first (index.ts: /generate and /chat).
    const index = readFileSync(join(__dirname, '../src/index.ts'), 'utf8');
    expect(index.match(/mayAskAnother\(err, \{ acted[^)]*\}\) \|\| outgrew\(err\)/g)).toHaveLength(1);
    expect(index.match(/mayAskAnother\(err, \{ acted, signal: ac\.signal \}\) && !outgrew\(err\)/g)).toHaveLength(2);
    for (const ind of ['    ', '      ']) {
      expect(index, `outgrew at ${ind.length}`).toContain([
        `${ind}const outgrew = (err: unknown): boolean =>`,
        `${ind}  outgrewTheCloud(err, {`,
        `${ind}    media: attachments.some((a) => a.kind === 'image' || a.kind === 'document'),`,
        `${ind}    localRoom: Math.max(0, ...localPlan.steps.flatMap((s) => (s.kind === 'local' ? [promptRoom(ctx.inference.primary.provider.getCapabilities(s.model))] : []))),`,
        `${ind}    rooms: plan?.chain.map((b) => promptRoom(b.provider.getCapabilities(b.model))) ?? [],`,
        `${ind}  });`,
      ].join('\n'));
    }
    expect(index).toContain("if (outgrew(err)) return json(res, 413, { error: TOO_LONG_FOR_THE_CLOUD, ...evalFields() });");
    expect(TOO_LONG_FOR_THE_CLOUD).toBe('This message is longer than the cloud model can read. Send a shorter one, or split it up.');
  });

  // The rule reads core's own wording, so this runs the real tool loop: if core rewords it, this fails.
  it('providerFailure knows the error core raises when a tool handler throws', async () => {
    const s = server([['call-tool', 'answer']], { toolThrows: true });
    const { forwarded } = await s.chat();
    const last = forwarded.at(-1)!;
    expect(last.type).toBe('error');
    expect(last.type === 'error' && providerFailure(last.error)).toBe(false);
    expect(last.type === 'error' && last.error).toMatchObject({ kind: 'internal', message: expect.stringMatching(/^Tool 'calendar\.create_event' failed/) });
  });

  it('shouldFallBack: a tool\'s own error does not move on to another brain; a refusal and a provider error do', () => {
    expect(shouldFallBack(new FlintError(toolThrew()))).toBe(false);
    expect(shouldFallBack(new FlintError(overloaded()))).toBe(true);
    expect(shouldFallBack(new NoAnswer('refusal'))).toBe(true);
  });

  it('mayAskAnother: never once the turn has acted, whatever failed', () => {
    expect(mayAskAnother(new FlintError(overloaded()), { acted: false })).toBe(true);
    expect(mayAskAnother(new FlintError(overloaded()), { acted: true })).toBe(false);
    expect(mayAskAnother(new NoAnswer('empty'), { acted: true })).toBe(false);
    expect(mayAskAnother(new FlintError(toolThrew()), { acted: false })).toBe(false);
    const gone = new AbortController();
    gone.abort();
    expect(mayAskAnother(new FlintError(overloaded()), { acted: false, signal: gone.signal })).toBe(false);
  });

  it('runWithFallback stops at the first failure once `acted` says so', async () => {
    const asked: string[] = [];
    let acted = false;
    const chain = ['a', 'b'].map((l) => ({ tier: 'standard', provider: {} as ProviderAdapter, model: l, label: l, persona: l }) as BrainTier<string>);
    const attempt = async (b: BrainTier<string>) => {
      asked.push(b.label);
      acted = true;
      throw new FlintError(overloaded());
    };
    await expect(runWithFallback(chain, attempt, { acted: () => acted })).rejects.toBeInstanceOf(FlintError);
    expect(asked).toEqual(['a']);
  });
});

describe.each(['chat', 'generate'] as const)('/%s: a tool ran, then the provider failed', (route) => {
  it('a 529 after the tool call: no fallback to the next tier or the local model, and the tool ran once', async () => {
    const s = server([['call-tool', overloaded], ['call-tool', 'answer']]);
    const r = await s[route]();
    expect(s.executions).toHaveLength(1); // calendar.create_event was not run a second time
    expect(s.tiers[1]!.state.requests).toBe(0);
    expect(s.local.state.requests).toBe(0);
    expect(r.brain).toBe('frontier');
    if (route === 'chat') {
      // The failure reaches the console as the reply stopping, not as a second attempt.
      expect((r as Awaited<ReturnType<typeof s.chat>>).forwarded.at(-1)).toMatchObject({ type: 'error', error: { kind: 'provider_unavailable' } });
      expect(await s.memory.getMessages('c')).toEqual([]);
    } else {
      expect((r as { failed?: unknown }).failed).toBeInstanceOf(FlintError);
    }
  });

  it('the same on a single-brain chain: the local model is not asked to do it again', async () => {
    const s = server([['call-tool', overloaded]]);
    await s[route]();
    expect(s.executions).toHaveLength(1);
    expect(s.local.state.requests).toBe(0);
  });

  it('the tool itself throwing is not the provider failing: no fallback, one execution', async () => {
    const s = server([['call-tool', 'answer'], ['call-tool', 'answer']], { toolThrows: true });
    const r = await s[route]();
    expect(s.executions).toHaveLength(1);
    expect(s.tiers[1]!.state.requests).toBe(0);
    expect(s.local.state.requests).toBe(0);
    expect(r.brain).toBe('frontier');
  });

  it('a refusal after the tool call gets the honest message at once, not another brain', async () => {
    const s = server([['call-tool', 'refuse'], ['call-tool', 'answer']]);
    const r = await s[route]();
    expect(s.executions).toHaveLength(1);
    expect(s.tiers[1]!.state.requests).toBe(0);
    expect(s.local.state.requests).toBe(0);
    const text = route === 'chat' ? (r as { answer: string }).answer : (r as { text: string }).text;
    expect(text).toBe(unansweredMessage('refusal', 1));
  });

  // The control: nothing has acted yet, so an outage still falls back as before.
  it('a 529 before any tool call still falls back, and the tool then runs once, for the brain that answers', async () => {
    const next = server([[overloaded], ['call-tool', 'answer']]);
    expect(await next[route]()).toMatchObject({ brain: 'frontier' });
    expect(next.executions).toHaveLength(1);
    expect(next.local.state.requests).toBe(0);

    const local = server([[overloaded]]);
    expect(await local[route]()).toMatchObject({ brain: 'local' });
    expect(local.executions).toHaveLength(1);
    expect(local.local.state.requests).toBe(2);
  });
});

describe('guardAnswer after a tool call', () => {
  async function* play(events: StreamEvent[]): AsyncGenerator<StreamEvent> {
    for (const e of events) yield e;
  }
  const call: StreamEvent = { type: 'tool_call', call: { id: 'c', toolName: 'calendar.create_event', args: {} } };

  it('a silent refusal on a tier with a fallback is not retried: the honest message goes out instead', async () => {
    const out: StreamEvent[] = [];
    for await (const ev of guardAnswer(play([call, { type: 'done', reason: 'refusal', usage }]), { recoverable: true, tried: 1, noAnswers: [] })) out.push(ev);
    expect(out.map((e) => e.type)).toEqual(['tool_call', 'text', 'done']);
    expect(out[1]).toEqual({ type: 'text', delta: unansweredMessage('refusal', 1) });
  });
});
