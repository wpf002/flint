/**
 * Word error rate: how far a transcript is from the words that were said.
 *
 * The standard measure. Both texts are made alike first (case, punctuation,
 * spacing), then the fewest word substitutions, deletions and insertions that
 * turn the reference into the transcript are counted, and divided by the
 * number of words in the reference. 0 is word for word; it can pass 1 when a
 * transcript holds more wrong words than the reference has words.
 *
 * What "made alike" does NOT do: it does not turn "nine" into "9", or a
 * British spelling into an American one. A benchmark's sentences are written
 * to have neither (./voice-bench SENTENCES).
 */

/** The words of a text as they are compared: lower case, no punctuation, apostrophes kept inside a word ("don't"). */
export function werWords(text: string): string[] {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‘’‚‛′´`]/g, "'")
    .replace(/[^\p{L}\p{N}']+/gu, ' ')
    .split(' ')
    .map((w) => w.replace(/^'+|'+$/g, ''))
    .filter((w) => w.length > 0);
}

export interface WordErrors {
  /** Words in the reference. */
  words: number;
  substitutions: number;
  deletions: number;
  insertions: number;
  /** substitutions + deletions + insertions. */
  errors: number;
}

/** The longest text compared word by word (a clip's sentence is a dozen words; this bounds the table, 4,000 x 4,000). */
const MAX_WORDS = 4000;

/**
 * The fewest edits from `reference` to `heard`, by kind. Word-level
 * Levenshtein; among equally short edit paths a substitution is preferred to
 * a deletion and an insertion, so the three counts are stable.
 */
export function wordErrors(reference: string, heard: string): WordErrors {
  const ref = werWords(reference).slice(0, MAX_WORDS);
  const hyp = werWords(heard).slice(0, MAX_WORDS);
  const n = ref.length;
  const m = hyp.length;
  // cost[i][j]: edits from ref[0..i) to hyp[0..j). back[i][j]: the last step taken (0 match, 1 sub, 2 del, 3 ins).
  const cost: Uint16Array[] = [];
  const back: Uint8Array[] = [];
  for (let i = 0; i <= n; i++) {
    cost.push(new Uint16Array(m + 1));
    back.push(new Uint8Array(m + 1));
  }
  for (let i = 1; i <= n; i++) {
    cost[i]![0] = i;
    back[i]![0] = 2;
  }
  for (let j = 1; j <= m; j++) {
    cost[0]![j] = j;
    back[0]![j] = 3;
  }
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (ref[i - 1] === hyp[j - 1]) {
        cost[i]![j] = cost[i - 1]![j - 1]!;
        back[i]![j] = 0;
        continue;
      }
      const sub = cost[i - 1]![j - 1]! + 1;
      const del = cost[i - 1]![j]! + 1;
      const ins = cost[i]![j - 1]! + 1;
      const best = Math.min(sub, del, ins);
      cost[i]![j] = best;
      back[i]![j] = best === sub ? 1 : best === del ? 2 : 3;
    }
  }
  let substitutions = 0;
  let deletions = 0;
  let insertions = 0;
  for (let i = n, j = m; i > 0 || j > 0; ) {
    const step = back[i]![j]!;
    if (step === 0) {
      i--;
      j--;
    } else if (step === 1) {
      substitutions++;
      i--;
      j--;
    } else if (step === 2) {
      deletions++;
      i--;
    } else {
      insertions++;
      j--;
    }
  }
  return { words: n, substitutions, deletions, insertions, errors: substitutions + deletions + insertions };
}

/**
 * The word error rate over any number of (reference, heard) pairs: all the
 * errors over all the reference words, which is how a set of clips is scored
 * (a short clip's one mistake does not count for more than a long clip's).
 * Undefined when the references hold no word at all.
 */
export function wordErrorRate(pairs: ReadonlyArray<Pick<WordErrors, 'words' | 'errors'>>): number | undefined {
  const words = pairs.reduce((n, p) => n + p.words, 0);
  return words === 0 ? undefined : pairs.reduce((n, p) => n + p.errors, 0) / words;
}
