/**
 * The console's Tasks panel and Settings > Assets (apps/console/index.html,
 * <script id="tasks-js">), run against a small fake DOM whose innerHTML setter
 * throws: ES5 and text only. It is loaded as the page loads it, after the
 * Approvals, Goals and Predictions scripts whose words and helpers it uses.
 *
 *  - The header button shows once the runtime answers, and its dot only while
 *    a card about a task or an asset waits for Will.
 *  - Tasks switched off on this Mac: the panel says the runtime's one sentence
 *    and offers nothing; so does Settings > Assets.
 *  - Every sentence about a task or an asset is the runtime's, shown as it
 *    came. The panel's own words are Title Case titles, tabs, buttons and
 *    labels, section headers through .gsh, and complete sentences, each held
 *    to the notes' rules. No id reaches the screen outside a card's Show
 *    Details.
 *  - Each button on an open task is there only when the runtime says it can
 *    be done now. Run Again is not offered by a runtime that does not say.
 *  - A card filed here is read back from the Approvals list and shown in that
 *    panel's own words, with everything it holds behind Show Details; Approve
 *    signs exactly those args, with a fresh touch and a plain prompt. Only a
 *    waiting card about a task or an asset is ever shown to sign.
 *  - Cancelling asks first; turning an asset off asks first and is not taken
 *    on a double tap; both are one unsigned POST, as the runtime allows.
 *  - Loading, failed, signed out, off and empty are each said in words; an
 *    answer that lands after Will has gone elsewhere neither throws nor pulls
 *    him back; closing drops what the panel holds.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { webcrypto } from 'node:crypto';
import {
  ACTION_WORDS, AssetEnableArgs, AssetsPage, CHECK_NAMES, DraftKey, EmptyBody, NewTaskBody, REVIEW_SAYS, TASK_SAYS, TASK_STATUS_SAYS, TASK_TEMPLATE_IDS, TaskAcceptArgs, TaskAgainBody, TaskAnswer, TaskCancelArgs, TaskDispatchArgs,
  TaskForm, TaskOverrideArgs, TasksPage, digestOf, noteProblems, ruleChecks, TaskSpec,
} from '@flint/policy';
import { TASKS_SAY } from '../src/tasks-routes';

const html = readFileSync(join(__dirname, '..', '..', 'console', 'index.html'), 'utf8');
const script = (id: string) => new RegExp(`<script id="${id}">([\\s\\S]*?)</script>`).exec(html)![1]!;
const tasksJs = script('tasks-js');
const predJs = script('predictions-js');
const goalsJs = script('goals-js');
const apprJs = script('approvals-js');

class El {
  className = '';
  children: El[] = [];
  style: Record<string, string> = {};
  onclick: ((ev?: unknown) => void) | null = null;
  onchange: (() => void) | null = null;
  oninput: (() => void) | null = null;
  onkeydown: ((ev: { key: string; preventDefault?: () => void }) => void) | null = null;
  disabled = false;
  hidden = false;
  tabIndex = -1;
  value = '';
  type = '';
  placeholder = '';
  maxLength = 0;
  /** A fact row keeps its value's element here (the page sets it). */
  val?: El;
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
    throw new Error('innerHTML is not allowed in the tasks panel');
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
  querySelector(_sel: string): El | null {
    return null;
  }
  focus() {
    focused = this;
  }
  all(): El[] {
    return this.children.flatMap((c) => [c, ...c.all()]);
  }
  visible(): El[] {
    return this.hidden ? [] : this.children.flatMap((c) => (c.hidden ? [] : [c, ...c.visible()]));
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
  shown(): string {
    return this.hidden ? '' : this.text + this.children.map((c) => c.shown()).join(' ');
  }
  with(cls: string): El[] {
    return this.visible().filter((e) => e.className.split(' ').includes(cls));
  }
  /** The <select> or <input> under the label that says `label`. */
  field(label: string): El {
    const wrap = this.with('fl').find((w) => w.children[0]?.textContent === label);
    if (!wrap) throw new Error(`no field "${label}" in: ${this.shown()}`);
    return wrap.children[1]!;
  }
}

/** The element that has the cursor. */
let focused: El | null;

type Call = { url: string; method: string; body: unknown };
let calls: Call[];
let routes: (c: Call) => { status: number; body: unknown };
let ids: Record<string, El>;
let signed: Array<[string, Record<string, unknown>]>;
let signAnswer: () => Promise<unknown>;
let keyed: boolean;
let panels: Record<string, boolean>;
let listeners: Array<[string, (e: { key: string }) => void]>;
let ctx: Record<string, unknown>;
let clock: number;

const settle = async () => {
  for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0));
};
const run = (code: string) => runInContext(code, ctx);

// ---- what a runtime sends, each held to its contract below ----
const WATCHER = 'as-ci-watcher-v1';
const T_OUT = 'tkk7Hq2LmN9pQr3sTv01';
const T_WAIT = 'tkk7Hq2LmN9pQr3sTv02';
const T_NEW = 'tkk7Hq2LmN9pQr3sTv03';
const T_RED = 'tkk7Hq2LmN9pQr3sTv04';
const T_DONE = 'tkk7Hq2LmN9pQr3sTv05';
const ITEM = 'en8f3k2m9x7q1w5z4c6v0b1n';
const GOAL = 'go1finishbuildingflint00';
const asset = (over: Record<string, unknown> = {}) => ({ id: WATCHER, name: 'CI Watcher', kind: 'ci_runner', on: true, waiting: false, line: 'Flint reports how your CI runs end.', canTurnOn: false, costs: false, ...over });
const assets = (...rows: Array<Record<string, unknown>>) => ({ assets: rows.length ? rows : [asset()], reviewsRequired: false });
const row = (id: string, over: Record<string, unknown> = {}) => ({
  id, title: 'Watch a CI Run', about: 'wpf002/flint CI', status: 'dispatched', line: 'Flint is watching for the run.', runsOn: 'CI Watcher', outside: false, costs: false, createdAt: '2026-10-12T10:00:00.000Z', ...over,
});
const WAITING_CHECKS = [{ id: 'a1', name: 'CI Run Passed', state: 'waiting' }, { id: 'a2', name: 'Names Only Your Items', state: 'waiting' }];
const PASSED_CHECKS = WAITING_CHECKS.map((c) => ({ ...c, state: 'passed' }));
const view = (id: string, over: Record<string, unknown> = {}) => ({
  ...row(id), result: null, checks: WAITING_CHECKS, checkedBy: null, askedBy: 'you', goalId: null, dueAt: null, chance: { likelihood: 'about_even', percent: 50 }, cost: null, card: null,
  can: { cancel: true, accept: false, reject: false, again: false }, ...over,
});
/** A task whose result passed its checks: its accept card waits for Will. */
const waitingView = (over: Record<string, unknown> = {}) =>
  view(T_WAIT, { status: 'checking', line: 'It passed its checks and is waiting for you.', outside: true, result: 'The run passed.', checks: PASSED_CHECKS, checkedBy: 'rules', card: 'praccept01', can: { cancel: true, accept: false, reject: true, again: false }, ...over });
const redView = (over: Record<string, unknown> = {}) =>
  view(T_RED, {
    status: 'rejected', line: 'It failed 1 of 2 checks.', outside: true, result: 'The run failed.', checks: [{ id: 'a1', name: 'CI Run Passed', state: 'failed' }, { id: 'a2', name: 'Names Only Your Items', state: 'passed' }], checkedBy: 'rules',
    can: { cancel: false, accept: true, reject: false, again: true }, ...over,
  });
const form = (over: Record<string, unknown> = {}) => ({
  templates: [{ template: 'watch_ci', title: 'Watch a CI Run', runsOn: 'CI Watcher', items: [{ entityId: ITEM, label: 'wpf002/flint CI' }, { entityId: 'en1a2b3c4d5e6f7g8h9i0j1k', label: 'wpf002/nexus CI' }], more: false }],
  goals: [{ id: GOAL, title: 'Finish Building Flint' }], ...over,
});

// ---- the cards, as the Approvals list holds them: args as the runtime files them ----
const spec = TaskSpec.parse({ template: 'watch_ci', params: { item: ITEM } });
const dispatchArgs = (taskId: string, over: Record<string, unknown> = {}) =>
  TaskDispatchArgs.parse({ taskId, assetId: WATCHER, assetKind: 'ci_runner', title: 'Watch a CI Run', spec, acceptance: ruleChecks(spec), goalId: null, stepKey: null, dueAt: null, sensitivity: 'ops', tainted: false, estCostMicros: 0, ...over });
const card = (id: string, fullName: string, args: unknown, over: Record<string, unknown> = {}) => ({
  id, fullName, args, tainted: false, provenance: {}, status: 'pending', origin: 'console', ts: Date.now() - 60_000, sensitivity: 'ops', destructive: false, consequential: false, kind: 'task', mcp: false,
  reason: 'Approving runs this task.', expiresAt: '2026-10-27T18:00:00.000Z', ...over,
});
const CARDS = {
  dispatch: card('prdispatch1', 'task.dispatch.ci_runner', dispatchArgs(T_NEW), { cost: { micros: 0 } }),
  accept: card('praccept01', 'task.check_bar', TaskAcceptArgs.parse({ taskId: T_WAIT, outputRef: 'out:0123456789abcdef', metBar: true, checks: 2, met: 2, by: 'flint:rule' }), { origin: 'runtime:tasks', templateId: 'task.accept.v1', reason: 'Approving accepts this result.' }),
  cancel: card('prcancel01', 'task.cancel', TaskCancelArgs.parse({ taskId: T_OUT }), { reason: 'Approving stops this task.' }),
  override: card('proverride1', 'task.bar_override', TaskOverrideArgs.parse({ taskId: T_RED, to: 'accepted' }), { consequential: true, reason: 'Approving accepts this result against its checks.' }),
  reject: card('prreject001', 'task.bar_override', TaskOverrideArgs.parse({ taskId: T_WAIT, to: 'rejected' }), { consequential: true, reason: 'Approving rejects this result against its checks.' }),
  again: card('pragain0001', 'task.dispatch.ci_runner', dispatchArgs(T_NEW), { cost: { micros: 0 } }),
  enable: card('prenable001', 'asset.enable', AssetEnableArgs.parse({ assetId: WATCHER, kind: 'ci_runner', externalRef: 'github:ci:v1', name: 'CI Watcher', capabilities: ['watch_ci'], dispatchAction: 'task.dispatch.ci_runner', spends: false, entityId: null }), {
    kind: 'policy', consequential: true, reason: 'Approving turns this asset on.',
  }),
};
const VIEWS: Record<string, Record<string, unknown>> = {
  [T_OUT]: view(T_OUT), [T_WAIT]: waitingView(), [T_RED]: redView(),
  [T_NEW]: view(T_NEW, { status: 'proposed', line: 'It’s waiting for your approval.', chance: null, card: 'prdispatch1' }),
  [T_DONE]: view(T_DONE, { status: 'accepted', line: 'It passed 2 of 2 checks.', outside: true, result: 'The run passed.', checks: PASSED_CHECKS, checkedBy: 'rules', can: { cancel: false, accept: false, reject: false, again: true } }),
};
const OFF = { status: 409, body: { error: TASK_SAYS.off, code: 'off' } };

/** The routes as a working server answers them; a test overrides what it needs. */
const answers = (over: Partial<Record<string, { status: number; body: unknown }>> = {}) => (c: Call): { status: number; body: unknown } => {
  const key = `${c.method} ${c.url}`;
  if (over[key]) return over[key]!;
  if (c.url === '/assets') return { status: 200, body: assets() };
  if (c.url === '/tasks?tab=active') return { status: 200, body: { tasks: [row(T_WAIT, { status: 'checking', line: 'It passed its checks and is waiting for you.', outside: true }), row(T_OUT, { about: 'wpf002/nexus CI' })], more: false } };
  if (c.url === '/tasks?tab=finished') return { status: 200, body: { tasks: [row(T_DONE, { status: 'accepted', line: 'It passed 2 of 2 checks.', outside: true }), row(T_RED, { status: 'rejected', line: 'It failed 1 of 2 checks.', outside: true })], more: false } };
  if (c.url === '/tasks/form') return { status: 200, body: form() };
  if (c.method === 'GET' && c.url.startsWith('/tasks/')) {
    const t = VIEWS[c.url.slice('/tasks/'.length)];
    return t ? { status: 200, body: { task: t } } : { status: 404, body: { error: TASK_SAYS.noTask, code: 'noTask' } };
  }
  if (key === 'POST /tasks') return { status: 200, body: { id: T_NEW, proposalId: 'prdispatch1', deduped: false } };
  if (c.method === 'POST' && c.url.endsWith('/again')) return { status: 200, body: { id: T_NEW, proposalId: 'pragain0001', deduped: false } };
  if (c.method === 'POST' && c.url.endsWith('/cancel')) return { status: 200, body: { proposalId: 'prcancel01', deduped: false } };
  if (c.method === 'POST' && c.url.endsWith('/accept')) return { status: 200, body: { proposalId: 'proverride1', deduped: false } };
  if (c.method === 'POST' && c.url.endsWith('/reject')) return { status: 200, body: { proposalId: 'prreject001', deduped: false } };
  if (c.method === 'POST' && c.url.endsWith('/on')) return { status: 200, body: { proposalId: 'prenable001', deduped: false } };
  if (c.url === '/proposals') return { status: 200, body: { proposals: Object.values(CARDS), signed: true } };
  if (c.url === `/goals/${GOAL}`) return { status: 200, body: { goal: { id: GOAL, title: 'Finish Building Flint' } } };
  if (c.url.startsWith('/goals')) return { status: 200, body: { tab: 'active', goals: [], waiting: [], reviews: 'off' } };
  if (c.url === '/predictions/waiting') return { status: 200, body: { questions: 0, announce: false } };
  return { status: 200, body: { ok: true } };
};

beforeEach(async () => {
  calls = [];
  signed = [];
  keyed = true;
  panels = {};
  listeners = [];
  focused = null;
  clock = 1_000_000;
  signAnswer = async () => ({ action: { status: 'done' } });
  routes = answers();
  ids = Object.fromEntries(
    ['tasks', 'tasksbtn', 'tasksdot', 'tasksttl', 'taskback', 'taskadd', 'taskbody', 'taskfoot', 'settings', 'setassets',
      'predictions', 'predbtn', 'preddot', 'predttl', 'predback', 'predbody', 'predfoot', 'goals', 'goalsbtn', 'goalsdot', 'goalsttl', 'goalback', 'goaladd', 'goalclear', 'goalbody', 'goalfoot',
      'approvals', 'apprlist', 'apprhelp', 'apprbadge', 'apprseg', 'apprtab-waiting', 'apprtab-approved', 'apprn-waiting', 'apprn-approved', 'apprfoot', 'apprnote', 'apprall', 'thread'].map((id) => [id, new El('div', id)]),
  );
  ids.tasksbtn!.hidden = true;
  ids.tasksdot!.hidden = true;
  ids.taskadd!.hidden = true;
  ids.setassets!.hidden = true;
  const document = {
    getElementById: (id: string) => ids[id] ?? [...Object.values(ids)].flatMap((e) => e.all()).find((e) => e.id === id) ?? null,
    createElement: (tag: string) => new El(tag),
    createTextNode: (t: string) => Object.assign(new El('#text'), { textContent: t }),
    querySelectorAll: () => [],
    addEventListener: (type: string, fn: (e: { key: string }) => void) => void listeners.push([type, fn]),
  };
  const fetch = async (url: string, init: { method?: string; body?: string; headers?: Record<string, string> } = {}) => {
    const c: Call = { url, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : undefined };
    expect(init.headers?.Authorization).toBe('Bearer tok');
    calls.push(c);
    const a = routes(c);
    return { ok: a.status >= 200 && a.status < 300, status: a.status, json: async () => (runInContext('JSON.parse', ctx) as (t: string) => unknown)(JSON.stringify(a.body)) };
  };
  ctx = {
    document, fetch, BASE: '', TOKEN: 'tok', console, crypto: webcrypto, navigator: { userAgent: 'test' },
    PANELS: ['approvals', 'settings', 'activity', 'goals'],
    auth: () => ({ Authorization: 'Bearer tok' }),
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0,
    svgi: () => new El('svg'), laneAgo: () => '1h', starters: () => {}, rejectAction: () => {},
    showPanel: (id: string, on: boolean) => {
      if (on) for (const other of Object.keys(panels)) if (other !== id) (panels[other] = false), ids[other]?.classList.toggle('open', false);
      panels[id] = on;
      ids[id]?.classList.toggle('open', on);
    },
    loadCreds: () => {},
    openSettings: () => void (ctx.showPanel as (id: string, on: boolean) => void)('settings', true),
    canEnclave: () => keyed, canPasskey: () => false,
    approveLabel: () => (keyed ? 'Approve with Touch ID' : 'Approve'),
    approveAction: (id: string, host: El, o: Record<string, unknown>) => {
      signed.push([id, o]);
      expect(host.querySelector('.res')).toBeTruthy();
      expect(host.querySelector('.prow')).toBeTruthy();
      return signAnswer();
    },
    errText: (e: unknown) => {
      const m = String((e as { message?: string })?.message ?? e);
      return /^not confirmed$/i.test(m) ? 'Cancelled.' : m;
    },
  };
  createContext(ctx);
  await boot();
  calls = [];
});

/** The scripts, as the page loads them: Approvals (the cards' words), Goals and Predictions (the helpers), then Tasks. `early`: the answers to what the first three asked come back before the Tasks script is read. */
async function boot(early = false): Promise<void> {
  runInContext(apprJs, ctx);
  runInContext(goalsJs, ctx);
  runInContext('openApprovals=function(){OPENED_APPROVALS=true;showPanel("approvals",true);};var OPENED_APPROVALS=false;', ctx);
  runInContext(predJs, ctx);
  if (early) await settle();
  runInContext(tasksJs, ctx);
  runInContext('taskNow=function(){return CLOCK();};', ctx);
  ctx.CLOCK = () => clock;
  await settle();
}

const open = async (tab?: string) => {
  run(tab ? `TASKS.tab='${tab}';openTasks()` : 'openTasks()');
  await settle();
};
const openTask = async (id: string) => {
  await open();
  run(`taskOpen('${id}')`);
  await settle();
};
const click = async (root: El, text: string) => {
  root.button(text).onclick!();
  await settle();
};
const body = () => ids.taskbody!;
const foot = () => ids.taskfoot!;
const title = () => ids.tasksttl!.textContent;
/** What the footer says (its message line), and how. */
const said = () => {
  const m = foot().visible().find((e) => e.id === 'taskmsg');
  return m ? [m.textContent, m.className] : null;
};
const note = () => foot().with('note').map((e) => e.textContent).join(' ');
const headers = (root: El = body()) => root.with('gsh').map((e) => e.textContent);
/** Each row as [label, its lines, its value]. */
const rows = (root: El = body()) =>
  root.with('row').map((r) => {
    const lbl = r.children.find((c) => c.className.split(' ').includes('lbl'));
    const val = r.all().find((c) => c.className === 'val' || c.className.split(' ').includes('st'));
    return [lbl?.children.find((c) => c.tagName === 'b')?.textContent ?? '', lbl?.children.filter((c) => c.tagName === 'span').map((c) => c.textContent) ?? [], val?.textContent ?? ''] as [string, string[], string];
  });
const tags = (root: El = body()) => root.with('tag').map((e) => e.textContent);
const empty = (root: El = body()) => {
  const e = root.with('empty')[0];
  return e ? [e.children.find((c) => c.tagName === 'b')?.textContent ?? e.textContent, e.children.find((c) => c.tagName === 'span')?.textContent ?? ''] : null;
};
const posts = () => calls.filter((c) => c.method === 'POST');
const SMALL = new Set(['a', 'an', 'the', 'and', 'but', 'or', 'nor', 'for', 'so', 'yet', 'as', 'at', 'by', 'from', 'in', 'into', 'of', 'off', 'on', 'onto', 'out', 'over', 'to', 'up', 'with']);
const titleCase = (s: string) => s.split(' ').every((w, i, all) => !w || /^[^a-z]/.test(w) || (i > 0 && i < all.length - 1 && SMALL.has(w)));
const sentence = (l: string) => /^[A-Z0-9].*[.!?]$/.test(l);
/** Everything on screen in the panel, as text. */
const screen = () => `${title()} ${body().shown()} ${foot().shown()}`;
/** No id, no stored name, no JSON, no aside in parentheses: nothing but words. */
const plainScreen = (root: () => string = screen) => {
  expect(root()).not.toMatch(/\btk[A-Za-z0-9]{16}|\ben[0-9a-z]{20}|\bas-ci|\bpr[a-z]+\d|\bgo1|watch_ci|ci_runner|task\.|asset\.|[{}[\]()]|undefined|null|NaN|\[object/);
};
/** The panel's own words on screen now (not the runtime's sentences) are held to the notes' rules. */
const ownWords = (titles: string[], sentences: string[]) => {
  for (const t of titles) {
    expect(titleCase(t), t).toBe(true);
    // (The notes' own title rule would write a small word inside a title lowercase: "Turn on the CI Watcher". A switch's On and Off are words of their own.)
    expect(noteProblems(t.replace(/ (On|Off) /g, (m) => m.toLowerCase()), ''), t).toEqual([]);
  }
  for (const s of sentences) {
    expect(sentence(s), s).toBe(true);
    expect(noteProblems('Tasks', s), s).toEqual([]);
  }
};

describe('what the fixtures hold', () => {
  it('is what a runtime can send: each page, each open task and the form pass their contracts, and each card’s args are the runtime’s own', () => {
    expect(AssetsPage.safeParse(assets()).success).toBe(true);
    for (const tab of ['active', 'finished']) expect(TasksPage.safeParse(answers()({ url: `/tasks?tab=${tab}`, method: 'GET', body: undefined }).body).success, tab).toBe(true);
    for (const [id, t] of Object.entries(VIEWS)) expect(TaskAnswer.safeParse({ task: t }).success, id).toBe(true);
    expect(TaskForm.safeParse(form()).success).toBe(true);
    expect(CARDS.dispatch.args).toMatchObject({ taskId: T_NEW, estCostMicros: 0, acceptance: [{ id: 'a1', text: CHECK_NAMES.ci }, { id: 'a2', text: CHECK_NAMES.refs_known }] });
  });
});

describe('the header button', () => {
  it('shows once the runtime answers; tasks switched off, an older runtime, no runtime, or a rejected token leaves it hidden', async () => {
    // The page as loaded (beforeEach): the runtime answered.
    expect(ids.tasksbtn!.hidden).toBe(false);
    for (const a of [{ status: 501, body: { error: 'x' } }, { status: 401, body: { error: 'x' } }, OFF]) {
      ids.tasksbtn!.hidden = false;
      routes = answers({ 'GET /assets': a });
      run('tasksProbe()');
      await settle();
      expect(ids.tasksbtn!.hidden, String(a.status)).toBe(true);
    }
    // Switched back on: the next look brings the button back.
    routes = answers();
    run('tasksProbe()');
    await settle();
    expect(ids.tasksbtn!.hidden).toBe(false);
    // Only down: the button is there, and its panel says why nothing loads.
    ids.tasksbtn!.hidden = true;
    routes = answers({ 'GET /assets': { status: 503, body: { error: TASKS_SAY.down } } });
    run('tasksProbe()');
    await settle();
    expect(ids.tasksbtn!.hidden).toBe(false);
    // What the page asks on its own is the assets: no task is read until Will opens the panel.
    routes = answers();
    calls = [];
    run('tasksProbe()');
    await settle();
    expect(calls).toEqual([{ url: '/assets', method: 'GET', body: undefined }]);
    // Signed out, nothing is asked at all, and the button opens Settings.
    calls = [];
    run("TOKEN='';tasksProbe();openTasks();loadAssets()");
    await settle();
    expect(calls).toEqual([]);
    expect(panels).toMatchObject({ settings: true });
    expect(panels.tasks).toBeFalsy();
  });

  it('its dot is lit only while a card about a task or an asset waits for Will', () => {
    const dot = () => ids.tasksdot!.hidden;
    run(`tasksDot(${JSON.stringify([CARDS.dispatch])})`);
    expect(dot()).toBe(false);
    for (const p of [CARDS.accept, CARDS.cancel, CARDS.override, CARDS.enable]) {
      run('tasksDot([])');
      expect(dot()).toBe(true);
      run(`tasksDot(${JSON.stringify([p])})`);
      expect(dot(), p.fullName).toBe(false);
    }
    // One that is approved and waiting to run, or a card of another kind, does not light it.
    run(`tasksDot(${JSON.stringify([{ ...CARDS.dispatch, status: 'approved' }, { id: 'pr9', fullName: 'goal.activate', kind: 'goal', mcp: false, status: 'pending', args: {} }, { id: 'pr8', fullName: 'tasks.other', status: 'pending', args: {} }])})`);
    expect(dot()).toBe(true);
    // Nor does a tool on a connected server that carries one of these names: by the server's mark, or by its kind.
    for (const p of Object.values(CARDS)) {
      for (const planted of [{ ...p, kind: 'tool_call', mcp: true }, { ...p, mcp: true }, { ...p, kind: 'tool_call' }, { ...p, kind: undefined }]) {
        run(`tasksDot(${JSON.stringify([planted])})`);
        expect(dot(), `${p.fullName} ${planted.kind} ${String((planted as { mcp?: boolean }).mcp)}`).toBe(true);
      }
    }
    // The Goals dot is held the same way: a goal's card lights it, a tool's card called goal.activate does not.
    const goalDot = () => ids.goalsdot!.hidden;
    const goal = { id: 'prg1', fullName: 'goal.activate', kind: 'goal', mcp: false, status: 'pending', args: {} };
    run(`goalsDot(${JSON.stringify([goal])})`);
    expect(goalDot()).toBe(false);
    for (const planted of [{ ...goal, kind: 'tool_call', mcp: true }, { ...goal, mcp: true }, { ...goal, kind: 'tool_call' }, { ...goal, kind: undefined }, { ...goal, fullName: 'plan.change', kind: 'tool_call', mcp: true }]) {
      run(`goalsDot(${JSON.stringify([planted])})`);
      expect(goalDot(), JSON.stringify(planted)).toBe(true);
    }
    run(`goalsDot(${JSON.stringify([{ ...goal, fullName: 'plan.change', kind: 'plan', mcp: false }])})`);
    expect(goalDot()).toBe(false);
  });

  it('the dot is lit from the start, even when the page’s first look at what waits came back before this script was read', async () => {
    // The page as loaded (beforeEach): a task card waits, and the dot says so.
    expect(ids.tasksdot!.hidden).toBe(false);
    // The same page, with the first answers back early: the Approvals script had no one to tell, so this script asks again.
    ids.tasksdot!.hidden = true;
    calls = [];
    await boot(true);
    expect(calls.filter((c) => c.url === '/proposals').length).toBeGreaterThanOrEqual(2);
    expect(ids.tasksdot!.hidden).toBe(false);
  });

  it('the page has the button, the panel and the Assets section, and Settings loads its assets whenever it opens', () => {
    expect(html).toContain('<button class="ib" id="tasksbtn" onclick="openTasks()" aria-label="Tasks" data-tip="Tasks" hidden>');
    expect(html).toMatch(/<div class="overlay" id="tasks" onclick="if\(event\.target===this\)closeTasks\(\)"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="tasksttl">/);
    expect(html).toMatch(/<h2 id="tasksttl">Tasks<\/h2><button class="ghost" id="taskadd" onclick="taskNew\(\)" hidden><svg class="i"><use href="#i-plus"\/><\/svg>New Task<\/button>/);
    expect(html).toContain('<div id="setassets" hidden></div>');
    expect(html).toContain("if(typeof loadAssets==='function')loadAssets();");
    expect(html).toContain('<symbol id="i-tasks"');
    // One of the page's panels: opening another closes it, and Escape closes it.
    expect(run('PANELS.indexOf("tasks")>=0')).toBe(true);
    ids.tasks!.classList.toggle('open', true);
    for (const [type, fn] of listeners) if (type === 'keydown') fn({ key: 'Escape' });
    expect(panels.tasks).toBe(false);
  });
});

describe('switched off on this Mac', () => {
  it('the panel says the runtime’s one sentence and offers nothing: no tab, no New Task, no button, and no task is asked for', async () => {
    routes = answers({ 'GET /assets': OFF });
    await open();
    expect(title()).toBe('Tasks');
    expect(empty()).toEqual(['Tasks Are Off', 'Tasks are turned off on this Mac.']);
    expect(body().buttons()).toEqual([]);
    expect(body().with('seg')).toEqual([]);
    expect(ids.taskadd!.hidden).toBe(true);
    expect(ids.taskback!.hidden).toBe(true);
    expect(foot().hidden).toBe(true);
    expect(calls.map((c) => c.url)).toEqual(['/assets']);
    plainScreen();
    // It was on, and is switched off while the panel is open: the tabs go too.
    routes = answers();
    await open();
    expect(body().with('seg')).toHaveLength(1);
    routes = answers({ 'GET /assets': OFF });
    run("taskTab('finished')");
    await settle();
    expect(body().with('seg')).toEqual([]);
    expect(body().buttons()).toEqual([]);
    expect(ids.taskadd!.hidden).toBe(true);
  });

  it('wherever it is learned, the panel goes to that one sentence: opening a task, a button on it, the form, a card', async () => {
    const offNow = (key: string) => (routes = answers({ [key]: OFF, 'GET /assets': OFF }));
    const isOff = () => {
      expect(empty()).toEqual(['Tasks Are Off', TASK_SAYS.off]);
      // Learned from whatever answer said so: the header's button goes, and the panel remembers.
      expect(ids.tasksbtn!.hidden).toBe(true);
      expect(run('taskIsOff()')).toBe(true);
      expect(body().buttons()).toEqual([]);
      expect(foot().hidden).toBe(true);
      expect(ids.taskadd!.hidden).toBe(true);
    };
    await open();
    offNow(`GET /tasks/${T_OUT}`);
    run(`taskOpen('${T_OUT}')`);
    await settle();
    isOff();
    routes = answers();
    await openTask(T_RED);
    offNow(`POST /tasks/${T_RED}/accept`);
    await click(foot(), 'Accept Anyway');
    isOff();
    routes = answers();
    await open();
    offNow('GET /tasks/form');
    run('taskNew()');
    await settle();
    isOff();
    routes = answers();
    await open();
    run('taskNew()');
    await settle();
    body().field('CI Run').value = ITEM;
    body().field('CI Run').onchange!();
    offNow('POST /tasks');
    await click(foot(), 'Create Task');
    isOff();
    expect(signed).toEqual([]);
  });

  it('Settings > Assets says the same one sentence under its header, with no row and no control', async () => {
    routes = answers({ 'GET /assets': OFF });
    run('loadAssets()');
    await settle();
    const host = ids.setassets!;
    expect(host.hidden).toBe(false);
    expect(headers(host)).toEqual(['Assets']);
    expect(rows(host)).toEqual([['', ['Tasks are turned off on this Mac.'], '']]);
    expect(host.buttons()).toEqual([]);
  });
});

describe('the list', () => {
  it('Active and Finished: each task by its title, the runtime’s sentence for where it stands, what it is about, and its marks', async () => {
    await open();
    expect(title()).toBe('Tasks');
    expect(body().with('seg')[0]!.buttons()).toEqual(['Active', 'Finished']);
    expect(rows()).toEqual([
      ['Watch a CI Run', ['It passed its checks and is waiting for you.'], 'wpf002/flint CI'],
      ['Watch a CI Run', ['Flint is watching for the run.'], 'wpf002/nexus CI'],
    ]);
    expect(tags()).toEqual(['Outside Text']);
    expect(ids.taskadd!.hidden).toBe(false);
    expect(calls.map((c) => c.url)).toEqual(['/assets', '/tasks?tab=active']);
    expect(focused?.id).toBe('tasktab-active');
    plainScreen();
    await click(body(), 'Finished');
    expect(rows().map((r) => r[1][0])).toEqual(['It passed 2 of 2 checks.', 'It failed 1 of 2 checks.']);
    expect(body().with('seg')[0]!.children.map((b) => [b.textContent, b.getAttribute('aria-selected')])).toEqual([['Active', 'false'], ['Finished', 'true']]);
    plainScreen();
    // A row opens its task, by the mouse or the keyboard.
    const first = body().with('row')[0]!;
    expect(first.getAttribute('role')).toBe('button');
    first.onkeydown!({ key: 'Enter', preventDefault: () => {} });
    await settle();
    expect(calls.at(-1)).toEqual({ url: `/tasks/${T_DONE}`, method: 'GET', body: undefined });
    expect(title()).toBe('Watch a CI Run');
  });

  it('a task that costs money is marked; a page that holds only the newest says so', async () => {
    routes = answers({ 'GET /tasks?tab=active': { status: 200, body: { tasks: [row(T_OUT, { costs: true, outside: true })], more: true } } });
    await open();
    expect(tags()).toEqual(['Outside Text', 'Costs Money']);
    expect(body().with('gnote').map((e) => e.textContent)).toEqual(['Flint shows the newest 100 tasks.']);
  });

  it('empty, by why: nothing yet, nothing finished, and no asset on to run one', async () => {
    const none = { status: 200, body: { tasks: [], more: false } };
    routes = answers({ 'GET /tasks?tab=active': none, 'GET /tasks?tab=finished': none });
    await open();
    expect(empty()).toEqual(['No Tasks Yet', 'Flint runs a task after you approve it.']);
    expect(body().buttons()).toEqual(['Active', 'Finished', 'New Task']);
    // The empty state has the button: the header does not repeat it.
    expect(ids.taskadd!.hidden).toBe(true);
    await click(body(), 'Finished');
    expect(empty()).toEqual(['Nothing Finished Yet', 'Tasks that end show here.']);
    expect(body().buttons()).toEqual(['Active', 'Finished']);
    expect(ids.taskadd!.hidden).toBe(false);
    // No asset is on: there is nothing to make a task with, and Settings is where that changes.
    for (const a of [asset({ on: false, canTurnOn: true }), asset({ on: false, waiting: true, line: 'A card is waiting for your approval.' }), asset({ on: false, line: TASK_SAYS.needsGithub })]) {
      routes = answers({ 'GET /assets': { status: 200, body: assets(a) }, 'GET /tasks?tab=active': none });
      await open('active');
      expect(empty()).toEqual(['No Asset Is On', 'Turn on the CI Watcher in Settings to start.']);
      expect(body().buttons()).toEqual(['Active', 'Finished', 'Open Settings']);
      expect(ids.taskadd!.hidden).toBe(true);
    }
    await click(body(), 'Open Settings');
    expect(panels).toMatchObject({ tasks: false, settings: true });
    // An asset that only reviews runs no task; one this page has no words for is named by its own name; none at all is "an asset".
    for (const [list, needs] of [
      [[asset({ kind: 'local_reviewer', name: 'Local Reviews' })], 'an asset'],
      [[asset({ kind: 'local_worker', name: 'Local Worker', on: false })], 'the Local Worker'],
      [[asset({ kind: 'nexus_participant', name: 'Paid Tasks', on: false })], 'Paid Tasks'],
      [[], 'an asset'],
    ] as const) {
      routes = answers({ 'GET /assets': { status: 200, body: { assets: list, reviewsRequired: false } }, 'GET /tasks?tab=active': none });
      await open('active');
      expect(empty(), needs).toEqual(['No Asset Is On', `Turn on ${needs} in Settings to start.`]);
    }
    // Tasks from before, with nothing on now: they are listed, New Task is not offered, and a line says why.
    routes = answers({ 'GET /assets': { status: 200, body: assets(asset({ on: false, canTurnOn: true })) } });
    await open('active');
    expect(rows()).toHaveLength(2);
    expect(ids.taskadd!.hidden).toBe(true);
    expect(body().with('gnote').map((e) => e.textContent)).toEqual(['Turn on the CI Watcher in Settings to run a new task.']);
  });

  it('loading, failed, signed out and an older runtime are each said in words, with a way on', async () => {
    run('openTasks()');
    expect(body().shown()).toContain('Loading…');
    await settle();
    for (const [a, words, buttons] of [
      [{ status: 503, body: { error: TASKS_SAY.down } }, ['Couldn’t Load Tasks', 'The runtime isn’t answering, so tasks can’t load.'], ['Try Again']],
      [{ status: 502, body: { error: TASKS_SAY.unreadable, ref: 'ref1' } }, ['Couldn’t Load Tasks', TASKS_SAY.unreadable], ['Try Again']],
      [{ status: 401, body: { error: 'unauthorized' } }, ['You’re Signed Out', 'Enter your access token in Settings to see tasks.'], ['Open Settings']],
      [{ status: 501, body: { error: TASKS_SAY.older } }, ['Couldn’t Load Tasks', 'This needs a newer runtime.'], ['Try Again']],
    ] as const) {
      for (const key of ['GET /assets', 'GET /tasks?tab=active']) {
        routes = answers({ [key]: a });
        await open('active');
        expect(empty(), `${key} ${a.status}`).toEqual(words);
        expect(body().buttons().filter((b) => b !== 'Active' && b !== 'Finished'), `${key} ${a.status}`).toEqual(buttons);
        expect(ids.taskadd!.hidden).toBe(true);
        plainScreen();
      }
    }
    // An older runtime: the header button goes too. Try Again reads it again.
    expect(ids.tasksbtn!.hidden).toBe(true);
    routes = answers();
    await click(body(), 'Try Again');
    expect(rows()).toHaveLength(2);
    expect(ids.tasksbtn!.hidden).toBe(false);
  });
});

describe('one task, open', () => {
  it('its sentence, its result marked as outside text, each check by name and state, and its details as labels and values', async () => {
    routes = answers({ [`GET /tasks/${T_WAIT}`]: { status: 200, body: { task: waitingView({ goalId: GOAL, dueAt: '2026-10-20T21:59:00.000Z' }) } } });
    await openTask(T_WAIT);
    expect(title()).toBe('Watch a CI Run');
    expect(ids.taskback!.hidden).toBe(false);
    expect(ids.taskadd!.hidden).toBe(true);
    expect(body().with('plead').map((e) => e.textContent)).toEqual(['It passed its checks and is waiting for you.']);
    expect(headers()).toEqual(['Result', 'Checks', 'Details']);
    const due = new Date('2026-10-20T21:59:00.000Z').toLocaleDateString([], { month: 'short', day: 'numeric' });
    expect(rows()).toEqual([
      ['', ['The run passed.'], ''],
      ['CI Run Passed', [], 'Passed'], ['Names Only Your Items', [], 'Passed'],
      ['About', [], 'wpf002/flint CI'], ['Runs On', [], 'CI Watcher'], ['Asked By', [], 'You'], ['Goal', [], 'Finish Building Flint'], ['Due', [], due], ['Chance It Passes', [], 'About Even · 50%'], ['Cost', [], 'No Cost'],
    ]);
    expect(tags()).toEqual(['Outside Text']);
    expect(body().with('gnote').map((e) => e.textContent)).toEqual(['Flint checked these by rule.']);
    expect(body().with('st').map((e) => e.className)).toEqual(['st ok', 'st ok']);
    expect(calls.at(-1)).toEqual({ url: `/goals/${GOAL}`, method: 'GET', body: undefined });
    plainScreen();
    ownWords([...headers(), ...rows().slice(3).map((r) => r[0]), ...foot().buttons()], [...body().with('gnote').map((e) => e.textContent), note()]);
  });

  it('before there is a result, and once one is gone: said, never left blank; a goal that cannot be read is not shown as an id', async () => {
    await openTask(T_OUT);
    expect(rows().slice(0, 3)).toEqual([['', ['There is no result yet.'], ''], ['CI Run Passed', [], 'Waiting'], ['Names Only Your Items', [], 'Waiting']]);
    expect(tags()).toEqual([]);
    expect(body().with('st').map((e) => e.className)).toEqual(['st off', 'st off']);
    expect(body().with('gnote')).toEqual([]);
    expect(rows().map((r) => r[0])).toContain('Goal');
    expect(rows().find((r) => r[0] === 'Goal')![2]).toBe('No Goal');
    expect(rows().find((r) => r[0] === 'Due')![2]).toBe('No Due Date');
    // Ended and cleared: no result, no checks.
    routes = answers({ [`GET /tasks/${T_DONE}`]: { status: 200, body: { task: view(T_DONE, { status: 'accepted', line: 'It was accepted, and its checks are no longer kept.', about: null, result: null, checks: [], checkedBy: 'rules', chance: null, goalId: GOAL, askedBy: 'flint', can: { cancel: false, accept: false, reject: false } }) } }, [`GET /goals/${GOAL}`]: { status: 404, body: { error: 'This goal no longer exists.', code: 'noGoal' } } });
    await openTask(T_DONE);
    expect(rows()).toEqual([['', ['It has no result to show.'], ''], ['', ['Its checks are no longer kept.'], ''], ['Runs On', [], 'CI Watcher'], ['Asked By', [], 'Flint'], ['Due', [], 'No Due Date'], ['Cost', [], 'No Cost']]);
    expect(body().with('gnote')).toEqual([]);
    expect(foot().hidden).toBe(true);
    plainScreen();
    // A task that ended before it was checked: its checks are not still "Waiting".
    routes = answers({ [`GET /tasks/${T_OUT}`]: { status: 200, body: { task: view(T_OUT, { status: 'failed', line: 'It ran out of time.', can: { cancel: false, accept: false, reject: false, again: true } }) } } });
    await openTask(T_OUT);
    expect(rows().slice(0, 3)).toEqual([['', ['It has no result to show.'], ''], ['CI Run Passed', [], 'Not Checked'], ['Names Only Your Items', [], 'Not Checked']]);
    expect(body().with('st').map((e) => e.className)).toEqual(['st off', 'st off']);
    // Its forecast is shown while there is something to forecast: an ended task says how it ended, not how likely that was.
    routes = answers();
    await openTask(T_RED);
    expect(VIEWS[T_RED]!.chance).toEqual({ likelihood: 'about_even', percent: 50 });
    expect(rows().map((r) => r[0])).not.toContain('Chance It Passes');
    // A failed check is said as failed; a check Will overruled says who decided; a model's check says so.
    for (const [checkedBy, line] of [['you', 'You decided it yourself, against its checks.'], ['model', 'The local model judged these.']] as const) {
      routes = answers({ [`GET /tasks/${T_RED}`]: { status: 200, body: { task: redView({ checkedBy }) } } });
      await openTask(T_RED);
      expect(rows().slice(1, 3).map((r) => r[2])).toEqual(['Failed', 'Passed']);
      expect(body().with('st').map((e) => e.className)).toEqual(['st down', 'st ok']);
      expect(body().with('gnote').map((e) => e.textContent)).toEqual([line]);
    }
  });

  it('what it cost: nothing, an amount, an estimate, or not known yet for one that costs money and has not ended', async () => {
    for (const [over, shown] of [
      [{ cost: null, costs: false }, 'No Cost'], [{ cost: { micros: 0, estimate: false }, costs: false }, 'No Cost'], [{ cost: { micros: 250_000, estimate: false }, costs: true }, '$0.25'],
      [{ cost: { micros: 12_500_000, estimate: true }, costs: true }, 'About $12.50'], [{ cost: { micros: 2_500, estimate: false }, costs: true }, '$0.0025'], [{ cost: null, costs: true }, 'Not Known Yet'],
    ] as const) {
      routes = answers({ [`GET /tasks/${T_OUT}`]: { status: 200, body: { task: view(T_OUT, over) } } });
      await openTask(T_OUT);
      expect(rows().find((r) => r[0] === 'Cost')![2], JSON.stringify(over)).toBe(shown);
    }
  });

  it('each button is there only when the runtime says it can be done now; Run Again is not offered by a runtime that does not say', async () => {
    const offered = async (can: Record<string, unknown>, cardId: string | null = null) => {
      routes = answers({ [`GET /tasks/${T_OUT}`]: { status: 200, body: { task: view(T_OUT, { can, card: cardId }) } } });
      await openTask(T_OUT);
      return foot().hidden ? [] : foot().buttons();
    };
    expect(await offered({ cancel: false, accept: false, reject: false, again: false })).toEqual([]);
    expect(await offered({ cancel: true, accept: false, reject: false, again: false })).toEqual(['Cancel Task']);
    expect(await offered({ cancel: false, accept: true, reject: false, again: false })).toEqual(['Accept Anyway']);
    expect(await offered({ cancel: false, accept: false, reject: true, again: false })).toEqual(['Reject Anyway']);
    expect(await offered({ cancel: false, accept: false, reject: false, again: true })).toEqual(['Run Again']);
    expect(await offered({ cancel: true, accept: true, reject: true, again: true })).toEqual(['Cancel Task', 'Reject Anyway', 'Accept Anyway', 'Run Again']);
    // An older runtime says nothing of Run Again, and anything that is not a plain yes is a no.
    expect(await offered({ cancel: false, accept: false, reject: false })).toEqual([]);
    expect(await offered({ cancel: 'yes', accept: 1, reject: {}, again: 'true' })).toEqual([]);
    // Its own card that waits is opened from here, and said.
    expect(await offered({ cancel: true, accept: false, reject: false, again: false }, 'prcancel01')).toEqual(['Cancel Task', 'Review Card']);
    expect(note()).toBe('A card is waiting for your approval.');
    expect(await offered({ cancel: false, accept: false, reject: false, again: false }, 'prcancel01')).toEqual(['Review Card']);
  });

  it('a task that is gone goes back to the list and says so; any other failure is said in place, with a way to try again', async () => {
    await open();
    run("taskOpen('tk0000000000000000')");
    await settle();
    expect(title()).toBe('Tasks');
    expect(rows()).toHaveLength(2);
    expect(said()).toEqual(['This task no longer exists.', 'res bad']);
    routes = answers({ [`GET /tasks/${T_OUT}`]: { status: 503, body: { error: TASKS_SAY.down } } });
    run(`taskOpen('${T_OUT}')`);
    await settle();
    expect(empty()).toEqual(['Couldn’t Load Tasks', 'The runtime isn’t answering, so tasks can’t load.']);
    expect(ids.taskback!.hidden).toBe(false);
    routes = answers();
    await click(body(), 'Try Again');
    expect(title()).toBe('Watch a CI Run');
    // Back goes to the list.
    run('taskBack()');
    await settle();
    expect(title()).toBe('Tasks');
    expect(rows()).toHaveLength(2);
  });

  it('text only: a title, a sentence and a result that look like HTML are shown as they are written', async () => {
    const evil = '<img src=x onerror=alert(1)>';
    routes = answers({ [`GET /tasks/${T_OUT}`]: { status: 200, body: { task: view(T_OUT, { title: `Watch ${evil}`, line: `It ${evil}.`, about: evil, result: `Result ${evil}`, checks: [{ id: 'a1', name: evil, state: 'passed' }], runsOn: evil }) } } });
    await openTask(T_OUT);
    expect(title()).toBe(`Watch ${evil}`);
    expect(body().shown()).toContain(`Result ${evil}`);
    expect(rows().some((r) => r[0] === evil && r[2] === 'Passed')).toBe(true);
    // (The fake DOM's innerHTML setter throws: nothing here ever sets it.)
    expect(tasksJs).not.toMatch(/innerHTML|insertAdjacentHTML|outerHTML|document\.write/);
  });
});

describe('a card, shown and signed here', () => {
  it('Review Card reads the card back from the Approvals list and shows it in that panel’s words, with everything it holds behind Show Details', async () => {
    await openTask(T_WAIT);
    calls = [];
    await click(foot(), 'Review Card');
    // The card is read back, then its task's name is looked up, before anything is drawn.
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(['GET /proposals', `GET /tasks/${T_WAIT}`]);
    expect(title()).toBe('Accept a Task Result');
    expect(title()).toBe(ACTION_WORDS['task.check_bar']);
    expect(body().with('plead').map((e) => e.textContent)).toEqual(['It passed 2 of 2 checks.']);
    const expires = new Date('2026-10-27T18:00:00.000Z').toLocaleDateString([], { month: 'short', day: 'numeric' });
    expect(rows()).toEqual([['Task', [], 'Watch a CI Run · wpf002/flint CI'], ['Checked By', [], 'Rules'], ['Expires', [], expires]]);
    // The task's name is looked up, not signed: its row says so beside the value, and no other row does.
    const face = body().all().find((e) => e.id === 'taskcardfacts')!;
    expect(face.children.map((r) => r.children.filter((c) => c.className === 'looked').map((c) => c.textContent))).toEqual([['Looked Up'], [], []]);
    expect(face.children[0]!.val!.textContent).toBe('Watch a CI Run · wpf002/flint CI');
    // The title and the sentence under it are the card's own words.
    expect(`${title()} ${body().with('plead')[0]!.textContent}`).not.toMatch(/wpf002|·/);
    // A card that may share a prompt carries no mark.
    expect(body().all().find((e) => e.id === 'taskcardmark')).toBeUndefined();
    expect(foot().buttons()).toEqual(['Not Now', 'Approve with Touch ID']);
    // Nothing but words on its face.
    plainScreen();
    // Show Details: what it would do, the fields it holds under labels, and its ids under REFERENCES. Nothing is left out.
    const details = body().all().find((e) => e.id === 'taskcarddetails')!;
    expect(details.hidden).toBe(true);
    const toggle = body().button('Show Details');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    toggle.onclick!();
    expect(details.hidden).toBe(false);
    expect(body().buttons()).toContain('Hide Details');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const text = details.textContent;
    expect(text).toContain('Approving accepts this result.');
    expect(text).toContain('It passed 2 of 2 checks.');
    expect(details.all().filter((e) => e.tagName === 'h4').map((e) => e.textContent)).toEqual(['DETAILS', 'REFERENCES']);
    for (const signedValue of [T_WAIT, 'out:0123456789abcdef', 'flint:rule']) expect(text, signedValue).toContain(signedValue);
    // Only what is signed is here, with one fixed sentence about the row above that was looked up.
    expect(details.children.filter((e) => e.className === 'lookedsay').map((e) => e.textContent)).toEqual(['The task’s name above is looked up, not part of what you sign.']);
    expect(text).not.toMatch(/wpf002/);
    ownWords([], ['The task’s name above is looked up, not part of what you sign.']);
    expect(details.all().some((e) => e.tagName === 'pre')).toBe(false);
    expect(text).not.toMatch(/[{}"[\]]/);
    toggle.onclick!();
    expect(details.hidden).toBe(true);
    expect(body().buttons()).toContain('Show Details');
  });

  it('Approve signs exactly the args the list holds, with a fresh touch and a plain prompt, then goes back to the task and says what happened', async () => {
    await openTask(T_WAIT);
    await click(foot(), 'Review Card');
    calls = [];
    let finish!: (v: unknown) => void;
    signAnswer = () => new Promise((r) => (finish = r));
    foot().button('Approve with Touch ID').onclick!();
    await settle();
    // While the prompt is up: the buttons are off, and the footer says it is waiting. A second press does nothing.
    expect(said()).toEqual(['Flint is waiting for your approval.', 'res wait']);
    expect(foot().with('btn').map((b) => b.disabled)).toEqual([true, true]);
    foot().button('Approve with Touch ID').onclick!();
    foot().button('Not Now').onclick!();
    await settle();
    expect(signed).toHaveLength(1);
    expect(title()).toBe('Accept a Task Result');
    const [id, o] = signed[0]!;
    expect(id).toBe('praccept01');
    expect(o).toEqual({ fresh: true, reason: 'accept this result', args: CARDS.accept.args });
    // (Read through JSON: the page's objects are another realm's.)
    expect(digestOf(JSON.parse(JSON.stringify(o.args)) as Record<string, unknown>)).toBe(digestOf(CARDS.accept.args as Record<string, unknown>));
    finish({ action: { status: 'done' } });
    await settle();
    // It ran: the task is read again, and the footer says so.
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([`GET /tasks/${T_WAIT}`]);
    expect(title()).toBe('Watch a CI Run');
    expect(said()).toEqual(['You accepted its result.', 'res ok']);
    expect(posts()).toEqual([]);
  });

  it('a prompt that is dismissed, a card approved that has not run, and one that failed are each said, and the card stays', async () => {
    for (const [answer, words] of [
      // (A prompt he dismissed is said as that, the same sentence wherever a card is signed: never "Cancelled.", which on a card that cancels a task would read as done.)
      [() => Promise.reject(new Error('not confirmed')), ['You dismissed the prompt. The card is waiting in Approvals.', 'res bad']],
      [() => Promise.reject(Object.assign(new Error('x'), { name: 'NotAllowedError' })), ['You dismissed the prompt. The card is waiting in Approvals.', 'res bad']],
      [async () => ({ action: { status: 'approved' } }), ['Approved. It hasn’t run yet.', 'res bad']],
      [async () => ({ action: { status: 'failed', error: 'Its asset is off. Turn it on in Settings.' } }), ['Its asset is off. Turn it on in Settings.', 'res bad']],
      [async () => ({ action: { status: 'failed' } }), ['It failed.', 'res bad']],
      [() => Promise.reject(new Error('Flint didn’t answer. Try again.')), ['Flint didn’t answer. Try again.', 'res bad']],
    ] as const) {
      await openTask(T_WAIT);
      await click(foot(), 'Review Card');
      signAnswer = answer as () => Promise<unknown>;
      await click(foot(), 'Approve with Touch ID');
      expect(said(), words[0]).toEqual(words);
      expect(title()).toBe('Accept a Task Result');
      // The buttons are back: he can try again, or leave it for later.
      expect(foot().with('btn').map((b) => b.disabled)).toEqual([false, false]);
    }
    // Not Now leaves it in Approvals and goes back to the task; Back does the same without a word.
    await click(foot(), 'Not Now');
    expect(title()).toBe('Watch a CI Run');
    expect(said()).toEqual(['It’s waiting in Approvals.', 'res ok']);
    await click(foot(), 'Review Card');
    run('taskBack()');
    await settle();
    expect(title()).toBe('Watch a CI Run');
    expect(said()).toBeNull();
  });

  it('only a waiting card about a task or an asset is ever shown to sign: one that was decided, one of another kind, or none at all is not', async () => {
    const lists: Array<[string, unknown[]]> = [
      ['gone', []],
      ['already approved', [{ ...CARDS.accept, status: 'approved' }]],
      ['rejected', [{ ...CARDS.accept, status: 'rejected' }]],
      ['another kind of card under that id', [{ ...CARDS.accept, fullName: 'mcp:shop.buy', args: { amount: 400 } }]],
      ['a goal card under that id', [{ ...CARDS.accept, fullName: 'goal.abandon', kind: 'goal', mcp: false, args: { goalId: GOAL, goalTitle: 'Finish Building Flint' } }]],
      ['another card', [CARDS.cancel]],
      // A tool on a connected server called "task", with a tool called "check_bar": the same name, and not a task's card.
      ['a tool’s card under a task card’s name, by the server’s mark', [{ ...CARDS.accept, kind: 'tool_call', mcp: true, origin: 'chat:c1' }]],
      ['a tool’s card under a task card’s name, by its kind', [{ ...CARDS.accept, kind: 'tool_call' }]],
      ['a card of that name with no kind', [{ ...CARDS.accept, kind: undefined }]],
      ['a tool’s card marked, whatever kind it claims', [{ ...CARDS.accept, mcp: true }]],
    ];
    for (const [why, proposals] of lists) {
      routes = answers({ 'GET /proposals': { status: 200, body: { proposals, signed: true } } });
      await openTask(T_WAIT);
      await click(foot(), 'Review Card');
      // Back on the task, which says why; there is nothing to approve.
      expect(title(), why).toBe('Watch a CI Run');
      expect(said(), why).toEqual(['That card is no longer waiting.', 'res bad']);
      expect(foot().buttons(), why).not.toContain('Approve with Touch ID');
    }
    expect(signed).toEqual([]);
    // The runtime is down: said as that, never as a card that is gone.
    routes = answers({ 'GET /proposals': { status: 200, body: { proposals: [], runtime: 'down', signed: true } } });
    await openTask(T_WAIT);
    await click(foot(), 'Review Card');
    expect(empty()).toEqual(['Couldn’t Load the Card', 'The runtime isn’t answering, so the card can’t load.']);
    expect(body().buttons()).toEqual(['Try Again']);
    routes = answers({ 'GET /proposals': { status: 503, body: { error: 'x' } } });
    await click(body(), 'Try Again');
    expect(empty()![0]).toBe('Couldn’t Load Tasks');
    routes = answers();
    await click(body(), 'Try Again');
    expect(title()).toBe('Accept a Task Result');
    expect(signed).toEqual([]);
  });

  it('a device without an approval key is told so and sent to Settings; nothing is signed', async () => {
    keyed = false;
    await openTask(T_WAIT);
    await click(foot(), 'Review Card');
    expect(title()).toBe('Accept a Task Result');
    expect(note()).toBe('This device needs an approval key.');
    expect(foot().buttons()).toEqual(['Open Settings']);
    await click(foot(), 'Open Settings');
    expect(panels).toMatchObject({ tasks: false, settings: true });
    expect(signed).toEqual([]);
  });

  it('an approval that lands after Will has gone elsewhere does not pull him back', async () => {
    await openTask(T_WAIT);
    await click(foot(), 'Review Card');
    let finish!: (v: unknown) => void;
    signAnswer = () => new Promise((r) => (finish = r));
    foot().button('Approve with Touch ID').onclick!();
    await settle();
    run('closeTasks()');
    await settle();
    calls = [];
    finish({ action: { status: 'done' } });
    await settle();
    expect(panels.tasks).toBe(false);
    expect(body().shown()).toBe('');
    expect(calls.filter((c) => c.url.startsWith('/tasks'))).toEqual([]);
    // It went through: there is nothing to keep for its card. The header is read again.
    expect(run('JSON.stringify(APPR.said||{})')).toBe('{}');
    expect(calls.map((c) => c.url)).toEqual(['/proposals']);
  });

  it('closing the panel while the prompt is up does not lose what the approval said: it is kept for the card, shown on it in Approvals, and the lists are read again', async () => {
    const outcomes: Array<[string, () => void, string]> = [];
    for (const [what, settleIt, say] of [
      ['dismissed', (no: (e: Error) => void) => no(new Error('not confirmed')), 'You dismissed the prompt. The card is waiting in Approvals.'],
      ['failed', (_no: (e: Error) => void, ok: (v: unknown) => void) => ok({ action: { status: 'failed', error: 'Its asset is off. Turn it on in Settings.' } }), 'Its asset is off. Turn it on in Settings.'],
      ['approved, not run', (_no: (e: Error) => void, ok: (v: unknown) => void) => ok({ action: { status: 'approved' } }), 'Approved. It hasn’t run yet.'],
    ] as const) {
      run('APPR.said={}');
      await openTask(T_WAIT);
      await click(foot(), 'Review Card');
      let ok!: (v: unknown) => void;
      let no!: (e: Error) => void;
      signAnswer = () => new Promise((y, n) => ((ok = y), (no = n)));
      foot().button('Approve with Touch ID').onclick!();
      await settle();
      run('closeTasks()');
      await settle();
      calls = [];
      settleIt(no, ok);
      await settle();
      outcomes.push([what, () => {}, say]);
      // Kept for its card, by the card's id. Nothing is drawn in the panel he closed, and it stays closed.
      expect(JSON.parse(run('JSON.stringify(APPR.said)') as string), what).toEqual({ praccept01: [say, 'bad'] });
      expect(panels.tasks, what).toBe(false);
      expect(body().shown(), what).toBe('');
      // The header (the badge and the dots) is read again; no task is.
      expect(calls.map((c) => c.url), what).toEqual(['/proposals']);
      // In Approvals, the card says it.
      run('loadApprovals()');
      await settle();
      const waiting = ids.apprlist!.all().find((e) => e.getAttribute('data-id') === 'praccept01')!;
      expect(waiting.shown(), what).toContain(say);
      const others = ids.apprlist!.all().filter((e) => e.getAttribute('data-id') && e.getAttribute('data-id') !== 'praccept01');
      expect(others.length).toBeGreaterThan(3);
      for (const o of others) expect(o.shown(), what).not.toContain(say);
    }
    expect(outcomes).toHaveLength(3);

    // Approvals is the panel that is open when it settles: its list is read again there and then.
    run('APPR.said={}');
    await openTask(T_WAIT);
    await click(foot(), 'Review Card');
    let no!: (e: Error) => void;
    signAnswer = () => new Promise((_y, n) => (no = n));
    foot().button('Approve with Touch ID').onclick!();
    await settle();
    run("closeTasks();showPanel('approvals',true)");
    await settle();
    calls = [];
    no(new Error('not confirmed'));
    await settle();
    expect(calls.filter((c) => c.url === '/proposals')).toHaveLength(2);
    expect(ids.apprlist!.all().find((e) => e.getAttribute('data-id') === 'praccept01')!.shown()).toContain('You dismissed the prompt. The card is waiting in Approvals.');
  });

  it('he went back to the task, or to the list, with the prompt up: what the approval said is told where he is', async () => {
    // Back to the task the card was about: it is read again, and its footer says it.
    await openTask(T_WAIT);
    await click(foot(), 'Review Card');
    let no!: (e: Error) => void;
    signAnswer = () => new Promise((_y, n) => (no = n));
    foot().button('Approve with Touch ID').onclick!();
    await settle();
    run('taskBack()');
    await settle();
    expect(title()).toBe('Watch a CI Run');
    calls = [];
    no(new Error('not confirmed'));
    await settle();
    expect(calls.map((c) => c.url)).toEqual(expect.arrayContaining([`/tasks/${T_WAIT}`, '/proposals']));
    expect(title()).toBe('Watch a CI Run');
    expect(said()).toEqual(['You dismissed the prompt. The card is waiting in Approvals.', 'res bad']);
    // To the list: it is read again, and says it; one that went through says what happened.
    await click(foot(), 'Review Card');
    let ok!: (v: unknown) => void;
    signAnswer = () => new Promise((y) => (ok = y));
    foot().button('Approve with Touch ID').onclick!();
    await settle();
    run("taskTab('active')");
    await settle();
    ok({ action: { status: 'done' } });
    await settle();
    expect(title()).toBe('Tasks');
    expect(said()).toEqual(['You accepted its result.', 'res ok']);
    expect(rows()).toHaveLength(2);
    // On another task: nothing is written into it. (What was said is kept for the card, in Approvals.)
    run('APPR.said={}');
    await openTask(T_WAIT);
    await click(foot(), 'Review Card');
    signAnswer = () => new Promise((_y, n) => (no = n));
    foot().button('Approve with Touch ID').onclick!();
    await settle();
    run(`taskOpen('${T_OUT}')`);
    await settle();
    no(new Error('not confirmed'));
    await settle();
    expect(said()).toBeNull();
    expect(JSON.parse(run('JSON.stringify(APPR.said)') as string)).toEqual({ praccept01: ['You dismissed the prompt. The card is waiting in Approvals.', 'bad'] });
  });

  it('the card’s mark is the Approvals panel’s own: outside text first, then what cannot be undone, then that it asks on its own', async () => {
    const mark = () => body().all().find((e) => e.id === 'taskcardmark');
    const shown = async (p: Record<string, unknown>) => {
      routes = answers({ 'GET /proposals': { status: 200, body: { proposals: [p], signed: true } } });
      await openTask(T_WAIT);
      await click(foot(), 'Review Card');
      expect(foot().buttons()).toEqual(['Not Now', 'Approve with Touch ID']);
      return mark();
    };
    for (const [p, says] of [
      [{ ...CARDS.accept, tainted: true }, 'Outside Text'],
      [{ ...CARDS.accept, tainted: true, destructive: true, consequential: true }, 'Outside Text'],
      [{ ...CARDS.accept, destructive: true }, 'Can’t Be Undone'],
      [{ ...CARDS.accept, id: 'praccept01', fullName: 'task.bar_override', args: { taskId: T_WAIT, to: 'rejected' }, consequential: true }, 'Asks on Its Own'],
      [{ ...CARDS.dispatch, id: 'praccept01', cost: { micros: 250_000 }, args: dispatchArgs(T_WAIT, { estCostMicros: 250_000 }) }, 'Asks on Its Own'],
    ] as const) {
      const m = await shown(p);
      expect(m, says).toBeTruthy();
      expect(m!.className).toBe('tmark');
      // One element, the same the Approvals panel draws on its own card: a dot and the words.
      expect(m!.children.map((c) => [c.tagName, c.className, c.textContent])).toEqual([['span', 'outside', says]]);
      expect(m!.children[0]!.children[0]!.tagName).toBe('i');
      expect(run(`apprMark(${JSON.stringify(p)}).textContent`)).toBe(says);
      // It sits under the card's sentence, above its facts.
      const order = body().children.map((c) => c.id || c.className);
      expect(order.indexOf('taskcardmark')).toBe(order.indexOf('plead') + 1);
      expect(order.indexOf('taskcardfacts')).toBe(order.indexOf('taskcardmark') + 1);
    }
    expect(await shown(CARDS.accept)).toBeUndefined();
    expect(run(`apprMark(${JSON.stringify(CARDS.accept)})`)).toBeNull();
    expect(html).toMatch(/\.tmark\{/);
  });

  it('a card with a review shows it as the Approvals panel does, and Approve names it; one that must have its review first can’t be approved yet (P5)', async () => {
    const review = {
      id: 'cmreview0000000000000001', verdict: 'proceed_with_changes', confidence: 0.55, agreed: false, findings: ['outside_text'], reasonCodes: ['outside_text_steers'],
      attack: 'The run’s log could be steering it.', defense: 'It only accepts a result.', verdictReason: 'Read the log first.', shadow: true, textPurged: false, createdAt: '2026-10-17T15:00:00.000Z',
    };
    const show = async (p: Record<string, unknown>) => {
      routes = answers({ 'GET /proposals': { status: 200, body: { proposals: [p], signed: true } } });
      await openTask(T_WAIT);
      await click(foot(), 'Review Card');
    };
    await show({ ...CARDS.accept, tainted: true, reviewRequired: true, reviewFirst: false, review });
    const face = body().shown();
    expect(face).toContain('Flint’s Review');
    expect(face).toContain('Verdict Go Ahead with Changes');
    expect(face).toContain('How Sure 55%');
    expect(face).toContain('Its two passes didn’t agree, so it kept the more careful verdict.');
    expect(face).not.toContain(review.attack);
    // Under its facts, before Show Details; the model's words wait behind it, marked.
    const order = body().children.map((c) => c.id || c.className);
    expect(order.indexOf('review treview')).toBe(order.indexOf('taskcardfacts') + 1);
    const details = body().all().find((e) => e.id === 'taskcarddetails')!;
    expect(details.hidden).toBe(true);
    body().button('Show Details').onclick!();
    expect(details.hidden).toBe(false);
    expect(details.shown()).toContain(`The Case Against ${review.attack}`);
    expect(details.shown()).toContain('Outside Text');
    foot().button('Approve with Touch ID').onclick!();
    await settle();
    expect(signed[0]).toEqual(['praccept01', { fresh: true, reason: 'accept this result', args: CARDS.accept.args, reviewId: review.id }]);
    // Waiting for its review: said, and Approve is off. Not Now still goes back.
    signed = [];
    await show({ ...CARDS.accept, tainted: true, reviewRequired: true, reviewFirst: true, review: null });
    expect(body().shown()).toContain(REVIEW_SAYS.waiting);
    const ok = foot().button('Approve with Touch ID');
    expect(ok.disabled).toBe(true);
    ok.onclick!();
    await settle();
    expect(signed).toEqual([]);
  });

  it('a card shown here waits a short while for its task’s name and is drawn once: a name that lands late, or after he has gone elsewhere, never draws it', async () => {
    const timers: Array<[() => void, number]> = [];
    ctx.setTimeout = (fn: () => void, ms: number) => timers.push([fn, ms]);
    const holds: Array<{ ps: Array<{ id: string }>; done: (n: number) => void }> = [];
    ctx.HOLD = (ps: Array<{ id: string }>, done: (n: number) => void) => void holds.push({ ps, done });
    run('taskNames=function(ps,done){HOLD(ps,done);}');
    const know = () => run(`APPR_TASKS['${T_WAIT}']={title:'Watch a CI Run',about:'wpf002/flint CI'}`);
    const deadline = () => timers.filter((t) => t[1] === 600).at(-1)![0];
    // (Opening a task keeps its name. Here the card is reached with nothing known, as from Settings or after a reload.)
    const review = async () => {
      await openTask(T_WAIT);
      run(`delete APPR_TASKS['${T_WAIT}']`);
      await click(foot(), 'Review Card');
    };
    await review();
    // The card is read back and its name asked for: nothing is drawn yet but the wait, with its deadline.
    expect(holds.map((h) => h.ps.map((p) => p.id))).toEqual([['praccept01']]);
    expect(title()).toBe('Tasks');
    expect(body().shown()).toBe('Loading…');
    expect(run('TASK_NAMES_MS')).toBe(600);
    expect(timers.filter((t) => t[1] === 600)).toHaveLength(1);
    // The deadline passes: the card is drawn without the name.
    deadline()();
    expect(title()).toBe('Accept a Task Result');
    expect(rows().map((r) => r[0])).toEqual(['Checked By', 'Expires']);
    const drawn = body().children[0];
    // The name lands late: the card on screen is not drawn again, and nothing on it moves.
    know();
    holds[0]!.done(1);
    expect(body().children[0]).toBe(drawn);
    expect(screen()).not.toMatch(/Looked Up|wpf002/);
    // In time: drawn with its looked-up row, and the deadline afterwards draws nothing more.
    await review();
    know();
    holds[1]!.done(1);
    expect(rows().map((r) => r[0])).toEqual(['Task', 'Checked By', 'Expires']);
    const withName = body().children[0];
    deadline()();
    holds[1]!.done(1);
    expect(body().children[0]).toBe(withName);
    // He goes elsewhere before the name lands: neither the name nor the deadline draws the card over where he is.
    await review();
    run("taskTab('active')");
    await settle();
    expect(title()).toBe('Tasks');
    const list = body().children[0];
    holds[2]!.done(1);
    deadline()();
    expect(title()).toBe('Tasks');
    expect(body().children[0]).toBe(list);
    expect(rows()).toHaveLength(2);
    expect(foot().buttons()).not.toContain('Approve with Touch ID');
    // The panel closed meanwhile: the same.
    await review();
    run('closeTasks()');
    holds[3]!.done(1);
    deadline()();
    expect(body().shown()).toBe('');
    expect(signed).toEqual([]);
  });

  it('once tasks are known to be off nothing here writes: each button’s function returns before it sends, and says the runtime’s sentence', async () => {
    await openTask(T_RED);
    // The page's own look finds tasks switched off while the task is still on screen.
    routes = answers({ 'GET /assets': OFF });
    run('tasksProbe()');
    await settle();
    expect(run('taskIsOff()')).toBe(true);
    expect(ids.tasksbtn!.hidden).toBe(true);
    calls = [];
    const t = JSON.stringify(redView());
    const writes: Array<[string, string]> = [
      ['Accept Anyway', `taskFile(${t},'accept',[])`], ['Reject Anyway', `taskFile(${t},'reject',[])`], ['Cancel Task', `taskFile(${t},'cancel',[])`],
      ['Run Again', `TASKS.again={id:'${T_RED}',key:gDraftKey()};taskAgain(${t},[])`],
      ['Create Task', `TASKS.form={draftKey:gDraftKey(),template:'watch_ci',item:'${ITEM}',goal:'',due:''};taskCreate({},[])`],
      ['Approve', `taskApprove(${JSON.stringify(CARDS.accept)},[],{back:function(){},done:function(){}})`],
    ];
    for (const [what, code] of writes) {
      run('taskMsg("")');
      run(code);
      await settle();
      expect(calls, what).toEqual([]);
      expect(signed, what).toEqual([]);
      expect(run('TASKS.busy'), what).toBe(false);
      // The button that did nothing says why, in the runtime's own sentence.
      expect(said(), what).toEqual([TASK_SAYS.off, 'res bad']);
    }
    // The buttons on screen are those functions: pressed, they send nothing either.
    for (const b of ['Accept Anyway', 'Run Again']) await click(foot(), b);
    expect(calls).toEqual([]);
    // Settings > Assets: Turn On and Turn Off the same, with the sentence under the list.
    run('TASKS.off=false');
    routes = answers();
    run('openSettings();loadAssets()');
    await settle();
    routes = answers({ 'GET /assets': OFF });
    run('tasksProbe()');
    await settle();
    calls = [];
    run(`assetOn(${JSON.stringify(asset({ on: false, canTurnOn: true }))},null)`);
    run(`assetOff(${JSON.stringify(asset())},[])`);
    await settle();
    expect(calls).toEqual([]);
    expect(ids.setassets!.visible().find((e) => e.id === 'assetsmsg')?.textContent).toBe(TASK_SAYS.off);
    // The runtime answers again: the button is back, and they write again.
    routes = answers();
    run('tasksProbe()');
    await settle();
    expect(run('taskIsOff()')).toBe(false);
    expect(run('TASKS.offSays')).toBe('');
    expect(ids.tasksbtn!.hidden).toBe(false);
    await openTask(T_RED);
    calls = [];
    await click(foot(), 'Accept Anyway');
    expect(posts().map((c) => c.url)).toEqual([`/tasks/${T_RED}/accept`]);
  });
});

describe('Cancel Task, Accept Anyway, Reject Anyway, Run Again', () => {
  it('Cancel Task asks in place first; one that has not gone out is cancelled there and then, with one unsigned POST', async () => {
    routes = answers({ [`POST /tasks/${T_NEW}/cancel`]: { status: 200, body: { ok: true } } });
    await openTask(T_NEW);
    calls = [];
    await click(foot(), 'Cancel Task');
    // Asked first: nothing is sent yet.
    expect(calls).toEqual([]);
    expect(foot().with('gconfirm').map((e) => e.children.map((c) => c.textContent))).toEqual([['Cancel This Task', 'Nothing has run, and its card is withdrawn.']]);
    // The button that goes through with it comes first; Keep Task takes the end of the row, and the cursor.
    expect(foot().buttons()).toEqual(['Cancel Task', 'Keep Task']);
    expect(foot().with('btn').map((b) => [b.textContent, b.className])).toEqual([['Cancel Task', 'btn pri'], ['Keep Task', 'btn']]);
    expect(focused?.textContent).toBe('Keep Task');
    // Keep Task puts the buttons back.
    await click(foot(), 'Keep Task');
    expect(foot().buttons()).toEqual(['Cancel Task', 'Review Card']);
    expect(calls).toEqual([]);
    // A second tap right on the heels of the first is the same tap: it cancels nothing.
    await click(foot(), 'Cancel Task');
    clock += 399;
    await click(foot(), 'Cancel Task');
    expect(calls).toEqual([]);
    expect(foot().with('gconfirm')).toHaveLength(1);
    expect(run('TASK_ARM_MS')).toBe(400);
    clock += 1;
    foot().button('Cancel Task').onclick!();
    foot().button('Cancel Task').onclick!();
    await settle();
    expect(posts()).toEqual([{ url: `/tasks/${T_NEW}/cancel`, method: 'POST', body: {} }]);
    expect(EmptyBody.safeParse(posts()[0]!.body).success).toBe(true);
    expect(said()).toEqual(['You cancelled it.', 'res ok']);
    expect(signed).toEqual([]);
  });

  it('one that has gone out gets its card, shown here to sign: Cancel a Task', async () => {
    await openTask(T_OUT);
    await click(foot(), 'Cancel Task');
    expect(foot().with('gconfirm')[0]!.children[1]!.textContent).toBe('Flint files a card to stop it, for you to approve.');
    clock += 400;
    await click(foot(), 'Cancel Task');
    expect(posts()).toEqual([{ url: `/tasks/${T_OUT}/cancel`, method: 'POST', body: {} }]);
    expect(title()).toBe('Cancel a Task');
    expect(body().with('plead')[0]!.textContent).toBe('Flint stops working on it.');
    expect(rows()[0]).toEqual(['Task', [], 'Watch a CI Run · wpf002/flint CI']);
    await click(foot(), 'Approve with Touch ID');
    expect(signed).toEqual([['prcancel01', { fresh: true, reason: 'cancel this task', args: CARDS.cancel.args }]]);
    expect(title()).toBe('Watch a CI Run');
    expect(said()).toEqual(['You cancelled it.', 'res ok']);
  });

  it('Accept Anyway and Reject Anyway file their cards, which say which way it ends; each is signed with a fresh touch', async () => {
    await openTask(T_RED);
    calls = [];
    await click(foot(), 'Accept Anyway');
    expect(posts()).toEqual([{ url: `/tasks/${T_RED}/accept`, method: 'POST', body: {} }]);
    expect(title()).toBe('Accept a Result Anyway');
    expect(body().with('plead')[0]!.textContent).toBe('It ends as accepted, against Flint’s checks.');
    await click(foot(), 'Approve with Touch ID');
    expect(signed.at(-1)).toEqual(['proverride1', { fresh: true, reason: 'accept this result against its checks', args: { taskId: T_RED, to: 'accepted' } }]);
    expect(said()).toEqual(['You accepted it.', 'res ok']);
    await openTask(T_WAIT);
    calls = [];
    await click(foot(), 'Reject Anyway');
    expect(posts()).toEqual([{ url: `/tasks/${T_WAIT}/reject`, method: 'POST', body: {} }]);
    expect(title()).toBe('Reject a Result Anyway');
    expect(body().with('plead')[0]!.textContent).toBe('It ends as rejected, against Flint’s checks.');
    await click(foot(), 'Approve with Touch ID');
    expect(signed.at(-1)).toEqual(['prreject001', { fresh: true, reason: 'reject this result against its checks', args: { taskId: T_WAIT, to: 'rejected' } }]);
    expect(said()).toEqual(['You rejected it.', 'res ok']);
  });

  it('Run Again sends a key of its own and nothing else, the same key if it is pressed again, and shows the new task’s card', async () => {
    await openTask(T_RED);
    calls = [];
    // The runtime does not answer in time: Flint isn't sure, and the buttons come back.
    routes = answers({ [`POST /tasks/${T_RED}/again`]: { status: 504, body: { error: TASKS_SAY.unsure } } });
    await click(foot(), 'Run Again');
    expect(said()).toEqual([TASKS_SAY.unsure, 'res bad']);
    expect(foot().with('btn').map((b) => b.disabled)).toEqual([false, false]);
    routes = answers();
    foot().button('Run Again').onclick!();
    foot().button('Run Again').onclick!();
    await settle();
    const sent = posts();
    expect(sent.map((c) => c.url)).toEqual([`/tasks/${T_RED}/again`, `/tasks/${T_RED}/again`]);
    const key = (sent[0]!.body as { draftKey: string }).draftKey;
    expect(TaskAgainBody.safeParse(sent[0]!.body).success).toBe(true);
    expect(DraftKey.safeParse(key).success).toBe(true);
    // Pressed again after "not sure": the same key, so it is the same new task.
    expect(sent[1]!.body).toEqual({ draftKey: key });
    expect(title()).toBe('Watch a CI Run');
    expect(body().with('plead')[0]!.textContent).toBe('Flint waits for the run and tells you how it ended.');
    expect(rows().map((r) => r[0])).toEqual(['CI Run', 'Due', 'Cost']);
    await click(foot(), 'Approve with Touch ID');
    expect(signed).toEqual([['pragain0001', { fresh: true, reason: 'run this task', args: CARDS.again.args }]]);
    // It goes on to the NEW task, not the one it was made from.
    expect(calls.at(-1)).toEqual({ url: `/tasks/${T_NEW}`, method: 'GET', body: undefined });
    expect(said()).toEqual(['Flint started it.', 'res ok']);
    // Another task opened afterwards has a key of its own.
    await openTask(T_DONE);
    calls = [];
    await click(foot(), 'Run Again');
    expect((posts()[0]!.body as { draftKey: string }).draftKey).not.toBe(key);
  });

  it('Run Again that the runtime refuses made nothing under its key: the key is dropped, and the next press starts clean with a key of its own', async () => {
    const keyOf = (c: Call) => (c.body as { draftKey: string }).draftKey;
    await openTask(T_RED);
    calls = [];
    // A rule of his forbids the card: said in a sentence of its own, never as the rule's stored name.
    routes = answers({ [`POST /tasks/${T_RED}/again`]: { status: 409, body: { error: TASK_SAYS.ruleForbids, code: 'ruleForbids' } } });
    await click(foot(), 'Run Again');
    expect(said()).toEqual(['A rule you set doesn’t allow this.', 'res bad']);
    expect(title()).toBe('Watch a CI Run');
    // He changes the rule and presses again: a new key, so a new task, not the answer to the one that was refused.
    routes = answers();
    await click(foot(), 'Run Again');
    const sent = posts().filter((c) => c.url.endsWith('/again'));
    expect(sent).toHaveLength(2);
    expect(DraftKey.safeParse(keyOf(sent[1]!)).success).toBe(true);
    expect(keyOf(sent[1]!)).not.toBe(keyOf(sent[0]!));
    expect(foot().buttons()).toContain('Approve with Touch ID');
    // Every refusal by its code does the same; "not sure" (no code: it may have gone through) keeps the key.
    for (const [status, code, say] of [[409, 'assetOff', TASK_SAYS.assetOff], [409, 'itemEnded', TASK_SAYS.itemEnded], [409, 'goalEnded', TASK_SAYS.goalEnded], [409, 'flintAsked', TASK_SAYS.flintAsked], [409, 'notAllowed', TASK_SAYS.notAllowed]] as const) {
      routes = answers();
      await openTask(T_RED);
      calls = [];
      routes = answers({ [`POST /tasks/${T_RED}/again`]: { status: 504, body: { error: TASKS_SAY.unsure } } });
      await click(foot(), 'Run Again');
      routes = answers({ [`POST /tasks/${T_RED}/again`]: { status, body: { error: say, code } } });
      await click(foot(), 'Run Again');
      expect(said(), code).toEqual([say, 'res bad']);
      routes = answers({ [`POST /tasks/${T_RED}/again`]: { status: 504, body: { error: TASKS_SAY.unsure } } });
      await click(foot(), 'Run Again');
      const keys = posts().filter((c) => c.url.endsWith('/again')).map(keyOf);
      expect(keys, code).toHaveLength(3);
      expect(keys[1], code).toBe(keys[0]);
      expect(keys[2], code).not.toBe(keys[0]);
    }
  });

  it('a refusal by its code means the task on screen is stale: it is read again and the footer says why; a task that is gone goes back to the list', async () => {
    for (const [verb, button, status, code, say] of [
      ['accept', 'Accept Anyway', 409, 'decided', TASK_SAYS.decided], ['accept', 'Accept Anyway', 400, 'notOverride', TASK_SAYS.notOverride],
      ['again', 'Run Again', 409, 'detailsGone', TASK_SAYS.detailsGone], ['again', 'Run Again', 409, 'assetOff', TASK_SAYS.assetOff], ['accept', 'Accept Anyway', 409, 'status.accepted', TASK_STATUS_SAYS.accepted],
    ] as const) {
      routes = answers();
      await openTask(T_RED);
      routes = answers({ [`POST /tasks/${T_RED}/${verb}`]: { status, body: { error: say, code } } });
      calls = [];
      await click(foot(), button);
      expect(calls.map((c) => `${c.method} ${c.url}`), code).toEqual([`POST /tasks/${T_RED}/${verb}`, `GET /tasks/${T_RED}`]);
      expect(title()).toBe('Watch a CI Run');
      expect(said(), code).toEqual([say, 'res bad']);
    }
    routes = answers();
    await openTask(T_RED);
    routes = answers({ [`POST /tasks/${T_RED}/accept`]: { status: 404, body: { error: TASK_SAYS.noTask, code: 'noTask' } } });
    await click(foot(), 'Accept Anyway');
    expect(title()).toBe('Tasks');
    expect(said()).toEqual([TASK_SAYS.noTask, 'res bad']);
    // The runtime is down: nothing changed, the view stays, and the buttons are back.
    routes = answers();
    await openTask(T_RED);
    routes = answers({ [`POST /tasks/${T_RED}/accept`]: { status: 503, body: { error: TASKS_SAY.downWrite } } });
    calls = [];
    await click(foot(), 'Accept Anyway');
    expect(calls).toHaveLength(1);
    expect(said()).toEqual([TASKS_SAY.downWrite, 'res bad']);
    expect(foot().with('btn').map((b) => b.disabled)).toEqual([false, false]);
    // An older runtime, asked to run one again: said as that.
    routes = answers({ [`POST /tasks/${T_RED}/again`]: { status: 501, body: { error: TASKS_SAY.older } } });
    await click(foot(), 'Run Again');
    expect(said()).toEqual(['This needs a newer runtime.', 'res bad']);
    expect(signed).toEqual([]);
  });
});

describe('New Task', () => {
  const pick = (label: string, value: string) => {
    const f = body().field(label);
    f.value = value;
    f.onchange!();
  };

  it('offers what the runtime says can run: Watch a CI Run, its runs by label, his goals by title, and a due date', async () => {
    await open();
    calls = [];
    run('taskNew()');
    await settle();
    expect(calls).toEqual([{ url: '/tasks/form', method: 'GET', body: undefined }]);
    expect(title()).toBe('New Task');
    expect(ids.taskback!.hidden).toBe(false);
    expect(ids.taskadd!.hidden).toBe(true);
    expect(body().with('fl').map((w) => w.children[0]!.textContent)).toEqual(['What to Do', 'CI Run', 'Goal', 'Due']);
    const options = (label: string) => body().field(label).children.map((o) => [o.value, o.textContent]);
    expect(options('What to Do')).toEqual([['watch_ci', 'Watch a CI Run']]);
    expect(options('CI Run')).toEqual([['', 'Choose a CI Run'], [ITEM, 'wpf002/flint CI'], ['en1a2b3c4d5e6f7g8h9i0j1k', 'wpf002/nexus CI']]);
    expect(options('Goal')).toEqual([['', 'No Goal'], [GOAL, 'Finish Building Flint']]);
    expect(body().field('Due').type).toBe('date');
    expect(body().with('gnote').map((e) => e.textContent)).toEqual(['Pick a CI run Flint tracks.']);
    expect(foot().buttons()).toEqual(['Cancel', 'Create Task']);
    expect(focused).toBe(body().field('What to Do'));
    // An id is a value the form sends, never a word on screen.
    plainScreen();
    ownWords(['New Task', 'What to Do', 'CI Run', 'Goal', 'Due', 'Choose a CI Run', 'No Goal', 'Cancel', 'Create Task'], ['Pick a CI run Flint tracks.']);
    // Cancel leaves the form, and what was picked in it: the next New Task starts empty.
    pick('CI Run', ITEM);
    await click(foot(), 'Cancel');
    expect(title()).toBe('Tasks');
    expect(run('TASKS.form')).toBeNull();
    run('taskNew()');
    await settle();
    expect(body().field('CI Run').value).toBe('');
  });

  it('Create Task needs a run picked; then one POST makes the task and files its card, which is shown here and signed', async () => {
    await open();
    run('taskNew()');
    await settle();
    calls = [];
    await click(foot(), 'Create Task');
    expect(said()).toEqual(['Choose a CI run to watch.', 'res bad']);
    expect(calls).toEqual([]);
    pick('CI Run', ITEM);
    expect(said()).toBeNull();
    foot().button('Create Task').onclick!();
    foot().button('Create Task').onclick!();
    await settle();
    expect(posts()).toHaveLength(1);
    const sent = posts()[0]!;
    expect(sent.url).toBe('/tasks');
    expect(NewTaskBody.safeParse(sent.body).success).toBe(true);
    expect(sent.body).toEqual({ draftKey: expect.stringMatching(/^[0-9a-f]{24}$/), template: 'watch_ci', params: { item: ITEM }, goalId: null, dueAt: null });
    // The card, read back from the Approvals list: what it does, on what, by when, and what it costs.
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(['POST /tasks', 'GET /proposals', `GET /tasks/${T_NEW}`]);
    expect(title()).toBe('Watch a CI Run');
    expect(body().with('plead')[0]!.textContent).toBe('Flint waits for the run and tells you how it ended.');
    expect(rows()).toEqual([['CI Run', [], 'wpf002/flint CI'], ['Due', [], 'No Due Date'], ['Cost', [], 'No Cost']]);
    plainScreen();
    // Behind Show Details: the whole task he signs, in sentences, labels and references.
    body().button('Show Details').onclick!();
    const details = body().all().find((e) => e.id === 'taskcarddetails')!;
    const text = details.textContent;
    for (const says of ['Approving runs this task.', 'The task is “Watch a CI Run”.', 'Check 1 is “CI Run Passed”. Flint checks it by rule.', 'Check 2 is “Names Only Your Items”. Flint checks it by rule.', 'It has no due time.', 'It costs nothing.']) expect(text, says).toContain(says);
    for (const id of [T_NEW, WATCHER, ITEM]) expect(text, id).toContain(id);
    expect(text).not.toMatch(/[{}"[\]]/);
    expect(details.all().some((e) => e.tagName === 'pre')).toBe(false);
    await click(foot(), 'Approve with Touch ID');
    expect(signed).toEqual([['prdispatch1', { fresh: true, reason: 'run this task', args: CARDS.dispatch.args }]]);
    expect(title()).toBe('Watch a CI Run');
    expect(said()).toEqual(['Flint started it.', 'res ok']);
    expect(calls.at(-1)).toEqual({ url: `/tasks/${T_NEW}`, method: 'GET', body: undefined });
  });

  it('a goal and a due date ride along: the goal by its id, the date as the end of that day', async () => {
    await open();
    run('taskNew()');
    await settle();
    pick('CI Run', ITEM);
    pick('Goal', GOAL);
    pick('Due', '2026-10-20');
    await click(foot(), 'Create Task');
    const sent = posts()[0]!.body as Record<string, unknown>;
    expect(NewTaskBody.safeParse(sent).success).toBe(true);
    expect(sent).toMatchObject({ params: { item: ITEM }, goalId: GOAL, dueAt: new Date(2026, 9, 20, 23, 59, 0, 0).toISOString() });
  });

  it('a form the runtime did not answer keeps what was picked, and sent again it is the same task: the same key', async () => {
    await open();
    run('taskNew()');
    await settle();
    pick('CI Run', ITEM);
    routes = answers({ 'POST /tasks': { status: 504, body: { error: TASKS_SAY.unsure } } });
    await click(foot(), 'Create Task');
    expect(said()).toEqual([TASKS_SAY.unsure, 'res bad']);
    expect(title()).toBe('New Task');
    expect(body().field('CI Run').value).toBe(ITEM);
    expect(foot().with('btn').map((b) => b.disabled)).toEqual([false, false]);
    // Not sure again, then it goes through: one key all along, so one task whichever of them made it.
    await click(foot(), 'Create Task');
    routes = answers();
    await click(foot(), 'Create Task');
    const keys = posts().map((c) => (c.body as { draftKey: string }).draftKey);
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(1);
    // Made: the next New Task is a new form, with a new key and nothing picked.
    run('taskNew()');
    await settle();
    expect(body().field('CI Run').value).toBe('');
    pick('CI Run', ITEM);
    await click(foot(), 'Create Task');
    expect((posts().at(-1)!.body as { draftKey: string }).draftKey).not.toBe(keys[0]);
  });

  it('a form the runtime refuses made nothing under its key: what was picked stays, and sent again it starts clean with a key of its own', async () => {
    const keys = () => posts().filter((c) => c.url === '/tasks').map((c) => (c.body as { draftKey: string }).draftKey);
    await open();
    run('taskNew()');
    await settle();
    pick('CI Run', ITEM);
    calls = [];
    for (const [status, code, say] of [[409, 'ruleForbids', TASK_SAYS.ruleForbids], [400, 'due', TASK_SAYS.due], [409, 'notAllowed', TASK_SAYS.notAllowed]] as const) {
      routes = answers({ 'POST /tasks': { status, body: { error: say, code } } });
      await click(foot(), 'Create Task');
      expect(said(), code).toEqual([say, 'res bad']);
      expect(title()).toBe('New Task');
      expect(body().field('CI Run').value, code).toBe(ITEM);
      expect(foot().with('btn').map((b) => b.disabled), code).toEqual([false, false]);
    }
    // Not sure it went through (no code): that key is kept, so the next press is the same task.
    routes = answers({ 'POST /tasks': { status: 504, body: { error: TASKS_SAY.unsure } } });
    await click(foot(), 'Create Task');
    routes = answers();
    await click(foot(), 'Create Task');
    const ks = keys();
    expect(ks).toHaveLength(5);
    for (const k of ks) expect(DraftKey.safeParse(k).success).toBe(true);
    // Each refusal took its key with it: the three refused and the one after them are four different keys.
    expect(new Set(ks.slice(0, 4)).size).toBe(4);
    expect(ks[4]).toBe(ks[3]);
    expect(foot().buttons()).toContain('Approve with Touch ID');
  });

  it('what it can offer has changed: the form is read again and says why; an item that is no longer offered is no longer picked', async () => {
    await open();
    run('taskNew()');
    await settle();
    pick('CI Run', ITEM);
    routes = answers({
      'POST /tasks': { status: 409, body: { error: TASK_SAYS.itemGone, code: 'itemGone' } },
      'GET /tasks/form': { status: 200, body: form({ templates: [{ template: 'watch_ci', title: 'Watch a CI Run', runsOn: 'CI Watcher', items: [{ entityId: 'en1a2b3c4d5e6f7g8h9i0j1k', label: 'wpf002/nexus CI' }], more: true }], goals: [] }) },
    });
    await click(foot(), 'Create Task');
    expect(said()).toEqual([TASK_SAYS.itemGone, 'res bad']);
    expect(body().field('CI Run').children.map((o) => o.textContent)).toEqual(['Choose a CI Run', 'wpf002/nexus CI']);
    expect(body().field('CI Run').value).toBe('');
    expect(body().with('gnote').map((e) => e.textContent)).toEqual(['Pick a CI run Flint tracks. Flint lists the 50 it saw most recently.']);
    // The asset was turned off: nothing can be made, and Settings is where that changes.
    routes = answers({ 'POST /tasks': { status: 409, body: { error: TASK_SAYS.assetOff, code: 'assetOff' } }, 'GET /tasks/form': { status: 200, body: form({ templates: [] }) } });
    pick('CI Run', 'en1a2b3c4d5e6f7g8h9i0j1k');
    await click(foot(), 'Create Task');
    expect(empty()).toEqual(['Nothing to Run Yet', 'No asset that is on can run a task yet.']);
    expect(body().buttons()).toEqual(['Open Settings']);
    expect(said()).toEqual([TASK_SAYS.assetOff, 'res bad']);
  });

  it('nothing to choose from is said, and Create Task is off; a kind of task this page has no field for is not offered; an older runtime is said as that', async () => {
    routes = answers({ 'GET /tasks/form': { status: 200, body: form({ templates: [{ template: 'watch_ci', title: 'Watch a CI Run', runsOn: 'CI Watcher', items: [], more: false }] }) } });
    await open();
    run('taskNew()');
    await settle();
    expect(body().with('fl').map((w) => w.children[0]!.textContent)).toEqual(['What to Do', 'Goal', 'Due']);
    expect(body().shown()).toContain('Flint tracks no CI runs yet.');
    expect(foot().button('Create Task').disabled).toBe(true);
    // Every kind the runtime may name has its own field here now, so each one it offers is offered.
    const others = TASK_TEMPLATE_IDS.filter((t) => t !== 'watch_ci').map((template) => ({ template, title: 'Summarize Items', runsOn: 'Local Worker', items: [{ entityId: ITEM, label: 'wpf002/flint #57' }], more: false }));
    routes = answers({ 'GET /tasks/form': { status: 200, body: form({ templates: [...others, form().templates[0]!] }) } });
    run('taskNew()');
    await settle();
    expect(body().field('What to Do').children.map((o) => o.value)).toEqual([...others.map((t) => t.template), 'watch_ci']);
    // The runtime offering no kind at all: nothing can be run, and the form is not drawn.
    routes = answers({ 'GET /tasks/form': { status: 200, body: form({ templates: [] }) } });
    run('taskNew()');
    await settle();
    expect(empty()).toEqual(['Nothing to Run Yet', 'No asset that is on can run a task yet.']);
    ownWords(['Nothing to Run Yet'], ['No asset that is on can run a task yet.']);
    expect(body().buttons()).toEqual(['Open Settings']);
    expect(foot().hidden).toBe(true);
    routes = answers({ 'GET /tasks/form': { status: 501, body: { error: TASKS_SAY.older } } });
    run('taskNew()');
    await settle();
    expect(title()).toBe('New Task');
    expect(empty()).toEqual(['Couldn’t Load Tasks', 'This needs a newer runtime.']);
    expect(ids.taskback!.hidden).toBe(false);
  });
});

describe('New Task: the kinds the local worker runs', () => {
  const ITEM2 = 'en1a2b3c4d5e6f7g8h9i0j1k';
  const TITLES: Record<string, string> = { summarize_items: 'Summarize Items', sort_items: 'Sort Items', draft_note: 'Draft a Note' };
  /** One kind of task as the runtime offers it: the Local Worker runs it, and these are the items it can be about. */
  const kind = (template: string, over: Record<string, unknown> = {}) => ({
    template, title: TITLES[template]!, runsOn: 'Local Worker', items: [{ entityId: ITEM, label: 'wpf002/flint #57' }, { entityId: ITEM2, label: 'wpf002/nexus #12' }], more: false, ...over,
  });
  const offering = async (...templates: Array<Record<string, unknown>>) => {
    const body = { templates, goals: [{ id: GOAL, title: 'Finish Building Flint' }] };
    expect(TaskForm.safeParse(body).success).toBe(true);
    routes = answers({ 'GET /tasks/form': { status: 200, body } });
    await open();
    run('taskNew()');
    await settle();
  };
  /** The items picked, by the label on each row. */
  const picked = () => body().with('lbl').map((l) => l.children[0]!.textContent).filter((t) => t.indexOf('wpf002/') === 0);
  const add = (value: string) => {
    const f = body().field('Items');
    f.value = value;
    f.onchange!();
  };
  const type = (label: string, value: string) => {
    const f = body().field(label);
    f.value = value;
    f.oninput!();
  };
  const titles = () => body().all().find((e) => e.id === 'tasktitles');

  it('a summary is about several items: each is added and taken away one at a time, and the titles switch is off until Will turns it on', async () => {
    await offering(kind('summarize_items'));
    expect(body().with('fl').map((w) => w.children[0]!.textContent)).toEqual(['What to Do', 'Items', 'Goal', 'Due']);
    expect(body().field('Items').children.map((o) => [o.value, o.textContent])).toEqual([['', 'Add an Item'], [ITEM, 'wpf002/flint #57'], [ITEM2, 'wpf002/nexus #12']]);
    // No items picked: nothing to show the model a title of, so no switch yet.
    expect(titles()).toBeUndefined();
    add(ITEM);
    expect(picked()).toEqual(['wpf002/flint #57']);
    // The one that is picked is no longer on offer.
    expect(body().field('Items').children.map((o) => o.value)).toEqual(['', ITEM2]);
    add(ITEM2);
    expect(picked()).toEqual(['wpf002/flint #57', 'wpf002/nexus #12']);
    expect(body().shown()).toContain('Every item Flint offers is already picked.');
    // Taking one away leaves the other, and puts it back on offer.
    await click(body(), '');
    expect(picked()).toEqual(['wpf002/nexus #12']);
    expect(body().field('Items').children.map((o) => o.value)).toEqual(['', ITEM]);
    add(ITEM);
    // The switch: off, and on only when he says so.
    expect(titles()!.getAttribute('aria-checked')).toBe('false');
    titles()!.onclick!();
    expect(titles()!.getAttribute('aria-checked')).toBe('true');
    calls = [];
    await click(foot(), 'Create Task');
    const sent = posts()[0]!;
    expect(sent.url).toBe('/tasks');
    expect(NewTaskBody.safeParse(sent.body).success).toBe(true);
    expect(sent.body).toEqual({ draftKey: expect.stringMatching(/^[0-9a-f]{24}$/), template: 'summarize_items', params: { items: [ITEM2, ITEM], titles: true }, goalId: null, dueAt: null });
    expect(TaskSpec.safeParse({ template: 'summarize_items', params: (sent.body as { params: unknown }).params }).success).toBe(true);
  });

  it('a summary with nothing picked is not sent, and says what it needs', async () => {
    await offering(kind('summarize_items'));
    calls = [];
    await click(foot(), 'Create Task');
    expect(said()).toEqual(['Choose at least one item to summarize.', 'res bad']);
    expect(posts()).toEqual([]);
    // Nothing to choose from at all: the sentence says so, and there is nothing to create.
    await offering(kind('summarize_items', { items: [] }));
    expect(body().shown()).toContain('Flint tracks no items to summarize yet.');
    expect(foot().button('Create Task').disabled).toBe(true);
  });

  it('a sort takes two to six labels of Will’s own: blank and repeated are refused, and the labels ride on the card', async () => {
    await offering(kind('sort_items'));
    expect(body().with('fl').map((w) => w.children[0]!.textContent)).toEqual(['What to Do', 'Items', 'Label', 'Label', 'Goal', 'Due']);
    add(ITEM);
    calls = [];
    // Two empty labels: said, not sent.
    await click(foot(), 'Create Task');
    expect(said()).toEqual(['Fill in every label, or take it out.', 'res bad']);
    expect(posts()).toEqual([]);
    type('Label', 'Mine');
    // The second field holds the second label (fields are read in order).
    const second = body().with('fl').filter((w) => w.children[0]!.textContent === 'Label')[1]!.children[1]!;
    second.value = 'Mine';
    second.oninput!();
    await click(foot(), 'Create Task');
    expect(said()).toEqual(['Give each label once.', 'res bad']);
    second.value = 'Theirs';
    second.oninput!();
    // A third, then taken away again: two is enough.
    await click(body(), 'Add Label');
    expect(body().with('fl').filter((w) => w.children[0]!.textContent === 'Label')).toHaveLength(3);
    await click(foot(), 'Create Task');
    expect(said()).toEqual(['Fill in every label, or take it out.', 'res bad']);
    const xs = body().visible().filter((e) => e.tagName === 'button' && e.getAttribute('aria-label') === 'Remove Label');
    xs[xs.length - 1]!.onclick!();
    await settle();
    calls = [];
    await click(foot(), 'Create Task');
    const sent = posts()[0]!;
    expect(sent.body).toEqual({ draftKey: expect.stringMatching(/^[0-9a-f]{24}$/), template: 'sort_items', params: { items: [ITEM], labels: ['Mine', 'Theirs'], titles: false }, goalId: null, dueAt: null });
    expect(TaskSpec.safeParse({ template: 'sort_items', params: (sent.body as { params: unknown }).params }).success).toBe(true);
  });

  it('a note is Will’s own words, and its items are up to him: it can be made with none, and none means no titles', async () => {
    await offering(kind('draft_note', { items: [] }));
    expect(body().with('fl').map((w) => w.children[0]!.textContent)).toEqual(['What to Do', 'About', 'Goal', 'Due']);
    // No item to pick, and none is needed: Create Task is live.
    expect(foot().button('Create Task').disabled).toBe(false);
    calls = [];
    await click(foot(), 'Create Task');
    expect(said()).toEqual(['Say what the note is about.', 'res bad']);
    expect(posts()).toEqual([]);
    type('About', '  What the week looked like  ');
    await click(foot(), 'Create Task');
    let sent = posts()[0]!;
    // His words as typed, with the space around them taken off; no items, and so no titles.
    expect(sent.body).toEqual({ draftKey: expect.stringMatching(/^[0-9a-f]{24}$/), template: 'draft_note', params: { items: [], titles: false, about: 'What the week looked like' }, goalId: null, dueAt: null });
    expect(TaskSpec.safeParse({ template: 'draft_note', params: (sent.body as { params: unknown }).params }).success).toBe(true);
    // With items offered, they can ride along, and then the switch is there.
    await offering(kind('draft_note'));
    type('About', 'What to do about these');
    add(ITEM);
    expect(titles()!.getAttribute('aria-checked')).toBe('false');
    calls = [];
    await click(foot(), 'Create Task');
    sent = posts()[0]!;
    expect((sent.body as { params: Record<string, unknown> }).params).toEqual({ items: [ITEM], titles: false, about: 'What to do about these' });
  });

  it('every word the form adds is its own: Title Case labels, whole sentences, and no id on screen', async () => {
    await offering(kind('summarize_items'), kind('sort_items'), kind('draft_note'));
    add(ITEM);
    plainScreen();
    ownWords(['New Task', 'What to Do', 'Items', 'Add an Item', 'About', 'Show Titles', 'Create Task'], ['Pick the items to summarize.', 'Flint shows the model each item’s title, which is text from outside Flint.']);
    const f = body().field('What to Do');
    f.value = 'sort_items';
    f.onchange!();
    plainScreen();
    ownWords(['Label', 'Add Label'], ['Pick the items to sort, and the labels to sort them under.']);
    // What he picked is kept across a change of kind, while the new kind is about those items too.
    expect(picked()).toEqual(['wpf002/flint #57']);
    const g = body().field('What to Do');
    g.value = 'draft_note';
    g.onchange!();
    plainScreen();
    ownWords(['About'], ['Say what the note is about. Items are up to you.']);
  });

  it('an item the new kind of task is not about is no longer picked, and no longer sent', async () => {
    await offering(kind('summarize_items'), kind('sort_items', { items: [{ entityId: ITEM2, label: 'wpf002/nexus #12' }] }));
    add(ITEM);
    expect(picked()).toEqual(['wpf002/flint #57']);
    const f = body().field('What to Do');
    f.value = 'sort_items';
    f.onchange!();
    // This kind is not offered that item: it is dropped, so the form asks for one it is about.
    expect(picked()).toEqual([]);
    expect(body().field('Items').children.map((o) => o.value)).toEqual(['', ITEM2]);
    calls = [];
    await click(foot(), 'Create Task');
    expect(said()).toEqual(['Choose at least one item to sort.', 'res bad']);
    expect(posts()).toEqual([]);
  });
});

describe('Settings > Assets', () => {
  const host = () => ids.setassets!;
  const load = async () => {
    run('openSettings();loadAssets()');
    await settle();
  };

  it('each asset by its name, the runtime’s sentence, its state, and the one thing that can be done with it now', async () => {
    const list = [
      asset(),
      asset({ id: 'as-two', name: 'Local Tasks', kind: 'local_worker', on: false, canTurnOn: true, line: 'The local model runs tasks on this Mac.' }),
      asset({ id: 'as-three', name: 'Local Reviews', kind: 'local_reviewer', on: false, waiting: true, line: 'A card is waiting for your approval.' }),
      asset({ id: 'as-four', name: 'Nexus Participant', kind: 'nexus_participant', on: false, costs: true, line: TASK_SAYS.needsGithub }),
    ];
    expect(AssetsPage.safeParse({ assets: list, reviewsRequired: false }).success).toBe(true);
    routes = answers({ 'GET /assets': { status: 200, body: { assets: list, reviewsRequired: false } } });
    await load();
    expect(host().hidden).toBe(false);
    expect(headers(host())).toEqual(['Assets']);
    expect(rows(host())).toEqual([
      ['CI Watcher', ['Flint reports how your CI runs end.'], 'On'], ['Local Tasks', ['The local model runs tasks on this Mac.'], 'Off'],
      ['Local Reviews', ['A card is waiting for your approval.'], 'Waiting'], ['Nexus Participant', ['It needs the GitHub source first.'], 'Off'],
    ]);
    expect(host().with('st').map((e) => e.className)).toEqual(['st ok', 'st off', 'st unknown', 'st off']);
    // On: Turn Off. Off and ready: Turn On. Its card waiting: Open Approvals. Off and not ready: nothing, and its sentence says why.
    expect(host().with('row').map((r) => r.buttons())).toEqual([['Turn Off'], ['Turn On'], ['Open Approvals'], []]);
    expect(tags(host())).toEqual(['Costs Money']);
    expect(host().shown()).not.toMatch(/as-|ci_runner|local_worker|[{}[\]()]|undefined|null/);
    ownWords(['Assets', 'Turn Off', 'Turn On', 'Open Approvals', 'On', 'Off', 'Waiting', 'Costs Money'], []);
    await click(host(), 'Open Approvals');
    expect(panels).toMatchObject({ approvals: true, settings: false });
  });

  it('Turn On files the signed card and shows it in the Tasks panel: what it turns on, what that can do, and that it costs nothing', async () => {
    routes = answers({ 'GET /assets': { status: 200, body: assets(asset({ on: false, canTurnOn: true })) } });
    await load();
    calls = [];
    host().button('Turn On').onclick!();
    host().button('Turn On').onclick!();
    await settle();
    expect(posts()).toEqual([{ url: `/assets/${WATCHER}/on`, method: 'POST', body: {} }]);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([`POST /assets/${WATCHER}/on`, 'GET /proposals']);
    expect(panels).toMatchObject({ tasks: true, settings: false });
    expect(title()).toBe('Turn On the CI Watcher');
    expect(body().with('plead')[0]!.textContent).toBe('Flint reports how your CI runs end.');
    expect(rows()).toEqual([['Asset', [], 'CI Watcher'], ['Can Do', [], 'Watch CI Runs'], ['Cost', [], 'No Cost']]);
    plainScreen();
    body().button('Show Details').onclick!();
    const text = body().all().find((e) => e.id === 'taskcarddetails')!.textContent;
    for (const says of ['Approving turns this asset on.', 'The asset is “CI Watcher”.', 'It can watch CI runs.', 'Using it costs nothing.', WATCHER, 'github:ci:v1', 'task.dispatch.ci_runner']) expect(text, says).toContain(says);
    // Nothing is on until he approves it: with a fresh touch, signing exactly what the card holds.
    expect(signed).toEqual([]);
    routes = answers();
    await click(foot(), 'Approve with Touch ID');
    expect(signed).toEqual([['prenable001', { fresh: true, reason: 'turn on the CI watcher', args: CARDS.enable.args }]]);
    expect(title()).toBe('Tasks');
    expect(said()).toEqual(['It’s on.', 'res ok']);
    // Not Now leaves it waiting in Approvals, and the list says so.
    routes = answers({ 'GET /assets': { status: 200, body: assets(asset({ on: false, canTurnOn: true })) } });
    await load();
    await click(host(), 'Turn On');
    await click(foot(), 'Not Now');
    expect(title()).toBe('Tasks');
    expect(said()).toEqual(['It’s waiting in Approvals.', 'res ok']);
    expect(signed).toHaveLength(1);
  });

  it('if Will has left Settings before the card is filed, nothing opens: the card waits in Approvals', async () => {
    routes = answers({ 'GET /assets': { status: 200, body: assets(asset({ on: false, canTurnOn: true })) } });
    await load();
    host().button('Turn On').onclick!();
    run("showPanel('settings',false)");
    await settle();
    expect(panels.tasks).toBeFalsy();
    expect(calls.some((c) => c.url === '/proposals')).toBe(false);
  });

  it('Turn Off asks in place first, is not taken on a double tap, and is one unsigned POST; the list is read again', async () => {
    await load();
    calls = [];
    await click(host(), 'Turn Off');
    expect(calls).toEqual([]);
    expect(rows(host())).toEqual([['CI Watcher', ['Tasks that are running on it will fail.'], 'On']]);
    // The button that goes through with it comes first; Cancel takes the end of the row, where the lone Turn Off was, and the cursor.
    expect(host().buttons()).toEqual(['Turn Off', 'Cancel']);
    expect(focused?.textContent).toBe('Cancel');
    // Cancel puts it back as it was.
    await click(host(), 'Cancel');
    expect(rows(host())).toEqual([['CI Watcher', ['Flint reports how your CI runs end.'], 'On']]);
    expect(host().buttons()).toEqual(['Turn Off']);
    // A second tap right on the heels of the first is the same tap: it turns nothing off.
    await click(host(), 'Turn Off');
    clock += 399;
    await click(host(), 'Turn Off');
    expect(calls).toEqual([]);
    clock += 1;
    routes = answers({ 'GET /assets': { status: 200, body: assets(asset({ on: false, canTurnOn: true })) } });
    host().button('Turn Off').onclick!();
    host().button('Turn Off').onclick!();
    await settle();
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([`POST /assets/${WATCHER}/off`, 'GET /assets']);
    expect(posts()[0]!.body).toEqual({});
    expect(rows(host())).toEqual([['CI Watcher', ['Flint reports how your CI runs end.'], 'Off']]);
    expect(host().buttons()).toEqual(['Turn On']);
    expect(signed).toEqual([]);
  });

  it('a refusal is the runtime’s sentence under the list, read again; a runtime that is down leaves the row as it is', async () => {
    await load();
    await click(host(), 'Turn Off');
    clock += 1000;
    routes = answers({ [`POST /assets/${WATCHER}/off`]: { status: 409, body: { error: TASK_SAYS.reviewerStays, code: 'reviewerStays' } } });
    await click(host(), 'Turn Off');
    const msg = () => host().visible().find((e) => e.id === 'assetsmsg')?.textContent ?? null;
    expect(msg()).toBe('Reviews are required, so this stays on.');
    expect(host().buttons()).toEqual(['Turn Off']);
    await click(host(), 'Turn Off');
    clock += 1000;
    routes = answers({ [`POST /assets/${WATCHER}/off`]: { status: 503, body: { error: TASKS_SAY.downWrite } } });
    await click(host(), 'Turn Off');
    expect(msg()).toBe(TASKS_SAY.downWrite);
    expect(host().buttons()).toEqual(['Turn Off', 'Cancel']);
    expect(host().with('btn').map((b) => b.disabled)).toEqual([false]);
    // Turn On refused: the same.
    routes = answers({ 'GET /assets': { status: 200, body: assets(asset({ on: false, canTurnOn: true })) }, [`POST /assets/${WATCHER}/on`]: { status: 409, body: { error: TASK_SAYS.needsGithub, code: 'needsGithub' } } });
    await load();
    await click(host(), 'Turn On');
    expect(msg()).toBe('It needs the GitHub source first.');
    expect(panels.tasks).toBeFalsy();
  });

  it('no runtime, an older one, or a rejected token: the section is not there; a runtime that is down says so with a way to try again; none yet is said', async () => {
    for (const status of [501, 401]) {
      host().hidden = false;
      routes = answers({ 'GET /assets': { status, body: { error: 'x' } } });
      await load();
      expect(host().hidden, String(status)).toBe(true);
      expect(host().shown()).toBe('');
    }
    routes = answers({ 'GET /assets': { status: 503, body: { error: TASKS_SAY.down } } });
    await load();
    expect(host().hidden).toBe(false);
    expect(rows(host())).toEqual([['Couldn’t Load Assets', ['The runtime isn’t answering, so assets can’t load.'], '']]);
    routes = answers({ 'GET /assets': { status: 200, body: { assets: [], reviewsRequired: false } } });
    await click(host(), 'Try Again');
    expect(rows(host())).toEqual([['', ['Flint has no assets yet.'], '']]);
    expect(host().buttons()).toEqual([]);
  });
});

describe('the Approvals panel names a card’s task', () => {
  const name = (p: unknown) => run(`apprTaskName(${JSON.stringify(p)})`);
  const known = () => (JSON.parse(run('JSON.stringify(Object.keys(APPR_TASKS))') as string) as string[]).sort();
  let learned: number[];
  const names = async (ps: unknown[]) => {
    ctx.LEARNED = (n: number) => void learned.push(n);
    run(`taskNames(${JSON.stringify(ps)},LEARNED)`);
    await settle();
  };
  beforeEach(() => {
    learned = [];
  });

  it('reads each task its cards are about, by its id, every time it is asked; a card of another kind, a tool’s card under a task card’s name, or one with no task’s id is not asked about', async () => {
    const ps = [
      CARDS.accept, CARDS.cancel, { ...CARDS.reject }, CARDS.enable, { id: 'pr9', fullName: 'goal.activate', kind: 'goal', mcp: false, status: 'pending', args: { taskId: T_DONE } },
      { ...CARDS.dispatch, id: 'prbad', args: { taskId: '../assets' } }, { ...CARDS.override, id: 'prtool', kind: 'tool_call', mcp: true }, { ...CARDS.override, id: 'prnokind', kind: undefined },
    ];
    await names(ps);
    expect(calls.map((c) => c.url).sort()).toEqual([`/tasks/${T_OUT}`, `/tasks/${T_WAIT}`]);
    // Told once, when every read is back, how many it read.
    expect(learned).toEqual([2]);
    expect(name(CARDS.cancel)).toBe('Watch a CI Run · wpf002/flint CI');
    expect(known()).toEqual([T_OUT, T_WAIT]);
    // Asked again, it reads again: what it read before is not trusted to be current.
    routes = answers({ [`GET /tasks/${T_OUT}`]: { status: 200, body: { task: view(T_OUT, { about: 'wpf002/nexus CI' }) } } });
    calls = [];
    await names(ps);
    expect(calls.map((c) => c.url).sort()).toEqual([`/tasks/${T_OUT}`, `/tasks/${T_WAIT}`]);
    expect(learned).toEqual([2, 2]);
    expect(name(CARDS.cancel)).toBe('Watch a CI Run · wpf002/nexus CI');
    // Nothing to read: it still answers, once.
    calls = [];
    await names([CARDS.enable, { ...CARDS.override, kind: 'tool_call', mcp: true }]);
    await names([]);
    expect(calls).toEqual([]);
    expect(learned).toEqual([2, 2, 0, 0]);
    // Many cards: a bounded number of reads.
    const many = Array.from({ length: 40 }, (_, i) => ({ ...CARDS.cancel, id: `prm${i}`, args: { taskId: `tk${String(i).padStart(18, '0')}` } }));
    calls = [];
    await names(many);
    expect(calls).toHaveLength(20);
    expect(run('TASK_NAMES_MAX')).toBe(20);
  });

  it('keeps a name only under the id it asked for: an answer about another task is dropped, a task that is gone takes its name with it, and a runtime that is down changes nothing', async () => {
    // The answer names another task: nothing is kept under the id that was asked, nor under the id it names.
    routes = answers({ [`GET /tasks/${T_OUT}`]: { status: 200, body: { task: view(T_RED, { title: 'Pay Everyone', about: 'somewhere else' }) } } });
    await names([CARDS.cancel]);
    expect(learned).toEqual([0]);
    expect(known()).toEqual([]);
    expect(name(CARDS.cancel)).toBe('');
    expect(name(CARDS.override)).toBe('');
    // What was known under that id before is left as it was: the answer is dropped, whole.
    routes = answers();
    await names([CARDS.cancel]);
    expect(name(CARDS.cancel)).toBe('Watch a CI Run · wpf002/flint CI');
    routes = answers({ [`GET /tasks/${T_OUT}`]: { status: 200, body: { task: view(T_RED, { title: 'Pay Everyone', about: 'somewhere else' }) } } });
    await names([CARDS.cancel]);
    expect(name(CARDS.cancel)).toBe('Watch a CI Run · wpf002/flint CI');
    expect(known()).toEqual([T_OUT]);
    // An answer with no task, or a task with no title, names nothing.
    for (const body of [{}, { task: null }, { task: { id: T_WAIT } }, { task: { id: T_WAIT, title: 7 } }]) {
      routes = answers({ [`GET /tasks/${T_WAIT}`]: { status: 200, body } });
      await names([CARDS.accept]);
      expect(name(CARDS.accept), JSON.stringify(body)).toBe('');
    }
    // A task that is gone takes its name with it: the card shows only what it holds.
    routes = answers({ [`GET /tasks/${T_OUT}`]: { status: 404, body: { error: TASK_SAYS.noTask, code: 'noTask' } } });
    await names([CARDS.cancel]);
    expect(learned.at(-1)).toBe(0);
    expect(known()).toEqual([]);
    expect(name(CARDS.cancel)).toBe('');
    expect(name(CARDS.dispatch)).toBe('Watch a CI Run');
    // A runtime that is down, or any other failure, leaves what was known.
    routes = answers();
    await names([CARDS.cancel]);
    for (const a of [{ status: 503, body: { error: TASKS_SAY.down } }, { status: 502, body: { error: TASKS_SAY.unreadable } }, { status: 404, body: { error: 'x' } }]) {
      routes = answers({ [`GET /tasks/${T_OUT}`]: a });
      await names([CARDS.cancel]);
      expect(learned.at(-1), String(a.status)).toBe(0);
      expect(name(CARDS.cancel), String(a.status)).toBe('Watch a CI Run · wpf002/flint CI');
    }
  });

  it('opening a task keeps its name for its cards only when the answer is the task that was asked for; any other answer is not shown and nothing of it is kept', async () => {
    await openTask(T_OUT);
    expect(JSON.parse(run(`JSON.stringify(APPR_TASKS['${T_OUT}'])`) as string)).toEqual({ title: 'Watch a CI Run', about: 'wpf002/flint CI' });
    expect(known()).toEqual([T_OUT]);
    run(`delete APPR_TASKS['${T_OUT}']`);
    // The runtime (or something between) answers with another task.
    routes = answers({ [`GET /tasks/${T_OUT}`]: { status: 200, body: { task: view(T_RED, { title: 'Pay Everyone', about: 'somewhere else' }) } } });
    calls = [];
    run(`taskOpen('${T_OUT}')`);
    await settle();
    expect(empty()).toEqual(['Couldn’t Load Tasks', 'The runtime sent an answer Flint can’t read.']);
    expect(body().buttons()).toEqual(['Try Again']);
    expect(screen()).not.toMatch(/Pay Everyone|somewhere else/);
    expect(foot().hidden).toBe(true);
    expect(known()).toEqual([]);
    expect(run('TASKS.task')).toBeNull();
    ownWords(['Couldn’t Load Tasks'], ['The runtime sent an answer Flint can’t read.']);
    // The same for an answer with no task in it.
    routes = answers({ [`GET /tasks/${T_OUT}`]: { status: 200, body: {} } });
    await click(body(), 'Try Again');
    expect(empty()![0]).toBe('Couldn’t Load Tasks');
    expect(known()).toEqual([]);
    // Try Again asks for the task that was asked for, and shows it when it is the one that answers.
    routes = answers();
    await click(body(), 'Try Again');
    expect(calls.at(-1)).toEqual({ url: `/tasks/${T_OUT}`, method: 'GET', body: undefined });
    expect(title()).toBe('Watch a CI Run');
    expect(known()).toEqual([T_OUT]);
    // An id that is no task's id is never a key of what this page knows ("__proto__", "constructor").
    for (const id of ['__proto__', 'constructor', 'toString']) {
      routes = answers({ [`GET /tasks/${id}`]: { status: 200, body: { task: view(id, { title: 'Pay Everyone' }) } } });
      run(`taskOpen(${JSON.stringify(id)})`);
      await settle();
      expect(known(), id).toEqual([T_OUT]);
      expect(run('({}).title'), id).toBeUndefined();
    }
  });
});

describe('what the panel holds', () => {
  it('closing drops it: the tasks drawn, a half-made form, and an answer still on its way', async () => {
    await openTask(T_WAIT);
    run('closeTasks()');
    expect(body().shown()).toBe('');
    expect(foot().hidden).toBe(true);
    expect(run('TASKS.task===null&&TASKS.form===null&&TASKS.again===null')).toBe(true);
    // An answer that lands after he has gone neither throws nor draws.
    await open();
    run(`taskOpen('${T_OUT}');closeTasks()`);
    await settle();
    expect(body().shown()).toBe('');
    // A New Task form is not kept past closing: the next one starts empty.
    await open();
    run('taskNew()');
    await settle();
    body().field('CI Run').value = ITEM;
    body().field('CI Run').onchange!();
    expect(run('TASKS.form.item')).toBe(ITEM);
    run('closeTasks()');
    // Gone with the panel, not only once it is opened again.
    expect(run('TASKS.form')).toBeNull();
    await open();
    run('taskNew()');
    await settle();
    expect(body().field('CI Run').value).toBe('');
  });

  it('a slow answer for one view never writes into another', async () => {
    await open();
    // The task is asked for, then Will goes to Finished before it answers.
    run(`taskOpen('${T_OUT}');taskTab('finished')`);
    await settle();
    expect(title()).toBe('Tasks');
    expect(rows().map((r) => r[1][0])).toEqual(['It passed 2 of 2 checks.', 'It failed 1 of 2 checks.']);
  });

  it('every word of its own is a Title Case title or a whole sentence; its headers are uppercase through .gsh', () => {
    const say = run('JSON.stringify(TASK_SAY)') as string;
    for (const s of Object.values(JSON.parse(say) as Record<string, string>)) {
      expect(sentence(s), s).toBe(true);
      expect(noteProblems('Tasks', s), s).toEqual([]);
    }
    for (const s of Object.values(JSON.parse(run('JSON.stringify(TASK_DONE)') as string) as Record<string, string>)) expect(noteProblems('Tasks', s), s).toEqual([]);
    for (const words of Object.values(JSON.parse(run('JSON.stringify(TASK_FIELDS)') as string) as Record<string, string[]>)) {
      ownWords(words.slice(0, 2), words.slice(2));
    }
    for (const t of ['Tasks', 'New Task', 'Active', 'Finished', 'Tasks Are Off', 'No Tasks Yet', 'Nothing Finished Yet', 'Couldn’t Load Tasks', 'Couldn’t Load the Card', 'Couldn’t Load Assets', 'You’re Signed Out', 'Cancel This Task', 'Keep Task', 'Cancel Task',
      'Accept Anyway', 'Reject Anyway', 'Run Again', 'Review Card', 'Show Details', 'Hide Details', 'Not Now', 'Open Settings', 'Open Approvals', 'Try Again', 'Turn On', 'Turn Off', 'Create Task', 'Passed', 'Failed', 'Waiting', 'Not Checked', 'Outside Text', 'Costs Money',
      'About', 'Runs On', 'Asked By', 'Goal', 'Due', 'Chance It Passes', 'Cost', 'No Cost', 'Not Known Yet', 'No Goal', 'No Due Date']) {
      expect(tasksJs, t).toContain(`'${t}'`);
      ownWords([t], []);
    }
    expect(html).toMatch(/\.gsh\{[^}]*text-transform:uppercase/);
    // Every section header in the script goes through .gsh.
    expect(tasksJs.match(/gEl\('div','gsh','[^']+'\)/g)).toEqual(["gEl('div','gsh','Result')", "gEl('div','gsh','Checks')", "gEl('div','gsh','Details')", "gEl('div','gsh','Assets')"]);
    // ES5: the Mac app's web view and an older phone run it as written.
    expect(tasksJs.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/=>|\blet\s|\bconst\s|`|\bconfirm\(|\balert\(|\bprompt\(|localStorage|sessionStorage/);
    // The words it shares with the runtime's registry and the server are the same words.
    const registry = readFileSync(join(__dirname, '..', '..', 'runtime', 'src', 'assets', 'registry.ts'), 'utf8');
    expect(registry).toContain(`line: '${(JSON.parse(run('JSON.stringify(APPR_ASSETS)') as string) as Record<string, string[]>).ci_runner![1]}'`);
    expect(registry).toContain("name: 'CI Watcher'");
  });

  it('works at phone width and shows where the keyboard is: the footer wraps, targets are tall, long words wrap, and nothing turns off the focus ring', () => {
    const css = /\/\* tasks and assets: the panel's rows, in the same components \*\/([\s\S]*?)<\/style>/.exec(html)![1]!;
    expect(css).toContain('#taskfoot{flex-wrap:wrap;}');
    expect(css).toContain('#taskbody .lbl b,#taskbody .lbl span,#taskbody .plead,#taskbody .empty span{overflow-wrap:anywhere;}');
    const phone = /@media \(max-width:600px\)\{([\s\S]*)\}/.exec(css)![1]!;
    expect(phone).toContain('#taskfoot .btn{flex:1;justify-content:center;}');
    expect(phone).toContain('#taskseg button{height:44px;');
    // A task's row on a phone: its marks and what it is about take a line of their own, under the title and beside nothing.
    expect(phone).toContain('.row.tkrow .tmeta{order:3;flex:1 1 100%;');
    // What a task is about is set no larger there than the sentence above it (a row's own text is larger on a phone).
    const size = (rule: string) => /font-size:(\d+)px;line-height:(\d+)px/.exec(rule)!.slice(1).map(Number);
    const aboutRule = /\.row\.tkrow \.tmeta \.val\{([^}]*)\}/.exec(phone)![1]!;
    const sentenceRule = /\n  \.row \.lbl span\{([^}]*)\}/.exec(html)![1]!;
    expect(size(aboutRule)).toEqual(size(sentenceRule));
    expect(size(aboutRule)).toEqual([12, 16]);
    expect(/\n    \.row\{[^}]*font-size:(\d+)px/.exec(html)![1]).toBe('17');
    // Show Details, open: its chevron turns (the button says so to a screen reader too: aria-expanded).
    expect(css).toContain('button[aria-expanded="true"]>svg.i{transform:rotate(90deg);}');
    expect(html.match(/setAttribute\('aria-expanded'/g)!.length).toBeGreaterThanOrEqual(4);
    // The mark beside a looked-up value is small and muted, and never wraps away from its value.
    expect(css).toMatch(/\.looked\{[^}]*font-size:11px;[^}]*color:var\(--t3\);[^}]*white-space:nowrap;/);
    expect(css).not.toMatch(/outline:\s*(none|0)|:focus/);
    expect(html).toContain(':focus-visible{outline:none;box-shadow:0 0 0 2px var(--bg),0 0 0 4px var(--gold-hi);border-radius:6px;}');
    // The palette is the page's own: the panel names no colour of its own.
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgb\(/);
  });
});
