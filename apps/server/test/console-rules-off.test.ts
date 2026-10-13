/**
 * The card that switches rules off, in the console's Approvals panel
 * (apps/console/index.html, <script id="approvals-js">), as Will reads it.
 *
 * A rule that holds an action back goes off only on a card he signs (the
 * runtime cannot switch one off itself: the policy_off_guard migration). That
 * card is a policy.change whose args carry `off`: the rows to switch off, each
 * by its id, its pattern and its tier (the `rules` command files it). It must
 * read as what it is: a Title Case title that says rules end, one sentence
 * that says what kind, the rules by name, each row as a sentence under Show
 * Details, every signed field on screen (the ids under REFERENCES, exactly),
 * and it always asks on its own with a fresh touch, whatever mark it carries.
 *
 * A rule card says ONE thing. Only a card whose sole key is `off`, holding a
 * list that is not empty, reads as a switch-off. A card that carries `rows`
 * as well (it would add a rule under a title that says rules end), an empty
 * list, or anything beside the one list is shown as neither: a title that
 * promises nothing, both halves under Show Details with each row said as
 * ended or as added, and it asks on its own. The runtime files no such card
 * and the server signs none; the console still never dresses one up.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { noteProblems } from '@flint/policy';
import { pinLocale } from './console-dates';

const html = readFileSync(join(__dirname, '..', '..', 'console', 'index.html'), 'utf8');
const apprJs = /<script id="approvals-js">([\s\S]*?)<\/script>/.exec(html)![1]!;

const noop = () => {};
const el = () => ({ appendChild: noop, classList: { add: noop, remove: noop, toggle: noop }, style: {}, setAttribute: noop });
// The panel's script polls the server as it loads: with no token there is nothing to ask.
const ctx: Record<string, unknown> = {
  console, setInterval: () => 0, setTimeout: () => 0, BASE: '', TOKEN: '', auth: () => ({}),
  fetch: async () => ({ ok: false, status: 401, json: async () => ({}) }),
  document: { getElementById: () => null, createElement: el, createTextNode: el, querySelectorAll: () => [] },
};
createContext(ctx);
pinLocale(ctx);
runInContext(apprJs, ctx);
const run = (code: string) => runInContext(code, ctx);

type OffRow = { id: string; pattern: string; tier: string };
/**
 * The card as the rules command files it and as a server that sends no mark lists it: `consequential` is left off on
 * purpose, so an assertion that it asks on its own cannot pass on the flag.
 */
const card = (off: unknown, more: Record<string, unknown> = {}) => ({
  id: 'proff1', fullName: 'policy.change', kind: 'policy', origin: 'cli', tainted: false, destructive: false, sensitivity: 'ops',
  expiresAt: '2026-10-20T14:00:00.000Z', reason: 'Approving switches this rule off.', args: { off }, ...more,
});
const say = (c: object) => ({
  title: run(`apprTitle(${JSON.stringify(c)})`) as string,
  sub: run(`apprSub(${JSON.stringify(c)})`) as string,
  facts: JSON.parse(JSON.stringify(run(`apprFacts(${JSON.stringify(c)})`))) as Array<[string, string]>,
  alone: run(`apprAlone(${JSON.stringify(c)})`) as boolean,
  prompt: run(`apprReason(${JSON.stringify(c)})`) as string,
});
const details = (c: object) => JSON.parse(JSON.stringify(run(`apprDetails(${JSON.stringify(c)})`))) as { says: string[]; facts: Array<[string, string]>; refs: Array<[string, string]>; withheld: string };

const BRAKE: OffRow = { id: 'apbrake01', pattern: 'goal.propose', tier: 'approval' };
const NEVER: OffRow = { id: 'apnever02', pattern: 'restore.*', tier: 'forbidden' };
const ALONE: OffRow = { id: 'apalone03', pattern: 'goal.review.local', tier: 'alone' };

/** Title Case as the console writes it: every word capitalised but the short joining ones. */
const titleCase = (t: string) => t.split(' ').every((w, i) => /^[A-Z0-9]/.test(w) || (i > 0 && ['on', 'from', 'a', 'the', 'to', 'of', 'in', 'and'].includes(w)));
/** Nothing internal in the card's own lines: no action name, id, JSON or parenthesis. */
const plain = (t: string) => !/[(){}\[\]_/\\]|goal\.|restore\.|policy\.|apbrake|apnever|apalone|\balone\b|\bforbidden\b/.test(t);

describe('the card that switches rules off', () => {
  it('one rule that makes Flint ask: the title says a rule ends, the sentence says which kind, and the rule is named', () => {
    const c = say(card([BRAKE]));
    expect(c.title).toBe('Switch Off 1 Rule');
    expect(c.sub).toBe('This ends a rule that makes Flint ask you each time.');
    // The rule by the panel's own name for it (the name its promotion card's Limits fact uses).
    expect(c.facts).toEqual([['Switches Off', 'Goal Suggestions from Chat'], ['Filed By', 'You'], ['Expires', expect.any(String)]]);
    expect(c.prompt).toBe('approve: Switch Off 1 Rule');
  });

  it('by what the rules do, read from the rows: one that stops Flint, one that lets it act, several, and a mix', () => {
    expect(say(card([NEVER]))).toMatchObject({ title: 'Switch Off 1 Rule', sub: 'This ends a rule that stops Flint.' });
    expect(say(card([NEVER])).facts[0]).toEqual(['Switches Off', 'Every Restore Action']);
    expect(say(card([ALONE]))).toMatchObject({ title: 'Switch Off 1 Rule', sub: 'This ends a rule that lets Flint act on its own.' });
    // A rule that let something run has no limit to show once it ends: it is named, and no more.
    expect(say(card([ALONE])).facts[0]).toEqual(['Switches Off', 'Goal Reviews']);
    expect(say(card([BRAKE, { ...BRAKE, id: 'apbrake09', pattern: 'goal.*' }]))).toMatchObject({ title: 'Switch Off 2 Rules', sub: 'This ends rules that make Flint ask you each time.' });
    expect(say(card([NEVER, { ...NEVER, id: 'apnever09' }])).sub).toBe('This ends rules that stop Flint.');
    expect(say(card([ALONE, { ...ALONE, id: 'apalone09' }])).sub).toBe('This ends rules that let Flint act on its own.');
    const mixed = say(card([BRAKE, NEVER, ALONE]));
    expect(mixed).toMatchObject({ title: 'Switch Off 3 Rules', sub: 'This ends 3 of your rules.' });
    expect(mixed.facts[0]).toEqual(['Switches Off', 'Goal Suggestions from Chat · Every Restore Action · Goal Reviews']);
    // A tier this panel does not know is never said to be one it does.
    expect(say(card([{ ...BRAKE, tier: 'sometimes' }])).sub).toBe('This ends one of your rules.');
  });

  it('always asks on its own, whatever mark it carries: ending a brake widens what Flint may do alone', () => {
    for (const off of [[BRAKE], [NEVER], [ALONE], [BRAKE, NEVER, ALONE], []]) {
      expect(say(card(off)).alone, JSON.stringify(off)).toBe(true);
      expect(say(card(off, { consequential: false })).alone).toBe(true);
    }
    // A rule with a limit of its own that ends has no limit to show: it is named, and no more.
    expect(say(card([{ id: 'apbk', pattern: 'backup.local', tier: 'alone' }])).facts[0]).toEqual(['Switches Off', 'Backup']);
    // A card that adds rules is as it was: one that only tightens can be approved with the rest.
    const adds = { ...card([]), args: { rows: [{ pattern: 'goal.propose', tier: 'approval', expiresAt: '2027-04-05T00:00:00.000Z' }] } };
    expect(say(adds).alone).toBe(false);
    expect(say(adds).title).toBe('Ask Before 1 Action');
  });

  it('Show Details: each rule that ends as a sentence, and every signed field on screen, the ids exactly', () => {
    const d = details(card([BRAKE, NEVER, ALONE]));
    expect(d.says).toEqual([
      'This rule ends: You approve “Goal Suggestions from Chat” each time.',
      'This rule ends: Flint may not run any action under “Restore”.',
      'This rule ends: Goal reviews may run on their own.',
    ]);
    expect(d.withheld).toBe('');
    // What the sentences did not state: the ids, exactly; and the name of a rule this panel has no words for, as it is written.
    expect(d.refs).toEqual([['Rule 1 ID', 'apbrake01'], ['Rule 2 ID', 'apnever02'], ['Rule 3 ID', 'apalone03']]);
    expect(d.facts).toEqual([['Rule 2 Action', 'restore.*']]);
    for (const s of d.says) expect(noteProblems('Rule', s), s).toEqual([]);
    // Nothing signed is unseen: a field the runtime never sends still shows, and a tier this panel does not know is listed as written.
    const odd = details(card([{ ...BRAKE, tier: 'sometimes', note: 'Synthetic note' }]));
    expect(odd.says).toEqual(['A rule ends. What it says is listed below.']);
    expect(odd.facts).toEqual(expect.arrayContaining([['Rule 1 Action', 'goal.propose'], ['Rule 1 Tier', 'Sometimes'], ['Rule 1 Note', 'Synthetic note']]));
    expect(odd.refs).toEqual([['Rule 1 ID', 'apbrake01']]);
  });

  describe('a card that is not one thing', () => {
    const UNTIL = '2027-04-05T00:00:00.000Z';
    const WIDE = { pattern: 'mcp:hive.*', tier: 'alone', expiresAt: UNTIL };
    const REVIEWS = { pattern: 'goal.review.local', tier: 'alone', dailyCap: 20, expiresAt: UNTIL };
    const both = (off: unknown, rows: unknown, more: Record<string, unknown> = {}) => ({ ...card([]), args: { off, rows }, ...more });

    it('the reviewed card, rows beside off: never "Switch Off", both halves named apart, every row said as ended or as added', () => {
      const c = both([ALONE], [WIDE]);
      const said = say(c);
      expect(said.title).toBe('Change 2 Rules');
      expect(said.title).not.toMatch(/Switch Off|Let /);
      expect(said.sub).toBe('It adds rules and ends rules at once.');
      expect(said.facts).toEqual([['Ends', 'Goal Reviews'], ['Adds', 'Every MCP Hive Action'], ['Filed By', 'You']]);
      expect(said.alone).toBe(true);
      expect(say({ ...c, consequential: false }).alone).toBe(true);
      const d = details(c);
      expect(d.says[0]).toBe('This rule ends: Goal reviews may run on their own.');
      expect(d.says[1]).toMatch(/^This rule is added: .*may run on its own until /);
      expect(d.says).toHaveLength(2);
      // Nothing is "Rule 1" twice: what the sentences did not state is listed under which list it is in.
      expect(d.refs).toEqual([['Ended Rule 1 ID', 'apalone03']]);
      expect(d.facts).toEqual([['Added Rule 1 Action', 'mcp:hive.*']]);
      for (const line of d.says) expect(noteProblems('Rule', line), line).toEqual([]);
    });

    it('a known promotion beside a switch-off is not titled as that promotion either', () => {
      const said = say(both([BRAKE], [REVIEWS]));
      expect(said.title).toBe('Change 2 Rules');
      expect(said.facts.slice(0, 2)).toEqual([['Ends', 'Goal Suggestions from Chat'], ['Adds', 'Goal Reviews 20 a Day']]);
      expect(details(both([BRAKE], [REVIEWS])).says).toEqual([
        'This rule ends: You approve “Goal Suggestions from Chat” each time.',
        expect.stringMatching(/^This rule is added: Goal reviews may run on their own, up to 20 a day, until /),
      ]);
    });

    it('an empty list never reads as a switch-off or a promotion: not "Switch Off 0 Rules", and each empty list is said by name', () => {
      // off: [] beside rows: the rows are what it does, and it is not a pure rows card either.
      const empty = both([], [WIDE]);
      expect(say(empty)).toMatchObject({ title: 'Change 1 Rule', sub: 'It changes what Flint may do on its own.', alone: true });
      expect(say(empty).facts[0]).toEqual(['Adds', 'Every MCP Hive Action']);
      expect(details(empty).facts).toEqual(expect.arrayContaining([['Ended Rules', 'None'], ['Added Rule 1 Action', 'mcp:hive.*']]));
      expect(details(empty).says).toEqual([expect.stringMatching(/^This rule is added: /)]);
      // rows: [] beside off.
      const none = both([BRAKE], []);
      expect(say(none)).toMatchObject({ title: 'Change 1 Rule', alone: true });
      expect(say(none).facts[0]).toEqual(['Ends', 'Goal Suggestions from Chat']);
      expect(details(none).facts).toEqual([['Added Rules', 'None']]);
      // off alone and empty.
      const nothing = card([]);
      expect(say(nothing)).toMatchObject({ title: 'Change 0 Rules', sub: 'It changes what Flint may do on its own.', alone: true });
      expect(say(nothing).facts[0]).toEqual(['Rules', 'None']);
      expect(details(nothing).facts).toEqual([['Ended Rules', 'None']]);
      for (const c of [empty, none, nothing]) expect(say(c).title).not.toMatch(/Switch Off/);
    });

    it('a key beside the one list, or a list that is not a list, is neither kind: it asks on its own and shows all it holds', () => {
      const extra = { ...card([BRAKE]), args: { off: [BRAKE], also: 'Synthetic extra' } };
      expect(say(extra)).toMatchObject({ title: 'Change 1 Rule', alone: true });
      expect(details(extra).facts).toEqual(expect.arrayContaining([['Also', 'Synthetic extra']]));
      expect(details(extra).says).toEqual(['This rule ends: You approve “Goal Suggestions from Chat” each time.']);
      const beside = { ...card([]), args: { rows: [REVIEWS], note: 'Synthetic extra' } };
      expect(say(beside)).toMatchObject({ title: 'Change 1 Rule', alone: true });
      expect(say(beside).title).not.toMatch(/Let /);
      for (const args of [{ off: BRAKE }, { off: 'all' }, { rows: 'goal.review.local' }, {}, { switchOff: [BRAKE] }]) {
        const c = { ...card([]), args };
        expect(say(c).title, JSON.stringify(args)).toBe('Change 0 Rules');
        expect(say(c).alone, JSON.stringify(args)).toBe(true);
        expect(details(c).withheld).toBe('');
      }
    });

    it('a card that only adds rules is as it was', () => {
      const adds = { ...card([]), args: { rows: [REVIEWS] } };
      expect(say(adds).title).toBe('Let Goal Reviews Run on Their Own');
      expect(say(adds).facts[1]).toEqual(['Limits', 'Goal Reviews 20 a Day']);
      expect(details(adds).says).toEqual([expect.stringMatching(/^Goal reviews may run on their own, up to 20 a day, until /)]);
      expect(details(adds).refs).toEqual([]);
      const asks = { ...card([]), args: { rows: [{ pattern: 'goal.propose', tier: 'approval', expiresAt: UNTIL }] } };
      expect(say(asks)).toMatchObject({ title: 'Ask Before 1 Action', alone: false });
    });
  });

  it('every line is Will’s standard: Title Case titles and labels, one complete sentence, nothing internal in the card’s own lines', () => {
    for (const off of [[BRAKE], [NEVER], [ALONE], [BRAKE, NEVER, ALONE]]) {
      const c = say(card(off));
      expect(titleCase(c.title), c.title).toBe(true);
      expect(c.sub, c.sub).toMatch(/^[A-Z][^.!?]*\.$/);
      // The sentence by the notes' own standard. (The title's "Off" is the verb's, capitalised as "Turn On Predictions" is.)
      expect(noteProblems('Rule', c.sub), c.sub).toEqual([]);
      for (const [label, value] of c.facts.slice(0, 2)) {
        expect(titleCase(label), label).toBe(true);
        expect(titleCase(value.replace(/ · /g, ' ')), value).toBe(true);
      }
      for (const text of [c.title, c.sub, ...c.facts.slice(0, 2).flat()]) expect(plain(text), text).toBe(true);
    }
  });
});
