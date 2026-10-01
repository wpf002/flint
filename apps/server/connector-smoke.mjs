#!/usr/bin/env node
// Start an MCP connector bundle and ask it for its tools, the way Flint's server
// will after a reload. Exit 0 if it lists at least one tool within the timeout,
// 1 otherwise. install-server.sh runs this on every rebuilt connector BEFORE it
// replaces the working one: a bundle can build and still die at startup.
//
//   node connector-smoke.mjs <bundle.mjs> [timeoutMs]
import { spawn } from 'node:child_process';

const [bundle, ms = '10000'] = process.argv.slice(2);
if (!bundle) {
  console.error('usage: connector-smoke.mjs <bundle.mjs> [timeoutMs]');
  process.exit(2);
}
const child = spawn(process.execPath, [bundle], { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
let out = '';
let err = '';
/** The line that says what went wrong: the last one naming an error, else the last line. */
const why = () => {
  const lines = err.trim().split('\n').filter(Boolean);
  return [...lines].reverse().find((l) => /error|cannot|not defined|failed/i.test(l)) ?? lines.pop() ?? '';
};
const finish = (code, msg) => {
  clearTimeout(timer);
  child.kill('SIGKILL');
  (code === 0 ? console.log : console.error)(msg);
  process.exit(code);
};
const timer = setTimeout(() => finish(1, `no tool list within ${ms}ms${err ? `: ${why()}` : ''}`), Number(ms));
child.stderr.on('data', (d) => (err += d));
child.on('exit', (code) => finish(1, `exited ${code} before listing tools${err ? `: ${why()}` : ''}`));
child.stdout.on('data', (d) => {
  out += d;
  for (const line of out.split('\n')) {
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
      finish(n > 0 ? 0 : 1, n > 0 ? `${n} tools` : `listed no tools${msg.error ? `: ${msg.error.message}` : ''}`);
    }
  }
});
child.stdin.write(
  `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'flint-deploy-smoke', version: '1' } } })}\n`,
);
