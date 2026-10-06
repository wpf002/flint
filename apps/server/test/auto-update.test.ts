/**
 * Flint keeps itself current after every push (auto-update):
 *  - auto_deploy.sh retries a failed deploy every 30 minutes, up to 6 times,
 *    only the part that failed, and its log never calls a failed server deploy
 *    "up to date" (the runtime's git source reads those lines);
 *  - update_app.sh installs a new Flint.app build even while the app is open
 *    (the app restarts itself onto it when idle), and keeps the current app
 *    when a build fails;
 *  - Flint Calendar (apps/desktop-calendar) is updated only once the runtime
 *    it pushes to is live with the commit's runtime code;
 *  - the server's gate requires Flint Calendar's Swift checks only when a
 *    deploy changes the helper or its wire since the last finished server
 *    deploy (install-server.sh's calendar_changed), and skips them otherwise.
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
  let work: string, deployDir: string, bin: string, state: string, marks: string, events: string, runtimeDir: string;

  // A deploy event line, as deploy_event writes it (field order matters to auto_deploy's reader).
  const ev = (component: string, stage: string, outcome: string) =>
    `printf '{"id":"x","at":"2026-10-05T00:00:00Z","component":"${component}","stage":"${stage}","outcome":"${outcome}","sha":"%s"}\\n' "$(git rev-parse HEAD)" >> "${events}"`;

  beforeEach(() => {
    const origin = join(tmp, 'origin.git');
    work = join(tmp, 'work');
    deployDir = join(tmp, 'deploy');
    bin = join(tmp, 'bin');
    state = join(tmp, 'state');
    marks = join(tmp, 'marks');
    events = join(tmp, '.flint', 'deploy-events.jsonl');
    runtimeDir = join(tmp, '.flint', 'runtime');
    mkdirSync(join(tmp, '.flint'), { recursive: true });
    git(tmp, 'init', '-q', '--bare', '-b', 'main', origin);
    git(tmp, 'clone', '-q', origin, work);
    git(work, 'checkout', '-q', '-b', 'main');
    // The stubs behave like the real scripts: they record that they ran, write the
    // deploy events the real ones write, and fail at a stage while its flag file exists.
    script(join(work, 'apps/server/install-server.sh'), [
      `echo server >> "${marks}"`,
      `[ -e "${tmp}/server-gate" ] && { ${ev('server', 'gate', 'failed')}; exit 1; }`,
      `[ -e "${tmp}/server-health" ] && { ${ev('server', 'health', 'failed')}; exit 1; }`,
      ev('server', 'deploy', 'ok'),
      'exit 0',
    ].join('\n'));
    script(join(work, 'apps/runtime/install-runtime.sh'), [
      `echo runtime >> "${marks}"`,
      `[ -e "${tmp}/runtime-gate" ] && { ${ev('runtime', 'gate', 'failed')}; exit 1; }`,
      `[ -e "${tmp}/runtime-migrate" ] && { ${ev('runtime', 'migrate', 'failed')}; exit 1; }`,
      `[ -e "${tmp}/runtime-health" ] && { ${ev('runtime', 'health', 'failed')}; exit 1; }`,
      // A sha whose migration failed before: install-runtime.sh skips it and exits 0.
      `[ -e "${tmp}/runtime-skip" ] && exit 0`,
      `mkdir -p "${runtimeDir}/releases/$(git rev-parse HEAD)" && ln -sfn "${runtimeDir}/releases/$(git rev-parse HEAD)" "${runtimeDir}/current"`,
      ev('runtime', 'deploy', 'ok'),
      'exit 0',
    ].join('\n'));
    script(join(work, 'apps/desktop-mac/update_app.sh'), `echo app >> "${tmp}/appmarks"; exit 0`);
    script(join(work, 'apps/desktop-calendar/update_calendar.sh'), `echo calendar >> "${tmp}/calmarks"; exit 0`);
    writeFileSync(join(work, 'README'), 'v0\n');
    git(work, 'add', '-A');
    git(work, 'commit', '-q', '-m', 'v0');
    git(work, 'push', '-q', 'origin', 'main');
    git(tmp, 'clone', '-q', origin, deployDir);
    script(join(bin, 'pnpm'), 'exit 0');
  });

  const push = (text: string, file = 'README') => {
    mkdirSync(join(work, file, '..'), { recursive: true });
    writeFileSync(join(work, file), `${text}\n`);
    git(work, 'add', '-A');
    git(work, 'commit', '-q', '-m', text);
    git(work, 'push', '-q', 'origin', 'main');
    return git(work, 'rev-parse', 'HEAD');
  };
  const tick = () => {
    rmSync(marks, { force: true });
    rmSync(join(tmp, 'appmarks'), { force: true });
    rmSync(join(tmp, 'calmarks'), { force: true });
    const r = spawnSync('/bin/zsh', [AUTO_DEPLOY], {
      encoding: 'utf8',
      env: { ...process.env, HOME: tmp, FLINT_REPO: deployDir, FLINT_STATE_DIR: state, PATH: `${bin}:${process.env.PATH}` },
    });
    const ran = existsSync(marks) ? readFileSync(marks, 'utf8').trim().split('\n') : [];
    return { status: r.status, out: r.stdout + r.stderr, ran, app: existsSync(join(tmp, 'appmarks')), calendar: existsSync(join(tmp, 'calmarks')) };
  };
  const flag = (name: string, on = true) => (on ? writeFileSync(join(tmp, name), '') : rmSync(join(tmp, name), { force: true }));
  const retryFile = () => join(state, 'deploy-retry');
  const retry = () => (existsSync(retryFile()) ? readFileSync(retryFile(), 'utf8').trim() : null);
  const age = (minutes: number) => {
    const t = Date.now() / 1000 - minutes * 60;
    utimesSync(retryFile(), t, t);
  };
  const live = () => (existsSync(join(runtimeDir, 'current')) ? spawnSync('readlink', [join(runtimeDir, 'current')], { encoding: 'utf8' }).stdout.trim().split('/').pop() : null);

  it('a server that failed its gate is retried after 30 minutes, alone, and reads failed until then', () => {
    const sha = push('v1');
    flag('server-gate');
    let t = tick();
    expect(t.status).toBe(1);
    expect(t.out).toContain(`server deploy FAILED at ${sha}`);
    expect(t.ran).toEqual(['server', 'runtime']);
    expect(retry()).toBe(`${sha} server 0 1`);

    // Within the 30 minutes: nothing runs, and the log does not call it up to date.
    t = tick();
    expect(t.status).toBe(0);
    expect(t.ran).toEqual([]);
    expect(t.out).toContain(`server deploy FAILED at ${sha} (retrying)`);
    expect(t.out).not.toContain('up to date');

    // After 30 minutes, with the cause gone: only the server, and it is forgotten.
    age(31);
    flag('server-gate', false);
    t = tick();
    expect(t.status).toBe(0);
    expect(t.out).toContain(`retrying the failed deploy of ${sha} (server), attempt 1 of 6`);
    expect(t.out).toMatch(new RegExp(`^\\S+ \\S+ deployed ${sha}$`, 'm'));
    expect(t.ran).toEqual(['server']);
    expect(retry()).toBeNull();
    expect(tick().out).toContain(`up to date (${sha})`);
  });

  it('counts its retries and stops after 6; a new push starts over', () => {
    const sha = push('v1');
    flag('server-gate');
    tick();
    for (let n = 1; n <= 6; n++) {
      age(31);
      const t = tick();
      expect(t.out).toContain(`attempt ${n} of 6`);
      expect(retry()).toBe(`${sha} server ${n} 1`);
    }
    age(31);
    let t = tick();
    expect(t.ran).toEqual([]);
    expect(t.out).toContain(`server deploy FAILED at ${sha} (waiting for the next push)`);
    flag('server-gate', false);
    const next = push('v2');
    t = tick();
    expect(t.out).toMatch(new RegExp(`deployed ${next}$`, 'm'));
    expect(retry()).toBeNull();
  });

  it('never retries a server that failed past its gate (a boot crash would take Flint down again)', () => {
    const sha = push('v1');
    flag('server-health');
    expect(tick().status).toBe(1);
    expect(retry()).toBe(`${sha} server 0 0`);
    age(31);
    const t = tick();
    expect(t.ran).toEqual([]);
    expect(t.out).toContain(`server deploy FAILED at ${sha} (waiting for the next push)`);
  });

  it('a deploy by hand ends the retrying, and the log says so', () => {
    const sha = push('v1');
    flag('server-gate');
    tick();
    // Will runs the deploy himself (FLINT_SKIP_TESTS=1 ./apps/server/install-server.sh).
    flag('server-gate', false);
    spawnSync('/bin/zsh', [join(deployDir, 'apps/server/install-server.sh')], { cwd: deployDir, env: { ...process.env, HOME: tmp } });
    const t = tick();
    expect(t.ran).toEqual([]);
    expect(t.out).toContain(`up to date (${sha})`);
    expect(retry()).toBeNull();
  });

  it('a runtime that failed its gate is retried on its own, while the server reads up to date', () => {
    push('v0 runtime', 'apps/runtime/x.ts');
    tick();
    expect(live()).toBeTruthy();
    const sha = push('runtime change', 'apps/runtime/x.ts');
    flag('runtime-gate');
    let t = tick();
    expect(t.status).toBe(0);
    expect(t.ran).toEqual(['server', 'runtime']);
    expect(t.out).toContain(`runtime deploy FAILED at ${sha}`);
    expect(retry()).toBe(`${sha} runtime 0 1`);
    expect(tick().out).toContain(`up to date (${sha})`);
    age(31);
    flag('runtime-gate', false);
    t = tick();
    expect(t.ran).toEqual(['runtime']);
    expect(t.out).toContain(`runtime deployed ${sha}`);
    expect(live()).toBe(sha);
    expect(retry()).toBeNull();
  });

  it('a runtime left behind is deployed by the next push, even one that does not touch it', () => {
    push('v0 runtime', 'apps/runtime/x.ts');
    tick();
    const a = push('runtime change', 'apps/runtime/x.ts');
    flag('runtime-gate');
    tick();
    expect(live()).not.toBe(a);
    flag('runtime-gate', false);
    const b = push('docs only', 'docs.md');
    const t = tick();
    expect(t.ran).toEqual(['server', 'runtime']);
    expect(live()).toBe(b);
  });

  it('a runtime whose migration failed is never logged as deployed, nor retried', () => {
    push('v0 runtime', 'apps/runtime/x.ts');
    tick();
    const sha = push('a migration', 'apps/runtime/x.ts');
    flag('runtime-migrate');
    tick();
    expect(retry()).toBe(`${sha} runtime 0 0`);
    // install-runtime.sh now skips that sha and exits 0: still not deployed.
    flag('runtime-migrate', false);
    flag('runtime-skip');
    age(31);
    const t = tick();
    expect(t.ran).toEqual([]);
    expect(t.out).not.toContain('runtime deployed');
    expect(live()).not.toBe(sha);
  });

  it('a run cut short (a restart mid-deploy) leaves a retry behind', () => {
    const sha = push('v1');
    // The tick that pulled it died before it finished: HEAD moved, the retry file was written first.
    git(deployDir, 'fetch', '-q', 'origin', 'main');
    git(deployDir, 'reset', '-q', '--hard', 'origin/main');
    mkdirSync(state, { recursive: true });
    writeFileSync(retryFile(), `${sha} server 0 1\n`);
    expect(tick().out).toContain(`server deploy FAILED at ${sha} (retrying)`);
    age(31);
    const t = tick();
    expect(t.ran).toEqual(['server']);
    expect(t.out).toMatch(new RegExp(`deployed ${sha}$`, 'm'));
    expect(retry()).toBeNull();
  });
  it('a runtime that failed past its gate is held: unrelated pushes leave it alone, a runtime change tries again', () => {
    push('v0 runtime', 'apps/runtime/x.ts');
    tick();
    const p = live();
    for (const stage of ['runtime-migrate', 'runtime-health']) {
      push(`breaks at ${stage}`, 'apps/runtime/x.ts');
      flag(stage);
      expect(tick().ran).toEqual(['server', 'runtime']);
      flag(stage, false);
      // Two unrelated pushes: the server deploys, the runtime is not tried again.
      for (const f of ['docs.md', 'apps/console/index.html']) {
        push(`unrelated ${stage} ${f}`, f);
        const t = tick();
        expect(t.ran, `${stage} then ${f}`).toEqual(['server']);
      }
      expect(live()).toBe(p);
    }
    // The fix touches runtime code: deployed, and no longer held.
    const fix = push('the fix', 'apps/runtime/x.ts');
    expect(tick().ran).toEqual(['server', 'runtime']);
    expect(live()).toBe(fix);
    expect(existsSync(join(state, 'runtime-held'))).toBe(false);
    push('docs again', 'docs.md');
    expect(tick().ran).toEqual(['server']);
  });

  it('a change to what the runtime is built from (packages/core, the lockfile) deploys the runtime', () => {
    push('v0 runtime', 'apps/runtime/x.ts');
    tick();
    for (const f of ['packages/core/src/ollama.ts', 'pnpm-lock.yaml']) {
      const sha = push(`change ${f}`, f);
      expect(tick().ran, f).toEqual(['server', 'runtime']);
      expect(live()).toBe(sha);
    }
    push('policy', 'packages/persona/x.ts');
    expect(tick().ran).toEqual(['server']);
  });

  it('updates the app only once the server is live at the same commit', () => {
    const sha = push('v1');
    flag('server-gate');
    // The failing tick stops before the app; the ticks after it say why the app waits.
    let t = tick();
    expect(t.status).toBe(1);
    expect(t.app).toBe(false);
    t = tick();
    expect(t.app).toBe(false);
    expect(t.out).toContain(`app: waiting for the server to deploy ${sha}`);
    age(31);
    flag('server-gate', false);
    t = tick();
    expect(t.out).toMatch(new RegExp(`deployed ${sha}$`, 'm'));
    expect(t.app).toBe(true);
  });

  it('updates Flint Calendar only once the runtime is live with the commit, so a new wire format reaches the runtime first', () => {
    // No runtime live at all (its first deploy failed): the helper waits.
    flag('runtime-gate');
    const first = push('v1');
    let t = tick();
    expect(t.ran).toEqual(['server', 'runtime']);
    expect(live()).toBeNull();
    expect(t.calendar).toBe(false);
    expect(t.out).toContain(`calendar: waiting for the runtime to deploy ${first}`);
    flag('runtime-gate', false);
    push('v0 runtime', 'apps/runtime/x.ts');
    expect(tick().calendar).toBe(true);
    // A runtime change that fails its gate: the server and the app deploy, the helper waits for the runtime.
    const sha = push('a new wire format', 'apps/runtime/src/sources/apple/wire.ts');
    flag('runtime-gate');
    t = tick();
    expect(t.ran).toEqual(['server', 'runtime']);
    expect(t.app).toBe(true);
    expect(t.calendar).toBe(false);
    expect(t.out).toContain(`calendar: waiting for the runtime to deploy ${sha}`);
    expect(tick().calendar).toBe(false);
    // Retried and deployed: the helper follows on the same tick.
    age(31);
    flag('runtime-gate', false);
    t = tick();
    expect(t.out).toContain(`runtime deployed ${sha}`);
    expect(t.calendar).toBe(true);
  });

  it('a push that leaves the runtime alone still updates Flint Calendar; a held runtime holds it back', () => {
    push('v0 runtime', 'apps/runtime/x.ts');
    tick();
    // The runtime's release is older than this commit, but nothing it is built from changed.
    push('the helper', 'apps/desktop-calendar/FlintCalendar.swift');
    let t = tick();
    expect(t.ran).toEqual(['server']);
    expect(t.calendar).toBe(true);
    // A runtime that failed past its gate is held at the older release: the helper waits, even for unrelated pushes.
    push('a bad migration', 'apps/runtime/x.ts');
    flag('runtime-migrate');
    expect(tick().calendar).toBe(false);
    flag('runtime-migrate', false);
    const docs = push('docs', 'docs.md');
    t = tick();
    expect(t.ran).toEqual(['server']);
    expect(t.calendar).toBe(false);
    expect(t.out).toContain(`calendar: waiting for the runtime to deploy ${docs}`);
    // The fix deploys the runtime, and the helper with it.
    push('the fix', 'apps/runtime/x.ts');
    t = tick();
    expect(t.ran).toEqual(['server', 'runtime']);
    expect(t.calendar).toBe(true);
  });

  it('a retry file without a final newline never stops the deploys', () => {
    const sha = push('v1');
    flag('server-gate');
    tick();
    writeFileSync(retryFile(), `${sha} server 0 1`);
    age(31);
    flag('server-gate', false);
    const t = tick();
    expect(t.status).toBe(0);
    expect(t.out).toMatch(new RegExp(`deployed ${sha}$`, 'm'));
  });
  it('a held runtime is released only by a change to its own code, not to shared code or the lockfile', () => {
    push('v0 runtime', 'apps/runtime/x.ts');
    tick();
    push('a bad migration', 'apps/runtime/x.ts');
    flag('runtime-migrate');
    tick();
    flag('runtime-migrate', false);
    for (const f of ['packages/core/src/provider/anthropic.ts', 'pnpm-lock.yaml']) {
      push(`server-side change ${f}`, f);
      expect(tick().ran, f).toEqual(['server']);
    }
    const fix = push('the migration fix', 'apps/runtime/prisma/x.sql');
    expect(tick().ran).toEqual(['server', 'runtime']);
    expect(live()).toBe(fix);
  });

  it('a runtime deployed by hand clears the hold', () => {
    push('v0 runtime', 'apps/runtime/x.ts');
    tick();
    push('crashes on boot', 'apps/runtime/x.ts');
    flag('runtime-health');
    tick();
    flag('runtime-health', false);
    expect(existsSync(join(state, 'runtime-held'))).toBe(true);
    // Will deploys a runtime by hand from another clone: a release this checkout does not know.
    const other = 'e'.repeat(40);
    mkdirSync(join(runtimeDir, 'releases', other), { recursive: true });
    spawnSync('ln', ['-sfn', join(runtimeDir, 'releases', other), join(runtimeDir, 'current')]);
    const next = push('docs', 'docs.md');
    const t = tick();
    expect(existsSync(join(state, 'runtime-held'))).toBe(false);
    // Main's runtime comes back at the next push, as without a hold.
    expect(t.ran).toEqual(['server', 'runtime']);
    expect(live()).toBe(next);
  });

  it('a server that failed at its gate under a run that left no retry (the old script, on the merge tick) is retried', () => {
    const sha = push('v1');
    // The old script deployed it and failed at the gate, writing only the event.
    git(deployDir, 'fetch', '-q', 'origin', 'main');
    git(deployDir, 'reset', '-q', '--hard', 'origin/main');
    writeFileSync(events, `{"id":"x","at":"2026-10-05T00:00:00Z","component":"server","stage":"gate","outcome":"failed","sha":"${sha}"}\n`, { flag: 'a' });
    let t = tick();
    expect(t.out).toContain(`server deploy FAILED at ${sha} (retrying)`);
    expect(t.out).not.toContain('up to date');
    expect(t.app).toBe(false);
    expect(retry()).toBe(`${sha} server 0 1`);
    age(31);
    t = tick();
    expect(t.out).toMatch(new RegExp(`deployed ${sha}$`, 'm'));
    expect(t.app).toBe(true);
  });
});


describe('update_app.sh installs while Flint.app is open', () => {
  let repo: string, dest: string, state: string, bin: string, said: string, built: string;
  let fake: ChildProcess | undefined;

  beforeEach(() => {
    repo = join(tmp, 'repo');
    dest = join(tmp, 'Applications', 'Flint-test.app');
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
    // The app "running": a process whose command line reads as the installed binary.
    // Only its name: no bundle is made on disk and nothing is copied into one, since
    // macOS kills a system binary run from inside an app bundle and then tells Will
    // that "Flint" is damaged.
    fake = spawn('/bin/sleep', ['30'], { argv0: join(dest, 'Contents', 'MacOS', 'flint'), stdio: 'ignore' });
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
    // The open app wrote its pid at launch: it restarts itself onto a new build.
    writeFileSync(join(state, 'app-pid'), `${fake!.pid}\n`);
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

  it('tells Will to reopen an open app from before self-restart, instead of promising a restart', () => {
    mkdirSync(state, { recursive: true });
    const u = update();
    expect(u.built).toHaveLength(1);
    expect(u.out).toContain('the open app is older and updates when reopened');
    expect(u.said).toContain('Flint updated. Quit and reopen it once to finish.');
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

describe('Flint.app restarts onto a new build without ever leaving none running', () => {
  const swift = readFileSync(join(REPO, 'apps', 'desktop-mac', 'flint.swift'), 'utf8');
  const relaunch = swift.slice(swift.indexOf('func relaunch(front: Bool)'), swift.indexOf('func buildMenu()'));

  it('quits only after another instance is up and has finished launching', () => {
    expect(relaunch).not.toMatch(/if app != nil \{ NSApp\.terminate/);
    const wait = relaunch.slice(relaunch.indexOf('func waitForNewInstance'));
    expect(wait.indexOf('isFinishedLaunching')).toBeGreaterThan(0);
    expect(wait.indexOf('NSApp.terminate(nil)')).toBeGreaterThan(wait.indexOf('isFinishedLaunching'));
    expect(relaunch.match(/NSApp\.terminate\(nil\)/g)).toHaveLength(1);
    // The instance Launch Services hands back must be another one.
    expect(relaunch).toContain('app.processIdentifier != me');
  });

  it('falls back to open -n, then stays on its build and tries again later, logging each step', () => {
    expect(relaunch).toContain('p.arguments = ["-n", Bundle.main.bundlePath]');
    expect(relaunch).toContain('nextRelaunch = Date().addingTimeInterval(30 * 60)');
    expect(relaunch).toContain('.flint/app-update.log');
  });
});

describe("install-server.sh requires Flint Calendar's Swift checks only when the helper or its wire changed", () => {
  const SERVER = readFileSync(join(REPO, 'apps', 'server', 'install-server.sh'), 'utf8');
  /** CALENDAR_PATHS and calendar_changed, exactly as install-server.sh has them. */
  const fn = SERVER.slice(SERVER.indexOf('CALENDAR_PATHS='), SERVER.indexOf('\n}\n', SERVER.indexOf('calendar_changed() {')) + 3);
  let repo: string, data: string;
  const commit = (msg: string, path: string) => {
    mkdirSync(join(repo, path, '..'), { recursive: true });
    writeFileSync(join(repo, path), `${msg}\n`);
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', msg);
    return git(repo, 'rev-parse', 'HEAD');
  };
  /** A finished (or failed) server deploy of `sha`, as deploy_event writes it. */
  const deployed = (sha: string, outcome = 'ok', stage = 'deploy') =>
    writeFileSync(join(data, 'deploy-events.jsonl'), `{"id":"x","at":"2026-10-06T00:00:00Z","component":"server","stage":"${stage}","outcome":"${outcome}","sha":"${sha}"}\n`, { flag: 'a' });
  /** true when the Swift checks must run. */
  const needed = () => {
    const r = spawnSync('/bin/zsh', ['-f', '-c', `set -e\nREPO=${JSON.stringify(repo)}\nDATA=${JSON.stringify(data)}\n${fn}\nif calendar_changed; then echo needed; else echo skipped; fi`], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    return r.stdout.trim() === 'needed';
  };

  beforeEach(() => {
    repo = join(tmp, 'repo');
    data = join(tmp, 'data');
    mkdirSync(data, { recursive: true });
    git(tmp, 'init', '-q', '-b', 'main', repo);
  });

  it('the gate passes FLINT_REQUIRE_SWIFT=1 or =0 from calendar_changed, never 1 on every deploy', () => {
    expect(fn).toMatch(/^CALENDAR_PATHS='[^\n]+'\ncalendar_changed\(\) \{[\s\S]+\n\}\n$/);
    expect(SERVER).toContain('if calendar_changed; then\n    SWIFT_CHECKS=1;');
    expect(SERVER).toContain('FLINT_REQUIRE_SWIFT=$SWIFT_CHECKS pnpm --filter server test');
    expect(SERVER).not.toContain('FLINT_REQUIRE_SWIFT=1 pnpm');
  });

  it('skips them for a deploy that leaves the helper and its wire alone, and requires them for one that changes either', () => {
    const base = commit('v0', 'README.md');
    deployed(base);
    commit('docs', 'docs/x.md');
    commit('server', 'apps/server/src/x.ts');
    commit('runtime elsewhere', 'apps/runtime/src/sources/google/x.ts');
    expect(needed()).toBe(false);
    for (const path of ['apps/desktop-calendar/FlintCalendar.swift', 'apps/runtime/src/sources/apple/wire.ts', 'apps/runtime/src/routes/apple-calendar.ts',
      'apps/runtime/test/fixtures/apple-calendar-snapshot.json', 'apps/server/test/desktop-calendar.test.ts']) {
      const sha = commit(`change ${path}`, path);
      expect(needed(), path).toBe(true);
      // Once a server deploy of it finished, the next unrelated push skips them again.
      deployed(sha);
      commit(`after ${path}`, 'docs/y.md');
      expect(needed(), path).toBe(false);
    }
  });

  it('a failed deploy is not a finished one: the change stays pending until a deploy of it finishes', () => {
    deployed(commit('v0', 'README.md'));
    const helper = commit('helper', 'apps/desktop-calendar/FlintCalendar.swift');
    deployed(helper, 'failed', 'gate');
    commit('docs', 'docs/x.md');
    expect(needed()).toBe(true);
  });

  it('requires them when the last finished deploy is unknown: no events, an unknown commit, or a change not committed yet', () => {
    commit('v0', 'README.md');
    expect(needed()).toBe(true);
    deployed('f'.repeat(40));
    expect(needed()).toBe(true);
    writeFileSync(join(data, 'deploy-events.jsonl'), '');
    deployed(git(repo, 'rev-parse', 'HEAD'));
    expect(needed()).toBe(false);
    // A deploy by hand from a checkout with an uncommitted change to the helper.
    commit('helper', 'apps/desktop-calendar/x.swift');
    deployed(git(repo, 'rev-parse', 'HEAD'));
    writeFileSync(join(repo, 'apps/desktop-calendar/x.swift'), 'changed\n');
    expect(needed()).toBe(true);
  });
});
