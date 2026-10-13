import { describe, it, expect, afterEach } from 'vitest';
import { Flint, FlintError, isFlintError, type StreamEvent, type Tool } from '@flint/core';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FRESH_FOR_MS, FRESH_WAIT_MS, buildInference, type Inference } from '../src/inference';
import { routeLocal, runLocalPlan, type LocalStep } from '../src/local-serve';
import type { Hardware } from '../src/hardware';
import type { ModeRoute } from '../src/mode-route';
import { readInferenceConfig } from '../src/inference-config';
import { buildLocalBrains, type LocalBrains } from '../src/local-brains';
import { startMockLocalServer, type MockLocalServer, type MockModel } from './mock-local-server';

/**
 * Integration: the real pieces against a mocked OpenAI-compatible server (a
 * real HTTP server on 127.0.0.1, ./mock-local-server). Nothing is faked between
 * Flint's client and the socket: config, the guarded fetch with its real TCP
 * connect check, the adapter, the SSE parsing, the tool loop.
 *
 * Part 1: the adapter.
 */

let server: MockLocalServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const MAIN = 'main-model:30b';
const MARKER = 'ZEBRA-PROMPT-MARKER';
const REPLY_MARKER = 'QUOKKA-REPLY-MARKER';

async function boot(models: Record<string, MockModel>, env: Record<string, string> = {}, kind: MockLocalServer['kind'] = 'ollama'): Promise<{ s: MockLocalServer; brains: LocalBrains; lines: string[] }> {
  const s = (server = await startMockLocalServer({ kind, models }));
  const lines: string[] = [];
  const full = { FLINT_LOCAL_PROVIDER: 'openai', FLINT_LOCAL_BASE_URL: s.baseURL, OLLAMA_MODEL: MAIN, FLINT_LOCAL_FIRST_OUTPUT_TIMEOUT_MS: '500', FLINT_LOCAL_CONNECT_TIMEOUT_MS: '500', ...env };
  const brains = await buildLocalBrains({ cfg: readInferenceConfig(full, (m) => lines.push(m)), env: full, deadlinesOn: () => true, log: (m) => lines.push(m) });
  return { s, brains, lines };
}

async function collect(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

const textOf = (events: StreamEvent[]): string =>
  events
    .filter((e): e is Extract<StreamEvent, { type: 'text' }> => e.type === 'text')
    .map((e) => e.delta)
    .join('');

describe('the OpenAI-compatible adapter against a real (mocked) server', () => {
  it('streams text', async () => {
    const { s, brains } = await boot({ [MAIN]: { loaded: true, replies: [{ text: 'Hello from the local model.' }] } });
    const flint = new Flint({ provider: brains.primary.provider, defaultModel: brains.primary.model });
    const events = await collect(flint.stream({ prompt: 'hi' }));
    expect(textOf(events)).toBe('Hello from the local model.');
    // More than one delta: it streamed.
    expect(events.filter((e) => e.type === 'text').length).toBeGreaterThan(1);
    expect(events.at(-1)).toMatchObject({ type: 'done', reason: 'complete', usage: { input: 35, output: 4 } });
    expect(s.chats()[0]).toMatchObject({ path: '/v1/chat/completions', model: MAIN, body: { stream: true } });
  });

  it('a tool call runs the tool once, and the result goes back for the answer', async () => {
    const { s, brains } = await boot({
      [MAIN]: { loaded: true, capabilities: ['completion', 'tools'], replies: [{ tool: { name: 'get_weather', args: { city: 'Paris' } } }, { text: 'It is sunny in Paris.' }] },
    });
    const ran: unknown[] = [];
    const weather: Tool = {
      definition: { name: 'get_weather', description: 'Weather for a city', inputSchema: { type: 'object', properties: { city: { type: 'string' } } }, idempotent: true },
      handler: (call) => {
        ran.push(call.args);
        return 'sunny';
      },
    };
    const flint = new Flint({ provider: brains.primary.provider, defaultModel: brains.primary.model });
    const out = await flint.generate({ prompt: 'weather in Paris?', tools: [weather] });
    expect(out.text).toBe('It is sunny in Paris.');
    expect(ran).toEqual([{ city: 'Paris' }]);
    const [first, second] = s.chats();
    expect((first!.body!.tools as unknown[]).length).toBe(1);
    // The second pass carries the call and its result in the history.
    const roles = (second!.body!.messages as Array<{ role: string }>).map((m) => m.role);
    expect(roles).toEqual(['user', 'assistant', 'tool']);
  });

  it('a model the server says cannot call tools is never sent any', async () => {
    const { s, brains } = await boot({ [MAIN]: { loaded: true, capabilities: ['completion'] } });
    const flint = new Flint({ provider: brains.primary.provider, defaultModel: brains.primary.model });
    const never: Tool = { definition: { name: 'get_weather', description: 'w', inputSchema: { type: 'object' }, idempotent: true }, handler: () => 'x' };
    await flint.generate({ prompt: 'weather?', tools: [never] });
    expect('tools' in s.chats()[0]!.body!).toBe(false);
    expect(flint.getCapabilities().toolCalling).toBe('unsupported');
  });

  it('a model that never sends a first token: first_token_timeout at the deadline, once, with no retry of the stalled model', async () => {
    const { s, brains } = await boot({ [MAIN]: { loaded: true, stall: true } });
    const flint = new Flint({ provider: brains.primary.provider, defaultModel: brains.primary.model });
    const started = Date.now();
    const err = await flint.generate({ prompt: 'hi' }).catch((e: unknown) => e);
    const took = Date.now() - started;
    expect(isFlintError(err)).toBe(true);
    if (!isFlintError(err)) return;
    expect(err.error).toMatchObject({ kind: 'timeout', providerCode: 'first_token_timeout', retryable: false });
    expect(took).toBeGreaterThanOrEqual(450);
    // One deadline, not three: the tool loop does not retry it.
    expect(took).toBeLessThan(1400);
    expect(s.chats()).toHaveLength(1);
  });

  it('a slow first token inside the deadline is simply an answer', async () => {
    const { brains } = await boot({ [MAIN]: { loaded: true, firstTokenMs: 150, replies: [{ text: 'Here.' }] } });
    const flint = new Flint({ provider: brains.primary.provider, defaultModel: brains.primary.model });
    expect((await flint.generate({ prompt: 'hi' })).text).toBe('Here.');
  });

  it('the server stopped: provider_unavailable, quickly', async () => {
    const { s, brains } = await boot({ [MAIN]: { loaded: true } });
    await s.close();
    server = undefined;
    const flint = new Flint({ provider: brains.primary.provider, defaultModel: brains.primary.model, retryPolicy: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 } });
    const started = Date.now();
    const err = await flint.generate({ prompt: 'hi' }).catch((e: unknown) => e);
    expect(isFlintError(err) && err.error.kind).toBe('provider_unavailable');
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('a model the server does not have: validation (404), not retried', async () => {
    const { s, brains } = await boot({ 'other-model:7b': { loaded: true } });
    const flint = new Flint({ provider: brains.primary.provider, defaultModel: brains.primary.model });
    const err = await flint.generate({ prompt: 'hi' }).catch((e: unknown) => e);
    expect(isFlintError(err)).toBe(true);
    if (isFlintError(err)) expect(err.error).toMatchObject({ kind: 'validation', retryable: false, providerCode: 'not_found_error' });
    expect(s.chats()).toHaveLength(1);
    // And the monitor knew before the turn: it is not installed, with the command to get it.
    expect(brains.monitor.snapshot().primary).toMatchObject({ state: 'unavailable', why: 'not_installed' });
  });

  it('a redirect from the server is refused, not followed', async () => {
    const { s, brains } = await boot({ [MAIN]: { loaded: true } });
    s.redirectTo = 'http://127.0.0.1:9/elsewhere';
    const flint = new Flint({ provider: brains.primary.provider, defaultModel: brains.primary.model });
    const err = await flint.generate({ prompt: 'hi' }).catch((e: unknown) => e);
    expect(isFlintError(err)).toBe(true);
    if (isFlintError(err)) expect(err.error).toMatchObject({ kind: 'validation', providerCode: 'redirect', retryable: false });
  });

  it('llama.cpp: the same adapter, another server', async () => {
    const { s, brains } = await boot({ 'model.gguf': { loaded: true, replies: [{ text: 'From llama.cpp.' }] } }, { OLLAMA_MODEL: '' }, 'llamacpp');
    expect(brains.server).toBe('llamacpp');
    const flint = new Flint({ provider: brains.primary.provider, defaultModel: brains.primary.model });
    expect((await flint.generate({ prompt: 'hi' })).text).toBe('From llama.cpp.');
    expect(s.chats()[0]!.path).toBe('/v1/chat/completions');
  });

  it('no log line carries the prompt or the reply', async () => {
    const { brains, lines } = await boot({ [MAIN]: { loaded: true, replies: [{ text: `The answer is ${REPLY_MARKER}.` }] } });
    const flint = new Flint({ provider: brains.primary.provider, defaultModel: brains.primary.model });
    const out = await flint.generate({ prompt: `Remember ${MARKER}` });
    expect(out.text).toContain(REPLY_MARKER);
    await brains.monitor.check();
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).not.toContain(MARKER);
    expect(lines.join('\n')).not.toContain(REPLY_MARKER);
  });
});

/**
 * Part 2: the warm-start fallback. The real config, monitor, guarded fetch,
 * adapter (the native Ollama wire, which is the default), plan and runner,
 * against the mock server. The turn below does what the two handlers in
 * index.ts do with them: plan once, run the plan's steps, never move on after
 * progress. (index.ts itself runs main() on import; its wiring is checked by
 * reading its source, and by running the real server against this same mock.)
 */
const SMALL = 'small-model:3b';
const MAC: Hardware = { platform: 'darwin', arch: 'arm64', accelerator: 'apple-silicon', memoryGb: 64, systemMemoryGb: 64, chip: 'Apple M5 Max', notes: [] };

describe('warm-start fallback, end to end against the mock server', () => {
  const dirs: string[] = [];
  const built: Inference[] = [];
  afterEach(() => {
    for (const i of built.splice(0)) i.stop();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  interface Turn {
    text: string;
    answeredBy: string;
    cloudCalls: number;
    toolRuns: number;
    fields: ReturnType<typeof routeLocal>;
  }

  async function rig(models: Record<string, MockModel>, mode: 'local' | 'hybrid', env: Record<string, string> = {}) {
    const s = (server = await startMockLocalServer({ models }));
    const dir = mkdtempSync(join(tmpdir(), 'flint-warm-'));
    dirs.push(dir);
    const lines: string[] = [];
    const inference = await buildInference({
      // (The standby's context is set by hand to what the mock has it loaded at: nothing is reloaded at boot.)
      env: { OLLAMA_HOST: s.origin, OLLAMA_MODEL: MAIN, OLLAMA_NUM_CTX: '16384', FLINT_LOCAL_FALLBACK_MODEL: SMALL, FLINT_LOCAL_FALLBACK_NUM_CTX: '4096', FLINT_INFERENCE_MODE: mode, FLINT_LOCAL_FIRST_OUTPUT_TIMEOUT_MS: '500', FLINT_LOCAL_REQUEST_TIMEOUT_MS: '1000', FLINT_LOCAL_CONNECT_TIMEOUT_MS: '500', ...env },
      modeFile: join(dir, 'inference.json'),
      log: (m) => lines.push(m),
      detect: async () => MAC,
    });
    built.push(inference);
    await inference.ready;
    const main = new Flint({ provider: inference.primary.provider, defaultModel: inference.primary.model });
    const small = inference.standby && new Flint({ provider: inference.standby.provider, defaultModel: inference.standby.model });
    let cloudCalls = 0;
    let toolRuns = 0;
    const tool: Tool = {
      definition: { name: 'get_weather', description: 'Weather for a city', inputSchema: { type: 'object', properties: { city: { type: 'string' } } }, idempotent: false },
      handler: () => {
        toolRuns += 1;
        return 'sunny';
      },
    };

    /** One turn, as the handlers run it. `withTool` offers the tool; `signal` is the client's connection. */
    async function turn(message: string, route: Pick<ModeRoute, 'private' | 'cloudFallback' | 'reason'>, opts: { withTool?: boolean } = {}): Promise<Turn | { refusal: string } | { error: string; cloudCalls: number; toolRuns: number }> {
      const full: ModeRoute = { brain: 'local', localFallback: true, mode, ...route };
      // As the handlers do: a fresh look at the model server when the last one is more than a moment old.
      await inference.freshen();
      const plan = inference.planLocal(full, { primary: { persona: main, model: MAIN }, standby: small ? { persona: small, model: SMALL } : undefined });
      if (plan.steps.length === 0) return { refusal: plan.refusal ?? '' };
      let text = '';
      let acted = false;
      let answeredBy = '';
      try {
        const run = await runLocalPlan(
          plan,
          async (step: LocalStep<Flint>) => {
            if (step.kind === 'cloud') {
              cloudCalls += 1;
              answeredBy = 'cloud';
              text = 'the cloud stub answered';
              return;
            }
            answeredBy = step.model;
            for await (const ev of step.persona.stream({ prompt: message, ...(opts.withTool ? { tools: [tool] } : {}) })) {
              if (ev.type === 'text') text += ev.delta;
              if (ev.type === 'tool_call') acted = true;
              // An error is thrown to the runner, which moves on only if nothing was shown and no tool was called.
              if (ev.type === 'error') throw new FlintError(ev.error);
            }
          },
          { progressed: () => text.length > 0 || acted },
        );
        return { text, answeredBy, cloudCalls, toolRuns, fields: routeLocal(run, plan, false) };
      } catch (err) {
        return { error: isFlintError(err) ? `${err.error.kind} ${err.error.providerCode ?? ''}`.trim() : 'error', cloudCalls, toolRuns };
      }
    }
    const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));
    return { s, inference, lines, turn, settle };
  }

  const localTurn = { private: false, cloudFallback: false, reason: 'mode_local' as const };
  const hybridTurn = { private: false, cloudFallback: true, reason: 'default' as const };
  const privateTurn = { private: true, cloudFallback: false, reason: 'private' as const };
  const ready: MockModel = { loaded: true, contextLength: 16384, capabilities: ['completion', 'tools'], replies: [{ text: 'the MAIN model answered' }] };
  const standby: MockModel = { loaded: true, contextLength: 4096, capabilities: ['completion', 'tools'], replies: [{ text: 'the STANDBY answered' }] };

  it('1. the main model is loaded: it answers, and the route fields say so', async () => {
    const { turn, s } = await rig({ [MAIN]: ready, [SMALL]: standby }, 'local');
    const t = (await turn('hello', localTurn)) as Turn;
    expect(t.text).toBe('the MAIN model answered');
    expect(t.fields.local).toMatchObject({ which: 'primary', state: 'loaded' });
    expect(t.fields.local!.firstTokenMs).toBeGreaterThanOrEqual(0);
    expect(t.fields.fellTo).toBeUndefined();
    expect(s.chats().map((c) => c.model)).toEqual([MAIN]);
  });

  it('2 and 3. the main model is cold: the standby answers and the monitor loads the main one; the NEXT turn uses the main model', async () => {
    const { turn, s, inference, settle, lines } = await rig({ [MAIN]: { ...ready, loaded: false, loadMs: 150 }, [SMALL]: standby }, 'local');
    // (Boot in Local mode started the main model's load; a turn that arrives meanwhile does not wait for it.)
    const first = (await turn('hello', localTurn)) as Turn;
    expect(first.text).toBe('the STANDBY answered');
    expect(first.fields).toEqual({ local: { which: 'fallback', state: 'loading', firstTokenMs: expect.any(Number) }, fellTo: 'fallback' });
    // The turn's own request never named the main model: only the monitor's detached load did.
    expect(s.chats().map((c) => c.model)).toEqual([SMALL]);
    expect(s.warms()).toEqual([MAIN]);
    // No mid-turn swap: only once the main model is in memory does a turn use it, and that is the next turn.
    await settle(250);
    await inference.local.monitor.check();
    expect(inference.local.monitor.snapshot().primary.state).toBe('loaded');
    const second = (await turn('hello again', localTurn)) as Turn;
    expect(second.text).toBe('the MAIN model answered');
    expect(second.fields.local).toMatchObject({ which: 'primary', state: 'loaded' });
    expect(lines.some((l) => new RegExp(`\\[local\\] primary ${MAIN.replace('.', '\\.')}: loading -> loaded \\(context 16384, \\d+ ms\\)`).test(l))).toBe(true);
  });

  // The routing review's A9 and H3. This used to stall a turn with NO tools, which is the one kind of turn the
  // first-token deadline already covered. Every real chat turn is offered tools, and on Ollama's own API that
  // pass answered whole: the stalled main model held the turn for the whole-reply deadline (1,000 ms here,
  // 120 s by default; twice that when the standby stalled too).
  it('4. the main model looks loaded but never sends a first token, on a turn WITH tools: at the first-token deadline the standby answers, and the main model is marked not ready', async () => {
    const { turn, s, inference } = await rig({ [MAIN]: { ...ready, stall: true }, [SMALL]: standby }, 'local');
    const started = Date.now();
    const t = (await turn('hello', localTurn, { withTool: true })) as Turn;
    const took = Date.now() - started;
    expect(t.text).toBe('the STANDBY answered');
    expect(t.fields).toMatchObject({ local: { which: 'fallback', state: 'loaded' }, fellTo: 'fallback' });
    // The first-token deadline (500 ms), not the whole-reply one (1,000 ms), and one deadline, not three.
    expect(took).toBeGreaterThanOrEqual(450);
    expect(took).toBeLessThan(950);
    expect(s.chats().map((c) => c.model)).toEqual([MAIN, SMALL]);
    // Both were asked with the tool, and read as a stream so that their first line could be timed.
    for (const c of s.chats()) expect(c.body).toMatchObject({ stream: true, tools: [{ function: { name: 'get_weather' } }] });
    // For the cool-down the main model is not ready: the next turn goes straight to the standby, with no wait.
    const p = inference.local.monitor.snapshot().primary;
    expect(p.slowUntil).toBeGreaterThan(Date.now());
    const again = Date.now();
    const next = (await turn('hello again', localTurn, { withTool: true })) as Turn;
    expect(next.text).toBe('the STANDBY answered');
    expect(Date.now() - again).toBeLessThan(300);
  });

  // A9c and A10e: 12 s with the reviewer's 6 s whole-reply deadline. Two first-token deadlines now.
  it('4b. both local models stall on a turn with tools: the turn fails after two first-token deadlines, never two whole-reply ones', async () => {
    const { turn, s } = await rig({ [MAIN]: { ...ready, stall: true }, [SMALL]: { ...standby, stall: true } }, 'local');
    const started = Date.now();
    const t = await turn('hello', localTurn, { withTool: true });
    const took = Date.now() - started;
    expect(t).toMatchObject({ error: 'timeout first_token_timeout' });
    expect(took).toBeGreaterThanOrEqual(900);
    expect(took).toBeLessThan(1700); // 2 x 500 ms, not 2 x 1,000 ms
    expect(s.chats().map((c) => c.model)).toEqual([MAIN, SMALL]);
  });

  it('4c. time to first token is the first line\'s, on a turn with tools too: not the time the whole reply took', async () => {
    const { turn, inference } = await rig({ [MAIN]: { ...ready, firstTokenMs: 60 }, [SMALL]: standby }, 'local');
    const t = (await turn('hello', localTurn, { withTool: true })) as Turn;
    expect(t.text).toBe('the MAIN model answered');
    expect(t.fields.local?.firstTokenMs).toBeGreaterThanOrEqual(50);
    expect(t.fields.local?.firstTokenMs).toBeLessThan(400);
    expect(inference.local.monitor.snapshot().primary.firstTokenMs).toMatchObject({ n: 1 });
  });

  // The routing review's A8: the main model left memory a second ago and the monitor had not looked (its timer
  // is 15 s). The turn was planned as if it were loaded, and was the request that LOADED the cold main model.
  it('4d. the main model left memory since the monitor last looked: the turn looks again first, the standby answers, and the turn never loads the main model', async () => {
    const { turn, s, inference, settle } = await rig({ [MAIN]: { ...ready, loadMs: 400 }, [SMALL]: standby }, 'local');
    expect(inference.local.monitor.snapshot().primary.state).toBe('loaded');
    s.models.get(MAIN)!.loaded = false; // Ollama's keep-alive ran out
    await settle(FRESH_FOR_MS + 60); // "a second ago"
    const t = (await turn('hello', localTurn, { withTool: true })) as Turn;
    expect(t.text).toBe('the STANDBY answered');
    expect(t.fields).toMatchObject({ local: { which: 'fallback', state: 'cold' }, fellTo: 'fallback' });
    // No chat request ever named the cold main model: only the monitor's own, detached load did.
    expect(s.chats().map((c) => c.model)).toEqual([SMALL]);
    expect(s.warms()).toContain(MAIN);
    await settle(600);
    await inference.local.monitor.check();
    expect(((await turn('hello again', localTurn, { withTool: true })) as Turn).text).toBe('the MAIN model answered');
  });

  it('4e. a look that is fresh is not taken again, and the cloud mode takes none', async () => {
    const { s, inference } = await rig({ [MAIN]: ready, [SMALL]: standby }, 'local');
    await inference.local.monitor.check();
    const before = s.requests.length;
    await inference.freshen();
    expect(s.requests.length).toBe(before);
    inference.mode.set('cloud', 'console');
    await new Promise((r) => setTimeout(r, FRESH_FOR_MS + 60));
    const inCloud = s.requests.length;
    await inference.freshen();
    expect(s.requests.length).toBe(inCloud);
  });

  it('4f. a model server that hangs on the look does not hold the turn: it goes on with what was known', async () => {
    const { inference } = await rig({ [MAIN]: ready, [SMALL]: standby }, 'local');
    await new Promise((r) => setTimeout(r, FRESH_FOR_MS + 60));
    const monitor = inference.local.monitor as unknown as { check: () => Promise<unknown> };
    monitor.check = () => new Promise(() => {});
    const started = Date.now();
    await inference.freshen();
    expect(Date.now() - started).toBeLessThan(FRESH_WAIT_MS + 250);
  });

  it('5. hybrid, the main model cold: the standby answers first; the cloud only when no local model can; a private turn never reaches it', async () => {
    const withStandby = await rig({ [MAIN]: { ...ready, loaded: false, loadMs: 300 }, [SMALL]: standby }, 'hybrid');
    const a = (await withStandby.turn('hello', hybridTurn)) as Turn;
    expect(a.text).toBe('the STANDBY answered');
    expect(a.cloudCalls).toBe(0);
    await server!.close();
    // No standby, the main model still loading: an ordinary hybrid turn goes to the cloud...
    const noStandby = await rig({ [MAIN]: { ...ready, loaded: false, loadMs: 300 } }, 'hybrid', { FLINT_LOCAL_FALLBACK_MODEL: 'off' });
    const b = (await noStandby.turn('hello', hybridTurn)) as Turn;
    expect(b.text).toBe('the cloud stub answered');
    expect(b.fields).toEqual({ fellTo: 'cloud' });
    expect(noStandby.s.chats()).toEqual([]);
    // ...and a private one is not answered at all, rather than sent out.
    const c = await noStandby.turn('keep this private', privateTurn);
    expect(c).toEqual({ refusal: "Flint's local model is still loading. Try again in a moment." });
    expect((await noStandby.turn('x', hybridTurn) as Turn).cloudCalls).toBe(2);
    await server!.close();
    // A private turn with a standby: the standby answers, and the cloud stub is never called.
    const priv = await rig({ [MAIN]: { ...ready, loaded: false, loadMs: 300 }, [SMALL]: standby }, 'hybrid');
    const d = (await priv.turn('keep this private', privateTurn)) as Turn;
    expect(d.text).toBe('the STANDBY answered');
    expect(d.cloudCalls).toBe(0);
  });

  it('5b. hybrid, every local model fails before any output: the turn falls through to the cloud', async () => {
    const { turn, s } = await rig({ [MAIN]: { ...ready, stall: true }, [SMALL]: { ...standby, stall: true } }, 'hybrid');
    const t = (await turn('hello', hybridTurn)) as Turn;
    expect(t.text).toBe('the cloud stub answered');
    expect(t.cloudCalls).toBe(1);
    expect(s.chats().map((c) => c.model)).toEqual([MAIN, SMALL]);
  });

  it('6. a tool ran, then the model fails: the turn errors, no second model is asked, and the tool ran once', async () => {
    const { turn, s } = await rig(
      { [MAIN]: { ...ready, replies: [{ tool: { name: 'get_weather', args: { city: 'Paris' } } }, { status: 500, message: 'the model crashed' }] }, [SMALL]: standby },
      'hybrid',
    );
    const t = await turn('weather in Paris?', hybridTurn, { withTool: true });
    expect(t).toMatchObject({ error: expect.stringContaining('provider_unavailable'), cloudCalls: 0, toolRuns: 1 });
    // The standby was never asked, and neither was the cloud: a restart would have run the tool again.
    expect(s.chats().every((c) => c.model === MAIN)).toBe(true);
  });

  it('7. Local mode, the model server stopped: a sentence, and the cloud is never called', async () => {
    const { turn, s, inference } = await rig({ [MAIN]: ready, [SMALL]: standby }, 'local');
    await s.close();
    server = undefined;
    await inference.local.monitor.check();
    const t = await turn('hello', localTurn);
    expect(t).toEqual({ refusal: "The local model isn't available, and Local mode never uses the cloud." });
  });

  it('7b. the server dies between the look and the turn: the turn fails fast, the monitor hears, and the next turn is refused with the sentence', async () => {
    const { turn, s, inference } = await rig({ [MAIN]: ready, [SMALL]: standby }, 'local');
    await s.close();
    server = undefined;
    const started = Date.now();
    const t = await turn('hello', localTurn);
    expect(t).toMatchObject({ error: expect.stringContaining('provider_unavailable') });
    expect(Date.now() - started).toBeLessThan(4000);
    expect(inference.local.monitor.snapshot()).toMatchObject({ primary: { state: 'unavailable', why: 'unreachable' }, fallback: { state: 'unavailable', why: 'unreachable' } });
    expect(await turn('hello again', localTurn)).toEqual({ refusal: "The local model isn't available, and Local mode never uses the cloud." });
  });

  it('8. no log line carries the prompt or what a model said', async () => {
    const { turn, lines, inference } = await rig(
      { [MAIN]: { ...ready, loaded: false, loadMs: 50, replies: [{ text: `main says ${REPLY_MARKER}` }] }, [SMALL]: { ...standby, replies: [{ text: `standby says ${REPLY_MARKER}` }] } },
      'hybrid',
    );
    const t = (await turn(`remember ${MARKER}`, hybridTurn)) as Turn;
    expect(t.text).toContain(REPLY_MARKER);
    await new Promise((r) => setTimeout(r, 120));
    await inference.local.monitor.check();
    await turn(`again ${MARKER}`, hybridTurn);
    expect(lines.length).toBeGreaterThan(4);
    const all = lines.join('\n');
    expect(all).not.toContain(MARKER);
    expect(all).not.toContain(REPLY_MARKER);
    expect(all).not.toMatch(/https?:\/\//);
  });
});
