/**
 * install-server.sh writes down which version each kept bundle is: one line,
 * "<commit> <when it was installed, in seconds>", in server.version for
 * server.mjs and in server.version.prev for server.mjs.prev.
 *
 * Review of the recovery PR: server.mjs.prev is only "whatever ran before the
 * last install". Once a revert has been installed, that is the broken build,
 * and rollback.sh put it back and called it "the version from before its last
 * update". With these lines rollback.sh names both versions and their ages
 * before it does anything (apps/studio/test/rollback.test.sh), and
 * auto_deploy.sh can tell that what is installed is not main's newest commit
 * (test/auto-update.test.ts).
 *
 * The function is run exactly as the script has it, on a scratch data folder.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = readFileSync(join(__dirname, '..', 'install-server.sh'), 'utf8');
const start = SCRIPT.indexOf('server_version() {');
/** server_version exactly as install-server.sh has it. */
const FN = SCRIPT.slice(start, SCRIPT.indexOf('\n}\n', start) + 3);
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

let data: string;
beforeEach(() => {
  data = mkdtempSync(join(tmpdir(), 'install-versions-'));
});
afterEach(() => rmSync(data, { recursive: true, force: true }));

/** Runs the function under the script's own options (set -e), so a step that fails would end the install here too. */
const run = (...calls: string[]) => {
  const r = spawnSync('/bin/zsh', ['-f', '-c', `set -e\nDATA=${JSON.stringify(data)}\n${FN}\n${calls.join('\n')}\necho END`], { encoding: 'utf8' });
  expect(r.stdout + r.stderr).toBe('END\n');
  return r;
};
const read = (name: string) => (existsSync(join(data, name)) ? readFileSync(join(data, name), 'utf8') : null);
const mode = (name: string) => statSync(join(data, name)).mode & 0o777;
const event = (sha: string, at: string, stage = 'deploy', outcome = 'ok') =>
  writeFileSync(join(data, 'deploy-events.jsonl'), `{"id":"x","at":"${at}","component":"server","stage":"${stage}","outcome":"${outcome}","sha":"${sha}"}\n`, { flag: 'a' });
const iso = (s: number) => new Date(s * 1000).toISOString().replace(/\.\d+Z$/, 'Z');

describe('install-server.sh keeps each bundle’s version beside it', () => {
  it('the script calls it where each bundle moves: kept, written, and put back', () => {
    expect(FN).toMatch(/^server_version\(\) \{[\s\S]+\n\}\n$/);
    // The bundle that was running becomes .prev, and so does its line; with no bundle, a line here is another Mac's.
    expect(SCRIPT).toContain('  cp -p "$DATA/server.mjs" "$DATA/server.mjs.prev"\n  server_version keep\nelse\n  rm -f "$DATA/server.version" "$DATA/server.version.prev"');
    // The new bundle's line is written as soon as the bundle is, before anything is restarted.
    expect(SCRIPT).toMatch(/--outfile="\$DATA\/server\.mjs"\nserver_version set "\$SHA"\n/);
    expect(SCRIPT.indexOf('server_version set "$SHA"')).toBeLessThan(SCRIPT.indexOf('echo "reloading com.flint.server..."'));
    // A new bundle that does not come up: the previous one goes back, and its line with it.
    const failed = SCRIPT.slice(SCRIPT.indexOf('if [ "$up" != 1 ]; then'));
    expect(failed).toContain('    cp -p "$DATA/server.mjs.prev" "$DATA/server.mjs"\n    server_version back\n');
    expect(SCRIPT.match(/server_version (keep|set|back)\b/g)).toHaveLength(3);
  });

  it('set: the new bundle is this commit, installed now, in a file that is its owner’s alone', () => {
    const before = Math.floor(Date.now() / 1000);
    run(`server_version set ${A}`);
    const [sha, at, ...rest] = read('server.version')!.trim().split(' ');
    expect(sha).toBe(A);
    expect(Number(at)).toBeGreaterThanOrEqual(before);
    expect(Number(at)).toBeLessThanOrEqual(before + 60);
    expect(rest).toEqual([]);
    expect(mode('server.version')).toBe(0o600);
  });

  it('set: with no commit to name (not a git checkout), no line is left to mislead', () => {
    writeFileSync(join(data, 'server.version'), `${A} 1760000000\n`);
    run('server_version set ""');
    expect(read('server.version')).toBeNull();
    writeFileSync(join(data, 'server.version'), `${A} 1760000000\n`);
    run('server_version set "not-a-commit; rm -rf x"');
    expect(read('server.version')).toBeNull();
  });

  it('keep, then set: the line of the bundle that was running becomes the line of the one kept', () => {
    writeFileSync(join(data, 'server.mjs'), 'bundle a');
    writeFileSync(join(data, 'server.version'), `${A} 1760000000\n`, { mode: 0o644 });
    run('server_version keep', `server_version set ${B}`);
    expect(read('server.version.prev')).toBe(`${A} 1760000000\n`);
    expect(mode('server.version.prev')).toBe(0o600);
    expect(read('server.version')).toMatch(new RegExp(`^${B} \\d{10}\\n$`));
  });

  it('back: the kept bundle’s line comes back with it; with none kept, none is left', () => {
    writeFileSync(join(data, 'server.version'), `${B} 1760000500\n`);
    writeFileSync(join(data, 'server.version.prev'), `${A} 1760000000\n`);
    run('server_version back');
    expect(read('server.version')).toBe(`${A} 1760000000\n`);
    rmSync(join(data, 'server.version.prev'));
    run('server_version back');
    expect(read('server.version')).toBeNull();
  });

  describe('a bundle from before the lines were kept (the first deploy of this change)', () => {
    const bundleMadeAt = (s: number) => {
      writeFileSync(join(data, 'server.mjs'), 'an older bundle');
      utimesSync(join(data, 'server.mjs'), s, s);
    };

    it('is the last server deploy that finished, when that deploy ended within minutes of the bundle being written', () => {
      bundleMadeAt(1760000000);
      event(B, iso(1759990000));
      event(A, iso(1760000040));
      event(B, iso(1760000300), 'gate', 'failed'); // a later deploy that never replaced the bundle
      run('server_version keep');
      // Dated by the bundle itself: when it was written is when it was installed.
      expect(read('server.version.prev')).toBe(`${A} 1760000000\n`);
    });

    it('is left unnamed when the last finished deploy is not the one that made it, or nothing says', () => {
      // The last finished deploy was hours after this bundle was written: something else put the bundle here (a rollback).
      bundleMadeAt(1760000000);
      event(A, iso(1760009000));
      writeFileSync(join(data, 'server.version.prev'), `${B} 1750000000\n`);
      run('server_version keep');
      expect(read('server.version.prev')).toBeNull();
      // ...or long before it.
      bundleMadeAt(1760009000 + 3600);
      run('server_version keep');
      expect(read('server.version.prev')).toBeNull();
      // No events at all, and a line that is not one.
      rmSync(join(data, 'deploy-events.jsonl'));
      writeFileSync(join(data, 'server.version'), 'something else\n');
      run('server_version keep');
      expect(read('server.version.prev')).toBeNull();
    });
  });

  it('nothing it does can fail the install: a data folder it cannot write to changes nothing and returns', () => {
    const r = spawnSync('/bin/zsh', ['-f', '-c', `set -e\nDATA=${JSON.stringify(join(data, 'missing'))}\n${FN}\nserver_version keep\nserver_version set ${A}\nserver_version back\necho END`], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('END\n');
    expect(existsSync(join(data, 'missing'))).toBe(false);
  });
});
