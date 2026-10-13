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
 * The local model's estimate (part 5) is the one exception, in ONE file:
 * predict/reason.ts reaches loopback Ollama's /api/chat through scopedFetch,
 * after asking model/here.ts whether its model is on this Mac. That file is
 * named here and held to exactly that: no other fetch, no socket, no path to
 * the frontier or to any address but the one it is configured with, no
 * environment read. Every other file stays as it was, and the jobs still add
 * nothing of their own.
 *
 * Part 4's two files are held to the same: the panel's views (which hold a
 * series' numbers in words) and Will's questions reach nothing but the
 * database, and neither writes a log line.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(__dirname, '..', '..', 'src');
const every = readdirSync(join(SRC, 'predict')).filter((f) => f.endsWith('.ts')).map((f) => `predict/${f}`);
/** The one file that asks the local model. */
const REASON = 'predict/reason.ts';
/** Everything else under predict/: no model at all. */
const predict = every.filter((f) => f !== REASON);
const ledger = ['ledger/sweep.ts', 'ledger/scoring.ts', 'ledger/bootstrap.ts', 'ledger/calibration.ts'];
const code = (f: string) => readFileSync(join(SRC, f), 'utf8');
/** The file without its comments: what it does, not what it says about itself. */
const bare = (f: string) => code(f).replace(/\/\*[\s\S]*?\*\/|(^|[^:'"`])\/\/.*$/gm, '$1');
/** The prediction jobs, as jobs.ts runs them: the function that makes their handlers, and nothing else of that file. */
const jobs = (() => {
  const src = bare('jobs.ts');
  const from = src.indexOf('export function predictJobs(');
  return src.slice(from, src.indexOf('export function jobSpecs(', from));
})();

describe('no egress from predictions', () => {
  it('every file is here: the forecaster, the materialiser, the runner, the phrase table, the resolvers, the registry, the card, the panel\'s questions and views, and the one that asks the local model', () => {
    expect(every.sort()).toEqual([
      'predict/enable.ts', 'predict/forecast.ts', 'predict/metrics.ts', 'predict/phrasing.ts', 'predict/questions.ts', 'predict/reason.ts', 'predict/resolvers.ts', 'predict/run.ts', 'predict/series.ts',
      'predict/view.ts',
    ]);
    expect(predict).not.toContain(REASON);
    expect(predict).toHaveLength(every.length - 1);
  });

  it('the local model is asked in one file, and only through the scoped fetch, at Ollama\'s /api/chat, after asking whether the model is on this Mac', () => {
    const src = bare(REASON);
    // Its one way out: a POST to /api/chat at the origin it is configured with. No address is written in it.
    expect(src.match(/scopedFetch\(/g)).toHaveLength(1);
    expect(src).toContain("scopedFetch([{ origin, pathPrefix: '/api/chat', methods: ['POST'] }], d.fetch ?? fetch, d.timeoutMs ?? 90_000)");
    expect(src).toContain('const origin = new URL(d.ollama.url).origin;');
    expect(src).not.toMatch(/https?:\/\/|127\.0\.0\.1|localhost|\[::1\]/);
    // It never calls fetch itself: the provider is given the gated one, and the gate sends through the scoped one.
    expect(src).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource/);
    expect(src.match(/new OllamaProvider\(/g)).toHaveLength(1);
    expect(src).toContain('new OllamaProvider({ baseURL: origin, fetch: gated,');
    expect(src).toContain("import { OllamaProvider } from '@flint/core/ollama';");
    expect(src.match(/@flint\/core/g)).toHaveLength(1);
    // Before anything is built to send with, it asks whether the model runs here; a no ends it.
    const asks = src.indexOf('.runsHere(d.ollama, d.fetch ?? fetch)');
    expect(asks).toBeGreaterThan(0);
    expect(asks).toBeLessThan(src.indexOf('scopedFetch('));
    expect(asks).toBeLessThan(src.indexOf('new OllamaProvider('));
    // No socket, no other client, no path to the frontier or to the server's own model route, no outside name.
    expect(src).not.toMatch(/from 'node:(http|https|http2|net|tls|dgram|dns)'|from '(http|https|net|tls|dgram|undici|node-fetch|axios)'|require\(/);
    expect(src).not.toMatch(/\/internal\/complete|frontier|anthropic|openai|perplexity|tavily|notifyServer|prophet-api|railway\.app/i);
    expect(src).not.toMatch(/process\.env|\bimport\s*\(/);
    expect(src).not.toMatch(/child_process|execFile|\bexec\(|\bspawn\(|makeRun\(/);
    // It writes no value to a log: its two log lines name a series' key and the class of a refusal or of a failure.
    expect(src).not.toMatch(/console\.(log|warn|error|info|debug)|process\.std(out|err)/);
    expect(src.match(/d\.log\?\.\(/g)).toHaveLength(2);
    expect(src).toContain("d.log?.(`forecast: ${key}'s second opinion was not recorded: ${failureOf(err)}`)");
    expect(src).toContain("d.log?.(`forecast: ${key}'s second opinion was not saved: ${failureClass(err)}`)");
    // (Never an error's own words.)
    expect(src).not.toMatch(/err\.message|String\(err\)|\$\{err\}/);
    // The reply's schema has no field that could hold a sentence.
    expect(src).toContain("export const Estimate = z.object({ probability: z.number().finite().min(MIN_PROBABILITY).max(MAX_PROBABILITY), reasonCode: z.enum(ESTIMATE_REASONS) }).strict();");
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
    for (const queue of ['forecast.series', 'forecast.run', 'ledger.sweep', 'ledger.snapshot', 'ledger.ask', 'forecast.reason']) expect(jobs).toContain(`queue: '${queue}'`);
    // The second opinion's job is handed the runtime's settings whole and a run's id: what it may reach is its own file's to say.
    expect(jobs).toContain('await runReason({ db: ctx.db, bus: ctx.bus, config: ctx.config, log: ctx.log }, data.data)');
    expect(jobs).toContain('await sendReasons({ db: ctx.db, bus: ctx.bus })');
    expect(jobs).not.toMatch(/\bfetch\s*\(|scopedFetch|XMLHttpRequest|WebSocket|EventSource|https?:\/\/|process\.env|\bimport\s*\(/);
    expect(jobs).not.toMatch(/ollama|OllamaProvider|@flint\/core|\/api\/chat|\/internal\/complete|frontier|anthropic\.com|openai\.com/i);
    expect(jobs).not.toMatch(/child_process|execFile|\bexec\(|\bspawn\(/);
    // One runner, made once, given to runSeries (which gives it to the materialiser for git). No job runs a command itself.
    expect(jobs.match(/makeRun\(/g)).toHaveLength(1);
    expect(jobs).toContain('run: makeRun(ctx.config.home)');
    expect(jobs).not.toMatch(/\brun\(\s*['"`\/]/);
  });

  it('none of them runs a command; the one that needs git is handed a fixed one, and builds no argument from data', () => {
    for (const f of [...every, ...ledger]) expect(bare(f), f).not.toMatch(/child_process|execFile|\bexec\(|\bspawn\(|makeRun\(/);
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

  it('the panel\'s views and questions write no log line: a forecast\'s numbers and a question\'s words go to the console and nowhere else', () => {
    for (const f of ['predict/view.ts', 'predict/questions.ts', 'routes/predictions.ts']) {
      const src = bare(f);
      expect(src, f).not.toMatch(/console\.(log|warn|error|info|debug)|process\.std(out|err)/);
      expect(src, f).not.toMatch(/notifyServer|notify\.js|deliver|\/internal\/notify/);
    }
    // The views take no logger at all; the questions' job is handed one and says only counts with it (jobs.ts).
    expect(bare('predict/view.ts')).not.toMatch(/\blog\b/);
    // The routes log a refusal by status and field paths, and nothing else.
    expect(bare('routes/predictions.ts').match(/req\.log\./g)).toHaveLength(1);
    expect(bare('routes/predictions.ts')).toContain("req.log.warn({ ref, status: err.status, why: err.why }, 'predictions route refused')");
  });

  it('the arithmetic draws on no clock and no chance: the forecaster, the scoring and the bootstrap give the same answer every time', () => {
    for (const f of ['predict/forecast.ts', 'predict/phrasing.ts', 'ledger/scoring.ts', 'ledger/bootstrap.ts']) {
      expect(bare(f), f).not.toMatch(/Math\.random|Date\.now|new Date\(\)|performance\.now/);
    }
    // And they hold no database: numbers in, numbers out.
    for (const f of ['predict/forecast.ts', 'predict/phrasing.ts', 'ledger/scoring.ts', 'ledger/bootstrap.ts']) expect(bare(f), f).not.toMatch(/@prisma|\.\.\/db\.js|\$queryRaw/);
  });
});
