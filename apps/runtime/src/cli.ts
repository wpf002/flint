/**
 * The runtime's operator commands (plan P1 backups):
 *
 *   pnpm --filter @flint/runtime backup   [--auto]   pg_dump, 14 kept, BackupRun row
 *   pnpm --filter @flint/runtime offsite  [--auto]   age-encrypted copy off the box
 *   pnpm --filter @flint/runtime drill    [--auto]   restore the newest dump and compare
 *   pnpm --filter @flint/runtime p2-report            P2's exit criteria, measured now (JSON)
 *   pnpm --filter @flint/runtime p25-report           P2.5's exit criteria, measured now (JSON)
 *   pnpm --filter @flint/runtime promotion-table [--phase p2|p25] [--drop <pattern>]...
 *                                                    file a phase's promotion table for Will to sign
 *   pnpm --filter @flint/runtime google-login         sign in to Google once (calendar, read-only;
 *                                                    P2.5); needs no database
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
import { promotionTable, type Phase } from './governance/promotion.js';
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
  console.log('\nThen add FLINT_SOURCE_GOOGLE_CALENDAR=on to ~/.flint/runtime.override.env and approve world.source.enable for google_calendar.');
}

async function main(): Promise<void> {
  if (process.argv[2] === 'enroll') return enroll(process.argv.includes('--replace'));
  if (process.argv[2] === 'google-login') return loginToGoogle();
  if (process.argv[2] === 'promotion-table') {
    const drop = process.argv.flatMap((a, i) => (a === '--drop' && process.argv[i + 1] ? [process.argv[i + 1]!] : []));
    const at = process.argv.indexOf('--phase');
    const phase = at === -1 ? 'p2' : process.argv[at + 1];
    if (phase !== 'p2' && phase !== 'p25') throw new Error('promotion-table: --phase is p2 or p25');
    const config = loadRuntimeConfig();
    const db = createDb(config.databaseUrl);
    try {
      const t = await promotionTable(db, { phase: phase as Phase, drop });
      console.log(`${t.deduped ? 'already filed' : 'filed'}: proposal ${t.proposalId}, ${t.rows.length} rows to ALONE until ${t.rows[0]!.expiresAt}`);
      for (const r of t.rows) console.log(`  ${r.pattern}${r.dailyCap ? ` (cap ${r.dailyCap}/day)` : ''}`);
      console.log('Sign it in the console (Approvals) with your key, or let it expire.');
    } finally {
      await db.$disconnect();
    }
    return;
  }
  if (process.argv[2] === 'p2-report' || process.argv[2] === 'p25-report') {
    const config = loadRuntimeConfig();
    const db = createDb(config.databaseUrl);
    try {
      console.log(JSON.stringify(process.argv[2] === 'p2-report' ? await p2Report(db, config) : await p25Report(db, config), null, 2));
    } finally {
      await db.$disconnect();
    }
    return;
  }
  const cmd = process.argv[2] as Command;
  if (!(cmd in ACTION)) throw new Error('usage: cli.ts enroll [--replace] | google-login | p2-report | p25-report | promotion-table [--phase p2|p25] [--drop <pattern>] | backup|offsite|drill [--auto]');
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
      if (auto) await notifyWill(b.config, `${action} failed`, error ?? 'see ~/.flint/runtime-backup.err.log');
    }
  } finally {
    await db.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
