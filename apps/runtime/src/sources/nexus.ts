/**
 * nexus: Will's open Nexus threads, every 5 minutes (Machine plan P1 sources).
 *
 *  - Reached as an MCP client over Streamable HTTP, through the source's
 *    endpoint-scoped fetch: only the Nexus URL, no redirects. The token
 *    (NEXUS_READ_TOKEN in runtime.env) is a whole Nexus namespace token, since
 *    Nexus tokens have no scopes yet; what keeps this source read-only is the
 *    code, which calls only thread_list and thread_read.
 *  - Nexus has many writers, so ALL of its text is tainted: a thread's goal is
 *    its (tainted) name and nothing else of its text is stored.
 *  - Lists OPEN threads (at most 50, Nexus's limit). A thread that leaves the
 *    list is read once to learn how it ended: closed or gone, it is archived.
 *    A full page of 50 cannot say what left, so then nothing is followed up.
 *  - A tool error or a reply that is not the expected JSON fails the run: an
 *    outage must never look like "no threads".
 *  - When Nexus ships `changes_since` (Decision 4) this switches to it; memory
 *    is not attached to entities in P1.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { clip } from './text.js';
import type { Source, SourceObservation, SourceRun, SyncResult } from './types.js';

export interface NexusOptions {
  url: string;
  token: string;
}

interface ThreadRow {
  threadId: string;
  goal: string;
  status: string;
  updatedAt?: unknown;
}

export const NEXUS_LIST_LIMIT = 50;

/** The JSON a tool replied with, or an error naming the tool's own error code. */
export function toolJson(tool: string, result: unknown): Record<string, unknown> {
  const r = (result ?? {}) as { isError?: boolean; content?: Array<{ type: string; text?: string }> };
  const text = (r.content ?? []).find((c) => c.type === 'text')?.text;
  let data: unknown;
  try {
    data = JSON.parse(text ?? '');
  } catch {
    throw new Error(`nexus ${tool}: reply is not JSON`);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(`nexus ${tool}: reply is not an object`);
  const d = data as Record<string, unknown>;
  if (r.isError) throw Object.assign(new Error(`nexus ${tool}: ${typeof d.error === 'string' ? d.error.slice(0, 40) : 'error'}`), { code: d.error });
  return d;
}

const isRow = (t: unknown): t is ThreadRow =>
  !!t && typeof (t as ThreadRow).threadId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test((t as ThreadRow).threadId) &&
  typeof (t as ThreadRow).goal === 'string' && typeof (t as ThreadRow).status === 'string';

/** Thread rows out of a thread_list result. Rows that are not threads are dropped; a reply that is not a list fails. */
export function parseThreads(result: unknown): ThreadRow[] {
  const d = toolJson('thread_list', result);
  if (!Array.isArray(d.threads)) throw new Error('nexus thread_list: no threads list');
  return d.threads.filter(isRow);
}

export function threadObservation(t: ThreadRow): SourceObservation {
  const open = t.status === 'OPEN';
  return {
    type: 'thread.state', kind: 'thread', key: `thread:nexus:${t.threadId}`, name: clip(t.goal, 300) || 'thread',
    sensitivity: 'ops', externalId: `thread:${t.threadId}`, taintedPaths: ['name'],
    state: { status: open ? 'open' : 'archived' }, ...(open ? {} : { status: 'archived' as const }),
    ...(typeof t.updatedAt === 'string' ? { changedAt: t.updatedAt.slice(0, 40) } : {}),
  };
}

export function nexusSource(o: NexusOptions): Source & { endpoints: string[] } {
  return {
    name: 'nexus',
    cadenceMs: 5 * 60_000,
    endpoints: [o.url],
    async run(r: SourceRun): Promise<SyncResult> {
      const client = new Client({ name: 'flint-runtime', version: '1.0.0' });
      const transport = new StreamableHTTPClientTransport(new URL(o.url), {
        requestInit: { headers: { authorization: `Bearer ${o.token}` } },
        fetch: (url, init) => r.fetch(String(url), init as RequestInit),
      });
      await client.connect(transport as never);
      try {
        const rows = parseThreads(await client.callTool({ name: 'thread_list', arguments: { mine: false, status: 'OPEN', limit: NEXUS_LIST_LIMIT } }));
        const observations = rows.map(threadObservation);
        if (rows.length < NEXUS_LIST_LIMIT && r.known) {
          const open = new Set(observations.map((ob) => ob.key));
          for (const k of await r.known('thread')) {
            if (!k.key.startsWith('thread:nexus:') || open.has(k.key)) continue;
            const threadId = k.key.slice('thread:nexus:'.length);
            let ended: SourceObservation | undefined;
            try {
              const d = toolJson('thread_read', await client.callTool({ name: 'thread_read', arguments: { threadId, full: false } }));
              const row = { threadId, goal: typeof d.goal === 'string' ? d.goal : k.name, status: typeof d.status === 'string' ? d.status : 'OPEN' };
              // Still open but not listed (archived as superseded, or a race): left as it is.
              if (row.status !== 'OPEN') ended = threadObservation(row);
            } catch (err) {
              if ((err as { code?: unknown }).code !== 'NOT_FOUND') throw err;
              ended = { type: 'thread.state', kind: 'thread', key: k.key, name: k.name, sensitivity: 'ops', externalId: `thread:${threadId}`, taintedPaths: k.taintedPaths, state: { ...k.state, status: 'archived' }, status: 'archived' };
            }
            if (ended) observations.push(ended);
          }
        }
        return { observations, metrics: [] };
      } finally {
        await client.close().catch(() => {});
      }
    },
  };
}
