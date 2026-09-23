import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { CATEGORIES } from './categorize.js';
import type { Outcome } from './judge.js';
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
    for (const r of rows) {
      if (!r.ok || !r.outcome) {
        judgeErrors++;
        continue;
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
    });
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
}

export function renderMarkdown(r: ReportInput): string {
  const L: string[] = [];
  L.push(`# Flint parity eval — ${r.run}${r.subject && r.subject !== 'flint' ? ` (${r.subject})` : ''}`, '');
  L.push(`Prompt set: \`${r.promptSet}\` (${r.promptCount} prompts in this run).`);
  L.push(`Spend this invocation: $${r.spendUsd.toFixed(2)} of a $${r.budgetUsd.toFixed(2)} budget${r.stoppedForBudget ? ' — **stopped early: budget reached**' : ''}.`, '');

  L.push('## Contestants', '', '| contestant | model | answered | failed | spend |', '| --- | --- | ---: | ---: | ---: |');
  for (const c of r.contestants) {
    const mine = r.answers.filter((a) => a.contestant === c.name);
    const ok = mine.filter((a) => a.ok).length;
    const cost = mine.reduce((s, a) => s + (a.costUsd || 0), 0);
    L.push(`| ${c.name} | \`${c.model}\` | ${ok} | ${mine.length - ok} | $${cost.toFixed(2)} |`);
  }
  L.push('');

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

    for (const s of r.summaries) {
      L.push(`### vs ${s.competitor} — by category`, '', '| category | W | L | T | win rate | p | signal |', '| --- | ---: | ---: | ---: | ---: | ---: | --- |');
      for (const [cat, t] of Object.entries(s.byCategory)) {
        L.push(`| ${cat} | ${t.wins} | ${t.losses} | ${t.ties} | ${pct(winRate(t))} | ${t.p.toPrecision(3)} | ${t.signal} |`);
      }
      if (s.judgeErrors) L.push('', `${s.judgeErrors} judgment(s) failed to parse or errored and are excluded.`);
      L.push('');
    }
  }

  const flintErr = r.answers.filter((a) => a.contestant === 'flint' && !a.ok);
  if (flintErr.length) {
    L.push('## Flint failures', '', 'Prompts Flint failed to answer are NOT judged (they are infrastructure failures, e.g. the local brain being down), so they do not count as losses. Fix them and re-run the same run dir to fill them in.', '');
    for (const a of flintErr.slice(0, 20)) L.push(`- \`${a.promptId}\`: ${(a.error ?? '').slice(0, 200)}`);
    L.push('');
  }

  if (r.notes.length) {
    L.push('## Notes', '');
    for (const n of r.notes) L.push(`- ${n}`);
    L.push('');
  }
  return L.join('\n');
}
