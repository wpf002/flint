/**
 * Google sign-in (P2.5): PKCE and the consent URL; scopes held to
 * calendar.readonly at login and at every refresh; client.json and token.json
 * refused when anyone but Will could read them, token.json written whole;
 * the access token cached until a minute before expiry, a revoked grant named
 * as such; the loopback login end to end (wrong state, a denial, a stray
 * favicon request, a timeout). No secret value ever appears in a message or
 * a log line. No network: fetch is a fake, the browser is http.get.
 */
import { connect } from 'node:net';
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { get } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ALLOWED_SCOPES,
  CALENDAR_SCOPE,
  GOOGLE_AUTH_URL,
  GOOGLE_TOKEN_ORIGIN,
  GoogleAuthError,
  REQUIRED_SCOPES,
  SIGNED_IN_PAGE,
  TOKEN_ENDPOINTS,
  authUrl,
  checkScopes,
  createGoogleAuth,
  ensureGoogleDir,
  exchangeCode,
  googleDir,
  googleLogin,
  pkcePair,
  readClient,
  readToken,
  writeToken,
  type TokenFile,
} from '../../src/sources/google/oauth';
import { allowed } from '../../src/policy/egress';

const CLIENT_ID = '123456789012-abcdefgh12345678.apps.googleusercontent.com';
const SECRET = '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K';
const REFRESH = '1//refresh-token-SHOULD-NOT-LEAK';
const ACCESS = 'ya29.access-token-SHOULD-NOT-LEAK';
const CODE = '4/auth-code-SHOULD-NOT-LEAK';
const SECRETS = [SECRET, REFRESH, ACCESS, CODE, 'SHOULD-NOT-LEAK'];
const NOW = new Date('2026-10-04T12:00:00.000Z');
const at = (ms: number) => new Date(NOW.getTime() + ms);
const TOKEN_URL = `${GOOGLE_TOKEN_ORIGIN}/token`;

/** A temp HOME with ~/.flint/google made (0700). */
function tempHome(): { home: string; dir: string } {
  const home = mkdtempSync(join(tmpdir(), 'flint-google-'));
  return { home, dir: ensureGoogleDir(home) };
}

function writeMode(file: string, body: string, mode: number): void {
  writeFileSync(file, body, { mode });
  chmodSync(file, mode);
}

const desktopClient = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ installed: { client_id: CLIENT_ID, project_id: 'flint-123', auth_uri: 'https://accounts.google.com/o/oauth2/auth', token_uri: 'https://evil.example/token', client_secret: SECRET, redirect_uris: ['http://localhost'], ...over } });

const saveClient = (dir: string, body = desktopClient(), mode = 0o600) => writeMode(join(dir, 'client.json'), body, mode);

const token = (over: Partial<TokenFile> = {}): TokenFile => ({ refreshToken: REFRESH, scopes: [CALENDAR_SCOPE], obtainedAt: NOW.toISOString(), clientId: CLIENT_ID, ...over });

const mode = (p: string) => statSync(p).mode & 0o777;

/** Whatever was thrown (sync or async), checked to carry no secret. */
async function caught(f: () => unknown): Promise<GoogleAuthError> {
  try {
    await f();
  } catch (err) {
    const e = err as GoogleAuthError;
    for (const s of SECRETS) expect(`${e.message}\n${e.stack ?? ''}`).not.toContain(s);
    return e;
  }
  throw new Error('expected a throw');
}

/** A fake token endpoint: replies in order (the last repeats), every call recorded. */
function fakeGoogle(...replies: Array<{ status?: number; body: unknown }>) {
  const calls: Array<{ url: string; method: string; contentType: string; form: URLSearchParams }> = [];
  const fetch = async (url: string, init: RequestInit = {}) => {
    calls.push({ url, method: init.method ?? 'GET', contentType: String((init.headers as Record<string, string>)['content-type']), form: new URLSearchParams(String(init.body ?? '')) });
    const r = replies[Math.min(calls.length - 1, replies.length - 1)]!;
    return Response.json(r.body, { status: r.status ?? 200 });
  };
  return { fetch, calls };
}

const refreshed = (over: Record<string, unknown> = {}) => ({ body: { access_token: ACCESS, expires_in: 3599, scope: CALENDAR_SCOPE, token_type: 'Bearer', ...over } });

describe('constants and PKCE', () => {
  it('holds calendar.readonly and nothing else; the egress list allows only a POST to the token endpoint', () => {
    expect([...ALLOWED_SCOPES]).toEqual([CALENDAR_SCOPE]);
    expect(REQUIRED_SCOPES).toEqual([CALENDAR_SCOPE]);
    expect(allowed(TOKEN_ENDPOINTS, TOKEN_URL, 'POST')).toBe(true);
    expect(allowed(TOKEN_ENDPOINTS, TOKEN_URL, 'GET')).toBe(false);
    expect(allowed(TOKEN_ENDPOINTS, 'https://www.googleapis.com/calendar/v3/users/me/calendarList', 'POST')).toBe(false);
    expect(allowed(TOKEN_ENDPOINTS, 'https://oauth2.googleapis.com/revoke', 'POST')).toBe(false);
  });

  it('a 64-character base64url verifier whose S256 hash is the challenge, fresh every time', () => {
    const a = pkcePair();
    const b = pkcePair();
    expect(a.verifier).toMatch(/^[A-Za-z0-9_-]{64}$/);
    expect(a.challenge).toBe(createHash('sha256').update(a.verifier).digest('base64url'));
    expect(a.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(b.verifier).not.toBe(a.verifier);
  });

  it('the consent URL asks for offline access with a fresh consent, S256, and no granted-scope merging', () => {
    const u = new URL(authUrl({ clientId: CLIENT_ID, redirectUri: 'http://127.0.0.1:5555', challenge: 'c'.repeat(43), state: 's'.repeat(32), scopes: REQUIRED_SCOPES }));
    expect(`${u.origin}${u.pathname}`).toBe(GOOGLE_AUTH_URL);
    expect(Object.fromEntries(u.searchParams)).toEqual({
      client_id: CLIENT_ID,
      redirect_uri: 'http://127.0.0.1:5555',
      response_type: 'code',
      scope: CALENDAR_SCOPE,
      access_type: 'offline',
      prompt: 'consent',
      code_challenge: 'c'.repeat(43),
      code_challenge_method: 'S256',
      state: 's'.repeat(32),
    });
    expect(u.searchParams.has('include_granted_scopes')).toBe(false);
  });

  it('refuses to ask Google for a scope outside the allowed set', async () => {
    const o = { clientId: CLIENT_ID, redirectUri: 'http://127.0.0.1:1', challenge: 'c', state: 's' };
    expect((await caught(() => authUrl({ ...o, scopes: [CALENDAR_SCOPE, 'https://www.googleapis.com/auth/calendar'] }))).code).toBe('scope');
    expect((await caught(() => authUrl({ ...o, scopes: [] }))).code).toBe('scope');
  });
});

describe('checkScopes', () => {
  it('accepts calendar.readonly as a space-separated string or a list, sorted and deduplicated', () => {
    expect(checkScopes(CALENDAR_SCOPE)).toEqual([CALENDAR_SCOPE]);
    expect(checkScopes(`  ${CALENDAR_SCOPE}  ${CALENDAR_SCOPE} `)).toEqual([CALENDAR_SCOPE]);
    expect(checkScopes([CALENDAR_SCOPE])).toEqual([CALENDAR_SCOPE]);
  });

  it.each([
    ['full calendar (write)', `${CALENDAR_SCOPE} https://www.googleapis.com/auth/calendar`],
    ['calendar.events (write)', `${CALENDAR_SCOPE} https://www.googleapis.com/auth/calendar.events`],
    ['gmail.send', `${CALENDAR_SCOPE} https://www.googleapis.com/auth/gmail.send`],
    ['gmail.metadata (not yet)', `${CALENDAR_SCOPE} https://www.googleapis.com/auth/gmail.metadata`],
    ['an extra unrequested scope', `openid ${CALENDAR_SCOPE} email`],
    ['missing the required scope', 'https://www.googleapis.com/auth/calendar'],
    ['empty', ''],
    ['an empty list', []],
  ])('refuses %s', async (_, granted) => {
    const e = await caught(() => checkScopes(granted as string | string[]));
    expect(e).toBeInstanceOf(GoogleAuthError);
    expect(e.code).toBe('scope');
  });

  it('names a refused Google scope, but never echoes text that is not one', async () => {
    expect((await caught(() => checkScopes(`${CALENDAR_SCOPE} https://www.googleapis.com/auth/calendar.events`))).message).toContain('calendar.events');
    const e = await caught(() => checkScopes(`${CALENDAR_SCOPE} ${REFRESH}`));
    expect(e.message).toContain('unrecognised scope');
  });
});

describe('client.json', () => {
  it('reads a Desktop app client, using only its id and secret', () => {
    const { dir } = tempHome();
    saveClient(dir);
    expect(readClient(dir)).toEqual({ clientId: CLIENT_ID, clientSecret: SECRET });
  });

  it('the directory is ~/.flint/google, 0700 even when it existed looser', () => {
    const { home, dir } = tempHome();
    expect(dir).toBe(join(home, '.flint', 'google'));
    expect(googleDir(home)).toBe(dir);
    expect(mode(dir)).toBe(0o700);
    chmodSync(dir, 0o755);
    ensureGoogleDir(home);
    expect(mode(dir)).toBe(0o700);
  });

  it('refuses a file anyone but Will can read, naming chmod 600', async () => {
    const { dir } = tempHome();
    saveClient(dir, desktopClient(), 0o644);
    const e = await caught(() => readClient(dir));
    expect(e.code).toBe('config');
    expect(e.message).toContain('chmod 600');
    expect(e.message).toContain(join(dir, 'client.json'));
  });

  it.each([
    ['not JSON', '{"installed": '],
    ['a malformed client id', desktopClient({ client_id: 'not-a-client-id' })],
    ['a short secret', desktopClient({ client_secret: 'GOCSPX-x' })],
    ['a secret with spaces', desktopClient({ client_secret: 'GOCSPX SHOULD-NOT-LEAK' })],
    ['no secret', JSON.stringify({ installed: { client_id: CLIENT_ID } })],
  ])('refuses %s, naming the file and never the values', async (_, body) => {
    const { dir } = tempHome();
    saveClient(dir, body);
    const e = await caught(() => readClient(dir));
    expect(e.code).toBe('config');
    expect(e.message).toContain('client.json');
    expect(e.message).not.toContain(CLIENT_ID);
  });

  it('says so when the client is a Web client, or missing', async () => {
    const { dir } = tempHome();
    expect((await caught(() => readClient(dir))).message).toMatch(/^no .*client\.json/);
    saveClient(dir, JSON.stringify({ web: { client_id: CLIENT_ID, client_secret: SECRET } }));
    expect((await caught(() => readClient(dir))).message).toContain('Web application');
  });
});

describe('token.json', () => {
  it('is written 0600 in a 0700 directory, whole, with no .tmp left behind', () => {
    const { home } = tempHome();
    const dir = googleDir(home);
    const file = writeToken(dir, token());
    expect(file).toBe(join(dir, 'token.json'));
    expect(mode(file)).toBe(0o600);
    expect(mode(dir)).toBe(0o700);
    expect(readdirSync(dir)).toEqual(['token.json']);
    expect(readToken(dir)).toEqual(token());
  });

  it('replaces an older token, and never writes into a world-readable .tmp a crash left', () => {
    const { dir } = tempHome();
    writeToken(dir, token({ refreshToken: '1//old' }));
    writeMode(join(dir, 'token.json.tmp'), 'stale', 0o644);
    writeToken(dir, token());
    expect(readToken(dir)?.refreshToken).toBe(REFRESH);
    expect(mode(join(dir, 'token.json'))).toBe(0o600);
    expect(existsSync(join(dir, 'token.json.tmp'))).toBe(false);
  });

  it('refuses to write a malformed token, and writes nothing', async () => {
    const { dir } = tempHome();
    expect((await caught(() => writeToken(dir, token({ scopes: [] })))).code).toBe('config');
    expect(readdirSync(dir)).toEqual([]);
  });

  it('is undefined before the first login; refused when readable by others or malformed', async () => {
    const { dir } = tempHome();
    expect(readToken(dir)).toBeUndefined();
    const file = writeToken(dir, token());
    chmodSync(file, 0o644);
    const e = await caught(() => readToken(dir));
    expect(e.code).toBe('config');
    expect(e.message).toContain('chmod 600');
    writeMode(file, JSON.stringify({ ...token(), extra: 1 }), 0o600);
    expect((await caught(() => readToken(dir))).code).toBe('config');
    writeMode(file, JSON.stringify({ ...token(), obtainedAt: 'yesterday' }), 0o600);
    expect((await caught(() => readToken(dir))).message).toContain('obtainedAt');
  });
});

describe('exchangeCode', () => {
  const client = { clientId: CLIENT_ID, clientSecret: SECRET };
  const args = { code: CODE, verifier: 'v'.repeat(64), redirectUri: 'http://127.0.0.1:5555' };

  it('posts the code, verifier and client as a form, and keeps the refresh token and scopes', async () => {
    const g = fakeGoogle(refreshed({ refresh_token: REFRESH }));
    expect(await exchangeCode(g.fetch, client, args, NOW)).toEqual(token());
    expect(g.calls).toHaveLength(1);
    expect(g.calls[0]).toMatchObject({ url: TOKEN_URL, method: 'POST', contentType: 'application/x-www-form-urlencoded' });
    expect(Object.fromEntries(g.calls[0]!.form)).toEqual({
      grant_type: 'authorization_code', code: CODE, code_verifier: args.verifier, client_id: CLIENT_ID, client_secret: SECRET, redirect_uri: args.redirectUri,
    });
  });

  it('refuses a reply with no refresh token, or a wider grant', async () => {
    const none = await caught(() => exchangeCode(fakeGoogle(refreshed()).fetch, client, args, NOW));
    expect(none.code).toBe('config');
    expect(none.message).toContain('myaccount.google.com/permissions');
    const wide = await caught(() => exchangeCode(fakeGoogle(refreshed({ refresh_token: REFRESH, scope: `${CALENDAR_SCOPE} https://www.googleapis.com/auth/calendar` })).fetch, client, args, NOW));
    expect(wide.code).toBe('scope');
  });

  it('a refusal names the status and the OAuth error code, never its description', async () => {
    const e = await caught(() => exchangeCode(fakeGoogle({ status: 400, body: { error: 'invalid_grant', error_description: `code ${CODE} was already used` } }).fetch, client, args, NOW));
    expect(e.code).toBe('http');
    expect(e.message).toBe("Google's token endpoint answered 400 (invalid_grant)");
  });
});

describe('createGoogleAuth', () => {
  function signedIn() {
    const { dir } = tempHome();
    saveClient(dir);
    writeToken(dir, token());
    return dir;
  }

  it('refreshes with the stored grant, then serves the cached token (one fetch for two calls)', async () => {
    const auth = createGoogleAuth({ dir: signedIn() });
    const g = fakeGoogle(refreshed());
    expect(await auth.accessToken(g.fetch, NOW)).toBe(ACCESS);
    expect(await auth.accessToken(g.fetch, at(60_000))).toBe(ACCESS);
    expect(g.calls).toHaveLength(1);
    expect(g.calls[0]).toMatchObject({ url: TOKEN_URL, method: 'POST', contentType: 'application/x-www-form-urlencoded' });
    expect(Object.fromEntries(g.calls[0]!.form)).toEqual({ grant_type: 'refresh_token', refresh_token: REFRESH, client_id: CLIENT_ID, client_secret: SECRET });
  });

  it('callers that miss the cache together share one refresh', async () => {
    const auth = createGoogleAuth({ dir: signedIn() });
    const g = fakeGoogle(refreshed());
    expect(await Promise.all([auth.accessToken(g.fetch, NOW), auth.accessToken(g.fetch, NOW)])).toEqual([ACCESS, ACCESS]);
    expect(g.calls).toHaveLength(1);
  });

  it('refreshes again a minute before expiry', async () => {
    const auth = createGoogleAuth({ dir: signedIn() });
    const g = fakeGoogle(refreshed(), refreshed({ access_token: 'ya29.second' }));
    await auth.accessToken(g.fetch, NOW);
    expect(await auth.accessToken(g.fetch, at(3599_000 - 61_000))).toBe(ACCESS);
    expect(g.calls).toHaveLength(1);
    expect(await auth.accessToken(g.fetch, at(3599_000 - 60_000))).toBe('ya29.second');
    expect(g.calls).toHaveLength(2);
  });

  it('invalid_grant (400 or 401) is a revoked grant; a new login takes effect without a restart', async () => {
    const dir = signedIn();
    const auth = createGoogleAuth({ dir });
    for (const status of [400, 401]) {
      const e = await caught(() => auth.accessToken(fakeGoogle({ status, body: { error: 'invalid_grant', error_description: `Token ${REFRESH} has been expired or revoked.` } }).fetch, NOW));
      expect(e.code).toBe('revoked');
      expect(e.message).toContain('pnpm --filter @flint/runtime google-login');
      expect(e.message).toContain('7 days');
    }
    writeToken(dir, token({ refreshToken: '1//after-relogin' }));
    const g = fakeGoogle(refreshed());
    expect(await auth.accessToken(g.fetch, NOW)).toBe(ACCESS);
    expect(g.calls[0]!.form.get('refresh_token')).toBe('1//after-relogin');
  });

  it('any other refusal is an http error with its status; a garbled reply too', async () => {
    const auth = createGoogleAuth({ dir: signedIn() });
    const e500 = await caught(() => auth.accessToken(fakeGoogle({ status: 500, body: { error: 'internal_failure' } }).fetch, NOW));
    expect(e500.code).toBe('http');
    expect(e500.message).toContain('500');
    const e401 = await caught(() => auth.accessToken(fakeGoogle({ status: 401, body: { error: 'invalid_client', error_description: SECRET } }).fetch, NOW));
    expect(e401.code).toBe('http');
    expect((await caught(() => auth.accessToken(fakeGoogle({ body: { token_type: 'Bearer', note: ACCESS } }).fetch, NOW))).code).toBe('http');
  });

  it('a refresh whose grant has widened is refused, and nothing is cached', async () => {
    const auth = createGoogleAuth({ dir: signedIn() });
    const g = fakeGoogle(refreshed({ scope: `${CALENDAR_SCOPE} https://www.googleapis.com/auth/calendar.events` }));
    expect((await caught(() => auth.accessToken(g.fetch, NOW))).code).toBe('scope');
    expect((await caught(() => auth.accessToken(g.fetch, NOW))).code).toBe('scope');
    expect(g.calls).toHaveLength(2);
  });

  it('a refresh reply without a scope keeps the grant as it was checked at login', async () => {
    const auth = createGoogleAuth({ dir: signedIn() });
    expect(await auth.accessToken(fakeGoogle(refreshed({ scope: undefined })).fetch, NOW)).toBe(ACCESS);
  });

  it('before any login, or with a token from another client, it says so and sends nothing', async () => {
    const { dir } = tempHome();
    const g = fakeGoogle(refreshed());
    const auth = createGoogleAuth({ dir });
    const none = await caught(() => auth.accessToken(g.fetch, NOW));
    expect(none.code).toBe('config');
    expect(none.message).toMatch(/^no Google sign-in yet: run `pnpm --filter @flint\/runtime google-login`/);
    expect(auth.info()).toBeUndefined();
    saveClient(dir);
    writeToken(dir, token({ clientId: '999999999999-zzzzzzzz99999999.apps.googleusercontent.com' }));
    expect((await caught(() => auth.accessToken(g.fetch, NOW))).code).toBe('config');
    expect(g.calls).toHaveLength(0);
  });

  it('info() says when and what, never the token', () => {
    const auth = createGoogleAuth({ dir: signedIn() });
    const info = auth.info();
    expect(info).toEqual({ obtainedAt: NOW.toISOString(), scopes: [CALENDAR_SCOPE] });
    expect(JSON.stringify(info)).not.toContain(REFRESH);
  });
});

describe('googleLogin', () => {
  type Answer = { status: number; body: string };
  const browserGet = (url: string) =>
    new Promise<Answer>((resolve, reject) => {
      get(url, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      }).on('error', reject);
    });

  /** A fake open(): reads the consent URL and, as Google would, sends the browser to each of `paths` in turn. */
  function browser(paths: (state: string) => string[]) {
    const answers: Array<Promise<Answer>> = [];
    let consent: URL | undefined;
    const open = async (url: string) => {
      consent = new URL(url);
      const back = consent.searchParams.get('redirect_uri')!;
      for (const p of paths(consent.searchParams.get('state')!)) {
        const a = browserGet(`${back}${p}`);
        answers.push(a);
        await a.catch(() => {});
      }
    };
    return { open, answers, consent: () => consent! };
  }

  /** The token endpoint as Google runs it: the code is good once, and only with the verifier behind the challenge. */
  function googleFor(b: { consent: () => URL }, reply: { status?: number; body: unknown } = refreshed({ refresh_token: REFRESH })) {
    const g = fakeGoogle(reply);
    const fetch = async (url: string, init: RequestInit = {}) => {
      const form = new URLSearchParams(String(init.body ?? ''));
      const c = b.consent();
      const verified = createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url') === c.searchParams.get('code_challenge');
      if (!verified || form.get('redirect_uri') !== c.searchParams.get('redirect_uri') || form.get('code') !== CODE) return Response.json({ error: 'invalid_grant' }, { status: 400 });
      return g.fetch(url, init);
    };
    return { fetch, calls: g.calls };
  }

  function setup() {
    const { home, dir } = tempHome();
    saveClient(dir);
    const logs: string[] = [];
    return { home, dir, logs, log: (l: string) => void logs.push(l) };
  }

  it('signs in end to end: the redirect is answered without echoing it, the token is written, the listener closed', async () => {
    const s = setup();
    const b = browser((state) => [`/?state=${state}&code=${encodeURIComponent(CODE)}&scope=${encodeURIComponent(CALENDAR_SCOPE)}`]);
    const g = googleFor(b);
    const r = await googleLogin({ home: s.home, fetch: g.fetch, open: b.open, log: s.log, now: () => NOW });
    expect(r).toEqual({ file: join(s.dir, 'token.json'), scopes: [CALENDAR_SCOPE] });
    expect(readToken(s.dir)).toEqual(token());
    expect(mode(r.file)).toBe(0o600);
    expect(g.calls).toHaveLength(1);

    const answer = await b.answers[0]!;
    expect(answer).toEqual({ status: 200, body: SIGNED_IN_PAGE });

    const redirect = b.consent().searchParams.get('redirect_uri')!;
    expect(redirect).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(b.consent().searchParams.get('state')).toMatch(/^[0-9a-f]{32}$/);
    // The link is logged for pasting; the grant itself never is.
    const out = s.logs.join('\n');
    expect(out).toContain(b.consent().toString());
    expect(out).toContain(CALENDAR_SCOPE);
    expect(out).toContain(r.file);
    for (const x of [...SECRETS, g.calls[0]!.form.get('code_verifier')!]) expect(out).not.toContain(x);
    await expect(browserGet(redirect)).rejects.toThrow(/ECONNREFUSED/);
  });

  it('a stray request first (a favicon) is answered 404 and the login keeps waiting', async () => {
    const s = setup();
    const b = browser((state) => ['/favicon.ico', `/?code=${encodeURIComponent(CODE)}`, `/?state=${state}&code=${encodeURIComponent(CODE)}`]);
    const r = await googleLogin({ home: s.home, fetch: googleFor(b).fetch, open: b.open, log: s.log, now: () => NOW });
    expect(r.scopes).toEqual([CALENDAR_SCOPE]);
    expect((await b.answers[0]!).status).toBe(404);
    expect((await b.answers[1]!).status).toBe(404);
    expect(await b.answers[2]!).toEqual({ status: 200, body: SIGNED_IN_PAGE });
  });

  it('a request the URL parser cannot read is ignored, never a crash; a multibyte state is the wrong state, not a throw', async () => {
    const s = setup();
    const b = browser((state) => [`/?state=${state}&code=${encodeURIComponent(CODE)}`]);
    const g = googleFor(b);
    // First a raw `GET http://[`, with the right Host header, straight to the listener; then the real redirect.
    const open = async (url: string) => {
      const back = new URL(new URL(url).searchParams.get('redirect_uri')!);
      const raw = await new Promise<string>((resolve) => {
        const sock = connect(Number(back.port), '127.0.0.1', () => sock.write(`GET http://[ HTTP/1.1\r\nHost: ${back.host}\r\nConnection: close\r\n\r\n`));
        let got = '';
        sock.on('data', (c) => (got += String(c)));
        sock.on('close', () => resolve(got));
        sock.on('error', () => resolve(got));
      });
      expect(raw).toMatch(/^HTTP\/1\.1 404/);
      await b.open(url);
    };
    expect((await googleLogin({ home: s.home, fetch: g.fetch, open, log: s.log, now: () => NOW })).scopes).toEqual([CALENDAR_SCOPE]);

    const t = setup();
    const m = browser(() => [`/?state=${'%C3%A9'.repeat(32)}&code=${encodeURIComponent(CODE)}`]);
    const e = await caught(() => googleLogin({ home: t.home, fetch: googleFor(m).fetch, open: m.open, log: t.log }));
    expect(e.code).toBe('state');
    expect((await m.answers[0]!).status).toBe(400);
  });

  it('the wrong state fails the login with a 400, and nothing is exchanged or written', async () => {
    const s = setup();
    const b = browser(() => [`/?state=${'0'.repeat(32)}&code=${encodeURIComponent(CODE)}`]);
    const g = googleFor(b);
    const e = await caught(() => googleLogin({ home: s.home, fetch: g.fetch, open: b.open, log: s.log }));
    expect(e.code).toBe('state');
    const answer = await b.answers[0]!;
    expect(answer.status).toBe(400);
    expect(answer.body).not.toContain(CODE);
    expect(g.calls).toHaveLength(0);
    expect(existsSync(join(s.dir, 'token.json'))).toBe(false);
  });

  it('a denial on the consent screen fails the login as denied', async () => {
    const s = setup();
    const b = browser((state) => [`/?error=access_denied&state=${state}`]);
    const g = googleFor(b);
    const e = await caught(() => googleLogin({ home: s.home, fetch: g.fetch, open: b.open, log: s.log }));
    expect(e.code).toBe('denied');
    expect(e.message).toContain('access_denied');
    expect((await b.answers[0]!).body).not.toContain('access_denied');
    expect(g.calls).toHaveLength(0);
    expect(existsSync(join(s.dir, 'token.json'))).toBe(false);
  });

  it('a failed exchange tells the browser it did not finish, and writes nothing', async () => {
    const s = setup();
    const b = browser((state) => [`/?state=${state}&code=${encodeURIComponent(CODE)}`]);
    const e = await caught(() => googleLogin({ home: s.home, fetch: googleFor(b, refreshed()).fetch, open: b.open, log: s.log }));
    expect(e.code).toBe('config');
    expect((await b.answers[0]!).status).toBe(500);
    expect(existsSync(join(s.dir, 'token.json'))).toBe(false);
  });

  it('no redirect in time is a timeout; a browser that cannot open still leaves the link in the log', async () => {
    const s = setup();
    let link = '';
    const e = await caught(() =>
      googleLogin({ home: s.home, fetch: fakeGoogle(refreshed()).fetch, open: (url) => {
        link = url;
        throw new Error('no browser');
      }, log: s.log, timeoutMs: 100 }),
    );
    expect(e.code).toBe('timeout');
    expect(s.logs.join('\n')).toContain(link);
    expect(s.logs.join('\n')).toContain('Could not open a browser');
    await expect(browserGet(new URL(link).searchParams.get('redirect_uri')!)).rejects.toThrow(/ECONNREFUSED/);
  });

  it('refuses to start without a usable client.json', async () => {
    const { home } = tempHome();
    let opened = false;
    const e = await caught(() => googleLogin({ home, fetch: fakeGoogle(refreshed()).fetch, open: () => void (opened = true), log: () => {} }));
    expect(e.code).toBe('config');
    expect(opened).toBe(false);
  });
});
