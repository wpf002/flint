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
export { FLINT_STYLE_GUIDE, FLINT_VOICE_EXEMPLARS, FLINT_BANNED_PHRASES } from './flint.js';
export { checkVoice } from './voice-eval.js';
export type { VoiceScore, VoiceViolation, VoiceCheckOptions } from './voice-eval.js';
export type { PersonaConfig, Retriever, WritingSample } from './types.js';
