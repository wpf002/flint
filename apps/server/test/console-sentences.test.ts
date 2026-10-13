/**
 * The console's own lines are sentences (Will, 2026-10-06: "All secondary text
 * should be complete and concise sentences"), checked on the main script's
 * functions run against small fakes: an error in Flint's words ends with a stop
 * and never doubles one; a reply that stops mid-stream says so in a sentence and
 * never prints the server's raw error (that goes to the console log); a refused
 * or unanswered message says so; a Mac whose key was revoked can replace it; and
 * the line under a notification is complete sentences, whatever was stored.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { PAID_VENDORS } from '@flint/core';
import { ACTION_DONE, CHECK_NAMES, TASK_FAILURE_SAYS, TASK_REASONS, TASK_SAYS, TASK_STATUS_SAYS, jobFailedNote, noteProblems, type NightlyJob } from '@flint/policy';
import { actionDoneNote } from '../src/approval-routes';
import { TASKS_SAY } from '../src/tasks-routes';
import { breakerNote } from '../src/frontier-breaker';
import { localDefaultNote } from '../src/local-model';
import { PHONE_PING } from '../src/notifications';
import { effectOf, thresholdNote } from '../src/spend';

const html = readFileSync(join(__dirname, '..', '..', 'console', 'index.html'), 'utf8');
const mainJs = /<script>\n\/\* ---------- config ---------- \*\/([\s\S]*?)<\/script>/.exec(html)![1]!;

/** One top-level function of the main script, up to the next top-level statement. */
function fn(name: string): string {
  const start = mainJs.indexOf(`\nfunction ${name}(`);
  if (start < 0) throw new Error(`no function ${name}`);
  const rest = mainJs.slice(start + 1);
  const end = rest.slice(1).search(/\n(function |\/\*|\$\(|var )/);
  return end < 0 ? rest : rest.slice(0, end + 1);
}

class El {
  value = '';
  hidden = false;
  children: El[] = [];
  style: Record<string, string> = {};
  scrollTop = 0;
  textContent = '';
  innerHTML = '';
  constructor(readonly id = '') {}
}

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

describe('errText', () => {
  const c: Record<string, unknown> = {};
  createContext(c);
  runInContext(fn('errText'), c);
  const say = (e: unknown) => (c.errText as (e: unknown) => string)(e);

  it('is a sentence: a capital first and a stop last, never two', () => {
    expect(say('the runtime refused that change')).toBe('The runtime refused that change.');
    expect(say(new Error('That key is already added.'))).toBe('That key is already added.');
    expect(say('Is it there?')).toBe('Is it there?');
    expect(say('Flint is waiting…')).toBe('Flint is waiting…');
    expect(say('a list follows:')).toBe('A list follows.');
    // An aside is left out, as before.
    expect(say('the database refused it (err123)')).toBe('The database refused it.');
  });

  it('a cancelled prompt is "Cancelled.", and nothing at all is "It stopped."', () => {
    expect(say(new Error('not confirmed'))).toBe('Cancelled.');
    expect(say(undefined)).toBe('It stopped.');
    expect(say('(only an aside)')).toBe('It stopped.');
  });
});

describe('the console asking Flint', () => {
  function chat(answer: () => Promise<unknown>) {
    const ids: Record<string, El> = Object.fromEntries(['input', 'thread', 'think', 'transcript'].map((id) => [id, new El(id)]));
    ids.input!.value = 'Hello';
    const bodies: El[] = [];
    const logged: unknown[][] = [];
    const c: Record<string, unknown> = {
      $: (id: string) => ids[id],
      ATT_READING: 0, PENDING: [], TOKEN: 'tok', BASE: '', convId: 'c1', LOCAL_ONLY: false, _ttsGen: 0,
      attNote: () => {}, openSettings: () => {}, syncSend: () => {}, renderChips: () => {}, setTitle: () => {}, renderSentAtts: () => {},
      stopSpeech: () => {}, setTalk: () => {}, tokenRejected: () => {}, setBrainChip: () => {}, renderProposals: () => {}, speakSynced: () => {}, loadThreads: () => {},
      addMsg: () => {
        const b = new El();
        bodies.push(b);
        return b;
      },
      auth: () => ({ Authorization: 'Bearer tok' }),
      md: (s: string) => s,
      fetch: answer,
      TextDecoder,
      console: { log: (...a: unknown[]) => void logged.push(a) },
    };
    createContext(c);
    runInContext(`${fn('errText')}\n${fn('send')}`, c);
    return { send: () => runInContext('send()', c), reply: () => bodies[1]!, logged };
  }
  const stream = (...events: unknown[]) => async () => {
    const chunks = events.map((e) => new TextEncoder().encode(`data: ${JSON.stringify(e)}\n\n`));
    return { status: 200, ok: true, body: { getReader: () => ({ read: async () => (chunks.length ? { done: false, value: chunks.shift() } : { done: true }) }) } };
  };

  it('a reply that stops mid-stream says so in a sentence; the server\'s error goes to the console log, never into the reply', async () => {
    for (const error of [{ message: 'upstream reset: ECONNRESET' }, 'Error: socket hang up', { kind: 'timeout' }]) {
      const t = chat(stream({ type: 'text', delta: 'Partly there' }, { type: 'error', error }));
      t.send();
      await settle();
      expect(t.reply().innerHTML).toBe('Partly there\n\nThis reply stopped early.');
      expect(t.reply().innerHTML).not.toMatch(/object Object|Error:|ECONNRESET|timeout/);
      expect(t.logged).toEqual([['Flint: the reply stopped early:', error]]);
    }
  });

  it('a reply stopped because no brain has budget left says why and what to do, from the sentence the server wrote for Will', async () => {
    const message = "Claude (Anthropic) budget reached: today's $10.00 cap is spent. No brain with budget left can answer, so none was called. Ask again after the budget resets, or raise the cap (FLINT_BUDGET_ANTHROPIC_*).";
    const error = `Error: frontier failed: Error: 529 overloaded. ${message}`;
    const t = chat(stream({ type: 'error', error, message }));
    t.send();
    await settle();
    expect(t.reply().innerHTML).toBe(
      "\n\nThis reply stopped early. Claude budget reached: today's $10.00 cap is spent. No brain with budget left can answer, so none was called. Ask again after the budget resets, or raise the cap.",
    );
    // The raw error stays in the console log only.
    expect(t.reply().innerHTML).not.toMatch(/frontier failed|529|Error:/);
    expect(t.logged).toEqual([['Flint: the reply stopped early:', error]]);
  });

  it('a refused message says it was not sent, in Flint\'s words; no answer at all says so', async () => {
    const refused = chat(async () => ({ status: 413, ok: false, json: async () => ({ error: 'that file is over the 20 MB limit' }) }));
    refused.send();
    await settle();
    expect(refused.reply().textContent).toBe('This message wasn’t sent. That file is over the 20 MB limit.');
    const bare = chat(async () => ({ status: 500, ok: false, json: async () => { throw new Error('not JSON'); } }));
    bare.send();
    await settle();
    expect(bare.reply().textContent).toBe('This message wasn’t sent. Flint returned error 500.');
    const down = chat(async () => { throw new TypeError('Failed to fetch'); });
    down.send();
    await settle();
    expect(down.reply().textContent).toBe('Flint didn’t answer. Try again.');
  });
});

describe('a card a chat proposed', () => {
  it('says a chat filed it, even when the server sent it without its origin', () => {
    const host = { children: [] as Array<{ children: Array<{ cls: string; text: string }> }>, appendChild(c: { children: Array<{ cls: string; text: string }> }) { this.children.push(c); return c; } };
    const subs: unknown[] = [];
    const c: Record<string, unknown> = {
      $: () => ({ scrollTop: 0 }),
      el: (_tag: string, cls?: string, text?: string) => ({ cls, text, children: [] as unknown[], classList: { toggle() {}, contains: () => false }, style: {}, appendChild(x: unknown) { this.children.push(x); return x; } }),
      apprTitle: (a: { fullName: string }) => a.fullName,
      apprSub: (a: { origin?: string }) => (subs.push(a.origin), a.origin && a.origin.indexOf('chat:') === 0 ? 'A chat filed this.' : 'Its source is unknown.'),
      apprAlone: () => false, approveLabel: () => 'Approve', approveAction: () => {}, rejectAction: () => {},
    };
    createContext(c);
    runInContext(fn('renderProposals'), c);
    (c.renderProposals as (a: unknown[], b: unknown) => void)([{ id: 'act-1', fullName: 'github.create_issue', args: {}, tainted: false, status: 'pending' }, { id: 'pr2', fullName: 'github.create_issue', args: {}, tainted: false, status: 'pending', origin: 'chat:t1' }], { parentNode: host });
    expect(subs).toEqual(['chat:', 'chat:t1']);
    expect(host.children.map((card) => card.children.find((x) => x.cls === 'psub')!.text)).toEqual(['A chat filed this.', 'A chat filed this.']);
  });
});

describe('Settings: Approval Keys', () => {
  function keys(o: { seId: string | null; listed: Array<{ credentialId: string; factor: string; label: string }> }) {
    const ids: Record<string, El> = Object.fromEntries(['creds', 'enrollbox', 'enrollpk', 'enrollse', 'resetse'].map((id) => [id, new El(id)]));
    const c: Record<string, unknown> = {
      $: (id: string) => ids[id],
      TOKEN: 'tok', BASE: '', SE_ID: o.seId, SE_METHOD: 'touchid', CREDS: null,
      auth: () => ({ Authorization: 'Bearer tok' }),
      enclave: () => ({}), passkeysHere: () => false, loadKeyApprovals: () => {}, resetEnclave: () => {},
      el: (_tag: string, _cls?: string, text?: string) => Object.assign(new El(), { textContent: text ?? '', appendChild(x: El) { this.children.push(x); return x; } }),
      fetch: async () => ({ ok: true, json: async () => ({ credentials: o.listed }) }),
    };
    createContext(c);
    runInContext(`${fn('keyRow')}\n${fn('loadCreds')}`, c);
    (ids.creds as unknown as { appendChild: (x: El) => El }).appendChild = (x: El) => (ids.creds!.children.push(x), x);
    runInContext('loadCreds()', c);
    return ids;
  }

  it('offers Replace This Mac’s Key whenever this Mac has a key that is not enrolled (one that was revoked is not listed)', async () => {
    const revoked = keys({ seId: 'se_revoked', listed: [{ credentialId: 'pk1', factor: 'webauthn', label: 'phone' }] });
    await settle();
    expect(revoked.resetse!.hidden).toBe(false);
    const enrolled = keys({ seId: 'se_mine', listed: [{ credentialId: 'se_mine', factor: 'secure_enclave', label: 'Mac' }] });
    await settle();
    expect(enrolled.resetse!.hidden).toBe(false);
    // No key on this Mac yet: nothing to replace, so Add is the way.
    const none = keys({ seId: null, listed: [] });
    await settle();
    expect(none.resetse!.hidden).toBe(true);
  });
});

// While the frontier breaker has Claude paused (apps/server/src/frontier-breaker.ts), a /chat
// turn's first `meta` event says brain "local": this is what the console does with it.
describe('who answered, under a reply', () => {
  function chip(brains: string[]) {
    const tags: Array<{ cls: string; text: string }> = [];
    const meta = {
      querySelector: (sel: string) => (sel === '.tag' && tags.length ? { remove: () => tags.splice(0) } : null),
      appendChild: (t: { cls: string; text: string }) => tags.push(t),
    };
    const body = { parentNode: { querySelector: (sel: string) => (sel === '.meta' ? meta : null) } };
    const c: Record<string, unknown> = { el: (_tag: string, cls: string, text: string) => ({ cls, text }), applyLO: () => {}, body };
    createContext(c);
    runInContext(fn('setBrainChip'), c);
    for (const b of brains) runInContext(`setBrainChip(body, ${JSON.stringify(b)})`, c);
    return tags;
  }

  it('an answer from the local model is marked Local; one from the frontier carries no mark', () => {
    expect(chip(['local'])).toEqual([{ cls: 'tag', text: 'Local' }]);
    expect(chip(['frontier'])).toEqual([]);
  });

  it('a turn that started on the frontier and was handed to the local model ends marked Local, once', () => {
    expect(chip(['frontier', 'local'])).toEqual([{ cls: 'tag', text: 'Local' }]);
    expect(chip(['local', 'local'])).toEqual([{ cls: 'tag', text: 'Local' }]);
  });
});

describe('the line under a notification', () => {
  const lanesJs = /<script id="lanes-js">([\s\S]*?)<\/script>/.exec(html)![1]!;
  const c: Record<string, unknown> = { document: { getElementById: () => null }, setInterval: () => 0, TOKEN: '', BASE: '', console };
  createContext(c);
  runInContext(lanesJs, c);
  const title = (t: string) => runInContext(`noteTitle(${JSON.stringify(t)})`, c) as string;
  const line = (b: string, kind = 'runtime') => runInContext(`noteBody(${JSON.stringify(b)}, ${JSON.stringify(kind)})`, c) as string;
  /** Each line is one or more sentences: a capital (or a number) first, a stop last. */
  const SENTENCES = /^[\p{Lu}\p{N}“$][^\n]*[.!?…]$/u;

  it('is the note’s own sentences, untouched, for every note Flint posts today', () => {
    const notes: Array<{ title: string; body: string }> = [
      ...(['backup.local', 'backup.offsite', 'restore.drill'] as NightlyJob[]).flatMap((job) => (['retry', 'card', 'card_later', 'setup'] as const).flatMap((next) => [true, false].map((x) => jobFailedNote(job, { next, icloud: x, mismatch: x })))),
      ...Object.keys(ACTION_DONE).map(actionDoneNote),
      actionDoneNote('trident.gmail_send'),
      ...PAID_VENDORS.flatMap((v) => (['degrade', 'exhausted', 'notice'] as const).map((level) => thresholdNote(v, 'monthly', 80, 120.5, 150, effectOf(v, level)))),
      { title: 'Daily Summary for Sun Oct 11', body: 'Yesterday, 3 items were important and 12 went to Other. Flint escalated 1.\nFlint did 2 things on its own. You have 1 approval and 3 open escalations waiting.\nThese need a look: Job Queue, Restore Test and GitHub.\nToday, 3 predictions resolve.' },
      { title: 'The Server Is Down', body: 'The server has been down for 45 minutes. Recovery is somewhat unlikely, around 40% by Oct 2, 5:30 PM.' },
      { title: 'On Your Calendar Tue Oct 6 at 2:30 PM', body: 'You have an event on Tue Oct 6 at 2:30 PM. Its title is in Activity, under Important.' },
      { title: 'One of Your Rules Matched', body: 'A GitHub event matched your rule “ci red”.' },
      { title: 'The Trident API Service Is Down', body: 'The Trident API service has been down for 35 minutes.' },
      { title: 'The Last Restore Test Failed', body: 'The last restore test found 2 tables that differ from the backup, so the backups may not restore.' },
      { title: PHONE_PING.title, body: PHONE_PING.body },
      // An outside AI paused for something only Will can fix, and a local model that is a guess.
      breakerNote({ provider: 'anthropic', reason: 'credit' })!,
      breakerNote({ provider: 'openai', reason: 'auth' })!,
      breakerNote({ provider: 'anthropic', reason: 'auth', model: 'claude-opus-4-8' })!,
      localDefaultNote(),
    ];
    for (const n of notes) {
      expect(title(n.title), n.title).toBe(n.title);
      expect(line(n.body), n.body).toBe(n.body);
      for (const l of line(n.body).split('\n')) expect(l, l).toMatch(SENTENCES);
      expect(noteProblems(title(n.title), line(n.body)), n.title).toEqual([]);
    }
  });

  it('is still complete sentences once an older note’s file paths, commands and asides are left out', () => {
    for (const [stored, shown] of [
      ['Last night’s offsite copy failed. The details are in ~/.flint/runtime-backup.out.log.', 'Last night’s offsite copy failed.'],
      ['The details are in ~/.flint/runtime-backup.out.log. Last night’s backup failed.', 'Last night’s backup failed.'],
      ['The update failed (exit 2). Run `pnpm install` and try again. Flint kept the old version.', 'The update failed. Flint kept the old version.'],
      ['It was told to stop with --force. It stopped.', 'It stopped.'],
      ['Flint’s restore_drill job found 2 tables that differ.', 'Flint’s restore drill job found 2 tables that differ.'],
      ['Nothing changed (see /Users/will/log.txt).', 'Nothing changed.'],
      // Nothing left to say: the title stands alone, and no empty line is shown under it.
      ['See ~/.flint/server.err.log.', ''],
    ] as const) {
      expect(line(stored), stored).toBe(shown);
      if (shown) expect(shown).toMatch(SENTENCES);
    }
  });

  it('the count after a repeated note is a sentence of its own, in the tense that is true', () => {
    const again = (n: Record<string, unknown>, cut = 0) => runInContext(`noteAgain(${JSON.stringify(n)}, ${cut})`, c) as string;
    const NIGHT = 86_400_000;
    const now = Date.now();
    const row = (over: Record<string, unknown>) => ({ count: 2, every: NIGHT, ts: now - 3_600_000, first: now - NIGHT - 3_600_000, ...over });
    const said = [
      again({ count: 3, every: 0 }),
      again(row({})),
      again(row({ count: 5, first: now - 4 * NIGHT - 3_600_000 })),
      // Its newest failure is four nights old: it is over.
      again(row({ count: 3, ts: now - 4 * NIGHT, first: now - 6 * NIGHT })),
      again(row({ count: 2, every: 7 * NIGHT, first: now - 7 * NIGHT - 3_600_000 })),
      // The list was cut a night before the streak's oldest failure.
      again(row({ count: 50, first: now - 49 * NIGHT - 3_600_000 }), now - 50 * NIGHT),
    ];
    expect(said).toEqual([
      'It happened 3 times.',
      'It has failed 2 nights in a row.',
      'It has failed 5 nights in a row. It needs a look.',
      'It failed 3 nights in a row.',
      'It has failed 2 weeks in a row.',
      'It has failed at least 50 nights in a row. It needs a look.',
    ]);
    for (const line of said) for (const sentence of line.split(/(?<=\.) /)) expect(sentence).toMatch(SENTENCES);
    // Once is not a streak.
    expect(again(row({ count: 1 }))).toBe('');
  });
});

describe('P5: tasks and assets', () => {
  const block = (id: string) => new RegExp(`<script id="${id}">([\\s\\S]*?)</script>`).exec(html)![1]!;
  const noComments = (js: string) => js.replace(/\/\*[\s\S]*?\*\//g, '');
  const tasksJs = noComments(block('tasks-js'));
  const apprJs = block('approvals-js');
  /** The part of the Approvals script that holds P5's card words. */
  const cardsJs = noComments(apprJs.slice(apprJs.indexOf('/* ---------- P5: the cards for assets and tasks'), apprJs.indexOf('\nfunction apprEl(')));
  const literals = (js: string) => [...js.matchAll(/'((?:[^'\\\n]|\\.)*)'/g)].map((m) => m[1]!);
  const SMALL = new Set(['a', 'an', 'the', 'and', 'but', 'or', 'nor', 'for', 'so', 'yet', 'as', 'at', 'by', 'from', 'in', 'into', 'of', 'off', 'on', 'onto', 'out', 'over', 'to', 'up', 'with']);
  const titleCase = (t: string) => t.split(' ').every((w, i, all) => !w || /^[^a-z]/.test(w) || (i > 0 && i < all.length - 1 && SMALL.has(w)));
  const SENTENCE = /^[\p{Lu}\p{N}“][^\n]*[.!?…]$/u;
  /** A whole sentence written out in the script: it starts with a capital and ends with a stop. (A piece of one, joined to a name, starts with a space or a small letter.) */
  const whole = (l: string) => /^[A-Z]/.test(l) && /[.!?…]$/.test(l) && l.includes(' ');
  /** What a call site puts on screen: the text argument of each kind of element. */
  const at = (js: string, re: RegExp) => [...js.matchAll(re)].map((m) => m[1]!);

  it('every secondary line the panel and Settings can show is a complete sentence, by the notes’ own standard', () => {
    const lines = literals(tasksJs).filter(whole);
    // The script holds its sentences: the table, the empty states, the confirmations, what a failed read says.
    expect(lines.length).toBeGreaterThan(30);
    for (const l of lines) {
      expect(l, l).toMatch(SENTENCE);
      expect(noteProblems('Tasks', l), l).toEqual([]);
    }
    // Each place a second line is drawn is given a sentence, a name the runtime sent, or one of the table's.
    const second = [
      ...at(tasksJs, /goalEmpty\('[^']*','([^']+)'/g), ...at(tasksJs, /predLine\('([^']+)'\)/g), ...at(tasksJs, /gEl\('span',null,'([^']+)'\)/g),
      ...at(tasksJs, /gEl\('span','note','([^']+)'\)/g), ...at(tasksJs, /gEl\('p','(?:gnote|plead)','([^']+)'\)/g),
    ];
    // (What is no sentence there: the Show Details button's label, held to Title Case below, and the start of a sentence
    // that goes on with an asset's name, read whole just below.)
    expect(second.filter((x) => x.endsWith(' '))).toEqual(['Turn on ', 'Turn on ']);
    for (const l of second.filter((x) => x !== 'Show Details' && !x.endsWith(' '))) expect(l, l).toMatch(SENTENCE);
    // The sentences made from a piece and a name read whole.
    for (const made of ['Turn on the CI Watcher in Settings to start.', 'Turn on Local Tasks in Settings to run a new task.', 'Turn on an asset in Settings to start.']) expect(noteProblems('Tasks', made), made).toEqual([]);
    expect(literals(tasksJs).filter((l) => /^ in Settings to /.test(l)).sort()).toEqual([' in Settings to run a new task.', ' in Settings to start.', ' in Settings to start.']);
    // And everything the runtime and the server may say there is a sentence too.
    for (const l of [...Object.values(TASK_SAYS), ...Object.values(TASK_STATUS_SAYS), ...Object.values(TASK_FAILURE_SAYS), ...Object.values(TASK_REASONS), ...Object.values(TASKS_SAY)]) {
      expect(l, l).toMatch(SENTENCE);
      expect(noteProblems('Tasks', l), l).toEqual([]);
    }
  });

  it('every title, button, label, tab, tag and value of its own is in Title Case, and section headers go through .gsh', () => {
    const labels = [
      ...at(tasksJs, /gBtn\('[^']*','([^']+)'/g), ...at(tasksJs, /taskFact\('([^']+)'/g), ...at(tasksJs, /taskFact\('[^']+',[^)]*\?'[^']*':'([^']+)'\)/g), ...at(tasksJs, /goalEmpty\('([^']+)'/g),
      ...at(tasksJs, /gEl\('b',null,'([^']+)'\)/g), ...at(tasksJs, /gTag\('([^']+)'/g), ...at(tasksJs, /goalSelect\('([^']+)'/g), ...at(tasksJs, /goalField\('([^']+)'/g), ...at(tasksJs, /taskHead\('([^']+)'/g),
      ...at(tasksJs, /gEl\('div','gsh','([^']+)'\)/g), ...at(tasksJs, /TASK_TABS=\[\['[a-z]+','([^']+)'\],\['[a-z]+','([^']+)'\]\]/g), ...at(tasksJs, /createTextNode\(a\.on\?'([^']+)'/g),
      'Show Details', 'Hide Details', 'On', 'Off', 'Waiting', 'Passed', 'Failed', 'No Cost', 'Not Known Yet', 'No Goal', 'No Due Date', 'Choose a CI Run',
    ];
    expect(labels.length).toBeGreaterThan(45);
    for (const want of ['Tasks', 'New Task', 'Cancel Task', 'Keep Task', 'Accept Anyway', 'Reject Anyway', 'Run Again', 'Review Card', 'Not Now', 'Create Task', 'Turn On', 'Turn Off', 'Open Settings', 'Open Approvals', 'Try Again',
      'Tasks Are Off', 'No Tasks Yet', 'Nothing Finished Yet', 'Cancel This Task', 'Outside Text', 'Costs Money', 'What to Do', 'Goal', 'Due', 'About', 'Runs On', 'Asked By', 'Chance It Passes', 'Cost', 'Result', 'Checks', 'Details', 'Assets']) {
      expect(labels, want).toContain(want);
    }
    for (const l of labels) {
      expect(titleCase(l), l).toBe(true);
      expect(l, l).not.toMatch(/[.!?]$/);
    }
    // No label is written in capitals: a header's capitals are the style's.
    for (const l of labels) expect(l === l.toUpperCase() && l.length > 3, l).toBe(false);
    expect(html).toMatch(/\.gsh\{[^}]*text-transform:uppercase/);
    // A check's name is the runtime's, and each one is a Title Case title too.
    for (const n of Object.values(CHECK_NAMES)) expect(titleCase(n), n).toBe(true);
  });

  it('P5’s card words: each title in Title Case, each sentence whole, each label behind Show Details a Title Case label', () => {
    const lines = literals(cardsJs).filter(whole);
    expect(lines.length).toBeGreaterThan(12);
    for (const l of lines) {
      expect(l, l).toMatch(SENTENCE);
      expect(noteProblems('Approvals', l), l).toEqual([]);
    }
    const titles = [
      ...at(cardsJs, /APPR_ASSETS=\{ci_runner:\['([^']+)'/g), ...at(cardsJs, /APPR_ASSET_OTHER=\['([^']+)'/g), ...at(cardsJs, /APPR_DISPATCH=\{ci_runner:\['([^']+)'/g), ...at(cardsJs, /APPR_DISPATCH_OTHER=\['([^']+)'/g),
      ...at(cardsJs, /return '((?:Accept|Cancel) a [^']+)'/g), ...at(cardsJs, /\?'((?:Accept|Reject) a Result Anyway)'/g), ...at(cardsJs, /:'(Overrule[^']+)'/g),
    ];
    expect(titles.sort()).toEqual(['Accept a Result Anyway', 'Accept a Task Result', 'Cancel a Task', 'Overrule a Task’s Checks', 'Reject a Result Anyway', 'Run a Task', 'Turn On an Asset', 'Turn On the CI Watcher', 'Watch a CI Run']);
    for (const t of titles) expect(titleCase(t), t).toBe(true);
    // The labels: a fact's on the card's face, and a stored key's own word behind Show Details.
    const keys = /var APPR_KEYS_TASK=\{([\s\S]*?)\};/.exec(cardsJs)![1]!;
    const labels = [...at(cardsJs, /\[\'([A-Z][A-Za-z ]+)\',/g), ...[...keys.matchAll(/:'([^']*)'/g)].map((m) => m[1]!).filter(Boolean), ...Object.values({ a: 'Item ID', b: 'Item IDs' })];
    expect(labels).toEqual(expect.arrayContaining(['Asset', 'Can Do', 'Cost', 'Task', 'Checked By', 'CI Run', 'Due', 'Expires', 'Filed By', 'Template', 'Check', 'Runs On', 'Outside Text', 'Passed Its Checks']));
    for (const l of labels) expect(titleCase(l), l).toBe(true);
    // What a prompt says Flint is doing is lower case, as the others are, with names their own way.
    for (const r of [...at(cardsJs, /return '((?:accept|reject|cancel|run|end) this [a-z]+)'/g), ...at(cardsJs, /'(turn on [^']+)'/g)]) expect(r, r).toMatch(/^[a-z][A-Za-z ]+$/);
  });

  it('no <pre> for a P5 card: neither script makes one, and neither writes HTML or the args as they are stored', () => {
    for (const js of [tasksJs, cardsJs]) {
      expect(js).not.toMatch(/['"]pre['"]|['"]code['"]|<pre|innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
      // A card is never shown as its stored args: nothing here turns them into text.
      expect(js).not.toMatch(/JSON\.stringify\((?!\{draftKey)[^)]*args/);
    }
    expect(tasksJs).not.toMatch(/JSON\.stringify/);
    // The Approvals panel's own renderer, which both use for a card's details, makes paragraphs, headers and label lists only.
    const details = /function apprDetailsInto\([\s\S]*?\n(?=\/\*)/.exec(apprJs)![0] + /function apprGroupInto\([\s\S]*?\n(?=function )/.exec(apprJs)![0];
    expect([...details.matchAll(/apprEl\('([a-z0-9]+)'/g)].map((m) => m[1]).sort()).toEqual(['dd', 'dl', 'dt', 'h4', 'p', 'p']);
  });
});
