/**
 * Tests never reach Will's screen (test-support/quiet.ts). On 2026-10-05 a test
 * ran a copied system binary from a fake Flint.app, and macOS told Will that
 * "Flint" was damaged. This checks the guard stays in place:
 *  - every package that runs vitest loads test-support/quiet.ts;
 *  - the stand-ins are on PATH here, executable, and print nothing;
 *  - no test file builds an app bundle, copies a system binary, or calls the
 *    real osascript or open by absolute path (which PATH cannot catch).
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(__dirname, '..', '..', '..');
const QUIET = join(REPO, 'test-support', 'quiet-bin');
const tracked = (...globs: string[]) =>
  spawnSync('git', ['ls-files', ...globs], { cwd: REPO, encoding: 'utf8' }).stdout.split('\n').filter(Boolean);

describe('tests stay off the screen', () => {
  it('every package that runs vitest loads the quiet setup', () => {
    const packages = tracked('apps/*/package.json', 'packages/*/package.json')
      .filter((p) => /"test":\s*"[^"]*vitest/.test(readFileSync(join(REPO, p), 'utf8')))
      .map((p) => p.replace(/\/package\.json$/, ''));
    expect(packages).toContain('apps/server');
    expect(packages).toContain('apps/runtime');
    for (const p of packages) {
      const cfg = join(REPO, p, 'vitest.config.ts');
      expect(existsSync(cfg), `${p} has no vitest.config.ts`).toBe(true);
      expect(readFileSync(cfg, 'utf8'), p).toContain("setupFiles: ['../../test-support/quiet.ts']");
    }
  });

  it('puts no-op stand-ins first on PATH, for this run and what it spawns', () => {
    expect(process.env.PATH!.split(':')[0]).toBe(QUIET);
    for (const c of ['osascript', 'open', 'say', 'afplay', 'terminal-notifier']) {
      expect(statSync(join(QUIET, c)).mode & 0o111, c).toBeTruthy();
      const r = spawnSync('/bin/zsh', ['-c', `command -v ${c}; ${c} -e 'display notification "test" with title "Flint"'`], { encoding: 'utf8' });
      expect(r.status, c).toBe(0);
      expect(r.stdout.trim(), c).toBe(join(QUIET, c));
      expect(r.stderr, c).toBe('');
    }
  });

  it('no test builds an app bundle, copies a system binary, or calls osascript or open by path', () => {
    const self = 'apps/server/test/tests-stay-quiet.test.ts';
    const files = tracked('*.test.ts', '*.test.mts', 'apps/*/test/**', 'packages/*/test/**').filter((f) => f !== self && /\.(m?ts|sh|zsh)$/.test(f));
    expect(files.length).toBeGreaterThan(50);
    const banned: Array<[RegExp, string]> = [
      [/\.app['"`/,)]\s*[,)]?.*Contents|\.app\/Contents/, 'builds or runs from an app bundle'],
      [/copyFileSync\(\s*['"`]\/(usr\/)?s?bin\//, 'copies a system binary'],
      [/\bcp\s+(-\w+\s+)*\/(usr\/)?s?bin\//, 'copies a system binary'],
      [/\/usr\/bin\/(osascript|open)\b/, 'calls the real osascript or open'],
    ];
    const hits: string[] = [];
    for (const f of files) {
      const text = readFileSync(join(REPO, f), 'utf8');
      for (const [re, why] of banned) if (re.test(text)) hits.push(`${f}: ${why}`);
    }
    expect(hits).toEqual([]);
  });
});
