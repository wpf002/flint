import { describe, it, expect } from 'vitest';
import { LocalMonitor, isReady, pullCommand, type MonitorDeps } from '../src/local-monitor';
import { WarmFailed, type LocalBackend, type ModelFacts, type ModelProbe, type ProbeResult } from '../src/local-backend';

/**
 * The local model's health as a turn reads it: loaded, cold, loading or
 * unavailable. A fake server and a fake clock: every row of the state table in
 * local-monitor.ts, one warm-up at a time, probes that never overlap, and a
 * snapshot that never waits.
 */

const P = 'main-model';
const S = 'small-model';

interface Fake {
  backend: LocalBackend;
  /** What the next probe answers. */
  world: { reachable: boolean; models: Record<string, ModelProbe>; version?: string };
  probes: number;
  warms: Array<{ model: string; numCtx?: number }>;
  /** Resolve or reject the warm-up in flight for a model. */
  finishWarm: (model: string, err?: unknown) => void;
  facts: Record<string, ModelFacts | undefined>;
  describes: string[];
  /** Hold the next probe until released. */
  hold?: { release: () => void };
}

function fake(kind: LocalBackend['kind'] = 'ollama'): Fake {
  const pending = new Map<string, { resolve: () => void; reject: (e: unknown) => void }>();
  const f: Fake = {
    world: { reachable: true, models: {} },
    probes: 0,
    warms: [],
    facts: {},
    describes: [],
    finishWarm: (model, err) => {
      const p = pending.get(model);
      pending.delete(model);
      if (err !== undefined) p?.reject(err);
      else p?.resolve();
    },
    backend: {
      kind,
      async probe(models): Promise<ProbeResult> {
        f.probes += 1;
        if (f.hold) await new Promise<void>((r) => (f.hold!.release = r));
        if (!f.world.reachable) return { reachable: false, models: {} };
        return { reachable: true, ...(f.world.version ? { version: f.world.version } : {}), models: Object.fromEntries(models.map((m) => [m, f.world.models[m] ?? {}])) };
      },
      warm(model, opts) {
        f.warms.push({ model, ...(opts.numCtx !== undefined ? { numCtx: opts.numCtx } : {}) });
        return new Promise<void>((resolve, reject) => pending.set(model, { resolve, reject }));
      },
      async describe(model) {
        f.describes.push(model);
        return f.facts[model];
      },
    },
  };
  return f;
}

function monitor(f: Fake, over: Partial<MonitorDeps> = {}) {
  const clock = { t: 1_000_000 };
  const lines: string[] = [];
  const m = new LocalMonitor({
    backend: f.backend,
    primary: P,
    fallback: S,
    numCtx: { primary: 16384, fallback: 4096 },
    intervalMs: 15_000,
    now: () => clock.t,
    log: (l) => lines.push(l),
    ...over,
  });
  return { m, clock, lines };
}

const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};

describe('LocalMonitor: what a probe says', () => {
  it('before any probe, nothing is ready', () => {
    const { m, clock } = monitor(fake());
    const s = m.snapshot();
    expect(s.reachable).toBe(false);
    expect(s.primary).toMatchObject({ model: P, state: 'unavailable', checkedAt: 0 });
    expect(isReady(s.primary, clock.t)).toBe(false);
  });

  it('the server does not answer: unavailable (unreachable)', async () => {
    const f = fake();
    f.world.reachable = false;
    const { m, lines } = monitor(f);
    const s = await m.check();
    expect(s.reachable).toBe(false);
    expect(s.primary).toMatchObject({ state: 'unavailable', why: 'unreachable' });
    expect(s.fallback).toMatchObject({ state: 'unavailable', why: 'unreachable' });
    expect(lines).toEqual([`[local] primary ${P}: unavailable (unreachable)`, `[local] standby ${S}: unavailable (unreachable)`]);
  });

  it('the model is not installed: unavailable (not_installed), with the pull command once', async () => {
    const f = fake();
    f.world.models = { [P]: { installed: false, loaded: false }, [S]: { installed: true, loaded: true, contextLength: 4096 } };
    const { m, lines } = monitor(f);
    const s = await m.check();
    expect(s.primary).toMatchObject({ state: 'unavailable', why: 'not_installed' });
    expect(lines[0]).toBe(`[local] primary ${P}: unavailable (not_installed). To download it, run: ollama pull ${P}`);
    await m.check();
    await m.check();
    expect(lines.filter((l) => l.includes('ollama pull'))).toHaveLength(1);
  });

  it('installed and not in memory: cold; in memory at the context Flint sends: loaded', async () => {
    const f = fake();
    f.world.models = { [P]: { installed: true, loaded: false }, [S]: { installed: true, loaded: true, contextLength: 4096 } };
    const { m, clock, lines } = monitor(f);
    let s = await m.check();
    expect(s.primary.state).toBe('cold');
    expect(s.fallback).toMatchObject({ state: 'loaded', contextLength: 4096 });
    expect(isReady(s.primary, clock.t)).toBe(false);
    expect(isReady(s.fallback, clock.t)).toBe(true);
    f.world.models[P] = { installed: true, loaded: true, contextLength: 16384 };
    s = await m.check();
    expect(s.primary).toMatchObject({ state: 'loaded', contextLength: 16384 });
    expect(lines).toEqual([`[local] primary ${P}: cold`, `[local] standby ${S}: loaded (context 4096)`, `[local] primary ${P}: cold -> loaded (context 16384)`]);
  });

  it('in memory at ANOTHER context is cold, not loaded: the next turn would make Ollama reload it', async () => {
    const f = fake();
    f.world.models = { [P]: { installed: true, loaded: true, contextLength: 32768 } };
    const { m, clock } = monitor(f);
    const s = await m.check();
    expect(s.primary).toMatchObject({ state: 'cold', contextLength: 32768, contextMismatch: true });
    expect(isReady(s.primary, clock.t)).toBe(false);
  });

  it('with no expected context, any loaded context counts', async () => {
    const f = fake();
    f.world.models = { [P]: { installed: true, loaded: true, contextLength: 32768 } };
    const { m } = monitor(f, { numCtx: {} });
    expect((await m.check()).primary.state).toBe('loaded');
  });

  it('loaded, then no longer in memory: cold', async () => {
    const f = fake();
    f.world.models = { [P]: { installed: true, loaded: true, contextLength: 16384 } };
    const { m } = monitor(f);
    expect((await m.check()).primary.state).toBe('loaded');
    f.world.models[P] = { installed: true, loaded: false };
    const s = await m.check();
    expect(s.primary.state).toBe('cold');
    expect(s.primary.contextLength).toBeUndefined();
  });

  it('a server that says it is loading (llama.cpp): loading', async () => {
    const f = fake('llamacpp');
    f.world.models = { [P]: { installed: true, loaded: false, loading: true } };
    const { m } = monitor(f, { fallback: undefined });
    expect((await m.check()).primary.state).toBe('loading');
  });

  it('an endpoint that config refused: unavailable (config), and nothing is ever probed', async () => {
    const lines: string[] = [];
    const m = new LocalMonitor({ backend: undefined, primary: P, intervalMs: 1000, log: (l) => lines.push(l) });
    expect((await m.check()).primary).toMatchObject({ state: 'unavailable', why: 'config' });
    m.start();
    expect(m.running).toBe(false);
    m.warm('primary');
    expect(lines).toEqual([]);
  });

  it("asks what each model can do once it is there, and keeps the server's answer", async () => {
    const f = fake();
    f.world.models = { [P]: { installed: true, loaded: true, contextLength: 16384 }, [S]: { installed: false } };
    f.facts[P] = { tools: true, vision: true };
    const { m } = monitor(f);
    await m.check();
    expect(m.facts(P)).toEqual({ tools: true, vision: true });
    expect(m.facts(S)).toBeUndefined();
    await m.check();
    // Asked once for the model it has; never for the one that is not installed.
    expect(f.describes).toEqual([P]);
    // The standby is downloaded later: asked then.
    f.world.models[S] = { installed: true, loaded: false };
    f.facts[S] = { tools: false };
    await m.check();
    expect(m.facts(S)).toEqual({ tools: false });
  });

  it('a snapshot is a copy: a later change does not reach a turn that already read it', async () => {
    const f = fake();
    f.world.models = { [P]: { installed: true, loaded: true, contextLength: 16384 } };
    const { m } = monitor(f);
    const before = await m.check();
    f.world.models[P] = { installed: true, loaded: false };
    await m.check();
    expect(before.primary.state).toBe('loaded');
    expect(m.snapshot().primary.state).toBe('cold');
  });
});

describe('LocalMonitor: warm-ups', () => {
  it('cold -> loading when warmed, with the context chat will send; loaded once the server has it', async () => {
    const f = fake();
    f.world.models = { [P]: { installed: true, loaded: false } };
    const { m, clock, lines } = monitor(f, { fallback: undefined });
    await m.check();
    m.warm('primary');
    expect(m.snapshot().primary.state).toBe('loading');
    expect(f.warms).toEqual([{ model: P, numCtx: 16384 }]);
    clock.t += 8412;
    f.world.models[P] = { installed: true, loaded: true, contextLength: 16384 };
    f.finishWarm(P);
    await settle();
    expect(m.snapshot().primary.state).toBe('loaded');
    expect(lines).toEqual([`[local] primary ${P}: cold`, `[local] primary ${P}: cold -> loading (warm-up started)`, `[local] primary ${P}: loading -> loaded (context 16384, 8412 ms)`]);
  });

  it('at most one warm-up per model at a time', async () => {
    const f = fake();
    f.world.models = { [P]: { installed: true, loaded: false }, [S]: { installed: true, loaded: false } };
    const { m } = monitor(f);
    await m.check();
    m.warm('primary');
    m.warm('primary');
    m.warm('primary');
    m.warm('fallback');
    expect(f.warms.map((w) => w.model)).toEqual([P, S]);
  });

  it('a probe during a warm-up leaves it loading, not cold', async () => {
    const f = fake();
    f.world.models = { [P]: { installed: true, loaded: false } };
    const { m } = monitor(f, { fallback: undefined });
    await m.check();
    m.warm('primary');
    await m.check();
    expect(m.snapshot().primary.state).toBe('loading');
  });

  it('a warm-up that fails goes back to cold, and the log has its status, never its words', async () => {
    const f = fake();
    f.world.models = { [P]: { installed: true, loaded: false } };
    const { m, lines } = monitor(f, { fallback: undefined });
    await m.check();
    m.warm('primary');
    f.finishWarm(P, new WarmFailed(500));
    await settle();
    expect(m.snapshot().primary.state).toBe('cold');
    expect(lines.at(-1)).toBe(`[local] primary ${P}: loading -> cold (warm-up status 500)`);
    // And it can be tried again.
    m.warm('primary');
    expect(f.warms).toHaveLength(2);
    f.finishWarm(P, new Error('the server said: SECRET DETAIL'));
    await settle();
    expect(lines.join('\n')).not.toContain('SECRET');
    expect(lines.at(-1)).toBe(`[local] primary ${P}: loading -> cold (warm-up failed)`);
  });

  it('a warm-up that outlives its timeout goes back to cold', async () => {
    const f = fake();
    f.world.models = { [P]: { installed: true, loaded: false } };
    const { m, lines } = monitor(f, { fallback: undefined, warmTimeoutMs: 20 });
    await m.check();
    // This backend never answers the load on its own: the monitor's timeout must end it.
    const backend = f.backend;
    const original = backend.warm.bind(backend);
    backend.warm = (model, opts) =>
      new Promise<void>((_resolve, reject) => {
        void original(model, opts).catch(() => {});
        opts.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    m.warm('primary');
    await new Promise((r) => setTimeout(r, 60));
    expect(m.snapshot().primary.state).toBe('cold');
    expect(lines.at(-1)).toBe(`[local] primary ${P}: loading -> cold (warm-up timed out)`);
  });

  it('nothing is warmed that is not there to load, or that is already loaded', async () => {
    const f = fake();
    f.world.models = { [P]: { installed: false }, [S]: { installed: true, loaded: true, contextLength: 4096 } };
    const { m } = monitor(f);
    await m.check();
    m.warm('primary');
    m.warm('fallback');
    expect(f.warms).toEqual([]);
  });

  // The privacy review's N10. A standby that is a cloud model under a plain name was still loaded ahead of a turn.
  it('a model the server says runs somewhere else is never warmed: not when asked, not after a slow turn, not when it leaves memory', async () => {
    const f = fake();
    f.world.models = { [P]: { installed: true, loaded: false }, [S]: { installed: true, loaded: false } };
    const elsewhere = new Set([S]);
    const asked: string[] = [];
    const { m } = monitor(f, { rewarm: () => true, mayWarm: (model) => (asked.push(model), !elsewhere.has(model)) });
    await m.check();
    m.warm('fallback');
    expect(f.warms).toEqual([]);
    expect(m.snapshot().fallback?.state).toBe('cold'); // not "loading": nothing was started
    m.warm('primary');
    expect(f.warms).toEqual([{ model: P, numCtx: 16384 }]);
    expect(asked).toEqual([S, P]);
    // Asked at every warm-up, not once: a name pointed at a cloud model while Flint runs stops being loaded.
    f.finishWarm(P);
    await settle();
    elsewhere.add(P);
    m.observe('primary', { outcome: 'timeout_first_token' });
    f.world.models[P] = { installed: true, loaded: false };
    await m.check();
    m.warm('primary');
    expect(f.warms).toEqual([{ model: P, numCtx: 16384 }]);
  });

  it('a server that cannot say what is in memory is loaded once a warm-up has made it answer', async () => {
    const f = fake('openai');
    f.world.models = { [P]: { installed: true } };
    const { m } = monitor(f, { fallback: undefined, numCtx: {} });
    await m.check();
    expect(m.snapshot().primary.state).toBe('cold');
    m.warm('primary');
    f.finishWarm(P);
    await settle();
    expect(m.snapshot().primary.state).toBe('loaded');
    // And a later probe, which still cannot say, leaves that standing.
    await m.check();
    expect(m.snapshot().primary.state).toBe('loaded');
  });
});

describe('LocalMonitor: what a turn saw', () => {
  it('a first-token timeout on a loaded model: loading, not ready for the cool-down, and a warm-up is fired', async () => {
    const f = fake();
    f.world.models = { [P]: { installed: true, loaded: true, contextLength: 16384 } };
    const { m, clock } = monitor(f, { fallback: undefined, slowCooldownMs: 30_000 });
    await m.check();
    m.observe('primary', { outcome: 'first_token_timeout' });
    let s = m.snapshot();
    expect(s.primary.state).toBe('loading');
    expect(s.primary.slowUntil).toBe(clock.t + 30_000);
    expect(f.warms.map((w) => w.model)).toEqual([P]);
    // The server still says it is in memory: loaded again, but not ready until the cool-down passes.
    f.finishWarm(P);
    await settle();
    s = m.snapshot();
    expect(s.primary.state).toBe('loaded');
    expect(isReady(s.primary, clock.t)).toBe(false);
    clock.t += 30_001;
    expect(isReady(m.snapshot().primary, clock.t)).toBe(true);
  });

  it('a turn that could not connect: unavailable (unreachable), and so is every other model on that server', async () => {
    const f = fake();
    f.world.models = { [P]: { installed: true, loaded: true, contextLength: 16384 }, [S]: { installed: true, loaded: true, contextLength: 4096 } };
    const { m } = monitor(f);
    await m.check();
    m.observe('primary', { outcome: 'unreachable' });
    expect(m.snapshot()).toMatchObject({ reachable: false, primary: { state: 'unavailable', why: 'unreachable' }, fallback: { state: 'unavailable', why: 'unreachable' } });
    // The next probe that finds the server back puts both right.
    await m.check();
    expect(m.snapshot()).toMatchObject({ reachable: true, primary: { state: 'loaded' }, fallback: { state: 'loaded' } });
  });

  it('a first token from a model that was cold or loading: loaded', async () => {
    const f = fake();
    f.world.models = { [P]: { installed: true, loaded: false } };
    const { m } = monitor(f, { fallback: undefined });
    await m.check();
    m.observe('primary', { outcome: 'ok', firstTokenMs: 640 });
    expect(m.snapshot().primary.state).toBe('loaded');
  });

  it('keeps time to first token over the last 50 turns', async () => {
    const f = fake();
    f.world.models = { [P]: { installed: true, loaded: true, contextLength: 16384 } };
    const { m } = monitor(f, { fallback: undefined });
    await m.check();
    for (let i = 1; i <= 60; i++) m.observe('primary', { outcome: 'ok', firstTokenMs: i * 10 });
    // The last 50 samples are 110..600.
    expect(m.snapshot().primary.firstTokenMs).toEqual({ p50: 350, p95: 580, n: 50 });
  });

  it('an ordinary error says nothing about the model', async () => {
    const f = fake();
    f.world.models = { [P]: { installed: true, loaded: true, contextLength: 16384 } };
    const { m } = monitor(f, { fallback: undefined });
    await m.check();
    m.observe('primary', { outcome: 'error' });
    expect(m.snapshot().primary.state).toBe('loaded');
  });
});

describe('LocalMonitor: probing', () => {
  it('probes never overlap: a second check while one is in flight is the same check', async () => {
    const f = fake();
    f.world.models = { [P]: { installed: true, loaded: true, contextLength: 16384 } };
    f.hold = { release: () => {} };
    const { m } = monitor(f, { fallback: undefined });
    const a = m.check();
    const b = m.check();
    await settle();
    expect(f.probes).toBe(1);
    f.hold.release();
    delete f.hold;
    expect(await a).toEqual(await b);
    expect(f.probes).toBe(1);
  });

  it('snapshot() answers at once while a probe hangs', async () => {
    const f = fake();
    f.hold = { release: () => {} };
    const { m } = monitor(f);
    void m.check();
    await settle();
    expect(m.snapshot().primary.state).toBe('unavailable');
    f.hold.release();
  });

  it('checkSoon is detached and at most once per probe timeout', async () => {
    const f = fake();
    const { m, clock } = monitor(f, { probeTimeoutMs: 2000 });
    m.checkSoon();
    await settle();
    m.checkSoon();
    await settle();
    expect(f.probes).toBe(1);
    clock.t += 2001;
    m.checkSoon();
    await settle();
    expect(f.probes).toBe(2);
  });

  it('start() probes on the interval and stop() ends it', async () => {
    const f = fake();
    const { m } = monitor(f, { intervalMs: 15 });
    m.start();
    m.start();
    expect(m.running).toBe(true);
    await new Promise((r) => setTimeout(r, 80));
    m.stop();
    expect(m.running).toBe(false);
    const n = f.probes;
    expect(n).toBeGreaterThanOrEqual(2);
    await new Promise((r) => setTimeout(r, 40));
    expect(f.probes).toBe(n);
  });

  it('a probe that throws is an unreachable server, not a crash', async () => {
    const f = fake();
    f.backend.probe = async () => {
      throw new Error('boom');
    };
    const { m } = monitor(f);
    expect((await m.check()).primary).toMatchObject({ state: 'unavailable', why: 'unreachable' });
  });
});

describe('LocalMonitor: a stand-in, and following the brain when it changes', () => {
  it('a stand-in is unavailable (unsettled) whatever the server has under that name: never probed for, never warmed, never told by a turn', async () => {
    const f = fake();
    f.world.models[P] = { installed: true, loaded: true, contextLength: 16384 };
    const { m } = monitor(f, { primarySettled: false });
    expect(m.snapshot().primary).toMatchObject({ state: 'unavailable', why: 'unsettled' });
    const asked: string[][] = [];
    const probe = f.backend.probe.bind(f.backend);
    f.backend.probe = async (models, signal) => {
      asked.push([...models]);
      return probe(models, signal);
    };
    const snap = await m.check();
    // The server was reached, and the stand-in was not asked about.
    expect(snap.reachable).toBe(true);
    expect(asked).toEqual([[S]]);
    expect(snap.primary).toMatchObject({ state: 'unavailable', why: 'unsettled' });
    m.warm('primary');
    expect(f.warms).toEqual([]);
    m.observe('primary', { outcome: 'ok', firstTokenMs: 10 });
    m.observe('primary', { outcome: 'unreachable' });
    expect(m.snapshot().primary).toMatchObject({ state: 'unavailable', why: 'unsettled' });
    expect(f.describes).not.toContain(P);
  });

  it('retarget: the adopted model starts as one nobody has looked at, and the next look is about it', async () => {
    const f = fake();
    f.world.models['adopted-model'] = { installed: true, loaded: true, contextLength: 8192 };
    const { m } = monitor(f, { primarySettled: false });
    await m.check();
    m.retarget({ backend: f.backend, primary: { model: 'adopted-model', numCtx: 8192, settled: true }, fallback: { model: S, numCtx: 4096 } });
    expect(m.snapshot().primary).toMatchObject({ model: 'adopted-model', state: 'unavailable', why: 'unreachable', checkedAt: 0 });
    const snap = await m.check();
    expect(snap.primary).toMatchObject({ model: 'adopted-model', state: 'loaded', contextLength: 8192 });
  });

  it('retarget: a model that did not change keeps what the monitor knows of it', async () => {
    const f = fake();
    f.world.models[P] = { installed: true, loaded: true, contextLength: 16384 };
    f.world.models[S] = { installed: true, loaded: false };
    const { m } = monitor(f);
    await m.check();
    m.observe('primary', { outcome: 'ok', firstTokenMs: 40 });
    const probes = f.probes;
    m.retarget({ backend: f.backend, primary: { model: P, numCtx: 16384, settled: true }, fallback: { model: S, numCtx: 4096 } });
    expect(m.snapshot().primary).toMatchObject({ state: 'loaded', firstTokenMs: { n: 1 } });
    expect(f.probes).toBe(probes);
    // Only the standby changed: the main model's state stands, the new standby starts over.
    m.retarget({ backend: f.backend, primary: { model: P, numCtx: 16384, settled: true }, fallback: { model: 'other-small', numCtx: 4096 } });
    expect(m.snapshot()).toMatchObject({ primary: { state: 'loaded' }, fallback: { model: 'other-small', state: 'unavailable', checkedAt: 0 } });
    // And with no standby any more, there is no standby slot.
    m.retarget({ backend: f.backend, primary: { model: P, numCtx: 16384, settled: true } });
    expect(m.snapshot().fallback).toBeUndefined();
  });

  // The final review's L5: the watcher reported by slot, so a turn in flight across a retarget marked the NEW
  // model loaded (and gave it the old one's first-token time) until the next look said otherwise.
  it('retarget: what a turn saw is about the model it asked, never about the one the slot holds now', async () => {
    const f = fake();
    f.world.models[P] = { installed: true, loaded: true, contextLength: 16384 };
    f.world.models['adopted-model'] = { installed: true, loaded: false };
    const { m } = monitor(f);
    await m.check();
    m.retarget({ backend: f.backend, primary: { model: 'adopted-model', numCtx: 8192, settled: true } });
    await m.check();
    expect(m.snapshot().primary).toMatchObject({ model: 'adopted-model', state: 'cold' });
    // A turn that began on the old model finishes now: the adopted model is not marked loaded by it.
    m.observe('primary', { outcome: 'ok', firstTokenMs: 40, model: P });
    expect(m.snapshot().primary).toMatchObject({ model: 'adopted-model', state: 'cold' });
    expect(m.snapshot().primary.firstTokenMs).toBeUndefined();
    // ...nor marked slow by the old one's timeout.
    m.observe('primary', { outcome: 'first_token_timeout', model: P });
    expect(m.snapshot().primary).toMatchObject({ state: 'cold' });
    expect(m.snapshot().primary.slowUntil).toBeUndefined();
    // A turn on the adopted model itself is believed, however its tag is written.
    m.observe('primary', { outcome: 'ok', firstTokenMs: 55, model: 'Adopted-Model:latest' });
    expect(m.snapshot().primary).toMatchObject({ state: 'loaded', firstTokenMs: { n: 1 } });
    // A server that could not be reached is about the server, whichever model was asked: it names none.
    m.observe('primary', { outcome: 'unreachable' });
    expect(m.snapshot().primary).toMatchObject({ state: 'unavailable', why: 'unreachable' });
  });

  it('retarget: an answer that was on its way about the old model is dropped, never read as the new one', async () => {
    const f = fake();
    f.world.models[P] = { installed: true, loaded: true, contextLength: 16384 };
    const { m } = monitor(f);
    f.hold = { release: () => {} };
    const stale = m.check();
    await Promise.resolve();
    m.retarget({ backend: f.backend, primary: { model: 'adopted-model', settled: true } });
    f.hold.release();
    delete f.hold;
    await stale;
    // The old probe never listed the new model: it must not make it look installed and cold.
    expect(m.snapshot().primary).toMatchObject({ model: 'adopted-model', state: 'unavailable', checkedAt: 0 });
    f.world.models['adopted-model'] = { installed: false };
    expect((await m.check()).primary).toMatchObject({ state: 'unavailable', why: 'not_installed' });
  });

  it('retarget: a warm-up that finishes for a model the monitor left says nothing about the new one', async () => {
    const f = fake();
    f.world.models[P] = { installed: true, loaded: false };
    const { m, lines } = monitor(f);
    await m.check();
    m.warm('primary');
    m.retarget({ backend: f.backend, primary: { model: 'adopted-model', settled: true } });
    const before = lines.length;
    f.finishWarm(P, new WarmFailed(500));
    await new Promise((r) => setTimeout(r, 5));
    expect(lines.slice(before).filter((l) => l.includes(P))).toEqual([]);
    expect(m.snapshot().primary.model).toBe('adopted-model');
  });

  it('retarget to no server at all: unavailable (config), and the timer stops', async () => {
    const f = fake();
    const { m } = monitor(f);
    m.start();
    m.retarget({ backend: undefined, primary: { model: P, settled: true } });
    expect(m.running).toBe(false);
    expect(m.snapshot().primary).toMatchObject({ state: 'unavailable', why: 'config' });
  });
});

// The routing review's S10. Ollama clamps num_ctx to the model's own maximum. Asked for 16,384, a model whose
// maximum is 8,192 loads at 8,192: "in memory at another context", so cold, so warmed, so loaded at 8,192
// again, for good. The main model never became ready, and every turn went to the standby.
describe('LocalMonitor: the context Flint asks for, as the server will really give it', () => {
  it('a model whose own maximum is below what Flint asks for is LOADED when it is in memory at its maximum', async () => {
    const f = fake();
    f.world.models[P] = { installed: true, loaded: true, contextLength: 8192 };
    f.facts[P] = { tools: true, contextLength: 8192 }; // /api/show: the model's maximum
    const { m } = monitor(f); // Flint asks for 16,384
    const snap = await m.check();
    // The very first look learns the maximum and applies it before anyone reads the state.
    expect(snap.primary).toMatchObject({ state: 'loaded', contextLength: 8192 });
    expect(snap.primary.contextMismatch).toBeUndefined();
    m.warm('primary');
    expect(f.warms).toEqual([]); // nothing to load: it is ready
    expect((await m.check()).primary.state).toBe('loaded');
  });

  it('a model that CAN hold what Flint asks for, in memory at less, is still cold (asking would reload it)', async () => {
    const f = fake();
    f.world.models[P] = { installed: true, loaded: true, contextLength: 4096 };
    f.facts[P] = { tools: true, contextLength: 131072 };
    const { m } = monitor(f);
    const snap = await m.check();
    expect(snap.primary).toMatchObject({ state: 'cold', contextMismatch: true });
  });

  it('with the maximum not known (a server that does not say), the number asked for is the one compared, as before', async () => {
    const f = fake();
    f.world.models[P] = { installed: true, loaded: true, contextLength: 8192 };
    const { m } = monitor(f);
    expect((await m.check()).primary).toMatchObject({ state: 'cold', contextMismatch: true });
    f.world.models[P] = { installed: true, loaded: true, contextLength: 16384 };
    expect((await m.check()).primary.state).toBe('loaded');
  });
});

// Ollama unloads a model after its keep-alive (5 minutes unless OLLAMA_KEEP_ALIVE says otherwise). In the
// local and hybrid modes the first message after any break was then always the standby's.
describe('LocalMonitor: a main model that leaves memory is loaded again, once', () => {
  const left = (f: Fake) => (f.world.models[P] = { installed: true, loaded: false });
  const back = (f: Fake) => (f.world.models[P] = { installed: true, loaded: true, contextLength: 16384 });

  it('after it has answered a turn: the next look that finds it gone loads it again', async () => {
    const f = fake();
    back(f);
    const { m, lines } = monitor(f, { rewarm: () => true });
    await m.check();
    m.observe('primary', { outcome: 'ok', firstTokenMs: 30 });
    left(f);
    const snap = await m.check();
    expect(f.warms).toEqual([{ model: P, numCtx: 16384 }]);
    expect(snap.primary.state).toBe('loading');
    expect(lines.some((l) => l.includes(`primary ${P}: loaded -> cold`))).toBe(true);
    expect(lines.some((l) => l.includes(`primary ${P}: cold -> loading (warm-up started)`))).toBe(true);
  });

  it('once per departure: with nobody there it does not become a reload every five minutes', async () => {
    const f = fake();
    back(f);
    const { m } = monitor(f, { rewarm: () => true });
    await m.check();
    m.observe('primary', { outcome: 'ok', firstTokenMs: 30 });
    left(f);
    await m.check();
    expect(f.warms).toHaveLength(1);
    back(f);
    f.finishWarm(P);
    await settle();
    expect((await m.check()).primary.state).toBe('loaded');
    // It leaves again, and no turn was answered in between: it stays cold until a turn asks for it.
    left(f);
    expect((await m.check()).primary.state).toBe('cold');
    expect(f.warms).toHaveLength(1);
    // A turn is answered (the plan warmed it, it loaded, it answered): the next departure is followed again.
    back(f);
    await m.check();
    m.observe('primary', { outcome: 'ok', firstTokenMs: 30 });
    left(f);
    await m.check();
    expect(f.warms).toHaveLength(2);
  });

  it('never in the cloud mode, never for a model that never answered a turn, never for the standby, never for a context mismatch', async () => {
    // The cloud mode (rewarm says no), and a monitor that was given no say at all.
    for (const over of [{ rewarm: () => false }, {}]) {
      const f = fake();
      back(f);
      const { m } = monitor(f, over);
      await m.check();
      m.observe('primary', { outcome: 'ok', firstTokenMs: 30 });
      left(f);
      expect((await m.check()).primary.state).toBe('cold');
      expect(f.warms).toEqual([]);
    }
    // Loaded by someone else and never used by Flint: not Flint's to keep in memory.
    const unused = fake();
    back(unused);
    const a = monitor(unused, { rewarm: () => true });
    await a.m.check();
    left(unused);
    await a.m.check();
    expect(unused.warms).toEqual([]);
    // The standby.
    const sb = fake();
    back(sb);
    sb.world.models[S] = { installed: true, loaded: true, contextLength: 4096 };
    const b = monitor(sb, { rewarm: () => true });
    await b.m.check();
    b.m.observe('fallback', { outcome: 'ok', firstTokenMs: 30 });
    sb.world.models[S] = { installed: true, loaded: false };
    await b.m.check();
    expect(sb.warms).toEqual([]);
    // In memory at another context (another client's): reloading it would be a tug of war.
    const other = fake();
    back(other);
    const c = monitor(other, { rewarm: () => true });
    await c.m.check();
    c.m.observe('primary', { outcome: 'ok', firstTokenMs: 30 });
    other.world.models[P] = { installed: true, loaded: true, contextLength: 4096 };
    expect((await c.m.check()).primary).toMatchObject({ state: 'cold', contextMismatch: true });
    expect(other.warms).toEqual([]);
  });
});

describe('pullCommand', () => {
  it('is the exact command for a model tag', () => {
    expect(pullCommand('family:7b')).toBe('ollama pull family:7b');
    expect(pullCommand('hf.co/org/repo:Q4_K_M')).toBe('ollama pull hf.co/org/repo:Q4_K_M');
  });

  it('is nothing at all for a name that is not one: no line to paste, no shell to reach', () => {
    for (const bad of ['', 'a b', 'x; rm -rf ~', 'x && curl evil', '$(whoami)', '`id`', 'a|b', "a'b", 'x'.repeat(101), 'a\nb']) {
      expect(pullCommand(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });
});
