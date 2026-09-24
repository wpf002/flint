import type { GenerateResult } from '../adapter.js';
import { OpenAiCompatibleProvider } from '../openai/chat.js';
import { perplexityCapabilities } from './capabilities.js';

export interface PerplexityProviderOptions {
  /** API key. Passed explicitly — Flint never reads process.env. */
  apiKey: string;
  baseURL?: string;
  defaultMaxTokens?: number;
  fetch?: typeof fetch;
  /**
   * Append the sources Perplexity used to the end of the reply. Default true: a
   * grounded answer whose grounding is thrown away is just an ordinary answer.
   */
  citations?: boolean;
  extraBody?: Record<string, unknown>;
  headers?: Record<string, string>;
}

const DEFAULT_BASE_URL = 'https://api.perplexity.ai';
const DEFAULT_MAX_TOKENS = 2048;
/** Sources listed when the reply cites none (or isn't known yet, while streaming). */
const MAX_CITATIONS = 10;
/** Hard ceiling, however high the reply's markers go. */
const CITATION_CEILING = 50;
const HEADING = 'Sources:';

/**
 * Perplexity, over its OpenAI-compatible endpoint.
 *
 * Two real differences from OpenAI, both declared rather than papered over: the
 * output cap is `max_tokens` (the newer field is rejected), and there is no
 * function-calling API at all, so tools are never sent.
 *
 * The sources come back as top-level `search_results` / `citations`, which the
 * chat-completions shape has nowhere to put. They are folded into the reply text
 * rather than dropped or exposed as a vendor-specific field — that keeps each claim
 * next to what backs it, which is the part that matters when another participant
 * reads the answer and has to decide whether to trust it.
 */
export class PerplexityProvider extends OpenAiCompatibleProvider {
  private readonly citations: boolean;

  constructor(opts: PerplexityProviderOptions) {
    super({
      name: 'perplexity',
      apiKey: opts.apiKey,
      baseURL: opts.baseURL ?? DEFAULT_BASE_URL,
      maxTokensField: 'max_tokens',
      supportsTools: false,
      capabilities: perplexityCapabilities,
      defaultMaxTokens: opts.defaultMaxTokens ?? DEFAULT_MAX_TOKENS,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
      ...(opts.extraBody ? { extraBody: opts.extraBody } : {}),
      ...(opts.headers ? { headers: opts.headers } : {}),
    });
    this.citations = opts.citations ?? true;
  }

  protected override decorate(result: GenerateResult, raw: unknown): GenerateResult {
    const block = this.sourcesBlock(raw, result.message.content);
    if (!block) return result;
    return { ...result, message: { ...result.message, content: result.message.content + block } };
  }

  protected override streamSuffix(lastChunk: unknown): string | undefined {
    return this.sourcesBlock(lastChunk, '');
  }

  private sourcesBlock(raw: unknown, existing: string): string | undefined {
    if (!this.citations || existing.includes(`\n${HEADING}\n`)) return undefined;
    const sources = extractSources(raw, existing);
    return sources.length > 0 ? `\n\n${HEADING}\n${sources.join('\n')}` : undefined;
  }
}

/**
 * How many sources to list. sonar-pro routinely cites [11]..[19]; listing only the
 * first 10 left those markers pointing at nothing (266 of 300 answers in the parity
 * run), which reads as fabricated citations. So list up to the highest marker the
 * reply uses. While streaming the text isn't known yet, so list them all.
 */
function sourceLimit(text: string, available: number): number {
  if (!text) return Math.min(available, CITATION_CEILING);
  let highest = 0;
  for (const m of text.matchAll(/\[(\d{1,3})\]/g)) highest = Math.max(highest, Number(m[1]));
  return Math.min(available, CITATION_CEILING, Math.max(MAX_CITATIONS, highest));
}

function extractSources(raw: unknown, text: string): string[] {
  const body = raw as
    | { citations?: unknown; search_results?: Array<{ title?: string; url?: string }> }
    | undefined;
  if (!body || typeof body !== 'object') return [];

  if (Array.isArray(body.search_results)) {
    return body.search_results
      .slice(0, sourceLimit(text, body.search_results.length))
      .map((s, i) => `[${i + 1}] ${s.title ?? s.url ?? 'source'}${s.url && s.title ? ` — ${s.url}` : ''}`);
  }

  if (Array.isArray(body.citations)) {
    return body.citations
      .slice(0, sourceLimit(text, body.citations.length))
      .filter((c): c is string => typeof c === 'string')
      .map((c, i) => `[${i + 1}] ${c}`);
  }

  return [];
}

export { perplexityCapabilities } from './capabilities.js';
