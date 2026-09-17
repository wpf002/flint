import type { Check } from './notifications';

/*
 * Tells Will when a Nexus build has finished, and nothing else.
 *
 * It used to push four things: a run started, a chat app's step was covered, a run
 * stalled, and a run finished. On 2026-09-16 Will asked for tests to run silently and to
 * hear only when one is done. Stalls and covered steps are the session running the test
 * to deal with, not him.
 */

type Call = (tool: string, args: unknown) => Promise<string>;

interface Listed {
  threadId: string;
  goal: string;
  status?: string;
  updatedAt?: string;
}

interface Turn {
  seq: number;
  by: string;
  kind?: string;
  summary?: string;
  content?: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const parse = <T>(text: string): T | undefined => {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
};

/** "Build aqi: a zero-dependency…" reads as "Build aqi". */
const runName = (goal: string) => (goal.split(/[:\n]/)[0] ?? goal).trim().slice(0, 60);

export function nexusRunCheck(call: Call, now: () => number = Date.now): Check {
  return async () => {
    const listed = parse<{ threads?: Listed[] }>(await call('nexus.thread_list', { mine: false, status: 'CLOSED', limit: 20 }));
    const found: Array<{ title: string; body: string; kind: string; dedupe: string }> = [];

    for (const t of listed?.threads ?? []) {
      // Standups are the group talking about itself, daily; not a run anyone waits on.
      if (/^Standup for /.test(t.goal)) continue;
      if (t.status && t.status !== 'CLOSED') continue;
      const updated = t.updatedAt ? Date.parse(t.updatedAt) : Number.NaN;
      if (!Number.isFinite(updated) || now() - updated > DAY_MS) continue;

      const turns = parse<{ turns?: Turn[] }>(await call('nexus.thread_read', { threadId: t.threadId }))?.turns ?? [];
      const last = turns.filter((turn) => turn.kind !== 'note').at(-1);
      found.push({
        title: 'Nexus run finished',
        body: `${runName(t.goal)}: ${last?.summary ?? 'closed'}`,
        kind: 'nexus',
        dedupe: `nexus:done:${t.threadId}`,
      });
    }
    return found;
  };
}
