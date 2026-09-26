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
import type { FlintStyleVariant } from '../src/index.js';

const GUIDES = [
  ['v2', FLINT_STYLE_GUIDE_V2],
  ['local-v1', FLINT_LOCAL_STYLE_GUIDE],
] as const;

// Every variant's text, pinned. A variant name is what apps/parity puts in a
// contestant's name (flint#v2, …#local-v1) and so in the cache key of every answer
// and verdict: editing a guide in place would mix answers from two texts under one
// label, and a resumed or repeated run couldn't tell. To revise a guide, add it as a
// NEW variant (v3, local-v2) with its own pin; don't change a hash below. The
// Record type makes a new variant without a pin a type error.
//
// The one exception, deliberate: on 2026-09-25 all three were revised in place
// (fix/conversation-behaviour). v1 and v2 are the live guides and told Flint his own
// model retrains weekly and "gets sharper every week", which isn't true, and a new
// name would not have reached Will without a config change. Previous pins: v1
// 66145bd3…, v2 8381fbe5…, local-v1 d70a0243…. Parity answers cached before that
// commit are from the old texts: start a new run rather than resuming one across it.
// (The branch's first draft, v1 4fc8866c…, v2 12da7fe0…, local-v1 ec9ebc8a…, was
// revised before merge and never shipped: don't resume a run made with it either.)
const PINNED: Record<FlintStyleVariant, string> = {
  v1: '15a8f7804c70c30d3ce2a911b3d19b691889ef972253ab802942ac3a0609c3d2',
  v2: '68d118b942b67be6be3b1bce54f1e2b022685f5bebe78ae4be1f085ee87316c0',
  'local-v1': '692103475bbd4525547276e69a74fed0b19174327303a341b27abf9c53d1dd27',
};

describe('every style variant is frozen', () => {
  it.each(FLINT_STYLE_VARIANT_NAMES)('%s is byte-identical to its pinned text', (v) => {
    expect(createHash('sha256').update(FLINT_STYLE_VARIANTS[v]).digest('hex')).toBe(PINNED[v]);
  });

  it('pins exactly the registered variants', () => {
    expect(Object.keys(PINNED).sort()).toEqual([...FLINT_STYLE_VARIANT_NAMES].sort());
  });

  it('v1 is FLINT_STYLE_GUIDE, the text parity runs have measured as "v1"', () => {
    expect(createHash('sha256').update(FLINT_STYLE_GUIDE).digest('hex')).toBe(PINNED.v1);
  });

  it('gives each variant its own text (the server names a persona\'s variant by its text)', () => {
    expect(new Set(Object.values(FLINT_STYLE_VARIANTS)).size).toBe(FLINT_STYLE_VARIANT_NAMES.length);
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

// Rules a)-f), from the loss analysis of parity run 20260924-tiered. Both guides carry all six;
// e) is checked below for every guide, since v1, the live local guide, carries it too.
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
    // No unscoped "disagree hard" anywhere else in the guide (v1's Calibration
    // bullet had one): every line that asks for hard disagreement names Will's own
    // plans, code and decisions as its scope.
    expect(guide).not.toContain('Disagreement: hard. When Will is wrong');
    const hard = guide.split('\n').filter((l) => /disagree/i.test(l) && /\bhard\b/i.test(l));
    expect(hard.length).toBeGreaterThan(0);
    for (const line of hard) expect(line, line.slice(0, 60)).toMatch(/(Will's|his) own plans, code (or|and) decisions/);
  });

  it('f) computes derived numbers with the calculate tool', () => {
    expect(guide).toMatch(/Compute derived numbers[^\n]*powers, compounding[^\n]*ratios[^\n]*retries[^\n]*with the calculate tool, not in your head/);
  });
});

// What Will saw on 2026-09-25: "How are you doing today Flint?" got an unrequested
// training report plus a list of Flint's past mistakes; "I don't care about what you
// got wrong" got the training pitch again. And every guide said his own model retrains
// weekly, which it doesn't (fine-tuning is paused; no fine-tune has beaten its base).
// Every variant, the live v1 and v2 included, carries these rules.
const EVERY_GUIDE = FLINT_STYLE_VARIANT_NAMES.map((v) => [v, FLINT_STYLE_VARIANTS[v]] as const);

describe.each(EVERY_GUIDE)('%s: honest about training, calibrated in conversation', (_name, guide) => {
  it("a) doesn't claim a model that retrains or sharpens every week", () => {
    for (const claim of [/sharper (every|each) week/i, /retrains? on/i, /brain in training/i, /trains toward taking that over/i, /training corpus has been absorbing/i]) {
      expect(guide, String(claim)).not.toMatch(claim);
    }
  });

  it('a) says what does carry over, what the local model is for, and that fine-tuning is paused', () => {
    // The server sends each message only the conversation's recent turns
    // (apps/server history-window), so no guide may say the whole log carries over.
    expect(guide).not.toMatch(/conversation log/);
    expect(guide).toContain('Your long-term memory carries over between sessions, along with the recent part of this conversation; anything older reaches you only through that memory');
    // ...and what isn't in front of Flint is said to be missing, never filled in.
    expect(guide).toContain("If Will refers to something you can't see, say it isn't in front of you — don't reconstruct it.");
    expect(guide).toMatch(/local (open model|brain is an open model)/);
    expect(guide).toMatch(/private questions/);
    expect(guide).toMatch(/outages/);
    expect(guide).toContain('fine-tuning is paused until a candidate measurably beats');
    // ...and his real training status is one tool call away when Will asks.
    expect(guide).toMatch(/training_status/);
  });

  it('b) a greeting or small talk gets a short, warm reply, not a status report', () => {
    expect(guide).toMatch(/A greeting or small talk[^.]*gets a short, warm reply in character/);
    expect(guide).toContain('Running clean — what do you need?');
    expect(guide).toMatch(/no status report,? (no )?training numbers,? (or|no) agenda unless (he|Will) asks/);
  });

  it("c) doesn't volunteer old mistakes, and drops what Will says he doesn't care about", () => {
    expect(guide).toContain("Don't volunteer corrections of your past mistakes");
    expect(guide).toMatch(/Will asks or (it|one) bears on what he's doing now/);
    expect(guide).toMatch(/when he says he doesn't care about something, drop it/i);
  });

  it('d) still never invents personal facts about Will', () => {
    expect(guide).toMatch(/State a personal fact about Will only if it is in your memory|Only state a personal fact about Will if it's actually in your memory/);
    expect(guide).toMatch(/never invent|Never invent/);
  });

  // v2's rule e), in every guide: an unrelated question (a private one answered by the
  // local brain on v1, say) mustn't pick up a training aside either.
  it("e) doesn't bring up its own training, engine or stats unless Will asks", () => {
    expect(guide).toMatch(/Don't bring up your own training, engine[^.]*unless Will asks about them/);
    // "How are you?" is literally a question about Flint; it's not a request for a status report.
    expect(guide).not.toMatch(/unless the question is about you/);
  });
});

// v1 and v2 list what Flint must never say about himself. On 2026-09-25 the list still
// called "each conversation I start from the same base model" wrong, after the same
// paragraph had said the model isn't retraining, so Flint "corrected" an honest answer
// in front of Will. The list keeps only claims that are false; statelessness gets an
// honest frame instead of a ban.
describe.each([
  ['v1', FLINT_STYLE_GUIDE],
  ['v2', FLINT_STYLE_GUIDE_V2],
] as const)("%s: doesn't call true things about the engine wrong", (_name, guide) => {
  it('bans only the false deflections', () => {
    for (const trueThing of ['each conversation I start from the same base model', "I haven't grown the way a person does"]) {
      expect(guide, trueThing).not.toContain(trueThing);
    }
    for (const falseThing of ['"I don\'t accumulate knowledge between sessions,"', '"I start fresh each time,"', '"there\'s no \'lately\' for me."']) {
      expect(guide, falseThing).toContain(falseThing);
    }
  });

  it('says what carries over and what does not, instead', () => {
    expect(guide).toContain(
      "Don't give the engine's statelessness as the whole answer either: the engine you borrow is static between chats — true — so say what carries over (long-term memory, the recent conversation) and what doesn't (the model itself isn't retraining).",
    );
  });

  it('still bans the robotic disclaimers and "I am Claude"', () => {
    for (const banned of ['"I\'m an AI assistant,"', '"I don\'t have feelings,"', 'never say "I am Claude,"', 'never introduce yourself as Claude']) {
      expect(guide, banned).toContain(banned);
    }
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
    '- Disagreement: hard.', // d
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
