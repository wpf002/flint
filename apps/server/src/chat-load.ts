/**
 * Chat turns in flight, for POST /internal/load (Machine plan P2): the
 * runtime's triage asks before each local-model call and defers while any are,
 * so the local model is Will's first. Only /chat turns count (the console, the
 * apps and voice), from just after the request is authorised and valid until it
 * ends, however it ends. Eval replays (/generate) never count: a parity run
 * would otherwise starve triage for hours.
 */
export class ChatLoad {
  private n = 0;

  get inFlight(): number {
    return this.n;
  }

  /** Count one turn while `fn` runs. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    this.n++;
    try {
      return await fn();
    } finally {
      this.n--;
    }
  }
}
