/**
 * Restoring Flint's database from a backup (P7, src/backup/restore.ts), against
 * a throwaway cluster of its own with a real `flint` database in it:
 *
 *  - a dump is checked before anything reads it: its name, that it is a plain
 *    file of Will's own, and its fingerprint against EVERY record of it;
 *  - the backup is restored beside the database in use by a role that owns
 *    nothing else, compared object by object with a database built from this
 *    checkout's migrations, and only then handed over and swapped in, in one
 *    transaction. The old database is kept, closed; nothing is dropped;
 *  - what Will took away after the backup stays taken away, what was signed and
 *    not finished cannot act, and a promotion his signature does not cover is
 *    switched off;
 *  - every refusal leaves the production database exactly as it was, and a
 *    failed or interrupted swap is settled by reading the catalog: "Nothing was
 *    changed" is said only when that was confirmed;
 *  - a rebuild's restore takes the same path, into an empty database only;
 *  - the command itself is Will's: no --auto, no answer piped in for him, and a
 *    rule of his own that forbids it is honoured.
 *
 * No time here is fixed: the audit trail refuses an entry more than 31 days
 * old, so a test with a date written into it stops passing a month later.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import pg from 'pg';
import { bootstrapDb, scramVerifier } from '../src/backup/bootstrap';
import { ToolFailed, countRows, dumpDatabase, sha256File, toolError } from '../src/backup/backup';
import { carryLines, type CarryReport } from '../src/backup/carry';
import { catalogDifference, catalogLines, checkoutMigrations, differenceSentence, migrationState } from '../src/backup/catalog';
import { grantLines } from '../src/backup/grants';
import {
  KEEP_DAYS, RestoreRefused, VOIDED_BY_RESTORE, checkDump, referenceBuilder, repairDatabase, restoreDatabase, roleProblems, verifyRestored, writeDumpHash,
  type RestoreOptions, type RestoreSummary,
} from '../src/backup/restore';
import { refusalLines, restoreEmptyCommand, restoreProductionCommand, runtimeAgent, summaryLines, terminal } from '../src/backup/restore-cli';
import type { RestoreConfig } from '../src/config';
import {
  GRANTS_FIXTURE, MIGRATIONS, NO_CLUSTER, RUNTIME, connect, enrollKey, id, migrate, onDb, pgConfig, readEnv, signedPolicy, signedRule, startScratchCluster,
  type ScratchCluster, type TestKey,
} from './scratch-cluster';

/** A temp directory of this file's own, removed when the file ends (these hold dumps and settings files). */
const scratch: string[] = [];
const scratchDir = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(d);
  return d;
};
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

const DIGEST = 'a'.repeat(64);
const stampOf = (d: Date): string => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'z').toLowerCase();
const dumpNameAt = (d: Date): string => `flint-${d.toISOString().replace(/[:.]/g, '-')}.dump`;
const refusal = async (p: Promise<unknown>): Promise<RestoreRefused> => {
  const err = await p.then(() => undefined, (e: unknown) => e);
  if (!(err instanceof RestoreRefused)) throw new Error(`expected a refusal, got ${err === undefined ? 'no error' : String(err)}`);
  return err;
};
const emptyReport: CarryReport = {
  currentRead: true, revoked: 0, mismatched: 0, keysNotCarried: [], policiesOff: 0, rulesOff: 0, unsignedPolicies: [], unsignedRules: [], approvals: 0, proposals: 0,
  deliveries: 0, jobs: 0, counters: 0, forgets: [], reappearing: { cards: 0, ran: 0 }, liveKeys: [], promotions: [], rules: [],
};

describe('the command is Will’s alone', () => {
  const config = {
    home: '/nonexistent', tz: 'America/Chicago', ownerUrl: 'postgresql://flint_owner:x@[::1]:1/flint', appUrl: 'postgresql://flint_app:x@[::1]:1/flint', restoreUrl: 'postgresql://flint_restore:x@[::1]:1/postgres',
    dumpDir: '/nonexistent/pg', copyDir: '/nonexistent/pre', fingerprintKey: '/nonexistent/key', holdFile: '/nonexistent/hold', recordFile: '/nonexistent/record',
    tools: { pgDump: 'x', pgRestore: 'x' }, path: '', launchctl: false,
  } satisfies RestoreConfig;
  const said: string[] = [];
  const io = { say: (l: string) => said.push(l), ask: async () => 'RESTORE', uid: 501 };

  it('there is no --auto: Flint never restores its database on its own', async () => {
    await expect(restoreProductionCommand(['--auto'], config, io)).rejects.toThrow(/never restores its database on its own/);
  });

  it('with no one at a keyboard it refuses; a terminal at both ends stops an accident, and that is all it claims', async () => {
    await expect(restoreProductionCommand([], config, { say: io.say, uid: 501 })).rejects.toThrow(RestoreRefused);
    await expect(restoreProductionCommand([], config, { say: io.say, uid: 501 })).rejects.toThrow(/Run this yourself in Terminal/);
    await expect(restoreProductionCommand(['--repair'], config, { say: io.say, uid: 501 })).rejects.toThrow(/Run this yourself in Terminal/);
    // A pipe is not a terminal, at either end.
    const pipe = { isTTY: false } as NodeJS.ReadStream;
    const tty = { isTTY: true } as NodeJS.ReadStream;
    expect(terminal(pipe, tty as unknown as NodeJS.WriteStream)).toBeUndefined();
    expect(terminal(tty, pipe as unknown as NodeJS.WriteStream)).toBeUndefined();
    expect(terminal(tty, tty as unknown as NodeJS.WriteStream)).toBeTypeOf('function');
    // The README says so in as many words, and no longer says nothing can answer for him.
    const readme = readFileSync(join(RUNTIME, 'README.md'), 'utf8');
    expect(readme).toMatch(/stops an accident/);
    expect(readme).not.toMatch(/nothing can be piped in/i);
  });

  it('it takes --dump <file>, --without-copy, --without-fingerprint, --check and --repair, and nothing else', async () => {
    for (const bad of [['--yes'], ['--force'], ['stray'], ['--dump'], ['--dump', '--without-copy'], ['--check', '--now']]) {
      await expect(restoreProductionCommand(bad, config, io), bad.join(' ')).rejects.toThrow(/only options/);
    }
    await expect(restoreProductionCommand(['--repair', '--check'], config, io)).rejects.toThrow(/--repair takes no other option/);
  });

  it('a backup is named inside Flint’s own backup folder, never outside it', async () => {
    for (const outside of ['../pre/flint-x.dump', '/etc/passwd', '../../x']) {
      await expect(restoreProductionCommand(['--dump', outside], config, io), outside).rejects.toThrow(/only the nightly backups in its own backup folder/);
    }
  });

  it('the rebuild’s step is not one to run by hand, and takes only its own options', async () => {
    await expect(restoreEmptyCommand(['--dump', '/x/flint.dump'], config, io)).rejects.toThrow(/rebuild script's step, not one to run by hand/);
    await expect(restoreEmptyCommand(['--from-rebuild'], config, io)).rejects.toThrow(/full path after --dump/);
    await expect(restoreEmptyCommand(['--from-rebuild', '--dump', 'relative.dump'], config, io)).rejects.toThrow(/full path after --dump/);
    await expect(restoreEmptyCommand(['--from-rebuild', '--dump', '/x.dump', '--sha256', 'zz'], config, io)).rejects.toThrow(/not a sha256/);
    await expect(restoreEmptyCommand(['--from-rebuild', '--yes'], config, io)).rejects.toThrow(/only options/);
  });

  it('what Will reads before he types RESTORE is whole sentences: the backup, where the old database goes, what is in force', () => {
    const now = new Date('2026-10-12T15:00:00Z');
    const summary = (over: Partial<RestoreSummary> = {}): RestoreSummary => ({
      name: 'flint-x.dump', takenAt: new Date('2026-10-12T07:15:00Z'), bytes: 1, tables: 31, fingerprint: 'matches', database: 'flint', keptAs: 'flint_damaged_20261012t150000z',
      report: { ...emptyReport, liveKeys: [{ label: 'Studio', factor: 'secure_enclave', enrolledAt: new Date('2026-10-01T12:00:00Z'), known: true }], promotions: [{ pattern: 'backup.local', tier: 'alone', dailyCap: 1, expiresAt: now }] },
      removing: [], ...over,
    });
    const lines = summaryLines(summary(), 'America/Chicago', now);
    expect(lines[0]).toBe('The backup is from Monday, October 12 at 2:15 AM. It is 8 hours old.');
    expect(lines.join(' ')).toContain('flint_damaged_20261012t150000z, closed');
    expect(lines).toContain('This key can approve: "Studio", this Mac\'s key, enrolled October 1, 2026.');
    expect(lines).toContain('Flint may do 1 thing on its own: backup.local (1 a day).');
    for (const l of lines) expect(l, l).toMatch(/^[A-Z].*\.$/);
    const none = summaryLines(summary({ takenAt: now, tables: 3, fingerprint: 'none', removing: ['flint_damaged_20260901t000000z'] }), 'UTC', now);
    expect(none[0]).toMatch(/less than an hour old/);
    expect(none[1]).toMatch(/No fingerprint was recorded for it/);
    expect(none.join(' ')).toMatch(new RegExp(`more than ${KEEP_DAYS} days ago, and removed by this one: flint_damaged_20260901t000000z`));
  });

  it('what a restore carried forward, set aside and left for Will is said in sentences, and never holds a key', () => {
    const r: CarryReport = {
      ...emptyReport, revoked: 1, mismatched: 1, policiesOff: 1, rulesOff: 1, proposals: 2, approvals: 3, deliveries: 1, jobs: 4,
      keysNotCarried: [{ label: 'New phone', factor: 'webauthn', enrolledAt: new Date('2026-10-11T00:00:00Z') }],
      unsignedPolicies: [{ pattern: 'backup.*', why: 'the key that signed it is revoked' }], unsignedRules: [{ name: 'quiet_ci', why: 'it is not in the card you signed' }],
      forgets: [{ id: 'e1', kind: 'person' }, { id: 'e2', kind: 'thread' }], reappearing: { cards: 2, ran: 1 },
      liveKeys: [{ label: 'Stranger\u001b[31m', factor: 'webauthn', enrolledAt: new Date('2026-10-02T00:00:00Z'), known: false }],
      promotions: [{ pattern: 'world.sync.github', tier: 'alone', dailyCap: null, expiresAt: new Date() }, { pattern: 'mcp:*', tier: 'forbidden', dailyCap: null, expiresAt: new Date() }], rules: ['quiet_ci'],
    };
    const lines = carryLines(r, 'UTC', 'production');
    const text = lines.join('\n');
    expect(text).toContain('The approval key you revoked after this backup stays revoked.');
    expect(text).toContain('Flint revoked 1 approval key from the backup, because it is not the same as in the database in use.');
    expect(text).toContain('The approval key "New phone" was enrolled after this backup, so it is not in it. Enrol it again.');
    expect(text).toContain('What you switched off after this backup stays off: 2 permissions.');
    expect(text).toContain('Flint switched off Flint doing backup.* on its own: the key that signed it is revoked. Sign it again if you want it.');
    expect(text).toContain('Flint switched off the triage rule quiet_ci: it is not in the card you signed. Sign it again if you want it.');
    expect(text).toContain('You had approved 2 cards that did not run. Approve them again in Flint.');
    expect(text).toContain('You dealt with 2 cards after this backup, and they are waiting again; 1 of them had already run. Reject what you do not want done twice.');
    expect(text).toContain('You told Flint to forget 2 things after this backup, and they are back (person, thread). Forget them again in the console.');
    expect(text).toContain('Notes and jobs that were waiting when the backup was made were closed, so nothing is sent twice.');
    // A key the database in use does not hold is pointed out; a label cannot put control characters on the terminal.
    expect(text).toContain('This key can approve: "Stranger??31m", a passkey, enrolled October 2, 2026. It is not in the database in use now: revoke it if you do not know it.');
    expect(text).toContain('Flint may do 1 thing on its own: world.sync.github.');
    expect(text).toContain('You have 1 limit in force: mcp:*.');
    expect(text).toContain('You have 1 triage rule in force: quiet_ci.');
    for (const l of lines) expect(l, l).toMatch(/^([A-Z].*[.:]|  pnpm .*)$/);
    // When the database in use could not be read, or there is none (a rebuild), that is said first.
    expect(carryLines({ ...emptyReport, currentRead: false }, 'UTC', 'production')[0]).toMatch(/could not read the database in use, so anything you revoked, switched off or told Flint to forget after this backup may be back/);
    expect(carryLines({ ...emptyReport, currentRead: false }, 'UTC', 'rebuild')[0]).toMatch(/The rebuilt Flint starts from the backup/);
    // No key at all: the command that enrols one, on a line of its own.
    const bare = carryLines(emptyReport, 'UTC', 'production');
    expect(bare).toContain('No approval key is live after this restore. Enrol one with this command:');
    expect(bare).toContain('  pnpm --silent --filter @flint/runtime enroll --replace');
    expect(bare).toContain('Flint may do nothing on its own after this restore: every action asks you first.');
  });

  describe('the runtime is stopped and started through launchctl, with fixed arguments', () => {
    const home = scratchDir('flint-agent-');
    mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true });
    const plist = join(home, 'Library', 'LaunchAgents', 'com.flint.runtime.plist');
    writeFileSync(plist, '');
    const RUNNING = 'gui/501/com.flint.runtime = {\n\tstate = running\n\tpid = 4242\n}\n';
    const WAITING = 'gui/501/com.flint.runtime = {\n\tstate = not running\n}\n';
    /** A launchd of its own: `print` answers from `state`, the rest change it. */
    const launchd = (start: 'running' | 'waiting' | 'absent', over: (args: string[], s: { state: string; calls: string[][] }) => string | undefined = () => undefined) => {
      const s = { state: start as string, calls: [] as string[][], waited: 0 };
      const exec = async (bin: string, args: string[]) => {
        s.calls.push([bin, ...args]);
        const custom = over(args, s);
        if (custom !== undefined) return custom;
        if (args[0] === 'print') {
          if (s.state === 'absent') throw new Error('Could not find service');
          return s.state === 'running' ? RUNNING : WAITING;
        }
        if (args[0] === 'bootout') s.state = 'absent';
        if (args[0] === 'bootstrap' || args[0] === 'kickstart') s.state = 'running';
        return '';
      };
      return { s, agent: runtimeAgent(home, 501, exec, async (ms) => void (s.waited += ms)) };
    };

    it('stop boots it out and returns once launchd has let go; one already stopped is left alone', async () => {
      const a = launchd('running');
      await a.agent.stop();
      expect(a.s.calls).toEqual([
        ['/bin/launchctl', 'print', 'gui/501/com.flint.runtime'],
        ['/bin/launchctl', 'bootout', 'gui/501/com.flint.runtime'],
        ['/bin/launchctl', 'print', 'gui/501/com.flint.runtime'],
      ]);
      const b = launchd('absent');
      await b.agent.stop();
      expect(b.s.calls).toHaveLength(1);
    });

    it('stop waits longer than launchd’s own 30 seconds for a job that will not let go, then refuses', async () => {
      const a = launchd('running', (args) => (args[0] === 'bootout' ? '' : undefined));
      await expect(a.agent.stop()).rejects.toThrow(/did not stop, so Flint did not swap the databases/);
      expect(a.s.waited).toBeGreaterThanOrEqual(40_000);
    });

    it('start loads it and returns only once launchd says it is running, twice in a row', async () => {
      const a = launchd('absent');
      await a.agent.start();
      expect(a.s.calls[0]).toEqual(['/bin/launchctl', 'print', 'gui/501/com.flint.runtime']);
      expect(a.s.calls[1]).toEqual(['/bin/launchctl', 'bootstrap', 'gui/501', plist]);
      expect(a.s.calls.filter((c) => c[1] === 'print').length).toBeGreaterThanOrEqual(4);
      expect(a.agent.startCommand).toBe('  launchctl bootstrap gui/501 ~/Library/LaunchAgents/com.flint.runtime.plist');
    });

    it('loaded is not running: one that is loaded and stopped is kicked, and one that never stays up is an error', async () => {
      const kicked = launchd('waiting');
      await kicked.agent.start();
      expect(kicked.s.calls.map((c) => c[1])).toContain('kickstart');
      // It starts, dies, starts, dies: never running twice in a row.
      let prints = 0;
      const flapping = launchd('running', (args) => (args[0] === 'print' ? (prints++ % 2 ? WAITING : RUNNING) : undefined));
      await expect(flapping.agent.start()).rejects.toThrow(/did not stay running/);
      const dead = launchd('waiting', (args) => (args[0] === 'kickstart' ? '' : undefined));
      await expect(dead.agent.start()).rejects.toThrow(/did not stay running/);
    });

    it('start says why when it cannot load it: no LaunchAgent file, or launchd keeps refusing', async () => {
      const gone = runtimeAgent(scratchDir('flint-agent-'), 501, async () => { throw new Error('Could not find service'); }, async () => {});
      await expect(gone.start()).rejects.toThrow(/LaunchAgent file is missing/);
      const refused = launchd('absent', (args) => { if (args[0] === 'bootstrap') throw new Error('Bootstrap failed: 5: Input/output error'); return undefined; });
      await expect(refused.agent.start()).rejects.toThrow(/Bootstrap failed: 5/);
      expect(refused.s.calls.filter((c) => c[1] === 'bootstrap')).toHaveLength(5);
    });

    it('the real launchctl is never run from here: a config that does not allow it has it refused before anything starts', async () => {
      // No exec is handed in, so the command would use the real one. The config a test builds does not allow launchctl,
      // and the config the command loads for itself does not either while a test runner is running it.
      const err = await restoreProductionCommand(['--repair'], { ...config, ownerUrl: 'postgresql://flint_owner:x@[::1]:1/Bad-Name' }, io).then(() => undefined, (e: unknown) => e);
      expect(err).toBeInstanceOf(RestoreRefused);
      expect(process.env.VITEST).toBeTruthy();
      const { loadRestoreConfig } = await import('../src/config');
      const fake = scratchDir('flint-cfg-');
      const saved = { ...process.env };
      try {
        Object.assign(process.env, { HOME: fake, FLINT_DB_OWNER_URL: config.ownerUrl, FLINT_DB_URL: config.appUrl, FLINT_DB_RESTORE_URL: config.restoreUrl });
        const loaded = loadRestoreConfig();
        expect(loaded.launchctl).toBe(false);
        expect(loaded.fingerprintKey).toBe(join(fake, '.flint', 'backup-fingerprint.key'));
        expect(loaded.holdFile).toBe(join(fake, '.flint', 'deploy-hold'));
      } finally {
        for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
        Object.assign(process.env, saved);
      }
      const agent = runtimeAgent('/nonexistent', 501, (await import('../src/backup/restore-cli')).execFor(false));
      // `print` refused reads as "not loaded", and nothing was started to find that out.
      await expect(agent.stop()).resolves.toBeUndefined();
      await expect((await import('../src/backup/restore-cli')).execFor(false)('/bin/launchctl', ['print', 'gui/501/x'])).rejects.toThrow(/launchctl is not run here/);
    });
  });

  it('a refusal that left the runtime stopped says how to start it, with the command on a line of its own', () => {
    const down = new RestoreRefused('The databases could not be swapped (error). Nothing was changed.', { lines: ['One more.'], runtimeDown: true });
    expect(refusalLines(down, '  launchctl bootstrap gui/501 x')).toEqual([
      'The databases could not be swapped (error). Nothing was changed.', 'One more.', 'The runtime did not start again by itself. Start it with this command:', '  launchctl bootstrap gui/501 x',
    ]);
    expect(refusalLines(new RestoreRefused('No.'), 'x')).toEqual(['No.']);
  });

  it('a tool’s own words never reach Will or a log: only what kind of failure it was, and the object it names', () => {
    const noisy = [
      'pg_restore: error: could not execute query: ERROR:  duplicate key value violates unique constraint "Proposal_pkey"',
      'DETAIL:  Key (id)=(secret-row-id) already exists.',
      'Command was: INSERT INTO "Goal" (id, words) VALUES (1, \'what Will wrote\');',
    ].join('\n');
    expect(toolError(noisy)).toBe('it reported an error');
    expect(toolError('pg_restore: error: connection to server at "::1", port 5432 failed: FATAL:  password authentication failed for user "flint_restore"')).toBe('password authentication failed for user "flint_restore"');
    expect(toolError('pg_restore: error: unsupported version (1.16) in file header')).toBe('unsupported version (1.16) in file header');
    expect(toolError('ERROR:  permission denied for table Approval\nCONTEXT: COPY Approval, line 3: "secret"')).toBe('permission denied for table Approval');
    expect(toolError('pg_dump: error: aborting because of server version mismatch')).toBe('server version mismatch');
    const failed = new ToolFailed('pg_restore', 1, toolError(noisy));
    expect(failed.message).toBe('pg_restore exited 1: it reported an error');
    expect(failed.message).not.toMatch(/secret|Will wrote/);
  });

  it('a difference between two databases names the object, and a date-named partition a database has outgrown is not one', () => {
    const reference = [
      'function|public.consume_approval(text)|CREATE FUNCTION a', 'trigger|public."Approval"|Approval_consume_once|CREATE TRIGGER x|enabled=O',
      'relation|flint_part."AuditEntry_<month>"|kind=r', 'relation|pgboss.queue_stats_<day>|kind=r', 'may|flint_app INSERT public.AuditEntry',
    ];
    expect(catalogDifference(reference, reference).objects).toEqual([]);
    // The restored database has lived past the months the reference was built with: fine.
    expect(catalogDifference(reference, reference.filter((l) => !/<month>|<day>/.test(l))).objects).toEqual([]);
    const tampered = [
      'function|public.consume_approval(text)|CREATE FUNCTION b', 'trigger|public."Approval"|Approval_consume_once|CREATE TRIGGER x|enabled=D',
      'relation|flint_part."AuditEntry_<month>"|kind=r', 'relation|pgboss.queue_stats_<day>|kind=r', 'function|public.backdoor()|CREATE FUNCTION c', 'may|flint_app INSERT public.Approval',
    ];
    const d = catalogDifference(reference, tampered);
    expect(d.objects).toEqual([
      'the function public.backdoor() is not one Flint makes',
      'the function public.consume_approval(text) is different',
      'the trigger Approval_consume_once on public."Approval" is different',
      'what a role may do (flint_app INSERT public.Approval) is not one Flint makes',
      'what a role may do (flint_app INSERT public.AuditEntry) is missing',
    ]);
    expect(differenceSentence(d, 2)).toBe('the function public.backdoor() is not one Flint makes; the function public.consume_approval(text) is different; and 3 more');
  });
});

describe.skipIf(NO_CLUSTER)('restore (a throwaway cluster)', () => {
  let cluster: ScratchCluster;
  let home: string;
  let urls: { owner: string; app: string; approver: string; backup: string; restore: string };
  let dumpDir: string;
  let copyDir: string;
  let keyFile: string;
  let dump = '';
  let dumpSha = '';
  let takenAt: Date;
  let ids: { pending: string; approved: string; executing: string; executed: string; thing: string };
  let keys: { a: TestKey; b: TestKey };
  let policy: { keep: string; off: string; byB: string };
  let rule: string;
  let n = 0;
  /** A time of its own for every run (the scratch and kept databases are named by it), counted from now. */
  const base = Math.floor(Date.now() / 1000) * 1000;
  let ticks = 0;
  const tick = (): Date => new Date(base + ++ticks * 1000);

  const admin = <T>(fn: (c: pg.Client) => Promise<T>, database = 'postgres'): Promise<T> => connect({ ...cluster.admin, database }, fn);
  /** A pending proposal, as the runtime would create it. */
  const proposal = async (app: string, pid = id('prop')): Promise<string> => {
    await connect(app, (c) =>
      c.query(
        `INSERT INTO "Proposal" (id, kind, origin, action, args, "argsDigest", "argsProvenance", "expiresAt")
         VALUES ($1, 'tool_call', 'console', 'world.sync.github', '{"a":1}', $2, '{}', now() + interval '1 hour')`,
        [pid, DIGEST],
      ),
    );
    return pid;
  };
  const statusOf = (owner: string, pid: string) =>
    connect(owner, async (c) => (await c.query<{ status: string; error: string | null }>('SELECT status, error FROM "Proposal" WHERE id = $1', [pid])).rows[0]);
  const one = <T = Record<string, unknown>>(url: string, sql: string, params: unknown[] = []): Promise<T | undefined> => connect(url, async (c) => (await c.query(sql, params)).rows[0] as T | undefined);
  const databases = (prefix = 'flint') => admin(async (c) => (await c.query<{ datname: string }>(`SELECT datname FROM pg_database WHERE left(datname, $1) = $2 ORDER BY 1`, [prefix.length, prefix])).rows.map((r) => r.datname));
  const isOpen = (name: string) => admin(async (c) => (await c.query<{ datallowconn: boolean }>('SELECT datallowconn FROM pg_database WHERE datname = $1', [name])).rows[0]?.datallowconn);
  /** A kept database is closed: to look inside one, a test opens it. */
  const openKept = async (name: string): Promise<string> => {
    await admin((c) => c.query(`ALTER DATABASE ${name} ALLOW_CONNECTIONS true`));
    return onDb(urls.owner, name);
  };

  interface Scenario { name: string; owner: string; app: string; approver: string; backup: string; marker: string }
  /**
   * A production database of its own for one scenario: a copy of what `flint`
   * held when the backup was taken, set up as a Flint database is, plus one
   * row made "after the backup".
   */
  const production = async (): Promise<Scenario> => {
    const name = `flint_s${++n}`;
    await admin(async (c) => {
      await c.query(`CREATE DATABASE ${name} TEMPLATE flint_seed OWNER flint_owner`);
      // What the first migration does to the database it runs in, which a copy does not inherit.
      await c.query(`REVOKE TEMPORARY ON DATABASE ${name} FROM PUBLIC`);
    });
    const marker = await proposal(onDb(urls.app, name), id('after'));
    return { name, owner: onDb(urls.owner, name), app: onDb(urls.app, name), approver: onDb(urls.approver, name), backup: onDb(urls.backup, name), marker };
  };

  const calls: string[] = [];
  const said: string[] = [];
  const records: Array<Record<string, unknown>> = [];
  const options = (p: { owner: string; app: string; backup?: string }, over: Partial<RestoreOptions> = {}): RestoreOptions => ({
    mode: 'production',
    dump,
    owner: p.owner,
    app: p.app,
    restore: urls.restore,
    ...(p.backup ? { backup: p.backup } : {}),
    copyDir,
    keyFile,
    tools: cluster.tools,
    migrationsDir: MIGRATIONS,
    migrate,
    confirm: async () => true,
    stopRuntime: async () => void calls.push('stop'),
    startRuntime: async () => void calls.push('start'),
    say: (l) => said.push(l),
    now: tick(),
    drainMs: 20_000,
    record: (e) => records.push(e),
    ...over,
  });
  const fresh = (): void => {
    calls.length = 0;
    said.length = 0;
    records.length = 0;
  };

  beforeAll(async () => {
    cluster = await startScratchCluster();
    home = scratchDir('flint-restore-');
    dumpDir = join(home, 'FlintBackups', 'pg');
    copyDir = join(home, 'FlintBackups', 'pre-restore');
    keyFile = join(home, '.flint', 'backup-fingerprint.key');
    await bootstrapDb({ admin: cluster.admin, port: cluster.port, home });
    const env = readEnv(join(home, '.flint', 'secrets.env'));
    const backupEnv = readEnv(join(home, '.flint', 'backup.env'));
    urls = { owner: env.FLINT_DB_OWNER_URL!, app: env.FLINT_DB_URL!, approver: env.FLINT_DB_APPROVER_URL!, backup: env.FLINT_DB_BACKUP_URL!, restore: backupEnv.FLINT_DB_RESTORE_URL! };
    await migrate(urls.owner);

    // What the database held when the backup was taken. Two keys; one card of each kind and one approval not yet used;
    // three promotions (one that stays, one Will switches off later, one signed by the key he revokes later); a rule;
    // something Flint knows; a job waiting; a cap partly used.
    keys = { a: await enrollKey(urls.approver, 'Studio'), b: await enrollKey(urls.approver, 'Old laptop') };
    const approve = async (pid: string) => {
      const approvalId = await keys.a.approve({ subjectId: pid, action: 'world.sync.github', argsDigest: DIGEST });
      await connect(urls.app, (c) => c.query(`UPDATE "Proposal" SET status = 'approved', "approvalId" = $2 WHERE id = $1`, [pid, approvalId]));
    };
    const thing = id('ent');
    ids = { pending: await proposal(urls.app), approved: await proposal(urls.app), executing: await proposal(urls.app), executed: await proposal(urls.app), thing };
    await approve(ids.approved);
    await approve(ids.executing);
    await approve(ids.executed);
    await connect(urls.app, async (c) => {
      await c.query(`UPDATE "Proposal" SET status = 'executing' WHERE id = ANY($1)`, [[ids.executing, ids.executed]]);
      await c.query(`UPDATE "Proposal" SET status = 'executed', "executedAt" = now(), result = '{}' WHERE id = $1`, [ids.executed]);
      await c.query(`INSERT INTO "Entity" (id, kind, key, name, state, "stateHash", "lastObservedAt", "updatedAt") VALUES ($1, 'project', $1, 'Something', '{}', $2, now(), now())`, [thing, DIGEST]);
      await c.query(`SELECT claim_action('notify.push', to_char(now(), 'YYYY-MM-DD'), 5)`);
    });
    await keys.a.approve({ subjectId: ids.pending, action: 'world.sync.github', argsDigest: DIGEST }); // signed, not yet used
    policy = {
      keep: await signedPolicy(urls, keys.a, { pattern: 'world.sync.github', tier: 'alone', dailyCap: 5 }),
      off: await signedPolicy(urls, keys.a, { pattern: 'backup.local', tier: 'alone' }),
      byB: await signedPolicy(urls, keys.b, { pattern: 'digest.send', tier: 'alone' }),
    };
    rule = await signedRule(urls, keys.a, 'quiet_ci');
    await connect(urls.owner, (c) => c.query(`INSERT INTO pgboss.job (name, data) VALUES ('deliver', '{"escalationId":"x"}')`));

    takenAt = new Date();
    const d = await dumpDatabase(urls.backup, dumpDir, cluster.tools, takenAt);
    writeDumpHash(d.path, d.sha256, keyFile);
    dump = d.path;
    dumpSha = d.sha256;
    // ...and one thing that happened after it, which a restore leaves out.
    await proposal(urls.app, 'afterbackup');
    // Every scenario starts from a copy of this.
    await admin(async (c) => {
      await c.query('CREATE DATABASE flint_seed TEMPLATE flint OWNER flint_owner');
      await c.query('REVOKE TEMPORARY ON DATABASE flint_seed FROM PUBLIC');
    });
  });
  afterAll(() => cluster?.stop());

  describe('a dump is checked before anything is restored', () => {
    const copyOf = (name = dumpNameAt(new Date(takenAt.getTime() - 86_400_000)), withHash = true) => {
      const dir = scratchDir('flint-dump-');
      const to = join(dir, name);
      cpSync(dump, to);
      chmodSync(to, 0o600);
      cpSync(`${dump}.counts.json`, `${to}.counts.json`);
      // A fingerprint file is sealed for one name: a copy under another name gets its own.
      if (withHash) writeDumpHash(to, dumpSha, keyFile);
      return to;
    };
    const check = (file: string, over: Parameters<typeof checkDump>[2] = {}) => checkDump(file, cluster.tools, { keyFile, ...over });

    it('a whole dump passes, and says when it was taken and that it is unchanged', async () => {
      const c = await check(dump);
      expect(c.fingerprint).toBe('matches');
      expect(c.takenAt.toISOString()).toBe(takenAt.toISOString());
      expect(c.sha256).toBe(dumpSha);
      expect(c.counts!['public."Proposal"']).toBeGreaterThanOrEqual(4);
      // The fingerprint file, and the key that seals it, are the owner's alone.
      expect(statSync(`${dump}.sha256`).mode & 0o777).toBe(0o600);
      expect(statSync(keyFile).mode & 0o777).toBe(0o600);
      expect(readFileSync(`${dump}.sha256`, 'utf8')).toMatch(/^[0-9a-f]{64}\ncounts [0-9a-f]{64}\nhmac [0-9a-f]{64}\n$/);
    });

    it('refuses a file that is not a nightly dump, is missing, is a link, or that others may write', async () => {
      await expect(check(basename(dump))).rejects.toThrow(/full path/);
      await expect(check(copyOf('other.dump', false))).rejects.toThrow(/not one of Flint's nightly/);
      await expect(check(copyOf('flint-2026-13-45T99-99-99-000Z.dump', false))).rejects.toThrow(/not one of Flint's nightly/);
      await expect(check(join(dumpDir, dumpNameAt(new Date(takenAt.getTime() - 9 * 86_400_000))))).rejects.toThrow(/does not exist/);
      const real = copyOf();
      const link = join(scratchDir('flint-dump-'), basename(real));
      symlinkSync(real, link);
      await expect(check(link)).rejects.toThrow(/not a plain file/);
      chmodSync(real, 0o664);
      await expect(check(real)).rejects.toThrow(/could have changed/);
    });

    it('every record of its fingerprint must match: the file beside it AND what the database recorded', async () => {
      const good = copyOf();
      const other = 'f'.repeat(64);
      // Both there and both right.
      expect((await check(good, { recorded: [dumpSha] })).fingerprint).toBe('matches');
      // The file beside it is right and the database's record is not: refused. (The file beside it can no longer overrule the record.)
      await expect(check(good, { recorded: [other] })).rejects.toThrow(/has changed since it was written/);
      await expect(check(good, { recorded: [dumpSha, other] })).rejects.toThrow(/has changed since it was written/);
      await expect(check(good, { recorded: ['not a hash'] })).rejects.toThrow(/fingerprint recorded for that backup is not readable/);
      // The record is right and the file beside it is not: refused.
      writeFileSync(`${good}.sha256`, `${other}\n`, { mode: 0o600 });
      await expect(check(good, { recorded: [dumpSha] })).rejects.toThrow(/has changed since it was written/);
      // The dump itself changed.
      const changed = copyOf();
      writeFileSync(changed, Buffer.concat([readFileSync(changed), Buffer.from('x')]), { mode: 0o600 });
      await expect(check(changed)).rejects.toThrow(/has changed since it was written/);
      await expect(check(copyOf(undefined, false), { recorded: [other] })).rejects.toThrow(/has changed since it was written/);
    });

    it('a fingerprint file counts only when this Mac’s key sealed it, for this dump and these counts', async () => {
      // A plain hash anyone could have written beside a changed dump is compared, and is not a record.
      const plain = copyOf(undefined, false);
      writeFileSync(`${plain}.sha256`, `${dumpSha}\n`, { mode: 0o600 });
      const none = await refusal(check(plain));
      expect(none.message).toBe('No fingerprint was recorded for that backup, so Flint cannot tell whether it has been changed. Nothing was restored.');
      expect(none.lines).toEqual(['To restore it all the same, add --without-fingerprint to the command.']);
      expect((await check(plain, { withoutFingerprint: true })).fingerprint).toBe('none');
      expect((await check(plain, { recorded: [dumpSha] })).fingerprint).toBe('matches');
      // No file and no record at all.
      await expect(check(copyOf(undefined, false))).rejects.toThrow(/No fingerprint was recorded/);
      // Sealed with another key, or for another dump's name: refused outright.
      const foreign = copyOf();
      const otherKey = join(scratchDir('flint-key-'), 'key');
      writeDumpHash(foreign, dumpSha, otherKey);
      await expect(check(foreign)).rejects.toThrow(/was not written by this Mac's Flint/);
      const renamed = copyOf(dumpNameAt(new Date(takenAt.getTime() - 2 * 86_400_000)));
      cpSync(`${dump}.sha256`, `${renamed}.sha256`);
      await expect(check(renamed)).rejects.toThrow(/was not written by this Mac's Flint/);
      // The counts are sealed with it: changed counts are caught even though they are valid.
      const recount = copyOf();
      const counts = JSON.parse(readFileSync(`${recount}.counts.json`, 'utf8')) as Record<string, number>;
      counts['public."Proposal"'] = 0;
      writeFileSync(`${recount}.counts.json`, JSON.stringify(counts));
      await expect(check(recount)).rejects.toThrow(/row counts beside that backup have changed/);
      // A key file others can read is no key.
      const loose = join(scratchDir('flint-key-'), 'key');
      writeFileSync(loose, `${'ab'.repeat(32)}\n`, { mode: 0o644 });
      expect(() => writeDumpHash(copyOf(undefined, false), dumpSha, loose)).toThrow(/only its owner can read/);
      writeFileSync(`${foreign}.sha256`, 'not a hash\n');
      await expect(check(foreign)).rejects.toThrow(/fingerprint saved with that backup is not readable/);
    });

    it('refuses a damaged or empty dump, and one without readable counts', async () => {
      const cut = copyOf(undefined, false);
      truncateSync(cut, 200);
      await expect(check(cut, { withoutFingerprint: true })).rejects.toThrow(/damaged/);
      truncateSync(cut, 0);
      await expect(check(cut, { withoutFingerprint: true })).rejects.toThrow(/empty/);
      const noCounts = copyOf(undefined, false);
      rmSync(`${noCounts}.counts.json`);
      await expect(check(noCounts, { recorded: [dumpSha] })).rejects.toThrow(/no row counts/);
      expect((await check(noCounts, { recorded: [dumpSha], countsOptional: true })).counts).toBeUndefined();
      for (const bad of ['not json', '[]', '{}', '{"public.\\"Proposal\\"": -1}', '{"public.x; DROP TABLE y": 1}', '{"public.\\"Proposal\\"": "4"}']) {
        writeFileSync(`${noCounts}.counts.json`, bad);
        await expect(check(noCounts, { recorded: [dumpSha], countsOptional: true }), bad).rejects.toThrow(/row counts beside that backup are not readable/);
      }
    });

    it('a tool that cannot be started is this Mac’s fault, not the file’s; a backup from a newer Postgres says so', async () => {
      // No pg_restore at all: a fault that is passed on, never "that backup is damaged".
      const err = await checkDump(dump, { ...cluster.tools, pgRestore: '/nonexistent/pg_restore' }, { keyFile }).then(() => undefined, (e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(RestoreRefused);
      expect((err as { code?: string }).code).toBe('ENOENT');
      // A pg_restore older than the dump.
      const old = join(scratchDir('flint-tool-'), 'pg_restore');
      writeFileSync(old, '#!/bin/sh\necho "pg_restore: error: unsupported version (1.99) in file header" >&2\nexit 1\n', { mode: 0o700 });
      await expect(checkDump(dump, { ...cluster.tools, pgRestore: old }, { keyFile })).rejects.toThrow(/made by a newer Postgres than this Mac has/);
    });
  });

  describe('restore.production', () => {
    it('restores beside the database in use, checks the copy, swaps the names in one step, and keeps the old database closed', async () => {
      fresh();
      const before = await databases();
      const holdFile = join(home, '.flint', 'deploy-hold');
      let held = '';
      let asked: RestoreSummary | undefined;
      const now = tick();
      const r = await restoreDatabase(options(urls, { now, holdFile, confirm: async (s) => { asked = s; held = readFileSync(holdFile, 'utf8'); return true; } }));
      const keptAs = `flint_damaged_${stampOf(now)}`;
      expect(r).toMatchObject({ mode: 'production', database: 'flint', keptAs, fingerprint: 'matches', pending: [], runtimeStarted: true, audited: true, leftovers: [], removed: [] });
      expect(r.report).toMatchObject({ currentRead: true, approvals: 1, proposals: 2, jobs: 1 });
      expect(r.tables).toBeGreaterThan(15);
      expect(calls).toEqual(['stop', 'start']);
      expect(said).toEqual([
        'The backup restored and passed its checks.',
        'Flint copied the current database first.',
        'Flint is waiting for everything else to let go of the database. This can take up to a minute.',
      ]);
      expect(await databases()).toEqual([...before, keptAs].sort());

      // He was asked with the copy already restored and checked, and read what would be in force.
      expect(asked).toMatchObject({ name: basename(dump), database: 'flint', keptAs, fingerprint: 'matches', removing: [] });
      expect(asked!.report.liveKeys.map((k) => k.label).sort()).toEqual(['Old laptop', 'Studio']);
      // Updates were paused for as long as it ran, and are not paused now.
      expect(held).toMatch(new RegExp(`^restore ${process.pid} `));
      expect(existsSync(holdFile)).toBe(false);

      // The production name now holds the backup: what came after it is gone from there...
      expect(await statusOf(urls.owner, 'afterbackup')).toBeUndefined();
      // ...and kept, untouched, under the other name, closed until Will opens it.
      expect(await isOpen(keptAs)).toBe(false);
      await expect(connect(onDb(urls.owner, keptAs), (c) => c.query('SELECT 1'))).rejects.toMatchObject({ code: '55000' });
      const kept = await openKept(keptAs);
      expect(await statusOf(kept, 'afterbackup')).toMatchObject({ status: 'pending' });
      expect(await statusOf(kept, ids.approved)).toMatchObject({ status: 'approved' });

      // Nothing signed before the backup can act after it; what was only waiting still waits, and what had finished stays finished.
      expect(await statusOf(urls.owner, ids.approved)).toEqual({ status: 'failed', error: VOIDED_BY_RESTORE });
      expect(await statusOf(urls.owner, ids.executing)).toEqual({ status: 'failed', error: VOIDED_BY_RESTORE });
      expect(await statusOf(urls.owner, ids.pending)).toMatchObject({ status: 'pending' });
      expect(await statusOf(urls.owner, ids.executed)).toMatchObject({ status: 'executed' });
      expect((await one<{ n: number }>(urls.owner, `SELECT count(*)::int AS n FROM "Approval" WHERE "consumedAt" IS NULL`))!.n).toBe(0);
      // Nothing queued before the backup runs again.
      expect((await one<{ n: number }>(urls.owner, `SELECT count(*)::int AS n FROM pgboss.job WHERE state IN ('created', 'retry', 'active')`))!.n).toBe(0);
      expect((await one<{ n: number }>(urls.owner, `SELECT count(*)::int AS n FROM pgboss.job WHERE state = 'cancelled'`))!.n).toBe(1);

      // Its own audit entry, written as the runtime's role AFTER the swap, with the time it was written.
      const audit = await connect(urls.app, async (c) => (await c.query(`SELECT actor, context, kind, tier, decision, outcome, inputs, at FROM "AuditEntry" WHERE action = 'restore.production'`)).rows);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ actor: 'will:cli', context: 'console', kind: 'action', tier: 'approval', decision: 'act', outcome: 'ok' });
      expect(audit[0].inputs).toMatchObject({ mode: 'production', sha256: dumpSha, fingerprint: 'matches', approvals: 1, proposals: 2, copied: true, keptAs, currentRead: true });
      expect(Math.abs(Date.now() - new Date(audit[0].at).getTime())).toBeLessThan(120_000);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ outcome: 'ok', mode: 'production', sha256: dumpSha, keptAs });

      // The copy taken first: a dump of the database as it was, 0600, with its counts and a sealed fingerprint.
      expect(r.copy && dirname(r.copy)).toBe(copyDir);
      expect(statSync(r.copy!).mode & 0o777).toBe(0o600);
      expect(statSync(copyDir).mode & 0o777).toBe(0o700);
      expect((await checkDump(r.copy!, cluster.tools, { keyFile })).fingerprint).toBe('matches');
      // The lock is let go, and the role that restored the copy owns nothing.
      expect((await admin(async (c) => (await c.query(`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory'`)).rows[0])).n).toBe(0);
      expect((await admin(async (c) => (await c.query(`SELECT count(*)::int AS n FROM pg_database WHERE datdba = 'flint_restore'::regrole`)).rows[0])).n).toBe(0);

      // The two claims everything else rests on, read from what the server itself saw.
      const log = cluster.log().split('\n');
      const copyName = `flint_restoring_${stampOf(now)}`;
      // 1. The two names changed in ONE transaction: one statement holds both renames, and neither was ever sent alone.
      const renames = log.filter((l) => /statement: .*ALTER DATABASE \S+ RENAME TO /.test(l) && (l.includes(keptAs) || l.includes(`ALTER DATABASE ${copyName} RENAME`)));
      expect(renames).toHaveLength(1);
      expect(renames[0]).toMatch(new RegExp(`statement: BEGIN; ALTER DATABASE flint RENAME TO ${keptAs}; ALTER DATABASE ${copyName} RENAME TO flint; COMMIT;$`));
      // 2. The backup's own SQL ran as the role that owns nothing else: every statement pg_restore sent to the copy was flint_restore's.
      const restored = log.filter((l) => l.includes(`@${copyName} pg_restore `));
      expect(restored.length).toBeGreaterThan(50);
      expect(restored.filter((l) => !l.includes(` flint_restore@${copyName} pg_restore `))).toEqual([]);
      // (The migration owner runs pg_restore too, but only into the reference, which holds nothing but this checkout's own migrations.)
      expect(log.filter((l) => / pg_restore /.test(l) && !/ flint_restore@\S+ pg_restore /.test(l) && !/ flint_owner@flint\w*_reference_\w+ pg_restore /.test(l))).toEqual([]);
      // And until it had passed its checks, nobody but that role read it: the migration owner's first statement in
      // the copy comes after the copy's own properties were cleared.
      const cleared = log.findIndex((l) => l.includes(`statement: ALTER DATABASE ${copyName} RESET ALL`));
      const ownerFirst = log.findIndex((l) => l.includes(` flint_owner@${copyName} `));
      expect(cleared).toBeGreaterThan(-1);
      expect(ownerFirst).toBeGreaterThan(cleared);
      expect(log.slice(0, cleared).some((l) => l.includes(` flint_restore@${copyName} `) && l.includes(`statement: SET search_path = ''`))).toBe(true);
    });

    it('what comes back is built exactly as Flint builds it: the reviewed grants, the migration owner’s, and usable by the runtime and no more', async () => {
      // On a database of its own, restored here: this depends on no other test.
      const p = await production();
      await restoreDatabase(options(p));
      expect(await connect(p.owner, (c) => grantLines(c))).toEqual(JSON.parse(readFileSync(GRANTS_FIXTURE, 'utf8')));
      const v = await admin((main) => connect(p.owner, (c) => verifyRestored(c, { migrationsDir: MIGRATIONS, reference: referenceBuilder(main, urls.owner, 'flint_reference_test', cluster.tools), owner: 'flint_owner', strangers: ['flint_restore'] })));
      expect(v).toMatchObject({ ok: true, problems: [] });
      expect(v.migrations.applied.map((m) => m.name)).toEqual(checkoutMigrations(MIGRATIONS).map((m) => m.name));
      expect(v.migrations.pending).toEqual([]);
      // The runtime's role can do its work in it, and no more than its work.
      await proposal(p.app);
      await expect(connect(p.app, (c) => c.query(`DELETE FROM "AuditEntry"`))).rejects.toThrow(/permission denied/);
      await expect(connect(p.app, (c) => c.query(`CREATE TEMP TABLE t (id integer)`))).rejects.toThrow(/permission denied/);
      // Prisma's own record of a migration is this checkout's file, byte for byte.
      const recorded = await connect(p.owner, async (c) => (await c.query<{ name: string; checksum: string }>('SELECT migration_name AS name, checksum FROM _prisma_migrations ORDER BY 1')).rows);
      expect(recorded).toEqual(checkoutMigrations(MIGRATIONS).map((m) => ({ name: m.name, checksum: m.checksum })));
    });

    it('a trial run (--check) restores and checks beside the database in use, then drops the copy: nothing in use changes, nothing is asked, and it is on record', async () => {
      const p = await production();
      fresh();
      const before = await databases();
      const copies = existsSync(copyDir) ? readdirSync(copyDir).length : 0;
      let asked = false;
      const r = await restoreDatabase(options(p, { checkOnly: true, confirm: async () => { asked = true; return false; } }));
      expect(r).toMatchObject({ checkedOnly: true, fingerprint: 'matches', pending: [] });
      expect(r.tables).toBeGreaterThan(15);
      expect(r.copy).toBeUndefined();
      expect(r.report.liveKeys).toHaveLength(2);
      expect(asked).toBe(false);
      expect(calls).toEqual([]);
      expect(said).toEqual([]);
      expect(await databases()).toEqual(before);
      expect(existsSync(copyDir) ? readdirSync(copyDir).length : 0).toBe(copies);
      // The database in use is exactly as it was: what came after the backup is still there, and nothing signed was voided.
      expect(await statusOf(p.owner, p.marker)).toMatchObject({ status: 'pending' });
      expect(await statusOf(p.owner, ids.approved)).toMatchObject({ status: 'approved' });
      // The trial is on record where it survives: the database in use, and the local file.
      const audit = await connect(p.owner, async (c) => (await c.query(`SELECT actor, decision, outcome, inputs FROM "AuditEntry" WHERE action = 'restore.production'`)).rows);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ actor: 'will:cli', decision: 'log', outcome: 'ok' });
      expect(audit[0].inputs).toMatchObject({ mode: 'check', sha256: dumpSha });
      expect(records).toEqual([expect.objectContaining({ outcome: 'ok', mode: 'check', sha256: dumpSha })]);
      // A backup that would not pass is caught by the trial too, and that is on record as well.
      fresh();
      await expect(restoreDatabase(options(p, { checkOnly: true, migrationsDir: scratchDir('flint-migrations-') }))).rejects.toThrow(/did not pass its checks.*Nothing was changed/);
      expect(await databases()).toEqual(before);
      expect(records).toEqual([expect.objectContaining({ outcome: 'failed', mode: 'check', stage: 'verify' })]);
      expect((await one<{ n: number }>(p.owner, `SELECT count(*)::int AS n FROM "AuditEntry" WHERE action = 'restore.production' AND outcome = 'failed'`))!.n).toBe(1);
    });

    it('a runtime that will not start again afterwards is reported, and the restore stands', async () => {
      const p = await production();
      const r = await restoreDatabase(options(p, { startRuntime: async () => { throw new Error('the runtime did not stay running'); } }));
      expect(r.runtimeStarted).toBe(false);
      expect(await statusOf(p.owner, p.marker)).toBeUndefined();
      expect(await statusOf(await openKept(r.keptAs!), p.marker)).toMatchObject({ status: 'pending' });
    });

    it('a runtime that will not stop: the copy is dropped and nothing is changed; if it then will not start either, that is said', async () => {
      const p = await production();
      fresh();
      const before = await databases();
      const stuck = async () => { calls.push('stop'); throw new RestoreRefused('The runtime did not stop, so Flint did not swap the databases.', { stage: 'runtime' }); };
      const err = await refusal(restoreDatabase(options(p, { stopRuntime: stuck })));
      expect(err.message).toBe('The runtime did not stop, so Flint did not swap the databases. Nothing was changed.');
      expect(err.runtimeDown).toBe(false);
      expect(calls).toEqual(['stop', 'start']);
      expect(await databases()).toEqual(before);
      expect(await statusOf(p.owner, p.marker)).toMatchObject({ status: 'pending' });
      const down = await refusal(restoreDatabase(options(p, { stopRuntime: stuck, startRuntime: async () => { throw new Error('no'); } })));
      expect(down.message).toMatch(/Nothing was changed\.$/);
      expect(down.runtimeDown).toBe(true);
      expect(await databases()).toEqual(before);
    });

    it('not confirmed: nothing is changed, the runtime is never stopped, and no copy of the database is taken', async () => {
      const p = await production();
      fresh();
      const before = await databases();
      const copies = readdirSync(copyDir).length;
      const err = await refusal(restoreDatabase(options(p, { confirm: async () => false })));
      expect(err.message).toBe('Nothing was changed.');
      expect(calls).toEqual([]);
      expect(await databases()).toEqual(before);
      expect(await statusOf(p.owner, p.marker)).toMatchObject({ status: 'pending' });
      expect(readdirSync(copyDir)).toHaveLength(copies);
      expect(records).toEqual([expect.objectContaining({ outcome: 'skipped', stage: 'confirm' })]);
      expect((await one<{ n: number }>(p.owner, `SELECT count(*)::int AS n FROM "AuditEntry" WHERE action = 'restore.production' AND outcome = 'skipped'`))!.n).toBe(1);
      // With no way to ask at all, the answer is no.
      const { confirm: _confirm, ...silent } = options(p);
      await expect(restoreDatabase(silent)).rejects.toThrow('Nothing was changed.');
      expect(await databases()).toEqual(before);
    });

    it('a copy of the current database that cannot be taken stops it, unless Will said to go on without', async () => {
      const p = await production();
      fresh();
      // A backup role whose password no longer works is caught before anything is restored...
      const badBackup = (() => {
        const u = new URL(p.backup);
        u.password = 'wrong';
        return u.toString();
      })();
      const before = await databases();
      await expect(restoreDatabase(options({ ...p, backup: badBackup }))).rejects.toThrow(/no longer let the role flint_backup sign in/);
      // ...a copy folder that cannot be written is caught when the copy is tried...
      const blocked = join(scratchDir('flint-copy-'), 'file');
      writeFileSync(blocked, '');
      await expect(restoreDatabase(options(p, { copyDir: join(blocked, 'pre') }))).rejects.toThrow(/could not copy the current database first, so it stopped. Nothing was changed/);
      // ...and so is having no way to take one.
      await expect(restoreDatabase(options({ owner: p.owner, app: p.app }))).rejects.toThrow(/no way to copy the current database first/);
      expect(calls).toEqual([]);
      expect(await databases()).toEqual(before);
      expect(await statusOf(p.owner, p.marker)).toMatchObject({ status: 'pending' });

      said.length = 0;
      const r = await restoreDatabase(options(p, { copyDir: join(blocked, 'pre'), withoutCopy: true }));
      expect(r.copy).toBeUndefined();
      expect(said.join(' ')).toMatch(/could not copy the current database first. It is kept under another name all the same/);
      expect(await statusOf(p.owner, p.marker)).toBeUndefined();
      expect(await statusOf(await openKept(r.keptAs!), p.marker)).toMatchObject({ status: 'pending' });
    });

    it('a restored copy that fails its counts is dropped, and the original is left in place', async () => {
      const p = await production();
      const dir = scratchDir('flint-dump-');
      const off = join(dir, basename(dump));
      cpSync(dump, off);
      chmodSync(off, 0o600);
      const counts = JSON.parse(readFileSync(`${dump}.counts.json`, 'utf8')) as Record<string, number>;
      counts['public."Proposal"'] = counts['public."Proposal"']! + 1;
      writeFileSync(`${off}.counts.json`, JSON.stringify(counts));
      fresh();
      const before = await databases();
      await expect(restoreDatabase(options(p, { dump: off, recorded: [dumpSha] }))).rejects.toThrow(/did not pass its checks: row counts differ in 1 table\(s\)\. Nothing was changed\./);
      expect(calls).toEqual([]);
      expect(await databases()).toEqual(before);
      expect(await statusOf(p.owner, p.marker)).toMatchObject({ status: 'pending' });
    });

    it('a backup from a newer Flint, or one whose migrations are not this checkout’s own files, is refused', async () => {
      const p = await production();
      const before = await databases();
      const all = checkoutMigrations(MIGRATIONS);
      const older = scratchDir('flint-migrations-');
      for (const m of all.slice(0, -1)) cpSync(join(MIGRATIONS, m.name), join(older, m.name), { recursive: true });
      await expect(restoreDatabase(options(p, { migrationsDir: older, checkOnly: true }))).rejects.toThrow(/from a newer Flint than this copy of the code.*Nothing was changed/);
      // The same names, with one file's SQL changed: the backup was not built from these.
      const edited = scratchDir('flint-migrations-');
      for (const m of all) cpSync(join(MIGRATIONS, m.name), join(edited, m.name), { recursive: true });
      const first = join(edited, all[0]!.name, 'migration.sql');
      writeFileSync(first, `${readFileSync(first, 'utf8')}\n-- changed\n`);
      await expect(restoreDatabase(options(p, { migrationsDir: edited, checkOnly: true }))).rejects.toThrow(/1 migration\(s\) are not the ones this copy of Flint has.*Nothing was changed/);
      expect(await databases()).toEqual(before);
      expect(await statusOf(p.owner, p.marker)).toMatchObject({ status: 'pending' });
    });

    it('a backup from before a database update is checked as it is, brought up to date, and checked again before it goes live', async () => {
      // A database one migration behind, made the way it would have been at the time: Prisma applying every
      // migration but the newest, into a database of its own. Then a dump of that.
      const all = checkoutMigrations(MIGRATIONS);
      const newest = all.at(-1)!.name;
      const earlier = join(scratchDir('flint-prisma-'), 'prisma');
      mkdirSync(join(earlier, 'migrations'), { recursive: true });
      cpSync(join(RUNTIME, 'prisma', 'schema.prisma'), join(earlier, 'schema.prisma'));
      cpSync(join(MIGRATIONS, 'migration_lock.toml'), join(earlier, 'migrations', 'migration_lock.toml'));
      for (const m of all.slice(0, -1)) cpSync(join(MIGRATIONS, m.name), join(earlier, 'migrations', m.name), { recursive: true });
      await admin((c) => c.query('CREATE DATABASE flint_older OWNER flint_owner'));
      await admin((c) => c.query('ALTER SCHEMA public OWNER TO flint_owner'), 'flint_older');
      await migrate(onDb(urls.owner, 'flint_older'), join(earlier, 'schema.prisma'));
      const old = { backup: onDb(urls.backup, 'flint_older') };
      const olderDumps = join(home, 'older');
      const d = await dumpDatabase(old.backup, olderDumps, cluster.tools, new Date(takenAt.getTime() - 2 * 86_400_000));
      writeDumpHash(d.path, d.sha256, keyFile);

      const p = await production();
      const r = await restoreDatabase(options(p, { dump: d.path }));
      expect(r.pending).toEqual([newest]);
      expect(await connect(p.owner, (c) => migrationState(c, MIGRATIONS))).toMatchObject({ pending: [], problems: [] });
      // A failing update leaves the original in place.
      const q = await production();
      const before = await databases();
      await expect(restoreDatabase(options(q, { dump: d.path, migrate: async () => { throw new Error('a database update failed (P3018)'); } }))).rejects.toThrow(/could not be restored \(Error\)\. Nothing was changed/);
      // One that leaves the copy unlike this checkout's own database is refused too.
      await expect(restoreDatabase(options(q, { dump: d.path, migrate: async () => {} }))).rejects.toThrow(/could not be brought up to date: migrations still pending\. Nothing was changed/);
      expect(await databases()).toEqual(before);
      expect(await statusOf(q.owner, q.marker)).toMatchObject({ status: 'pending' });
    });

    it('something still connected: it says who, puts everything back, and starts the runtime again', async () => {
      const p = await production();
      fresh();
      const before = await databases();
      const err = await connect(p.app, () => refusal(restoreDatabase(options(p, { drainMs: 1500 }))));
      expect(err.message).toMatch(/^Something is still using the database \(flint_app, 1 connection\), so Flint stopped\. Nothing was changed\.$/);
      expect(err.lines).toEqual(['Quit what is connected to it, then run this again.']);
      expect(calls).toEqual(['stop', 'start']);
      expect(await databases()).toEqual(before);
      // The database takes connections again, and still holds what it held.
      expect(await isOpen(p.name)).toBe(true);
      expect(await statusOf(p.owner, p.marker)).toMatchObject({ status: 'pending' });
      expect((await one<{ one: number }>(p.app, 'SELECT 1 AS one'))!.one).toBe(1);
      expect(records).toEqual([expect.objectContaining({ outcome: 'failed', stage: 'drain' })]);
    });

    it('refuses when there is no such database to replace, when this second’s names are taken, and when the settings disagree', async () => {
      await expect(restoreDatabase(options({ owner: onDb(urls.owner, 'flint_nowhere'), app: onDb(urls.app, 'flint_nowhere'), backup: onDb(urls.backup, 'flint_nowhere') }))).rejects.toThrow(/no production database to replace/);
      const p = await production();
      const now = tick();
      await admin((c) => c.query(`CREATE DATABASE ${p.name}_damaged_${stampOf(now)} OWNER flint_owner`));
      await expect(restoreDatabase(options(p, { now }))).rejects.toThrow(/already there/);
      await expect(restoreDatabase(options({ ...p, owner: onDb(p.owner, 'Bad-Name') }))).rejects.toThrow(/not one Flint can rename/);
      for (const reserved of ['postgres', 'template0', 'template1']) {
        await expect(restoreDatabase(options({ owner: onDb(p.owner, reserved), app: onDb(p.app, reserved) })), reserved).rejects.toThrow(/not one Flint can rename/);
      }
      // The runtime's URL, or the backup role's, names another database or another server than the owner's.
      await expect(restoreDatabase(options({ ...p, app: onDb(p.app, 'flint') }))).rejects.toThrow(/do not all name the same database, so it stopped/);
      await expect(restoreDatabase(options({ ...p, backup: onDb(p.backup, 'flint') }))).rejects.toThrow(/do not all name the same database, so it stopped/);
      const elsewhere = new URL(p.app);
      elsewhere.port = String(cluster.port + 1);
      await expect(restoreDatabase(options({ ...p, app: elsewhere.toString() }))).rejects.toThrow(/do not all name the same database server/);
    });

    it('one restore at a time, and none while an update is being installed', async () => {
      const p = await production();
      const before = await databases();
      await expect(restoreDatabase(options(p, { deployRunning: () => true }))).rejects.toThrow('An update is being installed. Wait for it to finish, then run this again.');
      // Another restore holds the lock.
      await connect(onDb(urls.owner, 'postgres'), async (c) => {
        await c.query('SELECT pg_advisory_lock($1, $2)', [0x464c4e54, 7]);
        await expect(restoreDatabase(options(p))).rejects.toThrow('Another restore is running. Wait for it to finish.');
        await expect(repairDatabase({ owner: p.owner, confirm: async () => true, startRuntime: async () => {}, say: () => {} })).rejects.toThrow('A restore is running. Wait for it to finish.');
      });
      expect(await databases()).toEqual(before);
      // A pause on updates that was already there is someone else's: it is left alone.
      const holdFile = join(scratchDir('flint-hold-'), 'deploy-hold');
      writeFileSync(holdFile, 'paused by rollback\n');
      await restoreDatabase(options(p, { holdFile, checkOnly: true }));
      expect(readFileSync(holdFile, 'utf8')).toBe('paused by rollback\n');
    });
  });

  describe('a backup that was changed is not believed', () => {
    /** A copy of the seed to tamper with, and the reference its checks compare it with. */
    let untouched: string[] | undefined;
    const doctored = async (change: (c: pg.Client) => Promise<unknown>, as: 'owner' | 'admin' = 'owner') => {
      const p = await production();
      // Compared with the same database before anyone changed it: every difference found is the change made here.
      untouched ??= await connect(onDb(urls.owner, 'flint_seed'), (c) => catalogLines(c));
      if (as === 'owner') await connect(p.owner, change);
      else await admin(change, p.name);
      const v = await connect(p.owner, (c) => verifyRestored(c, { migrationsDir: MIGRATIONS, reference: async () => untouched!, owner: 'flint_owner', strangers: ['flint_restore'] }));
      return { p, v, text: v.problems.join(' | ') };
    };

    it('an untouched copy passes, and its lines are the reference’s own', async () => {
      const { v } = await doctored(async () => {});
      expect(v).toMatchObject({ ok: true, problems: [] });
      const lines = await connect(urls.owner, (c) => catalogLines(c));
      expect(lines.filter((l) => l.startsWith('trigger|')).length).toBeGreaterThan(20);
      expect(lines.filter((l) => l.startsWith('function|')).length).toBeGreaterThan(20);
      expect(lines.some((l) => l.includes('AuditEntry_<month>'))).toBe(true);
      expect(lines.some((l) => /AuditEntry_\d{4}_\d{2}/.test(l))).toBe(false);
    });

    it('a guard that was dropped, switched off, or rewritten is named', async () => {
      expect((await doctored((c) => c.query('DROP TRIGGER "Approval_consume_once" ON "Approval"'))).text).toMatch(/the trigger Approval_consume_once on public.Approval is missing/);
      expect((await doctored((c) => c.query('ALTER TABLE "AuditEntry" DISABLE TRIGGER "AuditEntry_append_only"'))).text).toMatch(/the trigger AuditEntry_append_only on public.AuditEntry is different/);
      expect((await doctored((c) => c.query(`CREATE OR REPLACE FUNCTION approval_insert_check() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END; $$`))).text).toMatch(/the function public.approval_insert_check\(\) is different/);
      // The same body, now running with its owner's rights.
      expect((await doctored((c) => c.query('ALTER FUNCTION proposal_insert_check() SECURITY DEFINER'))).text).toMatch(/the function public.proposal_insert_check\(\) is different/);
      expect((await doctored((c) => c.query(`CREATE FUNCTION backdoor() RETURNS void LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1 $$`))).text).toMatch(/the function public.backdoor\(\) is not one Flint makes/);
      expect((await doctored((c) => c.query('ALTER TABLE "ActionPolicy" DROP CONSTRAINT "ActionPolicy_tier_check"'))).text).toMatch(/the constraint ActionPolicy_tier_check on public.ActionPolicy is missing/);
      expect((await doctored((c) => c.query(`CREATE RULE quiet AS ON INSERT TO "AuditEntry" DO INSTEAD NOTHING`))).text).toMatch(/the rule quiet on public.AuditEntry is not one Flint makes/);
      expect((await doctored((c) => c.query(`CREATE TABLE "AuditEntry_2099_01" (id text)`))).text).toMatch(/AuditEntry_<month>/);
    });

    it('a privilege that was added or taken away is named, in each direction', async () => {
      expect((await doctored((c) => c.query('GRANT INSERT ON "Approval" TO flint_app'))).text).toMatch(/flint_app holding INSERT on the table public.Approval is not one Flint makes/);
      expect((await doctored((c) => c.query('GRANT UPDATE ON "AuditEntry" TO flint_app'))).text).toMatch(/flint_app holding UPDATE/);
      expect((await doctored((c) => c.query('REVOKE INSERT ON "AuditEntry" FROM flint_app'))).text).toMatch(/flint_app holding INSERT on the table public.AuditEntry is missing/);
      expect((await doctored((c) => c.query('GRANT SELECT ON "Proposal" TO flint_approver'))).text).toMatch(/flint_approver holding SELECT/);
      expect((await doctored((c) => c.query('GRANT EXECUTE ON FUNCTION forget_entity(text, text) TO PUBLIC'))).text).toMatch(/PUBLIC holding EXECUTE on the function public.forget_entity/);
      expect((await doctored((c) => c.query('GRANT UPDATE ("revokedAt") ON "ApprovalCredential" TO flint_app'))).text).toMatch(/flint_app holding UPDATE on the column public.ApprovalCredential.revokedAt/);
      // A temp table could shadow a governance table; a schema an application role may create in could hold anything.
      const temp = await doctored(async (c) => { await c.query(`DO $$ BEGIN EXECUTE format('GRANT TEMPORARY ON DATABASE %I TO flint_app', current_database()); END $$`); });
      expect(temp.text).toMatch(/what a role may do \(flint_app TEMP database\) is not one Flint makes/);
      expect((await doctored((c) => c.query('GRANT CREATE ON SCHEMA public TO flint_app'))).text).toMatch(/flint_app holding CREATE on the schema public/);
      expect((await doctored((c) => c.query('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO flint_app'))).text).toMatch(/a default privilege/);
    });

    it('something that belongs to another role, or that the restoring role still holds, is named', async () => {
      const stray = await doctored(async (c) => { await c.query('ALTER TABLE "Proposal" OWNER TO scratch_admin'); }, 'admin');
      expect(stray.text).toMatch(/1 thing\(s\) in it do not belong to the migration owner \(the table or view public.Proposal\)/);
      const held = await doctored((c) => c.query('GRANT SELECT ON "Proposal" TO flint_restore'));
      expect(held.text).toMatch(/a privilege of flint_restore/);
    });

    it('a migration that never finished, or a record with no migration in it, is refused', async () => {
      const unfinished = await doctored((c) => c.query(`UPDATE _prisma_migrations SET finished_at = NULL WHERE migration_name = (SELECT max(migration_name) FROM _prisma_migrations)`));
      expect(unfinished.text).toMatch(/1 migration\(s\) never finished/);
      const none = await doctored((c) => c.query('DELETE FROM _prisma_migrations'));
      expect(none.text).toMatch(/no Flint migration is recorded/);
      const twice = await doctored((c) => c.query(`INSERT INTO _prisma_migrations (id, checksum, finished_at, migration_name) SELECT 'again', checksum, now(), migration_name FROM _prisma_migrations LIMIT 1`));
      expect(twice.text).toMatch(/a migration is recorded twice/);
    });

    it('end to end: a dump with a guard switched off is restored beside, refused by name, and dropped', async () => {
      const bad = await production();
      await connect(bad.owner, (c) => c.query('ALTER TABLE "Approval" DISABLE TRIGGER "Approval_consume_once"'));
      const d = await dumpDatabase(bad.backup, join(home, 'tampered'), cluster.tools, new Date(takenAt.getTime() - 3 * 86_400_000));
      writeDumpHash(d.path, d.sha256, keyFile);
      const p = await production();
      fresh();
      const before = await databases();
      const err = await refusal(restoreDatabase(options(p, { dump: d.path })));
      expect(err.message).toMatch(/did not pass its checks: it is not built the way this copy of Flint builds its database \(the trigger Approval_consume_once on public.Approval is different\)\. Nothing was changed\.$/);
      expect(err.stage).toBe('verify');
      expect(calls).toEqual([]);
      expect(await databases()).toEqual(before);
    });

    it('a promotion Will’s signature does not cover is switched off, and a key the database in use never held is pointed out', async () => {
      // The forger adds a promotion to a card Will really signed, and a whole chain of their own: key, card, approval, promotion.
      const bad = await production();
      const roles = { owner: bad.owner, app: bad.app, approver: bad.approver };
      const theirs = await enrollKey(bad.approver, 'Not Will');
      await signedPolicy(roles, theirs, { pattern: 'mcp:shell.run', tier: 'alone' });
      await connect(bad.owner, async (c) => {
        await c.query('ALTER TABLE "ActionPolicy" DISABLE TRIGGER USER');
        await c.query(`INSERT INTO "ActionPolicy" (id, pattern, tier, reason, "approvalId", "expiresAt") SELECT 'forged', 'selfmod.*', 'alone', 'x', "approvalId", "expiresAt" FROM "ActionPolicy" WHERE id = $1`, [policy.keep]);
        await c.query('ALTER TABLE "ActionPolicy" ENABLE TRIGGER USER');
      });
      const d = await dumpDatabase(bad.backup, join(home, 'forged'), cluster.tools, new Date(takenAt.getTime() - 4 * 86_400_000));
      writeDumpHash(d.path, d.sha256, keyFile);

      const p = await production();
      const r = await restoreDatabase(options(p, { dump: d.path }));
      expect(r.report.unsignedPolicies).toEqual(expect.arrayContaining([
        { pattern: 'selfmod.*', why: 'it is not in the card you signed' },
        { pattern: 'mcp:shell.run', why: 'the key that signed it is not in the database in use' },
      ]));
      const active = await connect(p.owner, async (c) => (await c.query<{ pattern: string }>(`SELECT pattern FROM "ActionPolicy" WHERE active ORDER BY 1`)).rows.map((x) => x.pattern));
      expect(active).toEqual(['backup.local', 'digest.send', 'world.sync.github']);
      // The forger's key is still a row in the backup: it is pointed out, by label, for Will to revoke.
      expect(r.report.liveKeys.find((k) => k.label === 'Not Will')).toMatchObject({ known: false });
      expect(carryLines(r.report, 'UTC', 'production').join('\n')).toMatch(/"Not Will", this Mac's key, enrolled .* It is not in the database in use now: revoke it if you do not know it\./);
    });
  });

  describe('what a backup’s own SQL can reach', () => {
    /**
     * A dump of `source` with SQL added to what restoring it runs: the forgery pg_dump itself never writes, made the
     * way an attacker with the file would make it. `after` goes straight after one table's definition (in the same
     * statement batch); `instead` takes the place of one index's definition (a statement on its own).
     */
    const forged = async (source: Scenario, daysAgo: number, change: { after?: string; instead?: string }): Promise<string> => {
      const t = pgConfig(source.backup);
      // Through a pipe, so the archive carries no offsets and its list of contents can change length.
      let raw: Buffer = execFileSync(cluster.tools.pgDump, ['-Fc', '-h', String(t.host), '-p', String(t.port), '-U', String(t.user), '-d', String(t.database)], {
        env: { PATH: process.env.PATH ?? '', PGPASSWORD: String(t.password) }, maxBuffer: 256 * 1024 * 1024,
      });
      // A string in the list of contents: a sign byte, its length in four bytes, then its bytes.
      const edit = (marker: string, make: (was: Buffer) => Buffer): void => {
        // The first place the marker begins such a string (the same words inside a function's body do not).
        const whole = (i: number): boolean => i > 5 && raw[i - 5] === 0 && raw.readUInt32LE(i - 4) > marker.length && raw.readUInt32LE(i - 4) < 20_000 && /;\n$/.test(raw.subarray(i, i + raw.readUInt32LE(i - 4)).toString('utf8'));
        let at = raw.indexOf(Buffer.from(marker));
        while (at !== -1 && !whole(at)) at = raw.indexOf(Buffer.from(marker), at + 1);
        expect(at, marker).toBeGreaterThan(5);
        const length = raw.readUInt32LE(at - 4);
        const was = raw.subarray(at, at + length);
        const now = make(was);
        const head = Buffer.alloc(4);
        head.writeUInt32LE(now.length);
        raw = Buffer.concat([raw.subarray(0, at - 4), head, now, raw.subarray(at + length)]);
      };
      if (change.after) edit('CREATE TABLE public."Proposal" (', (was) => Buffer.concat([was, Buffer.from(`${change.after}\n`)]));
      if (change.instead) edit('CREATE INDEX ', () => Buffer.from(`${change.instead}\n`));
      const dir = join(home, `forged-${++n}`);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const file = join(dir, dumpNameAt(new Date(takenAt.getTime() - daysAgo * 86_400_000)));
      writeFileSync(file, raw, { mode: 0o600 });
      writeFileSync(`${file}.counts.json`, JSON.stringify(await connect(source.backup, (c) => countRows(c))), { mode: 0o600 });
      // Sealed as this Mac seals its own: the fingerprint is not what stops this file.
      writeDumpHash(file, await sha256File(file), keyFile);
      return file;
    };
    const restoreRole = () => admin(async (c) => (await c.query<{ databases: number; settings: number }>(
      `SELECT (SELECT count(*)::int FROM pg_database WHERE datdba = 'flint_restore'::regrole) AS databases,
              (SELECT count(*)::int FROM pg_db_role_setting WHERE setrole = 'flint_restore'::regrole) AS settings`)).rows[0]!);
    const signsIn = () => connect(urls.restore, (c) => c.query('SELECT 1')).then(() => true, () => false);

    it('a view named like a table the checks read is refused, and the function inside it never runs as the migration owner', async () => {
      const bad = await production();
      await connect(bad.owner, async (c) => {
        await c.query('ALTER TABLE _prisma_migrations RENAME TO _pm');
        await c.query(`CREATE FUNCTION public.n1_probe() RETURNS boolean LANGUAGE plpgsql AS $f$ BEGIN RAISE LOG 'n1-probe ran as %', current_user; RETURN true; END $f$`);
        await c.query('CREATE VIEW public._prisma_migrations AS SELECT * FROM public._pm WHERE public.n1_probe()');
      });
      const d = await dumpDatabase(bad.backup, join(home, 'n1'), cluster.tools, new Date(takenAt.getTime() - 5 * 86_400_000));
      writeDumpHash(d.path, d.sha256, keyFile);
      const p = await production();
      fresh();
      const before = await databases();
      const err = await refusal(restoreDatabase(options(p, { dump: d.path })));
      expect(err.message).toMatch(/did not pass its checks: it is not built the way this copy of Flint builds its database .*Nothing was changed\.$/);
      expect(err.stage).toBe('verify');
      expect(calls).toEqual([]);
      expect(await databases()).toEqual(before);
      // The view was read (so this is not passing for want of a reader), and only ever by the role that owns nothing else.
      const ran = cluster.log().split('\n').flatMap((l) => /LOG: {2}n1-probe ran as (\w+)$/.exec(l)?.[1] ?? []);
      expect(ran.length).toBeGreaterThan(0);
      expect([...new Set(ran)]).toEqual(['flint_restore']);
    });

    it('a setting, a connection limit and the template mark a backup put on its own copy are cleared before it goes live', async () => {
      const p = await production();
      // What Will himself set on the database in use is still carried over, after the clearing.
      await admin((c) => c.query(`ALTER DATABASE ${p.name} SET statement_timeout = '45s'`));
      const dump = await forged(p, 6, {
        after: `DO $f$ BEGIN
          EXECUTE format('ALTER DATABASE %I SET work_mem = %L', current_database(), '7MB');
          EXECUTE format('ALTER DATABASE %I SET default_transaction_read_only = on', current_database());
          EXECUTE format('ALTER DATABASE %I SET search_path = pg_temp, public', current_database());
          EXECUTE format('ALTER DATABASE %I WITH CONNECTION LIMIT 40 IS_TEMPLATE true', current_database());
          RAISE LOG 'n2-probe ran in % as %', current_database(), current_user;
        END $f$;`,
      });
      fresh();
      const now = tick();
      const r = await restoreDatabase(options(p, { dump, now }));
      expect(r).toMatchObject({ database: p.name, fingerprint: 'matches', runtimeStarted: true });
      // The backup's SQL did run, in the copy, as the restoring role...
      expect(cluster.log()).toContain(`n2-probe ran in ${p.name}_restoring_${stampOf(now)} as flint_restore`);
      // ...and none of what it set is on the database now in use: only what was there before.
      const live = await admin(async (c) => (await c.query<{ lim: number; tmpl: boolean; open: boolean; settings: string[] | null }>(
        `SELECT d.datconnlimit AS lim, d.datistemplate AS tmpl, d.datallowconn AS open,
                (SELECT array_agg(x ORDER BY x) FROM pg_db_role_setting s, unnest(s.setconfig) AS x WHERE s.setdatabase = d.oid) AS settings
         FROM pg_database d WHERE d.datname = $1`, [p.name])).rows[0]!);
      expect(live).toEqual({ lim: -1, tmpl: false, open: true, settings: ['statement_timeout=45s'] });
      expect(await restoreRole()).toEqual({ databases: 0, settings: 0 });
    });

    it('a backup that fails its checks after marking its copy a template is still removed whole: nothing was changed, and that is true', async () => {
      const p = await production();
      const dump = await forged(p, 7, {
        after: `DO $f$ BEGIN
          EXECUTE format('ALTER DATABASE %I SET work_mem = %L', current_database(), '7MB');
          EXECUTE format('ALTER DATABASE %I WITH CONNECTION LIMIT 40 IS_TEMPLATE true', current_database());
        END $f$;
        CREATE FUNCTION public.backdoor() RETURNS void LANGUAGE sql SECURITY DEFINER AS $b$ SELECT 1 $b$;`,
      });
      fresh();
      const before = await databases();
      const err = await refusal(restoreDatabase(options(p, { dump })));
      expect(err.message).toMatch(/the function public\.backdoor\(\) is not one Flint makes.*\)\. Nothing was changed\.$/);
      expect(err.lines).toEqual([]);
      expect(await databases()).toEqual(before);
      expect((await admin(async (c) => (await c.query(`SELECT count(*)::int AS n FROM pg_db_role_setting s WHERE NOT EXISTS (SELECT 1 FROM pg_database d WHERE d.oid = s.setdatabase) AND s.setdatabase <> 0`)).rows[0])).n).toBe(0);
      expect(calls).toEqual([]);
    });

    it('a backup that changes the restoring role’s password, its settings, or makes a database is refused, the role is put back, and it never says nothing was changed', async () => {
      const p = await production();
      const dump = await forged(p, 8, {
        after: `ALTER ROLE flint_restore PASSWORD 'set-by-the-backup-0000'; ALTER ROLE flint_restore SET work_mem = '9MB';
          DO $f$ BEGIN EXECUTE format('ALTER ROLE flint_restore IN DATABASE %I SET statement_timeout = %L', current_database(), '1s'); END $f$;`,
        instead: 'CREATE DATABASE made_by_the_backup;',
      });
      fresh();
      const before = await databases('');
      const err = await refusal(restoreDatabase(options(p, { dump })));
      expect(err.message).toBe(
        "That file is not one of Flint's backups: restoring it changed the role Flint restores with (its password, its own settings, a database of its own). Flint put that back. The database in use was not touched.",
      );
      expect(err.stage).toBe('restorer');
      expect(err.message).not.toMatch(/Nothing was changed/);
      expect(err.lines).toEqual([]);
      expect(calls).toEqual([]);
      // Put back: the saved password signs in, nothing is stored for the role, and neither the copy nor the database it made is there.
      expect(await signsIn()).toBe(true);
      expect(await restoreRole()).toEqual({ databases: 0, settings: 0 });
      expect(await databases('')).toEqual(before);
      expect(records.at(-1)).toMatchObject({ outcome: 'failed', stage: 'restorer' });
      // The password went to the server as a verifier, never as itself.
      expect(cluster.log()).toMatch(/statement: ALTER ROLE "flint_restore" PASSWORD 'SCRAM-SHA-256\$4096:/);
      expect(cluster.log().includes(pgConfig(urls.restore).password as string)).toBe(false);
      // And the next restore works.
      const ok = await restoreDatabase(options(p, { checkOnly: true }));
      expect(ok).toMatchObject({ checkedOnly: true });
    });

    it('when the role cannot be put back (the backup also ended the session that would have), it says so, with the command', async () => {
      const p = await production();
      const dump = await forged(p, 9, {
        after: `ALTER ROLE flint_restore PASSWORD 'set-by-the-backup-0001';
          SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = 'flint_restore' AND pid <> pg_backend_pid();`,
      });
      fresh();
      const before = await databases('');
      try {
        const err = await refusal(restoreDatabase(options(p, { dump })));
        expect(err.message).toBe(
          "That file is not one of Flint's backups: restoring it changed the role Flint restores with (its password). Flint could not put all of that back. The database in use was not touched.",
        );
        expect(err.lines).toEqual([
          'Restores, and the weekly restore test, will not work until that role has its password again.',
          'Set it with this command, and type the password from the line FLINT_DB_RESTORE_URL in ~/.flint/backup.env when it asks:',
          "  psql -d postgres -c '\\password flint_restore'",
        ]);
        expect(err.message).not.toMatch(/Nothing was changed/);
        expect(await signsIn()).toBe(false);
        // The copy is gone all the same (the migration owner removes it), and nothing in use was touched.
        expect(await databases('')).toEqual(before);
        expect(calls).toEqual([]);
        // The next run says the same thing in its own words, before it reads any backup.
        const next = await refusal(restoreDatabase(options(p, { checkOnly: true })));
        expect(next.message).toMatch(/no longer let the role flint_restore sign in/);
      } finally {
        // What Will would do by hand, for the tests that follow.
        await admin((c) => c.query(`ALTER ROLE flint_restore PASSWORD '${scramVerifier(pgConfig(urls.restore).password as string)}'`));
      }
      expect(await signsIn()).toBe(true);
    });
  });

  describe('what Will took away after the backup stays taken away', () => {
    it('a revoked key stays revoked, a promotion switched off stays off, and what a revoked key signed is switched off', async () => {
      const p = await production();
      // After the backup: Will revokes the old laptop's key, switches a promotion off, enrols a new key, has Flint forget
      // something, deals with a card that was waiting, and a cap is used some more.
      const newKey = await enrollKey(p.approver, 'New phone');
      await connect(p.approver, (c) => c.query(`UPDATE "ApprovalCredential" SET "revokedAt" = now() WHERE "credentialId" = $1`, [keys.b.credentialId]));
      const forget = await newKey.approve({ subjectType: 'forget', subjectId: ids.thing, action: 'world.forget', argsDigest: DIGEST });
      const pendingApproval = (await one<{ id: string }>(p.owner, `SELECT id FROM "Approval" WHERE "subjectId" = $1 AND "consumedAt" IS NULL`, [ids.pending]))!.id;
      await connect(p.app, async (c) => {
        await c.query(`UPDATE "ActionPolicy" SET active = false WHERE id = $1`, [policy.off]);
        await c.query(`UPDATE "TriageRule" SET enabled = false WHERE id = $1`, [rule]);
        await c.query(`SELECT forget_entity($1, $2)`, [ids.thing, forget]);
        await c.query(`UPDATE "Proposal" SET status = 'approved', "approvalId" = $2 WHERE id = $1`, [ids.pending, pendingApproval]);
        await c.query(`UPDATE "Proposal" SET status = 'executing' WHERE id = $1`, [ids.pending]);
        await c.query(`UPDATE "Proposal" SET status = 'executed', "executedAt" = now(), result = '{}' WHERE id = $1`, [ids.pending]);
        for (let i = 0; i < 3; i++) await c.query(`SELECT claim_action('notify.push', to_char(now(), 'YYYY-MM-DD'), 5)`);
      });
      expect((await one<{ status: string }>(p.owner, `SELECT status FROM "Entity" WHERE id = $1`, [ids.thing]))!.status).toBe('forgotten');

      fresh();
      const r = await restoreDatabase(options(p));
      expect(r.report).toMatchObject({
        currentRead: true, revoked: 1, mismatched: 0, policiesOff: 1, rulesOff: 1,
        unsignedPolicies: [{ pattern: 'digest.send', why: 'the key that signed it is revoked' }], unsignedRules: [],
        forgets: [{ id: ids.thing, kind: 'project' }], reappearing: { cards: 1, ran: 1 }, rules: [],
      });
      expect(r.report.counters).toBe(1);
      expect(r.report.keysNotCarried.map((k) => k.label)).toEqual(['New phone']);
      expect(r.report.liveKeys).toEqual([expect.objectContaining({ label: 'Studio', known: true })]);
      expect(r.report.promotions.map((x) => x.pattern)).toEqual(['world.sync.github']);

      // In the database now in use.
      const cred = await connect(p.owner, async (c) => (await c.query<{ label: string; revoked: boolean }>(`SELECT label, "revokedAt" IS NOT NULL AS revoked FROM "ApprovalCredential" ORDER BY label`)).rows);
      expect(cred).toEqual([{ label: 'Old laptop', revoked: true }, { label: 'Studio', revoked: false }]);
      const pol = await connect(p.owner, async (c) => (await c.query<{ pattern: string; active: boolean }>(`SELECT pattern, active FROM "ActionPolicy" ORDER BY pattern`)).rows);
      expect(pol).toEqual([{ pattern: 'backup.local', active: false }, { pattern: 'digest.send', active: false }, { pattern: 'world.sync.github', active: true }]);
      expect((await one<{ enabled: boolean }>(p.owner, `SELECT enabled FROM "TriageRule" WHERE id = $1`, [rule]))!.enabled).toBe(false);
      expect((await one<{ count: number }>(p.owner, `SELECT count FROM "ActionCounter" WHERE action = 'notify.push'`))!.count).toBe(4);
      // Each switch-off is in the history the triggers keep, as the restore's own.
      const history = await connect(p.owner, async (c) => (await c.query<{ actor: string }>(`SELECT DISTINCT actor FROM "RowChange" WHERE "tableName" = 'ActionPolicy'`)).rows.map((x) => x.actor));
      expect(history).toContain('restore');
      // What he had Flint forget is back (a forget needs his signature again), and the card he dealt with waits again.
      expect((await one<{ status: string }>(p.owner, `SELECT status FROM "Entity" WHERE id = $1`, [ids.thing]))!.status).toBe('active');
      expect(await statusOf(p.owner, ids.pending)).toMatchObject({ status: 'pending' });
      const text = carryLines(r.report, 'UTC', 'production').join('\n');
      expect(text).toContain('The approval key you revoked after this backup stays revoked.');
      expect(text).toContain('The approval key "New phone" was enrolled after this backup, so it is not in it. Enrol it again.');
      expect(text).toContain('You told Flint to forget 1 thing after this backup, and it is back (project). Forget it again in the console.');
      expect(text).toContain('You dealt with 1 card after this backup, and it is waiting again; 1 of them had already run.');
    });

    it('when the database in use cannot be read, the restore still goes through, and says what may be back', async () => {
      const p = await production();
      // Damaged: a governance table is gone under its name.
      await connect(p.owner, (c) => c.query('ALTER TABLE "ApprovalCredential" RENAME TO lost'));
      const r = await restoreDatabase(options(p));
      expect(r.report.currentRead).toBe(false);
      expect(r.report).toMatchObject({ revoked: 0, policiesOff: 0, unsignedPolicies: [] });
      expect(r.report.liveKeys.every((k) => k.known === undefined)).toBe(true);
      expect(carryLines(r.report, 'UTC', 'production')[0]).toMatch(/could not read the database in use/);
      expect((await one<{ n: number }>(p.owner, `SELECT count(*)::int AS n FROM "ApprovalCredential"`))!.n).toBe(2);
      const audit = await one<{ inputs: { currentRead: boolean } }>(p.owner, `SELECT inputs FROM "AuditEntry" WHERE action = 'restore.production'`);
      expect(audit!.inputs.currentRead).toBe(false);
    });

    it('a key in the backup that is not the one in use under that name is revoked', async () => {
      const bad = await production();
      const other = await enrollKey(bad.approver, 'swap');
      await connect(bad.owner, async (c) => {
        await c.query('ALTER TABLE "ApprovalCredential" DISABLE TRIGGER USER');
        await c.query(`UPDATE "ApprovalCredential" SET "publicKey" = (SELECT "publicKey" FROM "ApprovalCredential" WHERE "credentialId" = $2) WHERE "credentialId" = $1`, [keys.a.credentialId, other.credentialId]);
        await c.query(`DELETE FROM "ApprovalCredential" WHERE "credentialId" = $1`, [other.credentialId]);
        await c.query('ALTER TABLE "ApprovalCredential" ENABLE TRIGGER USER');
      });
      const d = await dumpDatabase(bad.backup, join(home, 'swapped'), cluster.tools, new Date(takenAt.getTime() - 5 * 86_400_000));
      writeDumpHash(d.path, d.sha256, keyFile);
      const p = await production();
      const r = await restoreDatabase(options(p, { dump: d.path }));
      expect(r.report.mismatched).toBe(1);
      expect(r.report.liveKeys.map((k) => k.label)).toEqual(['Old laptop']);
      // Everything that key had signed is switched off with it.
      expect(r.report.promotions.map((x) => x.pattern)).toEqual(['digest.send']);
    });
  });

  describe('the database’s own settings come with it', () => {
    it('privileges and settings Will added to the database are carried over; where it had drifted from Flint’s setup, the setup wins and it says so', async () => {
      const p = await production();
      await admin(async (c) => {
        await c.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reader') THEN CREATE ROLE reader; END IF; END $$`);
        await c.query(`GRANT CONNECT ON DATABASE ${p.name} TO reader`);
        await c.query(`GRANT TEMPORARY ON DATABASE ${p.name} TO flint_app`);
        await c.query(`ALTER DATABASE ${p.name} SET statement_timeout = '45s'`);
        await c.query(`ALTER DATABASE ${p.name} SET search_path = "$user", public`);
        await c.query(`ALTER ROLE flint_app IN DATABASE ${p.name} SET work_mem = '8MB'`);
      });
      fresh();
      await restoreDatabase(options(p));
      expect(said).toContain("The database in use gives flint_app the privilege TEMPORARY, which Flint's own setup does not. The restored database follows Flint's setup.");
      expect(said).toContain('The database in use has a setting Flint could not copy to the restored one: work_mem for flint_app. Set it again afterwards if you still want it.');
      const has = (role: string, privilege: string) => admin(async (c) => (await c.query<{ ok: boolean }>('SELECT has_database_privilege($1, $2, $3) AS ok', [role, p.name, privilege])).rows[0]!.ok);
      expect(await has('reader', 'CONNECT')).toBe(true);
      expect(await has('flint_app', 'CONNECT')).toBe(true);
      expect(await has('flint_app', 'TEMP')).toBe(false);
      expect(await has('flint_approver', 'TEMP')).toBe(false);
      const settings = await admin(async (c) => (await c.query<{ setconfig: string[] }>(`SELECT s.setconfig FROM pg_db_role_setting s JOIN pg_database d ON d.oid = s.setdatabase WHERE d.datname = $1 AND s.setrole = 0`, [p.name])).rows[0]?.setconfig);
      expect(settings?.sort()).toEqual(['search_path="$user", public', 'statement_timeout=45s']);
    });

    it('the roles are checked first: one with too much power, one that is missing, an owner that cannot take the copy over', async () => {
      const problems = (restorer = 'flint_restore') => admin((c) => roleProblems(c, restorer));
      expect(await problems()).toEqual([]);
      expect(await problems('flint_nobody')).toEqual(['the role flint_nobody does not exist']);
      expect(await problems('flint_owner')).toContain('the role that restores backups must be one of its own');
      const p = await production();
      const before = await databases();
      const withRole = async (change: string, undo: string, expected: RegExp) => {
        await admin((c) => c.query(change));
        try {
          expect((await problems()).join(' | ')).toMatch(expected);
          await expect(restoreDatabase(options(p, { checkOnly: true }))).rejects.toThrow(/not set up for a restore/);
        } finally {
          await admin((c) => c.query(undo));
        }
      };
      await withRole('ALTER ROLE flint_app CREATEDB', 'ALTER ROLE flint_app NOCREATEDB', /flint_app has more power than an application role may/);
      await withRole('ALTER ROLE flint_backup BYPASSRLS', 'ALTER ROLE flint_backup NOBYPASSRLS', /flint_backup has more power than an application role may/);
      await withRole('ALTER ROLE flint_owner NOCREATEDB', 'ALTER ROLE flint_owner CREATEDB', /flint_owner may not create databases/);
      await withRole('ALTER ROLE flint_restore CREATEROLE', 'ALTER ROLE flint_restore NOCREATEROLE', /flint_restore has more power than a role that restores backups may/);
      // The migration owner must be able to take over what the restoring role makes: the one-time grant, with its command.
      await admin((c) => c.query('REVOKE flint_restore FROM flint_owner'));
      try {
        const err = await refusal(restoreDatabase(options(p, { checkOnly: true })));
        expect(err.message).toMatch(/That permission is missing\.$/);
        expect(err.lines).toEqual(['Grant it once with this command, then run this again:', "  psql -d postgres -c 'GRANT flint_restore TO flint_owner'"]);
      } finally {
        await admin((c) => c.query('GRANT flint_restore TO flint_owner'));
      }
      // A database that does not belong to the migration owner.
      await admin((c) => c.query(`ALTER DATABASE ${p.name} OWNER TO scratch_admin`));
      try {
        await expect(restoreDatabase(options(p, { checkOnly: true }))).rejects.toThrow(new RegExp(`the database ${p.name} does not belong to flint_owner`));
      } finally {
        await admin((c) => c.query(`ALTER DATABASE ${p.name} OWNER TO flint_owner`));
      }
      // A saved password that no longer works is caught before anything is restored.
      const stale = new URL(p.app);
      stale.password = 'old';
      await expect(restoreDatabase(options({ ...p, app: stale.toString() }, { checkOnly: true }))).rejects.toThrow(/no longer let the role flint_app sign in/);
      expect(await databases()).toEqual(before);
      // A restore drill's own scratch database, there while a restore runs, is still the drill's afterwards.
      await connect(urls.restore, (c) => c.query('CREATE DATABASE flint_restore_test'));
      try {
        await restoreDatabase(options(p, { checkOnly: true }));
        expect((await admin(async (c) => (await c.query<{ owner: string }>(`SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = 'flint_restore_test'`)).rows[0]))!.owner).toBe('flint_restore');
      } finally {
        await connect(urls.restore, (c) => c.query('DROP DATABASE flint_restore_test'));
      }
    });
  });

  describe('a swap that fails, or is interrupted, is settled by reading the catalog', () => {
    it('a failure with the database closed: it is opened again, the copy removed, the runtime started, and only then is "nothing was changed" said', async () => {
      const p = await production();
      fresh();
      const before = await databases();
      const err = await refusal(restoreDatabase(options(p, { at: async (point) => { if (point === 'closed') { expect(await isOpen(p.name)).toBe(false); throw new Error('boom'); } } })));
      expect(err.message).toBe('The databases could not be swapped (Error). Nothing was changed.');
      expect(err.runtimeDown).toBe(false);
      expect(calls).toEqual(['stop', 'start']);
      expect(await isOpen(p.name)).toBe(true);
      expect(await databases()).toEqual(before);
      expect(await statusOf(p.owner, p.marker)).toMatchObject({ status: 'pending' });
      expect(records).toEqual([expect.objectContaining({ outcome: 'failed', stage: 'swap' })]);
    });

    it('an interruption during the swap is held until the swap is undone; one before it ends the run with nothing in use touched', async () => {
      const p = await production();
      fresh();
      const before = await databases();
      let signal: ((s: string) => void) | undefined;
      let listening = false;
      const onSignal = (h: (s: string) => void) => { signal = h; listening = true; return () => { listening = false; }; };
      const exits: string[] = [];
      // Ctrl-C while the database is closed and nothing is renamed.
      const err = await refusal(restoreDatabase(options(p, { onSignal, exit: (s) => exits.push(s), at: (point) => { if (point === 'closed') signal!('SIGINT'); } })));
      expect(err.message).toBe('Flint was interrupted (SIGINT), so it stopped. Nothing was changed.');
      expect(err.stage).toBe('interrupted');
      expect(exits).toEqual([]);
      expect(listening).toBe(false);
      expect(calls).toEqual(['stop', 'start']);
      expect(await isOpen(p.name)).toBe(true);
      expect(await databases()).toEqual(before);
      expect(await statusOf(p.owner, p.marker)).toMatchObject({ status: 'pending' });

      // Once the names have changed, an interruption changes nothing: the restore finishes.
      const done = await restoreDatabase(options(p, { onSignal, exit: (s) => exits.push(s), at: (point) => { if (point === 'swapped') signal!('SIGTERM'); } }));
      expect(done.keptAs).toBeDefined();
      expect(exits).toEqual([]);
      expect(await statusOf(p.owner, p.marker)).toBeUndefined();

      // Before the swap (here, while Will is being asked): the run is ended, the pause on updates is lifted, nothing in use was touched.
      const q = await production();
      const holdFile = join(scratchDir('flint-hold-'), 'deploy-hold');
      let heldAtExit: boolean | undefined;
      await restoreDatabase(options(q, { holdFile, onSignal, exit: (s) => { exits.push(s); heldAtExit = existsSync(holdFile); }, confirm: async () => { signal!('SIGHUP'); return false; } })).catch(() => undefined);
      expect(exits).toEqual(['SIGHUP']);
      expect(heldAtExit).toBe(false);
      expect(await isOpen(q.name)).toBe(true);
      expect(await statusOf(q.owner, q.marker)).toMatchObject({ status: 'pending' });
    });

    it('an undo that cannot be confirmed never says "nothing was changed": the copy is kept and the real state is said, with the commands', async () => {
      const p = await production();
      fresh();
      const now = tick();
      const copy = `${p.name}_restoring_${stampOf(now)}`;
      // With the database closed, it is renamed out from under the restore: there is nothing to put back under its name.
      const err = await refusal(restoreDatabase(options(p, { now, at: async (point) => { if (point === 'closed') { await admin((c) => c.query(`ALTER DATABASE ${p.name} RENAME TO ${p.name}_elsewhere`)); throw new Error('boom'); } } })));
      expect(err.message).toBe('The databases could not be swapped (Error). Flint could not confirm that the database is back as it was.');
      expect(err.message).not.toMatch(/Nothing was changed/);
      expect(err.stage).toBe('undo');
      expect(err.lines).toEqual([
        `There is no database named ${p.name} right now.`,
        `The restored copy is still there as ${copy}.`,
        'Put things back with this command:',
        '  ~/flint/apps/studio/restore_database.sh --repair',
        'If that does not work, open the database by hand with this command:',
        `  psql -d postgres -c 'ALTER DATABASE ${p.name} ALLOW_CONNECTIONS true'`,
      ]);
      // The good restored copy was NOT dropped, and the runtime was started again all the same.
      expect(await databases(p.name)).toEqual([`${p.name}_elsewhere`, copy]);
      expect(calls).toEqual(['stop', 'start']);
      expect(records).toEqual([expect.objectContaining({ outcome: 'failed', stage: 'undo' })]);
      // The same, when the database is there but will not open, and the runtime will not start either.
      await admin((c) => c.query(`ALTER DATABASE ${p.name}_elsewhere RENAME TO ${p.name}`));
      await admin((c) => c.query(`DROP DATABASE ${copy}`));
      await admin((c) => c.query(`ALTER DATABASE ${p.name} ALLOW_CONNECTIONS true`));
      const closed = await refusal(restoreDatabase(options(p, {
        startRuntime: async () => { throw new Error('no'); },
        at: async (point) => { if (point === 'closed') { await admin((c) => c.query(`ALTER DATABASE ${p.name} OWNER TO scratch_admin`)); throw new Error('boom'); } },
      })));
      expect(closed.message).toMatch(/Flint could not confirm that the database is back as it was\.$/);
      expect(closed.lines[0]).toBe(`The database ${p.name} is closed to connections.`);
      expect(closed.runtimeDown).toBe(true);
      await admin((c) => c.query(`ALTER DATABASE ${p.name} OWNER TO flint_owner`));
    });

    it('what a stopped run leaves is said in plain words at the next start, with the repair, and the repair puts it right', async () => {
      // 1. Closed (a run was killed between closing the database and the swap).
      const p = await production();
      const stale = `${p.name}_restoring_${stampOf(tick())}`;
      await admin(async (c) => {
        await c.query(`CREATE DATABASE ${stale} OWNER flint_owner`);
        await c.query(`ALTER DATABASE ${p.name} ALLOW_CONNECTIONS false`);
      });
      const closed = await refusal(restoreDatabase(options(p)));
      expect(closed.message).toBe(`The database ${p.name} is closed to connections: an earlier restore was stopped part-way.`);
      expect(closed.lines).toEqual(['Open it again with this command:', '  ~/flint/apps/studio/restore_database.sh --repair']);
      const lines: string[] = [];
      let asked = false;
      let started = 0;
      const repair = (owner: string, confirm = true) => repairDatabase({ owner, confirm: async () => { asked = true; return confirm; }, startRuntime: async () => void started++, say: (l) => lines.push(l) });
      expect(await repair(p.owner)).toEqual({ did: 'opened', runtimeStarted: true });
      expect(asked).toBe(false);
      expect(lines).toEqual([`The database ${p.name} is open again.`, `Flint removed ${stale}, a copy that never went into use.`]);
      expect(await isOpen(p.name)).toBe(true);
      expect(await databases(p.name)).toEqual([p.name]);
      expect(await statusOf(p.owner, p.marker)).toMatchObject({ status: 'pending' });
      // Nothing to repair: it says so, and still makes sure the runtime is up.
      lines.length = 0;
      expect(await repair(p.owner)).toEqual({ did: 'nothing', runtimeStarted: true });
      expect(lines).toEqual([`The database ${p.name} is open. Nothing needed repairing.`]);
      expect(started).toBe(2);

      // 2. Missing, with a kept copy there (never the "rebuild" message).
      const q = await production();
      const kept = `${q.name}_damaged_${stampOf(tick())}`;
      await admin(async (c) => {
        await c.query(`ALTER DATABASE ${q.name} ALLOW_CONNECTIONS false`);
        await c.query(`ALTER DATABASE ${q.name} RENAME TO ${kept}`);
      });
      const missing = await refusal(restoreDatabase(options(q)));
      expect(missing.message).toBe(`There is no database named ${q.name}, and ${kept} is there: an earlier restore was stopped part-way.`);
      expect(missing.message).not.toMatch(/rebuild/i);
      expect(missing.lines).toEqual(['Put it back with this command:', '  ~/flint/apps/studio/restore_database.sh --repair']);
      // Giving a kept copy the production name back is Will's to confirm.
      lines.length = 0;
      await expect(repair(q.owner, false)).rejects.toThrow('Nothing was changed.');
      expect(await databases(q.name)).toEqual([kept]);
      expect(await repair(q.owner)).toEqual({ did: 'renamed', runtimeStarted: true });
      expect(asked).toBe(true);
      expect(lines).toContain(`The database ${q.name} is back, from the kept copy.`);
      expect(await isOpen(q.name)).toBe(true);
      expect(await statusOf(q.owner, q.marker)).toMatchObject({ status: 'pending' });
      // Missing with nothing kept: there is nothing to put back, and it says where to turn.
      await expect(repair(onDb(urls.owner, 'flint_nowhere'))).rejects.toThrow(/no database named flint_nowhere and no kept copy of it\. Rebuild from a backup/);
    });

    it('a copy that cannot be removed is named, never passed over, and the next run removes it', async () => {
      const p = await production();
      fresh();
      const now = tick();
      const copy = `${p.name}_restoring_${stampOf(now)}`;
      let holder: pg.Client | undefined;
      const err = await refusal(restoreDatabase(options(p, {
        now,
        at: async (point) => {
          if (point !== 'closed') return;
          // Someone is looking at the copy when the swap fails.
          holder = new pg.Client({ ...cluster.admin, database: copy });
          await holder.connect();
          throw new Error('boom');
        },
      })));
      try {
        expect(err.message).toBe('The databases could not be swapped (Error). Nothing was changed.');
        expect(err.lines).toEqual([`Flint could not remove the copy ${copy}. The next restore removes it.`]);
        expect(await isOpen(p.name)).toBe(true);
        expect(await databases(p.name)).toEqual([p.name, copy]);
      } finally {
        await holder?.end();
      }
      said.length = 0;
      await restoreDatabase(options(p, { checkOnly: true }));
      expect(said).toEqual([`Flint removed ${copy}, left by an earlier restore that did not finish.`]);
      expect(await databases(p.name)).toEqual([p.name]);
    });
  });

  describe('what is kept is not kept for ever', () => {
    it('a kept database and a pre-restore copy from more than two weeks ago are removed by a later restore, and Will is told before he confirms', async () => {
      const p = await production();
      const pre = scratchDir('flint-pre-');
      const old = new Date(Date.now() - (KEEP_DAYS + 6) * 86_400_000);
      const recent = new Date(Date.now() - 2 * 86_400_000);
      const oldKept = `${p.name}_damaged_${stampOf(old)}`;
      const recentKept = `${p.name}_damaged_${stampOf(recent)}`;
      await admin(async (c) => {
        for (const name of [oldKept, recentKept]) {
          await c.query(`CREATE DATABASE ${name} OWNER flint_owner`);
          await c.query(`ALTER DATABASE ${name} ALLOW_CONNECTIONS false`);
        }
      });
      for (const d of [old, recent]) for (const suffix of ['', '.counts.json', '.sha256']) writeFileSync(join(pre, `${dumpNameAt(d)}${suffix}`), 'x', { mode: 0o600 });
      writeFileSync(join(pre, 'notes.txt'), 'not a copy');
      let asked: RestoreSummary | undefined;
      // A trial run removes nothing.
      await restoreDatabase(options(p, { copyDir: pre, checkOnly: true }));
      expect(await databases(p.name)).toEqual([p.name, oldKept, recentKept].sort());
      const r = await restoreDatabase(options(p, { copyDir: pre, confirm: async (s) => { asked = s; return true; } }));
      expect(asked!.removing).toEqual([oldKept, `the copy ${dumpNameAt(old)}`]);
      expect(r.removed).toEqual([oldKept, `the copy ${dumpNameAt(old)}`]);
      expect(await databases(p.name)).toEqual([p.name, r.keptAs!, recentKept].sort());
      expect(readdirSync(pre).sort()).toEqual([basename(r.copy!), `${basename(r.copy!)}.counts.json`, `${basename(r.copy!)}.sha256`, dumpNameAt(recent), `${dumpNameAt(recent)}.counts.json`, `${dumpNameAt(recent)}.sha256`, 'notes.txt'].sort());
    });
  });

  describe('a rebuild takes the same path, into an empty database only', () => {
    const empty = async (): Promise<{ name: string; owner: string; app: string }> => {
      const name = `flint_new${++n}`;
      await admin((c) => c.query(`CREATE DATABASE ${name} OWNER flint_owner`));
      await admin((c) => c.query('ALTER SCHEMA public OWNER TO flint_owner'), name);
      return { name, owner: onDb(urls.owner, name), app: onDb(urls.app, name) };
    };
    const rebuild = (p: { owner: string; app: string }, over: Partial<RestoreOptions> = {}): RestoreOptions => {
      const { backup: _b, copyDir: _c, confirm: _f, ...rest } = options(p);
      return { ...rest, mode: 'rebuild', recorded: [dumpSha], stopRuntime: async () => {}, startRuntime: async () => {}, ...over };
    };

    it('restores, checks, sets signed work aside and says truthfully who ran it; the empty database it replaced is gone, and nothing asked anyone', async () => {
      const p = await empty();
      fresh();
      const r = await restoreDatabase(rebuild(p));
      expect(r).toMatchObject({ mode: 'rebuild', fingerprint: 'matches', pending: [], audited: true, leftovers: [] });
      expect(r.keptAs).toBeUndefined();
      expect(r.report).toMatchObject({ currentRead: false, approvals: 1, proposals: 2 });
      expect(r.tables).toBeGreaterThan(15);
      expect(await databases(p.name)).toEqual([p.name]);
      expect(await isOpen(p.name)).toBe(true);
      expect(await statusOf(p.owner, ids.approved)).toEqual({ status: 'failed', error: VOIDED_BY_RESTORE });
      // The audit entry does not claim Will, the console or an approval: the rebuild script ran it, and no one was asked.
      const audit = await connect(p.app, async (c) => (await c.query(`SELECT actor, context, tier, decision, outcome, inputs->>'mode' AS mode FROM "AuditEntry" WHERE action = 'restore.production'`)).rows);
      expect(audit).toEqual([{ actor: 'rebuild', context: 'deploy', tier: null, decision: 'act', outcome: 'ok', mode: 'rebuild' }]);
      expect(await connect(p.owner, (c) => grantLines(c))).toEqual(JSON.parse(readFileSync(GRANTS_FIXTURE, 'utf8')));
      // The database's own privileges are Flint's setup: nobody may make temp tables in it.
      expect((await admin(async (c) => (await c.query<{ ok: boolean }>(`SELECT has_database_privilege('flint_app', $1, 'TEMP') AS ok`, [p.name])).rows[0]))!.ok).toBe(false);
      // The promotions that came back are said, and that what was taken away since is back with them.
      const text = carryLines(r.report, 'UTC', 'rebuild').join('\n');
      expect(text).toMatch(/^The rebuilt Flint starts from the backup/);
      expect(text).toContain('Flint may do 3 things on its own: backup.local, digest.send, world.sync.github (5 a day).');

      // Run again with the same backup (a rebuild that stopped later and was restarted): nothing is done, and it says so.
      const again = await restoreDatabase(rebuild(p));
      expect(again).toMatchObject({ already: true });
      expect((await one<{ n: number }>(p.app, `SELECT count(*)::int AS n FROM "AuditEntry" WHERE action = 'restore.production'`))!.n).toBe(1);
      // Any other backup into a database that is not empty is refused.
      const other = join(scratchDir('flint-dump-'), dumpNameAt(new Date(takenAt.getTime() - 6 * 86_400_000)));
      writeFileSync(other, Buffer.concat([readFileSync(dump), Buffer.from('\n')]), { mode: 0o600 });
      await expect(restoreDatabase(rebuild(p, { dump: other, withoutFingerprint: true, recorded: [] }))).rejects.toThrow(/not empty/);
    });

    it('a run that fails part-way leaves the database empty, and the same command run again succeeds', async () => {
      const p = await empty();
      // Fails with the copy restored and checked, at the swap.
      await expect(restoreDatabase(rebuild(p, { at: (point) => { if (point === 'closed') throw new Error('boom'); } }))).rejects.toThrow(/Nothing was changed/);
      expect(await databases(p.name)).toEqual([p.name]);
      expect(await isOpen(p.name)).toBe(true);
      // Fails while the copy is being checked (its counts are wrong).
      const dir = scratchDir('flint-dump-');
      const off = join(dir, basename(dump));
      cpSync(dump, off);
      chmodSync(off, 0o600);
      writeFileSync(`${off}.counts.json`, JSON.stringify({ 'public."Proposal"': 0 }));
      await expect(restoreDatabase(rebuild(p, { dump: off }))).rejects.toThrow(/row counts differ.*Nothing was changed/);
      expect(await databases(p.name)).toEqual([p.name]);
      // The same command again.
      const r = await restoreDatabase(rebuild(p));
      expect(r).toMatchObject({ mode: 'rebuild', audited: true });
      expect(r.already).toBeUndefined();
      expect(await statusOf(p.owner, ids.executed)).toMatchObject({ status: 'executed' });
    });

    it('an offsite copy that came without its counts still restores, by the fingerprint the rebuild’s bundle lists; with no fingerprint at all it is refused', async () => {
      const dir = scratchDir('flint-dump-');
      const bare = join(dir, basename(dump));
      cpSync(dump, bare);
      chmodSync(bare, 0o600);
      const p = await empty();
      await expect(restoreDatabase(rebuild(p, { dump: bare, recorded: [] }))).rejects.toThrow(/No fingerprint was recorded for that backup/);
      await expect(restoreDatabase(rebuild(p, { dump: bare, recorded: ['0'.repeat(64)] }))).rejects.toThrow(/has changed since it was written/);
      const r = await restoreDatabase(rebuild(p, { dump: bare }));
      expect(r).toMatchObject({ tables: 0, fingerprint: 'matches' });
    });
  });

  describe('the commands, as they are run', () => {
    const cli = (args: string[], env: Record<string, string> = {}) =>
      spawnSync(join(RUNTIME, 'node_modules', '.bin', 'tsx'), ['src/cli.ts', ...args], {
        cwd: RUNTIME, encoding: 'utf8', input: 'RESTORE\n',
        // NODE_ENV=test: the command's own config then never allows launchctl.
        env: { PATH: process.env.PATH ?? '', HOME: home, NODE_ENV: 'test', ...env },
      });
    const config = (p: { owner: string; app: string; backup?: string }, over: Partial<RestoreConfig> = {}): RestoreConfig => ({
      home, tz: 'UTC', ownerUrl: p.owner, appUrl: p.app, restoreUrl: urls.restore, ...(p.backup ? { backupUrl: p.backup } : {}), dumpDir, copyDir, fingerprintKey: keyFile,
      holdFile: join(home, '.flint', 'deploy-hold'), recordFile: join(home, '.flint', 'restore-log.jsonl'),
      tools: cluster.tools, path: process.env.PATH ?? '', launchctl: false, ...over,
    });
    const noLaunchd = async (_bin: string, args: string[]) => { if (args[0] === 'print') throw new Error('not loaded'); return ''; };

    it('restore-production --check runs with no one at the keyboard, changes nothing in use, and says how long a restore takes and what would be in force', async () => {
      const before = await databases();
      const r = cli(['restore-production', '--check', '--dump', basename(dump)]);
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      const lines = r.stdout.trim().split('\n');
      expect(lines[0]).toMatch(new RegExp(`^The backup ${basename(dump).replace(/\./g, '\\.')} restores and passes every check\\. A real restore would take about \\d+ seconds?\\.$`));
      expect(lines.at(-1)).toBe('This was a trial run. Nothing was changed.');
      expect(r.stdout).toMatch(/This key can approve: "Studio", this Mac's key, enrolled /);
      for (const l of lines) expect(l, l).toMatch(/^[A-Z].*\.$/);
      for (const secret of [new URL(urls.owner).password, new URL(urls.restore).password, 'postgresql://']) expect(r.stdout.includes(secret)).toBe(false);
      expect(await databases()).toEqual(before);
      // The local record: one line, the owner's alone, with no secret in it.
      const log = join(home, '.flint', 'restore-log.jsonl');
      expect(statSync(log).mode & 0o777).toBe(0o600);
      const last = JSON.parse(readFileSync(log, 'utf8').trim().split('\n').at(-1)!) as Record<string, unknown>;
      expect(last).toMatchObject({ outcome: 'ok', mode: 'check', sha256: dumpSha });
      expect(typeof last.at).toBe('string');
    });

    it('restore-production with RESTORE piped in refuses, prints one sentence, and changes nothing', async () => {
      const before = await databases();
      const r = cli(['restore-production']);
      expect(r.status).toBe(1);
      expect(r.stdout.trim()).toBe('Run this yourself in Terminal: it asks you to confirm before it changes anything.');
      expect(r.stderr).toBe('');
      expect(await databases()).toEqual(before);
    });

    it('with no backup named it takes the newest that is whole: one that fails its own checks is passed over, and said', async () => {
      const p = await production();
      const dir = join(scratchDir('flint-dumps-'), 'pg');
      mkdirSync(dir, { recursive: true });
      const good = join(dir, basename(dump));
      cpSync(dump, good);
      chmodSync(good, 0o600);
      cpSync(`${dump}.counts.json`, `${good}.counts.json`);
      cpSync(`${dump}.sha256`, `${good}.sha256`);
      // Newer, and cut short on the way to disk; newer still, and changed since it was written.
      const cut = join(dir, dumpNameAt(new Date(takenAt.getTime() + 3_600_000)));
      writeFileSync(cut, readFileSync(dump).subarray(0, 300), { mode: 0o600 });
      writeFileSync(`${cut}.counts.json`, readFileSync(`${dump}.counts.json`));
      const changed = join(dir, dumpNameAt(new Date(takenAt.getTime() + 7_200_000)));
      writeFileSync(changed, Buffer.concat([readFileSync(dump), Buffer.from('x')]), { mode: 0o600 });
      writeFileSync(`${changed}.counts.json`, readFileSync(`${dump}.counts.json`));
      writeDumpHash(changed, dumpSha, keyFile);
      const out: string[] = [];
      await restoreProductionCommand(['--check'], config(p, { dumpDir: dir }), { say: (l) => out.push(l), uid: 501, exec: noLaunchd });
      expect(out[0]).toBe(`Flint skipped the backup ${basename(changed)}: That backup file has changed since it was written. Choose another backup.`);
      expect(out[1]).toBe(`Flint skipped the backup ${basename(cut)}: No fingerprint was recorded for that backup, so Flint cannot tell whether it has been changed. Nothing was restored.`);
      expect(out[2]).toMatch(new RegExp(`^The backup ${basename(good).replace(/\./g, '\\.')} restores and passes every check`));
      // Named outright, a bad backup is refused, never swapped for another.
      await expect(restoreProductionCommand(['--check', '--dump', basename(changed)], config(p, { dumpDir: dir }), { say: () => {}, uid: 501, exec: noLaunchd })).rejects.toThrow(/has changed since it was written/);
      // With --without-fingerprint the cut file is read, and is refused for what it is.
      await expect(restoreProductionCommand(['--check', '--without-fingerprint', '--dump', basename(cut)], config(p, { dumpDir: dir }), { say: () => {}, uid: 501, exec: noLaunchd })).rejects.toThrow(/That backup file is damaged/);
      await expect(restoreProductionCommand(['--check'], config(p, { dumpDir: scratchDir('flint-dumps-') }), { say: () => {}, uid: 501, exec: noLaunchd })).rejects.toThrow(/There is no backup to restore from/);
    });

    it('typed at a terminal it restores, and says what happened in sentences; a rule of Will’s own that forbids it is honoured', async () => {
      const p = await production();
      const out: string[] = [];
      const asked: string[] = [];
      const launchd: string[] = [];
      let loaded = true;
      const exec = async (bin: string, args: string[]) => {
        launchd.push(`${bin} ${args[0]}`);
        if (args[0] === 'print') { if (!loaded) throw new Error('not loaded'); return 'state = running\n\tpid = 7\n'; }
        if (args[0] === 'bootout') loaded = false;
        if (args[0] === 'bootstrap') loaded = true;
        return '';
      };
      mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true });
      writeFileSync(join(home, 'Library', 'LaunchAgents', 'com.flint.runtime.plist'), '');
      // The dump is in the backup folder under its own name, as the nightly job leaves it.
      await restoreProductionCommand(['--dump', basename(dump)], config(p), { say: (l) => out.push(l), ask: async (q) => { asked.push(q); return ' RESTORE\n'; }, uid: 501, exec });
      expect(asked).toEqual(['Type RESTORE to continue: ']);
      expect(launchd).toContain('/bin/launchctl bootout');
      expect(launchd).toContain('/bin/launchctl bootstrap');
      const text = out.join('\n');
      expect(text).toMatch(/The backup is from .*\. It is less than an hour old\./);
      expect(text).toMatch(/Restored and verified in \d+ seconds?\./);
      expect(text).toMatch(new RegExp(`The database that was in use is kept as ${p.name}_damaged_\\d{8}t\\d{6}z, closed\\.`));
      expect(text).toContain('A copy of it is also in the pre-restore folder of your Flint backups.');
      for (const l of out) expect(l, l).toMatch(/^[A-Z].*\.$/);
      expect(await statusOf(p.owner, p.marker)).toBeUndefined();

      // Anything but the word leaves everything as it was.
      const q = await production();
      await expect(restoreProductionCommand(['--dump', basename(dump)], config(q), { say: () => {}, ask: async () => 'restore', uid: 501, exec })).rejects.toThrow('Nothing was changed.');
      expect(await statusOf(q.owner, q.marker)).toMatchObject({ status: 'pending' });
      // A row of Will's own that forbids restoring: the command reads it from the database in use and stops.
      await signedPolicy({ owner: q.owner, app: q.app, approver: q.approver }, keys.a, { pattern: 'restore.*', tier: 'forbidden' });
      const forbidden = await refusal(restoreProductionCommand(['--check', '--dump', basename(dump)], config(q), { say: () => {}, uid: 501, exec }));
      expect(forbidden.message).toBe('One of your own rules forbids restoring the database. Switch that rule off in the console first.');
      expect(forbidden.stage).toBe('tier');
    });

    it('restore-empty is the rebuild’s step: it says so by hand, and with the rebuild’s flag restores into the empty database the settings name', async () => {
      await admin((c) => c.query('CREATE DATABASE flint_cli OWNER flint_owner'));
      await admin((c) => c.query('ALTER SCHEMA public OWNER TO flint_owner'), 'flint_cli');
      const env = { FLINT_DB_OWNER_URL: onDb(urls.owner, 'flint_cli'), FLINT_DB_URL: onDb(urls.app, 'flint_cli'), FLINT_DB_BACKUP_URL: onDb(urls.backup, 'flint_cli') };
      const byHand = cli(['restore-empty', '--dump', dump], env);
      expect(byHand.status).toBe(1);
      expect(byHand.stdout.trim()).toBe("This is the rebuild script's step, not one to run by hand. To restore over the database in use, run restore-production.");
      const r = cli(['restore-empty', '--from-rebuild', '--dump', dump, '--sha256', dumpSha], env);
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      const lines = r.stdout.trim().split('\n');
      expect(lines[0]).toMatch(/^The database restored and passed its checks: \d+ tables match the backup's own counts\.$/);
      expect(lines[1]).toMatch(/^The rebuilt Flint starts from the backup/);
      for (const l of lines) expect(l, l).toMatch(/^[A-Z].*\.$/);
      for (const secret of [new URL(urls.owner).password, new URL(urls.app).password, 'postgresql://']) expect(r.stdout.includes(secret)).toBe(false);
      const again = cli(['restore-empty', '--from-rebuild', '--dump', dump, '--sha256', dumpSha], env);
      expect(again.status).toBe(0);
      expect(again.stdout.trim().split('\n')[0]).toBe('The database already holds this backup from an earlier run, and it passes its checks.');
      // A database that holds something else is refused in one sentence.
      await admin((c) => c.query('CREATE DATABASE flint_other OWNER flint_owner'));
      await connect(onDb(urls.owner, 'flint_other'), (c) => c.query('CREATE TABLE something (id integer)'));
      const refused = cli(['restore-empty', '--from-rebuild', '--dump', dump, '--sha256', dumpSha], { FLINT_DB_OWNER_URL: onDb(urls.owner, 'flint_other'), FLINT_DB_URL: onDb(urls.app, 'flint_other'), FLINT_DB_BACKUP_URL: onDb(urls.backup, 'flint_other') });
      // Its own way of ending (3), so the rebuild script can tell it from every other refusal: that script made the database.
      expect(refused.status).toBe(3);
      expect(refused.stdout.trim()).toBe('The database to restore into is not empty.');
    });

    it('settings that are missing, blank, or that name another machine or another database are refused by name, never by value', () => {
      const run = (env: Record<string, string>) => cli(['restore-empty', '--from-rebuild', '--dump', dump], env);
      const other = run({ FLINT_DB_OWNER_URL: 'postgresql://flint_owner:hunter2@db.example.com:5432/flint' });
      expect(other.status).toBe(1);
      expect(other.stderr).toMatch(/restore config is invalid: FLINT_DB_OWNER_URL: must be a database on this Mac/);
      expect(other.stdout + other.stderr).not.toContain('hunter2');
      // Blank, or not a URL at all: a name and a reason, never a raw error with the value in it.
      const blank = run({ FLINT_DB_OWNER_URL: '', FLINT_DB_URL: 'hunter2 is not a url' });
      expect(blank.status).toBe(1);
      expect(blank.stderr).toMatch(/restore config is invalid: FLINT_DB_OWNER_URL: is not set; FLINT_DB_URL: is not a URL/);
      expect(blank.stderr).not.toMatch(/TypeError|hunter2/);
      // The runtime's URL names another database than the owner's; the backup role's names another server; the owner's names Postgres's own.
      const mixed = run({ FLINT_DB_URL: onDb(urls.app, 'flint_test') });
      expect(mixed.stderr).toMatch(/FLINT_DB_URL: must name the same database as FLINT_DB_OWNER_URL/);
      const moved = new URL(urls.backup);
      moved.port = String(cluster.port + 1);
      expect(run({ FLINT_DB_BACKUP_URL: moved.toString() }).stderr).toMatch(/FLINT_DB_BACKUP_URL: must name the same database server as FLINT_DB_OWNER_URL/);
      expect(run({ FLINT_DB_OWNER_URL: onDb(urls.owner, 'postgres'), FLINT_DB_URL: onDb(urls.app, 'postgres') }).stderr).toMatch(/FLINT_DB_OWNER_URL: must name Flint's own database/);
      for (const r of [mixed]) expect(r.stdout + r.stderr).not.toContain(new URL(urls.app).password);
    });
  });
});

function dirname(p: string): string {
  return p.slice(0, p.lastIndexOf('/'));
}
