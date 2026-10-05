/**
 * The console updating itself (apps/console/index.html, <script id="update-js">),
 * run against a small fake page: once the deployed version differs from the
 * one stamped into the page, it reloads at the first quiet moment, never while
 * something is typed or attached, a panel is open, or a reply, recording,
 * transcription, speech or approval is in progress; the open conversation is
 * kept in localStorage (so a restarted Mac app finds it too) and the page never
 * reloads when it cannot be kept; restored cards that still wait point to
 * Approvals; and the Mac app's flintIdle(0) check answers the same way.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';

const html = readFileSync(join(__dirname, '..', '..', 'console', 'index.html'), 'utf8');
const updateJs = /<script id="update-js">([\s\S]*?)<\/script>/.exec(html)![1]!;

/** Just enough of an element. A transcript parses `<div class="propose"><div class="prow" ...>` cards. */
class El {
  value = '';
  textContent = '';
  style: Record<string, string | number> = { display: '' };
  classes = new Set<string>();
  classList = { contains: (c: string) => this.classes.has(c) };
  children: El[] = [];
  onclick: (() => void) | null = null;
  on: Record<string, () => void> = {};
  addEventListener(t: string, f: () => void) {
    this.on[t] = f;
  }
  className = '';
  scrollTop = 0;
  scrollHeight = 2000;
  clientHeight = 600;
  rows: El[] = [];
  private _html = '';
  constructor(readonly tagName = 'div') {}
  get innerHTML() {
    return this._html;
  }
  set innerHTML(v: string) {
    this._html = v;
    // Each card's action row, with the inline display/opacity it was saved with.
    this.rows = [...v.matchAll(/<div class="prow"( style="([^"]*)")?>/g)].map((m) => {
      const r = new El();
      for (const [k, val] of (m[2] ?? '').split(';').filter(Boolean).map((d) => d.split(':').map((x) => x.trim()))) r.style[k!] = val!;
      return r;
    });
  }
  querySelectorAll(sel: string) {
    return sel === '.propose .prow' ? this.rows : [];
  }
  appendChild(c: El) {
    this.children.push(c);
    return c;
  }
}

let els: Record<string, El>;
let doc: { hidden: boolean; getElementById: (id: string) => El | null; addEventListener: (t: string, f: () => void) => void; createElement: (t: string) => El };
let listeners: Record<string, Array<() => void>>;
let deployed: string | null;
let reloads: number;
let store: Map<string, string>;
let full: boolean;
let speech: { speaking: boolean; pending: boolean };
let opened: number;
let lo: number;
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
  els = Object.fromEntries(['input', 'think', 'transcript', 'micbtn', 'filepick', 'settings', 'activity', 'approvals', 'ctitle'].map((id) => [id, new El()]));
  listeners = {};
  doc = {
    hidden: false,
    getElementById: (id) => els[id] ?? null,
    addEventListener: (t, f) => void (listeners[t] ??= []).push(f),
    createElement: (t) => new El(t),
  };
  reloads = 0;
  opened = 0;
  lo = 0;
  full = false;
  speech = { speaking: false, pending: false };
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
    LOCAL_ONLY: false,
    applyLO: () => void lo++,
    _ttsQueued: 0,
    openApprovals: () => void opened++,
    speechSynthesis: speech,
    location: { reload: () => void reloads++ },
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        // A quota like WebKit's: a photo-sized snapshot does not fit.
        if (full && v.length > 2000) throw new Error('QuotaExceededError');
        store.set(k, v);
      },
      removeItem: (k: string) => void store.delete(k),
    },
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

  it('reloads once a new page is deployed and the page is quiet, keeping the open conversation in localStorage', async () => {
    run("convId='c123'");
    els.transcript!.innerHTML = '<div class="msg you">Did the backup run?</div>';
    els.transcript!.scrollTop = 1400;
    deployed = 'v2';
    doc.hidden = true;
    await check();
    expect(reloads).toBe(1);
    const saved = JSON.parse(store.get('flint_resume')!);
    expect(saved).toMatchObject({ convId: 'c123', html: '<div class="msg you">Did the backup run?</div>', top: 1400, end: true });
    expect(saved.title).toBe('');
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
      ['a recording (button)', () => void els.micbtn!.classes.add('rec'), () => void els.micbtn!.classes.delete('rec')],
      ['a transcription', () => void els.micbtn!.classes.add('busy'), () => void els.micbtn!.classes.delete('busy')],
      ['speech playing', () => void run('_ttsAudio={}'), () => void run('_ttsAudio=null')],
      ['sentences still to speak', () => void run('_ttsQueued=2'), () => void run('_ttsQueued=0')],
      ['a file being chosen', () => void run('FILE_PICKING=Date.now()'), () => void els.filepick!.on.change!()],
      ['a file being chosen (cancelled)', () => void run('FILE_PICKING=Date.now()'), () => void els.filepick!.on.cancel!()],
      ['the browser voice speaking', () => void (speech.speaking = true), () => void (speech.speaking = false)],
      ['the browser voice queued', () => void (speech.pending = true), () => void (speech.pending = false)],
      [
        'an approval being signed',
        () => void (els.transcript!.innerHTML = '<div class="propose"><div class="prow" style="opacity: 0.5"></div></div>'),
        () => void (els.transcript!.innerHTML = '<div class="propose"><div class="prow" style="display: none"></div></div>'),
      ],
      ...['settings', 'activity', 'approvals'].map((id): [string, () => void, () => void] => [
        `the ${id} panel`,
        () => void els[id]!.classes.add('open'),
        () => void els[id]!.classes.delete('open'),
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

  it('drops pictures to keep a conversation that does not fit, and never reloads when it cannot keep it', async () => {
    deployed = 'v2';
    doc.hidden = true;
    full = true;
    els.transcript!.innerHTML = `<div class="msg you">Here it is<img src="data:image/png;base64,${'A'.repeat(5000)}"></div>`;
    await check();
    expect(reloads).toBe(1);
    expect(JSON.parse(store.get('flint_resume')!).html).toBe('<div class="msg you">Here it is<span class="att-gone">[image]</span></div>');
    store.clear();
    els.transcript!.innerHTML = `<div class="msg flint">${'a long answer '.repeat(400)}</div>`;
    await check();
    expect(reloads).toBe(1);
    expect(store.has('flint_resume')).toBe(false);
    // The Mac app asks the same: it restarts only when the conversation was kept.
    expect(run("flintIdle(0)&&flintSnapshot()")).toBe(false);
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

  it('brings the conversation back once, where Will was reading, and not a stale one', () => {
    boot({ resume: { convId: 'c123', html: '<div class="msg flint">It ran at 2:15.</div>', top: 300, end: false, at: Date.now() - 1000 } });
    expect(run('convId')).toBe('c123');
    expect(els.transcript!.innerHTML).toBe('<div class="msg flint">It ran at 2:15.</div>');
    expect(els.transcript!.scrollTop).toBe(300);
    expect(store.has('flint_resume')).toBe(false);
    boot({ resume: { convId: 'c124', html: '<p>latest</p>', top: 0, end: true, at: Date.now() - 1000 } });
    expect(els.transcript!.scrollTop).toBe(2000);
    boot({ resume: { convId: 'c999', html: '<p>old</p>', at: Date.now() - 31 * 60_000 } });
    expect(run('convId')).toBe('console');
    expect(els.transcript!.innerHTML).toBe('');
    expect(store.has('flint_resume')).toBe(false);
  });

  it('a restored card that still waits offers Approvals instead of buttons that no longer work', () => {
    boot({
      resume: {
        convId: 'c1',
        html: '<div class="propose"><div class="prow"><button class="ok">Approve with Touch ID</button></div></div><div class="propose"><div class="prow" style="display: none"></div></div>',
        at: Date.now() - 1000,
      },
    });
    const [waiting, decided] = els.transcript!.rows;
    expect(waiting!.children).toHaveLength(1);
    expect(waiting!.children[0]!.textContent).toBe('Open Approvals');
    waiting!.children[0]!.onclick!();
    expect(opened).toBe(1);
    expect(decided!.children).toHaveLength(0);
  });
  it('a file chooser that never said it closed stops counting after 10 minutes', () => {
    run('FILE_PICKING=Date.now()-11*60000');
    expect(run('flintIdle(0)')).toBe(true);
  });

  it('keeps Local only on through an update, and only through an update', async () => {
    run('LOCAL_ONLY=true');
    deployed = 'v2';
    doc.hidden = true;
    await check();
    expect(JSON.parse(store.get('flint_resume')!).lo).toBe(true);
    boot({ resume: JSON.parse(store.get('flint_resume')!) });
    expect(run('LOCAL_ONLY')).toBe(true);
    expect(store.get('flint_lo')).toBe('1');
    expect(lo).toBe(1);
    // A page opened afresh (no snapshot) starts unlocked, as before.
    boot();
    expect(run('LOCAL_ONLY')).toBe(false);
    expect(lo).toBe(0);
  });
});
