/**
 * A hard spend ceiling for one eval invocation.
 *
 * Every paid call first RESERVES its estimated cost; the reservation is refused
 * if spent + in-flight reservations + this estimate would cross the limit. When
 * the call returns, the reservation is swapped for the real cost (from usage).
 * Reserving before the call is what makes the guard hold under concurrency: four
 * workers can't each see $0.10 of headroom and all spend it.
 *
 * Once anything is refused the guard latches `exhausted`, and the runner stops
 * launching work. Calls already in flight finish, so the true total can exceed
 * the limit by at most those calls' overshoot beyond their estimates.
 */
export class BudgetGuard {
  private spentUsd = 0;
  private reservedUsd = 0;
  private refused = false;

  constructor(readonly limitUsd: number) {
    if (!(limitUsd > 0)) throw new Error(`budget must be > 0 (got ${limitUsd})`);
  }

  /** Try to reserve `estimateUsd`. Returns a settle function, or null if it would cross the limit. */
  reserve(estimateUsd: number): ((actualUsd: number) => void) | null {
    const est = Math.max(0, estimateUsd);
    if (this.refused || this.spentUsd + this.reservedUsd + est > this.limitUsd) {
      this.refused = true;
      return null;
    }
    this.reservedUsd += est;
    let settled = false;
    return (actualUsd: number) => {
      if (settled) return;
      settled = true;
      this.reservedUsd -= est;
      this.spentUsd += Math.max(0, actualUsd);
    };
  }

  get spent(): number {
    return this.spentUsd;
  }

  get reserved(): number {
    return this.reservedUsd;
  }

  get exhausted(): boolean {
    return this.refused || this.spentUsd >= this.limitUsd;
  }
}
