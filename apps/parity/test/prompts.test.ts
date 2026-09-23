import { describe, it, expect } from 'vitest';
import { buildPromptSet, dedupe, isTrivial, takeBalanced, type TrainingRecord } from '../src/prompts.js';

let nextId = 0;
function rec(input: string, conversationId = 'console', tools: string[] = []): TrainingRecord {
  nextId++;
  return {
    ts: 1_700_000_000_000 + nextId * 1000,
    id: nextId,
    conversationId,
    brain: 'frontier',
    model: 'claude-sonnet-4-6',
    input,
    output: 'x',
    tools: tools.map((tool) => ({ tool })),
  };
}

describe('isTrivial', () => {
  it('drops greetings, acknowledgements, follow-ups and probes', () => {
    for (const s of [
      'hi',
      'Hey Flint, how are you doing today?',
      'Thanks man, you are the best',
      'Yes',
      'go ahead',
      'No! It hasn’t taken place yet. It’s happening right now!',
      'say ok',
      'Reply with exactly: UI-OK',
      "What is today's date? Answer with the date only.",
      'https://www.ufc.com/event/ufc-329',
    ]) {
      expect(isTrivial(s), s).toBe(true);
    }
  });

  it('keeps real asks, including ones that open with a greeting', () => {
    for (const s of [
      'Who do you think will win UFC 329?',
      'How do solar panels convert light into electricity?',
      'Hey Flint, can you pull my Vantage watchlist and tell me which names dropped the most this week and why?',
      'What is the only planet that rotates on its side?',
    ]) {
      expect(isTrivial(s), s).toBe(false);
    }
  });
});

describe('dedupe', () => {
  it('drops exact and near duplicates, keeping the first', () => {
    const rows = [
      { input: 'Who do you think will win UFC 329?' },
      { input: 'who do you think will win ufc 329' },
      { input: 'Who do you think will win UFC 329 tonight?' },
      { input: 'Who is fighting in the UFC 329 main event?' },
    ];
    expect(dedupe(rows).map((r) => r.input)).toEqual([
      'Who do you think will win UFC 329?',
      'Who is fighting in the UFC 329 main event?',
    ]);
  });

  it('treats a short ask contained in a longer one as a duplicate, but not a template sibling', () => {
    const rows = [
      { input: 'Who is fighting in the UFC 329 main event? Search the web.' },
      { input: 'who is fighting at UFC 329?' },
      { input: 'Explain the history of stirrups and why it matters' },
      { input: 'Explain the history of cavitation and why it matters' },
    ];
    expect(dedupe(rows).map((r) => r.input)).toEqual([
      'Who is fighting in the UFC 329 main event? Search the web.',
      'Explain the history of stirrups and why it matters',
      'Explain the history of cavitation and why it matters',
    ]);
  });
});

function corpus(): TrainingRecord[] {
  nextId = 0;
  const rows: TrainingRecord[] = [
    rec('hi'),
    rec('Who do you think will win UFC 329?'),
    rec('Who do you think will win UFC 329?', 'diag2', ['web.web_search']),
    rec("What's the Vantage score for NVDA?", 'console', ['vantage.get_score']),
    rec('Any unread emails from Tanner?'),
    rec('Why does this TypeScript narrowing fail on a union?'),
    rec('Draft a short note to my landlord about the leak'),
    rec('Are you Claude?'),
  ];
  const topics = ['stirrups', 'cavitation', 'solar panels', 'CDNs', 'Nietzsche', 'fatigue cracks', 'the yield curve', 'DOMS'];
  topics.forEach((topic, i) => rows.push(rec(`How does ${topic} actually work in practice?`, `bulk-${i}`)));
  topics.forEach((topic, i) => rows.push(rec(`Explain the history of ${topic} and why it matters`, `grow-${i}`)));
  return rows;
}

describe('buildPromptSet', () => {
  it('is deterministic for a seed, and stable ids survive a reordered corpus', () => {
    const a = buildPromptSet(corpus(), { seed: 7, max: 10 });
    const b = buildPromptSet(corpus(), { seed: 7, max: 10 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const reordered = buildPromptSet(corpus().reverse(), { seed: 7, max: 100 });
    const full = buildPromptSet(corpus(), { seed: 7, max: 100 });
    expect(reordered.prompts.map((p) => p.id).sort()).toEqual(full.prompts.map((p) => p.id).sort());
  });

  it('a different seed picks a different sample from an over-full category', () => {
    const picks = new Set<string>();
    for (const seed of [1, 2, 3, 4, 5]) {
      const ids = buildPromptSet(corpus(), { seed, max: 8 })
        .prompts.filter((p) => p.category === 'knowledge')
        .map((p) => p.id)
        .join(',');
      picks.add(ids);
    }
    expect(picks.size).toBeGreaterThan(1);
  });

  it('drops trivial and duplicate rows and reports how many', () => {
    const { prompts, stats } = buildPromptSet(corpus(), { seed: 1, max: 300 });
    expect(stats.trivial).toBe(1);
    expect(stats.duplicates).toBe(1);
    expect(prompts.filter((p) => p.prompt.startsWith('Who do you think will win UFC 329')).length).toBe(1);
    expect(new Set(prompts.map((p) => p.id)).size).toBe(prompts.length);
  });

  it('stratifies: small categories are kept whole, the big synthetic one is capped', () => {
    const { prompts, stats } = buildPromptSet(corpus(), { seed: 1, max: 9 });
    expect(prompts.length).toBe(9);
    const count = (c: string) => prompts.filter((p) => p.category === c).length;
    for (const c of ['research', 'finance-systems', 'email-calendar-drive', 'coding', 'planning-writing', 'chit-chat']) {
      expect(count(c), c).toBe(1);
    }
    expect(count('knowledge')).toBe(3);
    expect(stats.byCategory.knowledge?.available).toBe(16);
  });

  it('prefers organic prompts over synthetic ones within a category', () => {
    nextId = 0;
    const rows = [
      rec('How does a content delivery network reduce latency?', 'bulk-1'),
      rec('How does a heat pump move heat uphill in winter?', 'bulk-2'),
      rec('Why do sourdough loaves come out dense and flat?', 'console'),
    ];
    const { prompts } = buildPromptSet(rows, { seed: 3, max: 1 });
    expect(prompts[0]?.source).toBe('organic');
  });
});

describe('takeBalanced', () => {
  it('round-robins categories so --limit 3 spans three categories', () => {
    const { prompts } = buildPromptSet(corpus(), { seed: 1, max: 300 });
    const picked = takeBalanced(prompts, 3);
    expect(new Set(picked.map((p) => p.category)).size).toBe(3);
    expect(takeBalanced(prompts, 1000).length).toBe(prompts.length);
  });
});
