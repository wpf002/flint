import { describe, it, expect } from 'vitest';
import { cassetteProvider, type OllamaChatCassette } from './ollama-harness.js';
import { decodeAssistantTurn } from '../../src/index.js';
import type { GenerateArgs, StreamEvent, ToolDefinition } from '../../src/index.js';

/*
 * The seam release's Ollama `format` cassette: responseFormat (and a forced tool,
 * which rides on the same `format`) through the real OllamaProvider, replayed
 * from whole /api/chat bodies. Like the Anthropic fixtures (see README), these
 * are written in the documented response shape rather than captured live; the
 * thinking model's `thinking` and the timing fields are in them so the adapter
 * meets everything a real reply carries, not just what it reads.
 */

const userMsg = { id: 'u1', role: 'user' as const, content: 'The checkout API returns 500 for every order.', timestamp: 0 };
const triage = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['ignore', 'log', 'escalate'] },
    reason: { type: 'string' },
  },
  required: ['action', 'reason'],
};
const decideTool: ToolDefinition = { name: 'decide', description: 'Decide what to do', inputSchema: triage, idempotent: true };

/** A thinking model answering under `format`: the JSON in `content`, its reasoning in `thinking`. */
const answered: OllamaChatCassette = {
  model: 'qwen3:8b',
  created_at: '2026-09-30T18:04:11.532917Z',
  message: {
    role: 'assistant',
    content: '{"action": "escalate", "reason": "Every order failing is a production outage."}',
    thinking: 'Every order fails, so this is an outage rather than noise. Escalate.',
  },
  done: true,
  done_reason: 'stop',
  total_duration: 2914527333,
  load_duration: 31262708,
  prompt_eval_count: 61,
  prompt_eval_duration: 104318208,
  eval_count: 92,
  eval_duration: 2777406917,
};

/** The same request with too small a num_predict: the reasoning spent most of it. */
const truncated: OllamaChatCassette = {
  ...answered,
  message: { role: 'assistant', content: '{"action": "esc', thinking: 'Every order fails, so this is an outage' },
  done_reason: 'length',
  eval_count: 24,
};

/** Whole JSON padded with whitespace up to num_predict, which a model under `format` can do. */
const padded: OllamaChatCassette = {
  ...answered,
  message: { role: 'assistant', content: `${answered.message.content}\n\n\n\n\n\n\n\n` },
  done_reason: 'length',
};

const args: GenerateArgs = {
  model: 'qwen3:8b',
  messages: [userMsg],
  responseFormat: { type: 'json_schema', name: 'triage', schema: triage },
};
const expected = { action: 'escalate', reason: 'Every order failing is a production outage.' };

describe('contract (ollama): responseFormat on `format`', () => {
  it('sends the schema as `format`, unstreamed and with no tools, and the JSON is the text', async () => {
    const { provider, requests } = cassetteProvider([answered]);
    const r = await provider.generate({ ...args, tools: [decideTool] });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ model: 'qwen3:8b', stream: false, format: triage });
    expect(requests[0]!.tools).toBeUndefined();
    expect(r.reason).toBe('complete');
    expect(r.usage).toEqual({ input: 61, output: 92 });
    const turn = decodeAssistantTurn(r.message);
    expect(JSON.parse(turn.text)).toEqual(expected);
    expect(turn.text).not.toContain('outage rather than noise');
  });

  it('streams the same reply as one text value, then exactly one done', async () => {
    const { provider } = cassetteProvider([answered]);
    const events: StreamEvent[] = [];
    for await (const ev of provider.stream(args)) events.push(ev);

    expect(events.map((e) => e.type)).toEqual(['text', 'done']);
    const text = events[0]?.type === 'text' ? events[0].delta : '';
    expect(JSON.parse(text)).toEqual(expected);
    expect(events[1]).toEqual({ type: 'done', reason: 'complete', usage: { input: 61, output: 92 } });
  });

  it('a forced tool comes back as that tool\'s call', async () => {
    const { provider, requests } = cassetteProvider([answered]);
    const r = await provider.generate({ model: 'qwen3:8b', messages: [userMsg], tools: [decideTool], toolChoice: { name: 'decide' } });

    expect(requests[0]!.format).toEqual(triage);
    expect(r.reason).toBe('tool_call');
    expect(decodeAssistantTurn(r.message).toolCalls).toMatchObject([{ toolName: 'decide', args: expected }]);
  });

  it('a reply cut off at num_predict is max_tokens after one request, not three', async () => {
    const { provider, requests } = cassetteProvider([truncated]);
    const r = await provider.generate({ ...args, maxTokens: 24 });

    expect(requests).toHaveLength(1);
    expect(requests[0]!.options).toEqual({ num_predict: 24 });
    expect(r.reason).toBe('max_tokens');
    expect(decodeAssistantTurn(r.message).text).toBe('{"action": "esc');
  });

  it('whole JSON padded to num_predict is still the answer', async () => {
    const { provider, requests } = cassetteProvider([padded]);
    const r = await provider.generate(args);

    expect(requests).toHaveLength(1);
    expect(r.reason).toBe('complete');
    expect(JSON.parse(decodeAssistantTurn(r.message).text)).toEqual(expected);
  });
});
