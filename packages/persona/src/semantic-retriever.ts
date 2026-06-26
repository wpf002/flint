import type { Retriever, WritingSample } from './types.js';
import { cosineSimilarity, type Embedder } from './embedder.js';

/**
 * Meaning-based retrieval: ranks the user's writing by semantic similarity to
 * the query (embeddings + cosine), not keyword overlap. Implements the same
 * `Retriever` interface as `InMemoryRetriever`, so it's a drop-in upgrade for
 * the Persona.
 *
 * Vectors are held in memory here; the durable Postgres+pgvector backend
 * implements the same interface later with no change to the Persona.
 */
export class SemanticRetriever implements Retriever {
  private readonly items: Array<{ sample: WritingSample; vec: number[] }> = [];

  constructor(private readonly embedder: Embedder) {}

  async add(samples: WritingSample[]): Promise<void> {
    if (samples.length === 0) return;
    const vecs = await this.embedder.embed(samples.map((s) => s.text));
    samples.forEach((sample, i) => {
      const vec = vecs[i] ?? [];
      const idx = this.items.findIndex((it) => it.sample.id === sample.id);
      if (idx >= 0) this.items[idx] = { sample, vec };
      else this.items.push({ sample, vec });
    });
  }

  async retrieve(query: string, k: number): Promise<WritingSample[]> {
    if (this.items.length === 0) return [];
    const [q] = await this.embedder.embed([query]);
    if (!q) return [];
    return this.items
      .map((it) => ({ sample: it.sample, score: cosineSimilarity(q, it.vec) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map((r) => r.sample);
  }

  get size(): number {
    return this.items.length;
  }
}
