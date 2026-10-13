/**
 * Whether this turn has read untrusted text (Machine plan 3.0.3).
 *
 * Every request runs in its own scope (index.ts wraps handle()). A tool result
 * from anywhere other than Will or Flint's own code (the web, Nexus, mail,
 * GitHub, Drive...) marks the turn tainted, and from then on the tier engine
 * moves network egress and writes to APPROVAL for the rest of that turn: text a
 * stranger wrote cannot steer Flint into sending data out or changing anything
 * without Will seeing it first.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';

export class TurnTaint {
  readonly sources = new Set<string>();
  /** An eval replay (apps/parity, evolve): nothing it asks for is ever queued or proposed. */
  eval = false;
  /** When tainted by its history: the time of the newest untrusted read behind it (./conversation-taint). */
  historyOrigin: number | undefined;
  /**
   * One-time allowances for exact calls Will approved, valid only inside the
   * scope that runs that approval (a concurrent turn cannot spend them).
   */
  readonly allowances = new Set<string>();
  /** Names this turn as a proposal's origin (`chat:<id>`). */
  readonly id = randomBytes(8).toString('hex');
  /** Proposals this turn filed (RAM queue or runtime), for the console's approval cards; a chat filed each (`chat:<id>`). */
  readonly proposed: Array<{ id: string; fullName: string; args: unknown; tainted: boolean; status: 'pending'; origin: string }> = [];
  /**
   * The tools this turn called (names only, refused and queued calls included),
   * for the runtime's chat.turn event. A scope opened inside the turn (deep_research's)
   * shares its parent's set, so the searches it makes are the turn's too.
   */
  tools = new Set<string>();
  /**
   * How the prompt of the last LOCAL model this turn asked was sized to its
   * window (./route-log PromptFit): what history and which tools had to be left
   * out. Numbers only. Undefined when no local model was asked.
   */
  fit: { window: number; dropped: number; kept: number; toolsShed: number; full?: true } | undefined;
  /**
   * Will asked for this request's message to stay on this Mac (Local Only, or
   * the words), known from the moment it is routed: before the router or recall
   * has embedded a word of it (markPrivateRequest). A scope opened inside the
   * request inherits it.
   */
  private = false;
  get tainted(): boolean {
    return this.sources.size > 0;
  }
}

const scope = new AsyncLocalStorage<TurnTaint>();

/** Run `fn` as one turn with its own taint state, optionally starting from what it carries. */
export function withTurnTaint<T>(fn: () => T, seed: { sources?: readonly string[]; eval?: boolean; allow?: readonly string[]; tools?: Set<string> | undefined } = {}): T {
  const t = new TurnTaint();
  for (const s of seed.sources ?? []) t.sources.add(s);
  for (const a of seed.allow ?? []) t.allowances.add(a);
  t.eval = seed.eval === true;
  if (seed.tools) t.tools = seed.tools;
  t.private = scope.getStore()?.private === true;
  return scope.run(t, fn);
}

/** The current turn's state, for a listener that runs outside its scope (a response's 'finish'). */
export function currentTurn(): TurnTaint | undefined {
  return scope.getStore();
}

/** Note a tool the current turn called. Outside a turn, nothing. */
export function noteTool(name: string): void {
  scope.getStore()?.tools.add(name);
}

/** Note how a local model's prompt was sized for the current turn. Outside a turn, nothing. */
export function noteFit(fit: NonNullable<TurnTaint['fit']>): void {
  const t = scope.getStore();
  if (t) t.fit = fit;
}

/**
 * The model's own count of the prompt it was just sent, for the current turn:
 * at `fullAt` of its window or more, the turn's fit says the window was full.
 */
export function noteFitInput(promptTokens: number, fullAt = 0.97): void {
  const fit = scope.getStore()?.fit;
  if (fit && fit.window > 0 && promptTokens >= fit.window * fullAt) fit.full = true;
}

/** How the last local model this turn asked had its prompt sized, if one was asked. */
export function turnFit(): TurnTaint['fit'] {
  return scope.getStore()?.fit;
}

/** The tools the current turn called, in the order first called. */
export function turnTools(): string[] {
  return [...(scope.getStore()?.tools ?? [])];
}

/** This turn's history carries untrusted text read at `origin`: it is tainted from here on. */
export function taintFromHistory(origin: number): void {
  const t = scope.getStore();
  if (!t) return;
  t.sources.add('history');
  t.historyOrigin = Math.max(t.historyOrigin ?? 0, origin);
}

/** The newest untrusted read this turn's history carried, if any. */
export function historyOrigin(): number | undefined {
  return scope.getStore()?.historyOrigin;
}

const localScope = new AsyncLocalStorage<{ private: boolean; staysHere: boolean }>();

/**
 * Run `fn` as (part of) a turn the LOCAL model is answering: Local-only, a
 * question Will asked to keep private, or a frontier turn handed to the local
 * model. Its own store, not the turn's, so it reaches a scope opened inside the
 * turn too (deep_research runs in one): nothing the local model's turn sets off
 * may quietly send the question to an outside AI (isLocalTurn).
 *
 * Two things a turn can have promised, which are not the same (./outside-ai):
 *  - `private`: Will asked for THIS turn to stay on this Mac (Local Only, or
 *    the words). Then nothing it sets off leaves this Mac at all: only tools
 *    that run here answer (isPrivateTurn);
 *  - `staysHere`: the turn was routed as one that stays here, which is a
 *    private turn or ANY turn of Local mode. Then nothing it sets off reaches
 *    an outside AI or a paid service, even if the mode is changed while it is
 *    still running (isStaysHereTurn).
 */
export function asLocalTurn<T>(fn: () => T, opts: { private?: boolean; staysHere?: boolean } = {}): T {
  return localScope.run({ private: opts.private === true, staysHere: opts.staysHere === true || opts.private === true }, fn);
}

/** Is this the local model's turn (asLocalTurn)? */
export function isLocalTurn(): boolean {
  return localScope.getStore() !== undefined;
}

/** Is this a turn Will asked to keep on this Mac (explicitly private), being answered by a local model? */
export function isPrivateTurn(): boolean {
  return localScope.getStore()?.private === true;
}

/** Is this a turn that was routed to stay on this Mac: private, or any turn of Local mode? */
export function isStaysHereTurn(): boolean {
  return localScope.getStore()?.staysHere === true;
}

/**
 * This request's message is private: from here on, nothing made on its behalf
 * may send its text off this Mac, the helpers that embed it included
 * (./inference helpersOff). Outside a request, nothing.
 */
export function markPrivateRequest(): void {
  const t = scope.getStore();
  if (t) t.private = true;
}

/** Is this request one whose message Will asked to keep on this Mac? */
export function isPrivateRequest(): boolean {
  return scope.getStore()?.private === true;
}

const keptScope = new AsyncLocalStorage<true>();

/**
 * Run `fn` as a request that CARRIES TEXT WHICH STAYS ON THIS MAC, whoever
 * makes it and in whatever mode: a fact that stays here being embedded, a
 * turn that stays here being mined for memory. It is no turn of Will's, so
 * `markPrivateRequest` does not cover it. The helpers that talk to Ollama read
 * it where the request is sent (./inference helperFetch): such a request goes
 * only to a model that Ollama, asked a moment ago, lists as its own.
 */
export function asKeptText<T>(fn: () => T): T {
  return keptScope.run(true, fn);
}

/** Is the request being made one that carries text which stays on this Mac (asKeptText)? */
export function carriesKeptText(): boolean {
  return keptScope.getStore() === true;
}

/** This turn is an eval replay. */
export function markEval(): void {
  const t = scope.getStore();
  if (t) t.eval = true;
}

/** Is this turn an eval replay? */
export function isEvalTurn(): boolean {
  return scope.getStore()?.eval ?? false;
}

/** Spend this turn's one-time allowance for `key`, if it has one. Outside a turn, none. */
export function takeAllowance(key: string): boolean {
  return scope.getStore()?.allowances.delete(key) ?? false;
}

/** Mark the current turn as having read untrusted text from `source`. Outside a turn, nothing. */
export function markTainted(source: string): void {
  scope.getStore()?.sources.add(source);
}

/** Has the current turn read untrusted text? Outside a turn, false. */
export function turnTainted(): boolean {
  return scope.getStore()?.tainted ?? false;
}

/** Note a proposal this turn filed (once per id). Its origin is this turn: the console's card says a chat filed it. */
export function noteProposal(p: { id: string; fullName: string; args: unknown; tainted: boolean }): void {
  const t = scope.getStore();
  if (t && !t.proposed.some((x) => x.id === p.id)) t.proposed.push({ ...p, status: 'pending', origin: `chat:${t.id}` });
}

/** The proposals this turn filed. */
export function turnProposals(): Array<{ id: string; fullName: string; args: unknown; tainted: boolean; status: 'pending'; origin: string }> {
  return [...(scope.getStore()?.proposed ?? [])];
}

/** The current turn's id, for a proposal's origin. */
export function turnId(): string {
  return scope.getStore()?.id ?? 'none';
}

/** What tainted the current turn (for the approval card and the audit trail). */
export function taintSources(): string[] {
  return [...(scope.getStore()?.sources ?? [])].sort();
}
