/**
 * The runtime's operator commands (plan P1 backups):
 *
 *   pnpm --filter @flint/runtime backup   [--auto]   pg_dump, 14 kept, BackupRun row
 *   pnpm --filter @flint/runtime offsite  [--auto]   age-encrypted copy off the box (iCloud Drive, 7 kept)
 *   pnpm --filter @flint/runtime drill    [--auto]   restore the newest dump and compare
 *   pnpm --filter @flint/runtime nexus-setup [--database <name>]
 *                                                    switch Nexus's own backup on (P7): work its address out
 *                                                    from Flint's backup address, check that the login is let
 *                                                    in and holds no right to change Nexus, and save it
 *   pnpm --filter @flint/runtime nexus-backup  [--auto]  the same dump of the Nexus database (~/FlintBackups/nexus)
 *   pnpm --filter @flint/runtime nexus-offsite [--auto]  its age-encrypted copy off the box (7 kept)
 *   pnpm --filter @flint/runtime nexus-drill   [--auto]  restore the newest Nexus dump into a scratch database
 *                                                    and compare; the Nexus database itself is never opened.
 *                                                    All three do nothing until the address is set.
 *   pnpm --filter @flint/runtime prune-backups [--remove]
 *                                                    list the old copies taken before database updates
 *                                                    that may go (the newest 10 and the last 30 days are
 *                                                    kept, and always the running release's); removes
 *                                                    them only with --remove. `prune-backups --auto` is
 *                                                    the nightly job's: it waits for a card until promoted.
 *                                                    (The script is not called `prune`: that is pnpm's own
 *                                                    command, which removes packages.)
 *   pnpm --filter @flint/runtime p2-report            P2's exit criteria, measured now (JSON)
 *   pnpm --filter @flint/runtime p25-report [--source google_calendar|apple_calendar]
 *                                                    P2.5's exit criteria for a calendar, measured now (JSON)
 *   pnpm --filter @flint/runtime p3-report            P3's exit criteria, measured now (JSON, numbers only)
 *   pnpm --filter @flint/runtime promotion-table [--phase p1|p2|p25|p26|p3|p3c] [--drop <pattern>]...
 *                                                    file a phase's promotion table for Will to sign
 *   pnpm --filter @flint/runtime enable-source <name> file the card that turns a source on, for Will
 *                                                    to sign in the console
 *   pnpm --filter @flint/runtime rules                list Will's rules that are switched on, each under its id
 *   pnpm --filter @flint/runtime rules --off <id>...  file the card that switches those rules off, for Will to
 *                                                    sign in the console (the only way a rule that holds an
 *                                                    action back goes off)
 *   pnpm --filter @flint/runtime predictions-on [key]...
 *                                                    file the Turn On Predictions card (P4), for Will to
 *                                                    sign in the console: every number Flint can
 *                                                    forecast, or the ones named
 *   pnpm --filter @flint/runtime google-login         sign in to Google once (calendar, read-only;
 *                                                    P2.5); needs no database
 *   pnpm --filter @flint/runtime apple-calendar       one line on Apple Calendar reading (P2.6):
 *                                                    its state, last read and event count, never a title
 *   pnpm --filter @flint/runtime restore-production [--dump <file>] [--without-copy] [--without-fingerprint]
 *                                                    replace the production database with a nightly backup
 *                                                    (P7): Will runs it in Terminal and types RESTORE; the
 *                                                    database in use is kept, closed, under another name
 *   pnpm --filter @flint/runtime restore-production --check
 *                                                    a trial run of the same restore: nothing in use is
 *                                                    changed, and it says how long a real one would take
 *   pnpm --filter @flint/runtime restore-production --compare
 *                                                    read the database in use and list every way it differs
 *                                                    from what this checkout builds; nothing is restored
 *   pnpm --filter @flint/runtime restore-production --repair
 *                                                    put right what a restore that was stopped part-way left
 *   pnpm --filter @flint/runtime restore-empty --from-rebuild --dump <file> [--sha256 <fingerprint>]
 *                                                    a rebuilt Mac: restore into the empty database (only
 *                                                    apps/studio/rebuild.sh runs it)
 *
 * Run by hand, it is Will acting (context console). With --auto (the nightly
 * LaunchAgent) it is Flint acting on its own, so the tier engine decides: an
 * action still at APPROVAL waits for Will's signed approval of a proposal it
 * files once a day; a promoted one claims its cap and runs.
 */
// Network: None of its own: it hands the Google sign-in a fetch scoped to Google's token endpoint (policy/egress.ts).
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { backupEnvFile, loadBackupConfig, loadRuntimeConfig } from './config.js';
import { p2Report } from './report/exit.js';
import { p25Report } from './report/p25.js';
import { p3Report } from './report/p3.js';
import { appleCalendarStatus } from './report/apple-calendar.js';
import { PHASES_LIST, promotionTable, type Phase } from './governance/promotion.js';
import { isCalendarSource } from './world/people.js';
import { proposeEnable } from './governance/internal.js';
import { RULES_SAY, proposeRulesOff, rulesLines, rulesOffFiledSays, rulesOn } from './governance/rules.js';
import { PREDICTIONS_OFF_SAYS, cardFiledSays, proposeForecasts } from './predict/enable.js';
import { FORECAST_SERIES_KEYS } from './predict/series.js';
import { Refused } from './governance/proposals.js';
import { SOURCES } from '@flint/policy';
import { createDb } from './db.js';
import { appendAudit } from './governance/audit.js';
import { ACTION, STEP, attempt, forNexus, gate, tellFailure, tellStopped, type Command } from './backup/nightly.js';
import { NEXUS_OFF, nexusHelp, nexusSetup, nexusSetupArgs } from './backup/nexus.js';
import { PRUNE_ACTION, pruneJob, pruneLines, pruneMode } from './backup/prune-job.js';
import { fileBackup, fileFailure } from './backup/record.js';
import { completeProposal } from './governance/proposals.js';
import { FLINT_SET, NEXUS_SET, dumpDatabase, dumpPathAt, newestDump, pruneDumps, restoreDrill } from './backup/backup.js';
import { sendOffsite, type OffsiteConfig } from './backup/offsite.js';
import { notifyWill } from './notify.js';
import { scopedFetch } from './policy/egress.js';
import { googleLogin, TOKEN_ENDPOINTS } from './sources/google/oauth.js';
import { loadRestoreConfig } from './config.js';
import { RestoreRefused, writeDumpHash } from './backup/restore.js';
import { restoreEmptyCommand, restoreProductionCommand, terminal } from './backup/restore-cli.js';

/**
 * `enroll`: a one-time code for registering Will's approval key in the console
 * (plan 3.0.2). Written to ~/.flint/enroll-code (0600); the server deletes it
 * once a key is registered with it. `enroll --replace` writes a code that, once
 * used, revokes every enrolled key and keeps only the new one: the way back
 * when the only key is lost (the Mac is wiped or replaced).
 */
function enroll(replace: boolean): void {
  const home = homedir();
  const file = join(home, '.flint', 'enroll-code');
  const code = [0, 1, 2, 3].map(() => randomBytes(3).toString('hex')).join('-');
  writeFileSync(file, `${code}${replace ? ' replace' : ''}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  console.log(`enrolment code (one use; type it in the console's Settings → Approval key):\n\n  ${code}\n`);
  if (replace) console.log('This is a REPLACE code: the key you register with it becomes the only one; every other key is revoked.\n');
}

/**
 * `google-login`: the one-time Google sign-in (P2.5). It reaches Google's
 * token endpoint and nothing else, and opens the consent page with open(1)
 * directly (no shell, so the URL is one argument whatever it holds).
 */
async function loginToGoogle(): Promise<void> {
  await googleLogin({
    home: homedir(),
    fetch: scopedFetch(TOKEN_ENDPOINTS),
    open: (url) => new Promise<void>((resolve, reject) => execFile('/usr/bin/open', [url], { timeout: 10_000 }, (err) => (err ? reject(err) : resolve()))),
    log: (line) => console.log(line),
  });
  // The override file must stay 0600 (the runtime refuses to start on a looser one), so the commands make it so.
  console.log([
    '',
    'Then switch it on (the runtime refuses an override file anyone else can read, so keep it 0600):',
    '  touch ~/.flint/runtime.override.env && chmod 600 ~/.flint/runtime.override.env',
    // On its own line, once: a file saved without a final newline would glue it onto its last setting.
    "  grep -q '^FLINT_SOURCE_GOOGLE_CALENDAR=' ~/.flint/runtime.override.env || printf '\\nFLINT_SOURCE_GOOGLE_CALENDAR=on\\n' >> ~/.flint/runtime.override.env",
    '  launchctl kickstart -k gui/$(id -u)/com.flint.runtime',
    'and file its card, then sign it in the console\'s Approvals:',
    '  cd ~/flint && pnpm --filter @flint/runtime enable-source google_calendar',
  ].join('\n'));
}

/**
 * `prune`: remove the old copies of the database that deploys took before a
 * migration (backup/prune.ts says which stay; backup/prune-job.ts who may
 * remove them). By hand it lists what would go and removes it only with
 * --remove, in sentences. With --auto it is the nightly job's, and what it
 * prints is a line for the job's log.
 */
async function pruneOldBackups(argv: readonly string[]): Promise<void> {
  const mode = pruneMode(argv);
  const config = loadRuntimeConfig();
  const db = createDb(config.databaseUrl);
  try {
    const o = await pruneJob(db, { home: config.home, tz: config.tz, rp: config.rp, now: new Date(), mode });
    if (mode === 'auto') {
      const counts = JSON.stringify({ would: o.would, removed: o.removed, megabytes: o.megabytes, kept: o.kept, failed: o.failed });
      console.log(`${PRUNE_ACTION}: ${o.did === 'removed' ? 'ok' : o.did === 'failed' ? 'FAILED' : `not run (${o.did === 'waiting' ? o.why : o.did === 'held' ? 'the running release could not be told' : 'nothing to remove'})`} ${counts}`);
    } else {
      for (const line of pruneLines(o)) console.log(line);
    }
    // It could not do all it was asked to, or a rule of Will's would not let it: the command says so by failing.
    if (o.did === 'failed' || o.did === 'forbidden') process.exitCode = 1;
  } finally {
    await db.$disconnect();
  }
}

async function main(): Promise<void> {
  if (process.argv[2] === 'enroll') return enroll(process.argv.includes('--replace'));
  if (process.argv[2] === 'google-login') return loginToGoogle();
  if (process.argv[2] === 'enable-source') {
    const source = process.argv[3] ?? '';
    if (!(SOURCES as readonly string[]).includes(source)) throw new Error(`enable-source: one of ${SOURCES.join(', ')}`);
    const config = loadRuntimeConfig();
    const db = createDb(config.databaseUrl);
    try {
      const p = await proposeEnable(db, source);
      console.log(`${p.deduped ? 'already filed' : 'filed'}: proposal ${p.id}, to turn on ${source}. Sign it in the console (Approvals) with your key; it runs once signed.`);
    } finally {
      await db.$disconnect();
    }
    return;
  }
  if (process.argv[2] === 'rules') {
    const rest = process.argv.slice(3);
    // `rules` lists; `rules --off <id>...` files the card. Anything else is said, and nothing is filed.
    if (rest.length && rest[0] !== '--off') throw new Error('rules: run it alone to list your rules, or with --off <id>... to file the card that switches some off');
    const config = loadRuntimeConfig();
    const db = createDb(config.databaseUrl);
    try {
      if (!rest.length) {
        for (const line of rulesLines(await rulesOn(db), config.tz)) console.log(line);
        return;
      }
      if (rest.length === 1) throw new Refused(400, RULES_SAY.none);
      console.log(rulesOffFiledSays(await proposeRulesOff(db, rest.slice(1))));
    } catch (err) {
      // A refusal is Flint's own sentence: said as it is, with nothing filed, and the command fails.
      if (!(err instanceof Refused)) throw err;
      console.log(`Not filed: ${err.message}`);
      process.exitCode = 1;
    } finally {
      await db.$disconnect();
    }
    return;
  }
  if (process.argv[2] === 'predictions-on') {
    const keys = process.argv.slice(3);
    const config = loadRuntimeConfig();
    // Switched off on this Mac: said, nothing is filed, and the command fails (as enable-source does for a bad name).
    if (!config.predict) {
      console.log(PREDICTIONS_OFF_SAYS);
      process.exitCode = 1;
      return;
    }
    const db = createDb(config.databaseUrl);
    try {
      const p = await proposeForecasts(db, keys.length ? keys : FORECAST_SERIES_KEYS);
      console.log(cardFiledSays(p, keys.length ? new Set(keys).size : FORECAST_SERIES_KEYS.length));
    } catch (err) {
      // A refusal is Flint's own sentence ("That number can’t be forecast."): said as it is, with nothing filed, and
      // the command fails.
      if (!(err instanceof Refused)) throw err;
      console.log(`Not filed: ${err.message}`);
      process.exitCode = 1;
    } finally {
      await db.$disconnect();
    }
    return;
  }
  if (process.argv[2] === 'promotion-table') {
    const drop = process.argv.flatMap((a, i) => (a === '--drop' && process.argv[i + 1] ? [process.argv[i + 1]!] : []));
    const at = process.argv.indexOf('--phase');
    const phase = at === -1 ? 'p2' : process.argv[at + 1];
    if (!(PHASES_LIST as readonly unknown[]).includes(phase)) throw new Error(`promotion-table: --phase is ${PHASES_LIST.slice(0, -1).join(', ')} or ${PHASES_LIST[PHASES_LIST.length - 1]}`);
    const config = loadRuntimeConfig();
    const db = createDb(config.databaseUrl);
    try {
      const t = await promotionTable(db, { phase: phase as Phase, drop, tz: config.tz });
      console.log(`${t.deduped ? 'already filed' : 'filed'}: proposal ${t.proposalId}, ${t.rows.length} rows to ALONE until ${t.rows[0]!.expiresAt}`);
      for (const r of t.rows) console.log(`  ${r.pattern}${r.dailyCap ? ` (cap ${r.dailyCap}/day)` : ''}`);
      console.log('Sign it in the console (Approvals) with your key, or let it expire.');
    } finally {
      await db.$disconnect();
    }
    return;
  }
  if (process.argv[2] === 'p2-report' || process.argv[2] === 'p25-report') {
    const at = process.argv.indexOf('--source');
    const source = at === -1 ? 'google_calendar' : process.argv[at + 1];
    if (!isCalendarSource(source)) throw new Error('p25-report: --source is google_calendar or apple_calendar');
    const config = loadRuntimeConfig();
    const db = createDb(config.databaseUrl);
    try {
      console.log(JSON.stringify(process.argv[2] === 'p2-report' ? await p2Report(db, config) : await p25Report(db, config, new Date(), source), null, 2));
    } finally {
      await db.$disconnect();
    }
    return;
  }
  if (process.argv[2] === 'p3-report') {
    const config = loadRuntimeConfig();
    const db = createDb(config.databaseUrl);
    try {
      console.log(JSON.stringify(await p3Report(db, { tz: config.tz, planner: config.planner }), null, 2));
    } finally {
      await db.$disconnect();
    }
    return;
  }
  if (process.argv[2] === 'apple-calendar') {
    const config = loadRuntimeConfig();
    const db = createDb(config.databaseUrl);
    try {
      console.log(await appleCalendarStatus(db, { on: config.appleCalendar }));
    } finally {
      await db.$disconnect();
    }
    return;
  }
  if (process.argv[2] === 'restore-production' || process.argv[2] === 'restore-empty') {
    const say = (line: string) => console.log(line);
    const args = process.argv.slice(3);
    try {
      if (process.argv[2] === 'restore-empty') await restoreEmptyCommand(args, loadRestoreConfig(), { say });
      else {
        const ask = terminal(process.stdin, process.stdout);
        // Ctrl-C, a closed window or a kill: the restore hears it. Before the swap it ends at once, with nothing in use
        // touched; during the swap it finishes or undoes the swap first (restore.ts).
        const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
        await restoreProductionCommand(args, loadRestoreConfig(), {
          say,
          ...(ask ? { ask } : {}),
          uid: process.getuid?.() ?? 0,
          onSignal: (handler) => {
            for (const s of signals) process.on(s, handler);
            return () => {
              for (const s of signals) process.off(s, handler);
            };
          },
          exit: () => {
            console.log('Flint stopped because it was interrupted. Nothing in use was changed.');
            process.exit(130);
          },
        });
      }
    } catch (err) {
      // A refusal is a sentence for Will, then any more he needs (a command on a line of its own); anything else is a
      // fault and goes to the handler below.
      if (!(err instanceof RestoreRefused)) throw err;
      console.log(err.message);
      for (const line of err.lines) console.log(line);
      // 3: a rebuild's database is not empty. The rebuild script, which made that database, tells it from every other refusal.
      process.exitCode = err.stage === 'not-empty' ? 3 : 1;
    }
    return;
  }
  if (process.argv[2] === 'prune') return pruneOldBackups(process.argv.slice(3));
  if (process.argv[2] === 'nexus-setup') {
    const { database } = nexusSetupArgs(process.argv.slice(3));
    const ok = await nexusSetup({ backupEnv: backupEnvFile(), database, say: (line) => console.log(line) });
    if (!ok) process.exitCode = 1;
    return;
  }
  const cmd = process.argv[2] as Command;
  if (!(cmd in ACTION)) throw new Error('usage: cli.ts enroll [--replace] | enable-source <name> | rules [--off <id>...] | predictions-on [key]... | google-login | apple-calendar | p2-report | p25-report [--source google_calendar|apple_calendar] | p3-report | promotion-table [--phase p1|p2|p25|p26|p3|p3c] [--drop <pattern>] | backup|offsite|drill [--auto] | nexus-setup [--database <name>] | nexus-backup|nexus-offsite|nexus-drill [--auto] | prune [--remove] | prune --auto | restore-production [--dump <file>] [--without-copy] [--without-fingerprint] [--check] | restore-production --compare | restore-production --repair | restore-empty --from-rebuild --dump <file>');
  const auto = process.argv.includes('--auto');
  const b = loadBackupConfig();
  const action = ACTION[cmd];
  // Which database this is for, and so which files, names and records are its own.
  const nexus = forNexus(cmd);
  const step = STEP[cmd];
  const set = nexus ? NEXUS_SET : FLINT_SET;
  if (nexus && !b.nexus) {
    // Off: nothing of Nexus's backup runs, no card is filed, and neither database is opened.
    if (auto) console.log(`${action}: not run (off: no address is set for the Nexus database)`);
    else {
      for (const line of NEXUS_OFF) console.log(line);
      process.exitCode = 1;
    }
    return;
  }
  if (nexus && b.nexus!.problem) {
    // An address that cannot be used (not on this Mac, not Postgres, Flint's own database): none of Nexus's
    // steps runs, and none asks for a card it could not act on. Said here, with what to run; Settings > Health
    // says it too, for as long as it lasts (health/checks.ts). Neither database is opened.
    console.log(`${action}: not run (${b.nexus!.problem})`);
    for (const line of nexusHelp(undefined, b.nexus!, step)) console.log(line);
    if (!auto) process.exitCode = 1;
    return;
  }
  const where = nexus
    ? { dumpDir: b.nexus!.dumpDir, offsiteDir: b.nexus!.offsiteDir, offsiteManifest: b.nexus!.offsiteManifest }
    : { dumpDir: b.dumpDir, offsiteDir: b.offsiteDir, offsiteManifest: b.offsiteManifest };
  const db = createDb(b.config.databaseUrl);
  const now = new Date();
  const actor = auto ? 'runtime' : 'will:cli';
  const context = auto ? 'autonomous' : 'console';
  // How Will is told, for a failure and for a run that stopped before it began.
  const telling = {
    tz: b.config.tz, rp: b.config.rp, now,
    notify: (title, body) => notifyWill(b.config, title, body),
  } satisfies Parameters<typeof tellFailure>[3];
  /** What went wrong with Nexus's own setup, for the lines after the FAILED one (nexusHelp); nothing else is kept of it. */
  let refused: unknown;
  /** How many large objects a Nexus dump left out (no dump includes them); said after the dump when there are any. */
  let left = 0;
  try {
    let proposalId: string | undefined;
    if (auto) {
      // The first question to the database. With no answer the job cannot tell what it may do, and used to end
      // here in a log line alone: Will is told once a night (tellStopped), and the error goes on to the log.
      const g = await gate(db, cmd, b.config.tz, b.config.rp, now).catch(async (err: unknown) => {
        await tellStopped(cmd, { icloud: b.offsiteICloud, tz: telling.tz, now, mark: join(b.config.home, '.flint', 'nightly-stopped'), notify: telling.notify }).catch(() => undefined);
        throw err;
      });
      if (!g.go) {
        console.log(`${action}: not run (${g.why})`);
        return;
      }
      proposalId = g.proposalId;
    }
    // The job's own work. Whatever it throws is its failure, classified once (attempt): one another try
    // could change, or one that stays until its setup is fixed.
    const o = await attempt(async () => {
      try {
        if (step === 'backup') {
          const d = await dumpDatabase(nexus ? b.nexus!.backupUrl! : b.backupUrl, where.dumpDir, b.tools, now, set);
          // The dump's fingerprint, kept beside it: a restore can check the file when the database cannot be asked.
          writeDumpHash(d.path, d.sha256, b.fingerprintKey);
          const pruned = pruneDumps(where.dumpDir, 14, set.prefix);
          if (nexus) await fileBackup(db, { kind: set.kind, location: 'local', path: d.path, bytes: d.bytes, sha256: d.sha256, startedAt: now });
          else {
            await db.backupRun.create({
              data: { kind: 'pg_dump_flint', location: 'local', path: d.path, bytes: BigInt(d.bytes), sha256: d.sha256, encrypted: false, status: 'ok', startedAt: now, finishedAt: new Date() },
            });
          }
          left = d.largeObjects ?? 0;
          return { detail: { bytes: d.bytes, sha256: d.sha256, tables: Object.keys(d.counts).length, pruned: pruned.length, ...(d.largeObjects === undefined ? {} : { largeObjects: d.largeObjects }) } };
        }
        if (step === 'offsite') {
          // The same key and the same offsite place as Flint's own copy; this set's own folders, names and list.
          const cfg: OffsiteConfig = {
            ...(b.ageRecipient ? { ageRecipient: b.ageRecipient } : {}), ...(b.offsiteProblem ? { offsiteProblem: b.offsiteProblem } : {}),
            ...(where.offsiteDir ? { offsiteDir: where.offsiteDir } : {}), offsiteManifest: where.offsiteManifest, dumpDir: where.dumpDir, tools: b.tools,
          };
          return { detail: await sendOffsite(db, cfg, now, undefined, { set, action }) };
        }
        const dump = newestDump(where.dumpDir, set.prefix);
        if (!dump) throw new Error('no dump to restore');
        const r = await restoreDrill(dump, b.restoreUrl, b.tools, set);
        const run = await db.backupRun.findFirst({ where: { path: dump, kind: set.kind, location: 'local' }, orderBy: { startedAt: 'desc' } });
        if (run) await db.backupRun.update({ where: { id: run.id }, data: { restoreTestedAt: new Date(), restoreOk: r.ok, restoreDetail: { tables: r.tables, mismatches: r.mismatches } } });
        return { ok: r.ok, mismatch: !r.ok, detail: { tables: r.tables, mismatches: r.mismatches.length }, ...(r.ok ? {} : { error: `row counts differ in ${r.mismatches.length === 1 ? '1 table' : `${r.mismatches.length} tables`}` }) };
      } catch (err) {
        refused = err;
        throw err;
      }
    });
    const { ok, error, detail } = o;
    // A run that failed is on record beside the ones that worked (Health says "the last backup failed" from it,
    // without waiting for the last good one to grow old). Only for a file that has no record: a failure never
    // takes a good record's place. The database may be why it failed, so this is tried and no more.
    if (!ok && step !== 'drill') {
      const newest = step === 'offsite' ? newestDump(where.dumpDir, set.prefix) : undefined;
      const path = step === 'backup' ? dumpPathAt(where.dumpDir, now, set.prefix) : newest && where.offsiteDir ? join(where.offsiteDir, `${basename(newest)}.age`) : undefined;
      if (path) await fileFailure(db, { kind: set.kind, location: step === 'backup' ? 'local' : 'icloud', path, startedAt: now }).catch(() => undefined);
    }
    if (proposalId) {
      // Recording the proposal's end must not cost the job's own audit row or the failure notice.
      await completeProposal(db, proposalId, { ok, ...(error ? { error } : {}), result: detail }, actor).catch((err: unknown) =>
        console.error(`${action}: could not complete its proposal: ${err instanceof Error ? err.message : String(err)}`),
      );
    }
    await appendAudit(db, [{ actor, context, kind: 'action', action, decision: 'act', outcome: ok ? 'ok' : 'failed', inputs: detail, ...(error ? { reasoning: error.slice(0, 1000) } : {}), ...(proposalId ? { correlationId: proposalId } : {}) }]);
    console.log(`${action}: ${ok ? 'ok' : `FAILED: ${error}`} ${JSON.stringify(detail)}`);
    if (ok && left > 0) console.log(left === 1 ? 'Nexus holds 1 large object. No backup includes it, so it was left out.' : `Nexus holds ${left} large objects. No backup includes them, so they were left out.`);
    if (!ok) {
      process.exitCode = 1;
      // Nexus would not let Flint read it: what is wrong and the commands that put it right, in the job's log and
      // in Terminal alike. Only the backup's own failures get that advice; a restore test that was refused in its
      // scratch database gets a sentence of its own (nexusHelp). The owner's side runs the commands; Flint never
      // changes Nexus.
      if (nexus) for (const line of nexusHelp(refused, b.nexus!, step)) console.log(line);
      // The error itself is in the FAILED line above (stdout, the LaunchAgent's out.log) and the audit. The note
      // says what happened and what happens next, in Will's words, and promises only what is true (tellFailure):
      //  - a failure another try cannot change says its setup needs fixing;
      //  - a job he promoted runs again at its next time by itself (the nightly LaunchAgent, 02:15; the drill on Sundays);
      //  - one that ran on a card waits for his next approval, and that card is filed first, so it is there to approve.
      if (auto) {
        await tellFailure(db, cmd, { setup: o.setup, mismatch: o.mismatch, icloud: b.offsiteICloud, ...(proposalId !== undefined ? { proposalId } : {}) }, telling);
      }
    }
  } finally {
    await db.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
