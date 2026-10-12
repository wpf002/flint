/**
 * How cli.ts wires `try` and `discover` (it runs a command on import, so this
 * reads its source): `try` refuses anything but a local model before it reads
 * the baseline, lists a catalog, probes or writes; `discover` asks the outside
 * vendors only with --vendors.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(join(__dirname, '..', 'src', 'cli.ts'), 'utf8');
const between = (a: string, b: string) => {
  const i = src.indexOf(a);
  const j = src.indexOf(b, i + 1);
  expect(i).toBeGreaterThan(0);
  expect(j).toBeGreaterThan(i);
  return src.slice(i, j);
};
const runTry = between('async function runTry(spec: string)', 'const cmd = process.argv[2];');
const discover = between('async function discover(args: readonly string[])', '/** Flint\'s bearer token');

describe('evolve try', () => {
  it('refuses a candidate that is not local before anything else is done with it', () => {
    const refuse = runTry.indexOf('const local = localOnly(cand);');
    expect(refuse).toBeGreaterThan(0);
    expect(runTry).toMatch(/const local = localOnly\(cand\);\s*if \(!local\.ok\) \{\s*console\.log\(`refused: \$\{local\.reason\}\. Nothing was tried or spent\.`\);\s*return 1;\s*\}/);
    for (const later of ['measuredPrompts(', 'tierReach(', 'allCatalogs(', 'screen(cand', 'await probe(', 'applyCandidate(', 'measureOnce(']) {
      expect(runTry.indexOf(later), later).toBeGreaterThan(refuse);
    }
    // An interrupted earlier run is still put back first, whatever this run asks for.
    expect(runTry.indexOf('recoverIfNeeded(io)')).toBeLessThan(refuse);
  });

  it('checks the candidate against Ollama\'s own list only: no vendor catalog is fetched', () => {
    expect(runTry).toContain('const catalogs = await allCatalogs(env);');
    expect(runTry).not.toContain('vendors: ');
  });

  it('its example and usage name a local model', () => {
    expect(src).toContain("expected e.g. hard=ollama:qwen3.8:27b");
    expect(src).toContain("'usage: evolve <discover [--vendors] | measure | try hard=ollama:model>'");
    expect(src).not.toMatch(/hard=openai/);
  });
});

describe('evolve discover', () => {
  it('lists the outside vendors only when the run asks with --vendors', () => {
    expect(discover).toContain('const catalogs = await allCatalogs(env, { vendors: wantsVendors(args) });');
    expect(src).toContain('discover(process.argv.slice(3))');
    expect(src.match(/allCatalogs\(/g)).toHaveLength(2);
  });
});
