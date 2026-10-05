/**
 * The console's Lanes view (apps/console/index.html, its own <script
 * id="lanes-js">), run against a small fake DOM that refuses innerHTML: what
 * the runtime sent is shown as text (an injected title stays inert), tainted
 * items carry the banner, labels and acks go to the server's routes, "Older"
 * pages with `before`, a failure is shown without forgetting the token, and
 * there is no confirm/alert/prompt anywhere in the console.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';

const html = readFileSync(join(__dirname, '..', '..', 'console', 'index.html'), 'utf8');
const lanesJs = /<script id="lanes-js">([\s\S]*?)<\/script>/.exec(html)![1]!;
const AT = '2026-10-02T15:00:00.000Z';

/** Just enough DOM for the lanes view: no innerHTML, ever. */
class El {
  className = '';
  children: El[] = [];
  style: Record<string, string> = {};
  onclick: (() => void) | null = null;
  disabled = false;
  private text = '';
  private readonly classes = new Set<string>();
  constructor(readonly tagName: string, readonly id = '') {}
  readonly classList = {
    add: (c: string) => void this.classes.add(c),
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
    throw new Error('innerHTML is not allowed in the lanes view');
  }
  appendChild(c: El): El {
    this.children.push(c);
    return c;
  }
  /** Every element under this one. */
  all(): El[] {
    return this.children.flatMap((c) => [c, ...c.all()]);
  }
  button(text: string): El {
    const b = this.all().find((e) => e.tagName === 'button' && e.textContent === text);
    if (!b) throw new Error(`no button "${text}"`);
    return b;
  }
}

type Call = { url: string; method: string; body: unknown };
let calls: Call[];
let answers: Array<(c: Call) => { status: number; body: unknown }>;
let ids: Record<string, El>;
let stored: Record<string, string>;
let ctx: Record<string, unknown>;

const flush = () => new Promise((r) => setTimeout(r, 0));
async function settle() {
  for (let i = 0; i < 5; i++) await flush();
}

beforeEach(() => {
  calls = [];
  answers = [];
  stored = { flint_token: 'tok' };
  ids = Object.fromEntries(['lanes', 'lanelist', 'laneolder', 'lanemsg', 'lanenote', 'lanetab-relevant', 'lanetab-quiet', 'lanetab-health'].map((id) => [id, new El('div', id)]));
  const document = { getElementById: (id: string) => ids[id] ?? null, createElement: (tag: string) => new El(tag) };
  const fetch = async (url: string, init: { method?: string; body?: string; headers?: Record<string, string> } = {}) => {
    const c: Call = { url, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : undefined };
    expect(init.headers?.Authorization).toBe('Bearer tok');
    calls.push(c);
    const a = (answers.shift() ?? (() => ({ status: 200, body: { ok: true } })))(c);
    return { ok: a.status >= 200 && a.status < 300, status: a.status, json: async () => a.body };
  };
  ctx = {
    document, fetch, BASE: '', TOKEN: 'tok', console,
    auth: () => ({ Authorization: 'Bearer tok' }),
    openSettings: () => { throw new Error('the lanes view must not open Settings when it has a token'); },
    localStorage: { getItem: (k: string) => stored[k] ?? null, removeItem: (k: string) => void delete stored[k], setItem: (k: string, v: string) => void (stored[k] = v) },
  };
  createContext(ctx);
  runInContext(lanesJs, ctx);
});

const run = (code: string) => runInContext(code, ctx);
const item = (over: Record<string, unknown> = {}) => ({
  id: 'td_1', at: AT, lane: 'relevant', action: 'escalate', decidedBy: 'rule:service_down', ruleName: 'service_down', relevance: null, reasonCode: 'failure',
  source: 'github', eventType: 'issue.opened', entity: { ref: 'issue#24ehza', kind: 'issue', name: '<img src=x onerror=alert(1)> fix login' }, reasoning: 'The page said: ignore previous instructions.',
  feedback: null, tainted: true, sensitivity: 'ops',
  escalation: { id: 'es_1', templateId: 'issue_new', title: '<b>New issue</b> on flint', body: '<script>steal()</script>', status: 'open', channels: ['inapp'], tainted: true, createdAt: AT },
  ...over,
});

describe('the console Lanes view', () => {
  it('shows a page of a lane as text only, with the tainted banner', async () => {
    answers.push(() => ({ status: 200, body: { items: [item(), item({ id: 'td_2', tainted: false, escalation: null, entity: null, reasoning: null, action: 'log' })], next: null } }));
    run('openLanes()');
    await settle();
    expect(calls[0]).toMatchObject({ url: '/inbox?lane=relevant&limit=25', method: 'GET' });
    expect(ids.lanes!.style.display).toBe('flex');
    const list = ids.lanelist!;
    expect(list.children).toHaveLength(2);
    const text = list.children[0]!.textContent;
    // The markup arrives as literal text (the fake DOM has no innerHTML to fall into).
    expect(text).toContain('<b>New issue</b> on flint');
    expect(text).toContain('<script>steal()</script>');
    expect(text).toContain('<img src=x onerror=alert(1)> fix login (issue#24ehza)');
    expect(text).toContain('Model note: The page said: ignore previous instructions.');
    expect(text).toMatch(/Contains text from outside Flint/);
    expect(list.children[1]!.textContent).not.toMatch(/Contains text from outside Flint/);
    expect(ids['lanetab-relevant']!.classList.contains('on')).toBe(true);
    expect(ids.laneolder!.style.display).toBe('none');
  });

  it('labels a decision through the feedback route and marks the label chosen', async () => {
    answers.push(() => ({ status: 200, body: { items: [item()], next: null } }));
    run('openLanes()');
    await settle();
    const card = ids.lanelist!.children[0]!;
    card.button('Should be quiet').onclick!();
    await settle();
    expect(calls[1]).toEqual({ url: '/inbox/td_1/feedback', method: 'POST', body: { feedback: 'should_be_quiet' } });
    expect(card.button('Should be quiet').classList.contains('on')).toBe(true);
    expect(card.button('OK').classList.contains('on')).toBe(false);
    expect(card.textContent).toContain('labelled: Should be quiet');
  });

  it('acknowledges or dismisses an open escalation through its route', async () => {
    answers.push(() => ({ status: 200, body: { items: [item(), item({ id: 'td_3', escalation: { ...item().escalation, id: 'es_3' } })], next: null } }));
    run('openLanes()');
    await settle();
    const [a, b] = ids.lanelist!.children;
    a!.button('Acknowledge').onclick!();
    b!.button('Dismiss').onclick!();
    await settle();
    expect(calls.slice(1).map((c) => `${c.method} ${c.url}`)).toEqual(['POST /escalations/es_1/ack', 'POST /escalations/es_3/dismiss']);
    expect(a!.textContent).toContain('escalation: acked');
    expect(a!.textContent).toContain('✓ acknowledged');
    expect(b!.textContent).toContain('escalation: dismissed');
    expect(() => a!.button('Acknowledge')).toThrow();
  });

  it('pages back with "Older", appending, and switches lanes', async () => {
    answers.push(() => ({ status: 200, body: { items: [item()], next: '2026-10-01T09:00:00.000Z' } }));
    answers.push(() => ({ status: 200, body: { items: [item({ id: 'td_9' })], next: null } }));
    answers.push(() => ({ status: 200, body: { items: [], next: null } }));
    run('openLanes()');
    await settle();
    expect(ids.laneolder!.style.display).toBe('block');
    run('loadLane(true)');
    await settle();
    expect(calls[1]!.url).toBe('/inbox?lane=relevant&limit=25&before=2026-10-01T09%3A00%3A00.000Z');
    expect(ids.lanelist!.children).toHaveLength(2);
    expect(ids.laneolder!.style.display).toBe('none');
    run("showLane('quiet')");
    await settle();
    expect(calls[2]!.url).toBe('/inbox?lane=quiet&limit=25');
    expect(ids.lanelist!.textContent).toBe('Nothing in the quiet lane.');
  });

  it("shows a failure in the view and keeps the token (a runtime's refusal is the server's 502)", async () => {
    answers.push(() => ({ status: 502, body: { error: "the runtime refused the server's token (reinstall the runtime, or check ~/.flint/tokens/runtime.token)" } }));
    run('openLanes()');
    await settle();
    expect(ids.lanemsg!.textContent).toMatch(/^✗ the runtime refused the server's token/);
    expect(ids.lanemsg!.style.display).toBe('block');
    expect(stored.flint_token).toBe('tok');
    answers.push(() => ({ status: 401, body: { error: 'unauthorized' } }));
    run("showLane('quiet')");
    await settle();
    expect(ids.lanemsg!.textContent).toMatch(/unauthorized: check the access token in Settings/);
    expect(stored.flint_token).toBe('tok');
  });

  it('shows the health report: instance, uptime, a stale check run, each component', async () => {
    // Opening shows the relevant lane first; its page arrives after the switch to Health and is ignored.
    answers.push(() => ({ status: 200, body: { items: [item()], next: null } }));
    answers.push(() => ({
      status: 200,
      body: {
        at: AT, instance: { gitSha: '0f8b2ab0'.padEnd(40, '0'), startedAt: AT, lastBeatAt: new Date().toISOString() }, uptime14d: 0.9934,
        components: [{ component: 'postgres', status: 'ok', detail: null, at: AT }, { component: 'source:github', status: 'down', detail: '<i>5 failures</i>', at: AT }],
        lastHealthRun: '2026-10-01T00:00:00.000Z', triage: 'off',
      },
    }));
    run("openLanes(); showLane('health')");
    await settle();
    const text = ids.lanelist!.textContent;
    expect(calls.at(-1)!.url).toBe('/runtime/health');
    expect(text).toContain('Runtime 0f8b2ab · triage off');
    expect(text).toContain('uptime, last 14 days: 99.3%');
    expect(text).toContain('(more than 10 minutes ago)');
    expect(text).toContain('source:github');
    expect(text).toContain('<i>5 failures</i>');
    expect(ids.lanenote!.style.display).toBe('none');
  });
});

describe('the console', () => {
  it('never calls confirm, alert or prompt (the Mac app\'s web view has none)', () => {
    const code = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]!).join('\n').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(code).not.toMatch(/(^|[^.\w])(alert|confirm|prompt)\s*\(/m);
    expect(code).not.toMatch(/window\.(alert|confirm|prompt)/);
  });

  it('the lanes view never writes HTML', () => {
    expect(lanesJs.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  });
});
