/**
 * nexus: Will's Nexus threads, every 10 minutes (Machine plan P1 sources).
 *
 *  - Reached as an MCP client over Streamable HTTP, with a READ token Will
 *    issues for the runtime (NEXUS_READ_TOKEN in runtime.env), through the
 *    source's endpoint-scoped fetch: only the Nexus URL, no redirects.
 *  - Nexus has many writers, so ALL of its text is tainted: a thread's goal is
 *    its (tainted) name and nothing else of its text is stored.
 *  - Uses thread_list (by updatedAt). When Nexus ships `changes_since`
 *    (Decision 4) this switches to it; memory is not attached to entities in P1.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Source, SourceObservation, SourceRun, SyncResult } from './types.js';

export interface NexusOptions {
  url: string;
  token: string;
}

interface ThreadRow {
  threadId: string;
  goal: string;
  status: string;
  updatedAt: string;
}

/** Thread rows out of a thread_list result (the JSON is in the first text block). */
export function parseThreads(result: unknown): ThreadRow[] {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  const text = content.find((c) => c.type === 'text')?.text ?? '{}';
  let data: { threads?: unknown };
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  return (Array.isArray(data.threads) ? data.threads : []).filter(
    (t): t is ThreadRow => !!t && typeof (t as ThreadRow).threadId === 'string' && typeof (t as ThreadRow).goal === 'string',
  );
}

export function threadObservation(t: ThreadRow): SourceObservation {
  const open = t.status === 'OPEN';
  return {
    type: 'thread.state', kind: 'thread', key: `thread:nexus:${t.threadId.slice(0, 64)}`, name: t.goal.slice(0, 300) || 'thread',
    sensitivity: 'ops', externalId: `thread:${t.threadId.slice(0, 64)}`, taintedPaths: ['name'],
    state: { status: open ? 'open' : 'archived' }, ...(open ? {} : { status: 'archived' as const }),
  };
}

export function nexusSource(o: NexusOptions): Source & { endpoints: string[] } {
  return {
    name: 'nexus',
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
        const result = await client.callTool({ name: 'thread_list', arguments: { mine: false, status: 'ANY', limit: 50 } });
        return { observations: parseThreads(result).map(threadObservation), metrics: [] };
      } finally {
        await client.close().catch(() => {});
      }
    },
  };
}
