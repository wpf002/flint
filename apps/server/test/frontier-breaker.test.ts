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
function make(opts: { probe?: (provider: string, signal: AbortSignal) => Promise<void>; probeTimeoutMs?: number } = {}) {
  const clock = { now: 1_000_000 };
  const logs: string[] = [];
  const opened: Array<{ provider: string; reason: string; cooldownMs: number }> = [];
  const probes: string[] = [];
  let answer: () => Promise<void> = async () => {};
  const breaker = new FrontierBreaker({
    now: () => clock.now,
    log: (m) => logs.push(m),
    onOpen: (e) => opened.push(e),
    probe:
      opts.probe ??
      (async (p) => {
        probes.push(p);
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
    /** What the next checks do: answer, or throw this error. */
    checksFail: (err: AiError | undefined) => (answer = err ? async () => Promise.reject(new FlintError(err)) : async () => {}),
    advance: (ms: number) => (clock.now += ms),
  };
}

describe('breakerReason (which failures will keep failing)', () => {
  it('credit: the 400 that says the balance is too low, and OpenAI\'s spent quota', () => {
    expect(breakerReason(credit())).toBe('credit');
    expect(breakerReason(makeAiError('validation', 'openai: You exceeded your current quota', { retryable: false, providerCode: 'insufficient_quota' }))).toBe('credit');
    expect(breakerReason(makeAiError('validation', 'openai: billing hard limit reached', { retryable: false, providerCode: '429' }))).toBe('credit');
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
  it('a spent credit balance opens it at once, for an hour', () => {
    const t = make();
    expect(t.breaker.paused('anthropic')).toBeUndefined();
    t.breaker.failed('anthropic', credit());
    expect(t.breaker.paused('anthropic')).toBe('credit');
    expect(t.breaker.state('anthropic').open).toMatchObject({ reason: 'credit', cooldownMs: HARD_COOLDOWN_MS, until: t.clock.now + 60 * MIN });
    expect(t.opened).toEqual([{ provider: 'anthropic', reason: 'credit', cooldownMs: 60 * MIN }]);
  });

  it('a rejected key (401 or 403) opens it at once, for an hour', () => {
    for (const status of [401, 403]) {
      const t = make();
      t.breaker.failed('anthropic', badKey(status));
      expect(t.breaker.paused('anthropic')).toBe('auth');
      expect(t.breaker.state('anthropic').open?.cooldownMs).toBe(HARD_COOLDOWN_MS);
    }
  });

  it.each([
    ['529', overloaded],
    ['500', () => overloaded(500)],
    ['a timeout', timedOut],
    ['a connection error', noConnection],
  ])('%s opens it only after three in a row, for 5 minutes', (_name, err) => {
    const t = make();
    for (let i = 1; i < BREAKER_THRESHOLD; i++) {
      t.breaker.failed('anthropic', err());
      expect(t.breaker.paused('anthropic'), `after ${i}`).toBeUndefined();
    }
    t.breaker.failed('anthropic', err());
    expect(t.breaker.paused('anthropic')).toBe('transient');
    expect(t.breaker.state('anthropic').open?.cooldownMs).toBe(TRANSIENT_COOLDOWN_MS);
    expect(TRANSIENT_COOLDOWN_MS).toBe(5 * MIN);
  });

  it('"in a row" means no success between: one answer starts the count over', () => {
    const t = make();
    t.breaker.failed('anthropic', overloaded());
    t.breaker.failed('anthropic', timedOut());
    t.breaker.succeeded('anthropic');
    t.breaker.failed('anthropic', overloaded());
    t.breaker.failed('anthropic', noConnection());
    expect(t.breaker.paused('anthropic')).toBeUndefined();
    t.breaker.failed('anthropic', overloaded(503)); // mixed kinds count together
    expect(t.breaker.paused('anthropic')).toBe('transient');
  });

  it('failures that say nothing about the next call are not counted', () => {
    const t = make();
    for (const err of [closedTab(), rateLimited(), malformed(), closedTab(), rateLimited(), malformed()]) t.breaker.failed('anthropic', err);
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
    for (let i = 0; i < 10; i++) t.breaker.failed('ollama', noConnection());
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
      '[breaker] anthropic paused (credit): the local model answers; next check in 60 min',
      '[breaker] openai paused (auth): the local model answers; next check in 60 min',
    ]);
    expect(t.logs.join('\n')).not.toMatch(/balance|Billing|x-api-key/i);
  });
});

describe('the cool-down and the one check after it', () => {
  it('asks nothing during the cool-down, then makes one check however many turns ask', async () => {
    const t = make();
    t.checksFail(credit());
    t.breaker.failed('anthropic', credit());
    t.advance(59 * MIN);
    for (let i = 0; i < 5; i++) expect(t.breaker.paused('anthropic')).toBe('credit');
    expect(t.probes).toEqual([]);
    t.advance(MIN);
    // The turns that arrive now are still answered locally: nobody waits on the check.
    for (let i = 0; i < 5; i++) expect(t.breaker.paused('anthropic')).toBe('credit');
    await settle();
    expect(t.probes).toEqual(['anthropic']);
  });

  it('a check that is answered closes the breaker', async () => {
    const t = make();
    t.breaker.failed('anthropic', credit());
    t.advance(60 * MIN);
    expect(t.breaker.paused('anthropic')).toBe('credit');
    await settle();
    expect(t.breaker.paused('anthropic')).toBeUndefined();
    expect(t.logs.at(-1)).toBe('[breaker] anthropic answered: back in use');
  });

  it('credit and auth are checked again every hour, for as long as they fail', async () => {
    for (const err of [credit, badKey]) {
      const t = make();
      t.checksFail(err());
      t.breaker.failed('anthropic', err());
      for (let hour = 1; hour <= 4; hour++) {
        t.advance(60 * MIN);
        t.breaker.paused('anthropic');
        await settle();
        expect(t.probes).toHaveLength(hour);
        expect(t.breaker.state('anthropic').open).toMatchObject({ cooldownMs: HARD_COOLDOWN_MS, until: t.clock.now + 60 * MIN, probing: false });
      }
      expect(t.opened).toHaveLength(1); // a failed check is not a new pause: one note for Will, not one an hour
    }
  });

  it('a transient cool-down doubles with each failed check, up to an hour', async () => {
    const t = make();
    t.checksFail(overloaded());
    for (let i = 0; i < BREAKER_THRESHOLD; i++) t.breaker.failed('anthropic', overloaded());
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
    for (let i = 0; i < BREAKER_THRESHOLD; i++) t.breaker.failed('anthropic', overloaded());
    t.advance(5 * MIN);
    t.breaker.paused('anthropic');
    await settle();
    expect(t.breaker.state('anthropic').open?.cooldownMs).toBe(10 * MIN);
    t.checksFail(undefined);
    t.advance(10 * MIN);
    t.breaker.paused('anthropic');
    await settle();
    expect(t.breaker.paused('anthropic')).toBeUndefined();
    for (let i = 0; i < BREAKER_THRESHOLD; i++) t.breaker.failed('anthropic', overloaded());
    expect(t.breaker.state('anthropic').open?.cooldownMs).toBe(5 * MIN);
  });

  it('the check\'s answer sets the reason: an outage that turns out to be no credit waits an hour, and the other way round 5 minutes', async () => {
    const t = make();
    for (let i = 0; i < BREAKER_THRESHOLD; i++) t.breaker.failed('anthropic', overloaded());
    t.checksFail(credit());
    t.advance(5 * MIN);
    t.breaker.paused('anthropic');
    await settle();
    expect(t.breaker.state('anthropic').open).toMatchObject({ reason: 'credit', cooldownMs: HARD_COOLDOWN_MS });
    t.checksFail(noConnection());
    t.advance(60 * MIN);
    t.breaker.paused('anthropic');
    await settle();
    expect(t.breaker.state('anthropic').open).toMatchObject({ reason: 'transient', cooldownMs: TRANSIENT_COOLDOWN_MS });
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
    t.advance(60 * MIN);
    t.breaker.paused('anthropic');
    await new Promise((r) => setTimeout(r, 40));
    expect(cut).toBe(true);
    expect(t.breaker.state('anthropic').open).toMatchObject({ reason: 'transient', cooldownMs: TRANSIENT_COOLDOWN_MS, probing: false });
  });

  it('a check that is answered with something that is no outage (a 429) closes it: real calls decide', async () => {
    const t = make();
    t.checksFail(rateLimited());
    t.breaker.failed('anthropic', credit());
    t.advance(60 * MIN);
    t.breaker.paused('anthropic');
    await settle();
    expect(t.breaker.paused('anthropic')).toBeUndefined();
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
    t.breaker.failed('anthropic', overloaded());
    expect(t.breaker.state('anthropic')).toEqual(before);
    expect(t.opened).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// through real Flint clients: the observer, the chain, both routes

/** A stand-in vendor: every model on it answers `say`, or fails as `fail` says. Counts requests per model. */
function vendor(name = 'anthropic') {
  const state: { fail: (() => AiError) | undefined; requests: string[] } = { fail: undefined, requests: [] };
  const provider: ProviderAdapter = {
    name,
    getCapabilities: () => ({ toolCalling: 'native', structuredOutput: 'native', streaming: 'full', maxContextTokens: 100_000, maxOutputTokens: 1_000 }),
    estimateTokens: () => 1,
    generate: () => Promise.reject(new Error('stream only')),
    async *stream(args): AsyncIterable<StreamEvent> {
      state.requests.push(args.model);
      if (state.fail) {
        yield { type: 'error', error: state.fail() };
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
    probe: async (p, signal) => {
      const b = brains.cheapestOn(p)!;
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

  it('529s: three failed requests in a row open it (Flint\'s own retries are requests)', async () => {
    const s = server();
    s.claude.state.fail = overloaded;
    const r = await s.generate('hard');
    expect(s.claude.state.requests).toEqual(['opus', 'opus', 'opus']);
    expect(s.breaker.paused('anthropic')).toBe('transient');
    expect(r).toMatchObject({ brain: 'local', paused: 'anthropic:transient' });
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
    s.advance(59 * MIN);
    expect(await turn(s, 'standard', 'c1')).toMatchObject({ brain: 'local' });
    expect(s.claude.state.requests).toEqual([]); // still cooling down: not even a check
    s.advance(MIN);
    expect(await turn(s, 'standard', 'c2')).toMatchObject({ brain: 'local', paused: 'anthropic:credit' });
    await settle();
    expect(s.claude.state.requests).toEqual(['haiku']); // the check: one request, to the cheapest brain
    expect(await turn(s, 'standard', 'c3')).toMatchObject({ brain: 'frontier', model: 'anthropic:sonnet', text: 'answer from sonnet' });
  });

  it('a check that fails keeps the turns local, with one request an hour and no more', async () => {
    const s = server();
    s.claude.state.fail = credit;
    await turn(s, 'hard');
    s.claude.state.requests.length = 0;
    for (let hour = 1; hour <= 3; hour++) {
      s.advance(60 * MIN);
      for (let i = 0; i < 4; i++) expect(await turn(s, 'hard', `c${hour}-${i}`)).toMatchObject({ brain: 'local' });
      await settle();
      expect(s.claude.state.requests).toHaveLength(hour);
    }
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

  it('gated: a brain paused while its turn runs is skipped without being asked', async () => {
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
  it('says what happened and what Flint is doing, in plain words, for the two things only Will can fix', () => {
    expect(breakerNote({ provider: 'anthropic', reason: 'credit' })).toEqual({
      title: 'Claude Is Out of Credit',
      body: 'Flint is answering with the local model, and checks again every hour.',
    });
    expect(breakerNote({ provider: 'openai', reason: 'auth' })).toEqual({
      title: "OpenAI Rejected Flint's Key",
      body: 'Flint is answering with the local model, and checks again every hour.',
    });
  });

  it('an outage that clears itself gets no note', () => {
    expect(breakerNote({ provider: 'anthropic', reason: 'transient' })).toBeUndefined();
  });
});
