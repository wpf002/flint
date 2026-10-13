import { describe, it, expect, afterEach } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModeNotSaved, ModeStore, SAVED_MODE_MAX_BYTES, type ModeStoreOptions } from '../src/inference-mode';

/** The mode: the environment's until Will sets one, then his, across restarts. */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      chmodSync(d, 0o700);
    } catch {
      /* gone */
    }
    rmSync(d, { recursive: true, force: true });
  }
});

function store(over: Partial<ModeStoreOptions> = {}, file?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'flint-mode-'));
  dirs.push(dir);
  const lines: string[] = [];
  const opts: ModeStoreOptions = { file: file ?? join(dir, 'inference.json'), envMode: 'cloud', envSource: 'default', log: (m) => lines.push(m), now: () => new Date('2026-10-12T15:00:00.000Z'), ...over };
  return { store: new ModeStore(opts), lines, opts, dir };
}

describe('ModeStore', () => {
  it("with nothing saved, the mode is the environment's", () => {
    expect(store().store.current()).toBe('cloud');
    expect(store().store.source()).toBe('default');
    const hybrid = store({ envMode: 'hybrid', envSource: 'env' });
    expect(hybrid.store.current()).toBe('hybrid');
    expect(hybrid.store.source()).toBe('env');
    expect(hybrid.lines).toEqual(['[inference] mode=hybrid (env)']);
  });

  it('an invalid env value runs as local, and the boot line says why', () => {
    const s = store({ envMode: 'local', envSource: 'invalid_env' });
    expect(s.store.current()).toBe('local');
    expect(s.store.source()).toBe('invalid_env');
    expect(s.lines).toEqual(['[inference] mode=local (the env value is invalid, so local)']);
  });

  it('a mode Will sets wins over the environment, and says so', () => {
    const s = store({ envMode: 'cloud', envSource: 'env' });
    expect(s.store.set('local', 'console')).toBe('cloud');
    expect(s.store.current()).toBe('local');
    expect(s.store.source()).toBe('settings');
    expect(s.lines.at(-1)).toBe('[inference] mode cloud -> local (console)');
  });

  it('it survives a restart: a new store reads the saved mode', () => {
    const first = store({ envMode: 'cloud', envSource: 'env' });
    first.store.set('hybrid', 'cli');
    const lines: string[] = [];
    const again = new ModeStore({ ...first.opts, log: (m) => lines.push(m) });
    expect(again.current()).toBe('hybrid');
    expect(again.source()).toBe('settings');
    expect(lines).toEqual(['[inference] mode=hybrid (saved in Settings; env says cloud)']);
  });

  it('the file holds the mode and when it was set, is private (0600), and nothing else is left behind', () => {
    const s = store();
    s.store.set('local', 'console');
    expect(JSON.parse(readFileSync(s.opts.file, 'utf8'))).toEqual({ version: 1, mode: 'local', setAt: '2026-10-12T15:00:00.000Z', setBy: 'console' });
    expect(statSync(s.opts.file).mode & 0o777).toBe(0o600);
    expect(existsSync(`${s.opts.file}.${process.pid}.tmp`)).toBe(false);
  });

  it('reset forgets the saved mode: back to the environment', () => {
    const s = store({ envMode: 'cloud', envSource: 'env' });
    s.store.set('local', 'console');
    expect(s.store.reset()).toBe('local');
    expect(s.store.current()).toBe('cloud');
    expect(s.store.source()).toBe('env');
    expect(existsSync(s.opts.file)).toBe(false);
    expect(new ModeStore(s.opts).current()).toBe('cloud');
  });

  // The routing review's B1: Will had saved Local, the file was cut short, and at the next restart Flint
  // read the environment instead (unset: cloud) and sent a plain turn to the cloud. A saved file that is
  // there and cannot be read means Will chose something Flint no longer knows: it runs as LOCAL.
  const DAMAGED: Array<[string, string]> = [
    ['cut short', '{"version":1,"mode":"loc'],
    ['empty', ''],
    ['not JSON', 'not json SECRET'],
    ['garbage', 'garbage'],
    ['an array', '[]'],
    ['an extra field', '{"version":1,"mode":"local","setAt":"2026-10-12T15:00:00.000Z","setBy":"console","note":"SECRET"}'],
    ['another version', '{"version":2,"mode":"local","setAt":"2026-10-12T15:00:00.000Z","setBy":"console"}'],
    ['a mode it does not know', '{"version":1,"mode":"SECRET","setAt":"2026-10-12T15:00:00.000Z","setBy":"console"}'],
    ['a mode in another case', '{"version":1,"mode":"Local","setAt":"2026-10-12T15:00:00.000Z","setBy":"console"}'],
    ['a time with an offset', '{"version":1,"mode":"local","setAt":"2026-10-12T10:00:00-05:00","setBy":"console"}'],
    ['a saved cloud that fails the schema', '{"version":1,"mode":"cloud","setAt":"yesterday","setBy":"console"}'],
  ];

  it('a saved file that is there and cannot be read runs as LOCAL, whatever the environment says, and its content is never logged', () => {
    for (const [what, bad] of DAMAGED) {
      for (const [envMode, envSource] of [['cloud', 'default'], ['hybrid', 'env'], ['cloud', 'env'], ['local', 'invalid_env']] as const) {
        const dir = mkdtempSync(join(tmpdir(), 'flint-mode-'));
        dirs.push(dir);
        const file = join(dir, 'inference.json');
        writeFileSync(file, bad);
        const lines: string[] = [];
        const s = new ModeStore({ file, envMode, envSource, log: (m) => lines.push(m) });
        expect(s.current(), `${what}, env ${envMode}`).toBe('local');
        expect(s.source(), what).toBe('invalid_saved');
        expect(lines, what).toHaveLength(1);
        expect(lines[0], what).toMatch(/^\[inference\] mode=local \(the saved mode could not be read, so local, which never uses the cloud; .*; set the mode again in Settings, or reset it\)$/);
        expect(lines.join('\n'), what).not.toContain('SECRET');
        // The file is left as it was found: Flint does not destroy what it could not read.
        expect(readFileSync(file, 'utf8')).toBe(bad);
      }
    }
  });

  it('a saved file that cannot be opened at all (no permission, a directory in its place) runs as LOCAL too', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flint-mode-'));
    dirs.push(dir);
    const file = join(dir, 'inference.json');
    writeFileSync(file, '{"version":1,"mode":"cloud","setAt":"2026-10-12T15:00:00.000Z","setBy":"console"}');
    chmodSync(file, 0o000);
    const unreadable = new ModeStore({ file, envMode: 'cloud', envSource: 'default' });
    chmodSync(file, 0o600);
    // (Skipped when the test runs as root, which can read anything.)
    if (process.getuid?.() !== 0) {
      expect(unreadable.current()).toBe('local');
      expect(unreadable.source()).toBe('invalid_saved');
    }
    const asDir = join(dir, 'a-directory.json');
    mkdirSync(asDir);
    const s = new ModeStore({ file: asDir, envMode: 'cloud', envSource: 'default' });
    expect(s.current()).toBe('local');
    expect(s.source()).toBe('invalid_saved');
  });

  it('no file at all is not damage: the environment applies, as before', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flint-mode-'));
    dirs.push(dir);
    const s = new ModeStore({ file: join(dir, 'inference.json'), envMode: 'cloud', envSource: 'default' });
    expect(s.current()).toBe('cloud');
    expect(s.source()).toBe('default');
    // Nor is a directory that is not there yet.
    expect(new ModeStore({ file: join(dir, 'not', 'made', 'yet', 'inference.json'), envMode: 'hybrid', envSource: 'env' }).current()).toBe('hybrid');
  });

  it('setting the mode again repairs a damaged file; reset removes it and goes back to the environment', () => {
    const fresh = () => {
      const dir = mkdtempSync(join(tmpdir(), 'flint-mode-'));
      dirs.push(dir);
      const file = join(dir, 'inference.json');
      writeFileSync(file, '{"version":1,"mode":"loc');
      const lines: string[] = [];
      return { file, lines, s: new ModeStore({ file, envMode: 'cloud', envSource: 'default', log: (m) => lines.push(m), now: () => new Date('2026-10-12T15:00:00.000Z') }) };
    };
    const a = fresh();
    const seen: string[] = [];
    a.s.onChange((to, from) => seen.push(`${from}->${to}`));
    expect(a.s.set('hybrid', 'console')).toBe('local'); // it replaced the Local that the damage forced
    expect(a.s.current()).toBe('hybrid');
    expect(a.s.source()).toBe('settings');
    expect(seen).toEqual(['local->hybrid']);
    expect(JSON.parse(readFileSync(a.file, 'utf8'))).toMatchObject({ version: 1, mode: 'hybrid' });
    expect(new ModeStore({ file: a.file, envMode: 'cloud', envSource: 'default' }).source()).toBe('settings');
    // Choosing Local again is a choice too: the source becomes `settings`, and the file is whole.
    const b = fresh();
    b.s.set('local', 'console');
    expect(b.s.source()).toBe('settings');
    expect(new ModeStore({ file: b.file, envMode: 'cloud', envSource: 'default' }).current()).toBe('local');
    // Reset: the file is gone, and the environment applies.
    const c = fresh();
    expect(c.s.reset('cli')).toBe('local');
    expect(c.s.current()).toBe('cloud');
    expect(c.s.source()).toBe('default');
    expect(existsSync(c.file)).toBe(false);
    expect(c.lines.at(-1)).toBe('[inference] mode local -> cloud (cli)');
  });

  it('a mode that cannot be saved is not switched to', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flint-mode-'));
    dirs.push(dir);
    const locked = join(dir, 'locked');
    mkdirSync(locked);
    chmodSync(locked, 0o500);
    dirs.push(locked);
    const lines: string[] = [];
    const s = new ModeStore({ file: join(locked, 'inference.json'), envMode: 'cloud', envSource: 'default', log: (m) => lines.push(m) });
    expect(() => s.set('local', 'console')).toThrow(ModeNotSaved);
    expect(s.current()).toBe('cloud');
    expect(lines.at(-1)).toBe('[inference] the mode could not be saved, so it was not changed');
  });

  it('listeners hear each change once, and not a set that changes nothing', () => {
    const s = store();
    const heard: string[] = [];
    s.store.onChange((to, from) => heard.push(`${from}->${to}`));
    s.store.onChange(() => {
      throw new Error('a listener that fails');
    });
    s.store.set('hybrid', 'console');
    s.store.set('hybrid', 'console');
    s.store.set('local', 'cli');
    s.store.reset();
    expect(heard).toEqual(['cloud->hybrid', 'hybrid->local', 'local->cloud']);
  });

  // The final review's L7.
  it('a set that leaves the mode as it was but SAVES it is said, once; listeners are not told, since the mode did not change', () => {
    const s = store({ envMode: 'hybrid', envSource: 'env' });
    const heard: string[] = [];
    s.store.onChange((to, from) => heard.push(`${from}->${to}`));
    expect(s.store.source()).toBe('env');
    expect(s.store.set('hybrid', 'console')).toBe('hybrid');
    expect(s.store.source()).toBe('settings');
    expect(s.lines.at(-1)).toBe('[inference] mode hybrid saved (console); it was already in force');
    expect(existsSync(s.opts.file)).toBe(true);
    // Saved already: nothing is written again and nothing is said.
    const before = { lines: s.lines.length, mtime: statSync(s.opts.file).mtimeMs, text: readFileSync(s.opts.file, 'utf8') };
    s.store.set('hybrid', 'cli');
    expect(s.lines).toHaveLength(before.lines);
    expect(readFileSync(s.opts.file, 'utf8')).toBe(before.text);
    // Forgetting it is said the same way.
    s.store.reset('cli');
    expect(s.lines.at(-1)).toBe('[inference] mode hybrid no longer saved (cli); it was already in force');
    expect(s.store.source()).toBe('env');
    expect(heard).toEqual([]);
  });

  it('only the three modes can be set', () => {
    const s = store();
    expect(() => s.store.set('fast' as never, 'console')).toThrow();
    expect(s.store.current()).toBe('cloud');
  });
});

// The final review's L2: what is at the saved mode's path is looked at before it is opened.
describe('the saved mode is read only from a small regular file', () => {
  const GOOD = '{"version":1,"mode":"hybrid","setAt":"2026-10-12T15:00:00.000Z","setBy":"console"}\n';
  const at = (make: (file: string, dir: string) => void, over: Partial<ModeStoreOptions> = {}) => {
    const dir = mkdtempSync(join(tmpdir(), 'flint-mode-'));
    dirs.push(dir);
    const file = join(dir, 'inference.json');
    make(file, dir);
    const lines: string[] = [];
    const started = Date.now();
    const s = new ModeStore({ file, envMode: 'cloud', envSource: 'default', log: (m) => lines.push(m), ...over });
    return { s, lines, ms: Date.now() - started, file, dir };
  };

  it('a pipe at that path does not hold the boot: it is damage, at once', () => {
    const r = at((file) => execFileSync('/usr/bin/mkfifo', [file]));
    expect(r.ms).toBeLessThan(1000); // reading a pipe nobody writes to used to wait for ever
    expect(r.s.current()).toBe('local');
    expect(r.s.source()).toBe('invalid_saved');
  });

  it('a link is never followed: to an endless device, to a good file elsewhere, or to nothing at all', () => {
    const endless = at((file) => symlinkSync('/dev/zero', file));
    expect(endless.ms).toBeLessThan(1000);
    expect([endless.s.current(), endless.s.source()]).toEqual(['local', 'invalid_saved']);
    // A link to a perfectly good saved mode is still not a file Flint wrote there.
    const elsewhere = at((file, dir) => {
      writeFileSync(join(dir, 'real.json'), GOOD);
      symlinkSync(join(dir, 'real.json'), file);
    });
    expect([elsewhere.s.current(), elsewhere.s.source()]).toEqual(['local', 'invalid_saved']);
    // A link that points nowhere used to read as "no file", and so as the environment's mode: cloud.
    const dangling = at((file, dir) => symlinkSync(join(dir, 'gone.json'), file));
    expect([dangling.s.current(), dangling.s.source()]).toEqual(['local', 'invalid_saved']);
  });

  it('a file over 4 KB is not read: damage, whatever it starts with', () => {
    expect(SAVED_MODE_MAX_BYTES).toBe(4096);
    const big = at((file) => writeFileSync(file, GOOD + ' '.repeat(SAVED_MODE_MAX_BYTES)));
    expect([big.s.current(), big.s.source()]).toEqual(['local', 'invalid_saved']);
    // Padded to exactly the limit, it is still the mode Will saved.
    const edge = at((file) => writeFileSync(file, GOOD + ' '.repeat(SAVED_MODE_MAX_BYTES - GOOD.length)));
    expect([edge.s.current(), edge.s.source()]).toEqual(['hybrid', 'settings']);
  });

  it('a regular file Flint wrote is read as before, and setting the mode repairs anything else found there', () => {
    const good = at((file) => writeFileSync(file, GOOD));
    expect([good.s.current(), good.s.source()]).toEqual(['hybrid', 'settings']);
    const linked = at((file) => symlinkSync('/dev/zero', file));
    linked.s.set('cloud', 'console');
    expect(statSync(linked.file).isFile()).toBe(true); // the rename replaced the link itself, never what it pointed at
    expect(new ModeStore({ file: linked.file, envMode: 'local', envSource: 'env' }).current()).toBe('cloud');
  });
});

describe('the saved mode is written through a temp file of its own', () => {
  it('a link planted at the old, guessable temp name is not followed or touched', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flint-mode-'));
    dirs.push(dir);
    const file = join(dir, 'inference.json');
    const victim = join(dir, 'victim.txt');
    writeFileSync(victim, 'untouched');
    symlinkSync(victim, `${file}.${process.pid}.tmp`);
    const s = new ModeStore({ file, envMode: 'cloud', envSource: 'default' });
    s.set('local', 'console');
    expect(readFileSync(victim, 'utf8')).toBe('untouched');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ version: 1, mode: 'local' });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    // Nothing of the write is left behind: the saved file, and the two things this test put there.
    expect(readdirSync(dir).sort()).toEqual(['inference.json', `inference.json.${process.pid}.tmp`, 'victim.txt'].sort());
  });

  it('each write has its own name, and a write that fails leaves no temp file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flint-mode-'));
    dirs.push(dir);
    const s = new ModeStore({ file: join(dir, 'inference.json'), envMode: 'cloud', envSource: 'default' });
    s.set('local', 'console');
    s.set('hybrid', 'console');
    expect(readdirSync(dir)).toEqual(['inference.json']);
    // The saved file's own path is a directory: the rename fails, the mode is not changed, and the temp file is removed.
    const blocked = mkdtempSync(join(tmpdir(), 'flint-mode-'));
    dirs.push(blocked);
    mkdirSync(join(blocked, 'inference.json'));
    writeFileSync(join(blocked, 'inference.json', 'x'), 'x');
    const b = new ModeStore({ file: join(blocked, 'inference.json'), envMode: 'cloud', envSource: 'default' });
    expect(() => b.set('hybrid', 'console')).toThrow(ModeNotSaved);
    expect(readdirSync(blocked)).toEqual(['inference.json']);
  });
});
