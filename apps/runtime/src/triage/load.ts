/**
 * Triage yields to chat (Machine plan P2, Ollama contention): before each
 * model call it asks the server how many /chat turns are running
 * (POST /internal/load on [::1]:8081), and waits while any are.
 *
 * It fails closed: an answer it cannot trust (a timeout, 401, 404, a 5xx, a
 * body that is not the contract) means "wait", never "go". The one exception
 * is a refused connection: no server is running, so no chat turn is either.
 */
import { LoadResponse } from '@flint/policy';
import type { Config } from '../config.js';
import { scopedFetch } from '../policy/egress.js';

export type Load = 'proceed' | 'defer';

export function chatLoad(server: Config['server'], base: typeof fetch = fetch): () => Promise<Load> {
  if (!server) return async () => 'proceed';
  const origin = new URL(server.url).origin;
  const post = scopedFetch([{ origin, pathPrefix: '/internal/load', methods: ['POST'] }], base, 2_000);
  return async () => {
    let res: Response;
    try {
      res = await post(`${origin}/internal/load`, {
        method: 'POST',
        headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
        body: '{}',
      });
    } catch (err) {
      return refused(err) ? 'proceed' : 'defer';
    }
    try {
      if (!res.ok) return 'defer';
      const body = LoadResponse.safeParse(await res.json());
      return body.success && body.data.chatInFlight === 0 ? 'proceed' : 'defer';
    } catch {
      return 'defer';
    } finally {
      // Never leave a body unread: it holds the socket.
      await res.body?.cancel().catch(() => {});
    }
  };
}

/** fetch() wraps a refused connection as TypeError('fetch failed') with the code on its cause. */
function refused(err: unknown): boolean {
  const cause = (err as { cause?: { code?: unknown; errors?: Array<{ code?: unknown }> } }).cause;
  if (cause?.code === 'ECONNREFUSED') return true;
  // Happy eyeballs: an AggregateError of every address tried.
  return !!cause?.errors?.length && cause.errors.every((e) => e.code === 'ECONNREFUSED');
}
