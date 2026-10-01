import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = readFileSync(join(__dirname, '..', 'install-server.sh'), 'utf8');
/** The tailnet step exactly as install-server.sh has it. */
const STEP = SCRIPT.slice(SCRIPT.indexOf('# ---- TAILNET'), SCRIPT.indexOf('echo "done. server bundled'));

const listen = (host: string): Promise<{ srv: Server; port: number }> =>
  new Promise((ok) => {
    const srv = createServer((_q, r) => r.end('{"ok":true}'));
    srv.listen(0, host, () => ok({ srv, port: (srv.address() as { port: number }).port }));
  });

/** Runs the step with a fake `tailscale` that reports `proxy` and records what it is told. */
async function runStep(proxy: string, port: number) {
  const dir = mkdtempSync(join(tmpdir(), 'tailnet-'));
  const log = join(dir, 'calls.log');
  const fake = join(dir, 'tailscale');
  writeFileSync(
    fake,
    `#!/bin/sh\necho "$@" >> ${log}\ncase "$*" in *"serve status --json"*) printf '%s' '{"Web":{"flint-1.x.ts.net:443":{"Handlers":{"/":{"Proxy":"${proxy}"}}}}}';; esac\n`,
  );
  chmodSync(fake, 0o755);
  const sock = join(dir, 'ts.sock');
  const sockSrv = createNetServer();
  await new Promise<void>((ok) => sockSrv.listen(sock, ok));
  // Async, not spawnSync: the step curls the test's own HTTP server, which can only
  // answer while this process's event loop is free.
  const out = await new Promise<string>((ok) => {
    const child = spawn('/bin/zsh', ['-c', `set -e\nDATA=${dir}\nPORT_N=${port}\nFLINT_TS_SOCKET=${sock}\nPATH=${dir}:$PATH\n${STEP}\necho END`]);
    let text = '';
    child.stdout.on('data', (d) => (text += d));
    child.stderr.on('data', (d) => (text += d));
    child.on('close', () => ok(text));
  });
  sockSrv.close();
  return { out, calls: existsSync(log) ? readFileSync(log, 'utf8') : '' };
}

// Review of #34: deploying Flint onto ::1 left serve proxying to 127.0.0.1:8080,
// where nothing listens any more, while the deploy reported success.
describe('install-server.sh tailnet step', () => {
  it('points serve at http://localhost:<port> when it proxies anywhere else', async () => {
    const { srv, port } = await listen('::1');
    try {
      const r = await runStep('http://127.0.0.1:8080', port);
      expect(r.calls).toContain(`serve --bg http://localhost:${port}`);
      expect(r.out).toMatch(new RegExp(`serve now proxies to http://localhost:${port} \\(was http://127.0.0.1:8080\\)`));
      expect(r.out).not.toMatch(/WARNING/);
      expect(r.out).toMatch(/END/);
    } finally {
      srv.close();
    }
  });

  it('leaves serve alone when it already proxies to localhost', async () => {
    const { srv, port } = await listen('::1');
    try {
      const r = await runStep(`http://localhost:${port}`, port);
      expect(r.calls).not.toContain('serve --bg');
      expect(r.out).toMatch(/serve proxies to http:\/\/localhost/);
    } finally {
      srv.close();
    }
  });

  it('warns loudly when Flint answers on 127.0.0.1, where peers are forwarded raw', async () => {
    const { srv, port } = await listen('127.0.0.1');
    try {
      const r = await runStep(`http://localhost:${port}`, port);
      expect(r.out).toMatch(/WARNING: Flint answers on 127\.0\.0\.1/);
    } finally {
      srv.close();
    }
  });
});
