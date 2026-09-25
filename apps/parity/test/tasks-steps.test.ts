import { describe, expect, it } from 'vitest';
import type { GenerateArgs, ProviderAdapter } from '@flint/core';
import { BudgetGuard } from '../src/budget.js';
import { FatalError, flintContestant, preflightFlint, providerContestant } from '../src/contestants.js';
import type { FlintGrounding } from '../src/grounding.js';
import { JUDGE_SYSTEM, judgeUserMessage } from '../src/judge.js';
import type { Panelist } from '../src/panel.js';
import type { AnswerRow, JudgmentRow } from '../src/report.js';
import type { JudgeSetup } from '../src/steps.js';
import { competitorMessage, taskContext } from '../src/task-privacy.js';
import {
  answerWithContext,
  competitorWork,
  contextsFor,
  flintDiscovery,
  judgeFor,
  judgeTask,
  parseSlotsFile,
  selectionFor,
  taskPairs,
} from '../src/tasks-cli.js';
import { currentJudgments, renderTasksReport, tasksStrict } from '../src/tasks-report.js';
import type { TaskPrompt } from '../src/tasks.js';

const G: FlintGrounding = {
  memory: ['Will has a dog named Juno'],
  tools: [{ name: 'trident.gmail_search', isError: false, excerpt: '[{"subject":"Invoice due","from":"billing@example.com"}]' }],
};

const task = (over: Partial<TaskPrompt> = {}): TaskPrompt => ({
  id: 'gmail-triage-24~aaaa0000',
  prompt: 'Any important emails today?',
  category: 'task:gmail',
  templateId: 'gmail-triage-24',
  system: 'gmail',
  privacy: 'personal-comms',
  slots: {},
  great: 'Triages by importance.',
  tools: { need: [['trident.gmail_search']], ok: [] },
  memory: 'incidental',
  ...over,
});
const PUBLIC = task({ id: 'web-lookup-08~bbbb0000', templateId: 'web-lookup-08', system: 'web', category: 'task:web', privacy: 'public', tools: { need: [], ok: [] } });

const FLINT = { name: 'flint', model: 'flint@http://x' };
const row = (promptId: string, c: { name: string; model: string }, extra: Partial<AnswerRow> = {}): AnswerRow => ({
  promptId,
  contestant: c.name,
  model: c.model,
  ok: true,
  text: `${c.name} answer`,
  costUsd: 0,
  ms: 1,
  ts: Date.parse('2026-09-25T15:00:00Z'),
  ...extra,
});

/** A provider that records what it was sent and answers `reply`. */
function recorder(reply = '{"verdict":"TIE","reason":"same"}'): ProviderAdapter & { calls: GenerateArgs[] } {
  const calls: GenerateArgs[] = [];
  return {
    name: 'rec',
    calls,
    getCapabilities: () => ({ toolCalling: 'native', structuredOutput: 'native', streaming: 'full', maxContextTokens: 1, maxOutputTokens: 1 }),
    estimateTokens: () => 0,
    async generate(args) {
      calls.push(args);
      return { message: { id: 'm', role: 'assistant', content: reply, timestamp: 0 }, usage: { input: 1000, output: 100 }, reason: 'complete' };
    },
    // eslint-disable-next-line require-yield
    async *stream() {
      throw new Error('unused');
    },
  };
}

const reserve = () => {
  const budget = new BudgetGuard(10);
  return (e: number) => budget.reserve(e);
};

describe('competitors get the same data Flint had', () => {
  it('asks the competitor the request with the labelled context, and records the context hash', async () => {
    const rec = recorder('Nothing urgent: one invoice.');
    const comp = providerContestant({ name: 'claude', vendor: 'anthropic', model: 'claude-opus-5-5', provider: rec, maxTokens: 1000, system: 'You are a helpful assistant for Will.' });
    const ctx = taskContext(task(), G, 16_000);
    const r = await answerWithContext({ contestant: comp, prompt: task(), ctx, signal: new AbortController().signal, reserve: reserve() });
    expect(rec.calls[0]!.system).toBe('You are a helpful assistant for Will.');
    const msg = String(rec.calls[0]!.messages[0]!.content);
    expect(msg).toContain('<tool name="trident.gmail_search" status="ok">');
    expect(msg).toContain('Invoice due');
    expect(msg).not.toContain('Juno'); // incidental memory is withheld
    expect(msg.endsWith('<request>\nAny important emails today?\n</request>')).toBe(true);
    expect(r).toMatchObject({ kind: 'answered', row: { promptId: task().id, contestant: 'claude', text: 'Nothing urgent: one invoice.', meta: { contextSha: ctx.sha, privacy: 'personal-comms' } } });
  });

  it('budgets for the context, not just the request', () => {
    const comp = providerContestant({ name: 'openai', vendor: 'openai', model: 'gpt-5', provider: recorder(), maxTokens: 1000, system: 's' });
    const big: FlintGrounding = { memory: [], tools: [{ name: 'vantage.top_scores', isError: false, excerpt: 'x'.repeat(40_000) }] };
    const ctx = taskContext(task({ privacy: 'systems' }), big, 40_000);
    // answerWithContext asks with competitorMessage, so the estimate sees the whole context.
    expect(comp.estimate({ id: 'p', prompt: competitorMessage('q', ctx) })).toBeGreaterThan(comp.estimate({ id: 'p', prompt: 'q' }) + 0.01);
  });

  it('only asks allowed vendors, only where Flint answered, and re-asks when the context changed', () => {
    const openai = { name: 'openai', model: 'gpt-5' };
    const claude = { name: 'claude', model: 'claude-opus-5-5' };
    const failed = task({ id: 'gmail-triage-25~cccc0000', templateId: 'gmail-triage-25' });
    const flintRows = new Map([
      [task().id, row(task().id, FLINT, { grounding: G })],
      [PUBLIC.id, row(PUBLIC.id, FLINT, { grounding: { memory: [], tools: [] } })],
      [failed.id, row(failed.id, FLINT, { ok: false, error: 'timeout' })],
    ]);
    const contexts = contextsFor([task(), PUBLIC, failed], (id) => flintRows.get(id));
    expect([...contexts.keys()].sort()).toEqual([task().id, PUBLIC.id].sort());
    const cached = new Map([[`${PUBLIC.id}|claude`, row(PUBLIC.id, claude, { meta: { contextSha: contexts.get(PUBLIC.id)!.sha } })]]);
    const work = competitorWork({
      prompts: [task(), PUBLIC, failed],
      competitors: [openai, claude],
      contexts,
      personalVendors: ['anthropic'],
      cached: (id, c) => cached.get(`${id}|${c.name}`),
    });
    expect(work.map((w) => `${w.comp.name}:${w.p.templateId}`).sort()).toEqual(['claude:gmail-triage-24', 'openai:web-lookup-08']);
    // A cached answer on another context is stale: asked again.
    cached.set(`${PUBLIC.id}|claude`, row(PUBLIC.id, claude, { meta: { contextSha: 'old' } }));
    const again = competitorWork({ prompts: [PUBLIC], competitors: [claude], contexts, personalVendors: ['anthropic'], cached: (id, c) => cached.get(`${id}|${c.name}`) });
    expect(again).toHaveLength(1);
    // Shared with OpenAI: now it gets the personal prompt too.
    const shared = competitorWork({ prompts: [task()], competitors: [openai], contexts, personalVendors: ['anthropic', 'openai'], cached: () => undefined });
    expect(shared).toHaveLength(1);
  });

  it('judges only pairs answered on the current context, not yet judged', () => {
    const claude = { name: 'claude', model: 'claude-opus-5-5' };
    const flintRow = row(task().id, FLINT, { grounding: G });
    const contexts = contextsFor([task()], () => flintRow);
    const sha = contexts.get(task().id)!.sha;
    const pairs = (compRow: AnswerRow | undefined, judged = false) =>
      taskPairs({ prompts: [task()], competitors: [claude], contexts, flintAnswer: () => flintRow, answer: () => compRow, judged: () => judged });
    expect(pairs(row(task().id, claude, { meta: { contextSha: sha } }))).toHaveLength(1);
    expect(pairs(row(task().id, claude, { meta: { contextSha: 'stale' } }))).toHaveLength(0);
    expect(pairs(row(task().id, claude, { ok: false, meta: { contextSha: sha } }))).toHaveLength(0);
    expect(pairs(row(task().id, claude, { meta: { contextSha: sha } }), true)).toHaveLength(0);
  });
});

describe('judging a task', () => {
  const panelOf = (a: ProviderAdapter, o: ProviderAdapter): Panelist[] => [
    { vendor: 'anthropic', model: 'claude-opus-5-5', id: 'anthropic:claude-opus-5-5', provider: a },
    { vendor: 'openai', model: 'gpt-5', id: 'openai:gpt-5', provider: o },
  ];
  const setupOf = (panel: Panelist[]): JudgeSetup => ({ judgeModel: 'panel:anthropic:claude-opus-5-5+openai:gpt-5+grounded', model: 'panel:anthropic:claude-opus-5-5+openai:gpt-5', grounded: true, panel });

  it('drops panelists whose vendor may not see the prompt, and has no judge when none may', () => {
    const setup = setupOf(panelOf(recorder(), recorder()));
    expect(judgeFor(setup, { privacy: 'personal-comms' }, ['anthropic'])).toMatchObject({ excluded: ['openai:gpt-5'], setup: { panel: [{ id: 'anthropic:claude-opus-5-5' }] } });
    expect(judgeFor(setup, { privacy: 'public' }, ['anthropic']).excluded).toEqual([]);
    const openaiOnly: JudgeSetup = { ...setup, panel: [setup.panel![1]!] };
    expect(judgeFor(openaiOnly, { privacy: 'personal-comms' }, ['anthropic'])).toEqual({ excluded: ['openai:gpt-5'] });
  });

  it('shows allowed judges the shared context and the rubric, and never sends a personal prompt to OpenAI', async () => {
    const a = recorder('{"verdict":"A","reason":"better"}');
    const o = recorder('{"verdict":"A","reason":"better"}');
    const claude = { name: 'claude', model: 'claude-opus-5-5' };
    const ctx = taskContext(task(), G, 16_000);
    const r = await judgeTask({
      judge: setupOf(panelOf(a, o)),
      subject: 'flint',
      prompt: task({ reference: 'The invoice is the only urgent item.' }),
      competitor: claude,
      flintAnswer: row(task().id, FLINT, { grounding: G }),
      competitorAnswer: row(task().id, claude, { meta: { contextSha: ctx.sha } }),
      ctx,
      personalVendors: ['anthropic'],
      seed: 1,
      now: new Date('2026-09-25T16:00:00Z'),
      signal: new AbortController().signal,
      judgeMaxTokens: 4096,
      reserve: reserve(),
    });
    expect(o.calls).toHaveLength(0);
    expect(a.calls).toHaveLength(1);
    expect(a.calls[0]!.system).toBe(JUDGE_SYSTEM);
    const msg = String(a.calls[0]!.messages[0]!.content);
    expect(msg).toContain('<shared_context>');
    expect(msg).not.toContain('<flint_context>');
    expect(msg).toContain('Invoice due');
    expect(msg).not.toContain('Juno');
    expect(msg).toContain('<task_rubric>');
    expect(msg).toContain('Reference: The invoice is the only urgent item.');
    expect(r).toMatchObject({ kind: 'judged', row: { ok: true, contextSha: ctx.sha, privacy: 'personal-comms', excludedJudges: ['openai:gpt-5'], judgeModel: 'panel:anthropic:claude-opus-5-5+openai:gpt-5+grounded' } });
  });

  it('keeps the parity judge message byte-for-byte without extras', () => {
    const p = { id: 'x', prompt: 'hi', category: 'knowledge' };
    const now = new Date('2026-09-25T00:00:00Z');
    expect(judgeUserMessage(p, 'A1', 'B1', now)).toBe(judgeUserMessage(p, 'A1', 'B1', now, undefined, undefined));
    expect(judgeUserMessage(p, 'A1', 'B1', now, G)).toContain('<flint_context>');
    expect(judgeUserMessage(p, 'A1', 'B1', now, G)).not.toContain('<task_rubric>');
  });

  it('counts only verdicts on the current context', () => {
    const base: JudgmentRow = { subject: 'flint', promptId: task().id, category: 'task:gmail', competitor: 'claude', competitorModel: 'm', judgeModel: 'j', flintIsA: true, ok: true, outcome: 'win', verdict: 'A', costUsd: 0, ts: 1 };
    const contexts = new Map([[task().id, { sha: 'now' }]]);
    const rows = [
      { ...base, contextSha: 'old', outcome: 'loss' as const, ts: 2 },
      { ...base, contextSha: 'now', ts: 1 },
    ];
    expect(currentJudgments(rows, 'j', 'flint', contexts, new Set([task().id])).map((j) => j.outcome)).toEqual(['win']);
    expect(currentJudgments([{ ...base }], 'j', 'flint', contexts, new Set([task().id]))).toEqual([]);
  });
});

describe('strict accounting and the report', () => {
  it('counts a Flint failure as a loss against every competitor the task could go to', () => {
    const strict = tasksStrict({
      summaries: [],
      competitors: [
        { name: 'openai', model: 'gpt-5' },
        { name: 'claude', model: 'claude-opus-5-5' },
      ],
      flintFailed: [task(), PUBLIC],
      personalVendors: ['anthropic'],
    });
    expect(strict.find((s) => s.competitor === 'claude')).toMatchObject({ flintFailures: 2, total: { wins: 0, losses: 2, ties: 0 } });
    expect(strict.find((s) => s.competitor === 'openai')).toMatchObject({ flintFailures: 1 });
  });

  it('renders per-system win rates, tool selection, exclusions and failures', () => {
    const claude = { name: 'claude', model: 'claude-opus-5-5' };
    const flintRow = row(task().id, FLINT, { grounding: G, meta: { brain: 'frontier', proposed: [] } });
    const contexts = contextsFor([task(), PUBLIC], (id) => (id === task().id ? flintRow : undefined));
    const md = renderTasksReport({
      run: 'r1',
      taskSet: '/x/flint_tasks.jsonl',
      subject: 'flint',
      judgeModel: 'claude-opus-5-5+grounded',
      prompts: [task(), PUBLIC],
      contestants: [FLINT, claude, { name: 'openai', model: 'gpt-5' }],
      answers: [flintRow, row(PUBLIC.id, FLINT, { ok: false, error: 'flint HTTP 500' }), row(task().id, claude)],
      judgments: [
        { subject: 'flint', promptId: task().id, category: 'task:gmail', competitor: 'claude', competitorModel: 'claude-opus-5-5', judgeModel: 'claude-opus-5-5+grounded', flintIsA: true, ok: true, verdict: 'A', outcome: 'win', costUsd: 0.01, ts: 1, contextSha: contexts.get(task().id)!.sha },
      ],
      selection: selectionFor([task(), PUBLIC], (id) => (id === task().id ? flintRow : undefined)),
      contexts,
      exclusions: [{ promptId: task().id, templateId: 'gmail-triage-24', vendor: 'openai', role: 'competitor', privacy: 'personal-comms' }],
      personalVendors: ['anthropic'],
      contextChars: 16_000,
      spendUsd: 0.5,
      budgetUsd: 10,
      stoppedForBudget: false,
      notes: ['google skipped: no GEMINI_API_KEY in env or ~/.flint/secrets.env.'],
    });
    expect(md).toContain('| gmail | 1 | 100.0% (1-0-0) |');
    expect(md).toContain('Correct on 1/1 (100.0%)');
    expect(md).toContain('| openai | competitor | 1 | `gmail-triage-24~aaaa0000` |');
    expect(md).toContain('## Flint failures');
    expect(md).toContain('flint HTTP 500');
    expect(md).toContain('| claude | 1 | 1 | 1 |');
    expect(md).toContain('google skipped: no GEMINI_API_KEY');
    expect(md).toContain('Recalled memory withheld from competitors and judges on 1 task(s)');
  });
});

describe('Flint with longer excerpts (groundingChars)', () => {
  const body = (over: Record<string, unknown>) =>
    new Response(JSON.stringify({ text: 'ok', eval: true, brain: 'frontier', model: 'claude-opus-5-5', grounding: { memory: [], tools: [{ name: 'vantage.top_scores', isError: false, excerpt: 'y'.repeat(5000) }] }, ...over }), { status: 200 });

  it('asks for them, keeps them uncut, and records the length', async () => {
    const sent: unknown[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)));
      return body({ groundingChars: 16_000 });
    }) as typeof fetch;
    try {
      const f = flintContestant({ url: 'http://x', token: 't', frontierModel: 'claude-sonnet-5', allowTrainingLog: false, timeoutMs: 1000, requireGrounding: true, groundingChars: 16_000 });
      const res = await f.answer({ id: 'p', prompt: 'q' }, new AbortController().signal);
      expect(sent[0]).toMatchObject({ prompt: 'q', eval: true, groundingChars: 16_000 });
      expect(res.grounding!.tools[0]!.excerpt).toHaveLength(5000);
      expect(res.meta).toMatchObject({ groundingChars: 16_000 });
    } finally {
      globalThis.fetch = real;
    }
  });

  it('stops the run when the server ignores it', async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async () => body({})) as typeof fetch;
    try {
      const f = flintContestant({ url: 'http://x', token: 't', frontierModel: 'claude-sonnet-5', allowTrainingLog: false, timeoutMs: 1000, groundingChars: 16_000 });
      await expect(f.answer({ id: 'p', prompt: 'q' }, new AbortController().signal)).rejects.toBeInstanceOf(FatalError);
    } finally {
      globalThis.fetch = real;
    }
  });

  it('preflight: needs groundingCharsMax, within range, and evalDiscovery for the builder', async () => {
    const health = (h: Record<string, unknown>) => (async () => new Response(JSON.stringify({ ok: true, evalMode: true, ...h }), { status: 200 })) as unknown as typeof fetch;
    const base = { url: 'http://x', judgeOnly: false, allowTrainingLog: false };
    await expect(preflightFlint({ ...base, groundingChars: 16_000, fetchFn: health({}) })).rejects.toThrow(/--allow-short-context/);
    await expect(preflightFlint({ ...base, groundingChars: 40_000, fetchFn: health({ groundingCharsMax: 32_000 }) })).rejects.toThrow(/at most 32000/);
    await expect(preflightFlint({ ...base, groundingChars: 16_000, fetchFn: health({ groundingCharsMax: 32_000 }) })).resolves.toMatchObject({ groundingCharsMax: 32_000 });
    await expect(preflightFlint({ ...base, discovery: true, fetchFn: health({}) })).rejects.toThrow(/--no-discover/);
  });
});

describe('build-tasks helpers', () => {
  it('calls the server discovery endpoints with eval: true and the bearer token', async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      seen.push({ url, ...(init ? { init } : {}) });
      if (url.endsWith('/eval/tools')) return new Response(JSON.stringify({ tools: ['meridian.list_tickers'] }), { status: 200 });
      if (JSON.parse(String(init?.body)).name === 'nexus.thread_list') return new Response(JSON.stringify({ error: 'not wired' }), { status: 404 });
      return new Response(JSON.stringify({ ok: true, isError: false, text: '["NVDA"]' }), { status: 200 });
    }) as unknown as typeof fetch;
    const d = flintDiscovery('http://x/', 'tok', fetchFn);
    expect(await d.tools()).toEqual(['meridian.list_tickers']);
    expect(await d.call('meridian.list_tickers', {})).toEqual({ text: '["NVDA"]', isError: false });
    await expect(d.call('nexus.thread_list', { mine: false })).rejects.toThrow(/HTTP 404: not wired/);
    expect(seen[1]!.url).toBe('http://x/eval/tool');
    expect(JSON.parse(String(seen[1]!.init!.body))).toEqual({ eval: true, name: 'meridian.list_tickers', args: {} });
    expect((seen[1]!.init!.headers as Record<string, string>).authorization).toBe('Bearer tok');
  });

  it('parses a --slots file', () => {
    expect(parseSlotsFile('{"meridian_ticker":["NVDA",{"value":"AAPL","reference":"r"}]}')).toEqual({ meridian_ticker: ['NVDA', { value: 'AAPL', reference: 'r' }] });
    expect(() => parseSlotsFile('[]')).toThrow(/JSON object/);
    expect(() => parseSlotsFile('{"x":[]}')).toThrow(/non-empty/);
    expect(() => parseSlotsFile('{"x":[3]}')).toThrow(/neither a string/);
  });
});
