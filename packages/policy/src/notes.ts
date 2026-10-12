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

const CHECKS: ReadonlyArray<readonly [RegExp, string]> = [
  // backup.offsite, restore_drill, com.flint.server, runtime-backup.out.log
  [/(^|[^\p{L}\p{N}])[a-z][a-z0-9]*(?:[._][a-z0-9]+)+/u, 'an internal name'],
  [/(^|[\s"'“(])~?\/[\w.~-]+|\/Users\//, 'a file path'],
  [/`/, 'a backtick'],
  [/(^|\s)--?[a-z][\w-]*=?|\b(pnpm|npm|launchctl|brew|chmod|sudo|psql)\s/, 'a command'],
  [/^\s*[{[]|[{}]|\[\s*["{[]|"\s*:/m, 'raw JSON'],
  [/[()]/, 'parentheses'],
  // An entity ref (issue#24ehza) or a commit's hex.
  [/[a-z_]{2,20}#[A-Za-z0-9]{1,12}\b|\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/, 'an id'],
];

/**
 * Why a note is not fit to show, in words; empty when it is. `title` is a short
 * Title Case phrase with no stop; `body` is complete sentences, one or more to
 * a line (empty is allowed: a title can stand alone).
 */
export function noteProblems(title: string, body: string): string[] {
  const out: string[] = [];
  for (const [where, text] of [['title', title], ['body', body]] as const) {
    for (const [re, what] of CHECKS) if (re.test(text)) out.push(`the ${where} has ${what}`);
  }
  if (!title.trim()) out.push('the title is empty');
  if (title.length > 80) out.push('the title is over 80 characters');
  if (title !== titleCase(title)) out.push(`the title is not in Title Case (${titleCase(title)})`);
  if (/[.!?…]$/.test(title.trim())) out.push('the title ends with a stop');
  for (const line of body.split('\n')) {
    if (line && !/^[\p{Lu}\p{N}“"$].*[.!?…]$/u.test(line.trim())) out.push(`a line of the body is not a sentence: ${line.slice(0, 60)}`);
  }
  return out;
}
