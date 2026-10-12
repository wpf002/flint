/**
 * What the server log may carry of an error (./error-log): its class, never a
 * provider's words. Every case plants a canary in the error's message and in
 * its raw body, and looks for it in what was logged: the lines index.ts and
 * deep_research write (errorRef, the tier fallback, the hand-off to the local
 * model, the planner). FLINT_DEBUG_ERRORS=1 is the one way to see it all.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FlintError, makeAiError } from '@flint/core';
import { debugErrors, errorClass, errorSummary, logError } from '../src/error-log';
import { planQueries } from '../src/deep-research';
import { NoAnswer } from '../src/unanswered';

const CANARY = 'CANARY-7f3a-what-will-typed';

/** A provider error as the adapters build one: the vendor's words in `message`, the whole response in `raw`. */
function providerError(kind: Parameters<typeof makeAiError>[0], providerCode: string | undefined, words: string): FlintError {
  return new FlintError(
    makeAiError(kind, `${words} ${CANARY}`, {
      retryable: false,
      ...(providerCode !== undefined ? { providerCode } : {}),
      raw: Object.assign(new Error(`upstream said: ${CANARY}`), { body: { error: { message: `model output echoed: ${CANARY}` } }, status: 500 }),
    }),
  );
}

function capture() {
  const lines: string[] = [];
  const log = (...args: unknown[]) => lines.push(args.map((a) => (typeof a === 'string' ? a : a instanceof Error ? `${a.stack ?? a.message} ${JSON.stringify(a, Object.getOwnPropertyNames(a))}` : JSON.stringify(a))).join(' '));
  return { lines, log, text: () => lines.join('\n') };
}

describe('errorSummary', () => {
  it('a provider error is its kind, its code and the breaker\'s reason: code words only', () => {
    expect(errorSummary(providerError('validation', '400', '400 Your credit balance is too low'))).toBe('validation 400 credit');
    expect(errorSummary(providerError('provider_unavailable', '529', 'Overloaded'))).toBe('provider_unavailable 529 transient');
    expect(errorSummary(providerError('validation', 'insufficient_quota', 'openai: You exceeded your current quota'))).toBe('validation insufficient_quota credit');
    expect(errorSummary(providerError('timeout', undefined, 'Request timed out'))).toBe('timeout');
    expect(errorSummary(providerError('rate_limit', '429', 'slow down'))).toBe('rate_limit 429');
  });

  it('a provider "code" that is not one (free text) is left out', () => {
    expect(errorSummary(providerError('validation', `see ${CANARY}`, 'bad'))).toBe('validation');
    expect(errorSummary(providerError('validation', 'x'.repeat(41), 'bad'))).toBe('validation');
  });

  it('the server\'s own errors are their name, with their reason code when they carry one', () => {
    expect(errorSummary(new NoAnswer('refusal'))).toBe('NoAnswer refusal');
    expect(errorSummary(new TypeError(`cannot read ${CANARY}`))).toBe('TypeError');
    expect(errorSummary(Object.assign(new Error('x'), { why: `free text ${CANARY}` }))).toBe('Error');
    expect(errorSummary(`a string ${CANARY}`)).toBe('error');
    expect(errorClass(new DOMException('late', 'TimeoutError'))).toBe('timeout');
  });

  it('never carries the canary, for any error', () => {
    for (const err of [providerError('validation', '400', 'x'), providerError('internal', undefined, 'x'), new Error(CANARY), { message: CANARY }, null, undefined]) {
      expect(errorSummary(err)).not.toContain(CANARY);
    }
  });
});

describe('logError (what errorRef, the tier fallback and the hand-off to local write)', () => {
  it('a provider error: one line of code words; not its message, not its raw body', () => {
    const c = capture();
    logError('[generate] ref=ab12cd', providerError('validation', '400', '400 {"error":{"message":"Your credit balance is too low"}}'), { log: c.log, env: {} });
    logError('[brain] anthropic:claude-opus-5-5 failed, falling back to anthropic:claude-sonnet-5:', providerError('provider_unavailable', '529', 'Overloaded'), { log: c.log, env: {} });
    logError('[brain] frontier failed pre-output, falling back to local:', providerError('provider_unavailable', undefined, 'ollama 500: the model wrote'), { log: c.log, env: {} });
    expect(c.lines).toEqual([
      '[generate] ref=ab12cd validation 400 credit',
      '[brain] anthropic:claude-opus-5-5 failed, falling back to anthropic:claude-sonnet-5: provider_unavailable 529 transient',
      '[brain] frontier failed pre-output, falling back to local: provider_unavailable transient',
    ]);
    expect(c.text()).not.toContain(CANARY);
    expect(c.text()).not.toMatch(/balance|Overloaded|the model wrote/);
  });

  it('an error of the server\'s own: its name and where it was thrown, not its message', () => {
    const c = capture();
    logError('[approvals] ref=zz', new RangeError(`row for ${CANARY} is missing`), { log: c.log, env: {} });
    expect(c.lines).toHaveLength(1);
    expect(c.lines[0]).toMatch(/^\[approvals\] ref=zz RangeError at .*error-log\.test\.ts:\d+:\d+/);
    expect(c.text()).not.toContain(CANARY);
  });

  it('a string the caller wrote is logged as written', () => {
    const c = capture();
    logError('[inbox] ref=q1', 'the runtime answered 502 for a feedback request', { log: c.log, env: {} });
    expect(c.lines).toEqual(['[inbox] ref=q1 the runtime answered 502 for a feedback request']);
  });

  it('FLINT_DEBUG_ERRORS=1 logs the whole error; anything else does not', () => {
    const err = providerError('validation', '400', 'x');
    const on = capture();
    logError('[generate] ref=1', err, { log: on.log, env: { FLINT_DEBUG_ERRORS: '1' } });
    expect(on.text()).toContain(CANARY);
    for (const v of [undefined, '', '0', 'true', 'yes']) {
      const off = capture();
      logError('[generate] ref=1', err, { log: off.log, env: { FLINT_DEBUG_ERRORS: v } });
      expect(off.text(), String(v)).not.toContain(CANARY);
      expect(debugErrors({ FLINT_DEBUG_ERRORS: v })).toBe(false);
    }
    expect(debugErrors({ FLINT_DEBUG_ERRORS: ' 1 ' })).toBe(true);
  });
});

describe('deep_research: the planner\'s failure', () => {
  it('is logged as its class, and the heuristic queries take over', async () => {
    const logs: string[] = [];
    const out = await planQueries(
      'what changed in the tax code this year',
      { complete: async () => Promise.reject(providerError('provider_unavailable', '500', 'ollama: the model wrote')), log: (m) => logs.push(m) },
      new Date('2026-10-12T12:00:00Z'),
      { minQueries: 2, maxQueries: 4, planTimeoutMs: 1000 } as Parameters<typeof planQueries>[3],
    );
    expect(out.planner).toBe('heuristic');
    expect(logs).toEqual(['[research] planner failed (provider_unavailable 500 transient); using heuristics']);
    expect(logs.join('\n')).not.toContain(CANARY);
  });
});

describe('index.ts logs errors through error-log, and nowhere hands a provider error to console.error', () => {
  const src = readFileSync(join(__dirname, '..', 'src', 'index.ts'), 'utf8');

  it('errorRef, the tier fallback and the hand-off to the local model', () => {
    expect(src).toContain('logError(`[${tag}] ref=${ref}`, err);');
    expect(src).toContain('else logError(`[brain] ${from.label} failed, falling back to ${to.label}:`, err);');
    expect(src).toContain('else logError(`[brain] ${how}, falling back to local:`, err);');
    expect(src).not.toMatch(/describeError/);
  });

  it('the only console.error calls given an error object are the two config reads and the boot failure', () => {
    const withErr = src.split('\n').filter((l) => /console\.error\([^)]*,\s*(err|e)\)/.test(l)).map((l) => l.trim());
    expect(withErr).toEqual([
      "console.error('[secrets] failed to read ~/.flint/secrets.env:', err);",
      "console.error('[mcp] failed to read MCP_CONFIG:', err);",
      "console.error('Flint server failed to start:', err);",
    ]);
  });
});
