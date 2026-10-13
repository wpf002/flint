/**
 * Tests leave nothing behind in the temp folder (test-support/temp-root.ts).
 * The deploy gate and the builders' own runs had left tens of thousands of
 * scratch folders on the Mac that runs Flint. This checks the fix stays in
 * place:
 *  - every package that runs vitest starts its run by making one temp folder
 *    and removes it at the end;
 *  - this very run is inside such a folder, and so is whatever it starts;
 *  - the folder goes with everything in it, a folder nobody could write to
 *    included, and TMPDIR is put back;
 *  - the studio's script tests do the same, each for its own run.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import tempRoot, { TEMP_ROOT_PREFIX } from '../../../test-support/temp-root';

const REPO = join(__dirname, '..', '..', '..');
const tracked = (...globs: string[]) =>
  spawnSync('git', ['ls-files', ...globs], { cwd: REPO, encoding: 'utf8' }).stdout.split('\n').filter(Boolean);

describe('tests leave nothing in the temp folder', () => {
  it('every package that runs vitest makes its run a temp folder of its own', () => {
    const packages = tracked('apps/*/package.json', 'packages/*/package.json')
      .filter((p) => /"test":\s*"[^"]*vitest/.test(readFileSync(join(REPO, p), 'utf8')))
      .map((p) => p.replace(/\/package\.json$/, ''));
    expect(packages).toContain('apps/server');
    expect(packages).toContain('apps/runtime');
    for (const p of packages) {
      const cfg = readFileSync(join(REPO, p, 'vitest.config.ts'), 'utf8');
      // First in the list: whatever else a run sets up is made inside its folder.
      expect(cfg, p).toMatch(/globalSetup: \['\.\.\/\.\.\/test-support\/temp-root\.ts'[,\]]/);
    }
  });

  it('this run is inside one, and so is everything it makes or starts', () => {
    const root = tmpdir();
    expect(basename(root)).toMatch(new RegExp(`^${TEMP_ROOT_PREFIX}[A-Za-z0-9]{6}$`));
    expect(process.env.TMPDIR).toBe(root);
    const made = mkdtempSync(join(tmpdir(), 'flint-inside-'));
    expect(dirname(made)).toBe(root);
    // A script the test starts gets the same folder, from a shell and from node.
    const sh = spawnSync('/bin/zsh', ['-c', 'd="$(mktemp -d "${TMPDIR%/}/flint-sh.XXXXXX")" && print -r -- "$d"'], { encoding: 'utf8' });
    expect(dirname(sh.stdout.trim())).toBe(root);
    const node = spawnSync(process.execPath, ['-e', 'process.stdout.write(require("node:os").tmpdir())'], { encoding: 'utf8' });
    expect(node.stdout).toBe(root);
    // (Left where they are on purpose: the run's own end removes them with the folder.)
    expect(existsSync(made)).toBe(true);
  });

  it('the folder is removed with everything in it when the run ends, and TMPDIR is put back', () => {
    const outer = mkdtempSync(join(tmpdir(), 'flint-outer-'));
    const before = process.env.TMPDIR;
    process.env.TMPDIR = outer;
    let root = '';
    try {
      const teardown = tempRoot();
      root = process.env.TMPDIR!;
      expect(dirname(root)).toBe(outer);
      expect(basename(root)).toMatch(new RegExp(`^${TEMP_ROOT_PREFIX}[A-Za-z0-9]{6}$`));
      // What tests leave: folders, files, a folder nobody can write to, and a link to something outside.
      mkdirSync(join(root, 'flint-left-AbC123', 'deep'), { recursive: true });
      writeFileSync(join(root, 'flint-left-AbC123', 'deep', 'file'), 'x');
      mkdirSync(join(root, 'locked', 'inner'), { recursive: true });
      writeFileSync(join(root, 'locked', 'inner', 'held'), 'x');
      chmodSync(join(root, 'locked', 'inner'), 0o500);
      chmodSync(join(root, 'locked'), 0o500);
      mkdirSync(join(outer, 'kept'));
      writeFileSync(join(outer, 'kept', 'mine'), 'stays');
      symlinkSync(join(outer, 'kept'), join(root, 'link-out'));
      teardown();
      expect(existsSync(root)).toBe(false);
      // Nothing outside the folder went with it, and nothing was followed out of it.
      expect(readdirSync(outer)).toEqual(['kept']);
      expect(readFileSync(join(outer, 'kept', 'mine'), 'utf8')).toBe('stays');
      expect(process.env.TMPDIR).toBe(outer);
    } finally {
      if (before === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = before;
      rmSync(outer, { recursive: true, force: true });
    }
  });

  it('the studio’s script tests do the same, each for its own run: all but the rebuild rehearsal, which sweeps its own', () => {
    const tests = tracked('apps/studio/test/*.test.sh');
    expect(tests.length).toBeGreaterThanOrEqual(11);
    for (const t of tests) {
      const text = readFileSync(join(REPO, t), 'utf8');
      const first = text.split('\n').find((l) => l.trim() !== '' && !l.startsWith('#'));
      if (t.endsWith('/rebuild_rehearse.test.sh')) expect(text, t).toContain('keeps its own folders, not a run folder from temp_root.zsh');
      else expect(first, t).toBe('source "${0:A:h}/temp_root.zsh"   # one temp folder for this run, removed when the test ends');
    }
    // Run for real: a test's own EXIT trap does not replace the removal, a stop removes it too, and what a script it
    // started left is gone with it.
    const outer = mkdtempSync(join(tmpdir(), 'flint-outer-'));
    const helper = join(REPO, 'apps', 'studio', 'test', 'temp_root.zsh');
    const run = (body: string) => spawnSync('/bin/zsh', ['-c', `source ${JSON.stringify(helper)}\n${body}`], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', TMPDIR: outer } });
    const normal = run('fx="$(mktemp -d)"; trap \'rm -rf "$fx"\' EXIT; mkdir "$TMPDIR/left-behind"; mkdir -p "$TMPDIR/locked/in"; chmod 500 "$TMPDIR/locked/in" "$TMPDIR/locked"; print -r -- "$TMPDIR"');
    expect(normal.status).toBe(0);
    expect(dirname(normal.stdout.trim())).toBe(outer);
    expect(basename(normal.stdout.trim())).toMatch(/^flint-t\.[A-Za-z0-9]{6}$/);
    expect(readdirSync(outer)).toEqual([]);
    const failed = run('mkdir "$TMPDIR/left"; exit 7');
    expect(failed.status).toBe(7);
    expect(readdirSync(outer)).toEqual([]);
    const stopped = run('mkdir "$TMPDIR/left"; kill -TERM $$; sleep 5');
    expect(stopped.status).toBe(130);
    expect(readdirSync(outer)).toEqual([]);
    rmSync(outer, { recursive: true, force: true });
  });
});
