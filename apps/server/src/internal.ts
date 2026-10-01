/**
 * The server's internal listener (Machine plan 3.0.1): [::1]:8081, never in
 * `tailscale serve`, for the runtime's calls back into the server. The runtime
 * holds SERVER_INTERNAL_TOKEN; the server keeps only its sha256 (the token file
 * is written by install-runtime.sh as ~/.flint/tokens/internal.token, and its
 * digest read here at startup). Routes:
 *   POST /internal/notify          {title, body}            a notification for Will: redacted, kept in
 *                                                           the console; the phone only gets a ping
 *   POST /internal/spend-external  {asOf, vendors: {...}}   unified spend totals (plan 3.0.8), for the
 *                                                           background stop rule
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { redactString } from '@flint/policy';

export interface InternalDeps {
  /** sha256 hex of the runtime's token; undefined = the listener refuses everything. */
  tokenSha256: () => string | undefined;
  /** Stored ('stored'), already there ('duplicate'), or not storable ('refused'). */
  notify: (title: string, body: string) => 'stored' | 'duplicate' | 'refused';
  spendExternal: (totals: ExternalSpend) => void;
}

export interface ExternalSpend {
  asOf: string;
  vendors: Record<string, { dayUsd: number; monthUsd: number; estimate?: boolean }>;
}

const MAX = 16 * 1024;

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

export function internalHandler(deps: InternalDeps) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!authorized(req, deps.tokenSha256())) return send(res, 401, { error: 'unauthorized' });
    if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
    let b: Record<string, unknown>;
    try {
      b = (await body(req)) as Record<string, unknown>;
    } catch {
      return send(res, 400, { error: 'bad body' });
    }
    const url = (req.url ?? '').split('?')[0];
    if (url === '/internal/notify') {
      const title = typeof b.title === 'string' ? redactString(b.title).slice(0, 80) : '';
      const text = typeof b.body === 'string' ? redactString(b.body).slice(0, 500) : '';
      if (!title) return send(res, 400, { error: 'title required' });
      const r = deps.notify(title, text);
      if (r === 'refused') return send(res, 422, { error: 'not a notification Flint shows (a raw payload?)' });
      return send(res, 200, { ok: true, stored: r === 'stored' });
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
