/**
 * Reference MCP server — the template for wrapping one of your apps as Flint
 * tools. Copy this, swap the fake data for real calls into your app, and point
 * Flint at it:
 *
 *   { name: 'demo', transport: 'stdio', command: 'tsx', args: ['demo-server.ts'] }
 *
 * Run standalone (it speaks MCP over stdio, so it just waits for a client):
 *   tsx packages/mcp/examples/demo-server.ts
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

// Pretend app state.
const notes: string[] = [];

const server = new McpServer({ name: 'demo', version: '1.0.0' });

// SAFE — read-only. Flint runs it without asking.
server.registerTool(
  'list_notes',
  {
    description: 'List all saved notes.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => ({
    content: [{ type: 'text', text: notes.length ? notes.join('\n') : '(no notes)' }],
  }),
);

// GUARDED — has a side effect. Flint checkpoints it behind your approver.
server.registerTool(
  'add_note',
  {
    description: 'Append a note.',
    inputSchema: { text: z.string() },
    annotations: { destructiveHint: false, idempotentHint: false },
  },
  async ({ text }) => {
    notes.push(text);
    return { content: [{ type: 'text', text: `saved note #${notes.length}` }] };
  },
);

await server.connect(new StdioServerTransport());
