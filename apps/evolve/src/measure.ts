/**
 * Stage 2 of the nightly loop: put a number on "is Flint better than he was".
 *
 * The design question was what to measure against. Measuring against yesterday
 * compounds drift — a slow slide looks flat because each night only compares to
 * the night before. So this compares against a FROZEN BASELINE: the first
 * night's answers are stored once and every later night is judged against those
 * same answers, on the same prompts. The score is then an absolute line you can
 * read across weeks, not a series of unrelated numbers.
 *
 * Night 1 costs only Flint's own answers (no judging: there is nothing to
 * compare to yet). Every night after costs Flint's answers plus one judgment
 * per prompt.
 */

export interface Prompt {
  id: string;
  prompt: string;
  category?: string;
}

export interface Answer {
  promptId: string;
  text: string;
  costUsd: number;
}

export type Verdict = 'today' | 'baseline' | 'tie';

export interface DailyRow {
  ts: string;
  /** What Flint was configured as, so a score always has its config beside it. */
  config: string;
  n: number;
  wins: number;
  losses: number;
  ties: number;
  /** Wins / (wins + losses), ties excluded. 0.5 means no change since baseline. */
  winRate: number;
  signal: 'BETTER' | 'WORSE' | 'NOISE';
  costUsd: number;
}

/**
 * The subset measured on NIGHT ONE only. Sorting by id and taking the first N is
 * deterministic for a fixed pool, but it is NOT stable against additions: a new
 * prompt whose id sorts earlier displaces one. That is why the baseline records
 * the ids it froze, and every later night measures exactly those — see measure()
 * in run-measure.ts. Do not use this to pick the set on a later night.
 */
export function fixedSubset(prompts: Prompt[], n: number): Prompt[] {
  return [...prompts].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).slice(0, n);
}

/**
 * Which side today's answer is shown as. Derived from the prompt id so it is
 * stable across nights (the same prompt always sits in the same position), but
 * varied across prompts so a judge that favours position A cannot sway the run.
 */
export function todayIsA(promptId: string): boolean {
  let h = 0;
  for (const ch of promptId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 2 === 0;
}

/**
 * Is a win/loss split distinguishable from a coin flip? Same two-sigma rule the
 * parity harness uses, so the two report the same way. Ties are excluded: they
 * carry no directional information.
 */
export function signalOf(wins: number, losses: number): DailyRow['signal'] {
  const decisive = wins + losses;
  if (decisive < 4) return 'NOISE';
  const sd = Math.sqrt(decisive) / 2;
  const edge = Math.abs(wins - decisive / 2);
  if (edge < 2 * sd) return 'NOISE';
  return wins > losses ? 'BETTER' : 'WORSE';
}

export function toRow(opts: {
  ts: string;
  config: string;
  verdicts: Verdict[];
  costUsd: number;
}): DailyRow {
  const wins = opts.verdicts.filter((v) => v === 'today').length;
  const losses = opts.verdicts.filter((v) => v === 'baseline').length;
  const ties = opts.verdicts.filter((v) => v === 'tie').length;
  const decisive = wins + losses;
  return {
    ts: opts.ts,
    config: opts.config,
    n: opts.verdicts.length,
    wins,
    losses,
    ties,
    winRate: decisive === 0 ? 0.5 : wins / decisive,
    signal: signalOf(wins, losses),
    costUsd: opts.costUsd,
  };
}

export const CSV_HEADER = 'ts,config,n,wins,losses,ties,win_rate,signal,cost_usd';

export function toCsv(r: DailyRow): string {
  // The config can contain commas (several tiers), so it is quoted.
  return [
    r.ts,
    `"${r.config.replace(/"/g, '""')}"`,
    r.n,
    r.wins,
    r.losses,
    r.ties,
    r.winRate.toFixed(3),
    r.signal,
    r.costUsd.toFixed(4),
  ].join(',');
}

/** The judge declined to rule. Distinct from a failure: another judge may rule. */
export class JudgeRefused extends Error {
  constructor() {
    super('the judge refused');
    this.name = 'JudgeRefused';
  }
}

export interface Judgment {
  reply: string;
  costUsd: number;
  /** The model that gave the verdict. */
  judge: string;
}

/**
 * Judge with `primary`, and ask `fallback` only when `primary` refuses.
 *
 * Opus 5.5's safety classifiers refuse some ordinary questions: it refused an
 * aging-biology prompt (telomeres, p53, PGC-1α) on 2026-09-29, and it will
 * refuse the same prompt every night, so that prompt was lost for good. A
 * fallback that only ever sees the primary's refusals judges the same prompts
 * each night, which keeps nights comparable. Any other failure is not retried,
 * and money spent on a refused call still counts (`costUsd` on the error).
 */
export async function judgeWithFallback(
  call: (model: string) => Promise<{ reply: string; costUsd: number }>,
  primary: string,
  fallback: string,
): Promise<Judgment> {
  try {
    const r = await call(primary);
    return { ...r, judge: primary };
  } catch (err) {
    if (!(err instanceof JudgeRefused) || !fallback || fallback === primary) throw err;
    const spent = (err as { costUsd?: number }).costUsd ?? 0;
    try {
      const r = await call(fallback);
      return { reply: r.reply, costUsd: spent + r.costUsd, judge: fallback };
    } catch (err2) {
      // A new error, never the caught one edited: a fetch timeout rejects with a
      // DOMException whose `message` cannot be set, and setting it threw a
      // TypeError that lost the refused call's cost and the real reason.
      const why = err2 instanceof Error ? err2.message : String(err2);
      throw Object.assign(new Error(`${primary} refused, then ${fallback}: ${why}`, { cause: err2 }), {
        costUsd: spent + ((err2 as { costUsd?: number }).costUsd ?? 0),
      });
    }
  }
}

/** The parts of a Messages API response the judge reads. */
export interface JudgeResponse {
  content?: Array<{ type?: string; text?: string }>;
  stop_reason?: string | null;
}

/**
 * The judge's reply text, or a throw when there is no verdict to read.
 *
 * Opus 5.5 always thinks, and its thinking comes back as blocks AHEAD of the
 * text, so the verdict is not the first block. Reading `content[0]` read the
 * thinking, found no text, and scored every pair a tie: all 16 pairs judged on
 * 2026-09-28 came back ties. A reply with no text (cut off, refused) throws so
 * the pair is left out and reported, never quietly counted as a tie.
 */
export function judgeReplyText(res: JudgeResponse): string {
  if (res.stop_reason === 'refusal') throw new JudgeRefused();
  const text = (res.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('')
    .trim();
  if (!text) throw new Error(`the judge gave no verdict (stop_reason ${res.stop_reason ?? 'unknown'})`);
  return text;
}

/**
 * Parse the judge's one-word reply into a verdict, given which side was today.
 *
 * Only a BARE verdict token counts. Matching anything merely starting with the
 * letter scored "Both are good" as a win for B, inventing a result out of a
 * judge that had declined to pick one. Anything unrecognised is a tie, which
 * costs the run a data point instead of a wrong one.
 */
export function readVerdict(reply: string, todayWasA: boolean): Verdict {
  const first = reply.trim().toUpperCase().split(/[\s,.:;!]+/)[0] ?? '';
  if (first === 'A') return todayWasA ? 'today' : 'baseline';
  if (first === 'B') return todayWasA ? 'baseline' : 'today';
  return 'tie';
}
