/**
 * Panel judging: every pair is judged independently by several judges from
 * different vendors, and a win or loss counts only when ALL of them agree.
 *
 * Why: a single Claude judge prefers answers written by its own model. On 29
 * sampled pairs of Opus-backed Flint vs GPT-5, an Opus judge said 25-4 for Flint
 * and a GPT-5 judge said 12-15-2, and they agreed on only 16. Requiring
 * agreement across vendors cancels most of that self-preference: a verdict one
 * judge would only give its own model becomes a split (a tie).
 */
import type { ProviderAdapter, TokenUsage } from '@flint/core';
import { flintIsA, judgePair, outcomeFor, type Outcome, type Verdict } from './judge.js';
import { costOf, estimateCost, type Vendor } from './pricing.js';
import type { EvalPrompt } from './prompts.js';

/** Vendors that can sit on the panel. */
const PANEL_VENDORS = ['anthropic', 'openai'] as const;
export type PanelVendor = (typeof PANEL_VENDORS)[number];

export interface PanelistSpec {
  vendor: PanelVendor;
  model: string;
  /** `vendor:model`, the panelist's stable id. */
  id: string;
}

export interface Panelist extends PanelistSpec {
  provider: ProviderAdapter;
}

/** One panelist's verdict on one pair, as stored in the judgment row. */
export interface PanelVerdict {
  judge: string;
  /** Where Flint's answer sat for THIS panelist (each panelist gets its own order). */
  flintIsA: boolean;
  verdict: Verdict;
  outcome: Outcome;
  reason: string;
  costUsd: number;
}

/** Parse `anthropic:claude-opus-5-5,openai:gpt-5`. Sorted, so the same panel always gets the same id. */
export function parseJudgePanel(spec: string): PanelistSpec[] {
  const out: PanelistSpec[] = [];
  for (const part of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
    const i = part.indexOf(':');
    if (i <= 0 || i === part.length - 1) throw new Error(`--judge-panel: "${part}" is not provider:model`);
    const vendor = part.slice(0, i).trim().toLowerCase();
    const model = part.slice(i + 1).trim();
    if (!(PANEL_VENDORS as readonly string[]).includes(vendor)) {
      throw new Error(`--judge-panel: provider "${vendor}" isn't supported (use ${PANEL_VENDORS.join(' or ')})`);
    }
    const id = `${vendor}:${model}`;
    if (out.some((p) => p.id === id)) throw new Error(`--judge-panel: ${id} is listed twice`);
    out.push({ vendor: vendor as PanelVendor, model, id });
  }
  if (out.length < 2) throw new Error('--judge-panel needs at least two judges (a panel of one is just --judge-model)');
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * The `judgeModel` a panel's rows carry, e.g. `panel:anthropic:claude-opus-5-5+openai:gpt-5`.
 * Distinct from any single model name, so panel verdicts never mix with
 * single-judge ones in the resume cache, the report or the history CSV.
 */
export function panelId(panel: readonly PanelistSpec[]): string {
  return `panel:${[...panel].map((p) => p.id).sort().join('+')}`;
}

export function isPanelId(judgeModel: string): boolean {
  return judgeModel.startsWith('panel:');
}

/** The judge a `run` invocation uses: a model, or a panel (whose id is `judgeModel`). */
export interface JudgeChoice {
  judgeModel: string;
  panel?: PanelistSpec[];
  /** 'run' when it came from a resumed run's run.json. */
  from: 'flag' | 'run' | 'default';
}

/**
 * Which judge a `run` invocation uses. An explicit `--judge-panel`, then
 * `--judge-model`, wins. Otherwise a resumed run keeps the judge its run.json
 * was created with, so a later invocation on it (another `--local-model`
 * candidate, a `--local-think` variant) is judged like the verdicts it will be
 * compared with, and `report`, which also defaults to run.json's judge, renders
 * them. Only a new run falls back to the defaults (PARITY_JUDGE_PANEL, then
 * PARITY_JUDGE_MODEL / claude-opus-5).
 */
export function chooseJudge(opts: {
  judgeModel?: string | undefined;
  judgePanel?: string | undefined;
  resumed?: { judgeModel?: string; judgePanel?: string[] } | undefined;
  defaults: { judgeModel: string; judgePanel: string };
}): JudgeChoice {
  const asPanel = (spec: string, from: JudgeChoice['from']): JudgeChoice => {
    const panel = parseJudgePanel(spec);
    return { judgeModel: panelId(panel), panel, from };
  };
  if (opts.judgePanel?.trim()) return asPanel(opts.judgePanel, 'flag');
  if (opts.judgeModel?.trim()) return { judgeModel: opts.judgeModel.trim(), from: 'flag' };
  const r = opts.resumed;
  if (r?.judgePanel && r.judgePanel.length > 0) return asPanel(r.judgePanel.join(','), 'run');
  if (r?.judgeModel?.trim()) {
    const m = r.judgeModel.trim();
    return isPanelId(m) ? asPanel(m.slice('panel:'.length).split('+').join(','), 'run') : { judgeModel: m, from: 'run' };
  }
  if (opts.defaults.judgePanel.trim()) return asPanel(opts.defaults.judgePanel, 'default');
  return { judgeModel: opts.defaults.judgeModel, from: 'default' };
}

/**
 * Flint's slot for one panelist. Seeded by the pair AND the judge, so each
 * panelist sees an independent (but reproducible) order: a position bias in
 * one judge doesn't line up with the others'.
 */
export function panelistFlintIsA(promptId: string, competitor: string, seed: number, judge: string): boolean {
  return flintIsA(promptId, `${competitor}#${judge}`, seed);
}

/** Win or loss only if every panelist says so; any disagreement is a tie ("split"). */
export function consensus(outcomes: readonly Outcome[]): { outcome: Outcome; agreed: boolean } {
  if (outcomes.length === 0) throw new Error('consensus of nobody');
  const first = outcomes[0]!;
  const agreed = outcomes.every((o) => o === first);
  return { outcome: agreed ? first : 'tie', agreed };
}

/** The A/B/TIE verdict that gives `outcome` when Flint sat in A (`flintWasA`), i.e. the inverse of outcomeFor. */
export function verdictFor(outcome: Outcome, flintWasA: boolean): Verdict {
  if (outcome === 'tie') return 'TIE';
  return (outcome === 'win') === flintWasA ? 'A' : 'B';
}

/** The budget guard's pre-call estimate for one panelist's verdict on one pair. */
export function panelistEstimate(p: PanelistSpec, promptChars: number): number {
  // Reasoning models spend hidden output tokens before the JSON; estimate high.
  const expectedOutputTokens = p.vendor === 'openai' ? 3000 : 800;
  return estimateCost(p.vendor as Vendor, p.model, promptChars, { overheadTokens: 700, expectedOutputTokens });
}

/**
 * GPT-5-class models count reasoning against max_completion_tokens; a judge cap
 * sized for a JSON reply would be eaten by the thinking and return nothing.
 */
export function panelistMaxTokens(p: PanelistSpec, judgeMaxTokens: number): number {
  return p.vendor === 'openai' ? Math.max(judgeMaxTokens, 16_384) : judgeMaxTokens;
}

export type PanelResult =
  | { kind: 'ok'; outcome: Outcome; agreed: boolean; panel: PanelVerdict[]; costUsd: number }
  | { kind: 'error'; error: string; panel: PanelVerdict[]; costUsd: number }
  | { kind: 'refused' };

/**
 * Judge one pair with every panelist, in parallel. Budget is reserved for ALL
 * panelists before any call goes out, so a budget stop never leaves a pair half
 * paid for. If any panelist errors (after judgePair's own retry), the pair is a
 * judge error — excluded from the tally and retried on resume — not a tie.
 */
export async function judgeWithPanel(opts: {
  panel: readonly Panelist[];
  reserve: (estimateUsd: number) => ((actualUsd: number) => void) | null;
  judgeMaxTokens: number;
  prompt: EvalPrompt;
  competitor: string;
  flintAnswer: string;
  competitorAnswer: string;
  seed: number;
  now: Date;
  signal: AbortSignal;
}): Promise<PanelResult> {
  const { panel, prompt } = opts;
  const chars = prompt.prompt.length + opts.flintAnswer.length + opts.competitorAnswer.length;
  const settles: Array<(actualUsd: number) => void> = [];
  for (const p of panel) {
    const s = opts.reserve(panelistEstimate(p, chars));
    if (!s) {
      for (const done of settles) done(0);
      return { kind: 'refused' };
    }
    settles.push(s);
  }
  const results = await Promise.allSettled(
    panel.map(async (p, i) => {
      const aIsFlint = panelistFlintIsA(prompt.id, opts.competitor, opts.seed, p.id);
      const [answerA, answerB] = aIsFlint ? [opts.flintAnswer, opts.competitorAnswer] : [opts.competitorAnswer, opts.flintAnswer];
      try {
        const j = await judgePair({
          provider: p.provider,
          model: p.model,
          maxTokens: panelistMaxTokens(p, opts.judgeMaxTokens),
          prompt,
          answerA,
          answerB,
          now: opts.now,
          signal: opts.signal,
        });
        const costUsd = costOf(p.vendor, p.model, j.usage);
        settles[i]!(costUsd);
        const v: PanelVerdict = { judge: p.id, flintIsA: aIsFlint, verdict: j.verdict, outcome: outcomeFor(j.verdict, aIsFlint), reason: j.reason, costUsd };
        return v;
      } catch (err) {
        const usage = (err as { usage?: TokenUsage }).usage;
        const costUsd = usage ? costOf(p.vendor, p.model, usage) : 0;
        settles[i]!(costUsd);
        const e = new Error(`${p.id}: ${err instanceof Error ? err.message : String(err)}`);
        (e as Error & { costUsd?: number }).costUsd = costUsd;
        throw e;
      }
    }),
  );
  const verdicts: PanelVerdict[] = [];
  const errors: string[] = [];
  let costUsd = 0;
  for (const r of results) {
    if (r.status === 'fulfilled') {
      verdicts.push(r.value);
      costUsd += r.value.costUsd;
    } else {
      const e = r.reason as Error & { costUsd?: number };
      errors.push(e.message);
      costUsd += e.costUsd ?? 0;
    }
  }
  if (errors.length) return { kind: 'error', error: errors.join('; '), panel: verdicts, costUsd };
  const { outcome, agreed } = consensus(verdicts.map((v) => v.outcome));
  return { kind: 'ok', outcome, agreed, panel: verdicts, costUsd };
}
