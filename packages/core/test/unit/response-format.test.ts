/**
 * responseFormat (Machine plan P1 seam release): one constrained-JSON contract
 * across providers. Ollama gets `format` (and a forced tool rides on it and
 * comes back as a tool_call); OpenAI gets response_format; Anthropic gets a
 * forced tool whose input comes back as the text. Without the field, requests
 * are byte-identical to before.
 */
import { describe, it, expect } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { OllamaProvider } from '../../src/provider/ollama/index.js';
import { AnthropicProvider } from '../../src/provider/anthropic/index.js';
import { OpenAiProvider } from '../../src/provider/openai/index.js';
import { PerplexityProvider } from '../../src/provider/perplexity/index.js';
import { responseFormatAsTool, responseFormatName, toolResultAsText, toolStreamAsText } from '../../src/provider/response-format.js';
import { decodeAssistantTurn, encodeToolCallTurn } from '../../src/core/encoding.js';
import { isFlintError } from '../../src/types/error.js';
import type { GenerateArgs, ResponseFormat, StreamEvent, ToolDefinition } from '../../src/index.js';
import type { AnthropicBody } from './scripted.js';
import {
  generatedMessage,
  messageStart,
  toolUseBlockStart,
  inputJsonDelta,
  blockStop,
  messageDelta,
  messageStop,
} from '../contracts/harness.js';

const user = { id: 'u1', role: 'user' as const, content: 'triage this', timestamp: 0 };
const schema = { type: 'object', properties: { action: { type: 'string', enum: ['ignore', 'log', 'escalate'] } }, required: ['action'] };
const decideTool: ToolDefinition = { name: 'decide', description: 'Decide', inputSchema: schema, idempotent: true };
const rf = (name: string): ResponseFormat => ({ type: 'json_schema', name, schema });

async function collect(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

const textOf = (events: StreamEvent[]) =>
  events.filter((e): e is Extract<StreamEvent, { type: 'text' }> => e.type === 'text').map((e) => e.delta).join('');

/** An Ollama reply: just the content (done_reason `stop`), or the content with its done_reason. */
type OllamaReply = string | { content: string; done_reason: string };

function ollamaReplying(replies: OllamaReply[]) {
  const bodies: Array<Record<string, unknown>> = [];
  let i = 0;
  const impl = (async (_u: string, init: { body: string }) => {
    bodies.push(JSON.parse(init.body));
    const reply = replies[Math.min(i++, replies.length - 1)]!;
    const { content, done_reason } = typeof reply === 'string' ? { content: reply, done_reason: 'stop' } : reply;
    return new Response(JSON.stringify({ message: { role: 'assistant', content }, done: true, done_reason, prompt_eval_count: 5, eval_count: 3 }), { status: 200 });
  }) as unknown as typeof fetch;
  return { impl, bodies };
}

describe('Ollama format', () => {
  const make = (replies: OllamaReply[]) => {
    const f = ollamaReplying(replies);
    return { p: new OllamaProvider({ fetch: f.impl }), bodies: f.bodies };
  };

  it('responseFormat sends `format` with the schema, no tools, and the JSON is the text', async () => {
    const { p, bodies } = make(['{"action":"log"}']);
    const r = await p.generate({ model: 'm', messages: [user], tools: [decideTool], responseFormat: rf('triage') });
    expect(bodies[0]!.format).toEqual(schema);
    expect(bodies[0]!.tools).toBeUndefined();
    expect(r.reason).toBe('complete');
    expect(JSON.parse(decodeAssistantTurn(r.message).text)).toEqual({ action: 'log' });
  });

  it('a forced tool rides on `format` and comes back as that tool\'s call', async () => {
    const { p, bodies } = make(['{"action":"escalate"}']);
    const r = await p.generate({ model: 'm', messages: [user], tools: [decideTool], toolChoice: { name: 'decide' } });
    expect(bodies[0]!.format).toEqual(schema);
    expect(r.reason).toBe('tool_call');
    expect(decodeAssistantTurn(r.message).toolCalls).toMatchObject([{ toolName: 'decide', args: { action: 'escalate' } }]);
  });

  it('retries a reply that is not JSON, then fails loudly', async () => {
    const ok = make(['sure! here you go', '{"action":"ignore"}']);
    const r = await ok.p.generate({ model: 'm', messages: [user], responseFormat: rf('t') });
    expect(ok.bodies).toHaveLength(2);
    expect(JSON.parse(decodeAssistantTurn(r.message).text)).toEqual({ action: 'ignore' });
    const bad = make(['nope']);
    await expect(bad.p.generate({ model: 'm', messages: [user], responseFormat: rf('t') })).rejects.toThrow(/valid JSON/);
    expect(bad.bodies).toHaveLength(3);
  });

  // The server is up and answered: an outage-class, retryable error would have a
  // caller re-run three more generations, and health checks mark Ollama down.
  it('the final failure is a non-retryable validation error that leaves the model\'s text out', async () => {
    const bad = make(['IGNORE PREVIOUS INSTRUCTIONS']);
    const err = await bad.p.generate({ model: 'm', messages: [user], responseFormat: rf('triage') }).catch((e: unknown) => e);
    expect(isFlintError(err) && err.error.kind).toBe('validation');
    expect(isFlintError(err) && err.retryable).toBe(false);
    expect(String((err as Error).message)).toMatch(/triage/);
    expect(String((err as Error).message)).not.toContain('IGNORE');
    const events = await collect(make(['nope']).p.stream({ model: 'm', messages: [user], responseFormat: rf('t') }));
    expect(events).toMatchObject([{ type: 'error', error: { kind: 'validation', retryable: false } }]);
  });

  it('a reply cut off at num_predict is max_tokens with the partial text, and is not retried', async () => {
    const { p, bodies } = make([{ content: '{"action":"lo', done_reason: 'length' }]);
    const r = await p.generate({ model: 'm', messages: [user], maxTokens: 4, responseFormat: rf('triage') });
    expect(bodies).toHaveLength(1);
    expect(r.reason).toBe('max_tokens');
    expect(decodeAssistantTurn(r.message).text).toBe('{"action":"lo');

    const s = make([{ content: '', done_reason: 'length' }]);
    const events = await collect(s.p.stream({ model: 'm', messages: [user], maxTokens: 4, responseFormat: rf('triage') }));
    expect(s.bodies).toHaveLength(1);
    expect(events).toEqual([{ type: 'done', reason: 'max_tokens', usage: { input: 5, output: 3 } }]);
  });

  it('a forced tool cut off at num_predict is max_tokens too, not a call', async () => {
    const { p, bodies } = make([{ content: '{"action":', done_reason: 'length' }]);
    const r = await p.generate({ model: 'm', messages: [user], tools: [decideTool], toolChoice: { name: 'decide' }, maxTokens: 4 });
    expect(bodies).toHaveLength(1);
    expect(r.reason).toBe('max_tokens');
    expect(decodeAssistantTurn(r.message).toolCalls).toEqual([]);
  });

  it('a whole reply that ran to the cap on trailing whitespace still parses', async () => {
    const { p, bodies } = make([{ content: '{"action":"log"}\n\n\n\n\n\n', done_reason: 'length' }]);
    const r = await p.generate({ model: 'm', messages: [user], maxTokens: 12, responseFormat: rf('triage') });
    expect(bodies).toHaveLength(1);
    expect(r.reason).toBe('complete');
    expect(JSON.parse(decodeAssistantTurn(r.message).text)).toEqual({ action: 'log' });
  });

  it('streams a constrained reply as one value', async () => {
    const { p } = make(['{"action":"log"}']);
    const events = await collect(p.stream({ model: 'm', messages: [user], tools: [decideTool], toolChoice: { name: 'decide' } }));
    expect(events.map((e) => e.type)).toEqual(['tool_call', 'done']);
  });

  it('without responseFormat or a forced tool, no `format` is sent', async () => {
    const { p, bodies } = make(['hello']);
    await p.generate({ model: 'm', messages: [user] });
    expect('format' in bodies[0]!).toBe(false);
  });
});

describe('the responseFormat name', () => {
  it('keeps a name every provider accepts as it is', () => {
    for (const name of ['triage', 'triage_v2', 'triage-v2', 'T1', 'a'.repeat(64)]) expect(responseFormatName(rf(name))).toBe(name);
  });

  // `__` is how the Anthropic and OpenAI adapters spell a `.` in a tool name, so
  // a forced tool called `a__b` would come back as `a.b` and never match.
  it('sends anything else as `respond`', () => {
    for (const name of ['triage__v2', 'triage.v1', 'not ok!', '', 'a'.repeat(65)]) expect(responseFormatName(rf(name))).toBe('respond');
  });
});

describe('forced-tool responseFormat (Anthropic)', () => {
  const args: GenerateArgs = { model: 'm', messages: [user], responseFormat: rf('triage') };

  it('becomes one forced tool, and its input becomes the text', async () => {
    const f = responseFormatAsTool(args)!;
    expect(f.args.tools).toEqual([{ name: 'triage', description: expect.any(String), inputSchema: schema, idempotent: true }]);
    expect(f.args.toolChoice).toEqual({ name: 'triage' });
    expect('responseFormat' in f.args).toBe(false);
    const r = toolResultAsText({ message: encodeToolCallTurn('m1', '', [{ id: 't1', toolName: 'triage', args: { action: 'log' } }], 0), usage: { input: 1, output: 1 }, reason: 'tool_call' }, 'triage');
    expect(r.reason).toBe('complete');
    expect(JSON.parse(decodeAssistantTurn(r.message).text)).toEqual({ action: 'log' });
  });

  it('keeps a reason other than tool_call: a call cut off at max_tokens is not a finished answer', () => {
    for (const reason of ['max_tokens', 'refusal'] as const) {
      const r = toolResultAsText({ message: encodeToolCallTurn('m1', '', [{ id: 't1', toolName: 'triage', args: {} }], 0), usage: { input: 1, output: 1 }, reason }, 'triage');
      expect(r.reason).toBe(reason);
    }
  });

  it('streams the forced call as text', async () => {
    async function* inner(): AsyncIterable<StreamEvent> {
      yield { type: 'tool_call', call: { id: 't1', toolName: 'triage', args: { action: 'ignore' } } };
      yield { type: 'done', reason: 'tool_call', usage: { input: 1, output: 1 } };
    }
    const out = await collect(toolStreamAsText(inner(), 'triage'));
    expect(out).toEqual([{ type: 'text', delta: '{"action":"ignore"}' }, { type: 'done', reason: 'complete', usage: { input: 1, output: 1 } }]);
  });

  it('a bad name falls back to a safe one', () => {
    expect(responseFormatAsTool({ ...args, responseFormat: rf('not ok!') })!.tool).toBe('respond');
  });
});

/**
 * An Anthropic client that answers every request the way the API answers a
 * forced tool_choice: by calling exactly the tool it names. `json` overrides the
 * streamed input (a call cut off part way); `stop` is the stop_reason.
 */
function anthropicForcing(reply: { input: unknown; stop?: Anthropic.StopReason; json?: string }) {
  const bodies: AnthropicBody[] = [];
  const stop = reply.stop ?? 'tool_use';
  const forced = (body: AnthropicBody) => (body.tool_choice as { name: string }).name;
  const client = {
    messages: {
      async create(body: AnthropicBody) {
        bodies.push(JSON.parse(JSON.stringify(body)));
        return generatedMessage({ toolUses: [{ id: 'toolu_1', name: forced(body), input: reply.input }], stopReason: stop, inputTokens: 10, outputTokens: 5 });
      },
      stream(body: AnthropicBody) {
        bodies.push(JSON.parse(JSON.stringify(body)));
        const json = reply.json ?? JSON.stringify(reply.input);
        const half = Math.floor(json.length / 2);
        const events = [
          messageStart(10),
          toolUseBlockStart(0, 'toolu_1', forced(body)),
          inputJsonDelta(0, json.slice(0, half)),
          inputJsonDelta(0, json.slice(half)),
          blockStop(0),
          messageDelta(stop, 5),
          messageStop(),
        ];
        return (async function* () {
          for (const e of events) yield e;
        })();
      },
    },
  };
  return { p: new AnthropicProvider({ client: client as unknown as Anthropic }), bodies };
}

describe('AnthropicProvider with responseFormat', () => {
  const args: GenerateArgs = { model: 'claude-sonnet-4-6', messages: [user], responseFormat: rf('triage') };

  it('generate forces one tool and returns its input as the text', async () => {
    const { p, bodies } = anthropicForcing({ input: { action: 'log' } });
    const r = await p.generate(args);
    expect(bodies[0]!.tools).toEqual([{ name: 'triage', description: expect.any(String), input_schema: schema }]);
    expect(bodies[0]!.tool_choice).toEqual({ type: 'tool', name: 'triage' });
    expect(r.reason).toBe('complete');
    const turn = decodeAssistantTurn(r.message);
    expect(turn.toolCalls).toEqual([]);
    expect(JSON.parse(turn.text)).toEqual({ action: 'log' });
  });

  it('stream forces one tool and yields its input as text, then done complete', async () => {
    const { p, bodies } = anthropicForcing({ input: { action: 'escalate' } });
    const events = await collect(p.stream(args));
    expect(bodies[0]!.tool_choice).toEqual({ type: 'tool', name: 'triage' });
    expect(events.map((e) => e.type)).toEqual(['text', 'done']);
    expect(JSON.parse(textOf(events))).toEqual({ action: 'escalate' });
    expect(events.at(-1)).toMatchObject({ type: 'done', reason: 'complete' });
  });

  it('a call cut off at max_tokens reports max_tokens from generate and stream alike', async () => {
    const g = anthropicForcing({ input: {}, stop: 'max_tokens' });
    expect((await g.p.generate({ ...args, maxTokens: 5 })).reason).toBe('max_tokens');
    const s = anthropicForcing({ input: {}, json: '{"action":"lo', stop: 'max_tokens' });
    const events = await collect(s.p.stream({ ...args, maxTokens: 5 }));
    expect(events.at(-1)).toMatchObject({ type: 'done', reason: 'max_tokens' });
  });

  it('a refused call keeps refusal', async () => {
    const { p } = anthropicForcing({ input: {}, stop: 'refusal' });
    expect((await p.generate(args)).reason).toBe('refusal');
  });

  it('a name the tool-name mapping would rewrite is sent as `respond`, and the call still comes back as text', async () => {
    const dunder = { ...args, responseFormat: rf('triage__v2') };
    const g = anthropicForcing({ input: { action: 'log' } });
    const r = await g.p.generate(dunder);
    expect(g.bodies[0]!.tool_choice).toEqual({ type: 'tool', name: 'respond' });
    expect(r.reason).toBe('complete');
    expect(JSON.parse(decodeAssistantTurn(r.message).text)).toEqual({ action: 'log' });

    const s = anthropicForcing({ input: { action: 'log' } });
    const events = await collect(s.p.stream(dunder));
    expect(events.map((e) => e.type)).toEqual(['text', 'done']);
    expect(events.at(-1)).toMatchObject({ type: 'done', reason: 'complete' });
  });
});

/** A chat-completions endpoint that records each request and answers with JSON, or with SSE lines when streamed. */
function chatReplying(response: unknown, sse: unknown[] = []) {
  const bodies: Array<Record<string, unknown>> = [];
  const impl = (async (_u: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    bodies.push(body);
    if (body.stream) {
      const text = sse.map((l) => `data: ${JSON.stringify(l)}\n`).join('') + 'data: [DONE]\n';
      return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    return new Response(JSON.stringify(response), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { impl, bodies };
}

const jsonCompletion = {
  id: 'c1',
  choices: [{ message: { content: '{"action":"log"}' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 9, completion_tokens: 4 },
};
const jsonChunks = [
  { choices: [{ delta: { content: '{"action":' } }] },
  { choices: [{ delta: { content: '"log"}' } }] },
  { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 9, completion_tokens: 4 } },
];

describe('OpenAiProvider with responseFormat', () => {
  it('stream sends response_format and yields the JSON as text', async () => {
    const { impl, bodies } = chatReplying(undefined, jsonChunks);
    const p = new OpenAiProvider({ apiKey: 'k', fetch: impl });
    const events = await collect(p.stream({ model: 'gpt-5', messages: [user], responseFormat: rf('triage') }));
    expect(bodies[0]!.stream).toBe(true);
    expect(bodies[0]!.response_format).toEqual({ type: 'json_schema', json_schema: { name: 'triage', schema, strict: false } });
    expect(JSON.parse(textOf(events))).toEqual({ action: 'log' });
    expect(events.at(-1)).toEqual({ type: 'done', reason: 'complete', usage: { input: 9, output: 4 } });
  });

  it('a name OpenAI would reject with a 400 is sent as `respond`', async () => {
    const { impl, bodies } = chatReplying(jsonCompletion);
    const p = new OpenAiProvider({ apiKey: 'k', fetch: impl });
    await p.generate({ model: 'gpt-5', messages: [user], responseFormat: rf('triage.v1') });
    expect((bodies[0]!.response_format as { json_schema: { name: string } }).json_schema.name).toBe('respond');
  });
});

// The same GenerateArgs has to give JSON text everywhere, or failing over from one
// provider to another changes what the caller gets back.
describe('responseFormat replaces the caller\'s tools on every provider', () => {
  const args: GenerateArgs = { model: 'm', messages: [user], tools: [decideTool], toolChoice: 'required', responseFormat: rf('triage') };

  it('Ollama sends no tools', async () => {
    const f = ollamaReplying(['{"action":"log"}']);
    const r = await new OllamaProvider({ fetch: f.impl }).generate(args);
    expect(f.bodies[0]!.tools).toBeUndefined();
    expect(JSON.parse(decodeAssistantTurn(r.message).text)).toEqual({ action: 'log' });
  });

  it('OpenAI sends no tools and no tool_choice, generating or streaming', async () => {
    const { impl, bodies } = chatReplying(jsonCompletion, jsonChunks);
    const p = new OpenAiProvider({ apiKey: 'k', fetch: impl });
    const r = await p.generate(args);
    await collect(p.stream({ ...args, toolChoice: 'none' }));
    for (const body of bodies) {
      expect(body.tools).toBeUndefined();
      expect(body.tool_choice).toBeUndefined();
      expect(body.response_format).toBeDefined();
    }
    expect(JSON.parse(decodeAssistantTurn(r.message).text)).toEqual({ action: 'log' });
  });

  it('Anthropic sends only the forced tool', async () => {
    const { p, bodies } = anthropicForcing({ input: { action: 'log' } });
    const r = await p.generate(args);
    expect(bodies[0]!.tools!.map((t) => t.name)).toEqual(['triage']);
    expect(bodies[0]!.tool_choice).toEqual({ type: 'tool', name: 'triage' });
    expect(JSON.parse(decodeAssistantTurn(r.message).text)).toEqual({ action: 'log' });
  });

  it('OpenAI still sends the tools when there is no responseFormat', async () => {
    const { impl, bodies } = chatReplying(jsonCompletion);
    const { responseFormat: _rf, ...plain } = args;
    await new OpenAiProvider({ apiKey: 'k', fetch: impl }).generate(plain);
    expect((bodies[0]!.tools as unknown[]).length).toBe(1);
  });
});

describe('PerplexityProvider with responseFormat', () => {
  const sources = { search_results: [{ title: 'Met Office', url: 'https://example.test/a' }] };

  it('leaves the sources off a constrained reply, so the text still parses', async () => {
    const { impl, bodies } = chatReplying({ ...jsonCompletion, ...sources });
    const p = new PerplexityProvider({ apiKey: 'k', fetch: impl });
    const r = await p.generate({ model: 'sonar', messages: [user], responseFormat: rf('triage') });
    expect(bodies[0]!.response_format).toBeDefined();
    expect(r.message.content).toBe('{"action":"log"}');
  });

  it('streams a constrained reply with no sources suffix', async () => {
    const { impl } = chatReplying(undefined, [...jsonChunks.slice(0, -1), { ...jsonChunks.at(-1)!, ...sources }]);
    const p = new PerplexityProvider({ apiKey: 'k', fetch: impl });
    const events = await collect(p.stream({ model: 'sonar', messages: [user], responseFormat: rf('triage') }));
    expect(JSON.parse(textOf(events))).toEqual({ action: 'log' });
  });

  it('still appends the sources to an ordinary reply', async () => {
    const { impl } = chatReplying(undefined, [...jsonChunks.slice(0, -1), { ...jsonChunks.at(-1)!, ...sources }]);
    const p = new PerplexityProvider({ apiKey: 'k', fetch: impl });
    const events = await collect(p.stream({ model: 'sonar', messages: [user] }));
    expect(textOf(events)).toContain('Sources:');
  });
});
