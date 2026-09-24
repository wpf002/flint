#!/usr/bin/env tsx
/**
 * Flint parity eval. Three steps, one CLI:
 *
 *   build-prompts   freeze a stratified prompt set from the training corpus
 *   run             collect answers (Flint + vendors), judge blind, report
 *   report          re-render a run's report from its cached rows
 *
 * See ../README.md.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { AnthropicProvider, OpenAiProvider, type ProviderAdapter } from '@flint/core';
import { BudgetGuard } from './budget.js';
import {
  FatalError,
  assertLocalModelName,
  claudeContestant,
  competitorSystem,
  flintContestant,
  flintContestantName,
  flintHealth,
  ollamaHasModel,
  openaiContestant,
  perplexityContestant,
  resolveFlintToken,
  type Contestant,
} from './contestants.js';
import { flintIsA, judgePair, outcomeFor } from './judge.js';
import { judgeWithPanel, panelId, parseJudgePanel, verdictFor, type Panelist, type PanelistSpec } from './panel.js';
import { estimateCost, costOf } from './pricing.js';
import { buildPromptSet, takeBalanced, type EvalPrompt, type TrainingRecord } from './prompts.js';
import {
  appendHistory,
  cachedJudgments,
  historyRow,
  judgmentKey,
  latestJudgments,
  renderMarkdown,
  reportFileName,
  summarize,
  type AnswerRow,
  type JudgmentRow,
} from './report.js';
import { loadSecretsInto } from './secrets.js';
import { appendJsonl, pool, readJsonl, writeFileAtomic } from './util.js';

const FLINT_HOME = join(homedir(), '.flint');
const EVAL_DIR = process.env.PARITY_DIR?.trim() || join(FLINT_HOME, 'eval');
const PROMPTS_PATH = join(EVAL_DIR, 'parity_prompts.jsonl');
const HISTORY_PATH = join(EVAL_DIR, 'parity_history.csv');
const CORPUS_PATH = join(FLINT_HOME, 'training', 'corpus.jsonl');

const DEFAULTS = {
  claudeModel: process.env.PARITY_CLAUDE_MODEL?.trim() || 'claude-opus-5',
  openaiModel: process.env.PARITY_OPENAI_MODEL?.trim() || 'gpt-5',
  perplexityModel: process.env.PARITY_PERPLEXITY_MODEL?.trim() || 'sonar-pro',
  judgeModel: process.env.PARITY_JUDGE_MODEL?.trim() || 'claude-opus-5',
  /** Empty = single judge (--judge-model). */
  judgePanel: process.env.PARITY_JUDGE_PANEL?.trim() || '',
  ollamaHost: process.env.OLLAMA_HOST?.trim() || 'http://127.0.0.1:11434',
  flintUrl: process.env.FLINT_URL?.trim() || 'http://127.0.0.1:8080',
  flintFrontierModel: process.env.PARITY_FLINT_PRICE_MODEL?.trim() || 'claude-sonnet-4-6',
};

function log(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'build-prompts') return buildPrompts(rest);
  if (cmd === 'run') return run(rest);
  if (cmd === 'report') return report(rest);
  log('usage: tsx src/cli.ts <build-prompts|run|report> [flags]   (see apps/parity/README.md)');
  process.exitCode = 2;
}

// --------------------------------------------------------------------------
// build-prompts

function buildPrompts(argv: string[]): void {
  const { values } = parseArgs({
    args: argv,
    options: {
      rebuild: { type: 'boolean', default: false },
      seed: { type: 'string', default: '1' },
      max: { type: 'string', default: '300' },
      corpus: { type: 'string', default: CORPUS_PATH },
      out: { type: 'string', default: PROMPTS_PATH },
    },
  });
  const out = resolve(values.out!);
  if (existsSync(out) && !values.rebuild) {
    const n = readJsonl<EvalPrompt>(out).length;
    log(`frozen set already exists: ${out} (${n} prompts). Not touching it — pass --rebuild to replace it.`);
    return;
  }
  const records = readJsonl<TrainingRecord>(values.corpus!);
  if (records.length === 0) throw new Error(`no records in ${values.corpus}`);
  const seed = Number(values.seed);
  const max = Number(values.max);
  const { prompts, stats } = buildPromptSet(records, { seed, max });
  writeFileAtomic(out, prompts.map((p) => JSON.stringify(p)).join('\n') + '\n');
  const meta = {
    builtAt: new Date().toISOString(),
    seed,
    max,
    corpus: values.corpus,
    count: prompts.length,
    organic: prompts.filter((p) => p.source === 'organic').length,
    ...stats,
  };
  writeFileAtomic(out.replace(/\.jsonl$/, '.meta.json'), JSON.stringify(meta, null, 2) + '\n');
  log(`froze ${prompts.length} prompts -> ${out}`);
  log(`  corpus ${stats.corpusRows} rows; dropped ${stats.trivial} trivial, ${stats.duplicates} near-duplicate; ${stats.candidates} candidates`);
  for (const [c, s] of Object.entries(stats.byCategory)) log(`  ${c.padEnd(22)} ${String(s.selected).padStart(4)} of ${s.available}`);
}

// --------------------------------------------------------------------------
// run

function runStamp(d = new Date()): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z').replace('T', '-');
}

async function run(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      limit: { type: 'string' },
      'budget-usd': { type: 'string', default: '10' },
      run: { type: 'string' },
      contestants: { type: 'string', default: 'flint,openai,claude,perplexity' },
      categories: { type: 'string' },
      concurrency: { type: 'string', default: '3' },
      'flint-concurrency': { type: 'string', default: '1' },
      'flint-url': { type: 'string', default: DEFAULTS.flintUrl },
      'flint-timeout-s': { type: 'string', default: '240' },
      'claude-model': { type: 'string', default: DEFAULTS.claudeModel },
      'openai-model': { type: 'string', default: DEFAULTS.openaiModel },
      'perplexity-model': { type: 'string', default: DEFAULTS.perplexityModel },
      'judge-model': { type: 'string', default: DEFAULTS.judgeModel },
      'judge-panel': { type: 'string', default: DEFAULTS.judgePanel },
      'max-tokens': { type: 'string', default: '8192' },
      'judge-max-tokens': { type: 'string', default: '4096' },
      'no-judge': { type: 'boolean', default: false },
      'judge-only': { type: 'boolean', default: false },
      'allow-training-log': { type: 'boolean', default: false },
      'flint-local': { type: 'boolean', default: false },
      'local-model': { type: 'string' },
      seed: { type: 'string', default: '1' },
      prompts: { type: 'string', default: PROMPTS_PATH },
    },
  });

  loadSecretsInto(join(FLINT_HOME, 'secrets.env'));

  const promptsPath = resolve(values.prompts!);
  let prompts = readJsonl<EvalPrompt>(promptsPath);
  if (prompts.length === 0) throw new Error(`no frozen prompt set at ${promptsPath} — run \`pnpm --filter @flint/parity build-prompts\` first`);
  if (values.categories) {
    const want = new Set(values.categories.split(',').map((s) => s.trim()));
    prompts = prompts.filter((p) => want.has(p.category));
  }
  if (values.limit) prompts = takeBalanced(prompts, Number(values.limit));

  const budget = new BudgetGuard(Number(values['budget-usd']));
  const seed = Number(values.seed);
  const maxTokens = Number(values['max-tokens']);
  const now = new Date();
  const system = competitorSystem(now);
  const notes: string[] = [];

  // ---- contestants
  const wanted = new Set(values.contestants!.split(',').map((s) => s.trim()));
  const contestants: Contestant[] = [];
  let flint: Contestant | undefined;
  // ---- judge (validated up front: a missing key should fail before any answer is bought)
  const panelSpecs: PanelistSpec[] | undefined = values['judge-panel'] ? parseJudgePanel(values['judge-panel']) : undefined;
  const judgeModel = panelSpecs ? panelId(panelSpecs) : values['judge-model']!;
  const vendorKey = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY' } as const;
  if (!values['no-judge']) {
    for (const v of panelSpecs ? [...new Set(panelSpecs.map((p) => p.vendor))] : (['anthropic'] as const)) {
      if (!process.env[vendorKey[v]]?.trim()) throw new Error(`the judge needs ${vendorKey[v]} (env or ~/.flint/secrets.env)`);
    }
  }

  const judgeOnly = values['judge-only']!;
  if (judgeOnly && !values.run) throw new Error('--judge-only re-judges an existing run: pass --run <ts>');
  if (judgeOnly && values['no-judge']) throw new Error('--judge-only and --no-judge together do nothing');
  const localModel = values['local-model']?.trim() || undefined;
  if (localModel && !judgeOnly) {
    assertLocalModelName(localModel);
    let has: { ok: boolean; available: string[] };
    try {
      has = await ollamaHasModel(localModel, DEFAULTS.ollamaHost);
    } catch (err) {
      throw new Error(`--local-model: can't list Ollama's models at ${DEFAULTS.ollamaHost} (${err instanceof Error ? err.message : String(err)}); set OLLAMA_HOST if it runs elsewhere`);
    }
    if (!has.ok) {
      throw new Error(
        `--local-model: ${localModel} isn't pulled on ${DEFAULTS.ollamaHost}. Run \`ollama pull ${localModel}\` first. ` +
          `Available: ${has.available.join(', ') || '(none)'}`,
      );
    }
  }

  if (wanted.has('flint')) {
    const url = values['flint-url']!;
    // --judge-only never calls Flint: the server needn't be up, its cached answers are enough.
    const health = judgeOnly ? {} : await flintHealth(url);
    if (!health) throw new Error(`Flint isn't answering at ${url}/health`);
    if (!judgeOnly && health.evalMode !== true && !values['allow-training-log']) {
      throw new Error(
        `the Flint server at ${url} predates eval mode (/health has no evalMode), so every replay would be logged to the training corpus. ` +
          'Deploy the server with eval mode, point --flint-url at one that has it, or pass --allow-training-log.',
      );
    }
    if (!judgeOnly && localModel && health.localModelOverride !== true) {
      throw new Error(`the Flint server at ${url} doesn't support the eval-only local-model override (/health has no localModelOverride, or its local brain isn't Ollama). Deploy this branch first.`);
    }
    const token = judgeOnly
      ? 'unused'
      : resolveFlintToken({
          env: process.env,
          tokenFile: join(FLINT_HOME, 'token'),
          plist: join(homedir(), 'Library', 'LaunchAgents', 'com.flint.server.plist'),
        });
    if (!token) throw new Error('no Flint token: set FLINT_TOKEN (or ~/.flint/token)');
    flint = flintContestant({
      url,
      token,
      frontierModel: DEFAULTS.flintFrontierModel,
      allowTrainingLog: values['allow-training-log']!,
      timeoutMs: Number(values['flint-timeout-s']) * 1000,
      localOnly: values['flint-local']! || localModel !== undefined,
      ...(localModel ? { localModel } : {}),
    });
    contestants.push(flint);
    log(judgeOnly ? `${flint.name}: cached answers only (--judge-only)` : `${flint.name}: ${url} (local brain ${String(health.provider)}:${String(health.model)}, ${String(health.tools)} tools)`);
  }
  const need = (name: string, key: string): string | undefined => {
    if (!wanted.has(name)) return undefined;
    const v = process.env[key]?.trim();
    if (!v) {
      notes.push(`${name} skipped: no ${key} in env or ~/.flint/secrets.env.`);
      log(`${name}: skipped (no ${key})`);
    }
    return v;
  };
  const openaiKey = need('openai', 'OPENAI_API_KEY');
  if (openaiKey) contestants.push(openaiContestant(openaiKey, values['openai-model']!, system, maxTokens));
  const claudeKey = need('claude', 'ANTHROPIC_API_KEY');
  if (claudeKey) contestants.push(claudeContestant(claudeKey, values['claude-model']!, system, maxTokens));
  const pplxKey = need('perplexity', 'PERPLEXITY_API_KEY');
  if (pplxKey) contestants.push(perplexityContestant(pplxKey, values['perplexity-model']!, system, maxTokens));
  if (!flint) throw new Error('parity needs flint in --contestants');
  const competitors = contestants.filter((c) => c !== flint);
  if (competitors.length === 0) throw new Error('no competitor has a key — nothing to compare Flint against');

  // ---- run dir (new, or resumed)
  const runDir = values.run
    ? existsSync(values.run)
      ? resolve(values.run)
      : join(EVAL_DIR, 'runs', values.run)
    : join(EVAL_DIR, 'runs', runStamp(now));
  mkdirSync(runDir, { recursive: true });
  const answersPath = join(runDir, 'answers.jsonl');
  const judgmentsPath = join(runDir, 'judgments.jsonl');
  const runMeta = join(runDir, 'run.json');
  if (!existsSync(runMeta)) {
    writeFileSync(
      runMeta,
      JSON.stringify(
        {
          createdAt: now.toISOString(),
          promptSet: promptsPath,
          promptIds: prompts.map((p) => p.id),
          contestants: contestants.map((c) => ({ name: c.name, model: c.model })),
          judgeModel,
          ...(panelSpecs ? { judgePanel: panelSpecs.map((p) => p.id) } : {}),
          seed,
          competitorSystem: system,
        },
        null,
        2,
      ) + '\n',
    );
  }
  const run = basename(runDir);
  log(`run ${run}: ${prompts.length} prompts × ${contestants.length} contestants, budget $${budget.limitUsd.toFixed(2)} -> ${runDir}`);

  // ---- stop handling
  const ac = new AbortController();
  let stopReason = '';
  const stop = (why: string): void => {
    if (!stopReason) {
      stopReason = why;
      log(`stopping: ${why}`);
    }
  };
  process.once('SIGINT', () => {
    stop('interrupted');
    ac.abort();
  });
  const stopped = (): boolean => stopReason !== '';

  // ---- answers
  const answerKey = (id: string, c: string, m: string): string => `${id}|${c}|${m}`;
  const answers = new Map<string, AnswerRow>();
  for (const a of readJsonl<AnswerRow>(answersPath)) if (a.ok) answers.set(answerKey(a.promptId, a.contestant, a.model), a);

  const failed: AnswerRow[] = [];
  await Promise.all(
    contestants.map((c) => {
      // --judge-only: nothing is (re-)answered; pairs without cached answers are just skipped.
      const todo = judgeOnly ? [] : prompts.filter((p) => !answers.has(answerKey(p.id, c.name, c.model)));
      const limit = c === flint ? Number(values['flint-concurrency']) : Number(values.concurrency);
      return pool(
        todo,
        limit,
        async (p) => {
          const settle = budget.reserve(c.estimate(p));
          if (!settle) return stop(`budget of $${budget.limitUsd.toFixed(2)} reached`);
          const t0 = Date.now();
          try {
            const res = await c.answer(p, ac.signal);
            settle(res.costUsd);
            const row: AnswerRow = {
              promptId: p.id,
              contestant: c.name,
              model: c.model,
              ok: true,
              text: res.text,
              ...(res.usage ? { usage: res.usage } : {}),
              costUsd: res.costUsd,
              ms: Date.now() - t0,
              ...(res.meta ? { meta: res.meta } : {}),
              ts: Date.now(),
            };
            appendJsonl(answersPath, row);
            answers.set(answerKey(p.id, c.name, c.model), row);
            log(`  ✓ ${c.name.padEnd(10)} ${p.id} ${p.category} (${((Date.now() - t0) / 1000).toFixed(1)}s, $${res.costUsd.toFixed(4)})`);
          } catch (err) {
            settle(0);
            if (err instanceof FatalError) {
              stop(err.message);
              ac.abort();
              return;
            }
            const row: AnswerRow = {
              promptId: p.id,
              contestant: c.name,
              model: c.model,
              ok: false,
              error: err instanceof Error ? err.message : String(err),
              costUsd: 0,
              ms: Date.now() - t0,
              ts: Date.now(),
            };
            appendJsonl(answersPath, row);
            failed.push(row);
            log(`  ✗ ${c.name.padEnd(10)} ${p.id} ${row.error?.slice(0, 160)}`);
          }
        },
        stopped,
      );
    }),
  );

  // ---- judge
  const judgments = new Map<string, JudgmentRow>();
  let newJudgments = 0;
  // Verdicts for normal Flint, local-only Flint and each local-model candidate share
  // a run dir; the subject keeps them apart. judgeModel (a model, or a panel id) keeps
  // single-judge and panel verdicts apart.
  const subject = flint.name;
  const keyOf = (promptId: string, comp: Contestant): string =>
    judgmentKey({ promptId, competitor: comp.name, competitorModel: comp.model, judgeModel });
  for (const [k, j] of cachedJudgments(readJsonl<JudgmentRow>(judgmentsPath), judgeModel, subject)) judgments.set(k, j);
  if (!values['no-judge'] && !stopped()) {
    const providerFor = (vendor: 'anthropic' | 'openai'): ProviderAdapter =>
      vendor === 'anthropic'
        ? new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY!.trim() })
        : new OpenAiProvider({ apiKey: process.env.OPENAI_API_KEY!.trim() });
    const panel: Panelist[] | undefined = panelSpecs?.map((p) => ({ ...p, provider: providerFor(p.vendor) }));
    const judgeProvider = panel ? undefined : providerFor('anthropic');
    const pairs: Array<{ p: EvalPrompt; comp: Contestant }> = [];
    for (const p of prompts) {
      const fa = answers.get(answerKey(p.id, flint.name, flint.model));
      if (!fa) continue;
      for (const comp of competitors) {
        if (!answers.get(answerKey(p.id, comp.name, comp.model))) continue;
        if (judgments.has(keyOf(p.id, comp))) continue;
        pairs.push({ p, comp });
      }
    }
    log(`judging ${pairs.length} pair(s) with ${judgeModel}`);
    const judgeMaxTokens = Number(values['judge-max-tokens']);
    await pool(
      pairs,
      Number(values.concurrency),
      async ({ p, comp }) => {
        const fa = answers.get(answerKey(p.id, flint!.name, flint!.model))!;
        const ca = answers.get(answerKey(p.id, comp.name, comp.model))!;
        const aIsFlint = flintIsA(p.id, comp.name, seed);
        const base = {
          subject,
          promptId: p.id,
          category: p.category,
          competitor: comp.name,
          competitorModel: comp.model,
          judgeModel,
          flintIsA: aIsFlint,
        };
        const record = (row: JudgmentRow): void => {
          appendJsonl(judgmentsPath, row);
          if (row.ok) {
            judgments.set(keyOf(p.id, comp), row);
            newJudgments++;
            const split = row.panel && !row.agreed ? ' (split)' : '';
            log(`  ⚖ ${p.id} vs ${comp.name.padEnd(10)} -> ${subject} ${row.outcome}${split}`);
          } else {
            log(`  ✗ judge ${p.id} vs ${comp.name}: ${row.error?.slice(0, 160)}`);
          }
        };

        if (panel) {
          const r = await judgeWithPanel({
            panel,
            reserve: (est) => budget.reserve(est),
            judgeMaxTokens,
            prompt: p,
            competitor: comp.name,
            flintAnswer: fa.text!,
            competitorAnswer: ca.text!,
            seed,
            now,
            signal: ac.signal,
          });
          if (r.kind === 'refused') return stop(`budget of $${budget.limitUsd.toFixed(2)} reached`);
          if (r.kind === 'error') return record({ ...base, ok: false, error: r.error, panel: r.panel, costUsd: r.costUsd, ts: Date.now() });
          return record({
            ...base,
            ok: true,
            verdict: verdictFor(r.outcome, aIsFlint),
            outcome: r.outcome,
            agreed: r.agreed,
            reason: r.panel.map((v) => `[${v.judge}: ${v.outcome}] ${v.reason}`).join(' '),
            panel: r.panel,
            costUsd: r.costUsd,
            ts: Date.now(),
          });
        }

        const [ansA, ansB] = aIsFlint ? [fa.text!, ca.text!] : [ca.text!, fa.text!];
        const est = estimateCost('anthropic', judgeModel, p.prompt.length + ansA.length + ansB.length, {
          overheadTokens: 700,
          expectedOutputTokens: 800,
        });
        const settle = budget.reserve(est);
        if (!settle) return stop(`budget of $${budget.limitUsd.toFixed(2)} reached`);
        try {
          const j = await judgePair({
            provider: judgeProvider!,
            model: judgeModel,
            maxTokens: judgeMaxTokens,
            prompt: p,
            answerA: ansA,
            answerB: ansB,
            now,
            signal: ac.signal,
          });
          const cost = costOf('anthropic', judgeModel, j.usage);
          settle(cost);
          record({ ...base, ok: true, verdict: j.verdict, outcome: outcomeFor(j.verdict, aIsFlint), reason: j.reason, costUsd: cost, ts: Date.now() });
        } catch (err) {
          const usage = (err as { usage?: { input: number; output: number } }).usage;
          const cost = usage ? costOf('anthropic', judgeModel, usage) : 0;
          settle(cost);
          record({ ...base, ok: false, error: err instanceof Error ? err.message : String(err), costUsd: cost, ts: Date.now() });
        }
      },
      stopped,
    );
  }

  // ---- report
  const ids = new Set(prompts.map((p) => p.id));
  const reportName = reportFileName(subject);
  // One row per pair: the latest successful one, else the latest failure.
  const summaries = summarize(latestJudgments(readJsonl<JudgmentRow>(judgmentsPath), judgeModel, subject, ids));
  const answerRows = latestAnswers(readJsonl<AnswerRow>(answersPath).filter((a) => ids.has(a.promptId)));

  if (budget.exhausted) notes.push('The budget guard stopped the run; re-run with the same --run and a fresh --budget-usd to continue where it left off.');
  notes.push(
    `Competitors answer through their raw APIs with no tools (no web search), given the same date/location context Flint gets; Flint answers end to end with its tools. Categories that need live data or Will's systems measure that difference on purpose.`,
  );
  if (panelSpecs) {
    notes.push(
      `Judged by a panel (${panelSpecs.map((p) => p.id).join(', ')}): each panelist judges every pair on its own, with its own A/B order; a win or loss counts only when all agree, and any disagreement is a tie. See "Panel agreement".`,
    );
  } else if (competitors.some((c) => c.model.startsWith('claude')) && judgeModel.startsWith('claude')) {
    notes.push(`The judge (${judgeModel}) is a Claude model and so is a competitor — expect some self-preference in that column.${subject === 'flint' ? " Flint's frontier brain is also Claude." : ''}`);
  }
  const md = renderMarkdown({
    run,
    promptSet: promptsPath,
    promptCount: prompts.length,
    contestants: contestants.map((c) => ({ name: c.name, model: c.model })),
    answers: answerRows,
    summaries,
    spendUsd: budget.spent,
    budgetUsd: budget.limitUsd,
    stoppedForBudget: budget.exhausted,
    notes,
    subject,
  });
  writeFileSync(join(runDir, reportName), md);

  // One row per competitor, cumulative for the run. A resumed run appends a
  // fresh cumulative row (same `run` id) only when it judged something new, so
  // the LAST row per (run, competitor) is that run's result.
  const scored = summaries.filter((s) => s.n > 0);
  const recordHistory = scored.length > 0 && newJudgments > 0;
  if (recordHistory) {
    const ts = new Date().toISOString();
    appendHistory(HISTORY_PATH, scored.map((s) => historyRow(run, basename(promptsPath), s, ts, subject)));
  }

  process.stdout.write(md + '\n');
  log(`spent $${budget.spent.toFixed(4)} this invocation; report -> ${join(runDir, reportName)}`);
  log(recordHistory ? `history -> ${HISTORY_PATH}` : 'nothing new judged; history unchanged');
  if (stopReason && stopReason !== `budget of $${budget.limitUsd.toFixed(2)} reached`) process.exitCode = 1;
}

/** One row per (prompt, contestant, model): the success if there is one, else the latest failure. */
function latestAnswers(rows: readonly AnswerRow[]): AnswerRow[] {
  const m = new Map<string, AnswerRow>();
  for (const r of rows) {
    const k = `${r.promptId}|${r.contestant}|${r.model}`;
    const prev = m.get(k);
    if (!prev || r.ok || !prev.ok) m.set(k, r);
  }
  return [...m.values()];
}

// --------------------------------------------------------------------------
// report

function report(argv: string[]): void {
  const { values } = parseArgs({
    args: argv,
    options: {
      run: { type: 'string' },
      'flint-local': { type: 'boolean', default: false },
      'local-model': { type: 'string' },
      // Which verdicts to render; defaults to the judge the run was created with.
      'judge-model': { type: 'string' },
      'judge-panel': { type: 'string' },
    },
  });
  const localModel = values['local-model']?.trim() || undefined;
  if (localModel) assertLocalModelName(localModel);
  const subject = flintContestantName({ localOnly: values['flint-local'], localModel });
  if (!values.run) throw new Error('--run <dir|name> required');
  const runDir = existsSync(values.run) ? resolve(values.run) : join(EVAL_DIR, 'runs', values.run);
  const meta = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8')) as {
    promptSet: string;
    promptIds: string[];
    contestants: Array<{ name: string; model: string }>;
    judgeModel: string;
  };
  const judgeModel = values['judge-panel'] ? panelId(parseJudgePanel(values['judge-panel'])) : values['judge-model'] ?? meta.judgeModel;
  const ids = new Set(meta.promptIds);
  const rows = readJsonl<JudgmentRow>(join(runDir, 'judgments.jsonl'));
  const answers = latestAnswers(readJsonl<AnswerRow>(join(runDir, 'answers.jsonl')));
  const judgeRows = rows.filter((j) => ids.has(j.promptId) && j.judgeModel === judgeModel && (j.subject ?? 'flint') === subject);
  const spend = answers.reduce((s, a) => s + (a.costUsd || 0), 0) + judgeRows.reduce((s, j) => s + (j.costUsd || 0), 0);
  // run.json lists the contestants the run started with; a later --flint-local /
  // --local-model invocation answered as its own contestant, so add that one.
  const extra = meta.contestants.some((c) => c.name === subject) ? [] : answers.filter((a) => a.contestant === subject).slice(0, 1);
  const contestants = [...extra.map((a) => ({ name: a.contestant, model: a.model })), ...meta.contestants];
  const md = renderMarkdown({
    run: basename(runDir),
    promptSet: meta.promptSet,
    promptCount: meta.promptIds.length,
    contestants,
    answers,
    summaries: summarize(latestJudgments(rows, judgeModel, subject, ids)),
    spendUsd: spend,
    budgetUsd: spend,
    stoppedForBudget: false,
    notes: [`Re-rendered from cached rows (judge: ${judgeModel}); spend shown is the run total across invocations.`],
    subject,
  });
  writeFileSync(join(runDir, reportFileName(subject)), md);
  process.stdout.write(md + '\n');
}

main().catch((err) => {
  log(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
