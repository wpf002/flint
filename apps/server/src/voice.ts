/**
 * Voice: what turns Will's speech into text, and what speaks a reply.
 *
 * Two small interfaces, `SttProvider` and `TtsProvider`, and the providers
 * behind them. `/transcribe` and `/speak` call the interfaces; which provider
 * answers is config (./inference-config, FLINT_STT_PROVIDER and
 * FLINT_TTS_PROVIDER). The defaults are what Flint did before there was a seam:
 * whisper.cpp hears, on this Mac, and OpenAI speaks.
 *
 *   hearing   whisper-cpp   whisper.cpp's `whisper-cli`, on this Mac (the default)
 *             local         any OpenAI-compatible speech server (`/v1/audio/transcriptions`)
 *   speaking  openai        OpenAI's speech API (the default): an OUTSIDE service
 *             local         any OpenAI-compatible speech server (`/v1/audio/speech`)
 *             say           the Mac's own `say`
 *             off           nothing here: each device speaks with its own voice
 *
 * `local` on a provider says where the words go. True: they stay on this Mac
 * (or on the local model server Will said is his: config lets a speech server
 * be at no other address, ./inference-config). False: they are sent to
 * somebody else's service, and today that is OpenAI alone. A reply that must
 * stay on this Mac is never given to a provider that is not local
 * (./speech-route).
 *
 * Programs are run with `execFile`: an absolute path, fixed arguments, never a
 * shell. Text is never an argument: `say` reads it from a file, so text that
 * starts with a hyphen cannot become an option. A voice's name is checked
 * against a strict pattern before it is one.
 *
 * `say` is a program started for each reply, so it is held to two at a time
 * with a short line behind them (`sayLine`): past that a reply is refused with
 * `SpeechBusy`, and the device speaks it itself. A client that hangs up takes
 * its `say` with it: the program is stopped and its files are removed.
 *
 * Kept free of index.ts so it is unit-testable (index.ts runs main() on import).
 */
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, platform as osPlatform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { SAY_VOICE_RE, type InferenceConfig, type LocalUrlOk, type SttProviderKind, type TtsProviderKind } from './inference-config';
import { guardedFetch } from './local-backend';

/** The kinds of audio a provider may hand back. `/speak` answers with the provider's own. */
export const AUDIO_TYPES = ['audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/aac', 'audio/ogg', 'audio/flac'] as const;
export type AudioType = (typeof AUDIO_TYPES)[number];

/** A spoken reply: the audio, and what kind it is. */
export interface Speech {
  audio: Buffer;
  contentType: AudioType;
}

export interface SttProvider {
  readonly name: SttProviderKind;
  /** Does the audio stay on this Mac (or a machine Will said is his)? */
  readonly local: boolean;
  /** The engine's model, as a status may name it: a file's name or a model's id, never a path. */
  readonly model?: string;
  transcribe(audio: Buffer, opts?: { signal?: AbortSignal }): Promise<{ text: string }>;
}

export interface TtsProvider {
  readonly name: TtsProviderKind;
  /** Do the words stay on this Mac (or a machine Will said is his)? */
  readonly local: boolean;
  /** The vendor a call is billed to, for the spend guard. Undefined: free. */
  readonly vendor?: 'openai';
  readonly model?: string;
  readonly voice?: string;
  /**
   * The text as speech. `null`: this provider cannot speak right now for a
   * reason that is not an error (no key, or it is `off`), and the client uses
   * its own voice. `onFirstAudio` is called when the first audio arrives, for a
   * caller that measures it. Throws `SpeechBusy` when a provider on this Mac
   * already has as many replies in hand as it takes.
   */
  synthesize(text: string, opts?: { signal?: AbortSignal; onFirstAudio?: () => void }): Promise<Speech | null>;
}

export interface Voice {
  stt: SttProvider;
  tts: TtsProvider;
}

/** The longest text one `/speak` sends to a provider. */
export const TTS_MAX_CHARS = 4000;

/** The most audio a speech provider's answer may be. */
export const MAX_SPEECH_BYTES = 32 * 1024 * 1024;
/** The most a transcription server's answer may be: a transcript is text, and a megabyte of it is hours of speech. */
export const MAX_TRANSCRIPT_BYTES = 1024 * 1024;
const STT_TIMEOUT_MS = 120_000;
const TTS_TIMEOUT_MS = 60_000;
const SAY_TIMEOUT_MS = 30_000;

/** Run a program: its stdout. Rejects when it fails, and when `signal` fires (the program is then stopped with `killSignal`). Never a shell. */
export type Run = (
  file: string,
  args: readonly string[],
  opts?: { maxBuffer?: number; timeout?: number; killSignal?: NodeJS.Signals; env?: Record<string, string>; signal?: AbortSignal },
) => Promise<{ stdout: string }>;

/** The real runner: `execFile` on the file as given, with the arguments as given. */
export const runFile: Run = (file, args, opts = {}) =>
  new Promise((resolve, reject) => {
    execFile(file, [...args], { ...opts, shell: false, windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve({ stdout: String(stdout) })));
  });

const AFCONVERT = '/usr/bin/afconvert';
const SAY = '/usr/bin/say';

/** A provider on this Mac already has as many replies in hand as it takes. `/speak` answers 429, and the device speaks this one itself. */
export class SpeechBusy extends Error {
  constructor() {
    super('speech on this Mac is busy');
    this.name = 'SpeechBusy';
  }
}

/** How many `say` run at once, and how many more may wait behind them. */
export const SAY_AT_ONCE = 2;
export const SAY_WAITING = 8;

const hungUp = (): Error => Object.assign(new Error('the caller hung up'), { name: 'AbortError' });

/**
 * A line: at most `atOnce` pieces of work at a time, at most `waiting` behind
 * them, first come first served. One more than that is refused at once with
 * `SpeechBusy`: nothing here grows without bound. A caller whose `signal`
 * fires while it waits leaves the line.
 */
export function sayLine(atOnce: number = SAY_AT_ONCE, waiting: number = SAY_WAITING): <T>(work: () => Promise<T>, signal?: AbortSignal) => Promise<T> {
  let running = 0;
  const line: Array<() => void> = [];
  return async (work, signal) => {
    if (signal?.aborted) throw hungUp();
    if (running < atOnce) running++;
    else {
      if (line.length >= waiting) throw new SpeechBusy();
      // Its place is handed to it by whoever finishes (`go`): `running` does not change hands.
      await new Promise<void>((resolve, reject) => {
        const leave = (): void => {
          const at = line.indexOf(go);
          if (at >= 0) line.splice(at, 1);
          reject(hungUp());
        };
        const go = (): void => {
          signal?.removeEventListener('abort', leave);
          resolve();
        };
        line.push(go);
        signal?.addEventListener('abort', leave, { once: true });
      });
    }
    try {
      return await work();
    } finally {
      const next = line.shift();
      if (next) next();
      else running--;
    }
  };
}
/** What whisper.cpp reads: 16 kHz, mono, 16-bit WAV. (MediaRecorder gives mp4/m4a in WebKit.) */
const TO_WHISPER_WAV = ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1'] as const;

// ---------------------------------------------------------------------------
// hearing

/**
 * Where whisper.cpp and its model are: WHISPER_BIN and WHISPER_MODEL as config
 * took them (./inference-config: full paths, printable), or the usual ones.
 */
export function whisperPaths(v: Pick<InferenceConfig['voice'], 'whisperBin' | 'whisperModel'>, home: string = homedir()): { bin: string; model: string } {
  return {
    bin: v.whisperBin ?? '/opt/homebrew/bin/whisper-cli',
    model: v.whisperModel ?? join(home, '.flint', 'models', 'ggml-base.en.bin'),
  };
}

/** OpenAI's speech model and voice: FLINT_TTS_MODEL and FLINT_TTS_VOICE as config took them, or the usual ones. */
export function openAiSpeech(v: Pick<InferenceConfig['voice'], 'openaiModel' | 'openaiVoice'>): { model: string; voice: string } {
  return { model: v.openaiModel ?? 'tts-1', voice: v.openaiVoice ?? 'onyx' };
}

/** A file's name, for a log or a status: never the folder it is in. */
export const fileNameOf = (path: string): string => path.replace(/^.*[\\/]/, '');

/** Speech-to-text with whisper.cpp, on this Mac (the same pipeline the CLI voice mode uses). */
export function whisperCppStt(opts: { bin: string; model: string; run?: Run }): SttProvider {
  const run = opts.run ?? runFile;
  return {
    name: 'whisper-cpp',
    local: true,
    model: fileNameOf(opts.model),
    async transcribe(audio) {
      const dir = mkdtempSync(join(tmpdir(), 'flint-stt-'));
      try {
        const inFile = join(dir, 'in');
        const wav = join(dir, 'out.wav');
        writeFileSync(inFile, audio);
        await run(AFCONVERT, [inFile, wav, ...TO_WHISPER_WAV]);
        const { stdout } = await run(opts.bin, ['-m', opts.model, '-f', wav, '-nt', '-np'], { maxBuffer: 8 * 1024 * 1024 });
        return { text: stdout.replace(/\s+/g, ' ').trim() };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

/**
 * An answer's body, read whole and never past `max` bytes: past it the read is
 * dropped and this throws `tooMuch`. `onFirst` is called with the first bytes.
 */
async function readCapped(res: Response, max: number, tooMuch: string, onFirst?: () => void): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (res.body) {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.length === 0) continue;
      if (size === 0) onFirst?.();
      size += value.length;
      if (size > max) {
        await reader.cancel().catch(() => {});
        throw new Error(tooMuch);
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks);
}

/** Both deadlines on one signal: the caller's own, and the provider's clock. */
function within(ms: number, outer?: AbortSignal): AbortSignal {
  const clock = AbortSignal.timeout(ms);
  return outer ? AbortSignal.any([outer, clock]) : clock;
}

/**
 * Speech-to-text on any OpenAI-compatible speech server
 * (`POST {base}/audio/transcriptions`, multipart). On a Mac the recording is
 * first made into the WAV every such server reads (16 kHz, mono): what a
 * browser records is mp4, which whisper.cpp's own server does not take.
 */
export function openAiCompatStt(opts: {
  baseURL: string;
  model: string;
  apiKey?: string;
  fetch?: typeof fetch;
  /** Convert to WAV first (`afconvert`). Default: on a Mac. */
  convert?: boolean;
  run?: Run;
  timeoutMs?: number;
}): SttProvider {
  const f = opts.fetch ?? fetch;
  const run = opts.run ?? runFile;
  const convert = opts.convert ?? osPlatform() === 'darwin';
  const toWav = async (audio: Buffer): Promise<Buffer> => {
    const dir = mkdtempSync(join(tmpdir(), 'flint-stt-'));
    try {
      const inFile = join(dir, 'in');
      const wav = join(dir, 'out.wav');
      writeFileSync(inFile, audio, { mode: 0o600 });
      await run(AFCONVERT, [inFile, wav, ...TO_WHISPER_WAV]);
      return readFileSync(wav);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  return {
    name: 'local',
    local: true,
    model: opts.model,
    async transcribe(audio, o = {}) {
      const body = new FormData();
      const sent = convert ? await toWav(audio) : audio;
      body.append('file', new Blob([new Uint8Array(sent)], { type: convert ? 'audio/wav' : 'application/octet-stream' }), convert ? 'audio.wav' : 'audio');
      body.append('model', opts.model);
      body.append('response_format', 'json');
      const res = await f(`${opts.baseURL}/audio/transcriptions`, {
        method: 'POST',
        headers: opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {},
        body,
        signal: within(opts.timeoutMs ?? STT_TIMEOUT_MS, o.signal),
      });
      // The status only: a server's own words can carry what it was sent.
      if (!res.ok) throw new Error(`stt HTTP ${res.status}`);
      // Capped like a speech answer: a server that never stops answering is not read into memory.
      const said = await readCapped(res, MAX_TRANSCRIPT_BYTES, 'stt answered with too much text');
      let json: { text?: unknown } | undefined;
      try {
        json = JSON.parse(said.toString('utf8')) as { text?: unknown };
      } catch {
        json = undefined;
      }
      if (!json || typeof json !== 'object' || typeof json.text !== 'string') throw new Error('stt answered without text');
      return { text: json.text.replace(/\s+/g, ' ').trim() };
    },
  };
}

// ---------------------------------------------------------------------------
// speaking

/** The audio type a response names, when it is one a client can be handed; else `fallback`. */
export function audioTypeOf(header: string | null | undefined, fallback: AudioType): AudioType {
  const type = (header ?? '').split(';')[0]!.trim().toLowerCase();
  const known = type === 'audio/mp3' ? 'audio/mpeg' : type === 'audio/x-wav' || type === 'audio/wave' ? 'audio/wav' : type === 'audio/x-m4a' || type === 'audio/m4a' ? 'audio/mp4' : type;
  return (AUDIO_TYPES as readonly string[]).includes(known) ? (known as AudioType) : fallback;
}

/**
 * A speech API's answer as audio: read whole, the first piece timed for a
 * caller that asks. `allowEmpty`: an answer with no audio is handed on as it
 * is (what the OpenAI path has always done) instead of being an error.
 */
async function readSpeech(res: Response, fallback: AudioType, onFirstAudio?: () => void, allowEmpty = false): Promise<Speech> {
  const audio = await readCapped(res, MAX_SPEECH_BYTES, 'tts answered with too much audio', onFirstAudio);
  if (audio.length === 0 && !allowEmpty) throw new Error('tts answered with no audio');
  return { audio, contentType: audioTypeOf(res.headers.get('content-type'), fallback) };
}

/** Neural text-to-speech for a human voice (OpenAI). With no key it cannot speak, and the client uses its own voice. */
export function openAiTts(opts: { apiKey?: string | undefined; model: string; voice: string; fetch?: typeof fetch }): TtsProvider {
  const f = opts.fetch ?? fetch;
  return {
    name: 'openai',
    local: false,
    vendor: 'openai',
    model: opts.model,
    voice: opts.voice,
    async synthesize(text, o = {}) {
      const key = opts.apiKey?.trim();
      if (!key) return null;
      const r = await f('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: opts.model, voice: opts.voice, input: text.slice(0, TTS_MAX_CHARS), response_format: 'mp3' }),
        ...(o.signal ? { signal: o.signal } : {}),
      });
      if (!r.ok) throw new Error(`tts HTTP ${r.status}`);
      // mp3 was asked for, and a client is told mp3, as it always was: what OpenAI calls its answer is not passed on.
      // An answer with no audio is handed on as it is, as it always was.
      const { audio } = await readSpeech(r, 'audio/mpeg', o.onFirstAudio, true);
      return { audio, contentType: 'audio/mpeg' };
    },
  };
}

/** Text-to-speech on any OpenAI-compatible speech server (`POST {base}/audio/speech`). */
export function openAiCompatTts(opts: { baseURL: string; model: string; voice: string; apiKey?: string; fetch?: typeof fetch; timeoutMs?: number }): TtsProvider {
  const f = opts.fetch ?? fetch;
  return {
    name: 'local',
    local: true,
    model: opts.model,
    voice: opts.voice,
    async synthesize(text, o = {}) {
      const r = await f(`${opts.baseURL}/audio/speech`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}) },
        body: JSON.stringify({ model: opts.model, voice: opts.voice, input: text.slice(0, TTS_MAX_CHARS), response_format: 'mp3' }),
        signal: within(opts.timeoutMs ?? TTS_TIMEOUT_MS, o.signal),
      });
      if (!r.ok) throw new Error(`tts HTTP ${r.status}`);
      return readSpeech(r, 'audio/mpeg', o.onFirstAudio);
    },
  };
}

/**
 * The Mac's own `say`, to a file: AAC in an m4a, which every client here
 * plays. Nothing is played on this Mac's speakers.
 *
 * The text goes in a file (`-f`), never on the command line. The arguments are
 * fixed; the one that varies is the voice, and only a name that passes
 * SAY_VOICE_RE is ever one. The text and the audio live for the length of the
 * call in a directory only this user can read, in files only this user can
 * read, and the directory is removed whatever happens.
 *
 * Each reply is a program of its own, so they are held to a line (`sayLine`):
 * two at a time, a few waiting, and past that `SpeechBusy`. When the caller's
 * `signal` fires (the client hung up), a reply that is waiting leaves the
 * line, and one that is being spoken has its `say` stopped; either way its
 * files are gone when this returns.
 */
export function macSayTts(opts: { voice?: string | undefined; run?: Run; timeoutMs?: number; atOnce?: number; waiting?: number } = {}): TtsProvider {
  if (opts.voice !== undefined && !SAY_VOICE_RE.test(opts.voice)) throw new Error('the say voice is not a voice name');
  const run = opts.run ?? runFile;
  const voice = opts.voice;
  const inLine = sayLine(opts.atOnce, opts.waiting);
  return {
    name: 'say',
    local: true,
    ...(voice ? { voice } : {}),
    synthesize(text, o = {}) {
      return inLine(async () => {
        const dir = mkdtempSync(join(tmpdir(), 'flint-say-'));
        try {
          const textFile = join(dir, 'text.txt');
          const out = join(dir, 'speech.m4a');
          writeFileSync(textFile, text.slice(0, TTS_MAX_CHARS), { mode: 0o600 });
          // The audio file is made here, private, before `say` writes into it.
          writeFileSync(out, '', { mode: 0o600 });
          await run(SAY, ['-o', out, '--file-format=m4af', '--data-format=aac', '-f', textFile, ...(voice ? ['-v', voice] : [])], {
            timeout: opts.timeoutMs ?? SAY_TIMEOUT_MS,
            killSignal: 'SIGKILL',
            env: {},
            ...(o.signal ? { signal: o.signal } : {}),
          });
          const audio = readFileSync(out);
          if (audio.length === 0) throw new Error('say wrote no audio');
          o.onFirstAudio?.();
          return { audio, contentType: 'audio/mp4' as const };
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }, o.signal);
    },
  };
}

/** No speech is made here: the client uses its own voice. */
export function offTts(): TtsProvider {
  return { name: 'off', local: true, synthesize: async () => null };
}

// ---------------------------------------------------------------------------
// which provider

/** What hears and what speaks, decided from config: every setting resolved, nothing built yet. */
export interface VoicePlan {
  stt: { name: 'whisper-cpp'; local: true; bin: string; model: string } | { name: 'local'; local: true; server: LocalUrlOk; model: string; apiKey?: string };
  tts:
    | { name: 'openai'; local: false; model: string; voice: string; hasKey: boolean }
    | { name: 'local'; local: true; server: LocalUrlOk; model: string; voice: string; apiKey?: string }
    | { name: 'say'; local: true; voice?: string }
    | { name: 'off'; local: true; why: 'set' | 'invalid' | 'no_server' | 'not_a_mac' };
}

/**
 * Decide the providers. Config has already refused what it had to
 * (./inference-config); what is decided here is what a setting comes to when
 * the thing it needs is not there, and it is never a less private choice than
 * the one that was meant:
 *  - hearing on a local server with no address (unset, or refused: another machine's, a proxied one): whisper.cpp, on this Mac;
 *  - speaking on a local server with no address: OFF, never OpenAI in its place;
 *  - `say` on a machine that is not a Mac: OFF.
 * Every setting comes from config, checked; `env` is read for one thing only,
 * whether OpenAI has a key.
 */
export function planVoice(cfg: Pick<InferenceConfig, 'voice' | 'problems'>, env: Record<string, string | undefined>, o: { platform?: NodeJS.Platform; home?: string } = {}): VoicePlan {
  const v = cfg.voice;
  const platform = o.platform ?? osPlatform();
  const invalid = (key: string): boolean => cfg.problems.some((p) => p.key === key);
  const stt: VoicePlan['stt'] =
    v.stt === 'local' && v.sttServer
      ? { name: 'local', local: true, server: v.sttServer, model: v.sttModel, ...(v.apiKey ? { apiKey: v.apiKey } : {}) }
      : { name: 'whisper-cpp', local: true, ...whisperPaths(v, o.home) };
  let tts: VoicePlan['tts'];
  if (v.tts === 'openai') {
    tts = { name: 'openai', local: false, ...openAiSpeech(v), hasKey: !!env.OPENAI_API_KEY?.trim() };
  } else if (v.tts === 'local') {
    tts = v.ttsServer
      ? { name: 'local', local: true, server: v.ttsServer, model: v.ttsModel, voice: v.ttsVoice, ...(v.apiKey ? { apiKey: v.apiKey } : {}) }
      : { name: 'off', local: true, why: 'no_server' };
  } else if (v.tts === 'say') {
    tts = platform === 'darwin' ? { name: 'say', local: true, ...(v.sayVoice ? { voice: v.sayVoice } : {}) } : { name: 'off', local: true, why: 'not_a_mac' };
  } else {
    tts = { name: 'off', local: true, why: invalid('FLINT_TTS_PROVIDER') ? 'invalid' : 'set' };
  }
  return { stt, tts };
}

/** The paths a speech server is asked on: nothing else at its address is ever reached. */
export function speechPaths(basePath: string): string[] {
  return [`${basePath}/audio/transcriptions`, `${basePath}/audio/speech`];
}

export interface BuildVoiceDeps {
  env: Record<string, string | undefined>;
  fetch?: typeof fetch;
  run?: Run;
  connectTimeoutMs?: number;
  /** Injectable TCP connect check (tests: no real socket). */
  connect?: (host: string, port: number, ms: number) => Promise<void>;
}

/** Build the providers a plan names. A local speech server is reached through the guarded fetch: its origin only, its two paths only, never a redirect. */
export function buildVoice(plan: VoicePlan, deps: BuildVoiceDeps): Voice {
  const guard = (at: LocalUrlOk): typeof fetch =>
    guardedFetch({
      origin: at.origin,
      paths: speechPaths(at.path),
      ...(deps.connectTimeoutMs !== undefined ? { connectTimeoutMs: deps.connectTimeoutMs } : {}),
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      ...(deps.connect ? { connect: deps.connect } : {}),
    });
  const run = deps.run ? { run: deps.run } : {};
  const s = plan.stt;
  const stt =
    s.name === 'local'
      ? openAiCompatStt({ baseURL: s.server.baseURL, model: s.model, fetch: guard(s.server), ...(s.apiKey ? { apiKey: s.apiKey } : {}), ...run })
      : whisperCppStt({ bin: s.bin, model: s.model, ...run });
  const t = plan.tts;
  const tts =
    t.name === 'openai'
      ? openAiTts({ apiKey: deps.env.OPENAI_API_KEY, model: t.model, voice: t.voice, ...(deps.fetch ? { fetch: deps.fetch } : {}) })
      : t.name === 'local'
        ? openAiCompatTts({ baseURL: t.server.baseURL, model: t.model, voice: t.voice, fetch: guard(t.server), ...(t.apiKey ? { apiKey: t.apiKey } : {}) })
        : t.name === 'say'
          ? macSayTts({ ...(t.voice ? { voice: t.voice } : {}), ...run })
          : offTts();
  return { stt, tts };
}

/** Where a local speech server is, as a line says it: never its address. (Config lets it be at this Mac, or at the model server Will allowed.) */
export const whereOf = (at: Pick<LocalUrlOk, 'loopback'>): string => (at.loopback ? 'on this Mac' : 'on the allowed model server');

/** One boot line: what hears and what speaks, by provider and model. Never a path, an address or a key. */
export function voiceLine(plan: VoicePlan): string {
  const s = plan.stt;
  const t = plan.tts;
  const hears = s.name === 'local' ? `local server ${whereOf(s.server)} (${s.model})` : `whisper-cpp (${fileNameOf(s.model)})`;
  const speaks =
    t.name === 'openai'
      ? `openai (${t.model}, ${t.voice})${t.hasKey ? '' : ', no key'}`
      : t.name === 'local'
        ? `local server ${whereOf(t.server)} (${t.model}, ${t.voice})`
        : t.name === 'say'
          ? `say${t.voice ? ` (${t.voice})` : ''}`
          : `off (${t.why === 'set' ? 'set' : t.why === 'invalid' ? 'the setting was refused' : t.why === 'no_server' ? 'no local speech server' : 'say needs a Mac'})`;
  return `[voice] hearing=${hears} speaking=${speaks}`;
}
