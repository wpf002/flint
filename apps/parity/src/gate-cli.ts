#!/usr/bin/env tsx
/**
 * `pnpm --filter @flint/parity gate`: should this local-model candidate replace
 * the live local model? It answers that the only way that matters for Flint:
 * does Flint-local win more often against a frontier model (GPT-5) with the
 * candidate than with the live model, on the same prompts, the same competitor
 * answers and the same judge?
 *
 *   gate --candidate flint-muse:c20261001-0230 --manifest <cycle>/data/manifest.json
 *        [--candidate-think on|off] [--candidate-variant v] [--baseline-variant v]
 *        [--sets parity_prompts.jsonl:100,flint_tasks.jsonl]
 *        [--competitor openai] [--openai-model gpt-5]
 *        [--judge-panel anthropic:claude-opus-5-5,openai:gpt-5 | --judge-model m]
 *        [--budget-usd 30] [--verdict-out file] [--dry-run]
 *   gate --no-manifest --candidate qwen3.8:27b ...          a base-model swap (nothing trained)
 *   gate --decide-only --runs parity_prompts=<run dir> --candidate-subject <name> --baseline-subject <name> ...
 *   gate --preflight-only [--manifest m | --no-manifest] [--sets ...]
 *        only the free checks (sets on disk, the manifest): prints them as JSON and
 *        exits 0 PROCEED / 1 REJECT / 3 HOLD. No server, model or paid call, and
 *        nothing written. cycle.sh runs it before training.
 *
 * For each set it makes a fresh run dir and calls this package's own `run`
 * twice (./gate#planSetRuns): the live local model (`--flint-local`) and then
 * the candidate (`--local-model`). The pure decision is ./gate#decideGate.
 * Checks that can fail before anything is paid for (missing sets, a manifest
 * guarded against other sets, a contaminated manifest) run first.
 *
 * Exit: 0 PROMOTE, 1 REJECT, 3 HOLD, 2 error. It never promotes: a PROMOTE
 * prints the commands that would (./gate#promotionCommands, also kept in the
 * verdict record as `promote`), and running them is Will's step.
 */
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { assertLocalModelName, flintContestantName, flintHealth, flintVariantFlag, parseLocalThink } from './contestants.js';
import {
  DEFAULT_THRESHOLDS,
  decideGate,
  describeFingerprintChange,
  exitCodeOf,
  GATE_COMPETITOR_VENDOR,
  GATE_HISTORY_HEADER,
  gateShareable,
  gateHistoryRow,
  parseManifest,
  parseSetsSpec,
  parseSpent,
  planSetRuns,
  poolSets,
  preflightChecks,
  preflightExitCode,
  preflightVerdict,
  promotionCommands,
  renderGate,
  serverFingerprint,
  setOutcome,
  type GateCheck,
  type GateInput,
  type GateThresholds,
  type ManifestInfo,
} from './gate.js';
import { panelId, parseJudgePanel } from './panel.js';
import { takeBalanced, type EvalPrompt } from './prompts.js';
import { latestJudgments, type AnswerRow, type JudgmentRow } from './report.js';
import { readJsonl, writeFileAtomic } from './util.js';

const FLINT_HOME = join(homedir(), '.flint');
const EVAL_DIR = process.env.PARITY_DIR?.trim() || join(FLINT_HOME, 'eval');
const BRAIN_DIR = process.env.FLINT_BRAIN_DIR?.trim() || join(FLINT_HOME, 'brain');
const DEPLOY_DIR = process.env.FLINT_DEPLOY_DIR?.trim() || join(homedir(), 'flint');
const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI_TS = join(PKG_DIR, 'src', 'cli.ts');
const DEFAULT_PANEL = 'anthropic:claude-opus-5-5,openai:gpt-5';
const COMPETITOR_MODEL_DEFAULTS: Record<string, string> = {
  openai: process.env.PARITY_OPENAI_MODEL?.trim() || 'gpt-5',
  claude: process.env.PARITY_CLAUDE_MODEL?.trim() || 'claude-opus-5-5',
  perplexity: process.env.PARITY_PERPLEXITY_MODEL?.trim() || 'sonar-pro',
};

function log(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function deployHead(): string {
  try {
    return execFileSync('git', ['-C', DEPLOY_DIR, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return 'unknown';
  }
}

/** A training run in progress competes with the models being timed. cycle.sh writes this file while it trains. */
function trainingInProgress(): string | undefined {
  const mark = join(BRAIN_DIR, 'TRAINING.json');
  if (!existsSync(mark)) return undefined;
  try {
    const m = JSON.parse(readFileSync(mark, 'utf8')) as { pid?: number; cycle?: string };
    if (typeof m.pid === 'number') process.kill(m.pid, 0);
    return `cycle ${m.cycle ?? '?'} (pid ${m.pid ?? '?'}) is training`;
  } catch {
    return undefined; // a stale mark from a dead process
  }
}

/** This package's own `run`, as a child process (the same code path a person runs), streaming its log through. */
function runParity(args: string[]): Promise<{ code: number; spent: number | undefined; budgetStop: boolean; tail: string[] }> {
  const tsxCli = createRequire(import.meta.url).resolve('tsx/cli');
  return new Promise((done) => {
    const child = spawn(process.execPath, [tsxCli, CLI_TS, 'run', ...args], { cwd: PKG_DIR, stdio: ['ignore', 'ignore', 'pipe'], env: process.env });
    let spent: number | undefined;
    let budgetStop = false;
    let buf = '';
    const tail: string[] = [];
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      process.stderr.write(chunk);
      buf += chunk;
      for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        spent = parseSpent(line) ?? spent;
        // `run` exits 0 when the budget stops it, so the log is the only signal.
        if (/^stopping: budget/.test(line)) budgetStop = true;
        tail.push(line);
        if (tail.length > 5) tail.shift();
      }
    });
    child.on('close', (code) => done({ code: code ?? 1, spent, budgetStop, tail }));
  });
}

function stamp(d = new Date()): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z').replace('T', '-');
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      candidate: { type: 'string' },
      'candidate-think': { type: 'string' },
      'candidate-variant': { type: 'string' },
      'baseline-variant': { type: 'string' },
      manifest: { type: 'string' },
      'no-manifest': { type: 'boolean', default: false },
      sets: { type: 'string', default: 'parity_prompts.jsonl:100,flint_tasks.jsonl' },
      competitor: { type: 'string', default: 'openai' },
      'openai-model': { type: 'string' },
      'claude-model': { type: 'string' },
      'perplexity-model': { type: 'string' },
      'judge-panel': { type: 'string' },
      'judge-model': { type: 'string' },
      'budget-usd': { type: 'string', default: '30' },
      'flint-url': { type: 'string', default: process.env.FLINT_URL?.trim() || 'http://127.0.0.1:8080' },
      margin: { type: 'string' },
      alpha: { type: 'string' },
      'min-paired': { type: 'string' },
      'max-category-drop': { type: 'string' },
      'max-latency-ratio': { type: 'string' },
      'out-dir': { type: 'string', default: join(EVAL_DIR, 'gates') },
      'verdict-out': { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      'decide-only': { type: 'boolean', default: false },
      'preflight-only': { type: 'boolean', default: false },
      runs: { type: 'string' },
      'baseline-subject': { type: 'string' },
      'candidate-subject': { type: 'string' },
      'baseline-label': { type: 'string' },
    },
  });

  const t: GateThresholds = {
    ...DEFAULT_THRESHOLDS,
    ...(values.margin ? { margin: Number(values.margin) } : {}),
    ...(values.alpha ? { alpha: Number(values.alpha) } : {}),
    ...(values['min-paired'] ? { minPaired: Number(values['min-paired']) } : {}),
    ...(values['max-category-drop'] ? { maxCategoryDrop: Number(values['max-category-drop']) } : {}),
    ...(values['max-latency-ratio'] ? { maxLatencyRatio: Number(values['max-latency-ratio']) } : {}),
  };
  const decideOnly = values['decide-only']!;
  const preflightOnly = values['preflight-only']!;
  const candidate = values.candidate?.trim();
  if (!candidate && !preflightOnly && !(decideOnly && values['candidate-subject'])) throw new Error('--candidate <ollama model> is required');
  if (candidate) assertLocalModelName(candidate);
  const think = parseLocalThink(values['candidate-think']);
  const candidateVariant = flintVariantFlag(values['candidate-variant']);
  const baselineVariant = flintVariantFlag(values['baseline-variant']);
  const competitor = values.competitor!.trim();
  const competitorModel = values[`${competitor}-model` as 'openai-model']?.trim() || COMPETITOR_MODEL_DEFAULTS[competitor];
  if (!competitorModel) throw new Error(`--competitor ${competitor}: one of ${Object.keys(COMPETITOR_MODEL_DEFAULTS).join(', ')}`);
  const judgeModel = values['judge-model']?.trim() || panelId(parseJudgePanel(values['judge-panel']?.trim() || DEFAULT_PANEL));
  const judgeArgs = values['judge-model'] ? ['--judge-model', values['judge-model'].trim()] : ['--judge-panel', values['judge-panel']?.trim() || DEFAULT_PANEL];
  // Every vendor a gated prompt (or Flint's answer to it) is sent to: a Flint-tasks set is cut to what they all may see.
  const judgeVendors = values['judge-model'] ? ['anthropic'] : parseJudgePanel(values['judge-panel']?.trim() || DEFAULT_PANEL).map((p) => p.vendor);
  const sendsTo = [...new Set([GATE_COMPETITOR_VENDOR[competitor]!, ...judgeVendors])];
  const baselineSubject = values['baseline-subject']?.trim() || flintContestantName({ localOnly: true, styleVariant: baselineVariant });
  const candidateSubject =
    values['candidate-subject']?.trim() ||
    flintContestantName({ localModel: candidate, localThink: think === undefined ? undefined : think, styleVariant: candidateVariant });

  // ---- sets
  const specs = parseSetsSpec(values.sets!);
  const sets = specs.map((s) => ({ ...s, path: isAbsolute(s.file) ? s.file : join(EVAL_DIR, s.file) }));
  const missingSets = sets.filter((s) => !existsSync(s.path)).map((s) => s.path);
  const present = sets.filter((s) => existsSync(s.path)).map((s) => ({ ...s, sha256: sha256File(s.path) }));
  /** A set's prompts as the gate runs and scores them: what `sendsTo` may see, then its `:N` slice. */
  const gatedPrompts = (s: (typeof present)[number]): { rows: EvalPrompt[]; shareable: EvalPrompt[]; withheld: number } => {
    const { kept, withheld } = gateShareable(readJsonl<EvalPrompt>(s.path), sendsTo);
    return { rows: s.limit !== undefined ? takeBalanced(kept, s.limit) : kept, shareable: kept, withheld };
  };

  // ---- manifest
  let manifest: ManifestInfo | 'not-required' | undefined;
  if (values['no-manifest']) manifest = 'not-required';
  else if (values.manifest) manifest = parseManifest(values.manifest, readFileSync(values.manifest, 'utf8'));

  // ---- --preflight-only: the free checks and nothing else (no server, no model, no files)
  if (preflightOnly) {
    const checks = preflightChecks({ missingSets, manifest, sets: present });
    const { verdict, reasons } = preflightVerdict(checks);
    log(`gate preflight: ${verdict}${reasons.length ? `: ${reasons.join('; ')}` : ''}`);
    process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), preflight: true, decision: { verdict, checks, reasons } }) + '\n');
    return preflightExitCode(verdict);
  }

  const label = candidate ?? candidateSubject;
  const outDir = resolve(values['out-dir']!);
  const ts = stamp();
  const finish = (input: GateInput): number => {
    const decision = decideGate(input);
    const md = renderGate(input, decision);
    // How to serve it as it was judged (model, think flag, style variant); only for a real candidate.
    const promote =
      decision.verdict === 'PROMOTE' && candidate ? promotionCommands({ candidate, think, variant: candidateVariant, flintUrl: values['flint-url']! }) : undefined;
    const record = { ts: new Date().toISOString(), decision, ...(promote ? { promote } : {}), input: { ...input, pooled: input.pooled } };
    mkdirSync(outDir, { recursive: true });
    const base = join(outDir, `${label.replace(/[^A-Za-z0-9._-]/g, '_')}-${ts}`);
    writeFileAtomic(`${base}.json`, JSON.stringify(record, null, 2) + '\n');
    writeFileAtomic(`${base}.md`, md);
    if (values['verdict-out']) writeFileAtomic(resolve(values['verdict-out']), JSON.stringify(record, null, 2) + '\n');
    const hist = join(outDir, 'gate_history.csv');
    appendFileSync(hist, (existsSync(hist) ? '' : GATE_HISTORY_HEADER + '\n') + gateHistoryRow(record.ts, input, decision) + '\n');
    process.stdout.write(md + '\n');
    log(`verdict: ${decision.verdict} -> ${base}.json`);
    if (promote) log(`To serve it as it was judged (Will's call; the gate never does):\n${promote.map((l) => `  ${l}`).join('\n')}`);
    return exitCodeOf(decision.verdict);
  };
  const emptyPaired = poolSets([], t.ciLevel);

  // ---- checks that cost nothing
  const pre: GateCheck[] = preflightChecks({ missingSets, manifest, sets: present });
  const blocking = pre.filter((c) => !c.ok && (c.severity === 'fatal' || c.severity === 'hold'));
  if (blocking.length) {
    log(`gate: stopping before any paid call: ${blocking.map((c) => c.detail).join('; ')}`);
    return finish({ candidate: label, baseline: baselineSubject, sets: [], pooled: emptyPaired, manifest, missingSets, thresholds: t });
  }

  // ---- answer and judge (unless re-deciding existing runs)
  const runDirs = new Map<string, string>();
  const runErrors: string[] = [];
  let baselineLabel = values['baseline-label']?.trim() || baselineSubject;
  let serverChanged: string | undefined;
  if (decideOnly) {
    for (const part of (values.runs ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
      const [name, dir] = part.split('=');
      if (!name || !dir) throw new Error(`--runs: "${part}" is not <set name>=<run dir>`);
      runDirs.set(name, existsSync(dir) ? resolve(dir) : join(EVAL_DIR, 'runs', dir));
    }
    for (const s of present) if (!runDirs.has(s.name)) throw new Error(`--decide-only: no run dir for set ${s.name} (--runs ${s.name}=<dir>)`);
  } else {
    if (!candidate) throw new Error('--candidate is required unless --decide-only');
    const training = trainingInProgress();
    if (training) throw new Error(`${training}: a gate run now would time both models against a GPU that is busy training`);
    const url = values['flint-url']!;
    const health = await flintHealth(url);
    if (!health) throw new Error(`Flint isn't answering at ${url}/health`);
    if (health.provider !== 'ollama') throw new Error(`the server's local brain is ${String(health.provider)}, not Ollama: nothing to gate`);
    if (health.evalMode !== true || health.localModelOverride !== true) throw new Error('the server lacks eval mode / the local-model override (deploy a current build)');
    if (think !== undefined && health.localThinkOverride !== true) throw new Error('the server lacks the local-think override');
    if (String(health.model) === candidate) throw new Error(`${candidate} is already the live local model`);
    baselineLabel = values['baseline-label']?.trim() || String(health.model);
    const before = serverFingerprint(health, deployHead());
    let remaining = Number(values['budget-usd']);
    for (const s of present) {
      const runDir = join(EVAL_DIR, 'runs', `gate-${label.replace(/[^A-Za-z0-9._-]/g, '_')}-${ts}-${s.name}`);
      // Created up front: `run --run <path>` treats a path that doesn't exist yet as a run *name*.
      if (!values['dry-run']) mkdirSync(runDir, { recursive: true });
      runDirs.set(s.name, runDir);
      // A Flint-tasks set: `run` gets only the prompts every vendor it sends to may see (gateShareable).
      const g = gatedPrompts(s);
      let promptsPath = s.path;
      if (g.withheld > 0) {
        log(`gate: ${s.name}: ${g.withheld} Flint-tasks prompt(s) withheld (personal: Anthropic only; stay local: nobody), since this gate sends to ${sendsTo.join(', ')}`);
        promptsPath = join(runDir, 'gate-prompts.jsonl');
        if (!values['dry-run']) writeFileAtomic(promptsPath, g.shareable.map((p) => JSON.stringify(p)).join('\n') + '\n');
      }
      const plan = planSetRuns({
        runDir,
        promptsPath,
        limit: s.limit,
        competitor,
        competitorModel,
        judgeArgs,
        flintUrl: url,
        candidate,
        candidateThink: think === undefined ? undefined : think ? 'on' : 'off',
        candidateVariant,
        baselineVariant,
      });
      // One pass, then one resume pass if any pair ended in a judge error: `run`
      // retries failed verdicts (and failed answers, for both sides alike) on resume.
      let setErrors: string[] = [];
      for (let pass = 1; pass <= 2; pass++) {
        if (pass === 2) {
          const failedJudgments = [baselineSubject, candidateSubject].reduce(
            (n, subject) => n + latestJudgments(readJsonl<JudgmentRow>(join(runDir, 'judgments.jsonl')), judgeModel, subject).filter((j) => !j.ok).length,
            0,
          );
          if (values['dry-run'] || failedJudgments === 0) break;
          log(`gate: ${s.name}: ${failedJudgments} judge error(s); resuming once to re-judge them`);
        }
        const errors: string[] = [];
        for (const step of plan) {
          if (values['dry-run']) {
            log(`[dry run] ${step.subject}: tsx src/cli.ts run ${step.args.join(' ')} --budget-usd <remaining>`);
            continue;
          }
          if (remaining <= 0) {
            errors.push(`${s.name}/${step.subject}: budget exhausted before it ran`);
            continue;
          }
          log(`gate: ${s.name}: answering and judging the ${step.subject} ($${remaining.toFixed(2)} left)`);
          const r = await runParity([...step.args, '--budget-usd', remaining.toFixed(2)]);
          remaining -= r.spent ?? remaining; // unknown spend: assume the worst
          if (r.code !== 0) errors.push(`${s.name}/${step.subject}: exit ${r.code} (${r.tail.at(-1) ?? ''})`);
          else if (r.budgetStop) errors.push(`${s.name}/${step.subject}: stopped at the budget`);
        }
        // The last pass decides: a resume that finished cleanly supersedes the first pass's stop.
        setErrors = errors;
      }
      runErrors.push(...setErrors);
    }
    if (values['dry-run']) {
      log('[dry run] nothing was answered, judged or written');
      return 0;
    }
    serverChanged = describeFingerprintChange(before, serverFingerprint(await flintHealth(url), deployHead()));
  }

  // ---- score and decide
  const outcomes = present.map((s) => {
    const runDir = runDirs.get(s.name)!;
    const prompts = gatedPrompts(s).rows;
    return setOutcome({
      name: s.name,
      path: s.path,
      sha256: s.sha256,
      runDir,
      prompts,
      answers: readJsonl<AnswerRow>(join(runDir, 'answers.jsonl')),
      judgments: readJsonl<JudgmentRow>(join(runDir, 'judgments.jsonl')),
      baselineSubject,
      candidateSubject,
      competitor,
      competitorModel,
      judgeModel,
      ciLevel: t.ciLevel,
    });
  });
  const input: GateInput = {
    candidate: label,
    baseline: baselineLabel,
    sets: outcomes.map(({ baselineScores: _b, candidateScores: _c, ...o }) => o),
    pooled: poolSets(outcomes, t.ciLevel),
    manifest,
    missingSets,
    serverChanged,
    runErrors,
    thresholds: t,
  };
  return finish(input);
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    log(`gate: error: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 2;
  },
);
