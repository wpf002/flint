import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The connector reads its token from ~/.flint at import: a scratch HOME first,
// then the import (this file has its own module registry).
const HOME = mkdtempSync(join(tmpdir(), 'runtime-call-'));
const TOKEN = 'a'.repeat(64);
let mod: typeof import('../../connectors/runtime-server.js');

beforeAll(async () => {
  vi.stubEnv('HOME', HOME);
  vi.stubEnv('FLINT_RUNTIME_URL', undefined);
  mod = await import('../../connectors/runtime-server.js');
});
afterAll(() => {
  vi.unstubAllEnvs();
});

const withToken = () => {
  mkdirSync(join(HOME, '.flint', 'tokens'), { recursive: true });
  writeFileSync(join(HOME, '.flint', 'tokens', 'runtime-mcp.token'), `${TOKEN}\n`);
};

describe('runtimeCall', () => {
  it('without a token: the install hint, before any request (never the path it looked in)', async () => {
    let fetched = false;
    const r = mod.runtimeCall('/v1/triage/recent?limit=10', {}, (async () => {
      fetched = true;
      return new Response('{}');
    }) as typeof fetch);
    await expect(r).rejects.toThrow(/^the runtime connector token is missing \(run apps\/runtime\/install-runtime\.sh\)$/);
    expect(fetched).toBe(false);
  });

  it('GETs the loopback runtime with the bearer token and a timeout; a non-2xx answer is a RuntimeHttpError with its status', async () => {
    withToken();
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const answer = (body: string, status: number) =>
      (async (url: string, init: RequestInit) => {
        seen.push({ url, init });
        return new Response(body, { status });
      }) as unknown as typeof fetch;
    expect(await mod.runtimeCall('/v1/escalations/open?limit=3', {}, answer('{"escalations":[]}', 200))).toEqual({ escalations: [] });
    expect(seen[0]!.url).toBe('http://[::1]:8090/v1/escalations/open?limit=3');
    expect(seen[0]!.init.method).toBe('GET');
    expect((seen[0]!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    expect(seen[0]!.init.signal).toBeInstanceOf(AbortSignal);

    const notFound = await mod.runtimeCall('/v1/triage/decisions/x/explain', {}, answer('{"error":"no such decision"}', 404)).catch((e: unknown) => e);
    expect(notFound).toBeInstanceOf(mod.RuntimeHttpError);
    expect(notFound).toMatchObject({ status: 404, message: 'no such decision' });
    // A body that is not an object (or not JSON) still gives a status, not a TypeError.
    for (const body of ['null', 'not json', '']) {
      const e = await mod.runtimeCall('/v1/triage/recent', {}, answer(body, 502)).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(mod.RuntimeHttpError);
      expect(e).toMatchObject({ status: 502, message: 'runtime HTTP 502' });
    }
    // A 2xx body that is not JSON comes back as {}, which the front door's schemas refuse.
    expect(await mod.runtimeCall('/v1/triage/recent', {}, answer('<html>', 200))).toEqual({});
  });
});
