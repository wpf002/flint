import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyCandidate, hasParked, parkEnvLine, readEnvLine, readRollback, recoverIfNeeded, setEnvLine, settleCandidate, unparkEnvLine, writeSecrets, type TryIo } from '../src/run-try';

describe('setEnvLine', () => {
  const file = 'A=1\nFLINT_TIER_HARD=anthropic:claude-opus-5-5\nB=2\n';

  it('replaces one line and leaves the rest alone', () => {
    const out = setEnvLine(file, 'FLINT_TIER_HARD', 'openai:gpt-5.6-sol');
    expect(out).toContain('FLINT_TIER_HARD=openai:gpt-5.6-sol');
    expect(out).toContain('A=1');
    expect(out).toContain('B=2');
    expect(out.match(/FLINT_TIER_HARD=/g)).toHaveLength(1);
  });

  it('removes the line when the value is undefined', () => {
    expect(setEnvLine(file, 'FLINT_TIER_HARD', undefined)).not.toContain('FLINT_TIER_HARD');
  });

  it('adds the line when it was absent', () => {
    expect(setEnvLine('A=1\n', 'FLINT_TIER_CODE', 'openai:x')).toContain('FLINT_TIER_CODE=openai:x');
  });

  it('does not accumulate blank lines across edits', () => {
    let s = 'A=1\n';
    for (let i = 0; i < 5; i++) s = setEnvLine(s, 'K', `v${i}`);
    expect(s).toBe('A=1\nK=v4\n');
  });
});

describe('readEnvLine', () => {
  it('reads a value and strips quotes', () => {
    expect(readEnvLine('K="v"\n', 'K')).toBe('v');
    expect(readEnvLine('K=v\n', 'K')).toBe('v');
  });

  it('is undefined when unset', () => {
    expect(readEnvLine('A=1\n', 'K')).toBeUndefined();
  });
});

// The line a tier had before a try is never deleted and rewritten: it is parked as a comment where it
// stood, and put back from there. So undoing a try writes no tier value of evolve's own making.
describe('parkEnvLine / unparkEnvLine', () => {
  const file = 'A=1\nFLINT_TIER_HARD="anthropic:claude-opus-5-5"\nB=2\n';

  it('parks the line that was there, exactly as written, and puts the candidate in', () => {
    const out = parkEnvLine(file, 'FLINT_TIER_HARD', 'ollama:qwen3.8:27b');
    expect(out).toBe('A=1\n#evolve-parked FLINT_TIER_HARD="anthropic:claude-opus-5-5"\nB=2\nFLINT_TIER_HARD=ollama:qwen3.8:27b\n');
    // The server reads the candidate and nothing else: a comment line sets nothing.
    expect(readEnvLine(out, 'FLINT_TIER_HARD')).toBe('ollama:qwen3.8:27b');
    expect(hasParked(out, 'FLINT_TIER_HARD')).toBe(true);
    expect(hasParked(out, 'FLINT_TIER_CODE')).toBe(false);
  });

  it('un-parking gives the file back byte for byte', () => {
    expect(unparkEnvLine(parkEnvLine(file, 'FLINT_TIER_HARD', 'ollama:qwen3.8:27b'), 'FLINT_TIER_HARD')).toBe(file);
  });

  it('a tier that was not set has nothing to park, and un-parking leaves it unset', () => {
    const out = parkEnvLine('A=1\n', 'FLINT_TIER_CODE', 'ollama:qwen2.5:7b');
    expect(out).toBe('A=1\nFLINT_TIER_CODE=ollama:qwen2.5:7b\n');
    expect(unparkEnvLine(out, 'FLINT_TIER_CODE')).toBe('A=1\n');
  });

  it('a leftover from an older try is not put back by a later one', () => {
    const stale = '#evolve-parked FLINT_TIER_HARD=openai:gpt-5\nFLINT_TIER_HARD=ollama:a:1b\n';
    const out = parkEnvLine(stale, 'FLINT_TIER_HARD', 'ollama:b:2b');
    expect(out).toBe('#evolve-parked FLINT_TIER_HARD=ollama:a:1b\nFLINT_TIER_HARD=ollama:b:2b\n');
    expect(unparkEnvLine(out, 'FLINT_TIER_HARD')).toBe('FLINT_TIER_HARD=ollama:a:1b\n');
  });
});

describe('readRollback (a marker is checked before it is believed)', () => {
  const marker = (o: Record<string, unknown>) => JSON.stringify({ envVar: 'FLINT_TIER_HARD', candidate: 'ollama:qwen3.8:27b', startedAt: 'now', ...o });

  it('accepts what applyCandidate writes: a tier, a local candidate', () => {
    expect(readRollback(marker({ previous: 'anthropic:claude-opus-5-5' }))).toEqual({
      ok: true,
      rb: { envVar: 'FLINT_TIER_HARD', candidate: 'ollama:qwen3.8:27b', startedAt: 'now', previous: 'anthropic:claude-opus-5-5' },
    });
    expect(readRollback(marker({})).ok).toBe(true);
  });

  it('refuses an env var that is not a tier: it cannot be pointed at a key, a host or any other setting', () => {
    for (const envVar of ['ANTHROPIC_API_KEY', 'OLLAMA_HOST', 'FLINT_TOKEN', 'FLINT_TIER_LAST_RESORT', 'FLINT_TIER_OLLAMA_HOST', 'FLINT_TIERS', 'flint_tier_hard', 'FLINT_TIER_HARD\nX', '', 7]) {
      const r = readRollback(marker({ envVar }));
      expect(r.ok, String(envVar)).toBe(false);
      expect((r as { why: string }).why).toBe('its env var is not a tier');
    }
  });

  it('refuses a candidate that is not a local model', () => {
    for (const candidate of ['openai:gpt-5.6-sol', 'anthropic:claude-opus-5-5', 'ollama:gpt-oss:120b-cloud', 'ollama:', 'qwen3.8:27b', '', null]) {
      expect(readRollback(marker({ candidate })).ok, String(candidate)).toBe(false);
    }
  });

  it('refuses a previous value that is not a provider:model, and anything that is not JSON', () => {
    expect(readRollback(marker({ previous: 'x\nANTHROPIC_API_KEY=sk' })).ok).toBe(false);
    expect(readRollback(marker({ previous: 42 })).ok).toBe(false);
    expect(readRollback('not json')).toEqual({ ok: false, why: 'it is not JSON' });
    expect(readRollback('[]').ok).toBe(false);
  });
});

describe('rollback safety', () => {
  let dir: string;
  let io: TryIo;
  let restarts: number;
  const ORIGINAL = 'FLINT_TIER_HARD=anthropic:claude-opus-5-5\nOTHER=keep\n';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'evolve-try-'));
    restarts = 0;
    io = {
      secretsPath: join(dir, 'secrets.env'),
      rollbackPath: join(dir, 'rollback.json'),
      restart: () => {
        restarts++;
      },
      waitHealthy: async () => {},
    };
    writeFileSync(io.secretsPath, ORIGINAL, 'utf8');
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('writes the undo marker before changing the config, and parks the line that was there', async () => {
    await applyCandidate(io, { tier: 'hard', provider: 'ollama', model: 'qwen3.8:27b' }, 'now');
    expect(existsSync(io.rollbackPath)).toBe(true);
    const out = readFileSync(io.secretsPath, 'utf8');
    expect(readEnvLine(out, 'FLINT_TIER_HARD')).toBe('ollama:qwen3.8:27b');
    expect(out).toContain('#evolve-parked FLINT_TIER_HARD=anthropic:claude-opus-5-5');
    expect(restarts).toBe(1);
  });

  // `try` rewrites the live config, so the write itself refuses anything but a local model,
  // whatever its caller checked: no marker, no change to the file, no restart.
  it('never writes an outside model into the config', async () => {
    for (const c of [
      { tier: 'hard', provider: 'openai', model: 'gpt-5.6-sol' },
      { tier: 'hard', provider: 'anthropic', model: 'claude-opus-5-5' },
      { tier: 'code', provider: 'google', model: 'gemini-3.8-pro' },
      { tier: 'routine', provider: 'perplexity', model: 'sonar' },
      { tier: 'hard', provider: 'OLLAMA', model: 'qwen3.8:27b' }, // not the provider name Flint reads
      { tier: 'hard', provider: 'ollama', model: 'gpt-oss:120b-cloud' }, // open weights, but on Ollama's servers
    ]) {
      await expect(applyCandidate(io, c, 'now'), `${c.provider}:${c.model}`).rejects.toThrow(/refusing to write/);
    }
    expect(readFileSync(io.secretsPath, 'utf8')).toBe(ORIGINAL);
    expect(existsSync(io.rollbackPath)).toBe(false);
    expect(restarts).toBe(0);
  });

  // The review's case: the model goes into the file as `FLINT_TIER_X=ollama:<model>`, so a name with a
  // line break in it wrote a second line of its own choosing under the first.
  it('never writes a model name that is not one: a line break in it would add a line to secrets.env', async () => {
    for (const model of ['qwen3.8:27b\nANTHROPIC_API_KEY=sk-ant-planted', 'qwen3.8:27b\rOLLAMA_HOST=http://evil.example', 'qwen 3.8', 'x"y', "x'y", 'x#comment', 'x=y', '', ' ', 'x'.repeat(200)]) {
      await expect(applyCandidate(io, { tier: 'hard', provider: 'ollama', model }, 'now'), JSON.stringify(model)).rejects.toThrow(/refusing to write/);
    }
    expect(readFileSync(io.secretsPath, 'utf8')).toBe(ORIGINAL);
    expect(existsSync(io.rollbackPath)).toBe(false);
    expect(restarts).toBe(0);
  });

  it('never writes an env var that is not a tier', async () => {
    for (const tier of ['last_resort', 'ollama_host', 'x']) {
      await expect(applyCandidate(io, { tier, provider: 'ollama', model: 'qwen3.8:27b' }, 'now'), tier).rejects.toThrow(/is not a tier/);
    }
    expect(readFileSync(io.secretsPath, 'utf8')).toBe(ORIGINAL);
    expect(existsSync(io.rollbackPath)).toBe(false);
  });

  // The whole point: a run that dies mid-test must not leave Flint on an unproven config.
  // Will's own line comes back byte for byte, from his own file: nothing here writes its value.
  it('restores the previous config on the next run, by un-parking Will\'s own line', async () => {
    await applyCandidate(io, { tier: 'hard', provider: 'ollama', model: 'qwen3.8:27b' }, 'now');
    const note = await recoverIfNeeded(io); // as if the process had died here
    expect(note).toBe('restored FLINT_TIER_HARD after an interrupted try of ollama:qwen3.8:27b');
    expect(readFileSync(io.secretsPath, 'utf8')).toBe(ORIGINAL);
    expect(existsSync(io.rollbackPath)).toBe(false);
    expect(restarts).toBe(2);
  });

  it('what the marker says the previous value was is not what gets restored: the parked line is', async () => {
    await applyCandidate(io, { tier: 'hard', provider: 'ollama', model: 'qwen3.8:27b' }, 'now');
    // Someone edits the marker to name another outside model as "previous".
    const rb = JSON.parse(readFileSync(io.rollbackPath, 'utf8')) as Record<string, unknown>;
    writeFileSync(io.rollbackPath, JSON.stringify({ ...rb, previous: 'openai:gpt-9-evil' }), 'utf8');
    await recoverIfNeeded(io);
    const out = readFileSync(io.secretsPath, 'utf8');
    expect(out).toBe(ORIGINAL);
    expect(out).not.toContain('gpt-9-evil');
  });

  it('removes a tier that was not set before, rather than inventing one', async () => {
    writeFileSync(io.secretsPath, 'OTHER=keep\n', 'utf8');
    await applyCandidate(io, { tier: 'code', provider: 'ollama', model: 'qwen2.5:7b' }, 'now');
    await recoverIfNeeded(io);
    expect(readFileSync(io.secretsPath, 'utf8')).toBe('OTHER=keep\n');
  });

  it('does nothing when there is no marker', async () => {
    expect(await recoverIfNeeded(io)).toBeUndefined();
    expect(restarts).toBe(0);
  });

  // The review's case: rollback.json was believed as written, so a stale or hand-made one made any
  // `evolve try` write whatever KEY=value it named into the config and restart Flint.
  it('a marker that is not one is dropped, and the config is not touched', async () => {
    for (const forged of [
      { envVar: 'ANTHROPIC_API_KEY', previous: 'sk-ant-attacker', candidate: 'ollama:qwen3.8:27b', startedAt: 'x' },
      { envVar: 'FLINT_TIER_HARD', previous: 'openai:gpt-5', candidate: 'openai:gpt-5.6-sol', startedAt: 'x' },
      { envVar: 'OLLAMA_HOST', previous: 'http://evil.example:11434', candidate: 'ollama:x', startedAt: 'x' },
      'garbage',
    ]) {
      writeFileSync(io.rollbackPath, typeof forged === 'string' ? forged : JSON.stringify(forged), 'utf8');
      const note = await recoverIfNeeded(io);
      expect(note).toMatch(/^dropped a rollback marker that is not one \(.*\); the config was not touched$/);
      expect(readFileSync(io.secretsPath, 'utf8')).toBe(ORIGINAL);
      expect(existsSync(io.rollbackPath)).toBe(false);
    }
    expect(restarts).toBe(0);
  });

  it('a real-looking marker whose candidate is not in the config (Will changed the tier since) changes nothing', async () => {
    writeFileSync(io.rollbackPath, JSON.stringify({ envVar: 'FLINT_TIER_HARD', previous: 'openai:gpt-5', candidate: 'ollama:qwen3.8:27b', startedAt: 'x' }), 'utf8');
    const note = await recoverIfNeeded(io);
    expect(note).toBe('an interrupted try of ollama:qwen3.8:27b left a marker, but FLINT_TIER_HARD no longer holds it; the config was left as it is');
    expect(readFileSync(io.secretsPath, 'utf8')).toBe(ORIGINAL);
    expect(existsSync(io.rollbackPath)).toBe(false);
    expect(restarts).toBe(0);
  });

  // A marker written by the code before parking existed: the previous line was deleted, and its value is only in the JSON.
  it('an old marker naming an outside previous value: the candidate comes out, and the value is not written, only named for Will', async () => {
    writeFileSync(io.secretsPath, 'OTHER=keep\nFLINT_TIER_HARD=ollama:qwen3.8:27b\n', 'utf8');
    writeFileSync(io.rollbackPath, JSON.stringify({ envVar: 'FLINT_TIER_HARD', previous: 'anthropic:claude-opus-5-5', candidate: 'ollama:qwen3.8:27b', startedAt: 'x' }), 'utf8');
    const note = await recoverIfNeeded(io);
    expect(readFileSync(io.secretsPath, 'utf8')).toBe('OTHER=keep\n');
    expect(note).toBe(
      'removed ollama:qwen3.8:27b from FLINT_TIER_HARD after an interrupted try. It was anthropic:claude-opus-5-5 before; evolve does not write an outside model, so set it back by hand if you want it',
    );
    expect(restarts).toBe(1);
  });

  it('an old marker naming a local previous value puts it back', async () => {
    writeFileSync(io.secretsPath, 'OTHER=keep\nFLINT_TIER_HARD=ollama:qwen3.8:27b\n', 'utf8');
    writeFileSync(io.rollbackPath, JSON.stringify({ envVar: 'FLINT_TIER_HARD', previous: 'ollama:muse-glimmer:30b', candidate: 'ollama:qwen3.8:27b', startedAt: 'x' }), 'utf8');
    await recoverIfNeeded(io);
    expect(readFileSync(io.secretsPath, 'utf8')).toBe('OTHER=keep\nFLINT_TIER_HARD=ollama:muse-glimmer:30b\n');
  });

  // secrets.env holds every key Flint has. It is replaced by a rename, never rewritten in place.
  it('every write of the config goes through a temp file, mode 600, renamed over it: nothing is left beside it', async () => {
    chmodSync(io.secretsPath, 0o644); // as a careless editor might leave it
    const files = () => readdirSync(dir).sort();
    await applyCandidate(io, { tier: 'hard', provider: 'ollama', model: 'qwen3.8:27b' }, 'now');
    expect(statSync(io.secretsPath).mode & 0o777).toBe(0o600);
    expect(files()).toEqual(['rollback.json', 'secrets.env']);
    await recoverIfNeeded(io);
    expect(statSync(io.secretsPath).mode & 0o777).toBe(0o600);
    expect(files()).toEqual(['secrets.env']);
    await applyCandidate(io, { tier: 'hard', provider: 'ollama', model: 'qwen3.8:27b' }, 'now');
    settleCandidate(io);
    expect(statSync(io.secretsPath).mode & 0o777).toBe(0o600);
    expect(files()).toEqual(['secrets.env']);
  });

  it('keeping the candidate drops the marker and the parked line, and leaves the candidate in place', async () => {
    await applyCandidate(io, { tier: 'hard', provider: 'ollama', model: 'qwen3.8:27b' }, 'now');
    settleCandidate(io);
    expect(existsSync(io.rollbackPath)).toBe(false);
    expect(readFileSync(io.secretsPath, 'utf8')).toBe('OTHER=keep\nFLINT_TIER_HARD=ollama:qwen3.8:27b\n');
  });
});

describe('writeSecrets (the file is replaced whole, or not at all)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'evolve-secrets-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('replaces the contents and leaves the file at mode 600, whatever it was', () => {
    const path = join(dir, 'secrets.env');
    writeFileSync(path, 'A=1\n', { encoding: 'utf8', mode: 0o644 });
    writeSecrets(path, 'A=2\n');
    expect(readFileSync(path, 'utf8')).toBe('A=2\n');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(['secrets.env']);
  });

  it('creates the file when there is none', () => {
    const path = join(dir, 'secrets.env');
    writeSecrets(path, 'A=1\n');
    expect(readFileSync(path, 'utf8')).toBe('A=1\n');
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('a write that cannot finish leaves what was there untouched, and no temp file behind', () => {
    // The "file" is a directory with something in it: the rename over it fails.
    const path = join(dir, 'secrets.env');
    mkdirSync(path);
    writeFileSync(join(path, 'keep'), 'still here', 'utf8');
    expect(() => writeSecrets(path, 'A=1\n')).toThrow();
    expect(readFileSync(join(path, 'keep'), 'utf8')).toBe('still here');
    expect(readdirSync(dir)).toEqual(['secrets.env']);
  });

  it('a symlinked secrets.env stays a symlink: the file it points at is the one replaced', () => {
    const real = join(dir, 'real.env');
    const link = join(dir, 'secrets.env');
    writeFileSync(real, 'A=1\n', 'utf8');
    symlinkSync(real, link);
    writeSecrets(link, 'A=2\n');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(real, 'utf8')).toBe('A=2\n');
    expect(statSync(real).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir).sort()).toEqual(['real.env', 'secrets.env']);
  });
});
