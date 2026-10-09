/**
 * The console's Goals panel (apps/console/index.html, <script id="goals-js">),
 * run against a small fake DOM whose innerHTML setter throws: ES5 and text only;
 * the exact words (Title Case titles, buttons, tabs and labels; UPPERCASE section
 * headers through .gsh; every secondary line a sentence); never "Late" (reviews
 * come in a later part); the form refuses what cannot be filed, in sentences;
 * Add Goal posts /goals and then signs exactly the args it showed, with a fresh
 * touch and a prompt in plain words (the args are already what the shared
 * contract normalizes them to, so their digest is the one filed); a cancelled
 * prompt leaves the card in Approvals; pausing, marks and step ticks are unsigned;
 * the item search is a POST and the stored label comes from the item's key; and
 * the Goals button hides while the server answers 501.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { webcrypto } from 'node:crypto';
import { GOAL_CARD_BODIES, NewGoalBody, digestOf } from '@flint/policy';

const html = readFileSync(join(__dirname, '..', '..', 'console', 'index.html'), 'utf8');
const goalsJs = /<script id="goals-js">([\s\S]*?)<\/script>/.exec(html)![1]!;
const mainJs = /<script>\n\/\* ---------- config ---------- \*\/([\s\S]*?)<\/script>/.exec(html)![1]!;
const canonJs = /\nfunction canonJson\(v\)\{[\s\S]*?\n(?=function shownDigest)/.exec(mainJs)![0];
const unsignable = /\nvar UNSIGNABLE=[^\n]*\n/.exec(mainJs)![0];

class El {
  className = '';
  children: El[] = [];
  style: Record<string, string> = {};
  onclick: ((ev?: unknown) => void) | null = null;
  oninput: (() => void) | null = null;
  onchange: (() => void) | null = null;
  onkeydown: ((ev: { key: string }) => void) | null = null;
  disabled = false;
  hidden = false;
  value = '';
  type = '';
  placeholder = '';
  maxLength = -1;
  tabIndex = -1;
  seq?: number;
  private text = '';
  private attrs: Record<string, string> = {};
  private readonly classes = new Set<string>();
  constructor(readonly tagName: string, public id = '') {}
  readonly classList = {
    add: (c: string) => void this.classes.add(c),
    remove: (c: string) => void this.classes.delete(c),
    toggle: (c: string, on?: boolean) => void ((on ?? !this.classes.has(c)) ? this.classes.add(c) : this.classes.delete(c)),
    contains: (c: string) => this.classes.has(c) || this.className.split(' ').includes(c),
  };
  get textContent(): string {
    return this.text + this.children.map((c) => c.textContent).join('');
  }
  set textContent(v: string) {
    this.children = [];
    this.text = String(v);
  }
  set innerHTML(_v: string) {
    throw new Error('innerHTML is not allowed in the goals panel');
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
  insertBefore(c: El, ref: El): El {
    const i = this.children.indexOf(ref);
    this.children.splice(i < 0 ? this.children.length : i, 0, c);
    return c;
  }
  focus() {}
  all(): El[] {
    return this.children.flatMap((c) => [c, ...c.all()]);
  }
  /** A button by its text, among what is shown. */
  button(text: string): El {
    const b = this.visible().find((e) => e.tagName === 'button' && e.textContent === text);
    if (!b) throw new Error(`no button "${text}" in: ${this.shown()}`);
    return b;
  }
  buttons(): string[] {
    return this.visible().filter((e) => e.tagName === 'button' && e.textContent).map((e) => e.textContent);
  }
  visible(): El[] {
    return this.hidden ? [] : this.children.flatMap((c) => (c.hidden ? [] : [c, ...c.visible()]));
  }
  shown(): string {
    return this.hidden ? '' : this.text + this.children.map((c) => c.shown()).join('');
  }
  /** Inputs and selects by their label. */
  field(label: string): El {
    const f = this.visible().find((e) => (e.tagName === 'input' || e.tagName === 'select' || e.tagName === 'textarea') && e.getAttribute('aria-label') === label);
    if (!f) throw new Error(`no field "${label}"`);
    return f;
  }
}

type Call = { url: string; method: string; body: unknown };
let calls: Call[];
let routes: (c: Call) => { status: number; body: unknown };
let ids: Record<string, El>;
let signed: Array<[string, Record<string, unknown>]>;
let signAnswer: () => Promise<unknown>;
let keyed: boolean;
let panels: Record<string, boolean>;
let ctx: Record<string, unknown>;

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};
const run = (code: string) => runInContext(code, ctx);

const DAY = 86_400_000;
const later = (days: number) => new Date(Date.now() + days * DAY);
const day = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const row = (over: Record<string, unknown> = {}) => ({
  id: 'gotestgoal0001', title: 'Synthetic goal one', status: 'active', origin: 'will', checks: { met: 1, total: 3, unknown: 0 }, horizonAt: null, reviewCadence: 'P1W',
  endedAt: null, waiting: 0, late: false, tainted: false, ...over,
});
const view = (over: Record<string, unknown> = {}) => ({
  id: 'gotestgoal0001', title: 'Synthetic goal one', description: 'Synthetic reason', status: 'active', owner: 'will', origin: 'will', sensitivity: 'personal', tainted: false, nexusProjectId: null,
  successCriteria: [
    { id: 'c1', text: 'Synthetic manual check', check: { kind: 'manual' } },
    { id: 'c2', text: 'Synthetic merged check', check: { kind: 'item', entityId: 'enpr57', key: 'state', value: 'merged' } },
    { id: 'c3', text: 'Synthetic steps check', check: { kind: 'steps', keys: ['s1', 's2'] } },
  ],
  criteria: [{ id: 'c1', state: 'met' }, { id: 'c2', state: 'unmet' }, { id: 'c3', state: 'unknown' }],
  checks: { met: 1, total: 3, unknown: 1 }, horizonAt: new Date(2026, 11, 1, 23, 59).toISOString(), reviewCadence: 'P1W', activatedAt: '2026-10-09T15:00:00.000Z', endedAt: null,
  links: [{ entityId: 'enpr57', role: 'target', watchPaths: ['state'], label: 'wpf002/flint #57', kind: 'pull_request', status: 'active' }],
  plan: { version: 1, steps: [
    { key: 's1', ordinal: 100, title: 'Synthetic step one', kind: 'will_task', tier: 'approval', status: 'todo', dueAt: new Date(2026, 9, 14, 17, 0).toISOString(), dependsOn: [] },
    { key: 's2', ordinal: 200, title: 'Synthetic step two', kind: 'will_task', tier: 'approval', status: 'done', dueAt: null, dependsOn: [] },
    { key: 's3', ordinal: 300, title: 'Synthetic Flint step', kind: 'flint_action', tier: 'approval', status: 'todo', dueAt: null, dependsOn: [] },
  ] },
  waiting: [], reviews: 'off', late: false, ...over,
});

beforeEach(() => {
  calls = [];
  signed = [];
  keyed = true;
  panels = {};
  signAnswer = async () => ({ action: { status: 'done' } });
  routes = (c) => {
    if (c.url.startsWith('/goals?tab=active')) return { status: 200, body: { tab: 'active', goals: [], waiting: [], reviews: 'off' } };
    if (c.url.startsWith('/goals?tab=')) return { status: 200, body: { tab: 'x', goals: [], waiting: [], reviews: 'off' } };
    return { status: 200, body: { ok: true } };
  };
  ids = Object.fromEntries(['goals', 'goalsbtn', 'goalsdot', 'goalsttl', 'goalback', 'goaladd', 'goalbody', 'goalfoot'].map((id) => [id, new El('div', id)]));
  const document = {
    getElementById: (id: string) => ids[id] ?? [...Object.values(ids)].flatMap((e) => e.all()).find((e) => e.id === id) ?? null,
    createElement: (tag: string) => new El(tag),
    createTextNode: (t: string) => Object.assign(new El('#text'), { textContent: t }),
  };
  const fetch = async (url: string, init: { method?: string; body?: string; headers?: Record<string, string> } = {}) => {
    const c: Call = { url, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : undefined };
    expect(init.headers?.Authorization).toBe('Bearer tok');
    calls.push(c);
    const a = routes(c);
    // Parsed in the page's own realm, as a browser's fetch would.
    return { ok: a.status >= 200 && a.status < 300, status: a.status, json: async () => (runInContext('JSON.parse', ctx) as (t: string) => unknown)(JSON.stringify(a.body)) };
  };
  ctx = {
    document, fetch, BASE: '', TOKEN: 'tok', console, crypto: webcrypto,
    auth: () => ({ Authorization: 'Bearer tok' }),
    setTimeout: (f: () => void) => (f(), 0), clearTimeout: () => {},
    svgi: () => new El('svg'),
    showPanel: (id: string, on: boolean) => void (panels[id] = on),
    loadCreds: () => {}, pollApprovals: () => {}, openApprovals: () => void (panels.approvals = true), openSettings: () => void (panels.settings = true),
    canEnclave: () => keyed, canPasskey: () => false,
    approveLabel: () => (keyed ? 'Approve with Touch ID' : 'Approve'),
    approveAction: (id: string, card: El, o: Record<string, unknown>) => {
      signed.push([id, o]);
      expect(card.querySelector('.res')).toBeTruthy();
      expect(card.querySelector('.prow')).toBeTruthy();
      return signAnswer();
    },
    errText: (e: unknown) => {
      const m = String((e as { message?: string })?.message ?? e);
      return /^not confirmed$/i.test(m) ? 'Cancelled.' : m;
    },
  };
  createContext(ctx);
  runInContext(`${unsignable}${canonJs}`, ctx);
  runInContext(goalsJs, ctx);
});

const open = async () => {
  run('openGoals()');
  await settle();
};
const body = () => ids.goalbody!;
const foot = () => ids.goalfoot!;
/** Every line under a title in the panel (a row's second line), outside text left out. */
const lines = (root: El) => root.visible().filter((e) => e.className === 'lbl' || e.className === 'lbl gwhy').flatMap((l) => l.children.filter((c) => c.tagName === 'span').map((c) => c.textContent));
const SMALL = new Set(['a', 'an', 'the', 'and', 'but', 'or', 'nor', 'for', 'so', 'yet', 'as', 'at', 'by', 'from', 'in', 'into', 'of', 'off', 'on', 'onto', 'out', 'over', 'to', 'up', 'with']);
const titleCase = (s: string) => s.split(' ').every((w, i, all) => !w || /^[^a-z]/.test(w) || (i > 0 && i < all.length - 1 && SMALL.has(w)));

describe('the Goals panel', () => {
  it('is ES5 and text only, with no dialog of its own', () => {
    const code = goalsJs.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(code).not.toMatch(/=>|`|\blet |\bconst |\bclass |\.\.\./);
    expect(code).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    expect(code).not.toMatch(/(^|[^.\w])(alert|confirm|prompt)\s*\(/m);
  });

  it('the Goals button hides while the server answers 501 (an older runtime), and its dot shows when a goal card waits', async () => {
    routes = () => ({ status: 501, body: { error: 'This needs a newer runtime.' } });
    run('goalsProbe()');
    await settle();
    expect(ids.goalsbtn!.hidden).toBe(true);
    routes = () => ({ status: 200, body: { tab: 'active', goals: [], waiting: [], reviews: 'off' } });
    run('goalsProbe()');
    await settle();
    expect(ids.goalsbtn!.hidden).toBe(false);
    run(`goalsDot([{status:'pending',fullName:'world.source.enable'}])`);
    expect(ids.goalsdot!.hidden).toBe(true);
    run(`goalsDot([{status:'pending',fullName:'goal.activate'}])`);
    expect(ids.goalsdot!.hidden).toBe(false);
    run(`goalsDot([{status:'approved',fullName:'plan.change'}])`);
    expect(ids.goalsdot!.hidden).toBe(true);
  });

  it('the empty Active tab: its exact words, one primary Add Goal, Suggested hidden while empty', async () => {
    await open();
    expect(panels.goals).toBe(true);
    expect(ids.goalsttl!.textContent).toBe('Goals');
    expect(body().shown()).toContain('No Goals YetAdd something you’re working toward, and Flint keeps track of it.Add Goal');
    expect(body().button('Add Goal').className).toBe('btn pri');
    expect(ids.goaladd!.hidden).toBe(true);
    expect(body().buttons().filter((b) => ['Active', 'Suggested', 'Finished'].includes(b))).toEqual(['Active', 'Finished']);
    body().button('Add Goal').onclick!();
    expect(ids.goalsttl!.textContent).toBe('New Goal');
  });

  it('a load failure says so in a sentence, with Try Again', async () => {
    routes = () => ({ status: 503, body: { error: 'The runtime isn’t answering, so goals can’t load.' } });
    await open();
    expect(body().shown()).toContain('Couldn’t Load GoalsThe runtime isn’t answering, so goals can’t load.Try Again');
    routes = () => ({ status: 200, body: { tab: 'active', goals: [row()], waiting: [], reviews: 'off' } });
    body().button('Try Again').onclick!();
    await settle();
    expect(body().shown()).toContain('Synthetic goal one');
  });

  it('the list: Will’s titles, one sentence each, badges, and never Late', async () => {
    routes = (c) => (c.url === '/goals?tab=active'
      ? { status: 200, body: { tab: 'active', reviews: 'off', waiting: [{ proposalId: 'pr9', goalId: 'gotestgoal0009', title: 'Synthetic waiting goal', checks: 1 }], goals: [
        row(), row({ id: 'gotestgoal0002', title: 'Synthetic paused', status: 'paused', origin: 'flint' }), row({ id: 'gotestgoal0003', title: 'Synthetic met', checks: { met: 2, total: 2, unknown: 0 }, waiting: 1, late: true }),
        row({ id: 'gotestgoal0004', title: 'Synthetic one check', checks: { met: 0, total: 1, unknown: 0 } }),
      ] } }
      : { status: 200, body: { tab: 'suggested', goals: [row({ id: 'gotestgoal0005', status: 'proposed', origin: 'flint' })], waiting: [], reviews: 'off' } });
    await open();
    const shown = body().shown();
    expect(shown).toContain('Synthetic waiting goalIt starts once you approve it.Waiting for You');
    expect(shown).toContain('Synthetic goal one1 of 3 checks are met.');
    expect(shown).toContain('Synthetic pausedPaused. Flint won’t review it until you resume it.PausedFrom Chat');
    expect(shown).toContain('Synthetic metAll of its checks are met.Waiting for You');
    expect(shown).toContain('Synthetic one check0 of 1 check is met.');
    expect(shown).toContain('Goal reviews are off, so Flint isn’t checking on your goals yet.');
    // No lateness until reviews exist, whatever a row says.
    expect(shown).not.toMatch(/Late|late\./);
    expect(ids.goaladd!.hidden).toBe(false);
    // Suggested shows once Flint has suggested something.
    expect(body().buttons()).toContain('Suggested');
    for (const l of lines(body())) expect(l, l).toMatch(/^[A-Z0-9].*[.!?]$/);
    // A waiting new goal opens Approvals.
    body().visible().find((e) => e.className.startsWith('row'))!.onclick!();
    expect(panels.approvals).toBe(true);
  });

  it('an open goal: facts, DONE WHEN and STEPS in words; Mark Met, step ticks and Pause are unsigned', async () => {
    routes = (c) => (c.url.startsWith('/goals/gotestgoal0001') && c.method === 'GET' ? { status: 200, body: { goal: view() } } : { status: 200, body: { ok: true } });
    run(`goalOpen('gotestgoal0001')`);
    await settle();
    expect(ids.goalsttl!.textContent).toBe('Synthetic goal one');
    expect(ids.goalback!.hidden).toBe(false);
    const shown = body().shown();
    expect(shown).toContain('Checks1 of 3 Met');
    expect(shown).toContain('Finish ByDec 1');
    expect(shown).toContain('Review EveryWeek');
    // Section headers are .gsh, Title Case in the source (CSS makes them UPPERCASE).
    expect(body().visible().filter((e) => e.className === 'gsh').map((e) => e.textContent)).toEqual(['Why It Matters', 'Done When', 'Steps']);
    expect(shown).toContain('Synthetic manual checkYou mark this one.MetMark Not Met');
    expect(shown).toContain('Synthetic merged checkFlint checks this: wpf002/flint #57 is merged.Not Yet');
    expect(shown).toContain('Synthetic steps checkFlint checks this: 1 of 2 steps are done.Unknown');
    expect(shown).toContain('Synthetic step oneIt’s due Oct 14.Mark Done');
    expect(shown).toContain('Synthetic step twoIt’s done.Undo');
    // A Flint action is done by doing it: no button.
    expect(shown).toContain('Synthetic Flint stepIt has no due date.');
    expect(shown).not.toContain('Synthetic Flint stepIt has no due date.Mark Done');
    expect(foot().buttons()).toEqual(['Edit Goal', 'Change Timing', 'Pause', 'Abandon Goal', 'Mark Done']);
    for (const b of [...body().buttons(), ...foot().buttons()]) expect(titleCase(b), b).toBe(true);
    for (const l of lines(body()).filter((l) => l !== 'Synthetic reason')) expect(l, l).toMatch(/^[A-Z].*[.!?]$/);
    expect(shown).not.toMatch(/Late/);

    body().button('Mark Not Met').onclick!();
    await settle();
    expect(calls.find((c) => c.method === 'POST')).toEqual({ url: '/goals/gotestgoal0001/criteria/c1', method: 'POST', body: { met: false } });
    calls = [];
    body().button('Mark Done').onclick!();
    await settle();
    expect(calls.find((c) => c.method === 'POST')).toEqual({ url: '/goals/gotestgoal0001/steps/s1', method: 'POST', body: { status: 'done' } });
    calls = [];
    foot().button('Pause').onclick!();
    await settle();
    expect(calls.find((c) => c.method === 'POST')).toEqual({ url: '/goals/gotestgoal0001/pause', method: 'POST', body: {} });
    expect(signed).toEqual([]);
  });

  it('Abandon asks in place, then files the card and signs exactly its args with a fresh touch and a plain prompt', async () => {
    routes = (c) => (c.method === 'GET' && c.url.startsWith('/goals/') ? { status: 200, body: { goal: view() } } : c.url.endsWith('/abandon') ? { status: 200, body: { id: 'prab', deduped: false } } : { status: 200, body: { ok: true } });
    run(`goalOpen('gotestgoal0001')`);
    await settle();
    foot().button('Abandon Goal').onclick!();
    expect(foot().shown()).toBe('Abandon This GoalFlint stops reviewing it, and it can’t be restarted.CancelAbandon with Touch ID');
    foot().button('Abandon with Touch ID').onclick!();
    await settle();
    const args = { goalId: 'gotestgoal0001', goalTitle: 'Synthetic goal one' };
    expect(calls.find((c) => c.method === 'POST')).toEqual({ url: '/goals/gotestgoal0001/abandon', method: 'POST', body: { args } });
    expect(signed).toEqual([['prab', { fresh: true, reason: 'abandon this goal', args }]]);
    expect(GOAL_CARD_BODIES.abandon.parse({ args })).toEqual({ args });
    expect(body().shown()).toContain('You abandoned this goal.');
  });

  it('Mark Done says how many checks are not met before it signs', async () => {
    routes = (c) => (c.method === 'GET' ? { status: 200, body: { goal: view() } } : { status: 200, body: { id: 'prdone', deduped: false } });
    run(`goalOpen('gotestgoal0001')`);
    await settle();
    foot().button('Mark Done').onclick!();
    expect(foot().shown()).toBe('Mark This Goal Done2 of its checks aren’t met yet.CancelMark Done with Touch ID');
    foot().button('Cancel').onclick!();
    expect(foot().buttons()).toContain('Abandon Goal');
    foot().button('Mark Done').onclick!();
    foot().button('Mark Done with Touch ID').onclick!();
    await settle();
    expect(signed[0]).toEqual(['prdone', { fresh: true, reason: 'mark this goal done', args: { goalId: 'gotestgoal0001', goalTitle: 'Synthetic goal one' } }]);
  });

  it('a paused goal resumes with a signature of exactly what it is, and no plan', async () => {
    const g = view({ status: 'paused' });
    routes = (c) => (c.method === 'GET' ? { status: 200, body: { goal: g } } : { status: 200, body: { id: 'prres', deduped: false } });
    run(`goalOpen('gotestgoal0001')`);
    await settle();
    expect(foot().buttons()).toEqual(['Edit Goal', 'Change Timing', 'Abandon Goal', 'Resume with Touch ID']);
    foot().button('Resume with Touch ID').onclick!();
    await settle();
    const posted = calls.find((c) => c.method === 'POST')!;
    expect(posted.url).toBe('/goals/gotestgoal0001/resume');
    const args = (posted.body as { args: Record<string, unknown> }).args;
    expect(signed[0]).toEqual(['prres', { fresh: true, reason: 'resume this goal', args }]);
    // What it signs is already in the contract's normal form: its digest is the filed card's.
    const parsed = GOAL_CARD_BODIES.resume.parse({ args }) as { args: unknown };
    expect(digestOf(parsed.args)).toBe(digestOf(args));
    expect(args).toMatchObject({ owner: 'will', origin: 'will', sensitivity: 'personal', tainted: false, nexusProjectId: null, plan: null, links: [{ entityId: 'enpr57', role: 'target', watchPaths: ['state'] }] });
  });

  it('Add Goal refuses what cannot be filed, each in a sentence', async () => {
    await open();
    run('goalNew()');
    const add = () => foot().button('Add Goal with Touch ID').onclick!();
    const msg = () => body().all().find((e) => e.id === 'goalmsg')!.textContent;
    add();
    expect(msg()).toBe('Give the goal a name.');
    run(`GOALS.form.title='Synthetic goal'`);
    add();
    expect(msg()).toBe('Add at least one way to know it’s done.');
    run(`GOALS.form.checks[0].method='item';goalForm()`);
    run(`GOALS.form.checks[0].text='Synthetic check'`);
    add();
    expect(msg()).toBe('Choose an item for this check.');
    run(`GOALS.form.checks[0].method='steps';GOALS.form.steps=[{title:'',due:''}];goalForm()`);
    add();
    expect(msg()).toBe('Add a first step for this check.');
    run(`GOALS.form.checks[0].method='manual';GOALS.form.finishBy='${day(new Date())}';goalForm()`);
    add();
    expect(msg()).toBe('Pick a date after today.');
    expect(calls.filter((c) => c.method === 'POST' && c.url !== '/goals/linkable')).toEqual([]);
    expect(signed).toEqual([]);
  });

  it('Add Goal posts /goals, then signs exactly the args it showed, fresh, with a plain prompt; the result is in words', async () => {
    routes = (c) => (c.url === '/goals' && c.method === 'POST' ? { status: 200, body: { id: 'prnew', deduped: false } }
      : c.url === '/goals/linkable' ? { status: 200, body: { items: [{ entityId: 'enpr57', kind: 'pull_request', label: 'wpf002/flint #57', status: 'active', title: 'Outside words <b>', conditions: [{ key: 'state', value: 'merged' }, { key: 'state', value: 'closed' }] }] } }
        : { status: 200, body: { tab: 'active', goals: [], waiting: [], reviews: 'off' } });
    await open();
    run('goalNew()');
    expect(body().visible().filter((e) => e.className === 'gsh').map((e) => e.textContent)).toEqual(['Goal', 'Done When', 'Timing', 'First Steps']);
    for (const label of ['Goal', 'Why It Matters', 'Done When', 'How It’s Checked', 'Finish By', 'Review Every', 'Step', 'Due']) expect(titleCase(label)).toBe(true), body().field(label);
    expect(body().field('Goal').placeholder).toBe('Run a half marathon');
    expect(body().field('Review Every').value).toBe('P1W');
    expect(body().field('How It’s Checked').children.map((o) => o.textContent)).toEqual(['You Mark It', 'When Its Steps Are Done', 'When an Item Changes']);
    expect(body().field('Review Every').children.map((o) => o.textContent)).toEqual(['Day', '3 Days', 'Week', '2 Weeks', 'Month']);
    // Fill it in as Will would.
    const type = (label: string, v: string, i = 0) => {
      const f = body().visible().filter((e) => e.getAttribute('aria-label') === label)[i]!;
      f.value = v;
      (f.oninput ?? f.onchange)!();
    };
    type('Goal', '  Synthetic   half marathon ');
    type('Why It Matters', 'Synthetic reason');
    type('Done When', 'Synthetic I finish it');
    body().button('Add Another').onclick!();
    const how = body().visible().filter((e) => e.getAttribute('aria-label') === 'How It’s Checked')[1]!;
    how.value = 'item';
    how.onchange!();
    await settle();
    // The item search is a POST; the picker shows the title marked as outside text, inert.
    expect(calls.at(-1)).toEqual({ url: '/goals/linkable', method: 'POST', body: { q: '' } });
    expect(body().field('Choose an Item').placeholder).toBe('Find a pull request, issue, service or deploy');
    type('Choose an Item', '#57');
    await settle();
    expect(calls.at(-1)).toEqual({ url: '/goals/linkable', method: 'POST', body: { q: '#57' } });
    expect(body().shown()).toContain('wpf002/flint #57Outside words <b>Outside Text');
    body().visible().find((e) => e.className === 'row two click')!.onclick!();
    expect(body().field('Condition').children.map((o) => o.textContent)).toEqual(['Is Merged', 'Is Closed']);
    body().button('Add Another').onclick!();
    const how3 = body().visible().filter((e) => e.getAttribute('aria-label') === 'How It’s Checked')[2]!;
    how3.value = 'steps';
    how3.onchange!();
    type('Done When', 'Synthetic steps done', 2);
    const finish = day(later(30));
    type('Finish By', finish);
    type('Review Every', 'P2W');
    type('Step', 'Synthetic first step');
    body().button('Add Step').onclick!();
    type('Step', 'Synthetic second step', 1);
    type('Due', day(later(5)), 1);
    calls = [];
    foot().button('Add Goal with Touch ID').onclick!();
    await settle();
    const posted = calls.find((c) => c.method === 'POST')!;
    expect(posted.url).toBe('/goals');
    const b = posted.body as { draftKey: string; args: Record<string, unknown> };
    expect(b.draftKey).toMatch(/^[0-9a-f]{24}$/);
    expect(b.args).toEqual({
      goalId: `go${b.draftKey}`, owner: 'will', origin: 'will', sensitivity: 'personal', tainted: false, nexusProjectId: null,
      title: 'Synthetic half marathon', description: 'Synthetic reason',
      successCriteria: [
        { id: 'c1', text: 'Synthetic I finish it', check: { kind: 'manual' } },
        // An item check left without words says what it checks, by the item's key-based label.
        { id: 'c2', text: 'wpf002/flint #57 is merged', check: { kind: 'item', entityId: 'enpr57', key: 'state', value: 'merged' } },
        { id: 'c3', text: 'Synthetic steps done', check: { kind: 'steps', keys: ['s1', 's2'] } },
      ],
      horizonAt: new Date(`${finish}T23:59:00`).toISOString(), reviewCadence: 'P2W',
      links: [{ entityId: 'enpr57', role: 'target', watchPaths: ['state'] }],
      plan: { ops: [
        { op: 'add', key: 's1', step: { ordinal: 100, title: 'Synthetic first step', kind: 'will_task', tier: 'approval', dueAt: null, dependsOn: [] } },
        { op: 'add', key: 's2', step: { ordinal: 200, title: 'Synthetic second step', kind: 'will_task', tier: 'approval', dueAt: new Date(`${day(later(5))}T17:00:00`).toISOString(), dependsOn: [] } },
      ] },
    });
    // Never a title in what is filed or signed.
    expect(JSON.stringify(b)).not.toContain('Outside words');
    // The shared contract reads it as it is: the digest Will signs is the filed card's.
    const parsed = NewGoalBody.parse(b);
    expect(digestOf(parsed.args)).toBe(digestOf(b.args));
    expect(signed).toEqual([['prnew', { fresh: true, reason: 'add this goal', args: b.args }]]);
    expect(body().shown()).toContain('Goal AddedYour goal is active.');
    expect(foot().buttons()).toEqual(['Done', 'Add Another']);
    expect(foot().button('Add Another').className).toBe('btn pri');
    // The same form filed again is the same card: a new form gets a new draft key.
    foot().button('Add Another').onclick!();
    expect(run('GOALS.form.draftKey')).not.toBe(b.draftKey);
  });

  it('a cancelled prompt leaves the card in Approvals, and says so', async () => {
    routes = (c) => (c.url === '/goals' && c.method === 'POST' ? { status: 200, body: { id: 'prnew', deduped: false } } : { status: 200, body: { tab: 'active', goals: [], waiting: [], reviews: 'off' } });
    signAnswer = async () => { throw new Error('not confirmed'); };
    await open();
    run(`goalNew();GOALS.form.title='Synthetic goal';GOALS.form.checks[0].text='Synthetic check';goalForm()`);
    foot().button('Add Goal with Touch ID').onclick!();
    await settle();
    expect(body().shown()).toContain('Cancelled. It’s waiting in Approvals.');
    expect(ids.goalsttl!.textContent).toBe('New Goal');
    // A refusal from the server is its sentence, and nothing was signed.
    signed = [];
    routes = () => ({ status: 409, body: { error: 'The goal changed since you looked. Reload it and try again.', code: 'looked' } });
    foot().button('Add Goal with Touch ID').onclick!();
    await settle();
    expect(body().shown()).toContain('The goal changed since you looked. Reload it and try again.');
    expect(signed).toEqual([]);
  });

  it('a device without an approval key is pointed to Settings', async () => {
    keyed = false;
    await open();
    run('goalNew()');
    expect(foot().shown()).toBe('This device needs an approval key.Open Settings');
    foot().button('Open Settings').onclick!();
    expect(panels.settings).toBe(true);
    expect(panels.goals).toBe(false);
  });

  it('Edit Goal keeps each check’s id; an unchanged goal changes nothing; a change is signed with a plain prompt', async () => {
    routes = (c) => (c.method === 'GET' ? { status: 200, body: { goal: view() } } : { status: 200, body: { id: 'predit', deduped: false } });
    run(`goalOpen('gotestgoal0001')`);
    await settle();
    foot().button('Edit Goal').onclick!();
    expect(ids.goalsttl!.textContent).toBe('Edit Goal');
    expect(body().visible().filter((e) => e.className === 'gsh').map((e) => e.textContent)).toEqual(['Goal', 'Done When']);
    foot().button('Save with Touch ID').onclick!();
    await settle();
    expect(body().shown()).toContain('It changes nothing.');
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
    run(`GOALS.form.title='Synthetic goal, sharper'`);
    foot().button('Save with Touch ID').onclick!();
    await settle();
    const posted = calls.find((c) => c.method === 'POST')!;
    expect(posted.url).toBe('/goals/gotestgoal0001/edit');
    const args = (posted.body as { args: Record<string, unknown> }).args;
    expect(args).toEqual({ goalId: 'gotestgoal0001', title: 'Synthetic goal, sharper', description: 'Synthetic reason', successCriteria: view().successCriteria, links: [{ entityId: 'enpr57', role: 'target', watchPaths: ['state'] }] });
    expect(signed[0]).toEqual(['predit', { fresh: true, reason: 'change what counts as done for this goal', args }]);
  });

  it('Change Timing keeps the same instant for the same date, and signs what changed', async () => {
    const g = view();
    routes = (c) => (c.method === 'GET' ? { status: 200, body: { goal: g } } : { status: 200, body: { id: 'prtime', deduped: false } });
    run(`goalOpen('gotestgoal0001')`);
    await settle();
    foot().button('Change Timing').onclick!();
    expect(body().field('Finish By').value).toBe('2026-12-01');
    foot().button('Change with Touch ID').onclick!();
    expect(body().shown()).toContain('It changes nothing.');
    const every = body().field('Review Every');
    every.value = 'P1M';
    foot().button('Change with Touch ID').onclick!();
    await settle();
    const args = { goalId: 'gotestgoal0001', goalTitle: 'Synthetic goal one', horizonAt: g.horizonAt, reviewCadence: 'P1M' };
    expect(calls.find((c) => c.method === 'POST')).toEqual({ url: '/goals/gotestgoal0001/timing', method: 'POST', body: { args } });
    expect(signed[0]).toEqual(['prtime', { fresh: true, reason: 'change this goal’s timing', args }]);
  });

  it('Add Step adds the next key after every step, signed as a plan change', async () => {
    routes = (c) => (c.method === 'GET' ? { status: 200, body: { goal: view() } } : { status: 200, body: { id: 'prplan', deduped: false } });
    run(`goalOpen('gotestgoal0001')`);
    await settle();
    body().button('Add Step').onclick!();
    body().field('Step').value = 'Synthetic third step';
    body().button('Add with Touch ID').onclick!();
    await settle();
    const args = { goalId: 'gotestgoal0001', goalTitle: 'Synthetic goal one', ops: [{ op: 'add', key: 's4', step: { ordinal: 400, title: 'Synthetic third step', kind: 'will_task', tier: 'approval', dueAt: null, dependsOn: [] } }] };
    expect(calls.find((c) => c.method === 'POST')).toEqual({ url: '/goals/gotestgoal0001/plan', method: 'POST', body: { args } });
    expect(signed[0]).toEqual(['prplan', { fresh: true, reason: 'add a step to this goal', args }]);
    expect(GOAL_CARD_BODIES.plan.parse({ args })).toEqual({ args });
  });

  it('the finished tab says when each goal ended, in a sentence', async () => {
    routes = (c) => (c.url.startsWith('/goals?tab=finished') ? { status: 200, body: { tab: 'finished', reviews: 'off', waiting: [], goals: [
      row({ status: 'done', endedAt: new Date(2026, 9, 30, 12).toISOString() }), row({ id: 'gotestgoal0002', status: 'abandoned', endedAt: new Date(2026, 9, 12, 12).toISOString() }),
      row({ id: 'gotestgoal0003', status: 'rejected', endedAt: new Date(2026, 9, 9, 12).toISOString() }),
    ] } } : { status: 200, body: { tab: 'active', goals: [], waiting: [], reviews: 'off' } });
    run(`goalList('finished')`);
    await settle();
    expect(lines(body())).toEqual(['Done Oct 30.', 'Abandoned Oct 12.', 'Dismissed Oct 9.']);
  });
});
