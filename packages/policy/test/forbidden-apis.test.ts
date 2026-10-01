/**
 * Forbidden APIs (Machine plan 3.0.10), checked over the whole repository on
 * every CI run and every deploy:
 *  - no `$queryRawUnsafe` / `$executeRawUnsafe` anywhere: SQL is parameterized;
 *  - no `process.env` in the runtime outside its config.ts, nor anywhere in this
 *    package: configuration is read in one place, validated, and never logged;
 *  - no `pull_request_target` and no `secrets.` in a workflow: the repo is public
 *    and CI runs code from forks.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(__dirname, '..', '..', '..');
const SKIP = new Set(['node_modules', 'dist', '.git', '.turbo', 'coverage', '.claude']);
const CODE = /\.(ts|mts|cts|js|mjs|cjs)$/;

function files(dir: string, match: RegExp): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p, match));
    else if (match.test(name)) out.push(p);
  }
  return out;
}

const rel = (p: string) => relative(ROOT, p);
/** Source lines, with `//` and block comments blanked so a comment naming an API is not a use. */
const code = (p: string) => readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:])\/\/.*$/gm, '$1');
const hits = (paths: string[], re: RegExp) => paths.filter((p) => re.test(code(p))).map(rel);

const sources = [
  ...readdirSync(join(ROOT, 'apps')).flatMap((a) => files(join(ROOT, 'apps', a, 'src'), CODE)),
  ...readdirSync(join(ROOT, 'packages')).flatMap((a) => [
    ...files(join(ROOT, 'packages', a, 'src'), CODE),
    ...files(join(ROOT, 'packages', a, 'connectors'), CODE),
  ]),
];

describe('forbidden APIs', () => {
  it('finds the source tree (the scan is not silently empty)', () => {
    expect(sources.length).toBeGreaterThan(50);
  });

  it('no unsafe raw SQL', () => {
    expect(hits(sources, /\$(queryRawUnsafe|executeRawUnsafe)\b/)).toEqual([]);
  });

  it('the runtime reads process.env only in src/config.ts', () => {
    const runtime = files(join(ROOT, 'apps', 'runtime', 'src'), CODE).filter((p) => rel(p) !== join('apps', 'runtime', 'src', 'config.ts'));
    expect(hits(runtime, /\bprocess\.env\b/)).toEqual([]);
  });

  it('@flint/policy never reads process.env', () => {
    expect(hits(files(join(ROOT, 'packages', 'policy', 'src'), CODE), /\bprocess\.env\b/)).toEqual([]);
  });

  it('workflows never use pull_request_target or secrets', () => {
    // .github/pending-workflows holds ci.yml until the push token can write workflows.
    const wf = files(join(ROOT, '.github'), /\.ya?ml$/);
    expect(wf.length).toBeGreaterThan(0);
    expect(wf.filter((p) => /pull_request_target|\bsecrets\./.test(readFileSync(p, 'utf8').replace(/^\s*#.*$/gm, ''))).map(rel)).toEqual([]);
  });
});
