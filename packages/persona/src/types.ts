/** A piece of the user's own writing — the raw material for "your voice". */
export interface WritingSample {
  id: string;
  text: string;
  /** Optional tags for filtering/boosting (e.g. 'email', 'blog'). */
  tags?: string[];
  /** Optional recency signal; newer samples win ties. */
  createdAt?: number;
}

/**
 * Retrieval seam. The persona pulls a few relevant samples into context per
 * call. `@flint/core` deliberately ships no retrieval (it's the app's job), so
 * it lives here. Swap in a vector store later by implementing this interface.
 */
export interface Retriever {
  add(samples: WritingSample[]): void | Promise<void>;
  /** Return up to `k` samples most relevant to `query`. */
  retrieve(query: string, k: number): WritingSample[] | Promise<WritingSample[]>;
}

/** Configuration for a persona — the identity Flint speaks with. */
export interface PersonaConfig {
  /** A human label for the persona. */
  name: string;
  /** The style guide — becomes the core of the system prompt. Write this in YOUR voice. */
  styleGuide: string;
  /** Optional retriever of the user's own writing. Defaults to none (style guide only). */
  retriever?: Retriever;
  /** How many writing samples to pull into context per call. Default 3. */
  retrieveK?: number;
}
