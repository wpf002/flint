/**
 * responseFormat (Machine plan P1 seam release): one constrained-JSON contract
 * across providers. Ollama gets `format` (and a forced tool rides on it and
 * comes back as a tool_call); OpenAI gets response_format; Anthropic gets a
 * forced tool whose input comes back as the text. Without the field, requests
 * are byte-identical to before.
 */
import { describe, it, expect } from 'vitest';
import { OllamaProvider } from '../../src/provider/ollama/index.js';
import { responseFormatAsTool, toolResultAsText, toolStreamAsText } from '../../src/provider/response-format.js';
import { decodeAssistantTurn, encodeToolCallTurn } from '../../src/core/encoding.js';
import type { GenerateArgs, StreamEvent, ToolDefinition } from '../../src/index.js';

const user = { id: 'u1', role: 'user' as const, content: 'triage this', timestamp: 0 };
const schema = { type: 'object', properties: { action: { type: 'string', enum: ['ignore', 'log', 'escalate'] } }, required: ['action'] };
const decideTool: ToolDefinition = { name: 'decide', description: 'Decide', inputSchema: schema, idempotent: true };

function ollamaReplying(contents: string[]) {
  const bodies: Array<Record<string, unknown>> = [];
  let i = 0;
  const impl = (async (_u: string, init: { body: string }) => {
    bodies.push(JSON.parse(init.body));
    const content = contents[Math.min(i++, contents.length - 1)]!;
    return new Response(JSON.stringify({ message: { role: 'assistant', content }, done: true, done_reason: 'stop', prompt_eval_count: 5, eval_count: 3 }), { status: 200 });
  }) as unknown as typeof fetch;
  return { impl, bodies };
}

describe('Ollama format', () => {
  const make = (contents: string[]) => {
    const f = ollamaReplying(contents);
    return { p: new OllamaProvider({ fetch: f.impl }), bodies: f.bodies };
  };

  it('responseFormat sends `format` with the schema, no tools, and the JSON is the text', async () => {
    const { p, bodies } = make(['{"action":"log"}']);
    const r = await p.generate({ model: 'm', messages: [user], tools: [decideTool], responseFormat: { type: 'json_schema', name: 'triage', schema } });
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
    const r = await ok.p.generate({ model: 'm', messages: [user], responseFormat: { type: 'json_schema', name: 't', schema } });
    expect(ok.bodies).toHaveLength(2);
    expect(JSON.parse(decodeAssistantTurn(r.message).text)).toEqual({ action: 'ignore' });
    const bad = make(['nope']);
    await expect(bad.p.generate({ model: 'm', messages: [user], responseFormat: { type: 'json_schema', name: 't', schema } })).rejects.toThrow(/valid JSON/);
    expect(bad.bodies).toHaveLength(3);
  });

  it('streams a constrained reply as one value', async () => {
    const { p } = make(['{"action":"log"}']);
    const events: StreamEvent[] = [];
    for await (const e of p.stream({ model: 'm', messages: [user], tools: [decideTool], toolChoice: { name: 'decide' } })) events.push(e);
    expect(events.map((e) => e.type)).toEqual(['tool_call', 'done']);
  });

  it('without responseFormat or a forced tool, no `format` is sent', async () => {
    const { p, bodies } = make(['hello']);
    await p.generate({ model: 'm', messages: [user] });
    expect('format' in bodies[0]!).toBe(false);
  });
});

describe('forced-tool responseFormat (Anthropic)', () => {
  const args: GenerateArgs = { model: 'm', messages: [user], responseFormat: { type: 'json_schema', name: 'triage', schema } };

  it('becomes one forced tool, and its input becomes the text', async () => {
    const f = responseFormatAsTool(args)!;
    expect(f.args.tools).toEqual([{ name: 'triage', description: expect.any(String), inputSchema: schema, idempotent: true }]);
    expect(f.args.toolChoice).toEqual({ name: 'triage' });
    expect('responseFormat' in f.args).toBe(false);
    const r = toolResultAsText({ message: encodeToolCallTurn('m1', '', [{ id: 't1', toolName: 'triage', args: { action: 'log' } }], 0), usage: { input: 1, output: 1 }, reason: 'tool_call' }, 'triage');
    expect(r.reason).toBe('complete');
    expect(JSON.parse(decodeAssistantTurn(r.message).text)).toEqual({ action: 'log' });
  });

  it('streams the forced call as text', async () => {
    async function* inner(): AsyncIterable<StreamEvent> {
      yield { type: 'tool_call', call: { id: 't1', toolName: 'triage', args: { action: 'ignore' } } };
      yield { type: 'done', reason: 'tool_call', usage: { input: 1, output: 1 } };
    }
    const out: StreamEvent[] = [];
    for await (const e of toolStreamAsText(inner(), 'triage')) out.push(e);
    expect(out).toEqual([{ type: 'text', delta: '{"action":"ignore"}' }, { type: 'done', reason: 'complete', usage: { input: 1, output: 1 } }]);
  });

  it('a bad name falls back to a safe one', () => {
    expect(responseFormatAsTool({ ...args, responseFormat: { type: 'json_schema', name: 'not ok!', schema } })!.tool).toBe('respond');
  });
});
