import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  Flint,
  FlintError,
  InMemoryStore,
  makeAiError,
  type ProviderAdapter,
  type StreamEvent,
} from '@flint/core';
import { NoFallback, runWithFallback, type BrainTier } from '../src/brains';
import {
  NoAnswer,
  answerWithFallback,
  guardAnswer,
  isUnansweredMessage,
  unanswered,
  unansweredMessage,
  type ReplyLike,
} from '../src/unanswered';
import { TrainingLogger } from '../src/training';

const usage = { input: 1, output: 1 };

/** A BrainTier around any persona-like value (only label and persona are read). */
function tier<P>(label: string, persona: P): BrainTier<P> {
  return { tier: 'standard', provider: {} as ProviderAdapter, model: label, label, persona };
}

/** A collected reply, the shape Persona.generate returns. */
function reply(text: string, reason = 'complete', usedTools = false): ReplyLike & { usage: typeof usage } {
  return { text, reason, usage, messages: usedTools ? [{ role: 'tool' }, { role: 'tool_result' }, { role: 'assistant' }] : [{ role: 'assistant' }] };
}

async function collect(it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of it) out.push(ev);
  return out;
}

async function* play(events: StreamEvent[]): AsyncGenerator<StreamEvent> {
  for (const e of events) yield e;
}

describe('unanswered', () => {
  it('a refusal is never an answer, even with partial text', () => {
    expect(unanswered({ text: '', reason: 'refusal', usedTools: false })).toBe('refusal');
    expect(unanswered({ text: 'Sure, first you', reason: 'refusal', usedTools: false })).toBe('refusal');
    expect(unanswered({ text: '', reason: 'refusal', usedTools: true })).toBe('refusal');
  });

  it('no text and no tool call is empty; a tool-only turn is left alone', () => {
    expect(unanswered({ text: '', reason: 'complete', usedTools: false })).toBe('empty');
    expect(unanswered({ text: ' \n ', reason: 'complete', usedTools: false })).toBe('empty');
    expect(unanswered({ text: '', reason: 'complete', usedTools: true })).toBeUndefined();
  });

  it('text is an answer', () => {
    expect(unanswered({ text: 'Paris.', reason: 'complete', usedTools: false })).toBeUndefined();
    expect(unanswered({ text: 'cut off mid', reason: 'max_tokens', usedTools: false })).toBeUndefined();
  });
});

describe('the honest message', () => {
  it('says how many models it tried', () => {
    expect(unansweredMessage('refusal', 1)).toMatch(/the model I asked declined it/);
    expect(unansweredMessage('refusal', 3)).toMatch(/all 3 models I tried declined it/);
    expect(unansweredMessage('empty', 2)).toMatch(/all 2 models I tried returned nothing/);
  });

  it('is recognisable, and a real answer is not', () => {
    expect(isUnansweredMessage(unansweredMessage('refusal', 1))).toBe(true);
    expect(isUnansweredMessage(`  ${unansweredMessage('empty', 4)}`)).toBe(true);
    expect(isUnansweredMessage("I can't stand that restaurant, honestly.")).toBe(false);
    expect(isUnansweredMessage('Paris.')).toBe(false);
  });

  it('never enters the training corpus', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flint-train-'));
    try {
      const path = join(dir, 'corpus.jsonl');
      const log = new TrainingLogger(path);
      log.log({ conversationId: 'c', brain: 'frontier', model: 'm', input: 'q', output: unansweredMessage('refusal', 2), tools: [] }, 1);
      expect(existsSync(path)).toBe(false);
      log.log({ conversationId: 'c', brain: 'frontier', model: 'm', input: 'q', output: 'a real answer', tools: [] }, 2);
      expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(1);
      expect(log.stats().teacher).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('answerWithFallback (/generate)', () => {
  const chain = [tier('anthropic:opus', 'opus'), tier('anthropic:sonnet', 'sonnet'), tier('openai:gpt-5', 'gpt')];

  it('a refusal moves on to the next tier, and says why in the fallback log', async () => {
    const onFallback = vi.fn();
    const ask = vi.fn(async (b: BrainTier<string>) => (b.persona === 'opus' ? reply('', 'refusal') : reply(`from ${b.persona}`)));
    const won = await answerWithFallback(chain, ask, { onFallback });
    expect(won.result.text).toBe('from sonnet');
    expect(won.brain.label).toBe('anthropic:sonnet');
    expect(won.unanswered).toBeUndefined();
    expect(onFallback).toHaveBeenCalledOnce();
    expect(String(onFallback.mock.calls[0]![2])).toMatch(/declined to answer: refusal/);
  });

  it('an empty reply with no tool call moves on too; a tool-only reply does not', async () => {
    const empty = await answerWithFallback(chain, async (b) => (b.persona === 'opus' ? reply('') : reply('ok')));
    expect(empty.brain.label).toBe('anthropic:sonnet');
    const toolOnly = await answerWithFallback(chain, async () => reply('', 'complete', true));
    expect(toolOnly.brain.label).toBe('anthropic:opus');
    expect(toolOnly.result.text).toBe('');
  });

  it('reaches the cross-vendor last resort when every Claude tier refuses', async () => {
    const won = await answerWithFallback(chain, async (b) => (b.persona === 'gpt' ? reply('answered') : reply('', 'refusal')));
    expect(won.brain.label).toBe('openai:gpt-5');
    expect(won.result.text).toBe('answered');
  });

  it('when every tier refuses: the honest message, not an empty answer and not an error', async () => {
    const ask = vi.fn(async () => reply('', 'refusal'));
    const won = await answerWithFallback(chain, ask);
    expect(ask).toHaveBeenCalledTimes(3);
    expect(won.unanswered).toBe('refusal');
    expect(won.result.text).toBe(unansweredMessage('refusal', 3));
    expect(won.result.reason).toBe('refusal'); // the truth about the last attempt is kept
    expect(won.result.usage).toBe(usage);
    expect(won.brain.label).toBe('openai:gpt-5');
  });

  it('with the default single brain, one refusal gets the honest message', async () => {
    const won = await answerWithFallback([chain[0]!], async () => reply('Here is how', 'refusal'));
    expect(won.result.text).toBe(unansweredMessage('refusal', 1));
  });

  it('every tier empty: the empty-answer message', async () => {
    const won = await answerWithFallback(chain.slice(0, 2), async () => reply(''));
    expect(won.unanswered).toBe('empty');
    expect(won.result.text).toBe(unansweredMessage('empty', 2));
  });

  it('a provider error on the last tier is still thrown (the caller goes local, as before)', async () => {
    const outage = new FlintError(makeAiError('provider_unavailable', '529 overloaded'));
    await expect(
      answerWithFallback(chain.slice(0, 2), async (b) => {
        if (b.persona === 'opus') return reply('', 'refusal');
        throw outage;
      }),
    ).rejects.toBe(outage);
  });

  it('does not spend another model once the caller aborted', async () => {
    const ac = new AbortController();
    const ask = vi.fn(async () => {
      ac.abort();
      return reply('', 'refusal');
    });
    const won = await answerWithFallback(chain, ask, { signal: ac.signal });
    expect(ask).toHaveBeenCalledOnce();
    expect(won.unanswered).toBe('refusal');
  });
});

describe('guardAnswer (/chat)', () => {
  const done = (reason: 'complete' | 'refusal' = 'complete'): StreamEvent => ({ type: 'done', reason, usage });

  it('on a tier with a fallback, a silent refusal throws before its done is shown', async () => {
    const seen: StreamEvent[] = [];
    const run = async () => {
      for await (const ev of guardAnswer(play([done('refusal')]), { recoverable: true, tried: 1 })) seen.push(ev);
    };
    await expect(run()).rejects.toBeInstanceOf(NoAnswer);
    expect(seen).toEqual([]);
  });

  it('on the last tier, the honest message goes out ahead of the done', async () => {
    const out = await collect(guardAnswer(play([done('refusal')]), { recoverable: false, tried: 2 }));
    expect(out).toEqual([{ type: 'text', delta: unansweredMessage('refusal', 2) }, done('refusal')]);
  });

  it('an empty complete reply is caught the same way', async () => {
    await expect(collect(guardAnswer(play([done()]), { recoverable: true, tried: 1 }))).rejects.toBeInstanceOf(NoAnswer);
    const last = await collect(guardAnswer(play([{ type: 'text', delta: '  ' }, done()]), { recoverable: false, tried: 1 }));
    expect(last.map((e) => (e.type === 'text' ? e.delta : e.type))).toEqual(['  ', unansweredMessage('empty', 1), 'done']);
  });

  it('whitespace already sent cannot be retried: the honest message follows it instead', async () => {
    const out = await collect(guardAnswer(play([{ type: 'text', delta: '\n' }, done('refusal')]), { recoverable: true, tried: 1 }));
    expect(out.map((e) => e.type)).toEqual(['text', 'text', 'done']);
  });

  it('passes a streamed refusal, a tool-only turn and a normal answer through untouched', async () => {
    const cases: StreamEvent[][] = [
      [{ type: 'text', delta: 'Partly answered' }, done('refusal')],
      [{ type: 'tool_call', call: { id: 'c', toolName: 'x.y', args: {} } }, done()],
      [{ type: 'text', delta: 'Paris.' }, done()],
      [{ type: 'error', error: makeAiError('rate_limit', '429') }],
    ];
    for (const events of cases) {
      expect(await collect(guardAnswer(play(events), { recoverable: true, tried: 1 }))).toEqual(events);
    }
  });
});

/**
 * The /chat frontier path end to end, as index.ts wires it (runWithFallback +
 * guardAnswer around each tier's Flint.chat), against real Flint instances
 * sharing one memory store. What matters: the retried turn leaves no trace.
 */
describe('a /chat turn that falls back', () => {
  function stubProvider(script: StreamEvent[]): ProviderAdapter {
    return {
      name: 'stub',
      getCapabilities: () => ({ toolCalling: 'native', structuredOutput: 'native', streaming: 'full', maxContextTokens: 100_000, maxOutputTokens: 1_000 }),
      estimateTokens: () => 1,
      generate: () => Promise.reject(new Error('stream only')),
      async *stream() {
        for (const e of script) yield e;
      },
    };
  }

  async function chatLikeServer(chain: BrainTier<Flint>[], conversationId: string, message: string) {
    const written: StreamEvent[] = [];
    let answer = '';
    const won = await runWithFallback(chain, async (b) => {
      try {
        const events = b.persona.chat({ conversationId, message });
        for await (const ev of guardAnswer(events, { recoverable: b !== chain[chain.length - 1], tried: chain.indexOf(b) + 1 })) {
          if (ev.type === 'text') answer += ev.delta;
          written.push(ev);
        }
      } catch (err) {
        if (answer.length > 0) throw new NoFallback(err);
        throw err;
      }
    });
    return { written, answer, won };
  }

  it('an empty first tier leaves no half-turn in memory; the second tier answers once', async () => {
    const memory = new InMemoryStore();
    const first = new Flint({ provider: stubProvider([{ type: 'done', reason: 'complete', usage }]), defaultModel: 'a', memory });
    const second = new Flint({ provider: stubProvider([{ type: 'text', delta: 'hi there' }, { type: 'done', reason: 'complete', usage }]), defaultModel: 'b', memory });

    const { written, answer, won } = await chatLikeServer([tier('a', first), tier('b', second)], 'c', 'hello');

    expect(won.brain.label).toBe('b');
    expect(answer).toBe('hi there');
    expect(written.filter((e) => e.type === 'done')).toHaveLength(1); // tier a's done never reached the client
    expect((await memory.getMessages('c')).map((m) => [m.role, m.content])).toEqual([
      ['user', 'hello'],
      ['assistant', 'hi there'],
    ]);
    expect((await memory.getTurns('c')).map((t) => t.status)).toEqual(['failed', 'complete']);
  });

  it('when every tier refuses, the user reads the honest message and memory stays clean', async () => {
    const memory = new InMemoryStore();
    const refuses = () => new Flint({ provider: stubProvider([{ type: 'done', reason: 'refusal', usage }]), defaultModel: 'r', memory });

    const { written, answer } = await chatLikeServer([tier('a', refuses()), tier('b', refuses())], 'c', 'q');

    expect(answer).toBe(unansweredMessage('refusal', 2));
    expect(written.at(-1)).toMatchObject({ type: 'done', reason: 'refusal' });
    expect(await memory.getMessages('c')).toEqual([]);
  });
});
