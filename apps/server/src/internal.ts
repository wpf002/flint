/**
 * The server's internal listener (Machine plan 3.0.1): [::1]:8081, never in
 * `tailscale serve`, for the runtime's calls back into the server. The runtime
 * holds SERVER_INTERNAL_TOKEN; the server keeps only its sha256 (the token file
 * is written by install-runtime.sh as ~/.flint/tokens/internal.token, and its
 * digest read here at startup). Routes:
 *   POST /internal/notify          NotifyRequest            a note for Will, redacted and kept in the
 *                                                           console; `channels` adds a banner and a
 *                                                           content-free phone ping (both always with the
 *                                                           in-app note; omitted: all three, as in P1);
 *                                                           `ref` makes a resent note a duplicate
 *   POST /internal/load            {}                       {chatInFlight}: triage yields to chat
 *   POST /internal/complete        InternalCompleteRequest  a metered frontier call under a background
 *                                                           spend kind (./background-complete)
 *   POST /internal/spend-external  {asOf, vendors: {...}}   unified spend totals (plan 3.0.8), for the
 *                                                           background stop rule
 * The request and answer shapes are @flint/policy's wire contracts, which the
 * runtime validates too.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { LoadResponse, NotifyRequest, NotifyResponse, redactString, type NotifyChannel } from '@flint/policy';
import { noteChannels, type PushResult } from './notifications';
import type { CompleteResult } from './background-complete';

export interface InternalDeps {
  /** sha256 hex of the runtime's token; undefined = the listener refuses everything. */
  tokenSha256: () => string | undefined;
  /**
   * Keep a note for Will, deduped on `dedupe`, sent on `channels` (already
   * resolved: never a banner or ping without the in-app note).
   */
  notify: (n: { title: string; body: string; channels: NotifyChannel[]; dedupe: string }) => PushResult;
  spendExternal: (totals: ExternalSpend) => void;
  /** /chat turns running now (./chat-load). */
  chatInFlight: () => number;
  /** POST /internal/complete (./background-complete). */
  complete: (body: unknown) => Promise<CompleteResult>;
}

export interface ExternalSpend {
  asOf: string;
  vendors: Record<string, { dayUsd: number; monthUsd: number; estimate?: boolean }>;
}

/** Bodies up to 256 KB: a complete request carries up to 40k characters of prompt, JSON-escaped. */
const MAX = 256 * 1024;

function authorized(req: IncomingMessage, sha: string | undefined): boolean {
  const m = /^Bearer ([A-Za-z0-9._~+/=-]{16,512})$/.exec(req.headers.authorization ?? '');
  if (!sha || !/^[0-9a-f]{64}$/.test(sha) || !m) return false;
  return timingSafeEqual(createHash('sha256').update(m[1]!).digest(), Buffer.from(sha, 'hex'));
}

async function body(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX) throw new Error('too large');
    chunks.push(c as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

const send = (res: ServerResponse, status: number, b: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(b));
};

/** At most `n` UTF-16 units, never splitting a surrogate pair. */
const clip = (s: string, n: number): string => (s.length <= n ? s : s.slice(0, /[\uD800-\uDBFF]/.test(s[n - 1] ?? '') ? n - 1 : n));

export function internalHandler(deps: InternalDeps) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!authorized(req, deps.tokenSha256())) return send(res, 401, { error: 'unauthorized' });
    if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
    let b: Record<string, unknown>;
    try {
      const parsed = await body(req);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return send(res, 400, { error: 'bad body' });
      b = parsed as Record<string, unknown>;
    } catch {
      return send(res, 400, { error: 'bad body' });
    }
    const url = (req.url ?? '').split('?')[0];
    if (url === '/internal/notify') {
      const n = NotifyRequest.safeParse(b);
      if (!n.success) return send(res, 400, { error: 'not a notification (title, body, channels, ref)' });
      // A raw payload is not a note: the console shows words, not a tool's JSON.
      if (/^\s*[{[]/.test(n.data.body)) return send(res, 422, { error: 'not a notification Flint shows (a raw payload?)' });
      const title = clip(redactString(n.data.title), 80);
      const text = clip(redactString(n.data.body), 500);
      // A resent note (the runtime's retry after a timeout) is the same note; without a ref, every note is new.
      const dedupe = n.data.ref ? `rt:${n.data.ref}` : `rt:${Date.now()}:${randomBytes(6).toString('hex')}`;
      // Omitted channels: what a P1 runtime's note always got (in-app, banner, ping).
      const r = deps.notify({ title, body: text, channels: noteChannels(n.data.channels), dedupe });
      if (r.status === 'refused') return send(res, 422, { error: 'not a notification Flint shows (a raw payload?)' });
      return send(res, 200, NotifyResponse.parse({ ok: true, stored: r.status === 'stored', pinged: r.pinged }));
    }
    if (url === '/internal/load') return send(res, 200, LoadResponse.parse({ chatInFlight: Math.max(0, Math.trunc(deps.chatInFlight())) }));
    if (url === '/internal/complete') {
      const r = await deps.complete(b);
      return send(res, r.status, r.body);
    }
    if (url === '/internal/spend-external') {
      const vendors = b.vendors;
      if (typeof b.asOf !== 'string' || !vendors || typeof vendors !== 'object') return send(res, 400, { error: 'asOf and vendors required' });
      const clean: ExternalSpend['vendors'] = {};
      for (const [k, v] of Object.entries(vendors as Record<string, unknown>)) {
        const t = v as { dayUsd?: unknown; monthUsd?: unknown; estimate?: unknown };
        if (!/^[a-z0-9_-]{1,40}$/.test(k) || typeof t.dayUsd !== 'number' || typeof t.monthUsd !== 'number' || !(t.dayUsd >= 0) || !(t.monthUsd >= 0)) continue;
        clean[k] = { dayUsd: t.dayUsd, monthUsd: t.monthUsd, ...(t.estimate === true ? { estimate: true } : {}) };
      }
      deps.spendExternal({ asOf: b.asOf.slice(0, 40), vendors: clean });
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: 'not found' });
  };
}

/** Listen on [::1] only. */
export function startInternal(deps: InternalDeps, port = 8081): Server {
  const s = createServer((req, res) => {
    internalHandler(deps)(req, res).catch(() => send(res, 500, { error: 'internal error' }));
  });
  s.listen(port, '::1');
  return s;
}
