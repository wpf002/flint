/**
 * The console's Goals panel (apps/console/index.html, <script id="goals-js">),
 * run against a small fake DOM whose innerHTML setter throws: ES5 and text only;
 * the exact words (Title Case titles, buttons, tabs and labels; UPPERCASE section
 * headers through .gsh; every secondary line a complete sentence whose verb
 * agrees with its count); never "Late" (reviews come in a later part); what the
 * panel has to say (an error, an outcome, "Waiting for your approval.") is in the
 * footer, which never scrolls away; the form refuses what cannot be filed, in
 * sentences; Add Goal posts /goals and then signs exactly the args it showed,
 * with a fresh touch and a prompt in plain words (the args are already what the
 * shared contract normalizes them to, so their digest is the one filed); a
 * change says what it changes from; a cancelled prompt leaves the card in
 * Approvals; a half-typed New Goal survives closing the panel; a form drawn
 * again keeps the cursor; an answer that lands after Will has gone elsewhere
 * neither throws nor pulls him back; pausing, marks and step ticks are unsigned;
 * the item search is a POST and the stored label is the item's own; and the
 * Goals button hides while the server answers 501.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { webcrypto } from 'node:crypto';
import { GOAL_CARD_BODIES, NewGoalBody, digestOf } from '@flint/policy';

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
    // The header keeps the title (two lines of it); the body has all of it.
    expect(ids.goalsttl!.textContent).toBe(long);
    expect(body().visible().find((e) => e.className === 'gfull')!.textContent).toBe(long);
    expect(body().shown()).toContain('Synthetic one stepFlint checks this: its step isn’t done yet.');
    expect(body().shown()).toContain('Synthetic done stepFlint checks this: its step is done.');
    // A short title needs no second copy.
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
    expect(said()).toEqual(['Waiting for your approval.', 'res wait']);
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
    expect(body().shown()).not.toMatch(/Cancelled|Waiting for your approval/);
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
    // Clear is a quiet button, and starts a new draft.
    expect(foot().buttons()).toEqual(['Clear', 'Cancel', 'Add Goal with Touch ID']);
    expect(foot().button('Clear').className).toBe('ghost');
    foot().button('Clear').onclick!();
    expect(body().field('Name').value).toBe('');
    expect(body().visible().filter((e) => e.getAttribute('aria-label') === 'Step')).toHaveLength(1);
    expect(run('GOALS.form.draftKey')).not.toBe(key);
    expect(focused).toBe('name');
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
});
