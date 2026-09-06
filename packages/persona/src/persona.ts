import type {
  Flint,
  StreamEvent,
  GenerateOutcome,
  Tool,
  CallOptions,
  CacheHints,
} from '@flint/core';
import type { PersonaConfig, WritingSample } from './types.js';

export interface PersonaChatInput {
  conversationId: string;
  message: string;
  tools?: Tool[];
  /**
   * Per-turn context (current date/time, recalled long-term memory). Goes into
   * the SYSTEM prompt, never into the stored user message — so it stays fresh
   * each turn instead of being persisted into history and replayed forever.
   */
  context?: string;
}

export interface PersonaGenerateInput {
  prompt: string;
  tools?: Tool[];
  /** Per-turn context — see PersonaChatInput.context. */
  context?: string;
}

/**
 * "Your AI" as a reusable identity on top of Flint. It injects your style guide
 * (and, if configured, your own writing retrieved into context) as the system
 * prompt on every call, then delegates to Flint.
 *
 * Provider-agnostic by construction: the same Persona works against Anthropic
 * today and your local Ollama model later — you only swap the provider in the
 * Flint it wraps. Apps import a Persona and call chat()/generate(); they never
 * touch system prompts or retrieval themselves.
 */
export class Persona {
  constructor(
    private readonly flint: Flint,
    private readonly config: PersonaConfig,
  ) {}

  get name(): string {
    return this.config.name;
  }

  /** Memory-backed, streaming — the persona's voice + your retrieved writing. */
  async *chat(
    input: PersonaChatInput,
    options?: CallOptions,
  ): AsyncIterable<StreamEvent> {
    const { stable, context } = await this.buildSystem(input.message, input.context);
    yield* this.flint.chat(
      {
        conversationId: input.conversationId,
        message: input.message,
        system: stable + (context ?? ''),
        ...(input.tools ? { tools: input.tools } : {}),
        ...this.cacheHints(context),
      },
      options,
    );
  }

  /** One-shot, collected — same identity, no memory. */
  async generate(
    input: PersonaGenerateInput,
    options?: CallOptions,
  ): Promise<GenerateOutcome> {
    const { stable, context } = await this.buildSystem(input.prompt, input.context);
    return this.flint.generate(
      {
        system: stable + (context ?? ''),
        prompt: input.prompt,
        ...(input.tools ? { tools: input.tools } : {}),
        ...this.cacheHints(context),
      },
      options,
    );
  }

  /** Teach the persona more of your writing (added to the retriever). */
  async learn(samples: WritingSample[]): Promise<void> {
    if (!this.config.retriever) return;
    await this.config.retriever.add(samples);
  }

  /**
   * Per-call cache hints, and only when the persona was configured with them.
   * The stable half of the system prompt is the same bytes on every turn, so
   * marking it stops the provider from re-charging full input price for the
   * style guide on every message and on every iteration of a tool loop. With no
   * `cache` in the config nothing is sent and the call is exactly as before.
   */
  private cacheHints(context: string | undefined): { cache?: CacheHints } {
    const cache = this.config.cache;
    if (!cache) return {};
    return {
      cache: {
        ...cache,
        // The per-turn context carries a minute-resolution timestamp, so it must
        // sit AFTER the breakpoint or the prefix would be new on every call.
        ...(context !== undefined ? { systemSuffix: context } : {}),
      },
    };
  }

  /**
   * Assemble the system prompt: style guide + retrieved writing samples +
   * accumulated lessons. The lessons section is how the persona evolves — what
   * nightly reflection learns shows up here on every subsequent call.
   *
   * Returned split at the per-turn boundary rather than as one string: `stable`
   * is what repeats call after call (and so is what can be cached), `context` is
   * this turn's freshly-built block. `stable + context` is byte-for-byte the
   * single string this used to return — the separating blank line stays on the
   * END of `stable` — so a caller that just concatenates loses nothing.
   */
  private async buildSystem(
    query: string,
    context?: string,
  ): Promise<{ stable: string; context?: string }> {
    let system = this.config.styleGuide;

    if (this.config.retriever) {
      const k = this.config.retrieveK ?? 3;
      const samples = await this.config.retriever.retrieve(query, k);
      if (samples.length > 0) {
        const block = samples.map((s) => s.text.trim()).join('\n---\n');
        system +=
          `\n\nHere are examples of how you write. Match this voice and word choice:\n` +
          `---\n${block}\n---`;
      }
    }

    if (this.config.lessonStore) {
      const k = this.config.lessonsK ?? 8;
      const lessons = await this.config.lessonStore.recent(k);
      if (lessons.length > 0) {
        const block = lessons.map((l) => `- (${l.category}) ${l.text}`).join('\n');
        system +=
          `\n\nWhat you've learned from past sessions — apply these:\n${block}`;
      }
    }

    // Per-turn context LAST so it's the freshest thing the model reads. It lives
    // only in this call's system prompt — never in stored history — so yesterday's
    // "right now it is..." can't come back and contradict today's.
    const tail = context?.trim() ?? '';
    if (tail.length > 0) return { stable: `${system}\n\n`, context: tail };

    return { stable: system };
  }
}
