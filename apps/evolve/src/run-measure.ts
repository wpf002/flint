import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { costOf } from '@flint/core';
import {
  CSV_HEADER,
  fixedSubset,
  judgeReplyText,
  judgeWithFallback,
  readVerdict,
  toCsv,
  toRow,
  todayIsA,
  type Answer,
  type DailyRow,
  type JudgeResponse,
  type Prompt,
  type Verdict,
} from './measure.js';

/** The I/O half of stage 2. Kept apart from measure.ts so the logic stays testable. */

export interface MeasureOpts {
  flintUrl: string;
  flintToken: string;
  anthropicKey: string;
  judgeModel: string;
  /** Sent as `output_config.effort`; empty sends none, for a judge model without effort. */
  judgeEffort: string;
  /** Asked only when `judgeModel` refuses; empty means no fallback. */
  judgeFallbackModel: string;
  promptsPath: string;
  baselinePath: string;
  csvPath: string;
  n: number;
  /** Hard ceiling. The run stops and records what it has rather than exceeding it. */
  budgetUsd: number;
  config: string;
  now: string;
}

/**
 * Room for the judge's thinking as well as its one-word verdict. Opus 5.5
 * always thinks and the thinking counts toward max_tokens; at 8 the thinking
 * used all of it and no verdict was ever written. 4096 is the parity judge's.
 */
const JUDGE_MAX_TOKENS = 4096;

const JUDGE_SYSTEM =
  'You are a strict evaluator. Compare two answers to the same question and decide which is better overall — more accurate, clear, well-structured and genuinely useful. Ignore length unless it hurts quality. Reply with EXACTLY one token: A, B, or TIE.';

export function readPrompts(path: string): Prompt[] {
  const out: Prompt[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as Prompt;
      if (r.id && r.prompt) out.push(r);
    } catch {
      /* a malformed line is skipped, not fatal */
    }
  }
  return out;
}

/**
 * The prompts the frozen baseline measures, in its order, or undefined when no
 * baseline exists yet. Exactly what `measure` asks; evolve try reads it to see
 * which tiers a measurement can reach before it spends anything.
 */
export function measuredPrompts(promptsPath: string, baselinePath: string): Prompt[] | undefined {
  if (!existsSync(baselinePath)) return undefined;
  const stored = JSON.parse(readFileSync(baselinePath, 'utf8')) as { answers: Record<string, string> };
  // Measure exactly what the baseline froze. Re-deriving the subset from the
  // pool would silently drop a measured prompt the moment a new one sorting
  // earlier was added, changing the denominator without changing the config.
  const byId = new Map(readPrompts(promptsPath).map((p) => [p.id, p]));
  return Object.keys(stored.answers)
    .map((id) => byId.get(id))
    .filter((p): p is Prompt => p !== undefined);
}

/** Ask Flint, in eval mode so the turn never lands in the training corpus. */
async function askFlint(o: MeasureOpts, p: Prompt): Promise<Answer> {
  const res = await fetch(`${o.flintUrl}/generate`, {
    method: 'POST',
    headers: { authorization: `Bearer ${o.flintToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: p.prompt, eval: true }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) throw new Error(`flint HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const d = (await res.json()) as { text?: string; usage?: { input: number; output: number }; model?: string };
  const text = (d.text ?? '').trim();
  if (!text) throw new Error('flint returned an empty answer');
  // Flint's own spend is reported by the server; this is the eval's view of it.
  const cost = d.usage && d.model ? costOf('anthropic', d.model.replace(/^anthropic:/, ''), d.usage) : 0;
  return { promptId: p.id, text, costUsd: cost, ...(d.model ? { model: d.model } : {}) };
}

async function judge(o: MeasureOpts, model: string, question: string, a: string, b: string): Promise<{ reply: string; costUsd: number }> {
  const body = {
    model,
    max_tokens: JUDGE_MAX_TOKENS,
    ...(o.judgeEffort ? { output_config: { effort: o.judgeEffort } } : {}),
    system: JUDGE_SYSTEM,
    messages: [{ role: 'user', content: `Question:\n${question}\n\nAnswer A:\n${a}\n\nAnswer B:\n${b}\n\nWhich is better? Reply A, B, or TIE.` }],
  };
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': o.anthropicKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`judge HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const d = (await res.json()) as JudgeResponse & { usage?: { input_tokens: number; output_tokens: number } };
  const usage = { input: d.usage?.input_tokens ?? 0, output: d.usage?.output_tokens ?? 0 };
  const cost = costOf('anthropic', model, usage);
  try {
    return { reply: judgeReplyText(d), costUsd: cost };
  } catch (err) {
    // The judge was paid for even when it gave no verdict.
    throw Object.assign(err instanceof Error ? err : new Error(String(err)), { costUsd: cost });
  }
}

export interface MeasureResult {
  kind: 'baseline-created' | 'measured';
  row?: DailyRow;
  n: number;
  costUsd: number;
  stoppedEarly?: string;
  /** Prompts that produced no verdict, each with why. They are in no column of the row. */
  unscored?: string[];
  /** Prompts the fallback judged because the primary judge refused, with the judge used. */
  fallbackJudged?: string[];
  /** Which brain answered today's prompts, `provider:model` -> count. */
  answeredBy?: Record<string, number>;
}

export async function measure(o: MeasureOpts): Promise<MeasureResult> {
  const pool = readPrompts(o.promptsPath);
  if (pool.length === 0) throw new Error(`no prompts in ${o.promptsPath}`);
  let spent = 0;
  const over = (): boolean => spent >= o.budgetUsd;

  // ---- night 1: establish the frozen baseline, judge nothing.
  if (!existsSync(o.baselinePath)) {
    const prompts = fixedSubset(pool, o.n);
    const baseline: Record<string, string> = {};
    for (const p of prompts) {
      if (over()) break;
      try {
        const a = await askFlint(o, p);
        baseline[p.id] = a.text;
        spent += a.costUsd;
      } catch {
        /* a prompt Flint fails is simply not in the baseline */
      }
    }
    mkdirSync(o.baselinePath.replace(/\/[^/]+$/, ''), { recursive: true });
    writeFileSync(o.baselinePath, JSON.stringify({ createdAt: o.now, config: o.config, answers: baseline }), 'utf8');
    return { kind: 'baseline-created', n: Object.keys(baseline).length, costUsd: spent };
  }

  // ---- every later night: answer again, judge today against the baseline.
  const stored = JSON.parse(readFileSync(o.baselinePath, 'utf8')) as { answers: Record<string, string> };
  const prompts = measuredPrompts(o.promptsPath, o.baselinePath) ?? [];
  const answeredBy: Record<string, number> = {};
  const verdicts: Verdict[] = [];
  const unscored: string[] = [];
  const fallbackJudged: string[] = [];
  let stoppedEarly: string | undefined;

  for (const p of prompts) {
    const base = stored.answers[p.id];
    if (!base) continue; // not in the baseline, so not comparable
    if (over()) {
      stoppedEarly = `budget of $${o.budgetUsd.toFixed(2)} reached`;
      break;
    }
    try {
      const today = await askFlint(o, p);
      spent += today.costUsd;
      const by = today.model ?? 'unknown';
      answeredBy[by] = (answeredBy[by] ?? 0) + 1;
      if (over()) {
        stoppedEarly = `budget of $${o.budgetUsd.toFixed(2)} reached`;
        break;
      }
      const isA = todayIsA(p.id);
      const r = await judgeWithFallback(
        (model) => judge(o, model, p.prompt, isA ? today.text : base, isA ? base : today.text),
        o.judgeModel,
        o.judgeFallbackModel,
      );
      spent += r.costUsd;
      if (r.judge !== o.judgeModel) fallbackJudged.push(`${p.id}: ${r.judge}`);
      verdicts.push(readVerdict(r.reply, isA));
    } catch (err) {
      // A failed prompt is left out of the tally rather than counted as a loss,
      // and named, so a run that scored nothing cannot pass for a quiet night.
      spent += (err as { costUsd?: number }).costUsd ?? 0;
      unscored.push(`${p.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const row = toRow({ ts: o.now, config: o.config, verdicts, costUsd: spent });
  if (!existsSync(o.csvPath)) {
    mkdirSync(o.csvPath.replace(/\/[^/]+$/, ''), { recursive: true });
    writeFileSync(o.csvPath, `${CSV_HEADER}\n`, 'utf8');
  }
  appendFileSync(o.csvPath, `${toCsv(row)}\n`, 'utf8');
  return {
    kind: 'measured',
    row,
    n: verdicts.length,
    costUsd: spent,
    ...(stoppedEarly ? { stoppedEarly } : {}),
    ...(unscored.length ? { unscored } : {}),
    ...(fallbackJudged.length ? { fallbackJudged } : {}),
    answeredBy,
  };
}
