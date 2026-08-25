import 'dotenv/config';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { parseConfig, type ResponderConfig } from './config.js';
import { Participant } from './participant.js';
import { describe, tick, type Limits } from './loop.js';

/**
 * `responder` — the half of Nexus that lets a thread advance without a human.
 *
 *   responder check     verify every participant's token and print who it is
 *   responder roles     publish each participant's declared strength to Nexus
 *   responder once      take one round of waiting turns and exit (cron-friendly)
 *   responder run       poll and keep taking turns until interrupted
 *
 * Config: $NEXUS_RESPONDER_CONFIG, or ~/.flint/nexus-responder.json.
 */

const DEFAULT_CONFIG = join(homedir(), '.flint', 'nexus-responder.json');

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
    process.stdout.write('responder <check|roles|once|run>\n');
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

      case 'once': {
        await runTick(participants, cfg, budgetFor(cfg));
        return;
      }

      case 'run': {
        await runForever(participants, cfg);
        return;
      }

      default:
        throw new Error(`Unknown command '${command}'. Try: check, roles, once, run.`);
    }
  } finally {
    await shutdown();
  }
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
      `${Number.isFinite(budget) ? `, ${budget} this run` : ''})`,
  );

  let idle = 0;
  while (!stopping && budget > 0) {
    const taken = await runTick(participants, cfg, budget).catch((err: unknown) => {
      log(`! round failed: ${describe(err)}`);
      return 0;
    });
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
