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
import { laterDay, pinLocale, shownDay } from './console-dates';

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
pinLocale(ctx);
runInContext(apprJs, ctx);
const run = (code: string) => runInContext(code, ctx);

/** The rows' last day: a date the console writes with its year, whenever this runs. */
const UNTIL = laterDay(4, 5);
/**
 * The card as promotionTable files it, and as a server that sends no mark lists it: `consequential` is left off on
 * purpose. What makes such a card ask on its own here is what it would sign (a row that lets something run alone),
 * so an assertion that it does cannot pass on the flag.
 */
const card = (rows: Array<{ pattern: string; dailyCap?: number; tier?: string }>, templateId: string) => ({
  id: 'prp3', fullName: 'policy.change', kind: 'policy', origin: 'cli', templateId, tainted: false, destructive: false, sensitivity: 'ops',
  expiresAt: '2026-10-27T14:00:00.000Z', reason: `This lets Flint review your goals and send its plan suggestions as cards without asking until ${date}.`,
  args: { rows: rows.map((r) => ({ tier: 'alone', ...r, reason: 'P3 promotion table, after the shadow week', expiresAt: UNTIL })) },
});
const say = (c: object) => ({
  title: run(`apprTitle(${JSON.stringify(c)})`) as string,
  sub: run(`apprSub(${JSON.stringify(c)})`) as string,
  facts: JSON.parse(JSON.stringify(run(`apprFacts(${JSON.stringify(c)})`))) as Array<[string, string]>,
  alone: run(`apprAlone(${JSON.stringify(c)})`) as boolean,
  prompt: run(`apprReason(${JSON.stringify(c)})`) as string,
});
/** ...as the console shows it ("Apr 5, 2028"), worked out here and not read back from the console. */
const date = shownDay(4, 5);
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
    expect(c.facts).toEqual([['Until', date], ['Limits', 'Goal Reviews 20 a Day'], ['Filed By', 'You']]);
    expect(c.alone).toBe(true);
    expect(c.prompt).toBe('approve: Let Goal Reviews Run on Their Own');
  });

  it('the later card, for suggestions from chat: its own title, sentence and limit', () => {
    // Both rows (part 5 added the commitments): goals Flint hears land in Suggested, and what Will says he'll do lands unconfirmed.
    const rows = rowsOf('P3C_PROMOTIONS');
    expect(rows).toEqual([{ pattern: 'goal.propose', dailyCap: 3 }, { pattern: 'world.commitment.from_chat', dailyCap: 10 }]);
    const c = say(card(rows, 'p3c.promotion'));
    expect(c.title).toBe('Let Flint Take Goals and Commitments from Chat');
    expect(c.sub).toBe(`Until ${date}, Flint adds goals it hears in chat to Suggested, and the things you say you’ll do as unconfirmed commitments.`);
    expect(c.facts).toEqual([['Until', date], ['Limits', 'Goal Suggestions from Chat 3 a Day · Commitments from Chat 10 a Day'], ['Filed By', 'You']]);
    expect(c.alone).toBe(true);
    // In either order it is the same card; each row alone has its own title and sentence.
    expect(say(card([...rows].reverse(), 'p3c.promotion')).title).toBe('Let Flint Take Goals and Commitments from Chat');
    const goals = say(card([rows[0]!], 'p3c.promotion'));
    expect([goals.title, goals.sub]).toEqual(['Let Flint Suggest Goals from Chat', `Until ${date}, Flint adds goals it hears in chat to Suggested.`]);
    const commitments = say(card([rows[1]!], 'p3c.promotion'));
    expect([commitments.title, commitments.sub]).toEqual(['Let Flint Add Commitments from Chat', `Until ${date}, Flint adds the things you say you’ll do in chat, unconfirmed.`]);
    expect(commitments.facts[1]).toEqual(['Limits', 'Commitments from Chat 10 a Day']);
    // With anything else beside them it is named for what it would let run, never for chat's table.
    expect(say(card([...rows, { pattern: 'notify.push', dailyCap: 3 }], 'p3c.promotion')).title).toBe('Let 3 Actions Run on Their Own');
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
    expect(both.facts[1]).toEqual(['Limits', 'Goal Reviews 20 a Day · Phone Pings 3 a Day']);
  });

  it('a card whose rows carry no date still reads as a sentence', () => {
    const c = card(rowsOf('P3_PROMOTIONS'), 'p3.promotion');
    c.args.rows = c.args.rows.map(({ expiresAt: _e, ...r }) => r) as typeof c.args.rows;
    expect(say(c).sub).toBe('Flint files its plan suggestions as cards you sign.');
  });

  it('Show Details: each of the two cards says its row as a sentence, its limit and its last day', () => {
    expect(run(`apprDate('${UNTIL}')`)).toBe(date);
    expect(details(card(rowsOf('P3_PROMOTIONS'), 'p3.promotion'))).toEqual([`Goal reviews may run on their own, up to 20 a day, until ${date}.`]);
    expect(details(card(rowsOf('P3C_PROMOTIONS'), 'p3c.promotion'))).toEqual([
      `Goal suggestions from chat may be filed on their own, up to 3 a day, until ${date}.`,
      `Commitments from chat may be added on their own, up to 10 a day, until ${date}.`,
    ]);
  });

  it('no card’s details are built from its stored args: the panel and the chat card both go through apprDetails, and nothing prints the args', () => {
    expect(apprJs).toContain('apprDetailsInto(det,p);');
    expect(apprJs).not.toMatch(/JSON\.stringify\(/);
    expect(apprJs).not.toMatch(/apprEl\('pre'/);
    // The card in a chat: the same lines, and no stored args either.
    const chatCard = /\nfunction renderProposals\([\s\S]*?\n\/\* -{10} Will.s approval key/.exec(html)![0];
    expect(chatCard).toContain("var pargs=el('div','pargs');if(typeof apprDetailsInto==='function')apprDetailsInto(pargs,a);card.appendChild(pargs);");
    expect(chatCard).not.toMatch(/JSON\.stringify/);
    // What is signed is untouched: both hand the stored args to the signed path, which checks their digest.
    expect(apprJs).toContain('approveAction(p.id,card,{reason:apprReason(p),fresh:apprAlone(p),args:p.args})');
    expect(chatCard).toContain("approveAction(a.id,card,{reason:'approve: '+title,fresh:typeof apprAlone==='function'?apprAlone(a):true,args:a.args});");
    // (test/console-card-details.test.ts opens every kind of card in a DOM and reads what it shows.)
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
      `The backup may run on its own, once a day, until ${date}.`,
      `The offsite copy may be sent on its own, once a day, until ${date}.`,
      `The restore test may run on its own, once a week, until ${date}.`,
    ]);
    for (const line of backups) expect(noteProblems('Rule', line), line).toEqual([]);
  });

  it('one name for each rule: the Limits fact says it, and the details’ sentence is built from it, so the two cannot drift', () => {
    const tool = (pattern: string) => run(`!!APPR_TOOLS['runtime.'+${JSON.stringify(pattern)}]`) as boolean;
    const BACKUP_LIMITS: Record<string, string> = { 'backup.local': 'Backup 1 a Day', 'backup.offsite': 'Offsite Copy 1 a Day', 'restore.drill': 'Restore Test 1 a Week' };
    for (const row of [...TABLES.flatMap((t) => rowsOf(t)), ...BACKUPS] as Array<{ pattern: string; dailyCap?: number }>) {
      const words = run(`apprRuleWords(${JSON.stringify(row.pattern)})`) as string;
      const limit = run(`apprLimitSays(${JSON.stringify(row)})`) as string;
      // The name is the panel's own, never spelled out of the action's internal name, and it is a Title Case title by the notes' standard.
      expect(words, row.pattern).not.toBe(run(`apprWords(${JSON.stringify(row.pattern)})`));
      // (Chat's tools keep the titles they share with the notes, @flint/policy's ACTION_WORDS: "Look Up One Item" is a verb with its "Up".)
      expect(noteProblems(limit, '').filter((why) => !(tool(row.pattern) && why.includes('Title Case'))), limit).toEqual([]);
      expect(plain(limit), limit).toBe(true);
      expect(limit).toBe(BACKUP_LIMITS[row.pattern] ?? `${words}${row.dailyCap ? ` ${row.dailyCap} a Day` : ''}`);
      // The sentence says those very words.
      expect(says({ ...row, tier: 'alone', expiresAt: UNTIL }).toLowerCase(), row.pattern).toContain(words.toLowerCase());
    }
    // The table holds a name and how it reads, never a second wording of the sentence.
    const table = /\nvar APPR_RULES=\{([\s\S]*?)\};\n/.exec(apprJs)![1]!;
    expect(table).not.toMatch(/may |on its own|on their own/);
    // Over 6 rules, the fact counts them instead of listing them.
    const p2 = say(card(rowsOf('P2_PROMOTIONS'), 'p2.promotion'));
    expect(p2.facts).toEqual([['Until', date], ['Limits', '15 actions, listed under Show Details.'], ['Filed By', 'You']]);
    expect(noteProblems('Limits', p2.facts[1]![1])).toEqual([]);
    const p1 = say(card(rowsOf('P1_PROMOTIONS'), 'p1.promotion'));
    expect(p1.facts[1]).toEqual(['Limits', 'Check What’s Happening Now · Look Up One Item · Read Open Predictions · Check Prediction Accuracy · Record a Prediction 10 a Day']);
  });

  it('reads as the tables are written: a few of them, word for word', () => {
    const one = (pattern: string, dailyCap?: number) => says({ pattern, tier: 'alone', ...(dailyCap ? { dailyCap } : {}), expiresAt: UNTIL });
    expect(one('goal.review.local', 20)).toBe(`Goal reviews may run on their own, up to 20 a day, until ${date}.`);
    expect(one('world.sync.google_calendar')).toBe(`Google Calendar reads may run on their own until ${date}.`);
    expect(one('world.person.create', 20)).toBe(`People from your calendar may be added on their own, up to 20 a day, until ${date}.`);
    expect(one('notify.push', 3)).toBe(`Phone pings may be sent on their own, up to 3 a day, until ${date}.`);
    expect(one('notify.inapp')).toBe(`In-app notes may be posted on their own until ${date}.`);
    expect(one('world.sync.nexus_inbox')).toBe(`The Nexus inbox may be read on its own until ${date}.`);
    expect(one('triage.local_model')).toBe(`Local model triage may run on its own until ${date}.`);
    expect(one('digest.daily')).toBe(`The daily summary may be sent on its own until ${date}.`);
    expect(one('ledger_record_prediction', 10)).toBe(`Chat may record a prediction on its own, up to 10 a day, until ${date}.`);
    expect(one('world_now')).toBe(`Chat may check what’s happening now on its own until ${date}.`);
  });

  it('a rule this panel has no words for is still a sentence: named in quotes, a whole family as every action under its name', () => {
    expect(says({ pattern: 'some.new_action', tier: 'alone', dailyCap: 5, expiresAt: UNTIL })).toBe(`“Some New Action” may run on its own, up to 5 a day, until ${date}.`);
    expect(says({ pattern: 'world.sync.*', tier: 'alone', expiresAt: UNTIL })).toBe(`Every action under “World Sync” may run on its own until ${date}.`);
    // A row with no date, and a card with no rows.
    expect(says({ pattern: 'goal.review.local', tier: 'alone', dailyCap: 20 })).toBe('Goal reviews may run on their own, up to 20 a day.');
    expect(details({ fullName: 'policy.change', kind: 'policy', args: {} })).toEqual([]);
  });

  it('a rule that tightens says so: one that asks each time, and one that stops an action', () => {
    expect(says({ pattern: 'goal.review.local', tier: 'approval', expiresAt: UNTIL })).toBe(`You approve “Goal Reviews” each time until ${date}.`);
    expect(says({ pattern: 'notify.push', tier: 'forbidden', dailyCap: 3, expiresAt: UNTIL })).toBe(`Flint may not run “Phone Pings” until ${date}.`);
    expect(says({ pattern: 'world.sync.*', tier: 'forbidden' })).toBe('Flint may not run any action under “World Sync”.');
  });

  it('a scoped rule says what it covers, as a list in a sentence, never as the object', () => {
    const scoped = card([{ pattern: 'world.sync.git' }], 'x');
    (scoped.args.rows[0] as Record<string, unknown>).scope = { endpoints: ['github', 'gitlab'] };
    expect(details(scoped)).toEqual([`Repo reads may run on their own until ${date}.`, 'It covers only these endpoints: GitHub, GitLab.']);
    (scoped.args.rows[0] as Record<string, unknown>).scope = { series: { nested: true } };
    expect(details(scoped)[1]).toBe('It covers only part of what it names, listed below.');
    for (const line of details(scoped)) expect(line).not.toMatch(/[{}\[\]"]/);
  });
});

describe('a rule card says what its rows do: the title, the line under it and the facts follow each row’s tier', () => {
  const LETS = /Let .* Run on (Its|Their) Own|Run Backups on Their Own|Let Flint Suggest/;

  it('a row that stops an action is never titled as letting it run, whichever rule it names', () => {
    for (const pattern of ['goal.review.local', 'goal.propose', 'notify.push', 'backup.local', 'some.new_action']) {
      const c = say(card([{ pattern, dailyCap: 20, tier: 'forbidden' }], 'p3.promotion'));
      expect(c.title, pattern).toBe('Stop 1 Action');
      expect(c.title, pattern).not.toMatch(LETS);
      expect(c.sub, pattern).toBe(`Until ${date}, Flint may not run it.`);
      expect(c.facts[0], pattern).toEqual(['Until', date]);
      expect(c.facts[1]![0], pattern).toBe('Stopped');
      // The rule by its name, and no limit: nothing runs to be limited.
      expect(c.facts[1]![1], pattern).toBe(run(`apprRuleWords(${JSON.stringify(pattern)})`));
      expect(c.facts[1]![1], pattern).not.toMatch(/a Day|a Week/);
      for (const text of [c.title, c.sub, ...c.facts.flat()]) expect(text, pattern).not.toMatch(/on (its|their) own/i);
    }
    const two = say(card([{ pattern: 'goal.review.local', tier: 'forbidden' }, { pattern: 'notify.push', tier: 'forbidden' }], 'x'));
    expect([two.title, two.sub, two.facts[1]]).toEqual(['Stop 2 Actions', `Until ${date}, Flint may not run them.`, ['Stopped', 'Goal Reviews · Phone Pings']]);
  });

  it('a row that makes Flint ask each time says that', () => {
    const one = say(card([{ pattern: 'goal.review.local', dailyCap: 20, tier: 'approval' }], 'p3.promotion'));
    expect([one.title, one.sub]).toEqual(['Ask Before 1 Action', `Until ${date}, Flint asks you each time.`]);
    expect(one.facts).toEqual([['Until', date], ['Asks First', 'Goal Reviews'], ['Filed By', 'You']]);
    expect(one.title).not.toMatch(LETS);
    const three = say(card(rowsOf('P25_PROMOTIONS').map((r) => ({ ...r, tier: 'approval' })), 'x'));
    expect(three.title).toBe(`Ask Before ${rowsOf('P25_PROMOTIONS').length} Actions`);
    // With no date the line is still a sentence.
    const undated = card([{ pattern: 'notify.push', tier: 'approval' }], 'x');
    undated.args.rows = undated.args.rows.map(({ expiresAt: _e, ...r }) => r) as typeof undated.args.rows;
    expect(say(undated).sub).toBe('Flint asks you each time.');
    const stopped = card([{ pattern: 'notify.push', tier: 'forbidden' }], 'x');
    stopped.args.rows = stopped.args.rows.map(({ expiresAt: _e, ...r }) => r) as typeof stopped.args.rows;
    expect(say(stopped).sub).toBe('Flint may not run it.');
  });

  it('rows that do not all do the same, or say nothing this panel knows, are a change of rules: never "Let ... Run"', () => {
    const mixed = say(card([{ pattern: 'goal.review.local', dailyCap: 20 }, { pattern: 'notify.push', dailyCap: 3, tier: 'forbidden' }], 'p3.promotion'));
    expect(mixed.title).toBe('Change 2 Rules');
    expect(mixed.sub).toBe(`It lasts until ${date}.`);
    // Each rule by name; only the one that runs has a limit.
    expect(mixed.facts[1]).toEqual(['Rules', 'Goal Reviews 20 a Day · Phone Pings']);
    for (const tier of [undefined, 'ALONE', 'auto', '', null, 7]) {
      const c = say({ fullName: 'policy.change', kind: 'policy', origin: 'cli', args: { rows: [{ pattern: 'goal.review.local', tier, expiresAt: UNTIL }] } });
      expect(c.title, String(tier)).toBe('Change 1 Rule');
      expect(c.title, String(tier)).not.toMatch(LETS);
      // Nor does the line under it say what a promotion would: it is not known to be one.
      expect(c.sub, String(tier)).toBe(`It lasts until ${date}.`);
      expect(c.facts[1]![0], String(tier)).toBe('Rules');
    }
    // No rows at all, or rows that are not a list.
    expect(say({ fullName: 'policy.change', kind: 'policy', origin: 'cli', args: {} }).title).toBe('Change 0 Rules');
    expect(say({ fullName: 'policy.change', kind: 'policy', origin: 'cli', args: { rows: 'goal.review.local' } }).title).toBe('Change 0 Rules');
  });

  it('every title, line and label of these cards is Will’s standard', () => {
    for (const tier of ['alone', 'approval', 'forbidden']) {
      for (const rows of [[{ pattern: 'goal.review.local', dailyCap: 20, tier }], [{ pattern: 'goal.review.local', tier }, { pattern: 'notify.push', dailyCap: 3, tier }]]) {
        const c = say(card(rows, 'x'));
        expect(titleCase(c.title), c.title).toBe(true);
        expect(c.sub, c.sub).toMatch(/^[A-Z][^.!?]*\.$/);
        for (const [label, value] of c.facts) {
          expect(titleCase(label), label).toBe(true);
          expect(noteProblems(label, ''), label).toEqual([]);
          expect(plain(value), value).toBe(true);
        }
        expect(noteProblems(c.title, c.sub), `${c.title} / ${c.sub}`).toEqual([]);
      }
    }
  });
});

describe('a card can name anything: every table is read by its own entries only', () => {
  const ODD = ['constructor', 'toString', 'hasOwnProperty', '__proto__', 'valueOf', 'prototype'];

  it('a rule named for something every object has is an unknown rule, named in quotes', () => {
    const c = say(card([{ pattern: 'constructor', dailyCap: 5 }], 'p3.promotion'));
    expect(c.title).toBe('Let 1 Action Run on Its Own');
    expect(c.sub).toBe(`It lasts until ${date}.`);
    expect(c.facts).toEqual([['Until', date], ['Limits', 'Constructor 5 a Day'], ['Filed By', 'You']]);
    expect(details(card([{ pattern: 'constructor', dailyCap: 5 }], 'x'))).toEqual([`“Constructor” may run on its own, up to 5 a day, until ${date}.`]);
    // The sentence names it in words; DETAILS gives the action exactly as it is stored, never as words of its own.
    const listed = JSON.parse(JSON.stringify(run(`apprDetails(${JSON.stringify(card([{ pattern: 'constructor' }, { pattern: 'in_progress' }], 'x'))})`))) as { facts: Array<[string, string]> };
    expect(listed.facts).toEqual(expect.arrayContaining([['Rule 1 Action', 'constructor'], ['Rule 2 Action', 'in_progress']]));
    for (const pattern of ODD) {
      const one = say(card([{ pattern }], 'x'));
      const lines = details(card([{ pattern }], 'x'));
      for (const text of [one.title, one.sub, ...one.facts.flat(), ...lines]) {
        expect(text, pattern).not.toMatch(/undefined|function|native code|\[object/);
      }
      expect(lines[0], pattern).toMatch(/^“[^”]+” may run on its own until /);
      expect(run(`apprRule(${JSON.stringify(pattern)})`), pattern).toBeNull();
      expect(run(`apprPromotes([{pattern:${JSON.stringify(pattern)}}])`), pattern).toBeNull();
    }
  });

  it('and so is a card, a source, a calendar or a step’s status named that way: the panel’s plain fallback, never a table’s insides', () => {
    for (const name of ODD) {
      const c = say({ id: 'x1', fullName: name, origin: 'runtime:x', args: {} });
      expect(c.title, name).toBe(`Approve ${run(`apprWords(${JSON.stringify(name)})`)}`);
      expect(c.sub, name).toBe('Flint filed this.');
      expect(c.alone, name).toBe(false);
      expect(c.prompt, name).toBe(`approve: ${c.title}`);
      expect(run(`apprIcon(${JSON.stringify({ fullName: name, args: {} })})`), name).toBe('bolt');
      expect(run(`apprWhen(${JSON.stringify(name)})`), name).toBe('');
      expect(say({ fullName: 'world.source.enable', kind: 'tool_call', origin: 'cli', args: { source: name } }).sub, name).toBe('Flint starts reading this source.');
      expect(say({ fullName: 'world.person.create', kind: 'tool_call', origin: 'runtime:x', args: { people: [], source: name } }).sub, name).toBe('They’re from events you accepted or organized.');
      // A status the panel has no words for is not called "not started": the sentence says it changes, and the card lists to what.
      expect(run(`apprOpSays(${JSON.stringify({ op: 'set', from: { title: 'Ship it' }, to: { status: name } })})`), name).toBe('Change the status of “Ship it”.');
      expect(run(`apprGet(APPR_RULES,${JSON.stringify(name)})`), name).toBeUndefined();
    }
    // The guard is one function, and no table a card indexes is read any other way.
    const reads = apprJs.match(/\bAPPR_(PROMOTES|NIGHTLY|GOAL|GOAL_WORDS|SOURCES|CALENDARS|TOOLS|STEP_WORDS|RULES)\[/g) ?? [];
    expect(reads).toEqual([]);
    expect(apprJs).toContain("function apprGet(table,key){key=String(key===null||key===undefined?'':key);return Object.prototype.hasOwnProperty.call(table,key)?table[key]:undefined;}");
  });
});

describe('every rule the panel has words for', () => {
  const SENTENCES: Record<string, string> = {
    'goal.review.local': 'Goal reviews may run on their own',
    'goal.propose': 'Goal suggestions from chat may be filed on their own',
    'world.commitment.from_chat': 'Commitments from chat may be added on their own',
    'world.sync.google_calendar': 'Google Calendar reads may run on their own',
    'world.sync.apple_calendar': 'Apple Calendar reads may run on their own',
    'world.person.create': 'People from your calendar may be added on their own',
    'world.sync.deploy': 'Deploy results may be read on their own',
    'world.sync.knowledge': 'New memory facts may be read on their own',
    'world.sync.nexus_inbox': 'The Nexus inbox may be read on its own',
    'world.sync.launchd': 'Background services may be checked on their own',
    'world.sync.health': 'Service checks may run on their own',
    'world.sync.git': 'Repo reads may run on their own',
    'world.sync.spend': 'Spend checks may run on their own',
    'triage.rule': 'Triage rules may run on their own',
    'triage.local_model': 'Local model triage may run on its own',
    'notify.inapp': 'In-app notes may be posted on their own',
    'notify.banner': 'Banners may be shown on their own',
    'notify.push': 'Phone pings may be sent on their own',
    'health.check': 'Health checks may run on their own',
    'health.report': 'Health reports may be sent on their own',
    'digest.daily': 'The daily summary may be sent on its own',
    'maintenance.retention': 'The nightly cleanup may run on its own',
    'backup.local': 'The backup may run on its own, once a day',
    'backup.offsite': 'The offsite copy may be sent on its own, once a day',
    'restore.drill': 'The restore test may run on its own, once a week',
    'backup.prune': 'The backup cleanup may run on its own, once a day',
    'backup.nexus': 'The Nexus backup may run on its own, once a day',
    'backup.nexus.offsite': 'The Nexus offsite copy may be sent on its own, once a day',
    'restore.drill.nexus': 'The Nexus restore test may run on its own, once a week',
  };

  it('has its sentence, word for word: all of them, not only the ones a promotion table holds', () => {
    const known = JSON.parse(JSON.stringify(run('Object.keys(APPR_RULES)'))) as string[];
    expect([...known].sort()).toEqual(Object.keys(SENTENCES).sort());
    for (const pattern of known) {
      const line = says({ pattern, tier: 'alone', expiresAt: UNTIL });
      expect(line, pattern).toBe(`${SENTENCES[pattern]}${SENTENCES[pattern]!.includes(', once a ') ? ',' : ''} until ${date}.`);
      expect(noteProblems('Rule', line), line).toEqual([]);
      expect(plain(line), line).toBe(true);
      // With no last day it still ends as a sentence.
      expect(says({ pattern, tier: 'alone' }), pattern).toBe(`${SENTENCES[pattern]}.`);
    }
  });

  it('each of chat’s tools reads "Chat may ... on its own"', () => {
    const tools = (JSON.parse(JSON.stringify(run('Object.keys(APPR_TOOLS)'))) as string[]).map((k) => k.replace(/^runtime\./, ''));
    expect(tools.length).toBeGreaterThan(4);
    const seen = new Set<string>();
    for (const pattern of tools) {
      const line = says({ pattern, tier: 'alone', dailyCap: 10, expiresAt: UNTIL });
      expect(line, pattern).toMatch(/^Chat may [a-z][^.]* on its own, up to 10 a day, until /);
      expect(noteProblems('Rule', line), line).toEqual([]);
      seen.add(line);
    }
    expect(seen.size).toBe(tools.length);
  });

  it('a limit of none a day is a limit: it is said in the fact and in the sentence, never left out', () => {
    const row = { pattern: 'goal.review.local', tier: 'alone', dailyCap: 0, expiresAt: UNTIL };
    expect(run(`apprLimitSays(${JSON.stringify(row)})`)).toBe('Goal Reviews 0 a Day');
    expect(says(row)).toBe(`Goal reviews may run on their own, up to 0 a day, until ${date}.`);
    expect(say(card([{ pattern: 'goal.review.local', dailyCap: 0 }], 'x')).facts[1]).toEqual(['Limits', 'Goal Reviews 0 a Day']);
    // Only a number is a limit; and a job that has its own keeps it.
    expect(run(`apprLimitSays(${JSON.stringify({ pattern: 'goal.review.local', tier: 'alone', dailyCap: '20' })})`)).toBe('Goal Reviews');
    expect(run(`apprLimitSays(${JSON.stringify({ pattern: 'goal.review.local', tier: 'alone', dailyCap: null })})`)).toBe('Goal Reviews');
    expect(run(`apprLimitSays(${JSON.stringify({ pattern: 'backup.local', tier: 'alone', dailyCap: 0 })})`)).toBe('Backup 1 a Day');
    expect(says({ pattern: 'backup.local', tier: 'alone', dailyCap: 0 })).toBe('The backup may run on its own, once a day.');
    // A row that asks, or stops, says no limit in its sentence either.
    expect(says({ pattern: 'goal.review.local', tier: 'approval', dailyCap: 20 })).toBe('You approve “Goal Reviews” each time.');
    expect(says({ pattern: 'backup.local', tier: 'forbidden', dailyCap: 2 })).toBe('Flint may not run “Backup”.');
  });
});

describe('a scoped rule: what it covers', () => {
  /** A one-rule card with this scope: what it says, and what it lists below. */
  const scoped = (scope: unknown) => {
    const c = card([{ pattern: 'world.sync.git' }], 'x');
    (c.args.rows[0] as Record<string, unknown>).scope = scope;
    const d = JSON.parse(JSON.stringify(run(`apprDetails(${JSON.stringify(c)})`))) as { says: string[]; facts: Array<[string, string]>; refs: Array<[string, string]> };
    // (The row's own sentence comes first, and its reason is always listed.)
    return { says: d.says.slice(1), facts: d.facts.filter(([label]) => label !== 'Rule 1 Reason'), refs: d.refs };
  };

  it('a list of plain words is said in a sentence, each as it is written', () => {
    expect(scoped({ endpoints: ['github', 'gitlab'] })).toEqual({ says: ['It covers only these endpoints: GitHub, GitLab.'], facts: [], refs: [] });
    expect(scoped({ source_kinds: ['google_calendar', 'in_progress'] }).says).toEqual(['It covers only these source kinds: Google Calendar, In Progress.']);
    expect(scoped({ calendars: ['Work', 'Family'], days: [1, 5] }).says).toEqual(['It covers only these calendars: Work, Family.', 'It covers only these days: 1, 5.']);
    // A link and a path are whole: they are what the rule covers.
    expect(scoped({ sites: ['https://example.com/a/b?x=1', '/Users/will/notes/Plan.md'] }).says).toEqual(['It covers only these sites: https://example.com/a/b?x=1, /Users/will/notes/Plan.md.']);
    // Eleven are eleven: no list is cut.
    const many = Array.from({ length: 11 }, (_, i) => `Calendar ${i + 1}`);
    expect(scoped({ calendars: many }).says).toEqual([`It covers only these calendars: ${many.join(', ')}.`]);
  });

  it('anything else it names is not summed up: the row says it is listed below, once, and it is, with each id exactly', () => {
    const ID = 'cmg1x9k2p0001abcd2345wxyz';
    expect(scoped({ calendarIds: ['Work', ID] })).toEqual({ says: ['It covers only part of what it names, listed below.'], facts: [], refs: [['Rule 1 Scope Calendar IDs', `Work, ${ID}`]] });
    expect(scoped({ series: { nested: true } })).toEqual({ says: ['It covers only part of what it names, listed below.'], facts: [['Rule 1 Scope Series Nested', 'Yes']], refs: [] });
    expect(scoped({ items: [] })).toEqual({ says: ['It covers only part of what it names, listed below.'], facts: [['Rule 1 Scope Items', 'None']], refs: [] });
    expect(scoped({ items: [{ id: ID, name: 'One' }] })).toEqual({ says: ['It covers only part of what it names, listed below.'], facts: [['Rule 1 Scope Items 1 Name', 'One']], refs: [['Rule 1 Scope Items 1 ID', ID]] });
    // Text that cannot sit in a sentence as written (a comma of its own, a quotation mark) is listed whole instead.
    expect(scoped({ names: ['Lovelace, Ada', 'Grace'] })).toEqual({ says: ['It covers only part of what it names, listed below.'], facts: [['Rule 1 Scope Names 1', 'Lovelace, Ada'], ['Rule 1 Scope Names 2', 'Grace']], refs: [] });
    // Several such parts in one scope: the sentence is said once, never twice in a row.
    expect(scoped({ calendars: ['Work'], calendarIds: [ID], repoIds: [ID], nested: { a: 1 } }).says).toEqual(['It covers only these calendars: Work.', 'It covers only part of what it names, listed below.']);
    for (const none of [null, undefined, 'calendars', 7, ['Work']]) expect(scoped(none).says, JSON.stringify(none)).toEqual([]);
  });

  it('the "listed below" line is one a row at most; two rows that read alike are still two rows, each with its sentence', () => {
    const ID = 'cmg1x9k2p0001abcd2345wxyz';
    const c = card([{ pattern: 'world.sync.git' }, { pattern: 'world.sync.git' }], 'x');
    for (const row of c.args.rows as Array<Record<string, unknown>>) row.scope = { repoIds: [ID], entityIds: [ID] };
    const d = JSON.parse(JSON.stringify(run(`apprDetails(${JSON.stringify(c)})`))) as { says: string[]; refs: Array<[string, string]> };
    // Nothing signed goes unsaid because it was said before: Will signs both rows.
    expect(d.says).toEqual([
      `Repo reads may run on their own until ${date}.`, 'It covers only part of what it names, listed below.',
      `Repo reads may run on their own until ${date}.`, 'It covers only part of what it names, listed below.',
    ]);
    expect(d.refs).toEqual([['Rule 1 Scope Repo IDs', ID], ['Rule 1 Scope Entity IDs', ID], ['Rule 2 Scope Repo IDs', ID], ['Rule 2 Scope Entity IDs', ID]]);
    expect(say(c).title).toBe('Let 2 Actions Run on Their Own');
  });

  it('every such line is a sentence by the notes’ standard', () => {
    const ID = 'cmg1x9k2p0001abcd2345wxyz';
    const lines = [...scoped({ endpoints: ['github', 'gitlab'] }).says, ...scoped({ source_kinds: ['google_calendar'] }).says, ...scoped({ calendarIds: [ID] }).says, ...scoped({ calendars: ['Work'], nested: { a: 1 } }).says];
    expect(lines).toHaveLength(5);
    for (const line of lines) expect(noteProblems('Rule', line), line).toEqual([]);
  });
});

describe('a row for a whole family of actions is every action under it, never one action', () => {
  it('in the title, the Limits fact and the sentence', () => {
    const one = say(card([{ pattern: 'world.sync.*' }], 'x'));
    expect(one.title).toBe('Let Every World Sync Action Run on Its Own');
    expect(one.facts[1]).toEqual(['Limits', 'Every World Sync Action']);
    expect(details(card([{ pattern: 'world.sync.*', dailyCap: 5 }], 'x'))).toEqual([`Every action under “World Sync” may run on its own, up to 5 a day, until ${date}.`]);
    expect(say(card([{ pattern: 'world.sync.*', dailyCap: 5 }], 'x')).facts[1]).toEqual(['Limits', 'Every World Sync Action 5 a Day']);
    // With other rows it is a group beside them, not one more action.
    expect(say(card([{ pattern: 'goal.review.local' }, { pattern: 'world.sync.*' }], 'x')).title).toBe('Let 1 Action and 1 Group of Actions Run on Their Own');
    expect(say(card([{ pattern: 'goal.review.local' }, { pattern: 'notify.push' }, { pattern: 'world.sync.*' }, { pattern: 'mcp:github.*' }], 'x')).title).toBe('Let 2 Actions and 2 Groups of Actions Run on Their Own');
    expect(say(card([{ pattern: 'world.sync.*' }, { pattern: 'mcp:github.*' }], 'x')).title).toBe('Let 2 Groups of Actions Run on Their Own');
    // Stopping one, and asking before one.
    expect(say(card([{ pattern: 'world.sync.*', tier: 'forbidden' }], 'x')).title).toBe('Stop Every World Sync Action');
    expect(say(card([{ pattern: 'mcp:github.*', tier: 'approval' }], 'x')).title).toBe('Ask Before Every MCP GitHub Action');
    expect(say(card([{ pattern: 'notify.push', tier: 'forbidden' }, { pattern: 'world.sync.*', tier: 'forbidden' }], 'x')).title).toBe('Stop 1 Action and 1 Group of Actions');
    for (const rows of [[{ pattern: 'world.sync.*' }], [{ pattern: 'goal.review.local' }, { pattern: 'world.sync.*' }], [{ pattern: 'world.sync.*', tier: 'forbidden' }]]) {
      const c = say(card(rows, 'x'));
      expect(titleCase(c.title), c.title).toBe(true);
      expect(noteProblems(c.title, c.sub), c.title).toEqual([]);
    }
    // The family's own pattern is listed as it is written, since the panel has no words of its own for it.
    const d = JSON.parse(JSON.stringify(run(`apprDetails(${JSON.stringify(card([{ pattern: 'world.sync.*' }], 'x'))})`))) as { facts: Array<[string, string]> };
    expect(d.facts).toContainEqual(['Rule 1 Action', 'world.sync.*']);
  });
});

describe('asks on its own: read from what the card would sign, whatever mark it carries', () => {
  const alone = (c: object) => run(`apprAlone(${JSON.stringify(c)})`) as boolean;

  it('a rule card with a row that lets something run alone asks on its own with the mark, without it, and with it set to false', () => {
    for (const rows of [rowsOf('P3_PROMOTIONS'), rowsOf('P3C_PROMOTIONS'), rowsOf('P26_PROMOTIONS'), [{ pattern: 'backup.local' }], [{ pattern: 'some.new_action' }]]) {
      const base = card(rows, 'x');
      expect(base).not.toHaveProperty('consequential');
      expect(alone(base), JSON.stringify(rows)).toBe(true);
      expect(alone({ ...base, consequential: false }), JSON.stringify(rows)).toBe(true);
      expect(alone({ ...base, consequential: true }), JSON.stringify(rows)).toBe(true);
    }
    // One such row among others is enough.
    expect(alone(card([{ pattern: 'notify.push', tier: 'approval' }, { pattern: 'goal.review.local' }], 'x'))).toBe(true);
  });

  it('a card that only tightens does not, on its rows alone; the server’s mark still makes it', () => {
    const tightens = card([{ pattern: 'notify.push', tier: 'forbidden' }, { pattern: 'goal.review.local', tier: 'approval' }], 'x');
    expect(alone(tightens)).toBe(false);
    expect(alone({ ...tightens, consequential: true })).toBe(true);
    // Rows that are not rows let nothing run.
    expect(alone({ fullName: 'policy.change', kind: 'policy', args: { rows: [null, 7, 'alone'] } })).toBe(false);
    // A rule card that is not a list of rows at all is not one Flint files (a rule card says one thing: rows, or the
    // rules it switches off). Whatever it is, it is never signed in a batch: it asks on its own.
    expect(alone({ fullName: 'policy.change', kind: 'policy', args: { rows: 'alone' } })).toBe(true);
    expect(alone({ fullName: 'policy.change', kind: 'policy', args: {} })).toBe(true);
    // The rule is about rule cards: another card with such a row inside it is not one.
    expect(alone({ fullName: 'runtime.inbox_recent', args: { rows: [{ pattern: 'x', tier: 'alone' }] } })).toBe(false);
  });
});

