import { LocalOpenAiProvider, localCapabilities } from '../../src/provider/local/index.js';
import type { ProviderAdapter } from '../../src/index.js';

/**
 * Cassette harness for LocalOpenAiProvider: the same contract assertions as
 * the other providers, run against the real adapter with a faked `fetch`. The
 * cassettes are the bodies Ollama 0.34.4's /v1/chat/completions sent for these
 * requests (recorded 2026-10-12 with synthetic prompts), so the SSE parsing and
 * tool-call assembly run on what a real server sends. Offline, deterministic, free.
 */

const BASE = 'http://127.0.0.1:11434/v1';
const caps = () => localCapabilities({ contextTokens: 16384, tools: true });

const chunk = (id: string, choices: unknown[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ id, object: 'chat.completion.chunk', created: 1791818566, model: 'test-model', system_fingerprint: 'fp_ollama', choices, ...extra });

/** A streamed plain answer: "Hello, world". */
export const TEXT_STREAM: string[] = [
  chunk('chatcmpl-888', [{ index: 0, delta: { role: 'assistant', content: 'Hello' }, finish_reason: null }]),
  chunk('chatcmpl-888', [{ index: 0, delta: { content: ',' }, finish_reason: null }]),
  chunk('chatcmpl-888', [{ index: 0, delta: { content: ' world' }, finish_reason: null }]),
  chunk('chatcmpl-888', [{ index: 0, delta: {}, finish_reason: 'stop' }]),
  chunk('chatcmpl-888', [], { usage: { prompt_tokens: 35, prompt_tokens_details: { cached_tokens: 0 }, completion_tokens: 4, total_tokens: 39 } }),
];

/** A streamed tool call: Ollama sends the whole call in one delta, then the finish. */
export const TOOL_STREAM: string[] = [
  chunk('chatcmpl-514', [
    {
      index: 0,
      delta: { role: 'assistant', content: '', tool_calls: [{ id: 'call_668wpbkr', index: 0, type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }] },
      finish_reason: null,
    },
  ]),
  chunk('chatcmpl-514', [{ index: 0, delta: {}, finish_reason: 'tool_calls' }]),
  chunk('chatcmpl-514', [], { usage: { prompt_tokens: 153, prompt_tokens_details: { cached_tokens: 18 }, completion_tokens: 20, total_tokens: 173 } }),
];

/** A whole non-streamed completion. */
export const COMPLETION = {
  id: 'chatcmpl-151',
  object: 'chat.completion',
  created: 1791818567,
  model: 'test-model',
  system_fingerprint: 'fp_ollama',
  choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 33, prompt_tokens_details: { cached_tokens: 27 }, completion_tokens: 2, total_tokens: 35 },
};

/** The body of a 404 for a model the server does not have. */
export const NOT_FOUND = { error: { message: "model 'no-such-model' not found", type: 'not_found_error', param: null, code: null } };

/** A provider whose endpoint streams these SSE payloads (one read each, so a chunk boundary falls between events). */
export function streamingProvider(payloads: string[]): { provider: ProviderAdapter; requests: Array<Record<string, unknown>> } {
  const requests: Array<Record<string, unknown>> = [];
  const fakeFetch = (async (_url: string, init?: { body?: string; signal?: AbortSignal }) => {
    requests.push(JSON.parse(init?.body ?? '{}') as Record<string, unknown>);
    if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    return new Response(sseStream(payloads, init?.signal), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as unknown as typeof fetch;
  return { provider: new LocalOpenAiProvider({ baseURL: BASE, capabilities: caps, fetch: fakeFetch }), requests };
}

/** A provider whose endpoint answers one JSON body. */
export function jsonProvider(body: unknown, status = 200): ProviderAdapter {
  const fakeFetch = (async () =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
  return new LocalOpenAiProvider({ baseURL: BASE, capabilities: caps, fetch: fakeFetch });
}

/** A provider whose server is not there. */
export function unreachableProvider(): ProviderAdapter {
  const fakeFetch = (async () => {
    throw new TypeError('fetch failed');
  }) as unknown as typeof fetch;
  return new LocalOpenAiProvider({ baseURL: BASE, capabilities: caps, fetch: fakeFetch });
}

function sseStream(payloads: string[], signal?: AbortSignal): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const frames = [...payloads.map((p) => `data: ${p}\n\n`), 'data: [DONE]\n\n'];
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (signal?.aborted) {
        controller.error(new DOMException('Aborted', 'AbortError'));
        return;
      }
      if (i >= frames.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(frames[i]!));
      i++;
    },
  });
}
