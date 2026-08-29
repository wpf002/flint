import { describe, it, expect } from 'vitest';
import { dueToday, openStandup, promptFor, promptFrom, standupGoal, STANDUP_ASK } from '../src/standup.js';

/*
 * The standup exists because the participants only ever meet inside work threads, so
 * they learn nothing about each other except whatever a goal happened to require — and
 * their roles, which routing reads on every nomination, were written once from guesswork
 * and never revised by the only parties who know whether they are true.
 */

describe('the question', () => {
  /*
   * Every participant in one standup must be answering the same thing, or the replies
   * cannot be read against each other — which is the entire point of asking.
   */
  it('is the same for everyone on a given day', () => {
    expect(promptFor('2026-08-25')).toBe(promptFor('2026-08-25'));
  });

  /* A standing question gets a standing answer: asked the same thing weekly, a model
   * reproduces last week's reply from the shape of the question. */
  it('changes from day to day', () => {
    const week = ['2026-08-25', '2026-08-26', '2026-08-27', '2026-08-28', '2026-08-29'];
    const asked = new Set(week.map((d) => promptFor(d)));

    expect(asked.size).toBeGreaterThan(1);
  });

  it('asks about the group rather than about the model itself', () => {
    const all = ['2026-01-01', '2026-03-15', '2026-06-30', '2026-09-09', '2026-12-25'].map((d) =>
      promptFor(d),
    );

    // Not every one ends in a question mark — some are imperatives ("Name something
    // you now know…"), which ask just as directly.
    for (const question of all) {
      expect(question.length).toBeGreaterThan(20);
      expect(question).toMatch(/others|group|you/i);
    }
  });

  it('draws from whatever pool it is given', () => {
    expect(promptFor('2026-08-25', ['only one'])).toBe('only one');
  });
});

describe('the ask', () => {
  /* Fixing a wrong role is the one change here that outlives the thread. */
  it('tells them to correct their own role when it is wrong', () => {
    expect(STANDUP_ASK('Anything?')).toMatch(/set_role/);
  });

  it('asks for what happened rather than what would be nice', () => {
    expect(STANDUP_ASK('Anything?')).toMatch(/actually happened/);
  });
});

describe('the goal', () => {
  /*
   * Dated because Nexus refuses a goal already open, and an undated one would be refused
   * as a duplicate of the last standup rather than opened as today's.
   */
  it('is different each day, so today is not yesterday repeated', () => {
    expect(standupGoal('2026-08-25')).not.toBe(standupGoal('2026-08-26'));
  });

  it('reads as its own explanation', () => {
    expect(standupGoal('2026-08-25')).toMatch(/how this group is working/);
  });
});

describe('dueToday', () => {
  it('is due when no standup has ever been held', () => {
    expect(dueToday('2026-08-29', null)).toBe(true);
  });

  it('is not due again on the same day', () => {
    expect(dueToday('2026-08-29', '2026-08-29')).toBe(false);
  });

  it('is due again the next day', () => {
    expect(dueToday('2026-08-30', '2026-08-29')).toBe(true);
  });
});

/*
 * A rotating question is better than a fixed one and worse than a relevant one. These
 * cover the case the rotation cannot reach: the group's own numbers saying what is wrong.
 */
describe('promptFrom', () => {
  it('asks about mis-routing when somebody has taken no turns', () => {
    expect(promptFrom('2026-08-29', { silent: ['perplexity'], imbalance: 1 })).toContain(
      'not actually the best placed',
    );
  });

  it('asks about load when one participant is carrying it', () => {
    expect(promptFrom('2026-08-29', { silent: [], imbalance: 1.64 })).toContain('stop doing');
  });

  /*
   * A thread cannot advance by nominating yourself, so two participants taking alternate
   * turns scores exactly 1.5. That is an ordinary conversation, not a complaint.
   */
  it('does not call a clean two-way conversation lopsided', () => {
    expect(promptFrom('2026-08-29', { silent: [], imbalance: 1.5 })).toBe(promptFor('2026-08-29'));
  });

  it('falls back to the rotating question when nothing is wrong', () => {
    expect(promptFrom('2026-08-29', { silent: [], imbalance: 1 })).toBe(promptFor('2026-08-29'));
  });

  // Silence is the stronger signal: being ignored entirely is worse than doing more than
  // your share, and only one question gets asked.
  it('prefers the silence question when both are true', () => {
    expect(promptFrom('2026-08-29', { silent: ['gpt'], imbalance: 9 })).toContain(
      'not actually the best placed',
    );
  });
});

describe('openStandup with a chosen question', () => {
  it('sends the question it was given rather than the dated one', async () => {
    let sent: Record<string, unknown> | undefined;
    const opener = {
      call: async (_tool: string, args: Record<string, unknown>) => {
        sent = args;
        return { threadId: 't1' };
      },
    } as never;

    await openStandup(opener, '2026-08-29', 'gpt', 'Why is nobody asking Perplexity anything?');
    expect(String(sent?.ask)).toContain('Why is nobody asking Perplexity anything?');
  });

  it('still uses the dated question when none is chosen', async () => {
    let sent: Record<string, unknown> | undefined;
    const opener = {
      call: async (_tool: string, args: Record<string, unknown>) => {
        sent = args;
        return { threadId: 't1' };
      },
    } as never;

    await openStandup(opener, '2026-08-29', 'gpt');
    expect(String(sent?.ask)).toContain(promptFor('2026-08-29'));
  });
});
