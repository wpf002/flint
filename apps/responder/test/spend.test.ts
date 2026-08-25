import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SpendLedger, utcDay } from '../src/spend.js';

/*
 * The per-run budget stops bounding anything once a supervisor restarts the process,
 * because the budget restarts with it. These cover the cap that survives that.
 */

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'spend-'));
  path = join(dir, 'ledger.json');
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('SpendLedger', () => {
  it('starts empty and reports what is left', () => {
    const ledger = SpendLedger.open(path, 10);

    expect(ledger.spent).toBe(0);
    expect(ledger.remaining()).toBe(10);
  });

  it('survives a restart, which is the whole point', () => {
    SpendLedger.open(path, 10).record(4);

    const reopened = SpendLedger.open(path, 10);
    expect(reopened.spent).toBe(4);
    expect(reopened.remaining()).toBe(6);
  });

  it('does not carry yesterday forward', () => {
    writeFileSync(path, JSON.stringify({ day: '2020-01-01', turns: 99 }));

    expect(SpendLedger.open(path, 10).spent).toBe(0);
  });

  it('rolls over when the process outlives the day it started in', () => {
    const ledger = SpendLedger.open(path, 10);
    ledger.record(7);

    ledger.rollover('2099-12-31');

    expect(ledger.spent).toBe(0);
  });

  it('is uncapped at a limit of zero rather than blocked', () => {
    const ledger = SpendLedger.open(path, 0);
    ledger.record(500);

    expect(ledger.remaining()).toBe(Number.POSITIVE_INFINITY);
    expect(ledger.limited).toBe(false);
  });

  it('never reports a negative remainder once the cap is passed', () => {
    const ledger = SpendLedger.open(path, 3);
    ledger.record(9);

    expect(ledger.remaining()).toBe(0);
  });

  /*
   * Refusing to run because a local counter file is unparseable would be a worse
   * failure than recounting from zero.
   */
  it('treats a corrupt ledger as a fresh day rather than refusing to run', () => {
    writeFileSync(path, 'not json at all');

    expect(SpendLedger.open(path, 10).spent).toBe(0);
  });

  it('ignores a ledger claiming a negative count', () => {
    writeFileSync(path, JSON.stringify({ day: utcDay(), turns: -50 }));

    expect(SpendLedger.open(path, 10).spent).toBe(0);
  });

  it('records nothing for a round that took no turns', () => {
    const ledger = SpendLedger.open(path, 10);
    ledger.record(0);

    expect(ledger.spent).toBe(0);
  });
});

describe("the budget a bill is actually made of", () => {
  /*
   * Sixty short turns and sixty long ones cost very differently, and a thread's later
   * turns cost several times its first because they carry the history. Counting turns
   * bounded the wrong thing.
   */
  it("stops on tokens even when turns are left", () => {
    const ledger = SpendLedger.open(path, 100, 10_000);
    ledger.record(3, 10_000);

    expect(ledger.remaining()).toBe(0);
    expect(ledger.tokensSpent).toBe(true);
  });

  it("still stops on turns when tokens are left", () => {
    const ledger = SpendLedger.open(path, 2, 100_000);
    ledger.record(2, 500);

    expect(ledger.remaining()).toBe(0);
    expect(ledger.tokensSpent).toBe(false);
  });

  it("carries the token count across a restart", () => {
    SpendLedger.open(path, 100, 50_000).record(1, 12_000);

    expect(SpendLedger.open(path, 100, 50_000).tokens).toBe(12_000);
  });

  it("is uncapped on tokens at a limit of zero", () => {
    const ledger = SpendLedger.open(path, 0, 0);
    ledger.record(50, 999_999);

    expect(ledger.tokensRemaining()).toBe(Number.POSITIVE_INFINITY);
    expect(ledger.remaining()).toBe(Number.POSITIVE_INFINITY);
  });

  it("reads a ledger written before tokens were tracked as zero spent", () => {
    writeFileSync(path, JSON.stringify({ day: utcDay(), turns: 9 }));

    const ledger = SpendLedger.open(path, 100, 50_000);
    expect(ledger.spent).toBe(9);
    expect(ledger.tokens).toBe(0);
  });
});
