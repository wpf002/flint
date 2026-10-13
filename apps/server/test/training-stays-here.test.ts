import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TrainingLogger, type TrainingRecord } from '../src/training';
// The eval harness's own builder: the set it makes goes to outside competitors and judges.
import { buildPromptSet, staysOnThisMac } from '../../parity/src/prompts.js';

/**
 * The final review's M4. A turn that stayed on this Mac (private, or any turn
 * of Local mode) was written to the training corpus like any other row, and
 * apps/parity builds prompt sets from that file for outside models and judges.
 *
 * The row is kept (it is what a model on this Mac learns from) and it is
 * written WITH a mark. Both ends are run here: the server's writer, and the
 * harness's reader on the file the writer made.
 */

const SECRET = 'What should I tell my doctor about the ZEBRA-7781 diagnosis I got last week?';
const OPEN = 'How do transformers compare with state space models for very long documents?';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function corpus(): { log: TrainingLogger; rows: () => TrainingRecord[] } {
  const dir = mkdtempSync(join(tmpdir(), 'flint-corpus-'));
  dirs.push(dir);
  const path = join(dir, 'corpus.jsonl');
  return { log: new TrainingLogger(path), rows: () => readFileSync(path, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as TrainingRecord) };
}

describe('a turn that stays on this Mac, in the training corpus', () => {
  it('is written, with the mark; a turn that does not stay here is written as it always was', () => {
    const c = corpus();
    c.log.log({ conversationId: 'c1', brain: 'local', model: 'main-model:30b', input: SECRET, output: 'Tell them when it started.', tools: [], staysHere: true }, 1000);
    c.log.log({ conversationId: 'c1', brain: 'frontier', model: 'claude-big', input: OPEN, output: 'They trade attention for a recurrence.', tools: [] }, 2000);
    const [kept, open] = c.rows();
    expect(kept).toMatchObject({ id: 1, input: SECRET, brain: 'local', staysHere: true });
    expect(open).toMatchObject({ id: 2, input: OPEN, brain: 'frontier' });
    expect(Object.prototype.hasOwnProperty.call(open, 'staysHere')).toBe(false);
    // Both count: the row is training data, for a model on this Mac.
    expect(c.log.stats()).toMatchObject({ total: 2, teacher: 1, student: 1 });
  });

  it('the eval harness, reading that very file, never makes a prompt of the marked row', () => {
    const c = corpus();
    c.log.log({ conversationId: 'c1', brain: 'local', model: 'main-model:30b', input: SECRET, output: 'Tell them when it started.', tools: [], staysHere: true }, 1000);
    c.log.log({ conversationId: 'c2', brain: 'frontier', model: 'claude-big', input: OPEN, output: 'They trade attention for a recurrence.', tools: [] }, 2000);
    const rows = c.rows();
    expect(rows.map((r) => staysOnThisMac(r))).toEqual([true, false]);
    const { prompts, stats } = buildPromptSet(rows, { seed: 1, max: 300 });
    expect(prompts.map((p) => p.prompt)).toEqual([OPEN]);
    expect(JSON.stringify(prompts)).not.toContain('ZEBRA-7781');
    expect(stats).toMatchObject({ corpusRows: 2, keptHere: 1 });
  });

  it('the mark survives a restart: the logger reads the file back and keeps counting from it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flint-corpus-'));
    dirs.push(dir);
    const path = join(dir, 'corpus.jsonl');
    new TrainingLogger(path).log({ conversationId: 'c1', brain: 'local', model: 'm', input: SECRET, output: 'an answer', tools: [], staysHere: true }, 1);
    const again = new TrainingLogger(path);
    again.log({ conversationId: 'c1', brain: 'local', model: 'm', input: OPEN, output: 'another answer', tools: [] }, 2);
    const rows = readFileSync(path, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as TrainingRecord);
    expect(rows.map((r) => [r.id, r.staysHere === true])).toEqual([[1, true], [2, false]]);
  });
});
