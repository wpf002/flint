/**
 * P3's promotion cards in the console's Approvals panel (apps/console/index.html,
 * <script id="approvals-js">), as Will reads them: a Title Case title that says
 * what signing lets happen, one complete sentence under it, three facts, and
 * never an action's internal name, an id, JSON or a parenthesis. Each asks on
 * its own, with a fresh touch. The rows are the runtime's own (read from
 * governance/promotion.ts), so the card and the table cannot drift apart.
 *
 * Show Details says each row Will would sign as a sentence ("Goal reviews may
 * run on their own, up to 20 a day, until Apr 5, 2027."), for every promotion
 * table and the backups' card alike: an approval card never looks like a JSON
 * file. Each sentence is held to the notes' own standard (@flint/policy
 * noteProblems).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { noteProblems } from '@flint/policy';

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
/** The lines Show Details adds under the card's reason: one sentence a row. */
const details = (c: object) => JSON.parse(JSON.stringify(run(`apprRulesSay(${JSON.stringify(c)})`))) as string[];
/** One row's sentence. */
const says = (row: object) => run(`apprRuleSays(${JSON.stringify(row)})`) as string;

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

  it('Show Details: each of the two cards says its row as a sentence, its limit and its last day', () => {
    expect(date).toBe('Apr 5, 2027');
    expect(details(card(rowsOf('P3_PROMOTIONS'), 'p3.promotion'))).toEqual(['Goal reviews may run on their own, up to 20 a day, until Apr 5, 2027.']);
    expect(details(card(rowsOf('P3C_PROMOTIONS'), 'p3c.promotion'))).toEqual(['Flint may add goals it hears in chat to Suggested on its own, up to 3 a day, until Apr 5, 2027.']);
  });

  it('a rule card’s details are built from sentences, never from its stored rows: only the other cards still show theirs', () => {
    // The card's renderer: a rule card's rows go through apprRulesSay, as text; the stored args are for every other card.
    expect(apprJs).toContain("if(p.fullName==='policy.change')apprRulesSay(p).forEach(function(t){det.appendChild(apprEl('p',null,t));});");
    expect(apprJs).toContain("else{var args='';try{args=JSON.stringify(p.args,null,1);}catch(e){args=String(p.args);}det.appendChild(apprEl('pre',null,args));}");
    expect(apprJs.match(/JSON\.stringify\(p\.args/g)).toHaveLength(1);
    // (test/console-approvals.test.ts opens a rule card in a DOM and reads its details.)
  });

  it('no table of P3’s holds a signed goal or plan action', () => {
    const signed = ['goal.activate', 'goal.criteria_change', 'goal.horizon_change', 'goal.done', 'goal.abandon', 'plan.change', 'nexus.remember_goal_decision'];
    for (const name of ['P3_PROMOTIONS', 'P3C_PROMOTIONS']) for (const r of rowsOf(name)) expect(signed, name).not.toContain(r.pattern);
  });
});

describe('Show Details on every rule card, old and new', () => {
  const TABLES = ['P1_PROMOTIONS', 'P2_PROMOTIONS', 'P25_PROMOTIONS', 'P26_PROMOTIONS', 'P3_PROMOTIONS', 'P3C_PROMOTIONS'] as const;
  const BACKUPS = [{ pattern: 'backup.local' }, { pattern: 'backup.offsite' }, { pattern: 'restore.drill' }];
  /** A sentence that fell back to a quoted name: the panel had no words of its own for the rule. */
  const fellBack = (t: string) => /[“”]/.test(t);

  it('every row of every promotion table, and the backups’ card, has its own sentence: no quoted fallback, no internal name, nothing shaped like JSON', () => {
    const seen = new Set<string>();
    for (const name of TABLES) {
      const rows = rowsOf(name);
      expect(rows.length, name).toBeGreaterThan(0);
      const lines = details(card(rows, 'x.promotion'));
      expect(lines, name).toHaveLength(rows.length);
      lines.forEach((line, i) => {
        const row = rows[i]!;
        expect(fellBack(line), `${name} ${row.pattern}: ${line}`).toBe(false);
        // The notes' own standard: a complete sentence, with no internal name, id, path, JSON or parenthesis.
        expect(noteProblems('Rule', line), line).toEqual([]);
        expect(plain(line), line).toBe(true);
        expect(line.endsWith(`${row.dailyCap ? `, up to ${row.dailyCap} a day, until` : / once a (day|night|week)$/.test(line.replace(/, until .*$/, '')) ? ', until' : ' until'} ${date}.`), line).toBe(true);
        seen.add(line);
      });
    }
    // Each rule reads differently: no two rows share a sentence.
    expect(seen.size).toBe(TABLES.reduce((n, t) => n + rowsOf(t).length, 0));
    const backups = details(card(BACKUPS, 'x'));
    expect(backups).toEqual([
      `The nightly backup may run on its own, once a day, until ${date}.`,
      `The offsite copy may be sent on its own, once a day, until ${date}.`,
      `The restore test may run on its own, once a week, until ${date}.`,
    ]);
    for (const line of backups) expect(noteProblems('Rule', line), line).toEqual([]);
  });

  it('reads as the tables are written: a few of them, word for word', () => {
    const one = (pattern: string, dailyCap?: number) => says({ pattern, tier: 'alone', ...(dailyCap ? { dailyCap } : {}), expiresAt: UNTIL });
    expect(one('world.sync.google_calendar')).toBe('Flint may read your Google Calendar on its own until Apr 5, 2027.');
    expect(one('world.person.create', 20)).toBe('Flint may add people from your calendar on its own, up to 20 a day, until Apr 5, 2027.');
    expect(one('notify.push', 3)).toBe('Flint may ping your phone on its own, up to 3 a day, until Apr 5, 2027.');
    expect(one('triage.rule')).toBe('Triage rules may run on their own until Apr 5, 2027.');
    expect(one('ledger_record_prediction', 10)).toBe('Chat may record a prediction on its own, up to 10 a day, until Apr 5, 2027.');
    expect(one('world_now')).toBe('Chat may check what’s happening now on its own until Apr 5, 2027.');
  });

  it('a rule this panel has no words for is still a sentence: named in quotes, a whole family as every action under its name', () => {
    expect(says({ pattern: 'some.new_action', tier: 'alone', dailyCap: 5, expiresAt: UNTIL })).toBe('“Some New Action” may run on its own, up to 5 a day, until Apr 5, 2027.');
    expect(says({ pattern: 'world.sync.*', tier: 'alone', expiresAt: UNTIL })).toBe('Every action under “World Sync” may run on its own until Apr 5, 2027.');
    // A row with no date, and a card with no rows.
    expect(says({ pattern: 'goal.review.local', tier: 'alone', dailyCap: 20 })).toBe('Goal reviews may run on their own, up to 20 a day.');
    expect(details({ fullName: 'policy.change', args: {} })).toEqual([]);
  });

  it('a rule that tightens says so: one that asks each time, and one that stops an action', () => {
    expect(says({ pattern: 'goal.review.local', tier: 'approval', expiresAt: UNTIL })).toBe('You approve “Review Your Goals” each time until Apr 5, 2027.');
    expect(says({ pattern: 'notify.push', tier: 'forbidden', dailyCap: 3, expiresAt: UNTIL })).toBe('Flint may not run “Notify Push” until Apr 5, 2027.');
    expect(says({ pattern: 'world.sync.*', tier: 'forbidden' })).toBe('Flint may not run any action under “World Sync”.');
  });

  it('a scoped rule says what it covers, as a list in a sentence, never as the object', () => {
    const scoped = card([{ pattern: 'world.sync.git' }], 'x');
    (scoped.args.rows[0] as Record<string, unknown>).scope = { endpoints: ['github', 'gitlab'] };
    expect(details(scoped)).toEqual([`Flint may read your repos on its own until ${date}.`, 'It covers only these endpoints: github, gitlab.']);
    (scoped.args.rows[0] as Record<string, unknown>).scope = { series: { nested: true } };
    expect(details(scoped)[1]).toBe('It covers only part of what it names.');
    for (const line of details(scoped)) expect(line).not.toMatch(/[{}\[\]"]/);
  });
});

