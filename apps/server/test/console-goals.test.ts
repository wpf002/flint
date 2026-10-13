/**
 * The console's Goals panel (apps/console/index.html, <script id="goals-js">),
 * run against a small fake DOM whose innerHTML setter throws: ES5 and text only;
 * the exact words (Title Case titles, buttons, tabs and labels; UPPERCASE section
 * headers through .gsh; every secondary line a complete sentence whose verb
 * agrees with its count); never "Late" while reviews are off; what the
 * panel has to say (an error, an outcome, "Flint is waiting for your approval.")
 * is in the footer, which never scrolls away; a refresh redraws a goal in place; the form refuses what cannot be filed, in
 * sentences; Add Goal posts /goals and then signs exactly the args it showed,
 * with a fresh touch and a prompt in plain words (the args are already what the
 * shared contract normalizes them to, so their digest is the one filed); a
 * change says what it changes from; a cancelled prompt leaves the card in
 * Approvals; a half-typed New Goal survives closing the panel; a form drawn
 * again keeps the cursor; an answer that lands after Will has gone elsewhere
 * neither throws nor pulls him back; pausing, marks and step ticks are unsigned;
 * the item search is a POST and the stored label is the item's own; and the
 * Goals button hides while the server answers 501.
 *
 * Reviews (part 3): with reviews on, a late review is said in the list (its
 * sentence, a Late tag, the header's dot); an open goal's third fact is Next
 * Review before its first review and On Track after; LATEST REVIEW says when,
 * what it found and what it would change (the trial week) or suggested, each a
 * sentence, with no parentheses, ids or JSON on screen; Review Now is unsigned
 * and says what happens next in the footer.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { webcrypto } from 'node:crypto';
import { GOAL_CARD_BODIES, NewGoalBody, digestOf, noteProblems } from '@flint/policy';

const html = readFileSync(join(__dirname, '..', '..', 'console', 'index.html'), 'utf8');
const goalsJs = /<script id="goals-js">([\s\S]*?)<\/script>/.exec(html)![1]!;
const apprJs = /<script id="approvals-js">([\s\S]*?)<\/script>/.exec(html)![1]!;
const mainJs = /<script>\n\/\* ---------- config ---------- \*\/([\s\S]*?)<\/script>/.exec(html)![1]!;
const canonJs = /\nfunction canonJson\(v\)\{[\s\S]*?\n(?=function shownDigest)/.exec(mainJs)![0];
const unsignable = /\nvar UNSIGNABLE=[^\n]*\n/.exec(mainJs)![0];
// The two tables the Goals panel shares with Approvals (one of each for both panels).
const shared = `${/\nvar APPR_CADENCES=[^\n]*\n/.exec(apprJs)![0]}${/\nvar APPR_PROMPTS=\{[\s\S]*?\};\n/.exec(apprJs)![0]}`;

/** The data-k of the control that has the cursor. */
let focused: string | null;

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
  scrollTop = 0;
  scrollHeight = 0;
  clientHeight = 0;
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
  focus() {
    focused = this.getAttribute('data-k') ?? this.getAttribute('aria-label') ?? this.tagName;
  }
  /** Only what the panel asks for: a control by its key. */
  querySelector(sel: string): El | null {
    const m = /^\[data-k="([^"]+)"\]$/.exec(sel);
    return m ? (this.all().find((e) => e.getAttribute('data-k') === m[1]) ?? null) : null;
  }
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
  field(label: string, i = 0): El {
    const f = this.visible().filter((e) => (e.tagName === 'input' || e.tagName === 'select' || e.tagName === 'textarea') && e.getAttribute('aria-label') === label)[i];
    if (!f) throw new Error(`no field "${label}" #${i}`);
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
const YEAR = new Date().getFullYear();
/** A date as the panel says it: the year only when it is not this one. */
const says = (d: Date) => d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getFullYear() === YEAR ? undefined : 'numeric' });

const row = (over: Record<string, unknown> = {}) => ({
  id: 'gotestgoal0001', title: 'Synthetic goal one', status: 'active', origin: 'will', checks: { met: 1, total: 3, unknown: 0 }, horizonAt: null, reviewCadence: 'P1W',
  endedAt: null, waiting: 0, late: false, tainted: false, ...over,
});
const FINISH = new Date(YEAR, 11, 1, 23, 59);
const DUE = new Date(YEAR, 9, 14, 17, 0);
const view = (over: Record<string, unknown> = {}) => ({
  id: 'gotestgoal0001', title: 'Synthetic goal one', description: 'Synthetic reason', status: 'active', owner: 'will', origin: 'will', sensitivity: 'personal', tainted: false, nexusProjectId: null,
  successCriteria: [
    { id: 'c1', text: 'Synthetic manual check', check: { kind: 'manual' } },
    { id: 'c2', text: 'Synthetic merged check', check: { kind: 'item', entityId: 'enpr57', key: 'state', value: 'merged' } },
    { id: 'c3', text: 'Synthetic steps check', check: { kind: 'steps', keys: ['s1', 's2'] } },
  ],
  criteria: [{ id: 'c1', state: 'met' }, { id: 'c2', state: 'unmet' }, { id: 'c3', state: 'unknown' }],
  checks: { met: 1, total: 3, unknown: 1 }, horizonAt: FINISH.toISOString(), reviewCadence: 'P1W', activatedAt: '2026-10-09T15:00:00.000Z', endedAt: null,
  links: [{ entityId: 'enpr57', role: 'target', watchPaths: ['state'], label: 'wpf002/flint #57', kind: 'pull_request', status: 'active', conditions: [{ key: 'state', value: 'merged' }, { key: 'state', value: 'closed' }] }],
  plan: { version: 1, steps: [
    { key: 's1', ordinal: 100, title: 'Synthetic step one', kind: 'will_task', tier: 'approval', status: 'todo', dueAt: DUE.toISOString(), dependsOn: [] },
    { key: 's2', ordinal: 200, title: 'Synthetic step two', kind: 'will_task', tier: 'approval', status: 'done', dueAt: null, dependsOn: [] },
    { key: 's3', ordinal: 300, title: 'Synthetic Flint step', kind: 'flint_action', tier: 'approval', status: 'todo', dueAt: null, dependsOn: [] },
  ] },
  waiting: [], reviews: 'off', late: false, ...over,
});
/** What a goal is, as a card's `from` says it. */
const definition = (g: ReturnType<typeof view>) => ({ title: g.title, description: g.description, successCriteria: g.successCriteria, links: g.links.map((l) => ({ entityId: l.entityId, role: l.role, watchPaths: l.watchPaths })) });
const ITEM = { entityId: 'enpr57', kind: 'pull_request', label: 'wpf002/flint #57', status: 'active', title: 'Outside words <b>', conditions: [{ key: 'state', value: 'merged' }, { key: 'state', value: 'closed' }] };

beforeEach(() => {
  calls = [];
  signed = [];
  keyed = true;
  panels = {};
  focused = null;
  signAnswer = async () => ({ action: { status: 'done' } });
  routes = (c) => {
    if (c.url.startsWith('/goals?tab=active')) return { status: 200, body: { tab: 'active', goals: [], waiting: [], reviews: 'off' } };
    if (c.url.startsWith('/goals?tab=')) return { status: 200, body: { tab: 'x', goals: [], waiting: [], reviews: 'off' } };
    return { status: 200, body: { ok: true } };
  };
  ids = Object.fromEntries(['goals', 'goalsbtn', 'goalsdot', 'goalsttl', 'goalback', 'goaladd', 'goalclear', 'goalbody', 'goalfoot'].map((id) => [id, new El('div', id)]));
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
    // The real showPanel opens and closes the overlay by its class.
    showPanel: (id: string, on: boolean) => {
      panels[id] = on;
      ids[id]?.classList.toggle('open', on);
    },
    loadCreds: () => {}, pollApprovals: () => {},
    openApprovals: () => void (panels.approvals = true), openSettings: () => void (panels.settings = true),
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
  runInContext(`${unsignable}${canonJs}${shared}`, ctx);
  runInContext(goalsJs, ctx);
});

const open = async () => {
  run('openGoals()');
  await settle();
};
/** Open one goal in the panel, as a click on its row does. */
const openGoal = async (g: ReturnType<typeof view> = view(), answer: (c: Call) => { status: number; body: unknown } = () => ({ status: 200, body: { id: 'prcard', deduped: false } })) => {
  routes = (c) => (c.method === 'GET' && c.url.startsWith('/goals/') ? { status: 200, body: { goal: g } } : c.method === 'GET' ? { status: 200, body: { tab: 'active', goals: [row()], waiting: [], reviews: 'off' } } : answer(c));
  await open();
  run(`goalOpen('${g.id}')`);
  await settle();
};
const body = () => ids.goalbody!;
const foot = () => ids.goalfoot!;
/** What the footer says (its message line), and how. */
const said = () => {
  const m = foot().visible().find((e) => e.id === 'goalmsg');
  return m ? [m.textContent, m.className] : null;
};
/** Every line under a title in the panel (a row's second line). */
const lines = (root: El) => root.visible().filter((e) => e.className === 'lbl' || e.className === 'lbl gwhy').flatMap((l) => l.children.filter((c) => c.tagName === 'span').map((c) => c.textContent));
const SMALL = new Set(['a', 'an', 'the', 'and', 'but', 'or', 'nor', 'for', 'so', 'yet', 'as', 'at', 'by', 'from', 'in', 'into', 'of', 'off', 'on', 'onto', 'out', 'over', 'to', 'up', 'with']);
const titleCase = (s: string) => s.split(' ').every((w, i, all) => !w || /^[^a-z]/.test(w) || (i > 0 && i < all.length - 1 && SMALL.has(w)));
/** A sentence starts with a capital (or a count) and ends with a stop... */
const sentence = (l: string) => /^[A-Z0-9].*[.!?]$/.test(l);
/** ...and is never one of the bare fragments a label would be: "A service.", "Done Oct 30.", "Paused." */
const FRAGMENT = /^(A|An) [a-zA-Z ]+\.$|^(Done|Abandoned|Dismissed|Paused)\b/;
const posted = () => calls.filter((c) => c.method === 'POST' && c.url !== '/goals/linkable');
const type = (label: string, v: string, i = 0) => {
  const f = body().field(label, i);
  f.value = v;
  (f.oninput ?? f.onchange)!();
};

describe('the Goals panel', () => {
  it('is ES5 and text only, with no dialog of its own', () => {
    const code = goalsJs.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(code).not.toMatch(/=>|`|\blet |\bconst |\bclass |\.\.\./);
    expect(code).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    expect(code).not.toMatch(/(^|[^.\w])(alert|confirm|prompt)\s*\(/m);
  });

  it('shares one cadence table and one prompt table with Approvals, and keeps no second copy', () => {
    expect(run('gCadences()')).toBe(run('APPR_CADENCES'));
    expect(run(`gPrompt('add')`)).toBe('add this goal');
    expect(goalsJs).not.toMatch(/'3 Days'|'2 Weeks'|add this goal|mark this goal done|GOAL_CADENCES|GOAL_PROMPTS|GOAL_CONDS/);
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

  it('the list: Will’s titles, one complete sentence each whose verb agrees with its count, badges, and never Late', async () => {
    routes = (c) => (c.url === '/goals?tab=active'
      ? { status: 200, body: { tab: 'active', reviews: 'off', waiting: [{ proposalId: 'pr9', goalId: 'gotestgoal0009', title: 'Synthetic waiting goal', checks: 1 }], goals: [
        row(), row({ id: 'gotestgoal0002', title: 'Synthetic paused', status: 'paused', origin: 'flint' }), row({ id: 'gotestgoal0003', title: 'Synthetic met', checks: { met: 2, total: 2, unknown: 0 }, waiting: 1, late: true }),
        row({ id: 'gotestgoal0004', title: 'Synthetic one check', checks: { met: 0, total: 1, unknown: 0 } }), row({ id: 'gotestgoal0005', title: 'Synthetic two met', checks: { met: 2, total: 3, unknown: 0 } }),
        row({ id: 'gotestgoal0006', title: 'Synthetic none met', checks: { met: 0, total: 3, unknown: 0 } }), row({ id: 'gotestgoal0007', title: 'Synthetic one of one', checks: { met: 1, total: 1, unknown: 0 } }),
      ] } }
      : { status: 200, body: { tab: 'suggested', goals: [row({ id: 'gotestgoal0008', status: 'proposed', origin: 'flint' })], waiting: [], reviews: 'off' } });
    await open();
    const shown = body().shown();
    expect(shown).toContain('Synthetic waiting goalIt starts once you approve it.Waiting for You');
    // "1 of 3 checks is met", "2 of 3 checks are met": the verb follows the count.
    expect(shown).toContain('Synthetic goal one1 of 3 checks is met.');
    expect(shown).toContain('Synthetic two met2 of 3 checks are met.');
    expect(shown).toContain('Synthetic none met0 of 3 checks are met.');
    expect(shown).toContain('Synthetic pausedIt’s paused, so Flint won’t review it until you resume it.PausedFrom Chat');
    expect(shown).toContain('Synthetic metAll of its checks are met.Waiting for You');
    expect(shown).toContain('Synthetic one checkIts check isn’t met yet.');
    expect(shown).toContain('Synthetic one of oneIts check is met.');
    // Nothing here contradicts "Flint checks this" on an open goal.
    expect(shown).toContain('Flint checks your goals when you open them. Scheduled reviews start soon.');
    expect(shown).not.toMatch(/reviews are off|isn’t checking/);
    // No lateness until reviews exist, whatever a row says.
    expect(shown).not.toMatch(/Late|late\./);
    expect(ids.goaladd!.hidden).toBe(false);
    // Suggested shows once Flint has suggested something.
    expect(body().buttons()).toContain('Suggested');
    for (const l of lines(body())) {
      expect(sentence(l), l).toBe(true);
      expect(l, l).not.toMatch(FRAGMENT);
    }
    // A waiting new goal opens Approvals.
    body().visible().find((e) => e.className.startsWith('row'))!.onclick!();
    expect(panels.approvals).toBe(true);
  });

  it('a step Flint carries out as a task is marked Flint Task, and is not Will’s to tick; no other kind of step is marked', async () => {
    const steps = view().plan.steps;
    const task = { key: 's4', ordinal: 400, title: 'Synthetic task step', kind: 'asset_task', tier: 'approval', status: 'todo', dueAt: null, dependsOn: [] };
    await openGoal(view({ plan: { version: 2, steps: [...steps, task, { ...task, key: 's5', title: 'Synthetic wait step', kind: 'wait' }, { ...task, key: 's6', title: 'Synthetic decision step', kind: 'decision' }] } }), () => ({ status: 200, body: { ok: true } }));
    const rowOf = (title: string) => body().visible().find((r) => r.className.split(' ').includes('row') && r.children.some((c) => c.children[0]?.textContent === title))!;
    const tagsOf = (title: string) => rowOf(title).children.filter((c) => c.className.split(' ').includes('tag')).map((c) => c.textContent);
    expect(tagsOf('Synthetic task step')).toEqual(['Flint Task']);
    expect(rowOf('Synthetic task step').buttons()).toEqual([]);
    for (const title of ['Synthetic step one', 'Synthetic step two', 'Synthetic Flint step', 'Synthetic wait step', 'Synthetic decision step']) expect(tagsOf(title), title).toEqual([]);
    expect(rowOf('Synthetic wait step').buttons()).toEqual(['Mark Done']);
    expect(titleCase('Flint Task')).toBe(true);
  });

  it('an open goal: facts, DONE WHEN and STEPS in words; Mark Met, step ticks and Pause are unsigned', async () => {
    await openGoal(view(), () => ({ status: 200, body: { ok: true } }));
    expect(ids.goalsttl!.textContent).toBe('Synthetic goal one');
    expect(ids.goalback!.hidden).toBe(false);
    const shown = body().shown();
    expect(shown).toContain('Checks1 of 3 Met');
    expect(shown).toContain(`Finish By${says(FINISH)}`);
    expect(shown).toContain('Review EveryWeek');
    // Section headers are .gsh, Title Case in the source (CSS makes them UPPERCASE).
    expect(body().visible().filter((e) => e.className === 'gsh').map((e) => e.textContent)).toEqual(['Why It Matters', 'Done When', 'Steps']);
    expect(shown).toContain('Synthetic manual checkYou mark this one.MetMark Not Met');
    expect(shown).toContain('Synthetic merged checkFlint checks this: wpf002/flint #57 is merged.Not Yet');
    expect(shown).toContain('Synthetic steps checkFlint checks this: 1 of 2 steps is done.Unknown');
    expect(shown).toContain(`Synthetic step oneIt’s due ${says(DUE)}.Mark Done`);
    expect(shown).toContain('Synthetic step twoIt’s done.Undo');
    // A Flint action is done by doing it: no button.
    expect(shown).toContain('Synthetic Flint stepIt has no due date.');
    expect(shown).not.toContain('Synthetic Flint stepIt has no due date.Mark Done');
    // One "Mark Done" kind of button per place: steps say Mark Done, the goal says Mark Goal Done.
    expect(foot().buttons()).toEqual(['Edit Goal', 'Change Timing', 'Pause', 'Abandon Goal', 'Mark Goal Done']);
    for (const b of [...body().buttons(), ...foot().buttons()]) expect(titleCase(b), b).toBe(true);
    for (const l of lines(body()).filter((l) => l !== 'Synthetic reason')) {
      expect(sentence(l), l).toBe(true);
      expect(l, l).not.toMatch(FRAGMENT);
    }
    expect(shown).not.toMatch(/Late/);

    body().button('Mark Not Met').onclick!();
    await settle();
    expect(posted()[0]).toEqual({ url: '/goals/gotestgoal0001/criteria/c1', method: 'POST', body: { met: false } });
    calls = [];
    body().button('Mark Done').onclick!();
    await settle();
    expect(posted()[0]).toEqual({ url: '/goals/gotestgoal0001/steps/s1', method: 'POST', body: { status: 'done' } });
    calls = [];
    foot().button('Pause').onclick!();
    await settle();
    expect(posted()[0]).toEqual({ url: '/goals/gotestgoal0001/pause', method: 'POST', body: {} });
    // The outcome is said in the footer, in a complete sentence.
    expect(said()).toEqual(['It’s paused, so Flint won’t review it until you resume it.', 'res ok']);
    expect(signed).toEqual([]);
  });

  it('dates say their year when it is not this one; a long title is shown in full; a steps check of one step reads right', async () => {
    const long = 'Synthetic goal with a title long enough that two header lines cannot hold all of it on a phone';
    await openGoal(view({
      title: long, horizonAt: new Date(YEAR + 1, 11, 1, 23, 59).toISOString(),
      successCriteria: [{ id: 'c1', text: 'Synthetic one step', check: { kind: 'steps', keys: ['s1'] } }, { id: 'c2', text: 'Synthetic done step', check: { kind: 'steps', keys: ['s2'] } }],
      criteria: [{ id: 'c1', state: 'unmet' }, { id: 'c2', state: 'met' }], checks: { met: 1, total: 2, unknown: 0 },
    }));
    expect(body().shown()).toContain(`Finish ByDec 1, ${YEAR + 1}`);
    expect(body().shown()).toContain('Synthetic one stepFlint checks this: its step isn’t done yet.');
    expect(body().shown()).toContain('Synthetic done stepFlint checks this: its step is done.');
    // The header keeps the title, two lines of it. Where that holds all of it (a desktop window), it is not said twice.
    expect(ids.goalsttl!.textContent).toBe(long);
    expect(body().visible().find((e) => e.className === 'gfull')).toBeUndefined();
    // Where the header cuts it short (a phone: its box is shorter than its words), the goal starts with all of it.
    Object.assign(ids.goalsttl!, { scrollHeight: 112, clientHeight: 56 });
    run(`goalShow(GOALS.goal)`);
    expect(body().children[0]).toMatchObject({ className: 'gfull', textContent: long });
    // A short title never needs a second copy.
    Object.assign(ids.goalsttl!, { scrollHeight: 28, clientHeight: 28 });
    await openGoal(view());
    expect(body().visible().find((e) => e.className === 'gfull')).toBeUndefined();
  });

  it('Abandon asks in place, then files the card and signs exactly its args with a fresh touch and a plain prompt', async () => {
    await openGoal();
    foot().button('Abandon Goal').onclick!();
    expect(foot().shown()).toBe('Abandon This GoalFlint stops reviewing it, and it can’t be restarted.CancelAbandon with Touch ID');
    foot().button('Abandon with Touch ID').onclick!();
    await settle();
    const args = { goalId: 'gotestgoal0001', goalTitle: 'Synthetic goal one' };
    expect(posted()[0]).toEqual({ url: '/goals/gotestgoal0001/abandon', method: 'POST', body: { args } });
    expect(signed).toEqual([['prcard', { fresh: true, reason: 'abandon this goal', args }]]);
    expect(GOAL_CARD_BODIES.abandon.parse({ args })).toEqual({ args });
    expect(said()).toEqual(['You abandoned this goal.', 'res ok']);
  });

  it('Mark Goal Done says how many checks are not met before it signs', async () => {
    await openGoal();
    foot().button('Mark Goal Done').onclick!();
    expect(foot().shown()).toBe('Mark This Goal Done2 of its checks aren’t met yet.CancelMark Goal Done with Touch ID');
    foot().button('Cancel').onclick!();
    expect(foot().buttons()).toContain('Abandon Goal');
    foot().button('Mark Goal Done').onclick!();
    foot().button('Mark Goal Done with Touch ID').onclick!();
    await settle();
    expect(signed[0]).toEqual(['prcard', { fresh: true, reason: 'mark this goal done', args: { goalId: 'gotestgoal0001', goalTitle: 'Synthetic goal one' } }]);
    // One check left, and none.
    await openGoal(view({ checks: { met: 2, total: 3, unknown: 0 } }));
    foot().button('Mark Goal Done').onclick!();
    expect(foot().shown()).toContain('1 of its checks isn’t met yet.');
    await openGoal(view({ checks: { met: 3, total: 3, unknown: 0 } }));
    foot().button('Mark Goal Done').onclick!();
    expect(foot().shown()).toContain('All of its checks are met.');
  });

  it('while the prompt is up the buttons are off and the footer says it is waiting; a refusal or a cancel is said there too', async () => {
    let release!: (v: unknown) => void;
    signAnswer = () => new Promise((r) => (release = r));
    await openGoal();
    foot().button('Abandon Goal').onclick!();
    const go = foot().button('Abandon with Touch ID');
    const cancel = foot().button('Cancel');
    go.onclick!();
    await settle();
    expect(said()).toEqual(['Flint is waiting for your approval.', 'res wait']);
    expect([go.disabled, cancel.disabled]).toEqual([true, true]);
    // A second click while it waits files nothing more.
    go.onclick!();
    await settle();
    expect(posted()).toHaveLength(1);
    release({ action: { status: 'error', error: 'This goal was abandoned.' } });
    await settle();
    expect(said()).toEqual(['This goal was abandoned.', 'res bad']);
    expect([go.disabled, cancel.disabled]).toEqual([false, false]);
    signAnswer = async () => { throw new Error('not confirmed'); };
    go.onclick!();
    await settle();
    expect(said()).toEqual(['Cancelled. It’s waiting in Approvals.', 'res bad']);
    // The message is in the footer, never in the scrolling body.
    expect(body().shown()).not.toMatch(/Cancelled|waiting for your approval/);
  });

  it('a paused goal resumes with a signature of exactly what it is, and no plan', async () => {
    await openGoal(view({ status: 'paused' }));
    expect(foot().buttons()).toEqual(['Edit Goal', 'Change Timing', 'Abandon Goal', 'Resume with Touch ID']);
    foot().button('Resume with Touch ID').onclick!();
    await settle();
    expect(posted()[0]!.url).toBe('/goals/gotestgoal0001/resume');
    const args = (posted()[0]!.body as { args: Record<string, unknown> }).args;
    expect(signed[0]).toEqual(['prcard', { fresh: true, reason: 'resume this goal', args }]);
    // What it signs is already in the contract's normal form: its digest is the filed card's.
    const parsed = GOAL_CARD_BODIES.resume.parse({ args }) as { args: unknown };
    expect(digestOf(parsed.args)).toBe(digestOf(args));
    expect(args).toMatchObject({ owner: 'will', origin: 'will', sensitivity: 'personal', tainted: false, nexusProjectId: null, plan: null, links: [{ entityId: 'enpr57', role: 'target', watchPaths: ['state'] }] });
    expect(said()).toEqual(['Your goal is active again.', 'res ok']);
  });

  it('Add Goal refuses what cannot be filed, each in a sentence in the footer, with the cursor on the field it is about', async () => {
    await open();
    run('goalNew()');
    const add = () => foot().button('Add Goal with Touch ID').onclick!();
    add();
    expect(said()).toEqual(['Give the goal a name.', 'res bad']);
    expect(focused).toBe('name');
    // In the footer, which never scrolls away; not at the bottom of the long form.
    expect(body().shown()).not.toContain('Give the goal a name.');
    run(`GOALS.form.title='Synthetic goal'`);
    add();
    expect(said()![0]).toBe('Add at least one way to know it’s done.');
    expect(focused).toBe('check:0:text');
    run(`GOALS.form.checks[0].method='item';goalForm()`);
    run(`GOALS.form.checks[0].text='Synthetic check'`);
    add();
    expect(said()![0]).toBe('Choose an item for this check.');
    expect(focused).toBe('check:0:find');
    run(`GOALS.form.checks[0].method='steps';GOALS.form.steps=[{title:'',due:''}];goalForm()`);
    add();
    expect(said()![0]).toBe('Add a first step for this check.');
    expect(focused).toBe('step:0:title');
    run(`GOALS.form.checks[0].method='manual';GOALS.form.finishBy='${day(new Date())}';goalForm()`);
    add();
    expect(said()![0]).toBe('Pick a date after today.');
    expect(focused).toBe('finish');
    expect(posted()).toEqual([]);
    expect(signed).toEqual([]);
  });

  it('Add Goal posts /goals, then signs exactly the args it showed, fresh, with a plain prompt; the result is in words', async () => {
    routes = (c) => (c.url === '/goals' && c.method === 'POST' ? { status: 200, body: { id: 'prnew', deduped: false } }
      : c.url === '/goals/linkable' ? { status: 200, body: { items: [ITEM, { ...ITEM, entityId: 'enpr41', label: 'wpf002/flint #41', status: 'archived', title: null }, { entityId: 'ensvc', kind: 'service', label: 'com.flint.runtime', status: 'active', title: null, conditions: [{ key: 'health', value: 'ok' }] }] } }
        : { status: 200, body: { tab: 'active', goals: [], waiting: [], reviews: 'off' } });
    await open();
    run('goalNew()');
    expect(body().visible().filter((e) => e.className === 'gsh').map((e) => e.textContent)).toEqual(['Goal', 'Done When', 'Timing', 'First Steps']);
    // No field repeats its section's header: GOAL then Name, DONE WHEN then Check.
    const labels = body().visible().filter((e) => e.getAttribute('aria-label') && e.tagName !== 'button').map((e) => e.getAttribute('aria-label'));
    expect(labels).toEqual(['Name', 'Why It Matters', 'Check', 'How It’s Checked', 'Finish By', 'Review Every', 'Step', 'Due']);
    for (const l of labels) expect(titleCase(l!), l!).toBe(true);
    expect(body().field('Name').placeholder).toBe('Run a half marathon');
    expect(body().field('Review Every').value).toBe('P1W');
    expect(body().field('How It’s Checked').children.map((o) => o.textContent)).toEqual(['You Mark It', 'When Its Steps Are Done', 'When an Item Changes']);
    expect(body().field('Review Every').children.map((o) => o.textContent)).toEqual(['Day', '3 Days', 'Week', '2 Weeks', 'Month']);
    // Fill it in as Will would.
    type('Name', '  Synthetic   half marathon ');
    type('Why It Matters', 'Synthetic reason');
    type('Check', 'Synthetic I finish it');
    body().button('Add Check').onclick!();
    const how = body().field('How It’s Checked', 1);
    how.value = 'item';
    how.onchange!();
    await settle();
    // The item search is a POST; the picker shows the title marked as outside text, inert, and what each item is in a sentence.
    expect(calls.at(-1)).toEqual({ url: '/goals/linkable', method: 'POST', body: { q: '' } });
    expect(body().field('Choose an Item').placeholder).toBe('Find an item');
    type('Choose an Item', '#57');
    await settle();
    expect(calls.at(-1)).toEqual({ url: '/goals/linkable', method: 'POST', body: { q: '#57' } });
    expect(body().shown()).toContain('wpf002/flint #57Outside words <b>Outside Text');
    expect(body().shown()).toContain('wpf002/flint #41It’s a pull request.Finished');
    expect(body().shown()).toContain('com.flint.runtimeIt’s a service.');
    // "Finished" is a small tag, like its neighbours, not a row value.
    expect(body().visible().find((e) => e.textContent === 'Finished')!.className).toBe('tag');
    body().visible().find((e) => e.className === 'row two click')!.onclick!();
    // The conditions offered are the ones the item came with.
    expect(body().field('Condition').children.map((o) => o.textContent)).toEqual(['Is Merged', 'Is Closed']);
    body().button('Add Check').onclick!();
    const how3 = body().field('How It’s Checked', 2);
    how3.value = 'steps';
    how3.onchange!();
    type('Check', 'Synthetic steps done', 2);
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
    expect(posted()[0]!.url).toBe('/goals');
    const b = posted()[0]!.body as { draftKey: string; args: Record<string, unknown> };
    expect(b.draftKey).toMatch(/^[0-9a-f]{24}$/);
    expect(b.args).toEqual({
      goalId: `go${b.draftKey}`, owner: 'will', origin: 'will', sensitivity: 'personal', tainted: false, nexusProjectId: null,
      title: 'Synthetic half marathon', description: 'Synthetic reason',
      successCriteria: [
        { id: 'c1', text: 'Synthetic I finish it', check: { kind: 'manual' } },
        // An item check left without words says what it checks, by the item's own label.
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
    // Done is the likelier next step, so it is the gold one; Add Another is beside it.
    expect(foot().buttons()).toEqual(['Add Another', 'Done']);
    expect(foot().button('Done').className).toBe('btn pri');
    expect(foot().button('Add Another').className).toBe('btn');
    // A new form gets a new draft key (the same form filed again would be the same card).
    foot().button('Add Another').onclick!();
    expect(run('GOALS.form.draftKey')).not.toBe(b.draftKey);
    expect(body().field('Name').value).toBe('');
  });

  it('a cancelled prompt leaves the card in Approvals, and says so in the footer', async () => {
    routes = (c) => (c.url === '/goals' && c.method === 'POST' ? { status: 200, body: { id: 'prnew', deduped: false } } : { status: 200, body: { tab: 'active', goals: [], waiting: [], reviews: 'off' } });
    signAnswer = async () => { throw new Error('not confirmed'); };
    await open();
    run(`goalNew();GOALS.form.title='Synthetic goal';GOALS.form.checks[0].text='Synthetic check';goalForm()`);
    foot().button('Add Goal with Touch ID').onclick!();
    await settle();
    expect(said()).toEqual(['Cancelled. It’s waiting in Approvals.', 'res bad']);
    expect(body().shown()).not.toContain('Cancelled');
    expect(ids.goalsttl!.textContent).toBe('New Goal');
    // A refusal from the server is its sentence, and nothing was signed.
    signed = [];
    routes = () => ({ status: 409, body: { error: 'The goal changed since you looked. Reload it and try again.', code: 'looked' } });
    foot().button('Add Goal with Touch ID').onclick!();
    await settle();
    expect(said()![0]).toBe('The goal changed since you looked. Reload it and try again.');
    expect(signed).toEqual([]);
  });

  it('a half-typed New Goal survives Escape, a click outside and Back; Clear starts over', async () => {
    await open();
    run('goalNew()');
    type('Name', 'Synthetic half typed');
    type('Check', 'Synthetic check words');
    body().button('Add Step').onclick!();
    type('Step', 'Synthetic second step', 1);
    const key = run('GOALS.form.draftKey');
    // Escape and a click on the backdrop both close the panel.
    run('closeGoals()');
    await open();
    expect(ids.goalsttl!.textContent).toBe('Goals');
    ids.goaladd!.hidden = false;
    run('goalNew()');
    expect(body().field('Name').value).toBe('Synthetic half typed');
    expect(body().field('Check').value).toBe('Synthetic check words');
    expect(body().field('Step', 1).value).toBe('Synthetic second step');
    expect(run('GOALS.form.draftKey')).toBe(key);
    // Back, then Cancel: the same.
    run('goalBack()');
    await settle();
    run('goalNew()');
    foot().button('Cancel').onclick!();
    await settle();
    run('goalNew()');
    expect(body().field('Name').value).toBe('Synthetic half typed');
    // Clear is a quiet button in the header (never alone on a row of the footer), there only for a New Goal.
    expect(ids.goalclear!.hidden).toBe(false);
    expect(html).toContain('<button class="ghost" id="goalclear" onclick="goalClearAsk()" hidden>Clear</button>');
    expect(foot().buttons()).toEqual(['Cancel', 'Add Goal with Touch ID']);
    // It asks in place before it wipes what he typed: there is no undo.
    run('goalClearAsk()');
    expect(foot().shown()).toBe('Clear This Goal?What you typed here is removed.CancelClear');
    expect(body().field('Name').value).toBe('Synthetic half typed');
    foot().button('Cancel').onclick!();
    expect(foot().buttons()).toEqual(['Cancel', 'Add Goal with Touch ID']);
    expect(run('GOALS.form.draftKey')).toBe(key);
    run('goalClearAsk()');
    foot().button('Clear').onclick!();
    expect(body().field('Name').value).toBe('');
    expect(body().visible().filter((e) => e.getAttribute('aria-label') === 'Step')).toHaveLength(1);
    expect(run('GOALS.form.draftKey')).not.toBe(key);
    expect(focused).toBe('name');
    expect(foot().buttons()).toEqual(['Cancel', 'Add Goal with Touch ID']);
    // An untouched form has nothing to ask about.
    const blank = run('GOALS.form.draftKey');
    run('goalClearAsk()');
    expect(foot().shown()).not.toContain('Clear This Goal?');
    expect(run('GOALS.form.draftKey')).not.toBe(blank);
    // Not on the list, an open goal, or Edit Goal.
    run(`goalList('active')`);
    await settle();
    expect(ids.goalclear!.hidden).toBe(true);
  });

  it('a draft is spent once its goal exists: approved in Approvals after a cancelled prompt, or already in the list', async () => {
    routes = (c) => (c.url === '/goals' && c.method === 'POST' ? { status: 200, body: { id: 'prnew', deduped: false } } : { status: 200, body: { tab: 'active', goals: [], waiting: [], reviews: 'off' } });
    signAnswer = async () => { throw new Error('not confirmed'); };
    const cancelled = async () => {
      await open();
      run(`goalNew();GOALS.form.title='Synthetic goal';GOALS.form.checks[0].text='Synthetic check';goalForm()`);
      foot().button('Add Goal with Touch ID').onclick!();
      await settle();
      expect(said()![0]).toBe('Cancelled. It’s waiting in Approvals.');
      return run('GOALS.draft.draftKey') as string;
    };
    // The card waits in Approvals, and the draft is still his to change.
    let key = await cancelled();
    run('closeGoals()');
    run('goalNew()');
    expect(body().field('Name').value).toBe('Synthetic goal');
    // Approved there (Approvals tells the panel): New Goal starts a new one, never the form of a goal he now has.
    run(`goalsApproved({id:'prnew',fullName:'goal.activate',args:{goalId:'go${key}'}})`);
    expect(run('GOALS.draft')).toBeNull();
    run('goalNew()');
    expect(body().field('Name').value).toBe('');
    // Another card's approval leaves a draft alone.
    key = await cancelled();
    run(`goalsApproved({id:'prother',fullName:'goal.activate',args:{goalId:'goSomeOtherGoal0001'}})`);
    expect(run('GOALS.draft.draftKey')).toBe(key);
    // The poll that feeds the header's dot sees it approved (signed on another device).
    run(`goalsDot([{id:'prnew',status:'approved',fullName:'goal.activate',args:{goalId:'go${key}'}}])`);
    expect(run('GOALS.draft')).toBeNull();
    // Or the goal is simply in the list by now.
    key = await cancelled();
    routes = () => ({ status: 200, body: { tab: 'active', goals: [row({ id: `go${key}` })], waiting: [], reviews: 'off' } });
    run(`goalList('active')`);
    await settle();
    expect(run('GOALS.draft')).toBeNull();
  });

  it('a date not set says No Date, never today’s date as if it were chosen', async () => {
    await open();
    run('goalNew()');
    const finish = body().field('Finish By');
    const due = body().field('Due');
    // Empty: marked, and the page shows "No Date" over the browser's own hint until the field has the cursor.
    expect([finish.classList.contains('gempty'), due.classList.contains('gempty')]).toEqual([true, true]);
    expect(html).toContain('.field.gempty:not(:focus)::-webkit-datetime-edit{opacity:0;}');
    expect(html).toContain('.fl:has(>.field.gempty:not(:focus))::after{content:"No Date";');
    // With a value it is the value.
    run(`GOALS.form.finishBy='${day(later(30))}';goalForm()`);
    expect(body().field('Finish By').classList.contains('gempty')).toBe(false);
    expect(body().field('Due').classList.contains('gempty')).toBe(true);
  });

  it('a form drawn again keeps what was typed, where it was scrolled, and the cursor where the next keystroke belongs', async () => {
    routes = (c) => (c.url === '/goals/linkable' ? { status: 200, body: { items: [ITEM] } } : { status: 200, body: { tab: 'active', goals: [], waiting: [], reviews: 'off' } });
    await open();
    run('goalNew()');
    type('Name', 'Synthetic typed name');
    type('Check', 'Synthetic first check');
    body().scrollTop = 240;
    body().button('Add Check').onclick!();
    expect(focused).toBe('check:1:text');
    expect(body().scrollTop).toBe(240);
    expect(body().field('Name').value).toBe('Synthetic typed name');
    expect(body().field('Check').value).toBe('Synthetic first check');
    const how = body().field('How It’s Checked', 1);
    how.value = 'item';
    how.onchange!();
    await settle();
    expect(focused).toBe('check:1:how');
    // What was typed into the search stays through another redraw.
    type('Choose an Item', 'flint');
    await settle();
    body().button('Add Step').onclick!();
    await settle();
    expect(focused).toBe('step:1:title');
    expect(body().field('Choose an Item').value).toBe('flint');
    body().visible().find((e) => e.className === 'row two click')!.onclick!();
    expect(focused).toBe('check:1:cond');
    body().button('Change').onclick!();
    await settle();
    expect(focused).toBe('check:1:find');
    // Removing a check or a step leaves the cursor on the button that adds one.
    body().visible().filter((e) => e.getAttribute('aria-label') === 'Remove Check')[1]!.onclick!();
    expect(focused).toBe('addcheck');
    body().visible().filter((e) => e.getAttribute('aria-label') === 'Remove Step')[1]!.onclick!();
    expect(focused).toBe('addstep');
    expect(body().field('Check').value).toBe('Synthetic first check');
  });

  it('an answer that lands after Will has gone elsewhere neither throws nor pulls him back', async () => {
    // A goal added after he closed the form: the draft is spent, and he stays where he is.
    let release!: (v: unknown) => void;
    signAnswer = () => new Promise((r) => (release = r));
    routes = (c) => (c.url === '/goals' && c.method === 'POST' ? { status: 200, body: { id: 'prnew', deduped: false } } : c.url.startsWith('/goals/') && c.method === 'GET' ? { status: 200, body: { goal: view() } } : { status: 200, body: { tab: 'active', goals: [row()], waiting: [], reviews: 'off' } });
    await open();
    run(`goalNew();GOALS.form.title='Synthetic goal';GOALS.form.checks[0].text='Synthetic check';goalForm()`);
    foot().button('Add Goal with Touch ID').onclick!();
    await settle();
    run(`goalList('active')`);
    await settle();
    calls = [];
    release({ action: { status: 'done' } });
    await settle();
    expect(ids.goalsttl!.textContent).toBe('Goals');
    expect(run('GOALS.draft')).toBeNull();
    // The list he is looking at is read again, so the new goal is in it.
    expect(calls.some((c) => c.url === '/goals?tab=active')).toBe(true);
    // The same, with the panel closed: nothing is drawn or fetched.
    run(`goalNew();GOALS.form.title='Synthetic goal';GOALS.form.checks[0].text='Synthetic check';goalForm()`);
    foot().button('Add Goal with Touch ID').onclick!();
    await settle();
    run('closeGoals()');
    calls = [];
    release({ action: { status: 'done' } });
    await settle();
    expect(calls).toEqual([]);
    expect(run('GOALS.draft')).toBeNull();
    // A failure that lands late says nothing where he now is.
    await open();
    run(`goalNew();GOALS.form.title='Synthetic goal';GOALS.form.checks[0].text='Synthetic check';goalForm()`);
    foot().button('Add Goal with Touch ID').onclick!();
    await settle();
    run(`goalList('active')`);
    await settle();
    release({ action: { status: 'error', error: 'It failed.' } });
    await settle();
    expect(said()).toBeNull();

    // A mark whose answer is slow: he has gone back to the list, and stays there.
    let answerMark!: () => void;
    const slow = new Promise<void>((r) => (answerMark = r));
    const realFetch = ctx.fetch as (u: string, i?: Record<string, unknown>) => Promise<unknown>;
    ctx.fetch = async (u: string, i?: Record<string, unknown>) => {
      if (/\/criteria\//.test(u)) await slow;
      return realFetch(u, i);
    };
    run(`goalOpen('gotestgoal0001')`);
    await settle();
    body().button('Mark Not Met').onclick!();
    run(`goalList('active')`);
    await settle();
    calls = [];
    answerMark();
    await settle();
    expect(ids.goalsttl!.textContent).toBe('Goals');
    expect(run('GOALS.view')).toBe('list');
    expect(calls.filter((c) => c.method === 'GET' && c.url.startsWith('/goals/'))).toEqual([]);
    // The list he is on is read again, so its counts are not stale.
    expect(calls.some((c) => c.url === '/goals?tab=active')).toBe(true);
  });

  it('a signature that lands after Will has gone elsewhere redraws what he is looking at: the list, or another goal, in place', async () => {
    let release!: (v: unknown) => void;
    signAnswer = () => new Promise((r) => (release = r));
    const other = view({ id: 'gotestgoal0002', title: 'Synthetic other goal' });
    routes = (c) => (c.method === 'GET' && c.url === '/goals/gotestgoal0002' ? { status: 200, body: { goal: other } } : c.method === 'GET' && c.url.startsWith('/goals/') ? { status: 200, body: { goal: view() } }
      : c.method === 'GET' ? { status: 200, body: { tab: 'active', goals: [row()], waiting: [], reviews: 'off' } } : { status: 200, body: { id: 'prcard', deduped: false } });
    await open();
    run(`goalOpen('gotestgoal0001')`);
    await settle();
    // Mark Goal Done is signed while he goes back to the list: the list is read again when it lands.
    foot().button('Mark Goal Done').onclick!();
    foot().button('Mark Goal Done with Touch ID').onclick!();
    await settle();
    run(`goalList('active')`);
    await settle();
    calls = [];
    release({ action: { status: 'done' } });
    await settle();
    expect(run('GOALS.view')).toBe('list');
    expect(calls.map((c) => c.url)).toContain('/goals?tab=active');
    // The same while he has opened another goal: that goal is redrawn in place, and he is not pulled back to the first.
    run(`goalOpen('gotestgoal0001')`);
    await settle();
    foot().button('Abandon Goal').onclick!();
    foot().button('Abandon with Touch ID').onclick!();
    await settle();
    run(`goalOpen('gotestgoal0002')`);
    await settle();
    body().scrollTop = 180;
    calls = [];
    release({ action: { status: 'done' } });
    await settle();
    expect(ids.goalsttl!.textContent).toBe('Synthetic other goal');
    expect(calls.map((c) => c.url)).toEqual(['/goals/gotestgoal0002']);
    expect(body().scrollTop).toBe(180);
    // A form is left alone: nothing is fetched or redrawn under what he is typing.
    run(`goalOpen('gotestgoal0001')`);
    await settle();
    foot().button('Abandon Goal').onclick!();
    foot().button('Abandon with Touch ID').onclick!();
    await settle();
    run('goalNew()');
    type('Name', 'Synthetic typing');
    calls = [];
    release({ action: { status: 'done' } });
    await settle();
    expect(calls).toEqual([]);
    expect(body().field('Name').value).toBe('Synthetic typing');
  });

  it('a mark or a tick redraws the goal where it was scrolled to, with no Loading in between', async () => {
    let answerGet: (() => void) | null = null;
    await openGoal(view(), () => ({ status: 200, body: { ok: true } }));
    const realFetch = ctx.fetch as (u: string, i?: Record<string, unknown>) => Promise<unknown>;
    let slowGets = false;
    ctx.fetch = async (u: string, i?: Record<string, unknown>) => {
      if (slowGets && (!i || !i.method) && /^\/goals\/go/.test(u)) await new Promise<void>((r) => (answerGet = r));
      return realFetch(u, i);
    };
    slowGets = true;
    body().scrollTop = 320;
    body().button('Mark Done').onclick!();
    await settle();
    // The tick has landed and the goal is being read again: what he sees is still the goal, where he was.
    expect(answerGet).toBeTruthy();
    expect(body().shown()).not.toContain('Loading…');
    expect(body().shown()).toContain('Synthetic step one');
    expect(ids.goalsttl!.textContent).toBe('Synthetic goal one');
    answerGet!();
    await settle();
    expect(body().scrollTop).toBe(320);
    expect(body().shown()).toContain('Synthetic step one');
    // Opening a goal afresh starts at its top.
    slowGets = false;
    run(`goalOpen('gotestgoal0001')`);
    await settle();
    expect(body().scrollTop).toBe(0);
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

  it('Edit Goal keeps each check’s id and says what it changes from; an unchanged goal changes nothing', async () => {
    const g = view();
    await openGoal(g);
    foot().button('Edit Goal').onclick!();
    expect(ids.goalsttl!.textContent).toBe('Edit Goal');
    expect(body().visible().filter((e) => e.className === 'gsh').map((e) => e.textContent)).toEqual(['Goal', 'Done When']);
    expect(foot().buttons()).toEqual(['Cancel', 'Save with Touch ID']);
    // An item check already has its item, and offers that item's conditions.
    expect(body().field('Condition').children.map((o) => o.textContent)).toEqual(['Is Merged', 'Is Closed']);
    foot().button('Save with Touch ID').onclick!();
    await settle();
    expect(said()).toEqual(['It changes nothing.', 'res bad']);
    expect(posted()).toEqual([]);
    type('Name', 'Synthetic goal, sharper');
    foot().button('Save with Touch ID').onclick!();
    await settle();
    expect(posted()[0]!.url).toBe('/goals/gotestgoal0001/edit');
    const args = (posted()[0]!.body as { args: Record<string, unknown> }).args;
    const links = [{ entityId: 'enpr57', role: 'target', watchPaths: ['state'] }];
    expect(args).toEqual({ goalId: 'gotestgoal0001', title: 'Synthetic goal, sharper', description: 'Synthetic reason', successCriteria: g.successCriteria, links, from: definition(g) });
    expect(signed[0]).toEqual(['prcard', { fresh: true, reason: 'change what counts as done for this goal', args }]);
    // Already in the contract's normal form, `from` included: the digest Will signs is the filed card's.
    expect(digestOf((GOAL_CARD_BODIES.edit.parse({ args }) as { args: unknown }).args)).toBe(digestOf(args));
    expect(said()).toEqual(['What counts as done changed.', 'res ok']);
  });

  it('Change Timing keeps the same instant for the same date, says what it changes from, and lets an overdue goal change only its cadence', async () => {
    const g = view();
    await openGoal(g);
    foot().button('Change Timing').onclick!();
    expect(body().field('Finish By').value).toBe(day(FINISH));
    foot().button('Change with Touch ID').onclick!();
    expect(said()).toEqual(['It changes nothing.', 'res bad']);
    body().field('Review Every').value = 'P1M';
    foot().button('Change with Touch ID').onclick!();
    await settle();
    const args = { goalId: 'gotestgoal0001', goalTitle: 'Synthetic goal one', horizonAt: g.horizonAt, reviewCadence: 'P1M', from: { horizonAt: g.horizonAt, reviewCadence: 'P1W' } };
    expect(posted()[0]).toEqual({ url: '/goals/gotestgoal0001/timing', method: 'POST', body: { args } });
    expect(signed[0]).toEqual(['prcard', { fresh: true, reason: 'change this goal’s timing', args }]);
    expect(digestOf((GOAL_CARD_BODIES.timing.parse({ args }) as { args: unknown }).args)).toBe(digestOf(args));
    expect(said()).toEqual(['Its timing changed.', 'res ok']);

    // Overdue: the date stays as it is while the cadence changes; only a new date has to be after today.
    const past = new Date(Date.now() - 3 * DAY);
    const overdue = view({ horizonAt: past.toISOString() });
    await openGoal(overdue);
    foot().button('Change Timing').onclick!();
    body().field('Review Every').value = 'P1D';
    calls = [];
    signed = [];
    foot().button('Change with Touch ID').onclick!();
    await settle();
    expect((posted()[0]!.body as { args: Record<string, unknown> }).args).toMatchObject({ horizonAt: overdue.horizonAt, reviewCadence: 'P1D' });
    await openGoal(overdue);
    foot().button('Change Timing').onclick!();
    body().field('Finish By').value = day(new Date(Date.now() - DAY));
    calls = [];
    foot().button('Change with Touch ID').onclick!();
    expect(said()![0]).toBe('Pick a date after today.');
    expect(posted()).toEqual([]);
  });

  it('Add Step adds the next key after every step, signed as a plan change; its errors are in the footer', async () => {
    await openGoal();
    body().button('Add Step').onclick!();
    body().button('Add with Touch ID').onclick!();
    expect(said()).toEqual(['Give the step a name.', 'res bad']);
    body().field('Step').value = 'Synthetic third step';
    body().button('Add with Touch ID').onclick!();
    await settle();
    const args = { goalId: 'gotestgoal0001', goalTitle: 'Synthetic goal one', ops: [{ op: 'add', key: 's4', step: { ordinal: 400, title: 'Synthetic third step', kind: 'will_task', tier: 'approval', dueAt: null, dependsOn: [] } }] };
    expect(posted()[0]).toEqual({ url: '/goals/gotestgoal0001/plan', method: 'POST', body: { args } });
    expect(signed[0]).toEqual(['prcard', { fresh: true, reason: 'add a step to this goal', args }]);
    expect(GOAL_CARD_BODIES.plan.parse({ args })).toEqual({ args });
    expect(said()).toEqual(['The step is added.', 'res ok']);
  });

  it('the finished tab says when each goal ended, in a complete sentence, with the year when it is not this one', async () => {
    routes = (c) => (c.url.startsWith('/goals?tab=finished') ? { status: 200, body: { tab: 'finished', reviews: 'off', waiting: [], goals: [
      row({ status: 'done', endedAt: new Date(YEAR, 9, 30, 12).toISOString() }), row({ id: 'gotestgoal0002', status: 'abandoned', endedAt: new Date(YEAR, 9, 12, 12).toISOString() }),
      row({ id: 'gotestgoal0003', status: 'rejected', endedAt: new Date(YEAR - 1, 9, 9, 12).toISOString() }),
    ] } } : { status: 200, body: { tab: 'active', goals: [], waiting: [], reviews: 'off' } });
    await open();
    run(`goalList('finished')`);
    await settle();
    expect(lines(body())).toEqual(['It was done on Oct 30.', 'It was abandoned on Oct 12.', `It was dismissed on Oct 9, ${YEAR - 1}.`]);
  });

  // ---- Reviews (P3 part 3) ------------------------------------------------------------------
  const at = (days: number, h: number, m: number) => {
    const d = new Date();
    d.setDate(d.getDate() + days);
    d.setHours(h, m, 0, 0);
    return d;
  };
  /** A weekday as the panel says it: spelled out. */
  const weekday = (d: Date) => d.toLocaleDateString([], { weekday: 'long' });
  const STEP_DUE = new Date(YEAR, 9, 16, 17, 0);
  const reviewed = (over: Record<string, unknown> = {}) => ({
    at: at(0, 9, 2).toISOString(), kind: 'scheduled', summary: '1 of 3 checks is met. 1 step is due this week.', shadow: true, planner: 'ok',
    changes: [
      { kind: 'due', title: 'Synthetic step one', dueAt: STEP_DUE.toISOString(), status: null, after: null, material: false },
      { kind: 'add', title: 'Check on wpf002/flint #57', dueAt: null, status: null, after: null, material: true },
    ],
    ...over,
  });
  /** An open goal while Flint reviews goals (the list behind it says reviews are on). */
  const openReviewed = async (over: Record<string, unknown> = {}, answer: (c: Call) => { status: number; body: unknown } = () => ({ status: 200, body: { ok: true } })) => {
    const g = view({ reviews: 'on', nextReviewAt: null, onTrack: null, review: null, ...over });
    routes = (c) => (c.method === 'GET' && c.url.startsWith('/goals/') ? { status: 200, body: { goal: g } } : c.method === 'GET' ? { status: 200, body: { tab: 'active', goals: [row()], waiting: [], reviews: 'on' } } : answer(c));
    await open();
    run(`goalOpen('${g.id}')`);
    await settle();
    return g;
  };
  /** Timers that wait to be fired by the test (the fake DOM's own fire at once), with how long each was set for. */
  const heldTimers = () => {
    const queue: Array<{ fire: () => void; ms: number }> = [];
    const real = ctx.setTimeout;
    ctx.setTimeout = (f: () => void, ms: number) => (queue.push({ fire: f, ms }), 0);
    return { queue, restore: () => void (ctx.setTimeout = real), next: async () => { const t = queue.shift()!; t.fire(); await settle(); return t.ms; } };
  };
  const section = () => body().all().find((e) => e.id === 'goalreview')!;
  const reviewLines = () => lines(section());
  const headers = () => body().visible().filter((e) => e.className === 'gsh').map((e) => e.textContent);
  /** What Will's UI standard rules out on screen: parentheses, raw ids, JSON. */
  const plainWords = (text: string) => expect(text, text).not.toMatch(/[(){}[\]]|gotestgoal|enpr57|\bs\d\b|\bc\d\b|"kind"|null|undefined|NaN/);

  it('with reviews on, a late review is said in the list: its sentence and a Late tag; the header’s dot is for what needs Will, never for lateness alone', async () => {
    const goals = [row({ late: true }), row({ id: 'gotestgoal0002', title: 'Synthetic on time' }), row({ id: 'gotestgoal0003', title: 'Synthetic paused', status: 'paused', late: true })];
    routes = (c) => (c.url === '/goals?tab=active' ? { status: 200, body: { tab: 'active', reviews: 'on', waiting: [], goals } } : { status: 200, body: { tab: 'x', goals: [], waiting: [], reviews: 'on' } });
    run(`goalsDot([])`);
    expect(ids.goalsdot!.hidden).toBe(true);
    await open();
    const shown = body().shown();
    expect(shown).toContain('Synthetic goal oneIts review is late, and Flint runs it as soon as it can.Late');
    expect(shown).toContain('Synthetic on time1 of 3 checks is met.');
    // A paused goal is not reviewed, so it is never late.
    expect(shown).toContain('Synthetic pausedIt’s paused, so Flint won’t review it until you resume it.Paused');
    expect(shown.match(/Late/g)).toHaveLength(1);
    // Reviews are running: the line about scheduled reviews starting soon is gone.
    expect(shown).not.toContain('Scheduled reviews start soon');
    for (const l of lines(body())) {
      expect(sentence(l), l).toBe(true);
      expect(l, l).not.toMatch(FRAGMENT);
    }
    // The header's gold dot is for things that need Will. A late review is Flint's to run: it never lights the dot.
    expect(ids.goalsdot!.hidden).toBe(true);
    run(`goalsDot([])`);
    expect(ids.goalsdot!.hidden).toBe(true);
    run(`goalsDot([{status:'pending',fullName:'world.source.enable'}])`);
    expect(ids.goalsdot!.hidden).toBe(true);
    // A goal card waiting for him does, late review or not; and it goes out when the card is gone.
    run(`goalsDot([{status:'pending',fullName:'plan.change'}])`);
    expect(ids.goalsdot!.hidden).toBe(false);
    run(`goalsDot([{status:'approved',fullName:'plan.change'}])`);
    expect(ids.goalsdot!.hidden).toBe(true);
    // The same rows with reviews off: nothing is late.
    routes = () => ({ status: 200, body: { tab: 'active', reviews: 'off', waiting: [], goals } });
    run(`goalList('active')`);
    await settle();
    expect(body().shown()).not.toMatch(/Late|late\b/);
    expect(body().shown()).toContain('Flint checks your goals when you open them. Scheduled reviews start soon.');
    expect(ids.goalsdot!.hidden).toBe(true);
    run(`goalsDot([{status:'pending',fullName:'plan.change'}])`);
    expect(ids.goalsdot!.hidden).toBe(false);
    // The probe at load finds late goals and leaves the dot alone.
    routes = () => ({ status: 200, body: { tab: 'active', reviews: 'on', waiting: [], goals } });
    run(`goalsDot([]);goalsProbe()`);
    await settle();
    expect(ids.goalsdot!.hidden).toBe(true);
  });

  it('an open goal whose review is late says Late right under its title; never a paused one, and never while reviews are off', async () => {
    const tags = () => body().all().find((e) => e.id === 'goaltags');
    await openReviewed({ late: true, horizonAt: null, nextReviewAt: at(-1, 9, 0).toISOString() });
    expect(body().children[0]!.id).toBe('goaltop');
    expect(body().children[0]!.children[0]!.id).toBe('goaltags');
    expect(tags()!.shown()).toBe('Late');
    expect(tags()!.children[0]!.className).toBe('tag gtag');
    expect(titleCase('Late')).toBe(true);
    // Said once: the tag says Late, and the third fact says when the review was due (it said "Late" a second time).
    expect(body().shown().match(/Late(?!st)/g)).toHaveLength(1);
    expect(body().shown()).toContain('Finish ByNo DateReview DueYesterday at 9:00 AM');
    expect(body().shown()).not.toContain('Next Review');
    expect(titleCase('Review Due')).toBe(true);
    // With a finish date and a forecast for it, the third fact is On Track as ever, and Late is still said once.
    await openReviewed({ late: true, nextReviewAt: at(-1, 9, 0).toISOString(), onTrack: { likelihood: 'likely', percent: 70, by: FINISH.toISOString() }, review: reviewed({ at: at(-2, 9, 2).toISOString() }) });
    expect(body().shown().match(/Late(?!st)/g)).toHaveLength(1);
    expect(body().shown()).toContain('On TrackLikely · 70%');
    // On time, paused, or with reviews off: no tag at all.
    await openReviewed({ nextReviewAt: at(3, 9, 0).toISOString() });
    expect(tags()).toBeUndefined();
    await openReviewed({ status: 'paused', late: true });
    expect(tags()).toBeUndefined();
    await openGoal(view({ late: true, nextReviewAt: at(-1, 9, 0).toISOString() }));
    expect(tags()).toBeUndefined();
    expect(body().shown()).not.toMatch(/Late/);
  });

  it('an open goal before its first review: the third fact is Next Review, and Review Now is offered', async () => {
    const next = at(3, 9, 0);
    await openReviewed({ nextReviewAt: next.toISOString() });
    const shown = body().shown();
    expect(shown).toContain(`Next Review${weekday(next)} at 9:00 AM`);
    expect(shown).not.toContain('Review Every');
    expect(shown).not.toContain('On Track');
    // No review yet: LATEST REVIEW says so, and when the first one is; Review Now sits under it, as Add Step sits under the steps.
    expect(headers()).toEqual(['Why It Matters', 'Done When', 'Steps', 'Latest Review']);
    expect(reviewLines()).toEqual(['Flint hasn’t reviewed this goal yet.', `The next review is ${weekday(next)} at 9:00 AM.`]);
    expect(body().buttons()).toContain('Review Now');
    expect(body().button('Review Now').className).toBe('ghost');
    expect(titleCase('Review Now')).toBe(true);
    // The footer keeps its own buttons.
    expect(foot().buttons()).toEqual(['Edit Goal', 'Change Timing', 'Pause', 'Abandon Goal', 'Mark Goal Done']);
    // Tomorrow, further out, already here, and late: each in plain words.
    const fact = async (g: Record<string, unknown>) => {
      await openReviewed(g);
      return /Next Review(.*?)Why It Matters/.exec(body().shown())![1];
    };
    expect(await fact({ nextReviewAt: at(1, 9, 0).toISOString() })).toBe('Tomorrow at 9:00 AM');
    expect(await fact({ nextReviewAt: at(20, 9, 0).toISOString() })).toBe(`${says(at(20, 9, 0))} at 9:00 AM`);
    expect(await fact({ nextReviewAt: new Date(Date.now() - 60_000).toISOString() })).toBe('In a Few Minutes');
    // A late one says when it was due, under its own label (the Late tag above the facts says the rest).
    await openReviewed({ nextReviewAt: at(-1, 9, 0).toISOString(), late: true });
    expect(/Review Due(.*?)Why It Matters/.exec(body().shown())![1]).toBe('Yesterday at 9:00 AM');
    for (const v of ['Tomorrow at 9:00 AM', 'In a Few Minutes', 'Yesterday at 9:00 AM']) expect(titleCase(v), v).toBe(true);
    // A paused goal, or reviews off: how often, as before, with no Review Now and no empty LATEST REVIEW.
    await openReviewed({ status: 'paused' });
    expect(body().shown()).toContain('Review EveryWeek');
    expect(body().buttons()).not.toContain('Review Now');
    expect(headers()).toEqual(['Why It Matters', 'Done When', 'Steps']);
    await openGoal(view({ nextReviewAt: next.toISOString() }));
    expect(body().shown()).toContain('Review EveryWeek');
    expect(body().buttons()).not.toContain('Review Now');
    expect(headers()).toEqual(['Why It Matters', 'Done When', 'Steps']);
  });

  it('LATEST REVIEW in the trial week: when, what it found, and what it would change, each a sentence', async () => {
    const next = at(3, 9, 0);
    await openReviewed({ nextReviewAt: next.toISOString(), onTrack: { likelihood: 'likely', percent: 70, by: FINISH.toISOString() }, review: reviewed() });
    const shown = body().shown();
    // The third fact is the forecast for the finish date right above it, from the ledger's own number, in words: no parentheses.
    expect(shown).toContain(`Finish By${says(FINISH)}On TrackLikely · 70%`);
    expect(shown).not.toContain('Next Review');
    expect(headers()).toEqual(['Why It Matters', 'Done When', 'Steps', 'Latest Review']);
    expect(section().shown()).toBe([
      'Reviewed Today at 9:02 AM', '1 of 3 checks is met. 1 step is due this week.', 'Trial Week',
      'Flint is in its trial week, so it only shows what it would change.',
      `Move “Synthetic step one” to ${says(STEP_DUE)}.`,
      'Add the step “Check on wpf002/flint #57”.',
      `The next review is ${weekday(next)} at 9:00 AM.`,
    ].join(''));
    expect(reviewLines()).toEqual([
      '1 of 3 checks is met. 1 step is due this week.',
      'Flint is in its trial week, so it only shows what it would change.',
      `Move “Synthetic step one” to ${says(STEP_DUE)}.`,
      'Add the step “Check on wpf002/flint #57”.',
      `The next review is ${weekday(next)} at 9:00 AM.`,
    ]);
    for (const l of reviewLines()) {
      expect(sentence(l), l).toBe(true);
      expect(l, l).not.toMatch(FRAGMENT);
    }
    for (const title of section().visible().filter((e) => e.tagName === 'b' || e.className.startsWith('tag')).map((e) => e.textContent)) expect(titleCase(title), title).toBe(true);
    plainWords(section().shown());
    plainWords(shown.replace('Synthetic reason', ''));
    // Nothing waits in Approvals: in the trial week no card is filed.
    expect(shown).not.toContain('Approvals');
    expect(shown).not.toMatch(/approvals? waits?/);
    // A goal with no finish date has no On Track (likely by when?): its third fact is the next review.
    await openReviewed({ horizonAt: null, nextReviewAt: next.toISOString(), onTrack: null, review: reviewed() });
    expect(body().shown()).toContain(`Finish ByNo DateNext Review${weekday(next)} at 9:00 AM`);
    expect(body().shown()).not.toContain('On Track');
    // Even if a forecast came with it (an older runtime): never On Track without a date.
    await openReviewed({ horizonAt: null, nextReviewAt: next.toISOString(), onTrack: { likelihood: 'likely', percent: 70, by: at(90, 9, 0).toISOString() }, review: reviewed() });
    expect(body().shown()).not.toContain('On Track');
    expect(body().shown()).toContain('Next Review');
  });

  it('every kind of suggestion is a sentence in the panel’s own words; the titles are Will’s or a template’s', async () => {
    const due = new Date(YEAR, 9, 20, 17, 0);
    const changes = [
      { kind: 'due', title: 'Synthetic step one', dueAt: due.toISOString(), status: null, after: null, material: false },
      { kind: 'status', title: 'Synthetic step one', dueAt: null, status: 'blocked', after: null, material: false },
      { kind: 'status', title: 'Synthetic step one', dueAt: null, status: 'in_progress', after: null, material: false },
      { kind: 'status', title: 'Synthetic step one', dueAt: null, status: 'todo', after: null, material: false },
      { kind: 'move', title: 'Synthetic Flint step', dueAt: null, status: null, after: 'Synthetic step one', material: true },
      { kind: 'move', title: 'Synthetic Flint step', dueAt: null, status: null, after: null, material: true },
      { kind: 'skip', title: 'Synthetic step two', dueAt: null, status: null, after: null, material: true },
      { kind: 'add', title: 'Work on: Synthetic manual check', dueAt: due.toISOString(), status: null, after: null, material: true },
      { kind: 'add', title: 'Review your progress on this goal', dueAt: null, status: null, after: null, material: true },
    ];
    await openReviewed({ review: reviewed({ changes }) });
    expect(reviewLines().slice(2)).toEqual([
      `Move “Synthetic step one” to ${says(due)}.`,
      'Mark “Synthetic step one” blocked.',
      'Mark “Synthetic step one” in progress.',
      'Mark “Synthetic step one” not started.',
      'Do “Synthetic Flint step” after “Synthetic step one”.',
      'Do “Synthetic Flint step” first.',
      'Skip “Synthetic step two”.',
      `Add the step “Work on: Synthetic manual check”, due ${says(due)}.`,
      'Add the step “Review your progress on this goal”.',
    ]);
    // Quotation marks never nest: marks inside a title (Will's own, or a check's words in a template) become single ones.
    const quoted = [
      { kind: 'skip', title: 'Ship “v2” to “everyone”', dueAt: null, status: null, after: null, material: true },
      { kind: 'add', title: 'Work on: The "launch" post says "done"', dueAt: null, status: null, after: null, material: true },
      { kind: 'move', title: 'Read “the plan”', dueAt: null, status: null, after: 'Write "notes"', material: false },
    ];
    await openReviewed({ review: reviewed({ changes: quoted }) });
    expect(reviewLines().slice(2)).toEqual([
      'Skip “Ship ‘v2’ to ‘everyone’”.',
      'Add the step “Work on: The ‘launch’ post says ‘done’”.',
      'Do “Read ‘the plan’” after “Write ‘notes’”.',
    ]);
    for (const l of reviewLines()) expect(l, l).toMatch(/^[^“”"]*(“[^“”"]*”[^“”"]*)*$/);
    // A title is shown as text, never as markup (the fake DOM's innerHTML throws), whatever it holds.
    await openReviewed({ review: reviewed({ changes: [{ kind: 'skip', title: '<img src=x onerror=alert(1)>', dueAt: null, status: null, after: null, material: true }] }) });
    expect(reviewLines()).toContain('Skip “<img src=x onerror=alert(1)>”.');
  });

  it('after the trial week: what Flint suggested and what waits in Approvals; and why a review suggested nothing', async () => {
    const promoted = (over: Record<string, unknown>, more: Record<string, unknown> = {}) => openReviewed({ review: reviewed({ shadow: false, ...over }), ...more });
    await promoted({}, { waiting: [{ id: 'pr1', action: 'plan.change' }, { id: 'pr2', action: 'plan.change' }] });
    expect(section().shown()).toBe(`Reviewed Today at 9:02 AM1 of 3 checks is met. 1 step is due this week.Flint suggested these changes to the plan.Move “Synthetic step one” to ${says(STEP_DUE)}.Add the step “Check on wpf002/flint #57”.`);
    expect(section().shown()).not.toMatch(/Trial|trial/);
    // Its cards are where every card is: the goal's own line about what waits, with Open Approvals.
    // Cards are counted as cards (one may hold several changes), with a verb that agrees.
    expect(body().shown()).toContain('2 approvals wait for you.Open Approvals');
    expect(body().shown()).not.toMatch(/changes? waits?/);
    await promoted({}, { waiting: [{ id: 'pr1', action: 'plan.change' }] });
    expect(body().shown()).toContain('1 approval waits for you.Open Approvals');
    expect(sentence('1 approval waits for you.') && sentence('2 approvals wait for you.')).toBe(true);
    await promoted({ changes: reviewed().changes.slice(0, 1) });
    expect(reviewLines()[1]).toBe('Flint suggested this change to the plan.');
    // A suggestion held back by a limit is on no card yet, and says so right under it; the others say nothing more.
    const held = [
      { kind: 'due', title: 'Synthetic step one', dueAt: STEP_DUE.toISOString(), status: null, after: null, material: false, later: false },
      { kind: 'skip', title: 'Synthetic step two', dueAt: null, status: null, after: null, material: true, later: false },
      { kind: 'add', title: 'Check on wpf002/flint #57', dueAt: null, status: null, after: null, material: true, later: true },
    ];
    await promoted({ changes: held }, { waiting: [{ id: 'pr1', action: 'plan.change' }, { id: 'pr2', action: 'plan.change' }] });
    expect(reviewLines().slice(1)).toEqual([
      'Flint suggested these changes to the plan.',
      `Move “Synthetic step one” to ${says(STEP_DUE)}.`,
      'Skip “Synthetic step two”.',
      'Add the step “Check on wpf002/flint #57”.',
      'Flint will suggest this again at the next review.',
    ]);
    expect(sentence('Flint will suggest this again at the next review.')).toBe(true);
    expect(section().shown().match(/Flint will suggest this again/g)).toHaveLength(1);
    // In the trial week nothing is on a card, so nothing is marked as waiting for one.
    await openReviewed({ review: reviewed({ changes: held }) });
    expect(section().shown()).not.toContain('Flint will suggest this again');
    await promoted({ changes: [] });
    expect(reviewLines()).toEqual(['1 of 3 checks is met. 1 step is due this week.', 'Flint suggested no changes to the plan.']);
    await openReviewed({ review: reviewed({ changes: [] }) });
    expect(reviewLines().slice(1)).toEqual(['Flint is in its trial week, so it only shows what it would change.', 'It would change nothing in the plan.']);
    // Why there are no suggestions, each a sentence; suggestions are never shown without the model's answer.
    const why: Record<string, string> = {
      pending: 'Flint is still looking at the plan.', off: 'The local model is off, so Flint suggested no plan changes.',
      capped: 'Flint reached today’s limit of plan reviews, so it suggested no changes.', unavailable: 'The local model didn’t answer, so Flint suggested no plan changes.',
      invalid: 'The local model’s answer didn’t fit, so Flint suggested no plan changes.', deferred: 'Chat stayed busy, so Flint suggested no plan changes.',
      skipped: 'Flint didn’t look at the plan this time.',
    };
    for (const [planner, line] of Object.entries(why)) {
      await promoted({ planner });
      expect(reviewLines(), planner).toEqual(['1 of 3 checks is met. 1 step is due this week.', line]);
      expect(sentence(line), line).toBe(true);
    }
    // A review from another day says which, and a late next review says so.
    await openReviewed({ late: true, nextReviewAt: at(-1, 9, 0).toISOString(), review: reviewed({ at: at(-1, 9, 2).toISOString(), shadow: false, changes: [] }) });
    expect(section().shown()).toContain('Reviewed Yesterday at 9:02 AM');
    expect(reviewLines().at(-1)).toBe('The next review is late, and Flint runs it as soon as it can.');
    await openReviewed({ nextReviewAt: at(0, 23, 58).toISOString(), review: reviewed({ at: at(-9, 9, 2).toISOString() }) });
    expect(section().shown()).toContain(`Reviewed ${says(at(-9, 9, 2))} at 9:02 AM`);
    expect(reviewLines().at(-1)).toMatch(/^The next review (is today at 11:58 PM|runs in a few minutes)\.$/);
    // With reviews off the latest review is still shown, without a next review or Review Now.
    await openGoal(view({ nextReviewAt: at(1, 9, 0).toISOString(), review: reviewed() }));
    expect(section().shown()).not.toContain('next review');
    expect(body().shown()).toContain('Review EveryWeek');
    expect(body().buttons()).not.toContain('Review Now');
  });

  it('Review Now is unsigned: it posts /goals/:id/review and says what happens next in the footer; a refusal is the server’s sentence', async () => {
    await openReviewed({ nextReviewAt: at(3, 9, 0).toISOString(), review: reviewed() });
    calls = [];
    const timers = heldTimers();
    try {
      body().button('Review Now').onclick!();
      await settle();
    } finally {
      timers.restore();
    }
    expect(posted()).toEqual([{ url: '/goals/gotestgoal0001/review', method: 'POST', body: {} }]);
    expect(signed).toEqual([]);
    expect(said()).toEqual(['Flint is reviewing this goal. It takes a few minutes.', 'res ok']);
    // One quiet read of the goal is set for 6 seconds on, and nothing is read before then.
    expect(timers.queue.map((t) => t.ms)).toEqual([6000]);
    expect(calls.filter((c) => c.method === 'GET')).toEqual([]);
    // Past the day's 12, before reviews run, and while a rule stops them: the fixed sentences, in the footer, and the button works again.
    for (const [status, error, code] of [
      [429, 'Flint already reviewed this goal 12 times today. Try again tomorrow.', 'reviewCap'],
      [409, 'Scheduled reviews haven’t started yet, so Flint can’t review this goal.', 'reviewsOff'],
      [409, 'A rule stops goal reviews, so Flint can’t review this goal.', 'reviewsStopped'],
    ] as const) {
      await openReviewed({ nextReviewAt: at(3, 9, 0).toISOString(), review: reviewed() }, () => ({ status, body: { error, code } }));
      body().button('Review Now').onclick!();
      await settle();
      expect(said()).toEqual([error, 'res bad']);
      expect(body().button('Review Now').disabled).toBe(false);
    }
  });

  it('review findings 4 and R2: after a yes to Review Now the open goal is read again quietly, only what a review changes is redrawn, and never under a half-typed Add Step', async () => {
    expect([run('GOAL_REVIEW_WAITS'), run('GOAL_REVIEW_MORE'), run('GOAL_REVIEW_MAX'), run('GOAL_REVIEW_ASKED')]).toEqual([[6000, 69000], 60000, 32, 6]);
    const before = reviewed({ at: at(-1, 9, 2).toISOString() });
    const g = view({ reviews: 'on', nextReviewAt: at(3, 9, 0).toISOString(), onTrack: null, review: before });
    let latest: Record<string, unknown> = g;
    routes = (c) => (c.method === 'GET' && c.url.startsWith('/goals/') ? { status: 200, body: { goal: latest } } : c.method === 'GET' ? { status: 200, body: { tab: 'active', goals: [row()], waiting: [], reviews: 'on' } } : { status: 200, body: { ok: true } });
    await open();
    run(`goalOpen('${g.id}')`);
    await settle();
    ids.goalbody!.scrollTop = 420;
    const gets = () => calls.filter((c) => c.method === 'GET').map((c) => c.url);
    const part = (id: string) => body().all().find((e) => e.id === id)!;
    const timers = heldTimers();
    try {
      calls = [];
      body().button('Review Now').onclick!();
      await settle();
      expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(['POST /goals/gotestgoal0001/review']);
      expect(timers.queue.map((t) => t.ms)).toEqual([6000]);

      // 6 seconds on: the goal is read once. Only the facts and LATEST REVIEW are drawn again; everything else on the
      // page is the very element it was (the checks, the steps, Add Step, the footer and its buttons), where Will had scrolled.
      const kept = body().children.filter((e) => e.id !== 'goaltop' && e.id !== 'goalrevbox');
      const footer = [...foot().children];
      const [topWas, revWas] = [part('goaltop').children[0], part('goalrevbox').children[1]];
      calls = [];
      expect(await timers.next()).toBe(6000);
      expect(gets()).toEqual(['/goals/gotestgoal0001']);
      expect(body().children.filter((e) => e.id !== 'goaltop' && e.id !== 'goalrevbox')).toEqual(kept);
      for (const [i, e] of kept.entries()) expect(body().children.filter((x) => x.id !== 'goaltop' && x.id !== 'goalrevbox')[i]).toBe(e);
      for (const [i, e] of footer.entries()) expect(foot().children[i]).toBe(e);
      expect(part('goaltop').children[0]).not.toBe(topWas);
      expect(part('goalrevbox').children[1]).not.toBe(revWas);
      expect(body().shown()).not.toContain('Loading');
      expect(ids.goalbody!.scrollTop).toBe(420);
      // The review has not landed yet: the footer still says Flint is on it, and the next read is set for 75 seconds after the yes.
      expect(section().shown()).toContain('Reviewed Yesterday at 9:02 AM');
      expect(said()).toEqual(['Flint is reviewing this goal. It takes a few minutes.', 'res ok']);
      expect(timers.queue.map((t) => t.ms)).toEqual([69000]);

      // Will opens Add Step and starts typing. The read that comes due does not happen: nothing is drawn under his hands.
      body().button('Add Step').onclick!();
      body().field('Step').value = 'Synthetic half-typed step';
      body().field('Due').value = '2026-11-02';
      calls = [];
      expect(await timers.next()).toBe(69000);
      expect(gets()).toEqual([]);
      expect(body().field('Step').value).toBe('Synthetic half-typed step');
      expect(body().field('Due').value).toBe('2026-11-02');
      // It is tried again a minute later, and again waits for him: an open form with nothing in it yet is left alone too.
      expect(timers.queue.map((t) => t.ms)).toEqual([60000]);
      latest = { ...g, review: reviewed({ at: at(0, 9, 30).toISOString(), planner: 'pending', changes: [] }) };
      body().field('Step').value = '';
      await timers.next();
      expect(gets()).toEqual([]);
      expect(body().buttons()).toContain('Cancel');
      // A write on its way holds it off as well.
      run('GOALS.busy=true');
      body().field('Step').value = 'Synthetic half-typed step';
      await timers.next();
      expect(gets()).toEqual([]);
      run('GOALS.busy=false');

      // He cancels the form. The next read happens: the new review is here, still looking at the plan. The footer has
      // nothing more to say, and the panel reads on, a minute at a time, until that look has ended.
      body().button('Cancel').onclick!();
      await settle();
      calls = [];
      expect(await timers.next()).toBe(60000);
      expect(gets()).toEqual(['/goals/gotestgoal0001']);
      expect(section().shown()).toContain('Reviewed Today at 9:30 AM');
      expect(reviewLines()).toContain('Flint is still looking at the plan.');
      expect(said()).toBeNull();
      expect(ids.goalbody!.scrollTop).toBe(420);
      expect(timers.queue.map((t) => t.ms)).toEqual([60000]);
      // Slower than 75 seconds: it does not stay "still looking" for good. The read after it has ended shows what it found, and is the last.
      latest = { ...g, waiting: [{ id: 'pr1', action: 'plan.change' }], review: reviewed({ at: at(0, 9, 30).toISOString(), shadow: false, planner: 'ok' }) };
      calls = [];
      await timers.next();
      expect(gets()).toEqual(['/goals/gotestgoal0001']);
      expect(reviewLines()).not.toContain('Flint is still looking at the plan.');
      expect(reviewLines()).toContain('Flint suggested these changes to the plan.');
      expect(body().shown()).toContain('1 approval waits for you.Open Approvals');
      expect(timers.queue).toEqual([]);

      // A read that fails is tried again; Will gone elsewhere ends it for good, even once he is back on the same goal.
      body().button('Review Now').onclick!();
      await settle();
      routes = (c) => (c.method === 'GET' && c.url.startsWith('/goals/') ? { status: 503, body: { error: 'x' } } : { status: 200, body: { tab: 'active', goals: [row()], waiting: [], reviews: 'on' } });
      const seen = body().shown();
      await timers.next();
      expect(body().shown()).toBe(seen);
      expect(timers.queue.map((t) => t.ms)).toEqual([69000]);
      routes = (c) => (c.method === 'GET' && c.url.startsWith('/goals/') ? { status: 200, body: { goal: latest } } : { status: 200, body: { tab: 'active', goals: [row()], waiting: [], reviews: 'on' } });
      for (const away of [`goalList('active')`, `closeGoals()`]) {
        run(away);
        await settle();
        if (away.startsWith('close')) await open();
        const there = body().shown();
        calls = [];
        while (timers.queue.length) await timers.next();
        expect(gets().filter((u) => u.startsWith('/goals/gotestgoal0001')), away).toEqual([]);
        expect(body().shown(), away).toBe(there);
        run(`goalOpen('${g.id}')`);
        await settle();
        body().button('Review Now').onclick!();
        await settle();
      }
      run(`goalList('active')`);
      await settle();
      run(`goalOpen('${g.id}')`);
      await settle();
      calls = [];
      while (timers.queue.length) await timers.next();
      expect(calls).toEqual([]);
      expect(said()).toBeNull();
    } finally {
      timers.restore();
    }
  });

  it('review finding R2: the quiet reads are bounded, and a look at the plan that is still running when a goal is opened is read on too', async () => {
    // (The fake DOM's own timers fire at once, so every read the panel would ever make happens right here.)
    const pending = view({ reviews: 'on', nextReviewAt: at(3, 9, 0).toISOString(), onTrack: null, review: reviewed({ planner: 'pending', changes: [] }) });
    let n = 0;
    let after = 3;
    routes = (c) => {
      if (c.method === 'GET' && c.url.startsWith('/goals/')) return { status: 200, body: { goal: ++n > after ? { ...pending, review: reviewed({ changes: [] }) } : pending } };
      return c.method === 'GET' ? { status: 200, body: { tab: 'active', goals: [row()], waiting: [], reviews: 'on' } } : { status: 200, body: { ok: true } };
    };
    await open();
    // Opened while Flint is still looking at the plan: no Review Now needed. It reads on until the look has ended, then stops.
    run(`goalOpen('${pending.id}')`);
    await settle();
    expect(n).toBe(4);
    expect(reviewLines()).not.toContain('Flint is still looking at the plan.');
    expect(reviewLines()).toContain('It would change nothing in the plan.');
    // A look that never ends: 32 reads in all (about half an hour), and no more. By then the runtime itself says it was skipped.
    n = 0;
    after = 1000;
    run(`goalOpen('${pending.id}')`);
    await settle();
    expect(n).toBe(1 + 32);
    // Review Now, and the review never comes (the day's 12 were used between the tap and the job): 6 reads, and the footer stops saying Flint is on it.
    const idle = view({ reviews: 'on', nextReviewAt: at(3, 9, 0).toISOString(), onTrack: null, review: reviewed() });
    n = 0;
    routes = (c) => (c.method === 'GET' && c.url.startsWith('/goals/') ? (n++, { status: 200, body: { goal: idle } }) : c.method === 'GET' ? { status: 200, body: { tab: 'active', goals: [row()], waiting: [], reviews: 'on' } } : { status: 200, body: { ok: true } });
    run(`goalOpen('${idle.id}')`);
    await settle();
    n = 0;
    body().button('Review Now').onclick!();
    await settle();
    expect(n).toBe(6);
    expect(said()).toBeNull();
    // A goal whose review is not pending, opened and left alone, is read once and never again.
    n = 0;
    run(`goalOpen('${idle.id}')`);
    await settle();
    expect(n).toBe(1);
  });

  it('the panel’s own new lines are plain sentences by the note rules too', () => {
    for (const line of [
      'Flint will suggest this again at the next review.', '2 approvals wait for you.', '1 approval waits for you.', run('GOAL_REVIEWING') as string,
      'The next review is Sunday at 9:00 AM.', 'The next review is late, and Flint runs it as soon as it can.', 'The next review runs in a few minutes.',
      'Flint is in its trial week, so it only shows what it would change.', 'Flint suggested these changes to the plan.', 'Flint suggested no changes to the plan.',
      ...(Object.values(run('GOAL_PLAN_SAY') as Record<string, string>)),
    ]) {
      expect(noteProblems('Latest Review', line), line).toEqual([]);
      expect(sentence(line), line).toBe(true);
    }
    for (const title of ['Latest Review', 'Review Now', 'Review Due', 'Next Review', 'On Track', 'Late', 'Trial Week', 'Open Approvals']) expect(noteProblems(title, ''), title).toEqual([]);
  });

  it('a goal just added says when its first review is, or that scheduled reviews start soon', async () => {
    const added = async (reviews: 'on' | 'off') => {
      routes = (c) => (c.url === '/goals' && c.method === 'POST' ? { status: 200, body: { id: 'prnew', deduped: false } } : { status: 200, body: { tab: 'active', goals: [], waiting: [], reviews } });
      await open();
      run(`goalClear();GOALS.form.title='Synthetic goal';GOALS.form.checks[0].text='Synthetic check';goalForm()`);
      foot().button('Add Goal with Touch ID').onclick!();
      await settle();
      return body().shown();
    };
    expect(await added('on')).toContain('Goal AddedYour goal is active. Flint’s first review runs in a few minutes.');
    expect(await added('off')).toContain('Goal AddedYour goal is active. Scheduled reviews start soon.');
  });
});

/**
 * The Suggested tab (P3 part 5): what Flint heard Will say in a chat. Each row
 * is its short title, "You said this in a chat on Oct 8.", and his own words
 * in quotation marks, whole; with Dismiss and Make It a Goal. Make It a Goal
 * opens the New Goal form with his words in it, and takes one signature.
 */
describe('the Suggested tab', () => {
  const SAID_ON = new Date(YEAR, 9, 8, 15, 0);
  const QUOTE = 'I want to run a half marathon by spring, and I’m going to sign up for the Dallas race this week so I can’t back out';
  const one = (over: Record<string, unknown> = {}) => ({ goalId: 'go0123456789abcdef0123456789abcdef', title: 'Run a half marathon', quote: QUOTE, saidAt: SAID_ON.toISOString(), dueOn: day(later(120)), waiting: true, ...over });
  const two = () => [one(), one({ goalId: 'gofedcba9876543210fedcba9876543210', title: 'Finish the sailing course', quote: 'I’d like to finish the sailing course before summer', saidAt: null, dueOn: null, waiting: false })];
  const suggested = (suggestions: unknown[], more: (c: Call) => { status: number; body: unknown } | undefined = () => undefined) => {
    routes = (c) => more(c) ?? (c.url === '/goals?tab=suggested'
      ? { status: 200, body: { tab: 'suggested', goals: [], waiting: [], reviews: 'off', suggestions } }
      : c.method === 'GET' ? { status: 200, body: { tab: 'active', goals: [], waiting: [], reviews: 'off', suggestions: [] } } : { status: 200, body: { ok: true } });
  };
  const openSuggested = async () => {
    await open();
    run(`goalList('suggested')`);
    await settle();
  };
  const rows = () => body().visible().filter((e) => e.className === 'row two gwrap gsug');

  it('empty: its exact words; loading says Loading; the tab is shown only when Flint has suggested something, or while it is open', async () => {
    suggested([]);
    await open();
    // Nothing suggested: no Suggested tab on the Active list.
    expect(body().buttons().filter((b) => ['Active', 'Suggested', 'Finished'].includes(b))).toEqual(['Active', 'Finished']);
    run(`goalList('suggested')`);
    // Before the answer lands, the list says it is loading.
    expect(body().shown()).toContain('Loading…');
    await settle();
    expect(body().shown()).toContain('No SuggestionsGoals Flint suggests from your chats show here.');
    expect(body().shown()).not.toContain('Loading…');
    expect(body().buttons().filter((b) => ['Active', 'Suggested', 'Finished'].includes(b))).toEqual(['Active', 'Suggested', 'Finished']);
    expect(rows()).toEqual([]);
    // With something suggested, the Active list offers the tab.
    suggested(two());
    run(`goalList('active')`);
    await settle();
    expect(body().buttons().filter((b) => ['Active', 'Suggested', 'Finished'].includes(b))).toEqual(['Active', 'Suggested', 'Finished']);
  });

  it('two suggestions: each its title, when he said it, and his words in quotation marks, whole; Dismiss and Make It a Goal; no id anywhere', async () => {
    suggested(two());
    await openSuggested();
    expect(rows()).toHaveLength(2);
    const [first, second] = rows();
    const linesOf = (r: El) => r.children[0]!.children.map((c) => c.textContent);
    expect(linesOf(first!)).toEqual(['Run a half marathon', `You said this in a chat on ${says(SAID_ON)}.`, `“${QUOTE}”`]);
    // His words are never cut: every character of the quote is on the row.
    expect(first!.shown()).toContain(QUOTE);
    expect(QUOTE.length).toBeGreaterThan(100);
    // One nothing kept the day of: it says so without a date, never an empty one.
    expect(linesOf(second!)).toEqual(['Finish the sailing course', 'You said this in a chat.', '“I’d like to finish the sailing course before summer”']);
    for (const r of rows()) {
      expect(r.buttons()).toEqual(['Dismiss', 'Make It a Goal']);
      expect(r.button('Make It a Goal').className).toBe('btn pri');
      expect(r.button('Dismiss').className).toBe('btn');
    }
    for (const b of ['Dismiss', 'Make It a Goal']) expect(titleCase(b), b).toBe(true);
    for (const l of [linesOf(first!)[1]!, linesOf(second!)[1]!]) {
      expect(sentence(l), l).toBe(true);
      expect(noteProblems('Suggested', l), l).toEqual([]);
    }
    // Nothing internal on screen: no goal id, no source, no JSON, no parenthesis.
    const shown = body().shown();
    expect(shown).not.toMatch(/go0123456789|gofedcba|chat:|sourceRef|[{}()\[\]]/);
    // New Goal is still offered from here.
    expect(ids.goaladd!.hidden).toBe(false);
  });

  it('a load failure, a rejected token and a signed-out console each say so, and nothing is drawn half-read', async () => {
    routes = (c) => (c.url === '/goals?tab=suggested' ? { status: 503, body: { error: 'The runtime isn’t answering, so goals can’t load.' } } : { status: 200, body: { tab: 'active', goals: [], waiting: [], reviews: 'off' } });
    await openSuggested();
    expect(body().shown()).toContain('Couldn’t Load GoalsThe runtime isn’t answering, so goals can’t load.Try Again');
    expect(rows()).toEqual([]);
    suggested(two());
    body().button('Try Again').onclick!();
    await settle();
    expect(rows()).toHaveLength(2);
    // The server no longer takes the token.
    routes = (c) => (c.url === '/goals?tab=suggested' ? { status: 401, body: { error: 'unauthorized' } } : { status: 200, body: { tab: 'active', goals: [], waiting: [], reviews: 'off' } });
    run(`goalList('suggested')`);
    await settle();
    expect(body().shown()).toContain('Couldn’t Load GoalsThe access token was rejected. Check Settings.Try Again');
    // Signed out (no token at all): the Goals button opens Settings, and nothing is asked.
    const before = calls.length;
    panels = {};
    run(`TOKEN='';closeGoals();openGoals()`);
    await settle();
    expect(panels.settings).toBe(true);
    expect(panels.goals).toBe(false);
    expect(calls.length).toBe(before);
  });

  it('Make It a Goal opens the New Goal form with his words in it: the title, why it matters, and the day Flint read, said as Flint’s reading', async () => {
    suggested(two());
    await openSuggested();
    rows()[0]!.button('Make It a Goal').onclick!();
    expect(ids.goalsttl!.textContent).toBe('New Goal');
    // Nothing is filed or signed by opening it.
    expect(posted()).toEqual([]);
    expect(signed).toEqual([]);
    expect(body().field('Name').value).toBe('Run a half marathon');
    expect(body().field('Why It Matters').value).toBe(QUOTE);
    expect(body().field('Finish By').value).toBe(day(later(120)));
    expect(body().field('Check').value).toBe('');
    // The day in Finish By is the local model's reading of his words, never his own word for it: the form says whose it is.
    expect(body().shown()).toContain(`You said this in a chat on ${says(SAID_ON)}. Flint read the day as ${says(later(120))}. Add how you’ll know it’s done, then make it a goal.`);
    expect(body().shown()).not.toMatch(/you named/i);
    // It is this suggestion's form, not the kept New Goal draft: no Clear, and the draft is not touched.
    expect(ids.goalclear!.hidden).toBe(true);
    expect(run('GOALS.draft')).toBeNull();
    expect(foot().buttons()).toEqual(['Cancel', 'Make It a Goal with Touch ID']);
    expect(focused).toBe('check:0:text');
    // Cancel goes back to the suggestions.
    foot().button('Cancel').onclick!();
    await settle();
    expect(rows()).toHaveLength(2);
    // A day that is today, or has passed, is not put in the form; a suggestion with no day has none. Then the form says nothing of a day.
    for (const s of [one({ dueOn: day(new Date()) }), one({ dueOn: day(later(-3)) }), one({ dueOn: null })]) {
      run(`goalFromSuggestion(${JSON.stringify(s)})`);
      expect(body().field('Finish By').value).toBe('');
      expect(body().shown()).toContain(`You said this in a chat on ${says(SAID_ON)}. Add how you’ll know it’s done, then make it a goal.`);
      expect(body().shown()).not.toContain('Flint read the day');
    }
  });

  it('a title starts with a capital letter, on the row, in the form and in the Dismiss question, whoever wrote it; his words are shown in his own characters', async () => {
    // A row stored before the server gave titles their capital, with a quote in his own marks (a curly apostrophe, a dash, an accent).
    const his = 'I’ll finish the café’s “winter menu” — all of it — before the 1st';
    suggested([one({ title: 'finish the winter menu', quote: his })]);
    await openSuggested();
    const lines = rows()[0]!.children[0]!.children.map((c) => c.textContent);
    expect(lines[0]).toBe('Finish the winter menu');
    expect(lines[2]).toBe(`“${his}”`);
    rows()[0]!.button('Dismiss').onclick!();
    expect(foot().shown()).toContain('“Finish the winter menu”');
    foot().button('Cancel').onclick!();
    rows()[0]!.button('Make It a Goal').onclick!();
    expect(body().field('Name').value).toBe('Finish the winter menu');
    // Why It Matters starts as his words, character for character.
    expect(body().field('Why It Matters').value).toBe(his);
    // Only the first letter is touched: a name inside the title keeps its own letters.
    expect(run(`gCap('visit iOS meetup in São Paulo')`)).toBe('Visit iOS meetup in São Paulo');
    expect(run(`gCap('')`)).toBe('');
    expect(run(`gCap('Émile’s book')`)).toBe('Émile’s book');
  });

  it('one signature: it posts the suggestion’s own start route, then signs exactly the args it showed; the goal stays one Flint suggested', async () => {
    suggested(two(), (c) => (c.method === 'POST' && c.url.endsWith('/start') ? { status: 200, body: { id: 'prstart', deduped: false } } : undefined));
    await openSuggested();
    rows()[0]!.button('Make It a Goal').onclick!();
    // A goal needs a way to know it is done: said in the footer, with the cursor on the check.
    foot().button('Make It a Goal with Touch ID').onclick!();
    expect(said()).toEqual(['Add at least one way to know it’s done.', 'res bad']);
    expect(focused).toBe('check:0:text');
    expect(posted()).toEqual([]);
    type('Check', 'I cross the finish line');
    type('Step', 'Sign up for the Dallas race');
    foot().button('Make It a Goal with Touch ID').onclick!();
    await settle();
    const finish = new Date(later(120).getFullYear(), later(120).getMonth(), later(120).getDate(), 23, 59, 0, 0).toISOString();
    const args = {
      goalId: 'go0123456789abcdef0123456789abcdef', owner: 'will', origin: 'flint', sensitivity: 'personal', tainted: false, nexusProjectId: null,
      title: 'Run a half marathon', description: QUOTE, successCriteria: [{ id: 'c1', text: 'I cross the finish line', check: { kind: 'manual' } }],
      horizonAt: finish, reviewCadence: 'P1W', links: [],
      plan: { ops: [{ op: 'add', key: 's1', step: { ordinal: 100, title: 'Sign up for the Dallas race', kind: 'will_task', tier: 'approval', dueAt: null, dependsOn: [] } }] },
    };
    // One card filed, on the suggestion's own id: never POST /goals (his own new goal), never a draft key.
    expect(posted()).toEqual([{ url: '/goals/go0123456789abcdef0123456789abcdef/start', method: 'POST', body: { args } }]);
    // And one signature, of exactly those args, fresh, with a plain prompt.
    expect(signed).toHaveLength(1);
    expect(signed[0]![0]).toBe('prstart');
    expect(signed[0]![1]).toMatchObject({ fresh: true, reason: 'start this goal' });
    expect(JSON.parse(JSON.stringify(signed[0]![1].args))).toEqual(args);
    // What the panel signs is what the server and the runtime read: the contract changes nothing in it.
    const parsed = GOAL_CARD_BODIES.start.parse({ args }) as { args: unknown };
    expect(digestOf(parsed.args)).toBe(digestOf(args));
    expect(NewGoalBody.safeParse({ draftKey: 'k7Hq2LmN9pQr3sTv', args }).success).toBe(false);
    // Said in words, with the way back to the other suggestions.
    expect(body().shown()).toContain('Goal AddedYour goal is active.');
    expect(foot().buttons()).toEqual(['More Suggestions', 'Done']);
    foot().button('More Suggestions').onclick!();
    await settle();
    expect(run('GOALS.tab')).toBe('suggested');
  });

  it('a cancelled prompt leaves the card in Approvals and says so; a refusal is the server’s sentence', async () => {
    suggested(two(), (c) => (c.method === 'POST' && c.url.endsWith('/start') ? { status: 200, body: { id: 'prstart', deduped: false } } : undefined));
    await openSuggested();
    rows()[0]!.button('Make It a Goal').onclick!();
    type('Check', 'I cross the finish line');
    signAnswer = async () => {
      throw new Error('not confirmed');
    };
    foot().button('Make It a Goal with Touch ID').onclick!();
    await settle();
    expect(said()).toEqual(['Cancelled. It’s waiting in Approvals.', 'res bad']);
    // The suggestion was dismissed, or made a goal, somewhere else meanwhile: the runtime's sentence, as it is.
    suggested(two(), (c) => (c.method === 'POST' && c.url.endsWith('/start') ? { status: 404, body: { error: 'This suggestion is no longer waiting.', code: 'suggestionGone' } } : undefined));
    foot().button('Make It a Goal with Touch ID').onclick!();
    await settle();
    expect(said()).toEqual(['This suggestion is no longer waiting.', 'res bad']);
    expect(signed).toHaveLength(1);
  });

  it('Dismiss is unsigned: it posts the suggestion’s dismiss route, says so, and reads the list again', async () => {
    let left = two();
    suggested(left, (c) => {
      if (c.method === 'POST' && c.url.endsWith('/dismiss')) {
        left = left.slice(1);
        return { status: 200, body: { ok: true } };
      }
      return c.url === '/goals?tab=suggested' ? { status: 200, body: { tab: 'suggested', goals: [], waiting: [], reviews: 'off', suggestions: left } } : undefined;
    });
    await openSuggested();
    // It asks first, in the footer, naming the one it is about. It promises what is true and no more: this one is set aside,
    // and the same idea said again in a later chat may be suggested again.
    rows()[0]!.button('Dismiss').onclick!();
    await settle();
    expect(posted()).toEqual([]);
    expect(foot().shown()).toContain('Dismiss This SuggestionFlint sets aside “Run a half marathon”. If you say it again in a later chat, Flint may suggest it again.');
    expect(foot().shown()).not.toMatch(/won’t suggest|never/);
    expect(foot().buttons()).toEqual(['Cancel', 'Dismiss']);
    foot().button('Cancel').onclick!();
    expect(foot().buttons()).toEqual([]);
    expect(posted()).toEqual([]);
    expect(rows()).toHaveLength(2);
    rows()[0]!.button('Dismiss').onclick!();
    foot().button('Dismiss').onclick!();
    await settle();
    expect(posted()).toEqual([{ url: '/goals/go0123456789abcdef0123456789abcdef/dismiss', method: 'POST', body: {} }]);
    expect(signed).toEqual([]);
    expect(said()).toEqual(['You dismissed it.', 'res ok']);
    expect(rows()).toHaveLength(1);
    expect(run('GOALS.tab')).toBe('suggested');
    // A refusal is said in the footer, and the row stays.
    suggested(left, (c) => (c.method === 'POST' ? { status: 409, body: { error: 'This goal is already active.', code: 'status.active' } } : undefined));
    rows()[0]!.button('Dismiss').onclick!();
    foot().button('Dismiss').onclick!();
    await settle();
    expect(said()).toEqual(['This goal is already active.', 'res bad']);
    expect(rows()).toHaveLength(1);
  });

  it('a runtime from before this part lists its proposed goals as rows, and an open one still offers Dismiss and Make It a Goal, which opens the form', async () => {
    const proposed = view({ id: 'gotestgoal0008', title: 'Synthetic suggested goal', description: 'Synthetic words I said', status: 'proposed', origin: 'flint', successCriteria: [], criteria: [], checks: { met: 0, total: 0, unknown: 0 }, horizonAt: null, activatedAt: null, links: [], plan: null });
    routes = (c) => (c.method === 'GET' && c.url.startsWith('/goals/') ? { status: 200, body: { goal: proposed } }
      : c.url === '/goals?tab=suggested' ? { status: 200, body: { tab: 'suggested', goals: [row({ id: 'gotestgoal0008', title: 'Synthetic suggested goal', status: 'proposed', origin: 'flint' })], waiting: [], reviews: 'off' } }
        : { status: 200, body: { tab: 'active', goals: [], waiting: [], reviews: 'off' } });
    await openSuggested();
    expect(rows()).toEqual([]);
    expect(body().shown()).toContain('Synthetic suggested goalFlint suggested this from a chat.');
    run(`goalOpen('gotestgoal0008')`);
    await settle();
    expect(foot().buttons()).toEqual(['Dismiss', 'Make It a Goal']);
    foot().button('Make It a Goal').onclick!();
    // Nothing is signed by the button: a goal with no check could not start. The form opens with what it holds.
    expect(signed).toEqual([]);
    expect(posted()).toEqual([]);
    expect(ids.goalsttl!.textContent).toBe('New Goal');
    expect(body().field('Name').value).toBe('Synthetic suggested goal');
    expect(body().field('Why It Matters').value).toBe('Synthetic words I said');
    expect(run('GOALS.form.suggestion.goalId')).toBe('gotestgoal0008');
  });

  it('its own lines are plain sentences by the note rules, and its buttons Title Case', () => {
    for (const line of ['You said this in a chat on Oct 8.', 'You said this in a chat.', 'You said this in a chat on Oct 8. Add how you’ll know it’s done, then make it a goal.', 'You dismissed it.', 'Goals Flint suggests from your chats show here.', 'Flint sets aside “Run a half marathon”. If you say it again in a later chat, Flint may suggest it again.',
      'You said this in a chat on Oct 8. Flint read the day as Mar 11, 2027. Add how you’ll know it’s done, then make it a goal.']) {
      expect(noteProblems('Suggested', line), line).toEqual([]);
      expect(sentence(line), line).toBe(true);
    }
    for (const title of ['Suggested', 'No Suggestions', 'Make It a Goal', 'Dismiss', 'More Suggestions', 'Dismiss This Suggestion']) {
      expect(noteProblems(title, ''), title).toEqual([]);
      expect(titleCase(title), title).toBe(true);
    }
  });
});
