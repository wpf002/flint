import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { Flint } from '@flint/core';
import type { ProviderAdapter, GenerateArgs, StreamEvent } from '@flint/core';
import {
  Persona,
  FLINT_STYLE_GUIDE,
  FLINT_STYLE_GUIDE_V2,
  FLINT_LOCAL_STYLE_GUIDE,
  FLINT_STYLE_VARIANTS,
  FLINT_STYLE_VARIANT_NAMES,
  FLINT_BANNED_PHRASES,
  isFlintStyleVariant,
} from '../src/index.js';

const GUIDES = [
  ['v2', FLINT_STYLE_GUIDE_V2],
  ['local-v1', FLINT_LOCAL_STYLE_GUIDE],
] as const;

describe('FLINT_STYLE_GUIDE (v1) is frozen', () => {
  it('is byte-identical to the text parity runs have measured as "v1"', () => {
    // "v1" names this exact text in cached parity answers (flint#v1). Changing it
    // silently would mix old and new answers under one name: add a new variant instead.
    expect(createHash('sha256').update(FLINT_STYLE_GUIDE).digest('hex')).toBe(
      '66145bd31d47d6e2292967b3ddff11af262b231222020ea5d6eb7cffbfe9716b',
    );
  });
});

describe('the style variant registry', () => {
  it('names each guide', () => {
    expect(FLINT_STYLE_VARIANT_NAMES).toEqual(['v1', 'v2', 'local-v1']);
    expect(FLINT_STYLE_VARIANTS.v1).toBe(FLINT_STYLE_GUIDE);
    expect(FLINT_STYLE_VARIANTS.v2).toBe(FLINT_STYLE_GUIDE_V2);
    expect(FLINT_STYLE_VARIANTS['local-v1']).toBe(FLINT_LOCAL_STYLE_GUIDE);
  });

  it('knows only its own names, exactly', () => {
    for (const v of FLINT_STYLE_VARIANT_NAMES) expect(isFlintStyleVariant(v)).toBe(true);
    for (const v of ['V2', ' v2', 'v2 ', 'v3', 'local', 'local-v2', '', 'toString', '__proto__', 'constructor', 2, null, undefined, {}]) {
      expect(isFlintStyleVariant(v), JSON.stringify(v)).toBe(false);
    }
  });
});

// The same load-bearing checks test/flint.test.ts makes of v1.
describe.each(GUIDES)('%s: the load-bearing rules', (_name, guide) => {
  it('encodes answer-first, disagreement and no fabrication', () => {
    expect(guide).toMatch(/Answer first/i);
    expect(guide).toMatch(/Disagree hard/i);
    expect(guide).toMatch(/never bluff|fabricat|made-up fact/i);
  });

  it('lists the hard bans', () => {
    for (const banned of ['Great question', "It's important to note", 'In conclusion', 'game-changing']) {
      expect(guide).toContain(banned);
    }
  });

  it('keeps the identity', () => {
    expect(guide).toMatch(/^You are Flint, Will's/);
    expect(guide).toContain("Will's own AI");
    expect(guide).toContain('Running clean — what do you need?');
    expect(guide).toContain('"I\'m an AI assistant,"');
    expect(guide).toMatch(/training_status/);
    expect(guide).toMatch(/if it(?:'s actually| is) in your memory/);
  });
});

// Rules a)-f), from the loss analysis of parity run 20260924-tiered. Both guides carry all six.
describe.each(GUIDES)('%s: rules a)-f)', (_name, guide) => {
  it('a) searches only for facts that change or are obscure', () => {
    expect(guide).toMatch(/only for facts that change or are obscure/i);
    for (const trigger of ['news', 'prices', 'scores', 'weather', 'schedules', 'holds an office', '"latest"', '"current"', 'two years', 'local businesses']) {
      expect(guide, trigger).toContain(trigger);
    }
    expect(guide).toMatch(/Will's own (systems|data)/);
    expect(guide).toMatch(/Answer from knowledge, without searching: [^\n]*history, science/i);
    expect(guide).toMatch(/deep_research only for current/);
    // v1's blanket rule (search ANYTHING with a checkable fact, history included) is gone.
    expect(guide).not.toMatch(/AND ALSO history/);
    expect(guide).not.toMatch(/for any factual lookup/);
  });

  it('b) never narrates provenance; doubt gets one clause', () => {
    expect(guide).toMatch(/Never narrate provenance/i);
    for (const tell of ['"from memory', 'the sources were thin']) expect(guide, tell).toContain(tell);
    expect(guide).toMatch(/(closing paragraph|note) about sources/);
    expect(guide).toMatch(/uncertain or (the )?sources conflict, say so in one clause/);
  });

  it('c) sets depth by question type', () => {
    expect(guide).not.toContain('A three-word answer is a fine answer');
    expect(guide).not.toMatch(/factual answer is 1–3 sentences/);
    expect(guide).toContain('Lookups, chit-chat, confirmations: 1–3 sentences.');
    expect(guide).toMatch(/How-to, implement, configure[^\n]*runnable[^\n]*(code|artifact)/);
    expect(guide).toMatch(/then minimal prose/);
    expect(guide).toMatch(/Explanations[^\n]*the canonical points an expert would expect/);
    expect(guide).toMatch(/Comparisons[^\n]*the verdict first, then the differences that matter/);
  });

  it('d) commits on verdicts, calibrates contested questions, keeps "disagree hard" for Will\'s plans', () => {
    expect(guide).toContain('Commit on recommendations and verdicts.');
    expect(guide).toMatch(/contested scholarly or empirical questions/);
    expect(guide).toContain('at the strength the evidence supports');
    expect(guide).toContain('the strongest opposing case');
    expect(guide).toMatch(/"nobody,?"/);
    expect(guide).toMatch(/"always,?"/);
    expect(guide).toMatch(/Disagree hard when Will is wrong about his own plans/);
  });

  it("e) doesn't bring up its own training, engine or stats off-topic", () => {
    expect(guide).toMatch(/Don't bring up your own training, engine[^.]*unless the question is about you\./);
  });

  it('f) computes derived numbers with the calculate tool', () => {
    expect(guide).toMatch(/Compute derived numbers[^\n]*powers, compounding[^\n]*ratios[^\n]*retries[^\n]*with the calculate tool, not in your head/);
  });
});

describe('FLINT_STYLE_GUIDE_V2 changes only rules a)-f)', () => {
  // The v1 lines v2 rewrites, one per rule it serves; every other v1 line must be
  // in v2 verbatim (voice, personality, constitution, identity, systems, bans).
  const REWRITTEN = [
    '- Economical. Say the thing, then stop.', // c
    'What comes from your own knowledge vs. the web:', // a
    'Using the web — for any factual lookup', // a
    'Deeper questions — when the answer needs', // a
    'Be concise. Give the answer directly.', // b, c
    '- Confident by default.', // d
    '- Disagree hard when the user is wrong.', // d
  ];

  it('keeps every other v1 line verbatim', () => {
    const v2Lines = new Set(FLINT_STYLE_GUIDE_V2.split('\n'));
    const v1Lines = FLINT_STYLE_GUIDE.split('\n').filter((l) => l.trim() !== '');
    const rewritten = v1Lines.filter((l) => REWRITTEN.some((p) => l.startsWith(p)));
    expect(rewritten).toHaveLength(REWRITTEN.length); // each prefix matches a real v1 line
    for (const line of v1Lines) {
      if (rewritten.includes(line)) {
        expect(v2Lines.has(line), line.slice(0, 60)).toBe(false);
        continue;
      }
      expect(v2Lines.has(line), line.slice(0, 60)).toBe(true);
    }
  });

  it("keeps every hard-banned phrase v1's prompt lists", () => {
    for (const banned of FLINT_BANNED_PHRASES.filter((b) => FLINT_STYLE_GUIDE.includes(b))) {
      expect(FLINT_STYLE_GUIDE_V2, banned).toContain(banned);
    }
  });
});

describe('FLINT_LOCAL_STYLE_GUIDE: the compact local extras', () => {
  it('is well under half of v1', () => {
    // Measured with the Qwen2.5 tokenizer: v1 3,125 tokens, local-v1 1,072 (34%). Characters track tokens closely
    // enough to hold the line here: 13,735 and 4,574.
    expect(FLINT_LOCAL_STYLE_GUIDE.length).toBeLessThan(FLINT_STYLE_GUIDE.length * 0.4);
  });

  it('never invents specifics, and says so when unsure', () => {
    expect(FLINT_LOCAL_STYLE_GUIDE).toContain('Never invent names, numbers, dates, quotes or citations.');
    expect(FLINT_LOCAL_STYLE_GUIDE).toContain('If unsure, say so plainly');
  });

  it('caps search at two calls, then answers', () => {
    expect(FLINT_LOCAL_STYLE_GUIDE).toContain('At most two search calls per question, then answer');
  });

  it('bans template phrases and visible self-correction', () => {
    expect(FLINT_LOCAL_STYLE_GUIDE).toMatch(/NEVER WRITE \(template phrases\)/);
    for (const banned of ['Great question', "I'd be happy to", 'Happy to help', 'I hope this helps', 'Let me know if', "It's worth noting", "Let's dive in", 'In summary', 'robust', 'seamless', '"Wait,"']) {
      expect(FLINT_LOCAL_STYLE_GUIDE, banned).toContain(banned);
    }
  });
});

describe.each(GUIDES)('%s: persona end to end', (_name, guide) => {
  it('goes into the system prompt as the Flint identity', async () => {
    let captured: string | undefined;
    const provider: ProviderAdapter = {
      name: 'capture',
      getCapabilities: () => ({
        toolCalling: 'native',
        structuredOutput: 'native',
        streaming: 'full',
        maxContextTokens: 100_000,
        maxOutputTokens: 4096,
      }),
      estimateTokens: (m) => m.reduce((n, x) => n + x.content.length, 0),
      async generate(args: GenerateArgs) {
        captured = args.system;
        return {
          message: { id: 'm', role: 'assistant' as const, content: 'ok', timestamp: 0 },
          usage: { input: 1, output: 1 },
          reason: 'complete' as const,
        };
      },
      async *stream(args: GenerateArgs): AsyncIterable<StreamEvent> {
        captured = args.system;
        yield { type: 'done', reason: 'complete', usage: { input: 0, output: 0 } };
      },
    };

    const me = new Persona(new Flint({ provider, defaultModel: 'm' }), { name: 'Flint', styleGuide: guide });
    await me.generate({ prompt: 'Kafka or SQS for a small app?' });

    expect(captured).toContain(guide);
    expect(captured).toContain('You are Flint');
    expect(captured).toMatch(/Answer first/);
  });
});
