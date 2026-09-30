/**
 * Which frontier tier a message goes to: routine / standard / hard / code.
 *
 * A cheap regex classifier, used by the server to pick a brain per message
 * (apps/server/src/brains.ts maps each tier to a `provider:model`) and by
 * evolve to tell which tiers its measured questions can reach at all: a tier
 * no measured question is sent to cannot be measured, however long it runs.
 * It lives here, not in the server, so both use the same rules.
 */

export type Tier = 'routine' | 'standard' | 'hard' | 'code';
export const TIERS: readonly Tier[] = ['routine', 'standard', 'hard', 'code'];

export interface ClassifyContext {
  /**
   * Complete turns of history this message is sent with (the server's windowed
   * history, apps/server/src/history-window.ts; 0 for a fresh conversation or
   * /generate). Turns, not
   * messages: a tool call adds messages to a turn, not context worth more.
   */
  turns?: number;
  /** The tool router appended non-core tools — the question needs to DO things. */
  toolsLikely?: boolean;
}

/** Code: fences, stack traces, language/tool names, source-file paths, code verbs. */
const CODE_RE = new RegExp(
  [
    '```',
    '\\b(typescript|javascript|python|golang|rust(lang)?|swiftui|kotlin|java|c\\+\\+|sql|bash|zsh|shell script|regex|regexp|jq|yaml|dockerfile|terraform|react (component|hook)s?|node\\.?js|pnpm|npm|vitest|jest|pytest|git (rebase|merge|diff|log|bisect))\\b',
    '\\b(stack ?trace|traceback|segfault|null pointer|undefined is not|TypeError|SyntaxError|ReferenceError|uncaught exception|compile error|linter|type ?check)\\b',
    '\\b(refactor|debug|unit tests?|function signature|pull request|code review|write (a|the|me a) (script|function|class|query|test))\\b',
    '\\b[\\w./-]+\\.(ts|tsx|js|mjs|py|go|rs|swift|java|kt|sql|sh|yml|yaml|json|toml)\\b',
    '\\b(def|func|fn)\\s+\\w+\\s*\\(|\\bconst\\s+\\w+\\s*=|\\bSELECT\\s+.+\\s+FROM\\b|\\bCREATE TABLE\\b',
  ].join('|'),
  'i',
);

/** Hard reasoning: analysis, planning, trade-offs, proofs, multi-part asks. */
const HARD_RE = new RegExp(
  [
    '\\b(step[- ]by[- ]step|think (it )?through|reason (it )?through|in depth|deep dive|thorough(ly)?|rigorous(ly)?)\\b',
    '\\b(prove|proof|derive|derivation|theorem|optimi[sz]e|optimal|probability|expected value|statistical(ly)?)\\b',
    '\\b(analy[sz]e|analysis|evaluate|assess|critique|trade-?offs?|pros and cons|compare|comparison|versus|vs\\.?)\\b',
    '\\b(strategy|strategic|architecture|design (a|the|an)|roadmap|business plan|investment thesis|due diligence|negotiat\\w*)\\b',
    "\\b(what would happen if|how should i|should i .+ or)\\b",
  ].join('|'),
  'i',
);

/** Routine: greetings, thanks, acks, and one-line quick lookups. */
const ROUTINE_RE =
  /^\s*(hi|hey|hello|yo|sup|thanks|thank you|thx|ty|ok(ay)?|cool|nice|great|got it|good (morning|afternoon|evening|night)|gm|gn|what time is it|what'?s the (time|date|weather)|weather\b|remind me\b|how are you)\b/i;

const LONG_MESSAGE = 800; // chars — long asks are rarely routine and often hard
const SHORT_MESSAGE = 80; // chars — the ceiling for a routine one-liner
/**
 * Complete turns: a deep thread carries context worth the stronger brain. It was
 * 30 messages of the whole stored thread; the history window (12 turns / 48h by
 * default) never sends more than 24 messages for a tool-free thread, so the rule
 * is sized to what the window can hold: 8 of its 12 turns.
 */
export const LONG_CONVERSATION = 8;

/**
 * Sort a frontier-bound message into a tier. Deliberately cheap and
 * conservative: when unsure it says `standard`, which by default is exactly the
 * brain that answers today. Order matters — code beats hard (a hard coding
 * question wants the coding model), and anything long or deep in a thread is
 * never routine.
 */
export function classifyMessage(message: string, ctx: ClassifyContext = {}): Tier {
  const m = message.trim();
  if (CODE_RE.test(m)) return 'code';
  if (m.length >= LONG_MESSAGE || HARD_RE.test(m)) return 'hard';
  // Several separate questions in one message is multi-part reasoning.
  if ((m.match(/\?/g) ?? []).length >= 3) return 'hard';
  const deep = (ctx.turns ?? 0) >= LONG_CONVERSATION;
  if (!deep && !ctx.toolsLikely && m.length <= SHORT_MESSAGE && ROUTINE_RE.test(m)) return 'routine';
  return 'standard';
}
