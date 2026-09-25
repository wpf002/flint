import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, appendFileSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DailyEvalBudget,
  dailyLimitFrom,
  openSharedEvalBudget,
  processAlive,
  spendLedgerPath,
  type EvalLedgerRow,
} from '../src/daily-budget.js';
import { BudgetGuard } from '../src/budget.js';

const NOON = Date.UTC(2026, 8, 25, 17, 0); // 12:00 CDT
const HOUR = 3_600_000;

let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'parity-daily-'));
  path = join(dir, 'eval', 'spend-ledger.jsonl');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** One parity invocation: its own pid, the shared ledger file, a clock, and which pids are "running". */
function invocation(pid: number, t: { now: number }, alive: Set<number>, limit = 25) {
  return new DailyEvalBudget({ path, dailyLimitUsd: limit, now: () => t.now, pid, alive: (p) => alive.has(p) });
}

const rows = () =>
  readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as EvalLedgerRow);

describe('DailyEvalBudget', () => {
  it('grants the ask when the day has room, and records spend and release', () => {
    const t = { now: NOON };
    const a = invocation(101, t, new Set([101]));
    expect(a.open('20260925-run', 10)).toMatchObject({ ok: true, grantedUsd: 10, clipped: false });
    a.spend(1.25);
    a.spend(0); // nothing to record
    a.close();
    a.close(); // idempotent
    expect(rows().map((r) => [r.type, r.usd])).toEqual([
      ['reserve', 10],
      ['spend', 1.25],
      ['release', 0],
    ]);
    expect(rows()[0]).toMatchObject({ run: '20260925-run', pid: 101, day: '2026-09-25' });
    expect(a.state()).toMatchObject({ spentTodayUsd: 1.25, heldUsd: 0, remainingUsd: 23.75 });
  });

  it("shares one pot across invocations: a running eval's unspent reservation holds budget", () => {
    const t = { now: NOON };
    const alive = new Set([1, 2, 3]);
    const a = invocation(1, t, alive);
    expect(a.open('run-a', 10)).toMatchObject({ ok: true, grantedUsd: 10 });
    a.spend(4);
    // $4 spent + $6 still held by a → $15 left of $25.
    expect(invocation(2, t, alive).open('run-b', 10)).toMatchObject({ ok: true, grantedUsd: 10, clipped: false, spentTodayUsd: 4, heldUsd: 6 });
    // $4 spent + a's $6 + b's $10 held → $5 left: this one is capped at $5.
    expect(invocation(3, t, alive).open('run-c', 10)).toMatchObject({ ok: true, grantedUsd: 5, clipped: true });
  });

  it('refuses to start when the day is spent', () => {
    const t = { now: NOON };
    const alive = new Set([1, 2]);
    const a = invocation(1, t, alive, 10);
    a.open('run-a', 10);
    a.spend(9.8);
    a.close();
    const r = invocation(2, t, alive, 10).open('run-b', 5);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/today's shared eval budget is spent: \$9\.80 spent of \$10\.00 \(PARITY_DAILY_BUDGET_USD\)/);
    expect(rows().filter((x) => x.type === 'reserve')).toHaveLength(1); // nothing reserved for the refused run
  });

  it('refuses when other running evals hold the rest, and says so', () => {
    const t = { now: NOON };
    const alive = new Set([1, 2]);
    invocation(1, t, alive, 10).open('run-a', 10);
    const r = invocation(2, t, alive, 10).open('run-b', 5);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/\$0\.00 spent \+ \$10\.00 held by other running evals/);
  });

  it('a small ask still starts in a small remainder', () => {
    const t = { now: NOON };
    const a = invocation(1, t, new Set([1]), 1);
    a.open('run-a', 1);
    a.spend(0.8);
    a.close();
    expect(invocation(2, t, new Set([2]), 1).open('run-b', 0.1)).toMatchObject({ ok: true, grantedUsd: 0.1 });
  });

  it("a crashed eval's spend still counts, but its reservation stops holding", () => {
    const t = { now: NOON };
    const alive = new Set([1, 2]);
    const a = invocation(1, t, alive);
    a.open('run-a', 20);
    a.spend(3);
    alive.delete(1); // killed: no release row
    expect(invocation(2, t, alive).open('run-b', 25)).toMatchObject({ ok: true, grantedUsd: 22, clipped: true, spentTodayUsd: 3, heldUsd: 0 });
  });

  it('starts a fresh pot at midnight in Chicago', () => {
    const t = { now: Date.UTC(2026, 8, 26, 4, 30) }; // 23:30 CDT on the 25th
    const a = invocation(1, t, new Set([1, 2]));
    a.open('late', 25);
    a.spend(25);
    a.close();
    t.now += HOUR; // 00:30 on the 26th
    expect(invocation(2, t, new Set([1, 2])).open('early', 10)).toMatchObject({ ok: true, grantedUsd: 10, spentTodayUsd: 0 });
  });

  it("a run that started before midnight still holds what it hasn't spent", () => {
    const t = { now: Date.UTC(2026, 8, 26, 4, 30) }; // 23:30 on the 25th
    const alive = new Set([1, 2]);
    const a = invocation(1, t, alive);
    a.open('overnight', 10);
    t.now += HOUR;
    a.spend(2); // counted on the 26th
    expect(invocation(2, t, alive).open('morning', 25)).toMatchObject({ grantedUsd: 15, spentTodayUsd: 2, heldUsd: 8 });
  });

  it('skips a torn line and gets past a stale lock left by a killed process', () => {
    const t = { now: NOON };
    invocation(1, t, new Set([1])).open('a', 1);
    appendFileSync(path, '{"type":"spend","id":"x","usd":');
    writeFileSync(`${path}.lock`, '');
    const old = (Date.now() - 60_000) / 1000;
    utimesSync(`${path}.lock`, old, old);
    expect(invocation(2, t, new Set([1, 2])).open('b', 5)).toMatchObject({ ok: true, grantedUsd: 5 });
  });

  it("records each settled call of the invocation's BudgetGuard", () => {
    const t = { now: NOON };
    const a = invocation(1, t, new Set([1]));
    const g = a.open('run', 2);
    if (!g.ok) throw new Error('expected a grant');
    const guard = new BudgetGuard(g.grantedUsd, (usd) => a.spend(usd));
    guard.reserve(0.5)!(0.3);
    guard.reserve(0.5)!(0.45);
    expect(rows().filter((r) => r.type === 'spend').map((r) => r.usd)).toEqual([0.3, 0.45]);
    expect(a.state().spentTodayUsd).toBeCloseTo(0.75, 6);
  });
});

describe('dailyLimitFrom', () => {
  it('defaults to $25 and reads PARITY_DAILY_BUDGET_USD', () => {
    expect(dailyLimitFrom({})).toBe(25);
    expect(dailyLimitFrom({ PARITY_DAILY_BUDGET_USD: '40' })).toBe(40);
    expect(dailyLimitFrom({ PARITY_DAILY_BUDGET_USD: '$7.5' })).toBe(7.5);
    expect(() => dailyLimitFrom({ PARITY_DAILY_BUDGET_USD: 'lots' })).toThrow(/not a dollar amount/);
  });

  it('knows this process is alive and a nonsense pid is not', () => {
    expect(processAlive(process.pid)).toBe(true);
    expect(processAlive(2 ** 22 + 12_345)).toBe(false);
  });
});

describe('openSharedEvalBudget (what run and tasks open before their first paid call)', () => {
  const open = (budgetUsd: number, notes: string[] = [], logged: string[] = []) =>
    openSharedEvalBudget({ run: 'tasks/20260925-run', budgetUsd, dailyLimitUsd: 25, ledgerPath: path, env: {}, log: (m) => logged.push(m), notes, now: () => NOON });

  it("caps the invocation's guard at the grant and records every settled call in the shared ledger", () => {
    const { budget, daily, clipped } = open(10);
    expect(budget.limitUsd).toBe(10);
    expect(clipped).toBe(false);
    budget.reserve(0.5)!(0.4);
    daily.close();
    expect(rows().map((r) => [r.type, r.usd])).toEqual([
      ['reserve', 10],
      ['spend', 0.4],
      ['release', 0],
    ]);
    expect(rows()[0]).toMatchObject({ run: 'tasks/20260925-run', day: '2026-09-25' });
  });

  it("is capped by what today's other evals left, and says so in the report notes", () => {
    const t = { now: NOON };
    const earlier = invocation(7, t, new Set());
    earlier.open('earlier', 24);
    earlier.spend(24);
    earlier.close();
    const notes: string[] = [];
    const logged: string[] = [];
    const { budget, daily, clipped } = open(10, notes, logged);
    daily.close();
    expect(budget.limitUsd).toBe(1);
    expect(clipped).toBe(true);
    expect(notes[0]).toMatch(/^Capped by the shared daily eval budget: .*capped at \$1\.00 instead of --budget-usd \$10\.00/);
    expect(logged).toHaveLength(1);
  });

  it("refuses to start once today's budget is spent", () => {
    const t = { now: NOON };
    const earlier = invocation(7, t, new Set());
    earlier.open('earlier', 25);
    earlier.spend(25);
    earlier.close();
    expect(() => open(5)).toThrow(/shared eval budget is spent/);
  });

  it('finds the ledger from the flag, then PARITY_SPEND_LEDGER, then the eval dir', () => {
    expect(spendLedgerPath('/x/flag.jsonl', { PARITY_SPEND_LEDGER: '/x/env.jsonl' }, '/e')).toBe('/x/flag.jsonl');
    expect(spendLedgerPath(undefined, { PARITY_SPEND_LEDGER: ' /x/env.jsonl ' }, '/e')).toBe('/x/env.jsonl');
    expect(spendLedgerPath(undefined, {}, '/e')).toBe('/e/spend-ledger.jsonl');
  });
});
