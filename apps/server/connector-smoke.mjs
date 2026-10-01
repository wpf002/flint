#!/usr/bin/env node
// Start an MCP connector bundle and ask it for its tools, the way Flint's server
// will after a reload. Exit 0 if it lists at least one tool within the timeout,
// 1 otherwise. install-server.sh runs this on every rebuilt connector BEFORE it
// replaces the working one: a bundle can build and still die at startup.
//
//   node connector-smoke.mjs <candidate.mjs> [timeoutMs] [installed.mjs] [mcp.json]
//
// With the installed path and the server's mcp.json, the candidate is started
// exactly as the server starts that connector (packages/mcp/src/client.ts): the
// entry's command, args (the installed path swapped for the candidate), cwd, and
// env = the MCP SDK's default variables plus the entry's env, `${NAME}` filled
// from this process's environment as apps/server/src/mcp-config.ts fills it.
// Without an entry, it gets the default variables only, as the server would give
// it no more. Env values are never printed.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const [candidate, ms = '10000', installed, configPath] = process.argv.slice(2);
if (!candidate) {
  console.error('usage: connector-smoke.mjs <candidate.mjs> [timeoutMs] [installed.mjs] [mcp.json]');
  process.exit(2);
}

// The MCP SDK's getDefaultEnvironment() on macOS/Linux.
const DEFAULT_ENV = ['HOME', 'LOGNAME', 'PATH', 'SHELL', 'TERM', 'USER'];
const env = Object.fromEntries(DEFAULT_ENV.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));
const fill = (v) => v.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => process.env[name] ?? '');

let command = process.execPath;
let args = [candidate];
let cwd;
let as = '';
if (installed && configPath) {
  let servers = [];
  try {
    servers = JSON.parse(readFileSync(configPath, 'utf8')).servers ?? [];
  } catch {
    // No readable config: start it the default way.
  }
  const want = resolve(installed);
  const entry = servers.find((s) => s && typeof s.command === 'string' && Array.isArray(s.args) && s.args.some((a) => typeof a === 'string' && resolve(a) === want));
  if (entry) {
    command = entry.command;
    args = entry.args.map((a) => (typeof a === 'string' && resolve(a) === want ? candidate : a));
    for (const [k, v] of Object.entries(entry.env ?? {})) if (typeof v === 'string') env[k] = fill(v);
    if (typeof entry.cwd === 'string') cwd = entry.cwd;
    as = ` as ${entry.name}`;
  }
}

const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env, ...(cwd ? { cwd } : {}) });
// A connector that dies before our first write closes its stdin; without a
// listener that EPIPE is an unhandled 'error' and Node's stack would replace the
// connector's own message.
child.stdin.on('error', () => {});
let out = '';
let err = '';
let done = false;
/** The line that says what went wrong: the last one naming an error, else the last line. */
const why = () => {
  const lines = err.trim().split('\n').filter(Boolean);
  return [...lines].reverse().find((l) => /error|cannot|not defined|failed/i.test(l)) ?? lines.pop() ?? '';
};
const finish = (code, msg) => {
  if (done) return;
  done = true;
  clearTimeout(timer);
  child.kill('SIGKILL');
  (code === 0 ? console.log : console.error)(msg);
  process.exit(code);
};
const timer = setTimeout(() => finish(1, `no tool list within ${ms}ms${as}${err ? `: ${why()}` : ''}`), Number(ms));
child.stderr.on('data', (d) => (err += d));
child.on('error', (e) => finish(1, `could not start${as}: ${e.message}`));
// 'close' (not 'exit') so stderr has been read in full when we report.
child.on('close', (code) => finish(1, `exited ${code} before listing tools${as}${err ? `: ${why()}` : ''}`));
child.stdout.on('data', (d) => {
  out += d;
  const lines = out.split('\n');
  out = lines.pop() ?? '';
  for (const line of lines) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id === 1) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
    }
    if (msg.id === 2) {
      const n = msg.result?.tools?.length ?? 0;
      finish(n > 0 ? 0 : 1, n > 0 ? `${n} tools${as}` : `listed no tools${as}${msg.error ? `: ${msg.error.message}` : ''}`);
    }
  }
});
child.stdin.write(
  `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'flint-deploy-smoke', version: '1' } } })}\n`,
);
