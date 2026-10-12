/**
 * A throwaway Postgres for the tests that need a whole cluster to themselves
 * (making roles, renaming a database called `flint`): `initdb` into a temp
 * directory, listening on [::1] only on a free port, no socket file, removed
 * when the test file ends. It shares nothing with the Mac's own Postgres or
 * with flint_test, so these tests need no lock and can never touch real data.
 *
 * It needs Postgres 17's server programs (the Mac has them from Homebrew). Where
 * they are missing the tests are skipped, except in the deploy gate
 * (FLINT_REQUIRE_DB), where that is a failure.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type pg from 'pg';

const major = (dir: string): number => {
  try {
    return Number(/(\d+)\./.exec(execFileSync(join(dir, 'postgres'), ['--version'], { encoding: 'utf8' }))?.[1] ?? 0);
  } catch {
    return 0;
  }
};
/** Where Postgres 17's programs are, or undefined. */
export const PG_BIN = ['/opt/homebrew/opt/postgresql@17/bin', '/usr/local/opt/postgresql@17/bin', '/usr/lib/postgresql/17/bin'].find(
  (d) => existsSync(join(d, 'initdb')) && existsSync(join(d, 'pg_ctl')) && major(d) === 17,
);
if (!PG_BIN && process.env.FLINT_REQUIRE_DB) throw new Error('Postgres 17 (initdb, pg_ctl) is required here (see test/scratch-cluster.ts)');
/** `describe.skipIf(NO_CLUSTER)` for the tests that need their own cluster. */
export const NO_CLUSTER = !PG_BIN;

export interface ScratchCluster {
  port: number;
  /** The cluster's superuser, over TCP with its password. */
  admin: pg.ClientConfig;
  /** The server's log, with every statement in it (log_statement = all). */
  log(): string;
  tools: { pgDump: string; pgRestore: string };
  stop(): void;
}

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const s = createServer();
    s.on('error', reject);
    s.listen(0, '::1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });

export async function startScratchCluster(): Promise<ScratchCluster> {
  if (!PG_BIN) throw new Error('no Postgres 17 here');
  const bin = (name: string) => join(PG_BIN, name);
  const dir = mkdtempSync(join(tmpdir(), 'flint-pg-'));
  chmodSync(dir, 0o700);
  const data = join(dir, 'data');
  const logFile = join(dir, 'server.log');
  const password = randomBytes(18).toString('hex');
  const pwfile = join(dir, 'pw');
  writeFileSync(pwfile, `${password}\n`, { mode: 0o600 });
  const quiet = { stdio: 'pipe' as const, env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', TZ: 'UTC' } };
  execFileSync(bin('initdb'), ['-D', data, '-U', 'scratch_admin', '--auth-host=scram-sha-256', '--auth-local=reject', `--pwfile=${pwfile}`, '-E', 'UTF8', '--locale=C', '--no-sync'], quiet);
  const port = await freePort();
  appendFileSync(join(data, 'postgresql.conf'), `\nlisten_addresses = '::1'\nport = ${port}\nunix_socket_directories = ''\nfsync = off\nlog_statement = 'all'\nmax_connections = 60\n`);
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    spawnSync(bin('pg_ctl'), ['-D', data, '-m', 'immediate', '-w', '-t', '20', 'stop'], quiet);
    rmSync(dir, { recursive: true, force: true });
  };
  // A test run that is cut short must not leave a server behind.
  process.once('exit', stop);
  try {
    execFileSync(bin('pg_ctl'), ['-D', data, '-l', logFile, '-w', '-t', '30', 'start'], quiet);
  } catch (err) {
    const tail = existsSync(logFile) ? readFileSync(logFile, 'utf8').split('\n').slice(-5).join(' | ') : '';
    stop();
    throw new Error(`the scratch Postgres did not start: ${tail || (err as Error).message}`);
  }
  return {
    port,
    admin: { host: '::1', port, user: 'scratch_admin', password, database: 'postgres' },
    log: () => readFileSync(logFile, 'utf8'),
    tools: { pgDump: bin('pg_dump'), pgRestore: bin('pg_restore') },
    stop,
  };
}

/** KEY=value pairs of an env file. */
export function readEnv(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}
