import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HISTORY_HEADER, appendHistory, historyRow, renderMarkdown, summarize, winRate, type JudgmentRow } from '../src/report.js';
import { parseSecrets } from '../src/secrets.js';
import { resolveFlintToken } from '../src/contestants.js';

const j = (competitor: string, category: string, outcome: 'win' | 'loss' | 'tie' | null): JudgmentRow => ({
  promptId: Math.random().toString(36).slice(2),
  category,
  competitor,
  competitorModel: `${competitor}-model`,
  judgeModel: 'judge',
  flintIsA: true,
  ok: outcome !== null,
  ...(outcome ? { outcome, verdict: outcome === 'tie' ? 'TIE' : outcome === 'win' ? 'A' : 'B' } : { error: 'parse' }),
  costUsd: 0,
  ts: 0,
});

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('summarize', () => {
  it('tallies per competitor and per category, excluding judge failures', () => {
    const rows = [
      ...Array.from({ length: 9 }, () => j('openai', 'research', 'win')),
      j('openai', 'coding', 'loss'),
      j('openai', 'coding', 'tie'),
      j('openai', 'coding', null),
      j('claude', 'knowledge', 'loss'),
    ];
    const [claude, openai] = summarize(rows);
    expect(openai!.total).toEqual({ wins: 9, losses: 1, ties: 1 });
    expect(openai!.judgeErrors).toBe(1);
    expect(openai!.signal).toBe('SIGNIFICANT');
    expect(openai!.byCategory.research).toMatchObject({ wins: 9, losses: 0, ties: 0 });
    expect(openai!.byCategory.coding).toMatchObject({ wins: 0, losses: 1, ties: 1 });
    expect(claude!.signal).toBe('NOISE');
    expect(winRate({ wins: 1, losses: 1, ties: 2 })).toBe(0.5);
  });

  it('writes a history header once and one row per competitor', () => {
    dir = mkdtempSync(join(tmpdir(), 'parity-'));
    const path = join(dir, 'h.csv');
    const s = summarize([j('openai', 'research', 'win')]);
    appendHistory(path, s.map((x) => historyRow('run1', 'set.jsonl', x, 'T')));
    appendHistory(path, s.map((x) => historyRow('run2', 'set.jsonl', x, 'T')));
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    expect(lines[0]).toBe(HISTORY_HEADER);
    expect(lines.length).toBe(3);
    expect(lines[2]).toContain('run2,set.jsonl,openai,openai-model,judge,1,1,0,0');
  });

  it('renders a report that names the signal', () => {
    const md = renderMarkdown({
      run: 'r',
      promptSet: 'p',
      promptCount: 1,
      contestants: [{ name: 'flint', model: 'f' }],
      answers: [{ promptId: 'x', contestant: 'flint', model: 'f', ok: false, error: 'ollama down', costUsd: 0, ms: 1, ts: 0 }],
      summaries: summarize([j('openai', 'research', 'win')]),
      spendUsd: 0.1,
      budgetUsd: 1,
      stoppedForBudget: false,
      notes: [],
    });
    expect(md).toContain('| openai (`openai-model`) | 1 | 0 | 0 |');
    expect(md).toContain('ollama down');
  });
});

describe('secrets + token', () => {
  it('parses the same KEY=value format as the server', () => {
    expect(parseSecrets('# c\nA=1\n\nB="two"\nC=\'3\'\nnoeq\n D = x=y ')).toEqual({ A: '1', B: 'two', C: '3', D: 'x=y' });
  });

  it('prefers $FLINT_TOKEN, then the token file', () => {
    dir = mkdtempSync(join(tmpdir(), 'parity-'));
    const tokenFile = join(dir, 'token');
    writeFileSync(tokenFile, 'from-file\n');
    const plist = join(dir, 'missing.plist');
    expect(resolveFlintToken({ env: { FLINT_TOKEN: 'from-env' }, tokenFile, plist })).toBe('from-env');
    expect(resolveFlintToken({ env: {}, tokenFile, plist })).toBe('from-file');
    expect(resolveFlintToken({ env: {}, tokenFile: join(dir, 'nope'), plist })).toBeUndefined();
  });
});
