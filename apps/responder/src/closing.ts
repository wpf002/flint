import type { RanBefore } from './prompt.js';

/*
 * When a thread may close.
 *
 * `done: true` is a participant's claim that the goal is met, and any participant can
 * make it. The first real product build ended on turn 1: asked to confirm three Node
 * APIs, Perplexity (API) answered and marked the thread done, before a single file
 * existed. For a goal whose finish line is a check, the claim needs evidence: the
 * thread's latest run includes a test command, and every command in it passed.
 */

/** A goal that says what has to pass, not only what to make. */
export function needsPassingRun(goal: string): boolean {
  return /\b(npm|pnpm|yarn)\s+(run\s+)?test\b|\bnode\s+--test\b|\bpytest\b|\btests?\s+pass/i.test(goal);
}

const TEST_COMMAND = /\btest\b|--test\b|\bvitest\b|\bjest\b|\bpytest\b/;

/** Why this thread can't close yet, or null when it can. */
export function refuseClose(goal: string, latestRuns: RanBefore[]): string | null {
  if (!needsPassingRun(goal)) return null;
  if (latestRuns.length === 0) {
    return 'The goal needs a passing test run, and nothing has been run in this thread yet.';
  }
  const failed = latestRuns.find((r) => !r.ok);
  if (failed) return `The last run failed at \`${failed.command}\`, so the goal isn't met yet.`;
  if (!latestRuns.some((r) => TEST_COMMAND.test(r.command))) {
    return 'The last run passed but included no tests, and the goal needs a passing test run.';
  }
  return null;
}
