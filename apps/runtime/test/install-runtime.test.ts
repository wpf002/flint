/**
 * install-runtime.sh, P2's parts: the bundle targets node22, launchd gives a
 * stop 30 s (the bus drains for 15), Will's runtime.override.env is never
 * written (only kept 0600), and pruning keeps a pinned release.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = readFileSync(join(__dirname, '..', 'install-runtime.sh'), 'utf8');
const between = (from: string, to: string) => {
  const a = SCRIPT.indexOf(from);
  const b = SCRIPT.indexOf(to, a);
  if (a < 0 || b < 0) throw new Error(`install-runtime.sh changed: no ${from} … ${to}`);
  return SCRIPT.slice(a, b + to.length);
};
const zsh = (body: string) => spawnSync('/bin/zsh', ['-c', `set -e\nsetopt pipefail\n${body}`], { encoding: 'utf8' });

describe('install-runtime.sh', () => {
  it('bundles for node22, on both esbuild lines', () => {
    expect(SCRIPT.match(/--target=node\d+/g)).toEqual(['--target=node22', '--target=node22']);
  });

  it('gives the runtime 30 s to stop (ExitTimeOut)', () => {
    expect(SCRIPT).toMatch(/<key>ExitTimeOut<\/key><integer>30<\/integer>/);
  });

  it('the override survives a redeploy: never written, only kept 0600', () => {
    expect(SCRIPT).not.toMatch(/>\s*"?\$DATA\/runtime\.override\.env/);
    const line = SCRIPT.split('\n').find((l) => l.includes('runtime.override.env') && l.includes('chmod'))!;
    const data = mkdtempSync(join(tmpdir(), 'rt-install-'));
    // Absent: nothing made, no failure under set -e.
    expect(zsh(`DATA=${data}\n${line}\necho END`).stdout).toContain('END');
    expect(existsSync(join(data, 'runtime.override.env'))).toBe(false);
    writeFileSync(join(data, 'runtime.override.env'), 'FLINT_RUNTIME_TRIAGE=on\n', { mode: 0o644 });
    expect(zsh(`DATA=${data}\n${line}\necho END`).stdout).toContain('END');
    expect(statSync(join(data, 'runtime.override.env')).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(data, 'runtime.override.env'), 'utf8')).toBe('FLINT_RUNTIME_TRIAGE=on\n');
  });

  it('writes the triage model settings only when they are loopback and well-formed', () => {
    const block = between('OLLAMA_HOST_V="$(', 'OLLAMA_NUM_CTX=$OLLAMA_CTX_V"; fi');
    const run = (host: string, model: string, ctx: string) => {
      const body = block
        .replace(/OLLAMA_HOST_V="\$\(plutil[^\n]*/, `OLLAMA_HOST_V='${host}'`)
        .replace(/OLLAMA_MODEL_V="\$\(plutil[^\n]*/, `OLLAMA_MODEL_V='${model}'`)
        .replace(/OLLAMA_CTX_V="\$\(plutil[^\n]*/, `OLLAMA_CTX_V='${ctx}'`);
      return zsh(body).stdout;
    };
    expect(run('http://127.0.0.1:11434', 'muse-glimmer:30b', '16384')).toBe('OLLAMA_URL=http://127.0.0.1:11434\nFLINT_TRIAGE_MODEL=muse-glimmer:30b\nOLLAMA_NUM_CTX=16384\n');
    expect(run('http://10.0.0.2:11434', 'a b', '16k; rm')).toBe('');
  });

  it('pruning keeps the newest three, the new release and any pinned one', () => {
    const prune = between('    ls -1dt "$RT"/releases/*(/N)', '    done\n');
    const rt = mkdtempSync(join(tmpdir(), 'rt-releases-'));
    const names = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6'];
    names.forEach((n, i) => {
      mkdirSync(join(rt, 'releases', n), { recursive: true });
      const t = new Date(Date.UTC(2026, 9, 1, i));
      utimesSync(join(rt, 'releases', n), t, t);
    });
    writeFileSync(join(rt, 'pinned'), 'r1\n');
    const r = zsh(`RT=${rt}\nREL=${rt}/releases/r6\n${prune}\necho END`);
    expect(r.stdout).toContain('END');
    expect(readdirSync(join(rt, 'releases')).sort()).toEqual(['r1', 'r4', 'r5', 'r6']);
  });
});
