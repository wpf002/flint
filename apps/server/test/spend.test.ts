import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProviderAdapter, Tool } from '@flint/core';
import {
  SpendLedger,
  SpendGuard,
  NoteOnce,
  readCaps,
  levelOf,
  planFrontier,
  budgetNote,
  budgetMediaError,
  describePlan,
  meterPaidTools,
  paidToolSpecs,
  toolSucceeded,
  speakWithinBudget,
  spendStatusTool,
  formatSpend,
  kindFromContext,
  spendContext,
  pausable,
  type Caps,
  type Notifier,
  type BrainChooser,
} from '../src/spend';
import { FALLBACK, type BrainTier, type Tier } from '../src/brains';
import { planQueries, deepResearch, DEFAULT_LIMITS } from '../src/deep-research';

// 2026-09-25 12:00 in Chicago (CDT, UTC-5).
const NOON = Date.UTC(2026, 8, 25, 17, 0);
const HOUR = 3_600_000;

function caps(partial: Partial<Caps> = {}): Caps {
  return { anthropic: {}, openai: {}, perplexity: {}, tavily: {}, ...partial };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'flint-spend-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function ledgerAt(t: { now: number }, opts: { log?: (m: string) => void } = {}) {
  return new SpendLedger({ dir, timeZone: 'America/Chicago', now: () => t.now, ...opts });
}

function notifier() {
  const pushed: Array<{ title: string; body: string; kind: string; dedupe?: string }> = [];
  const n: Notifier = { push: (title, body, kind, dedupe) => pushed.push({ title, body, kind, ...(dedupe ? { dedupe } : {}) }) };
  return { n, pushed };
}

// ---------------------------------------------------------------------------

describe('SpendLedger', () => {
  it('appends one JSONL row per call and sums the day and month per vendor', () => {
    const t = { now: NOON };
    const l = ledgerAt(t);
    l.record({ vendor: 'anthropic', model: 'claude-opus-5-5', kind: 'chat', usd: 0.25 });
    l.record({ vendor: 'anthropic', model: 'claude-sonnet-5', kind: 'plan', usd: 0.01 });
    l.record({ vendor: 'tavily', model: 'search-basic', kind: 'tool-search', usd: 0.008 });
    const a = l.totals('anthropic');
    expect(a.day.usd).toBeCloseTo(0.26, 6);
    expect(a.month.usd).toBeCloseTo(0.26, 6);
    expect(a.day.calls).toBe(2);
    expect(l.totals('tavily').day.usd).toBeCloseTo(0.008, 6);
    expect(l.totals('openai').day.usd).toBe(0);
    const lines = readFileSync(join(dir, 'spend-2026-09.jsonl'), 'utf8').trim().split('\n').map((x) => JSON.parse(x));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({ ts: NOON, vendor: 'anthropic', model: 'claude-opus-5-5', kind: 'chat', usd: 0.25 });
  });

  it('restores the month on boot, so a restart never resets a cap', () => {
    const t = { now: NOON };
    const a = ledgerAt(t);
    a.record({ vendor: 'anthropic', model: 'claude-opus-5-5', kind: 'chat', usd: 3 });
    a.record({ vendor: 'openai', model: 'tts-1', kind: 'tts', usd: 0.5 });
    // A torn last line (a crash mid-append) and garbage are skipped, the rest stands.
    appendFileSync(join(dir, 'spend-2026-09.jsonl'), '{"ts":1,"vendor":"anthr');
    appendFileSync(join(dir, 'spend-2026-09.jsonl'), '\n{"ts":1,"vendor":"nobody","model":"x","kind":"chat","usd":5}\n');
    const logs: string[] = [];
    const b = ledgerAt(t, { log: (m) => logs.push(m) });
    expect(b.totals('anthropic').day.usd).toBeCloseTo(3, 6);
    expect(b.totals('openai').month.usd).toBeCloseTo(0.5, 6);
    expect(logs.join('\n')).toMatch(/restored 2 paid call\(s\) for 2026-09 \(2 unreadable/);
  });

  it('rolls the day over at midnight in Chicago, not UTC', () => {
    const t = { now: Date.UTC(2026, 8, 26, 4, 30) }; // 23:30 CDT on the 25th
    const l = ledgerAt(t);
    l.record({ vendor: 'anthropic', model: 'claude-opus-5-5', kind: 'chat', usd: 2 });
    expect(l.period().day).toBe('2026-09-25');
    t.now += HOUR; // 00:30 CDT on the 26th (still 05:30Z on the 26th)
    expect(l.period().day).toBe('2026-09-26');
    expect(l.totals('anthropic').day.usd).toBe(0);
    expect(l.totals('anthropic').month.usd).toBeCloseTo(2, 6);
    l.record({ vendor: 'anthropic', model: 'claude-opus-5-5', kind: 'chat', usd: 1 });
    expect(l.totals('anthropic').day.usd).toBeCloseTo(1, 6);
    expect(l.totals('anthropic').month.usd).toBeCloseTo(3, 6);
  });

  it('rolls the month over into a new file, and boot reads only the current month', () => {
    const t = { now: Date.UTC(2026, 9, 1, 4, 0) }; // 23:00 CDT, Sep 30
    const l = ledgerAt(t);
    l.record({ vendor: 'anthropic', model: 'claude-opus-5-5', kind: 'chat', usd: 40 });
    t.now += 2 * HOUR; // 01:00 CDT, Oct 1
    l.record({ vendor: 'anthropic', model: 'claude-opus-5-5', kind: 'chat', usd: 1 });
    expect(l.totals('anthropic').month.usd).toBeCloseTo(1, 6);
    expect(existsSync(join(dir, 'spend-2026-09.jsonl'))).toBe(true);
    expect(existsSync(join(dir, 'spend-2026-10.jsonl'))).toBe(true);
    const rebooted = ledgerAt(t);
    expect(rebooted.totals('anthropic').month.usd).toBeCloseTo(1, 6);
    // Asking about a time in September still finds September's totals in this process.
    expect(l.totals('anthropic', Date.UTC(2026, 9, 1, 4, 0)).month.usd).toBeCloseTo(40, 6);
  });

  it('keeps eval replays out of the capped total', () => {
    const l = ledgerAt({ now: NOON });
    l.record({ vendor: 'anthropic', model: 'claude-opus-5-5', kind: 'eval', usd: 7 });
    l.record({ vendor: 'anthropic', model: 'claude-opus-5-5', kind: 'chat', usd: 1 });
    expect(l.totals('anthropic').day).toMatchObject({ usd: 1, evalUsd: 7, calls: 2 });
  });

  it('keeps counting in memory when the ledger file cannot be written', () => {
    const blocker = join(dir, 'not-a-dir');
    writeFileSync(blocker, 'x');
    const logs: string[] = [];
    const l = new SpendLedger({ dir: blocker, timeZone: 'America/Chicago', now: () => NOON, log: (m) => logs.push(m) });
    l.record({ vendor: 'anthropic', model: 'claude-opus-5-5', kind: 'chat', usd: 1 });
    expect(l.totals('anthropic').day.usd).toBe(1);
    expect(logs.join('\n')).toMatch(/could not append/);
  });

  it('logs once, and prices high, a model the table has no price for', () => {
    const logs: string[] = [];
    const l = ledgerAt({ now: NOON }, { log: (m) => logs.push(m) });
    const usd = l.priceTokens('anthropic', 'claude-mystery-9', { input: 1_000_000, output: 0 });
    l.priceTokens('anthropic', 'claude-mystery-9', { input: 1, output: 0 });
    expect(usd).toBeGreaterThanOrEqual(10);
    expect(logs.filter((m) => m.includes('claude-mystery-9'))).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------

describe('readCaps', () => {
  it('reads daily and monthly caps per vendor; unset is no cap', () => {
    const c = readCaps({
      FLINT_BUDGET_ANTHROPIC_DAILY_USD: '20',
      FLINT_BUDGET_ANTHROPIC_MONTHLY_USD: '$300',
      FLINT_BUDGET_TAVILY_MONTHLY_USD: '8',
      FLINT_BUDGET_OPENAI_DAILY_USD: '  ',
    });
    expect(c.anthropic).toEqual({ dailyUsd: 20, monthlyUsd: 300 });
    expect(c.tavily).toEqual({ monthlyUsd: 8 });
    expect(c.openai).toEqual({});
    expect(c.perplexity).toEqual({});
  });

  it('takes 0 as a real cap (a kill switch) and ignores nonsense with a warning', () => {
    const warns: string[] = [];
    const c = readCaps({ FLINT_BUDGET_OPENAI_DAILY_USD: '0', FLINT_BUDGET_PERPLEXITY_DAILY_USD: 'lots', FLINT_BUDGET_TAVILY_DAILY_USD: '-1' }, (m) => warns.push(m));
    expect(c.openai).toEqual({ dailyUsd: 0 });
    expect(c.perplexity).toEqual({});
    expect(c.tavily).toEqual({});
    expect(warns).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------

describe('SpendGuard levels', () => {
  it('maps a cap fraction to a level at 50 / 80 / 100%', () => {
    expect(levelOf(0)).toBe('ok');
    expect(levelOf(0.49)).toBe('ok');
    expect(levelOf(0.5)).toBe('notice');
    expect(levelOf(0.79)).toBe('notice');
    expect(levelOf(0.8)).toBe('degrade');
    expect(levelOf(0.99)).toBe('degrade');
    expect(levelOf(1)).toBe('exhausted');
  });

  it('uses whichever of the daily and monthly caps is closer to spent', () => {
    const t = { now: NOON };
    const l = ledgerAt(t);
    const g = new SpendGuard(l, caps({ anthropic: { dailyUsd: 100, monthlyUsd: 10 } }));
    l.record({ vendor: 'anthropic', model: 'claude-opus-5-5', kind: 'chat', usd: 8.5 });
    const s = g.status('anthropic');
    expect(s.today.pct).toBeCloseTo(8.5, 1);
    expect(s.month.pct).toBeCloseTo(85, 1);
    expect(s.level).toBe('degrade');
    expect(s.binding).toBe('monthly');
  });

  it('changes nothing for a vendor with no cap, however much it spends', () => {
    const l = ledgerAt({ now: NOON });
    const g = new SpendGuard(l, caps());
    l.record({ vendor: 'anthropic', model: 'claude-opus-5-5', kind: 'chat', usd: 10_000 });
    expect(g.status('anthropic')).toMatchObject({ level: 'ok', fraction: 0 });
    expect(g.blocked('anthropic')).toBeUndefined();
    expect(g.backgroundBlocked('anthropic')).toBeUndefined();
  });

  it('pauses background work at 80% and blocks calls at 100%', () => {
    const l = ledgerAt({ now: NOON });
    const g = new SpendGuard(l, caps({ anthropic: { dailyUsd: 10 } }));
    l.record({ vendor: 'anthropic', model: 'claude-opus-5-5', kind: 'chat', usd: 7.9 });
    expect(g.backgroundBlocked('anthropic')).toBeUndefined();
    l.record({ vendor: 'anthropic', model: 'claude-opus-5-5', kind: 'chat', usd: 0.2 });
    expect(g.backgroundBlocked('anthropic')).toMatch(/Claude \(Anthropic\) at 81% of today's \$10\.00 cap/);
    expect(g.blocked('anthropic')).toBeUndefined();
    l.record({ vendor: 'anthropic', model: 'claude-opus-5-5', kind: 'chat', usd: 1.9 });
    expect(g.blocked('anthropic')).toBe("Claude (Anthropic) budget reached: today's $10.00 cap is spent.");
  });

  it('never lets eval replays push Flint toward a cap', () => {
    const l = ledgerAt({ now: NOON });
    const g = new SpendGuard(l, caps({ anthropic: { dailyUsd: 10 } }));
    l.record({ vendor: 'anthropic', model: 'claude-opus-5-5', kind: 'eval', usd: 50 });
    expect(g.level('anthropic')).toBe('ok');
  });

  it('treats a $0 cap as spent from the start (the kill switch)', () => {
    const g = new SpendGuard(ledgerAt({ now: NOON }), caps({ openai: { dailyUsd: 0 } }));
    expect(g.level('openai')).toBe('exhausted');
    expect(g.status('openai').today.pct).toBe(100);
  });
});

// ---------------------------------------------------------------------------

describe('SpendGuard notifications', () => {
  it('notifies once at 50, 80 and 100% of the daily cap, deduped', () => {
    const { n, pushed } = notifier();
    const l = ledgerAt({ now: NOON });
    new SpendGuard(l, caps({ anthropic: { dailyUsd: 10 } }), n);
    const spend = (usd: number) => l.record({ vendor: 'anthropic', model: 'claude-opus-5-5', kind: 'chat', usd });
    spend(4.9);
    expect(pushed).toHaveLength(0);
    spend(0.2); // 51%
    spend(0.1); // still 52%: no second notice
    expect(pushed.map((p) => p.title)).toEqual(["Claude (Anthropic) budget: 50% of today's cap"]);
    spend(3); // 82%
    spend(2); // 102%
    spend(1); // still over
    expect(pushed.map((p) => p.title)).toEqual([
      "Claude (Anthropic) budget: 50% of today's cap",
      "Claude (Anthropic) budget: 80% of today's cap",
      "Claude (Anthropic) budget: 100% of today's cap",
    ]);
    expect(pushed[1]!.body).toMatch(/^\$8\.20 of \$10\.00 today\. Standard, hard and code questions answer on the routine/);
    expect(pushed[2]!.body).toMatch(/local brain/);
    expect(new Set(pushed.map((p) => p.dedupe)).size).toBe(3);
    expect(pushed[0]!.dedupe).toBe('spend:anthropic:daily:2026-09-25:50');
    expect(pushed.every((p) => p.kind === 'budget')).toBe(true);
  });

  it('raises only the highest threshold when one call jumps past several', () => {
    const { n, pushed } = notifier();
    const l = ledgerAt({ now: NOON });
    new SpendGuard(l, caps({ perplexity: { dailyUsd: 1 } }), n);
    l.record({ vendor: 'perplexity', model: 'sonar', kind: 'tool-perplexity', usd: 0.9 });
    expect(pushed.map((p) => p.title)).toEqual(["Perplexity budget: 80% of today's cap"]);
  });

  it('notifies again the next day, and for the monthly cap on its own key', () => {
    const { n, pushed } = notifier();
    const t = { now: NOON };
    const l = ledgerAt(t);
    new SpendGuard(l, caps({ tavily: { dailyUsd: 1, monthlyUsd: 3 } }), n);
    l.record({ vendor: 'tavily', model: 'search-basic', kind: 'tool-search', usd: 0.6 });
    t.now += 24 * HOUR;
    l.record({ vendor: 'tavily', model: 'search-basic', kind: 'tool-search', usd: 0.6 });
    const keys = pushed.map((p) => p.dedupe);
    expect(keys).toEqual(['spend:tavily:daily:2026-09-25:50', 'spend:tavily:daily:2026-09-26:50']);
    l.record({ vendor: 'tavily', model: 'search-basic', kind: 'tool-search', usd: 0.4 }); // month $1.60 of $3: 53%
    expect(pushed.map((p) => p.dedupe)).toContain('spend:tavily:monthly:2026-09:50');
  });

  it('checks a restored ledger on boot', () => {
    const t = { now: NOON };
    ledgerAt(t).record({ vendor: 'openai', model: 'tts-1', kind: 'tts', usd: 2.5 });
    const { n, pushed } = notifier();
    const g = new SpendGuard(ledgerAt(t), caps({ openai: { dailyUsd: 3 } }), n);
    g.checkAll();
    g.checkAll();
    expect(pushed.map((p) => p.title)).toEqual(["OpenAI budget: 80% of today's cap"]);
  });
});

// ---------------------------------------------------------------------------
// routing

function provider(name: string): ProviderAdapter {
  return { name } as unknown as ProviderAdapter;
}

/** A BrainSet-shaped stand-in: tiers by label, with the real FALLBACK ladder. */
function brainsOf(spec: Record<Tier, string>, lastResort?: string): BrainChooser<string> {
  const make = (tier: Tier | 'last_resort', label: string): BrainTier<string> => {
    const [p, model] = [label.slice(0, label.indexOf(':')), label.slice(label.indexOf(':') + 1)];
    return { tier, provider: provider(p), model, label, persona: label };
  };
  const by = Object.fromEntries((Object.keys(spec) as Tier[]).map((t) => [t, make(t, spec[t])])) as Record<Tier, BrainTier<string>>;
  const last = lastResort ? make('last_resort', lastResort) : undefined;
  return {
    primary: by.standard,
    get: (t) => by[t],
    chain: (t) => {
      const seen = new Set<string>();
      return [...FALLBACK[t].map((x) => by[x]), ...(last ? [last] : [])].filter((b) => (seen.has(b.label) ? false : (seen.add(b.label), true)));
    },
  };
}

const WILL = {
  routine: 'anthropic:claude-sonnet-5',
  standard: 'anthropic:claude-opus-5-5',
  hard: 'anthropic:claude-opus-5-5',
  code: 'anthropic:claude-opus-5-5',
};

function guardWith(anthropicUsd: number, extra: { openaiUsd?: number } = {}) {
  // A fresh ledger dir per guard: the same dir would restore the previous guard's spend.
  const l = new SpendLedger({ dir: mkdtempSync(join(dir, 'g-')), timeZone: 'America/Chicago', now: () => NOON });
  const g = new SpendGuard(l, caps({ anthropic: { dailyUsd: 10 }, openai: { dailyUsd: 5 } }));
  if (anthropicUsd) l.record({ vendor: 'anthropic', model: 'claude-opus-5-5', kind: 'chat', usd: anthropicUsd });
  if (extra.openaiUsd) l.record({ vendor: 'openai', model: 'gpt-5', kind: 'chat', usd: extra.openaiUsd });
  return g;
}

const labels = (p: { chain: BrainTier<string>[] }) => p.chain.map((b) => b.label);

describe('planFrontier', () => {
  it('below 80% of the cap: exactly the chain Flint uses with no caps at all', () => {
    const brains = brainsOf(WILL, 'openai:gpt-5');
    for (const usd of [0, 5, 7.99]) {
      for (const tier of ['routine', 'standard', 'hard', 'code'] as Tier[]) {
        const plan = planFrontier(brains, tier, guardWith(usd));
        expect(labels(plan), `${tier} at $${usd}`).toEqual(brains.chain(tier).map((b) => b.label));
        expect(plan.tier).toBe(tier);
        expect(plan.degradedFrom).toBeUndefined();
        expect(plan.exhausted).toBeUndefined();
      }
    }
  });

  it('at 80%: standard, hard and code turns answer on the routine tier', () => {
    const brains = brainsOf(WILL, 'openai:gpt-5');
    for (const tier of ['standard', 'hard', 'code'] as Tier[]) {
      const plan = planFrontier(brains, tier, guardWith(8));
      expect(plan.tier).toBe('routine');
      expect(plan.degradedFrom).toBe(tier);
      expect(labels(plan)[0]).toBe('anthropic:claude-sonnet-5');
      expect(plan.exhausted).toBeUndefined();
    }
    // Routine itself is already the cheap tier.
    const routine = planFrontier(brains, 'routine', guardWith(8));
    expect(routine.degradedFrom).toBeUndefined();
    expect(labels(routine)[0]).toBe('anthropic:claude-sonnet-5');
  });

  it('at 80%: no downgrade when the routine tier is the same brain (nothing cheaper to go to)', () => {
    const one = 'anthropic:claude-sonnet-4-6';
    const plan = planFrontier(brainsOf({ routine: one, standard: one, hard: one, code: one }), 'hard', guardWith(9));
    expect(plan.degradedFrom).toBeUndefined();
    expect(labels(plan)).toEqual([one]);
  });

  it('at 100%: every Claude brain is skipped; an OpenAI last resort with budget still answers', () => {
    const plan = planFrontier(brainsOf(WILL, 'openai:gpt-5'), 'hard', guardWith(10));
    expect(labels(plan)).toEqual(['openai:gpt-5']);
    expect(plan.dropped).toEqual(['anthropic:claude-sonnet-5', 'anthropic:claude-opus-5-5']);
    expect(plan.exhausted).toBeUndefined();
  });

  it('at 100% with nothing else: exhausted, so the local brain answers', () => {
    const plan = planFrontier(brainsOf(WILL), 'standard', guardWith(10.5));
    expect(plan.chain).toEqual([]);
    expect(plan.exhausted).toEqual({ vendor: 'anthropic', binding: 'daily' });
    expect(budgetNote(plan.exhausted!)).toBe("(Running on my local brain — today's Claude budget is spent.)");
    expect(describePlan(plan)).toMatch(/anthropic daily budget spent — the local brain answers/);
  });

  it('names the monthly cap when that is the one spent', () => {
    const l = ledgerAt({ now: NOON });
    const g = new SpendGuard(l, caps({ anthropic: { dailyUsd: 100, monthlyUsd: 10 } }));
    l.record({ vendor: 'anthropic', model: 'claude-opus-5-5', kind: 'chat', usd: 12 });
    const plan = planFrontier(brainsOf(WILL), 'routine', g);
    expect(plan.exhausted).toEqual({ vendor: 'anthropic', binding: 'monthly' });
    expect(budgetNote(plan.exhausted!)).toBe("(Running on my local brain — this month's Claude budget is spent.)");
  });

  it('both vendors spent: exhausted even with a last resort', () => {
    const plan = planFrontier(brainsOf(WILL, 'openai:gpt-5'), 'code', guardWith(10, { openaiUsd: 5 }));
    expect(plan.exhausted?.vendor).toBe('anthropic');
  });

  it('never drops the local (Ollama) brain for budget', () => {
    const plan = planFrontier(brainsOf({ ...WILL, hard: 'ollama:qwen2.5:72b' }), 'hard', guardWith(10));
    expect(labels(plan)).toEqual(['ollama:qwen2.5:72b']);
  });

  it('exempts eval replays: routed as if uncapped', () => {
    const brains = brainsOf(WILL);
    const plan = planFrontier(brains, 'hard', guardWith(50), { exempt: true });
    expect(labels(plan)).toEqual(brains.chain('hard').map((b) => b.label));
    expect(plan.exhausted).toBeUndefined();
  });

  it('undoes the downgrade for a file only the dearer tier can read', () => {
    const canRead = (b: BrainTier<string>) => b.label === 'anthropic:claude-opus-5-5';
    const brains = brainsOf({ ...WILL, routine: 'anthropic:claude-haiku-4-5' });
    const plan = planFrontier(brains, 'hard', guardWith(8), { canRead });
    expect(plan.tier).toBe('hard');
    expect(plan.degradedFrom).toBeUndefined();
    expect(labels(plan)).toEqual(['anthropic:claude-opus-5-5']);
  });

  it('a file turn with every capable brain spent is exhausted, never answered blind', () => {
    const plan = planFrontier(brainsOf(WILL, 'openai:gpt-5'), 'standard', guardWith(10), {
      canRead: (b) => b.provider.name === 'anthropic',
    });
    expect(plan.chain).toEqual([]);
    expect(plan.exhausted?.vendor).toBe('anthropic');
    expect(budgetMediaError(plan.exhausted!)).toMatch(/Today's Claude budget is spent, and the local brain can't read images or PDFs/);
  });

  it('no guard (caps off): the plain chain', () => {
    const brains = brainsOf(WILL);
    expect(labels(planFrontier(brains, 'code', undefined))).toEqual(brains.chain('code').map((b) => b.label));
  });
});

describe('NoteOnce', () => {
  it('says it once per conversation per day', () => {
    let day = '2026-09-25';
    const once = new NoteOnce(() => day);
    expect(once.take('console')).toBe(true);
    expect(once.take('console')).toBe(false);
    expect(once.take('phone')).toBe(true);
    day = '2026-09-26';
    expect(once.take('console')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// paid tools

function stubTool(name: string, result: unknown, seen: unknown[] = []): Tool {
  return {
    definition: { name, description: name, inputSchema: { type: 'object' }, idempotent: true },
    handler: async (call) => {
      seen.push(call.args);
      return result;
    },
  };
}

describe('meterPaidTools', () => {
  const specs = paidToolSpecs({});

  it('records each successful paid call and leaves other tools alone', async () => {
    const l = ledgerAt({ now: NOON });
    const g = new SpendGuard(l, caps());
    const other = stubTool('web.fetch_url', 'page');
    const [pplx, tav, fetch, trident] = meterPaidTools(
      [stubTool('trident.perplexity_search', '{"content":"ok","citations":[]}'), stubTool('web.web_search', '{"answer":"x","results":[]}'), other, stubTool('trident.web_search', '{"results":[]}')],
      { guard: g, specs },
    );
    expect(fetch).toBe(other);
    await pplx!.handler({ id: '1', toolName: 'trident.perplexity_search', args: { query: 'q' } });
    await tav!.handler({ id: '2', toolName: 'web.web_search', args: { query: 'q' } });
    await trident!.handler({ id: '3', toolName: 'trident.web_search', args: { query: 'q', search_depth: 'advanced' } });
    expect(l.totals('perplexity').day).toMatchObject({ usd: 0.008, calls: 1 });
    expect(l.totals('tavily').day.usd).toBeCloseTo(0.008 + 0.016, 6); // basic 1 credit + advanced 2
  });

  it('does not charge failed calls', async () => {
    const l = ledgerAt({ now: NOON });
    const g = new SpendGuard(l, caps());
    const tools = meterPaidTools(
      [
        stubTool('trident.perplexity_search', '{"error":"Perplexity API error (401)"}'),
        stubTool('web.web_search', { isError: true, content: 'tavily HTTP 432' }),
      ],
      { guard: g, specs },
    );
    for (const t of tools) await t.handler({ id: 'x', toolName: t.definition.name, args: {} });
    expect(l.totals('perplexity').day.calls).toBe(0);
    expect(l.totals('tavily').day.calls).toBe(0);
  });

  it('at the cap: refuses with a routable error before calling the vendor', async () => {
    const l = ledgerAt({ now: NOON });
    const g = new SpendGuard(l, caps({ perplexity: { dailyUsd: 0.01 }, tavily: { monthlyUsd: 0.008 } }));
    l.record({ vendor: 'perplexity', model: 'sonar', kind: 'tool-perplexity', usd: 0.01 });
    l.record({ vendor: 'tavily', model: 'search-basic', kind: 'tool-search', usd: 0.008 });
    const seen: unknown[] = [];
    const [pplx, tav] = meterPaidTools([stubTool('trident.perplexity_search', 'answer', seen), stubTool('web.web_search', 'hits', seen)], { guard: g, specs });
    const a = (await pplx!.handler({ id: '1', toolName: 'trident.perplexity_search', args: { query: 'q' } })) as { isError: boolean; content: string };
    const b = (await tav!.handler({ id: '2', toolName: 'web.web_search', args: { query: 'q' } })) as { isError: boolean; content: string };
    expect(seen).toEqual([]); // the vendor was never called
    expect(a.isError).toBe(true);
    expect(a.content).toBe("Perplexity budget reached: today's $0.01 cap is spent. Use web.web_search (or deep_research) for this instead.");
    expect(b.isError).toBe(true);
    expect(b.content).toMatch(/^Tavily budget reached: this month's \$0\.01 cap is spent\. Use trident\.perplexity_search .*web\.fetch_url on a keyless search page \(https:\/\/html\.duckduckgo\.com/);
  });

  it('takes per-call prices from env', async () => {
    const l = ledgerAt({ now: NOON });
    const [t] = meterPaidTools([stubTool('web.web_search', 'hits')], {
      guard: new SpendGuard(l, caps()),
      specs: paidToolSpecs({ FLINT_TAVILY_USD_PER_CALL: '0.005' }),
    });
    await t!.handler({ id: '1', toolName: 'web.web_search', args: {} });
    expect(l.totals('tavily').day.usd).toBeCloseTo(0.005, 6);
  });

  it('tells a success from an MCP / trident failure', () => {
    expect(toolSucceeded('{"content":"x"}')).toBe(true);
    expect(toolSucceeded('plain text results')).toBe(true);
    expect(toolSucceeded([{ type: 'text', text: 'x' }])).toBe(true);
    expect(toolSucceeded('{"error":"PERPLEXITY_API_KEY not set"}')).toBe(false);
    expect(toolSucceeded({ isError: true, content: 'x' })).toBe(false);
    expect(toolSucceeded({ approved: false, message: 'x' })).toBe(false);
    expect(toolSucceeded('')).toBe(false);
    expect(toolSucceeded(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TTS

describe('speakWithinBudget', () => {
  it('charges per character sent and returns the audio', async () => {
    const l = ledgerAt({ now: NOON });
    const g = new SpendGuard(l, caps({ openai: { dailyUsd: 1 } }));
    const r = await speakWithinBudget('x'.repeat(5000), { guard: g, model: 'tts-1', maxChars: 4000, synth: async () => Buffer.from('mp3') });
    expect(r.status).toBe('ok');
    // 4000 characters (the request is cut there) at $15 / 1M.
    expect(l.totals('openai').day).toMatchObject({ usd: 0.06, calls: 1 });
  });

  it("at the cap: refuses without calling OpenAI, so the console uses the browser's voice", async () => {
    const l = ledgerAt({ now: NOON });
    const g = new SpendGuard(l, caps({ openai: { dailyUsd: 1 } }));
    l.record({ vendor: 'openai', model: 'tts-1', kind: 'tts', usd: 1 });
    let called = false;
    const r = await speakWithinBudget('hello', {
      guard: g,
      model: 'tts-1',
      maxChars: 4000,
      synth: async () => {
        called = true;
        return Buffer.from('mp3');
      },
    });
    expect(called).toBe(false);
    expect(r).toEqual({ status: 'budget', message: "OpenAI budget reached: today's $1.00 cap is spent. Using the browser's voice." });
  });

  it('no key: nothing is charged', async () => {
    const l = ledgerAt({ now: NOON });
    const r = await speakWithinBudget('hello', { guard: new SpendGuard(l, caps()), model: 'tts-1', maxChars: 4000, synth: async () => null });
    expect(r.status).toBe('no-key');
    expect(l.totals('openai').day.calls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// visibility

describe('/spend snapshot and spend_status', () => {
  it('reports today and this month per vendor, with caps, percent used and effect', () => {
    const l = ledgerAt({ now: NOON });
    const g = new SpendGuard(l, caps({ anthropic: { dailyUsd: 20, monthlyUsd: 300 }, openai: { dailyUsd: 0 } }));
    l.record({ vendor: 'anthropic', model: 'claude-opus-5-5', kind: 'chat', usd: 17 });
    l.record({ vendor: 'anthropic', model: 'claude-opus-5-5', kind: 'eval', usd: 4 });
    const snap = JSON.parse(JSON.stringify(g.snapshot())); // exactly what GET /spend sends
    expect(snap).toMatchObject({ timeZone: 'America/Chicago', day: '2026-09-25', month: '2026-09', thresholds: { notice: 0.5, degrade: 0.8, exhausted: 1 } });
    expect(snap.vendors.anthropic).toMatchObject({
      name: 'Claude (Anthropic)',
      today: { usd: 17, capUsd: 20, pct: 85, evalUsd: 4, calls: 2 },
      month: { usd: 17, capUsd: 300, pct: 5.7 },
      level: 'degrade',
      binding: 'daily',
    });
    expect(snap.vendors.anthropic.effect).toMatch(/routine \(cheaper\) tier/);
    expect(snap.vendors.openai).toMatchObject({ today: { usd: 0, capUsd: 0, pct: 100 }, level: 'exhausted' });
    expect(snap.vendors.tavily).toMatchObject({ today: { usd: 0, calls: 0 }, level: 'ok', effect: 'Normal: nothing is limited.' });
    expect(snap.vendors.tavily.today.capUsd).toBeUndefined();
    expect(snap.vendors.tavily.binding).toBeUndefined();
  });

  it('spend_status answers in plain lines, read-only', async () => {
    const l = ledgerAt({ now: NOON });
    const g = new SpendGuard(l, caps({ anthropic: { dailyUsd: 20 } }));
    l.record({ vendor: 'anthropic', model: 'claude-opus-5-5', kind: 'chat', usd: 5 });
    const tool = spendStatusTool(g);
    expect(tool.definition.name).toBe('spend_status');
    expect(tool.definition.idempotent).toBe(true);
    const text = String(await tool.handler({ id: '1', toolName: 'spend_status', args: {} }));
    expect(text).toContain('Claude (Anthropic): $5.00 today of a $20.00 cap (25%); $5.00 this month (no cap). Normal: nothing is limited.');
    expect(text).toContain('Tavily: $0.00 today (no cap)');
    expect(formatSpend(g.snapshot())).toBe(text);
  });
});

describe('spend context', () => {
  it('round-trips the call kind through CallOptions.context', () => {
    expect(kindFromContext(spendContext('extract'))).toBe('extract');
    expect(kindFromContext(undefined)).toBeUndefined();
    expect(kindFromContext({ spendKind: 'bogus' })).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// deep_research under budget

describe('deep_research under the caps', () => {
  it('plans heuristically, without a model call, while background work is paused', async () => {
    const l = ledgerAt({ now: NOON });
    const g = new SpendGuard(l, caps({ anthropic: { dailyUsd: 10 } }));
    l.record({ vendor: 'anthropic', model: 'claude-opus-5-5', kind: 'chat', usd: 8.5 });
    let asked = 0;
    const logs: string[] = [];
    const complete = pausable(
      async () => {
        asked++;
        return '["a","b","c"]';
      },
      () => g.backgroundBlocked('anthropic'),
    );
    const plan = await planQueries('What changed in the Fed statement?', { complete, log: (m) => logs.push(m) }, new Date(NOON), DEFAULT_LIMITS);
    expect(asked).toBe(0);
    expect(plan.planner).toBe('heuristic');
    expect(logs.join('\n')).toMatch(/planner failed \(Claude \(Anthropic\) at 85% of today's \$10\.00 cap; background work waits\)/);
  });

  it('keeps researching on Perplexity when Tavily is spent (and charges only what ran)', async () => {
    const l = ledgerAt({ now: NOON });
    const g = new SpendGuard(l, caps({ tavily: { dailyUsd: 0.05 } }));
    l.record({ vendor: 'tavily', model: 'search-basic', kind: 'tool-search', usd: 0.05 });
    const seen: string[] = [];
    const tavily = stubTool('web.web_search', JSON.stringify({ results: [{ title: 't', url: 'https://a.example/x', content: 'tavily snippet' }] }));
    const pplx: Tool = {
      definition: { name: 'trident.perplexity_search', description: 'p', inputSchema: { type: 'object' }, idempotent: true },
      handler: async () => {
        seen.push('perplexity');
        return 'Per [the source](https://b.example/y) the answer to the question is 42.';
      },
    };
    const tools = meterPaidTools([tavily, pplx], { guard: g, specs: paidToolSpecs({}) });
    const pack = await deepResearch('What is the answer?', {
      tools,
      now: () => new Date(NOON),
      fetchPage: async () => ({ contentType: 'text/plain', body: 'What is the answer? The answer to the question is 42, according to the source.' }),
      log: () => {},
    });
    expect(seen).toEqual(['perplexity']);
    // Tavily refused (never called), Perplexity's source made it into the pack.
    expect(pack.cited.map((c) => c.url)).toEqual(['https://b.example/y']);
    expect(l.totals('tavily').day.calls).toBe(1); // only the row recorded before the cap
    expect(l.totals('perplexity').day.calls).toBe(1);
  });
});
