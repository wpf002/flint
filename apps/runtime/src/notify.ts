/**
 * Telling Will something through the server's internal listener
 * (POST /internal/notify on [::1]:8081): a note in the console, and, for the
 * channels asked for, a banner and a content-free ping.
 *
 * notifyWill is P1's best-effort call (the backup alert): no channels, which
 * the server reads as the P1 behaviour. notifyServer is P2's: channels and a
 * ref (the escalation id) the server dedupes on, so a retried delivery is
 * "duplicate", never a second note or ping; its answer says whether to retry.
 */
import { NotifyResponse, type NotifyRequest } from '@flint/policy';
import type { Config } from './config.js';
import { scopedFetch } from './policy/egress.js';

export async function notifyWill(config: Pick<Config, 'server'>, title: string, body: string): Promise<boolean> {
  const r = await notifyServer(config, { title: title.slice(0, 80), body: body.slice(0, 500) });
  return r.status === 'stored' || r.status === 'duplicate';
}

/**
 * stored / duplicate: the server has it (duplicate: an earlier call with this
 * ref landed). refused: it said no (4xx), and asking again will not change
 * that. retry: no answer to trust (no server, a timeout, a 5xx).
 */
export type NotifyOutcome = { status: 'stored' | 'duplicate'; pinged: boolean } | { status: 'refused'; code: number } | { status: 'retry'; why: string };

export async function notifyServer(config: Pick<Config, 'server'>, req: Omit<NotifyRequest, 'body'> & { body?: string }, base: typeof fetch = fetch): Promise<NotifyOutcome> {
  if (!config.server) return { status: 'retry', why: 'no server configured' };
  const origin = new URL(config.server.url).origin;
  const post = scopedFetch([{ origin, pathPrefix: '/internal/notify', methods: ['POST'] }], base, 5_000);
  let res: Response;
  try {
    res = await post(`${origin}/internal/notify`, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.server.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(req),
    });
  } catch (err) {
    return { status: 'retry', why: err instanceof Error && err.name === 'TimeoutError' ? 'timeout' : 'unreachable' };
  }
  try {
    if (res.status >= 500) return { status: 'retry', why: `HTTP ${res.status}` };
    if (!res.ok) return { status: 'refused', code: res.status };
    const body = NotifyResponse.safeParse(await res.json().catch(() => undefined));
    if (!body.success) return { status: 'retry', why: 'an answer that is not the contract' };
    return { status: body.data.stored ? 'stored' : 'duplicate', pinged: body.data.pinged };
  } finally {
    await res.body?.cancel().catch(() => {});
  }
}
