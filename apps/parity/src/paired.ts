/**
 * Paired comparison of two Flint subjects on the same prompts against the same
 * competitor and judge: "does the candidate beat GPT-5 more often than the live
 * local model does, prompt for prompt?"
 *
 * Each subject gets a strict score per prompt (a win 1, a tie 0.5, a loss or a
 * failure to answer 0, the same accounting as the report's strict line), and the
 * comparison is on d = candidate − baseline per prompt. That is far more
 * sensitive than comparing two win rates: re-answering with the same model
 * flipped only 8 of 99 prompts in 20260924-tiered, so most prompts cancel out
 * and a real change shows up as a lopsided count of better vs worse.
 *
 * - The sign test is one-sided (is the candidate better?), exact, over the
 *   prompts that changed.
 * - Δ is the difference in strict win rate over the paired prompts.
 * - A seeded bootstrap gives a confidence interval for Δ that doesn't assume
 *   anything about the shape of d.
 */
import { latestAnswers, latestJudgments, type AnswerRow, type JudgmentRow } from './report.js';
import { binomPmfHalf } from './stats.js';
import { seededRng } from './util.js';

export type Score = 0 | 0.5 | 1;

export interface PromptScore {
  promptId: string;
  category: string;
  score: Score;
  /** Scored 0 because the subject failed to answer (not a judged loss). */
  failed: boolean;
}

export interface SubjectScores {
  scores: Map<string, PromptScore>;
  /** Pairs whose latest verdict is a judge error: retried by resuming the run. */
  judgeErrors: number;
  /** Prompts with no verdict and no subject failure (not judged yet, or the competitor failed). */
  unscored: number;
}

/**
 * One subject's strict score per prompt against one competitor, under one judge id
 * (a model, a panel id, `+grounded` or not).
 */
export function strictScores(opts: {
  subject: string;
  competitor: string;
  competitorModel: string;
  judgeModel: string;
  answers: readonly AnswerRow[];
  judgments: readonly JudgmentRow[];
  prompts: ReadonlyArray<{ id: string; category: string }>;
}): SubjectScores {
  const ids = new Set(opts.prompts.map((p) => p.id));
  const verdicts = new Map<string, JudgmentRow>();
  for (const j of latestJudgments(opts.judgments, opts.judgeModel, opts.subject, ids)) {
    if (j.competitor === opts.competitor && j.competitorModel === opts.competitorModel) verdicts.set(j.promptId, j);
  }
  const latest = latestAnswers(opts.answers.filter((a) => ids.has(a.promptId)));
  const subjectOk = new Map<string, boolean>();
  const competitorOk = new Set<string>();
  for (const a of latest) {
    if (a.contestant === opts.subject) subjectOk.set(a.promptId, (subjectOk.get(a.promptId) ?? false) || a.ok);
    if (a.contestant === opts.competitor && a.model === opts.competitorModel && a.ok) competitorOk.add(a.promptId);
  }
  const scores = new Map<string, PromptScore>();
  let judgeErrors = 0;
  let unscored = 0;
  for (const p of opts.prompts) {
    const v = verdicts.get(p.id);
    if (v?.ok && v.outcome) {
      scores.set(p.id, { promptId: p.id, category: p.category, score: v.outcome === 'win' ? 1 : v.outcome === 'tie' ? 0.5 : 0, failed: false });
    } else if (subjectOk.get(p.id) === false && competitorOk.has(p.id)) {
      scores.set(p.id, { promptId: p.id, category: p.category, score: 0, failed: true });
    } else if (v && !v.ok) {
      judgeErrors++;
    } else {
      unscored++;
    }
  }
  return { scores, judgeErrors, unscored };
}

export interface PairedTally {
  n: number;
  better: number;
  worse: number;
  same: number;
  baselineRate: number;
  candidateRate: number;
  /** candidateRate − baselineRate. */
  delta: number;
}

export interface PairedResult extends PairedTally {
  /** One-sided exact sign test: P(at least `better` of better+worse | no difference). */
  p: number;
  /** Bootstrap confidence interval for delta at `ciLevel`. */
  ci: [number, number];
  ciLevel: number;
  byCategory: Record<string, PairedTally>;
  /** Prompts scored for only one side (left out of the pairing). */
  onlyBaseline: number;
  onlyCandidate: number;
}

/** Exact one-sided sign test: P(X ≥ better) for X ~ Binomial(better + worse, 0.5). */
export function signTestOneSidedP(better: number, worse: number): number {
  const n = better + worse;
  if (n === 0 || better === 0) return 1;
  let tail = 0;
  for (let i = better; i <= n; i++) tail += binomPmfHalf(n, i);
  return Math.min(1, tail);
}

/** Percentile bootstrap CI for the mean of `xs`, seeded so a verdict is reproducible. */
export function bootstrapMeanCI(xs: readonly number[], level: number, resamples: number, seed: number): [number, number] {
  const n = xs.length;
  if (n === 0) return [0, 0];
  const rng = seededRng(seed);
  const means = new Float64Array(resamples);
  for (let b = 0; b < resamples; b++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += xs[Math.floor(rng() * n)]!;
    means[b] = s / n;
  }
  means.sort();
  const tail = (1 - level) / 2;
  const at = (q: number): number => means[Math.min(resamples - 1, Math.max(0, Math.floor(q * (resamples - 1))))]!;
  return [at(tail), at(1 - tail)];
}

function tally(pairs: ReadonlyArray<{ base: number; cand: number }>): PairedTally {
  let better = 0;
  let worse = 0;
  let b = 0;
  let c = 0;
  for (const p of pairs) {
    if (p.cand > p.base) better++;
    else if (p.cand < p.base) worse++;
    b += p.base;
    c += p.cand;
  }
  const n = pairs.length;
  const baselineRate = n ? b / n : 0;
  const candidateRate = n ? c / n : 0;
  return { n, better, worse, same: n - better - worse, baselineRate, candidateRate, delta: candidateRate - baselineRate };
}

/** Pair two subjects' scores on the prompts both were scored on. */
export function pairScores(
  baseline: ReadonlyMap<string, PromptScore>,
  candidate: ReadonlyMap<string, PromptScore>,
  opts: { ciLevel?: number; resamples?: number; seed?: number } = {},
): PairedResult {
  const ciLevel = opts.ciLevel ?? 0.9;
  const pairs: Array<{ id: string; category: string; base: number; cand: number }> = [];
  for (const [id, b] of [...baseline].sort(([x], [y]) => x.localeCompare(y))) {
    const c = candidate.get(id);
    if (c) pairs.push({ id, category: b.category, base: b.score, cand: c.score });
  }
  const byCat = new Map<string, typeof pairs>();
  for (const p of pairs) byCat.set(p.category, [...(byCat.get(p.category) ?? []), p]);
  const byCategory: Record<string, PairedTally> = {};
  for (const [cat, ps] of [...byCat].sort(([a], [b]) => a.localeCompare(b))) byCategory[cat] = tally(ps);
  const t = tally(pairs);
  return {
    ...t,
    p: signTestOneSidedP(t.better, t.worse),
    ci: bootstrapMeanCI(
      pairs.map((p) => p.cand - p.base),
      ciLevel,
      opts.resamples ?? 10_000,
      opts.seed ?? 1,
    ),
    ciLevel,
    byCategory,
    onlyBaseline: [...baseline.keys()].filter((id) => !candidate.has(id)).length,
    onlyCandidate: [...candidate.keys()].filter((id) => !baseline.has(id)).length,
  };
}

/** Answer rate and median latency of one subject over the given prompts (latest row per prompt). */
export function subjectStats(answers: readonly AnswerRow[], subject: string, promptIds: ReadonlySet<string>): {
  answered: number;
  failed: number;
  answerRate: number | undefined;
  medianMs: number | undefined;
} {
  const latest = latestAnswers(answers.filter((a) => a.contestant === subject && promptIds.has(a.promptId)));
  const byPrompt = new Map<string, AnswerRow>();
  for (const a of latest) {
    const prev = byPrompt.get(a.promptId);
    if (!prev || (a.ok && !prev.ok)) byPrompt.set(a.promptId, a);
  }
  const rows = [...byPrompt.values()];
  const ok = rows.filter((a) => a.ok);
  const ms = ok.map((a) => a.ms).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  const mid = Math.floor(ms.length / 2);
  const medianMs = ms.length === 0 ? undefined : ms.length % 2 ? ms[mid]! : (ms[mid - 1]! + ms[mid]!) / 2;
  return { answered: ok.length, failed: rows.length - ok.length, answerRate: rows.length ? ok.length / rows.length : undefined, medianMs };
}
