/**
 * The console's Approvals panel (apps/console/index.html, its own <script
 * id="approvals-js">), run against a small fake DOM that refuses innerHTML:
 * every pending card the server lists says what it would do in words (the
 * open one with three facts or fewer, the rest as sentences behind Show Details), with
 * outside text marked and inert; Approve and Reject go through the signed path
 * chat cards use; Approve All signs each card in turn and leaves a card with
 * outside text or money for its own prompt; a device without an approval key
 * is pointed to Settings; an approved card that did not run can be run (a
 * nightly one says when its job runs it instead); the header badge counts what
 * is waiting. Every line under a title, and every note, is a sentence.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { laterDay, pinLocale, shownDay } from './console-dates';
import { ACTION_WORDS, FORECAST_REASONS, WEEKLY_JOBS, noteProblems } from '@flint/policy';

/** A rule's last day, and how the console shows it: a date with its year, whenever this runs. */
const RULE_UNTIL = laterDay(3, 29);
const RULE_DAY = shownDay(3, 29);

const html = readFileSync(join(__dirname, '..', '..', 'console', 'index.html'), 'utf8');
const apprJs = /<script id="approvals-js">([\s\S]*?)<\/script>/.exec(html)![1]!;

class El {
  className = '';
  children: El[] = [];
  style: Record<string, string> = {};
  onclick: (() => void) | null = null;
  disabled = false;
  hidden = false;
  private text = '';
  private attrs: Record<string, string> = {};
  private readonly classes = new Set<string>();
  constructor(readonly tagName: string, readonly id = '') {}
  readonly classList = {
    add: (c: string) => void this.classes.add(c),
    remove: (c: string) => void this.classes.delete(c),
    toggle: (c: string, on?: boolean) => void ((on ?? !this.classes.has(c)) ? this.classes.add(c) : this.classes.delete(c)),
    contains: (c: string) => this.classes.has(c),
  };
  get firstChild(): El | undefined {
    return this.children[0];
  }
  get textContent(): string {
    return this.text + this.children.map((c) => c.textContent).join('');
  }
  set textContent(v: string) {
    this.children = [];
    this.text = String(v);
  }
  set innerHTML(_v: string) {
    throw new Error('innerHTML is not allowed in the approvals panel');
  }
  setAttribute(k: string, v: string) {
    this.attrs[k] = v;
  }
  getAttribute(k: string) {
    return this.attrs[k] ?? null;
  }
  appendChild(c: El): El {
    this.children.push(c);
    return c;
  }
  all(): El[] {
    return this.children.flatMap((c) => [c, ...c.all()]);
  }
  button(text: string): El {
    const b = this.all().find((e) => e.tagName === 'button' && e.textContent === text);
    if (!b) throw new Error(`no button "${text}" in: ${this.textContent}`);
    return b;
  }
  shown(): string {
    return this.hidden ? '' : this.text + this.children.map((c) => c.shown()).join('');
  }
}

type Call = { url: string; method: string; body: unknown };
let calls: Call[];
let answer: (c: Call) => { status: number; body: unknown };
let ids: Record<string, El>;
let decided: Array<[string, string, Record<string, unknown>?]>;
let failApprove: string | null;
/** What a failed approval says ("not confirmed" is a prompt Will dismissed). */
let failWith: string;
/** Set to a list, approvals wait in it (the prompt is up) until the test settles them. */
let held: Array<{ id: string; card: El; ok: (d: unknown) => void; no: (e: Error) => void }> | null;
let ctx: Record<string, unknown>;
let keyed: boolean;
let panels: Record<string, boolean>;

const settle = async () => {
  for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0));
};
const run = (code: string) => runInContext(code, ctx);
/** The footer's note, read with plain spaces (its second sentence is held together with no-break ones). */
const noteSays = () => ids.apprnote!.textContent.replace(/\u00a0/g, ' ');
const card = (over: Record<string, unknown> = {}) => ({
  id: 'pr1', fullName: 'world.source.enable', kind: 'tool_call', args: { source: 'deploy' }, tainted: false, status: 'pending', origin: 'cli', ts: Date.now() - 3600_000,
  expiresAt: '2026-10-12T14:00:00.000Z', ...over,
});
/** An ordinary card, which may share one prompt with others in Approve All: a read chat asked for. (A card that turns a source on asks on its own.) */
const plain = (over: Record<string, unknown> = {}) => card({ fullName: 'runtime.inbox_recent', args: { lane: 'relevant' }, origin: 'chat:c1', ...over });
const textNode = (t: string) => Object.assign(new El('#text'), { textContent: t });

beforeEach(() => {
  calls = [];
  decided = [];
  failApprove = null;
  failWith = 'not confirmed';
  held = null;
  keyed = true;
  panels = {};
  answer = () => ({ status: 200, body: { proposals: [], signed: true } });
  ids = Object.fromEntries(
    ['approvals', 'apprlist', 'apprhelp', 'apprbadge', 'apprseg', 'apprtab-waiting', 'apprtab-approved', 'apprn-waiting', 'apprn-approved', 'apprfoot', 'apprnote', 'apprall', 'thread'].map((id) => [id, new El('div', id)]),
  );
  const document = {
    getElementById: (id: string) => ids[id] ?? null,
    createElement: (tag: string) => new El(tag),
    createTextNode: textNode,
    querySelectorAll: (sel: string) => (sel === '#apprlist .card' ? ids.apprlist!.all().filter((e) => e.className.split(' ').includes('card')) : []),
  };
  const fetch = async (url: string, init: { method?: string; body?: string; headers?: Record<string, string> } = {}) => {
    const c: Call = { url, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : undefined };
    expect(init.headers?.Authorization).toBe('Bearer tok');
    calls.push(c);
    const a = answer(c);
    return { ok: a.status >= 200 && a.status < 300, status: a.status, json: async () => a.body };
  };
  ctx = {
    document, fetch, BASE: '', TOKEN: 'tok', console,
    auth: () => ({ Authorization: 'Bearer tok' }),
    setInterval: () => 0, setTimeout: () => 0,
    svgi: () => new El('svg'),
    laneAgo: () => '1h',
    showPanel: (id: string, on: boolean) => void (panels[id] = on),
    canEnclave: () => keyed, canPasskey: () => false, loadCreds: () => {},
    approveLabel: (all?: boolean) => (all ? 'Approve All with Password' : 'Approve with Password'),
    approveAction: (id: string, _card: El, o: Record<string, unknown>) => {
      decided.push(['approve', id, o]);
      if (held) return new Promise((ok, no) => void held!.push({ id, card: _card, ok, no }));
      return failApprove === id ? Promise.reject(new Error(failWith)) : Promise.resolve({ action: { status: 'done' } });
    },
    rejectAction: (id: string) => void decided.push(['reject', id]),
    postJson: async (path: string, body: unknown) => (calls.push({ url: path, method: 'POST', body }), { action: { status: 'done' } }),
    showOutcome: (d: { action?: { status?: string } }, r: El) => void (r.textContent = `outcome ${d.action?.status}`),
    failed: (e: Error, r: El) => void (r.textContent = `failed ${e.message}`),
    errText: (e: Error) => (e.message === 'not confirmed' ? 'Cancelled.' : e.message),
    starters: () => {},
    openSettings: () => void (panels.settings = true),
  };
  createContext(ctx);
  pinLocale(ctx);
  runInContext(apprJs, ctx);
  // A Tuesday noon, so a restore test's card says the same thing whatever day the tests run.
  ctx.apprNow = () => new Date(2026, 9, 6, 12, 0);
});

const open = async () => {
  run('openApprovals()');
  await settle();
};

describe('the console Approvals panel', () => {
  it('says what each waiting card would do in words: the open one with its facts, the rest as rows, outside text marked and inert', async () => {
    answer = () => ({
      status: 200,
      body: {
        signed: true,
        proposals: [
          card({ id: 'pr0', fullName: 'policy.change', kind: 'policy', reason: 'The shadow week: 1.2 relevant a day.', args: { rows: [{ pattern: 'backup.local', tier: 'alone', expiresAt: RULE_UNTIL }, { pattern: 'restore.drill', tier: 'alone', expiresAt: RULE_UNTIL }, { pattern: 'backup.offsite', tier: 'alone', expiresAt: RULE_UNTIL }] } }),
          card(),
          card({ id: 'pr2', fullName: 'world.person.create', kind: 'tool_call', origin: 'runtime:google_calendar', tainted: true, args: { people: [{ name: '<img src=x onerror=alert(1)>Ada', email: 'ada@example.com' }] } }),
        ],
      },
    });
    await open();
    expect(panels.approvals).toBe(true);
    const rows = ids.apprlist!.children[0]!.children;
    expect(rows).toHaveLength(3);
    const first = rows[0]!.shown();
    expect(first).toContain('Run Backups on Their Own');
    // The open card shows its line too, as a sentence, and its facts.
    expect(first).toContain(`Run Backups on Their OwnIt lasts until ${RULE_DAY}.`);
    expect(first).toContain(`Until${RULE_DAY}`);
    expect(first).toContain('LimitsBackup 1 a Day · Restore Test 1 a Week · Offsite Copy 1 a Day');
    expect(first).toContain('Filed ByYou');
    // The reason and what each rule lets run wait behind Show Details, as sentences: a rule card never shows its rows as they are stored.
    expect(first).not.toContain('backup.local');
    expect(first).not.toContain('The backup may run');
    rows[0]!.button('Show Details').onclick!();
    const details = rows[0]!.shown();
    expect(details).toContain('The shadow week: 1.2 relevant a day.');
    expect(details).toContain(`The backup may run on its own, once a day, until ${RULE_DAY}.`);
    expect(details).toContain(`The restore test may run on its own, once a week, until ${RULE_DAY}.`);
    expect(details).toContain(`The offsite copy may be sent on its own, once a day, until ${RULE_DAY}.`);
    expect(details).not.toMatch(/[{}"\[\]]|backup\.local|restore\.drill|pattern|expiresAt/);
    expect(rows[1]!.shown()).toContain('Turn On the Deploy Source');
    expect(rows[1]!.shown()).toContain('Turn On the Deploy SourceDeploy results are read every minute.');
    expect(rows[2]!.shown()).toContain('Add 1 Person from Calendar');
    expect(rows[2]!.shown()).toContain('Outside Text');
    // Opening a row shows its facts; the invitation's markup arrives as literal text.
    rows[2]!.onclick!();
    expect(ids.apprlist!.children[0]!.children[2]!.shown()).toContain('<img src=x onerror=alert(1)>Ada');
    // Each asks on its own: the rules card would let backups run alone, the source card changes what Flint reads, and the person card holds outside text.
    expect(rows[0]!.shown()).toContain('Asks on Its Own');
    expect(rows[1]!.shown()).toContain('Asks on Its Own');
    expect(noteSays()).toBe('You have 3 approvals waiting. Approve All skips 3.');
    expect(ids.apprall!.textContent).toBe('Approve All with Password');
    expect(ids.apprhelp!.hidden).toBe(true);
  });

  it('Approve and Reject on the open card take the signed path chat cards use; outside text asks on its own', async () => {
    answer = () => ({ status: 200, body: { signed: true, proposals: [plain(), card({ id: 'pr2', tainted: true, fullName: 'world.person.create', kind: 'tool_call', args: { people: [] } }), card({ id: 'pr3' })] } });
    await open();
    const first = ids.apprlist!.children[0]!.children[0]!;
    first.button('Approve with Password').onclick!();
    // The args the card shows go with it: what is signed must hash to them (the main script checks the challenge).
    expect(decided[0]).toEqual(['approve', 'pr1', { reason: 'approve: Read What Triage Decided', fresh: false, args: { lane: 'relevant' } }]);
    // (Reject is taken once that approval has settled: nothing else on the list is, while a prompt is up.)
    first.button('Reject').onclick!();
    expect(decided).toHaveLength(1);
    await settle();
    first.button('Reject').onclick!();
    expect(decided[1]).toEqual(['reject', 'pr1']);
    ids.apprlist!.children[0]!.children[1]!.onclick!();
    ids.apprlist!.children[0]!.children[1]!.button('Approve with Password').onclick!();
    expect(decided[2]![2]).toEqual({ reason: 'approve: Add 0 People from Calendar', fresh: true, args: { people: [] } });
    await settle();
    // A card that turns a source on changes what Flint reads: a fresh touch for it too.
    ids.apprlist!.children[0]!.children[2]!.onclick!();
    ids.apprlist!.children[0]!.children[2]!.button('Approve with Password').onclick!();
    expect(decided[3]![2]).toEqual({ reason: 'approve: Turn On the Deploy Source', fresh: true, args: { source: 'deploy' } });
  });

  it('Approve All signs each card in turn after one prompt, and leaves outside text and money for their own', async () => {
    answer = () => ({
      status: 200,
      body: { signed: true, proposals: [plain({ id: 'a' }), plain({ id: 'b', args: { lane: 'quiet' } }), plain({ id: 't', tainted: true }), card({ id: 'm', fullName: 'spend.purchase' }), plain({ id: 'c', fullName: 'runtime.ledger_open', args: {} }), card({ id: 's' })] },
    });
    await open();
    // Outside text, money and a source to turn on are each left for their own approval.
    expect(noteSays()).toBe('You have 6 approvals waiting. Approve All skips 3.');
    run('approveAll()');
    await settle();
    expect(decided.map((d) => d[1])).toEqual(['a', 'b', 'c']);
    expect(decided[0]![2]).toEqual({ reason: 'approve 3 Flint cards', args: { lane: 'relevant' } });
    expect(decided[1]![2]).toEqual({ reason: 'approve: Read What Triage Decided', args: { lane: 'quiet' } });
    expect(ids.apprnote!.textContent).toBe('You approved 3 of 3.');
  });

  it('Approve All stops at the first card that is not approved, and says how far it got', async () => {
    answer = () => ({ status: 200, body: { signed: true, proposals: [plain({ id: 'a' }), plain({ id: 'b' }), plain({ id: 'c' })] } });
    await open();
    failApprove = 'b';
    run('approveAll()');
    await settle();
    expect(decided.map((d) => d[1])).toEqual(['a', 'b']);
    // A prompt Will dismissed is said as that, the same sentence a single card says: never "Cancelled.".
    expect(ids.apprnote!.textContent).toBe('You approved 1 of 3. You dismissed the prompt. The card is waiting in Approvals.');
    // Anything else is the sentence it came with.
    decided = [];
    failWith = 'The runtime isn’t answering.';
    run('approveAll()');
    await settle();
    expect(decided.map((d) => d[1])).toEqual(['a', 'b']);
    expect(ids.apprnote!.textContent).toBe('You approved 1 of 3. The runtime isn’t answering.');
    expect(run('promptDismissed(new Error("Not Confirmed"))')).toBe(true);
    expect(run('promptDismissed({name:"NotAllowedError",message:"The operation either timed out or was not allowed."})')).toBe(true);
    for (const e of ['new Error("not confirmed by the runtime")', 'new Error("It stopped.")', 'null', '"Cancelled."']) expect(run(`promptDismissed(${e})`), e).toBe(false);
  });

  it('a device without an approval key is pointed to Settings', async () => {
    keyed = false;
    answer = () => ({ status: 200, body: { signed: true, proposals: [card()] } });
    await open();
    expect(ids.apprnote!.textContent).toBe('This device needs an approval key.');
    expect(ids.apprall!.textContent).toBe('Open Settings');
    ids.apprall!.onclick!();
    expect(panels.settings).toBe(true);
    expect(panels.approvals).toBe(false);
  });

  it('an approved card that did not run can be run; nothing waiting says so; a runtime that is down says so', async () => {
    answer = () => ({ status: 200, body: { signed: true, proposals: [card({ status: 'approved' })] } });
    await open();
    expect(ids.apprseg!.hidden).toBe(false);
    expect(ids.apprlist!.shown()).toBe('Nothing Waiting');
    run("apprShow('approved')");
    const row = ids.apprlist!.children[0]!.children[0]!;
    expect(row.shown()).toContain('Turn On the Deploy SourceApproved. It hasn’t run yet.');
    row.button('Run Now').onclick!();
    await settle();
    expect(calls.at(-1)).toEqual({ url: '/proposals/run', method: 'POST', body: { id: 'pr1' } });
    answer = () => ({ status: 200, body: { signed: true, proposals: [], runtime: 'down' } });
    await open();
    expect(ids.apprseg!.hidden).toBe(true);
    expect(ids.apprhelp!.textContent).toBe('The runtime isn’t answering, so approvals can’t load.');
    // Only the help line: "Nothing Waiting" would say the opposite.
    expect(ids.apprlist!.shown()).toBe('');
    expect(ids.apprfoot!.hidden).toBe(true);
    // Back up, an empty list says so again.
    answer = () => ({ status: 200, body: { signed: true, proposals: [] } });
    await open();
    expect(ids.apprhelp!.hidden).toBe(true);
    expect(ids.apprlist!.shown()).toBe('Nothing Waiting');
    answer = () => ({ status: 500, body: {} });
    await open();
    expect(ids.apprlist!.shown()).toContain("Couldn't Load Approvals");
  });

  it('the header badge counts the cards waiting for a signature, hidden at none', async () => {
    answer = () => ({ status: 200, body: { signed: true, proposals: [card(), card({ id: 'pr2' }), card({ id: 'pr3', status: 'approved' })] } });
    run('pollApprovals()');
    await settle();
    expect(ids.apprbadge!.textContent).toBe('2');
    expect(ids.apprbadge!.hidden).toBe(false);
    answer = () => ({ status: 200, body: { signed: true, proposals: Array.from({ length: 12 }, (_, i) => card({ id: `p${i}` })) } });
    run('pollApprovals()');
    await settle();
    expect(ids.apprbadge!.textContent).toBe('9+');
    answer = () => ({ status: 200, body: { signed: true, proposals: [] } });
    run('pollApprovals()');
    await settle();
    expect(ids.apprbadge!.hidden).toBe(true);
  });

  it('a destructive card asks on its own, and an unknown action is described without its internal name', async () => {
    answer = () => ({ status: 200, body: { signed: true, proposals: [card({ id: 'd', fullName: 'mcp.files.wipe', destructive: true, args: {} }), card({ id: 'n', fullName: 'world.unknown.thing', args: {} })] } });
    await open();
    const rows = ids.apprlist!.children[0]!.children;
    expect(rows[0]!.shown()).toContain('Can’t Be Undone');
    expect(rows[1]!.shown()).toContain('Approve World Unknown ThingYou filed this.');
    expect(rows[1]!.shown()).not.toContain('world.unknown.thing');
    expect(noteSays()).toBe('You have 2 approvals waiting. Approve All skips 1.');
    run('approveAll()');
    await settle();
    expect(decided.map((d) => d[1])).toEqual(['n']);
  });

  it('a person card names each address it would store, and keeps a "Last, First" name whole', async () => {
    const people = [
      { name: 'Kim, Alex', email: 'alex.kim@corp.example', emailHash: 'a'.repeat(64) },
      { name: 'Mom', email: 'mallory@evil.example', emailHash: 'b'.repeat(64) },
      { name: 'sam@corp.example', email: 'sam@corp.example', emailHash: 'c'.repeat(64) },
    ];
    answer = () => ({ status: 200, body: { signed: true, proposals: [card({ id: 'pp', fullName: 'world.person.create', kind: 'tool_call', origin: 'runtime:google_calendar', tainted: true, args: { people } })] } });
    await open();
    const shown = ids.apprlist!.children[0]!.children[0]!.shown();
    expect(shown).toContain('Add 3 People from Calendar');
    expect(shown).toContain('PeopleKim, Alex, alex.kim@corp.example · Mom, mallory@evil.example · sam@corp.example');
    expect(shown).not.toMatch(/[()]/);
    expect(shown).not.toContain('a'.repeat(64));
    expect(shown).toContain('Outside Text');
    // A card that names no calendar is Google's, as every P2.5 card was.
    expect(shown).toContain('They’re from Google Calendar events you accepted or organized.');
  });

  it('a person card says which calendar its people came from in its subtitle, the one Will signs, and still says when it expires', async () => {
    const people = [{ name: 'Ada Lovelace', email: 'ada@example.com', emailHash: 'a'.repeat(64) }];
    const shown = async (args: Record<string, unknown>) => {
      answer = () => ({ status: 200, body: { signed: true, proposals: [card({ id: 'pc', fullName: 'world.person.create', kind: 'tool_call', origin: 'runtime:apple_calendar', tainted: true, args })] } });
      await open();
      const row = ids.apprlist!.children[0]!.children[0]!;
      const dl = row.all().find((e) => e.tagName === 'dl')!;
      return { text: row.shown(), facts: dl.children.map((e) => e.textContent) };
    };
    const apple = await shown({ people, source: 'apple_calendar' });
    expect(apple.text).toContain('They’re from Apple Calendar events you accepted or organized.');
    expect(apple.facts).toEqual(['People', 'Ada Lovelace, ada@example.com', 'Filed By', 'Flint', 'Expires', run(`apprDate('2026-10-12T14:00:00.000Z')`)]);
    expect((await shown({ people, source: 'google_calendar' })).text).toContain('They’re from Google Calendar events you accepted or organized.');
    expect((await shown({ people })).text).toContain('They’re from Google Calendar events you accepted or organized.');
  });

  it('the calendar’s cards: its enable card states the source’s real cadence; the promotion that lets Flint add people is in words and asks on its own', async () => {
    const src = readFileSync(join(__dirname, '..', '..', 'runtime', 'src', 'sources', 'google', 'calendar.ts'), 'utf8');
    const minutes = Number(/cadenceMs: (\d+) \* 60_000/.exec(src)![1]);
    const promo = card({ id: 'pz', fullName: 'policy.change', kind: 'policy', args: { rows: [{ pattern: 'world.sync.google_calendar', tier: 'alone', expiresAt: RULE_UNTIL }, { pattern: 'world.person.create', tier: 'alone', dailyCap: 20, expiresAt: RULE_UNTIL }] } });
    answer = () => ({ status: 200, body: { signed: true, proposals: [promo, card({ id: 'gc', args: { source: 'google_calendar' } })] } });
    await open();
    const rows = ids.apprlist!.children[0]!.children;
    expect(rows[0]!.shown()).toContain('LimitsGoogle Calendar Reads · People from Your Calendar 20 a Day');
    expect(rows[0]!.shown()).toContain('Asks on Its Own');
    expect(rows[1]!.shown()).toContain('Turn On the Google Calendar Source');
    expect(rows[1]!.shown()).toContain(`Your Google Calendar is read every ${minutes} minutes.`);
    // Neither rides Approve All: one lets Flint add people by itself, the other changes what Flint reads.
    expect(rows[1]!.shown()).toContain('Asks on Its Own');
    run('approveAll()');
    await settle();
    expect(decided).toEqual([]);
  });

  it('Apple Calendar’s cards (P2.6): turning it on says how it reads in a sentence; its promotion is in words and asks on its own, as every card that lets something run alone does', async () => {
    const src = readFileSync(join(__dirname, '..', '..', 'runtime', 'src', 'sources', 'apple', 'calendar.ts'), 'utf8');
    const minutes = Number(/cadenceMs: (\d+) \* 60_000/.exec(src)![1]);
    const promo = card({ id: 'pa', fullName: 'policy.change', kind: 'policy', args: { rows: [{ pattern: 'world.sync.apple_calendar', tier: 'alone', expiresAt: RULE_UNTIL }] } });
    answer = () => ({ status: 200, body: { signed: true, proposals: [promo, card({ id: 'ac', args: { source: 'apple_calendar' } })] } });
    await open();
    const rows = ids.apprlist!.children[0]!.children;
    expect(rows[0]!.shown()).toContain('LimitsApple Calendar Reads');
    // It carries no mark here (an older server's card): the rows say it lets something run alone, and that is enough.
    expect(promo).not.toHaveProperty('consequential', true);
    expect(rows[0]!.shown()).toContain('Asks on Its Own');
    expect(rows[1]!.shown()).toContain('Asks on Its Own');
    run('approveAll()');
    await settle();
    expect(decided).toEqual([]);
    expect(rows[1]!.shown()).toContain('Turn On the Apple Calendar Source');
    expect(rows[1]!.shown()).toContain(`Your Apple Calendar is read every ${minutes} minutes and when it changes.`);
  });

  it('a signed card’s outcome is in sentences: who was added and who was not; done, approved or failed, with the server’s note after', () => {
    // resText through errText (showOutcome makes each part a sentence with it).
    const fns = /(function resText[\s\S]*?)function failed/.exec(html)![1]!;
    const c: Record<string, unknown> = {};
    createContext(c);
    runInContext(fns, c);
    const say = (action: Record<string, unknown>) => {
      const r = new El('div'), row = new El('div');
      (c.showOutcome as (d: unknown, r: El, row: El) => void)({ action }, r, row);
      return r.textContent;
    };
    expect(say({ status: 'done', result: { created: 0, skipped: 3 } })).toBe('Flint added no one and skipped 3.');
    expect(say({ status: 'done', result: { created: 2, skipped: 1 } })).toBe('Flint added 2 people and skipped 1.');
    expect(say({ status: 'done', result: { created: 1, skipped: 0 } })).toBe('Flint added 1 person.');
    expect(say({ status: 'done', result: { created: 0, skipped: 0 } })).toBe('Flint added no one.');
    expect(say({ status: 'done', note: 'Flint will record the result once the runtime answers.', result: { relationId: 'r1' } })).toBe('Done. Flint will record the result once the runtime answers.');
    expect(say({ status: 'done' })).toBe('Done.');
    expect(say({ status: 'approved' })).toBe('Approved. It hasn’t run yet.');
    expect(say({ status: 'approved', note: 'Approved. It runs tonight at 2:15 AM.' })).toBe('Approved. It runs tonight at 2:15 AM.');
    // A tool's own words, as a sentence; then the note as its own.
    expect(say({ status: 'error', error: 'quota exceeded', note: 'The runtime didn’t record the result, so it will show as unknown.' })).toBe('Quota exceeded. The runtime didn’t record the result, so it will show as unknown.');
    expect(say({ status: 'error' })).toBe('It failed.');
    const refused = new El('div'), row = new El('div');
    (c.showOutcome as (d: unknown, r: El, row: El) => void)({ error: 'this device needs an approval key. Add one in Settings.' }, refused, row);
    expect(refused.textContent).toBe('This device needs an approval key. Add one in Settings.');
    const rejected = new El('div');
    (c.showDecision as (d: unknown, decision: string, r: El, row: El) => void)({}, 'reject', rejected, new El('div'));
    expect(rejected.textContent).toBe('Rejected.');
  });

  it('a chat lookup in Flint’s world model is named in words, the same words its notes use, for every tool the runtime connector serves', async () => {
    answer = () => ({ status: 200, body: { signed: true, proposals: [card({ id: 'w', fullName: 'runtime.world_now', origin: 'chat:abc', args: {} })] } });
    await open();
    const shown = ids.apprlist!.children[0]!.children[0]!.shown();
    expect(shown).toContain('Check What’s Happening Now');
    expect(shown).not.toMatch(/runtime|World Now/);
    // Its line under the title is a sentence, open or closed.
    expect(shown).toContain('Check What’s Happening NowFlint checks its services and what is waiting on you.');
    expect(run(`apprSub({fullName:'runtime.world_now',args:{}})`)).toBe('Flint checks its services and what is waiting on you.');
    const tools = run('APPR_TOOLS') as Record<string, [string, string]>;
    const src = readFileSync(join(__dirname, '..', '..', '..', 'packages', 'mcp', 'connectors', 'runtime-server.ts'), 'utf8');
    const served = [...src.matchAll(/registerTool\(\s*'([a-z_]+)'/g)].map((m) => `runtime.${m[1]}`).sort();
    expect(served.length).toBeGreaterThan(0);
    expect(Object.keys(tools).sort()).toEqual(served);
    for (const name of served) expect(tools[name]![0]).toBe(ACTION_WORDS[name]);
  });

  it('a nightly card says when its job runs it: before approval, and once approved (with no Run Now, which could not run it)', async () => {
    const nightly = (id: string, fullName: string, status = 'pending') => card({ id, fullName, origin: `runtime:${id}`, status, args: { day: '2026-10-06' } });
    answer = () => ({ status: 200, body: { signed: true, proposals: [nightly('backup', 'backup.local'), nightly('offsite', 'backup.offsite'), nightly('drill', 'restore.drill'), nightly('retention', 'maintenance.retention')] } });
    await open();
    const rows = ids.apprlist!.children[0]!.children;
    expect(rows.map((r) => r.shown().replace(/1h$/, ''))).toEqual([
      expect.stringContaining('Run Tonight\'s BackupIt runs tonight at 2:15 AM if you approve it.'),
      'Run Tonight\'s Offsite CopyIt runs tonight at 2:15 AM if you approve it.',
      'Run This Week\'s Restore TestIt runs Sunday at 2:15 AM if you approve it.',
      'Run Tonight\'s CleanupIt runs tonight at 3:10 AM if you approve it.',
    ]);
    answer = () => ({ status: 200, body: { signed: true, proposals: [nightly('backup', 'backup.local', 'approved'), nightly('drill', 'restore.drill', 'approved'), nightly('retention', 'maintenance.retention', 'approved'), card({ id: 'tool', fullName: 'runtime.world_now', status: 'approved' })] } });
    await open();
    run("apprShow('approved')");
    const done = ids.apprlist!.children[0]!.children;
    expect(done.map((r) => r.shown())).toEqual([
      'Run Tonight\'s BackupApproved. It runs tonight at 2:15 AM.',
      'Run This Week\'s Restore TestApproved. It runs Sunday at 2:15 AM.',
      'Run Tonight\'s CleanupApproved. It runs tonight at 3:10 AM.',
      'Check What’s Happening NowApproved. It hasn’t run yet.Run Now',
    ]);
    for (const r of done.slice(0, 3)) expect(() => r.button('Run Now')).toThrow();
    done[3]!.button('Run Now').onclick!();
    await settle();
    expect(calls.at(-1)).toEqual({ url: '/proposals/run', method: 'POST', body: { id: 'tool' } });
  });

  it('removing old backups is a card of its own: it says how much would go, that it cannot be undone, and it asks on its own', async () => {
    const prune = (over: Record<string, unknown> = {}) => card({
      id: 'prune', fullName: 'backup.prune', kind: 'tool_call', origin: 'runtime:prune', destructive: true, args: { day: '2026-10-06', copies: 4, megabytes: 812, digest: '3f'.repeat(32) },
      reason: 'It waits for your approval each night there are old backups to remove, until you let it run on its own.', ...over,
    });
    answer = () => ({ status: 200, body: { signed: true, proposals: [prune(), card({ id: 'b', fullName: 'backup.local', kind: 'tool_call', origin: 'runtime:backup', args: { day: '2026-10-06' } })] } });
    await open();
    const row = ids.apprlist!.children[0]!.children[0]!;
    const shown = row.shown();
    expect(shown).toContain('Remove Old BackupsFlint deletes update backups past the newest 10 and the last 30 days.');
    expect(shown).toContain('Can’t Be Undone');
    expect(shown).not.toMatch(/backup\.prune|Backup Prune|pre-migrate/);
    // It deletes, so Approve All leaves it out, and its own approval is a fresh touch.
    expect(run(`apprAlone(${JSON.stringify(prune())})`)).toBe(true);
    expect(ids.apprnote!.shown()).toContain('Approve\u00a0All\u00a0skips\u00a01.');
    // Show Details: how much, what an update backup is, what always stays, and when it runs. Its numbers are in the sentence, so they are not listed again.
    const d = run(`apprDetails(${JSON.stringify(prune())})`) as { says: string[]; facts: string[][]; refs: string[][] };
    expect(d.says).toEqual([
      'It deletes 4 old update backups, which frees 812 MB.',
      'It deletes only the ones counted for this card, even if more grow old before it runs.',
      'An update backup is the copy of the database Flint takes before an update changes it.',
      'The one taken before the version that is running is always kept.',
      'It runs tonight at 2:15 AM if you approve it.',
    ]);
    expect(JSON.stringify(d.facts)).not.toMatch(/Copies|Megabytes/);
    // Which ones is signed too: the digest of their list is under REFERENCES, exactly, and in no sentence.
    expect(d.refs).toEqual([['Digest', '3f'.repeat(32)]]);
    expect(d.says.join(' ')).not.toContain('3f3f');
    for (const line of d.says) expect(noteProblems('Remove Old Backups', line), line).toEqual([]);
    // A card from before the digest (or with one that is not a digest) promises nothing about which.
    const older = run(`apprDetails(${JSON.stringify(prune({ args: { day: '2026-10-06', copies: 1, megabytes: 3 } }))})`) as { says: string[] };
    expect(older.says.slice(0, 2)).toEqual(['It deletes 1 old update backup, which frees 3 MB.', 'An update backup is the copy of the database Flint takes before an update changes it.']);
    expect((run(`apprDetails(${JSON.stringify(prune({ args: { day: '2026-10-06', copies: 1, megabytes: 3, digest: 'all of them' } }))})`) as { says: string[] }).says.join(' ')).not.toMatch(/only the ones/);
    // A card with no count (an older Flint's) says the rest, and nothing it does not know; odd values are listed as they are, never put in a sentence.
    const bare = run(`apprDetails(${JSON.stringify(prune({ args: { day: '2026-10-06' } }))})`) as { says: string[] };
    expect(bare.says[0]).toBe('An update backup is the copy of the database Flint takes before an update changes it.');
    const odd = run(`apprDetails(${JSON.stringify(prune({ args: { day: '2026-10-06', copies: '4; rm -rf', megabytes: -1 } }))})`) as { says: string[]; facts: string[][] };
    expect(odd.says.join(' ')).not.toMatch(/rm -rf|-1/);
    expect(JSON.stringify(odd.facts)).toContain('4; rm -rf');
    // Approved, it says when the nightly job runs it, with no Run Now (the server cannot run it).
    answer = () => ({ status: 200, body: { signed: true, proposals: [prune({ status: 'approved' })] } });
    await open();
    run("apprShow('approved')");
    const done = ids.apprlist!.children[0]!.children[0]!;
    expect(done.shown()).toBe('Remove Old BackupsApproved. It runs tonight at 2:15 AM.');
    expect(() => done.button('Run Now')).toThrow();
    // A rule that lets it run on its own is named for what it is, never as one of the backups.
    const rule = (rows: Array<Record<string, unknown>>) => run(`apprTitle(${JSON.stringify(card({ fullName: 'policy.change', kind: 'policy', consequential: true, args: { rows } }))})`);
    const until = '2027-01-10T00:00:00.000Z';
    expect(rule([{ pattern: 'backup.prune', tier: 'alone', dailyCap: 1, expiresAt: until }])).toBe('Let Flint Remove Old Backups on Its Own');
    expect(run(`apprSub(${JSON.stringify(card({ fullName: 'policy.change', kind: 'policy', consequential: true, args: { rows: [{ pattern: 'backup.prune', tier: 'alone', dailyCap: 1, expiresAt: until }] } }))})`))
      .toMatch(/^Until [A-Z][a-z]+ \d+(, \d{4})?, Flint deletes update backups past the newest 10 and the last 30 days\.$/);
    expect(rule([{ pattern: 'backup.local', tier: 'alone', expiresAt: until }, { pattern: 'backup.offsite', tier: 'alone', expiresAt: until }])).toBe('Run Backups on Their Own');
    expect(rule([{ pattern: 'backup.local', tier: 'alone', expiresAt: until }, { pattern: 'backup.prune', tier: 'alone', expiresAt: until }])).not.toBe('Run Backups on Their Own');
  });

  it('Nexus’s own backup has three cards: each says what it does, what it never changes, and when its job runs it', async () => {
    const nexus = (id: string, fullName: string, status = 'pending') => card({
      id, fullName, origin: `runtime:${id}`, status, args: { day: '2026-10-06' },
      reason: `It waits for your approval each ${fullName === 'restore.drill.nexus' ? 'week' : 'night'} until you let it run on its own.`,
    });
    const three = (status?: string) => [nexus('nexus-backup', 'backup.nexus', status), nexus('nexus-offsite', 'backup.nexus.offsite', status), nexus('nexus-drill', 'restore.drill.nexus', status)];
    answer = () => ({ status: 200, body: { signed: true, proposals: three() } });
    await open();
    const rows = ids.apprlist!.children[0]!.children;
    expect(rows.map((r) => r.shown().replace(/1h$/, ''))).toEqual([
      expect.stringContaining('Run Tonight\'s Nexus BackupIt runs tonight at 2:15 AM if you approve it.'),
      'Run Tonight\'s Nexus Offsite CopyIt runs tonight at 2:15 AM if you approve it.',
      'Run This Week\'s Nexus Restore TestIt runs Sunday at 2:15 AM if you approve it.',
    ]);
    for (const r of rows) expect(r.shown()).not.toMatch(/backup\.nexus|restore\.drill|nexus_dump|flint_backup|Can’t Be Undone/);
    // They ride Approve All like Flint's own nightly cards: nothing here deletes, and nothing of Nexus is changed.
    for (const p of three()) expect(run(`apprAlone(${JSON.stringify(p)})`), p.fullName as string).toBe(false);
    // Show Details: what it does, in a sentence. (When it runs is the line under its title, said once.)
    const details = (fullName: string) => (run(`apprDetails(${JSON.stringify(nexus('x', fullName))})`) as { says: string[]; facts: string[][]; refs: string[][] });
    expect(details('backup.nexus').says).toEqual(['Flint copies the Nexus database to this Mac. It only reads Nexus, through a login with no right to change its tables.']);
    // No card says more than the runtime checks: it never promises that Nexus cannot be changed.
    for (const f of ['backup.nexus', 'backup.nexus.offsite', 'restore.drill.nexus']) expect(details(f).says.join(' ')).not.toMatch(/changes nothing|cannot change|can’t change|can change nothing/);
    expect(details('backup.nexus.offsite').says).toEqual(['The newest Nexus backup is encrypted to your key before it leaves this Mac.']);
    expect(details('restore.drill.nexus').says).toEqual(['Flint restores the newest Nexus backup into a scratch database and compares it. Nexus itself isn’t opened.']);
    for (const f of ['backup.nexus', 'backup.nexus.offsite', 'restore.drill.nexus']) {
      for (const line of details(f).says) expect(noteProblems('Nexus Backup', line), line).toEqual([]);
      // What it signs is its day, shown as a date; nothing else is on the card.
      expect(details(f).facts).toEqual([['Day', 'Oct 6']]);
      expect(details(f).refs).toEqual([]);
    }
    // Approved, each says when its job runs it, with no Run Now (the server cannot run it).
    answer = () => ({ status: 200, body: { signed: true, proposals: three('approved') } });
    await open();
    run("apprShow('approved')");
    const done = ids.apprlist!.children[0]!.children;
    expect(done.map((r) => r.shown())).toEqual([
      'Run Tonight\'s Nexus BackupApproved. It runs tonight at 2:15 AM.',
      'Run Tonight\'s Nexus Offsite CopyApproved. It runs tonight at 2:15 AM.',
      'Run This Week\'s Nexus Restore TestApproved. It runs Sunday at 2:15 AM.',
    ]);
    for (const r of done) expect(() => r.button('Run Now')).toThrow();
    // The weekly one is "next Sunday" on a Sunday past 2:15, like Flint's own restore test.
    ctx.apprNow = () => new Date(2026, 9, 4, 15, 0);
    expect(run(`apprWhen('restore.drill.nexus')`)).toBe('next Sunday at 2:15 AM');
    expect(run(`apprWhen('backup.nexus')`)).toBe('tonight at 2:15 AM');
    expect(Object.keys(run('APPR_WEEKLY') as Record<string, number>).sort()).toEqual([...WEEKLY_JOBS].sort());
    // A rule that lets them run on their own is named for Nexus, and never as Flint's own backups; Flint's own
    // three keep their title, and a Nexus rule among them is not folded in.
    const until = '2027-03-28T00:00:00.000Z';
    const rule = (patterns: string[]) => run(`apprTitle(${JSON.stringify(card({ fullName: 'policy.change', kind: 'policy', consequential: true, args: { rows: patterns.map((pattern) => ({ pattern, tier: 'alone', expiresAt: until })) } }))})`);
    expect(rule(['backup.nexus', 'backup.nexus.offsite', 'restore.drill.nexus'])).toBe('Run Nexus Backups on Their Own');
    expect(rule(['backup.local', 'backup.offsite', 'restore.drill'])).toBe('Run Backups on Their Own');
    // Flint's own rules are titled exactly as before Nexus had any: every row a backup or anything under `restore.`.
    for (const own of [['restore.drill'], ['restore.*'], ['restore.production'], ['backup.offsite', 'restore.*'], ['backup.local']]) expect(rule(own), own.join(' ')).toBe('Run Backups on Their Own');
    for (const other of [['backup.local', 'backup.prune'], ['backup.*'], ['backup.local.more'], ['restore']]) expect(rule(other), other.join(' ')).not.toBe('Run Backups on Their Own');
    expect(rule(['backup.local', 'backup.offsite', 'restore.drill', 'restore.drill.nexus'])).not.toMatch(/^Run (Nexus )?Backups on Their Own$/);
    expect(rule(['backup.local', 'backup.nexus'])).not.toMatch(/^Run (Nexus )?Backups on Their Own$/);
    for (const [pattern, words] of [['backup.nexus', 'Nexus Backup'], ['backup.nexus.offsite', 'Nexus Offsite Copy'], ['restore.drill.nexus', 'Nexus Restore Test']] as const) {
      expect((run(`apprRule(${JSON.stringify(pattern)})`) as unknown[])[0]).toBe(words);
    }
  });

  it('the restore test’s card never names a time already past: on the Sunday it was filed, it runs next Sunday', async () => {
    const drill = (status: string) => card({ id: 'drill', fullName: 'restore.drill', kind: 'tool_call', origin: 'runtime:drill', status, args: {} });
    const lines = async (now: Date) => {
      ctx.apprNow = () => now;
      answer = () => ({ status: 200, body: { signed: true, proposals: [drill('pending')] } });
      await open();
      const waiting = ids.apprlist!.children[0]!.children[0]!.shown();
      answer = () => ({ status: 200, body: { signed: true, proposals: [drill('approved')] } });
      await open();
      run("apprShow('approved')");
      return [waiting, ids.apprlist!.children[0]!.children[0]!.shown()];
    };
    // 2026-10-04 is a Sunday: the drill that filed the card ran at 2:15 AM.
    expect(await lines(new Date(2026, 9, 4, 15, 0))).toEqual([
      expect.stringContaining('It runs next Sunday at 2:15 AM if you approve it.'),
      'Run This Week\'s Restore TestApproved. It runs next Sunday at 2:15 AM.',
    ]);
    // Before 2:15 that Sunday, a card from the week before runs within the hour.
    expect((await lines(new Date(2026, 9, 4, 1, 30)))[1]).toBe('Run This Week\'s Restore TestApproved. It runs today at 2:15 AM.');
    // Any other day: Sunday.
    expect((await lines(new Date(2026, 9, 10, 23, 0)))[1]).toBe('Run This Week\'s Restore TestApproved. It runs Sunday at 2:15 AM.');
  });

  it('every line under a card’s title is a sentence, whatever filed it', () => {
    const sub = (p: Record<string, unknown>) => run(`apprSub(${JSON.stringify(p)})`) as string;
    for (const source of ['launchd', 'health', 'git', 'spend', 'deploy', 'knowledge', 'nexus_inbox', 'nexus', 'github', 'railway', 'google_calendar', 'apple_calendar', 'unknown_source']) {
      expect(sub({ fullName: 'world.source.enable', kind: 'tool_call', args: { source } })).toMatch(/^[A-Z].*\.$/);
    }
    expect(sub({ fullName: 'world.source.enable', kind: 'tool_call', args: { source: 'unknown_source' } })).toBe('Flint starts reading this source.');
    expect(sub({ fullName: 'policy.change', kind: 'policy', args: { rows: [{}] } })).toBe('It changes what Flint may do on its own.');
    // A card that names no calendar is Google's, as every P2.5 card was.
    expect(sub({ fullName: 'world.person.create', kind: 'tool_call', args: {} })).toBe('They’re from Google Calendar events you accepted or organized.');
    expect(sub({ fullName: 'world.person.create', kind: 'tool_call', args: { source: 'apple_calendar' } })).toBe('They’re from Apple Calendar events you accepted or organized.');
    expect(sub({ fullName: 'triage.rule.create', kind: 'rule', args: {} })).toBe('This adds a new rule.');
    expect(sub({ fullName: 'triage.rule.create', kind: 'rule', args: { rule: { name: 'ci-red' } } })).toBe('This adds the rule “ci-red”.');
    expect(sub({ fullName: 'world.relation.write', kind: 'tool_call', args: {} })).toBe('Flint’s memory suggests this link.');
    expect(sub({ fullName: 'mcp.x', origin: 'console' })).toBe('You filed this.');
    expect(sub({ fullName: 'mcp.x', origin: 'runtime:knowledge' })).toBe('Flint filed this.');
    expect(sub({ fullName: 'mcp.x', origin: 'chat:abc' })).toBe('A chat filed this.');
    expect(sub({ fullName: 'mcp.x', origin: 'somewhere' })).toBe('Its source is unknown.');
    expect(sub({ fullName: 'mcp.x' })).toBe('Its source is unknown.');
    for (const [, line] of Object.values(run('APPR_TOOLS') as Record<string, [string, string]>)) expect(line).toMatch(/^Flint .*\.$/);
  });

  it('one card waiting says so in the singular', async () => {
    answer = () => ({ status: 200, body: { signed: true, proposals: [plain()] } });
    await open();
    expect(noteSays()).toBe('You have 1 approval waiting.');
  });

  it('P3’s cards in words: a title, a sentence and their facts for every goal and plan action; never the raw action name', async () => {
    const h = '2026-12-01T23:59:00.000Z';
    const crit = [{ id: 'c1', text: 'Synthetic check', check: { kind: 'manual' } }, { id: 'c2', text: 'Synthetic other', check: { kind: 'manual' } }, { id: 'c3', text: 'x', check: { kind: 'manual' } }];
    const say = (p: Record<string, unknown>) => {
      const c = { origin: 'console', expiresAt: '2026-10-16T14:00:00.000Z', ...p };
      return [run(`apprTitle(${JSON.stringify(c)})`), run(`apprSub(${JSON.stringify(c)})`), JSON.parse(JSON.stringify(run(`apprFacts(${JSON.stringify(c)})`))), run(`apprIcon(${JSON.stringify(c)})`)];
    };
    expect(say({ fullName: 'goal.activate', kind: 'goal', args: { title: 'Synthetic goal', successCriteria: crit, horizonAt: h }, reason: 'Approving starts this goal.' }))
      .toEqual(['Add a Goal', 'It starts as soon as you approve.', [['Goal', 'Synthetic goal'], ['Checks', '3 Checks'], ['Finish By', run(`apprDate('${h}')`)]], 'target']);
    expect(say({ fullName: 'goal.activate', kind: 'goal', args: { title: 'Synthetic goal', successCriteria: crit.slice(0, 1), horizonAt: null, origin: 'flint' } }).slice(0, 3))
      .toEqual(['Activate a Goal', 'It starts as soon as you approve.', [['Goal', 'Synthetic goal'], ['Checks', '1 Check'], ['Finish By', 'No Date']]]);
    expect(say({ fullName: 'goal.activate', kind: 'goal', args: { title: 'Synthetic goal', successCriteria: crit }, reason: 'Approving resumes this goal.' }).slice(0, 2)).toEqual(['Resume a Goal', 'It resumes as soon as you approve.']);
    expect(say({ fullName: 'goal.criteria_change', kind: 'goal', args: { title: 'Synthetic goal', successCriteria: crit } }).slice(0, 3)).toEqual(['Change a Goal', 'This changes what counts as done.', [['Goal', 'Synthetic goal'], ['Checks', '3 Checks']]]);
    expect(say({ fullName: 'goal.horizon_change', kind: 'goal', args: { goalTitle: 'Synthetic goal', horizonAt: null, reviewCadence: 'P2W' } }).slice(0, 3))
      .toEqual(['Change a Goal’s Timing', 'This changes its date or how often it’s reviewed.', [['Goal', 'Synthetic goal'], ['Finish By', 'No Date'], ['Review Every', '2 Weeks']]]);
    expect(say({ fullName: 'goal.done', kind: 'goal', args: { goalTitle: 'Synthetic goal' } }).slice(0, 3)).toEqual(['Mark a Goal Done', 'Flint stops reviewing it.', [['Goal', 'Synthetic goal'], ['Filed By', 'You'], ['Expires', run(`apprDate('2026-10-16T14:00:00.000Z')`)]]]);
    expect(say({ fullName: 'goal.abandon', kind: 'goal', args: { goalTitle: 'Synthetic goal' } }).slice(0, 2)).toEqual(['Abandon a Goal', 'Flint stops reviewing it, and it can’t be restarted.']);
    // A review's cards as the runtime files them: each change with the step as it is now (`from`). The dates move by two days.
    const was = new Date(Date.parse(h) - 2 * 86_400_000).toISOString();
    const ops = [
      { op: 'add', key: 's4' }, { op: 'set', key: 's1', from: { title: 'Synthetic step one', dueAt: was }, to: { dueAt: h } },
      { op: 'set', key: 's2', from: { title: 'Synthetic step two', dueAt: was }, to: { dueAt: h } }, { op: 'set', key: 's3', from: { title: 'Synthetic step three', status: 'todo' }, to: { status: 'blocked' } },
    ];
    expect(say({ fullName: 'plan.change', kind: 'plan', origin: 'runtime:goals', templateId: 'plan.diff.minor', args: { goalTitle: 'Synthetic goal', ops: ops.slice(1) } }).slice(0, 3))
      .toEqual(['Update a Plan', 'Flint suggests 3 small changes.', [['Goal', 'Synthetic goal'], ['Changes', 'Move 2 Dates · Mark 1 Blocked'], ['Filed By', 'Flint']]]);
    expect(say({ fullName: 'plan.change', kind: 'plan', origin: 'runtime:goals', templateId: 'plan.diff.material', args: { goalTitle: 'Synthetic goal', ops: ops.slice(0, 1) } }).slice(0, 2)).toEqual(['Change a Plan', 'Flint suggests a bigger change.']);
    expect(say({ fullName: 'plan.change', kind: 'plan', args: { goalTitle: 'Synthetic goal', ops: ops.slice(0, 1) } }).slice(0, 3)).toEqual(['Change a Plan', 'You asked for this change.', [['Goal', 'Synthetic goal'], ['Changes', 'Add 1 Step'], ['Filed By', 'You']]]);
    // What chat suggested (part 5), as the candidates intake files it: the short text, Will's own words, and the day Flint read (never called his).
    expect(say({ fullName: 'goal.propose', kind: 'goal', origin: 'chat:c1', templateId: 'chat.goal', args: { goalId: 'go4f4f4f4f4f4f4f4f', title: 'Synthetic goal', quote: 'I want to run a half marathon', dueOn: '2027-03-20', saidAt: h, sourceRef: `chat:${'4f'.repeat(32)}` } }).slice(0, 3))
      .toEqual(['Suggest a Goal from Chat', 'You said this in a chat.', [['Goal', 'Synthetic goal'], ['You Said', 'I want to run a half marathon'], ['Day Flint Read', 'Mar 20, 2027']]]);
    expect(say({ fullName: 'goal.propose', kind: 'goal', origin: 'chat:c1', args: { title: 'Synthetic goal', quote: 'I want to run a half marathon' } })[2]).toEqual([['Goal', 'Synthetic goal'], ['You Said', 'I want to run a half marathon']]);
    expect(say({ fullName: 'world.commitment.from_chat', kind: 'tool_call', origin: 'chat:c1', templateId: 'chat.commitment', args: { text: 'Send it', quote: 'I will send it by Friday', saidAt: h, sourceRef: `chat:${'4f'.repeat(32)}` } }).slice(0, 3))
      .toEqual(['Add a Commitment from Chat', 'You said this in a chat.', [['Commitment', 'Send it'], ['You Said', 'I will send it by Friday']]]);
    expect(say({ fullName: 'world.commitment.from_chat', kind: 'tool_call', origin: 'chat:c1', args: { text: 'Send it', quote: 'I will send it by Friday', dueOn: '2027-03-20' } })[2]).toEqual([['Commitment', 'Send it'], ['You Said', 'I will send it by Friday'], ['Day Flint Read', 'Mar 20, 2027']]);
    // The titles are the ones Will's notes use for the same two actions.
    expect(say({ fullName: 'goal.propose', kind: 'goal', args: {} })[0]).toBe(ACTION_WORDS['goal.propose']);
    expect(say({ fullName: 'world.commitment.from_chat', kind: 'tool_call', args: {} })[0]).toBe(ACTION_WORDS['world.commitment.from_chat']);
    // A card whose args were cleared says what it still knows, and no empty facts.
    expect(say({ fullName: 'goal.done', kind: 'goal', args: null })[2]).toEqual([['Filed By', 'You'], ['Expires', run(`apprDate('2026-10-16T14:00:00.000Z')`)]]);
    expect(say({ fullName: 'goal.activate', kind: 'goal', args: null }).slice(0, 3)).toEqual(['Add a Goal', 'It starts as soon as you approve.', []]);
    // The policy card names P3's rows in words.
    expect(say({ fullName: 'policy.change', kind: 'policy', args: { rows: [{ pattern: 'goal.review.local', tier: 'alone', dailyCap: 20 }, { pattern: 'goal.propose', tier: 'alone', dailyCap: 3 }, { pattern: 'world.commitment.from_chat', tier: 'alone', dailyCap: 10 }] } })[2])
      .toContainEqual(['Limits', 'Goal Reviews 20 a Day · Goal Suggestions from Chat 3 a Day · Commitments from Chat 10 a Day']);
  });

  it('on a phone a card’s sentence wraps instead of being cut off, and the footer’s note has a line of its own above the button', () => {
    const css = /<style>([\s\S]*?)<\/style>/.exec(html)![1]!;
    const phone = /@media \(max-width:600px\)\{([\s\S]*?)\n  \}/.exec(css)![1]!;
    // A closed card's second line ("Flint suggests a bigger change.") was one line with an ellipsis.
    expect(css).toContain('.ct .sub{display:block;font-size:12px;line-height:16px;color:var(--t3);font-weight:400;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}');
    expect(phone).toContain('.ct .sub{white-space:normal;}');
    // The note beside a wide button wrapped to three lines, the last a number alone.
    expect(phone).toContain('#apprfoot{flex-wrap:wrap;} #apprfoot .note{flex-basis:100%;}');
  });

  it('every goal card, and every consequential card, asks on its own with a fresh touch and a plain prompt; what chat suggested is filed as one; a small plan change rides Approve All', async () => {
    // (Each under the kind the runtime files it under: a goal's card as a goal, a plan's as a plan, a commitment as a tool call.)
    const kindOf = (fullName: string) => (fullName === 'plan.change' ? 'plan' : fullName === 'world.commitment.from_chat' ? 'tool_call' : 'goal');
    const goalCard = (id: string, fullName: string, over: Record<string, unknown> = {}) => card({ id, fullName, kind: kindOf(fullName), origin: 'console', sensitivity: 'personal', args: { goalId: 'gotest0001', goalTitle: 'Synthetic goal', title: 'Synthetic goal' }, ...over });
    const alone = ['goal.activate', 'goal.criteria_change', 'goal.horizon_change', 'goal.done', 'goal.abandon'];
    // Even without the server's mark, a goal card's name keeps it alone (an older server).
    for (const a of alone) expect(run(`apprAlone(${JSON.stringify({ fullName: a, kind: 'goal' })})`), a).toBe(true);
    expect(run(`apprAlone(${JSON.stringify({ fullName: 'plan.change', kind: 'plan', templateId: 'plan.diff.material', consequential: true })})`)).toBe(true);
    expect(run(`apprAlone(${JSON.stringify({ fullName: 'plan.change', kind: 'plan' })})`)).toBe(true);
    expect(run(`apprAlone(${JSON.stringify({ fullName: 'world.source.enable', kind: 'tool_call', consequential: true })})`)).toBe(true);
    const small = [{ op: 'set', key: 's1', from: { title: 'Synthetic step one', status: 'todo' }, to: { status: 'blocked' } }];
    expect(run(`apprAlone(${JSON.stringify({ fullName: 'plan.change', kind: 'plan', templateId: 'plan.diff.minor', consequential: false, args: { ops: small } })})`)).toBe(false);
    // What chat suggested asks on its own by the mark the intake files it with (the runtime's choice, which a later table may change), not by its name.
    for (const [a, kind] of [['goal.propose', 'goal'], ['world.commitment.from_chat', 'tool_call']]) {
      expect(run(`apprAlone(${JSON.stringify({ fullName: a, kind, origin: 'chat:c1', consequential: true })})`), a).toBe(true);
      expect(run(`apprAlone(${JSON.stringify({ fullName: a, kind, origin: 'chat:c1' })})`), a).toBe(false);
    }
    // Review finding 2: which plan card is a small one is read from its operations, never from the template's name alone.
    const due = '2026-10-20T22:00:00.000Z';
    const minor = (ops: unknown[], over: Record<string, unknown> = {}) => ({ fullName: 'plan.change', kind: 'plan', origin: 'runtime:goals', templateId: 'plan.diff.minor', consequential: false, args: { goalTitle: 'Synthetic goal', ops }, ...over });
    const says = (p: Record<string, unknown>) => [run(`apprAlone(${JSON.stringify(p)})`), run(`apprTitle(${JSON.stringify(p)})`), run(`apprSub(${JSON.stringify(p)})`)];
    // Small: a status among not started, in progress and blocked; a date moved by a week at most; a step put elsewhere.
    expect(says(minor([
      ...small, { op: 'set', key: 's2', from: { title: 'T', dueAt: '2026-10-14T22:00:00.000Z' }, to: { dueAt: due } }, { op: 'set', key: 's3', from: { title: 'T', ordinal: 300 }, to: { ordinal: 50 } },
    ]))).toEqual([false, 'Update a Plan', 'Flint suggests 3 small changes.']);
    // Anything bigger under the same name asks on its own, and is not called small.
    const bigger: Array<[string, unknown[]]> = [
      ['a step added', [{ op: 'add', key: 's9', step: { ordinal: 900, title: 'Synthetic free text nobody templated', kind: 'flint_action', tier: 'alone' } }]],
      ['a step skipped', [{ op: 'set', key: 's1', from: { title: 'T', status: 'todo' }, to: { status: 'skipped' } }]],
      ['a skipped step brought back', [{ op: 'set', key: 's1', from: { title: 'T', status: 'skipped' }, to: { status: 'todo' } }]],
      ['a title', [{ op: 'set', key: 's1', from: { title: 'T' }, to: { title: 'Synthetic retitled step' } }]],
      ['what it depends on', [{ op: 'set', key: 's1', from: { title: 'T', dependsOn: [] }, to: { dependsOn: ['s2'] } }]],
      ['a date where there was none', [{ op: 'set', key: 's1', from: { title: 'T', dueAt: null }, to: { dueAt: due } }]],
      ['a date taken away', [{ op: 'set', key: 's1', from: { title: 'T', dueAt: due }, to: { dueAt: null } }]],
      ['a date moved over a week', [{ op: 'set', key: 's1', from: { title: 'T', dueAt: '2026-10-01T22:00:00.000Z' }, to: { dueAt: due } }]],
      ['a change that does not say what from', [{ op: 'set', key: 's1', to: { dueAt: due } }]],
      ['one small change beside a bigger one', [...small, { op: 'add', key: 's9', step: { ordinal: 900, title: 'Check on wpf002/flint #57', kind: 'will_task' } }]],
      ['nothing at all', []],
    ];
    for (const [what, ops] of bigger) expect(says(minor(ops)), what).toEqual([true, 'Change a Plan', 'Flint suggests a bigger change.']);
    // The server's own mark wins too, and a card whose args were cleared is never taken for a small one.
    expect(says(minor(small, { consequential: true }))[0]).toBe(true);
    expect(says({ fullName: 'plan.change', kind: 'plan', origin: 'runtime:goals', templateId: 'plan.diff.minor', consequential: false, args: null })[0]).toBe(true);
    answer = () => ({
      status: 200,
      body: {
        signed: true,
        proposals: [
          ...alone.map((a, i) => goalCard(`g${i}`, a, { consequential: true })),
          goalCard('pm', 'plan.change', { origin: 'runtime:goals', templateId: 'plan.diff.minor', consequential: false, args: { goalTitle: 'Synthetic goal', ops: small } }),
          // Named small, holding a skip: it does not ride Approve All.
          goalCard('px', 'plan.change', { origin: 'runtime:goals', templateId: 'plan.diff.minor', consequential: false, args: { goalTitle: 'Synthetic goal', ops: [{ op: 'set', key: 's1', from: { title: 'T', status: 'todo' }, to: { status: 'skipped' } }] } }),
          goalCard('pw', 'plan.change', { consequential: true, args: { goalTitle: 'Synthetic goal', ops: [] } }),
          goalCard('gp', 'goal.propose', { origin: 'chat:c1', templateId: 'chat.goal', consequential: true, args: { title: 'Synthetic', quote: 'Synthetic quoted words' } }),
          goalCard('gc', 'world.commitment.from_chat', { origin: 'chat:c1', templateId: 'chat.commitment', consequential: true, args: { text: 'Synthetic', quote: 'Synthetic quoted words' } }),
          plain({ id: 'src' }),
        ],
      },
    });
    await open();
    expect(noteSays()).toBe('You have 11 approvals waiting. Approve All skips 9.');
    // The second sentence is one unbreakable run, so a narrow footer never leaves "9." on a line of its own.
    expect(ids.apprnote!.textContent).toBe('You have 11 approvals waiting. Approve\u00a0All\u00a0skips\u00a09.');
    // Approve All signs only the cards that may share one prompt.
    run('approveAll()');
    await settle();
    expect(decided.map((d) => d[1])).toEqual(['pm', 'src']);
    expect(decided.every((d) => !(d[2] as { fresh?: boolean }).fresh)).toBe(true);
    // Each goal card is signed on its own, fresh, and the prompt says what it does in plain words.
    decided = [];
    const rows = () => ids.apprlist!.children[0]!.children;
    const prompts: string[] = [];
    for (let i = 0; i < alone.length; i++) {
      rows()[i]!.onclick?.();
      const r = rows()[i]!;
      expect(r.shown()).toContain('Asks on Its Own');
      r.button('Approve with Password').onclick!();
      const o = decided.at(-1)![2] as { fresh: boolean; reason: string; args: unknown };
      expect(o.fresh, alone[i]).toBe(true);
      expect(o.args).toEqual({ goalId: 'gotest0001', goalTitle: 'Synthetic goal', title: 'Synthetic goal' });
      prompts.push(o.reason);
      // (The next card opens once this approval has settled.)
      await settle();
    }
    expect(prompts).toEqual(['add this goal', 'change what counts as done for this goal', 'change this goal’s timing', 'mark this goal done', 'abandon this goal']);
    for (const p of prompts) expect(p).not.toMatch(/goal\.|approve/);
    rows()[6]!.onclick?.();
    rows()[6]!.button('Approve with Password').onclick!();
    expect(decided.at(-1)![2]).toMatchObject({ fresh: true, reason: 'change this goal’s plan' });
    await settle();
    // What chat suggested: each on its own, fresh, with a plain prompt and exactly the args it showed.
    for (const [id, reason] of [['gp', 'add this suggested goal'], ['gc', 'add this commitment']] as const) {
      const at = (JSON.parse(JSON.stringify(run('APPR.pending.map(function(c){return c.id;})'))) as string[]).indexOf(id);
      rows()[at]!.onclick?.();
      expect(rows()[at]!.shown()).toContain('Asks on Its Own');
      rows()[at]!.button('Approve with Password').onclick!();
      expect(decided.at(-1)![1]).toBe(id);
      expect(decided.at(-1)![2]).toMatchObject({ fresh: true, reason, args: { quote: 'Synthetic quoted words' } });
      await settle();
    }
  });

  it('Turn On Predictions (P4) is in words, names each number it turns on, and asks on its own with a fresh touch and a plain prompt', async () => {
    const three = ['daily.calendar.hours', 'daily.deploys.count', 'daily.spend.anthropic.usd'];
    const predict = (over: Record<string, unknown> = {}) => card({
      id: 'tp', fullName: 'forecast.series.enable', kind: 'tool_call', origin: 'console', sensitivity: 'financial', consequential: true,
      args: { series: three, reason: [] }, reason: 'Approving turns on Flint’s forecasts of these numbers, on this Mac.', ...over,
    });
    /** The card's facts, read with plain spaces ("and 8 more" is held together with no-break ones). */
    const facts = (p: Record<string, unknown>) => (JSON.parse(JSON.stringify(run(`apprFacts(${JSON.stringify(p)})`))) as string[][]).map((f) => f.map((x) => x.replace(/\u00a0/g, ' ')));
    const say = (p: Record<string, unknown>) => [run(`apprTitle(${JSON.stringify(p)})`), run(`apprSub(${JSON.stringify(p)})`), facts(p), run(`apprReason(${JSON.stringify(p)})`)];
    // Which numbers, by name (in the registry's order, whatever order the card lists them in), and that spending and the calendar are among them.
    expect(say(predict({ expiresAt: '2026-10-16T14:00:00.000Z' }))).toEqual([
      'Turn On Predictions', 'Flint forecasts 3 of its own numbers each night, on this Mac.',
      [['Numbers', 'Anthropic Spend · Deploys · Calendar Hours'], ['Includes', 'Spending and calendar numbers'], ['Filed By', 'You']], 'turn on predictions',
    ]);
    // The title is the one its notes use; one number reads right; a card whose args were cleared still reads as a sentence.
    expect(run(`apprTitle(${JSON.stringify(predict())})`)).toBe(ACTION_WORDS['forecast.series.enable']);
    const one = predict({ sensitivity: 'ops', args: { series: ['daily.deploys.count'], reason: [] } });
    expect(say(one).slice(1, 3)).toEqual(['Flint forecasts 1 of its own numbers each night, on this Mac.', [['Numbers', 'Deploys'], ['Filed By', 'You'], ['Expires', run(`apprDate('2026-10-12T14:00:00.000Z')`)]]]);
    expect(say(predict({ args: null })).slice(0, 3)).toEqual(['Turn On Predictions', 'Flint forecasts its own numbers each night, on this Mac.', [['Filed By', 'You'], ['Expires', run(`apprDate('2026-10-12T14:00:00.000Z')`)]]]);
    // Includes is said only for what is there: spending alone, the calendar alone, or neither.
    expect(facts(predict({ args: { series: ['daily.spend.openai.usd', 'daily.spend.tavily.usd'], reason: [] } })).slice(0, 2)).toEqual([['Numbers', 'OpenAI Spend · Tavily Spend'], ['Includes', 'Spending numbers']]);
    expect(facts(predict({ sensitivity: 'personal', args: { series: ['daily.calendar.hours', 'daily.threads.open'], reason: [] } })).slice(0, 2)).toEqual([['Numbers', 'Open Threads · Calendar Hours'], ['Includes', 'Calendar numbers']]);
    expect(facts(predict({ sensitivity: 'ops', args: { series: ['daily.threads.open', 'weekly.commits.flint.count'], reason: [] } })).map((f) => f[0])).toEqual(['Numbers', 'Filed By', 'Expires']);
    // The local model's second opinion: said when it is on the card, for every number or for some.
    expect(facts(predict({ args: { series: three, reason: three } }))).toEqual([['Numbers', 'Anthropic Spend · Deploys · Calendar Hours'], ['Includes', 'Spending and calendar numbers'], ['Second Opinion', 'Local Model']]);
    expect(facts(predict({ sensitivity: 'ops', args: { series: ['daily.deploys.count', 'daily.threads.open'], reason: ['daily.deploys.count'] } }))).toEqual([['Numbers', 'Deploys · Open Threads'], ['Second Opinion', 'Local Model on 1 of 2'], ['Filed By', 'You']]);
    // Up to six, every name. Past six, the first four and how many more: the whole list is behind Show Details.
    const all = ['daily.calendar.hours', 'daily.deploys.count', 'daily.services.incident_minutes', 'daily.spend.anthropic.usd', 'daily.spend.openai.usd', 'daily.spend.perplexity.usd', 'daily.spend.tavily.usd',
      'daily.threads.open', 'weekly.commits.flint.count', 'weekly.commits.helm.count', 'weekly.commits.nexus.count', 'weekly.commits.trident.count'];
    expect(facts(predict({ args: { series: all.slice(3, 9), reason: [] } }))[0]).toEqual(['Numbers', 'Anthropic Spend · OpenAI Spend · Perplexity Spend · Tavily Spend · Flint Commits · Open Threads']);
    expect(facts(predict({ args: { series: all.slice(2, 9), reason: [] } }))[0]).toEqual(['Numbers', 'Anthropic Spend · OpenAI Spend · Perplexity Spend · Tavily Spend · and 3 more']);
    expect(run(`apprFacts(${JSON.stringify(predict({ args: { series: all, reason: [] } }))})[0][1]`)).toMatch(/ · and\u00a08\u00a0more$/);
    expect(say(predict({ args: { series: all, reason: all.slice(3, 7) } })).slice(1, 3)).toEqual([
      'Flint forecasts 12 of its own numbers each night, on this Mac.',
      [['Numbers', 'Anthropic Spend · OpenAI Spend · Perplexity Spend · Tavily Spend · and 8 more'], ['Includes', 'Spending and calendar numbers'], ['Second Opinion', 'Local Model on 4 of 12']],
    ]);
    // A number this page cannot name is said to be one, and never shown by its key; on a card marked as more than ops data it counts as sensitive.
    const odd = predict({ args: { series: ['daily.deploys.count', 'daily.spend.acme.usd', 'x.y'], reason: ['x.y'] } });
    expect(facts(odd)).toEqual([['Numbers', 'Deploys · 2 Unknown Numbers'], ['Includes', 'Sensitive numbers'], ['Second Opinion', 'Local Model on 1 of 3']]);
    expect(facts(predict({ sensitivity: 'ops', args: { series: ['x.y'], reason: [] } }))[0]).toEqual(['Numbers', '1 Unknown Number']);
    for (const p of [predict(), predict({ args: { series: all, reason: all } }), odd]) {
      expect(facts(p).length).toBeLessThanOrEqual(3);
      // Never the action's internal name, a series' key, or JSON on the card's face.
      expect(`${run(`apprTitle(${JSON.stringify(p)})`)} ${run(`apprSub(${JSON.stringify(p)})`)} ${facts(p).flat().join(' ')}`).not.toMatch(/forecast\.series|daily\.|weekly\.|\.usd|\.count|acme|x\.y|[{}[\]"]/);
    }
    // It asks on its own whatever it lists: by the server's mark, and by its name alone for a server that sends none.
    expect(run(`apprAlone(${JSON.stringify({ fullName: 'forecast.series.enable', kind: 'tool_call', consequential: true, sensitivity: 'ops' })})`)).toBe(true);
    expect(run(`apprAlone(${JSON.stringify({ fullName: 'forecast.series.enable', kind: 'tool_call', sensitivity: 'ops' })})`)).toBe(true);
    answer = () => ({ status: 200, body: { signed: true, proposals: [predict({ sensitivity: 'ops', args: { series: all, reason: ['daily.deploys.count', 'daily.spend.anthropic.usd'] } }), plain({ id: 'src' })] } });
    await open();
    expect(noteSays()).toBe('You have 2 approvals waiting. Approve All skips 1.');
    const open1 = ids.apprlist!.children[0]!.children[0]!;
    expect(open1.shown()).toContain('Turn On PredictionsFlint forecasts 12 of its own numbers each night, on this Mac.');
    expect(open1.shown()).toContain('Asks on Its Own');
    // Behind Show Details: why, then every number on its own line, in words. No raw args for this card: no key, no JSON.
    const details = open1.all().find((e) => e.className === 'details')!;
    expect(details.hidden).toBe(true);
    expect(details.all().filter((e) => e.tagName === 'pre')).toEqual([]);
    // After the why: what turning predictions on does to what is already there. The first check settles every
    // prediction Flint has made so far, and nothing takes a recorded result back, so the card says so before he signs.
    const also = 'Turning this on also checks the predictions Flint has already made, and those results can’t be undone.';
    expect(details.all().filter((e) => e.tagName === 'p').map((e) => e.textContent)).toEqual(['Approving turns on Flint’s forecasts of these numbers, on this Mac.', also]);
    expect(run('APPR_PREDICT_ALSO')).toBe(also);
    // Held to the notes standard as a line of its own (under a plain title: the check reads "On" in the card's title as a small word).
    expect(noteProblems('Predictions', also)).toEqual([]);
    expect(also).toMatch(/^[A-Z][^(){}[\]`]*\.$/);
    // It is this card's alone: no other card says it.
    expect(ids.apprlist!.children[0]!.children[1]!.shown()).not.toContain('already made');
    expect(details.all().filter((e) => e.tagName === 'li').map((e) => e.textContent)).toEqual([
      'Anthropic Spend · Spending · Second Opinion', 'OpenAI Spend · Spending', 'Perplexity Spend · Spending', 'Tavily Spend · Spending', 'Deploys · Second Opinion',
      'Flint Commits', 'Nexus Commits', 'Trident Commits', 'Helm Commits', 'Service Downtime', 'Open Threads', 'Calendar Hours · Calendar',
    ]);
    open1.button('Show Details').onclick!();
    expect(details.hidden).toBe(false);
    expect(open1.shown()).not.toMatch(/forecast\.series|daily\.|weekly\.|\.usd|\.count|[{}[\]"]/);
    // Every card's details are words, the others' too: what each holds, under a label, and never its args as they are stored.
    const other = ids.apprlist!.children[0]!.children[1]!;
    other.onclick!();
    const otherDetails = ids.apprlist!.children[0]!.children[1]!.all().find((e) => e.className === 'details')!;
    expect(otherDetails.all().filter((e) => e.tagName === 'pre')).toEqual([]);
    expect(otherDetails.all().filter((e) => e.tagName === 'dt' || e.tagName === 'dd').map((e) => e.textContent)).toEqual(['Lane', 'Relevant']);
    // A number this page cannot name is counted in the list and given exactly, as a reference, behind Show Details:
    // Will signs it, so he can see it. A card whose numbers are all known has no such group.
    const refs = (p: Record<string, unknown>) => JSON.parse(JSON.stringify(run(`apprDetails(${JSON.stringify(p)}).refs`))) as string[][];
    expect(refs(odd)).toEqual([['Unknown Numbers', 'daily.spend.acme.usd, x.y'], ['Unknown Second Opinions', 'x.y']]);
    expect(refs(predict())).toEqual([]);
    expect(JSON.parse(JSON.stringify(run(`apprDetails(${JSON.stringify(predict())})`)))).toEqual({ says: [also], facts: [], refs: [], withheld: '' });
    ids.apprlist!.children[0]!.children[0]!.onclick!();
    run('approveAll()');
    await settle();
    expect(decided.map((d) => d[1])).toEqual(['src']);
    decided = [];
    ids.apprlist!.children[0]!.children[0]!.button('Approve with Password').onclick!();
    expect(decided.at(-1)).toEqual(['approve', 'tp', { reason: 'turn on predictions', fresh: true, args: { series: all, reason: ['daily.deploys.count', 'daily.spend.anthropic.usd'] } }]);
  });

  it('a predictions card filed when its numbers were already on says that only second opinions change, from the card’s own stored reason', async () => {
    const OPINION = FORECAST_REASONS.opinion;
    expect(run('APPR_PREDICT_OPINION')).toBe(OPINION);
    expect(OPINION).toBe('Approving changes only the local model’s second opinion on these numbers, which Flint already forecasts.');
    const predict = (over: Record<string, unknown> = {}) => card({
      id: 'tp', fullName: 'forecast.series.enable', origin: 'console', sensitivity: 'ops', consequential: true,
      args: { series: ['daily.deploys.count'], reason: ['daily.deploys.count'] }, reason: OPINION, ...over,
    });
    const facts = (p: Record<string, unknown>) => (JSON.parse(JSON.stringify(run(`apprFacts(${JSON.stringify(p)})`))) as string[][]).map((f) => f.map((x) => x.replace(/\u00a0/g, ' ')));
    const one = 'Flint already forecasts this number, so only its second opinion changes.';
    const many = 'Flint already forecasts these numbers, so only their second opinions change.';
    // One line under the title, what the card holds, and what the prompt says he is signing.
    expect([run(`apprTitle(${JSON.stringify(predict())})`), run(`apprSub(${JSON.stringify(predict())})`), run(`apprReason(${JSON.stringify(predict())})`)]).toEqual(['Turn On Predictions', one, 'change a second opinion']);
    expect(facts(predict()).slice(0, 2)).toEqual([['Numbers', 'Deploys'], ['Second Opinion', 'Local Model']]);
    expect(run(`apprSub(${JSON.stringify(predict({ args: { series: ['daily.deploys.count', 'daily.threads.open'], reason: ['daily.deploys.count'] } }))})`)).toBe(many);
    for (const line of [one, many, OPINION]) {
      expect(noteProblems('Predictions', line), line).toEqual([]);
      expect(line).toMatch(/^[A-Z][^(){}[\]`]*\.$/);
    }
    // It turns nothing on, so it does not say that turning this on also checks what Flint already predicted.
    const says = (p: Record<string, unknown>) => JSON.parse(JSON.stringify(run(`apprDetails(${JSON.stringify(p)}).says`))) as string[];
    expect(says(predict())).toEqual([]);
    expect(says(predict({ reason: FORECAST_REASONS.enable }))).toEqual([run('APPR_PREDICT_ALSO')]);
    // Any other reason (the card that turns numbers on, none at all, a sentence that only looks like it) is the plain card.
    for (const reason of [FORECAST_REASONS.enable, null, undefined, `${OPINION} `, 'opinion']) {
      const p = predict({ reason });
      expect([run(`apprSub(${JSON.stringify(p)})`), run(`apprReason(${JSON.stringify(p)})`)], String(reason)).toEqual(['Flint forecasts 1 of its own numbers each night, on this Mac.', 'turn on predictions']);
    }
    // And the reason is another action's business: only a predictions card is read this way.
    expect(run(`apprPredictOnlyOpinion(${JSON.stringify(card({ id: 'x', fullName: 'world.source.enable', reason: OPINION }))})`)).toBe(false);
    // In the list: the line under the title, and behind Show Details the card's own reason, then its number by name.
    answer = () => ({ status: 200, body: { signed: true, proposals: [predict()] } });
    await open();
    const shown = ids.apprlist!.children[0]!.children[0]!;
    expect(shown.shown()).toContain(`Turn On Predictions${one}`);
    expect(shown.shown()).toContain('Asks on Its Own');
    const details = shown.all().find((e) => e.className === 'details')!;
    expect(details.all().filter((e) => e.tagName === 'p').map((e) => e.textContent)).toEqual([OPINION]);
    expect(details.all().filter((e) => e.tagName === 'li').map((e) => e.textContent)).toEqual(['Deploys · Second Opinion']);
    expect(shown.shown()).not.toMatch(/forecast\.series|daily\.|also checks|[{}[\]"]/);
  });

  it('a card approved here is told to the Goals panel, so a New Goal draft whose card it was is spent; a failed one is not', async () => {
    const told: string[] = [];
    ctx.goalsApproved = (p: { id: string }) => void told.push(p.id);
    answer = () => ({ status: 200, body: { signed: true, proposals: [card({ id: 'g1', fullName: 'goal.activate', kind: 'goal', consequential: true, args: { goalId: 'gotest0001', title: 'Synthetic goal' } })] } });
    await open();
    ids.apprlist!.children[0]!.children[0]!.button('Approve with Password').onclick!();
    await settle();
    expect(told).toEqual(['g1']);
    failApprove = 'g1';
    await open();
    ids.apprlist!.children[0]!.children[0]!.button('Approve with Password').onclick!();
    await settle();
    expect(told).toEqual(['g1']);
  });

  describe('P5: the cards for assets and tasks', () => {
    const TASK = 'tkk7Hq2LmN9pQr3sTv';
    const WATCHER = 'as-ci-watcher-v1';
    const ITEM = 'en8f3k2m9x7q1w5z4c6v0b1n';
    const watch = (over: Record<string, unknown> = {}) => ({
      taskId: TASK, assetId: WATCHER, assetKind: 'ci_runner', title: 'Watch a CI Run', spec: { template: 'watch_ci', params: { item: ITEM, sha: null } },
      acceptance: [{ id: 'a1', text: 'CI Run Passed', check: { type: 'deterministic', op: 'ci', sha: null } }, { id: 'a2', text: 'Names Only Your Items', check: { type: 'deterministic', op: 'refs_known' } }],
      goalId: null, stepKey: null, dueAt: null, sensitivity: 'ops', tainted: false, estCostMicros: 0, ...over,
    });
    const enable = (over: Record<string, unknown> = {}) => ({ assetId: WATCHER, kind: 'ci_runner', externalRef: 'github:ci:v1', name: 'CI Watcher', capabilities: ['watch_ci'], dispatchAction: 'task.dispatch.ci_runner', spends: false, entityId: null, ...over });
    const P5 = {
      enable: card({ id: 'p5a', fullName: 'asset.enable', kind: 'policy', origin: 'console', consequential: true, reason: 'Approving turns this asset on.', args: enable() }),
      dispatch: card({ id: 'p5b', fullName: 'task.dispatch.ci_runner', kind: 'task', origin: 'console', reason: 'Approving runs this task.', cost: { micros: 0 }, args: watch() }),
      accept: card({ id: 'p5c', fullName: 'task.check_bar', kind: 'task', origin: 'runtime:tasks', templateId: 'task.accept.v1', reason: 'Approving accepts this result.', args: { taskId: TASK, outputRef: 'out:0123456789abcdef', metBar: true, checks: 2, met: 2, by: 'flint:rule' } }),
      cancel: card({ id: 'p5d', fullName: 'task.cancel', kind: 'task', origin: 'console', reason: 'Approving stops this task.', args: { taskId: TASK } }),
      acceptAnyway: card({ id: 'p5e', fullName: 'task.bar_override', kind: 'task', origin: 'console', consequential: true, reason: 'Approving accepts this result against its checks.', args: { taskId: TASK, to: 'accepted' } }),
      rejectAnyway: card({ id: 'p5f', fullName: 'task.bar_override', kind: 'task', origin: 'console', consequential: true, reason: 'Approving rejects this result against its checks.', args: { taskId: TASK, to: 'rejected' } }),
    };
    const words = (p: Record<string, unknown>) => [run(`apprTitle(${JSON.stringify(p)})`), run(`apprSub(${JSON.stringify(p)})`), run(`JSON.stringify(apprFacts(${JSON.stringify(p)}))`)] as [string, string, string];
    const facts = (p: Record<string, unknown>) => JSON.parse(words(p)[2]) as Array<[string, string]>;
    const EXPIRES = new Date('2026-10-12T14:00:00.000Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const SMALL = new Set(['a', 'an', 'the', 'and', 'but', 'or', 'nor', 'for', 'so', 'yet', 'as', 'at', 'by', 'from', 'in', 'into', 'of', 'off', 'on', 'onto', 'out', 'over', 'to', 'up', 'with']);
    const titleCase = (s: string) => s.split(' ').every((w, i, all) => !w || /^[^a-z]/.test(w) || (i > 0 && i < all.length - 1 && SMALL.has(w)));

    it('each has a title, a sentence and three facts or fewer, in words: never the action’s own name, an id, or a stored key', () => {
      expect(words(P5.enable)).toEqual(['Turn On the CI Watcher', 'Flint reports how your CI runs end.', JSON.stringify([['Asset', 'CI Watcher'], ['Can Do', 'Watch CI Runs'], ['Cost', 'No Cost']])]);
      expect(words(P5.dispatch)).toEqual(['Watch a CI Run', 'Flint waits for the run and tells you how it ended.', JSON.stringify([['Due', 'No Due Date'], ['Cost', 'No Cost']])]);
      expect(words(P5.accept)).toEqual(['Accept a Task Result', 'It passed 2 of 2 checks.', JSON.stringify([['Checked By', 'Rules'], ['Expires', EXPIRES]])]);
      expect(words(P5.cancel)).toEqual(['Cancel a Task', 'Flint stops working on it.', JSON.stringify([['Filed By', 'You'], ['Expires', EXPIRES]])]);
      expect(words(P5.acceptAnyway).slice(0, 2)).toEqual(['Accept a Result Anyway', 'It ends as accepted, against Flint’s checks.']);
      expect(words(P5.rejectAnyway).slice(0, 2)).toEqual(['Reject a Result Anyway', 'It ends as rejected, against Flint’s checks.']);
      // The same words the notes use, where the card does not say more (which asset, which way).
      for (const p of [P5.dispatch, P5.accept, P5.cancel]) expect(words(p)[0]).toBe(ACTION_WORDS[p.fullName as string]);
      for (const p of Object.values(P5)) {
        const [title, sub] = words(p);
        expect(titleCase(title), title).toBe(true);
        expect(sub, sub).toMatch(/^[A-Z].*\.$/);
        expect(noteProblems('Approvals', sub), sub).toEqual([]);
        expect(facts(p).length).toBeLessThanOrEqual(3);
        for (const [label, value] of facts(p)) {
          expect(titleCase(label), label).toBe(true);
          expect(`${title} ${sub} ${label} ${value}`).not.toMatch(/tk[A-Za-z0-9]{16}|as-ci|\ben[0-9a-z]{20}|task\.|asset\.|ci_runner|watch_ci|flint:rule|[{}[\]"]|undefined|null/);
        }
      }
      // A due time and a real cost are said; one check is singular; a check a model judged says so.
      const due = '2026-10-20T21:59:00.000Z';
      expect(facts({ ...P5.dispatch, cost: { micros: 250_000 }, args: watch({ dueAt: due, estCostMicros: 250_000 }) })).toEqual([['Due', new Date(due).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })], ['Cost', 'About $0.25']]);
      expect(words({ ...P5.accept, args: { ...P5.accept.args, checks: 1, met: 1, by: 'ollama:qwen2.5:14b' } }).slice(1)).toEqual(['It passed 1 of 1 check.', JSON.stringify([['Checked By', 'Local Model'], ['Expires', EXPIRES]])]);
    });

    it('a card this page has fewer words for still reads in words: another kind of asset or task, an ending it does not know, counts that do not add up, args that were cleared', () => {
      expect(words({ ...P5.enable, args: enable({ kind: 'local_worker', name: 'Local Tasks', capabilities: ['summarize_items', 'new_thing'], spends: true }) })).toEqual([
        'Turn On an Asset', 'Flint can hand it work once it’s on.', JSON.stringify([['Asset', 'Local Tasks'], ['Can Do', 'Summarize Items · New Thing'], ['Cost', 'Costs Money']]),
      ]);
      expect(words({ ...P5.dispatch, fullName: 'task.dispatch.local_worker', kind: 'task', cost: undefined, args: watch({ title: 'Summarize Items' }) })).toEqual(['Run a Task', 'Flint runs it once you approve it.', JSON.stringify([['Task', 'Summarize Items'], ['Due', 'No Due Date'], ['Cost', 'No Cost']])]);
      expect(words({ ...P5.acceptAnyway, args: { taskId: TASK, to: 'archived' } }).slice(0, 2)).toEqual(['Overrule a Task’s Checks', 'It ends against Flint’s checks.']);
      // A result is called passed only when every check is met, by the card's own counts.
      for (const args of [{ checks: 3, met: 2 }, { checks: 0, met: 0 }, { checks: '2', met: '2' }, { checks: 2.5, met: 2.5 }, {}]) expect(words({ ...P5.accept, args: { taskId: TASK, ...args } })[1], JSON.stringify(args)).toBe('Flint checked its result.');
      // A name a table does not hold is not a word: "constructor" is no kind of asset.
      for (const kind of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) expect(words({ ...P5.enable, args: enable({ kind }) })[0], kind).toBe('Turn On an Asset');
      expect(words({ ...P5.dispatch, fullName: 'task.dispatch.constructor', kind: 'task', args: watch() })[0]).toBe('Run a Task');
      for (const p of Object.values(P5)) {
        const [title, sub, f] = words({ ...p, args: null, cost: undefined });
        expect(title).toMatch(/^[A-Z]/);
        expect(sub).toMatch(/\.$/);
        expect(f).not.toMatch(/undefined|null/);
      }
    });

    it('the cost on a dispatch card is the number Will signs, which the server’s reading of it has to agree with; a cost that cannot be read says so, is never put in other words, and the card asks on its own', () => {
      const cost = (p: Record<string, unknown>) => facts(p).find((x) => x[0] === 'Cost')?.[1] ?? null;
      const alone = (p: Record<string, unknown>) => run(`apprAlone(${JSON.stringify(p)})`) as boolean;
      const UNREAD = 'Flint couldn’t read the cost.';
      expect(run('APPR_COST_UNREAD')).toBe(UNREAD);
      expect(noteProblems('Approvals', UNREAD)).toEqual([]);
      // Exactly nothing, by the args and by the server (or by the args alone, from an older server): the one card that may share a prompt.
      for (const p of [P5.dispatch, { ...P5.dispatch, cost: undefined }]) {
        expect(cost(p)).toBe('No Cost');
        expect(alone(p)).toBe(false);
      }
      for (const [micros, says] of [[12_500_000, 'About $12.50'], [2_500, 'About $0.0025'], [1_000_000_000, 'About $1000.00'], [100, 'About $0.0001']] as const) {
        for (const p of [{ ...P5.dispatch, cost: { micros }, args: watch({ estCostMicros: micros }) }, { ...P5.dispatch, cost: undefined, args: watch({ estCostMicros: micros }) }]) {
          expect(cost(p), String(micros)).toBe(says);
          expect(alone(p), String(micros)).toBe(true);
        }
      }
      // A number no card could hold: the row says the cost could not be read, and the card asks on its own.
      for (const bad of [-100, 0.5, 250_050, 1_000_000_100, '0', null, true, NaN]) {
        for (const p of [{ ...P5.dispatch, cost: { micros: bad }, args: watch({ estCostMicros: bad }) }, { ...P5.dispatch, cost: undefined, args: watch({ estCostMicros: bad }) }, { ...P5.dispatch, args: watch({ estCostMicros: bad }) }]) {
          expect(cost(p), String(bad)).toBe(UNREAD);
          expect(alone(p), String(bad)).toBe(true);
        }
        // Behind Show Details such a number is listed as it is stored, never rounded into a sentence.
        const d = JSON.parse(run(`JSON.stringify(apprDetails(${JSON.stringify({ ...P5.dispatch, args: watch({ estCostMicros: bad }) })}))`) as string) as { says: string[]; facts: Array<[string, string]> };
        expect(d.says.join(' '), String(bad)).not.toMatch(/costs/);
        expect(d.facts.some((x) => x[0] === 'Cost in Millionths of a Dollar'), String(bad)).toBe(true);
      }
      // The server's reading and the signed number differ, or the server's reading is no reading: neither is believed.
      for (const [server, signed] of [[{ micros: 0 }, 5_000_000], [{ micros: 5_000_000 }, 0], [{ micros: 100 }, 200], [{}, 0], [0, 0], ['free', 0], [{ micros: '0' }, 0], [[], 0]] as const) {
        const p = { ...P5.dispatch, cost: server, args: watch({ estCostMicros: signed }) };
        expect(cost(p), JSON.stringify(server)).toBe(UNREAD);
        expect(alone(p), JSON.stringify(server)).toBe(true);
      }
      // A card with no estimate at all (its args were cleared, or never held one) is not one that costs nothing.
      for (const args of [null, {}, watch({ estCostMicros: undefined })]) {
        expect(cost({ ...P5.dispatch, cost: undefined, args }), JSON.stringify(args)).toBe(UNREAD);
        expect(alone({ ...P5.dispatch, cost: undefined, args }), JSON.stringify(args)).toBe(true);
      }
      // No card but a dispatch has a Cost fact of this kind, whatever its args hold; nor does one ask alone for it.
      for (const p of [P5.accept, P5.cancel, P5.acceptAnyway]) expect(cost({ ...p, cost: { micros: 0 }, args: { ...(p.args as object), estCostMicros: 0 } }), p.fullName as string).toBeNull();
      for (const p of [P5.accept, P5.cancel]) expect(alone({ ...p, cost: { micros: 5 }, args: { ...(p.args as object), estCostMicros: 'x' } }), p.fullName as string).toBe(false);
    });

    it('in the panel a task whose cost cannot be read shows that on its Cost row, is marked as asking on its own, and is left out of Approve All', async () => {
      const unread = { ...P5.dispatch, id: 'p5u', cost: { micros: 0 }, args: watch({ estCostMicros: 5_000_000 }) };
      answer = () => ({ status: 200, body: { proposals: [unread, P5.dispatch, P5.cancel], signed: true } });
      await open();
      const first = ids.apprlist!.children[0]!.children[0]!;
      expect(first.shown()).toContain('CostFlint couldn’t read the cost.');
      expect(first.shown()).toContain('Asks on Its Own');
      expect(first.shown()).not.toContain('No Cost');
      expect(noteSays()).toBe('You have 3 approvals waiting. Approve All skips 1.');
      ids.apprall!.onclick!();
      await settle();
      expect(decided.map((d) => d[1])).toEqual(['p5b', 'p5d']);
      decided = [];
      ids.apprlist!.button('Approve with Password').onclick!();
      expect(decided).toEqual([['approve', 'p5u', { reason: 'run this task', fresh: true, args: unread.args }]]);
    });

    it('turning an asset on and ending a task against its checks ask on their own, whatever the server marks; so does a task that costs money; the prompt says what Flint is doing', async () => {
      const alone = (p: Record<string, unknown>) => run(`apprAlone(${JSON.stringify(p)})`) as boolean;
      const reason = (p: Record<string, unknown>) => run(`apprReason(${JSON.stringify(p)})`) as string;
      for (const p of [P5.enable, P5.acceptAnyway, P5.rejectAnyway]) {
        expect(alone(p), p.fullName as string).toBe(true);
        // Its name holds the line for a server that does not send the mark.
        expect(alone({ ...p, consequential: false }), p.fullName as string).toBe(true);
      }
      for (const p of [P5.dispatch, P5.accept, P5.cancel]) expect(alone(p), p.fullName as string).toBe(false);
      expect(alone({ ...P5.dispatch, cost: { micros: 100 }, args: watch({ estCostMicros: 100 }) })).toBe(true);
      expect(alone({ ...P5.dispatch, cost: undefined, args: watch({ estCostMicros: 250_000 }) })).toBe(true);
      expect(alone({ ...P5.dispatch, tainted: true })).toBe(true);
      // A card filed as a spend is money, whatever its estimate reads and whatever marks it came without.
      expect(alone({ ...P5.dispatch, fullName: 'task.dispatch.local_worker', kind: 'spend' })).toBe(true);
      expect(alone({ ...plain(), kind: 'spend' })).toBe(true);
      // Ending a task against its checks says so in the prompt: it never reads as the plain acceptance of a result that passed.
      expect([P5.enable, P5.dispatch, P5.accept, P5.cancel, P5.acceptAnyway, P5.rejectAnyway].map(reason)).toEqual([
        'turn on the CI watcher', 'run this task', 'accept this result', 'cancel this task', 'accept this result against its checks', 'reject this result against its checks',
      ]);
      expect(reason(P5.acceptAnyway)).not.toBe(reason(P5.accept));
      expect(reason({ ...P5.enable, args: enable({ kind: 'local_worker' }) })).toBe('turn on this asset');
      expect(reason({ ...P5.acceptAnyway, args: { taskId: TASK, to: 'archived' } })).toBe('end this task against its checks');
      expect(reason({ ...P5.acceptAnyway, args: null })).toBe('end this task against its checks');
      // In the panel: Approve All takes the three that may share a prompt and leaves the three that ask on their own.
      answer = () => ({ status: 200, body: { proposals: Object.values(P5), signed: true } });
      await open();
      expect(noteSays()).toBe('You have 6 approvals waiting. Approve All skips 3.');
      ids.apprall!.onclick!();
      await settle();
      expect(decided.map((d) => d[1])).toEqual(['p5b', 'p5c', 'p5d']);
      // On its own card, Approve hands the stored args untouched, with a fresh touch where it asks on its own.
      decided = [];
      run("APPR.open='p5a';apprRender()");
      ids.apprlist!.button('Approve with Password').onclick!();
      await settle();
      expect(decided).toEqual([['approve', 'p5a', { reason: 'turn on the CI watcher', fresh: true, args: P5.enable.args }]]);
    });

    it('in the panel a task card is opened in words, with everything it holds behind Show Details: sentences, labelled values and references, and never a <pre>', async () => {
      answer = () => ({ status: 200, body: { proposals: Object.values(P5), signed: true } });
      await open();
      for (const p of Object.values(P5)) {
        run(`APPR.open=${JSON.stringify(p.id)};apprRender()`);
        const open = ids.apprlist!.all().find((e) => e.className.split(' ').includes('open'))!;
        open.button('Show Details').onclick!();
        const details = open.all().find((e) => e.className === 'details')!;
        expect(details.hidden).toBe(false);
        expect(open.all().some((e) => e.tagName === 'pre' || e.tagName === 'code'), p.fullName as string).toBe(false);
        const lines = details.children.filter((c) => c.tagName === 'p').map((c) => c.textContent);
        expect(lines[0]).toBe(p.reason);
        for (const line of lines) expect(noteProblems('Details', line), line).toEqual([]);
        for (const dt of details.all().filter((e) => e.tagName === 'dt')) expect(titleCase(dt.textContent), dt.textContent).toBe(true);
        // Its ids are there, under REFERENCES; nothing is written as JSON.
        expect(details.all().filter((e) => e.tagName === 'h4').map((e) => e.textContent)).toContain('REFERENCES');
        expect(details.textContent).toContain(p.fullName === 'asset.enable' ? WATCHER : TASK);
        expect(details.textContent).not.toMatch(/[{}"[\]]/);
      }
      // The icon: an asset is a switch, a task is a task.
      expect(run(`apprIcon(${JSON.stringify(P5.enable)})`)).toBe('power');
      for (const p of [P5.dispatch, P5.accept, P5.cancel, P5.acceptAnyway]) expect(run(`apprIcon(${JSON.stringify(p)})`)).toBe('tasks');
    });

    const rowsOf = (p: Record<string, unknown>) => JSON.parse(run(`JSON.stringify(apprFaceRows(${JSON.stringify(p)}))`) as string) as Array<[string, string, boolean]>;
    const LOOKED = 'The task’s name above is looked up, not part of what you sign.';
    const know = (title: string, about: string) => run(`APPR_TASKS[${JSON.stringify(TASK)}]=${JSON.stringify({ title, about })}`);
    /** Timers the page sets, kept instead of run: [what, after how long]. */
    const clock = () => {
      const timers: Array<[() => void, number]> = [];
      ctx.setTimeout = (fn: () => void, ms: number) => timers.push([fn, ms]);
      return timers;
    };
    const cardsDrawn = () => ids.apprlist!.all().filter((e) => e.className.split(' ').includes('card'));

    it('what the Tasks panel looked up is a row of its own on a card’s face, marked as looked up; a word Will signs is never replaced by it; Show Details holds only what is signed', () => {
      // Nothing looked up: the face is the card's facts, and nothing says otherwise.
      expect(rowsOf(P5.cancel)).toEqual([['Filed By', 'You', false], ['Expires', EXPIRES, false]]);
      expect(run(`apprLooked(${JSON.stringify(P5.cancel)})`)).toBeNull();
      know('Watch a CI Run', 'wpf002/flint CI');
      // The facts are what the card carries, looked up or not. The face adds one row, and marks it.
      expect(facts(P5.cancel)).toEqual([['Filed By', 'You'], ['Expires', EXPIRES]]);
      expect(rowsOf(P5.cancel)).toEqual([['Task', 'Watch a CI Run · wpf002/flint CI', true], ['Filed By', 'You', false], ['Expires', EXPIRES, false]]);
      expect(rowsOf(P5.accept)).toEqual([['Task', 'Watch a CI Run · wpf002/flint CI', true], ['Checked By', 'Rules', false], ['Expires', EXPIRES, false]]);
      expect(rowsOf(P5.acceptAnyway)[0]).toEqual(['Task', 'Watch a CI Run · wpf002/flint CI', true]);
      // A CI watch's card signs its title (the card's own): what it watches is the looked-up row.
      expect(facts(P5.dispatch)).toEqual([['Due', 'No Due Date'], ['Cost', 'No Cost']]);
      expect(rowsOf(P5.dispatch)).toEqual([['CI Run', 'wpf002/flint CI', true], ['Due', 'No Due Date', false], ['Cost', 'No Cost', false]]);
      // Neither the title nor the sentence under it ever holds a looked-up word.
      for (const p of Object.values(P5)) expect(`${words(p)[0]} ${words(p)[1]}`, p.fullName as string).not.toMatch(/wpf002|·/);
      // A signed title always wins: a card that carries its task's title is named by that, whatever was looked up.
      know('Pay Everyone', 'somewhere else');
      const other = { ...P5.dispatch, fullName: 'task.dispatch.local_worker', args: watch({ title: 'Summarize Items' }) };
      expect(run(`apprTaskName(${JSON.stringify(other)})`)).toBe('Summarize Items');
      expect(run(`apprTaskName(${JSON.stringify(P5.dispatch)})`)).toBe('Watch a CI Run');
      for (const p of [P5.accept, P5.cancel, P5.acceptAnyway]) {
        const signed = { ...p, args: { ...(p.args as object), title: 'Summarize Items' } };
        expect(run(`apprTaskName(${JSON.stringify(signed)})`), p.fullName as string).toBe('Summarize Items');
        expect(rowsOf(signed).filter((x) => x[0] === 'Task'), p.fullName as string).toEqual([['Task', 'Summarize Items', false]]);
        expect(JSON.stringify(rowsOf(signed)), p.fullName as string).not.toContain('Pay Everyone');
      }
      // A face has three rows at most, and what is signed comes first: a face that is full has no looked-up row.
      expect(rowsOf(other)).toEqual([['Task', 'Summarize Items', false], ['Due', 'No Due Date', false], ['Cost', 'No Cost', false]]);
      expect(run(`apprLooked(${JSON.stringify(other)})`)).toBeNull();
      // With room (its due time is no moment), what it is about is the looked-up row, after the name it signs.
      expect(rowsOf({ ...other, args: watch({ title: 'Summarize Items', dueAt: 'whenever' }) })).toEqual([['Task', 'Summarize Items', false], ['About', 'somewhere else', true], ['Cost', 'No Cost', false]]);
      for (const p of [...Object.values(P5), other]) expect(rowsOf(p).length, p.fullName as string).toBeLessThanOrEqual(3);
      for (const p of [...Object.values(P5), other]) expect(rowsOf(p).filter((x) => x[2]).length, p.fullName as string).toBeLessThanOrEqual(1);
      // An asset's card is about no task: nothing is looked up for it.
      expect(rowsOf({ ...P5.enable, args: { ...enable(), taskId: TASK } }).some((x) => x[2])).toBe(false);
      // Show Details, and what is signed, hold only what the card carries.
      for (const p of Object.values(P5)) expect(run(`JSON.stringify(apprDetails(${JSON.stringify(p)}))`), p.fullName as string).not.toMatch(/wpf002|Pay Everyone|somewhere else|looked up/);
      // Each looked-up row has its one sentence, which is a sentence.
      const says = JSON.parse(run('JSON.stringify(APPR_LOOKED_SAYS)') as string) as Record<string, string>;
      expect(Object.keys(says).sort()).toEqual(['About', 'CI Run', 'Task']);
      expect(says.Task).toBe(LOOKED);
      for (const line of Object.values(says)) {
        expect(noteProblems('Details', line), line).toEqual([]);
        expect(line).toMatch(/looked up, not part of what you sign\.$/);
      }
      // A task id that is not one, or a name under a key the table does not own, is never looked up as a task.
      expect(run(`apprTaskName(${JSON.stringify({ ...P5.cancel, args: { taskId: 'constructor' } })})`)).toBe('');
      expect(run(`apprTaskName(${JSON.stringify({ ...P5.cancel, args: { taskId: '__proto__' } })})`)).toBe('');
      for (const taskId of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'tk0000000000000000']) expect(run(`apprTaskKnown(${JSON.stringify({ fullName: 'task.cancel', kind: 'task', args: { taskId } })})`), taskId).toBeNull();
      expect(run(`apprTaskKnown(${JSON.stringify(P5.cancel)}).about`)).toBe('somewhere else');
      // What was looked up with no title, or with something that is no text, names nothing.
      for (const known of [{ title: '', about: 'x' }, { title: 7, about: 'x' }, { about: 'x' }, {}]) {
        run(`APPR_TASKS[${JSON.stringify(TASK)}]=${JSON.stringify(known)}`);
        expect(rowsOf(P5.cancel).some((x) => x[2]), JSON.stringify(known)).toBe(false);
      }
      // A due time that is no moment is not dressed as a date on the card's face; behind Show Details it is given as it is written.
      // (Words, a date written some other way, and a moment that never was: none of them is the card's kind of time.)
      know('Watch a CI Run', 'wpf002/flint CI');
      for (const dueAt of ['whenever', 'October 20, 2026', '2026-13-45T25:61:00.000Z', 20261020, true]) expect(rowsOf({ ...P5.dispatch, args: watch({ dueAt }) }).map((x) => x[0]), String(dueAt)).toEqual(['CI Run', 'Cost']);
      expect(run(`JSON.stringify(apprDetails(${JSON.stringify({ ...P5.dispatch, args: watch({ dueAt: 'whenever' }) })}).says)`)).toContain('It’s due whenever.');
    });

    it('a due time finer than a second is said as a time, with its thousandths: never as it is stored', () => {
      const says = (dueAt: string) => (JSON.parse(run(`JSON.stringify(apprDetails(${JSON.stringify({ ...P5.dispatch, args: watch({ dueAt }) })}).says)`) as string) as string[]).find((x) => x.startsWith('It’s due'))!;
      const fine = says('2026-10-15T09:04:15.202Z');
      expect(fine).toMatch(/^It’s due .*\b\d{1,2}:04:15\.202\b.*\.$/);
      expect(fine).not.toMatch(/2026-10-15T|\d{2}Z/);
      expect(noteProblems('Details', fine)).toEqual([]);
      // A whole second, with or without its zeros, reads as it always did: to the minute.
      expect(says('2026-10-15T09:04:00.000Z')).toBe(says('2026-10-15T09:04:00Z'));
      expect(says('2026-10-15T09:04:00.000Z')).not.toMatch(/:04:00/);
      // The card's face gives the day, whatever the fraction.
      expect(facts({ ...P5.dispatch, args: watch({ dueAt: '2026-10-15T09:04:15.202Z' }) })[0]).toEqual(['Due', new Date('2026-10-15T09:04:15.202Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })]);
    });

    it('in the panel the looked-up row carries its mark beside the value, and Show Details says the row was looked up; a card with nothing looked up says neither', async () => {
      ctx.taskNames = (_ps: unknown[], done: (n: number) => void) => (know('Watch a CI Run', 'wpf002/flint CI'), done(1));
      answer = () => ({ status: 200, body: { proposals: [P5.cancel, P5.dispatch, P5.enable], signed: true } });
      await open();
      const opened = (id: string) => {
        run(`APPR.open=${JSON.stringify(id)};APPR.details=null;apprRender()`);
        return ids.apprlist!.all().find((e) => e.className.split(' ').includes('open'))!;
      };
      for (const [id, label, value, sentence] of [['p5d', 'Task', 'Watch a CI Run · wpf002/flint CI', LOOKED], ['p5b', 'CI Run', 'wpf002/flint CI', 'The CI run’s name above is looked up, not part of what you sign.']] as const) {
        const c = opened(id);
        const dl = c.all().find((e) => e.tagName === 'dl' && e.className === 'facts')!;
        const dts = dl.children.filter((e) => e.tagName === 'dt');
        const dds = dl.children.filter((e) => e.tagName === 'dd');
        expect(dts[0]!.textContent).toBe(label);
        // The value, then the mark: a small element of its own, never part of the value's text.
        expect(dds[0]!.children.map((e) => [e.tagName, e.className, e.textContent])).toEqual([['span', 'looked', 'Looked Up']]);
        expect(dds[0]!.textContent).toBe(`${value}Looked Up`);
        // No other row is marked.
        for (const dd of dds.slice(1)) expect(dd.children).toHaveLength(0);
        expect(c.all().filter((e) => e.className === 'looked')).toHaveLength(1);
        // The title and the sentence under it are the card's own.
        expect(c.children[0]!.textContent).not.toContain('wpf002');
        // Show Details: what is signed, and one fixed sentence about the row above.
        const details = c.all().find((e) => e.className === 'details')!;
        const said = details.children.filter((e) => e.tagName === 'p' && e.className === 'lookedsay').map((e) => e.textContent);
        expect(said).toEqual([sentence]);
        expect(details.textContent.replace(sentence, '')).not.toMatch(/wpf002|Looked Up/);
      }
      // An asset's card, and a task card with nothing looked up, have no mark and no such sentence.
      const asset = opened('p5a');
      expect(asset.all().some((e) => e.className === 'looked' || e.className === 'lookedsay')).toBe(false);
      run(`delete APPR_TASKS[${JSON.stringify(TASK)}]`);
      const bare = opened('p5d');
      expect(bare.all().some((e) => e.className === 'looked' || e.className === 'lookedsay')).toBe(false);
      expect(bare.all().find((e) => e.tagName === 'dl' && e.className === 'facts')!.children.filter((e) => e.tagName === 'dt').map((e) => e.textContent)).toEqual(['Filed By', 'Expires']);
    });

    it('the names a list’s task cards show are read before the list is first drawn, for 600 ms at most; the list is drawn once, and names that land late never draw it again', async () => {
      const timers = clock();
      const seen: Array<Array<{ id: string }>> = [];
      const learns: Array<(n: number) => void> = [];
      ctx.taskNames = (ps: Array<{ id: string }>, done: (n: number) => void) => (seen.push(ps), learns.push(done));
      const dots: unknown[][] = [];
      ctx.tasksDot = (ps: unknown[]) => void dots.push(ps);
      answer = () => ({ status: 200, body: { proposals: [P5.cancel, P5.dispatch], signed: true } });
      await open();
      // Asked once, about the whole list; its dot is lit; and no card is drawn yet: only the wait, with its deadline.
      expect(seen.map((ps) => ps.map((p) => p.id))).toEqual([['p5d', 'p5b']]);
      expect(dots).toHaveLength(1);
      expect(cardsDrawn()).toHaveLength(0);
      expect(ids.apprlist!.textContent).toBe('Loading…');
      expect(run('APPR_NAMES_MS')).toBe(600);
      expect(timers.map((t) => t[1])).toEqual([600]);
      // The names land in time: the list is drawn, with them.
      know('Watch a CI Run', 'wpf002/flint CI');
      learns[0]!(1);
      const drawn = ids.apprlist!.children[0]!;
      expect(cardsDrawn()).toHaveLength(2);
      expect(drawn.textContent).toContain('TaskWatch a CI Run · wpf002/flint CILooked Up');
      // The deadline passing afterwards, or the names answering again, draws nothing.
      timers[0]![0]();
      learns[0]!(1);
      expect(ids.apprlist!.children[0]).toBe(drawn);

      // The next load: the names do not land in time.
      run(`delete APPR_TASKS[${JSON.stringify(TASK)}]`);
      run('loadApprovals()');
      await settle();
      expect(seen).toHaveLength(2);
      // Until the deadline, the list on screen is the one that was there, and it is the list this page holds: a card
      // opened in it meanwhile is one of its own cards, with what it showed.
      expect(ids.apprlist!.children[0]).toBe(drawn);
      expect(timers.map((t) => t[1])).toEqual([600, 600]);
      drawn.children[1]!.onclick!();
      const meanwhile = ids.apprlist!.children[0]!;
      expect(meanwhile.children.map((c) => c.getAttribute('data-id'))).toEqual(['p5d', 'p5b']);
      expect(meanwhile.children[1]!.className).toContain('open');
      timers[1]![0]();
      const late = ids.apprlist!.children[0]!;
      expect(late).not.toBe(meanwhile);
      expect(late.textContent).not.toMatch(/wpf002|Looked Up/);
      // (The card he opened is still the open one.)
      expect(late.children[1]!.className).toContain('open');
      // Then they land. They are kept for the next load; this list is not drawn again, so nothing moves under a pointer.
      know('Watch a CI Run', 'wpf002/flint CI');
      learns[1]!(1);
      learns[1]!(0);
      expect(ids.apprlist!.children[0]).toBe(late);
      expect(late.textContent).not.toMatch(/wpf002/);
      // The load after that shows them.
      run('loadApprovals()');
      await settle();
      learns[2]!(0);
      expect(ids.apprlist!.children[0]).not.toBe(late);
      expect(ids.apprlist!.textContent).toContain('wpf002/flint CI');

      // A list that was read again while an older one still waited for its names: the older one draws nothing.
      const before = ids.apprlist!.children[0];
      run('loadApprovals()');
      await settle();
      run('loadApprovals()');
      await settle();
      expect(learns).toHaveLength(5);
      learns[3]!(1);
      expect(ids.apprlist!.children[0]).toBe(before);
      learns[4]!(1);
      expect(ids.apprlist!.children[0]).not.toBe(before);

      // A list with no card about a task waits for nothing and asks for nothing.
      const asked = seen.length;
      const set = timers.length;
      answer = () => ({ status: 200, body: { proposals: [plain({ id: 'x1' }), P5.enable], signed: true } });
      run('loadApprovals()');
      await settle();
      expect(seen).toHaveLength(asked);
      expect(timers).toHaveLength(set);
      expect(cardsDrawn().map((c) => c.getAttribute('data-id'))).toEqual(['x1', 'p5a']);
    });

    it('while an approval is in flight the list is not drawn again and nothing else on it is taken: the card being signed stays on screen, and what its approval said is kept for it', async () => {
      const timers = clock();
      held = [];
      answer = () => ({ status: 200, body: { proposals: [P5.cancel, P5.accept, plain({ id: 'x1' }), plain({ id: 'x2', status: 'approved' })], signed: true } });
      await open();
      const list = ids.apprlist!.children[0]!;
      const first = list.children[0]!;
      const toggle = first.button('Show Details');
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      toggle.onclick!();
      // (Open, and it says so to a screen reader, which is what turns its chevron.)
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
      toggle.onclick!();
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      toggle.onclick!();
      first.button('Approve with Password').onclick!();
      expect(held.map((h) => h.id)).toEqual(['p5d']);
      expect(held[0]!.card).toBe(first);
      expect(run('APPR.flight')).toBe(1);
      // The prompt is up. Reject, Approve again, another card, the other tab: none of them is taken.
      first.button('Reject').onclick!();
      first.button('Approve with Password').onclick!();
      list.children[1]!.onclick!();
      run("apprShow('approved')");
      expect(decided).toHaveLength(1);
      expect([run('APPR.open'), run('APPR.tab')]).toEqual(['p5d', 'waiting']);
      expect(ids.apprlist!.children[0]).toBe(list);
      // The list is read again meanwhile (a reload that was already on its way): it is held back. Nothing is drawn, and
      // what this page holds stays the list on screen.
      answer = () => ({ status: 200, body: { proposals: [plain({ id: 'x9' })], signed: true } });
      run('loadApprovals()');
      await settle();
      expect(ids.apprlist!.children[0]).toBe(list);
      expect(run('APPR.redraw')).toBe(true);
      expect(JSON.parse(run('JSON.stringify(APPR.pending.map(function(p){return p.id;}))') as string)).toEqual(['p5d', 'p5c', 'x1']);
      // A read that fails meanwhile does not take the list away either: not a refusal, not a server that cannot be reached.
      for (const broken of [() => ({ status: 500, body: {} }), () => { throw new Error('offline'); }]) {
        run('APPR.redraw=false');
        answer = broken as typeof answer;
        run('loadApprovals()');
        await settle();
        expect(ids.apprlist!.children[0]).toBe(list);
        expect(ids.apprlist!.textContent).not.toMatch(/Couldn't/);
        expect(run('APPR.redraw')).toBe(true);
      }
      answer = () => ({ status: 200, body: { proposals: [P5.cancel, P5.accept, plain({ id: 'x1' }), plain({ id: 'x2', status: 'approved' })], signed: true } });
      // Will dismisses the prompt. The main script writes what happened on the card it was handed: the one still on screen.
      const DISMISSED = 'You dismissed the prompt. The card is waiting in Approvals.';
      const res = held[0]!.card.all().find((e) => e.className.split(' ')[0] === 'res')!;
      res.style.display = 'block';
      res.textContent = DISMISSED;
      held[0]!.no(new Error('not confirmed'));
      await settle();
      expect(run('APPR.flight')).toBe(0);
      expect(cardsDrawn()).toContain(first);
      expect(first.shown()).toContain(DISMISSED);
      // The list that was held back is read again a little later (time to read the line), and the line stays with its card.
      expect(timers.filter((t) => t[1] === 2500)).toHaveLength(1);
      held = null;
      timers.find((t) => t[1] === 2500)![0]();
      await settle();
      const again = ids.apprlist!.children[0]!.children[0]!;
      expect(again).not.toBe(first);
      expect(again.getAttribute('data-id')).toBe('p5d');
      expect(again.shown()).toContain(DISMISSED);
      // Show Details is as he left it: a card he was reading does not fold when the list is drawn again.
      expect(again.all().find((e) => e.className === 'details')!.hidden).toBe(false);
      expect(again.button('Hide Details').getAttribute('aria-expanded')).toBe('true');
      // Opening another card by hand starts that one closed, and going back finds this one closed too.
      ids.apprlist!.children[0]!.children[1]!.onclick!();
      const second = ids.apprlist!.children[0]!.children[1]!;
      expect(second.all().find((e) => e.className === 'details')!.hidden).toBe(true);
      expect(second.button('Show Details').getAttribute('aria-expanded')).toBe('false');
      // The line is only ever on its own card.
      expect(second.shown()).not.toContain(DISMISSED);
      // Approving the card again takes its old line away; a card that no longer waits takes its line with it.
      run("apprSaid('x1','It failed.','bad')");
      answer = () => ({ status: 200, body: { proposals: [P5.cancel, P5.accept], signed: true } });
      run('loadApprovals()');
      await settle();
      expect(JSON.parse(run('JSON.stringify(Object.keys(APPR.said))') as string)).toEqual(['p5d']);
      run("APPR.open='p5d';apprRender()");
      ids.apprlist!.button('Approve with Password').onclick!();
      expect(run('JSON.stringify(APPR.said)')).toBe('{}');
      // An id that is no card's id keeps nothing ("__proto__", a path, a sentence).
      for (const id of ['__proto__', 'constructor!', '../x', 'a b', '']) run(`apprSaid(${JSON.stringify(id)},'x','bad')`);
      expect(run('JSON.stringify(APPR.said)')).toBe('{}');
      expect(run('({}).x')).toBeUndefined();
    });

    it('an approval that starts while a list just read still waits for its names: that list is held back too, and drawn after the approval settles', async () => {
      const timers = clock();
      const learns: Array<(n: number) => void> = [];
      ctx.taskNames = (_ps: unknown[], done: (n: number) => void) => learns.push(done);
      answer = () => ({ status: 200, body: { proposals: [P5.cancel, plain({ id: 'x1' })], signed: true } });
      await open();
      learns[0]!(0);
      const list = ids.apprlist!.children[0]!;
      // The list is read again (its answer is in, its names are not), and he presses Approve on the card in front of him.
      answer = () => ({ status: 200, body: { proposals: [P5.cancel, P5.accept, plain({ id: 'x1' })], signed: true } });
      run('loadApprovals()');
      await settle();
      expect(learns).toHaveLength(2);
      held = [];
      list.children[0]!.button('Approve with Password').onclick!();
      expect(held.map((h) => h.id)).toEqual(['p5d']);
      // The names land, and the deadline passes: neither draws over the card being signed.
      learns[1]!(0);
      for (const t of timers.filter((x) => x[1] === 600)) t[0]();
      expect(ids.apprlist!.children[0]).toBe(list);
      expect(run('APPR.redraw')).toBe(true);
      expect(JSON.parse(run('JSON.stringify(APPR.pending.map(function(p){return p.id;}))') as string)).toEqual(['p5d', 'x1']);
      // It goes through: the list is read again, as after any approval, and that reading is drawn.
      held[0]!.ok({ action: { status: 'done' } });
      await settle();
      held = null;
      answer = () => ({ status: 200, body: { proposals: [P5.accept, plain({ id: 'x1' })], signed: true } });
      timers.find((t) => t[1] === 1200)![0]();
      await settle();
      learns[2]!(0);
      expect(cardsDrawn().map((c) => c.getAttribute('data-id'))).toEqual(['p5c', 'x1']);
      expect(run('APPR.redraw')).toBe(false);
    });

    it('an approval that goes through with a list held back draws the next list when it is read; Approve All holds the list back the same way', async () => {
      const timers = clock();
      held = [];
      answer = () => ({ status: 200, body: { proposals: [P5.cancel, P5.accept, plain({ id: 'x1' })], signed: true } });
      await open();
      const list = ids.apprlist!.children[0]!;
      list.children[0]!.button('Approve with Password').onclick!();
      run('loadApprovals()');
      await settle();
      expect(ids.apprlist!.children[0]).toBe(list);
      held[0]!.ok({ action: { status: 'done' } });
      await settle();
      expect(run('APPR.flight')).toBe(0);
      // Read again as after any approval; that reading is drawn.
      expect(timers.filter((t) => t[1] === 1200)).toHaveLength(1);
      answer = () => ({ status: 200, body: { proposals: [P5.accept, plain({ id: 'x1' })], signed: true } });
      timers.find((t) => t[1] === 1200)![0]();
      await settle();
      expect(cardsDrawn().map((c) => c.getAttribute('data-id'))).toEqual(['p5c', 'x1']);
      expect(run('APPR.redraw')).toBe(false);
      // Approve All: its cards stay where they are until it has finished, whatever is read meanwhile.
      const during = ids.apprlist!.children[0]!;
      held = [];
      ids.apprall!.onclick!();
      expect(run('APPR.busy')).toBe(true);
      run('loadApprovals()');
      await settle();
      expect(ids.apprlist!.children[0]).toBe(during);
      during.children[0]!.button('Reject').onclick!();
      during.children[1]!.onclick!();
      expect(decided.filter((d) => d[0] === 'reject')).toHaveLength(0);
      expect(run('APPR.open')).toBe('p5c');
      held[0]!.ok({ action: { status: 'done' } });
      await settle();
      held[1]!.ok({ action: { status: 'done' } });
      await settle();
      expect(run('APPR.busy')).toBe(false);
      expect(ids.apprnote!.textContent).toBe('You approved 2 of 2.');
    });

    it('a tool on a connected server that carries one of Flint’s own names is drawn as a tool’s card, with its server named; it gets none of that card’s words, asks on its own, and never rides Approve All', async () => {
      const planted = {
        task: card({ id: 'm1', fullName: 'task.check_bar', kind: 'tool_call', mcp: true, origin: 'chat:c1', args: { taskId: TASK, outputRef: 'out:0123456789abcdef', metBar: true, checks: 2, met: 2, by: 'flint:rule' } }),
        goal: card({ id: 'm2', fullName: 'goal.activate', kind: 'tool_call', mcp: true, origin: 'chat:c1', args: { goalId: 'go1', title: 'Finish Building Flint' } }),
      };
      const alone = (p: Record<string, unknown>) => run(`apprAlone(${JSON.stringify(p)})`) as boolean;
      const SUB = 'It’s a tool on a connected server.';
      const NOTE = 'It’s not one of Flint’s own cards, whatever it is called.';
      // Its server and its tool are named on its face, as they are written.
      expect(words(planted.task)).toEqual(['Approve a Tool Call', SUB, JSON.stringify([['Server', 'task'], ['Tool', 'check_bar'], ['Filed By', 'A Chat']])]);
      expect(words(planted.goal)).toEqual(['Approve a Tool Call', SUB, JSON.stringify([['Server', 'goal'], ['Tool', 'activate'], ['Filed By', 'A Chat']])]);
      know('Watch a CI Run', 'wpf002/flint CI');
      for (const p of Object.values(planted)) {
        expect(alone(p), p.fullName as string).toBe(true);
        expect(run(`apprReason(${JSON.stringify(p)})`), p.fullName as string).toBe('run a tool on a connected server');
        expect(run(`apprIcon(${JSON.stringify(p)})`), p.fullName as string).toBe('bolt');
        // It is no task's card and no goal's: nothing is looked up for it, and no dot is lit by it.
        for (const fn of ['apprTaskCard', 'apprDispatchCard', 'apprGoalCard', 'apprOwn']) expect(run(`!!${fn}(${JSON.stringify(p)})`), `${fn} ${p.fullName}`).toBe(false);
        expect(run(`apprTaskKnown(${JSON.stringify(p)})`)).toBeNull();
        expect(run(`apprLooked(${JSON.stringify(p)})`)).toBeNull();
        expect(rowsOf(p).some((x) => x[2])).toBe(false);
        // Behind Show Details: what it is, then every value it holds, as any tool's card lists them.
        const d = JSON.parse(run(`JSON.stringify(apprDetails(${JSON.stringify(p)}))`) as string) as { says: string[]; facts: Array<[string, string]>; refs: Array<[string, string]> };
        expect(d.says).toEqual([NOTE]);
        const listed = JSON.stringify([d.facts, d.refs]);
        for (const v of Object.values(p.args as Record<string, unknown>)) expect(listed, String(v)).toContain(v === true ? 'Yes' : String(v));
        expect(noteProblems('Approvals', words(p)[1])).toEqual([]);
        expect(titleCase(words(p)[0])).toBe(true);
      }
      expect(noteProblems('Details', NOTE)).toEqual([]);
      // The whole family: every name this panel keeps words for is one of Flint's own ONLY when the server does not
      // mark the card as a tool's AND its kind is the kind the runtime files that action under.
      const own = JSON.parse(run('JSON.stringify([Object.keys(APPR_OWN).map(function(k){return [k,[APPR_OWN[k]]];}),Object.keys(APPR_NIGHTLY).map(function(k){return [k,["tool_call"]];})])') as string) as Array<Array<[string, string[]]>>;
      const names: Array<[string, string[]]> = [...own[0]!, ...own[1]!, ['task.dispatch.ci_runner', ['task', 'spend']], ['task.dispatch.local_worker', ['task', 'spend']]];
      expect(names.map((n) => n[0])).toEqual(expect.arrayContaining([
        'goal.activate', 'goal.criteria_change', 'goal.horizon_change', 'goal.done', 'goal.abandon', 'goal.propose', 'plan.change', 'world.commitment.from_chat', 'policy.change', 'triage.rule.create',
        'world.source.enable', 'world.person.create', 'world.relation.write', 'forecast.series.enable', 'asset.enable', 'task.check_bar', 'task.cancel', 'task.bar_override',
        'backup.local', 'backup.offsite', 'restore.drill', 'maintenance.retention', 'backup.prune', 'backup.nexus', 'backup.nexus.offsite', 'restore.drill.nexus',
      ]));
      const KINDS = ['tool_call', 'goal', 'plan', 'rule', 'policy', 'task', 'pr', 'spend', 'forget', 'void'];
      for (const [name, kinds] of names) {
        const args = name === 'policy.change' ? { rows: [] } : {};
        for (const kind of kinds) {
          expect(run(`apprOwn(${JSON.stringify({ fullName: name, kind, args })})`), `${name} as ${kind}`).toBe(true);
          expect(run(`apprTitle(${JSON.stringify({ fullName: name, kind, args })})`), `${name} as ${kind}`).not.toBe('Approve a Tool Call');
          // The server's mark alone is enough to take the words away.
          const marked = { fullName: name, kind, mcp: true, args };
          expect(words(marked).slice(0, 2), `${name} marked`).toEqual(['Approve a Tool Call', SUB]);
          expect(alone(marked), `${name} marked`).toBe(true);
        }
        // So is any other kind, a kind that is no kind, or none at all (a card from a server with no runtime).
        for (const kind of [...KINDS.filter((k) => !kinds.includes(k)), 'constructor', '__proto__', '', 7, null, undefined]) {
          const p = { fullName: name, kind, args };
          expect(run(`apprTitle(${JSON.stringify(p)})`), `${name} as ${String(kind)}`).toBe('Approve a Tool Call');
          expect(alone(p), `${name} as ${String(kind)}`).toBe(true);
        }
      }
      // A card's fixed reason is not a way in either: the predictions card that changes second opinions only is worded
      // from its reason, and a tool's card that carries the same name and the same reason gets none of those words.
      const opinion = { fullName: 'forecast.series.enable', kind: 'tool_call', origin: 'console', consequential: true, reason: run('APPR_PREDICT_OPINION') as string, args: { series: ['daily.deploys.count'], reason: [] } };
      expect(run(`apprPredictOnlyOpinion(${JSON.stringify(opinion)})`)).toBe(true);
      expect(run(`apprReason(${JSON.stringify(opinion)})`)).toBe('change a second opinion');
      expect(run(`apprPredictOnlyOpinion(${JSON.stringify({ ...opinion, mcp: true })})`)).toBe(false);
      expect(words({ ...opinion, mcp: true }).slice(0, 2)).toEqual(['Approve a Tool Call', SUB]);
      expect(run(`apprReason(${JSON.stringify({ ...opinion, mcp: true })})`)).toBe('run a tool on a connected server');
      // A tool under a name that is nobody's is a tool's card as it always was: its own words, and it may share a prompt.
      expect(words(plain())[0]).toBe('Read What Triage Decided');
      expect(alone(plain())).toBe(false);
      expect(alone(plain({ mcp: true, fullName: 'notes.search', args: { q: 'x' } }))).toBe(false);
      // Whatever the tool is called, it is listed whole; a name with no tool after it is all server.
      const odd = { fullName: `task.dispatch.${'x.'.repeat(60)}y`, kind: 'tool_call', mcp: true, origin: 'chat:c1', args: {} };
      expect(facts(odd).slice(0, 2)).toEqual([['Server', 'task'], ['Tool', `dispatch.${'x.'.repeat(60)}y`]]);
      expect(facts({ fullName: 'backup.local', mcp: true, origin: 'chat:c1', args: {} }).slice(0, 2)).toEqual([['Server', 'backup'], ['Tool', 'local']]);

      // In the panel: drawn as a tool's card, marked, skipped by Approve All, signed with a fresh touch and its own prompt.
      const seen: unknown[][] = [];
      ctx.taskNames = (ps: unknown[], done: (n: number) => void) => (seen.push(ps), done(0));
      answer = () => ({ status: 200, body: { proposals: [planted.task, planted.goal, plain({ id: 'x1' })], signed: true } });
      await open();
      // (No card on this list is about a task: the Tasks panel is asked for no name.)
      expect(seen).toHaveLength(0);
      const first = ids.apprlist!.children[0]!.children[0]!;
      expect(first.shown()).toContain('Approve a Tool CallIt’s a tool on a connected server.Asks on Its Own');
      expect(first.shown()).toContain('ServertaskToolcheck_bar');
      expect(first.shown()).not.toMatch(/Accept a Task Result|It passed 2 of 2 checks|Looked Up|wpf002/);
      expect(ids.apprlist!.children[0]!.children[1]!.shown()).toContain('Approve a Tool CallIt’s a tool on a connected server.Asks on Its Own');
      expect(ids.apprlist!.textContent).not.toMatch(/Add a Goal|Start a Goal/);
      expect(noteSays()).toBe('You have 3 approvals waiting. Approve All skips 2.');
      ids.apprall!.onclick!();
      await settle();
      expect(decided.map((d) => d[1])).toEqual(['x1']);
      decided = [];
      first.button('Approve with Password').onclick!();
      expect(decided).toEqual([['approve', 'm1', { reason: 'run a tool on a connected server', fresh: true, args: planted.task.args }]]);
    });

    it('a goal’s task step on a plan card says Flint would run it as a task', () => {
      const says = JSON.parse(run(`JSON.stringify(apprDetails(${JSON.stringify(card({ fullName: 'plan.change', kind: 'plan', args: { goalId: 'go1', goalTitle: 'Finish Building Flint', ops: [{ op: 'add', key: 's4', step: { ordinal: 400, title: 'Watch the release run', kind: 'asset_task', tier: 'approval', dueAt: null, dependsOn: [] } }] } }))}).says)`) as string) as string[];
      expect(says).toContain('Add the step “Watch the release run”. Flint would run this step as a task.');
    });
  });

  it('the approvals panel never writes HTML', () => {
    expect(apprJs.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  });
});
