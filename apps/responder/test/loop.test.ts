import { describe, it, expect } from 'vitest';
import { FlintError } from '@flint/core';
import { builderFor, coverMissedTurns, MISSED_TURN_CHECK_MS, MISSED_TURN_MS, tick, withRetry, type Limits } from '../src/loop.js';
import { Participant } from '../src/participant.js';

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
  waitingOn?: string | null;
  updatedAt?: string;
}

interface Fake {
  participant: Participant;
  calls: Array<{ tool: string; args: Record<string, unknown> }>;
  generations: number;
  /** What the last generate call was given. */
  lastArgs: unknown;
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
    built?: Array<{ name: string }>;
    participants?: Array<{ slug: string; label: string; good_at: string; answers_on_its_own?: boolean }>;
  } = {},
): Fake {
  const status = floor.status ?? 'OPEN';
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const state = { generations: 0, lastArgs: undefined as unknown };

  const participant = {
    slug,
    cfg: { slug, model: 'test-model', role: 'testing', maxOutputTokens: 500 },
    reportFailing: async () => {},
    reportRecovered: async () => {},
    recheck: async () => {},
    provider: {
      name: 'fake',
      generate: async (args: unknown) => {
        state.generations += 1;
        state.lastArgs = args;
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
          participants: floor.participants ?? [{ slug, label: slug, good_at: 'testing' }],
          turns: [],
        };
      }
      if (tool === 'thread_append') return { seq: 1, next: (args.next as string) ?? null };
      if (tool === 'check_inbox') return { handoffs: floor.offers ?? [] };
      if (tool === 'artifact_read') {
        return args.name
          ? { name: args.name, content: 'existing', version: 1, lastBy: 'gpt' }
          : { artifacts: floor.built ?? [] };
      }
      if (tool === 'artifact_write') return { name: args.name, version: 2, revised: true };
      return {};
    },
  } as unknown as Participant;

  return {
    participant,
    calls,
    get generations() {
      return state.generations;
    },
    get lastArgs() {
      return state.lastArgs;
    },
  } as Fake;
}

const limits = (over: Partial<Limits> = {}): Limits => ({
  maxTurnsPerTick: 10,
  maxTurnsPerThread: 20,
  runBudget: Number.POSITIVE_INFINITY,
  turnTimeoutMs: 90_000,
  retryDelaysMs: [],
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
      reportFailing: async () => {},
      reportRecovered: async () => {},
      recheck: async () => {},
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

describe("threads that cannot be answered", () => {
  const broken = (slug: string, thr: FakeThread[]) => {
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const participant = {
      slug,
      cfg: { slug, model: 'm', maxOutputTokens: 500 },
      replyMode: 'prompt',
      reportFailing: async () => {},
      reportRecovered: async () => {},
      recheck: async () => {},
      provider: { name: 'fake', generate: async () => { throw new Error('provider refused'); } },
      call: async (tool: string, args: Record<string, unknown> = {}) => {
        calls.push({ tool, args });
        if (tool === 'thread_list') return { threads: thr };
        if (tool === 'thread_read') {
          return { threadId: thr[0]!.threadId, goal: 'g', status: 'OPEN', yourTurnIf: slug, turnCount: 1, ask: 'a', participants: [], turns: [] };
        }
        return {};
      },
    } as unknown as Participant;
    return { participant, calls };
  };

  /*
   * Without a memory across rounds a thread that cannot be answered is retried every
   * fifteen seconds forever, and one broken thread spends the whole day's budget
   * failing.
   */
  it("rests a thread after repeated failures instead of retrying forever", async () => {
    const f = broken('claude', threads(1));
    const failures = new Map<string, number>();

    for (let round = 0; round < 3; round += 1) {
      await tick([f.participant], limits(), silent, failures);
    }
    const attemptsBefore = f.calls.filter((c) => c.tool === 'thread_read').length;

    await tick([f.participant], limits(), silent, failures);

    expect(attemptsBefore).toBe(3);
    expect(f.calls.filter((c) => c.tool === 'thread_read')).toHaveLength(3);
  });

  it("says it is resting the thread rather than failing silently", async () => {
    const f = broken('claude', threads(1));
    const failures = new Map<string, number>();

    let last = await tick([f.participant], limits(), silent, failures);
    for (let round = 0; round < 2; round += 1) {
      last = await tick([f.participant], limits(), silent, failures);
    }

    expect(last.errors[0]).toMatch(/resting it after 3 failures/);
  });

  /*
   * A thread that has quietly stopped being attempted looks exactly like a thread nobody
   * has got to yet, and those need opposite responses from a person. The log alone was
   * not enough: it is on this machine, and the console is where anyone looks.
   */
  it('writes the rest into the thread, where it can be seen', async () => {
    const f = broken('claude', threads(1));
    const failures = new Map<string, number>();

    for (let round = 0; round < 4; round += 1) {
      await tick([f.participant], limits(), silent, failures);
    }

    const notes = f.calls.filter((c) => c.tool === 'thread_note');
    expect(notes).toHaveLength(1);
    expect(notes[0]!.args).toMatchObject({ threadId: 't0' });
    expect((notes[0]!.args.resting as { why: string }).why).toContain('repeated failures');
  });

  it('says it once, not every round it stays rested', async () => {
    const f = broken('claude', threads(1));
    const failures = new Map<string, number>();

    for (let round = 0; round < 8; round += 1) {
      await tick([f.participant], limits(), silent, failures);
    }

    expect(f.calls.filter((c) => c.tool === 'thread_note')).toHaveLength(1);
  });

  it("forgets the failures as soon as a turn lands", async () => {
    const failures = new Map<string, number>([['t0', 2]]);
    const f = fake('claude', threads(1));

    await tick([f.participant], limits(), silent, failures);

    expect(failures.has('t0')).toBe(false);
  });
});

describe("a thread that has run out of turns", () => {
  /*
   * Closing is a turn, and a turn needs the floor. A capped thread whose floor was open
   * could never be closed: the append was refused every round, forever.
   */
  it("claims the floor before closing one it only volunteered for", async () => {
    const f = fake('claude', [{ threadId: 't0', goal: 'g', turns: 20, yourTurn: false }]);
    const withOpenFloor = {
      ...f.participant,
      call: async (tool: string, args: Record<string, unknown> = {}) => {
        if (tool === 'thread_list') {
          return { threads: [{ threadId: 't0', goal: 'g', turns: 20, yourTurn: false, floorOpen: true, youMatch: true }] };
        }
        return f.participant.call(tool, args);
      },
    } as unknown as Participant;

    const result = await tick([withOpenFloor], limits({ maxTurnsPerThread: 20 }), silent);

    expect(result.threadsClosed).toBe(1);
    const order = f.calls.map((c) => c.tool);
    expect(order.indexOf('thread_reassign')).toBeLessThan(order.indexOf('thread_append'));
  });

  it("closes one it already holds without reassigning", async () => {
    const f = fake('claude', threads(1, 20));

    await tick([f.participant], limits({ maxTurnsPerThread: 20 }), silent);

    expect(f.calls.some((c) => c.tool === 'thread_reassign')).toBe(false);
    expect(f.calls.find((c) => c.tool === 'thread_append')!.args.done).toBe(true);
  });
});

describe("a participant whose provider is down", () => {
  const failing = (slug: string, kind: string, message = 'down') => {
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const reported: boolean[] = [];
    const participant = {
      slug,
      cfg: { slug, model: 'm', maxOutputTokens: 500 },
      replyMode: 'prompt',
      reportFailing: async () => {
        reported.push(false);
      },
      reportRecovered: async () => {
        reported.push(true);
      },
      recheck: async () => {},
      provider: {
        name: 'fake',
        generate: async () => {
          throw new FlintError({ kind, message, retryable: true } as never);
        },
      },
      call: async (tool: string, args: Record<string, unknown> = {}) => {
        calls.push({ tool, args });
        if (tool === 'thread_list') return { threads: threads(1) };
        if (tool === 'thread_read') {
          return { threadId: 't0', goal: 'g', status: 'OPEN', yourTurnIf: slug, turnCount: 1, ask: 'a', participants: [], turns: [] };
        }
        return {};
      },
    } as unknown as Participant;
    return { participant, calls, reported };
  };

  const peer = () => fake('gpt', []).participant;

  /*
   * A participant whose provider is down should not hold a thread the others could
   * finish. Resting the thread instead punishes the work for a fault in one of them.
   */
  it("passes the thread to someone who can answer", async () => {
    const f = failing('claude', 'provider_unavailable');
    const failures = new Map<string, number>();

    await tick([f.participant, peer()], limits(), silent, failures);
    await tick([f.participant, peer()], limits(), silent, failures);

    const passed = f.calls.find((c) => c.tool === 'thread_reassign');
    expect(passed!.args.to).toBe('gpt');
  });

  it("says it could not answer, so the console stops showing it as fine", async () => {
    const f = failing('claude', 'timeout');
    const failures = new Map<string, number>();

    await tick([f.participant, peer()], limits(), silent, failures);
    await tick([f.participant, peer()], limits(), silent, failures);

    expect(f.reported).toContain(false);
  });

  it("does not pass on the first failure, which is usually nothing", async () => {
    const f = failing('claude', 'provider_unavailable');

    await tick([f.participant, peer()], limits(), silent, new Map());

    expect(f.calls.some((c) => c.tool === 'thread_reassign')).toBe(false);
  });

  /* A rejected payload fails the same way for everyone; passing it spreads the failure. */
  it("keeps a thread whose own content is the problem", async () => {
    const f = failing('claude', 'validation');
    const failures = new Map<string, number>();

    await tick([f.participant, peer()], limits(), silent, failures);
    const result = await tick([f.participant, peer()], limits(), silent, failures);

    expect(f.calls.some((c) => c.tool === 'thread_reassign')).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("keeps it when there is nobody else to pass it to", async () => {
    const f = failing('claude', 'provider_unavailable');
    const failures = new Map<string, number>();

    await tick([f.participant], limits(), silent, failures);
    const result = await tick([f.participant], limits(), silent, failures);

    expect(f.calls.some((c) => c.tool === 'thread_reassign')).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  /*
   * The sixth product build: the builder ran out of credit, and every attempt cost three
   * failures and a fifteen-minute rescue. No credit does not clear by waiting.
   */
  it("passes on at the first failure when the account is out of credit", async () => {
    const f = failing('gpt', 'validation', 'openai: You have no credits remaining. Add credits to continue.');

    await tick([f.participant, fake('claude', []).participant], limits(), silent, new Map());

    expect(f.calls.find((c) => c.tool === 'thread_reassign')?.args.to).toBe('claude');
  });

  it("passes to someone who can answer, not to the next name in the config", async () => {
    const f = failing('claude', 'provider_unavailable');
    const sick = fake('gpt', []).participant;
    (sick as unknown as { failing: boolean }).failing = true;
    const well = fake('perplexity', []).participant;
    const failures = new Map<string, number>();

    await tick([f.participant, sick, well], limits(), silent, failures);
    await tick([f.participant, sick, well], limits(), silent, failures);

    expect(f.calls.find((c) => c.tool === 'thread_reassign')?.args.to).toBe('perplexity');
  });

  it("prefers a builder among those who can answer", async () => {
    const f = failing('claude', 'provider_unavailable');
    const facts = fake('perplexity', []).participant;
    (facts as unknown as { cfg: { role: string } }).cfg.role = 'Current facts with sources.';
    const code = fake('gpt', []).participant;
    (code as unknown as { cfg: { role: string } }).cfg.role = 'Implementation and concrete code.';
    const failures = new Map<string, number>();

    await tick([f.participant, facts, code], limits(), silent, failures);
    await tick([f.participant, facts, code], limits(), silent, failures);

    expect(f.calls.find((c) => c.tool === 'thread_reassign')?.args.to).toBe('gpt');
  });
});

/* ChatGPT took none of its turns in forty hours of aqi builds, and each time the build just waited. */
describe('a chat app that misses its turn', () => {
  const now = Date.parse('2026-09-15T20:00:00Z');
  const waiting = (waitingOn: string, minutesAgo: number): FakeThread[] => [
    { threadId: 't0', goal: 'Build aqi', turns: 6, yourTurn: false, waitingOn, updatedAt: new Date(now - minutesAgo * 60_000).toISOString() },
  ];
  const fresh = () => ({ lastChecked: 0 });

  it("has the same maker's API model take the step and say why", async () => {
    const gpt = fake('gpt-api', waiting('chatgpt', 120));

    await coverMissedTurns([gpt.participant], silent, now, fresh());

    expect(gpt.calls.find((c) => c.tool === 'thread_reassign')?.args).toEqual({ threadId: 't0', to: 'gpt-api' });
    expect(String(gpt.calls.find((c) => c.tool === 'thread_note')?.args.content)).toContain('chatgpt did not take its turn');
  });

  it('leaves a step the app still has time for', async () => {
    const gpt = fake('gpt-api', waiting('chatgpt', MISSED_TURN_MS / 60_000 - 5));

    await coverMissedTurns([gpt.participant], silent, now, fresh());

    expect(gpt.calls.some((c) => c.tool === 'thread_reassign')).toBe(false);
  });

  it('leaves a floor held by anyone without a stand-in', async () => {
    const gpt = fake('gpt-api', waiting('flint', 600));

    await coverMissedTurns([gpt.participant], silent, now, fresh());

    expect(gpt.calls.some((c) => c.tool === 'thread_reassign')).toBe(false);
  });

  it('leaves it when the stand-in is not one of these participants', async () => {
    const claude = fake('claude-api', waiting('chatgpt', 600));

    await coverMissedTurns([claude.participant], silent, now, fresh());

    expect(claude.calls.some((c) => c.tool === 'thread_reassign')).toBe(false);
  });

  it('looks at most every few minutes', async () => {
    const gpt = fake('gpt-api', []);
    const state = fresh();

    await coverMissedTurns([gpt.participant], silent, now, state);
    await coverMissedTurns([gpt.participant], silent, now + MISSED_TURN_CHECK_MS - 1, state);

    expect(gpt.calls.filter((c) => c.tool === 'thread_list')).toHaveLength(1);
  });
});

/* The second aqi run handed a page that was still failing its design review to ChatGPT, an hour away. */
describe("a turn that hands a blocked build to a chat app", () => {
  const roster = [
    { slug: 'claude-api', label: 'Claude (API)', good_at: 'Interface design and code review.', answers_on_its_own: true },
    { slug: 'gpt-api', label: 'GPT (API)', good_at: 'Implementation and concrete code.', answers_on_its_own: true },
    { slug: 'chatgpt', label: 'ChatGPT', good_at: 'No profile set.', answers_on_its_own: false },
  ];
  const handoff = { content: 'Built it.', summary: 'built', next: 'chatgpt', ask: 'Review the page.' };

  it('keeps it with a builder and asks for what is missing', async () => {
    const blocked = [{ threadId: 't0', goal: 'Build a CLI; npm test passes.', turns: 3, yourTurn: true }];
    const f = fake('claude-api', blocked, handoff, { participants: roster });

    await tick([f.participant], limits(), silent);

    const append = f.calls.find((c) => c.tool === 'thread_append')?.args;
    expect(append?.next).toBe('gpt-api');
    expect(String(append?.ask)).toContain('passing test run');
  });

  it('hands a build with nothing blocking it to the chat app as asked', async () => {
    const f = fake('claude-api', threads(1), handoff, { participants: roster });

    await tick([f.participant], limits(), silent);

    const append = f.calls.find((c) => c.tool === 'thread_append')?.args;
    expect(append?.next).toBe('chatgpt');
    expect(append?.ask).toBe('Review the page.');
  });
});

/* Handing a thread to a participant that cannot answer parks it until somebody rescues it. */
describe("a turn that hands to a participant that cannot answer", () => {
  const roster = [
    { slug: 'claude', label: 'Claude', good_at: 'System design and code review.' },
    { slug: 'gpt', label: 'GPT', good_at: 'Implementation and concrete code.' },
    { slug: 'perplexity', label: 'Perplexity', good_at: 'Current facts with sources.' },
  ];
  const sick = () => {
    const p = fake('gpt', []).participant;
    (p as unknown as { failing: boolean }).failing = true;
    return p;
  };

  it("hands to someone who can instead, and says so in the thread", async () => {
    const f = fake('claude', threads(1), { content: 'Fixed the page.', summary: 'page', next: 'gpt', ask: 'Run the tests.' }, { participants: roster });

    await tick([f.participant, sick(), fake('perplexity', []).participant], limits(), silent);

    expect(f.calls.find((c) => c.tool === 'thread_append')?.args.next).toBe('perplexity');
    expect(String(f.calls.find((c) => c.tool === 'thread_note')?.args.content)).toContain('unable to answer');
  });

  it("leaves the floor open when nobody else can", async () => {
    const f = fake('claude', threads(1), { content: 'Fixed the page.', summary: 'page', next: 'gpt', ask: 'Run the tests.' }, { participants: roster.slice(0, 2) });

    await tick([f.participant, sick()], limits(), silent);

    expect(f.calls.find((c) => c.tool === 'thread_append')?.args.next).toBeUndefined();
  });

  it("keeps a nomination of someone who can answer", async () => {
    const f = fake('claude', threads(1), { content: 'Fixed the page.', summary: 'page', next: 'perplexity', ask: 'Check the docs.' }, { participants: roster });

    await tick([f.participant, sick(), fake('perplexity', []).participant], limits(), silent);

    expect(f.calls.find((c) => c.tool === 'thread_append')?.args.next).toBe('perplexity');
    expect(f.calls.some((c) => c.tool === 'thread_note')).toBe(false);
  });
});

describe("turns run alongside each other", () => {
  /** A participant whose turn takes a fixed time, so overlap is measurable. */
  const slow = (slug: string, ms: number) => {
    const participant = {
      slug,
      cfg: { slug, model: 'm', maxOutputTokens: 500 },
      replyMode: 'prompt',
      reportFailing: async () => {},
      reportRecovered: async () => {},
      recheck: async () => {},
      provider: {
        name: 'fake',
        generate: async () => {
          await new Promise((resolve) => setTimeout(resolve, ms));
          return {
            message: {
              id: 'x',
              role: 'assistant',
              content: JSON.stringify({ content: 'c', summary: 's', next: 'other', ask: 'a' }),
              timestamp: 0,
            },
            usage: { input: 1, output: 1 },
            reason: 'complete',
          };
        },
      },
      call: async (tool: string, args: Record<string, unknown> = {}) => {
        if (tool === 'thread_list') return { threads: [{ threadId: `${slug}-0`, goal: 'g', turns: 1, yourTurn: true }] };
        if (tool === 'thread_read') {
          return { threadId: `${slug}-0`, goal: 'g', status: 'OPEN', yourTurnIf: slug, turnCount: 1, ask: 'a', participants: [], turns: [] };
        }
        if (tool === 'thread_append') return { seq: 1, next: (args.next as string) ?? null };
        return {};
      },
    } as unknown as Participant;
    return participant;
  };

  /*
   * Sequentially one slow provider held up every other participant — a round spent
   * ninety seconds on a search model while two others sat idle with work in front of
   * them.
   */
  it("does not make one participant wait on another's provider", async () => {
    const started = Date.now();

    const result = await tick([slow('a', 120), slow('b', 120), slow('c', 120)], limits(), silent);

    expect(result.turnsTaken).toBe(3);
    // Three 120ms turns in sequence would be 360ms; overlapped they finish in ~120.
    expect(Date.now() - started).toBeLessThan(300);
  });

  it("still stops at the per-tick cap", async () => {
    const result = await tick([slow('a', 5), slow('b', 5), slow('c', 5)], limits({ maxTurnsPerTick: 2 }), silent);

    expect(result.turnsTaken).toBeLessThanOrEqual(2);
  });
});

describe("who goes first when the budget is nearly spent", () => {
  /*
   * A wave sized smaller than the number of participants has to choose. A fixed order
   * would hand every last slot to whoever happens to be first in the list.
   */
  it("does not always favour the same participant", async () => {
    const a = fake('a', threads(4));
    const b = fake('b', threads(4));

    await tick([a.participant, b.participant], limits({ maxTurnsPerTick: 3 }), silent);

    expect(a.generations).toBeGreaterThan(0);
    expect(b.generations).toBeGreaterThan(0);
  });
});

describe("saying it works again", () => {
  /*
   * Health was only ever reported downward. A provider that recovered stayed marked
   * broken until the next daily probe — up to a day of telling you something is wrong
   * when it is not, and a warning that is wrong that often stops being read.
   */
  const recovering = () => {
    const reported: boolean[] = [];
    const f = fake('claude', threads(1));
    const participant = {
      ...f.participant,
      reportFailing: async () => {
        reported.push(false);
      },
      reportRecovered: async () => {
        reported.push(true);
      },
      recheck: async () => {},
    } as unknown as Participant;
    return { participant, reported };
  };

  it("says so after a turn lands", async () => {
    const r = recovering();

    await tick([r.participant], limits(), silent);

    expect(r.reported).toContain(true);
  });

  it("says nothing when it never claimed to be failing", async () => {
    const f = fake('claude', threads(1));

    await tick([f.participant], limits(), silent);

    // The real participant only reports upward if it reported downward first, so a
    // healthy run costs no extra calls at all.
    expect(f.calls.some((c) => c.tool === 'report_health')).toBe(false);
  });
});

describe("re-checking a participant that reported itself failing", () => {
  /*
   * Clearing the mark only when a turn lands meant a participant that recovered stayed
   * flagged for as long as no work came its way — the console kept warning about
   * something that was fine, which is how a warning stops being read.
   */
  it("re-checks every round, whether or not there is work", async () => {
    let rechecks = 0;
    const idle = {
      slug: 'claude',
      cfg: { slug: 'claude', model: 'm' },
      replyMode: 'prompt',
      reportFailing: async () => {},
      reportRecovered: async () => {},
      recheck: async () => {
        rechecks += 1;
      },
      provider: { name: 'fake', generate: async () => { throw new Error('unused'); } },
      call: async () => ({ threads: [] }),
    } as unknown as Participant;

    await tick([idle], limits(), silent);
    await tick([idle], limits(), silent);

    expect(rechecks).toBe(2);
  });
});

describe("what the thread is actually for", () => {
  /*
   * Turns are a conversation; the artifact is the work. Without it the only way to get
   * value out of six turns is to read all six.
   */
  it("writes the artifact a turn produced", async () => {
    const f = fake('claude', threads(1), {
      content: 'Drafted it.',
      summary: 'Drafted.',
      next: 'gpt',
      ask: 'review',
      artifact: { name: 'pricing.md', content: '# Pricing\n\nTwo tiers.', note: 'First draft' },
    });

    await tick([f.participant], limits(), silent);

    const written = f.calls.find((c) => c.tool === 'artifact_write')!;
    expect(written.args.name).toBe('pricing.md');
    expect(written.args.content).toContain('Two tiers');
    expect(written.args.note).toBe('First draft');
  });

  it("writes nothing when the turn changed nothing about it", async () => {
    const f = fake('claude', threads(1));

    await tick([f.participant], limits(), silent);

    expect(f.calls.some((c) => c.tool === 'artifact_write')).toBe(false);
  });

  /* Without the current contents a participant can only write over the top, which is
   * how a document gets restarted five times instead of improved five times. */
  it("reads what already exists before taking its turn", async () => {
    const f = fake('claude', threads(1), undefined, { built: [{ name: 'pricing.md' }] });

    await tick([f.participant], limits(), silent);

    const reads = f.calls.filter((c) => c.tool === 'artifact_read');
    expect(reads.some((c) => c.args.name === 'pricing.md')).toBe(true);
  });

  it("still records the turn when the artifact cannot be written", async () => {
    const f = fake('claude', threads(1), {
      content: 'x',
      summary: 'y',
      next: 'gpt',
      ask: 'z',
      artifact: { name: 'pricing.md', content: 'draft' },
    });
    const blocked = {
      ...f.participant,
      call: async (tool: string, args: Record<string, unknown> = {}) => {
        if (tool === 'artifact_write') throw new Error('thread closed');
        return f.participant.call(tool, args);
      },
    } as unknown as Participant;

    const result = await tick([blocked], limits(), silent);

    expect(result.turnsTaken).toBe(1);
    expect(result.errors).toHaveLength(0);
  });
});

/*
 * A thread waiting on a participant that cannot answer.
 *
 * Passing a thread on happens when a turn is attempted and fails. A thread whose holder
 * is already known to be down never gets that far — it is not listed as anyone's turn, so
 * nothing tries it, and it simply stops with the console showing it waiting on someone
 * who is never going to speak.
 */
function stranded(
  slug: string,
  failing: boolean,
  others: Array<{ threadId: string; waitingOn: string; minutesAgo: number }>,
): Fake {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const participant = {
    slug,
    failing,
    cfg: { slug, model: 'm', role: 'testing', maxOutputTokens: 500 },
    reportFailing: async () => {},
    reportRecovered: async () => {},
    recheck: async () => {},
    provider: { name: 'fake', generate: async () => ({ message: { id: 'x', role: 'assistant', content: '{}', timestamp: 0 }, usage: { input: 1, output: 1 }, reason: 'complete' }) },
    call: async (tool: string, args: Record<string, unknown> = {}) => {
      calls.push({ tool, args });
      if (tool === 'thread_list') {
        return args.mine === false
          ? {
              threads: others.map((o) => ({
                threadId: o.threadId,
                goal: 'stuck',
                turns: 2,
                yourTurn: false,
                waitingOn: o.waitingOn,
                updatedAt: new Date(Date.now() - o.minutesAgo * 60_000).toISOString(),
              })),
            }
          : { threads: [] };
      }
      return {};
    },
  } as unknown as Participant;
  return { participant, calls, generations: 0 } as Fake;
}

describe('stranded threads', () => {
  /*
   * Handed on by the one that is stuck, not taken by the one picking it up. Nexus
   * refuses a participant taking someone else's floor for a day, so a rescuer asking for
   * it was refused every time — the rescue never happened at all.
   */
  it('has the stuck participant hand the thread on', async () => {
    const down = stranded('perplexity', true, []);
    const up = stranded('claude', false, [{ threadId: 'stuck', waitingOn: 'perplexity', minutesAgo: 30 }]);

    await tick([down.participant, up.participant], limits(), silent);

    expect(down.calls.find((c) => c.tool === 'thread_reassign')?.args).toMatchObject({
      threadId: 'stuck',
      to: 'claude',
    });
    // The rescuer must not ask for it itself: that is the call Nexus refuses.
    expect(up.calls.some((c) => c.tool === 'thread_reassign')).toBe(false);
  });

  /* Nothing to hand on with, so it falls back rather than doing nothing at all. */
  it('falls back to asking, when the holder is not one of ours', async () => {
    const down = stranded('perplexity', true, []);
    const up = stranded('claude', false, [{ threadId: 'stuck', waitingOn: 'someone-else', minutesAgo: 30 }]);

    await tick([down.participant, up.participant], limits(), silent);

    expect(up.calls.some((c) => c.tool === 'thread_reassign')).toBe(false);
  });

  it('says in the thread why the speaker changed', async () => {
    const down = stranded('perplexity', true, []);
    const up = stranded('claude', false, [{ threadId: 'stuck', waitingOn: 'perplexity', minutesAgo: 30 }]);

    await tick([down.participant, up.participant], limits(), silent);

    const note = up.calls.find((c) => c.tool === 'thread_note');
    expect(String(note?.args.content)).toContain('perplexity');
  });

  // A model is allowed to be slow. Snatching a thread away from whoever holds it because
  // one round went by would break every long turn.
  it('leaves a recently-moved thread alone', async () => {
    const down = stranded('perplexity', true, []);
    const up = stranded('claude', false, [{ threadId: 'stuck', waitingOn: 'perplexity', minutesAgo: 2 }]);

    await tick([down.participant, up.participant], limits(), silent);

    expect(up.calls.some((c) => c.tool === 'thread_reassign')).toBe(false);
  });

  // A thread waiting on a person is waiting on a person. Moving it would be answering
  // for them.
  it('leaves a thread held by someone this runner does not drive', async () => {
    const down = stranded('perplexity', true, []);
    const up = stranded('claude', false, [{ threadId: 'stuck', waitingOn: 'will', minutesAgo: 90 }]);

    await tick([down.participant, up.participant], limits(), silent);

    expect(up.calls.some((c) => c.tool === 'thread_reassign')).toBe(false);
  });

  it('does not look for stranded threads while everyone is well', async () => {
    const a = stranded('claude', false, [{ threadId: 'stuck', waitingOn: 'perplexity', minutesAgo: 90 }]);

    await tick([a.participant], limits(), silent);

    expect(a.calls.some((c) => c.tool === 'thread_list' && c.args.mine === false)).toBe(false);
  });
});


/*
 * "Am I failing" lived only in this process, while the mark lives in Nexus. A restart
 * therefore left a participant that works perfectly marked broken with nothing able to
 * clear it — both reportRecovered and recheck return early unless this process set it.
 *
 * Built through the real class rather than a stand-in, because the whole bug lives in
 * private state that an object literal does not have.
 */
describe('a failure mark that outlived the process', () => {
  const restarted = (health: string, answers: boolean) => {
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    let probes = 0;
    const provider = {
      name: 'fake',
      generate: async () => {
        probes += 1;
        if (!answers) throw new Error('still down');
        return {
          message: { id: 'x', role: 'assistant', content: '{}', timestamp: 0 },
          usage: { input: 1, output: 1 },
          reason: 'complete',
        };
      },
    };
    // Shaped like a real MCP reply, so the parsing in Participant.call is exercised
    // rather than bypassed.
    const server = {
      client: {
        callTool: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
          calls.push({ tool: name, args });
          const body = name === 'whoami' ? { namespace: 'claude', health } : {};
          return { content: [{ type: 'text', text: JSON.stringify(body) }] };
        },
      },
    };
    const Ctor = Participant as unknown as new (
      cfg: unknown,
      provider: unknown,
      server: unknown,
    ) => Participant;
    const participant = new Ctor(
      { slug: 'claude', model: 'm', role: 'testing', maxOutputTokens: 500, turnTimeoutMs: 1_000 },
      provider,
      server,
    );
    return { participant, calls, probes: () => probes };
  };

  it('picks the mark back up from Nexus', async () => {
    const p = restarted('failing', true);
    await p.participant.adoptHealth();
    expect(p.participant.failing).toBe(true);
  });

  it('leaves a healthy participant alone', async () => {
    const p = restarted('ok', true);
    await p.participant.adoptHealth();
    expect(p.participant.failing).toBe(false);
  });

  it('clears the mark on the very next round, not after the usual wait', async () => {
    const p = restarted('failing', true);
    await p.participant.adoptHealth();

    await p.participant.recheck();

    expect(p.probes()).toBe(1);
    expect(p.calls.some((c) => c.tool === 'report_health' && c.args.ok === true)).toBe(true);
    expect(p.participant.failing).toBe(false);
  });

  it('leaves the mark standing while the model really is down', async () => {
    const p = restarted('failing', false);
    await p.participant.adoptHealth();

    await p.participant.recheck();

    expect(p.participant.failing).toBe(true);
    expect(p.calls.some((c) => c.tool === 'report_health' && c.args.ok === true)).toBe(false);
  });

  /*
   * A key that has run out of credit and a provider outage both read as "model failing",
   * and one of those you can fix in a minute. The probe is the only thing that knows
   * which, so it has to say.
   */
  it('says why it is still failing, every time it checks', async () => {
    const p = restarted('failing', false);
    await p.participant.adoptHealth();

    await p.participant.recheck();

    const said = p.calls.find((c) => c.tool === 'report_health' && c.args.ok === false);
    expect(String(said?.args.note)).toContain('still down');
  });
});

/*
 * What reaches a person's canon review queue. Standups filled it with notes about the
 * standup process, and over-long proposals are refused by Nexus anyway.
 */
describe('canon proposals', () => {
  const closing = (canon: unknown) => ({ content: 'Done.', summary: 'done', next: null, ask: null, done: true, canon });

  it('proposes what an ordinary thread concluded', async () => {
    const f = fake('claude', [{ threadId: 't0', goal: 'Pick a queue', turns: 2, yourTurn: true }], closing({ key: 'queue', content: 'Use Redis.', rationale: 'Cheapest.' }));
    await tick([f.participant], limits(), silent);
    expect(f.calls.filter((c) => c.tool === 'propose_canon')).toHaveLength(1);
  });

  it('does not propose canon from a standup', async () => {
    const f = fake('claude', [{ threadId: 't0', goal: 'Standup for 2026-09-13: how this group is working, and what should change', turns: 2, yourTurn: true }], closing({ key: 'nexus.standup.x', content: 'We need logs.', rationale: 'Said twice.' }));
    await tick([f.participant], limits(), silent);
    expect(f.calls.some((c) => c.tool === 'propose_canon')).toBe(false);
    // The turn itself still lands. Only the proposal is dropped.
    expect(f.calls.some((c) => c.tool === 'thread_append')).toBe(true);
  });

  it('does not send a proposal longer than Nexus accepts', async () => {
    const f = fake('claude', [{ threadId: 't0', goal: 'Pick a queue', turns: 2, yourTurn: true }], closing({ key: 'queue', content: 'x'.repeat(601), rationale: 'r' }));
    await tick([f.participant], limits(), silent);
    expect(f.calls.some((c) => c.tool === 'propose_canon')).toBe(false);
  });
});

describe('closing a build thread', () => {
  const GOAL = "Build csv2md. It's done when `npm test` passes in the build sandbox.";
  const closes = { content: 'Confirmed the APIs.', summary: 'confirmed', next: null, ask: null, done: true };

  it('keeps the thread open when nothing has been run', async () => {
    const f = fake('perplexity-api', [{ threadId: 't0', goal: GOAL, turns: 1, yourTurn: true }], closes);
    await tick([f.participant], limits(), silent);

    const append = f.calls.find((c) => c.tool === 'thread_append');
    expect(append?.args.done).toBe(false);
    expect(String(append?.args.ask)).toMatch(/run the tests/);
  });

  it('says in the thread why it stayed open', async () => {
    const f = fake('perplexity-api', [{ threadId: 't0', goal: GOAL, turns: 1, yourTurn: true }], closes);
    await tick([f.participant], limits(), silent);

    const note = f.calls.find((c) => c.tool === 'thread_note');
    expect(String(note?.args.content)).toMatch(/Not closed yet/);
  });

  it('lets an ordinary thread close as before', async () => {
    const f = fake('claude', [{ threadId: 't0', goal: 'Pick a queue', turns: 2, yourTurn: true }], closes);
    await tick([f.participant], limits(), silent);

    expect(f.calls.find((c) => c.tool === 'thread_append')?.args.done).toBe(true);
    expect(f.calls.some((c) => c.tool === 'thread_note')).toBe(false);
  });
});

describe('canon from a build thread', () => {
  it('is not proposed: the product is the result', async () => {
    const f = fake(
      'gpt-api',
      [{ threadId: 't0', goal: "Build csv2md. Done when `npm test` passes.", turns: 9, yourTurn: true }],
      { content: 'Done.', summary: 'done', next: null, ask: null, done: false, canon: { key: 'cli.csv2md', content: 'csv2md exists.', rationale: 'Built it.' } },
    );
    await tick([f.participant], limits(), silent);
    expect(f.calls.some((c) => c.tool === 'propose_canon')).toBe(false);
  });
});

describe('a turn that sends more files than it may write', () => {
  it('tells the thread which files were not written', async () => {
    const files = Array.from({ length: 17 }, (_, i) => ({ name: i === 16 ? 'README.md' : `src/f${i}.js`, content: 'x', note: null }));
    const f = fake('gpt-api', [{ threadId: 't0', goal: 'Pick a queue', turns: 2, yourTurn: true }], { content: 'Built.', summary: 'built', next: 'claude', ask: 'review', done: false, files });
    await tick([f.participant], limits(), silent);

    const note = f.calls.find((c) => c.tool === 'thread_note');
    expect(String(note?.args.content)).toContain('README.md');
  });
});

describe('withRetry', () => {
  const unavailable = () => new FlintError({ kind: 'provider_unavailable', message: 'HTTP 502', retryable: true } as never);

  it('returns once a retry succeeds', async () => {
    let calls = 0;
    const result = await withRetry(silent, 'perplexity-api', async () => {
      calls += 1;
      if (calls < 3) throw unavailable();
      return 'answered';
    }, [0, 0]);
    expect(result).toBe('answered');
    expect(calls).toBe(3);
  });

  it('gives up after the last delay', async () => {
    let calls = 0;
    await expect(withRetry(silent, 'p', async () => { calls += 1; throw unavailable(); }, [0, 0])).rejects.toThrow();
    expect(calls).toBe(3);
  });

  /* A turn that already ran out its clock would only run it out again. */
  it('does not retry a timeout', async () => {
    let calls = 0;
    const timeout = new FlintError({ kind: 'timeout', message: 'slow', retryable: true } as never);
    await expect(withRetry(silent, 'p', async () => { calls += 1; throw timeout; }, [0, 0])).rejects.toThrow();
    expect(calls).toBe(1);
  });
});

describe('builderFor', () => {
  const roster = [
    { slug: 'claude-api', good_at: 'System design, code review, and finding the flaw in a plan.' },
    { slug: 'gpt-api', good_at: 'Implementation, concrete code, schemas, and turning a design into something that runs.' },
    { slug: 'perplexity-api', good_at: 'Current facts with sources: pricing, rate limits, API changes.' },
  ];

  it('picks the strongest coder who did not just speak', () => {
    expect(builderFor(roster, 'claude-api')).toBe('gpt-api');
  });

  /* The second product build routed "fix the failing tests" to Perplexity. */
  it('never picks the fact-checker over a coder', () => {
    expect(builderFor(roster, 'gpt-api')).toBe('claude-api');
    expect(builderFor(roster, 'perplexity-api')).toBe('gpt-api');
  });

  it('leaves routing to Nexus when nobody codes', () => {
    expect(builderFor([{ slug: 'perplexity-api', good_at: 'Current facts.' }], 'gpt-api')).toBeNull();
  });
});

/* A three-line fix used to cost the whole file again in output tokens. */
describe('a turn that edits a file instead of resending it', () => {
  it('writes the file with the change applied', async () => {
    const f = fake(
      'gpt',
      threads(1),
      { content: 'Tightened the button.', summary: 'edit', next: null, edits: [{ name: 'a.md', find: 'exist', replace: 'revis', note: 'shorter' }] },
      { built: [{ name: 'a.md' }] },
    );
    await tick([f.participant], limits(), silent);

    expect(f.calls.find((c) => c.tool === 'artifact_write')?.args).toMatchObject({ name: 'a.md', content: 'revising', note: 'shorter' });
  });

  it('leaves the file alone and says so when the text is not there', async () => {
    const f = fake(
      'gpt',
      threads(1),
      { content: 'x', summary: 'y', next: null, edits: [{ name: 'a.md', find: 'nope', replace: 'z', note: null }] },
      { built: [{ name: 'a.md' }] },
    );
    await tick([f.participant], limits(), silent);

    expect(f.calls.some((c) => c.tool === 'artifact_write')).toBe(false);
    expect(String(f.calls.find((c) => c.tool === 'thread_note')?.args.content)).toContain('could not be applied');
  });
});

/* Every turn re-sent the whole thread and every file; most of it was the same as last time. */
describe('what a turn sends the model', () => {
  it('puts what stays the same in the system prompt, and the conversation in the message', async () => {
    const f = fake('gpt', threads(1), undefined, { built: [{ name: 'a.md' }] });
    await tick([f.participant], limits(), silent);

    const args = f.lastArgs as { system: string; messages: Array<{ content: string }>; cache?: unknown };
    expect(args.system).toContain('GOAL: goal 0');
    expect(args.system).toContain('--- a.md');
    expect(args.messages[0]?.content).toContain('THREAD SO FAR');
    expect(args.messages[0]?.content).not.toContain('--- a.md');
    expect(args.cache).toBeUndefined();
  });
});

/* One standup ran twelve turns and wrote five versions of a retry procedure nobody asked for. */
describe('a standup', () => {
  const goal = 'Standup for 2026-09-14: how this group is working, and what should change';

  it('writes no files and runs nothing, whatever a turn sends', async () => {
    const f = fake('gpt', [{ threadId: 's0', goal, turns: 1, yourTurn: true }], {
      content: 'The handoff to Perplexity wastes a turn.',
      summary: 'handoffs',
      next: 'claude',
      files: [{ name: 'ops/retry-sop.md', content: 'x', note: null }],
      run: [['npm', 'test']],
    });
    await tick([f.participant], limits(), silent);

    expect(f.calls.some((c) => c.tool === 'artifact_write')).toBe(false);
    expect(f.calls.find((c) => c.tool === 'thread_append')?.args.runs).toBeUndefined();
  });

  it('closes at its own short cap, not the build cap', async () => {
    const f = fake('gpt', [{ threadId: 's0', goal, turns: 4, yourTurn: true }]);
    const result = await tick([f.participant], limits({ maxTurnsPerThread: 30 }), silent);

    expect(result.threadsClosed).toBe(1);
    expect(f.generations).toBe(0);
  });
});
