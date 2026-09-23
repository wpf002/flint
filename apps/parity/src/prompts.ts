import { CATEGORIES, categorize, wordCount, type Category } from './categorize.js';
import { seededRng, sha, shuffle } from './util.js';

/** One row of ~/.flint/training/corpus.jsonl (apps/server/src/training.ts). */
export interface TrainingRecord {
  ts: number;
  id: number;
  conversationId: string;
  brain: 'local' | 'frontier';
  model: string;
  input: string;
  output: string;
  tools?: Array<{ tool: string; outcome?: string; ms?: number }>;
  usage?: unknown;
}

/** One frozen eval prompt. */
export interface EvalPrompt {
  /** sha of the normalized text: stable across rebuilds, so answer caches stay valid. */
  id: string;
  prompt: string;
  category: Category;
  /** organic = Will typed it; synthetic = a seeding script (bulk_seed/auto_grow) did. */
  source: 'organic' | 'synthetic';
  conversationId: string;
  sourceTs: number;
  /** Tools the original turn used (a hint at what the task needed). */
  tools: string[];
}

/** Conversation ids written by the seeding scripts in apps/train/mlx, not by Will. */
const SYNTHETIC_CONV = /^(bulk|grow|seed|verify)[-_]/i;

export function sourceOf(conversationId: string): 'organic' | 'synthetic' {
  return SYNTHETIC_CONV.test(conversationId) ? 'synthetic' : 'organic';
}

export function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const GREETING =
  /^(hey|hi|hello|yo|sup|howdy|good (morning|afternoon|evening|night)|gm|thanks|thank you|ty|ok|okay|cool|nice|great|awesome|lol|how are (you|we)|how'?s it going|what'?s up)\b/;
/** Replies that only make sense inside the conversation they came from. */
const FOLLOW_UP =
  /^(yes|yeah|yep|no|nope|nah|right|well|sure|go ahead|do it|continue|again|show it|that'?s|and|but|so|here are|here is|here's|i meant|i mean|i'?m referencing|i was referring)\b/;
/** Health checks and smoke tests typed at the API, not real asks. */
const PROBE = /^(say|reply( with)?|respond( with)?|repeat|echo|print|ping|test)\b|\b(answer with|one line|nothing else|reply with exactly)\b/;

/**
 * Prompts not worth a comparison: greetings, bare acknowledgements, follow-ups
 * that are meaningless out of their conversation, API probes, bare URLs.
 */
export function isTrivial(input: string): boolean {
  const n = normalize(input);
  const words = wordCount(n);
  if (words < 3) return true;
  if (/^https?:\/\/\S+$/.test(input.trim())) return true;
  if (GREETING.test(n) && words <= 10 && !/\?.*\S.*\?|\b(what|why|how|who|when|where|tell me)\b.{25,}/.test(n)) return true;
  if (FOLLOW_UP.test(n) && words <= 20) return true;
  if (PROBE.test(n) && words <= 16) return true;
  return false;
}

const STOPWORDS = new Set(
  (
    "a an the of in on at to for from by with and or but is are was were be been do does did you your i me my we our it its " +
    "this that these those what which who whom how why when where can could would should will shall may might about as into " +
    "than then there their they them he she his her so if not no just also more most some any all tell explain"
  ).split(' '),
);

/**
 * Content words only. On the full word set, two template questions that differ
 * in their one real noun ("explain the history of X and why it matters") score
 * 0.8 and look like duplicates; on content words they don't.
 */
function wordSet(s: string): Set<string> {
  return new Set(normalize(s).split(' ').filter((w) => w && !STOPWORDS.has(w)));
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Content-word Jaccard at or above this counts as the same question asked twice. */
export const NEAR_DUP_THRESHOLD = 0.8;

/**
 * Also a duplicate: one short ask that is (nearly) contained in another —
 * "who is fighting at UFC 329?" inside "Who is fighting in the UFC 329 main
 * event? Search the web." Only for sets of 3+ content words, so a two-word
 * prompt can't swallow every longer one that happens to share its words.
 */
export const CONTAINMENT_THRESHOLD = 0.8;

export function isNearDuplicate(a: Set<string>, b: Set<string>, threshold = NEAR_DUP_THRESHOLD): boolean {
  if (jaccard(a, b) >= threshold) return true;
  const small = a.size <= b.size ? a : b;
  const big = small === a ? b : a;
  if (small.size < 3) return false;
  let inter = 0;
  for (const w of small) if (big.has(w)) inter++;
  return inter / small.size >= CONTAINMENT_THRESHOLD;
}

/**
 * Drop exact and near duplicates, keeping the first in the given order. The
 * caller orders organic before synthetic and old before new, so the kept copy is
 * the most "real" one.
 */
export function dedupe<T extends { input: string }>(rows: readonly T[], threshold = NEAR_DUP_THRESHOLD): T[] {
  const kept: Array<{ row: T; words: Set<string>; norm: string }> = [];
  const seenExact = new Set<string>();
  for (const row of rows) {
    const norm = normalize(row.input);
    if (seenExact.has(norm)) continue;
    const words = wordSet(row.input);
    if (kept.some((k) => isNearDuplicate(k.words, words, threshold))) continue;
    seenExact.add(norm);
    kept.push({ row, words, norm });
  }
  return kept.map((k) => k.row);
}

export interface BuildOptions {
  seed: number;
  max: number;
}

export interface BuildResult {
  prompts: EvalPrompt[];
  stats: {
    corpusRows: number;
    trivial: number;
    duplicates: number;
    candidates: number;
    byCategory: Record<string, { available: number; selected: number }>;
  };
}

/**
 * The frozen parity set: deduped, trivial asks dropped, stratified across
 * categories so the 500 synthetic textbook questions can't drown out the handful
 * of real email/finance/coding asks. Within a category organic prompts go first
 * (they ARE Will's tasks), then a seeded shuffle of the rest. Output order is by
 * id, so the file itself is deterministic, not just its contents.
 */
export function buildPromptSet(records: readonly TrainingRecord[], opts: BuildOptions): BuildResult {
  const usable = records.filter((r) => typeof r.input === 'string' && r.input.trim());
  const nonTrivial = usable.filter((r) => !isTrivial(r.input));
  const ordered = nonTrivial
    .slice()
    .sort(
      (a, b) =>
        Number(sourceOf(a.conversationId) === 'synthetic') - Number(sourceOf(b.conversationId) === 'synthetic') ||
        a.ts - b.ts ||
        a.id - b.id,
    );
  const unique = dedupe(ordered);

  const pool = new Map<Category, EvalPrompt[]>(CATEGORIES.map((c) => [c, []]));
  for (const r of unique) {
    const prompt = r.input.trim();
    const item: EvalPrompt = {
      id: sha(normalize(prompt)),
      prompt,
      category: categorize({ ...r, synthetic: sourceOf(r.conversationId) === 'synthetic' }),
      source: sourceOf(r.conversationId),
      conversationId: r.conversationId,
      sourceTs: r.ts,
      tools: [...new Set((r.tools ?? []).map((t) => t.tool))],
    };
    pool.get(item.category)!.push(item);
  }

  const rng = seededRng(opts.seed);
  const ranked = new Map<Category, EvalPrompt[]>();
  for (const c of CATEGORIES) {
    const items = pool.get(c)!.slice().sort((a, b) => a.id.localeCompare(b.id));
    const organic = shuffle(items.filter((p) => p.source === 'organic'), rng);
    const synthetic = shuffle(items.filter((p) => p.source === 'synthetic'), rng);
    ranked.set(c, [...organic, ...synthetic]);
  }

  // Round-robin allocation: each category gets an equal share, and whatever a
  // small category can't use flows to the others.
  const quota = new Map<Category, number>(CATEGORIES.map((c) => [c, 0]));
  let left = Math.min(opts.max, unique.length);
  while (left > 0) {
    let progressed = false;
    for (const c of CATEGORIES) {
      if (left === 0) break;
      if (quota.get(c)! < ranked.get(c)!.length) {
        quota.set(c, quota.get(c)! + 1);
        left--;
        progressed = true;
      }
    }
    if (!progressed) break;
  }

  const prompts: EvalPrompt[] = [];
  const byCategory: BuildResult['stats']['byCategory'] = {};
  for (const c of CATEGORIES) {
    const take = ranked.get(c)!.slice(0, quota.get(c)!);
    prompts.push(...take);
    byCategory[c] = { available: ranked.get(c)!.length, selected: take.length };
  }
  prompts.sort((a, b) => a.id.localeCompare(b.id));
  return {
    prompts,
    stats: {
      corpusRows: records.length,
      trivial: usable.length - nonTrivial.length,
      duplicates: nonTrivial.length - unique.length,
      candidates: unique.length,
      byCategory,
    },
  };
}

/** Take n prompts round-robin across categories (id order within each), so a small --limit still spans categories. */
export function takeBalanced(prompts: readonly EvalPrompt[], n: number): EvalPrompt[] {
  const byCat = new Map<string, EvalPrompt[]>();
  for (const p of prompts) byCat.set(p.category, [...(byCat.get(p.category) ?? []), p]);
  const known = CATEGORIES as readonly string[];
  const cats = [...CATEGORIES.filter((c) => byCat.has(c)), ...[...byCat.keys()].filter((c) => !known.includes(c))];
  const out: EvalPrompt[] = [];
  for (let i = 0; out.length < n; i++) {
    let any = false;
    for (const c of cats) {
      const p = byCat.get(c)![i];
      if (p && out.length < n) {
        out.push(p);
        any = true;
      }
    }
    if (!any) break;
  }
  return out;
}
