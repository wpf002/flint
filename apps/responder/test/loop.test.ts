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
  floor: {
    status?: string;
    yourTurnIf?: string;
    reason?: string;
    offers?: Array<{ id: string; subject: string; content: string; from: { slug: string } }>;
  } = {},
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
      if (tool === 'check_inbox') return { handoffs: floor.offers ?? [] };
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
  turnTimeoutMs: 90_000,
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

describe('what a turn cost', () => {
  it('reports its own token usage, since Nexus cannot measure it', async () => {
    const f = fake('claude', threads(1));

    await tick([f.participant], limits(), silent);

    const append = f.calls.find((c) => c.tool === 'thread_append')!;
    expect(append.args.tokensIn).toBe(10);
    expect(append.args.tokensOut).toBe(5);
  });
});

describe('a thread that reaches a conclusion', () => {
  const conclusion = {
    content: 'Settled on Redis Streams.',
    summary: 'Settled the queue question.',
    done: true,
    canon: { key: 'queue.choice', content: 'Redis Streams', rationale: 'Ordering plus replay.' },
  };

  /*
   * Offering the conclusion to shared memory is the natural end of a thread. It is a
   * proposal, never a write — canon stays human-approved, which no amount of prompting
   * can change on the Nexus side.
   */
  it('proposes what it concluded, for a person to approve', async () => {
    const f = fake('claude', threads(1), conclusion);

    await tick([f.participant], limits(), silent);

    const proposed = f.calls.find((c) => c.tool === 'propose_canon');
    expect(proposed!.args.key).toBe('queue.choice');
    expect(proposed!.args.content).toBe('Redis Streams');
    expect(proposed!.args.rationale).toBe('Ordering plus replay.');
  });

  it('proposes nothing while the thread is still going', async () => {
    const f = fake('claude', threads(1), { ...conclusion, done: false, next: 'gpt' });

    await tick([f.participant], limits(), silent);

    expect(f.calls.some((c) => c.tool === 'propose_canon')).toBe(false);
  });

  it('still records the closing turn when the proposal is rejected', async () => {
    const f = fake('claude', threads(1), conclusion);
    const flaky = {
      ...f.participant,
      call: async (tool: string, args: Record<string, unknown> = {}) => {
        if (tool === 'propose_canon') throw new Error('key already proposed');
        return f.participant.call(tool, args);
      },
    } as unknown as typeof f.participant;

    const result = await tick([flaky], limits(), silent);

    expect(result.turnsTaken).toBe(1);
    expect(result.errors).toHaveLength(0);
  });

  it('closes without proposing when nothing was worth keeping', async () => {
    const f = fake('claude', threads(1), { content: 'x', summary: 'x', done: true });

    await tick([f.participant], limits(), silent);

    expect(f.calls.some((c) => c.tool === 'propose_canon')).toBe(false);
    expect(f.calls.find((c) => c.tool === 'thread_append')!.args.done).toBe(true);
  });
});

describe('facts travelling between participants', () => {
  const offer = { id: 'h1', subject: 'Redis Streams', content: 'The queue is Redis Streams.', from: { slug: 'gpt' } };

  /*
   * A fact learned mid-thread is usually a fact the next speaker needs. Offering it
   * rather than pushing it is the rule the whole handoff mechanism exists to enforce.
   */
  it('offers a remembered fact onward to whoever speaks next', async () => {
    const f = fake('claude', threads(1), {
      content: 'work',
      summary: 'did work',
      next: 'gpt',
      ask: 'next bit',
      remember: ['The queue is Redis Streams.'],
    });

    await tick([f.participant], limits(), silent);

    const sent = f.calls.find((c) => c.tool === 'handoff')!;
    expect(sent.args.to).toBe('gpt');
    expect(sent.args.content).toBe('The queue is Redis Streams.');
  });

  it('offers nothing onward when nobody was nominated', async () => {
    const f = fake('claude', threads(1), {
      content: 'work',
      summary: 'did work',
      done: true,
      remember: ['A fact.'],
    });

    await tick([f.participant], limits(), silent);

    expect(f.calls.some((c) => c.tool === 'handoff')).toBe(false);
    expect(f.calls.some((c) => c.tool === 'remember')).toBe(true);
  });

  it('keeps an offer it chose to accept', async () => {
    const f = fake(
      'claude',
      threads(1),
      { content: 'work', summary: 'did work', next: 'gpt', ask: 'go', accept: ['h1'] },
      { offers: [offer] },
    );

    await tick([f.participant], limits(), silent);

    const accepted = f.calls.find((c) => c.tool === 'accept_handoff')!;
    expect(accepted.args.handoffId).toBe('h1');
    expect(accepted.args.content).toBe('The queue is Redis Streams.');
  });

  /* Anything not accepted simply stays pending and lapses. Silence is a decision. */
  it('leaves an offer alone when it was not accepted', async () => {
    const f = fake('claude', threads(1), undefined, { offers: [offer] });

    await tick([f.participant], limits(), silent);

    expect(f.calls.some((c) => c.tool === 'accept_handoff')).toBe(false);
  });

  it('ignores an accept naming an offer it was never shown', async () => {
    const f = fake('claude', threads(1), {
      content: 'x',
      summary: 'y',
      next: 'gpt',
      ask: 'z',
      accept: ['not-a-real-offer'],
    });

    await tick([f.participant], limits(), silent);

    expect(f.calls.some((c) => c.tool === 'accept_handoff')).toBe(false);
  });

  it('still takes the turn when the inbox cannot be read', async () => {
    const f = fake('claude', threads(1));
    const blind = {
      ...f.participant,
      call: async (tool: string, args: Record<string, unknown> = {}) => {
        if (tool === 'check_inbox') throw new Error('inbox unavailable');
        return f.participant.call(tool, args);
      },
    } as unknown as typeof f.participant;

    const result = await tick([blind], limits(), silent);

    expect(result.turnsTaken).toBe(1);
    expect(result.errors).toHaveLength(0);
  });
});
