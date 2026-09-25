/**
 * The promotion gate for Flint's local brain: a candidate model ships only if it
 * measurably improves Flint-local's standing against a frontier model (GPT-5 by
 * default), compared prompt for prompt with the live local model on the same
 * prompts, competitor answers and judge.
 *
 * This file is the decision, and nothing else: pure functions over paired
 * scores (./paired), so every rule is unit-tested on fixture verdicts. The CLI
 * that answers and judges (./gate-cli) feeds it.
 *
 * Why these rules. Val loss and "beats its own base" never decide anything:
 * the old gate compared a fine-tune with its base, raw, capped at 360 tokens,
 * one judge, and called 85 ties in 150 a result. Here:
 *
 * - PROMOTE needs, pooled over every prompt set: a one-sided sign test
 *   p < alpha, a gain of at least `margin` (5 points) in strict win rate vs the
 *   frontier model, and the bootstrap interval's lower end above 0. With the
 *   measured noise floor (8 of 99 prompts flip on a re-answer), qwen3.8:27b vs
 *   muse-glimmer:30b (31 better, 18 worse, +3.4 points, p ≈ 0.04) is REJECTED by
 *   the margin rule; a real +9 points (12 better, 3 worse, p ≈ 0.018) passes.
 * - No set may go backwards (Will's own tasks can't pay for textbook gains), no
 *   category with n ≥ 10 may drop more than 10 points (research and chit-chat,
 *   where the local model is already near parity, are protected), the answer
 *   rate may not drop more than a point, and the median answer may not get more
 *   than 1.3x slower.
 * - HOLD (no verdict, spend nothing more) when the measurement itself can't be
 *   trusted: a prompt set is missing, the server changed mid-gate, too few
 *   paired prompts, too many judge errors, or the candidate's training data was
 *   guarded against a different version of a set than the one judging it.
 * - A candidate whose manifest reports any eval overlap is REJECTED outright.
 */
import { pairScores, strictScores, subjectStats, type PairedResult, type PromptScore } from './paired.js';
import type { AnswerRow, JudgmentRow } from './report.js';

export type GateVerdict = 'PROMOTE' | 'REJECT' | 'HOLD';

export interface GateThresholds {
  alpha: number;
  margin: number;
  ciLevel: number;
  maxCategoryDrop: number;
  minCategoryN: number;
  maxAnswerRateDrop: number;
  maxLatencyRatio: number;
  minPaired: number;
  maxJudgeErrorRate: number;
}

export const DEFAULT_THRESHOLDS: GateThresholds = {
  alpha: 0.05,
  margin: 0.05,
  ciLevel: 0.9,
  maxCategoryDrop: 0.1,
  minCategoryN: 10,
  maxAnswerRateDrop: 0.01,
  maxLatencyRatio: 1.3,
  minPaired: 50,
  maxJudgeErrorRate: 0.05,
};

export interface SubjectSummary {
  subject: string;
  answered: number;
  failed: number;
  answerRate: number | undefined;
  medianMs: number | undefined;
  judgeErrors: number;
  unscored: number;
}

export interface SetOutcome {
  /** Short name (the file's basename without .jsonl). */
  name: string;
  path: string;
  sha256: string;
  runDir: string;
  competitor: string;
  competitorModel: string;
  judgeModel: string;
  baseline: SubjectSummary;
  candidate: SubjectSummary;
  paired: PairedResult;
}

/** What the gate needs from a training cycle's manifest.json (apps/train/mlx/build_data.py). */
export interface ManifestInfo {
  path: string;
  status: string;
  overlap: { train: number; valid: number };
  evalSets: Array<{ path: string; sha256: string | null; present: boolean }>;
}

export interface GateInput {
  candidate: string;
  baseline: string;
  sets: SetOutcome[];
  /** Pooled over every set (each prompt once). */
  pooled: PairedResult;
  /** The trained candidate's manifest; 'not-required' for a base-model swap (--no-manifest). */
  manifest: ManifestInfo | 'not-required' | undefined;
  /** Requested prompt sets that aren't on disk. */
  missingSets: string[];
  /** Set when the server (its /health or the deploy checkout's HEAD) changed between the first and last answer. */
  serverChanged?: string | undefined;
  /** Parity runs that stopped early (budget, a fatal error, Ctrl-C): their sets are incomplete. */
  runErrors?: string[] | undefined;
  thresholds: GateThresholds;
}

export type CheckSeverity = 'fatal' | 'hold' | 'reject';

export interface GateCheck {
  id: string;
  severity: CheckSeverity;
  ok: boolean;
  detail: string;
}

export interface GateDecision {
  verdict: GateVerdict;
  checks: GateCheck[];
  /** The failed checks' details, in the order that decided the verdict. */
  reasons: string[];
}

const pts = (x: number): string => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)} pts`;
const pct = (x: number | undefined): string => (x === undefined ? '—' : `${(x * 100).toFixed(1)}%`);

/**
 * The checks a candidate can fail before anything is answered or paid for:
 * missing sets and a manifest that doesn't match them. The CLI runs these first
 * and stops on a HOLD or REJECT, so a gate that can't promote costs nothing.
 */
export function preflightChecks(opts: {
  missingSets: string[];
  manifest: ManifestInfo | 'not-required' | undefined;
  sets: ReadonlyArray<{ name: string; path: string; sha256: string }>;
}): GateCheck[] {
  const checks: GateCheck[] = [];
  checks.push({
    id: 'sets-present',
    severity: 'hold',
    ok: opts.missingSets.length === 0,
    detail: opts.missingSets.length
      ? `prompt set(s) missing: ${opts.missingSets.join(', ')} (build them, or name only the sets you have with --sets)`
      : 'every requested prompt set is on disk',
  });
  const m = opts.manifest;
  if (m === 'not-required') return checks;
  if (!m) {
    checks.push({ id: 'manifest', severity: 'hold', ok: false, detail: 'no training manifest: pass --manifest <cycle>/data/manifest.json, or --no-manifest for an untrained base-model swap' });
    return checks;
  }
  const overlap = m.overlap.train + m.overlap.valid;
  checks.push({
    id: 'contamination',
    severity: 'fatal',
    ok: overlap === 0,
    detail: overlap === 0 ? 'manifest: 0 training rows overlap an eval set' : `manifest: ${overlap} training rows overlap an eval set (${m.path}); the candidate saw its own exam`,
  });
  checks.push({ id: 'manifest', severity: 'hold', ok: m.status === 'ok', detail: `manifest status ${m.status}` });
  for (const s of opts.sets) {
    const guarded = m.evalSets.find((e) => e.present && e.sha256 === s.sha256);
    checks.push({
      id: `guarded:${s.name}`,
      severity: 'hold',
      ok: !!guarded,
      detail: guarded
        ? `training data was guarded against this exact ${s.name} (sha256 ${s.sha256.slice(0, 12)})`
        : `training data was not guarded against this version of ${s.name} (sha256 ${s.sha256.slice(0, 12)}): rebuild the data against it before judging`,
    });
  }
  return checks;
}

export function decideGate(input: GateInput): GateDecision {
  const t = input.thresholds;
  const checks: GateCheck[] = preflightChecks({ missingSets: input.missingSets, manifest: input.manifest, sets: input.sets });
  const P = input.pooled;

  checks.push({
    id: 'server-stable',
    severity: 'hold',
    ok: !input.serverChanged,
    detail: input.serverChanged ? `the server changed during the gate (${input.serverChanged}): both sides must be answered by the same build` : 'one server build answered both sides',
  });
  const runErrors = input.runErrors ?? [];
  checks.push({
    id: 'runs-complete',
    severity: 'hold',
    ok: runErrors.length === 0,
    detail: runErrors.length ? `parity run(s) stopped early: ${runErrors.join('; ')} (resume them with the same --run)` : 'every parity run finished',
  });
  checks.push({
    id: 'paired-n',
    severity: 'hold',
    ok: P.n >= t.minPaired,
    detail: `${P.n} paired prompts (need ${t.minPaired})`,
  });
  for (const s of input.sets) {
    const errors = s.baseline.judgeErrors + s.candidate.judgeErrors;
    const rate = errors / Math.max(1, s.paired.n + errors);
    checks.push({
      id: `judge-errors:${s.name}`,
      severity: 'hold',
      ok: rate <= t.maxJudgeErrorRate,
      detail: `${s.name}: ${errors} judge error(s) (${pct(rate)}; max ${pct(t.maxJudgeErrorRate)}), resume the run to re-judge them`,
    });
  }

  checks.push({
    id: 'significance',
    severity: 'reject',
    ok: P.p < t.alpha,
    detail: `${P.better} prompts better, ${P.worse} worse: one-sided sign test p = ${P.p.toPrecision(3)} (need < ${t.alpha})`,
  });
  checks.push({
    id: 'margin',
    severity: 'reject',
    ok: P.delta >= t.margin,
    detail: `strict win rate vs the frontier model ${pct(P.baselineRate)} → ${pct(P.candidateRate)} (${pts(P.delta)}; need ${pts(t.margin)})`,
  });
  checks.push({
    id: 'interval',
    severity: 'reject',
    ok: P.ci[0] > 0,
    detail: `${Math.round(P.ciLevel * 100)}% bootstrap interval for the gain [${pts(P.ci[0])}, ${pts(P.ci[1])}] (lower end must be > 0)`,
  });
  for (const s of input.sets) {
    checks.push({
      id: `no-regression:${s.name}`,
      severity: 'reject',
      ok: s.paired.delta >= 0,
      detail: `${s.name}: ${pts(s.paired.delta)} (${s.paired.better} better, ${s.paired.worse} worse, n=${s.paired.n})`,
    });
  }
  for (const [cat, c] of Object.entries(P.byCategory)) {
    if (c.n < t.minCategoryN) continue;
    checks.push({
      id: `category:${cat}`,
      severity: 'reject',
      ok: c.delta >= -t.maxCategoryDrop,
      detail: `${cat}: ${pct(c.baselineRate)} → ${pct(c.candidateRate)} (${pts(c.delta)}, n=${c.n}; may drop at most ${pts(t.maxCategoryDrop).replace('+', '')})`,
    });
  }
  for (const s of input.sets) {
    const b = s.baseline.answerRate;
    const c = s.candidate.answerRate;
    checks.push({
      id: `answer-rate:${s.name}`,
      severity: 'reject',
      ok: b === undefined || (c !== undefined && c >= b - t.maxAnswerRateDrop),
      detail: `${s.name}: answer rate ${pct(b)} → ${pct(c)} (may drop at most ${pct(t.maxAnswerRateDrop)})`,
    });
    const bm = s.baseline.medianMs;
    const cm = s.candidate.medianMs;
    checks.push({
      id: `latency:${s.name}`,
      severity: 'reject',
      ok: bm === undefined || (cm !== undefined && cm <= bm * t.maxLatencyRatio),
      detail: `${s.name}: median answer ${bm === undefined ? '—' : `${(bm / 1000).toFixed(1)}s`} → ${cm === undefined ? '—' : `${(cm / 1000).toFixed(1)}s`} (at most ${t.maxLatencyRatio}x)`,
    });
  }

  const failed = (sev: CheckSeverity): GateCheck[] => checks.filter((c) => c.severity === sev && !c.ok);
  const fatal = failed('fatal');
  const hold = failed('hold');
  const reject = failed('reject');
  const verdict: GateVerdict = fatal.length ? 'REJECT' : hold.length ? 'HOLD' : reject.length ? 'REJECT' : 'PROMOTE';
  const deciding = fatal.length ? fatal : hold.length ? hold : reject;
  return { verdict, checks, reasons: deciding.map((c) => c.detail) };
}

/** Exit code for the CLI and cycle.sh: 0 PROMOTE, 1 REJECT, 3 HOLD (2 is an error). */
export function exitCodeOf(v: GateVerdict): number {
  return v === 'PROMOTE' ? 0 : v === 'REJECT' ? 1 : 3;
}

export function renderGate(input: GateInput, d: GateDecision): string {
  const L: string[] = [];
  const P = input.pooled;
  L.push(`# Gate: ${input.candidate} vs the live local model (${input.baseline})`, '');
  L.push(`**Verdict: ${d.verdict}**`, '');
  for (const r of d.reasons) L.push(`- ${r}`);
  if (d.reasons.length) L.push('');
  L.push(
    `Pooled over ${input.sets.length} set(s): ${P.n} paired prompts, ${P.better} better, ${P.worse} worse, ${P.same} unchanged. ` +
      `Strict win rate vs the frontier model: ${pct(P.baselineRate)} (live) → ${pct(P.candidateRate)} (candidate), ${pts(P.delta)}, ` +
      `p = ${P.p.toPrecision(3)} one-sided, ${Math.round(P.ciLevel * 100)}% interval [${pts(P.ci[0])}, ${pts(P.ci[1])}].`,
    '',
  );
  L.push('| set | vs | judge | n | better | worse | live | candidate | Δ | p |', '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const s of input.sets) {
    const q = s.paired;
    L.push(
      `| ${s.name} | ${s.competitor} (\`${s.competitorModel}\`) | \`${s.judgeModel}\` | ${q.n} | ${q.better} | ${q.worse} | ${pct(q.baselineRate)} | ${pct(q.candidateRate)} | ${pts(q.delta)} | ${q.p.toPrecision(3)} |`,
    );
  }
  L.push('', '| category | n | better | worse | live | candidate | Δ |', '| --- | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const [cat, c] of Object.entries(P.byCategory)) {
    L.push(`| ${cat} | ${c.n} | ${c.better} | ${c.worse} | ${pct(c.baselineRate)} | ${pct(c.candidateRate)} | ${pts(c.delta)} |`);
  }
  L.push('', '## Checks', '', '| check | severity | ok | detail |', '| --- | --- | --- | --- |');
  for (const c of d.checks) L.push(`| ${c.id} | ${c.severity} | ${c.ok ? 'yes' : '**no**'} | ${c.detail.replace(/\|/g, '\\|')} |`);
  L.push(
    '',
    'Scores are strict (a failure to answer is a loss). Δ is the change in the share of prompts Flint-local wins against the frontier model, candidate minus live, on the same prompts, competitor answers and judge.',
    '',
  );
  return L.join('\n');
}

export const GATE_HISTORY_HEADER = 'ts,candidate,baseline,sets,competitor,judge,n,better,worse,live_rate,candidate_rate,delta,p,ci_lo,ci_hi,verdict,reasons';

export function gateHistoryRow(ts: string, input: GateInput, d: GateDecision): string {
  const P = input.pooled;
  const s0 = input.sets[0];
  const cells = [
    ts,
    input.candidate,
    input.baseline,
    input.sets.map((s) => s.name).join('+'),
    s0 ? `${s0.competitor}:${s0.competitorModel}` : '',
    s0?.judgeModel ?? '',
    P.n,
    P.better,
    P.worse,
    P.baselineRate.toFixed(3),
    P.candidateRate.toFixed(3),
    P.delta.toFixed(3),
    P.p.toPrecision(3),
    P.ci[0].toFixed(3),
    P.ci[1].toFixed(3),
    d.verdict,
    d.reasons.join('; '),
  ];
  return cells.map((c) => (/[",\n]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : String(c))).join(',');
}

/** Read the fields the gate needs from build_data.py's manifest.json. Throws on a malformed file. */
export function parseManifest(path: string, raw: string): ManifestInfo {
  const m = JSON.parse(raw) as {
    status?: string;
    guard?: { overlap?: { train?: number; valid?: number }; evalSets?: Array<{ path?: string; sha256?: string | null; present?: boolean }> };
  };
  if (!m.guard || !Array.isArray(m.guard.evalSets) || !m.guard.overlap) throw new Error(`${path} is not a build_data.py manifest (no guard.evalSets / guard.overlap)`);
  return {
    path,
    status: m.status ?? 'unknown',
    overlap: { train: Number(m.guard.overlap.train ?? NaN), valid: Number(m.guard.overlap.valid ?? NaN) },
    evalSets: m.guard.evalSets.map((e) => ({ path: String(e.path ?? ''), sha256: e.sha256 ?? null, present: e.present === true })),
  };
}

// ---------------------------------------------------------------------------
// From run directories to a decision (pure; the CLI does the reading)

/** One `--sets` entry: `parity_prompts.jsonl:100` (a balanced slice of 100) or `flint_tasks.jsonl` (all). */
export interface SetSpec {
  name: string;
  file: string;
  limit?: number;
}

export function parseSetsSpec(spec: string): SetSpec[] {
  const out: SetSpec[] = [];
  for (const part of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = part.match(/^(.*?)(?::(\d+))?$/)!;
    const file = m[1]!;
    if (!file) throw new Error(`--sets: "${part}" names no file`);
    const name = file.split('/').pop()!.replace(/\.jsonl$/, '');
    if (out.some((s) => s.name === name)) throw new Error(`--sets: ${name} is listed twice`);
    out.push({ name, file, ...(m[2] ? { limit: Number(m[2]) } : {}) });
  }
  if (out.length === 0) throw new Error('--sets names no prompt set');
  return out;
}

/** Score one set's run directory for both subjects against one competitor under one judge. */
export function setOutcome(opts: {
  name: string;
  path: string;
  sha256: string;
  runDir: string;
  prompts: ReadonlyArray<{ id: string; category: string }>;
  answers: readonly AnswerRow[];
  judgments: readonly JudgmentRow[];
  baselineSubject: string;
  candidateSubject: string;
  competitor: string;
  competitorModel: string;
  judgeModel: string;
  ciLevel: number;
  seed?: number;
}): SetOutcome & { baselineScores: Map<string, PromptScore>; candidateScores: Map<string, PromptScore> } {
  const ids = new Set(opts.prompts.map((p) => p.id));
  const score = (subject: string) =>
    strictScores({
      subject,
      competitor: opts.competitor,
      competitorModel: opts.competitorModel,
      judgeModel: opts.judgeModel,
      answers: opts.answers,
      judgments: opts.judgments,
      prompts: opts.prompts,
    });
  const b = score(opts.baselineSubject);
  const c = score(opts.candidateSubject);
  const summary = (subject: string, s: ReturnType<typeof score>): SubjectSummary => ({
    subject,
    ...subjectStats(opts.answers, subject, ids),
    judgeErrors: s.judgeErrors,
    unscored: s.unscored,
  });
  return {
    name: opts.name,
    path: opts.path,
    sha256: opts.sha256,
    runDir: opts.runDir,
    competitor: opts.competitor,
    competitorModel: opts.competitorModel,
    judgeModel: opts.judgeModel,
    baseline: summary(opts.baselineSubject, b),
    candidate: summary(opts.candidateSubject, c),
    paired: pairScores(b.scores, c.scores, { ciLevel: opts.ciLevel, seed: opts.seed ?? 1 }),
    baselineScores: b.scores,
    candidateScores: c.scores,
  };
}

/** Pool several sets' scores, each prompt once (the first set that has it wins). */
export function poolSets(
  sets: ReadonlyArray<{ baselineScores: ReadonlyMap<string, PromptScore>; candidateScores: ReadonlyMap<string, PromptScore> }>,
  ciLevel: number,
  seed = 1,
): PairedResult {
  const b = new Map<string, PromptScore>();
  const c = new Map<string, PromptScore>();
  for (const s of sets) {
    for (const [id, v] of s.baselineScores) if (!b.has(id)) b.set(id, v);
    for (const [id, v] of s.candidateScores) if (!c.has(id)) c.set(id, v);
  }
  return pairScores(b, c, { ciLevel, seed });
}

/**
 * The /health fields that identify what is answering, plus the deploy
 * checkout's HEAD. Auto-deploy restarts the server on every commit to main; a
 * gate whose baseline and candidate straddle a deploy compares two builds.
 */
export function serverFingerprint(health: Record<string, unknown> | undefined, deployHead: string): string {
  const h = health ?? {};
  const pick = ['provider', 'model', 'tools', 'evalMode', 'localModelOverride', 'localThinkOverride', 'styleVariants'];
  return JSON.stringify({ ...Object.fromEntries(pick.map((k) => [k, h[k] ?? null])), deployHead });
}

export function describeFingerprintChange(before: string, after: string): string | undefined {
  if (before === after) return undefined;
  const a = JSON.parse(before) as Record<string, unknown>;
  const b = JSON.parse(after) as Record<string, unknown>;
  const changed = Object.keys({ ...a, ...b }).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
  return changed.map((k) => `${k}: ${JSON.stringify(a[k])} → ${JSON.stringify(b[k])}`).join(', ');
}

/** The spend a `run` invocation reports on stderr ("spent $1.2345 this invocation"). */
export function parseSpent(stderrLine: string): number | undefined {
  const m = stderrLine.match(/spent \$([\d.]+) this invocation/);
  return m ? Number(m[1]) : undefined;
}

export interface GateRunPlan {
  subject: 'baseline' | 'candidate';
  args: string[];
}

/**
 * The two `run` invocations for one set, in order. Both write to the same fresh
 * run dir, so the competitor's answers are bought once and shared, and both
 * subjects are judged by the same judge on the same prompts. The baseline is
 * plain `--flint-local`: the live local persona exactly as Will gets it (live
 * model, think setting and style variant), not a re-creation through the
 * local-model override.
 */
export function planSetRuns(opts: {
  runDir: string;
  promptsPath: string;
  limit?: number | undefined;
  competitor: string;
  competitorModel: string;
  judgeArgs: string[];
  flintUrl: string;
  candidate: string;
  candidateThink?: 'on' | 'off' | undefined;
  candidateVariant?: string | undefined;
  baselineVariant?: string | undefined;
}): GateRunPlan[] {
  const common = [
    '--run',
    opts.runDir,
    '--prompts',
    opts.promptsPath,
    ...(opts.limit !== undefined ? ['--limit', String(opts.limit)] : []),
    '--contestants',
    `flint,${opts.competitor}`,
    `--${opts.competitor}-model`,
    opts.competitorModel,
    ...opts.judgeArgs,
    '--flint-url',
    opts.flintUrl,
  ];
  return [
    { subject: 'baseline', args: [...common, '--flint-local', ...(opts.baselineVariant ? ['--flint-variant', opts.baselineVariant] : [])] },
    {
      subject: 'candidate',
      args: [
        ...common,
        '--local-model',
        opts.candidate,
        ...(opts.candidateThink ? ['--local-think', opts.candidateThink] : []),
        ...(opts.candidateVariant ? ['--flint-variant', opts.candidateVariant] : []),
      ],
    },
  ];
}
