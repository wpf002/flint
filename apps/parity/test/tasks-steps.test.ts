import { describe, expect, it } from 'vitest';
import type { GenerateArgs, ProviderAdapter } from '@flint/core';
import { BudgetGuard } from '../src/budget.js';
import { FatalError, flintContestant, preflightFlint, providerContestant } from '../src/contestants.js';
import type { FlintGrounding } from '../src/grounding.js';
import { JUDGE_SYSTEM, judgeUserMessage } from '../src/judge.js';
import type { ModelCheck } from '../src/model-currency.js';
import type { Panelist } from '../src/panel.js';
import { summarize, type AnswerRow, type JudgmentRow } from '../src/report.js';
import type { JudgeSetup } from '../src/steps.js';
import { competitorMessage, DEFAULT_SHARING, taskContext, type Sharing } from '../src/task-privacy.js';
import {
  answerWithContext,
  competitorWork,
  contextsFor,
  defaultJudgePanel,
  flintAnswerStale,
  flintDiscovery,
  judgeFor,
  judgeTask,
  parseSlotsFile,
  resolveModel,
  selectionFor,
  taskPairs,
  TASK_MODEL_DEFAULTS,
} from '../src/tasks-cli.js';
import {
  currentJudgments,
  renderTasksReport,
  tasksHistoryRows,
  tasksSelectionStrict,
  tasksStrict,
  TASKS_HISTORY_HEADER,
  type TasksReportInput,
} from '../src/tasks-report.js';
import type { TaskPrompt } from '../src/tasks.js';
import type { ToolSelection } from '../src/tool-selection.js';

const G: FlintGrounding = {
  memory: ['Will has a dog named Juno'],
  tools: [{ name: 'trident.gmail_search', isError: false, excerpt: '[{"subject":"Invoice due","from":"billing@example.com"}]' }],
};
/** What Flint had when answered with `recall: false`: the tools, no memory. */
const NO_MEMORY: FlintGrounding = { ...G, memory: [] };

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
const THU = Date.parse('2026-09-24T15:00:00Z'); // Thursday, September 24, 10:00 AM in Chicago
const row = (promptId: string, c: { name: string; model: string }, extra: Partial<AnswerRow> = {}): AnswerRow => ({
  promptId,
  contestant: c.name,
  model: c.model,
  ok: true,
  text: `${c.name} answer`,
  costUsd: 0,
  ms: 1,
  ts: THU,
  ...extra,
});
const AT = new Date(THU);
const sharing = (personal: string[] = ['anthropic'], local: string[] = []): Sharing => ({ personal, local });

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
    const comp = providerContestant({ name: 'claude', vendor: 'anthropic', model: 'claude-fable-5-1', provider: rec, maxTokens: 1000, system: 'You are a helpful assistant for Will.' });
    const ctx = taskContext(task(), G, 16_000, AT);
    const r = await answerWithContext({ contestant: comp, prompt: task(), ctx, signal: new AbortController().signal, reserve: reserve() });
    expect(rec.calls[0]!.system).toBe(ctx.system);
    const msg = String(rec.calls[0]!.messages[0]!.content);
    expect(msg).toContain('<tool name="trident.gmail_search" status="ok">');
    expect(msg).toContain('Invoice due');
    expect(msg).not.toContain('Juno'); // incidental memory is never handed over
    expect(msg.endsWith('<request>\nAny important emails today?\n</request>')).toBe(true);
    expect(r).toMatchObject({ kind: 'answered', row: { promptId: task().id, contestant: 'claude', text: 'Nothing urgent: one invoice.', meta: { contextSha: ctx.sha, privacy: 'personal-comms' } } });
  });

  it("tells a competitor asked days later the time Flint answered, not the time it is asked", async () => {
    const date = task({ id: 'knowledge-date-95~eeee0000', templateId: 'knowledge-date-95', system: 'knowledge', privacy: 'public', computed: 'weekday-offset', slots: { day_offset: '10' }, tools: { need: [], ok: ['calculate'] } });
    // Flint answered on Thursday; the run was resumed on Saturday.
    const contexts = contextsFor([date], () => row(date.id, FLINT, { grounding: { memory: [], tools: [] }, ts: THU }));
    const rec = recorder('Today is Thursday, September 24.');
    const comp = providerContestant({ name: 'openai', vendor: 'openai', model: 'gpt-5', provider: rec, maxTokens: 1000, system: 'You are a helpful assistant for Will. Right now it is Saturday, September 26, 2026.' });
    await answerWithContext({ contestant: comp, prompt: date, ctx: contexts.get(date.id)!, signal: new AbortController().signal, reserve: reserve() });
    expect(rec.calls[0]!.system).toContain('Thursday, September 24, 2026');
    expect(rec.calls[0]!.system).not.toContain('September 26');
    // A Flint answer at another time is another context: the cached competitor answer is re-asked.
    const redone = contextsFor([date], () => row(date.id, FLINT, { grounding: { memory: [], tools: [] }, ts: Date.parse('2026-09-26T15:00:00Z') }));
    expect(redone.get(date.id)!.sha).not.toBe(contexts.get(date.id)!.sha);
  });

  it('budgets for the context, not just the request', () => {
    const comp = providerContestant({ name: 'openai', vendor: 'openai', model: 'gpt-5', provider: recorder(), maxTokens: 1000, system: 's' });
    const big: FlintGrounding = { memory: [], tools: [{ name: 'vantage.top_scores', isError: false, excerpt: 'x'.repeat(40_000) }] };
    const ctx = taskContext(task({ privacy: 'systems' }), big, 40_000, AT);
    // answerWithContext asks with competitorMessage, so the estimate sees the whole context.
    expect(comp.estimate({ id: 'p', prompt: competitorMessage('q', ctx) })).toBeGreaterThan(comp.estimate({ id: 'p', prompt: 'q' }) + 0.01);
  });

  it('only asks allowed vendors, only where Flint answered, and re-asks when the context changed', () => {
    const openai = { name: 'openai', model: 'gpt-5' };
    const claude = { name: 'claude', model: 'claude-fable-5-1' };
    const failed = task({ id: 'gmail-triage-25~cccc0000', templateId: 'gmail-triage-25' });
    const flintRows = new Map([
      [task().id, row(task().id, FLINT, { grounding: NO_MEMORY })],
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
      sharing: DEFAULT_SHARING,
      cached: (id, c) => cached.get(`${id}|${c.name}`),
    });
    expect(work.map((w) => `${w.comp.name}:${w.p.templateId}`).sort()).toEqual(['claude:gmail-triage-24', 'openai:web-lookup-08']);
    // A cached answer on another context is stale: asked again.
    cached.set(`${PUBLIC.id}|claude`, row(PUBLIC.id, claude, { meta: { contextSha: 'old' } }));
    const again = competitorWork({ prompts: [PUBLIC], competitors: [claude], contexts, sharing: DEFAULT_SHARING, cached: (id, c) => cached.get(`${id}|${c.name}`) });
    expect(again).toHaveLength(1);
    // Shared with OpenAI: now it gets the personal prompt too.
    const shared = competitorWork({ prompts: [task()], competitors: [openai], contexts, sharing: sharing(['anthropic', 'openai']), cached: () => undefined });
    expect(shared).toHaveLength(1);
  });

  it("never asks or judges a task where Flint read memory the competitor wasn't given", () => {
    const claude = { name: 'claude', model: 'claude-fable-5-1' };
    // Flint recalled "Will has a dog named Juno" on a triage task: the competitor would get "(none)".
    const flintRow = row(task().id, FLINT, { grounding: G });
    const contexts = contextsFor([task()], () => flintRow);
    expect(contexts.get(task().id)!.notCompared).toBe('unshared-memory');
    expect(competitorWork({ prompts: [task()], competitors: [claude], contexts, sharing: DEFAULT_SHARING, cached: () => undefined })).toEqual([]);
    const sha = contexts.get(task().id)!.sha;
    const pairs = taskPairs({ prompts: [task()], competitors: [claude], contexts, flintAnswer: () => flintRow, answer: () => row(task().id, claude, { meta: { contextSha: sha } }), judged: () => false });
    expect(pairs).toEqual([]);
    // And the run redoes that Flint answer (with recall: false) when the server can skip memory.
    expect(flintAnswerStale(task(), flintRow, true)).toBe(true);
    expect(flintAnswerStale(task(), flintRow, false)).toBe(false);
    expect(flintAnswerStale(task(), row(task().id, FLINT, { grounding: NO_MEMORY }), true)).toBe(false);
    expect(flintAnswerStale(task({ memory: 'task' }), flintRow, true)).toBe(false);
  });

  it('never asks or judges a Flint-only task (about Flint himself)', () => {
    const openai = { name: 'openai', model: 'gpt-5' };
    const identity = task({ id: 'self-identity-75~ffff0000', templateId: 'self-identity-75', system: 'self', privacy: 'systems', scoring: 'flint-only', tools: { need: [['training_status']], ok: [] } });
    const flintRow = row(identity.id, FLINT, { grounding: { memory: [], tools: [{ name: 'training_status', isError: false, excerpt: '{"serving":"claude-opus-5-5"}' }] } });
    const contexts = contextsFor([identity], () => flintRow);
    expect(competitorWork({ prompts: [identity], competitors: [openai], contexts, sharing: DEFAULT_SHARING, cached: () => undefined })).toEqual([]);
    expect(taskPairs({ prompts: [identity], competitors: [openai], contexts, flintAnswer: () => flintRow, answer: () => row(identity.id, openai, { meta: { contextSha: contexts.get(identity.id)!.sha } }), judged: () => false })).toEqual([]);
    // Still scored for tool selection.
    expect(selectionFor([identity], () => flintRow)).toMatchObject([{ promptId: identity.id, correct: true }]);
  });

  it('keeps a stay-local task from every cloud competitor, Claude included, unless shared with --share-local-with', () => {
    const local = task({ id: 'local-route-94~dddd0000', templateId: 'local-route-94', system: 'local-route', route: 'local', tools: { need: [['trident.gcal_upcoming'], ['trident.gmail_search']], ok: [] } });
    const claude = { name: 'claude', model: 'claude-fable-5-1' };
    const contexts = contextsFor([local], () => row(local.id, FLINT, { grounding: NO_MEMORY, meta: { brain: 'local' } }));
    expect(contexts.get(local.id)!.privacy).toBe('local-only');
    expect(competitorWork({ prompts: [local], competitors: [claude], contexts, sharing: DEFAULT_SHARING, cached: () => undefined })).toEqual([]);
    expect(competitorWork({ prompts: [local], competitors: [claude], contexts, sharing: sharing(['anthropic'], ['anthropic']), cached: () => undefined })).toHaveLength(1);
  });

  it('judges only pairs answered on the current context, not yet judged', () => {
    const claude = { name: 'claude', model: 'claude-fable-5-1' };
    const flintRow = row(task().id, FLINT, { grounding: NO_MEMORY });
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

describe('Flint answers without memory the competitors do not get (recall: false)', () => {
  const reply = (over: Record<string, unknown>) =>
    new Response(JSON.stringify({ text: 'ok', eval: true, brain: 'frontier', model: 'anthropic:claude-opus-5-5', grounding: { memory: [], tools: [] }, ...over }), { status: 200 });
  const withFetch = async (fake: typeof fetch, fn: () => Promise<void>) => {
    const real = globalThis.fetch;
    globalThis.fetch = fake;
    try {
      await fn();
    } finally {
      globalThis.fetch = real;
    }
  };

  it('sends recall: false for the withheld prompts only, and records it', async () => {
    const sent: Array<Record<string, unknown>> = [];
    await withFetch((async (_u: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      sent.push(body);
      return reply(body.recall === false ? { recall: false } : { grounding: { memory: ['Will has a dog named Juno'], tools: [] } });
    }) as typeof fetch, async () => {
      const f = flintContestant({ url: 'http://x', token: 't', frontierModel: 'claude-sonnet-5', allowTrainingLog: false, timeoutMs: 1000, withholdMemory: (p) => p.id === 'incidental' });
      const a = await f.answer({ id: 'incidental', prompt: 'Hey Flint' }, new AbortController().signal);
      expect(sent[0]).toMatchObject({ eval: true, recall: false });
      expect(a.meta).toMatchObject({ recall: false });
      expect(a.grounding!.memory).toEqual([]);
      const m = await f.answer({ id: 'memory', prompt: "What's my dog's name?" }, new AbortController().signal);
      expect(sent[1]).not.toHaveProperty('recall');
      expect(m.grounding!.memory).toEqual(['Will has a dog named Juno']);
    });
  });

  it("stops the run when the server doesn't echo it, or still recalled memory", async () => {
    for (const over of [{}, { recall: true }, { recall: false, grounding: { memory: ['Will is going to UFC 330 with Mike'], tools: [] } }]) {
      await withFetch((async () => reply(over)) as typeof fetch, async () => {
        const f = flintContestant({ url: 'http://x', token: 't', frontierModel: 'claude-sonnet-5', allowTrainingLog: false, timeoutMs: 1000, withholdMemory: () => true });
        await expect(f.answer({ id: 'p', prompt: 'Hey Flint' }, new AbortController().signal), JSON.stringify(over)).rejects.toBeInstanceOf(FatalError);
      });
    }
  });

  it('preflight: a run that withholds memory needs evalRecallOverride', async () => {
    const health = (h: Record<string, unknown>) => (async () => new Response(JSON.stringify({ ok: true, evalMode: true, groundingCharsMax: 32_000, ...h }), { status: 200 })) as unknown as typeof fetch;
    const base = { url: 'http://x', judgeOnly: false, allowTrainingLog: false, groundingChars: 16_000 };
    await expect(preflightFlint({ ...base, recallOverride: true, fetchFn: health({}) })).rejects.toThrow(/evalRecallOverride/);
    await expect(preflightFlint({ ...base, recallOverride: true, fetchFn: health({ evalRecallOverride: true }) })).resolves.toMatchObject({ evalRecallOverride: true });
  });
});

describe('judging a task', () => {
  const panelOf = (a: ProviderAdapter, o: ProviderAdapter): Panelist[] => [
    { vendor: 'anthropic', model: 'claude-fable-5-1', id: 'anthropic:claude-fable-5-1', provider: a },
    { vendor: 'openai', model: 'gpt-5', id: 'openai:gpt-5', provider: o },
  ];
  const setupOf = (panel: Panelist[]): JudgeSetup => ({ judgeModel: 'panel:anthropic:claude-fable-5-1+openai:gpt-5+grounded', model: 'panel:anthropic:claude-fable-5-1+openai:gpt-5', grounded: true, panel });

  it('drops panelists whose vendor may not see the prompt, and has no judge when none may', () => {
    const setup = setupOf(panelOf(recorder(), recorder()));
    expect(judgeFor(setup, { privacy: 'personal-comms' }, DEFAULT_SHARING)).toMatchObject({ excluded: ['openai:gpt-5'], setup: { panel: [{ id: 'anthropic:claude-fable-5-1' }] } });
    expect(judgeFor(setup, { privacy: 'public' }, DEFAULT_SHARING).excluded).toEqual([]);
    const openaiOnly: JudgeSetup = { ...setup, panel: [setup.panel![1]!] };
    expect(judgeFor(openaiOnly, { privacy: 'personal-comms' }, DEFAULT_SHARING)).toEqual({ excluded: ['openai:gpt-5'] });
    // A stay-local task: no cloud judge at all by default, Anthropic included.
    expect(judgeFor(setup, { privacy: 'local-only' }, DEFAULT_SHARING)).toEqual({ excluded: ['anthropic:claude-fable-5-1', 'openai:gpt-5'] });
  });

  it('shows allowed judges the shared context and the rubric, and never sends a personal prompt to OpenAI', async () => {
    const a = recorder('{"verdict":"A","reason":"better"}');
    const o = recorder('{"verdict":"A","reason":"better"}');
    const claude = { name: 'claude', model: 'claude-fable-5-1' };
    const ctx = taskContext(task(), NO_MEMORY, 16_000, AT);
    const r = await judgeTask({
      judge: setupOf(panelOf(a, o)),
      subject: 'flint',
      prompt: task({ reference: 'The invoice is the only urgent item.' }),
      competitor: claude,
      flintAnswer: row(task().id, FLINT, { grounding: NO_MEMORY }),
      competitorAnswer: row(task().id, claude, { meta: { contextSha: ctx.sha } }),
      ctx,
      sharing: DEFAULT_SHARING,
      seed: 1,
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
    expect(msg).toContain('<task_rubric>');
    expect(msg).toContain('Reference: The invoice is the only urgent item.');
    expect(r).toMatchObject({ kind: 'judged', row: { ok: true, contextSha: ctx.sha, privacy: 'personal-comms', excludedJudges: ['openai:gpt-5'], judgeModel: 'panel:anthropic:claude-fable-5-1+openai:gpt-5+grounded' } });
  });

  it("dates the evaluation by when Flint answered, like the rubric's computed reference", async () => {
    const a = recorder('{"verdict":"TIE","reason":"same"}');
    const o = recorder('{"verdict":"TIE","reason":"same"}');
    const date = task({ id: 'knowledge-date-95~eeee0000', category: 'task:knowledge', privacy: 'public', computed: 'weekday-offset', slots: { day_offset: '10' }, tools: { need: [], ok: [] } });
    const ctx = taskContext(date, { memory: [], tools: [] }, 16_000, AT);
    await judgeTask({
      judge: setupOf(panelOf(a, o)),
      subject: 'flint',
      prompt: date,
      competitor: { name: 'openai', model: 'gpt-5' },
      flintAnswer: row(date.id, FLINT, { grounding: { memory: [], tools: [] } }),
      competitorAnswer: row(date.id, { name: 'openai', model: 'gpt-5' }, { meta: { contextSha: ctx.sha } }),
      ctx,
      sharing: DEFAULT_SHARING,
      seed: 1,
      signal: new AbortController().signal,
      judgeMaxTokens: 4096,
      reserve: reserve(),
    });
    const msg = String(o.calls[0]!.messages[0]!.content);
    expect(msg).toContain('Date of this evaluation: 2026-09-24.');
    expect(msg).toContain('today is Thursday, September 24, 2026');
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

describe("the models: each vendor's current top model, never Flint's own as the frontier", () => {
  it("defaults the Anthropic competitor and judge to Claude Fable 5.1, not Opus 5.5 (Flint's own frontier model)", () => {
    expect(TASK_MODEL_DEFAULTS.claude).toBe('claude-fable-5-1');
    expect(defaultJudgePanel(TASK_MODEL_DEFAULTS.claude, 'gpt-5.2')).toBe('anthropic:claude-fable-5-1,openai:gpt-5.2');
    expect(defaultJudgePanel(TASK_MODEL_DEFAULTS.claude, 'gpt-5.2')).not.toContain('claude-opus-5-5');
  });

  it('takes a model from the flag, then the env, then the resumed run, then the default', () => {
    expect(resolveModel({ flag: 'gpt-5.2', env: 'gpt-5.1', resumed: 'gpt-5', fallback: 'gpt-5' })).toEqual({ model: 'gpt-5.2', source: 'flag' });
    expect(resolveModel({ env: 'gpt-5.1', resumed: 'gpt-5', fallback: 'gpt-5' })).toEqual({ model: 'gpt-5.1', source: 'env' });
    expect(resolveModel({ resumed: 'gpt-5.1', fallback: 'gpt-5' })).toEqual({ model: 'gpt-5.1', source: 'run' });
    expect(resolveModel({ fallback: 'gpt-5' })).toEqual({ model: 'gpt-5', source: 'default' });
    expect(resolveModel({})).toBeUndefined();
  });
});

describe('strict accounting and the report', () => {
  const sel = (promptId: string, correct: boolean): ToolSelection => ({
    promptId,
    templateId: promptId.split('~')[0]!,
    system: 'gmail',
    called: correct ? ['trident.gmail_search'] : [],
    needGroups: 1,
    groupsMet: correct ? 1 : 0,
    missing: correct ? [] : [['trident.gmail_search']],
    extra: [],
    unrequestedWrites: [],
    correct,
    recall: correct ? 1 : 0,
  });
  const verdict = (promptId: string, outcome: 'win' | 'loss' | 'tie', competitor = 'claude'): JudgmentRow => ({
    subject: 'flint',
    promptId,
    category: 'task:gmail',
    competitor,
    competitorModel: 'claude-fable-5-1',
    judgeModel: 'j',
    flintIsA: true,
    ok: true,
    outcome,
    verdict: outcome === 'win' ? 'A' : outcome === 'loss' ? 'B' : 'TIE',
    costUsd: 0,
    ts: 1,
  });

  it('counts a Flint failure as a loss against every competitor the task could go to, and never a Flint-only task', () => {
    const selfTask = task({ id: 'self-identity-75~ffff0000', templateId: 'self-identity-75', system: 'self', privacy: 'systems', scoring: 'flint-only' });
    const local = task({ id: 'local-route-94~dddd0000', templateId: 'local-route-94', route: 'local' });
    const strict = tasksStrict({
      summaries: [],
      competitors: [
        { name: 'openai', model: 'gpt-5' },
        { name: 'claude', model: 'claude-fable-5-1' },
      ],
      flintFailed: [task(), PUBLIC, selfTask, local],
      sharing: DEFAULT_SHARING,
    });
    expect(strict.find((s) => s.competitor === 'claude')).toMatchObject({ flintFailures: 2, total: { wins: 0, losses: 2, ties: 0 } });
    expect(strict.find((s) => s.competitor === 'openai')).toMatchObject({ flintFailures: 1 });
  });

  it('strict + tool selection: a tie on a task where Flint missed a needed system is a loss', () => {
    const missed = task({ id: 'gmail-triage-24~miss0000' });
    const hit = task({ id: 'gmail-triage-24~hit00000' });
    const out = tasksSelectionStrict({
      judgments: [verdict(missed.id, 'tie'), verdict(hit.id, 'win')],
      selection: [sel(missed.id, false), sel(hit.id, true)],
      competitors: [{ name: 'claude', model: 'claude-fable-5-1' }],
      flintFailed: [],
      sharing: DEFAULT_SHARING,
    });
    expect(out).toMatchObject([{ competitor: 'claude', selectionMisses: 1, total: { wins: 1, losses: 1, ties: 0 }, winRate: 0.5 }]);
    // The plain strict line reads the same pairs as 1 win and 1 tie (75%).
    const plain = tasksStrict({ summaries: summarize([verdict(missed.id, 'tie'), verdict(hit.id, 'win')]), competitors: [{ name: 'claude', model: 'claude-fable-5-1' }], flintFailed: [], sharing: DEFAULT_SHARING });
    expect(plain).toMatchObject([{ total: { wins: 1, losses: 0, ties: 1 }, winRate: 0.75 }]);
  });

  const reportInput = (over: Partial<TasksReportInput> = {}): TasksReportInput => {
    const claude = { name: 'claude', model: 'claude-fable-5-1' };
    const flintRow = row(task().id, FLINT, { grounding: NO_MEMORY, meta: { brain: 'frontier', model: 'anthropic:claude-opus-5-5', proposed: [] } });
    const contexts = contextsFor([task(), PUBLIC], (id) => (id === task().id ? flintRow : undefined));
    return {
      run: 'r1',
      taskSet: '/x/flint_tasks.jsonl',
      subject: 'flint',
      judgeModel: 'panel:anthropic:claude-fable-5-1+openai:gpt-5.2+grounded',
      prompts: [task(), PUBLIC],
      contestants: [FLINT, claude, { name: 'openai', model: 'gpt-5.2' }],
      answers: [flintRow, row(PUBLIC.id, FLINT, { ok: false, error: 'flint HTTP 500' }), row(task().id, claude)],
      judgments: [{ ...verdict(task().id, 'win'), contextSha: contexts.get(task().id)!.sha }],
      selection: selectionFor([task(), PUBLIC], (id) => (id === task().id ? flintRow : undefined)),
      contexts,
      exclusions: [{ promptId: task().id, templateId: 'gmail-triage-24', vendor: 'openai', role: 'competitor', privacy: 'personal-comms' }],
      sharing: DEFAULT_SHARING,
      modelChecks: [],
      contextChars: 16_000,
      spendUsd: 0.5,
      budgetUsd: 10,
      stoppedForBudget: false,
      notes: ['google skipped: no GEMINI_API_KEY in env or ~/.flint/secrets.env.'],
      ...over,
    };
  };

  it('renders per-system win rates, tool selection, exclusions and failures', () => {
    const md = renderTasksReport(reportInput());
    expect(md).toContain('| gmail | 1 | 100.0% (1-0-0) |');
    expect(md).toContain('Correct on 1/1 (100.0%)');
    expect(md).toContain('| openai | competitor | 1 | `gmail-triage-24~aaaa0000` |');
    expect(md).toContain('## Flint failures');
    expect(md).toContain('flint HTTP 500');
    expect(md).toContain('| claude | 1 | 1 | 1 |');
    expect(md).toContain('google skipped: no GEMINI_API_KEY');
    expect(md).toContain('### Strict + tool selection');
    // The old claim that memory was "withheld from competitors and judges" while Flint still read it is gone.
    expect(md).not.toContain('withheld from competitors and judges');
  });

  it("puts each model's check in the header, and labels Flint's own base model a baseline", () => {
    const checks: ModelCheck[] = [
      { role: 'claude', vendor: 'anthropic', model: 'claude-fable-5-1', source: 'default', status: 'current', newer: [], checkedOn: '2026-09-25' },
      { role: 'openai', vendor: 'openai', model: 'gpt-5.2', source: 'flag', status: 'current', newer: [], checkedOn: '2026-09-25' },
      { role: 'claude-base', vendor: 'anthropic', model: 'claude-opus-5-5', source: 'flag', status: 'newer-available', newer: ['claude-opus-5-6'], checkedOn: '2026-09-25' },
    ];
    const base = { name: 'claude-base', model: 'claude-opus-5-5' };
    const md = renderTasksReport(
      reportInput({
        modelChecks: checks,
        contestants: [FLINT, { name: 'claude', model: 'claude-fable-5-1' }, base],
        judgments: [{ ...verdict(task().id, 'win', 'claude-base'), competitorModel: 'claude-opus-5-5', contextSha: reportInput().contexts.get(task().id)!.sha }],
      }),
    );
    expect(md).toContain('## Models');
    expect(md).toContain('| claude | `claude-fable-5-1` | verified current on 2026-09-25');
    expect(md).toContain('**not the newest**');
    expect(md).toContain('**Baseline, not a frontier comparison:** claude-base (`claude-opus-5-5`)');
    expect(md).toContain('| claude-base (`claude-opus-5-5`) — baseline |');
  });

  it("labels a competitor on the model Flint's answers came from a baseline, and warns when a judge is that model", () => {
    const md = renderTasksReport(
      reportInput({
        contestants: [FLINT, { name: 'claude', model: 'claude-opus-5-5' }],
        judgeModel: 'panel:anthropic:claude-opus-5-5+openai:gpt-5.2+grounded',
      }),
    );
    expect(md).toContain("claude (`claude-opus-5-5`) is the model Flint's own frontier answers came from");
    expect(md).toContain('**Self-preference risk:** the judge `claude-opus-5-5`');
    expect(renderTasksReport(reportInput())).not.toContain('Self-preference risk');
  });

  it('lists the tasks not compared and why', () => {
    const identity = task({ id: 'self-identity-75~ffff0000', templateId: 'self-identity-75', system: 'self', privacy: 'systems', scoring: 'flint-only', tools: { need: [['training_status']], ok: [] } });
    const local = task({ id: 'local-route-94~dddd0000', templateId: 'local-route-94', system: 'local-route', route: 'local' });
    const memory = task({ id: 'coding-decide-20~9999aaaa', templateId: 'coding-decide-20', system: 'coding', privacy: 'public', tools: { need: [], ok: [] } });
    const flintRows = new Map([
      [identity.id, row(identity.id, FLINT, { grounding: { memory: [], tools: [{ name: 'training_status', isError: false, excerpt: '{}' }] } })],
      [local.id, row(local.id, FLINT, { grounding: NO_MEMORY, meta: { brain: 'local' } })],
      [memory.id, row(memory.id, FLINT, { grounding: { memory: ['Will is rewriting his trading stack in Rust'], tools: [] } })],
    ]);
    const prompts = [identity, local, memory];
    const contexts = contextsFor(prompts, (id) => flintRows.get(id));
    const md = renderTasksReport(reportInput({ prompts, contexts, answers: [...flintRows.values()], judgments: [], selection: selectionFor(prompts, (id) => flintRows.get(id)), exclusions: [] }));
    expect(md).toContain('## Not compared (Flint only)');
    expect(md).toContain('1 task(s) about Flint himself');
    expect(md).toContain('1 task(s) Will asked for it to stay on his machine');
    expect(md).toContain("1 task(s) Flint's answer read recalled memory the competitors weren't given");
  });

  it('writes the baseline role, model status and the selection-strict numbers to the history', () => {
    const header = TASKS_HISTORY_HEADER.split(',');
    const idx = (c: string) => header.indexOf(c);
    const judgments = [verdict('gmail-triage-24~miss0000', 'tie'), { ...verdict('gmail-triage-24~miss0000', 'tie', 'claude-base'), competitorModel: 'claude-opus-5-5' }];
    const selection = [sel('gmail-triage-24~miss0000', false)];
    const competitors = [
      { name: 'claude', model: 'claude-fable-5-1' },
      { name: 'claude-base', model: 'claude-opus-5-5' },
    ];
    const rows = tasksHistoryRows({
      ts: 't',
      run: 'r',
      taskSet: 's',
      subject: 'flint',
      summaries: [],
      strict: [],
      selectionStrict: tasksSelectionStrict({ judgments, selection, competitors, flintFailed: [], sharing: DEFAULT_SHARING }),
      selection,
      sharing: DEFAULT_SHARING,
      modelChecks: [{ role: 'claude', vendor: 'anthropic', model: 'claude-fable-5-1', source: 'default', status: 'current', newer: [], checkedOn: '2026-09-25' }],
      flintModels: new Set(['claude-opus-5-5']),
    });
    expect(rows).toEqual([]); // no summaries, no rows
    const withSummaries = tasksHistoryRows({
      ts: 't',
      run: 'r',
      taskSet: 's',
      subject: 'flint',
      summaries: [
        { competitor: 'claude', competitorModel: 'claude-fable-5-1', judgeModel: 'j', n: 1, total: { wins: 0, losses: 0, ties: 1 }, winRate: 0.5, p: 1, signal: 'NOISE', verdict: '', judgeErrors: 0, byCategory: {} },
        { competitor: 'claude-base', competitorModel: 'claude-opus-5-5', judgeModel: 'j', n: 1, total: { wins: 0, losses: 0, ties: 1 }, winRate: 0.5, p: 1, signal: 'NOISE', verdict: '', judgeErrors: 0, byCategory: {} },
      ] as never,
      strict: [],
      selectionStrict: tasksSelectionStrict({ judgments, selection, competitors, flintFailed: [], sharing: DEFAULT_SHARING }),
      selection,
      sharing: DEFAULT_SHARING,
      modelChecks: [{ role: 'claude', vendor: 'anthropic', model: 'claude-fable-5-1', source: 'default', status: 'current', newer: [], checkedOn: '2026-09-25' }],
      flintModels: new Set(['claude-opus-5-5']),
    }).map((r) => r.split(','));
    expect(withSummaries[0]![idx('competitor_role')]).toBe('frontier');
    expect(withSummaries[0]![idx('competitor_model_status')]).toBe('current');
    expect(withSummaries[0]![idx('selection_misses')]).toBe('1');
    expect(withSummaries[0]![idx('selection_strict_win_rate')]).toBe('0.000');
    expect(withSummaries[1]![idx('competitor_role')]).toBe('baseline');
    expect(withSummaries[1]![idx('share_local_with')]).toBe('');
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
