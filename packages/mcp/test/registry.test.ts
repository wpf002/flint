import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Flint, decodeToolResult } from '@flint/core';
import type { ProviderAdapter, GenerateArgs, StreamEvent } from '@flint/core';
import { McpRegistry, type RegistryOptions } from '../src/index.js';

/** Stand up an in-memory MCP server with one read-only and one destructive tool. */
async function setup(options: RegistryOptions = {}) {
  const executed: string[] = [];
  const server = new McpServer({ name: 'test', version: '1.0.0' });

  server.registerTool(
    'echo',
    { description: 'Echo the input.', inputSchema: { text: z.string() }, annotations: { readOnlyHint: true } },
    async ({ text }) => ({ content: [{ type: 'text', text }] }),
  );

  server.registerTool(
    'delete_thing',
    { description: 'Delete a thing.', inputSchema: { id: z.string() }, annotations: { destructiveHint: true } },
    async ({ id }) => {
      executed.push(`delete:${id}`);
      return { content: [{ type: 'text', text: `deleted ${id}` }] };
    },
  );

  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const registry = await McpRegistry.connect([{ name: 'test', transport: clientT }], options);

  return {
    registry,
    executed,
    async close() {
      await registry.close();
      await server.close();
    },
  };
}

function tool(registry: McpRegistry, name: string) {
  const t = registry.tools().find((x) => x.definition.name === name);
  if (!t) throw new Error(`tool ${name} not found`);
  return t;
}

describe('McpRegistry', () => {
  it('maps MCP tools to namespaced Flint tools with correct idempotency', async () => {
    const { registry, close } = await setup();
    const names = registry.tools().map((t) => t.definition.name).sort();
    expect(names).toEqual(['test.delete_thing', 'test.echo']);
    expect(tool(registry, 'test.echo').definition.idempotent).toBe(true); // readOnly ⇒ idempotent
    expect(tool(registry, 'test.delete_thing').definition.idempotent).toBe(false);
    await close();
  });

  it('runs a read-only (safe) tool without approval', async () => {
    const { registry, close } = await setup();
    const res = await tool(registry, 'test.echo').handler({
      id: '1',
      toolName: 'test.echo',
      args: { text: 'hello' },
    });
    expect(res).toBe('hello');
    await close();
  });

  it('DENIES a guarded tool by default when no approver is set (fail-safe)', async () => {
    const { registry, executed, close } = await setup();
    const res = await tool(registry, 'test.delete_thing').handler({
      id: '1',
      toolName: 'test.delete_thing',
      args: { id: 'x' },
    });
    expect(res).toMatchObject({ approved: false });
    expect(executed).toHaveLength(0); // side effect never happened
    await close();
  });

  it('runs a guarded tool when the approver approves', async () => {
    const { registry, executed, close } = await setup({ approver: () => true });
    const res = await tool(registry, 'test.delete_thing').handler({
      id: '1',
      toolName: 'test.delete_thing',
      args: { id: 'x' },
    });
    expect(res).toContain('deleted x');
    expect(executed).toEqual(['delete:x']);
    await close();
  });

  it('does NOT run a guarded tool when the approver denies', async () => {
    const { registry, executed, close } = await setup({ approver: () => false });
    await tool(registry, 'test.delete_thing').handler({ id: '1', toolName: 'test.delete_thing', args: { id: 'x' } });
    expect(executed).toHaveLength(0);
    await close();
  });

  it('autoApprove "all" skips the gate', async () => {
    const { registry, executed, close } = await setup({ autoApprove: 'all' });
    await tool(registry, 'test.delete_thing').handler({ id: '1', toolName: 'test.delete_thing', args: { id: 'y' } });
    expect(executed).toEqual(['delete:y']);
    await close();
  });
});

/** A provider that calls `test.echo` once, then answers with the tool result. */
function echoingProvider(): ProviderAdapter {
  return {
    name: 'mock',
    getCapabilities: () => ({
      toolCalling: 'native',
      structuredOutput: 'native',
      streaming: 'full',
      maxContextTokens: 100_000,
      maxOutputTokens: 4096,
    }),
    estimateTokens: (m) => m.reduce((n, x) => n + x.content.length, 0),
    async generate() {
      throw new Error('unused');
    },
    async *stream(args: GenerateArgs): AsyncIterable<StreamEvent> {
      const ranTool = args.messages.some((m) => m.role === 'tool_result');
      if (!ranTool) {
        yield {
          type: 'tool_call',
          call: { id: 'c1', toolName: 'test.echo', args: { text: 'mcp works' } },
        };
        yield { type: 'done', reason: 'tool_call', usage: { input: 1, output: 1 } };
      } else {
        const result = [...args.messages].reverse().find((m) => m.role === 'tool_result');
        yield { type: 'text', delta: `Tool said: ${result?.content ?? ''}` };
        yield { type: 'done', reason: 'complete', usage: { input: 1, output: 1 } };
      }
    },
  };
}

describe('MCP tools through the Flint tool loop', () => {
  it('executes an MCP tool end to end', async () => {
    const { registry, close } = await setup();
    const flint = new Flint({ provider: echoingProvider(), defaultModel: 'm' });

    const { text, messages } = await flint.generate({
      prompt: 'echo something',
      tools: registry.tools(),
    });

    expect(text).toContain('mcp works'); // the MCP server's echo result reached the model
    // The loop recorded a tool result in the produced messages.
    expect(messages.some((m) => m.role === 'tool_result')).toBe(true);
    await close();
  });

  it('an MCP error result reaches the loop as a failed tool call, not ok', async () => {
    const server = new McpServer({ name: 'test', version: '1.0.0' });
    server.registerTool(
      'echo',
      { description: 'Always fails.', inputSchema: { text: z.string() }, annotations: { readOnlyHint: true } },
      async () => ({ isError: true, content: [{ type: 'text', text: 'invalid_grant: token expired' }] }),
    );
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    const registry = await McpRegistry.connect([{ name: 'test', transport: clientT }]);

    // The shape @flint/mcp hands the loop for an MCP isError result.
    expect(await tool(registry, 'test.echo').handler({ id: '0', toolName: 'test.echo', args: { text: 'x' } })).toEqual({
      isError: true,
      content: 'invalid_grant: token expired',
    });

    const outcomes: boolean[] = [];
    const flint = new Flint({
      provider: echoingProvider(),
      defaultModel: 'm',
      observer: { onToolResult: (e) => outcomes.push(e.isError) },
    });
    const { messages } = await flint.generate({ prompt: 'echo something', tools: registry.tools() });

    expect(outcomes).toEqual([true]);
    const result = decodeToolResult(messages.find((m) => m.role === 'tool_result')!);
    expect(result.isError).toBe(true);
    await registry.close();
    await server.close();
  });
});

// The seam (Machine plan P1): a gate sees EVERY call, read-only ones included,
// and every result; with no gate, nothing changes (the tests above).
describe('McpRegistry gate', () => {
  it('is asked for read-only tools too, with the annotations and args, and sees the result', async () => {
    const seen: Array<{ fullName: string; readOnly: boolean | undefined; args: unknown }> = [];
    const results: unknown[] = [];
    const { registry, close } = await setup({
      gate: {
        check: (req) => (seen.push({ fullName: req.fullName, readOnly: req.annotations.readOnlyHint, args: req.args }), { allow: true }),
        onResult: (_req, r) => results.push(r),
      },
    });
    await tool(registry, 'test.echo').handler({ id: '1', toolName: 'test.echo', args: { text: 'hi' } });
    expect(seen).toEqual([{ fullName: 'test.echo', readOnly: true, args: { text: 'hi' } }]);
    expect(results).toHaveLength(1);
    await close();
  });

  it('a denial stops the call (read-only or not) and the model gets the message', async () => {
    const { registry, executed, close } = await setup({
      gate: { check: (req) => ({ allow: false, message: `no: ${req.tool}` }) },
      // The gate replaces approver and autoApprove; this must not let anything through.
      autoApprove: 'all',
      approver: () => true,
    });
    const r = await tool(registry, 'test.delete_thing').handler({ id: '1', toolName: 'test.delete_thing', args: { id: 'x' } });
    expect(r).toEqual({ approved: false, message: 'no: delete_thing' });
    expect(executed).toEqual([]);
    expect(await tool(registry, 'test.echo').handler({ id: '2', toolName: 'test.echo', args: { text: 'hi' } })).toEqual({ approved: false, message: 'no: echo' });
    await close();
  });

  it('sends the metadata the gate sets as the request\'s _meta (where the model cannot reach), and shows the gate a failure too', async () => {
    const results: unknown[] = [];
    const metas: unknown[] = [];
    const server = new McpServer({ name: 'm', version: '1.0.0' });
    server.registerTool('peek', { description: 'p', inputSchema: { x: z.string() } }, async (_a, extra) => (metas.push(extra._meta), { content: [{ type: 'text', text: 'ok' }] }));
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const reg = await McpRegistry.connect([{ name: 'm', transport: ct }], { gate: { check: () => ({ allow: true, meta: { 'flint/tainted': true } }) } });
    await tool(reg, 'm.peek').handler({ id: '0', toolName: 'm.peek', args: { x: 'a', _meta: { 'flint/tainted': false } } });
    expect(metas[0]).toMatchObject({ 'flint/tainted': true });
    await reg.close();
    await server.close();
    const { registry, executed, close } = await setup({ gate: { check: () => ({ allow: true }), onResult: (_r, x) => results.push(x) } });
    await tool(registry, 'test.delete_thing').handler({ id: '1', toolName: 'test.delete_thing', args: { id: 'from-model' } });
    expect(executed).toEqual(['delete:from-model']);
    // A call that fails in the transport: its error text reaches the model, so the gate sees it.
    const echo = tool(registry, 'test.echo');
    await close();
    await expect(echo.handler({ id: '2', toolName: 'test.echo', args: { text: 'x' } })).rejects.toThrow();
    expect(results.at(-1)).toMatchObject({ isError: true });
  });

  it('a gate that throws denies (fail closed)', async () => {
    const { registry, executed, close } = await setup({ gate: { check: () => { throw new Error('boom'); } } });
    const r = (await tool(registry, 'test.delete_thing').handler({ id: '1', toolName: 'test.delete_thing', args: { id: 'x' } })) as { approved: boolean };
    expect(r.approved).toBe(false);
    expect(executed).toEqual([]);
    await close();
  });
});
