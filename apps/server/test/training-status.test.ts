import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseEvalHistory, parseRunLog, readTrainingStatus } from '../src/training-status';

const MID_RUN = `[2026-09-23 09:10] ULTIMATE UPGRADE — base=mlx-community/Qwen2.5-72B-Instruct-4bit
[2026-09-23 09:10] fine-tuning 70B: train_n=30642 iters=2000 step=200 (this takes hours)
Loading pretrained model
Iter 1: Val loss 2.143, Val took 46.369s
Iter 190: Train loss 1.010, Learning Rate 1.000e-05, It/sec 0.300, Tokens/sec 154.4, Trained Tokens 1, Peak mem 46.0 GB
Iter 200: Val loss 1.500, Val took 45.1s
Iter 200: Train loss 0.900, Learning Rate 1.000e-05, It/sec 0.300, Tokens/sec 154.4, Trained Tokens 1, Peak mem 46.0 GB
`;

const DONE = `${MID_RUN}[2026-09-23 09:10] selecting best checkpoint (early-stop)...
pick_best: best val loss 1.500 @ iter 200 -> active adapter = checkpoint 200
[2026-09-23 09:10] judging Flint-70B vs base 70B (Claude referee)...
=== UPGRADE COMPLETE ===
Flint wins: 39/150   Base wins: 31/150   Ties: 80/150
signal: NOISE  (39-31 decisive, coin-flip sd=4.2, edge=4.0)
`;

describe('parseRunLog', () => {
  it('reads progress, loss and ETA from a live run', () => {
    const r = parseRunLog(MID_RUN, true);
    expect(r.phase).toBe('training');
    expect(r.startedAt).toBe('2026-09-23 09:10');
    expect(r.trainExamples).toBe(30642);
    expect(r.iter).toBe(200);
    expect(r.totalIters).toBe(2000);
    expect(r.percent).toBe(10);
    expect(r.lastTrainLoss).toBe(0.9);
    expect(r.bestVal).toEqual({ iter: 200, loss: 1.5 });
    // 1800 iters left at 0.3 it/s = 100 minutes
    expect(r.trainingEtaMinutes).toBe(100);
  });

  it('reports a finished run with its checkpoint and verdict', () => {
    const r = parseRunLog(DONE, false);
    expect(r.phase).toBe('complete');
    expect(r.pickedCheckpoint).toMatch(/checkpoint 200/);
    expect(r.result?.some((l) => l.includes('signal: NOISE'))).toBe(true);
    expect(r.trainingEtaMinutes).toBeUndefined();
  });

  it('calls a half-written log with no live process stopped, not training', () => {
    expect(parseRunLog(MID_RUN, false).phase).toBe('stopped');
  });
});

describe('parseEvalHistory', () => {
  it('keeps rows that were logged without a timestamp', () => {
    const rows = parseEvalHistory(
      'ts,base,adapter,n,flint_wins,base_wins,ties,signal\n,m,adapters70b,15,4,4,7,NOISE\n2026-09-22 20:33,m,adapters70b,150,39,31,80,NOISE\n',
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]?.ts).toBe('(no timestamp)');
    expect(rows[1]).toMatchObject({ n: 150, flintWins: 39, baseWins: 31, ties: 80, signal: 'NOISE' });
  });
});

describe('readTrainingStatus', () => {
  it('assembles run, evals, corpus and serving from the brain dir', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'flint-brain-'));
    writeFileSync(join(dir, 'upgrade.out'), MID_RUN);
    writeFileSync(join(dir, 'eval_history.csv'), 'ts,base,adapter,n,flint_wins,base_wins,ties,signal\nt,m,a,150,39,31,80,NOISE\n');
    const s = await readTrainingStatus({
      brainDir: dir,
      corpus: () => ({ total: 793, teacher: 755, student: 38 }),
      serving: () => ({ local: 'ollama:qwen2.5:7b', frontier: 'anthropic:claude-sonnet-4-6' }),
      isRunning: async () => true,
    });
    expect(s.latestRun?.phase).toBe('training');
    expect(s.latestRun?.kind).toMatch(/70B/);
    expect(s.recentEvals).toHaveLength(1);
    expect(s.corpus.total).toBe(793);
    // the stock qwen isn't Flint's fine-tune — he must not claim it is
    expect(s.servingNow.fineTunedServing).toBe(false);
  });

  it('works on an empty brain dir', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'flint-brain-'));
    const s = await readTrainingStatus({
      brainDir: dir,
      corpus: () => ({ total: 0, teacher: 0, student: 0 }),
      serving: () => ({ local: 'ollama:flint-70b' }),
      isRunning: async () => false,
    });
    expect(s.latestRun).toBeNull();
    expect(s.recentEvals).toEqual([]);
    expect(s.servingNow.fineTunedServing).toBe(true);
  });
});
