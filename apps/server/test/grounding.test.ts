import { describe, expect, it } from 'vitest';
import { ActionLogObserver, Flint, type ActionEntry, type GenerateArgs, type ProviderAdapter, type StreamEvent, type Tool } from '@flint/core';
import {
  TOOL_EXCERPT_CHARS,
  TurnLog,
  evalGrounding,
  groundingTools,
  recallContext,
  recordTurnEntry,
  toolExcerpt,
  withMemory,
} from '../src/grounding';

const result = (tool: string, res: unknown, isError = false): ActionEntry => ({
  type: 'tool_result',
  requestId: 'r',
  timestamp: 0,
  tool,
  result: res,
  isError,
  durationMs: 1,
});
const call = (tool: string): ActionEntry => ({ type: 'tool_call', requestId: 'r', timestamp: 0, tool, args: {}, idempotent: true });
const request = (): ActionEntry => ({ type: 'request', requestId: 'r', timestamp: 0, model: 'm', kind: 'generate', toolNames: [] });

/** Feed entries into a real ActionLogObserver through its observer hooks. */
function logTool(log: ActionLogObserver, tool: string, res: unknown, isError = false): void {
  log.onToolResult({
    requestId: 'r',
    provider: 'p',
    model: 'm',
    timestamp: 0,
    context: {},
    toolCallId: 'c',
    toolName: tool,
    result: res,
    isError,
    durationMs: 1,
  } as never);
}

describe('context block (withMemory / recallContext)', () => {
  const base = '[Context — not a user message: now.]';

  it('is exactly the block contextFor has always built', () => {
    expect(withMemory(base, [])).toBe(base);
    expect(withMemory(base, ['Will has a dog named Juno', 'Will lives in Dallas'])).toBe(
      `${base}\n[Long-term memory — things you already know about Will; use if relevant, don't recite back:\n- Will has a dog named Juno\n- Will lives in Dallas\n]`,
    );
  });

  it('returns the recalled facts with the block', async () => {
    const r = await recallContext(base, 'dog?', { recall: async () => ['Will has a dog named Juno'] });
    expect(r.facts).toEqual(['Will has a dog named Juno']);
    expect(r.block).toBe(withMemory(base, r.facts));
  });

  it('treats a failed recall as no memory, not an error', async () => {
    const r = await recallContext(base, 'dog?', {
      recall: async () => {
        throw new Error('embedder down');
      },
    });
    expect(r).toEqual({ block: base, facts: [] });
  });

  it('skip (eval recall: false) never reads memory, and the block is the no-memory block', async () => {
    let asked = 0;
    const knowledge = {
      recall: async () => {
        asked++;
        return ['Will is going to UFC 330 with Mike'];
      },
    };
    expect(await recallContext(base, 'Hey Flint, how is it going?', knowledge, { skip: true })).toEqual({ block: base, facts: [] });
    expect(asked).toBe(0);
    // Without it, recall runs as always.
    expect((await recallContext(base, 'Hey Flint, how is it going?', knowledge)).facts).toEqual(['Will is going to UFC 330 with Mike']);
    expect(asked).toBe(1);
  });
});

describe('toolExcerpt', () => {
  it('uses a string result as is and JSON for anything else', () => {
    expect(toolExcerpt('  72°F and sunny  ')).toBe('72°F and sunny');
    expect(toolExcerpt({ score: 81, ticker: 'NVDA' })).toBe('{"score":81,"ticker":"NVDA"}');
    expect(toolExcerpt([1, 2])).toBe('[1,2]');
    expect(toolExcerpt(undefined)).toBe('');
    expect(toolExcerpt(null)).toBe('');
  });

  it("uses an MCP error's content", () => {
    expect(toolExcerpt({ isError: true, content: 'rate limited' })).toBe('rate limited');
  });

  it('cuts long results to at most 800 characters, marking the cut', () => {
    const long = 'x'.repeat(5000);
    const e = toolExcerpt(long);
    expect(TOOL_EXCERPT_CHARS).toBe(800);
    expect(e.length).toBe(800);
    expect(e.endsWith('…')).toBe(true);
    expect(toolExcerpt('y'.repeat(800))).toBe('y'.repeat(800));
  });

  it('never ends on half a surrogate pair', () => {
    const e = toolExcerpt('a'.repeat(798) + '😀' + 'b'.repeat(10));
    expect(e.length).toBeLessThanOrEqual(800);
    expect(e).toBe('a'.repeat(798) + '…');
  });

  it('survives a value JSON cannot encode', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(toolExcerpt(cyclic)).toBe('[object Object]');
  });
});

describe('groundingTools / evalGrounding', () => {
  it('keeps tool results only, in order, with name, error flag and excerpt', () => {
    const entries = [request(), call('web_search'), result('web_search', 'sunny'), call('vantage.score'), result('vantage.score', { error: 'nope' }, true)];
    expect(groundingTools(entries)).toEqual([
      { name: 'web_search', isError: false, excerpt: 'sunny' },
      { name: 'vantage.score', isError: true, excerpt: '{"error":"nope"}' },
    ]);
    expect(evalGrounding(['fact'], entries)).toEqual({ memory: ['fact'], tools: groundingTools(entries) });
    expect(evalGrounding([], [])).toEqual({ memory: [], tools: [] });
  });
});

/**
 * A provider that, for the user message "<name>", calls the tool `<name>_tool`
 * once and then answers "done". What the server's personas run on, minus the model.
 */
function toolCallingProvider(): ProviderAdapter {
  return {
    name: 'mock',
    getCapabilities: () => ({ toolCalling: 'native', structuredOutput: 'native', streaming: 'full', maxContextTokens: 100_000, maxOutputTokens: 4096 }),
    estimateTokens: (m) => m.reduce((n, x) => n + String(x.content).length, 0),
    async generate() {
      throw new Error('unused');
    },
    async *stream(args: GenerateArgs): AsyncIterable<StreamEvent> {
      if (!args.messages.some((m) => m.role === 'tool_result')) {
        const who = String(args.messages.find((m) => m.role === 'user')?.content ?? '');
        yield { type: 'tool_call', call: { id: `c-${who}`, toolName: `${who}_tool`, args: {} } };
        yield { type: 'done', reason: 'tool_call', usage: { input: 1, output: 1 } };
      } else {
        yield { type: 'text', delta: 'done' };
        yield { type: 'done', reason: 'complete', usage: { input: 1, output: 1 } };
      }
    },
  };
}

const tool = (name: string, handler: () => Promise<unknown>): Tool => ({
  definition: { name, description: name, inputSchema: { type: 'object' }, idempotent: true },
  handler,
});

const toolNames = (t: TurnLog): string[] => t.grounding([]).tools.map((x) => x.name);

describe('TurnLog: a turn sees its own tool results, not a concurrent turn\'s', () => {
  it('keeps overlapping turns apart on one shared action log (an eval answer while Will chats)', async () => {
    // Like the server: one action log, several Flint instances (local brain, tiers) observing into it.
    const log = new ActionLogObserver(recordTurnEntry, 2000);
    const flint = () => new Flint({ provider: toolCallingProvider(), defaultModel: 'm', observer: log });
    // Every tool waits until all three are in flight, and the eval turn's tool returns last,
    // so the other two turns' results are logged while the eval turn is still running.
    let started = 0;
    let allStarted!: () => void;
    const barrier = new Promise<void>((r) => (allStarted = r));
    const gated = (name: string, result: string, extraMs = 0) =>
      tool(name, async () => {
        if (++started === 3) allStarted();
        await barrier;
        if (extraMs) await new Promise((r) => setTimeout(r, extraMs));
        return result;
      });
    const evalTurn = new TurnLog();
    const otherEval = new TurnLog();
    const before = log.actions().length;
    await Promise.all([
      evalTurn.run(() => flint().generate({ prompt: 'eval', tools: [gated('eval_tool', 'Dallas: 72°F', 30)] })),
      otherEval.run(() => flint().generate({ prompt: 'other', tools: [gated('other_tool', 'NVDA 81')] })),
      // A /chat turn: not in any TurnLog.
      flint().generate({ prompt: 'chat', tools: [gated('chat_tool', "Will's inbox: 3 unread from Sam")] }),
    ]);

    expect(evalTurn.grounding(['fact'])).toEqual({ memory: ['fact'], tools: [{ name: 'eval_tool', isError: false, excerpt: 'Dallas: 72°F' }] });
    expect(toolNames(otherEval)).toEqual(['other_tool']);
    // Reading the shared log for the duration of the eval turn (what a mark or an index does)
    // picks up both other turns, Will's inbox included.
    expect(groundingTools(log.actions().slice(before)).map((t) => t.name).sort()).toEqual(['chat_tool', 'eval_tool', 'other_tool']);
  });

  it('holds when turns queue for the same Flint instance (the slot handoff keeps each turn its own)', async () => {
    const log = new ActionLogObserver(recordTurnEntry, 2000);
    const shared = new Flint({ provider: toolCallingProvider(), defaultModel: 'm', observer: log, maxConcurrent: 1 });
    const slow = tool('a_tool', () => new Promise((r) => setTimeout(() => r('a'), 10)));
    const fast = tool('b_tool', async () => 'b');
    const a = new TurnLog();
    const b = new TurnLog();
    await Promise.all([a.run(() => shared.generate({ prompt: 'a', tools: [slow] })), b.run(() => shared.generate({ prompt: 'b', tools: [fast] }))]);
    expect(toolNames(a)).toEqual(['a_tool']);
    expect(toolNames(b)).toEqual(['b_tool']);
  });

  it('collects every run() of the turn (a tier fallback asks again)', async () => {
    const log = new ActionLogObserver(recordTurnEntry, 2000);
    const turn = new TurnLog();
    await turn.run(async () => logTool(log, 'web_search', 'first try'));
    await turn.run(async () => logTool(log, 'vantage.score', { score: 81 }));
    expect(turn.grounding([]).tools).toEqual([
      { name: 'web_search', isError: false, excerpt: 'first try' },
      { name: 'vantage.score', isError: false, excerpt: '{"score":81}' },
    ]);
  });

  it("doesn't depend on the action log's ring buffer (once full, an index taken before the turn finds nothing)", async () => {
    const log = new ActionLogObserver(recordTurnEntry, 3);
    for (let i = 0; i < 3; i++) logTool(log, `old${i}`, 'x');
    const beforeLen = log.actions().length;
    const turn = new TurnLog();
    await turn.run(async () => {
      for (let i = 0; i < 5; i++) logTool(log, `t${i}`, 'y');
    });
    expect(log.actions().slice(beforeLen)).toHaveLength(0);
    expect(toolNames(turn)).toEqual(['t0', 't1', 't2', 't3', 't4']);
  });

  it('stops recording once the turn is over, even for work it started that outlives it', async () => {
    const log = new ActionLogObserver(recordTurnEntry, 2000);
    const turn = new TurnLog();
    let late!: Promise<void>;
    await turn.run(async () => {
      logTool(log, 'web_search', 'in time');
      // Carries the turn's async context past its end.
      late = new Promise((r) => setTimeout(() => (logTool(log, 'late', 'after'), r()), 5));
    });
    await late;
    expect(toolNames(turn)).toEqual(['web_search']);
    expect(log.actions()).toHaveLength(2);
  });

  it('files an entry logged outside any turn nowhere but the log', () => {
    const log = new ActionLogObserver(recordTurnEntry, 2000);
    expect(() => logTool(log, 'web_search', 'x')).not.toThrow();
    expect(log.actions()).toHaveLength(1);
    expect(toolNames(new TurnLog())).toEqual([]);
  });
});
