/**
 * The Flint-tasks report and history. Kept apart from parity's on purpose: a
 * tasks run lives under ~/.flint/eval/tasks/runs/, its history is
 * flint_tasks_history.csv (every row `suite=flint-tasks`), so its numbers never
 * mix with the general parity set's.
 */
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { privacyVendorOf } from './compat.js';
import { splitGroundedJudgeId } from './grounding.js';
import { describeCheck, normalizeModelId, type ModelCheck } from './model-currency.js';
import { answerRate, isFlintName, latestJudgments, summarize, winRate, type AnswerRow, type CompetitorSummary, type JudgmentRow, type Tally } from './report.js';
import { signalOf, verdictOf, type Signal } from './stats.js';
import { baseClass, vendorAllowed, type Exclusion, type NotCompared, type Sharing, type TaskContext } from './task-privacy.js';
import type { TaskPrompt } from './tasks.js';
import { summarizeSelection, type SelectionTally, type ToolSelection } from './tool-selection.js';

export const TASKS_SUITE = 'flint-tasks';

/**
 * The verdicts a report counts: this judge's and subject's latest per pair, and
 * only those given on the context the prompt has now (a verdict on an older
 * context is stale: that competitor answer has been replaced).
 */
export function currentJudgments(
  rows: readonly JudgmentRow[],
  judgeModel: string,
  subject: string,
  contexts: ReadonlyMap<string, Pick<TaskContext, 'sha'>>,
  promptIds: ReadonlySet<string>,
): JudgmentRow[] {
  const fresh = rows.filter((j) => j.contextSha !== undefined && j.contextSha === contexts.get(j.promptId)?.sha);
  return latestJudgments(fresh, judgeModel, subject, promptIds);
}

/**
 * Every (prompt, vendor) the allowlists kept apart: as a competitor (it wasn't
 * asked) and as a judge (it didn't judge). A prompt Flint failed has no context,
 * so its template's class decides. A Flint-only task is not compared at all, so
 * it has no exclusions to report.
 */
export function computeExclusions(opts: {
  prompts: readonly TaskPrompt[];
  contexts: ReadonlyMap<string, Pick<TaskContext, 'privacy'>>;
  competitors: readonly string[];
  judgeVendors: readonly string[];
  sharing: Sharing;
}): Exclusion[] {
  const out: Exclusion[] = [];
  for (const p of opts.prompts) {
    if (p.scoring === 'flint-only') continue;
    const privacy = opts.contexts.get(p.id)?.privacy ?? baseClass(p);
    for (const c of opts.competitors) {
      const vendor = privacyVendorOf(c);
      if (!vendorAllowed(vendor, privacy, opts.sharing)) out.push({ promptId: p.id, templateId: p.templateId, vendor, role: 'competitor', privacy });
    }
    for (const vendor of new Set(opts.judgeVendors)) {
      if (!vendorAllowed(vendor, privacy, opts.sharing)) out.push({ promptId: p.id, templateId: p.templateId, vendor, role: 'judge', privacy });
    }
  }
  return out;
}

export interface TasksStrict {
  competitor: string;
  competitorModel: string;
  total: Tally;
  flintFailures: number;
  /** Selection-strict only: judged pairs turned into losses because Flint missed a needed system (or wrote something unasked). */
  selectionMisses: number;
  n: number;
  winRate: number;
  p: number;
  signal: Signal;
  verdict: string;
}

/** The prompts Flint failed that could have gone to this competitor: compared tasks it may see. */
function failuresFor(flintFailed: readonly TaskPrompt[], competitor: string, sharing: Sharing): number {
  return flintFailed.filter((p) => p.scoring !== 'flint-only' && vendorAllowed(privacyVendorOf(competitor), baseClass(p), sharing)).length;
}

function strictRow(c: { name: string; model: string }, s: CompetitorSummary | undefined, total: Tally, flintFailures: number, selectionMisses: number): TasksStrict | undefined {
  const n = total.wins + total.losses + total.ties;
  if (n === 0) return undefined;
  const { signal, p } = signalOf(total.wins, total.losses);
  return { competitor: c.name, competitorModel: s?.competitorModel ?? c.model, total, flintFailures, selectionMisses, n, winRate: winRate(total), p, signal, verdict: verdictOf(total.wins, total.losses, signal) };
}

/**
 * The strict line: every prompt Flint failed counts as a loss against every
 * competitor the prompt could go to. (A competitor is only asked after Flint
 * answers, since its data is Flint's retrieval, so "the competitor answered it"
 * can't be the test here the way it is in parity.) Competitor failures are not
 * Flint wins, so this is a lower bound for Flint. Flint-only tasks aren't in it.
 */
export function tasksStrict(opts: {
  summaries: readonly CompetitorSummary[];
  competitors: ReadonlyArray<{ name: string; model: string }>;
  flintFailed: readonly TaskPrompt[];
  sharing: Sharing;
}): TasksStrict[] {
  const out: TasksStrict[] = [];
  for (const c of opts.competitors) {
    const s = opts.summaries.find((x) => x.competitor === c.name);
    const judged = s?.total ?? { wins: 0, losses: 0, ties: 0 };
    const flintFailures = failuresFor(opts.flintFailed, c.name, opts.sharing);
    const row = strictRow(c, s, { wins: judged.wins, losses: judged.losses + flintFailures, ties: judged.ties }, flintFailures, 0);
    if (row) out.push(row);
  }
  return out;
}

/**
 * Strict + tool selection: as strict, and a judged pair where Flint didn't call
 * a system the task needs (or wrote something nobody asked for) is a loss,
 * whatever the judges said. In the head-to-head such a pair is usually a tie:
 * the competitor is handed Flint's (missing) data and says the same "couldn't
 * check". A frontier product with its own connector would have looked, so this
 * line counts retrieval as part of the product.
 */
export function tasksSelectionStrict(opts: {
  judgments: readonly JudgmentRow[];
  selection: readonly ToolSelection[];
  competitors: ReadonlyArray<{ name: string; model: string }>;
  flintFailed: readonly TaskPrompt[];
  sharing: Sharing;
}): TasksStrict[] {
  const missed = new Set(opts.selection.filter((s) => !s.correct).map((s) => s.promptId));
  const summaries = summarize(opts.judgments);
  const out: TasksStrict[] = [];
  for (const c of opts.competitors) {
    const total: Tally = { wins: 0, losses: 0, ties: 0 };
    let selectionMisses = 0;
    for (const j of opts.judgments) {
      if (j.competitor !== c.name || !j.ok || !j.outcome) continue;
      if (missed.has(j.promptId)) {
        selectionMisses++;
        total.losses++;
      } else if (j.outcome === 'win') total.wins++;
      else if (j.outcome === 'loss') total.losses++;
      else total.ties++;
    }
    const flintFailures = failuresFor(opts.flintFailed, c.name, opts.sharing);
    total.losses += flintFailures;
    const row = strictRow(c, summaries.find((x) => x.competitor === c.name), total, flintFailures, selectionMisses);
    if (row) out.push(row);
  }
  return out;
}

/** The models Flint's own answers came from (`anthropic:claude-opus-5-5` → `claude-opus-5-5`). */
export function flintAnswerModels(answers: readonly AnswerRow[], subject: string): Set<string> {
  const out = new Set<string>();
  for (const a of answers) {
    if (a.contestant !== subject || !a.ok || typeof a.meta?.model !== 'string') continue;
    out.add(normalizeModelId(a.meta.model.replace(/^(anthropic|openai|google|amazon|ollama|perplexity):/, '')));
  }
  return out;
}

/** The models a judge id stands for: one, or each panelist's (`panel:anthropic:x+openai:y+grounded` → [x, y]). */
export function judgeMemberModels(judgeModel: string): string[] {
  const { base } = splitGroundedJudgeId(judgeModel);
  if (!base.startsWith('panel:')) return [base];
  return base
    .slice('panel:'.length)
    .split('+')
    .map((m) => m.slice(m.indexOf(':') + 1));
}

/**
 * Why a competitor is a baseline, not a frontier comparison: it is `claude-base`
 * (`--claude-base-model`), or its model is one Flint's own answers came from.
 */
export function baselineReason(c: { name: string; model: string }, flintModels: ReadonlySet<string>): string | undefined {
  if (c.name === 'claude-base') return "Flint's own base model (--claude-base-model)";
  if (flintModels.has(normalizeModelId(c.model))) return "the model Flint's own frontier answers came from";
  return undefined;
}

export interface TasksReportInput {
  run: string;
  taskSet: string;
  subject: string;
  judgeModel: string;
  /** The prompts in this run. */
  prompts: readonly TaskPrompt[];
  contestants: ReadonlyArray<{ name: string; model: string }>;
  /** Latest answer row per (prompt, contestant, model), in scope. */
  answers: readonly AnswerRow[];
  /** currentJudgments. */
  judgments: readonly JudgmentRow[];
  selection: readonly ToolSelection[];
  contexts: ReadonlyMap<string, TaskContext>;
  exclusions: readonly Exclusion[];
  sharing: Sharing;
  /** Each competitor's and judge's model, checked against its vendor's model list. */
  modelChecks: readonly ModelCheck[];
  /** The tool-excerpt length competitors got; undefined = the server's default 800. */
  contextChars: number | undefined;
  spendUsd: number;
  budgetUsd: number;
  stoppedForBudget: boolean;
  notes: readonly string[];
}

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
const frac = (a: number, b: number): string => (b ? `${a}/${b} (${pct(a / b)})` : '—');

function selectionRow(label: string, t: SelectionTally): string {
  return `| ${label} | ${t.n} | ${frac(t.correct, t.n)} | ${frac(t.allNeedsMet, t.withNeeds)} | ${t.meanRecall === undefined ? '—' : pct(t.meanRecall)} | ${t.withExtra} | ${t.unrequestedWrites} |`;
}

/** Why each answered task wasn't compared head to head. */
export function notComparedTasks(prompts: readonly TaskPrompt[], contexts: ReadonlyMap<string, TaskContext>, sharing: Sharing): Array<{ id: string; why: NotCompared | 'stay-local' }> {
  const out: Array<{ id: string; why: NotCompared | 'stay-local' }> = [];
  for (const p of prompts) {
    const ctx = contexts.get(p.id);
    if (!ctx) continue;
    if (ctx.notCompared) out.push({ id: p.id, why: ctx.notCompared });
    else if (ctx.privacy === 'local-only' && sharing.local.length === 0) out.push({ id: p.id, why: 'stay-local' });
  }
  return out;
}

const NOT_COMPARED_WHY: Record<NotCompared | 'stay-local', string> = {
  'flint-only': "about Flint himself (his identity, training or persona): no competitor can answer as Flint, so it's scored on tool selection only",
  'stay-local': 'Will asked for it to stay on his machine: no cloud vendor sees it without --share-local-with (tool selection and the local-brain check still count)',
  'unshared-memory': "Flint's answer read recalled memory the competitors weren't given (a server that ignored recall: false): not the same data, so not compared",
};

export function renderTasksReport(r: TasksReportInput): string {
  const L: string[] = [];
  const competitors = r.contestants.filter((c) => !isFlintName(c.name));
  const templates = new Set(r.prompts.map((p) => p.templateId)).size;
  const summaries = summarize(r.judgments);
  const flintModels = flintAnswerModels(r.answers, r.subject);
  L.push(`# Flint tasks: Flint vs frontier models on Will's work — ${r.run}`, '');
  L.push(`Task set: \`${r.taskSet}\` (${r.prompts.length} prompts from ${templates} templates in this run). Judge: \`${r.judgeModel}\`.`);
  L.push(
    `Personal prompts (email, calendar, Drive, memory, money) shared with: ${r.sharing.personal.join(', ')}. "Stay local" prompts shared with: ${r.sharing.local.length ? r.sharing.local.join(', ') : 'nobody (scored Flint-only)'}.`,
  );
  L.push(
    r.contextChars === undefined
      ? '**Short context:** competitors got each tool result cut to 800 characters (the server predates longer eval excerpts), while Flint read them in full. On data-heavy tasks this favours Flint; treat those rows with care.'
      : `Each competitor got the request plus the data Flint's tools returned (each result up to ${r.contextChars.toLocaleString('en-US')} characters) and, for memory tasks, the facts Flint recalled; on every other task Flint answered without long-term memory, so both sides had the same data. Each competitor was told the date and time Flint answered. The head-to-head is answer quality on the same data; tool selection is scored separately below.`,
  );
  L.push(`Spend this invocation: $${r.spendUsd.toFixed(2)} of a $${r.budgetUsd.toFixed(2)} budget${r.stoppedForBudget ? ' — **stopped early: budget reached**' : ''}.`, '');

  // The models: is each competitor the vendor's current top model?
  if (r.modelChecks.length) {
    L.push('## Models', '', '| who | model | vendor model list |', '| --- | --- | --- |');
    for (const c of r.modelChecks) L.push(`| ${c.role} | \`${c.model}\` | ${describeCheck(c)} |`);
    L.push('');
  }
  const baselines = competitors.map((c) => ({ c, why: baselineReason(c, flintModels) })).filter((b) => b.why);
  if (baselines.length) {
    L.push(
      `**Baseline, not a frontier comparison:** ${baselines.map((b) => `${b.c.name} (\`${b.c.model}\`) is ${b.why}`).join('; ')}. Its row says how much Flint's harness adds to his own model, not how he compares with what the vendor ships.`,
      '',
    );
  }
  const selfJudges = judgeMemberModels(r.judgeModel).filter((m) => flintModels.has(normalizeModelId(m)));
  if (selfJudges.length) {
    L.push(`**Self-preference risk:** the judge ${selfJudges.map((m) => `\`${m}\``).join(', ')} is also a model Flint's answers came from, and a judge tends to prefer its own model's writing. Re-judge with a panel that leaves it out.`, '');
  }

  L.push('## Contestants', '', '| contestant | model | answered | failed | answer rate | spend |', '| --- | --- | ---: | ---: | ---: | ---: |');
  for (const c of r.contestants) {
    const rate = answerRate(r.answers, c.name);
    const cost = r.answers.filter((a) => a.contestant === c.name).reduce((s, a) => s + (a.costUsd || 0), 0);
    L.push(`| ${c.name} | \`${c.model}\` | ${rate.answered} | ${rate.failed} | ${rate.rate === undefined ? '—' : pct(rate.rate)} | $${cost.toFixed(2)} |`);
  }
  L.push('');

  const label = (name: string, model: string): string => `${name} (\`${model}\`)${baselineReason({ name, model }, flintModels) ? ' — baseline' : ''}`;
  L.push("## Head to head (from Flint's side), all systems", '');
  if (summaries.length === 0) L.push('_No judgments yet._', '');
  else {
    L.push('| vs | W | L | T | Flint win rate | p (sign test) | signal | verdict |', '| --- | ---: | ---: | ---: | ---: | ---: | --- | --- |');
    for (const s of summaries) {
      L.push(`| ${label(s.competitor, s.competitorModel)} | ${s.total.wins} | ${s.total.losses} | ${s.total.ties} | ${pct(s.winRate)} | ${s.p.toPrecision(3)} | ${s.signal} | ${s.verdict} |`);
    }
    L.push('', 'Win rate counts a tie as half, so 50% is parity. p is the exact two-sided sign test on decisive games; SIGNIFICANT means p < 0.05, weak p < 0.32, and fewer than 4 decisive games is NOISE.', '');
    const paneled = summaries.filter((s) => s.panelAgreement);
    if (paneled.length) {
      L.push('### Panel agreement', '', '| vs | agreed | of | agreement |', '| --- | ---: | ---: | ---: |');
      for (const s of paneled) L.push(`| ${s.competitor} | ${s.panelAgreement!.agreed} | ${s.panelAgreement!.n} | ${pct(s.panelAgreement!.n ? s.panelAgreement!.agreed / s.panelAgreement!.n : 0)} |`);
      L.push(
        '',
        'A win or loss counts only when every panelist gives it (each with its own A/B order); any disagreement is a tie (a split). On personal tasks only the panelists whose vendor may see them judge (see Privacy).',
        '',
      );
    }
  }

  const flintLatest = new Map(r.answers.filter((a) => a.contestant === r.subject).map((a) => [a.promptId, a]));
  const flintFailed = r.prompts.filter((p) => flintLatest.has(p.id) && !flintLatest.get(p.id)!.ok);
  const strict = tasksStrict({ summaries, competitors, flintFailed, sharing: r.sharing });
  if (strict.length) {
    L.push('### Strict: a Flint failure counts as a loss', '', '| vs | W | L | of which Flint failed | T | strict win rate | p | signal |', '| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |');
    for (const s of strict) {
      L.push(`| ${s.competitor} | ${s.total.wins} | ${s.total.losses} | ${s.flintFailures} | ${s.total.ties} | ${pct(s.winRate)} | ${s.p.toPrecision(3)} | ${s.signal} |`);
    }
    L.push('', 'Every task Flint failed to answer (no answer after retries, or the "no model answered" fallback) is a loss against every competitor that task could go to. Competitor failures are not counted as Flint wins, so this is a lower bound for Flint.', '');
  }
  const selStrict = tasksSelectionStrict({ judgments: r.judgments, selection: r.selection, competitors, flintFailed, sharing: r.sharing });
  if (selStrict.length) {
    L.push(
      '### Strict + tool selection: a retrieval miss counts as a loss',
      '',
      '| vs | W | L | of which tool-selection misses | of which Flint failed | T | win rate | p | signal |',
      '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
    );
    for (const s of selStrict) {
      L.push(`| ${s.competitor} | ${s.total.wins} | ${s.total.losses} | ${s.selectionMisses} | ${s.flintFailures} | ${s.total.ties} | ${pct(s.winRate)} | ${s.p.toPrecision(3)} | ${s.signal} |`);
    }
    L.push(
      '',
      'As strict, and every judged pair where Flint didn\'t call a system the task needs (or wrote something nobody asked for) is a loss, whatever the judges said: the competitor was handed the same missing data, so the pair usually reads as a tie, but a frontier product with its own connector would have looked. The misses are listed under Tool selection.',
      '',
    );
  }

  // Per system: Flint's win rate against each competitor.
  const systems = [...new Set(r.prompts.map((p) => p.system))].sort();
  if (summaries.length) {
    L.push('## By system', '', `| system | tasks | ${summaries.map((s) => `vs ${s.competitor}`).join(' | ')} |`, `| --- | ---: | ${summaries.map(() => '---:').join(' | ')} |`);
    for (const sys of systems) {
      const cells = summaries.map((s) => {
        const t = s.byCategory[`task:${sys}`];
        return t ? `${pct(winRate(t))} (${t.wins}-${t.losses}-${t.ties})` : '—';
      });
      L.push(`| ${sys} | ${r.prompts.filter((p) => p.system === sys).length} | ${cells.join(' | ')} |`);
    }
    L.push('', 'Each cell: Flint win rate (W-L-T) on that system\'s tasks. Small cells are noise; a "—" means no judged pair (not compared, not asked, excluded by the privacy allowlist, or not judged yet).', '');
  }

  const notCompared = notComparedTasks(r.prompts, r.contexts, r.sharing);
  if (notCompared.length) {
    L.push('## Not compared (Flint only)', '');
    for (const why of ['flint-only', 'stay-local', 'unshared-memory'] as const) {
      const ids = notCompared.filter((n) => n.why === why).map((n) => `\`${n.id}\``);
      if (ids.length) L.push(`- ${ids.length} task(s) ${NOT_COMPARED_WHY[why]}: ${ids.slice(0, 12).join(', ')}${ids.length > 12 ? `, … ${ids.length - 12} more` : ''}.`);
    }
    L.push('', 'None of these is in the head-to-head, the strict lines or the history; all are in tool selection below.', '');
  }

  // Tool selection.
  const sel = summarizeSelection(r.selection);
  L.push('## Tool selection (Flint only)', '');
  if (sel.n === 0) L.push('_No Flint answers yet._', '');
  else {
    L.push(
      `Correct on ${frac(sel.correct, sel.n)} of the tasks Flint answered: every system the task needs was called and nothing was written that wasn't asked for. On the ${sel.withNeeds} tasks that need tools, all needed systems were called on ${frac(sel.allNeedsMet, sel.withNeeds)}, and ${sel.meanRecall === undefined ? '—' : pct(sel.meanRecall)} of the needed systems on average.` +
        (sel.localRoute.n ? ` "Stay local" tasks answered by the local brain: ${frac(sel.localRoute.honored, sel.localRoute.n)}.` : ''),
      '',
      '| system | tasks | correct | all needs met | mean recall | with extra calls | unrequested writes |',
      '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
    );
    for (const [sys, t] of Object.entries(sel.bySystem)) L.push(selectionRow(sys, t));
    L.push(selectionRow('**all**', sel), '');
    const misses = r.selection.filter((s) => !s.correct || (s.localRouteHonored === false));
    if (misses.length) {
      L.push('### Misses', '');
      for (const s of misses.slice(0, 40)) {
        const why = [
          ...(s.missing.length ? [`missing ${s.missing.map((g) => g.join(' or ')).join('; ')}`] : []),
          ...(s.unrequestedWrites.length ? [`unrequested write ${s.unrequestedWrites.join(', ')}`] : []),
          ...(s.localRouteHonored === false ? ['not answered on the local brain'] : []),
        ].join('; ');
        L.push(`- \`${s.promptId}\`: ${why}. Called: ${s.called.length ? s.called.join(', ') : 'nothing'}.`);
      }
      if (misses.length > 40) L.push(`- … and ${misses.length - 40} more`);
      L.push('');
    }
    L.push(
      'Tool selection is Flint-only: competitors are handed what Flint retrieved, so in the plain head-to-head a miss costs both sides the same data (the "strict + tool selection" line counts it as a loss instead). `calculate` is never required. Extra calls are listed, not failed.',
      '',
    );
  }

  // Privacy.
  L.push('## Privacy', '');
  L.push(
    `Default: personal-comms and personal-finance tasks go only to vendors on the allowlist (${r.sharing.personal.join(', ')}), as competitor context and as judge input; \`--share-personal-with\` extends it. "Stay local" tasks go to no cloud vendor unless \`--share-local-with\` names it. A task's class is raised by any tool Flint called whose data is more private than the template's class. Recalled memory is handed over only for tasks whose point is memory; on every other task Flint answers without it, so no judge sees an answer built on memory it wasn't shown.`,
    '',
  );
  if (r.exclusions.length === 0) L.push('Nothing was excluded.', '');
  else {
    L.push('| vendor | role | tasks excluded | examples |', '| --- | --- | ---: | --- |');
    const groups = new Map<string, Exclusion[]>();
    for (const e of r.exclusions) groups.set(`${e.vendor}|${e.role}`, [...(groups.get(`${e.vendor}|${e.role}`) ?? []), e]);
    for (const [k, list] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
      const [vendor, role] = k.split('|');
      const ids = list.map((e) => `\`${e.promptId}\``);
      L.push(`| ${vendor} | ${role} | ${list.length} | ${ids.slice(0, 12).join(', ')}${ids.length > 12 ? `, … ${ids.length - 12} more` : ''} |`);
    }
    L.push('');
  }
  const raised = [...r.contexts.entries()].filter(([, c]) => c.raisedBy.length);
  if (raised.length) L.push(`Class raised by what Flint called on ${raised.length} task(s): ${raised.slice(0, 10).map(([id, c]) => `\`${id}\` (${c.raisedBy.join(', ')} → ${c.privacy})`).join('; ')}${raised.length > 10 ? '; …' : ''}.`, '');
  const restricted = r.judgments.filter((j) => j.excludedJudges?.length);
  if (restricted.length) {
    L.push(
      `${restricted.length} verdict(s) came from a smaller panel because the task is personal (left out: ${[...new Set(restricted.flatMap((j) => j.excludedJudges ?? []))].join(', ')}). With only Anthropic judging, expect some self-preference toward Claude-written answers, Flint's included.`,
      '',
    );
  }

  const truncated = [...r.contexts.entries()].filter(([, c]) => c.truncated.length);
  if (truncated.length) {
    L.push(
      '## Context caveat',
      '',
      `On ${truncated.length} task(s) a tool result hit the excerpt limit, so competitors saw less of it than Flint did: ${truncated.slice(0, 10).map(([id, c]) => `\`${id}\` (${c.truncated.join(', ')})`).join('; ')}${truncated.length > 10 ? '; …' : ''}. Raise --context-chars to close the gap.`,
      '',
    );
  }

  const failures = r.answers.filter((a) => a.contestant === r.subject && !a.ok);
  if (failures.length) {
    L.push('## Flint failures', '');
    for (const a of failures.slice(0, 20)) L.push(`- \`${a.promptId}\`: ${(a.error ?? '').slice(0, 200)}`);
    if (failures.length > 20) L.push(`- … and ${failures.length - 20} more`);
    L.push('');
  }

  if (r.notes.length) {
    L.push('## Notes', '');
    for (const n of r.notes) L.push(`- ${n}`);
    L.push('');
  }
  return L.join('\n');
}

const HEADER =
  'ts,suite,run,task_set,subject,competitor,competitor_model,competitor_role,competitor_model_status,judge_model,n,flint_wins,competitor_wins,ties,flint_win_rate,p_value,signal,judge_errors,strict_n,strict_win_rate,flint_failures,selection_strict_n,selection_strict_win_rate,selection_misses,tool_selection_correct,tool_selection_n,share_personal_with,share_local_with';

/**
 * One row per competitor per invocation that judged something new; the last row
 * per (run, competitor) is the result. `competitor_role` is `baseline` for Flint's
 * own base model (never quote it as a frontier result), and
 * `competitor_model_status` says whether the model was the vendor's newest when
 * the run checked.
 */
export function tasksHistoryRows(opts: {
  ts: string;
  run: string;
  taskSet: string;
  subject: string;
  summaries: readonly CompetitorSummary[];
  strict: readonly TasksStrict[];
  selectionStrict: readonly TasksStrict[];
  selection: readonly ToolSelection[];
  sharing: Sharing;
  modelChecks: readonly ModelCheck[];
  flintModels: ReadonlySet<string>;
}): string[] {
  const sel = summarizeSelection(opts.selection);
  return opts.summaries.map((s) => {
    const st = opts.strict.find((x) => x.competitor === s.competitor);
    const ss = opts.selectionStrict.find((x) => x.competitor === s.competitor);
    const check = opts.modelChecks.find((c) => c.role === s.competitor && c.model === s.competitorModel);
    return [
      opts.ts,
      TASKS_SUITE,
      opts.run,
      opts.taskSet,
      opts.subject,
      s.competitor,
      s.competitorModel,
      baselineReason({ name: s.competitor, model: s.competitorModel }, opts.flintModels) ? 'baseline' : 'frontier',
      check?.status ?? 'unchecked',
      s.judgeModel,
      s.n,
      s.total.wins,
      s.total.losses,
      s.total.ties,
      s.winRate.toFixed(3),
      s.p.toPrecision(3),
      s.signal,
      s.judgeErrors,
      st?.n ?? s.n,
      (st?.winRate ?? s.winRate).toFixed(3),
      st?.flintFailures ?? 0,
      ss?.n ?? s.n,
      (ss?.winRate ?? s.winRate).toFixed(3),
      ss?.selectionMisses ?? 0,
      sel.correct,
      sel.n,
      opts.sharing.personal.join('+'),
      opts.sharing.local.join('+'),
    ]
      .map((c) => {
        const v = String(c);
        return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
      })
      .join(',');
  });
}

export function appendTasksHistory(path: string, rows: readonly string[]): void {
  if (rows.length === 0) return;
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, (existsSync(path) ? '' : HEADER + '\n') + rows.map((r) => r + '\n').join(''), 'utf8');
}

export const TASKS_HISTORY_HEADER = HEADER;
