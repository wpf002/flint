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
import { DailyEvalBudget, dailyLimitFrom } from './daily-budget.js';
import {
  assertLocalModelName,
  claudeContestant,
  competitorSystem,
  flintContestant,
  flintContestantName,
  flintVariantFlag,
  localThinkFlag,
  ollamaHasModel,
  ollamaModelCapabilities,
  openaiContestant,
  perplexityContestant,
  preflightFlint,
  resolveFlintToken,
  type Contestant,
} from './contestants.js';
import { GROUNDED_NOTE, groundedJudgeId } from './grounding.js';
import { chooseGroundedJudge, panelId, parseJudgePanel, type Panelist } from './panel.js';
import { buildPromptSet, takeBalanced, type EvalPrompt, type TrainingRecord } from './prompts.js';
import {
  appendHistory,
  cachedJudgments,
  historyRow,
  judgmentKey,
  latestAnswers,
  latestJudgments,
  renderMarkdown,
  reportFileName,
  rerenderReport,
  summarize,
  type AnswerRow,
  type JudgmentRow,
  type RunMeta,
} from './report.js';
import { loadSecretsInto } from './secrets.js';
import { answerOne, judgeOne, pairsToJudge, type JudgeSetup } from './steps.js';
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
      // The shared daily eval ledger (daily-budget.ts); PARITY_SPEND_LEDGER also sets it.
      'spend-ledger': { type: 'string' },
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
      // No defaults here: a resumed run keeps its own judge (chooseJudge).
      'judge-model': { type: 'string' },
      'judge-panel': { type: 'string' },
      'max-tokens': { type: 'string', default: '8192' },
      'judge-max-tokens': { type: 'string', default: '4096' },
      'no-judge': { type: 'boolean', default: false },
      'judge-only': { type: 'boolean', default: false },
      'allow-training-log': { type: 'boolean', default: false },
      'flint-local': { type: 'boolean', default: false },
      'local-model': { type: 'string' },
      'local-think': { type: 'string' },
      'flint-variant': { type: 'string' },
      'judge-grounding': { type: 'boolean', default: false },
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

  const budgetUsd = Number(values['budget-usd']);
  if (!(budgetUsd > 0)) throw new Error(`--budget-usd must be > 0 (got ${values['budget-usd']})`);
  // Checked now so a bad value fails before anything else; the ledger is opened just before the first paid call.
  const dailyLimitUsd = dailyLimitFrom(process.env);
  const seed = Number(values.seed);
  const maxTokens = Number(values['max-tokens']);
  const now = new Date();
  const system = competitorSystem(now);
  const notes: string[] = [];

  // ---- contestants
  const wanted = new Set(values.contestants!.split(',').map((s) => s.trim()));
  const contestants: Contestant[] = [];
  let flint: Contestant | undefined;
  // ---- run dir (new, or resumed). Resolved before the judge: a resumed run keeps its own.
  const runDir = values.run
    ? existsSync(values.run)
      ? resolve(values.run)
      : join(EVAL_DIR, 'runs', values.run)
    : join(EVAL_DIR, 'runs', runStamp(now));
  const runMeta = join(runDir, 'run.json');
  const resumed = existsSync(runMeta) ? (JSON.parse(readFileSync(runMeta, 'utf8')) as { judgeModel?: string; judgePanel?: string[] }) : undefined;
  // ---- judge (validated up front: a missing key should fail before any answer is bought)
  const judge = chooseGroundedJudge({
    judgeModel: values['judge-model'],
    judgePanel: values['judge-panel'],
    judgeGrounding: values['judge-grounding'],
    resumed,
    defaults: { judgeModel: DEFAULTS.judgeModel, judgePanel: DEFAULTS.judgePanel },
  });
  const panelSpecs = judge.panel;
  // The id verdicts carry (keys, reports, history): `+grounded` when grounded.
  const judgeModel = judge.judgeModel;
  // The model a single judge calls and is priced as (never the `+grounded` id).
  const judgeApiModel = judge.model;
  const grounded = judge.grounded;
  if (judge.from === 'run') log(`judge: ${judgeModel}, the run's own (run.json); pass --judge-model or --judge-panel to use another`);
  if (grounded) log(`judge sees Flint's grounding (recalled memory + tool results): verdicts are kept under ${judgeModel}`);
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
  const localThink = localThinkFlag(values['local-think'], localModel);
  const styleVariant = flintVariantFlag(values['flint-variant']);
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
    // Ollama answers `think: true` on a model that can't think with a 400 on
    // every call, so every prompt would just fail. Refuse up front instead.
    if (localThink === true) {
      const caps = await ollamaModelCapabilities(localModel, DEFAULTS.ollamaHost);
      if (caps && !caps.includes('thinking')) {
        throw new Error(`--local-think on: ${localModel} can't think (Ollama capabilities: ${caps.join(', ') || 'none'}); Ollama would reject every request`);
      }
    }
  }

  if (wanted.has('flint')) {
    const url = values['flint-url']!;
    // --judge-only never calls Flint: the server needn't be up, its cached answers are enough.
    const health = await preflightFlint({ url, judgeOnly, allowTrainingLog: values['allow-training-log']!, localModel, localThink, styleVariant });
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
      ...(localThink !== undefined ? { localThink } : {}),
      ...(styleVariant !== undefined ? { styleVariant } : {}),
      // A grounded judge needs every new answer's grounding; a server without it stops the run.
      requireGrounding: grounded,
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

  // ---- shared daily eval budget: this invocation's --budget-usd is reserved out of
  // PARITY_DAILY_BUDGET_USD (default $25) across every parity invocation today, before
  // any paid call. Less left than asked: capped at what's left. Nearly nothing: refused.
  const daily = new DailyEvalBudget({
    path: resolve(values['spend-ledger'] ?? (process.env.PARITY_SPEND_LEDGER?.trim() || join(EVAL_DIR, 'spend-ledger.jsonl'))),
    dailyLimitUsd,
    timeZone: process.env.FLINT_USER_TZ?.trim() || 'America/Chicago',
  });
  const grant = daily.open(basename(runDir), budgetUsd);
  if (!grant.ok) throw new Error(grant.reason);
  process.once('exit', () => daily.close());
  if (grant.clipped) {
    const why =
      `today's shared eval budget ($${daily.dailyLimitUsd.toFixed(2)}, PARITY_DAILY_BUDGET_USD) had $${grant.grantedUsd.toFixed(2)} left ` +
      `($${grant.spentTodayUsd.toFixed(2)} spent today${grant.heldUsd > 0 ? `, $${grant.heldUsd.toFixed(2)} held by other running evals` : ''}), ` +
      `so this invocation is capped at $${grant.grantedUsd.toFixed(2)} instead of --budget-usd $${budgetUsd.toFixed(2)}`;
    log(why);
    notes.push(`Capped by the shared daily eval budget: ${why}.`);
  }
  const budget = new BudgetGuard(grant.grantedUsd, (usd) => daily.spend(usd));

  // ---- run dir (resolved above)
  mkdirSync(runDir, { recursive: true });
  const answersPath = join(runDir, 'answers.jsonl');
  const judgmentsPath = join(runDir, 'judgments.jsonl');
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

  await Promise.all(
    contestants.map((c) => {
      // --judge-only: nothing is (re-)answered; pairs without cached answers are just skipped.
      const todo = judgeOnly ? [] : prompts.filter((p) => !answers.has(answerKey(p.id, c.name, c.model)));
      const limit = c === flint ? Number(values['flint-concurrency']) : Number(values.concurrency);
      return pool(
        todo,
        limit,
        async (p) => {
          const r = await answerOne({ contestant: c, prompt: p, signal: ac.signal, reserve: (est) => budget.reserve(est) });
          switch (r.kind) {
            case 'refused':
              return stop(`budget of $${budget.limitUsd.toFixed(2)} reached`);
            case 'fatal':
              stop(r.error.message);
              ac.abort();
              return;
            case 'aborted':
              // The run stopped mid-call: not a failure, so not recorded (resuming asks again).
              return log(`  … ${c.name.padEnd(10)} ${p.id} interrupted, not recorded`);
            case 'failed':
              appendJsonl(answersPath, r.row);
              return log(`  ✗ ${c.name.padEnd(10)} ${p.id} ${r.row.error?.slice(0, 160)}`);
            case 'answered':
              appendJsonl(answersPath, r.row);
              answers.set(answerKey(p.id, c.name, c.model), r.row);
              return log(`  ✓ ${c.name.padEnd(10)} ${p.id} ${p.category} (${(r.row.ms / 1000).toFixed(1)}s, $${r.row.costUsd.toFixed(4)})`);
          }
        },
        stopped,
      );
    }),
  );

  // ---- judge
  const judgments = new Map<string, JudgmentRow>();
  let newJudgments = 0;
  // Prompts whose cached Flint answer has no grounding: a grounded judge can't judge them.
  let ungrounded = new Set<string>();
  // Verdicts for normal Flint, local-only Flint and each local-model candidate share
  // a run dir; the subject keeps them apart. judgeModel (a model, or a panel id,
  // `+grounded` or not) keeps single-judge, panel and grounded verdicts apart.
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
    const setup: JudgeSetup = { judgeModel, model: judgeApiModel, grounded, panel, provider: panel ? undefined : providerFor('anthropic') };
    const todo = pairsToJudge({
      prompts,
      flint,
      competitors,
      answer: (promptId, c) => answers.get(answerKey(promptId, c.name, c.model)),
      judged: (promptId, comp) => judgments.has(keyOf(promptId, comp)),
      grounded,
    });
    const pairs = todo.pairs;
    ungrounded = todo.ungrounded;
    if (ungrounded.size) log(`skipping ${ungrounded.size} prompt(s) whose Flint answer has no grounding recorded (answered before the server reported it)`);
    log(`judging ${pairs.length} pair(s) with ${judgeModel}`);
    const judgeMaxTokens = Number(values['judge-max-tokens']);
    await pool(
      pairs,
      Number(values.concurrency),
      async ({ p, comp }) => {
        const r = await judgeOne({
          judge: setup,
          subject,
          prompt: p,
          competitor: comp,
          flintAnswer: answers.get(answerKey(p.id, flint!.name, flint!.model))!,
          competitorAnswer: answers.get(answerKey(p.id, comp.name, comp.model))!,
          seed,
          now,
          signal: ac.signal,
          judgeMaxTokens,
          reserve: (est) => budget.reserve(est),
        });
        if (r.kind === 'refused') return stop(`budget of $${budget.limitUsd.toFixed(2)} reached`);
        const row = r.row;
        appendJsonl(judgmentsPath, row);
        if (row.ok) {
          judgments.set(keyOf(p.id, comp), row);
          newJudgments++;
          const split = row.panel && !row.agreed ? ' (split)' : '';
          log(`  ⚖ ${p.id} vs ${comp.name.padEnd(10)} -> ${subject} ${row.outcome}${split}`);
        } else {
          log(`  ✗ judge ${p.id} vs ${comp.name}: ${row.error?.slice(0, 160)}`);
        }
      },
      stopped,
    );
  }

  // ---- report
  const ids = new Set(prompts.map((p) => p.id));
  const reportName = reportFileName(subject, judgeModel);
  // One row per pair: the latest successful one, else the latest failure.
  const summaries = summarize(latestJudgments(readJsonl<JudgmentRow>(judgmentsPath), judgeModel, subject, ids));
  const answerRows = latestAnswers(readJsonl<AnswerRow>(answersPath).filter((a) => ids.has(a.promptId)));

  if (budget.exhausted) {
    notes.push(
      grant.clipped
        ? "The budget guard stopped the run at the shared daily eval budget; re-run with the same --run tomorrow (or raise PARITY_DAILY_BUDGET_USD) to continue where it left off."
        : 'The budget guard stopped the run; re-run with the same --run and a fresh --budget-usd to continue where it left off.',
    );
  }
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
  if (grounded) notes.push(GROUNDED_NOTE);
  if (ungrounded.size) {
    notes.push(
      `${ungrounded.size} prompt(s) were not judged: their cached Flint answer has no grounding recorded (answered before the server reported it). Answer them again in a new run, or under a --flint-variant name, to judge them grounded.`,
    );
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
    judgeModel,
    promptIds: ids,
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
  daily.close();
  const today = daily.state();
  log(`spent $${budget.spent.toFixed(4)} this invocation ($${today.spentTodayUsd.toFixed(2)} of the $${daily.dailyLimitUsd.toFixed(2)} daily eval budget today); report -> ${join(runDir, reportName)}`);
  log(recordHistory ? `history -> ${HISTORY_PATH}` : 'nothing new judged; history unchanged');
  if (stopReason && stopReason !== `budget of $${budget.limitUsd.toFixed(2)} reached`) process.exitCode = 1;
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
      'local-think': { type: 'string' },
      'flint-variant': { type: 'string' },
      // Which verdicts to render; defaults to the judge the run was created with.
      'judge-model': { type: 'string' },
      'judge-panel': { type: 'string' },
      // ...and the grounded verdicts of that judge (`<judge>+grounded`).
      'judge-grounding': { type: 'boolean', default: false },
    },
  });
  const localModel = values['local-model']?.trim() || undefined;
  if (localModel) assertLocalModelName(localModel);
  const localThink = localThinkFlag(values['local-think'], localModel);
  const styleVariant = flintVariantFlag(values['flint-variant']);
  const subject = flintContestantName({ localOnly: values['flint-local'], localModel, localThink, styleVariant });
  if (!values.run) throw new Error('--run <dir|name> required');
  const runDir = existsSync(values.run) ? resolve(values.run) : join(EVAL_DIR, 'runs', values.run);
  const meta = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8')) as RunMeta;
  const chosen = values['judge-panel'] ? panelId(parseJudgePanel(values['judge-panel'])) : values['judge-model'] ?? meta.judgeModel;
  const judgeModel = values['judge-grounding'] ? groundedJudgeId(chosen) : chosen;
  const md = rerenderReport({
    run: basename(runDir),
    meta,
    answers: readJsonl<AnswerRow>(join(runDir, 'answers.jsonl')),
    judgments: readJsonl<JudgmentRow>(join(runDir, 'judgments.jsonl')),
    subject,
    judgeModel,
  });
  writeFileSync(join(runDir, reportFileName(subject, judgeModel)), md);
  process.stdout.write(md + '\n');
}

main().catch((err) => {
  log(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
