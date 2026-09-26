/**
 * Where the training corpus's rows came from, and whether their answers could
 * ever be training targets. Flint once told Will "only 827 examples come from our
 * own conversations" when the 827 were the whole corpus and most of it was seeding
 * scripts' questions answered by Claude. training_status now counts the parts.
 *
 * Both rules are ports of the ones training v2 applies (apps/train/mlx), so the
 * numbers here are the numbers the data builder would see:
 *  - the conversation id prefixes of the retired seeding scripts
 *    (parity_text.py _SYNTHETIC_CONV = apps/parity prompts.ts SYNTHETIC_CONV);
 *  - the frontier-vendor model names (provenance.py FRONTIER_VENDOR), whose
 *    answers are never a target: their terms bar using outputs as training targets.
 */

/** A seeding script's conversation id: seed_corpus.py (seed-N), bulk_seed.py (bulk-N), auto_grow.py (grow-N), verify-N. */
const SEEDING_SCRIPT = /^(seed|bulk|grow|verify)[-_]/i;

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

/**
 * Whether a row's answer was written by a frontier vendor's model (Claude, GPT,
 * Perplexity, Gemini...). The corpus labels those `anthropic:claude-…` or bare
 * `claude-…`; a frontier row with no model at all predates the labels, and the
 * frontier was always Claude then.
 */
export function isVendorWritten(row: { brain?: unknown; model?: unknown }): boolean {
  const model = typeof row.model === 'string' ? row.model.trim() : '';
  if (model) return FRONTIER_VENDOR.test(model);
  return row.brain === 'frontier';
}

export interface CorpusBreakdown {
  /** Rows per origin. */
  sources: Record<CorpusSource, number>;
  /** Rows from Will's own chats (includes early test chats; no seeding script, no /generate). */
  realConversations: number;
  /** Rows from seeding scripts or one-shot /generate calls. */
  synthetic: number;
  /** Answers a frontier vendor's model wrote: never a training target under training v2. */
  vendorWritten: number;
  /** Answers an open (local) model wrote: the only corpus answers the terms rule allows. */
  openModelAnswers: number;
  /** ...of which in Will's own chats. */
  openModelAnswersInConversations: number;
}

/** Counts rows as they're read or logged. */
export class CorpusTally {
  private readonly sources: Record<CorpusSource, number> = { conversations: 0, seed: 0, bulk: 0, grow: 0, verify: 0, generate: 0 };
  private vendor = 0;
  private open = 0;
  private openInConversations = 0;

  add(row: { conversationId?: unknown; brain?: unknown; model?: unknown }): void {
    const source = corpusSourceOf(typeof row.conversationId === 'string' ? row.conversationId : '');
    this.sources[source]++;
    if (isVendorWritten(row)) {
      this.vendor++;
    } else {
      this.open++;
      if (source === 'conversations') this.openInConversations++;
    }
  }

  snapshot(): CorpusBreakdown {
    const real = this.sources.conversations;
    const total = Object.values(this.sources).reduce((a, b) => a + b, 0);
    return {
      sources: { ...this.sources },
      realConversations: real,
      synthetic: total - real,
      vendorWritten: this.vendor,
      openModelAnswers: this.open,
      openModelAnswersInConversations: this.openInConversations,
    };
  }
}

/** What training_status says about the breakdown, in words Flint can repeat straight. */
export function corpusNote(b: CorpusBreakdown): string {
  const total = b.realConversations + b.synthetic;
  return (
    `Of ${total} corpus rows, ${b.realConversations} come from Will's own chats; the other ${b.synthetic} are synthetic ` +
    `(seeding scripts seed/bulk/grow/verify: ${b.sources.seed + b.sources.bulk + b.sources.grow + b.sources.verify}, one-shot /generate calls: ${b.sources.generate}). ` +
    `Training v2 never uses a Claude- or GPT-written answer as a target (the vendors' terms restrict training models on their outputs), ` +
    `so the eligible pool is real, human-written or open-model data only: ${b.vendorWritten} of these answers were written by a frontier vendor's model and are excluded; ` +
    `${b.openModelAnswers} were written by an open model (${b.openModelAnswersInConversations} of them in Will's own chats), and even those count as targets only after passing a verifiable check, which corpus rows don't record. ` +
    `bulk/grow questions were written by Claude too and are dropped outright; Will's own questions can still be answered by a permitted teacher.`
  );
}
