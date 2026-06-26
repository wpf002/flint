/**
 * Computer-use connector (Phase 6 — GATED, HIGH RISK). Lets Flint operate apps
 * that have no API by driving the screen like a human. The LAST layer for a
 * reason: error-prone, supervised, never destructive unattended.
 *
 * Safety posture (do not weaken):
 *  - screenshot + cursor_position are read-only (safe).
 *  - EVERY input action (move/click/type/key) is non-readonly ⇒ Flint's safety
 *    gate checkpoints it. With no approver it is DENIED. Never run unattended.
 *  - macOS prerequisites the USER must grant: Screen Recording (screenshots) and
 *    Accessibility (input injection). Without them these tools fail.
 *  - Autonomy needs a VISION model (the local text model can't see a screenshot);
 *    until then, actions are user-directed coordinates only.
 *
 *   tsx packages/mcp/connectors/computer-use-server.ts
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const exec = promisify(execFile);
const CLICLICK = process.env.CLICLICK_BIN ?? '/opt/homebrew/bin/cliclick';

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}
function err(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true };
}

const server = new McpServer({ name: 'computer', version: '1.0.0' });

// --- reads (safe) -----------------------------------------------------------
server.registerTool(
  'screenshot',
  {
    description: 'Capture the screen to a PNG. Returns the file path. (A vision model is needed to interpret it.)',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => {
    const path = join(tmpdir(), `flint-screen-${Date.now()}.png`);
    try {
      await exec('/usr/sbin/screencapture', ['-x', path]);
      return ok(`Screenshot saved to ${path}. (Grant Screen Recording permission if it is blank.)`);
    } catch (e) {
      return err(`screencapture failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
);

server.registerTool(
  'cursor_position',
  { description: 'Current mouse cursor position as "x,y".', inputSchema: {}, annotations: { readOnlyHint: true } },
  async () => {
    const { stdout } = await exec(CLICLICK, ['p']);
    return ok(stdout.trim());
  },
);

// --- actions (side-effecting ⇒ GATED) ---------------------------------------
const xy = { x: z.number(), y: z.number() };
const guarded = { readOnlyHint: false, destructiveHint: false, idempotentHint: false };

server.registerTool(
  'move',
  { description: 'Move the mouse to (x, y).', inputSchema: xy, annotations: guarded },
  async ({ x, y }) => {
    await exec(CLICLICK, [`m:${x},${y}`]);
    return ok(`moved to ${x},${y}`);
  },
);

server.registerTool(
  'click',
  { description: 'Click at (x, y).', inputSchema: xy, annotations: guarded },
  async ({ x, y }) => {
    await exec(CLICLICK, [`c:${x},${y}`]);
    return ok(`clicked ${x},${y}`);
  },
);

server.registerTool(
  'double_click',
  { description: 'Double-click at (x, y).', inputSchema: xy, annotations: guarded },
  async ({ x, y }) => {
    await exec(CLICLICK, [`dc:${x},${y}`]);
    return ok(`double-clicked ${x},${y}`);
  },
);

server.registerTool(
  'type_text',
  { description: 'Type text at the current focus.', inputSchema: { text: z.string() }, annotations: guarded },
  async ({ text }) => {
    await exec(CLICLICK, [`t:${text}`]);
    return ok(`typed ${text.length} chars`);
  },
);

server.registerTool(
  'key',
  { description: 'Press a key by name (e.g. return, space, esc, arrow-left).', inputSchema: { key: z.string() }, annotations: guarded },
  async ({ key }) => {
    await exec(CLICLICK, [`kp:${key}`]);
    return ok(`pressed ${key}`);
  },
);

await server.connect(new StdioServerTransport());
