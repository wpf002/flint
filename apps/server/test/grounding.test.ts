import { describe, expect, it } from 'vitest';
import { ActionLogObserver, type ActionEntry } from '@flint/core';
import {
  TOOL_EXCERPT_CHARS,
  entriesSince,
  evalGrounding,
  groundingTools,
  markLog,
  recallContext,
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

describe('markLog / entriesSince', () => {
  it("returns only this turn's entries", () => {
    const log = new ActionLogObserver(undefined, 2000);
    logTool(log, 'before', 'old');
    const mark = markLog(log.actions());
    logTool(log, 'web_search', 'sunny');
    expect(groundingTools(entriesSince(log.actions(), mark))).toEqual([{ name: 'web_search', isError: false, excerpt: 'sunny' }]);
  });

  it('works from an empty log', () => {
    const log = new ActionLogObserver(undefined, 2000);
    const mark = markLog(log.actions());
    logTool(log, 'web_search', 'sunny');
    expect(entriesSince(log.actions(), mark)).toHaveLength(1);
  });

  it('still finds the turn once the ring buffer is full (where a length index finds nothing)', () => {
    const log = new ActionLogObserver(undefined, 5);
    for (let i = 0; i < 5; i++) logTool(log, `old${i}`, 'x');
    const beforeLen = log.actions().length;
    const mark = markLog(log.actions());
    logTool(log, 'web_search', 'sunny');
    logTool(log, 'gmail.search', 'inbox');
    // The index approach (toolsSince) sees nothing: the length stayed at 5.
    expect(log.actions().slice(beforeLen)).toHaveLength(0);
    expect(groundingTools(entriesSince(log.actions(), mark)).map((t) => t.name)).toEqual(['web_search', 'gmail.search']);
  });

  it('returns everything left when the marked entry itself was evicted', () => {
    const log = new ActionLogObserver(undefined, 3);
    logTool(log, 'old', 'x');
    const mark = markLog(log.actions());
    for (let i = 0; i < 4; i++) logTool(log, `new${i}`, 'y');
    expect(entriesSince(log.actions(), mark).map((e) => (e as { tool: string }).tool)).toEqual(['new1', 'new2', 'new3']);
  });
});
