import { describe, it, expect } from 'vitest';
import { FIRST_TOKEN_TIMEOUT, FlintError, IDLE_TIMEOUT, OllamaProvider, REQUEST_TIMEOUT, isFlintError, makeAiError, type AiError, type GenerateArgs, type Message, type ModelCapabilities, type ProviderAdapter, type StreamEvent } from '@flint/core';
import { LOCAL_ERROR_SENTENCES, plainError, plainErrors } from '../src/local-errors';
import { shouldFallBack } from '../src/brains';
import { observationOf } from '../src/local-serve';

/**
 * What a local model server said when it failed is not repeated
 * (../src/local-errors). A review's stand-in answered a request with the
 * request itself inside its error, and a picture's bytes were stored in
 * conversations.json as the failed turn's error and sent back to the client.
 */

const PICTURE = 'iVBORw0KGgoAAAANSUhEUgAAAKAAAAAwCAIAAAAOG4EJ';
const ECHO = `decode failed for image [{"role":"user","content":"ECHOMSG4 what is this?","images":["${PICTURE}"]}] ECHOQ4`;
const user: Message = { id: 'u', role: 'user', content: 'ECHOMSG4 what is this?', timestamp: 0 };
const args: GenerateArgs = { model: 'm', messages: [user] };
const upstream = (over: Partial<AiError> = {}): AiError => ({ kind: 'provider_unavailable', message: JSON.stringify({ error: ECHO }), retryable: true, providerCode: '500', raw: { status: 500, name: 'OllamaHttpError', body: ECHO }, ...over });

function failing(how: { throws?: unknown; yields?: StreamEvent[] }): ProviderAdapter & { baseURL: string; numCtx: number } {
  return {
    name: 'ollama',
    baseURL: 'http://127.0.0.1:11434',
    numCtx: 16_384,
    getCapabilities: () => ({ maxContextTokens: 16_384, maxOutputTokens: 1024, toolCalling: 'native' }) as ModelCapabilities,
    estimateTokens: () => 7,
    async generate() {
      throw how.throws ?? new FlintError(upstream());
    },
    async *stream() {
      if (how.yields) {
        yield* how.yields;
        return;
      }
      throw how.throws ?? new FlintError(upstream());
    },
  };
}
async function drain(it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe('one error, made plain', () => {
  it('keeps its class and says a fixed sentence: nothing the server wrote, in the message or beside it', () => {
    const got = plainError(upstream());
    expect(got).toEqual({ kind: 'provider_unavailable', message: 'The local model server could not answer.', retryable: true, providerCode: '500', raw: { status: 500, name: 'OllamaHttpError' } });
    expect(JSON.stringify(got)).not.toMatch(/ECHO|decode failed|iVBOR/);
  });

  it('every kind has a sentence, each a complete one with no parentheses', () => {
    for (const kind of ['rate_limit', 'timeout', 'validation', 'context_overflow', 'provider_unavailable', 'internal'] as const) {
      const got = plainError(upstream({ kind }));
      expect(got.kind).toBe(kind);
      expect(got.message).toBe(LOCAL_ERROR_SENTENCES[kind]);
      expect(got.message).toMatch(/^The .*\.$/);
      expect(got.message).not.toMatch(/[()]/);
    }
    expect(new Set(Object.values(LOCAL_ERROR_SENTENCES)).size).toBe(6);
  });

  it('a code or a name that is not a plain one is dropped: it may be the server’s own text', () => {
    expect(plainError(upstream({ providerCode: ECHO })).providerCode).toBeUndefined();
    expect(plainError(upstream({ providerCode: 'server_error' })).providerCode).toBe('server_error');
    expect(plainError(upstream({ raw: { status: 'five hundred', name: ECHO } })).raw).toBeUndefined();
    expect(plainError(upstream({ raw: ECHO })).raw).toBeUndefined();
    // (An Error object's kind of error is kept, as a name; what it said is not.)
    expect(plainError(upstream({ raw: new Error(ECHO) })).raw).toEqual({ name: 'Error' });
    expect(JSON.stringify(plainError(upstream({ raw: new Error(ECHO) })))).not.toMatch(/ECHO|iVBOR/);
    expect(plainError({ kind: 'internal', message: ECHO, retryable: false })).toEqual({ kind: 'internal', message: 'The local model server failed.', retryable: false });
  });

  it('the adapter’s own deadlines and the caller’s own cancellation pass as they are: callers read them', () => {
    for (const providerCode of [FIRST_TOKEN_TIMEOUT, IDLE_TIMEOUT, REQUEST_TIMEOUT]) {
      const own = makeAiError('timeout', 'The local model did not start answering in time.', { providerCode, retryable: false });
      expect(plainError(own)).toBe(own);
      // What the monitor learns from it is unchanged.
      expect(observationOf(plainError(own))).toBe('first_token_timeout');
    }
    const cancelled = makeAiError('timeout', 'The request was aborted.', { retryable: false });
    expect(plainError(cancelled)).toBe(cancelled);
    // ...and it is still told apart from a failure that should move on to the next brain.
    expect(shouldFallBack(new FlintError(plainError(cancelled)))).toBe(false);
    expect(shouldFallBack(new FlintError(plainError(upstream())))).toBe(true);
    // A long "abort" message is not the adapter's short one: it is treated as the server's.
    const long = makeAiError('timeout', `aborted ${ECHO} ${'x'.repeat(300)}`, { retryable: false });
    expect(plainError(long).message).toBe('The local model took too long.');
  });

  it('what the monitor learns from a failure is the same before and after', () => {
    for (const e of [upstream(), upstream({ providerCode: undefined }), upstream({ kind: 'internal', retryable: false })]) expect(observationOf(plainError(e))).toBe(observationOf(e));
  });
});

describe('a local adapter with plain errors', () => {
  it('is otherwise the adapter it wraps: its name, its address, its window, what it can do, and every answer', async () => {
    const ok: ProviderAdapter & { baseURL: string; numCtx: number } = { ...failing({}), generate: async () => ({ message: { id: 'a', role: 'assistant', content: 'fine', timestamp: 0 }, usage: { input: 1, output: 1 }, reason: 'complete' }) };
    const p = plainErrors(ok) as ProviderAdapter & { baseURL?: string; numCtx?: number };
    expect(p.name).toBe('ollama');
    expect(p.baseURL).toBe('http://127.0.0.1:11434');
    expect(p.numCtx).toBe(16_384);
    expect(p.getCapabilities('m')).toEqual(ok.getCapabilities('m'));
    expect(p.estimateTokens([user], 'm')).toBe(7);
    expect((await p.generate(args)).message.content).toBe('fine');
    const events: StreamEvent[] = [{ type: 'text', delta: 'fi' }, { type: 'text', delta: 'ne' }, { type: 'done', reason: 'complete', usage: { input: 1, output: 1 } }];
    expect(await drain(plainErrors(failing({ yields: events })).stream(args))).toEqual(events);
  });

  it('generate: the error thrown is the plain one', async () => {
    const err = await plainErrors(failing({})).generate(args).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(isFlintError(err)).toBe(true);
    if (!isFlintError(err)) return;
    expect(err.error).toEqual({ kind: 'provider_unavailable', message: 'The local model server could not answer.', retryable: true, providerCode: '500', raw: { status: 500, name: 'OllamaHttpError' } });
    expect(`${err.message} ${err.stack} ${JSON.stringify(err.error)}`).not.toMatch(/ECHO|iVBOR/);
  });

  it('stream: an error event is made plain, and so is an error thrown part way; what came before it is passed on', async () => {
    const yielded = await drain(plainErrors(failing({ yields: [{ type: 'text', delta: 'so far' }, { type: 'error', error: upstream() }] })).stream(args));
    expect(yielded).toEqual([{ type: 'text', delta: 'so far' }, { type: 'error', error: { kind: 'provider_unavailable', message: 'The local model server could not answer.', retryable: true, providerCode: '500', raw: { status: 500, name: 'OllamaHttpError' } } }]);
    const thrown = await drain(plainErrors(failing({})).stream(args));
    expect(thrown).toHaveLength(1);
    expect(JSON.stringify(thrown)).not.toMatch(/ECHO|iVBOR/);
    expect(thrown[0]).toMatchObject({ type: 'error', error: { kind: 'provider_unavailable' } });
  });

  it('something that is not an error the adapter shaped says nothing of itself either', async () => {
    const err = await plainErrors(failing({ throws: new Error(ECHO) })).generate(args).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(isFlintError(err) && err.error).toEqual({ kind: 'internal', message: 'The local model server failed.', retryable: false });
    expect(await drain(plainErrors(failing({ throws: new TypeError(ECHO) })).stream(args))).toEqual([{ type: 'error', error: { kind: 'internal', message: 'The local model server failed.', retryable: false } }]);
  });

  it('through the real Ollama adapter against a server that echoes the request in its error', async () => {
    const echo = (async (_url: unknown, init?: { body?: unknown }) => new Response(JSON.stringify({ error: `decode failed for image ${String(init?.body).slice(0, 4000)}` }), { status: 500 })) as unknown as typeof fetch;
    const real = new OllamaProvider({ baseURL: 'http://127.0.0.1:11434', fetch: echo, capabilities: () => ({ vision: true }) });
    const withPicture: GenerateArgs = { model: 'm', messages: [{ ...user, attachments: [{ kind: 'image', mediaType: 'image/png', name: 'ECHONAME4.png', data: PICTURE, bytes: 30 }] }] };
    // Bare, the adapter repeats what the server said: the picture's bytes, the message, the file's name.
    const bare = await real.generate(withPicture).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(isFlintError(bare) && bare.error.message).toContain(PICTURE);
    // Wrapped, none of it.
    const plain = await plainErrors(real).generate(withPicture).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(isFlintError(plain)).toBe(true);
    expect(JSON.stringify(isFlintError(plain) ? plain.error : plain)).not.toMatch(/iVBOR|ECHOMSG4|ECHONAME4|decode failed/);
    const streamed = await drain(plainErrors(real).stream(withPicture));
    expect(JSON.stringify(streamed)).not.toMatch(/iVBOR|ECHOMSG4|ECHONAME4|decode failed/);
    expect(streamed.at(-1)).toMatchObject({ type: 'error', error: { message: 'The local model server could not answer.' } });
  });
});
