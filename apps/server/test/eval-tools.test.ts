import { describe, expect, it } from 'vitest';
import type { ActionEntry, Tool, ToolCall } from '@flint/core';
import {
  DISCOVERY_TOOLS,
  GROUNDING_CHARS_MAX,
  GROUNDING_CHARS_MIN,
  parseGroundingCharsRequest,
  parseRecallRequest,
  runDiscoveryTool,
  wiredToolNames,
  type DiscoveryAudit,
} from '../src/eval-tools';
import { TOOL_EXCERPT_CHARS, evalGrounding } from '../src/grounding';
import { isSafeTool } from '../src/policy';

function tool(name: string, handler: (call: ToolCall) => unknown): Tool & { calls: ToolCall[] } {
  const calls: ToolCall[] = [];
  return {
    calls,
    definition: { name, description: '', inputSchema: { type: 'object' } },
    handler: async (call) => {
      calls.push(call);
      return handler(call);
    },
  };
}

describe('groundingChars (eval-only longer tool excerpts)', () => {
  it('is absent for normal traffic', () => {
    expect(parseGroundingCharsRequest({ prompt: 'hi' })).toEqual({ ok: true, chars: undefined });
    expect(parseGroundingCharsRequest({ prompt: 'hi', eval: true, groundingChars: null })).toEqual({ ok: true, chars: undefined });
  });

  it('is accepted only with eval: true', () => {
    expect(parseGroundingCharsRequest({ eval: true, groundingChars: 16_000 })).toEqual({ ok: true, chars: 16_000 });
    expect(parseGroundingCharsRequest({ groundingChars: 16_000 })).toMatchObject({ ok: false, status: 400, error: expect.stringContaining('eval: true') });
  });

  it('must be an integer in range', () => {
    for (const bad of [GROUNDING_CHARS_MIN - 1, GROUNDING_CHARS_MAX + 1, 1000.5, '16000', -5]) {
      expect(parseGroundingCharsRequest({ eval: true, groundingChars: bad })).toMatchObject({ ok: false, status: 400 });
    }
    expect(parseGroundingCharsRequest({ eval: true, groundingChars: GROUNDING_CHARS_MIN })).toEqual({ ok: true, chars: GROUNDING_CHARS_MIN });
    expect(parseGroundingCharsRequest({ eval: true, groundingChars: GROUNDING_CHARS_MAX })).toEqual({ ok: true, chars: GROUNDING_CHARS_MAX });
  });

  it('cuts excerpts at the requested length, and at 800 by default', () => {
    const long = 'x'.repeat(5000);
    const entries: ActionEntry[] = [{ type: 'tool_result', requestId: 'r', timestamp: 0, tool: 'vantage.top_scores', result: long, isError: false, durationMs: 1 }];
    expect(evalGrounding([], entries).tools[0]!.excerpt).toHaveLength(TOOL_EXCERPT_CHARS);
    expect(evalGrounding([], entries, 4000).tools[0]!.excerpt).toHaveLength(4000);
    expect(evalGrounding([], entries, 16_000).tools[0]!.excerpt).toBe(long);
  });
});

describe('recall (eval-only: answer without long-term memory)', () => {
  it('is absent for normal traffic: memory is recalled as always, and nothing is echoed', () => {
    expect(parseRecallRequest({ prompt: 'hi' })).toEqual({ ok: true, recall: true, asked: false });
    expect(parseRecallRequest({ prompt: 'hi', eval: true, recall: null })).toEqual({ ok: true, recall: true, asked: false });
  });

  it('recall: false is accepted only with eval: true', () => {
    expect(parseRecallRequest({ eval: true, recall: false })).toEqual({ ok: true, recall: false, asked: true });
    expect(parseRecallRequest({ recall: false })).toMatchObject({ ok: false, status: 400, error: expect.stringContaining('eval: true') });
  });

  it('must be a boolean', () => {
    for (const bad of ['false', 0, 'no', {}]) expect(parseRecallRequest({ eval: true, recall: bad })).toMatchObject({ ok: false, status: 400 });
  });
});

describe('discovery (POST /eval/tool)', () => {
  it('every discovery tool is a read by the server gate, and none is a write', () => {
    for (const name of DISCOVERY_TOOLS) {
      expect(isSafeTool(name), name).toBe(true);
      expect(isSafeTool(name.slice(name.indexOf('.') + 1)), name).toBe(true);
    }
  });

  it('runs an allowlisted tool and returns its text, audited', async () => {
    const t = tool('meridian.list_tickers', () => '["NVDA","AAPL"]');
    const audits: DiscoveryAudit[] = [];
    const out = await runDiscoveryTool({ tools: [t], body: { eval: true, name: 'meridian.list_tickers' }, audit: (a) => audits.push(a) });
    expect(out).toEqual({ status: 200, body: { ok: true, name: 'meridian.list_tickers', isError: false, text: '["NVDA","AAPL"]' } });
    expect(t.calls[0]!.args).toEqual({});
    expect(audits).toMatchObject([{ name: 'meridian.list_tickers', isError: false }]);
  });

  it('passes args through and reports a tool error as isError', async () => {
    const t = tool('nexus.thread_list', () => ({ isError: true, content: 'unauthorized' }));
    const out = await runDiscoveryTool({ tools: [t], body: { eval: true, name: 'nexus.thread_list', args: { mine: false } } });
    expect(t.calls[0]!.args).toEqual({ mine: false });
    expect(out.body).toMatchObject({ ok: true, isError: true, text: 'unauthorized' });
  });

  it('refuses anything outside the allowlist before any handler runs, even a read', async () => {
    const write = tool('vantage.add_to_watchlist', () => 'added');
    const read = tool('vantage.get_score', () => 'NVDA 81');
    for (const name of ['vantage.add_to_watchlist', 'vantage.get_score', 'trident.gmail_search', 'remember']) {
      const out = await runDiscoveryTool({ tools: [write, read], body: { eval: true, name } });
      expect(out.status, name).toBe(403);
    }
    expect(write.calls).toHaveLength(0);
    expect(read.calls).toHaveLength(0);
  });

  it('is eval-only, needs a name and object args, and 404s an unwired tool', async () => {
    const t = tool('tdl.coverage', () => '{}');
    expect((await runDiscoveryTool({ tools: [t], body: { name: 'tdl.coverage' } })).status).toBe(400);
    expect((await runDiscoveryTool({ tools: [t], body: { eval: true } })).status).toBe(400);
    expect((await runDiscoveryTool({ tools: [t], body: { eval: true, name: 'tdl.coverage', args: ['x'] } })).status).toBe(400);
    expect((await runDiscoveryTool({ tools: [], body: { eval: true, name: 'tdl.coverage' } })).status).toBe(404);
    expect(t.calls).toHaveLength(0);
  });

  it('turns a throwing tool into a 502, audited as an error', async () => {
    const t = tool('prophet.list_models', () => {
      throw new Error('boom');
    });
    const audits: DiscoveryAudit[] = [];
    const out = await runDiscoveryTool({ tools: [t], body: { eval: true, name: 'prophet.list_models' }, audit: (a) => audits.push(a) });
    expect(out).toEqual({ status: 502, body: { error: 'prophet.list_models failed: boom' } });
    expect(audits).toMatchObject([{ name: 'prophet.list_models', isError: true }]);
  });

  it('cuts a long result to maxChars', async () => {
    const t = tool('vantage.top_scores', () => 'y'.repeat(50_000));
    const out = await runDiscoveryTool({ tools: [t], body: { eval: true, name: 'vantage.top_scores' }, maxChars: 1000 });
    expect(String(out.body.text)).toHaveLength(1000);
  });

  it('lists wired tool names sorted (GET /eval/tools)', () => {
    expect(wiredToolNames([tool('web.web_search', () => ''), tool('calculate', () => '')])).toEqual(['calculate', 'web.web_search']);
  });
});
