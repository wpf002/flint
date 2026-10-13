/**
 * Flint's routing + auto-approval policy, extracted so it is TESTABLE.
 *
 * These two functions are the highest-consequence logic in the server — one
 * decides whether a message leaves the machine, the other decides whether a
 * tool runs without asking. They used to live inline in index.ts, which calls
 * main() at import time and therefore could not be unit-tested at all.
 */

import { isCloudModel } from './memory-brain';
import { LOCALITY } from './ollama-locality';

export type Brain = 'local' | 'frontier';

/**
 * Keep a query on the LOCAL brain when the user asks to in plain language —
 * complements the explicit Local-only toggle.
 */
export const FORCE_LOCAL_RE =
  /\b(stay local|keep it local|keep this local|local only|on[- ]?device|on[- ]?machine|don'?t use claude|privately|keep this private|keep it private)\b/i;

/**
 * Which brain answers. Flint IS Claude by default — equal-to-Claude capability
 * on every query. The local model is used when no frontier is configured, when
 * the user flips Local-only, or when the message asks to stay on-device.
 *
 * `localOnly` is HONORED. It was ignored for a while because a sticky console
 * lock silently trapped answers on the weak 7B; the console now clears the flag
 * on every load, so the toggle is safe to obey — and a privacy switch that lies
 * is worse than no switch.
 */
export function judgeBrain(message: string, hasFrontier: boolean, localOnly: boolean): Brain {
  if (!hasFrontier) return 'local'; // no Claude configured → local fallback
  if (localOnly) return 'local'; // the user's explicit privacy choice
  if (FORCE_LOCAL_RE.test(message)) return 'local';
  return 'frontier'; // default: Flint runs on Claude
}

/** What the attachments on a turn need, and what the frontier model can read. */
export interface MediaFlags {
  image?: boolean;
  pdf?: boolean;
}

export type TurnRoute =
  | {
      brain: Brain;
      /**
       * Whether a frontier failure may silently retry on the local brain. False
       * when the turn carries an image/PDF: the local model would answer
       * WITHOUT seeing the file, and a confident answer about a picture it never
       * saw is worse than an error.
       */
      localFallback: boolean;
    }
  | { error: string };

/**
 * judgeBrain, plus the one thing it can't know: an image or PDF can only be
 * read by a frontier model that supports it. Text-file attachments are just
 * text and route exactly like a plain message.
 *
 * Privacy still wins. If Local-only is on (or the message asks to stay
 * private), an image is NOT quietly shipped to the frontier — the turn is
 * refused with a message that says why, so the user decides.
 */
export function routeTurn(opts: {
  message: string;
  hasFrontier: boolean;
  localOnly: boolean;
  needs: MediaFlags;
  frontierCan: MediaFlags;
}): TurnRoute {
  const brain = judgeBrain(opts.message, opts.hasFrontier, opts.localOnly);
  const visual = !!opts.needs.image || !!opts.needs.pdf;
  if (!visual) return { brain, localFallback: true };

  const what = opts.needs.image && opts.needs.pdf ? 'images or PDFs' : opts.needs.image ? 'images' : 'PDFs';
  if (brain === 'local') {
    if (!opts.hasFrontier) {
      return { error: `The local brain can't read ${what}, and no frontier brain is configured. Send it as text instead.` };
    }
    return {
      error: `Local-only is on, and the on-device brain can't read ${what}. Turn Local-only off to send the file to the frontier brain, or remove the attachment.`,
    };
  }
  if ((opts.needs.image && !opts.frontierCan.image) || (opts.needs.pdf && !opts.frontierCan.pdf)) {
    return { error: `The frontier brain configured here can't read ${what}.` };
  }
  return { brain: 'frontier', localFallback: false };
}

// ---------------------------------------------------------------------------
// does a brain's prompt stay on this Mac?

/** A brain as the locality rule sees it: whose wire it speaks, which model, and where its server is. */
export interface AnsweringBrain {
  /** The provider adapter's name: `ollama`, `anthropic`, `openai`, `perplexity`. */
  provider: string;
  model: string;
  /** The server the provider sends its requests to (an Ollama client's base URL). Unknown: not local. */
  baseURL?: string | undefined;
  /** The context window the provider asks for on every call (an Ollama client's `num_ctx`), when it sets one. */
  numCtx?: number | undefined;
}

/**
 * The wires a model on this Mac can be reached by. Every other provider is an
 * outside service, whatever else is true of it. A new local wire is added here,
 * in a reviewed change, and nowhere else.
 */
export const LOCAL_WIRES: ReadonlySet<string> = new Set(['ollama', 'local']); // Ollama's own API, and the OpenAI-compatible local adapter (@flint/core LocalOpenAiProvider)

/**
 * The local wires whose server can also hand a request on to a model somewhere
 * else (Ollama's cloud models). For these, brainIsLocal takes the server's own
 * word that the model runs on it (./ollama-locality).
 */
const SERVES_REMOTE: ReadonlySet<string> = new Set(['ollama']);

/** Is this provider one of the wires a model on this Mac is reached by? (For a caller that only needs the yes or no.) */
export function isLocalWire(provider: string): boolean {
  return LOCAL_WIRES.has(provider);
}

/** Is this URL's host the machine itself? Exactly 127.0.0.1, localhost or ::1: `127.0.0.1.example.com` is someone else's. */
export function onThisMachine(baseURL: string | undefined): boolean {
  if (!baseURL) return false;
  let host: string;
  try {
    const u = new URL(baseURL);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    host = u.hostname.toLowerCase();
  } catch {
    return false;
  }
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}

/**
 * What only this server's own settings can say about an address. ./inference
 * reads them once and tells this module at boot (`setPlaceRules`); until then,
 * and in a test that sets none, neither applies.
 */
export interface PlaceRules {
  /**
   * Is this the model server on another machine that Will said is his own
   * (FLINT_LOCAL_ALLOW_REMOTE, and then only over https or on a network he
   * called private)? Its address is then held as this Mac's is: what stays
   * here may be sent there, and nowhere else.
   */
  own?: (baseURL: string) => boolean;
  /**
   * Does a request to this address leave this process through a proxy first
   * (Node's env proxy carries loopback too)? Then it is not this Mac, whatever
   * its host says.
   */
  proxied?: (baseURL: string) => boolean;
}

let places: PlaceRules = {};

/** Tell this module what the server's settings say about addresses (./inference, at boot). An empty object clears them. */
export function setPlaceRules(rules: PlaceRules): void {
  places = rules;
}

/**
 * Is this address "here", for anything that must not leave: this Mac, or the
 * one server on another machine that Will said is his, and in either case not
 * reached through a proxy. The address alone: whether a MODEL at it runs there
 * is brainIsLocal's question.
 */
export function placedHere(baseURL: string | undefined): boolean {
  if (!baseURL || places.proxied?.(baseURL) === true) return false;
  return onThisMachine(baseURL) || places.own?.(baseURL) === true;
}

/**
 * Does asking this brain keep the prompt on this Mac? The ONE place that is
 * decided, for everything that may only be read locally: Will's goals in chat
 * context (./goals-now), the turns he kept private and every turn of Local
 * mode (./private-turns), and the facts learned from either. It is asked about
 * a BRAIN, not a turn, at the moment that brain is asked: a turn planned for
 * the frontier can end on the local model, and a turn's first brain is not
 * always the one that answers.
 *
 * Local means all four:
 *  - the provider is a local wire (LOCAL_WIRES: Ollama's own API, or the
 *    OpenAI-compatible local adapter). The name `local` on a route says
 *    nothing: the local persona can be on an Ollama on another machine, and
 *    that is not local;
 *  - the model is not named as one of Ollama's cloud models (`…-cloud`, `:cloud`),
 *    which Ollama serves from its own machines (./memory-brain isCloudModel);
 *  - its server is here (`placedHere`): this Mac, at a loopback address, or
 *    the one model server on another machine that Will said is his own
 *    (FLINT_LOCAL_ALLOW_REMOTE, as ./inference tells this module), and never
 *    through a proxy. Any other Ollama elsewhere (OLLAMA_HOST or a tier's host
 *    set to another machine) is not local. (`allowRemote` is a caller's own
 *    word for it; nothing in the server passes it.)
 *  - an Ollama itself says the model runs on it (./ollama-locality: its
 *    listing gives the model no remote host). A name is not trusted: a cloud
 *    model copied under another name still runs on Ollama's servers. This is
 *    the check the model auto-picker already makes, cached, and it fails
 *    closed: until Ollama has said so, and whenever it cannot be asked, the
 *    model is not local. The OpenAI-compatible wire can be pointed at an
 *    Ollama too: once its server has listed models as an Ollama does, it is
 *    held to that listing the same way (a server that never has, llama.cpp or
 *    LM Studio, runs only its own models and has nothing to ask).
 * Anything unknown (no brain, another provider, no address, no listing) is not local.
 */
export function brainIsLocal(brain: AnsweringBrain | undefined, opts: { allowRemote?: boolean; listed?: (baseURL: string | undefined, model: string) => boolean } = {}): boolean {
  if (!brain || !LOCAL_WIRES.has(brain.provider)) return false;
  if (!brain.model || isCloudModel(brain.model)) return false;
  if (brain.baseURL !== undefined && places.proxied?.(brain.baseURL) === true) return false;
  if (opts.allowRemote !== true && !placedHere(brain.baseURL)) return false;
  const listed = opts.listed ?? ((url, model) => LOCALITY.runsHere(url, model));
  // Ollama can serve a model from its own servers under any name, so an Ollama is asked.
  if (SERVES_REMOTE.has(brain.provider)) return listed(brain.baseURL, brain.model);
  // The other wire: only a server that has shown itself to be an Ollama has anything to ask.
  return !LOCALITY.isOllama(brain.baseURL) || listed(brain.baseURL, brain.model);
}

/**
 * Is where this brain's model runs simply NOT KNOWN right now? A local wire at
 * an address that is here, a model not named as a cloud one, and an Ollama
 * that has not been heard on it: no listing yet, one too old to believe, or one
 * that does not hold the model. brainIsLocal says no to such a brain, as it
 * must, and that no may become a yes at the next listing. Whoever can wait for
 * it should, instead of treating the brain as one that will never be local
 * (./goals-chat extractor: a turn skipped is a turn never mined).
 */
export function placeUnknown(brain: AnsweringBrain | undefined): boolean {
  if (!brain || !LOCAL_WIRES.has(brain.provider) || !brain.model || isCloudModel(brain.model)) return false;
  if (!placedHere(brain.baseURL) || brainIsLocal(brain)) return false;
  return !LOCALITY.runsElsewhere(brain.baseURL, brain.model);
}

/**
 * The address whose model listing decides whether this brain is local, when
 * one does: an Ollama brain at an address that is here (this Mac, or the model
 * server Will said is his). brainIsLocal reads what that Ollama last said
 * (./ollama-locality); whoever names a brain has it asked, and asked again
 * every minute. (An Ollama anywhere else is never asked: nothing it lists
 * would make its models local.)
 */
export function listedAt(brain: AnsweringBrain | undefined): string | undefined {
  return brain && SERVES_REMOTE.has(brain.provider) && placedHere(brain.baseURL) ? brain.baseURL : undefined;
}

/** A provider adapter and its model as an AnsweringBrain: the adapter's own name, address and context size, never a label's. */
export function brainOf(provider: { readonly name: string }, model: string): AnsweringBrain {
  const { baseURL, numCtx } = provider as { readonly baseURL?: unknown; readonly numCtx?: unknown };
  return {
    provider: provider.name,
    model,
    ...(typeof baseURL === 'string' ? { baseURL } : {}),
    ...(typeof numCtx === 'number' && Number.isInteger(numCtx) && numCtx > 0 ? { numCtx } : {}),
  };
}

// The tool-name rules (isSafeTool and the sets behind it) moved to @flint/policy,
// where the runtime's tier engine uses them too. Re-exported so imports here hold.
export {
  READ_SEGMENTS,
  MONEY_SEGMENTS,
  WRITE_SEGMENTS,
  WRITE_TOOL,
  NEVER_AUTO,
  segmentsOf,
  isSafeTool,
} from '@flint/policy';
