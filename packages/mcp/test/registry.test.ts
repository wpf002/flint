import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Flint } from '@flint/core';
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
});
