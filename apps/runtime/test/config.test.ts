import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadBackupConfig, loadConfig, loadRuntimeConfig, nexusBackupState, nexusBackupWanted, nexusUrlProblem, offsiteFolder, parseTokens, parseHealthExtra, runtimeEnv } from '../src/config';

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

  it('tasks and assets (P5) are off unless FLINT_ASSETS is exactly `on`, trimmed and in any case', () => {
    for (const v of [undefined, '', '  ', 'off', '1', 'yes', 'true', 'enabled', 'on!']) expect(loadConfig({ DATABASE_URL: DB, HOME, FLINT_ASSETS: v }).assets, String(v)).toBe(false);
    for (const v of ['on', ' on ', 'ON', ' On\t']) expect(loadConfig({ DATABASE_URL: DB, HOME, FLINT_ASSETS: v }).assets, v).toBe(true);
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

  it('a health check is never named spend or calendar: its latency series would be read as dollars or the calendar, and refused (P4)', () => {
    // `health.spend.latency_ms` as ops data: the database takes a `spend` segment for dollars (financial) and a
    // `calendar` segment for the calendar (never ops), and would refuse the series, and the health source's run with it.
    for (const name of ['spend', 'calendar']) {
      const load = () => loadConfig({ DATABASE_URL: DB, HOME, HEALTH_EXTRA: `nexus-mcp=https://nexus.example.app/health,${name}=https://h.example/health` });
      expect(load, name).toThrow(`runtime config is invalid: HEALTH_EXTRA entry 2 can't be named ${name}: that name is kept for Flint's spend and calendar numbers (try ${name}-api)`);
      expect(() => parseHealthExtra(`${name}=https://h.example/health`), name).toThrow(/entry 1 can't be named/);
    }
    // The error names the entry and the name, never the URL (it could hold a path that is private).
    expect(() => parseHealthExtra('spend=https://h.example/private-path')).not.toThrow(/private-path|h\.example/);
    // Only the bare names: a longer name is its own segment, and fine.
    expect(parseHealthExtra('spend-api=https://h.example/health,calendar_sync=https://h.example/health,my-spend=https://h.example/health').map((h) => h.name)).toEqual(['spend-api', 'calendar_sync', 'my-spend']);
  });

  it('passkey origins must be https', () => {
    expect(() => loadConfig({ DATABASE_URL: DB, HOME, FLINT_RP_ID: 'flint.example.ts.net', FLINT_RP_ORIGINS: 'http://flint.example.ts.net' })).toThrow(/https/);
    expect(loadConfig({ DATABASE_URL: DB, HOME, FLINT_RP_ID: 'flint.example.ts.net', FLINT_RP_ORIGINS: 'https://flint.example.ts.net' }).rp).toEqual({ rpId: 'flint.example.ts.net', origins: ['https://flint.example.ts.net'] });
  });

  it('predictions (P4) are off unless FLINT_PREDICT is exactly on (trimmed, any case): unset, blank and every other word are off', () => {
    expect(loadConfig({ DATABASE_URL: DB, HOME }).predict).toBe(false);
    for (const v of ['', ' ', 'off', 'OFF', '1', 'yes', 'true', 'enabled', 'on!', 'o n', 'armed']) expect(loadConfig({ DATABASE_URL: DB, HOME, FLINT_PREDICT: v }).predict, JSON.stringify(v)).toBe(false);
    for (const v of ['on', 'ON', ' On ', 'on\n']) expect(loadConfig({ DATABASE_URL: DB, HOME, FLINT_PREDICT: v }).predict, JSON.stringify(v)).toBe(true);
    // It is its own switch: triage being on says nothing about predictions.
    expect(loadConfig({ DATABASE_URL: DB, HOME, FLINT_RUNTIME_TRIAGE: 'on' }).predict).toBe(false);
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

  it('a port no machine has is refused in a sentence that names the setting, not left to fail as a URL later', () => {
    const base = { DATABASE_URL: DB, HOME, FLINT_TRIAGE_MODEL: 'm' };
    for (const bad of ['http://127.0.0.1:65536', 'http://127.0.0.1:99999', 'http://localhost:0', 'http://[::1]:70000', 'http://127.0.0.1:123456']) {
      let said = '';
      try {
        loadConfig({ ...base, OLLAMA_URL: bad });
      } catch (e) {
        said = (e as Error).message;
      }
      expect(said, bad).toMatch(/OLLAMA_URL/);
      expect(said, bad).not.toMatch(/Invalid URL/);
    }
    expect(() => loadConfig({ ...base, OLLAMA_URL: 'http://127.0.0.1:99999' })).toThrow(/OLLAMA_URL: the port must be 1 to 65535/);
    expect(loadConfig({ ...base, OLLAMA_URL: 'http://127.0.0.1:65535' }).ollama?.url).toBe('http://127.0.0.1:65535');
    expect(loadConfig({ ...base, OLLAMA_URL: 'http://127.0.0.1:1' }).ollama?.url).toBe('http://127.0.0.1:1');
    // The same setting names the fallback's server: the same sentence without a triage model.
    expect(() => loadConfig({ DATABASE_URL: DB, HOME, OLLAMA_URL: 'http://127.0.0.1:99999' })).toThrow(/OLLAMA_URL/);
  });

  it('the local model’s address: localhost is pinned to 127.0.0.1, and Node’s env proxy marks it as not this Mac', () => {
    const base = { DATABASE_URL: DB, HOME, FLINT_TRIAGE_MODEL: 'm' };
    expect(loadConfig({ ...base, OLLAMA_URL: 'http://localhost:11434' }, []).ollama).toEqual({ url: 'http://127.0.0.1:11434', model: 'm' });
    const quiet = console.error;
    const said: string[] = [];
    console.error = (m: string) => void said.push(m);
    try {
      const PROXY = { NODE_USE_ENV_PROXY: '1', HTTP_PROXY: 'http://proxy.example:3128' };
      // A proxy that is named but not switched on, or switched on with none named, carries nothing.
      expect(loadConfig({ ...base, HTTP_PROXY: PROXY.HTTP_PROXY }, []).ollama).toEqual({ url: 'http://127.0.0.1:11434', model: 'm' });
      expect(loadConfig({ ...base, NODE_USE_ENV_PROXY: '1' }, []).ollama?.proxied).toBeUndefined();
      expect(said).toEqual([]);
      // Switched on: a request to 127.0.0.1 would leave for the proxy first.
      expect(loadConfig({ ...base, ...PROXY }, []).ollama).toEqual({ url: 'http://127.0.0.1:11434', model: 'm', proxied: true });
      expect(loadConfig({ ...base, HTTPS_PROXY: 'http://p:1' }, ['--use-env-proxy']).ollama?.proxied).toBe(true);
      expect(loadConfig({ ...base, HTTP_PROXY: 'http://p:1', NODE_OPTIONS: '--use-env-proxy' }, []).ollama?.proxied).toBe(true);
      expect(loadConfig({ ...base, ...PROXY, OLLAMA_URL: 'http://[::1]:11434' }, []).ollama?.proxied).toBe(true);
      expect(said).toHaveLength(4);
      // The message names no value: not the proxy, not the address.
      expect(said.join(' ')).not.toMatch(/proxy\.example|3128|11434/);
      // NO_PROXY naming the host exactly keeps it on this Mac; an entry Node would have to interpret does not.
      expect(loadConfig({ ...base, ...PROXY, NO_PROXY: 'localhost,127.0.0.1,[::1]' }, []).ollama?.proxied).toBeUndefined();
      expect(loadConfig({ ...base, ...PROXY, NO_PROXY: 'localhost' }, []).ollama?.proxied).toBe(true);
      expect(loadConfig({ ...base, ...PROXY, NO_PROXY: '127.0.0.0/8' }, []).ollama?.proxied).toBe(true);
      // An IPv6 address needs its brackets: Node sends [::1] to the proxy when the list says ::1 (measured on Node 24).
      const V6 = { ...base, ...PROXY, OLLAMA_URL: 'http://[::1]:11434' };
      expect(loadConfig({ ...V6, NO_PROXY: '::1' }, []).ollama?.proxied).toBe(true);
      expect(loadConfig({ ...V6, NO_PROXY: '[::1]' }, []).ollama?.proxied).toBeUndefined();
      // (An entry with a port, or a suffix, is one Node would follow. The rule does not try to: it stays closed.)
      expect(loadConfig({ ...V6, NO_PROXY: '[::1]:11434' }, []).ollama?.proxied).toBe(true);
      expect(loadConfig({ ...base, ...PROXY, NO_PROXY: '127.0.0.1:11434' }, []).ollama?.proxied).toBe(true);
      // Node reads the lower-case name first, an empty one included: NO_PROXY is then not read at all.
      expect(loadConfig({ ...base, ...PROXY, no_proxy: 'elsewhere.example', NO_PROXY: '127.0.0.1' }, []).ollama?.proxied).toBe(true);
      expect(loadConfig({ ...base, ...PROXY, no_proxy: '', NO_PROXY: '127.0.0.1' }, []).ollama?.proxied).toBe(true);
      expect(loadConfig({ ...base, ...PROXY, no_proxy: '127.0.0.1', NO_PROXY: 'elsewhere.example' }, []).ollama?.proxied).toBeUndefined();
      // A star means "nothing is proxied" only as the whole value. In a list Node ignores it.
      expect(loadConfig({ ...base, ...PROXY, NO_PROXY: '*' }, []).ollama?.proxied).toBeUndefined();
      expect(loadConfig({ ...base, ...PROXY, NO_PROXY: '*,elsewhere.example' }, []).ollama?.proxied).toBe(true);
      expect(loadConfig({ ...base, ...PROXY, NO_PROXY: ' * ' }, []).ollama?.proxied).toBe(true);
      expect(loadConfig({ ...base, ...PROXY, NO_PROXY: '*,127.0.0.1' }, []).ollama?.proxied).toBeUndefined();
      // What it says to do names the brackets, and still no value.
      expect(said.at(-1)).toMatch(/NO_PROXY exactly, an IPv6 address with its brackets/);
      expect(said.join(' ')).not.toMatch(/proxy\.example|3128|11434|elsewhere/);
      // Without a local model there is nothing to mark.
      expect(loadConfig({ DATABASE_URL: DB, HOME, ...PROXY }, []).ollama).toBeUndefined();
    } finally {
      console.error = quiet;
    }
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
        for (const k of ['RUNTIME_ENV_FILE', 'BACKUP_ENV_FILE', 'DATABASE_URL', 'FLINT_OFFSITE_DIR', 'FLINT_DB_BACKUP_URL', 'FLINT_DB_RESTORE_URL', 'FLINT_BACKUP_AGE_RECIPIENT', 'FLINT_NEXUS_BACKUP_URL']) delete process.env[k];
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

      // ---- Nexus's own backup (P7): off until FLINT_NEXUS_BACKUP_URL is set, and then only a database on this Mac ----
      const FLINT_LINES = 'FLINT_DB_BACKUP_URL=postgresql://flint_backup:x@[::1]:5432/flint\nFLINT_DB_RESTORE_URL=postgresql://flint_restore:x@[::1]:5432/postgres\n';
      const withNexus = (h: string, value: string) => writeFileSync(join(h, '.flint', 'backup.env'), `${FLINT_LINES}FLINT_NEXUS_BACKUP_URL=${value}\n`, { mode: 0o600 });

      it.skipIf(!tools)('Nexus’s backup is off until its address is set: nothing of it is in the config at all', () => {
        const h = home(true);
        expect(loadBackupConfig().nexus).toBeUndefined();
        expect(nexusBackupWanted(h)).toBe(false);
        withNexus(h, '');
        expect(loadBackupConfig().nexus).toBeUndefined();
        withNexus(h, '   ');
        expect(loadBackupConfig().nexus).toBeUndefined();
      });

      it.skipIf(!tools)('set, its dumps and its encrypted copies go beside the database’s own, in folders of their own', () => {
        const h = home(true);
        withNexus(h, 'postgresql://flint_backup:x@[::1]:5432/nexus');
        const b = loadBackupConfig();
        expect(b.nexus).toEqual({
          backupUrl: 'postgresql://flint_backup:x@[::1]:5432/nexus',
          dumpDir: join(h, 'FlintBackups', 'nexus'),
          offsiteDir: join(h, ...DRIVE, 'FlintBackups', 'nexus'),
          offsiteManifest: join(h, 'FlintBackups', 'nexus', 'offsite-copies.txt'),
        });
        // Flint's own are as they were, and reading the config makes no folder.
        expect(b).toMatchObject({ dumpDir: join(h, 'FlintBackups', 'pg'), offsiteDir: join(h, ...DRIVE, 'FlintBackups', 'pg'), backupUrl: 'postgresql://flint_backup:x@[::1]:5432/flint' });
        expect(existsSync(b.nexus!.dumpDir) || existsSync(b.nexus!.offsiteDir!)).toBe(false);
        // A folder Will set for the offsite copies: Nexus's go in a folder of their own inside it.
        process.env.FLINT_OFFSITE_DIR = '/Volumes/Vault/flint';
        expect(loadBackupConfig().nexus!.offsiteDir).toBe('/Volumes/Vault/flint/nexus');
        delete process.env.FLINT_OFFSITE_DIR;
        // With nowhere to send a copy, there is none for Nexus either.
        const g = home(false);
        withNexus(g, 'postgresql://flint_backup:x@[::1]:5432/nexus');
        expect(loadBackupConfig().nexus!.offsiteDir).toBeUndefined();
        // The environment, when it says, wins over the file, as for every setting here.
        process.env.FLINT_NEXUS_BACKUP_URL = 'postgresql://flint_backup:x@127.0.0.1:5432/nexus_two';
        expect(loadBackupConfig().nexus!.backupUrl).toBe('postgresql://flint_backup:x@127.0.0.1:5432/nexus_two');
      });

      it.skipIf(!tools)('an address that is not a database on this Mac is refused with why, in words that hold nothing of it, and Flint’s own backup still loads', () => {
        const h = home(true);
        const secret = 's3cret-pw';
        const refused: Array<[string, string]> = [
          [`postgresql://flint_backup:${secret}@db.example.com:5432/nexus`, 'must be a database on this Mac'],
          [`postgresql://flint_backup:${secret}@10.0.0.5:5432/nexus`, 'must be a database on this Mac'],
          [`postgresql://flint_backup:${secret}@127.0.0.1.example.com:5432/nexus`, 'must be a database on this Mac'],
          [`postgresql://flint_backup:${secret}@[2001:db8::1]:5432/nexus`, 'must be a database on this Mac'],
          [`https://flint_backup:${secret}@[::1]:5432/nexus`, 'must be a postgres URL'],
          [`mysql://flint_backup:${secret}@localhost/nexus`, 'must be a postgres URL'],
          [`flint_backup:${secret}@localhost/nexus`, 'is not a URL'],
          [`not a url ${secret}`, 'is not a URL'],
          [`postgresql://:${secret}@[::1]:5432/nexus`, 'must name the login that reads Nexus'],
          [`postgresql://flint_backup:${secret}@[::1]:5432/`, 'must name the Nexus database'],
          [`postgresql://flint_backup:${secret}@[::1]:5432/postgres`, 'must name the Nexus database'],
          [`postgresql://flint_backup:${secret}@[::1]:5432/template1`, 'must name the Nexus database'],
          [`postgresql://flint_backup:${secret}@[::1]:5432/nexus_restore_test`, 'must name the Nexus database'],
          [`postgresql://flint_backup:${secret}@[::1]:5432/nexus%22%3B%20DROP`, 'must name the Nexus database'],
          // Flint's own database, by any of this Mac's names and with the port left out or spelled out.
          [`postgresql://flint_backup:${secret}@[::1]:5432/flint`, 'names Flint’s own database, which has its own backup'],
          [`postgresql://flint_backup:${secret}@localhost/flint`, 'names Flint’s own database, which has its own backup'],
        ];
        for (const [value, why] of refused) {
          withNexus(h, value);
          const b = loadBackupConfig();
          expect(b.nexus, value).toMatchObject({ problem: `FLINT_NEXUS_BACKUP_URL ${why}` });
          expect(b.nexus!.backupUrl, value).toBeUndefined();
          expect(JSON.stringify(b.nexus), value).not.toMatch(new RegExp(`${secret}|example|10\\.0|2001`));
          // Flint's own backup is read from the same file and is not stopped by it.
          expect(b.backupUrl).toBe('postgresql://flint_backup:x@[::1]:5432/flint');
          expect(nexusUrlProblem(value, b.backupUrl)).toBe(why);
        }
        // Every way of naming this Mac is taken, and the same name on another server's port is not Flint's database.
        for (const value of ['postgresql://flint_backup:x@[::1]:5432/nexus', 'postgres://flint_backup:x@127.0.0.1/nexus', 'postgresql://flint_backup:x@localhost:5433/flint', 'postgresql://flint_backup:p%40ss@[::1]/Nexus_2']) {
          expect(nexusUrlProblem(value, 'postgresql://flint_backup:x@[::1]:5432/flint'), value).toBeUndefined();
        }
      });

      it('the switch is one line in backup.env, read the same way by the runtime, the commands and the nightly script', () => {
        const h = mkdtempSync(join(tmpdir(), 'rt-nexus-switch-'));
        mkdirSync(join(h, '.flint'), { mode: 0o700 });
        const file = join(h, '.flint', 'backup.env');
        const script = readFileSync(join(__dirname, '..', 'backup-nightly.sh'), 'utf8');
        const fn = /^nexus_on\(\) \{.*\}$/m.exec(script)?.[0];
        expect(fn, 'the nightly script’s own check').toBeTruthy();
        const nightly = () => spawnSync('/bin/zsh', ['-c', `DATA="$1"; ${fn}\nnexus_on`, 'zsh', join(h, '.flint')], { encoding: 'utf8' }).status === 0;
        const url = 'postgresql://flint_backup:x@[::1]:5432/nexus';
        const cases: Array<[string, boolean]> = [
          [`FLINT_NEXUS_BACKUP_URL=${url}\n`, true],
          [`A=1\nexport FLINT_NEXUS_BACKUP_URL=${url}\nB=2\n`, true],
          [`FLINT_NEXUS_BACKUP_URL="${url}"\n`, true],
          [`FLINT_NEXUS_BACKUP_URL='${url}'\n`, true],
          [`FLINT_NEXUS_BACKUP_URL= ${url}\n`, true],
          ['FLINT_NEXUS_BACKUP_URL=\n', false],
          ['FLINT_NEXUS_BACKUP_URL=""\n', false],
          ['FLINT_NEXUS_BACKUP_URL=   \n', false],
          [`# FLINT_NEXUS_BACKUP_URL=${url}\n`, false],
          [`XFLINT_NEXUS_BACKUP_URL=${url}\n`, false],
          [`FLINT_NEXUS_BACKUP_URL_OLD=${url}\n`, false],
          [' \n', false],
          // Of two lines for it, the last one counts.
          [`FLINT_NEXUS_BACKUP_URL=${url}\nFLINT_NEXUS_BACKUP_URL=\n`, false],
          [`FLINT_NEXUS_BACKUP_URL=\nFLINT_NEXUS_BACKUP_URL=${url}\n`, true],
          [`FLINT_NEXUS_BACKUP_URL=${url}`, true],
        ];
        for (const [text, wanted] of cases) {
          writeFileSync(file, text, { mode: 0o600 });
          expect(nexusBackupWanted(h, file), JSON.stringify(text)).toBe(wanted);
          expect(nightly(), JSON.stringify(text)).toBe(wanted);
          // ...and it is what the commands' own reading of the file gives.
          expect(!!runtimeEnv(file, {}).FLINT_NEXUS_BACKUP_URL?.trim(), JSON.stringify(text)).toBe(wanted);
        }
        rmSync(file);
        expect(nexusBackupWanted(h, file)).toBe(false);
        expect(nightly()).toBe(false);
        // For Settings > Health the runtime tells three things apart, and keeps none of the address: off, on, and
        // set to something Flint cannot use (which the commands refuse with the same reason).
        const flintLine = 'FLINT_DB_BACKUP_URL=postgresql://flint_backup:x@[::1]:5432/flint\n';
        const states: Array<[string, 'off' | 'on' | 'bad']> = [
          [flintLine, 'off'],
          [`${flintLine}FLINT_NEXUS_BACKUP_URL=\n`, 'off'],
          [`${flintLine}FLINT_NEXUS_BACKUP_URL=${url}\n`, 'on'],
          [`${flintLine}export FLINT_NEXUS_BACKUP_URL="${url}"\n`, 'on'],
          [`${flintLine}FLINT_NEXUS_BACKUP_URL=postgresql://flint_backup:x@db.example.com:5432/nexus\n`, 'bad'],
          [`${flintLine}FLINT_NEXUS_BACKUP_URL=nexus\n`, 'bad'],
          [`${flintLine}FLINT_NEXUS_BACKUP_URL=postgresql://flint_backup:x@localhost:5432/flint\n`, 'bad'],
          [`${flintLine}FLINT_NEXUS_BACKUP_URL=postgresql://flint_backup:x@[::1]:5432/postgres\n`, 'bad'],
          // The last line for a name counts, for both names.
          [`${flintLine}FLINT_NEXUS_BACKUP_URL=nexus\nFLINT_NEXUS_BACKUP_URL=${url}\n`, 'on'],
          [`FLINT_DB_BACKUP_URL=postgresql://flint_backup:x@[::1]:5432/nexus\n${flintLine}FLINT_NEXUS_BACKUP_URL=${url}\n`, 'on'],
          [`${flintLine}FLINT_DB_BACKUP_URL=postgresql://flint_backup:x@[::1]:5432/nexus\nFLINT_NEXUS_BACKUP_URL=${url}\n`, 'bad'],
        ];
        for (const [text, state] of states) {
          writeFileSync(file, text, { mode: 0o600 });
          expect(nexusBackupState(h, file), JSON.stringify(text)).toBe(state);
          expect(nexusBackupWanted(h, file), JSON.stringify(text)).toBe(state !== 'off');
          // ...and it is what the commands' own check of the same lines says.
          const env = runtimeEnv(file, {});
          const value = env.FLINT_NEXUS_BACKUP_URL?.trim();
          expect(!value ? 'off' : nexusUrlProblem(value, env.FLINT_DB_BACKUP_URL) ? 'bad' : 'on', JSON.stringify(text)).toBe(state);
        }
        rmSync(file);
        expect(nexusBackupState(h, file)).toBe('off');
        rmSync(h, { recursive: true, force: true });
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
