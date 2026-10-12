/**
 * The rebuild rehearsal in the deploy gate, and on a weekly timer.
 *
 * Review of the recovery PR: the gate ran every apps/studio/test/*.test.sh on
 * every deploy, and the rehearsal (about 45 s) more than doubled it, for a
 * docs-only merge too. Now install-server.sh:
 *  - runs it only when the deploy changes something a rebuild is made of since
 *    the last server deploy that finished, when that deploy is unknown, or when
 *    FLINT_REHEARSE=1 asks for it (rehearsal_changed, as calendar_changed
 *    decides for the Swift checks);
 *  - runs it through apps/studio/run_rehearsal.sh with FLINT_REQUIRE_REHEARSAL=1,
 *    so a missing tool fails it instead of skipping it, and its result is kept
 *    for Settings > Health;
 *  - keeps a LaunchAgent that runs the same script every Sunday, so a rebuild
 *    that stopped working for a reason no deploy shows is still found.
 * Everything runs in scratch repos and folders, with a stand-in for launchctl:
 * nothing is loaded into launchd and nothing touches ~/.flint.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = join(__dirname, '..', '..', '..');
const SERVER = readFileSync(join(REPO, 'apps', 'server', 'install-server.sh'), 'utf8');
const sliceFn = (from: string, name: string) => SERVER.slice(SERVER.indexOf(from), SERVER.indexOf('\n}\n', SERVER.indexOf(`${name}() {`)) + 3);
/** REHEARSAL_PATHS and rehearsal_changed, exactly as install-server.sh has them. */
const CHANGED = sliceFn('REHEARSAL_PATHS=', 'rehearsal_changed');
/** REHEARSAL_LABEL and install_rehearsal_agent, exactly as install-server.sh has them. */
const AGENT = sliceFn('REHEARSAL_LABEL=', 'install_rehearsal_agent');

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'install-rehearsal-'));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe('install-server.sh runs the rebuild rehearsal only when a deploy changes what a rebuild is made of', () => {
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
    writeFileSync(join(data, 'deploy-events.jsonl'), `{"id":"x","at":"2026-10-12T00:00:00Z","component":"server","stage":"${stage}","outcome":"${outcome}","sha":"${sha}"}\n`, { flag: 'a' });
  /** true when the rehearsal must run. */
  const needed = () => {
    const r = spawnSync('/bin/zsh', ['-f', '-c', `set -e\nREPO=${JSON.stringify(repo)}\nDATA=${JSON.stringify(data)}\n${CHANGED}\nif rehearsal_changed; then echo needed; else echo skipped; fi`], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    return r.stdout.trim() === 'needed';
  };

  beforeEach(() => {
    repo = join(tmp, 'repo');
    data = join(tmp, 'data');
    mkdirSync(data, { recursive: true });
    git(tmp, 'init', '-q', '-b', 'main', repo);
  });

  it('the gate runs every other studio test always, and the rehearsal through its runner, required, only when it is needed', () => {
    expect(CHANGED).toMatch(/^REHEARSAL_PATHS='[^\n]+'\nrehearsal_changed\(\) \{[\s\S]+\n\}\n$/);
    const gate = SERVER.slice(SERVER.indexOf('for t in "$REPO"/apps/studio/test/*.test.sh(N); do'), SERVER.indexOf('DEPLOY_STAGE=\n'));
    // The loop still runs every studio test but the rehearsal itself.
    expect(gate).toContain('[ "${t:t}" = rebuild_rehearse.test.sh ] && continue');
    expect(gate).toContain('zsh "$t" || { echo "✗ $t failed — NOT deploying"; exit 1; }');
    // Asked for by hand, or decided by what changed: never on every deploy.
    expect(gate).toContain('if [ "${FLINT_REHEARSE:-0}" = "1" ]; then\n    REHEARSE=1;');
    expect(gate).toContain('elif rehearsal_changed; then\n    REHEARSE=1;');
    expect(gate).toContain('else\n    REHEARSE=0;');
    // It must really run (never a skip that reads as a pass), and a failure stops the deploy.
    expect(gate).toContain('if [ "$REHEARSE" = 1 ]; then\n    FLINT_REQUIRE_REHEARSAL=1 zsh "$REPO/apps/studio/run_rehearsal.sh" || { echo "✗ the rebuild rehearsal failed — NOT deploying"; exit 1; }');
    expect(SERVER.match(/run_rehearsal\.sh" \|\|/g)).toHaveLength(1);
    // Both scripts it names are in the repo.
    expect(existsSync(join(REPO, 'apps', 'studio', 'run_rehearsal.sh'))).toBe(true);
    expect(existsSync(join(REPO, 'apps', 'studio', 'test', 'rebuild_rehearse.test.sh'))).toBe(true);
  });

  it('skips it for a deploy that touches nothing a rebuild is made of', () => {
    deployed(commit('v0', 'README.md'));
    for (const path of ['docs/ARCHITECTURE.md', 'README.md', 'apps/server/src/router.ts', 'apps/server/test/router.test.ts', 'apps/console/index.html', 'apps/runtime/src/triage/triage.ts',
      'apps/runtime/src/sources/github.ts', 'apps/runtime/test/backup.test.ts', 'packages/policy/src/notes.ts', 'packages/core/src/index.ts', 'packages/mcp/src/gate.ts', 'apps/desktop-mac/Flint.swift',
      'apps/server/package.json', 'apps/runtime/scripts/other.ts', 'docs/RECOVERY.md.bak', 'apps/server/src/internal.test.ts']) {
      commit(`change ${path}`, path);
      expect(needed(), path).toBe(false);
    }
  });

  it('requires it for a change to the rebuild, the backups, the installers, the database, the settings a rebuild reads, or the dependencies', () => {
    deployed(commit('v0', 'README.md'));
    for (const path of ['apps/studio/rebuild.sh', 'apps/studio/settings.manifest', 'apps/studio/test/rebuild_rehearse.test.sh', 'apps/studio/rehearsal/launchctl', 'docs/RECOVERY.md',
      'apps/runtime/src/backup/restore.ts', 'apps/runtime/src/cli.ts', 'apps/runtime/src/config.ts', 'apps/runtime/scripts/bootstrap-db.ts', 'apps/runtime/prisma/migrations/20261012000000_x/migration.sql',
      'apps/runtime/prisma/schema.prisma', 'apps/runtime/install-runtime.sh', 'apps/runtime/package.json', 'apps/server/install-server.sh', 'apps/server/auto_deploy.sh', 'apps/server/src/internal.ts',
      'apps/server/src/access.ts', 'apps/server/src/mcp-config.ts', 'apps/server/com.flint.deploy.plist', 'apps/evolve/com.flint.evolve.plist', 'packages/policy/src/tiers.ts', 'packages/policy/src/selfmod-paths.ts',
      'packages/mcp/connectors/web-server.ts', 'test-support/quiet-bin/osascript', 'pnpm-lock.yaml', 'package.json', 'pnpm-workspace.yaml']) {
      const sha = commit(`change ${path}`, path);
      expect(needed(), path).toBe(true);
      // Once a server deploy of it finished, the next unrelated push skips it again.
      deployed(sha);
      commit(`after ${path}`, 'docs/notes.md');
      expect(needed(), path).toBe(false);
    }
  });

  it('a failed deploy is not a finished one: the change stays pending until a deploy of it finishes', () => {
    deployed(commit('v0', 'README.md'));
    const change = commit('the rebuild', 'apps/studio/rebuild.sh');
    deployed(change, 'failed', 'gate');
    commit('docs', 'docs/x.md');
    expect(needed()).toBe(true);
    deployed(git(repo, 'rev-parse', 'HEAD'));
    expect(needed()).toBe(false);
  });

  it('requires it when the last finished deploy is unknown: no events, an unknown commit, or a change not committed yet', () => {
    commit('v0', 'README.md');
    expect(needed()).toBe(true);
    deployed('f'.repeat(40));
    expect(needed()).toBe(true);
    writeFileSync(join(data, 'deploy-events.jsonl'), '');
    deployed(git(repo, 'rev-parse', 'HEAD'));
    expect(needed()).toBe(false);
    // A deploy by hand from a checkout with an uncommitted change to the rebuild.
    commit('the rebuild', 'apps/studio/rebuild.sh');
    deployed(git(repo, 'rev-parse', 'HEAD'));
    writeFileSync(join(repo, 'apps/studio/rebuild.sh'), 'changed\n');
    expect(needed()).toBe(true);
  });
});

describe('install-server.sh keeps the weekly rebuild rehearsal installed', () => {
  let agents: string, calls: string;
  /** launchctl, faked: records each call; `print` succeeds once something was bootstrapped. */
  const install = (path = `${join(tmp, 'bin')}:${join(tmp, 'node', 'bin')}:${join(tmp, 'pnpm', 'bin')}:/usr/bin:/bin`, repo = '/Users/someone/flint', home = '/Users/someone') =>
    spawnSync('/bin/zsh', ['-f', '-c', `set -e\nAGENTS=${JSON.stringify(agents)}\nDATA=${JSON.stringify(`${home}/.flint`)}\nREPO=${JSON.stringify(repo)}\n${AGENT}\ninstall_rehearsal_agent || echo FAILED\necho END`], { encoding: 'utf8', env: { PATH: path, HOME: home } });
  const plistPath = () => join(agents, 'com.flint.rebuild-rehearsal.plist');
  const value = (key: string) => spawnSync('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plistPath()], { encoding: 'utf8' });

  beforeEach(() => {
    agents = join(tmp, 'agents');
    calls = join(tmp, 'calls');
    mkdirSync(agents);
    for (const dir of ['bin', 'node/bin', 'pnpm/bin']) mkdirSync(join(tmp, dir), { recursive: true });
    writeFileSync(join(tmp, 'bin', 'launchctl'), `#!/bin/zsh\necho "$*" >> ${calls}\n[ "$1" = bootstrap ] && touch ${tmp}/loaded\n[ "$1" = print ] && { [ -f ${tmp}/loaded ] || exit 113; }\nexit 0\n`, { mode: 0o755 });
    writeFileSync(join(tmp, 'bin', 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    writeFileSync(join(tmp, 'node', 'bin', 'node'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    writeFileSync(join(tmp, 'pnpm', 'bin', 'pnpm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  });

  it('is installed once the new server answers, and a failure to load it never fails the deploy', () => {
    expect(AGENT).toMatch(/^REHEARSAL_LABEL="com\.flint\.rebuild-rehearsal"\ninstall_rehearsal_agent\(\) \{[\s\S]+\n\}\n$/);
    expect(SERVER).toContain('deploy_event server deploy ok "$SHA"\ninstall_rehearsal_agent || echo "✗ the weekly rebuild rehearsal agent could not be (re)loaded (the server itself is up)" >&2\n');
    expect(SERVER.match(/^install_rehearsal_agent /gm)).toHaveLength(1);
    // The rebuild's stand-in for launchctl answers these calls by its bare name; the script sets no PATH of its own.
    expect(AGENT).not.toMatch(/(\/bin|\/usr\/bin)\/launchctl/);
    expect(SERVER).not.toMatch(/^\s*(export\s+)?PATH=/m);
  });

  it('writes a valid LaunchAgent, 0600: this checkout’s runner, every Sunday at 05:10, on a timer only', () => {
    const r = install();
    expect(r.stdout).toBe('weekly rebuild rehearsal agent loaded (Sundays 05:10)\nEND\n');
    expect(spawnSync('/usr/bin/plutil', ['-lint', plistPath()]).status).toBe(0);
    expect(statSync(plistPath()).mode & 0o777).toBe(0o600);
    expect(value('Label').stdout.trim()).toBe('com.flint.rebuild-rehearsal');
    expect([value('ProgramArguments.0').stdout.trim(), value('ProgramArguments.1').stdout.trim()]).toEqual(['/bin/zsh', '/Users/someone/flint/apps/studio/run_rehearsal.sh']);
    expect(value('ProgramArguments.2').status).not.toBe(0);
    expect(['Weekday', 'Hour', 'Minute'].map((k) => value(`StartCalendarInterval.${k}`).stdout.trim())).toEqual(['0', '5', '10']);
    // Loading it starts nothing, in launchd or in a rebuild rehearsal (whose stand-in runs only RunAtLoad and KeepAlive jobs).
    expect(value('RunAtLoad').status).not.toBe(0);
    expect(value('KeepAlive').status).not.toBe(0);
    // Its PATH has this Mac's node and pnpm first; its one setting is that PATH; no secret, and nothing of the server's.
    expect(value('EnvironmentVariables.PATH').stdout.trim()).toBe(`${join(tmp, 'node', 'bin')}:${join(tmp, 'pnpm', 'bin')}:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`);
    const plist = readFileSync(plistPath(), 'utf8');
    expect(plist.match(/<key>[A-Z_]+<\/key>/g)).toEqual(['<key>PATH</key>']);
    expect(plist).not.toMatch(/TOKEN|SECRET|KEY<|password|postgres/i);
    // Its output goes to logs in the data folder, as every other agent's does.
    expect([value('StandardOutPath').stdout.trim(), value('StandardErrorPath').stdout.trim()]).toEqual(['/Users/someone/.flint/rehearsal.out.log', '/Users/someone/.flint/rehearsal.err.log']);
    // Loaded the way the runtime's installer loads its backup agent: out (if it was in), wait until it is gone, in.
    expect(readFileSync(calls, 'utf8')).toMatch(/^bootout gui\/\d+\/com\.flint\.rebuild-rehearsal\nprint gui\/\d+\/com\.flint\.rebuild-rehearsal\nbootstrap gui\/\d+ .*\/agents\/com\.flint\.rebuild-rehearsal\.plist\n$/);
  });

  it('is reloaded only when its file changes', () => {
    install();
    const first = readFileSync(calls, 'utf8');
    const again = install();
    expect(again.stdout).toBe('END\n');
    expect(readFileSync(calls, 'utf8').replace(first, '')).not.toMatch(/bootstrap|bootout/);
    expect(existsSync(`${plistPath()}.new`)).toBe(false);
    // A checkout somewhere else: a new file, loaded again.
    install(undefined, '/Users/someone/other');
    expect(readFileSync(calls, 'utf8').replace(first, '')).toMatch(/bootout gui\/\d+\/com\.flint\.rebuild-rehearsal\n[\s\S]*bootstrap gui\/\d+ /);
    expect(value('ProgramArguments.1').stdout.trim()).toBe('/Users/someone/other/apps/studio/run_rehearsal.sh');
  });

  it('writes and loads nothing when node or pnpm is not there, or when a path would not fit in a LaunchAgent file', () => {
    const noPnpm = install(`${join(tmp, 'bin')}:${join(tmp, 'node', 'bin')}:/usr/bin:/bin`);
    expect(noPnpm.stdout).toBe('FAILED\nEND\n');
    expect(existsSync(plistPath())).toBe(false);
    const unsafe = install(undefined, '/Users/someone/a<b&c');
    expect(unsafe.stdout).toBe('FAILED\nEND\n');
    expect(existsSync(plistPath())).toBe(false);
    expect(existsSync(`${plistPath()}.new`)).toBe(false);
    expect(existsSync(calls)).toBe(false);
  });

  it('is listed in agents.manifest as an agent the server’s installer writes and loads', () => {
    const manifest = readFileSync(join(REPO, 'apps', 'studio', 'agents.manifest'), 'utf8');
    expect(manifest).toMatch(/^com\.flint\.rebuild-rehearsal\s+installer\s+apps\/server\/install-server\.sh\s+installer$/m);
  });
});
