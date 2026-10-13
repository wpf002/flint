/**
 * The voice benchmark: how fast and how accurate the speech engines ON THIS
 * MAC are, measured through the same providers `/transcribe` and `/speak` use
 * (./voice). It reports numbers and changes nothing: no setting is written,
 * and no default is switched.
 *
 *   hearing   each clip is transcribed; the time it took, the real-time
 *             factor (time over the clip's length: under 1 is faster than
 *             speech), and the word error rate against the words that were
 *             said (./wer);
 *   speaking  each sentence is spoken to a file; the time to the first audio
 *             and to the last, the real-time factor, and, when something
 *             here can hear, the word error rate of the speech heard back.
 *
 * WHAT IT RUNS, AND WHAT IT NEVER DOES
 *  - The clips are SYNTHETIC: fixed sentences written for this file, spoken
 *    into files by the Mac's own `say`. Nobody is recorded, and no clip
 *    leaves this Mac.
 *  - Nothing is ever played. `say` is only ever run with an output file, no
 *    player is run, and nothing is shown.
 *  - Only engines that are already installed are run. For one that is not,
 *    the exact command to install it is printed, and never run: Flint does
 *    not download a model or a program.
 *  - A PAID provider (OpenAI's speech API) is run only when it is asked for by
 *    name AND a dollar cap is given. The estimate is printed first, before
 *    any request, and a run whose estimate is over the cap does not start.
 *    Such a run is OUTSIDE Flint's spend record: the server's budget neither
 *    counts it nor stops it. It says so before it sends anything, and again
 *    afterwards with what was sent and what that costs.
 *  - What it leaves behind (the clips, the speech, the results) goes in a
 *    folder only this user can read, under ~/Library/Caches: never under
 *    ~/.flint, which the nightly and the offsite backups carry.
 *  - Programs are run with `execFile` / `spawn`: an absolute path, fixed
 *    arguments, never a shell. Text is never an argument: `say` reads it from
 *    a file. A voice's name and a speaking rate are checked before they are
 *    arguments. The local transcription server it starts listens on 127.0.0.1
 *    alone, on a port nobody else has, and is stopped when the run ends.
 *
 * Everything that touches the machine is handed in (`BenchDeps`), so the
 * whole run is unit-tested with stand-ins: the tests run no program.
 */
import { ttsCostOf } from '@flint/core';
import { readInferenceConfig, SAY_VOICE_RE } from './inference-config';
import { buildVoice, fileNameOf, openAiSpeech, planVoice, whisperPaths, type Run, type SttProvider, type TtsProvider } from './voice';
import { wordErrorRate, wordErrors, type WordErrors } from './wer';

/**
 * What is said. Written for this file: plain words, no names, no numbers and
 * no word that is spelled two ways, so a transcript differs from a sentence
 * only when a word was heard wrong (./wer does not turn "nine" into "9").
 */
export const SENTENCES: readonly string[] = [
  'Please remind me to call the dentist tomorrow morning.',
  'What is the weather going to be like this weekend?',
  'Add milk, eggs and bread to the shopping list.',
  'The meeting with the design team moved to Thursday afternoon.',
  'Turn off the lights in the kitchen and lock the front door.',
  'I want to finish reading that book before the end of the month.',
  'How long does it take to drive from here to the airport?',
  'Send a message to my sister and tell her I will be late.',
  'The garden needs water because it has not rained all week.',
  'Play some quiet music while I work on the report.',
];

/** The voices the clips are spoken in, when this Mac has them: six accents of English. The first three it has are used. */
export const CLIP_VOICES: readonly string[] = ['Samantha', 'Daniel', 'Karen', 'Moira', 'Rishi', 'Tessa'];
/** Words a minute: `say`'s own usual pace, and a quick one. */
export const CLIP_RATES: readonly number[] = [175, 220];
const MAX_VOICES = 6;
const MAX_RATES = 4;

/**
 * The speech-to-text engine on this Mac, by each name it goes by: the program
 * (what a sentence calls it), the provider it is in Flint's settings (which is
 * also its Homebrew formula), its own server, and the setting that names its
 * model. Each is said here once, and nowhere else in this file.
 */
const ENGINE = 'whisper.cpp';
const PROVIDER = 'whisper-cpp';
const SERVER_BIN = 'whisper-server';
const MODEL_SETTING = 'WHISPER_MODEL';

export const STT_ENGINES = [PROVIDER, 'local'] as const;
export type SttEngine = (typeof STT_ENGINES)[number];
/** `openai` is the one that costs money: never run unless named and capped. */
export const TTS_ENGINES = ['say', 'local', 'openai'] as const;
export type TtsEngine = (typeof TTS_ENGINES)[number];

export interface BenchArgs {
  /** Where the clips, the spoken files and the results go. */
  out?: string;
  /**
   * A folder of clips to hear in place of the synthetic ones: `<name>.wav`
   * (or m4a, mp3, aiff, flac) beside `<name>.txt`, which holds the words said.
   * They are read where they are and never copied.
   */
  clips?: string;
  /** Where whisper.cpp's models are looked for (`ggml-*.bin`). */
  modelsDir?: string;
  voices?: string[];
  rates?: number[];
  stt: SttEngine[];
  tts: TtsEngine[];
  /** The most this run may spend on a paid provider, in dollars. Unset: a paid provider is refused. */
  budgetUsd?: number;
  json: boolean;
  help: boolean;
}

export const USAGE = [
  'pnpm --filter server voice-bench -- [options]',
  '  --out <folder>         where the clips, the speech and results go (default: a dated folder under ~/Library/Caches/Flint/voice-bench)',
  '  --clips <folder>       hear your own clips in place of the synthetic ones: name.wav (or m4a, mp3) beside name.txt, the words said',
  `  --models-dir <folder>  where ${ENGINE} models are (default: the folder of ${MODEL_SETTING}, or ~/.flint/models)`,
  `  --voices A,B           the say voices the clips are spoken in (default: the first three this Mac has of ${CLIP_VOICES.join(', ')})`,
  `  --rates 175,220        words a minute (default: ${CLIP_RATES.join(', ')})`,
  `  --stt a,b              what hears: ${STT_ENGINES.join(', ')} (default: both)`,
  `  --tts a,b              what speaks: ${TTS_ENGINES.join(', ')} (default: say, and local when a local speech server is set)`,
  "  --budget-usd N         the most to spend on a paid provider; without it a paid provider is never called (and what it spends is outside Flint's spend record)",
  '  --json                 print the results as JSON',
].join('\n');

/**
 * The arguments, or a sentence saying what is wrong with them. An argument
 * that is not understood is never repeated back.
 */
export function parseBenchArgs(argv: readonly string[]): BenchArgs | { error: string } {
  const args: BenchArgs = { stt: [...STT_ENGINES], tts: ['say', 'local'], json: false, help: false };
  const list = (v: string | undefined): string[] | undefined => {
    if (v === undefined || v.startsWith('--')) return undefined;
    const parts = v.split(',').map((x) => x.trim()).filter((x) => x.length > 0);
    return parts.length > 0 ? parts : undefined;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--') continue;
    if (a === '--json') args.json = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--out' || a === '--models-dir' || a === '--clips') {
      const v = argv[++i];
      // (A folder's name is printed in the results: nothing in it may be a character a terminal acts on.)
      if (v === undefined || v === '' || v.startsWith('--') || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(v) || v.length > 1024) return { error: `${a} takes a folder` };
      if (a === '--out') args.out = v;
      else if (a === '--clips') args.clips = v;
      else args.modelsDir = v;
    } else if (a === '--voices') {
      const v = list(argv[++i]);
      if (!v || v.length > MAX_VOICES || !v.every((x) => SAY_VOICE_RE.test(x))) return { error: `--voices takes up to ${MAX_VOICES} voice names, with commas between them` };
      args.voices = [...new Set(v)];
    } else if (a === '--rates') {
      const v = list(argv[++i]);
      if (!v || v.length > MAX_RATES || !v.every((x) => /^\d{2,3}$/.test(x) && Number(x) >= 90 && Number(x) <= 400)) return { error: `--rates takes up to ${MAX_RATES} whole numbers from 90 to 400, with commas between them` };
      args.rates = [...new Set(v.map(Number))];
    } else if (a === '--stt') {
      const v = list(argv[++i]);
      if (!v || !v.every((x) => (STT_ENGINES as readonly string[]).includes(x))) return { error: `--stt is one or more of ${STT_ENGINES.join(', ')}` };
      args.stt = [...new Set(v)] as SttEngine[];
    } else if (a === '--tts') {
      const v = list(argv[++i]);
      if (!v || !v.every((x) => (TTS_ENGINES as readonly string[]).includes(x))) return { error: `--tts is one or more of ${TTS_ENGINES.join(', ')}` };
      args.tts = [...new Set(v)] as TtsEngine[];
    } else if (a === '--budget-usd') {
      const v = argv[++i];
      if (v === undefined || !/^\d{1,4}(\.\d{1,4})?$/.test(v) || Number(v) <= 0) return { error: '--budget-usd takes an amount in dollars above zero, like 0.25' };
      args.budgetUsd = Number(v);
    } else return { error: 'an argument was not understood' };
  }
  return args;
}

// ---------------------------------------------------------------------------
// the paid side: an estimate first, and a cap

export type PaidPlan =
  | { asked: false }
  /** Asked for and refused: nothing is sent. `estimateUsd` is what it would have cost. */
  | { asked: true; run: false; estimateUsd: number; chars: number; model: string; why: 'no_budget' | 'over_budget' | 'no_key'; sentence: string }
  | { asked: true; run: true; estimateUsd: number; chars: number; model: string; budgetUsd: number; sentence: string };

const usd = (n: number): string => `$${n < 0.01 && n > 0 ? n.toFixed(4) : n.toFixed(2)}`;

/** Said before a paid run sends anything, and after it: Flint's own budget knows nothing of it. */
export const OUTSIDE_SPEND_RECORD = "This is outside Flint's spend record: Flint's budget neither counts it nor stops it.";

/** What a paid run really sent, and what that costs at the model's list price. */
export interface PaidSpent {
  sentences: number;
  chars: number;
  usd: number;
  sentence: string;
}

export function paidSpent(sentences: number, chars: number, cost: number): PaidSpent {
  return {
    sentences,
    chars,
    usd: cost,
    sentence: `OpenAI speech was sent ${sentences} ${sentences === 1 ? 'sentence' : 'sentences'}, ${chars.toLocaleString('en-US')} characters, which costs about ${usd(cost)}. ${OUTSIDE_SPEND_RECORD}`,
  };
}

/**
 * May the paid speech provider be called in this run? Decided before anything
 * is sent, from the sentences that would be sent and the price of the model
 * (@flint/core ttsCostOf). The sentence says the estimate whichever way it
 * goes.
 */
export function paidPlan(args: Pick<BenchArgs, 'tts' | 'budgetUsd'>, sentences: readonly string[], o: { model: string; hasKey: boolean }): PaidPlan {
  if (!args.tts.includes('openai')) return { asked: false };
  const chars = sentences.reduce((n, s) => n + s.length, 0);
  const estimateUsd = ttsCostOf(o.model, chars);
  const what = `OpenAI speech is a paid service. This run would send it ${sentences.length} sentences, ${chars.toLocaleString('en-US')} characters, for about ${usd(estimateUsd)}`;
  const base = { asked: true as const, estimateUsd, chars, model: o.model };
  if (args.budgetUsd === undefined) return { ...base, run: false, why: 'no_budget', sentence: `${what}. It was not called: run this again with --budget-usd and the most you want to spend.` };
  if (estimateUsd > args.budgetUsd) return { ...base, run: false, why: 'over_budget', sentence: `${what}, which is over the ${usd(args.budgetUsd)} you allowed. It was not called.` };
  if (!o.hasKey) return { ...base, run: false, why: 'no_key', sentence: `${what}. It was not called: no OpenAI key is set.` };
  return { ...base, run: true, budgetUsd: args.budgetUsd, sentence: `${what}, within the ${usd(args.budgetUsd)} you allowed. ${OUTSIDE_SPEND_RECORD}` };
}

// ---------------------------------------------------------------------------
// audio files

/**
 * How long a WAV file plays, in seconds, from its own header. Undefined for
 * anything that is not plain PCM in a RIFF file (the only kind made here).
 */
export function wavSeconds(file: Buffer): number | undefined {
  if (file.length < 44 || file.toString('ascii', 0, 4) !== 'RIFF' || file.toString('ascii', 8, 12) !== 'WAVE') return undefined;
  let byteRate: number | undefined;
  for (let at = 12; at + 8 <= file.length; ) {
    const id = file.toString('ascii', at, at + 4);
    const size = file.readUInt32LE(at + 4);
    if (id === 'fmt ' && at + 20 <= file.length) byteRate = file.readUInt32LE(at + 16);
    if (id === 'data') {
      if (!byteRate) return undefined;
      // (A file still being written says 0 or 0xFFFFFFFF here: what is really there is the rest of the file.)
      const bytes = Math.min(size, file.length - (at + 8));
      return bytes / byteRate;
    }
    at += 8 + size + (size % 2);
  }
  return undefined;
}

/** The voices `say -v ?` lists: the name is everything before the locale ("Eddy (English (US)) en_US    # ..."). */
export function sayVoices(listing: string): string[] {
  const names: string[] = [];
  for (const line of listing.split('\n')) {
    const m = /^(.+?)\s+[a-z]{2,3}[_-][A-Za-z0-9]{2,4}\s+#/.exec(line);
    if (m && SAY_VOICE_RE.test(m[1]!.trim())) names.push(m[1]!.trim());
  }
  return [...new Set(names)];
}

// ---------------------------------------------------------------------------
// numbers

export interface Spread {
  n: number;
  medianMs: number;
  p95Ms: number;
  meanMs: number;
}

/** The middle, the slow end and the mean of some times, in whole milliseconds. */
export function spread(ms: readonly number[]): Spread {
  if (ms.length === 0) return { n: 0, medianMs: 0, p95Ms: 0, meanMs: 0 };
  const s = [...ms].sort((a, b) => a - b);
  const at = (q: number): number => s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))]!;
  return { n: s.length, medianMs: Math.round(at(0.5)), p95Ms: Math.round(at(0.95)), meanMs: Math.round(s.reduce((a, b) => a + b, 0) / s.length) };
}

export interface Clip {
  name: string;
  /** The words that were said. */
  text: string;
  file: string;
  seconds: number;
  voice: string;
  rate: number;
}

export interface SttRow extends Spread {
  engine: SttEngine;
  /** The model, by its file's or its own name. Never a path. */
  model: string;
  audioSeconds: number;
  /** Time spent over the length of what was heard: under 1 is faster than speech. */
  realTimeFactor: number;
  /** Word error rate over every clip (./wer), or undefined when nothing could be scored. */
  wordErrorRate: number | undefined;
  words: number;
  errors: number;
  /** The first call, which is not in the numbers above: the model read from disk, or the server's first answer. */
  firstMs: number;
  /** For a server this run started: how long until it answered. */
  loadMs?: number;
  /** The word error rate for each voice the clips were spoken in. */
  byVoice: Record<string, number | undefined>;
  /** The same for each speaking rate. */
  byRate: Record<string, number | undefined>;
  failed: number;
}

export interface TtsRow {
  engine: TtsEngine;
  voice: string;
  model?: string;
  n: number;
  /** To the first audio. For an engine that hands back a whole file, this is the whole file. */
  firstAudio: Spread;
  /** To the last audio. */
  total: Spread;
  audioSeconds: number;
  /** Time spent over the length of what was spoken: under 1 is faster than speech. */
  realTimeFactor: number;
  /** The speech, heard back by the engine named in `heardBy`: its word error rate against the sentences. */
  heardBackWordErrorRate?: number;
  heardBy?: string;
  /** What a paid engine was estimated to cost, in dollars. */
  estimateUsd?: number;
  /** What a paid engine was really sent: the sentences, their characters, and what those cost. */
  sent?: { sentences: number; chars: number; usd: number };
  failed: number;
}

/** Something that could not be measured, and the command that would make it measurable. Printed; never run. */
export interface Hint {
  what: string;
  why: string;
  /** The exact line to run in Terminal. */
  command: string;
  /** What it takes on disk, when that is known. */
  disk: string;
  /** How to point Flint at it afterwards, when that takes a setting. */
  then?: string;
  /** Was the command run on this Mac by whoever wrote it down? (Nothing here installs anything, so: no.) */
  tried: boolean;
}

export interface BenchResult {
  when: string;
  machine: { chip: string; memoryGb: number; os: string };
  clips: { count: number; seconds: number; voices: string[]; rates: number[]; sentences: number; /** They are clips somebody recorded, not synthetic ones. */ own?: true };
  stt: SttRow[];
  tts: TtsRow[];
  /** What the paid provider would cost and whether it was called. */
  paid: PaidPlan;
  /** What the paid provider was sent and what that costs, when it was called. Outside Flint's spend record. */
  paidSpent?: PaidSpent;
  notInstalled: Hint[];
  notes: string[];
}

// ---------------------------------------------------------------------------
// what is not here, and how to get it

/** What one of the engine's model files is called: the prefix they all carry, a name, `.bin`. (Its voice-detection models carry it too, and are no transcriber.) */
const MODEL_FILE = /^ggml-[A-Za-z0-9._-]{1,60}\.bin$/;

/** whisper.cpp's own models, by the name of the file, with what each takes on disk. (Sizes: the files as published.) */
export const WHISPER_MODELS: ReadonlyArray<{ file: string; disk: string; note: string }> = [
  { file: 'ggml-base.en.bin', disk: '148 MB', note: `the model Flint's transcription uses unless ${MODEL_SETTING} names another` },
  { file: 'ggml-small.en.bin', disk: '488 MB', note: 'more accurate than base, slower' },
  { file: 'ggml-large-v3-turbo-q5_0.bin', disk: 'about 574 MB', note: 'the large model, made smaller: the most accurate of these for its size' },
  { file: 'ggml-large-v3-turbo.bin', disk: 'about 1.6 GB', note: 'the large model, as published' },
];

/** A path as one word of a command typed in Terminal: as it is when it is plain, in single quotes otherwise. */
export function shellWord(path: string): string {
  return /^[A-Za-z0-9_@%+=:,./~-]+$/.test(path) ? path : `'${path.replace(/'/g, `'\\''`)}'`;
}

/**
 * The line that fetches a model into the folder the models are in. In a
 * command, the usual folder is written with `~`, which Terminal reads as the
 * home folder. A SETTING is never written that way: neither the settings file
 * nor a LaunchAgent expands `~`, so the setting is the full path.
 */
const modelTarget = (file: string, folder: string, home: string): string => (folder === `${home}/.flint/models` ? `~/.flint/models/${file}` : shellWord(`${folder}/${file}`));
const modelCommand = (file: string, folder: string, home: string): string => `curl -L --fail --create-dirs -o ${modelTarget(file, folder, home)} https://huggingface.co/ggerganov/${ENGINE}/resolve/main/${file}`;

/**
 * The commands for what this Mac does not have. None of them was run here:
 * this file installs nothing. `modelsDir` is where the models are looked for,
 * as a full path: a model's line fetches it there, and the setting named
 * afterwards is that full path.
 */
export function hintsFor(found: { whisperCli: boolean; whisperServer: boolean; say: boolean; models: readonly string[]; localTtsSet: boolean; modelsDir: string; home: string }): Hint[] {
  const hints: Hint[] = [];
  if (!found.whisperCli) {
    hints.push({ what: ENGINE, why: 'Transcription on this Mac needs it, and it is not installed.', command: `brew install ${PROVIDER}`, disk: 'about 30 MB, plus a model', tried: false });
  } else if (!found.whisperServer) {
    hints.push({ what: `${ENGINE}’s server`, why: `The local transcription server could not be measured: this copy of ${ENGINE} has no ${SERVER_BIN}.`, command: `brew upgrade ${PROVIDER}`, disk: 'about 30 MB', tried: false });
  }
  for (const m of WHISPER_MODELS) {
    if (found.models.includes(m.file)) continue;
    hints.push({
      what: `the speech model ${m.file}`,
      why: `It is not on this Mac, so it was not measured (${m.note}).`,
      command: modelCommand(m.file, found.modelsDir, found.home),
      disk: m.disk,
      then: `To use it: set ${MODEL_SETTING}=${found.modelsDir}/${m.file} and restart Flint.`,
      tried: false,
    });
  }
  if (!found.localTtsSet) {
    hints.push({
      what: 'a neural voice on this Mac',
      why: "No local speech server is set up, so the only voice measured here is the Mac's own. Flint's local speech provider speaks through any server on this Mac that answers POST /v1/audio/speech the way OpenAI's does. Kokoro-FastAPI is one, and it needs Docker, which this command assumes is installed.",
      command: 'docker run -d --name kokoro -p 127.0.0.1:8880:8880 ghcr.io/remsky/kokoro-fastapi-cpu:latest',
      disk: 'not measured: several GB as a Docker image',
      then: 'To use it: set FLINT_TTS_PROVIDER=local FLINT_LOCAL_TTS_BASE_URL=http://127.0.0.1:8880/v1 FLINT_LOCAL_TTS_MODEL=kokoro FLINT_LOCAL_TTS_VOICE=af_heart, restart Flint, and run this benchmark again.',
      tried: false,
    });
  }
  return hints;
}

// ---------------------------------------------------------------------------
// the run

/** A local transcription server this run started, on this Mac alone. */
export interface StartedServer {
  /** `http://127.0.0.1:<port>/v1` */
  baseURL: string;
  /** How long it took to answer its first request. */
  loadMs: number;
  stop(): Promise<void>;
}

export interface BenchDeps {
  env: Record<string, string | undefined>;
  /** Run a program: never a shell (./voice runFile). */
  run: Run;
  fetch?: typeof fetch;
  /** Milliseconds, for timing (performance.now). */
  now: () => number;
  readFile: (path: string) => Buffer;
  writeFile: (path: string, data: Buffer | string) => void;
  mkdir: (path: string) => void;
  exists: (path: string) => boolean;
  /** Remove one file this run made. */
  remove: (path: string) => void;
  /** The names in a folder; [] when it cannot be read. */
  list: (dir: string) => string[];
  join: (...parts: string[]) => string;
  /** Start whisper.cpp's server with this model on 127.0.0.1; undefined when it could not be started. */
  startServer?: (bin: string, model: string) => Promise<StartedServer | undefined>;
  machine: BenchResult['machine'];
  home: string;
  platform: NodeJS.Platform;
  /** One line of progress (stderr). */
  log: (line: string) => void;
  /** When the run is (an ISO time), for the results. */
  when: string;
}

const SAY = '/usr/bin/say';
const AFCONVERT = '/usr/bin/afconvert';
const SAY_TIMEOUT_MS = 60_000;

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/**
 * Speak one sentence into a WAV file, 16 kHz mono, the kind every engine here
 * reads. The text is in a file; the arguments are fixed, and the two that
 * vary (the voice, the rate) are checked first. `-o` is always there: with it
 * `say` writes the file and plays nothing.
 */
export async function sayToWav(deps: Pick<BenchDeps, 'run' | 'writeFile'>, o: { text: string; textFile: string; out: string; voice: string; rate: number }): Promise<void> {
  if (!SAY_VOICE_RE.test(o.voice)) throw new Error('the voice is not a voice name');
  if (!Number.isInteger(o.rate) || o.rate < 90 || o.rate > 400) throw new Error('the rate is not a speaking rate');
  deps.writeFile(o.textFile, o.text);
  await deps.run(SAY, ['-o', o.out, '--file-format=WAVE', '--data-format=LEI16@16000', '-r', String(o.rate), '-v', o.voice, '-f', o.textFile], { timeout: SAY_TIMEOUT_MS, killSignal: 'SIGKILL', env: {} });
}

/** Any audio file as the WAV a duration can be read from, and a transcriber can read. */
async function toWav(deps: Pick<BenchDeps, 'run'>, from: string, to: string): Promise<void> {
  await deps.run(AFCONVERT, [from, to, '-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1'], { timeout: SAY_TIMEOUT_MS, killSignal: 'SIGKILL' });
}

async function makeClips(deps: BenchDeps, dir: string, voices: readonly string[], rates: readonly number[]): Promise<Clip[]> {
  const clips: Clip[] = [];
  deps.mkdir(dir);
  for (const voice of voices) {
    for (const rate of rates) {
      for (let i = 0; i < SENTENCES.length; i++) {
        const name = `${slug(voice)}-${rate}-${String(i + 1).padStart(2, '0')}`;
        const file = deps.join(dir, `${name}.wav`);
        try {
          await sayToWav(deps, { text: SENTENCES[i]!, textFile: deps.join(dir, `${name}.txt`), out: file, voice, rate });
          const seconds = wavSeconds(deps.readFile(file));
          if (seconds && seconds > 0.2) clips.push({ name, text: SENTENCES[i]!, file, seconds, voice, rate });
        } catch {
          /* a voice that will not speak is left out; the count says so */
        }
      }
    }
  }
  return clips;
}

/** "1 clip" or "3 clips", and what follows a count of them. */
const clipsOf = (n: number): string => `${n} ${n === 1 ? 'clip' : 'clips'}`;

/** Where a run's files go when no folder is named: under this user's caches, never under ~/.flint (a backup would carry them). */
export function defaultOut(home: string, when: string, join: (...parts: string[]) => string): string {
  return join(home, 'Library', 'Caches', 'Flint', 'voice-bench', when.replace(/[:.]/g, '-'));
}

/** The voice a clip of Will's own is filed under, in the results. */
export const OWN_CLIPS = 'your clips';
/** The most clips taken from a folder, and the longest transcript read for one. */
const MAX_OWN_CLIPS = 500;
const MAX_TRANSCRIPT_CHARS = 4000;

/**
 * Clips somebody recorded: each audio file in the folder that has a text file
 * of the same name beside it, holding the words that were said. They are read
 * where they are. To learn how long one is it is made into a WAV in the output
 * folder, measured, and that WAV is removed at once: his voice is not copied.
 */
async function ownClips(deps: BenchDeps, dir: string, scratch: string, remarks: string[]): Promise<Clip[]> {
  const clips: Clip[] = [];
  const audio = deps
    .list(dir)
    .filter((n) => /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,80}\.(wav|m4a|mp3|aiff|flac)$/i.test(n))
    .sort()
    .slice(0, MAX_OWN_CLIPS);
  let untitled = 0;
  let unread = 0;
  deps.mkdir(scratch);
  for (const name of audio) {
    const stem = name.replace(/\.[A-Za-z0-9]+$/, '');
    const words = deps.join(dir, `${stem}.txt`);
    if (!deps.exists(words)) {
      untitled++;
      continue;
    }
    const file = deps.join(dir, name);
    const wav = deps.join(scratch, `measure-${clips.length + unread}.wav`);
    try {
      const text = deps.readFile(words).toString('utf8').replace(/\s+/g, ' ').trim().slice(0, MAX_TRANSCRIPT_CHARS);
      await toWav(deps, file, wav);
      const seconds = wavSeconds(deps.readFile(wav));
      if (text && seconds && seconds > 0.2) clips.push({ name: stem, text, file, seconds, voice: OWN_CLIPS, rate: 0 });
      else unread++;
    } catch {
      unread++;
    } finally {
      try {
        deps.remove(wav);
      } catch {
        /* it was never made */
      }
    }
  }
  if (untitled > 0) remarks.push(untitled === 1 ? '1 clip had no text file beside it saying what was said, so it was left out.' : `${untitled} clips had no text file beside them saying what was said, so they were left out.`);
  if (unread > 0) remarks.push(`${clipsOf(unread)} could not be read and ${unread === 1 ? 'was' : 'were'} left out.`);
  return clips;
}

async function hear(deps: BenchDeps, stt: SttProvider, engine: SttEngine, model: string, clips: readonly Clip[], loadMs?: number): Promise<SttRow> {
  const times: number[] = [];
  const scored: Array<WordErrors & { voice: string; rate: number }> = [];
  let failed = 0;
  let audioSeconds = 0;
  // The first call is not in the numbers: it reads the model from disk (or is a server's first answer).
  let firstMs = 0;
  if (clips[0]) {
    const t = deps.now();
    try {
      await stt.transcribe(deps.readFile(clips[0].file));
    } catch {
      /* counted below, with the measured calls */
    }
    firstMs = Math.round(deps.now() - t);
  }
  for (const clip of clips) {
    const audio = deps.readFile(clip.file);
    const t = deps.now();
    try {
      const { text } = await stt.transcribe(audio);
      times.push(deps.now() - t);
      audioSeconds += clip.seconds;
      scored.push({ ...wordErrors(clip.text, text), voice: clip.voice, rate: clip.rate });
    } catch {
      failed++;
    }
  }
  const by = <K extends 'voice' | 'rate'>(key: K): Record<string, number | undefined> => {
    const out: Record<string, number | undefined> = {};
    // (A clip somebody recorded has no speaking rate: it is under its own heading, by voice.)
    for (const v of new Set(scored.map((s) => String(s[key])))) if (!(key === 'rate' && v === '0')) out[v] = wordErrorRate(scored.filter((s) => String(s[key]) === v));
    return out;
  };
  const spent = times.reduce((a, b) => a + b, 0);
  return {
    engine,
    model,
    ...spread(times),
    audioSeconds: Math.round(audioSeconds * 10) / 10,
    realTimeFactor: audioSeconds > 0 ? Math.round((spent / 1000 / audioSeconds) * 1000) / 1000 : 0,
    wordErrorRate: wordErrorRate(scored),
    words: scored.reduce((n, s) => n + s.words, 0),
    errors: scored.reduce((n, s) => n + s.errors, 0),
    firstMs,
    ...(loadMs !== undefined ? { loadMs: Math.round(loadMs) } : {}),
    byVoice: by('voice'),
    byRate: by('rate'),
    failed,
  };
}

const EXT: Record<string, string> = { 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/wav': 'wav', 'audio/aac': 'aac', 'audio/ogg': 'ogg', 'audio/flac': 'flac' };

export async function speakAll(
  deps: BenchDeps,
  tts: TtsProvider,
  engine: TtsEngine,
  dir: string,
  o: { hearBack?: { stt: SttProvider; label: string }; capUsd?: number; estimateUsd?: number } = {},
): Promise<TtsRow> {
  const first: number[] = [];
  const total: number[] = [];
  const heard: WordErrors[] = [];
  let audioSeconds = 0;
  let spoken = 0;
  let failed = 0;
  let spentUsd = 0;
  let sentChars = 0;
  let sentSentences = 0;
  const voice = tts.voice ?? 'the usual voice';
  deps.mkdir(dir);
  for (let i = 0; i < SENTENCES.length; i++) {
    const text = SENTENCES[i]!;
    if (o.capUsd !== undefined) {
      // A paid engine stops before the sentence that would pass the cap.
      const cost = ttsCostOf(tts.model ?? '', text.length);
      if (spentUsd + cost > o.capUsd) break;
      spentUsd += cost;
      // Counted as sent whether or not it comes back as audio: what was sent is what is charged for.
      sentChars += text.length;
      sentSentences++;
    }
    const t = deps.now();
    let firstAt: number | undefined;
    try {
      const speech = await tts.synthesize(text, { onFirstAudio: () => (firstAt ??= deps.now() - t) });
      const took = deps.now() - t;
      if (!speech) {
        failed++;
        continue;
      }
      const base = deps.join(dir, `${slug(`${engine}-${voice}`)}-${String(i + 1).padStart(2, '0')}`);
      const file = `${base}.${EXT[speech.contentType] ?? 'bin'}`;
      deps.writeFile(file, speech.audio);
      // Its length, and something a transcriber can read: the same WAV for both. Never played.
      const wav = speech.contentType === 'audio/wav' ? file : `${base}.wav`;
      if (wav !== file) await toWav(deps, file, wav);
      const seconds = wavSeconds(deps.readFile(wav));
      if (!seconds) {
        failed++;
        continue;
      }
      first.push(firstAt ?? took);
      total.push(took);
      audioSeconds += seconds;
      spoken += took;
      if (o.hearBack) {
        try {
          heard.push(wordErrors(text, (await o.hearBack.stt.transcribe(deps.readFile(wav))).text));
        } catch {
          /* not heard back: the rate is over the ones that were */
        }
      }
    } catch {
      failed++;
    }
  }
  const back = wordErrorRate(heard);
  return {
    engine,
    voice,
    ...(tts.model ? { model: tts.model } : {}),
    n: total.length,
    firstAudio: spread(first),
    total: spread(total),
    audioSeconds: Math.round(audioSeconds * 10) / 10,
    realTimeFactor: audioSeconds > 0 ? Math.round((spoken / 1000 / audioSeconds) * 1000) / 1000 : 0,
    ...(back !== undefined && o.hearBack ? { heardBackWordErrorRate: back, heardBy: o.hearBack.label } : {}),
    ...(o.estimateUsd !== undefined ? { estimateUsd: o.estimateUsd } : {}),
    ...(o.capUsd !== undefined ? { sent: { sentences: sentSentences, chars: sentChars, usd: spentUsd } } : {}),
    failed,
  };
}

/**
 * The whole run. It never throws for an engine that is missing or fails: that
 * engine is left out, and the result says what was not measured and how to
 * get it. The paid provider is decided before anything is sent (`paidPlan`),
 * and its sentence is logged first.
 */
export async function runBench(args: BenchArgs, deps: BenchDeps): Promise<BenchResult> {
  const env = deps.env;
  /** What this run has to say about itself, for the results: what was left out, and why. */
  const remarks: string[] = [];
  // (A program or a model that a setting names and that is not there is refused, as the server refuses it: the usual one is measured.)
  const cfg = readInferenceConfig(env, undefined, { home: deps.home, fileExists: deps.exists });
  const plan = planVoice(cfg, env, { platform: deps.platform, home: deps.home });
  // whisper.cpp and its model, where the server itself reads them (WHISPER_BIN, WHISPER_MODEL, as config takes them).
  const { bin, model: usualModel } = whisperPaths(cfg.voice, deps.home);
  const folderOf = (path: string): string => path.replace(/[\\/][^\\/]*$/, '');
  const serverBin = deps.join(folderOf(bin), SERVER_BIN);
  const modelsDir = args.modelsDir ?? folderOf(usualModel);
  const haveCli = deps.exists(bin);
  const haveServer = deps.exists(serverBin);
  const haveSay = deps.platform === 'darwin' && deps.exists(SAY);
  // Only whisper.cpp's own model files are looked at in that folder: nothing else in it is read, or named.
  const models = deps
    .list(modelsDir)
    .filter((n) => MODEL_FILE.test(n) && !/silero/i.test(n))
    .sort();
  const usual = fileNameOf(usualModel);
  // The usual model first, so the numbers for what Flint runs today lead.
  models.sort((a, b) => Number(b === usual) - Number(a === usual));

  // The paid side is settled before anything else is done, and said first.
  const openai = openAiSpeech(cfg.voice);
  const paid = paidPlan(args, SENTENCES, { model: openai.model, hasKey: !!env.OPENAI_API_KEY?.trim() });
  if (paid.asked) deps.log(paid.sentence);

  const out = args.out ?? defaultOut(deps.home, deps.when, deps.join);
  deps.mkdir(out);

  // ---- the clips
  let clips: Clip[] = [];
  let voices: string[] = [];
  const own = args.clips !== undefined;
  const rates = own ? [] : (args.rates ?? [...CLIP_RATES]);
  if (!haveSay) {
    remarks.push("This machine has no `say`, so no clips were made and nothing could be measured. The benchmark runs on a Mac.");
  } else if (own) {
    deps.log('Reading your clips where they are (nothing is played, and none is copied).');
    clips = await ownClips(deps, args.clips!, deps.join(out, 'clips'), remarks);
    if (clips.length === 0) remarks.push('No clip with a text file beside it was found in that folder, so nothing was heard.');
  } else {
    let installed: string[] = [];
    try {
      installed = sayVoices((await deps.run(SAY, ['-v', '?'], { timeout: SAY_TIMEOUT_MS, env: {} })).stdout);
    } catch {
      /* no list: the voices asked for are tried as they are */
    }
    // (`say` takes a voice by its first name too: the list calls one "Samantha (English (US))", and `-v Samantha` is it.)
    const has = (v: string): boolean => installed.length === 0 || installed.some((n) => n === v || n.startsWith(`${v} (`));
    const wanted = args.voices ?? CLIP_VOICES.filter(has).slice(0, 3);
    voices = wanted.filter(has);
    for (const v of wanted) if (!voices.includes(v)) remarks.push(`The voice ${v} is not on this Mac, so no clip was spoken in it.`);
    deps.log(`Speaking ${voices.length * rates.length * SENTENCES.length} clips into files (nothing is played).`);
    clips = await makeClips(deps, deps.join(out, 'clips'), voices, rates);
    const missing = voices.length * rates.length * SENTENCES.length - clips.length;
    if (missing > 0) remarks.push(`${clipsOf(missing)} could not be made and ${missing === 1 ? 'was' : 'were'} left out.`);
  }

  // ---- hearing
  const stt: SttRow[] = [];
  let hearBack: { stt: SttProvider; label: string } | undefined;
  if (clips.length > 0 && haveCli) {
    for (const file of models) {
      const model = deps.join(modelsDir, file);
      if (args.stt.includes(PROVIDER)) {
        deps.log(`Transcribing with ${ENGINE}, ${file}.`);
        const provider = buildVoice({ stt: { name: PROVIDER, local: true, bin, model }, tts: { name: 'off', local: true, why: 'set' } }, { env, run: deps.run, fileExists: deps.exists }).stt;
        stt.push(await hear(deps, provider, PROVIDER, file, clips));
        hearBack ??= { stt: provider, label: `${ENGINE} ${file}` };
      }
      if (args.stt.includes('local') && haveServer && deps.startServer) {
        deps.log(`Starting a transcription server on this Mac with ${file}.`);
        const server = await deps.startServer(serverBin, model);
        if (!server) {
          remarks.push(`The local transcription server did not start with ${file}, so it was not measured.`);
          continue;
        }
        try {
          // Through config and the guarded fetch, as Flint would reach it: FLINT_STT_PROVIDER=local at that address.
          // (The usual model name is sent: the server answers with the one model it was started with, whatever it is asked for.)
          const serverEnv = { ...env, FLINT_STT_PROVIDER: 'local', FLINT_LOCAL_STT_BASE_URL: server.baseURL, FLINT_LOCAL_STT_MODEL: undefined };
          const local = planVoice(readInferenceConfig(serverEnv, undefined, { home: deps.home, fileExists: deps.exists }), serverEnv, { platform: deps.platform, home: deps.home });
          if (local.stt.name !== 'local') {
            remarks.push('The local transcription server could not be reached through Flint’s own settings, so it was not measured.');
            continue;
          }
          const provider = buildVoice(local, { env: serverEnv, run: deps.run, fileExists: deps.exists, ...(deps.fetch ? { fetch: deps.fetch } : {}) }).stt;
          stt.push(await hear(deps, provider, 'local', file, clips, server.loadMs));
        } finally {
          await server.stop();
        }
      }
    }
  }
  if (clips.length > 0 && !haveCli) remarks.push(`${ENGINE} is not installed, so transcription was not measured.`);
  if (clips.length > 0 && haveCli && models.length === 0) remarks.push(`No ${ENGINE} model was found, so transcription was not measured.`);
  // A local transcription server Will already runs, when one is set: measured as it is.
  if (clips.length > 0 && args.stt.includes('local') && plan.stt.name === 'local') {
    deps.log('Transcribing with the local speech server that is set up.');
    stt.push(await hear(deps, buildVoice(plan, { env, run: deps.run, fileExists: deps.exists, ...(deps.fetch ? { fetch: deps.fetch } : {}) }).stt, 'local', plan.stt.model, clips));
  }

  // ---- speaking
  const tts: TtsRow[] = [];
  const speech = deps.join(out, 'speech');
  if (haveSay && args.tts.includes('say')) {
    // The Mac's usual voice, and each voice the clips were spoken in (or the ones named, with clips of his own).
    for (const voice of [undefined, ...(own ? (args.voices ?? []) : voices)]) {
      deps.log(`Speaking with this Mac's own voice${voice ? `, ${voice}` : ''}, into files.`);
      const provider = buildVoice({ stt: { name: PROVIDER, local: true, bin, model: usualModel }, tts: { name: 'say', local: true, ...(voice ? { voice } : {}) } }, { env, run: deps.run, fileExists: deps.exists }).tts;
      tts.push(await speakAll(deps, provider, 'say', speech, hearBack ? { hearBack } : {}));
    }
  }
  if (args.tts.includes('local') && plan.tts.name === 'local') {
    deps.log('Speaking with the local speech server that is set up, into files.');
    tts.push(await speakAll(deps, buildVoice(plan, { env, run: deps.run, fileExists: deps.exists, ...(deps.fetch ? { fetch: deps.fetch } : {}) }).tts, 'local', speech, hearBack ? { hearBack } : {}));
  }
  let spent: PaidSpent | undefined;
  if (paid.asked && paid.run) {
    const provider = buildVoice({ stt: { name: PROVIDER, local: true, bin, model: usualModel }, tts: { name: 'openai', local: false, ...openai, hasKey: true } }, { env, run: deps.run, fileExists: deps.exists, ...(deps.fetch ? { fetch: deps.fetch } : {}) }).tts;
    const row = await speakAll(deps, provider, 'openai', speech, { ...(hearBack ? { hearBack } : {}), capUsd: paid.budgetUsd, estimateUsd: paid.estimateUsd });
    tts.push(row);
    // Said again when it is over, with what was really sent: nothing else keeps a record of it.
    spent = paidSpent(row.sent?.sentences ?? 0, row.sent?.chars ?? 0, row.sent?.usd ?? 0);
    deps.log(spent.sentence);
  }

  return {
    when: deps.when,
    machine: deps.machine,
    clips: { count: clips.length, seconds: Math.round(clips.reduce((n, c) => n + c.seconds, 0) * 10) / 10, voices, rates: [...rates], sentences: SENTENCES.length, ...(own ? { own: true as const } : {}) },
    stt,
    tts,
    paid,
    ...(spent ? { paidSpent: spent } : {}),
    notInstalled: hintsFor({ whisperCli: haveCli, whisperServer: haveServer, say: haveSay, models, localTtsSet: plan.tts.name === 'local', modelsDir, home: deps.home }),
    notes: remarks,
  };
}

// ---------------------------------------------------------------------------
// the report

const pct = (n: number | undefined): string => (n === undefined ? 'n/a' : `${(n * 100).toFixed(1)}%`);
const secs = (ms: number): string => (ms >= 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`);

function table(head: string[], rows: string[][]): string[] {
  const width = head.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: string[]): string => `| ${cells.map((c, i) => c.padEnd(width[i]!)).join(' | ')} |`;
  return [line(head), `| ${width.map((w) => '-'.repeat(w)).join(' | ')} |`, ...rows.map(line)];
}

const STT_NAMES: Record<SttEngine, string> = { [PROVIDER]: `${ENGINE}, one run per clip (what Flint does today)`, local: `${ENGINE} as a server on this Mac (the local provider)` };
const TTS_NAMES: Record<TtsEngine, string> = { say: "this Mac's own voice (say)", local: 'local speech server', openai: 'OpenAI (paid)' };

/** The results as a page of Markdown: two tables, what they mean, and what was not measured. */
export function renderBench(r: BenchResult): string {
  const lines: string[] = [];
  lines.push('# Voice benchmark', '');
  lines.push(`Run ${r.when} on ${r.machine.chip}, ${r.machine.memoryGb} GB, macOS ${r.machine.os}.`);
  lines.push(
    r.clips.own
      ? `Clips: ${r.clips.count} of your own clips, ${r.clips.seconds} seconds in all, each scored against the text file beside it. They were read where they are: none was copied, nothing was played, and nothing left this Mac.`
      : `Clips: ${r.clips.count} synthetic clips, ${r.clips.seconds} seconds in all (${r.clips.sentences} fixed sentences, spoken into files by the Mac's own voices${r.clips.voices.length ? ` ${r.clips.voices.join(', ')}` : ''}${r.clips.rates.length ? ` at ${r.clips.rates.join(' and ')} words a minute` : ''}). Nobody was recorded, nothing was played, and nothing left this Mac.`,
    '',
  );
  lines.push('## Hearing (speech to text)', '');
  if (r.stt.length === 0) lines.push('Nothing that hears could be measured.', '');
  else {
    lines.push(
      ...table(
        ['Engine', 'Model', 'Clips', 'Median', 'Slowest 5%', 'Real-time factor', 'Word error rate', 'First call'],
        r.stt.map((s) => [STT_NAMES[s.engine], s.model, String(s.n), secs(s.medianMs), secs(s.p95Ms), s.realTimeFactor.toFixed(3), `${pct(s.wordErrorRate)} (${s.errors} of ${s.words} words)`, `${secs(s.firstMs)}${s.loadMs !== undefined ? `, after ${secs(s.loadMs)} to start` : ''}`]),
      ),
      '',
    );
    const voices = [...new Set(r.stt.flatMap((s) => Object.keys(s.byVoice)))];
    const rates = [...new Set(r.stt.flatMap((s) => Object.keys(s.byRate)))];
    if (voices.length + rates.length > 0) {
      lines.push('Word error rate by voice and by speaking rate:', '');
      lines.push(...table(['Engine', 'Model', ...voices, ...rates.map((x) => `${x} wpm`)], r.stt.map((s) => [s.engine, s.model, ...voices.map((v) => pct(s.byVoice[v])), ...rates.map((x) => pct(s.byRate[x]))])), '');
    }
    for (const s of r.stt) if (s.failed > 0) lines.push(`${s.engine} with ${s.model} failed on ${clipsOf(s.failed)}, which ${s.failed === 1 ? 'is' : 'are'} not in its numbers.`, '');
  }
  lines.push('## Speaking (text to speech)', '');
  if (r.tts.length === 0) lines.push('Nothing that speaks could be measured.', '');
  else {
    lines.push(
      ...table(
        ['Engine', 'Voice', 'Sentences', 'To first audio', 'To last audio', 'Slowest 5%', 'Real-time factor', 'Heard back'],
        r.tts.map((t) => [TTS_NAMES[t.engine], t.voice, String(t.n), secs(t.firstAudio.medianMs), secs(t.total.medianMs), secs(t.total.p95Ms), t.realTimeFactor.toFixed(3), t.heardBackWordErrorRate === undefined ? 'n/a' : `${pct(t.heardBackWordErrorRate)} word error rate`]),
      ),
      '',
    );
    const by = r.tts.find((t) => t.heardBy)?.heardBy;
    if (by) lines.push(`"Heard back" is the speech transcribed by ${by}: how much of what was said comes back as the same words.`, '');
    lines.push("The Mac's own voice hands back a whole file, so its first audio is its last.", '');
  }
  lines.push('## How to read it', '');
  lines.push(
    '- Median and slowest 5% are the time one clip or one sentence takes, start to finish.',
    '- Real-time factor is the time spent over the length of the audio. Under 1 is faster than speech; 0.1 is ten times faster.',
    r.clips.own
      ? '- Word error rate is the share of words heard wrong, missed or added, against the words in the text file beside each clip. Lower is better.'
      : '- Word error rate is the share of words heard wrong, missed or added, against the sentence that was said. Lower is better. The clips are clean synthetic speech, so real rooms and real voices will do worse than this.',
    '- First call is the first use after a start, which reads the model from disk. It is not in the other numbers.',
    '',
  );
  if (r.paid.asked) lines.push('## The paid provider', '', r.paid.sentence, '', ...(r.paidSpent ? [r.paidSpent.sentence, ''] : []));
  if (r.notes.length > 0) lines.push('## Notes', '', ...r.notes.map((n) => `- ${n}`), '');
  if (r.notInstalled.length > 0) {
    lines.push('## Not on this Mac, so not measured', '', 'Nothing below was run or downloaded. Each line is a command for you to run in Terminal if you want it.', '');
    for (const h of r.notInstalled) {
      lines.push(`- **${h.what}** (${h.disk}). ${h.why}`, '', '  ```', `  ${h.command}`, '  ```', '');
      if (h.then) lines.push(`  ${h.then}`, '');
    }
  }
  lines.push('No setting was changed by this run.');
  return lines.join('\n');
}
