import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadBackupConfig, loadConfig, loadRuntimeConfig, offsiteFolder, parseTokens } from '../src/config';

const DB = 'postgresql://flint_app:x@[::1]:5432/flint';
const HOME = '/Users/test';
const H = 'a'.repeat(64);

describe('runtime config', () => {
  it('defaults to IPv6 loopback on 8090', () => {
    expect(loadConfig({ DATABASE_URL: DB, HOME })).toMatchObject({ host: '::1', port: 8090, tokens: [] });
  });

  it('refuses a non-loopback host and a non-postgres URL', () => {
    expect(() => loadConfig({ DATABASE_URL: DB, RUNTIME_HOST: '0.0.0.0' })).toThrow(/RUNTIME_HOST/);
    expect(() => loadConfig({ DATABASE_URL: 'mysql://a@localhost/flint' })).toThrow(/DATABASE_URL/);
  });

  it('never echoes a value in its error', () => {
    for (const env of [{ DATABASE_URL: 'not a url with hunter2' }, { DATABASE_URL: DB, RUNTIME_TOKENS: 'server:hunter2hunter2:audit' }]) {
      try {
        loadConfig(env);
        throw new Error('should have thrown');
      } catch (e) {
        expect(String(e)).not.toMatch(/hunter2/);
        expect(String(e)).toMatch(/invalid/);
      }
    }
  });

  it('parses token grants with their scopes, and refuses unknown scopes and repeats', () => {
    const [g] = parseTokens(`server:${H}:audit|proposals|world:read`);
    expect(g!.name).toBe('server');
    expect([...g!.scopes]).toEqual(['audit', 'proposals', 'world:read']);
    expect(() => parseTokens(`server:${H}:root`)).toThrow(/unknown scope/);
    expect(() => parseTokens(`a:${H}:audit,a:${H}:ledger`)).toThrow(/twice/);
    expect(() => parseTokens('server:short:audit')).toThrow(/malformed/);
  });

  it("Flint Calendar's scope (P2.6) parses on its own, and the Apple Calendar source is on only for `on`", () => {
    const [g] = parseTokens(`apple-calendar:${H}:calendar:push`);
    expect(g!.name).toBe('apple-calendar');
    expect([...g!.scopes]).toEqual(['calendar:push']);
    expect(() => parseTokens(`apple-calendar:${H}:calendar:pull`)).toThrow(/unknown scope/);
    for (const v of [undefined, '', 'off', '1', 'yes', 'true']) expect(loadConfig({ DATABASE_URL: DB, HOME, FLINT_SOURCE_APPLE_CALENDAR: v }).appleCalendar, String(v)).toBe(false);
    expect(loadConfig({ DATABASE_URL: DB, HOME, FLINT_SOURCE_APPLE_CALENDAR: ' On ' }).appleCalendar).toBe(true);
  });

  it('goal reviews (P3) are off unless FLINT_PLANNER is exactly `on`, trimmed and in any case', () => {
    for (const v of [undefined, '', '  ', 'off', ' Off ', '1', 'yes', 'true', 'enabled', 'on!']) expect(loadConfig({ DATABASE_URL: DB, HOME, FLINT_PLANNER: v }).planner, String(v)).toBe(false);
    for (const v of ['on', ' on ', 'ON', ' On\t']) expect(loadConfig({ DATABASE_URL: DB, HOME, FLINT_PLANNER: v }).planner, v).toBe(true);
    // Its own switch: triage on does not turn reviews on, nor the other way round.
    expect(loadConfig({ DATABASE_URL: DB, HOME, FLINT_RUNTIME_TRIAGE: 'on' })).toMatchObject({ triage: true, planner: false });
    expect(loadConfig({ DATABASE_URL: DB, HOME, FLINT_PLANNER: 'on' })).toMatchObject({ triage: false, planner: true });
  });

  it('reads caps and off-box health URLs, and refuses credentials in them', () => {
    const c = loadConfig({ DATABASE_URL: DB, HOME, FLINT_BUDGET_ANTHROPIC_DAILY_USD: '10', FLINT_BUDGET_ANTHROPIC_MONTHLY_USD: '150', HEALTH_EXTRA: 'nexus-mcp=https://nexus.example.app/health' });
    expect(c.caps.anthropic).toEqual({ dailyUsd: 10, monthlyUsd: 150 });
    expect(c.caps.openai).toEqual({});
    expect(c.healthExtra).toEqual([{ name: 'nexus-mcp', url: 'https://nexus.example.app/health' }]);
    expect(() => loadConfig({ DATABASE_URL: DB, HOME, HEALTH_EXTRA: 'x=https://u:p@h.example/health' })).toThrow(/credentials/);
    expect(() => loadConfig({ DATABASE_URL: DB, HOME, HEALTH_EXTRA: 'x=http://h.example/health' })).toThrow(/https/);
  });

  it('passkey origins must be https', () => {
    expect(() => loadConfig({ DATABASE_URL: DB, HOME, FLINT_RP_ID: 'flint.example.ts.net', FLINT_RP_ORIGINS: 'http://flint.example.ts.net' })).toThrow(/https/);
    expect(loadConfig({ DATABASE_URL: DB, HOME, FLINT_RP_ID: 'flint.example.ts.net', FLINT_RP_ORIGINS: 'https://flint.example.ts.net' }).rp).toEqual({ rpId: 'flint.example.ts.net', origins: ['https://flint.example.ts.net'] });
  });

  it('triage is off unless set to on; blank values mean the defaults', () => {
    expect(loadConfig({ DATABASE_URL: DB, HOME }).triage).toBe(false);
    expect(loadConfig({ DATABASE_URL: DB, HOME, FLINT_RUNTIME_TRIAGE: '' }).triage).toBe(false);
    expect(loadConfig({ DATABASE_URL: DB, HOME, FLINT_RUNTIME_TRIAGE: 'yes' }).triage).toBe(false);
    expect(loadConfig({ DATABASE_URL: DB, HOME, FLINT_RUNTIME_TRIAGE: ' On ' }).triage).toBe(true);
    expect(loadConfig({ DATABASE_URL: DB, HOME, FLINT_TZ: '', FLINT_USER_TZ: '' }).tz).toBe('America/Chicago');
    expect(() => loadConfig({ DATABASE_URL: DB, HOME, FLINT_TZ: 'Not/AZone' })).toThrow(/time zone/);
    expect(loadConfig({ DATABASE_URL: DB, HOME, FLINT_TZ: 'Europe/Berlin' }).tz).toBe('Europe/Berlin');
  });

  it('the triage model is on loopback only, and absent without a model', () => {
    expect(loadConfig({ DATABASE_URL: DB, HOME }).ollama).toBeUndefined();
    expect(loadConfig({ DATABASE_URL: DB, HOME, FLINT_TRIAGE_MODEL: 'muse-glimmer:30b' }).ollama).toEqual({ url: 'http://127.0.0.1:11434', model: 'muse-glimmer:30b' });
    expect(loadConfig({ DATABASE_URL: DB, HOME, FLINT_TRIAGE_MODEL: 'm', OLLAMA_URL: 'http://[::1]:11434' }).ollama?.url).toBe('http://[::1]:11434');
    for (const bad of ['http://10.0.0.5:11434', 'https://ollama.example.com', 'http://127.0.0.1.evil.example:11434', 'http://localhost:11434/api']) {
      expect(() => loadConfig({ DATABASE_URL: DB, HOME, FLINT_TRIAGE_MODEL: 'm', OLLAMA_URL: bad })).toThrow(/OLLAMA_URL/);
    }
    expect(() => loadConfig({ DATABASE_URL: DB, HOME, FLINT_TRIAGE_MODEL: 'a model; rm -rf' })).toThrow(/FLINT_TRIAGE_MODEL/);
  });

  it('the git sha is a full sha or dev', () => {
    expect(loadConfig({ DATABASE_URL: DB, HOME, RUNTIME_GIT_SHA: 'f'.repeat(40) }).gitSha).toBe('f'.repeat(40));
    expect(loadConfig({ DATABASE_URL: DB, HOME, RUNTIME_GIT_SHA: 'nope' }).gitSha).toBe('dev');
  });

  describe('where the database’s encrypted offsite copy goes', () => {
    const DRIVE = ['Library', 'Mobile Documents', 'com~apple~CloudDocs'];
    const mac = (icloud: boolean) => {
      const h = mkdtempSync(join(tmpdir(), 'rt-offsite-'));
      if (icloud) mkdirSync(join(h, ...DRIVE), { recursive: true });
      return h;
    };

    it('iCloud Drive’s FlintBackups/pg when nothing is set and iCloud Drive is on this Mac', () => {
      const h = mac(true);
      expect(offsiteFolder(h, undefined)).toEqual({ dir: join(h, ...DRIVE, 'FlintBackups', 'pg'), icloud: true });
      // A blank setting is no setting.
      expect(offsiteFolder(h, '  ')).toEqual({ dir: join(h, ...DRIVE, 'FlintBackups', 'pg'), icloud: true });
    });

    it('FLINT_OFFSITE_DIR still wins, and is called iCloud only when it is inside iCloud Drive', () => {
      const h = mac(true);
      expect(offsiteFolder(h, '/Volumes/Vault/flint')).toEqual({ dir: '/Volumes/Vault/flint', icloud: false });
      expect(offsiteFolder(h, join(h, ...DRIVE, 'Elsewhere'))).toEqual({ dir: join(h, ...DRIVE, 'Elsewhere'), icloud: true });
      expect(offsiteFolder(mac(false), '/Volumes/Vault/flint')).toEqual({ dir: '/Volumes/Vault/flint', icloud: false });
      // A path that only passes through iCloud Drive's name is not in it.
      expect(offsiteFolder(h, `${join(h, ...DRIVE)}-old/x`).icloud).toBe(false);
      expect(offsiteFolder(h, `${join(h, ...DRIVE)}/../../Elsewhere`)).toEqual({ dir: join(h, 'Library', 'Elsewhere'), icloud: false });
    });

    it('a setting under Will’s home may be written ~/…; one that is not a whole path is refused, never guessed at', () => {
      const h = mac(true);
      expect(offsiteFolder(h, '~/Vault/flint')).toEqual({ dir: join(h, 'Vault', 'flint'), icloud: false });
      expect(offsiteFolder(h, '~')).toEqual({ dir: h, icloud: false });
      expect(offsiteFolder(h, '~/Library/Mobile Documents/com~apple~CloudDocs/Elsewhere')).toEqual({ dir: join(h, ...DRIVE, 'Elsewhere'), icloud: true });
      for (const relative of ['Vault/flint', './flint', '../flint', '~will/flint', 'C:\\flint']) {
        const r = offsiteFolder(h, relative);
        // No folder at all, not iCloud's by default: Will set one, and it is wrong.
        expect(r.dir, relative).toBeUndefined();
        expect(r.icloud, relative).toBe(false);
        expect(r.problem, relative).toMatch(/FLINT_OFFSITE_DIR is not an absolute path/);
      }
    });

    it('nowhere without iCloud Drive: no folder is made up, and a file by that name is not a folder', () => {
      expect(offsiteFolder(mac(false), undefined)).toEqual({ icloud: false });
      const h = mac(false);
      mkdirSync(join(h, 'Library', 'Mobile Documents'), { recursive: true });
      writeFileSync(join(h, ...DRIVE), '');
      expect(offsiteFolder(h, undefined)).toEqual({ icloud: false });
    });

    describe('loadBackupConfig', () => {
      const saved = { ...process.env };
      afterEach(() => {
        for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
        Object.assign(process.env, saved);
      });
      const home = (icloud: boolean) => {
        const h = mac(icloud);
        mkdirSync(join(h, '.flint'), { mode: 0o700 });
        writeFileSync(join(h, '.flint', 'runtime.env'), `DATABASE_URL=${DB}\n`, { mode: 0o600 });
        writeFileSync(join(h, '.flint', 'backup.env'), 'FLINT_DB_BACKUP_URL=postgresql://flint_backup:x@[::1]:5432/flint\nFLINT_DB_RESTORE_URL=postgresql://flint_restore:x@[::1]:5432/postgres\n', { mode: 0o600 });
        process.env.HOME = h;
        for (const k of ['RUNTIME_ENV_FILE', 'BACKUP_ENV_FILE', 'DATABASE_URL', 'FLINT_OFFSITE_DIR', 'FLINT_DB_BACKUP_URL', 'FLINT_DB_RESTORE_URL', 'FLINT_BACKUP_AGE_RECIPIENT']) delete process.env[k];
        return h;
      };
      // pg_dump and pg_restore are looked up where Homebrew puts them; without them there is no backup config to read.
      const tools = ['/opt/homebrew/opt/postgresql@17/bin', '/opt/homebrew/bin', '/usr/local/bin'].some((d) => existsSync(join(d, 'pg_dump')) && existsSync(join(d, 'pg_restore')));

      it.skipIf(!tools)('with FLINT_OFFSITE_DIR unset, the offsite job has a folder (what failed five nights running): iCloud Drive’s, and a manifest beside the dumps', () => {
        const h = home(true);
        const b = loadBackupConfig();
        expect(b.offsiteDir).toBe(join(h, ...DRIVE, 'FlintBackups', 'pg'));
        expect(b.offsiteICloud).toBe(true);
        expect(b.offsiteManifest).toBe(join(h, 'FlintBackups', 'pg', 'offsite-copies.txt'));
        // Reading the config makes no folder: the job does, when it writes its first encrypted copy.
        expect(existsSync(b.offsiteDir!)).toBe(false);
      });

      it.skipIf(!tools)('the setting wins, from backup.env or the environment; with neither and no iCloud Drive there is no folder', () => {
        const h = home(true);
        writeFileSync(join(h, '.flint', 'backup.env'), 'FLINT_DB_BACKUP_URL=postgresql://flint_backup:x@[::1]:5432/flint\nFLINT_DB_RESTORE_URL=postgresql://flint_restore:x@[::1]:5432/postgres\nFLINT_OFFSITE_DIR=/Volumes/Vault/flint\n', { mode: 0o600 });
        expect(loadBackupConfig()).toMatchObject({ offsiteDir: '/Volumes/Vault/flint', offsiteICloud: false });
        process.env.FLINT_OFFSITE_DIR = '/Volumes/Other';
        expect(loadBackupConfig().offsiteDir).toBe('/Volumes/Other');
        // A setting that is not a whole path: no folder, and why, for the job to say its setup needs fixing.
        process.env.FLINT_OFFSITE_DIR = 'Vault/flint';
        const wrong = loadBackupConfig();
        expect(wrong.offsiteDir).toBeUndefined();
        expect(wrong.offsiteProblem).toMatch(/not an absolute path/);
        delete process.env.FLINT_OFFSITE_DIR;
        home(false);
        const none = loadBackupConfig();
        expect(none.offsiteDir).toBeUndefined();
        expect(none.offsiteProblem).toBeUndefined();
        expect(none.offsiteICloud).toBe(false);
      });
    });
  });

  describe('runtime.env, then runtime.override.env, then the process environment', () => {
    const saved = { ...process.env };
    afterEach(() => {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    });
    const home = () => {
      const h = mkdtempSync(join(tmpdir(), 'rt-config-'));
      mkdirSync(join(h, '.flint'), { mode: 0o700 });
      writeFileSync(join(h, '.flint', 'runtime.env'), `DATABASE_URL=${DB}\nFLINT_RUNTIME_TRIAGE=off\nFLINT_TZ=America/Denver\n`, { mode: 0o600 });
      process.env.HOME = h;
      delete process.env.RUNTIME_ENV_FILE;
      delete process.env.DATABASE_URL;
      delete process.env.FLINT_RUNTIME_TRIAGE;
      delete process.env.FLINT_TZ;
      return h;
    };

    it('the override survives a redeploy and wins over runtime.env', () => {
      const h = home();
      expect(loadRuntimeConfig().triage).toBe(false);
      writeFileSync(join(h, '.flint', 'runtime.override.env'), 'FLINT_RUNTIME_TRIAGE=on\n', { mode: 0o600 });
      const c = loadRuntimeConfig();
      expect(c.triage).toBe(true);
      expect(c.tz).toBe('America/Denver');
      process.env.FLINT_RUNTIME_TRIAGE = 'off';
      expect(loadRuntimeConfig().triage).toBe(false);
    });

    it('an override others can read is refused', () => {
      const h = home();
      const f = join(h, '.flint', 'runtime.override.env');
      writeFileSync(f, 'FLINT_RUNTIME_TRIAGE=on\n');
      chmodSync(f, 0o644);
      expect(() => loadRuntimeConfig()).toThrow(/chmod 600/);
    });
  });
});
