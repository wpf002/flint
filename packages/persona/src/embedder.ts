/**
 * Embeddings behind a Flint-style interface (Phase 3). Provider-agnostic: the
 * semantic retriever depends on `Embedder`, not on any vendor. `OllamaEmbedder`
 * runs entirely locally; swap in a hosted embedder later with zero change to
 * the retriever.
 */
export interface Embedder {
  /** Embed each text into a vector. Order matches the input. */
  embed(texts: string[]): Promise<number[][]>;
}

export interface OllamaEmbedderOptions {
  /** Embedding model, e.g. 'nomic-embed-text' (pull it first: `ollama pull nomic-embed-text`). */
  model?: string;
  /** Ollama base URL. Default 127.0.0.1 (not 'localhost' — IPv4, to dodge Node's IPv6 quirk). */
  baseURL?: string;
  /** Injectable fetch for tests. */
  fetch?: typeof fetch;
}

/** Local embeddings via Ollama's HTTP API. No cloud, no key. */
export class OllamaEmbedder implements Embedder {
  private readonly model: string;
  private readonly baseURL: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: OllamaEmbedderOptions = {}) {
    this.model = opts.model ?? 'nomic-embed-text';
    this.baseURL = (opts.baseURL ?? 'http://127.0.0.1:11434').replace(/\/$/, '');
    this.fetchImpl = opts.fetch ?? fetch;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (const text of texts) {
      const res = await this.fetchImpl(`${this.baseURL}/api/embeddings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.model, prompt: text }),
      });
      if (!res.ok) {
        throw new Error(`Ollama embeddings failed: HTTP ${res.status}`);
      }
      const json = (await res.json()) as { embedding?: number[] };
      out.push(json.embedding ?? []);
    }
    return out;
  }
}

/** Cosine similarity of two equal-length vectors; 0 if either is empty/zero. */
export function cosineSimilarity(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
