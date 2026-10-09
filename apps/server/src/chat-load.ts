/**
 * Chat turns in flight, for POST /internal/load (Machine plan P2): the
 * runtime's triage asks before each local-model call and defers while any are,
 * so the local model is Will's first. Only /chat turns count (the console, the
 * apps and voice), from just after the request is authorised and valid until it
 * ends, however it ends. Eval replays (/generate) never count: a parity run
 * would otherwise starve triage for hours.
 *
 * The memory extractor asks too (busy): it also waits a quiet spell after a
 * turn ends, since Will's next message usually follows within a minute or two.
 */
export class ChatLoad {
  private n = 0;
  /** When the last turn ended (0: none yet). */
  private lastEnd = 0;

  constructor(private readonly now: () => number = Date.now) {}

  get inFlight(): number {
    return this.n;
  }

  /** Is a turn running, or did one end less than `quietMs` ago? */
  busy(quietMs: number): boolean {
    return this.n > 0 || (this.lastEnd > 0 && this.now() - this.lastEnd < quietMs);
  }

  /** Count one turn while `fn` runs. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    this.n++;
    try {
      return await fn();
    } finally {
      this.n--;
      this.lastEnd = this.now();
    }
  }
}
