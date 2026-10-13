/**
 * The local brain, built on whichever wire the config names.
 *
 *  - `ollama` (the default): Ollama's own API through OllamaProvider, as
 *    before. It can set the context size per call, turn thinking off, hold a
 *    reply to a JSON schema with `format`, and recover tool calls a model wrote
 *    as text. Memory extraction, background calls and the runtime's triage all
 *    use this API with the same context, so Ollama never reloads the model
 *    between them and a chat.
 *  - `openai` (FLINT_LOCAL_PROVIDER=openai): LocalOpenAiProvider, for any
 *    OpenAI-compatible server (Ollama's /v1, llama.cpp). Chat completions has
 *    no field for a context size, so the server's own setting applies.
 *
 * Either way the local brain is on Will's hardware and never a paid vendor
 * (./local-model chooseLocalBrain): the wire changes how Flint talks to the
 * model server, not whose model answers.
 *
 * Which model, in this order:
 *  1. FLINT_LOCAL_MODEL, then OLLAMA_MODEL: Will named it;
 *  2. this machine's hardware tier's model (@flint/core HARDWARE_TIERS), when it
 *     is installed, in the LOCAL and HYBRID modes. There the monitor loads the
 *     chosen model ahead of any turn, and every turn has a deadline. In the
 *     cloud mode this step is skipped, so a setup nothing new was set for
 *     keeps answering with the model Ollama has in memory (`preferTier`);
 *  3. what the server already has: the chat model it has loaded, else the first
 *     one pulled (./local-model chooseLocalBrain, @flint/core pickOllamaModel);
 *  4. the tier's model anyway, reported as not downloaded with the command that
 *     gets it. Nothing here downloads a model.
 * A model that is already in memory keeps the context it is loaded with; the
 * tier's model, when Flint is the one to load it, gets the tier's context;
 * OLLAMA_NUM_CTX overrides both.
 *
 * What the model can do comes from the server's own report (the monitor asks
 * Ollama's /api/show), never from a guess: FLINT_LOCAL_TOOLS=auto offers tools
 * to a model the server says can call them, and to no other.
 *
 * Every request the brain makes goes through `guardedFetch` (./local-backend):
 * one origin, a path allowlist, no redirects, and a connect check.
 *
 * A second, small model is built beside it: the STANDBY, which answers while
 * the main one loads (./local-serve). FLINT_LOCAL_FALLBACK_MODEL names it, or
 * turns it off; unset, it is the hardware tier's standby. Same server, same
 * wire, thinking off, at its tier row's context. Both adapters are watched
 * (./local-serve observed), so the monitor learns from every turn.
 *
 * BOOT NEVER WAITS ON THE MODEL SERVER. `startLocalBrains` returns as soon as
 * there is a brain to hold: at once when a model is named, else after one pick
 * that is cut off by the clock (./local-model chooseLocalBrain). Everything
 * else happens behind a server that is already listening, and lands as a new
 * `LocalBrains` for the NEXT turn (`onChange`): this machine's tier, the tier's
 * model when it is installed, what kind of server an OpenAI-compatible address
 * is, the standby from the tier, the first look at the server, and, when the
 * server did not answer, asking it again until it does. Every one of those is
 * built by the same code as the first, so an adopted brain has the same guarded
 * fetch, deadlines, capability report and monitor as the one it replaces.
 *
 * A STAND-IN IS NEVER ASKED. While nothing names the model and the server has
 * not said what it has, the brain is `settled: false`: it holds the name the
 * server would be asked for, and a provider that refuses every call. Asking
 * Ollama for the stand-in would make Ollama load it, and the next pick would
 * then take it for the model Will runs.
 *
 * Kept free of index.ts so it is unit-testable (index.ts runs main() on import).
 */
import {
  FlintError,
  LocalOpenAiProvider,
  OllamaProvider,
  isOllamaCloudModel,
  localCapabilities,
  makeAiError,
  pickOllamaModel,
  DEFAULT_OLLAMA_MODEL,
  type HardwareTier,
  type ModelCapabilities,
  type OllamaProviderOptions,
  type ProviderAdapter,
} from '@flint/core';
import { endpointIsLocal, viaProxy, type InferenceConfig } from './inference-config';
import {
  DETECT_PATHS,
  OLLAMA_PATHS,
  PLACE_PATH,
  askPlace,
  detectServer,
  guardedFetch,
  llamaCppBackend,
  llamaCppPaths,
  ollamaBackend,
  openAiBackend,
  openAiPaths,
  withPlace,
  type GuardOptions,
  type LocalBackend,
  type ModelFacts,
  type ServerKind,
} from './local-backend';
import type { ListedModel, PlaceSaid } from './ollama-locality';
import { LocalMonitor, type Which } from './local-monitor';
import { LOCAL_MODEL_MAX_LEN, LOCAL_MODEL_RE, chooseLocalBrain, keepPickingLocal, liveOllamaOptions } from './local-model';
import { watcher } from './local-serve';
import { sameModel } from './memory-brain';

type Env = Record<string, string | undefined>;

export type Wire = 'ollama' | 'openai';

/**
 * Where a local model's name came from: `env` (FLINT_LOCAL_MODEL or
 * OLLAMA_MODEL), `tier` (this machine's hardware tier's model, installed),
 * `loaded` / `pulled` (what Ollama had), `server` (the first model another
 * server lists), `default` (nothing was named and the server offered none: a
 * guess, the tier's model, until the next restart), or `none` (no model is
 * known at all: an OpenAI-compatible server that lists nothing, or an address
 * config refused with no model named).
 */
export type ModelSource = 'env' | 'tier' | 'loaded' | 'pulled' | 'default' | 'server' | 'none';

/** What `model` holds when no model is known. Never shown as a model's name: `settled` is false with it. */
export const NO_LOCAL_MODEL = 'none';

/** One local model as main() uses it: the client that reaches it and what to ask for. */
export interface LocalBrainSpec {
  which: Which;
  provider: ProviderAdapter;
  model: string;
  /** `provider:model`, what observability records. */
  label: string;
  from: ModelSource;
  /** The context Flint asks the server for (the native wire's num_ctx). Undefined: the server decides. */
  numCtx: number | undefined;
  /**
   * What was settled, as the env the rest of the server reads (./local-model
   * LocalBrain.env): the model, and the context size when it was taken from a
   * loaded model. Memory extraction and background calls read these, so they
   * ask the same model with the same window.
   */
  env: { OLLAMA_MODEL: string; OLLAMA_NUM_CTX?: string };
  /**
   * False while the model is a stand-in: nothing names it and the server has
   * not said what it has (or lists nothing). A stand-in is never asked: its
   * provider refuses every call, the monitor holds it `unavailable (unsettled)`,
   * and a status never shows its name as the local model.
   */
  settled: boolean;
}

/** Why "local" would not mean this Mac. */
export type NotConfined = 'remote_host' | 'cloud_model' | 'config' | 'proxy';

export interface LocalBrains {
  cfg: InferenceConfig;
  wire: Wire;
  server: ServerKind | 'unknown';
  /** `host:port` of the model server and whether it is this Mac. Undefined when config refused its address. */
  endpoint: { host: string; loopback: boolean } | undefined;
  primary: LocalBrainSpec;
  /** The standby model, when one is configured (it may not be downloaded: the monitor says). */
  fallback?: LocalBrainSpec;
  backend: LocalBackend | undefined;
  /** One monitor for the life of the server: it follows the brain when the brain changes. */
  monitor: LocalMonitor;
  /**
   * May a turn that must stay on this Mac use the local brain? Not when its
   * server is another machine Will has not allowed, when its model is one of
   * Ollama's cloud models, or when config refused the address. The local and
   * hybrid modes ask this; the cloud mode uses the local brain as it always has.
   */
  confined: { ok: true } | { ok: false; why: NotConfined };
}

export interface BuildLocalDeps {
  cfg: InferenceConfig;
  env: Env;
  /**
   * Do the local deadlines apply to the call being made? False in the cloud
   * mode, which behaves as before, and for eval replays, which measure the
   * model they named however slow it is. Read on every call.
   */
  deadlinesOn: () => boolean;
  fetch?: typeof fetch;
  /** Injectable TCP connect check (tests: no real socket). */
  connect?: GuardOptions['connect'];
  log?: (msg: string) => void;
  now?: () => number;
  /** The boot-time pick's cut-off (./local-model LOCAL_PICK_CAP_MS) and the wait between later picks; tests shorten both. */
  pick?: { capMs?: number; wait?: (ms: number) => Promise<void> };
  /**
   * This machine's hardware tier (./hardware, @flint/core): the model to prefer
   * when none is named, and the standby. A promise when the machine is still
   * being looked at: nothing here waits for it before there is a brain to hold.
   */
  tier?: HardwareTier | undefined | Promise<HardwareTier | undefined>;
  /** One pass and no more: a server that does not answer is not asked again (the status command, tests). */
  once?: boolean;
  /** May the monitor load the main model again when it finds it has left memory (./local-monitor rewarm)? The local and hybrid modes. */
  rewarm?: () => boolean;
  /**
   * With no model named: does this machine's tier choose it (the tier's model
   * when it is installed, and never the tier's standby)? The local and hybrid
   * modes, where the monitor loads that model ahead of any turn and every turn
   * has a deadline. In the cloud mode the answer is no, and the choice is what
   * it always was: the model Ollama has loaded, else one it has pulled. Read
   * each time a choice is made. Left out: yes (tests, one-off callers).
   */
  preferTier?: () => boolean;
  /**
   * Told what the model server says it is, each time the monitor looks at it:
   * the address the brain is asked at, and either the rows of its model
   * listing as they came (it is an Ollama) or that it is no Ollama. The server
   * keeps it for ./policy (./ollama-locality): a model is on this Mac only on
   * its server's own word. Left out: nobody is told.
   */
  place?: (baseURL: string, said: PlaceSaid) => void;
  /**
   * Told when a look at the model server came back WITHOUT that answer (it
   * did not answer, or its listing failed): the address the brain is asked
   * at. What it said before does not stand through such a look
   * (./ollama-locality silent). Left out: nobody is told.
   */
  silent?: (baseURL: string) => void;
  /**
   * Is this model known to run somewhere else than the server at this address
   * (./ollama-locality runsElsewhere)? Such a model is never warmed. Left out:
   * none is.
   */
  elsewhere?: (baseURL: string, model: string) => boolean;
}

/** The local brain while the server runs: what the next turn uses, and when that changes. */
export interface LocalHandle {
  /** The local brain as the NEXT turn uses it. */
  current(): LocalBrains;
  /** Over when the first pass behind the boot is: the tier applied, the server looked at once. Never rejects. */
  ready: Promise<void>;
  /** Told after each change of the main or standby model, or of the server's kind. Never for the first build. */
  onChange(fn: (next: LocalBrains) => void): void;
  /**
   * The mode changed: with no model named, choose again by the rule now in
   * force (`preferTier`), and adopt the answer for the next turn when it is
   * another model. Does nothing when a model is named. Never rejects.
   */
  repick(): Promise<void>;
  /** End the background work (tests, the status command). */
  stop(): void;
}

/** How long a look at the server may take behind the boot (what it is, what it has). */
const BOOT_PROBE_MS = 2_000;
/** The window assumed for a model on the OpenAI wire when nothing says what it is. */
const UNKNOWN_CONTEXT = 4_096;

/** The context a model nothing is known about is run with (the standby's, when its tag is in no tier row). */
const DEFAULT_STANDBY_CONTEXT = 4_096;

/**
 * The context to run the standby model at: FLINT_LOCAL_FALLBACK_NUM_CTX when
 * Will set one; else what this MACHINE's hardware tier gives a standby
 * (`fallbackContextLength`: 8,192 where there is memory for a second model at
 * that size), whichever model it is; else, with the machine not yet looked at,
 * 4,096. Ollama clamps it to the model's own maximum, and the monitor and the
 * prompt's size follow what it really gets.
 */
export function standbyContext(cfg: Pick<InferenceConfig, 'local'>, tier: HardwareTier | undefined): number {
  return cfg.local.fallbackNumCtx ?? tier?.fallbackContextLength ?? DEFAULT_STANDBY_CONTEXT;
}

/**
 * Which model stands by, or undefined for none: FLINT_LOCAL_FALLBACK_MODEL (a
 * model, or `off`), else the hardware tier's standby on an Ollama server (a
 * tier's tag means nothing to another server). A standby that is the main
 * model is no standby.
 */
export function standbyModel(cfg: InferenceConfig, tier: HardwareTier | undefined, server: ServerKind | 'unknown', primaryModel: string, log: (m: string) => void = () => {}): { model: string; from: ModelSource } | undefined {
  if (cfg.local.fallbackModel === 'off') return undefined;
  const model = cfg.local.fallbackModel ?? (server === 'ollama' ? tier?.fallbackModel : undefined);
  if (!model) return undefined;
  if (sameModel(model, primaryModel)) {
    log('[local] the standby model is the main model, so there is no standby (set FLINT_LOCAL_FALLBACK_MODEL to a smaller one)');
    return undefined;
  }
  return { model, from: cfg.local.fallbackModel ? 'env' : 'tier' };
}

/** May this model be offered tools: `on` and `off` decide; `auto` is the server's own report, when it has one. */
export function toolsAllowed(setting: InferenceConfig['local']['tools'], facts: ModelFacts | undefined): boolean | undefined {
  if (setting === 'on') return true;
  if (setting === 'off') return false;
  return facts?.tools;
}

const positiveInt = (n: unknown): number | undefined => (typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : undefined);

/** A provider that refuses every call at once, with one fixed error, and never touches the network. */
function refusingProvider(name: string, error: () => ReturnType<typeof makeAiError>): ProviderAdapter {
  return {
    name,
    getCapabilities: () => localCapabilities({ contextTokens: UNKNOWN_CONTEXT, tools: false }),
    estimateTokens: (messages) => Math.ceil(messages.reduce((n, m) => n + m.content.length, 0) / 4),
    generate: () => Promise.reject(new FlintError(error())),
    async *stream() {
      yield { type: 'error', error: error() };
    },
  };
}

/**
 * A stand-in for a local brain whose address config refused. The server still
 * starts (a bad value never takes Flint down); every local call fails at once
 * with an error that says the address was refused, and names nothing else.
 */
export function disabledProvider(): ProviderAdapter {
  return refusingProvider('local', () =>
    makeAiError('provider_unavailable', "The local model server's address was refused by config, so the local provider is off", { retryable: false, providerCode: 'config' }),
  );
}

/** `providerCode` of a call made while the local model is a stand-in. */
export const UNSETTLED = 'local_model_unsettled';

/**
 * The provider of a brain that is not settled: every call is refused at once,
 * and nothing is sent. `name` is the wire's own (`ollama`, `local`), so what
 * reads the provider's name sees the wire it will be on.
 */
export function unsettledProvider(name: string): ProviderAdapter {
  return refusingProvider(name, () => makeAiError('provider_unavailable', 'No local model is chosen yet: the local model server has not answered', { retryable: false, providerCode: UNSETTLED }));
}

/** The one model a brain is to be built on, and how sure that is. */
interface Choice {
  model: string;
  from: ModelSource;
  settled: boolean;
  /** Native wire: the client's options (address, context, think), as ./local-model settles them. */
  options?: OllamaProviderOptions;
  env: LocalBrainSpec['env'];
}

/** A model id as a server gave it, when it is one a log and a status may carry: a tag's characters, a tag's length. */
export function safeModelId(id: unknown): string | undefined {
  if (typeof id !== 'string') return undefined;
  const m = id.trim();
  return m.length > 0 && m.length <= LOCAL_MODEL_MAX_LEN && LOCAL_MODEL_RE.test(m) ? m : undefined;
}

/**
 * Start the local brain: choose the wire, build the first brain, and return.
 * The rest (this machine's tier, what the server is and has, the first look at
 * it, asking again when it is silent) runs behind the caller, and each change
 * is a whole new `LocalBrains` for the next turn. Never throws.
 *
 * It waits for one thing only, and only when no model is named on Ollama's own
 * API: the pick, which the clock cuts off (LOCAL_PICK_CAP_MS).
 */
export async function startLocalBrains(deps: BuildLocalDeps): Promise<LocalHandle> {
  const { cfg, env } = deps;
  const log = deps.log ?? (() => {});
  const quiet = (): void => {};
  const wire: Wire = cfg.local.provider;
  const connectTimeoutMs = (): number | undefined => (deps.deadlinesOn() ? cfg.local.connectTimeoutMs : undefined);
  const guard = (origin: string, paths: readonly string[]): typeof fetch =>
    guardedFetch({ origin, paths, connectTimeoutMs, ...(deps.fetch ? { fetch: deps.fetch } : {}), ...(deps.connect ? { connect: deps.connect } : {}) });

  // What the base's helpers read (./local-model), holding only values the config schema passed.
  // A cloud tag in OLLAMA_MODEL names no local model, on either wire: the server is asked what it has, as if nothing were named.
  const namedRaw = cfg.local.model ?? cfg.local.ollamaModel;
  const cloudNamed = !!namedRaw && isOllamaCloudModel(namedRaw);
  const named = cloudNamed ? undefined : namedRaw;
  if (cloudNamed) log("[brain] OLLAMA_MODEL is an Ollama cloud model, which runs on Ollama's servers: it is not used as the local brain");
  const envSan: Env = { ...env };
  if (named) envSan.OLLAMA_MODEL = named;
  else delete envSan.OLLAMA_MODEL;
  if (cfg.local.numCtx !== undefined) envSan.OLLAMA_NUM_CTX = String(cfg.local.numCtx);
  else delete envSan.OLLAMA_NUM_CTX;
  // ...and the address as config checked it, with `localhost` pinned to 127.0.0.1: every request this
  // module makes goes to that address, and the guarded fetch refuses any other.
  if (cfg.local.ollama) envSan.OLLAMA_HOST = `${cfg.local.ollama.origin}${cfg.local.ollama.path}`;

  // One monitor for the life of the server. It is pointed at each brain as it is built.
  const monitor = new LocalMonitor({
    backend: undefined,
    primary: NO_LOCAL_MODEL,
    primarySettled: false,
    intervalMs: cfg.local.healthIntervalMs,
    log,
    ...(deps.rewarm ? { rewarm: deps.rewarm } : {}),
    // A model its server says runs somewhere else is never loaded ahead of a turn (the standby as much as the main one).
    ...(deps.elsewhere ? { mayWarm: (m: string) => !deps.elsewhere!(wire === 'ollama' ? `${cfg.local.ollama?.origin ?? ''}${cfg.local.ollama?.path ?? ''}` : (cfg.local.openai?.baseURL ?? ''), m) } : {}),
    ...(deps.now ? { now: deps.now } : {}),
  });
  // What the monitor learned about a model. A model nobody has asked about yet sets off a look, off the turn's path.
  const factsOf = (model: string): ModelFacts | undefined => {
    const facts = monitor.facts(model);
    if (!facts) monitor.checkSoon();
    return facts;
  };
  // The deadlines are read per call: on in the local and hybrid modes, off in the cloud mode and for an eval replay.
  const deadlines = {
    firstTokenTimeoutMs: (): number | undefined => (deps.deadlinesOn() ? cfg.local.firstTokenTimeoutMs : undefined),
    toolPassTimeoutMs: (): number | undefined => (deps.deadlinesOn() ? cfg.local.toolPassTimeoutMs : undefined),
    requestTimeoutMs: (): number | undefined => (deps.deadlinesOn() ? cfg.local.requestTimeoutMs : undefined),
    idleTimeoutMs: (): number | undefined => (deps.deadlinesOn() ? cfg.local.idleTimeoutMs : undefined),
  };
  // Every local adapter is watched: the monitor learns from each turn, and the turn learns its time to first
  // token. Ollama's own API says when a reply's first line arrives (its whole passes yield nothing until the
  // reply is in); the OpenAI-compatible wire streams every pass, so its first event is the first token.
  const watching = (which: Which, timedBy: 'events' | 'callback') => watcher(which, () => monitor, deps.now, timedBy);

  let tier: HardwareTier | undefined = deps.tier && !(deps.tier instanceof Promise) ? deps.tier : undefined;
  /** What an OpenAI-compatible address turned out to be; the config's own word until it is asked. */
  let kind: ServerKind = cfg.local.server === 'auto' ? 'openai' : cfg.local.server;

  // ---- the two wires, each as: where it is, how a model is asked, and how a brain is made of a choice

  const ollamaAt = wire === 'ollama' ? cfg.local.ollama : undefined;
  const openaiAt = wire === 'openai' ? cfg.local.openai : undefined;
  const nativeFetch = ollamaAt ? guard(ollamaAt.origin, OLLAMA_PATHS.map((p) => `${ollamaAt.path}${p}`)) : undefined;
  // What the model server says it is, and where each of its models runs, is kept for ./policy (./ollama-locality),
  // under the address the brain itself is asked at. Told at every look the monitor takes.
  const placeOf = (baseURL: string) => (said: PlaceSaid): void => deps.place?.(baseURL, said);
  // ...and so is a look that came back without its answer: what it said before does not stand through it.
  const silentAt = (baseURL: string) => (): void => deps.silent?.(baseURL);
  const nativeBackend =
    ollamaAt && nativeFetch
      ? ollamaBackend(`${ollamaAt.origin}${ollamaAt.path}`, nativeFetch, (rows) => placeOf(`${ollamaAt.origin}${ollamaAt.path}`)({ ollama: [...rows] as ListedModel[] }), silentAt(`${ollamaAt.origin}${ollamaAt.path}`))
      : undefined;
  // One guarded fetch and one backend per kind of server, so a rebuild that changes nothing hands the monitor the backend it has.
  const openaiSites = new Map<ServerKind, { f: typeof fetch; backend: LocalBackend }>();
  const openaiSite = (k: ServerKind): { f: typeof fetch; backend: LocalBackend } | undefined => {
    if (!openaiAt) return undefined;
    let site = openaiSites.get(k);
    if (!site) {
      // (The listing only an Ollama gives is asked of every kind: PLACE_PATH is on every list.)
      const f = guard(openaiAt.origin, [...new Set([...openAiPaths(openaiAt.path), PLACE_PATH, ...(k === 'ollama' ? OLLAMA_PATHS : k === 'llamacpp' ? llamaCppPaths(openaiAt.path) : [])])]);
      const told = placeOf(openaiAt.baseURL);
      const key: Record<string, string> = cfg.local.apiKey ? { authorization: `Bearer ${cfg.local.apiKey}` } : {};
      // What kind of server this is was read off what answered at boot, or off FLINT_LOCAL_SERVER, and either can be
      // wrong: an Ollama taken for a plain OpenAI-compatible server serves cloud models under plain names all the
      // same. So whatever the kind, every look asks the server whether it is an Ollama, and tells ./policy.
      const backend =
        k === 'ollama'
          ? ollamaBackend(openaiAt.origin, f, (rows) => told({ ollama: [...rows] as ListedModel[] }), silentAt(openaiAt.baseURL))
          : withPlace(k === 'llamacpp' ? llamaCppBackend(openaiAt.origin, openaiAt.path, f) : openAiBackend(openaiAt.origin, openaiAt.path, f, cfg.local.apiKey), (signal) => askPlace(f, openaiAt.origin, signal, key), told, silentAt(openaiAt.baseURL));
      site = { f, backend };
      openaiSites.set(k, site);
    }
    return site;
  };

  /** The standby's name as far as it is known: Will's, else the tier's. The pick never takes it for the main model. */
  const standbyName = (): string | undefined => (cfg.local.fallbackModel === 'off' ? undefined : cfg.local.fallbackModel ?? tier?.fallbackModel);
  const notTheStandby = (name: string): boolean => {
    const spare = standbyName();
    return spare !== undefined && sameModel(name, spare);
  };
  /** Does this machine's tier choose the unnamed model right now (BuildLocalDeps.preferTier)? */
  const tierChooses = (): boolean => deps.preferTier?.() !== false;
  /** Ollama's own answer to "which model", as a choice; a name that is not a model's name is no answer. */
  const pickNative = async (say: (m: string) => void): Promise<Choice> => {
    const b = await chooseLocalBrain(envSan, {
      fetch: nativeFetch!,
      log: say,
      // (In the cloud mode the standby is never asked, so there is nothing to keep apart: the pick is as it always was.)
      ...(tierChooses() ? { skip: notTheStandby } : {}),
      ...(deps.pick?.capMs !== undefined ? { capMs: deps.pick.capMs } : {}),
      ...(tier ? { defaultModel: tier.model } : {}),
    });
    if (safeModelId(b.model) === undefined) {
      saidOnce('[brain] the model server listed a model whose name is not a model name: set OLLAMA_MODEL');
      const model = tier?.model ?? DEFAULT_OLLAMA_MODEL;
      return { model, from: 'default', settled: false, options: liveOllamaOptions({ ...envSan, OLLAMA_MODEL: model }), env: { OLLAMA_MODEL: model } };
    }
    return { model: b.model, from: b.from, settled: b.settled, options: b.options, env: b.env };
  };

  /** A choice on Ollama's own API, settled as ./local-model settles a named model: its options, and the env the rest of the server reads. */
  const nativeChoice = async (model: string, from: ModelSource, settled: boolean, more: { numCtx?: number } = {}): Promise<Choice> => {
    const asEnv: Env = { ...envSan, OLLAMA_MODEL: model, ...(more.numCtx !== undefined ? { OLLAMA_NUM_CTX: String(more.numCtx) } : {}) };
    const b = await chooseLocalBrain(asEnv, { log: quiet }); // a named model: no request is made
    return { model, from, settled, options: b.options, env: { OLLAMA_MODEL: model, ...(more.numCtx !== undefined ? { OLLAMA_NUM_CTX: String(more.numCtx) } : {}) } };
  };

  /** Build a whole `LocalBrains` from a choice. No request is made here. */
  const make = (choice: Choice): LocalBrains => {
    let server: ServerKind | 'unknown' = 'unknown';
    let backend: LocalBackend | undefined;
    let endpoint: LocalBrains['endpoint'];
    let primary: LocalBrainSpec;
    let fallback: LocalBrainSpec | undefined;
    let confinedWhy: NotConfined | undefined;
    const refused = (): LocalBrainSpec => ({
      which: 'primary',
      provider: disabledProvider(),
      model: named ?? NO_LOCAL_MODEL,
      label: `local:${named ?? NO_LOCAL_MODEL}`,
      from: named ? 'env' : 'none',
      numCtx: undefined,
      env: { OLLAMA_MODEL: named ?? NO_LOCAL_MODEL },
      settled: !!named,
    });

    if (wire === 'ollama') {
      if (!ollamaAt || !nativeFetch || !nativeBackend) {
        primary = refused();
        confinedWhy = 'config';
      } else {
        server = 'ollama';
        backend = nativeBackend;
        endpoint = { host: ollamaAt.host, loopback: ollamaAt.loopback };
        // (The address is the checked one, whatever an options object built from the raw env says.)
        const options: OllamaProviderOptions = { ...(choice.options ?? liveOllamaOptions({ ...envSan, OLLAMA_MODEL: choice.model })), baseURL: `${ollamaAt.origin}${ollamaAt.path}` };
        const numCtx = positiveInt(options.defaultOptions?.num_ctx);
        const native = (o: OllamaProviderOptions, which: Which): ProviderAdapter => {
          const w = watching(which, 'callback');
          return w.provider(
            new OllamaProvider({
              ...o,
              fetch: nativeFetch,
              // The server's own report wins over the built-in table; a model it says cannot call tools is not sent any.
              capabilities: (m): Partial<ModelCapabilities> | undefined => {
                const facts = factsOf(m);
                const tools = toolsAllowed(cfg.local.tools, facts);
                // The model's own maximum context bounds the window (Ollama gives no more, whatever num_ctx asks).
                const most = facts?.contextLength;
                if (tools === undefined && most === undefined) return undefined;
                return { ...(tools === undefined ? {} : { toolCalling: tools ? ('native' as const) : ('unsupported' as const) }), ...(most !== undefined ? { maxContextTokens: most } : {}) };
              },
              ...deadlines,
              onFirstOutput: w.onFirstOutput,
            }),
          );
        };
        // A stand-in is never asked: Ollama would load it, and the next pick would take it for the model Will runs.
        const provider = choice.settled ? native(options, 'primary') : unsettledProvider('ollama');
        primary = { which: 'primary', provider, model: choice.model, label: `${provider.name}:${choice.model}`, from: choice.from, numCtx, env: choice.env, settled: choice.settled };
        const spare = standbyModel(cfg, tier, server, choice.model, saidOnce);
        if (spare) {
          // The same server and wire; thinking off (harmless on a model that cannot think) and its own, small window.
          const ctx = standbyContext(cfg, tier);
          const standby = native({ ...(options.baseURL ? { baseURL: options.baseURL } : {}), defaultOptions: { num_ctx: ctx }, think: false }, 'fallback');
          fallback = { which: 'fallback', provider: standby, model: spare.model, label: `${standby.name}:${spare.model}`, from: spare.from, numCtx: ctx, env: { OLLAMA_MODEL: spare.model, OLLAMA_NUM_CTX: String(ctx) }, settled: true };
        }
      }
    } else {
      const site = openaiSite(kind);
      if (!openaiAt || !site) {
        primary = refused();
        confinedWhy = 'config';
      } else {
        const f = site.f;
        endpoint = { host: openaiAt.host, loopback: openaiAt.loopback };
        server = kind;
        backend = site.backend;
        // Chat completions cannot set a context size: this number only sizes Flint's own history budget.
        const envCtx = cfg.local.numCtx;
        const openai = (which: Which): ProviderAdapter =>
          watching(which, 'events').provider(
            new LocalOpenAiProvider({
              baseURL: openaiAt.baseURL,
              allowRemote: cfg.local.allowRemote,
              ...(cfg.local.apiKey ? { apiKey: cfg.local.apiKey } : {}),
              fetch: f,
              ...deadlines,
              capabilities: (m) => {
                const facts = factsOf(m);
                // The context the server has the model loaded with, when it says; llama.cpp's own setting; else what
                // the env says for the main model, and a small window for any other (the standby).
                const context = monitor.contextLength(m) ?? (kind === 'llamacpp' ? facts?.contextLength : undefined) ?? (sameModel(m, choice.model) ? envCtx : undefined) ?? UNKNOWN_CONTEXT;
                return localCapabilities({ contextTokens: context, tools: toolsAllowed(cfg.local.tools, facts) === true, ...(facts?.vision ? { vision: true } : {}) });
              },
            }),
          );
        const provider = choice.settled ? openai('primary') : unsettledProvider('local');
        primary = { which: 'primary', provider, model: choice.model, label: `${provider.name}:${choice.model}`, from: choice.from, numCtx: undefined, env: { OLLAMA_MODEL: choice.model }, settled: choice.settled };
        const spare = standbyModel(cfg, tier, server, choice.model, saidOnce);
        if (spare) {
          const standby = openai('fallback');
          fallback = { which: 'fallback', provider: standby, model: spare.model, label: `${standby.name}:${spare.model}`, from: spare.from, numCtx: undefined, env: { OLLAMA_MODEL: spare.model }, settled: true };
        }
      }
    }

    // Node's env proxy carries a request to this address out of this process first, loopback included.
    if (!confinedWhy && endpoint && viaProxy(endpoint.host, cfg.local.proxy)) confinedWhy = 'proxy';
    if (!confinedWhy && !endpointIsLocal(cfg)) confinedWhy = 'remote_host';
    if (!confinedWhy && primary.settled && isOllamaCloudModel(primary.model)) confinedWhy = 'cloud_model';

    monitor.retarget({
      backend,
      primary: { model: primary.model, numCtx: primary.numCtx, settled: primary.settled },
      ...(fallback ? { fallback: { model: fallback.model, numCtx: fallback.numCtx } } : {}),
    });
    return { cfg, wire, server, endpoint, primary, ...(fallback ? { fallback } : {}), backend, monitor, confined: confinedWhy ? { ok: false, why: confinedWhy } : { ok: true } };
  };

  // A line that would otherwise be said by every rebuild (the standby is the main model) is said once.
  const said = new Set<string>();
  const saidOnce = (m: string): void => {
    if (said.has(m)) return;
    said.add(m);
    log(m);
  };

  // ---- the first brain: at once when a model is named, else after the one pick the clock cuts off

  let choice: Choice;
  if (wire === 'ollama') {
    if (!ollamaAt || !nativeFetch) choice = { model: named ?? NO_LOCAL_MODEL, from: named ? 'env' : 'none', settled: !!named, env: { OLLAMA_MODEL: named ?? NO_LOCAL_MODEL } };
    else {
      // FLINT_LOCAL_MODEL, then OLLAMA_MODEL; with neither, what Ollama has (chooseLocalBrain), and its default as a stand-in
      // when it does not answer. The tier's model, when it is installed, comes behind the boot (settleOnce).
      choice = await pickNative(log);
    }
  } else if (named) choice = { model: named, from: 'env', settled: true, env: { OLLAMA_MODEL: named } };
  else choice = { model: NO_LOCAL_MODEL, from: 'none', settled: false, env: { OLLAMA_MODEL: NO_LOCAL_MODEL } };

  let brains = make(choice);
  const listeners: Array<(next: LocalBrains) => void> = [];
  let stopped = false;
  /** Swap in a brain built from `next`, for the next turn, and tell whoever holds the old one. */
  const tell = (): void => {
    for (const fn of listeners) {
      try {
        fn(brains);
      } catch {
        /* a listener's failure is its own (index.ts catches and logs it); the brain is adopted all the same */
      }
    }
  };
  const adopt = (next: Choice): void => {
    if (stopped) return;
    choice = next;
    brains = make(next);
    tell();
  };
  const sameChoice = (a: Choice, b: Choice): boolean =>
    sameModel(a.model, b.model) && a.settled === b.settled && positiveInt(a.options?.defaultOptions?.num_ctx) === positiveInt(b.options?.defaultOptions?.num_ctx);

  // ---- behind the boot

  /** With no model named: the whole precedence, asked of the server now. Never throws. */
  const decide = async (): Promise<Choice> => {
    if (wire === 'ollama') {
      if (!nativeBackend || !nativeFetch) return choice;
      const preferred = tierChooses() ? await tierModelIfInstalled(nativeBackend, tier, envSan) : undefined;
      if (preferred) return nativeChoice(preferred.model, 'tier', true, preferred.numCtx !== undefined ? { numCtx: preferred.numCtx } : {});
      return pickNative(quiet);
    }
    const site = openaiSite(kind);
    if (!openaiAt || !site) return choice;
    const found = await serverModel(kind, openaiAt.origin, openaiAt.path, site.f, site.backend, tier, notTheStandby);
    return found ? { model: found.model, from: found.from, settled: true, env: { OLLAMA_MODEL: found.model } } : choice;
  };

  /** One pass: the tier, the server's kind, the tier's model, the standby, and a look at the server. */
  const settleOnce = async (): Promise<void> => {
    if (deps.tier instanceof Promise) tier = await deps.tier.catch(() => undefined);
    if (stopped) return;
    const before = brains;
    let next = choice;
    if (wire === 'openai' && openaiAt && cfg.local.server === 'auto') {
      kind = await detectServer(openaiAt.origin, guard(openaiAt.origin, DETECT_PATHS), AbortSignal.timeout(BOOT_PROBE_MS), 'openai');
    }
    if (!named) {
      if (wire === 'ollama' && nativeBackend) {
        // The tier's model comes before what Ollama happens to have, when it is installed: in the local and hybrid
        // modes. In the cloud mode the model Ollama has loaded stays the choice, as it always was, so no turn there is
        // the request that loads another model, with no deadline on it.
        const byTier = tierChooses();
        const preferred = byTier ? await tierModelIfInstalled(nativeBackend, tier, envSan) : undefined;
        if (preferred) next = await nativeChoice(preferred.model, 'tier', true, preferred.numCtx !== undefined ? { numCtx: preferred.numCtx } : {});
        // The boot's pick took the tier's standby (it did not know the tier yet): the standby is not the model Will runs.
        else if (byTier && choice.settled && choice.from !== 'default' && notTheStandby(choice.model)) next = await pickNative(quiet);
        // Nothing was named and Ollama offered none (or has not answered): the guess is the tier's model, not the smallest GPU tier's.
        else if (choice.from === 'default' && tier && !sameModel(tier.model, choice.model)) next = await nativeChoice(tier.model, 'default', choice.settled);
      } else if (wire === 'openai') {
        next = await decide();
      }
    }
    if (stopped) return;
    const changed = !sameChoice(next, choice) || next.from !== choice.from;
    if (changed && next.settled) log(chosenLine(next, tier, 'no local model is named'));
    // The stand-in got this machine's tier's name: said, because the boot line named another and /health names this one.
    else if (!next.settled && !sameModel(next.model, choice.model)) log(`[brain] the stand-in is now ${next.model}, this machine's hardware tier's model: it is the name /health shows until the model server answers, and it is never asked`);
    // A rebuild also when only the tier or the server's kind landed: the standby and the backend come from them.
    choice = next;
    const rebuilt = make(next);
    const moved =
      !sameModel(rebuilt.primary.model, before.primary.model) ||
      rebuilt.primary.settled !== before.primary.settled ||
      rebuilt.primary.from !== before.primary.from ||
      rebuilt.primary.numCtx !== before.primary.numCtx ||
      rebuilt.fallback?.model !== before.fallback?.model ||
      rebuilt.fallback?.numCtx !== before.fallback?.numCtx ||
      rebuilt.server !== before.server;
    // Nothing a turn could tell apart changed: whoever holds the first brain keeps it (the monitor already follows it).
    brains = moved ? rebuilt : before;
    if (moved) tell();
    // One look now, for the boot log and so the first turn knows what the model can do.
    const first = await monitor.check();
    log(
      `[local] provider=${wire} wire=${wire === 'ollama' ? 'native' : 'openai-compatible'} server=${brains.server}${first.version ? ` ${first.version}` : ''} ` +
        `host=${brains.endpoint?.host ?? 'refused'} loopback=${brains.endpoint ? (brains.endpoint.loopback ? 'yes' : 'no') : 'n/a'}`,
    );
    if (!brains.confined.ok && brains.confined.why === 'proxy') {
      log("[local] Node's env proxy is on (NODE_USE_ENV_PROXY) and NO_PROXY does not name the local model server's host: requests to it go through the proxy, so a turn that must stay on this Mac will not use it (add the host to NO_PROXY)");
    } else if (!brains.confined.ok && brains.confined.why === 'remote_host') {
      log('[local] the local model server is not this Mac: the local and hybrid modes will not use it unless FLINT_LOCAL_ALLOW_REMOTE=1');
    } else if (!brains.confined.ok && brains.confined.why === 'cloud_model') {
      log("[local] the local model is an Ollama cloud model, which runs on Ollama's servers: the local and hybrid modes will not use it");
    }
    if (!brains.primary.settled && wire === 'openai' && brains.backend) log('[brain] no local model is named and the server has not listed one: local turns wait until it does (or set FLINT_LOCAL_MODEL)');
  };

  let picking: { stop: () => void } | undefined;
  const ready = settleOnce()
    .catch(() => undefined)
    .then(() => {
      // The server did not say what it has: it is asked again, quietly, until it does. Its answer is the brain for the next turn.
      if (stopped || deps.once || choice.settled || !brains.backend) return;
      picking = keepPickingLocal<Choice>(
        envSan,
        (next) => {
          log(chosenLine(next, tier, 'the model server is answering now'));
          adopt(next);
          void monitor.check().catch(() => {});
        },
        { choose: decide, ...(deps.pick?.wait ? { wait: deps.pick.wait } : {}) },
      );
    });

  // ---- a change of mode: the rule for an unnamed model is the mode's (preferTier), so it is asked again
  let repicking: Promise<void> | undefined;
  const repick = (): Promise<void> => {
    if (stopped || named || wire !== 'ollama' || !nativeBackend) return Promise.resolve();
    repicking ??= ready
      .then(async () => {
        if (stopped) return;
        const next = await decide();
        // An Ollama that does not answer right now changes nothing: the brain in use stays.
        if (stopped || !next.settled || (sameChoice(next, choice) && next.from === choice.from)) return;
        log(chosenLine(next, tier, 'the mode changed'));
        adopt(next);
      })
      .catch(() => undefined)
      .finally(() => {
        repicking = undefined;
      });
    return repicking;
  };

  return {
    current: () => brains,
    ready,
    repick,
    onChange: (fn) => void listeners.push(fn),
    stop: () => {
      stopped = true;
      picking?.stop();
      monitor.close();
    },
  };
}

/** One log line for a model that was chosen without being named: which, and where its name came from. */
function chosenLine(c: Choice, tier: HardwareTier | undefined, why: string): string {
  switch (c.from) {
    case 'tier':
      return `[brain] ${why}: the local brain is ${c.model}, this machine's hardware tier's model${tier ? ` (${tier.label})` : ''}; the next turn uses it`;
    case 'server':
      return `[brain] ${why}: the local brain is the first model the server lists (set FLINT_LOCAL_MODEL to choose another); the next turn uses it`;
    case 'default':
      return `[brain] ${why}, and the server lists no chat model: the local brain is ${c.model} until the next restart (run "ollama pull ${c.model}", or set OLLAMA_MODEL)`;
    default:
      return `[brain] ${why}: the local brain is ${c.model}, which the server has ${c.from}; the next turn uses it`;
  }
}

/**
 * Build the local brain and wait for its first pass: the tier applied, the
 * server asked what it is and has, and one look taken. For a caller that wants
 * the settled answer once (tests); the server uses `startLocalBrains`, which
 * does not wait.
 */
export async function buildLocalBrains(deps: BuildLocalDeps): Promise<LocalBrains> {
  const handle = await startLocalBrains({ ...deps, once: true });
  await handle.ready;
  return handle.current();
}

/**
 * The model to ask for on the OpenAI wire when none is named: on Ollama, this
 * machine's tier's model when it is installed, else the chat model it has
 * loaded or pulled (as on the native wire), else the tier's model as a guess;
 * on any other server, the first one it lists, when that is a name a log may
 * carry. Undefined when the server does not answer or lists nothing usable.
 */
async function serverModel(
  kind: ServerKind,
  origin: string,
  basePath: string,
  f: typeof fetch,
  backend: LocalBackend,
  tier: HardwareTier | undefined,
  skip: (name: string) => boolean,
): Promise<{ model: string; from: ModelSource } | undefined> {
  if (kind === 'ollama') {
    if (tier && (await installed(backend, tier.model))) return { model: tier.model, from: 'tier' };
    const picked = await pickOllamaModel({ baseURL: origin, fetch: f, skip });
    if (picked.from === 'default') return picked.answered ? { model: tier?.model ?? DEFAULT_OLLAMA_MODEL, from: 'default' } : undefined;
    const model = safeModelId(picked.model);
    return model ? { model, from: picked.from } : undefined;
  }
  try {
    const res = await f(`${origin}${basePath}/models`, { signal: AbortSignal.timeout(BOOT_PROBE_MS) });
    const data = res.ok ? ((await res.json()) as { data?: Array<{ id?: unknown }> }).data : undefined;
    // The first id that is a name a log and a status may carry: a server's own string is never passed on unchecked.
    const id = Array.isArray(data)
      ? data
          .slice(0, 200)
          .map((d) => safeModelId(d?.id))
          .find((x): x is string => x !== undefined && !skip(x))
      : undefined;
    if (id) return { model: id, from: 'server' };
  } catch {
    /* no answer: asked again later */
  }
  return undefined;
}

/** Does the server have this model installed? One look; false when it cannot be asked. */
async function installed(backend: LocalBackend, model: string): Promise<boolean> {
  try {
    const seen = await backend.probe([model], AbortSignal.timeout(BOOT_PROBE_MS));
    return seen.reachable && seen.models[model]?.installed === true;
  } catch {
    return false;
  }
}

/**
 * Step 2 of the model's precedence, on Ollama's own API: with no model named,
 * this machine's hardware tier's model when Ollama has it installed, and the
 * context to ask for it with:
 *  - OLLAMA_NUM_CTX when Will set one (undefined here: the env already says);
 *  - else the context the model is already in memory with (asking with another
 *    would make Ollama reload it);
 *  - else the tier's own context length.
 * Undefined when there is no tier, the server does not answer, or it does not have the model.
 */
async function tierModelIfInstalled(backend: LocalBackend, tier: HardwareTier | undefined, env: Env): Promise<{ model: string; numCtx: number | undefined } | undefined> {
  if (!tier) return undefined;
  let seen: Awaited<ReturnType<LocalBackend['probe']>>;
  try {
    seen = await backend.probe([tier.model], AbortSignal.timeout(BOOT_PROBE_MS));
  } catch {
    return undefined;
  }
  const row = seen.models[tier.model];
  if (!seen.reachable || row?.installed !== true) return undefined;
  const own = env.OLLAMA_NUM_CTX?.trim();
  return { model: tier.model, numCtx: own ? undefined : row.loaded === true && row.contextLength !== undefined ? row.contextLength : tier.contextLength };
}
