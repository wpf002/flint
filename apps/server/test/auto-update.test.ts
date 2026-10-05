/**
 * Flint keeps itself current after every push (auto-update):
 *  - auto_deploy.sh retries a failed deploy every 30 minutes, up to 6 times,
 *    only the part that failed, and its log never calls a failed server deploy
 *    "up to date" (the runtime's git source reads those lines);
 *  - update_app.sh installs a new Flint.app build even while the app is open
 *    (the app restarts itself onto it when idle), and keeps the current app
 *    when a build fails.
 * Everything runs in scratch repos with stub install scripts, a stub pnpm and
 * a stub osascript: nothing touches ~/.flint, /Applications or the screen.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = join(__dirname, '..', '..', '..');
const AUTO_DEPLOY = join(REPO, 'apps', 'server', 'auto_deploy.sh');
const UPDATE_APP = join(REPO, 'apps', 'desktop-mac', 'update_app.sh');

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const script = (path: string, body: string) => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `#!/bin/zsh\n${body}\n`);
  chmodSync(path, 0o755);
};

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'auto-update-'));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe('auto_deploy.sh retries a failed deploy', () => {
  let work: string, deployDir: string, bin: string, state: string, marks: string;

  beforeEach(() => {
    const origin = join(tmp, 'origin.git');
    work = join(tmp, 'work');
    deployDir = join(tmp, 'deploy');
    bin = join(tmp, 'bin');
    state = join(tmp, 'state');
    marks = join(tmp, 'marks');
    git(tmp, 'init', '-q', '--bare', '-b', 'main', origin);
    git(tmp, 'clone', '-q', origin, work);
    git(work, 'checkout', '-q', '-b', 'main');
    // Each stub records that it ran, and fails while its fail-file exists.
    script(join(work, 'apps/server/install-server.sh'), `echo server >> "${marks}"; [ -e "${tmp}/fail-server" ] && exit 1; exit 0`);
    script(join(work, 'apps/runtime/install-runtime.sh'), `echo runtime >> "${marks}"; [ -e "${tmp}/fail-runtime" ] && exit 1; exit 0`);
    script(join(work, 'apps/desktop-mac/update_app.sh'), 'exit 0');
    writeFileSync(join(work, 'README'), 'v0\n');
    git(work, 'add', '-A');
    git(work, 'commit', '-q', '-m', 'v0');
    git(work, 'push', '-q', 'origin', 'main');
    git(tmp, 'clone', '-q', origin, deployDir);
    script(join(bin, 'pnpm'), 'exit 0');
  });

  const push = (text: string) => {
    writeFileSync(join(work, 'README'), `${text}\n`);
    git(work, 'commit', '-q', '-am', text);
    git(work, 'push', '-q', 'origin', 'main');
    return git(work, 'rev-parse', 'HEAD');
  };
  const tick = () => {
    rmSync(marks, { force: true });
    const r = spawnSync('/bin/zsh', [AUTO_DEPLOY], {
      encoding: 'utf8',
      env: { ...process.env, HOME: tmp, FLINT_REPO: deployDir, FLINT_STATE_DIR: state, PATH: `${bin}:${process.env.PATH}` },
    });
    const ran = existsSync(marks) ? readFileSync(marks, 'utf8').trim().split('\n') : [];
    return { status: r.status, out: r.stdout + r.stderr, ran };
  };
  const retryFile = () => join(state, 'deploy-retry');
  const age = (minutes: number) => {
    const t = Date.now() / 1000 - minutes * 60;
    utimesSync(retryFile(), t, t);
  };

  it('a failed server deploy is retried after 30 minutes, alone, and says failed until then', () => {
    const sha = push('v1');
    writeFileSync(join(tmp, 'fail-server'), '');
    let t = tick();
    expect(t.status).toBe(1);
    expect(t.out).toContain(`server deploy FAILED at ${sha}`);
    expect(t.ran).toEqual(['server', 'runtime']);
    expect(readFileSync(retryFile(), 'utf8').trim()).toBe(`${sha} server 0`);

    // Within the 30 minutes: nothing runs, and the log does not call it up to date.
    t = tick();
    expect(t.status).toBe(0);
    expect(t.ran).toEqual([]);
    expect(t.out).toContain(`server deploy FAILED at ${sha} (retrying)`);
    expect(t.out).not.toContain('up to date');

    // After 30 minutes, with the cause gone: only the server, and it is forgotten.
    age(31);
    rmSync(join(tmp, 'fail-server'));
    t = tick();
    expect(t.status).toBe(0);
    expect(t.out).toContain(`retrying the failed deploy of ${sha} (server), attempt 1 of 6`);
    expect(t.out).toMatch(new RegExp(`^\\S+ \\S+ deployed ${sha}$`, 'm'));
    expect(t.ran).toEqual(['server']);
    expect(existsSync(retryFile())).toBe(false);
    expect(tick().out).toContain(`up to date (${sha})`);
  });

  it('counts its retries and stops after 6; a new push starts over', () => {
    const sha = push('v1');
    writeFileSync(join(tmp, 'fail-server'), '');
    tick();
    for (let n = 1; n <= 6; n++) {
      age(31);
      const t = tick();
      expect(t.out).toContain(`attempt ${n} of 6`);
      expect(readFileSync(retryFile(), 'utf8').trim()).toBe(`${sha} server ${n}`);
    }
    age(31);
    let t = tick();
    expect(t.ran).toEqual([]);
    expect(t.out).toContain(`server deploy FAILED at ${sha} (no retries left)`);
    rmSync(join(tmp, 'fail-server'));
    const next = push('v2');
    t = tick();
    expect(t.out).toMatch(new RegExp(`deployed ${next}$`, 'm'));
    expect(existsSync(retryFile())).toBe(false);
  });

  it('a failed runtime deploy is retried on its own, while the server reads up to date', () => {
    mkdirSync(join(tmp, '.flint', 'runtime', 'current'), { recursive: true });
    writeFileSync(join(work, 'apps/runtime/x.ts'), '1\n');
    git(work, 'add', '-A');
    const sha = push('runtime change');
    writeFileSync(join(tmp, 'fail-runtime'), '');
    let t = tick();
    expect(t.status).toBe(0);
    expect(t.ran).toEqual(['server', 'runtime']);
    expect(t.out).toContain(`runtime deploy FAILED at ${sha}`);
    expect(readFileSync(retryFile(), 'utf8').trim()).toBe(`${sha} runtime 0`);
    expect(tick().out).toContain(`up to date (${sha})`);
    age(31);
    rmSync(join(tmp, 'fail-runtime'));
    t = tick();
    expect(t.ran).toEqual(['runtime']);
    expect(t.out).toContain(`runtime deployed ${sha}`);
    expect(existsSync(retryFile())).toBe(false);
  });
});

describe('update_app.sh installs while Flint.app is open', () => {
  let repo: string, dest: string, state: string, bin: string, said: string, built: string;
  let fake: ChildProcess | undefined;

  beforeEach(() => {
    repo = join(tmp, 'repo');
    dest = join(tmp, 'Applications', 'Flint.app');
    state = join(tmp, 'state');
    bin = join(tmp, 'bin');
    said = join(tmp, 'notifications');
    built = join(tmp, 'built');
    const dir = join(repo, 'apps', 'desktop-mac');
    mkdirSync(dir, { recursive: true });
    copyFileSync(UPDATE_APP, join(dir, 'update_app.sh'));
    chmodSync(join(dir, 'update_app.sh'), 0o755);
    script(join(dir, 'install_app.sh'), `echo "install_app.sh $*" >> "${built}"; [ -e "${tmp}/fail-build" ] && exit 1; exit 0`);
    writeFileSync(join(dir, 'flint.swift'), '// v1\n');
    git(tmp, 'init', '-q', '-b', 'main', repo);
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'App v1');
    // The app "running": a process whose command line is the installed binary.
    mkdirSync(join(dest, 'Contents', 'MacOS'), { recursive: true });
    copyFileSync('/bin/sleep', join(dest, 'Contents', 'MacOS', 'flint'));
    fake = spawn(join(dest, 'Contents', 'MacOS', 'flint'), ['30'], { stdio: 'ignore' });
    script(join(bin, 'osascript'), `echo "$2" >> "${said}"`);
  });
  afterEach(() => {
    fake?.kill();
  });

  const update = () => {
    rmSync(built, { force: true });
    rmSync(said, { force: true });
    const r = spawnSync('/bin/zsh', [join(repo, 'apps', 'desktop-mac', 'update_app.sh')], {
      encoding: 'utf8',
      env: { ...process.env, HOME: tmp, FLINT_APP_DEST: dest, FLINT_STATE_DIR: state, PATH: `${bin}:${process.env.PATH}` },
    });
    return {
      status: r.status,
      out: r.stdout + r.stderr,
      built: existsSync(built) ? readFileSync(built, 'utf8').split('\n').filter(Boolean) : [],
      said: existsSync(said) ? readFileSync(said, 'utf8') : '',
    };
  };
  const tree = () => git(repo, 'rev-parse', 'HEAD:apps/desktop-mac');

  it('builds and installs at once, without --if-closed, and says the open app restarts onto it', () => {
    mkdirSync(state, { recursive: true });
    const u = update();
    expect(u.status).toBe(0);
    expect(u.built).toHaveLength(1);
    expect(u.built[0]).not.toContain('--if-closed');
    expect(u.out).toContain('installed (');
    expect(u.out).toContain('the open app restarts onto it when idle');
    expect(u.said).toContain('Flint updated: App v1');
    expect(readFileSync(join(state, 'app-installed-tree'), 'utf8').trim()).toBe(tree());
    // The same tree again: nothing to do.
    expect(update().built).toHaveLength(0);
  });

  it('keeps the current app when a build fails, and does not retry the same tree', () => {
    mkdirSync(state, { recursive: true });
    writeFileSync(join(tmp, 'fail-build'), '');
    let u = update();
    expect(u.status).toBe(0);
    expect(u.out).toContain('build failed');
    expect(u.said).toContain('Flint update failed to build. Kept the current app.');
    expect(readFileSync(join(state, 'app-failed-tree'), 'utf8').trim()).toBe(tree());
    expect(existsSync(join(state, 'app-installed-tree'))).toBe(false);
    u = update();
    expect(u.built).toHaveLength(0);
  });
});
