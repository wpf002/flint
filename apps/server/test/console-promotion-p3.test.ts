/**
 * P3's promotion cards in the console's Approvals panel (apps/console/index.html,
 * <script id="approvals-js">), as Will reads them: a Title Case title that says
 * what signing lets happen, one complete sentence under it, three facts, and
 * never an action's internal name, an id, JSON or a parenthesis. Each asks on
 * its own, with a fresh touch. The rows are the runtime's own (read from
 * governance/promotion.ts), so the card and the table cannot drift apart.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';

const html = readFileSync(join(__dirname, '..', '..', 'console', 'index.html'), 'utf8');
const apprJs = /<script id="approvals-js">([\s\S]*?)<\/script>/.exec(html)![1]!;
const promotion = readFileSync(join(__dirname, '..', '..', 'runtime', 'src', 'governance', 'promotion.ts'), 'utf8');

/** A table's rows as the runtime declares them: `{ pattern: '...', dailyCap: n }`. */
function rowsOf(name: string): Array<{ pattern: string; dailyCap?: number }> {
  const body = new RegExp(`export const ${name}: [^=]+= \\[([\\s\\S]*?)\\n\\];`).exec(promotion)?.[1];
  if (!body) throw new Error(`no ${name} in promotion.ts`);
  return [...body.matchAll(/\{ pattern: '([^']+)'(?:, dailyCap: (\d+))? \}/g)].map((m) => ({ pattern: m[1]!, ...(m[2] ? { dailyCap: Number(m[2]) } : {}) }));
}

const noop = () => {};
const el = () => ({ appendChild: noop, classList: { add: noop, remove: noop, toggle: noop }, style: {}, setAttribute: noop });
// The panel's script polls the server as it loads: with no token there is nothing to ask.
const ctx: Record<string, unknown> = {
  console, setInterval: () => 0, setTimeout: () => 0, BASE: '', TOKEN: '', auth: () => ({}),
  fetch: async () => ({ ok: false, status: 401, json: async () => ({}) }),
  document: { getElementById: () => null, createElement: el, createTextNode: el, querySelectorAll: () => [] },
};
createContext(ctx);
runInContext(apprJs, ctx);
const run = (code: string) => runInContext(code, ctx);

const UNTIL = '2027-04-05T00:00:00.000Z';
/** The card as promotionTable files it and the server lists it. */
const card = (rows: Array<{ pattern: string; dailyCap?: number }>, templateId: string) => ({
  id: 'prp3', fullName: 'policy.change', kind: 'policy', origin: 'cli', templateId, tainted: false, destructive: false, consequential: true, sensitivity: 'ops',
  expiresAt: '2026-10-27T14:00:00.000Z', reason: 'This lets Flint review your goals and send its plan suggestions as cards without asking until Apr 5, 2027.',
  args: { rows: rows.map((r) => ({ ...r, tier: 'alone', reason: 'P3 promotion table, after the shadow week', expiresAt: UNTIL })) },
});
const say = (c: object) => ({
  title: run(`apprTitle(${JSON.stringify(c)})`) as string,
  sub: run(`apprSub(${JSON.stringify(c)})`) as string,
  facts: JSON.parse(JSON.stringify(run(`apprFacts(${JSON.stringify(c)})`))) as Array<[string, string]>,
  alone: run(`apprAlone(${JSON.stringify(c)})`) as boolean,
  prompt: run(`apprReason(${JSON.stringify(c)})`) as string,
});
const date = run(`apprDate('${UNTIL}')`) as string;

/** Title Case as the console writes it: every word capitalised but the short joining ones. */
const titleCase = (t: string) => t.split(' ').every((w, i) => /^[A-Z0-9]/.test(w) || (i > 0 && ['on', 'from', 'a', 'the', 'to', 'of', 'in', 'and'].includes(w)));
/** Nothing internal on screen: no action name, id, JSON, path or parenthesis. */
const plain = (t: string) => !/[(){}\[\]_/\\]|goal\.|plan\.|policy\.|p3c?\.|prp3|\balone\b/.test(t);

describe('P3’s promotion cards', () => {
  it('the reviews’ card: what signing lets happen, what Flint then does, and its limit', () => {
    const rows = rowsOf('P3_PROMOTIONS');
    expect(rows).toEqual([{ pattern: 'goal.review.local', dailyCap: 20 }]);
    const c = say(card(rows, 'p3.promotion'));
    expect(c.title).toBe('Let Goal Reviews Run on Their Own');
    expect(c.sub).toBe(`Until ${date}, Flint files its plan suggestions as cards you sign.`);
    expect(c.facts).toEqual([['Until', date], ['Limits', 'Review Your Goals 20 a Day'], ['Filed By', 'You']]);
    expect(c.alone).toBe(true);
    expect(c.prompt).toBe('approve: Let Goal Reviews Run on Their Own');
  });

  it('the later card, for suggestions from chat: its own title, sentence and limit', () => {
    const rows = rowsOf('P3C_PROMOTIONS');
    expect(rows).toEqual([{ pattern: 'goal.propose', dailyCap: 3 }]);
    const c = say(card(rows, 'p3c.promotion'));
    expect(c.title).toBe('Let Flint Suggest Goals from Chat');
    expect(c.sub).toBe(`Until ${date}, Flint adds goals it hears in chat to Suggested.`);
    expect(c.facts).toEqual([['Until', date], ['Limits', 'Suggest Goals from Chat 3 a Day'], ['Filed By', 'You']]);
    expect(c.alone).toBe(true);
  });

  it('every line is Will’s standard: Title Case titles and labels, one complete sentence under the title, nothing internal on screen', () => {
    for (const [name, template] of [['P3_PROMOTIONS', 'p3.promotion'], ['P3C_PROMOTIONS', 'p3c.promotion']] as const) {
      const c = say(card(rowsOf(name), template));
      expect(titleCase(c.title), c.title).toBe(true);
      expect(c.sub, c.sub).toMatch(/^[A-Z][^.!?]*\.$/);
      for (const [label, value] of c.facts) {
        expect(titleCase(label), label).toBe(true);
        expect(titleCase(value.replace(/ · /g, ' ')), value).toBe(true);
      }
      for (const text of [c.title, c.sub, ...c.facts.flat()]) expect(plain(text), text).toBe(true);
    }
  });

  it('the title follows the rows the card signs, never a label it carries', () => {
    const reviews = rowsOf('P3_PROMOTIONS');
    // The same rows under any template are the same card...
    expect(say(card(reviews, 'p2.promotion')).title).toBe('Let Goal Reviews Run on Their Own');
    // ...and a card that only says it is P3's, with other rows, is named for what it would really let run.
    const other = say(card([{ pattern: 'notify.push', dailyCap: 3 }], 'p3.promotion'));
    expect(other.title).toBe('Let 1 Action Run on Its Own');
    expect(other.sub).toBe(`It lasts until ${date}.`);
    const both = say(card([...reviews, { pattern: 'notify.push', dailyCap: 3 }], 'p3.promotion'));
    expect(both.title).toBe('Let 2 Actions Run on Their Own');
    expect(both.facts[1]).toEqual(['Limits', 'Review Your Goals 20 a Day · Notify Push 3 a Day']);
  });

  it('a card whose rows carry no date still reads as a sentence', () => {
    const c = card(rowsOf('P3_PROMOTIONS'), 'p3.promotion');
    c.args.rows = c.args.rows.map(({ expiresAt: _e, ...r }) => r) as typeof c.args.rows;
    expect(say(c).sub).toBe('Flint files its plan suggestions as cards you sign.');
  });

  it('no table of P3’s holds a signed goal or plan action', () => {
    const signed = ['goal.activate', 'goal.criteria_change', 'goal.horizon_change', 'goal.done', 'goal.abandon', 'plan.change', 'nexus.remember_goal_decision'];
    for (const name of ['P3_PROMOTIONS', 'P3C_PROMOTIONS']) for (const r of rowsOf(name)) expect(signed, name).not.toContain(r.pattern);
  });
});
