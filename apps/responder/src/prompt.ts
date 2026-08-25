import { z } from 'zod';

/**
 * Turning a Nexus thread into one model call, and the model's reply back into a turn.
 *
 * The loop drives Nexus itself rather than handing the model a tool belt. One call per
 * turn, no tool round-trips, and it works with providers that have no function calling
 * at all — which is what lets a search-first model take a turn alongside the others.
 */

/** The shape `thread_read` returns. Only the parts a turn actually needs. */
export const ThreadStateSchema = z
  .object({
    threadId: z.string(),
    goal: z.string(),
    status: z.string(),
    turnCount: z.number(),
    yourTurnIf: z.string().nullable().optional(),
    ask: z.string().nullable().optional(),
    participants: z
      .array(z.object({ slug: z.string(), label: z.string(), good_at: z.string() }))
      .default([]),
    turns: z
      .array(
        z.object({
          seq: z.number(),
          by: z.string(),
          content: z.string().optional(),
          summary: z.string().optional(),
          asked: z.string().optional(),
        }),
      )
      .default([]),
  })
  .passthrough();

export type ThreadState = z.infer<typeof ThreadStateSchema>;

/** What a participant is expected to produce. Kept small so the JSON is easy to hit. */
export const TurnReplySchema = z
  .object({
    content: z.string().min(1).max(8_000),
    summary: z.string().min(1).max(300),
    next: z.string().min(1).nullish(),
    ask: z.string().max(1_000).nullish(),
    done: z.boolean().default(false),
    remember: z.array(z.string().min(1).max(1_000)).max(5).default([]),
  })
  .passthrough();

export type TurnReply = z.infer<typeof TurnReplySchema>;

export function systemPrompt(slug: string, role: string | undefined): string {
  return [
    `You are "${slug}", one of several AI participants working in a shared space called Nexus.`,
    role ? `Your declared strength: ${role}` : null,
    '',
    'You are taking a turn in a thread the group is building together. How this works:',
    '- Turns are append-only and attributed. You cannot alter anyone else\'s turn, and nobody can alter yours.',
    '- Do the actual work in your turn. Do not summarise the thread back, restate the goal, or praise the previous turn.',
    '- Answer the specific thing you were asked. If you disagree with an earlier turn, say so and say why.',
    '- Then hand off: name who should speak next and what you need from them, specifically.',
    '- Choose the next speaker by what the work needs and by what each participant is good at. Not by rotation.',
    '- Never nominate yourself. If nobody obvious fits, leave "next" null and Nexus will route on your ask.',
    '- If the goal is genuinely met, set "done": true and leave "next" null.',
    '',
    'Reply with a single JSON object and nothing else. No prose before or after, no code fences.',
    '{',
    '  "content": "your actual contribution",',
    '  "summary": "one line describing your own turn, under 300 characters",',
    '  "next": "slug of the next speaker, or null",',
    '  "ask": "what you need from them",',
    '  "done": false,',
    '  "remember": ["a durable fact worth keeping beyond this thread"]',
    '}',
    '',
    '"remember" is optional and usually empty. Use it only for a fact that outlives this thread.',
  ]
    .filter((line) => line !== null)
    .join('\n');
}

export function threadPrompt(state: ThreadState, self: string): string {
  const others = state.participants.filter((p) => p.slug !== self);

  const roster =
    others.length > 0
      ? others.map((p) => `- ${p.slug} (${p.label}): ${p.good_at}`).join('\n')
      : '- nobody else is active right now';

  const history =
    state.turns.length > 0
      ? state.turns
          .map((t) => {
            const body = t.content ?? t.summary ?? '';
            const asked = t.asked ? `\n  (asked next speaker: ${t.asked})` : '';
            return `[${t.seq}] ${t.by}: ${body}${asked}`;
          })
          .join('\n\n')
      : '(no turns yet — you are opening the work)';

  return [
    `GOAL: ${state.goal}`,
    '',
    'WHO ELSE IS HERE:',
    roster,
    '',
    `THREAD SO FAR (${state.turnCount} turn${state.turnCount === 1 ? '' : 's'}; older turns appear as their author's own summary):`,
    history,
    '',
    state.ask ? `ASKED OF YOU: ${state.ask}` : 'Nothing specific was asked of you. Advance the goal.',
    '',
    'Take your turn. JSON only.',
  ].join('\n');
}

/**
 * Pulls the reply object out of whatever the model actually emitted.
 *
 * Models wrap JSON in fences or add a sentence of preamble often enough that failing
 * on it would stall threads for a formatting slip. Anything genuinely unparseable
 * falls back to the raw text as the turn's content, which keeps the thread honest —
 * the text is still recorded and attributed — but deliberately nominates nobody, so a
 * malformed reply stops the loop instead of letting it spend on guesses.
 */
export function parseReply(raw: string): { reply: TurnReply; malformed: boolean } {
  const candidate = extractJson(raw);
  if (candidate) {
    const parsed = TurnReplySchema.safeParse(candidate);
    if (parsed.success) return { reply: parsed.data, malformed: false };
  }

  const text = raw.trim();
  const firstLine = text.split('\n').find((l) => l.trim().length > 0) ?? 'Unstructured reply.';
  return {
    reply: {
      content: text.length > 0 ? text : '(the model returned nothing)',
      summary: firstLine.slice(0, 280),
      next: null,
      ask: null,
      done: false,
      remember: [],
    },
    malformed: true,
  };
}

function extractJson(raw: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const body = fenced?.[1] ?? raw;

  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end <= start) return undefined;

  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return undefined;
  }
}
