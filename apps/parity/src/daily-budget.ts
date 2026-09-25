import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spendPeriod } from '@flint/core';
import { BudgetGuard } from './budget.js';

/**
 * One daily eval budget shared by EVERY parity invocation: two runs started in
 * two terminals (or a resume, or a --judge-only pass) draw on the same pot.
 *
 * `--budget-usd` still caps each invocation (BudgetGuard). On top of it, each
 * invocation RESERVES its budget in an append-only ledger before it spends
 * anything; the reservation is granted only out of what today's eval spend and
 * the other live runs' outstanding reservations leave under the daily limit.
 * If less than the ask is left the invocation is capped at what is left, and if
 * almost nothing is left it refuses to start. Every settled call is appended as
 * a spend row, so a run that crashes still has its spend counted; its
 * reservation stops holding budget once its process is gone.
 *
 * Rows (one JSON object per line):
 *   { type: 'reserve', id, run, pid, day, ts, usd }  the invocation's grant
 *   { type: 'spend',   id, run, pid, day, ts, usd }  one settled call
 *   { type: 'release', id, run, pid, day, ts, usd: 0 } the invocation finished
 */
export interface EvalLedgerRow {
  type: 'reserve' | 'spend' | 'release';
  id: string;
  run: string;
  pid: number;
  day: string;
  ts: string;
  usd: number;
}

export interface DailyBudgetOptions {
  path: string;
  dailyLimitUsd: number;
  /** Days end at midnight here. Default America/Chicago. */
  timeZone?: string;
  now?: () => number;
  pid?: number;
  /** Whether a process is still running (a crashed run's reservation is void). */
  alive?: (pid: number) => boolean;
  /** Smallest grant worth starting a run for (default $0.50, or the ask if smaller). */
  minGrantUsd?: number;
}

export type OpenResult =
  | { ok: true; grantedUsd: number; clipped: boolean; spentTodayUsd: number; heldUsd: number }
  | { ok: false; reason: string; spentTodayUsd: number; heldUsd: number };

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists, it just isn't ours to signal.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export class DailyEvalBudget {
  readonly path: string;
  readonly dailyLimitUsd: number;
  readonly timeZone: string;
  private readonly now: () => number;
  private readonly pid: number;
  private readonly alive: (pid: number) => boolean;
  private readonly minGrantUsd: number;
  private id: string | undefined;
  private run = '';
  private closed = false;

  constructor(opts: DailyBudgetOptions) {
    if (!(opts.dailyLimitUsd >= 0) || !Number.isFinite(opts.dailyLimitUsd)) {
      throw new Error(`daily eval budget must be a dollar amount >= 0 (got ${opts.dailyLimitUsd})`);
    }
    this.path = opts.path;
    this.dailyLimitUsd = opts.dailyLimitUsd;
    this.timeZone = opts.timeZone ?? 'America/Chicago';
    this.now = opts.now ?? Date.now;
    this.pid = opts.pid ?? process.pid;
    this.alive = opts.alive ?? processAlive;
    this.minGrantUsd = opts.minGrantUsd ?? 0.5;
  }

  today(): string {
    return spendPeriod(this.now(), this.timeZone).day;
  }

  /**
   * Today's eval spend (every invocation, finished or not) and what OTHER live
   * invocations still hold: their reservation minus what they have spent. A
   * reservation holds until it is released or its process is gone, whatever
   * day it was made (a run that started before midnight keeps its hold).
   */
  state(): { day: string; spentTodayUsd: number; heldUsd: number; remainingUsd: number } {
    const day = this.today();
    const rows = this.rows();
    let spentToday = 0;
    const reserved = new Map<string, { usd: number; pid: number }>();
    const spentBy = new Map<string, number>();
    const released = new Set<string>();
    for (const r of rows) {
      if (r.type === 'spend') {
        if (r.day === day) spentToday += r.usd;
        spentBy.set(r.id, (spentBy.get(r.id) ?? 0) + r.usd);
      } else if (r.type === 'reserve') reserved.set(r.id, { usd: r.usd, pid: r.pid });
      else if (r.type === 'release') released.add(r.id);
    }
    let held = 0;
    for (const [id, res] of reserved) {
      if (id === this.id || released.has(id) || !this.alive(res.pid)) continue;
      held += Math.max(0, res.usd - (spentBy.get(id) ?? 0));
    }
    return { day, spentTodayUsd: spentToday, heldUsd: held, remainingUsd: Math.max(0, this.dailyLimitUsd - spentToday - held) };
  }

  /**
   * Reserve up to `wantUsd` for this invocation (see the class comment). Read
   * and reservation happen under a lock file, so two evals starting in the
   * same instant can't both be granted the same headroom.
   */
  open(run: string, wantUsd: number): OpenResult {
    if (this.id) throw new Error('this invocation already holds a reservation');
    return this.locked(() => this.openUnlocked(run, wantUsd));
  }

  private openUnlocked(run: string, wantUsd: number): OpenResult {
    const s = this.state();
    const minimum = Math.min(wantUsd, this.minGrantUsd);
    if (s.remainingUsd < minimum || s.remainingUsd <= 0) {
      return {
        ok: false,
        reason:
          `today's shared eval budget is spent: $${s.spentTodayUsd.toFixed(2)} spent` +
          (s.heldUsd > 0 ? ` + $${s.heldUsd.toFixed(2)} held by other running evals` : '') +
          ` of $${this.dailyLimitUsd.toFixed(2)} (PARITY_DAILY_BUDGET_USD). Resume tomorrow with the same --run, or raise the limit.`,
        spentTodayUsd: s.spentTodayUsd,
        heldUsd: s.heldUsd,
      };
    }
    const granted = Math.min(wantUsd, s.remainingUsd);
    this.id = `${run}#${this.pid}#${this.now()}`;
    this.run = run;
    this.append('reserve', granted);
    return { ok: true, grantedUsd: granted, clipped: granted < wantUsd, spentTodayUsd: s.spentTodayUsd, heldUsd: s.heldUsd };
  }

  /**
   * Record one settled call (the BudgetGuard's actual cost). A ledger that
   * can't be written is reported, not thrown: the invocation's own guard still
   * holds it to its grant.
   */
  spend(usd: number): void {
    if (!this.id || !(usd > 0)) return;
    this.appendSafely('spend', usd);
  }

  /** Release the reservation: this invocation is done. Idempotent. */
  close(): void {
    if (!this.id || this.closed) return;
    this.closed = true;
    this.appendSafely('release', 0);
  }

  private appendSafely(type: EvalLedgerRow['type'], usd: number): void {
    try {
      this.append(type, usd);
    } catch (err) {
      process.stderr.write(`[parity] could not write the eval spend ledger ${this.path}: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  private locked<T>(fn: () => T): T {
    const lock = `${this.path}.lock`;
    mkdirSync(dirname(lock), { recursive: true });
    const deadline = Date.now() + 5_000;
    for (;;) {
      try {
        closeSync(openSync(lock, 'wx'));
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        try {
          // A lock left by a process killed mid-open: nothing holds it for 30s.
          if (Date.now() - statSync(lock).mtimeMs > 30_000) {
            rmSync(lock, { force: true });
            continue;
          }
        } catch {
          continue; // it went away between the two calls
        }
        if (Date.now() > deadline) throw new Error(`the eval spend ledger is locked (${lock}); delete it if no eval is starting`);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      }
    }
    try {
      return fn();
    } finally {
      rmSync(lock, { force: true });
    }
  }

  private append(type: EvalLedgerRow['type'], usd: number): void {
    const row: EvalLedgerRow = {
      type,
      id: this.id!,
      run: this.run,
      pid: this.pid,
      day: this.today(),
      ts: new Date(this.now()).toISOString(),
      usd: Math.round(usd * 1e6) / 1e6,
    };
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, JSON.stringify(row) + '\n', 'utf8');
  }

  private rows(): EvalLedgerRow[] {
    if (!existsSync(this.path)) return [];
    const out: EvalLedgerRow[] = [];
    for (const line of readFileSync(this.path, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as EvalLedgerRow;
        if (r && typeof r.id === 'string' && typeof r.usd === 'number' && Number.isFinite(r.usd)) out.push(r);
      } catch {
        /* a torn line from a killed run */
      }
    }
    return out;
  }
}

/** PARITY_DAILY_BUDGET_USD, default $25. */
export function dailyLimitFrom(env: Record<string, string | undefined>): number {
  const raw = env.PARITY_DAILY_BUDGET_USD?.trim();
  if (!raw) return 25;
  const n = Number(raw.replace(/^\$/, ''));
  if (!Number.isFinite(n) || n < 0) throw new Error(`PARITY_DAILY_BUDGET_USD=${JSON.stringify(raw)} is not a dollar amount`);
  return n;
}

/** The shared ledger: `--spend-ledger`, else PARITY_SPEND_LEDGER, else `<evalDir>/spend-ledger.jsonl`. */
export function spendLedgerPath(flag: string | undefined, env: Record<string, string | undefined>, evalDir: string): string {
  return resolve(flag ?? (env.PARITY_SPEND_LEDGER?.trim() || join(evalDir, 'spend-ledger.jsonl')));
}

/**
 * What every paid parity command does before its first paid call: reserve its
 * `--budget-usd` out of today's shared eval budget (PARITY_DAILY_BUDGET_USD) and
 * spend only through the returned BudgetGuard. The guard's limit is the grant
 * (capped at what today has left) and every call it settles is appended to the
 * ledger. Throws when today's budget is spent; a capped grant is logged and
 * added to `notes`. Close `daily` when the invocation ends (and on process exit).
 */
export function openSharedEvalBudget(opts: {
  run: string;
  budgetUsd: number;
  dailyLimitUsd: number;
  ledgerPath: string;
  env: Record<string, string | undefined>;
  log: (msg: string) => void;
  notes: string[];
  now?: () => number;
}): { budget: BudgetGuard; daily: DailyEvalBudget; clipped: boolean } {
  const daily = new DailyEvalBudget({
    path: opts.ledgerPath,
    dailyLimitUsd: opts.dailyLimitUsd,
    timeZone: opts.env.FLINT_USER_TZ?.trim() || 'America/Chicago',
    ...(opts.now ? { now: opts.now } : {}),
  });
  const grant = daily.open(opts.run, opts.budgetUsd);
  if (!grant.ok) throw new Error(grant.reason);
  if (grant.clipped) {
    const why =
      `today's shared eval budget ($${daily.dailyLimitUsd.toFixed(2)}, PARITY_DAILY_BUDGET_USD) had $${grant.grantedUsd.toFixed(2)} left ` +
      `($${grant.spentTodayUsd.toFixed(2)} spent today${grant.heldUsd > 0 ? `, $${grant.heldUsd.toFixed(2)} held by other running evals` : ''}), ` +
      `so this invocation is capped at $${grant.grantedUsd.toFixed(2)} instead of --budget-usd $${opts.budgetUsd.toFixed(2)}`;
    opts.log(why);
    opts.notes.push(`Capped by the shared daily eval budget: ${why}.`);
  }
  return { budget: new BudgetGuard(grant.grantedUsd, (usd) => daily.spend(usd)), daily, clipped: grant.clipped };
}
