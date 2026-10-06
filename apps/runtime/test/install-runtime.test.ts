/**
 * install-runtime.sh, P2's parts: the bundle targets node22, launchd gives a
 * stop 30 s (the bus drains for 15), Will's runtime.override.env is never
 * written (only kept 0600), and pruning keeps a pinned release. P2.6's: Flint
 * Calendar's push token, and a rollback on the env the old release knew.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseTokens } from '../src/config';

const SCRIPT = readFileSync(join(__dirname, '..', 'install-runtime.sh'), 'utf8');
const between = (from: string, to: string) => {
  const a = SCRIPT.indexOf(from);
  const b = SCRIPT.indexOf(to, a);
  if (a < 0 || b < 0) throw new Error(`install-runtime.sh changed: no ${from} … ${to}`);
  return SCRIPT.slice(a, b + to.length);
};
const zsh = (body: string) => spawnSync('/bin/zsh', ['-c', `set -e\nsetopt pipefail\n${body}`], { encoding: 'utf8' });

describe('install-runtime.sh', () => {
  it('bundles for node22, on both esbuild lines', () => {
    expect(SCRIPT.match(/--target=node\d+/g)).toEqual(['--target=node22', '--target=node22']);
  });

  it('files a failed pre-migrate copy under the gate, and only a failed migration under migrate', () => {
    // The migrate_failed note says the update won't be retried and that a copy exists: true only once both hold.
    const dump = SCRIPT.indexOf('|| die "pre-migrate dump failed');
    const stage = SCRIPT.indexOf('DEPLOY_STAGE=migrate');
    const migrate = SCRIPT.indexOf('prisma migrate deploy)');
    const marker = SCRIPT.indexOf('echo "$SHA" >> "$RT/migrate-failed"');
    expect(SCRIPT.match(/DEPLOY_STAGE=migrate/g)).toHaveLength(1);
    expect(dump).toBeGreaterThan(0);
    expect(stage).toBeGreaterThan(dump);
    expect(stage).toBeLessThan(migrate);
    expect(marker).toBeGreaterThan(migrate);
    // Before the dump, the stage is still the gate (set once, at the top).
    expect(SCRIPT.slice(SCRIPT.indexOf('DEPLOY_STAGE=gate'), dump)).not.toMatch(/DEPLOY_STAGE=(?!gate)/);
    // The trap records the dump's failure as the gate's.
    const trap = SCRIPT.split('\n').find((l) => l.startsWith('trap '))!;
    const out = zsh(`deploy_event() { echo "$1 $2 $3"; }\nSHA=x\nDEPLOY_STAGE=gate\n${trap}\nfalse || exit 1`);
    expect(out.stdout.trim()).toBe('runtime gate failed');
  });

  it('gives the runtime 30 s to stop (ExitTimeOut)', () => {
    expect(SCRIPT).toMatch(/<key>ExitTimeOut<\/key><integer>30<\/integer>/);
  });

  it('the override survives a redeploy: never written, only kept 0600', () => {
    expect(SCRIPT).not.toMatch(/>\s*"?\$DATA\/runtime\.override\.env/);
    const line = SCRIPT.split('\n').find((l) => l.includes('runtime.override.env') && l.includes('chmod'))!;
    const data = mkdtempSync(join(tmpdir(), 'rt-install-'));
    // Absent: nothing made, no failure under set -e.
    expect(zsh(`DATA=${data}\n${line}\necho END`).stdout).toContain('END');
    expect(existsSync(join(data, 'runtime.override.env'))).toBe(false);
    writeFileSync(join(data, 'runtime.override.env'), 'FLINT_RUNTIME_TRIAGE=on\n', { mode: 0o644 });
    expect(zsh(`DATA=${data}\n${line}\necho END`).stdout).toContain('END');
    expect(statSync(join(data, 'runtime.override.env')).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(data, 'runtime.override.env'), 'utf8')).toBe('FLINT_RUNTIME_TRIAGE=on\n');
  });

  it("keeps the calendar's token directory (P2.5) its owner's alone, and makes none when it is absent", () => {
    const line = SCRIPT.split('\n').find((l) => l.includes('$DATA/google') && l.includes('chmod'))!;
    const data = mkdtempSync(join(tmpdir(), 'rt-install-'));
    expect(zsh(`DATA=${data}\n${line}\necho END`).stdout).toContain('END');
    expect(existsSync(join(data, 'google'))).toBe(false);
    mkdirSync(join(data, 'google'), { mode: 0o755 });
    expect(zsh(`DATA=${data}\n${line}\necho END`).stdout).toContain('END');
    expect(statSync(join(data, 'google')).mode & 0o777).toBe(0o700);
  });

  it("makes Flint Calendar's push token (P2.6) once, 0600, and grants it calendar:push and nothing else", () => {
    const block = between('APPLE_TOKEN_FILE="$DATA/tokens/apple-calendar.token"', "APPLE_SHA=\"$(tr -d '\\n' < \"$APPLE_TOKEN_FILE\" | shasum -a 256 | cut -d' ' -f1)\"");
    const data = mkdtempSync(join(tmpdir(), 'rt-install-'));
    mkdirSync(join(data, 'tokens'), { mode: 0o700 });
    const run = () => zsh(`DATA=${data}\n${block}\necho "$APPLE_SHA"`);
    const first = run();
    const file = join(data, 'tokens', 'apple-calendar.token');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const token = readFileSync(file, 'utf8').trim();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(first.stdout.trim()).toBe(createHash('sha256').update(token).digest('hex'));
    // Kept across deploys (the helper reads the same file), and made 0600 again if loosened.
    chmodSync(file, 0o644);
    expect(run().stdout).toBe(first.stdout);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    // The grants: the push token gets calendar:push alone; the server's and the connector's never get it.
    const line = SCRIPT.split('\n').find((l) => l.includes('echo "RUNTIME_TOKENS='))!;
    const grants = Object.fromEntries(line.replace(/^.*RUNTIME_TOKENS=/, '').replace(/"$/, '').split(',').map((g) => {
      const [name, , ...scopes] = g.split(':');
      return [name, scopes.join(':').split('|')];
    }));
    expect(grants['apple-calendar']).toEqual(['calendar:push']);
    expect(grants.server).not.toContain('calendar:push');
    expect(grants['runtime-mcp']).not.toContain('calendar:push');
    expect(line).toContain('apple-calendar:${APPLE_SHA}:calendar:push');
    expect(() => parseTokens(`apple-calendar:${'a'.repeat(64)}:calendar:push`)).not.toThrow();
  });

  it('a rollback restarts the previous release on the env it started with, and a good deploy keeps no copy', () => {
    const keep = SCRIPT.split('\n').find((l) => l.includes('cp -p "$ENVF" "$ENVF.prev"'))!;
    const restore = SCRIPT.split('\n').find((l) => l.includes('mv "$ENVF.prev" "$ENVF"'))!.trim();
    expect(SCRIPT.indexOf(keep)).toBeLessThan(SCRIPT.indexOf('} > "$ENVF.new"'));
    expect(SCRIPT.indexOf(restore)).toBeGreaterThan(SCRIPT.indexOf('ln -sfn "$PREV" "$RT/current"'));
    expect(SCRIPT).toMatch(/is up on \[::1\]:\$PORT"\n\s+rm -f "\$ENVF\.prev"/);
    const data = mkdtempSync(join(tmpdir(), 'rt-install-'));
    const envf = join(data, 'runtime.env');
    writeFileSync(envf, 'RUNTIME_TOKENS=old\n', { mode: 0o600 });
    expect(zsh(`ENVF=${envf}\n${keep}\nprint -r -- 'RUNTIME_TOKENS=new' > "$ENVF"\n${restore}\necho END`).stdout).toContain('END');
    expect(readFileSync(envf, 'utf8')).toBe('RUNTIME_TOKENS=old\n');
    expect(statSync(envf).mode & 0o777).toBe(0o600);
    expect(existsSync(`${envf}.prev`)).toBe(false);
    // A first install (no env yet): nothing kept, and the rollback leaves the new env alone.
    const fresh = join(mkdtempSync(join(tmpdir(), 'rt-install-')), 'runtime.env');
    expect(zsh(`ENVF=${fresh}\n${keep}\nprint -r -- 'RUNTIME_TOKENS=new' > "$ENVF"\n${restore}\necho END`).stdout).toContain('END');
    expect(readFileSync(fresh, 'utf8')).toBe('RUNTIME_TOKENS=new\n');
  });

  it('writes the triage model settings only when they are loopback and well-formed', () => {
    const block = between('OLLAMA_HOST_V="$(', 'OLLAMA_NUM_CTX=$OLLAMA_CTX_V"; fi');
    const run = (host: string, model: string, ctx: string) => {
      const body = block
        .replace(/OLLAMA_HOST_V="\$\(plutil[^\n]*/, `OLLAMA_HOST_V='${host}'`)
        .replace(/OLLAMA_MODEL_V="\$\(plutil[^\n]*/, `OLLAMA_MODEL_V='${model}'`)
        .replace(/OLLAMA_CTX_V="\$\(plutil[^\n]*/, `OLLAMA_CTX_V='${ctx}'`);
      return zsh(body).stdout;
    };
    expect(run('http://127.0.0.1:11434', 'muse-glimmer:30b', '16384')).toBe('OLLAMA_URL=http://127.0.0.1:11434\nFLINT_TRIAGE_MODEL=muse-glimmer:30b\nOLLAMA_NUM_CTX=16384\n');
    expect(run('http://10.0.0.2:11434', 'a b', '16k; rm')).toBe('');
  });

  it('pruning keeps the newest three, the new release and any pinned one', () => {
    const prune = between('    ls -1dt "$RT"/releases/*(/N)', '    done\n');
    const rt = mkdtempSync(join(tmpdir(), 'rt-releases-'));
    const names = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6'];
    names.forEach((n, i) => {
      mkdirSync(join(rt, 'releases', n), { recursive: true });
      const t = new Date(Date.UTC(2026, 9, 1, i));
      utimesSync(join(rt, 'releases', n), t, t);
    });
    writeFileSync(join(rt, 'pinned'), 'r1\n');
    const r = zsh(`RT=${rt}\nREL=${rt}/releases/r6\n${prune}\necho END`);
    expect(r.stdout).toContain('END');
    expect(readdirSync(join(rt, 'releases')).sort()).toEqual(['r1', 'r4', 'r5', 'r6']);
  });

  it('keeps the nightly database backup agent installed: 02:15, its own script, no secrets, reloaded only when it changes', () => {
    const fn = between('BACKUP_LABEL=', '\n}');
    const dir = mkdtempSync(join(tmpdir(), 'rt-backup-agent-'));
    mkdirSync(join(dir, 'bin'));
    mkdirSync(join(dir, 'agents'));
    // launchctl, faked: records each call; `print` succeeds once something was bootstrapped.
    writeFileSync(join(dir, 'bin', 'launchctl'), `#!/bin/zsh\necho "$*" >> ${dir}/calls\n[ "$1" = bootstrap ] && touch ${dir}/loaded\n[ "$1" = print ] && { [ -f ${dir}/loaded ] || exit 1; }\nexit 0\n`, { mode: 0o755 });
    const run = () => zsh(`PATH=${dir}/bin:$PATH\nAGENTS=${dir}/agents\nDATA=${dir}/data\nRT_SRC=/repo/apps/runtime\nREPO=/repo\n${fn}\ninstall_backup_agent\necho END`);
    const first = run();
    expect(first.stdout).toContain('END');
    const plist = readFileSync(join(dir, 'agents', 'com.flint.runtime-backup.plist'), 'utf8');
    expect(plist).toContain('<string>/repo/apps/runtime/backup-nightly.sh</string>');
    expect(plist).toMatch(/<key>Hour<\/key><integer>2<\/integer><key>Minute<\/key><integer>15<\/integer>/);
    expect(plist).toContain('<key>FLINT_REPO</key><string>/repo</string>');
    expect(plist).not.toMatch(/postgres|TOKEN|password/i);
    expect(statSync(join(dir, 'agents', 'com.flint.runtime-backup.plist')).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(dir, 'calls'), 'utf8')).toMatch(/bootstrap gui\/\d+ /);
    // Unchanged and loaded: nothing is reloaded.
    const calls = readFileSync(join(dir, 'calls'), 'utf8');
    run();
    expect(readFileSync(join(dir, 'calls'), 'utf8').replace(calls, '')).not.toMatch(/bootstrap|bootout/);
  });

  it('the nightly script backs up every night, copies off the box only with a recipient, and drills on Sundays', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rt-backup-nightly-'));
    mkdirSync(join(dir, 'bin'));
    mkdirSync(join(dir, 'home', '.flint'), { recursive: true });
    writeFileSync(join(dir, 'bin', 'pnpm'), `#!/bin/zsh\necho "$*" >> ${dir}/pnpm-calls\nexit 0\n`, { mode: 0o755 });
    const script = join(__dirname, '..', 'backup-nightly.sh');
    const night = (dow: number) => {
      writeFileSync(join(dir, 'pnpm-calls'), '');
      spawnSync('/bin/zsh', [script], { env: { PATH: `${dir}/bin:/usr/bin:/bin`, HOME: join(dir, 'home'), FLINT_REPO: dir, FLINT_DOW: String(dow) }, encoding: 'utf8' });
      return readFileSync(join(dir, 'pnpm-calls'), 'utf8').trim().split('\n').map((l) => l.replace('--silent --filter @flint/runtime ', ''));
    };
    expect(night(3)).toEqual(['backup --auto']);
    expect(night(7)).toEqual(['backup --auto', 'drill --auto']);
    writeFileSync(join(dir, 'home', '.flint', 'backup-age-recipient'), 'age1example\n');
    expect(night(7)).toEqual(['backup --auto', 'offsite --auto', 'drill --auto']);
  });
});
