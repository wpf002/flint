import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CorpusTally, corpusNote, corpusSourceOf, corpusTargetRefusal, isVendorWrittenPrompt, type TargetRefusal } from '../src/corpus-sources';
import { TrainingLogger } from '../src/training';
import { corpusView, parseLaunchd, readTrainingStatus } from '../src/training-status';

// Corpus rows in the shape the server writes (./training TrainingRecord), with what
// training v2's provenance.py decides for each. apps/train/mlx/tests/test_provenance.py
// checks the same file against provenance.py itself, so the port can't drift from it.
interface Case {
  conversationId: string;
  brain?: string;
  model: string;
  refusal: TargetRefusal;
  vendorPrompt: boolean;
}
const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/corpus-provenance.json', import.meta.url), 'utf8')) as { corpus: Case[]; edge: Case[] };
const ROWS = FIXTURE.corpus.map(({ refusal: _r, vendorPrompt: _v, ...r }, i) => ({ ts: 1_780_000_000_000 + i, id: i + 1, input: `question ${i}`, output: `answer ${i}`, tools: [], ...r }));

function fixtureCorpus(dir: string): string {
  const path = join(dir, 'corpus.jsonl');
  writeFileSync(path, [...ROWS.map((r) => JSON.stringify(r)), '{"torn line', ''].join('\n'));
  return path;
}

describe('corpusSourceOf', () => {
  it('names the seeding scripts by their conversation id prefix, and /generate by its fixed id', () => {
    expect(corpusSourceOf('seed-4')).toBe('seed');
    expect(corpusSourceOf('bulk-880')).toBe('bulk');
    expect(corpusSourceOf('grow_7')).toBe('grow');
    expect(corpusSourceOf('Verify-1')).toBe('verify');
    expect(corpusSourceOf('generate')).toBe('generate');
  });

  it("counts everything else as Will's own chats", () => {
    for (const id of ['console', 'default', 'c1783820981374', 'seed', 'seeds-1', 'generated', 'w0', '']) {
      expect(corpusSourceOf(id), id).toBe('conversations');
    }
  });
});

describe('corpusTargetRefusal (provenance.py teacher_of_corpus_row + judge_target)', () => {
  it.each([...FIXTURE.corpus, ...FIXTURE.edge])('$conversationId $brain $model → $refusal', (c) => {
    expect(corpusTargetRefusal(c)).toBe(c.refusal);
    expect(isVendorWrittenPrompt(c.conversationId)).toBe(c.vendorPrompt);
  });

  it('refuses a frontier-brain answer even from an open model: the row is kind "frontier", never "open-weight"', () => {
    expect(corpusTargetRefusal({ brain: 'frontier', model: 'ollama:qwen3.8:27b' })).toBe('unknown-provenance');
    expect(corpusTargetRefusal({ brain: 'frontier', model: '' })).toBe('unknown-provenance');
  });

  it('checks for a vendor model first, whatever the brain', () => {
    expect(corpusTargetRefusal({ brain: 'local', model: 'anthropic:claude-opus-5-5' })).toBe('frontier-vendor-output');
  });
});

describe('the corpus breakdown', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('TrainingLogger counts a fixture corpus by origin, by why each answer is refused, and by usable prompt', () => {
    dir = mkdtempSync(join(tmpdir(), 'flint-corpus-'));
    const s = new TrainingLogger(fixtureCorpus(dir)).stats();
    expect(s.total).toBe(14); // the torn line is skipped
    expect(s.breakdown).toEqual({
      sources: { conversations: 6, seed: 2, bulk: 2, grow: 1, verify: 1, generate: 2 },
      realConversations: 6,
      synthetic: 8,
      eligibleTargets: 0,
      refusedTargets: { 'frontier-vendor-output': 7, 'unknown-provenance': 2, 'local-unverified': 5 },
      promptsForSampling: 11, // every row but bulk-12, bulk-13, grow-3
      promptsForSamplingFromChats: 6,
    });
  });

  it('keeps counting as new rows are logged', () => {
    dir = mkdtempSync(join(tmpdir(), 'flint-corpus-'));
    const logger = new TrainingLogger(fixtureCorpus(dir));
    logger.log({ conversationId: 'console', brain: 'frontier', model: 'anthropic:claude-opus-5-5', input: 'how are you?', output: 'Running clean.', tools: [] }, 1);
    logger.log({ conversationId: 'console', brain: 'local', model: 'muse-glimmer:30b', input: 'keep it local: my bloodwork', output: 'Here is the read.', tools: [] }, 2);
    // incomplete pairs aren't logged, so they aren't counted either
    logger.log({ conversationId: 'console', brain: 'local', model: 'muse-glimmer:30b', input: 'hi', output: '  ', tools: [] }, 3);
    const b = logger.stats().breakdown;
    expect(b.realConversations).toBe(8);
    expect(b.eligibleTargets).toBe(0);
    expect(b.refusedTargets).toEqual({ 'frontier-vendor-output': 8, 'unknown-provenance': 2, 'local-unverified': 6 });
    expect(b.promptsForSamplingFromChats).toBe(8);
  });

  it('training_status leads with what can be trained on (nothing), then why', async () => {
    dir = mkdtempSync(join(tmpdir(), 'flint-corpus-'));
    const logger = new TrainingLogger(fixtureCorpus(dir));
    const s = await readTrainingStatus({
      brainDir: dir,
      corpus: () => logger.stats(),
      serving: () => ({ local: 'ollama:muse-glimmer:30b', frontier: 'anthropic:claude-opus-5-5' }),
      isRunning: async () => false,
      trainingJobs: async () => undefined,
    });
    const note = s.corpusNote ?? '';
    // The answer first: no corpus answer is a target; only prompts can be re-answered.
    expect(note.startsWith("0 of 14 corpus answers can be used as training targets today; at most 11 prompts (6 from Will's own chats) could be re-answered by a permitted teacher.")).toBe(true);
    expect(note).toContain("Of the 14 rows, 6 come from Will's own chats; the other 8 are synthetic");
    expect(note).toContain('seed/bulk/grow/verify: 6, one-shot /generate calls: 2');
    expect(note).toContain("7 were written by a frontier vendor's model (Claude, GPT), and the vendors' terms bar using their outputs as training targets");
    expect(note).toContain('2 are other frontier-brain answers, which it refuses as unknown provenance');
    expect(note).toContain('5 are local-model answers, which count only after passing a verifiable check that corpus rows never record');
    // No wording that frames an open model's frontier-brain answer as usable, or a vendor's answer as a teacher's.
    expect(note).not.toMatch(/eligible pool|written by an open model/);
    // the job state couldn't be read: the field is left out, not guessed
    expect(s).not.toHaveProperty('trainingJobs');
  });

  it('training_status names the answer counts for who answered, not "teacher"/"student", and leads the corpus with the eligible count', async () => {
    dir = mkdtempSync(join(tmpdir(), 'flint-corpus-'));
    const logger = new TrainingLogger(fixtureCorpus(dir));
    const s = await readTrainingStatus({
      brainDir: dir,
      corpus: () => logger.stats(),
      serving: () => ({ local: 'ollama:muse-glimmer:30b' }),
      isRunning: async () => false,
      trainingJobs: async () => undefined,
    });
    expect(Object.keys(s.corpus)).toEqual(['eligibleTargets', 'promptsForSampling', 'total', 'frontierAnswers', 'localAnswers', 'breakdown']);
    expect(s.corpus).toMatchObject({ eligibleTargets: 0, promptsForSampling: 11, total: 14, frontierAnswers: 9, localAnswers: 5 });
    expect(JSON.stringify(s)).not.toMatch(/"(teacher|student)"/);
    // The note comes before the numbers it explains.
    const keys = Object.keys(s);
    expect(keys.indexOf('corpusNote')).toBeLessThan(keys.indexOf('corpus'));
    // GET /training (TrainingLogger.stats) keeps its old keys: the change there is additive.
    expect(logger.stats()).toMatchObject({ total: 14, teacher: 9, student: 5 });
  });

  it('without a breakdown the corpus view is just the renamed counts', () => {
    expect(corpusView({ total: 3, teacher: 2, student: 1 })).toEqual({ total: 3, frontierAnswers: 2, localAnswers: 1 });
  });

  it('an empty corpus reads as zeros', () => {
    const b = new CorpusTally().snapshot();
    expect(b.realConversations + b.synthetic).toBe(0);
    expect(corpusNote(b)).toMatch(/^0 of 0 corpus answers can be used as training targets today; at most 0 prompts/);
  });
});

describe('the training jobs (launchd)', () => {
  // As printed on the Studio (macOS 27), trimmed.
  const PRINT_DISABLED = `disabled services = {
		"com.flint.ollama" => enabled
		"com.flint.retrain" => disabled
		"com.flint.server" => enabled
		"com.flint.grow" => disabled
	}
login item associations = {
	}
`;
  const LIST = `PID\tStatus\tLabel
73093\t0\tcom.flint.searxng
-\t0\tcom.flint.deploy
58221\t0\tcom.flint.ollama
31655\t0\tcom.flint.server
`;

  it('reads both jobs as disabled on the Studio', () => {
    const jobs = parseLaunchd(PRINT_DISABLED, LIST);
    expect(jobs['com.flint.retrain']).toMatchObject({ enabled: false, state: 'disabled' });
    expect(jobs['com.flint.grow']).toMatchObject({ enabled: false, state: 'disabled' });
    expect(jobs['com.flint.retrain']?.what).toMatch(/weekly retrain/);
  });

  it('a loaded job is enabled; one with no override and not loaded is just not loaded', () => {
    const jobs = parseLaunchd('"com.flint.grow" => false\n', `${LIST}-\t0\tcom.flint.retrain\n`);
    expect(jobs['com.flint.retrain']).toMatchObject({ enabled: true, state: 'enabled' });
    expect(jobs['com.flint.grow']).toMatchObject({ enabled: false, state: 'not loaded' });
  });

  it('understands the older "=> true" form of print-disabled', () => {
    expect(parseLaunchd('"com.flint.retrain" => true\n', LIST)['com.flint.retrain']?.state).toBe('disabled');
  });

  it('training_status carries the job state when it can be read', async () => {
    const d = mkdtempSync(join(tmpdir(), 'flint-brain-'));
    try {
      const s = await readTrainingStatus({
        brainDir: d,
        corpus: () => ({ total: 0, teacher: 0, student: 0 }),
        serving: () => ({ local: 'ollama:muse-glimmer:30b' }),
        isRunning: async () => false,
        trainingJobs: async () => parseLaunchd(PRINT_DISABLED, LIST),
      });
      expect(s.trainingJobs?.['com.flint.retrain']?.state).toBe('disabled');
      // no breakdown from the corpus source, no note
      expect(s).not.toHaveProperty('corpusNote');
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});
