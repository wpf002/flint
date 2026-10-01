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
  /** Proposals this turn filed (RAM queue or runtime), for the console's approval cards. */
  readonly proposed: Array<{ id: string; fullName: string; args: unknown; tainted: boolean; status: 'pending' }> = [];
  get tainted(): boolean {
    return this.sources.size > 0;
  }
}

const scope = new AsyncLocalStorage<TurnTaint>();

/** Run `fn` as one turn with its own taint state, optionally starting from what it carries. */
export function withTurnTaint<T>(fn: () => T, seed: { sources?: readonly string[]; eval?: boolean; allow?: readonly string[] } = {}): T {
  const t = new TurnTaint();
  for (const s of seed.sources ?? []) t.sources.add(s);
  for (const a of seed.allow ?? []) t.allowances.add(a);
  t.eval = seed.eval === true;
  return scope.run(t, fn);
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

/** Note a proposal this turn filed (once per id). */
export function noteProposal(p: { id: string; fullName: string; args: unknown; tainted: boolean }): void {
  const t = scope.getStore();
  if (t && !t.proposed.some((x) => x.id === p.id)) t.proposed.push({ ...p, status: 'pending' });
}

/** The proposals this turn filed. */
export function turnProposals(): Array<{ id: string; fullName: string; args: unknown; tainted: boolean; status: 'pending' }> {
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
