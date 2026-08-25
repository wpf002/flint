import { describe, it, expect } from 'vitest';
import { parseReply, systemPrompt, threadPrompt, ThreadStateSchema } from '../src/prompt.js';

const wellFormed = JSON.stringify({
  content: 'Here is the schema.',
  summary: 'Drafted the schema.',
  next: 'perplexity',
  ask: 'Check the rate limits.',
  done: false,
});

describe('parseReply', () => {
  it('accepts a clean JSON reply', () => {
    const { reply, malformed } = parseReply(wellFormed);

    expect(malformed).toBe(false);
    expect(reply.next).toBe('perplexity');
    expect(reply.ask).toBe('Check the rate limits.');
    expect(reply.remember).toEqual([]);
  });

  it('unwraps a fenced reply, which models emit often enough to matter', () => {
    const { reply, malformed } = parseReply('```json\n' + wellFormed + '\n```');

    expect(malformed).toBe(false);
    expect(reply.summary).toBe('Drafted the schema.');
  });

  it('tolerates a sentence of preamble before the object', () => {
    const { reply, malformed } = parseReply(`Sure — here you go:\n${wellFormed}`);

    expect(malformed).toBe(false);
    expect(reply.content).toBe('Here is the schema.');
  });

  it('keeps unparseable output as the turn but nominates nobody', () => {
    const { reply, malformed } = parseReply('I think we should start with the schema.');

    expect(malformed).toBe(true);
    expect(reply.content).toBe('I think we should start with the schema.');
    expect(reply.next).toBeNull();
    expect(reply.done).toBe(false);
  });

  it('records something rather than nothing when the model returns empty', () => {
    const { reply, malformed } = parseReply('   ');

    expect(malformed).toBe(true);
    expect(reply.content.length).toBeGreaterThan(0);
    expect(reply.summary.length).toBeGreaterThan(0);
  });

  it('falls back when the JSON parses but is missing required fields', () => {
    const { malformed } = parseReply(JSON.stringify({ next: 'claude' }));

    expect(malformed).toBe(true);
  });

  it('caps a runaway summary rather than sending one Nexus will reject', () => {
    const { reply } = parseReply('x'.repeat(5_000));

    expect(reply.summary.length).toBeLessThanOrEqual(300);
  });
});

describe('threadPrompt', () => {
  const state = ThreadStateSchema.parse({
    threadId: 't1',
    goal: 'Design the ingest pipeline.',
    status: 'OPEN',
    turnCount: 1,
    ask: 'Pick a queue.',
    participants: [
      { slug: 'claude', label: 'Claude', good_at: 'architecture' },
      { slug: 'gpt', label: 'GPT', good_at: 'implementation' },
    ],
    turns: [{ seq: 0, by: 'claude', content: 'We need a queue.', asked: 'Pick a queue.' }],
  });

  it('shows the other participants and what they are good at', () => {
    const prompt = threadPrompt(state, 'claude');

    expect(prompt).toContain('gpt (GPT): implementation');
  });

  it('leaves the speaker out of its own roster, since it cannot nominate itself', () => {
    const prompt = threadPrompt(state, 'claude');

    expect(prompt).not.toContain('claude (Claude)');
  });

  it('carries the goal, the history and the ask directed at the speaker', () => {
    const prompt = threadPrompt(state, 'gpt');

    expect(prompt).toContain('Design the ingest pipeline.');
    expect(prompt).toContain('[0] claude: We need a queue.');
    expect(prompt).toContain('ASKED OF YOU: Pick a queue.');
  });

  it('says so plainly when nothing was asked', () => {
    const open = ThreadStateSchema.parse({ ...state, ask: null });

    expect(threadPrompt(open, 'gpt')).toContain('Nothing specific was asked of you');
  });
});

describe('systemPrompt', () => {
  it('names the participant and forbids self-nomination', () => {
    const prompt = systemPrompt('gpt', 'implementation');

    expect(prompt).toContain('"gpt"');
    expect(prompt).toContain('implementation');
    expect(prompt).toContain('Never nominate yourself');
  });
});

describe('replies that exceed what Nexus accepts', () => {
  /*
   * The fallback is built by hand rather than parsed, so nothing enforced the limits.
   * An over-long reply reached the append and was rejected there, losing the turn
   * outright — worse than recording a clipped one.
   */
  it('clips an over-long unstructured reply to what Nexus will take', () => {
    const { reply, malformed } = parseReply('x'.repeat(20_000));

    expect(malformed).toBe(true);
    expect(reply.content.length).toBeLessThanOrEqual(8_000);
    expect(reply.content).toMatch(/truncated/);
  });

  it('clips a well-formed reply whose content is too long, rather than dropping it', () => {
    const { reply } = parseReply(
      JSON.stringify({ content: 'y'.repeat(20_000), summary: 'long one', next: 'gpt' }),
    );

    expect(reply.content.length).toBeLessThanOrEqual(8_000);
  });

  it('says it was truncated, so a clipped turn never reads as a complete one', () => {
    const { reply } = parseReply('z'.repeat(9_000));

    expect(reply.content.endsWith('… [truncated]')).toBe(true);
  });
});

describe('replies whose content is structured rather than a string', () => {
  /*
   * A model asked for {"content": "..."} sometimes answers with content as a nested
   * object. The contribution is there and is good; rejecting it lost the whole turn
   * and recorded the raw text instead, which was strictly worse.
   */
  it('renders an object content instead of discarding the turn', () => {
    const { reply, malformed } = parseReply(
      JSON.stringify({ content: { plan: ['a', 'b'], why: 'because' }, summary: 'Drafted a plan.', next: 'claude' }),
    );

    expect(malformed).toBe(false);
    expect(reply.content).toContain('because');
    expect(reply.next).toBe('claude');
  });

  it('derives a summary when the model omits one', () => {
    const { reply, malformed } = parseReply(JSON.stringify({ content: 'First line.\nSecond line.', next: 'gpt' }));

    expect(malformed).toBe(false);
    expect(reply.summary).toBe('First line.');
  });

  it('drops a non-string nomination rather than sending Nexus something it will reject', () => {
    const { reply, malformed } = parseReply(
      JSON.stringify({ content: 'x', summary: 'y', next: { slug: 'gpt' } }),
    );

    expect(malformed).toBe(false);
    expect(reply.next).toBeNull();
  });

  it('still refuses a reply with no content at all', () => {
    const { malformed } = parseReply(JSON.stringify({ summary: 'nothing here' }));

    expect(malformed).toBe(true);
  });
});

describe('a conclusion offered to shared memory', () => {
  it('keeps a well-formed proposal', () => {
    const { reply } = parseReply(
      JSON.stringify({
        content: 'x',
        summary: 'y',
        done: true,
        canon: { key: 'queue.choice', content: 'Redis Streams', rationale: 'Replay.' },
      }),
    );

    expect(reply.canon?.key).toBe('queue.choice');
    expect(reply.canon?.rationale).toBe('Replay.');
  });

  /* Canon is the one place a half-understood write is worse than no write. */
  it('drops a proposal with no key rather than sending a broken one', () => {
    const { reply, malformed } = parseReply(
      JSON.stringify({ content: 'x', summary: 'y', done: true, canon: { content: 'no key here' } }),
    );

    expect(malformed).toBe(false);
    expect(reply.canon).toBeNull();
  });

  it('renders a structured conclusion rather than discarding it', () => {
    const { reply } = parseReply(
      JSON.stringify({
        content: 'x',
        summary: 'y',
        done: true,
        canon: { key: 'k', content: { decision: 'Redis Streams' } },
      }),
    );

    expect(reply.canon?.content).toContain('Redis Streams');
  });
});

describe("the artifact in a reply", () => {
  it("keeps a well-formed one", () => {
    const { reply } = parseReply(
      JSON.stringify({
        content: 'x',
        summary: 'y',
        artifact: { name: 'pricing.md', content: '# Pricing', note: 'Draft' },
      }),
    );

    expect(reply.artifact?.name).toBe('pricing.md');
    expect(reply.artifact?.note).toBe('Draft');
  });

  /* A half-understood artifact is worse than none: the next turn revises the wrong thing. */
  it("drops one with no name", () => {
    const { reply, malformed } = parseReply(
      JSON.stringify({ content: 'x', summary: 'y', artifact: { content: 'orphaned' } }),
    );

    expect(malformed).toBe(false);
    expect(reply.artifact).toBeNull();
  });

  it("renders a structured document rather than discarding it", () => {
    const { reply } = parseReply(
      JSON.stringify({ content: 'x', summary: 'y', artifact: { name: 'plan.json', content: { steps: ['a'] } } }),
    );

    expect(reply.artifact?.content).toContain('steps');
  });
});
