/**
 * Nexus's own backup (P7): the same three nightly steps as Flint's database
 * (backup.ts), for a database that is on this Mac and is not Flint's.
 *
 *  - It ships off. Nothing here runs, and nothing of Nexus is read, until
 *    FLINT_NEXUS_BACKUP_URL is in ~/.flint/backup.env (config.ts).
 *  - Flint reads Nexus through a login that can change nothing there (the
 *    backup login it already has, flint_backup: it may read every table and
 *    write none). A login that could write is refused before any dump is
 *    taken (backup.ts, canWrite), so a mistaken address can never become a
 *    way to change Nexus.
 *  - The dump is a file of this user's alone, in ~/FlintBackups/nexus. It
 *    leaves this Mac only encrypted to Will's key, with its row counts. No
 *    model ever reads it.
 *  - The weekly test restores the newest dump into a scratch database
 *    (nexus_restore_test) as the restore login and compares row counts. It
 *    never opens the Nexus database.
 *  - Nothing here can put a Nexus backup back: restoring Nexus is a later part
 *    (docs/RECOVERY.md says what there is until then).
 *
 * What is here is the part only Nexus needs: the one-time setup the owner's
 * side runs (`nexus-setup`), and what Flint says, with the commands, when the
 * address is set and Nexus will not let it read.
 */
import { nexusUrlProblem, runtimeEnv, type NexusBackupConfig } from '../config.js';
import { NotReadOnly, ToolFailed, canWrite, client, targetOf } from './backup.js';
import { stageEnv } from './bootstrap.js';

/** The name Nexus's database has on this Mac unless `nexus-setup` is told another. */
export const NEXUS_DATABASE = 'nexus';

/** The command that sets the address, on a line of its own. */
const SETUP = '  cd ~/flint && pnpm --filter @flint/runtime nexus-setup';

/** A login or database name that needs no quoting, so a command can be printed with it as it is. */
const plain = (name: string | undefined): name is string => !!name && /^[a-z_][a-z0-9_]{0,62}$/.test(name);

/** What kind of refusal an error from Postgres, or from one of its tools, is. Its own words are never passed on. */
function refusal(err: unknown): 'writes' | 'login' | 'no-database' | 'not-let-in' | undefined {
  if (err instanceof NotReadOnly) return 'writes';
  const e = err as { code?: unknown; message?: unknown } | null;
  const code = typeof e?.code === 'string' ? e.code : '';
  const said = err instanceof ToolFailed ? err.summary : String(e?.message ?? '');
  if (code === '28P01' || code === '28000' || /password authentication failed|role "[^"]*" does not exist/i.test(said)) return 'login';
  if (code === '3D000' || /database "[^"]*" does not exist/i.test(said)) return 'no-database';
  if (code === '42501' || /permission denied/i.test(said)) return 'not-let-in';
  return undefined;
}

/**
 * What Flint says, in Terminal and in the nightly job's log, when Nexus's
 * backup is switched on and could not read Nexus: what is wrong, and the
 * commands that put it right, each on a line of its own. Empty when the
 * failure is not one of setup (the disk, a tool, a dropped connection).
 *
 * The two grants are what the owner's side gives, once:
 *  - CONNECT on the Nexus database lets Flint's backup login open it;
 *  - membership of pg_read_all_data lets that login read every table, view
 *    and sequence, and gives it no way to change any of them.
 * Neither is Flint's to give itself: Nexus's database and its logins are
 * never touched from here.
 */
export function nexusHelp(err: unknown, nexus: Pick<NexusBackupConfig, 'backupUrl' | 'problem'>): string[] {
  if (nexus.problem) {
    return [`Flint did not back Nexus up: ${nexus.problem.replace(/^FLINT_NEXUS_BACKUP_URL /, 'the address set for it ')}.`, 'Set it again with this command:', SETUP];
  }
  let login: string | undefined;
  let database: string | undefined;
  try {
    const t = targetOf(nexus.backupUrl ?? '');
    login = t.user;
    database = t.database;
  } catch {
    // Not an address: the problem above would have said so.
  }
  switch (refusal(err)) {
    case 'writes':
      return [
        'The login in the Nexus address could change Nexus, so Flint backed nothing up.',
        'Flint reads Nexus only through a login that can change nothing there. Set the address again with this command:',
        SETUP,
      ];
    case 'login':
      return ['The login in the Nexus address was refused. Its password may have changed.', 'Set the address again with this command:', SETUP];
    case 'no-database':
      return ['There is no database by the name in the Nexus address on this Mac.', 'Set the address again, with the name of the Nexus database:', `${SETUP} --database <name>`];
    case 'not-let-in':
      return plain(login) && plain(database)
        ? [
            'Flint’s backup login is not let into the Nexus database.',
            'Let it in once with these commands, then run this again:',
            `  psql -d postgres -c 'GRANT CONNECT ON DATABASE ${database} TO ${login}'`,
            `  psql -d postgres -c 'GRANT pg_read_all_data TO ${login}'`,
            'The first lets that login connect to Nexus. The second lets it read every table there and change none.',
          ]
        : ['Flint’s backup login is not let into the Nexus database.', 'Set the address again with this command:', SETUP];
    default:
      return [];
  }
}

/** What `nexus-backup`, `nexus-offsite` and `nexus-drill` say by hand while Nexus's backup is off. */
export const NEXUS_OFF = ['Flint is not set up to back up Nexus, so nothing was done.', 'To set it up, run this:', SETUP] as const;

/** What follows `nexus-setup` on the command line: nothing, or `--database <name>`. Anything else is refused. */
export function nexusSetupArgs(argv: readonly string[]): { database: string } {
  if (argv.length === 0) return { database: NEXUS_DATABASE };
  if (argv.length === 2 && argv[0] === '--database' && plain(argv[1])) return { database: argv[1] };
  throw new Error('usage: cli.ts nexus-setup [--database <name>]');
}

/**
 * `nexus-setup`: switch Nexus's backup on. Run by Will, once (and again after
 * Flint's database passwords are changed).
 *
 * It works the address out from Flint's own backup address in backup.env: the
 * same login and password, on the same server, with the Nexus database's name.
 * So no password is typed or shown. Before it writes anything it opens that
 * database once, with that login, to see that the login is let in and can
 * change nothing there; it reads the server's records of who may do what, and
 * no table. Only then is the one line written (the file stays this user's
 * alone, 0600), and the nightly job takes it from there.
 *
 * Every line it says is a sentence or a command. The address is never said.
 */
export async function nexusSetup(o: { backupEnv: string; database: string; say: (line: string) => void }): Promise<boolean> {
  const { say } = o;
  const flint = runtimeEnv(o.backupEnv, {}).FLINT_DB_BACKUP_URL;
  if (!flint) {
    say('Flint’s own backup is not set up on this Mac, so there is no login to read Nexus with. Nothing was changed.');
    return false;
  }
  if (!plain(o.database)) {
    say('That is not a database’s name. Nothing was changed.');
    return false;
  }
  // The same address with the last part, the database's name, changed; nothing else of it is touched.
  const url = /\/[^/?#]+$/.test(flint) ? flint.replace(/\/[^/?#]+$/, `/${o.database}`) : '';
  const why = url ? nexusUrlProblem(url, flint) : 'could not be worked out from Flint’s own backup address';
  if (why) {
    say(`Flint did not set it up: the address for Nexus ${why}. Nothing was changed.`);
    return false;
  }
  try {
    const c = client(targetOf(url));
    await c.connect();
    try {
      await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      if (await canWrite(c)) throw new NotReadOnly();
    } finally {
      await c.end().catch(() => {});
    }
  } catch (err) {
    const lines = nexusHelp(err, { backupUrl: url });
    if (err instanceof NotReadOnly) {
      // Here the login is Flint's own backup login, so setting the address again would change nothing.
      say('Flint’s backup login could change the Nexus database, so Flint will not use it there. Nothing was changed.');
      say('Take away what lets it write in Nexus, then run this again.');
    } else if (lines.length) {
      for (const line of lines) say(line);
      say('Nothing was changed.');
    } else {
      say('Flint could not reach the Nexus database. Nothing was changed.');
    }
    return false;
  }
  stageEnv(o.backupEnv, { FLINT_NEXUS_BACKUP_URL: url }).commit();
  say('Flint can read the Nexus database and cannot change it.');
  say('Nexus’s backup is on. Tonight’s run files its first card in Approvals.');
  say('To take a backup now and test it, run these:');
  say('  cd ~/flint && pnpm --filter @flint/runtime nexus-backup');
  say('  cd ~/flint && pnpm --filter @flint/runtime nexus-drill');
  return true;
}
