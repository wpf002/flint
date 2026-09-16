import type { RanBefore } from './prompt.js';
import { measuredIn } from './visual-review.js';

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

/** The label a visual review gets among a turn's runs. */
export const VISUAL_REVIEW = 'visual review';

/**
 * A command that asks for the review by name.
 *
 * Only the responder produces a review, after a screenshot. The fourth product build
 * copied the label out of the run history into its own commands. The sandbox refused
 * it, and the refusal carried the review's label, so the close gate read it as a
 * review that had asked for fixes.
 */
export function namesReview(argv: string[]): boolean {
  return /^visual\s+review\b/i.test(argv.join(' ').trim());
}

/** Runs, newest first: this turn's, then each earlier turn's that ran anything. */
export type RunHistory = RanBefore[][];

/**
 * Why this thread can't close yet, or null when it can.
 *
 * Judged on the tests alone, from the newest run that ran any. The third product build
 * checked that an unknown city exits 1, which is correct, and the non-zero exit blocked
 * the close for three turns. A smoke check that fails on purpose says nothing about
 * whether the goal is met; the tests do.
 */
export function refuseClose(goal: string, history: RunHistory): string | null {
  if (!needsPassingRun(goal)) return null;
  const latest = history.find((runs) => runs.some((r) => TEST_COMMAND.test(r.command)));
  if (!latest) {
    return history.some((runs) => runs.length > 0)
      ? 'Nothing run in this thread has included the tests yet, and the goal needs a passing test run.'
      : 'The goal needs a passing test run, and nothing has been run in this thread yet.';
  }
  const failed = latest.find((r) => TEST_COMMAND.test(r.command) && !r.ok);
  return failed ? `The last test run failed at \`${failed.command}\`, so the goal isn't met yet.` : null;
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

/** Files that are, or contain, a page. A page inlined in server.js counts. */
export function pagesIn(files: Array<{ name: string; content: string }>): Array<{ name: string; content: string }> {
  return files.filter((f) => /\.html?$/i.test(f.name) || /<html[\s>]/i.test(f.content));
}

export function refuseUnstyled(goal: string, files: Array<{ name: string; content: string }>): string | null {
  if (!hasInterface(goal)) return null;
  if (pagesIn(files).length === 0) return null;

  // Any file's <style> blocks count. The third build's page lived in server.js as a
  // template string, and a check that only read .html files never saw it.
  const css = [
    ...files.filter((f) => /\.css$/i.test(f.name)).map((f) => f.content),
    ...files.flatMap((f) => [...f.content.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1] ?? '')),
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

/*
 * After this many reviews have asked for fixes, the review stops holding the build. The
 * third aqi run went sixteen rounds on one phone chart: the builders can't see the
 * screenshots, each round cost about 35k tokens, and the thread spent its whole turn cap
 * there. The newest notes are still in the thread for whoever speaks next.
 */
export const MAX_REVIEW_ROUNDS = 6;

/**
 * Why a build with a page can't close until someone has looked at it.
 *
 * The newest visual review has to pass, and a turn that changes the page has to have its
 * change looked at in the same turn: a review of the page as it was is not a review of
 * the page as it is.
 */
export function refuseUnreviewed(
  goal: string,
  files: Array<{ name: string; content: string }>,
  history: RunHistory,
  pageChangedThisTurn: boolean,
): string | null {
  if (!hasInterface(goal) || pagesIn(files).length === 0) return null;
  const reviewedNow = history[0]?.some((r) => r.command === VISUAL_REVIEW) ?? false;
  if (pageChangedThisTurn && !reviewedNow) {
    return 'This turn changed the page and nobody has looked at the change. Screenshot it in the same turn so it gets a visual review.';
  }
  const latest = history.flat().find((r) => r.command === VISUAL_REVIEW);
  if (!latest) {
    return 'Nobody has looked at the page yet. Run ["screenshot", "server.js", "/"] (or the HTML file) so it gets a visual review before closing.';
  }
  /*
   * Measured problems hold the build even when the reviewer passed it. In the fourth aqi
   * run the review passed a 17px text field and a 2:1 button three times. Capped like the
   * review, so a problem the builders can't fix doesn't hold the thread forever.
   */
  const shotRuns = history.filter((runs) => runs.some((r) => /^screenshot\b/.test(r.command)));
  const measured = measuredIn((shotRuns[0] ?? []).map((r) => r.output));
  const measuredRounds = shotRuns.filter((runs) => measuredIn(runs.map((r) => r.output)).length > 0).length;
  if (measured.length > 0 && measuredRounds <= MAX_REVIEW_ROUNDS) {
    // Five is enough to act on, and this text becomes the ask, which Nexus caps at 1,000.
    const worst = [...new Set(measured)].slice(0, 5);
    return `The phone view was measured and still has problems:\n${worst.map((m) => `- ${m}`).join('\n')}`;
  }
  if (latest.ok) return null;
  const rounds = history.flat().filter((r) => r.command === VISUAL_REVIEW && !r.ok).length;
  if (rounds >= MAX_REVIEW_ROUNDS) return null;
  return `The last visual review asked for fixes:\n${latest.output.slice(0, 700)}`;
}

/*
 * A step the goal gives a chat app, not yet taken.
 *
 * The sixth aqi run's goal gave ChatGPT the one review of the finished page. The builders
 * passed the tests and the design review and closed on turn 36 without handing it over:
 * nothing checked that the goal's steps had happened. A step the responder covered after
 * the app missed it counts as taken. The thread records that with a note, and holding the
 * close for the app again would only repeat the wait.
 */

const escapeSlug = (slug: string) => slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Where a slug is last named as itself, so `claude` isn't found inside `claude-api`. */
function lastMention(goal: string, slug: string): number {
  const re = new RegExp(`(?<![\\w-])${escapeSlug(slug)}(?![\\w-])`, 'g');
  let at = -1;
  for (const m of goal.matchAll(re)) at = m.index ?? at;
  return at;
}

export function skippedStep(
  goal: string,
  participants: Array<{ slug: string; answers_on_its_own?: boolean | undefined }>,
  turns: Array<{ by: string; kind?: 'note' | undefined; content?: string | undefined }>,
): string | null {
  const named = participants
    .filter((p) => p.answers_on_its_own === false)
    .map((p) => ({ slug: p.slug, at: lastMention(goal, p.slug) }))
    .filter((p) => p.at >= 0)
    // By where the goal last names them, which for a numbered plan is the app's own step.
    .sort((a, b) => a.at - b.at);
  for (const { slug } of named) {
    const spoke = turns.some((t) => t.kind !== 'note' && t.by === slug);
    const covered = turns.some((t) => t.kind === 'note' && (t.content ?? '').startsWith(`${slug} did not take its turn`));
    if (!spoke && !covered) return slug;
  }
  return null;
}

/** The numbered step of the goal that starts with this participant, if there is one. */
export function stepFor(goal: string, slug: string): string | null {
  const steps = goal.split(/(?=(?<![\w-])\d+\)\s)/);
  const own = new RegExp(`^\\d+\\)\\s*${escapeSlug(slug)}(?![\\w-])`);
  return steps.map((s) => s.trim()).find((s) => own.test(s)) ?? null;
}

export function refuseSkipped(slug: string): string {
  return `The goal gives ${slug} a step and ${slug} hasn't taken it, so this can't close yet.`;
}

/*
 * A review whose fixes were said to be made and weren't.
 *
 * In the eighth aqi run ChatGPT's review named four fixes in public/app.js and server.js.
 * The closing turn described all four as done and wrote only public/app.js: server.js
 * still sent plain-text errors, and the thread closed. A file the review names that
 * nobody has written since the review holds the close. Capped by turns, because a review
 * can name a file only to say it's fine.
 */

/** Builder turns after a review before its unchanged files stop holding the close. */
export const REVIEW_FIX_TURNS = 4;

/** Whether the text names this file as a path of its own, so `server.js` isn't found in `src/server.js`. */
function namesFile(text: string, name: string): boolean {
  return new RegExp(`(?<![\\w./-])${escapeSlug(name)}(?![\\w-])`).test(text);
}

export function unappliedReview(
  turns: Array<{ by: string; at?: string | undefined; kind?: 'note' | undefined; content?: string | undefined }>,
  participants: Array<{ slug: string; answers_on_its_own?: boolean | undefined }>,
  files: Array<{ name: string; history?: Array<{ at: string }> | undefined }>,
  writtenNow: string[],
): { by: string; files: string[] } | null {
  const apps = new Set(participants.filter((p) => p.answers_on_its_own === false).map((p) => p.slug));
  // The review is the newest turn by an app, or by whoever covered an app that missed it.
  let review = -1;
  turns.forEach((t, i) => {
    if (t.kind === 'note') return;
    const prev = turns[i - 1];
    const covered =
      prev?.kind === 'note' && prev.by === t.by && /^\S+ did not take its turn within 90 minutes/.test(prev.content ?? '');
    if (apps.has(t.by) || covered) review = i;
  });
  if (review < 0) return null;
  const { by, at, content } = turns[review]!;
  const since = at ? Date.parse(at) : Number.NaN;
  if (!content || !Number.isFinite(since)) return null;
  const later = turns.slice(review + 1).filter((t) => t.kind !== 'note').length;
  if (later >= REVIEW_FIX_TURNS) return null;

  const untouched = files
    .filter((f) => namesFile(content, f.name))
    .filter((f) => !writtenNow.includes(f.name))
    .filter((f) => !(f.history ?? []).some((h) => Date.parse(h.at) > since))
    .map((f) => f.name);
  return untouched.length > 0 ? { by, files: untouched } : null;
}

export function refuseUnapplied(found: { by: string; files: string[] }): string {
  const list = found.files.join(', ');
  return `${found.by}'s review named ${list}, and nothing has changed ${found.files.length === 1 ? 'it' : 'them'} since, so this can't close yet.`;
}
