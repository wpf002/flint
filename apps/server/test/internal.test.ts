/**
 * The internal listener (the runtime's calls into the server): the token, a
 * note through the channels asked for (the in-app note always, a resent note a
 * duplicate, a raw payload refused), the chat load, and the metered complete
 * call's answer passed through as the gate gave it.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { LoadResponse, NotifyResponse, type NotifyChannel } from '@flint/policy';
import { startInternal, type ExternalSpend, type InternalDeps } from '../src/internal';
import { Notifications, PHONE_PING } from '../src/notifications';

const TOKEN = 'runtime-to-server-0123456789abcdef';
const sha = createHash('sha256').update(TOKEN).digest('hex');

let server: Server | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
});

async function listen(over: Partial<InternalDeps> = {}) {
  const deps: InternalDeps = {
    tokenSha256: () => sha,
    notify: () => ({ status: 'stored', pinged: false }),
    spendExternal: () => {},
    chatInFlight: () => 0,
    complete: async () => ({ status: 402, body: { error: 'capped', reason: 'kind_cap' } }),
    ...over,
  };
  server = startInternal(deps, 0);
  await new Promise((r) => server!.once('listening', r));
  const addr = server.address() as AddressInfo;
  const url = (p: string) => `http://[::1]:${addr.port}${p}`;
  const post = (p: string, body: unknown, token = TOKEN) =>
    fetch(url(p), { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  return { addr, post };
}

describe('internal listener', () => {
  it("listens on ::1 only, needs the runtime's token, and takes notify and spend-external", async () => {
    const notes: string[] = [];
    let spend: ExternalSpend | undefined;
    const { addr, post } = await listen({ notify: (n) => (notes.push(`${n.title}: ${n.body}`), { status: 'stored', pinged: false }), spendExternal: (x) => (spend = x) });
    expect(addr.address).toBe('::1');
    expect((await post('/internal/notify', { title: 'x' }, 'wrong-token-0123456789abcd')).status).toBe(401);
    expect((await post('/internal/notify', { title: 'Runtime', body: 'drill ok' })).status).toBe(200);
    expect(notes).toEqual(['Runtime: drill ok']);
    expect((await post('/internal/spend-external', { asOf: '2026-10-01', vendors: { anthropic: { dayUsd: 1.5, monthUsd: 20 }, 'bad key!': { dayUsd: 1, monthUsd: 1 }, openai: { dayUsd: -1, monthUsd: 0 } } })).status).toBe(200);
    expect(spend).toEqual({ asOf: '2026-10-01', vendors: { anthropic: { dayUsd: 1.5, monthUsd: 20 } } });
    expect((await post('/internal/notify', { title: 'x'.repeat(20_000) })).status).toBe(400);
    // Not JSON, or JSON that is not an object: a bad body, not a crash.
    expect((await post('/internal/notify', 'not json')).status).toBe(400);
    expect((await post('/internal/spend-external', 'null')).status).toBe(400);
  });

  it('refuses everything when no token is configured', async () => {
    const { post } = await listen({ tokenSha256: () => undefined });
    expect((await post('/internal/notify', {})).status).toBe(401);
  });
});

describe('/internal/notify', () => {
  /** A real Notifications feed with a stubbed phone and banner. */
  function feed() {
    const pings: Array<{ url: string; init: RequestInit }> = [];
    const banners: string[] = [];
    const notes = new Notifications(join(mkdtempSync(join(tmpdir(), 'flint-int-')), 'n.json'), {
      topic: () => 'flint-topic',
      fetchImpl: (async (url: string, init: RequestInit) => (pings.push({ url, init }), new Response('ok'))) as unknown as typeof fetch,
      banner: (t) => banners.push(t),
    });
    const seen: Array<{ channels: NotifyChannel[]; dedupe: string }> = [];
    const notify: InternalDeps['notify'] = (n) => (seen.push({ channels: n.channels, dedupe: n.dedupe }), notes.push(n.title, n.body, 'runtime', n.dedupe, { channels: n.channels }));
    return { notes, pings, banners, seen, notify };
  }

  it('no channels is the P1 behaviour: in-app, banner and a content-free ping', async () => {
    const f = feed();
    const { post } = await listen({ notify: f.notify });
    const r = await post('/internal/notify', { title: 'offsite failed', body: 'see the log' });
    expect(r.status).toBe(200);
    expect(NotifyResponse.parse(await r.json())).toEqual({ ok: true, stored: true, pinged: true });
    expect(f.seen[0]!.channels).toEqual(['inapp', 'banner', 'push']);
    expect(f.notes.list()[0]).toMatchObject({ title: 'offsite failed', body: 'see the log', kind: 'runtime' });
    expect(f.banners).toEqual(['offsite failed']);
    expect(f.pings).toHaveLength(1);
    expect(f.pings[0]!.init.body).toBe(PHONE_PING.body);
  });

  it('a banner or a push always brings the in-app note; in-app alone pings nothing', async () => {
    const f = feed();
    const { post } = await listen({ notify: f.notify });
    expect(await (await post('/internal/notify', { title: 'a', channels: ['push'], ref: 'es1' })).json()).toEqual({ ok: true, stored: true, pinged: true });
    expect(f.seen[0]!.channels).toEqual(['inapp', 'push']);
    expect(await (await post('/internal/notify', { title: 'b', channels: ['banner'], ref: 'es2' })).json()).toEqual({ ok: true, stored: true, pinged: false });
    expect(f.seen[1]!.channels).toEqual(['inapp', 'banner']);
    expect(await (await post('/internal/notify', { title: 'c', channels: ['inapp'], ref: 'es3' })).json()).toEqual({ ok: true, stored: true, pinged: false });
    expect(f.notes.list().map((n) => n.title)).toEqual(['c', 'b', 'a']);
    expect(f.pings).toHaveLength(1);
    expect(f.banners).toEqual(['b']);
  });

  it('a resent note with the same ref is a duplicate (no second note, no second ping); without a ref each is new', async () => {
    const f = feed();
    const { post } = await listen({ notify: f.notify });
    const send = (b: unknown) => post('/internal/notify', b).then((r) => r.json());
    expect(await send({ title: 'Service down', channels: ['inapp', 'push'], ref: 'cmabc123' })).toEqual({ ok: true, stored: true, pinged: true });
    expect(await send({ title: 'Service down', channels: ['inapp', 'push'], ref: 'cmabc123' })).toEqual({ ok: true, stored: false, pinged: false });
    expect(f.seen.map((s) => s.dedupe)).toEqual(['rt:cmabc123', 'rt:cmabc123']);
    // Two notes in the same millisecond without a ref are still two notes.
    await Promise.all([send({ title: 'x' }), send({ title: 'x' })]);
    expect(f.notes.list()).toHaveLength(3);
    expect(f.pings).toHaveLength(3);
  });

  it('redacts, refuses a raw payload (422) and anything off the contract (400)', async () => {
    const f = feed();
    const { post } = await listen({ notify: f.notify });
    expect((await post('/internal/notify', { title: 'offsite failed', body: 'pg_dump: sk-ant-api03-abcdefghijklmnopqrstuv' })).status).toBe(200);
    expect(f.notes.list()[0]!.body).not.toMatch(/sk-ant-api03/);
    expect((await post('/internal/notify', { title: 'x', body: '{"raw":1}' })).status).toBe(422);
    expect((await post('/internal/notify', { title: 'x', channels: ['sms'] })).status).toBe(400);
    expect((await post('/internal/notify', { title: 'x', channels: [] })).status).toBe(400);
    expect((await post('/internal/notify', { title: 'x', ref: 'has spaces' })).status).toBe(400);
    expect((await post('/internal/notify', { title: 'x', extra: 1 })).status).toBe(400);
    expect((await post('/internal/notify', { title: '' })).status).toBe(400);
    expect(f.pings).toHaveLength(1);
  });

  it('a note the feed refuses is a 422, never "stored"', async () => {
    const { post } = await listen({ notify: () => ({ status: 'refused', pinged: false }) });
    expect((await post('/internal/notify', { title: 'x' })).status).toBe(422);
  });
});

describe('/internal/load and /internal/complete', () => {
  it('load answers the chat turns in flight, as the wire contract has it', async () => {
    let n = 2;
    const { post } = await listen({ chatInFlight: () => n });
    expect(LoadResponse.parse(await (await post('/internal/load', {})).json())).toEqual({ chatInFlight: 2 });
    n = 0;
    expect(await (await post('/internal/load', {})).json()).toEqual({ chatInFlight: 0 });
    expect((await post('/internal/load', {}, 'wrong-token-0123456789abcd')).status).toBe(401);
  });

  it("complete passes the body to the gate and answers with the gate's status and body", async () => {
    const bodies: unknown[] = [];
    const { post } = await listen({
      complete: async (b) => {
        bodies.push(b);
        return (b as { kind?: string }).kind === 'runtime'
          ? { status: 402, body: { error: 'the runtime spend kind is capped at $0', reason: 'kind_cap' } }
          : { status: 200, body: { text: 'ok', usage: { input: 1, output: 1 }, costUsd: 0 } };
      },
    });
    const refused = await post('/internal/complete', { kind: 'runtime', ref: 'es1', system: '', prompt: 'p', maxTokens: 10 });
    expect(refused.status).toBe(402);
    expect(await refused.json()).toEqual({ error: 'the runtime spend kind is capped at $0', reason: 'kind_cap' });
    expect((await post('/internal/complete', { kind: 'review' })).status).toBe(200);
    expect(bodies).toHaveLength(2);
  });
});
