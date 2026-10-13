/**
 * The voice benchmark (../src/voice-bench, ../scripts/voice-bench), run whole
 * with stand-ins: no program is run here, nothing is spoken, nothing is
 * played and nothing leaves this process but requests to a stand-in on
 * loopback.
 *
 * The stand-ins: `say` writes a WAV whose "audio" is the sentence's own bytes
 * (padded to a known length), `afconvert` copies a file, and "whisper"
 * (whisper-cli, and a little HTTP server in place of whisper-server) reads
 * the sentence back out of the WAV, getting one word wrong when a test asks.
 * So what the benchmark reports can be worked out by hand.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { SERVER_HOST, main, serverArgs, startWhisperServer } from '../scripts/voice-bench';
import { NO_PROXY_SPELLINGS } from './no-proxy-spellings';
import {
  CLIP_RATES,
  CLIP_VOICES,
  OUTSIDE_SPEND_RECORD,
  SENTENCES,
  USAGE,
  WHISPER_MODELS,
  defaultOut,
  hintsFor,
  paidPlan,
  paidSpent,
  parseBenchArgs,
  renderBench,
  runBench,
  sayToWav,
  sayVoices,
  shellWord,
  speakAll,
  spread,
  wavSeconds,
  type BenchArgs,
  type BenchDeps,
  type StartedServer,
} from '../src/voice-bench';
import type { Run, TtsProvider } from '../src/voice';

let dir: string;
const servers: Server[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'flint-voice-bench-'));
});
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections?.();
    await new Promise<void>((r) => s.close(() => r()));
  }
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// the stand-ins

const SAY = '/usr/bin/say';
const AFCONVERT = '/usr/bin/afconvert';
const WHISPER = '/opt/whisper/bin/whisper-cli';
const WHISPER_SERVER = '/opt/whisper/bin/whisper-server';
/** Every fake clip plays for this long. */
const CLIP_SECONDS = 2;

/** A WAV, 16 kHz mono 16-bit, `seconds` long, whose first bytes are `text`. */
function fakeWav(text: string, seconds = CLIP_SECONDS): Buffer {
  const data = Buffer.alloc(seconds * 32_000);
  const words = Buffer.from(text, 'utf8');
  data.writeUInt16LE(words.length, 0);
  words.copy(data, 2);
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
/** The sentence a fake WAV holds, wherever the WAV sits in `bytes` (a file, or a multipart body). */
function heardIn(bytes: Buffer): string {
  const at = bytes.indexOf('data', bytes.indexOf('RIFF'), 'ascii');
  const n = bytes.readUInt16LE(at + 8);
  return bytes.toString('utf8', at + 10, at + 10 + n);
}

const VOICE_LIST = [
  'Albert              en_US    # Hello! My name is Albert.',
  'Daniel              en_GB    # Hello! My name is Daniel.',
  'Eddy (English (US)) en_US    # Hello! My name is Eddy.',
  'Karen               en_AU    # Hello! My name is Karen.',
  'Samantha (English (US)) en_US    # Hello! My name is Samantha.',
  'Samantha (English (US)) en_US    # Hello! My name is Samantha.',
  'Thomas              fr_FR    # Bonjour, je m’appelle Thomas.',
  'not a voice line',
].join('\n');

interface Rig {
  deps: BenchDeps;
  ran: Array<{ file: string; args: string[]; opts?: Record<string, unknown> | undefined }>;
  log: string[];
  clock: { ms: number };
  started: Array<{ bin: string; model: string; stopped: boolean }>;
  fetched: string[];
  /** Make "whisper" hear `wrong` in place of `right`, for one model. */
  mishear: Map<string, [string, string]>;
  out: string;
}

let rigs = 0;
/** A Mac with whisper.cpp, two models and `say`, all stand-ins. (Each has a home folder and an output folder of its own.) */
function rig(over: { env?: Record<string, string>; models?: string[]; missing?: string[]; platform?: NodeJS.Platform; server?: boolean } = {}): Rig {
  const id = ++rigs;
  const home = join(dir, `mac${id}`, 'home');
  const modelsDir = join(home, '.flint', 'models');
  mkdirSync(modelsDir, { recursive: true });
  for (const m of over.models ?? ['ggml-base.en.bin', 'ggml-small.en.bin']) writeFileSync(join(modelsDir, m), 'weights');
  // Things in that folder that are not whisper models are never read or named.
  writeFileSync(join(modelsDir, 'notes.txt'), 'PRIVATE-NOTE');
  writeFileSync(join(modelsDir, 'other-model.bin'), 'x');
  const out = join(dir, `mac${id}`, 'out');
  const ran: Rig['ran'] = [];
  const log: string[] = [];
  const clock = { ms: 0 };
  const started: Rig['started'] = [];
  const fetched: string[] = [];
  const mishear: Rig['mishear'] = new Map();
  const missing = new Set(over.missing ?? []);
  const hear = (wav: Buffer, model: string): string => {
    const said = heardIn(wav);
    const swap = mishear.get(model.replace(/^.*\//, ''));
    return swap ? said.replace(swap[0], swap[1]) : said;
  };
  const run: Run = async (file, args, opts) => {
    ran.push({ file, args: [...args], opts: opts as Record<string, unknown> | undefined });
    if (file === SAY && args[0] === '-v' && args[1] === '?') return { stdout: VOICE_LIST };
    if (file === SAY) {
      clock.ms += 500;
      const o = args[args.indexOf('-o') + 1]!;
      const text = readFileSync(args[args.indexOf('-f') + 1]!, 'utf8');
      writeFileSync(o, fakeWav(text));
      return { stdout: '' };
    }
    if (file === AFCONVERT) {
      clock.ms += 10;
      copyFileSync(args[0]!, args[1]!);
      return { stdout: '' };
    }
    if (file === WHISPER) {
      clock.ms += 250;
      return { stdout: ` ${hear(readFileSync(args[args.indexOf('-f') + 1]!), args[args.indexOf('-m') + 1]!)}\n` };
    }
    throw new Error(`a program the benchmark must not run: ${file}`);
  };
  const startServer = async (bin: string, model: string): Promise<StartedServer | undefined> => {
    const entry = { bin, model, stopped: false };
    started.push(entry);
    const s = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        clock.ms += 80;
        if (req.method !== 'POST' || req.url !== '/v1/audio/transcriptions') return void res.writeHead(404).end('{}');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ text: hear(Buffer.concat(chunks), model) }));
      });
    });
    servers.push(s);
    const port = await new Promise<number>((resolve) => s.listen(0, '127.0.0.1', () => resolve((s.address() as AddressInfo).port)));
    clock.ms += 300;
    return { baseURL: `http://127.0.0.1:${port}/v1`, loadMs: 300, stop: async () => void (entry.stopped = true) };
  };
  const deps: BenchDeps = {
    env: { WHISPER_BIN: WHISPER, ...over.env },
    run,
    fetch: ((url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      fetched.push(String(url));
      return fetch(url, init);
    }) as typeof fetch,
    now: () => clock.ms,
    readFile: (p) => readFileSync(p),
    writeFile: (p, data) => writeFileSync(p, data),
    mkdir: (p) => void mkdirSync(p, { recursive: true }),
    // The three programs are stand-ins; any other file is there only when it is one of this test's own. (Nothing
    // of the machine the tests run on is looked at: whisper.cpp may or may not be installed on it.)
    exists: (p) => !missing.has(p) && (p === SAY || p === WHISPER || p === WHISPER_SERVER || (p.startsWith(dir) && existsSync(p))),
    remove: (p) => rmSync(p, { force: true }),
    list: (d) => {
      try {
        return readdirSync(d);
      } catch {
        return [];
      }
    },
    join,
    ...(over.server === false ? {} : { startServer }),
    machine: { chip: 'Test Chip', memoryGb: 64, os: '27.0' },
    home,
    platform: over.platform ?? 'darwin',
    log: (l) => log.push(l),
    when: '2026-10-13T06:00:00.000Z',
  };
  return { deps, ran, log, clock, started, fetched, mishear, out };
}
const args = (over: Partial<BenchArgs> = {}): BenchArgs => ({ stt: ['whisper-cpp', 'local'], tts: ['say', 'local'], json: false, help: false, ...over });

// ---------------------------------------------------------------------------
describe('the arguments', () => {
  it('nothing given: both kinds of hearing, the Mac’s own voice and a local speech server, and never the paid one', () => {
    expect(parseBenchArgs([])).toEqual({ stt: ['whisper-cpp', 'local'], tts: ['say', 'local'], json: false, help: false });
    expect(parseBenchArgs(['--'])).toMatchObject({ json: false });
  });

  it('each option is read, and a list is made of names with commas between them', () => {
    expect(parseBenchArgs(['--out', '/tmp/x', '--models-dir', '/m', '--clips', '/c', '--voices', 'Samantha, Eddy (English (US))', '--rates', '175,220,175', '--stt', 'local', '--tts', 'say,openai', '--budget-usd', '0.25', '--json'])).toEqual({
      out: '/tmp/x',
      modelsDir: '/m',
      clips: '/c',
      voices: ['Samantha', 'Eddy (English (US))'],
      rates: [175, 220],
      stt: ['local'],
      tts: ['say', 'openai'],
      budgetUsd: 0.25,
      json: true,
      help: false,
    });
    expect(parseBenchArgs(['-h'])).toMatchObject({ help: true });
  });

  it('what is not understood is refused in a sentence, and never repeated back', () => {
    const bad: string[][] = [
      ['--token', 'sk-SECRET'],
      ['sk-SECRET'],
      ['--voices', '--help'],
      ['--voices', '-o /etc/passwd'],
      ['--voices', 'A,B,C,D,E,F,G'],
      ['--voices'],
      ['--rates', '50'],
      ['--rates', '1e3'],
      ['--rates', '175;rm'],
      ['--stt', 'openai'],
      ['--tts', 'elevenlabs'],
      ['--budget-usd', '0'],
      ['--budget-usd', '-1'],
      ['--budget-usd', 'lots'],
      ['--budget-usd'],
      ['--out'],
      ['--out', '--json'],
      ['--models-dir', ''],
      // A folder is printed in the results: one with a line break or an escape in it is no folder.
      ['--models-dir', '/m\n## Not on this Mac'],
      ['--out', '/tmp/x\u001b[2J'],
      ['--clips', '/c\u202egnp'],
    ];
    for (const argv of bad) {
      const r = parseBenchArgs(argv);
      expect('error' in r, argv.join(' ')).toBe(true);
      expect(JSON.stringify(r), argv.join(' ')).not.toMatch(/SECRET|passwd|elevenlabs|lots|1e3|;rm|Not on this Mac|2J|gnp/);
    }
  });
});

describe('the paid provider: an estimate first, and a cap', () => {
  const chars = SENTENCES.reduce((n, s) => n + s.length, 0);
  const estimate = (chars * 15) / 1_000_000;

  it('not named: not asked, whatever else is set', () => {
    expect(paidPlan({ tts: ['say', 'local'], budgetUsd: 5 }, SENTENCES, { model: 'tts-1', hasKey: true })).toEqual({ asked: false });
  });

  it('named with no cap: refused, and the sentence says what it would have cost and how to allow it', () => {
    const p = paidPlan({ tts: ['say', 'openai'] }, SENTENCES, { model: 'tts-1', hasKey: true });
    expect(p).toMatchObject({ asked: true, run: false, why: 'no_budget', chars, model: 'tts-1' });
    expect(p.asked && p.estimateUsd).toBeCloseTo(estimate, 10);
    expect(p.asked && p.sentence).toBe(`OpenAI speech is a paid service. This run would send it 10 sentences, ${chars} characters, for about $${estimate.toFixed(4)}. It was not called: run this again with --budget-usd and the most you want to spend.`);
  });

  it('a cap under the estimate is refused; no key is refused; a cap that covers it runs, and says the estimate all the same', () => {
    expect(paidPlan({ tts: ['openai'], budgetUsd: 0.001 }, SENTENCES, { model: 'tts-1', hasKey: true })).toMatchObject({ run: false, why: 'over_budget' });
    expect(paidPlan({ tts: ['openai'], budgetUsd: 1 }, SENTENCES, { model: 'tts-1', hasKey: false })).toMatchObject({ run: false, why: 'no_key' });
    const ok = paidPlan({ tts: ['openai'], budgetUsd: 1 }, SENTENCES, { model: 'tts-1', hasKey: true });
    expect(ok).toMatchObject({ asked: true, run: true, budgetUsd: 1 });
    expect(ok.asked && ok.sentence).toContain(`for about $${estimate.toFixed(4)}, within the $1.00 you allowed.`);
    // L10: said before anything is sent. Flint's own budget knows nothing of this run.
    expect(OUTSIDE_SPEND_RECORD).toBe("This is outside Flint's spend record: Flint's budget neither counts it nor stops it.");
    expect(ok.asked && ok.sentence.endsWith(` ${OUTSIDE_SPEND_RECORD}`)).toBe(true);
    // ...and afterwards, with what was really sent.
    expect(paidSpent(10, 552, 0.00828).sentence).toBe(`OpenAI speech was sent 10 sentences, 552 characters, which costs about $0.0083. ${OUTSIDE_SPEND_RECORD}`);
    expect(paidSpent(1, 54, 0.00081).sentence).toContain('was sent 1 sentence, 54 characters,');
    // A dearer model is a dearer estimate.
    const hd = paidPlan({ tts: ['openai'], budgetUsd: 1 }, SENTENCES, { model: 'tts-1-hd', hasKey: true });
    expect(hd.asked && hd.estimateUsd).toBeCloseTo(estimate * 2, 10);
  });
});

describe('the small pieces', () => {
  it('wavSeconds reads a WAV’s length from its own header, and says nothing of what is not one', () => {
    expect(wavSeconds(fakeWav('hello'))).toBe(2);
    expect(wavSeconds(fakeWav('hello', 5))).toBe(5);
    // A file whose header claims more than is there: what is there.
    expect(wavSeconds(fakeWav('hello').subarray(0, 44 + 16_000))).toBe(0.5);
    for (const not of [Buffer.alloc(0), Buffer.from('ID3 an mp3'), Buffer.concat([Buffer.from('RIFF....WAVE'), Buffer.alloc(40)]), Buffer.alloc(100)]) expect(wavSeconds(not)).toBeUndefined();
  });

  it('sayVoices reads the names say lists, whole, and nothing that is not a line of that list', () => {
    expect(sayVoices(VOICE_LIST)).toEqual(['Albert', 'Daniel', 'Eddy (English (US))', 'Karen', 'Samantha (English (US))', 'Thomas']);
    expect(sayVoices('')).toEqual([]);
    expect(sayVoices('--help en_US # x\n$(reboot) en_US # y')).toEqual([]);
  });

  it('spread: the middle, the slow end and the mean, in whole milliseconds', () => {
    expect(spread([])).toEqual({ n: 0, medianMs: 0, p95Ms: 0, meanMs: 0 });
    expect(spread([100])).toEqual({ n: 1, medianMs: 100, p95Ms: 100, meanMs: 100 });
    expect(spread([300, 100, 200, 400])).toEqual({ n: 4, medianMs: 200, p95Ms: 400, meanMs: 250 });
    expect(spread(Array.from({ length: 100 }, (_, i) => i + 1))).toMatchObject({ medianMs: 50, p95Ms: 95 });
  });

  it('sayToWav: the text is in a file and never an argument, the arguments are fixed, and -o is always there', async () => {
    const ran: Array<{ file: string; args: string[]; opts: unknown }> = [];
    const files = new Map<string, string>();
    const d = { run: (async (file, a, opts) => (ran.push({ file, args: [...a], opts }), { stdout: '' })) as Run, writeFile: (p: string, data: Buffer | string) => void files.set(p, String(data)) };
    await sayToWav(d, { text: '-v Zarvox; say this $(reboot)', textFile: '/t/one.txt', out: '/t/one.wav', voice: 'Eddy (English (US))', rate: 220 });
    // The review's M31: `say` is handed NO environment (not this process's, with its keys and its tokens), and a time limit it cannot ignore.
    expect(ran).toEqual([
      { file: '/usr/bin/say', args: ['-o', '/t/one.wav', '--file-format=WAVE', '--data-format=LEI16@16000', '-r', '220', '-v', 'Eddy (English (US))', '-f', '/t/one.txt'], opts: { timeout: 60_000, killSignal: 'SIGKILL', env: {} } },
    ]);
    expect(files.get('/t/one.txt')).toBe('-v Zarvox; say this $(reboot)');
    expect(ran[0]!.args.join(' ')).not.toContain('reboot');
    // A voice or a rate that is not one is refused before anything runs.
    for (const [voice, rate] of [['-o /etc/passwd', 175], ['--help', 175], ['Samantha;x', 175], ['', 175], ['Samantha', 89], ['Samantha', 401], ['Samantha', 175.5], ['Samantha', Number.NaN]] as const) {
      await expect(sayToWav(d, { text: 'x', textFile: '/t/x.txt', out: '/t/x.wav', voice, rate })).rejects.toThrow(/not a (voice name|speaking rate)/);
    }
    expect(ran).toHaveLength(1);
  });

  it('the sentences are plain: no digit and no line break, so a transcript differs only by a word heard wrong', () => {
    expect(SENTENCES).toHaveLength(10);
    for (const s of SENTENCES) {
      expect(s).toMatch(/^[A-Z][A-Za-z ,]+[.?]$/);
      expect(s.length).toBeLessThan(80);
    }
    expect(new Set(SENTENCES).size).toBe(10);
    expect(CLIP_VOICES.length).toBeGreaterThanOrEqual(3);
    expect(CLIP_RATES).toEqual([175, 220]);
  });
});

describe('what is not on this Mac: a command for each, and none of them run', () => {
  it('a model that is here is not offered; one that is not gets the exact line to fetch it, and where it goes', () => {
    const HERE = { modelsDir: '/Users/will/.flint/models', home: '/Users/will' };
    const h = hintsFor({ whisperCli: true, whisperServer: true, say: true, models: ['ggml-base.en.bin', 'ggml-small.en.bin'], localTtsSet: false, ...HERE });
    expect(h.map((x) => x.what)).toEqual(['the speech model ggml-large-v3-turbo-q5_0.bin', 'the speech model ggml-large-v3-turbo.bin', 'a neural voice on this Mac']);
    // The review's M2. The setting is the FULL path: neither the settings file nor a LaunchAgent expands `~`, and
    // the line this printed before ("set WHISPER_MODEL=~/.flint/models/...") failed every recording when followed.
    // The command is typed in Terminal, which does read `~`, so there the usual folder is written the short way.
    expect(h[0]).toMatchObject({
      command: 'curl -L --fail --create-dirs -o ~/.flint/models/ggml-large-v3-turbo-q5_0.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin',
      disk: 'about 574 MB',
      then: 'To use it: set WHISPER_MODEL=/Users/will/.flint/models/ggml-large-v3-turbo-q5_0.bin and restart Flint.',
    });
    for (const x of h) expect(x.then ?? '', x.what).not.toMatch(/=~|= ~/);
    // Models kept somewhere else: the line fetches into THAT folder (so the next run finds the model), quoted when
    // the folder's name needs it, and the setting names it there.
    const kept = hintsFor({ whisperCli: true, whisperServer: true, say: true, models: [], localTtsSet: true, modelsDir: "/Volumes/Big Disk/will's models", home: '/Users/will' });
    expect(kept[0]).toMatchObject({
      command: "curl -L --fail --create-dirs -o '/Volumes/Big Disk/will'\\''s models/ggml-base.en.bin' https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin",
      then: "To use it: set WHISPER_MODEL=/Volumes/Big Disk/will's models/ggml-base.en.bin and restart Flint.",
    });
    expect(shellWord('/opt/models/ggml-base.en.bin')).toBe('/opt/models/ggml-base.en.bin');
    expect(shellWord('/a b/$(reboot);x')).toBe("'/a b/$(reboot);x'");
    // Every one of them says it was not tried here: this file installs nothing.
    expect(h.every((x) => x.tried === false)).toBe(true);
    for (const m of WHISPER_MODELS) expect(m.file).toMatch(/^ggml-[a-z0-9._-]+\.bin$/);
  });

  it('no whisper.cpp: the one line that installs it; a local speech server already set: no line for one', () => {
    const HERE = { modelsDir: '/Users/will/.flint/models', home: '/Users/will' };
    const none = hintsFor({ whisperCli: false, whisperServer: false, say: true, models: [], localTtsSet: true, ...HERE });
    expect(none[0]).toMatchObject({ what: 'whisper.cpp', command: 'brew install whisper-cpp' });
    expect(none.map((x) => x.what)).not.toContain('a neural voice on this Mac');
    expect(none.filter((x) => x.what.startsWith('the speech model'))).toHaveLength(WHISPER_MODELS.length);
    // The speech server it suggests is published on this Mac alone.
    const voice = hintsFor({ whisperCli: true, whisperServer: true, say: true, models: [], localTtsSet: false, ...HERE }).at(-1)!;
    expect(voice.command).toContain('-p 127.0.0.1:8880:8880');
    expect(voice.then).toContain('FLINT_LOCAL_TTS_BASE_URL=http://127.0.0.1:8880/v1');
  });
});

// ---------------------------------------------------------------------------
describe('a whole run, on stand-ins', () => {
  it('clips are spoken into files, every model is heard both ways, the Mac’s own voices speak, and the numbers are the ones the stand-ins make', async () => {
    const r = rig();
    r.mishear.set('ggml-base.en.bin', ['dentist', 'dentists']); // one word wrong, in one sentence, on the base model
    const result = await runBench(args({ out: r.out, voices: ['Samantha', 'Daniel'], rates: [175] }), r.deps);

    // 2 voices x 1 rate x 10 sentences, 2 seconds each.
    expect(result.clips).toEqual({ count: 20, seconds: 40, voices: ['Samantha', 'Daniel'], rates: [175], sentences: 10 });
    expect(readdirSync(join(r.out, 'clips')).filter((f) => f.endsWith('.wav'))).toHaveLength(20);

    // Hearing: the usual model first, each model as Flint runs it today and through a server on this Mac.
    expect(result.stt.map((s) => [s.engine, s.model])).toEqual([
      ['whisper-cpp', 'ggml-base.en.bin'],
      ['local', 'ggml-base.en.bin'],
      ['whisper-cpp', 'ggml-small.en.bin'],
      ['local', 'ggml-small.en.bin'],
    ]);
    const words = SENTENCES.reduce((n, s) => n + s.split(' ').length, 0) * 2;
    const [cli, server, small] = result.stt;
    // One run per clip: afconvert (10 ms) and whisper-cli (250 ms), for a 2-second clip.
    expect(cli).toMatchObject({ n: 20, medianMs: 260, p95Ms: 260, meanMs: 260, audioSeconds: 40, realTimeFactor: 0.13, words, errors: 2, firstMs: 260, failed: 0 });
    expect(cli!.wordErrorRate).toBeCloseTo(2 / words, 10);
    expect(Object.keys(cli!.byVoice)).toEqual(['Samantha', 'Daniel']);
    expect(Object.keys(cli!.byRate)).toEqual(['175']);
    expect(cli!.loadMs).toBeUndefined();
    // The server: the recording is made into WAV (10 ms) and posted (80 ms); it took 300 ms to start.
    expect(server).toMatchObject({ n: 20, medianMs: 90, realTimeFactor: 0.045, errors: 2, loadMs: 300, firstMs: 90 });
    expect(small).toMatchObject({ errors: 0, wordErrorRate: 0 });
    // A model is named by its file, never by where it is. The one place a folder of this Mac is written is the
    // setting a missing model would need, which has to be the full path (M2).
    expect(JSON.stringify({ ...result, notInstalled: [] })).not.toContain(dir);
    expect(result.notInstalled.filter((h) => JSON.stringify(h).includes(dir)).map((h) => h.then)).toEqual([
      `To use it: set WHISPER_MODEL=${join(r.deps.home, '.flint', 'models', 'ggml-large-v3-turbo-q5_0.bin')} and restart Flint.`,
      `To use it: set WHISPER_MODEL=${join(r.deps.home, '.flint', 'models', 'ggml-large-v3-turbo.bin')} and restart Flint.`,
    ]);

    // Speaking: the Mac's usual voice, then each voice the clips were spoken in; whole files, heard back with the usual model.
    expect(result.tts.map((t) => [t.engine, t.voice, t.n])).toEqual([
      ['say', 'the usual voice', 10],
      ['say', 'Samantha', 10],
      ['say', 'Daniel', 10],
    ]);
    for (const t of result.tts) {
      expect(t.firstAudio.medianMs).toBe(t.total.medianMs);
      expect(t).toMatchObject({ total: { medianMs: 500 }, audioSeconds: 20, realTimeFactor: 0.25, heardBy: 'whisper.cpp ggml-base.en.bin', failed: 0 });
    }
    // (Heard back by the model that mishears "dentist": one error in the ten sentences.)
    expect(result.tts[0]!.heardBackWordErrorRate).toBeCloseTo(1 / (words / 2), 10);
    expect(readdirSync(join(r.out, 'speech')).filter((f) => f.endsWith('.m4a'))).toHaveLength(30);

    expect(result.paid).toEqual({ asked: false });
    expect(result.notes).toEqual([]);
    expect(result.notInstalled.map((h) => h.what)).toEqual(['the speech model ggml-large-v3-turbo-q5_0.bin', 'the speech model ggml-large-v3-turbo.bin', 'a neural voice on this Mac']);
  });

  it('nothing is played, nothing is installed, and nothing but the three programs is run: say always with a file to write to', async () => {
    const r = rig();
    await runBench(args({ out: r.out, voices: ['Samantha'], rates: [175, 220] }), r.deps);
    expect(new Set(r.ran.map((x) => x.file))).toEqual(new Set([SAY, AFCONVERT, WHISPER]));
    for (const call of r.ran.filter((x) => x.file === SAY && x.args[0] !== '-v')) {
      expect(call.args[0]).toBe('-o');
      expect(call.args).toContain('-f');
      // The sentence is in the file say reads, never among the arguments.
      for (const s of SENTENCES) expect(call.args.join(' ')).not.toContain(s.slice(0, 20));
    }
    // The one say call with no file to write is the one that lists voices.
    expect(r.ran.filter((x) => x.file === SAY && !x.args.includes('-o')).map((x) => x.args)).toEqual([['-v', '?']]);
    // M31: every `say` of the run, the listing too, is handed an empty environment.
    const says = r.ran.filter((x) => x.file === SAY);
    expect(says.length).toBeGreaterThan(20);
    for (const call of says) expect(call.opts?.env, call.args.join(' ')).toEqual({});
    // Every request went to this Mac.
    expect(r.fetched.length).toBeGreaterThan(0);
    for (const url of r.fetched) expect(new URL(url).hostname).toBe('127.0.0.1');
    // Each server it started was given the model by its path, and was stopped.
    expect(r.started.map((s) => [s.bin, s.model.replace(r.deps.home, '~'), s.stopped])).toEqual([
      [WHISPER_SERVER, '~/.flint/models/ggml-base.en.bin', true],
      [WHISPER_SERVER, '~/.flint/models/ggml-small.en.bin', true],
    ]);
    // Only whisper's own model files were taken from that folder.
    expect(r.ran.filter((x) => x.file === WHISPER).every((x) => /ggml-(base|small)\.en\.bin$/.test(x.args[x.args.indexOf('-m') + 1]!))).toBe(true);
    // Neither the code nor the command names a player, an installer or a shell.
    for (const file of ['../src/voice-bench.ts', '../scripts/voice-bench.ts']) {
      const src = readFileSync(join(__dirname, file), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
      expect(src, file).not.toMatch(/afplay|osascript|execSync|shell: true|['"`]open['"`]/);
      // (child_process is used for spawn alone, in the command: never exec, which runs a shell.)
      expect(src, file).not.toMatch(/import \{[^}]*\bexec\b[^}]*\} from 'node:child_process'/);
      expect(src.replace(/command: [^\n]*|modelCommand = [^\n]*/g, ''), file).not.toMatch(/\bcurl\b|\bbrew\b|\bdocker\b|ollama pull|pip3? install/);
    }
  });

  // Will's own clips, when he has some: a folder of recordings, each beside a text file of the words said.
  it('--clips: a folder of recorded clips is heard in place of the synthetic ones, scored against the text beside each, read where it is and never copied', async () => {
    const mine = join(dir, 'my-clips');
    mkdirSync(mine);
    writeFileSync(join(mine, 'kitchen.wav'), fakeWav('Turn off the lights in the kitchen.', 3));
    writeFileSync(join(mine, 'kitchen.txt'), 'Turn off the lights in the kitchen.\n');
    writeFileSync(join(mine, 'airport.m4a'), fakeWav('how long to the airport', 4));
    writeFileSync(join(mine, 'airport.txt'), '  How long   does it take to the airport?  ');
    writeFileSync(join(mine, 'no-words.wav'), fakeWav('nothing beside this one'));
    writeFileSync(join(mine, 'broken.wav'), 'not audio');
    writeFileSync(join(mine, 'broken.txt'), 'something');
    writeFileSync(join(mine, 'notes.md'), 'not a clip');
    const r = rig();
    const result = await runBench(args({ out: r.out, clips: mine, stt: ['whisper-cpp'], tts: [] }), r.deps);
    expect(result.clips).toEqual({ count: 2, seconds: 7, voices: [], rates: [], sentences: 10, own: true });
    const [base] = result.stt;
    // 15 words said (7 and 8); the airport clip was heard without "does it take" (3 missing).
    expect(base).toMatchObject({ engine: 'whisper-cpp', model: 'ggml-base.en.bin', n: 2, audioSeconds: 7, words: 15, errors: 3, byVoice: { 'your clips': 0.2 }, byRate: {} });
    expect(result.notes).toEqual(['1 clip had no text file beside it saying what was said, so it was left out.', '1 clip could not be read and was left out.']);
    // No synthetic clip was made, and his own were not copied: the WAV each was measured by is gone.
    expect(r.ran.filter((x) => x.file === SAY && x.args.includes('-o'))).toEqual([]);
    expect(readdirSync(join(r.out, 'clips'))).toEqual([]);
    expect(readdirSync(mine).sort()).toEqual(['airport.m4a', 'airport.txt', 'broken.txt', 'broken.wav', 'kitchen.txt', 'kitchen.wav', 'no-words.wav', 'notes.md']);
    const page = renderBench(result);
    expect(page).toContain('Clips: 2 of your own clips, 7 seconds in all, each scored against the text file beside it. They were read where they are: none was copied, nothing was played, and nothing left this Mac.');
    expect(page).not.toContain('synthetic');
    // An empty folder, or one with nothing usable: said, and nothing heard.
    const none = rig();
    const empty = await runBench(args({ out: none.out, clips: join(dir, 'nowhere'), stt: ['whisper-cpp'], tts: [] }), none.deps);
    expect(empty.stt).toEqual([]);
    expect(empty.notes).toContain('No clip with a text file beside it was found in that folder, so nothing was heard.');
    // More than one: said in the plural.
    writeFileSync(join(mine, 'also-no-words.wav'), fakeWav('nothing beside this one either'));
    writeFileSync(join(mine, 'also-broken.wav'), 'not audio');
    writeFileSync(join(mine, 'also-broken.txt'), 'something');
    const more = rig();
    const two = await runBench(args({ out: more.out, clips: mine, stt: ['whisper-cpp'], tts: [] }), more.deps);
    expect(two.notes).toEqual(['2 clips had no text file beside them saying what was said, so they were left out.', '2 clips could not be read and were left out.']);
  });

  // The review's M1, for the benchmark. With `--clips` what is posted to the transcription server it starts is
  // WILL'S OWN VOICE. That server is at this Mac's own address, and a request for that address goes wherever Node
  // sends it: through its env proxy, when that is on and the no-proxy list does not name the address as Node needs
  // it named. Six spellings used to be read as "direct" while Node proxied them.
  describe('--clips and a proxy: his recordings are posted to this Mac’s own address only when Node would reach it directly', () => {
    const ON = { NODE_USE_ENV_PROXY: '1', HTTP_PROXY: 'http://proxy.example:3128' };
    const own = (): string => {
      const mine = join(dir, `clips-${++rigs}`);
      mkdirSync(mine);
      writeFileSync(join(mine, 'kitchen.wav'), fakeWav('Turn off the lights in the kitchen.', 3));
      writeFileSync(join(mine, 'kitchen.txt'), 'Turn off the lights in the kitchen.\n');
      return mine;
    };

    it.each(NO_PROXY_SPELLINGS.map((s) => [s.label, s] as const))('%s', async (_label, s) => {
      const r = rig({ env: { ...ON, ...s.env } });
      const result = await runBench(args({ out: r.out, clips: own(), stt: ['whisper-cpp', 'local'], tts: [] }), r.deps);
      // One run per clip is a program on this Mac: no address, no proxy, measured either way.
      expect(result.stt.filter((x) => x.engine === 'whisper-cpp').map((x) => [x.model, x.n])).toEqual([
        ['ggml-base.en.bin', 1],
        ['ggml-small.en.bin', 1],
      ]);
      if (s.direct.v4) {
        // Node reaches 127.0.0.1 directly: the server is started, his clip is posted to it, and to nothing else.
        expect(r.started.map((x) => x.stopped)).toEqual([true, true]);
        expect(result.stt.filter((x) => x.engine === 'local').map((x) => [x.model, x.n, x.failed])).toEqual([
          ['ggml-base.en.bin', 1, 0],
          ['ggml-small.en.bin', 1, 0],
        ]);
        expect(r.fetched.length).toBeGreaterThan(0);
        for (const url of r.fetched) expect(new URL(url).hostname).toBe('127.0.0.1');
        expect(result.notes.join(' ')).not.toContain('proxy');
      } else {
        // Node would hand the request to the proxy: the server is never started, and not one request is made.
        expect(r.started).toEqual([]);
        expect(r.fetched).toEqual([]);
        expect(result.stt.filter((x) => x.engine === 'local')).toEqual([]);
        expect(result.notes).toEqual(["This Mac's own address is reached through a proxy here, so the local transcription server was not started and no clip was sent to it."]);
      }
      expect(JSON.stringify(result)).not.toContain('proxy.example');
    });

    it('a transcription server Will already runs is asked through the same settings: proxied, it is not sent a clip', async () => {
      const got: string[] = [];
      const s = createServer((req, res) => {
        got.push(req.url ?? '');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ text: 'Turn off the lights in the kitchen.' }));
      });
      servers.push(s);
      const port = await new Promise<number>((resolve) => s.listen(0, '127.0.0.1', () => resolve((s.address() as AddressInfo).port)));
      const set = { FLINT_STT_PROVIDER: 'local', FLINT_LOCAL_STT_BASE_URL: `http://127.0.0.1:${port}/v1` };
      const proxied = rig({ env: { ...ON, NO_PROXY: ' * ', ...set }, server: false });
      const none = await runBench(args({ out: proxied.out, clips: own(), stt: ['local'], tts: [] }), proxied.deps);
      expect([none.stt, got, proxied.fetched]).toEqual([[], [], []]);
      const direct = rig({ env: { ...ON, NO_PROXY: '127.0.0.1', ...set }, server: false });
      const heard = await runBench(args({ out: direct.out, clips: own(), stt: ['local'], tts: [] }), direct.deps);
      expect(heard.stt.map((x) => [x.engine, x.n, x.errors])).toEqual([['local', 1, 0]]);
      expect(got.length).toBeGreaterThan(0);
    });
  });

  it('the options choose what is measured, and voices this Mac does not have are said, not spoken', async () => {
    const r = rig();
    const only = await runBench(args({ out: r.out, voices: ['Samantha', 'Zarvox'], rates: [175], stt: ['whisper-cpp'], tts: ['local'] }), r.deps);
    expect(only.stt.map((s) => s.engine)).toEqual(['whisper-cpp', 'whisper-cpp']);
    expect(only.tts).toEqual([]); // no local speech server is set, and say was not asked for
    expect(only.clips.voices).toEqual(['Samantha']);
    expect(only.notes).toEqual(['The voice Zarvox is not on this Mac, so no clip was spoken in it.']);
    expect(r.started).toEqual([]);
    // With no voices named: the first three of the usual six that this Mac has.
    const usual = await runBench(args({ out: join(dir, 'out2'), rates: [175], stt: [], tts: [] }), rig().deps);
    expect(usual.clips.voices).toEqual(['Samantha', 'Daniel', 'Karen']);
  });

  it('what is missing is left out and said, with the command for it: no whisper.cpp, no model, no say', async () => {
    const noCli = rig({ missing: [WHISPER, WHISPER_SERVER] });
    const a = await runBench(args({ out: noCli.out, voices: ['Samantha'], rates: [175] }), noCli.deps);
    expect(a.stt).toEqual([]);
    expect(a.notes).toContain('whisper.cpp is not installed, so transcription was not measured.');
    expect(a.notInstalled[0]).toMatchObject({ command: 'brew install whisper-cpp' });
    // The Mac's own voice is still measured, with nothing to hear it back.
    expect(a.tts).toHaveLength(2);
    expect(a.tts[0]!.heardBackWordErrorRate).toBeUndefined();
    expect(noCli.ran.some((x) => x.file === WHISPER)).toBe(false);

    const noModels = rig({ models: [] });
    const b = await runBench(args({ out: noModels.out, voices: ['Samantha'], rates: [175] }), noModels.deps);
    expect(b.stt).toEqual([]);
    expect(b.notes).toContain('No whisper.cpp model was found, so transcription was not measured.');
    expect(b.notInstalled.filter((h) => h.what.startsWith('the speech model'))).toHaveLength(WHISPER_MODELS.length);

    const noServer = rig({ missing: [WHISPER_SERVER] });
    const c = await runBench(args({ out: noServer.out, voices: ['Samantha'], rates: [175] }), noServer.deps);
    expect(c.stt.map((s) => s.engine)).toEqual(['whisper-cpp', 'whisper-cpp']);
    expect(c.notInstalled[0]).toMatchObject({ what: 'whisper.cpp’s server' });

    const linux = rig({ platform: 'linux' });
    const d = await runBench(args({ out: linux.out }), linux.deps);
    expect([d.clips.count, d.stt, d.tts]).toEqual([0, [], []]);
    expect(d.notes[0]).toMatch(/no `say`/);
    expect(linux.ran).toEqual([]);
  });

  it('a model a setting names that is not there is refused, as the server refuses it: the usual folder is what is measured', async () => {
    const r = rig({ env: { WHISPER_MODEL: '/nonexistent/old/ggml-gone.bin' } });
    const result = await runBench(args({ out: r.out, voices: ['Samantha'], rates: [175], stt: ['whisper-cpp'], tts: [] }), r.deps);
    // The two models in the usual folder, the usual one first; nothing of the stale path is run or named.
    expect(result.stt.map((s) => [s.engine, s.model, s.failed])).toEqual([
      ['whisper-cpp', 'ggml-base.en.bin', 0],
      ['whisper-cpp', 'ggml-small.en.bin', 0],
    ]);
    expect(JSON.stringify(result) + JSON.stringify(r.ran)).not.toMatch(/nonexistent|ggml-gone/);
  });

  it('a local speech server that is already set up is measured as it is, through Flint’s own settings', async () => {
    // A stand-in for a speech server on this Mac: /v1/audio/speech answers with a WAV of the words it was sent.
    const spoken: string[] = [];
    const s = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { input: string; model: string; voice: string };
        spoken.push(`${body.model}/${body.voice}`);
        res.writeHead(200, { 'content-type': 'audio/wav' });
        res.end(fakeWav(body.input, 3));
      });
    });
    servers.push(s);
    const port = await new Promise<number>((resolve) => s.listen(0, '127.0.0.1', () => resolve((s.address() as AddressInfo).port)));
    const r = rig({ env: { FLINT_TTS_PROVIDER: 'local', FLINT_LOCAL_TTS_BASE_URL: `http://127.0.0.1:${port}/v1`, FLINT_LOCAL_TTS_MODEL: 'kokoro', FLINT_LOCAL_TTS_VOICE: 'af_heart' } });
    const result = await runBench(args({ out: r.out, voices: ['Samantha'], rates: [175], stt: ['whisper-cpp'], tts: ['local'] }), r.deps);
    expect(result.tts).toHaveLength(1);
    expect(result.tts[0]).toMatchObject({ engine: 'local', voice: 'af_heart', model: 'kokoro', n: 10, audioSeconds: 30, heardBackWordErrorRate: 0, failed: 0 });
    expect(new Set(spoken)).toEqual(new Set(['kokoro/af_heart']));
    expect(result.notInstalled.map((h) => h.what)).not.toContain('a neural voice on this Mac');
    // An address that is not this Mac is refused by the same settings: nothing is sent there, and nothing is measured.
    const away = rig({ env: { FLINT_TTS_PROVIDER: 'local', FLINT_LOCAL_TTS_BASE_URL: 'https://speech.example/v1' } });
    const none = await runBench(args({ out: away.out, voices: ['Samantha'], rates: [175], stt: [], tts: ['local'] }), away.deps);
    expect(none.tts).toEqual([]);
    expect(away.fetched).toEqual([]);
  });

  it('the paid provider: said first, called only inside the cap, and never when it is not named', async () => {
    const calls: string[] = [];
    const openai = ((url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      if (!String(url).startsWith('https://api.openai.com/')) return fetch(url, init);
      calls.push((JSON.parse(String(init?.body)) as { input: string }).input);
      return Promise.resolve(new Response(new Uint8Array(fakeWav('x')), { status: 200, headers: { 'content-type': 'audio/wav' } }));
    }) as typeof fetch;
    const env = { OPENAI_API_KEY: 'sk-test-not-a-key' };
    // Not named: never called, with a key and a budget both there.
    const quiet = rig({ env });
    await runBench(args({ out: quiet.out, voices: ['Samantha'], rates: [175], stt: [], budgetUsd: 5 }), { ...quiet.deps, fetch: openai });
    expect(calls).toEqual([]);
    // Named, with a cap that covers it: the estimate is the first thing said, then it is called.
    const r = rig({ env });
    const result = await runBench(args({ out: r.out, voices: ['Samantha'], rates: [175], stt: [], tts: ['openai'], budgetUsd: 1 }), { ...r.deps, fetch: openai });
    // L10. Said first, before anything is sent: what it would cost, and that Flint's own budget knows nothing of it.
    expect(r.log[0]).toMatch(/^OpenAI speech is a paid service\. This run would send it 10 sentences, \d+ characters, for about \$0\.00\d+, within the \$1\.00 you allowed\. This is outside Flint's spend record: Flint's budget neither counts it nor stops it\.$/);
    expect(calls).toEqual([...SENTENCES]);
    expect(result.tts.map((t) => [t.engine, t.n])).toEqual([['openai', 10]]);
    expect(result.tts[0]!.estimateUsd).toBeGreaterThan(0);
    // ...and said again when it is over, with what was really sent and what that costs.
    const chars = SENTENCES.reduce((n, x) => n + x.length, 0);
    const after = `OpenAI speech was sent 10 sentences, ${chars} characters, which costs about $${((chars * 15) / 1_000_000).toFixed(4)}. ${OUTSIDE_SPEND_RECORD}`;
    expect(r.log.at(-1)).toBe(after);
    expect(result.paidSpent).toMatchObject({ sentences: 10, chars, sentence: after });
    expect(result.paidSpent!.usd).toBeCloseTo((chars * 15) / 1_000_000, 10);
    expect(result.tts[0]!.sent).toMatchObject({ sentences: 10, chars });
    const page = renderBench(result);
    expect(page).toContain(`## The paid provider\n\n${r.log[0]}\n\n${after}\n`);
    // A run that sends nothing says nothing of having sent.
    expect(quiet.log.join('\n')).not.toContain('OpenAI');
    expect(JSON.stringify(result) + r.log.join('\n')).not.toContain('sk-test');
    // Named and not allowed (runBench alone, without the command's own stop): nothing is sent.
    calls.length = 0;
    for (const over of [{}, { budgetUsd: 0.0001 }]) {
      const no = rig({ env });
      const out = await runBench(args({ out: no.out, voices: ['Samantha'], rates: [175], stt: [], tts: ['openai'], ...over }), { ...no.deps, fetch: openai });
      expect(out.tts).toEqual([]);
      expect(out.paid).toMatchObject({ asked: true, run: false });
      expect(out.paidSpent).toBeUndefined();
      expect(no.log.join('\n')).not.toContain('was sent');
    }
    expect(calls).toEqual([]);
  });

  // The review's M13: the stop inside the paid run was held by no test. The estimate is checked before the run
  // starts; this is the second fence, sentence by sentence, for a run whose sentences cost more than was estimated.
  it('a paid engine stops before the sentence that would pass the cap, and says what it sent: nothing after that is sent', async () => {
    const r = rig();
    const sent: string[] = [];
    const paid: TtsProvider = {
      name: 'openai',
      local: false,
      vendor: 'openai',
      model: 'tts-1',
      voice: 'onyx',
      synthesize: async (text) => (sent.push(text), { audio: fakeWav(text), contentType: 'audio/wav' }),
    };
    const cost = (n: number): number => (SENTENCES.slice(0, n).reduce((a, x) => a + x.length, 0) * 15) / 1_000_000;
    // A cap that covers three sentences and not the fourth.
    const row = await speakAll(r.deps, paid, 'openai', join(r.out, 'speech'), { capUsd: (cost(3) + cost(4)) / 2, estimateUsd: cost(10) });
    expect(sent).toEqual(SENTENCES.slice(0, 3));
    expect(row.n).toBe(3);
    expect(row.sent).toMatchObject({ sentences: 3, chars: SENTENCES.slice(0, 3).reduce((a, x) => a + x.length, 0) });
    expect(row.sent!.usd).toBeCloseTo(cost(3), 10);
    // A cap below the first sentence: nothing is sent at all.
    sent.length = 0;
    const none = await speakAll(r.deps, paid, 'openai', join(r.out, 'speech'), { capUsd: cost(1) / 2 });
    expect(sent).toEqual([]);
    expect(none.sent).toEqual({ sentences: 0, chars: 0, usd: 0 });
    // A sentence that was sent and came back as nothing is still counted as sent: it is what is charged for.
    const mute: TtsProvider = { ...paid, synthesize: async (text) => (sent.push(text), null) };
    const lost = await speakAll(r.deps, mute, 'openai', join(r.out, 'speech'), { capUsd: 1 });
    expect([lost.n, lost.failed, lost.sent!.sentences]).toEqual([0, 10, 10]);
    // An engine with no cap (one on this Mac) is never stopped, and reports nothing sent.
    const free = await speakAll(r.deps, { ...paid, name: 'say', local: true }, 'say', join(r.out, 'speech'));
    expect([free.n, free.sent]).toEqual([10, undefined]);
  });
});

// ---------------------------------------------------------------------------
describe('the report', () => {
  it('two tables, what the numbers mean, what was not measured and the command for it, and that nothing was changed', async () => {
    const r = rig();
    r.mishear.set('ggml-base.en.bin', ['dentist', 'dentists']);
    const page = renderBench(await runBench(args({ out: r.out, voices: ['Samantha'], rates: [175] }), r.deps));
    expect(page).toContain('# Voice benchmark');
    expect(page).toContain('Run 2026-10-13T06:00:00.000Z on Test Chip, 64 GB, macOS 27.0.');
    expect(page).toContain('Clips: 10 synthetic clips, 20 seconds in all (10 fixed sentences, spoken into files by the Mac\'s own voices Samantha at 175 words a minute). Nobody was recorded, nothing was played, and nothing left this Mac.');
    expect(page).toMatch(/\| whisper\.cpp, one run per clip \(what Flint does today\) +\| ggml-base\.en\.bin +\| 10 +\| 260 ms +\| 260 ms +\| 0\.130 +\| 0\.9% \(1 of 109 words\) +\| 260 ms +\|/);
    expect(page).toMatch(/\| whisper\.cpp as a server on this Mac \(the local provider\) +\| ggml-small\.en\.bin +\| 10 +\| 90 ms +\| 90 ms +\| 0\.045 +\| 0\.0% \(0 of 109 words\) +\| 90 ms, after 300 ms to start \|/);
    expect(page).toMatch(/\| this Mac's own voice \(say\) +\| Samantha +\| 10 +\| 500 ms +\| 500 ms +\| 500 ms +\| 0\.250 +\| 0\.9% word error rate \|/);
    expect(page).toContain('Real-time factor is the time spent over the length of the audio. Under 1 is faster than speech');
    expect(page).toContain('Nothing below was run or downloaded.');
    expect(page).toContain('  curl -L --fail --create-dirs -o ~/.flint/models/ggml-large-v3-turbo.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin');
    expect(page.trimEnd().endsWith('No setting was changed by this run.')).toBe(true);
    // M2: the setting for a model that is not here is its full path, with no `~` for nothing to expand.
    expect(page).toContain(`  To use it: set WHISPER_MODEL=${join(r.deps.home, '.flint', 'models', 'ggml-large-v3-turbo.bin')} and restart Flint.`);
    expect(page).not.toMatch(/WHISPER_MODEL=~/);
    // No other path of this machine is in it.
    expect(page.replace(/To use it: set WHISPER_MODEL=[^\n]*/g, '')).not.toContain(dir);
  });
});

// ---------------------------------------------------------------------------
describe('the command', () => {
  const io = () => {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, d: { out: (l: string) => void out.push(l), err: (l: string) => void err.push(l) } };
  };

  it('--help prints how to use it; an argument that is not understood is exit 2, with the usage and without the argument', async () => {
    const help = io();
    expect(await main(['--help'], { env: {}, home: dir, ...help.d })).toBe(0);
    expect(help.out).toEqual([USAGE]);
    const bad = io();
    expect(await main(['--token', 'sk-SECRET'], { env: {}, home: dir, ...bad.d })).toBe(2);
    expect(bad.err).toEqual(['voice-bench: an argument was not understood.', USAGE]);
    expect(bad.out).toEqual([]);
  });

  it('the paid provider named with no cap: exit 2 with the estimate, before a clip is made or a request is sent', async () => {
    const r = rig({ env: { OPENAI_API_KEY: 'sk-test-not-a-key' } });
    for (const argv of [['--tts', 'say,openai'], ['--tts', 'openai', '--budget-usd', '0.0001']]) {
      const o = io();
      expect(await main(['--out', r.out, ...argv], { env: r.deps.env, home: r.deps.home, ...o.d, bench: r.deps }), argv.join(' ')).toBe(2);
      expect(o.err).toHaveLength(1);
      expect(o.err[0]).toMatch(/^OpenAI speech is a paid service\. This run would send it 10 sentences, \d+ characters, for about \$0\.00\d+/);
      expect(o.err[0]).toMatch(/It was not called/);
      expect(o.out).toEqual([]);
    }
    expect(r.ran).toEqual([]);
    expect(r.fetched).toEqual([]);
    expect(existsSync(r.out)).toBe(false);
  });

  it('a run prints the page (or the object), leaves results.md and results.json beside the clips, and says where', async () => {
    const r = rig();
    const o = io();
    expect(await main(['--out', r.out, '--voices', 'Samantha', '--rates', '175'], { env: r.deps.env, home: r.deps.home, ...o.d, bench: r.deps })).toBe(0);
    expect(o.out).toHaveLength(1);
    expect(o.out[0]).toContain('# Voice benchmark');
    expect(readFileSync(join(r.out, 'results.md'), 'utf8')).toBe(`${o.out[0]}\n`);
    const saved = JSON.parse(readFileSync(join(r.out, 'results.json'), 'utf8')) as { stt: unknown[]; tts: unknown[] };
    expect([saved.stt.length, saved.tts.length]).toEqual([4, 2]);
    expect(o.err.at(-1)).toBe(`The clips, the speech and the results are in ${r.out}.`);
    // --json: the object alone on stdout.
    const r2 = rig();
    const j = io();
    expect(await main(['--out', r2.out, '--voices', 'Samantha', '--rates', '175', '--json'], { env: r2.deps.env, home: r2.deps.home, ...j.d, bench: r2.deps })).toBe(0);
    expect((JSON.parse(j.out[0]!) as { clips: { count: number } }).clips.count).toBe(10);
  });

  // L8. The default was a folder under ~/.flint, which the nightly and the offsite backups carry: every clip of
  // every run would have gone with them. It is the user's caches now, which no backup of Flint's takes.
  it('with no folder named, everything goes under ~/Library/Caches/Flint/voice-bench, readable by this user alone, and nothing is written under ~/.flint', async () => {
    const r = rig();
    const o = io();
    const flint = join(r.deps.home, '.flint');
    const before = readdirSync(flint, { recursive: true }).map(String).sort();
    // The command's own way of making folders and files (everything else of the machine is the stand-ins').
    const { mkdir: _mkdir, writeFile: _writeFile, ...standIns } = r.deps;
    expect(await main(['--voices', 'Samantha', '--rates', '175', '--stt', 'whisper-cpp', '--tts', 'say'], { env: r.deps.env, home: r.deps.home, ...o.d, bench: standIns })).toBe(0);
    const made = join(r.deps.home, 'Library', 'Caches', 'Flint', 'voice-bench', '2026-10-13T06-00-00-000Z');
    expect(defaultOut(r.deps.home, '2026-10-13T06:00:00.000Z', join)).toBe(made);
    expect(o.err.at(-1)).toBe(`The clips, the speech and the results are in ${made}.`);
    expect(readdirSync(made).sort()).toEqual(['clips', 'results.json', 'results.md', 'speech']);
    expect(readdirSync(join(made, 'clips')).filter((f) => f.endsWith('.wav'))).toHaveLength(10);
    // The folders are this user's alone, and so is every file the command itself writes.
    for (const folder of [join(r.deps.home, 'Library', 'Caches', 'Flint'), dirname(made), made, join(made, 'clips'), join(made, 'speech')]) expect(statSync(folder).mode & 0o777, folder).toBe(0o700);
    for (const file of ['results.json', 'results.md', join('clips', 'samantha-175-01.txt')]) expect(statSync(join(made, file)).mode & 0o777, file).toBe(0o600);
    // Not one file or folder was added under ~/.flint.
    expect(readdirSync(flint, { recursive: true }).map(String).sort()).toEqual(before);
    expect(USAGE).toContain('default: a dated folder under ~/Library/Caches/Flint/voice-bench');
    expect(USAGE).not.toContain('.flint/eval');
    // What the programs it runs leave behind (the audio `say` and afconvert write) is this user's alone too: the
    // command sets its own file mask before anything else, and a program it starts keeps it.
    const entry = readFileSync(join(__dirname, '..', 'scripts', 'voice-bench.ts'), 'utf8');
    const start = entry.indexOf("if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {");
    expect(start).toBeGreaterThan(-1);
    expect(entry.slice(start).replace(/\s*\/\/[^\n]*/g, '')).toMatch(/^if \(import\.meta\.url === pathToFileURL\(process\.argv\[1\] \?\? ''\)\.href\) \{\n  process\.umask\(0o077\);/);
  });

  // The review's M32: nothing held where the transcription server it starts listens.
  it('the transcription server it starts is given this Mac alone to listen on, and is asked there', async () => {
    expect(SERVER_HOST).toBe('127.0.0.1');
    expect(serverArgs('/m/ggml-base.en.bin', 8178)).toEqual(['-m', '/m/ggml-base.en.bin', '--host', '127.0.0.1', '--port', '8178', '--inference-path', '/v1/audio/transcriptions']);
    // Started for real, with a stand-in for the program: a script that records what it was started with, and
    // listens where it was told to. (Its interpreter is this one, by its full path: the server is handed no PATH of ours.)
    const record = join(dir, 'started.json');
    const bin = join(dir, 'whisper-server');
    writeFileSync(
      bin,
      [
        `#!${process.execPath}`,
        "const http = require('node:http'); const fs = require('node:fs');",
        'const a = process.argv.slice(2); const at = (f) => a[a.indexOf(f) + 1];',
        `fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ args: a, env: Object.keys(process.env).sort() }));`,
        "http.createServer((q, s) => s.end('ok')).listen(Number(at('--port')), at('--host'));",
        '',
      ].join('\n'),
    );
    chmodSync(bin, 0o755);
    const server = await startWhisperServer(bin, '/m/ggml-base.en.bin');
    try {
      expect(server).toBeDefined();
      const port = Number(new URL(server!.baseURL).port);
      expect(server!.baseURL).toBe(`http://127.0.0.1:${port}/v1`);
      const was = JSON.parse(readFileSync(record, 'utf8')) as { args: string[]; env: string[] };
      expect(was.args).toEqual(serverArgs('/m/ggml-base.en.bin', port));
      expect(was.args[was.args.indexOf('--host') + 1]).toBe('127.0.0.1');
      // It was handed three plain variables, and nothing of this process's environment: no key, no token.
      expect(was.env.filter((k) => !k.startsWith('__'))).toEqual(['HOME', 'PATH', 'TMPDIR']);
    } finally {
      await server?.stop();
    }
  });

  it('nothing could be measured: exit 1, and the page says why', async () => {
    const r = rig({ platform: 'linux' });
    const o = io();
    expect(await main(['--out', r.out], { env: r.deps.env, home: r.deps.home, ...o.d, bench: r.deps })).toBe(1);
    expect(o.out[0]).toContain('Nothing that hears could be measured.');
  });

  it('is wired as a command of the server package', () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['voice-bench']).toBe('tsx scripts/voice-bench.ts');
  });
});
