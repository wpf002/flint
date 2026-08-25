import 'dotenv/config';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { parseConfig, type ResponderConfig } from './config.js';
import { Participant } from './participant.js';
import { describe, tick, type Limits } from './loop.js';
import { checkAll, publish } from './health.js';
import { SpendLedger } from './spend.js';

/**
 * `responder` — the half of Nexus that lets a thread advance without a human.
 *
 *   responder check     verify every participant's token and print who it is
 *   responder roles     publish each participant's declared strength to Nexus
 *   responder open      start a thread that runs itself: open "<goal>" @slug "<ask>"
 *   responder read      print a thread's turns in full
 *   responder health    probe every token and model key, report the result to Nexus
 *   responder spend     how many turns have been taken today
 *   responder once      take one round of waiting turns and exit (cron-friendly)
 *   responder run       poll and keep taking turns until interrupted
 *
 * Config: $NEXUS_RESPONDER_CONFIG, or ~/.flint/nexus-responder.json.
 */

const DEFAULT_CONFIG = join(homedir(), '.flint', 'nexus-responder.json');
const SPEND_LEDGER = join(homedir(), '.flint', 'responder-spend.json');

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
      connected.push(await Participant.connect(p, cfg.nexusUrl));
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
    process.stdout.write('responder <check|roles|open|read|health|spend|once|run>\n');
    return;
  }

  const cfg = loadConfig();
  const participants = await connectAll(cfg);

  const shutdown = async (): Promise<void> => {
    await Promise.all(participants.map((p) => p.close()));
  };

  try {
    switch (command) {
      case 'check': {
        for (const p of participants) {
          const who = await p.call<{ namespace?: string; label?: string }>('whoami');
          log(`${p.slug} → ${who.label ?? who.namespace ?? 'unknown'} (${p.cfg.provider}/${p.cfg.model})`);
        }
        return;
      }

      case 'roles': {
        for (const p of participants) {
          if (!p.cfg.role) {
            log(`${p.slug} has no role configured; skipping`);
            continue;
          }
          await p.publishRole();
          log(`${p.slug} role published`);
        }
        return;
      }

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

      case 'health': {
        const checks = await checkAll(participants);
        for (const c of checks) {
          await publish(participants.find((p) => p.slug === c.slug)!, c);
          const ok = c.nexus && c.model;
          log(`${ok ? 'ok  ' : 'FAIL'} ${c.slug}  nexus=${c.nexus ? 'ok' : 'down'} model=${c.model ? 'ok' : 'down'}${c.note ? `  ${c.note}` : ''}`);
        }
        // Non-zero on failure so a scheduler, a CI step or a shell `&&` can act on it
        // without parsing this output.
        const broken = checks.filter((c) => !(c.nexus && c.model));
        if (broken.length > 0) {
          process.exitCode = 1;
          log(`${broken.length} participant${broken.length === 1 ? '' : 's'} cannot take a turn: ${broken.map((c) => c.slug).join(', ')}`);
        }
        return;
      }

      case 'once': {
        const ledger = SpendLedger.open(SPEND_LEDGER, cfg.maxTurnsPerDay);
        if (ledger.remaining() <= 0) {
          log(`daily cap reached (${ledger.spent}/${cfg.maxTurnsPerDay} turns). Nothing taken.`);
          return;
        }
        const taken = await runTick(participants, cfg, Math.min(budgetFor(cfg), ledger.remaining()));
        ledger.record(taken);
        return;
      }

      case 'run': {
        await runForever(participants, cfg);
        return;
      }

      case 'spend': {
        const ledger = SpendLedger.open(SPEND_LEDGER, cfg.maxTurnsPerDay);
        log(
          ledger.limited
            ? `${ledger.spent} of ${cfg.maxTurnsPerDay} turns taken today; ${ledger.remaining()} left`
            : `${ledger.spent} turns taken today; no daily cap set`,
        );
        return;
      }

      default:
        throw new Error(`Unknown command '${command}'. Try: check, roles, open, read, health, spend, once, run.`);
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

async function runTick(participants: Participant[], cfg: ResponderConfig, runBudget: number): Promise<number> {
  const limits: Limits = {
    maxTurnsPerTick: cfg.maxTurnsPerTick,
    maxTurnsPerThread: cfg.maxTurnsPerThread,
    runBudget,
  };
  const result = await tick(participants, limits, log);
  for (const err of result.errors) log(`! ${err}`);
  return result.turnsTaken;
}

async function runForever(participants: Participant[], cfg: ResponderConfig): Promise<void> {
  let budget = budgetFor(cfg);
  const ledger = SpendLedger.open(SPEND_LEDGER, cfg.maxTurnsPerDay);
  let stopping = false;

  const stop = (): void => {
    if (stopping) process.exit(1); // a second interrupt means "now"
    stopping = true;
    log('stopping after the current round…');
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  // Roles first: routing and nominations both read them, and an unpublished role
  // makes a participant invisible to the others' judgement.
  for (const p of participants) {
    await p.publishRole().catch((err: unknown) => log(`! ${p.slug} role: ${describe(err)}`));
  }

  log(
    `watching ${participants.length} participant${participants.length === 1 ? '' : 's'} every ${cfg.pollMs / 1000}s ` +
      `(max ${cfg.maxTurnsPerTick} turns/round, ${cfg.maxTurnsPerThread}/thread` +
      `${ledger.limited ? `, ${ledger.remaining()} left today` : ''}` +
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
        log(`daily cap reached (${ledger.spent}/${cfg.maxTurnsPerDay} turns). Idling until tomorrow.`);
        capped = true;
      }
      await sleep(cfg.pollMs * 4, () => stopping);
      continue;
    }
    capped = false;

    const allowed = Math.min(budget, ledger.remaining());
    const taken = await runTick(participants, cfg, allowed).catch((err: unknown) => {
      log(`! round failed: ${describe(err)}`);
      return 0;
    });
    ledger.record(taken);
    budget -= taken;

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
