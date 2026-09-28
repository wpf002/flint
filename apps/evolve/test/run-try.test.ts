import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyCandidate, readEnvLine, recoverIfNeeded, setEnvLine, settleCandidate, type TryIo } from '../src/run-try';

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

describe('rollback safety', () => {
  let dir: string;
  let io: TryIo;
  let restarts: number;

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
    writeFileSync(io.secretsPath, 'FLINT_TIER_HARD=anthropic:claude-opus-5-5\nOTHER=keep\n', 'utf8');
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('writes the undo marker before changing the config', async () => {
    await applyCandidate(io, { tier: 'hard', provider: 'openai', model: 'gpt-5.6-sol' }, 'now');
    expect(existsSync(io.rollbackPath)).toBe(true);
    expect(readFileSync(io.secretsPath, 'utf8')).toContain('FLINT_TIER_HARD=openai:gpt-5.6-sol');
    expect(restarts).toBe(1);
  });

  // The whole point: a run that dies mid-test must not leave Flint on an
  // unproven config.
  it('restores the previous config on the next run', async () => {
    await applyCandidate(io, { tier: 'hard', provider: 'openai', model: 'gpt-5.6-sol' }, 'now');
    const note = await recoverIfNeeded(io); // as if the process had died here
    expect(note).toContain('restored');
    expect(readFileSync(io.secretsPath, 'utf8')).toContain('FLINT_TIER_HARD=anthropic:claude-opus-5-5');
    expect(existsSync(io.rollbackPath)).toBe(false);
  });

  it('removes a tier that was not set before, rather than inventing one', async () => {
    writeFileSync(io.secretsPath, 'OTHER=keep\n', 'utf8');
    await applyCandidate(io, { tier: 'code', provider: 'openai', model: 'gpt-5.5' }, 'now');
    await recoverIfNeeded(io);
    const out = readFileSync(io.secretsPath, 'utf8');
    expect(out).not.toContain('FLINT_TIER_CODE');
    expect(out).toContain('OTHER=keep');
  });

  it('does nothing when there is no marker', async () => {
    expect(await recoverIfNeeded(io)).toBeUndefined();
    expect(restarts).toBe(0);
  });

  it('keeping the candidate drops the marker and leaves the config in place', async () => {
    await applyCandidate(io, { tier: 'hard', provider: 'openai', model: 'gpt-5.6-sol' }, 'now');
    settleCandidate(io);
    expect(existsSync(io.rollbackPath)).toBe(false);
    expect(readFileSync(io.secretsPath, 'utf8')).toContain('FLINT_TIER_HARD=openai:gpt-5.6-sol');
  });
});
