import { JUDGE_RUBRIC } from './constitution.js';

/**
 * The preference judge — the constitution applied as a consistent rubric to two
 * candidate responses, to LABEL training pairs (chosen vs. rejected). It is not
 * a persona and not the assistant; it ranks.
 *
 * Provider-agnostic via the `JudgeModel` function, so you can judge with a strong
 * model (best labels — recommended) or Flint's local model (self-contained).
 */

export interface JudgeVerdict {
  winner: 'A' | 'B' | 'tie';
  /** The principle or conflict-order level that decided it. */
  deciding_principle: string;
  /** One or two content-based sentences. */
  reason: string;
  hard_constraint_violation: { A: boolean; B: boolean };
  confidence: 'high' | 'medium' | 'low';
}

export interface JudgeInput {
  prompt: string;
  a: string;
  b: string;
}

/** A model the judge calls: returns the model's text for a (system, user) pair. */
export type JudgeModel = (system: string, user: string) => Promise<string>;

const OUTPUT_SPEC = `Output a SINGLE JSON object and nothing else — no preamble, no prose outside it:
{
  "winner": "A" | "B" | "tie",
  "deciding_principle": "<the principle name or conflict-order level that decided it, e.g. 'Honesty H3' or 'Hard constraint: fabrication'>",
  "reason": "<one or two sentences, grounded in the content of the responses>",
  "hard_constraint_violation": { "A": false, "B": false },
  "confidence": "high" | "medium" | "low"
}`;

export function buildJudgePrompt(input: JudgeInput): { system: string; user: string } {
  const system = `${JUDGE_RUBRIC}\n\n${OUTPUT_SPEC}`;
  const user = `# Prompt\n${input.prompt}\n\n# Response A\n${input.a}\n\n# Response B\n${input.b}`;
  return { system, user };
}

/** Judge a single ordering (A vs B). */
export async function judgePair(model: JudgeModel, input: JudgeInput): Promise<JudgeVerdict> {
  const { system, user } = buildJudgePrompt(input);
  return parseVerdict(await model(system, user));
}

/**
 * Debiased judgement: run both orderings and require agreement. Position bias is
 * real — a model can favor whichever response is shown first. We judge (a,b) and
 * (b,a); if they agree on the same actual response, that's the winner with the
 * higher of the two confidences; if they disagree, it's a 'tie' (don't train on
 * an unstable label). Hard-constraint flags are OR-ed across both runs.
 */
export async function judgePairDebiased(model: JudgeModel, input: JudgeInput): Promise<JudgeVerdict> {
  const forward = await judgePair(model, input);
  const reverse = await judgePair(model, { prompt: input.prompt, a: input.b, b: input.a });

  // Map each verdict to the actual response it picked: 'a' | 'b' | 'tie'.
  const pickForward = forward.winner === 'A' ? 'a' : forward.winner === 'B' ? 'b' : 'tie';
  const pickReverse = reverse.winner === 'A' ? 'b' : reverse.winner === 'B' ? 'a' : 'tie';

  const hard = {
    A: forward.hard_constraint_violation.A || reverse.hard_constraint_violation.B,
    B: forward.hard_constraint_violation.B || reverse.hard_constraint_violation.A,
  };

  if (pickForward === 'tie' || pickReverse === 'tie' || pickForward !== pickReverse) {
    return {
      winner: 'tie',
      deciding_principle: forward.deciding_principle,
      reason:
        pickForward !== pickReverse
          ? `Order-dependent (forward picked ${pickForward}, reverse picked ${pickReverse}) — unstable, treated as tie.`
          : forward.reason,
      hard_constraint_violation: hard,
      confidence: 'low',
    };
  }

  const ranks = { low: 0, medium: 1, high: 2 } as const;
  const confidence = ranks[forward.confidence] >= ranks[reverse.confidence] ? forward.confidence : reverse.confidence;
  return {
    winner: pickForward === 'a' ? 'A' : 'B',
    deciding_principle: forward.deciding_principle,
    reason: forward.reason,
    hard_constraint_violation: hard,
    confidence,
  };
}

/** Tolerant JSON extraction — handles code fences, leading/trailing prose. */
function parseVerdict(raw: string): JudgeVerdict {
  const fallback: JudgeVerdict = {
    winner: 'tie',
    deciding_principle: 'unparseable',
    reason: 'Judge output could not be parsed.',
    hard_constraint_violation: { A: false, B: false },
    confidence: 'low',
  };
  if (!raw) return fallback;
  let depth = 0;
  let start = -1;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        try {
          const o = JSON.parse(raw.slice(start, i + 1)) as Partial<JudgeVerdict>;
          const winner = o.winner === 'A' || o.winner === 'B' ? o.winner : 'tie';
          return {
            winner,
            deciding_principle: typeof o.deciding_principle === 'string' ? o.deciding_principle : 'unspecified',
            reason: typeof o.reason === 'string' ? o.reason : '',
            hard_constraint_violation: {
              A: Boolean(o.hard_constraint_violation?.A),
              B: Boolean(o.hard_constraint_violation?.B),
            },
            confidence:
              o.confidence === 'high' || o.confidence === 'medium' || o.confidence === 'low'
                ? o.confidence
                : 'medium',
          };
        } catch {
          start = -1;
        }
      }
    }
  }
  return fallback;
}
