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

/** The logs a run writes to, newest wins. Paths are relative to the brain dir. */
const RUN_LOGS = [
  { file: 'upgrade.out', kind: '70B upgrade (ultimate_upgrade.sh)' },
  { file: 'retrain.out.log', kind: 'weekly retrain (retrain.sh)' },
] as const;

const TRAINING_PROC_RE = /ultimate_upgrade\.sh|retrain\.sh|mlx_lm lora|eval_judge\.py|prepare_data\.py/;

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
    if (/UPGRADE COMPLETE|RETRAIN DONE/.test(line)) sawDone = true;
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
    recentEvals: evals,
    evalNote:
      'Each eval: Claude judges the fine-tuned model vs its base on a frozen held-out set. signal=NOISE means the gap is within coin-flip range — not a real win yet. signal=SIGNIFICANT means the gap is real in whichever direction the wins point: if baseWins > flintWins, the fine-tune made that model worse.',
    corpus: deps.corpus(),
    adaptersOnDisk: adapters,
    servingNow: { ...serving, fineTunedServing },
  };
}

export function trainingStatusTool(deps: TrainingStatusDeps): Tool {
  return {
    definition: {
      name: 'training_status',
      description:
        "Flint's own training: the live or latest fine-tune run (phase, iteration, loss, ETA), recent eval results vs the base model, corpus size, and which model is actually serving. Call when Will asks how your training/retraining/learning is going.",
      inputSchema: { type: 'object', properties: {} },
      idempotent: true,
    },
    handler: async () => readTrainingStatus(deps),
  };
}
