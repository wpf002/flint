import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
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

const CYCLE_DONE = `[2026-10-01 02:30] cycle 20261001-0230: profile=muse-glimmer-30b
[2026-10-01 02:31] training: footprint 2048x16, budget 33.0 GB, up to 4.0 h
[2026-10-01 02:31] training: profile=muse-glimmer-30b model=mlx-community/Muse-Glimmer-30B-4bit train_n=640 iters=1280 valid_n=120
early_stop: base val 1.9000
early_stop: step 160 val 1.8000 (new best, saved)
early_stop: step 400 val 1.7100 (new best, saved)
early_stop: step 560 val 1.7300 (best 1.7100 @ 400, 1/3 without improvement)
[2026-10-01 05:02] train_lora: CANDIDATE (stopped: patience); base val 1.9 best 1.71 @ step 400
[2026-10-01 05:20] judging candidate flint-muse:c20261001-0230 against GPT-5 through the parity gate...
[2026-10-01 06:10] verdict: REJECT
[2026-10-01 06:10] === CYCLE DONE ===
`;

describe('parseRunLog', () => {
  it('reads a training cycle log: header, early-stop curve, verdict', () => {
    const r = parseRunLog(CYCLE_DONE, false);
    expect(r.phase).toBe('complete');
    expect(r.trainExamples).toBe(640);
    expect(r.totalIters).toBe(1280);
    expect(r.valLoss.map((v) => v.iter)).toEqual([0, 160, 400, 560]);
    expect(r.bestVal).toEqual({ iter: 400, loss: 1.71 });
    expect(r.result).toContain('[2026-10-01 06:10] verdict: REJECT');
  });

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

  it('reads the training cycle: its log, early-stop summary and gate verdict', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'flint-brain-'));
    const cycle = join(dir, 'cycles', '20261001-0230');
    mkdirSync(join(cycle, 'adapter'), { recursive: true });
    // cycles/latest is a symlink in production; a plain dir reads the same.
    mkdirSync(join(dir, 'cycles', 'latest'), { recursive: true });
    writeFileSync(join(dir, 'upgrade.out'), DONE);
    writeFileSync(join(dir, 'cycles', 'latest', 'cycle.log'), CYCLE_DONE);
    // The cycle log is newer than the retired 70B log.
    utimesSync(join(dir, 'upgrade.out'), new Date('2026-09-23T00:00:00Z'), new Date('2026-09-23T00:00:00Z'));
    writeFileSync(
      join(dir, 'cycles', 'state.json'),
      JSON.stringify({ cycles: [{ id: '20261001-0230', result: 'REJECT', profile: 'muse-glimmer-30b', targets: 312, candidate: 'flint-muse:c20261001-0230' }] }),
    );
    writeFileSync(join(cycle, 'adapter', 'early_stop.json'), JSON.stringify({ exit: 'CANDIDATE', base_val: 1.9, best_val: 1.71, best_iter: 400, stop_reason: 'patience: 3 evals', peakMemoryGbMlx: 27.4 }));
    writeFileSync(join(cycle, 'gate.json'), JSON.stringify({ decision: { verdict: 'REJECT', reasons: ['strict win rate vs the frontier model 14.1% → 16.0% (+1.9 pts; need +5.0 pts)'] } }));
    const s = await readTrainingStatus({
      brainDir: dir,
      corpus: () => ({ total: 900, teacher: 800, student: 100 }),
      serving: () => ({ local: 'ollama:muse-glimmer:30b' }),
      isRunning: async () => false,
    });
    expect(s.latestRun?.kind).toMatch(/training cycle/);
    expect(s.latestRun?.phase).toBe('complete');
    expect(s.latestRun?.bestVal).toEqual({ iter: 400, loss: 1.71 });
    expect(s.latestRun?.result?.some((l) => l.includes('verdict: REJECT'))).toBe(true);
    expect(s.latestCycle).toMatchObject({
      id: '20261001-0230',
      result: 'REJECT',
      targets: 312,
      training: { exit: 'CANDIDATE', bestVal: 1.71, bestStep: 400, peakMemoryGb: 27.4 },
      gate: { verdict: 'REJECT' },
    });
    expect(s.servingNow.fineTunedServing).toBe(false);
  });

  it('a cycle that ends before training reads as finished, not stopped', () => {
    const r = parseRunLog('[2026-10-01 02:30] cycle 20261001-0230: profile=muse-glimmer-30b\n[2026-10-01 02:30] NO_DATA (see /x/manifest.json)\n', false);
    expect(r.phase).toBe('complete');
    expect(r.result).toEqual(['[2026-10-01 02:30] NO_DATA (see /x/manifest.json)']);
    // The gate's free preflight stopping a cycle before any training is an ending too.
    const u = parseRunLog(
      '[2026-10-01 02:30] cycle 20261001-0230: profile=muse-glimmer-30b\n[2026-10-01 02:31] UNGATEABLE: the gate would HOLD this data\'s candidate unjudged (see /x/gate.json): nothing trained\n',
      false,
    );
    expect(u.phase).toBe('complete');
    expect(u.result?.[0]).toMatch(/UNGATEABLE/);
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
