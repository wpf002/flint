/**
 * The console's Predictions panel (apps/console/index.html, <script
 * id="predictions-js">), run against a small fake DOM whose innerHTML setter
 * throws: ES5 and text only. It is loaded as the page loads it, after the
 * Approvals and Goals scripts whose words and helpers it uses.
 *
 *  - The header button shows only once the runtime answers; its dot only when
 *    questions wait and Will has let Flint ask on its own.
 *  - Every sentence and value about a number, a question or a score is the
 *    runtime's, shown as it came: the panel adds none, so a state with no
 *    number shows no number. The panel's own words are Title Case titles,
 *    tabs, buttons and labels, section headers through .gsh, and complete
 *    sentences, each held to the notes' rules.
 *  - No stored key and no id reaches the screen.
 *  - Turning predictions on files the card, shows it in the Approvals panel's
 *    own words for it, and signs exactly the args it showed, with a fresh
 *    touch and the prompt "turn on predictions"; a cancelled prompt leaves the
 *    card in Approvals. Turning a number off and answering a question are
 *    unsigned: one POST each.
 *  - Loading, failed, signed out, off, and empty are each said in words.
 *  - An answer that lands after Will has gone elsewhere neither throws nor
 *    pulls him back.
 *  - No answer is recorded on one tap: the first arms the row, the second
 *    records. A prediction Flint cannot say plainly offers only Skip.
 *  - Closing drops what the panel holds.
 *  - The local model's second opinion (P4 part 5): one switch on the sheet,
 *    offered only where the runtime says there is a local model; the card
 *    shows it as the Approvals panel does, and what is signed lists the same
 *    numbers for the local model. One number, open, shows it as the runtime's
 *    one sentence, with Turn Off Second Opinion (one unsigned POST) or Turn On
 *    Second Opinion (the card, which says that only the second opinion
 *    changes). The footer's button is Turn Off Forecasts: no two buttons on
 *    the view read the same.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { webcrypto } from 'node:crypto';
import { AnswerBody, ForecastEnableArgs, PREDICT_SAYS, PredictEmptyBody, TurnOnBody, digestOf, noteProblems } from '@flint/policy';
import { PREDICTIONS_SAY } from '../src/predictions-routes';

const html = readFileSync(join(__dirname, '..', '..', 'console', 'index.html'), 'utf8');
const script = (id: string) => new RegExp(`<script id="${id}">([\\s\\S]*?)</script>`).exec(html)![1]!;
const predJs = script('predictions-js');
const goalsJs = script('goals-js');
const apprJs = script('approvals-js');
const updateJs = script('update-js');

class El {
  className = '';
  children: El[] = [];
  style: Record<string, string> = {};
  onclick: ((ev?: unknown) => void) | null = null;
  onkeydown: ((ev: { key: string }) => void) | null = null;
  disabled = false;
  hidden = false;
  tabIndex = -1;
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
  /** Its own text, without its children's. */
  get own(): string {
    return this.text;
  }
  set innerHTML(_v: string) {
    throw new Error('innerHTML is not allowed in the predictions panel');
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

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};
const run = (code: string) => runInContext(code, ctx);

const KEYS = {
  anthropic: 'daily.spend.anthropic.usd', deploys: 'daily.deploys.count', flint: 'weekly.commits.flint.count', nexus: 'weekly.commits.nexus.count', calendar: 'daily.calendar.hours',
  downtime: 'daily.services.incident_minutes', openai: 'daily.spend.openai.usd', threads: 'daily.threads.open',
};
const number = (key: string, name: string, over: Record<string, unknown> = {}) => ({
  key, name, about: `This is what ${name} is, each ${key.startsWith('weekly') ? 'week' : 'day'}.`, step: key.startsWith('weekly') ? 'week' : 'day', on: true, state: 'range', value: 'About 4',
  says: 'Flint expects about 4, with an 80% range of 2 to 6.', ...over,
});
const OFF = { on: false, state: 'off', value: 'Off', says: 'Forecasts for this number are off.' };
/** The page with numbers in every state a row can be in. */
const onPage = (over: Record<string, unknown> = {}) => ({
  state: 'on', waiting: [], questions: 0, announce: false, secondOpinion: false,
  numbers: [
    number(KEYS.anthropic, 'Anthropic Spend', { state: 'no_trend', value: 'No Trend', says: 'There’s no reliable trend, and a plain guess gives an 80% range of $0.80 to $1.75.' }),
    number(KEYS.openai, 'OpenAI Spend', { state: 'waiting', value: 'Waiting', says: 'Yesterday’s number isn’t in yet, so there’s no forecast for today.' }),
    number(KEYS.deploys, 'Deploys'),
    number(KEYS.flint, 'Flint Commits', { state: 'steady', value: 'Steady', says: 'This number hasn’t changed in 28 weeks.' }),
    number(KEYS.nexus, 'Nexus Commits', OFF),
    number(KEYS.downtime, 'Service Downtime', { state: 'short', value: 'Not Enough History', says: 'Flint needs 24 days of history. It has 9.' }),
    number(KEYS.threads, 'Open Threads', { state: 'no_data', value: 'No Data', says: 'This number has no data yet.' }),
    number(KEYS.calendar, 'Calendar Hours', { state: 'tonight', value: 'Tonight', says: 'Flint makes its next forecast tonight.' }),
  ],
  ...over,
});
const offPage = (over: Record<string, unknown> = {}) => ({ ...onPage(), state: 'off', numbers: onPage().numbers.map((n) => ({ ...n, ...OFF })), ...over });
const seriesOf = (n: ReturnType<typeof number>, over: Record<string, unknown> = {}) => ({
  number: n,
  forecast: [{ label: 'Today', value: 'About 4', says: 'The 80% range is 2 to 6.' }, { label: 'Tue, Oct 13', value: 'About 5', says: 'The 80% range is 2 to 8.' }],
  chance: { label: 'Above 3', value: 'Likely · 70%', says: 'It’s likely, around 70%, that today runs above 3.' },
  opinion: null, record: '22 of its last 27 ranges held.', waiting: false, offHere: false, ...over,
});
const QID = 'pdq1abc123def';
const SAID = 'Flint said likely, around 70%, on Oct 3. It was due Oct 5 at 3:00 PM.';
const question = (over: Record<string, unknown> = {}) => ({ id: QID, title: 'The <b>deploy</b> lands by Friday', says: SAID, answer: null, answerable: true, ...over });
/** One Flint cannot say plainly: the runtime's own row for it. */
const UNSAID = { id: 'pdq9unsaid', title: 'Flint made this prediction in a chat.', says: 'Flint can’t show what this one was about, so it can only be skipped.', answer: null, answerable: false };
const ACCURACY = {
  scored: true, scoring: 'on',
  areas: [
    { name: 'Spend', value: '161 Scored', lines: ['When Flint said about 71%, it happened 64% of the time, over 41 predictions.', 'Flint did better than always guessing the usual rate.', 'Its 80% ranges held 79% of the time, over 120 forecasts.'] },
    { name: 'Deploys', value: '12 Scored', lines: ['Flint has 12 of the 30 results it needs for its ranges.'] },
  ],
  unsettled: ['3 predictions ran out before they could be checked.', '1 was set aside with your approval.'],
};

/** The routes as a working runtime answers them; a test overrides what it needs. */
const answers = (over: Partial<Record<string, { status: number; body: unknown }>> = {}) => (c: Call): { status: number; body: unknown } => {
  const key = `${c.method} ${c.url}`;
  if (over[key]) return over[key]!;
  if (c.url === '/predictions/waiting') return { status: 200, body: { questions: 0, announce: false } };
  if (c.url === '/predictions') return { status: 200, body: onPage() };
  if (c.url === '/predictions/questions') return { status: 200, body: { waiting: [], answered: [], offHere: false } };
  if (c.url === '/predictions/accuracy') return { status: 200, body: ACCURACY };
  if (c.method === 'GET' && c.url.startsWith('/predictions/series/')) {
    const n = onPage().numbers.find((x) => c.url.endsWith(`/${x.key}`))!;
    return { status: 200, body: { series: seriesOf(n, n.state === 'range' ? {} : { forecast: [], chance: null, record: 'Flint has no results for this number yet.' }) } };
  }
  if (c.url === '/predictions/turn-on') return { status: 200, body: { id: 'prcard9x8y7z', deduped: false } };
  if (c.url.startsWith('/goals')) return { status: 200, body: { tab: 'active', goals: [], waiting: [], reviews: 'off' } };
  if (c.url === '/proposals') return { status: 200, body: { proposals: [] } };
  return { status: 200, body: { ok: true } };
};

beforeEach(async () => {
  calls = [];
  signed = [];
  keyed = true;
  panels = {};
  listeners = [];
  focused = null;
  signAnswer = async () => ({ action: { status: 'done' } });
  routes = answers();
  ids = Object.fromEntries(
    ['predictions', 'predbtn', 'preddot', 'predttl', 'predback', 'predbody', 'predfoot', 'goals', 'goalsbtn', 'goalsdot', 'goalsttl', 'goalback', 'goaladd', 'goalclear', 'goalbody', 'goalfoot',
      'approvals', 'apprlist', 'apprhelp', 'apprbadge', 'apprseg', 'apprtab-waiting', 'apprtab-approved', 'apprn-waiting', 'apprn-approved', 'apprfoot', 'apprnote', 'apprall', 'thread'].map((id) => [id, new El('div', id)]),
  );
  ids.predbtn!.hidden = true;
  ids.preddot!.hidden = true;
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
      panels[id] = on;
      ids[id]?.classList.toggle('open', on);
    },
    loadCreds: () => {},
    openSettings: () => void (panels.settings = true),
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
  // As the page loads them: Approvals (the card's words), Goals (the helpers), then Predictions.
  runInContext(apprJs, ctx);
  runInContext(goalsJs, ctx);
  // The real openApprovals draws its own panel; here it is enough to know it was asked for.
  runInContext('openApprovals=function(){OPENED_APPROVALS=true;};var OPENED_APPROVALS=false;', ctx);
  runInContext(predJs, ctx);
  await settle();
  calls = [];
});

const open = async (tab?: string) => {
  run(tab ? `PRED.tab='${tab}';openPredictions()` : 'openPredictions()');
  await settle();
};
const body = () => ids.predbody!;
const foot = () => ids.predfoot!;
const title = () => ids.predttl!.textContent;
/** What the footer says (its message line), and how. */
const said = () => {
  const m = foot().visible().find((e) => e.id === 'predmsg');
  return m ? [m.textContent, m.className] : null;
};
const headers = () => body().with('gsh').map((e) => e.textContent);
/** Each row as [label, its lines, its value]. */
const rows = (root: El = body()) =>
  root.with('row').map((r) => {
    const lbl = r.children.find((c) => c.className.split(' ').includes('lbl'));
    return [lbl?.children.find((c) => c.tagName === 'b')?.textContent ?? '', lbl?.children.filter((c) => c.tagName === 'span').map((c) => c.textContent) ?? [], r.children.find((c) => c.className === 'val')?.textContent ?? ''] as [string, string[], string];
  });
const rowOf = (label: string) => body().with('row').find((r) => r.children.some((c) => c.className.split(' ').includes('lbl') && c.children[0]?.textContent === label))!;
const SMALL = new Set(['a', 'an', 'the', 'and', 'but', 'or', 'nor', 'for', 'so', 'yet', 'as', 'at', 'by', 'from', 'in', 'into', 'of', 'off', 'on', 'onto', 'out', 'over', 'to', 'up', 'with']);
const titleCase = (s: string) => s.split(' ').every((w, i, all) => !w || /^[^a-z]/.test(w) || (i > 0 && i < all.length - 1 && SMALL.has(w)));
const sentence = (l: string) => /^[A-Z0-9].*[.!?]$/.test(l);
/** Everything on screen in the panel, as text. */
const screen = () => `${title()} ${body().shown()} ${foot().shown()}`;
/** No stored key, no id, no JSON, no aside in parentheses: nothing but words. */
const plainScreen = () => {
  const s = screen();
  expect(s).not.toMatch(/daily\.|weekly\.|\busd\b|incident_minutes|forecast\.series|prcard|pdq1|[{}[\]()]|undefined|null|NaN|\[object/);
};
/** The panel's own words on screen now (not the runtime's sentences) are held to the notes' rules. */
const ownWords = (titles: string[], sentences: string[]) => {
  for (const t of titles) {
    expect(titleCase(t), t).toBe(true);
    // (The notes' own title rule would write a small word inside a title lowercase: "Turn on Predictions". The card
    // has been Turn On Predictions since it was first filed, as a switch's On is a word of its own. Its Off too.)
    expect(noteProblems(t.replace(/ (On|Off) /g, (w) => w.toLowerCase()), ''), t).toEqual([]);
  }
  for (const s of sentences) {
    expect(sentence(s), s).toBe(true);
    expect(noteProblems('Predictions', s), s).toEqual([]);
  }
};

describe('the header button', () => {
  it('shows once the runtime answers; an older runtime, no runtime, or a rejected token leaves it hidden', async () => {
    // The page as loaded (beforeEach): the runtime answered.
    expect(ids.predbtn!.hidden).toBe(false);
    for (const status of [501, 401]) {
      ids.predbtn!.hidden = false;
      routes = answers({ 'GET /predictions/waiting': { status, body: { error: 'x' } } });
      run('predProbe()');
      await settle();
      expect(ids.predbtn!.hidden, String(status)).toBe(true);
    }
    // The runtime is only down: the button stays, and the panel says so when opened.
    routes = answers({ 'GET /predictions/waiting': { status: 503, body: { error: PREDICTIONS_SAY.down } } });
    run('predProbe()');
    await settle();
    expect(ids.predbtn!.hidden).toBe(false);
    // What the page asks on its own is two facts: no forecast is read until Will opens the panel.
    routes = answers();
    calls = [];
    run('predProbe()');
    await settle();
    expect(calls).toEqual([{ url: '/predictions/waiting', method: 'GET', body: undefined }]);
    // Signed out, nothing is asked at all.
    calls = [];
    run("TOKEN='';predProbe()");
    await settle();
    expect(calls).toEqual([]);
    run('openPredictions()');
    expect(panels).toEqual({ settings: true });
  });

  it('its dot is for questions that wait, and only once Will has let Flint ask on its own', async () => {
    expect(ids.preddot!.hidden).toBe(true);
    for (const [waiting, dot] of [[{ questions: 2, announce: false }, false], [{ questions: 0, announce: true }, false], [{ questions: 2, announce: true }, true], [{ questions: 2, announce: 'yes' }, false]] as const) {
      routes = answers({ 'GET /predictions/waiting': { status: 200, body: waiting } });
      run('predProbe()');
      await settle();
      expect(!ids.preddot!.hidden, JSON.stringify(waiting)).toBe(dot);
    }
    // The open panel keeps it in step: the page's own count, and each answer he gives.
    routes = answers({ 'GET /predictions': { status: 200, body: onPage({ questions: 1, announce: true }) }, 'GET /predictions/questions': { status: 200, body: { waiting: [question()], answered: [], offHere: false } } });
    await open();
    expect(ids.preddot!.hidden).toBe(false);
    run("predTab('questions')");
    await settle();
    run('var PRED_T=1000000;predNow=function(){return PRED_T;};');
    body().with('pacts')[0]!.children[0]!.onclick!();
    run('PRED_T+=1000');
    body().with('pacts')[0]!.children[1]!.onclick!();
    await settle();
    expect(ids.preddot!.hidden).toBe(true);
  });

  it('is in the header beside Goals, named and hidden until then; the panel is a dialog, one of the page\'s panels, and Escape closes it', async () => {
    expect(html).toContain('<button class="ib" id="predbtn" onclick="openPredictions()" aria-label="Predictions" data-tip="Predictions" hidden><svg class="i"><use href="#i-chart"/></svg><span class="udot" id="preddot" hidden></span></button>');
    expect(html.indexOf('id="goalsbtn"')).toBeLessThan(html.indexOf('id="predbtn"'));
    expect(html.indexOf('id="predbtn"')).toBeLessThan(html.indexOf('id="apprbtn"'));
    expect(html).toContain('<symbol id="i-chart" viewBox="0 0 24 24">');
    expect(html).toContain('<div class="overlay" id="predictions" onclick="if(event.target===this)closePredictions()"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="predttl">');
    expect(html).toContain('<button class="xb" id="predback" onclick="predBack()" aria-label="Back" hidden>');
    expect(html).toMatch(/<h2 id="predttl">Predictions<\/h2><button class="xb" onclick="closePredictions\(\)" aria-label="Close">/);
    expect(run('PANELS')).toEqual(['approvals', 'settings', 'activity', 'goals', 'predictions']);
    // An update never reloads the page under the open panel.
    expect(updateJs).toContain("['settings','activity','approvals','goals','predictions'].some(");
    await open();
    expect(panels.predictions).toBe(true);
    const keydown = listeners.filter(([type]) => type === 'keydown');
    expect(keydown).toHaveLength(1);
    keydown[0]![1]({ key: 'a' });
    expect(panels.predictions).toBe(true);
    keydown[0]![1]({ key: 'Escape' });
    expect(panels.predictions).toBe(false);
  });
});

describe('Forecasts', () => {
  it('three tabs, Forecasts first; Loading… until the runtime answers', async () => {
    run('openPredictions()');
    // Before the answer: the tabs and one word.
    expect(title()).toBe('Predictions');
    const tabs = body().visible().filter((e) => e.tagName === 'button' && e.getAttribute('role') === 'tab');
    expect(tabs.map((t) => [t.own, t.getAttribute('aria-selected')])).toEqual([['Forecasts', 'true'], ['Questions', 'false'], ['Accuracy', 'false']]);
    expect(body().with('empty').map((e) => e.textContent)).toEqual(['Loading…']);
    expect(foot().hidden).toBe(true);
    await settle();
    expect(body().with('empty')).toEqual([]);
    expect(calls).toEqual([{ url: '/predictions', method: 'GET', body: undefined }]);
  });

  it('each number says what the runtime said of it, under TODAY and THIS WEEK; the panel adds no number of its own', async () => {
    await open();
    // Section headers are .gsh, Title Case in the source (CSS makes them UPPERCASE).
    expect(headers()).toEqual(['Today', 'This Week']);
    expect(html).toMatch(/\.gsh\{[^}]*text-transform:uppercase/);
    const page = onPage();
    const shown = rows();
    // Daily numbers first, then weekly, each in the runtime's order, with its sentence and value as sent.
    const order = [...page.numbers.filter((n) => n.step === 'day'), ...page.numbers.filter((n) => n.step === 'week')];
    expect(shown).toEqual(order.map((n) => [n.name, [n.says], n.value]));
    // The states with no number show none: no digit beyond the fixed counts in their own sentences.
    expect(rows().find((r) => r[0] === 'OpenAI Spend')).toEqual(['OpenAI Spend', ['Yesterday’s number isn’t in yet, so there’s no forecast for today.'], 'Waiting']);
    expect(rows().find((r) => r[0] === 'Service Downtime')).toEqual(['Service Downtime', ['Flint needs 24 days of history. It has 9.'], 'Not Enough History']);
    expect(rows().find((r) => r[0] === 'Anthropic Spend')![1][0]).toMatch(/^There’s no reliable trend, and a plain guess gives an 80% range/);
    expect(rows().find((r) => r[0] === 'Open Threads')).toEqual(['Open Threads', ['This number has no data yet.'], 'No Data']);
    for (const [name, lines, value] of shown) {
      expect(titleCase(name), name).toBe(true);
      expect(titleCase(value), value).toBe(true);
      for (const l of lines) expect(sentence(l), l).toBe(true);
    }
    plainScreen();
    // Every row is a button to the keyboard, and Enter (or Space) opens it.
    for (const r of body().with('row')) expect([r.tabIndex, r.getAttribute('role'), typeof r.onkeydown], r.textContent).toEqual([0, 'button', 'function']);
    rowOf('Deploys').onkeydown!({ key: 'Tab' });
    expect(calls).toHaveLength(1);
    rowOf('Deploys').onkeydown!({ key: 'Enter' });
    await settle();
    expect(calls.at(-1)).toEqual({ url: `/predictions/series/${KEYS.deploys}`, method: 'GET', body: undefined });
    expect(title()).toBe('Deploys');
  });

  it('never turned on: it says so, with one button; switched off on this Mac: a sentence and no button', async () => {
    routes = answers({ 'GET /predictions': { status: 200, body: offPage() } });
    await open();
    expect(body().with('empty').map((e) => e.children.map((c) => c.textContent))).toEqual([['Predictions Are Off', 'Flint can forecast its own numbers each night, on this Mac.', 'Turn On Predictions']]);
    expect(body().buttons().filter((b) => !['Forecasts', 'Questions', 'Accuracy'].includes(b))).toEqual(['Turn On Predictions']);
    expect(headers()).toEqual([]);
    ownWords(['Predictions Are Off', 'Turn On Predictions'], ['Flint can forecast its own numbers each night, on this Mac.']);
    routes = answers({ 'GET /predictions': { status: 200, body: offPage({ state: 'off_here' }) } });
    await open();
    expect(body().with('empty').map((e) => e.children.map((c) => c.textContent))).toEqual([['Predictions Are Off', 'Predictions are switched off on this Mac.']]);
    expect(body().buttons().filter((b) => !['Forecasts', 'Questions', 'Accuracy'].includes(b))).toEqual([]);
    // The console's sentence is the runtime's own for the same refusal.
    expect(run('PRED_SAY.offHere')).toBe(PREDICT_SAYS.offHere);
  });

  it('a card that waits for Will is a row that says so and opens Approvals; nothing is forecast until he approves it', async () => {
    routes = answers({ 'GET /predictions': { status: 200, body: offPage({ waiting: [{ id: 'prcard9x8y7z', numbers: 12 }] }) } });
    await open();
    expect(rows()).toEqual([['Turn On Predictions', ['It turns on 12 numbers once you approve it.'], '']]);
    expect(body().with('tag').map((t) => t.textContent)).toEqual(['Waiting for You']);
    expect(body().with('gnote').map((e) => e.textContent)).toEqual(['Nothing is forecast until you approve it.']);
    expect(body().buttons().filter((b) => !['Forecasts', 'Questions', 'Accuracy'].includes(b))).toEqual([]);
    plainScreen();
    ownWords(['Turn On Predictions', 'Waiting for You'], ['It turns on 12 numbers once you approve it.', 'It turns on 1 number once you approve it.', 'Nothing is forecast until you approve it.', 'It starts once you approve it.']);
    rowOf('Turn On Predictions').onclick!();
    expect(run('OPENED_APPROVALS')).toBe(true);
    expect(panels.predictions).toBe(false);
    // One number: the sentence agrees with the count. While predictions are on, the row sits above the numbers.
    routes = answers({ 'GET /predictions': { status: 200, body: onPage({ waiting: [{ id: 'prcard9x8y7z', numbers: 1 }] }) } });
    await open();
    expect(rows()[0]).toEqual(['Turn On Predictions', ['It turns on 1 number once you approve it.'], '']);
    expect(headers()).toEqual(['Today', 'This Week']);
  });
});

describe('one number, open', () => {
  const openSeries = async (key: string, over: Partial<Record<string, { status: number; body: unknown }>> = {}) => {
    routes = answers(over);
    await open();
    run(`predSeries('${key}')`);
    await settle();
  };

  it('what it is, each step of its forecast, its chance and its record, each as the runtime said it', async () => {
    await openSeries(KEYS.deploys);
    expect(title()).toBe('Deploys');
    expect(ids.predback!.hidden).toBe(false);
    expect(body().with('plead').map((e) => e.textContent)).toEqual(['This is what Deploys is, each day.']);
    expect(headers()).toEqual(['Forecast', 'Chance', 'Record']);
    expect(rows()).toEqual([
      ['Today', ['The 80% range is 2 to 6.'], 'About 4'],
      ['Tue, Oct 13', ['The 80% range is 2 to 8.'], 'About 5'],
      ['Above 3', ['It’s likely, around 70%, that today runs above 3.'], 'Likely · 70%'],
      ['', ['22 of its last 27 ranges held.'], ''],
    ]);
    // These rows open nothing: they are not buttons.
    for (const r of body().with('row')) expect([r.tabIndex, r.onclick], r.textContent).toEqual([-1, null]);
    expect(foot().buttons()).toEqual(['Turn Off Forecasts']);
    plainScreen();
    // Back returns to the tab he came from.
    run('predBack()');
    await settle();
    expect(title()).toBe('Predictions');
    expect(headers()).toEqual(['Today', 'This Week']);
  });

  it('with no forecast it says where the number stands and why, and shows no step and no chance', async () => {
    for (const [key, name, value, says] of [
      [KEYS.openai, 'OpenAI Spend', 'Waiting', 'Yesterday’s number isn’t in yet, so there’s no forecast for today.'],
      [KEYS.downtime, 'Service Downtime', 'Not Enough History', 'Flint needs 24 days of history. It has 9.'],
      [KEYS.threads, 'Open Threads', 'No Data', 'This number has no data yet.'],
    ] as const) {
      await openSeries(key);
      expect(title()).toBe(name);
      expect(headers()).toEqual(['Forecast', 'Record']);
      expect(rows()).toEqual([['Today', [says], value], ['', ['Flint has no results for this number yet.'], '']]);
    }
    // A weekly number's one row is this week's.
    await openSeries(KEYS.flint);
    expect(rows()[0]).toEqual(['This Week', ['This number hasn’t changed in 28 weeks.'], 'Steady']);
  });

  it('Turn Off Forecasts is one unsigned POST with nothing in it, and the panel says what happened', async () => {
    await openSeries(KEYS.deploys);
    calls = [];
    foot().button('Turn Off Forecasts').onclick!();
    expect(foot().button('Turn Off Forecasts').disabled).toBe(true);
    await settle();
    expect(calls[0]).toEqual({ url: `/predictions/series/${KEYS.deploys}/turn-off`, method: 'POST', body: {} });
    expect(PredictEmptyBody.safeParse(calls[0]!.body).success).toBe(true);
    expect(signed).toEqual([]);
    // The number is read again, and the footer says it.
    expect(calls[1]).toEqual({ url: `/predictions/series/${KEYS.deploys}`, method: 'GET', body: undefined });
    expect(said()).toEqual(['Flint stopped forecasting this number.', 'res ok']);
    ownWords(['Turn Off Forecasts'], ['Flint stopped forecasting this number.']);
    // A refusal is said in the footer, in the server's sentence, and the button comes back.
    await openSeries(KEYS.deploys, { [`POST /predictions/series/${KEYS.deploys}/turn-off`]: { status: 409, body: { error: PREDICT_SAYS.alreadyOff, code: 'alreadyOff' } } });
    foot().button('Turn Off Forecasts').onclick!();
    await settle();
    expect(said()).toEqual(['Forecasts for this number are already off.', 'res bad']);
    expect(foot().button('Turn Off Forecasts').disabled).toBe(false);
    await openSeries(KEYS.deploys, { [`POST /predictions/series/${KEYS.deploys}/turn-off`]: { status: 503, body: { error: PREDICTIONS_SAY.downWrite } } });
    foot().button('Turn Off Forecasts').onclick!();
    await settle();
    expect(said()).toEqual(['The runtime isn’t answering, so nothing changed.', 'res bad']);
  });

  it('a number that is off offers Turn On Forecasts (the sheet, with only it switched on); one whose card waits, Open Approvals; off on this Mac, a sentence', async () => {
    const nexus = { ...number(KEYS.nexus, 'Nexus Commits', OFF) };
    const off = (over: Record<string, unknown>) => ({ [`GET /predictions/series/${KEYS.nexus}`]: { status: 200, body: { series: seriesOf(nexus, { forecast: [], chance: null, record: 'Flint has no results for this number yet.', ...over }) } } });
    await openSeries(KEYS.nexus, off({}));
    expect(rows()[0]).toEqual(['This Week', ['Forecasts for this number are off.'], 'Off']);
    expect(foot().buttons()).toEqual(['Turn On Forecasts']);
    foot().button('Turn On Forecasts').onclick!();
    expect(title()).toBe('Turn On Predictions');
    const switches = body().visible().filter((e) => e.getAttribute('role') === 'switch');
    expect(switches.map((t) => [t.getAttribute('aria-label'), t.getAttribute('aria-checked')])).toEqual([['Nexus Commits', 'true']]);

    await openSeries(KEYS.nexus, off({ waiting: true }));
    expect(foot().buttons()).toEqual(['Open Approvals']);
    expect(foot().with('note').map((e) => e.textContent)).toEqual(['Flint is waiting for your approval.']);
    foot().button('Open Approvals').onclick!();
    expect(run('OPENED_APPROVALS')).toBe(true);

    await openSeries(KEYS.nexus, off({ offHere: true }));
    expect(foot().buttons()).toEqual([]);
    expect(foot().with('note').map((e) => e.textContent)).toEqual(['Predictions are switched off on this Mac.']);
    ownWords(['Turn On Forecasts', 'Open Approvals'], ['Flint is waiting for your approval.', 'Predictions are switched off on this Mac.']);
  });
});

describe('turning predictions on', () => {
  const sheet = async (page: Record<string, unknown> = offPage()) => {
    routes = answers({ 'GET /predictions': { status: 200, body: page } });
    await open();
    body().button('Turn On Predictions').onclick!();
  };
  const switches = () => body().visible().filter((e) => e.getAttribute('role') === 'switch');

  it('the sheet lists every number that is off, with what it is and a switch, all on to begin with', async () => {
    await sheet();
    expect(title()).toBe('Turn On Predictions');
    expect(headers()).toEqual(['Numbers to Forecast']);
    const page = offPage();
    expect(rows()).toEqual(page.numbers.map((n) => [n.name, [n.about], '']));
    expect(switches().map((t) => [t.tagName, t.className, t.getAttribute('aria-label'), t.getAttribute('aria-checked')])).toEqual(page.numbers.map((n) => ['button', 'toggle', n.name, 'true']));
    expect(foot().buttons()).toEqual(['Cancel', 'Continue']);
    plainScreen();
    ownWords(['Turn On Predictions', 'Numbers to Forecast', 'Cancel', 'Continue'], []);
    // A switch flips with a click on it or anywhere on its row; nothing is sent by either.
    switches()[0]!.onclick!({ stopPropagation: () => {} });
    expect(switches()[0]!.getAttribute('aria-checked')).toBe('false');
    body().with('ppick')[0]!.onclick!();
    expect(switches()[0]!.getAttribute('aria-checked')).toBe('true');
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
    // Cancel goes back to the tab, and files nothing.
    foot().button('Cancel').onclick!();
    await settle();
    expect(title()).toBe('Predictions');
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
  });

  it('with nothing switched on it files nothing and says why', async () => {
    await sheet();
    for (const t of switches()) t.onclick!({ stopPropagation: () => {} });
    foot().button('Continue').onclick!();
    await settle();
    expect(said()).toEqual(['Choose at least one number.', 'res bad']);
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
    ownWords([], ['Choose at least one number.']);
    // Switching one back on clears the message.
    switches()[2]!.onclick!({ stopPropagation: () => {} });
    expect(said()).toBeNull();
  });

  it('Continue files the card for the numbers switched on, then shows it in the card\'s own words, and nothing is signed yet', async () => {
    await sheet();
    // Three stay on: a spending number, a count and the calendar's.
    const keep = ['Anthropic Spend', 'Deploys', 'Calendar Hours'];
    for (const t of switches()) if (!keep.includes(t.getAttribute('aria-label')!)) t.onclick!({ stopPropagation: () => {} });
    calls = [];
    foot().button('Continue').onclick!();
    expect(foot().buttons().map((b) => foot().button(b).disabled)).toEqual([true, true]);
    await settle();
    const sorted = [KEYS.calendar, KEYS.deploys, KEYS.anthropic].sort();
    expect(calls).toEqual([{ url: '/predictions/turn-on', method: 'POST', body: { series: sorted } }]);
    expect(TurnOnBody.safeParse(calls[0]!.body).success).toBe(true);
    expect(signed).toEqual([]);
    // The card: what it does, each number by name with its kind, and what turning predictions on also does.
    expect(title()).toBe('Turn On Predictions');
    expect(body().with('plead').map((e) => e.textContent)).toEqual([
      'Flint forecasts 3 of its own numbers each night, on this Mac.',
      'Turning this on also checks the predictions Flint has already made, and those results can’t be undone.',
    ]);
    expect(headers()).toEqual(['Numbers']);
    expect(rows()).toEqual([['Anthropic Spend', [], 'Spending'], ['Deploys', [], ''], ['Calendar Hours', [], 'Calendar']]);
    expect(body().with('plead')[0]!.textContent).toBe(run(`apprSub({fullName:APPR_PREDICT,args:{series:${JSON.stringify(sorted)},reason:[]}})`));
    expect(body().with('plead')[1]!.textContent).toBe(run('APPR_PREDICT_ALSO'));
    // What it also does is said before the list of numbers: never below the fold of a long card.
    const order = body().visible().filter((e) => ['plead', 'gsh', 'group'].includes(e.className)).map((e) => e.className);
    expect(order).toEqual(['plead', 'plead', 'gsh', 'group']);
    expect(foot().with('note').map((e) => e.textContent)).toEqual(['Approve it with Touch ID to start.']);
    expect(foot().buttons()).toEqual(['Not Now', 'Approve with Touch ID']);
    plainScreen();
    ownWords(['Numbers', 'Not Now', 'Approve with Touch ID', 'Spending', 'Calendar'], ['Approve it with Touch ID to start.', 'Approve it to start.']);
  });

  it('Approve signs exactly the args the card showed, with a fresh touch and the prompt in plain words; then the numbers are read again', async () => {
    await sheet();
    foot().button('Continue').onclick!();
    await settle();
    let release!: (v: unknown) => void;
    signAnswer = () => new Promise((r) => (release = r));
    routes = answers();
    calls = [];
    foot().button('Approve with Touch ID').onclick!();
    // While the prompt is up: the footer says so, and neither button takes a second tap.
    expect(said()).toEqual(['Flint is waiting for your approval.', 'res wait']);
    expect([foot().button('Not Now').disabled, foot().button('Approve with Touch ID').disabled]).toEqual([true, true]);
    foot().button('Approve with Touch ID').onclick!();
    expect(signed).toHaveLength(1);
    const all = offPage().numbers.map((n) => n.key).sort();
    expect(signed[0]![0]).toBe('prcard9x8y7z');
    expect(signed[0]![1]).toEqual({ fresh: true, reason: 'turn on predictions', args: { series: all, reason: [] } });
    // The args are already what the shared contract normalizes them to: their digest is the stored card's.
    expect(digestOf(JSON.parse(JSON.stringify(signed[0]![1].args)))).toBe(digestOf(ForecastEnableArgs.parse({ series: [...all].reverse(), reason: [] })));
    release({ action: { status: 'done' } });
    await settle();
    expect(title()).toBe('Predictions');
    expect(calls).toEqual([{ url: '/predictions', method: 'GET', body: undefined }]);
    expect(said()).toEqual(['Approved. Flint starts keeping these numbers tonight.', 'res ok']);
    expect(headers()).toEqual(['Today', 'This Week']);
    ownWords([], ['Approved. Flint starts keeping these numbers tonight.', 'Flint is waiting for your approval.']);
  });

  it('a cancelled prompt, Not Now, a card that has not run and a failure are each said; the card stays where it was', async () => {
    const card = async () => {
      await sheet();
      foot().button('Continue').onclick!();
      await settle();
    };
    await card();
    signAnswer = async () => { throw new Error('not confirmed'); };
    foot().button('Approve with Touch ID').onclick!();
    await settle();
    expect(said()).toEqual(['Cancelled. It’s waiting in Approvals.', 'res bad']);
    expect(title()).toBe('Turn On Predictions');
    expect([foot().button('Not Now').disabled, foot().button('Approve with Touch ID').disabled]).toEqual([false, false]);
    signAnswer = async () => { throw Object.assign(new Error('The operation was not allowed.'), { name: 'NotAllowedError' }); };
    foot().button('Approve with Touch ID').onclick!();
    await settle();
    expect(said()).toEqual(['Cancelled. It’s waiting in Approvals.', 'res bad']);
    signAnswer = async () => ({ action: { status: 'approved' } });
    foot().button('Approve with Touch ID').onclick!();
    await settle();
    expect(said()).toEqual(['Approved. It hasn’t run yet.', 'res bad']);
    signAnswer = async () => ({ action: { status: 'failed', error: 'Flint couldn’t carry it out.' } });
    foot().button('Approve with Touch ID').onclick!();
    await settle();
    expect(said()).toEqual(['Flint couldn’t carry it out.', 'res bad']);
    // Not Now: back to the tab, which says where the card is.
    foot().button('Not Now').onclick!();
    await settle();
    expect(title()).toBe('Predictions');
    expect(said()).toEqual(['Cancelled. It’s waiting in Approvals.', 'res ok']);
    ownWords([], ['Cancelled. It’s waiting in Approvals.', 'Approved. It hasn’t run yet.']);
  });

  it('a refusal to file is said in the server\'s sentence and the sheet stays; a device with no approval key files nothing', async () => {
    await sheet();
    routes = answers({ 'POST /predictions/turn-on': { status: 400, body: { error: PREDICT_SAYS.nothing, code: 'nothing' } } });
    foot().button('Continue').onclick!();
    await settle();
    expect(said()).toEqual(['It changes nothing.', 'res bad']);
    expect(title()).toBe('Turn On Predictions');
    expect(headers()).toEqual(['Numbers to Forecast']);
    expect([foot().button('Cancel').disabled, foot().button('Continue').disabled]).toEqual([false, false]);
    routes = answers({ 'POST /predictions/turn-on': { status: 503, body: { error: PREDICTIONS_SAY.downWrite } } });
    foot().button('Continue').onclick!();
    await settle();
    expect(said()).toEqual(['The runtime isn’t answering, so nothing changed.', 'res bad']);

    keyed = false;
    await sheet();
    calls = [];
    foot().button('Continue').onclick!();
    await settle();
    expect(calls).toEqual([]);
    expect(foot().with('note').map((e) => e.textContent)).toEqual(['This device needs an approval key.']);
    expect(foot().buttons()).toEqual(['Open Settings']);
    foot().button('Open Settings').onclick!();
    expect(panels).toMatchObject({ predictions: false, settings: true });
    ownWords(['Open Settings'], ['This device needs an approval key.']);
  });

  it('while predictions are on, a number that is off is turned on from its own page: the sheet lists only what is off', async () => {
    routes = answers();
    await open();
    run(`predSheet(['${KEYS.nexus}'])`);
    expect(switches().map((t) => [t.getAttribute('aria-label'), t.getAttribute('aria-checked')])).toEqual([['Nexus Commits', 'true']]);
    foot().button('Continue').onclick!();
    await settle();
    expect(calls.at(-1)).toEqual({ url: '/predictions/turn-on', method: 'POST', body: { series: [KEYS.nexus] } });
    expect(body().with('plead')[0]!.textContent).toBe('Flint forecasts 1 of its own numbers each night, on this Mac.');
  });
});

describe('the local model\'s second opinion', () => {
  const sheet = async (page: Record<string, unknown>) => {
    routes = answers({ 'GET /predictions': { status: 200, body: page } });
    await open();
    body().button('Turn On Predictions').onclick!();
  };
  const switches = () => body().visible().filter((e) => e.getAttribute('role') === 'switch');
  const opinionSwitch = () => switches().find((t) => t.getAttribute('aria-label') === 'Second Opinion');
  const SAYS = 'The local model also estimates each number, and Flint compares the two.';
  const openNumber = async (opinion: unknown, over: Record<string, unknown> = {}) => {
    const n = onPage().numbers[2]!;
    routes = answers({ [`GET /predictions/series/${KEYS.deploys}`]: { status: 200, body: { series: seriesOf(n, { opinion, ...over }) } } });
    await open();
    rowOf('Deploys').onclick!();
    await settle();
  };

  it('the sheet offers it only where the runtime says there is a local model: one switch, off to begin with', async () => {
    await sheet(offPage());
    expect(headers()).toEqual(['Numbers to Forecast']);
    expect(opinionSwitch()).toBeUndefined();
    expect(screen()).not.toMatch(/Second Opinion|local model/i);
    run('closePredictions()');
    await sheet(offPage({ secondOpinion: true }));
    expect(headers()).toEqual(['Numbers to Forecast', 'Local Model']);
    const t = opinionSwitch()!;
    expect([t.tagName, t.className, t.getAttribute('aria-checked')]).toEqual(['button', 'toggle', 'false']);
    expect(rows().at(-1)).toEqual(['Second Opinion', [SAYS], '']);
    // It flips with a click on it or anywhere on its row, and nothing is sent by either.
    t.onclick!({ stopPropagation: () => {} });
    expect(t.getAttribute('aria-checked')).toBe('true');
    body().with('ppick').at(-1)!.onclick!();
    expect(t.getAttribute('aria-checked')).toBe('false');
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
    plainScreen();
    ownWords(['Local Model', 'Second Opinion'], [SAYS]);
    // Anything but the runtime's plain yes leaves it out.
    for (const secondOpinion of ['true', 1, null, undefined]) {
      run('closePredictions()');
      await sheet(offPage({ secondOpinion }));
      expect(opinionSwitch(), String(secondOpinion)).toBeUndefined();
    }
  });

  it('left off, the card is the plain one: nothing about a second opinion is sent, shown or signed', async () => {
    await sheet(offPage({ secondOpinion: true }));
    calls = [];
    foot().button('Continue').onclick!();
    await settle();
    const all = offPage().numbers.map((n) => n.key).sort();
    expect(calls).toEqual([{ url: '/predictions/turn-on', method: 'POST', body: { series: all } }]);
    expect(headers()).toEqual(['Numbers']);
    expect(screen()).not.toMatch(/Second Opinion|Local Model/);
    foot().button('Approve with Touch ID').onclick!();
    await settle();
    expect(signed[0]![1]).toEqual({ fresh: true, reason: 'turn on predictions', args: { series: all, reason: [] } });
  });

  it('switched on, the card names the same numbers for the local model, says so before it is signed, and that is what is signed', async () => {
    await sheet(offPage({ secondOpinion: true }));
    const keep = ['Anthropic Spend', 'Deploys'];
    for (const t of switches()) if (t.getAttribute('aria-label') !== 'Second Opinion' && !keep.includes(t.getAttribute('aria-label')!)) t.onclick!({ stopPropagation: () => {} });
    opinionSwitch()!.onclick!({ stopPropagation: () => {} });
    calls = [];
    foot().button('Continue').onclick!();
    await settle();
    const sorted = [KEYS.deploys, KEYS.anthropic].sort();
    // One switch rides along with the keys: the runtime writes the card's two lists from it.
    expect(calls).toEqual([{ url: '/predictions/turn-on', method: 'POST', body: { series: sorted, opinion: true } }]);
    expect(TurnOnBody.safeParse(calls[0]!.body).success).toBe(true);
    expect(signed).toEqual([]);
    // The card: its numbers, then the Second Opinion fact in the Approvals panel's own words for it.
    expect(headers()).toEqual(['Numbers', 'Second Opinion']);
    expect(rows()).toEqual([['Anthropic Spend', [], 'Spending'], ['Deploys', [], ''], ['Local Model', [SAYS], '']]);
    expect(rows().at(-1)![0]).toBe(run(`apprPredictOpinion(apprPredictList({args:{series:${JSON.stringify(sorted)},reason:${JSON.stringify(sorted)}}}))`));
    const order = body().visible().filter((e) => ['plead', 'gsh', 'group'].includes(e.className)).map((e) => e.className);
    expect(order).toEqual(['plead', 'plead', 'gsh', 'group', 'gsh', 'group']);
    plainScreen();
    ownWords(['Numbers', 'Second Opinion', 'Local Model'], [SAYS]);
    // Signed: exactly what was shown, the same list twice, as the shared contract normalizes it.
    foot().button('Approve with Touch ID').onclick!();
    await settle();
    expect(signed).toHaveLength(1);
    expect(signed[0]![1]).toEqual({ fresh: true, reason: 'turn on predictions', args: { series: sorted, reason: sorted } });
    const args = JSON.parse(JSON.stringify(signed[0]![1].args)) as { series: string[]; reason: string[] };
    expect(ForecastEnableArgs.parse(args)).toEqual(args);
    expect(digestOf(args)).toBe(digestOf(ForecastEnableArgs.parse({ series: [...sorted].reverse(), reason: [...sorted].reverse() })));
    // The sheet opened again starts with the switch off: it is never carried over from the last card.
    run('closePredictions()');
    await sheet(offPage({ secondOpinion: true }));
    expect(opinionSwitch()!.getAttribute('aria-checked')).toBe('false');
    calls = [];
    foot().button('Continue').onclick!();
    await settle();
    expect((calls[0]!.body as Record<string, unknown>).opinion).toBeUndefined();
    // Whatever was left set by another view, opening the sheet puts the switch off: what is sent is what it shows.
    run('closePredictions()');
    routes = answers({ 'GET /predictions': { status: 200, body: offPage({ secondOpinion: true }) } });
    await open();
    run('PRED.opinion=true');
    body().button('Turn On Predictions').onclick!();
    expect(opinionSwitch()!.getAttribute('aria-checked')).toBe('false');
    calls = [];
    foot().button('Continue').onclick!();
    await settle();
    expect(calls[0]!.body).toEqual({ series: offPage().numbers.map((n) => n.key).sort() });
  });

  it('a card refused for want of a local model is said in the server\'s sentence, and the sheet stays', async () => {
    await sheet(offPage({ secondOpinion: true }));
    opinionSwitch()!.onclick!({ stopPropagation: () => {} });
    routes = answers({ 'POST /predictions/turn-on': { status: 409, body: { error: PREDICT_SAYS.noModel, code: 'noModel' } } });
    foot().button('Continue').onclick!();
    await settle();
    expect(said()).toEqual(['No local model is set on this Mac, so there is no second opinion to turn on.', 'res bad']);
    expect(title()).toBe('Turn On Predictions');
    expect(headers()).toEqual(['Numbers to Forecast', 'Local Model']);
    expect(signed).toEqual([]);
  });

  it('one number, open: the runtime\'s one sentence under SECOND OPINION, between its chance and its record; none while there is nothing to say', async () => {
    await openNumber(null);
    expect(headers()).toEqual(['Forecast', 'Chance', 'Record']);
    expect(screen()).not.toMatch(/Second Opinion|Local Model/);
    run('closePredictions()');
    await openNumber({ on: true, says: 'The local model said about 60%.', offer: false });
    expect(headers()).toEqual(['Forecast', 'Chance', 'Second Opinion', 'Record']);
    expect(rowOf('Local Model').children[0]!.children.map((c) => c.textContent)).toEqual(['Local Model', 'The local model said about 60%.']);
    // Two things can be turned off here, and each button says which: no two on the view read the same.
    expect(rowOf('Local Model').buttons()).toEqual(['Turn Off Second Opinion']);
    expect(foot().buttons()).toEqual(['Turn Off Forecasts']);
    const all = [...body().buttons(), ...foot().buttons()];
    expect(new Set(all).size).toBe(all.length);
    expect(all.filter((b) => /^Turn O(n|ff)$/.test(b))).toEqual([]);
    // What is read out is what is written: neither needs a label of its own.
    expect(rowOf('Local Model').button('Turn Off Second Opinion').getAttribute('aria-label')).toBeNull();
    expect(foot().button('Turn Off Forecasts').getAttribute('aria-label')).toBeNull();
    // The row's own button is marked as the row's (on a phone it sits under its sentence, at the left; the footer's is at the right).
    expect(rowOf('Local Model').className.split(' ')).toContain('pown');
    expect(rowOf('Above 3').className.split(' ')).not.toContain('pown');
    // The forecaster's own chance is beside it, untouched.
    expect(rows()).toContainEqual(['Above 3', ['It’s likely, around 70%, that today runs above 3.'], 'Likely · 70%']);
    plainScreen();
    ownWords(['Second Opinion', 'Local Model', 'Turn Off Second Opinion', 'Turn Off Forecasts'], []);
    // The sentence is shown as it came: text, never markup.
    run('closePredictions()');
    await openNumber({ on: true, says: 'The local model said about <b>60%</b>.', offer: false });
    expect(rowOf('Local Model').children[0]!.children[1]!.textContent).toBe('The local model said about <b>60%</b>.');
  });

  it('Turn Off Second Opinion is one unsigned POST with nothing in it; the number is read again and the panel says what happened', async () => {
    await openNumber({ on: true, says: 'The local model said about 60%.', offer: false });
    const off = { on: false, says: 'The local model doesn’t estimate this number.', offer: true };
    routes = answers({ [`GET /predictions/series/${KEYS.deploys}`]: { status: 200, body: { series: seriesOf(onPage().numbers[2]!, { opinion: off }) } } });
    calls = [];
    const b = rowOf('Local Model').button('Turn Off Second Opinion');
    b.onclick!();
    expect(b.disabled).toBe(true);
    b.onclick!();
    await settle();
    expect(calls).toEqual([
      { url: `/predictions/series/${KEYS.deploys}/second-opinion-off`, method: 'POST', body: {} },
      { url: `/predictions/series/${KEYS.deploys}`, method: 'GET', body: undefined },
    ]);
    expect(PredictEmptyBody.safeParse(calls[0]!.body).success).toBe(true);
    expect(signed).toEqual([]);
    expect(said()).toEqual(['The local model stopped estimating this number.', 'res ok']);
    expect(rowOf('Local Model').children[0]!.children[1]!.textContent).toBe('The local model doesn’t estimate this number.');
    expect(rowOf('Local Model').buttons()).toEqual(['Turn On Second Opinion']);
    // Its forecasts are still on: the footer still offers to turn those off.
    expect(foot().buttons()).toEqual(['Turn Off Forecasts']);
    ownWords(['Turn On Second Opinion'], ['The local model stopped estimating this number.']);
    // A refusal is said in the server's sentence, and the button comes back.
    run('closePredictions()');
    await openNumber({ on: true, says: 'The local model said about 60%.', offer: false });
    routes = answers({ [`POST /predictions/series/${KEYS.deploys}/second-opinion-off`]: { status: 409, body: { error: PREDICT_SAYS.opinionOff, code: 'opinionOff' } } });
    rowOf('Local Model').button('Turn Off Second Opinion').onclick!();
    await settle();
    expect(said()).toEqual(['The second opinion for this number is already off.', 'res bad']);
    expect(rowOf('Local Model').button('Turn Off Second Opinion').disabled).toBe(false);
  });

  it('Turn On Second Opinion files the card for this one number with the local model on it, and the card says that only the second opinion changes; where it cannot be turned on there is no button', async () => {
    await openNumber({ on: false, says: 'The local model doesn’t estimate this number.', offer: true });
    expect(rowOf('Local Model').buttons()).toEqual(['Turn On Second Opinion']);
    expect(rowOf('Local Model').button('Turn On Second Opinion').getAttribute('aria-label')).toBeNull();
    expect(foot().buttons()).toEqual(['Turn Off Forecasts']);
    calls = [];
    rowOf('Local Model').button('Turn On Second Opinion').onclick!();
    await settle();
    expect(calls).toEqual([{ url: '/predictions/turn-on', method: 'POST', body: { series: [KEYS.deploys], opinion: true } }]);
    expect(title()).toBe('Turn On Predictions');
    // The number is already on: the card says so, and that only its second opinion changes. It does not say Flint
    // "forecasts 1 of its own numbers each night" as if that began now, nor that turning this on starts the checks.
    expect(body().with('plead').map((e) => e.textContent)).toEqual(['Flint already forecasts this number. Only its second opinion changes.']);
    expect(screen()).not.toMatch(/forecasts 1 of its own numbers|also checks the predictions/);
    ownWords([], ['Flint already forecasts this number. Only its second opinion changes.']);
    expect(headers()).toEqual(['Numbers', 'Second Opinion']);
    expect(rows()).toEqual([['Deploys', [], ''], ['Local Model', [SAYS], '']]);
    plainScreen();
    expect(signed).toEqual([]);
    foot().button('Approve with Touch ID').onclick!();
    await settle();
    expect(signed).toEqual([['prcard9x8y7z', { fresh: true, reason: 'turn on predictions', args: { series: [KEYS.deploys], reason: [KEYS.deploys] } }]]);
    // No local model: the runtime's sentence says so, and nothing is offered.
    run('closePredictions()');
    await openNumber({ on: false, says: 'No local model is set on this Mac.', offer: false });
    expect(rowOf('Local Model').children[0]!.children[1]!.textContent).toBe('No local model is set on this Mac.');
    expect(rowOf('Local Model').buttons()).toEqual([]);
    // A device with no approval key files nothing.
    run('closePredictions()');
    keyed = false;
    await openNumber({ on: false, says: 'The local model doesn’t estimate this number.', offer: true });
    calls = [];
    rowOf('Local Model').button('Turn On Second Opinion').onclick!();
    await settle();
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
    expect(foot().buttons()).toEqual(['Open Settings']);
  });

  it('the card from the sheet is for numbers that are off: it says what turning them on does, whatever the second opinion switch says', async () => {
    await sheet(offPage({ secondOpinion: true }));
    opinionSwitch()!.onclick!({ stopPropagation: () => {} });
    routes = answers({ 'POST /predictions/turn-on': { status: 200, body: { id: 'prcard9x8y7z', deduped: false } } });
    foot().button('Continue').onclick!();
    await settle();
    const leads = body().with('plead').map((e) => e.textContent);
    expect(leads).toHaveLength(2);
    expect(leads[0]).toMatch(/^Flint forecasts \d+ of its own numbers each night, on this Mac\.$/);
    expect(leads[1]).toBe('Turning this on also checks the predictions Flint has already made, and those results can’t be undone.');
    expect(screen()).not.toMatch(/already forecasts/);
  });

  it('a runtime from before second opinions sends a number with no word of one: the view is as it was, with one button', async () => {
    const n = onPage().numbers[2]!;
    const { opinion: _none, ...older } = seriesOf(n);
    expect('opinion' in older).toBe(false);
    routes = answers({ [`GET /predictions/series/${KEYS.deploys}`]: { status: 200, body: { series: older } } });
    await open();
    rowOf('Deploys').onclick!();
    await settle();
    expect(title()).toBe('Deploys');
    expect(headers()).toEqual(['Forecast', 'Chance', 'Record']);
    expect(screen()).not.toMatch(/Second Opinion|Local Model|undefined/);
    expect(foot().buttons()).toEqual(['Turn Off Forecasts']);
    plainScreen();
    // And a page with no word of a local model offers no switch on the sheet.
    const { secondOpinion: _no, ...page } = offPage({ secondOpinion: true }) as Record<string, unknown>;
    expect('secondOpinion' in page).toBe(false);
    await sheet(page);
    expect(headers()).toEqual(['Numbers to Forecast']);
    expect(opinionSwitch()).toBeUndefined();
  });
});

describe('Questions', () => {
  const SECOND_SAID = 'Flint said unlikely, around 20%, on Oct 5. It was due Oct 7 at 9:00 AM.';
  const second = question({ id: 'pdq2zzz999', title: 'Deploys ran above 4.', says: SECOND_SAID });
  const questions = async (page: Record<string, unknown>, over: Partial<Record<string, { status: number; body: unknown }>> = {}) => {
    routes = answers({ 'GET /predictions/questions': { status: 200, body: { offHere: false, ...page } }, ...over });
    await open('questions');
  };
  const acts = (label: string) => rowOf(label).children.find((c) => c.className === 'pacts')!;
  const choices = (label: string) => acts(label).children.map((b) => [b.tagName, b.className, b.textContent]);
  /** The page's clock, in the test's hands: a tap is this long after the one before it. */
  const later = (ms: number) => run(`PRED_T+=${ms}`);
  /** Tap a row's choice, wait past the double-tap guard, and tap the button that records it. */
  const record = (label: string, choice: string) => {
    acts(label).children.find((b) => b.textContent === choice)!.onclick!();
    later(1000);
    acts(label).children[1]!.onclick!();
  };
  beforeEach(() => {
    run('var PRED_T=1000000;predNow=function(){return PRED_T;};');
  });

  it('each question is the prediction as text, what Flint said, when, and when it was due, and one clear choice: Yes, No or Skip', async () => {
    await questions({ waiting: [question(), second], answered: [] });
    expect(body().visible().find((e) => e.id === 'predtab-questions')!.getAttribute('aria-selected')).toBe('true');
    expect(headers()).toEqual(['For You']);
    // The second line is the runtime's, as sent: it ends with when the prediction was due, the moment his answer is recorded as of.
    expect(rows()).toEqual([['The <b>deploy</b> lands by Friday', [SAID], ''], ['Deploys ran above 4.', [SECOND_SAID], '']]);
    // Yes and No are outlined buttons; Skip is the quiet one.
    for (const q of [question(), second]) expect(choices(q.title)).toEqual([['button', 'btn', 'Yes'], ['button', 'btn', 'No'], ['button', 'ghost', 'Skip']]);
    // What an answer means, and that it is for good, is said under the list.
    expect(body().with('gnote').map((e) => e.textContent)).toEqual(['Yes means it happened. Skip leaves it unscored. An answer can’t be changed.']);
    // The tab says how many wait.
    expect(body().visible().find((e) => e.id === 'predqn')!.textContent).toBe('2');
    plainScreen();
    ownWords(['For You', 'Yes', 'No', 'Skip', 'Questions'], ['Yes means it happened. Skip leaves it unscored. An answer can’t be changed.']);
    // Yes and No are not side by side at 4 px: the choices sit 8 px apart.
    expect(html).toContain('.pacts{display:flex;align-items:center;gap:8px;flex:none;}');
  });

  it('no answer is recorded on one tap: the first arms the row (the other choices go), Cancel puts them back, and only the second records', async () => {
    await questions({ waiting: [question(), second], answered: [] });
    calls = [];
    for (const [choice, armed] of [['Yes', 'Record Yes'], ['No', 'Record No'], ['Skip', 'Skip for Good']] as const) {
      acts(question().title).children.find((b) => b.textContent === choice)!.onclick!();
      // Armed: Cancel, and the one thing a second tap will record. The other choices are gone, and nothing was sent.
      expect(choices(question().title), choice).toEqual([['button', 'ghost', 'Cancel'], ['button', 'btn pri', armed]]);
      expect(calls).toEqual([]);
      // The cursor is on Cancel: a second Enter cancels, it does not record.
      expect(focused?.textContent).toBe('Cancel');
      // The other row is as it was.
      expect(choices(second.title)).toEqual([['button', 'btn', 'Yes'], ['button', 'btn', 'No'], ['button', 'ghost', 'Skip']]);
      later(1000);
      acts(question().title).children[0]!.onclick!();
      expect(choices(question().title), choice).toEqual([['button', 'btn', 'Yes'], ['button', 'btn', 'No'], ['button', 'ghost', 'Skip']]);
    }
    await settle();
    expect(calls).toEqual([]);
    expect(rows()[0]).toEqual(['The <b>deploy</b> lands by Friday', [SAID], '']);
    ownWords(['Cancel', 'Record Yes', 'Record No', 'Skip for Good'], []);
  });

  it('a double tap does not record: the second tap of one, landing on the armed button at once, is not taken for the second', async () => {
    await questions({ waiting: [question()], answered: [] });
    calls = [];
    expect(run('PRED_ARM_MS')).toBe(400);
    acts(question().title).children[0]!.onclick!();
    // The same instant, and a little after: still inside the double tap.
    acts(question().title).children[1]!.onclick!();
    later(399);
    acts(question().title).children[1]!.onclick!();
    await settle();
    expect(calls).toEqual([]);
    expect(choices(question().title)).toEqual([['button', 'ghost', 'Cancel'], ['button', 'btn pri', 'Record Yes']]);
    // A deliberate second tap records it.
    later(1);
    acts(question().title).children[1]!.onclick!();
    await settle();
    expect(calls).toEqual([{ url: `/predictions/questions/${QID}/answer`, method: 'POST', body: { answer: 'yes' } }]);
  });

  it('the second tap is one unsigned POST; the row then says it was recorded, with what he answered, and the rest stays put', async () => {
    for (const [choice, answer, value] of [['Yes', 'yes', 'Yes'], ['No', 'no', 'No'], ['Skip', 'skip', 'Skipped']] as const) {
      await questions({ waiting: [question(), second], answered: [] });
      calls = [];
      acts(question().title).children.find((b) => b.textContent === choice)!.onclick!();
      later(1000);
      const [cancel, go] = acts(question().title).children;
      go!.onclick!();
      // Neither button of the armed row takes another tap while it is on its way, and no other row can be armed.
      expect([cancel!.disabled, go!.disabled]).toEqual([true, true]);
      go!.onclick!();
      cancel!.onclick!();
      acts(second.title).children[0]!.onclick!();
      expect(choices(second.title)).toEqual([['button', 'btn', 'Yes'], ['button', 'btn', 'No'], ['button', 'ghost', 'Skip']]);
      await settle();
      expect(calls).toEqual([{ url: `/predictions/questions/${QID}/answer`, method: 'POST', body: { answer } }]);
      expect(AnswerBody.safeParse(calls[0]!.body).success).toBe(true);
      expect(signed).toEqual([]);
      expect(rows()).toEqual([['The <b>deploy</b> lands by Friday', ['Flint recorded your answer.'], value], ['Deploys ran above 4.', [SECOND_SAID], '']]);
      expect(rowOf(question().title).children.some((c) => c.className === 'pacts')).toBe(false);
      expect(acts(second.title).children.map((b) => b.disabled)).toEqual([false, false, false]);
      expect(body().visible().find((e) => e.id === 'predqn')!.textContent).toBe('1');
      expect(said()).toBeNull();
    }
    ownWords(['Skipped'], ['Flint recorded your answer.']);
  });

  it('a prediction Flint cannot say plainly offers Skip and nothing else, and Skip is armed like any other', async () => {
    await questions({ waiting: [UNSAID, question()], answered: [] });
    expect(rows()[0]).toEqual(['Flint made this prediction in a chat.', ['Flint can’t show what this one was about, so it can only be skipped.'], '']);
    expect(choices(UNSAID.title)).toEqual([['button', 'ghost', 'Skip']]);
    expect(choices(question().title)).toEqual([['button', 'btn', 'Yes'], ['button', 'btn', 'No'], ['button', 'ghost', 'Skip']]);
    // Only a row the runtime marks answerable offers Yes and No: a row that does not say is treated as one that is not.
    await questions({ waiting: [{ ...question(), answerable: undefined }, { ...question({ id: 'pdq3', title: 'Third' }), answerable: 'yes' }], answered: [] });
    expect(choices(question().title)).toEqual([['button', 'ghost', 'Skip']]);
    expect(choices('Third')).toEqual([['button', 'ghost', 'Skip']]);
    await questions({ waiting: [UNSAID], answered: [] });
    calls = [];
    acts(UNSAID.title).children[0]!.onclick!();
    expect(choices(UNSAID.title)).toEqual([['button', 'ghost', 'Cancel'], ['button', 'btn pri', 'Skip for Good']]);
    later(1000);
    acts(UNSAID.title).children[1]!.onclick!();
    await settle();
    expect(calls).toEqual([{ url: `/predictions/questions/${UNSAID.id}/answer`, method: 'POST', body: { answer: 'skip' } }]);
    expect(rows()[0]).toEqual(['Flint made this prediction in a chat.', ['Flint recorded your answer.'], 'Skipped']);
  });

  it('switched off on this Mac: the questions are listed, and none can be answered; the page says why', async () => {
    await questions({ waiting: [question(), UNSAID], answered: [question({ id: 'pdq4', answer: 'yes', says: 'You said yes on Oct 12.' })], offHere: true });
    expect(rows().slice(0, 2)).toEqual([['The <b>deploy</b> lands by Friday', [SAID], ''], [UNSAID.title, [UNSAID.says], '']]);
    expect(body().visible().filter((e) => e.className === 'pacts')).toEqual([]);
    expect(body().buttons().filter((b) => !['Forecasts', 'Questions', 'Accuracy'].includes(b))).toEqual([]);
    expect(body().with('gnote').map((e) => e.textContent)).toEqual(['Predictions are switched off on this Mac.']);
    // Nothing is said to wait where nothing can be answered.
    expect(body().visible().find((e) => e.id === 'predqn')).toBeUndefined();
  });

  it('answered already, no longer open, not answerable that way or switched off: the list is read again and the footer says why; any other failure leaves the armed choice', async () => {
    for (const [status, code] of [[409, 'answered'], [404, 'noQuestion'], [409, 'unanswerable'], [409, 'offHere']] as const) {
      await questions({ waiting: [question()], answered: [] }, { [`POST /predictions/questions/${QID}/answer`]: { status, body: { error: PREDICT_SAYS[code], code } } });
      calls = [];
      record(question().title, 'Yes');
      await settle();
      expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([`POST /predictions/questions/${QID}/answer`, 'GET /predictions/questions']);
      expect(said()).toEqual([PREDICT_SAYS[code], 'res bad']);
    }
    await questions({ waiting: [question()], answered: [] }, { [`POST /predictions/questions/${QID}/answer`]: { status: 504, body: { error: PREDICTIONS_SAY.unsure } } });
    record(question().title, 'No');
    await settle();
    expect(said()).toEqual(['Flint isn’t sure it went through. Check Predictions before trying again.', 'res bad']);
    // Still armed, and both buttons take a tap again: he can try once more, or cancel.
    expect(choices(question().title)).toEqual([['button', 'ghost', 'Cancel'], ['button', 'btn pri', 'Record No']]);
    expect(acts(question().title).children.map((b) => b.disabled)).toEqual([false, false]);
    expect(rows()[0]![1]).toEqual([SAID]);
    acts(question().title).children[0]!.onclick!();
    expect(choices(question().title)).toEqual([['button', 'btn', 'Yes'], ['button', 'btn', 'No'], ['button', 'ghost', 'Skip']]);
    expect(said()).toBeNull();
  });

  it('none waiting: it says so; what he answered is listed under ANSWERED with what he said', async () => {
    await questions({ waiting: [], answered: [] });
    expect(body().with('empty').map((e) => e.children.map((c) => c.textContent))).toEqual([['No Questions', 'No questions are waiting.']]);
    expect(headers()).toEqual([]);
    await questions({ waiting: [], answered: [question({ answer: 'yes', says: 'You said yes on Oct 12.' }), question({ id: 'pdq3', title: 'Second', answer: 'skip', says: 'You skipped it on Oct 11.' })] });
    expect(headers()).toEqual(['For You', 'Answered']);
    expect(rows()).toEqual([['', ['No questions are waiting.'], ''], ['The <b>deploy</b> lands by Friday', ['You said yes on Oct 12.'], 'Yes'], ['Second', ['You skipped it on Oct 11.'], 'Skipped']]);
    expect(body().visible().filter((e) => e.className === 'pacts')).toEqual([]);
    expect(body().with('gnote')).toEqual([]);
    expect(body().visible().find((e) => e.id === 'predqn')).toBeUndefined();
    ownWords(['No Questions', 'Answered'], ['No questions are waiting.']);
  });

  it('an answer that lands after he has gone elsewhere neither throws nor pulls him back, and writes nothing into the view he is in', async () => {
    await questions({ waiting: [question(), second], answered: [] });
    record(question().title, 'Yes');
    // He goes to another tab, which has something to say in its footer, before the answer lands.
    run("predTab('accuracy','It’s waiting in Approvals.','ok')");
    await settle();
    expect(body().visible().find((e) => e.id === 'predtab-accuracy')!.getAttribute('aria-selected')).toBe('true');
    expect(headers()).toEqual(['How Flint Has Done', 'Left Unsettled']);
    // The late answer cleared no message of this view, and counted nothing down in it.
    expect(said()).toEqual(['It’s waiting in Approvals.', 'res ok']);
    expect(run('PRED.questions')).toBe(2);
    // And one that lands after the panel was closed.
    await questions({ waiting: [question()], answered: [] });
    record(question().title, 'Skip');
    run('closePredictions()');
    await settle();
    expect(panels.predictions).toBe(false);
    expect(run('PRED.busy')).toBe(false);
    expect(body().shown()).toBe('');
  });
});

describe('Accuracy', () => {
  it('each area with its results in sentences, then what was left unsettled; too little data says how much there is', async () => {
    routes = answers();
    await open('accuracy');
    expect(headers()).toEqual(['How Flint Has Done', 'Left Unsettled']);
    expect(rows()).toEqual([
      ['Spend', ACCURACY.areas[0]!.lines, '161 Scored'],
      ['Deploys', ['Flint has 12 of the 30 results it needs for its ranges.'], '12 Scored'],
      ['', ['3 predictions ran out before they could be checked.'], ''],
      ['', ['1 was set aside with your approval.'], ''],
    ]);
    for (const r of body().with('row')) expect([r.tabIndex, r.onclick], r.textContent).toEqual([-1, null]);
    expect(body().with('gnote')).toEqual([]);
    plainScreen();
    ownWords(['How Flint Has Done', 'Left Unsettled', 'Accuracy'], []);
  });

  it('nothing scored yet is said as what it is: "each night" only when something scores them each night', async () => {
    const empty = (scoring: string) => ({ 'GET /predictions/accuracy': { status: 200, body: { scored: false, scoring, areas: [], unsettled: [] } } });
    routes = answers(empty('on'));
    await open('accuracy');
    expect(body().with('empty').map((e) => e.children.map((c) => c.textContent))).toEqual([['No Results Yet', 'Flint scores its predictions each night, once they come due.']]);
    // Never turned on: nothing scores them, and it says how that changes.
    routes = answers(empty('not_started'));
    await open('accuracy');
    expect(body().with('empty').map((e) => e.children.map((c) => c.textContent))).toEqual([['Predictions Are Off', 'Flint scores its predictions once you turn them on.']]);
    // Switched off on this Mac.
    routes = answers(empty('off_here'));
    await open('accuracy');
    expect(body().with('empty').map((e) => e.children.map((c) => c.textContent))).toEqual([['Predictions Are Off', 'Predictions are switched off on this Mac.']]);
    for (const scoring of ['not_started', 'off_here']) {
      routes = answers(empty(scoring));
      await open('accuracy');
      expect(screen(), scoring).not.toContain('each night');
    }
    // Scores from before the switch went off are still shown, with a line that says nothing updates them.
    routes = answers({ 'GET /predictions/accuracy': { status: 200, body: { ...ACCURACY, scoring: 'off_here' } } });
    await open('accuracy');
    expect(body().with('gnote').map((e) => e.textContent)).toEqual(['Predictions are switched off on this Mac.']);
    expect(headers()).toEqual(['How Flint Has Done', 'Left Unsettled']);
    routes = answers({ 'GET /predictions/accuracy': { status: 200, body: { ...ACCURACY, unsettled: [] } } });
    await open('accuracy');
    expect(rows().at(-1)).toEqual(['', ['Nothing was left unsettled.'], '']);
    ownWords(['No Results Yet', 'Predictions Are Off'], ['Flint scores its predictions each night, once they come due.', 'Flint scores its predictions once you turn them on.', 'Nothing was left unsettled.']);
  });
});

describe('closing, the keyboard and long words', () => {
  it('closing drops what the panel holds: the numbers leave the page and its memory, and a read still on its way is not drawn', async () => {
    routes = answers();
    await open();
    expect(rows().length).toBeGreaterThan(0);
    expect(run('PRED.page')).not.toBeNull();
    run('closePredictions()');
    expect(body().shown()).toBe('');
    expect(body().children).toEqual([]);
    expect(foot().hidden).toBe(true);
    expect(foot().shown()).toBe('');
    expect([run('PRED.page'), run('PRED.series'), run('PRED.picked')]).toEqual([null, null, null]);
    // Closed while the page is still being read: its answer is dropped, not drawn into the hidden panel.
    run('openPredictions()');
    run('closePredictions()');
    await settle();
    expect(body().shown()).toBe('');
    expect(run('PRED.page')).toBeNull();
    // The same for one number, and for the questions.
    await open();
    run(`predSeries('${KEYS.anthropic}')`);
    run('closePredictions()');
    await settle();
    expect(body().shown()).toBe('');
    expect(run('PRED.series')).toBeNull();
    routes = answers({ 'GET /predictions/questions': { status: 200, body: { waiting: [question()], answered: [], offHere: false } } });
    run("PRED.tab='questions';openPredictions()");
    run('closePredictions()');
    await settle();
    expect(screen()).not.toContain('deploy');
    // Opened again, it reads again.
    calls = [];
    await open('forecasts');
    expect(calls.map((c) => c.url)).toContain('/predictions');
    expect(rows().length).toBeGreaterThan(0);
  });

  it('the cursor goes into the dialog and follows what is drawn; Space on a row opens it without scrolling the page', async () => {
    routes = answers();
    await open();
    // On opening, and on each change of tab, the cursor is on the tab that is shown.
    expect(focused?.id).toBe('predtab-forecasts');
    run("predTab('accuracy')");
    expect(focused?.id).toBe('predtab-accuracy');
    await settle();
    // Into one number, the sheet and the card: on Back.
    run("predTab('forecasts')");
    await settle();
    let prevented = 0;
    // Tab moves on as it always does; Space opens the row, and the page behind does not scroll.
    rowOf('Deploys').onkeydown!({ key: 'Tab', preventDefault: () => void prevented++ } as never);
    expect(prevented).toBe(0);
    rowOf('Deploys').onkeydown!({ key: ' ', preventDefault: () => void prevented++ } as never);
    expect(prevented).toBe(1);
    await settle();
    expect(title()).toBe('Deploys');
    expect(focused?.id).toBe('predback');
    focused = null;
    run(`predSheet(['${KEYS.nexus}'])`);
    expect(focused?.id).toBe('predback');
    // Nothing takes the cursor while the panel is closed.
    run('closePredictions()');
    focused = null;
    run('predProbe()');
    await settle();
    expect(focused).toBeNull();
  });

  it('a long title with no place to break wraps inside its row, on every line of the panel', () => {
    expect(html).toContain('#predbody .lbl b,#predbody .lbl span,#predbody .plead,#predbody .empty span{overflow-wrap:anywhere;}');
    // The rows the panel draws are the wrapping kind (not the one-line, cut-short kind the page's plain rows are).
    expect(html).toContain('.gwrap .lbl b,.gwrap .lbl span{white-space:normal;overflow:visible;}');
    const code = predJs.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(code).toContain("var row=gEl('div','row two gwrap'");
  });
});

describe('when it cannot load', () => {
  it('a runtime that is down, an older one, a rejected token and any other failure are each said, on every tab', async () => {
    for (const tab of ['forecasts', 'questions', 'accuracy']) {
      const path = tab === 'forecasts' ? '/predictions' : `/predictions/${tab}`;
      routes = answers({ [`GET ${path}`]: { status: 503, body: { error: PREDICTIONS_SAY.down } } });
      await open(tab);
      expect(body().with('empty').map((e) => e.children.map((c) => c.textContent)), tab).toEqual([['Couldn’t Load Predictions', 'The runtime isn’t answering, so predictions can’t load.', 'Try Again']]);
      // Try Again asks once more, and shows what comes back.
      routes = answers();
      calls = [];
      body().button('Try Again').onclick!();
      await settle();
      expect(calls).toEqual([{ url: path, method: 'GET', body: undefined }]);
      expect(screen(), tab).not.toContain('Couldn’t Load Predictions');
    }
    // The console's sentences are the server's own for the same failures.
    expect(predJs).toContain(`'${PREDICTIONS_SAY.down}'`);
    expect(predJs).toContain(`'${PREDICTIONS_SAY.older}'`);
    routes = answers({ 'GET /predictions': { status: 501, body: { error: PREDICTIONS_SAY.older } } });
    await open('forecasts');
    expect(body().with('empty')[0]!.children.map((c) => c.textContent)).toEqual(['Couldn’t Load Predictions', 'This needs a newer runtime.', 'Try Again']);
    expect(ids.predbtn!.hidden).toBe(true);
    routes = answers({ 'GET /predictions': { status: 502, body: { error: PREDICTIONS_SAY.unreadable, ref: 'ref123' } } });
    await open('forecasts');
    expect(body().with('empty')[0]!.children.map((c) => c.textContent)).toEqual(['Couldn’t Load Predictions', 'The runtime sent an answer Flint can’t read.', 'Try Again']);
    ownWords(['Couldn’t Load Predictions', 'Try Again'], [PREDICTIONS_SAY.down, PREDICTIONS_SAY.older]);
  });

  it('signed out: it says so, and its one button opens Settings', async () => {
    routes = answers({ 'GET /predictions': { status: 401, body: { error: 'unauthorized' } } });
    await open('forecasts');
    expect(body().with('empty').map((e) => e.children.map((c) => c.textContent))).toEqual([['You’re Signed Out', 'Enter your access token in Settings to see predictions.', 'Open Settings']]);
    expect(screen()).not.toContain('unauthorized');
    // Nothing stale is left beside the tabs: no count of questions he can't see.
    expect(body().visible().find((e) => e.id === 'predqn')).toBeUndefined();
    body().button('Open Settings').onclick!();
    expect(panels).toMatchObject({ predictions: false, settings: true });
    ownWords(['You’re Signed Out', 'Open Settings'], ['Enter your access token in Settings to see predictions.']);
    // One number that fails to load says so too, and can be tried again.
    routes = answers({ [`GET /predictions/series/${KEYS.deploys}`]: { status: 503, body: { error: PREDICTIONS_SAY.down } } });
    await open('forecasts');
    run(`predSeries('${KEYS.deploys}')`);
    await settle();
    expect(body().with('empty')[0]!.children.map((c) => c.textContent)).toEqual(['Couldn’t Load Predictions', 'The runtime isn’t answering, so predictions can’t load.', 'Try Again']);
    expect(ids.predback!.hidden).toBe(false);
  });
});

describe('the script itself', () => {
  const code = predJs.replace(/\/\*[\s\S]*?\*\//g, '');

  it('is ES5, writes text only, and keeps nothing: no storage, no cookie, no log line, no number in a query', () => {
    expect(code).not.toMatch(/=>|`|\blet\b|\bconst\b|\bclass\b|\.\.\.|\basync\b|\bawait\b/);
    expect(code).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/);
    expect(code).not.toMatch(/localStorage|sessionStorage|document\.cookie|indexedDB|console\.|navigator\.sendBeacon/);
    expect(code).not.toMatch(/\bconfirm\(|\balert\(|\bprompt\(/);
    // Every request is one of the panel's eight, and none carries anything in a query.
    expect(code).not.toMatch(/\?[a-z]+=|[&?]series=|[&?]answer=/);
    expect([...code.matchAll(/'(\/predictions[^']*)'/g)].map((m) => m[1]).sort()).toEqual(['/predictions', '/predictions/accuracy', '/predictions/questions', '/predictions/questions/', '/predictions/series/', '/predictions/series/', '/predictions/series/', '/predictions/turn-on', '/predictions/waiting']);
    // The three under a number's key: read it, turn it off, and turn its second opinion off.
    expect([...code.matchAll(/encodeURIComponent\((?:n\.)?key\)(?:\+'(\/[a-z-]+)')?/g)].map((m) => m[1] ?? '').sort()).toEqual(['', '/second-opinion-off', '/turn-off']);
    // It reaches the server only through the Goals panel's one caller, which sends the console's token.
    expect(code).not.toMatch(/\bfetch\(|XMLHttpRequest|WebSocket|EventSource/);
  });

  it('writes no sentence about a number, a chance or a score: those words are the runtime\'s, so the panel cannot say a number it was not sent', () => {
    for (const words of ['Flint expects', 'reliable trend', 'plain guess', 'isn’t in yet', 'of history', 'hasn’t changed', 'has no data', 'ranges held', 'Flint said', 'around ', 'of the time', 'Scored', 'ran out']) expect(code, words).not.toContain(words);
    // It formats no number at all.
    expect(code).not.toMatch(/toFixed|toLocaleString|Intl\.|Math\.round|toPrecision/);
  });

  it('its numbers are in tabular figures, and on a phone a row\'s choices take a full-height line of their own', () => {
    expect(html).toContain('#predbody{font-variant-numeric:tabular-nums;}');
    expect(html).toMatch(/@media \(max-width:600px\)\{\s*\.row\.gwrap>\.pacts\{flex:1 1 100%;justify-content:flex-end;\} \.pacts \.btn,\.pacts \.ghost\{min-width:72px;justify-content:center;\}/);
    // Its tabs are 44 points tall on a phone, as every other target in it is.
    // A row's own action (the second opinion's) sits under its sentence at the left on a phone: the footer's button is at the right.
    expect(html).toMatch(/@media \(max-width:600px\)\{[^@]*\.row\.gwrap\.pown>\.pacts\{justify-content:flex-start;\} \.pown>\.pacts \.ghost\{margin-left:-10px;\}/);
    expect(html).toContain('#predseg button{height:44px;padding:0 14px;}');
    expect(html).toContain('.xb{width:44px;height:44px;}');
    // The phone's buttons are 44 points tall, and a row at least 48 (the page's own rules, which the panel's rows use).
    expect(html).toContain('.row{min-height:48px;font-size:17px;} .btn,.ghost{height:44px;}');
    expect(html).toMatch(/:focus-visible\{outline:none;box-shadow:0 0 0 2px var\(--bg\),0 0 0 4px var\(--gold-hi\)/);
  });
});
