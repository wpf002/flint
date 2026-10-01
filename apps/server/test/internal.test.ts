import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { startInternal, type ExternalSpend } from '../src/internal';

const TOKEN = 'runtime-to-server-0123456789abcdef';
const sha = createHash('sha256').update(TOKEN).digest('hex');

describe('internal listener', () => {
  it('listens on ::1 only, needs the runtime\'s token, and takes notify and spend-external', async () => {
    const notes: string[] = [];
    let spend: ExternalSpend | undefined;
    const s = startInternal({ tokenSha256: () => sha, notify: (t, b) => notes.push(`${t}: ${b}`), spendExternal: (x) => (spend = x) }, 0);
    await new Promise((r) => s.once('listening', r));
    const addr = s.address() as AddressInfo;
    expect(addr.address).toBe('::1');
    const url = (p: string) => `http://[::1]:${addr.port}${p}`;
    const post = (p: string, body: unknown, token = TOKEN) => fetch(url(p), { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    expect((await post('/internal/notify', { title: 'x' }, 'wrong-token-0123456789abcd')).status).toBe(401);
    expect((await post('/internal/notify', { title: 'Runtime', body: 'drill ok' })).status).toBe(200);
    expect(notes).toEqual(['Runtime: drill ok']);
    expect((await post('/internal/spend-external', { asOf: '2026-10-01', vendors: { anthropic: { dayUsd: 1.5, monthUsd: 20 }, 'bad key!': { dayUsd: 1, monthUsd: 1 }, openai: { dayUsd: -1, monthUsd: 0 } } })).status).toBe(200);
    expect(spend).toEqual({ asOf: '2026-10-01', vendors: { anthropic: { dayUsd: 1.5, monthUsd: 20 } } });
    expect((await post('/internal/notify', { title: 'x'.repeat(20_000) })).status).toBe(400);
    s.close();
  });

  it('refuses everything when no token is configured', async () => {
    const s = startInternal({ tokenSha256: () => undefined, notify: () => {}, spendExternal: () => {} }, 0);
    await new Promise((r) => s.once('listening', r));
    const r = await fetch(`http://[::1]:${(s.address() as AddressInfo).port}/internal/notify`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` }, body: '{}' });
    expect(r.status).toBe(401);
    s.close();
  });
});
