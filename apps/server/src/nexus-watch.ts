import type { Check } from './notifications';

/*
 * Tells Will what the Nexus builds are doing, so he doesn't have to go and look.
 *
 * A build moves through three chat apps on their own hourly schedules and the API models
 * in between. Finding out where one stood meant opening ChatGPT, Perplexity, Claude's
 * routines and the Nexus console, and a run that had stalled looked the same as one that
 * was working. This reads Nexus on the watcher's interval and pushes four things: a run
 * started, a chat app missed its step and its API model took it, a run has stalled, and a
 * run finished with what its last turn said.
 */

type Call = (tool: string, args: unknown) => Promise<string>;

interface Listed {
  threadId: string;
  goal: string;
  status?: string;
  waitingOn?: string | null;
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
/** Longer than a missed hourly check plus the 90 minutes before a stand-in takes the step. */
export const STALLED_MS = 3 * 60 * 60 * 1000;
/** The note Flint's responder writes when an API model covers a chat app's step. */
const COVERED = /did not take its turn within 90 minutes/;

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
    const listed = parse<{ threads?: Listed[] }>(await call('nexus.thread_list', { mine: false, status: 'ANY', limit: 20 }));
    const found: Array<{ title: string; body: string; kind: string; dedupe: string }> = [];

    for (const t of listed?.threads ?? []) {
      // Standups are the group talking about itself, daily; not a run anyone waits on.
      if (/^Standup for /.test(t.goal)) continue;
      const updated = t.updatedAt ? Date.parse(t.updatedAt) : Number.NaN;
      if (!Number.isFinite(updated) || now() - updated > DAY_MS) continue;

      const run = runName(t.goal);
      const id = t.threadId;
      const open = t.status === 'OPEN';

      if (open) {
        found.push({
          title: 'Nexus run started',
          body: `${run} is under way${t.waitingOn ? `, waiting on ${t.waitingOn}` : ''}.`,
          kind: 'nexus',
          dedupe: `nexus:start:${id}`,
        });
        if (t.waitingOn && now() - updated > STALLED_MS) {
          found.push({
            title: 'Nexus run stalled',
            body: `${run} has waited on ${t.waitingOn} for ${Math.floor((now() - updated) / 3_600_000)} hours.`,
            kind: 'nexus',
            dedupe: `nexus:stall:${id}:${t.waitingOn}`,
          });
        }
      }

      const turns = parse<{ turns?: Turn[] }>(await call('nexus.thread_read', { threadId: id }))?.turns ?? [];
      for (const turn of turns) {
        if (turn.kind === 'note' && COVERED.test(turn.content ?? '')) {
          found.push({ title: 'Nexus step covered', body: `${run}: ${turn.content}`, kind: 'nexus', dedupe: `nexus:cover:${id}:${turn.seq}` });
        }
      }

      if (!open) {
        const last = turns.filter((turn) => turn.kind !== 'note').at(-1);
        found.push({
          title: 'Nexus run finished',
          body: `${run}: ${last?.summary ?? 'closed'}`,
          kind: 'nexus',
          dedupe: `nexus:done:${id}`,
        });
      }
    }
    return found;
  };
}
