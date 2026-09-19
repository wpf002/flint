import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { TokenUsage } from '@flint/core';
import type { ParticipantConfig } from './config.js';

/*
 * What one participant may spend, in dollars.
 *
 * The token cap in spend.ts bounds the whole loop. It cannot say "GPT has had its share".
 * OpenAI credit is prepaid in $10 blocks, and GPT used two of them in a week of builds at
 * about $0.05 a turn. The cap has to be per participant and in dollars, because that is
 * how the bill is charged.
 *
 * A participant over its budget rests. It takes no turns, the threads it holds go to
 * someone who can answer, and nobody hands it anything until the day or month turns over.
 * The build carries on without it rather than stopping.
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
 * OpenAI's default. At about $0.05 a turn, $1 a day is some 20 GPT turns, a whole build;
 * $5 a month makes a $10 top-up last at least two months. Claude (API) takes the turns
 * GPT would have taken once either runs out.
 */
export const OPENAI_BUDGET: Budget = { usdPerDay: 1, usdPerMonth: 5 };

/** A participant's budget: what its config says, else its provider's default, else none. */
export function budgetOf(cfg: Pick<ParticipantConfig, 'provider' | 'budget'>): Budget | null {
  const fallback = cfg.provider === 'openai' ? OPENAI_BUDGET : null;
  if (!cfg.budget) return fallback;
  return {
    usdPerDay: cfg.budget.usdPerDay ?? fallback?.usdPerDay ?? 0,
    usdPerMonth: cfg.budget.usdPerMonth ?? fallback?.usdPerMonth ?? 0,
  };
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
  if (!budget) return `${usd(spent.today)} today, ${usd(spent.month)} this month, no budget`;
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
