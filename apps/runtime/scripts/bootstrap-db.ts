/**
 * Make Flint's database roles and databases on a rebuilt Mac (P7;
 * src/backup/bootstrap.ts says what and why). apps/studio/rebuild.sh runs it:
 *
 *   pnpm --filter @flint/runtime bootstrap-db --port 5432 [--rotate] [--from-rebuild]
 *
 * It connects as whoever the standard PG* variables name (PGHOST, PGPORT,
 * PGUSER, and PGPASSFILE or PGPASSWORD; the pg client reads them itself), so no
 * password is ever on the command line. Every line it prints is a sentence, and
 * none holds a password.
 */
import { homedir } from 'node:os';
import { BootstrapRefused, bootstrapDb } from '../src/backup/bootstrap.js';

const args = process.argv.slice(2);
const at = args.indexOf('--port');
const port = at === -1 ? 5432 : Number(args[at + 1]);
const rotate = args.includes('--rotate');

bootstrapDb({ admin: {}, port, home: homedir(), rotate })
  .then((r) => {
    const roles = [...r.created, ...r.rotated].length;
    console.log(`Flint's database has its ${roles} roles, each with a new password.`);
    if (r.databases.length) console.log(`Flint made ${r.databases.length === 1 ? 'the database' : 'the databases'} ${r.databases.join(' and ')}.`);
    console.log("The new passwords are saved in Flint's own settings files, which only you can read.");
    // A rebuild installs the services next, with the new passwords: only a rotation run by hand needs saying.
    if (r.rotated.length && !args.includes('--from-rebuild')) console.log("Flint's services keep the old passwords until they are installed again.");
  })
  .catch((err: unknown) => {
    // A refusal is a sentence. Anything else: the error's code or class, never its text (a connection error can name a URL).
    if (err instanceof BootstrapRefused) console.log(err.message);
    else console.log(`Flint could not set up its database (${(err as { code?: string }).code ?? (err instanceof Error ? err.name : 'error')}).`);
    process.exit(1);
  });
