import { OllamaProvider } from '../../src/provider/ollama/index.js';
import type { ProviderAdapter } from '../../src/index.js';

/**
 * Cassette harness for Ollama — the SAME contract assertions as Anthropic, run
 * against the real OllamaProvider with a faked `fetch`. Only the local HTTP call
 * is replaced; the adapter's NDJSON parsing and prompted-tool logic are
 * exercised for real. Offline, deterministic, free.
 */

export interface OllamaChunk {
  message?: { role: 'assistant'; content: string };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

/** A streaming provider whose /api/chat returns the given NDJSON chunks. */
export function streamingProvider(chunks: OllamaChunk[]): ProviderAdapter {
  const fakeFetch = (async (_url: string, init?: { signal?: AbortSignal }) => {
    if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    return new Response(ndjsonStream(chunks, init?.signal), { status: 200 });
  }) as unknown as typeof fetch;
  return new OllamaProvider({ fetch: fakeFetch });
}

/** A non-streaming provider whose /api/chat returns a single JSON body. */
export function jsonProvider(chunk: OllamaChunk): ProviderAdapter {
  const fakeFetch = (async () =>
    new Response(JSON.stringify(chunk), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
  return new OllamaProvider({ fetch: fakeFetch });
}

/** A provider whose /api/chat fails with the given HTTP status. */
export function httpErrorProvider(status: number, body = 'error'): ProviderAdapter {
  const fakeFetch = (async () => new Response(body, { status })) as unknown as typeof fetch;
  return new OllamaProvider({ fetch: fakeFetch });
}

/** A provider whose fetch rejects (server unreachable). */
export function unreachableProvider(): ProviderAdapter {
  const fakeFetch = (async () => {
    throw new TypeError('fetch failed');
  }) as unknown as typeof fetch;
  return new OllamaProvider({ fetch: fakeFetch });
}

// --- chunk builders ---------------------------------------------------------

export function textChunk(content: string): OllamaChunk {
  return { message: { role: 'assistant', content } };
}

export function finalChunk(opts: {
  reason?: string;
  input?: number;
  output?: number;
}): OllamaChunk {
  return {
    message: { role: 'assistant', content: '' },
    done: true,
    done_reason: opts.reason ?? 'stop',
    prompt_eval_count: opts.input ?? 0,
    eval_count: opts.output ?? 0,
  };
}

function ndjsonStream(
  chunks: OllamaChunk[],
  signal?: AbortSignal,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (signal?.aborted) {
        controller.error(new DOMException('Aborted', 'AbortError'));
        return;
      }
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(JSON.stringify(chunks[i]) + '\n'));
      i++;
    },
  });
}
