/**
 * Which brain answers a turn, by the routing mode.
 *
 *  - `cloud`: exactly ./policy routeTurn, as before the modes existed. The
 *    frontier answers unless Will asked to stay local; the hybrid rules are not
 *    consulted.
 *  - `local`: the local model, every turn. No cloud model is ever chosen, and a
 *    file the local model cannot read is refused with a sentence, never sent out.
 *  - `hybrid`: the rule table (./hybrid-rules) decides per turn. The table needs
 *    the message's tier and whether it needs tools, which are only known once
 *    the turn is under way, so a hybrid turn is routed in two steps: `preRoute`
 *    makes every refusal (before the turn is counted or anything is loaded) and
 *    leaves the route `open`; `finishRoute` walks the table.
 *
 * An eval replay (`/generate` with `eval: true`) is routed by routeTurn, not by
 * the rule table: a bake-off must measure the model it named. In the hybrid and
 * cloud modes that is all. In LOCAL mode it holds for a replay a local model
 * answers (`localOnly`, with or without a `localModel`); a replay that an
 * outside model would answer is REFUSED with a sentence. Local mode never uses
 * the cloud, and "it was only an eval" is not an exception: an eval's prompts
 * are Will's own turns, replayed.
 *
 * A PRIVATE TURN NEVER LEAVES THIS MAC, AND NO TABLE CAN MOVE IT. In hybrid a
 * private turn is routed to the local side before the rule table is walked, so
 * deleting the table's `private` row, or moving another row above it, changes
 * nothing for a private turn. (The row stays in the table: it is what the
 * README shows, and it names the reason.)
 *
 * Kept free of index.ts so it is unit-testable (index.ts runs main() on import).
 */
import type { Tier } from '@flint/core';
import { asksDeep, decideHybrid, type HybridRule, type RouteReason, type TurnFacts } from './hybrid-rules';
import type { InferenceMode } from './inference-config';
import { FORCE_LOCAL_RE, routeTurn, type Brain, type MediaFlags } from './policy';

/**
 * Is the turn that is running right now being answered by a LOCAL model?
 *
 * THE ONE PLACE TO ASK. It is true inside every local model's attempt at a
 * turn, in every mode: Local mode, a private turn, a hybrid turn the rules kept
 * here, the standby answering while the main model loads, and a cloud turn the
 * local model took over. It is false while a cloud model is being asked,
 * including the cloud step of a hybrid turn that fell through from the local
 * side. (./local-serve runLocalPlan marks each local step with ./turn-taint
 * asLocalTurn; nothing else does.) Code that may only hand something to a local
 * brain, or must keep a question off an outside AI, checks this.
 */
export { isLocalTurn } from './turn-taint';

/** A decided route: what index.ts hands to the spend plan and the breaker. */
export interface ModeRoute {
  /** `local` or `frontier`, as ./policy has it. */
  brain: Brain;
  /** A frontier failure may fall back to the local brain (false for a file the local model cannot read). */
  localFallback: boolean;
  /** A local failure may fall through to the cloud: hybrid only, and never a private turn. */
  cloudFallback: boolean;
  /** The rule that decided, or the mode itself. */
  reason: RouteReason;
  mode: InferenceMode;
  /** The turn must stay on this Mac: Local Only, or the message asked. */
  private: boolean;
}

/** A hybrid turn whose refusals are done and whose rule is not yet chosen. */
export interface OpenRoute {
  open: true;
  mode: 'hybrid';
  private: boolean;
  deep: boolean;
  mediaLocalCannotRead: boolean;
  hasFrontier: boolean;
}

export interface RouteRefusal {
  error: string;
  /**
   * 422: a file no brain that may answer can read. 409: the mode forbids what was asked (an eval replay for the
   * cloud, in Local mode). 503: the message is private and the local model server is not this Mac (./inference).
   */
  status: 422 | 409 | 503;
}

/** What an eval replay for an outside model is told in Local mode. */
export const EVAL_REFUSED_IN_LOCAL = 'Flint is in Local mode, which never uses the cloud, so this eval replay was not run. Switch the mode, or replay it on a local model.';

export type PreRoute = ModeRoute | OpenRoute | RouteRefusal;

export interface PreRouteInput {
  mode: InferenceMode;
  /** `/generate` with `eval: true`. */
  evalMode: boolean;
  message: string;
  /** `localOnly: true` on the request (the console's Local Only). */
  localOnly: boolean;
  /** `deep: true` on the request. */
  deep: boolean;
  /** A frontier brain is configured. */
  hasFrontier: boolean;
  needs: MediaFlags;
  frontierCan: MediaFlags;
  /** What the local model can read (nothing, on the native Ollama wire). */
  localCan: MediaFlags;
}

/** Did Will ask for this turn to stay on this Mac? */
export function isPrivate(message: string, localOnly: boolean): boolean {
  return localOnly || FORCE_LOCAL_RE.test(message);
}

/** The kinds of file on this turn that `can` cannot read, in words; undefined when it can read them all. */
function unreadable(needs: MediaFlags, can: MediaFlags): string | undefined {
  const image = !!needs.image && !can.image;
  const pdf = !!needs.pdf && !can.pdf;
  return image && pdf ? 'images or PDFs' : image ? 'images' : pdf ? 'PDFs' : undefined;
}

/**
 * Everything that can be decided before the turn is counted: the whole route
 * in the cloud and local modes, and every refusal in all three.
 */
export function preRoute(i: PreRouteInput): PreRoute {
  const priv = isPrivate(i.message, i.localOnly);
  if (i.evalMode || i.mode === 'cloud') {
    const r = routeTurn({ message: i.message, hasFrontier: i.hasFrontier, localOnly: i.localOnly, needs: i.needs, frontierCan: i.frontierCan });
    if ('error' in r) return { error: r.error, status: 422 };
    // Local mode never uses the cloud, an eval replay included: one a local model answers runs, any other is refused.
    if (i.mode === 'local' && r.brain !== 'local') return { error: EVAL_REFUSED_IN_LOCAL, status: 409 };
    // (In Local mode a local replay has no cloud to fall back to either: it never had one, `localFallback` is about the frontier failing.)
    return { brain: r.brain, localFallback: r.localFallback, cloudFallback: false, reason: i.evalMode ? 'eval' : 'mode_cloud', mode: i.mode, private: priv };
  }
  const cannot = unreadable(i.needs, i.localCan);
  if (i.mode === 'local') {
    if (cannot) return { error: `The local model can't read ${cannot}, and Local mode never uses the cloud. Send it as text instead.`, status: 422 };
    return { brain: 'local', localFallback: true, cloudFallback: false, reason: 'mode_local', mode: 'local', private: priv };
  }
  if (cannot) {
    // The same refusals as the cloud mode, in the same words: a private turn with a file the local
    // model cannot read, no cloud model at all, or a cloud model that cannot read it either.
    const r = routeTurn({ message: i.message, hasFrontier: i.hasFrontier, localOnly: i.localOnly, needs: i.needs, frontierCan: i.frontierCan });
    if ('error' in r) return { error: r.error, status: 422 };
  }
  return { open: true, mode: 'hybrid', private: priv, deep: i.deep || asksDeep(i.message), mediaLocalCannotRead: cannot !== undefined, hasFrontier: i.hasFrontier };
}

/** Could this turn be answered by a cloud model? What the tier classifier's "deep thread" rule is sized for. */
export function mayUseCloud(pre: ModeRoute | OpenRoute): boolean {
  return 'open' in pre || pre.brain === 'frontier';
}

export interface FinishInput {
  tier: Tier;
  toolsLikely: boolean;
  promptTokens: number;
  local: TurnFacts['local'];
}

/** The facts the rule table is asked about, for one hybrid turn. */
export function turnFacts(open: OpenRoute, more: FinishInput): TurnFacts {
  return {
    private: open.private,
    deep: open.deep,
    tier: more.tier,
    toolsLikely: more.toolsLikely,
    promptTokens: more.promptTokens,
    mediaLocalCannotRead: open.mediaLocalCannotRead,
    local: more.local,
    cloud: { available: open.hasFrontier },
  };
}

/** A hybrid turn, once its tier and tools are known: walk the rule table. A decided route passes through. */
export function finishRoute(pre: ModeRoute | OpenRoute, more: FinishInput, rules?: readonly HybridRule[]): ModeRoute {
  if (!('open' in pre)) return pre;
  // A private turn is decided here, before the table: no edit to the table can send it anywhere else.
  if (pre.private) return { brain: 'local', localFallback: true, cloudFallback: false, reason: 'private', mode: 'hybrid', private: true };
  const d = decideHybrid(turnFacts(pre, more), rules);
  // A table that sends a turn to a cloud that is not configured (a row was moved): this Mac, or nothing.
  if (d.route === 'cloud' && pre.hasFrontier) {
    return { brain: 'frontier', localFallback: d.fallThrough && !pre.mediaLocalCannotRead, cloudFallback: false, reason: d.reason, mode: 'hybrid', private: pre.private };
  }
  return { brain: 'local', localFallback: true, cloudFallback: d.route === 'local' && d.fallThrough && pre.hasFrontier && !pre.private, reason: d.reason, mode: 'hybrid', private: pre.private };
}
