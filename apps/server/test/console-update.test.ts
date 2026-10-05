/**
 * The console updating itself (apps/console/index.html, <script id="update-js">),
 * run against a small fake page: once the deployed version differs from the
 * one stamped into the page, it reloads at the first quiet moment, never while
 * something is typed or attached, a panel is open, or a reply, recording or
 * speech is in progress; the open conversation survives the reload; and the
 * Mac app's flintIdle(0) check answers the same way.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';

const html = readFileSync(join(__dirname, '..', '..', 'console', 'index.html'), 'utf8');
const updateJs = /<script id="update-js">([\s\S]*?)<\/script>/.exec(html)![1]!;

type El = { value?: string; textContent?: string; innerHTML?: string; style: { display: string } };
let els: Record<string, El>;
let doc: { hidden: boolean; getElementById: (id: string) => El | null; addEventListener: (t: string, f: () => void) => void };
let listeners: Record<string, Array<() => void>>;
let deployed: string | null;
let reloads: number;
let store: Map<string, string>;
let ctx: Record<string, unknown>;

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};
const run = (code: string) => runInContext(code, ctx);
const check = async () => {
  await run('checkUpdate()');
  await settle();
};

function boot(opts: { stamped?: string | null; resume?: unknown } = {}) {
  els = Object.fromEntries(
    ['input', 'think', 'transcript', 'settings', 'notifs', 'lanes', 'approvals', 'convo'].map((id) => [id, { value: '', textContent: '', innerHTML: '', style: { display: '' } }]),
  );
  listeners = {};
  doc = {
    hidden: false,
    getElementById: (id) => els[id] ?? null,
    addEventListener: (t, f) => void (listeners[t] ??= []).push(f),
  };
  reloads = 0;
  store = new Map();
  if (opts.resume !== undefined) store.set('flint_resume', JSON.stringify(opts.resume));
  ctx = {
    document: doc,
    BASE: '',
    PENDING: [],
    ATT_READING: 0,
    mediaRec: null,
    _ttsAudio: null,
    convId: 'console',
    location: { reload: () => void reloads++ },
    sessionStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) },
    fetch: async (url: string, init: { cache?: string }) => {
      expect(url).toBe('/ui-version');
      expect(init.cache).toBe('no-store');
      return { ok: true, json: async () => ({ version: deployed }) };
    },
    setInterval: () => 0,
    __FLINT_UI__: opts.stamped === undefined ? 'v1' : opts.stamped,
  };
  ctx.window = ctx;
  createContext(ctx);
  runInContext(updateJs, ctx);
}

beforeEach(() => {
  deployed = 'v1';
  boot();
});

describe('the console updating itself', () => {
  it('does nothing while the deployed page is the one open', async () => {
    doc.hidden = true;
    await check();
    expect(reloads).toBe(0);
  });

  it('reloads once a new page is deployed and the page is quiet, keeping the open conversation', async () => {
    run("convId='c123'");
    els.transcript!.innerHTML = '<div class="msg you">Did the backup run?</div>';
    deployed = 'v2';
    doc.hidden = true;
    await check();
    expect(reloads).toBe(1);
    const saved = JSON.parse(store.get('flint_resume')!);
    expect(saved.convId).toBe('c123');
    expect(saved.html).toBe('<div class="msg you">Did the backup run?</div>');
  });

  it('waits for a quiet minute when the page is in front and was just used', async () => {
    deployed = 'v2';
    await check();
    expect(reloads).toBe(0);
    run('LAST_INPUT=Date.now()-61000');
    await check();
    expect(reloads).toBe(1);
  });

  it('never reloads over something typed, attached, open or in progress', async () => {
    deployed = 'v2';
    doc.hidden = true;
    const busy: Array<[string, () => void, () => void]> = [
      ['typed text', () => void (els.input!.value = 'half a sentence'), () => void (els.input!.value = '')],
      ['an attachment', () => void run("PENDING=[{name:'a.png'}]"), () => void run('PENDING=[]')],
      ['an attachment being read', () => void run('ATT_READING=1'), () => void run('ATT_READING=0')],
      ['a reply in progress', () => void (els.think!.textContent = 'responding'), () => void (els.think!.textContent = '')],
      ['a recording', () => void run("mediaRec={state:'recording'}"), () => void run('mediaRec=null')],
      ['speech playing', () => void run('_ttsAudio={}'), () => void run('_ttsAudio=null')],
      ...['settings', 'notifs', 'lanes', 'approvals', 'convo'].map((id): [string, () => void, () => void] => [
        `the ${id} panel`,
        () => void (els[id]!.style.display = 'flex'),
        () => void (els[id]!.style.display = 'none'),
      ]),
    ];
    for (const [what, on, off] of busy) {
      on();
      await check();
      expect(reloads, what).toBe(0);
      expect(run('flintIdle(0)'), what).toBe(false);
      off();
    }
    expect(run('flintIdle(0)')).toBe(true);
    await check();
    expect(reloads).toBe(1);
  });

  it('a page served without a stamped version takes the first one it sees as its own', async () => {
    boot({ stamped: null });
    doc.hidden = true;
    deployed = 'v1';
    await check();
    expect(reloads).toBe(0);
    deployed = 'v2';
    await check();
    expect(reloads).toBe(1);
  });

  it('checks when the page is hidden, and every minute', async () => {
    deployed = 'v2';
    doc.hidden = true;
    for (const f of listeners.visibilitychange ?? []) f();
    await settle();
    expect(reloads).toBe(1);
  });

  it('brings the conversation back after the reload, once, and not a stale one', () => {
    boot({ resume: { convId: 'c123', html: '<div class="msg flint">It ran at 2:15.</div>', at: Date.now() - 1000 } });
    expect(run('convId')).toBe('c123');
    expect(els.transcript!.innerHTML).toBe('<div class="msg flint">It ran at 2:15.</div>');
    expect(store.has('flint_resume')).toBe(false);
    boot({ resume: { convId: 'c999', html: '<p>old</p>', at: Date.now() - 31 * 60_000 } });
    expect(run('convId')).toBe('console');
    expect(els.transcript!.innerHTML).toBe('');
    expect(store.has('flint_resume')).toBe(false);
  });
});
