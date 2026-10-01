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

export class TurnTaint {
  readonly sources = new Set<string>();
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

/** What tainted the current turn (for the approval card and the audit trail). */
export function taintSources(): string[] {
  return [...(scope.getStore()?.sources ?? [])].sort();
}
