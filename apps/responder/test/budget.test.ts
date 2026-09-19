import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BudgetLedger, OPENAI_BUDGET, budgetOf, costOf, describeBudget } from '../src/budget.js';

/* GPT spent two $10 blocks of OpenAI credit in a week of builds, about $0.05 a turn. */

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'budget-'));
  path = join(dir, 'budget.json');
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const day = (iso: string): Date => new Date(`${iso}T12:00:00Z`);

describe('costOf', () => {
  it("prices a gpt-5 turn at OpenAI's rates", () => {
    // A typical build turn from the logs: 16k in, 2.8k out.
    expect(costOf('gpt-5', { input: 16_000, output: 2_800 })).toBeCloseTo(0.048, 3);
  });

  it('charges the cached part of the prompt at the cached rate', () => {
    const full = costOf('gpt-5', { input: 10_000, output: 0 });
    const cached = costOf('gpt-5', { input: 10_000, output: 0, cacheRead: 8_000 });
    expect(cached).toBeCloseTo(full * 0.28, 6);
  });

  it('prices a mini model as a mini, not as its parent', () => {
    expect(costOf('gpt-5-mini', { input: 1_000_000, output: 0 })).toBeCloseTo(0.25, 6);
  });

  it('prices a model it does not know high, so the budget runs out early rather than late', () => {
    expect(costOf('mystery-model', { input: 1_000_000, output: 0 })).toBeGreaterThan(costOf('gpt-5', { input: 1_000_000, output: 0 }));
  });
});

describe('budgetOf', () => {
  it('gives an OpenAI participant the default budget', () => {
    expect(budgetOf({ provider: 'openai' })).toEqual(OPENAI_BUDGET);
  });

  it('gives the others none unless configured', () => {
    expect(budgetOf({ provider: 'anthropic' })).toBeNull();
    expect(budgetOf({ provider: 'anthropic', budget: { usdPerDay: 3 } })).toEqual({ usdPerDay: 3, usdPerMonth: 0 });
  });

  it('lets config override either half of the default', () => {
    expect(budgetOf({ provider: 'openai', budget: { usdPerMonth: 10 } })).toEqual({ usdPerDay: 1, usdPerMonth: 10 });
  });
});

describe('BudgetLedger', () => {
  it('rests a participant once its day is spent, and says until when', () => {
    const book = BudgetLedger.open(path, day('2026-09-19'));
    book.charge('gpt-api', 0.6, day('2026-09-19'));
    expect(book.over('gpt-api', OPENAI_BUDGET, day('2026-09-19'))).toBeNull();

    book.charge('gpt-api', 0.45, day('2026-09-19'));
    expect(book.over('gpt-api', OPENAI_BUDGET, day('2026-09-19'))).toBe("used today's $1.00 budget ($1.05 spent); back at 00:00 UTC");
  });

  it('starts a new day fresh but keeps counting the month', () => {
    const book = BudgetLedger.open(path, day('2026-09-19'));
    book.charge('gpt-api', 1.2, day('2026-09-19'));

    expect(book.over('gpt-api', OPENAI_BUDGET, day('2026-09-20'))).toBeNull();
    expect(book.spent('gpt-api', day('2026-09-20'))).toEqual({ today: 0, month: 1.2 });
  });

  it('rests it for the rest of the month once the month is spent', () => {
    const book = BudgetLedger.open(path, day('2026-09-19'));
    for (const d of ['2026-09-19', '2026-09-20', '2026-09-21', '2026-09-22', '2026-09-23']) book.charge('gpt-api', 1, day(d));

    expect(book.over('gpt-api', OPENAI_BUDGET, day('2026-09-24'))).toBe("used this month's $5.00 budget ($5.00 spent); back on 2026-10-01 UTC");
    expect(book.over('gpt-api', OPENAI_BUDGET, day('2026-10-01'))).toBeNull();
  });

  it('survives a restart, since a redeploy restarts the process', () => {
    BudgetLedger.open(path, day('2026-09-19')).charge('gpt-api', 0.7, day('2026-09-19'));

    expect(BudgetLedger.open(path, day('2026-09-19')).spent('gpt-api', day('2026-09-19'))).toEqual({ today: 0.7, month: 0.7 });
  });

  it('keeps each participant to its own budget', () => {
    const book = BudgetLedger.open(path, day('2026-09-19'));
    book.charge('claude-api', 40, day('2026-09-19'));

    expect(book.over('gpt-api', OPENAI_BUDGET, day('2026-09-19'))).toBeNull();
    expect(book.over('claude-api', null, day('2026-09-19'))).toBeNull();
  });

  it('describes what is spent against what is allowed', () => {
    expect(describeBudget(OPENAI_BUDGET, { today: 0.25, month: 1.5 })).toBe('$0.25 of $1.00 today, $1.50 of $5.00 this month');
  });
});
