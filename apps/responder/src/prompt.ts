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
          /** A note about what happened to the thread, not a contribution to it. */
          kind: z.literal('note').optional(),
          /** What that turn ran against the files, and what came back. */
          runs: z
            .array(z.object({ command: z.string(), ok: z.boolean(), output: z.string() }))
            .optional(),
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
    /*
     * Commands to run against what the thread has built. Each is an argv array rather
     * than a string, so nothing here ever reaches a shell.
     */
    run: z.array(z.array(z.string().min(1)).min(1).max(12)).max(4).default([]),
    /*
     * The thing the thread is for. Turns are a conversation; this is the work. Optional
     * because not every turn is a revision — a critique that changes nothing is still a
     * turn worth having.
     */
    artifact: z
      .object({
        name: z.string().min(1).max(120),
        content: z.string().min(1).max(100_000),
        note: z.string().max(300).nullish(),
      })
      .nullish(),
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
  required: ['content', 'summary', 'next', 'ask', 'done', 'remember', 'accept', 'run', 'artifact', 'canon'],
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
    run: {
      type: 'array',
      items: { type: 'array', items: { type: 'string' } },
      description:
        'Commands to run against what the thread built, each as an argv array — ["pnpm","install"], not "pnpm install". Empty unless you want to check that something works.',
    },
    artifact: {
      type: ['object', 'null'],
      additionalProperties: false,
      required: ['name', 'content', 'note'],
      properties: {
        name: { type: 'string', description: 'A filename: "pricing-model.md", "schema.sql".' },
        content: { type: 'string', description: 'The whole document as it should now stand, not a diff.' },
        note: { type: ['string', 'null'], description: 'One line on what you changed.' },
      },
      description: 'The thing the thread is building. Write or revise it here.',
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
    '- Closing is a real contribution. A thread that is finished and still going costs money and makes the',
    '  work worse: sixteen turns produced a README that four would have. If the artifact answers the goal,',
    '  say so and close it. Do not add a section because it is your turn.',
    '- Before you revise, ask whether the change is worth another round. Tightening someone else\'s wording',
    '  is not. A missing piece, a wrong claim, or a real disagreement is.',
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
    '"artifact" is what the thread is actually for. If the goal calls for something — a document, a spec,',
    'a plan, a schema — build it there rather than describing it in your turn. Send the whole thing as it',
    'should now stand, not a diff, and say in "note" what you changed. Revise what is already there instead',
    'of starting again; your turn is for the reasoning, the artifact is for the result. Leave it out when',
    'your turn genuinely changes nothing about it.',
    '',
    'You cannot see the system you are working on. If a turn needs facts about Nexus itself — what happened',
    'this week, what the tables actually are — say so in your turn and ask for them rather than describing',
    'them from memory. A plausible answer in the right shape is harder to catch than an obvious wrong one,',
    'and saying "I would need to look" is a better turn than a confident invention.',
    '',
    'If a run failed, fixing it is your turn. Do not describe the fix and hand it on — change the artifact',
    'and run it again. A thread that discusses an error it could have fixed has wasted a round.',
    '',
    'Length is a decision, not a side effect. A README that a person reads before anything else should be',
    'short enough that they do. Cutting an artifact in half is as valuable a turn as adding to it, and much',
    'rarer — if it has grown past what the goal needs, say so and cut it.',
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

export interface BuiltArtifact {
  name: string;
  content: string;
  version: number;
  lastBy: string | null;
}

/** What happened last time something was run against the thread's files. */
export interface RanBefore {
  command: string;
  ok: boolean;
  output: string;
}

/**
 * What the last turn ran, read from the thread rather than from this machine.
 *
 * It used to be held in a map here, which meant a restart lost it, a second runner never
 * saw it, and the console could not show it at all — the build output existed only
 * inside the process that happened to produce it. On the turn, it is part of the shared
 * record like everything else.
 */
export function lastRuns(state: ThreadState): RanBefore[] {
  for (let i = state.turns.length - 1; i >= 0; i -= 1) {
    const runs = state.turns[i]?.runs;
    if (runs && runs.length > 0) return runs;
  }
  return [];
}

export function threadPrompt(
  state: ThreadState,
  self: string,
  offers: Offer[] = [],
  built: BuiltArtifact[] = [],
  ran: RanBefore[] = lastRuns(state),
): string {
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
    ...(built.length > 0
      ? [
          '',
          'WHAT THE THREAD HAS BUILT SO FAR — revise this rather than starting again:',
          ...built.map((a) => `--- ${a.name} (v${a.version}, last by ${a.lastBy ?? 'someone'}) ---\n${a.content}`),
        ]
      : []),
    ...(ran.length > 0
      ? [
          '',
          'WHAT HAPPENED WHEN IT LAST RAN:',
          ...ran.map((r) => `$ ${r.command}\n${r.ok ? 'succeeded' : 'FAILED'}\n${r.output || '(no output)'}`),
        ]
      : []),
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
      run: [],
      artifact: null,
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
  // A command sent as one string is the shape that would need a shell to interpret.
  // Splitting it here keeps the no-shell rule from depending on the model's compliance.
  if (Array.isArray(obj.run)) {
    obj.run = (obj.run as unknown[])
      .map((cmd) => (typeof cmd === 'string' ? cmd.split(/\s+/).filter(Boolean) : cmd))
      .filter((cmd) => Array.isArray(cmd) && cmd.length > 0);
  } else if (obj.run !== undefined) {
    obj.run = [];
  }
  // Same reasoning as canon: a half-understood artifact is worse than none, because the
  // next turn would revise the wrong thing.
  if (obj.artifact !== undefined && obj.artifact !== null) {
    const a = obj.artifact as Record<string, unknown>;
    obj.artifact =
      typeof a.name === 'string' && a.name.trim().length > 0 && a.content !== undefined
        ? { name: a.name, content: render(a.content), ...(typeof a.note === 'string' ? { note: a.note } : {}) }
        : null;
  }
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
