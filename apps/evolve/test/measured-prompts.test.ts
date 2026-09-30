import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { measuredPrompts, reachReport } from '../src/run-measure';

function files(pool: object[], baseline?: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'evolve-'));
  const promptsPath = join(dir, 'prompts.jsonl');
  const baselinePath = join(dir, 'baseline.json');
  writeFileSync(promptsPath, pool.map((p) => JSON.stringify(p)).join('\n'));
  if (baseline) writeFileSync(baselinePath, JSON.stringify({ createdAt: 't', config: 'c', answers: baseline }));
  return { promptsPath, baselinePath };
}

describe('measuredPrompts', () => {
  it('is the baseline\'s prompts, in the baseline\'s order', () => {
    const f = files(
      [
        { id: 'a', prompt: 'first' },
        { id: 'b', prompt: 'second' },
        { id: 'c', prompt: 'third' },
      ],
      { c: 'x', a: 'y' },
    );
    expect(measuredPrompts(f.promptsPath, f.baselinePath)?.map((p) => p.id)).toEqual(['c', 'a']);
  });

  it('drops a baseline id the pool no longer has', () => {
    const f = files([{ id: 'a', prompt: 'first' }], { a: 'y', gone: 'z' });
    expect(measuredPrompts(f.promptsPath, f.baselinePath)?.map((p) => p.id)).toEqual(['a']);
  });

  it('is undefined before a baseline exists, so try can refuse before spending', () => {
    const f = files([{ id: 'a', prompt: 'first' }]);
    expect(measuredPrompts(f.promptsPath, f.baselinePath)).toBeUndefined();
  });
});

describe('reachReport', () => {
  it('counts, per tier, the measured prompts that reach it', () => {
    const f = files(
      [
        { id: 'a', prompt: 'Explain the birthday paradox.' },
        { id: 'b', prompt: 'thanks!' },
      ],
      { a: 'x', b: 'y' },
    );
    expect(reachReport(['routine', 'code'], f.promptsPath, f.baselinePath)).toEqual({
      reach: [
        { tier: 'routine', reachable: 1, total: 2 },
        { tier: 'code', reachable: 0, total: 2 },
      ],
    });
  });

  it('is empty, not an error, before a baseline exists', () => {
    const f = files([{ id: 'a', prompt: 'hi' }]);
    expect(reachReport(['routine'], f.promptsPath, f.baselinePath)).toEqual({ reach: [] });
  });

  // Discovery reads neither file; losing them must not lose the night's report.
  it('skips the section, saying why, when the prompt pool is missing or the baseline is damaged', () => {
    const f = files([{ id: 'a', prompt: 'hi' }], { a: 'x' });
    const missingPool = reachReport(['routine'], `${f.promptsPath}.gone`, f.baselinePath);
    expect(missingPool.reach).toEqual([]);
    expect(missingPool.skipped).toMatch(/ENOENT/);
    writeFileSync(f.baselinePath, '{"answers": {"a": ');
    const damaged = reachReport(['routine'], f.promptsPath, f.baselinePath);
    expect(damaged.reach).toEqual([]);
    expect(damaged.skipped).toBeTruthy();
  });
});
