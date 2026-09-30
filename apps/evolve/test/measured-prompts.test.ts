import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { measuredPrompts } from '../src/run-measure';

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
