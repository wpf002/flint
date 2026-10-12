/**
 * P7: replacing the production database with a backup (`restore.production`)
 * is Will's alone. APPROVAL in code for him at the keyboard, never promotable,
 * forbidden from chat, and not an autonomous action: Flint on its own is refused it whatever a
 * policy row says. The scratch restore drill keeps its own, promotable entry.
 */
import { describe, it, expect } from 'vitest';
import { resolveTier, forbiddenReason, CODE_TABLE, AUTONOMOUS_ACTIONS, CONSOLE_ONLY, type PolicyRow, type TierContext } from '../src/tiers';
import { BACKUP_EVENT_REASONS, BackupEvent } from '../src/wire';
import { jobFailedNote } from '../src/action-words';
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
    expect(resolveTier('backup.prune', chat).tier).toBe('approval');
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

