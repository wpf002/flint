import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * How many turns have been taken today.
 *
 * The per-run budget is the wrong brake once the loop is supervised: a supervisor
 * restarts a crashed process, and the run budget restarts with it. A ledger on disk,
 * keyed by UTC date, is the only cap that survives that.
 *
 * Deliberately a plain file rather than a row in Nexus. Nexus is the shared record of
 * what the participants said; what this particular machine has spent driving them is
 * local operational state, and putting it in the substrate would make every restart of
 * a local process a write to shared memory.
 */

interface Ledger {
  /** UTC date, YYYY-MM-DD. */
  day: string;
  turns: number;
  /** Output tokens, which is what the day actually costs. */
  tokens: number;
}

export class SpendLedger {
  private ledger: Ledger;

  private constructor(
    private readonly path: string,
    private readonly limit: number,
    private readonly tokenLimit: number,
    ledger: Ledger,
  ) {
    this.ledger = ledger;
  }

  /** `limit` of 0 means uncapped. */
  static open(path: string, limit: number, tokenLimit = 0, today = utcDay()): SpendLedger {
    let ledger: Ledger = { day: today, turns: 0, tokens: 0 };
    if (existsSync(path)) {
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<Ledger>;
        // A ledger from a previous day is not carried forward; the count is per-day.
        if (parsed.day === today && typeof parsed.turns === 'number' && parsed.turns >= 0) {
          ledger = {
            day: today,
            turns: Math.floor(parsed.turns),
            tokens: typeof parsed.tokens === 'number' && parsed.tokens >= 0 ? Math.floor(parsed.tokens) : 0,
          };
        }
      } catch {
        // A corrupt ledger reads as a fresh day. Refusing to run because a local
        // counter file is unparseable would be a worse failure than recounting.
      }
    }
    return new SpendLedger(path, limit, tokenLimit, ledger);
  }

  get spent(): number {
    return this.ledger.turns;
  }

  /** Output tokens spent today. The number a bill is actually made of. */
  get tokens(): number {
    return this.ledger.tokens;
  }

  get limited(): boolean {
    return this.limit > 0 || this.tokenLimit > 0;
  }

  /** True when the day's token budget is gone, whatever the turn count says. */
  get tokensSpent(): boolean {
    return this.tokenLimit > 0 && this.ledger.tokens >= this.tokenLimit;
  }

  /** What is left of the day, in the unit a bill is made of. */
  tokensRemaining(): number {
    return this.tokenLimit > 0 ? Math.max(0, this.tokenLimit - this.ledger.tokens) : Number.POSITIVE_INFINITY;
  }

  /** Turns still allowed today. Infinity when uncapped. */
  remaining(): number {
    if (this.tokensSpent) return 0;
    return this.limit > 0 ? Math.max(0, this.limit - this.ledger.turns) : Number.POSITIVE_INFINITY;
  }

  /**
   * Records turns taken, persisting immediately. Written after each round rather than
   * at exit, because the process this bounds is one that gets killed and restarted.
   */
  record(turns: number, tokens = 0, today = utcDay()): void {
    if (turns <= 0 && tokens <= 0) return;
    if (this.ledger.day !== today) this.ledger = { day: today, turns: 0, tokens: 0 };
    this.ledger.turns += Math.max(0, turns);
    this.ledger.tokens += Math.max(0, tokens);

    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, JSON.stringify(this.ledger), { mode: 0o600 });
    } catch {
      // An unwritable ledger must not stop the loop, but it does mean the cap is only
      // as good as this process's memory of it.
    }
  }

  /** Rolls the day over when the process has been running across midnight. */
  rollover(today = utcDay()): void {
    if (this.ledger.day !== today) this.ledger = { day: today, turns: 0, tokens: 0 };
  }
}

export function utcDay(at = new Date()): string {
  return at.toISOString().slice(0, 10);
}
