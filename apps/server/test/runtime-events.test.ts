/**
 * Server -> runtime events (POST /v1/events): checked against the shared
 * contract before they are kept, spooled on disk (0600, bounded) so a runtime
 * outage loses nothing, sent in batches with ids the runtime dedupes on, one
 * flush at a time; a refused batch is bisected and only the event refused on
 * its own is set aside; a runtime older than P2 (404) drops them quietly.
 * Also what they say, and the tools a turn called. (A threshold event's hook
 * is tested with the notifications feed it depends on: notifications.test.ts.)
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ServerEventBatch, type ServerEvent } from '@flint/policy';
import type { Tool } from '@flint/core';
import { RuntimeEvents, chatTurnEvent, routeOf, thresholdEventId, type EventDraft } from '../src/runtime-events';
import { ActionQueue } from '../src/actions';
import { isSafeTool } from '../src/policy';
import { gateBuiltins } from '../src/tier-gate';
import { turnTools, withTurnTaint } from '../src/turn-taint';

const RT = { url: 'http://[::1]:8090', token: 'b'.repeat(64) };
const turn = (n = 0): EventDraft => ({ type: 'chat.turn', brain: 'local', outcome: 'answered', tools: [`t${n}`], ms: 100 + n, tainted: false });

/** A stub runtime: records each POST's events, answers with `status(events)`. */
function stubRuntime(status: (events: ServerEvent[], call: number) => number | 'throw' = () => 200) {
  const posts: ServerEvent[][] = [];
  let cancelled = 0;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    expect(url).toBe(`${RT.url}/v1/events`);
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${RT.token}`);
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const body = ServerEventBatch.parse(JSON.parse(String(init.body)));
    const s = status(body.events, posts.length);
    posts.push(body.events);
    if (s === 'throw') throw new Error('ECONNREFUSED');
    const r = new Response(JSON.stringify({ accepted: body.events.length, duplicates: 0 }), { status: s });
    const cancel = r.body!.cancel.bind(r.body);
    r.body!.cancel = (why?: unknown) => (cancelled++, cancel(why));
    return r;
  }) as unknown as typeof fetch;
  return { posts, fetchImpl, cancelled: () => cancelled };
}

let dir: string;
let logs: string[];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'flint-events-'));
  logs = [];
});
const make = (fetchImpl: typeof fetch, over: { maxBytes?: number; runtime?: () => typeof RT | undefined } = {}) =>
  new RuntimeEvents({ runtime: over.runtime ?? (() => RT), spoolDir: dir, fetchImpl, log: (m) => logs.push(m), ...(over.maxBytes ? { maxBytes: over.maxBytes } : {}), now: () => Date.parse('2026-10-02T15:00:00Z') });
const spooled = () => (existsSync(join(dir, 'events.jsonl')) ? readFileSync(join(dir, 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean) : []);

describe('pushing', () => {
  it('gives each event a 32-hex id and the server time, checks it against the contract, and spools it 0600', () => {
    const ev = make(stubRuntime().fetchImpl);
    expect(ev.push(turn())).toBe(true);
    const [line] = spooled();
    const e = JSON.parse(line!) as ServerEvent;
    expect(e.id).toMatch(/^[0-9a-f]{32}$/);
    expect(e.at).toBe('2026-10-02T15:00:00.000Z');
    expect(statSync(join(dir, 'events.jsonl')).mode & 0o777).toBe(0o600);
    // Off the contract (free text where a tool name goes): dropped, logged once, never sent.
    expect(ev.push({ ...turn(), tools: ['email Bob the quarterly numbers'] } as EventDraft)).toBe(false);
    expect(ev.push({ type: 'route.error', route: 'chat', status: 200 } as EventDraft)).toBe(false);
    expect(spooled()).toHaveLength(1);
    expect(logs.join('\n')).toMatch(/did not fit the contract/);
    expect(logs.join('\n')).not.toContain('Bob');
  });

  it('keeps nothing while the runtime is not installed', () => {
    const ev = make(stubRuntime().fetchImpl, { runtime: () => undefined });
    expect(ev.push(turn())).toBe(false);
    expect(spooled()).toEqual([]);
  });

  it('is bounded: past the cap chat turns are dropped and counted, spend and route events still have room', () => {
    const ev = make(stubRuntime().fetchImpl, { maxBytes: 1000 });
    let kept = 0;
    for (let i = 0; i < 20; i++) kept += ev.push(turn(i)) ? 1 : 0;
    expect(kept).toBeLessThan(20);
    expect(logs.some((l) => /spool is full; 1 event/.test(l))).toBe(true);
    expect(ev.push({ type: 'spend.threshold', vendor: 'anthropic', level: 'exhausted', period: 'day' })).toBe(true);
    expect(ev.push({ type: 'route.error', route: 'chat', status: 502 })).toBe(true);
  });
});

describe('flushing', () => {
  it('sends what is spooled in batches of at most 50 and empties the spool; every body is cancelled', async () => {
    const rt = stubRuntime();
    const ev = make(rt.fetchImpl);
    for (let i = 0; i < 120; i++) ev.push(turn(i));
    await ev.flush();
    expect(rt.posts.map((p) => p.length)).toEqual([50, 50, 20]);
    expect(rt.cancelled()).toBe(3);
    expect(spooled()).toEqual([]);
    expect(existsSync(join(dir, 'events.sending.jsonl'))).toBe(false);
    await ev.flush();
    expect(rt.posts).toHaveLength(3);
  });

  it('a runtime that is down, failing or not taking the token loses nothing: the same events (same ids) go next time, and only what was not taken', async () => {
    // What the runtime does with each POST, in order.
    const answers: Array<number | 'throw'> = ['throw', 200, 503, 401, 401, 200, 200];
    const rt = stubRuntime((_e, call) => answers[call]!);
    const ev = make(rt.fetchImpl);
    for (let i = 0; i < 70; i++) ev.push(turn(i));
    await ev.flush(); // POST 0 (50 events): refused connection, nothing taken
    await ev.flush(); // POST 1: the first 50 go in; POST 2 (the last 20): 503
    ev.push(turn(99)); // waits in the spool behind the 20
    await ev.flush(); // POST 3: 401
    await ev.flush(); // POST 4: 401 again (logged once)
    await ev.flush(); // POST 5: the 20 go in
    await ev.flush(); // POST 6: the new one
    expect(rt.posts.map((p) => p.length)).toEqual([50, 50, 20, 20, 20, 20, 1]);
    // Retried with the same ids; nothing taken is sent twice.
    expect(rt.posts[0]!.map((e) => e.id)).toEqual(rt.posts[1]!.map((e) => e.id));
    expect(rt.posts[2]!.map((e) => e.id)).toEqual(rt.posts[5]!.map((e) => e.id));
    const taken = [rt.posts[1]!, rt.posts[5]!, rt.posts[6]!].flat().map((e) => e.id);
    expect(new Set(taken).size).toBe(71);
    expect(spooled()).toEqual([]);
    expect(logs.filter((l) => /answered 401/.test(l))).toHaveLength(1);
    expect(logs.filter((l) => /answered 503/.test(l))).toHaveLength(1);
  });

  it('a refused batch (400) is resent one event at a time; only the event refused on its own is set aside', async () => {
    const rt = stubRuntime((events) => (events.some((e) => e.type === 'chat.turn' && e.ms === 107) ? 400 : 200));
    const ev = make(rt.fetchImpl);
    for (let i = 0; i < 10; i++) ev.push(turn(i));
    await ev.flush();
    const delivered = rt.posts.filter((p) => p.length === 1 && !(p[0]!.type === 'chat.turn' && p[0]!.ms === 107)).flat();
    expect(delivered).toHaveLength(9);
    const rejected = readFileSync(join(dir, 'events.rejected.jsonl'), 'utf8').trim().split('\n');
    expect(rejected).toHaveLength(1);
    expect(JSON.parse(rejected[0]!).ms).toBe(107);
    expect(statSync(join(dir, 'events.rejected.jsonl')).mode & 0o777).toBe(0o600);
    expect(logs.join('\n')).toMatch(/refused event [0-9a-f]{32} \(chat\.turn\)/);
    expect(spooled()).toEqual([]);
  });

  it('a runtime older than P2 (404) drops them quietly: one log line, never resent', async () => {
    const rt = stubRuntime(() => 404);
    const ev = make(rt.fetchImpl);
    ev.push(turn(1));
    await ev.flush();
    ev.push(turn(2));
    await ev.flush();
    expect(rt.posts).toHaveLength(2);
    expect(spooled()).toEqual([]);
    expect(existsSync(join(dir, 'events.sending.jsonl'))).toBe(false);
    expect(logs.filter((l) => /older than P2/.test(l))).toHaveLength(1);
  });

  it('one flush at a time: overlapping calls send each event once', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const posts: ServerEvent[][] = [];
    const slow = (async (_u: string, init: RequestInit) => {
      posts.push(ServerEventBatch.parse(JSON.parse(String(init.body))).events);
      await gate;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const ev = make(slow);
    for (let i = 0; i < 5; i++) ev.push(turn(i));
    const a = ev.flush();
    const b = ev.flush();
    expect(a).toBe(b);
    release();
    await Promise.all([a, b]);
    expect(posts.flat()).toHaveLength(5);
  });

  it('after a restart, what an earlier process spooled (or left half sent) is sent', async () => {
    const before = make(stubRuntime(() => 'throw').fetchImpl);
    before.push(turn(1));
    await before.flush(); // left in events.sending.jsonl
    before.push(turn(2)); // and one in events.jsonl
    const rt = stubRuntime();
    const after = make(rt.fetchImpl);
    await after.flush();
    await after.flush();
    expect(rt.posts.flat().map((e) => (e as { ms: number }).ms)).toEqual([101, 102]);
  });

  it('an unreadable spooled line is set aside, not sent and not fatal', async () => {
    writeFileSync(join(dir, 'events.sending.jsonl'), `not json\n${JSON.stringify({ id: 'x', type: 'chat.turn' })}\n`, { mode: 0o600 });
    const rt = stubRuntime();
    const ev = make(rt.fetchImpl);
    ev.push(turn(3));
    await ev.flush();
    await ev.flush();
    expect(rt.posts.flat()).toHaveLength(1);
    expect(readFileSync(join(dir, 'events.rejected.jsonl'), 'utf8').trim().split('\n')).toHaveLength(2);
  });
});

describe('what the events say', () => {
  it("a chat turn: the wire's outcome, tool names only (deduped, at most 30), time clamped", () => {
    const e = chatTurnEvent({ brain: 'frontier', outcome: 'error', tools: ['web.web_search', 'web.web_search', 'bad name!', ...Array.from({ length: 40 }, (_, i) => `t${i}`)], ms: 9e9, tainted: true });
    expect(e).toMatchObject({ type: 'chat.turn', brain: 'frontier', outcome: 'failed', ms: 3_600_000, tainted: true });
    expect((e as { tools: string[] }).tools).toHaveLength(30);
    expect((e as { tools: string[] }).tools[0]).toBe('web.web_search');
    expect(chatTurnEvent({ brain: 'local', outcome: 'aborted', tools: [], ms: -5, tainted: false })).toMatchObject({ brain: 'local', outcome: 'aborted', ms: 0 });
  });

  it("routes are named as the wire names them; the lanes proxy's (the runtime's own failures) are not reported", () => {
    expect(['/chat', '/generate', '/speak', '/transcribe', '/approvals/finish', '/proposals?x=1', '/proposals/run', '/notifications', '/'].map(routeOf)).toEqual([
      'chat', 'generate', 'speak', 'transcribe', 'approvals', 'proposals', 'proposals', 'other', 'other',
    ]);
    for (const p of ['/inbox?lane=quiet', '/inbox/td1/feedback', '/escalations/es1/ack', '/runtime/health']) expect(routeOf(p)).toBeUndefined();
  });

  it('a threshold is always the same event: its id comes from its notice key', () => {
    const k = 'spend:anthropic:daily:2026-10-02:80';
    expect(thresholdEventId(k)).toMatch(/^[0-9a-f]{32}$/);
    expect(thresholdEventId(k)).toBe(thresholdEventId(k));
    expect(thresholdEventId(k)).not.toBe(thresholdEventId('spend:anthropic:daily:2026-10-03:80'));
  });
});

describe('the tools a turn called', () => {
  const tool = (name: string, fn: (call: Parameters<Tool['handler']>[0]) => unknown): Tool => ({ definition: { name, description: name, inputSchema: { type: 'object' } }, handler: async (c) => fn(c) });

  it("are noted by the gate, refused and queued ones too, and deep_research's own calls count as the turn's", async () => {
    const queue = new ActionQueue(isSafeTool);
    const opts = { queue };
    const [calc] = gateBuiltins([tool('calculate', () => '4')], opts);
    const [remember] = gateBuiltins([tool('remember', () => 'saved')], opts);
    const [research] = gateBuiltins([tool('deep_research', async () => (await calc!.handler({ id: 'c', toolName: 'calculate', args: {} }), 'pack'))], opts);
    const tools = await withTurnTaint(async () => {
      await research!.handler({ id: 'r', toolName: 'deep_research', args: {} });
      await remember!.handler({ id: 'm', toolName: 'remember', args: { fact: 'x' } });
      return turnTools();
    });
    expect(tools).toEqual(['deep_research', 'calculate', 'remember']);
    // Each turn has its own list.
    expect(await withTurnTaint(async () => turnTools())).toEqual([]);
  });
});
