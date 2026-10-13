/**
 * Flint's predictions, for the console's Predictions panel (P4 part 4): a
 * proxy to the runtime's prediction routes. Console buttons only, never model
 * tools: they need the console's full token (a scoped voice or eval token
 * cannot reach them, ./access).
 *
 *   GET  /predictions                              -> runtime GET /v1/predictions
 *   GET  /predictions/series/:key                  -> one number, open
 *   GET  /predictions/questions                    -> Will's questions
 *   GET  /predictions/accuracy                     -> how Flint has done
 *   POST /predictions/turn-on {series}             -> the Turn On Predictions card
 *   POST /predictions/series/:key/turn-off {}      -> unsigned
 *   POST /predictions/questions/:id/answer {answer}  -> his yes, no or skip: unsigned, recorded as his
 *
 * Every key, id and body is checked here with the shared contracts
 * (@flint/policy, bodies up to 16 KB) before the runtime sees it, and every
 * answer against its contract before the console does. The card is filed with
 * the runtime straight away: nothing is ever spooled to disk, so a runtime
 * that is down is a 503 and nothing changed. A write the runtime did not
 * answer (in time, or because the connection dropped on the way) is a 504 that
 * says Flint isn't sure it went through. The runtime's own words never pass
 * through: a refusal reaches the console only as one of PREDICT_SAYS's codes
 * and its fixed sentence. A runtime 401 or 403 is a 502 (the console forgets
 * its token on a 401); a 404 on the page is a 501 (an older runtime: the
 * console hides its Predictions button).
 *
 * A forecast's numbers are sensitive (spend and calendar hours among them),
 * and so are a question's words. They pass through here from the runtime to
 * the console and go nowhere else: this file keeps nothing, pushes no note,
 * and logs statuses, field paths and references only.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { z } from 'zod';
import { AccuracyView, AnswerBody, PredictDone, PredictEmptyBody, PredictFiled, PredictionRef, PredictionsPage, QuestionsPage, SeriesAnswer, SeriesKey, TurnOnBody, predictSayOf } from '@flint/policy';
import { readJsonLimited } from './attachments';
import type { Runtime } from './audit-sink';

export interface PredictionsDeps {
  /** The runtime link main() builds. */
  runtime: () => Runtime | undefined;
  fetchImpl?: typeof fetch;
  /** Per call to the runtime. Default: 10 s for a read, 30 s for a write. */
  timeoutMs?: number;
  /** Log an error with a short reference, and return the reference for the client. */
  errorRef: (tag: string, err: unknown) => string;
}

/** A predictions request's largest body: forty keys of eighty characters fit several times over. */
export const PREDICTIONS_BODY_BYTES = 16 * 1024;
const READ_TIMEOUT_MS = 10_000;
const WRITE_TIMEOUT_MS = 30_000;
/**
 * ask()'s status for a call that reached the runtime, or may have, and got no answer: it timed out, or the
 * connection dropped on the way. (0: the runtime could not be reached at all, so it got nothing.)
 */
const NO_ANSWER = -2;
/** A connection that was never made: the request did not leave. */
const UNREACHED: ReadonlySet<string> = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'EADDRNOTAVAIL', 'EAI_AGAIN']);
/** The largest runtime answer the server reads. */
const MAX_ANSWER = 1024 * 1024;

/** What Will reads when the runtime can't be asked. */
export const PREDICTIONS_SAY = {
  noRuntime: 'Predictions need the runtime.',
  older: 'This needs a newer runtime.',
  down: 'The runtime isn’t answering, so predictions can’t load.',
  downWrite: 'The runtime isn’t answering, so nothing changed.',
  unsure: 'Flint isn’t sure it went through. Check Predictions before trying again.',
  token: 'The runtime rejected Flint’s token. Reinstall the runtime to fix it.',
  refused: 'The runtime refused that change.',
  gone: 'That is no longer there.',
  stuck: 'That can no longer change.',
  busy: 'The runtime is busy. Try again shortly.',
  failed: 'The runtime hit an error. Try again.',
  unreadable: 'The runtime sent an answer Flint can’t read.',
  invalid: 'Flint can’t send that: it isn’t a valid predictions request.',
  tooLarge: 'That is too large to send.',
} as const;

function reply(res: ServerResponse, status: number, body: unknown): true {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
  return true;
}

type Answer = { ok: true; json: unknown } | { ok: false; status: number; code?: unknown };

/** One call to the runtime: its JSON, or its status (0: unreachable; NO_ANSWER: sent, or maybe sent, and not answered) and a refusal's code. The body is always read or cancelled. */
async function ask(deps: PredictionsDeps, rt: Runtime, method: 'GET' | 'POST', path: string, body?: unknown): Promise<Answer> {
  try {
    const r = await (deps.fetchImpl ?? fetch)(`${rt.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${rt.token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(deps.timeoutMs ?? (method === 'GET' ? READ_TIMEOUT_MS : WRITE_TIMEOUT_MS)),
    });
    const text = await r.text();
    if (text.length > MAX_ANSWER) return { ok: false, status: -1 };
    if (!r.ok) {
      let code: unknown;
      try {
        code = (JSON.parse(text) as { code?: unknown } | null)?.code;
      } catch {
        code = undefined;
      }
      return { ok: false, status: r.status, code };
    }
    return { ok: true, json: JSON.parse(text) as unknown };
  } catch (err) {
    // Only a connection that was never made is "the runtime got nothing". A timeout, a reset, a socket closed
    // mid-answer: the runtime may have the request, and a write may still land.
    const cause = (err as { cause?: { code?: unknown; errors?: Array<{ code?: unknown }> } } | null)?.cause;
    // One address, or several tried in turn (localhost): unreached only when every attempt was.
    const codes = Array.isArray(cause?.errors) && cause.errors.length ? cause.errors.map((e) => e?.code) : [cause?.code];
    return { ok: false, status: codes.every((c) => typeof c === 'string' && UNREACHED.has(c)) ? 0 : NO_ANSWER };
  }
}

/** The console's answer when the runtime did not give a usable one. `page`: the panel's first read (a 404 there is an older runtime). */
function failed(res: ServerResponse, deps: PredictionsDeps, a: { status: number; code?: unknown }, what: string, read: boolean, page: boolean): true {
  const s = a.status;
  if (s === 0) return reply(res, 503, { error: read ? PREDICTIONS_SAY.down : PREDICTIONS_SAY.downWrite });
  // No answer (in time, or the connection dropped): a read just did not load; a write may still land, and saying
  // "nothing changed" would be a guess.
  if (s === NO_ANSWER) return read ? reply(res, 503, { error: PREDICTIONS_SAY.down }) : reply(res, 504, { error: PREDICTIONS_SAY.unsure });
  if (s === 401 || s === 403) return reply(res, 502, { error: PREDICTIONS_SAY.token });
  // A refusal the runtime named by a code in the closed set: its fixed sentence, and the code.
  const say = predictSayOf(a.code);
  if (say && typeof a.code === 'string' && (s === 400 || s === 404 || s === 409 || s === 429)) return reply(res, s, { error: say, code: a.code });
  if (s === 404) return page || !read ? reply(res, 501, { error: PREDICTIONS_SAY.older }) : reply(res, 404, { error: PREDICTIONS_SAY.gone });
  if (s === 400 || s === 422) return reply(res, 400, { error: PREDICTIONS_SAY.refused });
  if (s === 409) return reply(res, 409, { error: PREDICTIONS_SAY.stuck });
  if (s === 413) return reply(res, 413, { error: PREDICTIONS_SAY.tooLarge });
  if (s === 429) return reply(res, 429, { error: PREDICTIONS_SAY.busy });
  return reply(res, 502, { error: PREDICTIONS_SAY.failed, ref: deps.errorRef('predictions', `the runtime answered ${s} for a ${what} request`) });
}

const paths = (e: z.ZodError) => [...new Set(e.issues.map((i) => i.path.join('.') || '(root)'))].join(', ').slice(0, 300);

/** The runtime answered 2xx with something that is not the contract: logged by field paths, never values. */
function malformed(res: ServerResponse, deps: PredictionsDeps, what: string, e: z.ZodError): true {
  return reply(res, 502, { error: PREDICTIONS_SAY.unreadable, ref: deps.errorRef('predictions', `malformed ${what} answer (${paths(e)})`) });
}

/** The console sent something no predictions route takes: refused here, before the runtime sees it, by field paths only. */
function invalid(res: ServerResponse, deps: PredictionsDeps, what: string, e?: z.ZodError): true {
  if (e) deps.errorRef('predictions', `refused a ${what} request (${paths(e)})`);
  return reply(res, 400, { error: PREDICTIONS_SAY.invalid });
}

/** Ask, check the answer against its contract, and pass it on. */
async function forward<T extends z.ZodTypeAny>(res: ServerResponse, deps: PredictionsDeps, rt: Runtime, method: 'GET' | 'POST', path: string, body: unknown, schema: T, what: string, page = false): Promise<true> {
  const a = await ask(deps, rt, method, path, body);
  if (!a.ok) return failed(res, deps, a, what, method === 'GET', page);
  const answer = schema.safeParse(a.json);
  if (!answer.success) return malformed(res, deps, what, answer.error);
  return reply(res, 200, answer.data);
}

const SERIES = /^\/predictions\/series\/([^/]+)$/;
const TURN_OFF = /^\/predictions\/series\/([^/]+)\/turn-off$/;
const ANSWER = /^\/predictions\/questions\/([^/]+)\/answer$/;
const READS: Readonly<Record<string, readonly [string, z.ZodTypeAny, string]>> = {
  '/predictions': ['/v1/predictions', PredictionsPage, 'page'],
  '/predictions/questions': ['/v1/predictions/questions', QuestionsPage, 'questions'],
  '/predictions/accuracy': ['/v1/predictions/accuracy', AccuracyView, 'accuracy'],
};

/** Handle one predictions route; false when `url` is not one of them. */
export async function predictionsRoutes(req: IncomingMessage, res: ServerResponse, url: string, deps: PredictionsDeps): Promise<boolean> {
  const u = new URL(url, 'http://x');
  const path = u.pathname;
  if (path !== '/predictions' && !path.startsWith('/predictions/')) return false;
  const get = req.method === 'GET';
  const post = req.method === 'POST';
  const read = get && Object.prototype.hasOwnProperty.call(READS, path) ? READS[path] : undefined;
  const one = get ? SERIES.exec(path) : null;
  const off = post ? TURN_OFF.exec(path) : null;
  const answer = post ? ANSWER.exec(path) : null;
  const on = post && path === '/predictions/turn-on';
  if (!read && !one && !off && !answer && !on) return false;
  const rt = deps.runtime();
  // Without the runtime there are no predictions: the console hides its button, as for an older runtime.
  if (!rt) {
    if (post) await readJsonLimited(req, PREDICTIONS_BODY_BYTES);
    return reply(res, 501, { error: PREDICTIONS_SAY.noRuntime });
  }

  if (read) {
    // No read takes a query: nothing about a number or a question ever rides in a URL.
    if (u.search) return invalid(res, deps, read[2]);
    return forward(res, deps, rt, 'GET', read[0], undefined, read[1], read[2], path === '/predictions');
  }
  if (one) {
    const key = SeriesKey.safeParse(one[1]);
    if (!key.success || u.search) return invalid(res, deps, 'number');
    return forward(res, deps, rt, 'GET', `/v1/predictions/series/${key.data}`, undefined, SeriesAnswer, 'number');
  }

  // The POSTs: the body is read (and drained) whatever happens, up to 16 KB.
  const got = await readJsonLimited(req, PREDICTIONS_BODY_BYTES);
  if (got.tooLarge) return reply(res, 413, { error: PREDICTIONS_SAY.tooLarge });
  const body = got.body;
  if (u.search) return invalid(res, deps, 'write');

  if (on) {
    const b = TurnOnBody.safeParse(body);
    if (!b.success) return invalid(res, deps, 'turn on', b.error);
    return forward(res, deps, rt, 'POST', '/v1/predictions/turn-on', b.data, PredictFiled, 'turn on');
  }
  if (off) {
    const key = SeriesKey.safeParse(off[1]);
    const b = PredictEmptyBody.safeParse(body ?? {});
    if (!key.success || !b.success) return invalid(res, deps, 'turn off', b.success ? undefined : b.error);
    return forward(res, deps, rt, 'POST', `/v1/predictions/series/${key.data}/turn-off`, {}, PredictDone, 'turn off');
  }
  const id = PredictionRef.safeParse(answer![1]);
  const b = AnswerBody.safeParse(body);
  if (!id.success || !b.success) return invalid(res, deps, 'answer', b.success ? undefined : b.error);
  return forward(res, deps, rt, 'POST', `/v1/predictions/questions/${id.data}/answer`, b.data, PredictDone, 'answer');
}
