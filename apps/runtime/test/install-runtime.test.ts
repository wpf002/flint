/**
 * install-runtime.sh, P2's parts: the bundle targets node22, launchd gives a
 * stop 30 s (the bus drains for 15), Will's runtime.override.env is never
 * written (only kept 0600), and pruning keeps a pinned release.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
