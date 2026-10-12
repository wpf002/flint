/**
 * What a note to Will may show (his standing rules, 2026-10-12): a short Title
 * Case title in plain words, and under it complete sentences. Never an action's
 * internal name ("backup.offsite"), a file path, a command, an id, raw JSON or
 * an aside in parentheses: details for debugging belong in the logs.
 *
 * titleCase is the console's own (apps/console/index.html; a test keeps the two
 * in step), so a title written here reads the same once the console shows it.
 * noteProblems is the standard as a check: every producer's inventory test runs
 * its words through it (apps/runtime/test/notes-inventory.test.ts,
 * apps/server/test/notes-inventory.test.ts).
 *
 * Two checks, because a note holds two kinds of words. noteProblems is for
 * Flint's own: it also refuses anything shaped like an internal name
 * (restore_drill, flint-server, FLINT_OFFSITE_DIR, worldNow) or an id.
 * shownProblems is for a name someone else gave a thing (a repo, a thread),
 * which may well be "nexus-responder" or "v2.1": it refuses only what no text
 * on a note may carry. The runtime checks Flint's words with the names masked
 * and each name on its own, so a good note is never swapped for its field-free
 * wording because a repo has a hyphen in its name.
 */

/** Short words a title keeps lowercase inside it. */
export const SMALL_WORDS: ReadonlySet<string> = new Set([
  'a', 'an', 'the', 'and', 'but', 'or', 'nor', 'for', 'so', 'yet', 'as', 'at', 'by', 'from', 'in', 'into', 'of', 'off', 'on', 'onto', 'out', 'over', 'to', 'up', 'with',
]);

/**
 * Apple's title style, for Flint's own short titles (never for someone else's
 * text). A word that carries its own capitals or marks (GitHub, iCloud, CI,
 * 2:15, #60) is left as it is written; a colon or a stop after a word is not
 * such a mark ("issue:" is "Issue:").
 */
export function titleCase(s: string): string {
  const w = String(s ?? '').split(' ');
  return w
    .map((x, i) => {
      if (!x) return x;
      if (/[A-Z].*[A-Z]|[a-z][A-Z]|\d|[_.:/@]/.test(x.replace(/[.:]+$/, ''))) return x;
      const l = x.toLowerCase();
      if (i > 0 && i < w.length - 1 && SMALL_WORDS.has(l)) return l;
      return l.replace(/^(\P{L}*)(\p{L})/u, (_m, p: string, c: string) => p + c.toUpperCase());
    })
    .join(' ');
}

/** An internal name's parts as words: "restore_drill" and "backup.offsite" lose their marks. */
export const nameWords = (s: string): string => s.replace(/[_.]+/g, ' ').trim();

/** A name Will gave a thing (a rule, a Nexus namespace), said in words: "ci_red.main" and "ci-red" lose their marks. */
export const plainName = (s: string): string => s.replace(/[-_.\s]+/g, ' ').trim();

/** What no text on a note may carry, whoever wrote it. */
const NEVER: ReadonlyArray<readonly [RegExp, string]> = [
  [/(^|[\s"'“(])~?\/[\w.~-]+|\/Users\//, 'a file path'],
  [/`/, 'a backtick'],
  // A flag, or "Run pnpm install": never bare tool names ("the npm service" is a service).
  [/(^|\s)--[a-z][\w-]*|(^|\s)-[A-Za-z]\b(?![-’'])|\b[Rr]un(?:ning)? (?:\.{0,2}\/|~\/|(?:pnpm|npm|npx|node|git|brew|launchctl|chmod|sudo|psql|zsh|bash|sh|make|tsx|docker|curl|age|kill)\b)/, 'a command'],
  [/^\s*[{[]|[{}]|\[\s*["{[]|"\s*:/m, 'raw JSON'],
  [/[()]/, 'parentheses'],
  [/[a-z][a-z0-9+.-]*:\/\//i, 'a link'],
  [/\$\{|\$[A-Za-z_]/, 'a variable'],
  [/\b(?:[A-Z][A-Za-z]*)?Error:/, 'an error’s own words'],
  // An entity ref (issue#24ehza).
  [/[a-z_]{2,20}#[A-Za-z0-9]{1,12}\b/, 'an id'],
];

/** Ordinary words with a hyphen: every other all-lowercase hyphenated word is taken for an internal name (flint-server). */
const HYPHENATED: ReadonlySet<string> = new Set([
  'auto-deploy', 'read-only', 'all-day', 're-run', 'sign-in', 'set-up', 'follow-up', 'check-in', 'built-in', 'up-to-date', 'day-to-day', 'e-mail', 'on-call', 'in-app',
  'age-encrypted', 'long-running', 'full-screen', 'field-free', 'one-time', 'third-party', 'money-related',
]);
/** Names written with a capital inside that are words, not code: said as they are written, never "IMessage". */
export const INNER_CAPITAL = /^(?:i(?:Cloud|Message|Phone|Pad|OS)|macOS)$/;
/** The endings of a site's name (claude.ai): a dotted pair that is not an action's name. */
const SITE_ENDINGS: ReadonlySet<string> = new Set(['ai', 'com', 'org', 'net', 'io', 'dev']);

/** The first thing in `text` shaped like an internal name or an id, in words; undefined when there is none. */
function internalIn(text: string): string | undefined {
  // restore_drill, FLINT_OFFSITE_DIR
  if (/(?<![\p{L}\p{N}_])[\p{L}\p{N}]+_[\p{L}\p{N}_]+/u.test(text)) return 'an internal name';
  // backup.offsite, com.flint.server, out.log: never a.m., e.g., v2.1 or claude.ai
  for (const m of text.matchAll(/(?<![\p{L}\p{N}.])[a-z][a-z0-9]*(?:\.[a-z0-9]+)+/gu)) {
    const parts = m[0].split('.');
    if (parts.every((p) => p.length === 1)) continue;
    if (parts.slice(1).every((p) => /^\d+$/.test(p))) continue;
    if (parts.length === 2 && SITE_ENDINGS.has(parts[1]!)) continue;
    return 'an internal name';
  }
  // flint-server, worker-2
  for (const m of text.matchAll(/(?<![\p{L}\p{N}-])[a-z][a-z0-9]*(?:-[a-z0-9]+)+(?![\p{L}\p{N}-])/gu)) if (!HYPHENATED.has(m[0])) return 'an internal name';
  // worldNow, offsiteDir
  for (const m of text.matchAll(/(?<![\p{L}\p{N}])[a-z]+[A-Z][A-Za-z0-9]*/gu)) if (!INNER_CAPITAL.test(m[0])) return 'an internal name';
  // A commit's hex, or a database id (cuid and Flint's own are long runs of lowercase letters and digits).
  if (/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/.test(text)) return 'an id';
  if (/(?<![\p{L}\p{N}])(?=[a-z0-9]*\d)(?=[a-z0-9]*[a-z])[a-z0-9]{16,}(?![\p{L}\p{N}])/u.test(text)) return 'an id';
  return undefined;
}

/**
 * Why a piece of text may not be shown on a note at all, in words; empty when it
 * may. For a name someone else gave a thing, and for a row stored before these
 * rules: it does not mind a hyphen or a dot in a name.
 */
export function shownProblems(text: string): string[] {
  return NEVER.filter(([re]) => re.test(text)).map(([, what]) => what);
}

/**
 * Why a note in Flint's own words is not fit to show, in words; empty when it
 * is. `title` is a short Title Case phrase with no stop; `body` is complete
 * sentences, one or more to a line (empty is allowed: a title can stand alone).
 */
export function noteProblems(title: string, body: string): string[] {
  const out: string[] = [];
  for (const [where, text] of [['title', title], ['body', body]] as const) {
    for (const what of shownProblems(text)) out.push(`the ${where} has ${what}`);
    const internal = internalIn(text);
    if (internal) out.push(`the ${where} has ${internal}`);
  }
  if (!title.trim()) out.push('the title is empty');
  if (title.length > 80) out.push('the title is over 80 characters');
  if (title !== titleCase(title)) out.push(`the title is not in Title Case (${titleCase(title)})`);
  // A question may be a title; a statement's stop may not end one.
  if (/[.!…]$/.test(title.trim())) out.push('the title ends with a stop');
  for (const line of body.split('\n')) {
    // A capital, a number or an opening quote first (iCloud and iMessage start with their own letter); a stop last, inside a closing quote or not.
    if (line && !/^(?:[\p{Lu}\p{N}“"$]|i[A-Z]).*[.!?…][”"’']?$/u.test(line.trim())) out.push(`a line of the body is not a sentence: ${line.slice(0, 60)}`);
  }
  return out;
}
