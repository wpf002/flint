/**
 * The console's Activity panel and Settings' Health (apps/console/index.html,
 * <script id="lanes-js">), run against a small fake DOM that refuses innerHTML:
 * what the runtime sent is shown as text (an injected title stays inert),
 * outside text is marked, labels and acks go to the server's routes, "Older"
 * pages with `before`, a failure is shown without forgetting the token, the
 * notifications fold repeats and read themselves and say even an older Flint's
 * notes in plain words (a job by its name, never its action's; no file path),
 * a job failing night after night is one row, Health leads Settings with
 * what needs Will, every line under a title is a sentence, and there is no
 * confirm/alert/prompt anywhere in the console.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { HEALTH_NAMES, JOB_WORDS, SERVICE_SHORT, SERVICE_WORDS, SOURCE_NAMES, jobFailedNote, noteProblems, serviceWords, titleCase } from '@flint/policy';

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
    // The markup arrives as literal text (the fake DOM has no innerHTML to fall into); an escalation's title is
    // one of Flint's own, so it is title-cased like any note's.
    expect(a!.shown()).toContain('<B>new issue</b> on Flint');
    // The line under the title is a sentence: who reported it, for an event type with no words of its own.
    expect(a!.shown()).toContain('<B>new issue</b> on FlintGitHub reported this.');
    expect(a!.shown()).not.toContain('Escalate');
    expect(a!.shown()).toContain('Outside Text');
    // The rest opens on click: the escalation's text, the model's note, what it is about.
    expect(a!.shown()).not.toContain('<script>steal');
    // Labels and acks wait in the details too: a closed row is one title and one line.
    expect(a!.shown()).not.toContain('Not Important');
    a!.onclick!({ target: { tagName: 'DIV' } });
    // Still inert text (a note shows no aside in parentheses, so the call's brackets go).
    expect(a!.shown()).toContain('<script>steal</script>');
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

  it('Important says an escalation an older Flint stored in plain words too: its title and the text in its details', async () => {
    const stored = (id: string, title: string, body: string | null, over: Record<string, unknown> = {}) =>
      item({ id, tainted: false, reasoning: null, entity: null, source: 'runtime', eventType: 'x.y', escalation: { id: `es_${id}`, templateId: 't', title, body, status: 'open', channels: ['inapp'], tainted: false, createdAt: AT }, ...over });
    routes['/inbox'] = () => ({
      status: 200,
      body: {
        items: [
          stored('o1', 'issue.state: your rule ci_red', 'A GitHub event matched your rule “ci_red”.', { source: 'github', eventType: 'issue.state' }),
          stored('o2', 'A database migration failed', 'The runtime’s database update failed and won’t be retried until it’s fixed. A copy of the database from just before it is in ~/FlintBackups/pre-migrate.', { eventType: 'migrate.failed' }),
          stored('o3', 'The server is down', 'The server has been down for 45 minutes. Recovery is somewhat unlikely (~40%) by Oct 2, 5:30 PM.', { eventType: 'service.down_30m' }),
          stored('o4', 'New issue: issue#24ehza', 'Flint flagged it as needing you. It’s in Activity, under Important.', { source: 'github', eventType: 'issue.state' }),
          stored('o5', 'anthropic spend is at its cap', 'Flint has reached its Claude spending cap. Paid calls to it stop until the cap resets or is raised.', { eventType: 'vendor.cap_100' }),
          // Purged: a title only, as the database's forget leaves it.
          stored('o6', 'Something needs a look', null),
          // As this branch writes one: unchanged.
          stored('o7', 'The Last Restore Test Failed', 'The last restore test found 2 tables that differ from the backup, so the backups may not restore.', { eventType: 'drill.failed' }),
        ],
        next: null,
      },
    });
    await openLane();
    const rows = ids.lanelist!.children;
    const shown = rows.map((r) => {
      const [title, line] = r.children[1]!.children;
      r.onclick!({ target: { tagName: 'DIV' } });
      // The escalation's own text is the first line of the details.
      const more = r.children[1]!.children.find((c) => c.className === 'more')!;
      return [title!.textContent, line!.textContent, more.children[0]!.className === 'acts' ? '' : more.children[0]!.textContent];
    });
    expect(shown).toEqual([
      ['Issue State: Your Rule Ci Red', 'An issue changed.', 'A GitHub event matched your rule “ci red”.'],
      ['A Database Migration Failed', 'A database update failed.', 'The runtime’s database update failed and won’t be retried until it’s fixed.'],
      ['The Server Is Down', 'A service has been down for 30 minutes.', 'The server has been down for 45 minutes. Recovery is somewhat unlikely, around 40% by Oct 2, 5:30 PM.'],
      ['New Issue', 'An issue changed.', 'Flint flagged it as needing you. It’s in Activity, under Important.'],
      ['Anthropic Spend Is at Its Cap', 'A vendor reached its spending cap.', 'Flint has reached its Claude spending cap. Paid calls to it stop until the cap resets or is raised.'],
      ['Something Needs a Look', 'Flint reported this.', 'It’s waiting on you.'],
      ['The Last Restore Test Failed', 'A restore test failed.', 'The last restore test found 2 tables that differ from the backup, so the backups may not restore.'],
    ]);
    const text = ids.lanelist!.shown();
    expect(text).not.toMatch(/issue\.state|ci_red|~\/|FlintBackups|\(~40%\)|issue#24ehza/);
    for (const [title, , said] of shown) expect(noteProblems(title!, said!), `${title} / ${said}`).toEqual([]);
  });

  it('an escalation about a service whose title could not name it says which in its line, by the service’s plain name', async () => {
    const down = (id: string, title: string, name: string) =>
      item({ id, tainted: false, reasoning: null, source: 'runtime', eventType: 'service.down_30m', entity: { ref: `service#${id}`, kind: 'service', name }, escalation: { id: `es_${id}`, templateId: 'service_down', title, body: 'A service has been down for more than 30 minutes. It’s in Activity, under Important.', status: 'open', channels: ['inapp'], tainted: false, createdAt: AT } });
    routes['/inbox'] = () => ({
      status: 200,
      body: {
        items: [
          // Field-free words (its name was unfit to show as it is): the row still says which service.
          down('s1', 'A Service Is Down', 'worker-4aef4bf9c2'),
          down('s2', 'A Service Is Down', 'com.nexus.responder'),
          down('s3', 'A Service Is Down', 'trident-api'),
          down('s4', 'A Service Is Down', 'com.flint.server'),
          // The title names it already: the line says what happened, as before.
          down('s5', 'The Server Is Down', 'com.flint.server'),
          down('s6', 'The Trident API Service Is Down', 'trident-api'),
          // Nothing sayable in its name: no line of its own.
          down('s7', 'A Service Is Down', '4aef4bf9c2'),
        ],
        next: null,
      },
    });
    await openLane();
    expect(ids.lanelist!.children.map((r) => r.children[1]!.children[1]!.textContent)).toEqual([
      'It’s about the Worker service.',
      'It’s about Nexus’s Responder service.',
      'It’s about the Trident API service.',
      'It’s about the server.',
      'A service has been down for 30 minutes.',
      'A service has been down for 30 minutes.',
      'A service has been down for 30 minutes.',
    ]);
    expect(ids.lanelist!.shown()).not.toMatch(/4aef4bf9c2|com\.nexus|trident-api|com\.flint/);
    // Only an escalation about a service: any other row's line is its own.
    expect(run(`laneAbout(${JSON.stringify(item({ escalation: null, entity: { ref: 'service#x', kind: 'service', name: 'trident-api' } }))}, 'x')`)).toBe('');
    expect(run(`laneAbout(${JSON.stringify(item())}, 'x')`)).toBe('');
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

  it('an Apple Calendar row (P2.6) is in the same words as Google’s, and anything else from it is Apple Calendar’s', async () => {
    const cal = (id: string, eventType: string, name: string) =>
      item({ id, lane: 'quiet', action: 'log', source: 'apple_calendar', eventType, escalation: null, reasoning: null, tainted: false, entity: { ref: `commitment#${id}`, kind: 'commitment', name } });
    routes['/inbox'] = () => ({
      status: 200,
      body: { items: [cal('a1', 'commitment.state', 'event 2026-10-06 14:00'), cal('a2', 'deadline.upcoming', 'deadline 2026-10-06'), { ...cal('a3', 'commitment.upcoming', 'x'), entity: null }], next: null },
    });
    await openLane('quiet');
    const [a, b, c] = ids.lanelist!.children;
    expect(a!.shown()).toContain('Event Tue Oct 6 at 14:00An event on your calendar changed.');
    expect(a!.shown()).not.toMatch(/event 2026|commitment state|apple calendar|Apple_calendar/);
    expect(b!.shown()).toContain('Deadline Tue Oct 6A deadline on your calendar is due soon.');
    expect(c!.shown()).toContain('Coming Up');
    expect(c!.shown()).toContain('An event on your calendar is coming up.');
    const line = (eventType: string) => run(`laneLine(${JSON.stringify({ source: 'apple_calendar', eventType })})`) as string;
    expect(line('person.seen')).toBe('Someone is on an event you accepted or organized.');
    expect(line('odd.thing')).toBe('Apple Calendar reported this.');
    expect(run(`healthName('source:apple_calendar')`)).toBe('Apple Calendar');
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
          { id: 'n2', title: 'Action done', body: 'Flint checked what’s happening now.', ts: now - 3 * 86400_000, read: true },
          { id: 'n1', title: 'Action done', body: 'Flint checked what’s happening now.', ts: now - 3 * 86400_000 - 1000, read: true },
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
    expect(text).toContain('Flint checked what’s happening now. It happened 2 times.');
    expect(ids.markread!.hidden).toBe(false);
    expect(calls.some((c) => c.url === '/notifications/read' && c.method === 'POST')).toBe(true);
  });

  /** The list as Will reads it: each row's title, the line under it and its time; the day headers left out. */
  const noteRows = () =>
    ids.nlist!.children.filter((r) => r.className.startsWith('frow')).map((r) => ({ title: r.children[1]!.children[0]!.textContent, line: r.children[1]!.children[1]!.textContent, when: r.children[2]!.textContent, read: r.className.includes('read') }));
  const showNotes = async (items: Array<Record<string, unknown>>) => {
    routes['/notifications/read'] = () => ({ status: 200, body: { ok: true } });
    routes['/notifications'] = () => ({ status: 200, body: { unread: items.filter((n) => !n.read).length, items: items.map((n, i) => ({ id: `n${items.length - i}`, read: false, ...n })) } });
    run("actShow('notifications')");
    await settle();
    return noteRows();
  };
  const NIGHT = 86_400_000;
  /** What an older Flint stored for a nightly job that failed: the action's name for a title, and a file path under it. */
  const oldFailure = (action: string, words: string, ts: number, read = true) => ({ title: `${action} failed`, body: `${words} failed. The details are in ~/.flint/runtime-backup.out.log.`, kind: 'runtime', ts, read });

  it('Will’s screenshot (2026-10-12): five nights of "backup.offsite Failed" are one row in plain words, with the latest time and how long it has gone on', async () => {
    const now = Date.now();
    const digest = (n: number) => ({ title: `Flint for 2026-10-0${n}`, body: 'Yesterday, no items were important and none went to Other.\nFlint did nothing on its own. Nothing is waiting on you.', kind: 'runtime', ts: now - (5 - n) * NIGHT - 5 * 3_600_000 + 60_000, read: true });
    // Newest first, as the server lists them: each night's failure at 2:15, and the morning digest between them.
    const items = [5, 4, 3, 2, 1].flatMap((n) => [digest(n), oldFailure('backup.offsite', 'Last night’s offsite copy', now - (5 - n) * NIGHT - 10 * 3_600_000, n !== 5)]);
    const rows = await showNotes(items);
    const failures = rows.filter((r) => /Backup/.test(r.title));
    // Still going on (the newest was last night), and three nights or more: it needs him.
    expect(failures).toEqual([{ title: 'Offsite Backup Failed', line: 'Last night’s offsite copy failed. It has failed 5 nights in a row. It needs a look.', when: '10h', read: false }]);
    // The digests between them stay their own rows, each titled by its day in words.
    expect(rows.filter((r) => r.title.startsWith('Daily Summary for ')).map((r) => r.title)).toEqual(['Daily Summary for Mon Oct 5', 'Daily Summary for Sun Oct 4', 'Daily Summary for Sat Oct 3', 'Daily Summary for Fri Oct 2', 'Daily Summary for Thu Oct 1']);
    const text = ids.nlist!.shown();
    expect(text).not.toMatch(/backup\.offsite|~\/|\.flint|out\.log|Flint for 2026/);
    for (const r of rows) expect(noteProblems(r.title, r.line), `${r.title} / ${r.line}`).toEqual([]);
  });

  it('a note Flint posts today folds the same way, and says what happens next once', async () => {
    const now = Date.now();
    const note = jobFailedNote('backup.offsite', { next: 'retry', icloud: true });
    const rows = await showNotes([0, 1, 2].map((n) => ({ ...note, kind: 'runtime', ts: now - n * NIGHT - 3_600_000 })));
    expect(rows).toEqual([{ title: 'Offsite Backup Failed', line: 'Last night’s encrypted copy to iCloud didn’t finish. Flint tries again tonight. It has failed 3 nights in a row. It needs a look.', when: '1h', read: false }]);
    // Two nights: said, but not yet one to look at.
    expect((await showNotes([0, 1].map((n) => ({ ...note, kind: 'runtime', ts: now - n * NIGHT - 3_600_000 }))))[0]!.line).toBe('Last night’s encrypted copy to iCloud didn’t finish. Flint tries again tonight. It has failed 2 nights in a row.');
    // One failure is one row, with no count.
    expect(await showNotes([{ ...note, kind: 'runtime', ts: now - 3_600_000 }])).toEqual([{ title: 'Offsite Backup Failed', line: note.body, when: '1h', read: false }]);
    // The newest note's own words are what the row says: one whose setup needs fixing says so, whatever the nights before said.
    const setup = jobFailedNote('backup.offsite', { next: 'setup', icloud: true });
    expect((await showNotes([{ ...setup, kind: 'runtime', ts: now - 3_600_000 }, { ...note, kind: 'runtime', ts: now - NIGHT - 3_600_000 }]))[0]!.line).toBe('Last night’s encrypted copy to iCloud didn’t finish. It won’t work until its setup is fixed. It has failed 2 nights in a row.');
  });

  describe('a streak', () => {
    const at = (nightsAgo: number, plusMin = 0) => Date.now() - nightsAgo * NIGHT - 3_600_000 + plusMin * 60_000;
    const backup = (ts: number, read = true) => oldFailure('backup.local', 'Last night’s backup', ts, read);
    const lines = async (items: Array<Record<string, unknown>>) => (await showNotes(items)).map((r) => [r.title, r.line]);

    it('is nights in a row: a good night between two failures keeps them apart, and an older streak that ended is said in the past', async () => {
      // Failed last night and the night before; the night before that was good; failed the two nights before it.
      expect(await lines([0, 1, 3, 4].map((n) => backup(at(n))))).toEqual([
        ['Backup Failed', 'Last night’s backup failed. It has failed 2 nights in a row.'],
        ['Backup Failed', 'Last night’s backup failed. It failed 2 nights in a row.'],
      ]);
      // It stopped failing four nights ago: three in a row then, over now, and nothing to look at.
      expect(await lines([4, 5, 6].map((n) => backup(at(n))))).toEqual([['Backup Failed', 'Last night’s backup failed. It failed 3 nights in a row.']]);
    });

    it('joins only a night apart: 30 hours is the next night, 31 is not, and a good night is never bridged', async () => {
      const t = Date.now() - 3_600_000;
      const H = 3_600_000;
      expect(await lines([backup(t), backup(t - 30 * H)])).toEqual([['Backup Failed', 'Last night’s backup failed. It has failed 2 nights in a row.']]);
      expect((await lines([backup(t), backup(t - 31 * H)])).map((r) => r[1])).toEqual(['Last night’s backup failed.', 'Last night’s backup failed.']);
      // Run by hand at 2 PM after a good 2:15 AM run: 36 hours after the last failure, and not the next night's.
      expect((await lines([backup(t), backup(t - 36 * H)])).map((r) => r[1])).toEqual(['Last night’s backup failed.', 'Last night’s backup failed.']);
      expect((await lines([backup(t), backup(t - 48 * H)])).map((r) => r[1])).toEqual(['Last night’s backup failed.', 'Last night’s backup failed.']);
    });

    it('two tries in one night count once', async () => {
      expect(await lines([backup(at(0, 60)), backup(at(0)), backup(at(1))])).toEqual([['Backup Failed', 'Last night’s backup failed. It has failed 2 nights in a row.']]);
      expect(await lines([backup(at(0, 60)), backup(at(0))])).toEqual([['Backup Failed', 'Last night’s backup failed.']]);
    });

    it('the restore test counts weeks, each job is its own row, and an unread night leaves its row unread', async () => {
      const drill = jobFailedNote('restore.drill', { next: 'retry', mismatch: true });
      expect(await lines([{ ...drill, kind: 'runtime', ts: at(0) }, oldFailure('backup.offsite', 'Last night’s offsite copy', at(0, -5)), oldFailure('restore.drill', 'This week’s restore test', at(7)), oldFailure('restore.drill', 'This week’s restore test', at(14))])).toEqual([
        ['Restore Test Failed', 'This week’s practice restore found a problem. Flint tries again next Sunday. It has failed 3 weeks in a row. It needs a look.'],
        ['Offsite Backup Failed', 'Last night’s offsite copy failed.'],
      ]);
      // Its newest failure is eleven days old (a Sunday has passed without one): it is over, "It failed". A fortnight's gap is two streaks.
      expect((await lines([oldFailure('restore.drill', 'This week’s restore test', at(11)), oldFailure('restore.drill', 'This week’s restore test', at(18)), oldFailure('restore.drill', 'This week’s restore test', at(32))])).map((r) => r[1])).toEqual([
        'This week’s restore test failed. It failed 2 weeks in a row.',
        'This week’s restore test failed.',
      ]);
      const rows = await showNotes([backup(at(0), true), backup(at(1), false)]);
      expect(rows.map((r) => r.read)).toEqual([false]);
    });

    it('never folds the watchdog’s own note about the last restore test into the job’s: the job’s says what happens next', async () => {
      const job = jobFailedNote('restore.drill', { next: 'retry', mismatch: true });
      const watchdog = { title: 'The Last Restore Test Failed', body: 'The last restore test found 2 tables that differ from the backup, so the backups may not restore.', kind: 'runtime' };
      expect(await lines([{ ...watchdog, ts: at(0, 5) }, { ...job, kind: 'runtime', ts: at(0) }, { ...watchdog, ts: at(7, 5) }, { ...job, kind: 'runtime', ts: at(7) }])).toEqual([
        ['The Last Restore Test Failed', watchdog.body],
        ['Restore Test Failed', 'This week’s practice restore found a problem. Flint tries again next Sunday. It has failed 2 weeks in a row.'],
        ['The Last Restore Test Failed', watchdog.body],
      ]);
      // As an older Flint titled it: its own row too.
      expect((await lines([{ title: 'The restore drill failed', body: watchdog.body, kind: 'runtime', ts: at(0, 5) }, { ...job, kind: 'runtime', ts: at(0) }])).map((r) => r[0])).toEqual(['The Restore Drill Failed', 'Restore Test Failed']);
    });

    it('says "at least" when the list ends where the streak may have gone on (the server lists the newest 50 notes)', async () => {
      const fifty = Array.from({ length: 50 }, (_, n) => backup(at(n)));
      expect(await lines(fifty)).toEqual([['Backup Failed', 'Last night’s backup failed. It has failed at least 50 nights in a row. It needs a look.']]);
      // The same fifty notes, but the streak ended inside them (a good night, then older failures): its count is exact.
      const broken = Array.from({ length: 50 }, (_, n) => backup(at(n < 5 ? n : n + 1)));
      expect((await lines(broken)).map((r) => r[1])).toEqual(['Last night’s backup failed. It has failed 5 nights in a row. It needs a look.', 'Last night’s backup failed. It failed at least 45 nights in a row.']);
      // Fewer than fifty notes is the whole list: nothing was cut.
      expect(await lines(fifty.slice(0, 49))).toEqual([['Backup Failed', 'Last night’s backup failed. It has failed 49 nights in a row. It needs a look.']]);
      // Fifty notes with the streak well inside them: other notes fill the rest, so it is exact.
      const other = (n: number) => ({ title: `Daily Summary for Day ${n}`, body: 'Everything checked is healthy.', kind: 'runtime', ts: at(10 + n) });
      expect((await lines([backup(at(0)), backup(at(1)), backup(at(2)), ...Array.from({ length: 47 }, (_, n) => other(n))]))[0]).toEqual(['Backup Failed', 'Last night’s backup failed. It has failed 3 nights in a row. It needs a look.']);
    });
  });

  it('whatever an older Flint stored is shown in plain words: no internal name, path, command, id or aside, and a Title Case title', async () => {
    const now = Date.now();
    const stored: Array<[string, string, string, string, string]> = [
      // kind, stored title, stored body, shown title, shown line
      ['runtime', 'restore.drill failed', 'This week’s restore test failed. The details are in ~/.flint/runtime-backup.out.log.', 'Restore Test Failed', 'This week’s restore test failed.'],
      // An action with no words of its own: its name's parts in Title Case, never the dotted name.
      ['runtime', 'world.sync.github failed', 'Run `pnpm --filter @flint/runtime sync` to see why. It stopped.', 'World Sync Github Failed', 'It stopped.'],
      ['runtime', 'maintenance.retention failed', '', 'Cleanup Failed', ''],
      // A budget note, retitled as this branch titles one.
      ['budget', "Claude (Anthropic) budget: 80% of today's cap", 'Flint has spent $8.00 of today’s $10.00 cap. Harder questions use a cheaper model, and background work waits.', 'Claude Budget at 80% for Today', 'Flint has spent $8.00 of today’s $10.00 cap. Harder questions use a cheaper model, and background work waits.'],
      ['budget', "OpenAI budget: 100% of this month's cap", 'Flint has spent $150.00 of this month’s $150.00 cap. OpenAI is off until the cap resets, so voice uses the browser.', 'OpenAI Budget at 100% for This Month', 'Flint has spent $150.00 of this month’s $150.00 cap. OpenAI is off until the cap resets, so voice uses the browser.'],
      ['runtime', 'A database migration failed', 'The runtime’s database update failed and won’t be retried until it’s fixed. A copy of the database from just before it is in ~/FlintBackups/pre-migrate.', 'A Database Migration Failed', 'The runtime’s database update failed and won’t be retried until it’s fixed.'],
      ['runtime', 'issue.state: your rule ci_red.main', 'A GitHub event matched your rule “ci_red.main”.', 'Issue State: Your Rule Ci Red Main', 'A GitHub event matched your rule “ci red main”.'],
      ['runtime', 'New issue: issue#24ehza', 'Flint flagged it as needing you. It’s in Activity, under Important.', 'New Issue', 'Flint flagged it as needing you. It’s in Activity, under Important.'],
      ['runtime', 'New pull request: wpf002/flint #60', 'Flint flagged it as worth knowing. It’s in Activity, under Important.', 'New Pull Request: wpf002/flint #60', 'Flint flagged it as worth knowing. It’s in Activity, under Important.'],
      ['runtime', 'service#abc123 is down', 'A service has been down for 31 minutes.', 'A Service Is Down', 'A service has been down for 31 minutes.'],
      ['runtime', 'The server is down', 'The server has been down for 45 minutes. Recovery is somewhat unlikely (~40%) by Oct 2, 5:30 PM.', 'The Server Is Down', 'The server has been down for 45 minutes. Recovery is somewhat unlikely, around 40% by Oct 2, 5:30 PM.'],
      ['runtime', 'anthropic spend is at its cap', 'Flint has reached its Claude spending cap. Paid calls to it stop until the cap resets or is raised.', 'Anthropic Spend Is at Its Cap', 'Flint has reached its Claude spending cap. Paid calls to it stop until the cap resets or is raised.'],
      ['runtime', 'The com.nexus.responder service is down', 'The com.nexus.responder service has been down for 35 minutes (see /Users/will/.flint/runtime.log).', 'The Com Nexus Responder Service Is Down', 'The com nexus responder service has been down for 35 minutes.'],
      ['action', 'Action done', 'Flint checked what’s happening now.', 'Action Done', 'Flint checked what’s happening now.'],
      ['system', 'Something (odd)', 'It ran with --auto and wrote /tmp/out.json. Nothing else changed.', 'Something', 'Nothing else changed.'],
    ];
    const rows = await showNotes(stored.map(([kind, title, body], i) => ({ kind, title, body, ts: now - i * 1000 })));
    expect(rows.map((r) => [r.title, r.line])).toEqual(stored.map((x) => [x[3], x[4]]));
    for (const r of rows) {
      expect(noteProblems(r.title, r.line), `${r.title} / ${r.line}`).toEqual([]);
      expect(`${r.title}\n${r.line}`).not.toMatch(/[a-z]\.[a-z]|~\/|\/Users\/|`|[{}()]|#[a-z0-9]{6}/);
    }
  });

  it('a calendar or market note keeps the words someone else wrote: an aside in an event’s name is part of it', async () => {
    const rows = await showNotes([
      { kind: 'calendar', title: 'Upcoming', body: 'Lunch (moved to 1) is on Tue, Oct 6 at 1:00 PM, at 12 Main St.', ts: Date.now() - 1000 },
      { kind: 'signal', title: 'Market signal', body: 'acme.example files for an IPO (again)', ts: Date.now() - 2000 },
    ]);
    expect(rows.map((r) => [r.title, r.line])).toEqual([['Upcoming', 'Lunch (moved to 1) is on Tue, Oct 6 at 1:00 PM, at 12 Main St.'], ['Market Signal', 'acme.example files for an IPO (again)']]);
  });

  it('knows where the server cuts the list (the newest 50), which is when a streak is "at least" so long', () => {
    expect(run('NOTE_MAX')).toBe(50);
    expect(readFileSync(join(__dirname, '..', 'src', 'notifications.ts'), 'utf8')).toContain('list(limit = 50): Notification[] {');
    expect(readFileSync(join(__dirname, '..', 'src', 'index.ts'), 'utf8')).toContain('items: ctx.notes.list(), unread: ctx.notes.unreadCount()');
  });

  it('names a service as @flint/policy does, so the Important tab says "the Trident API service" as its note does', () => {
    expect(JSON.parse(JSON.stringify(run('SERVICE_WORDS')))).toEqual(SERVICE_WORDS);
    expect(JSON.parse(JSON.stringify(run('SERVICE_SHORT')))).toEqual(SERVICE_SHORT);
    for (const name of [
      ...Object.keys(SERVICE_WORDS), 'trident-api', 'nexus-mcp', 'com.nexus.responder', 'com.nexus.worker-2', 'com.flint.evolve_measure', 'org.example.sync_agent', 'npm', 'psql', 'brew',
      'worker-4aef4bf9c2', 'com.nexus.job-cmg4x2k9d0001ab3cdefgh1234', '4aef4bf9c2', '...', 'api (staging)', 'constructor', 'toString', 'école-api', '',
    ]) {
      expect(run(`serviceWords(${JSON.stringify(name)})`), name).toBe(serviceWords(name));
    }
  });

  it('names the jobs as @flint/policy does and title-cases as it does, so a note reads the same where it is written and where it is shown', () => {
    expect(JSON.parse(JSON.stringify(run('NOTE_JOBS')))).toEqual(JOB_WORDS);
    for (const [action, words] of Object.entries(JOB_WORDS)) expect(run(`noteTitle(${JSON.stringify(`${action} failed`)})`)).toBe(`${words} Failed`);
    for (const t of [
      'backups waiting for you', 'on your calendar tue oct 6, all day', 'new issue: the login page', 'the iCloud copy of GitHub and CI at 2:15', 'école of ödeme', 'something to look at',
      'The Server Is Down', 'New Pull Request: wpf002/flint #60', 'Claude Budget at 80% for This Month', 'the trident-api service is down', 'a handoff from trident is waiting', 'iMessage is quiet',
    ]) {
      expect(run(`titleCase(${JSON.stringify(t)})`), t).toBe(titleCase(t));
    }
    // The digest's day, as the runtime titles it now.
    expect(run(`noteTitle('Flint for 2026-10-11')`)).toBe('Daily Summary for Sun Oct 11');
    expect(run(`noteTitle('Daily Summary for Sun Oct 11')`)).toBe('Daily Summary for Sun Oct 11');
  });

  it('nothing of a notification is cut off: its title and its sentences wrap, and the digest keeps its lines', () => {
    // The digest is read here and nowhere else; one line with an ellipsis hid all but its first sentence.
    const css = /<style>([\s\S]*?)<\/style>/.exec(html)![1]!;
    expect(css).toContain('#nlist .frow .fx b,#nlist .frow .fx span{overflow:visible;text-overflow:clip;overflow-wrap:anywhere;}');
    expect(css).toContain('#nlist .frow .fx b{white-space:normal;}');
    expect(css).toContain('#nlist .frow .fx span{white-space:pre-line;margin-top:2px;}');
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
      { component: 'source:google_calendar', status: 'degraded', detail: 'The last read skipped at least one item.', at: AT },
    ]);
    run('loadHealth()');
    await settle();
    const top = ids.sethealth!.shown();
    expect(top).toContain('1 Issue');
    expect(top).toContain('Google Calendar');
    expect(top).toContain('Google CalendarThe last read skipped at least one item.');
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
