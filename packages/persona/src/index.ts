/**
 * @flint/persona — your AI's identity on top of @flint/core.
 *
 * Bundles a style guide + retrieval of your own writing into the system prompt
 * so the model speaks as you, across every app. Provider-agnostic: works on
 * Anthropic now and your local Ollama model later, unchanged.
 */
export { Persona } from './persona.js';
export type { PersonaChatInput, PersonaGenerateInput } from './persona.js';
export { InMemoryRetriever } from './retriever.js';
export { STARTER_STYLE_GUIDE } from './style-guide.js';
export type { PersonaConfig, Retriever, WritingSample } from './types.js';
