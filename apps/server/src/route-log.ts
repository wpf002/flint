/**
 * One `[route]` line per answered message: the tier it was sorted into, what
 * moved it there, and which brain answered.
 *
 * Why: on 2026-09-30 three greetings sent to test the routine tier (then
 * claude-sonnet-5-5) were all answered by Opus 5.5, and the log could not say
 * why: nothing recorded a message's tier, the tools the router appended (any
 * append moves a routine one-liner to standard), or who answered. This line
 * records exactly that, as JSON so it can be counted. Never the message text,
 * the conversation, or anything the user wrote: tier, tool names and scores,
 * model labels, outcome, timing.
 *
 * With the routing modes it also says which mode the turn was decided in, the
 * rule (or mode) that decided it, and the adapter that served the answer: which
 * provider served each turn, and why.
 */
import { classifyMessage, LONG_CONVERSATION, parseBrainLabel, type Tier } from '@flint/core';

export type Outcome = 'answered' | 'unanswered' | 'empty' | 'error' | 'aborted';

/** How a local model's prompt was sized to its window. Numbers only. */
export interface PromptFit {
  window: number;
  dropped: number;
  kept: number;
  toolsShed: number;
  /**
   * The model's OWN count of the prompt reached its window. The prompt was
   * sized by an estimate; when the server's count says the window was full
   * anyway, the server may have cut it, and this line is how that is known.
   */
  full?: true;
}

/** A prompt the model counted at this share of its window, or more, is taken to have filled it. */
export const WINDOW_FULL_AT = 0.97;

/**
 * The `fit` field of a [route] line: what a local model's prompt left out, or
 * nothing at all when everything fit (the common case says nothing).
 */
export function fitFields(fit: PromptFit | undefined): { fit?: PromptFit } {
  return fit && (fit.dropped > 0 || fit.toolsShed > 0 || fit.full === true) ? { fit } : {};
}

/**
 * The observer that notes, for the turn that is running, how each LOCAL
 * model's prompt was sized (@flint/core onContext), and whether the model's own
 * count then said the window was full (onResponse). `isLocal` says which
 * providers are local wires; `note` files the size on the turn and `counted`
 * the model's count (./turn-taint noteFit, noteFitInput).
 */
export function fitObserver(
  isLocal: (provider: string) => boolean,
  note: (fit: PromptFit) => void,
  counted: (promptTokens: number) => void = () => {},
): {
  onContext: (e: { provider: string; windowTokens: number; messages: { kept: number; dropped: number }; tools: { shed: string[] } }) => void;
  onResponse: (e: { provider: string; usage: { input: number; lastInput?: number | undefined } }) => void;
} {
  return {
    onContext: (e) => {
      if (isLocal(e.provider)) note({ window: e.windowTokens, dropped: e.messages.dropped, kept: e.messages.kept, toolsShed: e.tools.shed.length });
    },
    onResponse: (e) => {
      if (isLocal(e.provider)) counted(e.usage.lastInput ?? e.usage.input);
    },
  };
}

export interface RouteRecord {
  /** Which endpoint answered: the app's /chat or the one-shot /generate. */
  path: 'chat' | 'generate';
  /** The routing mode the turn was decided in: local, cloud or hybrid (./inference-mode). */
  mode?: 'local' | 'cloud' | 'hybrid';
  /**
   * Why it went where it did: the hybrid rule that decided (`private`, `tools`,
   * `default`, ... ./hybrid-rules), or `mode_local` / `mode_cloud` / `eval`.
   */
  reason?: string;
  /**
   * Will kept this turn on this Mac (Local Only, or the words): nothing left this Mac for it (only tools that run
   * here were offered), and it is stored with the mark that keeps it out of an outside brain's history. A Local
   * mode turn without it used no outside AI and no paid service, and may still have searched the web.
   */
  private?: true;
  /** The tier classifyMessage chose. */
  tier: Tier;
  /** Set when context moved the message off the tier its words alone get (see movedBy). */
  movedBy?: string;
  /** Rest tools the router appended, with their similarity scores. */
  appended: ReadonlyArray<{ name: string; score: number }>;
  /** Complete turns of history sent (/chat only). */
  turns?: number;
  /** The tier the spend plan ran, when it is not `tier` (a budget step-down). */
  planTier?: string;
  /** Frontier or the local brain, after any fallback to local. */
  brain: string;
  /**
   * Outside providers this turn left out because the breaker had them paused
   * (./frontier-breaker), as `provider:reason` codes: `anthropic:credit`. With
   * every planned brain paused, `brain` is `local` and the local model answered.
   */
  paused?: string;
  /** The brain that answered (`provider:model` for the frontier). Only when the outcome is `answered`. */
  answeredBy?: string;
  /** The adapter that served the answer: `ollama`, `local` (an OpenAI-compatible local server), `anthropic`, ... Only when `answered`. */
  provider?: string;
  /**
   * For a turn a local model answered (./local-serve): which one (`primary`,
   * or `fallback` for the standby), the MAIN model's state when the turn was
   * planned (`loaded`, `cold`, `loading`, `unavailable`: why the standby was
   * used, when it was), and its time to first token in ms.
   */
  local?: { which: 'primary' | 'fallback'; state: 'loaded' | 'cold' | 'loading' | 'unavailable'; firstTokenMs?: number };
  /**
   * What the turn fell to when its first choice did not answer: `fallback` (the
   * standby local model), `cloud` (a hybrid turn no local model could answer),
   * or `local` (a cloud turn the local model answered).
   */
  fellTo?: 'fallback' | 'cloud' | 'local';
  /**
   * Set when a local model's prompt had to leave something out to fit its
   * window: the window in tokens, how many of the oldest messages were dropped
   * and how many were kept (the newest), and how many tools were not offered.
   * Absent when everything fit.
   */
  fit?: PromptFit;
  /** The last brain tried, when none answered: an error, an empty reply, the honest message, a hang-up. */
  tried?: string;
  /**
   * The prompt revision of the last persona asked (./style-variant
   * promptRevision): a hash of its style guide and engine paragraph, so lines
   * written before and after a prompt change can be told apart.
   */
  promptRev?: string;
  outcome: Outcome;
  /** Tiers that refused or came back empty before the one that answered (/chat). */
  declined?: number;
  ms: number;
  eval?: boolean;
  /** How memory recall ran: semantic, lexical (embedder failed), timeout, none, skipped or error. The pre-P2 baseline. */
  recall?: string;
  /**
   * Estimated tokens each context block added to the prompt (plan 3.0.8: chat overhead is measured), e.g.
   * {world: 120} on a frontier turn, {goals: 180} on a turn whose last-asked brain was given Will's goals.
   */
  ctxTokens?: Record<string, number>;
}

/**
 * Why context moved a message off the tier its words alone would get, or
 * undefined when it did not. Only the routine rule reads context: a confident
 * tool match (the router's toolsLikely: the question needs to DO things) or a
 * deep thread send a routine one-liner to standard. An append below the tier
 * score is offered but moves nothing, so it is not a reason.
 */
export function movedBy(message: string, tier: Tier, ctx: { toolsLikely: boolean; turns?: number }): string | undefined {
  if (classifyMessage(message) === tier) return undefined;
  const why: string[] = [];
  if (ctx.toolsLikely) why.push('tools');
  if ((ctx.turns ?? 0) >= LONG_CONVERSATION) why.push('deep thread');
  return why.join('+') || undefined;
}

/**
 * How a /chat turn ended. A provider failure reaches /chat as a streamed error
 * event, not a throw, so `streamErrored` counts as much as `failed`: without it,
 * Ollama being down or every tier failing was logged as `empty`.
 */
export function chatOutcome(t: {
  aborted: boolean;
  failed: boolean;
  streamErrored: boolean;
  gaveUp: boolean;
  answer: string;
}): Outcome {
  if (t.aborted) return 'aborted';
  if (t.failed || t.streamErrored) return 'error';
  if (t.gaveUp) return 'unanswered';
  return t.answer.trim() ? 'answered' : 'empty';
}

/**
 * Who to name. The last brain tried is the one that answered only when the
 * outcome is `answered`; otherwise it is only `tried`, so counting `answeredBy`
 * never credits a failure to a brain (or to the local model that never ran).
 */
export function attribution(outcome: Outcome, lastTried: string | undefined): { answeredBy?: string; tried?: string } {
  if (!lastTried) return {};
  return outcome === 'answered' ? { answeredBy: lastTried } : { tried: lastTried };
}

/**
 * Which adapter served the answer, or nothing when none did: the provider in a
 * frontier brain's label, or the local brain's own (`ollama`, or `local` on the
 * OpenAI-compatible wire). With `answeredBy` it says who answered a turn; with
 * `mode` and `reason`, why that one.
 */
export function servedBy(outcome: Outcome, brain: string, lastTried: string | undefined, localProvider: string): { provider?: string } {
  if (outcome !== 'answered' || !lastTried) return {};
  if (brain === 'local') return { provider: localProvider };
  const provider = parseBrainLabel(lastTried).provider;
  return provider ? { provider } : {};
}

/**
 * The ONLY fields a [route] line can carry, in the order they are written. A
 * line is built from these names and nothing else, so a field that is not
 * here cannot reach the log: not the message, not the prompt, not the answer,
 * whatever a caller spreads into the record. (`satisfies` holds this list to
 * the record's own keys: a new field is logged only once it is named here.)
 */
export const ROUTE_FIELDS = [
  'path',
  'mode',
  'reason',
  'private',
  'tier',
  'movedBy',
  'appended',
  'turns',
  'planTier',
  'brain',
  'paused',
  'answeredBy',
  'provider',
  'local',
  'fellTo',
  'fit',
  'tried',
  'promptRev',
  'outcome',
  'declined',
  'ms',
  'eval',
  'recall',
  'ctxTokens',
] as const satisfies ReadonlyArray<keyof RouteRecord>;
/** Every key of the record is listed above (a key that is missing makes this line fail to compile). */
const _everyRouteFieldIsListed: Exclude<keyof RouteRecord, (typeof ROUTE_FIELDS)[number]> extends never ? true : never = true;
void _everyRouteFieldIsListed;

/** The longest word or label a line carries (`provider:model`, a rule's id, a list of paused providers). */
const ROUTE_TEXT_MAX = 160;

/**
 * A field's value as the line may carry it: a number, a boolean, or a short
 * one-line label. Anything else is left out: a long string or one with a line
 * break is not a label (it is text someone wrote), and an object is rebuilt
 * from the fields it is known to have.
 */
function routeValue(key: (typeof ROUTE_FIELDS)[number], v: unknown): unknown {
  const label = (x: unknown): string | undefined => (typeof x === 'string' && x.length <= ROUTE_TEXT_MAX && !/[\r\n\u2028\u2029]/.test(x) ? x : undefined);
  const num = (x: unknown): number | undefined => (typeof x === 'number' && Number.isFinite(x) ? x : undefined);
  const obj = (x: unknown): Record<string, unknown> | undefined => (x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : undefined);
  const compact = (o: Record<string, unknown>): Record<string, unknown> | undefined => {
    const out = Object.fromEntries(Object.entries(o).filter(([, x]) => x !== undefined));
    return Object.keys(out).length > 0 ? out : undefined;
  };
  switch (key) {
    case 'appended':
      // Scores are rounded; they are compared with a 0.55 floor.
      return (Array.isArray(v) ? v : []).flatMap((a: unknown) => {
        const name = label(obj(a)?.name);
        const score = num(obj(a)?.score);
        return name !== undefined && score !== undefined ? [{ name, score: Math.round(score * 1000) / 1000 }] : [];
      });
    case 'local': {
      const o = obj(v);
      return o && compact({ which: label(o.which), state: label(o.state), firstTokenMs: num(o.firstTokenMs) });
    }
    case 'fit': {
      const o = obj(v);
      return o && compact({ window: num(o.window), dropped: num(o.dropped), kept: num(o.kept), toolsShed: num(o.toolsShed), full: o.full === true ? true : undefined });
    }
    case 'ctxTokens': {
      const o = obj(v);
      return o && compact(Object.fromEntries(Object.entries(o).map(([k, x]) => [k, /^[A-Za-z]{1,24}$/.test(k) ? num(x) : undefined])));
    }
    case 'private':
    case 'eval':
      return v === true ? true : undefined;
    case 'turns':
    case 'declined':
    case 'ms':
      return num(v);
    default:
      return label(v);
  }
}

/**
 * The log line, JSON after the tag: the time, then the fields of ROUTE_FIELDS
 * that the record has, each in the shape `routeValue` allows.
 */
export function routeLine(r: RouteRecord, now: number = Date.now()): string {
  const rec: Record<string, unknown> = { ts: new Date(now).toISOString() };
  const given = r as unknown as Record<string, unknown>;
  for (const key of ROUTE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(given, key)) continue;
    const value = routeValue(key, given[key]);
    if (value !== undefined) rec[key] = value;
  }
  return `[route] ${JSON.stringify(rec)}`;
}
