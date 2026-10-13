/**
 * Configuration for local inference: which wire the local brain is on, where
 * its server is, how long a turn waits for it, and the routing mode. Every key
 * is validated by a schema here before anything reads it.
 *
 * The server's convention holds (./brains, ./style-variant): a bad value never
 * stops Flint. It is reported by NAME and REASON, never by value (a URL can
 * carry a password, a key is a key), and replaced by the outcome in the table
 * below. That outcome is the safe side, which is not always the default:
 *
 *   key                                  unset                        invalid
 *   FLINT_INFERENCE_MODE                 cloud                        local (a typo must not send a private setup to the cloud)
 *   FLINT_LOCAL_PROVIDER                 ollama (the native wire)     ollama
 *   FLINT_LOCAL_BASE_URL                 http://127.0.0.1:11434/v1    the OpenAI-compatible provider is OFF, never a silent substitute
 *   FLINT_LOCAL_ALLOW_REMOTE             0                            0
 *   FLINT_LOCAL_ALLOW_INSECURE_REMOTE    0                            0
 *   FLINT_LOCAL_API_KEY                  none                         none
 *   FLINT_LOCAL_SERVER                   auto                         auto
 *   FLINT_LOCAL_MODEL                    (see ./local-brains)         ignored
 *   FLINT_LOCAL_FALLBACK_MODEL           (see ./local-brains)         ignored
 *   FLINT_LOCAL_FALLBACK_NUM_CTX         the tier's standby context   ignored: the tier's
 *   FLINT_LOCAL_TOOLS                    auto                         off
 *   FLINT_LOCAL_CONNECT_TIMEOUT_MS       1500                         1500
 *   FLINT_LOCAL_FIRST_OUTPUT_TIMEOUT_MS  20000                        20000
 *   FLINT_LOCAL_TOOL_PASS_TIMEOUT_MS     60000                        60000
 *   FLINT_LOCAL_REQUEST_TIMEOUT_MS       120000                       120000
 *   FLINT_LOCAL_IDLE_TIMEOUT_MS          30000                        30000
 *   FLINT_LOCAL_HEALTH_INTERVAL_MS       15000                        15000
 *   FLINT_HARDWARE_TIER                  auto (detect)                auto
 *   OLLAMA_MODEL                         (see ./local-brains)         ignored: the server is asked what it has
 *   OLLAMA_NUM_CTX                       (see ./local-brains)         ignored: the model's own, or the tier's
 *   FLINT_EMBED_MODEL                    the tier table's             ignored: the tier table's
 *   FLINT_STT_PROVIDER                   whisper-cpp (this Mac)       whisper-cpp: the engine on this Mac, the most private there is
 *   FLINT_TTS_PROVIDER                   openai (as before)           off: no speech is made here, each device uses its own voice
 *   FLINT_LOCAL_STT_BASE_URL             none                         transcription stays on whisper-cpp, never another address
 *   FLINT_LOCAL_STT_MODEL                whisper-1                    whisper-1
 *   FLINT_LOCAL_TTS_BASE_URL             none                         speech is off, never OpenAI in its place
 *   FLINT_LOCAL_TTS_MODEL                tts-1                        tts-1
 *   FLINT_LOCAL_TTS_VOICE                alloy                        alloy
 *   FLINT_LOCAL_VOICE_API_KEY            none                         none
 *   FLINT_SAY_VOICE                      the Mac's own default        the Mac's own default
 *   FLINT_TTS_MODEL / FLINT_TTS_VOICE    tts-1 / onyx (OpenAI's)      tts-1 / onyx
 *   WHISPER_BIN / WHISPER_MODEL          Homebrew's, ~/.flint/models  the same: the usual program, the usual model
 *
 * The last four are older than this module. The server used to read them
 * before it read ~/.flint/secrets.env, so a line for one of them in that file
 * was silently ignored; they are read here, after it, so such a line now
 * applies. A path may start with `~/` (neither that file nor a LaunchAgent
 * expands it): it is this home folder. Any other path that is not a full one
 * is refused, and so is one that names a file that is not there when Flint
 * starts (a line saved long ago, which nothing read until now): the usual
 * program or model is used, wherever the value came from. A recording is
 * never failed for a setting.
 *
 * A voice setting that is refused never lands on a less private choice than
 * the one that was meant: a speech provider Flint does not know is no speech
 * at all (the default would be an outside service), and a local speech server
 * whose address is refused is never replaced by OpenAI.
 *
 * A local speech server is on THIS MAC. The one exception is the same one
 * OLLAMA_HOST has (`ollamaIsLocal`): the address of the local model server
 * itself, when Will said that server is his. FLINT_LOCAL_ALLOW_REMOTE vouches
 * for that server and for no other machine, so a speech server anywhere else
 * is refused, and so is one that Node's env proxy would carry the request to.
 *
 * Secure by default: a local endpoint is this Mac (127.0.0.1, localhost or
 * [::1]) unless FLINT_LOCAL_ALLOW_REMOTE=1 says a server elsewhere is meant.
 * OLLAMA_HOST, which the native wire has always read, is held to the same rule
 * in the local and hybrid modes (./local-brains): "local" must mean this Mac.
 *
 * Kept free of index.ts so it is unit-testable (index.ts runs main() on import).
 */
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { HARDWARE_TIER_IDS, isLoopbackHost, isOllamaCloudModel, type HardwareTierId } from '@flint/core';
import { readEnvProxy as policyEnvProxy, viaProxy, type EnvProxy } from '@flint/policy';
import { LOCAL_MODEL_MAX_LEN, LOCAL_MODEL_RE } from './local-model';

export const MODES = ['local', 'cloud', 'hybrid'] as const;
export type InferenceMode = (typeof MODES)[number];

/** Which wire the local brain is on: Ollama's own API (the default), or the OpenAI-compatible adapter. */
export const LOCAL_PROVIDERS = ['ollama', 'openai'] as const;
export type LocalProviderKind = (typeof LOCAL_PROVIDERS)[number];

/** What kind of server answers at the local address; `auto` asks it. */
export const LOCAL_SERVERS = ['auto', 'ollama', 'llamacpp', 'openai'] as const;
export type LocalServerSetting = (typeof LOCAL_SERVERS)[number];

/** What turns Will's voice into text: whisper.cpp on this Mac (today's), or an OpenAI-compatible local speech server. */
export const STT_PROVIDERS = ['whisper-cpp', 'local'] as const;
export type SttProviderKind = (typeof STT_PROVIDERS)[number];

/** What speaks a reply: OpenAI (today's), an OpenAI-compatible local speech server, the Mac's own `say`, or nothing here. */
export const TTS_PROVIDERS = ['openai', 'local', 'say', 'off'] as const;
export type TtsProviderKind = (typeof TTS_PROVIDERS)[number];

/**
 * A voice for the Mac's `say`: letters, spaces, brackets and hyphens, as its
 * own list names them ("Samantha", "Eddy (English (US))"). It starts with a
 * letter, so it can never be read as an option.
 */
export const SAY_VOICE_RE = /^[A-Za-z][A-Za-z ()-]{0,39}$/;

/** The longest name `say` gives a voice that is taken here. */
export const SAY_VOICE_MAX_LEN = 40;

/**
 * A model or a voice on a speech server, and OpenAI's speech model: a plain
 * name, never a path or an option. The same shape a rebuild puts back
 * (apps/studio/recovery_lib.sh `model`, `speechname`), so a name that is taken
 * here is one a rebuild keeps.
 */
const SPEECH_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/;
const speechName = z.string().trim().min(1).max(80).regex(SPEECH_NAME_RE);
/** OpenAI's voice: one word (recovery_lib.sh `word`). */
const SPEECH_WORD_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;

/** The longest path to a program or a model file that is looked at, and the longest file name a log or a status shows. */
const FILE_PATH_MAX_LEN = 1024;
const FILE_NAME_MAX_LEN = 100;
/** Nothing a terminal or a log acts on: a control character, a format character (a direction override), a line or paragraph separator. */
const UNPRINTABLE_RE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
/**
 * A path to a program or to a model's file, as it is written in a setting:
 * printable, bounded, and with a file name short enough to show. Whether it
 * is a full path is decided where the home folder is known (`filePath`).
 */
const fileSetting = z
  .string()
  .trim()
  .min(1)
  .max(FILE_PATH_MAX_LEN)
  .refine((v) => !UNPRINTABLE_RE.test(v), { message: 'unprintable' })
  .refine((v) => /[^\\/]$/.test(v) && v.replace(/^.*[\\/]/, '').length <= FILE_NAME_MAX_LEN, { message: 'file_name' });

/** What is looked for at a path: a file, or a program (a file this user may run). */
export type FileKind = 'file' | 'program';
/** Is that there? Handed in by whoever touches the file system (./voice isFile); a stand-in may answer for the path alone. */
export type FileCheck = (path: string, kind: FileKind) => boolean;

export const DEFAULT_LOCAL_STT_MODEL = 'whisper-1';
export const DEFAULT_LOCAL_TTS_MODEL = 'tts-1';
export const DEFAULT_LOCAL_TTS_VOICE = 'alloy';

export const DEFAULT_LOCAL_BASE_URL = 'http://127.0.0.1:11434/v1';
export const DEFAULT_OLLAMA_HOST = 'http://127.0.0.1:11434';

export const DEFAULTS = {
  connectTimeoutMs: 1_500,
  firstTokenTimeoutMs: 20_000,
  toolPassTimeoutMs: 60_000,
  requestTimeoutMs: 120_000,
  idleTimeoutMs: 30_000,
  healthIntervalMs: 15_000,
} as const;

type Env = Record<string, string | undefined>;

// Node's own proxy switch (NODE_USE_ENV_PROXY): with it on, a request to 127.0.0.1 leaves this process for the
// proxy first, so an address that goes through the proxy is not "this Mac", whatever its host is. The rule is
// @flint/policy's (models.ts), which the runtime reads too; re-exported so imports here hold.
export { viaProxy, type EnvProxy };

/** Read the switch as Node reads it at startup. `execArgv`: this process's own flags. */
export function readEnvProxy(env: Env, execArgv: readonly string[] = process.execArgv): EnvProxy {
  return policyEnvProxy(env, execArgv);
}

/** The longest address that is looked at at all (a model server's URL is a few dozen characters). */
export const LOCAL_URL_MAX_LEN = 2048;

export type UrlProblem = 'not_a_url' | 'not_http' | 'has_credentials' | 'has_query' | 'bad_path' | 'not_loopback' | 'insecure_remote';

export type LocalUrl =
  | {
      ok: true;
      /** Normalised: no trailing slash, and `/v1` when the URL named no path. */
      baseURL: string;
      /** Scheme, host and port: where every probe and call goes. */
      origin: string;
      /** The path under the origin (`/v1`). */
      path: string;
      loopback: boolean;
      /** `host:port`, the most a log or a status may show. */
      host: string;
      /** https, or this Mac: nothing sent to it crosses a network in the clear. */
      secure: boolean;
    }
  | { ok: false; reason: UrlProblem };

/** An address that passed: what `parseLocalUrl` says of it. */
export type LocalUrlOk = Extract<LocalUrl, { ok: true }>;

/**
 * A local model server's address, or why it is refused. http or https; no
 * credentials, query or fragment; a path of at most three plain segments; and
 * this Mac only unless `allowRemote`.
 *
 * `localhost` is PINNED to 127.0.0.1: the address a request goes to is then
 * this machine's loopback whatever a resolver or a hosts file says the name
 * means.
 *
 * With `refuseInsecureRemote`, a server on another machine must be https:
 * plain http would carry every prompt across the network in the clear.
 */
export function parseLocalUrl(raw: string, allowRemote: boolean, opts: { defaultPath?: string; refuseInsecureRemote?: boolean } = {}): LocalUrl {
  // An address is short. Nothing longer is parsed, so no pattern below ever runs on a long string.
  if (raw.length > LOCAL_URL_MAX_LEN) return { ok: false, reason: 'not_a_url' };
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return { ok: false, reason: 'not_a_url' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, reason: 'not_http' };
  if (u.username || u.password) return { ok: false, reason: 'has_credentials' };
  if (u.search || u.hash || raw.includes('?') || raw.includes('#')) return { ok: false, reason: 'has_query' };
  // As written, not as the URL parser resolved it: an escape, a backslash or a dot segment is
  // never a plain path, even when it resolves to one.
  if (/[%\\]|\/\.{1,2}(\/|$)/.test(raw)) return { ok: false, reason: 'bad_path' };
  // Trailing slashes, without a pattern that rescans a long run of them from every slash in it.
  let end = u.pathname.length;
  while (end > 0 && u.pathname.charCodeAt(end - 1) === 47) end--;
  const trimmed = u.pathname.slice(0, end);
  if (trimmed !== '' && !/^(\/[A-Za-z0-9._-]{1,40}){1,3}$/.test(trimmed)) return { ok: false, reason: 'bad_path' };
  const loopback = isLoopbackHost(u.hostname);
  if (!loopback && !allowRemote) return { ok: false, reason: 'not_loopback' };
  const secure = loopback || u.protocol === 'https:';
  if (!secure && opts.refuseInsecureRemote) return { ok: false, reason: 'insecure_remote' };
  // The name `localhost` is whatever the resolver says it is; 127.0.0.1 is this machine.
  if (u.hostname.toLowerCase() === 'localhost') u.hostname = '127.0.0.1';
  const path = trimmed === '' ? opts.defaultPath ?? '' : trimmed;
  return { ok: true, baseURL: `${u.origin}${path}`, origin: u.origin, path, loopback, host: u.host, secure };
}

/** Ollama model tags, minus Ollama's cloud models (they run on Ollama's servers, not here). */
const modelTag = z
  .string()
  .trim()
  .min(1)
  .max(LOCAL_MODEL_MAX_LEN)
  .regex(LOCAL_MODEL_RE)
  .refine((m) => !isOllamaCloudModel(m), { message: 'cloud_model' });

/** A whole number of milliseconds in [min, max], written in plain digits. */
const ms = (min: number, max: number) =>
  z
    .string()
    .trim()
    .regex(/^\d{1,7}$/)
    .transform(Number)
    .pipe(z.number().int().min(min).max(max));

/** A context size in tokens, written in plain digits: 256 to 1,048,576. */
const contextSize = z
  .string()
  .trim()
  .regex(/^\d{1,7}$/)
  .transform(Number)
  .pipe(z.number().int().min(256).max(1_048_576));

/** One schema per key: the single place a value's shape is decided. */
export const SCHEMAS = {
  FLINT_INFERENCE_MODE: z.string().trim().toLowerCase().pipe(z.enum(MODES)),
  FLINT_LOCAL_PROVIDER: z.string().trim().toLowerCase().pipe(z.enum(LOCAL_PROVIDERS)),
  FLINT_LOCAL_ALLOW_REMOTE: z.string().trim().pipe(z.enum(['0', '1'])),
  FLINT_LOCAL_ALLOW_INSECURE_REMOTE: z.string().trim().pipe(z.enum(['0', '1'])),
  FLINT_LOCAL_API_KEY: z.string().trim().min(1).max(512).regex(/^[\x21-\x7e]+$/),
  FLINT_LOCAL_SERVER: z.string().trim().toLowerCase().pipe(z.enum(LOCAL_SERVERS)),
  FLINT_LOCAL_MODEL: modelTag,
  // `off`, or `none`: no standby. (`none` used to be read as a model called "none".)
  FLINT_LOCAL_FALLBACK_MODEL: z.union([
    z
      .string()
      .trim()
      .toLowerCase()
      .pipe(z.enum(['off', 'none']))
      .transform(() => 'off' as const),
    modelTag,
  ]),
  FLINT_LOCAL_TOOLS: z.string().trim().toLowerCase().pipe(z.enum(['auto', 'on', 'off'])),
  FLINT_LOCAL_CONNECT_TIMEOUT_MS: ms(100, 30_000),
  FLINT_LOCAL_FIRST_OUTPUT_TIMEOUT_MS: ms(500, 300_000),
  FLINT_LOCAL_TOOL_PASS_TIMEOUT_MS: ms(1_000, 600_000),
  FLINT_LOCAL_REQUEST_TIMEOUT_MS: ms(1_000, 600_000),
  FLINT_LOCAL_IDLE_TIMEOUT_MS: ms(1_000, 600_000),
  FLINT_LOCAL_HEALTH_INTERVAL_MS: ms(2_000, 600_000),
  FLINT_HARDWARE_TIER: z.string().trim().toLowerCase().pipe(z.enum(['auto', ...HARDWARE_TIER_IDS])),
  // Older than this module, and read as they are by other parts of the server. Checked here
  // before they reach a request, a log or a status from this one. (A cloud tag in OLLAMA_MODEL
  // is a model's name: ./local-model refuses it as the local brain, and says so.)
  OLLAMA_MODEL: z.string().trim().min(1).max(LOCAL_MODEL_MAX_LEN).regex(LOCAL_MODEL_RE),
  OLLAMA_NUM_CTX: contextSize,
  FLINT_LOCAL_FALLBACK_NUM_CTX: contextSize,
  // A model tag like any other here: never one of Ollama's cloud models, which would send every fact and every
  // question it embeds to Ollama's servers.
  FLINT_EMBED_MODEL: modelTag,
  // Voice (./voice). The defaults are today's: whisper.cpp hears, OpenAI speaks.
  FLINT_STT_PROVIDER: z.string().trim().toLowerCase().pipe(z.enum(STT_PROVIDERS)),
  FLINT_TTS_PROVIDER: z.string().trim().toLowerCase().pipe(z.enum(TTS_PROVIDERS)),
  FLINT_LOCAL_STT_MODEL: speechName,
  FLINT_LOCAL_TTS_MODEL: speechName,
  FLINT_LOCAL_TTS_VOICE: speechName,
  FLINT_LOCAL_VOICE_API_KEY: z.string().trim().min(1).max(512).regex(/^[\x21-\x7e]+$/),
  FLINT_SAY_VOICE: z.string().trim().min(1).max(SAY_VOICE_MAX_LEN).regex(SAY_VOICE_RE),
  // Older than this module (the server read them as they were). A name that goes to OpenAI, into a log and into a
  // status is a plain name; a path is printable and bounded, so no newline or escape of it reaches a line of either.
  FLINT_TTS_MODEL: speechName,
  FLINT_TTS_VOICE: z.string().trim().min(1).max(40).regex(SPEECH_WORD_RE),
  WHISPER_BIN: fileSetting,
  WHISPER_MODEL: fileSetting,
} as const;

/**
 * A context size written as plain digits, 256 to 1,048,576: the one rule for
 * every setting that is one. Undefined for anything else (unset, a float, an
 * exponent, a size no model has).
 */
export function readContextSize(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const parsed = contextSize.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

export type ConfigKey = keyof typeof SCHEMAS | 'FLINT_LOCAL_BASE_URL' | 'OLLAMA_HOST' | 'FLINT_LOCAL_STT_BASE_URL' | 'FLINT_LOCAL_TTS_BASE_URL';

/**
 * The class of a refusal, for a face that says it in its own words (the
 * console never shows a key's name): what was wrong with an address, a model
 * that runs on Ollama's servers, a key that would have travelled in the clear,
 * or simply a value the key does not take.
 */
export type ProblemKind = UrlProblem | 'invalid' | 'cloud_model' | 'in_the_clear' | 'unset' | 'other_machine' | 'proxied' | 'missing';

/** A value that was set and refused: the key, why in words, and the class of the refusal. Never the value. */
export interface ConfigProblem {
  key: ConfigKey;
  reason: string;
  kind: ProblemKind;
}

export interface InferenceConfig {
  /** The mode the environment asks for (a mode saved from Settings wins over it, ./inference-mode). */
  mode: InferenceMode;
  /** `env`: FLINT_INFERENCE_MODE was valid; `default`: it was unset; `invalid_env`: it was refused, so `local`. */
  modeSource: 'env' | 'default' | 'invalid_env';
  local: {
    /** The wire: `ollama` is Ollama's own API (today's), `openai` the OpenAI-compatible adapter. */
    provider: LocalProviderKind;
    /** The OpenAI-compatible server. Undefined when FLINT_LOCAL_BASE_URL was refused: that provider is off. */
    openai: Extract<LocalUrl, { ok: true }> | undefined;
    /** Ollama's own address (OLLAMA_HOST), `path` being a prefix it is served under. Undefined when it is not an http(s) URL. */
    ollama: { origin: string; path: string; host: string; loopback: boolean; secure: boolean } | undefined;
    /** FLINT_LOCAL_ALLOW_REMOTE=1: a server on another machine is meant. */
    allowRemote: boolean;
    /** FLINT_LOCAL_ALLOW_INSECURE_REMOTE=1: that server may be reached over plain http (a private network Will trusts). */
    allowInsecureRemote: boolean;
    /** Node's proxy switch (NODE_USE_ENV_PROXY): an address that goes through it is not this Mac. */
    proxy: EnvProxy;
    server: LocalServerSetting;
    /** FLINT_LOCAL_MODEL: names the local model on either wire, ahead of OLLAMA_MODEL. */
    model: string | undefined;
    /** OLLAMA_MODEL, when it is a model's name. Undefined when unset or refused. */
    ollamaModel: string | undefined;
    /** OLLAMA_NUM_CTX, when it is a context size. Undefined when unset or refused. */
    numCtx: number | undefined;
    /** FLINT_LOCAL_FALLBACK_MODEL: a model, `off`, or undefined for the default (./local-brains). */
    fallbackModel: string | 'off' | undefined;
    /** FLINT_LOCAL_FALLBACK_NUM_CTX: the standby's context, in place of the hardware tier's. Undefined when unset or refused. */
    fallbackNumCtx: number | undefined;
    /** FLINT_EMBED_MODEL: the embedding model, in place of the tier table's. Undefined when unset or refused. */
    embedModel: string | undefined;
    /** May the local model be offered tools: what the server reports (`auto`), always, or never. */
    tools: 'auto' | 'on' | 'off';
    /** Never logged, never in a status. */
    apiKey: string | undefined;
    connectTimeoutMs: number;
    firstTokenTimeoutMs: number;
    toolPassTimeoutMs: number;
    requestTimeoutMs: number;
    /** How long a reply may go quiet once it has begun, between one piece and the next. */
    idleTimeoutMs: number;
    healthIntervalMs: number;
  };
  /** FLINT_HARDWARE_TIER: `auto` detects the machine (./hardware); a tier id overrides the detection. */
  hardwareTier: 'auto' | HardwareTierId;
  /** Voice (./voice): what hears and what speaks. What is here is what was SET and passed; ./voice decides what it comes to. */
  voice: {
    /** FLINT_STT_PROVIDER. Unset or refused: `whisper-cpp`. */
    stt: SttProviderKind;
    /** FLINT_TTS_PROVIDER. Unset: `openai`, as before. Refused: `off`, never the outside service a typo did not ask for. */
    tts: TtsProviderKind;
    /** FLINT_LOCAL_STT_BASE_URL. Undefined when unset or refused: there is no local transcription server. */
    sttServer: LocalUrlOk | undefined;
    sttModel: string;
    /** FLINT_LOCAL_TTS_BASE_URL. Undefined when unset or refused: there is no local speech server. */
    ttsServer: LocalUrlOk | undefined;
    ttsModel: string;
    ttsVoice: string;
    /** FLINT_LOCAL_VOICE_API_KEY, for a speech server started with a key. Never logged, never in a status. */
    apiKey: string | undefined;
    /** FLINT_SAY_VOICE. Undefined: the Mac's own default voice. */
    sayVoice: string | undefined;
    /** FLINT_TTS_MODEL and FLINT_TTS_VOICE, OpenAI's. Undefined when unset or refused: the usual ones (./voice). */
    openaiModel: string | undefined;
    openaiVoice: string | undefined;
    /** WHISPER_BIN and WHISPER_MODEL, as full paths (`~/` is this home folder). Undefined when unset or refused: the usual ones (./voice). */
    whisperBin: string | undefined;
    whisperModel: string | undefined;
  };
  problems: ConfigProblem[];
}

/** Why a schema refused a value, in a word or two that never includes the value. */
function reasonOf(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'invalid';
  if (issue.message === 'cloud_model') return 'an Ollama cloud model does not run on this Mac';
  if (issue.message === 'unprintable') return 'written with characters that cannot be shown';
  if (issue.message === 'file_name') return 'not the path of a file with a name of at most 100 characters';
  switch (issue.code) {
    case 'invalid_enum_value':
      return `not one of ${issue.options.join(', ')}`;
    case 'invalid_literal':
    case 'invalid_union':
      return 'not a model name or off';
    case 'too_small':
      return issue.type === 'number' ? `below ${String(issue.minimum)}` : 'empty';
    case 'too_big':
      return issue.type === 'number' ? `above ${String(issue.maximum)}` : 'too long';
    case 'invalid_string':
      return 'written with characters that are not allowed';
    default:
      return 'invalid';
  }
}

/** Each reads after "<KEY> is ...". */
const URL_REASONS: Record<UrlProblem, string> = {
  not_a_url: 'not a URL',
  not_http: 'not http or https',
  has_credentials: 'a URL that carries credentials (use FLINT_LOCAL_API_KEY)',
  has_query: 'a URL with a query or fragment',
  bad_path: 'a URL whose path is not a plain one like /v1',
  not_loopback: 'not on this Mac (set FLINT_LOCAL_ALLOW_REMOTE=1 to use a server elsewhere)',
  insecure_remote: 'plain http to another machine (use https, or set FLINT_LOCAL_ALLOW_INSECURE_REMOTE=1 for a private network)',
};

/**
 * The same for a speech server's address, where two of them would mislead: its
 * key has a setting of its own, and no switch lets a speech server be on
 * another machine (FLINT_LOCAL_ALLOW_REMOTE vouches for the model server).
 */
const SPEECH_URL_REASONS: Record<UrlProblem, string> = {
  ...URL_REASONS,
  has_credentials: 'a URL that carries credentials (use FLINT_LOCAL_VOICE_API_KEY)',
  not_loopback: 'on another machine (a speech server runs on this Mac)',
};

/**
 * Read every key. `warn` gets one line per refused value; the same facts are
 * in `problems` for the status command. Nothing here throws.
 */
export function readInferenceConfig(
  env: Env,
  warn: (msg: string) => void = () => {},
  opts: {
    execArgv?: readonly string[];
    home?: string;
    /**
     * Is there a file at this path? Handed in by whoever starts the server
     * (./inference buildInference: the real file system), so that a program or
     * a model that is named and not there is refused here, at start. Left out,
     * no file is looked for: this function reads the environment and nothing
     * else.
     */
    fileExists?: FileCheck;
  } = {},
): InferenceConfig {
  const problems: ConfigProblem[] = [];
  const refuse = (key: ConfigKey, reason: string, outcome: string, kind: ProblemKind = 'invalid'): void => {
    problems.push({ key, reason, kind });
    warn(`[inference] ${key} is ${reason}; ${outcome}`);
  };
  /** A key's parsed value; `unset` when absent or blank; `invalid` (reported) when refused. */
  const read = <K extends keyof typeof SCHEMAS>(key: K, outcome: string): { state: 'ok'; value: z.output<(typeof SCHEMAS)[K]> } | { state: 'unset' | 'invalid' } => {
    const raw = env[key];
    if (raw === undefined || raw.trim() === '') return { state: 'unset' };
    const parsed = SCHEMAS[key].safeParse(raw);
    if (parsed.success) return { state: 'ok', value: parsed.data as z.output<(typeof SCHEMAS)[K]> };
    refuse(key, reasonOf(parsed.error), outcome, parsed.error.issues[0]?.message === 'cloud_model' ? 'cloud_model' : 'invalid');
    return { state: 'invalid' };
  };
  const or = <T>(r: { state: 'ok'; value: T } | { state: 'unset' | 'invalid' }, unset: T, invalid: T = unset): T =>
    r.state === 'ok' ? r.value : r.state === 'unset' ? unset : invalid;

  const modeRead = read('FLINT_INFERENCE_MODE', 'running as local, which never uses the cloud');
  const mode: InferenceMode = or<InferenceMode>(modeRead, 'cloud', 'local');
  const modeSource = modeRead.state === 'ok' ? 'env' : modeRead.state === 'unset' ? 'default' : 'invalid_env';

  // Node's own proxy switch is not one of Flint's keys: it is only read, and said once when it changes what is local.
  const proxy = readEnvProxy(env, opts.execArgv);
  const allowRemote = or(read('FLINT_LOCAL_ALLOW_REMOTE', 'only this Mac is allowed'), '0') === '1';
  const allowInsecureRemote = or(read('FLINT_LOCAL_ALLOW_INSECURE_REMOTE', 'a server on another machine must be https'), '0') === '1';
  const provider = or<LocalProviderKind>(read('FLINT_LOCAL_PROVIDER', "using Ollama's own API"), 'ollama');

  const rawBase = env.FLINT_LOCAL_BASE_URL?.trim();
  const base = parseLocalUrl(rawBase || DEFAULT_LOCAL_BASE_URL, allowRemote, { defaultPath: '/v1', refuseInsecureRemote: !allowInsecureRemote });
  if (!base.ok) refuse('FLINT_LOCAL_BASE_URL', URL_REASONS[base.reason], 'the OpenAI-compatible provider is off', base.reason);
  // A key is never sent in the clear: over plain http to another machine it is left out, whatever else is allowed.
  let apiKey = or<string | undefined>(read('FLINT_LOCAL_API_KEY', 'no key is sent'), undefined);
  if (apiKey && base.ok && !base.secure) {
    refuse('FLINT_LOCAL_API_KEY', 'not sent over plain http to another machine', 'no key is sent (use https)', 'in_the_clear');
    apiKey = undefined;
  }

  // OLLAMA_HOST is older than this module and other parts of the server read it as it is. Here it is
  // only checked: whether it is this Mac decides if "local" may use it in the local and hybrid modes.
  const rawOllama = env.OLLAMA_HOST?.trim();
  const ollamaUrl = parseLocalUrl(rawOllama || DEFAULT_OLLAMA_HOST, true);
  if (!ollamaUrl.ok) refuse('OLLAMA_HOST', URL_REASONS[ollamaUrl.reason], "Ollama's own API is off", ollamaUrl.reason);

  // Voice. A provider Flint does not know is whisper-cpp for hearing (this Mac, the most private there is) and
  // OFF for speaking: the default there is an outside service, and a typo must not choose it.
  const stt = or<SttProviderKind>(read('FLINT_STT_PROVIDER', 'transcription stays on whisper-cpp, on this Mac'), 'whisper-cpp');
  const tts = or<TtsProviderKind>(read('FLINT_TTS_PROVIDER', 'no speech is made here, so each device uses its own voice'), 'openai', 'off');
  /**
   * A local speech server's address: this Mac. Or the local model server's own address on another machine, when
   * Will said that server is his (the switch vouches for that server and no other), and then under its rule: https,
   * unless he also called its network private. Never an address Node's env proxy would carry the request to.
   */
  // Where the model server's own setting points, read as an address and nothing more: whether a machine other than
  // this one may be used at all, and over what, is decided below, by the same two switches the model server has.
  const baseAsWritten = parseLocalUrl(rawBase || DEFAULT_LOCAL_BASE_URL, true, { defaultPath: '/v1' });
  const modelOrigin = provider === 'openai' ? (baseAsWritten.ok ? baseAsWritten.origin : undefined) : ollamaUrl.ok ? ollamaUrl.origin : undefined;
  const speechServer = (key: 'FLINT_LOCAL_STT_BASE_URL' | 'FLINT_LOCAL_TTS_BASE_URL', wanted: boolean, outcome: string): LocalUrlOk | undefined => {
    const raw = env[key]?.trim();
    if (!raw) {
      if (wanted) refuse(key, 'not set', outcome, 'unset');
      return undefined;
    }
    // Read as an address first, whatever machine it names: what is said of another machine is this rule's own.
    const at = parseLocalUrl(raw, true, { defaultPath: '/v1' });
    if (!at.ok) {
      refuse(key, SPEECH_URL_REASONS[at.reason], outcome, at.reason);
      return undefined;
    }
    if (!at.loopback) {
      if (!allowRemote || modelOrigin !== at.origin) {
        refuse(key, SPEECH_URL_REASONS.not_loopback, outcome, 'other_machine');
        return undefined;
      }
      // The model server's own address: under the model server's rule, https unless its network was called private.
      if (!at.secure && !allowInsecureRemote) {
        refuse(key, URL_REASONS.insecure_remote, outcome, 'insecure_remote');
        return undefined;
      }
    }
    if (viaProxy(at.host, proxy)) {
      refuse(key, 'reached through a proxy (NODE_USE_ENV_PROXY), so it is not this Mac', outcome, 'proxied');
      return undefined;
    }
    return at;
  };
  const sttServer = speechServer('FLINT_LOCAL_STT_BASE_URL', stt === 'local', 'transcription stays on whisper-cpp, on this Mac');
  const ttsServer = speechServer('FLINT_LOCAL_TTS_BASE_URL', tts === 'local', 'no speech is made here, so each device uses its own voice');
  // The same rule as the model server's key: never in the clear to another machine.
  let voiceKey = or<string | undefined>(read('FLINT_LOCAL_VOICE_API_KEY', 'no key is sent'), undefined);
  if (voiceKey && [sttServer, ttsServer].some((at) => at && !at.secure)) {
    refuse('FLINT_LOCAL_VOICE_API_KEY', 'not sent over plain http to another machine', 'no key is sent (use https)', 'in_the_clear');
    voiceKey = undefined;
  }

  /**
   * A path to a program or a model file: a full path, with `~/` read as this home folder (neither the settings
   * file nor a LaunchAgent expands it, and a path whisper.cpp cannot open would fail every recording). Any other
   * path that is not a full one (`~someone/...`, a bare name) is refused, and the usual one is used. So is one
   * that names a file that is not there (`opts.fileExists`), or a program that is there and may not be run (a
   * file without execute permission fails every recording just as a missing one does): said by the setting's
   * name, never by its path.
   */
  const home = opts.home ?? homedir();
  const filePath = (key: 'WHISPER_BIN' | 'WHISPER_MODEL', outcome: string): string | undefined => {
    const r = read(key, outcome);
    if (r.state !== 'ok') return undefined;
    const full = r.value.startsWith('~/') ? join(home, r.value.slice(2)) : r.value;
    if (!isAbsolute(full)) {
      refuse(key, 'not a full path (one that starts with / or with ~/)', outcome);
      return undefined;
    }
    if (opts.fileExists && !opts.fileExists(full, key === 'WHISPER_BIN' ? 'program' : 'file')) {
      refuse(key, key === 'WHISPER_BIN' ? 'the path of a program that is not there, or that cannot be run' : 'the path of a file that is not there', outcome, 'missing');
      return undefined;
    }
    return full;
  };

  return {
    mode,
    modeSource,
    voice: {
      stt,
      tts,
      sttServer,
      sttModel: or(read('FLINT_LOCAL_STT_MODEL', `using ${DEFAULT_LOCAL_STT_MODEL}`), DEFAULT_LOCAL_STT_MODEL),
      ttsServer,
      ttsModel: or(read('FLINT_LOCAL_TTS_MODEL', `using ${DEFAULT_LOCAL_TTS_MODEL}`), DEFAULT_LOCAL_TTS_MODEL),
      ttsVoice: or(read('FLINT_LOCAL_TTS_VOICE', `using ${DEFAULT_LOCAL_TTS_VOICE}`), DEFAULT_LOCAL_TTS_VOICE),
      apiKey: voiceKey,
      sayVoice: or<string | undefined>(read('FLINT_SAY_VOICE', "using the Mac's own default voice"), undefined),
      openaiModel: or<string | undefined>(read('FLINT_TTS_MODEL', "using OpenAI's usual speech model"), undefined),
      openaiVoice: or<string | undefined>(read('FLINT_TTS_VOICE', "using OpenAI's usual voice"), undefined),
      whisperBin: filePath('WHISPER_BIN', 'using the usual transcription program'),
      whisperModel: filePath('WHISPER_MODEL', 'using the usual transcription model'),
    },
    local: {
      provider,
      openai: base.ok ? base : undefined,
      ollama: ollamaUrl.ok ? { origin: ollamaUrl.origin, path: ollamaUrl.path, host: ollamaUrl.host, loopback: ollamaUrl.loopback, secure: ollamaUrl.secure } : undefined,
      allowRemote,
      allowInsecureRemote,
      proxy,
      server: or<LocalServerSetting>(read('FLINT_LOCAL_SERVER', 'asking the server what it is'), 'auto'),
      model: or<string | undefined>(read('FLINT_LOCAL_MODEL', 'ignored'), undefined),
      ollamaModel: or<string | undefined>(read('OLLAMA_MODEL', 'ignored, so the model server is asked what it has'), undefined),
      numCtx: or<number | undefined>(read('OLLAMA_NUM_CTX', "ignored, so the model's own context is used"), undefined),
      fallbackModel: or<string | undefined>(read('FLINT_LOCAL_FALLBACK_MODEL', 'ignored'), undefined),
      fallbackNumCtx: or<number | undefined>(read('FLINT_LOCAL_FALLBACK_NUM_CTX', "ignored, so the hardware tier's standby context is used"), undefined),
      embedModel: or<string | undefined>(read('FLINT_EMBED_MODEL', "ignored, so the tier table's embedding model is used"), undefined),
      tools: or<'auto' | 'on' | 'off'>(read('FLINT_LOCAL_TOOLS', 'the local model is offered no tools'), 'auto', 'off'),
      apiKey,
      connectTimeoutMs: or(read('FLINT_LOCAL_CONNECT_TIMEOUT_MS', `using ${DEFAULTS.connectTimeoutMs}`), DEFAULTS.connectTimeoutMs),
      firstTokenTimeoutMs: or(read('FLINT_LOCAL_FIRST_OUTPUT_TIMEOUT_MS', `using ${DEFAULTS.firstTokenTimeoutMs}`), DEFAULTS.firstTokenTimeoutMs),
      toolPassTimeoutMs: or(read('FLINT_LOCAL_TOOL_PASS_TIMEOUT_MS', `using ${DEFAULTS.toolPassTimeoutMs}`), DEFAULTS.toolPassTimeoutMs),
      requestTimeoutMs: or(read('FLINT_LOCAL_REQUEST_TIMEOUT_MS', `using ${DEFAULTS.requestTimeoutMs}`), DEFAULTS.requestTimeoutMs),
      idleTimeoutMs: or(read('FLINT_LOCAL_IDLE_TIMEOUT_MS', `using ${DEFAULTS.idleTimeoutMs}`), DEFAULTS.idleTimeoutMs),
      healthIntervalMs: or(read('FLINT_LOCAL_HEALTH_INTERVAL_MS', `using ${DEFAULTS.healthIntervalMs}`), DEFAULTS.healthIntervalMs),
    },
    hardwareTier: or<'auto' | HardwareTierId>(read('FLINT_HARDWARE_TIER', 'detecting the hardware instead'), 'auto'),
    problems,
  };
}

/**
 * Where the local model server is, for the wire in use: its origin, the most a
 * log may show of it, and whether it is this Mac. Undefined when that wire's
 * address was refused.
 */
export function localEndpoint(cfg: InferenceConfig): { origin: string; host: string; loopback: boolean; secure: boolean; basePath: string } | undefined {
  if (cfg.local.provider === 'openai') {
    const o = cfg.local.openai;
    return o ? { origin: o.origin, host: o.host, loopback: o.loopback, secure: o.secure, basePath: o.path } : undefined;
  }
  const o = cfg.local.ollama;
  return o ? { origin: o.origin, host: o.host, loopback: o.loopback, secure: o.secure, basePath: o.path } : undefined;
}

/**
 * May text that must stay local be sent to this address? This Mac always.
 * Another machine only when Will said it is his (FLINT_LOCAL_ALLOW_REMOTE=1),
 * and then only over https, unless he also said its network is private
 * (FLINT_LOCAL_ALLOW_INSECURE_REMOTE=1).
 */
export function addressIsLocal(at: { loopback: boolean; secure: boolean; host?: string } | undefined, cfg: Pick<InferenceConfig, 'local'>): boolean {
  // Through Node's env proxy, nothing is "this Mac": the request leaves this process for the proxy first.
  if (!at || viaProxy(at.host, cfg.local.proxy)) return false;
  return at.loopback || (cfg.local.allowRemote && (at.secure || cfg.local.allowInsecureRemote));
}

/**
 * May the helpers that always talk to Ollama's own address (OLLAMA_HOST: the
 * embedder, local memory extraction, the runtime's background calls) send it
 * text that must stay local? They are older than the modes and read
 * OLLAMA_HOST as it is, so in Local mode they would still send text to an
 * Ollama on another machine.
 *
 * This Mac: yes. Another machine: only when it is the local model server
 * itself, and Will said that server is his (FLINT_LOCAL_ALLOW_REMOTE, over
 * https or on a network he called private). The switch vouches for the model
 * server and for nothing else: with the local model on this Mac (or on some
 * third machine) and OLLAMA_HOST elsewhere, that Ollama is not "here", whatever
 * the switch says, and every sentence that says where things stay names only
 * what is true.
 */
export function ollamaIsLocal(cfg: Pick<InferenceConfig, 'local'>): boolean {
  const at = cfg.local.ollama;
  if (!at || viaProxy(at.host, cfg.local.proxy)) return false;
  if (at.loopback) return true;
  const server = cfg.local.provider === 'openai' ? cfg.local.openai : cfg.local.ollama;
  return server !== undefined && server.origin === at.origin && addressIsLocal(server, cfg);
}

/**
 * May a turn that must stay local use this endpoint? This Mac always; another
 * machine only when FLINT_LOCAL_ALLOW_REMOTE=1 says so. (In the cloud mode the
 * native wire reaches a remote OLLAMA_HOST as it always has; this is asked in
 * the local and hybrid modes.)
 */
export function endpointIsLocal(cfg: InferenceConfig): boolean {
  return addressIsLocal(localEndpoint(cfg), cfg);
}
