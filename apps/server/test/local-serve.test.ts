import { describe, it, expect } from 'vitest';
import { FlintError, makeAiError, type GenerateArgs, type Message, type ProviderAdapter, type StreamEvent } from '@flint/core';
import { HYBRID_WHEN_COLD, cloudChainFor, heldToHere, observationOf, observed, planLocal, privateRefusal, routeLocal, runLocalPlan, standbyNote, stepName, watcher, type LocalPlan, type LocalStep, type PlanInput } from '../src/local-serve';
import { staysOn } from '../src/inference-status';
import type { LocalSnapshot, LocalState, ModelHealth, TurnObservation, UnavailableWhy } from '../src/local-monitor';
import type { BrainTier } from '../src/brains';
import { isLocalTurn, isPrivateTurn, isStaysHereTurn } from '../src/turn-taint';

/**
 * The warm-start fallback: every cell of the plan's table, and the rules that
 * hold a plan together while it runs.
 */

const NOW = 1_000_000;
const health = (model: string, state: LocalState, why?: UnavailableWhy, slowUntil?: number): ModelHealth => ({ model, state, since: 0, checkedAt: NOW, ...(why ? { why } : {}), ...(slowUntil ? { slowUntil } : {}) });
const snap = (primary: ModelHealth, fallback?: ModelHealth): LocalSnapshot => ({ server: 'ollama', reachable: primary.why !== 'unreachable', primary, ...(fallback ? { fallback } : {}) });

const MAIN = { persona: 'P-main', model: 'main-model' };
const SMALL = { persona: 'P-small', model: 'small-model' };
type Route = PlanInput<string>['route'];
const local: Route = { mode: 'local', reason: 'mode_local', private: false, cloudFallback: false };
const hybridPrivate: Route = { mode: 'hybrid', reason: 'private', private: true, cloudFallback: false };
const hybridOther: Route = { mode: 'hybrid', reason: 'default', private: false, cloudFallback: true };
const hybridFromCloud: Route = { mode: 'hybrid', reason: 'tools', private: false, cloudFallback: false }; // a cloud-first turn falling back
const cloudMode: Route = { mode: 'cloud', reason: 'mode_cloud', private: false, cloudFallback: false };

const plan = (route: Route, primary: ModelHealth, fallback?: ModelHealth, over: Partial<PlanInput<string>> = {}): LocalPlan<string> =>
  planLocal({ route, snapshot: snap(primary, fallback), confined: { ok: true }, primary: MAIN, ...(fallback ? { standby: SMALL } : {}), now: NOW, ...over });
const names = (p: LocalPlan<string>): string[] => p.steps.map((s) => (s.kind === 'cloud' ? 'cloud' : s.which === 'primary' ? 'main' : 'standby'));

describe('planLocal: every cell of the table', () => {
  const ready = health('main-model', 'loaded');
  const standbyReady = health('small-model', 'loaded');
  const standbyCold = health('small-model', 'cold');
  const standbyMissing = health('small-model', 'unavailable', 'not_installed');

  it('main ready: main first, then the standby, then (hybrid, not private) the cloud', () => {
    expect(names(plan(local, ready, standbyReady))).toEqual(['main', 'standby']);
    expect(names(plan(hybridPrivate, ready, standbyReady))).toEqual(['main', 'standby']);
    expect(names(plan(hybridOther, ready, standbyReady))).toEqual(['main', 'standby', 'cloud']);
    expect(names(plan(local, ready))).toEqual(['main']);
    expect(names(plan(hybridOther, ready))).toEqual(['main', 'cloud']);
    expect(plan(local, ready, standbyReady)).toMatchObject({ primaryState: 'loaded', warmPrimary: false });
    expect(plan(local, ready, standbyReady).refusal).toBeUndefined();
  });

  for (const [what, main] of [
    ['cold', health('main-model', 'cold')],
    ['loading', health('main-model', 'loading')],
    ['slow to first token a moment ago', health('main-model', 'loaded', undefined, NOW + 30_000)],
  ] as const) {
    it(`main ${what}, standby installed: the standby answers, and the main model is never sent the turn`, () => {
      expect(names(plan(local, main, standbyReady))).toEqual(['standby']);
      expect(names(plan(hybridPrivate, main, standbyReady))).toEqual(['standby']);
      // Hybrid, any other turn: the standby FIRST, the cloud only if no local model can.
      expect(names(plan(hybridOther, main, standbyReady))).toEqual(['standby', 'cloud']);
      // A standby that is installed but not in memory is still used: it loads inside the deadline.
      expect(names(plan(local, main, standbyCold))).toEqual(['standby']);
    });

    it(`main ${what}, no standby: a sentence in local mode and for a private turn; the cloud for any other hybrid turn`, () => {
      for (const p of [plan(local, main), plan(local, main, standbyMissing)]) {
        expect(names(p)).toEqual([]);
        expect(p.refusal).toBe("Flint's local model is still loading. Try again in a moment.");
      }
      expect(names(plan(hybridPrivate, main))).toEqual([]);
      expect(names(plan(hybridOther, main))).toEqual(['cloud']);
    });
  }

  it('a main model that is cold or loading is warmed (by the monitor, off the turn); one that is only slow already was', () => {
    expect(plan(local, health('main-model', 'cold'), standbyReady).warmPrimary).toBe(true);
    expect(plan(local, health('main-model', 'loading'), standbyReady).warmPrimary).toBe(true);
    expect(plan(local, health('main-model', 'loaded', undefined, NOW + 1), standbyReady).warmPrimary).toBe(false);
    expect(plan(local, health('main-model', 'unavailable', 'not_installed'), standbyReady).warmPrimary).toBe(false);
  });

  it('main unavailable, standby installed: the standby answers', () => {
    const missing = health('main-model', 'unavailable', 'not_installed');
    expect(names(plan(local, missing, standbyReady))).toEqual(['standby']);
    expect(names(plan(hybridPrivate, missing, standbyReady))).toEqual(['standby']);
    expect(names(plan(hybridOther, missing, standbyReady))).toEqual(['standby', 'cloud']);
  });

  it('nothing local: a sentence that says why, and never the cloud for a turn that must be local', () => {
    const down = health('main-model', 'unavailable', 'unreachable');
    const downToo = health('small-model', 'unavailable', 'unreachable');
    expect(plan(local, down, downToo)).toMatchObject({ steps: [], refusal: "The local model isn't available, and Local mode never uses the cloud." });
    expect(plan(hybridPrivate, down, downToo)).toMatchObject({ steps: [], refusal: "The local model isn't available, and a private message never leaves this Mac." });
    expect(names(plan(hybridOther, down, downToo))).toEqual(['cloud']);
    const missing = health('main-model', 'unavailable', 'not_installed');
    expect(plan(local, missing).refusal).toBe("The local model isn't downloaded yet, and Local mode never uses the cloud.");
    expect(plan({ ...hybridOther, cloudFallback: false }, missing).refusal).toBe("The local model isn't downloaded yet, and no cloud model is configured.");
  });

  it('a cloud-first hybrid turn that falls back gets the local steps and no cloud step (it came from there)', () => {
    expect(names(plan(hybridFromCloud, ready, standbyReady))).toEqual(['main', 'standby']);
    expect(names(plan(hybridFromCloud, health('main-model', 'cold'), standbyReady))).toEqual(['standby']);
    expect(names(plan(hybridFromCloud, health('main-model', 'cold')))).toEqual([]);
  });

  it('the cloud mode and an eval replay get the main model alone, whatever its state: as before', () => {
    for (const state of ['loaded', 'cold', 'loading', 'unavailable'] as const) {
      const main = health('main-model', state, state === 'unavailable' ? 'unreachable' : undefined);
      expect(names(plan(cloudMode, main, standbyReady))).toEqual(['main']);
      expect(plan(cloudMode, main, standbyReady).warmPrimary).toBe(false);
      expect(names(plan({ ...local, reason: 'eval' }, main, standbyReady))).toEqual(['main']);
    }
  });

  // The breaker's last review, F1: with nothing naming the model and the server silent, the name held is a
  // stand-in. Asking Ollama for it loads it, and the next pick then adopts it as "loaded". So no plan, in
  // any mode, ever has a step for it.
  it('a main model that is not settled is never a step, in any mode: the standby, the cloud, or a sentence', () => {
    const standIn = health('main-model', 'unavailable', 'unsettled');
    // Local mode and private turns: the standby when there is one, else a sentence that says why.
    for (const route of [local, hybridPrivate]) {
      expect(names(plan(route, standIn, health('small-model', 'loaded')))).toEqual(['standby']);
      const none = plan(route, standIn);
      expect(none.steps).toEqual([]);
      expect(none.refusal).toMatch(/^Flint hasn't chosen its local model yet, because the local model server isn't answering, and /);
      expect(none.warmPrimary).toBe(false);
    }
    expect(plan(local, standIn).refusal).toBe("Flint hasn't chosen its local model yet, because the local model server isn't answering, and Local mode never uses the cloud.");
    expect(plan(hybridPrivate, standIn).refusal).toBe("Flint hasn't chosen its local model yet, because the local model server isn't answering, and a private message never leaves this Mac.");
    // Hybrid, any other turn: the cloud.
    expect(names(plan(hybridOther, standIn))).toEqual(['cloud']);
    // The cloud mode used to send a local turn to the main model whatever its state. Not a stand-in:
    const cloud = plan(cloudMode, standIn);
    expect(cloud.steps).toEqual([]);
    // (The review's C4c: this ended "so only the cloud can answer right now", and a Cloud-mode turn that is not
    // private is the local model's to answer only when there is no cloud model at all.)
    expect(cloud.refusal).toBe("Flint hasn't chosen its local model yet, because the local model server isn't answering, and no cloud model is configured.");
    for (const main of [health('main-model', 'unavailable', 'unsettled')]) expect(plan(cloudMode, main).refusal).not.toMatch(/only the cloud/);
    expect(plan({ ...cloudMode, private: true }, standIn).refusal).toBe("Flint hasn't chosen its local model yet, because the local model server isn't answering, and a private message never leaves this Mac.");
    // An eval replay of the main brain is refused the same way; one that names its own model is that model's, and runs.
    expect(plan({ ...cloudMode, reason: 'eval' }, standIn).steps).toEqual([]);
    expect(names(plan({ ...cloudMode, reason: 'eval' }, standIn, undefined, { evalOwnModel: true }))).toEqual(['main']);
    // Settled, the cloud mode and an eval replay are as they were.
    expect(names(plan(cloudMode, health('main-model', 'cold')))).toEqual(['main']);
  });

  it('a model server that is not this Mac is never used for a turn that must be local', () => {
    const remote = { ok: false as const, why: 'remote_host' as const };
    expect(plan(local, ready, standbyReady, { confined: remote })).toMatchObject({ steps: [], refusal: 'The local model server is on another machine, and Local mode never uses the cloud.' });
    expect(names(plan(hybridOther, ready, standbyReady, { confined: remote }))).toEqual(['cloud']);
    expect(plan(hybridPrivate, ready, standbyReady, { confined: { ok: false, why: 'cloud_model' } }).refusal).toBe("The local model is one that runs on Ollama's servers, and a private message never leaves this Mac.");
    expect(plan(local, ready, undefined, { confined: { ok: false, why: 'config' } }).refusal).toBe("The local model server's address was refused, and Local mode never uses the cloud.");
  });

  // The final review's M1: in Cloud mode a Local Only turn was sent to a model server on another machine, under a
  // Mode row that said private messages stay on this Mac.
  it('a private message is never sent to a model server that is not this Mac, in any mode, an eval replay included', () => {
    const remote = { ok: false as const, why: 'remote_host' as const };
    const SENTENCE = 'The local model server is on another machine, and a private message never leaves this Mac.';
    for (const reason of ['mode_cloud', 'eval'] as const) {
      const p = plan({ ...cloudMode, reason, private: true }, ready, standbyReady, { confined: remote });
      expect(p, reason).toMatchObject({ steps: [], warmPrimary: false, refusal: SENTENCE });
    }
    // ...whatever it names as its own model.
    expect(plan({ ...cloudMode, reason: 'eval', private: true }, ready, undefined, { confined: remote, evalOwnModel: true }).steps).toEqual([]);
    expect(plan(hybridPrivate, ready, standbyReady, { confined: remote })).toMatchObject({ steps: [], refusal: SENTENCE });
    expect(plan({ ...local, private: true }, ready, standbyReady, { confined: remote })).toMatchObject({ steps: [], refusal: 'The local model server is on another machine, and Local mode never uses the cloud.' });
    // The other reasons "local" is not this Mac get their own true sentence.
    expect(plan({ ...cloudMode, private: true }, ready, undefined, { confined: { ok: false, why: 'cloud_model' } }).refusal).toBe("The local model is one that runs on Ollama's servers, and a private message never leaves this Mac.");
    expect(plan({ ...cloudMode, private: true }, ready, undefined, { confined: { ok: false, why: 'config' } }).refusal).toBe("The local model server's address was refused, and a private message never leaves this Mac.");
    // A Cloud-mode turn that is NOT private is as it always was: the configured server answers it.
    expect(names(plan(cloudMode, ready, standbyReady, { confined: remote }))).toEqual(['main']);
    expect(names(plan({ ...cloudMode, reason: 'eval' }, ready, undefined, { confined: remote }))).toEqual(['main']);
    // On this Mac, a private turn in Cloud mode is answered by the main model, as before.
    expect(names(plan({ ...cloudMode, private: true }, ready))).toEqual(['main']);
  });

  it('privateRefusal: the same answer where the turn is first routed, before a word of it is embedded or planned with', () => {
    const remote = { ok: false as const, why: 'remote_host' as const };
    for (const mode of ['cloud', 'hybrid'] as const) expect(privateRefusal({ mode, private: true }, remote), mode).toBe('The local model server is on another machine, and a private message never leaves this Mac.');
    expect(privateRefusal({ mode: 'local', private: true }, remote)).toBe('The local model server is on another machine, and Local mode never uses the cloud.');
    expect(privateRefusal({ mode: 'cloud', private: true }, { ok: false, why: 'cloud_model' })).toBe("The local model is one that runs on Ollama's servers, and a private message never leaves this Mac.");
    // Not private, or really here: nothing to refuse.
    for (const mode of ['cloud', 'hybrid', 'local'] as const) {
      expect(privateRefusal({ mode, private: false }, remote), mode).toBeUndefined();
      expect(privateRefusal({ mode, private: true }, { ok: true }), mode).toBeUndefined();
    }
  });

  // L11: with a model server Will allowed on another machine, "this Mac" alone would not be true.
  it('a server Will said is his: the sentence that says where a private message stays names it too', () => {
    expect(staysOn(false)).toBe('this Mac');
    expect(staysOn(undefined)).toBe('this Mac');
    expect(staysOn(true)).toBe('this Mac or the model server you allowed');
    const down = health('main-model', 'unavailable', 'unreachable');
    expect(plan(hybridPrivate, down, undefined, { allowedRemote: true }).refusal).toBe("The local model isn't available, and a private message never leaves this Mac or the model server you allowed.");
    expect(plan({ ...cloudMode, private: true }, health('main-model', 'unavailable', 'unsettled'), undefined, { allowedRemote: true }).refusal).toBe(
      "Flint hasn't chosen its local model yet, because the local model server isn't answering, and a private message never leaves this Mac or the model server you allowed.",
    );
    // Sentences that promise nothing about where are unchanged.
    expect(plan(local, down, undefined, { allowedRemote: true }).refusal).toBe("The local model isn't available, and Local mode never uses the cloud.");
  });

  it('a private turn never has a cloud step, in any cell', () => {
    const states: ModelHealth[] = [ready, health('main-model', 'cold'), health('main-model', 'loading'), health('main-model', 'unavailable', 'unreachable')];
    for (const main of states) {
      for (const spare of [undefined, standbyReady, standbyMissing]) {
        for (const route of [hybridPrivate, { ...hybridPrivate, cloudFallback: true }, local]) {
          expect(names(plan(route, main, spare)), `${main.state}/${spare?.state}`).not.toContain('cloud');
        }
      }
    }
  });

  it('each step carries the persona that speaks for its model and the state it was in when the plan was made', () => {
    const p = plan(hybridOther, ready, standbyCold);
    expect(p.steps).toEqual([
      { kind: 'local', which: 'primary', state: 'loaded', persona: 'P-main', model: 'main-model' },
      { kind: 'local', which: 'fallback', state: 'cold', persona: 'P-small', model: 'small-model' },
      { kind: 'cloud' },
    ]);
  });
});

// The final review's H3: a turn that stays here is only asked of a model that is KNOWN to run here.
describe('heldToHere: a plan for a turn that stays here keeps only the models known to run here', () => {
  const ready = health('main-model', 'loaded');
  const standbyReady = health('small-model', 'loaded');
  const both = () => plan(local, ready, standbyReady);
  const never = () => false;
  const always = () => true;

  it('every model known to run here: the plan is the very same', () => {
    const p = both();
    expect(heldToHere(p, { route: local, here: always, elsewhere: never })).toBe(p);
  });

  it('a model that is not is left out, and the one that is still answers; the main model is not loaded for a turn that may not use it', () => {
    const cold = plan(local, health('main-model', 'cold'), standbyReady);
    expect(cold.warmPrimary).toBe(true);
    const held = heldToHere(both(), { route: local, here: (s) => s.which === 'fallback', elsewhere: (s) => s.which === 'primary' });
    expect(names(held)).toEqual(['standby']);
    expect(held.refusal).toBeUndefined();
    expect(names(heldToHere(both(), { route: local, here: (s) => s.which === 'primary', elsewhere: never }))).toEqual(['main']);
    // The standby alone was planned (the main model is cold); it is known here, so nothing changes.
    expect(heldToHere(cold, { route: local, here: always, elsewhere: never }).warmPrimary).toBe(true);
  });

  it('none left: a sentence, never the cloud. A cloud model under a plain name is said so; a model not heard of yet is too', () => {
    const cloudModel = heldToHere(both(), { route: local, here: never, elsewhere: (s) => s.which === 'primary' });
    expect(cloudModel).toEqual({ steps: [], primaryState: 'loaded', warmPrimary: false, refusal: "The local model is one that runs on Ollama's servers, and Local mode never uses the cloud." });
    const unknown = heldToHere(both(), { route: hybridPrivate, here: never, elsewhere: never });
    expect(unknown.refusal).toBe('Flint has not confirmed yet that its local model runs on this Mac, and a private message never leaves this Mac.');
    expect(heldToHere(both(), { route: hybridPrivate, here: never, elsewhere: never, allowedRemote: true }).refusal).toBe(
      'Flint has not confirmed yet that its local model runs on this Mac or the model server you allowed, and a private message never leaves this Mac or the model server you allowed.',
    );
    // A main model that is not there at all gets the sentence any turn that must be local gets.
    const missing = health('main-model', 'unavailable', 'not_installed');
    const evalPlan = plan({ ...local, reason: 'eval' }, missing);
    expect(names(evalPlan)).toEqual(['main']);
    expect(heldToHere(evalPlan, { route: local, here: never, elsewhere: never, main: missing }).refusal).toBe("The local model isn't downloaded yet, and Local mode never uses the cloud.");
  });

  it('a plan that already had nothing local is left as it is', () => {
    const none = plan(local, health('main-model', 'unavailable', 'unreachable'));
    expect(heldToHere(none, { route: local, here: never, elsewhere: never })).toBe(none);
  });
});

describe('HYBRID_WHEN_COLD: one row, and the place to flip it', () => {
  it('ships as the standby first, then the cloud', () => {
    expect(HYBRID_WHEN_COLD).toEqual(['fallback', 'cloud']);
  });

  it('reversed, a hybrid turn goes to the cloud first while the main model loads', () => {
    const cold = health('main-model', 'cold');
    const p = plan(hybridOther, cold, health('small-model', 'loaded'), { whenCold: ['cloud', 'fallback'] });
    expect(names(p)).toEqual(['cloud', 'standby']);
    // A private turn is unaffected: it has no cloud step to reorder.
    expect(names(plan(hybridPrivate, cold, health('small-model', 'loaded'), { whenCold: ['cloud', 'fallback'] }))).toEqual(['standby']);
  });

  it('cloud only: the standby is not used', () => {
    const p = plan(hybridOther, health('main-model', 'cold'), health('small-model', 'loaded'), { whenCold: ['cloud'] });
    expect(names(p)).toEqual(['cloud']);
  });
});

describe('runLocalPlan', () => {
  const steps = (...which: Array<'main' | 'standby' | 'cloud'>): LocalPlan<string> => ({
    primaryState: 'loaded',
    warmPrimary: false,
    steps: which.map((w): LocalStep<string> => (w === 'cloud' ? { kind: 'cloud' } : { kind: 'local', which: w === 'main' ? 'primary' : 'fallback', state: 'loaded', ...(w === 'main' ? MAIN : SMALL) })),
  });
  const timeout = () => new FlintError(makeAiError('timeout', 'local sent no first token in 20000 ms', { retryable: false, providerCode: 'first_token_timeout' }));
  const tried = (s: LocalStep<string>) => (s.kind === 'cloud' ? 'cloud' : s.model);

  it('the first step that answers is the answer; later steps are never asked', async () => {
    const asked: string[] = [];
    const r = await runLocalPlan(steps('main', 'standby', 'cloud'), async (s) => (asked.push(tried(s)), `from ${tried(s)}`), { progressed: () => false });
    expect(r).toMatchObject({ result: 'from main-model', moved: 0, meter: { which: 'primary', state: 'loaded' } });
    expect(asked).toEqual(['main-model']);
  });

  it('a step that fails before any progress moves on: main, then the standby, then the cloud', async () => {
    const asked: string[] = [];
    const moves: string[] = [];
    const r = await runLocalPlan(
      steps('main', 'standby', 'cloud'),
      async (s) => {
        asked.push(tried(s));
        if (s.kind === 'local') throw timeout();
        return 'from cloud';
      },
      { progressed: () => false, onMove: (from, to) => moves.push(`${tried(from)}->${tried(to)}`) },
    );
    expect(r.result).toBe('from cloud');
    expect(r.step).toEqual({ kind: 'cloud' });
    expect(r.moved).toBe(2);
    expect(r.meter).toBeUndefined();
    expect(asked).toEqual(['main-model', 'small-model', 'cloud']);
    expect(moves).toEqual(['main-model->small-model', 'small-model->cloud']);
  });

  it('after text was shown, a failure is thrown as it is: no second model starts the turn over', async () => {
    const asked: string[] = [];
    const err = timeout();
    let shown = false;
    await expect(
      runLocalPlan(
        steps('main', 'standby', 'cloud'),
        async (s) => {
          asked.push(tried(s));
          shown = true;
          throw err;
        },
        { progressed: () => shown },
      ),
    ).rejects.toBe(err);
    expect(asked).toEqual(['main-model']);
  });

  it('after a tool was called, a failure is thrown as it is: the tool is never run twice by a restart', async () => {
    const asked: string[] = [];
    let toolRan = 0;
    await expect(
      runLocalPlan(
        steps('main', 'standby'),
        async (s) => {
          asked.push(tried(s));
          toolRan += 1;
          throw timeout();
        },
        { progressed: () => toolRan > 0 },
      ),
    ).rejects.toThrow(/no first token/);
    expect(asked).toEqual(['main-model']);
    expect(toolRan).toBe(1);
  });

  it("a tool's own error is not the model failing: nothing else is asked", async () => {
    const asked: string[] = [];
    const toolError = new FlintError(makeAiError('internal', "Tool 'calendar.create_event' failed: boom", { retryable: false }));
    await expect(runLocalPlan(steps('main', 'standby'), async (s) => (asked.push(tried(s)), Promise.reject(toolError)), { progressed: () => false })).rejects.toBe(toolError);
    expect(asked).toEqual(['main-model']);
  });

  it("the caller's abort stops the plan: a closed tab does not spend another model", async () => {
    const asked: string[] = [];
    const ac = new AbortController();
    await expect(
      runLocalPlan(
        steps('main', 'standby', 'cloud'),
        async (s) => {
          asked.push(tried(s));
          ac.abort();
          throw new FlintError(makeAiError('timeout', 'Request aborted', { retryable: false }));
        },
        { progressed: () => false, signal: ac.signal },
      ),
    ).rejects.toThrow(/aborted/);
    expect(asked).toEqual(['main-model']);
  });

  it('the last step is told it is the last, so a stream can pass its failure on instead of throwing', async () => {
    const lasts: boolean[] = [];
    await runLocalPlan(
      steps('main', 'standby'),
      async (s, last) => {
        lasts.push(last);
        if (s.kind === 'local' && s.which === 'primary') throw timeout();
        return 'ok';
      },
      { progressed: () => false },
    );
    expect(lasts).toEqual([false, true]);
  });

  it('a local step runs as the local model\'s turn; a cloud step does not', async () => {
    const seen: Array<[string, boolean]> = [];
    await runLocalPlan(
      steps('main', 'cloud'),
      async (s) => {
        seen.push([tried(s), isLocalTurn()]);
        if (s.kind === 'local') throw timeout();
        return 'ok';
      },
      { progressed: () => false },
    );
    expect(seen).toEqual([['main-model', true], ['cloud', false]]);
    expect(isLocalTurn()).toBe(false);
  });

  it('a private turn\'s local steps are marked private, so nothing they set off reaches an outside service; the cloud step and a turn that is not private are not', async () => {
    const steps: LocalPlan<string> = {
      steps: [
        { kind: 'local', which: 'primary', state: 'loaded', ...MAIN },
        { kind: 'local', which: 'fallback', state: 'loaded', ...SMALL },
        { kind: 'cloud' },
      ],
      primaryState: 'loaded',
      warmPrimary: false,
    };
    const seen = async (priv: boolean | undefined) => {
      const marks: Array<[string, boolean, boolean]> = [];
      await runLocalPlan(
        steps,
        async (step) => {
          // ...inside a scope the turn opened itself, as deep_research does.
          await new Promise((r) => setTimeout(r, 0));
          marks.push([step.kind === 'cloud' ? 'cloud' : step.which, isLocalTurn(), isPrivateTurn()]);
          if (step.kind !== 'cloud') throw new FlintError(makeAiError('provider_unavailable', 'down', { retryable: true }));
          return 'ok';
        },
        { progressed: () => false, ...(priv === undefined ? {} : { private: priv }) },
      );
      return marks;
    };
    expect(await seen(true)).toEqual([['primary', true, true], ['fallback', true, true], ['cloud', false, false]]);
    expect(await seen(false)).toEqual([['primary', true, false], ['fallback', true, false], ['cloud', false, false]]);
    expect(await seen(undefined)).toEqual([['primary', true, false], ['fallback', true, false], ['cloud', false, false]]);
    expect(isPrivateTurn()).toBe(false);
  });

  // Two notions, kept apart: "explicitly private" (tools: nothing leaves this Mac) and "stays here" (private, or
  // any turn of Local mode: no outside AI, no paid service, to the end of the turn whatever the mode is by then).
  it('a turn that stays here is marked so on its local steps, private or not, and a cloud step is never marked', async () => {
    const steps: LocalPlan<string> = {
      steps: [{ kind: 'local', which: 'primary', state: 'loaded', ...MAIN }, { kind: 'cloud' }],
      primaryState: 'loaded',
      warmPrimary: false,
    };
    const seen = async (opts: { private?: boolean; staysHere?: boolean }) => {
      const marks: Array<[string, boolean, boolean]> = [];
      await runLocalPlan(
        steps,
        async (step) => {
          await new Promise((r) => setTimeout(r, 0));
          marks.push([step.kind === 'cloud' ? 'cloud' : step.which, isPrivateTurn(), isStaysHereTurn()]);
          if (step.kind !== 'cloud') throw new FlintError(makeAiError('provider_unavailable', 'down', { retryable: true }));
          return 'ok';
        },
        { progressed: () => false, ...opts },
      );
      return marks;
    };
    // Local mode, an ordinary turn: stays here, not private.
    expect(await seen({ private: false, staysHere: true })).toEqual([['primary', false, true], ['cloud', false, false]]);
    // A private turn stays here too, even when only `private` is passed.
    expect(await seen({ private: true })).toEqual([['primary', true, true], ['cloud', false, false]]);
    expect(await seen({ private: true, staysHere: true })).toEqual([['primary', true, true], ['cloud', false, false]]);
    // A hybrid turn the rules kept local: neither.
    expect(await seen({})).toEqual([['primary', false, false], ['cloud', false, false]]);
    expect(isStaysHereTurn()).toBe(false);
    // Before each LOCAL step is asked, the model server is heard from (./inference heardLately): what it says of where
    // its models run decides, inside the ask, what that model is handed. A cloud step waits for nothing.
    const order: string[] = [];
    await runLocalPlan(
      steps,
      async (step) => {
        order.push(`ask ${step.kind === 'cloud' ? 'cloud' : step.which}`);
        if (step.kind !== 'cloud') throw new FlintError(makeAiError('provider_unavailable', 'down', { retryable: true }));
        return 'ok';
      },
      { progressed: () => false, heard: async () => void order.push('heard') },
    );
    expect(order).toEqual(['heard', 'ask primary', 'ask cloud']);
    // A look that fails holds nothing up.
    await expect(runLocalPlan(steps, async (step) => step.kind, { progressed: () => false, heard: () => Promise.reject(new Error('the look failed')) })).resolves.toMatchObject({ result: 'local' });
  });

  it('a plan with no steps cannot run: the caller refused before this', async () => {
    await expect(runLocalPlan({ steps: [], primaryState: 'cold', warmPrimary: true, refusal: 'Try again in a moment.' }, async () => 'x', { progressed: () => false })).rejects.toThrow('Try again in a moment.');
  });

  it('the plan is fixed: a main model that becomes ready mid-turn is not swapped in', async () => {
    // The plan was made while the main model was cold: only the standby is in it, whatever happens next.
    const cold = planLocal({ route: local, snapshot: snap(health('main-model', 'cold'), health('small-model', 'loaded')), confined: { ok: true }, primary: MAIN, standby: SMALL, now: NOW });
    const asked: string[] = [];
    await runLocalPlan(cold, async (s) => (asked.push(tried(s)), 'ok'), { progressed: () => false });
    expect(asked).toEqual(['small-model']);
    // The NEXT turn's plan, from a new snapshot, picks the main model.
    const next = planLocal({ route: local, snapshot: snap(health('main-model', 'loaded'), health('small-model', 'loaded')), confined: { ok: true }, primary: MAIN, standby: SMALL, now: NOW });
    expect(names(next)[0]).toBe('main');
  });
});

describe('observed: what the monitor learns from a turn', () => {
  const user: Message = { id: 'u', role: 'user', content: 'hi', timestamp: 0 };
  const toolResult: Message = { id: 't', role: 'tool_result', toolCallId: 'c', content: '{"toolName":"x","result":"y","isError":false}', timestamp: 0 };
  const caps = { toolCalling: 'native' as const, structuredOutput: 'native' as const, streaming: 'full' as const, maxContextTokens: 8192, maxOutputTokens: 1024 };

  function scripted(events: StreamEvent[], clock: { t: number }, delayMs = 0): ProviderAdapter {
    return {
      name: 'ollama',
      getCapabilities: () => caps,
      estimateTokens: () => 1,
      generate: async () => {
        clock.t += delayMs;
        return { message: { id: 'a', role: 'assistant', content: 'ok', timestamp: 0 }, usage: { input: 1, output: 1 }, reason: 'complete' };
      },
      async *stream() {
        clock.t += delayMs;
        for (const e of events) yield e;
      },
    };
  }
  const run = async (p: ProviderAdapter, args: Partial<GenerateArgs> = {}) => {
    const out: StreamEvent[] = [];
    for await (const e of p.stream({ model: 'm', messages: [user], ...args })) out.push(e);
    return out;
  };
  const done: StreamEvent = { type: 'done', reason: 'complete', usage: { input: 1, output: 1 } };

  it('a first token: ok, with how long it took, and the events pass through untouched', async () => {
    const clock = { t: 0 };
    const seen: TurnObservation[] = [];
    const events: StreamEvent[] = [{ type: 'text', delta: 'Hello' }, { type: 'text', delta: ' there' }, done];
    const p = observed(scripted(events, clock, 640), 'primary', () => ({ observe: (_w, o) => void seen.push(o) }), () => clock.t);
    expect(await run(p)).toEqual(events);
    expect(seen).toEqual([{ outcome: 'ok', model: 'm', firstTokenMs: 640 }]);
    expect(p.name).toBe('ollama');
    expect(p.getCapabilities('m')).toEqual(caps);
  });

  it('the pass after a tool result is not a first token to time', async () => {
    const clock = { t: 0 };
    const seen: TurnObservation[] = [];
    const p = observed(scripted([{ type: 'text', delta: 'x' }, done], clock, 900), 'primary', () => ({ observe: (_w, o) => void seen.push(o) }), () => clock.t);
    await run(p, { messages: [user, toolResult] });
    expect(seen).toEqual([{ outcome: 'ok', model: 'm' }]);
  });

  it('a first-token timeout and an unreachable server are told; an ordinary error and a hang-up are not', async () => {
    const clock = { t: 0 };
    const seen: Array<[string, TurnObservation]> = [];
    const mon = () => ({ observe: (w: string, o: TurnObservation) => void seen.push([w, o]) });
    const err = (kind: 'timeout' | 'provider_unavailable' | 'validation', providerCode?: string): StreamEvent => ({ type: 'error', error: makeAiError(kind, 'x', { retryable: false, ...(providerCode ? { providerCode } : {}) }) });
    await run(observed(scripted([err('timeout', 'first_token_timeout')], clock), 'primary', mon, () => clock.t));
    await run(observed(scripted([err('timeout', 'request_timeout')], clock), 'fallback', mon, () => clock.t));
    await run(observed(scripted([err('provider_unavailable')], clock), 'primary', mon, () => clock.t));
    await run(observed(scripted([err('provider_unavailable', '503')], clock), 'primary', mon, () => clock.t));
    await run(observed(scripted([err('validation', '404')], clock), 'primary', mon, () => clock.t));
    const ac = new AbortController();
    ac.abort();
    await run(observed(scripted([err('timeout')], clock), 'primary', mon, () => clock.t), { signal: ac.signal });
    expect(seen).toEqual([
      ['primary', { outcome: 'first_token_timeout', model: 'm' }],
      ['fallback', { outcome: 'first_token_timeout', model: 'm' }],
      ['primary', { outcome: 'unreachable' }],
    ]);
  });

  it("a turn's own time to first token reaches its plan's meter, and only for the model that answered it", async () => {
    const clock = { t: 0 };
    const p = observed(scripted([{ type: 'text', delta: 'x' }, done], clock, 250), 'fallback', () => undefined, () => clock.t);
    const r = await runLocalPlan(
      { primaryState: 'cold', warmPrimary: true, steps: [{ kind: 'local', which: 'fallback', state: 'loaded', ...SMALL }] },
      async () => {
        clock.t += 100; // recall, routing: the turn's own time before the model is asked
        return run(p);
      },
      { progressed: () => false, now: () => clock.t },
    );
    expect(r.meter).toEqual({ which: 'fallback', state: 'loaded', firstTokenMs: 350 });
  });

  it('generate() is watched too: it says the model answered, and records no time (a whole reply has no first token to time)', async () => {
    const clock = { t: 0 };
    const seen: TurnObservation[] = [];
    const p = observed(scripted([], clock, 120), 'primary', () => ({ observe: (_w, o) => void seen.push(o) }), () => clock.t);
    await p.generate({ model: 'm', messages: [user] });
    expect(seen).toEqual([{ outcome: 'ok', model: 'm' }]);
    const failing: ProviderAdapter = { ...scripted([], clock), generate: () => Promise.reject(new FlintError(makeAiError('timeout', 'x', { retryable: false, providerCode: 'request_timeout' }))) };
    await expect(observed(failing, 'primary', () => ({ observe: (_w, o) => void seen.push(o) })).generate({ model: 'm', messages: [user] })).rejects.toThrow();
    expect(seen.at(-1)).toEqual({ outcome: 'first_token_timeout', model: 'm' });
  });

  // The routing review: on Ollama's own API the first pass of a turn with tools answers whole, so its events
  // come out when the whole reply is in. Timed by them, "time to first token" was the time to the last one.
  describe('timed by the adapter\'s own hook (Ollama\'s API)', () => {
    /** An adapter whose reply takes `wholeMs`, and which says (through its hook) that the first line came at `firstMs`. */
    function hooked(clock: { t: number }, firstMs: number | undefined, wholeMs: number, hook: () => void, events: StreamEvent[]): ProviderAdapter {
      const reply = async () => {
        if (firstMs !== undefined) {
          clock.t += firstMs;
          hook();
        }
        clock.t += wholeMs - (firstMs ?? 0);
        await Promise.resolve();
      };
      return {
        name: 'ollama',
        getCapabilities: () => caps,
        estimateTokens: () => 1,
        generate: async () => {
          await reply();
          return { message: { id: 'a', role: 'assistant', content: 'ok', timestamp: 0 }, usage: { input: 1, output: 1 }, reason: 'complete' };
        },
        async *stream() {
          await reply();
          for (const e of events) yield e;
        },
      };
    }
    const watch = (clock: { t: number }, seen: TurnObservation[]) => watcher('primary', () => ({ observe: (_w, o) => void seen.push(o) }), () => clock.t, 'callback');

    it('a whole pass read as a stream: the time is the first line\'s, not the whole reply\'s', async () => {
      const clock = { t: 0 };
      const seen: TurnObservation[] = [];
      const w = watch(clock, seen);
      const p = w.provider(hooked(clock, 180, 9000, () => w.onFirstOutput(), [{ type: 'text', delta: 'The whole answer, at once.' }, done]));
      await run(p, { tools: [] });
      expect(seen).toEqual([{ outcome: 'ok', model: 'm', firstTokenMs: 180 }]);
      await p.generate({ model: 'm', messages: [user] });
      expect(seen).toEqual([{ outcome: 'ok', model: 'm', firstTokenMs: 180 }, { outcome: 'ok', model: 'm', firstTokenMs: 180 }]);
    });

    it('a whole pass that was NOT read as a stream (the cloud mode: no deadline, so no stream): the model answered, and no time is recorded', async () => {
      const clock = { t: 0 };
      const seen: TurnObservation[] = [];
      const w = watch(clock, seen);
      const p = w.provider(hooked(clock, undefined, 9000, () => w.onFirstOutput(), [{ type: 'text', delta: 'The whole answer.' }, done]));
      await run(p);
      expect(seen).toEqual([{ outcome: 'ok', model: 'm' }]);
    });

    it('two turns at once: each hook marks its own call', async () => {
      const clock = { t: 0 };
      const seen: TurnObservation[] = [];
      const w = watch(clock, seen);
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const slow: ProviderAdapter = {
        name: 'ollama',
        getCapabilities: () => caps,
        estimateTokens: () => 1,
        generate: async () => {
          throw new Error('unused');
        },
        async *stream(args) {
          const mine = (args.messages[0] as Message).content;
          if (mine === 'first') await gate; // the first call's first line comes AFTER the second's
          clock.t += 10;
          w.onFirstOutput();
          yield { type: 'text', delta: mine };
          yield done;
        },
      };
      const p = w.provider(slow);
      const a = run(p, { messages: [{ ...user, content: 'first' }] });
      const b = run(p, { messages: [{ ...user, content: 'second' }] });
      await b;
      release();
      await a;
      // Both were sent at t=0. The second's line came at 10, the first's at 20: each call got its own time.
      expect(seen).toEqual([{ outcome: 'ok', model: 'm', firstTokenMs: 10 }, { outcome: 'ok', model: 'm', firstTokenMs: 20 }]);
    });

    it('the pass after a tool result is still not timed', async () => {
      const clock = { t: 0 };
      const seen: TurnObservation[] = [];
      const w = watch(clock, seen);
      await run(w.provider(hooked(clock, 50, 60, () => w.onFirstOutput(), [{ type: 'text', delta: 'x' }, done])), { messages: [user, toolResult] });
      expect(seen).toEqual([{ outcome: 'ok', model: 'm' }]);
    });

    it('a consumer that stops early closes the inner stream', async () => {
      let closed = false;
      const inner: ProviderAdapter = {
        name: 'ollama',
        getCapabilities: () => caps,
        estimateTokens: () => 1,
        generate: async () => {
          throw new Error('unused');
        },
        async *stream() {
          try {
            yield { type: 'text', delta: 'a' };
            yield { type: 'text', delta: 'b' };
          } finally {
            closed = true;
          }
        },
      };
      for await (const _ of observed(inner, 'primary', () => undefined).stream({ model: 'm', messages: [user] })) {
        void _;
        break;
      }
      expect(closed).toBe(true);
    });
  });

  it('observationOf', () => {
    expect(observationOf({ kind: 'timeout', providerCode: 'idle_timeout' })).toBe('first_token_timeout');
    expect(observationOf({ kind: 'timeout', providerCode: 'request_timeout' })).toBe('first_token_timeout');
    expect(observationOf({ kind: 'timeout', providerCode: 'first_token_timeout' })).toBe('first_token_timeout');
    expect(observationOf({ kind: 'provider_unavailable' })).toBe('unreachable');
    expect(observationOf({ kind: 'provider_unavailable', providerCode: '500' })).toBe('error');
    expect(observationOf({ kind: 'timeout' })).toBe('error');
  });
});

describe('cloudChainFor: the cloud step of a hybrid turn no local model could answer', () => {
  const brain = (label: string): BrainTier<string> => {
    const [provider, model] = label.split(':') as [string, string];
    return { tier: 'standard', provider: { name: provider } as ProviderAdapter, model, label, persona: `P-${label}` };
  };
  const chooser = (chain: BrainTier<string>[]) => ({ chain: () => chain, get: () => chain[0]!, primary: chain[0]! });
  const ok = { status: () => ({ level: 'ok' as const, binding: undefined }) };

  it('is the spend plan for the tier, without the brains the breaker has paused', () => {
    const chain = [brain('anthropic:opus'), brain('openai:gpt')];
    const paused = { paused: (p: string) => (p === 'anthropic' ? ('credit' as const) : undefined) };
    const r = cloudChainFor({ brains: chooser(chain) as never, tier: 'hard', guard: ok as never, breaker: paused });
    expect(r?.chain.map((b) => b.label)).toEqual(['openai:gpt']);
    expect(r?.tier).toBe('hard');
  });

  it('nothing configured, or everything paused: no cloud step', () => {
    expect(cloudChainFor({ brains: undefined, tier: 'standard', guard: ok as never, breaker: { paused: () => undefined } })).toBeUndefined();
    expect(cloudChainFor({ brains: chooser([brain('anthropic:opus')]) as never, tier: 'standard', guard: ok as never, breaker: { paused: () => 'auth' } })).toBeUndefined();
  });
});

describe('what a turn says about its local side', () => {
  const primary: LocalStep<string> = { kind: 'local', which: 'primary', model: 'main-model', persona: 'P' };
  const standby: LocalStep<string> = { kind: 'local', which: 'fallback', model: 'small-model', persona: 'S' };
  const cloud: LocalStep<string> = { kind: 'cloud' };

  it('routeLocal: the main model answered, and nothing fell anywhere', () => {
    expect(routeLocal({ step: primary, meter: { which: 'primary', state: 'loaded', firstTokenMs: 412 } }, { primaryState: 'loaded' }, false)).toEqual({
      local: { which: 'primary', state: 'loaded', firstTokenMs: 412 },
    });
  });

  it('routeLocal: the standby answered: fellTo fallback, with the MAIN model\'s state as the reason', () => {
    expect(routeLocal({ step: standby, meter: { which: 'fallback', state: 'loaded', firstTokenMs: 90 } }, { primaryState: 'loading' }, false)).toEqual({
      local: { which: 'fallback', state: 'loading', firstTokenMs: 90 },
      fellTo: 'fallback',
    });
  });

  it('routeLocal: a hybrid turn the cloud answered: fellTo cloud, and no local block', () => {
    expect(routeLocal({ step: cloud }, { primaryState: 'cold' }, false)).toEqual({ fellTo: 'cloud' });
  });

  it('routeLocal: a cloud turn the local model answered: fellTo local', () => {
    expect(routeLocal({ step: primary }, { primaryState: 'loaded' }, true)).toEqual({ local: { which: 'primary', state: 'loaded' }, fellTo: 'local' });
    // The standby taking a cloud turn is still "the standby".
    expect(routeLocal({ step: standby }, { primaryState: 'cold' }, true).fellTo).toBe('fallback');
  });

  it('routeLocal: a turn that never reached the local plan adds nothing', () => {
    expect(routeLocal(undefined, { primaryState: 'loaded' }, true)).toEqual({});
  });

  it('stepName: by role and name, for a log line', () => {
    expect(stepName(primary)).toBe('the main model main-model');
    expect(stepName(standby)).toBe('the standby small-model');
    expect(stepName(cloud)).toBe('the cloud');
  });

  it('standbyNote: a complete sentence that says why it was not the main model', () => {
    for (const state of ['cold', 'loading', 'loaded'] as const) expect(standbyNote({ primaryState: state })).toBe('My standby model answered this while my main model loads.');
    expect(standbyNote({ primaryState: 'unavailable' })).toBe('My standby model answered this because my main model isn’t available.');
  });
});
