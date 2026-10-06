/**
 * The runtime's operator commands (plan P1 backups):
 *
 *   pnpm --filter @flint/runtime backup   [--auto]   pg_dump, 14 kept, BackupRun row
 *   pnpm --filter @flint/runtime offsite  [--auto]   age-encrypted copy off the box
 *   pnpm --filter @flint/runtime drill    [--auto]   restore the newest dump and compare
 *   pnpm --filter @flint/runtime p2-report            P2's exit criteria, measured now (JSON)
 *   pnpm --filter @flint/runtime p25-report [--source google_calendar|apple_calendar]
 *                                                    P2.5's exit criteria for a calendar, measured now (JSON)
 *   pnpm --filter @flint/runtime promotion-table [--phase p1|p2|p25|p26] [--drop <pattern>]...
 *                                                    file a phase's promotion table for Will to sign
 *   pnpm --filter @flint/runtime enable-source <name> file the card that turns a source on, for Will
 *                                                    to sign in the console
 *   pnpm --filter @flint/runtime google-login         sign in to Google once (calendar, read-only;
 *                                                    P2.5); needs no database
 *   pnpm --filter @flint/runtime apple-calendar       one line on Apple Calendar reading (P2.6):
 *                                                    its state, last read and event count, never a title
 *
 * Run by hand, it is Will acting (context console). With --auto (the nightly
 * LaunchAgent) it is Flint acting on its own, so the tier engine decides: an
 * action still at APPROVAL waits for Will's signed approval of a proposal it
 * files once a day; a promoted one claims its cap and runs.
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadBackupConfig, loadRuntimeConfig } from './config.js';
import { p2Report } from './report/exit.js';
import { p25Report } from './report/p25.js';
import { appleCalendarStatus } from './report/apple-calendar.js';
import { PHASES_LIST, promotionTable, type Phase } from './governance/promotion.js';
import { isCalendarSource } from './world/people.js';
import { proposeEnable } from './governance/internal.js';
import { SOURCES } from '@flint/policy';
import { createDb } from './db.js';
import { appendAudit } from './governance/audit.js';
import { ACTION, gate, type Command } from './backup/nightly.js';
import { completeProposal } from './governance/proposals.js';
import { dumpDatabase, encryptTo, newestDump, pruneDumps, restoreDrill } from './backup/backup.js';
import { notifyWill } from './notify.js';
import { scopedFetch } from './policy/egress.js';
import { googleLogin, TOKEN_ENDPOINTS } from './sources/google/oauth.js';

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
  const cmd = process.argv[2] as Command;
  if (!(cmd in ACTION)) throw new Error('usage: cli.ts enroll [--replace] | enable-source <name> | google-login | apple-calendar | p2-report | p25-report [--source google_calendar|apple_calendar] | promotion-table [--phase p1|p2|p25|p26] [--drop <pattern>] | backup|offsite|drill [--auto]');
  const auto = process.argv.includes('--auto');
  const b = loadBackupConfig();
  const db = createDb(b.config.databaseUrl);
  const now = new Date();
  const action = ACTION[cmd];
  const actor = auto ? 'runtime' : 'will:cli';
  const context = auto ? 'autonomous' : 'console';
  try {
    let proposalId: string | undefined;
    if (auto) {
      const g = await gate(db, cmd, b.config.tz, b.config.rp, now);
      if (!g.go) {
        console.log(`${action}: not run (${g.why})`);
        return;
      }
      proposalId = g.proposalId;
    }
    let detail: Record<string, string | number | boolean | null> = {};
    let ok = true;
    let error: string | undefined;
    try {
      if (cmd === 'backup') {
        const d = await dumpDatabase(b.backupUrl, b.dumpDir, b.tools, now);
        const pruned = pruneDumps(b.dumpDir, 14);
        await db.backupRun.create({
          data: { kind: 'pg_dump_flint', location: 'local', path: d.path, bytes: BigInt(d.bytes), sha256: d.sha256, encrypted: false, status: 'ok', startedAt: now, finishedAt: new Date() },
        });
        detail = { bytes: d.bytes, sha256: d.sha256, tables: Object.keys(d.counts).length, pruned: pruned.length };
      } else if (cmd === 'offsite') {
        if (!b.ageRecipient) throw new Error('no age recipient: put Will\'s public key in ~/.flint/backup-age-recipient');
        if (!b.offsiteDir) throw new Error('FLINT_OFFSITE_DIR is not set');
        const dump = newestDump(b.dumpDir);
        if (!dump) throw new Error('no local dump to send');
        const e = await encryptTo(dump, b.ageRecipient, b.tools, b.offsiteDir);
        await db.backupRun.create({ data: { kind: 'pg_dump_flint', location: 'icloud', path: e.path, bytes: BigInt(e.bytes), sha256: e.sha256, encrypted: true, status: 'ok', startedAt: now, finishedAt: new Date() } });
        detail = { bytes: e.bytes, sha256: e.sha256 };
      } else {
        const dump = newestDump(b.dumpDir);
        if (!dump) throw new Error('no dump to restore');
        const r = await restoreDrill(dump, b.restoreUrl, b.tools);
        ok = r.ok;
        const run = await db.backupRun.findFirst({ where: { path: dump }, orderBy: { startedAt: 'desc' } });
        if (run) await db.backupRun.update({ where: { id: run.id }, data: { restoreTestedAt: new Date(), restoreOk: r.ok, restoreDetail: { tables: r.tables, mismatches: r.mismatches } } });
        detail = { tables: r.tables, mismatches: r.mismatches.length };
        if (!r.ok) error = `row counts differ in ${r.mismatches.length} table(s)`;
      }
    } catch (err) {
      ok = false;
      error = err instanceof Error ? err.message : String(err);
    }
    if (proposalId) {
      // Recording the proposal's end must not cost the job's own audit row or the failure notice.
      await completeProposal(db, proposalId, { ok, ...(error ? { error } : {}), result: detail }, actor).catch((err: unknown) =>
        console.error(`${action}: could not complete its proposal: ${err instanceof Error ? err.message : String(err)}`),
      );
    }
    await appendAudit(db, [{ actor, context, kind: 'action', action, decision: 'act', outcome: ok ? 'ok' : 'failed', inputs: detail, ...(error ? { reasoning: error.slice(0, 1000) } : {}), ...(proposalId ? { correlationId: proposalId } : {}) }]);
    console.log(`${action}: ${ok ? 'ok' : `FAILED: ${error}`} ${JSON.stringify(detail)}`);
    if (!ok) {
      process.exitCode = 1;
      // The error itself is in the FAILED line above (stdout, the LaunchAgent's out.log) and the audit.
      if (auto) await notifyWill(b.config, `${action} failed`, `${FAILED_WORDS[cmd]} failed. The details are in ~/.flint/runtime-backup.out.log.`);
    }
  } finally {
    await db.$disconnect();
  }
}

/** Which run failed, for the note Will reads (the nightly LaunchAgent runs these at 02:15; the drill on Sundays). */
const FAILED_WORDS: Record<Command, string> = { backup: 'Last night’s backup', offsite: 'Last night’s offsite copy', drill: 'This week’s restore test' };

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
