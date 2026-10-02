/**
 * nexus_inbox: handoffs to Flint in Nexus that nobody has accepted, every 10
 * minutes. It calls one tool, check_inbox (pending, incoming), and keeps only
 * a handoff's id, its sender's namespace slug and its age: never its subject
 * or content. A handoff still pending 24 hours after it was sent raises one
 * handoff.unaccepted_24h event (triage escalates it once per sender a day).
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { toolJson } from './nexus.js';
import type { RaisedEvent, Source, SourceRun, SyncResult } from './types.js';

export const UNACCEPTED_AFTER_MS = 24 * 3_600_000;

interface Pending {
  id: string;
  createdAt: Date;
  slug: string | null;
}

/** The pending handoffs in a check_inbox reply: ids, times and sender slugs only. A reply that is not a list fails. */
export function parseInbox(result: unknown): Pending[] {
  const d = toolJson('check_inbox', result);
  if (!Array.isArray(d.handoffs)) throw new Error('nexus check_inbox: no handoffs list');
  return d.handoffs.flatMap((h) => {
    const x = (h ?? {}) as { id?: unknown; createdAt?: unknown; status?: unknown; from?: { slug?: unknown } };
    const at = typeof x.createdAt === 'string' ? Date.parse(x.createdAt) : NaN;
    if (typeof x.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(x.id) || !Number.isFinite(at) || (x.status !== undefined && x.status !== 'PENDING')) return [];
    const slug = typeof x.from?.slug === 'string' && /^[a-z0-9][a-z0-9_-]{0,39}$/.test(x.from.slug) ? x.from.slug : null;
    return [{ id: x.id, createdAt: new Date(at), slug }];
  });
}

export function nexusInboxSource(o: { url: string; token: string }): Source & { endpoints: string[] } {
  return {
    name: 'nexus_inbox',
    cadenceMs: 10 * 60_000,
    endpoints: [o.url],
    async run(r: SourceRun): Promise<SyncResult> {
      const client = new Client({ name: 'flint-runtime', version: '1.0.0' });
      const transport = new StreamableHTTPClientTransport(new URL(o.url), {
        requestInit: { headers: { authorization: `Bearer ${o.token}` } },
        fetch: (url, init) => r.fetch(String(url), init as RequestInit),
      });
      await client.connect(transport as never);
      try {
        const pending = parseInbox(await client.callTool({ name: 'check_inbox', arguments: { status: 'PENDING', direction: 'incoming', limit: 100 } }));
        const events: RaisedEvent[] = pending
          .filter((h) => r.now.getTime() - h.createdAt.getTime() >= UNACCEPTED_AFTER_MS)
          .map((h) => ({
            // Seen pending now: a condition that holds, not a past change (its age is in `hours`).
            sourceRef: `handoff:${h.id}:unaccepted_24h`, type: 'handoff.unaccepted_24h', occurredAt: r.now, current: true,
            // An id and a slug are Nexus's structure, not anyone's words.
            sensitivity: 'ops', tainted: false,
            payload: { handoffId: h.id, kind: 'handoff', hours: Math.floor((r.now.getTime() - h.createdAt.getTime()) / 3_600_000), ...(h.slug ? { namespace: h.slug } : {}) },
          }));
        return { observations: [], metrics: [], events };
      } finally {
        await client.close().catch(() => {});
      }
    },
  };
}
