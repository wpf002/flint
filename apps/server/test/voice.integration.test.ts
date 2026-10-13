import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readInferenceConfig } from '../src/inference-config';
import { GuardRefusal, guardedFetch } from '../src/local-backend';
import { buildVoice, planVoice, speechPaths } from '../src/voice';

/**
 * The local speech providers against a real HTTP server on loopback (port 0):
 * a stand-in for any OpenAI-compatible speech server (`/v1/audio/speech`,
 * `/v1/audio/transcriptions`). The providers are built the way main() builds
 * them, from config, behind the real guarded fetch, with a real TCP connect.
 * Nothing here plays audio or runs a speech program.
 */

interface Got {
  method: string;
  path: string;
  auth: string | undefined;
  type: string | undefined;
  body: Buffer;
}

let server: Server;
let base: string;
let got: Got[];
let answer: (g: Got) => { status: number; type?: string; body: Buffer | string; location?: string };
/** A second server, LIVE, at another port of this machine: where a redirect points, and what stands in for OpenAI. It answers whatever it is asked, so a request that reaches it is seen. */
let other: Server;
let otherBase: string;
let otherGot: Got[];

const read = (req: IncomingMessage): Promise<Buffer> =>
  new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });

beforeAll(async () => {
  server = createServer((req, res) => {
    void read(req).then((body) => {
      const g: Got = { method: req.method ?? '', path: req.url ?? '', auth: req.headers.authorization, type: req.headers['content-type'], body };
      got.push(g);
      const a = answer(g);
      res.writeHead(a.status, { ...(a.type ? { 'content-type': a.type } : {}), ...(a.location ? { location: a.location } : {}) });
      res.end(a.body);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  other = createServer((req, res) => {
    void read(req).then((body) => {
      otherGot.push({ method: req.method ?? '', path: req.url ?? '', auth: req.headers.authorization, type: req.headers['content-type'], body });
      res.writeHead(200, { 'content-type': 'audio/mpeg' });
      res.end(Buffer.from('ID3-from-the-other-server'));
    });
  });
  await new Promise<void>((r) => other.listen(0, '127.0.0.1', r));
  otherBase = `http://127.0.0.1:${(other.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await new Promise<void>((r) => other.close(() => r()));
});
beforeEach(() => {
  got = [];
  otherGot = [];
  answer = (g) =>
    g.path === '/v1/audio/speech'
      ? { status: 200, type: 'audio/mpeg', body: Buffer.from('ID3-fake-mp3-audio') }
      : g.path === '/v1/audio/transcriptions'
        ? { status: 200, type: 'application/json', body: JSON.stringify({ text: ' The quick brown fox.  ' }) }
        : { status: 404, body: 'not found' };
});

/** The providers, as main() builds them from the environment. `convert: false` is not a setting: the STT side is given a stand-in for afconvert instead. */
function voice(env: Record<string, string>, o: { fetch?: typeof fetch } = {}) {
  const cfg = readInferenceConfig(env);
  const plan = planVoice(cfg, env, { platform: 'darwin', home: '/nonexistent' });
  const ran: string[] = [];
  const built = buildVoice(plan, {
    env,
    connectTimeoutMs: 1000,
    ...(o.fetch ? { fetch: o.fetch } : {}),
    // afconvert's part, played here: the "WAV" is the recording with a header in front.
    run: async (file, args) => {
      ran.push(file);
      writeFileSync(args[1]!, Buffer.concat([Buffer.from('RIFF'), readFileSync(args[0]!)]));
      return { stdout: '' };
    },
  });
  return { ...built, plan, cfg, ran };
}

describe('speaking through a local OpenAI-compatible speech server', () => {
  it('the reply goes to /v1/audio/speech as JSON and comes back as audio of the kind the server says', async () => {
    const { tts, cfg } = voice({ FLINT_TTS_PROVIDER: 'local', FLINT_LOCAL_TTS_BASE_URL: base, FLINT_LOCAL_TTS_MODEL: 'kokoro', FLINT_LOCAL_TTS_VOICE: 'af_heart' });
    expect(cfg.problems).toEqual([]);
    expect(tts).toMatchObject({ name: 'local', local: true });
    const out = await tts.synthesize('Tuesday works. You have nothing on the calendar before noon.');
    expect(out).toEqual({ audio: Buffer.from('ID3-fake-mp3-audio'), contentType: 'audio/mpeg' });
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ method: 'POST', path: '/v1/audio/speech', type: 'application/json', auth: undefined });
    expect(JSON.parse(got[0]!.body.toString('utf8'))).toEqual({ model: 'kokoro', voice: 'af_heart', input: 'Tuesday works. You have nothing on the calendar before noon.', response_format: 'mp3' });
  });

  it('a server that answers WAV is handed on as WAV, and one started with a key gets the key', async () => {
    answer = () => ({ status: 200, type: 'audio/wav', body: Buffer.from('RIFF-wav') });
    const { tts } = voice({ FLINT_TTS_PROVIDER: 'local', FLINT_LOCAL_TTS_BASE_URL: `${base}/v1`, FLINT_LOCAL_VOICE_API_KEY: 'local-voice-key' });
    expect(await tts.synthesize('Hi.')).toEqual({ audio: Buffer.from('RIFF-wav'), contentType: 'audio/wav' });
    expect(got[0]!.auth).toBe('Bearer local-voice-key');
  });

  // The review: this pointed the redirect at a port nothing listened on, so it passed whether or not the redirect
  // was followed. It points at a LIVE server now, which answers anything: a followed redirect is audio, and is seen.
  it('a redirect is refused, never followed: the words go to the address Will set and nowhere else', async () => {
    // First, that the other server would have answered: this test can fail.
    const direct = await fetch(`${otherBase}/v1/audio/speech`, { method: 'POST', body: '{}' });
    expect(direct.status).toBe(200);
    expect(otherGot).toHaveLength(1);
    otherGot = [];
    for (const status of [301, 302, 303, 307, 308]) {
      got = [];
      answer = () => ({ status, location: `${otherBase}/v1/audio/speech`, body: '' });
      const { tts, stt } = voice({ FLINT_TTS_PROVIDER: 'local', FLINT_LOCAL_TTS_BASE_URL: base, FLINT_STT_PROVIDER: 'local', FLINT_LOCAL_STT_BASE_URL: base, FLINT_LOCAL_VOICE_API_KEY: 'voice-KEY' });
      await expect(tts.synthesize('Private words.'), String(status)).rejects.toThrow();
      await expect(stt.transcribe(Buffer.from('private recording')), String(status)).rejects.toThrow();
      // Each was asked once, at the address Will set...
      expect(got.map((g) => g.path), String(status)).toEqual(['/v1/audio/speech', '/v1/audio/transcriptions']);
      // ...and the server the redirect named never heard of it: not the words, not the recording, not the key.
      expect(otherGot, String(status)).toEqual([]);
    }
  });

  // The review's M14 and M15, on real servers: which key goes where was held by no test.
  it('with both keys set, the speech server gets its own key and OpenAI gets its own: neither is sent to the other', async () => {
    // What stands in for OpenAI: a request for api.openai.com is carried to the other server, and nothing else is.
    const carried: typeof fetch = ((url: string | URL, init?: RequestInit) => {
      const at = new URL(String(url));
      return at.origin === 'https://api.openai.com' ? fetch(`${otherBase}${at.pathname}`, init) : fetch(url, init);
    }) as typeof fetch;
    const keys = { OPENAI_API_KEY: 'sk-OPENAI-KEY', FLINT_LOCAL_VOICE_API_KEY: 'voice-KEY' };
    const local = voice({ ...keys, FLINT_TTS_PROVIDER: 'local', FLINT_LOCAL_TTS_BASE_URL: base, FLINT_STT_PROVIDER: 'local', FLINT_LOCAL_STT_BASE_URL: base }, { fetch: carried });
    await local.tts.synthesize('Hello.');
    await local.stt.transcribe(Buffer.from('a'));
    expect(got.map((g) => [g.path, g.auth])).toEqual([
      ['/v1/audio/speech', 'Bearer voice-KEY'],
      ['/v1/audio/transcriptions', 'Bearer voice-KEY'],
    ]);
    expect(otherGot).toEqual([]);
    // The defaults, with the speech server's settings still there: OpenAI speaks, and is sent OpenAI's key alone.
    got = [];
    const outside = voice({ ...keys, FLINT_LOCAL_TTS_BASE_URL: base }, { fetch: carried });
    expect(outside.tts.name).toBe('openai');
    await outside.tts.synthesize('Hello.');
    expect(otherGot.map((g) => [g.path, g.auth])).toEqual([['/v1/audio/speech', 'Bearer sk-OPENAI-KEY']]);
    expect(got).toEqual([]);
    // No key for the speech server: it is sent none. OpenAI's is not lent to it.
    otherGot = [];
    const keyless = voice({ OPENAI_API_KEY: 'sk-OPENAI-KEY', FLINT_TTS_PROVIDER: 'local', FLINT_LOCAL_TTS_BASE_URL: base }, { fetch: carried });
    await keyless.tts.synthesize('Hello.');
    expect(got.map((g) => g.auth)).toEqual([undefined]);
    expect(otherGot).toEqual([]);
  });

  it('a server that is down is a failure within the connect deadline, not a hang', async () => {
    const closed = createServer();
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', r));
    const dead = `http://127.0.0.1:${(closed.address() as AddressInfo).port}`;
    await new Promise<void>((r) => closed.close(() => r()));
    const { tts } = voice({ FLINT_TTS_PROVIDER: 'local', FLINT_LOCAL_TTS_BASE_URL: dead });
    // It fails, and does not wait out the minute a reply may take: the test's own limit (half of that) is the only clock.
    await expect(tts.synthesize('Hi.')).rejects.toThrow('fetch failed');
  }, 30_000);

  it('an error from the server is its status, and nothing it said', async () => {
    answer = () => ({ status: 500, type: 'text/plain', body: 'failed to speak: Private words.' });
    const { tts } = voice({ FLINT_TTS_PROVIDER: 'local', FLINT_LOCAL_TTS_BASE_URL: base });
    const err = (await tts.synthesize('Private words.').catch((e: Error) => e)) as Error;
    expect(err.message).toBe('tts HTTP 500');
  });
});

describe('hearing through a local OpenAI-compatible speech server', () => {
  it('the recording is made into WAV and posted as multipart to /v1/audio/transcriptions; the text comes back on one line', async () => {
    const { stt, ran, cfg } = voice({ FLINT_STT_PROVIDER: 'local', FLINT_LOCAL_STT_BASE_URL: base, FLINT_LOCAL_STT_MODEL: 'small.en' });
    expect(cfg.problems).toEqual([]);
    expect(stt).toMatchObject({ name: 'local', local: true, model: 'small.en' });
    expect(await stt.transcribe(Buffer.from('recorded-m4a-bytes'))).toEqual({ text: 'The quick brown fox.' });
    expect(ran).toEqual(['/usr/bin/afconvert']);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ method: 'POST', path: '/v1/audio/transcriptions', auth: undefined });
    expect(got[0]!.type).toMatch(/^multipart\/form-data; boundary=/);
    const body = got[0]!.body.toString('latin1');
    expect(body).toContain('name="file"; filename="audio.wav"');
    expect(body).toContain('Content-Type: audio/wav');
    expect(body).toContain('RIFFrecorded-m4a-bytes');
    expect(body).toMatch(/name="model"\r\n\r\nsmall\.en\r\n/);
    expect(body).toMatch(/name="response_format"\r\n\r\njson\r\n/);
  });

  it('a server that answers without text, or with an error, is a failure', async () => {
    const { stt } = voice({ FLINT_STT_PROVIDER: 'local', FLINT_LOCAL_STT_BASE_URL: base });
    answer = () => ({ status: 200, type: 'application/json', body: '{"segments":[]}' });
    await expect(stt.transcribe(Buffer.from('a'))).rejects.toThrow('stt answered without text');
    answer = () => ({ status: 503, body: 'loading model' });
    await expect(stt.transcribe(Buffer.from('a'))).rejects.toThrow('stt HTTP 503');
  });
});

describe('the guard around a local speech server', () => {
  it('only its two paths, at its own address: nothing else there, and nowhere else, is ever reached', async () => {
    const env = { FLINT_TTS_PROVIDER: 'local', FLINT_LOCAL_TTS_BASE_URL: base };
    const cfg = readInferenceConfig(env);
    const plan = planVoice(cfg, env, { platform: 'darwin' });
    // The same guard buildVoice puts around the provider: this server's origin, and the speech paths.
    const reached = guardedFetch({ origin: (plan.tts as { server: { origin: string } }).server.origin, paths: speechPaths('/v1') });
    await expect(reached(`${base}/v1/models`)).rejects.toBeInstanceOf(GuardRefusal);
    await expect(reached(`${base}/v1/audio/speech?voice=x`)).rejects.toBeInstanceOf(GuardRefusal);
    await expect(reached('http://127.0.0.1:1/v1/audio/speech', { method: 'POST' })).rejects.toBeInstanceOf(GuardRefusal);
    await expect(reached('https://api.openai.com/v1/audio/speech', { method: 'POST' })).rejects.toBeInstanceOf(GuardRefusal);
    expect(got).toEqual([]);
  });

  it('an address on another machine is refused by config before any provider exists for it', () => {
    const { tts, cfg, plan } = voice({ FLINT_TTS_PROVIDER: 'local', FLINT_LOCAL_TTS_BASE_URL: 'http://speech.example:8880/v1', OPENAI_API_KEY: 'sk-x' });
    expect(cfg.problems.map((p) => [p.key, p.kind])).toEqual([['FLINT_LOCAL_TTS_BASE_URL', 'other_machine']]);
    // Off: OpenAI does not take its place, though a key is there.
    expect(plan.tts).toEqual({ name: 'off', local: true, why: 'no_server' });
    expect(tts.name).toBe('off');
  });
});
