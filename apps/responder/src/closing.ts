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

/*
 * A page that works and was never designed.
 *
 * The second product build shipped an HTML page with no CSS at all: default controls, a
 * full-grid table, and black text on a dark background for anyone in dark mode. Every
 * test passed, because nothing tests how a page looks. This can't judge whether a design
 * is good. It refuses a page with essentially no styling, or one that leaves text and
 * background colors to the browser.
 */

/** A goal with something a person looks at. */
export function hasInterface(goal: string): boolean {
  return /\b(html|web ?page|page|ui|interface|screen|front-?end|dashboard|website|web app)\b/i.test(goal);
}

/** CSS declarations below which a page counts as unstyled. */
export const MIN_DECLARATIONS = 25;

export function refuseUnstyled(goal: string, files: Array<{ name: string; content: string }>): string | null {
  if (!hasInterface(goal)) return null;
  const pages = files.filter((f) => /\.html?$/i.test(f.name));
  if (pages.length === 0) return null;

  const css = [
    ...files.filter((f) => /\.css$/i.test(f.name)).map((f) => f.content),
    ...pages.flatMap((f) => [...f.content.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1] ?? '')),
  ].join('\n');
  const declarations = (css.match(/[a-z-]+\s*:\s*[^;{}]+;/gi) ?? []).length;
  if (declarations < MIN_DECLARATIONS) {
    return `The page is essentially unstyled (${declarations} CSS declarations). Its design is part of done: style it before closing.`;
  }
  const setsBackground = /(^|[\s;{])background(-color)?\s*:/i.test(css);
  const setsColor = /(^|[\s;{])color\s*:/i.test(css);
  if (!setsBackground || !setsColor) {
    return 'The page leaves its text or background color to the browser, which is unreadable in dark mode. Set both explicitly before closing.';
  }
  return null;
}
