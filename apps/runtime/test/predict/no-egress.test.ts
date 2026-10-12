/**
 * Nothing that forecasts, settles or scores reaches the network (P4; static, in
 * the style of packages/policy/test/forbidden-apis.test.ts): every file under
 * src/predict/, the ledger's sweep and scoring, and the part of jobs.ts that
 * runs them, is read as text. No fetch, no socket, no model, no path to the
 * frontier, no environment read, no import decided at run time, and no command
 * but the two fixed git questions the materialiser is handed.
 *
 * Reading the text cannot see everything (a fetch built from pieces, or one in
 * a helper these files import), so no-egress-db.test.ts also runs both nightly
 * jobs with the network taken away and every command recorded.
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
/** The four prediction jobs, as jobs.ts runs them: the function that makes their handlers, and nothing else of that file. */
const jobs = (() => {
  const src = bare('jobs.ts');
  const from = src.indexOf('export function predictJobs(');
  return src.slice(from, src.indexOf('export function jobSpecs(', from));
})();

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
      // And nothing is imported by a name worked out at run time: every import is a line at the top, checked above.
      expect(src, f).not.toMatch(/\bimport\s*\(/);
    }
  });

  it('the jobs that run them (jobs.ts) add nothing: no fetch, no socket, no model, and one runner for commands, handed to the numbers job', () => {
    expect(jobs.length).toBeGreaterThan(1000);
    for (const queue of ['forecast.series', 'forecast.run', 'ledger.sweep', 'ledger.snapshot']) expect(jobs).toContain(`queue: '${queue}'`);
    expect(jobs).not.toMatch(/\bfetch\s*\(|scopedFetch|XMLHttpRequest|WebSocket|EventSource|https?:\/\/|process\.env|\bimport\s*\(/);
    expect(jobs).not.toMatch(/ollama|OllamaProvider|@flint\/core|\/api\/chat|\/internal\/complete|frontier|anthropic\.com|openai\.com/i);
    expect(jobs).not.toMatch(/child_process|execFile|\bexec\(|\bspawn\(/);
    // One runner, made once, given to runSeries (which gives it to the materialiser for git). No job runs a command itself.
    expect(jobs.match(/makeRun\(/g)).toHaveLength(1);
    expect(jobs).toContain('run: makeRun(ctx.config.home)');
    expect(jobs).not.toMatch(/\brun\(\s*['"`\/]/);
  });

  it('none of them runs a command; the one that needs git is handed a fixed one, and builds no argument from data', () => {
    for (const f of [...predict, ...ledger]) expect(bare(f), f).not.toMatch(/child_process|execFile|\bexec\(|\bspawn\(|makeRun\(/);
    // The materialiser's only uses of the runner it is handed: which branch is main, and the commit count on it, by the
    // clone's path and two instants.
    const metrics = bare('predict/metrics.ts');
    expect(metrics.match(/commitsBetween\(/g)).toHaveLength(1);
    expect(metrics.match(/mainRef\(/g)).toHaveLength(1);
    expect(metrics.match(/d\.run\b/g)).toHaveLength(3);
    expect(metrics).not.toMatch(/d\.run\s*\(|\brun\(\s*['"`\/]/);
    const git = bare('sources/git.ts');
    const main = git.slice(git.indexOf('export async function mainRef'), git.indexOf('export async function commitsBetween'));
    expect(main).toContain(`['-C', path, 'for-each-ref', '--format=%(refname)', ...MAIN_REFS]`);
    const fn = git.slice(git.indexOf('export async function commitsBetween'), git.indexOf('export function gitSource'));
    expect(fn).toContain(`['-C', path, 'rev-list', '--count', '--first-parent', \`--since=\${since.toISOString()}\`, \`--before=\${last.toISOString()}\`, ref]`);
    for (const part of [main, fn]) {
      expect(part.match(/\brun\(/g)).toHaveLength(1);
      expect(part).not.toMatch(/fetch|pull|remote\b|\blog\b|\bshow\b|--all|--branches/);
    }
  });

  it('the arithmetic draws on no clock and no chance: the forecaster, the scoring and the bootstrap give the same answer every time', () => {
    for (const f of ['predict/forecast.ts', 'predict/phrasing.ts', 'ledger/scoring.ts', 'ledger/bootstrap.ts']) {
      expect(bare(f), f).not.toMatch(/Math\.random|Date\.now|new Date\(\)|performance\.now/);
    }
    // And they hold no database: numbers in, numbers out.
    for (const f of ['predict/forecast.ts', 'predict/phrasing.ts', 'ledger/scoring.ts', 'ledger/bootstrap.ts']) expect(bare(f), f).not.toMatch(/@prisma|\.\.\/db\.js|\$queryRaw/);
  });
});
