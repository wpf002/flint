import { isFlintError } from '@flint/core';
import type { Participant } from './participant.js';
import { parseReply, systemPrompt, threadPrompt, ThreadStateSchema } from './prompt.js';

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
}

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
}

/** What `thread_list` returns for one participant. */
interface ThreadListing {
  threads: Array<{ threadId: string; goal: string; turns: number; yourTurn: boolean }>;
}

export async function tick(participants: Participant[], limits: Limits, log: Log): Promise<TickResult> {
  const result: TickResult = { turnsTaken: 0, threadsClosed: 0, errors: [] };

  const queues: Waiting[][] = [];
  for (const p of participants) {
    try {
      const listing = await p.call<ThreadListing>('thread_list', { mine: true, status: 'OPEN' });
      queues.push(
        (listing.threads ?? [])
          .filter((t) => t.yourTurn)
          .map((t) => ({ participant: p, threadId: t.threadId, goal: t.goal, turns: t.turns })),
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

    if (job.turns >= limits.maxTurnsPerThread) {
      try {
        await closeExhausted(job, limits.maxTurnsPerThread);
        result.threadsClosed += 1;
        log(`[${job.participant.slug}] closed ${short(job.threadId)} at the ${limits.maxTurnsPerThread}-turn cap`);
      } catch (err) {
        result.errors.push(`${job.participant.slug}: could not close ${short(job.threadId)} — ${describe(err)}`);
      }
      continue;
    }

    try {
      const taken = await takeTurn(job, log);
      if (taken) result.turnsTaken += 1;
    } catch (err) {
      result.errors.push(`${job.participant.slug}: turn on ${short(job.threadId)} failed — ${describe(err)}`);
    }
  }

  return result;
}

async function takeTurn(job: Waiting, log: Log): Promise<boolean> {
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

  const generated = await p.provider.generate({
    model: p.cfg.model,
    system: systemPrompt(p.slug, p.cfg.role, p.cfg.maxOutputTokens),
    messages: [
      {
        id: `${job.threadId}:${state.turnCount}`,
        role: 'user',
        content: threadPrompt(state, p.slug),
        timestamp: 0,
      },
    ],
    maxTokens: p.cfg.maxOutputTokens,
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

  const { reply, malformed } = parseReply(generated.message.content);
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
  });

  // Facts the participant flagged as outliving the thread. Written under its own
  // namespace, so they are attributable and revocable like any other memory.
  for (const fact of reply.remember) {
    await p
      .call('remember', { content: fact, tags: ['thread', job.threadId] })
      .catch((err: unknown) => log(`[${p.slug}] could not store a fact: ${describe(err)}`));
  }

  const cost = `${generated.usage.input}→${generated.usage.output} tok`;
  const handoff = reply.done
    ? 'closed the thread'
    : appended.next
      ? `→ ${appended.next}${appended.routedBy === 'nexus' ? ' (routed by Nexus)' : ''}`
      : '→ floor open';

  log(`[${p.slug}] turn ${appended.seq} on ${short(job.threadId)} ${handoff} (${cost})`);
  return true;
}

/**
 * A thread that has hit the turn cap is closed rather than abandoned. Leaving it open
 * would leave it permanently waiting on a participant that has been told to stop,
 * which reads as a hang rather than a decision.
 */
async function closeExhausted(job: Waiting, cap: number): Promise<void> {
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

function short(threadId: string): string {
  return threadId.length > 10 ? `${threadId.slice(0, 8)}…` : threadId;
}

export function describe(err: unknown): string {
  if (isFlintError(err)) return `${err.error.kind}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}
