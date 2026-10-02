/**
 * The local provider on its own (`@flint/core/ollama`): what the runtime needs
 * to ask Ollama, without the rest of the package (and so without the
 * Anthropic SDK) in its bundle.
 */
export { OllamaProvider } from './provider/ollama/index.js';
export type { OllamaProviderOptions } from './provider/ollama/index.js';
export type { GenerateArgs, GenerateResult, ResponseFormat } from './provider/adapter.js';
export type { Message } from './types/message.js';
export { FlintError } from './types/error.js';
