/**
 * A stand-in for what the runtime knows of the models on this Mac (model/here):
 * every local call first asks whether its model runs here, on Ollama's own
 * word. A test of something else says up front that Ollama has listed its
 * model (`modelsHere`); a test of the check itself answers the listing.
 */
import { beforeEach } from 'vitest';
import { LOCAL_MODELS } from '../src/model/here';

export const OLLAMA_URL = 'http://127.0.0.1:11434';

/** Before each test in this file: Ollama at `url` has just listed these models as its own, and nothing else is known. */
export function modelsHere(names: readonly string[], url: string = OLLAMA_URL): void {
  beforeEach(() => {
    LOCAL_MODELS.forget();
    LOCAL_MODELS.learn(url, names.map((name) => ({ name, model: name })));
  });
}

/** Ollama's `/api/tags` reply for these rows. */
export const tags = (rows: readonly unknown[]): Response => new Response(JSON.stringify({ models: rows }), { status: 200, headers: { 'content-type': 'application/json' } });

export interface Listened {
  fetch: typeof fetch;
  /** Every request, in order: the listing and whatever followed. */
  seen: Array<{ method: string; url: string }>;
  /** Requests that were not the listing: a model call that should not have been made. */
  sent: () => number;
}

/**
 * A fetch that answers Ollama's listing with `listing` and hands everything
 * else to `chat` (default: a model call that fails the test's expectation by
 * being counted in `sent`).
 */
export function listening(listing: () => Response | Promise<Response>, chat?: typeof fetch): Listened {
  const seen: Listened['seen'] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    seen.push({ method: init?.method ?? 'GET', url: u });
    if (new URL(u).pathname === '/api/tags') return listing();
    if (chat) return chat(url as string, init);
    return new Response('{}', { status: 500 });
  }) as typeof fetch;
  return { fetch: f, seen, sent: () => seen.filter((s) => new URL(s.url).pathname !== '/api/tags').length };
}

/** A listing that never comes: it settles only when its request is given up. */
export const hangs = (): Promise<Response> => new Promise<Response>(() => {});
