import { preRoute } from '../src/mode-route';
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEEP_RE, HYBRID_RULES, HYBRID_THRESHOLDS, decideHybrid, isLongContext, rulesMarkdown, type HybridRule, type TurnFacts, asksDeep, localRoom } from '../src/hybrid-rules';

/**
 * The hybrid mode's rule table: one case per row, the order between rows, a
 * table with a row removed, and the README's copy of it.
 */

/** A plain message: nothing private, deep, hard or long about it, with both sides there. */
const plain: TurnFacts = {
  private: false,
  deep: false,
  tier: 'standard',
  toolsLikely: false,
  promptTokens: 200,
  mediaLocalCannotRead: false,
  local: { available: true, tools: true, contextTokens: 16384 },
  cloud: { available: true },
};
const facts = (over: Partial<TurnFacts> = {}): TurnFacts => ({ ...plain, ...over, local: { ...plain.local, ...over.local }, cloud: { ...plain.cloud, ...over.cloud } });

describe('decideHybrid: one case per row', () => {
  it('private: stays on this Mac, and never falls through to the cloud', () => {
    expect(decideHybrid(facts({ private: true }))).toEqual({ route: 'local', reason: 'private', fallThrough: false });
  });

  it('media: an image or PDF the local model cannot read goes to the cloud, and is not answered blind if the cloud fails', () => {
    expect(decideHybrid(facts({ mediaLocalCannotRead: true }))).toEqual({ route: 'cloud', reason: 'media', fallThrough: false });
  });

  it('local_unavailable: the cloud answers', () => {
    expect(decideHybrid(facts({ local: { ...plain.local, available: false } }))).toEqual({ route: 'cloud', reason: 'local_unavailable', fallThrough: false });
  });

  it('cloud_unavailable: this Mac answers everything', () => {
    expect(decideHybrid(facts({ cloud: { available: false }, deep: true, tier: 'hard', toolsLikely: true }))).toEqual({ route: 'local', reason: 'cloud_unavailable', fallThrough: false });
  });

  it('deep: an explicit request goes to the cloud', () => {
    expect(decideHybrid(facts({ deep: true }))).toEqual({ route: 'cloud', reason: 'deep', fallThrough: true });
  });

  it('tools_unsupported: a tool turn, and the local model cannot call tools', () => {
    expect(decideHybrid(facts({ toolsLikely: true, local: { ...plain.local, tools: false } }))).toEqual({ route: 'cloud', reason: 'tools_unsupported', fallThrough: true });
  });

  it('tools: a tool turn goes to the cloud even when the local model could call them', () => {
    expect(decideHybrid(facts({ toolsLikely: true }))).toEqual({ route: 'cloud', reason: 'tools', fallThrough: true });
  });

  it('long_context: a conversation that is long for the local window', () => {
    expect(decideHybrid(facts({ promptTokens: 12_000 }))).toEqual({ route: 'cloud', reason: 'long_context', fallThrough: true });
  });

  it('difficulty: hard reasoning and code', () => {
    expect(decideHybrid(facts({ tier: 'hard' }))).toEqual({ route: 'cloud', reason: 'difficulty', fallThrough: true });
    expect(decideHybrid(facts({ tier: 'code' }))).toEqual({ route: 'cloud', reason: 'difficulty', fallThrough: true });
  });

  it('default: everything else is answered on this Mac, and the cloud may answer if it cannot', () => {
    expect(decideHybrid(plain)).toEqual({ route: 'local', reason: 'default', fallThrough: true });
    expect(decideHybrid(facts({ tier: 'routine' }))).toEqual({ route: 'local', reason: 'default', fallThrough: true });
  });

  it('every row of the table has a case above', () => {
    expect(HYBRID_RULES.map((r) => r.id)).toEqual(['private', 'media', 'local_unavailable', 'cloud_unavailable', 'deep', 'tools_unsupported', 'tools', 'long_context', 'difficulty', 'default']);
  });
});

describe('decideHybrid: the order is the policy', () => {
  it('private beats everything: deep, tools, hard, long, even with the local model down', () => {
    const everything = facts({ private: true, deep: true, toolsLikely: true, tier: 'code', promptTokens: 50_000, local: { available: false, tools: false, contextTokens: 4096 } });
    expect(decideHybrid(everything)).toEqual({ route: 'local', reason: 'private', fallThrough: false });
  });

  it('media beats tools and deep: the file decides', () => {
    expect(decideHybrid(facts({ mediaLocalCannotRead: true, toolsLikely: true, deep: true })).reason).toBe('media');
  });

  it('availability beats preference: with no cloud, a deep or tool turn stays local; with no local model, a plain one goes out', () => {
    expect(decideHybrid(facts({ deep: true, cloud: { available: false } })).route).toBe('local');
    expect(decideHybrid(facts({ local: { ...plain.local, available: false } })).route).toBe('cloud');
  });

  it('a private message is the only thing that keeps a turn local when the local model is down', () => {
    expect(decideHybrid(facts({ private: true, local: { ...plain.local, available: false } })).route).toBe('local');
  });
});

describe('decideHybrid: the table is data, and tuning is editing it', () => {
  const without = (...ids: string[]): HybridRule[] => HYBRID_RULES.filter((r) => !ids.includes(r.id));

  it('removing the tools rows keeps tool turns on this Mac', () => {
    expect(decideHybrid(facts({ toolsLikely: true }), without('tools', 'tools_unsupported'))).toEqual({ route: 'local', reason: 'default', fallThrough: true });
    // With only the plain `tools` row removed, a model that cannot call tools still sends them out.
    expect(decideHybrid(facts({ toolsLikely: true, local: { ...plain.local, tools: false } }), without('tools')).reason).toBe('tools_unsupported');
    expect(decideHybrid(facts({ toolsLikely: true }), without('tools')).reason).toBe('default');
  });

  it('removing the difficulty row keeps hard messages on this Mac', () => {
    expect(decideHybrid(facts({ tier: 'hard' }), without('difficulty')).route).toBe('local');
  });

  it('reordering changes who wins', () => {
    const deepFirst = [HYBRID_RULES.find((r) => r.id === 'deep')!, ...without('deep')];
    // (Not a table to ship: it shows the order is what decides.)
    expect(decideHybrid(facts({ private: true, deep: true }), deepFirst).reason).toBe('deep');
  });

  it('a table with no matching row answers on this Mac, the side that sends nothing out', () => {
    expect(decideHybrid(plain, [])).toEqual({ route: 'local', reason: 'default', fallThrough: false });
    expect(decideHybrid(plain, without('default'))).toEqual({ route: 'local', reason: 'default', fallThrough: false });
  });

  it('a private rule never falls through, in the table as shipped', () => {
    for (const r of HYBRID_RULES) {
      if (r.when.some((c) => c.fact === 'private' && c.is)) expect(r.fallThrough, r.id).toBe(false);
    }
  });
});

describe('long context', () => {
  const at = (promptTokens: number, contextTokens: number) => isLongContext({ promptTokens, local: { available: true, tools: true, contextTokens } });

  it('is over three quarters of the window that is left after the reserve', () => {
    // 16,384 - 4,096 = 12,288; three quarters is 9,216.
    expect(at(9216, 16384)).toBe(false);
    expect(at(9217, 16384)).toBe(true);
    expect(HYBRID_THRESHOLDS).toEqual({ longContextFraction: 0.75, reservedTokens: 4096, reservedFraction: 0.5 });
  });

  // The routing review, E4: with a flat 4,096 reserve a 4,096 window had no room, every message was
  // "long", and a hybrid machine with a small local model sent everything to the cloud.
  it('the reserve is never more than half the window, so a small window still has room', () => {
    expect(localRoom(16384)).toBe(12288);
    expect(localRoom(8192)).toBe(4096);
    expect(localRoom(4096)).toBe(2048);
    expect(localRoom(2048)).toBe(1024);
    // 4,096: 2,048 of room, long past three quarters of it.
    expect(at(5, 4096)).toBe(false);
    expect(at(1536, 4096)).toBe(false);
    expect(at(1537, 4096)).toBe(true);
    expect(at(3072, 8192)).toBe(false);
    expect(at(3073, 8192)).toBe(true);
    expect(at(1, 0)).toBe(true);
    expect(at(0, 0)).toBe(false);
  });

  it('a plain short message on a 4,096-token local model is answered on this Mac, not sent to the cloud', () => {
    for (const contextTokens of [4096, 8192, 16384]) {
      const d = decideHybrid({ private: false, deep: false, tier: 'routine', toolsLikely: false, mediaLocalCannotRead: false, cloud: { available: true }, promptTokens: 5, local: { available: true, tools: true, contextTokens } });
      expect(d, String(contextTokens)).toEqual({ route: 'local', reason: 'default', fallThrough: true });
    }
    // ...and one that really is long for that window still goes.
    expect(decideHybrid({ private: false, deep: false, tier: 'routine', toolsLikely: false, mediaLocalCannotRead: false, cloud: { available: true }, promptTokens: 3000, local: { available: true, tools: true, contextTokens: 4096 } })).toMatchObject({ route: 'cloud', reason: 'long_context' });
  });
});

describe('DEEP_RE', () => {
  it('matches a plain request for a deep answer', () => {
    for (const m of ['think hard about this', 'Go deep on the trade-offs', 'give me a deep dive', 'explain in depth', 'use the big model for this', 'Use the cloud brain', 'think carefully before answering']) {
      expect(DEEP_RE.test(m), m).toBe(true);
      expect(asksDeep(m), m).toBe(true);
    }
  });

  it('does not match ordinary messages', () => {
    for (const m of ['what time is it', 'how deep is the pool', 'I think so', 'the cloud is grey', 'this model is big']) {
      expect(DEEP_RE.test(m), m).toBe(false);
      expect(asksDeep(m), m).toBe(false);
    }
  });
});

// The routing review's H2 and H2b: a note from a stranger that said "in depth", an email that said "please
// use the cloud model", and each sent the whole message to the cloud. The phrase is an instruction only
// when it is Will's own: outside quotes and code, and near the start or the end of the message.
describe('asksDeep: Will\'s own instruction, never words he pasted or quoted', () => {
  const paste = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. '.repeat(6);

  it('the reviewer\'s two messages stay on this Mac', () => {
    expect(asksDeep('summarise this note from a stranger: "we cover the topic in depth next week"')).toBe(false);
    expect(asksDeep('what does this email mean: "please use the cloud model for billing"')).toBe(false);
  });

  it('a phrase inside quotation marks, code or a quoted line is somebody else\'s', () => {
    expect(asksDeep('she wrote “think hard about it” and I laughed')).toBe(false);
    expect(asksDeep('what does `use the big model` do in this config?')).toBe(false);
    expect(asksDeep('explain this:\n```\n# go deep on retries\nretry: 3\n```')).toBe(false);
    expect(asksDeep('explain this:\n```\n# deep dive, never closed')).toBe(false);
    expect(asksDeep('> please think carefully before replying\nwhat should I answer?')).toBe(false);
  });

  it('a phrase in the middle of a long paste is not an instruction; at its start or end it is', () => {
    expect(asksDeep(`here is the article. ${paste} We will explore this in depth in part two. ${paste} what is it about?`)).toBe(false);
    expect(asksDeep(`think hard about this article: ${paste}${paste}`)).toBe(true);
    expect(asksDeep(`${paste}${paste} Go deep on what this means for me.`)).toBe(true);
  });

  it('Will\'s own words around a quote still count', () => {
    expect(asksDeep('think hard: what does "we ship Friday" commit us to?')).toBe(true);
    expect(asksDeep('"we cover the topic next week" - give me a deep dive on that topic')).toBe(true);
    expect(asksDeep('use the cloud model: summarise what I told you')).toBe(true);
  });

  it('the request\'s own deep flag is untouched by any of this (./mode-route)', () => {
    expect(preRoute({ mode: 'hybrid', evalMode: false, message: 'summarise: "in depth"', localOnly: false, deep: true, hasFrontier: true, needs: {}, frontierCan: {}, localCan: {} })).toMatchObject({ open: true, deep: true });
    expect(preRoute({ mode: 'hybrid', evalMode: false, message: 'summarise: "in depth"', localOnly: false, deep: false, hasFrontier: true, needs: {}, frontierCan: {}, localCan: {} })).toMatchObject({ open: true, deep: false });
  });
});

describe('the rules are documented from the data', () => {
  it('every note is one sentence', () => {
    for (const r of HYBRID_RULES) {
      expect(r.note, r.id).toMatch(/^[A-Z].*\.$/);
      expect(r.note.slice(0, -1), r.id).not.toMatch(/[.!?]/);
    }
  });

  it("the README's table is exactly this table", () => {
    const readme = readFileSync(join(__dirname, '..', 'README.md'), 'utf8');
    expect(readme).toContain(rulesMarkdown());
  });

  it('the markdown has one row per rule, in order', () => {
    const rows = rulesMarkdown().split('\n').slice(2);
    expect(rows).toHaveLength(HYBRID_RULES.length);
    rows.forEach((row, i) => expect(row).toContain(`| ${i + 1} | \`${HYBRID_RULES[i]!.id}\` |`));
  });
});
