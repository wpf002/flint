/**
 * Nothing that forecasts, settles or scores reaches the network (P4; static, in
 * the style of packages/policy/test/forbidden-apis.test.ts): every file under
 * src/predict/, and the ledger's sweep and scoring, is read as text. No fetch,
 * no socket, no model, no path to the frontier, no environment read, and no
 * command but the one fixed git count the materialiser is handed.
 *
 * When the local model's estimate arrives (its own part), it reaches loopback
 * Ollama through scopedFetch in one file, and this test names that file.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(__dirname, '..', '..', 'src');
const predict = readdirSync(join(SRC, 'predict')).filter((f) => f.endsWith('.ts')).map((f) => `predict/${f}`);
const ledger = ['ledger/sweep.ts', 'ledger/scoring.ts', 'ledger/bootstrap.ts', 'ledger/calibration.ts'];
const code = (f: string) => readFileSync(join(SRC, f), 'utf8');
/** The file without its comments: what it does, not what it says about itself. */
const bare = (f: string) => code(f).replace(/\/\*[\s\S]*?\*\/|(^|[^:'"`])\/\/.*$/gm, '$1');

describe('no egress from predictions', () => {
  it('every file is here: the forecaster, the materialiser, the runner, the phrase table, the resolvers, the registry and the card', () => {
    expect(predict.sort()).toEqual(['predict/enable.ts', 'predict/forecast.ts', 'predict/metrics.ts', 'predict/phrasing.ts', 'predict/resolvers.ts', 'predict/run.ts', 'predict/series.ts']);
  });

  it('none of them fetches, opens a socket, asks a model, or has a path to the frontier', () => {
    for (const f of [...predict, ...ledger]) {
      const src = bare(f);
      expect(src, f).not.toMatch(/\bfetch\s*\(|scopedFetch|XMLHttpRequest|WebSocket|EventSource/);
      expect(src, f).not.toMatch(/from 'node:(http|https|http2|net|tls|dgram|dns)'|from '(http|https|net|tls|dgram|undici|node-fetch|axios)'|require\(/);
      expect(src, f).not.toMatch(/ollama|OllamaProvider|@flint\/core|\/api\/chat|\/internal\/complete|frontier|anthropic\.com|openai\.com/i);
      expect(src, f).not.toMatch(/prophet-api|railway\.app|https?:\/\//);
      expect(src, f).not.toMatch(/process\.env/);
    }
  });

  it('none of them runs a command; the one that needs git is handed a fixed one, and builds no argument from data', () => {
    for (const f of [...predict, ...ledger]) expect(bare(f), f).not.toMatch(/child_process|execFile|\bexec\(|\bspawn\(|makeRun\(/);
    // The materialiser's only use of the runner it is handed: the commit count, by the clone's path and two instants.
    const metrics = bare('predict/metrics.ts');
    expect(metrics.match(/commitsBetween\(/g)).toHaveLength(1);
    expect(metrics.match(/d\.run\b/g)!.length).toBeLessThanOrEqual(2);
    const git = bare('sources/git.ts');
    const fn = git.slice(git.indexOf('export async function commitsBetween'), git.indexOf('export function gitSource'));
    expect(fn).toContain(`['-C', path, 'rev-list', '--count', '--all', \`--since=\${since.toISOString()}\`, \`--before=\${before.toISOString()}\`]`);
    expect(fn).not.toMatch(/fetch|pull|remote|log\b|show\b|format/);
  });

  it('the arithmetic draws on no clock and no chance: the forecaster, the scoring and the bootstrap give the same answer every time', () => {
    for (const f of ['predict/forecast.ts', 'predict/phrasing.ts', 'ledger/scoring.ts', 'ledger/bootstrap.ts']) {
      expect(bare(f), f).not.toMatch(/Math\.random|Date\.now|new Date\(\)|performance\.now/);
    }
    // And they hold no database: numbers in, numbers out.
    for (const f of ['predict/forecast.ts', 'predict/phrasing.ts', 'ledger/scoring.ts', 'ledger/bootstrap.ts']) expect(bare(f), f).not.toMatch(/@prisma|\.\.\/db\.js|\$queryRaw/);
  });
});
