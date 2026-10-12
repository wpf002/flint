/**
 * The frontier circuit breaker (./frontier-breaker): what opens it (each error
 * class), how long it stays open (the cool-down and its growth), the one cheap
 * check afterwards and what closes it, and what it does to a turn on each
 * route and every tier. The provider is a scripted stand-in named `anthropic`
 * behind real Flint clients, so the breaker is fed the way the server feeds it
 * (the observer); the clock is the test's. No network, nothing paid.
 */
import { describe, it, expect } from 'vitest';
import { Flint, FlintError, InMemoryStore, TIERS, makeAiError, type AiError, type ProviderAdapter, type StreamEvent, type Tier } from '@flint/core';
import { NoFallback, buildTiers, runWithFallback, type BrainSet, type BrainTier } from '../src/brains';
import {
  BREAKER_THRESHOLD,
  FrontierBreaker,
  FrontierPaused,
  HARD_COOLDOWN_MS,
  MAX_COOLDOWN_MS,
  TRANSIENT_COOLDOWN_MS,
  breakerNote,
  breakerReason,
  creditExhausted,
  gateChain,
  gateTurn,
  gated,
  modelScoped,
  pausedCode,
} from '../src/frontier-breaker';
import { frontierOutage } from '../src/memory-brain';
import { answerWithFallback, guardAnswer, type Unanswered } from '../src/unanswered';

const MIN = 60_000;
const usage = { input: 3, output: 2 };

// The errors, as the adapters map them (packages/core: anthropic/errors.ts, openai/errors.ts).
const CREDIT_WORDS = 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.';
const credit = (): AiError => makeAiError('validation', `400 ${CREDIT_WORDS}`, { retryable: false, providerCode: '400' });
const badKey = (status = 401): AiError => makeAiError('validation', `anthropic: ${status} invalid x-api-key (check the API key)`, { retryable: false, providerCode: String(status) });
const overloaded = (status = 529): AiError => makeAiError('provider_unavailable', `${status} Overloaded`, { retryable: true, providerCode: String(status) });
const noConnection = (): AiError => makeAiError('provider_unavailable', 'Connection error.', { retryable: true });
const timedOut = (): AiError => makeAiError('timeout', 'Request timed out.', { retryable: true });
const closedTab = (): AiError => makeAiError('timeout', 'Request aborted', { retryable: false });
const rateLimited = (): AiError => makeAiError('rate_limit', '429 slow down', { retryable: true, providerCode: '429' });
const malformed = (): AiError => makeAiError('validation', '400 messages: at least one message is required', { retryable: false, providerCode: '400' });

/** Let the check's promise chain run. */
const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};

/** A breaker on the test's clock, with a scripted check. */
function make(opts: { probe?: (provider: string, signal: AbortSignal, model?: string) => Promise<void>; probeTimeoutMs?: number } = {}) {
  const clock = { now: 1_000_000 };
  const logs: string[] = [];
  const opened: Array<{ provider: string; model?: string; reason: string; cooldownMs: number }> = [];
  const probes: string[] = [];
  let answer: () => Promise<void> = async () => {};
  const breaker = new FrontierBreaker({
    now: () => clock.now,
    log: (m) => logs.push(m),
    onOpen: (e) => opened.push(e),
    probe:
      opts.probe ??
      (async (p, _signal, model) => {
        probes.push(model === undefined ? p : `${p}:${model}`);
        await answer();
      }),
    ...(opts.probeTimeoutMs !== undefined ? { probeTimeoutMs: opts.probeTimeoutMs } : {}),
  });
  return {
    breaker,
    clock,
    logs,
    opened,
    probes,
    /** What the next checks do: answer, throw this provider error, or throw whatever `err` is. */
    checksFail: (err: AiError | Error | undefined) =>
      (answer = err === undefined ? async () => {} : async () => Promise.reject(err instanceof Error ? err : new FlintError(err))),
    advance: (ms: number) => (clock.now += ms),
  };
}

/** `n` failures, each its own request. */
function fail(t: ReturnType<typeof make>, err: () => AiError, n = BREAKER_THRESHOLD, provider = 'anthropic') {
  for (let i = 0; i < n; i++) t.breaker.failed(provider, err(), { requestId: `req_${Math.random()}` });
}

describe('breakerReason (which failures will keep failing)', () => {
  it('credit: the 400 that says the balance is too low, and OpenAI\'s spent quota', () => {
    expect(breakerReason(credit())).toBe('credit');
    expect(breakerReason(makeAiError('validation', 'openai: You exceeded your current quota', { retryable: false, providerCode: 'insufficient_quota' }))).toBe('credit');
    expect(breakerReason(makeAiError('validation', 'openai: billing hard limit reached', { retryable: false, providerCode: '429' }))).toBe('credit');
    // 402 is Payment Required, whatever the body says and whatever kind the adapter gave it.
    expect(breakerReason(makeAiError('internal', '402 payment required', { retryable: false, providerCode: '402' }))).toBe('credit');
    expect(breakerReason(makeAiError('validation', 'some gateway: 402', { retryable: false, providerCode: '402' }))).toBe('credit');
    // The same status with any other words is a malformed request: that turn's own fault.
    expect(breakerReason(malformed())).toBeUndefined();
    // ...and the words under another status are not Anthropic's credit answer.
    expect(breakerReason(makeAiError('internal', CREDIT_WORDS, { retryable: false, providerCode: '418' }))).toBeUndefined();
  });

  it('auth: 401 and 403, and a rejected key however the vendor codes it', () => {
    expect(breakerReason(badKey(401))).toBe('auth');
    expect(breakerReason(badKey(403))).toBe('auth');
    expect(breakerReason(makeAiError('validation', 'openai: Incorrect API key provided (check the API key)', { retryable: false, providerCode: 'invalid_api_key' }))).toBe('auth');
  });

  it('transient: 529, any other 5xx, a timeout, a connection error', () => {
    for (const status of [500, 502, 503, 504, 529]) expect(breakerReason(overloaded(status)), String(status)).toBe('transient');
    expect(breakerReason(noConnection())).toBe('transient');
    expect(breakerReason(timedOut())).toBe('transient');
  });

  it('nothing else: a closed tab, a rate limit, an unknown model, an over-long prompt, a tool that threw', () => {
    expect(breakerReason(closedTab())).toBeUndefined();
    expect(breakerReason(rateLimited())).toBeUndefined();
    expect(breakerReason(makeAiError('validation', 'anthropic: 404 model not found (unknown model or endpoint)', { retryable: false, providerCode: '404' }))).toBeUndefined();
    expect(breakerReason(makeAiError('context_overflow', '400 prompt is too long', { retryable: false, providerCode: '400' }))).toBeUndefined();
    expect(breakerReason(makeAiError('internal', "Tool 'web.web_search' failed: boom", { retryable: false }))).toBeUndefined();
  });

  it('shares the credit wording with memory extraction\'s frontierOutage', () => {
    expect(creditExhausted(CREDIT_WORDS)).toBe(true);
    expect(creditExhausted('messages: at least one message is required')).toBe(false);
    expect(frontierOutage(400, CREDIT_WORDS)).toBe(true);
    expect(frontierOutage(400, 'prompt is too long')).toBe(false);
  });
});

describe('what opens the breaker', () => {
  it('a spent credit balance opens it at once, for 15 minutes', () => {
    const t = make();
    expect(t.breaker.paused('anthropic')).toBeUndefined();
    t.breaker.failed('anthropic', credit());
    expect(t.breaker.paused('anthropic')).toBe('credit');
    expect(t.breaker.paused('anthropic', 'claude-sonnet-5')).toBe('credit'); // every model on the account
    expect(t.breaker.state('anthropic').open).toMatchObject({ reason: 'credit', cooldownMs: HARD_COOLDOWN_MS, until: t.clock.now + 15 * MIN });
    expect(t.opened).toEqual([{ provider: 'anthropic', reason: 'credit', cooldownMs: 15 * MIN }]);
    expect(HARD_COOLDOWN_MS).toBe(15 * MIN);
  });

  it('a rejected key (401, or a 403 about the key) opens it at once, for the whole provider', () => {
    for (const status of [401, 403]) {
      const t = make();
      t.breaker.failed('anthropic', badKey(status), { model: 'claude-opus-5-5' });
      expect(t.breaker.paused('anthropic')).toBe('auth');
      expect(t.breaker.paused('anthropic', 'claude-sonnet-5')).toBe('auth');
      expect(t.breaker.state('anthropic').open?.cooldownMs).toBe(HARD_COOLDOWN_MS);
    }
  });

  it.each([
    ['529', overloaded],
    ['500', () => overloaded(500)],
    ['a timeout', timedOut],
    ['a connection error', noConnection],
  ])('%s opens it only after two requests in a row fail, for 5 minutes', (_name, err) => {
    const t = make();
    fail(t, err, BREAKER_THRESHOLD - 1);
    expect(t.breaker.paused('anthropic')).toBeUndefined();
    fail(t, err, 1);
    expect(t.breaker.paused('anthropic')).toBe('transient');
    expect(t.breaker.state('anthropic').open?.cooldownMs).toBe(TRANSIENT_COOLDOWN_MS);
    expect(TRANSIENT_COOLDOWN_MS).toBe(5 * MIN);
    expect(BREAKER_THRESHOLD).toBe(2);
  });

  // The review's case: default retries are 3, so "three in a row" was ONE call to ONE model.
  it('one request\'s own retries are one failure, however many there are', () => {
    const t = make();
    for (let attempt = 0; attempt < 10; attempt++) t.breaker.failed('anthropic', overloaded(), { requestId: 'req_opus_1', model: 'claude-opus-5-5' });
    expect(t.breaker.paused('anthropic')).toBeUndefined();
    expect(t.breaker.state('anthropic').failures).toBe(1);
    // A second, different request failing too is what opens it.
    t.breaker.failed('anthropic', overloaded(), { requestId: 'req_sonnet_1', model: 'claude-sonnet-5' });
    expect(t.breaker.paused('anthropic')).toBe('transient');
  });

  it('interleaved retries of two requests are still two failures, not more', () => {
    const t = make({});
    const b = new FrontierBreaker({ probe: async () => {}, threshold: 3, now: () => t.clock.now });
    for (const id of ['a', 'b', 'a', 'b', 'a', 'b']) b.failed('anthropic', overloaded(), { requestId: id });
    expect(b.paused('anthropic')).toBeUndefined();
    expect(b.state('anthropic').failures).toBe(2);
  });

  it('"in a row" means no success between: one answer, from any model on the provider, starts the count over', () => {
    const t = make();
    fail(t, overloaded, 1);
    t.breaker.succeeded('anthropic', 'claude-sonnet-5');
    fail(t, timedOut, 1);
    expect(t.breaker.paused('anthropic')).toBeUndefined();
    t.breaker.succeeded('anthropic');
    fail(t, noConnection, 1);
    expect(t.breaker.paused('anthropic')).toBeUndefined();
    fail(t, () => overloaded(503), 1); // mixed kinds count together
    expect(t.breaker.paused('anthropic')).toBe('transient');
  });

  it('failures that say nothing about the next call are not counted', () => {
    const t = make();
    for (const err of [closedTab(), rateLimited(), malformed(), closedTab(), rateLimited(), malformed()]) t.breaker.failed('anthropic', err, { requestId: `r${Math.random()}` });
    expect(t.breaker.paused('anthropic')).toBeUndefined();
    expect(t.breaker.state('anthropic')).toEqual({ failures: 0 });
  });

  it('each provider has its own breaker', () => {
    const t = make();
    t.breaker.failed('anthropic', credit());
    expect(t.breaker.paused('anthropic')).toBe('credit');
    expect(t.breaker.paused('openai')).toBeUndefined();
    t.breaker.failed('openai', badKey());
    expect(t.breaker.paused('openai')).toBe('auth');
  });

  it('the local model is never paused, however it fails', () => {
    const t = make();
    fail(t, noConnection, 10, 'ollama');
    t.breaker.failed('ollama', badKey());
    expect(t.breaker.paused('ollama')).toBeUndefined();
    expect(t.logs).toEqual([]);
  });

  it('a new breaker starts closed: the state is in memory only', () => {
    const t = make();
    t.breaker.failed('anthropic', credit());
    expect(make().breaker.paused('anthropic')).toBeUndefined();
  });

  it('logs the provider and a reason code, never the provider\'s words', () => {
    const t = make();
    t.breaker.failed('anthropic', credit());
    t.breaker.failed('openai', badKey());
    expect(t.logs).toEqual([
      '[breaker] anthropic paused (credit): the local model answers; next check in 15 min',
      '[breaker] openai paused (auth): the local model answers; next check in 15 min',
    ]);
    expect(t.logs.join('\n')).not.toMatch(/balance|Billing|x-api-key/i);
  });

  it('by default it keeps time on the monotonic clock, so a wall-clock change cannot end or stretch a cool-down', () => {
    const wall = Date.now;
    const b = new FrontierBreaker({ probe: async () => {} });
    b.failed('anthropic', credit());
    const until = b.state('anthropic').open!.until;
    expect(Math.abs(until - (performance.now() + HARD_COOLDOWN_MS))).toBeLessThan(1_000);
    try {
      Date.now = () => wall() + 24 * 60 * MIN; // the wall clock jumps a day ahead
      expect(b.snapshot()).toMatchObject([{ scope: 'anthropic', reason: 'credit', checking: false }]);
      expect(b.snapshot()[0]!.nextCheckInSec).toBeGreaterThan(14 * 60);
    } finally {
      Date.now = wall;
    }
  });
});

// A 403 can be about the key, or about one model the key may not use.
describe('a 403 that names a model pauses that model alone', () => {
  const noAccess = (model: string): AiError =>
    makeAiError('validation', `openai: Project proj_1 does not have access to model ${model} (check the API key)`, { retryable: false, providerCode: 'model_not_found' });

  it('modelScoped: a permission error that names the model, or speaks of a model; never a 401', () => {
    expect(modelScoped(noAccess('gpt-5'), 'gpt-5')).toBe(true);
    expect(modelScoped(makeAiError('validation', 'anthropic: 403 claude-opus-5-5 is not available on this key (check the API key)', { providerCode: '403' }), 'claude-opus-5-5')).toBe(true);
    expect(modelScoped(badKey(403), 'claude-opus-5-5')).toBe(false); // about the key: no model in it
    expect(modelScoped(makeAiError('validation', 'anthropic: 401 no key for model x (check the API key)', { providerCode: '401' }), 'x')).toBe(false);
    expect(modelScoped(noAccess('gpt-5'), undefined)).toBe(false);
  });

  it('its siblings on the same key stay in use', () => {
    const t = make();
    t.breaker.failed('openai', noAccess('gpt-5'), { model: 'gpt-5', requestId: 'r1' });
    expect(t.breaker.paused('openai', 'gpt-5')).toBe('auth');
    expect(t.breaker.paused('openai', 'gpt-5-mini')).toBeUndefined();
    expect(t.breaker.paused('openai')).toBeUndefined();
    expect(t.opened).toEqual([{ provider: 'openai', model: 'gpt-5', reason: 'auth', cooldownMs: 15 * MIN }]);
    expect(t.logs).toEqual(['[breaker] openai:gpt-5 paused (auth): its other models still answer; next check in 15 min']);
  });

  it('its check asks that model, and only that model\'s answer closes it', async () => {
    const t = make();
    t.breaker.failed('openai', noAccess('gpt-5'), { model: 'gpt-5' });
    t.breaker.succeeded('openai', 'gpt-5-mini'); // a sibling answering proves nothing about gpt-5
    expect(t.breaker.paused('openai', 'gpt-5')).toBe('auth');
    t.advance(15 * MIN);
    t.breaker.paused('openai', 'gpt-5');
    await settle();
    expect(t.probes).toEqual(['openai:gpt-5']);
    expect(t.breaker.paused('openai', 'gpt-5')).toBeUndefined();
  });

  it('the chain loses that one brain', () => {
    const t = make();
    t.breaker.failed('openai', noAccess('gpt-5'), { model: 'gpt-5' });
    const brain = (model: string): BrainTier<string> => ({ tier: 'standard', provider: { name: 'openai' } as ProviderAdapter, model, label: `openai:${model}`, persona: model });
    const g = gateTurn({ brain: 'frontier', chain: [brain('gpt-5'), brain('gpt-5-mini')], canLocal: true, breaker: t.breaker });
    expect(g.brain).toBe('frontier');
    expect(g.chain.map((b) => b.label)).toEqual(['openai:gpt-5-mini']);
    expect(g.paused).toBe('openai:auth');
  });
});

describe('the cool-down and the one check after it', () => {
  it('asks nothing during the cool-down, then makes one check however many turns ask', async () => {
    const t = make();
    t.checksFail(credit());
    t.breaker.failed('anthropic', credit());
    t.advance(14 * MIN);
    for (let i = 0; i < 5; i++) expect(t.breaker.paused('anthropic')).toBe('credit');
    expect(t.probes).toEqual([]);
    t.advance(MIN);
    // The turns that arrive now are still answered locally: nobody waits on the check.
    for (let i = 0; i < 5; i++) expect(t.breaker.paused('anthropic', 'claude-opus-5-5')).toBe('credit');
    await settle();
    expect(t.probes).toEqual(['anthropic']);
  });

  it('a check that is answered closes the breaker', async () => {
    const t = make();
    t.breaker.failed('anthropic', credit());
    t.advance(15 * MIN);
    expect(t.breaker.paused('anthropic')).toBe('credit');
    await settle();
    expect(t.breaker.paused('anthropic')).toBeUndefined();
    expect(t.logs.at(-1)).toBe('[breaker] anthropic answered: back in use');
  });

  // A failed check costs nothing, so there is no reason to make Will wait an hour after topping up.
  it('credit and auth are checked again every 15 minutes, for as long as they fail', async () => {
    for (const err of [credit, badKey]) {
      const t = make();
      t.checksFail(err());
      t.breaker.failed('anthropic', err());
      for (let n = 1; n <= 4; n++) {
        t.advance(15 * MIN);
        t.breaker.paused('anthropic');
        await settle();
        expect(t.probes).toHaveLength(n);
        expect(t.breaker.state('anthropic').open).toMatchObject({ cooldownMs: HARD_COOLDOWN_MS, until: t.clock.now + 15 * MIN, probing: false });
      }
      expect(t.opened).toHaveLength(1); // a failed check for the same reason is not news: one note for Will
    }
  });

  it('a transient cool-down doubles with each failed check, up to an hour', async () => {
    const t = make();
    t.checksFail(overloaded());
    fail(t, overloaded);
    const seen = [t.breaker.state('anthropic').open!.cooldownMs / MIN];
    for (let i = 0; i < 6; i++) {
      t.advance(t.breaker.state('anthropic').open!.cooldownMs);
      t.breaker.paused('anthropic');
      await settle();
      seen.push(t.breaker.state('anthropic').open!.cooldownMs / MIN);
    }
    expect(seen).toEqual([5, 10, 20, 40, 60, 60, 60]);
    expect(MAX_COOLDOWN_MS).toBe(60 * MIN);
    expect(t.logs.at(-1)).toBe('[breaker] anthropic still failing (transient): next check in 60 min');
  });

  it('once closed, the next outage starts again at 5 minutes', async () => {
    const t = make();
    t.checksFail(overloaded());
    fail(t, overloaded);
    t.advance(5 * MIN);
    t.breaker.paused('anthropic');
    await settle();
    expect(t.breaker.state('anthropic').open?.cooldownMs).toBe(10 * MIN);
    t.checksFail(undefined);
    t.advance(10 * MIN);
    t.breaker.paused('anthropic');
    await settle();
    expect(t.breaker.paused('anthropic')).toBeUndefined();
    fail(t, overloaded);
    expect(t.breaker.state('anthropic').open?.cooldownMs).toBe(5 * MIN);
  });

  // An outage gets no note (it clears itself). If the check finds it was no credit all along, that is news.
  it('a check that finds another reason changes the pause, and tells Will', async () => {
    const t = make();
    fail(t, overloaded);
    expect(t.opened.map((e) => e.reason)).toEqual(['transient']);
    t.checksFail(credit());
    t.advance(5 * MIN);
    t.breaker.paused('anthropic');
    await settle();
    expect(t.breaker.state('anthropic').open).toMatchObject({ reason: 'credit', cooldownMs: HARD_COOLDOWN_MS });
    expect(t.opened.map((e) => e.reason)).toEqual(['transient', 'credit']);
    expect(breakerNote(t.opened[1]! as Parameters<typeof breakerNote>[0])?.title).toBe('Claude Has No Credit Left');
    expect(t.logs.at(-1)).toBe('[breaker] anthropic paused (credit): the local model answers; next check in 15 min');
    // ...and the other way round: no credit, then the network goes. 5 minutes, and no note for an outage.
    t.checksFail(noConnection());
    t.advance(15 * MIN);
    t.breaker.paused('anthropic');
    await settle();
    expect(t.breaker.state('anthropic').open).toMatchObject({ reason: 'transient', cooldownMs: TRANSIENT_COOLDOWN_MS });
    expect(breakerNote(t.opened[2]! as Parameters<typeof breakerNote>[0])).toBeUndefined();
  });

  it('a check that gets no answer in time is a transient failure, and its call is cut off', async () => {
    let cut = false;
    const t = make({
      probeTimeoutMs: 10,
      probe: (_p, signal) =>
        new Promise((_, reject) =>
          signal.addEventListener('abort', () => {
            cut = true;
            // As the Anthropic adapter words an aborted request: not retryable, so not transient by itself.
            reject(new FlintError(closedTab()));
          }),
        ),
    });
    t.breaker.failed('anthropic', credit());
    t.advance(15 * MIN);
    t.breaker.paused('anthropic');
    await new Promise((r) => setTimeout(r, 40));
    expect(cut).toBe(true);
    expect(t.breaker.state('anthropic').open).toMatchObject({ reason: 'transient', cooldownMs: TRANSIENT_COOLDOWN_MS, probing: false });
  });

  // The review's case: a check that never settles and ignores its signal left `probing` true for good.
  it('a check that hangs, ignoring its signal, cannot leave the breaker checking forever', async () => {
    let started = 0;
    const t = make({
      probeTimeoutMs: 10,
      probe: () => {
        started++;
        return new Promise(() => {}); // never settles
      },
    });
    t.breaker.failed('anthropic', credit());
    t.advance(15 * MIN);
    t.breaker.paused('anthropic');
    expect(t.breaker.state('anthropic').open?.probing).toBe(true);
    await new Promise((r) => setTimeout(r, 40));
    expect(t.breaker.state('anthropic').open).toMatchObject({ reason: 'transient', probing: false, until: t.clock.now + 5 * MIN });
    // So the next cool-down ends in a check again.
    t.advance(5 * MIN);
    t.breaker.paused('anthropic');
    await settle();
    expect(started).toBe(2);
  });

  it('a check that is answered with something that is no outage (a 429) closes it: real calls decide', async () => {
    const t = make();
    t.checksFail(rateLimited());
    t.breaker.failed('anthropic', credit());
    t.advance(15 * MIN);
    t.breaker.paused('anthropic');
    await settle();
    expect(t.breaker.paused('anthropic')).toBeUndefined();
  });

  // The review's case: "no brain on that provider", or a bug in the check, used to close the breaker.
  it('a check that throws a plain Error proves nothing: the breaker stays open, for the same reason', async () => {
    for (const [open, cooldown] of [[credit, 15], [badKey, 15]] as const) {
      const t = make();
      t.checksFail(new Error('no brain on that provider'));
      t.breaker.failed('anthropic', open());
      const reason = t.breaker.paused('anthropic');
      t.advance(15 * MIN);
      t.breaker.paused('anthropic');
      await settle();
      expect(t.probes).toHaveLength(1);
      expect(t.breaker.paused('anthropic')).toBe(reason);
      expect(t.breaker.state('anthropic').open).toMatchObject({ cooldownMs: cooldown * MIN, until: t.clock.now + cooldown * MIN, probing: false });
      expect(t.opened).toHaveLength(1);
      expect(t.logs.at(-1)).toBe(`[breaker] anthropic still failing (${reason}): next check in 15 min`);
    }
    const t = make();
    t.checksFail(new TypeError('x is not a function'));
    fail(t, overloaded);
    t.advance(5 * MIN);
    t.breaker.paused('anthropic');
    await settle();
    expect(t.breaker.state('anthropic').open).toMatchObject({ reason: 'transient', cooldownMs: 10 * MIN });
  });

  it('a real call that succeeds while it is open closes it too (a turn only the frontier could answer)', () => {
    const t = make();
    t.breaker.failed('anthropic', credit());
    const o = t.breaker.observer();
    const base = { requestId: 'r', provider: 'anthropic', model: 'm', timestamp: 0, usage, durationMs: 1 };
    // A pass that ended in an error or a hang-up reports what it was billed, not an answer.
    o.onResponse!({ ...base, reason: 'error' });
    o.onResponse!({ ...base, reason: 'aborted' });
    expect(t.breaker.paused('anthropic')).toBe('credit');
    o.onResponse!({ ...base, reason: 'complete' });
    expect(t.breaker.paused('anthropic')).toBeUndefined();
  });

  it('failures that arrive while it is open change nothing (a call that was in flight)', () => {
    const t = make();
    t.breaker.failed('anthropic', credit());
    const before = t.breaker.state('anthropic');
    t.advance(MIN);
    t.breaker.failed('anthropic', badKey());
    fail(t, overloaded);
    expect(t.breaker.state('anthropic')).toEqual(before);
    expect(t.opened).toHaveLength(1);
  });

  it('snapshot (what /health shows): each pause, its reason code and the time to its next check; it starts no check', async () => {
    const t = make();
    expect(t.breaker.snapshot()).toEqual([]);
    t.breaker.failed('anthropic', credit());
    fail(t, overloaded, BREAKER_THRESHOLD, 'openai');
    t.advance(2 * MIN);
    expect(t.breaker.snapshot()).toEqual([
      { scope: 'anthropic', reason: 'credit', nextCheckInSec: 13 * 60, checking: false },
      { scope: 'openai', reason: 'transient', nextCheckInSec: 3 * 60, checking: false },
    ]);
    t.advance(60 * MIN);
    expect(t.breaker.snapshot().map((p) => p.nextCheckInSec)).toEqual([0, 0]);
    await settle();
    expect(t.probes).toEqual([]);
    expect(JSON.stringify(t.breaker.snapshot())).not.toMatch(/balance|Overloaded/);
  });
});

// ---------------------------------------------------------------------------
// through real Flint clients: the observer, the chain, both routes

/** A stand-in vendor: every model on it answers, or fails as `fail` says (only the model `failOnly` names, when set). Counts requests per model. */
function vendor(name = 'anthropic') {
  const state: { fail: (() => AiError) | undefined; failOnly: string | undefined; failBy: Record<string, () => AiError>; requests: string[] } = { fail: undefined, failOnly: undefined, failBy: {}, requests: [] };
  const provider: ProviderAdapter = {
    name,
    getCapabilities: () => ({ toolCalling: 'native', structuredOutput: 'native', streaming: 'full', maxContextTokens: 100_000, maxOutputTokens: 1_000 }),
    estimateTokens: () => 1,
    generate: () => Promise.reject(new Error('stream only')),
    async *stream(args): AsyncIterable<StreamEvent> {
      state.requests.push(args.model);
      // `failBy` is one model's own, lasting failure (a key that may not use it), whatever the rest do.
      const fail = state.failBy[args.model] ?? (state.fail && (state.failOnly === undefined || state.failOnly === args.model) ? state.fail : undefined);
      if (fail) {
        yield { type: 'error', error: fail() };
        return;
      }
      yield { type: 'text', delta: `answer from ${args.model}` };
      yield { type: 'done', reason: 'complete', usage };
    },
  };
  return { provider, state };
}

/** The server in miniature: a tier set on one vendor, a local brain, one breaker fed by every client's observer. */
function server(env: Record<string, string> = { FLINT_TIER_HARD: 'anthropic:opus', FLINT_TIER_CODE: 'anthropic:opus', FLINT_TIER_ROUTINE: 'anthropic:haiku' }) {
  const t = make({
    probe: async (p, signal, model) => {
      // As index.ts: a provider-wide check asks a brain with no pause of its own.
      const b = brains.cheapestOn(p, model, (brain) => !t.breaker.state(p, brain.model).open)!;
      await b.persona.generate({ prompt: 'ping' }, { maxTokens: 1, signal, retryPolicy: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 } });
    },
  });
  const memory = new InMemoryStore();
  const observer = t.breaker.observer();
  const retryPolicy = { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 };
  const claude = vendor('anthropic');
  const ollama = vendor('ollama');
  const flintOn = (provider: ProviderAdapter, model: string) => new Flint({ provider, defaultModel: model, memory, observer, retryPolicy });
  const brains: BrainSet<Flint> = buildTiers<Flint>({
    env,
    factory: (name) => (name === 'anthropic' ? claude.provider : undefined),
    legacy: { provider: claude.provider, model: 'sonnet' },
    makePersona: flintOn,
  })!;
  const local = flintOn(ollama.provider, 'muse-glimmer:30b');

  /** /generate, as index.ts wires it: gateTurn, answerWithFallback over the gated chain, then the local brain. */
  async function generate(tier: Tier, canLocal = true) {
    const gate = gateTurn({ brain: 'frontier', chain: brains.chain(tier), canLocal, breaker: t.breaker });
    let brain = gate.brain;
    let paused = gate.paused;
    const reply = (text: string, model: string) => ({ text, model, brain, paused });
    if (brain === 'frontier') {
      try {
        const won = await answerWithFallback(gate.chain, gate.attempt((b) => b.persona.generate({ prompt: 'q' })));
        return reply(won.result.text, won.brain.label);
      } catch (err) {
        if (!canLocal) throw err;
        if (err instanceof FrontierPaused) paused ??= pausedCode([err.brain]);
        brain = 'local';
      }
    }
    return reply((await local.generate({ prompt: 'q' })).text, 'muse-glimmer:30b');
  }

  /** /chat, as index.ts wires it: gateTurn, runWithFallback + guardAnswer per tier, a last-tier error to the local brain. */
  async function chat(tier: Tier, conversationId = 'c') {
    const gate = gateTurn({ brain: 'frontier', chain: brains.chain(tier), canLocal: true, breaker: t.breaker });
    let brain = gate.brain;
    let paused = gate.paused;
    let answer = '';
    const metas: string[] = [];
    const errors: StreamEvent[] = [];
    const noAnswers: Unanswered[] = [];
    const pump = async (f: Flint, recoverable = false, tried?: number) => {
      const events = f.chat({ conversationId, message: 'q' });
      for await (const ev of tried === undefined ? events : guardAnswer(events, { recoverable, tried, noAnswers })) {
        if (ev.type === 'text') answer += ev.delta;
        if ((recoverable || tried !== undefined) && ev.type === 'error' && answer.length === 0) throw new FlintError(ev.error);
        if (ev.type === 'error') errors.push(ev);
      }
    };
    let model = 'muse-glimmer:30b';
    if (brain === 'frontier') {
      try {
        const chain = gate.chain;
        const won = await runWithFallback(
          chain,
          gate.attempt(async (b) => {
            metas.push(`frontier:${b.label}`);
            try {
              await pump(b.persona, b !== chain[chain.length - 1], chain.indexOf(b) + 1);
            } catch (err) {
              if (answer.length > 0) throw new NoFallback(err);
              throw err;
            }
          }),
        );
        model = won.brain.label;
      } catch (err) {
        if (err instanceof FrontierPaused) paused ??= pausedCode([err.brain]);
        brain = 'local';
        metas.push('local');
        await pump(local);
      }
    } else {
      metas.push('local');
      await pump(local);
    }
    return { text: answer, model, brain, paused, metas, errors };
  }

  return { ...t, brains, claude, ollama, memory, generate, chat };
}

describe('fed by the observer, from real Flint clients', () => {
  it('a spent credit balance: the first brain\'s one request opens it, and the rest of the chain is not asked', async () => {
    const s = server();
    s.claude.state.fail = credit;
    const r = await s.generate('hard');
    expect(s.claude.state.requests).toEqual(['opus']); // one request: not retried, and Sonnet and Haiku skipped
    expect(r).toMatchObject({ brain: 'local', model: 'muse-glimmer:30b', text: 'answer from muse-glimmer:30b', paused: 'anthropic:credit' });
  });

  // The review's case. Flint retries a 529 three times by itself, so "three failures in a row" used to be
  // one call to one model: Opus having a bad minute skipped a healthy Sonnet and paused Claude for 5 minutes.
  it('one model\'s outage does not pause the provider: its sibling answers, turn after turn', async () => {
    const s = server();
    s.claude.state.fail = overloaded;
    s.claude.state.failOnly = 'opus';
    for (let i = 0; i < 5; i++) {
      const r = await s.generate('hard');
      expect(r).toMatchObject({ brain: 'frontier', model: 'anthropic:sonnet', text: 'answer from sonnet', paused: undefined });
      expect(s.breaker.paused('anthropic')).toBeUndefined();
      expect(s.breaker.state('anthropic')).toEqual({ failures: 0 }); // Sonnet's answer started the count over
    }
    expect(s.claude.state.requests.filter((m) => m === 'opus')).toHaveLength(15); // each turn still tries Opus, three times
    expect(s.ollama.state.requests).toEqual([]);
    expect(s.logs).toEqual([]);
  });

  it('a provider-wide outage: no sibling is skipped mid-turn, the second failed request opens it, and the next turn is local at once', async () => {
    const s = server();
    s.claude.state.fail = overloaded;
    const first = await s.generate('hard');
    // Every brain in the chain was asked (each retried by Flint): an outage skips nobody mid-turn.
    expect(s.claude.state.requests).toEqual(['opus', 'opus', 'opus', 'sonnet', 'sonnet', 'sonnet', 'haiku', 'haiku', 'haiku']);
    expect(first).toMatchObject({ brain: 'local', text: 'answer from muse-glimmer:30b' });
    expect(s.breaker.paused('anthropic')).toBe('transient');
    s.claude.state.requests.length = 0;
    expect(await s.generate('hard')).toMatchObject({ brain: 'local', paused: 'anthropic:transient' });
    expect(s.claude.state.requests).toEqual([]);
  });

  it('with one brain in the chain, one failed call does not open it; the next turn\'s does', async () => {
    const s = server({}); // no tiers: every chain is the one legacy brain
    s.claude.state.fail = overloaded;
    expect(await s.generate('standard')).toMatchObject({ brain: 'local' });
    expect(s.claude.state.requests).toHaveLength(3); // one request, retried
    expect(s.breaker.paused('anthropic')).toBeUndefined();
    expect(await s.generate('standard')).toMatchObject({ brain: 'local' });
    expect(s.breaker.paused('anthropic')).toBe('transient');
    expect(await s.generate('standard')).toMatchObject({ brain: 'local', paused: 'anthropic:transient' });
    expect(s.claude.state.requests).toHaveLength(6);
  });

  it('a 529 that clears on a retry does not open it', async () => {
    const s = server();
    let n = 0;
    s.claude.state.fail = overloaded;
    const stream = s.claude.provider.stream.bind(s.claude.provider);
    s.claude.provider.stream = (args) => {
      if (++n === 3) s.claude.state.fail = undefined; // the third request is answered
      return stream(args);
    };
    const r = await s.generate('hard');
    expect(r).toMatchObject({ brain: 'frontier', model: 'anthropic:opus' });
    expect(s.breaker.state('anthropic')).toEqual({ failures: 0 });
  });

  it('the local brain\'s own failures never pause anything', async () => {
    const s = server();
    s.ollama.state.fail = noConnection;
    s.claude.state.fail = credit;
    await expect(s.generate('standard')).rejects.toBeInstanceOf(FlintError);
    expect(s.breaker.paused('ollama')).toBeUndefined();
    expect(s.breaker.paused('anthropic')).toBe('credit');
  });
});

describe.each(['generate', 'chat'] as const)('a /%s turn while the frontier keeps failing', (route) => {
  /** One turn on this route; /chat turns each get their own conversation. */
  const turn = (s: ReturnType<typeof server>, tier: Tier, id = 'c') => (route === 'chat' ? s.chat(tier, id) : s.generate(tier));

  it.each(TIERS)('%s tier: once open, the local model answers at once and the vendor is not asked at all', async (tier) => {
    const s = server();
    s.claude.state.fail = credit;
    await turn(s, tier); // the turn that finds out
    const asked = s.claude.state.requests.length;
    expect(asked).toBe(1);
    for (let i = 0; i < 3; i++) {
      const r = await turn(s, tier, `c${i}`);
      expect(r).toMatchObject({ brain: 'local', model: 'muse-glimmer:30b', text: 'answer from muse-glimmer:30b', paused: 'anthropic:credit' });
    }
    expect(s.claude.state.requests).toHaveLength(asked);
    expect(s.ollama.state.requests).toHaveLength(4);
  });

  it('after the cool-down: that turn is still local, the check goes out once, and the turn after it is the frontier\'s again', async () => {
    const s = server();
    s.claude.state.fail = credit;
    await turn(s, 'standard');
    s.claude.state.requests.length = 0;
    s.claude.state.fail = undefined; // Will topped up
    s.advance(14 * MIN);
    expect(await turn(s, 'standard', 'c1')).toMatchObject({ brain: 'local' });
    expect(s.claude.state.requests).toEqual([]); // still cooling down: not even a check
    s.advance(MIN);
    expect(await turn(s, 'standard', 'c2')).toMatchObject({ brain: 'local', paused: 'anthropic:credit' });
    await settle();
    expect(s.claude.state.requests).toEqual(['haiku']); // the check: one request, to the cheapest brain
    expect(await turn(s, 'standard', 'c3')).toMatchObject({ brain: 'frontier', model: 'anthropic:sonnet', text: 'answer from sonnet' });
  });

  it('a check that fails keeps the turns local, with one request every 15 minutes and no more', async () => {
    const s = server();
    s.claude.state.fail = credit;
    await turn(s, 'hard');
    s.claude.state.requests.length = 0;
    for (let n = 1; n <= 3; n++) {
      s.advance(15 * MIN);
      for (let i = 0; i < 4; i++) expect(await turn(s, 'hard', `c${n}-${i}`)).toMatchObject({ brain: 'local' });
      await settle();
      expect(s.claude.state.requests).toHaveLength(n);
    }
  });
});

// The review's case: the cheapest model is one the key may not use. Every provider-wide check asked it,
// got its 403, and paused the whole provider again as a rejected key: it could never be seen to be back.
describe('a provider-wide check and a model with a pause of its own', () => {
  const noAccess = (): AiError => makeAiError('validation', 'anthropic: 403 this key does not have access to model haiku (check the API key)', { retryable: false, providerCode: '403' });

  it('the check asks the cheapest brain that has no pause of its own, so the provider comes back', async () => {
    const s = server();
    s.claude.state.failBy.haiku = noAccess;
    // A routine turn finds out: haiku is paused alone, Sonnet answers.
    expect(await s.generate('routine')).toMatchObject({ brain: 'frontier', model: 'anthropic:sonnet' });
    expect(s.breaker.paused('anthropic', 'haiku')).toBe('auth');
    expect(s.breaker.paused('anthropic')).toBeUndefined();
    // Then an outage pauses the whole provider.
    s.claude.state.fail = overloaded;
    expect(await s.generate('hard')).toMatchObject({ brain: 'local' });
    expect(s.breaker.paused('anthropic')).toBe('transient');
    // The outage ends. Haiku is still not this key's to use.
    s.claude.state.fail = undefined;
    s.claude.state.requests.length = 0;
    s.advance(5 * MIN);
    expect(await s.generate('hard')).toMatchObject({ brain: 'local' });
    await settle();
    expect(s.claude.state.requests).toEqual(['sonnet']); // the check: not haiku
    expect(s.breaker.paused('anthropic')).toBeUndefined();
    expect(s.breaker.paused('anthropic', 'haiku')).toBe('auth'); // its own pause is its own affair
    expect(await s.generate('hard')).toMatchObject({ brain: 'frontier', model: 'anthropic:opus' });
  });

  it('cheapestOn leaves out what the check may not use, and still finds one model by name', () => {
    const s = server();
    const ok = (b: BrainTier<Flint>) => b.model !== 'haiku';
    expect(s.brains.cheapestOn('anthropic')?.model).toBe('haiku');
    expect(s.brains.cheapestOn('anthropic', undefined, ok)?.model).toBe('sonnet');
    expect(s.brains.cheapestOn('anthropic', 'haiku', ok)?.model).toBe('haiku'); // a model's own check asks that model
    expect(s.brains.cheapestOn('anthropic', undefined, () => false)).toBeUndefined();
  });

  it('a provider-wide check that is told "not that model" has found the provider up: it closes, and is not re-paused as a rejected key', async () => {
    const t = make();
    fail(t, overloaded);
    t.checksFail(noAccess());
    t.advance(5 * MIN);
    t.breaker.paused('anthropic');
    await settle();
    expect(t.breaker.paused('anthropic')).toBeUndefined();
    expect(t.opened.map((e) => e.reason)).toEqual(['transient']); // no "Rejected Flint's Key" note for it
    // A 403 about the key itself still pauses the provider.
    const k = make();
    fail(k, overloaded);
    k.checksFail(badKey(403));
    k.advance(5 * MIN);
    k.breaker.paused('anthropic');
    await settle();
    expect(k.breaker.state('anthropic').open).toMatchObject({ reason: 'auth' });
  });
});

describe('/chat: the last frontier tier', () => {
  it('an error from it reaches the local model, not Will (single-brain chain, before the breaker has opened)', async () => {
    const s = server({}); // no tiers: every chain is the one legacy brain
    s.claude.state.fail = overloaded;
    let n = 0;
    const stream = s.claude.provider.stream.bind(s.claude.provider);
    s.claude.provider.stream = (args) => {
      n++;
      return stream(args);
    };
    const r = await s.chat('standard');
    expect(n).toBe(3);
    expect(r).toMatchObject({ brain: 'local', text: 'answer from muse-glimmer:30b', errors: [] });
    expect(r.metas).toEqual(['frontier:anthropic:sonnet', 'local']);
    // The failed attempt left no half-turn: the conversation holds the question once, with the local answer.
    expect((await s.memory.getMessages('c')).map((m) => [m.role, m.content])).toEqual([['user', 'q'], ['assistant', 'answer from muse-glimmer:30b']]);
  });
});

describe('a turn only the frontier can answer (an image or PDF)', () => {
  it('is left exactly as planned: it is asked even while the breaker is open, and its success closes it', async () => {
    const s = server();
    s.claude.state.fail = credit;
    await s.generate('standard');
    expect(s.breaker.paused('anthropic')).toBe('credit');
    s.claude.state.requests.length = 0;
    await expect(s.generate('standard', false)).rejects.toBeInstanceOf(FlintError); // still out of credit: every brain is asked, as before
    expect(s.claude.state.requests).toEqual(['sonnet', 'haiku']);
    s.claude.state.fail = undefined;
    expect(await s.generate('standard', false)).toMatchObject({ brain: 'frontier', model: 'anthropic:sonnet', paused: undefined });
    expect(s.breaker.paused('anthropic')).toBeUndefined();
  });
});

describe('gateChain / gateTurn / gated', () => {
  const brain = (provider: string, model: string): BrainTier<string> => ({ tier: 'standard', provider: { name: provider } as ProviderAdapter, model, label: `${provider}:${model}`, persona: model });
  const chain = [brain('anthropic', 'opus'), brain('anthropic', 'sonnet'), brain('openai', 'gpt-5'), brain('ollama', 'big:70b')];
  const pausing = (reasons: Record<string, 'credit' | 'auth' | 'transient'>) => ({ paused: (p: string) => reasons[p] });

  it('leaves out only the paused provider\'s brains: another vendor, or an ollama tier, still answers', () => {
    const g = gateChain(chain, pausing({ anthropic: 'credit' }));
    expect(g.chain.map((b) => b.label)).toEqual(['openai:gpt-5', 'ollama:big:70b']);
    expect(g.paused).toEqual([
      { label: 'anthropic:opus', provider: 'anthropic', reason: 'credit' },
      { label: 'anthropic:sonnet', provider: 'anthropic', reason: 'credit' },
    ]);
    expect(pausedCode(g.paused)).toBe('anthropic:credit');
    expect(pausedCode([])).toBeUndefined();
    expect(pausedCode(gateChain(chain, pausing({ anthropic: 'credit', openai: 'transient' })).paused)).toBe('anthropic:credit,openai:transient');
  });

  it('gateTurn: some brains left, the turn stays on the frontier without the paused ones', () => {
    const g = gateTurn({ brain: 'frontier', chain, canLocal: true, breaker: pausing({ anthropic: 'auth' }) });
    expect(g.brain).toBe('frontier');
    expect(g.chain.map((b) => b.label)).toEqual(['openai:gpt-5', 'ollama:big:70b']);
    expect(g.paused).toBe('anthropic:auth');
  });

  it('gateTurn: none left, it is a local turn from the start', () => {
    const g = gateTurn({ brain: 'frontier', chain: chain.slice(0, 2), canLocal: true, breaker: pausing({ anthropic: 'credit' }) });
    expect(g).toMatchObject({ brain: 'local', chain: [], paused: 'anthropic:credit' });
  });

  it('gateTurn: nothing paused, or a turn that was local already, is left alone', () => {
    const open = gateTurn({ brain: 'frontier', chain, canLocal: true, breaker: pausing({}) });
    expect(open.brain).toBe('frontier');
    expect(open.chain).toEqual(chain);
    expect(open.paused).toBeUndefined();
    const local = gateTurn({ brain: 'local', chain: undefined, canLocal: true, breaker: pausing({ anthropic: 'credit' }) });
    expect(local).toMatchObject({ brain: 'local', chain: [] });
    expect(local.paused).toBeUndefined();
  });

  it('gateTurn: a turn the local model may not answer keeps its whole chain and asks every brain', async () => {
    const g = gateTurn({ brain: 'frontier', chain, canLocal: false, breaker: pausing({ anthropic: 'credit', openai: 'credit' }) });
    expect(g.brain).toBe('frontier');
    expect(g.chain).toEqual(chain);
    expect(g.paused).toBeUndefined();
    expect(await g.attempt(async (b) => b.label)(chain[0]!)).toBe('anthropic:opus');
  });

  it('gated: an outage that opens mid-turn skips nobody in that turn', async () => {
    const asked: string[] = [];
    const attempt = gated(pausing({ anthropic: 'transient' }), async (b: BrainTier<string>) => (asked.push(b.label), b.label));
    expect(await attempt(chain[1]!)).toBe('anthropic:sonnet');
    expect(asked).toEqual(['anthropic:sonnet']);
    // ...while at plan time, before the turn starts, a paused provider's brains are left out whatever the reason.
    expect(gateChain(chain, pausing({ anthropic: 'transient' })).chain.map((b) => b.label)).toEqual(['openai:gpt-5', 'ollama:big:70b']);
  });

  it('gated: a brain whose account was paused (credit, auth) while its turn runs is skipped without being asked', async () => {
    const reasons: Record<string, 'credit'> = {};
    const asked: string[] = [];
    const attempt = gated(pausing(reasons), async (b: BrainTier<string>) => {
      asked.push(b.label);
      reasons.anthropic = 'credit'; // this brain's failure opened the breaker
      throw new FlintError(credit());
    });
    await expect(attempt(chain[0]!)).rejects.toBeInstanceOf(FlintError);
    const skipped = await attempt(chain[1]!).catch((e: unknown) => e);
    expect(skipped).toBeInstanceOf(FrontierPaused);
    expect((skipped as FrontierPaused).brain).toEqual({ label: 'anthropic:sonnet', provider: 'anthropic', reason: 'credit' });
    expect((skipped as FrontierPaused).message).toBe('paused: credit');
    expect(asked).toEqual(['anthropic:opus']);
  });
});

describe('breakerNote (what the console tells Will)', () => {
  it('says what happened and what Flint is doing, in plain words, for the things only Will can fix', () => {
    expect(breakerNote({ provider: 'anthropic', reason: 'credit' })).toEqual({
      title: 'Claude Has No Credit Left',
      body: 'Flint is answering with the local model, and checks again every 15 minutes.',
    });
    expect(breakerNote({ provider: 'openai', reason: 'auth' })).toEqual({
      title: 'OpenAI Rejected Flint’s Key',
      body: 'Flint is answering with the local model, and checks again every 15 minutes.',
    });
  });

  // Will's rules for a note (2026-10-12) allow no internal name, and a model's id is one.
  it('one model the key may not use: says so without the model\'s id, where to find it, and that the others still answer', () => {
    expect(breakerNote({ provider: 'anthropic', reason: 'auth', model: 'claude-opus-5-5' })).toEqual({
      title: 'Claude Refused One Model',
      body: 'Flint’s key can’t use one of Claude’s models, and the server log names it. The others still answer, and Flint checks again every 15 minutes.',
    });
  });

  it('no note carries a model id or a provider\'s config name, whatever the provider is called', () => {
    for (const provider of ['anthropic', 'openai', 'perplexity', 'ollama', 'openai-compat', 'my_proxy']) {
      for (const e of [
        { provider, reason: 'credit' as const },
        { provider, reason: 'auth' as const },
        { provider, reason: 'auth' as const, model: 'sonar-deep-research' },
        { provider, reason: 'auth' as const, model: 'gpt-5.5' },
      ]) {
        const note = breakerNote(e)!;
        const text = `${note.title} ${note.body}`;
        expect(text, text).not.toMatch(/sonar|gpt|openai-compat|my_proxy|[a-z]+-[a-z0-9]+-|[()`_]/);
        // Title Case, with no stop; whole sentences under it.
        expect(note.title, note.title).toMatch(/^(?:[A-Z][A-Za-z’]*)(?: [A-Z][A-Za-z’]*)*$/);
        expect(note.body, note.body).toMatch(/^[A-Z].*\.$/);
      }
    }
    expect(breakerNote({ provider: 'ollama', reason: 'auth' })!.title).toBe('Ollama Rejected Flint’s Key');
    expect(breakerNote({ provider: 'my_proxy', reason: 'credit' })!.title).toBe('An Outside AI Has No Credit Left');
    expect(breakerNote({ provider: 'my_proxy', reason: 'auth', model: 'x-1' })!.body).toBe(
      'Flint’s key can’t use one of its models, and the server log names it. The others still answer, and Flint checks again every 15 minutes.',
    );
  });

  it('an outage that clears itself gets no note', () => {
    expect(breakerNote({ provider: 'anthropic', reason: 'transient' })).toBeUndefined();
  });
});
