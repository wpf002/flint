/**
 * The hybrid mode's routing rules: for each message, this Mac or the cloud.
 *
 * THIS IS THE ONE MODULE TO TUNE. The rules are data: an ordered table, first
 * match wins. To change how hybrid routes, edit `HYBRID_RULES` (delete a row,
 * reorder rows, change a row's `route`) or the numbers in
 * `HYBRID_THRESHOLDS`. Nothing else in the server decides a hybrid turn;
 * `decideHybrid` only walks the table. test/hybrid-rules.test.ts has one case
 * per row, and checks that the README's table is this one.
 *
 * What a rule can look at (`TurnFacts`) is what the server knows about a
 * message before any model is asked, none of it the message's content beyond
 * two regular expressions and a length:
 *  - `private`: Will's Local Only switch, or the message asks to stay local;
 *  - `deep`: the request body says so, or the message asks to think it through;
 *  - `tier`: the classifier's sort (routine, standard, hard, code);
 *  - `toolsLikely`: the tool router is confident the message needs a tool
 *    beyond the always-on ones;
 *  - `longContext`: the conversation is long for the local model's window;
 *  - `mediaLocalCannotRead`: an image or PDF the local model cannot read;
 *  - whether each side is there to answer, and whether the local model can
 *    call tools.
 *
 * `fallThrough` says whether the other side may answer when the chosen one
 * cannot, before anything was shown or any tool ran. A private message never
 * falls through: it stays on this Mac or is not answered.
 *
 * Kept free of index.ts so it is unit-testable (index.ts runs main() on import).
 */
import type { Tier } from '@flint/core';

/** Why a turn went where it did: a rule's id, or the mode itself. What the [route] line records. */
export type RouteReason =
  | 'private'
  | 'media'
  | 'local_unavailable'
  | 'cloud_unavailable'
  | 'deep'
  | 'tools_unsupported'
  | 'tools'
  | 'long_context'
  | 'difficulty'
  | 'default'
  | 'mode_local'
  | 'mode_cloud'
  | 'eval';

export interface TurnFacts {
  /** `localOnly: true` on the request, or the message asks to stay local (./policy FORCE_LOCAL_RE). */
  private: boolean;
  /** `deep: true` on the request, or the message matches DEEP_RE. */
  deep: boolean;
  /** The classifier's tier (@flint/core classifyMessage). */
  tier: Tier;
  /** The tool router's confident match on a tool that is not always offered (./router toolsLikely). */
  toolsLikely: boolean;
  /** Estimated tokens of the message, its text attachments and the history it is sent with. */
  promptTokens: number;
  /** The turn carries an image or PDF the local model cannot read. */
  mediaLocalCannotRead: boolean;
  local: {
    /** The local server answers and a local model is installed (and "local" is this Mac). */
    available: boolean;
    /** The local model can call tools (its capability flag). */
    tools: boolean;
    /** The local model's context window. */
    contextTokens: number;
  };
  cloud: {
    /** A cloud model is configured. (A spent budget or a paused provider is applied afterwards: ./spend, ./frontier-breaker.) */
    available: boolean;
  };
}

/** One condition of a rule. Every condition of a rule must hold. */
export type Cond =
  | { fact: 'private' | 'deep' | 'toolsLikely' | 'mediaLocalCannotRead' | 'localAvailable' | 'cloudAvailable' | 'localTools' | 'longContext'; is: boolean }
  | { fact: 'tier'; in: readonly Tier[] };

export interface HybridRule {
  /** The reason the [route] line records when this rule decides. */
  id: RouteReason;
  /** All must hold. Empty: always. */
  when: readonly Cond[];
  route: 'local' | 'cloud';
  /** May the other side answer if this one cannot, before anything was shown? */
  fallThrough: boolean;
  /** One sentence, for the README's table. */
  note: string;
}

export const HYBRID_THRESHOLDS = {
  /** A prompt over this share of the local window (after the reserve) is long. */
  longContextFraction: 0.75,
  /** Tokens set aside for the system prompt, tool schemas and the reply... */
  reservedTokens: 4096,
  /**
   * ...and never more than this share of the window. With a flat 4,096 a
   * window of 4,096 or less had no room at all, so EVERY message was "long"
   * and a hybrid machine with a small local model sent everything to the
   * cloud. A 4,096 window sets 2,048 aside and has 2,048 of room.
   */
  reservedFraction: 0.5,
} as const;

/** "Give this one real thought": the plain-language way to ask for the cloud model in hybrid. */
export const DEEP_RE = /\b(think (hard|deeply|carefully)|go deep|deep dive|in depth|use the (cloud|big|best) (model|brain))\b/i;

/** How much of each end of a message is read for Will's own instruction. */
const INSTRUCTION_REACH = 160;

/** What closes each kind of quotation mark. */
const QUOTE_CLOSER: Readonly<Record<string, string>> = { '"': '"', '“': '”', '«': '»' };

/**
 * `text` with each stretch that is quoted on one line replaced by a space: from
 * a quotation mark to the first mark that closes it, when that is on the same
 * line. What the pattern `"[^"\n]*"|“[^”\n]*”|«[^»\n]*»` matched, found in
 * one pass: where the next closer of each kind is, and where the line ends, is
 * looked up once and kept until the scan has passed it, so a long run of
 * openers with nothing to close them costs one look, not one per opener.
 */
export function withoutQuoted(text: string): string {
  const nextCloser = new Map<string, number>();
  let lineEnd = -1;
  let out = '';
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    const closer = QUOTE_CLOSER[text[i]!];
    if (closer === undefined) continue;
    if (i > lineEnd) {
      lineEnd = text.indexOf('\n', i);
      if (lineEnd === -1) lineEnd = text.length;
    }
    let at = nextCloser.get(closer);
    // Looked up afresh only once the scan is past the one that was found (-1: there is none left at all).
    if (at === undefined || (at !== -1 && at <= i)) {
      at = text.indexOf(closer, i + 1);
      nextCloser.set(closer, at);
    }
    if (at === -1 || at > lineEnd) continue; // nothing closes it on this line: it is not a quotation
    out += `${text.slice(from, i)} `;
    i = at;
    from = at + 1;
  }
  return out + text.slice(from);
}

/**
 * Did WILL ask for a deep answer, in his own words? DEEP_RE alone matched
 * anything the message carried: a pasted note that says "we cover it in depth
 * next week", an email that says "please use the cloud model for billing".
 * Text that is quoted or pasted is somebody else's, and it must not choose the
 * model (least of all the cloud). So the phrase counts only:
 *  - outside quotation marks, code and quoted lines (`>`), and
 *  - near the start or the end of the message, where an instruction sits: the
 *    first and last 160 characters of what is left.
 *
 * It runs on the event loop for every hybrid message, on whatever was pasted,
 * so every step is linear in the message. Two were not: a pattern for quoted
 * text rescanned the rest of the line from every `“` in a long run of them
 * (`withoutQuoted` reads the line once instead), and a pattern for quoted
 * lines rescanned a long run of blank lines from every line start (a quoted
 * line's indent is now spaces and tabs, never newlines).
 */
export function asksDeep(message: string): boolean {
  const code = message
    .replace(/```[\s\S]*?(```|$)/g, ' ') // fenced code, closed or not
    .replace(/`[^`\n]*`/g, ' '); // inline code
  const own = withoutQuoted(code) // quoted on one line
    .replace(/^[ \t]*>.*$/gm, ' ') // quoted lines
    .replace(/[ \t]+/g, ' ')
    .trim();
  if (own.length <= INSTRUCTION_REACH * 2) return DEEP_RE.test(own);
  return DEEP_RE.test(own.slice(0, INSTRUCTION_REACH)) || DEEP_RE.test(own.slice(-INSTRUCTION_REACH));
}

/**
 * The table. Ordered; the first rule whose conditions all hold decides.
 *
 * The first four rows are about what CAN answer and come before any preference:
 * a private message stays here; a file goes to a model that can read it; a
 * side that is not there cannot be chosen.
 */
export const HYBRID_RULES: readonly HybridRule[] = [
  { id: 'private', when: [{ fact: 'private', is: true }], route: 'local', fallThrough: false, note: 'A private message stays on this Mac.' },
  { id: 'media', when: [{ fact: 'mediaLocalCannotRead', is: true }], route: 'cloud', fallThrough: false, note: 'An image or PDF goes to a model that can read it.' },
  { id: 'local_unavailable', when: [{ fact: 'localAvailable', is: false }], route: 'cloud', fallThrough: false, note: 'The local model is not available.' },
  { id: 'cloud_unavailable', when: [{ fact: 'cloudAvailable', is: false }], route: 'local', fallThrough: false, note: 'No cloud model is configured.' },
  { id: 'deep', when: [{ fact: 'deep', is: true }], route: 'cloud', fallThrough: true, note: 'Will asked for a deep answer.' },
  {
    id: 'tools_unsupported',
    when: [
      { fact: 'toolsLikely', is: true },
      { fact: 'localTools', is: false },
    ],
    route: 'cloud',
    fallThrough: true,
    note: 'The message needs tools and the local model cannot call them.',
  },
  { id: 'tools', when: [{ fact: 'toolsLikely', is: true }], route: 'cloud', fallThrough: true, note: 'The message needs tools.' },
  { id: 'long_context', when: [{ fact: 'longContext', is: true }], route: 'cloud', fallThrough: true, note: 'The conversation is too long for the local window.' },
  { id: 'difficulty', when: [{ fact: 'tier', in: ['hard', 'code'] }], route: 'cloud', fallThrough: true, note: 'The message is hard reasoning or code.' },
  { id: 'default', when: [], route: 'local', fallThrough: true, note: 'Everything else is answered on this Mac.' },
];

/** Is the prompt long for the local window? */
export function isLongContext(f: Pick<TurnFacts, 'promptTokens' | 'local'>, thresholds: typeof HYBRID_THRESHOLDS = HYBRID_THRESHOLDS): boolean {
  return f.promptTokens > thresholds.longContextFraction * localRoom(f.local.contextTokens, thresholds);
}

/** The local window's room for the message and its history: the real window, less a reserve that is never more than its share of it. */
export function localRoom(contextTokens: number, thresholds: typeof HYBRID_THRESHOLDS = HYBRID_THRESHOLDS): number {
  const window = Math.max(0, contextTokens);
  const reserve = Math.min(thresholds.reservedTokens, Math.floor(window * thresholds.reservedFraction));
  return window - reserve;
}

function holds(c: Cond, f: TurnFacts): boolean {
  switch (c.fact) {
    case 'private':
      return f.private === c.is;
    case 'deep':
      return f.deep === c.is;
    case 'toolsLikely':
      return f.toolsLikely === c.is;
    case 'mediaLocalCannotRead':
      return f.mediaLocalCannotRead === c.is;
    case 'localAvailable':
      return f.local.available === c.is;
    case 'cloudAvailable':
      return f.cloud.available === c.is;
    case 'localTools':
      return f.local.tools === c.is;
    case 'longContext':
      return isLongContext(f) === c.is;
    case 'tier':
      return c.in.includes(f.tier);
  }
}

export interface HybridDecision {
  route: 'local' | 'cloud';
  reason: RouteReason;
  fallThrough: boolean;
}

/**
 * Walk the table: the first rule whose conditions all hold. A table with no
 * rule that matches (someone deleted the last row) answers on this Mac, the
 * side that never sends anything out.
 */
export function decideHybrid(f: TurnFacts, rules: readonly HybridRule[] = HYBRID_RULES): HybridDecision {
  for (const r of rules) {
    if (r.when.every((c) => holds(c, f))) return { route: r.route, reason: r.id, fallThrough: r.fallThrough };
  }
  return { route: 'local', reason: 'default', fallThrough: false };
}

/** The table as README markdown, so the document can never drift from the data (a test compares them). */
export function rulesMarkdown(rules: readonly HybridRule[] = HYBRID_RULES): string {
  const says = (c: Cond): string => {
    if (c.fact === 'tier') return `the tier is ${c.in.join(' or ')}`;
    const words: Record<Exclude<Cond['fact'], 'tier'>, [yes: string, no: string]> = {
      private: ['the message is private', 'the message is not private'],
      deep: ['a deep answer was asked for', 'no deep answer was asked for'],
      toolsLikely: ['the message needs a tool', 'the message needs no tool'],
      mediaLocalCannotRead: ['it carries a file the local model cannot read', 'it carries no file the local model cannot read'],
      localAvailable: ['the local model is available', 'the local model is not available'],
      cloudAvailable: ['a cloud model is configured', 'no cloud model is configured'],
      localTools: ['the local model can call tools', 'the local model cannot call tools'],
      longContext: ['the conversation is long for the local window', 'the conversation fits the local window'],
    };
    return words[c.fact][c.is ? 0 : 1];
  };
  const lines = ['| # | Rule | When | Goes to | If that side cannot answer | Why |', '| --- | --- | --- | --- | --- | --- |'];
  rules.forEach((r, i) => {
    const when = r.when.length === 0 ? 'always' : r.when.map(says).join(', and ');
    const other = r.route === 'local' ? 'the cloud' : 'this Mac';
    lines.push(`| ${i + 1} | \`${r.id}\` | ${when} | ${r.route === 'local' ? 'this Mac' : 'the cloud'} | ${r.fallThrough ? `${other} answers` : 'it is not answered'} | ${r.note} |`);
  });
  return lines.join('\n');
}
