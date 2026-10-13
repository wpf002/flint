import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EMBEDDING_MODEL, hardwareTier, isFlintError, type Tool } from '@flint/core';
import { buildInference, type Inference } from '../src/inference';
import type { Hardware } from '../src/hardware';
import type { ModeRoute } from '../src/mode-route';
import { OUTSIDE_OFF_LOCAL_MODE, OUTSIDE_OFF_PRIVATE, OUTSIDE_OFF_PRIVATE_SERVER, PRIVATE_TURN_NOTE } from '../src/outside-ai';
import { asLocalTurn, isPrivateRequest, withTurnTaint } from '../src/turn-taint';
import { keepsPrivate, staysHere } from '../src/goals-now';
import { embedderHere } from '../src/goals-chat';
import { LOCALITY } from '../src/ollama-locality';
import { brainOf, placedHere, setPlaceRules } from '../src/policy';
import { listed } from './goals-mini';
import { startMockLocalServer, type MockLocalServer, type MockModel } from './mock-local-server';

/**
 * Local inference as main() holds it: the mode, the local brain and its
 * health, and each decision the handlers take from them.
 */

const MAIN = 'main-model:30b';
let server: MockLocalServer | undefined;
const dirs: string[] = [];
const built: Inference[] = [];
afterEach(async () => {
  for (const i of built.splice(0)) i.stop();
  await server?.close();
  server = undefined;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  // What a model server listed, and what the settings said about addresses, are the server's own for its life
  // (../src/ollama-locality, ../src/policy): each test starts with neither.
  LOCALITY.clear();
  setPlaceRules({});
});

/** Will's Mac, as detection reports it. Injected: no test runs a program to find out. */
const MAC: Hardware = { platform: 'darwin', arch: 'arm64', accelerator: 'apple-silicon', memoryGb: 64, systemMemoryGb: 64, chip: 'Apple M5 Max', notes: [] };
const detect = async () => MAC;
/** A network that is not there: for a test whose address is not this Mac, so nothing is ever sent to it. */
const offline = (async () => {
  throw new TypeError('fetch failed');
}) as unknown as typeof fetch;

async function boot(models: Record<string, MockModel>, env: Record<string, string> = {}, opts: { connects?: number[]; modeFile?: string; hardware?: Hardware; observeOnly?: boolean; noWait?: boolean; detect?: () => Promise<Hardware> } = {}) {
  server ??= await startMockLocalServer({ models });
  const dir = mkdtempSync(join(tmpdir(), 'flint-inference-'));
  dirs.push(dir);
  const lines: string[] = [];
  const modeFile = opts.modeFile ?? join(dir, 'inference.json');
  const inference = await buildInference({
    env: { OLLAMA_HOST: server.origin, OLLAMA_MODEL: MAIN, OLLAMA_NUM_CTX: '16384', ...env },
    modeFile,
    log: (m) => lines.push(m),
    connect: async (_h, _p, ms) => void opts.connects?.push(ms),
    detect: opts.detect ?? (async () => opts.hardware ?? MAC),
    pick: { capMs: 500 },
    ...(opts.observeOnly ? { observeOnly: true } : {}),
  });
  built.push(inference);
  // The first pass behind the boot (the machine, the tier, one look at the server): what the server does not wait for.
  if (!opts.noWait) await inference.ready;
  return { inference, lines, s: server, modeFile };
}

const SMALL = 'small-model:3b';
/** The embedding model, downloaded and not in memory: what a machine that runs Flint has. (A test that wants it missing leaves it out.) */
const EMBED = EMBEDDING_MODEL.model;
const loaded: Record<string, MockModel> = { [MAIN]: { loaded: true, contextLength: 16384, capabilities: ['completion', 'tools'] }, [EMBED]: {} };
const both: Record<string, MockModel> = { ...loaded, [SMALL]: { loaded: true, contextLength: 4096, capabilities: ['completion', 'tools'] } };
const route = (over: Partial<ModeRoute>): ModeRoute => ({ brain: 'local', localFallback: true, cloudFallback: false, reason: 'mode_local', mode: 'local', private: false, ...over });
const tool = (name: string): Tool => ({ definition: { name, description: name, inputSchema: { type: 'object', properties: {} }, idempotent: true }, handler: () => `${name} ran` });

describe('the mode', () => {
  it('is cloud with nothing set: routes are routeTurn, and no timer watches the model server', async () => {
    const { inference, lines } = await boot(loaded);
    expect(inference.mode.current()).toBe('cloud');
    expect(inference.local.monitor.running).toBe(false);
    expect(inference.preRoute({ message: 'hi', localOnly: false, deep: false, evalMode: false, hasFrontier: true, needs: {}, frontierCan: {} })).toMatchObject({ brain: 'frontier', reason: 'mode_cloud' });
    expect(lines).toContain('[inference] mode=cloud (default)');
    // The one look at boot still ran: the log and the status know the model's state.
    expect(lines).toContain(`[local] primary ${MAIN}: loaded (context 16384)`);
  });

  it('FLINT_INFERENCE_MODE=hybrid starts the timer; an invalid value runs as local, never cloud', async () => {
    const hybrid = await boot(loaded, { FLINT_INFERENCE_MODE: 'hybrid' });
    expect(hybrid.inference.mode.current()).toBe('hybrid');
    expect(hybrid.inference.local.monitor.running).toBe(true);
    const typo = await boot(loaded, { FLINT_INFERENCE_MODE: 'cloudy' });
    expect(typo.inference.mode.current()).toBe('local');
    expect(typo.lines).toContain('[inference] FLINT_INFERENCE_MODE is not one of local, cloud, hybrid; running as local, which never uses the cloud');
    expect(typo.lines).toContain('[inference] mode=local (the env value is invalid, so local)');
    expect(typo.inference.preRoute({ message: 'hi', localOnly: false, deep: true, evalMode: false, hasFrontier: true, needs: {}, frontierCan: {} })).toMatchObject({ brain: 'local', reason: 'mode_local' });
  });

  it('a change while running is followed at once: the timer, the routes, and it is saved for the next start', async () => {
    const first = await boot(loaded);
    first.inference.mode.set('local', 'console');
    expect(first.inference.local.monitor.running).toBe(true);
    expect(first.inference.preRoute({ message: 'hi', localOnly: false, deep: false, evalMode: false, hasFrontier: true, needs: {}, frontierCan: {} })).toMatchObject({ brain: 'local' });
    first.inference.mode.set('cloud', 'console');
    expect(first.inference.local.monitor.running).toBe(false);
    first.inference.mode.set('hybrid', 'console');
    // A restart: the saved mode wins over the environment.
    const again = await boot(loaded, { FLINT_INFERENCE_MODE: 'cloud' }, { modeFile: first.modeFile });
    expect(again.inference.mode.current()).toBe('hybrid');
    expect(again.lines).toContain('[inference] mode=hybrid (saved in Settings; env says cloud)');
    expect(again.inference.local.monitor.running).toBe(true);
  });

  // The routing review's B1 and B2, at the facade: Will had saved Local, the file was cut short, the
  // environment says nothing, and after the restart a plain turn went to the cloud.
  it('a restart with a damaged saved mode: Flint is in Local, and a plain turn (even a deep one) stays on this Mac', async () => {
    const first = await boot(loaded);
    first.inference.mode.set('local', 'console');
    writeFileSync(first.modeFile, '{"version":1,"mode":"loc');
    const again = await boot(loaded, {}, { modeFile: first.modeFile });
    expect(again.inference.mode.current()).toBe('local');
    expect(again.inference.mode.source()).toBe('invalid_saved');
    expect(again.inference.preRoute({ message: 'hi', localOnly: false, deep: true, evalMode: false, hasFrontier: true, needs: {}, frontierCan: {} })).toMatchObject({ brain: 'local', reason: 'mode_local' });
    expect(again.inference.cloudRefused('plan')).toBe('Flint is in Local mode, which never uses the cloud.');
    expect(again.inference.local.monitor.running).toBe(true);
    expect((await again.inference.status()).modeSource).toBe('invalid_saved');
    // With the environment saying cloud, too: the file is something Will chose, and it wins.
    const withEnv = await boot(loaded, { FLINT_INFERENCE_MODE: 'cloud' }, { modeFile: first.modeFile });
    expect(withEnv.inference.mode.current()).toBe('local');
  });

  it('the connect check applies outside the cloud mode only', async () => {
    const connects: number[] = [];
    const { inference } = await boot(loaded, { FLINT_LOCAL_CONNECT_TIMEOUT_MS: '900' }, { connects });
    const user = { id: 'u', role: 'user' as const, content: 'hi', timestamp: 0 };
    await inference.primary.provider.generate({ model: MAIN, messages: [user] });
    expect(connects).toEqual([]);
    inference.mode.set('hybrid', 'console');
    await inference.primary.provider.generate({ model: MAIN, messages: [user] });
    expect(connects).toEqual([900]);
  });
});

describe('what the hybrid rules are told about the local side', () => {
  it('available with tools and the real window when the model is there', async () => {
    const { inference } = await boot(loaded, { FLINT_INFERENCE_MODE: 'hybrid' });
    expect(inference.localFacts()).toEqual({ available: true, tools: true, contextTokens: 16384 });
  });

  it('not available when the model is not downloaded, or the server is another machine', async () => {
    const missing = await boot({}, { FLINT_INFERENCE_MODE: 'hybrid' });
    expect(missing.inference.localFacts().available).toBe(false);
  });

  it('finishRoute fills them in: a plain hybrid message stays here; with the model missing it goes to the cloud', async () => {
    const here = await boot(loaded, { FLINT_INFERENCE_MODE: 'hybrid' });
    const pre = here.inference.preRoute({ message: 'what is for dinner', localOnly: false, deep: false, evalMode: false, hasFrontier: true, needs: {}, frontierCan: {} });
    if ('error' in pre) throw new Error('unexpected');
    expect(here.inference.finishRoute(pre, { tier: 'standard', toolsLikely: false, promptChars: 400 })).toMatchObject({ brain: 'local', reason: 'default', cloudFallback: true });
    // 40,000 characters is about 10,000 tokens: long for a 16,384 window after the reserve.
    expect(here.inference.finishRoute(pre, { tier: 'standard', toolsLikely: false, promptChars: 40_000 })).toMatchObject({ brain: 'frontier', reason: 'long_context' });
  });
});

describe('planLocal: which local model answers, and the sentence when none can', () => {
  const who = { primary: { persona: 'P-main', model: MAIN }, standby: { persona: 'P-small', model: SMALL } };
  const names = (p: { steps: Array<{ kind: string; which?: string }> }) => p.steps.map((s) => (s.kind === 'cloud' ? 'cloud' : s.which === 'primary' ? 'main' : 'standby'));

  it('the main model when it is ready, then the standby', async () => {
    const { inference } = await boot(both, { FLINT_INFERENCE_MODE: 'local', FLINT_LOCAL_FALLBACK_MODEL: SMALL });
    const plan = inference.planLocal(route({}), who);
    expect(names(plan)).toEqual(['main', 'standby']);
    expect(plan.refusal).toBeUndefined();
  });

  it('the main model cold: the standby answers, and the monitor (not the turn) is asked to load the main one', async () => {
    const { inference, s } = await boot({ [MAIN]: { loaded: false, loadMs: 50 }, [SMALL]: { loaded: true, contextLength: 4096 } }, { FLINT_LOCAL_FALLBACK_MODEL: SMALL });
    // (Booted in the cloud mode, so nothing was warmed ahead of time; now Will switches.)
    inference.mode.set('local', 'console');
    const plan = inference.planLocal(route({}), who);
    expect(names(plan)).toEqual(['standby']);
    expect(plan).toMatchObject({ primaryState: 'cold', warmPrimary: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(s.warms()).toContain(MAIN);
    expect(s.chats()).toEqual([]); // no turn was sent to the cold model
  });

  it('no standby configured: the facade never plans one, whatever the handler holds', async () => {
    const { inference } = await boot({ [MAIN]: { loaded: true, contextLength: 16384 } }, { FLINT_INFERENCE_MODE: 'local', FLINT_LOCAL_FALLBACK_MODEL: 'off' });
    expect(names(inference.planLocal(route({}), who))).toEqual(['main']);
  });

  it('Local mode, model not downloaded: a sentence, and never the cloud', async () => {
    const { inference } = await boot({}, { FLINT_INFERENCE_MODE: 'local', FLINT_LOCAL_FALLBACK_MODEL: 'off' });
    expect(inference.planLocal(route({}), who)).toMatchObject({ steps: [], refusal: "The local model isn't downloaded yet, and Local mode never uses the cloud." });
  });

  it('Local mode, server not answering', async () => {
    const { inference, s } = await boot(loaded, { FLINT_INFERENCE_MODE: 'local', FLINT_LOCAL_FALLBACK_MODEL: 'off' });
    s.kind = 'openai'; // the probe routes are gone: the server reads as down
    await inference.local.monitor.check();
    expect(inference.planLocal(route({}), who)).toMatchObject({ steps: [], refusal: "The local model isn't available, and Local mode never uses the cloud." });
  });

  it('Hybrid: a private message says it never leaves this Mac; any other goes to the cloud', async () => {
    const { inference } = await boot({}, { FLINT_INFERENCE_MODE: 'hybrid', FLINT_LOCAL_FALLBACK_MODEL: 'off' });
    expect(inference.planLocal(route({ mode: 'hybrid', reason: 'private', private: true }), who)).toMatchObject({ steps: [], refusal: "The local model isn't downloaded yet, and a private message never leaves this Mac." });
    expect(names(inference.planLocal(route({ mode: 'hybrid', reason: 'default', cloudFallback: true }), who))).toEqual(['cloud']);
  });

  it('a local model server on another machine is refused for a turn that must be local', async () => {
    const offline = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const dir = mkdtempSync(join(tmpdir(), 'flint-inference-'));
    dirs.push(dir);
    const inference = await buildInference({ env: { OLLAMA_HOST: 'http://gpu-box.invalid:11434', OLLAMA_MODEL: MAIN, FLINT_INFERENCE_MODE: 'local' }, modeFile: join(dir, 'm.json'), fetch: offline, detect });
    built.push(inference);
    expect(inference.planLocal(route({}), who).refusal).toBe('The local model server is on another machine, and Local mode never uses the cloud.');
  });

  it('the cloud mode and an eval replay get the main model as before, whatever its state', async () => {
    const { inference } = await boot({}, { FLINT_INFERENCE_MODE: 'local', FLINT_LOCAL_FALLBACK_MODEL: 'off' });
    expect(names(inference.planLocal(route({ mode: 'cloud', reason: 'mode_cloud' }), who))).toEqual(['main']);
    expect(names(inference.planLocal(route({ mode: 'cloud', reason: 'eval' }), who))).toEqual(['main']);
    expect(names(inference.planLocal(route({ mode: 'hybrid', reason: 'eval' }), who))).toEqual(['main']);
  });

  // A turn that stays here is only ever asked of a model that is KNOWN to run here (./policy brainIsLocal): in Local
  // mode that is every turn, an eval replay included, and anywhere it is a turn Will kept private.
  it('a turn that stays here is not asked of a model the server does not list: it gets the sentence, an eval replay too', async () => {
    const { inference } = await boot({}, { FLINT_INFERENCE_MODE: 'local', FLINT_LOCAL_FALLBACK_MODEL: 'off' });
    const SENTENCE = "The local model isn't downloaded yet, and Local mode never uses the cloud.";
    expect(inference.planLocal(route({ reason: 'eval' }), who)).toMatchObject({ steps: [], refusal: SENTENCE });
    // A candidate the replay named itself, which the server does not have either.
    expect(inference.planLocal(route({ reason: 'eval' }), { primary: { persona: 'cand', model: 'never-pulled:7b' }, evalOwnModel: true })).toMatchObject({
      steps: [],
      refusal: 'Flint has not confirmed yet that its local model runs on this Mac, and Local mode never uses the cloud.',
    });
    expect(inference.planLocal(route({ mode: 'cloud', reason: 'eval', private: true }), who)).toMatchObject({ steps: [], refusal: "The local model isn't downloaded yet, and a private message never leaves this Mac." });
  });

  it('...and is asked of one the server lists as its own: the main model, the standby, a candidate a replay named', async () => {
    const { inference } = await boot({ ...both, 'candidate:7b': { loaded: false } }, { FLINT_INFERENCE_MODE: 'local', FLINT_LOCAL_FALLBACK_MODEL: SMALL });
    expect(names(inference.planLocal(route({}), who))).toEqual(['main', 'standby']);
    expect(names(inference.planLocal(route({ mode: 'cloud', reason: 'private', private: true }), who))).toEqual(['main']);
    expect(inference.planLocal(route({ reason: 'eval' }), { primary: { persona: 'cand', model: 'candidate:7b' }, evalOwnModel: true }).steps).toMatchObject([{ kind: 'local', which: 'primary', persona: 'cand' }]);
  });
});

// The final review's H3. `ollama cp gpt-oss:120b-cloud mine` gives a cloud model a plain name: nothing in the
// name says so, the address is this Mac's, and a turn that "stays here" would be answered on Ollama's servers.
// Only Ollama can say, and it does: its listing gives the model a remote host (./ollama-locality).
describe('a cloud model under a plain name: the model server says where it runs, and Flint takes its word', () => {
  const ALIAS = 'mine:latest';
  const aliased: Record<string, MockModel> = { [ALIAS]: { loaded: true, contextLength: 16384, remoteHost: 'https://ollama.com:443' }, [SMALL]: { loaded: true, contextLength: 4096 }, [EMBED]: {} };
  const main = { primary: { persona: 'main', model: ALIAS }, standby: { persona: 'small', model: SMALL } };
  const names = (plan: { steps: Array<{ kind: string; persona?: unknown }> }) => plan.steps.map((s) => (s.kind === 'local' ? s.persona : s.kind));
  const ask = (i: Inference, localOnly = true) => i.preRoute({ message: 'what was my diagnosis', localOnly, deep: false, evalMode: false, hasFrontier: true, needs: {}, frontierCan: {} });

  it('the settings alone see nothing wrong; what is known now says it is a cloud model', async () => {
    const { inference } = await boot(aliased, { OLLAMA_MODEL: ALIAS, FLINT_INFERENCE_MODE: 'local', FLINT_LOCAL_FALLBACK_MODEL: 'off' });
    expect(inference.local.confined).toEqual({ ok: true });
    expect(inference.confined).toEqual({ ok: false, why: 'cloud_model' });
    expect(inference.brainIsLocal(inference.primary.provider, ALIAS)).toBe(false);
    expect(inference.localFacts().available).toBe(false);
    expect(inference.allowedRemote()).toBe(false);
  });

  it('Local mode does not use it: every turn gets the sentence, and Settings says why', async () => {
    const { inference } = await boot(aliased, { OLLAMA_MODEL: ALIAS, FLINT_INFERENCE_MODE: 'local', FLINT_LOCAL_FALLBACK_MODEL: 'off' });
    expect(inference.planLocal(route({}), main)).toMatchObject({ steps: [], refusal: "The local model is one that runs on Ollama's servers, and Local mode never uses the cloud." });
    const st = await inference.status();
    expect(st.local).toMatchObject({ confined: false, notConfined: 'cloud_model' });
    expect(st.local.primary.sentence).toBe("The local model is an Ollama cloud model, which runs on Ollama's servers, so Local and Hybrid modes will not use it.");
    expect(st.local.warnings).toContain("The local model is an Ollama cloud model, which runs on Ollama's servers, so Local and Hybrid modes will not use it.");
  });

  it('a private message is refused where it is routed, in every mode; an ordinary turn in Cloud mode is as it always was', async () => {
    for (const mode of ['cloud', 'hybrid', 'local'] as const) {
      const { inference } = await boot(aliased, { OLLAMA_MODEL: ALIAS, FLINT_INFERENCE_MODE: mode, FLINT_LOCAL_FALLBACK_MODEL: 'off' });
      const tail = mode === 'local' ? 'and Local mode never uses the cloud.' : 'and a private message never leaves this Mac.';
      expect(ask(inference), mode).toEqual({ error: `The local model is one that runs on Ollama's servers, ${tail}`, status: 503 });
      await server!.close();
      server = undefined;
      LOCALITY.clear();
    }
    const { inference } = await boot(aliased, { OLLAMA_MODEL: ALIAS, FLINT_INFERENCE_MODE: 'cloud', FLINT_LOCAL_FALLBACK_MODEL: 'off' });
    expect(ask(inference, false)).toMatchObject({ brain: 'frontier', private: false });
    expect(names(inference.planLocal(route({ mode: 'cloud', reason: 'mode_cloud' }), main))).toEqual(['main']);
  });

  it('Hybrid sends an ordinary turn to the cloud, and never a private one to that model', async () => {
    const { inference } = await boot(aliased, { OLLAMA_MODEL: ALIAS, FLINT_INFERENCE_MODE: 'hybrid', FLINT_LOCAL_FALLBACK_MODEL: 'off' });
    expect(names(inference.planLocal(route({ mode: 'hybrid', reason: 'default', cloudFallback: true }), main))).toEqual(['cloud']);
    expect(inference.planLocal(route({ mode: 'hybrid', reason: 'private', private: true }), main).steps).toEqual([]);
  });

  it('a standby that is a real local model still answers; a standby that is the alias is never asked on a turn that stays here', async () => {
    // The main model is the alias, the standby runs here: with the main model out, the settings' own rule refuses
    // (the local side is not this Mac), so nothing is asked.
    const mainAliased = await boot(aliased, { OLLAMA_MODEL: ALIAS, FLINT_INFERENCE_MODE: 'local', FLINT_LOCAL_FALLBACK_MODEL: SMALL });
    expect(mainAliased.inference.planLocal(route({}), main).steps).toEqual([]);
    await server!.close();
    server = undefined;
    LOCALITY.clear();
    // The other way round: a real main model, and a standby that is the alias. The main model answers; the standby is left out.
    const flipped: Record<string, MockModel> = { [MAIN]: { loaded: true, contextLength: 16384 }, [ALIAS]: { loaded: true, remoteHost: 'https://ollama.com:443' }, [EMBED]: {} };
    const { inference } = await boot(flipped, { FLINT_INFERENCE_MODE: 'local', FLINT_LOCAL_FALLBACK_MODEL: ALIAS });
    expect(inference.confined).toEqual({ ok: true });
    const who = { primary: { persona: 'main', model: MAIN }, standby: { persona: 'small', model: ALIAS } };
    expect(names(inference.planLocal(route({}), who))).toEqual(['main']);
    // ...nor on an ordinary Hybrid turn, which may go to the cloud but is never sent there under the name "standby".
    expect(names(inference.planLocal(route({ mode: 'hybrid', reason: 'default', cloudFallback: true }), who))).toEqual(['main', 'cloud']);
    // Settings says so on its row: not available, with the reason, and nothing to download.
    const st = await inference.status();
    expect(st.local.standby).toMatchObject({ state: 'unavailable', sentence: "It is an Ollama cloud model, which runs on Ollama's servers, so Flint does not use it." });
    expect(st.local.standby!.pull).toBeUndefined();
    expect(st.local.primary.state).toBe('loaded');
    expect(st.local.confined).toBe(true);
  });

  it('the same over the OpenAI-compatible wire, once its server has shown itself to be an Ollama', async () => {
    server = await startMockLocalServer({ models: aliased });
    const { inference } = await boot(aliased, { FLINT_LOCAL_PROVIDER: 'openai', FLINT_LOCAL_BASE_URL: server.baseURL, FLINT_LOCAL_MODEL: ALIAS, FLINT_INFERENCE_MODE: 'local', FLINT_LOCAL_FALLBACK_MODEL: 'off' });
    expect(inference.local.wire).toBe('openai');
    expect(inference.local.server).toBe('ollama');
    expect(inference.confined).toEqual({ ok: false, why: 'cloud_model' });
    expect(inference.brainIsLocal(inference.primary.provider, ALIAS)).toBe(false);
    expect(inference.planLocal(route({}), main).steps).toEqual([]);
  });

  it('an Ollama that stops answering is believed for a few minutes and then not at all: unknown is not "here"', async () => {
    const { inference, s } = await boot(loaded, { FLINT_INFERENCE_MODE: 'local', FLINT_LOCAL_FALLBACK_MODEL: 'off' });
    expect(inference.brainIsLocal(inference.primary.provider, MAIN)).toBe(true);
    // What it said is forgotten (as it would be after five minutes of silence): the model is no longer known to run here.
    LOCALITY.clear();
    expect(inference.brainIsLocal(inference.primary.provider, MAIN)).toBe(false);
    expect(inference.confined).toEqual({ ok: true }); // not known to be elsewhere either
    // The next look at the server (every turn takes one when the last is more than a moment old) hears it again.
    await inference.local.monitor.check();
    expect(inference.brainIsLocal(inference.primary.provider, MAIN)).toBe(true);
    void s;
  });
});

describe('the standby at boot, and when the mode changes', () => {
  it('in the local and hybrid modes a model that is installed and not in memory is warmed at boot, off any turn', async () => {
    const { inference, s } = await boot({ [MAIN]: { loaded: false }, [SMALL]: { loaded: false } }, { FLINT_INFERENCE_MODE: 'hybrid', FLINT_LOCAL_FALLBACK_MODEL: SMALL });
    await new Promise((r) => setTimeout(r, 30));
    expect(s.warms().sort()).toEqual([MAIN, SMALL].sort());
    // The main model is loaded with the context chat sends; the standby with its own small one.
    const loads = s.requests.filter((r) => r.path === '/api/generate').map((r) => [r.model, (r.body!.options as { num_ctx: number }).num_ctx]);
    expect(loads).toContainEqual([MAIN, 16384]);
    expect(loads).toContainEqual([SMALL, hardwareTier('48gb').fallbackContextLength]);
    await inference.local.monitor.check();
    expect(inference.local.monitor.snapshot()).toMatchObject({ primary: { state: 'loaded' }, fallback: { state: 'loaded' } });
    expect(s.chats()).toEqual([]);
  });

  it('in the cloud mode nothing is loaded ahead of a turn; switching to hybrid loads it then', async () => {
    const { inference, s } = await boot({ [MAIN]: { loaded: false }, [SMALL]: { loaded: false } }, { FLINT_LOCAL_FALLBACK_MODEL: SMALL });
    await new Promise((r) => setTimeout(r, 20));
    expect(s.warms()).toEqual([]);
    inference.mode.set('hybrid', 'console');
    await new Promise((r) => setTimeout(r, 40));
    expect(s.warms().sort()).toEqual([MAIN, SMALL].sort());
  });

  it('a main model that leaves memory after it answered a turn is loaded again in the local and hybrid modes; in the cloud mode, and by a status command, never', async () => {
    const leaves = async (env: Record<string, string>, opts: { observeOnly?: boolean } = {}) => {
      const { inference, s } = await boot({ [MAIN]: { loaded: true, contextLength: 16384, capabilities: ['completion', 'tools'] } }, { FLINT_LOCAL_FALLBACK_MODEL: 'off', ...env }, opts);
      await inference.local.monitor.check();
      inference.local.monitor.observe('primary', { outcome: 'ok', firstTokenMs: 20 }); // it answered a turn
      s.models.get(MAIN)!.loaded = false; // ...and then Ollama's keep-alive ran out
      await inference.local.monitor.check();
      await new Promise((r) => setTimeout(r, 30));
      const warmed = s.warms();
      await server!.close();
      server = undefined;
      return warmed;
    };
    expect(await leaves({ FLINT_INFERENCE_MODE: 'hybrid' })).toEqual([MAIN]);
    expect(await leaves({ FLINT_INFERENCE_MODE: 'local' })).toEqual([MAIN]);
    expect(await leaves({})).toEqual([]);
    expect(await leaves({ FLINT_INFERENCE_MODE: 'hybrid' }, { observeOnly: true })).toEqual([]);
  });

  it('a model that is not downloaded is never warmed, and never downloaded', async () => {
    const { s } = await boot({ [MAIN]: { loaded: true, contextLength: 16384 } }, { FLINT_INFERENCE_MODE: 'local', FLINT_LOCAL_FALLBACK_MODEL: SMALL });
    await new Promise((r) => setTimeout(r, 20));
    expect(s.warms()).toEqual([]);
    expect(s.requests.some((r) => /pull/.test(r.path))).toBe(false);
  });
});

describe('observeOnly: the status command looks and never loads', () => {
  it('in hybrid with nothing in memory: the state is reported, and no model is warmed, at boot or on a mode change', async () => {
    const { inference, s } = await boot({ [MAIN]: { loaded: false }, [SMALL]: { loaded: false } }, { FLINT_INFERENCE_MODE: 'hybrid', FLINT_LOCAL_FALLBACK_MODEL: SMALL }, { observeOnly: true });
    await new Promise((r) => setTimeout(r, 30));
    expect(inference.local.monitor.snapshot()).toMatchObject({ primary: { state: 'cold' }, fallback: { state: 'cold' } });
    expect((await inference.status()).lines).toContain(`The local model is ${MAIN} with a 16,384-token context. It is not loaded.`);
    inference.mode.set('local', 'cli');
    await new Promise((r) => setTimeout(r, 30));
    expect(s.warms()).toEqual([]);
    // Nothing but reads reached the model server: no load, no chat, no download.
    expect(s.requests.filter((r) => r.path === '/api/generate' || r.path === '/api/chat' || /pull/.test(r.path))).toEqual([]);
  });

  it('no health timer is left running', async () => {
    const { s } = await boot({ [MAIN]: { loaded: false } }, { FLINT_INFERENCE_MODE: 'local', FLINT_LOCAL_HEALTH_INTERVAL_MS: '2000' }, { observeOnly: true });
    const before = s.requests.length;
    await new Promise((r) => setTimeout(r, 2300));
    expect(s.requests.length).toBe(before);
  });
});

describe('behind the boot: the machine and the model server are looked at after the server is up', () => {
  it('there is a facade to hold before the machine has been looked at; the status says Flint is checking, and then says what it found', async () => {
    let land!: (h: Hardware) => void;
    const detect = () => new Promise<Hardware>((r) => (land = r));
    const started = Date.now();
    const { inference, lines } = await boot(loaded, { FLINT_LOCAL_FALLBACK_MODEL: 'off' }, { noWait: true, detect });
    expect(Date.now() - started).toBeLessThan(500);
    expect(inference.hardware).toBeUndefined();
    expect(inference.tier).toBeUndefined();
    expect(inference.primary).toMatchObject({ model: MAIN, from: 'env', settled: true });
    const early = await inference.status();
    expect(early.hardware).toBeUndefined();
    expect(early.lines).toContain('Flint is checking this machine.');
    expect(lines.some((l) => l.startsWith('[local] hardware:'))).toBe(false);
    land(MAC);
    await inference.ready;
    expect(inference.tier?.id).toBe('48gb');
    const late = await inference.status();
    expect(late.hardware).toMatchObject({ tier: '48gb', chip: 'Apple M5 Max' });
    expect(late.lines).toContain("This Mac's chip is Apple M5 Max, with 64 GB of memory, of which a model can use 48 GB. That is the 48 GB+ tier.");
    expect(late.hardware?.sentence).toBe('This Mac has 64 GB of memory, enough for the largest model.');
  });

  it('FLINT_HARDWARE_TIER needs no look at the machine: the tier is known from the start', async () => {
    const { inference } = await boot(loaded, { FLINT_HARDWARE_TIER: '16gb' }, { noWait: true, detect: () => new Promise<Hardware>(() => {}) });
    expect(inference.tier?.id).toBe('16gb');
    expect(inference.standby?.model).toBe(hardwareTier('16gb').fallbackModel);
  });

  it('a detection that fails is no accelerator known, never a boot that fails', async () => {
    const { inference } = await boot(loaded, {}, { detect: async () => Promise.reject(new Error('no such program')) });
    expect(inference.hardware).toBeUndefined();
    expect((await inference.status()).lines).toContain('Flint is checking this machine.');
    expect(inference.primary.model).toBe(MAIN);
  });

  it("the tier's model lands behind the boot: main() is told once, the monitor follows it, and in hybrid it is warmed", async () => {
    const TIER = hardwareTier('48gb');
    let land!: (h: Hardware) => void;
    const detect = () => new Promise<Hardware>((r) => (land = r));
    const { inference, s } = await boot(
      { [TIER.model]: { loaded: false }, 'other-model:7b': { loaded: true, contextLength: 4096 } },
      { OLLAMA_MODEL: '', OLLAMA_NUM_CTX: '', FLINT_INFERENCE_MODE: 'hybrid', FLINT_LOCAL_FALLBACK_MODEL: 'off' },
      { noWait: true, detect },
    );
    let adopted = 0;
    inference.onAdopt(() => (adopted += 1));
    const first = inference.local;
    expect(inference.primary).toMatchObject({ model: 'other-model:7b', from: 'loaded' });
    land(MAC);
    await inference.ready;
    expect(adopted).toBe(1);
    expect(inference.local).not.toBe(first);
    expect(inference.primary).toMatchObject({ model: TIER.model, from: 'tier', numCtx: TIER.contextLength });
    expect(inference.local.monitor).toBe(first.monitor);
    expect(inference.local.monitor.running).toBe(true);
    await new Promise((r) => setTimeout(r, 40));
    // The adopted model, not the one it replaced, is the one loaded ahead of a turn, at the tier's context.
    expect(s.warms()).toEqual([TIER.model]);
    expect(s.requests.filter((r) => r.path === '/api/generate').map((r) => (r.body!.options as { num_ctx: number }).num_ctx)).toEqual([TIER.contextLength]);
  });

  it('stop() ends the health timer and anything still asking', async () => {
    const { inference, s } = await boot(loaded, { FLINT_INFERENCE_MODE: 'local', FLINT_LOCAL_HEALTH_INTERVAL_MS: '2000' });
    expect(inference.local.monitor.running).toBe(true);
    // (The tier's standby landed with the first pass, and the look that follows it may still be on its way.)
    await new Promise((r) => setTimeout(r, 60));
    inference.stop();
    expect(inference.local.monitor.running).toBe(false);
    const before = s.requests.length;
    await new Promise((r) => setTimeout(r, 2300));
    expect(s.requests.slice(before).map((r) => r.path)).toEqual([]);
  });
});

describe('two promises: Local mode uses no outside AI and no paid service; a private turn sends nothing off this Mac', () => {
  const search = (): Tool => ({ definition: { name: 'web.web_search', description: 'search', inputSchema: { type: 'object', properties: { query: { type: 'string' }, keyless: { type: 'boolean' } } }, idempotent: true }, handler: () => 'hits' });
  const wired = () => [search(), tool('trident.perplexity_search'), tool('trident.web_search'), tool('web.fetch_url')];

  it('Local mode, an ordinary turn: the keyless search, the page fetch and his account tools stay; no outside AI, no paid search', async () => {
    const { inference } = await boot(loaded, { FLINT_INFERENCE_MODE: 'local' });
    const tools = wired();
    // Before the server has said what is wired, everything in the paid-tool table is withheld.
    expect(inference.offer(tools, { mode: 'local' }).map((t) => t.definition.name)).toEqual(['web.fetch_url']);
    inference.declareTools(tools);
    expect(inference.offer(tools, { mode: 'local' }).map((t) => t.definition.name)).toEqual(['web.web_search', 'web.fetch_url']);
    const more = [...tools, tool('google.gmail_search'), tool('deep_research'), tool('remember')];
    expect(inference.offer(more, { mode: 'local', private: false }).map((t) => t.definition.name)).toEqual(['web.web_search', 'web.fetch_url', 'google.gmail_search', 'deep_research', 'remember']);
    expect(inference.offer(tools, { mode: 'hybrid' })).toHaveLength(4);
    expect(inference.outsideOff()).toBe(OUTSIDE_OFF_LOCAL_MODE);
    inference.mode.set('cloud', 'console');
    expect(inference.outsideOff()).toBeUndefined();
    // A turn that was routed in Local mode keeps that mode's rule to its end, whatever the mode is by then.
    expect(asLocalTurn(() => inference.outsideOff(), { staysHere: true })).toBe(OUTSIDE_OFF_LOCAL_MODE);
    expect(asLocalTurn(() => inference.outsideOff())).toBeUndefined();
  });

  // The routing review's S8: a private turn (Local Only, or the words) could still call Perplexity and Tavily.
  // (The final review's M2: a private turn still searched the web keyless, fetched pages and asked Google.)
  it('a private turn, in any mode: only the tools that run on this Mac are offered, and everything outside is off while a local model answers it', async () => {
    const { inference, lines } = await boot(loaded, { FLINT_INFERENCE_MODE: 'hybrid' });
    const tools = [...wired(), tool('google.gmail_search'), tool('deep_research'), tool('remember'), tool('runtime.world_search')];
    inference.declareTools(tools);
    for (const mode of ['hybrid', 'cloud', 'local'] as const) {
      expect(inference.offer(tools, { mode, private: true }).map((t) => t.definition.name), mode).toEqual(['remember', 'runtime.world_search']);
    }
    for (const mode of ['hybrid', 'cloud'] as const) expect(inference.offer(tools, { mode, private: false })).toHaveLength(8);
    // Outside the turn: on. Inside a local model's turn that is not private (a hybrid turn kept here): on.
    expect(inference.outsideOff()).toBeUndefined();
    expect(asLocalTurn(() => inference.outsideOff())).toBeUndefined();
    // Inside a private turn, and in anything it sets off (deep_research opens its own scope inside it): off.
    expect(asLocalTurn(() => inference.outsideOff(), { private: true })).toBe(OUTSIDE_OFF_PRIVATE);
    // Private wins over Local mode: its rule is the stricter one (no keyless search either, ./spend meterPaidTools).
    inference.mode.set('local', 'console');
    expect(asLocalTurn(() => inference.outsideOff(), { private: true, staysHere: true })).toBe(OUTSIDE_OFF_PRIVATE);
    inference.mode.set('hybrid', 'console');
    expect(await asLocalTurn(async () => withTurnTaint(async () => (await Promise.resolve(), inference.outsideOff())), { private: true })).toBe(OUTSIDE_OFF_PRIVATE);
    inference.outsideRefused('trident.perplexity_search', OUTSIDE_OFF_PRIVATE);
    inference.outsideRefused('trident.web_search', OUTSIDE_OFF_LOCAL_MODE);
    expect(lines.slice(-2)).toEqual(['[inference] outside tool refused (trident.perplexity_search, private)', '[inference] outside tool refused (trident.web_search, local_mode)']);
  });

  it('what a response says about its route: the mode, the rule, and private only when it is', async () => {
    const { inference } = await boot(loaded, { FLINT_INFERENCE_MODE: 'hybrid' });
    expect(inference.routeFields(route({ mode: 'hybrid', reason: 'private', private: true }))).toEqual({ mode: 'hybrid', reason: 'private', private: true });
    expect(inference.routeFields(route({ mode: 'hybrid', reason: 'default' }))).toEqual({ mode: 'hybrid', reason: 'default' });
  });
});

describe('which brain is on this Mac, as the facade answers it', () => {
  const fake = (name: string, baseURL?: string) => ({ name, ...(baseURL ? { baseURL } : {}) });

  it("the local brain it built is local; a cloud brain, a server elsewhere and a brain with no address are not", async () => {
    const { inference, s } = await boot(both, { FLINT_LOCAL_FALLBACK_MODEL: SMALL });
    // The brains ./local-brains built keep their server's address readable through the watcher.
    expect(inference.brainIsLocal(inference.primary.provider, inference.primary.model)).toBe(true);
    expect(inference.brainIsLocal(inference.standby!.provider, inference.standby!.model)).toBe(true);
    expect((inference.primary.provider as { baseURL?: string }).baseURL).toBe(s.origin);
    expect(inference.brainIsLocal(fake('anthropic'), 'claude-big')).toBe(false);
    expect(inference.brainIsLocal(fake('ollama', 'http://gpu-box.lan:11434'), 'big-model:72b')).toBe(false);
    expect(inference.brainIsLocal(fake('ollama', s.origin), 'gpt-oss:120b-cloud')).toBe(false);
    expect(inference.brainIsLocal(fake('ollama'), 'no-address')).toBe(false);
  });

  it('a stand-in brain (nothing settled) is not local: it has no server it may be asked on', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'flint-inference-'));
    dirs.push(dir);
    const inference = await buildInference({ env: { OLLAMA_HOST: 'http://127.0.0.1:9' }, modeFile: join(dir, 'm.json'), fetch: offline, detect, pick: { capMs: 200 }, observeOnly: true });
    built.push(inference);
    expect(inference.primary.settled).toBe(false);
    expect(inference.brainIsLocal(inference.primary.provider, inference.primary.model)).toBe(false);
  });

  it('FLINT_LOCAL_ALLOW_REMOTE=1 makes the configured local server Will\'s own, and no other', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'flint-inference-'));
    dirs.push(dir);
    const env = { OLLAMA_HOST: 'http://gpu-box.invalid:11434', OLLAMA_MODEL: MAIN, FLINT_LOCAL_ALLOW_REMOTE: '1' };
    const allowed = await buildInference({ env, modeFile: join(dir, 'a.json'), fetch: offline, detect, observeOnly: true });
    built.push(allowed);
    // The address is his. The model is local once that server has said it runs there (its listing, which the
    // monitor's looks at it hand over): an Ollama's own word, like this Mac's.
    expect(placedHere('http://gpu-box.invalid:11434')).toBe(false); // plain http to another machine is not allowed by that setting alone
    expect(allowed.brainIsLocal(allowed.primary.provider, MAIN)).toBe(false);
    const https = await buildInference({ env: { ...env, OLLAMA_HOST: 'https://gpu-box.invalid:11434' }, modeFile: join(dir, 'c.json'), fetch: offline, detect, observeOnly: true });
    built.push(https);
    expect(placedHere('https://gpu-box.invalid:11434')).toBe(true);
    expect(placedHere('https://someone-else.invalid:11434')).toBe(false);
    expect(https.brainIsLocal(https.primary.provider, MAIN)).toBe(false); // not heard from yet
    listed('https://gpu-box.invalid:11434', [MAIN, 'other-model:7b', { name: 'mine', remote_host: 'https://ollama.com:443' }]);
    listed('https://someone-else.invalid:11434', [MAIN]);
    expect(https.brainIsLocal(https.primary.provider, MAIN)).toBe(true);
    expect(https.brainIsLocal(fake('ollama', 'https://gpu-box.invalid:11434'), 'other-model:7b')).toBe(true);
    expect(https.brainIsLocal(fake('ollama', 'https://gpu-box.invalid:11434'), 'mine')).toBe(false);
    expect(https.brainIsLocal(fake('ollama', 'https://someone-else.invalid:11434'), MAIN)).toBe(false);
    expect(https.brainIsLocal(fake('anthropic', 'https://gpu-box.invalid:11434'), MAIN)).toBe(false);
    // The embedder at that address is here too (it is Ollama's own address, and Will said that machine is his).
    expect(embedderHere('https://gpu-box.invalid:11434')).toBe(true);
    expect(embedderHere('https://someone-else.invalid:11434')).toBe(false);
    // Without the setting, that server is not local, whatever it lists.
    const refused = await buildInference({ env: { ...env, OLLAMA_HOST: 'https://gpu-box.invalid:11434', FLINT_LOCAL_ALLOW_REMOTE: '0' }, modeFile: join(dir, 'b.json'), fetch: offline, detect, observeOnly: true });
    built.push(refused);
    expect(placedHere('https://gpu-box.invalid:11434')).toBe(false);
    expect(refused.brainIsLocal(refused.primary.provider, MAIN)).toBe(false);
  });
});

// The routing review: the embedder, local memory extraction and the runtime's background calls read OLLAMA_HOST
// as it is. With an Ollama on another machine, in Local mode, they still sent it the text of Will's messages.
describe('the helpers that always talk to Ollama\'s own address', () => {
  const at = async (env: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), 'flint-inference-'));
    dirs.push(dir);
    const inference = await buildInference({ env: { OLLAMA_MODEL: MAIN, ...env }, modeFile: join(dir, 'm.json'), fetch: offline, detect, observeOnly: true });
    built.push(inference);
    return inference;
  };
  const REMOTE = { OLLAMA_HOST: 'http://gpu-box.invalid:11434' };
  const OFF = 'the Ollama server is on another machine, and in this mode nothing is sent off this Mac';

  it('on this Mac: never off, in any mode', async () => {
    for (const mode of ['local', 'hybrid', 'cloud']) expect((await at({ FLINT_INFERENCE_MODE: mode })).helpersOff(), mode).toBeUndefined();
  });

  // The final review's M1: in Cloud mode the router and recall embedded a private message's words at that Ollama.
  it('on another machine, in Cloud mode: off for a request whose message is private, from the moment it is routed', async () => {
    const i = await at({ ...REMOTE, FLINT_LOCAL_PROVIDER: 'openai', FLINT_LOCAL_BASE_URL: 'http://127.0.0.1:8080/v1', FLINT_LOCAL_SERVER: 'openai', FLINT_INFERENCE_MODE: 'cloud' });
    expect(i.local.confined).toEqual({ ok: true }); // the brain is here, so the private turn is answered
    const ask = (message: string, localOnly: boolean) => i.preRoute({ message, localOnly, deep: false, evalMode: false, hasFrontier: true, needs: {}, frontierCan: {} });
    const seen = await withTurnTaint(async () => {
      const before = i.helpersOff();
      const pre = ask('what was my diagnosis', true);
      await Promise.resolve();
      // ...and a scope opened inside the request (deep_research's) is held to it too.
      return { before, pre, after: i.helpersOff(), inner: withTurnTaint(() => i.helpersOff()), marked: isPrivateRequest() };
    });
    expect(seen.before).toBeUndefined();
    expect(seen.pre).toMatchObject({ brain: 'local', private: true });
    expect(seen.after).toBe('the Ollama server is on another machine, and a private message is not sent off this Mac');
    expect(seen.inner).toBe(seen.after);
    expect(seen.marked).toBe(true);
    // The words alone make it private too; an ordinary request is as it always was, and so is the next request.
    expect(await withTurnTaint(async () => (ask('keep this private: my diagnosis', false), i.helpersOff()))).toBe(seen.after);
    expect(await withTurnTaint(async () => (ask('what is the weather', false), i.helpersOff()))).toBeUndefined();
    expect(i.helpersOff()).toBeUndefined();
    // With Ollama on this Mac there is nothing to switch off.
    const here = await at({ FLINT_INFERENCE_MODE: 'cloud' });
    expect(await withTurnTaint(async () => (here.preRoute({ message: 'x', localOnly: true, deep: false, evalMode: false, hasFrontier: true, needs: {}, frontierCan: {} }), here.helpersOff()))).toBeUndefined();
  });

  it('on another machine: off in the local and hybrid modes, and as it always was in the cloud mode', async () => {
    expect((await at({ ...REMOTE, FLINT_INFERENCE_MODE: 'local' })).helpersOff()).toBe(OFF);
    expect((await at({ ...REMOTE, FLINT_INFERENCE_MODE: 'hybrid' })).helpersOff()).toBe(OFF);
    expect((await at({ ...REMOTE, FLINT_INFERENCE_MODE: 'cloud' })).helpersOff()).toBeUndefined();
    // It follows the mode Will sets while Flint runs.
    const i = await at({ ...REMOTE });
    expect(i.helpersOff()).toBeUndefined();
    i.mode.set('local', 'console');
    expect(i.helpersOff()).toBe(OFF);
  });

  it('a machine Will said is his: on over https, and over plain http only with his word that the network is private', async () => {
    expect((await at({ OLLAMA_HOST: 'https://gpu-box.invalid:11434', FLINT_LOCAL_ALLOW_REMOTE: '1', FLINT_INFERENCE_MODE: 'local' })).helpersOff()).toBeUndefined();
    expect((await at({ ...REMOTE, FLINT_LOCAL_ALLOW_REMOTE: '1', FLINT_INFERENCE_MODE: 'local' })).helpersOff()).toBe(OFF);
    expect((await at({ ...REMOTE, FLINT_LOCAL_ALLOW_REMOTE: '1', FLINT_LOCAL_ALLOW_INSECURE_REMOTE: '1', FLINT_INFERENCE_MODE: 'local' })).helpersOff()).toBeUndefined();
  });

  it('the rule is about Ollama\'s address even when the local brain is on the other wire, at this Mac', async () => {
    const i = await at({ ...REMOTE, FLINT_LOCAL_PROVIDER: 'openai', FLINT_LOCAL_BASE_URL: 'http://127.0.0.1:8080/v1', FLINT_LOCAL_SERVER: 'openai', FLINT_INFERENCE_MODE: 'local' });
    expect(i.local.confined).toEqual({ ok: true }); // the brain is here...
    expect(i.helpersOff()).toBe(OFF); // ...and the embedder's Ollama is not
  });
});

// The final review's M1. Cloud mode, a model server that is not this Mac (the documented remote OLLAMA_HOST): a
// Local Only turn was sent there, under "private messages stay on this Mac", and then read back without its own history.
describe('a private message and a model server that is not this Mac', () => {
  const at = async (env: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), 'flint-inference-'));
    dirs.push(dir);
    const inference = await buildInference({ env: { OLLAMA_MODEL: MAIN, ...env }, modeFile: join(dir, 'm.json'), fetch: offline, detect, observeOnly: true });
    built.push(inference);
    return { inference, dir };
  };
  const ask = (i: Inference, over: { message?: string; localOnly?: boolean; evalMode?: boolean } = {}) =>
    i.preRoute({ message: over.message ?? 'what was my diagnosis', localOnly: over.localOnly ?? true, deep: false, evalMode: over.evalMode ?? false, hasFrontier: true, needs: {}, frontierCan: {} });
  const SENTENCE = 'The local model server is on another machine, and a private message never leaves this Mac.';

  it('not allowed: refused where it is routed, in every mode, with a sentence and a 503', async () => {
    for (const mode of ['cloud', 'hybrid'] as const) {
      const { inference } = await at({ OLLAMA_HOST: 'http://gpu-box.invalid:11434', FLINT_INFERENCE_MODE: mode });
      expect(inference.local.confined, mode).toEqual({ ok: false, why: 'remote_host' });
      expect(ask(inference), mode).toEqual({ error: SENTENCE, status: 503 });
      // Private by its words, and an eval replay kept local, alike.
      expect(ask(inference, { message: 'keep this private: my diagnosis', localOnly: false }), mode).toEqual({ error: SENTENCE, status: 503 });
      expect(ask(inference, { evalMode: true }), mode).toEqual({ error: SENTENCE, status: 503 });
      expect(inference.allowedRemote()).toBe(false);
    }
    const local = (await at({ OLLAMA_HOST: 'http://gpu-box.invalid:11434', FLINT_INFERENCE_MODE: 'local' })).inference;
    expect(ask(local)).toEqual({ error: 'The local model server is on another machine, and Local mode never uses the cloud.', status: 503 });
  });

  it('not allowed, Cloud mode: a turn that is not private is as it always was', async () => {
    const { inference } = await at({ OLLAMA_HOST: 'http://gpu-box.invalid:11434', FLINT_INFERENCE_MODE: 'cloud' });
    expect(ask(inference, { message: 'hello', localOnly: false })).toMatchObject({ brain: 'frontier', reason: 'mode_cloud', private: false });
    expect(inference.preRoute({ message: 'hello', localOnly: false, deep: false, evalMode: false, hasFrontier: false, needs: {}, frontierCan: {} })).toMatchObject({ brain: 'local', private: false });
  });

  it('allowed (FLINT_LOCAL_ALLOW_REMOTE=1, over https): it is answered there, and that server reads its own private turns back', async () => {
    const { inference, dir } = await at({ OLLAMA_HOST: 'https://gpu-box.invalid:11434', FLINT_LOCAL_ALLOW_REMOTE: '1', FLINT_INFERENCE_MODE: 'cloud' });
    expect(inference.local.confined).toEqual({ ok: true });
    expect(inference.allowedRemote()).toBe(true);
    expect(ask(inference)).toMatchObject({ brain: 'local', private: true, mode: 'cloud' });
    void dir;
    // Once that server has said the model runs on it, its brain is one that reads what stays here: the brain that
    // answered a private turn is handed it back (the NEW regression M1 named), by the one rule every history view,
    // recall and the extractor use (../src/goals-now).
    const there = brainOf(inference.primary.provider, MAIN);
    expect(keepsPrivate(there)).toBe(false); // not heard from yet: nothing is assumed
    listed('https://gpu-box.invalid:11434', [MAIN]);
    expect(keepsPrivate(there)).toBe(true);
    expect(staysHere(there, false)).toBe(true);
    // ...and no other server is: an outside brain, or an Ollama somewhere else, reads the view without it.
    listed('https://someone-else.invalid:11434', [MAIN]);
    expect(keepsPrivate({ provider: 'anthropic', model: 'claude-big' })).toBe(false);
    expect(keepsPrivate({ provider: 'ollama', model: MAIN, baseURL: 'https://someone-else.invalid:11434' })).toBe(false);
    // What the model is told, and what a tool that does not run here answers, name that server as Settings does.
    expect(inference.withPrivateNote('the clock', { private: true })).toBe(
      'the clock\n\n[Private message: nothing outside this Mac or the model server you allowed is asked for it, so answer from this conversation and what you already know, with no web search, page reading, account lookup or research.]',
    );
    expect(inference.withPrivateNote('the clock', { private: false })).toBe('the clock');
    expect(asLocalTurn(() => inference.outsideOff(), { private: true })).toBe(OUTSIDE_OFF_PRIVATE_SERVER);
    expect(OUTSIDE_OFF_PRIVATE_SERVER).toBe('This message is private, so nothing outside this Mac or the model server you allowed is asked.');
    // Plain http to another machine is not allowed by that setting alone.
    const plain = (await at({ OLLAMA_HOST: 'http://gpu-box.invalid:11434', FLINT_LOCAL_ALLOW_REMOTE: '1', FLINT_INFERENCE_MODE: 'cloud' })).inference;
    expect(plain.local.confined.ok).toBe(false);
    expect(ask(plain)).toMatchObject({ status: 503 });
    expect(plain.allowedRemote()).toBe(false);
  });

  it('on this Mac: nothing is refused, and no sentence names another server', async () => {
    const { inference } = await boot(loaded);
    expect(ask(inference)).toMatchObject({ brain: 'local', private: true });
    expect(inference.allowedRemote()).toBe(false);
    expect(inference.withPrivateNote('the clock', { private: true })).toBe(`the clock\n\n${PRIVATE_TURN_NOTE}`);
    expect(asLocalTurn(() => inference.outsideOff(), { private: true })).toBe(OUTSIDE_OFF_PRIVATE);
    expect(inference.sentences()).toEqual({ modeSentence: 'Cloud models answer, and private messages stay on this Mac.', localOnlySentence: 'Answers stay on this Mac.' });
    inference.mode.set('local', 'console');
    expect(inference.sentences()).toEqual({ modeSentence: 'Every answer comes from this Mac. Flint may still search the web.', localOnlySentence: 'Local mode keeps every answer on this Mac.' });
  });

  it('with a server Will allowed, the sentences a saved mode comes back with name it', async () => {
    const { inference } = await at({ OLLAMA_HOST: 'https://gpu-box.invalid:11434', FLINT_LOCAL_ALLOW_REMOTE: '1', FLINT_INFERENCE_MODE: 'local' });
    expect(inference.sentences()).toEqual({
      modeSentence: 'Every answer stays on this Mac or the model server you allowed. Flint may still search the web.',
      localOnlySentence: 'Local mode keeps every answer on this Mac or the model server you allowed.',
    });
  });
});

// The final review's L1: with Node's env proxy on, a request to 127.0.0.1 goes to the proxy first.
describe("Node's env proxy is on and NO_PROXY does not name the model server", () => {
  const PROXY = { NODE_USE_ENV_PROXY: '1', HTTP_PROXY: 'http://proxy.corp.example:3128' };

  it('the local model server is not this Mac: Local and Hybrid do not use it, a private message is refused, the helpers are off', async () => {
    const { inference, lines } = await boot(loaded, { ...PROXY, FLINT_INFERENCE_MODE: 'local' });
    expect(inference.local.confined).toEqual({ ok: false, why: 'proxy' });
    const ask = (localOnly: boolean) => inference.preRoute({ message: 'hello', localOnly, deep: false, evalMode: false, hasFrontier: true, needs: {}, frontierCan: {} });
    expect(inference.planLocal(route({}), { primary: { persona: 'p', model: MAIN } })).toMatchObject({ steps: [], refusal: 'The local model server is reached through a proxy, and Local mode never uses the cloud.' });
    expect(inference.helpersOff()).toBe('the Ollama server is on another machine, and in this mode nothing is sent off this Mac');
    expect(inference.brainIsLocal(inference.primary.provider, MAIN)).toBe(false);
    expect(inference.localFacts().available).toBe(false);
    expect(lines.some((l) => l.includes("Node's env proxy is on (NODE_USE_ENV_PROXY)") && l.includes('add the host to NO_PROXY'))).toBe(true);
    const st = await inference.status();
    expect(st.local).toMatchObject({ confined: false, notConfined: 'proxy' });
    expect(st.local.primary.sentence).toBe('The local model server is reached through a proxy, so Local and Hybrid modes will not use it.');
    // In Cloud mode an ordinary turn is as it always was; a private one is not sent through the proxy.
    inference.mode.set('cloud', 'console');
    expect(ask(false)).toMatchObject({ brain: 'frontier' });
    expect(ask(true)).toEqual({ error: 'The local model server is reached through a proxy, and a private message never leaves this Mac.', status: 503 });
    // The proxy's address is in nothing Flint logs or shows.
    expect(JSON.stringify(st) + lines.join('\n')).not.toContain('proxy.corp.example');
  });

  it('with the host in NO_PROXY, or the switch off, everything is as it was', async () => {
    const named = await boot(loaded, { ...PROXY, NO_PROXY: '127.0.0.1,localhost,::1', FLINT_INFERENCE_MODE: 'local' });
    expect(named.inference.local.confined).toEqual({ ok: true });
    expect(named.inference.brainIsLocal(named.inference.primary.provider, MAIN)).toBe(true);
    expect(named.inference.helpersOff()).toBeUndefined();
    await server!.close();
    server = undefined;
    const off = await boot(loaded, { HTTP_PROXY: PROXY.HTTP_PROXY, FLINT_INFERENCE_MODE: 'local' });
    expect(off.inference.local.confined).toEqual({ ok: true });
  });
});

describe('cloud calls that are not chat turns', () => {
  it('are refused in Local mode with a reason, logged at most once per kind every ten minutes; allowed in the other modes', async () => {
    const { inference, lines } = await boot(loaded, { FLINT_INFERENCE_MODE: 'local' });
    expect(inference.cloudRefused('plan')).toBe('Flint is in Local mode, which never uses the cloud.');
    inference.cloudRefused('plan');
    inference.cloudRefused('tts');
    expect(lines.filter((l) => l.startsWith('[inference] cloud call refused'))).toEqual(['[inference] cloud call refused in local mode (kind=plan)', '[inference] cloud call refused in local mode (kind=tts)']);
    inference.mode.set('hybrid', 'console');
    expect(inference.cloudRefused('plan')).toBeUndefined();
    inference.mode.set('cloud', 'console');
    expect(inference.cloudRefused('extract')).toBeUndefined();
  });

  it('cloudOnly: the wrapped call is never made in Local mode, and throws what a background caller reads as "not available now"', async () => {
    const { inference } = await boot(loaded, { FLINT_INFERENCE_MODE: 'local' });
    let called = 0;
    const extract = inference.cloudOnly('extract', async (x: number) => {
      called += 1;
      return x * 2;
    });
    const err = await extract(2).catch((e: unknown) => e);
    expect(called).toBe(0);
    expect(isFlintError(err) && err.error.kind).toBe('provider_unavailable');
    inference.mode.set('cloud', 'console');
    expect(await extract(2)).toBe(4);
    expect(called).toBe(1);
  });
});

describe('status', () => {
  it('says the mode and the model in sentences, after a fresh look at the server', async () => {
    const { inference, s } = await boot(loaded, { FLINT_INFERENCE_MODE: 'hybrid', FLINT_LOCAL_FALLBACK_MODEL: 'off' });
    const before = s.requests.length;
    const st = await inference.status({ configured: true, brains: 'standard=anthropic:claude' });
    expect(s.requests.length).toBeGreaterThan(before);
    expect(st).toMatchObject({
      mode: 'hybrid',
      modeSource: 'env',
      local: { wire: 'ollama', server: 'ollama', loopback: true, model: MAIN, modelSource: 'env', contextLength: 16384, tools: true, primary: { model: MAIN, state: 'loaded', contextLength: 16384 }, confined: true, pull: [], warnings: [] },
      cloud: { configured: true },
      problems: [],
    });
    expect(st.hardware).toEqual({
      accelerator: 'apple-silicon',
      chip: 'Apple M5 Max',
      memoryGb: 64,
      usableGb: 48,
      systemMemoryGb: 64,
      tier: '48gb',
      tierLabel: '48 GB+',
      tierSource: 'detected',
      recommended: { model: hardwareTier('48gb').model, name: 'Muse Glimmer 30B', contextLength: 16384, fallbackModel: hardwareTier('48gb').fallbackModel, fallbackName: 'Llama 3.2 3B' },
      name: 'Apple M5 Max',
      sentence: 'This Mac has 64 GB of memory, enough for the largest model.',
      notes: [],
    });
    expect(st.lines).toEqual([
      'Flint is in Hybrid mode. Flint picks this Mac or the cloud for each message.',
      "This Mac's chip is Apple M5 Max, with 64 GB of memory, of which a model can use 48 GB. That is the 48 GB+ tier.",
      `The local model is ${MAIN} with a 16,384-token context. It is ready.`,
      // Will named another model than the tier's: the status says what the table would have chosen.
      `The recommended model for this tier is ${hardwareTier('48gb').model} with a 16,384-token context.`,
      'No standby model is set.',
      `The embedding model is ${EMBED}. It is downloaded.`,
      'A cloud model is configured.',
    ]);
    // What the console shows: a name made for a screen, a sentence for the mode, and nothing to report.
    expect(st.modeSentence).toBe('Flint picks this Mac or the cloud for each message.');
    expect(st.local.primary).toMatchObject({ name: 'Main Model 30B', sentence: 'It is ready.' });
    expect(st.local.embedding).toEqual({ model: EMBED, name: 'Nomic Embed Text', state: 'installed', sentence: 'Memory search uses it.' });
    expect(st.notices).toEqual([]);
  });

  it('a model that is not downloaded comes with the exact pull command, and only then', async () => {
    const { inference } = await boot({}, { FLINT_INFERENCE_MODE: 'local', FLINT_LOCAL_FALLBACK_MODEL: 'off' });
    const st = await inference.status({ configured: false });
    expect(st.local.primary).toMatchObject({ state: 'unavailable', why: 'not_installed', pull: `ollama pull ${MAIN}`, sentence: "It isn't downloaded yet." });
    // The embedding model is not on this server either: its command follows, with the size the table lists.
    expect(st.local.pull).toEqual([`ollama pull ${MAIN}`, `ollama pull ${EMBED}`]);
    expect(st.lines).toContain(`To download it, run:  ollama pull ${MAIN}`);
    expect(st.local.embedding).toEqual({
      model: EMBED,
      name: 'Nomic Embed Text',
      state: 'not_installed',
      pull: `ollama pull ${EMBED}`,
      downloadGb: 0.3,
      sentence: "It isn't downloaded, so memory search matches words and not meaning.",
    });
    const at = st.lines.indexOf(`The embedding model is ${EMBED}. It is not downloaded yet.`);
    expect(st.lines[at + 1]).toBe(`To download it (about 0.3 GB), run:  ollama pull ${EMBED}`);
    expect(st.lines).toContain('No cloud model is configured.');
    // With the model there: no command anywhere.
    await server!.close();
    server = undefined;
    const ok = await boot(loaded, { FLINT_LOCAL_FALLBACK_MODEL: 'off' });
    expect(JSON.stringify(await ok.inference.status({ configured: true }))).not.toContain('ollama pull');
  });

  it('every line is a sentence', async () => {
    // (The cloud mode: in the others the monitor would already have reloaded the model at Flint's context.)
    const { inference } = await boot({ [MAIN]: { loaded: true, contextLength: 32768 } });
    const st = await inference.status({ configured: true, paused: 'anthropic:credit' });
    expect(st.local.warnings).toEqual(['The local model is in memory with a context of 32,768 tokens, and Flint asks for 16,384.']);
    // The REAL monitor's state for it is `cold` with the mismatch flag (the review's C4b), and the row says what
    // the notice says: never "It is not loaded." above "is in memory".
    expect(inference.local.monitor.snapshot().primary).toMatchObject({ state: 'cold', contextMismatch: true, contextLength: 32768 });
    expect(st.local.primary).toMatchObject({ state: 'cold', sentence: 'It reloads on the next local answer.' });
    for (const line of st.lines) {
      if (/^To download it( \(about [\d.]+ GB\))?, run:  ollama pull /.test(line)) continue;
      expect(line, line).toMatch(/^[A-Z].*\.$/);
    }
    for (const line of [...st.notices, st.modeSentence, st.local.primary.sentence, st.hardware!.sentence]) expect(line, line).toMatch(/^[A-Z].*\.$/);
    expect(st.notices).toEqual(st.local.warnings);
    expect(st.lines).toContain('A cloud model is configured, and it is paused right now.');
  });

  it('never holds a key, a token, or more of an address than host:port', async () => {
    const s = (server = await startMockLocalServer({ models: loaded }));
    const { inference } = await boot(loaded, { FLINT_LOCAL_PROVIDER: 'openai', FLINT_LOCAL_BASE_URL: s.baseURL, FLINT_LOCAL_API_KEY: 'sk-local-SECRET', FLINT_TOKEN: 'TOKENSECRET', FLINT_LOCAL_TOOLS: 'nonsense' });
    const text = JSON.stringify(await inference.status({ configured: true }));
    expect(text).not.toContain('SECRET');
    expect(text).not.toMatch(/https?:\/\//);
    expect(text).toContain(new URL(s.origin).host);
    // The config problem is there by key and reason.
    expect(text).toContain('FLINT_LOCAL_TOOLS');
  });
});

describe('the standby in the status', () => {
  it('a standby that is ready, and one that is not downloaded with its own pull command', async () => {
    // (In memory at 4,096, and that is what Flint asks for here: FLINT_LOCAL_FALLBACK_NUM_CTX.)
    const ready = await boot(both, { FLINT_LOCAL_FALLBACK_MODEL: SMALL, FLINT_LOCAL_FALLBACK_NUM_CTX: '4096' });
    const st = await ready.inference.status();
    // (The cloud mode, which never asks the standby: its row says so, and does not claim it answers.)
    expect(st.local.standby).toMatchObject({ model: SMALL, name: 'Small Model 3B', state: 'loaded', contextLength: 4096, sentence: "Cloud mode doesn't use it." });
    ready.inference.mode.set('hybrid', 'cli');
    expect((await ready.inference.status()).local.standby?.sentence).toBe('It answers while the main model loads.');
    expect(st.lines).toContain(`The standby model is ${SMALL}. It is ready.`);
    expect(st.local.pull).toEqual([]);
    await server!.close();
    server = undefined;
    // The tier's own standby, which is not on this server: Flint says so and gives the command. It never downloads it.
    const missing = await boot(loaded);
    const tierStandby = hardwareTier('48gb').fallbackModel;
    const st2 = await missing.inference.status();
    expect(st2.local.standby).toMatchObject({
      model: tierStandby,
      name: 'Llama 3.2 3B',
      state: 'unavailable',
      why: 'not_installed',
      pull: `ollama pull ${tierStandby}`,
      downloadGb: 2,
      sentence: "It isn't downloaded, and Cloud mode doesn't use it.",
    });
    expect(st2.local.pull).toEqual([`ollama pull ${tierStandby}`]);
    const at = st2.lines.indexOf(`The standby model is ${tierStandby}. It is not downloaded yet.`);
    expect(at).toBeGreaterThan(0);
    // The size of the download is stated with the command.
    expect(st2.lines[at + 1]).toBe(`To download it (about 2.0 GB), run:  ollama pull ${tierStandby}`);
    missing.inference.mode.set('local', 'cli');
    expect((await missing.inference.status()).local.standby?.sentence).toBe("It isn't downloaded, so nothing answers while the main model loads.");
    expect(missing.s.requests.some((r) => /pull/.test(r.path))).toBe(false);
  });

  it('what the hybrid rules are told: with the main model missing, an installed standby still makes the local side available', async () => {
    const { inference } = await boot({ [SMALL]: { loaded: true, contextLength: 4096 } }, { FLINT_INFERENCE_MODE: 'hybrid', FLINT_LOCAL_FALLBACK_MODEL: SMALL });
    expect(inference.localFacts().available).toBe(true);
    await server!.close();
    server = undefined;
    const none = await boot({}, { FLINT_INFERENCE_MODE: 'hybrid', FLINT_LOCAL_FALLBACK_MODEL: SMALL });
    expect(none.inference.localFacts().available).toBe(false);
  });
});

describe('the hardware tier', () => {
  const TIER = hardwareTier('48gb');

  it('with no model named, in Local and Hybrid: the tier\'s model is the local brain when it is installed, at the tier\'s context', async () => {
    const { inference, lines } = await boot({ [TIER.model]: { loaded: false }, 'other-model:7b': { loaded: true, contextLength: 4096 } }, { OLLAMA_MODEL: '', OLLAMA_NUM_CTX: '', FLINT_INFERENCE_MODE: 'hybrid' });
    expect(inference.tier.id).toBe('48gb');
    expect(inference.primary).toMatchObject({ model: TIER.model, from: 'tier', numCtx: TIER.contextLength });
    // Memory extraction and background calls are told the same model and window.
    expect(inference.primary.env).toEqual({ OLLAMA_MODEL: TIER.model, OLLAMA_NUM_CTX: String(TIER.contextLength) });
    expect(lines).toContain(`[local] hardware: apple-silicon (Apple M5 Max), 64 GB; tier 48gb; recommended ${TIER.model} at context ${TIER.contextLength}`);
    expect(lines).toContain(`[brain] no local model is named: the local brain is ${TIER.model}, this machine's hardware tier's model (48 GB+); the next turn uses it`);
  });

  it('a tier model that is already in memory keeps the context it is loaded with; OLLAMA_NUM_CTX overrides', async () => {
    const loadedAt = await boot({ [TIER.model]: { loaded: true, contextLength: 8192 } }, { OLLAMA_MODEL: '', OLLAMA_NUM_CTX: '', FLINT_INFERENCE_MODE: 'local' });
    expect(loadedAt.inference.primary).toMatchObject({ model: TIER.model, from: 'tier', numCtx: 8192 });
    expect(loadedAt.inference.local.monitor.snapshot().primary.state).toBe('loaded');
    await server!.close();
    server = undefined;
    const set = await boot({ [TIER.model]: { loaded: true, contextLength: 8192 } }, { OLLAMA_MODEL: '', OLLAMA_NUM_CTX: '32768', FLINT_INFERENCE_MODE: 'local' });
    expect(set.inference.primary).toMatchObject({ from: 'tier', numCtx: 32768 });
    expect(set.inference.primary.env).toEqual({ OLLAMA_MODEL: TIER.model });
  });

  // The final review's M3a. Cloud mode is the mode nothing new was set for: with no model named, another model in
  // memory and the tier's model installed, the tier's model was chosen, cold, and a turn was the request that loaded
  // it, with no deadline (Cloud mode has none).
  it('with no model named, in Cloud mode: the model Ollama has loaded answers, as it always did, and nothing loads the tier\'s', async () => {
    const { inference, lines, s } = await boot({ [TIER.model]: { loaded: false }, 'other-model:7b': { loaded: true, contextLength: 4096 } }, { OLLAMA_MODEL: '', OLLAMA_NUM_CTX: '' });
    expect(inference.mode.current()).toBe('cloud');
    expect(inference.primary).toMatchObject({ model: 'other-model:7b', from: 'loaded', numCtx: 4096 });
    expect(inference.primary.env).toEqual({ OLLAMA_MODEL: 'other-model:7b', OLLAMA_NUM_CTX: '4096' });
    expect(lines.some((l) => l.includes("this machine's hardware tier's model"))).toBe(false);
    await new Promise((r) => setTimeout(r, 30));
    // No warm-up, and no request that names the tier's model as the one to run.
    expect(s.warms()).toEqual([]);
    expect(s.requests.filter((r) => r.path === '/api/generate' || r.path === '/api/chat')).toEqual([]);
    // The tier is still known, and the status still says what it recommends.
    expect(inference.tier.id).toBe('48gb');
    expect((await inference.status()).lines).toContain(`The recommended model for this tier is ${TIER.model} with a ${TIER.contextLength.toLocaleString('en-US')}-token context.`);
  });

  it('in Cloud mode the tier\'s standby is not kept apart either: a loaded model with that name is the one that answers', async () => {
    const { inference } = await boot({ [TIER.fallbackModel!]: { loaded: true, contextLength: 4096 }, 'other-model:7b': {} }, { OLLAMA_MODEL: '', OLLAMA_NUM_CTX: '' });
    expect(inference.primary).toMatchObject({ model: TIER.fallbackModel, from: 'loaded' });
    // In Hybrid the standby is never taken for the main model.
    await server!.close();
    server = undefined;
    const hybrid = await boot({ [TIER.fallbackModel!]: { loaded: true, contextLength: 4096 }, 'other-model:7b': {} }, { OLLAMA_MODEL: '', OLLAMA_NUM_CTX: '', FLINT_INFERENCE_MODE: 'hybrid' });
    expect(hybrid.inference.primary).toMatchObject({ model: 'other-model:7b' });
  });

  it('the rule follows the mode while Flint runs: Local adopts the tier\'s model and the MONITOR loads it; back in Cloud, what is loaded answers', async () => {
    const { inference, lines, s } = await boot({ [TIER.model]: { loaded: false }, 'other-model:7b': { loaded: true, contextLength: 4096 } }, { OLLAMA_MODEL: '', OLLAMA_NUM_CTX: '', FLINT_LOCAL_FALLBACK_MODEL: 'off' });
    expect(inference.primary.model).toBe('other-model:7b');
    let adopted = 0;
    inference.onAdopt(() => (adopted += 1));
    inference.mode.set('local', 'console');
    await inference.local.monitor.check();
    await new Promise((r) => setTimeout(r, 60));
    expect(adopted).toBe(1);
    expect(inference.primary).toMatchObject({ model: TIER.model, from: 'tier', numCtx: TIER.contextLength });
    expect(lines).toContain(`[brain] the mode changed: the local brain is ${TIER.model}, this machine's hardware tier's model (48 GB+); the next turn uses it`);
    // It was cold: the monitor's warm-up loads it, at the tier's context, and no chat request did.
    expect(s.warms()).toEqual([TIER.model]);
    expect(s.chats()).toEqual([]);
    // ...and in this mode every local call has its deadlines.
    expect(inference.mode.current()).toBe('local');
    // Back to Cloud: the tier no longer chooses. The tier's model is the one in memory now, so it stays.
    inference.mode.set('cloud', 'console');
    await new Promise((r) => setTimeout(r, 60));
    expect(inference.primary.model).toBe(TIER.model);
    expect(s.chats()).toEqual([]);
  });

  it('a mode change with a model NAMED chooses nothing again', async () => {
    const { inference, s } = await boot({ [TIER.model]: { loaded: false }, [MAIN]: { loaded: true, contextLength: 16384 } });
    let adopted = 0;
    inference.onAdopt(() => (adopted += 1));
    inference.mode.set('hybrid', 'console');
    await new Promise((r) => setTimeout(r, 40));
    expect(adopted).toBe(0);
    expect(inference.primary).toMatchObject({ model: MAIN, from: 'env' });
    expect(s.warms()).not.toContain(TIER.model);
  });

  it('a named model always wins over the tier', async () => {
    const { inference } = await boot({ [TIER.model]: { loaded: true }, [MAIN]: {} });
    expect(inference.primary).toMatchObject({ model: MAIN, from: 'env' });
  });

  it('the tier model not installed: what Ollama already has is used', async () => {
    const { inference } = await boot({ 'other-model:7b': { loaded: true, contextLength: 4096 } }, { OLLAMA_MODEL: '', OLLAMA_NUM_CTX: '' });
    expect(inference.primary).toMatchObject({ model: 'other-model:7b', from: 'loaded', numCtx: 4096 });
  });

  it('nothing named and nothing installed: the tier\'s model, not downloaded, with the command to get it (never a download)', async () => {
    const { inference, lines, s } = await boot({}, { OLLAMA_MODEL: '', OLLAMA_NUM_CTX: '' });
    expect(inference.primary).toMatchObject({ model: TIER.model, from: 'default' });
    const st = await inference.status();
    expect(st.local.primary).toMatchObject({ name: 'Muse Glimmer 30B', state: 'unavailable', why: 'not_installed', pull: `ollama pull ${TIER.model}`, downloadGb: TIER.downloadGb });
    expect(st.lines).toContain(`To download it (about 18.2 GB), run:  ollama pull ${TIER.model}`);
    expect(lines.some((l) => l.includes(`the local brain is ${TIER.model} until the next restart`))).toBe(true);
    expect(s.requests.some((r) => /pull/.test(r.path))).toBe(false);
  });

  it('FLINT_HARDWARE_TIER overrides detection, and the status says the tier was set by hand', async () => {
    const small = hardwareTier('8gb');
    const { inference } = await boot({ [small.model]: {}, [TIER.model]: {} }, { OLLAMA_MODEL: '', OLLAMA_NUM_CTX: '', FLINT_HARDWARE_TIER: '8gb', FLINT_INFERENCE_MODE: 'hybrid' });
    expect(inference.tier.id).toBe('8gb');
    expect(inference.primary).toMatchObject({ model: small.model, from: 'tier', numCtx: small.contextLength });
    const st = await inference.status();
    expect(st.hardware).toMatchObject({ tier: '8gb', tierLabel: '8 GB', tierSource: 'override' });
    expect(st.lines[1]).toBe("This Mac's chip is Apple M5 Max, with 64 GB of memory, of which a model can use 48 GB. The tier is set to 8 GB by hand.");
    expect(st.hardware?.sentence).toBe('This Mac has 64 GB of memory. The model size was set by hand.');
  });

  it('a machine with an NVIDIA GPU, and one with no GPU', async () => {
    const nvidia = await boot(loaded, {}, { hardware: { platform: 'linux', arch: 'x64', accelerator: 'nvidia', memoryGb: 24, systemMemoryGb: 64, chip: 'NVIDIA GeForce RTX 4090', notes: [] } });
    expect(nvidia.inference.tier.id).toBe('24gb');
    const nv = await nvidia.inference.status();
    expect(nv.lines[1]).toBe("This machine's graphics card is NVIDIA GeForce RTX 4090, with 24 GB of memory. That is the 24 GB tier.");
    expect(nv.hardware).toMatchObject({ name: 'NVIDIA GeForce RTX 4090', usableGb: 24, sentence: 'This machine has 24 GB of graphics memory, enough for Qwen 3 14B.' });
    await server!.close();
    server = undefined;
    const none = await boot(loaded, {}, { hardware: { platform: 'linux', arch: 'x64', accelerator: 'none', memoryGb: 0, systemMemoryGb: 16, notes: ['nvidia-smi is not installed or did not answer'] } });
    expect(none.inference.tier.id).toBe('cpu');
    const cpu = await none.inference.status();
    expect(cpu.lines[1]).toBe('This machine has no graphics card that Flint can use, and 16 GB of memory. That is the CPU Only tier.');
    // What detection could not find out is in the plain output, as a sentence.
    expect(cpu.lines[2]).toBe('A hardware check did not answer: nvidia-smi is not installed or did not answer.');
    expect(cpu.hardware).toMatchObject({ name: 'No Graphics Card', usableGb: 0, sentence: 'This machine has no graphics card Flint can use, so models run on its processor.' });
    expect(none.lines).toContain('[local] hardware: nvidia-smi is not installed or did not answer');
  });

  it('the status read without the server has no cloud line (the server is what knows it)', async () => {
    const { inference } = await boot(loaded);
    const st = await inference.status();
    expect(st.cloud).toBeUndefined();
    expect(st.lines.some((l) => /cloud model/.test(l))).toBe(false);
  });

  it('serving(): the mode and the local model\'s state, for "what are you running on?"', async () => {
    const { inference } = await boot(loaded, { FLINT_INFERENCE_MODE: 'hybrid' });
    expect(inference.serving()).toEqual({ mode: 'hybrid', localState: 'loaded' });
    await server!.close();
    server = undefined;
    const missing = await boot({}, {});
    expect(missing.inference.serving()).toEqual({ mode: 'cloud', localState: 'unavailable (not_installed)' });
  });
});
