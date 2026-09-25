/**
 * The per-prompt steps of `run`: answer one prompt, choose the pairs to judge,
 * judge one pair. They live here rather than in cli.ts (which runs main() on
 * import) so the wiring is tested: which pairs a grounded judge skips, what
 * grounding it is shown, which model the judge API is called with, and which
 * failures are recorded.
 */
import type { ProviderAdapter, TokenUsage } from '@flint/core';
import { FatalError, costOfFailure, type Contestant } from './contestants.js';
import { groundingChars } from './grounding.js';
import { flintIsA, judgePair, outcomeFor } from './judge.js';
import { judgeWithPanel, verdictFor, type Panelist } from './panel.js';
import { costOf, estimateCost } from './pricing.js';
import type { EvalPrompt } from './prompts.js';
import type { AnswerRow, JudgmentRow } from './report.js';

/** BudgetGuard.reserve: a settle function, or null when the budget refuses. */
export type Reserve = (estimateUsd: number) => ((actualUsd: number) => void) | null;

export type AnswerStep =
  | { kind: 'answered'; row: AnswerRow }
  /** A failure to record: the prompt counts as not answered (answer rate, the strict line) and is retried on resume. */
  | { kind: 'failed'; row: AnswerRow }
  /** The budget refused the call; nothing was sent. */
  | { kind: 'refused' }
  /** The run must stop (e.g. the server refused the request shape). Nothing is recorded. */
  | { kind: 'fatal'; error: FatalError }
  /**
   * The run was stopped (Ctrl-C, or another prompt's fatal error) while this call
   * was in flight. Not the contestant's failure, so nothing is recorded: a
   * recorded failure would count as a strict loss (or a competitor miss) that is
   * really an interrupt. Resuming asks it again.
   */
  | { kind: 'aborted' };

/** Ask one contestant one prompt, with its spend reserved first. */
export async function answerOne(opts: {
  contestant: Contestant;
  prompt: EvalPrompt;
  /** The run's signal: aborted when the run stops. */
  signal: AbortSignal;
  reserve: Reserve;
}): Promise<AnswerStep> {
  const { contestant: c, prompt: p, signal } = opts;
  const estimate = c.estimate(p);
  const settle = opts.reserve(estimate);
  if (!settle) return { kind: 'refused' };
  const t0 = Date.now();
  try {
    const res = await c.answer(p, signal);
    settle(res.costUsd);
    return {
      kind: 'answered',
      row: {
        promptId: p.id,
        contestant: c.name,
        model: c.model,
        ok: true,
        text: res.text,
        ...(res.usage ? { usage: res.usage } : {}),
        costUsd: res.costUsd,
        ms: Date.now() - t0,
        ...(res.meta ? { meta: res.meta } : {}),
        ...(res.grounding ? { grounding: res.grounding } : {}),
        ts: Date.now(),
      },
    };
  } catch (err) {
    // A failed call can still have been billed, and that spend belongs under this
    // budget (and the shared daily one) like any other: what the contestant says
    // it cost (Flint's server reports every replay's cost, answered or not), or,
    // for a call cut off by a timeout or the run stopping, the estimate, since the
    // vendor bills the work already done. Only a call that never got going is free.
    const cost = costOfFailure(err) ?? (signal.aborted || cutOff(err) ? estimate : 0);
    settle(cost);
    if (err instanceof FatalError) return { kind: 'fatal', error: err };
    if (signal.aborted) return { kind: 'aborted' };
    return {
      kind: 'failed',
      row: {
        promptId: p.id,
        contestant: c.name,
        model: c.model,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        costUsd: cost,
        ms: Date.now() - t0,
        ts: Date.now(),
      },
    };
  }
}

/** A request cut off by its own timeout (or an abort): it reached the vendor, which billed the work done. */
function cutOff(err: unknown): boolean {
  const name = (err as { name?: unknown } | null | undefined)?.name;
  return name === 'TimeoutError' || name === 'AbortError';
}

interface Named {
  name: string;
  model: string;
}

/**
 * The pairs still to judge: every prompt both Flint and the competitor answered
 * that has no cached verdict. A grounded judge skips a prompt whose Flint answer
 * has no grounding recorded (answered by a server that didn't report it):
 * judging it "grounded" with nothing to show would put an ungrounded verdict
 * under the `+grounded` id. Those prompts come back in `ungrounded`.
 */
export function pairsToJudge<C extends Named>(opts: {
  prompts: readonly EvalPrompt[];
  flint: Named;
  competitors: readonly C[];
  /** The cached successful answer of this contestant to this prompt. */
  answer: (promptId: string, c: Named) => AnswerRow | undefined;
  /** Does this pair already have a verdict from this judge? */
  judged: (promptId: string, comp: C) => boolean;
  grounded: boolean;
}): { pairs: Array<{ p: EvalPrompt; comp: C }>; ungrounded: Set<string> } {
  const pairs: Array<{ p: EvalPrompt; comp: C }> = [];
  const ungrounded = new Set<string>();
  for (const p of opts.prompts) {
    const fa = opts.answer(p.id, opts.flint);
    if (!fa) continue;
    for (const comp of opts.competitors) {
      if (!opts.answer(p.id, comp)) continue;
      if (opts.judged(p.id, comp)) continue;
      if (opts.grounded && !fa.grounding) {
        ungrounded.add(p.id);
        continue;
      }
      pairs.push({ p, comp });
    }
  }
  return { pairs, ungrounded };
}

/** The judge a run uses, as judgeOne needs it. */
export interface JudgeSetup {
  /** The id verdicts carry (keys, reports, history): a model or a panel id, `+grounded` when grounded. */
  judgeModel: string;
  /** The model a single judge is called with and priced as: never the `+grounded` id. */
  model: string;
  /** `--judge-grounding`: the judge also sees Flint's grounding. */
  grounded: boolean;
  /** A panel; without one, the single judge `provider` (an Anthropic model). */
  panel?: readonly Panelist[] | undefined;
  provider?: ProviderAdapter | undefined;
}

export type JudgeStep = { kind: 'judged'; row: JudgmentRow } | { kind: 'refused' };

/**
 * Judge one pair, by the single judge or the panel. The row is a verdict, or a
 * judge error (excluded from the tally, retried on resume). `refused`: the budget
 * refused the call and nothing was sent.
 */
export async function judgeOne(opts: {
  judge: JudgeSetup;
  subject: string;
  prompt: EvalPrompt;
  competitor: Named;
  flintAnswer: AnswerRow;
  competitorAnswer: AnswerRow;
  seed: number;
  now: Date;
  signal: AbortSignal;
  judgeMaxTokens: number;
  reserve: Reserve;
}): Promise<JudgeStep> {
  const { judge, prompt: p, competitor: comp, flintAnswer: fa, competitorAnswer: ca } = opts;
  if (judge.grounded && !fa.grounding) {
    throw new Error(`judging ${p.id} grounded, but its Flint answer has no grounding (pairsToJudge skips those)`);
  }
  const grounding = judge.grounded ? fa.grounding : undefined;
  const aIsFlint = flintIsA(p.id, comp.name, opts.seed);
  const base = {
    subject: opts.subject,
    promptId: p.id,
    category: p.category,
    competitor: comp.name,
    competitorModel: comp.model,
    judgeModel: judge.judgeModel,
    flintIsA: aIsFlint,
  };

  if (judge.panel) {
    const r = await judgeWithPanel({
      panel: judge.panel,
      reserve: opts.reserve,
      judgeMaxTokens: opts.judgeMaxTokens,
      prompt: p,
      competitor: comp.name,
      flintAnswer: fa.text!,
      competitorAnswer: ca.text!,
      seed: opts.seed,
      now: opts.now,
      signal: opts.signal,
      grounding,
    });
    if (r.kind === 'refused') return { kind: 'refused' };
    if (r.kind === 'error') return { kind: 'judged', row: { ...base, ok: false, error: r.error, panel: r.panel, costUsd: r.costUsd, ts: Date.now() } };
    return {
      kind: 'judged',
      row: {
        ...base,
        ok: true,
        verdict: verdictFor(r.outcome, aIsFlint),
        outcome: r.outcome,
        agreed: r.agreed,
        reason: r.panel.map((v) => `[${v.judge}: ${v.outcome}] ${v.reason}`).join(' '),
        panel: r.panel,
        costUsd: r.costUsd,
        ts: Date.now(),
      },
    };
  }

  if (!judge.provider) throw new Error('a single judge needs a provider');
  const [answerA, answerB] = aIsFlint ? [fa.text!, ca.text!] : [ca.text!, fa.text!];
  const est = estimateCost('anthropic', judge.model, p.prompt.length + answerA.length + answerB.length + groundingChars(grounding), {
    overheadTokens: 700,
    expectedOutputTokens: 800,
  });
  const settle = opts.reserve(est);
  if (!settle) return { kind: 'refused' };
  try {
    const j = await judgePair({
      provider: judge.provider,
      model: judge.model,
      maxTokens: opts.judgeMaxTokens,
      prompt: p,
      answerA,
      answerB,
      now: opts.now,
      signal: opts.signal,
      grounding,
    });
    const cost = costOf('anthropic', judge.model, j.usage);
    settle(cost);
    return { kind: 'judged', row: { ...base, ok: true, verdict: j.verdict, outcome: outcomeFor(j.verdict, aIsFlint), reason: j.reason, costUsd: cost, ts: Date.now() } };
  } catch (err) {
    const usage = (err as { usage?: TokenUsage }).usage;
    const cost = usage ? costOf('anthropic', judge.model, usage) : 0;
    settle(cost);
    return { kind: 'judged', row: { ...base, ok: false, error: err instanceof Error ? err.message : String(err), costUsd: cost, ts: Date.now() } };
  }
}
