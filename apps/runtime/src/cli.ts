/**
 * The runtime's operator commands (plan P1 backups):
 *
 *   pnpm --filter @flint/runtime backup   [--auto]   pg_dump, 14 kept, BackupRun row
 *   pnpm --filter @flint/runtime offsite  [--auto]   age-encrypted copy off the box
 *   pnpm --filter @flint/runtime drill    [--auto]   restore the newest dump and compare
 *
 * Run by hand, it is Will acting (context console). With --auto (the nightly
 * LaunchAgent) it is Flint acting on its own, so the tier engine decides: an
 * action still at APPROVAL waits for Will's signed approval of a proposal it
 * files once a day; a promoted one claims its cap and runs.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveTier, type WebAuthnRelyingParty } from '@flint/policy';
import { loadBackupConfig } from './config.js';
import { createDb, type Db } from './db.js';
import { appendAudit } from './governance/audit.js';
import { activePolicies, claimProposal, completeProposal, createProposal } from './governance/proposals.js';
import { claim } from './governance/counters.js';
import { dumpDatabase, encryptTo, newestDump, pruneDumps, restoreDrill } from './backup/backup.js';
import { notifyWill } from './notify.js';

type Command = 'backup' | 'offsite' | 'drill';
const ACTION: Record<Command, string> = { backup: 'backup.local', offsite: 'backup.offsite', drill: 'restore.drill' };

async function gate(db: Db, cmd: Command, tz: string, rp: WebAuthnRelyingParty | undefined, now: Date): Promise<{ go: boolean; proposalId?: string; why: string }> {
  const action = ACTION[cmd];
  const t = resolveTier(action, { context: 'autonomous', tainted: false, policies: await activePolicies(db, now), now });
  if (t.tier === 'forbidden') return { go: false, why: `forbidden: ${t.reason}` };
  if (t.tier === 'alone') {
    if (t.cap && (await claim(db, t.key, t.cap, tz, now)) === null) return { go: false, why: `the ${t.cap.period}ly cap is reached` };
    return { go: true, why: 'promoted' };
  }
  // APPROVAL: run an approved proposal for it, or file one (one a day) and wait.
  const day = now.toISOString().slice(0, 10);
  const approved = await db.proposal.findFirst({ where: { action, origin: `runtime:${cmd}`, status: 'approved', expiresAt: { gt: now } }, orderBy: { createdAt: 'desc' } });
  let refused: string | undefined;
  if (approved) {
    try {
      const c = await claimProposal(db, approved.id, rp, tz, 'runtime');
      return { go: true, proposalId: c.id, why: 'approved by Will' };
    } catch (err) {
      // Expired a moment ago, re-verification failed, a cap: say so, and ask again below.
      refused = err instanceof Error ? err.message : String(err);
    }
  }
  const pending = await db.proposal.findFirst({ where: { action, origin: `runtime:${cmd}`, status: 'pending', expiresAt: { gt: now } } });
  if (!pending) {
    await createProposal(db, {
      kind: 'tool_call', origin: `runtime:${cmd}`, templateId: `nightly.${cmd}`, action, args: { day },
      argsProvenance: { day: { source: 'template', ref: `nightly.${cmd}`, tainted: false } },
      // Long enough for the next night's run to find it once Will has approved it.
      tainted: false, sensitivity: 'ops', destructive: false, consequential: false, ttlMinutes: 47 * 60,
      reason: `nightly ${cmd}: waiting for approval until this action is promoted`,
    }, 'runtime');
  }
  return { go: false, why: refused ? `the approved proposal could not be claimed (${refused}); asked again` : 'waiting for Will to approve (or promote) it' };
}

/**
 * `enroll`: a one-time code for registering Will's approval key in the console
 * (plan 3.0.2). Written to ~/.flint/enroll-code (0600); the server deletes it
 * once a key is registered with it. `enroll --replace` writes a code that, once
 * used, revokes every enrolled key and keeps only the new one: the way back
 * when the only key is lost (a fingerprint change kills a Touch ID key).
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

async function main(): Promise<void> {
  if (process.argv[2] === 'enroll') return enroll(process.argv.includes('--replace'));
  const cmd = process.argv[2] as Command;
  if (!(cmd in ACTION)) throw new Error('usage: cli.ts enroll [--replace] | backup|offsite|drill [--auto]');
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
