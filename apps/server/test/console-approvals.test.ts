/**
 * The console's Approvals view (apps/console/index.html, its own <script
 * id="approvals-js">), run against a small fake DOM that refuses innerHTML:
 * every pending card the server lists is shown in words (what it would do,
 * who filed it, its reason and expiry) with its full args as text and the
 * tainted banner; Approve and Reject go through the signed path chat cards
 * use; an approved card that did not run can be run; a device without an
 * approval key is told, step by step, how to add one; the header badge counts
 * what is waiting.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';

const html = readFileSync(join(__dirname, '..', '..', 'console', 'index.html'), 'utf8');
const apprJs = /<script id="approvals-js">([\s\S]*?)<\/script>/.exec(html)![1]!;

class El {
  className = '';
  children: El[] = [];
  style: Record<string, string> = {};
  onclick: (() => void) | null = null;
  disabled = false;
  private text = '';
  constructor(readonly tagName: string, readonly id = '') {}
  get textContent(): string {
    return this.text + this.children.map((c) => c.textContent).join('');
  }
  set textContent(v: string) {
    this.children = [];
    this.text = String(v);
  }
  set innerHTML(_v: string) {
    throw new Error('innerHTML is not allowed in the approvals view');
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
    if (!b) throw new Error(`no button "${text}"`);
    return b;
  }
}

type Call = { url: string; method: string; body: unknown };
let calls: Call[];
let answer: (c: Call) => { status: number; body: unknown };
let ids: Record<string, El>;
let decided: Array<[string, string]>;
let ctx: Record<string, unknown>;
let keyed: boolean;

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};
const run = (code: string) => runInContext(code, ctx);
const card = (over: Record<string, unknown> = {}) => ({
  id: 'pr1', fullName: 'world.source.enable', args: { source: 'deploy' }, tainted: false, status: 'pending', origin: 'cli', ts: Date.parse('2026-10-05T14:00:00Z'),
  expiresAt: '2026-10-12T14:00:00.000Z', ...over,
});

beforeEach(() => {
  calls = [];
  decided = [];
  keyed = true;
  answer = () => ({ status: 200, body: { proposals: [], signed: true } });
  ids = Object.fromEntries(['approvals', 'apprlist', 'apprhelp', 'apprbadge'].map((id) => [id, new El('div', id)]));
  const document = { getElementById: (id: string) => ids[id] ?? null, createElement: (tag: string) => new El(tag) };
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
    canEnclave: () => keyed, canPasskey: () => false, loadCreds: () => {},
    approveAction: (id: string) => void decided.push(['approve', id]),
    rejectAction: (id: string) => void decided.push(['reject', id]),
    postJson: async (path: string, body: unknown) => (calls.push({ url: path, method: 'POST', body }), { action: { status: 'done' } }),
    showOutcome: (d: { action?: { status?: string } }, r: El) => void (r.textContent = `outcome ${d.action?.status}`),
    failed: (e: Error, r: El) => void (r.textContent = `failed ${e.message}`),
    openSettings: () => { throw new Error('must not open Settings with a token'); },
  };
  createContext(ctx);
  runInContext(apprJs, ctx);
});

describe('the console Approvals view', () => {
  it('shows each waiting card in words, with who filed it, its full args as text, and the tainted banner', async () => {
    answer = () => ({
      status: 200,
      body: {
        signed: true,
        proposals: [
          card(),
          card({ id: 'pr2', fullName: 'world.person.create', origin: 'runtime:google_calendar', tainted: true, args: { people: [{ name: '<img src=x onerror=alert(1)>Ada', email: 'ada@example.com' }] } }),
          card({ id: 'pr3', fullName: 'policy.change', reason: 'The shadow week: 1.2 relevant a day; precision 80% over 10 marked.', args: { rows: [{ pattern: 'triage.rule', expiresAt: '2027-03-29T00:00:00.000Z' }, { pattern: 'notify.inapp', expiresAt: '2027-03-29T00:00:00.000Z' }] } }),
          card({ id: 'pr4', fullName: 'backup.offsite', origin: 'runtime:backup', args: {} }),
        ],
      },
    });
    run('openApprovals()');
    await settle();
    expect(ids.approvals!.style.display).toBe('flex');
    const cards = ids.apprlist!.children;
    expect(cards).toHaveLength(4);
    expect(cards[0]!.textContent).toContain('Turn on the deploy source');
    expect(cards[0]!.textContent).toContain('Filed by you, at the terminal');
    expect(cards[0]!.textContent).toContain('"source": "deploy"');
    expect(cards[0]!.textContent).not.toMatch(/Contains text from outside Flint/);
    expect(cards[1]!.textContent).toContain('Add 1 person from calendar events you accepted');
    expect(cards[1]!.textContent).toContain('Filed by Flint (google_calendar)');
    expect(cards[1]!.textContent).toMatch(/Contains text from outside Flint/);
    // The invitation's markup arrives as literal text (the fake DOM has no innerHTML to fall into).
    expect(cards[1]!.textContent).toContain('<img src=x onerror=alert(1)>Ada');
    expect(cards[2]!.textContent).toContain('Let 2 actions run on their own until 2027-03-29 (a signed promotion table)');
    expect(cards[2]!.textContent).toContain('precision 80% over 10 marked');
    expect(cards[3]!.textContent).toContain("Run tonight's offsite backup");
    expect(ids.apprhelp!.style.display).toBe('none');
  });

  it('Approve and Reject take the signed path chat cards use', async () => {
    answer = () => ({ status: 200, body: { signed: true, proposals: [card()] } });
    run('openApprovals()');
    await settle();
    const c = ids.apprlist!.children[0]!;
    c.button('Approve with Touch ID').onclick!();
    c.button('Reject').onclick!();
    expect(decided).toEqual([['approve', 'pr1'], ['reject', 'pr1']]);
  });

  it('a device without an approval key is told how to add one', async () => {
    keyed = false;
    answer = () => ({ status: 200, body: { signed: true, proposals: [card()] } });
    run('openApprovals()');
    await settle();
    expect(ids.apprhelp!.style.display).toBe('block');
    expect(ids.apprhelp!.textContent).toContain('pnpm --filter @flint/runtime enroll');
    expect(ids.apprhelp!.textContent).toContain('Add Touch ID approval key');
    expect(ids.apprlist!.children[0]!.textContent).toContain('Approve');
  });

  it('an approved card that did not run can be run; nothing waiting says so; a runtime that is down says so', async () => {
    answer = () => ({ status: 200, body: { signed: true, proposals: [card({ status: 'approved' })] } });
    run('openApprovals()');
    await settle();
    const c = ids.apprlist!.children[0]!;
    expect(c.textContent).toContain('Approved, not run yet: Turn on the deploy source');
    c.button('Run now').onclick!();
    await settle();
    expect(calls.at(-1)).toEqual({ url: '/proposals/run', method: 'POST', body: { id: 'pr1' } });
    answer = () => ({ status: 200, body: { signed: true, proposals: [] } });
    run('openApprovals()');
    await settle();
    expect(ids.apprlist!.textContent).toBe('Nothing is waiting for you.');
    answer = () => ({ status: 200, body: { signed: true, proposals: [], runtime: 'down' } });
    run('openApprovals()');
    await settle();
    expect(ids.apprhelp!.textContent).toMatch(/runtime is not answering/);
  });

  it('the header badge counts the cards waiting for a signature', async () => {
    answer = () => ({ status: 200, body: { signed: true, proposals: [card(), card({ id: 'pr2' }), card({ id: 'pr3', status: 'approved' })] } });
    run('pollApprovals()');
    await settle();
    expect(ids.apprbadge!.textContent).toBe('2');
    expect(ids.apprbadge!.style.display).toBe('flex');
  });
});
