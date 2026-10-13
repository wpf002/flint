import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readInferenceConfig } from '../src/inference-config';
import {
  AUDIO_TYPES,
  TTS_MAX_CHARS,
  audioTypeOf,
  buildVoice,
  macSayTts,
  offTts,
  openAiCompatStt,
  openAiCompatTts,
  openAiTts,
  planVoice,
  speechPaths,
  voiceLine,
  whisperCppStt,
  whisperPaths,
  type Run,
} from '../src/voice';

/**
 * The voice seam: two interfaces, and each provider behind them. Nothing here
 * runs a program or reaches a network: `run` and `fetch` are injected, and the
 * stand-ins record what a real one would have been given.
 */

interface Ran {
  file: string;
  args: string[];
  opts: Record<string, unknown> | undefined;
  /** What the files named in the arguments held, and their modes, at the moment the program would have run. */
  files: Record<string, { text: string; mode: number; dirMode: number }>;
}

/** A stand-in for execFile: records the call, and plays the part of `afconvert`, `whisper-cli` and `say`. */
function runner(o: { whisperSays?: string; sayWrites?: string | null; fail?: string } = {}) {
  const ran: Ran[] = [];
  const run: Run = async (file, args, opts) => {
    const files: Ran['files'] = {};
    for (const a of args) {
      if (a.startsWith('/') && existsSync(a)) files[a] = { text: readFileSync(a, 'utf8'), mode: statSync(a).mode & 0o777, dirMode: statSync(dirname(a)).mode & 0o777 };
    }
    ran.push({ file, args: [...args], opts: opts as Record<string, unknown> | undefined, files });
    if (o.fail && file.endsWith(o.fail)) throw new Error(`${o.fail} failed`);
    if (file === '/usr/bin/afconvert') writeFileSync(args[1]!, 'RIFF-wav-bytes');
    if (file === '/usr/bin/say' && o.sayWrites !== null) writeFileSync(args[args.indexOf('-o') + 1]!, o.sayWrites ?? 'm4a-bytes');
    return { stdout: o.whisperSays ?? '' };
  };
  return { run, ran };
}

interface Sent {
  url: string;
  init: RequestInit;
}
function fetcher(answer: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const sent: Sent[] = [];
  const f = (async (url: string | URL, init: RequestInit = {}) => {
    sent.push({ url: String(url), init });
    return answer(String(url), init);
  }) as unknown as typeof fetch;
  return { f, sent };
}
const audio = (body: string, type = 'audio/mpeg'): Response => new Response(body, { status: 200, headers: { 'content-type': type } });
const headers = (init: RequestInit): Record<string, string> => init.headers as Record<string, string>;

// ---------------------------------------------------------------------------

describe('whisper.cpp, on this Mac: what Flint has always done, moved behind the seam unchanged', () => {
  it('converts the recording to the WAV whisper reads, runs whisper-cli on it, and hands back the text on one line', async () => {
    const { run, ran } = runner({ whisperSays: '\n  Hello   there,\n Flint. \n' });
    const stt = whisperCppStt({ bin: '/opt/homebrew/bin/whisper-cli', model: '/models/ggml-base.en.bin', run });
    expect(await stt.transcribe(Buffer.from('m4a-recording'))).toEqual({ text: 'Hello there, Flint.' });
    expect(ran).toHaveLength(2);
    const [convert, whisper] = ran as [Ran, Ran];
    // Exactly the two commands the server ran before there was a seam.
    expect(convert.file).toBe('/usr/bin/afconvert');
    expect(convert.args.slice(2)).toEqual(['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1']);
    expect(convert.args[0]).toMatch(/flint-stt-[^/]+\/in$/);
    expect(convert.args[1]).toMatch(/flint-stt-[^/]+\/out\.wav$/);
    expect(convert.files[convert.args[0]!]!.text).toBe('m4a-recording');
    expect(whisper.file).toBe('/opt/homebrew/bin/whisper-cli');
    expect(whisper.args).toEqual(['-m', '/models/ggml-base.en.bin', '-f', convert.args[1], '-nt', '-np']);
    expect(whisper.opts).toEqual({ maxBuffer: 8 * 1024 * 1024 });
  });

  it('the recording lives in a directory only this user can read, and is gone afterwards, also when whisper fails', async () => {
    const ok = runner({ whisperSays: 'x' });
    await whisperCppStt({ bin: '/w', model: '/m', run: ok.run }).transcribe(Buffer.from('a'));
    const dir = dirname(ok.ran[0]!.args[0]!);
    expect(ok.ran[0]!.files[ok.ran[0]!.args[0]!]!.dirMode).toBe(0o700);
    expect(existsSync(dir)).toBe(false);
    const bad = runner({ fail: 'afconvert' });
    await expect(whisperCppStt({ bin: '/w', model: '/m', run: bad.run }).transcribe(Buffer.from('a'))).rejects.toThrow('afconvert failed');
    expect(existsSync(dirname(bad.ran[0]!.args[0]!))).toBe(false);
  });

  it('is local, and a status may name its model by the file, never by the path', () => {
    const stt = whisperCppStt({ bin: '/w', model: '/Users/someone/.flint/models/ggml-small.en.bin' });
    expect(stt).toMatchObject({ name: 'whisper-cpp', local: true, model: 'ggml-small.en.bin' });
  });

  it('where the program and the model are: WHISPER_BIN and WHISPER_MODEL, else where they have always been', () => {
    expect(whisperPaths({}, '/home/will')).toEqual({ bin: '/opt/homebrew/bin/whisper-cli', model: '/home/will/.flint/models/ggml-base.en.bin' });
    expect(whisperPaths({ WHISPER_BIN: ' /x/whisper-cli ', WHISPER_MODEL: '/m/ggml-small.bin' }, '/home/will')).toEqual({ bin: '/x/whisper-cli', model: '/m/ggml-small.bin' });
    expect(whisperPaths({ WHISPER_BIN: '  ', WHISPER_MODEL: '' }, '/h').bin).toBe('/opt/homebrew/bin/whisper-cli');
  });
});

describe('OpenAI speech: what Flint has always done, moved behind the seam unchanged', () => {
  it('sends the same request as before, and hands back mp3', async () => {
    const { f, sent } = fetcher(() => audio('mp3-bytes'));
    const tts = openAiTts({ apiKey: ' sk-test ', model: 'tts-1', voice: 'onyx', fetch: f });
    const out = await tts.synthesize('Hello.');
    expect(out).toEqual({ audio: Buffer.from('mp3-bytes'), contentType: 'audio/mpeg' });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe('https://api.openai.com/v1/audio/speech');
    expect(sent[0]!.init.method).toBe('POST');
    expect(headers(sent[0]!.init)).toEqual({ authorization: 'Bearer sk-test', 'content-type': 'application/json' });
    expect(JSON.parse(String(sent[0]!.init.body))).toEqual({ model: 'tts-1', voice: 'onyx', input: 'Hello.', response_format: 'mp3' });
  });

  it('cuts the text at 4,000 characters, as before', async () => {
    const { f, sent } = fetcher(() => audio('x'));
    await openAiTts({ apiKey: 'k', model: 'tts-1', voice: 'onyx', fetch: f }).synthesize('x'.repeat(5000));
    expect(TTS_MAX_CHARS).toBe(4000);
    expect((JSON.parse(String(sent[0]!.init.body)) as { input: string }).input).toHaveLength(4000);
  });

  it('with no key it does not ask at all: null, and the client uses its own voice', async () => {
    const { f, sent } = fetcher(() => audio('x'));
    for (const apiKey of [undefined, '', '   ']) expect(await openAiTts({ apiKey, model: 'tts-1', voice: 'onyx', fetch: f }).synthesize('Hello.')).toBeNull();
    expect(sent).toEqual([]);
  });

  it('a failure is the status and nothing of what the service said', async () => {
    const { f } = fetcher(() => new Response('{"error":{"message":"Incorrect API key provided: sk-SECRET"}}', { status: 401 }));
    const err = await openAiTts({ apiKey: 'k', model: 'tts-1', voice: 'onyx', fetch: f }).synthesize('Hello.').catch((e: Error) => e);
    expect((err as Error).message).toBe('tts HTTP 401');
  });

  it('is an OUTSIDE service, billed to OpenAI', () => {
    expect(openAiTts({ apiKey: 'k', model: 'tts-1-hd', voice: 'nova' })).toMatchObject({ name: 'openai', local: false, vendor: 'openai', model: 'tts-1-hd', voice: 'nova' });
  });

  it('tells a caller that measures it when the first audio arrives', async () => {
    let first = 0;
    const { f } = fetcher(() => audio('mp3'));
    await openAiTts({ apiKey: 'k', model: 'tts-1', voice: 'onyx', fetch: f }).synthesize('Hi.', { onFirstAudio: () => (first += 1) });
    expect(first).toBe(1);
  });
});

describe('an OpenAI-compatible local speech server: speaking', () => {
  const make = (answer: (url: string, init: RequestInit) => Response, over: Partial<Parameters<typeof openAiCompatTts>[0]> = {}) => {
    const { f, sent } = fetcher(answer);
    return { tts: openAiCompatTts({ baseURL: 'http://127.0.0.1:8880/v1', model: 'kokoro', voice: 'af_heart', fetch: f, ...over }), sent };
  };

  it('posts the model, the voice and the text to /audio/speech, and hands back the audio as the kind the server says it is', async () => {
    const { tts, sent } = make(() => audio('wav-bytes', 'audio/wav; charset=binary'));
    expect(await tts.synthesize('Hello.')).toEqual({ audio: Buffer.from('wav-bytes'), contentType: 'audio/wav' });
    expect(sent[0]!.url).toBe('http://127.0.0.1:8880/v1/audio/speech');
    expect(JSON.parse(String(sent[0]!.init.body))).toEqual({ model: 'kokoro', voice: 'af_heart', input: 'Hello.', response_format: 'mp3' });
    expect(headers(sent[0]!.init)).toEqual({ 'content-type': 'application/json' });
    expect(sent[0]!.init.signal).toBeInstanceOf(AbortSignal);
  });

  it('a key is sent only when there is one', async () => {
    const { tts, sent } = make(() => audio('x'), { apiKey: 'local-key' });
    await tts.synthesize('Hello.');
    expect(headers(sent[0]!.init).authorization).toBe('Bearer local-key');
  });

  it('a kind of audio it does not know is treated as the mp3 it asked for; no audio, too much, and an error are failures', async () => {
    expect((await make(() => audio('x', 'text/html')).tts.synthesize('Hi.'))!.contentType).toBe('audio/mpeg');
    await expect(make(() => new Response('', { status: 200 })).tts.synthesize('Hi.')).rejects.toThrow('tts answered with no audio');
    const err = await make(() => new Response('the text you sent was: SECRET', { status: 500 })).tts.synthesize('Hi.').catch((e: Error) => e);
    expect((err as Error).message).toBe('tts HTTP 500');
  });

  it('its words stay here (config lets it be at no address that is not), and it bills nobody', () => {
    expect(make(() => audio('x')).tts).toMatchObject({ name: 'local', local: true, model: 'kokoro', voice: 'af_heart' });
    expect(make(() => audio('x')).tts.vendor).toBeUndefined();
  });
});

describe('an OpenAI-compatible local speech server: hearing', () => {
  it('on a Mac the recording is made into WAV first, then posted as multipart to /audio/transcriptions', async () => {
    const { run, ran } = runner();
    const { f, sent } = fetcher(() => Response.json({ text: '  Hello   there. ' }));
    const stt = openAiCompatStt({ baseURL: 'http://127.0.0.1:8081/v1', model: 'whisper-1', fetch: f, run, convert: true });
    expect(await stt.transcribe(Buffer.from('m4a-recording'))).toEqual({ text: 'Hello there.' });
    expect(ran.map((r) => r.file)).toEqual(['/usr/bin/afconvert']);
    expect(ran[0]!.args.slice(2)).toEqual(['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1']);
    // The recording was written for this user only, in a directory for this user only, and both are gone.
    expect(ran[0]!.files[ran[0]!.args[0]!]).toEqual({ text: 'm4a-recording', mode: 0o600, dirMode: 0o700 });
    expect(existsSync(dirname(ran[0]!.args[0]!))).toBe(false);
    expect(sent[0]!.url).toBe('http://127.0.0.1:8081/v1/audio/transcriptions');
    const body = sent[0]!.init.body as FormData;
    expect(body.get('model')).toBe('whisper-1');
    expect(body.get('response_format')).toBe('json');
    const file = body.get('file') as File;
    expect(file.name).toBe('audio.wav');
    expect(file.type).toBe('audio/wav');
    expect(await file.text()).toBe('RIFF-wav-bytes');
    // No content-type of its own: fetch writes the multipart boundary.
    expect(headers(sent[0]!.init)).toEqual({});
  });

  it('off a Mac, or when told not to, the recording is posted as it is, and no program runs', async () => {
    const { run, ran } = runner();
    const { f, sent } = fetcher(() => Response.json({ text: 'ok' }));
    await openAiCompatStt({ baseURL: 'http://127.0.0.1:8081/v1', model: 'm', fetch: f, run, convert: false, apiKey: 'k' }).transcribe(Buffer.from('raw'));
    expect(ran).toEqual([]);
    expect(await ((sent[0]!.init.body as FormData).get('file') as File).text()).toBe('raw');
    expect(headers(sent[0]!.init)).toEqual({ authorization: 'Bearer k' });
  });

  it('an error, and an answer with no text, are failures that say nothing of what was sent', async () => {
    const stt = (answer: () => Response) => openAiCompatStt({ baseURL: 'http://127.0.0.1:1/v1', model: 'm', fetch: fetcher(answer).f, convert: false });
    expect(((await stt(() => new Response('your audio said: SECRET', { status: 500 })).transcribe(Buffer.from('a')).catch((e: Error) => e)) as Error).message).toBe('stt HTTP 500');
    await expect(stt(() => Response.json({ words: [] })).transcribe(Buffer.from('a'))).rejects.toThrow('stt answered without text');
    await expect(stt(() => new Response('not json', { status: 200 })).transcribe(Buffer.from('a'))).rejects.toThrow('stt answered without text');
  });
});

describe("the Mac's own say", () => {
  it('runs /usr/bin/say with fixed arguments, the text in a file, and hands back the m4a it wrote', async () => {
    const { run, ran } = runner({ sayWrites: 'aac-audio' });
    const tts = macSayTts({ run });
    expect(await tts.synthesize('Hello there.')).toEqual({ audio: Buffer.from('aac-audio'), contentType: 'audio/mp4' });
    expect(ran).toHaveLength(1);
    const call = ran[0]!;
    expect(call.file).toBe('/usr/bin/say');
    expect(call.args).toHaveLength(6);
    expect(call.args[0]).toBe('-o');
    expect(call.args[1]).toMatch(/flint-say-[^/]+\/speech\.m4a$/);
    expect(call.args.slice(2, 5)).toEqual(['--file-format=m4af', '--data-format=aac', '-f']);
    expect(call.args[5]).toMatch(/flint-say-[^/]+\/text\.txt$/);
    // An empty environment, and a hard time limit a program cannot ignore.
    expect(call.opts).toEqual({ timeout: 30_000, killSignal: 'SIGKILL', env: {} });
  });

  it('the text is NEVER an argument: not as it is, and not when it looks like options', async () => {
    for (const text of ['Hello there.', '-v Bad News --help', '--file-format=WAVE -o /tmp/x', '; rm -rf ~', '$(reboot)', '`id`', '-']) {
      const { run, ran } = runner();
      await macSayTts({ run, voice: 'Samantha' }).synthesize(text);
      const call = ran[0]!;
      // No argument is the text, and (for anything longer than a mark) no argument holds it.
      expect(call.args, text).not.toContain(text);
      if (text.length > 1) expect(call.args.join('\u0000'), text).not.toContain(text);
      // It is in the file `-f` names, whole.
      expect(call.files[call.args[call.args.indexOf('-f') + 1]!]!.text, text).toBe(text);
      // Every argument is one of the fixed ones, a path in the private directory, or the checked voice.
      expect(call.args.filter((a) => !['-o', '--file-format=m4af', '--data-format=aac', '-f', '-v', 'Samantha'].includes(a) && !/\/flint-say-[^/]+\/(speech\.m4a|text\.txt)$/.test(a))).toEqual([]);
    }
  });

  it('the text and the audio are files only this user can read, in a directory only this user can read, removed whatever happens', async () => {
    const { run, ran } = runner();
    await macSayTts({ run }).synthesize('Private words.');
    const call = ran[0]!;
    const out = call.args[1]!;
    const textFile = call.args[5]!;
    expect(call.files[textFile]).toEqual({ text: 'Private words.', mode: 0o600, dirMode: 0o700 });
    // The audio file exists, private, BEFORE say writes into it.
    expect(call.files[out]).toEqual({ text: '', mode: 0o600, dirMode: 0o700 });
    expect(existsSync(dirname(out))).toBe(false);
    const failing = runner({ fail: 'say' });
    await expect(macSayTts({ run: failing.run }).synthesize('Private words.')).rejects.toThrow('say failed');
    expect(existsSync(dirname(failing.ran[0]!.args[1]!))).toBe(false);
    // Nothing of a past call is left in the temp directory by name either.
    expect(readdirSync(dirname(dirname(out))).filter((n) => n === dirname(out).split('/').pop())).toEqual([]);
  });

  it('a voice is an argument only when it is a voice name: letters, spaces, brackets and hyphens, starting with a letter', () => {
    for (const good of ['Samantha', 'Daniel', 'Eddy (English (US))', 'Bad News', 'Zoe (Premium)', 'Anna-Marie']) {
      expect(macSayTts({ voice: good }).voice, good).toBe(good);
    }
    for (const bad of ['-v', '--help', '-o /tmp/x', 'Samantha; rm -rf ~', 'Sam$(id)', '', ' Samantha', 'x'.repeat(41), 'Voice/../../x', 'Sam\nantha', '1984', 'Zoë']) {
      expect(() => macSayTts({ voice: bad }), JSON.stringify(bad)).toThrow('the say voice is not a voice name');
    }
  });

  it('with a voice, the last two arguments are -v and the name; with none, there is no -v', async () => {
    const withVoice = runner();
    await macSayTts({ run: withVoice.run, voice: 'Eddy (English (US))' }).synthesize('Hi.');
    expect(withVoice.ran[0]!.args.slice(-2)).toEqual(['-v', 'Eddy (English (US))']);
    const none = runner();
    await macSayTts({ run: none.run }).synthesize('Hi.');
    expect(none.ran[0]!.args).not.toContain('-v');
  });

  it('cuts the text at 4,000 characters, and a say that wrote nothing is a failure', async () => {
    const { run, ran } = runner();
    await macSayTts({ run }).synthesize('y'.repeat(5000));
    expect(ran[0]!.files[ran[0]!.args[5]!]!.text).toHaveLength(4000);
    await expect(macSayTts({ run: runner({ sayWrites: null }).run }).synthesize('Hi.')).rejects.toThrow('say wrote no audio');
  });

  it('is local and free', () => {
    const tts = macSayTts();
    expect(tts).toMatchObject({ name: 'say', local: true });
    expect(tts.vendor).toBeUndefined();
  });
});

describe('off', () => {
  it('makes no speech: null, so the client uses its own voice', async () => {
    expect(await offTts().synthesize('Hello.')).toBeNull();
    expect(offTts()).toMatchObject({ name: 'off', local: true });
  });
});

describe('audioTypeOf', () => {
  it('names a kind of audio a client can be handed, whatever the server calls it', () => {
    expect(audioTypeOf('audio/mpeg', 'audio/wav')).toBe('audio/mpeg');
    expect(audioTypeOf('audio/mp3', 'audio/wav')).toBe('audio/mpeg');
    expect(audioTypeOf('Audio/X-WAV; rate=22050', 'audio/mpeg')).toBe('audio/wav');
    expect(audioTypeOf('audio/x-m4a', 'audio/mpeg')).toBe('audio/mp4');
    for (const t of AUDIO_TYPES) expect(audioTypeOf(t, 'audio/mpeg')).toBe(t);
  });

  it('anything else is the fallback: never a type a server made up', () => {
    for (const odd of [null, undefined, '', 'text/html', 'application/octet-stream', 'audio/../../x', 'audio/mpeg\r\nSet-Cookie: x']) expect(audioTypeOf(odd, 'audio/mpeg'), String(odd)).toBe('audio/mpeg');
  });
});

// ---------------------------------------------------------------------------

describe('planVoice: which provider, from config', () => {
  const plan = (env: Record<string, string> = {}, platform: NodeJS.Platform = 'darwin') => {
    const warned: string[] = [];
    const cfg = readInferenceConfig(env, (m) => warned.push(m));
    return { plan: planVoice(cfg, env, { platform, home: '/home/will' }), cfg, warned };
  };

  it('THE DEFAULTS DO NOT CHANGE: whisper.cpp hears, on this Mac, and OpenAI speaks', () => {
    const { plan: p, cfg, warned } = plan({ OPENAI_API_KEY: 'sk-x' });
    expect(p.stt).toEqual({ name: 'whisper-cpp', local: true, bin: '/opt/homebrew/bin/whisper-cli', model: '/home/will/.flint/models/ggml-base.en.bin' });
    expect(p.tts).toEqual({ name: 'openai', local: false, model: 'tts-1', voice: 'onyx', hasKey: true });
    expect(cfg.problems).toEqual([]);
    expect(warned).toEqual([]);
    expect(voiceLine(p)).toBe('[voice] hearing=whisper-cpp (ggml-base.en.bin) speaking=openai (tts-1, onyx)');
  });

  it('the older keys are read as they always were: WHISPER_BIN, WHISPER_MODEL, FLINT_TTS_MODEL, FLINT_TTS_VOICE', () => {
    const { plan: p } = plan({ WHISPER_BIN: '/x/whisper-cli', WHISPER_MODEL: '/m/ggml-small.en.bin', FLINT_TTS_MODEL: 'tts-1-hd', FLINT_TTS_VOICE: 'nova' });
    expect(p.stt).toMatchObject({ bin: '/x/whisper-cli', model: '/m/ggml-small.en.bin' });
    expect(p.tts).toEqual({ name: 'openai', local: false, model: 'tts-1-hd', voice: 'nova', hasKey: false });
    expect(voiceLine(p)).toBe('[voice] hearing=whisper-cpp (ggml-small.en.bin) speaking=openai (tts-1-hd, nova), no key');
  });

  it("FLINT_TTS_PROVIDER=say: the Mac's own voice, on a Mac; anywhere else speech is off, never OpenAI", () => {
    expect(plan({ FLINT_TTS_PROVIDER: 'say', FLINT_SAY_VOICE: 'Samantha' }).plan.tts).toEqual({ name: 'say', local: true, voice: 'Samantha' });
    expect(plan({ FLINT_TTS_PROVIDER: 'SAY' }).plan.tts).toEqual({ name: 'say', local: true });
    const linux = plan({ FLINT_TTS_PROVIDER: 'say', OPENAI_API_KEY: 'sk-x' }, 'linux').plan;
    expect(linux.tts).toEqual({ name: 'off', local: true, why: 'not_a_mac' });
    expect(voiceLine(linux)).toContain('speaking=off (say needs a Mac)');
  });

  it('a local speech server: both sides, each at its own address, on this Mac', () => {
    const { plan: p, cfg } = plan({
      FLINT_STT_PROVIDER: 'local',
      FLINT_LOCAL_STT_BASE_URL: 'http://localhost:8081',
      FLINT_LOCAL_STT_MODEL: 'small.en',
      FLINT_TTS_PROVIDER: 'local',
      FLINT_LOCAL_TTS_BASE_URL: 'http://127.0.0.1:8880/v1/',
      FLINT_LOCAL_TTS_MODEL: 'kokoro',
      FLINT_LOCAL_TTS_VOICE: 'af_heart',
    });
    expect(cfg.problems).toEqual([]);
    // `localhost` is pinned to 127.0.0.1, and an address with no path gets /v1: the same parser as the model server's.
    expect(p.stt).toMatchObject({ name: 'local', local: true, model: 'small.en', server: { baseURL: 'http://127.0.0.1:8081/v1', host: '127.0.0.1:8081', loopback: true } });
    expect(p.tts).toMatchObject({ name: 'local', local: true, model: 'kokoro', voice: 'af_heart', server: { baseURL: 'http://127.0.0.1:8880/v1', loopback: true } });
    expect(voiceLine(p)).toBe('[voice] hearing=local server 127.0.0.1:8081 (small.en) speaking=local server 127.0.0.1:8880 (kokoro, af_heart)');
  });

  it('a local speech server with defaults for the model and the voice', () => {
    const { plan: p } = plan({ FLINT_STT_PROVIDER: 'local', FLINT_LOCAL_STT_BASE_URL: 'http://127.0.0.1:8081/v1', FLINT_TTS_PROVIDER: 'local', FLINT_LOCAL_TTS_BASE_URL: 'http://127.0.0.1:8880/v1' });
    expect(p.stt).toMatchObject({ model: 'whisper-1' });
    expect(p.tts).toMatchObject({ model: 'tts-1', voice: 'alloy' });
  });

  it('off is off', () => {
    const { plan: p, cfg } = plan({ FLINT_TTS_PROVIDER: 'off', OPENAI_API_KEY: 'sk-x' });
    expect(p.tts).toEqual({ name: 'off', local: true, why: 'set' });
    expect(cfg.problems).toEqual([]);
    expect(voiceLine(p)).toContain('speaking=off (set)');
  });
});

describe('a refused voice setting never lands on a less private choice, and never stops Flint', () => {
  const plan = (env: Record<string, string>) => {
    const warned: string[] = [];
    const cfg = readInferenceConfig(env, (m) => warned.push(m));
    return { plan: planVoice(cfg, env, { platform: 'darwin', home: '/h' }), cfg, warned };
  };

  it('a speech provider Flint does not know is NO speech here, never the outside service a typo did not ask for', () => {
    for (const typo of ['sya', 'local-tts', 'openai ', 'none', 'macos', 'OpenAI!', '1']) {
      const { plan: p, cfg, warned } = plan({ FLINT_TTS_PROVIDER: typo, OPENAI_API_KEY: 'sk-x' });
      if (typo.trim().toLowerCase() === 'openai') {
        expect(p.tts.name).toBe('openai');
        continue;
      }
      expect(p.tts, typo).toEqual({ name: 'off', local: true, why: 'invalid' });
      expect(cfg.problems, typo).toEqual([{ key: 'FLINT_TTS_PROVIDER', reason: 'not one of openai, local, say, off', kind: 'invalid' }]);
      expect(warned, typo).toEqual(['[inference] FLINT_TTS_PROVIDER is not one of openai, local, say, off; no speech is made here, so each device uses its own voice']);
      // The value is never repeated.
      expect(JSON.stringify(cfg.problems) + warned.join(''), typo).not.toContain(`"${typo}"`);
    }
  });

  it('a hearing provider Flint does not know is whisper.cpp: this Mac, the most private there is', () => {
    const { plan: p, cfg } = plan({ FLINT_STT_PROVIDER: 'cloud' });
    expect(p.stt.name).toBe('whisper-cpp');
    expect(cfg.problems).toEqual([{ key: 'FLINT_STT_PROVIDER', reason: 'not one of whisper-cpp, local', kind: 'invalid' }]);
  });

  it('speaking on a local server with no address, or a refused one, is OFF: OpenAI never takes its place', () => {
    const unset = plan({ FLINT_TTS_PROVIDER: 'local', OPENAI_API_KEY: 'sk-x' });
    expect(unset.plan.tts).toEqual({ name: 'off', local: true, why: 'no_server' });
    expect(unset.cfg.problems).toEqual([{ key: 'FLINT_LOCAL_TTS_BASE_URL', reason: 'not set', kind: 'unset' }]);
    expect(voiceLine(unset.plan)).toContain('speaking=off (no local speech server)');
    const cases: Array<[string, string]> = [
      ['nonsense', 'not_a_url'],
      ['ftp://127.0.0.1:1', 'not_http'],
      ['http://u:p@127.0.0.1:1/v1', 'has_credentials'],
      ['http://127.0.0.1:1/v1?key=1', 'has_query'],
      ['http://127.0.0.1:1/a/b/c/d', 'bad_path'],
      ['http://speech.example:8880/v1', 'not_loopback'],
      ['https://speech.example/v1', 'not_loopback'],
    ];
    for (const [url, kind] of cases) {
      const { plan: p, cfg, warned } = plan({ FLINT_TTS_PROVIDER: 'local', FLINT_LOCAL_TTS_BASE_URL: url, OPENAI_API_KEY: 'sk-x' });
      expect(p.tts, url).toEqual({ name: 'off', local: true, why: 'no_server' });
      expect(cfg.problems.map((x) => [x.key, x.kind]), url).toEqual([['FLINT_LOCAL_TTS_BASE_URL', kind]]);
      expect(warned[0], url).toContain('no speech is made here, so each device uses its own voice');
      expect(warned.join(''), url).not.toContain('u:p');
    }
  });

  it('hearing on a local server with no address, or a refused one, stays on whisper.cpp, on this Mac', () => {
    expect(plan({ FLINT_STT_PROVIDER: 'local' }).plan.stt.name).toBe('whisper-cpp');
    expect(plan({ FLINT_STT_PROVIDER: 'local' }).cfg.problems).toEqual([{ key: 'FLINT_LOCAL_STT_BASE_URL', reason: 'not set', kind: 'unset' }]);
    const refused = plan({ FLINT_STT_PROVIDER: 'local', FLINT_LOCAL_STT_BASE_URL: 'http://stt.example:9000/v1' });
    expect(refused.plan.stt.name).toBe('whisper-cpp');
    expect(refused.cfg.problems.map((x) => [x.key, x.kind])).toEqual([['FLINT_LOCAL_STT_BASE_URL', 'not_loopback']]);
    expect(refused.warned[0]).toContain('transcription stays on whisper-cpp, on this Mac');
  });

  it('a server address that is set but not asked for is still checked, and is not a problem for being unused', () => {
    const { cfg } = plan({ FLINT_LOCAL_TTS_BASE_URL: 'http://127.0.0.1:8880/v1' });
    expect(cfg.problems).toEqual([]);
    expect(cfg.voice.tts).toBe('openai');
  });

  // The remote switch vouches for the local model server and for no other machine (the same rule OLLAMA_HOST has):
  // a speech server is on this Mac, or at that server's own address.
  it('another machine is refused, whatever the remote switch says: a speech server runs on this Mac, or at the model server Will allowed', () => {
    const base = { FLINT_TTS_PROVIDER: 'local', FLINT_STT_PROVIDER: 'local' };
    const elsewhere = { FLINT_LOCAL_TTS_BASE_URL: 'https://speech.example/v1', FLINT_LOCAL_STT_BASE_URL: 'https://speech.example/v1' };
    // No switch: not on this Mac.
    const off = plan({ ...base, ...elsewhere });
    expect(off.plan.tts).toEqual({ name: 'off', local: true, why: 'no_server' });
    expect(off.plan.stt.name).toBe('whisper-cpp');
    expect(off.cfg.problems.map((x) => [x.key, x.kind])).toEqual([
      ['FLINT_LOCAL_STT_BASE_URL', 'not_loopback'],
      ['FLINT_LOCAL_TTS_BASE_URL', 'not_loopback'],
    ]);
    // The switch on, over https, and it is still some other machine: refused, by its own reason.
    for (const more of [{}, { FLINT_LOCAL_ALLOW_INSECURE_REMOTE: '1' }, { FLINT_LOCAL_PROVIDER: 'openai', FLINT_LOCAL_BASE_URL: 'https://gpu-box.example/v1' }, { OLLAMA_HOST: 'https://gpu-box.example:11434' }]) {
      const on = plan({ ...base, ...elsewhere, FLINT_LOCAL_ALLOW_REMOTE: '1', ...more });
      expect(on.plan.tts, JSON.stringify(more)).toEqual({ name: 'off', local: true, why: 'no_server' });
      expect(on.plan.stt.name, JSON.stringify(more)).toBe('whisper-cpp');
      expect(on.cfg.problems.map((x) => [x.key, x.kind]), JSON.stringify(more)).toEqual([
        ['FLINT_LOCAL_STT_BASE_URL', 'other_machine'],
        ['FLINT_LOCAL_TTS_BASE_URL', 'other_machine'],
      ]);
      expect(on.warned.join('\n'), JSON.stringify(more)).not.toContain('speech.example');
    }
    // The model server he allowed, at its own address (both wires): its speech routes are that server's.
    const openai = plan({ ...base, FLINT_LOCAL_ALLOW_REMOTE: '1', FLINT_LOCAL_PROVIDER: 'openai', FLINT_LOCAL_BASE_URL: 'https://gpu-box.example/v1', FLINT_LOCAL_TTS_BASE_URL: 'https://gpu-box.example/v1', FLINT_LOCAL_STT_BASE_URL: 'https://gpu-box.example/v1' });
    expect(openai.cfg.problems).toEqual([]);
    expect(openai.plan.tts).toMatchObject({ name: 'local', local: true, server: { loopback: false, secure: true } });
    expect(openai.plan.stt).toMatchObject({ name: 'local', local: true });
    const native = plan({ ...base, FLINT_LOCAL_ALLOW_REMOTE: '1', OLLAMA_HOST: 'https://gpu-box.example:11434', FLINT_LOCAL_TTS_BASE_URL: 'https://gpu-box.example:11434/v1', FLINT_LOCAL_STT_BASE_URL: 'https://gpu-box.example:11434/v1' });
    expect(native.cfg.problems).toEqual([]);
    expect(native.plan.tts).toMatchObject({ name: 'local', local: true });
    // ...but not the wire that is not in use, and not another port of that machine.
    const other = plan({ ...base, FLINT_LOCAL_ALLOW_REMOTE: '1', FLINT_LOCAL_BASE_URL: 'https://gpu-box.example/v1', FLINT_LOCAL_TTS_BASE_URL: 'https://gpu-box.example/v1', FLINT_LOCAL_STT_BASE_URL: 'https://gpu-box.example:8443/v1' });
    expect(other.cfg.problems.map((x) => [x.key, x.kind])).toEqual([
      ['FLINT_LOCAL_STT_BASE_URL', 'other_machine'],
      ['FLINT_LOCAL_TTS_BASE_URL', 'other_machine'],
    ]);
    // Plain http to it only when he also said its network is private, as for the model server itself.
    const plainEnv = { ...base, FLINT_LOCAL_ALLOW_REMOTE: '1', FLINT_LOCAL_PROVIDER: 'openai', FLINT_LOCAL_BASE_URL: 'http://gpu-box.example:8880/v1', FLINT_LOCAL_TTS_BASE_URL: 'http://gpu-box.example:8880/v1' };
    const plain = plan(plainEnv);
    expect(plain.plan.tts).toEqual({ name: 'off', local: true, why: 'no_server' });
    expect(plain.cfg.problems.map((x) => [x.key, x.kind])).toContainEqual(['FLINT_LOCAL_TTS_BASE_URL', 'insecure_remote']);
    const allowed = plan({ ...plainEnv, FLINT_LOCAL_ALLOW_INSECURE_REMOTE: '1' });
    expect(allowed.plan.tts).toMatchObject({ name: 'local', local: true, server: { secure: false } });
  });

  it("a speech server that Node's env proxy would carry the request to is not this Mac: refused", () => {
    const env = { FLINT_TTS_PROVIDER: 'local', FLINT_STT_PROVIDER: 'local', FLINT_LOCAL_TTS_BASE_URL: 'http://127.0.0.1:8880/v1', FLINT_LOCAL_STT_BASE_URL: 'http://127.0.0.1:8081/v1' };
    const proxied = plan({ ...env, NODE_USE_ENV_PROXY: '1', HTTP_PROXY: 'http://proxy.example:3128' });
    expect(proxied.plan.tts).toEqual({ name: 'off', local: true, why: 'no_server' });
    expect(proxied.plan.stt.name).toBe('whisper-cpp');
    expect(proxied.cfg.problems.map((x) => [x.key, x.kind])).toEqual([
      ['FLINT_LOCAL_STT_BASE_URL', 'proxied'],
      ['FLINT_LOCAL_TTS_BASE_URL', 'proxied'],
    ]);
    // Kept direct by name: this Mac again.
    const direct = plan({ ...env, NODE_USE_ENV_PROXY: '1', HTTP_PROXY: 'http://proxy.example:3128', NO_PROXY: '127.0.0.1' });
    expect(direct.cfg.problems).toEqual([]);
    expect(direct.plan.tts).toMatchObject({ name: 'local', local: true });
  });

  it('a key is never sent in the clear to another machine: it is dropped, and the log says so without the key', () => {
    const env = { FLINT_TTS_PROVIDER: 'local', FLINT_LOCAL_ALLOW_REMOTE: '1', FLINT_LOCAL_ALLOW_INSECURE_REMOTE: '1', FLINT_LOCAL_PROVIDER: 'openai', FLINT_LOCAL_BASE_URL: 'http://gpu-box.example:8880/v1', FLINT_LOCAL_TTS_BASE_URL: 'http://gpu-box.example:8880/v1', FLINT_LOCAL_VOICE_API_KEY: 'voice-key-SECRET' };
    const { plan: p, cfg, warned } = plan(env);
    expect(p.tts).toMatchObject({ name: 'local' });
    expect((p.tts as { apiKey?: string }).apiKey).toBeUndefined();
    expect(cfg.problems).toEqual([{ key: 'FLINT_LOCAL_VOICE_API_KEY', reason: 'not sent over plain http to another machine', kind: 'in_the_clear' }]);
    expect(JSON.stringify(cfg) + warned.join('') + voiceLine(p)).not.toContain('SECRET');
    // Over https, or to this Mac, it is sent.
    const safe = plan({ ...env, FLINT_LOCAL_BASE_URL: 'https://gpu-box.example/v1', FLINT_LOCAL_TTS_BASE_URL: 'https://gpu-box.example/v1' });
    expect((safe.plan.tts as { apiKey?: string }).apiKey).toBe('voice-key-SECRET');
    expect(voiceLine(safe.plan)).not.toContain('SECRET');
    const here = plan({ FLINT_TTS_PROVIDER: 'local', FLINT_LOCAL_TTS_BASE_URL: 'http://127.0.0.1:8880/v1', FLINT_LOCAL_VOICE_API_KEY: 'voice-key-SECRET' });
    expect((here.plan.tts as { apiKey?: string }).apiKey).toBe('voice-key-SECRET');
  });

  it('a voice, a model and a key that are not plain names are refused by name, never by value, and the default is used', () => {
    const { plan: p, cfg, warned } = plan({
      FLINT_TTS_PROVIDER: 'say',
      FLINT_SAY_VOICE: '-o /tmp/x',
      FLINT_LOCAL_TTS_VOICE: 'af heart; rm',
      FLINT_LOCAL_TTS_MODEL: '../../etc/passwd',
      FLINT_LOCAL_STT_MODEL: '--help',
      FLINT_LOCAL_VOICE_API_KEY: 'has space SECRET',
    });
    expect(p.tts).toEqual({ name: 'say', local: true });
    expect(cfg.voice).toMatchObject({ sayVoice: undefined, ttsVoice: 'alloy', ttsModel: 'tts-1', sttModel: 'whisper-1', apiKey: undefined });
    expect(cfg.problems.map((x) => x.key).sort()).toEqual(['FLINT_LOCAL_STT_MODEL', 'FLINT_LOCAL_TTS_MODEL', 'FLINT_LOCAL_TTS_VOICE', 'FLINT_LOCAL_VOICE_API_KEY', 'FLINT_SAY_VOICE']);
    const said = JSON.stringify(cfg.problems) + warned.join('\n');
    for (const value of ['/tmp/x', 'rm', 'passwd', '--help', 'SECRET']) expect(said).not.toContain(value);
  });
});

describe('buildVoice: the providers a plan names', () => {
  const env = { OPENAI_API_KEY: 'sk-x' };
  const built = (vars: Record<string, string>, f?: typeof fetch) => {
    const all = { ...env, ...vars };
    const plan = planVoice(readInferenceConfig(all), all, { platform: 'darwin', home: '/h' });
    return buildVoice(plan, { env: all, ...(f ? { fetch: f } : {}), connect: async () => {}, connectTimeoutMs: 50 });
  };

  it('the defaults: whisper.cpp and OpenAI', () => {
    const v = built({});
    expect(v.stt).toMatchObject({ name: 'whisper-cpp', local: true });
    expect(v.tts).toMatchObject({ name: 'openai', local: false, vendor: 'openai', model: 'tts-1', voice: 'onyx' });
  });

  it('say, off, and a local server on each side', () => {
    expect(built({ FLINT_TTS_PROVIDER: 'say', FLINT_SAY_VOICE: 'Daniel' }).tts).toMatchObject({ name: 'say', local: true, voice: 'Daniel' });
    expect(built({ FLINT_TTS_PROVIDER: 'off' }).tts).toMatchObject({ name: 'off' });
    const v = built({ FLINT_TTS_PROVIDER: 'local', FLINT_LOCAL_TTS_BASE_URL: 'http://127.0.0.1:8880/v1', FLINT_STT_PROVIDER: 'local', FLINT_LOCAL_STT_BASE_URL: 'http://127.0.0.1:8081/v1' });
    expect(v.tts).toMatchObject({ name: 'local', local: true });
    expect(v.stt).toMatchObject({ name: 'local', local: true });
  });

  it('a local speech server is reached through the guarded fetch: its own two paths, its own origin, and never a redirect', async () => {
    const { f, sent } = fetcher(() => audio('x'));
    const v = built({ FLINT_TTS_PROVIDER: 'local', FLINT_LOCAL_TTS_BASE_URL: 'http://127.0.0.1:8880/v1', FLINT_LOCAL_VOICE_API_KEY: 'k' }, f);
    await v.tts.synthesize('Hello.');
    expect(sent[0]!.url).toBe('http://127.0.0.1:8880/v1/audio/speech');
    expect(sent[0]!.init.redirect).toBe('error');
    expect(headers(sent[0]!.init).authorization).toBe('Bearer k');
    expect(speechPaths('/v1')).toEqual(['/v1/audio/transcriptions', '/v1/audio/speech']);
  });

  it('the OpenAI provider is NOT behind the local guard, and the local one cannot be pointed anywhere else', async () => {
    const { f, sent } = fetcher(() => audio('x'));
    await built({}, f).tts.synthesize('Hello.');
    expect(sent[0]!.url).toBe('https://api.openai.com/v1/audio/speech');
    // The local provider's fetch refuses any other address or path, whatever a caller hands it.
    const { f: g, sent: reached } = fetcher(() => audio('x'));
    const guarded = buildVoice(
      planVoice(readInferenceConfig({ FLINT_TTS_PROVIDER: 'local', FLINT_LOCAL_TTS_BASE_URL: 'http://127.0.0.1:8880/v1' }), {}, { platform: 'darwin', home: '/h' }),
      { env: {}, fetch: g, connect: async () => {} },
    );
    await guarded.tts.synthesize('Hello.');
    expect(reached).toHaveLength(1);
    expect(new URL(reached[0]!.url).origin).toBe('http://127.0.0.1:8880');
  });
});
