/**
 * Stand-ins for the question every local call asks first (model/here): is my
 * model on this Mac, on Ollama's own word? The runtime asks it before each
 * call and believes the answer for two seconds.
 *
 *  - A test of something else says up front that these models are Ollama's own
 *    (`modelsHere`): in that file the process's record answers yes for them,
 *    however long a test takes, and asks nothing. One test in such a file can
 *    still have the question asked for real (`listingForReal`).
 *  - A test of the check itself answers the listing: a fetch that plays Ollama
 *    (`listening`), or a real stand-in server on loopback (`standIn`).
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, vi, type MockInstance } from 'vitest';
import { sameModel } from '@flint/policy';
import { LOCAL_MODELS, LocalModels } from '../src/model/here';

export const OLLAMA_URL = 'http://127.0.0.1:11434';

let standing: MockInstance | undefined;

/**
 * In this file, Ollama at `url` says these models run on it: the process's own record (LOCAL_MODELS) answers yes for
 * them and no for anything else, without asking. A record a test makes for itself (`new LocalModels()`) is untouched.
 */
export function modelsHere(names: readonly string[], url: string = OLLAMA_URL): void {
  beforeEach(() => {
    const origin = new URL(url).origin;
    standing = vi.spyOn(LOCAL_MODELS, 'runsHere').mockImplementation(async (ollama) => {
      let at: string;
      try {
        at = new URL(ollama.url).origin;
      } catch {
        return false;
      }
      return ollama.proxied !== true && at === origin && names.some((n) => sameModel(n, ollama.model));
    });
  });
  afterEach(() => {
    standing?.mockRestore();
    standing = undefined;
    LOCAL_MODELS.forget();
  });
}

/** For the rest of this test, the process's record asks Ollama for real again, knowing nothing. */
export function listingForReal(): void {
  standing?.mockRestore();
  standing = undefined;
  LOCAL_MODELS.forget();
}

/**
 * A record of its own for one test: nothing heard yet, and a listing given up after `timeoutMs` (a hang then costs
 * a third of a second, not two). `wordMs`: how old Ollama's word may be when a request goes (two seconds, unless a
 * test over real sockets shortens it so it need not wait that long).
 */
export const fresh = (timeoutMs = 300, wordMs?: number): LocalModels => new LocalModels({ timeoutMs, ...(wordMs !== undefined ? { wordMs } : {}) });

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

export type ListingMode = 'here' | 'remote' | 'hang' | 'error500' | 'gone';

export interface StandIn {
  /** Its address: loopback, on a port of its own. */
  url: string;
  /** How it answers `GET /api/tags`. */
  listing: ListingMode;
  /** The chat reply's content (an object is sent as JSON). Chat ALWAYS answers: only the listing says where the model runs. */
  reply: unknown;
  /** When set: the reply to each chat request in turn (the last repeats), instead of `reply`. */
  replies?: unknown[];
  /** How long each chat request takes to answer, by its number from 1 (default: at once). */
  chatDelayMs?: (n: number) => number;
  /** Every request it received, in order. */
  seen: Array<{ method: string; path: string }>;
  /** The body of every chat request it received: what would have reached the model. */
  chats: string[];
  close: () => Promise<void>;
}

/**
 * A real stand-in for Ollama on loopback: its listing names `model`, as running here or (mode `remote`) with a
 * remote host, or hangs, or fails; its chat endpoint answers every request with `reply` and keeps what it was sent.
 */
export async function standIn(model: string, reply: unknown = {}): Promise<StandIn> {
  const hung: Array<() => void> = [];
  const s: StandIn = { url: '', listing: 'here', reply, seen: [], chats: [], close: async () => {} };
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => {
      const path = (req.url ?? '').split('?')[0]!;
      s.seen.push({ method: req.method ?? '', path });
      res.setHeader('content-type', 'application/json');
      if (path === '/api/tags') {
        if (s.listing === 'hang') return void hung.push(() => res.destroy());
        if (s.listing === 'error500') return void res.writeHead(500).end('{"error":"the listing failed"}');
        if (s.listing === 'gone') return void res.end(JSON.stringify({ models: [{ name: 'some-other-model:1b' }] }));
        const row = s.listing === 'remote' ? { name: model, model, remote_host: 'https://ollama.com:443', remote_model: 'gpt-oss:120b' } : { name: model, model };
        return void res.end(JSON.stringify({ models: [row, { name: 'some-other-model:1b' }] }));
      }
      // What is loaded now (Settings > Health reads it beside the listing): nothing.
      if (path === '/api/ps') return void res.end(JSON.stringify({ models: [] }));
      if (path === '/api/chat') {
        s.chats.push(body);
        const n = s.chats.length;
        const said = s.replies ? s.replies[Math.min(n - 1, s.replies.length - 1)] : s.reply;
        const answer = (): void => void res.end(JSON.stringify({ model, message: { role: 'assistant', content: typeof said === 'string' ? said : JSON.stringify(said) }, done: true, done_reason: 'stop', prompt_eval_count: 10, eval_count: 5 }));
        const wait = s.chatDelayMs?.(n) ?? 0;
        return void (wait > 0 ? setTimeout(answer, wait) : answer());
      }
      res.writeHead(404).end('{}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  s.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  s.close = async () => {
    for (const end of hung) end();
    server.closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
  };
  return s;
}
