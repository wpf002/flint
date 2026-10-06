/**
 * The console's Approvals panel (apps/console/index.html, its own <script
 * id="approvals-js">), run against a small fake DOM that refuses innerHTML:
 * every pending card the server lists says what it would do in words (the
 * open one with three facts or fewer, the raw args behind Show Details), with
 * outside text marked and inert; Approve and Reject go through the signed path
 * chat cards use; Approve All signs each card in turn and leaves a card with
 * outside text or money for its own prompt; a device without an approval key
 * is pointed to Settings; an approved card that did not run can be run; the
 * header badge counts what is waiting.
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
    errText: (e: Error) => (e.message === 'not confirmed' ? 'Cancelled' : e.message),
    starters: () => {},
    openSettings: () => void (panels.settings = true),
  };
  createContext(ctx);
  runInContext(apprJs, ctx);
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
    expect(first).toContain('UntilMar 29, 2027');
    expect(first).toContain('LimitsBackup 1 a Day · Restore Test 1 a Week · Offsite 1 a Day');
    expect(first).toContain('Filed ByYou');
    // The raw args and the reason wait behind Show Details.
    expect(first).not.toContain('backup.local');
    rows[0]!.button('Show Details').onclick!();
    expect(rows[0]!.shown()).toContain('"pattern": "backup.local"');
    expect(rows[0]!.shown()).toContain('The shadow week: 1.2 relevant a day.');
    expect(rows[1]!.shown()).toContain('Turn On the Deploy Source');
    expect(rows[1]!.shown()).toContain('Deploy results, every minute');
    expect(rows[2]!.shown()).toContain('Add 1 Person from Calendar');
    expect(rows[2]!.shown()).toContain('Outside Text');
    // Opening a row shows its facts; the invitation's markup arrives as literal text.
    rows[2]!.onclick!();
    expect(ids.apprlist!.children[0]!.children[2]!.shown()).toContain('<img src=x onerror=alert(1)>Ada');
    expect(ids.apprnote!.textContent).toBe('3 Waiting · 1 Ask on Their Own');
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
    expect(ids.apprnote!.textContent).toBe('5 Waiting · 2 Ask on Their Own');
    run('approveAll()');
    await settle();
    expect(decided.map((d) => d[1])).toEqual(['a', 'b', 'c']);
    expect(decided[0]![2]).toEqual({ reason: 'approve 3 Flint cards' });
    expect(decided[1]![2]).toEqual({ reason: 'approve: Turn On the Git Source' });
    expect(ids.apprnote!.textContent).toBe('Approved 3 of 3');
  });

  it('Approve All stops at the first card that is not approved, and says how far it got', async () => {
    answer = () => ({ status: 200, body: { signed: true, proposals: [card({ id: 'a' }), card({ id: 'b' }), card({ id: 'c' })] } });
    await open();
    failApprove = 'b';
    run('approveAll()');
    await settle();
    expect(decided.map((d) => d[1])).toEqual(['a', 'b']);
    expect(ids.apprnote!.textContent).toBe('Approved 1 of 3. Cancelled');
  });

  it('a device without an approval key is pointed to Settings', async () => {
    keyed = false;
    answer = () => ({ status: 200, body: { signed: true, proposals: [card()] } });
    await open();
    expect(ids.apprnote!.textContent).toBe('Add an approval key to approve');
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
    expect(row.shown()).toContain('Turn On the Deploy SourceApproved, not run yet');
    row.button('Run Now').onclick!();
    await settle();
    expect(calls.at(-1)).toEqual({ url: '/proposals/run', method: 'POST', body: { id: 'pr1' } });
    answer = () => ({ status: 200, body: { signed: true, proposals: [], runtime: 'down' } });
    await open();
    expect(ids.apprseg!.hidden).toBe(true);
    expect(ids.apprhelp!.textContent).toBe("The runtime isn't answering, so its cards can't be shown.");
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
    expect(rows[1]!.shown()).toContain('Filed by You');
    expect(rows[1]!.shown()).not.toContain('world.unknown.thing');
    expect(ids.apprnote!.textContent).toBe('2 Waiting · 1 Ask on Their Own');
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
    expect(rows[1]!.shown()).toContain(`Your calendar, read-only, every ${minutes} minutes`);
    run('approveAll()');
    await settle();
    expect(decided.map((d) => d[1])).toEqual(['gc']);
  });

  it('a signed person card says who was added, and who was not', () => {
    const fns = /(function resText[\s\S]*?function showOutcome[\s\S]*?'bad'\);\})/.exec(html)![1]!;
    const c: Record<string, unknown> = {};
    createContext(c);
    runInContext(fns, c);
    const say = (action: Record<string, unknown>) => {
      const r = new El('div'), row = new El('div');
      (c.showOutcome as (d: unknown, r: El, row: El) => void)({ action }, r, row);
      return r.textContent;
    };
    expect(say({ status: 'done', result: { created: 0, skipped: 3 } })).toBe('Nobody Added · Skipped 3');
    expect(say({ status: 'done', result: { created: 2, skipped: 1 } })).toBe('Added 2 People · Skipped 1');
    expect(say({ status: 'done', result: { created: 1, skipped: 0 } })).toBe('Added 1 Person');
    expect(say({ status: 'done', note: 'ran tonight', result: { relationId: 'r1' } })).toBe('Done: ran tonight');
  });

  it('a chat lookup in Flint’s world model is named in words, the same words its notes use, for every tool the runtime connector serves', async () => {
    answer = () => ({ status: 200, body: { signed: true, proposals: [card({ id: 'w', fullName: 'runtime.world_now', origin: 'chat:abc', args: {} })] } });
    await open();
    const shown = ids.apprlist!.children[0]!.children[0]!.shown();
    expect(shown).toContain('Check What’s Happening Now');
    expect(shown).not.toMatch(/runtime|World Now/);
    // Closed, a card shows its line in words too.
    expect(run(`apprSub({fullName:'runtime.world_now',args:{}})`)).toBe('Services, counts and open items in Flint’s world model');
    const tools = run('APPR_TOOLS') as Record<string, [string, string]>;
    const src = readFileSync(join(__dirname, '..', '..', '..', 'packages', 'mcp', 'connectors', 'runtime-server.ts'), 'utf8');
    const served = [...src.matchAll(/registerTool\(\s*'([a-z_]+)'/g)].map((m) => `runtime.${m[1]}`).sort();
    expect(served.length).toBeGreaterThan(0);
    expect(Object.keys(tools).sort()).toEqual(served);
    for (const name of served) expect(tools[name]![0]).toBe(ACTION_WORDS[name]);
  });

  it('the approvals panel never writes HTML', () => {
    expect(apprJs.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  });
});
