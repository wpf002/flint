/**
 * Google sign-in for the read-only calendar source (Machine plan P2.5). Flint
 * holds its own OAuth grant, made once by Will at the terminal
 * (`pnpm --filter @flint/runtime google-login`); no other service stands
 * between the runtime and his calendar.
 *
 *  - The client is a "Desktop app" OAuth client Will creates in Google Cloud
 *    and saves as ~/.flint/google/client.json (0600). Google cannot keep a
 *    desktop app's secret secret, so PKCE (S256) is what binds a code to this
 *    login; the secret is still kept out of every message.
 *  - Scopes: calendar.readonly and nothing else. A grant wider than that (a
 *    write scope, any scope not asked for) is refused at login and at every
 *    refresh, so a widened grant is never used.
 *  - The refresh token lives in ~/.flint/google/token.json (0600, in a 0700
 *    directory), written atomically. Both files are re-read at each refresh,
 *    so a new login takes effect without a restart; the access token lives
 *    only in memory.
 *  - The login waits for one redirect on 127.0.0.1 (a random port, a random
 *    state) and answers the browser without echoing anything it was sent.
 *  - No token, code, verifier or client secret ever reaches an error message
 *    or a log line: messages name files and scopes, never values.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, closeSync, fstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { z } from 'zod';
import type { Endpoint } from '../../policy/egress.js';

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_ORIGIN = 'https://oauth2.googleapis.com';
export const GOOGLE_TOKEN_PATH = '/token';
export const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';
/** Every scope Flint may hold. gmail.metadata joins in a later step; a write scope never does. */
export const ALLOWED_SCOPES: ReadonlySet<string> = new Set([CALENDAR_SCOPE]);
/** What a login asks for, and what every grant must include. */
export const REQUIRED_SCOPES: readonly string[] = [CALENDAR_SCOPE];
/** The one endpoint sign-in and refresh may reach. */
export const TOKEN_ENDPOINTS: Endpoint[] = [{ origin: GOOGLE_TOKEN_ORIGIN, pathPrefix: GOOGLE_TOKEN_PATH, methods: ['POST'] }];

export const SIGNED_IN_PAGE = 'Flint: Google sign-in finished. You can close this tab.';
const NOT_SIGNED_IN_PAGE = 'Flint: Google sign-in did not finish. See the terminal.';
const LOGIN_COMMAND = '`pnpm --filter @flint/runtime google-login`';
const TOKEN_URL = `${GOOGLE_TOKEN_ORIGIN}${GOOGLE_TOKEN_PATH}`;
/** A cached access token is renewed this long before Google says it expires. */
const EARLY_MS = 60_000;
const MAX_FILE_BYTES = 64 * 1024;

export type GoogleAuthCode = 'revoked' | 'scope' | 'http' | 'config' | 'state' | 'denied' | 'timeout';

/** Every sign-in failure. Its message is safe to log. */
export class GoogleAuthError extends Error {
  readonly code: GoogleAuthCode;
  constructor(code: GoogleAuthCode, message: string) {
    super(message);
    this.name = 'GoogleAuthError';
    this.code = code;
  }
}

/** fetch as policy/egress.ts scopedFetch gives it. */
export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface GoogleClient {
  clientId: string;
  clientSecret: string;
}

/** token.json: the grant, and what it was for. */
export interface TokenFile {
  refreshToken: string;
  scopes: string[];
  obtainedAt: string;
  /** The client it was issued to: a token from another client.json is refused, not sent. */
  clientId: string;
}

// ---- files ------------------------------------------------------------------------------

export const googleDir = (home: string) => join(home, '.flint', 'google');

/** googleDir(home), created if missing and made 0700 either way. */
export function ensureGoogleDir(home: string): string {
  const dir = googleDir(home);
  privateDir(dir);
  return dir;
}

function privateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

/** A file only its owner may read, as text; undefined when absent. Mode and size are checked on the open file. */
function readPrivate(file: string): string | undefined {
  let fd: number;
  try {
    fd = openSync(file, 'r');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new GoogleAuthError('config', `cannot read ${file}`);
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new GoogleAuthError('config', `${file} is not a file`);
    if (st.mode & 0o077) throw new GoogleAuthError('config', `${file} must be readable only by its owner (chmod 600)`);
    if (st.size > MAX_FILE_BYTES) throw new GoogleAuthError('config', `${file} is too large to be what Flint expects`);
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
}

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** Which fields were wrong, by name (zod paths are the schema's keys, never the file's values). */
const badFields = (e: z.ZodError) => [...new Set(e.issues.map((i) => i.path.join('.') || 'its shape'))].slice(0, 5).join(', ');

const printable = (min: number, max: number) => z.string().regex(new RegExp(`^[\\x21-\\x7e]{${min},${max}}$`));
const CLIENT_ID = /^[0-9]{6,30}-[a-z0-9]{8,64}\.apps\.googleusercontent\.com$/;

/** Only the two fields used; the file's own token_uri and redirect_uris are ignored, never followed. */
const ClientJson = z.object({ installed: z.object({ client_id: z.string().regex(CLIENT_ID), client_secret: printable(10, 200) }) });

const TokenJson = z
  .object({
    refreshToken: printable(1, 2048),
    scopes: z.array(z.string().max(200)).min(1).max(20),
    obtainedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
    clientId: z.string().regex(CLIENT_ID),
  })
  .strict();

/** client.json, as Google Cloud's download of a "Desktop app" OAuth client has it. */
export function readClient(dir: string): GoogleClient {
  const file = join(dir, 'client.json');
  const text = readPrivate(file);
  if (text === undefined) throw new GoogleAuthError('config', `no ${file}: save a "Desktop app" OAuth client's JSON from Google Cloud there (chmod 600)`);
  const json = parseJson(text);
  if (json && typeof json === 'object' && 'web' in json && !('installed' in json)) {
    throw new GoogleAuthError('config', `${file} is a "Web application" client: Flint signs in as a "Desktop app" client`);
  }
  const c = ClientJson.safeParse(json);
  if (!c.success) throw new GoogleAuthError('config', `${file} is not a "Desktop app" OAuth client (${badFields(c.error)} missing or malformed)`);
  return { clientId: c.data.installed.client_id, clientSecret: c.data.installed.client_secret };
}

/** token.json, or undefined before the first login. */
export function readToken(dir: string): TokenFile | undefined {
  const file = join(dir, 'token.json');
  const text = readPrivate(file);
  if (text === undefined) return undefined;
  const t = TokenJson.safeParse(parseJson(text));
  if (!t.success) throw new GoogleAuthError('config', `${file} is malformed (${badFields(t.error)}): run ${LOGIN_COMMAND}`);
  return t.data;
}

/** Writes token.json whole or not at all: a 0600 .tmp beside it, then a rename. Returns its path. */
export function writeToken(dir: string, t: TokenFile): string {
  const parsed = TokenJson.safeParse(t);
  if (!parsed.success) throw new GoogleAuthError('config', `refusing to write a malformed token.json (${badFields(parsed.error)})`);
  privateDir(dir);
  const file = join(dir, 'token.json');
  const tmp = `${file}.tmp`;
  // A .tmp a crash left behind may have any mode: start a new one, never write into it.
  rmSync(tmp, { force: true });
  try {
    writeFileSync(tmp, `${JSON.stringify(parsed.data)}\n`, { mode: 0o600, flag: 'wx' });
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  return file;
}

// ---- scopes and the authorization request -----------------------------------------------

/** A scope as a message may show it: Google's own scope URLs by name, anything else unnamed. */
const shown = (s: string) => (/^https:\/\/www\.googleapis\.com\/auth\/[a-z0-9._-]{1,80}$/.test(s) ? s : '(an unrecognised scope)');

/** The granted scopes, sorted, when they are all of REQUIRED_SCOPES and nothing outside ALLOWED_SCOPES. */
export function checkScopes(granted: string | readonly string[]): string[] {
  const list = [...new Set((typeof granted === 'string' ? [granted] : granted).flatMap((s) => s.split(/\s+/)).filter(Boolean))].sort();
  const extra = list.filter((s) => !ALLOWED_SCOPES.has(s));
  if (extra.length) {
    throw new GoogleAuthError(
      'scope',
      `Google granted more than read-only calendar access (${extra.slice(0, 5).map(shown).join(', ')}): remove Flint at myaccount.google.com/permissions, then run ${LOGIN_COMMAND}`,
    );
  }
  const missing = REQUIRED_SCOPES.filter((s) => !list.includes(s));
  if (missing.length) throw new GoogleAuthError('scope', `Google did not grant ${missing.join(', ')}: tick it on the consent screen when you run ${LOGIN_COMMAND}`);
  return list;
}

/** RFC 7636 S256: a 64-character verifier (48 random bytes) and its SHA-256, both base64url. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

/** The consent page's URL. Asking for a scope outside ALLOWED_SCOPES is refused here, before Google sees it. */
export function authUrl(o: { clientId: string; redirectUri: string; challenge: string; state: string; scopes: readonly string[] }): string {
  const refused = o.scopes.filter((s) => !ALLOWED_SCOPES.has(s));
  if (refused.length || o.scopes.length === 0) throw new GoogleAuthError('scope', `Flint asks only for ${[...ALLOWED_SCOPES].join(', ')}`);
  const u = new URL(GOOGLE_AUTH_URL);
  const params: Record<string, string> = {
    client_id: o.clientId,
    redirect_uri: o.redirectUri,
    response_type: 'code',
    scope: o.scopes.join(' '),
    // offline + consent: a refresh token on every login, not only the first.
    access_type: 'offline',
    prompt: 'consent',
    code_challenge: o.challenge,
    code_challenge_method: 'S256',
    state: o.state,
    // No include_granted_scopes: a grant made to this client for anything else is never folded in.
  };
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

// ---- the token endpoint -----------------------------------------------------------------

const TokenReply = z.object({
  access_token: printable(1, 4096),
  expires_in: z.number().int().positive().max(86_400),
  refresh_token: printable(1, 2048).optional(),
  scope: z.string().max(2000).optional(),
});

async function postToken(fetch: Fetch, form: Record<string, string>): Promise<{ status: number; ok: boolean; body: unknown }> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(form).toString(),
  });
  const text = await res.text().catch(() => '');
  return { status: res.status, ok: res.ok, body: text.length <= MAX_FILE_BYTES ? parseJson(text) : undefined };
}

/** Google's OAuth error code (`invalid_grant`), when it is one; never its free-text description. */
const oauthError = (body: unknown): string | undefined => {
  const e = (body as { error?: unknown } | null | undefined)?.error;
  return typeof e === 'string' && /^[a-z_]{1,40}$/.test(e) ? e : undefined;
};

const httpError = (status: number, body: unknown) => {
  const e = oauthError(body);
  return new GoogleAuthError('http', `Google's token endpoint answered ${status}${e ? ` (${e})` : ''}`);
};
const unexpectedReply = () => new GoogleAuthError('http', "Google's token endpoint sent a reply Flint does not understand");

/** Trades the redirect's code for a grant. The access token in the reply is dropped: the runtime refreshes its own. */
export async function exchangeCode(fetch: Fetch, client: GoogleClient, o: { code: string; verifier: string; redirectUri: string }, now: Date): Promise<TokenFile> {
  const r = await postToken(fetch, {
    grant_type: 'authorization_code',
    code: o.code,
    code_verifier: o.verifier,
    client_id: client.clientId,
    client_secret: client.clientSecret,
    redirect_uri: o.redirectUri,
  });
  if (!r.ok) throw httpError(r.status, r.body);
  const reply = TokenReply.safeParse(r.body);
  if (!reply.success) throw unexpectedReply();
  if (!reply.data.refresh_token) {
    throw new GoogleAuthError('config', 'Google returned no refresh token: remove Flint at myaccount.google.com/permissions, then run google-login again');
  }
  return { refreshToken: reply.data.refresh_token, scopes: checkScopes(reply.data.scope ?? ''), obtainedAt: now.toISOString(), clientId: client.clientId };
}

export interface GoogleAuth {
  /** A live access token: the cached one until a minute before it expires, else a fresh one. */
  accessToken(fetch: Fetch, now: Date): Promise<string>;
  /** When Will signed in and what he granted (never a token); undefined before the first login. */
  info(): { obtainedAt: string; scopes: string[] } | undefined;
}

export function createGoogleAuth(o: { dir: string }): GoogleAuth {
  let cached: { token: string; expiresAt: number } | undefined;
  // Callers that miss the cache together share one refresh.
  let refreshing: Promise<string> | undefined;

  const refresh = async (fetch: Fetch, now: Date): Promise<string> => {
    const token = readToken(o.dir);
    if (!token) throw new GoogleAuthError('config', `no Google sign-in yet: run ${LOGIN_COMMAND}`);
    const client = readClient(o.dir);
    if (client.clientId !== token.clientId) throw new GoogleAuthError('config', `token.json was issued to a different OAuth client than client.json holds: run ${LOGIN_COMMAND}`);
    const r = await postToken(fetch, { grant_type: 'refresh_token', refresh_token: token.refreshToken, client_id: client.clientId, client_secret: client.clientSecret });
    if (!r.ok) {
      if ((r.status === 400 || r.status === 401) && oauthError(r.body) === 'invalid_grant') {
        throw new GoogleAuthError('revoked', `the Google grant was revoked or has expired (an app left in Testing mode loses it after 7 days): run ${LOGIN_COMMAND}`);
      }
      throw httpError(r.status, r.body);
    }
    const reply = TokenReply.safeParse(r.body);
    if (!reply.success) throw unexpectedReply();
    // Google may leave scope out of a refresh; when it names one, it must still be read-only.
    if (reply.data.scope !== undefined) checkScopes(reply.data.scope);
    cached = { token: reply.data.access_token, expiresAt: now.getTime() + reply.data.expires_in * 1000 };
    return cached.token;
  };

  return {
    async accessToken(fetch, now) {
      if (cached && now.getTime() < cached.expiresAt - EARLY_MS) return cached.token;
      cached = undefined;
      refreshing ??= refresh(fetch, now).finally(() => {
        refreshing = undefined;
      });
      return refreshing;
    },
    info() {
      const t = readToken(o.dir);
      return t ? { obtainedAt: t.obtainedAt, scopes: [...t.scopes] } : undefined;
    },
  };
}

// ---- the one-time login -----------------------------------------------------------------

export interface LoginOptions {
  home: string;
  fetch: Fetch;
  /** Shows the consent page in Will's browser. If it fails, the logged link still works. */
  open: (url: string) => Promise<void> | void;
  log: (line: string) => void;
  timeoutMs?: number;
  /** For tests. */
  now?: () => Date;
}

/** Equal, in constant time. Compared as bytes: a multibyte string of the right length must not throw. */
const sameSecret = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** Answers the browser; settles once the answer is sent or the browser has gone (a closed tab never hangs the login). */
function answer(res: ServerResponse, status: number, text: string): Promise<void> {
  return new Promise((resolve) => {
    if (res.destroyed || !res.socket || res.socket.destroyed) return resolve();
    res.once('close', () => resolve());
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', connection: 'close' });
    res.end(text, () => resolve());
  });
}

type Redirect = { ignore: true } | { fail: GoogleAuthError; status: number } | { code: string };

/** What one request to the listener is. Only a GET of / that carries a state is the redirect; anything else is ignored. */
function readRedirect(req: IncomingMessage, host: string, state: string): Redirect {
  const u = new URL(req.url ?? '/', `http://${host}`);
  const states = u.searchParams.getAll('state');
  // The Host check keeps a page that rebinds its own name to 127.0.0.1 from talking to the listener.
  if (req.method !== 'GET' || req.headers.host !== host || u.pathname !== '/' || states.length === 0) return { ignore: true };
  if (states.length !== 1 || !sameSecret(states[0]!, state)) {
    return { fail: new GoogleAuthError('state', `the redirect did not carry this login's state: run ${LOGIN_COMMAND} again`), status: 400 };
  }
  const error = u.searchParams.get('error');
  if (error !== null) {
    return { fail: new GoogleAuthError('denied', `Google sign-in was not completed${/^[a-z_]{1,40}$/.test(error) ? ` (${error})` : ''}: run ${LOGIN_COMMAND} again`), status: 200 };
  }
  const codes = u.searchParams.getAll('code');
  if (codes.length !== 1 || !/^[\x21-\x7e]{1,2048}$/.test(codes[0]!)) {
    return { fail: new GoogleAuthError('denied', `Google's redirect carried no usable code: run ${LOGIN_COMMAND} again`), status: 400 };
  }
  return { code: codes[0]! };
}

/**
 * The one-time sign-in: opens Google's consent page, takes the one redirect
 * back to 127.0.0.1, trades its code (with the PKCE verifier) for a grant of
 * calendar.readonly only, and writes token.json. The browser is told it
 * finished only once the token is on disk. The listener is always closed.
 */
export async function googleLogin(o: LoginOptions): Promise<{ file: string; scopes: string[] }> {
  const timeoutMs = o.timeoutMs ?? 300_000;
  const dir = ensureGoogleDir(o.home);
  const client = readClient(dir);
  const { verifier, challenge } = pkcePair();
  const state = randomBytes(16).toString('hex');
  const server = createServer();
  let timer: NodeJS.Timeout | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    const host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
    const redirectUri = `http://${host}`;
    const url = authUrl({ clientId: client.clientId, redirectUri, challenge, state, scopes: REQUIRED_SCOPES });

    const redirect = new Promise<{ code: string; res: ServerResponse }>((resolve, reject) => {
      let done = false;
      timer = setTimeout(() => {
        done = true;
        reject(new GoogleAuthError('timeout', `no sign-in within ${Math.round(timeoutMs / 1000)}s: run ${LOGIN_COMMAND} again`));
      }, timeoutMs);
      server.on('request', (req: IncomingMessage, res: ServerResponse) => {
        let r: Redirect;
        try {
          r = done ? { ignore: true } : readRedirect(req, host, state);
        } catch {
          // A request the URL parser cannot read (`GET http://[`) is not the redirect; it never ends the login.
          r = { ignore: true };
        }
        if ('ignore' in r) return void answer(res, 404, 'not found');
        done = true;
        clearTimeout(timer);
        // The browser gets its answer before the login fails, so the tab is not left waiting.
        if ('fail' in r) return void answer(res, r.status, NOT_SIGNED_IN_PAGE).then(() => reject(r.fail));
        resolve({ code: r.code, res });
      });
    });

    o.log(`Sign in to Google in the browser tab that opens. If none does, open this link:\n\n  ${url}\n`);
    // A browser that fails to open is not a failed login: the link above still works.
    Promise.resolve()
      .then(() => o.open(url))
      .catch(() => o.log('Could not open a browser; open the link above by hand.'));

    const { code, res } = await redirect;
    let token: TokenFile;
    let file: string;
    try {
      token = await exchangeCode(o.fetch, client, { code, verifier, redirectUri }, o.now?.() ?? new Date());
      file = writeToken(dir, token);
    } catch (err) {
      await answer(res, 500, NOT_SIGNED_IN_PAGE);
      throw err;
    }
    await answer(res, 200, SIGNED_IN_PAGE);
    o.log(`Signed in. Granted: ${token.scopes.join(' ')}`);
    o.log(`The refresh token is in ${file} (0600); the access token is never written down.`);
    return { file, scopes: token.scopes };
  } finally {
    clearTimeout(timer);
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
}
