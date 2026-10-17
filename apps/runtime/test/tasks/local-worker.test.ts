/**
 * The local worker against a stub Ollama (P5): what it sends, the gate before
 * every request, what it takes for an answer, what it refuses, and the prompt.
 *
 *  - The request goes to Ollama's /api/chat alone, with the template's schema
 *    (every field required, nothing else allowed), no thinking, temperature 0,
 *    the template's token limit, and num_ctx only when configured.
 *  - An item is a number in the reply, never a ref it writes: the code turns
 *    the numbers into the refs of the items the task was given, so a result can
 *    name no other item, and a number that is not one of them is a failed
 *    attempt.
 *  - A reply that misses one of the template's own rule checks is asked again,
 *    told which rule in fixed words; the better answer is taken, and when
 *    neither meets the bar the first is handed in as it came, for its bar to
 *    say so.
 *  - Chat running means the task waits: nothing is sent, nothing is counted.
 *    A task's requests used up means it fails as capped; a model that is not on
 *    this Mac, as unavailable; a deadline, as a timeout.
 *  - The prompt holds the items' kinds and clean state, their titles only where
 *    the signed spec asked for titles, Will's own words where a template takes
 *    them, and never a ref.
 */
import { describe, it, expect } from 'vitest';
import { TASK_OUTPUTS, TaskSpec, noteProblems, ruleChecks, evaluateChecks } from '@flint/policy';
import { modelsHere } from '../ollama-kit';
import {
  REQUESTS_A_DAY,
  SCHEMA_NAME,
  WORK_REQUESTS,
  WORK_TEMPLATES,
  isWorkTemplate,
  localWorker,
  missedSays,
  outputOf,
  replySchema,
  requestsCounter,
  summaryOf,
  workPrompt,
  type WorkerDeps,
} from '../../src/tasks/local-worker';
import type { AdapterInput, ItemFact } from '../../src/tasks/adapters/types';
import { FORM_ITEM_KINDS, WORK_ITEM_KINDS } from '../../src/tasks/offer';
import { STATE } from '../../src/world/kinds';

const OLLAMA = { url: 'http://127.0.0.1:11434', model: 'muse-glimmer:30b' };
// Ollama has listed the model as its own: what makes a model "not here" is model/here.test.ts's.
modelsHere([OLLAMA.model]);

const NOW = new Date('2026-10-16T09:00:00.000Z');
const TASK = 'tkabcdefgh12345678';

const item = (over: Partial<ItemFact> = {}): ItemFact => ({ id: 'en1', ref: 'pull_request#000en1', kind: 'pull_request', state: { state: 'open', number: 12 }, ...over });
const ITEMS: ItemFact[] = [
  item(),
  item({ id: 'en2', ref: 'issue#000en2', kind: 'issue', state: { state: 'open' } }),
  item({ id: 'en3', ref: 'ci_run#000en3', kind: 'ci_run', state: { status: 'completed', conclusion: 'failure' } }),
];

const spec = (template: string, params: Record<string, unknown>): TaskSpec => TaskSpec.parse({ template, params });
const summarize = (titles = false) => spec('summarize_items', { items: ITEMS.map((i) => i.id), titles });
const sort = (labels: string[] = ['Mine', 'Theirs']) => spec('sort_items', { items: ITEMS.map((i) => i.id), labels });
const note = () => spec('draft_note', { about: 'What the week looked like' });

const input = (s: TaskSpec, items: readonly ItemFact[] = ITEMS): AdapterInput => ({ taskId: TASK, spec: s, items, now: NOW });

/** Everything an adapter is handed, frozen to the last leaf. */
function freeze<T>(v: T): T {
  if (v && typeof v === 'object') for (const x of Object.values(v)) freeze(x);
  return Object.freeze(v);
}

const reply = (content: unknown, done_reason = 'stop') =>
  new Response(JSON.stringify({ model: 'm', message: { role: 'assistant', content: typeof content === 'string' ? content : JSON.stringify(content) }, done: true, done_reason, prompt_eval_count: 10, eval_count: 5 }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

function stub(replies: Array<() => Response | Promise<Response>>) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
    return replies[Math.min(calls.length - 1, replies.length - 1)]!();
  }) as typeof globalThis.fetch;
  return { calls, fetch };
}

/** A worker over these replies, with the gate open and its requests to spare unless a test says otherwise. */
function worker(replies: Array<() => Response | Promise<Response>>, over: Partial<WorkerDeps> = {}) {
  const s = stub(replies);
  const asked: string[] = [];
  const d: WorkerDeps = {
    ollama: OLLAMA,
    load: async () => 'proceed',
    attempt: async (taskId) => {
      asked.push(taskId);
      return true;
    },
    fetch: s.fetch,
    ...over,
  };
  return { ...s, asked, adapter: localWorker(d) };
}

const GOOD_SUMMARY = { headline: 'Three Items Are Open', points: [{ text: 'A pull request and an issue are open.', items: [1, 2] }, { text: 'A run ended without passing.', items: [3] }], attention: [3] };
const GOOD_SORT = { labels: [{ item: 1, label: 'Mine' }, { item: 2, label: 'Theirs' }, { item: 3, label: 'Mine' }] };
const GOOD_NOTE = { title: 'The Week', body: 'Two items are open and one run failed. Nothing else moved.' };

describe('the local worker (stub Ollama)', () => {
  it('a summary: one request to /api/chat with the template’s schema, and the numbers it answers become this task’s refs', async () => {
    const w = worker([() => reply(GOOD_SUMMARY)]);
    const r = await w.adapter.run(input(summarize()));
    expect(r).toEqual({
      output: {
        headline: 'Three Items Are Open',
        points: [{ text: 'A pull request and an issue are open.', refs: ['pull_request#000en1', 'issue#000en2'] }, { text: 'A run ended without passing.', refs: ['ci_run#000en3'] }],
        attention: ['ci_run#000en3'],
      },
      summary: 'It made 2 points about 3 items. It marked 1 item to look at.',
    });
    expect(w.calls).toHaveLength(1);
    expect(w.calls[0]!.url).toBe('http://127.0.0.1:11434/api/chat');
    expect(w.asked).toEqual([TASK]);
    const body = w.calls[0]!.body as { model: string; think: boolean; stream: boolean; format: Record<string, unknown>; options: Record<string, unknown>; messages: Array<{ role: string; content: string }> };
    expect(body).toMatchObject({ model: OLLAMA.model, think: false, stream: false });
    expect(body.options).toEqual({ temperature: 0, num_predict: 800 });
    expect(body.format).toEqual(replySchema(summarize(), ITEMS.length));
    expect(body.format.additionalProperties).toBe(false);
    expect(body.format.required).toEqual(['headline', 'points', 'attention']);
    const p = workPrompt(summarize(), ITEMS);
    expect(body.messages).toEqual([{ role: 'system', content: p.system }, { role: 'user', content: p.user }]);
    // num_ctx only when the server's is configured (another one makes Ollama reload the model chat is using).
    const t = worker([() => reply(GOOD_SUMMARY)], { ollama: { ...OLLAMA, numCtx: 16384 } });
    await t.adapter.run(input(summarize()));
    expect(t.calls[0]!.body.options).toEqual({ temperature: 0, num_ctx: 16384, num_predict: 800 });
  });

  it('a sort gives every item one of Will’s labels; a note is its title and body, and needs no item', async () => {
    const s = worker([() => reply(GOOD_SORT)]);
    expect(await s.adapter.run(input(sort()))).toEqual({
      output: { labels: [{ ref: 'pull_request#000en1', label: 'Mine' }, { ref: 'issue#000en2', label: 'Theirs' }, { ref: 'ci_run#000en3', label: 'Mine' }] },
      summary: 'It put 3 items under 2 labels.',
    });
    expect((s.calls[0]!.body as { options: Record<string, unknown> }).options).toEqual({ temperature: 0, num_predict: 600 });
    const n = worker([() => reply(GOOD_NOTE)]);
    expect(await n.adapter.run(input(note(), []))).toEqual({ output: GOOD_NOTE, summary: 'It wrote a note of 58 characters.' });
    expect((n.calls[0]!.body as { options: Record<string, unknown> }).options).toEqual({ temperature: 0, num_predict: 1000 });
  });

  it('every summary it hands back is fit to show: its template’s shape, its bar met, and a sentence of counts alone; and it changes nothing it was given', async () => {
    for (const [s, answer] of [[summarize(), GOOD_SUMMARY], [sort(), GOOD_SORT], [note(), GOOD_NOTE]] as const) {
      const w = worker([() => reply(answer)]);
      // Frozen, as every adapter is held to (test/tasks/adapter-contract.test.ts): it reads what it was handed.
      const given = freeze(input(s, s.template === 'draft_note' ? [] : ITEMS));
      const before = JSON.stringify(given);
      const r = await w.adapter.run(given);
      expect(JSON.stringify(given), s.template).toBe(before);
      expect('output' in r, s.template).toBe(true);
      if (!('output' in r)) continue;
      expect(TASK_OUTPUTS[s.template].safeParse(r.output).success, s.template).toBe(true);
      // Its own rule checks are met, so the bar has nothing to reject.
      const refs = s.template === 'draft_note' ? [] : ITEMS.map((i) => i.ref);
      expect(evaluateChecks(s, ruleChecks(s), r.output, { refs }).metBar, s.template).toBe(true);
      // The sentence beside it is Flint's own: fit for a note, and holding no word the model wrote.
      expect(noteProblems('A Title', r.summary), s.template).toEqual([]);
      expect(r.summary, s.template).not.toMatch(/open|week|failed|Mine/);
    }
  });

  it('a number that is not one of this task’s items is a failed attempt, and nothing is dropped from the result', async () => {
    for (const answer of [
      { ...GOOD_SUMMARY, points: [{ text: 'About an item it was not given.', items: [4] }] },
      { ...GOOD_SUMMARY, points: [{ text: 'About an item it was not given.', items: [0] }] },
      { ...GOOD_SUMMARY, attention: [9] },
      { ...GOOD_SUMMARY, points: [{ text: 'A ref of its own.', items: ['pull_request#000en1'] }] },
      { ...GOOD_SUMMARY, headline: '' },
      { ...GOOD_SUMMARY, extra: 'a field of its own' },
      { headline: 'No Points', attention: [] },
    ]) {
      const w = worker([() => reply(answer)]);
      expect(await w.adapter.run(input(summarize())), JSON.stringify(answer)).toEqual({ failure: 'invalid' });
      expect(w.calls, JSON.stringify(answer)).toHaveLength(WORK_REQUESTS);
    }
    // A sort is held to one label of its own per item, each item once.
    for (const answer of [
      { labels: [{ item: 1, label: 'Mine' }, { item: 2, label: 'Theirs' }, { item: 3, label: 'Ours' }] },
      { labels: [{ item: 1, label: 'Mine' }, { item: 1, label: 'Theirs' }, { item: 3, label: 'Mine' }] },
      { labels: [{ item: 1, label: 'Mine' }, { item: 2, label: 'Theirs' }] },
    ]) {
      const w = worker([() => reply(answer)]);
      expect(await w.adapter.run(input(sort())), JSON.stringify(answer)).toEqual({ failure: 'invalid' });
    }
    // A note over its template's length is refused, never cut to fit.
    const long = worker([() => reply({ title: 'The Week', body: `${'A sentence about the week. '.repeat(60)}` })]);
    expect(await long.adapter.run(input(note(), []))).toEqual({ failure: 'invalid' });
  });

  it('an answer that misses a rule of its template is asked again, told which; the better one is taken', async () => {
    const odds = { ...GOOD_SUMMARY, points: [{ text: 'The run will likely fail again.', items: [3] }] };
    const w = worker([() => reply(odds), () => reply(GOOD_SUMMARY)]);
    const r = await w.adapter.run(input(summarize()));
    expect(r).toMatchObject({ output: { headline: 'Three Items Are Open' } });
    expect(w.calls).toHaveLength(2);
    // The second request says, in fixed words, which rule the last answer missed: asking again asks something new,
    // which is what makes a second answer possible at a temperature of nothing.
    const second = w.calls[1]!.body as { options: Record<string, unknown>; messages: Array<{ content: string }> };
    expect(second.options).toEqual({ temperature: 0, num_predict: 800 });
    expect(second.messages[1]!.content).not.toBe((w.calls[0]!.body as { messages: Array<{ content: string }> }).messages[1]!.content);
    expect(second.messages[1]!.content).toContain(missedSays(['no_loose_odds']));
    expect(missedSays(['no_loose_odds'])).toBe('Your last answer used words about chances or likelihood. Answer again, and meet every rule above.');
    expect(missedSays([])).toBe('');
    // The first request said nothing of the kind.
    expect((w.calls[0]!.body as { messages: Array<{ content: string }> }).messages[1]!.content).not.toMatch(/Your last answer/);
  });

  it('when no answer meets the bar, the first is handed in as it came: Will sees the result, and its bar says what it missed', async () => {
    const odds = { ...GOOD_SUMMARY, points: [{ text: 'The run will likely fail again.', items: [3] }] };
    const w = worker([() => reply(odds)]);
    const r = await w.adapter.run(input(summarize()));
    expect(r).toMatchObject({ output: { points: [{ text: 'The run will likely fail again.', refs: ['ci_run#000en3'] }] } });
    expect(w.calls).toHaveLength(WORK_REQUESTS);
    if (!('output' in r)) throw new Error('a result');
    const s = summarize();
    const { metBar, findings } = evaluateChecks(s, ruleChecks(s), r.output, { refs: ITEMS.map((i) => i.ref) });
    expect(metBar).toBe(false);
    expect(findings.filter((f) => f.met === false).map((f) => f.op)).toEqual(['covers', 'no_loose_odds']);
  });

  it('chat comes first: a task waits, and nothing is sent or counted', async () => {
    const w = worker([() => reply(GOOD_SUMMARY)], { load: async () => 'defer' });
    expect(await w.adapter.run(input(summarize()))).toEqual({ wait: true });
    expect(w.calls).toHaveLength(0);
    expect(w.asked).toEqual([]);
  });

  it('a task’s requests for the day, a model that is not on this Mac, and a deadline: each says what it was', async () => {
    const capped = worker([() => reply(GOOD_SUMMARY)], { attempt: async () => false });
    expect(await capped.adapter.run(input(summarize()))).toEqual({ failure: 'capped' });
    expect(capped.calls).toHaveLength(0);

    // A model Ollama's listing does not hold as its own: nothing is sent, nothing is counted.
    const elsewhere = worker([() => reply(GOOD_SUMMARY)], { ollama: { ...OLLAMA, model: 'some-other-model:1b' } });
    expect(await elsewhere.adapter.run(input(summarize()))).toEqual({ failure: 'unavailable' });
    expect(elsewhere.calls).toHaveLength(0);
    expect(elsewhere.asked).toEqual([]);
    // A cloud model's name is never asked either, whatever the address says.
    const cloud = worker([() => reply(GOOD_SUMMARY)], { ollama: { ...OLLAMA, model: 'gpt-oss:120b-cloud' } });
    expect(await cloud.adapter.run(input(summarize()))).toEqual({ failure: 'unavailable' });
    expect(cloud.calls).toHaveLength(0);

    const timeout = worker([
      () =>
        Promise.reject(
          Object.assign(new Error('the request took too long'), { name: 'TimeoutError' }),
        ),
    ]);
    expect(await timeout.adapter.run(input(summarize()))).toEqual({ failure: 'timeout' });

    // A transport error that is not a deadline: the model answered nothing at all.
    const down = worker([() => Promise.reject(new TypeError('fetch failed'))]);
    expect(await down.adapter.run(input(summarize()))).toEqual({ failure: 'unavailable' });

    // A reply cut off at its token limit is not a whole answer: a failed attempt, never half a result.
    const cut = worker([() => reply('{"headline":"Three Items', 'length')]);
    expect(await cut.adapter.run(input(summarize()))).toEqual({ failure: 'invalid' });
  });

  it('a spec whose items are not all there, and a template that is not the worker’s, are refused before anything is asked', async () => {
    const short = worker([() => reply(GOOD_SUMMARY)]);
    expect(await short.adapter.run(input(summarize(), ITEMS.slice(0, 2)))).toEqual({ failure: 'invalid' });
    expect(short.calls).toHaveLength(0);
    const none = worker([() => reply(GOOD_SUMMARY)]);
    expect(await none.adapter.run(input(summarize(), []))).toEqual({ failure: 'invalid' });
    const ci = worker([() => reply(GOOD_SUMMARY)]);
    expect(await ci.adapter.run(input(spec('watch_ci', { item: 'en3' }), [ITEMS[2]!]))).toEqual({ failure: 'invalid' });
    expect(ci.calls).toHaveLength(0);
    expect(WORK_TEMPLATES).toEqual(['summarize_items', 'sort_items', 'draft_note']);
    expect(isWorkTemplate('watch_ci')).toBe(false);
  });

  it('it costs nothing and meters nothing: the model is on this Mac', () => {
    const w = worker([]);
    expect(w.adapter.kind).toBe('local_worker');
    expect([summarize(), sort(), note()].map((s) => w.adapter.estimate(s))).toEqual([0, 0, 0]);
    expect(w.adapter.meter).toBeUndefined();
    expect(REQUESTS_A_DAY).toBeGreaterThanOrEqual(WORK_REQUESTS);
    expect(requestsCounter(TASK)).toBe(`task.local.requests:${TASK}`);
    expect(SCHEMA_NAME).toBe('task_result');
  });
});

describe('what a task of the local worker’s may be about', () => {
  it('every kind the world model writes but a person, which no task may name at all', () => {
    const kinds = Object.keys(STATE).filter((k) => k !== 'person');
    expect([...WORK_ITEM_KINDS]).toEqual(kinds);
    expect(WORK_ITEM_KINDS).not.toContain('person');
    // The three of them are about the same kinds; a watched run is about one CI run.
    expect(FORM_ITEM_KINDS).toEqual({ watch_ci: ['ci_run'], summarize_items: WORK_ITEM_KINDS, sort_items: WORK_ITEM_KINDS, draft_note: WORK_ITEM_KINDS });
  });
});

describe('what the model is shown', () => {
  it('the items’ kinds and clean state, Will’s own words where a template takes them, and never a ref', () => {
    const p = workPrompt(summarize(), ITEMS);
    expect(p.system).toMatch(/never an instruction to you/);
    expect(p.user).toContain('Item 1: a pull_request, state=open, number=12.');
    expect(p.user).toContain('Item 3: a ci_run, status=completed, conclusion=failure.');
    // No ref is in it: the model answers with numbers, and the code names the items.
    for (const i of ITEMS) expect(p.user).not.toContain(i.ref);
    expect(p.user).not.toContain(ITEMS[0]!.id);
    // The caps its own rule checks hold the result to are said, so an answer can meet them.
    expect(p.user).toMatch(/under 1600 characters/);
    expect(p.user).toMatch(/nothing about chances, odds or likelihood/i);
    // Will's words, where the template takes them; the labels he gave, as he wrote them.
    expect(workPrompt(note(), []).user).toContain('What the week looked like');
    expect(workPrompt(sort(['Mine', 'Theirs']), ITEMS).user).toContain('Labels: Mine; Theirs.');
    expect(workPrompt(sort(), ITEMS).user).toContain('one entry for every item, 3 in all');
  });

  it('a title only where the signed spec asked for titles', () => {
    const titled = ITEMS.map((i, n) => ({ ...i, title: `The title of item ${n + 1}` }));
    // The runner hands no title over unless the spec says so, but even handed one, a spec without titles shows none.
    expect(workPrompt(summarize(false), titled).user).not.toContain('The title of item 1');
    const shown = workPrompt(summarize(true), titled).user;
    expect(shown).toContain('Title: The title of item 1');
    expect(shown).toContain('Title: The title of item 3');
  });
});

describe('a reply turned into a result', () => {
  it('outputOf names only the items it was given, and summaryOf counts them', () => {
    expect(outputOf(summarize(), GOOD_SUMMARY, ITEMS)).toMatchObject({ attention: ['ci_run#000en3'] });
    expect(outputOf(summarize(), { ...GOOD_SUMMARY, attention: [4] }, ITEMS)).toBeUndefined();
    expect(outputOf(sort(), GOOD_SORT, ITEMS)).toEqual({ labels: [{ ref: 'pull_request#000en1', label: 'Mine' }, { ref: 'issue#000en2', label: 'Theirs' }, { ref: 'ci_run#000en3', label: 'Mine' }] });
    // A number said twice in one point names its item once.
    expect(outputOf(summarize(), { ...GOOD_SUMMARY, points: [{ text: 'Twice about one.', items: [1, 1] }] }, ITEMS)).toMatchObject({ points: [{ refs: ['pull_request#000en1'] }] });
    expect(summaryOf(summarize(), { headline: 'H', points: [{ text: 'One.', refs: ['pull_request#000en1'] }], attention: [] })).toBe('It made 1 point about 1 item.');
    expect(summaryOf(sort(), { labels: [{ ref: 'issue#000en2', label: 'Mine' }] })).toBe('It put 1 item under 1 label.');
  });
});
