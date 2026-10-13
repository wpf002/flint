import { describe, it, expect } from 'vitest';
import { EMBEDDING_MODEL, HARDWARE_TIERS, hardwareTier, hardwareTierFor, type HardwareTier } from '@flint/core';
import type { Hardware } from '../src/hardware';
import { MODES, readInferenceConfig, type ConfigKey, type ConfigProblem, type InferenceMode, type UrlProblem } from '../src/inference-config';
import type { ModeSource } from '../src/inference-mode';
import { INVALID_SAVED_SENTENCE, MODE_SENTENCES, RELOADS_SENTENCE, addressSentence, hardwareLine, hardwareName, hardwareSentence, inferenceStatus, localOnlySentence, modeSentence, noCloudSentence, problemSentence, speechRow, staysOn, transcriptionRow, voiceLines, whisperName, type StatusInput } from '../src/inference-status';
import { planVoice } from '../src/voice';
import type { LocalBrains, NotConfined } from '../src/local-brains';
import type { ModelHealth, LocalSnapshot } from '../src/local-monitor';

/**
 * The status, as its two readers get it: sentences by tag and key for the
 * command line (`lines`), and names, sentences and notices for the console,
 * which shows no tag, no key and no path.
 */

const MAIN = hardwareTier('48gb').model;
const SMALL = hardwareTier('48gb').fallbackModel!;
const MAC: Hardware = { platform: 'darwin', arch: 'arm64', accelerator: 'apple-silicon', memoryGb: 64, systemMemoryGb: 64, chip: 'Apple M5 Max', notes: [] };

const health = (model: string, over: Partial<ModelHealth> = {}): ModelHealth => ({ model, state: 'loaded', since: 1, checkedAt: 1, ...over });

interface Shape {
  mode?: InferenceMode;
  modeSource?: ModeSource;
  env?: Record<string, string>;
  hardware?: Hardware | null;
  tier?: HardwareTier;
  tierSource?: 'detected' | 'override';
  model?: string;
  settled?: boolean;
  primary?: Partial<ModelHealth>;
  standby?: Partial<ModelHealth> | null;
  server?: LocalBrains['server'];
  wire?: LocalBrains['wire'];
  backend?: boolean;
  notConfined?: NotConfined;
  embedding?: StatusInput['embedding'] | null;
  /** The model server's address, when it is not this Mac's default. */
  endpoint?: { host: string; loopback: boolean };
}

/** The parts main() would hand over. Nothing is built or asked. */
function input(o: Shape = {}): StatusInput {
  const cfg = readInferenceConfig(o.env ?? {});
  const model = o.model ?? MAIN;
  const hardware = o.hardware === null ? undefined : o.hardware ?? MAC;
  const local = {
    cfg,
    wire: o.wire ?? 'ollama',
    server: o.server ?? 'ollama',
    endpoint: o.endpoint ?? { host: '127.0.0.1:11434', loopback: true },
    primary: { model, settled: o.settled ?? true, from: 'tier', numCtx: 16384, provider: { getCapabilities: () => ({ maxContextTokens: 16384, toolCalling: 'native' }) } },
    ...(o.standby === null ? {} : { fallback: { model: SMALL, settled: true } }),
    backend: o.backend === false ? undefined : {},
    confined: o.notConfined ? { ok: false, why: o.notConfined } : { ok: true },
  } as unknown as LocalBrains;
  const snapshot: LocalSnapshot = {
    server: 'ollama',
    reachable: true,
    primary: health(model, o.primary),
    ...(o.standby === null ? {} : { fallback: health(SMALL, o.standby ?? {}) }),
  };
  return {
    mode: o.mode ?? 'hybrid',
    modeSource: o.modeSource ?? 'settings',
    ...(hardware ? { hardware, tier: o.tier ?? hardwareTierFor(hardware) } : {}),
    tierSource: o.tierSource ?? 'detected',
    local,
    snapshot,
    ...(o.embedding === null ? {} : { embedding: o.embedding ?? { model: EMBEDDING_MODEL.model, installed: true } }),
    // What hears and what speaks, decided from the same environment (./voice). No program runs and no file is read.
    voice: planVoice(cfg, o.env ?? {}, { platform: 'darwin', home: '/home/will' }),
  };
}

/** A status from those parts: the function is pure. */
function status(o: Shape = {}) {
  return inferenceStatus(input(o));
}

/** Everything of a status that the console puts on screen. */
const onScreen = (st: ReturnType<typeof status>): string[] =>
  [
    st.modeSentence,
    st.hardware?.name,
    st.hardware?.sentence,
    st.local.primary.name,
    st.local.primary.sentence,
    st.local.standby?.name,
    st.local.standby?.sentence,
    st.local.embedding?.name,
    st.local.embedding?.sentence,
    st.voice?.speech.name,
    st.voice?.speech.sentence,
    st.voice?.transcription.name,
    st.voice?.transcription.sentence,
    ...st.notices,
  ].filter((x): x is string => typeof x === 'string');

const KEY_SHAPED = /\b(FLINT|OLLAMA)_[A-Z_]+\b/;
const TAG_SHAPED = /[a-z][a-z0-9._-]*:\d+(\.\d+)?[bm]\b/i;

describe('the console is given names and sentences: no tag, no key, no path, no address', () => {
  it('a model is shown by its display name; the tag stays in `model`, for the command line and the download command', () => {
    const st = status({ primary: { state: 'unavailable', why: 'not_installed' }, standby: { state: 'unavailable', why: 'not_installed' } });
    expect(st.local.primary).toMatchObject({ model: MAIN, name: 'Muse Glimmer 30B', pull: `ollama pull ${MAIN}`, downloadGb: 18.2 });
    expect(st.local.standby).toMatchObject({ model: SMALL, name: 'Llama 3.2 3B', pull: `ollama pull ${SMALL}`, downloadGb: 2 });
    expect(st.hardware?.recommended).toEqual({ model: MAIN, name: 'Muse Glimmer 30B', contextLength: 16384, fallbackModel: SMALL, fallbackName: 'Llama 3.2 3B' });
    for (const text of onScreen(st)) {
      expect(text, text).not.toMatch(TAG_SHAPED);
      expect(text, text).not.toMatch(KEY_SHAPED);
    }
  });

  it('a model the table does not list gets a readable name made from its tag, never the raw tag', () => {
    const st = status({ model: 'qwen3.6:35b' });
    expect(st.local.primary).toMatchObject({ model: 'qwen3.6:35b', name: 'Qwen 3.6 35B' });
    expect(onScreen(st).join(' ')).not.toContain('qwen3.6:35b');
    expect(status({ model: 'hf.co/someone/odd_repo:Q4_K_M' }).local.primary.name).toBe('Odd Repo Q4-K-M');
  });

  it('every state, mode and refusal: what is on screen is complete sentences, with no key, tag or path in them', () => {
    const states: Array<Partial<ModelHealth>> = [
      { state: 'loaded' },
      { state: 'cold' },
      { state: 'loading' },
      { state: 'unavailable', why: 'not_installed' },
      { state: 'unavailable', why: 'unreachable' },
      { state: 'unavailable', why: 'unreachable', checkedAt: 0 },
      { state: 'unavailable', why: 'error' },
      { state: 'unavailable', why: 'config' },
    ];
    const env = {
      FLINT_LOCAL_TOOLS: 'nonsense',
      FLINT_LOCAL_MODEL: 'glm-5:cloud',
      FLINT_LOCAL_REQUEST_TIMEOUT_MS: 'soon',
      OLLAMA_HOST: 'ftp://x',
      FLINT_INFERENCE_MODE: 'turbo',
      // Voice, refused every way: a provider Flint does not know, a server on another machine, a voice that is not one.
      FLINT_TTS_PROVIDER: 'local',
      FLINT_LOCAL_TTS_BASE_URL: 'http://speech.example:8880/v1',
      FLINT_STT_PROVIDER: 'cloud',
      FLINT_SAY_VOICE: '-o /tmp/x',
      WHISPER_MODEL: '/Users/someone/models/ggml-large-v3-turbo-q5_0.bin',
    };
    let seen = 0;
    for (const mode of MODES) {
      for (const primary of states) {
        for (const standby of [...states, null]) {
          for (const notConfined of [undefined, 'remote_host', 'cloud_model', 'config'] as const) {
            const st = status({ mode, primary, standby, env, ...(notConfined ? { notConfined } : {}) });
            for (const text of onScreen(st)) {
              seen += 1;
              expect(text, text).not.toMatch(KEY_SHAPED);
              expect(text, text).not.toMatch(TAG_SHAPED);
              expect(text, text).not.toMatch(/[/\\~]|https?:|\d+\.\d+\.\d+\.\d+|\(|\)|\{|\}|_/);
            }
            for (const text of [st.modeSentence, st.hardware!.sentence, st.local.primary.sentence, st.local.standby?.sentence, st.local.embedding!.sentence, st.voice!.speech.sentence, st.voice!.transcription.sentence, ...st.notices]) {
              if (text !== undefined) expect(text, text).toMatch(/^[A-Z][^\n]*\.$/);
            }
          }
        }
      }
    }
    expect(seen).toBeGreaterThan(5000);
  });
});

describe('what each mode promises, in the words on screen', () => {
  // The final review's M2: Local mode said "no outside service", and a Local-mode turn searched the web and asked Google.
  it('Local mode promises who answers, and says that the web may still be searched', () => {
    expect(MODE_SENTENCES).toEqual({
      local: 'Every answer comes from this Mac. Flint may still search the web.',
      hybrid: 'Flint picks this Mac or the cloud for each message.',
      cloud: 'Cloud models answer, and private messages stay on this Mac.',
    });
    for (const mode of MODES) {
      const st = status({ mode });
      expect(st.modeSentence).toBe(MODE_SENTENCES[mode]);
      expect(st.lines[0]).toBe(`Flint is in ${mode[0]!.toUpperCase()}${mode.slice(1)} mode. ${MODE_SENTENCES[mode]}`);
      expect(st.modeSentence).not.toMatch(/outside service/);
    }
  });

  // L11: with FLINT_LOCAL_ALLOW_REMOTE=1 and the model on that server, "this Mac" alone was not true.
  it('with the local model on a server Will allowed, no sentence says "this Mac" alone', () => {
    const remote = { host: 'gpu-box.lan:11434', loopback: false };
    expect(staysOn(true)).toBe('this Mac or the model server you allowed');
    expect(status({ mode: 'local', endpoint: remote }).modeSentence).toBe('Every answer stays on this Mac or the model server you allowed. Flint may still search the web.');
    expect(status({ mode: 'hybrid', endpoint: remote }).modeSentence).toBe('Flint picks the model server you allowed or the cloud for each message.');
    expect(status({ mode: 'cloud', endpoint: remote }).modeSentence).toBe('Cloud models answer, and private messages stay on this Mac or the model server you allowed.');
    for (const mode of MODES) {
      expect(modeSentence(mode, true)).toBe(status({ mode, endpoint: remote }).modeSentence);
      expect(status({ mode, endpoint: remote }).lines[0]).toContain(modeSentence(mode, true));
      expect(modeSentence(mode, true).replace('this Mac or the model server you allowed', '')).not.toContain('this Mac');
    }
    // A server elsewhere that Will has NOT allowed is not used for a turn that stays here, so nothing changes.
    for (const mode of MODES) expect(status({ mode, endpoint: remote, notConfined: 'remote_host' }).modeSentence).toBe(MODE_SENTENCES[mode]);
  });
});

describe('the Local Model row: what is true for the mode Flint is in', () => {
  const say = (mode: InferenceMode, primary: Partial<ModelHealth>, more: Shape = {}): string => status({ mode, primary, ...more }).local.primary.sentence;

  it('ready, loading, not downloaded, and a server that is not answering', () => {
    for (const mode of MODES) {
      expect(say(mode, { state: 'loaded' })).toBe('It is ready.');
      expect(say(mode, { state: 'loading' })).toBe('It is loading now.');
      expect(say(mode, { state: 'unavailable', why: 'not_installed' })).toBe("It isn't downloaded yet.");
      expect(say(mode, { state: 'unavailable', why: 'unreachable' })).toBe("The local model server isn't answering.");
    }
  });

  it('"not loaded" says what will load it, and that is the mode\'s: only a private message in Cloud mode', () => {
    expect(say('local', { state: 'cold' })).toBe('It is not loaded. It loads when a message needs it.');
    expect(say('hybrid', { state: 'cold' })).toBe('It is not loaded. It loads when a message needs it.');
    expect(say('cloud', { state: 'cold' })).toBe('It is not loaded. It loads when a private message needs it.');
  });

  it('before the first look, it says Flint is checking, as a sentence', () => {
    const st = status({ primary: { state: 'unavailable', why: 'unreachable', checkedAt: 0 } });
    expect(st.local.primary).toMatchObject({ state: 'checking', sentence: 'Flint is checking.' });
    expect(st.local.primary.why).toBeUndefined();
  });

  it('no model chosen yet: no name is shown, and a placeholder is never printed as one', () => {
    for (const placeholder of ['none', 'default', 'unset', '']) {
      for (const settled of [false, true]) {
        const st = status({ model: placeholder, settled, primary: { state: 'unavailable', why: 'unsettled' } });
        expect(st.local.model, placeholder).toBeUndefined();
        expect(st.local.primary.model, placeholder).toBeUndefined();
        expect(st.local.primary.name, placeholder).toBeUndefined();
        expect(st.local.primary.pull, placeholder).toBeUndefined();
        expect(st.local.primary.sentence).toBe("No local model is chosen yet, because the local model server isn't answering.");
        expect(st.lines).toContain("No local model is chosen yet, because the local model server hasn't said what it has.");
        expect(st.lines.join('\n')).not.toMatch(/The local model is (none|default|unset)\b/);
        expect(JSON.stringify(st)).not.toContain(`ollama pull ${placeholder || 'none'}`);
      }
    }
  });

  it('a model that cannot be used from here says why, and is not offered as a download', () => {
    const remote = status({ notConfined: 'remote_host', primary: { state: 'unavailable', why: 'not_installed' }, standby: { state: 'unavailable', why: 'not_installed' } });
    expect(remote.local.primary.sentence).toBe('The local model server is on another machine, so Local and Hybrid modes will not use it.');
    expect(remote.local.primary.pull).toBeUndefined();
    expect(remote.local.standby?.pull).toBeUndefined();
    expect(status({ notConfined: 'cloud_model' }).local.primary.sentence).toBe("The local model is an Ollama cloud model, which runs on Ollama's servers, so Local and Hybrid modes will not use it.");
    // The row says it once; the notices do not say it again.
    expect(remote.notices).toEqual([]);
    expect(remote.local.warnings).toEqual(['The local model server is on another machine, so Local and Hybrid modes will not use it.']);
  });
});

describe('the Standby Model row', () => {
  const say = (mode: InferenceMode, standby: Partial<ModelHealth>): string => status({ mode, standby }).local.standby!.sentence;

  it('"It answers while the main model loads." only in the modes that ask it', () => {
    expect(say('local', { state: 'loaded' })).toBe('It answers while the main model loads.');
    expect(say('hybrid', { state: 'loaded' })).toBe('It answers while the main model loads.');
    expect(say('cloud', { state: 'loaded' })).toBe("Cloud mode doesn't use it.");
    expect(say('cloud', { state: 'cold' })).toBe("Cloud mode doesn't use it.");
  });

  it('not loaded, loading, and not downloaded', () => {
    expect(say('hybrid', { state: 'cold' })).toBe('It is not loaded. It loads when the main model is not ready.');
    expect(say('local', { state: 'loading' })).toBe('It is loading now.');
    expect(say('local', { state: 'unavailable', why: 'not_installed' })).toBe("It isn't downloaded, so nothing answers while the main model loads.");
    expect(say('cloud', { state: 'unavailable', why: 'not_installed' })).toBe("It isn't downloaded, and Cloud mode doesn't use it.");
    expect(say('hybrid', { state: 'unavailable', why: 'unreachable' })).toBe("The local model server isn't answering.");
  });

  it('none configured: no row', () => {
    const st = status({ standby: null });
    expect(st.local.standby).toBeUndefined();
    expect(st.lines).toContain('No standby model is set.');
  });
});

describe('the address of the model server: each class of refusal has its own true sentence', () => {
  const cases: Array<[string, UrlProblem, string]> = [
    ['nonsense', 'not_a_url', "The local model server's address isn't a web address, so the local model is off."],
    ['ftp://127.0.0.1:11434', 'not_http', "The local model server's address doesn't start with http or https, so the local model is off."],
    ['http://will:pw@127.0.0.1:11434', 'has_credentials', "The local model server's address has a name or a password in it, so the local model is off."],
    ['http://127.0.0.1:11434/?x=1', 'has_query', "The local model server's address has a question mark or a hash in it, so the local model is off."],
    ['http://127.0.0.1:11434/a/b/c/d', 'bad_path', "The local model server's address has a path Flint doesn't accept, so the local model is off."],
    ['http://gpu-box.example:8080/v1', 'not_loopback', "The local model server's address is on another machine, which Flint doesn't allow unless it is told to, so the local model is off."],
  ];

  it('on the wire in use, the Local Model row says it, and it is not repeated as a notice', () => {
    for (const [url, kind, sentence] of cases) {
      const st = status({ wire: 'openai', backend: false, settled: false, model: 'none', notConfined: 'config', env: { FLINT_LOCAL_PROVIDER: 'openai', FLINT_LOCAL_BASE_URL: url }, primary: { state: 'unavailable', why: 'config' } });
      expect(st.problems, url).toEqual([expect.objectContaining({ key: 'FLINT_LOCAL_BASE_URL', kind })]);
      expect(st.local.primary.sentence, url).toBe(sentence);
      expect(st.notices, url).toEqual([]);
      expect(st.local.warnings, url).toEqual([sentence]);
      expect(addressSentence(kind)).toBe(sentence);
      // The command line names the key and the reason.
      expect(st.lines.some((l) => l.startsWith('A setting was refused: FLINT_LOCAL_BASE_URL is ')), url).toBe(true);
      expect(st.lines.join('\n')).not.toContain('will:pw');
    }
  });

  it('plain http to another machine, even when a server elsewhere is allowed', () => {
    const st = status({
      wire: 'openai',
      backend: false,
      settled: false,
      notConfined: 'config',
      env: { FLINT_LOCAL_PROVIDER: 'openai', FLINT_LOCAL_BASE_URL: 'http://gpu-box.example:8080/v1', FLINT_LOCAL_ALLOW_REMOTE: '1' },
      primary: { state: 'unavailable', why: 'config' },
    });
    expect(st.problems).toEqual([expect.objectContaining({ key: 'FLINT_LOCAL_BASE_URL', kind: 'insecure_remote' })]);
    expect(st.local.primary.sentence).toBe("The local model server's address is on another machine and isn't encrypted, so the local model is off.");
  });

  it("a refused address of the server Flint is NOT using is a notice that says so, and the model's row is left alone", () => {
    const st = status({ env: { FLINT_LOCAL_BASE_URL: 'nonsense' } });
    expect(st.local.primary.sentence).toBe('It is ready.');
    expect(st.notices).toEqual(["The address of a second local server isn't a web address. Flint isn't using that server."]);
  });

  it('an address refused for a reason the status does not know still gets a true sentence', () => {
    expect(addressSentence(undefined)).toBe("The local model server's address was refused, so the local model is off.");
  });
});

describe('refused settings and an unreadable mode are notices, each a plain sentence', () => {
  const problem = (key: ConfigKey, kind: ConfigProblem['kind'] = 'invalid'): ConfigProblem => ({ key, reason: 'x', kind });
  const say = (key: ConfigKey, kind: ConfigProblem['kind'] = 'invalid', modeSource: ModeSource = 'default'): string => problemSentence(problem(key, kind), { inUse: true, modeSource });

  it('a mode in the environment that Flint does not know', () => {
    expect(say('FLINT_INFERENCE_MODE', 'invalid', 'invalid_env')).toBe("The mode Flint was started with isn't one it knows, so Flint is in Local mode, which never uses the cloud.");
    // With a mode saved from here in force, the bad value changes nothing, and the notice says so.
    expect(say('FLINT_INFERENCE_MODE', 'invalid', 'settings')).toBe("The mode Flint was started with isn't one it knows. The mode chosen here is in use.");
    const st = status({ mode: 'local', modeSource: 'invalid_env', env: { FLINT_INFERENCE_MODE: 'turbo' } });
    expect(st.notices).toEqual(["The mode Flint was started with isn't one it knows, so Flint is in Local mode, which never uses the cloud."]);
    expect(st.lines[1]).toBe('FLINT_INFERENCE_MODE is not a mode Flint knows, so it is running as Local, which never uses the cloud.');
    expect(st.lines).toContain('A setting was refused: FLINT_INFERENCE_MODE is not one of local, cloud, hybrid.');
  });

  it('a saved mode that cannot be read: first, with what to do', () => {
    const st = status({ mode: 'local', modeSource: 'invalid_saved', env: { FLINT_LOCAL_TOOLS: 'nonsense' } });
    expect(st.notices).toEqual([INVALID_SAVED_SENTENCE, "The tools setting in Flint's setup isn't valid, so the local model is offered no tools."]);
    expect(INVALID_SAVED_SENTENCE).toBe("The saved mode couldn't be read, so Flint is in Local mode, which never uses the cloud. Choose a mode to save it again.");
    expect(st.lines[1]).toBe(INVALID_SAVED_SENTENCE);
  });

  it('every key Flint reads has a sentence of its own class, and none of them names a key', () => {
    const keys = Object.keys({
      FLINT_INFERENCE_MODE: 1,
      FLINT_LOCAL_PROVIDER: 1,
      FLINT_LOCAL_ALLOW_REMOTE: 1,
      FLINT_LOCAL_ALLOW_INSECURE_REMOTE: 1,
      FLINT_LOCAL_API_KEY: 1,
      FLINT_LOCAL_SERVER: 1,
      FLINT_LOCAL_MODEL: 1,
      FLINT_LOCAL_FALLBACK_MODEL: 1,
      FLINT_LOCAL_TOOLS: 1,
      FLINT_LOCAL_CONNECT_TIMEOUT_MS: 1,
      FLINT_LOCAL_FIRST_OUTPUT_TIMEOUT_MS: 1,
      FLINT_LOCAL_TOOL_PASS_TIMEOUT_MS: 1,
      FLINT_LOCAL_REQUEST_TIMEOUT_MS: 1,
      FLINT_LOCAL_IDLE_TIMEOUT_MS: 1,
      FLINT_LOCAL_HEALTH_INTERVAL_MS: 1,
      FLINT_HARDWARE_TIER: 1,
      OLLAMA_MODEL: 1,
      OLLAMA_NUM_CTX: 1,
      FLINT_LOCAL_FALLBACK_NUM_CTX: 1,
      FLINT_EMBED_MODEL: 1,
      FLINT_LOCAL_BASE_URL: 1,
      OLLAMA_HOST: 1,
      FLINT_STT_PROVIDER: 1,
      FLINT_TTS_PROVIDER: 1,
      FLINT_LOCAL_STT_BASE_URL: 1,
      FLINT_LOCAL_TTS_BASE_URL: 1,
      FLINT_LOCAL_STT_MODEL: 1,
      FLINT_LOCAL_TTS_MODEL: 1,
      FLINT_LOCAL_TTS_VOICE: 1,
      FLINT_LOCAL_VOICE_API_KEY: 1,
      FLINT_SAY_VOICE: 1,
    } satisfies Record<ConfigKey, 1>) as ConfigKey[];
    const generic = "A setting in Flint's setup isn't valid, so Flint ignored it.";
    for (const key of keys) {
      const s = say(key);
      expect(s, key).toMatch(/^[A-Z].*\.$/);
      expect(s, key).not.toMatch(KEY_SHAPED);
      expect(s, key).not.toBe(generic);
    }
    // One sentence per class, not one per key: the six timing keys share theirs.
    expect(new Set(keys.map((k) => say(k))).size).toBe(21);
    expect(say('FLINT_LOCAL_TOOLS')).toBe("The tools setting in Flint's setup isn't valid, so the local model is offered no tools.");
    expect(say('FLINT_HARDWARE_TIER')).toBe("The model size named in Flint's setup isn't one it knows, so Flint checks this machine instead.");
  });

  it('a model named in the setup: not a model name, or one that runs on Ollama\'s servers', () => {
    expect(say('FLINT_LOCAL_MODEL')).toBe("The local model named in Flint's setup isn't a valid model name, so Flint ignored it.");
    expect(say('OLLAMA_MODEL', 'cloud_model')).toBe("The local model named in Flint's setup runs on Ollama's servers, so Flint ignored it.");
    expect(say('FLINT_LOCAL_FALLBACK_MODEL', 'cloud_model')).toBe("The standby model named in Flint's setup runs on Ollama's servers, so Flint ignored it.");
    expect(say('FLINT_EMBED_MODEL', 'cloud_model')).toBe("The embedding model named in Flint's setup runs on Ollama's servers, so Flint uses its usual one.");
    expect(say('FLINT_EMBED_MODEL')).toBe("The embedding model named in Flint's setup isn't a valid model name, so Flint uses its usual one.");
    expect(status({ env: { FLINT_EMBED_MODEL: 'embed-big:cloud' } }).notices).toEqual(["The embedding model named in Flint's setup runs on Ollama's servers, so Flint uses its usual one."]);
  });

  it('a key that would have travelled in the clear', () => {
    expect(say('FLINT_LOCAL_API_KEY', 'in_the_clear')).toBe("The local model server's key isn't sent, because the server's address isn't encrypted.");
    expect(say('FLINT_LOCAL_API_KEY')).toBe("The local model server's key isn't valid, so no key is sent.");
  });

  it('several timing settings are one notice, and a value is never in any of it', () => {
    const st = status({ env: { FLINT_LOCAL_REQUEST_TIMEOUT_MS: 'SECRETVALUE', FLINT_LOCAL_IDLE_TIMEOUT_MS: 'SECRETVALUE', FLINT_LOCAL_MODEL: 'SECRET VALUE; rm' } });
    expect(st.notices).toEqual(["The local model named in Flint's setup isn't a valid model name, so Flint ignored it.", "A timing setting in Flint's setup isn't valid, so Flint uses its usual value."]);
    expect(JSON.stringify(st)).not.toContain('SECRET');
  });

  // The final review's C4b. The monitor reports a model that is in memory at another context as `cold` (the next
  // local answer loads it again), so the row said "It is not loaded." directly above a notice that said it was in
  // memory; and the notice read "a 8,192-token context". (The old test here used a state the monitor never gives.)
  it('a model in memory at another context: the row and the notice say the same thing, and no number gets a wrong article', () => {
    const st = status({ primary: { state: 'cold', contextLength: 32768, contextMismatch: true } });
    expect(st.local.primary.sentence).toBe(RELOADS_SENTENCE);
    expect(RELOADS_SENTENCE).toBe('It reloads on the next local answer.');
    expect(st.notices).toEqual(['The local model is in memory with a context of 32,768 tokens, and Flint asks for 16,384.']);
    for (const mode of MODES) expect(status({ mode, primary: { state: 'cold', contextLength: 8192, contextMismatch: true } }).local.primary.sentence, mode).toBe(RELOADS_SENTENCE);
    for (const n of [8192, 11000, 18000, 80000, 4096]) {
      const notice = status({ primary: { state: 'cold', contextLength: n, contextMismatch: true } }).notices[0]!;
      expect(notice).toContain(`a context of ${n.toLocaleString('en-US')} tokens`);
      expect(notice).not.toMatch(/\ban? \d/);
    }
    // A cold model with no mismatch says what it always said.
    expect(status({ mode: 'hybrid', primary: { state: 'cold' } }).local.primary.sentence).toBe('It is not loaded. It loads when a message needs it.');
  });

  // C4d: both notices were shown together, and the second was false then.
  it('an unreadable saved mode and a bad mode in the environment: one sentence, the true one', () => {
    const st = status({ mode: 'local', modeSource: 'invalid_saved', env: { FLINT_INFERENCE_MODE: 'turbo' } });
    expect(st.notices).toEqual([INVALID_SAVED_SENTENCE]);
    expect(st.notices.join(' ')).not.toContain('The mode chosen here is in use.');
    // With a mode saved from Settings in force, that sentence is true, and is shown.
    expect(status({ mode: 'cloud', modeSource: 'settings', env: { FLINT_INFERENCE_MODE: 'turbo' } }).notices).toEqual(["The mode Flint was started with isn't one it knows. The mode chosen here is in use."]);
    // The command line still lists the refused setting by its key.
    expect(st.lines).toContain('A setting was refused: FLINT_INFERENCE_MODE is not one of local, cloud, hybrid.');
  });

  // C4a: "Cloud models answer..." and "Flint picks this Mac or the cloud..." with no cloud model at all.
  it('Hybrid or Cloud mode with no cloud model set up: a notice says who answers', () => {
    const withCloud = (mode: InferenceMode, configured: boolean | undefined, endpoint?: { host: string; loopback: boolean }) =>
      inferenceStatus({ ...input({ mode, ...(endpoint ? { endpoint } : {}) }), ...(configured === undefined ? {} : { cloud: { configured } }) });
    for (const mode of ['hybrid', 'cloud'] as const) {
      expect(withCloud(mode, false).notices, mode).toEqual(['No cloud model is set up, so this Mac answers everything.']);
      expect(withCloud(mode, true).notices, mode).toEqual([]);
      // Read without the running server, the cloud side is not known: nothing is claimed about it.
      expect(withCloud(mode, undefined).notices, mode).toEqual([]);
    }
    // Local mode says nothing of the cloud, so there is nothing to correct.
    expect(withCloud('local', false).notices).toEqual([]);
    // With the local model on a server Will allowed, that is who answers.
    expect(withCloud('cloud', false, { host: 'gpu-box.lan:11434', loopback: false }).notices).toEqual(['No cloud model is set up, so the model server you allowed answers everything.']);
    expect(noCloudSentence(false)).toBe('No cloud model is set up, so this Mac answers everything.');
  });

  it('the Local Only row has its own sentence from the server, true for the mode and for where answers stay', () => {
    expect(status({ mode: 'local' }).localOnlySentence).toBe('Local mode keeps every answer on this Mac.');
    for (const mode of ['hybrid', 'cloud'] as const) expect(status({ mode }).localOnlySentence).toBe('Answers stay on this Mac.');
    const remote = { host: 'gpu-box.lan:11434', loopback: false };
    expect(status({ mode: 'local', endpoint: remote }).localOnlySentence).toBe('Local mode keeps every answer on this Mac or the model server you allowed.');
    expect(status({ mode: 'hybrid', endpoint: remote }).localOnlySentence).toBe('Answers stay on this Mac or the model server you allowed.');
    expect(localOnlySentence('local', false)).toBe('Local mode keeps every answer on this Mac.');
  });
});

describe('the machine', () => {
  const tierOf = (h: Hardware): HardwareTier => hardwareTierFor(h);

  it('this Mac: 64 GB, enough for the largest model (never "the 48 GB+ tier" next to 64 GB)', () => {
    expect(hardwareLine(MAC, tierOf(MAC), 'detected')).toBe('This Mac has 64 GB of memory, enough for the largest model.');
    expect(hardwareName(MAC)).toBe('Apple M5 Max');
    expect(hardwareSentence(MAC, tierOf(MAC), 'detected')).toBe("This Mac's chip is Apple M5 Max, with 64 GB of memory, of which a model can use 48 GB. That is the 48 GB+ tier.");
  });

  it('a smaller Mac: what its memory is enough for, by the name of the model', () => {
    const m16: Hardware = { ...MAC, memoryGb: 16, systemMemoryGb: 16, chip: 'Apple M2' };
    expect(tierOf(m16).id).toBe('8gb');
    expect(hardwareLine(m16, tierOf(m16), 'detected')).toBe('This Mac has 16 GB of memory, enough for Qwen 2.5 7B.');
    expect(hardwareSentence(m16, tierOf(m16), 'detected')).toBe("This Mac's chip is Apple M2, with 16 GB of memory, of which a model can use 12 GB. That is the 8 GB tier.");
    const noChip: Hardware = { ...m16, chip: undefined as unknown as string };
    delete (noChip as Partial<Hardware>).chip;
    expect(hardwareName(noChip)).toBe('Apple Silicon');
    expect(hardwareSentence(noChip, tierOf(noChip), 'detected')).toBe('This Mac has Apple Silicon with 16 GB of memory, of which a model can use 12 GB. That is the 8 GB tier.');
  });

  it('a chip whose name starts with a consonant sound gets no wrong article: there is no article', () => {
    const t4: Hardware = { platform: 'linux', arch: 'x64', accelerator: 'nvidia', memoryGb: 15, systemMemoryGb: 32, chip: 'Tesla T4', notes: [] };
    expect(tierOf(t4).id).toBe('16gb');
    expect(hardwareSentence(t4, tierOf(t4), 'detected')).toBe("This machine's graphics card is Tesla T4, with 15 GB of memory. That is the 16 GB tier.");
    expect(hardwareLine(t4, tierOf(t4), 'detected')).toBe('This machine has 15 GB of graphics memory, enough for Qwen 2.5 14B.');
    for (const h of [t4, MAC, { ...t4, chip: 'NVIDIA GeForce RTX 4090' }, { ...t4, chip: 'Quadro RTX 8000' }]) {
      expect(hardwareSentence(h, tierOf(h), 'detected')).not.toMatch(/\ban? (Tesla|NVIDIA|Apple|Quadro)/);
    }
  });

  it('CPU Only: no graphics card, models on the processor', () => {
    const cpu: Hardware = { platform: 'linux', arch: 'x64', accelerator: 'none', memoryGb: 0, systemMemoryGb: 32, notes: [] };
    expect(tierOf(cpu).id).toBe('cpu');
    expect(hardwareName(cpu)).toBe('No Graphics Card');
    expect(hardwareLine(cpu, tierOf(cpu), 'detected')).toBe('This machine has no graphics card Flint can use, so models run on its processor.');
    expect(hardwareSentence(cpu, tierOf(cpu), 'detected')).toBe('This machine has no graphics card that Flint can use, and 32 GB of memory. That is the CPU Only tier.');
    const intelMac: Hardware = { ...cpu, platform: 'darwin' };
    expect(hardwareLine(intelMac, tierOf(intelMac), 'detected')).toBe('This Mac has no graphics card Flint can use, so models run on its processor.');
  });

  it('little memory and no graphics card: the smallest model, and the sentence says why', () => {
    const tiny: Hardware = { platform: 'linux', arch: 'x64', accelerator: 'none', memoryGb: 0, systemMemoryGb: 4, notes: [] };
    expect(tierOf(tiny).id).toBe('cpu-small');
    expect(hardwareLine(tiny, tierOf(tiny), 'detected')).toBe('This machine has no graphics card Flint can use and 4 GB of memory, so it runs the smallest model.');
    const st = status({ hardware: tiny, standby: null });
    expect(st.hardware?.recommended).toEqual({ model: hardwareTier('cpu-small').model, name: 'Llama 3.2 1B', contextLength: 4096 });
  });

  // The final review's C4f: "This machine has a graphics card with 4 GB of memory, too little for a model and 4 GB
  // of memory, so it runs the smallest model."
  it('a graphics card too small for a model on a machine with little memory: one sentence that reads right', () => {
    const both: Hardware = { platform: 'linux', arch: 'x64', accelerator: 'nvidia', memoryGb: 4, systemMemoryGb: 4, chip: 'NVIDIA GeForce GTX 1650', notes: [] };
    expect(tierOf(both).id).toBe('cpu-small');
    const line = hardwareLine(both, tierOf(both), 'detected');
    expect(line).toBe('This machine has 4 GB of memory and a graphics card too small for a model, so it runs the smallest model.');
    expect(line).not.toMatch(/a model and \d|of memory.*of memory/);
    expect(status({ hardware: both, standby: null }).hardware?.sentence).toBe(line);
  });

  it('a graphics card too small for a model', () => {
    const small: Hardware = { platform: 'linux', arch: 'x64', accelerator: 'nvidia', memoryGb: 4, systemMemoryGb: 16, chip: 'NVIDIA GeForce GTX 1650', notes: [] };
    expect(tierOf(small).id).toBe('cpu');
    expect(hardwareLine(small, tierOf(small), 'detected')).toBe('This machine has a graphics card with 4 GB of memory, too little for a model, so models run on its processor.');
  });

  it('a tier set by hand', () => {
    expect(hardwareLine(MAC, hardwareTier('8gb'), 'override')).toBe('This Mac has 64 GB of memory. The model size was set by hand.');
    expect(hardwareSentence(MAC, hardwareTier('8gb'), 'override')).toBe("This Mac's chip is Apple M5 Max, with 64 GB of memory, of which a model can use 48 GB. The tier is set to 8 GB by hand.");
  });

  it('every row of the table yields a sentence for each kind of machine', () => {
    for (const tier of HARDWARE_TIERS) {
      for (const h of [MAC, { ...MAC, platform: 'linux' as const, accelerator: 'nvidia' as const, chip: 'NVIDIA RTX A6000' }, { ...MAC, platform: 'linux' as const, accelerator: 'none' as const, memoryGb: 0 }]) {
        for (const source of ['detected', 'override'] as const) expect(hardwareLine(h, tier, source), `${tier.id} ${h.accelerator}`).toMatch(/^This (Mac|machine) has [^\n]+\.$/);
      }
    }
  });

  it('not looked at yet: no hardware, and the command line says Flint is checking', () => {
    const st = status({ hardware: null });
    expect(st.hardware).toBeUndefined();
    expect(st.lines[1]).toBe('Flint is checking this machine.');
  });

  it('what detection could not find out is in the plain output', () => {
    const st = status({ hardware: { ...MAC, notes: ['sysctl hw.memsize did not answer: memory is from the runtime'] } });
    expect(st.lines[2]).toBe('A hardware check did not answer: sysctl hw.memsize did not answer: memory is from the runtime.');
    expect(st.hardware?.notes).toEqual(['sysctl hw.memsize did not answer: memory is from the runtime']);
  });
});

describe('the embedding model', () => {
  it('downloaded, not downloaded with its command and size, and a server that cannot say', () => {
    expect(status().local.embedding).toEqual({ model: EMBEDDING_MODEL.model, name: 'Nomic Embed Text', state: 'installed', sentence: 'Memory search uses it.' });
    const missing = status({ embedding: { model: EMBEDDING_MODEL.model, installed: false } });
    expect(missing.local.embedding).toMatchObject({ state: 'not_installed', pull: `ollama pull ${EMBEDDING_MODEL.model}`, downloadGb: 0.3 });
    expect(missing.local.pull).toEqual([`ollama pull ${EMBEDDING_MODEL.model}`]);
    expect(missing.lines).toContain(`To download it (about 0.3 GB), run:  ollama pull ${EMBEDDING_MODEL.model}`);
    const unknown = status({ embedding: { model: EMBEDDING_MODEL.model, installed: undefined } });
    expect(unknown.local.embedding).toEqual({ model: EMBEDDING_MODEL.model, name: 'Nomic Embed Text', state: 'unknown', sentence: "Flint can't tell whether it is downloaded." });
    expect(unknown.lines).toContain(`The embedding model is ${EMBEDDING_MODEL.model}.`);
  });

  it('another embedding model, named by Will: its name is derived, and no size is claimed for it', () => {
    const st = status({ embedding: { model: 'mxbai-embed-large', installed: false } });
    expect(st.local.embedding).toMatchObject({ name: 'Mxbai Embed Large', pull: 'ollama pull mxbai-embed-large' });
    expect(st.local.embedding?.downloadGb).toBeUndefined();
    expect(st.lines).toContain('To download it, run:  ollama pull mxbai-embed-large');
  });

  it('a server that is not Ollama gets no download command: there is nothing to run', () => {
    const st = status({ server: 'llamacpp', embedding: { model: EMBEDDING_MODEL.model, installed: false }, primary: { state: 'unavailable', why: 'not_installed' } });
    expect(st.local.pull).toEqual([]);
    expect(JSON.stringify(st)).not.toContain('ollama pull');
  });
});

describe('voice: what speaks and what hears, for the console and for the command line', () => {
  const plan = (env: Record<string, string> = {}, platform: NodeJS.Platform = 'darwin') => planVoice(readInferenceConfig(env), env, { platform, home: '/home/will' });
  const KEY = { OPENAI_API_KEY: 'sk-test' };

  it('the defaults: OpenAI speaks, and whisper.cpp hears on this Mac', () => {
    const st = status({ mode: 'hybrid', env: KEY });
    expect(st.voice).toEqual({
      speech: { provider: 'openai', name: 'OpenAI', here: false, sentence: 'It speaks replies. A reply that stays on this Mac is spoken by the device instead.' },
      transcription: { provider: 'whisper-cpp', name: 'Whisper Base English', here: true, sentence: 'Your voice is turned into text on this Mac.' },
    });
    expect(st.lines).toContain('Transcription uses whisper-cpp (ggml-base.en.bin), on this Mac.');
    expect(st.lines).toContain('Speech uses OpenAI (tts-1, onyx). A reply that stays on this Mac is spoken by the device instead.');
    expect(st.notices).toEqual([]);
  });

  it('the speech sentence is true for the mode: Local mode does not use an outside service', () => {
    const openai = plan(KEY).tts;
    expect(speechRow(openai, 'cloud').sentence).toBe('It speaks replies. A reply that stays on this Mac is spoken by the device instead.');
    expect(speechRow(openai, 'hybrid').sentence).toBe('It speaks replies. A reply that stays on this Mac is spoken by the device instead.');
    expect(speechRow(openai, 'local').sentence).toBe("Local mode doesn't use it, so each device speaks with its own voice.");
    expect(voiceLines(plan(KEY), 'local')[1]).toBe('Speech is set to OpenAI (tts-1, onyx), which Local mode does not use: each device speaks with its own voice.');
    // With no key it cannot speak in any mode, and says so.
    for (const mode of MODES) expect(speechRow(plan({}).tts, mode).sentence).toBe('It has no key, so each device speaks with its own voice.');
  });

  it("the Mac's own voice: its name when one is set, and nothing is sent out in any mode", () => {
    const named = plan({ FLINT_TTS_PROVIDER: 'say', FLINT_SAY_VOICE: 'Eddy (English (US))' });
    for (const mode of MODES) expect(speechRow(named.tts, mode)).toEqual({ provider: 'say', name: 'Eddy English US', here: true, sentence: 'Replies are spoken on this Mac, and nothing is sent out.' });
    expect(speechRow(plan({ FLINT_TTS_PROVIDER: 'say' }).tts, 'cloud').name).toBe('This Mac');
    expect(voiceLines(named, 'cloud')[1]).toBe("Speech uses this Mac's own voice (Eddy (English (US))). Nothing is sent out.");
    expect(voiceLines(plan({ FLINT_TTS_PROVIDER: 'say' }), 'local')[1]).toBe("Speech uses this Mac's own voice. Nothing is sent out.");
  });

  it('a local speech server, on this Mac or at the model server Will allowed: no address is on screen', () => {
    const here = plan({ FLINT_TTS_PROVIDER: 'local', FLINT_LOCAL_TTS_BASE_URL: 'http://127.0.0.1:8880/v1', FLINT_LOCAL_TTS_MODEL: 'kokoro', FLINT_LOCAL_TTS_VOICE: 'af_heart', FLINT_STT_PROVIDER: 'local', FLINT_LOCAL_STT_BASE_URL: 'http://127.0.0.1:8081/v1' });
    for (const mode of MODES) expect(speechRow(here.tts, mode)).toEqual({ provider: 'local', name: 'Local Speech Server', here: true, sentence: 'Replies are spoken by the speech server on this Mac, and nothing is sent out.' });
    expect(transcriptionRow(here.stt)).toEqual({ provider: 'local', name: 'Local Speech Server', here: true, sentence: 'Your voice is turned into text by the speech server on this Mac.' });
    expect(voiceLines(here, 'cloud')).toEqual(['Transcription uses the local speech server at 127.0.0.1:8081 (whisper-1).', 'Speech uses the local speech server at 127.0.0.1:8880 (kokoro, af_heart).']);
    // The one address that is not this Mac: the local model server's own, when Will said that server is his.
    const remote = plan({ FLINT_LOCAL_ALLOW_REMOTE: '1', FLINT_LOCAL_PROVIDER: 'openai', FLINT_LOCAL_BASE_URL: 'https://gpu-box.example/v1', FLINT_TTS_PROVIDER: 'local', FLINT_LOCAL_TTS_BASE_URL: 'https://gpu-box.example/v1', FLINT_STT_PROVIDER: 'local', FLINT_LOCAL_STT_BASE_URL: 'https://gpu-box.example/v1' });
    expect(speechRow(remote.tts, 'cloud')).toMatchObject({ here: true, sentence: 'Replies are spoken by the speech server on the model server you allowed.' });
    expect(transcriptionRow(remote.stt)).toMatchObject({ here: true, sentence: 'Your voice is turned into text by the speech server on the model server you allowed.' });
    for (const row of [speechRow(remote.tts, 'cloud'), transcriptionRow(remote.stt), speechRow(here.tts, 'cloud'), transcriptionRow(here.stt)]) expect(`${row.name} ${row.sentence}`).not.toMatch(/gpu-box|example|https?:|127\.0\.0\.1/);
  });

  it('off, and why when the reason is the machine', () => {
    expect(speechRow(plan({ FLINT_TTS_PROVIDER: 'off' }).tts, 'cloud')).toEqual({ provider: 'off', name: 'Off', here: true, sentence: 'Each device speaks with its own voice.' });
    expect(speechRow(plan({ FLINT_TTS_PROVIDER: 'say' }, 'linux').tts, 'cloud').sentence).toBe("This machine isn't a Mac, so each device speaks with its own voice.");
    expect(voiceLines(plan({ FLINT_TTS_PROVIDER: 'off' }), 'hybrid')[1]).toBe('Speech is off: each device speaks with its own voice.');
  });

  it('a whisper model is named for a screen from its file, never by its path', () => {
    expect(whisperName('/Users/will/.flint/models/ggml-base.en.bin')).toBe('Whisper Base English');
    expect(whisperName('ggml-small.bin')).toBe('Whisper Small');
    expect(whisperName('/m/ggml-large-v3-turbo-q5_0.bin')).toBe('Whisper Large V3 Turbo Q5 0');
    expect(whisperName('C:\\models\\ggml-medium.en.bin')).toBe('Whisper Medium English');
    expect(whisperName('')).toBe('Whisper');
    for (const odd of ['../../etc/passwd', '<script>alert(1)</script>.bin', 'ggml-$(reboot).bin', 'x'.repeat(300)]) {
      expect(whisperName(odd), odd).toMatch(/^Whisper[A-Za-z0-9 ]{0,33}$/);
    }
    const st = status({ env: { WHISPER_MODEL: '/Users/someone/secret-folder/ggml-small.en.bin' } });
    expect(st.voice!.transcription.name).toBe('Whisper Small English');
    expect(JSON.stringify(st.voice)).not.toContain('secret-folder');
    // The command line names the file, and still not the folder.
    expect(st.lines).toContain('Transcription uses whisper-cpp (ggml-small.en.bin), on this Mac.');
    expect(st.lines.join('\n')).not.toContain('secret-folder');
  });

  it('a refused voice setting is a notice in plain words, and the row says what Flint did instead', () => {
    const typo = status({ env: { ...KEY, FLINT_TTS_PROVIDER: 'sya' } });
    expect(typo.voice!.speech).toEqual({ provider: 'off', name: 'Off', here: true, sentence: 'Each device speaks with its own voice.' });
    expect(typo.notices).toEqual(["The speech setting in Flint's setup isn't one it knows, so each device speaks with its own voice."]);
    expect(typo.lines).toContain('A setting was refused: FLINT_TTS_PROVIDER is not one of openai, local, say, off.');
    const noAddress = status({ env: { ...KEY, FLINT_TTS_PROVIDER: 'local', FLINT_STT_PROVIDER: 'local' } });
    expect(noAddress.notices).toEqual(["The transcription server's address isn't set, so your voice is turned into text on this Mac.", "The speech server's address isn't set, so each device speaks with its own voice."]);
    expect(noAddress.voice!.speech.name).toBe('Off');
    expect(noAddress.voice!.transcription.name).toBe('Whisper Base English');
    const elsewhere = status({ env: { ...KEY, FLINT_TTS_PROVIDER: 'local', FLINT_LOCAL_TTS_BASE_URL: 'http://speech.example:8880/v1' } });
    expect(elsewhere.notices).toEqual(["The speech server's address is on another machine, which Flint doesn't allow unless it is told to, so each device speaks with its own voice."]);
    expect(elsewhere.voice!.speech.name).toBe('Off');
    // Told to, for the model server: that vouches for the model server, and a speech server elsewhere is still refused.
    const other = status({ env: { ...KEY, FLINT_LOCAL_ALLOW_REMOTE: '1', FLINT_TTS_PROVIDER: 'local', FLINT_LOCAL_TTS_BASE_URL: 'https://speech.example/v1', FLINT_STT_PROVIDER: 'local', FLINT_LOCAL_STT_BASE_URL: 'https://speech.example/v1' } });
    expect(other.notices).toEqual([
      "The transcription server's address is on another machine, and a speech server has to run on this Mac, so your voice is turned into text on this Mac.",
      "The speech server's address is on another machine, and a speech server has to run on this Mac, so each device speaks with its own voice.",
    ]);
    expect(other.voice).toMatchObject({ speech: { name: 'Off', here: true }, transcription: { name: 'Whisper Base English', here: true } });
    const proxied = status({ env: { ...KEY, NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: 'http://proxy.example:3128', FLINT_TTS_PROVIDER: 'local', FLINT_LOCAL_TTS_BASE_URL: 'http://127.0.0.1:8880/v1' } });
    expect(proxied.notices).toContain("The speech server's address is reached through a proxy, so each device speaks with its own voice.");
    expect(JSON.stringify([other.notices, proxied.notices])).not.toMatch(/speech\.example|proxy\.example/);
    const voice = status({ env: { ...KEY, FLINT_TTS_PROVIDER: 'say', FLINT_SAY_VOICE: '--help', FLINT_LOCAL_TTS_VOICE: 'a b' } });
    expect(voice.notices).toEqual(["A speech model or voice named in Flint's setup isn't a valid name, so Flint uses its usual one.", "The voice named in Flint's setup isn't a voice name, so this Mac's usual voice is used."]);
    const key = status({ env: { FLINT_LOCAL_ALLOW_REMOTE: '1', FLINT_LOCAL_ALLOW_INSECURE_REMOTE: '1', FLINT_LOCAL_PROVIDER: 'openai', FLINT_LOCAL_BASE_URL: 'http://gpu-box.example:8880/v1', FLINT_TTS_PROVIDER: 'local', FLINT_LOCAL_TTS_BASE_URL: 'http://gpu-box.example:8880/v1', FLINT_LOCAL_VOICE_API_KEY: 'voice-SECRET' } });
    expect(key.notices).toContain("The speech server's key isn't sent, because the server's address isn't encrypted.");
    expect(JSON.stringify(key)).not.toContain('SECRET');
  });
});
