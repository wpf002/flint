/**
 * A throwaway Postgres for the tests that need a whole cluster to themselves
 * (making roles, renaming a database called `flint`): `initdb` into a temp
 * directory, listening on [::1] only on a free port, no socket file, removed
 * when the test file ends. It shares nothing with the Mac's own Postgres or
 * with flint_test, so these tests need no lock, read no settings file of the
 * Mac's (this file imports nothing that does), and can never touch real data.
 *
 * A watchdog process stops the server and removes its folder when the test
 * process is gone, however it went (a kill -9 runs no exit handler).
 *
 * It needs Postgres 17's server programs (the Mac has them from Homebrew). Where
 * they are missing the tests are skipped, except in the deploy gate
 * (FLINT_REQUIRE_DB), where that is a failure.
 */
import { execFile, execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import pg from 'pg';
import { challengeOf, digestOf, type ApprovalPayload } from '@flint/policy';

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

export const RUNTIME = join(__dirname, '..');
export const MIGRATIONS = join(RUNTIME, 'prisma', 'migrations');
export const GRANTS_FIXTURE = join(__dirname, 'fixtures', 'grants.json');

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

/**
 * Wait until process $1 is gone, then stop the server in $3 and remove the
 * folder $4 (only a folder of this helper's own making). Started detached, so
 * it outlives a test process that was killed.
 */
const WATCHDOG = [
  'while kill -0 "$1" 2>/dev/null; do sleep 1; done',
  '"$2" -D "$3" -m immediate -w -t 20 stop >/dev/null 2>&1',
  'case "$4" in */flint-pg-*) rm -rf -- "$4" ;; esac',
].join('\n');

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
  // A test run that ends in the ordinary way stops its server here...
  process.once('exit', stop);
  // ...and one that is killed has it stopped by the watchdog, which no signal to this process reaches.
  spawn('/bin/sh', ['-c', WATCHDOG, 'flint-pg-watchdog', String(process.pid), bin('pg_ctl'), data, dir], { detached: true, stdio: 'ignore', env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' } }).unref();
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

// ---------------------------------------------------------------------------
// What the tests on a scratch cluster share. Nothing here reads the Mac's own settings.

let n = 0;
/** A fresh id: unique within a run. */
export const id = (prefix = 't'): string => `${prefix}${Date.now().toString(36)}${(n++).toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/** The same URL pointed at another database. */
export const onDb = (url: string, db: string): string => {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
};

/** A pg config from a URL (pg's own parser keeps an IPv6 host's brackets, and then cannot resolve it). */
export const pgConfig = (url: string): pg.ClientConfig => {
  const u = new URL(url);
  return { host: u.hostname.replace(/^\[|\]$/g, ''), port: u.port ? Number(u.port) : 5432, user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), database: decodeURIComponent(u.pathname.slice(1)) };
};

export async function connect<T>(to: string | pg.ClientConfig, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client(typeof to === 'string' ? pgConfig(to) : to);
  c.on('error', () => {});
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end().catch(() => {});
  }
}

const run = promisify(execFile);
/** `prisma migrate deploy` against `ownerUrl` (the URL goes through the environment). */
export async function migrate(ownerUrl: string, cwd = RUNTIME): Promise<void> {
  try {
    await run(join(RUNTIME, 'node_modules', '.bin', 'prisma'), ['migrate', 'deploy'], {
      cwd,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', DATABASE_URL: ownerUrl, PRISMA_HIDE_UPDATE_MESSAGE: '1' },
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    throw new Error(`prisma migrate deploy failed: ${err.stdout ?? ''}${err.stderr ?? ''}`);
  }
}

export interface Roles {
  owner: string;
  app: string;
  approver: string;
}

export interface TestKey {
  credentialId: string;
  privateKey: KeyObject;
  /** Will signs: the Approval row flint_approver records (in the database the key was enrolled in, or the one at `at`). Returns its id. */
  approve(o: { subjectType?: ApprovalPayload['subjectType']; subjectId: string; action: string; argsDigest: string; decision?: 'approve' | 'reject' }, at?: string): Promise<string>;
}

/** Will's side of an approval, for tests: enrol a P-256 key, as the server's approval path would record it. */
export async function enrollKey(approverUrl: string, label = 'test key'): Promise<TestKey> {
  const key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const credentialId = id('cred');
  await connect(approverUrl, (c) =>
    c.query(`INSERT INTO "ApprovalCredential" (id, "credentialId", factor, "publicKey", label, "enrolledVia") VALUES ($1, $2, 'secure_enclave', $3, $4, 'enroll_code')`, [
      `c${credentialId}`, credentialId, key.publicKey.export({ format: 'der', type: 'spki' }), label,
    ]),
  );
  return {
    credentialId,
    privateKey: key.privateKey,
    async approve(o, at = approverUrl) {
      const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
      const payload: ApprovalPayload = {
        v: 1, subjectType: o.subjectType ?? 'proposal', subjectId: o.subjectId, decision: o.decision ?? 'approve', action: o.action, argsDigest: o.argsDigest, expiresAt,
        nonce: createHash('sha256').update(String(Math.random())).digest('hex').slice(0, 32),
      };
      const challenge = challengeOf(payload);
      const approvalId = id('ap');
      await connect(at, (c) =>
        c.query(`INSERT INTO "Approval" (id, "subjectType", "subjectId", decision, payload, challenge, "credentialId", signature, "expiresAt") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`, [
          approvalId, payload.subjectType, payload.subjectId, payload.decision, JSON.stringify(payload), challenge.toString('hex'), credentialId, sign('sha256', challenge, key.privateKey), expiresAt,
        ]),
      );
      return approvalId;
    },
  };
}

/**
 * A card Will signs and the runtime carries out, the way the real ones go
 * (every step passes the database's own triggers): filed pending, approved with
 * a signed approval, executing while `during` runs, then executed. Returns the
 * proposal's and the approval's ids.
 */
export async function signedCard(
  roles: Roles,
  key: TestKey,
  card: { kind: string; action: string; args: unknown },
  during: (c: pg.Client, approvalId: string) => Promise<void>,
): Promise<{ proposalId: string; approvalId: string }> {
  const proposalId = id('pr');
  const argsDigest = digestOf(card.args);
  await connect(roles.app, (c) =>
    c.query(
      `INSERT INTO "Proposal" (id, kind, origin, action, args, "argsDigest", "argsProvenance", "expiresAt") VALUES ($1, $2, 'cli', $3, $4::jsonb, $5, '{}', now() + interval '1 hour')`,
      [proposalId, card.kind, card.action, JSON.stringify(card.args), argsDigest],
    ),
  );
  const approvalId = await key.approve({ subjectId: proposalId, action: card.action, argsDigest }, roles.approver);
  await connect(roles.app, async (c) => {
    await c.query(`UPDATE "Proposal" SET status = 'approved', "approvalId" = $2 WHERE id = $1`, [proposalId, approvalId]);
    await c.query(`UPDATE "Proposal" SET status = 'executing' WHERE id = $1`, [proposalId]);
    await during(c, approvalId);
    await c.query(`UPDATE "Proposal" SET status = 'executed', "executedAt" = now(), result = '{}' WHERE id = $1`, [proposalId]);
  });
  return { proposalId, approvalId };
}

/** A promotion (an ActionPolicy row) made by a signed policy.change card. Returns the row's id. */
export async function signedPolicy(roles: Roles, key: TestKey, row: { pattern: string; tier: 'alone' | 'approval' | 'forbidden'; dailyCap?: number }): Promise<string> {
  // To the millisecond, as the runtime keeps them.
  const expiresAt = new Date(Math.floor(Date.now() / 1000) * 1000 + 30 * 86_400_000).toISOString();
  const policyId = id('pol');
  await signedCard(roles, key, { kind: 'policy', action: 'policy.change', args: { rows: [{ ...row, expiresAt }] } }, async (c, approvalId) => {
    await c.query(`INSERT INTO "ActionPolicy" (id, pattern, tier, "dailyCap", reason, "approvalId", "expiresAt") VALUES ($1, $2, $3, $4, 'signed policy change', $5, $6)`, [
      policyId, row.pattern, row.tier, row.dailyCap ?? null, approvalId, expiresAt,
    ]);
  });
  return policyId;
}

/** A triage rule made by a signed triage.rule.create card. Returns the rule's id. */
export async function signedRule(roles: Roles, key: TestKey, name: string): Promise<string> {
  const rule = { name, source: 'github', eventType: '*', predicate: { all: [] }, action: 'log', lane: 'quiet', priority: 100, createdBy: 'will' };
  const ruleId = id('tr');
  await signedCard(roles, key, { kind: 'rule', action: 'triage.rule.create', args: { rule } }, async (c, approvalId) => {
    await c.query(
      `INSERT INTO "TriageRule" (id, name, source, "eventType", predicate, action, lane, priority, "createdBy", "approvalId") VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10)`,
      [ruleId, rule.name, rule.source, rule.eventType, JSON.stringify(rule.predicate), rule.action, rule.lane, rule.priority, rule.createdBy, approvalId],
    );
  });
  return ruleId;
}
