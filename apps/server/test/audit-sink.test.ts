/**
 * The server's audit spool (Machine plan 3.0.7): redacted, 0600, intents on
 * disk before the action, capped, shipped in batches, and nothing lost while
 * the runtime is down or refusing.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditSink } from '../src/audit-sink';

const base = { actor: 'flint', context: 'chat' as const, kind: 'decision' as const, action: 'web.fetch_url', outcome: 'pending' as const, inputs: { rule: 'tainted' } };
const spool = () => mkdtempSync(join(tmpdir(), 'flint-spool-'));

describe('AuditSink', () => {
  it('writes redacted lines to a 0600 file in a 0700 directory, this process\'s tokens included', () => {
    const dir = spool();
    const tok = 'f'.repeat(64);
    const sink = new AuditSink({ spoolDir: dir, secrets: () => [tok] });
    sink.record({ ...base, reasoning: `saw Bearer abcdefgh12345678 and ${tok}` }, true);
    const file = join(dir, 'audit.jsonl');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    const line = readFileSync(file, 'utf8');
    expect(line).not.toContain(tok);
    expect(line).not.toContain('abcdefgh12345678');
    expect(JSON.parse(line)).toMatchObject({ action: 'web.fetch_url', id: expect.stringMatching(/^au/) });
  });

  it('stops at the cap instead of growing without bound, and says so', () => {
    const dir = spool();
    const logs: string[] = [];
    const sink = new AuditSink({ spoolDir: dir, maxBytes: 600, log: (m) => logs.push(m) });
    for (let i = 0; i < 20; i++) sink.record(base);
    expect(statSync(join(dir, 'audit.jsonl')).size).toBeLessThanOrEqual(600);
    expect(logs[0]).toMatch(/spool is full/);
  });

  it('does nothing until the runtime is installed', async () => {
    const dir = spool();
    let calls = 0;
    const sink = new AuditSink({ spoolDir: dir, fetchImpl: (async () => (calls++, new Response('{}'))) as typeof fetch });
    sink.record(base);
    await sink.flush();
    expect(calls).toBe(0);
    expect(existsSync(join(dir, 'audit.jsonl'))).toBe(true);
  });

  it('ships in batches of 100 and clears the spool only when every batch is in', async () => {
    const dir = spool();
    const batches: number[] = [];
    let fail = true;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      if (url.endsWith('/v1/audit')) {
        const n = (JSON.parse(String(init.body)) as unknown[]).length;
        if (fail && batches.length === 1) return new Response('', { status: 503 });
        batches.push(n);
      }
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    const sink = new AuditSink({ spoolDir: dir, runtime: () => ({ url: 'http://[::1]:8090', token: 't'.repeat(64) }), fetchImpl });
    for (let i = 0; i < 250; i++) sink.record({ ...base, inputs: { i } });
    await sink.flush();
    // The second batch failed: the shipping file stays, nothing is lost.
    expect(existsSync(join(dir, 'audit.shipping.jsonl'))).toBe(true);
    sink.record({ ...base, inputs: { late: true } }); // new entries go to a fresh spool meanwhile
    fail = false;
    batches.length = 0;
    await sink.flush(); // retries the whole shipping file (replays are ignored by the runtime)
    expect(batches).toEqual([100, 100, 50]);
    expect(existsSync(join(dir, 'audit.shipping.jsonl'))).toBe(false);
    await sink.flush(); // then the late one
    expect(batches).toEqual([100, 100, 50, 1]);
  });

  it('counts read-only calls and ships the counts, keeping them if the runtime is down', async () => {
    const dir = spool();
    const sent: unknown[] = [];
    let up = false;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      if (!up) throw new Error('ECONNREFUSED');
      if (url.endsWith('/v1/audit/rollup')) sent.push(JSON.parse(String(init.body)));
      return new Response('{}');
    }) as typeof fetch;
    const sink = new AuditSink({ spoolDir: dir, runtime: () => ({ url: 'http://[::1]:8090', token: 't' }), fetchImpl, tz: 'UTC' });
    sink.count('web.web_search', 'chat');
    sink.count('web.web_search', 'chat');
    await sink.flush();
    up = true;
    await sink.flush();
    expect(sent).toEqual([{ batchId: expect.stringMatching(/^[0-9a-f]{32}$/), rows: [{ day: new Date().toISOString().slice(0, 10), action: 'web.web_search', context: 'chat', n: 2 }] }]);
  });
});
