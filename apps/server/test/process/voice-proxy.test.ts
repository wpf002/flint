/**
 * Where a request for this Mac's own address REALLY goes, under a real Node
 * with its env proxy on, for each spelling of the no-proxy list
 * (../no-proxy-spellings): and that Flint takes a local speech server at that
 * address exactly when Node reaches it directly.
 *
 * The voice review found six spellings that the rule read as "direct" while
 * Node sent the request to the proxy. A speech server at 127.0.0.1 was then
 * accepted as "on this Mac", and a reply that stays here, and the speech
 * server's key, went to the proxy. The rule is @flint/policy's now, one copy
 * for the model server and for speech. This test does not take that rule's
 * word, or the table's: for each spelling it starts a Node of its own
 * (./voice-proxy-child.ts), with a proxy stand-in and two speech stand-ins on
 * loopback, and reads what arrived where.
 *
 * Nothing leaves this machine: the "proxy" is a server here that records what
 * it is asked to carry and answers itself. No program is run, and no audio.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NO_PROXY_SPELLINGS, REVIEW_SIX } from '../no-proxy-spellings';
import { scratch } from './rig';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, '..', '..');
const VOICE_KEY = 'voice-key-PROXYSECRET-0123456789';
/** Node's env proxy for `fetch` came with Node 24: on an older one the switch does nothing, and there is nothing to see. */
const NODE_HAS_ENV_PROXY = Number(process.versions.node.split('.')[0]) >= 24;

interface Got {
  /** What was asked for: a path at a speech stand-in; at the proxy, the whole of what it was handed. */
  what: string;
  auth: string | undefined;
  body: string;
}
const speechGot: Record<'v4' | 'v6', Got[]> = { v4: [], v6: [] };
const proxyGot: Got[] = [];
const servers: Server[] = [];
/** The tunnels the proxy stand-in was asked for: a server does not close while one is open, so each is ended here. */
const tunnels = new Set<Socket>();
let v4 = '';
let v6 = '';
let proxy = '';
const work = scratch('voice-proxy');

const listen = (s: Server, host: string): Promise<number> => new Promise((resolve) => s.listen(0, host, () => resolve((s.address() as AddressInfo).port)));

/** A speech server on this Mac: it answers the probe, `/v1/audio/speech` and `/v1/audio/transcriptions`, and keeps what it was sent. */
function speechStandIn(family: 'v4' | 'v6'): Server {
  const s = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      speechGot[family].push({ what: `${req.method} ${req.url}`, auth: req.headers.authorization, body: Buffer.concat(chunks).toString('latin1') });
      if (req.url?.startsWith('/probe/')) return void res.end(`direct ${family}`);
      if (req.url === '/v1/audio/speech') {
        res.writeHead(200, { 'content-type': 'audio/mpeg' });
        return void res.end(`spoken on ${family}`);
      }
      if (req.url === '/v1/audio/transcriptions') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return void res.end(JSON.stringify({ text: `heard on ${family}` }));
      }
      res.writeHead(404).end();
    });
  });
  servers.push(s);
  return s;
}

/**
 * What stands in for a proxy: it records whatever it is asked to carry (a
 * request in absolute form, or a tunnel and what comes down it), and answers
 * itself. Nothing is forwarded anywhere.
 */
function proxyStandIn(): Server {
  const s = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      proxyGot.push({ what: `${req.method} ${req.url}`, auth: req.headers.authorization, body: Buffer.concat(chunks).toString('latin1') });
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('from the proxy');
    });
  });
  s.on('connect', (req, socket: Socket) => {
    const entry: Got = { what: `CONNECT ${req.url}`, auth: undefined, body: '' };
    proxyGot.push(entry);
    tunnels.add(socket);
    socket.on('close', () => tunnels.delete(socket));
    let answered = false;
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    socket.on('data', (d: Buffer) => {
      entry.body += d.toString('latin1');
      entry.auth = /authorization: ([^\r]+)/i.exec(entry.body)?.[1];
      if (!answered && entry.body.includes('\r\n\r\n')) {
        answered = true;
        entry.what += ` then ${entry.body.split('\r\n')[0]}`;
        const body = 'from the proxy';
        socket.end(`HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ncontent-length: ${body.length}\r\nconnection: close\r\n\r\n${body}`);
      }
    });
    socket.on('error', () => {});
  });
  servers.push(s);
  return s;
}

beforeAll(async () => {
  v4 = `http://127.0.0.1:${await listen(speechStandIn('v4'), '127.0.0.1')}/v1`;
  v6 = `http://[::1]:${await listen(speechStandIn('v6'), '::1')}/v1`;
  proxy = `http://127.0.0.1:${await listen(proxyStandIn(), '127.0.0.1')}`;
});
afterAll(async () => {
  for (const t of tunnels) t.destroy();
  for (const s of servers) {
    s.closeAllConnections?.();
    await new Promise<void>((r) => s.close(() => r()));
  }
  work.cleanup();
});

interface Seen {
  probe: string;
  tts: string;
  stt: string;
  problems: string[];
  spoke?: string;
  heard?: string;
}
/** One Node, started with the proxy switch on and this spelling of the list. Its environment is built here from nothing. */
function child(tag: string, noProxy: Record<string, string>): Promise<Record<'v4' | 'v6', Seen>> {
  return new Promise((resolve, reject) => {
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '',
      HOME: work.dir,
      TMPDIR: process.env.TMPDIR ?? '/tmp',
      LANG: 'en_US.UTF-8',
      NODE_USE_ENV_PROXY: '1',
      HTTP_PROXY: proxy,
      HTTPS_PROXY: proxy,
      SPEECH_V4: v4,
      SPEECH_V6: v6,
      VOICE_KEY,
      CASE_TAG: tag,
      // A key that must go nowhere at all: nothing here speaks through OpenAI.
      OPENAI_API_KEY: 'sk-process-test-OPENAISECRET',
      ...noProxy,
    };
    const proc = spawn(join(SERVER, 'node_modules', '.bin', 'tsx'), ['test/process/voice-proxy-child.ts'], { cwd: SERVER, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let said = '';
    proc.stdout.on('data', (d: Buffer) => (said += d.toString()));
    proc.stderr.on('data', (d: Buffer) => (said += d.toString()));
    const clock = setTimeout(() => proc.kill('SIGKILL'), 45_000);
    proc.on('exit', () => {
      clearTimeout(clock);
      const line = said.split('\n').find((l) => l.startsWith('RESULT '));
      if (!line) return reject(new Error(`the child said nothing:\n${said.slice(-1500)}`));
      resolve(JSON.parse(line.slice('RESULT '.length)) as Record<'v4' | 'v6', Seen>);
    });
  });
}

describe.runIf(NODE_HAS_ENV_PROXY)('a local speech server under Node’s env proxy: taken exactly when Node reaches it directly', () => {
  const seen = new Map<string, Record<'v4' | 'v6', Seen>>();
  const tagOf = (i: number): string => `case${String(i).padStart(2, '0')}`;
  beforeAll(async () => {
    const all = await Promise.all(NO_PROXY_SPELLINGS.map((s, i) => child(tagOf(i), s.env)));
    NO_PROXY_SPELLINGS.forEach((s, i) => seen.set(s.label, all[i]!));
  });

  it('the stand-ins see what they should when nothing is in the way: this test can fail', () => {
    // With `*` as the whole list every request went direct and was answered by the speech stand-in itself...
    const star = seen.get('NO_PROXY=* (the whole value)')!;
    expect([star.v4.probe, star.v6.probe]).toEqual(['direct v4', 'direct v6']);
    // ...and with no list at all Node really did hand both to the proxy, which answered them.
    const none = seen.get('no list at all')!;
    expect([none.v4.probe, none.v6.probe]).toEqual(['from the proxy', 'from the proxy']);
    expect(proxyGot.length).toBeGreaterThan(0);
  });

  it.each(NO_PROXY_SPELLINGS.map((s, i) => [s.label, s, i] as const))('%s', (_label, s, i) => {
    const got = seen.get(s.label)!;
    const tag = tagOf(i);
    for (const family of ['v4', 'v6'] as const) {
      const direct = s.direct[family];
      const mine = (list: Got[]): Got[] => list.filter((g) => `${g.what} ${g.body}`.includes(`${tag}/${family}`) || `${g.what} ${g.body}`.includes(`${tag} ${family}`));
      // 1. What NODE did with a request for this address: what the table says, seen for real.
      expect(got[family].probe, `${family}: where Node sent the probe`).toBe(direct ? `direct ${family}` : 'from the proxy');
      // 2. What FLINT decided: a speech server there is taken exactly when Node reaches it directly.
      expect([got[family].tts, got[family].stt], `${family}: what Flint decided`).toEqual(direct ? ['local', 'local'] : ['off', 'whisper-cpp']);
      expect(got[family].problems, family).toEqual(direct ? [] : ['FLINT_LOCAL_STT_BASE_URL:proxied', 'FLINT_LOCAL_TTS_BASE_URL:proxied']);
      // 3. Where the words went. Taken: the reply and the recording reached the speech server itself, with its key.
      const reached = mine(speechGot[family]).filter((g) => !g.what.includes('/probe/'));
      if (direct) {
        expect([got[family].spoke, got[family].heard], family).toEqual([`spoken on ${family}`, `heard on ${family}`]);
        expect(reached.map((g) => [g.what, g.auth]), family).toEqual([
          ['POST /v1/audio/speech', `Bearer ${VOICE_KEY}`],
          ['POST /v1/audio/transcriptions', `Bearer ${VOICE_KEY}`],
        ]);
        expect(reached[0]!.body).toContain(`PRIVATE WORDS ${tag} ${family}`);
        expect(reached[1]!.body).toContain(`PRIVATE RECORDING ${tag} ${family}`);
      } else {
        // Refused: nothing was spoken or transcribed anywhere, not at the speech server and not through the proxy.
        expect([got[family].spoke, got[family].heard], family).toEqual([undefined, undefined]);
        expect(reached, family).toEqual([]);
      }
    }
  });

  it('in all of it the proxy was handed no words, no recording and no key: only the probes that carry nothing', () => {
    expect(proxyGot.length).toBeGreaterThan(0);
    for (const g of proxyGot) {
      expect(`${g.what} ${g.body}`).not.toMatch(/PRIVATE|PROXYSECRET|OPENAISECRET|audio\/speech|audio\/transcriptions/);
      expect(g.auth).toBeUndefined();
      expect(`${g.what} ${g.body}`).toContain('/probe/');
    }
    // The key reached the speech stand-ins only, and OpenAI's key reached nothing.
    expect(JSON.stringify([speechGot, proxyGot])).not.toContain('OPENAISECRET');
  });

  it('the six the review found are all here, and for each of them Node proxied at least one of the two addresses', () => {
    expect(REVIEW_SIX).toHaveLength(6);
    for (const s of REVIEW_SIX) {
      const got = seen.get(s.label)!;
      expect([got.v4.probe, got.v6.probe], s.label).toContain('from the proxy');
    }
  });
});
