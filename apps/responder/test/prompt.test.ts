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
