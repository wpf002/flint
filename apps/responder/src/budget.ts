import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { TokenUsage } from '@flint/core';
import type { ParticipantConfig } from './config.js';

/*
 * What each participant spends, in dollars.
 *
 * Recorded per participant and in dollars, because that is how the bill is charged: the
 * token cap in spend.ts bounds the whole loop and cannot say who spent what. It no longer
 * stops anyone — see budgetOf below.
 */

/** Dollars per million tokens. */
interface Price {
  input: number;
  cachedInput: number;
  output: number;
}

/*
 * OpenAI's published prices. Longest names first, because every mini and nano model's
 * name starts with its parent's.
 */
const PRICES: ReadonlyArray<readonly [prefix: string, price: Price]> = [
  ['gpt-5-pro', { input: 15, cachedInput: 15, output: 120 }],
  ['gpt-5-mini', { input: 0.25, cachedInput: 0.025, output: 2 }],
  ['gpt-5-nano', { input: 0.05, cachedInput: 0.005, output: 0.4 }],
  ['gpt-5', { input: 1.25, cachedInput: 0.125, output: 10 }],
  ['gpt-4.1-mini', { input: 0.4, cachedInput: 0.1, output: 1.6 }],
  ['gpt-4.1-nano', { input: 0.1, cachedInput: 0.025, output: 0.4 }],
  ['gpt-4.1', { input: 2, cachedInput: 0.5, output: 8 }],
  ['gpt-4o-mini', { input: 0.15, cachedInput: 0.075, output: 0.6 }],
  ['gpt-4o', { input: 2.5, cachedInput: 1.25, output: 10 }],
  ['o4-mini', { input: 1.1, cachedInput: 0.275, output: 4.4 }],
  ['o3', { input: 2, cachedInput: 0.5, output: 8 }],
];

/** A model not listed is priced high, so its budget runs out early rather than late. */
const UNLISTED: Price = { input: 2.5, cachedInput: 1.25, output: 15 };

/**
 * What one call cost. OpenAI counts cached tokens inside the prompt total and bills them
 * at the cached rate, so they are split out rather than charged twice.
 */
export function costOf(model: string, usage: TokenUsage): number {
  const price = PRICES.find(([prefix]) => model.startsWith(prefix))?.[1] ?? UNLISTED;
  const cached = Math.min(usage.cacheRead ?? 0, usage.input);
  return ((usage.input - cached) * price.input + cached * price.cachedInput + usage.output * price.output) / 1_000_000;
}

/** 0 means no limit on that one. */
export interface Budget {
  usdPerDay: number;
  usdPerMonth: number;
}

/*
 * No participant rests on a dollar cap any more, whatever its config says.
 *
 * The cap was a brake on waste, and it braked the work instead. On 2026-09-28 claude-api
 * spent its $3 on about eighty copies of one reply that Nexus refused, then sat out the
 * rest of the day — the money was gone either way, and the cap only added the outage.
 * The waste is now stopped where it happened: a refused turn is never paid for twice
 * (see appendOrSalvage in loop.ts). The ledger still records what each participant
 * spends, so `responder spend` can say where the money went.
 */
export function budgetOf(_cfg: Pick<ParticipantConfig, 'provider' | 'budget'>): Budget | null {
  return null;
}

interface Book {
  /** UTC date, YYYY-MM-DD. */
  day: string;
  /** UTC month, YYYY-MM. */
  month: string;
  today: Record<string, number>;
  thisMonth: Record<string, number>;
}

const usd = (n: number): string => `$${n.toFixed(2)}`;

/**
 * Dollars spent per participant, today and this month, kept on disk.
 *
 * On disk for the same reason as the token ledger. A restarted process that forgot the
 * day's spend would hand every participant a fresh budget, and a redeploy restarts it.
 */
export class BudgetLedger {
  private constructor(
    private readonly path: string | null,
    private book: Book,
  ) {}

  /** A null path keeps the ledger in memory only. */
  static open(path: string | null, now = new Date()): BudgetLedger {
    const fresh: Book = { day: dayOf(now), month: monthOf(now), today: {}, thisMonth: {} };
    if (!path || !existsSync(path)) return new BudgetLedger(path, fresh);
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<Book>;
      const ledger = new BudgetLedger(path, {
        day: typeof parsed.day === 'string' ? parsed.day : fresh.day,
        month: typeof parsed.month === 'string' ? parsed.month : fresh.month,
        today: amounts(parsed.today),
        thisMonth: amounts(parsed.thisMonth),
      });
      ledger.roll(now);
      return ledger;
    } catch {
      // Unreadable reads as a fresh month. Refusing to run over a counter file would be
      // worse than recounting.
      return new BudgetLedger(path, fresh);
    }
  }

  charge(slug: string, dollars: number, now = new Date()): void {
    if (!(dollars > 0)) return;
    this.roll(now);
    this.book.today[slug] = (this.book.today[slug] ?? 0) + dollars;
    this.book.thisMonth[slug] = (this.book.thisMonth[slug] ?? 0) + dollars;
    if (!this.path) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, JSON.stringify(this.book), { mode: 0o600 });
    } catch {
      // Unwritable costs only the memory of today's spend across a restart.
    }
  }

  spent(slug: string, now = new Date()): { today: number; month: number } {
    this.roll(now);
    return { today: this.book.today[slug] ?? 0, month: this.book.thisMonth[slug] ?? 0 };
  }

  /** Why this participant has to rest, or null when it may keep working. */
  over(slug: string, budget: Budget | null, now = new Date()): string | null {
    if (!budget) return null;
    const { today, month } = this.spent(slug, now);
    if (budget.usdPerMonth > 0 && month >= budget.usdPerMonth) {
      return `used this month's ${usd(budget.usdPerMonth)} budget (${usd(month)} spent); back on ${nextMonth(now)} UTC`;
    }
    if (budget.usdPerDay > 0 && today >= budget.usdPerDay) {
      return `used today's ${usd(budget.usdPerDay)} budget (${usd(today)} spent); back at 00:00 UTC`;
    }
    return null;
  }

  private roll(now: Date): void {
    if (this.book.month !== monthOf(now)) {
      this.book = { day: dayOf(now), month: monthOf(now), today: {}, thisMonth: {} };
    } else if (this.book.day !== dayOf(now)) {
      this.book = { ...this.book, day: dayOf(now), today: {} };
    }
  }
}

export function describeBudget(budget: Budget | null, spent: { today: number; month: number }): string {
  if (!budget) return `${usd(spent.today)} today, ${usd(spent.month)} this month`;
  const part = (amount: number, cap: number, period: string) =>
    cap > 0 ? `${usd(amount)} of ${usd(cap)} ${period}` : `${usd(amount)} ${period}`;
  return `${part(spent.today, budget.usdPerDay, 'today')}, ${part(spent.month, budget.usdPerMonth, 'this month')}`;
}

function amounts(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!value || typeof value !== 'object') return out;
  for (const [slug, n] of Object.entries(value)) {
    if (typeof n === 'number' && Number.isFinite(n) && n >= 0) out[slug] = n;
  }
  return out;
}

function dayOf(at: Date): string {
  return at.toISOString().slice(0, 10);
}

function monthOf(at: Date): string {
  return at.toISOString().slice(0, 7);
}

function nextMonth(at: Date): string {
  const first = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));
  return first.toISOString().slice(0, 10);
}
