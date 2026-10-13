/**
 * P7: replacing the production database with a backup (`restore.production`)
 * is Will's alone. APPROVAL in code for him at the keyboard, never promotable,
 * forbidden from chat, and not an autonomous action: Flint on its own is refused it whatever a
 * policy row says. The scratch restore drill keeps its own, promotable entry.
 */
import { describe, it, expect } from 'vitest';
import { resolveTier, forbiddenReason, CODE_TABLE, AUTONOMOUS_ACTIONS, CONSOLE_ONLY, NEVER_FROM_CHAT, type PolicyRow, type TierContext } from '../src/tiers';
import { BACKUP_EVENT_REASONS, BackupEvent } from '../src/wire';
import { JOB_WORDS, WEEKLY_JOBS, jobFailedNote, ruleWords } from '../src/action-words';
import { HEALTH_GROUPS, HEALTH_NAMES, healthGroup } from '../src/health-names';
import { noteProblems } from '../src/notes';

const chat: TierContext = { context: 'chat', tainted: false };
const auto: TierContext = { context: 'autonomous', tainted: false };
const NOW = new Date('2026-10-01T12:00:00Z');
const row = (pattern: string, tier: PolicyRow['tier']): PolicyRow => ({ pattern, tier, active: true, expiresAt: '2027-03-30T00:00:00Z' });

describe('P7: restoring the production database', () => {
  const consoleCtx: TierContext = { context: 'console', tainted: false };

  it('is APPROVAL in code for Will at the keyboard, and never ALONE whatever a policy row says', () => {
    expect(CODE_TABLE['restore.production']).toMatchObject({ tier: 'approval', promotable: false, write: true });
    expect(resolveTier('restore.production', consoleCtx)).toMatchObject({ tier: 'approval', rule: 'code' });
    const promoted = resolveTier('restore.production', { ...consoleCtx, policies: [row('restore.production', 'alone'), row('restore.*', 'alone')], now: NOW });
    expect(promoted.tier).toBe('approval');
  });

  it('a row of Will\'s own that forbids it is honoured, at the keyboard too', () => {
    for (const pattern of ['restore.production', 'restore.*']) {
      expect(resolveTier('restore.production', { ...consoleCtx, policies: [row(pattern, 'forbidden')], now: NOW })).toMatchObject({ tier: 'forbidden', rule: 'policy' });
    }
    // One that has expired, or was switched off, no longer does.
    expect(resolveTier('restore.production', { ...consoleCtx, policies: [{ ...row('restore.*', 'forbidden'), active: false }], now: NOW }).tier).toBe('approval');
    expect(resolveTier('restore.production', { ...consoleCtx, policies: [{ ...row('restore.*', 'forbidden'), expiresAt: '2026-09-30T00:00:00Z' }], now: NOW }).tier).toBe('approval');
  });

  it('is FORBIDDEN from chat: nothing but the command Will runs himself may even ask for it', () => {
    expect(CONSOLE_ONLY.has('restore.production')).toBe(true);
    expect(resolveTier('restore.production', chat)).toMatchObject({ tier: 'forbidden', rule: 'forbidden' });
    expect(resolveTier('restore.production', { ...chat, policies: [row('restore.*', 'alone')], now: NOW }).tier).toBe('forbidden');
    // The drill, which only ever touches a scratch database, is not console-only.
    expect(CONSOLE_ONLY.has('restore.drill')).toBe(false);
    expect(resolveTier('restore.drill', chat).tier).toBe('approval');
  });

  it('is FORBIDDEN for Flint on its own: it is not an autonomous action, and a promotion does not make it one', () => {
    expect(AUTONOMOUS_ACTIONS.has('restore.production')).toBe(false);
    expect(resolveTier('restore.production', auto).tier).toBe('forbidden');
    expect(resolveTier('restore.production', { ...auto, policies: [row('restore.*', 'alone')], now: NOW }).tier).toBe('forbidden');
    // Any context that is not exactly console is refused.
    expect(resolveTier('restore.production', { context: 'deploy' as TierContext['context'], tainted: false }).tier).toBe('forbidden');
  });

  it('the scratch restore drill keeps its own entry: promoting it never reaches production', () => {
    expect(resolveTier('restore.drill', { ...auto, policies: [row('restore.*', 'alone')], now: NOW }).tier).toBe('alone');
    expect(resolveTier('restore.production', { ...consoleCtx, policies: [row('restore.*', 'alone')], now: NOW }).tier).toBe('approval');
    expect(forbiddenReason('restore.production', {})).toBeUndefined();
  });
});

describe('P7: removing old backups', () => {
  it('ships at APPROVAL, with a daily cap, and may run on its own only as a nightly job', () => {
    expect(CODE_TABLE['backup.prune']).toMatchObject({ tier: 'approval', promotable: true, write: true, byName: true, cap: { limit: 1, period: 'day' } });
    expect(AUTONOMOUS_ACTIONS.has('backup.prune')).toBe(true);
    expect(resolveTier('backup.prune', auto)).toMatchObject({ tier: 'approval', rule: 'code', cap: { limit: 1, period: 'day' } });
    // By hand it is Will at the keyboard: his own approval, unless a rule of his forbids it.
    expect(resolveTier('backup.prune', { context: 'console', tainted: false }).tier).toBe('approval');
    expect(resolveTier('backup.prune', { context: 'console', tainted: false, policies: [row('backup.prune', 'forbidden')], now: NOW }).tier).toBe('forbidden');
  });

  it('is never asked for from chat: forbidden there, whatever a rule says, so no look-alike card can be filed', () => {
    expect(NEVER_FROM_CHAT.has('backup.prune')).toBe(true);
    expect(resolveTier('backup.prune', chat)).toMatchObject({ tier: 'forbidden', rule: 'forbidden', reason: 'backup.prune is never asked for from chat' });
    expect(resolveTier('backup.prune', { ...chat, tainted: true }).tier).toBe('forbidden');
    expect(resolveTier('backup.prune', { ...chat, policies: [row('backup.prune', 'alone')], now: NOW }).tier).toBe('forbidden');
    // Its neighbours are as they were: a backup asked for in chat waits for approval.
    for (const a of ['backup.local', 'backup.offsite', 'restore.drill', 'maintenance.retention']) expect(NEVER_FROM_CHAT.has(a), a).toBe(false);
    expect(resolveTier('backup.local', chat).tier).toBe('approval');
    // A tool some server calls by the same name is that server's tool, under the rules for tools.
    expect(resolveTier('backup.prune', { ...chat, mcp: { server: 'other', tool: 'backup.prune' } }).rule).not.toBe('forbidden');
  });

  it('a row signed for the backups as a group does not promote it: only one that names it does', () => {
    // The promotion Will signed before this action existed, were it written with a star.
    expect(resolveTier('backup.prune', { ...auto, policies: [row('backup.*', 'alone')], now: NOW })).toMatchObject({ tier: 'approval', rule: 'code' });
    // Its neighbours are promoted by the same row, as before.
    expect(resolveTier('backup.local', { ...auto, policies: [row('backup.*', 'alone')], now: NOW }).tier).toBe('alone');
    expect(resolveTier('backup.offsite', { ...auto, policies: [row('backup.*', 'alone')], now: NOW }).tier).toBe('alone');
    // Named, it is promoted, and keeps its cap (the lower of the row's and its own).
    expect(resolveTier('backup.prune', { ...auto, policies: [row('backup.prune', 'alone')], now: NOW })).toMatchObject({ tier: 'alone', rule: 'policy', policyPattern: 'backup.prune', cap: { limit: 1, period: 'day' } });
    expect(resolveTier('backup.prune', { ...auto, policies: [row('backup.*', 'alone'), row('backup.prune', 'alone')], now: NOW })).toMatchObject({ tier: 'alone', policyPattern: 'backup.prune' });
  });

  it('any row still tightens it, a star included', () => {
    expect(resolveTier('backup.prune', { ...auto, policies: [row('backup.*', 'forbidden')], now: NOW })).toMatchObject({ tier: 'forbidden', rule: 'policy' });
    expect(resolveTier('backup.prune', { ...auto, policies: [row('backup.prune', 'alone'), row('backup.*', 'forbidden')], now: NOW }).tier).toBe('forbidden');
  });
});

describe('P7: Nexus’s own backup', () => {
  const THREE = ['backup.nexus', 'backup.nexus.offsite', 'restore.drill.nexus'] as const;

  it('its three actions ship at APPROVAL, each under its own cap, and may run on their own only as nightly jobs', () => {
    expect(CODE_TABLE['backup.nexus']).toMatchObject({ tier: 'approval', promotable: true, write: true, byName: true, cap: { limit: 1, period: 'day' } });
    expect(CODE_TABLE['backup.nexus.offsite']).toMatchObject({ tier: 'approval', promotable: true, byName: true, egress: true, cap: { limit: 1, period: 'day' } });
    expect(CODE_TABLE['restore.drill.nexus']).toMatchObject({ tier: 'approval', promotable: true, byName: true, cap: { limit: 1, period: 'week' } });
    for (const a of THREE) {
      expect(AUTONOMOUS_ACTIONS.has(a), a).toBe(true);
      expect(resolveTier(a, auto), a).toMatchObject({ tier: 'approval', rule: 'code' });
      // By hand it is Will at the keyboard: his own approval, unless a rule of his forbids it.
      expect(resolveTier(a, { context: 'console', tainted: false }).tier, a).toBe('approval');
    }
    // The copy offsite is egress, like Flint's own.
    expect(CODE_TABLE['backup.nexus']!.egress ?? false).toBe(false);
    expect(CODE_TABLE['backup.offsite']!.egress).toBe(true);
  });

  it('a rule signed for the backups as a group, before these existed, does not promote them: only one that names each does', () => {
    const groups = [row('backup.*', 'alone'), row('restore.*', 'alone'), row('restore.drill.*', 'alone'), row('backup.nexus.*', 'alone')];
    for (const a of THREE) expect(resolveTier(a, { ...auto, policies: groups, now: NOW }), a).toMatchObject({ tier: 'approval', rule: 'code' });
    // Flint's own are promoted by the same rows, as before.
    expect(resolveTier('backup.local', { ...auto, policies: groups, now: NOW }).tier).toBe('alone');
    expect(resolveTier('restore.drill', { ...auto, policies: groups, now: NOW }).tier).toBe('alone');
    // Nor does a row that names one of Flint's own cover the Nexus action whose name begins the same way.
    expect(resolveTier('restore.drill.nexus', { ...auto, policies: [row('restore.drill', 'alone')], now: NOW }).tier).toBe('approval');
    expect(resolveTier('backup.nexus.offsite', { ...auto, policies: [row('backup.offsite', 'alone'), row('backup.nexus', 'alone')], now: NOW }).tier).toBe('approval');
    for (const a of THREE) {
      expect(resolveTier(a, { ...auto, policies: [...groups, row(a, 'alone')], now: NOW }), a).toMatchObject({ tier: 'alone', rule: 'policy', policyPattern: a, cap: { limit: 1, period: a === 'restore.drill.nexus' ? 'week' : 'day' } });
      // Any row still tightens it, a group's included.
      expect(resolveTier(a, { ...auto, policies: [row(a, 'alone'), row(a.startsWith('backup') ? 'backup.*' : 'restore.*', 'forbidden')], now: NOW }).tier, a).toBe('forbidden');
    }
  });

  it('none of the three can be asked for from chat, whatever a rule says', () => {
    for (const a of THREE) {
      expect(NEVER_FROM_CHAT.has(a), a).toBe(true);
      expect(resolveTier(a, chat), a).toMatchObject({ tier: 'forbidden', rule: 'forbidden', reason: `${a} is never asked for from chat` });
      expect(resolveTier(a, { ...chat, policies: [row(a, 'alone')], now: NOW }).tier, a).toBe('forbidden');
    }
    // Flint's own three are as they were.
    for (const a of ['backup.local', 'backup.offsite', 'restore.drill']) expect(resolveTier(a, chat).tier, a).toBe('approval');
  });

  it('each job has a name of its own for a note, and a failure’s note says which backup it was', () => {
    expect([JOB_WORDS['backup.nexus'], JOB_WORDS['backup.nexus.offsite'], JOB_WORDS['restore.drill.nexus']]).toEqual(['Nexus Backup', 'Nexus Offsite Backup', 'Nexus Restore Test']);
    expect([...WEEKLY_JOBS].sort()).toEqual(['restore.drill', 'restore.drill.nexus']);
    expect(jobFailedNote('backup.nexus', { next: 'retry' })).toEqual({ title: 'Nexus Backup Failed', body: 'Last night’s Nexus backup didn’t finish. Flint tries again tonight.' });
    expect(jobFailedNote('backup.nexus', { next: 'setup' })).toEqual({ title: 'Nexus Backup Failed', body: 'Last night’s Nexus backup didn’t finish. It won’t work until its setup is fixed.' });
    expect(jobFailedNote('backup.nexus.offsite', { next: 'card', icloud: true })).toEqual({ title: 'Nexus Offsite Backup Failed', body: 'Last night’s encrypted copy of the Nexus backup to iCloud didn’t finish. It runs again once you approve its next card in Approvals.' });
    expect(jobFailedNote('backup.nexus.offsite', { next: 'retry', icloud: false }).body).toBe('Last night’s encrypted offsite copy of the Nexus backup didn’t finish. Flint tries again tonight.');
    // The weekly test: its next run, and its next card, are a week away.
    expect(jobFailedNote('restore.drill.nexus', { next: 'retry', mismatch: true })).toEqual({ title: 'Nexus Restore Test Failed', body: 'This week’s practice restore of Nexus found a problem. Flint tries again next Sunday.' });
    expect(jobFailedNote('restore.drill.nexus', { next: 'card_later' }).body).toBe('This week’s practice restore of Nexus didn’t finish. Its next card will be in Approvals next Sunday.');
    // Flint's own notes are word for word what they were.
    expect(jobFailedNote('backup.local', { next: 'retry' }).body).toBe('Last night’s database backup didn’t finish. Flint tries again tonight.');
    expect(jobFailedNote('restore.drill', { next: 'retry', mismatch: true }).body).toBe('This week’s practice restore found a problem. Flint tries again next Sunday.');
    for (const job of THREE) {
      for (const next of ['retry', 'card', 'card_later', 'setup', 'stopped'] as const) {
        for (const icloud of [true, false]) {
          for (const mismatch of [true, false]) {
            const note = jobFailedNote(job, { next, icloud, mismatch });
            expect(noteProblems(note.title, note.body), `${note.title} / ${note.body}`).toEqual([]);
            expect(note.title.length).toBeLessThanOrEqual(40);
          }
        }
      }
    }
  });

  it('Settings > Health names it Nexus Backup, among the backups', () => {
    expect(HEALTH_NAMES.nexus_backup).toBe('Nexus Backup');
    expect(healthGroup('nexus_backup')).toBe('BACKUPS');
    expect(HEALTH_GROUPS.find((g) => g.header === 'BACKUPS')!.components).toEqual(['backup', 'files_backup', 'nexus_backup', 'offsite_backup', 'restore_drill', 'offsite_drill', 'rebuild_rehearsal']);
    expect(ruleWords('backup.nexus')).toBe('Nexus Backup');
    expect(ruleWords('restore.drill.nexus')).toBe('Nexus Restore Test');
  });
});

describe('P7: a line of the files archive’s record', () => {
  const id = 'a'.repeat(32);
  const at = '2026-10-13T07:30:12Z';
  const ok = { id, at, kind: 'flint_tar', location: 'local', outcome: 'ok', name: 'flint-20261013-0230.tar.gz', bytes: 127_000_000, sha256: 'c'.repeat(64) };

  it('an archive written here or offsite, by its own name, size and fingerprint', () => {
    expect(BackupEvent.safeParse(ok).success).toBe(true);
    expect(BackupEvent.safeParse({ ...ok, location: 'icloud', name: 'flint-20261013-0230.tar.gz.age' }).success).toBe(true);
    // Offsite is the encrypted archive and only that; the plain one is never an offsite line.
    expect(BackupEvent.safeParse({ ...ok, location: 'icloud' }).success).toBe(false);
    expect(BackupEvent.safeParse({ ...ok, name: 'flint-20261013-0230.tar.gz.age' }).success).toBe(false);
  });

  it('one that was not written says why, from a fixed list', () => {
    const failed = { id, at, kind: 'flint_tar', location: 'local', outcome: 'failed', name: 'flint-20261013-0230.tar.gz', reason: 'space' };
    expect(BackupEvent.safeParse(failed).success).toBe(true);
    for (const reason of BACKUP_EVENT_REASONS) expect(BackupEvent.safeParse({ ...failed, reason }).success, reason).toBe(true);
    expect(BackupEvent.safeParse({ ...failed, reason: 'tar: write error' }).success).toBe(false);
    expect(BackupEvent.safeParse({ ...failed, reason: undefined }).success).toBe(false);
    expect(BackupEvent.safeParse({ ...ok, reason: 'space' }).success).toBe(false);
  });

  it('never a path, a name of another kind, or anything extra', () => {
    for (const name of ['../flint-20261013-0230.tar.gz', '/Users/x/FlintBackups/flint-20261013-0230.tar.gz', 'flint-20261013-0230.tar.gz.partial', 'flint-2026-10-13.dump', 'secrets.env', '']) {
      expect(BackupEvent.safeParse({ ...ok, name }).success, name).toBe(false);
    }
    expect(BackupEvent.safeParse({ ...ok, path: '/tmp/x' }).success).toBe(false);
    expect(BackupEvent.safeParse({ ...ok, kind: 'pg_dump_flint' }).success).toBe(false);
    expect(BackupEvent.safeParse({ ...ok, sha256: 'abc' }).success).toBe(false);
    expect(BackupEvent.safeParse({ ...ok, bytes: -1 }).success).toBe(false);
    expect(BackupEvent.safeParse({ ...ok, id: 'not-an-id' }).success).toBe(false);
  });
});

describe('P7: a nightly job that stopped before it could tell what it may do', () => {
  it('says so and points at Health: it promises nothing about its next run', () => {
    expect(jobFailedNote('backup.local', { next: 'stopped' })).toEqual({ title: 'Backup Failed', body: 'Last night’s database backup didn’t finish. Flint couldn’t reach its database. Check Health in Settings.' });
    for (const job of ['backup.local', 'backup.offsite', 'restore.drill'] as const) {
      const note = jobFailedNote(job, { next: 'stopped', icloud: true });
      expect(noteProblems(note.title, note.body), job).toEqual([]);
      expect(note.body).not.toMatch(/tries again|next card/);
    }
  });
});

