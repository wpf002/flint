import { z } from 'zod';

/**
 * Turning a Nexus thread into one model call, and the model's reply back into a turn.
 *
 * The loop drives Nexus itself rather than handing the model a tool belt. One call per
 * turn, no tool round-trips, and it works with providers that have no function calling
 * at all — which is what lets a search-first model take a turn alongside the others.
 */

/* Nexus's own limits. Exceeding either is rejected at the append, so the fallback has
 * to respect them as strictly as the schema does. */
const MAX_CONTENT = 8_000;
const MAX_SUMMARY = 300;

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
    content: z.string().min(1).max(MAX_CONTENT),
    summary: z.string().min(1).max(MAX_SUMMARY),
    next: z.string().min(1).nullish(),
    ask: z.string().max(1_000).nullish(),
    done: z.boolean().default(false),
    remember: z.array(z.string().min(1).max(1_000)).max(5).default([]),
    /*
     * What the thread concluded, offered to shared memory. Only ever read when `done`
     * is set: a conclusion proposed mid-thread is a guess about where it is heading.
     */
    /* Offers this turn is willing to take into its own memory. Ids come from the
     * offers shown in the prompt; anything left out simply stays pending and lapses. */
    accept: z.array(z.string().min(1)).max(10).default([]),
    canon: z
      .object({
        key: z.string().min(1).max(200),
        content: z.string().min(1).max(20_000),
        rationale: z.string().max(2_000).optional(),
      })
      .nullish(),
  })
  .passthrough();

export type TurnReply = z.infer<typeof TurnReplySchema>;

/** Roughly four characters to a token, less the JSON wrapper. Budget only, not billing. */
function contentBudget(maxOutputTokens: number): number {
  return Math.max(200, Math.round((maxOutputTokens - 250) * 3.2));
}

/**
 * The reply shape as JSON Schema, for providers that can guarantee it.
 *
 * Prompting for JSON and repairing what comes back works, but it is the difference
 * between usually and always: one model answered with `content` as a nested object,
 * which was a good contribution the parser nearly threw away. Where the provider can
 * enforce the shape, enforcing it is strictly better than asking nicely.
 */
export const TURN_REPLY_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  // Strict mode requires every property to be listed as required, so anything genuinely
  // optional is expressed as nullable instead. Omitting `remember` and `canon` here
  // would silently make it impossible for a participant to store a fact or conclude a
  // thread — the schema would forbid the very fields the loop reads.
  required: ['content', 'summary', 'next', 'ask', 'done', 'remember', 'accept', 'canon'],
  properties: {
    content: { type: 'string', description: 'Your actual contribution.' },
    summary: { type: 'string', description: 'One line about your own turn, under 300 characters.' },
    next: { type: ['string', 'null'], description: 'Slug of the next speaker, or null.' },
    ask: { type: ['string', 'null'], description: 'What you need from them.' },
    done: { type: 'boolean', description: 'True when the goal is met and nobody needs to speak next.' },
    remember: {
      type: 'array',
      items: { type: 'string' },
      description: 'Durable facts worth keeping beyond this thread. Usually empty.',
    },
    accept: {
      type: 'array',
      items: { type: 'string' },
      description: 'Ids of offers you want to keep. Leave out anything you do not.',
    },
    canon: {
      type: ['object', 'null'],
      additionalProperties: false,
      required: ['key', 'content', 'rationale'],
      properties: {
        key: { type: 'string', description: 'A short dotted key, e.g. "pricing.floor".' },
        content: { type: 'string', description: 'What the thread concluded.' },
        rationale: { type: ['string', 'null'], description: 'Why.' },
      },
      description: 'Only when done is true, and only if the thread concluded something worth keeping.',
    },
  },
} as const;

/**
 * The same shape offered as a tool, for providers that guarantee a call's arguments
 * rather than a response format. Shares its schema with the response-format path, so the
 * two enforcement routes can never drift into demanding different things.
 */
export const TAKE_TURN_TOOL = {
  name: 'take_turn',
  description: 'Record your turn in the thread. This is the only way to speak.',
  inputSchema: TURN_REPLY_JSON_SCHEMA,
  idempotent: false,
} as const;

export function systemPrompt(slug: string, role: string | undefined, maxOutputTokens = 4_000): string {
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
    '',
    'When you set "done": true, also fill in "canon" with what the thread concluded — a short dotted key',
    'like "pricing.floor", the conclusion itself, and why. It is proposed to shared memory for a person to',
    'approve or reject; nothing you write there takes effect on its own. Leave it out if the thread ended',
    'without concluding anything worth keeping.',
    '',
    `Keep "content" under about ${contentBudget(maxOutputTokens)} characters. A reply that runs past the limit is cut off mid-JSON and cannot be recorded at all, so a shorter complete turn always beats a longer truncated one.`,
  ]
    .filter((line) => line !== null)
    .join('\n');
}

export interface Offer {
  id: string;
  subject: string;
  content: string;
  from: { slug: string };
}

export function threadPrompt(state: ThreadState, self: string, offers: Offer[] = []): string {
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
    ...(offers.length > 0
      ? [
          '',
          'OFFERED TO YOU (facts another participant thought you would need — list the id in "accept" to keep one):',
          ...offers.map((o) => `- ${o.id} from ${o.from.slug}: ${o.subject}\n  ${o.content}`),
        ]
      : []),
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
    const parsed = TurnReplySchema.safeParse(normalize(candidate));
    if (parsed.success) return { reply: parsed.data, malformed: false };
  }

  /*
   * Built by hand rather than parsed, so nothing enforces the limits here. An
   * over-long reply used to be handed to Nexus intact and rejected at the append,
   * which lost the turn entirely — worse than recording a clipped one.
   */
  const text = raw.trim();
  const firstLine = text.split('\n').find((l) => l.trim().length > 0) ?? 'Unstructured reply.';
  return {
    reply: {
      content: text.length > 0 ? clip(text, MAX_CONTENT) : '(the model returned nothing)',
      summary: clip(firstLine, MAX_SUMMARY),
      next: null,
      ask: null,
      done: false,
      remember: [],
      accept: [],
    },
    malformed: true,
  };
}

/**
 * Coerces the shapes models reach for when the answer is structured.
 *
 * A model asked for `{"content": "..."}` will sometimes answer with `content` as a
 * nested object — the contribution is there and is good, it is just not a string.
 * Rejecting it lost the whole turn and recorded the raw text instead, which was
 * strictly worse than rendering the object. Only the wrapper is coerced; nothing about
 * the model's actual content is invented or discarded.
 */
function normalize(candidate: unknown): unknown {
  if (typeof candidate !== 'object' || candidate === null) return candidate;
  const obj = { ...(candidate as Record<string, unknown>) };

  if (obj.content !== undefined && typeof obj.content !== 'string') {
    obj.content = render(obj.content);
  }
  if (typeof obj.summary !== 'string' || obj.summary.trim().length === 0) {
    const body = typeof obj.content === 'string' ? obj.content : '';
    const firstLine = body.split('\n').find((l) => l.trim().length > 0) ?? 'Structured reply.';
    obj.summary = clip(firstLine.trim(), MAX_SUMMARY);
  } else {
    obj.summary = clip(obj.summary, MAX_SUMMARY);
  }
  if (typeof obj.content === 'string') obj.content = clip(obj.content, MAX_CONTENT);
  if (obj.next !== undefined && obj.next !== null && typeof obj.next !== 'string') obj.next = null;
  if (obj.accept !== undefined && !Array.isArray(obj.accept)) obj.accept = [];
  // A malformed proposal is dropped rather than sent: canon is the one place where a
  // half-understood write is worse than no write.
  if (obj.canon !== undefined && obj.canon !== null) {
    const c = obj.canon as Record<string, unknown>;
    obj.canon =
      typeof c.key === 'string' && c.key.trim().length > 0 && c.content !== undefined
        ? { key: c.key, content: render(c.content), ...(typeof c.rationale === 'string' ? { rationale: c.rationale } : {}) }
        : null;
  }
  if (obj.ask !== undefined && obj.ask !== null && typeof obj.ask !== 'string') obj.ask = render(obj.ask);

  return obj;
}

function render(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

/** Truncates to a limit, saying so, so a clipped turn never reads as a complete one. */
function clip(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const marker = '… [truncated]';
  return value.slice(0, limit - marker.length) + marker;
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
