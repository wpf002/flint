import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { CATEGORIES } from './categorize.js';
import { GROUNDED_NOTE, splitGroundedJudgeId, type FlintGrounding } from './grounding.js';
import type { Outcome } from './judge.js';
import type { PanelVerdict } from './panel.js';
import { signalOf, verdictOf, type Signal } from './stats.js';

export interface AnswerRow {
  promptId: string;
  contestant: string;
  model: string;
  ok: boolean;
  text?: string;
  error?: string;
  usage?: unknown;
  costUsd: number;
  ms: number;
  meta?: Record<string, unknown>;
  /**
   * Flint only, from a server that reports it: the recalled memory and tool
   * results the answer was grounded on. What `--judge-grounding` shows the judge.
   */
  grounding?: FlintGrounding;
  ts: number;
}

export interface JudgmentRow {
  /** Which Flint was judged ('flint' or 'flint-local'). Rows written before this field existed are 'flint'. */
  subject?: string;
  promptId: string;
  category: string;
  competitor: string;
  competitorModel: string;
  judgeModel: string;
  flintIsA: boolean;
  ok: boolean;
  verdict?: 'A' | 'B' | 'TIE';
  outcome?: Outcome;
  reason?: string;
  error?: string;
  costUsd: number;
  ts: number;
  /**
   * Panel judging only (`judgeModel` is then a `panel:...` id): every panelist's
   * own verdict. The top-level verdict/outcome is the consensus, expressed in the
   * row's `flintIsA` order.
   */
  panel?: PanelVerdict[];
  /** Panel only: did every panelist give the same outcome? (false = a split, scored as a tie) */
  agreed?: boolean;
  /** Flint tasks: the hash of the context both sides had; a verdict on another context is stale. */
  contextSha?: string;
  /** Flint tasks: the prompt's privacy class in this run. */
  privacy?: string;
  /** Flint tasks: panelists left out because the prompt is personal and their vendor isn't allowed. */
  excludedJudges?: string[];
}

/** Resume-cache / report key for one judged pair (the judge is part of it). */
export function judgmentKey(j: Pick<JudgmentRow, 'promptId' | 'competitor' | 'competitorModel' | 'judgeModel'>): string {
  return `${j.promptId}|${j.competitor}|${j.competitorModel}|${j.judgeModel}`;
}

const subjectOf = (j: JudgmentRow): string => j.subject ?? 'flint';

/**
 * The successful verdicts a run can reuse for this judge (a model name, or a
 * panel id) and subject. A single judge's rows never satisfy a panel and vice
 * versa, because their judgeModel differs.
 */
export function cachedJudgments(rows: readonly JudgmentRow[], judgeModel: string, subject: string): Map<string, JudgmentRow> {
  const m = new Map<string, JudgmentRow>();
  for (const j of rows) if (j.ok && j.judgeModel === judgeModel && subjectOf(j) === subject) m.set(judgmentKey(j), j);
  return m;
}

/** One row per pair for this judge + subject: the latest success, else the latest failure. */
export function latestJudgments(rows: readonly JudgmentRow[], judgeModel: string, subject: string, promptIds?: ReadonlySet<string>): JudgmentRow[] {
  const m = new Map<string, JudgmentRow>();
  for (const j of rows) {
    if (j.judgeModel !== judgeModel || subjectOf(j) !== subject) continue;
    if (promptIds && !promptIds.has(j.promptId)) continue;
    const k = judgmentKey(j);
    const prev = m.get(k);
    if (!prev || j.ok || !prev.ok) m.set(k, j);
  }
  return [...m.values()];
}

/**
 * `report.md` for Flint, else `report-<subject>.md` with anything not filename-safe
 * (`:` `/` ...) as `_`. `~` is kept, so a `--local-think` variant
 * (`flint-local@<model>~nothink`) gets its own, readable report next to the plain one.
 * A `--flint-variant`'s `#` becomes `+` (`flint#v2` → `report-flint+v2.md`): `#`
 * is a comment in the shell and a fragment in a link, and `_` could collide with
 * a model name's `_`, which `+` can't.
 *
 * A grounded judge's report (`judgeModel` ends in `+grounded`) gets `+grounded`
 * right after `report` (`report+grounded.md`, `report+grounded-flint+v2.md`), so
 * a grounded pass and an ungrounded one on the same run never overwrite each
 * other's report. As a prefix it can't collide with any ungrounded name, even a
 * variant's that happened to be called `grounded`.
 */
export function reportFileName(subject: string, judgeModel?: string): string {
  const stem = judgeModel !== undefined && splitGroundedJudgeId(judgeModel).grounded ? 'report+grounded' : 'report';
  if (subject === 'flint') return `${stem}.md`;
  return `${stem}-${subject.replace(/#/g, '+').replace(/[^A-Za-z0-9._@~+-]/g, '_')}.md`;
}

/** Latest answer per (prompt, contestant, model): the success if there is one, else the latest failure. */
export function latestAnswers(rows: readonly AnswerRow[]): AnswerRow[] {
  const m = new Map<string, AnswerRow>();
  for (const r of rows) {
    const k = `${r.promptId}|${r.contestant}|${r.model}`;
    const prev = m.get(k);
    if (!prev || r.ok || !prev.ok) m.set(k, r);
  }
  return [...m.values()];
}

export interface Tally {
  wins: number;
  losses: number;
  ties: number;
}

export interface CompetitorSummary {
  competitor: string;
  competitorModel: string;
  judgeModel: string;
  total: Tally;
  n: number;
  winRate: number;
  p: number;
  signal: Signal;
  verdict: string;
  byCategory: Record<string, Tally & { p: number; signal: Signal }>;
  judgeErrors: number;
  /** Panel judging: of the scored pairs, how many every panelist agreed on. */
  panelAgreement?: { agreed: number; n: number };
}

const empty = (): Tally => ({ wins: 0, losses: 0, ties: 0 });

function add(t: Tally, o: Outcome): void {
  if (o === 'win') t.wins++;
  else if (o === 'loss') t.losses++;
  else t.ties++;
}

/**
 * Win rate counts a tie as half a win, so 50% means parity whether it's reached
 * by trading wins or by tying everything.
 */
export function winRate(t: Tally): number {
  const n = t.wins + t.losses + t.ties;
  return n === 0 ? 0 : (t.wins + t.ties / 2) / n;
}

export function summarize(judgments: readonly JudgmentRow[]): CompetitorSummary[] {
  const byComp = new Map<string, JudgmentRow[]>();
  for (const j of judgments) {
    const list = byComp.get(j.competitor) ?? [];
    list.push(j);
    byComp.set(j.competitor, list);
  }
  const out: CompetitorSummary[] = [];
  for (const [competitor, rows] of [...byComp.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const total = empty();
    const cats = new Map<string, Tally>();
    let judgeErrors = 0;
    let panelN = 0;
    let panelAgreed = 0;
    for (const r of rows) {
      if (!r.ok || !r.outcome) {
        judgeErrors++;
        continue;
      }
      if (r.panel) {
        panelN++;
        if (r.agreed) panelAgreed++;
      }
      add(total, r.outcome);
      const c = cats.get(r.category) ?? empty();
      add(c, r.outcome);
      cats.set(r.category, c);
    }
    const { signal, p } = signalOf(total.wins, total.losses);
    const byCategory: CompetitorSummary['byCategory'] = {};
    const order = [...CATEGORIES, ...[...cats.keys()].filter((k) => !(CATEGORIES as readonly string[]).includes(k))];
    for (const c of order) {
      const t = cats.get(c);
      if (!t) continue;
      byCategory[c] = { ...t, ...signalOf(t.wins, t.losses) };
    }
    const first = rows[0]!;
    out.push({
      competitor,
      competitorModel: first.competitorModel,
      judgeModel: first.judgeModel,
      total,
      n: total.wins + total.losses + total.ties,
      winRate: winRate(total),
      p,
      signal,
      verdict: verdictOf(total.wins, total.losses, signal),
      byCategory,
      judgeErrors,
      ...(panelN ? { panelAgreement: { agreed: panelAgreed, n: panelN } } : {}),
    });
  }
  return out;
}

/**
 * A Flint subject's name ('flint', 'flint-local', 'flint-local@<model>~nothink',
 * 'flint#v2', ...) as opposed to a competitor's ('openai', 'claude', 'perplexity').
 */
export function isFlintName(name: string): boolean {
  return /^flint(?:$|[-@#~])/.test(name);
}

/** Answer rate per contestant: answered / (answered + failed), over the latest row per prompt. */
export interface AnswerRate {
  answered: number;
  failed: number;
  /** answered / (answered + failed); undefined when nothing was attempted. */
  rate: number | undefined;
}

export function answerRate(answers: readonly AnswerRow[], contestant: string): AnswerRate {
  // A prompt counts once: answered if any row for it succeeded, else failed.
  const byPrompt = new Map<string, boolean>();
  for (const a of answers) if (a.contestant === contestant) byPrompt.set(a.promptId, (byPrompt.get(a.promptId) ?? false) || a.ok);
  const answered = [...byPrompt.values()].filter(Boolean).length;
  const failed = byPrompt.size - answered;
  return { answered, failed, rate: byPrompt.size ? answered / byPrompt.size : undefined };
}

/**
 * The strict head-to-head for one competitor: the judged tally, plus a loss for
 * every prompt Flint failed to answer (no successful answer after retries: an
 * empty answer, an HTTP error, a timeout) that the competitor did answer. The
 * normal tally leaves those out, so a Flint that fails often looks as good as one
 * that doesn't. A competitor's failures are not counted as Flint wins.
 */
export interface StrictSummary {
  competitor: string;
  competitorModel: string;
  total: Tally;
  /** Of total.losses, how many are Flint failures rather than judged losses. */
  flintFailures: number;
  n: number;
  winRate: number;
  p: number;
  signal: Signal;
  verdict: string;
}

export function strictSummarize(opts: {
  summaries: readonly CompetitorSummary[];
  answers: readonly AnswerRow[];
  /** Which Flint the report judges. */
  subject: string;
  /** The competitors that took part; a competitor with verdicts but not listed here is included too. */
  competitors: ReadonlyArray<{ name: string; model: string }>;
  promptIds?: ReadonlySet<string>;
}): StrictSummary[] {
  const inScope = (a: AnswerRow): boolean => !opts.promptIds || opts.promptIds.has(a.promptId);
  const flintOk = new Set<string>();
  const flintTried = new Set<string>();
  for (const a of opts.answers) {
    if (a.contestant !== opts.subject || !inScope(a)) continue;
    flintTried.add(a.promptId);
    if (a.ok) flintOk.add(a.promptId);
  }
  const flintFailed = new Set([...flintTried].filter((id) => !flintOk.has(id)));

  // Each competitor once: the model its verdicts were given against, else the listed one.
  const comps = new Map<string, string>();
  for (const c of opts.competitors) if (!isFlintName(c.name) && !comps.has(c.name)) comps.set(c.name, c.model);
  for (const s of opts.summaries) comps.set(s.competitor, s.competitorModel);

  const out: StrictSummary[] = [];
  for (const [competitor, competitorModel] of [...comps.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const judged = opts.summaries.find((s) => s.competitor === competitor)?.total ?? empty();
    const answeredByComp = new Set(
      opts.answers.filter((a) => a.ok && a.contestant === competitor && a.model === competitorModel && inScope(a)).map((a) => a.promptId),
    );
    const flintFailures = [...flintFailed].filter((id) => answeredByComp.has(id)).length;
    const total: Tally = { wins: judged.wins, losses: judged.losses + flintFailures, ties: judged.ties };
    const n = total.wins + total.losses + total.ties;
    if (n === 0) continue;
    const { signal, p } = signalOf(total.wins, total.losses);
    out.push({ competitor, competitorModel, total, flintFailures, n, winRate: winRate(total), p, signal, verdict: verdictOf(total.wins, total.losses, signal) });
  }
  return out;
}

const HISTORY_HEADER_V1 =
  'ts,run,prompt_set,competitor,competitor_model,judge_model,n,flint_wins,competitor_wins,ties,flint_win_rate,p_value,signal,judge_errors';
export const HISTORY_HEADER = HISTORY_HEADER_V1 + ',subject';

export function historyRow(run: string, promptSet: string, s: CompetitorSummary, ts: string, subject = 'flint'): string {
  const cells = [
    ts,
    run,
    promptSet,
    s.competitor,
    s.competitorModel,
    s.judgeModel,
    s.n,
    s.total.wins,
    s.total.losses,
    s.total.ties,
    s.winRate.toFixed(3),
    s.p.toPrecision(3),
    s.signal,
    s.judgeErrors,
    subject,
  ];
  return cells.map((c) => csvCell(String(c))).join(',');
}

function csvCell(s: string): string {
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function appendHistory(path: string, rows: string[]): void {
  mkdirSync(dirname(path), { recursive: true });
  migrateHistory(path);
  const header = existsSync(path) ? '' : HISTORY_HEADER + '\n';
  appendFileSync(path, header + rows.map((r) => r + '\n').join(''), 'utf8');
}

/** A v1 file (no subject column) gets the column, with every old row marked 'flint'. */
export function migrateHistory(path: string): void {
  if (!existsSync(path)) return;
  const lines = readFileSync(path, 'utf8').split('\n');
  if (lines[0] !== HISTORY_HEADER_V1) return;
  const body = lines.slice(1).filter((l) => l.trim()).map((l) => `${l},flint`);
  writeFileSync(path, [HISTORY_HEADER, ...body].join('\n') + '\n', 'utf8');
}

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;

export interface ReportInput {
  run: string;
  promptSet: string;
  promptCount: number;
  contestants: Array<{ name: string; model: string }>;
  answers: readonly AnswerRow[];
  summaries: readonly CompetitorSummary[];
  spendUsd: number;
  budgetUsd: number;
  stoppedForBudget: boolean;
  notes: string[];
  /** Which Flint this report judges; omitted means 'flint'. */
  subject?: string;
  /** The judge id the verdicts carry (a model or a panel id, `+grounded` when grounded), shown in the header. */
  judgeModel?: string;
  /** The prompts in scope, for the strict tally; omitted means every answer given. */
  promptIds?: ReadonlySet<string>;
  /**
   * The competitors this subject was (to be) judged against, for the strict
   * line; omitted means the non-Flint `contestants`. `report` passes the ones
   * with verdicts, since run.json lists every competitor the run started with.
   */
  strictCompetitors?: Array<{ name: string; model: string }>;
}

export function renderMarkdown(r: ReportInput): string {
  const L: string[] = [];
  const subject = r.subject ?? 'flint';
  L.push(`# Flint parity eval — ${r.run}${subject !== 'flint' ? ` (${subject})` : ''}`, '');
  L.push(`Prompt set: \`${r.promptSet}\` (${r.promptCount} prompts in this run).`);
  if (r.judgeModel) L.push(`Judge: \`${r.judgeModel}\`.`);
  L.push(`Spend this invocation: $${r.spendUsd.toFixed(2)} of a $${r.budgetUsd.toFixed(2)} budget${r.stoppedForBudget ? ' — **stopped early: budget reached**' : ''}.`, '');

  L.push('## Contestants', '', '| contestant | model | answered | failed | answer rate | spend |', '| --- | --- | ---: | ---: | ---: | ---: |');
  for (const c of r.contestants) {
    const rate = answerRate(r.answers, c.name);
    const cost = r.answers.filter((a) => a.contestant === c.name).reduce((s, a) => s + (a.costUsd || 0), 0);
    L.push(`| ${c.name} | \`${c.model}\` | ${rate.answered} | ${rate.failed} | ${rate.rate === undefined ? '—' : pct(rate.rate)} | $${cost.toFixed(2)} |`);
  }
  L.push('', 'Answer rate: of the prompts a contestant was asked, the share it answered. A failure is a prompt with no successful answer after retries.', '');

  const strict = strictSummarize({
    summaries: r.summaries,
    answers: r.answers,
    subject,
    competitors: r.strictCompetitors ?? r.contestants,
    ...(r.promptIds ? { promptIds: r.promptIds } : {}),
  });
  L.push('## Head to head (from Flint\'s side)', '');
  if (r.summaries.length === 0) L.push('_No judgments yet._', '');
  else {
    L.push('| vs | W | L | T | Flint win rate | p (sign test) | signal | verdict |', '| --- | ---: | ---: | ---: | ---: | ---: | --- | --- |');
    for (const s of r.summaries) {
      L.push(
        `| ${s.competitor} (\`${s.competitorModel}\`) | ${s.total.wins} | ${s.total.losses} | ${s.total.ties} | ${pct(s.winRate)} | ${s.p.toPrecision(3)} | ${s.signal} | ${s.verdict} |`,
      );
    }
    L.push('', 'Win rate counts a tie as half. p is the exact two-sided sign test on decisive games (ties dropped); SIGNIFICANT means p < 0.05, weak p < 0.32, fewer than 4 decisive games is always NOISE.', '');
  }
  if (strict.length) {
    L.push(
      '### Strict: a Flint failure counts as a loss',
      '',
      '| vs | W | L | of which Flint failed | T | strict win rate | p (sign test) | signal | verdict |',
      '| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |',
    );
    for (const s of strict) {
      L.push(
        `| ${s.competitor} (\`${s.competitorModel}\`) | ${s.total.wins} | ${s.total.losses} | ${s.flintFailures} | ${s.total.ties} | ${pct(s.winRate)} | ${s.p.toPrecision(3)} | ${s.signal} | ${s.verdict} |`,
      );
    }
    L.push(
      '',
      'The tally above only counts pairs where both sides answered. Here every prompt Flint failed to answer (no successful answer after retries: an empty answer, an HTTP error, a timeout) that the competitor did answer is added as a Flint loss, so failing to answer can never help Flint. Competitor failures are not counted as Flint wins, so this is a lower bound for Flint.',
      '',
    );
  }

  if (r.summaries.length) {
    const paneled = r.summaries.filter((s) => s.panelAgreement);
    if (paneled.length) {
      L.push('### Panel agreement', '', '| vs | judge | agreed | of | agreement |', '| --- | --- | ---: | ---: | ---: |');
      for (const s of paneled) {
        const a = s.panelAgreement!;
        L.push(`| ${s.competitor} | \`${s.judgeModel}\` | ${a.agreed} | ${a.n} | ${pct(a.n ? a.agreed / a.n : 0)} |`);
      }
      L.push(
        '',
        'Consensus rule: each pair is judged independently by every panelist (each with its own A/B order). A win or loss counts only when ALL panelists give it; any disagreement is scored as a tie (a split). A pair where any panelist errored is a judge error: excluded here and retried on resume. Low agreement means the judges themselves disagree about which answer is better, and the W/L above is correspondingly conservative.',
        '',
      );
    }

    for (const s of r.summaries) {
      L.push(`### vs ${s.competitor} — by category`, '', '| category | W | L | T | win rate | p | signal |', '| --- | ---: | ---: | ---: | ---: | ---: | --- |');
      for (const [cat, t] of Object.entries(s.byCategory)) {
        L.push(`| ${cat} | ${t.wins} | ${t.losses} | ${t.ties} | ${pct(winRate(t))} | ${t.p.toPrecision(3)} | ${t.signal} |`);
      }
      if (s.judgeErrors) L.push('', `${s.judgeErrors} judgment(s) failed to parse or errored and are excluded.`);
      L.push('');
    }
  }

  const flintErr = r.answers.filter((a) => a.contestant === subject && !a.ok && (!r.promptIds || r.promptIds.has(a.promptId)));
  if (flintErr.length) {
    L.push(
      '## Flint failures',
      '',
      'Prompts Flint failed to answer are not judged, so the head-to-head tally leaves them out; the strict line counts each one a competitor answered as a loss. Some are infrastructure failures (e.g. the local brain being down): fix those and re-run the same run dir to fill them in.',
      '',
    );
    const unanswered = flintErr.filter((a) => /\bunanswered=/.test(a.error ?? '')).length;
    if (unanswered) {
      L.push(
        `${unanswered} of these ${flintErr.length} were not answered by any model (\`unanswered=\`: every tier refused or came back empty, and the server sent its fallback message). A resume on the same server build will most likely fail them again.`,
        '',
      );
    }
    for (const a of flintErr.slice(0, 20)) L.push(`- \`${a.promptId}\`: ${(a.error ?? '').slice(0, 200)}`);
    if (flintErr.length > 20) L.push(`- … and ${flintErr.length - 20} more`);
    L.push('');
  }

  if (r.notes.length) {
    L.push('## Notes', '');
    for (const n of r.notes) L.push(`- ${n}`);
    L.push('');
  }
  return L.join('\n');
}

/**
 * The competitors `report` gives a strict line for. run.json lists every
 * competitor the run started with, but a later invocation on the run (another
 * `--local-model` candidate, a `--flint-variant`) may have faced only some of
 * them, and a line against one it never faced would count its failures and none
 * of its wins. So a competitor is in when:
 * - the subject was judged against it (by this judge), or
 * - it answered a prompt in scope and the two never both answered one: there
 *   was nothing to judge, so the subject's failures it answered are the whole
 *   strict tally. A subject that failed every prompt shows 0-N, as in the report
 *   `run` writes.
 * A competitor that answered alongside the subject but has no verdict against it
 * is left out.
 */
export function strictCompetitorsFor(opts: {
  subject: string;
  /** Latest answer rows, in scope. */
  answers: readonly AnswerRow[];
  /** This judge's verdict rows for the subject, in scope. */
  judgments: readonly JudgmentRow[];
  /** run.json's contestants. */
  contestants: ReadonlyArray<{ name: string; model: string }>;
}): Array<{ name: string; model: string }> {
  const out = new Map<string, string>();
  for (const j of opts.judgments) if (!out.has(j.competitor)) out.set(j.competitor, j.competitorModel);
  const subjectAnswered = new Set(opts.answers.filter((a) => a.ok && a.contestant === opts.subject).map((a) => a.promptId));
  const candidates = [...opts.contestants, ...opts.answers.filter((a) => a.ok).map((a) => ({ name: a.contestant, model: a.model }))];
  for (const c of candidates) {
    if (isFlintName(c.name) || out.has(c.name)) continue;
    const answered = opts.answers.filter((a) => a.ok && a.contestant === c.name && a.model === c.model).map((a) => a.promptId);
    if (answered.length === 0) continue;
    // Both answered a prompt, yet no verdict: not faced by this subject (or not judged yet).
    if (answered.some((id) => subjectAnswered.has(id))) continue;
    out.set(c.name, c.model);
  }
  return [...out].map(([name, model]) => ({ name, model }));
}

/** What `report` reads from a run's run.json. */
export interface RunMeta {
  promptSet: string;
  promptIds: string[];
  contestants: Array<{ name: string; model: string }>;
  judgeModel: string;
}

/**
 * `report`: one subject's report for one judge, re-rendered from a run's cached
 * rows (all of answers.jsonl and judgments.jsonl), over run.json's prompts.
 */
export function rerenderReport(opts: {
  run: string;
  meta: RunMeta;
  answers: readonly AnswerRow[];
  judgments: readonly JudgmentRow[];
  subject: string;
  /** The judge id to render (`+grounded` for a grounded judge's verdicts). */
  judgeModel: string;
}): string {
  const { meta, subject, judgeModel } = opts;
  const ids = new Set(meta.promptIds);
  const answers = latestAnswers(opts.answers);
  const judgeRows = opts.judgments.filter((j) => ids.has(j.promptId) && j.judgeModel === judgeModel && subjectOf(j) === subject);
  const spend = answers.reduce((s, a) => s + (a.costUsd || 0), 0) + judgeRows.reduce((s, j) => s + (j.costUsd || 0), 0);
  // run.json lists the contestants the run started with; a later --flint-local /
  // --local-model / --flint-variant invocation answered as its own contestant, so add that one.
  const extra = meta.contestants.some((c) => c.name === subject) ? [] : answers.filter((a) => a.contestant === subject).slice(0, 1);
  const contestants = [...extra.map((a) => ({ name: a.contestant, model: a.model })), ...meta.contestants];
  // The run's prompts only, like the verdicts: answer rates and the strict line cover the same set.
  const inScope = answers.filter((a) => ids.has(a.promptId));
  const notes = [`Re-rendered from cached rows (judge: ${judgeModel}); spend shown is the run total across invocations.`];
  if (splitGroundedJudgeId(judgeModel).grounded) notes.push(GROUNDED_NOTE);
  return renderMarkdown({
    run: opts.run,
    promptSet: meta.promptSet,
    promptCount: meta.promptIds.length,
    contestants,
    answers: inScope,
    summaries: summarize(latestJudgments(opts.judgments, judgeModel, subject, ids)),
    spendUsd: spend,
    budgetUsd: spend,
    stoppedForBudget: false,
    notes,
    subject,
    judgeModel,
    promptIds: ids,
    strictCompetitors: strictCompetitorsFor({ subject, answers: inScope, judgments: judgeRows, contestants: meta.contestants }),
  });
}
