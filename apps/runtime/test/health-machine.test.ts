/**
 * What Health reads from the Mac itself (src/health/machine.ts): free space,
 * whether remote access works, and which local models are there.
 *
 * Nothing here touches the real machine: the disk is a stub, the tailscale
 * program is a stand-in (a function, or a script in a scratch folder), and
 * Ollama is a function. What is checked:
 *  - a reading that is missing, cut short or not the shape expected is
 *    "unknown", never "ok";
 *  - the one program that is run is run by its full path, with fixed
 *    arguments, with nothing of this process's environment, and is killed at
 *    its limit;
 *  - only this Mac's own address is ever asked for the models, and only for
 *    its two lists;
 *  - every line Health can show is a plain sentence, with no path, name or
 *    number that came from a program.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HEALTH_NAMES, noteProblems } from '@flint/policy';
import {
  DISK_FULL_BYTES, DISK_LOW_BYTES, EXPIRY_WARN_DAYS, MODEL_HEALTH, REMOTE_HEALTH, TAILSCALE_BINS,
  standbyModelCheck, daysUntil, diskCheck, freeBytes, gigabytes, localModelCheck, localModels, modelName, readMachine, remoteAccess, remoteAccessCheck, runFixed,
  type RemoteAccess, type Run,
} from '../src/health/machine';

const NOW = new Date('2026-10-12T18:00:00Z');
const DAY = 86_400_000;
const GB = 1e9;
const scratch = mkdtempSync(join(tmpdir(), 'flint-machine-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A line Health shows: a sentence in plain words, under its component's name. */
function plain(component: string, line: string | undefined): void {
  expect(line, component).toBeTruthy();
  expect(noteProblems(HEALTH_NAMES[component]!, line!), `${component}: ${line}`).toEqual([]);
  expect(line!, line).toMatch(/^[A-Z].*\.$/);
  expect(line!, line).not.toMatch(/[%()/~]|\.sock|tailscale|ollama|[a-z]+_[a-z]+/i);
  expect(line!.length, line).toBeLessThanOrEqual(120);
}

describe('free space', () => {
  it('is what the volume says is free for this user, and unreadable is not a number', async () => {
    expect(await freeBytes('/x', async () => ({ bavail: 1000, bsize: 4096 }))).toBe(4_096_000);
    expect(await freeBytes('/x', async () => ({ bavail: 3n * 10n ** 9n, bsize: 4096n }))).toBe(3e9 * 4096);
    expect(await freeBytes('/x', async () => { throw new Error('ENOENT'); })).toBeUndefined();
    expect(await freeBytes('/x', async () => ({ bavail: -1, bsize: 4096 }))).toBeUndefined();
    expect(await freeBytes('/x', async () => ({ bavail: Number.NaN, bsize: 4096 }))).toBeUndefined();
    // The real call, on a folder that is there: a number, and more than nothing.
    expect(await freeBytes(scratch)).toBeGreaterThan(0);
  });

  it('low under 20 GB, nearly full under 5 GB, and never more than there is', () => {
    expect(diskCheck(212.9 * GB)).toEqual({ component: 'disk', status: 'ok', detail: 'This Mac has 212 GB free.' });
    expect(diskCheck(DISK_LOW_BYTES)).toMatchObject({ status: 'ok' });
    expect(diskCheck(DISK_LOW_BYTES - 1)).toEqual({ component: 'disk', status: 'degraded', detail: 'This Mac is low on space, with 19 GB free.' });
    expect(diskCheck(14.2 * GB).detail).toBe('This Mac is low on space, with 14 GB free.');
    expect(diskCheck(DISK_FULL_BYTES)).toMatchObject({ status: 'degraded', detail: 'This Mac is low on space, with 5 GB free.' });
    expect(diskCheck(DISK_FULL_BYTES - 1)).toEqual({ component: 'disk', status: 'down', detail: 'This Mac is nearly full, with 4 GB free.' });
    expect(diskCheck(3.99 * GB).detail).toBe('This Mac is nearly full, with 3 GB free.');
    expect(diskCheck(0.4 * GB).detail).toBe('This Mac is nearly full, with less than 1 GB free.');
    expect(diskCheck(0).status).toBe('down');
    // What could not be read is unknown, never ok.
    expect(diskCheck(undefined)).toEqual({ component: 'disk', status: 'unknown', detail: 'Flint couldn’t read how much space is free.' });
    expect(gigabytes(1.999 * GB)).toBe('1 GB');
    for (const free of [undefined, 0, 0.4 * GB, 3 * GB, 14 * GB, 212 * GB]) plain('disk', diskCheck(free).detail);
  });
});

describe('remote access', () => {
  const HOME = '/Users/someone';
  const SOCKET = `${HOME}/.flint/tailscaled.sock`;
  const BIN = TAILSCALE_BINS[0];
  const there = (...paths: string[]) => (p: string) => paths.includes(p);
  const setUp = there(`${HOME}/.flint/tailscale-url.txt`, SOCKET, BIN);
  const status = (over: Record<string, unknown> = {}, self: Record<string, unknown> = {}) =>
    JSON.stringify({ BackendState: 'Running', Version: '1.80.0', TailscaleIPs: ['100.64.0.1'], Self: { Online: true, HostName: 'studio', DNSName: 'studio.example.ts.net.', ...self }, Peer: { x: { HostName: 'macbook' } }, ...over });
  const serve = (proxy = 'http://127.0.0.1:8080') => JSON.stringify({ TCP: { '443': { HTTPS: true } }, Web: { 'studio.example.ts.net:443': { Handlers: { '/': { Proxy: proxy } } } } });
  /** A stand-in for the program: answers `status --json` and `serve status --json`, and remembers how it was asked. */
  const program = (answers: { status?: string | Error; serve?: string | Error }) => {
    const calls: Array<{ bin: string; args: readonly string[] }> = [];
    const run: Run = async (bin, args) => {
      calls.push({ bin, args });
      const said = args.includes('serve') ? answers.serve : answers.status;
      if (said === undefined || said instanceof Error) throw said ?? new Error('not answered');
      return said;
    };
    return { run, calls };
  };
  const ask = (answers: Parameters<typeof program>[0], exists = setUp) => remoteAccess(HOME, NOW, { run: program(answers).run, exists });

  it('off until it was set up on this Mac; down when its daemon is not there; unknown when the program is not', async () => {
    const p = program({ status: status(), serve: serve() });
    expect(await remoteAccess(HOME, NOW, { run: p.run, exists: there() })).toEqual({ state: 'off' });
    expect(await remoteAccess(HOME, NOW, { run: p.run, exists: there(`${HOME}/.flint/tailscale-url.txt`) })).toEqual({ state: 'down', why: 'not_running' });
    expect(await remoteAccess(HOME, NOW, { run: p.run, exists: there(`${HOME}/.flint/tailscale-url.txt`, SOCKET) })).toEqual({ state: 'unknown' });
    // Nothing was run to find any of that out.
    expect(p.calls).toEqual([]);
  });

  it('the program is run by its full path, from a fixed list, with fixed arguments and Flint’s own socket', async () => {
    const p = program({ status: status(), serve: serve() });
    expect(await remoteAccess(HOME, NOW, { run: p.run, exists: setUp })).toEqual({ state: 'ok' });
    expect(p.calls).toEqual([
      { bin: BIN, args: ['--socket', SOCKET, 'status', '--json'] },
      { bin: BIN, args: ['--socket', SOCKET, 'serve', 'status', '--json'] },
    ]);
    for (const bin of TAILSCALE_BINS) expect(bin, bin).toMatch(/^\/(opt\/homebrew|usr\/local)\/.*\/tailscale$/);
    // The first of the list that is there is the one run: nothing is looked up on the PATH.
    const second = program({ status: status(), serve: serve() });
    await remoteAccess(HOME, NOW, { run: second.run, exists: there(`${HOME}/.flint/tailscale-url.txt`, SOCKET, TAILSCALE_BINS[2]) });
    expect(second.calls.map((c) => c.bin)).toEqual([TAILSCALE_BINS[2], TAILSCALE_BINS[2]]);
  });

  it('running, connected and pointed at Flint is ok; anything else it says is down, with why from a fixed list', async () => {
    expect(await ask({ status: status(), serve: serve() })).toEqual({ state: 'ok' });
    expect(await ask({ status: status(), serve: serve('http://localhost:8080') })).toEqual({ state: 'ok' });
    expect(await ask({ status: status({ BackendState: 'Stopped' }), serve: serve() })).toEqual({ state: 'down', why: 'not_running' });
    expect(await ask({ status: status({ BackendState: 'NeedsLogin' }), serve: serve() })).toEqual({ state: 'down', why: 'signed_out' });
    expect(await ask({ status: status({ BackendState: 'NeedsMachineAuth' }), serve: serve() })).toEqual({ state: 'down', why: 'signed_out' });
    expect(await ask({ status: status({}, { Expired: true }), serve: serve() })).toEqual({ state: 'down', why: 'signed_out' });
    expect(await ask({ status: status({}, { KeyExpiry: new Date(NOW.getTime() - 1000).toISOString() }), serve: serve() })).toEqual({ state: 'down', why: 'signed_out' });
    expect(await ask({ status: status({}, { Online: false }), serve: serve() })).toEqual({ state: 'down', why: 'offline' });
    // On, and serving nothing, or something that is not Flint's server on this Mac.
    expect(await ask({ status: status(), serve: '{}' })).toEqual({ state: 'down', why: 'not_served' });
    for (const elsewhere of ['http://127.0.0.1:3000', 'https://127.0.0.1:8080', 'http://10.0.0.5:8080', 'http://example.com:8080', 'not a url', '']) {
      expect(await ask({ status: status(), serve: serve(elsewhere) }), elsewhere).toEqual({ state: 'down', why: 'not_served' });
    }
  });

  it('a reply that is missing, cut short, or not the shape expected is unknown, never ok', async () => {
    const bad = [
      new Error('timed out'), '', 'Tailscale is stopped.', '{"BackendState":"Running"', '[]', 'null', '{}',
      JSON.stringify({ BackendState: 'Running' }), // no Self
      JSON.stringify({ BackendState: '', Self: {} }),
      JSON.stringify({ BackendState: 7, Self: {} }),
      status({}, { Online: 'yes' }),
      status({}, { KeyExpiry: 'next spring' }),
      status({ BackendState: 'Starting' }), status({ BackendState: 'NoState' }), status({ BackendState: 'x'.repeat(41) }),
    ];
    for (const reply of bad) {
      const r = await ask({ status: reply, serve: serve() });
      expect(r, String(reply).slice(0, 40)).toEqual({ state: 'unknown' });
      expect(remoteAccessCheck(r, NOW).status).toBe('unknown');
    }
    // It runs and is connected, and what it serves cannot be read: unknown, never "it must be fine".
    for (const reply of [new Error('exit 1'), '', 'not json', '[]', JSON.stringify({ Web: 'yes' }), JSON.stringify({ Web: { a: { Handlers: { '/': { Proxy: 7 } } } } })]) {
      expect(await ask({ status: status(), serve: reply }), String(reply).slice(0, 40)).toEqual({ state: 'unknown' });
    }
    // Anything that throws on the way is unknown too (readMachine never lets one part fail the others).
    const m = await readMachine({ home: HOME }, NOW, { stat: async () => ({ bavail: 1, bsize: 1 }), exists: () => { throw new Error('EPERM'); } });
    expect(m).toEqual({ freeBytes: 1, remote: { state: 'unknown' } });
  });

  it('the sign-in running out is said two weeks ahead, in days, and on the day', async () => {
    const expiring = (days: number) => ask({ status: status({}, { KeyExpiry: new Date(NOW.getTime() + days * DAY + 3_600_000).toISOString() }), serve: serve() });
    const far = await expiring(90);
    expect(far).toMatchObject({ state: 'ok' });
    expect(remoteAccessCheck(far, NOW)).toEqual({ component: 'remote_access', status: 'ok', detail: 'Your phone and MacBook can reach Flint.' });
    expect(remoteAccessCheck(await expiring(EXPIRY_WARN_DAYS + 1), NOW).status).toBe('ok');
    expect(remoteAccessCheck(await expiring(EXPIRY_WARN_DAYS), NOW)).toEqual({ component: 'remote_access', status: 'degraded', detail: 'Remote access needs a new sign-in in 14 days.' });
    expect(remoteAccessCheck(await expiring(12), NOW).detail).toBe('Remote access needs a new sign-in in 12 days.');
    expect(remoteAccessCheck(await expiring(1), NOW).detail).toBe('Remote access needs a new sign-in in 1 day.');
    expect(remoteAccessCheck(await expiring(0), NOW)).toMatchObject({ status: 'degraded', detail: 'Remote access needs a new sign-in today.' });
    expect(daysUntil(new Date(NOW.getTime() - DAY), NOW)).toBe(0);
    // A key that never runs out (the setting is off for this Mac) carries no date.
    expect(await ask({ status: status(), serve: serve() })).toEqual({ state: 'ok' });
  });

  it('what Health shows is one of a few fixed sentences: nothing the program printed is passed on', () => {
    const states: RemoteAccess[] = [
      { state: 'off' }, { state: 'unknown' }, { state: 'ok' }, { state: 'ok', expiresAt: new Date(NOW.getTime() + 3 * DAY) },
      { state: 'down', why: 'not_running' }, { state: 'down', why: 'signed_out' }, { state: 'down', why: 'offline' }, { state: 'down', why: 'not_served' },
    ];
    const checks = states.map((s) => remoteAccessCheck(s, NOW));
    expect(checks.map((c) => c.status)).toEqual(['disabled', 'unknown', 'ok', 'degraded', 'down', 'down', 'down', 'down']);
    expect(checks[0]).toEqual({ component: 'remote_access', status: 'disabled' });
    for (const c of checks.slice(1)) plain('remote_access', c.detail);
    expect(new Set(checks.slice(1).map((c) => c.detail)).size).toBe(7);
    expect(REMOTE_HEALTH.down.signed_out).toBe('Remote access needs a new sign-in, so your phone and MacBook can’t reach Flint.');
  });

  describe('the program, run for real (a stand-in script in a scratch folder)', () => {
    const script = (name: string, body: string): string => {
      const file = join(scratch, name);
      writeFileSync(file, `#!/bin/sh\n${body}\n`);
      chmodSync(file, 0o755);
      return file;
    };

    it('gets its arguments as they are, no shell, and nothing of this process’s environment', async () => {
      process.env.FLINT_MACHINE_TEST_SECRET = 'never-passed-on';
      try {
        const out = await runFixed(script('echo-args', 'for a in "$@"; do printf "%s\\n" "$a"; done; printf "env:"; env | sort | tr "\\n" " "'), ['--socket', '/a b/$(id).sock', 'status', '--json; echo pwned']);
        const lines = out.split('\n');
        expect(lines.slice(0, 4)).toEqual(['--socket', '/a b/$(id).sock', 'status', '--json; echo pwned']);
        expect(out).not.toContain('never-passed-on');
        expect(out).not.toMatch(/HOME=|FLINT_|DATABASE_URL/);
        expect(lines[4]).toMatch(/^env:.*PATH=\/usr\/bin:\/bin/);
      } finally {
        delete process.env.FLINT_MACHINE_TEST_SECRET;
      }
    });

    it('is killed at its limit, and a run that printed nothing or was cut off is a failure', async () => {
      const began = Date.now();
      await expect(runFixed(script('hangs', 'printf "{\\"BackendState\\":\\"Running\\","; exec sleep 30'), [], 300)).rejects.toBeTruthy();
      expect(Date.now() - began).toBeLessThan(5_000);
      await expect(runFixed(script('silent', 'exit 1'), [])).rejects.toBeTruthy();
      await expect(runFixed(join(scratch, 'not-there'), [])).rejects.toBeTruthy();
      // One that printed its answer and then exited with an error still gave an answer: the schema decides what it is worth.
      expect(await runFixed(script('says-then-fails', 'echo "{}"; exit 1'), [])).toBe('{}\n');
    });

    it('asked through the real runner: a script that answers as the daemon does is ok, and one that hangs is unknown', async () => {
      const home = mkdtempSync(join(scratch, 'home-'));
      const exists = (bin: string) => (p: string) => p === bin || p.startsWith(home);
      const answers = script('answers', `case "$*" in *serve*) cat <<'J'\n${serve()}\nJ\n;; *) cat <<'J'\n${status()}\nJ\n;; esac`);
      const viaScript = (bin: string): Run => (_bin, args) => runFixed(bin, args, 400);
      expect(await remoteAccess(home, NOW, { run: viaScript(answers), exists: exists(TAILSCALE_BINS[0]) })).toEqual({ state: 'ok' });
      expect(await remoteAccess(home, NOW, { run: viaScript(script('hangs2', 'exec sleep 30')), exists: exists(TAILSCALE_BINS[0]) })).toEqual({ state: 'unknown' });
    });
  });
});

describe('the local models', () => {
  const lists = (installed: string[], loaded: string[], calls: Array<{ url: string; method: string; redirect: unknown }> = []) =>
    (async (url: string, init: RequestInit = {}) => {
      calls.push({ url: String(url), method: init.method ?? 'GET', redirect: init.redirect });
      const names = String(url).endsWith('/api/ps') ? loaded : installed;
      return new Response(JSON.stringify({ models: names.map((name) => ({ name, size: 1, digest: 'x'.repeat(64) })) }), { status: 200 });
    }) as unknown as typeof fetch;

  it('asks this Mac’s own address only, for its two lists and nothing else', async () => {
    const calls: Array<{ url: string; method: string; redirect: unknown }> = [];
    const m = await localModels('http://127.0.0.1:11434', lists(['qwen2.5:14b', 'llama3.2'], ['qwen2.5:14b'], calls));
    expect(calls).toEqual([
      { url: 'http://127.0.0.1:11434/api/tags', method: 'GET', redirect: 'manual' },
      { url: 'http://127.0.0.1:11434/api/ps', method: 'GET', redirect: 'manual' },
    ]);
    expect([...m!.installed].sort()).toEqual(['llama3.2:latest', 'qwen2.5:14b']);
    expect([...m!.loaded]).toEqual(['qwen2.5:14b']);
    // Any other address is never asked, whatever the setting says.
    for (const url of ['http://ollama.example.com:11434', 'https://127.0.0.1:11434', 'http://10.0.0.5:11434', 'http://127.0.0.1.example.com:11434', 'file:///etc/passwd', 'not a url']) {
      const none: Array<{ url: string; method: string; redirect: unknown }> = [];
      expect(await localModels(url, lists(['x'], ['x'], none)), url).toBeUndefined();
      expect(none, url).toEqual([]);
    }
    for (const url of ['http://localhost:11434', 'http://[::1]:11434']) expect(await localModels(url, lists(['x'], [])), url).toBeDefined();
  });

  it('a list that cannot be read is no list at all: never half of one', async () => {
    const failing = (bad: (url: string) => Response | Promise<Response>) => (async (url: string) => (String(url).endsWith('/api/ps') ? bad(String(url)) : new Response('{"models":[{"name":"a"}]}'))) as unknown as typeof fetch;
    expect(await localModels('http://127.0.0.1:11434', failing(() => new Response('busy', { status: 503 })))).toBeUndefined();
    expect(await localModels('http://127.0.0.1:11434', failing(() => new Response('<html>')))).toBeUndefined();
    expect(await localModels('http://127.0.0.1:11434', failing(() => new Response('{"models":"many"}')))).toBeUndefined();
    expect(await localModels('http://127.0.0.1:11434', failing(() => new Response('{"models":[{"name":""}]}')))).toBeUndefined();
    expect(await localModels('http://127.0.0.1:11434', failing(() => { throw new Error('ECONNREFUSED'); }))).toBeUndefined();
    expect(await localModels('http://127.0.0.1:11434', (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch)).toBeUndefined();
  });

  it('Local Model: "Ollama answers" is not "the model Flint asks is there"', () => {
    const up = { component: 'ollama', status: 'ok' } as const;
    const models = { installed: new Set(['qwen2.5:14b', 'llama3.2:latest']), loaded: new Set(['qwen2.5:14b']) };
    expect(localModelCheck(up, 'qwen2.5:14b', models)).toEqual({ component: 'ollama', status: 'ok', detail: 'The local model is loaded.' });
    expect(localModelCheck(up, 'llama3.2', models)).toEqual({ component: 'ollama', status: 'ok', detail: 'The local model is installed, and loads when it’s needed.' });
    expect(localModelCheck(up, 'gemma3:4b', models)).toEqual({ component: 'ollama', status: 'down', detail: 'The local model isn’t installed.' });
    // Its lists could not be read: unknown, never ok.
    expect(localModelCheck(up, 'qwen2.5:14b', undefined)).toEqual({ component: 'ollama', status: 'unknown', detail: 'Flint couldn’t check which models are installed.' });
    // When Ollama itself is not ok, or no model is named, what the health source saw stands as it is.
    for (const seen of [{ component: 'ollama', status: 'down' }, { component: 'ollama', status: 'unknown', detail: 'It hasn’t been checked yet.' }, { component: 'ollama', status: 'degraded' }] as const) {
      expect(localModelCheck(seen, 'qwen2.5:14b', models)).toBe(seen);
      expect(localModelCheck(seen, 'qwen2.5:14b', undefined)).toBe(seen);
    }
    expect(localModelCheck(up, undefined, undefined)).toBe(up);
    expect(modelName('llama3.2')).toBe('llama3.2:latest');
    expect(modelName('registry.example/x/y:tag')).toBe('registry.example/x/y:tag');
    expect(modelName('registry.example:5000/x/y')).toBe('registry.example:5000/x/y:latest');
  });

  it('Standby Model: no line until one is named; named "off" it is off; then installed or not, and unknown when the list could not be read', () => {
    const models = { installed: new Set(['llama3.2:latest']), loaded: new Set<string>() };
    // Not named: the server picks a standby for this Mac by itself, and the runtime has nothing to say about it.
    expect(standbyModelCheck(undefined, models)).toBeUndefined();
    for (const off of ['off', 'none', 'OFF', 'None']) expect(standbyModelCheck(off, models), off).toEqual({ component: 'standby_model', status: 'disabled' });
    // A model that merely begins that way is a model.
    expect(standbyModelCheck('offline-small:1b', models)).toMatchObject({ status: 'degraded' });
    expect(standbyModelCheck('llama3.2', models)).toEqual({ component: 'standby_model', status: 'ok', detail: 'The standby model is ready.' });
    expect(standbyModelCheck('gemma3:4b', models)).toEqual({ component: 'standby_model', status: 'degraded', detail: 'The standby model isn’t installed.' });
    expect(standbyModelCheck('llama3.2', undefined)).toEqual({ component: 'standby_model', status: 'unknown', detail: 'Flint couldn’t check which models are installed.' });
    for (const line of Object.values(MODEL_HEALTH)) {
      plain('ollama', line);
      plain('standby_model', line);
    }
  });

  it('one reading for a health run: each part is read on its own, and the models only when one is named', async () => {
    const asked: string[] = [];
    const f = (async (url: string) => (asked.push(String(url)), new Response('{"models":[{"name":"a:b"}]}'))) as unknown as typeof fetch;
    const without = await readMachine({ home: '/h' }, NOW, { stat: async () => ({ bavail: 10, bsize: GB }), exists: () => false, fetch: f });
    expect(without).toEqual({ freeBytes: 10 * GB, remote: { state: 'off' } });
    expect(asked).toEqual([]);
    const withModels = await readMachine({ home: '/h', ollama: { url: 'http://127.0.0.1:11434' } }, NOW, { stat: async () => { throw new Error('EIO'); }, exists: () => false, fetch: f });
    expect(withModels.freeBytes).toBeUndefined();
    expect([...withModels.models!.installed]).toEqual(['a:b']);
    expect(asked).toEqual(['http://127.0.0.1:11434/api/tags', 'http://127.0.0.1:11434/api/ps']);
  });
});
