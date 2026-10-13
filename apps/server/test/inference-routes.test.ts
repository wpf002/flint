import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inferenceRoutes, type InferenceRouteDeps } from '../src/inference-routes';
import { ModeStore } from '../src/inference-mode';
import { scopeAllows } from '../src/access';
import type { InferenceStatus } from '../src/inference-status';

/**
 * The mode routes, over real HTTP on a loopback port: a strict body, a
 * sentence for anything else, a change that is saved and audited, and no way
 * in for a scoped token.
 */

let server: Server;
let base: string;
let dir: string;
let deps: InferenceRouteDeps;
let audits: Array<{ from: string; to: string; by: string; reset: boolean }>;
let refs: string[];
let statusCalls: number;
let failStatus: boolean;

const STATUS = { mode: 'cloud', lines: ['Flint is in Cloud mode.'] } as unknown as InferenceStatus;

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void inferenceRoutes(req, res, req.url ?? '/', deps).then((handled) => {
      if (!handled) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{"error":"not found"}');
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.close();
});
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'flint-inference-routes-'));
  audits = [];
  refs = [];
  statusCalls = 0;
  failStatus = false;
  const mode = new ModeStore({ file: join(dir, 'inference.json'), envMode: 'cloud', envSource: 'default' });
  deps = {
    mode,
    status: async () => {
      statusCalls += 1;
      if (failStatus) throw new Error('boom');
      return { ...STATUS, mode: mode.current() };
    },
    audit: (c) => audits.push(c),
    errorRef: (tag) => {
      refs.push(tag);
      return 'ref123';
    },
  };
  return () => rmSync(dir, { recursive: true, force: true });
});

const post = async (body: unknown, raw?: string) => {
  const res = await fetch(`${base}/inference/mode`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw ?? JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
};

describe('GET /inference', () => {
  it('is the status after a fresh look, never cached by a browser', async () => {
    const res = await fetch(`${base}/inference`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toMatchObject({ mode: 'cloud', lines: ['Flint is in Cloud mode.'] });
    expect(statusCalls).toBe(1);
  });

  it('a failure is a sentence and a reference, not the error', async () => {
    failStatus = true;
    const res = await fetch(`${base}/inference`);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Flint couldn’t read its status.', ref: 'ref123' });
    expect(refs).toEqual(['inference']);
  });
});

describe('POST /inference/mode', () => {
  it('switches the mode, saves it, and records who changed it from what to what', async () => {
    const r = await post({ mode: 'local' });
    expect(r).toEqual({ status: 200, json: { ok: true, mode: 'local', previous: 'cloud', source: 'settings' } });
    expect(deps.mode.current()).toBe('local');
    expect(audits).toEqual([{ from: 'cloud', to: 'local', by: 'console', reset: false }]);
    // Saved: a new store (a restart) reads it.
    expect(new ModeStore({ file: join(dir, 'inference.json'), envMode: 'cloud', envSource: 'default' }).current()).toBe('local');
  });

  it('the status command says it is the cli', async () => {
    await post({ mode: 'hybrid', by: 'cli' });
    expect(audits).toEqual([{ from: 'cloud', to: 'hybrid', by: 'cli', reset: false }]);
  });

  // The final review's L7: this saved the mode (so it wins over the environment from the next restart on) with no
  // log line and nothing on the audit trail.
  it('setting the mode it is already in SAVES it, and that is audited once: from and to are the same', async () => {
    const r = await post({ mode: 'cloud' });
    expect(r.json).toEqual({ ok: true, mode: 'cloud', previous: 'cloud', source: 'settings' });
    expect(audits).toEqual([{ from: 'cloud', to: 'cloud', by: 'console', reset: false }]);
    // Saved already: a second time changes nothing and audits nothing.
    await post({ mode: 'cloud' });
    expect(audits).toHaveLength(1);
    // Forgetting it again is a change of the same kind, and is audited too.
    const back = await post({ reset: true, by: 'cli' });
    expect(back.json).toEqual({ ok: true, mode: 'cloud', previous: 'cloud', source: 'default' });
    expect(audits.at(-1)).toEqual({ from: 'cloud', to: 'cloud', by: 'cli', reset: true });
    // A reset with nothing saved is nothing at all.
    await post({ reset: true });
    expect(audits).toHaveLength(2);
  });

  // The review's C5: the console showed the old mode until a second request had answered.
  it('the reply carries the two sentences the console shows for the mode now in force, when the server gives them', async () => {
    deps.sentences = () => ({ modeSentence: `Mode sentence for ${deps.mode.current()}.`, localOnlySentence: `Local Only sentence for ${deps.mode.current()}.` });
    const r = await post({ mode: 'local' });
    expect(r.json).toEqual({ ok: true, mode: 'local', previous: 'cloud', source: 'settings', modeSentence: 'Mode sentence for local.', localOnlySentence: 'Local Only sentence for local.' });
    // They are read AFTER the change, and after a reset too.
    expect((await post({ reset: true })).json).toMatchObject({ mode: 'cloud', modeSentence: 'Mode sentence for cloud.' });
    // A mode that could not be saved carries none.
    expect(Object.keys((await post({ mode: 'fast' })).json as object)).toEqual(['error']);
  });

  it('reset forgets the saved mode: back to the environment', async () => {
    await post({ mode: 'local' });
    const r = await post({ reset: true });
    expect(r).toEqual({ status: 200, json: { ok: true, mode: 'cloud', previous: 'local', source: 'default' } });
    expect(audits.at(-1)).toEqual({ from: 'local', to: 'cloud', by: 'console', reset: true });
  });

  it('anything but a known mode is a 400 with a sentence, and nothing changes', async () => {
    for (const body of [{ mode: 'fast' }, { mode: 'LOCAL' }, { mode: 'local', extra: 1 }, { mode: 'local', reset: true }, { reset: false }, {}, { mode: 1 }, { mode: 'local', by: 'model' }, ['local']]) {
      const r = await post(body);
      expect(r, JSON.stringify(body)).toEqual({ status: 400, json: { error: 'The mode is Local, Hybrid or Cloud.' } });
    }
    expect((await post(undefined, 'not json')).status).toBe(400);
    expect(deps.mode.current()).toBe('cloud');
    expect(audits).toEqual([]);
  });

  it('a body over the limit is refused', async () => {
    const r = await post(undefined, JSON.stringify({ mode: 'local', pad: 'x'.repeat(5000) }));
    expect(r.status).toBe(413);
    expect(deps.mode.current()).toBe('cloud');
  });

  it('a mode that cannot be saved is not switched to, and says so in a sentence', async () => {
    deps.mode = new ModeStore({ file: join(dir, 'no-such-dir', 'x', '\0bad', 'inference.json'), envMode: 'cloud', envSource: 'default' });
    const r = await post({ mode: 'local' });
    expect(r).toEqual({ status: 500, json: { error: 'Flint couldn’t save the mode.' } });
    expect(deps.mode.current()).toBe('cloud');
    expect(audits).toEqual([]);
  });

  it('other paths and methods are not handled here', async () => {
    expect((await fetch(`${base}/inference/mode`)).status).toBe(404);
    expect((await fetch(`${base}/inference`, { method: 'POST', body: '{}' })).status).toBe(404);
    expect((await fetch(`${base}/inference/other`)).status).toBe(404);
  });
});

describe('who may reach them', () => {
  it('only the full token: a voice or eval token is refused by the scope check', () => {
    for (const scope of ['voice', 'eval'] as const) {
      expect(scopeAllows(scope, 'GET', '/inference')).toBe(false);
      expect(scopeAllows(scope, 'POST', '/inference/mode')).toBe(false);
    }
    expect(scopeAllows('full', 'POST', '/inference/mode')).toBe(true);
  });
});
