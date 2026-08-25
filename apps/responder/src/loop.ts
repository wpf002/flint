import { isFlintError } from '@flint/core';
import type { Participant } from './participant.js';
import { decodeAssistantTurn, type Message } from '@flint/core';
import {
  parseReply,
  systemPrompt,
  TAKE_TURN_TOOL,
  threadPrompt,
  ThreadStateSchema,
  type Offer,
} from './prompt.js';

/**
 * The loop that makes the space self-running.
 *
 * Nexus already sequences the work: every turn names who speaks next, and a thread
 * refuses turns from anyone but that participant. All this adds is the missing half —
 * something that notices "it is your turn" and answers without a human relaying it.
 *
 * Deliberately poll-driven rather than event-driven. A missed poll costs latency; a
 * missed event would leave a thread stalled with nobody able to tell.
 */

export interface Limits {
  maxTurnsPerTick: number;
  maxTurnsPerThread: number;
  /** Remaining model calls for the whole run. Infinity when uncapped. */
  runBudget: number;
  /** How long one turn may take before it is abandoned. */
  turnTimeoutMs: number;
}

/**
 * Consecutive failures per thread, carried between rounds.
 *
 * Without it a thread that cannot be answered — a provider refusing it, a payload it
 * chokes on — is retried every fifteen seconds forever, and a single broken thread
 * spends the day's budget failing.
 */
export type Failures = Map<string, number>;

/** After this many consecutive failures a thread is left alone for a while. */
const BACKOFF_AFTER = 3;
const BACKOFF_ROUNDS = 20;

export interface TickResult {
  turnsTaken: number;
  threadsClosed: number;
  errors: string[];
}

export type Log = (line: string) => void;

interface Waiting {
  participant: Participant;
  threadId: string;
  goal: string;
  turns: number;
  /** Nobody was named; this participant is volunteering rather than answering. */
  volunteered: boolean;
}

/** What `thread_list` returns for one participant. */
interface ThreadListing {
  threads: Array<{
    threadId: string;
    goal: string;
    turns: number;
    yourTurn: boolean;
    floorOpen?: boolean;
    youMatch?: boolean;
    ask?: string | null;
  }>;
}

export async function tick(
  participants: Participant[],
  limits: Limits,
  log: Log,
  failures: Failures = new Map(),
): Promise<TickResult> {
  const result: TickResult = { turnsTaken: 0, threadsClosed: 0, errors: [] };

  const queues: Waiting[][] = [];
  for (const p of participants) {
    try {
      const listing = await p.call<ThreadListing>('thread_list', {
        mine: true,
        status: 'OPEN',
        includeOpenFloor: true,
      });
      queues.push(
        (listing.threads ?? [])
          // An open floor is only taken by whoever the ask points at. Every participant
          // can see every open thread; all of them volunteering would produce the same
          // turn several times over and pay for each one.
          .filter((t) => t.yourTurn || (t.floorOpen && t.youMatch))
          .map((t) => ({
            participant: p,
            threadId: t.threadId,
            goal: t.goal,
            turns: t.turns,
            volunteered: !t.yourTurn,
          })),
      );
    } catch (err) {
      result.errors.push(`${p.slug}: could not list threads — ${describe(err)}`);
      queues.push([]);
    }
  }

  /*
   * Round-robin across participants rather than draining one at a time. A single
   * participant with a backlog would otherwise consume the entire tick budget and
   * the others would look dead.
   */
  for (const job of interleave(queues)) {
    if (result.turnsTaken >= limits.maxTurnsPerTick) break;
    if (limits.runBudget - result.turnsTaken <= 0) break;

    // A thread that keeps failing is rested rather than hammered. The counter decays,
    // so it comes back on its own once the cause has had time to clear.
    const failed = failures.get(job.threadId) ?? 0;
    if (failed >= BACKOFF_AFTER) {
      failures.set(job.threadId, failed >= BACKOFF_AFTER + BACKOFF_ROUNDS ? 0 : failed + 1);
      continue;
    }

    if (job.turns >= limits.maxTurnsPerThread) {
      try {
        await closeExhausted(job, limits.maxTurnsPerThread);
        failures.delete(job.threadId);
        result.threadsClosed += 1;
        log(`[${job.participant.slug}] closed ${short(job.threadId)} at the ${limits.maxTurnsPerThread}-turn cap`);
      } catch (err) {
        failures.set(job.threadId, failed + 1);
        result.errors.push(`${job.participant.slug}: could not close ${short(job.threadId)} — ${describe(err)}`);
      }
      continue;
    }

    try {
      const taken = await takeTurn(job, limits, log);
      if (taken) result.turnsTaken += 1;
      failures.delete(job.threadId);
    } catch (err) {
      const now = failed + 1;
      failures.set(job.threadId, now);
      result.errors.push(
        `${job.participant.slug}: turn on ${short(job.threadId)} failed — ${describe(err)}` +
          (now >= BACKOFF_AFTER ? ` (resting it after ${now} failures)` : ''),
      );
    }
  }

  return result;
}

async function takeTurn(job: Waiting, limits: Limits, log: Log): Promise<boolean> {
  const { participant: p } = job;

  const state = ThreadStateSchema.parse(await p.call('thread_read', { threadId: job.threadId }));

  /*
   * The floor can move between listing and reading — someone may have been
   * renominated, or the thread closed. Checking here rather than letting the append
   * fail matters because the model call sits in between: a stale listing would
   * otherwise be paid for and then rejected.
   */
  if (state.status !== 'OPEN') return false;
  if (state.yourTurnIf && state.yourTurnIf !== p.slug) return false;

  /*
   * An open floor is a race: several participants can see it at once, and all of them
   * volunteering would produce the same turn three times over. Claiming it first turns
   * the race into an ordinary nomination — whoever loses finds the floor taken on its
   * next read and moves on.
   */
  if (job.volunteered) {
    try {
      await p.call('thread_reassign', { threadId: job.threadId, to: p.slug });
    } catch {
      return false;
    }
  }

  /*
   * Anything another participant has offered this one. Shown with the turn rather than
   * handled separately: an offer is context for the work, and deciding on it in the
   * same call it is read costs nothing extra.
   */
  const inbox = await p
    .call<{ handoffs: Offer[] }>('check_inbox', { status: 'PENDING', direction: 'incoming', limit: 5 })
    .catch(() => ({ handoffs: [] as Offer[] }));
  const offers = inbox.handoffs ?? [];

  /*
   * Where the provider can enforce the reply shape, it is made to. Asking in the prompt
   * works until it doesn't: one model opened valid JSON and then broke out of it
   * mid-string into prose, which cost the whole turn its nomination.
   */
  const forced = p.replyMode === 'tool';
  const generated = await p.provider.generate({
    model: p.cfg.model,
    system: systemPrompt(p.slug, p.cfg.role, p.cfg.maxOutputTokens),
    messages: [
      {
        id: `${job.threadId}:${state.turnCount}`,
        role: 'user',
        content: threadPrompt(state, p.slug, offers),
        timestamp: 0,
      },
    ],
    maxTokens: p.cfg.maxOutputTokens,
    signal: AbortSignal.timeout(limits.turnTimeoutMs),
    ...(forced ? { tools: [TAKE_TURN_TOOL], toolChoice: { name: TAKE_TURN_TOOL.name } } : {}),
  });

  /*
   * A reply cut off at the cap is not a badly-formatted reply, and recording it as one
   * buries the cause: the turn lands truncated, nominates nobody, and the thread stops
   * with nothing saying why. Refusing to append leaves the floor where it is, so the
   * turn is retried once the cap is raised.
   */
  if (generated.reason === 'max_tokens') {
    throw new Error(
      `reply hit the ${p.cfg.maxOutputTokens}-token cap and was cut off. Nothing recorded — raise maxOutputTokens for '${p.slug}'.`,
    );
  }

  // A forced tool call carries the reply as its arguments rather than as message text.
  const raw = forced ? forcedReply(generated.message) : generated.message.content;
  const { reply, malformed } = parseReply(raw);
  if (malformed) {
    log(`[${p.slug}] reply was not valid JSON; recording it as-is and nominating nobody`);
  }

  const appended = await p.call<{ seq: number; next: string | null; routedBy?: string }>('thread_append', {
    threadId: job.threadId,
    content: reply.content,
    summary: reply.summary,
    ...(reply.next ? { next: reply.next } : {}),
    ...(reply.ask ? { ask: reply.ask } : {}),
    done: reply.done,
    // Reported so "what did this thread cost" is answerable. Nexus never calls a model
    // and cannot measure this itself.
    tokensIn: generated.usage.input,
    tokensOut: generated.usage.output,
  });

  /*
   * A thread that reached a conclusion offers it to shared memory. This is a proposal,
   * not a write — canon is human-approved only, and nothing here can change that. It
   * fires only on the closing turn: a conclusion proposed mid-thread is a guess about
   * where the thread is heading.
   */
  if (reply.done && reply.canon) {
    await p
      .call('propose_canon', {
        key: reply.canon.key,
        content: reply.canon.content,
        ...(reply.canon.rationale ? { rationale: reply.canon.rationale } : {}),
      })
      .then(() => log(`[${p.slug}] proposed "${reply.canon!.key}" to shared facts, awaiting your review`))
      .catch((err: unknown) => log(`[${p.slug}] could not propose to canon: ${describe(err)}`));
  }

  // Offers this turn chose to keep. Accepting writes the fact into the accepter's own
  // namespace, so it stays attributable to whoever took it, not to whoever sent it.
  for (const id of reply.accept) {
    const offer = offers.find((o) => o.id === id);
    if (!offer) continue;
    await p
      .call('accept_handoff', { handoffId: id, content: offer.content, tags: ['handoff'] })
      .then(() => log(`[${p.slug}] kept an offer from ${offer.from.slug}`))
      .catch((err: unknown) => log(`[${p.slug}] could not accept an offer: ${describe(err)}`));
  }

  // Facts the participant flagged as outliving the thread. Written under its own
  // namespace, so they are attributable and revocable like any other memory.
  for (const fact of reply.remember) {
    await p
      /* `kind` is required and was never sent, so every fact a participant tried to
       * store was rejected. OBSERVATION is right for something noticed in a thread:
       * it is what the participant saw, not a rule it is asserting. */
      .call('remember', { kind: 'OBSERVATION', content: fact, tags: ['thread', job.threadId] })
      .catch((err: unknown) => log(`[${p.slug}] could not store a fact: ${describe(err)}`));

    /*
     * A fact learned mid-thread is usually a fact the next speaker needs, so it is
     * offered to them rather than left where only its author can see it. An offer, not
     * a push: the recipient decides whether to keep it, which is the rule the whole
     * handoff mechanism exists to enforce.
     */
    if (appended.next) {
      await p
        .call('handoff', {
          to: appended.next,
          subject: fact.slice(0, 200),
          content: fact,
          tags: ['thread', job.threadId],
        })
        .catch((err: unknown) => log(`[${p.slug}] could not offer a fact onward: ${describe(err)}`));
    }
  }

  const cost = `${generated.usage.input}→${generated.usage.output} tok`;
  const handoff = reply.done
    ? 'closed the thread'
    : appended.next
      ? `→ ${appended.next}${appended.routedBy === 'nexus' ? ' (routed by Nexus)' : ''}`
      : '→ floor open';

  log(
    `[${p.slug}] turn ${appended.seq} on ${short(job.threadId)}${job.volunteered ? ' (took an open floor)' : ''} ${handoff} (${cost})`,
  );
  return true;
}

/**
 * A thread that has hit the turn cap is closed rather than abandoned. Leaving it open
 * would leave it permanently waiting on a participant that has been told to stop,
 * which reads as a hang rather than a decision.
 */
async function closeExhausted(job: Waiting, cap: number): Promise<void> {
  // Closing is a turn, and a turn needs the floor. Skipping this left a capped thread
  // with an open floor permanently unclosable: the append was refused every round.
  if (job.volunteered) {
    await job.participant.call('thread_reassign', { threadId: job.threadId, to: job.participant.slug });
  }

  await job.participant.call('thread_append', {
    threadId: job.threadId,
    content:
      `This thread reached its ${cap}-turn limit without reaching its goal. ` +
      'Closing it here rather than continuing to spend on it. Anything still needed should start a new thread with a narrower goal.',
    summary: `Closed at the ${cap}-turn limit.`,
    done: true,
  });
}

/** Round-robin merge: one item from each queue in turn until all are empty. */
function interleave<T>(queues: T[][]): T[] {
  const out: T[] = [];
  const longest = Math.max(0, ...queues.map((q) => q.length));
  for (let i = 0; i < longest; i += 1) {
    for (const q of queues) {
      const item = q[i];
      if (item !== undefined) out.push(item);
    }
  }
  return out;
}

/** Pulls the forced call's arguments back out as JSON for the ordinary parser. */
function forcedReply(message: Message): string {
  const turn = decodeAssistantTurn(message);
  const call = turn.toolCalls[0];
  return call ? JSON.stringify(call.args ?? {}) : turn.text;
}

function short(threadId: string): string {
  return threadId.length > 10 ? `${threadId.slice(0, 8)}…` : threadId;
}

export function describe(err: unknown): string {
  if (isFlintError(err)) return `${err.error.kind}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}
