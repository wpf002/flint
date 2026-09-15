import { describe, it, expect } from 'vitest';
import { nexusRunCheck, STALLED_MS } from '../src/nexus-watch';

const now = Date.parse('2026-09-15T20:00:00Z');
const ago = (ms: number) => new Date(now - ms).toISOString();

/** A fake Nexus: thread_list returns `threads`, thread_read returns the turns for an id. */
const nexus = (threads: unknown[], turns: Record<string, unknown[]> = {}) => {
  const calls: string[] = [];
  const call = async (tool: string, args: unknown) => {
    calls.push(tool);
    if (tool === 'nexus.thread_list') return JSON.stringify({ threads });
    const { threadId } = args as { threadId: string };
    return JSON.stringify({ threadId, turns: turns[threadId] ?? [] });
  };
  return { call, calls };
};

const goal = 'Build aqi: a zero-dependency Node.js 22 app';

describe('nexusRunCheck', () => {
  it('says a run started and who it is waiting on', async () => {
    const { call } = nexus([{ threadId: 't1', goal, status: 'OPEN', waitingOn: 'perplexity', updatedAt: ago(60_000) }]);

    const found = await nexusRunCheck(call, () => now)();

    expect(found).toEqual([
      { title: 'Nexus run started', body: 'Build aqi is under way, waiting on perplexity.', kind: 'nexus', dedupe: 'nexus:start:t1' },
    ]);
  });

  it('says when a chat app missed its step and an API model took it', async () => {
    const note = { seq: 9, by: 'gpt-api', kind: 'note', content: 'chatgpt did not take its turn within 90 minutes, so gpt-api is doing its part. The ask is unchanged.' };
    const { call } = nexus([{ threadId: 't1', goal, status: 'OPEN', waitingOn: 'gpt-api', updatedAt: ago(60_000) }], { t1: [note] });

    const found = await nexusRunCheck(call, () => now)();

    expect(found.find((f) => f.title === 'Nexus step covered')).toMatchObject({ body: `Build aqi: ${note.content}`, dedupe: 'nexus:cover:t1:9' });
  });

  it('says a run has stalled once it has waited three hours', async () => {
    const { call } = nexus([{ threadId: 't1', goal, status: 'OPEN', waitingOn: 'chatgpt', updatedAt: ago(STALLED_MS + 3_600_000) }]);

    const found = await nexusRunCheck(call, () => now)();

    expect(found.find((f) => f.title === 'Nexus run stalled')?.body).toBe('Build aqi has waited on chatgpt for 4 hours.');
  });

  it('says a run finished with what its last turn said, ignoring notes', async () => {
    const turns = [
      { seq: 30, by: 'claude-api', summary: 'Made the five review fixes; tests and design review pass.' },
      { seq: 31, by: 'claude-api', kind: 'note', content: 'something' },
    ];
    const { call } = nexus([{ threadId: 't1', goal, status: 'CLOSED', waitingOn: null, updatedAt: ago(60_000) }], { t1: turns });

    const found = await nexusRunCheck(call, () => now)();

    expect(found).toEqual([
      { title: 'Nexus run finished', body: 'Build aqi: Made the five review fixes; tests and design review pass.', kind: 'nexus', dedupe: 'nexus:done:t1' },
    ]);
  });

  it('skips standups and anything untouched for a day', async () => {
    const { call, calls } = nexus([
      { threadId: 's', goal: 'Standup for 2026-09-15: how this group is working', status: 'OPEN', waitingOn: 'gpt-api', updatedAt: ago(60_000) },
      { threadId: 'old', goal, status: 'CLOSED', updatedAt: ago(2 * 24 * 3_600_000) },
    ]);

    expect(await nexusRunCheck(call, () => now)()).toEqual([]);
    expect(calls).toEqual(['nexus.thread_list']);
  });

  it('stays quiet when Nexus gives nothing back', async () => {
    expect(await nexusRunCheck(async () => '', () => now)()).toEqual([]);
  });
});
