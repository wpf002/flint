/**
 * What Flint is running on, as one object: the routing mode, this machine's
 * hardware tier and the model it recommends, the local model that was chosen
 * and its state, the standby and the embedding model, and whether a cloud
 * model is configured. Three faces show it: `GET /inference`
 * (./inference-routes), the status command (scripts/inference-status.ts), and
 * Settings in the console.
 *
 * Two of those faces are for different readers, and the object carries both:
 *
 *  - `lines` is the facts as sentences for the COMMAND LINE. It names a model
 *    by its exact tag, a refused setting by its key, and gives the `ollama
 *    pull` line with the size of the download.
 *  - `name`, `sentence` and `notices` are for the CONSOLE. A model is shown by
 *    its display name (@flint/core modelDisplayName), never its tag; a refused
 *    setting is a plain sentence with no key in it; and each sentence is true
 *    for the mode Flint is in (the standby "answers while the main model
 *    loads" only where a mode uses it). The console shows what it is given: the
 *    wording lives here, under test, and not in a second copy in the page.
 *
 * It never holds the API key, a token, or more of an address than `host:port`.
 *
 * Kept free of index.ts so it is unit-testable (index.ts runs main() on import).
 */
import { isTopTier, modelDisplayName, modelDownloadGb, usableMemoryGb, type Accelerator, type HardwareTier, type HardwareTierId } from '@flint/core';
import type { Hardware } from './hardware';
import type { ConfigKey, ConfigProblem, InferenceMode, UrlProblem } from './inference-config';
import type { ModeSource } from './inference-mode';
import type { LocalBrains, ModelSource, NotConfined, Wire } from './local-brains';
import type { ServerKind } from './local-backend';
import { pullCommand, type LocalSnapshot, type LocalState, type ModelHealth, type UnavailableWhy } from './local-monitor';

/** One local model, as a status shows it. */
export interface ModelStatus {
  /**
   * The model's tag, for the command line and the download command. Absent
   * when no model is chosen yet: nothing names one and the server has not said
   * what it has. A stand-in's name is never shown.
   */
  model?: string;
  /** The model as the console names it ("Muse Glimmer 30B"). Absent with `model`. */
  name?: string;
  /** `checking`: Flint has not looked at the model server yet (the first moments after boot). */
  state: LocalState | 'checking';
  /** Only with `unavailable`. */
  why?: UnavailableWhy;
  /** The context it is in memory with. */
  contextLength?: number;
  /** Time to first token over the last turns it served. */
  firstTokenMs?: { p50: number; p95: number; n: number };
  /** The exact command that downloads it, when it is not installed. Flint never runs it. */
  pull?: string;
  /** With `pull`: the size of that download in GB, when the tier table lists it. */
  downloadGb?: number;
  /** What the console's row says of it: one or two sentences, true for the mode Flint is in. */
  sentence: string;
}

/** The embedding model: what recall and the tool router turn text into vectors with. */
export interface EmbeddingStatus {
  model: string;
  name: string;
  /** `unknown`: the model server did not say (it is not Ollama's own API, or it is not answering). */
  state: 'installed' | 'not_installed' | 'unknown';
  pull?: string;
  downloadGb?: number;
  sentence: string;
}

/** This machine, and the tier it falls in. */
export interface HardwareStatus {
  accelerator: Accelerator;
  /** "Apple M5 Max", "NVIDIA GeForce RTX 4090". */
  chip?: string;
  /** Accelerator memory in GB (unified memory, or the largest GPU's). 0 with no accelerator. */
  memoryGb: number;
  /** What of it a model can use (@flint/core usableMemoryGb): VRAM, or three quarters of unified memory. */
  usableGb: number;
  /** The machine's RAM in GB. */
  systemMemoryGb: number;
  tier: HardwareTierId;
  /** "48 GB+". */
  tierLabel: string;
  /** `detected`, or `override` when FLINT_HARDWARE_TIER names the tier. */
  tierSource: 'detected' | 'override';
  /** What the tier table recommends for this machine: tags for the command line, names for the console. */
  recommended: { model: string; name: string; contextLength: number; fallbackModel?: string; fallbackName?: string };
  /** The machine as the console names it: its chip, or what kind of machine it is. */
  name: string;
  /** What the console says of it. */
  sentence: string;
  /** Checks that did not answer, for the command line. */
  notes: string[];
}

export interface InferenceStatus {
  mode: InferenceMode;
  modeSource: ModeSource;
  /** What the mode does, in one sentence. */
  modeSentence: string;
  /**
   * What the console's Privacy, Local Only row says: what the switch does, or,
   * in Local mode, that the mode already does it (the switch is then shown on
   * and cannot be changed).
   */
  localOnlySentence: string;
  /** This machine and its tier. Absent while Flint is still looking at the machine (the first moments after boot). */
  hardware?: HardwareStatus;
  local: {
    /** `ollama`: Ollama's own API; `openai`: the OpenAI-compatible adapter. */
    wire: Wire;
    server: ServerKind | 'unknown';
    /** `host:port`. Absent when config refused the address. */
    host?: string;
    loopback?: boolean;
    /** The local model's tag. Absent when none is chosen yet (see ModelStatus.model). */
    model?: string;
    modelSource: ModelSource;
    /** The context Flint budgets the model's window at. */
    contextLength: number;
    /** May the model be offered tools. */
    tools: boolean;
    primary: ModelStatus;
    /** The standby model, which answers while the main one loads. Absent when none is configured. */
    standby?: ModelStatus;
    /** The embedding model. Absent when the status was built without a look for it. */
    embedding?: EmbeddingStatus;
    /** Can a turn that must stay on this Mac use the local model, and if not, why. */
    confined: boolean;
    notConfined?: NotConfined;
    /** Every download command, for anything not installed. */
    pull: string[];
    /** Things Will should know, each a sentence. */
    warnings: string[];
  };
  /** The cloud side. Absent when the status was read without the running server, which is what knows it. */
  cloud?: {
    configured: boolean;
    /** The configured brains, as the boot log names them. */
    brains?: string;
    /** `provider:reason` for providers the breaker has paused. */
    paused?: string;
  };
  problems: ConfigProblem[];
  /**
   * For the console: every refused setting, a mode that could not be read, and
   * every warning, each as a plain sentence. No key, tag, path or address.
   */
  notices: string[];
  /** For the command line: the same facts, by tag and by key. */
  lines: string[];
}

export interface StatusInput {
  mode: InferenceMode;
  modeSource: ModeSource;
  /** Undefined together, until the machine has been looked at. */
  hardware?: Hardware;
  tier?: HardwareTier;
  tierSource: 'detected' | 'override';
  local: LocalBrains;
  snapshot: LocalSnapshot;
  /** The embedding model in use, and whether the model server has it (`undefined`: it did not say). */
  embedding?: { model: string; installed: boolean | undefined };
  cloud?: InferenceStatus['cloud'];
  /**
   * The standby model is known to run on Ollama's servers, whatever it is
   * called (its listing gives it a remote host: ./ollama-locality). It is then
   * never asked, in any mode, and its row says so.
   */
  standbyElsewhere?: boolean;
}

const MODE_NAMES: Record<InferenceMode, string> = { local: 'Local', cloud: 'Cloud', hybrid: 'Hybrid' };

/**
 * Where an answer that stays "here" is, in words for Will: this Mac, or also
 * the one model server he said is his (FLINT_LOCAL_ALLOW_REMOTE=1). Every
 * sentence that promises it reads this, so none says "this Mac" of a turn that
 * server answered.
 */
export function staysOn(allowedRemote: boolean | undefined): string {
  return allowedRemote ? 'this Mac or the model server you allowed' : 'this Mac';
}

/**
 * What each mode does, in plain words. Local mode's promise is about who
 * answers: no outside AI and no paid service. It is not "nothing leaves this
 * Mac" (that is a private message's promise, ./outside-ai): the keyless web
 * search, the page fetch and Will's own account tools still work, and the
 * second sentence says so.
 */
export const MODE_SENTENCES: Record<InferenceMode, string> = {
  local: 'Every answer comes from this Mac. Flint may still search the web.',
  hybrid: 'Flint picks this Mac or the cloud for each message.',
  cloud: 'Cloud models answer, and private messages stay on this Mac.',
};

/**
 * The same, when the local model is on another machine that Will said is his
 * (FLINT_LOCAL_ALLOW_REMOTE=1): "this Mac" alone would not be true of an
 * answer that server wrote.
 */
const MODE_SENTENCES_ALLOWED_REMOTE: Record<InferenceMode, string> = {
  local: `Every answer stays on ${staysOn(true)}. Flint may still search the web.`,
  hybrid: 'Flint picks the model server you allowed or the cloud for each message.',
  cloud: `Cloud models answer, and private messages stay on ${staysOn(true)}.`,
};

/** What the Local Only row says, as it is true of this setup and this mode. */
export function localOnlySentence(mode: InferenceMode, allowedRemote: boolean): string {
  return mode === 'local' ? `Local mode keeps every answer on ${staysOn(allowedRemote)}.` : `Answers stay on ${staysOn(allowedRemote)}.`;
}

/** The notice for Hybrid or Cloud mode with no cloud model set up. */
export function noCloudSentence(allowedRemote: boolean): string {
  return `No cloud model is set up, so ${allowedRemote ? 'the model server you allowed' : 'this Mac'} answers everything.`;
}

/** What the mode does, as it is true of this setup. */
export function modeSentence(mode: InferenceMode, allowedRemote: boolean): string {
  return (allowedRemote ? MODE_SENTENCES_ALLOWED_REMOTE : MODE_SENTENCES)[mode];
}

const grouped = (n: number): string => n.toLocaleString('en-US');

/** "64 GB", "15.9 GB". */
const gigabytes = (n: number): string => `${Number.isInteger(n) ? n : n.toFixed(1)} GB`;

/** A name that is never a model's: what a slot holds when nothing is chosen. Never printed as one. */
const PLACEHOLDERS = new Set(['', 'none', 'default', 'unset', 'undefined', 'null']);
const isPlaceholder = (model: string | undefined): boolean => model === undefined || PLACEHOLDERS.has(model.trim().toLowerCase());

// ---------------------------------------------------------------------------
// the machine

type MachineFacts = Pick<Hardware, 'accelerator' | 'chip' | 'memoryGb' | 'platform' | 'systemMemoryGb'>;

/** The machine and its tier for the command line, in one or two sentences. No article before a chip's name: "a" or "an" is the chip's to decide. */
export function hardwareSentence(h: MachineFacts, tier: Pick<HardwareTier, 'label'>, source: 'detected' | 'override'): string {
  const mac = h.platform === 'darwin';
  const usable = usableMemoryGb(h);
  const machine =
    h.accelerator === 'apple-silicon'
      ? `${h.chip ? `This Mac's chip is ${h.chip}, with` : 'This Mac has Apple Silicon with'} ${gigabytes(h.memoryGb)} of memory, of which a model can use ${gigabytes(usable)}.`
      : h.accelerator === 'nvidia'
        ? `${h.chip ? `This machine's graphics card is ${h.chip}, with` : 'This machine has an NVIDIA graphics card with'} ${gigabytes(h.memoryGb)} of memory.`
        : `This ${mac ? 'Mac' : 'machine'} has no graphics card that Flint can use, and ${gigabytes(h.systemMemoryGb)} of memory.`;
  return `${machine} ${source === 'override' ? `The tier is set to ${tier.label} by hand.` : `That is the ${tier.label} tier.`}`;
}

/** The machine as the console names it. */
export function hardwareName(h: Pick<Hardware, 'accelerator' | 'chip'>): string {
  return h.chip ?? (h.accelerator === 'apple-silicon' ? 'Apple Silicon' : h.accelerator === 'nvidia' ? 'NVIDIA Graphics Card' : 'No Graphics Card');
}

/**
 * What the console says of the machine: how much memory it has and what that
 * is enough for, by the model's display name. Never a tier's label next to the
 * memory ("64 GB, the 48 GB+ tier" reads as a mistake).
 */
export function hardwareLine(h: MachineFacts, tier: HardwareTier, source: 'detected' | 'override'): string {
  const it = h.platform === 'darwin' ? 'This Mac' : 'This machine';
  const enough = isTopTier(tier) ? 'the largest model' : tier.name;
  const cpuRow = tier.minSystemGb !== undefined;
  if (source === 'override') {
    const has = h.accelerator === 'none' ? `${it} has no graphics card Flint can use.` : `${it} has ${gigabytes(h.memoryGb)} of ${h.accelerator === 'nvidia' ? 'graphics ' : ''}memory.`;
    return `${has} The model size was set by hand.`;
  }
  if (cpuRow) {
    const card = h.accelerator === 'nvidia';
    if (tier.fallbackModel) return card ? `${it} has a graphics card with ${gigabytes(h.memoryGb)} of memory, too little for a model, so models run on its processor.` : `${it} has no graphics card Flint can use, so models run on its processor.`;
    // The smallest row: the machine's own memory is the reason, and a card that is too small is said in a few words.
    // (It used to read "...too little for a model and 4 GB of memory, so...".)
    return card
      ? `${it} has ${gigabytes(h.systemMemoryGb)} of memory and a graphics card too small for a model, so it runs the smallest model.`
      : `${it} has no graphics card Flint can use and ${gigabytes(h.systemMemoryGb)} of memory, so it runs the smallest model.`;
  }
  return `${it} has ${gigabytes(h.memoryGb)} of ${h.accelerator === 'nvidia' ? 'graphics ' : ''}memory, enough for ${enough}.`;
}

// ---------------------------------------------------------------------------
// a model's state

/** A model's state for the command line, as a sentence about "it". */
export function stateSentence(h: { state: LocalState | 'checking'; why?: UnavailableWhy | undefined }): string {
  switch (h.state) {
    case 'checking':
      return 'Flint is checking it.';
    case 'loaded':
      return 'It is ready.';
    case 'cold':
      return 'It is not loaded.';
    case 'loading':
      return 'It is loading now.';
    case 'unavailable':
      if (h.why === 'not_installed') return 'It is not downloaded yet.';
      if (h.why === 'config') return "Its server's address was refused.";
      if (h.why === 'unsettled') return 'No local model is chosen yet.';
      return "The local model server isn't answering.";
  }
}

const NOT_ANSWERING = "The local model server isn't answering.";

/** What is wrong with an address, to follow "The local model server's address ...". One true clause per class of refusal. */
const ADDRESS_CLAUSES: Record<UrlProblem, string> = {
  not_a_url: "isn't a web address",
  not_http: "doesn't start with http or https",
  has_credentials: 'has a name or a password in it',
  has_query: 'has a question mark or a hash in it',
  bad_path: "has a path Flint doesn't accept",
  not_loopback: "is on another machine, which Flint doesn't allow unless it is told to",
  insecure_remote: "is on another machine and isn't encrypted",
};
const isUrlProblem = (k: string): k is UrlProblem => Object.prototype.hasOwnProperty.call(ADDRESS_CLAUSES, k);

/** Why the address of the server in use was refused, as a sentence. */
export function addressSentence(kind: UrlProblem | undefined): string {
  return kind ? `The local model server's address ${ADDRESS_CLAUSES[kind]}, so the local model is off.` : "The local model server's address was refused, so the local model is off.";
}

const NOT_CONFINED: Record<Exclude<NotConfined, 'config'>, string> = {
  proxy: 'The local model server is reached through a proxy, so Local and Hybrid modes will not use it.',
  remote_host: 'The local model server is on another machine, so Local and Hybrid modes will not use it.',
  cloud_model: "The local model is an Ollama cloud model, which runs on Ollama's servers, so Local and Hybrid modes will not use it.",
};

/** What the Local Model row says of a model that is in memory at a context Flint does not ask for. */
export const RELOADS_SENTENCE = 'It reloads on the next local answer.';

/** What the console says under the Local Model row. */
function primarySentence(
  m: Pick<ModelStatus, 'state' | 'why'>,
  mode: InferenceMode,
  o: { settled: boolean; hasBackend: boolean; address: UrlProblem | undefined; notConfined: NotConfined | undefined; contextMismatch?: boolean },
): string {
  if (!o.hasBackend || m.why === 'config' || o.notConfined === 'config') return addressSentence(o.address);
  if (o.notConfined) return NOT_CONFINED[o.notConfined];
  if (!o.settled || m.why === 'unsettled') return "No local model is chosen yet, because the local model server isn't answering.";
  // In memory, at another context: the monitor calls that cold, since the next local answer loads it again. The
  // row says that, and never "It is not loaded" over a notice that says it is in memory.
  if (o.contextMismatch && m.state === 'cold') return RELOADS_SENTENCE;
  switch (m.state) {
    case 'checking':
      return 'Flint is checking.';
    case 'loaded':
      return 'It is ready.';
    case 'loading':
      return 'It is loading now.';
    case 'cold':
      // What will load it is the mode's: the cloud mode asks it only for a private message.
      return mode === 'cloud' ? 'It is not loaded. It loads when a private message needs it.' : 'It is not loaded. It loads when a message needs it.';
    case 'unavailable':
      return m.why === 'not_installed' ? "It isn't downloaded yet." : NOT_ANSWERING;
  }
}

/** What the Standby Model row says when the local model cannot be used from here: the standby is on the same server. */
export const STANDBY_NOT_USED_SENTENCE = 'It is on the same server, so it is not used either.';
/**
 * ...and when the main model is one of Ollama's cloud models (by its name, or under a plain one that only the
 * listing shows): the server is this Mac's and the standby does run on it, so that is not the reason. No local
 * model answers while the main one is not on this Mac (./local-serve planLocal), and the row says so.
 */
export const STANDBY_BEHIND_CLOUD_MODEL_SENTENCE = 'It is not used while the main model is a cloud model.';
/** ...and when the standby itself is one: a cloud model under a plain name is not a model on this Mac, and is never asked. */
export const STANDBY_IS_CLOUD_MODEL_SENTENCE = "It is an Ollama cloud model, which runs on Ollama's servers, so Flint does not use it.";

/** What the console says under the Standby Model row. The cloud mode never asks the standby, and the row says so. */
function standbySentence(m: Pick<ModelStatus, 'state' | 'why'>, mode: InferenceMode, notConfined?: NotConfined): string {
  const missing = m.state === 'unavailable' && m.why === 'not_installed';
  if (mode === 'cloud') return missing ? "It isn't downloaded, and Cloud mode doesn't use it." : m.state === 'checking' ? 'Flint is checking.' : "Cloud mode doesn't use it.";
  // The row above says why the local model is not used in this mode. The standby is on that server too, so it
  // does not "answer while the main model loads": no local model answers at all (./local-serve planLocal).
  if (notConfined) return notConfined === 'cloud_model' ? STANDBY_BEHIND_CLOUD_MODEL_SENTENCE : STANDBY_NOT_USED_SENTENCE;
  switch (m.state) {
    case 'checking':
      return 'Flint is checking.';
    case 'loaded':
      return 'It answers while the main model loads.';
    case 'loading':
      return 'It is loading now.';
    case 'cold':
      return 'It is not loaded. It loads when the main model is not ready.';
    case 'unavailable':
      return missing ? "It isn't downloaded, so nothing answers while the main model loads." : NOT_ANSWERING;
  }
}

function modelStatus(h: ModelHealth, canPull: boolean, settled: boolean, hasBackend: boolean, sentence: (m: Pick<ModelStatus, 'state' | 'why'>) => string): ModelStatus {
  const named = settled && !isPlaceholder(h.model);
  const pull = named && canPull && h.state === 'unavailable' && h.why === 'not_installed' ? pullCommand(h.model) : undefined;
  const size = pull ? modelDownloadGb(h.model) : undefined;
  // Not looked at yet: only where there is a server to look at, and a model to look for.
  const checking = named && hasBackend && h.checkedAt === 0 && h.state === 'unavailable' && h.why === 'unreachable';
  const state: ModelStatus['state'] = checking ? 'checking' : h.state;
  const why = h.why && !checking ? h.why : undefined;
  return {
    ...(named ? { model: h.model, name: modelDisplayName(h.model) } : {}),
    state,
    ...(why ? { why } : {}),
    ...(h.contextLength !== undefined ? { contextLength: h.contextLength } : {}),
    ...(h.firstTokenMs ? { firstTokenMs: h.firstTokenMs } : {}),
    ...(pull ? { pull } : {}),
    ...(size !== undefined ? { downloadGb: size } : {}),
    sentence: sentence({ state, ...(why ? { why } : {}) }),
  };
}

function embeddingStatus(e: NonNullable<StatusInput['embedding']>, canPull: boolean): EmbeddingStatus | undefined {
  if (isPlaceholder(e.model)) return undefined;
  const state: EmbeddingStatus['state'] = e.installed === undefined ? 'unknown' : e.installed ? 'installed' : 'not_installed';
  const pull = canPull && state === 'not_installed' ? pullCommand(e.model) : undefined;
  const size = pull ? modelDownloadGb(e.model) : undefined;
  return {
    model: e.model,
    name: modelDisplayName(e.model),
    state,
    ...(pull ? { pull } : {}),
    ...(size !== undefined ? { downloadGb: size } : {}),
    sentence:
      state === 'installed'
        ? 'Memory search uses it.'
        : state === 'not_installed'
          ? "It isn't downloaded, so memory search matches words and not meaning."
          : "Flint can't tell whether it is downloaded.",
  };
}

/** The download line for the command line, with the size when the table knows it. */
const pullLine = (pull: string, gb: number | undefined): string => `To download it${gb !== undefined ? ` (about ${gb.toFixed(1)} GB)` : ''}, run:  ${pull}`;

// ---------------------------------------------------------------------------
// refused settings, for the console

const TIMING_KEYS: ReadonlySet<ConfigKey> = new Set<ConfigKey>([
  'FLINT_LOCAL_CONNECT_TIMEOUT_MS',
  'FLINT_LOCAL_FIRST_OUTPUT_TIMEOUT_MS',
  'FLINT_LOCAL_TOOL_PASS_TIMEOUT_MS',
  'FLINT_LOCAL_REQUEST_TIMEOUT_MS',
  'FLINT_LOCAL_IDLE_TIMEOUT_MS',
  'FLINT_LOCAL_HEALTH_INTERVAL_MS',
]);

/**
 * A refused setting as the console says it: what was wrong and what Flint did
 * instead, with no key's name and never the value. One sentence per class of
 * refusal; `inUse` says whether a refused address is the server Flint talks to.
 */
export function problemSentence(p: ConfigProblem, o: { inUse: boolean; modeSource: ModeSource }): string {
  if (p.key === 'OLLAMA_HOST' || p.key === 'FLINT_LOCAL_BASE_URL') {
    const kind = isUrlProblem(p.kind) ? p.kind : undefined;
    if (o.inUse) return addressSentence(kind);
    return `The address of a second local server ${kind ? ADDRESS_CLAUSES[kind] : 'was refused'}. Flint isn't using that server.`;
  }
  if (TIMING_KEYS.has(p.key)) return "A timing setting in Flint's setup isn't valid, so Flint uses its usual value.";
  switch (p.key) {
    case 'FLINT_INFERENCE_MODE':
      return o.modeSource === 'invalid_env'
        ? "The mode Flint was started with isn't one it knows, so Flint is in Local mode, which never uses the cloud."
        : "The mode Flint was started with isn't one it knows. The mode chosen here is in use.";
    case 'FLINT_LOCAL_PROVIDER':
      return "The kind of local server in Flint's setup isn't one it knows, so Flint talks to Ollama.";
    case 'FLINT_LOCAL_SERVER':
      return "The local server type in Flint's setup isn't one it knows, so Flint asks the server what it is.";
    case 'FLINT_LOCAL_ALLOW_REMOTE':
      return "A setting that allows a model server on another machine isn't valid, so only this Mac is allowed.";
    case 'FLINT_LOCAL_ALLOW_INSECURE_REMOTE':
      return "A setting that allows an unencrypted model server isn't valid, so a server on another machine must be encrypted.";
    case 'FLINT_LOCAL_API_KEY':
      return p.kind === 'in_the_clear' ? "The local model server's key isn't sent, because the server's address isn't encrypted." : "The local model server's key isn't valid, so no key is sent.";
    case 'FLINT_LOCAL_MODEL':
    case 'OLLAMA_MODEL':
      return p.kind === 'cloud_model'
        ? "The local model named in Flint's setup runs on Ollama's servers, so Flint ignored it."
        : "The local model named in Flint's setup isn't a valid model name, so Flint ignored it.";
    case 'FLINT_LOCAL_FALLBACK_MODEL':
      return p.kind === 'cloud_model'
        ? "The standby model named in Flint's setup runs on Ollama's servers, so Flint ignored it."
        : "The standby model named in Flint's setup isn't a valid model name, so Flint ignored it.";
    case 'FLINT_EMBED_MODEL':
      return p.kind === 'cloud_model'
        ? "The embedding model named in Flint's setup runs on Ollama's servers, so Flint uses its usual one."
        : "The embedding model named in Flint's setup isn't a valid model name, so Flint uses its usual one.";
    case 'FLINT_LOCAL_TOOLS':
      return "The tools setting in Flint's setup isn't valid, so the local model is offered no tools.";
    case 'FLINT_HARDWARE_TIER':
      return "The model size named in Flint's setup isn't one it knows, so Flint checks this machine instead.";
    case 'OLLAMA_NUM_CTX':
    case 'FLINT_LOCAL_FALLBACK_NUM_CTX':
      return "A context size in Flint's setup isn't valid, so Flint ignored it.";
    default:
      return "A setting in Flint's setup isn't valid, so Flint ignored it.";
  }
}

/** A saved mode that cannot be read: what happened, and what to do. */
export const INVALID_SAVED_SENTENCE = "The saved mode couldn't be read, so Flint is in Local mode, which never uses the cloud. Choose a mode to save it again.";

// ---------------------------------------------------------------------------

/** Build the status from what main() holds. Pure: the caller takes the snapshot. */
export function inferenceStatus(i: StatusInput): InferenceStatus {
  const { local, snapshot } = i;
  const settled = local.primary.settled && !isPlaceholder(local.primary.model);
  const caps = local.primary.provider.getCapabilities(local.primary.model);
  const canPull = local.server === 'ollama';
  const hasBackend = !!local.backend;
  const addressKey: ConfigKey = local.wire === 'openai' ? 'FLINT_LOCAL_BASE_URL' : 'OLLAMA_HOST';
  const addressProblem = local.cfg.problems.find((p) => p.key === addressKey);
  const address = addressProblem && isUrlProblem(addressProblem.kind) ? addressProblem.kind : undefined;
  const notConfined = local.confined.ok ? undefined : local.confined.why;
  // The local model is on another machine Will said is his: the sentences that say where an answer stays name it.
  const allowedRemote = local.confined.ok && local.endpoint !== undefined && !local.endpoint.loopback;

  const mismatch = snapshot.primary.contextMismatch === true && snapshot.primary.contextLength !== undefined && local.primary.numCtx !== undefined;
  const primary = modelStatus(snapshot.primary, canPull, settled, hasBackend, (m) => primarySentence(m, i.mode, { settled, hasBackend, address, notConfined, contextMismatch: mismatch }));
  const standby =
    local.fallback && snapshot.fallback
      ? i.standbyElsewhere
        ? // Listed, and in memory or not, it is not a model Flint can use: shown as not available, with why.
          modelStatus({ ...snapshot.fallback, state: 'unavailable', why: 'error' }, false, true, hasBackend, () => STANDBY_IS_CLOUD_MODEL_SENTENCE)
        : modelStatus(snapshot.fallback, canPull, true, hasBackend, (m) => standbySentence(m, i.mode, notConfined))
      : undefined;
  const embedding = i.embedding ? embeddingStatus(i.embedding, canPull) : undefined;
  // A model that cannot be used from here is not something to download.
  const offerPull = local.confined.ok;
  if (!offerPull) {
    delete primary.pull;
    delete primary.downloadGb;
    if (standby) {
      delete standby.pull;
      delete standby.downloadGb;
    }
  }

  const warnings: string[] = [];
  if (notConfined && notConfined !== 'config') warnings.push(NOT_CONFINED[notConfined]);
  if (notConfined === 'config' || !hasBackend) warnings.push(addressSentence(address));
  if (mismatch) {
    // (No article before the number: "a 8,192-token" and "an 16,384-token" are both wrong for some size.)
    warnings.push(`The local model is in memory with a context of ${grouped(snapshot.primary.contextLength!)} tokens, and Flint asks for ${grouped(local.primary.numCtx!)}.`);
  }
  const pull = [primary.pull, standby?.pull, embedding?.pull].filter((c): c is string => !!c);

  // ---- the console's notices: a mode that could not be read, every refused setting, every warning
  const notices: string[] = [];
  const notice = (s: string): void => {
    if (!notices.includes(s)) notices.push(s);
  };
  if (i.modeSource === 'invalid_saved') notice(INVALID_SAVED_SENTENCE);
  for (const p of local.cfg.problems) {
    // With the saved mode unreadable, Flint is in Local because of THAT, and the sentence above says so. A second
    // one about the mode it was started with ("The mode chosen here is in use.") would not be true.
    if (i.modeSource === 'invalid_saved' && p.key === 'FLINT_INFERENCE_MODE') continue;
    notice(problemSentence(p, { inUse: p.key === addressKey, modeSource: i.modeSource }));
  }
  // The Mode row's sentence speaks of the cloud in these two modes. With no cloud model set up it is not the whole truth.
  if (i.cloud && !i.cloud.configured && i.mode !== 'local') notice(noCloudSentence(allowedRemote));
  for (const w of warnings) {
    // The Local Model row already says why the model cannot be used: once is enough.
    if (w !== primary.sentence) notice(w);
  }
  const shown = notices.filter((n) => n !== primary.sentence);

  // ---- the command line's sentences
  const lines: string[] = [`Flint is in ${MODE_NAMES[i.mode]} mode. ${modeSentence(i.mode, allowedRemote)}`];
  if (i.modeSource === 'invalid_env') lines.push('FLINT_INFERENCE_MODE is not a mode Flint knows, so it is running as Local, which never uses the cloud.');
  if (i.modeSource === 'invalid_saved') lines.push(INVALID_SAVED_SENTENCE);
  if (i.hardware && i.tier) {
    lines.push(hardwareSentence(i.hardware, i.tier, i.tierSource));
    for (const note of i.hardware.notes) lines.push(`A hardware check did not answer: ${note}.`);
  } else {
    lines.push('Flint is checking this machine.');
  }
  if (settled) {
    lines.push(`The local model is ${local.primary.model} with a ${grouped(caps.maxContextTokens)}-token context. ${stateSentence(primary)}`);
    // What the tier table would have chosen, when Will (or what Ollama had) chose otherwise.
    if (i.tier && local.primary.model !== i.tier.model) {
      lines.push(`The recommended model for this tier is ${i.tier.model} with a ${grouped(i.tier.contextLength)}-token context.`);
    } else if (i.tier && local.wire === 'ollama' && caps.maxContextTokens !== i.tier.contextLength) {
      lines.push(`The recommended context for it is ${grouped(i.tier.contextLength)} tokens.`);
    }
    if (primary.pull) lines.push(pullLine(primary.pull, primary.downloadGb));
  } else {
    // Nothing names a model and the server has not said what it has: the stand-in's name is not the local model.
    lines.push(hasBackend ? "No local model is chosen yet, because the local model server hasn't said what it has." : "No local model is set, and the local model server's address was refused.");
    if (i.tier && hasBackend) lines.push(`The recommended model for this tier is ${i.tier.model} with a ${grouped(i.tier.contextLength)}-token context.`);
  }
  // The standby: the small model that answers while the main one loads.
  if (standby && standby.model) {
    lines.push(`The standby model is ${standby.model}. ${stateSentence(standby)}`);
    if (standby.pull) lines.push(pullLine(standby.pull, standby.downloadGb));
  } else {
    lines.push('No standby model is set.');
  }
  if (embedding) {
    lines.push(`The embedding model is ${embedding.model}.${embedding.state === 'installed' ? ' It is downloaded.' : embedding.state === 'not_installed' ? ' It is not downloaded yet.' : ''}`);
    if (embedding.pull) lines.push(pullLine(embedding.pull, embedding.downloadGb));
  }
  if (i.cloud) lines.push(i.cloud.configured ? (i.cloud.paused ? 'A cloud model is configured, and it is paused right now.' : 'A cloud model is configured.') : 'No cloud model is configured.');
  lines.push(...warnings);
  for (const p of local.cfg.problems) lines.push(`A setting was refused: ${p.key} is ${p.reason}.`);

  return {
    mode: i.mode,
    modeSource: i.modeSource,
    modeSentence: modeSentence(i.mode, allowedRemote),
    localOnlySentence: localOnlySentence(i.mode, allowedRemote),
    ...(i.hardware && i.tier
      ? {
          hardware: {
            accelerator: i.hardware.accelerator,
            ...(i.hardware.chip ? { chip: i.hardware.chip } : {}),
            memoryGb: i.hardware.memoryGb,
            usableGb: usableMemoryGb(i.hardware),
            systemMemoryGb: i.hardware.systemMemoryGb,
            tier: i.tier.id,
            tierLabel: i.tier.label,
            tierSource: i.tierSource,
            recommended: {
              model: i.tier.model,
              name: i.tier.name,
              contextLength: i.tier.contextLength,
              ...(i.tier.fallbackModel && i.tier.fallbackName ? { fallbackModel: i.tier.fallbackModel, fallbackName: i.tier.fallbackName } : {}),
            },
            name: hardwareName(i.hardware),
            sentence: hardwareLine(i.hardware, i.tier, i.tierSource),
            notes: [...i.hardware.notes],
          },
        }
      : {}),
    local: {
      wire: local.wire,
      server: local.server,
      ...(local.endpoint ? { host: local.endpoint.host, loopback: local.endpoint.loopback } : {}),
      ...(settled ? { model: local.primary.model } : {}),
      modelSource: local.primary.from,
      contextLength: caps.maxContextTokens,
      tools: caps.toolCalling !== 'unsupported',
      primary,
      ...(standby ? { standby } : {}),
      ...(embedding ? { embedding } : {}),
      confined: local.confined.ok,
      ...(notConfined ? { notConfined } : {}),
      pull,
      warnings,
    },
    ...(i.cloud ? { cloud: i.cloud } : {}),
    problems: local.cfg.problems,
    notices: shown,
    lines,
  };
}
