import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * One ceiling, not two.
 *
 * The parity harness already keeps a daily spend ledger with its own cap. Evolve
 * started with a separate cap, which meant a heavy parity day plus a nightly
 * measure could total more than either number suggested — two guards, neither
 * aware of the other. This writes into the SAME ledger and reads the same day's
 * total before running, so PARITY_DAILY_BUDGET_USD is the real ceiling for
 * everything that spends.
 *
 * The format matches parity's rows exactly ({type,id,run,pid,day,ts,usd}), so
 * both tools' spend totals with one sum.
 */

export interface LedgerRow {
  type: 'spend' | 'reserve' | 'release';
  id: string;
  run: string;
  pid: number;
  day: string;
  ts: string;
  usd: number;
}

/** Local calendar day, matching how parity stamps its rows. */
export function dayOf(now: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/** What has already been spent today, across every tool writing to this ledger. */
export function spentToday(path: string, day: string): number {
  if (!existsSync(path)) return 0;
  let total = 0;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as Partial<LedgerRow>;
      if (r.type === 'spend' && r.day === day) total += Number(r.usd ?? 0);
    } catch {
      /* a torn line at the end of the file is not worth failing over */
    }
  }
  return total;
}

/**
 * How much this run may spend: its own cap, or whatever is left of the shared
 * daily budget, whichever is smaller. Never negative.
 */
export function allowance(opts: { ownCap: number; dailyBudget: number; alreadySpent: number }): number {
  return Math.max(0, Math.min(opts.ownCap, opts.dailyBudget - opts.alreadySpent));
}

export function record(path: string, row: Omit<LedgerRow, 'ts'> & { ts?: string }): void {
  mkdirSync(dirname(path), { recursive: true });
  const full: LedgerRow = { ...row, ts: row.ts ?? new Date().toISOString() };
  appendFileSync(path, `${JSON.stringify(full)}\n`, 'utf8');
}
