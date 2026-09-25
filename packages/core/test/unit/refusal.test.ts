import { describe, it, expect } from 'vitest';
import { Flint, InMemoryStore, StreamDoneReason, type StreamEvent } from '../../src/index.js';
import { mapStopReason, mapToolChoice } from '../../src/provider/anthropic/mapping.js';
import { mapFinishReason } from '../../src/provider/openai/mapping.js';
import { OpenAiProvider } from '../../src/provider/openai/index.js';
import type { Message } from '../../src/types/message.js';
import { answer, scriptedAnthropic } from './scripted.js';

/**
 * Parity run 20260924-tiered: 11 of 300 prompts came back as silent empty
 * answers because Anthropic's `stop_reason: "refusal"` was mapped to `complete`
 * — nothing downstream could tell a refusal from a finished answer.
 */
describe('refusal is its own done reason', () => {
  it('is part of the canonical enum', () => {
    expect(StreamDoneReason.options).toContain('refusal');
  });

  it("maps Anthropic's refusal stop, and nothing else, to refusal", () => {
    expect(mapStopReason('refusal')).toBe('refusal');
    expect(mapStopReason('end_turn')).toBe('complete');
    expect(mapStopReason('pause_turn')).toBe('complete');
    expect(mapStopReason('tool_use')).toBe('tool_call');
    expect(mapStopReason('max_tokens')).toBe('max_tokens');
    expect(mapStopReason(null)).toBe('complete');
  });

  it("maps OpenAI's content_filter finish to refusal", () => {
    expect(mapFinishReason('content_filter')).toBe('refusal');
    expect(mapFinishReason('stop')).toBe('complete');
    expect(mapFinishReason('length')).toBe('max_tokens');
    expect(mapFinishReason('tool_calls')).toBe('tool_call');
  });

  it('maps the new none tool choice for Anthropic', () => {
    expect(mapToolChoice('none')).toEqual({ type: 'none' });
    expect(mapToolChoice('required')).toEqual({ type: 'any' });
    expect(mapToolChoice(undefined)).toBeUndefined();
  });
});

describe('an Anthropic refusal through Flint', () => {
  it('generate reports refusal instead of an empty complete answer', async () => {
    const { provider } = scriptedAnthropic([answer('', 'refusal')]);
    const out = await new Flint({ provider, defaultModel: 'claude-sonnet-4-6' }).generate({ prompt: 'q' });
    expect(out.reason).toBe('refusal');
    expect(out.text).toBe('');
  });

  it('chat yields done(refusal) and keeps the refused turn out of memory', async () => {
    const memory = new InMemoryStore();
    const { provider } = scriptedAnthropic([answer('', 'refusal'), answer('second answer')]);
    const flint = new Flint({ provider, defaultModel: 'claude-sonnet-4-6', memory });

    const events: StreamEvent[] = [];
    for await (const ev of flint.chat({ conversationId: 'c', message: 'refused question' })) events.push(ev);
    expect(events.at(-1)).toMatchObject({ type: 'done', reason: 'refusal' });
    expect(await memory.getMessages('c')).toEqual([]);
    const turns = await memory.getTurns('c');
    expect(turns.map((t) => t.status)).toEqual(['failed']);
    expect(turns[0]!.error?.message).toMatch(/refusal/);

    // The next turn commits normally, and history holds only that exchange.
    for await (const _ev of flint.chat({ conversationId: 'c', message: 'next question' })) void _ev;
    const history = await memory.getMessages('c');
    expect(history.map((m) => [m.role, m.content])).toEqual([
      ['user', 'next question'],
      ['assistant', 'second answer'],
    ]);
  });

  it('a normal answer still commits (the refusal rule is narrow)', async () => {
    const memory = new InMemoryStore();
    const { provider } = scriptedAnthropic([answer('hello')]);
    const flint = new Flint({ provider, defaultModel: 'claude-sonnet-4-6', memory });
    for await (const _ev of flint.chat({ conversationId: 'c', message: 'hi' })) void _ev;
    expect((await memory.getMessages('c')).map((m) => m.content)).toEqual(['hi', 'hello']);
  });
});

describe('an OpenAI refusal', () => {
  const user: Message = { id: 'm1', role: 'user', content: 'q', timestamp: 0 };

  it('generate: a message.refusal is reported as refusal', async () => {
    const fetch = (async () =>
      new Response(
        JSON.stringify({
          id: 'x',
          choices: [{ message: { content: null, refusal: "I can't help with that." }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 3, completion_tokens: 2 },
        }),
        { status: 200 },
      )) as unknown as typeof globalThis.fetch;
    const r = await new OpenAiProvider({ apiKey: 'k', fetch }).generate({ model: 'gpt-5', messages: [user] });
    expect(r.reason).toBe('refusal');
    expect(r.message.content).toBe('');
  });

  it('stream: a refusal delta ends in done(refusal) without leaking the refusal text', async () => {
    const lines = [
      JSON.stringify({ choices: [{ delta: { refusal: "I can't" } }] }),
      JSON.stringify({ choices: [{ delta: { refusal: ' help with that.' }, finish_reason: 'stop' }] }),
    ];
    const body = lines.map((l) => `data: ${l}\n`).join('') + 'data: [DONE]\n';
    const fetch = (async () => new Response(body, { status: 200 })) as unknown as typeof globalThis.fetch;
    const events: StreamEvent[] = [];
    for await (const ev of new OpenAiProvider({ apiKey: 'k', fetch }).stream({ model: 'gpt-5', messages: [user] })) {
      events.push(ev);
    }
    expect(events.filter((e) => e.type === 'text')).toEqual([]);
    expect(events.at(-1)).toMatchObject({ type: 'done', reason: 'refusal' });
  });
});
