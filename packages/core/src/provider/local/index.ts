import type { ModelCapabilities } from '../../types/capabilities.js';
import { OpenAiCompatibleProvider } from '../openai/chat.js';
import { isLoopbackHost } from './loopback.js';
import type { DeadlineMs } from '../deadline.js';

export interface LocalOpenAiProviderOptions {
  /**
   * The server's OpenAI-compatible base URL: `http://127.0.0.1:11434/v1` for
   * Ollama, `http://127.0.0.1:8080/v1` for llama.cpp's `llama-server`. Required
   * (Flint never reads process.env). http or https, no credentials in it.
   */
  baseURL: string;
  /**
   * Allow a server on another machine. Off by default: a local provider
   * connects to this machine only, and a `baseURL` anywhere else is refused
   * when the provider is built.
   */
  allowRemote?: boolean;
  /** For a server started with a key (`llama-server --api-key`). Unset: the placeholder `local` is sent. */
  apiKey?: string;
  /**
   * What each model can do (see `localCapabilities`). The caller knows: the
   * server's own report, or its own choice of model. There is no built-in table.
   */
  capabilities: (model: string) => ModelCapabilities;
  /** Fallback output cap when a call doesn't specify one (default 2048). */
  defaultMaxTokens?: number;
  /**
   * ms to the first sign of output on a streamed call. Unset: no deadline. A
   * number, or a function read on every call that returns undefined for "none
   * on this call" (see ChatWire).
   */
  firstTokenTimeoutMs?: DeadlineMs;
  /** The same for a call that follows a tool result. Unset: firstTokenTimeoutMs. */
  toolPassTimeoutMs?: DeadlineMs;
  /** ms for a non-streamed call to answer. Unset: no deadline. */
  requestTimeoutMs?: DeadlineMs;
  /** ms a streamed reply may go quiet once it has begun (providerCode `idle_timeout`). */
  idleTimeoutMs?: DeadlineMs;
  /** Extra fields merged into every request body. */
  extraBody?: Record<string, unknown>;
  headers?: Record<string, string>;
  /** Injectable fetch (tests, a transport that pins the address). */
  fetch?: typeof fetch;
}

const DEFAULT_MAX_TOKENS = 2048;
/** Sent as the bearer when the server has no key: the wire always sends one. */
const PLACEHOLDER_KEY = 'local';

/**
 * Any OpenAI-compatible local model server, behind the same `ProviderAdapter`
 * as every other provider: Ollama's `/v1`, llama.cpp's `llama-server`, and
 * whatever else speaks chat completions on this machine. One adapter; the base
 * URL is the only thing that differs.
 *
 * What it declares about itself, rather than papering over:
 *  - the output cap is `max_tokens` (the newer field is OpenAI's own);
 *  - tools go only to a model whose capabilities say it can call them, and
 *    `toolChoice: 'none'` is honoured by leaving the tools out (Ollama's `/v1`
 *    has no `tool_choice`);
 *  - it never follows a redirect, and connects to this machine only unless
 *    `allowRemote` is set;
 *  - a model that stalls is cut off at the deadlines the caller sets, with a
 *    non-retryable `first_token_timeout`, so a turn can move to another model
 *    instead of waiting on a cold one.
 *
 * What it does not do: it cannot set a context size (chat completions has no
 * field for one; the server's own setting applies), and it has none of the
 * native Ollama adapter's recovery of tool calls a model wrote as text.
 */
export class LocalOpenAiProvider extends OpenAiCompatibleProvider {
  /**
   * The server every request goes to, without a trailing slash. Readable, so a
   * caller can tell a model on this machine from one on a server elsewhere (as
   * OllamaProvider's is).
   */
  readonly baseURL: string;

  constructor(opts: LocalOpenAiProviderOptions) {
    const base = checkedBaseURL(opts.baseURL, opts.allowRemote === true);
    super({
      name: 'local',
      apiKey: opts.apiKey || PLACEHOLDER_KEY,
      baseURL: base,
      maxTokensField: 'max_tokens',
      supportsTools: true,
      toolChoiceNone: 'drop_tools',
      refuseRedirects: true,
      capabilities: opts.capabilities,
      defaultMaxTokens: opts.defaultMaxTokens ?? DEFAULT_MAX_TOKENS,
      ...(opts.firstTokenTimeoutMs !== undefined ? { firstTokenTimeoutMs: opts.firstTokenTimeoutMs } : {}),
      ...(opts.toolPassTimeoutMs !== undefined ? { toolPassTimeoutMs: opts.toolPassTimeoutMs } : {}),
      ...(opts.requestTimeoutMs !== undefined ? { requestTimeoutMs: opts.requestTimeoutMs } : {}),
      ...(opts.idleTimeoutMs !== undefined ? { idleTimeoutMs: opts.idleTimeoutMs } : {}),
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
      ...(opts.extraBody ? { extraBody: opts.extraBody } : {}),
      ...(opts.headers ? { headers: opts.headers } : {}),
    });
    this.baseURL = base;
  }
}

/**
 * The base URL, or a thrown configuration error. The message names what is
 * wrong and never repeats the URL: one that carries credentials would put them
 * in a log.
 */
function checkedBaseURL(raw: string, allowRemote: boolean): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('LocalOpenAiProvider: baseURL is not a URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('LocalOpenAiProvider: baseURL must be http or https');
  if (url.username || url.password) throw new Error('LocalOpenAiProvider: baseURL must not carry credentials (use apiKey)');
  if (!allowRemote && !isLoopbackHost(url.hostname)) {
    throw new Error('LocalOpenAiProvider: baseURL is not on this machine (127.0.0.1, localhost or [::1]); set allowRemote to use a server elsewhere');
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

export { localCapabilities } from './capabilities.js';
export type { LocalModelFacts } from './capabilities.js';
export { isLoopbackHost } from './loopback.js';
