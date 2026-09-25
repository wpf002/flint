import { execFile } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Tool } from '@flint/core';

/**
 * Flint's view of his own training. Without this he had no way to see the MLX
 * pipeline in ~/.flint/brain, so asked "how's your retraining going?" he said he
 * couldn't observe it — while a 70B run was live on the same machine. Everything
 * here is read from the files the pipeline already writes; nothing is inferred.
 */

/**
 * The logs a run writes to, newest wins. Paths are relative to the brain dir.
 * The training cycle (apps/train/mlx/cycle.sh) replaced the 70B upgrade and the
 * weekly retrain; their logs stay readable so the history still answers.
 */
const RUN_LOGS = [
  { file: 'cycles/latest/cycle.log', kind: 'training cycle (cycle.sh), gated against GPT-5' },
  { file: 'upgrade.out', kind: '70B upgrade (ultimate_upgrade.sh, retired)' },
  { file: 'retrain.out.log', kind: 'weekly retrain (retrain.sh, retired)' },
] as const;

const TRAINING_PROC_RE =
  /cycle\.sh|train_lora\.py|build_data\.py|package_candidate\.sh|gate-cli\.ts|ultimate_upgrade\.sh|retrain\.sh|mlx_lm lora|eval_judge\.py|prepare_data\.py/;

/** cycle.sh's stamped line for an outcome that ends a cycle before the gate ("[2026-10-01 02:31] NO_DATA (see ...)"). */
const CYCLE_END_RE = /^\[[\d: -]+\] (NO_DATA|DEFER|NO_CANDIDATE|PREEMPTED|PACKAGE_FAILED|CONTAMINATED|build_data failed|train_lora failed)\b/;

export type Phase = 'preparing' | 'loading' | 'training' | 'selecting' | 'judging' | 'complete' | 'stopped';

export interface RunStatus {
  kind: string;
  log: string;
  running: boolean;
  phase: Phase;
  startedAt?: string;
  lastUpdate: string;
  trainExamples?: number;
  iter?: number;
  totalIters?: number;
  percent?: number;
  itPerSec?: number;
  trainingEtaMinutes?: number;
  lastTrainLoss?: number;
  valLoss: Array<{ iter: number; loss: number }>;
  bestVal?: { iter: number; loss: number };
  pickedCheckpoint?: string;
  result?: string[];
}

export interface EvalRow {
  ts: string;
  base: string;
  adapter: string;
  n: number;
  flintWins: number;
  baseWins: number;
  ties: number;
  signal: string;
}

/** Parse one run's log. Pure, so it's testable without a live run. */
export function parseRunLog(text: string, running: boolean): Omit<RunStatus, 'kind' | 'log' | 'lastUpdate'> {
  const lines = text.split('\n');
  const out: Omit<RunStatus, 'kind' | 'log' | 'lastUpdate'> = { running, phase: 'preparing', valLoss: [] };
  const speeds: number[] = [];
  let sawLoad = false;
  let sawSelect = false;
  let sawJudge = false;
  let sawDone = false;
  const result: string[] = [];

  for (const line of lines) {
    const start = line.match(/^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\]/);
    if (start?.[1] && !out.startedAt) out.startedAt = start[1];
    const hdr = line.match(/train_n=(\d+) iters=(\d+)/);
    if (hdr) {
      out.trainExamples = Number(hdr[1]);
      out.totalIters = Number(hdr[2]);
    }
    if (/Loading pretrained model/.test(line)) sawLoad = true;
    const val = line.match(/Iter (\d+): Val loss ([\d.]+)/);
    if (val) out.valLoss.push({ iter: Number(val[1]), loss: Number(val[2]) });
    // train_lora.py's early-stopping callback: the base first, then each eval (step = updates done).
    const esBase = line.match(/early_stop: base val ([\d.]+)/);
    if (esBase) out.valLoss.push({ iter: 0, loss: Number(esBase[1]) });
    const es = line.match(/early_stop: step (\d+) val ([\d.]+)/);
    if (es) out.valLoss.push({ iter: Number(es[1]), loss: Number(es[2]) });
    const tr = line.match(/Iter (\d+): Train loss ([\d.]+).*?It\/sec ([\d.]+)/);
    if (tr) {
      out.iter = Number(tr[1]);
      out.lastTrainLoss = Number(tr[2]);
      speeds.push(Number(tr[3]));
    }
    if (/selecting best checkpoint/.test(line)) sawSelect = true;
    const pick = line.match(/pick_best: (.*)/);
    if (pick?.[1]) out.pickedCheckpoint = pick[1];
    if (/judging/.test(line)) sawJudge = true;
    if (/Flint wins|verdict|signal:/.test(line)) result.push(line.trim());
    if (/UPGRADE COMPLETE|RETRAIN DONE|CYCLE DONE/.test(line)) sawDone = true;
    if (CYCLE_END_RE.test(line)) {
      sawDone = true;
      result.push(line.trim());
    }
  }

  if (out.valLoss.length > 0) {
    out.bestVal = out.valLoss.reduce((a, b) => (b.loss < a.loss ? b : a));
  }
  if (out.iter !== undefined && out.totalIters) {
    out.percent = Math.round((out.iter / out.totalIters) * 1000) / 10;
    const recent = speeds.slice(-10);
    if (recent.length > 0) {
      out.itPerSec = Math.round((recent.reduce((a, b) => a + b, 0) / recent.length) * 1000) / 1000;
      if (out.itPerSec > 0) out.trainingEtaMinutes = Math.round((out.totalIters - out.iter) / out.itPerSec / 60);
    }
  }
  if (result.length > 0) out.result = [...new Set(result)];

  if (sawDone) out.phase = 'complete';
  else if (sawJudge) out.phase = 'judging';
  else if (sawSelect) out.phase = 'selecting';
  else if (out.iter !== undefined) out.phase = 'training';
  else if (sawLoad) out.phase = 'loading';
  // A log that stopped short of the end with no training process alive died.
  if (!running && !sawDone) out.phase = 'stopped';
  if (out.phase === 'complete' || out.phase === 'judging' || out.phase === 'selecting') {
    delete out.trainingEtaMinutes;
  }
  return out;
}

export function parseEvalHistory(csv: string): EvalRow[] {
  return csv
    .split('\n')
    .slice(1)
    .filter((l) => l.trim())
    .map((l) => {
      const [ts = '', base = '', adapter = '', n, fw, bw, ties, signal = ''] = l.split(',');
      return {
        ts: ts || '(no timestamp)',
        base,
        adapter,
        n: Number(n),
        flintWins: Number(fw),
        baseWins: Number(bw),
        ties: Number(ties),
        signal,
      };
    });
}

async function trainingProcsAlive(): Promise<boolean> {
  try {
    const { stdout } = await promisify(execFile)('ps', ['-Ao', 'command=']);
    return stdout.split('\n').some((l) => TRAINING_PROC_RE.test(l));
  } catch {
    return false;
  }
}

export interface TrainingStatusDeps {
  brainDir: string;
  corpus: () => { total: number; teacher: number; student: number };
  /** What is answering right now (the local provider + model, and frontier). */
  serving: () => { local: string; frontier?: string | undefined };
  /** Injectable for tests. */
  isRunning?: () => Promise<boolean>;
}

export async function readTrainingStatus(deps: TrainingStatusDeps) {
  const { brainDir } = deps;
  const running = await (deps.isRunning ?? trainingProcsAlive)();

  const logs = RUN_LOGS.map((r) => ({ ...r, path: join(brainDir, r.file) }))
    .filter((r) => existsSync(r.path))
    .map((r) => ({ ...r, mtime: statSync(r.path).mtime }))
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

  let latestRun: RunStatus | undefined;
  const newest = logs[0];
  if (newest) {
    latestRun = {
      kind: newest.kind,
      log: newest.path,
      lastUpdate: newest.mtime.toISOString(),
      ...parseRunLog(readFileSync(newest.path, 'utf8'), running),
    };
  }

  const evalPath = join(brainDir, 'eval_history.csv');
  const evals = existsSync(evalPath) ? parseEvalHistory(readFileSync(evalPath, 'utf8')).slice(-3) : [];
  const latestCycle = readLatestCycle(brainDir);

  const adapters: Record<string, string> = {};
  for (const d of ['adapters7b', 'adapters70b']) {
    const p = join(brainDir, d, 'adapters.safetensors');
    if (existsSync(p)) adapters[d] = statSync(p).mtime.toISOString();
  }

  // A fine-tuned model would be served under a flint-* name (docs/MAC_STUDIO_UPGRADE.md
  // step 3). Anything else means the trained adapters exist on disk but aren't live.
  const serving = deps.serving();
  const fineTunedServing = /flint/i.test(serving.local);

  return {
    latestRun: latestRun ?? null,
    latestCycle,
    cycleNote:
      "The training cycle ships a local model only if it measurably improves Flint-local's standing against GPT-5: the candidate and the live local model answer the same prompts, a cross-vendor judge panel compares each with GPT-5's answer, and PROMOTE needs a significant gain of at least 5 points in strict win rate with no regression elsewhere. HOLD means the measurement wasn't trustworthy (missing prompt set, server changed, too few pairs); promotion itself is always Will's manual step.",
    recentEvals: evals,
    evalNote:
      'recentEvals are from the retired pipeline, which compared a fine-tune with its own base (never with a frontier model); kept for the record. signal=NOISE means the gap was within coin-flip range.',
    corpus: deps.corpus(),
    adaptersOnDisk: adapters,
    servingNow: { ...serving, fineTunedServing },
  };
}

export interface CycleStatus {
  id?: string;
  result?: string;
  profile?: string;
  targets?: number;
  candidate?: string;
  startedAt?: string;
  endedAt?: string;
  /** From the cycle's adapter/early_stop.json. */
  training?: { exit?: string; baseVal?: number; bestVal?: number; bestStep?: number; stopReason?: string; peakMemoryGb?: number };
  /** From the cycle's gate.json. */
  gate?: { verdict?: string; reasons?: string[] };
}

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** The last cycle's record (cycles/state.json) plus its training summary and gate verdict. Null before the first cycle. */
export function readLatestCycle(brainDir: string): CycleStatus | null {
  const state = readJson(join(brainDir, 'cycles', 'state.json'));
  const cycles = Array.isArray(state?.cycles) ? (state.cycles as Array<Record<string, unknown>>) : [];
  const last = cycles.at(-1);
  if (!last) return null;
  const dir = join(brainDir, 'cycles', String(last.id ?? ''));
  const out: CycleStatus = {};
  for (const k of ['id', 'result', 'profile', 'candidate', 'startedAt', 'endedAt'] as const) if (typeof last[k] === 'string') out[k] = last[k] as string;
  if (typeof last.targets === 'number') out.targets = last.targets;
  const es = readJson(join(dir, 'adapter', 'early_stop.json'));
  if (es) {
    out.training = {
      ...(typeof es.exit === 'string' ? { exit: es.exit } : {}),
      ...(typeof es.base_val === 'number' ? { baseVal: es.base_val } : {}),
      ...(typeof es.best_val === 'number' ? { bestVal: es.best_val } : {}),
      ...(typeof es.best_iter === 'number' ? { bestStep: es.best_iter } : {}),
      ...(typeof es.stop_reason === 'string' ? { stopReason: es.stop_reason } : {}),
      ...(typeof es.peakMemoryGbMlx === 'number' ? { peakMemoryGb: es.peakMemoryGbMlx } : {}),
    };
  }
  const gate = readJson(join(dir, 'gate.json'));
  const decision = gate?.decision as { verdict?: unknown; reasons?: unknown } | undefined;
  if (decision) {
    out.gate = {
      ...(typeof decision.verdict === 'string' ? { verdict: decision.verdict } : {}),
      ...(Array.isArray(decision.reasons) ? { reasons: decision.reasons.filter((r): r is string => typeof r === 'string') } : {}),
    };
  }
  return out;
}

export function trainingStatusTool(deps: TrainingStatusDeps): Tool {
  return {
    definition: {
      name: 'training_status',
      description:
        "Flint's own training: the live or latest training cycle (phase, loss, ETA), its gate verdict against GPT-5, corpus size, and which model is actually serving. Call when Will asks how your training/retraining/learning is going.",
      inputSchema: { type: 'object', properties: {} },
      idempotent: true,
    },
    handler: async () => readTrainingStatus(deps),
  };
}
