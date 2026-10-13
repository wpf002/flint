import { describe, it, expect, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { askServer, flintToken, parseArgs, render, run, serverUrl, type RunDeps } from '../scripts/inference-status';
import type { InferenceStatus } from '../src/inference-status';

/** The status command: `pnpm --filter server inference-status`. Nothing here detects a machine, asks a model server, or reads ~/.flint. */

const status = { mode: 'hybrid', lines: ['Flint is in Hybrid mode. Flint picks this Mac or the cloud for each message.', 'The local model is ready.'] } as unknown as InferenceStatus;
const OFFLINE = { mode: 'cloud', lines: ['Flint is in Cloud mode. Cloud models answer, and private messages stay on this Mac.'] } as unknown as InferenceStatus;

const homes: string[] = [];
afterAll(() => {
  for (const h of homes) rmSync(h, { recursive: true, force: true });
});
/** A home directory of this test's own, with a token file when asked. */
function home(token?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'flint-status-home-'));
  homes.push(dir);
  if (token !== undefined) {
    mkdirSync(join(dir, '.flint'));
    writeFileSync(join(dir, '.flint', 'token'), token);
  }
  return dir;
}

type Reply = { status: number; body: unknown } | 'down';
/** The command, run against a server that answers as told. What it printed, where, and its exit code. */
async function cli(argv: string[], o: { env?: Record<string, string>; home?: string; server?: (path: string, init: RequestInit) => Reply; offline?: RunDeps['offline'] } = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const asked: Array<{ url: string; init: RequestInit }> = [];
  let offlineRuns = 0;
  const f = (async (url: string, init: RequestInit) => {
    asked.push({ url, init });
    const r = o.server ? o.server(new URL(url).pathname, init) : 'down';
    if (r === 'down') throw new TypeError('fetch failed');
    return new Response(JSON.stringify(r.body), { status: r.status });
  }) as unknown as typeof fetch;
  const code = await run(argv, {
    env: o.env ?? {},
    home: o.home ?? home(),
    fetch: f,
    offline: async () => {
      offlineRuns += 1;
      return o.offline ? o.offline() : OFFLINE;
    },
    out: (l) => stdout.push(l),
    err: (l) => stderr.push(l),
  });
  return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n'), asked, offlineRuns };
}

describe('parseArgs', () => {
  it('no arguments: the sentences', () => {
    expect(parseArgs([])).toEqual({ json: false });
    expect(parseArgs(['--'])).toEqual({ json: false });
  });

  it('--json, and --mode with one of the three modes or reset', () => {
    expect(parseArgs(['--json'])).toEqual({ json: true });
    for (const m of ['local', 'hybrid', 'cloud', 'reset']) expect(parseArgs(['--', '--mode', m])).toEqual({ json: false, mode: m });
  });

  it('anything else is refused with a sentence that names the choices', () => {
    expect(parseArgs(['--mode', 'turbo'])).toEqual({ error: '--mode is one of local, cloud, hybrid, or reset' });
    expect(parseArgs(['--mode'])).toEqual({ error: '--mode is one of local, cloud, hybrid, or reset' });
    expect(parseArgs(['--pull'])).toEqual({ error: 'an argument was not understood (use --json, or --mode <local|cloud|hybrid|reset>)' });
  });

  it('an argument that is not understood is never repeated back: what was pasted there may be a token', () => {
    for (const pasted of ['sk-ant-SECRETSECRET', '--token=SECRETSECRET', 'SECRETSECRET', '--mode=SECRETSECRET']) {
      expect(JSON.stringify(parseArgs([pasted]))).not.toContain('SECRET');
      expect(JSON.stringify(parseArgs(['--mode', pasted]))).not.toContain('SECRET');
    }
  });
});

describe('render', () => {
  it('prints the sentences, one per line, with the note when there is one', () => {
    expect(render(status, { json: false })).toBe(status.lines.join('\n'));
    expect(render(status, { json: false }, 'A note.')).toBe([...status.lines, 'A note.'].join('\n'));
  });

  it('--json prints the object, and never a note inside it', () => {
    expect(JSON.parse(render(status, { json: true }))).toEqual({ view: 'running_server', ...status });
    expect(JSON.parse(render(status, { json: true }, 'A note.'))).toEqual({ view: 'running_server', ...status });
    // The final review's L8: the object built here said nowhere that it is this shell's view, not the server's.
    expect(JSON.parse(render(status, { json: true }, undefined, 'this_shell'))).toEqual({ view: 'this_shell', ...status });
    expect(Object.keys(JSON.parse(render(status, { json: true })))[0]).toBe('view');
  });
});

describe("the token: FLINT_TOKEN, then the file ~/.flint/token, as Flint's other commands read it", () => {
  it('the environment first', () => {
    expect(flintToken({ FLINT_TOKEN: ' from-env ' }, home('from-file'))).toBe('from-env');
  });

  it('then the file, trimmed; an empty file or none is no token', () => {
    expect(flintToken({}, home('from-file\n'))).toBe('from-file');
    expect(flintToken({ FLINT_TOKEN: '  ' }, home('from-file'))).toBe('from-file');
    expect(flintToken({}, home('  \n'))).toBeUndefined();
    expect(flintToken({}, home())).toBeUndefined();
  });

  it('a token file that cannot be read is no token, never a crash', () => {
    const h = home();
    mkdirSync(join(h, '.flint', 'token'), { recursive: true });
    expect(flintToken({}, h)).toBeUndefined();
  });
});

describe('talking to the running server', () => {
  it('is always this Mac, on the port the server listens on', () => {
    expect(serverUrl({})).toBe('http://[::1]:8080');
    expect(serverUrl({ PORT: '9090' })).toBe('http://[::1]:9090');
    expect(serverUrl({ PORT: '9090@evil.example' })).toBe('http://[::1]:8080');
  });

  it('with no token nothing is asked', async () => {
    let asked = 0;
    const f = (async () => {
      asked += 1;
      return new Response('{}');
    }) as unknown as typeof fetch;
    expect(await askServer({}, undefined, '/inference', undefined, f)).toEqual({ kind: 'no_token' });
    expect(asked).toBe(0);
  });

  it('with a token it asks with it, never follows a redirect, and a server that is down is its own answer', async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const f = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response(JSON.stringify({ ok: true, mode: 'local', previous: 'cloud' }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await askServer({ PORT: '8080' }, 'tok', '/inference/mode', { mode: 'local', by: 'cli' }, f);
    expect(r).toEqual({ kind: 'answer', status: 200, json: { ok: true, mode: 'local', previous: 'cloud' } });
    expect(seen[0]!.url).toBe('http://[::1]:8080/inference/mode');
    expect(seen[0]!.init).toMatchObject({ method: 'POST', redirect: 'error', body: '{"mode":"local","by":"cli"}' });
    expect((seen[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer tok');
    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    expect(await askServer({}, 'tok', '/inference', undefined, down)).toEqual({ kind: 'down' });
  });
});

// The final review's L1, as it ran it: with NODE_USE_ENV_PROXY=1 and HTTP_PROXY, the command's request to [::1],
// bearer token and all, went to the proxy.
describe("Node's env proxy is on: the token is never sent through it", () => {
  const PROXY = { NODE_USE_ENV_PROXY: '1', HTTP_PROXY: 'http://proxy.corp.example:3128' };

  it('askServer sends nothing, and says why', async () => {
    let asked = 0;
    const f = (async () => {
      asked += 1;
      return new Response('{}');
    }) as unknown as typeof fetch;
    expect(await askServer(PROXY, 'tok', '/inference', undefined, f, [])).toEqual({ kind: 'proxied' });
    expect(await askServer({ HTTP_PROXY: PROXY.HTTP_PROXY }, 'tok', '/inference', undefined, f, ['--use-env-proxy'])).toEqual({ kind: 'proxied' });
    expect(asked).toBe(0);
    // With this Mac named in NO_PROXY, or the switch off, it asks as before.
    expect((await askServer({ ...PROXY, NO_PROXY: 'localhost,127.0.0.1,::1' }, 'tok', '/inference', undefined, f, [])).kind).toBe('answer');
    expect((await askServer({ HTTP_PROXY: PROXY.HTTP_PROXY }, 'tok', '/inference', undefined, f, [])).kind).toBe('answer');
    expect(asked).toBe(2);
  });

  it("the status: built here from this shell's settings, with a sentence that says what to change", async () => {
    const r = await cli([], { env: { ...PROXY, FLINT_TOKEN: 'tok-SECRET' }, server: () => ({ status: 200, body: status }) });
    expect(r.asked).toEqual([]);
    expect(r.offlineRuns).toBe(1);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(OFFLINE.lines[0]);
    expect(r.stdout).toContain("This shows this shell's settings, not the running server's, and no cloud side: the running server was not asked.");
    expect(r.stdout).toContain('Add ::1 to NO_PROXY, or run it without the proxy.');
    expect(r.stdout + r.stderr).not.toContain('SECRET');
    expect(r.stdout + r.stderr).not.toContain('proxy.corp.example');
  });

  it('--mode: nothing is changed, it says why, exit 1', async () => {
    const r = await cli(['--mode', 'local'], { env: { ...PROXY, FLINT_TOKEN: 'tok-SECRET' }, server: () => ({ status: 200, body: { ok: true, mode: 'local', previous: 'cloud' } }) });
    expect(r.asked).toEqual([]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^The mode was not changed: the running server was not asked\. Node's env proxy is on \(NODE_USE_ENV_PROXY\)/);
    expect(r.stdout).toBe('');
  });
});

describe('the command, run: what it prints, where, and its exit code', () => {
  const live = (path: string): Reply => (path === '/inference' ? { status: 200, body: status } : { status: 404, body: {} });

  it('the server answers: its status, on stdout, exit 0', async () => {
    const r = await cli([], { env: { FLINT_TOKEN: 'tok' }, server: live });
    expect(r).toMatchObject({ code: 0, stdout: status.lines.join('\n'), stderr: '', offlineRuns: 0 });
  });

  it('the token comes from the file when the environment has none', async () => {
    const r = await cli([], { home: home('file-token'), server: live });
    expect(r.code).toBe(0);
    expect((r.asked[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer file-token');
    expect(r.offlineRuns).toBe(0);
  });

  it("no token: the status is built here, and says plainly that it shows this shell's settings, not the running server's", async () => {
    const r = await cli([]);
    expect(r.code).toBe(0);
    expect(r.asked).toEqual([]);
    expect(r.offlineRuns).toBe(1);
    expect(r.stdout).toBe(
      [...OFFLINE.lines, "This shows this shell's settings, not the running server's, and no cloud side: this command has no token for the running server. Set FLINT_TOKEN, or put the token in the file ~/.flint/token."].join('\n'),
    );
  });

  it('the server is not answering: the same, and it says that', async () => {
    const r = await cli([], { env: { FLINT_TOKEN: 'tok' } });
    expect(r.code).toBe(0);
    expect(r.offlineRuns).toBe(1);
    expect(r.stdout.split('\n').pop()).toBe("This shows this shell's settings, not the running server's, and no cloud side: Flint isn't answering on this Mac.");
  });

  it('a 401 or a 403 is said, and is never a silent fall back to the offline status', async () => {
    for (const code of [401, 403]) {
      const r = await cli([], { env: { FLINT_TOKEN: 'WRONGTOKEN' }, server: () => ({ status: code, body: { error: 'unauthorized' } }) });
      expect(r.code).toBe(1);
      expect(r.stdout).toBe('');
      expect(r.offlineRuns).toBe(0);
      expect(r.stderr).toBe(`Flint refused this command's token (${code}), so its status was not read. Set FLINT_TOKEN, or put the token in the file ~/.flint/token.`);
      expect(r.stderr).not.toContain('WRONGTOKEN');
    }
  });

  it('a server that answers with an error is said too, exit 1', async () => {
    const r = await cli([], { env: { FLINT_TOKEN: 'tok' }, server: () => ({ status: 500, body: { error: 'Flint couldn’t read its status.' } }) });
    expect(r).toMatchObject({ code: 1, stdout: '', stderr: 'Flint answered 500, so its status was not read.', offlineRuns: 0 });
  });

  it('--json: stdout is the object and parses, with the server and without it; the note goes to stderr', async () => {
    const on = await cli(['--json'], { env: { FLINT_TOKEN: 'tok' }, server: live });
    expect(JSON.parse(on.stdout)).toEqual({ view: 'running_server', ...status });
    expect(on.stderr).toBe('');
    const off = await cli(['--json']);
    expect(off.code).toBe(0);
    // Built here: the object itself says so, since the sentence that says it goes to stderr.
    expect(JSON.parse(off.stdout)).toEqual({ view: 'this_shell', ...OFFLINE });
    expect(off.stderr).toContain("This shows this shell's settings, not the running server's");
  });

  it('--mode: the server is told, and the change is said on stdout before the status', async () => {
    const posted: unknown[] = [];
    const r = await cli(['--mode', 'local'], {
      env: { FLINT_TOKEN: 'tok' },
      server: (path, init) => {
        if (path === '/inference/mode') {
          posted.push(JSON.parse(String(init.body)));
          return { status: 200, body: { ok: true, mode: 'local', previous: 'hybrid' } };
        }
        return live(path);
      },
    });
    expect(posted).toEqual([{ mode: 'local', by: 'cli' }]);
    expect(r).toMatchObject({ code: 0, stderr: '' });
    expect(r.stdout).toBe(['The mode is now local (it was hybrid).', ...status.lines].join('\n'));
  });

  it('--mode reset asks the server to forget the saved choice', async () => {
    const posted: unknown[] = [];
    await cli(['--mode', 'reset'], {
      env: { FLINT_TOKEN: 'tok' },
      server: (path, init) => {
        if (path === '/inference/mode') posted.push(JSON.parse(String(init.body)));
        return path === '/inference/mode' ? { status: 200, body: { ok: true, mode: 'cloud', previous: 'local' } } : live(path);
      },
    });
    expect(posted).toEqual([{ reset: true, by: 'cli' }]);
  });

  it('--json with --mode: "The mode is now" goes to stderr, so stdout still parses', async () => {
    const r = await cli(['--json', '--mode', 'cloud'], {
      env: { FLINT_TOKEN: 'tok' },
      server: (path) => (path === '/inference/mode' ? { status: 200, body: { ok: true, mode: 'cloud', previous: 'local' } } : live(path)),
    });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ view: 'running_server', ...status });
    expect(r.stderr).toBe('The mode is now cloud (it was local).');
  });

  it('--mode with no token, with the server down, and with a refused token: nothing is changed, each says why, exit 1', async () => {
    const none = await cli(['--mode', 'local']);
    expect(none).toMatchObject({ code: 1, stdout: '', offlineRuns: 0 });
    expect(none.stderr).toBe('The mode was not changed: this command has no token for the running server. Set FLINT_TOKEN, or put the token in the file ~/.flint/token.');
    const down = await cli(['--mode', 'local'], { env: { FLINT_TOKEN: 'tok' } });
    expect(down).toMatchObject({ code: 1, stdout: '', offlineRuns: 0 });
    expect(down.stderr).toBe("The mode was not changed: Flint isn't answering on this Mac. Start Flint and run this again.");
    const refused = await cli(['--mode', 'local'], { env: { FLINT_TOKEN: 'WRONGTOKEN' }, server: () => ({ status: 401, body: {} }) });
    expect(refused).toMatchObject({ code: 1, stdout: '', offlineRuns: 0 });
    expect(refused.stderr).toBe("The mode was not changed: Flint refused this command's token (401). Set FLINT_TOKEN, or put the token in the file ~/.flint/token.");
    // One request, and no status after a change that did not happen.
    expect(refused.asked).toHaveLength(1);
  });

  it("--mode the server could not save: the server's own sentence, exit 1", async () => {
    const r = await cli(['--mode', 'local'], { env: { FLINT_TOKEN: 'tok' }, server: () => ({ status: 500, body: { error: 'Flint couldn’t change the mode.' } }) });
    expect(r).toMatchObject({ code: 1, stdout: '', stderr: 'The mode was not changed: Flint couldn’t change the mode.' });
    const odd = await cli(['--mode', 'local'], { env: { FLINT_TOKEN: 'tok' }, server: () => ({ status: 502, body: { error: { nested: 'x' } } }) });
    expect(odd.stderr).toBe('The mode was not changed: Flint answered 502.');
  });

  it("a mode's name comes from the three Flint knows, never from whatever a response carried", async () => {
    const r = await cli(['--mode', 'local'], {
      env: { FLINT_TOKEN: 'tok' },
      server: (path) => (path === '/inference/mode' ? { status: 200, body: { ok: true, mode: '\u001b[31mEVIL', previous: { a: 1 } } } : live(path)),
    });
    expect(r.stdout.split('\n')[0]).toBe('The mode is now unknown (it was unknown).');
  });

  it('arguments that are not understood: exit 2, a sentence on stderr, and what was typed is not in it', async () => {
    const r = await cli(['--token', 'SECRETSECRET'], { env: { FLINT_TOKEN: 'tok' }, server: live });
    expect(r).toMatchObject({ code: 2, stdout: '', offlineRuns: 0 });
    expect(r.asked).toEqual([]);
    expect(r.stderr).toBe('inference-status: an argument was not understood (use --json, or --mode <local|cloud|hybrid|reset>)');
    const bad = await cli(['--mode', 'SECRETSECRET']);
    expect(bad).toMatchObject({ code: 2, stderr: 'inference-status: --mode is one of local, cloud, hybrid, or reset' });
  });

  it('the token is in nothing the command prints, whatever happens', async () => {
    for (const server of [live, (): Reply => ({ status: 401, body: {} }), (): Reply => ({ status: 500, body: {} }), (): Reply => 'down']) {
      for (const argv of [[], ['--json'], ['--mode', 'local'], ['--bogus']]) {
        const r = await cli(argv, { env: { FLINT_TOKEN: 'TOKENSECRET' }, server });
        expect(r.stdout + r.stderr).not.toContain('TOKENSECRET');
      }
    }
  });
});

describe('the command itself', () => {
  const src = readFileSync(join(__dirname, '..', 'scripts', 'inference-status.ts'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

  it('is a package script', () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['inference-status']).toBe('tsx scripts/inference-status.ts');
  });

  // The final review's L8: the README said the output of `-- --json` parses, and pnpm's own two lines on stdout
  // made that false. Run with pnpm's --silent it is one JSON document (checked by hand on a scratch home).
  it('wherever the docs give the --json command, they give the one that prints only the object', () => {
    for (const file of [join(__dirname, '..', 'README.md'), join(__dirname, '..', '..', '..', 'README.md'), join(__dirname, '..', 'scripts', 'inference-status.ts')]) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/pnpm[^\n`]*inference-status -- --json/g)) expect(m[0], file).toBe('pnpm --silent --filter server inference-status -- --json');
    }
    expect(readFileSync(join(__dirname, '..', 'README.md'), 'utf8')).toContain('pnpm --silent --filter server inference-status -- --json');
  });

  it('never downloads a model and never runs a program: it prints the command for Will', () => {
    expect(code).not.toMatch(/child_process|execFile|spawn|\/api\/pull/);
    expect(src).toContain('It never downloads a model.');
  });

  it('never starts a model load: it builds the facade look-only, whatever the mode, and stops it', () => {
    expect(code).toContain("buildInference({ env, modeFile: join(home, '.flint', 'inference.json'), observeOnly: true })");
    expect(code).toContain('await inference.ready;');
    expect(code).toContain('inference.stop();');
    expect(code.match(/buildInference\(/g)).toHaveLength(1);
  });

  it('never prints the token, and never an error of unknown shape', () => {
    expect(code).not.toMatch(/console\.(log|error)\([^)]*token/i);
    expect(code).not.toMatch(/err(or)?\.message|String\(err/);
    expect(code).toContain("console.error('inference-status: the status could not be read.');");
  });
});
