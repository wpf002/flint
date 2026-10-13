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
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
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
      mkdirSync(join(outer, 'kept'));
      writeFileSync(join(outer, 'kept', 'mine'), 'stays');
      symlinkSync(join(outer, 'kept'), join(root, 'link-out'));
      // ...and a second name for a file outside, one its owner made read-only.
      chmodSync(join(outer, 'kept', 'mine'), 0o400);
      linkSync(join(outer, 'kept', 'mine'), join(root, 'locked', 'second-name'));
      chmodSync(join(root, 'locked'), 0o500);
      teardown();
      expect(existsSync(root)).toBe(false);
      // Nothing outside the folder went with it, nothing was followed out of it, and the file outside is as it was.
      expect(readdirSync(outer)).toEqual(['kept']);
      expect(readFileSync(join(outer, 'kept', 'mine'), 'utf8')).toBe('stays');
      expect(statSync(join(outer, 'kept', 'mine')).mode & 0o777).toBe(0o400);
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
  });

  describe('the studio tests’ helper, run for real (apps/studio/test/temp_root.zsh)', () => {
    const helper = join(REPO, 'apps', 'studio', 'test', 'temp_root.zsh');
    let outer = '';
    const fresh = (): string => {
      outer = mkdtempSync(join(tmpdir(), 'flint-outer-'));
      return outer;
    };
    const run = (body: string, env: Record<string, string> = {}) =>
      spawnSync('/bin/zsh', ['-c', `source ${JSON.stringify(helper)}\n${body}`], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', TMPDIR: outer, OUTER: outer, ...env } });
    const left = (): string[] => readdirSync(outer).filter((f) => f.startsWith('flint-t.'));

    it('the folder goes when the test ends, whatever its own EXIT trap does, with a folder nobody could write to', () => {
      fresh();
      const normal = run('fx="$(mktemp -d)"; trap \'rm -rf "$fx"\' EXIT; mkdir "$TMPDIR/left-behind"; mkdir -p "$TMPDIR/locked/in/deep"; chmod 000 "$TMPDIR/locked/in/deep"; chmod 500 "$TMPDIR/locked/in" "$TMPDIR/locked"; print -r -- "$TMPDIR"');
      expect(normal.status).toBe(0);
      expect(dirname(normal.stdout.trim())).toBe(outer);
      expect(basename(normal.stdout.trim())).toMatch(/^flint-t\.[A-Za-z0-9]{6}$/);
      expect(readdirSync(outer)).toEqual([]);
      const failed = run('mkdir "$TMPDIR/left"; exit 7');
      expect(failed.status).toBe(7);
      expect(readdirSync(outer)).toEqual([]);
    });

    it('a subshell that exits never removes it: the folder is the running test’s until the test itself ends', () => {
      fresh();
      const cases: Array<[string, string]> = [
        ['a subshell', '( exit 0 )'],
        ['a subshell that fails', '( exit 3 ) || true'],
        ['a command substitution', 'x=$(exit 0)'],
        ['a background job', '{ exit 0; } & wait'],
        ['one side of a pipeline', '{ print hi; exit 0; } | cat >/dev/null'],
        ['an eval of a subshell', 'eval "( cd / && exit 0 )"'],
        ['a child zsh', '/bin/zsh -c "exit 0"'],
        ['a function that returns', 'f() { return 0; }; f'],
      ];
      for (const [name, body] of cases) {
        const r = run(`print -r -- keep > "$TMPDIR/fixture"\n${body}\n[[ -d $TEST_TMP_ROOT && -f $TMPDIR/fixture ]] && print still-there`);
        expect(r.stdout.trim(), name).toBe('still-there');
        expect(r.status, name).toBe(0);
        // ...and it still goes at the end.
        expect(left(), name).toEqual([]);
      }
    });

    it('a test under `set -e` that stops at a failing command still removes it; a failing command with errexit off removes nothing', () => {
      fresh();
      const stopped = run('set -e; trap \'print own-exit-trap\' EXIT; mkdir "$TMPDIR/left"; false; print not-reached');
      expect(stopped.status).toBe(1);
      expect(stopped.stdout).toBe('own-exit-trap\n');
      expect(left()).toEqual([]);
      // Not under set -e: a command that fails is the test's own business, and the folder stays until the end.
      const carried = run('mkdir "$TMPDIR/still"; false; [[ -d $TMPDIR/still ]] && print still-there');
      expect(carried.stdout.trim()).toBe('still-there');
      expect(left()).toEqual([]);
      // Under set -e, where a failure does not end the shell: a condition, an `||`, and a function that turned errexit off for itself.
      const conditions = run('set -e; mkdir "$TMPDIR/still"; if false; then :; fi; false || true; f() { emulate -L zsh; setopt no_err_exit; false; return 0; }; f; g() { false; return 0; }; if g; then :; fi; g || true; [[ -d $TMPDIR/still ]] && print still-there');
      expect(conditions.stdout.trim()).toBe('still-there');
      expect(conditions.status).toBe(0);
      expect(left()).toEqual([]);
    });

    it('a stop removes it too: Ctrl-C, a kill, a closed window', () => {
      fresh();
      for (const signal of ['INT', 'TERM', 'HUP']) {
        const stopped = run(`mkdir "$TMPDIR/left"; kill -${signal} $$; sleep 5`);
        expect(stopped.status, signal).toBe(130);
        expect(left(), signal).toEqual([]);
      }
    });

    it('nothing outside the folder is changed or removed: not through a link, a hard link, or a name it was not given', () => {
      fresh();
      const outside = join(outer, 'outside');
      mkdirSync(join(outside, 'dir'), { recursive: true });
      writeFileSync(join(outside, 'secret'), 'x');
      writeFileSync(join(outside, 'dir', 'f'), 'x');
      chmodSync(join(outside, 'secret'), 0o400);
      chmodSync(join(outside, 'dir', 'f'), 0o400);
      chmodSync(join(outside, 'dir'), 0o500);
      // A hard link to a file outside, links to a file and a folder outside, and a folder that must be unlocked to be emptied.
      const r = run('ln "$OUTER/outside/secret" "$TMPDIR/hard"; ln -s "$OUTER/outside/secret" "$TMPDIR/l1"; ln -s "$OUTER/outside/dir" "$TMPDIR/l2"; mkdir -p "$TMPDIR/d/e"; chmod 000 "$TMPDIR/d/e"; chmod 500 "$TMPDIR/d"');
      expect(r.status).toBe(0);
      expect(left()).toEqual([]);
      const mode = (f: string) => statSync(f).mode & 0o777;
      expect([mode(join(outside, 'secret')), mode(join(outside, 'dir')), mode(join(outside, 'dir', 'f'))]).toEqual([0o400, 0o500, 0o400]);
      expect(readFileSync(join(outside, 'secret'), 'utf8')).toBe('x');
      // The variable pointed somewhere else by the test: a plain folder, and a link with a run folder's name. Neither is removed.
      mkdirSync(join(outer, 'plain', 'keep'), { recursive: true });
      mkdirSync(join(outer, 'real', 'keep'), { recursive: true });
      symlinkSync(join(outer, 'real'), join(outer, 'flint-t.LINKED'));
      run('rmdir "$TEST_TMP_ROOT"; TEST_TMP_ROOT="$OUTER/plain"');
      run('rmdir "$TEST_TMP_ROOT"; TEST_TMP_ROOT="$OUTER/flint-t.LINKED"');
      run('rmdir "$TEST_TMP_ROOT"; TEST_TMP_ROOT=""');
      expect(readdirSync(join(outer, 'plain'))).toEqual(['keep']);
      expect(readdirSync(join(outer, 'real'))).toEqual(['keep']);
      expect(lstatSync(join(outer, 'flint-t.LINKED')).isSymbolicLink()).toBe(true);
      // A run folder a parent test already made is the parent's: a test started inside it makes none, and removes none.
      const parent = join(outer, 'flint-t.PARENT');
      mkdirSync(parent);
      const child = run('print -r -- "$TMPDIR"', { TEST_TMP_ROOT: parent });
      expect(child.stdout.trim()).toBe(outer);
      expect(existsSync(parent)).toBe(true);
      chmodSync(join(outside, 'dir'), 0o700);
    });
  });

  it('a vitest run that is stopped removes its folder before it ends: Ctrl-C, a kill, a closed window', async () => {
    const outer = mkdtempSync(join(tmpdir(), 'flint-outer-'));
    const script = join(outer, 'run.ts');
    // A stand-in for a run: the setup, a folder nobody could write to left in it, and then it waits to be stopped.
    writeFileSync(script, [
      `import setup from ${JSON.stringify(join(REPO, 'test-support', 'temp-root.ts'))};`,
      "import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';",
      "import { join } from 'node:path';",
      'setup();',
      "const root = process.env.TMPDIR!;",
      "mkdirSync(join(root, 'locked', 'in'), { recursive: true });",
      "writeFileSync(join(root, 'locked', 'in', 'held'), 'x');",
      "chmodSync(join(root, 'locked', 'in'), 0o500);",
      'process.stdout.write(`${root}\\n`);',
      'setInterval(() => {}, 1000);',
    ].join('\n'));
    for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]] as const) {
      const child = spawn(join(REPO, 'apps', 'server', 'node_modules', '.bin', 'tsx'), [script], { env: { PATH: process.env.PATH ?? '', TMPDIR: outer }, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (d: Buffer) => { out += d.toString('utf8'); });
      const ended = new Promise<number | null>((resolve) => child.on('exit', (c) => resolve(c)));
      for (let i = 0; i < 400 && !out.includes('\n'); i++) await new Promise((r) => setTimeout(r, 25));
      const root = out.trim();
      expect(dirname(root), signal).toBe(outer);
      expect(existsSync(root), signal).toBe(true);
      // To the process that holds the folder (tsx starts it as a child of its own).
      const pids = spawnSync('/usr/bin/pgrep', ['-f', script], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean).map(Number);
      for (const pid of pids) try { process.kill(pid, signal); } catch { /* already gone */ }
      await ended;
      for (let i = 0; i < 200 && existsSync(root); i++) await new Promise((r) => setTimeout(r, 25));
      expect(existsSync(root), `${signal} (exit ${code})`).toBe(false);
    }
    rmSync(outer, { recursive: true, force: true });
  }, 60_000);
});
