import { describe, it, expect } from 'vitest';
import { tick, type Limits } from '../src/loop.js';
import type { Participant } from '../src/participant.js';

/**
 * The loop is the only part of this that costs money per iteration, so what these
 * cover is mostly the brakes: that a cap is a cap, that one busy participant cannot
 * starve the others, and that a thread which has stopped converging gets closed
 * rather than left waiting on someone who will never answer.
 */

interface FakeThread {
  threadId: string;
  goal: string;
  turns: number;
  yourTurn: boolean;
}

interface Fake {
  participant: Participant;
  calls: Array<{ tool: string; args: Record<string, unknown> }>;
  generations: number;
}

function fake(
  slug: string,
  threads: FakeThread[],
  reply: unknown = { content: 'work', summary: 'did work', next: 'other', ask: 'next bit' },
  floor: { status?: string; yourTurnIf?: string; reason?: string } = {},
): Fake {
  const status = floor.status ?? 'OPEN';
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const state = { generations: 0 };

  const participant = {
    slug,
    cfg: { slug, model: 'test-model', role: 'testing', maxOutputTokens: 500 },
    provider: {
      name: 'fake',
      generate: async () => {
        state.generations += 1;
        return {
          message: { id: 'x', role: 'assistant', content: JSON.stringify(reply), timestamp: 0 },
          usage: { input: 10, output: 5 },
          reason: floor.reason ?? 'complete',
        };
      },
    },
    call: async (tool: string, args: Record<string, unknown> = {}) => {
      calls.push({ tool, args });
      if (tool === 'thread_list') return { threads };
      if (tool === 'thread_read') {
        const t = threads.find((x) => x.threadId === args.threadId)!;
        return {
          threadId: t.threadId,
          goal: t.goal,
          status,
          yourTurnIf: floor.yourTurnIf ?? slug,
          turnCount: t.turns,
          ask: 'do the thing',
          participants: [{ slug, label: slug, good_at: 'testing' }],
          turns: [],
        };
      }
      if (tool === 'thread_append') return { seq: 1, next: (args.next as string) ?? null };
      return {};
    },
  } as unknown as Participant;

  return {
    participant,
    calls,
    get generations() {
      return state.generations;
    },
  } as Fake;
}

const limits = (over: Partial<Limits> = {}): Limits => ({
  maxTurnsPerTick: 10,
  maxTurnsPerThread: 20,
  runBudget: Number.POSITIVE_INFINITY,
  ...over,
});

const silent = (): void => {};

function threads(n: number, turns = 1): FakeThread[] {
  return Array.from({ length: n }, (_, i) => ({
    threadId: `t${i}`,
    goal: `goal ${i}`,
    turns,
    yourTurn: true,
  }));
}

describe('tick', () => {
  it('takes a turn on each thread that is waiting on it', async () => {
    const f = fake('claude', threads(2));

    const result = await tick([f.participant], limits(), silent);

    expect(result.turnsTaken).toBe(2);
    expect(f.calls.filter((c) => c.tool === 'thread_append')).toHaveLength(2);
  });

  it('ignores threads where the floor belongs to someone else', async () => {
    const f = fake('claude', [
      { threadId: 't0', goal: 'g', turns: 1, yourTurn: false },
      { threadId: 't1', goal: 'g', turns: 1, yourTurn: true },
    ]);

    const result = await tick([f.participant], limits(), silent);

    expect(result.turnsTaken).toBe(1);
    expect(f.calls.find((c) => c.tool === 'thread_read')!.args.threadId).toBe('t1');
  });

  it('stops at the per-tick cap, which is what bounds spend over time', async () => {
    const f = fake('claude', threads(9));

    const result = await tick([f.participant], limits({ maxTurnsPerTick: 3 }), silent);

    expect(result.turnsTaken).toBe(3);
    expect(f.generations).toBe(3);
  });

  it('stops at the remaining run budget even when the tick cap is higher', async () => {
    const f = fake('claude', threads(9));

    const result = await tick([f.participant], limits({ maxTurnsPerTick: 8, runBudget: 2 }), silent);

    expect(result.turnsTaken).toBe(2);
  });

  it('interleaves participants so one backlog cannot starve the others', async () => {
    const busy = fake('claude', threads(5));
    const quiet = fake('gpt', [{ threadId: 'q0', goal: 'g', turns: 1, yourTurn: true }]);

    await tick([busy.participant, quiet.participant], limits({ maxTurnsPerTick: 2 }), silent);

    expect(busy.generations).toBe(1);
    expect(quiet.generations).toBe(1);
  });

  it('closes a thread at the turn cap instead of leaving it waiting forever', async () => {
    const f = fake('claude', threads(1, 20));

    const result = await tick([f.participant], limits({ maxTurnsPerThread: 20 }), silent);

    expect(result.turnsTaken).toBe(0);
    expect(result.threadsClosed).toBe(1);

    const append = f.calls.find((c) => c.tool === 'thread_append')!;
    expect(append.args.done).toBe(true);
    expect(f.generations).toBe(0); // and without paying a model to say so
  });

  it('writes the facts a participant flagged as outliving the thread', async () => {
    const f = fake('claude', threads(1), {
      content: 'work',
      summary: 'did work',
      next: 'gpt',
      remember: ['The queue is Redis Streams.'],
    });

    await tick([f.participant], limits(), silent);

    const remembered = f.calls.find((c) => c.tool === 'remember');
    expect(remembered!.args.content).toBe('The queue is Redis Streams.');
  });

  it('reports a participant whose listing fails without stopping the others', async () => {
    const broken = {
      slug: 'gpt',
      cfg: { slug: 'gpt', model: 'm' },
      provider: { name: 'fake', generate: async () => { throw new Error('unused'); } },
      call: async () => {
        throw new Error('token revoked');
      },
    } as unknown as Participant;
    const healthy = fake('claude', threads(1));

    const result = await tick([broken, healthy.participant], limits(), silent);

    expect(result.turnsTaken).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('token revoked');
  });

  it('records a failed turn as an error rather than losing it silently', async () => {
    const f = fake('claude', threads(1));
    const broken = {
      ...f.participant,
      call: async (tool: string, args: Record<string, unknown> = {}) => {
        if (tool === 'thread_list') return { threads: threads(1) };
        throw new Error(`nexus.${tool} exploded`);
      },
    } as unknown as Participant;

    const result = await tick([broken], limits(), silent);

    expect(result.turnsTaken).toBe(0);
    expect(result.errors[0]).toContain('exploded');
  });
});

describe('a floor that moved between listing and reading', () => {
  /*
   * The model call sits between the listing and the append, so a stale listing that
   * is only caught by the append would have been paid for and then rejected.
   */
  it('skips without generating when someone else now holds the floor', async () => {
    const f = fake('claude', threads(1), undefined, { yourTurnIf: 'gpt' });

    const result = await tick([f.participant], limits(), silent);

    expect(result.turnsTaken).toBe(0);
    expect(f.generations).toBe(0);
    expect(f.calls.some((c) => c.tool === 'thread_append')).toBe(false);
  });

  it('skips without generating when the thread closed', async () => {
    const f = fake('claude', threads(1), undefined, { status: 'CLOSED' });

    const result = await tick([f.participant], limits(), silent);

    expect(result.turnsTaken).toBe(0);
    expect(f.generations).toBe(0);
  });
});

describe('a reply cut off at the token cap', () => {
  /*
   * Truncation used to arrive as unparseable JSON, so it was recorded as a turn that
   * nominated nobody. The thread stopped with nothing saying why.
   */
  it('records nothing and names the cap', async () => {
    const f = fake('claude', threads(1), undefined, { reason: 'max_tokens' });

    const result = await tick([f.participant], limits(), silent);

    expect(result.turnsTaken).toBe(0);
    expect(f.calls.some((c) => c.tool === 'thread_append')).toBe(false);
    expect(result.errors[0]).toMatch(/token cap/);
  });

  it('leaves the floor where it is, so the turn is retried once the cap is raised', async () => {
    const f = fake('claude', threads(1), undefined, { reason: 'max_tokens' });

    await tick([f.participant], limits(), silent);

    expect(f.calls.filter((c) => c.tool === 'thread_append')).toHaveLength(0);
  });
});
