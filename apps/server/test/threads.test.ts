/**
 * The console sidebar's chat history (../src/threads): GET /threads lists the
 * conversations with a complete turn, newest first, at most 100, titled by the
 * first user message; GET /threads/:id reads one back as text only (never an
 * attachment body). index.ts runs main() on import, so the wiring is checked
 * by reading its source, as index-wiring.test.ts does.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeAiError, type Attachment, type Message, type Turn } from '@flint/core';
import { PersistentStore } from '../src/persistent-store';
import { THREAD_LIMIT, TITLE_MAX, listThreads, readThread, threadTitle, type ThreadSource } from '../src/threads';

const BODY = 'iVBORw0KGgoAAAANSUhEUgSECRETBODY';
const TEXT_BODY = 'the whole text file, which must never leave';
const IMG: Attachment = { kind: 'image', mediaType: 'image/png', name: 'chart.png', data: BODY, bytes: 24 };
const DOC: Attachment = { kind: 'text', mediaType: 'text/markdown', name: 'notes.md', text: TEXT_BODY, bytes: 40 };

let n = 0;
const msg = (role: Message['role'], content: string, over: Partial<Message> = {}): Message => ({ id: `m${++n}`, role, content, timestamp: 1, ...over });

/** A turn: the user's message, then (when complete) the given response messages. */
function turn(
  at: number,
  user: string,
  over: { status?: Turn['status']; reply?: Message[]; attachments?: Attachment[]; updatedAt?: number; conversationId?: string } = {},
): Turn {
  const status = over.status ?? 'complete';
  const u = msg('user', user, over.attachments ? { attachments: over.attachments } : {});
  const reply = status === 'complete' ? (over.reply ?? [msg('assistant', `re: ${user}`)]) : [];
  return {
    id: `t${++n}`,
    conversationId: over.conversationId ?? 'c',
    status,
    messages: [u, ...reply],
    createdAt: at,
    updatedAt: over.updatedAt ?? at + 5,
  };
}

/** A fake store over a plain map, in insertion order like PersistentStore. */
function store(convos: Record<string, Turn[]>): ThreadSource {
  return {
    conversationIds: () => Object.keys(convos),
    getTurns: async (id) => structuredClone(convos[id] ?? []),
  };
}

describe('threadTitle', () => {
  it('is the first user message, whitespace collapsed and trimmed, never re-cased', () => {
    expect(threadTitle([turn(1, '  What is\n\tthe   WEATHER in nyc?  ')])).toBe('What is the WEATHER in nyc?');
  });

  it('cuts a long message to 60 characters plus "…"', () => {
    const long = 'a'.repeat(TITLE_MAX + 25);
    expect(threadTitle([turn(1, long)])).toBe(`${'a'.repeat(TITLE_MAX)}…`);
    // Exactly 60 is not cut.
    expect(threadTitle([turn(1, 'b'.repeat(TITLE_MAX))])).toBe('b'.repeat(TITLE_MAX));
    // Collapsing comes first: 70 characters of mostly spaces fit once collapsed.
    expect(threadTitle([turn(1, `${'x '.repeat(20)}${' '.repeat(30)}`)])).toBe('x '.repeat(20).trim());
    // A cut that lands on a space leaves none before the "…".
    const spaced = `${'w'.repeat(TITLE_MAX - 1)} and then some more words`;
    expect(threadTitle([turn(1, spaced)])).toBe(`${'w'.repeat(TITLE_MAX - 1)}…`);
  });

  it('never splits an emoji at the cut', () => {
    const t = threadTitle([turn(1, `${'🙂'.repeat(TITLE_MAX)}🙂🙂`)]);
    expect(t).toBe(`${'🙂'.repeat(TITLE_MAX)}…`);
    expect(Array.from(t)).toHaveLength(TITLE_MAX + 1);
  });

  it('titles an attachment-only first message by its first named attachment', () => {
    expect(threadTitle([turn(1, '', { attachments: [IMG, DOC] })])).toBe('chart.png');
    expect(threadTitle([turn(1, '   \n', { attachments: [{ kind: 'image', mediaType: 'image/png' }, DOC] })])).toBe('notes.md');
    expect(threadTitle([turn(1, '', { attachments: [{ kind: 'image', mediaType: 'image/png', name: `${'n'.repeat(70)}.png` }] })])).toBe(`${'n'.repeat(60)}…`);
  });

  it('is "Untitled" for an empty message, or one whose attachments have no name', () => {
    expect(threadTitle([turn(1, '')])).toBe('Untitled');
    expect(threadTitle([turn(1, ' \n\t ')])).toBe('Untitled');
    expect(threadTitle([turn(1, '', { attachments: [{ kind: 'document', mediaType: 'application/pdf', data: BODY }] })])).toBe('Untitled');
    expect(threadTitle([])).toBe('Untitled');
  });

  it('comes from the first complete turn, not a failed or pending one before it', () => {
    expect(threadTitle([turn(1, 'failed first', { status: 'failed' }), turn(2, 'pending', { status: 'pending' }), turn(3, 'Real question')])).toBe('Real question');
  });
});

describe('listThreads', () => {
  it('lists every conversation with a complete turn, newest first by its last complete turn', async () => {
    const s = store({
      old: [turn(100, 'old one')],
      mid: [turn(50, 'mid first'), turn(300, 'mid again')],
      fresh: [turn(500, 'fresh')],
    });
    const threads = await listThreads(s);
    expect(threads).toEqual([
      { id: 'fresh', title: 'fresh', updatedAt: 505, turns: 1 },
      { id: 'mid', title: 'mid first', updatedAt: 305, turns: 2 },
      { id: 'old', title: 'old one', updatedAt: 105, turns: 1 },
    ]);
  });

  it('breaks a tie on time by id, so the order is stable', async () => {
    const s = store({ b: [turn(10, 'b', { updatedAt: 99 })], a: [turn(10, 'a', { updatedAt: 99 })] });
    expect((await listThreads(s)).map((t) => t.id)).toEqual(['a', 'b']);
  });

  it('lists at most 100, the newest', async () => {
    const convos: Record<string, Turn[]> = {};
    for (let i = 0; i < THREAD_LIMIT + 50; i++) convos[`c${i}`] = [turn(i * 10, `q${i}`)];
    const threads = await listThreads(store(convos));
    expect(THREAD_LIMIT).toBe(100);
    expect(threads).toHaveLength(100);
    expect(threads[0]!.id).toBe(`c${THREAD_LIMIT + 49}`);
    expect(threads[99]!.id).toBe('c50');
  });

  it('leaves out pending and failed turns: from the count, the time, and the list', async () => {
    const s = store({
      mixed: [turn(10, 'ok one'), turn(20, 'broke', { status: 'failed' }), turn(30, 'ok two'), turn(900, 'in flight', { status: 'pending' })],
      onlyFailed: [turn(1000, 'never answered', { status: 'failed' })],
      onlyPending: [turn(2000, 'still going', { status: 'pending' })],
      empty: [],
    });
    expect(await listThreads(s)).toEqual([{ id: 'mixed', title: 'ok one', updatedAt: 35, turns: 2 }]);
  });

  it('leaves out ids GET /threads/:id would refuse, so every listed thread opens', async () => {
    const s = store({ 'seed:1': [turn(10, 'x')], 'has space': [turn(20, 'y')], ok_id: [turn(5, 'z')] });
    expect((await listThreads(s)).map((t) => t.id)).toEqual(['ok_id']);
  });
});

describe('readThread', () => {
  it("returns the complete turns in order: the user's text, the final answer, attachment names and kinds", async () => {
    const s = store({
      c1: [
        turn(10, 'Look at this', { attachments: [IMG, DOC], reply: [msg('assistant', 'A chart and some notes.')] }),
        turn(20, 'lost', { status: 'failed' }),
        turn(30, 'And now?'),
        turn(40, 'typing', { status: 'pending' }),
      ],
    });
    const r = await readThread(s, 'c1');
    expect(r).toEqual({
      status: 200,
      body: {
        id: 'c1',
        title: 'Look at this',
        turns: [
          { ts: 10, user: 'Look at this', assistant: 'A chart and some notes.', attachments: [{ name: 'chart.png', kind: 'image' }, { name: 'notes.md', kind: 'text' }] },
          { ts: 30, user: 'And now?', assistant: 're: And now?', attachments: [] },
        ],
      },
    });
  });

  it('never carries an attachment body, or anything but its name and kind', async () => {
    const s = store({ c: [turn(1, '', { attachments: [IMG, DOC, { kind: 'document', mediaType: 'application/pdf', data: BODY }] })] });
    const r = await readThread(s, 'c');
    const wire = JSON.stringify(r.body) + JSON.stringify(await listThreads(s));
    expect(wire).not.toContain(BODY);
    expect(wire).not.toContain(TEXT_BODY);
    expect(wire).not.toMatch(/"(mediaType|data|bytes|text)":/);
    if (r.status !== 200) throw new Error('expected 200');
    for (const a of r.body.turns[0]!.attachments) expect(Object.keys(a).sort()).toEqual(['kind', 'name']);
    expect(r.body.turns[0]!.attachments[2]).toEqual({ name: 'unnamed', kind: 'document' });
  });

  it("is the assistant's final text: not the tool calls or tool results along the way", async () => {
    const toolTurn = msg('tool', JSON.stringify({ text: 'Let me check.', toolCalls: [{ id: 'call1', toolName: 'web_search', args: { q: 'x' } }] }));
    const result = msg('tool_result', JSON.stringify({ secret: 'raw tool output' }), { toolCallId: 'call1' });
    const s = store({
      final: [turn(1, 'q', { reply: [toolTurn, result, msg('assistant', 'It is sunny.')] })],
      toolOnly: [turn(1, 'q', { reply: [toolTurn, result] })],
      malformed: [turn(1, 'q', { reply: [msg('tool', 'not json'), msg('assistant', 'Still answered.')] })],
    });
    const answer = async (id: string) => {
      const r = await readThread(s, id);
      if (r.status !== 200) throw new Error(`expected 200 for ${id}`);
      return r.body.turns[0]!.assistant;
    };
    expect(await answer('final')).toBe('It is sunny.');
    expect(await answer('toolOnly')).toBe('Let me check.');
    expect(await answer('malformed')).toBe('Still answered.');
  });

  it('is 404 for an unknown id, or one with no complete turn', async () => {
    const s = store({ failed: [turn(1, 'x', { status: 'failed' })], pending: [turn(1, 'y', { status: 'pending' })] });
    for (const id of ['nope', 'failed', 'pending']) {
      expect(await readThread(s, id)).toEqual({ status: 404, body: { error: 'no such thread' } });
    }
  });

  it('is 400 for an id that is not 1-80 of A-Z a-z 0-9 _ -', async () => {
    const s = store({ ok: [turn(1, 'x')], [`${'a'.repeat(80)}`]: [turn(1, 'y')] });
    for (const id of ['', 'a/b', '../etc', 'a b', 'a.b', '%41', 'é', 'a'.repeat(81), 'x?y=1']) {
      expect(await readThread(s, id)).toEqual({ status: 400, body: { error: 'bad thread id' } });
    }
    expect((await readThread(s, 'a'.repeat(80))).status).toBe(200);
    expect((await readThread(s, 'Ok_-9')).status).toBe(404);
  });
});

describe('over the real conversation store', () => {
  let dir: string | undefined;
  afterEach(() => {
    vi.useRealTimers(); // drops the store's pending save, so nothing is written after the dir goes
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('reads what PersistentStore holds, bodies still in RAM included, without them', async () => {
    vi.useFakeTimers();
    dir = mkdtempSync(join(tmpdir(), 'flint-threads-'));
    const s = new PersistentStore(join(dir, 'c.json'), { history: null });
    const ask = async (cid: string, tid: string, text: string, at: number, ok: boolean, attachments?: Attachment[]) => {
      await s.beginTurn({ conversationId: cid, turnId: tid, userMessage: msg('user', text, attachments ? { attachments } : {}), createdAt: at });
      if (ok) {
        await s.commitTurn({ conversationId: cid, turnId: tid, responseMessages: [msg('assistant', `answer ${tid}`)], usage: { input: 1, output: 1 }, updatedAt: at + 1 });
      } else {
        await s.failTurn({ conversationId: cid, turnId: tid, error: makeAiError('internal', 'boom', { retryable: false }), updatedAt: at + 1 });
      }
    };
    await ask('c1', 't1', '', 100, true, [IMG]);
    await ask('c1', 't2', 'follow up', 200, true);
    await ask('c2', 't3', 'gone wrong', 300, false);
    await ask('c3', 't4', 'Newest', 400, true);

    expect(await listThreads(s)).toEqual([
      { id: 'c3', title: 'Newest', updatedAt: 401, turns: 1 },
      { id: 'c1', title: 'chart.png', updatedAt: 201, turns: 2 },
    ]);
    const r = await readThread(s, 'c1');
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toContain(BODY);
    if (r.status === 200) expect(r.body.turns.map((t) => [t.ts, t.user, t.assistant, t.attachments])).toEqual([
      [100, '', 'answer t1', [{ name: 'chart.png', kind: 'image' }]],
      [200, 'follow up', 'answer t2', []],
    ]);
    expect(await readThread(s, 'c2')).toEqual({ status: 404, body: { error: 'no such thread' } });
  });
});

describe('index.ts wiring', () => {
  const src = readFileSync(join(__dirname, '..', 'src', 'index.ts'), 'utf8');
  const auth = src.indexOf('bearerScope(req.headers.authorization');
  const scopeCheck = src.indexOf('if (!scopeAllows(scope');
  const conversations = src.indexOf("url.startsWith('/conversations')");
  const list = src.indexOf("url === '/threads'");
  const one = src.indexOf("url.startsWith('/threads/')");
  const next = src.indexOf("url === '/transcribe'");

  it('serves both routes after the bearer and scope checks, right after GET /conversations', () => {
    for (const i of [auth, scopeCheck, conversations, list, one, next]) expect(i).toBeGreaterThan(0);
    expect(auth).toBeLessThan(scopeCheck);
    expect(scopeCheck).toBeLessThan(conversations);
    expect(conversations).toBeLessThan(list);
    expect(list).toBeLessThan(one);
    expect(one).toBeLessThan(next);
    // Nothing before the auth check answers for /threads.
    expect(src.slice(0, auth)).not.toMatch(/['"`]\/threads/);
    // Each is matched exactly once.
    expect(src.match(/url === '\/threads'/g)).toHaveLength(1);
    expect(src.match(/url\.startsWith\('\/threads\/'\)/g)).toHaveLength(1);
  });

  it('answers through json() from the conversation store, GET only, with no CORS', () => {
    const block = src.slice(list - 200, next);
    expect(block).toContain("req.method === 'GET' && (url === '/threads' || url.startsWith('/threads?'))");
    expect(block).toContain("req.method === 'GET' && url.startsWith('/threads/')");
    expect(block).toContain('return json(res, 200, { threads: await listThreads(ctx.memory) });');
    expect(block).toContain('return json(res, thread.status, thread.body);');
    expect(block).toContain('readThread(ctx.memory,');
    expect(block).not.toMatch(/Access-Control|writeHead/);
    expect(src).toContain("import { listThreads, readThread } from './threads';");
  });
});
