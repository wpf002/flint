/**
 * The runtime's lanes, for the console (Machine plan P2): what triage decided,
 * Will's labels on it, and acknowledging or dismissing an escalation. These are
 * console buttons only, never model tools; they need the console's full token
 * (a scoped voice or eval token cannot reach them, ./access).
 *
 *   GET  /inbox?lane=relevant|quiet&before=<ISO>&limit=1..100   -> runtime GET /v1/inbox (a page, newest first;
 *                                                                  `next` is the `before` of the older page)
 *   POST /inbox/:id/feedback {feedback}                          -> runtime POST /v1/inbox/:id/feedback
 *   POST /escalations/:id/ack | /escalations/:id/dismiss        -> runtime POST /v1/escalations/:id/{ack,dismiss}
 *   GET  /runtime/health                                         -> runtime GET /v1/health/report
 *
 * Everything the console sends is validated here before the runtime sees it,
 * and everything the runtime answers is checked against the wire contracts
 * (@flint/policy InboxPage, HealthReport) before the console sees it. The
 * runtime's own words never pass through: a refusal is a short message of the
 * server's, and a failure a reference into the server's log. A runtime 401 or
 * 403 (it does not take the server's token) is a 502, never a 401: the console
 * forgets its token on a 401. The runtime records feedback, acks and dismissals
 * in its audit trail (it is the one writer).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { FEEDBACK, HealthReport, InboxPage, InboxTitles, LANES } from '@flint/policy';
import { readJsonLimited } from './attachments';
import type { Runtime } from './audit-sink';

export interface InboxDeps {
  /** The runtime link main() builds. */
  runtime: () => Runtime | undefined;
  fetchImpl?: typeof fetch;
  /** Per call to the runtime (default 5 s). */
  timeoutMs?: number;
  /** Log an error with a short reference, and return the reference for the client. */
  errorRef: (tag: string, err: unknown) => string;
}

const ID = /^[A-Za-z0-9_-]{1,40}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;
/** The largest runtime answer the server reads (a full page is well under this). */
const MAX_ANSWER = 4 * 1024 * 1024;

function reply(res: ServerResponse, status: number, body: unknown): true {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
  return true;
}

type Answer = { ok: true; json: unknown } | { ok: false; status: number };

/** One call to the runtime: its JSON, or the status it answered (0: no answer). The body is always read or cancelled. */
async function ask(deps: InboxDeps, rt: Runtime, method: 'GET' | 'POST', path: string, body?: unknown): Promise<Answer> {
  try {
    const r = await (deps.fetchImpl ?? fetch)(`${rt.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${rt.token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(deps.timeoutMs ?? 5000),
    });
    if (!r.ok) {
      await r.body?.cancel().catch(() => {});
      return { ok: false, status: r.status };
    }
    const text = await r.text();
    if (text.length > MAX_ANSWER) return { ok: false, status: -1 };
    return { ok: true, json: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, status: 0 };
  }
}

/**
 * The console's answer when the runtime did not give a usable one. `list` is a
 * read of a whole route (a 404 there means a runtime older than the lanes).
 */
function failed(res: ServerResponse, deps: InboxDeps, a: { status: number }, what: string, list: boolean): true {
  // Each error is a sentence Will reads in Activity: a decision and an escalation are both a row there, an "item".
  const s = a.status;
  if (s === 0) return reply(res, 502, { error: 'The runtime didn’t answer.' });
  // The token is ~/.flint/tokens/runtime.token; reinstalling writes it for both sides.
  if (s === 401 || s === 403) return reply(res, 502, { error: 'The runtime rejected Flint’s token. Reinstall the runtime to fix it.' });
  // A 404 on a list is a runtime older than the lanes; on one item, the item is gone (or the runtime predates them).
  if (s === 404) return list ? reply(res, 501, { error: 'This needs a newer runtime.' }) : reply(res, 404, { error: 'That item no longer exists.' });
  if (s === 400 || s === 422) return reply(res, 400, { error: 'The runtime refused that change.' });
  if (s === 409) return reply(res, 409, { error: 'That item can no longer change.' });
  if (s === 429) return reply(res, 429, { error: 'The runtime is busy. Try again shortly.' });
  return reply(res, 502, { error: 'The runtime hit an error. Try again.', ref: deps.errorRef('inbox', new Error(`the runtime answered ${s} for a ${what} request`)) });
}

/** The runtime answered 2xx with something that is not the contract: logged by field paths, never values. */
function malformed(res: ServerResponse, deps: InboxDeps, what: string, issues: string): true {
  return reply(res, 502, { error: 'The runtime sent an answer Flint can’t read.', ref: deps.errorRef('inbox', new Error(`malformed ${what} answer (${issues.slice(0, 300)})`)) });
}

const paths = (e: { issues: Array<{ path: Array<string | number> }> }) => [...new Set(e.issues.map((i) => i.path.join('.') || '(root)'))].join(', ');

/** Handle one lanes route; false when `url` is not one of them. */
export async function inboxRoutes(req: IncomingMessage, res: ServerResponse, url: string, deps: InboxDeps): Promise<boolean> {
  const u = new URL(url, 'http://x');
  const path = u.pathname;
  const feedback = /^\/inbox\/([^/]+)\/feedback$/.exec(path);
  const escalation = /^\/escalations\/([^/]+)\/(ack|dismiss)$/.exec(path);
  const ours = (req.method === 'GET' && (path === '/inbox' || path === '/runtime/health')) || (req.method === 'POST' && (feedback || escalation));
  if (!ours) return false;
  const rt = deps.runtime();
  if (!rt) return reply(res, 503, { error: 'The runtime isn’t installed.' });

  if (path === '/inbox') {
    const q = u.searchParams;
    const lane = q.get('lane') ?? 'relevant';
    if (!(LANES as readonly string[]).includes(lane)) return reply(res, 400, { error: `lane is one of ${LANES.join(', ')}` });
    const before = q.get('before');
    if (before !== null && (!ISO.test(before) || !Number.isFinite(Date.parse(before)))) return reply(res, 400, { error: 'before is an ISO time (the page\'s `next`)' });
    const rawLimit = q.get('limit');
    const limit = rawLimit === null ? 50 : /^\d{1,3}$/.test(rawLimit) ? Number(rawLimit) : NaN;
    if (!(limit >= 1 && limit <= 100)) return reply(res, 400, { error: 'limit is 1 to 100' });
    const query = new URLSearchParams({ lane, limit: String(limit), ...(before !== null ? { before } : {}) });
    const a = await ask(deps, rt, 'GET', `/v1/inbox?${query}`);
    if (!a.ok) return failed(res, deps, a, 'inbox', true);
    const page = InboxPage.safeParse(a.json);
    if (!page.success) return malformed(res, deps, 'inbox', paths(page.error));
    // A calendar event's title (P2.5), asked for on its own: a runtime that predates it answers 404 and the
    // page goes without. A title is an invitation author's text, so its item carries the tainted banner.
    const ids = page.data.items.filter((i) => i.entity).map((i) => i.id);
    if (ids.length) {
      const t = await ask(deps, rt, 'GET', `/v1/inbox/titles?${new URLSearchParams({ ids: ids.join(',') })}`);
      const titles = t.ok ? InboxTitles.safeParse(t.json) : undefined;
      if (titles?.success) {
        const byId = new Map(titles.data.titles.map((x) => [x.id, x.title]));
        for (const item of page.data.items) {
          const title = byId.get(item.id);
          if (title && item.entity) {
            item.entity.title = title;
            item.tainted = true;
          }
        }
      }
    }
    return reply(res, 200, page.data);
  }

  if (path === '/runtime/health') {
    const a = await ask(deps, rt, 'GET', '/v1/health/report');
    if (!a.ok) return failed(res, deps, a, 'health', true);
    const report = HealthReport.safeParse(a.json);
    if (!report.success) return malformed(res, deps, 'health', paths(report.error));
    return reply(res, 200, report.data);
  }

  // The POSTs: the id and the label are checked here, and the body is drained either way.
  const read = await readJsonLimited(req, 4096);
  if (read.tooLarge) return reply(res, 413, { error: 'request too large' });
  const id = (feedback ?? escalation)![1]!;
  if (!ID.test(id)) return reply(res, 400, { error: 'not an id' });
  let a: Answer;
  let what: string;
  if (feedback) {
    const label = read.body.feedback;
    if (typeof label !== 'string' || !(FEEDBACK as readonly string[]).includes(label)) return reply(res, 400, { error: `feedback is one of ${FEEDBACK.join(', ')}` });
    what = 'decision';
    a = await ask(deps, rt, 'POST', `/v1/inbox/${id}/feedback`, { feedback: label });
  } else {
    what = 'escalation';
    a = await ask(deps, rt, 'POST', `/v1/escalations/${id}/${escalation![2]}`, {});
  }
  if (!a.ok) return failed(res, deps, a, what, false);
  if ((a.json as { ok?: unknown } | null)?.ok !== true) return malformed(res, deps, what, 'ok');
  return reply(res, 200, { ok: true });
}
