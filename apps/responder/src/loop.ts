import { isFlintError } from '@flint/core';
import type { Participant } from './participant.js';
import { decodeAssistantTurn, type Message } from '@flint/core';
import {
  parseReply,
  systemPrompt,
  TAKE_TURN_TOOL,
  threadPrompt,
  ThreadStateSchema,
  type BuiltArtifact,
  type Offer,
  type RanBefore,
} from './prompt.js';
import { ensureSandbox, materialise, run as runCommand, workspaceFor } from './workspace.js';
import { buildRemotely, type RemoteSandbox } from './remote-sandbox.js';

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
  /** Where per-thread workspaces live, and whether anything may run in them. */
  workspaceRoot?: string;
  canRun?: boolean;
  /** A disposable runner elsewhere. Preferred over local Docker when present. */
  sandbox?: RemoteSandbox;
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

/** Failures at which a participant stops holding the thread up and passes it on. */
const PASS_AFTER = 2;

/**
 * How long a thread may sit with a participant that cannot answer before it is moved.
 *
 * Generous on purpose. A model is allowed to be slow, and a thread that is merely between
 * rounds must not be snatched away from whoever holds it.
 */
const STRANDED_MS = 15 * 60_000;

/*
 * What one turn may carry, matching what Nexus will accept. Kept here as named limits
 * rather than inline numbers because going over any of them refuses the whole append.
 */
const MAX_RUNS = 10;
const MAX_COMMAND = 300;
const MAX_OUTPUT = 2_000;
const TRIM_NOTE = '…earlier output trimmed\n';

/** How many build-produced files one turn may keep. A guard, not a target. */
const KEEP_PRODUCED = 5;

/** Directories that hold derived output, which is reproducible and not worth versioning. */
const DERIVED = /^(dist|build|out|coverage|\.next|\.turbo|\.cache|target)\//;

/**
 * Whether a file the build produced is worth keeping in the shared record.
 *
 * The test is "would you commit this?" — source and lockfiles yes, compiled output no.
 * Getting it wrong in the generous direction is expensive: every build would write dozens
 * of versions of files nobody reads, and the thread's real work would be lost among them.
 */
export function keepsAsArtifact(name: string): boolean {
  if (DERIVED.test(name)) return false;
  if (name.endsWith('.map') || name.endsWith('.log') || name.endsWith('.tsbuildinfo')) return false;
  return true;
}

export interface TickResult {
  turnsTaken: number;
  threadsClosed: number;
  /** Output tokens generated this round. What the round actually cost. */
  tokensOut: number;
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
    /** Who actually holds the floor. Read only when looking for stranded threads. */
    waitingOn?: string | null;
    updatedAt?: string;
  }>;
}

export async function tick(
  participants: Participant[],
  limits: Limits,
  log: Log,
  failures: Failures = new Map(),
): Promise<TickResult> {
  const result: TickResult = { turnsTaken: 0, threadsClosed: 0, tokensOut: 0, errors: [] };

  /*
   * Anything that reported itself failing gets re-checked, whether or not there is work
   * for it. Clearing the mark only when a turn lands meant a participant that recovered
   * stayed flagged for as long as nothing happened to come its way — the console kept
   * warning about something that was fine, which is how a warning stops being read.
   */
  await Promise.all(participants.map((p) => p.recheck()));

  await rescueStranded(participants, log).catch((err: unknown) =>
    result.errors.push(`could not check for stranded threads — ${describe(err)}`),
  );

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
   * Participants take their turns at the same time as each other.
   *
   * Sequentially, one slow provider held up every other participant: a round spent
   * ninety seconds waiting on a search model while two others sat idle with work in
   * front of them. Each wave takes at most one turn per participant, so concurrency is
   * bounded by how many there are — the point is that nobody waits on somebody else's
   * provider, not to run as many calls as possible.
   */
  const remaining = queues.map((q) => [...q]);
  /*
   * Which participant a short wave starts from, rotated between waves. When the budget
   * leaves room for fewer turns than there are participants, a fixed order would hand
   * every last slot to whoever happens to be first in the list.
   */
  let first = 0;

  while (result.turnsTaken < limits.maxTurnsPerTick && limits.runBudget - result.turnsTaken > 0) {
    /*
     * Sized to what is still allowed, not to how many participants there are. A full
     * wave starts before any of its turns finish, so an unsized one could overshoot the
     * cap by up to one turn per participant — the cap would stop being a cap.
     */
    const room = Math.min(limits.maxTurnsPerTick - result.turnsTaken, limits.runBudget - result.turnsTaken);
    const wave: Waiting[] = [];
    for (let i = 0; i < remaining.length && wave.length < room; i += 1) {
      const job = remaining[(first + i) % remaining.length]!.shift();
      if (job) wave.push(job);
    }
    if (wave.length === 0) break;
    first = (first + 1) % Math.max(1, remaining.length);

    const outcomes = await Promise.all(wave.map((job) => runJob(job, participants, limits, log, failures)));

    for (const outcome of outcomes) {
      if (outcome.taken) result.turnsTaken += 1;
      if (outcome.closed) result.threadsClosed += 1;
      result.tokensOut += outcome.tokensOut;
      if (outcome.error) result.errors.push(outcome.error);
    }
  }

  return result;
}

/**
 * Threads waiting on a participant that cannot answer them.
 *
 * Passing a thread on happens when a turn is attempted and fails. A thread whose holder
 * is already known to be down never gets that far: the participant does not list it,
 * because listing asks "is it my turn" and it never gets to try. So the thread simply
 * stops, with the console showing it waiting on someone who is never going to speak.
 *
 * Only threads held by a participant this runner drives are touched. One waiting on a
 * person is waiting on a person, and moving it would be answering for them.
 */
async function rescueStranded(participants: Participant[], log: Log): Promise<void> {
  const broken = participants.filter((p) => p.failing);
  if (broken.length === 0) return;

  const rescuer = participants.find((p) => !p.failing);
  if (!rescuer) return; // nobody is well enough to hand it to

  const listing = await rescuer.call<ThreadListing>('thread_list', {
    mine: false,
    status: 'OPEN',
    limit: 50,
  });

  const stuck = (listing.threads ?? []).filter((t) => {
    if (!t.waitingOn || !broken.some((p) => p.slug === t.waitingOn)) return false;
    const at = t.updatedAt ? Date.parse(t.updatedAt) : Number.NaN;
    return Number.isFinite(at) && Date.now() - at > STRANDED_MS;
  });

  for (const t of stuck) {
    try {
      await rescuer.call('thread_reassign', { threadId: t.threadId, to: rescuer.slug });
      await rescuer
        .call('thread_note', {
          threadId: t.threadId,
          content:
            `This was waiting on ${t.waitingOn}, which has been unable to answer for a while, ` +
            `so ${rescuer.slug} has picked it up rather than leaving it stopped.`,
        })
        .catch(() => undefined);
      log(`[${rescuer.slug}] rescued ${short(t.threadId)} from ${t.waitingOn}`);
    } catch (err) {
      log(`[${rescuer.slug}] could not rescue ${short(t.threadId)}: ${describe(err)}`);
    }
  }
}

interface Outcome {
  taken: boolean;
  closed: boolean;
  tokensOut: number;
  error?: string;
}

/** One participant's next piece of work, start to finish. */
async function runJob(
  job: Waiting,
  participants: Participant[],
  limits: Limits,
  log: Log,
  failures: Failures,
): Promise<Outcome> {
  // A thread that keeps failing is rested rather than hammered. The counter decays, so
  // it comes back on its own once the cause has had time to clear.
  const failed = failures.get(job.threadId) ?? 0;
  if (failed >= BACKOFF_AFTER) {
    const next = failed >= BACKOFF_AFTER + BACKOFF_ROUNDS ? 0 : failed + 1;
    failures.set(job.threadId, next);
    /*
     * Said in the thread on the round it starts resting, once. A thread that has quietly
     * stopped being attempted looks exactly like a thread nobody has got to yet, and
     * those need opposite responses from a person.
     */
    if (failed === BACKOFF_AFTER) await rest(job, BACKOFF_ROUNDS).catch(() => undefined);
    return { taken: false, closed: false, tokensOut: 0 };
  }

  if (job.turns >= limits.maxTurnsPerThread) {
    try {
      await closeExhausted(job, limits.maxTurnsPerThread);
      failures.delete(job.threadId);
      log(`[${job.participant.slug}] closed ${short(job.threadId)} at the ${limits.maxTurnsPerThread}-turn cap`);
      return { taken: false, closed: true, tokensOut: 0 };
    } catch (err) {
      failures.set(job.threadId, failed + 1);
      return {
        taken: false,
        closed: false,
        tokensOut: 0,
        error: `${job.participant.slug}: could not close ${short(job.threadId)} — ${describe(err)}`,
      };
    }
  }

  try {
    const { taken, tokensOut } = await takeTurn(job, limits, log);
    failures.delete(job.threadId);
    return { taken, closed: false, tokensOut };
  } catch (err) {
    const now = failed + 1;
    failures.set(job.threadId, now);

    /*
     * A participant whose provider is down should not hold a thread the others could
     * finish. Passing it on costs nothing and is what a person would do; resting the
     * thread instead punishes the work for a fault in one participant.
     */
    if (now >= PASS_AFTER && !job.volunteered && isProviderFault(err)) {
      const passed = await passOn(job, participants, err, log).catch(() => false);
      if (passed) {
        failures.delete(job.threadId);
        return { taken: false, closed: false, tokensOut: 0 };
      }
    }

    return {
      taken: false,
      closed: false,
      tokensOut: 0,
      error:
        `${job.participant.slug}: turn on ${short(job.threadId)} failed — ${describe(err)}` +
        (now >= BACKOFF_AFTER ? ` (resting it after ${now} failures)` : ''),
    };
  }
}

async function takeTurn(job: Waiting, limits: Limits, log: Log): Promise<{ taken: boolean; tokensOut: number }> {
  const { participant: p } = job;

  const state = ThreadStateSchema.parse(await p.call('thread_read', { threadId: job.threadId }));

  /*
   * The floor can move between listing and reading — someone may have been
   * renominated, or the thread closed. Checking here rather than letting the append
   * fail matters because the model call sits in between: a stale listing would
   * otherwise be paid for and then rejected.
   */
  if (state.status !== 'OPEN') return { taken: false, tokensOut: 0 };
  if (state.yourTurnIf && state.yourTurnIf !== p.slug) return { taken: false, tokensOut: 0 };

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
      return { taken: false, tokensOut: 0 };
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
   * What the thread has built already, sent in full. Without it a participant cannot
   * revise — it can only write something new over the top, which is how a document
   * gets restarted five times instead of improved five times.
   */
  const listed = await p
    .call<{ artifacts?: Array<{ name: string }> }>('artifact_read', { threadId: job.threadId })
    .catch(() => ({ artifacts: [] }));
  const built: BuiltArtifact[] = [];
  for (const entry of listed.artifacts ?? []) {
    const full = await p
      .call<BuiltArtifact>('artifact_read', { threadId: job.threadId, name: entry.name })
      .catch(() => null);
    if (full) built.push(full);
  }

  /*
   * The thread's files on disk, brought up to date before anything runs against them.
   * Rewritten every turn rather than only when they change: the workspace is a cache of
   * the artifacts, and a cache that can disagree with its source is worse than none.
   */
  const workspace =
    limits.canRun && limits.workspaceRoot ? workspaceFor(limits.workspaceRoot, job.threadId) : null;
  if (workspace && !limits.sandbox) {
    // Local Docker only. With a remote runner there is nothing here to prepare — that is
    // rather the point of it.
    const trouble = await ensureSandbox(limits.workspaceRoot!);
    if (trouble) log(`[${p.slug}] ${trouble}`);
  }

  if (workspace) {

    for (const artifact of built) {
      try {
        materialise(workspace, artifact.name, artifact.content);
      } catch (err) {
        log(`[${p.slug}] could not write ${artifact.name} to disk: ${describe(err)}`);
      }
    }
  }

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
        content: threadPrompt(state, p.slug, offers, built),
        timestamp: 0,
      },
    ],
    maxTokens: p.cfg.maxOutputTokens,
    signal: AbortSignal.timeout(p.turnTimeoutMs ?? limits.turnTimeoutMs),
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

  /*
   * The work itself, written before the turn that describes it. If the append fails the
   * artifact still stands, which is the right way round — the document is the point and
   * the turn is the commentary.
   */
  if (reply.artifact) {
    await p
      .call('artifact_write', {
        threadId: job.threadId,
        name: reply.artifact.name,
        content: reply.artifact.content,
        ...(reply.artifact.note ? { note: reply.artifact.note } : {}),
      })
      .then((written) => {
        const v = (written as { version?: number }).version;
        log(`[${p.slug}] wrote ${reply.artifact!.name}${v ? ` v${v}` : ''}`);
      })
      .catch((err: unknown) => log(`[${p.slug}] could not write ${reply.artifact!.name}: ${describe(err)}`));
  }

  /*
   * Anything this turn wrote goes to disk before its commands run, so a fix and the run
   * that proves it belong to the same turn rather than to the next one.
   */
  if (workspace && reply.artifact) {
    try {
      materialise(workspace, reply.artifact.name, reply.artifact.content);
    } catch (err) {
      log(`[${p.slug}] could not write ${reply.artifact.name} to disk: ${describe(err)}`);
    }
  }

  /*
   * Commands run before the turn is recorded, so what happened lands on the turn itself.
   *
   * They used to run after the append and be held in a map on this machine, which meant
   * the build output was invisible to the console, lost on restart, and unavailable to a
   * second runner. On the turn it is part of the shared record — the next speaker reads
   * it from the thread rather than from whichever process happened to produce it.
   */
  let ran: RanBefore[] = [];
  if (workspace && reply.run.length > 0) {
    const results: RanBefore[] = [];

    if (limits.sandbox) {
      /*
       * Elsewhere, on a machine that can be thrown away. The whole directory goes and
       * whatever it produced comes back, because the runner keeps nothing between calls
       * — which is the property that makes it safe to give it code at all.
       */
      const files: Record<string, string> = {};
      for (const artifact of built) files[artifact.name] = artifact.content;
      if (reply.artifact) files[reply.artifact.name] = reply.artifact.content;

      const remote = await buildRemotely(limits.sandbox, files, reply.run);
      for (const result of remote.results) {
        results.push({ command: result.command, ok: result.ok, output: result.output });
        log(`[${p.slug}] $ ${result.command} — ${result.ok ? 'ok' : `failed (${result.code ?? 'no exit'})`}`);
      }
      // Compiled output and lockfiles are part of what was built; losing them would make
      // every subsequent turn start from source again.
      for (const [name, content] of Object.entries(remote.files)) {
        try {
          materialise(workspace, name, content);
        } catch {
          // A name the sandbox produced that will not sit inside the workspace.
        }
      }

      /*
       * Files the build produced that nobody wrote go back to Nexus as artifacts.
       *
       * Without this a lockfile, a generated client or a scaffolded config existed only
       * on this machine: invisible in the console, absent from an export run anywhere
       * else, and gone if the workspace is cleared. They are part of the product, so
       * they belong with the rest of it.
       *
       * Only what is genuinely new and genuinely source. Compiled output is derivable
       * and would turn every build into a wall of versions nobody reads.
       */
      const known = new Set(built.map((a) => a.name));
      if (reply.artifact) known.add(reply.artifact.name);
      const produced = Object.entries(remote.files)
        .filter(([name]) => !known.has(name) && keepsAsArtifact(name))
        .slice(0, KEEP_PRODUCED);

      for (const [name, content] of produced) {
        await p
          .call('artifact_write', {
            threadId: job.threadId,
            name,
            content,
            note: 'Produced by the build rather than written by hand.',
          })
          .then(() => log(`[${p.slug}] kept ${name} from the build`))
          .catch(() => undefined);
      }
    } else {
      for (const argv of reply.run) {
        const result = await runCommand(workspace, argv);
        results.push({ command: result.command, ok: result.ok, output: result.output });
        log(`[${p.slug}] $ ${result.command} — ${result.ok ? 'ok' : `failed (${result.code ?? 'no exit'})`}`);
      }
    }
    /*
     * Nexus caps what one turn may carry, and an oversized field is refused whole — a
     * verbose build log would cost the turn its entire record rather than just its tail.
     * The tail is what is kept: a failure says why at the end, not at the beginning.
     */
    ran = results.slice(-MAX_RUNS).map((r) => ({
      command: r.command.slice(0, MAX_COMMAND),
      ok: r.ok,
      output:
        r.output.length > MAX_OUTPUT
          ? `…earlier output trimmed\n${r.output.slice(-(MAX_OUTPUT - TRIM_NOTE.length))}`
          : r.output,
    }));
  }


  const appended = await p.call<{ seq: number; next: string | null; routedBy?: string }>('thread_append', {
    threadId: job.threadId,
    content: reply.content,
    summary: reply.summary,
    ...(reply.next ? { next: reply.next } : {}),
    ...(reply.ask ? { ask: reply.ask } : {}),
    done: reply.done,
    ...(ran.length > 0 ? { runs: ran } : {}),
    // Reported so "what did this thread cost" is answerable. Nexus never calls a model
    // and cannot measure this itself.
    tokensIn: generated.usage.input,
    tokensOut: generated.usage.output,
  });

  if (reply.done && reply.canon) {
    await p
      .call('propose_canon', {
        key: reply.canon.key,
        content: reply.canon.content,
        ...(reply.canon.rationale ? { rationale: reply.canon.rationale } : {}),
        // The argument behind the claim. Without it you are asked to approve a
        // conclusion with no way to read how it was reached.
        threadId: job.threadId,
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

  // Working again is as worth saying as failing was.
  await p.reportRecovered();

  log(
    `[${p.slug}] turn ${appended.seq} on ${short(job.threadId)}${job.volunteered ? ' (took an open floor)' : ''} ${handoff} (${cost})`,
  );
  return { taken: true, tokensOut: generated.usage.output };
}

/**
 * Marks a thread as resting, in the thread, where the console will read it.
 *
 * A note rather than a turn: nothing was contributed and the floor must not move, or a
 * participant that is merely unavailable would lose its place to the backoff.
 */
async function rest(job: Waiting, rounds: number): Promise<void> {
  await job.participant.call('thread_note', {
    threadId: job.threadId,
    content:
      `Repeated failures taking a turn here, so this is being left alone for about ${rounds} rounds ` +
      'rather than retried every few seconds. It will be picked up again on its own.',
    resting: {
      until: new Date(Date.now() + rounds * 60_000).toISOString(),
      why: 'repeated failures taking a turn',
    },
  });
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

/**
 * True when the failure is the provider's rather than the thread's.
 *
 * A rejected payload or a bad request will fail the same way for everyone, so passing
 * it on would only spread the failure. An unreachable or overloaded provider is
 * specific to this participant, and someone else can answer.
 */
function isProviderFault(err: unknown): boolean {
  if (!isFlintError(err)) return false;
  return err.error.kind === 'provider_unavailable' || err.error.kind === 'timeout' || err.error.kind === 'rate_limit';
}

/**
 * Hands a thread to someone who can answer it, and says in the thread why it moved.
 * Silence would leave the next speaker guessing at a gap in the conversation.
 */
async function passOn(
  job: Waiting,
  participants: Participant[],
  err: unknown,
  log: Log,
): Promise<boolean> {
  const peer = participants.find((other) => other.slug !== job.participant.slug);
  if (!peer) return false;

  await job.participant.call('thread_reassign', {
    threadId: job.threadId,
    to: peer.slug,
  });

  /*
   * Why the speaker changed, in the thread itself. Silence here reads as a routing bug:
   * you see a participant that was asked for something and never answered, with nothing
   * saying it was unable to.
   */
  await job.participant
    .call('thread_note', {
      threadId: job.threadId,
      content: `${job.participant.slug} could not take this turn (${describe(err)}), so it passed to ${peer.slug}.`,
    })
    .catch(() => undefined);

  // Recorded against the participant that could not answer, so the trail shows which
  // one was unavailable rather than leaving an unexplained change of speaker.
  await job.participant.reportFailing(`could not take a turn: ${describe(err)}`);

  log(`[${job.participant.slug}] could not answer, passed ${short(job.threadId)} to ${peer.slug}`);
  return true;
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
