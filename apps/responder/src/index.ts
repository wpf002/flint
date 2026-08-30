import 'dotenv/config';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { parseConfig, resolveSecret, type ResponderConfig } from './config.js';
import { Participant } from './participant.js';
import { describe, tick, type Failures, type Limits } from './loop.js';
import { checkAll, publish } from './health.js';
import { SpendLedger, utcDay } from './spend.js';
import { exportWorkspace, workspaceFor } from './workspace.js';
import { dueToday, openStandup, promptFrom } from './standup.js';
import { beat, type Heartbeat } from './heartbeat.js';

/** Days since the epoch, for anything that should rotate daily rather than randomly. */
function dayIndex(today: string): number {
  return Math.floor(Date.parse(`${today}T00:00:00Z`) / 86_400_000);
}

/**
 * `responder` — the half of Nexus that lets a thread advance without a human.
 *
 *   responder open      start a thread that runs itself: open "<goal>" @slug "<ask>"
 *   responder read      print a thread's turns in full
 *   responder export    copy a thread's build out as an ordinary project
 *   responder spend     how many turns have been taken today
 *   responder once      take one round of waiting turns and exit (cron-friendly)
 *   responder run       poll and keep taking turns until interrupted
 *
 * Roles, health probes and the daily standup used to be commands here. They are not any
 * more: each is now something the loop does on its own schedule, because a capability you
 * have to remember to invoke is one that quietly stops happening. What is left are the
 * things a person actually asks for by hand.
 *
 * Config: $NEXUS_RESPONDER_CONFIG, or ~/.flint/nexus-responder.json.
 */

const DEFAULT_CONFIG = join(homedir(), '.flint', 'nexus-responder.json');
const SPEND_LEDGER = join(homedir(), '.flint', 'responder-spend.json');

/** One row per runner. A second machine would report under its own name. */
const RUNNER_NAME = 'responder';

/** How often health is re-probed while running. Cheap, and the answer changes slowly. */
const HEALTH_EVERY_MS = 30 * 60_000;

function ledgerState(ledger: SpendLedger, cfg: ResponderConfig): Heartbeat {
  return {
    turnsToday: ledger.spent,
    turnCap: cfg.maxTurnsPerDay,
    tokensToday: ledger.tokens,
    tokenCap: cfg.maxOutputTokensPerDay,
  };
}

/**
 * Today's standup.
 *
 * Left unfiled rather than put in a project: it is a conversation about how the group
 * works, not about any one piece of work, and filing it under whichever project happened
 * to be busiest would misfile it every time.
 *
 * The opener rotates by date, because a fixed one would make every standup a variation
 * on a single voice. Who is asked first is not rotated — it is whoever the numbers say
 * has been left out, and only the date's pick when nobody has.
 */
async function holdStandup(participants: Participant[], log: (line: string) => void): Promise<boolean> {
  const today = utcDay();
  const order = [...participants].sort((a, b) => a.slug.localeCompare(b.slug));
  // Rotated by date: whoever speaks first frames the question, and a fixed opener would
  // make every standup a variation on one voice.
  const day = dayIndex(today);
  const opener = order[day % order.length]!;
  const second = order[(day + 1) % order.length]!;

  const signal = await opener
    .call<{ silent: string[]; imbalance: number }>('participation', { days: 7 })
    .catch(() => ({ silent: [] as string[], imbalance: 0 }));

  const result = await openStandup(opener, today, signal.silent[0] ?? second.slug, promptFrom(today, signal));
  if (result.opened) {
    log(`standup ${result.threadId} opened by ${opener.slug}`);
    return true;
  }

  /*
   * A refusal because one is already open counts as held.
   *
   * Every standup goal differs only by its date, so Nexus's duplicate check treats
   * yesterday's — if it is still open — as the same goal and refuses today's. Treating
   * that as "not held" meant standups stopped for good the first time one stalled, and
   * the loop retried the same refusal every round until someone noticed.
   */
  if (result.why?.includes('already open')) {
    log(`standup not opened: one is already open. Treating today as held.`);
    return true;
  }

  log(`standup could not be opened: ${result.why ?? 'no reason given'}`);
  return false;
}

function log(line: string): void {
  process.stdout.write(`${stamp()} ${line}\n`);
}

function stamp(): string {
  return new Date().toISOString().slice(11, 19);
}

function loadConfig(): ResponderConfig {
  const path = process.env.NEXUS_RESPONDER_CONFIG?.trim() || DEFAULT_CONFIG;
  if (!existsSync(path)) {
    throw new Error(
      `No responder config at ${path}. Create one (see apps/responder/README.md) or set $NEXUS_RESPONDER_CONFIG.`,
    );
  }
  return parseConfig(JSON.parse(readFileSync(path, 'utf8')));
}

async function connectAll(cfg: ResponderConfig): Promise<Participant[]> {
  const connected: Participant[] = [];
  for (const p of cfg.participants) {
    try {
      const participant = await Participant.connect(p, cfg.nexusUrl);
      /*
       * Published on connect rather than by a command. Routing and every nomination read
       * these; a deployment that only ever ran `once` never published them, so they
       * stayed empty and the matching had nothing to work with.
       */
      await participant.publishRole().catch(() => {});
      connected.push(participant);
      log(`connected ${p.slug} (${p.provider}/${p.model})`);
    } catch (err) {
      // One bad token should not ground the others. The rest of the space still works.
      log(`could not connect ${p.slug}: ${describe(err)}`);
    }
  }
  if (connected.length === 0) throw new Error('No participants connected. Nothing to run.');
  return connected;
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'run';
  if (command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write('responder <open|read|export|spend|once|run>\n');
    return;
  }

  const cfg = loadConfig();
  const participants = await connectAll(cfg);

  const shutdown = async (): Promise<void> => {
    await Promise.all(participants.map((p) => p.close()));
  };

  try {
    switch (command) {
      case 'open': {
        const { goal, slug, ask } = parseOpen(process.argv.slice(3));
        // Opened as the first participant, because a thread needs an author like
        // anything else here and the responder holds no separate identity of its own.
        const opener = participants[0]!;
        /*
         * Self-running by default. A thread opened from here exists to be answered
         * without anyone relaying it, and a nomination of a browser-app client would
         * park it indefinitely while looking exactly like one that is working.
         */
        const thread = await opener.call<{ threadId: string; nextSpeaker: string | null }>('thread_open', {
          goal,
          selfRunning: true,
          ...(slug ? { firstSpeaker: slug } : {}),
          ...(ask ? { ask } : {}),
        });
        log(`opened ${thread.threadId} as ${opener.slug}, waiting on ${thread.nextSpeaker ?? 'anyone'}`);
        return;
      }

      case 'read': {
        const threadId = process.argv[3];
        if (!threadId) throw new Error('Usage: responder read <threadId>');
        const thread = await participants[0]!.call<{
          goal: string;
          status: string;
          yourTurnIf: string | null;
          turns: Array<{ seq: number; by: string; content?: string; summary?: string; asked?: string }>;
        }>('thread_read', { threadId, full: true });

        process.stdout.write(`\nGOAL: ${thread.goal}  [${thread.status}]\n`);
        for (const t of thread.turns) {
          process.stdout.write(`\n--- [${t.seq}] ${t.by} ---\n${t.content ?? t.summary ?? ''}\n`);
          if (t.asked) process.stdout.write(`  (asked next: ${t.asked})\n`);
        }
        process.stdout.write(`\nwaiting on: ${thread.yourTurnIf ?? 'anyone'}\n`);
        return;
      }

      case 'export': {
        const [threadId, ...rest] = process.argv.slice(3);
        if (!threadId) throw new Error('Usage: responder export <threadId> [destination]');
        if (!cfg.workspaceRoot) throw new Error('No workspaceRoot is set, so nothing has been built on disk.');

        const from = workspaceFor(cfg.workspaceRoot, threadId);
        // Named after the thread's goal rather than its id, because the directory is the
        // product now and an id is not a name anyone wants to keep.
        const fallback = join(process.cwd(), `nexus-${threadId.slice(0, 8)}`);
        const result = await exportWorkspace(from, rest.join(' ') || fallback);

        log(`copied ${result.files} file${result.files === 1 ? '' : 's'} to ${result.destination}`);
        log('node_modules was left behind: reinstall it wherever this is going.');
        return;
      }

      case 'once': {
        const ledger = SpendLedger.open(SPEND_LEDGER, cfg.maxTurnsPerDay, cfg.maxOutputTokensPerDay);
        if (ledger.remaining() <= 0) {
          log(
            ledger.tokensSpent
              ? `daily budget spent (${ledger.tokens.toLocaleString()} output tokens). Nothing taken.`
              : `daily turn cap reached (${ledger.spent}/${cfg.maxTurnsPerDay}). Nothing taken.`,
          );
          return;
        }
        /*
         * The same upkeep `run` does on a clock, done once. A cron-driven Nexus should
         * not be a Nexus that never holds a standup and always looks unattended.
         */
        const known = await beat(participants[0]!, RUNNER_NAME, ledgerState(ledger, cfg));
        let standupDay: string | undefined;
        if (dueToday(utcDay(), known?.lastStandupDay ?? null) && (await holdStandup(participants, log))) {
          standupDay = utcDay();
        }

        const round = await runRound(participants, cfg, Math.min(budgetFor(cfg), ledger.remaining()));
        ledger.record(round.turnsTaken, round.tokensOut);
        await beat(participants[0]!, RUNNER_NAME, ledgerState(ledger, cfg), standupDay);
        return;
      }

      case 'run': {
        await runForever(participants, cfg);
        return;
      }

      case 'spend': {
        const ledger = SpendLedger.open(SPEND_LEDGER, cfg.maxTurnsPerDay, cfg.maxOutputTokensPerDay);
        log(
          ledger.limited
            ? `today: ${ledger.tokens.toLocaleString()} of ${cfg.maxOutputTokensPerDay.toLocaleString()} output tokens, ${ledger.spent} of ${cfg.maxTurnsPerDay} turns`
            : `today: ${ledger.tokens.toLocaleString()} output tokens across ${ledger.spent} turns; no daily cap set`,
        );
        return;
      }

      default:
        throw new Error(
          `Unknown command '${command}'. Try: open, read, export, spend, once, run.`,
        );
    }
  } finally {
    await shutdown();
  }
}

/**
 * `open "<goal>" @slug "<ask>"` — the same shape the Nexus console uses, so the two
 * ways of starting a thread do not need separate syntax in your head.
 */
function parseOpen(args: string[]): { goal: string; slug?: string; ask?: string } {
  const joined = args.join(' ').trim();
  if (joined.length === 0) throw new Error('Usage: responder open "<goal>" @slug "<what you need from them>"');

  const at = joined.indexOf('@');
  if (at === -1) return { goal: strip(joined) };

  const rest = joined.slice(at + 1).trimStart();
  const gap = rest.search(/\s/);
  const ask = gap === -1 ? '' : strip(rest.slice(gap));
  return {
    goal: strip(joined.slice(0, at)),
    slug: gap === -1 ? rest : rest.slice(0, gap),
    ...(ask ? { ask } : {}),
  };
}

/** Drops the quotes a shell already removed, for anyone who quoted twice. */
function strip(value: string): string {
  const trimmed = value.trim();
  return /^(".*"|'.*')$/s.test(trimmed) ? trimmed.slice(1, -1) : trimmed;
}

function budgetFor(cfg: ResponderConfig): number {
  return cfg.maxTurnsPerRun > 0 ? cfg.maxTurnsPerRun : Number.POSITIVE_INFINITY;
}

/** Carried across rounds so a thread that keeps failing is rested, not hammered. */
const failures: Failures = new Map();

async function runRound(
  participants: Participant[],
  cfg: ResponderConfig,
  runBudget: number,
): Promise<{ turnsTaken: number; tokensOut: number }> {
  const limits: Limits = {
    maxTurnsPerTick: cfg.maxTurnsPerTick,
    maxTurnsPerThread: cfg.maxTurnsPerThread,
    runBudget,
    turnTimeoutMs: cfg.turnTimeoutMs,
    ...(cfg.workspaceRoot ? { workspaceRoot: cfg.workspaceRoot } : {}),
    canRun: cfg.canRun,
    ...(cfg.sandboxUrl && cfg.sandboxToken
      ? {
          sandbox: {
            url: cfg.sandboxUrl,
            token: resolveSecret(cfg.sandboxToken, 'sandboxToken'),
          },
        }
      : {}),
  };
  const result = await tick(participants, limits, log, failures);
  for (const err of result.errors) log(`! ${err}`);
  return { turnsTaken: result.turnsTaken, tokensOut: result.tokensOut };
}

async function runForever(participants: Participant[], cfg: ResponderConfig): Promise<void> {
  let budget = budgetFor(cfg);
  const ledger = SpendLedger.open(SPEND_LEDGER, cfg.maxTurnsPerDay, cfg.maxOutputTokensPerDay);
  let stopping = false;
  /*
   * What Nexus remembers about this runner. Read once at the start rather than assumed,
   * so a restart does not repeat a standup that already happened today.
   */
  let lastStandup = (await beat(participants[0]!, RUNNER_NAME, ledgerState(ledger, cfg)))?.lastStandupDay ?? null;
  let lastHealthAt = 0;

  const stop = (): void => {
    if (stopping) process.exit(1); // a second interrupt means "now"
    stopping = true;
    log('stopping after the current round…');
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  log(
    `watching ${participants.length} participant${participants.length === 1 ? '' : 's'} every ${cfg.pollMs / 1000}s ` +
      `(max ${cfg.maxTurnsPerTick} turns/round, ${cfg.maxTurnsPerThread}/thread` +
      `${ledger.limited ? `, ${Math.round(ledger.tokensRemaining() / 1000)}k tokens left today` : ''}` +
      `${Number.isFinite(budget) ? `, ${budget} this run` : ''})`,
  );

  let idle = 0;
  let capped = false;
  while (!stopping && budget > 0) {
    // Checked each round rather than once at the top, because a supervised process can
    // outlive the day it started in.
    ledger.rollover();
    if (ledger.remaining() <= 0) {
      if (!capped) {
        log(
          ledger.tokensSpent
            ? `daily budget spent (${ledger.tokens.toLocaleString()} output tokens). Idling until tomorrow.`
            : `daily turn cap reached (${ledger.spent}/${cfg.maxTurnsPerDay}). Idling until tomorrow.`,
        );
        capped = true;
      }
      await sleep(cfg.pollMs * 4, () => stopping);
      continue;
    }
    capped = false;

    const allowed = Math.min(budget, ledger.remaining());
    /*
     * Everything that used to be a command you had to remember, on a clock instead.
     * A capability you have to invoke is one that silently stops happening.
     */
    if (Date.now() - lastHealthAt > HEALTH_EVERY_MS) {
      lastHealthAt = Date.now();
      for (const check of await checkAll(participants)) {
        await publish(participants.find((p) => p.slug === check.slug)!, check);
      }
    }

    if (dueToday(utcDay(), lastStandup)) {
      // Marked held whether it was opened or refused as a duplicate: one already open is
      // one that happened. Retrying it every fifteen seconds for the rest of the day
      // would spend a round on a refusal that is never going to change its mind.
      if (await holdStandup(participants, log)) lastStandup = utcDay();
    }

    const startedAt = Date.now();
    const round = await runRound(participants, cfg, allowed).catch((err: unknown) => {
      log(`! round failed: ${describe(err)}`);
      return { turnsTaken: 0, tokensOut: 0 };
    });
    const taken = round.turnsTaken;

    /*
     * A quiet loop and a stalled one look identical from the outside, because an idle
     * round prints nothing. A round that took far longer than it should is worth
     * saying out loud — it is the only symptom a hang has.
     */
    const elapsed = Date.now() - startedAt;
    if (elapsed > cfg.turnTimeoutMs) {
      log(`round took ${Math.round(elapsed / 1000)}s, which is longer than a turn is allowed`);
    }
    ledger.record(taken, round.tokensOut);
    budget -= taken;

    // Said every round, so "nothing is driving Nexus" means exactly that.
    await beat(participants[0]!, RUNNER_NAME, ledgerState(ledger, cfg), lastStandup ?? undefined);

    // Back off while nothing is happening so an idle space costs almost nothing,
    // and snap back to the configured cadence the moment work appears.
    idle = taken > 0 ? 0 : Math.min(idle + 1, 4);
    const wait = cfg.pollMs * (idle === 0 ? 1 : 1 + idle);
    if (!stopping && budget > 0) await sleep(wait, () => stopping);
  }

  if (budget <= 0) log('run budget spent; stopping.');
}

/** Sleeps in short slices so an interrupt is felt immediately, not a poll later. */
async function sleep(ms: number, cancelled: () => boolean): Promise<void> {
  const slice = 250;
  for (let waited = 0; waited < ms; waited += slice) {
    if (cancelled()) return;
    await new Promise((resolve) => setTimeout(resolve, Math.min(slice, ms - waited)));
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`responder: ${describe(err)}\n`);
  process.exit(1);
});
