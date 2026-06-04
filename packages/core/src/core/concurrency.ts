/**
 * A minimal FIFO concurrency limiter. One instance per provider (invariant:
 * "per-provider limiter / queue"). Caps in-flight work at `maxConcurrent`;
 * excess tasks queue and run as slots free up. Matters most for Phase 2 local
 * models that crash or thrash under parallel load.
 */
export class ConcurrencyLimiter {
  private active = 0;
  private readonly queue: Array<() => void> = [];
  readonly maxConcurrent: number;

  constructor(maxConcurrent: number) {
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
      throw new Error(`maxConcurrent must be a positive integer, got ${maxConcurrent}`);
    }
    this.maxConcurrent = maxConcurrent;
  }

  /** Number of tasks currently executing. */
  get inFlight(): number {
    return this.active;
  }

  /** Number of tasks waiting for a slot. */
  get pending(): number {
    return this.queue.length;
  }

  /**
   * Run `task` once a slot is free. The returned promise settles with the
   * task's result (or rejection). A slot is always released, even on throw.
   */
  async run<T>(task: () => Promise<T>): Promise<T> {
    const release = await this.acquireSlot();
    try {
      return await task();
    } finally {
      release();
    }
  }

  /**
   * Acquire a slot and return a release function. For work whose lifetime spans
   * more than a single promise — e.g. a streaming tool-loop turn that must hold
   * one slot from first token to terminal event. The release is idempotent.
   */
  async acquireSlot(): Promise<() => void> {
    await this.acquire();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.release();
    };
  }

  private acquire(): Promise<void> {
    if (this.active < this.maxConcurrent) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.active++;
        resolve();
      });
    });
  }

  private release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }
}
