/**
 * The two restore commands (P7), as Will and the rebuild script run them:
 *
 *   pnpm --filter @flint/runtime restore-production [--dump <file>] [--without-copy]
 *       Replace the production database with a nightly backup. Will runs it in
 *       Terminal and types RESTORE. It is the action `restore.production`:
 *       APPROVAL in code, never promoted, and forbidden to Flint on its own, so
 *       there is no --auto and no way to answer for him. It cannot wait on an
 *       approval card: the cards live in the database it replaces.
 *   pnpm --filter @flint/runtime restore-production --check [--dump <file>]
 *       A trial run: restore the backup beside the database in use, run every
 *       check, drop the copy, and say how long it took. Nothing is changed.
 *   pnpm --filter @flint/runtime restore-empty --dump <file>
 *       A rebuilt Mac: restore into the EMPTY database the rebuild just made.
 *       Refused if that database holds anything.
 *
 * Every line printed is a sentence for Will. No URL, password or file content
 * is ever printed.
 */
import { execFile, spawn } from 'node:child_process';
import { existsSync, readdirSync, readlinkSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { resolveTier } from '@flint/policy';
import type { RestoreConfig } from '../config.js';
import { client, targetOf } from './backup.js';
import { checkDump, RestoreRefused, restoreIntoEmpty, restoreProduction, type RestoreSummary } from './restore.js';

/** apps/runtime, whichever directory the command was started from. */
const RUNTIME_DIR = fileURLToPath(new URL('../../', import.meta.url));
const MIGRATIONS = join(RUNTIME_DIR, 'prisma', 'migrations');
const LABEL = 'com.flint.runtime';

export type Exec = (bin: string, args: string[]) => Promise<string>;
const realExec: Exec = (bin, args) =>
  new Promise((resolveP, reject) => execFile(bin, args, { timeout: 30_000 }, (err, stdout) => (err ? reject(err) : resolveP(String(stdout)))));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Stopping and starting the runtime's LaunchAgent, with fixed arguments (no
 * string is ever built into a command). `stop` waits until launchd has let go of
 * it; `start` loads it again, as the installer does.
 */
export function runtimeAgent(home: string, uid: number, exec: Exec = realExec, wait: (ms: number) => Promise<void> = sleep) {
  const target = `gui/${uid}`;
  const plist = join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
  const loaded = () => exec('/bin/launchctl', ['print', `${target}/${LABEL}`]).then(() => true, () => false);
  return {
    async stop(): Promise<void> {
      if (!(await loaded())) return;
      await exec('/bin/launchctl', ['bootout', `${target}/${LABEL}`]).catch(() => undefined);
      for (let i = 0; i < 60; i++) {
        if (!(await loaded())) return;
        await wait(250);
      }
      throw new RestoreRefused('The runtime did not stop, so Flint did not swap the databases.');
    },
    async start(): Promise<void> {
      if (await loaded()) return;
      if (!existsSync(plist)) throw new Error("the runtime's LaunchAgent file is missing");
      let last: unknown;
      for (let i = 0; i < 5; i++) {
        try {
          await exec('/bin/launchctl', ['bootstrap', target, plist]);
          return;
        } catch (err) {
          last = err;
          await wait(2000);
        }
      }
      throw last instanceof Error ? last : new Error('launchctl bootstrap failed');
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
    // The migration's name and Prisma's code only: its message can quote a row.
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
}

/** The words Will reads before he types RESTORE. */
export function summaryLines(s: RestoreSummary, tz: string, now: Date): string[] {
  const when = s.takenAt.toLocaleString('en-US', { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  return [
    `The backup is from ${when}. It is ${ago(s.takenAt, now)}.`,
    s.fingerprint === 'matches'
      ? `It holds ${s.tables} tables, and it is unchanged since it was made.`
      : `It holds ${s.tables} tables. No fingerprint was saved with it, so Flint checks it by its row counts after restoring.`,
    `Restoring it replaces Flint's database with that backup. Everything Flint recorded after it is left out.`,
    `The database in use now is kept under the name ${s.keptAs}. Nothing is deleted.`,
    'Anything you approved that has not run yet will need approving again.',
  ];
}

export async function restoreProductionCommand(argv: string[], config: RestoreConfig, io: RestoreIo): Promise<void> {
  const now = io.now ?? new Date();
  const exec = io.exec ?? realExec;
  // The tier engine's answer for a person at the console; anything else (an --auto run, a job) is not offered at all.
  if (argv.includes('--auto')) throw new RestoreRefused('Flint never restores its database on its own. Run this yourself in Terminal.');
  const tier = resolveTier('restore.production', { context: 'console', tainted: false });
  if (tier.tier !== 'approval') throw new RestoreRefused('Restoring the database is not allowed here.');
  let chosen: string | undefined;
  let withoutCopy = false;
  let checkOnly = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = argv[i + 1];
    if (a === '--without-copy') withoutCopy = true;
    else if (a === '--check') checkOnly = true;
    else if (a === '--dump' && next && !next.startsWith('--')) chosen = argv[++i];
    else throw new RestoreRefused('The only options are --dump followed by a backup file, --without-copy, and --check.');
  }
  // A real restore is confirmed at the keyboard. A trial run changes nothing and asks nothing.
  if (!checkOnly && !io.ask) throw new RestoreRefused('Run this yourself in Terminal: it asks you to confirm before it changes anything.');

  if (!checkOnly && (await updateWaiting(config.home, exec))) {
    throw new RestoreRefused('A database update is waiting or did not finish, and restoring now could apply it. Nothing was changed. Ask before restoring.');
  }

  // The chosen backup, or the newest one that is whole.
  let dump: string | undefined;
  if (chosen) {
    dump = resolve(config.dumpDir, chosen);
    if (!dump.startsWith(`${config.dumpDir}/`)) throw new RestoreRefused('Flint restores only the nightly backups in its own backup folder.');
    await checkDump(dump, config.tools);
  } else {
    for (const candidate of dumpsNewestFirst(config.dumpDir)) {
      try {
        await checkDump(candidate, config.tools);
        dump = candidate;
        break;
      } catch (err) {
        if (!(err instanceof RestoreRefused)) throw err;
        io.say(`Flint skipped the backup ${basename(candidate)}: ${err.message}`);
      }
    }
    if (!dump) throw new RestoreRefused('There is no whole backup to restore from. Nothing was changed.');
  }

  const agent = runtimeAgent(config.home, io.uid, exec);
  const ask = io.ask ?? (async () => '');
  const result = await restoreProduction({
    dump,
    owner: config.ownerUrl,
    app: config.appUrl,
    ...(config.backupUrl ? { backup: config.backupUrl } : {}),
    copyDir: config.copyDir,
    withoutCopy,
    checkOnly,
    tools: config.tools,
    migrationsDir: MIGRATIONS,
    migrate: (url) => migrateDeploy(url, config.home, config.path),
    confirm: async (summary) => {
      for (const line of summaryLines(summary, config.tz, now)) io.say(line);
      return (await ask('Type RESTORE to continue: ')).trim() === 'RESTORE';
    },
    stopRuntime: () => agent.stop(),
    startRuntime: () => agent.start(),
    recordedSha256: async (path) => {
      const c = client(targetOf(config.ownerUrl));
      await c.connect();
      try {
        const r = await c.query<{ sha256: string }>(`SELECT sha256 FROM "BackupRun" WHERE path = $1 AND location = 'local' AND status = 'ok' ORDER BY "startedAt" DESC LIMIT 1`, [path]);
        return r.rows[0]?.sha256;
      } finally {
        await c.end().catch(() => undefined);
      }
    },
    say: io.say,
    now,
  });
  if (result.checkedOnly) {
    io.say(`The backup ${basename(dump)} restores and passes every check. A real restore would take about ${result.seconds} second${result.seconds === 1 ? '' : 's'}.`);
    io.say('This was a trial run. Nothing was changed.');
    return;
  }
  io.say(`Restored and verified in ${result.seconds} second${result.seconds === 1 ? '' : 's'}.`);
  if (result.pending.length) io.say(`Flint brought the restored database up to date with ${result.pending.length} update${result.pending.length === 1 ? '' : 's'} made since the backup.`);
  if (result.proposals) io.say(`${result.proposals} card${result.proposals === 1 ? '' : 's'} you had approved did not run. Approve ${result.proposals === 1 ? 'it' : 'them'} again in Flint.`);
  io.say(`The database that was in use is kept as ${result.keptAs}.`);
  if (result.runtimeStarted === false) {
    io.say('The runtime did not start again by itself. Start it with this command:');
    io.say(`  launchctl bootstrap gui/${io.uid} ~/Library/LaunchAgents/${LABEL}.plist`);
  }
  if (result.copy) io.say('A copy of it is also in the pre-restore folder of your Flint backups.');
}

export async function restoreEmptyCommand(argv: string[], config: RestoreConfig, io: Pick<RestoreIo, 'say' | 'now'>): Promise<void> {
  const at = argv.indexOf('--dump');
  const dump = at === -1 ? undefined : argv[at + 1];
  if (!dump || !dump.startsWith('/')) throw new RestoreRefused('Name the backup file by its full path after --dump.');
  const r = await restoreIntoEmpty({ dump, owner: config.ownerUrl, app: config.appUrl, tools: config.tools, migrationsDir: MIGRATIONS, ...(io.now ? { now: io.now } : {}) });
  if (r.already) {
    io.say('The database already holds this backup from an earlier run, and it passes its checks.');
    return;
  }
  io.say(
    r.tables
      ? `The database restored and passed its checks: ${r.tables} tables match the backup's own counts.`
      : 'The database restored and passed its checks. This backup came without row counts, so its sizes were not compared.',
  );
  if (r.pending.length) io.say(`The backup is ${r.pending.length} database update${r.pending.length === 1 ? '' : 's'} behind this copy of Flint. The runtime's installer applies ${r.pending.length === 1 ? 'it' : 'them'} next.`);
  if (r.proposals || r.approvals) io.say('Approvals from before the backup were set aside, so nothing signed on the old Mac can run on this one.');
}

/** The terminal, when a person is at it: both ends must be a TTY, so nothing can be piped in to answer for Will. */
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
