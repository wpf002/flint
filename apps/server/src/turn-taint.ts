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
  /** Names this turn as a proposal's origin (`chat:<id>`). */
  readonly id = randomBytes(8).toString('hex');
  /** Runtime proposals this turn filed, for the console's approval cards. */
  readonly proposed: Array<{ id: string; fullName: string; args: unknown; tainted: boolean; status: 'pending' }> = [];
  get tainted(): boolean {
    return this.sources.size > 0;
  }
}

const scope = new AsyncLocalStorage<TurnTaint>();

/** Run `fn` as one turn with its own taint state. */
export function withTurnTaint<T>(fn: () => T): T {
  return scope.run(new TurnTaint(), fn);
}

/** Mark the current turn as having read untrusted text from `source`. Outside a turn, nothing. */
export function markTainted(source: string): void {
  scope.getStore()?.sources.add(source);
}

/** Has the current turn read untrusted text? Outside a turn, false. */
export function turnTainted(): boolean {
  return scope.getStore()?.tainted ?? false;
}

/** Note a runtime proposal this turn filed. */
export function noteProposal(p: { id: string; fullName: string; args: unknown; tainted: boolean }): void {
  scope.getStore()?.proposed.push({ ...p, status: 'pending' });
}

/** The runtime proposals this turn filed. */
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
