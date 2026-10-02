import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeployEvent } from '@flint/policy';

// Deploy events (Machine plan P2): the install scripts append DeployEvent lines
// to ~/.flint/deploy-events.jsonl, which the runtime's `deploy` source reads.
// Every run here uses a scratch HOME: nothing touches the real ~/.flint.
const REPO = join(__dirname, '..', '..', '..');
const SCRIPTS = {
  server: join(REPO, 'apps', 'server', 'install-server.sh'),
  runtime: join(REPO, 'apps', 'runtime', 'install-runtime.sh'),
} as const;
const source = (c: keyof typeof SCRIPTS) => readFileSync(SCRIPTS[c], 'utf8');
/** deploy_event exactly as the script has it. */
const fn = (c: keyof typeof SCRIPTS) => {
  const s = source(c);
  const start = s.indexOf('deploy_event() {');
  return s.slice(start, s.indexOf('\n}\n', start) + 3);
};
/** The EXIT trap exactly as the script has it. */
const trapLine = (c: keyof typeof SCRIPTS) => source(c).split('\n').find((l) => l.startsWith("trap '") && l.includes('deploy_event'))!;

const SHA = 'f'.repeat(8) + '0123456789abcdef0123456789abcdef';

/** Runs `body` under zsh with set -e and pipefail (as the scripts do), HOME a scratch dir. */
function run(body: string, opts: { home?: string; path?: string } = {}) {
  const home = opts.home ?? mkdtempSync(join(tmpdir(), 'deploy-events-'));
  const r = spawnSync('/bin/zsh', ['-f', '-c', `set -e\nsetopt pipefail\n${body}\necho END`], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, ...(opts.path ? { PATH: opts.path } : {}) },
  });
  const file = join(home, '.flint', 'deploy-events.jsonl');
  const lines = existsSync(file) && statSync(file).isFile() ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
  return { status: r.status, out: r.stdout + r.stderr, lines, home, file };
}

describe('deploy events from the install scripts', () => {
  it('both scripts parse (zsh -n), and carry the same deploy_event', () => {
    for (const path of Object.values(SCRIPTS)) {
      const r = spawnSync('/bin/zsh', ['-n', path], { encoding: 'utf8' });
      expect(r.status, `${path}: ${r.stderr}`).toBe(0);
    }
    expect(fn('server')).toMatch(/^deploy_event\(\) \{[\s\S]*\n\}\n$/);
    expect(fn('server')).toBe(fn('runtime'));
  });

  for (const c of ['server', 'runtime'] as const) {
    it(`${c}: writes lines that parse as DeployEvent, in a 0600 file under a 0700 ~/.flint`, () => {
      const before = Date.now();
      const r = run(`${fn(c)}\ndeploy_event ${c} gate failed ${SHA}\ndeploy_event ${c} deploy ok ${SHA}`);
      expect(r.status).toBe(0);
      expect(r.out).toBe('END\n');
      expect(r.lines).toHaveLength(2);
      const events = r.lines.map((l) => DeployEvent.parse(JSON.parse(l)));
      expect(events.map((e) => [e.component, e.stage, e.outcome, e.sha])).toEqual([
        [c, 'gate', 'failed', SHA],
        [c, 'deploy', 'ok', SHA],
      ]);
      expect(events[0]!.id).not.toBe(events[1]!.id);
      const at = Date.parse(events[0]!.at);
      expect(at).toBeGreaterThanOrEqual(Math.floor(before / 1000) * 1000);
      expect(at).toBeLessThanOrEqual(Date.now());
      expect(statSync(r.file).mode & 0o777).toBe(0o600);
      expect(statSync(join(r.home, '.flint')).mode & 0o777).toBe(0o700);
    });
  }

  it('anything outside the contract writes nothing, and the install carries on', () => {
    const bad = [
      `runtime gate failed ${SHA.slice(1)}`,
      `runtime gate failed ${SHA.toUpperCase()}`,
      `runtime gate failed ''`,
      `runtime build failed ${SHA}`,
      `runtime gate skipped ${SHA}`,
      `console gate failed ${SHA}`,
      `'runtime","x":"y' gate failed ${SHA}`,
      `runtime gate failed '${SHA}\n${SHA}'`,
      `runtime gate failed`,
    ];
    const r = run(`${fn('runtime')}\n${bad.map((b) => `deploy_event ${b}`).join('\n')}`);
    expect(r.status).toBe(0);
    expect(r.out).toBe('END\n');
    expect(r.lines).toEqual([]);
  });

  it('a write that cannot happen never fails the install (set -e and pipefail stay on around it)', () => {
    // ~/.flint is a file.
    const home1 = mkdtempSync(join(tmpdir(), 'deploy-events-'));
    writeFileSync(join(home1, '.flint'), 'not a directory');
    const r1 = run(`${fn('server')}\ndeploy_event server gate failed ${SHA}\n[[ -o errexit && -o pipefail ]] && echo still-strict`, { home: home1 });
    expect(r1.status).toBe(0);
    expect(r1.out).toBe('still-strict\nEND\n');
    // The events file is a directory.
    const home2 = mkdtempSync(join(tmpdir(), 'deploy-events-'));
    mkdirSync(join(home2, '.flint', 'deploy-events.jsonl'), { recursive: true });
    expect(run(`${fn('runtime')}\ndeploy_event runtime gate failed ${SHA}`, { home: home2 }).out).toBe('END\n');
    // openssl fails (no id, no line).
    const bin = mkdtempSync(join(tmpdir(), 'deploy-events-bin-'));
    writeFileSync(join(bin, 'openssl'), '#!/bin/sh\nexit 1\n');
    chmodSync(join(bin, 'openssl'), 0o755);
    const r3 = run(`${fn('runtime')}\ndeploy_event runtime gate failed ${SHA}`, { path: `${bin}:/usr/bin:/bin` });
    expect(r3.out).toBe('END\n');
    expect(r3.lines).toEqual([]);
  });

  for (const c of ['server', 'runtime'] as const) {
    it(`${c}: the EXIT trap records the failed stage and keeps the exit status; a clean exit records nothing`, () => {
      const prelude = `SHA=${SHA}\n${fn(c)}\nDEPLOY_STAGE=gate\n${trapLine(c)}`;
      const failed = run(`${prelude}\nfalse\necho never`);
      expect(failed.status).toBe(1);
      expect(failed.out).not.toContain('never');
      expect(failed.lines.map((l) => DeployEvent.parse(JSON.parse(l))).map((e) => [e.component, e.stage, e.outcome, e.sha])).toEqual([[c, 'gate', 'failed', SHA]]);
      // A die() further on, under the stage the script has reached.
      const later = run(`${prelude}\ndie() { echo "✗ $*"; exit 1; }\nDEPLOY_STAGE=migrate\ndie boom`);
      expect(later.status).toBe(1);
      expect(later.lines.map((l) => JSON.parse(l).stage)).toEqual(['migrate']);
      // Exit 0 (the runtime's skip of a SHA whose migration failed) and an emptied stage record nothing.
      expect(run(`${prelude}\nexit 0`).lines).toEqual([]);
      const emptied = run(`${prelude}\nDEPLOY_STAGE=\nexit 3`);
      expect(emptied.status).toBe(3);
      expect(emptied.lines).toEqual([]);
    });
  }

  it('install-runtime.sh: gate, migrate, restart, health in order; the health failure is recorded before the rollback', () => {
    const s = source('runtime');
    const at = (needle: string) => {
      const i = s.indexOf(needle);
      expect(i, needle).toBeGreaterThan(-1);
      return i;
    };
    expect(at('SHA="$(git -C')).toBeLessThan(at('DEPLOY_STAGE=gate'));
    expect(at('DEPLOY_STAGE=gate')).toBeLessThan(at('# 1. every migration is reversible'));
    expect(at('# 3. gate')).toBeLessThan(at('DEPLOY_STAGE=migrate'));
    expect(at('DEPLOY_STAGE=migrate')).toBeLessThan(at('prisma migrate deploy)'));
    expect(at('prisma migrate deploy)')).toBeLessThan(at('DEPLOY_STAGE=restart'));
    expect(at('DEPLOY_STAGE=restart')).toBeLessThan(at('"$ESBUILD" "$RT_SRC/src/index.ts"'));
    expect(at('restart_agent || deploy_event runtime restart failed "$SHA"')).toBeLessThan(at('DEPLOY_STAGE=health'));
    expect(at('DEPLOY_STAGE=health')).toBeLessThan(at('/health" 2>/dev/null'));
    expect(at('/health" 2>/dev/null')).toBeLessThan(at('deploy_event runtime deploy ok "$SHA"'));
    expect(at('deploy_event runtime health failed "$SHA"')).toBeLessThan(at('ln -sfn "$PREV" "$RT/current"'));
    expect(at('did not report healthy')).toBeLessThan(at('deploy_event runtime health failed "$SHA"'));
  });

  it('install-server.sh: the workspace build and the gate are the gate stage; a finished deploy is recorded once /health answers', () => {
    const s = source('server');
    const at = (needle: string) => {
      const i = s.indexOf(needle);
      expect(i, needle).toBeGreaterThan(-1);
      return i;
    };
    expect(at('SHA="$(git -C')).toBeLessThan(at('DEPLOY_STAGE=gate'));
    expect(at('DEPLOY_STAGE=gate')).toBeLessThan(at('pnpm --filter @flint/core build'));
    expect(at('# ---- GATE')).toBeLessThan(at('\nDEPLOY_STAGE=\n'));
    expect(at('\nDEPLOY_STAGE=\n')).toBeLessThan(at('echo "bundling server'));
    expect(at('verifying http://localhost')).toBeLessThan(at('deploy_event server deploy ok "$SHA"'));
    expect(at('deploy_event server deploy ok "$SHA"')).toBeLessThan(at('# ---- TAILNET'));
  });
});
