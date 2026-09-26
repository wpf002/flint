/**
 * Where the training corpus's rows came from, and whether their answers could
 * ever be training targets. Flint once told Will "only 827 examples come from our
 * own conversations" when the 827 were the whole corpus and most of it was seeding
 * scripts' questions answered by Claude. training_status now counts the parts.
 *
 * The rules are ports of the ones training v2 applies (apps/train/mlx), so the
 * counts here are what its data builder would decide for these rows:
 *  - the conversation id prefixes of the retired seeding scripts
 *    (parity_text.py _SYNTHETIC_CONV = apps/parity prompts.ts SYNTHETIC_CONV), and
 *    of the two whose questions Claude wrote (provenance.py prompt_origin);
 *  - which answers may be a target (provenance.py teacher_of_corpus_row +
 *    judge_target): none. corpusTargetRefusal says why for each row.
 * test/fixtures/corpus-provenance.json holds the cases both sides are checked
 * against (apps/train/mlx/tests/test_provenance.py reads it too).
 */

/** A seeding script's conversation id: seed_corpus.py (seed-N), bulk_seed.py (bulk-N), auto_grow.py (grow-N), verify-N. */
const SEEDING_SCRIPT = /^(seed|bulk|grow|verify)[-_]/i;

/** provenance.py _FRONTIER_WRITTEN_PROMPT: bulk_seed.py and auto_grow.py had Claude write the questions. */
const VENDOR_WRITTEN_PROMPT = /^(bulk|grow)[-_]/i;

/** provenance.py FRONTIER_VENDOR, verbatim: a frontier vendor's hosted model. */
const FRONTIER_VENDOR =
  /^(anthropic|openai|perplexity|google|gemini|vertex|bedrock|amazon|xai|azure)[:/]|^(claude|gpt-|chatgpt|o[1-9]\b|o[1-9]-|sonar|gemini|nova-|grok|command-r)/i;

export type CorpusSource = 'conversations' | 'seed' | 'bulk' | 'grow' | 'verify' | 'generate';

/**
 * `generate` is the server's one-shot /generate endpoint (scripts and early eval
 * replays, logged under that fixed id): a prompt, not a conversation with Will.
 * Everything else came through /chat under a conversation id no script uses.
 */
export function corpusSourceOf(conversationId: string): CorpusSource {
  const m = SEEDING_SCRIPT.exec(conversationId);
  if (m) return m[1]!.toLowerCase() as CorpusSource;
  if (conversationId === 'generate') return 'generate';
  return 'conversations';
}

/** provenance.py prompt_origin == "frontier-generated": a vendor model wrote the question, so it's dropped too. */
export function isVendorWrittenPrompt(conversationId: string): boolean {
  return VENDOR_WRITTEN_PROMPT.test(conversationId);
}

/**
 * Why training v2 refuses a corpus row's answer as a target:
 *  - 'frontier-vendor-output': the model is a frontier vendor's (Claude, GPT,
 *    Perplexity, Gemini...). Checked first, whatever the brain: the vendors' terms
 *    bar using their outputs as training targets.
 *  - 'unknown-provenance': any other brain=frontier row, an open model or no model
 *    at all. A corpus row has no teacher block, so provenance.py calls it kind
 *    "frontier", which isn't on its allow-list (human, self, open-weight).
 *  - 'local-unverified': a brain=local answer is a self-sample with no recorded
 *    check, and a self-sample counts only after passing a verifiable one. (provenance.py
 *    says 'self-sample-unverified', or 'self-sample-from-another-model' when the
 *    model is missing or not the profile's base family; either way, refused.)
 */
export type TargetRefusal = 'frontier-vendor-output' | 'unknown-provenance' | 'local-unverified';

/**
 * provenance.py teacher_of_corpus_row + judge_target for one corpus row. There is no
 * "accepted" result: nothing a corpus row records can pass, so every corpus answer
 * is refused. Targets come from elsewhere (Will's own rewrites, verified
 * self-samples, a permitted open-weight teacher's answers to the sampled prompts).
 */
export function corpusTargetRefusal(row: { brain?: unknown; model?: unknown }): TargetRefusal {
  const model = typeof row.model === 'string' ? row.model.trim() : '';
  if (model && FRONTIER_VENDOR.test(model)) return 'frontier-vendor-output';
  return row.brain === 'frontier' ? 'unknown-provenance' : 'local-unverified';
}

export interface CorpusBreakdown {
  /** Rows per origin. */
  sources: Record<CorpusSource, number>;
  /** Rows from Will's own chats (includes early test chats; no seeding script, no /generate). */
  realConversations: number;
  /** Rows from seeding scripts or one-shot /generate calls. */
  synthetic: number;
  /** Corpus answers training v2 would use as a target: 0, since it refuses every one (corpusTargetRefusal). */
  eligibleTargets: number;
  /** The refused answers, by reason. */
  refusedTargets: Record<TargetRefusal, number>;
  /**
   * Prompts no vendor model wrote (every row but bulk/grow): the most training v2
   * could hand a permitted teacher to answer. An upper bound: its data builder
   * also drops trivial, eval-overlapping and duplicate prompts.
   */
  promptsForSampling: number;
  /** ...of which from Will's own chats. */
  promptsForSamplingFromChats: number;
}

/** Counts rows as they're read or logged. */
export class CorpusTally {
  private readonly sources: Record<CorpusSource, number> = { conversations: 0, seed: 0, bulk: 0, grow: 0, verify: 0, generate: 0 };
  private readonly refused: Record<TargetRefusal, number> = { 'frontier-vendor-output': 0, 'unknown-provenance': 0, 'local-unverified': 0 };
  private prompts = 0;
  private promptsFromChats = 0;

  add(row: { conversationId?: unknown; brain?: unknown; model?: unknown }): void {
    const conversationId = typeof row.conversationId === 'string' ? row.conversationId : '';
    const source = corpusSourceOf(conversationId);
    this.sources[source]++;
    this.refused[corpusTargetRefusal(row)]++;
    if (!isVendorWrittenPrompt(conversationId)) {
      this.prompts++;
      if (source === 'conversations') this.promptsFromChats++;
    }
  }

  snapshot(): CorpusBreakdown {
    const real = this.sources.conversations;
    const total = Object.values(this.sources).reduce((a, b) => a + b, 0);
    return {
      sources: { ...this.sources },
      realConversations: real,
      synthetic: total - real,
      eligibleTargets: 0,
      refusedTargets: { ...this.refused },
      promptsForSampling: this.prompts,
      promptsForSamplingFromChats: this.promptsFromChats,
    };
  }
}

/** What training_status says about the breakdown, in words Flint can repeat straight. It leads with the answer. */
export function corpusNote(b: CorpusBreakdown): string {
  const total = b.realConversations + b.synthetic;
  const r = b.refusedTargets;
  return (
    `${b.eligibleTargets} of ${total} corpus answers can be used as training targets today; ` +
    `at most ${b.promptsForSampling} prompts (${b.promptsForSamplingFromChats} from Will's own chats) could be re-answered by a permitted teacher. ` +
    `Of the ${total} rows, ${b.realConversations} come from Will's own chats; the other ${b.synthetic} are synthetic ` +
    `(seeding scripts seed/bulk/grow/verify: ${b.sources.seed + b.sources.bulk + b.sources.grow + b.sources.verify}, one-shot /generate calls: ${b.sources.generate}). ` +
    `Why no answer qualifies under training v2: ${r['frontier-vendor-output']} were written by a frontier vendor's model (Claude, GPT), and the vendors' terms bar using their outputs as training targets; ` +
    `${r['unknown-provenance']} are other frontier-brain answers, which it refuses as unknown provenance; ` +
    `${r['local-unverified']} are local-model answers, which count only after passing a verifiable check that corpus rows never record. ` +
    `The prompt count leaves out bulk/grow questions (Claude wrote those too) and is before trivial, eval-overlapping and duplicate prompts are dropped.`
  );
}
