/**
 * The restore commands (P7), as Will and the rebuild script run them:
 *
 *   pnpm --silent --filter @flint/runtime restore-production [--dump <file>] [--without-copy] [--without-fingerprint]
 *       Replace the production database with a nightly backup. Will runs it in
 *       Terminal, reads what will be in force afterwards, and types RESTORE. It
 *       is the action `restore.production`: APPROVAL in code, never promoted,
 *       forbidden to Flint on its own, and forbidden outright by a policy row of
 *       Will's that says so. It cannot wait on an approval card: the cards live
 *       in the database it replaces.
 *   ... restore-production --check [--dump <file>]
 *       A trial run: restore the backup beside the database in use, run every
 *       check, drop the copy, and say how long it took. Nothing in use changes.
 *   ... restore-production --repair
 *       Put right what a restore that was stopped part-way left behind.
 *   ... restore-empty --from-rebuild --dump <file> [--sha256 <fingerprint>]
 *       A rebuilt Mac: restore into the EMPTY database the rebuild just made.
 *       Only apps/studio/rebuild.sh runs this; it asks no one, so it says so in
 *       the audit trail, and it is refused if the database holds anything.
 *
 * Asking at a terminal stops an accident (a script, a pipe, a job). It does not
 * stop someone who sets out to answer for Will: a program can run this under a
 * pseudo-terminal and type the word. What that someone could do is bounded by
 * what the command itself refuses, not by the prompt.
 *
 * Every line printed is a sentence for Will. No URL, password or file content
 * is ever printed.
 */
import { execFile, spawn } from 'node:child_process';
import { appendFileSync, existsSync, lstatSync, readdirSync, readlinkSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { resolveTier, type PolicyRow } from '@flint/policy';
import type { RestoreConfig } from '../config.js';
import { client, targetOf } from './backup.js';
import { carryLines, type CarryReport } from './carry.js';
import { KEEP_DAYS, REPAIR, RestoreRefused, compareDatabase, repairDatabase, restoreDatabase, type RestoreOptions, type RestoreSummary } from './restore.js';

/** apps/runtime, whichever directory the command was started from. */
const RUNTIME_DIR = fileURLToPath(new URL('../../', import.meta.url));
const MIGRATIONS = join(RUNTIME_DIR, 'prisma', 'migrations');
const LABEL = 'com.flint.runtime';
const LAUNCHCTL = '/bin/launchctl';
const PGREP = '/usr/bin/pgrep';

export type Exec = (bin: string, args: string[]) => Promise<string>;
/**
 * Run a program with fixed arguments. launchctl, and the look at what else is
 * running on this Mac, happen only where the config says they may: a test, or
 * anything else that builds its own config, can never reach the real launchd,
 * and is never stopped by an update that happens to be installing on the Mac
 * the tests run on (the deploy gate runs them from inside one).
 */
/** launchctl and pgrep are not run where the config says they may not be: the answer is "cannot tell", never "not there". */
export class NotRunHere extends Error {}
export const execFor = (machine: boolean): Exec => (bin, args) =>
  (bin === LAUNCHCTL || bin === PGREP) && !machine
    ? Promise.reject(new NotRunHere(`${bin === LAUNCHCTL ? 'launchctl' : 'pgrep'} is not run here`))
    : new Promise((resolveP, reject) => execFile(bin, args, { timeout: 30_000 }, (err, stdout) => (err ? reject(err) : resolveP(String(stdout)))));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** launchd waits up to the agent's ExitTimeOut (30 s) before it kills a job that will not stop; this waits a little longer than that. */
const STOP_WAIT_MS = 45_000;
/** How long a started runtime has to be seen running, and to stay running. */
const START_WAIT_MS = 30_000;

/**
 * Stopping and starting the runtime's LaunchAgent, with fixed arguments (no
 * string is ever built into a command). `stop` returns once launchd has let go
 * of it. `start` returns only once the job is really running (launchd says so,
 * with a process id, twice in a row): loaded is not running.
 */
export function runtimeAgent(home: string, uid: number, exec: Exec, wait: (ms: number) => Promise<void> = sleep) {
  const target = `gui/${uid}`;
  const plist = join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
  /** undefined: not loaded. Otherwise whether launchd reports it running, with a process. */
  const state = (): Promise<{ running: boolean } | undefined> =>
    exec(LAUNCHCTL, ['print', `${target}/${LABEL}`]).then((out) => ({ running: /^\s*state = running\s*$/m.test(out) && /^\s*pid = \d+\s*$/m.test(out) }), () => undefined);
  return {
    /** The command that starts it by hand, for when this could not. */
    startCommand: `  launchctl bootstrap ${target} ~/Library/LaunchAgents/${LABEL}.plist`,
    /** Is the runtime down? True: launchd says it is not loaded, or loaded and not running. Undefined: launchd could not be asked. */
    async down(): Promise<boolean | undefined> {
      try {
        const out = await exec(LAUNCHCTL, ['print', `${target}/${LABEL}`]);
        return !(/^\s*state = running\s*$/m.test(out) && /^\s*pid = \d+\s*$/m.test(out));
      } catch (err) {
        return err instanceof NotRunHere ? undefined : true;
      }
    },
    async stop(): Promise<void> {
      if (!(await state())) return;
      await exec(LAUNCHCTL, ['bootout', `${target}/${LABEL}`]).catch(() => undefined);
      for (let waited = 0; waited <= STOP_WAIT_MS; waited += 250) {
        if (!(await state())) return;
        await wait(250);
      }
      throw new RestoreRefused('The runtime did not stop, so Flint did not swap the databases.', { stage: 'runtime' });
    },
    async start(): Promise<void> {
      let now = await state();
      if (!now) {
        if (!existsSync(plist)) throw new Error("the runtime's LaunchAgent file is missing");
        let last: unknown;
        for (let i = 0; i < 5 && !now; i++) {
          try {
            await exec(LAUNCHCTL, ['bootstrap', target, plist]);
          } catch (err) {
            // launchd can refuse for a moment after a bootout.
            last = err;
            await wait(2000);
          }
          now = await state();
        }
        if (!now) throw last instanceof Error ? last : new Error('launchctl bootstrap failed');
      } else if (!now.running) {
        await exec(LAUNCHCTL, ['kickstart', `${target}/${LABEL}`]).catch(() => undefined);
      }
      let seen = 0;
      for (let waited = 0; waited <= START_WAIT_MS; waited += 1000) {
        seen = (await state())?.running ? seen + 1 : 0;
        if (seen >= 2) return;
        await wait(1000);
      }
      throw new Error('the runtime did not stay running');
    },
  };
}

/** `prisma migrate deploy` against `ownerUrl`; the URL goes through the environment, never argv. */
function migrateDeploy(ownerUrl: string, home: string, path: string): Promise<void> {
  return new Promise((resolveP, reject) => {
    const child = spawn(join(RUNTIME_DIR, 'node_modules', '.bin', 'prisma'), ['migrate', 'deploy'], {
      cwd: RUNTIME_DIR,
      env: { PATH: path, HOME: home, DATABASE_URL: ownerUrl, PRISMA_HIDE_UPDATE_MESSAGE: '1' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let err = '';
    child.stderr.on('data', (d) => (err = (err + d).slice(-2000)));
    child.on('error', reject);
    // Prisma's error code and nothing else of what it printed: its message can quote a row.
    child.on('close', (code) => (code === 0 ? resolveP() : reject(new Error(`a database update failed${/\b(P\d{4})\b/.exec(err)?.[1] ? ` (${/\b(P\d{4})\b/.exec(err)![1]})` : ''}`))));
  });
}

/** The nightly dumps in `dir`, newest first. */
function dumpsNewestFirst(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => /^flint-.*\.dump$/.test(f)).sort().reverse().map((f) => join(dir, f));
}

/**
 * A database update that is waiting, or that failed: the checkout holds a
 * migration the live runtime release was not built with. Restoring now would
 * apply it to the restored copy, which is not Will's call to make by accident.
 */
async function updateWaiting(home: string, exec: Exec): Promise<boolean> {
  let live: string;
  try {
    live = basename(readlinkSync(join(home, '.flint', 'runtime', 'current')));
  } catch {
    return false; // No release yet (a rebuild in progress): nothing to compare with.
  }
  if (!/^[0-9a-f]{40}$/.test(live)) return false;
  try {
    const head = (await exec('git', ['-C', RUNTIME_DIR, 'rev-parse', 'HEAD'])).trim();
    if (head === live) return false;
    const changed = await exec('git', ['-C', RUNTIME_DIR, 'diff', '--name-only', live, head, '--', 'prisma/migrations']);
    return changed.trim() !== '';
  } catch {
    return true; // Cannot tell: say so and stop, never guess.
  }
}

/**
 * Is an update being installed right now? The deploy job and the two installers are looked for by
 * name, as apps/studio/rollback.sh does. Together with the pause this restore puts on updates
 * before it asks (the deploy job looks for the pause before it does anything), a deploy and a
 * restore cannot run across each other: whichever started second sees the first.
 */
async function deployRunning(exec: Exec): Promise<boolean> {
  return exec(PGREP, ['-f', 'auto_deploy\\.sh|install-server\\.sh|install-runtime\\.sh']).then((out) => out.trim() !== '', () => false);
}

/** One line to the local record of restores (0600, appended): what was tried and how it ended. Never a secret, never a row. */
function recorder(file: string): NonNullable<RestoreOptions['record']> {
  return (entry) => {
    try {
      if (existsSync(file)) {
        const st = lstatSync(file);
        if (!st.isFile() || st.uid !== process.getuid?.()) return;
      }
      appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, { mode: 0o600 });
    } catch {
      // A record that cannot be written never stops a restore.
    }
  };
}

const ago = (from: Date, now: Date): string => {
  const hours = Math.max(0, Math.round((now.getTime() - from.getTime()) / 3_600_000));
  if (hours < 1) return 'less than an hour old';
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'} old`;
  const days = Math.round(hours / 24);
  return `${days} days old`;
};

export interface RestoreIo {
  say(line: string): void;
  /** Ask Will a question on the terminal; undefined when there is no one at a keyboard. */
  ask?(question: string): Promise<string>;
  exec?: Exec;
  uid: number;
  now?: Date;
  /** How the process hears that it is asked to stop (SIGINT, SIGTERM, SIGHUP), and how it ends. */
  onSignal?: RestoreOptions['onSignal'];
  exit?: RestoreOptions['exit'];
}

/** The words Will reads before he types RESTORE. */
export function summaryLines(s: RestoreSummary, tz: string, now: Date): string[] {
  const when = s.takenAt.toLocaleString('en-US', { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  return [
    `The backup is from ${when}. It is ${ago(s.takenAt, now)}.`,
    s.fingerprint === 'matches'
      ? `It holds ${s.tables} tables, and it is unchanged since it was made.`
      : `It holds ${s.tables} tables. No fingerprint was recorded for it, so Flint cannot tell whether it was changed after it was made.`,
    `Restoring it replaces Flint's database with that backup. Everything Flint recorded after it is left out.`,
    `The database in use now is kept under the name ${s.keptAs}, closed. Nothing of it is deleted.`,
    ...(s.removing.length ? [`Kept from restores more than ${KEEP_DAYS} days ago, and removed by this one: ${s.removing.join(', ')}.`] : []),
    ...carryLines(s.report, tz, 'production'),
  ];
}

/** Will's own policy rows from the database in use, when it can still be read: a row that forbids the restore is honoured. */
async function policies(ownerUrl: string): Promise<PolicyRow[] | undefined> {
  const c = client(targetOf(ownerUrl));
  try {
    await c.connect();
    const r = await c.query<{ pattern: string; tier: PolicyRow['tier']; dailyCap: number | null; scope: unknown; active: boolean; expiresAt: Date }>(
      `SELECT pattern, tier, "dailyCap", scope, active, "expiresAt" FROM public."ActionPolicy" WHERE active AND "expiresAt" > now()`,
    );
    return r.rows;
  } catch {
    return undefined;
  } finally {
    await c.end().catch(() => {});
  }
}

const OPTIONS = 'The only options are --dump followed by a backup file, --without-copy, --without-fingerprint, --check, --compare, and --repair.';
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

function sayReport(io: RestoreIo, r: CarryReport, tz: string, mode: 'production' | 'rebuild'): void {
  for (const line of carryLines(r, tz, mode)) io.say(line);
}

/** What a refusal says after its sentence: its own lines, then how to start the runtime when it was left stopped. */
export function refusalLines(err: RestoreRefused, startCommand: string): string[] {
  return [err.message, ...err.lines, ...(err.runtimeDown ? ['The runtime did not start again by itself. Start it with this command:', startCommand] : [])];
}

export async function restoreProductionCommand(argv: string[], config: RestoreConfig, io: RestoreIo): Promise<void> {
  const now = io.now ?? new Date();
  const exec = io.exec ?? execFor(config.launchctl);
  if (argv.includes('--auto')) throw new RestoreRefused('Flint never restores its database on its own. Run this yourself in Terminal.', { stage: 'tier' });
  let chosen: string | undefined;
  let withoutCopy = false;
  let withoutFingerprint = false;
  let checkOnly = false;
  let repair = false;
  let compare = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = argv[i + 1];
    if (a === '--without-copy') withoutCopy = true;
    else if (a === '--without-fingerprint') withoutFingerprint = true;
    else if (a === '--check') checkOnly = true;
    else if (a === '--repair') repair = true;
    else if (a === '--compare') compare = true;
    else if (a === '--dump' && next && !next.startsWith('--')) chosen = argv[++i];
    else throw new RestoreRefused(OPTIONS, { stage: 'options' });
  }
  if (repair && argv.length > 1) throw new RestoreRefused('--repair takes no other option.', { stage: 'options' });
  if (compare && argv.length > 1) throw new RestoreRefused('--compare takes no other option.', { stage: 'options' });
  // Reading only: how the database in use differs from what this copy of Flint builds. It needs no backup, restores
  // nothing, asks nothing, and so needs no one at a keyboard. When a restore would refuse a backup of it, it ends as a refusal.
  if (compare) {
    const r = await compareDatabase({
      owner: config.ownerUrl, restore: config.restoreUrl, tools: config.tools, migrationsDir: MIGRATIONS, say: io.say, ...(io.now ? { now: io.now } : {}),
      // Ctrl-C, a closed window or a kill: it removes the scratch database it made, and only then ends.
      ...(io.onSignal ? { onSignal: io.onSignal } : {}), ...(io.exit ? { exit: io.exit } : {}),
    });
    // The last word counts only what would stop a restore: the rest of what was said stops nothing.
    if (!r.same || r.stops > 0) throw new RestoreRefused(`${r.verdict} Nothing was changed.`, { stage: 'compare' });
    return;
  }
  const agent = runtimeAgent(config.home, io.uid, exec);
  const ask = io.ask;

  if (repair) {
    if (!ask) throw new RestoreRefused('Run this yourself in Terminal.', { stage: 'terminal' });
    const r = await repairDatabase({
      owner: config.ownerUrl,
      confirm: async (kept) => (await ask(`Type REPAIR to give ${kept} the name ${targetOf(config.ownerUrl).database} back: `)).trim() === 'REPAIR',
      startRuntime: () => agent.start(),
      say: io.say,
    });
    if (!r.runtimeStarted) {
      io.say('The runtime did not start by itself. Start it with this command:');
      io.say(agent.startCommand);
    } else io.say('The runtime is running.');
    return;
  }

  // The tier engine's answer for Will at the console, with his own policy rows when the database can still give them:
  // a row of his that forbids this is honoured. Anything that is not a person at a terminal is not offered it at all.
  const rows = await policies(config.ownerUrl);
  const tier = resolveTier('restore.production', { context: 'console', tainted: false, ...(rows ? { policies: rows } : {}), now });
  if (tier.tier === 'forbidden') {
    throw new RestoreRefused('One of your own rules forbids restoring the database. Switch that rule off in the console first.', { stage: 'tier' });
  }
  // A real restore is confirmed at the keyboard. A trial run changes nothing in use and asks nothing.
  if (!checkOnly && !ask) throw new RestoreRefused('Run this yourself in Terminal: it asks you to confirm before it changes anything.', { stage: 'terminal' });

  if (!checkOnly && (await updateWaiting(config.home, exec))) {
    throw new RestoreRefused('A database update is waiting or did not finish, and restoring now could apply it. Nothing was changed.', {
      stage: 'deploy', lines: ['Let the update finish, or pause updates and put the earlier version back first (docs/RECOVERY.md says how).'],
    });
  }

  // A restore that was killed outright after it stopped the runtime could not start it again, and nothing else says
  // so: the database is restored and in use, and Flint is simply not running. Said here, with what starts it.
  if (await agent.down()) {
    io.say('The runtime is not running. If an earlier restore was stopped part-way, this command starts it and puts right anything else that restore left:');
    io.say(REPAIR);
  }

  // The chosen backup (always one in Flint's own backup folder), or the newest there.
  let candidates: string[];
  if (chosen) {
    const dump = resolve(config.dumpDir, chosen);
    if (!dump.startsWith(`${config.dumpDir}/`)) throw new RestoreRefused('Flint restores only the nightly backups in its own backup folder.', { stage: 'dump' });
    candidates = [dump];
  } else {
    candidates = dumpsNewestFirst(config.dumpDir);
    if (!candidates.length) throw new RestoreRefused('There is no backup to restore from. Nothing was changed.', { stage: 'dump' });
  }

  const options = (dump: string): RestoreOptions => ({
    mode: 'production',
    dump,
    owner: config.ownerUrl,
    app: config.appUrl,
    restore: config.restoreUrl,
    ...(config.backupUrl ? { backup: config.backupUrl } : {}),
    copyDir: config.copyDir,
    withoutCopy,
    withoutFingerprint,
    checkOnly,
    keyFile: config.fingerprintKey,
    tools: config.tools,
    migrationsDir: MIGRATIONS,
    migrate: (url) => migrateDeploy(url, config.home, config.path),
    confirm: async (summary) => {
      for (const line of summaryLines(summary, config.tz, now)) io.say(line);
      return ((await ask?.('Type RESTORE to continue: ')) ?? '').trim() === 'RESTORE';
    },
    stopRuntime: () => agent.stop(),
    startRuntime: () => agent.start(),
    ...(config.rp ? { rp: config.rp } : {}),
    say: io.say,
    ...(io.now ? { now: io.now } : {}),
    holdFile: config.holdFile,
    deployRunning: () => deployRunning(exec),
    ...(config.dataDir ? { dataDir: config.dataDir } : {}),
    ...(io.onSignal ? { onSignal: io.onSignal } : {}),
    ...(io.exit ? { exit: io.exit } : {}),
    record: recorder(config.recordFile),
  });

  // With no backup named, the newest that is a whole, untouched dump: one that fails its own checks is passed over, and said.
  let result;
  for (const [i, dump] of candidates.entries()) {
    try {
      result = await restoreDatabase(options(dump));
      break;
    } catch (err) {
      const passable = err instanceof RestoreRefused && (err.stage === 'dump' || err.stage === 'fingerprint') && !chosen && i < candidates.length - 1;
      if (!passable) {
        if (err instanceof RestoreRefused && err.runtimeDown) throw new RestoreRefused(err.message, { stage: err.stage, lines: refusalLines(err, agent.startCommand).slice(1) });
        throw err;
      }
      io.say(`Flint skipped the backup ${basename(dump)}: ${(err as RestoreRefused).message}`);
    }
  }
  if (!result) throw new RestoreRefused('There is no whole backup to restore from. Nothing was changed.', { stage: 'dump' });

  const secs = plural(result.seconds, 'second', 'seconds');
  if (result.checkedOnly) {
    io.say(`The backup ${basename(result.dump)} restores and passes every check. A real restore would take about ${secs}.`);
    sayReport(io, result.report, config.tz, 'production');
    for (const name of result.leftovers) io.say(`Flint could not remove ${name}. The next restore removes it.`);
    io.say('This was a trial run. Nothing was changed.');
    return;
  }
  io.say(`Restored and verified in ${secs}.`);
  if (result.pending.length) io.say(`Flint brought the restored database up to date with ${plural(result.pending.length, 'update', 'updates')} made since the backup.`);
  io.say(`The database that was in use is kept as ${result.keptAs}, closed.`);
  if (result.copy) io.say('A copy of it is also in the pre-restore folder of your Flint backups.');
  for (const name of result.removed) io.say(`Flint removed ${name}, kept from a restore more than ${KEEP_DAYS} days ago.`);
  for (const name of result.leftovers) io.say(`Flint could not remove ${name}. The next restore removes it.`);
  if (result.audited === false) io.say('The restore is done, but Flint could not write it to its audit trail. It is in the restore record in your Flint folder.');
  if (result.runtimeStarted === false) {
    io.say('The runtime did not start again by itself. Start it with this command:');
    io.say(agent.startCommand);
  }
}

export async function restoreEmptyCommand(argv: string[], config: RestoreConfig, io: Pick<RestoreIo, 'say' | 'now'>): Promise<void> {
  let dump: string | undefined;
  let sha: string | undefined;
  let fromRebuild = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--from-rebuild') fromRebuild = true;
    else if (a === '--dump' && argv[i + 1]) dump = argv[++i];
    else if (a === '--sha256' && argv[i + 1]) sha = argv[++i];
    else throw new RestoreRefused('The only options are --from-rebuild, --dump followed by a backup file, and --sha256 followed by its fingerprint.', { stage: 'options' });
  }
  // Only the rebuild script runs this, on a Mac it has just set up. It asks no one, so it is never the way to restore over a Flint in use.
  if (!fromRebuild) throw new RestoreRefused('This is the rebuild script\'s step, not one to run by hand. To restore over the database in use, run restore-production.', { stage: 'options' });
  if (!dump || !dump.startsWith('/')) throw new RestoreRefused('Name the backup file by its full path after --dump.', { stage: 'options' });
  if (sha !== undefined && !/^[0-9a-f]{64}$/.test(sha)) throw new RestoreRefused('The fingerprint after --sha256 is not a sha256.', { stage: 'options' });
  const r = await restoreDatabase({
    mode: 'rebuild',
    dump,
    owner: config.ownerUrl,
    app: config.appUrl,
    restore: config.restoreUrl,
    ...(sha ? { recorded: [sha] } : {}),
    tools: config.tools,
    migrationsDir: MIGRATIONS,
    migrate: (url) => migrateDeploy(url, config.home, config.path),
    // Nothing runs yet on a Mac being rebuilt: there is no runtime to stop or start.
    stopRuntime: async () => {},
    startRuntime: async () => {},
    ...(config.rp ? { rp: config.rp } : {}),
    say: io.say,
    ...(io.now ? { now: io.now } : {}),
    ...(config.dataDir ? { dataDir: config.dataDir } : {}),
    record: recorder(config.recordFile),
  });
  if (r.already) io.say('The database already holds this backup from an earlier run, and it passes its checks.');
  else {
    io.say(
      r.tables
        ? `The database restored and passed its checks: ${r.tables} tables match the backup's own counts.`
        : 'The database restored and passed its checks. This backup came without row counts, so its sizes were not compared.',
    );
    if (r.pending.length) io.say(`Flint brought it up to date with ${plural(r.pending.length, 'update', 'updates')} made since the backup.`);
    if (r.audited === false) io.say('Flint could not write the restore to its audit trail. It is in the restore record in your Flint folder.');
  }
  for (const name of r.leftovers) io.say(`Flint could not remove ${name}. The next restore removes it.`);
  sayReport(io as RestoreIo, r.report, config.tz, 'rebuild');
}

/**
 * The terminal, when both ends are one. This stops a pipe, a script or a job
 * from answering by accident; it is not proof that Will is the one typing.
 */
export function terminal(stdin: NodeJS.ReadStream, stdout: NodeJS.WriteStream): RestoreIo['ask'] {
  if (!stdin.isTTY || !stdout.isTTY) return undefined;
  return async (question) => {
    const rl = createInterface({ input: stdin, output: stdout });
    try {
      return await rl.question(question);
    } finally {
      rl.close();
    }
  };
}
