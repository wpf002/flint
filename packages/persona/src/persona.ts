import type {
  Flint,
  StreamEvent,
  GenerateOutcome,
  Tool,
  CallOptions,
} from '@flint/core';
import type { PersonaConfig, WritingSample } from './types.js';

export interface PersonaChatInput {
  conversationId: string;
  message: string;
  tools?: Tool[];
}

export interface PersonaGenerateInput {
  prompt: string;
  tools?: Tool[];
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
    const system = await this.buildSystem(input.message);
    yield* this.flint.chat(
      {
        conversationId: input.conversationId,
        message: input.message,
        system,
        ...(input.tools ? { tools: input.tools } : {}),
      },
      options,
    );
  }

  /** One-shot, collected — same identity, no memory. */
  async generate(
    input: PersonaGenerateInput,
    options?: CallOptions,
  ): Promise<GenerateOutcome> {
    const system = await this.buildSystem(input.prompt);
    return this.flint.generate(
      {
        system,
        prompt: input.prompt,
        ...(input.tools ? { tools: input.tools } : {}),
      },
      options,
    );
  }

  /** Teach the persona more of your writing (added to the retriever). */
  async learn(samples: WritingSample[]): Promise<void> {
    if (!this.config.retriever) return;
    await this.config.retriever.add(samples);
  }

  /** Assemble the system prompt: style guide + retrieved writing samples. */
  private async buildSystem(query: string): Promise<string> {
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
    return system;
  }
}
