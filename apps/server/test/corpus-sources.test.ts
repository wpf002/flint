import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CorpusTally, corpusNote, corpusSourceOf, isVendorWritten } from '../src/corpus-sources';
import { TrainingLogger } from '../src/training';
import { parseLaunchd, readTrainingStatus } from '../src/training-status';

// A fixture corpus in the shape the server writes (./training TrainingRecord).
const ROWS = [
  { conversationId: 'console', brain: 'frontier', model: 'anthropic:claude-opus-5-5' },
  { conversationId: 'console', brain: 'local', model: 'muse-glimmer:30b' },
  { conversationId: 'c1783820981374', brain: 'frontier', model: 'claude-sonnet-4-6' },
  { conversationId: 'c1783820981374', brain: 'local', model: 'qwen2.5:7b' },
  // a local big model configured as the frontier (FLINT_FRONTIER_*): open weights, not a vendor
  { conversationId: 'default', brain: 'frontier', model: 'ollama:qwen3.8:27b' },
  // a frontier row from before model labels: the frontier was always Claude then
  { conversationId: 'w0', brain: 'frontier', model: '' },
  { conversationId: 'seed-1', brain: 'frontier', model: 'claude-sonnet-4-6' },
  { conversationId: 'seed-2', brain: 'local', model: 'qwen2.5:3b' },
  { conversationId: 'bulk-12', brain: 'frontier', model: 'claude-sonnet-4-6' },
  { conversationId: 'bulk-13', brain: 'frontier', model: 'claude-sonnet-4-6' },
  { conversationId: 'grow-3', brain: 'frontier', model: 'claude-sonnet-4-6' },
  { conversationId: 'verify-2', brain: 'local', model: 'qwen2.5:7b' },
  { conversationId: 'generate', brain: 'frontier', model: 'openai:gpt-5' },
  { conversationId: 'generate', brain: 'local', model: 'muse-glimmer:30b' },
].map((r, i) => ({ ts: 1_780_000_000_000 + i, id: i + 1, input: `question ${i}`, output: `answer ${i}`, tools: [], ...r }));

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

describe('isVendorWritten (provenance.py FRONTIER_VENDOR)', () => {
  it("flags a frontier vendor's model, labelled or bare", () => {
    for (const model of ['anthropic:claude-opus-5-5', 'claude-sonnet-4-6', 'openai:gpt-5', 'gpt-5', 'o3', 'o4-mini', 'perplexity:sonar-pro', 'sonar', 'gemini-2.5-pro', 'google:gemini-2.5', 'xai:grok-4']) {
      expect(isVendorWritten({ brain: 'frontier', model }), model).toBe(true);
    }
  });

  it('passes an open model, wherever it answered', () => {
    for (const model of ['muse-glimmer:30b', 'qwen2.5:7b', 'ollama:qwen3.8:27b', 'mlx-community/Muse-Glimmer-30B-4bit', 'ollama:gpt-oss:20b']) {
      expect(isVendorWritten({ brain: 'local', model }), model).toBe(false);
      expect(isVendorWritten({ brain: 'frontier', model }), model).toBe(false);
    }
  });

  it('treats an unlabelled frontier row as Claude, and an unlabelled local row as the local model', () => {
    expect(isVendorWritten({ brain: 'frontier', model: '' })).toBe(true);
    expect(isVendorWritten({ brain: 'frontier' })).toBe(true);
    expect(isVendorWritten({ brain: 'local' })).toBe(false);
  });
});

describe('the corpus breakdown', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('TrainingLogger counts a fixture corpus by origin and by who wrote the answer', () => {
    dir = mkdtempSync(join(tmpdir(), 'flint-corpus-'));
    const s = new TrainingLogger(fixtureCorpus(dir)).stats();
    expect(s.total).toBe(14); // the torn line is skipped
    expect(s.breakdown).toEqual({
      sources: { conversations: 6, seed: 2, bulk: 2, grow: 1, verify: 1, generate: 2 },
      realConversations: 6,
      synthetic: 8,
      vendorWritten: 8,
      openModelAnswers: 6,
      openModelAnswersInConversations: 3,
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
    expect(b.vendorWritten).toBe(9);
    expect(b.openModelAnswersInConversations).toBe(4);
  });

  it("training_status reports the breakdown and says plainly that vendor answers aren't trainable", async () => {
    dir = mkdtempSync(join(tmpdir(), 'flint-corpus-'));
    const logger = new TrainingLogger(fixtureCorpus(dir));
    const s = await readTrainingStatus({
      brainDir: dir,
      corpus: () => logger.stats(),
      serving: () => ({ local: 'ollama:muse-glimmer:30b', frontier: 'anthropic:claude-opus-5-5' }),
      isRunning: async () => false,
      trainingJobs: async () => undefined,
    });
    expect(s.corpus.total).toBe(14);
    expect(s.corpus.breakdown?.realConversations).toBe(6);
    const note = s.corpusNote ?? '';
    expect(note).toContain("Of 14 corpus rows, 6 come from Will's own chats; the other 8 are synthetic");
    expect(note).toContain('seed/bulk/grow/verify: 6, one-shot /generate calls: 2');
    expect(note).toMatch(/never uses a Claude- or GPT-written answer as a target/);
    expect(note).toMatch(/eligible pool is real, human-written or open-model data only/);
    expect(note).toContain("8 of these answers were written by a frontier vendor's model and are excluded");
    expect(note).toContain("6 were written by an open model (3 of them in Will's own chats)");
    // the job state couldn't be read: the field is left out, not guessed
    expect(s).not.toHaveProperty('trainingJobs');
  });

  it('an empty corpus reads as zeros', () => {
    const b = new CorpusTally().snapshot();
    expect(b.realConversations + b.synthetic).toBe(0);
    expect(corpusNote(b)).toContain('Of 0 corpus rows, 0 come from');
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
