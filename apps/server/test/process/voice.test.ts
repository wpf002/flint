/**
 * The real server, run as a process, with what speaks and what hears set
 * three ways (../../src/voice). What the unit tests cannot see is here: what a
 * running server really puts in the `meta` event of a chat stream, what
 * `/speak` really answers, and where the words really go.
 *
 * A review showed the limit of reading index.ts as text: with `speechMadeHere`
 * replaced by a function that always says yes, the line that calls it was
 * unchanged and every test passed. A server that tells a client "my speech is
 * made on this Mac" when it is OpenAI's has the client send a reply that
 * stays here to `/speak`. (The server still refuses it there, by the stored
 * turn. This is the other half: what the client is told.)
 *
 * Five servers, each on its own scratch HOME, against loopback stand-ins
 * (./stubs, and a speech server here), fenced so that nothing else can be
 * reached (./guard.mjs). OpenAI is the fence: a request for it is a lookup of
 * `api.openai.com` that the guard stops and records, so "OpenAI saw nothing"
 * is "nothing was looked up".
 *  - `off`:   FLINT_TTS_PROVIDER=off;
 *  - `local`: a speech server on this Mac for speaking and for hearing, with
 *             a key of its own, and OpenAI's key set as well;
 *  - `saved`: no voice setting in the environment at all, and the four older
 *             ones in ~/.flint/secrets.env, the model's path written with ~;
 *  - `stale`: a line in ~/.flint/secrets.env that names a model that is not
 *             there (one saved long ago, which nothing read until now), with
 *             the usual model in its usual place;
 *  - `none`:  the same stale name, in the environment this time, and no usual
 *             model either: nothing on this Mac can transcribe.
 * (The default server, with no voice setting anywhere, is `modes` in
 * ./behaviour.test.ts: its `meta` event is held to exactly its three keys
 * there.)
 *
 * No program that makes a sound is run. The one program a server here starts
 * is a stand-in for whisper.cpp (a script that prints a line), and on a Mac
 * `afconvert`, which turns one file into another.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { SPEECH_OFF } from '../../src/speech-route';
import { startCloudStub, startOllamaStub, type CloudStub, type OllamaStub } from './stubs';
import { scratch, startServer, type Reply, type Running } from './rig';

const MAIN = 'main-model:30b';
const MODELS = { [MAIN]: { loaded: true, contextLength: 16384 }, 'nomic-embed-text': { family: 'nomic-bert' } };
/** Words that are in a message and nowhere else, so a wire or a log can be searched for them. */
const SECRET = 'ZEBRAQUARTZ';
const OPENAI_KEY = 'sk-process-test-not-a-key-OPENAISECRET';
const VOICE_KEY = 'voice-key-PROCESSSECRET-0123456789';
const ON_A_MAC = process.platform === 'darwin';

const meta = (r: Reply): Record<string, unknown> | undefined => r.events?.find((e) => e.type === 'meta' && typeof e.staysHere === 'boolean');
const blocked = (srv: Running): Array<{ kind: string; hostname?: string }> => srv.guard().filter((e) => e.kind.endsWith('blocked'));

/** `/speak`, read as it is answered: audio, or a refusal. */
async function speak(srv: Running, body: Record<string, unknown>): Promise<{ status: number; type: string; audio: Buffer; json: Record<string, unknown> | undefined }> {
  const r = await fetch(`${srv.base}/speak`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${srv.token}` }, body: JSON.stringify(body) });
  const type = (r.headers.get('content-type') ?? '').split(';')[0]!;
  const audio = Buffer.from(await r.arrayBuffer());
  let json: Record<string, unknown> | undefined;
  if (type === 'application/json') json = JSON.parse(audio.toString('utf8')) as Record<string, unknown>;
  return { status: r.status, type, audio, json };
}

/** `/transcribe`, with a recording. */
async function transcribe(srv: Running, audio: Buffer): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${srv.base}/transcribe`, { method: 'POST', headers: { 'content-type': 'audio/wav', authorization: `Bearer ${srv.token}` }, body: new Uint8Array(audio) });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown> };
}

/** A real WAV: a fifth of a second of silence, 16 kHz, mono, 16-bit. Nothing is ever played. */
function silence(): Buffer {
  const data = Buffer.alloc(6400);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0, 'ascii');
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVE', 8, 'ascii');
  head.write('fmt ', 12, 'ascii');
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(16_000, 24);
  head.writeUInt32LE(32_000, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36, 'ascii');
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

interface SpeechGot {
  method: string;
  path: string;
  auth: string | undefined;
  type: string;
  body: string;
}
/** A speech server on this Mac, as any OpenAI-compatible one answers: audio for `/v1/audio/speech`, text for `/v1/audio/transcriptions`. */
async function startSpeechStub(): Promise<{ origin: string; got: SpeechGot[]; close(): Promise<void> }> {
  const got: SpeechGot[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const type = String(req.headers['content-type'] ?? '').split(';')[0]!;
      got.push({ method: req.method ?? '', path: req.url ?? '', auth: req.headers.authorization, type, body: type === 'application/json' ? raw.toString('utf8') : raw.toString('latin1') });
      if (req.method === 'POST' && req.url === '/v1/audio/speech') {
        res.writeHead(200, { 'content-type': 'audio/wav' });
        return void res.end(Buffer.from(`RIFF-stand-in-audio:${(JSON.parse(raw.toString('utf8')) as { input: string }).input}`));
      }
      if (req.method === 'POST' && req.url === '/v1/audio/transcriptions') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return void res.end(JSON.stringify({ text: '  Heard by   the stand-in. ' }));
      }
      res.writeHead(404).end('{}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    got,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

interface Booted {
  ollama: OllamaStub;
  cloud: CloudStub;
  srv: Running;
}
const runs = { off: scratch('voice-off'), local: scratch('voice-local'), saved: scratch('voice-saved'), stale: scratch('voice-stale'), none: scratch('voice-none') };
let off: Booted;
let local: Booted & { speech: Awaited<ReturnType<typeof startSpeechStub>> };
let saved: Booted & { whisperRan: string; whisperBin: string };
let stale: Booted & { whisperRan: string };
let none: Booted & { whisperRan: string };
/** A path that names nothing: a model that was there once. */
const GONE = '/nonexistent/old/ggml-gone.bin';

/** A stand-in for whisper.cpp in a run's own folder: it writes down what it was run with, and prints a line. Its interpreter is this one. */
function whisperStandIn(dir: string, says: string): { whisperBin: string; whisperRan: string } {
  const whisperRan = join(dir, 'whisper-ran.json');
  const whisperBin = join(dir, 'bin', 'whisper-cli');
  mkdirSync(join(dir, 'bin'), { recursive: true });
  writeFileSync(whisperBin, [`#!${process.execPath}`, `require('node:fs').writeFileSync(${JSON.stringify(whisperRan)}, JSON.stringify(process.argv.slice(2)));`, `process.stdout.write(${JSON.stringify(`\n  ${says}\n`)});`, ''].join('\n'));
  chmodSync(whisperBin, 0o755);
  return { whisperBin, whisperRan };
}

async function boot(dir: string, env: Record<string, string>, seed?: Array<{ path: string[]; text: string }>): Promise<Booted> {
  const ollama = await startOllamaStub(structuredClone(MODELS));
  const cloud = await startCloudStub();
  const srv = await startServer({
    dir,
    env: { OLLAMA_HOST: ollama.origin, OLLAMA_MODEL: MAIN, OLLAMA_NUM_CTX: '16384', ANTHROPIC_API_KEY: 'sk-ant-process-test-not-a-key', ANTHROPIC_BASE_URL: cloud.origin, OPENAI_API_KEY: OPENAI_KEY, ...env },
    ...(seed ? { seed } : {}),
  });
  return { ollama, cloud, srv };
}

beforeAll(async () => {
  const startLocal = async () => {
    const speech = await startSpeechStub();
    const b = await boot(runs.local.dir, {
      FLINT_TTS_PROVIDER: 'local',
      FLINT_LOCAL_TTS_BASE_URL: `${speech.origin}/v1`,
      FLINT_LOCAL_TTS_MODEL: 'kokoro',
      FLINT_LOCAL_TTS_VOICE: 'af_heart',
      FLINT_STT_PROVIDER: 'local',
      // (`localhost`, and no path: pinned to 127.0.0.1, and /v1 is the path an address without one gets.)
      FLINT_LOCAL_STT_BASE_URL: speech.origin.replace('127.0.0.1', 'localhost'),
      FLINT_LOCAL_VOICE_API_KEY: VOICE_KEY,
    });
    return { ...b, speech };
  };
  const startSaved = async () => {
    const { whisperBin, whisperRan } = whisperStandIn(runs.saved.dir, 'Heard by the   saved program.');
    // No voice setting is in the environment: all four are lines of the settings file, and the model's path starts with ~.
    const b = await boot(runs.saved.dir, {}, [
      { path: ['secrets.env'], text: `# saved settings\nFLINT_TTS_VOICE=nova\nFLINT_TTS_MODEL="tts-1-hd"\nWHISPER_MODEL=~/.flint/models/ggml-small.en.bin\nWHISPER_BIN=${whisperBin}\n` },
      { path: ['models', 'ggml-small.en.bin'], text: 'a stand-in for a model file\n' },
    ]);
    return { ...b, whisperRan, whisperBin };
  };
  // The stale line, in the settings file: the program is the stand-in, the model it names is not there, and the
  // usual model is where it always is.
  const startStale = async () => {
    const { whisperBin, whisperRan } = whisperStandIn(runs.stale.dir, 'Heard with the   usual model.');
    const b = await boot(runs.stale.dir, {}, [
      { path: ['secrets.env'], text: `WHISPER_MODEL=${GONE}\nWHISPER_BIN=${whisperBin}\n` },
      { path: ['models', 'ggml-base.en.bin'], text: 'a stand-in for the usual model file\n' },
    ]);
    return { ...b, whisperRan };
  };
  // The same stale name in the ENVIRONMENT, and no usual model under this HOME: nothing can transcribe.
  const startNone = async () => {
    const { whisperBin, whisperRan } = whisperStandIn(runs.none.dir, 'This is never printed.');
    const b = await boot(runs.none.dir, { WHISPER_MODEL: GONE, WHISPER_BIN: whisperBin });
    return { ...b, whisperRan };
  };
  [off, local, saved, stale, none] = await Promise.all([boot(runs.off.dir, { FLINT_TTS_PROVIDER: 'off' }), startLocal(), startSaved(), startStale(), startNone()]);
});

afterAll(async () => {
  for (const b of [off, local, saved, stale, none]) {
    if (!b) continue;
    await b.srv.stop();
    await b.ollama.close();
    await b.cloud.close();
  }
  await local?.speech.close();
  for (const r of Object.values(runs)) r.cleanup();
});

/** One ordinary turn and one he asked to keep private, with the `meta` event of each. */
async function turns(srv: Running, tag: string) {
  const ordinary = await srv.post('/chat', { conversationId: `${tag}-open`, message: 'An ordinary synthetic question to be spoken.' });
  const kept = await srv.post('/chat', { conversationId: `${tag}-kept`, message: `A private synthetic question ${SECRET}.`, localOnly: true });
  expect(ordinary.text).toMatch(/^CLOUD\(/);
  expect(kept.text).toBe(`LOCAL(${MAIN}) reply.`);
  return {
    ordinary: { meta: meta(ordinary)!, said: { text: ordinary.text!, conversationId: `${tag}-open`, turnId: meta(ordinary)!.turn } },
    kept: { meta: meta(kept)!, said: { text: kept.text!, conversationId: `${tag}-kept`, turnId: meta(kept)!.turn } },
  };
}

describe('the real server, as a process: speech is off', () => {
  it('it says so when it starts, and the status says so', async () => {
    expect(off.srv.log()).toContain('[voice] hearing=whisper-cpp (ggml-base.en.bin) speaking=off (set)');
    const st = (await off.srv.get('/inference')).json as { voice: { speech: Record<string, unknown> }; lines: string[] };
    expect(st.voice.speech).toEqual({ provider: 'off', name: 'Off', here: true, sentence: 'Each device speaks with its own voice.' });
    expect(st.lines).toContain('Speech is off: each device speaks with its own voice.');
  });

  // The review's M05, M06 and M27: "the server's speech is made here" said by a server that makes none.
  it('no reply is ever said to be spoken here: the meta event has exactly its three keys, for an ordinary turn and for a private one', async () => {
    const t = await turns(off.srv, 'off');
    expect(Object.keys(t.ordinary.meta).sort()).toEqual(['staysHere', 'turn', 'type']);
    expect(Object.keys(t.kept.meta).sort()).toEqual(['staysHere', 'turn', 'type']);
    expect([t.ordinary.meta.staysHere, t.kept.meta.staysHere]).toEqual([false, true]);
    for (const m of [t.ordinary.meta, t.kept.meta]) expect('speechHere' in m).toBe(false);
  });

  it('/speak makes no speech: 503 with the sentence and the device’s own voice, for every reply, and OpenAI is never looked up though its key is set', async () => {
    const t = await turns(off.srv, 'off2');
    for (const said of [t.ordinary.said, t.kept.said, { text: 'Words that name no turn.' }]) {
      const r = await speak(off.srv, said);
      expect(r.status, JSON.stringify(said)).toBe(503);
      expect(r.json).toEqual({ error: SPEECH_OFF, fallback: 'browser' });
    }
    expect(blocked(off.srv)).toEqual([]);
  });
});

describe('the real server, as a process: a speech server on this Mac speaks and hears', () => {
  it('it says so when it starts, with no address and no key in the line', () => {
    const log = local.srv.log();
    expect(log).toContain('[voice] hearing=local server on this Mac (whisper-1) speaking=local server on this Mac (kokoro, af_heart)');
    const port = new URL(local.speech.origin).port;
    const line = log.split('\n').find((l) => l.startsWith('[voice] '))!;
    expect(line).not.toMatch(new RegExp(`127\\.0\\.0\\.1|localhost|${port}|PROCESSSECRET`));
  });

  it('every reply is said to be spoken here, and that is the one thing added to the meta event', async () => {
    const t = await turns(local.srv, 'here');
    expect(t.ordinary.meta).toMatchObject({ type: 'meta', staysHere: false, speechHere: true });
    expect(t.kept.meta).toMatchObject({ type: 'meta', staysHere: true, speechHere: true });
    for (const m of [t.ordinary.meta, t.kept.meta]) expect(Object.keys(m).sort()).toEqual(['speechHere', 'staysHere', 'turn', 'type']);
  });

  it('a reply that stays here is spoken by that server, with its own key, and OpenAI is never looked up: not for it, and not for an ordinary one', async () => {
    const t = await turns(local.srv, 'spoken');
    const before = local.speech.got.length;
    const kept = await speak(local.srv, t.kept.said);
    expect([kept.status, kept.type]).toEqual([200, 'audio/wav']);
    expect(kept.audio.toString('utf8')).toBe(`RIFF-stand-in-audio:${t.kept.said.text}`);
    const ordinary = await speak(local.srv, t.ordinary.said);
    expect([ordinary.status, ordinary.type]).toEqual([200, 'audio/wav']);
    // Words that name no turn the store can place are a reply that stays here, to an outside service. Here they go nowhere.
    expect((await speak(local.srv, { text: 'Words that name no turn.' })).status).toBe(200);
    const sent = local.speech.got.slice(before);
    expect(sent.map((g) => [g.method, g.path, g.type])).toEqual(Array.from({ length: 3 }, () => ['POST', '/v1/audio/speech', 'application/json']));
    expect(sent.map((g) => (JSON.parse(g.body) as Record<string, unknown>))).toEqual([
      { model: 'kokoro', voice: 'af_heart', input: t.kept.said.text, response_format: 'mp3' },
      { model: 'kokoro', voice: 'af_heart', input: t.ordinary.said.text, response_format: 'mp3' },
      { model: 'kokoro', voice: 'af_heart', input: 'Words that name no turn.', response_format: 'mp3' },
    ]);
    // The speech server's own key, on every request: OpenAI's key went nowhere.
    expect(new Set(sent.map((g) => g.auth))).toEqual(new Set([`Bearer ${VOICE_KEY}`]));
    expect(JSON.stringify(local.speech.got)).not.toContain('OPENAISECRET');
    // OpenAI's stand-in is the fence: not one lookup, though its key is set.
    expect(blocked(local.srv)).toEqual([]);
  });

  it('in Local mode it speaks as before: nothing it is given leaves this Mac', async () => {
    const t = await turns(local.srv, 'mode');
    expect((await local.srv.post('/inference/mode', { mode: 'local' })).status).toBe(200);
    try {
      const taken = await local.srv.post('/chat', { conversationId: 'mode-local', message: 'A synthetic question in Local mode.' });
      expect(meta(taken)).toMatchObject({ staysHere: true, speechHere: true });
      const before = local.speech.got.length;
      for (const said of [t.kept.said, { text: taken.text!, conversationId: 'mode-local', turnId: meta(taken)!.turn }]) expect((await speak(local.srv, said)).status).toBe(200);
      expect(local.speech.got.length).toBe(before + 2);
      expect(blocked(local.srv)).toEqual([]);
    } finally {
      await local.srv.post('/inference/mode', { mode: 'cloud' });
    }
  });

  it('a recording is turned into text by that server, with its own key', async () => {
    const before = local.speech.got.length;
    const r = await transcribe(local.srv, silence());
    expect(r).toEqual({ status: 200, json: { text: 'Heard by the stand-in.' } });
    const sent = local.speech.got.slice(before);
    expect(sent.map((g) => [g.method, g.path, g.type, g.auth])).toEqual([['POST', '/v1/audio/transcriptions', 'multipart/form-data', `Bearer ${VOICE_KEY}`]]);
    expect(sent[0]!.body).toContain('RIFF');
    expect(sent[0]!.body).toMatch(/name="model"\r\n\r\nwhisper-1\r\n/);
  });

  // The review's M22: a status that carried the key passed every test.
  it("the status names both rows and holds no key and no address: not the speech server's key, not OpenAI's, in any part of it", async () => {
    const r = await local.srv.get('/inference');
    const st = r.json as { voice: { speech: Record<string, unknown>; transcription: Record<string, unknown> }; lines: string[] };
    expect(st.voice.speech).toEqual({ provider: 'local', name: 'Local Speech Server', here: true, sentence: 'Replies are spoken by the speech server on this Mac, and nothing is sent out.' });
    expect(st.voice.transcription).toEqual({ provider: 'local', name: 'Local Speech Server', here: true, sentence: 'Your voice is turned into text by the speech server on this Mac.' });
    expect(st.lines).toContain('Transcription uses the local speech server on this Mac (whisper-1).');
    expect(st.lines).toContain('Speech uses the local speech server on this Mac (kokoro, af_heart).');
    const whole = JSON.stringify(r.json);
    expect(whole).not.toMatch(/PROCESSSECRET|OPENAISECRET|voice-key|sk-process/);
    const port = new URL(local.speech.origin).port;
    for (const line of st.lines.filter((l) => /speech server/.test(l))) expect(line).not.toMatch(new RegExp(`127\\.0\\.0\\.1|localhost|${port}`));
    expect(JSON.stringify(st.voice)).not.toMatch(new RegExp(`127\\.0\\.0\\.1|localhost|${port}`));
  });

  it('the log holds no key and none of what was said', () => {
    const log = local.srv.log();
    for (const word of ['PROCESSSECRET', 'OPENAISECRET', SECRET, 'Words that name no turn', 'synthetic question']) expect(log, word).not.toContain(word);
  });
});

// The review's H1. main read these four into constants when index.ts loaded, BEFORE it read ~/.flint/secrets.env:
// a line for one of them in that file was silently ignored. They are read by config now, after the file.
describe('the real server, as a process: the four older voice settings, saved in the settings file', () => {
  it('all four are read from it: the boot line and the status name the saved model, and the saved voice', async () => {
    expect(saved.srv.log()).toContain('[voice] hearing=whisper-cpp (ggml-small.en.bin) speaking=openai (tts-1-hd, nova)');
    const st = (await saved.srv.get('/inference')).json as { voice: { transcription: Record<string, unknown> }; lines: string[]; problems: unknown[] };
    expect(st.lines).toContain('Transcription uses whisper-cpp (ggml-small.en.bin), on this Mac.');
    expect(st.lines).toContain('Speech uses OpenAI (tts-1-hd, nova). A reply that stays on this Mac is spoken by the device instead.');
    expect(st.voice.transcription).toMatchObject({ provider: 'whisper-cpp', name: 'Whisper Small English' });
    // Not one of them was refused: a path that starts with ~/ is this home folder.
    expect(st.problems).toEqual([]);
    expect(saved.srv.log()).not.toMatch(/WHISPER_(BIN|MODEL) is |FLINT_TTS_(MODEL|VOICE) is /);
  });

  // The review's M2, on a real server: the program is the saved one, and it is handed the model by its FULL path.
  it.runIf(ON_A_MAC)('a recording is transcribed by the saved program, which is handed the saved model by its full path: no ~ reaches it', async () => {
    expect(existsSync(saved.whisperRan)).toBe(false);
    const r = await transcribe(saved.srv, silence());
    expect(r).toEqual({ status: 200, json: { text: 'Heard by the saved program.' } });
    const argv = JSON.parse(readFileSync(saved.whisperRan, 'utf8')) as string[];
    expect(argv[0]).toBe('-m');
    expect(argv[1]).toBe(join(saved.srv.home, '.flint', 'models', 'ggml-small.en.bin'));
    expect(argv[2]).toBe('-f');
    expect(argv[3]).toMatch(/flint-stt-[^/]+\/out\.wav$/);
    expect(argv.slice(4)).toEqual(['-nt', '-np']);
    expect(argv.filter((a) => a.includes('~'))).toEqual([]);
  });

  it('the default path is untouched by them: OpenAI is asked for an ordinary reply and never for one that stays here, and the meta event has its three keys', async () => {
    const t = await turns(saved.srv, 'saved');
    for (const m of [t.ordinary.meta, t.kept.meta]) expect(Object.keys(m).sort()).toEqual(['staysHere', 'turn', 'type']);
    expect((await speak(saved.srv, t.kept.said)).status).toBe(409);
    expect(blocked(saved.srv)).toEqual([]);
    // The ordinary reply is sent (the fence stops the one lookup, and that attempt is the proof it was made).
    expect((await speak(saved.srv, t.ordinary.said)).status).not.toBe(409);
    expect(blocked(saved.srv).map((e) => [e.kind, e.hostname])).toEqual([['dns-blocked', 'api.openai.com']]);
  });
});

// A line saved long ago. main read WHISPER_MODEL before it read the settings file, so a line for it there was never
// used and may name a file that has since gone. Read after the file, it applied, and every recording was a 500. A
// model (or a program) that is named and is not there when Flint starts is refused, by the name of the setting, and
// the usual one is used; wherever the value came from.
describe('the real server, as a process: a saved WHISPER_MODEL that names a file that is not there', () => {
  it('it is refused when Flint starts, by the name of the setting and never by its path, and the usual model is what the boot line and the status name', async () => {
    const log = stale.srv.log();
    expect(log).toContain('[inference] WHISPER_MODEL is the path of a file that is not there; using the usual transcription model');
    expect(log).toContain('[voice] hearing=whisper-cpp (ggml-base.en.bin) speaking=openai (tts-1, onyx)');
    const st = (await stale.srv.get('/inference')).json as { voice: { transcription: Record<string, unknown> }; lines: string[]; notices: string[]; problems: Array<Record<string, unknown>> };
    expect(st.problems).toEqual([{ key: 'WHISPER_MODEL', reason: 'the path of a file that is not there', kind: 'missing' }]);
    expect(st.notices).toContain("The transcription model named in Flint's setup isn't on this Mac, so Flint uses the usual one.");
    expect(st.lines).toContain('Transcription uses whisper-cpp (ggml-base.en.bin), on this Mac.');
    expect(st.voice.transcription).toMatchObject({ name: 'Whisper Base English', sentence: 'Your voice is turned into text on this Mac.' });
    expect(log + JSON.stringify(st)).not.toMatch(/nonexistent|ggml-gone/);
  });

  it.runIf(ON_A_MAC)('a recording is transcribed, with the usual model: not one fails for the stale line', async () => {
    for (let i = 0; i < 2; i++) expect(await transcribe(stale.srv, silence())).toEqual({ status: 200, json: { text: 'Heard with the usual model.' } });
    const argv = JSON.parse(readFileSync(stale.whisperRan, 'utf8')) as string[];
    expect(argv.slice(0, 2)).toEqual(['-m', join(stale.srv.home, '.flint', 'models', 'ggml-base.en.bin')]);
    expect(argv.join(' ')).not.toMatch(/nonexistent|ggml-gone/);
  });
});

describe('the real server, as a process: the same stale name in the environment, and no usual model either', () => {
  it('it is refused at start all the same: where the value came from changes nothing', async () => {
    expect(none.srv.log()).toContain('[inference] WHISPER_MODEL is the path of a file that is not there; using the usual transcription model');
    const st = (await none.srv.get('/inference')).json as { problems: Array<Record<string, unknown>> };
    expect(st.problems).toEqual([{ key: 'WHISPER_MODEL', reason: 'the path of a file that is not there', kind: 'missing' }]);
  });

  it('a recording is answered with a sentence: a 503 that says the model is not on this Mac, with no reference, no stack, and nothing run', async () => {
    const before = none.srv.log().length;
    for (let i = 0; i < 2; i++) {
      const r = await transcribe(none.srv, silence());
      expect(r).toEqual({ status: 503, json: { error: 'Flint can’t turn speech into text: the transcription model isn’t on this Mac.' } });
    }
    // The program was never started (it has no model to be started with), and the server has nothing to say of a failure.
    expect(existsSync(none.whisperRan)).toBe(false);
    const said = none.srv.log().slice(before);
    expect(said).not.toMatch(/transcribe|ENOENT|    at |Error/);
    // The rest of the route is as it was: no recording is still a 400, and a recording that is too large a 413.
    expect((await transcribe(none.srv, Buffer.alloc(0))).status).toBe(400);
  });

  it('the model put where it belongs while Flint runs is used by the very next recording: nothing has to be restarted', async () => {
    const usual = join(none.srv.home, '.flint', 'models', 'ggml-base.en.bin');
    mkdirSync(join(none.srv.home, '.flint', 'models'), { recursive: true });
    writeFileSync(usual, 'a stand-in for the usual model file\n');
    try {
      const r = await transcribe(none.srv, silence());
      if (ON_A_MAC) {
        expect(r).toEqual({ status: 200, json: { text: 'This is never printed.' } });
        expect((JSON.parse(readFileSync(none.whisperRan, 'utf8')) as string[]).slice(0, 2)).toEqual(['-m', usual]);
      } else {
        // Off a Mac the recording cannot be made into the WAV whisper reads: a failure of a run, which is not this sentence.
        expect(r.status).not.toBe(503);
      }
    } finally {
      rmSync(usual, { force: true });
    }
  });
});
