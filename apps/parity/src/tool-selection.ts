/**
 * Flint's tool selection on a task, scored on its own: did he reach for the
 * systems the task needs? The plain head-to-head can't show this, because every
 * competitor is handed whatever Flint retrieved (a miss here costs both sides
 * the same data, and the pair usually reads as a tie). So it is its own metric,
 * Flint only, and the report's "strict + tool selection" line counts a judged
 * pair on a task Flint got wrong here as a loss (tasks-report tasksSelectionStrict).
 *
 * - A task's `need` is a list of groups; a group is met by calling any tool in
 *   it. `correct` = every group met, and no unrequested write.
 * - An unrequested write: a write the server captured as a proposal (eval mode
 *   rejects it) that the task didn't name explicitly (a `server.*` glob never
 *   counts as asking for a write). Always a selection failure.
 * - Extra calls (outside `need` and `ok`) are reported, not failed: an extra
 *   lookup costs time, not correctness.
 * - Tasks with no `need` are correct unless they wrote something unrequested.
 */
import type { AnswerRow } from './report.js';
import { matchesToolPattern, type TaskPrompt } from './tasks.js';

export interface ToolSelection {
  promptId: string;
  templateId: string;
  system: string;
  /** Distinct tools Flint called (tool results in the turn's grounding), in order. */
  called: string[];
  needGroups: number;
  groupsMet: number;
  /** The groups not met, as their patterns. */
  missing: string[][];
  /** Called, but in neither `need` nor `ok`. */
  extra: string[];
  unrequestedWrites: string[];
  correct: boolean;
  /** groupsMet / needGroups; undefined for a task with no need. */
  recall: number | undefined;
  /** `route: local` tasks: did the local brain answer? */
  localRouteHonored?: boolean;
}

const matchesAny = (name: string, patterns: readonly string[]): boolean => patterns.some((p) => matchesToolPattern(name, p));

/** The tools a Flint answer row shows it called, and the writes it proposed. */
export function toolsOf(row: Pick<AnswerRow, 'grounding' | 'meta'>): { called: string[]; proposed: string[] } {
  const called: string[] = [];
  for (const t of row.grounding?.tools ?? []) if (!called.includes(t.name)) called.push(t.name);
  const raw = row.meta?.proposed;
  const proposed = Array.isArray(raw) ? [...new Set(raw.filter((p): p is string => typeof p === 'string'))] : [];
  return { called, proposed };
}

export function scoreToolSelection(
  p: Pick<TaskPrompt, 'id' | 'templateId' | 'system' | 'tools' | 'route'>,
  called: readonly string[],
  proposed: readonly string[],
  brain?: string,
): ToolSelection {
  const expected = [...p.tools.need.flat(), ...p.tools.ok];
  const missing = p.tools.need.filter((g) => !called.some((c) => matchesAny(c, g)));
  const groupsMet = p.tools.need.length - missing.length;
  const extra = called.filter((c) => !matchesAny(c, expected));
  // Only a task that names the write asks for it: a `vantage.*` glob allows reads, never a write.
  const unrequestedWrites = proposed.filter((w) => !expected.includes(w));
  const correct = missing.length === 0 && unrequestedWrites.length === 0;
  return {
    promptId: p.id,
    templateId: p.templateId,
    system: p.system,
    called: [...called],
    needGroups: p.tools.need.length,
    groupsMet,
    missing,
    extra,
    unrequestedWrites,
    correct,
    recall: p.tools.need.length ? groupsMet / p.tools.need.length : undefined,
    ...(p.route === 'local' ? { localRouteHonored: brain === 'local' } : {}),
  };
}

export interface SelectionTally {
  /** Tasks scored (Flint answered them). */
  n: number;
  correct: number;
  /** Tasks with at least one need group, and how many met all of them. */
  withNeeds: number;
  allNeedsMet: number;
  /** Mean share of need groups met, over tasks with needs. */
  meanRecall: number | undefined;
  withExtra: number;
  unrequestedWrites: number;
  localRoute: { n: number; honored: number };
}

export interface SelectionSummary extends SelectionTally {
  bySystem: Record<string, SelectionTally>;
}

function tally(list: readonly ToolSelection[]): SelectionTally {
  const needs = list.filter((s) => s.needGroups > 0);
  const local = list.filter((s) => s.localRouteHonored !== undefined);
  return {
    n: list.length,
    correct: list.filter((s) => s.correct).length,
    withNeeds: needs.length,
    allNeedsMet: needs.filter((s) => s.missing.length === 0).length,
    meanRecall: needs.length ? needs.reduce((a, s) => a + (s.recall ?? 0), 0) / needs.length : undefined,
    withExtra: list.filter((s) => s.extra.length > 0).length,
    unrequestedWrites: list.filter((s) => s.unrequestedWrites.length > 0).length,
    localRoute: { n: local.length, honored: local.filter((s) => s.localRouteHonored).length },
  };
}

export function summarizeSelection(list: readonly ToolSelection[]): SelectionSummary {
  const bySystem: Record<string, SelectionTally> = {};
  for (const system of [...new Set(list.map((s) => s.system))].sort()) bySystem[system] = tally(list.filter((s) => s.system === system));
  return { ...tally(list), bySystem };
}
