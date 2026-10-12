/**
 * The console's Approvals panel (apps/console/index.html, its own <script
 * id="approvals-js">), run against a small fake DOM that refuses innerHTML:
 * every pending card the server lists says what it would do in words (the
 * open one with three facts or fewer, the raw args behind Show Details), with
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
import { ACTION_WORDS } from '@flint/policy';

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
  id: 'pr1', fullName: 'world.source.enable', args: { source: 'deploy' }, tainted: false, status: 'pending', origin: 'cli', ts: Date.now() - 3600_000,
  expiresAt: '2026-10-12T14:00:00.000Z', ...over,
});
const textNode = (t: string) => Object.assign(new El('#text'), { textContent: t });

beforeEach(() => {
  calls = [];
  decided = [];
  failApprove = null;
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
      return failApprove === id ? Promise.reject(new Error('not confirmed')) : Promise.resolve({ action: { status: 'done' } });
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
          card({ id: 'pr0', fullName: 'policy.change', reason: 'The shadow week: 1.2 relevant a day.', args: { rows: [{ pattern: 'backup.local', expiresAt: '2027-03-29T00:00:00.000Z' }, { pattern: 'restore.drill', expiresAt: '2027-03-29T00:00:00.000Z' }, { pattern: 'backup.offsite', expiresAt: '2027-03-29T00:00:00.000Z' }] } }),
          card(),
          card({ id: 'pr2', fullName: 'world.person.create', origin: 'runtime:google_calendar', tainted: true, args: { people: [{ name: '<img src=x onerror=alert(1)>Ada', email: 'ada@example.com' }] } }),
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
    expect(first).toContain('Run Backups on Their OwnIt lasts until Mar 29, 2027.');
    expect(first).toContain('UntilMar 29, 2027');
    expect(first).toContain('LimitsBackup 1 a Day · Restore Test 1 a Week · Offsite 1 a Day');
    expect(first).toContain('Filed ByYou');
    // The raw args and the reason wait behind Show Details.
    expect(first).not.toContain('backup.local');
    rows[0]!.button('Show Details').onclick!();
    expect(rows[0]!.shown()).toContain('"pattern": "backup.local"');
    expect(rows[0]!.shown()).toContain('The shadow week: 1.2 relevant a day.');
    expect(rows[1]!.shown()).toContain('Turn On the Deploy Source');
    expect(rows[1]!.shown()).toContain('Turn On the Deploy SourceDeploy results are read every minute.');
    expect(rows[2]!.shown()).toContain('Add 1 Person from Calendar');
    expect(rows[2]!.shown()).toContain('Outside Text');
    // Opening a row shows its facts; the invitation's markup arrives as literal text.
    rows[2]!.onclick!();
    expect(ids.apprlist!.children[0]!.children[2]!.shown()).toContain('<img src=x onerror=alert(1)>Ada');
    expect(noteSays()).toBe('You have 3 approvals waiting. Approve All skips 1.');
    expect(ids.apprall!.textContent).toBe('Approve All with Password');
    expect(ids.apprhelp!.hidden).toBe(true);
  });

  it('Approve and Reject on the open card take the signed path chat cards use; outside text asks on its own', async () => {
    answer = () => ({ status: 200, body: { signed: true, proposals: [card(), card({ id: 'pr2', tainted: true, fullName: 'world.person.create', args: { people: [] } })] } });
    await open();
    const first = ids.apprlist!.children[0]!.children[0]!;
    first.button('Approve with Password').onclick!();
    first.button('Reject').onclick!();
    // The args the card shows go with it: what is signed must hash to them (the main script checks the challenge).
    expect(decided[0]).toEqual(['approve', 'pr1', { reason: 'approve: Turn On the Deploy Source', fresh: false, args: { source: 'deploy' } }]);
    expect(decided[1]).toEqual(['reject', 'pr1']);
    ids.apprlist!.children[0]!.children[1]!.onclick!();
    ids.apprlist!.children[0]!.children[1]!.button('Approve with Password').onclick!();
    expect(decided[2]![2]).toEqual({ reason: 'approve: Add 0 People from Calendar', fresh: true, args: { people: [] } });
  });

  it('Approve All signs each card in turn after one prompt, and leaves outside text and money for their own', async () => {
    answer = () => ({
      status: 200,
      body: { signed: true, proposals: [card({ id: 'a' }), card({ id: 'b', args: { source: 'git' } }), card({ id: 't', tainted: true }), card({ id: 'm', fullName: 'spend.purchase' }), card({ id: 'c', args: { source: 'spend' } })] },
    });
    await open();
    expect(noteSays()).toBe('You have 5 approvals waiting. Approve All skips 2.');
    run('approveAll()');
    await settle();
    expect(decided.map((d) => d[1])).toEqual(['a', 'b', 'c']);
    expect(decided[0]![2]).toEqual({ reason: 'approve 3 Flint cards', args: { source: 'deploy' } });
    expect(decided[1]![2]).toEqual({ reason: 'approve: Turn On the Git Source', args: { source: 'git' } });
    expect(ids.apprnote!.textContent).toBe('You approved 3 of 3.');
  });

  it('Approve All stops at the first card that is not approved, and says how far it got', async () => {
    answer = () => ({ status: 200, body: { signed: true, proposals: [card({ id: 'a' }), card({ id: 'b' }), card({ id: 'c' })] } });
    await open();
    failApprove = 'b';
    run('approveAll()');
    await settle();
    expect(decided.map((d) => d[1])).toEqual(['a', 'b']);
    expect(ids.apprnote!.textContent).toBe('You approved 1 of 3. Cancelled.');
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
    answer = () => ({ status: 200, body: { signed: true, proposals: [card({ id: 'pp', fullName: 'world.person.create', origin: 'runtime:google_calendar', tainted: true, args: { people } })] } });
    await open();
    const shown = ids.apprlist!.children[0]!.children[0]!.shown();
    expect(shown).toContain('Add 3 People from Calendar');
    expect(shown).toContain('PeopleKim, Alex (alex.kim@corp.example) · Mom (mallory@evil.example) · sam@corp.example');
    expect(shown).not.toContain('a'.repeat(64));
    expect(shown).toContain('Outside Text');
    // A card that names no calendar is Google's, as every P2.5 card was.
    expect(shown).toContain('They’re from Google Calendar events you accepted or organized.');
  });

  it('a person card says which calendar its people came from in its subtitle, the one Will signs, and still says when it expires', async () => {
    const people = [{ name: 'Ada Lovelace', email: 'ada@example.com', emailHash: 'a'.repeat(64) }];
    const shown = async (args: Record<string, unknown>) => {
      answer = () => ({ status: 200, body: { signed: true, proposals: [card({ id: 'pc', fullName: 'world.person.create', origin: 'runtime:apple_calendar', tainted: true, args })] } });
      await open();
      const row = ids.apprlist!.children[0]!.children[0]!;
      const dl = row.all().find((e) => e.tagName === 'dl')!;
      return { text: row.shown(), facts: dl.children.map((e) => e.textContent) };
    };
    const apple = await shown({ people, source: 'apple_calendar' });
    expect(apple.text).toContain('They’re from Apple Calendar events you accepted or organized.');
    expect(apple.facts).toEqual(['People', 'Ada Lovelace (ada@example.com)', 'Filed By', 'Flint', 'Expires', run(`apprDate('2026-10-12T14:00:00.000Z')`)]);
    expect((await shown({ people, source: 'google_calendar' })).text).toContain('They’re from Google Calendar events you accepted or organized.');
    expect((await shown({ people })).text).toContain('They’re from Google Calendar events you accepted or organized.');
  });

  it('the calendar’s cards: its enable card states the source’s real cadence; the promotion that lets Flint add people is in words and asks on its own', async () => {
    const src = readFileSync(join(__dirname, '..', '..', 'runtime', 'src', 'sources', 'google', 'calendar.ts'), 'utf8');
    const minutes = Number(/cadenceMs: (\d+) \* 60_000/.exec(src)![1]);
    const promo = card({ id: 'pz', fullName: 'policy.change', args: { rows: [{ pattern: 'world.sync.google_calendar', expiresAt: '2027-03-29T00:00:00.000Z' }, { pattern: 'world.person.create', dailyCap: 20, expiresAt: '2027-03-29T00:00:00.000Z' }] } });
    answer = () => ({ status: 200, body: { signed: true, proposals: [promo, card({ id: 'gc', args: { source: 'google_calendar' } })] } });
    await open();
    const rows = ids.apprlist!.children[0]!.children;
    expect(rows[0]!.shown()).toContain('LimitsRead Your Google Calendar · Add People from Calendar 20 a Day');
    expect(rows[0]!.shown()).toContain('Asks on Its Own');
    expect(rows[1]!.shown()).toContain('Turn On the Google Calendar Source');
    expect(rows[1]!.shown()).toContain(`Your Google Calendar is read every ${minutes} minutes.`);
    run('approveAll()');
    await settle();
    expect(decided.map((d) => d[1])).toEqual(['gc']);
  });

  it('Apple Calendar’s cards (P2.6): turning it on says how it reads in a sentence; its promotion is in words and goes with Approve All', async () => {
    const src = readFileSync(join(__dirname, '..', '..', 'runtime', 'src', 'sources', 'apple', 'calendar.ts'), 'utf8');
    const minutes = Number(/cadenceMs: (\d+) \* 60_000/.exec(src)![1]);
    const promo = card({ id: 'pa', fullName: 'policy.change', args: { rows: [{ pattern: 'world.sync.apple_calendar', expiresAt: '2027-03-29T00:00:00.000Z' }] } });
    answer = () => ({ status: 200, body: { signed: true, proposals: [promo, card({ id: 'ac', args: { source: 'apple_calendar' } })] } });
    await open();
    const rows = ids.apprlist!.children[0]!.children;
    expect(rows[0]!.shown()).toContain('LimitsRead Your Apple Calendar');
    // Reading alone adds no one, so it doesn't ask on its own.
    expect(rows[0]!.shown()).not.toContain('Asks on Its Own');
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

  it('the restore test’s card never names a time already past: on the Sunday it was filed, it runs next Sunday', async () => {
    const drill = (status: string) => card({ id: 'drill', fullName: 'restore.drill', origin: 'runtime:drill', status, args: {} });
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
      expect(sub({ fullName: 'world.source.enable', args: { source } })).toMatch(/^[A-Z].*\.$/);
    }
    expect(sub({ fullName: 'world.source.enable', args: { source: 'unknown_source' } })).toBe('Flint starts reading this source.');
    expect(sub({ fullName: 'policy.change', args: { rows: [{}] } })).toBe('It changes what Flint may do on its own.');
    // A card that names no calendar is Google's, as every P2.5 card was.
    expect(sub({ fullName: 'world.person.create', args: {} })).toBe('They’re from Google Calendar events you accepted or organized.');
    expect(sub({ fullName: 'world.person.create', args: { source: 'apple_calendar' } })).toBe('They’re from Apple Calendar events you accepted or organized.');
    expect(sub({ fullName: 'triage.rule.create', args: {} })).toBe('This adds a new rule.');
    expect(sub({ fullName: 'triage.rule.create', args: { rule: { name: 'ci-red' } } })).toBe('ci-red');
    expect(sub({ fullName: 'world.relation.write', args: {} })).toBe('Flint’s memory suggests this link.');
    expect(sub({ fullName: 'mcp.x', origin: 'console' })).toBe('You filed this.');
    expect(sub({ fullName: 'mcp.x', origin: 'runtime:knowledge' })).toBe('Flint filed this.');
    expect(sub({ fullName: 'mcp.x', origin: 'chat:abc' })).toBe('A chat filed this.');
    expect(sub({ fullName: 'mcp.x', origin: 'somewhere' })).toBe('Its source is unknown.');
    expect(sub({ fullName: 'mcp.x' })).toBe('Its source is unknown.');
    for (const [, line] of Object.values(run('APPR_TOOLS') as Record<string, [string, string]>)) expect(line).toMatch(/^Flint .*\.$/);
  });

  it('one card waiting says so in the singular', async () => {
    answer = () => ({ status: 200, body: { signed: true, proposals: [card()] } });
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
    expect(say({ fullName: 'goal.activate', args: { title: 'Synthetic goal', successCriteria: crit, horizonAt: h }, reason: 'Approving starts this goal.' }))
      .toEqual(['Add a Goal', 'It starts as soon as you approve.', [['Goal', 'Synthetic goal'], ['Checks', '3 Checks'], ['Finish By', run(`apprDate('${h}')`)]], 'target']);
    expect(say({ fullName: 'goal.activate', args: { title: 'Synthetic goal', successCriteria: crit.slice(0, 1), horizonAt: null, origin: 'flint' } }).slice(0, 3))
      .toEqual(['Activate a Goal', 'It starts as soon as you approve.', [['Goal', 'Synthetic goal'], ['Checks', '1 Check'], ['Finish By', 'No Date']]]);
    expect(say({ fullName: 'goal.activate', args: { title: 'Synthetic goal', successCriteria: crit }, reason: 'Approving resumes this goal.' }).slice(0, 2)).toEqual(['Resume a Goal', 'It resumes as soon as you approve.']);
    expect(say({ fullName: 'goal.criteria_change', args: { title: 'Synthetic goal', successCriteria: crit } }).slice(0, 3)).toEqual(['Change a Goal', 'This changes what counts as done.', [['Goal', 'Synthetic goal'], ['Checks', '3 Checks']]]);
    expect(say({ fullName: 'goal.horizon_change', args: { goalTitle: 'Synthetic goal', horizonAt: null, reviewCadence: 'P2W' } }).slice(0, 3))
      .toEqual(['Change a Goal’s Timing', 'This changes its date or how often it’s reviewed.', [['Goal', 'Synthetic goal'], ['Finish By', 'No Date'], ['Review Every', '2 Weeks']]]);
    expect(say({ fullName: 'goal.done', args: { goalTitle: 'Synthetic goal' } }).slice(0, 3)).toEqual(['Mark a Goal Done', 'Flint stops reviewing it.', [['Goal', 'Synthetic goal'], ['Filed By', 'You'], ['Expires', run(`apprDate('2026-10-16T14:00:00.000Z')`)]]]);
    expect(say({ fullName: 'goal.abandon', args: { goalTitle: 'Synthetic goal' } }).slice(0, 2)).toEqual(['Abandon a Goal', 'Flint stops reviewing it, and it can’t be restarted.']);
    // A review's cards as the runtime files them: each change with the step as it is now (`from`). The dates move by two days.
    const was = new Date(Date.parse(h) - 2 * 86_400_000).toISOString();
    const ops = [
      { op: 'add', key: 's4' }, { op: 'set', key: 's1', from: { title: 'Synthetic step one', dueAt: was }, to: { dueAt: h } },
      { op: 'set', key: 's2', from: { title: 'Synthetic step two', dueAt: was }, to: { dueAt: h } }, { op: 'set', key: 's3', from: { title: 'Synthetic step three', status: 'todo' }, to: { status: 'blocked' } },
    ];
    expect(say({ fullName: 'plan.change', origin: 'runtime:goals', templateId: 'plan.diff.minor', args: { goalTitle: 'Synthetic goal', ops: ops.slice(1) } }).slice(0, 3))
      .toEqual(['Update a Plan', 'Flint suggests 3 small changes.', [['Goal', 'Synthetic goal'], ['Changes', 'Move 2 Dates · Mark 1 Blocked'], ['Filed By', 'Flint']]]);
    expect(say({ fullName: 'plan.change', origin: 'runtime:goals', templateId: 'plan.diff.material', args: { goalTitle: 'Synthetic goal', ops: ops.slice(0, 1) } }).slice(0, 2)).toEqual(['Change a Plan', 'Flint suggests a bigger change.']);
    expect(say({ fullName: 'plan.change', args: { goalTitle: 'Synthetic goal', ops: ops.slice(0, 1) } }).slice(0, 3)).toEqual(['Change a Plan', 'You asked for this change.', [['Goal', 'Synthetic goal'], ['Changes', 'Add 1 Step'], ['Filed By', 'You']]]);
    expect(say({ fullName: 'goal.propose', origin: 'chat:c1', args: { title: 'Synthetic goal', quote: 'I want to run a half marathon' } }).slice(0, 3))
      .toEqual(['Suggest a Goal from Chat', 'You said this in a chat.', [['Goal', 'Synthetic goal'], ['You Said', 'I want to run a half marathon']]]);
    expect(say({ fullName: 'world.commitment.from_chat', origin: 'chat:c1', args: { quote: 'I will send it by Friday', dueAt: h } }).slice(0, 3))
      .toEqual(['Add a Commitment from Chat', 'You said this in a chat.', [['You Said', 'I will send it by Friday'], ['Due', run(`apprDate('${h}')`)]]]);
    // A card whose args were cleared says what it still knows, and no empty facts.
    expect(say({ fullName: 'goal.done', args: null })[2]).toEqual([['Filed By', 'You'], ['Expires', run(`apprDate('2026-10-16T14:00:00.000Z')`)]]);
    expect(say({ fullName: 'goal.activate', args: null }).slice(0, 3)).toEqual(['Add a Goal', 'It starts as soon as you approve.', []]);
    // The policy card names P3's rows in words.
    expect(say({ fullName: 'policy.change', args: { rows: [{ pattern: 'goal.review.local', dailyCap: 20 }, { pattern: 'goal.propose', dailyCap: 3 }, { pattern: 'world.commitment.from_chat', dailyCap: 10 }] } })[2])
      .toContainEqual(['Limits', 'Review Your Goals 20 a Day · Suggest Goals from Chat 3 a Day · Add Commitments from Chat 10 a Day']);
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

  it('every goal card, and every consequential card, asks on its own with a fresh touch and a plain prompt; minor plan and chat suggestions ride Approve All', async () => {
    const goalCard = (id: string, fullName: string, over: Record<string, unknown> = {}) => card({ id, fullName, origin: 'console', sensitivity: 'personal', args: { goalId: 'gotest0001', goalTitle: 'Synthetic goal', title: 'Synthetic goal' }, ...over });
    const alone = ['goal.activate', 'goal.criteria_change', 'goal.horizon_change', 'goal.done', 'goal.abandon'];
    // Even without the server's mark, a goal card's name keeps it alone (an older server).
    for (const a of alone) expect(run(`apprAlone(${JSON.stringify({ fullName: a })})`), a).toBe(true);
    expect(run(`apprAlone(${JSON.stringify({ fullName: 'plan.change', templateId: 'plan.diff.material', consequential: true })})`)).toBe(true);
    expect(run(`apprAlone(${JSON.stringify({ fullName: 'plan.change' })})`)).toBe(true);
    expect(run(`apprAlone(${JSON.stringify({ fullName: 'world.source.enable', consequential: true })})`)).toBe(true);
    const small = [{ op: 'set', key: 's1', from: { title: 'Synthetic step one', status: 'todo' }, to: { status: 'blocked' } }];
    for (const p of [{ fullName: 'plan.change', templateId: 'plan.diff.minor', consequential: false, args: { ops: small } }, { fullName: 'goal.propose' }, { fullName: 'world.commitment.from_chat' }]) {
      expect(run(`apprAlone(${JSON.stringify(p)})`), p.fullName).toBe(false);
    }
    // Review finding 2: which plan card is a small one is read from its operations, never from the template's name alone.
    const due = '2026-10-20T22:00:00.000Z';
    const minor = (ops: unknown[], over: Record<string, unknown> = {}) => ({ fullName: 'plan.change', origin: 'runtime:goals', templateId: 'plan.diff.minor', consequential: false, args: { goalTitle: 'Synthetic goal', ops }, ...over });
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
    expect(says({ fullName: 'plan.change', origin: 'runtime:goals', templateId: 'plan.diff.minor', consequential: false, args: null })[0]).toBe(true);
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
          goalCard('gp', 'goal.propose', { origin: 'chat:c1', args: { title: 'Synthetic', quote: 'Synthetic quoted words' } }),
          card({ id: 'src' }),
        ],
      },
    });
    await open();
    expect(noteSays()).toBe('You have 10 approvals waiting. Approve All skips 7.');
    // The second sentence is one unbreakable run, so a narrow footer never leaves "7." on a line of its own.
    expect(ids.apprnote!.textContent).toBe('You have 10 approvals waiting. Approve\u00a0All\u00a0skips\u00a07.');
    // Approve All signs only the cards that may share one prompt.
    run('approveAll()');
    await settle();
    expect(decided.map((d) => d[1])).toEqual(['pm', 'gp', 'src']);
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
    }
    expect(prompts).toEqual(['add this goal', 'change what counts as done for this goal', 'change this goal’s timing', 'mark this goal done', 'abandon this goal']);
    for (const p of prompts) expect(p).not.toMatch(/goal\.|approve/);
    rows()[6]!.onclick?.();
    rows()[6]!.button('Approve with Password').onclick!();
    expect(decided.at(-1)![2]).toMatchObject({ fresh: true, reason: 'change this goal’s plan' });
  });

  it('Turn On Predictions (P4) is in words, names each number it turns on, and asks on its own with a fresh touch and a plain prompt', async () => {
    const three = ['daily.calendar.hours', 'daily.deploys.count', 'daily.spend.anthropic.usd'];
    const predict = (over: Record<string, unknown> = {}) => card({
      id: 'tp', fullName: 'forecast.series.enable', origin: 'console', sensitivity: 'financial', consequential: true,
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
    expect(run(`apprAlone(${JSON.stringify({ fullName: 'forecast.series.enable', consequential: true, sensitivity: 'ops' })})`)).toBe(true);
    expect(run(`apprAlone(${JSON.stringify({ fullName: 'forecast.series.enable', sensitivity: 'ops' })})`)).toBe(true);
    answer = () => ({ status: 200, body: { signed: true, proposals: [predict({ sensitivity: 'ops', args: { series: all, reason: ['daily.deploys.count', 'daily.spend.anthropic.usd'] } }), card({ id: 'src' })] } });
    await open();
    expect(noteSays()).toBe('You have 2 approvals waiting. Approve All skips 1.');
    const open1 = ids.apprlist!.children[0]!.children[0]!;
    expect(open1.shown()).toContain('Turn On PredictionsFlint forecasts 12 of its own numbers each night, on this Mac.');
    expect(open1.shown()).toContain('Asks on Its Own');
    // Behind Show Details: why, then every number on its own line, in words. No raw args for this card: no key, no JSON.
    const details = open1.all().find((e) => e.className === 'details')!;
    expect(details.hidden).toBe(true);
    expect(details.all().filter((e) => e.tagName === 'pre')).toEqual([]);
    expect(details.all().filter((e) => e.tagName === 'p').map((e) => e.textContent)).toEqual(['Approving turns on Flint’s forecasts of these numbers, on this Mac.']);
    expect(details.all().filter((e) => e.tagName === 'li').map((e) => e.textContent)).toEqual([
      'Anthropic Spend · Spending · Second Opinion', 'OpenAI Spend · Spending', 'Perplexity Spend · Spending', 'Tavily Spend · Spending', 'Deploys · Second Opinion',
      'Flint Commits', 'Nexus Commits', 'Trident Commits', 'Helm Commits', 'Service Downtime', 'Open Threads', 'Calendar Hours · Calendar',
    ]);
    open1.button('Show Details').onclick!();
    expect(details.hidden).toBe(false);
    expect(open1.shown()).not.toMatch(/forecast\.series|daily\.|weekly\.|\.usd|\.count|[{}[\]"]/);
    // Every other card still shows its raw args there.
    const other = ids.apprlist!.children[0]!.children[1]!;
    other.onclick!();
    expect(ids.apprlist!.children[0]!.children[1]!.all().filter((e) => e.tagName === 'pre').map((e) => e.textContent)).toEqual([JSON.stringify({ source: 'deploy' }, null, 1)]);
    ids.apprlist!.children[0]!.children[0]!.onclick!();
    run('approveAll()');
    await settle();
    expect(decided.map((d) => d[1])).toEqual(['src']);
    decided = [];
    ids.apprlist!.children[0]!.children[0]!.button('Approve with Password').onclick!();
    expect(decided.at(-1)).toEqual(['approve', 'tp', { reason: 'turn on predictions', fresh: true, args: { series: all, reason: ['daily.deploys.count', 'daily.spend.anthropic.usd'] } }]);
  });

  it('a card approved here is told to the Goals panel, so a New Goal draft whose card it was is spent; a failed one is not', async () => {
    const told: string[] = [];
    ctx.goalsApproved = (p: { id: string }) => void told.push(p.id);
    answer = () => ({ status: 200, body: { signed: true, proposals: [card({ id: 'g1', fullName: 'goal.activate', consequential: true, args: { goalId: 'gotest0001', title: 'Synthetic goal' } })] } });
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

  it('the approvals panel never writes HTML', () => {
    expect(apprJs.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  });
});
