import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LOCAL_PICK_CAP_MS } from '../src/local-model';
import { BOOT_EMBED_WAIT_MS } from '../src/router';

// After a deploy the installer polls /health, and puts the previous bundle back when it gets no
// answer. It tried ten times, a second apart, while the server could wait on Ollama for far longer
// before it listened: a good bundle was thrown out because Ollama was slow. Two things changed:
// the server no longer waits on Ollama for more than a few seconds (test/local-model.test.ts,
// test/router.test.ts), and the poll here outlasts whatever wait is left.
const SCRIPT = readFileSync(join(__dirname, '..', 'install-server.sh'), 'utf8');
/** The poll exactly as install-server.sh has it: from where it picks the port to where it reads the result. */
const POLL = SCRIPT.slice(SCRIPT.indexOf('PORT_N="${PORT:-8080}"'), SCRIPT.indexOf('if [ "$up" != 1 ]; then'));

/** Runs the script's own poll against a server that answers /health from its `upAt`-th try on (0: never). No real curl, no real sleep. */
function poll(upAt: number) {
  const body = [
    'set -e',
    'calls=0; slept=0',
    `curl() { calls=$((calls + 1)); [ ${upAt} -gt 0 ] && [ "$calls" -ge ${upAt} ]; }`,
    'sleep() { slept=$((slept + $1)); }',
    POLL,
    'echo "up=$up calls=$calls slept=$slept wait=$HEALTH_WAIT_S"',
  ].join('\n');
  const r = spawnSync('/bin/zsh', ['-f', '-c', body], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
  const m = /up=(\d) calls=(\d+) slept=(\d+) wait=(\d+)/.exec(r.stdout);
  if (r.status !== 0 || !m) throw new Error(`the poll did not run: ${r.stdout}${r.stderr}`);
  return { up: m[1] === '1', calls: Number(m[2]), slept: Number(m[3]), wait: Number(m[4]) };
}

describe('install-server.sh waits for a slow boot before it gives up on the new bundle', () => {
  it('the test runs the script\'s own loop', () => {
    expect(POLL).toContain('HEALTH_WAIT_S=');
    expect(POLL).toContain('curl -fsS -m 3 "http://localhost:$PORT_N/health"');
    expect(POLL).toContain('sleep 1');
  });

  it('a server that answers on the first try is up at once', () => {
    expect(poll(1)).toMatchObject({ up: true, calls: 1, slept: 0 });
  });

  it('a server that takes 45 s to listen is still up: the old ten tries ended at 10', () => {
    expect(poll(45)).toMatchObject({ up: true, calls: 45, slept: 44 });
  });

  it('a server that never answers is given the whole wait, then counted as down', () => {
    const r = poll(0);
    expect(r.up).toBe(false);
    expect(r.calls).toBe(r.wait);
    expect(r.slept).toBe(r.wait);
  });

  it('the wait is a minute, several times what the server may wait on Ollama before it listens', () => {
    const { wait } = poll(1);
    expect(wait).toBeGreaterThanOrEqual(60);
    // The two things boot asks Ollama, each cut off by the clock.
    const bootWaitsOnOllamaMs = LOCAL_PICK_CAP_MS + BOOT_EMBED_WAIT_MS;
    expect(bootWaitsOnOllamaMs).toBeLessThanOrEqual(30_000);
    expect(wait * 1000).toBeGreaterThanOrEqual(5 * bootWaitsOnOllamaMs);
  });

  it('a server that is down is still put back on the previous bundle', () => {
    const after = SCRIPT.slice(SCRIPT.indexOf('if [ "$up" != 1 ]; then'));
    expect(after).toContain('cp -p "$DATA/server.mjs.prev" "$DATA/server.mjs"');
    expect(after).toContain('deploy_event server health failed "$SHA"');
  });
});
