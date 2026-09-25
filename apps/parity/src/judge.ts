import { decodeAssistantTurn, type ProviderAdapter, type TokenUsage } from '@flint/core';
import { groundingBlock, type FlintGrounding } from './grounding.js';
import type { EvalPrompt } from './prompts.js';
import { seededRng, seedFrom } from './util.js';

export type Verdict = 'A' | 'B' | 'TIE';
/** The verdict from Flint's side. */
export type Outcome = 'win' | 'loss' | 'tie';

/**
 * Which slot Flint's answer goes in for this (prompt, competitor) pair. Seeded
 * by the pair rather than drawn in run order, so a resumed or re-judged run puts
 * every answer in the same slot it had before, and the whole set is ~50/50.
 */
export function flintIsA(promptId: string, competitor: string, seed: number): boolean {
  return seededRng(seedFrom(`${seed}:${promptId}:${competitor}`))() < 0.5;
}

export const JUDGE_SYSTEM = `You are a strict, impartial evaluator comparing two AI assistants' answers to the same request from Will, the person they both work for.

Will is a software builder and investor in Dallas, Texas. He has personal systems an assistant with access can query: Vantage (company scores/watchlists), Bellwether (market signals/digests), Meridian (trading signals), Prophet (forecasts), plus his Gmail, Google Calendar and Google Drive. Some assistants have tools (web search, those systems); some don't.

Judge on, in order of weight:
1. Correctness — facts, numbers, reasoning, code. A confident wrong answer is worse than an honest "I can't see that".
2. Usefulness to Will — does it actually get his task done, directly, at the right depth? Padding, hedging, and generic advice count against it.
3. Groundedness and currency — for anything time-sensitive or about his own data, does it rest on real, current information rather than stale memory or invention? Fabricated specifics (made-up scores, emails, prices, events) are a severe failure.
4. Tool-use outcome — if the task needed a lookup or an action, did the answer actually deliver its result, versus telling Will to go check himself or stalling?

Ignore: which assistant it is or claims to be, answer order, length for its own sake, and formatting unless it hurts clarity. Answer A and Answer B are in random order.
If they are genuinely equivalent in quality, or both fail equally, call it a TIE.

Reply with ONLY a JSON object, no prose before or after, no code fence:
{"verdict": "A" | "B" | "TIE", "reason": "<one or two sentences>"}`;

/**
 * The judge's user message. With `grounding` (`--judge-grounding` only), the
 * context Flint had goes between the request and the answers; without it the
 * message is exactly what it has always been.
 */
export function judgeUserMessage(p: EvalPrompt, answerA: string, answerB: string, now: Date, grounding?: FlintGrounding): string {
  return [
    `Date of this evaluation: ${now.toISOString().slice(0, 10)}. Request category: ${p.category}.`,
    '',
    `<request>\n${p.prompt}\n</request>`,
    '',
    ...(grounding ? [groundingBlock(grounding), ''] : []),
    `<answer_a>\n${answerA}\n</answer_a>`,
    '',
    `<answer_b>\n${answerB}\n</answer_b>`,
    '',
    'Which answer serves Will better? Reply with the JSON object only.',
  ].join('\n');
}

export class JudgeParseError extends Error {}

/**
 * Strict parse. The reply must be exactly one JSON object (an optional ```json
 * fence is tolerated, nothing else) with `verdict` exactly "A", "B" or "TIE".
 * Anything looser — "A is better", a verdict of "a", two objects, trailing prose —
 * is rejected rather than guessed at: a mis-parsed verdict silently flips a
 * result, a rejected one just gets retried.
 */
export function parseJudgeOutput(raw: string): { verdict: Verdict; reason: string } {
  let s = raw.trim();
  const fence = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/.exec(s);
  if (fence) s = (fence[1] ?? '').trim();
  if (!s.startsWith('{') || !s.endsWith('}')) throw new JudgeParseError(`not a bare JSON object: ${preview(raw)}`);
  let obj: unknown;
  try {
    obj = JSON.parse(s);
  } catch {
    throw new JudgeParseError(`invalid JSON: ${preview(raw)}`);
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new JudgeParseError('not an object');
  const v = (obj as Record<string, unknown>).verdict;
  if (v !== 'A' && v !== 'B' && v !== 'TIE') throw new JudgeParseError(`bad verdict: ${JSON.stringify(v)}`);
  const reason = (obj as Record<string, unknown>).reason;
  return { verdict: v, reason: typeof reason === 'string' ? reason : '' };
}

function preview(s: string): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > 120 ? `${one.slice(0, 120)}…` : one;
}

export function outcomeFor(verdict: Verdict, flintWasA: boolean): Outcome {
  if (verdict === 'TIE') return 'tie';
  return (verdict === 'A') === flintWasA ? 'win' : 'loss';
}

export interface JudgeCall {
  verdict: Verdict;
  reason: string;
  usage: TokenUsage;
  attempts: number;
  raw: string;
}

/** One judgment, with one retry on an unparseable reply. */
export async function judgePair(opts: {
  provider: ProviderAdapter;
  model: string;
  maxTokens: number;
  prompt: EvalPrompt;
  answerA: string;
  answerB: string;
  now: Date;
  signal: AbortSignal;
  /** `--judge-grounding`: what Flint was grounded on, shown to the judge. */
  grounding?: FlintGrounding | undefined;
}): Promise<JudgeCall> {
  const usage: TokenUsage = { input: 0, output: 0 };
  let lastErr: unknown;
  let raw = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await opts.provider.generate({
      model: opts.model,
      system: JUDGE_SYSTEM,
      messages: [
        {
          id: `judge-${opts.prompt.id}-${attempt}`,
          role: 'user',
          content: judgeUserMessage(opts.prompt, opts.answerA, opts.answerB, opts.now, opts.grounding),
          timestamp: Date.now(),
        },
      ],
      maxTokens: opts.maxTokens,
      signal: opts.signal,
    });
    usage.input += res.usage.input;
    usage.output += res.usage.output;
    raw = decodeAssistantTurn(res.message).text;
    try {
      const parsed = parseJudgeOutput(raw);
      return { ...parsed, usage, attempts: attempt, raw };
    } catch (err) {
      lastErr = err;
    }
  }
  const e = lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  (e as Error & { usage?: TokenUsage }).usage = usage;
  throw e;
}
