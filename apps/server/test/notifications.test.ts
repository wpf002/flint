/**
 * Notifications (Machine plan P2: 0 ntfy payloads carry content). The phone
 * ping is the same request whatever the note says and whoever pushes it (the
 * runtime, the Watcher, the spend guard, "Action done"); a banner or a ping
 * never goes out without the in-app note; push() says what it did.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Notifications, PHONE_PING, RETIRED_KINDS, noteChannels, watcherEnabled } from '../src/notifications';
import { SpendGuard, SpendLedger, type ThresholdNotice } from '../src/spend';

function feed(topic: string | null = 'my-topic') {
  const pings: Array<{ url: string; init: RequestInit }> = [];
  const banners: Array<[string, string]> = [];
  let cancelled = 0;
  const path = join(mkdtempSync(join(tmpdir(), 'flint-notes-')), 'notifications.json');
  const fetchImpl = (async (url: string, init: RequestInit) => {
    pings.push({ url, init });
    const r = new Response('ok');
    const cancel = r.body!.cancel.bind(r.body);
    r.body!.cancel = (why?: unknown) => (cancelled++, cancel(why));
    return r;
  }) as unknown as typeof fetch;
  const notes = new Notifications(path, { topic: () => topic ?? undefined, fetchImpl, banner: (t, b) => banners.push([t, b]) });
  return { notes, pings, banners, path, cancelled: () => cancelled };
}

const settle = () => new Promise((r) => setTimeout(r, 10));

describe('the phone ping', () => {
  it('is the same request for every note: no title, no body, nothing about what happened', async () => {
    const f = feed();
    const cases: Array<[string, string, string]> = [
      ['Upcoming', 'Dentist with Dr. Smith is on Sat, Oct 4 at 2:00 PM, at 12 Main St.', 'calendar'],
      ['Claude (Anthropic) budget: 80% of today\'s cap', 'Flint has spent $8.00 of today’s $10.00 cap. Harder questions use a cheaper model, and background work waits.', 'budget'],
      ['Action done', 'An approved action is done.', 'action'],
      ['Service down', 'api has been down for 31 minutes', 'runtime'],
    ];
    for (const [t, b, k] of cases) expect(f.notes.push(t, b, k)).toEqual({ status: 'stored', pinged: true });
    await settle();
    expect(f.pings).toHaveLength(cases.length);
    for (const p of f.pings) {
      expect(p.url).toBe('https://ntfy.sh/my-topic');
      expect(p.init.method).toBe('POST');
      expect(p.init.headers).toEqual({ Title: PHONE_PING.title, Tags: PHONE_PING.tags });
      expect(p.init.body).toBe(PHONE_PING.body);
      // A timeout on the request, and its body is never left hanging.
      expect(p.init.signal).toBeInstanceOf(AbortSignal);
    }
    const sent = JSON.stringify(f.pings.map((p) => [p.init.headers, p.init.body]));
    for (const [t, b] of cases) {
      expect(sent).not.toContain(t);
      expect(sent).not.toContain(b);
    }
    expect(f.cancelled()).toBe(cases.length);
    // The words are kept in the console, and on this Mac's banner.
    expect(f.notes.list().map((n) => n.title)).toEqual(cases.map((c) => c[0]).reverse());
    expect(f.banners.map((b) => b[0])).toEqual(cases.map((c) => c[0]));
  });

  it('no topic: no ping, and push() says so', () => {
    const f = feed(null);
    expect(f.notes.push('x', 'y', 'system')).toEqual({ status: 'stored', pinged: false });
    expect(f.pings).toHaveLength(0);
  });

  it('only notifications.ts mentions ntfy.sh, and only once (deliverPhone)', () => {
    const dir = join(__dirname, '..', 'src');
    const hits = readdirSync(dir)
      .filter((f) => f.endsWith('.ts'))
      .flatMap((f) => (readFileSync(join(dir, f), 'utf8').match(/ntfy\.sh\//g) ?? []).map(() => f));
    expect(hits).toEqual(['notifications.ts']);
  });
});

describe('channels and what push() reports', () => {
  it('a banner or a push brings the in-app note; nothing named is all three', () => {
    expect(noteChannels()).toEqual(['inapp', 'banner', 'push']);
    expect(noteChannels([])).toEqual(['inapp', 'banner', 'push']);
    expect(noteChannels(['push'])).toEqual(['inapp', 'push']);
    expect(noteChannels(['banner'])).toEqual(['inapp', 'banner']);
    expect(noteChannels(['inapp'])).toEqual(['inapp']);
  });

  it('in-app only: stored, no banner, no ping', async () => {
    const f = feed();
    expect(f.notes.push('t', 'b', 'runtime', 'rt:a', { channels: ['inapp'] })).toEqual({ status: 'stored', pinged: false });
    await settle();
    expect(f.pings).toHaveLength(0);
    expect(f.banners).toHaveLength(0);
    expect(f.notes.unreadCount()).toBe(1);
  });

  it('a push alone is still stored in the console, so the ping never points at nothing', async () => {
    const f = feed();
    expect(f.notes.push('t', 'b', 'runtime', 'rt:b', { channels: ['push'] })).toEqual({ status: 'stored', pinged: true });
    expect(f.notes.list()).toHaveLength(1);
    expect(f.banners).toHaveLength(0);
  });

  it('a duplicate is reported as one (nothing sent), across a restart too; a raw payload is refused', async () => {
    const f = feed();
    expect(f.notes.push('t', 'b', 'runtime', 'rt:c').status).toBe('stored');
    expect(f.notes.push('t', 'b', 'runtime', 'rt:c')).toEqual({ status: 'duplicate', pinged: false });
    const again = new Notifications(f.path, { topic: () => 'my-topic', fetchImpl: (async () => new Response('')) as unknown as typeof fetch, banner: () => {} });
    expect(again.push('t', 'b', 'runtime', 'rt:c')).toEqual({ status: 'duplicate', pinged: false });
    expect(f.notes.push('t', ' {"raw": true}', 'runtime', 'rt:d')).toEqual({ status: 'refused', pinged: false });
    await settle();
    expect(f.pings).toHaveLength(1);
  });

  it("the spend guard's threshold hook hears about a newly stored notice, never one re-raised on boot", () => {
    const NOON = Date.parse('2026-10-02T17:00:00Z');
    const dir = mkdtempSync(join(tmpdir(), 'flint-thresh-'));
    const caps = { anthropic: { dailyUsd: 10 }, openai: {}, perplexity: {}, tavily: {} };
    const quiet = { topic: () => undefined, banner: () => {} };
    const seen: ThresholdNotice[] = [];
    const ledger = new SpendLedger({ dir, timeZone: 'America/Chicago', now: () => NOON });
    new SpendGuard(ledger, caps, new Notifications(join(dir, 'n.json'), quiet), { onThreshold: (t) => seen.push(t) });
    ledger.record({ vendor: 'anthropic', model: 'claude-sonnet-4-6', kind: 'chat', usd: 5 });
    ledger.record({ vendor: 'anthropic', model: 'claude-sonnet-4-6', kind: 'chat', usd: 0.5 });
    ledger.record({ vendor: 'anthropic', model: 'claude-sonnet-4-6', kind: 'chat', usd: 3 });
    expect(seen).toEqual([
      { vendor: 'anthropic', period: 'day', level: 'notice', key: 'spend:anthropic:daily:2026-10-02:50' },
      { vendor: 'anthropic', period: 'day', level: 'degrade', key: 'spend:anthropic:daily:2026-10-02:80' },
    ]);
    // A restart: the ledger is read back and every threshold re-checked; the feed already has them.
    const again: ThresholdNotice[] = [];
    const g = new SpendGuard(new SpendLedger({ dir, timeZone: 'America/Chicago', now: () => NOON }), caps, new Notifications(join(dir, 'n.json'), quiet), { onThreshold: (t) => again.push(t) });
    g.checkAll();
    expect(again).toEqual([]);
  });

  it('a failing ntfy request is swallowed: the note is still stored', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'flint-notes-')), 'n.json');
    const notes = new Notifications(path, { topic: () => 't', fetchImpl: (async () => { throw new Error('offline'); }) as unknown as typeof fetch, banner: () => {} });
    expect(notes.push('t', 'b', 'x')).toEqual({ status: 'stored', pinged: true });
    await settle();
    expect(notes.list()).toHaveLength(1);
  });
});

describe('the Watcher switch (P2.5: the runtime has the calendar)', () => {
  it('FLINT_WATCHER=off, in any case or spacing, or 0/false/no, turns it off; anything else leaves it on', () => {
    for (const v of ['off', 'OFF', ' off ', 'Off', '0', 'false', 'FALSE', 'no']) expect(watcherEnabled({ FLINT_WATCHER: v }), v).toBe(false);
    for (const v of [undefined, '', ' ', 'on', '1', 'true', 'yes', 'offline']) expect(watcherEnabled({ FLINT_WATCHER: v }), String(v)).toBe(true);
  });
});

describe('retired kinds', () => {
  it("the Nexus run watcher's leftover notes are kept in the file but never shown or counted", () => {
    const path = join(mkdtempSync(join(tmpdir(), 'flint-notes-')), 'notifications.json');
    writeFileSync(path, JSON.stringify({ seq: 2, items: [
      { id: 'n2', title: 'Nexus run finished', body: 'Build aqi: closed', kind: 'nexus', ts: 2, read: false },
      { id: 'n1', title: 'Market signal', body: 'A signal arrived.', kind: 'signal', ts: 1, read: false },
    ] }));
    const notes = new Notifications(path, {});
    expect(RETIRED_KINDS.has('nexus')).toBe(true);
    expect(notes.list().map((n) => n.id)).toEqual(['n1']);
    expect(notes.unreadCount()).toBe(1);
    notes.markAllRead();
    // Nothing is deleted: the retired note is still in the file.
    expect((JSON.parse(readFileSync(path, 'utf8')) as { items: Array<{ id: string }> }).items.map((n) => n.id)).toEqual(['n2', 'n1']);
  });
});
