/**
 * The console's Activity panel and Settings' Health (apps/console/index.html,
 * <script id="lanes-js">), run against a small fake DOM that refuses innerHTML:
 * what the runtime sent is shown as text (an injected title stays inert),
 * outside text is marked, labels and acks go to the server's routes, "Older"
 * pages with `before`, a failure is shown without forgetting the token, the
 * notifications fold repeats and read themselves, Health leads Settings with
 * what needs Will, every line under a title is a sentence, and there is no
 * confirm/alert/prompt anywhere in the console.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { HEALTH_NAMES, SOURCE_NAMES } from '@flint/policy';

const html = readFileSync(join(__dirname, '..', '..', 'console', 'index.html'), 'utf8');
const lanesJs = /<script id="lanes-js">([\s\S]*?)<\/script>/.exec(html)![1]!;
const AT = '2026-10-02T15:00:00.000Z';

/** Just enough DOM for the panel: no innerHTML, ever. */
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
  private readonly classes = new Set<string>();
  constructor(readonly tagName: string, readonly id = '') {}
  readonly classList = {
    add: (c: string) => void this.classes.add(c),
    remove: (c: string) => void this.classes.delete(c),
    toggle: (c: string, on?: boolean) => void ((on ?? !this.classes.has(c)) ? this.classes.add(c) : this.classes.delete(c)),
    contains: (c: string) => this.classes.has(c),
  };
  get textContent(): string {
    return this.text + this.children.map((c) => c.textContent).join('');
  }
  set textContent(v: string) {
    this.children = [];
    this.text = String(v);
  }
  set innerHTML(_v: string) {
    throw new Error('innerHTML is not allowed in the activity panel');
  }
  appendChild(c: El): El {
    this.children.push(c);
    return c;
  }
  querySelectorAll(_sel: string): El[] {
    return this.all().filter((e) => e.tagName === 'button');
  }
  all(): El[] {
    return this.children.flatMap((c) => [c, ...c.all()]);
  }
  button(text: string): El {
    const b = this.all().find((e) => e.tagName === 'button' && e.textContent === text);
    if (!b) throw new Error(`no button "${text}"`);
    return b;
  }
  /** The text of the visible part (hidden boxes left out). */
  shown(): string {
    if (this.hidden) return '';
    return this.text + this.children.map((c) => c.shown()).join('');
  }
}

type Call = { url: string; method: string; body: unknown };
type Answer = { status: number; body: unknown };
let calls: Call[];
let routes: Record<string, (c: Call) => Answer>;
let ids: Record<string, El>;
let stored: Record<string, string>;
let panels: Record<string, boolean>;
let ctx: Record<string, unknown>;

const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};
const run = (code: string) => runInContext(code, ctx);

beforeEach(() => {
  calls = [];
  routes = {};
  panels = {};
  stored = { flint_token: 'tok' };
  ids = Object.fromEntries(
    ['activity', 'nlist', 'nbadge', 'lanelist', 'laneolder', 'lanemsg', 'markread', 'acttab-notifications', 'lanetab-relevant', 'lanetab-quiet', 'sethealth', 'sethealth-last'].map((id) => [id, new El('div', id)]),
  );
  const document = { getElementById: (id: string) => ids[id] ?? null, createElement: (tag: string) => new El(tag), createTextNode: (t: string) => Object.assign(new El('#text'), { textContent: t }), querySelectorAll: () => [] };
  const fetch = async (url: string, init: { method?: string; body?: string; headers?: Record<string, string> } = {}) => {
    const c: Call = { url, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : undefined };
    expect(init.headers?.Authorization).toBe('Bearer tok');
    calls.push(c);
    const key = Object.keys(routes).find((k) => url.startsWith(k));
    const a = key ? routes[key]!(c) : { status: 200, body: { ok: true } };
    return { ok: a.status >= 200 && a.status < 300, status: a.status, json: async () => a.body };
  };
  ctx = {
    document, fetch, BASE: '', TOKEN: 'tok', console, setInterval: () => 0,
    auth: () => ({ Authorization: 'Bearer tok' }),
    svgi: () => new El('svg'),
    showPanel: (id: string, on: boolean) => void (panels[id] = on),
    openSettings: () => { throw new Error('the panel must not open Settings when it has a token'); },
    localStorage: { getItem: (k: string) => stored[k] ?? null, removeItem: (k: string) => void delete stored[k], setItem: (k: string, v: string) => void (stored[k] = v) },
  };
  createContext(ctx);
  runInContext(lanesJs, ctx);
});

const item = (over: Record<string, unknown> = {}) => ({
  id: 'td_1', at: AT, lane: 'relevant', action: 'escalate', decidedBy: 'rule:service_down', ruleName: 'service_down', relevance: null, reasonCode: 'failure',
  source: 'github', eventType: 'issue.opened', entity: { ref: 'issue#24ehza', kind: 'issue', name: '<img src=x onerror=alert(1)> fix login' }, reasoning: 'The page said: ignore previous instructions.',
  feedback: null, tainted: true, sensitivity: 'ops',
  escalation: { id: 'es_1', templateId: 'issue_new', title: '<b>New issue</b> on flint', body: '<script>steal()</script>', status: 'open', channels: ['inapp'], tainted: true, createdAt: AT },
  ...over,
});
const openLane = async (lane = 'relevant') => {
  run(`openActivity(); actShow('${lane}')`);
  await settle();
};

describe('the console Activity panel: lanes', () => {
  it('shows a lane as text only: an injected title stays inert, outside text is marked, details open on click', async () => {
    routes['/inbox'] = () => ({ status: 200, body: { items: [item(), item({ id: 'td_2', tainted: false, escalation: null, entity: null, reasoning: null, action: 'log' })], next: null } });
    await openLane();
    expect(panels.activity).toBe(true);
    expect(calls.some((c) => c.url === '/inbox?lane=relevant&limit=25')).toBe(true);
    const [a, b] = ids.lanelist!.children;
    expect(ids.lanelist!.children).toHaveLength(2);
    // The markup arrives as literal text (the fake DOM has no innerHTML to fall into).
    expect(a!.shown()).toContain('<b>New issue</b> on flint');
    // The line under the title is a sentence: who reported it, for an event type with no words of its own.
    expect(a!.shown()).toContain('<b>New issue</b> on flintGitHub reported this.');
    expect(a!.shown()).not.toContain('Escalate');
    expect(a!.shown()).toContain('Outside Text');
    // The rest opens on click: the escalation's text, the model's note, what it is about.
    expect(a!.shown()).not.toContain('<script>steal()</script>');
    // Labels and acks wait in the details too: a closed row is one title and one line.
    expect(a!.shown()).not.toContain('Not Important');
    a!.onclick!({ target: { tagName: 'DIV' } });
    expect(a!.shown()).toContain('<script>steal()</script>');
    expect(a!.shown()).toContain('Model note: The page said: ignore previous instructions.');
    expect(a!.shown()).toContain('It’s waiting on you.');
    // Internal values (the decider, a relevance score, an entity's ref) are not shown.
    expect(a!.shown()).not.toMatch(/rule:service_down|issue#24ehza|relevance/);
    expect(b!.shown()).not.toContain('Outside Text');
    expect(b!.shown()).toContain('Issue Opened');
    expect(ids['lanetab-relevant']!.classList.contains('on')).toBe(true);
    expect(ids.nlist!.hidden).toBe(true);
    expect(ids.laneolder!.hidden).toBe(true);
  });

  it('a calendar row is in Flint’s words, never its machine name; the invitation’s title only in the details, as outside text', async () => {
    const cal = (id: string, eventType: string, name: string, title?: string) =>
      item({ id, lane: 'quiet', action: 'log', source: 'google_calendar', eventType, escalation: null, reasoning: null, tainted: !!title, entity: { ref: `commitment#${id}`, kind: 'commitment', name, ...(title ? { title } : {}) } });
    routes['/inbox'] = () => ({
      status: 200,
      body: {
        items: [
          cal('c1', 'commitment.state', 'event 2026-10-06 14:00', 'Dinner with <b>Ann</b>'),
          cal('c2', 'commitment.upcoming', 'event 2026-10-09 (all day)'),
          cal('c3', 'deadline.upcoming', 'deadline 2026-10-06'),
          cal('c4', 'commitment.state', 'event 2026-11-01 01:30 CST'),
          cal('c5', 'commitment.state', 'event 2026-10-25 01:30 GMT+1'),
          // A week on, retention clears the link to its event: still the calendar's words.
          { ...cal('c6', 'commitment.upcoming', 'x'), entity: null },
        ],
        next: null,
      },
    });
    await openLane('quiet');
    const [a, b, c, d, e, f] = ids.lanelist!.children;
    expect(a!.shown()).toContain('Event Tue Oct 6 at 14:00');
    expect(a!.shown()).toContain('Event Tue Oct 6 at 14:00An event on your calendar changed.');
    expect(a!.shown()).toContain('Outside Text');
    expect(a!.shown()).not.toMatch(/event 2026|commitment state|Dinner/);
    a!.onclick!({ target: { tagName: 'DIV' } });
    expect(a!.shown()).toContain('Invitation title: Dinner with <b>Ann</b>');
    expect(b!.shown()).toContain('Event Fri Oct 9, All Day');
    expect(b!.shown()).toContain('An event on your calendar is coming up.');
    expect(c!.shown()).toContain('Deadline Tue Oct 6');
    expect(c!.shown()).toContain('A deadline on your calendar is due soon.');
    // In the hour a fall-back repeats, the zone tells the two apart.
    expect(d!.shown()).toContain('Event Sun Nov 1 at 01:30 CST');
    expect(e!.shown()).toContain('Event Sun Oct 25 at 01:30 GMT+1');
    expect(f!.shown()).toContain('Coming Up');
    expect(f!.shown()).not.toContain('Commitment Upcoming');
    // Another source's names are its own.
    expect(run(`calName('event soon')`)).toBe('');
  });

  it('the line under each row is a sentence for every event type, and who reported it otherwise', () => {
    const line = (source: string, eventType: string) => run(`laneLine(${JSON.stringify({ source, eventType })})`) as string;
    expect(line('github', 'ci_run.state')).toBe('A CI run changed.');
    expect(line('github', 'pull_request.state')).toBe('A pull request changed.');
    expect(line('github', 'issue.state')).toBe('An issue changed.');
    expect(line('git', 'repo.head')).toBe('A repo’s latest commit changed.');
    expect(line('health', 'service.health')).toBe('A service’s health changed.');
    expect(line('nexus', 'thread.state')).toBe('A Nexus thread changed.');
    expect(line('knowledge', 'knowledge.fact')).toBe('Flint’s memory learned something.');
    expect(line('runtime', 'backup.stale')).toBe('Backups are overdue.');
    expect(line('runtime', 'source.circuit_open')).toBe('A source stopped after repeated failures.');
    expect(line('google_calendar', 'person.seen')).toBe('Someone is on an event you accepted or organized.');
    expect(line('google_calendar', 'deadline.state')).toBe('A deadline on your calendar changed.');
    expect(line('deploy', 'gate.failed')).toBe('A deploy failed.');
    expect(line('deploy', 'deploy.ok')).toBe('A deploy finished.');
    expect(line('railway', 'volume.railway')).toBe('Railway reported this.');
    expect(line('some_source', 'odd.thing')).toBe('Some Source reported this.');
    // Health's row names are not the sentence's: they stay as they are.
    expect(run(`healthName('source:github')`)).toBe('GitHub');
    for (const t of Object.keys(run('LANE_LINES') as Record<string, string>)) expect(line('x', t)).toMatch(/^[A-Z].*\.$/);
  });

  it('an escalation says where it stands, in a sentence', async () => {
    const es = (status: string) => item({ id: `td_${status}`, escalation: { ...item().escalation, id: `es_${status}`, status } });
    routes['/inbox'] = () => ({ status: 200, body: { items: ['acked', 'dismissed', 'acted', 'expired'].map(es), next: null } });
    await openLane();
    const rows = ids.lanelist!.children;
    rows.forEach((r) => r.onclick!({ target: { tagName: 'DIV' } }));
    expect(rows.map((r) => /(You acknowledged it\.|You dismissed it\.|It was acted on\.|It expired\.)/.exec(r.shown())?.[1])).toEqual(['You acknowledged it.', 'You dismissed it.', 'It was acted on.', 'It expired.']);
  });

  it('labels a decision through the feedback route and marks the label chosen', async () => {
    routes['/inbox?'] = () => ({ status: 200, body: { items: [item()], next: null } });
    await openLane();
    const row = ids.lanelist!.children[0]!;
    row.onclick!({ target: { tagName: 'DIV' } });
    row.button('Not Important').onclick!({ stopPropagation() {} });
    await settle();
    expect(calls.at(-1)).toEqual({ url: '/inbox/td_1/feedback', method: 'POST', body: { feedback: 'should_be_quiet' } });
    expect(row.button('Not Important').classList.contains('on')).toBe(true);
    // Two plain choices per row: the one that disagrees with the lane, and Correct.
    expect(() => row.button('Important')).toThrow();
    expect(row.button('Correct').classList.contains('on')).toBe(false);
  });

  it('acknowledges or dismisses an open escalation through its route', async () => {
    routes['/inbox?'] = () => ({ status: 200, body: { items: [item(), item({ id: 'td_3', escalation: { ...item().escalation, id: 'es_3' } })], next: null } });
    await openLane();
    const [a, b] = ids.lanelist!.children;
    a!.button('Acknowledge').onclick!();
    b!.button('Dismiss').onclick!();
    await settle();
    expect(calls.filter((c) => c.method === 'POST').map((c) => `${c.method} ${c.url}`)).toEqual(['POST /escalations/es_1/ack', 'POST /escalations/es_3/dismiss']);
    expect(a!.button('Acknowledged').disabled).toBe(true);
    expect(b!.button('Dismissed').disabled).toBe(true);
  });

  it('pages back with "Older", appending, and switches lanes', async () => {
    let page = 0;
    routes['/inbox?'] = () => (page++ === 0 ? { status: 200, body: { items: [item()], next: '2026-10-01T09:00:00.000Z' } } : page === 2 ? { status: 200, body: { items: [item({ id: 'td_9' })], next: null } } : { status: 200, body: { items: [], next: null } });
    await openLane();
    expect(ids.laneolder!.hidden).toBe(false);
    run('loadLane(true)');
    await settle();
    expect(calls.some((c) => c.url === '/inbox?lane=relevant&limit=25&before=2026-10-01T09%3A00%3A00.000Z')).toBe(true);
    expect(ids.lanelist!.children).toHaveLength(2);
    expect(ids.laneolder!.hidden).toBe(true);
    run("actShow('quiet')");
    await settle();
    expect(calls.at(-1)!.url).toBe('/inbox?lane=quiet&limit=25');
    expect(ids.lanelist!.shown()).toBe('Nothing Else');
  });

  it("shows a failure in the view and keeps the token (a runtime's refusal is the server's 502)", async () => {
    routes['/inbox?'] = () => ({ status: 502, body: { error: 'The runtime rejected Flint’s token. Reinstall the runtime to fix it.' } });
    await openLane();
    expect(ids.lanemsg!.textContent).toBe('The runtime rejected Flint’s token. Reinstall the runtime to fix it.');
    expect(ids.lanemsg!.hidden).toBe(false);
    expect(stored.flint_token).toBe('tok');
    routes['/inbox?'] = () => ({ status: 401, body: { error: 'unauthorized' } });
    run("actShow('quiet')");
    await settle();
    expect(ids.lanemsg!.textContent).toBe('The access token was rejected. Check Settings.');
    expect(stored.flint_token).toBe('tok');
    // No error of its own: the status, in a sentence.
    routes['/inbox?'] = () => ({ status: 504, body: {} });
    run("actShow('relevant')");
    await settle();
    expect(ids.lanemsg!.textContent).toBe('Flint returned error 504.');
  });
});

describe('the console Activity panel: notifications', () => {
  it('never folds Flint’s own notes (two calendar heads-ups read alike), and title-cases past a bracket', async () => {
    const now = Date.now();
    routes['/notifications/read'] = () => ({ status: 200, body: { ok: true } });
    const note = { title: 'On your calendar Tue Oct 6, all day', body: 'An event from your Google Calendar, on Tue Oct 6. Its title is in Activity, under Important.', kind: 'runtime', read: false };
    routes['/notifications'] = () => ({ status: 200, body: { unread: 2, items: [{ id: 'n2', ...note, ts: now - 1000 }, { id: 'n1', ...note, ts: now - 2000 }] } });
    run('openActivity()');
    await settle();
    const text = ids.nlist!.shown();
    expect(text.split('On Your Calendar Tue Oct 6, All Day')).toHaveLength(3);
    expect(text).not.toContain('2 times');
    expect(run(`titleCase('on your calendar (all day) at noon')`)).toBe('On Your Calendar (All Day) at Noon');
    // Any script's first letter, not only a–z.
    expect(run(`titleCase('école of ödeme')`)).toBe('École of Ödeme');
  });

  it('folds repeats, title-cases Flint’s titles, groups by day, and reads itself on opening', async () => {
    const now = Date.now();
    routes['/notifications/read'] = () => ({ status: 200, body: { ok: true } });
    routes['/notifications'] = () => ({
      status: 200,
      body: {
        unread: 3,
        items: [
          { id: 'n3', title: 'Backups waiting for you', body: 'Approve the card to run tonight.', ts: now - 60_000, read: false },
          { id: 'n2', title: 'Action done', body: 'Check What’s Happening Now is done.', ts: now - 3 * 86400_000, read: true },
          { id: 'n1', title: 'Action done', body: 'Check What’s Happening Now is done.', ts: now - 3 * 86400_000 - 1000, read: true },
        ],
      },
    });
    run('openActivity()');
    await settle();
    const text = ids.nlist!.shown();
    expect(text).toContain('Today');
    expect(text).toContain('Backups Waiting for You');
    expect(text).toContain('Earlier');
    expect(text).toContain('Action Done');
    // The count is a sentence of its own after the note's.
    expect(text).toContain('Check What’s Happening Now is done. It happened 2 times.');
    expect(ids.markread!.hidden).toBe(false);
    expect(calls.some((c) => c.url === '/notifications/read' && c.method === 'POST')).toBe(true);
  });

  it('says when there is nothing, and when it could not ask', async () => {
    routes['/notifications'] = () => ({ status: 200, body: { unread: 0, items: [] } });
    run('openActivity()');
    await settle();
    expect(ids.nlist!.shown()).toBe('Nothing New');
    routes['/notifications'] = () => ({ status: 500, body: {} });
    run("actShow('notifications')");
    await settle();
    expect(ids.nlist!.shown()).toContain("Couldn't Load Activity");
  });

  it('the bell shows a dot only while something is unread', async () => {
    routes['/notifications'] = () => ({ status: 200, body: { unread: 2, items: [] } });
    run('pollNotifs()');
    await settle();
    expect(ids.nbadge!.hidden).toBe(false);
    routes['/notifications'] = () => ({ status: 200, body: { unread: 0, items: [] } });
    run('pollNotifs()');
    await settle();
    expect(ids.nbadge!.hidden).toBe(true);
  });
});

describe('Settings: Health', () => {
  const report = (components: unknown[], lastHealthRun = new Date().toISOString()) => () => ({ status: 200, body: { at: AT, instance: null, uptime14d: 0.99, components, lastHealthRun, triage: 'off' } });

  it('leads Settings with what needs Will: a summary, the problems in plain names, the rest folded', async () => {
    routes['/runtime/health'] = report([
      { component: 'postgres', status: 'ok', detail: null, at: AT },
      { component: 'source:github', status: 'down', detail: '<i>The last 5 reads failed.</i> (last at 09:00)', at: AT },
      { component: 'restore_drill', status: 'degraded', detail: 'The last restore test was 9 days ago.', at: AT },
      { component: 'server', status: 'unknown', detail: null, at: AT },
    ]);
    run('loadHealth()');
    await settle();
    const top = ids.sethealth!.shown();
    expect(ids['sethealth-last']!.shown()).toBe('');
    expect(top).toContain('Health');
    expect(top).toContain('3 Issues');
    // Each issue's line is the runtime's sentence (its dot and its place show how bad); markup stays inert.
    expect(top).toContain('GitHub<i>The last 5 reads failed.</i>.');
    expect(top).not.toContain('(last at 09:00)');
    expect(top).toContain('Restore TestThe last restore test was 9 days ago.');
    // An issue with no note of its own says what its status means.
    expect(top).toContain('ServerIt hasn’t reported.');
    expect(top).not.toMatch(/Down ·|Degraded ·/);
    expect(top).toContain('All Components');
    expect(top).not.toContain('Database');
  });

  it('lists a source that set something aside as an issue, by its own name', async () => {
    routes['/runtime/health'] = report([
      { component: 'postgres', status: 'ok', detail: null, at: AT },
      { component: 'source:google_calendar', status: 'degraded', detail: 'The last read skipped an item.', at: AT },
    ]);
    run('loadHealth()');
    await settle();
    const top = ids.sethealth!.shown();
    expect(top).toContain('1 Issue');
    expect(top).toContain('Google Calendar');
    expect(top).toContain('Google CalendarThe last read skipped an item.');
    // A note that is not a sentence yet gets its capital and its stop.
    expect(run(`healthDetail('the last read failed (see ~/.flint/runtime.log)')`)).toBe('The last read failed.');
    expect(run(`healthDetail('done.')`)).toBe('Done.');
  });

  it('names the components as @flint/policy does, so the morning digest says the same names', () => {
    expect(JSON.parse(JSON.stringify(run('HEALTH_NAMES')))).toEqual(HEALTH_NAMES);
    expect(JSON.parse(JSON.stringify(run('SOURCE_NAMES')))).toEqual(SOURCE_NAMES);
  });

  it('sits last, quietly, when all is normal; says when checks stopped', async () => {
    routes['/runtime/health'] = report([{ component: 'postgres', status: 'ok', detail: null, at: AT }]);
    run('loadHealth()');
    await settle();
    expect(ids.sethealth!.shown()).toBe('');
    expect(ids['sethealth-last']!.shown()).toContain('All Systems Normal');
    routes['/runtime/health'] = report([{ component: 'postgres', status: 'ok', detail: null, at: AT }], '2026-10-01T00:00:00.000Z');
    run('loadHealth()');
    await settle();
    expect(ids.sethealth!.shown()).toContain('Checks Stopped');
    expect(ids.sethealth!.shown()).toContain('Last check');
  });

  it('a failure is shown with a way to try again', async () => {
    routes['/runtime/health'] = () => ({ status: 502, body: { error: 'the runtime is not answering' } });
    run('loadHealth()');
    await settle();
    expect(ids.sethealth!.shown()).toContain("Couldn't Load Health");
    expect(ids.sethealth!.shown()).toContain('Try Again');
    expect(stored.flint_token).toBe('tok');
  });
});

describe('the console', () => {
  it("never calls confirm, alert or prompt (the Mac app's web view has none)", () => {
    const code = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]!).join('\n').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(code).not.toMatch(/(^|[^.\w])(alert|confirm|prompt)\s*\(/m);
    expect(code).not.toMatch(/window\.(alert|confirm|prompt)/);
  });

  it('the activity panel never writes HTML', () => {
    expect(lanesJs.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  });
});
