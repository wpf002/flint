import { describe, it, expect } from 'vitest';
import { SemanticRetriever, OllamaEmbedder, cosineSimilarity } from '../src/index.js';
import type { Embedder } from '../src/index.js';

/**
 * Deterministic embedder: a bag-of-words vector over a fixed vocab, so cosine
 * similarity tracks word overlap. Enough to test the ranking path without a
 * live model.
 */
function bagOfWordsEmbedder(): Embedder {
  const vocab = [
    'email', 'sign', 'off', 'signature', 'cheers', 'regards',
    'garden', 'tomato', 'spring', 'water', 'soil',
    'invoice', 'payment', 'finance', 'budget',
  ];
  const vec = (text: string): number[] => {
    const words = new Set(text.toLowerCase().split(/[^a-z]+/));
    return vocab.map((v) => (words.has(v) ? 1 : 0));
  };
  return { embed: async (texts) => texts.map(vec) };
}

describe('cosineSimilarity', () => {
  it('is 1 for identical, 0 for orthogonal', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
    expect(cosineSimilarity([], [1])).toBe(0);
  });
});

describe('SemanticRetriever', () => {
  it('ranks by meaning, not keyword presence', async () => {
    const r = new SemanticRetriever(bagOfWordsEmbedder());
    await r.add([
      { id: 'email', text: 'I sign off my emails with cheers, never regards' },
      { id: 'garden', text: 'watering tomatoes in the spring garden' },
      { id: 'finance', text: 'the invoice and payment budget for finance' },
    ]);

    // Query shares NO exact keywords with the email sample's distinctive words
    // except the topic — overlap on email/sign/signature.
    const hits = await r.retrieve('how should I write an email signature sign off', 1);
    expect(hits[0]?.id).toBe('email');

    const fin = await r.retrieve('what about the payment invoice', 1);
    expect(fin[0]?.id).toBe('finance');
  });

  it('upserts by id and reports size', async () => {
    const r = new SemanticRetriever(bagOfWordsEmbedder());
    await r.add([{ id: '1', text: 'garden soil' }]);
    await r.add([{ id: '1', text: 'garden soil water spring' }]);
    expect(r.size).toBe(1);
  });

  it('returns nothing when empty', async () => {
    const r = new SemanticRetriever(bagOfWordsEmbedder());
    expect(await r.retrieve('anything', 3)).toEqual([]);
  });
});

describe('OllamaEmbedder', () => {
  it('calls /api/embeddings per text and returns vectors', async () => {
    const calls: unknown[] = [];
    const fakeFetch = (async (url: string, init?: { body?: string }) => {
      calls.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ embedding: [0.1, 0.2, 0.3] }), { status: 200 });
    }) as unknown as typeof fetch;

    const embedder = new OllamaEmbedder({ model: 'nomic-embed-text', fetch: fakeFetch });
    const vecs = await embedder.embed(['hello', 'world']);
    expect(vecs).toHaveLength(2);
    expect(vecs[0]).toEqual([0.1, 0.2, 0.3]);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ model: 'nomic-embed-text', prompt: 'hello' });
  });

  it('throws on a non-OK response', async () => {
    const fakeFetch = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
    const embedder = new OllamaEmbedder({ fetch: fakeFetch });
    await expect(embedder.embed(['x'])).rejects.toThrow(/HTTP 500/);
  });
});
