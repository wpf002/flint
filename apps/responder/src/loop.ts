import { isFlintError } from '@flint/core';
import type { Participant } from './participant.js';
import { decodeAssistantTurn, type Message } from '@flint/core';
import { applyEdits } from './edits.js';
import {
  parseReply,
  systemPrompt,
  TAKE_TURN_TOOL,
  threadContext,
  threadPrompt,
  ThreadStateSchema,
  type BuiltArtifact,
  type Offer,
  type RanBefore,
  lastRuns,
  MAX_COMMANDS_PER_TURN,
  MAX_FILES_PER_TURN,
  pastedFile,
  runHistory,
} from './prompt.js';
import { ensureSandbox, materialise, run as runCommand, workspaceFor } from './workspace.js';
import { isStandupGoal } from './standup.js';
import { namesReview, needsPassingRun, pagesIn, refuseClose, refuseSkipped, refuseUnreviewed, refuseUnstyled, skippedStep, stepFor, VISUAL_REVIEW } from './closing.js';
import { measuredIn, withPaths, type ReviewScreens } from './visual-review.js';
import { buildRemotely, type RemoteBuild, type RemoteSandbox } from './remote-sandbox.js';

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
  /** Delays before retrying a provider that failed on its edge. Tests pass []. */
  retryDelaysMs?: number[];
  /** Looks at screenshots the sandbox renders. Without one, screenshots go unreviewed. */
  reviewScreens?: ReviewScreens;
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

/** Turns a standup may run. Enough for each participant to speak once and one to close. */
const STANDUP_TURN_CAP = 4;

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

/*
 * What Nexus accepts in an ask. A refusal composed here is not clipped by the reply
 * parser, and the measured phone-view problems made one long enough that Nexus refused
 * the whole turn as invalid — three times in the fifth aqi run, until the builder was
 * rested. The ask is the one field this code writes without a schema behind it.
 */
const MAX_ASK = 1_000;

export function clipAsk(ask: string): string {
  return ask.length > MAX_ASK ? `${ask.slice(0, MAX_ASK - 1)}…` : ask;
}
const TRIM_NOTE = '…earlier output trimmed\n';

/** What Nexus accepts in a canon proposal. */
const MAX_CANON = 600;
const MAX_RATIONALE = 300;

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
  await coverMissedTurns(participants, log).catch((err: unknown) =>
    result.errors.push(`could not check for missed chat-app turns — ${describe(err)}`),
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
      /*
       * Handed on by the participant that is stuck, not taken by the one picking it up.
       *
       * Nexus refuses a participant taking someone else's floor until it has sat for a
       * day, so the rescuer asking for it was refused every time — the rescue never
       * happened and logged a failure every round. Giving away a floor you hold is
       * always allowed, and the stuck participant's Nexus token still works: it is its
       * model that is down, not its connection.
       */
      const holder = broken.find((p) => p.slug === t.waitingOn);
      await (holder ?? rescuer).call('thread_reassign', { threadId: t.threadId, to: rescuer.slug });
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

/*
 * Who does a chat app's part when the app misses its turn.
 *
 * The apps check in on their own schedules, hourly at best. In the aqi builds ChatGPT took
 * none of its turns in forty hours: its scheduled check switched itself off twice and its
 * copy of Nexus's tools went stale twice. Each time the finished build waited on it, for
 * nine hours once, and nothing said so. Now the step goes to the same maker's API model,
 * the thread records why, and the build carries on.
 */
export const STANDS_IN_FOR: Readonly<Record<string, string>> = {
  claude: 'claude-api',
  chatgpt: 'gpt-api',
  perplexity: 'perplexity-api',
};

/** Nexus lets a participant move a scheduled app's floor after 90 minutes; one minute's margin. */
export const MISSED_TURN_MS = 91 * 60 * 1000;

/** How often to look. Every round would be a listing every fifteen seconds for an hourly event. */
export const MISSED_TURN_CHECK_MS = 5 * 60 * 1000;

const missedTurns = { lastChecked: 0 };

export async function coverMissedTurns(
  participants: Participant[],
  log: Log,
  now = Date.now(),
  state = missedTurns,
): Promise<void> {
  if (now - state.lastChecked < MISSED_TURN_CHECK_MS) return;
  state.lastChecked = now;

  const healthy = participants.filter((p) => !p.failing);
  const lister = healthy[0];
  if (!lister) return;

  const listing = await lister.call<ThreadListing>('thread_list', { mine: false, status: 'OPEN', limit: 50 });
  for (const t of listing.threads ?? []) {
    const app = t.waitingOn;
    if (!app || !Object.hasOwn(STANDS_IN_FOR, app)) continue;
    const at = t.updatedAt ? Date.parse(t.updatedAt) : Number.NaN;
    if (!Number.isFinite(at) || now - at < MISSED_TURN_MS) continue;
    const standIn = healthy.find((p) => p.slug === STANDS_IN_FOR[app]);
    if (!standIn) continue;

    try {
      // Taken by the stand-in itself, so the ask stays as it was written for the app.
      await standIn.call('thread_reassign', { threadId: t.threadId, to: standIn.slug });
      await standIn
        .call('thread_note', {
          threadId: t.threadId,
          content: `${app} did not take its turn within 90 minutes, so ${standIn.slug} is doing its part. The ask is unchanged.`,
        })
        .catch(() => undefined);
      log(`[${standIn.slug}] covered ${short(t.threadId)} for ${app}, which missed its turn`);
    } catch (err) {
      log(`[${standIn.slug}] could not cover ${short(t.threadId)} for ${app}: ${describe(err)}`);
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

  // A standup is a few sentences each, not a build. One ran twelve turns and wrote
  // five versions of a retry procedure nobody asked for.
  const cap = isStandupGoal(job.goal) ? STANDUP_TURN_CAP : limits.maxTurnsPerThread;
  if (job.turns >= cap) {
    try {
      await closeExhausted(job, cap);
      failures.delete(job.threadId);
      log(`[${job.participant.slug}] closed ${short(job.threadId)} at the ${cap}-turn cap`);
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

  // Who cannot answer right now, so a turn never hands the thread to them.
  const down = participants.filter((o) => o.failing && o.slug !== job.participant.slug).map((o) => o.slug);

  try {
    const { taken, tokensOut } = await takeTurn(job, limits, log, down);
    failures.delete(job.threadId);
    return { taken, closed: false, tokensOut };
  } catch (err) {
    const now = failed + 1;
    failures.set(job.threadId, now);

    /*
     * A participant whose provider is down should not hold a thread the others could
     * finish. Passing it on costs nothing and is what a person would do; resting the
     * thread instead punishes the work for a fault in one participant.
     *
     * A transient fault gets a second try, since one failed call is usually nothing.
     * An account fault does not clear by itself: the sixth product build spent three
     * rounds and a fifteen-minute rescue each time a builder with no credit was tried.
     */
    const fault = providerFault(err);
    if (!job.volunteered && (fault === 'account' || (fault === 'transient' && now >= PASS_AFTER))) {
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

async function takeTurn(
  job: Waiting,
  limits: Limits,
  log: Log,
  down: string[] = [],
): Promise<{ taken: boolean; tokensOut: number }> {
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
  const generated = await withRetry(log, p.slug, () => p.provider.generate({
    model: p.cfg.model,
    /*
     * What stays the same from turn to turn goes first, in the system prompt, so a
     * provider that caches a repeated prefix can. No breakpoint is asked for: in a build
     * a file changes almost every turn, and the eighth product build's eleven turns had
     * no cache hit at all, only the write premium.
     */
    system: systemPrompt(
      p.slug,
      p.cfg.role,
      p.cfg.maxOutputTokens,
      Boolean(workspace),
      p.replyMode,
      threadContext(state, p.slug, built, down),
    ),
    messages: [
      {
        id: `${job.threadId}:${state.turnCount}`,
        role: 'user',
        content: threadPrompt(state, p.slug, offers, lastRuns(state)),
        timestamp: 0,
      },
    ],
    maxTokens: p.cfg.maxOutputTokens,
    signal: AbortSignal.timeout(p.turnTimeoutMs ?? limits.turnTimeoutMs),
    ...(forced ? { tools: [TAKE_TURN_TOOL], toolChoice: { name: TAKE_TURN_TOOL.name } } : {}),
  }), limits.retryDelaysMs);

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
   * Edits become whole files here, on top of what the thread has built, so everything
   * after this point handles one kind of thing. A refused edit changes nothing and is
   * reported to the thread below.
   */
  // A standup talks; it builds nothing. Files and commands sent from one are dropped.
  if (isStandupGoal(state.goal) && (reply.files.length > 0 || reply.edits.length > 0 || reply.run.length > 0)) {
    log(`[${p.slug}] dropped ${reply.files.length} file(s), ${reply.edits.length} edit(s) and ${reply.run.length} command(s) from a standup turn`);
    reply.files = [];
    reply.edits = [];
    reply.run = [];
  }

  const applied = applyEdits(reply.edits, reply.files, built);
  const files = applied.files;
  for (const bad of applied.failed) log(`[${p.slug}] edit to ${bad.name} not applied: ${bad.reason}`);
  if (reply.edits.length > applied.failed.length) {
    log(`[${p.slug}] applied ${reply.edits.length - applied.failed.length} edit(s)`);
  }

  /*
   * The work itself, written before the turn that describes it. If the append fails the
   * artifact still stands, which is the right way round — the document is the point and
   * the turn is the commentary.
   */
  for (const file of files) {
    await p
      .call('artifact_write', {
        threadId: job.threadId,
        name: file.name,
        content: file.content,
        ...(file.note ? { note: file.note } : {}),
      })
      .then((written) => {
        const v = (written as { version?: number }).version;
        log(`[${p.slug}] wrote ${file.name}${v ? ` v${v}` : ''}`);
      })
      .catch((err: unknown) => log(`[${p.slug}] could not write ${file.name}: ${describe(err)}`));
  }

  /*
   * Anything this turn wrote goes to disk before its commands run, so a fix and the run
   * that proves it belong to the same turn rather than to the next one.
   */
  if (workspace) {
    for (const file of files) {
      try {
        materialise(workspace, file.name, file.content);
      } catch (err) {
        log(`[${p.slug}] could not write ${file.name} to disk: ${describe(err)}`);
      }
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
  let reviewTokens = 0;
  const commands = reply.run.filter((argv) => !namesReview(argv));
  if (commands.length < reply.run.length) {
    log(`[${p.slug}] dropped "${VISUAL_REVIEW}" from its commands: the review runs by itself after a screenshot`);
  }
  if (workspace && commands.length > 0) {
    const results: RanBefore[] = [];

    if (limits.sandbox) {
      /*
       * Elsewhere, on a machine that can be thrown away. The whole directory goes and
       * whatever it produced comes back, because the runner keeps nothing between calls
       * — which is the property that makes it safe to give it code at all.
       */
      const bundle: Record<string, string> = {};
      for (const artifact of built) bundle[artifact.name] = artifact.content;
      for (const file of files) bundle[file.name] = file.content;

      /*
       * A sandbox that is down must not cost the turn.
       *
       * This sits between the model call and the append, so throwing here threw away a
       * reply that had already been generated and billed — and because the turn never
       * landed, the floor stayed put and the identical turn was regenerated and paid for
       * again next round, with none of it reaching the daily token ledger. Reported as a
       * failed command instead: that is something the thread can read and act on.
       */
      const remote = await buildRemotely(limits.sandbox, bundle, commands).catch((err: unknown) => {
        log(`[${p.slug}] the build sandbox could not be reached: ${describe(err)}`);
        return {
          results: commands.map((argv) => ({
            command: argv.join(' '),
            ok: false,
            code: null,
            output: `The build sandbox could not be reached: ${describe(err)}. Nothing was run.`,
          })),
          files: {} as Record<string, string>,
        } as RemoteBuild;
      });

      for (const result of remote.results ?? []) {
        results.push({ command: result.command, ok: result.ok, output: result.output });
        log(`[${p.slug}] $ ${result.command} — ${result.ok ? 'ok' : `failed (${result.code ?? 'no exit'})`}`);
      }
      if ((remote.images?.length ?? 0) > 0 && limits.reviewScreens) {
        // What the reviewer said before, so this round is judged against it rather than
        // from scratch, and so a page that has been fixed twice is only blocked on defects.
        const reviews = runHistory(state).flat().filter((r) => r.command === VISUAL_REVIEW);
        const prior = { fixRounds: reviews.filter((r) => !r.ok).length, notes: reviews[0]?.output ?? null };
        const outputs = (remote.results ?? []).map((r) => r.output);
        const review = await limits
          .reviewScreens(withPaths(remote.images!, outputs), state.goal, prior, measuredIn(outputs))
          .catch((err: unknown) => ({
            pass: false,
            notes: `The visual review could not run: ${describe(err)}`,
            tokensOut: 0,
            unavailable: true,
          }));
        reviewTokens += review.tokensOut;
        if (review.unavailable) {
          /*
           * No verdict is not a verdict. The fourth build's reviewer once came back empty,
           * and recording that as a review gave the next speaker a request for fixes with
           * no fixes in it. Nothing is recorded, so the gate still asks for a review, and
           * the screenshot's output says why there wasn't one.
           */
          log(`[${p.slug}] ${VISUAL_REVIEW} unavailable: ${review.notes}`);
          const shot = [...results].reverse().find((r) => /^screenshot\b/.test(r.command));
          if (shot) shot.output = `${shot.output}\nThe visual review could not run on this screenshot. Screenshot again to get one.`;
        } else {
          results.push({ command: VISUAL_REVIEW, ok: review.pass, output: review.notes });
          log(`[${p.slug}] ${VISUAL_REVIEW} — ${review.pass ? 'pass' : 'fixes requested'}`);
        }
      }
      // Compiled output and lockfiles are part of what was built; losing them would make
      // every subsequent turn start from source again.
      for (const [name, content] of Object.entries(remote.files ?? {})) {
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
      for (const file of files) known.add(file.name);
      const produced = Object.entries(remote.files ?? {})
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
          .catch((err: unknown) => log(`[${p.slug}] could not keep ${name}: ${describe(err)}`));
      }
    } else {
      for (const argv of commands) {
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


  /*
   * A close has to be earned. When the goal names a check, the thread stays open until a
   * run in it has passed that check. The turn still lands, and the floor goes to whoever
   * Nexus routes the ask to, which for building is the participant whose strength it is.
   */
  const history = [ran, ...runHistory(state)].filter((runs) => runs.length > 0);
  // Judged on the files as they stand after this turn, not on the last turn's.
  const current = [...built.filter((b) => !files.some((f) => f.name === b.name)), ...files];
  const pageChanged = pagesIn(files).length > 0 || files.some((f) => /\.css$/i.test(f.name) || /<style[\s>]/i.test(f.content));
  // What would keep the thread open if this turn closed it, judged whether or not it tries.
  const failing = refuseClose(state.goal, history);
  const unstyled = failing ? null : refuseUnstyled(state.goal, current);
  const unreviewed =
    failing || unstyled
      ? null
      : refuseUnreviewed(state.goal, current, ran.length > 0 ? history : [[], ...history], pageChanged);
  const blocker = failing ?? unstyled ?? unreviewed;
  // Asked only of a build that could otherwise close: an app's hour spent on a build the
  // builders know is broken is wasted. Not a blocker, so a hand to that app goes through.
  const skipped = blocker ? null : skippedStep(state.goal, state.participants, state.turns);
  const refused = reply.done ? (blocker ?? (skipped ? refuseSkipped(skipped) : null)) : null;
  const toApp = refused !== null && !blocker && skipped !== null ? skipped : null;
  const done = reply.done && !refused;
  /*
   * Named, not left to Nexus, whenever the build can't close yet and the turn didn't
   * name anyone itself. Routing on the refusal's wording sent "fix the failing tests" to
   * Perplexity (API) in the second product build. In the fourth, two turns that named
   * nobody went to Perplexity (API) while the tests or the review were still open, and
   * both times it re-confirmed the API and tried to close.
   */
  /*
   * Not to a chat app while the build is blocked, either. In the second aqi run GPT handed
   * the page to ChatGPT for its one review while the design review was still failing: a
   * review from an app that answers within the hour, spent on a page the builders already
   * knew was broken.
   */
  const handedEarly =
    !refused && Boolean(blocker) && Boolean(reply.next) &&
    state.participants.find((c) => c.slug === reply.next)?.answers_on_its_own === false;
  const held = refused ?? (handedEarly ? blocker : null);
  const wanted = toApp
    ? toApp
    : held || (blocker && !reply.next)
      ? builderFor(state.participants, p.slug, failing ? 'code' : 'design')
      : reply.next;
  /*
   * Never to someone known to be unable to answer. In the sixth product build the
   * builder ran out of credit, and each turn handed the thread back to it anyway; each
   * time it took three failures and a fifteen-minute rescue to move on.
   */
  const able = state.participants.filter((c) => c.slug !== p.slug && !down.includes(c.slug));
  const next =
    wanted && down.includes(wanted)
      ? (builderFor(able, p.slug, failing ? 'code' : 'design') ?? able[0]?.slug ?? null)
      : wanted;
  if (wanted && next !== wanted) {
    log(`[${p.slug}] handed to ${wanted}, which cannot answer right now; ${next ? `${next} gets it` : 'the floor is open'} instead`);
  }
  const ask = !held
    ? reply.ask
    : toApp
      ? `${refused} The build passes its tests and its design review. ${stepFor(state.goal, toApp) ?? 'Take the step the goal gives you, then hand on as it says.'}`
    : failing
      ? `${failing} Build what is missing, run the tests, and fix them until they pass.`
      : unstyled
        ? `${unstyled} Follow the design standard: explicit colors, a type scale, styled controls, and empty, loading and error states.`
        : `${unreviewed} Fix what the review found, then screenshot the page again in the same turn. Do not try to close again until a turn has changed a file and screenshotted it: a close attempt that changes nothing is a wasted turn.`;
  if (refused) log(`[${p.slug}] tried to close ${short(job.threadId)}. Kept open: ${refused}${toApp ? ` Handed to ${toApp}.` : ''}`);
  if (handedEarly) log(`[${p.slug}] handed ${short(job.threadId)} to ${reply.next} while it was blocked; kept with the builders: ${blocker}`);

  const appended = await p.call<{ seq: number; next: string | null; routedBy?: string }>('thread_append', {
    threadId: job.threadId,
    content: reply.content,
    summary: reply.summary,
    ...(next ? { next } : {}),
    ...(ask ? { ask: clipAsk(ask) } : {}),
    done,
    ...(ran.length > 0 ? { runs: ran } : {}),
    // Reported so "what did this thread cost" is answerable. Nexus never calls a model
    // and cannot measure this itself.
    tokensIn: generated.usage.input,
    tokensOut: generated.usage.output + reviewTokens,
  });

  /*
   * Two kinds of proposal never reach a person's review queue.
   *
   * Standups: they're about how the group works, and they filled the queue with hedged
   * notes on the standup process itself, one or two a day, with nothing durable in them.
   * A role that's wrong gets fixed with set_role, which needs no review.
   *
   * Anything over Nexus's 600-character limit: Nexus would refuse it anyway, and a
   * conclusion that long isn't one a person should have to read to approve.
   */
  if (reply.dropped.length > 0) {
    const names = reply.dropped.join(', ');
    log(`[${p.slug}] wrote more than ${MAX_FILES_PER_TURN} files. Not written: ${names}`);
    await p
      .call('thread_note', {
        threadId: job.threadId,
        content: `${p.slug} sent more than ${MAX_FILES_PER_TURN} files in one turn, so these were not written: ${names}. Write them in the next turn.`,
      })
      .catch(() => undefined);
  }

  if (reply.droppedRuns.length > 0) {
    const commands = reply.droppedRuns.join('; ');
    log(`[${p.slug}] asked for more than ${MAX_COMMANDS_PER_TURN} commands. Not run: ${commands}`);
    await p
      .call('thread_note', {
        threadId: job.threadId,
        content: `${p.slug} asked for more than ${MAX_COMMANDS_PER_TURN} commands in one turn, so these did not run: ${commands}. Run them in the next turn.`,
      })
      .catch(() => undefined);
  }

  // Nothing was written, and the next speaker would otherwise take the prose for a file.
  if (files.length === 0 && pastedFile(reply.content)) {
    log(`[${p.slug}] pasted a file into its turn instead of sending it in "files". Nothing was written.`);
    await p
      .call('thread_note', {
        threadId: job.threadId,
        content: `${p.slug} pasted a file into its turn instead of sending it in "files", so nothing was written. Whoever speaks next: write the file.`,
      })
      .catch(() => undefined);
  }

  if (applied.failed.length > 0) {
    const what = applied.failed.map((bad) => `${bad.name}: ${bad.reason}`).join('; ');
    await p
      .call('thread_note', {
        threadId: job.threadId,
        content: `${applied.failed.length} edit(s) from ${p.slug} could not be applied, so those files are unchanged: ${what}. Send the exact text as it appears in the file, or the whole file.`,
      })
      .catch(() => undefined);
  }

  if (wanted && next !== wanted) {
    await p
      .call('thread_note', {
        threadId: job.threadId,
        content: `${wanted} was handed the thread but is unable to answer right now, so ${next ? `it went to ${next}` : 'the floor is open'} instead.`,
      })
      .catch(() => undefined);
  }

  // Said in the thread, where the next speaker and the console both read it.
  if (refused) {
    await p
      .call('thread_note', { threadId: job.threadId, content: `Not closed yet. ${refused}` })
      .catch((err: unknown) => log(`[${p.slug}] could not note why the thread stayed open: ${describe(err)}`));
  }

  const proposal = done && reply.canon ? reply.canon : null;
  if (proposal && isStandupGoal(state.goal)) {
    log(`[${p.slug}] not proposing "${proposal.key}" to canon: standups don't propose canon`);
  } else if (proposal && needsPassingRun(state.goal)) {
    // A build's result is the product, and it's already in the thread's files. A canon
    // entry restating what was built is one more thing in a person's review queue.
    log(`[${p.slug}] not proposing "${proposal.key}" to canon: a build's result is its files`);
  } else if (proposal && (proposal.content.length > MAX_CANON || (proposal.rationale?.length ?? 0) > MAX_RATIONALE)) {
    log(`[${p.slug}] not proposing "${proposal.key}" to canon: longer than Nexus accepts`);
  } else if (done && reply.canon) {
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

  // Cache reads are shown so the prefix ordering can be checked against the bill.
  const cached = generated.usage.cacheRead ? `, ${generated.usage.cacheRead} cached` : '';
  const cost = `${generated.usage.input}→${generated.usage.output} tok${cached}`;
  const handoff = done
    ? 'closed the thread'
    : appended.next
      ? `→ ${appended.next}${appended.routedBy === 'nexus' ? ' (routed by Nexus)' : ''}`
      : '→ floor open';

  // Working again is as worth saying as failing was.
  await p.reportRecovered();

  log(
    `[${p.slug}] turn ${appended.seq} on ${short(job.threadId)}${job.volunteered ? ' (took an open floor)' : ''} ${handoff} (${cost})`,
  );
  return { taken: true, tokensOut: generated.usage.output + reviewTokens };
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

/** Delays before each retry of a provider that failed on its edge. */
export const RETRY_DELAYS_MS = [5_000, 15_000];

/**
 * Retries a model call that failed on the provider's edge (a 502 page, a dropped
 * connection) before the turn counts as failed.
 *
 * Perplexity (API) answered with HTTP 502 on four of seven attempts in one afternoon,
 * each a few seconds long. Every failure used to cost the participant its turn: the
 * thread passed to someone else, and the question it was best placed to answer got
 * answered from memory instead. Timeouts are not retried; a turn that already ran out
 * its clock would only run it out again.
 */
export async function withRetry<T>(
  log: Log,
  slug: string,
  call: () => Promise<T>,
  delays: number[] = RETRY_DELAYS_MS,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await call();
    } catch (err) {
      const transient = isFlintError(err) && err.error.kind === 'provider_unavailable';
      if (!transient || attempt >= delays.length) throw err;
      log(`[${slug}] provider unavailable, retrying in ${delays[attempt]! / 1000}s: ${describe(err)}`);
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
    }
  }
}

/**
 * Who fixes a build that can't close yet: the participant, other than the one who just
 * spoke, whose declared strength is closest to writing or reviewing code. Null when
 * nobody's is, which leaves routing to Nexus.
 */
export function builderFor(
  participants: Array<{ slug: string; good_at: string }>,
  author: string,
  focus: 'code' | 'design' = 'code',
): string | null {
  const terms =
    focus === 'design'
      ? /\b(interface|visual|ui|ux|typography|design)\b/gi
      : /\b(implement\w*|code|build\w*|review\w*|debug\w*|test\w*|schema\w*)\b/gi;
  const score = (goodAt: string) => (goodAt.match(terms) ?? []).length;
  const best = participants
    .filter((candidate) => candidate.slug !== author)
    .map((candidate) => ({ slug: candidate.slug, score: score(candidate.good_at) }))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score)[0];
  return best?.slug ?? null;
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
 * Whether the failure is the provider's rather than the thread's, and what kind.
 *
 * A rejected payload or a bad request will fail the same way for everyone, so passing
 * it on would only spread the failure. An unreachable or overloaded provider is
 * transient and specific to this participant. An account with no credit or a bad key
 * is specific to it too, and stays that way until a person acts.
 */
export function providerFault(err: unknown): 'transient' | 'account' | null {
  if (!isFlintError(err)) return null;
  const { kind } = err.error;
  if (kind === 'provider_unavailable' || kind === 'timeout' || kind === 'rate_limit') return 'transient';
  if (kind === 'validation' && /quota|billing|credit|api key/i.test(err.message)) return 'account';
  return null;
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
  /*
   * To someone who can answer, and for preference someone who builds. The first name in
   * the config used to get it whatever its state, so a thread could be passed from one
   * participant that was down to another.
   */
  const able = participants.filter((other) => other.slug !== job.participant.slug && !other.failing);
  const builder = builderFor(
    able.map((other) => ({ slug: other.slug, good_at: other.cfg.role ?? '' })),
    job.participant.slug,
  );
  const peer = able.find((other) => other.slug === builder) ?? able[0];
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
