/**
 * The Flint-tasks commands (see ../README.md, "Flint tasks"):
 *
 *   build-tasks    fill the committed templates (discovery on Will's systems,
 *                  fixed public lists) and freeze ~/.flint/eval/flint_tasks.jsonl
 *   tasks          Flint answers end to end; each competitor answers the same
 *                  request with Flint's retrieved data as labelled context; a
 *                  judge (or panel) with that context compares; tool selection
 *                  is scored on its own; report + history
 *   tasks-report   re-render a tasks run's report from its cached rows
 *
 * Nothing here runs on import (cli.ts dispatches), so the step functions are
 * tested directly.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { BudgetGuard } from './budget.js';
import { addVendorContestants, DEFAULT_AMAZON_MODEL, DEFAULT_GOOGLE_MODEL, privacyVendorOf, providerForVendor, VENDOR_KEY_ENV } from './compat.js';
import {
  claudeContestant,
  flintContestant,
  openaiContestant,
  perplexityContestant,
  preflightFlint,
  resolveFlintToken,
  type Contestant,
} from './contestants.js';
import { checkModels, listVendorModels, refusal, type CurrencyVendor, type ModelCheck, type ModelSource } from './model-currency.js';
import { chooseGroundedJudge, type Panelist, type PanelistSpec } from './panel.js';
import { isPriced } from './pricing.js';
import { takeBalanced } from './prompts.js';
import { judgmentKey, latestAnswers, reportFileName, summarize, type AnswerRow, type JudgmentRow } from './report.js';
import { loadSecretsInto } from './secrets.js';
import { answerOne, judgeOne, type AnswerStep, type JudgeSetup, type JudgeStep, type Reserve } from './steps.js';
import { competitorMessage, parseShareLocal, parseSharePersonal, taskContext, vendorAllowed, type Sharing, type TaskContext } from './task-privacy.js';
import { discoverSources, instantiate, rubricFor, unwiredPatterns, validateTaskFile, type SlotValue, type TaskPrompt } from './tasks.js';
import {
  appendTasksHistory,
  computeExclusions,
  currentJudgments,
  flintAnswerModels,
  renderTasksReport,
  tasksHistoryRows,
  tasksSelectionStrict,
  tasksStrict,
} from './tasks-report.js';
import { scoreToolSelection, toolsOf, type ToolSelection } from './tool-selection.js';
import { appendJsonl, pool, readJsonl, writeFileAtomic } from './util.js';

const FLINT_HOME = join(homedir(), '.flint');
const EVAL_DIR = process.env.PARITY_DIR?.trim() || join(FLINT_HOME, 'eval');
export const TASKS_PATH = join(EVAL_DIR, 'flint_tasks.jsonl');
const TASKS_RUNS = join(EVAL_DIR, 'tasks', 'runs');
const TASKS_HISTORY = join(EVAL_DIR, 'flint_tasks_history.csv');
/** The committed templates. */
export const TEMPLATES_PATH = fileURLToPath(new URL('../tasks/flint-tasks.json', import.meta.url));
/** Tool-excerpt length competitors get by default: a 50-row result or an evidence pack fits. */
export const DEFAULT_CONTEXT_CHARS = 16_000;
const SERVER_DEFAULT_EXCERPT = 800;

/**
 * The tasks suite compares Flint with each vendor's CURRENT TOP model: that is
 * what "Flint vs frontier" means. Every built-in default below is checked against
 * the vendor's own model list before a run buys anything (model-currency.ts), and
 * a default that isn't the newest of its family, or can't be checked (Amazon), is
 * refused with the flag to pass instead. The Anthropic default is Claude Fable
 * 5.1, Anthropic's most capable widely released model, and not Claude Opus 5.5:
 * that is the model Flint's own frontier tier runs on, so against it Flint would
 * be compared with his own base model (`--claude-base-model` adds that row as a
 * labelled baseline).
 */
export const TASK_MODEL_DEFAULTS = {
  claude: 'claude-fable-5-1',
  openai: 'gpt-5',
  perplexity: 'sonar-pro',
  google: DEFAULT_GOOGLE_MODEL,
  amazon: DEFAULT_AMAZON_MODEL,
} as const;
type ModelRole = keyof typeof TASK_MODEL_DEFAULTS;

const ROLE_VENDOR: Record<ModelRole | 'claude-base', CurrencyVendor> = {
  claude: 'anthropic',
  'claude-base': 'anthropic',
  openai: 'openai',
  perplexity: 'perplexity',
  google: 'google',
  amazon: 'amazon',
};

const ROLE_ENV: Record<ModelRole | 'claude-base', string> = {
  claude: 'PARITY_CLAUDE_MODEL',
  'claude-base': 'PARITY_CLAUDE_BASE_MODEL',
  openai: 'PARITY_OPENAI_MODEL',
  perplexity: 'PARITY_PERPLEXITY_MODEL',
  google: 'PARITY_GOOGLE_MODEL',
  amazon: 'PARITY_AMAZON_MODEL',
};

const DEFAULTS = {
  flintUrl: process.env.FLINT_URL?.trim() || 'http://127.0.0.1:8080',
  flintFrontierModel: process.env.PARITY_FLINT_PRICE_MODEL?.trim() || 'claude-sonnet-4-6',
};

/**
 * A model id and where it came from: the flag, then the PARITY_*_MODEL env var,
 * then the resumed run's own (so a resumed run keeps its competitors), then the
 * built-in default. Only a `default` has to pass the currency check.
 */
export function resolveModel(opts: { flag?: string | undefined; env?: string | undefined; resumed?: string | undefined; fallback?: string }): { model: string; source: ModelSource } | undefined {
  if (opts.flag?.trim()) return { model: opts.flag.trim(), source: 'flag' };
  if (opts.env?.trim()) return { model: opts.env.trim(), source: 'env' };
  if (opts.resumed?.trim()) return { model: opts.resumed.trim(), source: 'run' };
  return opts.fallback ? { model: opts.fallback, source: 'default' } : undefined;
}

/**
 * The judge panel a new run gets by default: each vendor's top model, i.e. the
 * same Anthropic and OpenAI models the run competes against, never the model
 * Flint answers with.
 */
export function defaultJudgePanel(claude: string, openai: string): string {
  return `anthropic:${claude},openai:${openai}`;
}

function log(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

const flintToken = (): string | undefined =>
  resolveFlintToken({
    env: process.env,
    tokenFile: join(FLINT_HOME, 'token'),
    plist: join(homedir(), 'Library', 'LaunchAgents', 'com.flint.server.plist'),
  });

// --------------------------------------------------------------------------
// build-tasks

/** The Flint server's eval discovery endpoints (apps/server/src/eval-tools.ts). */
export function flintDiscovery(url: string, token: string, fetchFn: typeof fetch = fetch) {
  const base = url.replace(/\/$/, '');
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  return {
    async tools(): Promise<string[]> {
      const r = await fetchFn(`${base}/eval/tools`, { headers, signal: AbortSignal.timeout(10_000) });
      const body = (await r.json().catch(() => ({}))) as { tools?: unknown; error?: string };
      if (!r.ok || !Array.isArray(body.tools)) throw new Error(`GET /eval/tools: HTTP ${r.status} ${body.error ?? ''}`.trim());
      return body.tools.filter((t): t is string => typeof t === 'string');
    },
    async call(tool: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
      const r = await fetchFn(`${base}/eval/tool`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ eval: true, name: tool, args }),
        signal: AbortSignal.timeout(60_000),
      });
      const body = (await r.json().catch(() => ({}))) as { text?: unknown; isError?: unknown; error?: string };
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${body.error ?? 'no body'}`);
      return { text: typeof body.text === 'string' ? body.text : '', isError: body.isError === true };
    },
  };
}

/** `--slots file.json`: `{ "<source>": ["value", { "value": "...", "reference": "..." }] }`. */
export function parseSlotsFile(text: string): Record<string, Array<string | SlotValue>> {
  const raw = JSON.parse(text) as unknown;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('--slots: expected a JSON object of source → values');
  const out: Record<string, Array<string | SlotValue>> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(v) || v.length === 0) throw new Error(`--slots: ${k} must be a non-empty list`);
    out[k] = v.map((x) => {
      if (typeof x === 'string') return x;
      if (x && typeof x === 'object' && (typeof (x as SlotValue).value === 'string' || (x as SlotValue).fields)) return x as SlotValue;
      throw new Error(`--slots: ${k} has a value that is neither a string nor {value|fields}`);
    });
  }
  return out;
}

export async function buildTasks(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      templates: { type: 'string', default: TEMPLATES_PATH },
      out: { type: 'string', default: TASKS_PATH },
      seed: { type: 'string', default: '1' },
      'per-template': { type: 'string', default: '1' },
      rebuild: { type: 'boolean', default: false },
      'no-discover': { type: 'boolean', default: false },
      slots: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      'flint-url': { type: 'string', default: DEFAULTS.flintUrl },
    },
  });
  const out = resolve(values.out!);
  const dryRun = values['dry-run']!;
  if (existsSync(out) && !values.rebuild && !dryRun) {
    log(`task set already exists: ${out} (${readJsonl(out).length} prompts). Not touching it — pass --rebuild to replace it, or --dry-run to preview.`);
    return;
  }
  const file = validateTaskFile(JSON.parse(readFileSync(values.templates!, 'utf8')));
  const overrides = values.slots ? parseSlotsFile(readFileSync(values.slots, 'utf8')) : undefined;
  const seed = Number(values.seed);
  const perTemplate = Number(values['per-template']);
  if (!Number.isInteger(perTemplate) || perTemplate < 1 || perTemplate > 5) throw new Error('--per-template must be 1-5');

  let discovered = {};
  let wired: string[] | undefined;
  if (!values['no-discover']) {
    const url = values['flint-url']!;
    await preflightFlint({ url, judgeOnly: false, allowTrainingLog: false, discovery: true });
    const token = flintToken();
    if (!token) throw new Error('no Flint token: set FLINT_TOKEN (or ~/.flint/token)');
    const d = flintDiscovery(url, token);
    wired = await d.tools();
    log(`discovery on ${url}: ${wired.length} wired tools`);
    discovered = await discoverSources(file, d.call);
    for (const [name, o] of Object.entries(discovered) as Array<[string, { values?: string[]; error?: string }]>) {
      log(o.error ? `  ✗ ${name}: ${o.error}` : `  ✓ ${name}: ${o.values!.length} value(s)`);
    }
  } else {
    log('discovery off (--no-discover): templates whose slots need it are skipped unless --slots fills them');
  }

  const res = instantiate(file, { seed, perTemplate, discovered, ...(overrides ? { overrides } : {}) });
  const unwired = wired ? unwiredPatterns(file, wired) : [];
  const count = (key: 'system' | 'privacy'): Record<string, number> =>
    res.prompts.reduce<Record<string, number>>((m, p) => ({ ...m, [p[key]]: (m[p[key]] ?? 0) + 1 }), {});
  const meta = {
    builtAt: new Date().toISOString(),
    templatesFile: values.templates,
    templates: file.templates.length,
    seed,
    perTemplate,
    count: res.prompts.length,
    bySystem: count('system'),
    byPrivacy: count('privacy'),
    discovery: values['no-discover'] ? 'off' : 'on',
    slotOverrides: Object.keys(overrides ?? {}),
    sourceSizes: res.sourceSizes,
    skipped: res.skipped,
    // Expected tools the server doesn't have: a renamed tool would score every call as a miss.
    unwiredPatterns: unwired,
  };
  for (const s of res.skipped) log(`  skipped ${s.templateId}: ${s.reason}`);
  if (unwired.length) log(`  expected tools the server doesn't wire (tool selection will count them as misses): ${unwired.join(', ')}`);
  if (dryRun) {
    for (const p of res.prompts) process.stdout.write(`${p.id}\t${p.category}\t${p.privacy}\t${p.prompt.replace(/\n/g, ' ⏎ ').slice(0, 160)}\n`);
    log(`dry run: ${res.prompts.length} prompts from ${file.templates.length} templates (${res.skipped.length} skipped); nothing written`);
    return;
  }
  writeFileAtomic(out, res.prompts.map((p) => JSON.stringify(p)).join('\n') + '\n');
  writeFileAtomic(out.replace(/\.jsonl$/, '.meta.json'), JSON.stringify(meta, null, 2) + '\n');
  log(`froze ${res.prompts.length} task prompts -> ${out}`);
  for (const [sys, n] of Object.entries(meta.bySystem).sort()) log(`  ${sys.padEnd(14)} ${String(n).padStart(3)}`);
}

// --------------------------------------------------------------------------
// the steps of `tasks` (tested directly)

/** The answer-cache key, as parity's: prompt, contestant, model. */
export const answerKey = (promptId: string, c: { name: string; model: string }): string => `${promptId}|${c.name}|${c.model}`;

/**
 * Each answered prompt's context, from Flint's answer: the excerpt limit it was
 * asked with (else the server default), and the time it answered (the clock the
 * competitor is given).
 */
export function contextsFor(prompts: readonly TaskPrompt[], flintAnswer: (promptId: string) => AnswerRow | undefined): Map<string, TaskContext> {
  const out = new Map<string, TaskContext>();
  for (const p of prompts) {
    const fa = flintAnswer(p.id);
    if (!fa?.ok || !fa.grounding) continue;
    const limit = typeof fa.meta?.groundingChars === 'number' ? fa.meta.groundingChars : SERVER_DEFAULT_EXCERPT;
    out.set(p.id, taskContext(p, fa.grounding, limit, new Date(fa.ts)));
  }
  return out;
}

/**
 * Whether Flint's cached answer must be redone before the head-to-head: on a task
 * whose point isn't memory it read recalled memory (an answer from before `recall:
 * false`), which the competitors won't get. Only when the server can skip memory.
 */
export function flintAnswerStale(p: Pick<TaskPrompt, 'memory'>, a: AnswerRow | undefined, withholdMemory: boolean): boolean {
  return withholdMemory && p.memory !== 'task' && (a?.grounding?.memory.length ?? 0) > 0;
}

/**
 * The competitor answers still to buy: every (prompt, competitor) where Flint
 * answered, the task is compared (not Flint-only), the vendor may see the
 * prompt's class, and there is no cached answer on this exact context. Excluded
 * pairs are reported, not asked.
 */
export function competitorWork<C extends { name: string; model: string }>(opts: {
  prompts: readonly TaskPrompt[];
  competitors: readonly C[];
  contexts: ReadonlyMap<string, TaskContext>;
  sharing: Sharing;
  cached: (promptId: string, comp: C) => AnswerRow | undefined;
}): Array<{ p: TaskPrompt; comp: C; ctx: TaskContext }> {
  const work: Array<{ p: TaskPrompt; comp: C; ctx: TaskContext }> = [];
  for (const comp of opts.competitors) {
    for (const p of opts.prompts) {
      const ctx = opts.contexts.get(p.id);
      if (!ctx || ctx.notCompared) continue;
      if (!vendorAllowed(privacyVendorOf(comp.name), ctx.privacy, opts.sharing)) continue;
      if (opts.cached(p.id, comp)?.meta?.contextSha === ctx.sha) continue;
      work.push({ p, comp, ctx });
    }
  }
  return work;
}

/**
 * Ask a competitor the task with Flint's data as labelled context (the request
 * becomes competitorMessage), told the time Flint answered (ctx.system), so its
 * "today" is the day the data is from, however much later it is asked. The row
 * records the context's hash (data and clock), so a later change of either
 * re-asks instead of judging a stale answer.
 */
export async function answerWithContext(opts: {
  contestant: Contestant;
  prompt: TaskPrompt;
  ctx: TaskContext;
  signal: AbortSignal;
  reserve: Reserve;
}): Promise<AnswerStep> {
  const { prompt: p, ctx } = opts;
  const r = await answerOne({ contestant: opts.contestant, prompt: { id: p.id, prompt: competitorMessage(p.prompt, ctx), system: ctx.system }, signal: opts.signal, reserve: opts.reserve });
  if (r.kind === 'answered' || r.kind === 'failed') {
    r.row.meta = { ...(r.row.meta ?? {}), contextSha: ctx.sha, privacy: ctx.privacy };
  }
  return r;
}

/** Pairs to judge: a compared task, both answered, the competitor on the current context, no current verdict. */
export function taskPairs<C extends { name: string; model: string }>(opts: {
  prompts: readonly TaskPrompt[];
  competitors: readonly C[];
  contexts: ReadonlyMap<string, TaskContext>;
  flintAnswer: (promptId: string) => AnswerRow | undefined;
  answer: (promptId: string, comp: C) => AnswerRow | undefined;
  judged: (promptId: string, comp: C, contextSha: string) => boolean;
}): Array<{ p: TaskPrompt; comp: C; ctx: TaskContext }> {
  const out: Array<{ p: TaskPrompt; comp: C; ctx: TaskContext }> = [];
  for (const p of opts.prompts) {
    const ctx = opts.contexts.get(p.id);
    if (!ctx || ctx.notCompared || !opts.flintAnswer(p.id)?.ok) continue;
    for (const comp of opts.competitors) {
      const ca = opts.answer(p.id, comp);
      if (!ca?.ok || ca.meta?.contextSha !== ctx.sha) continue;
      if (opts.judged(p.id, comp, ctx.sha)) continue;
      out.push({ p, comp, ctx });
    }
  }
  return out;
}

/**
 * The judge for one pair: the run's judge, minus panelists whose vendor may not
 * see this prompt. Undefined when nobody may (a single non-allowlisted judge, or
 * a panel left empty).
 */
export function judgeFor(setup: JudgeSetup, ctx: Pick<TaskContext, 'privacy'>, sharing: Sharing): { setup?: JudgeSetup; excluded: string[] } {
  if (!setup.panel) return vendorAllowed('anthropic', ctx.privacy, sharing) ? { setup, excluded: [] } : { excluded: ['anthropic'] };
  const allowed = setup.panel.filter((p) => vendorAllowed(p.vendor, ctx.privacy, sharing));
  const excluded = setup.panel.filter((p) => !allowed.includes(p)).map((p) => p.id);
  return allowed.length ? { setup: { ...setup, panel: allowed }, excluded } : { excluded };
}

/**
 * Judge one task pair: the judge sees the shared context (sharedGroundingBlock),
 * the task's rubric (with any reference), and the two answers in random order.
 * Its "date of this evaluation" is when Flint answered, like the reference and
 * the competitor's clock: every side of a pair works from the same day. The
 * verdict carries the context hash.
 */
export async function judgeTask(opts: {
  judge: JudgeSetup;
  subject: string;
  prompt: TaskPrompt;
  competitor: { name: string; model: string };
  flintAnswer: AnswerRow;
  competitorAnswer: AnswerRow;
  ctx: TaskContext;
  sharing: Sharing;
  seed: number;
  signal: AbortSignal;
  judgeMaxTokens: number;
  reserve: Reserve;
}): Promise<JudgeStep | { kind: 'unjudgeable'; excluded: string[] }> {
  const { setup, excluded } = judgeFor(opts.judge, opts.ctx, opts.sharing);
  if (!setup) return { kind: 'unjudgeable', excluded };
  const answeredAt = new Date(opts.flintAnswer.ts);
  const r = await judgeOne({
    judge: setup,
    subject: opts.subject,
    prompt: opts.prompt,
    competitor: opts.competitor,
    flintAnswer: opts.flintAnswer,
    competitorAnswer: opts.competitorAnswer,
    seed: opts.seed,
    now: answeredAt,
    signal: opts.signal,
    judgeMaxTokens: opts.judgeMaxTokens,
    reserve: opts.reserve,
    sharedGrounding: opts.ctx.grounding,
    extras: { shared: true, rubric: rubricFor(opts.prompt, answeredAt) },
  });
  if (r.kind !== 'judged') return r;
  return { kind: 'judged', row: { ...r.row, contextSha: opts.ctx.sha, privacy: opts.ctx.privacy, ...(excluded.length ? { excludedJudges: excluded } : {}) } };
}

/** Flint's tool selection on every task it answered. */
export function selectionFor(prompts: readonly TaskPrompt[], flintAnswer: (promptId: string) => AnswerRow | undefined): ToolSelection[] {
  const out: ToolSelection[] = [];
  for (const p of prompts) {
    const fa = flintAnswer(p.id);
    if (!fa?.ok) continue;
    const { called, proposed } = toolsOf(fa);
    out.push(scoreToolSelection(p, called, proposed, typeof fa.meta?.brain === 'string' ? fa.meta.brain : undefined));
  }
  return out;
}

// --------------------------------------------------------------------------
// tasks

interface TasksRunMeta {
  suite: 'flint-tasks';
  createdAt: string;
  taskSet: string;
  promptIds: string[];
  contestants: Array<{ name: string; model: string }>;
  judgeModel: string;
  judgePanel?: string[];
  seed: number;
  sharePersonalWith: string[];
  /** The vendors that may see "stay local" prompts (`--share-local-with`); absent or empty: nobody. */
  shareLocalWith?: string[];
  /** null: competitors got the server's 800-character excerpts (--allow-short-context). */
  contextChars: number | null;
  /** Each competitor's and judge's model against its vendor's model list, from the latest invocation that checked. */
  modelChecks?: ModelCheck[];
}

function runStamp(d = new Date()): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z').replace('T', '-');
}

function parseContextChars(v: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < SERVER_DEFAULT_EXCERPT || n > 32_000) throw new Error(`--context-chars must be an integer from ${SERVER_DEFAULT_EXCERPT} to 32000`);
  return n;
}

/** The models a run's judge stands for, as (vendor, model) pairs: each panelist, or the single (Anthropic) judge. */
function judgeEntries(judge: { panel?: PanelistSpec[]; model: string }): Array<{ vendor: CurrencyVendor; model: string }> {
  return judge.panel ? judge.panel.map((p) => ({ vendor: p.vendor, model: p.model })) : [{ vendor: 'anthropic', model: judge.model }];
}

export async function runTasks(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      tasks: { type: 'string', default: TASKS_PATH },
      run: { type: 'string' },
      limit: { type: 'string' },
      systems: { type: 'string' },
      'budget-usd': { type: 'string', default: '10' },
      contestants: { type: 'string', default: 'flint,openai,claude,perplexity,google,amazon' },
      concurrency: { type: 'string', default: '3' },
      'flint-concurrency': { type: 'string', default: '1' },
      'flint-url': { type: 'string', default: DEFAULTS.flintUrl },
      'flint-timeout-s': { type: 'string', default: '300' },
      'claude-model': { type: 'string' },
      'claude-base-model': { type: 'string' },
      'openai-model': { type: 'string' },
      'perplexity-model': { type: 'string' },
      'google-model': { type: 'string' },
      'amazon-model': { type: 'string' },
      'openai-compatible': { type: 'string', multiple: true },
      'judge-model': { type: 'string' },
      'judge-panel': { type: 'string' },
      'max-tokens': { type: 'string', default: '8192' },
      'judge-max-tokens': { type: 'string', default: '4096' },
      'no-judge': { type: 'boolean', default: false },
      'judge-only': { type: 'boolean', default: false },
      'allow-training-log': { type: 'boolean', default: false },
      'share-personal-with': { type: 'string' },
      'share-local-with': { type: 'string' },
      'context-chars': { type: 'string' },
      'allow-short-context': { type: 'boolean', default: false },
      seed: { type: 'string', default: '1' },
    },
  });
  loadSecretsInto(join(FLINT_HOME, 'secrets.env'));
  const now = new Date();
  const runDir = values.run ? (existsSync(values.run) ? resolve(values.run) : join(TASKS_RUNS, values.run)) : join(TASKS_RUNS, runStamp(now));
  const runMetaPath = join(runDir, 'run.json');
  const snapshotPath = join(runDir, 'tasks.jsonl');
  const resumed = existsSync(runMetaPath) ? (JSON.parse(readFileSync(runMetaPath, 'utf8')) as TasksRunMeta) : undefined;
  if (resumed && resumed.suite !== 'flint-tasks') throw new Error(`${runDir} is not a Flint-tasks run`);

  // A resumed run keeps its own prompts (the snapshot), so a rebuilt task set can't change it.
  const taskSet = resumed?.taskSet ?? resolve(values.tasks!);
  let prompts = readJsonl<TaskPrompt>(resumed && existsSync(snapshotPath) ? snapshotPath : taskSet);
  if (prompts.length === 0) throw new Error(`no task set at ${taskSet} — run \`pnpm --filter @flint/parity build-tasks\` first`);
  if (values.systems) {
    const want = new Set(values.systems.split(',').map((s) => s.trim()));
    prompts = prompts.filter((p) => want.has(p.system));
  }
  if (values.limit) prompts = takeBalanced(prompts, Number(values.limit));
  const ids = new Set(prompts.map((p) => p.id));

  const budget = new BudgetGuard(Number(values['budget-usd']));
  const seed = Number(values.seed);
  const maxTokens = Number(values['max-tokens']);
  // A competitor's system prompt is per prompt, from when Flint answered it (TaskContext.system);
  // this one only sizes the budget estimate before a context exists.
  const system = 'You are a helpful assistant for Will.';
  const notes: string[] = [];
  const judgeOnly = values['judge-only']!;
  if (judgeOnly && !values.run) throw new Error('--judge-only re-judges an existing run: pass --run <ts>');
  const wanted = new Set(values.contestants!.split(',').map((s) => s.trim()));
  if (!wanted.has('flint')) throw new Error('tasks needs flint in --contestants');

  // ---- models: each vendor's current top model, never an unverified default
  const resumedModel = (name: string): string | undefined => [...(resumed?.contestants ?? [])].reverse().find((c) => c.name === name)?.model;
  const flagOf: Record<ModelRole | 'claude-base', string | undefined> = {
    claude: values['claude-model'],
    'claude-base': values['claude-base-model'],
    openai: values['openai-model'],
    perplexity: values['perplexity-model'],
    google: values['google-model'],
    amazon: values['amazon-model'],
  };
  const models = Object.fromEntries(
    (Object.keys(TASK_MODEL_DEFAULTS) as ModelRole[]).map((role) => [
      role,
      resolveModel({ flag: flagOf[role], env: process.env[ROLE_ENV[role]], resumed: resumedModel(role), fallback: TASK_MODEL_DEFAULTS[role] })!,
    ]),
  ) as Record<ModelRole, { model: string; source: ModelSource }>;
  const claudeBase = resolveModel({ flag: flagOf['claude-base'], env: process.env[ROLE_ENV['claude-base']], resumed: resumedModel('claude-base') });

  // The judge always sees the shared context: it is how it tells grounded facts from inventions.
  // A new run's default panel is the vendors' top models (the ones competed against), never Flint's own.
  const envPanel = process.env.PARITY_JUDGE_PANEL?.trim();
  const envJudge = process.env.PARITY_JUDGE_MODEL?.trim();
  const judge = chooseGroundedJudge({
    judgeModel: values['judge-model'],
    judgePanel: values['judge-panel'],
    judgeGrounding: true,
    resumed,
    defaults: { judgeModel: envJudge || models.claude.model, judgePanel: envPanel || (envJudge ? '' : defaultJudgePanel(models.claude.model, models.openai.model)) },
  });
  const judgeVendors = judge.panel ? judge.panel.map((p) => p.vendor) : (['anthropic'] as const);
  if (!values['no-judge']) {
    for (const v of new Set(judgeVendors)) if (!process.env[VENDOR_KEY_ENV[v]]?.trim()) throw new Error(`the judge needs ${VENDOR_KEY_ENV[v]} (env or ~/.flint/secrets.env)`);
  }
  const sharing: Sharing = {
    personal: values['share-personal-with'] !== undefined ? parseSharePersonal(values['share-personal-with']) : (resumed?.sharePersonalWith ?? parseSharePersonal(undefined)),
    local: values['share-local-with'] !== undefined ? parseShareLocal(values['share-local-with']) : (resumed?.shareLocalWith ?? parseShareLocal(undefined)),
  };
  const contextChars: number | undefined = values['allow-short-context']
    ? undefined
    : values['context-chars'] !== undefined
      ? parseContextChars(values['context-chars'])
      : resumed
        ? (resumed.contextChars ?? undefined)
        : DEFAULT_CONTEXT_CHARS;
  log(
    `personal prompts shared with: ${sharing.personal.join(', ')}; stay-local prompts shared with: ${sharing.local.length ? sharing.local.join(', ') : 'nobody'}; competitor context: ${contextChars ? `${contextChars} chars per tool result` : 'SHORT (800 chars)'}`,
  );

  // Before anything is bought: is every competitor and judge the vendor's current top model? (Free calls.)
  let modelChecks: ModelCheck[] = resumed?.modelChecks ?? [];
  if (!judgeOnly) {
    const entries: Array<{ role: string; vendor: CurrencyVendor; model: string; source: ModelSource }> = [];
    for (const role of Object.keys(TASK_MODEL_DEFAULTS) as ModelRole[]) {
      const vendor = ROLE_VENDOR[role];
      if (wanted.has(role) && process.env[VENDOR_KEY_ENV[vendor]]?.trim()) entries.push({ role, vendor, ...models[role] });
    }
    if (claudeBase && process.env[VENDOR_KEY_ENV.anthropic]?.trim()) entries.push({ role: 'claude-base', vendor: 'anthropic', ...claudeBase });
    if (!values['no-judge']) {
      // A default panel's members are the competitor models, and inherit their source.
      const fromDefault = judge.from === 'default' && !envPanel && !envJudge;
      const explicit: ModelSource = judge.from === 'run' ? 'run' : judge.from === 'default' ? 'env' : 'flag';
      for (const j of judgeEntries(judge)) {
        const same = (Object.keys(TASK_MODEL_DEFAULTS) as ModelRole[]).find((r) => ROLE_VENDOR[r] === j.vendor && models[r].model === j.model);
        entries.push({ role: `judge:${j.vendor}`, vendor: j.vendor, model: j.model, source: fromDefault && same ? models[same].source : explicit });
      }
    }
    modelChecks = await checkModels(entries, (v) => listVendorModels(v, process.env), now);
    const refused = modelChecks.map(refusal).filter((m): m is string => !!m);
    if (refused.length) {
      throw new Error(`not running against models that may not be each vendor's current top model:\n- ${refused.join('\n- ')}`);
    }
    for (const c of modelChecks) {
      if (c.status === 'newer-available') notes.push(`${c.role}: ${c.model} was set explicitly, but ${c.vendor}'s model list also has ${c.newer.slice(0, 5).join(', ')}.`);
      if (c.status === 'not-listed') notes.push(`${c.role}: ${c.model} isn't on ${c.vendor}'s model list.`);
      if (c.status === 'unverified') notes.push(`${c.role}: ${c.model} was set explicitly and couldn't be checked (${c.why}).`);
      if (!isPriced(c.model)) notes.push(`${c.role}: ${c.model} has no price in src/pricing.ts, so its spend is estimated at the pessimistic UNLISTED rate (an upper bound).`);
      log(`model ${c.role}: ${c.model} — ${c.status}${c.newer.length ? ` (newer: ${c.newer.slice(0, 3).join(', ')})` : ''}`);
    }
  }

  // ---- contestants
  const url = values['flint-url']!;
  // Flint answers tasks that aren't about memory WITHOUT memory (`recall: false`), since
  // that is the data the competitors get. An older server (--allow-short-context) may
  // not honour it; then tasks where it recalled something are not compared.
  const health = await preflightFlint({ url, judgeOnly, allowTrainingLog: values['allow-training-log']!, groundingChars: contextChars, recallOverride: !values['allow-short-context'] });
  const withholdMemory = !values['allow-short-context'] || health.evalRecallOverride === true;
  const noRecall = new Set(prompts.filter((p) => p.memory !== 'task').map((p) => p.id));
  const token = judgeOnly ? 'unused' : flintToken();
  if (!token) throw new Error('no Flint token: set FLINT_TOKEN (or ~/.flint/token)');
  const flint = flintContestant({
    url,
    token,
    frontierModel: DEFAULTS.flintFrontierModel,
    allowTrainingLog: values['allow-training-log']!,
    timeoutMs: Number(values['flint-timeout-s']) * 1000,
    requireGrounding: true,
    ...(contextChars !== undefined ? { groundingChars: contextChars } : {}),
    ...(withholdMemory ? { withholdMemory: (p) => noRecall.has(p.id) } : {}),
  });
  if (!withholdMemory) notes.push('The Flint server predates `recall: false`, so Flint read long-term memory on every task; tasks where it recalled something the competitors were not given are not compared.');
  const competitors: Contestant[] = [];
  const need = (name: string, key: string): string | undefined => {
    if (!wanted.has(name)) return undefined;
    const v = process.env[key]?.trim();
    if (!v) {
      notes.push(`${name} skipped: no ${key} in env or ~/.flint/secrets.env.`);
      log(`${name}: skipped (no ${key})`);
    }
    return v;
  };
  const openaiKey = need('openai', VENDOR_KEY_ENV.openai);
  if (openaiKey) competitors.push(openaiContestant(openaiKey, models.openai.model, system, maxTokens));
  const claudeKey = need('claude', VENDOR_KEY_ENV.anthropic);
  if (claudeKey) competitors.push(claudeContestant(claudeKey, models.claude.model, system, maxTokens));
  const anthropicKey = process.env[VENDOR_KEY_ENV.anthropic]?.trim();
  if (claudeBase && anthropicKey) competitors.push(claudeContestant(anthropicKey, claudeBase.model, system, maxTokens, 'claude-base'));
  const pplxKey = need('perplexity', VENDOR_KEY_ENV.perplexity);
  if (pplxKey) competitors.push(perplexityContestant(pplxKey, models.perplexity.model, system, maxTokens));
  competitors.push(
    ...(await addVendorContestants({
      wanted,
      env: process.env,
      system,
      maxTokens,
      googleModel: models.google.model,
      amazonModel: models.amazon.model,
      compatSpecs: values['openai-compatible'] ?? [],
      notes,
      log,
      verifyModels: !judgeOnly,
    })),
  );
  if (competitors.length === 0) throw new Error('no competitor has a key — nothing to compare Flint against');

  // ---- run dir
  mkdirSync(runDir, { recursive: true });
  if (!existsSync(snapshotPath)) writeFileAtomic(snapshotPath, prompts.map((p) => JSON.stringify(p)).join('\n') + '\n');
  const all = [flint, ...competitors].map((c) => ({ name: c.name, model: c.model }));
  const meta: TasksRunMeta = {
    suite: 'flint-tasks',
    createdAt: resumed?.createdAt ?? now.toISOString(),
    taskSet,
    promptIds: [...new Set([...(resumed?.promptIds ?? []), ...prompts.map((p) => p.id)])],
    contestants: [...(resumed?.contestants ?? []).filter((c) => !all.some((a) => a.name === c.name && a.model === c.model)), ...all],
    judgeModel: judge.judgeModel,
    ...(judge.panel ? { judgePanel: judge.panel.map((p) => p.id) } : {}),
    seed,
    sharePersonalWith: [...sharing.personal],
    shareLocalWith: [...sharing.local],
    contextChars: contextChars ?? null,
    modelChecks,
  };
  writeFileSync(runMetaPath, JSON.stringify(meta, null, 2) + '\n');
  const answersPath = join(runDir, 'answers.jsonl');
  const judgmentsPath = join(runDir, 'judgments.jsonl');
  const run = basename(runDir);
  log(`tasks run ${run}: ${prompts.length} prompts × ${1 + competitors.length} contestants, budget $${budget.limitUsd.toFixed(2)} -> ${runDir}`);

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
  const budgetStop = `budget of $${budget.limitUsd.toFixed(2)} reached`;
  const record = (c: Contestant, p: TaskPrompt, r: AnswerStep, answers: Map<string, AnswerRow>): void => {
    switch (r.kind) {
      case 'refused':
        return stop(budgetStop);
      case 'fatal':
        stop(r.error.message);
        ac.abort();
        return;
      case 'aborted':
        return log(`  … ${c.name.padEnd(10)} ${p.id} interrupted, not recorded`);
      case 'failed':
        appendJsonl(answersPath, r.row);
        return log(`  ✗ ${c.name.padEnd(10)} ${p.id} ${r.row.error?.slice(0, 160)}`);
      case 'answered':
        appendJsonl(answersPath, r.row);
        answers.set(answerKey(p.id, c), r.row);
        return log(`  ✓ ${c.name.padEnd(10)} ${p.id} (${(r.row.ms / 1000).toFixed(1)}s, $${r.row.costUsd.toFixed(4)})`);
    }
  };

  // ---- 1. Flint answers, end to end (again, where a cached answer read memory the competitors won't get)
  const answers = new Map<string, AnswerRow>();
  for (const a of readJsonl<AnswerRow>(answersPath)) if (a.ok) answers.set(answerKey(a.promptId, { name: a.contestant, model: a.model }), a);
  const flintAnswer = (id: string): AnswerRow | undefined => answers.get(answerKey(id, flint));
  if (!judgeOnly) {
    const todo = prompts.filter((p) => !flintAnswer(p.id) || flintAnswerStale(p, flintAnswer(p.id), withholdMemory));
    await pool(todo, Number(values['flint-concurrency']), async (p) => record(flint, p, await answerOne({ contestant: flint, prompt: p, signal: ac.signal, reserve: (e) => budget.reserve(e) }), answers), stopped);
  }

  // ---- 2. Each competitor: the same request, with Flint's data as context and Flint's clock
  let contexts = contextsFor(prompts, flintAnswer);
  if (!judgeOnly && !stopped()) {
    const work = competitorWork({ prompts, competitors, contexts, sharing, cached: (id, c) => answers.get(answerKey(id, c)) });
    log(`competitors: ${work.length} answer(s) to buy`);
    await pool(
      work,
      Number(values.concurrency),
      async ({ p, comp, ctx }) => record(comp, p, await answerWithContext({ contestant: comp, prompt: p, ctx, signal: ac.signal, reserve: (e) => budget.reserve(e) }), answers),
      stopped,
    );
  }
  contexts = contextsFor(prompts, flintAnswer);

  // ---- 3. Judge
  const subject = flint.name;
  const judgeModel = judge.judgeModel;
  let newJudgments = 0;
  if (!values['no-judge'] && !stopped()) {
    const current = currentJudgments(readJsonl<JudgmentRow>(judgmentsPath), judgeModel, subject, contexts, ids).filter((j) => j.ok);
    const done = new Set(current.map((j) => `${judgmentKey(j)}|${j.contextSha}`));
    const panel: Panelist[] | undefined = judge.panel?.map((p) => ({ ...p, provider: providerForVendor(p.vendor) }));
    const setup: JudgeSetup = { judgeModel, model: judge.model, grounded: true, panel, provider: panel ? undefined : providerForVendor('anthropic') };
    const pairs = taskPairs({
      prompts,
      competitors,
      contexts,
      flintAnswer,
      answer: (id, c) => answers.get(answerKey(id, c)),
      judged: (id, c, sha) => done.has(`${judgmentKey({ promptId: id, competitor: c.name, competitorModel: c.model, judgeModel })}|${sha}`),
    });
    log(`judging ${pairs.length} pair(s) with ${judgeModel}`);
    await pool(
      pairs,
      Number(values.concurrency),
      async ({ p, comp, ctx }) => {
        const r = await judgeTask({
          judge: setup,
          subject,
          prompt: p,
          competitor: comp,
          flintAnswer: flintAnswer(p.id)!,
          competitorAnswer: answers.get(answerKey(p.id, comp))!,
          ctx,
          sharing,
          seed,
          signal: ac.signal,
          judgeMaxTokens: Number(values['judge-max-tokens']),
          reserve: (e) => budget.reserve(e),
        });
        if (r.kind === 'refused') return stop(budgetStop);
        if (r.kind === 'unjudgeable') return log(`  – ${p.id} vs ${comp.name}: no allowed judge (${r.excluded.join(', ')} excluded)`);
        appendJsonl(judgmentsPath, r.row);
        if (r.row.ok) {
          newJudgments++;
          log(`  ⚖ ${p.id} vs ${comp.name.padEnd(10)} -> ${subject} ${r.row.outcome}${r.row.panel && !r.row.agreed ? ' (split)' : ''}`);
        } else log(`  ✗ judge ${p.id} vs ${comp.name}: ${r.row.error?.slice(0, 160)}`);
      },
      stopped,
    );
  }

  // ---- report + history
  if (budget.exhausted) notes.push('The budget guard stopped the run; re-run with the same --run and a fresh --budget-usd to continue where it left off.');
  const md = renderRun({
    run,
    runDir,
    meta,
    prompts,
    answerRows: readJsonl<AnswerRow>(answersPath),
    judgmentRows: readJsonl<JudgmentRow>(judgmentsPath),
    subject,
    flintModel: flint.model,
    judgeModel,
    judgeVendors: [...judgeVendors],
    competitors: competitors.map((c) => ({ name: c.name, model: c.model })),
    spendUsd: budget.spent,
    budgetUsd: budget.limitUsd,
    stoppedForBudget: budget.exhausted,
    notes,
  });
  if (newJudgments > 0) {
    appendTasksHistory(TASKS_HISTORY, md.historyRows);
    log(`history -> ${TASKS_HISTORY}`);
  } else log('nothing new judged; history unchanged');
  process.stdout.write(md.text + '\n');
  log(`spent $${budget.spent.toFixed(4)} this invocation; report -> ${md.path}`);
  if (stopReason && stopReason !== budgetStop) process.exitCode = 1;
}

/** Contexts, verdicts, tool selection, exclusions and the report, from a run's rows (shared by `tasks` and `tasks-report`). */
function renderRun(opts: {
  run: string;
  runDir: string;
  meta: TasksRunMeta;
  prompts: readonly TaskPrompt[];
  answerRows: readonly AnswerRow[];
  judgmentRows: readonly JudgmentRow[];
  subject: string;
  /** Flint's contestant model (`flint@<url>`): its answers are keyed by it. */
  flintModel: string;
  judgeModel: string;
  judgeVendors: readonly string[];
  competitors: ReadonlyArray<{ name: string; model: string }>;
  spendUsd: number;
  budgetUsd: number;
  stoppedForBudget: boolean;
  notes: string[];
}): { text: string; path: string; historyRows: string[] } {
  const ids = new Set(opts.prompts.map((p) => p.id));
  const flintModel = opts.flintModel;
  const ok = new Map<string, AnswerRow>();
  for (const a of opts.answerRows) if (a.ok && ids.has(a.promptId)) ok.set(answerKey(a.promptId, { name: a.contestant, model: a.model }), a);
  const flintAnswer = (id: string): AnswerRow | undefined => ok.get(answerKey(id, { name: opts.subject, model: flintModel }));
  const contexts = contextsFor(opts.prompts, flintAnswer);
  const judgments = currentJudgments(opts.judgmentRows, opts.judgeModel, opts.subject, contexts, ids);
  const selection = selectionFor(opts.prompts, flintAnswer);
  const sharing: Sharing = { personal: opts.meta.sharePersonalWith, local: opts.meta.shareLocalWith ?? [] };
  const exclusions = computeExclusions({
    prompts: opts.prompts,
    contexts,
    competitors: opts.competitors.map((c) => c.name),
    judgeVendors: opts.judgeVendors,
    sharing,
  });
  const contestants = [{ name: opts.subject, model: flintModel }, ...opts.competitors];
  const answers = latestAnswers(opts.answerRows.filter((a) => ids.has(a.promptId)));
  const modelChecks = opts.meta.modelChecks ?? [];
  const notes = [
    ...opts.notes,
    'Competitors answer through their raw APIs with no tools of their own; each gets the request plus the data Flint retrieved, labelled as context, and the date and time Flint answered. Perplexity also searches the web on its own.',
    'Coding tasks are judged by reading: no generated code is run. Where a task has hidden tests or a verified answer, the judges get them as the rubric\'s "Reference".',
  ];
  const text = renderTasksReport({
    run: opts.run,
    taskSet: opts.meta.taskSet,
    subject: opts.subject,
    judgeModel: opts.judgeModel,
    prompts: opts.prompts,
    contestants,
    answers,
    judgments,
    selection,
    contexts,
    exclusions,
    sharing,
    modelChecks,
    contextChars: opts.meta.contextChars ?? undefined,
    spendUsd: opts.spendUsd,
    budgetUsd: opts.budgetUsd,
    stoppedForBudget: opts.stoppedForBudget,
    notes,
  });
  const path = join(opts.runDir, reportFileName(opts.subject, opts.judgeModel));
  writeFileSync(path, text);
  const summaries = summarize(judgments).filter((s) => s.n > 0);
  const flintFailed = opts.prompts.filter((p) => {
    const rows = opts.answerRows.filter((a) => a.promptId === p.id && a.contestant === opts.subject);
    return rows.length > 0 && !rows.some((a) => a.ok);
  });
  const strict = tasksStrict({ summaries, competitors: opts.competitors, flintFailed, sharing });
  const selectionStrict = tasksSelectionStrict({ judgments, selection, competitors: opts.competitors, flintFailed, sharing });
  const historyRows = tasksHistoryRows({
    ts: new Date().toISOString(),
    run: opts.run,
    taskSet: basename(opts.meta.taskSet),
    subject: opts.subject,
    summaries,
    strict,
    selectionStrict,
    selection,
    sharing,
    modelChecks,
    flintModels: flintAnswerModels(answers, opts.subject),
  });
  return { text, path, historyRows };
}

// --------------------------------------------------------------------------
// tasks-report

export function tasksReport(argv: string[]): void {
  const { values } = parseArgs({ args: argv, options: { run: { type: 'string' }, 'judge-model': { type: 'string' }, 'judge-panel': { type: 'string' } } });
  if (!values.run) throw new Error('--run <dir|name> required');
  const runDir = existsSync(values.run) ? resolve(values.run) : join(TASKS_RUNS, values.run);
  const meta = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8')) as TasksRunMeta;
  const judge = chooseGroundedJudge({
    judgeModel: values['judge-model'],
    judgePanel: values['judge-panel'],
    judgeGrounding: true,
    resumed: meta,
    defaults: { judgeModel: TASK_MODEL_DEFAULTS.claude, judgePanel: defaultJudgePanel(TASK_MODEL_DEFAULTS.claude, TASK_MODEL_DEFAULTS.openai) },
  });
  const prompts = readJsonl<TaskPrompt>(join(runDir, 'tasks.jsonl')).filter((p) => meta.promptIds.includes(p.id));
  const answerRows = readJsonl<AnswerRow>(join(runDir, 'answers.jsonl'));
  const judgmentRows = readJsonl<JudgmentRow>(join(runDir, 'judgments.jsonl'));
  const spend = answerRows.reduce((s, a) => s + (a.costUsd || 0), 0) + judgmentRows.filter((j) => j.judgeModel === judge.judgeModel).reduce((s, j) => s + (j.costUsd || 0), 0);
  const md = renderRun({
    run: basename(runDir),
    runDir,
    meta,
    prompts,
    answerRows,
    judgmentRows,
    subject: 'flint',
    // The latest Flint the run was answered by (run.json lists the current invocation's last).
    flintModel: [...meta.contestants].reverse().find((c) => c.name === 'flint')?.model ?? '',
    judgeModel: judge.judgeModel,
    judgeVendors: judge.panel ? judge.panel.map((p) => p.vendor) : ['anthropic'],
    competitors: meta.contestants.filter((c) => c.name !== 'flint'),
    spendUsd: spend,
    budgetUsd: spend,
    stoppedForBudget: false,
    notes: [`Re-rendered from cached rows (judge: ${judge.judgeModel}); spend shown is the run total across invocations.`],
  });
  process.stdout.write(md.text + '\n');
}
