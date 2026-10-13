/**
 * Goals and commitments from chat, in the memory extractor (P3 part 5; exit
 * criterion 7: nothing from chat without Will's own quoted words).
 *
 *  - Off (how it ships): the prompt and the local model's request are byte for
 *    byte what they were before this part (pinned by their sha256), no
 *    suggestion is read, nothing is handed on.
 *  - On, with the local model: the prompt gains its lines and the reply its
 *    schema. On the frontier, never: its prompt does not change, and a
 *    suggestion in its reply is not read.
 *  - The quote check comes first and is deterministic. Dropped: the claim is
 *    only in the assistant's words; the quote is only in the earlier turn shown
 *    for context, or in another turn of the batch; a paraphrase; under 12
 *    characters; no turn, or a turn the batch does not have. A tainted turn is
 *    never sent to the model at all. Kept: a quote past the 1,500 characters
 *    the model is shown but inside Will's whole message; one that differs only
 *    in curly quotes, doubled spaces or the marks a model wraps it in.
 *  - The short text is held to his message too (its words, its numbers), and a
 *    date to being a real day not before the turn.
 *  - Drops are counted by reason, and no log line carries a word of them.
 *  - The knowledge facts are stored exactly as with it off.
 * Synthetic text only.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Turn } from '@flint/core';
import { KnowledgeStore } from '../src/knowledge';
import { localExtractBrain } from '../src/memory-brain';
import {
  EXTRACT_SYSTEM, EXTRACT_VERSION, FACTS_SCHEMA, MemoryExtractor, SUGGESTIONS_SCHEMA, SUGGEST_PROMPT, suggestionOf, suggestionsReply,
  type BrainReply, type ChatSuggestion, type ExtractBrain, type ExtractorOptions, type SuggestionOutcome, type TurnSource,
} from '../src/memory-extract';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const CANARY = 'CANARY-p3suggest';
/** What the extractor sent before this part, for the fixture below (recorded on main at d7c608d). */
const GOLDEN_PROMPT = 'eeb45c65d5b74757330b53000767be90ec0955070a050811f778469b3281a446';
const GOLDEN_REQUEST = '96322e7777e36d6b8a26b1b99063f4bdc8d3adb1c3bec95d061e7bb37c387bdf';
const DAY = 86_400_000;

const downEmbedder = { embed: async () => { throw new Error('ollama down'); } } as unknown as ConstructorParameters<typeof KnowledgeStore>[1];

const NOW = Date.UTC(2026, 9, 12, 18, 0, 0);
let tick = NOW - 6 * 60 * 60_000;
function turn(cid: string, user: string, assistant = 'ok', id?: string): Turn {
  tick += 60_000;
  return {
    id: id ?? `t${tick}`, conversationId: cid, status: 'complete', createdAt: tick, updatedAt: tick,
    messages: [{ id: `u${tick}`, role: 'user', content: user, timestamp: tick }, { id: `a${tick}`, role: 'assistant', content: assistant, timestamp: tick }],
  };
}
const source = (convs: Record<string, Turn[]>): TurnSource => ({ conversationIds: () => Object.keys(convs), getTurns: async (cid) => structuredClone(convs[cid] ?? []) });

/** A local brain as the extractor sees one: structured replies (facts and, when asked, suggestions), every call kept. */
function local(reply: (prompt: string) => { facts?: unknown[]; suggestions?: unknown[] }) {
  const calls: Array<{ system: string; prompt: string; suggestions?: boolean }> = [];
  const brain: ExtractBrain = {
    generate: async (i) => {
      calls.push(i);
      const r = reply(i.prompt);
      return { facts: (r.facts ?? []) as never, ...(r.suggestions ? { suggestions: r.suggestions } : {}) } as BrainReply;
    },
  };
  return { brain, calls };
}

describe('goals and commitments from chat, in the extractor', () => {
  let dir: string;
  let said: string[];
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'flint-suggest-'));
    said = [];
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void said.push(a.map(String).join(' ')));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
    // No log line ever carries a suggestion's words, kept or dropped.
    expect(said.join('\n')).not.toContain(CANARY);
  });

  /** Run one pass over these conversations with a local brain that proposes `suggestions`; what was handed on, and the stats. */
  async function pass(convs: Record<string, Turn[]>, suggestions: unknown[], opts: ExtractorOptions = {}, facts: unknown[] = []) {
    const got: ChatSuggestion[] = [];
    const { brain, calls } = local(() => ({ facts, suggestions }));
    const k = new KnowledgeStore(join(dir, `k${Math.random()}.json`), downEmbedder);
    const ex = new MemoryExtractor(source(convs), k, brain, join(dir, `s${Math.random()}.json`), {
      now: () => NOW, candidates: true, onCandidate: async (s) => (got.push(s), 'filed' as SuggestionOutcome), ...opts,
    });
    await ex.run();
    return { got, calls, stats: ex.lastStats, k, ex };
  }
  const SAID = `${CANARY} I want to run a half marathon by spring, and I'll sign up for the Dallas race this week`;
  const QUOTE = `${CANARY} I want to run a half marathon by spring`;
  const good = (over: Record<string, unknown> = {}) => ({ turn: 1, kind: 'goal', quote: QUOTE, text: 'run a half marathon', dueOn: '', ...over });

  it('off: the prompt and the local model’s request are byte for byte what they were, and nothing is read or handed on', async () => {
    const at = 1_780_000_060_000;
    const t: Turn = { id: 't1', conversationId: 'console', status: 'complete', createdAt: at, updatedAt: at, messages: [
      { id: 'u1', role: 'user', content: 'My friend Tanner is visiting from Houston next month and he loves brisket', timestamp: at },
      { id: 'a1', role: 'assistant', content: 'ok', timestamp: at },
    ] };
    const run = async (opts: ExtractorOptions) => {
      let prompt = '';
      let body = '';
      // The local model's reply carries a suggestion it was never asked for.
      const fetchStub = (async (_u: unknown, init?: RequestInit) => {
        body = String(init?.body);
        const content = JSON.stringify({ facts: [], suggestions: [{ turn: 1, kind: 'goal', quote: 'My friend Tanner is visiting from Houston', text: 'host Tanner', dueOn: '' }] });
        return new Response(JSON.stringify({ model: 'm', message: { role: 'assistant', content }, done: true, done_reason: 'stop', prompt_eval_count: 1, eval_count: 1 }), { status: 200, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch;
      const real = localExtractBrain({ baseURL: 'http://127.0.0.1:11434', model: 'llama3.1:8b', numCtx: 8192, unloadAfter: false }, { fetch: fetchStub });
      const asked: Array<boolean | undefined> = [];
      const brain: ExtractBrain = { promptChars: real.promptChars!, generate: async (i) => { prompt = i.prompt; asked.push(i.suggestions); return real.generate(i); } };
      const got: ChatSuggestion[] = [];
      const ex = new MemoryExtractor({ conversationIds: () => ['console'], getTurns: async () => [structuredClone(t)] }, new KnowledgeStore(join(dir, `k${Math.random()}.json`), downEmbedder), brain, join(dir, `s${Math.random()}.json`), {
        now: () => at + 1000, onCandidate: async (s) => (got.push(s), 'filed' as SuggestionOutcome), ...opts,
      });
      await ex.run();
      return { prompt, body, got, asked, ex };
    };
    // Not set, set false, and set without anywhere to hand them: all off.
    for (const opts of [{}, { candidates: false }] as ExtractorOptions[]) {
      const off = await run(opts);
      expect(sha(off.prompt)).toBe(GOLDEN_PROMPT);
      expect(sha(off.body)).toBe(GOLDEN_REQUEST);
      expect(off.asked).toEqual([undefined]);
      expect(off.got).toEqual([]);
      expect(off.ex.suggests).toBe(false);
      expect(off.ex.lastStats).toMatchObject({ suggested: 0, suggestionsKept: 0, suggestionsFiled: 0 });
      expect(JSON.parse(off.body).format).toEqual(FACTS_SCHEMA);
    }
    const nowhere = new MemoryExtractor({ conversationIds: () => [], getTurns: async () => [] }, new KnowledgeStore(join(dir, 'k0.json'), downEmbedder), local(() => ({})).brain, join(dir, 's0.json'), { candidates: true });
    expect(nowhere.suggests).toBe(false);
    // On: the same prompt with its lines added (and nothing else changed), the schema with suggestions, the suggestion handed on.
    const on = await run({ candidates: true });
    expect(on.prompt).toContain(SUGGEST_PROMPT);
    expect(sha(on.prompt.replace(SUGGEST_PROMPT, ''))).toBe(GOLDEN_PROMPT);
    expect(JSON.parse(on.body).format).toEqual(SUGGESTIONS_SCHEMA);
    expect({ ...JSON.parse(on.body), format: FACTS_SCHEMA, messages: [] }).toEqual({ ...JSON.parse(await run({}).then((r) => r.body)), messages: [] });
    expect(on.asked).toEqual([true]);
    expect(on.got).toEqual([{ kind: 'goal', text: 'host Tanner', quote: 'My friend Tanner is visiting from Houston', conversationId: 'console', turnId: 't1', sourceAt: at, staysHere: false }]);
    // The extractor's version is not bumped: turning this on never re-reads history.
    expect(EXTRACT_VERSION).toBe(2);
  });

  it('never on the frontier: its prompt does not change, and a suggestion in its reply is not read, whatever shape the reply has', async () => {
    const convs = { c1: [turn('c1', SAID)] };
    const got: ChatSuggestion[] = [];
    const prompts: string[] = [];
    const flags: Array<boolean | undefined> = [];
    const reply = { facts: [], suggestions: [good()] };
    for (const answer of [{ text: JSON.stringify(reply) }, reply as unknown as BrainReply]) {
      const brain: ExtractBrain = { generate: async (i) => { prompts.push(i.prompt); flags.push(i.suggestions); return answer as BrainReply; } };
      const ex = new MemoryExtractor(source(convs), new KnowledgeStore(join(dir, `k${Math.random()}.json`), downEmbedder), brain, join(dir, `s${Math.random()}.json`), {
        kind: 'frontier', now: () => NOW, candidates: true, onCandidate: async (s) => (got.push(s), 'filed' as SuggestionOutcome),
      });
      await ex.run();
      expect(ex.suggests).toBe(false);
      expect(ex.lastStats).toMatchObject({ calls: 1, suggested: 0, suggestionsKept: 0 });
    }
    expect(prompts).toHaveLength(2);
    for (const p of prompts) {
      expect(p).not.toContain('suggestions');
      expect(p).not.toContain(SUGGEST_PROMPT.trim().slice(0, 40));
    }
    expect(flags).toEqual([undefined, undefined]);
    expect(got).toEqual([]);
    // The same turn on the local model, asked: handed on.
    expect((await pass(convs, [good()])).got).toHaveLength(1);
  });

  it('kept: the quote is Will’s own, in the turn it names; it is handed on with the conversation, the turn and when it ended', async () => {
    const t = turn('console-1', SAID, 'Good plan.', 'turn_abc');
    const { got, stats, calls } = await pass({ 'console-1': [t] }, [good({ dueOn: '2027-03-20' }), { turn: 1, kind: 'commitment', quote: `I'll sign up for the Dallas race this week`, text: 'sign up for the Dallas race', dueOn: '' }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ system: EXTRACT_SYSTEM, suggestions: true });
    expect(got).toEqual([
      { kind: 'goal', text: 'run a half marathon', quote: QUOTE, dueOn: '2027-03-20', conversationId: 'console-1', turnId: 'turn_abc', sourceAt: t.updatedAt, staysHere: false },
      { kind: 'commitment', text: 'sign up for the Dallas race', quote: `I'll sign up for the Dallas race this week`, conversationId: 'console-1', turnId: 'turn_abc', sourceAt: t.updatedAt, staysHere: false },
    ]);
    expect(stats).toMatchObject({ suggested: 2, suggestionsKept: 2, suggestionsFiled: 2 });
    expect(Object.keys(stats.rejected).filter((r) => r.startsWith('suggestion-'))).toEqual([]);
  });

  it('dropped: the claim is only in the assistant’s words, never Will’s', async () => {
    const t = turn('c1', `${CANARY} what should I work on this quarter, do you think?`, `${CANARY} You committed to ship the report by Friday.`);
    const { got, stats } = await pass({ c1: [t] }, [{ turn: 1, kind: 'commitment', quote: `${CANARY} You committed to ship the report by Friday`, text: 'ship the report', dueOn: '' }]);
    expect(got).toEqual([]);
    expect(stats.rejected['suggestion-quote']).toBe(1);
    expect(stats).toMatchObject({ suggested: 1, suggestionsKept: 0, suggestionsFiled: 0 });
  });

  it('dropped: the quote is only in the earlier turn shown for context, or in another turn of the batch', async () => {
    const first = turn('c1', `${CANARY} I will send Dana the draft contract by Friday`);
    const second = turn('c1', `${CANARY} what is a good name for a sailing boat, any ideas?`);
    // Only the second turn is new: the first is its "(earlier in this conversation ...)" line.
    const convs = { c1: [first, second] };
    const spath = join(dir, 'ctx-state.json');
    const { brain, calls } = local(() => ({ suggestions: [{ turn: 1, kind: 'commitment', quote: `${CANARY} I will send Dana the draft contract by Friday`, text: 'send Dana the draft contract', dueOn: '' }] }));
    const got: ChatSuggestion[] = [];
    const seed = new MemoryExtractor(source({ c1: [first] }), new KnowledgeStore(join(dir, 'ctx-k.json'), downEmbedder), local(() => ({})).brain, spath, { now: () => NOW });
    await seed.run();
    const ex = new MemoryExtractor(source(convs), new KnowledgeStore(join(dir, 'ctx-k.json'), downEmbedder), brain, spath, { now: () => NOW, candidates: true, onCandidate: async (s) => (got.push(s), 'filed' as SuggestionOutcome) });
    await ex.run();
    expect(calls).toHaveLength(1);
    // The model was shown those words, as context, and quoted them: they are not this turn's.
    expect(calls[0]!.prompt).toContain('(earlier in this conversation');
    expect(calls[0]!.prompt).toContain('send Dana the draft contract');
    expect(got).toEqual([]);
    expect(ex.lastStats.rejected['suggestion-quote']).toBe(1);
    // Two new turns in one call: a quote from turn 1 that names turn 2 is not turn 2's.
    const a = turn('c2', `${CANARY} I will renew the passport before the trip in June`);
    const b = turn('c2', `${CANARY} remind me what the capital of Australia is again`);
    const wrong = await pass({ c2: [a, b] }, [{ turn: 2, kind: 'commitment', quote: `${CANARY} I will renew the passport before the trip in June`, text: 'renew the passport', dueOn: '' }]);
    expect(wrong.got).toEqual([]);
    expect(wrong.stats.rejected['suggestion-quote']).toBe(1);
    // Named rightly, it is kept: the check is about the turn, not the words.
    const right = await pass({ c2: [a, b] }, [{ turn: 1, kind: 'commitment', quote: `${CANARY} I will renew the passport before the trip in June`, text: 'renew the passport', dueOn: '' }]);
    expect(right.got).toHaveLength(1);
    expect(right.got[0]).toMatchObject({ turnId: a.id });
  });

  it('dropped: a paraphrase, a quote under 12 characters, one over 300, and one that starts or ends inside a word', async () => {
    const t = turn('c1', `${CANARY} I want to run a half marathon by spring and visit my cardiologist first, ${'and keep at it '.repeat(30)}`);
    const { got, stats } = await pass({ c1: [t] }, [
      good({ quote: `${CANARY} I would like to run a half marathon in the spring` }),
      good({ quote: 'I want to r' }),
      good({ quote: `${CANARY} I want to run a half marathon by spring and visit my cardiologist first, ${'and keep at it '.repeat(30)}`.slice(0, 320) }),
      good({ quote: 'want to run a half marathon by spring and visit my card' }),
      good({ quote: '' }),
    ]);
    expect(got).toEqual([]);
    expect(stats.rejected['suggestion-quote']).toBe(5);
    // The length alone: eleven characters of his own whole words are too few to be a quote; twelve are enough.
    const short = turn('c2', `${CANARY} New goals for the year: learn Swift, and learn Kotlin properly this time`);
    const edge = await pass({ c2: [short] }, [good({ quote: 'learn Swift', text: 'learn Swift' }), good({ quote: 'learn Kotlin', text: 'learn Kotlin' })]);
    expect('learn Swift'.length).toBe(11);
    expect(edge.got.map((g) => g.quote)).toEqual(['learn Kotlin']);
    expect(edge.stats.rejected['suggestion-quote']).toBe(1);
  });

  it('dropped: no turn, a turn the batch does not have, and an entry that is not the shape; the facts beside it are kept', async () => {
    const a = turn('c1', SAID);
    const b = turn('c1', `${CANARY} I also keep a Mac Studio in the office for the big model runs`);
    const facts = [{ turn: 2, quote: 'I also keep a Mac Studio in the office', fact: 'Will keeps a Mac Studio in the office.', category: 'hardware', supersedes: [] }];
    const { got, stats, k } = await pass({ c1: [a, b] }, [
      { kind: 'goal', quote: QUOTE, text: 'run a half marathon', dueOn: '' },
      good({ turn: 3 }),
      good({ turn: 0 }),
      good({ turn: '1' }),
      good({ kind: 'task' }),
      'not an object',
    ], {}, facts);
    expect(got).toEqual([]);
    expect(stats.rejected['suggestion-shape']).toBe(4);
    expect(stats.rejected['suggestion-turn']).toBe(1);
    // More than five in one reply: the rest are not read.
    expect(stats.rejected['suggestion-extra']).toBe(1);
    expect(stats.suggested).toBe(6);
    expect(k.all().map((f) => f.text)).toEqual(['Will keeps a Mac Studio in the office.']);
    expect(stats.stored).toBe(1);
  });

  it('a tainted turn is never mined: it is not sent to the model, so nothing can be suggested from it', async () => {
    const t = turn('c1', SAID);
    const { got, calls, stats } = await pass({ c1: [t] }, [good()], { isTainted: () => true });
    expect(calls).toEqual([]);
    expect(got).toEqual([]);
    expect(stats).toMatchObject({ skippedTainted: 1, suggested: 0 });
    // Nor is a tainted turn before it context for the next: its words are not Will's to quote there either.
    const next = turn('c1', `${CANARY} thanks, what time is the Dallas race again`);
    const two = await pass({ c1: [t, next] }, [{ turn: 1, kind: 'goal', quote: QUOTE, text: 'run a half marathon', dueOn: '' }], { isTainted: (_c, id) => id === t.id });
    expect(two.calls).toHaveLength(1);
    expect(two.calls[0]!.prompt).not.toContain('half marathon');
    expect(two.got).toEqual([]);
  });

  it('kept: a quote past the 1,500 characters the model is shown, but inside Will’s whole message', async () => {
    const long = `${'Some notes about the week, nothing to act on. '.repeat(40)}${CANARY} I will finish the kitchen cabinets before Thanksgiving`;
    expect(long.indexOf(CANARY)).toBeGreaterThan(1500);
    const t = turn('c1', long);
    const { got, calls } = await pass({ c1: [t] }, [{ turn: 1, kind: 'commitment', quote: `${CANARY} I will finish the kitchen cabinets before Thanksgiving`, text: 'finish the kitchen cabinets', dueOn: '' }]);
    // The model was not shown it (its line is clipped), yet the words are his.
    expect(calls[0]!.prompt).not.toContain('kitchen cabinets');
    expect(got).toHaveLength(1);
    // Past 8,000 characters it is not looked for.
    const longer = turn('c2', `${'x'.repeat(8100)} ${CANARY} I will repaint the fence in the spring for sure`);
    expect((await pass({ c2: [longer] }, [{ turn: 1, kind: 'commitment', quote: `${CANARY} I will repaint the fence in the spring for sure`, text: 'repaint the fence', dueOn: '' }])).got).toEqual([]);
  });

  it('kept: curly quotes, doubled spaces and line breaks differ, or the model wrapped it in quote marks; what is handed on is his words, made alike', async () => {
    const t = turn('c1', `${CANARY} I’ll  finish the “Q4 report”\nbefore   Friday, promise`);
    const { got } = await pass({ c1: [t] }, [
      { turn: 1, kind: 'commitment', quote: `"${CANARY} I'll finish the "Q4 report" before Friday."`, text: 'finish the Q4 report', dueOn: '' },
    ]);
    expect(got).toEqual([expect.objectContaining({ quote: `${CANARY} I'll finish the "Q4 report" before Friday`, text: 'finish the Q4 report' })]);
    // The same suggestion twice in one reply is one.
    const twice = await pass({ c1: [t] }, [1, 2].map(() => ({ turn: 1, kind: 'commitment', quote: `${CANARY} I’ll finish the “Q4 report” before Friday`, text: 'finish the Q4 report', dueOn: '' })));
    expect(twice.got).toHaveLength(1);
    // Case is kept: other capitals are other words.
    expect((await pass({ c1: [t] }, [{ turn: 1, kind: 'commitment', quote: `${CANARY} I'LL FINISH THE "Q4 REPORT" BEFORE FRIDAY`, text: 'finish the Q4 report', dueOn: '' }])).got).toEqual([]);
  });

  it('the short text is held to his message too: words he did not say, or a number he did not give, drop it', async () => {
    const t = turn('c1', SAID);
    const { got, stats } = await pass({ c1: [t] }, [
      good({ text: 'climb Kilimanjaro with Dana' }),
      good({ text: 'run 7 half marathons' }),
      good({ text: 'ru' }),
      good({ text: 'x'.repeat(121) }),
    ]);
    expect(got).toEqual([]);
    expect(stats.rejected['suggestion-text']).toBe(4);
  });

  it('a date is a real day, not before the turn; one that has passed since is left off, and a turn over 30 days old is not suggested from', async () => {
    const t = turn('c1', SAID);
    const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    const bad = await pass({ c1: [t] }, [good({ dueOn: 'next Friday' }), good({ dueOn: '2027-02-30' }), good({ dueOn: day(t.updatedAt - 3 * DAY) })]);
    expect(bad.got).toEqual([]);
    expect(bad.stats.rejected['suggestion-date']).toBe(3);
    // He named a day; the pass runs after it: the suggestion stands, without the day.
    const later = await pass({ c1: [t] }, [good({ dueOn: day(t.updatedAt + DAY) })], { now: () => t.updatedAt + 5 * DAY });
    expect(later.got).toHaveLength(1);
    expect(later.got[0]).not.toHaveProperty('dueOn');
    const old = await pass({ c1: [t] }, [good()], { now: () => t.updatedAt + 31 * DAY });
    expect(old.got).toEqual([]);
    expect(old.stats.rejected['suggestion-old']).toBe(1);
    // A conversation whose id the runtime could not name a card by.
    const odd = await pass({ 'voice chat': [turn('voice chat', SAID)] }, [good()]);
    expect(odd.got).toEqual([]);
    expect(odd.stats.rejected['suggestion-id']).toBe(1);
  });

  it('what became of each is counted by a word: filed, known, capped, refused, or the runtime did not answer', async () => {
    const turns = [1, 2, 3, 4, 5].map((i) => turn('c1', `${CANARY} I will finish chapter ${i} of the sailing book this month`));
    const outcomes: SuggestionOutcome[] = ['filed', 'known', 'capped', 'refused'];
    let n = 0;
    const { stats } = await pass({ c1: turns }, turns.map((_t, i) => ({ turn: i + 1, kind: 'commitment', quote: `${CANARY} I will finish chapter ${i + 1} of the sailing book this month`, text: `finish chapter ${i + 1}`, dueOn: '' })), {
      onCandidate: async () => {
        const o = outcomes[n++];
        if (!o) throw new Error(`${CANARY} the runtime fell over`);
        return o;
      },
    });
    expect(stats).toMatchObject({ suggested: 5, suggestionsKept: 5, suggestionsFiled: 1 });
    expect(stats.rejected).toMatchObject({ 'suggestion-known': 1, 'suggestion-capped': 1, 'suggestion-refused': 1, 'suggestion-unreachable': 1 });
    // The pass's log line says how many, and nothing else.
    expect(said.some((l) => /5 suggestion\(s\) → kept 5, filed 1/.test(l))).toBe(true);
  });

  it('a turn answered with Will’s goals may be mined on the local model, and says so when it is handed on', async () => {
    const t = turn('c1', SAID);
    const { got, calls } = await pass({ c1: [t] }, [good()], { carriedGoals: () => true });
    expect(calls).toHaveLength(1);
    expect(got).toEqual([expect.objectContaining({ staysHere: true, turnId: t.id })]);
  });

  it('the knowledge facts are stored exactly as with it off', async () => {
    const convs = { c1: [turn('c1', `${CANARY} I keep a Mac Studio in the office and I want to run a half marathon by spring`)] };
    const facts = [{ turn: 1, quote: 'I keep a Mac Studio in the office', fact: 'Will keeps a Mac Studio in the office.', category: 'hardware', supersedes: [] }];
    const on = await pass(convs, [good({ quote: 'I want to run a half marathon by spring' })], {}, facts);
    const off = await pass(convs, [good({ quote: 'I want to run a half marathon by spring' })], { candidates: false }, facts);
    expect(on.k.all().map((f) => [f.text, f.category, f.source])).toEqual(off.k.all().map((f) => [f.text, f.category, f.source]));
    expect(on.stats).toMatchObject({ candidates: 1, stored: 1 });
    expect(off.stats).toMatchObject({ candidates: 1, stored: 1, suggested: 0 });
    expect(on.got).toHaveLength(1);
    expect(off.got).toEqual([]);
  });

  it('a reply’s suggestions are read tolerantly, one at a time', () => {
    expect(suggestionsReply({ facts: [], suggestions: [1, 2] })).toEqual([1, 2]);
    expect(suggestionsReply({ facts: [] })).toEqual([]);
    expect(suggestionsReply({ facts: [], suggestions: 'none' })).toEqual([]);
    expect(suggestionsReply(null)).toEqual([]);
    expect(suggestionOf({ turn: 1, kind: 'goal', quote: 'q', text: 't', dueOn: ' 2027-01-02 ' })).toEqual({ turn: 1, kind: 'goal', quote: 'q', text: 't', dueOn: '2027-01-02' });
    expect(suggestionOf({ turn: 1, kind: 'goal', quote: 'q', text: 't' })).toEqual({ turn: 1, kind: 'goal', quote: 'q', text: 't', dueOn: '' });
    for (const bad of [null, 'x', [], { turn: 1.5, kind: 'goal', quote: 'q', text: 't' }, { turn: 1, kind: 'goal', quote: 5, text: 't' }, { turn: 1, kind: 'goal', quote: 'q', text: 't', dueOn: 20270102 }]) {
      expect(suggestionOf(bad)).toBeUndefined();
    }
  });
});
