import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { readInferenceConfig } from '../src/inference-config';
import {
  AUDIO_TYPES,
  CannotTranscribe,
  MAX_SPEECH_BYTES,
  MAX_TRANSCRIPT_BYTES,
  SAY_AT_ONCE,
  SAY_WAITING,
  SpeechBusy,
  TTS_MAX_CHARS,
  audioTypeOf,
  buildVoice,
  isFile,
  macSayTts,
  offTts,
  openAiCompatStt,
  openAiCompatTts,
  openAiSpeech,
  openAiTts,
  planVoice,
  runFile,
  sayLine,
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
/** A stand-in for the file system: the program and the model are there. (No test here runs a real program, so none needs a real file.) */
const THERE = (): boolean => true;
const headers = (init: RequestInit): Record<string, string> => init.headers as Record<string, string>;

// ---------------------------------------------------------------------------

describe('whisper.cpp, on this Mac: what Flint has always done, moved behind the seam unchanged', () => {
  it('converts the recording to the WAV whisper reads, runs whisper-cli on it, and hands back the text on one line', async () => {
    const { run, ran } = runner({ whisperSays: '\n  Hello   there,\n Flint. \n' });
    const stt = whisperCppStt({ bin: '/opt/homebrew/bin/whisper-cli', model: '/models/ggml-base.en.bin', run, exists: THERE });
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
    await whisperCppStt({ bin: '/w', model: '/m', run: ok.run, exists: THERE }).transcribe(Buffer.from('a'));
    const dir = dirname(ok.ran[0]!.args[0]!);
    expect(ok.ran[0]!.files[ok.ran[0]!.args[0]!]!.dirMode).toBe(0o700);
    expect(existsSync(dir)).toBe(false);
    const bad = runner({ fail: 'afconvert' });
    await expect(whisperCppStt({ bin: '/w', model: '/m', run: bad.run, exists: THERE }).transcribe(Buffer.from('a'))).rejects.toThrow('afconvert failed');
    expect(existsSync(dirname(bad.ran[0]!.args[0]!))).toBe(false);
  });

  it('is local, and a status may name its model by the file, never by the path', () => {
    const stt = whisperCppStt({ bin: '/w', model: '/Users/someone/.flint/models/ggml-small.en.bin' });
    expect(stt).toMatchObject({ name: 'whisper-cpp', local: true, model: 'ggml-small.en.bin' });
  });

  it('where the program and the model are: WHISPER_BIN and WHISPER_MODEL as config took them, else where they have always been', () => {
    const paths = (env: Record<string, string>) => whisperPaths(readInferenceConfig(env, undefined, { home: '/home/will' }).voice, '/home/will');
    expect(paths({})).toEqual({ bin: '/opt/homebrew/bin/whisper-cli', model: '/home/will/.flint/models/ggml-base.en.bin' });
    expect(paths({ WHISPER_BIN: ' /x/whisper-cli ', WHISPER_MODEL: '/m/ggml-small.bin' })).toEqual({ bin: '/x/whisper-cli', model: '/m/ggml-small.bin' });
    expect(paths({ WHISPER_BIN: '  ', WHISPER_MODEL: '' }).bin).toBe('/opt/homebrew/bin/whisper-cli');
  });
});

// The review's M2. The benchmark told Will to set WHISPER_MODEL=~/.flint/models/<file>. Neither the settings file
// nor a LaunchAgent expands `~`, so whisper.cpp was handed a path it could not open and EVERY recording failed.
describe('WHISPER_BIN and WHISPER_MODEL are full paths: a leading ~/ is this home folder, and anything else that is not a full path is refused', () => {
  const read = (env: Record<string, string>) => {
    const warned: string[] = [];
    const cfg = readInferenceConfig(env, (m) => warned.push(m), { home: '/Users/will' });
    return { cfg, warned, plan: planVoice(cfg, env, { platform: 'darwin', home: '/Users/will' }) };
  };

  it('~/ is the home folder, for the model and for the program, and it is no problem', () => {
    const { cfg, plan, warned } = read({ WHISPER_MODEL: '~/.flint/models/ggml-small.en.bin', WHISPER_BIN: '~/bin/whisper-cli' });
    expect(cfg.problems).toEqual([]);
    expect(warned).toEqual([]);
    expect(plan.stt).toEqual({ name: 'whisper-cpp', local: true, bin: '/Users/will/bin/whisper-cli', model: '/Users/will/.flint/models/ggml-small.en.bin' });
    expect(voiceLine(plan)).toContain('hearing=whisper-cpp (ggml-small.en.bin)');
  });

  it('whisper.cpp is never handed a path that starts with ~: what it is run with is the full path', async () => {
    const env = { WHISPER_MODEL: '~/.flint/models/ggml-small.en.bin' };
    const ran: string[][] = [];
    const { stt } = buildVoice(planVoice(readInferenceConfig(env, undefined, { home: '/Users/will' }), env, { platform: 'darwin', home: '/Users/will' }), {
      env,
      fileExists: THERE,
      run: async (file, args) => {
        ran.push([file, ...args]);
        if (file === '/usr/bin/afconvert') writeFileSync(args[1]!, 'RIFF');
        return { stdout: 'heard' };
      },
    });
    expect(await stt.transcribe(Buffer.from('a'))).toEqual({ text: 'heard' });
    expect(ran[1]!.slice(0, 3)).toEqual(['/opt/homebrew/bin/whisper-cli', '-m', '/Users/will/.flint/models/ggml-small.en.bin']);
    expect(ran.flat().filter((a) => a.startsWith('~'))).toEqual([]);
  });

  it("another user's home, a bare name and a relative path are refused with a sentence, and the usual one is used: no recording fails for it", () => {
    for (const [value, key] of [
      ['~someone/models/ggml-base.en.bin', 'WHISPER_MODEL'],
      ['~', 'WHISPER_MODEL'],
      ['models/ggml-base.en.bin', 'WHISPER_MODEL'],
      ['./ggml-base.en.bin', 'WHISPER_MODEL'],
      ['whisper-cli', 'WHISPER_BIN'],
      ['../bin/whisper-cli', 'WHISPER_BIN'],
    ] as const) {
      const { cfg, plan, warned } = read({ [key]: value });
      expect(plan.stt, value).toEqual({ name: 'whisper-cpp', local: true, bin: '/opt/homebrew/bin/whisper-cli', model: '/Users/will/.flint/models/ggml-base.en.bin' });
      expect(cfg.problems, value).toEqual([{ key, reason: 'not a full path (one that starts with / or with ~/)', kind: 'invalid' }]);
      expect(warned, value).toEqual([`[inference] ${key} is not a full path (one that starts with / or with ~/); using the usual transcription ${key === 'WHISPER_BIN' ? 'program' : 'model'}`]);
    }
  });

  // L5: these two are shown (the model's file name is in the boot line and in the status), so nothing a terminal
  // or a log acts on may be in them.
  it('a path with a newline, an escape, a direction override, or a file name too long to show is refused, and never repeated', () => {
    for (const value of ['/m/ggml-base.en.bin\n[route] {"fake":1}', '/m/ggml-\u001b[2Jbase.bin', '/m/ggml-\u202egnp.bin', '/m/a\u2028b.bin', `/m/${'x'.repeat(101)}.bin`, `/${'d/'.repeat(600)}m.bin`, '/m/models/']) {
      const { cfg, plan, warned } = read({ WHISPER_MODEL: value, WHISPER_BIN: value });
      expect(plan.stt, JSON.stringify(value)).toMatchObject({ bin: '/opt/homebrew/bin/whisper-cli', model: '/Users/will/.flint/models/ggml-base.en.bin' });
      expect(cfg.problems.map((x) => x.key).sort(), JSON.stringify(value)).toEqual(['WHISPER_BIN', 'WHISPER_MODEL']);
      const said = JSON.stringify(cfg.problems) + warned.join('\n') + voiceLine(plan);
      expect(said, JSON.stringify(value)).not.toMatch(/fake|\u001b|\u202e|\u2028|xxxxx|d\/d\/d/);
      expect(voiceLine(plan).split('\n'), JSON.stringify(value)).toHaveLength(1);
    }
    // A space, and a letter that is not ASCII, are a path like any other.
    const fine = read({ WHISPER_MODEL: '/Users/josé/Library/Application Support/models/ggml-base.en.bin' });
    expect(fine.cfg.problems).toEqual([]);
    expect(fine.plan.stt).toMatchObject({ model: '/Users/josé/Library/Application Support/models/ggml-base.en.bin' });
  });
});

// The stale line. main read WHISPER_BIN and WHISPER_MODEL before it read the settings file, so a line for one of
// them saved there was never used, and may name a file that has since gone. Read after the file, such a line
// applied, and every recording failed with a 500. A program or a model that is named and is not there when Flint
// starts is refused now, and the usual one is used: wherever the value came from.
describe('a WHISPER_BIN or WHISPER_MODEL that names a file that is not there is refused at start, and the usual one is used', () => {
  const HOME = '/Users/will';
  const USUAL = { bin: '/opt/homebrew/bin/whisper-cli', model: `${HOME}/.flint/models/ggml-base.en.bin` };
  const read = (env: Record<string, string>, there: readonly string[]) => {
    const warned: string[] = [];
    const asked: string[] = [];
    const cfg = readInferenceConfig(env, (m) => warned.push(m), { home: HOME, fileExists: (p) => (asked.push(p), there.includes(p)) });
    return { cfg, warned, asked, plan: planVoice(cfg, env, { platform: 'darwin', home: HOME }) };
  };

  it('a model that is not there: refused by the name of the setting, never by its path, and the usual model is used', () => {
    const { cfg, plan, warned } = read({ WHISPER_MODEL: '/nonexistent/old/ggml-gone.bin' }, [USUAL.bin, USUAL.model]);
    expect(plan.stt).toEqual({ name: 'whisper-cpp', local: true, ...USUAL });
    expect(cfg.problems).toEqual([{ key: 'WHISPER_MODEL', reason: 'the path of a file that is not there', kind: 'missing' }]);
    expect(warned).toEqual(['[inference] WHISPER_MODEL is the path of a file that is not there; using the usual transcription model']);
    expect(JSON.stringify(cfg.problems) + warned.join('') + voiceLine(plan)).not.toMatch(/nonexistent|ggml-gone|\/old\//);
    expect(voiceLine(plan)).toContain('hearing=whisper-cpp (ggml-base.en.bin)');
  });

  it('the program likewise; and both at once are two refusals', () => {
    const one = read({ WHISPER_BIN: '/gone/bin/whisper-cli' }, [USUAL.bin, USUAL.model]);
    expect(one.plan.stt).toMatchObject(USUAL);
    expect(one.cfg.problems).toEqual([{ key: 'WHISPER_BIN', reason: 'the path of a file that is not there', kind: 'missing' }]);
    expect(one.warned).toEqual(['[inference] WHISPER_BIN is the path of a file that is not there; using the usual transcription program']);
    const both = read({ WHISPER_BIN: '/gone/whisper-cli', WHISPER_MODEL: '/gone/ggml-small.en.bin' }, []);
    expect(both.cfg.problems.map((x) => [x.key, x.kind])).toEqual([['WHISPER_BIN', 'missing'], ['WHISPER_MODEL', 'missing']]);
    // The plan names the usual ones whether or not they are there: what is there is looked for again at each recording.
    expect(both.plan.stt).toMatchObject(USUAL);
  });

  it('one that is there is used as it is set, and it is the FULL path that is looked for: ~/ is the home folder first', () => {
    const kept = read({ WHISPER_BIN: '/x/whisper-cli', WHISPER_MODEL: '~/models/ggml-small.en.bin' }, ['/x/whisper-cli', `${HOME}/models/ggml-small.en.bin`]);
    expect(kept.cfg.problems).toEqual([]);
    expect(kept.plan.stt).toMatchObject({ bin: '/x/whisper-cli', model: `${HOME}/models/ggml-small.en.bin` });
    expect(kept.asked.sort()).toEqual(['/x/whisper-cli', `${HOME}/models/ggml-small.en.bin`].sort());
    // Written with ~ and not there under the home folder: refused as missing, and the path with ~ is never the one asked about.
    const gone = read({ WHISPER_MODEL: '~/models/ggml-small.en.bin' }, []);
    expect(gone.cfg.problems.map((x) => x.kind)).toEqual(['missing']);
    expect(gone.asked).toEqual([`${HOME}/models/ggml-small.en.bin`]);
  });

  it('nothing is looked for when nothing is set, when the value was refused for its shape, or when no file check is handed in', () => {
    expect(read({}, []).asked).toEqual([]);
    expect(read({}, []).cfg.problems).toEqual([]);
    const shape = read({ WHISPER_MODEL: 'models/ggml-base.en.bin', WHISPER_BIN: '/x/whisper\u001b-cli' }, []);
    expect(shape.asked).toEqual([]);
    expect(shape.cfg.problems.map((x) => x.kind)).toEqual(['invalid', 'invalid']);
    // readInferenceConfig by itself reads the environment and nothing else.
    expect(readInferenceConfig({ WHISPER_MODEL: '/nonexistent/old/ggml-gone.bin' }, undefined, { home: HOME }).problems).toEqual([]);
  });

  it('isFile, the check the server hands in: a file and a link to one are there; a folder, a broken link and nothing are not', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flint-isfile-'));
    try {
      writeFileSync(join(dir, 'model.bin'), 'weights');
      symlinkSync(join(dir, 'model.bin'), join(dir, 'link.bin'));
      symlinkSync(join(dir, 'nowhere.bin'), join(dir, 'broken.bin'));
      expect([isFile(join(dir, 'model.bin')), isFile(join(dir, 'link.bin'))]).toEqual([true, true]);
      expect([isFile(dir), isFile(join(dir, 'broken.bin')), isFile(join(dir, 'missing.bin')), isFile('')]).toEqual([false, false, false, false]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ...and when neither the one that was named nor the usual one is there, a recording gets a sentence saying so:
// not the 500 of a program that could not start, with a reference to a stack in the log.
describe('whisper.cpp or its model is not on this Mac: a recording is answered with a sentence, and nothing is run', () => {
  it('no program, or no model: CannotTranscribe, by a sentence that names no path; nothing is run and nothing is written', async () => {
    for (const [there, what, sentence] of [
      [['/m/ggml-base.en.bin'], 'program', 'Flint can’t turn speech into text: its transcription program isn’t on this Mac.'],
      [['/w/whisper-cli'], 'model', 'Flint can’t turn speech into text: its transcription model isn’t on this Mac.'],
      [[], 'program', 'Flint can’t turn speech into text: its transcription program isn’t on this Mac.'],
    ] as Array<[string[], string, string]>) {
      const { run, ran } = runner({ whisperSays: 'x' });
      const before = readdirSync(tmpdir()).filter((n) => n.startsWith('flint-stt-')).length;
      const stt = whisperCppStt({ bin: '/w/whisper-cli', model: '/m/ggml-base.en.bin', run, exists: (p) => there.includes(p) });
      const err = (await stt.transcribe(Buffer.from('a private recording')).catch((e: Error) => e)) as CannotTranscribe;
      expect(err).toBeInstanceOf(CannotTranscribe);
      expect([err.what, err.message]).toEqual([what, sentence]);
      expect(err.message).not.toMatch(/\/w\/|\/m\/|ggml|whisper-cli/);
      expect(ran).toEqual([]);
      expect(readdirSync(tmpdir()).filter((n) => n.startsWith('flint-stt-')).length).toBe(before);
    }
  });

  it('it is looked for at each recording: a model put there while Flint runs is used by the next one', async () => {
    const { run } = runner({ whisperSays: 'heard' });
    const there = new Set(['/w/whisper-cli']);
    const stt = whisperCppStt({ bin: '/w/whisper-cli', model: '/m/ggml-base.en.bin', run, exists: (p) => there.has(p) });
    await expect(stt.transcribe(Buffer.from('a'))).rejects.toBeInstanceOf(CannotTranscribe);
    there.add('/m/ggml-base.en.bin');
    expect(await stt.transcribe(Buffer.from('a'))).toEqual({ text: 'heard' });
    there.delete('/w/whisper-cli');
    await expect(stt.transcribe(Buffer.from('a'))).rejects.toMatchObject({ what: 'program' });
  });

  it('with no check handed in it is the real file system that is asked: a program that is not there is not run', async () => {
    const { run, ran } = runner({ whisperSays: 'x' });
    await expect(whisperCppStt({ bin: '/nonexistent/bin/whisper-cli', model: '/nonexistent/ggml.bin', run }).transcribe(Buffer.from('a'))).rejects.toBeInstanceOf(CannotTranscribe);
    expect(ran).toEqual([]);
  });

  it('buildVoice hands the check on, to the provider the plan names', async () => {
    const env = { WHISPER_BIN: '/x/whisper-cli', WHISPER_MODEL: '/x/ggml-small.en.bin' };
    const plan = planVoice(readInferenceConfig(env, undefined, { home: '/h' }), env, { platform: 'darwin', home: '/h' });
    const asked: string[] = [];
    const { stt } = buildVoice(plan, { env, run: runner().run, fileExists: (p) => (asked.push(p), false) });
    await expect(stt.transcribe(Buffer.from('a'))).rejects.toMatchObject({ what: 'program' });
    expect(asked).toEqual(['/x/whisper-cli']);
  });
});

describe("FLINT_TTS_MODEL and FLINT_TTS_VOICE are plain names: OpenAI's model and voice, in a request, a log and a status", () => {
  const read = (env: Record<string, string>) => {
    const warned: string[] = [];
    const cfg = readInferenceConfig(env, (m) => warned.push(m), { home: '/h' });
    return { cfg, warned, plan: planVoice(cfg, env, { platform: 'darwin', home: '/h' }) };
  };

  it('a name is taken as it is; unset is the usual one', () => {
    expect(openAiSpeech(read({}).cfg.voice)).toEqual({ model: 'tts-1', voice: 'onyx' });
    expect(openAiSpeech(read({ FLINT_TTS_MODEL: ' gpt-4o-mini-tts ', FLINT_TTS_VOICE: 'nova' }).cfg.voice)).toEqual({ model: 'gpt-4o-mini-tts', voice: 'nova' });
    expect(read({ FLINT_TTS_MODEL: 'tts-1-hd', FLINT_TTS_VOICE: 'nova' }).cfg.problems).toEqual([]);
  });

  it('a newline, an escape, a space or a name too long is refused by name, the usual one is used, and no line of a log or a status carries it', () => {
    for (const bad of ['tts-1\n[route] {"fake":1}', 'tts\u001b[2J', 'two words', 'x'.repeat(81), '-v', '$(id)']) {
      const { cfg, plan, warned } = read({ FLINT_TTS_MODEL: bad, FLINT_TTS_VOICE: bad, OPENAI_API_KEY: 'sk-x' });
      expect(plan.tts, JSON.stringify(bad)).toEqual({ name: 'openai', local: false, model: 'tts-1', voice: 'onyx', hasKey: true });
      expect(cfg.problems.map((x) => x.key).sort(), JSON.stringify(bad)).toEqual(['FLINT_TTS_MODEL', 'FLINT_TTS_VOICE']);
      const said = JSON.stringify(cfg.problems) + warned.join('\n') + voiceLine(plan);
      expect(said, JSON.stringify(bad)).not.toMatch(/fake|\u001b|two words|xxxxx|\$\(id\)/);
      for (const line of warned) expect(line.split('\n')).toHaveLength(1);
    }
    // Too long says so, in words that read after "is".
    expect(read({ FLINT_TTS_VOICE: 'x'.repeat(41) }).warned).toEqual(["[inference] FLINT_TTS_VOICE is too long; using OpenAI's usual voice"]);
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

  // L1. main answered `audio/mpeg` whatever OpenAI called its answer: mp3 is what was asked for.
  it('the client is told mp3 whatever OpenAI calls its answer, as it always was', async () => {
    for (const type of ['audio/wav', 'audio/ogg', 'application/octet-stream', 'text/html', '']) {
      const { f } = fetcher(() => new Response('mp3-bytes', { status: 200, headers: type ? { 'content-type': type } : {} }));
      expect(await openAiTts({ apiKey: 'k', model: 'tts-1', voice: 'onyx', fetch: f }).synthesize('Hello.'), type).toEqual({ audio: Buffer.from('mp3-bytes'), contentType: 'audio/mpeg' });
    }
  });

  // What main did, and still does: an answer with no audio in it is handed on as it is (200, no bytes). A local
  // speech server's empty answer is a failure (below): that path is new, and has nothing to stay the same as.
  it('an answer from OpenAI with no audio is handed on as it is, as it always was: not an error', async () => {
    const { f } = fetcher(() => new Response(null, { status: 200, headers: { 'content-type': 'audio/mpeg' } }));
    expect(await openAiTts({ apiKey: 'k', model: 'tts-1', voice: 'onyx', fetch: f }).synthesize('Hello.')).toEqual({ audio: Buffer.alloc(0), contentType: 'audio/mpeg' });
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

  // The review's M23: nothing held the cap. A server that never stops answering is read to the cap and dropped.
  it('an answer is read to 32 MB and no further: past that the read is dropped, and it is a failure', async () => {
    expect(MAX_SPEECH_BYTES).toBe(32 * 1024 * 1024);
    const piece = new Uint8Array(1024 * 1024);
    const endless = () => {
      let pulled = 0;
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({
        pull(c) {
          pulled++;
          c.enqueue(piece);
        },
        cancel() {
          cancelled = true;
        },
      });
      return { res: new Response(body, { status: 200, headers: { 'content-type': 'audio/mpeg' } }), seen: () => ({ pulled, cancelled }) };
    };
    const over = endless();
    await expect(make(() => over.res).tts.synthesize('Hi.')).rejects.toThrow('tts answered with too much audio');
    // It stopped at the cap (33 pieces of a megabyte, give or take what the stream had ready), and let the answer go.
    expect(over.seen().cancelled).toBe(true);
    expect(over.seen().pulled).toBeGreaterThanOrEqual(33);
    expect(over.seen().pulled).toBeLessThan(40);
    // Exactly the cap is still an answer.
    let left = 32;
    const exact = new ReadableStream<Uint8Array>({
      pull(c) {
        if (left-- > 0) c.enqueue(piece);
        else c.close();
      },
    });
    const out = await make(() => new Response(exact, { status: 200, headers: { 'content-type': 'audio/mpeg' } })).tts.synthesize('Hi.');
    expect(out!.audio.length).toBe(MAX_SPEECH_BYTES);
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
    for (const odd of ['null', '"text"', '[]', '7']) await expect(stt(() => new Response(odd, { status: 200 })).transcribe(Buffer.from('a')), odd).rejects.toThrow('stt answered without text');
  });

  // L3. A speech answer was capped and a transcript was not: `res.json()` read whatever the server sent.
  it('an answer is read to a megabyte and no further: a transcript is text, and more than that is a failure', async () => {
    expect(MAX_TRANSCRIPT_BYTES).toBe(1024 * 1024);
    const make = (f: typeof fetch) => openAiCompatStt({ baseURL: 'http://127.0.0.1:1/v1', model: 'm', fetch: f, convert: false });
    let pulled = 0;
    let cancelled = false;
    const piece = new TextEncoder().encode('word '.repeat(13_108)); // 64 KB of a transcript that never ends
    const endless = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled++;
        c.enqueue(piece);
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(make(fetcher(() => new Response(endless, { status: 200, headers: { 'content-type': 'application/json' } })).f).transcribe(Buffer.from('a'))).rejects.toThrow('stt answered with too much text');
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThan(24);
    // A long transcript under the cap is an answer like any other.
    const long = 'word '.repeat(150_000).trim();
    expect((await make(fetcher(() => Response.json({ text: long })).f).transcribe(Buffer.from('a'))).text).toBe(long);
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

// L2. Every /speak started a `say` of its own: twenty requests at once were twenty programs.
describe("the Mac's own say is held to a line: two at a time, a few waiting, and past that it says it is busy", () => {
  /** A `say` that does not finish until it is let go, and counts how many are running. */
  function held() {
    const waiting: Array<{ out: string; go: () => void; fail: (e: Error) => void; signal: AbortSignal | undefined; dir: string }> = [];
    let running = 0;
    let most = 0;
    const started: string[] = [];
    const run: Run = (file, args, opts) =>
      new Promise((resolve, reject) => {
        const out = args[args.indexOf('-o') + 1]!;
        started.push(readFileSync(args[args.indexOf('-f') + 1]!, 'utf8'));
        running++;
        most = Math.max(most, running);
        const done = (): void => void running--;
        const entry = {
          out,
          dir: dirname(out),
          signal: opts?.signal,
          go: () => {
            writeFileSync(out, 'aac');
            done();
            resolve({ stdout: '' });
          },
          fail: (e: Error) => {
            done();
            reject(e);
          },
        };
        waiting.push(entry);
        // As execFile does: a signal that fires stops the program, and the call rejects.
        opts?.signal?.addEventListener('abort', () => entry.fail(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })), { once: true });
      });
    return { run, waiting, started, seen: () => ({ running, most }) };
  }
  const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

  it('twenty at once: two run, eight wait, ten are told it is busy at once, and no more than two ever run together', async () => {
    expect([SAY_AT_ONCE, SAY_WAITING]).toEqual([2, 8]);
    const h = held();
    const tts = macSayTts({ run: h.run });
    const all = Array.from({ length: 20 }, (_, i) => tts.synthesize(`Sentence ${i}.`).then((s) => (s ? 'spoken' : 'null'), (e: Error) => e));
    await tick();
    expect(h.seen()).toEqual({ running: 2, most: 2 });
    // The ten past the line were refused already, each with the error /speak answers 429 for.
    const early = await Promise.all(all.slice(10));
    expect(early.every((e) => e instanceof SpeechBusy)).toBe(true);
    // The rest are spoken as the two in front finish, in the order they came.
    for (let done = 0; done < 10; done++) {
      while (h.waiting.length === 0) await tick();
      h.waiting.shift()!.go();
      await tick();
      expect(h.seen().running).toBeLessThanOrEqual(2);
    }
    expect(await Promise.all(all.slice(0, 10))).toEqual(Array.from({ length: 10 }, () => 'spoken'));
    expect(h.started).toEqual(Array.from({ length: 10 }, (_, i) => `Sentence ${i}.`));
    expect(h.seen()).toEqual({ running: 0, most: 2 });
    // The line is free again: the next one runs at once.
    const next = tts.synthesize('Again.');
    await tick();
    h.waiting.shift()!.go();
    expect(await next).toMatchObject({ contentType: 'audio/mp4' });
  });

  it('a say that fails gives up its place: the line does not jam', async () => {
    const h = held();
    const tts = macSayTts({ run: h.run, atOnce: 1, waiting: 1 });
    const a = tts.synthesize('One.').catch((e: Error) => e.message);
    const b = tts.synthesize('Two.');
    await tick();
    expect(h.seen().running).toBe(1);
    h.waiting.shift()!.fail(new Error('say failed'));
    expect(await a).toBe('say failed');
    await tick();
    h.waiting.shift()!.go();
    expect(await b).toMatchObject({ contentType: 'audio/mp4' });
  });

  // L9. A client that hung up left its `say` running to the end, and its files with it.
  it('a client that hangs up takes its say with it: the program is handed the signal, it is stopped, and its folder is gone', async () => {
    const h = held();
    const tts = macSayTts({ run: h.run });
    const gone = new AbortController();
    const spoken = tts.synthesize('Private words.', { signal: gone.signal }).catch((e: Error) => e);
    await tick();
    const call = h.waiting[0]!;
    expect(call.signal).toBe(gone.signal);
    expect(existsSync(call.dir)).toBe(true);
    gone.abort();
    expect(((await spoken) as Error).name).toBe('AbortError');
    expect(existsSync(call.dir)).toBe(false);
    expect(h.seen().running).toBe(0);
  });

  it('one that hangs up while it waits leaves the line: its say is never started, and its place goes to the next', async () => {
    const h = held();
    const tts = macSayTts({ run: h.run, atOnce: 1, waiting: 2 });
    const first = tts.synthesize('One.');
    const gone = new AbortController();
    const second = tts.synthesize('Two.', { signal: gone.signal }).catch((e: Error) => e);
    const third = tts.synthesize('Three.');
    await tick();
    gone.abort();
    expect(((await second) as Error).name).toBe('AbortError');
    // Its place is free: one more may wait where it stood.
    const fourth = tts.synthesize('Four.');
    h.waiting.shift()!.go();
    await first;
    await tick();
    h.waiting.shift()!.go();
    await third;
    await tick();
    h.waiting.shift()!.go();
    await fourth;
    expect(h.started).toEqual(['One.', 'Three.', 'Four.']);
    // And one that had already hung up is never started at all.
    const before = new AbortController();
    before.abort();
    await expect(tts.synthesize('Never.', { signal: before.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(h.started).not.toContain('Never.');
  });

  it('the line by itself: what it runs at once, what it lets wait, and what it refuses', async () => {
    const line = sayLine(1, 1);
    let free!: () => void;
    const one = line(() => new Promise<string>((r) => (free = () => r('one'))));
    const two = line(async () => 'two');
    await expect(line(async () => 'three')).rejects.toBeInstanceOf(SpeechBusy);
    free();
    expect(await Promise.all([one, two])).toEqual(['one', 'two']);
    expect(await line(async () => 'four')).toBe('four');
  });

  it('the real runner stops a program when its signal fires, and says so', async () => {
    const gone = new AbortController();
    const started = Date.now();
    const ran = runFile('/bin/sleep', ['30'], { signal: gone.signal, killSignal: 'SIGKILL' }).catch((e: Error) => e);
    setTimeout(() => gone.abort(), 50);
    expect(((await ran) as Error).name).toBe('AbortError');
    expect(Date.now() - started).toBeLessThan(5000);
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
    // L5: the boot line says where in words. No address is in a log.
    expect(voiceLine(p)).toBe('[voice] hearing=local server on this Mac (small.en) speaking=local server on this Mac (kokoro, af_heart)');
    expect(voiceLine(p)).not.toMatch(/127\.0\.0\.1|808[01]|8880|localhost/);
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
      ['http://speech.example:8880/v1', 'other_machine'],
      ['https://speech.example/v1', 'other_machine'],
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
    expect(refused.cfg.problems.map((x) => [x.key, x.kind])).toEqual([['FLINT_LOCAL_STT_BASE_URL', 'other_machine']]);
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
      ['FLINT_LOCAL_STT_BASE_URL', 'other_machine'],
      ['FLINT_LOCAL_TTS_BASE_URL', 'other_machine'],
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

  // L4. The sentences were the model server's: a speech URL with a password was told to use the MODEL server's key
  // setting, and a speech server on another machine was told to set a switch that does not allow one.
  it('what a refused speech address is told is its own: its own key setting, and no switch that would not help', () => {
    for (const key of ['FLINT_LOCAL_TTS_BASE_URL', 'FLINT_LOCAL_STT_BASE_URL'] as const) {
      const provider = key === 'FLINT_LOCAL_TTS_BASE_URL' ? { FLINT_TTS_PROVIDER: 'local' } : { FLINT_STT_PROVIDER: 'local' };
      const creds = plan({ ...provider, [key]: 'http://user:PASSWORDSECRET@127.0.0.1:8880/v1' });
      expect(creds.cfg.problems).toEqual([{ key, reason: 'a URL that carries credentials (use FLINT_LOCAL_VOICE_API_KEY)', kind: 'has_credentials' }]);
      expect(creds.warned.join('\n')).not.toMatch(/FLINT_LOCAL_API_KEY|PASSWORDSECRET|user:/);
      for (const env of [{}, { FLINT_LOCAL_ALLOW_REMOTE: '1' }, { FLINT_LOCAL_ALLOW_REMOTE: '1', FLINT_LOCAL_ALLOW_INSECURE_REMOTE: '1' }]) {
        for (const url of ['https://speech.example/v1', 'http://10.0.0.5:8880/v1', 'http://127.0.0.2:8880/v1', 'http://[::ffff:127.0.0.1]:8880/v1', 'http://0.0.0.0:8880/v1']) {
          const remote = plan({ ...provider, ...env, [key]: url });
          expect(remote.cfg.problems.filter((x) => x.key === key), url).toEqual([{ key, reason: 'on another machine (a speech server runs on this Mac)', kind: 'other_machine' }]);
          expect(remote.warned.join('\n'), url).not.toMatch(/FLINT_LOCAL_ALLOW_REMOTE|FLINT_LOCAL_ALLOW_INSECURE_REMOTE|speech\.example|10\.0\.0\.5/);
        }
      }
    }
  });

  it('every refusal reads as a sentence after "is", and a name that is too long is told so', () => {
    const { warned, cfg } = plan({
      FLINT_TTS_PROVIDER: 'say',
      FLINT_SAY_VOICE: 'A'.repeat(41),
      FLINT_LOCAL_TTS_VOICE: 'v'.repeat(81),
      FLINT_LOCAL_TTS_MODEL: 'two words',
      FLINT_LOCAL_VOICE_API_KEY: 'has space',
    });
    expect(warned.sort()).toEqual([
      '[inference] FLINT_LOCAL_TTS_MODEL is written with characters that are not allowed; using tts-1',
      '[inference] FLINT_LOCAL_TTS_VOICE is too long; using alloy',
      '[inference] FLINT_LOCAL_VOICE_API_KEY is written with characters that are not allowed; no key is sent',
      "[inference] FLINT_SAY_VOICE is too long; using the Mac's own default voice",
    ]);
    for (const line of warned) expect(line).not.toMatch(/ is (has|is|are) /);
    expect(cfg.voice.sayVoice).toBeUndefined();
    // A voice of forty letters is one; so is the longest name the Mac gives.
    expect(plan({ FLINT_TTS_PROVIDER: 'say', FLINT_SAY_VOICE: 'A'.repeat(40) }).cfg.problems).toEqual([]);
    expect(plan({ FLINT_TTS_PROVIDER: 'say', FLINT_SAY_VOICE: 'Eddy (English (US))' }).plan.tts).toEqual({ name: 'say', local: true, voice: 'Eddy (English (US))' });
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

  // The review's M14 and M15. Nothing held which key goes where: the speech server's key could have gone to OpenAI,
  // and OpenAI's key to the speech server, with every test green.
  it('with both keys set, each goes to its own service and to no other', async () => {
    const both = { OPENAI_API_KEY: 'sk-OPENAI-KEY', FLINT_LOCAL_VOICE_API_KEY: 'voice-KEY' };
    const local = { FLINT_TTS_PROVIDER: 'local', FLINT_LOCAL_TTS_BASE_URL: 'http://127.0.0.1:8880/v1', FLINT_STT_PROVIDER: 'local', FLINT_LOCAL_STT_BASE_URL: 'http://127.0.0.1:8081/v1' };
    const where = (sent: Sent[]) => sent.map((s) => [new URL(s.url).host, headers(s.init).authorization]);
    // The local speech server, speaking and hearing: its own key, never OpenAI's.
    const a = fetcher((url) => (url.endsWith('/transcriptions') ? Response.json({ text: 'ok' }) : audio('x')));
    // (afconvert's part is played here: no program is run.)
    const run: Run = async (_file, args) => {
      writeFileSync(args[1]!, 'RIFF');
      return { stdout: '' };
    };
    const here = buildVoice(planVoice(readInferenceConfig({ ...both, ...local }), { ...both, ...local }, { platform: 'darwin', home: '/h' }), { env: { ...both, ...local }, fetch: a.f, run, connect: async () => {} });
    await here.tts.synthesize('Hello.');
    await here.stt.transcribe(Buffer.from('a'));
    expect(where(a.sent)).toEqual([
      ['127.0.0.1:8880', 'Bearer voice-KEY'],
      ['127.0.0.1:8081', 'Bearer voice-KEY'],
    ]);
    // ...and with no key of its own it is sent none: OpenAI's is not lent to it.
    const b = fetcher((url) => (url.endsWith('/transcriptions') ? Response.json({ text: 'ok' }) : audio('x')));
    const keyless = { OPENAI_API_KEY: 'sk-OPENAI-KEY', ...local };
    const bare = buildVoice(planVoice(readInferenceConfig(keyless), keyless, { platform: 'darwin', home: '/h' }), { env: keyless, fetch: b.f, run, connect: async () => {} });
    await bare.tts.synthesize('Hello.');
    await bare.stt.transcribe(Buffer.from('a'));
    expect(where(b.sent)).toEqual([
      ['127.0.0.1:8880', undefined],
      ['127.0.0.1:8081', undefined],
    ]);
    expect(JSON.stringify(b.sent.map((s) => s.init.headers))).not.toContain('OPENAI');
    // OpenAI: its own key, never the speech server's, whatever else is set.
    const c = fetcher(() => audio('x'));
    const out = buildVoice(planVoice(readInferenceConfig({ ...both, FLINT_LOCAL_TTS_BASE_URL: 'http://127.0.0.1:8880/v1' }), both, { platform: 'darwin', home: '/h' }), { env: both, fetch: c.f });
    await out.tts.synthesize('Hello.');
    expect(where(c.sent)).toEqual([['api.openai.com', 'Bearer sk-OPENAI-KEY']]);
    // With the speech server's key and none of its own, OpenAI is not asked at all.
    const d = fetcher(() => audio('x'));
    const none = { FLINT_LOCAL_VOICE_API_KEY: 'voice-KEY' };
    expect(await buildVoice(planVoice(readInferenceConfig(none), none, { platform: 'darwin', home: '/h' }), { env: none, fetch: d.f }).tts.synthesize('Hello.')).toBeNull();
    expect(d.sent).toEqual([]);
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
