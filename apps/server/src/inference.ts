/**
 * Local inference, as main() and the two chat handlers hold it: the validated
 * config, the routing mode, the local brain on its wire, and the monitor that
 * watches its server.
 *
 * index.ts runs main() on import and cannot be unit-tested, so every decision
 * it needs from local inference is made here, behind one object, and each call
 * site in index.ts is a single call:
 *  - `preRoute` / `finishRoute`: which brain answers, by the mode (./mode-route);
 *  - `planLocal`: which local model answers, from the models' state now: the
 *    main one when it is ready, else the standby, and the sentence for a turn
 *    that must be local when none can (./local-serve);
 *  - `cloudChain`: the cloud tiers a hybrid turn falls through to;
 *  - `offer` / `refusing`: Local mode offers and runs no tool an outside AI
 *    answers (./outside-ai);
 *  - `cloudOnly` / `cloudRefused`: the cloud calls that are not chat (research
 *    planning, memory extraction on the frontier, speech) are refused in Local
 *    mode, where they are made;
 *  - `status`: what the console and the status command show.
 *
 * Boot never waits on the model server or on the machine (./local-brains):
 * `buildInference` returns with a brain to hold, and what lands later (this
 * machine's tier, the tier's model, the server's own answer when it was silent
 * at boot) replaces `local` for the NEXT turn. `onAdopt` tells main(), which
 * holds a Flint client and a persona built on the old one. Until the machine
 * has been looked at, `hardware` and `tier` are undefined and the status says
 * Flint is checking.
 */
import { EMBEDDING_MODEL, FlintError, hardwareTier, hardwareTierFor, makeAiError, type Attachment, type HardwareTier, type ProviderAdapter, type Tier, type Tool } from '@flint/core';
import { detectHardware, type Hardware } from './hardware';
import { addressIsLocal, localEndpoint, ollamaIsLocal, readInferenceConfig, viaProxy, type FileCheck, type InferenceConfig, type InferenceMode } from './inference-config';
import { ModeStore } from './inference-mode';
import { inferenceStatus, localOnlySentence, modeSentence, staysOn, type InferenceStatus } from './inference-status';
import type { BrainTier } from './brains';
import type { FrontierBreaker } from './frontier-breaker';
import { startLocalBrains, type BuildLocalDeps, type LocalBrainSpec, type LocalBrains, type LocalHandle } from './local-brains';
import { isPdf, localMedia, type LocalMedia } from './local-media';
import { cloudChainFor, heldToHere, planLocal, privateRefusal, type LocalChoice, type LocalPlan } from './local-serve';
import { finishRoute, preRoute, type ModeRoute, type OpenRoute, type PreRoute, type PreRouteInput } from './mode-route';
import { FRESH_MS, LOCALITY } from './ollama-locality';
import { OUTSIDE_OFF_LOCAL_MODE, isPrivateOff, offered, offeredPrivate, outsideOffPrivate, outsideTools, withPrivateNote, withheldWhenOff, type OutsideOff } from './outside-ai';
import { makePdfReader, type PdfReader } from './pdf-text';
import { brainIsLocal, brainOf, setPlaceRules, type MediaFlags, type PdfUnread } from './policy';
import { turnStaysHere, type StayRoute } from './private-turns';
import { paidToolSpecs, type BrainChooser, type BudgetView, type PaidToolSpec } from './spend';
import { carriesKeptText, isEvalTurn, isPrivateRequest, isPrivateTurn, isStaysHereRequest, isStaysHereTurn, markPrivateRequest, markStaysHereRequest } from './turn-taint';
import { isFile, planVoice, transcriptionMissing, type VoicePlan } from './voice';
import type { TurnFacts } from './hybrid-rules';

type Env = Record<string, string | undefined>;

/** The host of a brain's address, or undefined when it has none that can be read. */
function hostOf(baseURL: string | undefined): string | undefined {
  if (!baseURL) return undefined;
  try {
    return new URL(baseURL).host;
  } catch {
    return undefined;
  }
}

/**
 * The model a helper's request to Ollama names (`"model"` in its JSON body):
 * what ./inference helpersOff asks Ollama's listing about. Undefined for a
 * request with no body (it names no model). An empty string for a body whose
 * model cannot be read: that is no model Ollama lists, so a private message is
 * not sent with it.
 */
export function helperModel(body: unknown): string | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body !== 'string') return '';
  try {
    const model = (JSON.parse(body) as { model?: unknown } | null)?.model;
    return typeof model === 'string' ? model : '';
  } catch {
    return '';
  }
}

/** A cloud call that is not a chat turn: what Local mode refuses where it is made. */
export type CloudCallKind = 'plan' | 'extract' | 'tts';

/** How long a status waits for the model server to say whether it has the embedding model. */
const EMBED_LOOK_MS = 1_500;

/** How old the monitor's last look at the model server may be when a turn is planned from it. */
export const FRESH_FOR_MS = 500;
/** How long a turn waits for a fresh look before it goes on with what was known. */
export const FRESH_WAIT_MS = 400;

/** How often the same kind of refused cloud call is logged. */
const REFUSAL_LOG_EVERY_MS = 10 * 60 * 1000;

/**
 * What a handler tells the route about a turn: everything ./mode-route asks
 * for that this object does not know itself, and the turn's files, which are
 * looked at here (`localReads`) and nowhere else on the way to a route.
 */
export type RouteAsk = Omit<PreRouteInput, 'mode' | 'localCan' | 'keptCan' | 'pdfUnread'> & {
  attachments?: readonly Attachment[] | undefined;
  /**
   * The files the conversation's EARLIER turns still carry, which the model is handed again as history
   * (./persistent-store windowAttachments). A PDF among them is read here before the route's look at the model
   * server, like this turn's own, so the request that follows waits for no read.
   */
  earlier?: readonly Attachment[] | undefined;
  /**
   * The local model that would answer is not the main one: an eval replay that names its own (`localModel`),
   * which is asked through a client of its own. What the main model's adapter can read says nothing of that
   * one, so nothing is said to be readable, and such a replay with a picture or a PDF is refused as it always
   * was.
   */
  ownLocalModel?: boolean | undefined;
};

/** What the local model can read of one turn's files (./mode-route PreRouteInput has each). */
export type LocalReads = Pick<PreRouteInput, 'localCan' | 'keptCan' | 'pdfUnread'>;

/** How long a turn that carries a file waits for the model server's first word about its model (what it can see), right after a start. */
export const FIRST_WORD_WAIT_MS = 3_000;

/** This machine, once it has been looked at: what it is, and the tier it falls in. */
export interface Machine {
  hardware: Hardware;
  tier: HardwareTier;
}

export class Inference {
  readonly cfg: InferenceConfig;
  /** What hears and what speaks, as config decided it (./voice): the providers are built from it, and the status says it. */
  readonly voicePlan: VoicePlan;
  readonly mode: ModeStore;
  /**
   * Over when the first pass behind the boot is: the machine looked at, its tier
   * applied, the model server asked once. Never rejects. Nothing on a turn's
   * path waits for it; a test and the status command do.
   */
  readonly ready: Promise<void>;
  private readonly handle: LocalHandle;
  private readonly machine: () => Machine | undefined;
  private readonly paid: readonly PaidToolSpec[];
  /** The tools not offered while outside services are off: every outside tool, until `declareTools` says which can run keyless. */
  private withheld: ReadonlySet<string>;
  private readonly log: (msg: string) => void;
  private readonly now: () => number;
  /** Have the server at this address asked what runs on it, when its word is more than two seconds old (./ollama-locality fresh). */
  private readonly listing: (baseURL: string) => Promise<void>;
  private readonly refusalLoggedAt = new Map<CloudCallKind, number>();
  /** Is there a file at this path? Asked when a status is built, of the transcription program and its model (./voice transcriptionMissing). */
  private readonly fileExists: FileCheck;
  /** What reads a PDF's text on this Mac for the local model (FLINT_LOCAL_PDF: ./local-media). Undefined: nothing does, as before. */
  private readonly media: LocalMedia | undefined;

  constructor(parts: {
    cfg: InferenceConfig; voice: VoicePlan; handle: LocalHandle; mode: ModeStore; machine: () => Machine | undefined; ready: Promise<void>; paid: readonly PaidToolSpec[];
    log?: (msg: string) => void; now?: () => number; listing?: (baseURL: string) => Promise<void>; fileExists?: FileCheck; media?: LocalMedia | undefined;
  }) {
    this.cfg = parts.cfg;
    this.media = parts.media;
    this.voicePlan = parts.voice;
    this.fileExists = parts.fileExists ?? isFile;
    this.handle = parts.handle;
    this.mode = parts.mode;
    this.machine = parts.machine;
    this.ready = parts.ready;
    this.paid = parts.paid;
    this.withheld = outsideTools(parts.paid);
    this.log = parts.log ?? (() => {});
    this.now = parts.now ?? Date.now;
    this.listing = parts.listing ?? ((baseURL) => LOCALITY.fresh(baseURL));
    // What these settings say about addresses, for the one rule that decides whether a brain is on this Mac
    // (./policy brainIsLocal): the model server on another machine that Will said is his is held as this Mac
    // is, and an address reached through Node's env proxy never is.
    setPlaceRules({ own: (baseURL) => this.ownServer(baseURL), proxied: (baseURL) => viaProxy(hostOf(baseURL), this.cfg.local.proxy) });
  }

  /**
   * Is this address the model server on another machine that Will said is his
   * own? FLINT_LOCAL_ALLOW_REMOTE vouches for ONE server: the local model
   * server itself (FLINT_LOCAL_BASE_URL, or OLLAMA_HOST on Ollama's own API),
   * and then only over https or on a network he called private
   * (./inference-config addressIsLocal). It vouches for no other address: an
   * OLLAMA_HOST on some other machine, while the model server is here or
   * elsewhere, is not "here" because of that switch, so the embedder and
   * memory extraction there are given nothing that stays here. (When Ollama's
   * address IS the model server's, they are one server, and it is vouched for.)
   */
  private ownServer(baseURL: string): boolean {
    let origin: string;
    try {
      origin = new URL(baseURL).origin;
    } catch {
      return false;
    }
    const at = localEndpoint(this.cfg);
    return at !== undefined && !at.loopback && at.origin === origin && addressIsLocal(at, this.cfg);
  }

  /**
   * May a turn that must stay here use the local brain, as far as is known
   * NOW? ./local-brains decides it from the settings (`local.confined`: the
   * address, a proxy, a model named as one of Ollama's cloud models). One more
   * thing only the model server can say: a cloud model copied under a plain
   * name (`ollama cp gpt-oss:120b-cloud mine`) still runs on Ollama's servers,
   * and its listing says so (./ollama-locality, which every look the monitor
   * takes at the server feeds). Then "local" is not this Mac either, and the
   * reason is the same: `cloud_model`.
   */
  get confined(): LocalBrains['confined'] {
    const c = this.local.confined;
    if (!c.ok) return c;
    const p = this.primary;
    return p.settled && LOCALITY.runsElsewhere(brainOf(p.provider, p.model).baseURL, p.model) ? { ok: false, why: 'cloud_model' } : c;
  }

  /** The local brain with what is known now of where its model runs (`confined`), for a status. */
  private get localNow(): LocalBrains {
    const confined = this.confined;
    return confined === this.local.confined ? this.local : { ...this.local, confined };
  }

  /** The local brain, its server and its monitor, as the NEXT turn uses them. */
  get local(): LocalBrains {
    return this.handle.current();
  }

  /** This machine, as detected behind the boot (./hardware). Undefined until it has been looked at. */
  get hardware(): Hardware | undefined {
    return this.machine()?.hardware;
  }

  /** Its hardware tier: detected, or the one FLINT_HARDWARE_TIER names. Undefined until the machine has been looked at. */
  get tier(): HardwareTier | undefined {
    return this.machine()?.tier ?? (this.cfg.hardwareTier === 'auto' ? undefined : hardwareTier(this.cfg.hardwareTier));
  }

  /**
   * Told when the local brain changes after boot: the tier's model, or the
   * server's own answer when it was silent at boot. The caller rebuilds what it
   * made of the old one; a turn already running finishes on what it started with.
   */
  onAdopt(fn: () => void): void {
    this.handle.onChange(() => fn());
  }

  /** End the background work: the health timer and any re-pick (tests, the status command). */
  stop(): void {
    this.handle.stop();
  }

  /** The local brain main() builds its Flint client and persona on. */
  get primary(): LocalBrainSpec {
    return this.local.primary;
  }

  /**
   * What the local model can read, by what its adapter says. On Ollama's own
   * wire that is nothing until Will turns it on: pictures with
   * FLINT_LOCAL_VISION=on, for a model its server says can see
   * (./local-brains), and PDFs with FLINT_LOCAL_PDF, as their text
   * (./local-media).
   */
  localCan(): MediaFlags {
    const caps = this.primary.provider.getCapabilities(this.primary.model);
    return { image: caps.vision === true, pdf: caps.pdfInput === true };
  }

  /**
   * What the local model can read of THIS turn's files.
   *
   * A picture: what `localCan` says. A PDF is looked at first: with
   * FLINT_LOCAL_PDF set it is read here, now (./local-media, which keeps the
   * read for the request that follows), and only a PDF that came out as text
   * counts as one the local model can read. One with no text in it (a scan),
   * or one the read failed on, does not: the turn is then routed exactly as if
   * nothing here read PDFs, so it is refused with a sentence that says which
   * (`pdfUnread`), or goes to a cloud model that reads PDFs when it may. It is
   * never answered blind. A PDF is read here only for a turn the local model
   * may answer: one a cloud model answers anyway is not.
   *
   * `keptCan` is the same answer, given only when one of the two settings is
   * on: it is what lets the cloud mode answer a turn it keeps here (no cloud
   * model, Local Only, the message asked) on the local model. With both off
   * it is left out, and such a turn with a picture or a PDF is refused as it
   * always was, whatever the local model can see.
   */
  async localReads(i: RouteAsk): Promise<LocalReads> {
    if (i.ownLocalModel) return { localCan: {} };
    const on = this.filesOn;
    // Right after a start the model server has not yet said what its model can do, and "not known" is "no": the
    // first turn with a file would be refused for it. It waits for that first word, a few seconds at most.
    if (on && (i.needs.image || i.needs.pdf)) await this.firstWord();
    const can = this.localCan();
    // A file's content goes to a model server only when it is this Mac, or the one Will vouched for (`confined`).
    // With any other, the turns the cloud mode keeps here are refused as they always were, ordinary ones included.
    const here = this.confined.ok;
    const said = (pdf: boolean, pdfUnread?: PdfUnread): LocalReads => {
      const localCan: MediaFlags = { image: can.image === true, pdf };
      return { localCan, ...(on && here ? { keptCan: localCan } : {}), ...(pdfUnread ? { pdfUnread } : {}) };
    };
    const { attachments: _files, ownLocalModel: _own, earlier: _earlier, ...ask } = i;
    /** Is a local model the first to be asked this turn (or may it be: a hybrid turn not yet decided)? */
    const localFirst = (r: LocalReads): boolean => {
      const first = preRoute({ ...ask, mode: this.mode.current(), ...r });
      return !('error' in first) && ('open' in first || first.brain === 'local');
    };
    let result: LocalReads;
    if (!i.needs.pdf || can.pdf !== true || !this.media) result = said(can.pdf === true);
    else {
      const pdfs = (i.attachments ?? []).filter(isPdf);
      // (No PDF among the files the route was handed: nothing was read, so nothing is said to be readable.)
      if (pdfs.length === 0) result = said(false);
      else if (!localFirst(said(true))) result = said(true);
      else {
        const reads = await Promise.all(pdfs.map((a) => this.media!.text(a)));
        const bad = reads.find((r) => !r.ok);
        result = bad && !bad.ok ? said(false, bad.why) : said(true);
      }
    }
    // The PDFs the conversation's earlier turns still carry are read now too, before the look at the model server
    // that follows (`routeFirst`): the request then finds every read kept, and nothing is awaited between that
    // look and the request. Only for a turn a local model is first to answer; what a read came to changes no route.
    const earlier = (i.earlier ?? []).filter(isPdf);
    if (this.media && here && can.pdf === true && earlier.length > 0 && localFirst(result)) await Promise.all(earlier.map((a) => this.media!.text(a)));
    return result;
  }

  /** Are pictures or PDFs for the local model turned on (FLINT_LOCAL_VISION, FLINT_LOCAL_PDF)? */
  private get filesOn(): boolean {
    return this.cfg.local.vision || this.media !== undefined;
  }

  /**
   * Wait, a few seconds at most, for the model server's first word about the
   * main model: what it can do (./local-monitor facts), which is asked behind
   * the boot. Returns at once when it is known. A server that does not answer
   * is not waited for past its own look.
   */
  private async firstWord(): Promise<void> {
    const known = (): boolean => this.primary.settled && this.local.monitor.facts(this.primary.model) !== undefined;
    if (known()) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      (async () => {
        await this.ready;
        if (!known()) await this.local.monitor.check().then(() => undefined, () => undefined);
      })(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, FIRST_WORD_WAIT_MS);
      }),
    ]);
    if (timer) clearTimeout(timer);
  }

  /**
   * A request to a local model had to wait for a read for longer than the
   * model server's word is good for (./local-media WrapOptions.lookAgain):
   * ask the server again now, and refuse if this turn stays here and the
   * model is no longer known to run here. Nothing has been sent when this
   * throws.
   */
  async lookAgain(provider: ProviderAdapter, model: string): Promise<void> {
    await this.local.monitor.check().then(
      () => undefined,
      () => undefined,
    );
    const kept = isPrivateTurn() || isStaysHereTurn() || isPrivateRequest() || isStaysHereRequest();
    if (kept && !brainIsLocal(brainOf(provider, model))) {
      throw new FlintError(makeAiError('provider_unavailable', `Flint cannot confirm right now that its local model runs on ${staysOn(this.allowedRemote())}, so nothing was sent to it.`, { retryable: false }));
    }
  }

  /** The standby local model, when one is configured (./local-brains). */
  get standby(): LocalBrainSpec | undefined {
    return this.local.fallback;
  }

  /**
   * What the hybrid rules are told about the local side. Available means: the
   * server answers, a local model is installed (the main one, or the standby),
   * and "local" is really this Mac.
   */
  localFacts(): TurnFacts['local'] {
    const snap = this.local.monitor.snapshot();
    const caps = this.primary.provider.getCapabilities(this.primary.model);
    const installed = snap.primary.state !== 'unavailable' || (snap.fallback !== undefined && snap.fallback.state !== 'unavailable');
    return {
      available: this.confined.ok && snap.reachable && installed,
      tools: caps.toolCalling !== 'unsupported',
      contextTokens: caps.maxContextTokens,
    };
  }

  /**
   * Before the turn is counted: the whole route in the cloud and local modes,
   * every refusal in all three (./mode-route).
   *
   * A private message is settled here too, before anything is made of it:
   *  - with a local model server that is not this Mac, and not one Will said
   *    is his, it is refused in every mode (503, a sentence). Cloud mode used
   *    to send it to that server;
   *  - otherwise the request is marked private from this moment, so the
   *    helpers that would embed its words at an Ollama on another machine (the
   *    tool router, recall) are off for it (`helpersOff`).
   *
   * A turn that stays here by its ROUTE is marked the same way (every turn of
   * Local mode; in Hybrid a turn stays here only when it is private, which is
   * the case above). Its words are then held to the strict rule by every
   * helper: embedded, or sent anywhere, only by a model that is confirmed to
   * run on this Mac. "Not known to run elsewhere" used to be enough in Local
   * mode, so with the listing silent the words of a turn that was about to be
   * refused still went to the embedding model, and with the whole server hung
   * the turn waited on that request instead of getting its sentence.
   */
  preRoute(i: Omit<PreRouteInput, 'mode' | 'localCan'> & { localCan?: MediaFlags }): PreRoute {
    // (`routeFirst` hands in what the local model can read of this turn's files. A caller with no files to look at
    // gets what its adapter says.)
    const pre = preRoute({ ...i, mode: this.mode.current(), localCan: i.localCan ?? this.localCan() });
    if ('error' in pre) return pre;
    if (!pre.private) {
      if (turnStaysHere(pre)) markStaysHereRequest();
      return pre;
    }
    const refusal = privateRefusal(pre, this.confined);
    if (refusal) return { error: refusal, status: 503 };
    markPrivateRequest();
    return pre;
  }

  /** What the console's Mode row and Local Only row say for the mode in force (./inference-status). */
  sentences(): { modeSentence: string; localOnlySentence: string } {
    const mode = this.mode.current();
    const remote = this.allowedRemote();
    return { modeSentence: modeSentence(mode, remote), localOnlySentence: localOnlySentence(mode, remote) };
  }

  /**
   * Is the local model on another machine that Will said is his
   * (FLINT_LOCAL_ALLOW_REMOTE=1, over https or on a network he called
   * private)? Then a turn that "stays here" was answered on that server, and
   * every sentence that says where it stays names it (./local-serve staysOn).
   */
  allowedRemote(): boolean {
    return this.confined.ok && this.local.endpoint !== undefined && !this.local.endpoint.loopback;
  }

  /**
   * A turn's context with the one sentence a private turn's model is told
   * (./outside-ai withPrivateNote): where the message stays, in the words
   * Settings uses, the model server Will allowed included when there is one.
   */
  withPrivateNote(context: string, route: { private: boolean }): string {
    return withPrivateNote(context, route.private, this.allowedRemote());
  }

  /**
   * What the local model reads, for the console's line under an attached file ("Local Only is on, so Flint
   * can't read ..."): given only when Will has turned pictures or PDFs for it on. Undefined with both off, and
   * the console then says what it always said.
   */
  readsForConsole(): { images: boolean; pdfs: boolean } | undefined {
    if (!this.filesOn) return undefined;
    // (Neither, for a model server that is not this Mac: no file's content is sent to it.)
    const here = this.confined.ok;
    const can = this.localCan();
    return { images: here && can.image === true, pdfs: here && can.pdf === true };
  }

  /**
   * How many characters of a turn's PDFs the local model would be handed as text (./local-media): part of how
   * long its prompt is, for the hybrid rules' long-context test. Nothing when no PDF is read here, and nothing
   * for one that was not read for this turn (a turn a cloud model answers anyway).
   */
  pdfTextChars(attachments: readonly Attachment[]): number {
    return this.media ? this.media.chars(attachments, this.primary.provider.getCapabilities(this.primary.model).maxContextTokens) : 0;
  }

  /** A hybrid turn, once its tier and tools are known. A route that was already decided passes through. */
  finishRoute(pre: ModeRoute | OpenRoute, more: { tier: Tier; toolsLikely: boolean; promptChars: number }): ModeRoute {
    if (!('open' in pre)) return pre;
    return finishRoute(pre, { tier: more.tier, toolsLikely: more.toolsLikely, promptTokens: Math.ceil(Math.max(0, more.promptChars) / 4), local: this.localFacts() });
  }

  /**
   * Which local model answers this turn (./local-serve planLocal), decided once
   * from the models' state right now: the main model when it is ready, else the
   * standby, and in hybrid the cloud last. A plan with no steps carries the
   * sentence for Will (`refusal`). The main model is warmed here when the plan
   * asks for it: by the monitor, detached, never by the turn.
   */
  planLocal<P>(route: ModeRoute, who: { primary: LocalChoice<P>; standby?: LocalChoice<P> | undefined; evalOwnModel?: boolean; needs?: MediaFlags | undefined }): LocalPlan<P> {
    const snapshot = this.local.monitor.snapshot();
    const planned = planLocal({
      route,
      snapshot,
      confined: this.confined,
      primary: who.primary,
      // A standby that is a cloud model under a plain name is not a local model: it is never asked, in any mode.
      // Neither, once pictures or PDFs for the local model are turned on, is one that cannot read this turn's
      // picture or PDF (`needs`): it would answer without having seen it. With both off the standby is planned
      // exactly as it always was, on either wire. (And it is asked only of a turn a local model may answer.)
      standby: this.local.fallback && !this.standbyElsewhere() && this.standbyReads(this.filesOn && (route.brain === 'local' || route.localFallback) ? who.needs : undefined) ? who.standby : undefined,
      now: this.now(),
      ...(who.evalOwnModel ? { evalOwnModel: true } : {}),
      ...(this.allowedRemote() ? { allowedRemote: true } : {}),
    });
    // A turn that stays here (Will kept it private, or Flint is in Local mode) is only ever asked of a model that
    // is known to run here: ./policy brainIsLocal, which for an Ollama is the server's own word. A model it is not
    // known of yet is not asked, and one that runs elsewhere under a plain name never is.
    const plan = turnStaysHere(route)
      ? heldToHere(planned, {
          route,
          here: (step) => this.runsHere(step.which === 'fallback' ? this.local.fallback : this.primary, step.model),
          elsewhere: (step) => this.runsElsewhere(step.which === 'fallback' ? this.local.fallback : this.primary, step.model),
          allowedRemote: this.allowedRemote(),
          ...(who.evalOwnModel ? {} : { main: snapshot.primary }),
        })
      : planned;
    if (plan.warmPrimary) this.local.monitor.warm('primary');
    // Nothing local could be planned: the server may be back already, so look again, off this turn's path.
    if (plan.refusal && !plan.steps.some((s) => s.kind === 'local')) this.local.monitor.checkSoon();
    return plan;
  }

  /**
   * What a turn's local steps are told about it (./local-serve RunOptions):
   * whether Will asked for it to stay on this Mac, and whether it was routed
   * as one that stays here (that, or any turn of Local mode).
   */
  keeping(route: StayRoute): { private: boolean; staysHere: boolean; heard: () => Promise<void> } {
    return { private: route.private, staysHere: turnStaysHere(route), heard: () => this.heardLately() };
  }

  /**
   * Before a local model is asked: have the model server looked at again when
   * the last look is more than two seconds old, and wait for it (as long as
   * a look may take). The look is where the server says where each of its
   * models runs (./ollama-locality), and that is what decides, inside the ask,
   * whether this model is handed the turns and facts that stay here.
   *
   * A turn that stays here by its route has just had its own look
   * (`routeFirst`), and the local and hybrid modes look before they plan
   * (`freshen`). This is for what is left: an ordinary turn the local model
   * answers in the cloud mode (no cloud model set up, or one that failed),
   * where no timer watches the server and the last look can be a minute old.
   * Such a turn can carry a private turn in its history.
   */
  async heardLately(): Promise<void> {
    const p = this.local.monitor.snapshot().primary;
    if (p.checkedAt !== 0 && this.now() - p.checkedAt < FRESH_MS) return;
    await this.local.monitor.check().then(
      () => undefined,
      () => undefined,
    );
  }

  /** Is this model, asked through that local brain's server, known to run here (./policy brainIsLocal)? */
  private runsHere(at: LocalBrainSpec | undefined, model: string): boolean {
    return at !== undefined && brainIsLocal(brainOf(at.provider, model));
  }

  /**
   * Can the standby read what this turn carries? A turn with no picture and
   * no PDF: yes. Otherwise by what its own adapter says of ITS model (a small
   * standby often cannot see when the main model can).
   */
  private standbyReads(needs: MediaFlags | undefined): boolean {
    if (!needs?.image && !needs?.pdf) return true;
    const spare = this.local.fallback;
    if (!spare) return false;
    const caps = spare.provider.getCapabilities(spare.model);
    return (!needs.image || caps.vision === true) && (!needs.pdf || caps.pdfInput === true);
  }

  /** Is the standby model known to run on Ollama's servers, whatever it is called? */
  private standbyElsewhere(): boolean {
    const spare = this.local.fallback;
    return spare !== undefined && this.runsElsewhere(spare, spare.model);
  }

  /** Is it known to run somewhere else: its Ollama lists it with a remote host (./ollama-locality)? */
  private runsElsewhere(at: LocalBrainSpec | undefined, model: string): boolean {
    return at !== undefined && LOCALITY.runsElsewhere(brainOf(at.provider, model).baseURL, model);
  }

  /**
   * Route a turn, asking the model server what runs on it NOW when the turn
   * STAYS HERE (a message Will kept private, in any mode, and every turn of
   * Local mode). This is how the handlers route: before anything of the turn
   * is sent anywhere (the router's and recall's embeddings included), and
   * before the turn is refused or planned.
   *
   * The look is where the server says where each of its models really runs
   * (./ollama-locality), and what was known can be a minute old in the cloud
   * mode, where no timer watches the server. A name pointed at a cloud model
   * while Flint was running (`ollama cp gpt-oss:120b-cloud mine`) would
   * otherwise keep answering private turns until the next look (the privacy
   * review's N5); and one pointed back at a model of its own would keep being
   * refused. So a look taken a moment ago does not stand in for this one (only
   * one already under way does), and the turn waits for it: as long as a look
   * may take, two seconds. A look that comes back without the server's
   * listing leaves nothing it said before believed to run here
   * (./ollama-locality silent), so the turn is planned on no model, and gets a
   * sentence: it is never decided on a word the server no longer stands behind.
   *
   * A turn that does not stay here is not held up at all. Neither is one the
   * settings alone already refuse (a model server on another machine, or
   * reached through a proxy): nothing that server says changes that answer.
   */
  async routeFirst(i: RouteAsk): Promise<PreRoute> {
    const { attachments: _files, ownLocalModel: _own, earlier: _earlier, ...ask } = i;
    // What the local model can read of this turn's files, once: a PDF is read here (./local-media) before the
    // route is decided, and both decisions below are made on the same answer.
    const reads = await this.localReads(i);
    const asked = preRoute({ ...ask, mode: this.mode.current(), ...reads });
    if (!('error' in asked) && turnStaysHere(asked) && this.local.confined.ok) {
      await this.local.monitor.check().then(
        () => undefined,
        () => undefined,
      );
    }
    return this.preRoute({ ...ask, ...reads });
  }

  /**
   * Look at the model server again, when what is known of it is more than a
   * moment old, before a turn is planned. The plan is made from the monitor's
   * last look, and in the local and hybrid modes that look can be 15 seconds
   * old: a turn sent just after the main model left memory was planned as if
   * it were loaded, and was the request that LOADED it (the routing review's
   * A8). One cheap look (three GETs on loopback) closes that gap to
   * milliseconds. It never holds a turn: past FRESH_WAIT_MS the turn goes on
   * with what was known, and the first-token deadline is the bound.
   *
   * The cloud mode plans nothing from the model's state, and looks at nothing
   * for a turn the cloud answers. It looks for one thing only: `route` is a
   * turn the local model is to answer, and where its model runs is not known
   * right now (./policy brainIsLocal: an Ollama's listing that nobody keeps
   * current in this mode, for a server on another machine that Will allowed or
   * an Ollama asked over the OpenAI-compatible wire). A private turn there is
   * then decided on the server's own word, not refused for want of it. (A
   * turn that stays here has already had its own look, `routeFirst`.)
   */
  async freshen(route?: { brain: 'local' | 'frontier' }): Promise<void> {
    const monitor = this.local.monitor;
    const p = monitor.snapshot().primary;
    if (p.checkedAt !== 0 && this.now() - p.checkedAt < FRESH_FOR_MS) return;
    if (this.mode.current() === 'cloud' && !(route?.brain === 'local' && this.local.confined.ok && this.primary.settled && !this.runsHere(this.primary, this.primary.model))) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      monitor.check().then(
        () => undefined,
        () => undefined,
      ),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, FRESH_WAIT_MS);
        timer.unref?.();
      }),
    ]).finally(() => clearTimeout(timer));
  }

  /** The cloud tiers a hybrid turn falls through to when no local model could answer it; undefined when none can either. */
  cloudChain<P>(i: { brains: BrainChooser<P> | undefined; tier: Tier; guard: BudgetView; breaker: Pick<FrontierBreaker, 'paused'>; canRead?: ((brain: BrainTier<P>) => boolean) | undefined }): { chain: BrainTier<P>[]; tier: Tier } | undefined {
    return cloudChainFor(i);
  }

  /**
   * Does asking this brain keep the prompt on this Mac? ./policy brainIsLocal,
   * the one place that is decided, with what this server's settings say about
   * addresses (told to it when this was built): a local wire, a model that is
   * not an Ollama cloud model and that its Ollama says runs on it, and a
   * server at a loopback address or the one Will said is his own, never
   * through a proxy. (isLocalTurn asks the other question, about the turn that
   * is running: is a local model answering it right now.)
   */
  brainIsLocal(provider: { readonly name: string }, model: string): boolean {
    return brainIsLocal(brainOf(provider, model));
  }

  /**
   * Why the helpers that always talk to Ollama's own address (the embedder,
   * local memory extraction, the runtime's background calls) must not be sent
   * anything right now; undefined when they may. In the local and hybrid modes
   * "local" means this Mac, and those helpers read OLLAMA_HOST as it is: with
   * an Ollama on another machine that is not the model server Will allowed,
   * they would still send it the text of his messages. The cloud mode is as
   * it always was, except for a private message.
   *
   * `model`: the model the request is for. The address is not the whole of it:
   * a cloud model under a plain name answers at this Mac's own Ollama and runs
   * on Ollama's servers (./ollama-locality has that Ollama's word on it). So:
   *  - a private message is sent only to a model Ollama lists as its own: an
   *    embedding model that is such a copy, or one Ollama has not been heard
   *    on, embeds none of its words;
   *  - a turn that stays here by its route (every turn of Local mode) is held
   *    the same way: its words go only to a model Ollama lists as its own. A
   *    server that gives no word is not one, so with the listing silent the
   *    turn's words are embedded nowhere, and the turn gets its sentence
   *    instead of waiting on a request to a server that does not answer;
   *  - anything else made in the local and hybrid modes (the tools'
   *    descriptions embedded while Flint boots, before any server has
   *    answered: nobody's words) is sent unless the model is KNOWN to be such
   *    a copy.
   */
  helpersOff(model?: string): string | undefined {
    // Text that stays here whatever the mode: a private message's words and the words of a turn its route keeps
    // here (the request was marked where it was routed), and what a helper sends of a fact or a turn that stays
    // here (./turn-taint asKeptText).
    const kept = carriesKeptText();
    const here = isStaysHereRequest();
    const strict = here || kept;
    const mustStay = strict || this.mode.current() !== 'cloud';
    if (!ollamaIsLocal(this.cfg)) {
      if (isPrivateRequest()) return 'the Ollama server is on another machine, and a private message is not sent off this Mac';
      if (kept) return 'the Ollama server is on another machine, and what stays on this Mac is not sent to it';
      return mustStay ? 'the Ollama server is on another machine, and in this mode nothing is sent off this Mac' : undefined;
    }
    if (model === undefined) return undefined;
    if (isPrivateRequest() && !this.helperRunsHere(model)) return 'the model asked for is not known to run on this Mac, and a private message is not sent to it';
    if (here && !this.helperRunsHere(model)) return 'the model asked for is not known to run on this Mac, and a turn that stays on this Mac is not sent to it';
    if (kept && !this.helperRunsHere(model)) return 'the model asked for is not known to run on this Mac, and what stays on this Mac is not sent to it';
    if (mustStay && this.helperElsewhere(model)) return "the model asked for runs on Ollama's servers, and in this mode nothing is sent off this Mac";
    return undefined;
  }

  /**
   * Before a helper's request is sent: have Ollama's own address asked what
   * runs on it, when its word is more than two seconds old, and wait for the
   * answer (./ollama-locality fresh). Only an Ollama that is here is asked:
   * nothing another machine says makes its models local.
   */
  async helpersHeard(): Promise<void> {
    const base = this.helperBase;
    if (base && ollamaIsLocal(this.cfg)) await this.listing(base);
  }

  /**
   * The fetch a helper that always talks to Ollama's own address is built
   * with: the embedder and local memory extraction (`helper`), and the
   * runtime's background calls (`background`). Each request is decided where
   * it is SENT, on a listing no more than two seconds old: Ollama is asked
   * first (`helpersHeard`), then the helpers' rule is read (`helpersOff`, or
   * for a background call the rule of `helperBrain`). A request that may not
   * be sent fails like an Ollama that is down, which every one of them
   * already lives with.
   *
   * So the rule no longer rests on what was known a minute ago: a model
   * pointed at a cloud model while Flint runs is found by the next request
   * that would have carried something to it.
   */
  helperFetch(kind: 'helper' | 'background', base: typeof fetch = fetch): typeof fetch {
    return (async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      // Asked first only where the answer decides something: a request for a private message or for a turn its
      // route keeps here, one that carries text that stays here, a background call (answered only by a model that
      // runs here), and any request outside the cloud mode (where nothing may go to a model on Ollama's servers).
      // An ordinary request in the cloud mode is sent whatever the listing says, so it does not wait for one: a
      // model server whose listing hangs would otherwise hold every ordinary turn's embedding for as long as an
      // ask may take.
      if (kind === 'background' || isStaysHereRequest() || carriesKeptText() || this.mode.current() !== 'cloud') await this.helpersHeard();
      const model = helperModel(init?.body);
      const off = kind === 'background' ? this.backgroundOff(model) : this.helpersOff(model);
      if (off) throw new TypeError(`fetch refused: ${off}`);
      return base(url, init);
    }) as typeof fetch;
  }

  /** Why a background call may not ask this model right now; undefined when it may (the rule `helperBrain` reads). */
  private backgroundOff(model: string | undefined): string | undefined {
    const off = this.helpersOff();
    if (off) return off;
    if (!ollamaIsLocal(this.cfg) || model === undefined) return undefined;
    return this.helperRunsHere(model) ? undefined : 'the model asked for is not known to run on this Mac, and a background call is answered only by a model that does';
  }

  /** Ollama's own address, as the helpers use it (OLLAMA_HOST as config checked it); undefined when it was refused. */
  private get helperBase(): string | undefined {
    const at = this.cfg.local.ollama;
    return at ? `${at.origin}${at.path}` : undefined;
  }

  /** Is this model, at Ollama's own address, one that Ollama lists as running on it? */
  private helperRunsHere(model: string): boolean {
    return LOCALITY.runsHere(this.helperBase, model);
  }

  /** Is this model, at Ollama's own address, a cloud model under another name (its listing gives it a remote host)? */
  private helperElsewhere(model: string): boolean {
    return LOCALITY.runsElsewhere(this.helperBase, model);
  }

  /**
   * The local model a background call (the runtime's /internal/complete) may
   * ask right now, or undefined: the gate then answers "no local model". Those
   * calls carry Will's own data and are answered by a local model in every
   * mode, never an outside one, so on this Mac's Ollama the model has to be one
   * Ollama's own listing says runs there. A cloud model under a plain name is
   * not, and neither is a model Ollama has not been heard on: this is the same
   * listing every other "is it here" reads (./ollama-locality), never the name.
   * (An Ollama on another machine is asked in the cloud mode only, as it
   * always was, and `helpersOff` already keeps the other modes off it.)
   * This reads what is known when the gate looks for a brain; the request
   * itself is decided again where it is sent (`helperFetch('background')`).
   */
  helperBrain<T extends { model: string }>(brain: T | undefined): T | undefined {
    return brain && this.backgroundOff(brain.model) === undefined ? brain : undefined;
  }

  /**
   * The tools as the server has them wired (before ./spend meterPaidTools hides
   * the keyless switch): which outside tools can run with no outside service,
   * and so stay offered while outside services are off.
   */
  declareTools(tools: readonly Tool[]): void {
    this.withheld = withheldWhenOff(tools, this.paid);
  }

  /**
   * Why a paid tool may not reach its vendor on the call being made, as a
   * sentence for the model; undefined when it may (./outside-ai). A private
   * turn: nothing leaves this Mac. Local mode, or a turn that was routed in
   * Local mode and is still running after the mode changed: no outside AI and
   * no paid service. Read on every call (./spend meterPaidTools), so it reaches
   * the searches deep_research makes itself.
   */
  outsideOff(): OutsideOff | undefined {
    if (isPrivateTurn()) return outsideOffPrivate(this.allowedRemote());
    if (this.mode.current() === 'local' || isStaysHereTurn()) return OUTSIDE_OFF_LOCAL_MODE;
    return undefined;
  }

  /** One log line for an outside tool that refused: its name and which rule, never its arguments. */
  outsideRefused(name: string, why: string): void {
    this.log(`[inference] outside tool refused (${name}, ${isPrivateOff(why) ? 'private' : 'local_mode'})`);
  }

  /**
   * The tools a turn is offered (./outside-ai).
   *  - A private turn, in any mode: only the tools that run on this Mac. No
   *    web search, page fetch, account tool or research.
   *  - An ordinary turn in Local mode: every tool but the paid ones that are
   *    an outside AI or a paid service; a search with a keyless switch stays
   *    (it runs keyless), and so do the page fetch and Will's account tools.
   *  - Any other turn: all of them.
   */
  offer<T extends { definition: { name: string } }>(tools: readonly T[], route: { mode: InferenceMode; private?: boolean }): T[] {
    if (route.private === true) return offeredPrivate(tools);
    return offered(tools, this.withheld, route.mode === 'local');
  }

  /**
   * Why a cloud call of this kind must not be made right now (Local mode), or
   * undefined when it may. A refusal is logged, at most once per kind every
   * ten minutes.
   */
  cloudRefused(kind: CloudCallKind): string | undefined {
    if (this.mode.current() !== 'local') return undefined;
    const t = this.now();
    if (t - (this.refusalLoggedAt.get(kind) ?? -Infinity) >= REFUSAL_LOG_EVERY_MS) {
      this.refusalLoggedAt.set(kind, t);
      this.log(`[inference] cloud call refused in local mode (kind=${kind})`);
    }
    return 'Flint is in Local mode, which never uses the cloud.';
  }

  /** `fn`, refused in Local mode with an error a background caller reads as "not available now". */
  cloudOnly<A extends unknown[], R>(kind: CloudCallKind, fn: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
    return async (...args) => {
      const refused = this.cloudRefused(kind);
      if (refused) throw new FlintError(makeAiError('provider_unavailable', refused, { retryable: false, providerCode: 'local_mode' }));
      return fn(...args);
    };
  }

  /**
   * What a turn's response says about its route (the meta event, the /generate
   * body): the mode, the rule that decided, and `private` when Will asked for
   * the turn to stay on this Mac. A client reads `private` to keep the reply
   * off every outside service it could reach itself (the neural voice).
   */
  routeFields(route: ModeRoute): { mode: InferenceMode; reason: string; private?: true } {
    return { mode: route.mode, reason: route.reason, ...(route.private ? { private: true as const } : {}) };
  }

  /** The status, after one fresh look at the model server (bounded by the probe's own timeout). */
  async status(cloud?: InferenceStatus['cloud']): Promise<InferenceStatus> {
    const snapshot = await this.local.monitor.check();
    const machine = this.machine();
    const embedModel = this.embedModel;
    // Whether a recording could be transcribed right now: the same look the provider takes before each one.
    const lacks = transcriptionMissing(this.voicePlan.stt, this.fileExists);
    return inferenceStatus({
      embedding: { model: embedModel, installed: await this.embedInstalled(embedModel, snapshot.reachable) },
      mode: this.mode.current(),
      modeSource: this.mode.source(),
      ...(machine ? { hardware: machine.hardware, tier: machine.tier } : {}),
      tierSource: this.cfg.hardwareTier === 'auto' ? 'detected' : 'override',
      local: this.localNow,
      ...(this.standbyElsewhere() ? { standbyElsewhere: true } : {}),
      snapshot,
      voice: this.voicePlan,
      ...(lacks ? { transcriptionMissing: lacks } : {}),
      ...(cloud ? { cloud } : {}),
    });
  }

  /** The embedding model in use: FLINT_EMBED_MODEL when it names one, else the tier table's (@flint/core EMBEDDING_MODEL). */
  get embedModel(): string {
    return this.cfg.local.embedModel ?? EMBEDDING_MODEL.model;
  }

  /**
   * Does the model server have the embedding model? Only Ollama's own API can
   * say, and the embedder always talks to that address: on the other wire, or
   * with the server not answering, nobody knows (`undefined`). One read-only look.
   */
  private async embedInstalled(model: string, reachable: boolean): Promise<boolean | undefined> {
    const backend = this.local.backend;
    if (!backend || !reachable || this.local.wire !== 'ollama' || backend.kind !== 'ollama') return undefined;
    try {
      return (await backend.probe([model], AbortSignal.timeout(EMBED_LOOK_MS))).models[model]?.installed;
    } catch {
      return undefined;
    }
  }

  /**
   * What is answering, for the training_status tool ("what are you running
   * on?"): the mode, and the local model's state. Enums only.
   */
  serving(): { mode: InferenceMode; localState: string } {
    const p = this.local.monitor.snapshot().primary;
    return { mode: this.mode.current(), localState: p.state === 'unavailable' ? `unavailable (${p.why ?? 'error'})` : p.state };
  }
}

export interface BuildInferenceDeps {
  env: Env;
  /** Where the mode Will sets is saved (`~/.flint/inference.json`). */
  modeFile: string;
  log?: (msg: string) => void;
  fetch?: typeof fetch;
  connect?: BuildLocalDeps['connect'];
  /** Injectable hardware detection (tests: nothing is spawned). */
  detect?: () => Promise<Hardware>;
  pick?: BuildLocalDeps['pick'];
  /**
   * Look, never load: no health timer, no warm-up and no asking again, in any
   * mode. For the status command, which must leave the model server exactly as
   * it found it (a status that started a load would evict a model the running
   * server is using).
   */
  observeOnly?: boolean;
  /**
   * Is there a file at this path? For the program and the model a setting
   * names (./inference-config): one that is not there when Flint starts is
   * refused, and the usual one is used. Default: the real file system. A test
   * hands one in.
   */
  fileExists?: FileCheck;
  /**
   * Have the server at an address asked what runs on it, when its word is more
   * than two seconds old. Default: the server's own record
   * (./ollama-locality fresh). A test hands one in.
   */
  listing?: (baseURL: string) => Promise<void>;
  /**
   * What reads a PDF's text, in place of the program FLINT_LOCAL_PDF names
   * (./pdf-text). Used only when that setting is on. A test hands one in.
   */
  pdfReader?: PdfReader;
}

/**
 * Read the config and the saved mode and build the local brain. Never throws.
 *
 * It waits for one thing, and only when no model is named on Ollama's own API:
 * the model pick, which the clock cuts off (./local-model LOCAL_PICK_CAP_MS).
 * The server listens right after. Behind it, in this order: the machine is
 * looked at (./hardware) and sorted into a tier, the tier's model and standby
 * are applied, and the model server is looked at once (the boot log, the
 * status, and what the model can do). `ready` is over when that is.
 *
 * The health timer runs in the local and hybrid modes only, where a model that
 * is installed and not in memory is also warmed, and both follow the mode when
 * Will changes it: in the cloud mode nothing new is on a turn's path and
 * nothing is loaded ahead of one. `observeOnly` (the status command) takes the
 * one look and does neither.
 */
export async function buildInference(deps: BuildInferenceDeps): Promise<Inference> {
  const log = deps.log ?? (() => {});
  const cfg = readInferenceConfig(deps.env, log, { fileExists: deps.fileExists ?? isFile });
  const mode = new ModeStore({ file: deps.modeFile, envMode: cfg.mode, envSource: cfg.modeSource, log });
  // The machine, once, behind the boot: which tier it is in, and so which model to prefer when none is named.
  // Detection cannot throw and is cut off by the clock (./hardware); a failure of an injected one is "no accelerator".
  let machine: Machine | undefined;
  const looked: Promise<HardwareTier | undefined> = (async () => {
    const hardware = await (deps.detect ?? detectHardware)();
    const tier = cfg.hardwareTier === 'auto' ? hardwareTierFor(hardware) : hardwareTier(cfg.hardwareTier);
    machine = { hardware, tier };
    log(
      `[local] hardware: ${hardware.accelerator}${hardware.chip ? ` (${hardware.chip})` : ''}, ${hardware.memoryGb} GB; tier ${tier.id}` +
        `${cfg.hardwareTier === 'auto' ? '' : ' (set by FLINT_HARDWARE_TIER)'}; recommended ${tier.model} at context ${tier.contextLength}`,
    );
    for (const note of hardware.notes) log(`[local] hardware: ${note}`);
    return tier;
  })().catch(() => undefined);
  // What reads a PDF's text on this Mac for the local model (FLINT_LOCAL_PDF; it ships off, and then nothing does).
  // A status command reads no PDF, and builds no reader.
  const media = cfg.local.pdf && !deps.observeOnly ? localMedia(deps.pdfReader ?? makePdfReader(cfg.local.pdf)) : undefined;
  // One line, names only, when either is on: what a restart turned on is in the log.
  if (cfg.local.vision || cfg.local.pdf) {
    log(`[local] on for the local model: ${[cfg.local.vision ? 'pictures (FLINT_LOCAL_VISION)' : '', cfg.local.pdf ? `PDF text by ${cfg.local.pdf.reader} (FLINT_LOCAL_PDF)` : ''].filter(Boolean).join(', ')}`);
  }
  // The object main() holds, once it is built (below): the local adapters ask it, for every request, whether a
  // file's content may go to the model server (`confined`), and to look at the server again after a long wait.
  // Until it exists, the answer is no.
  let built: Inference | undefined;
  const filesStayHere = (): boolean => built?.confined.ok === true;
  const handle = await startLocalBrains({
    cfg,
    env: deps.env,
    filesStayHere,
    ...(media ? { readsPdfs: (inner: ProviderAdapter) => media.provider(inner, { filesStayHere, lookAgain: (p, m) => (built ? built.lookAgain(p, m) : Promise.reject(new FlintError(makeAiError('provider_unavailable', 'Flint is still starting.', { retryable: true })))) }) } : {}),
    // A tier Will named needs no look at the machine: the brain is built on it from the start.
    tier: cfg.hardwareTier === 'auto' ? looked : hardwareTier(cfg.hardwareTier),
    ...(deps.pick ? { pick: deps.pick } : {}),
    ...(deps.observeOnly ? { once: true } : {}),
    // The local deadlines belong to the local and hybrid modes: the cloud mode behaves as it did,
    // and an eval replay measures the model it named however slow it is.
    deadlinesOn: () => mode.current() !== 'cloud' && !isEvalTurn(),
    // A main model that leaves memory is loaded again in those modes, never by a status command.
    rewarm: () => !deps.observeOnly && mode.current() !== 'cloud',
    // With no model named, this machine's tier chooses it in those modes only. In the cloud mode the choice is
    // what it always was (the model Ollama has loaded), so no local turn there loads another model.
    preferTier: () => mode.current() !== 'cloud',
    // What the model server says it is, each time the monitor looks at it, and where each of its models really runs
    // (./ollama-locality).
    place: (baseURL, said) => (said === 'other' ? LOCALITY.notOllama(baseURL) : LOCALITY.learn(baseURL, said.ollama)),
    // ...and a look that came back without that answer leaves nothing it said before believed to run here: a turn
    // that stays here waited for this look, and is not decided on a listing the server no longer stands behind.
    // (As of when the look began: a word the server gave another asker during the look is kept.)
    silent: (baseURL, since) => LOCALITY.silent(baseURL, since),
    // ...and a model it says runs elsewhere is never loaded ahead of a turn.
    elsewhere: (baseURL, model) => LOCALITY.runsElsewhere(baseURL, model),
    log,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(deps.connect ? { connect: deps.connect } : {}),
  });
  const monitor = handle.current().monitor;
  // The timer follows the mode at once.
  const timer = (): void => {
    if (mode.current() === 'cloud') monitor.stop();
    else monitor.start();
  };
  // In the local and hybrid modes a model that is installed and not in memory is loaded now, by the monitor, so
  // that no turn is the one that waits for it. (Only a cold model is warmed; nothing is ever downloaded.)
  const warm = (): void => {
    if (mode.current() === 'cloud') return;
    monitor.warm('primary');
    monitor.warm('fallback');
  };
  const ready = Promise.all([looked, handle.ready]).then(() => {
    if (deps.observeOnly) return;
    timer();
    warm();
  });
  if (!deps.observeOnly) {
    // A change while running: the timer now, then one look at the server, then the warm-up from what it found.
    const follow = (): void => {
      timer();
      void monitor
        .check()
        .catch(() => undefined)
        .then(warm);
    };
    mode.onChange(() => {
      // The rule for an unnamed model is the mode's: it is asked again, and a model it adopts is followed below.
      void handle.repick();
      follow();
    });
    // A brain adopted behind the boot (the tier's model, the server's late answer) is looked at and warmed the same way.
    handle.onChange(() => void ready.then(follow));
  }
  built = new Inference({ cfg, voice: planVoice(cfg, deps.env), handle, mode, machine: () => machine, ready, paid: paidToolSpecs(deps.env), log, ...(deps.listing ? { listing: deps.listing } : {}), ...(deps.fileExists ? { fileExists: deps.fileExists } : {}), ...(media ? { media } : {}) });
  return built;
}
