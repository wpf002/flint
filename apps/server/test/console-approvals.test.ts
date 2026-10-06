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
    expect(ids.apprnote!.textContent).toBe('You have 3 approvals waiting. Approve All skips 1.');
    expect(ids.apprall!.textContent).toBe('Approve All with Password');
    expect(ids.apprhelp!.hidden).toBe(true);
  });

  it('Approve and Reject on the open card take the signed path chat cards use; outside text asks on its own', async () => {
    answer = () => ({ status: 200, body: { signed: true, proposals: [card(), card({ id: 'pr2', tainted: true, fullName: 'world.person.create', args: { people: [] } })] } });
    await open();
    const first = ids.apprlist!.children[0]!.children[0]!;
    first.button('Approve with Password').onclick!();
    first.button('Reject').onclick!();
    expect(decided[0]).toEqual(['approve', 'pr1', { reason: 'approve: Turn On the Deploy Source', fresh: false }]);
    expect(decided[1]).toEqual(['reject', 'pr1']);
    ids.apprlist!.children[0]!.children[1]!.onclick!();
    ids.apprlist!.children[0]!.children[1]!.button('Approve with Password').onclick!();
    expect(decided[2]![2]).toEqual({ reason: 'approve: Add 0 People from Calendar', fresh: true });
  });

  it('Approve All signs each card in turn after one prompt, and leaves outside text and money for their own', async () => {
    answer = () => ({
      status: 200,
      body: { signed: true, proposals: [card({ id: 'a' }), card({ id: 'b', args: { source: 'git' } }), card({ id: 't', tainted: true }), card({ id: 'm', fullName: 'spend.purchase' }), card({ id: 'c', args: { source: 'spend' } })] },
    });
    await open();
    expect(ids.apprnote!.textContent).toBe('You have 5 approvals waiting. Approve All skips 2.');
    run('approveAll()');
    await settle();
    expect(decided.map((d) => d[1])).toEqual(['a', 'b', 'c']);
    expect(decided[0]![2]).toEqual({ reason: 'approve 3 Flint cards' });
    expect(decided[1]![2]).toEqual({ reason: 'approve: Turn On the Git Source' });
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
    expect(ids.apprnote!.textContent).toBe('You have 2 approvals waiting. Approve All skips 1.');
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
  });

  it('the calendar’s cards: its enable card states the source’s real cadence; the promotion that lets Flint add people is in words and asks on its own', async () => {
    const src = readFileSync(join(__dirname, '..', '..', 'runtime', 'src', 'sources', 'google', 'calendar.ts'), 'utf8');
    const minutes = Number(/cadenceMs: (\d+) \* 60_000/.exec(src)![1]);
    const promo = card({ id: 'pz', fullName: 'policy.change', args: { rows: [{ pattern: 'world.sync.google_calendar', expiresAt: '2027-03-29T00:00:00.000Z' }, { pattern: 'world.person.create', dailyCap: 20, expiresAt: '2027-03-29T00:00:00.000Z' }] } });
    answer = () => ({ status: 200, body: { signed: true, proposals: [promo, card({ id: 'gc', args: { source: 'google_calendar' } })] } });
    await open();
    const rows = ids.apprlist!.children[0]!.children;
    expect(rows[0]!.shown()).toContain('LimitsRead Your Calendar · Add People from Calendar 20 a Day');
    expect(rows[0]!.shown()).toContain('Asks on Its Own');
    expect(rows[1]!.shown()).toContain('Turn On the Google Calendar Source');
    expect(rows[1]!.shown()).toContain(`Your calendar is read every ${minutes} minutes.`);
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
    for (const source of ['launchd', 'health', 'git', 'spend', 'deploy', 'knowledge', 'nexus_inbox', 'nexus', 'github', 'railway', 'google_calendar', 'unknown_source']) {
      expect(sub({ fullName: 'world.source.enable', args: { source } })).toMatch(/^[A-Z].*\.$/);
    }
    expect(sub({ fullName: 'world.source.enable', args: { source: 'unknown_source' } })).toBe('Flint starts reading this source.');
    expect(sub({ fullName: 'policy.change', args: { rows: [{}] } })).toBe('It changes what Flint may do on its own.');
    expect(sub({ fullName: 'world.person.create', args: {} })).toBe('They’re from events you accepted or organized.');
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
    expect(ids.apprnote!.textContent).toBe('You have 1 approval waiting.');
  });

  it('the approvals panel never writes HTML', () => {
    expect(apprJs.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  });
});
