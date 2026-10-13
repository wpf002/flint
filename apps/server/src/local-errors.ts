/**
 * What a local model server said when it failed is not repeated.
 *
 * A model server's error body is the server's own words, and they can be
 * anything: a review's stand-in answered a request with "decode failed for
 * image" followed by the request itself, and the picture's bytes were then
 * stored in conversations.json as the failed turn's error and sent back to the
 * client. A request to a local model can carry what stays on this Mac (a
 * private message, a picture, a PDF's text), so whatever comes back in an
 * error is treated as carrying it too.
 *
 * `plainErrors` wraps a local model's adapter: an error keeps its CLASS (its
 * kind, whether it may be tried again, and a short code when the code is
 * plain), and its message becomes one of a few fixed sentences. Never the
 * body, in full or in part. Two errors pass as they are, because the adapter
 * wrote them itself and callers read them: its own deadlines (the first-token,
 * idle and whole-reply timeouts), and a call the caller called off.
 *
 * It is put around EVERY local adapter, whatever is set (./local-brains): an
 * error's wording is not a default worth keeping, and the hole was there for a
 * text file and a private message before pictures and PDFs were.
 */
import { FIRST_TOKEN_TIMEOUT, IDLE_TIMEOUT, REQUEST_TIMEOUT, FlintError, isFlintError, type AiError, type ProviderAdapter } from '@flint/core';

/** The sentence for each class of failure. Nothing of the server's own words is in any of them. */
export const LOCAL_ERROR_SENTENCES: Readonly<Record<AiError['kind'], string>> = {
  rate_limit: 'The local model server is busy.',
  timeout: 'The local model took too long.',
  validation: 'The local model server refused the request.',
  context_overflow: 'The prompt does not fit the local model.',
  provider_unavailable: 'The local model server could not answer.',
  internal: 'The local model server failed.',
};

const OWN_DEADLINES: ReadonlySet<string> = new Set([FIRST_TOKEN_TIMEOUT, IDLE_TIMEOUT, REQUEST_TIMEOUT]);
/** A code that is plain enough to keep: a status, or a short name. Anything else may be the server's own text. */
const PLAIN_CODE = /^[A-Za-z0-9_.-]{1,40}$/;

/** Did the adapter write this error itself: one of its own deadlines, or the caller's own cancellation? */
function adaptersOwn(e: AiError): boolean {
  if (e.providerCode !== undefined && OWN_DEADLINES.has(e.providerCode)) return true;
  return e.kind === 'timeout' && !e.retryable && e.message.length <= 200 && /abort/i.test(e.message);
}

/** The error with its class kept and its message replaced. The same object for one the adapter wrote itself. */
export function plainError(e: AiError): AiError {
  if (adaptersOwn(e)) return e;
  const raw = e.raw && typeof e.raw === 'object' ? (e.raw as { status?: unknown; name?: unknown }) : undefined;
  const status = typeof raw?.status === 'number' && Number.isInteger(raw.status) ? raw.status : undefined;
  const name = typeof raw?.name === 'string' && PLAIN_CODE.test(raw.name) ? raw.name : undefined;
  return {
    kind: e.kind,
    message: LOCAL_ERROR_SENTENCES[e.kind] ?? LOCAL_ERROR_SENTENCES.internal,
    retryable: e.retryable,
    ...(e.providerCode !== undefined && PLAIN_CODE.test(e.providerCode) ? { providerCode: e.providerCode } : {}),
    ...(status !== undefined || name !== undefined ? { raw: { ...(status !== undefined ? { status } : {}), ...(name !== undefined ? { name } : {}) } } : {}),
  };
}

/** A local model's adapter whose errors say their class and a fixed sentence, and nothing the server wrote. */
export function plainErrors(inner: ProviderAdapter): ProviderAdapter {
  // (Where the adapter's server is, and the window it asks for, stay readable through the wrapper: ./policy brainOf.)
  const { baseURL, numCtx } = inner as { readonly baseURL?: unknown; readonly numCtx?: unknown };
  return {
    name: inner.name,
    ...(typeof baseURL === 'string' ? { baseURL } : {}),
    ...(typeof numCtx === 'number' ? { numCtx } : {}),
    getCapabilities: (model) => inner.getCapabilities(model),
    estimateTokens: (messages, model) => inner.estimateTokens(messages, model),
    async generate(args) {
      try {
        return await inner.generate(args);
      } catch (err) {
        if (isFlintError(err)) throw new FlintError(plainError(err.error));
        // Not an error the adapter shaped: nothing of it is passed on either.
        throw new FlintError({ kind: 'internal', message: LOCAL_ERROR_SENTENCES.internal, retryable: false });
      }
    },
    async *stream(args) {
      const it = inner.stream(args)[Symbol.asyncIterator]();
      try {
        for (;;) {
          let step: IteratorResult<Awaited<ReturnType<typeof it.next>>['value']>;
          try {
            step = await it.next();
          } catch (err) {
            yield { type: 'error', error: isFlintError(err) ? plainError(err.error) : { kind: 'internal', message: LOCAL_ERROR_SENTENCES.internal, retryable: false } };
            return;
          }
          if (step.done) return;
          const ev = step.value;
          yield ev.type === 'error' ? { ...ev, error: plainError(ev.error) } : ev;
        }
      } finally {
        await it.return?.(undefined);
      }
    },
  };
}
