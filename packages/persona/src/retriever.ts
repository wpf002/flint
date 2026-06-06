import type { Retriever, WritingSample } from './types.js';

/**
 * Reference retriever: keyword-overlap scoring, recency as tiebreak. No vector
 * DB, no dependencies — good enough to pull the user's most relevant writing
 * into context. Replace with an embedding-backed store when overlap stops being
 * good enough (implement the same `Retriever` interface).
 */
export class InMemoryRetriever implements Retriever {
  private readonly samples: WritingSample[] = [];

  constructor(initial: WritingSample[] = []) {
    this.add(initial);
  }

  add(samples: WritingSample[]): void {
    for (const s of samples) {
      const idx = this.samples.findIndex((x) => x.id === s.id);
      if (idx >= 0) this.samples[idx] = s;
      else this.samples.push(s);
    }
  }

  retrieve(query: string, k: number): WritingSample[] {
    const q = tokenize(query);
    if (q.size === 0) {
      // No query signal — return the most recent samples.
      return [...this.samples]
        .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
        .slice(0, k);
    }
    return this.samples
      .map((s) => ({ s, score: overlap(q, tokenize(s.text)) }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score || (b.s.createdAt ?? 0) - (a.s.createdAt ?? 0))
      .slice(0, k)
      .map((r) => r.s);
  }

  get size(): number {
    return this.samples.length;
  }
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 2),
  );
}

function overlap(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return n;
}
