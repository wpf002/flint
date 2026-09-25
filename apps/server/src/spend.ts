/**
 * Spend guard: what Flint's paid calls cost, and what happens as a budget runs out.
 *
 * Every paid call (a frontier model turn, memory extraction, the research
 * planner, text-to-speech, a Perplexity or Tavily search) is appended to a
 * JSONL ledger and summed per vendor per day and month (Will's time zone). Caps
 * come from env (FLINT_BUDGET_<VENDOR>_DAILY_USD / _MONTHLY_USD); an unset cap
 * is no cap, which is exactly what Flint did before this module.
 *
 * The rule the whole module serves: a cap DEGRADES Flint, it never breaks him,
 * and nothing changes before a cap is actually close.
 *  - below 80% of every cap: nothing changes. Same brains, same tools.
 *  - at 80% of a vendor's daily or monthly cap: the expensive frontier tiers
 *    (standard / hard / code) answer on the routine tier instead, and optional
 *    background work (memory extraction, research query planning) waits.
 *  - at 100%: that vendor is not called at all. A frontier turn answers on the
 *    next brain whose vendor still has budget (the local brain at the end), and
 *    says so once per conversation per day; a spent search API returns a clear
 *    error naming an alternative that still has budget (or, with none, saying
 *    live search is off), so the model routes around it; TTS returns a 503 and
 *    the console speaks with the browser's voice.
 *  - every decision is made BEFORE a call. A turn already streaming finishes,
 *    tool loop and all, whatever it costs.
 *  - eval replays (apps/parity) are exempt and counted apart: their spend is
 *    `eval`, reported back as the replay's cost, and never touches these caps.
 *
 * Kept out of index.ts so it is unit-testable (index.ts runs main() on import).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PAID_VENDORS,
  PERPLEXITY_SEARCH_CALL_USD,
  TAVILY_USD_PER_CREDIT,
  costOf,
  isListedModel,
  spendPeriod,
  tavilySearchCredits,
  ttsCostOf,
  vendorOfProvider,
  type AiObserver,
  type PaidVendor,
  type TokenUsage,
  type Tool,
} from '@flint/core';
import type { BrainTier, Tier } from './brains';
import type { Brain } from './policy';

export type { PaidVendor } from '@flint/core';

/** What a paid call was for. `eval` is a parity replay: logged, but not charged to Flint's caps. */
export type SpendKind = 'chat' | 'extract' | 'plan' | 'tts' | 'tool-search' | 'tool-perplexity' | 'eval';

/** One paid call, as one line of the ledger. */
export interface SpendRow {
  ts: number;
  vendor: PaidVendor;
  model: string;
  kind: SpendKind;
  usd: number;
  tokens?: TokenUsage;
}

export const VENDOR_NAMES: Record<PaidVendor, string> = {
  anthropic: 'Claude (Anthropic)',
  openai: 'OpenAI',
  perplexity: 'Perplexity',
  tavily: 'Tavily',
};

/** How the honest note names a vendor ("today's Claude budget is spent"). */
const SHORT_NAMES: Record<PaidVendor, string> = { anthropic: 'Claude', openai: 'OpenAI', perplexity: 'Perplexity', tavily: 'Tavily' };

const KINDS: ReadonlySet<string> = new Set<SpendKind>(['chat', 'extract', 'plan', 'tts', 'tool-search', 'tool-perplexity', 'eval']);

// ---------------------------------------------------------------------------
// the ledger

interface Bucket {
  /** Spend that counts against the caps (everything but `eval`). */
  usd: number;
  /** Parity replays: the eval harness's own daily budget covers these. */
  evalUsd: number;
  calls: number;
}

export interface PeriodTotals {
  usd: number;
  evalUsd: number;
  calls: number;
}

export interface LedgerOptions {
  /** Where the monthly `spend-YYYY-MM.jsonl` files live (the server passes ~/.flint/spend). */
  dir: string;
  /** Budgets reset at midnight here. Default America/Chicago. */
  timeZone?: string;
  now?: () => number;
  log?: (msg: string) => void;
}

/**
 * Append-only JSONL, one file per month, one row per paid call. The current
 * month's file is read back on boot, so daily and monthly totals survive a
 * restart (or a deploy) and a restart can never reset a cap.
 */
export class SpendLedger {
  readonly dir: string;
  readonly timeZone: string;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  private readonly buckets = new Map<string, Bucket>();
  private readonly listeners: Array<(row: SpendRow) => void> = [];
  private readonly unpriced = new Set<string>();

  constructor(opts: LedgerOptions) {
    this.dir = opts.dir;
    this.timeZone = opts.timeZone ?? 'America/Chicago';
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
    this.restore();
  }

  /** The day and month `at` (default now) falls in, in the ledger's time zone. */
  period(at: number = this.now()): { day: string; month: string } {
    return spendPeriod(at, this.timeZone);
  }

  fileFor(month: string): string {
    return join(this.dir, `spend-${month}.jsonl`);
  }

  /**
   * Record one paid call: appended to the ledger file, added to the totals,
   * handed to listeners (the notifier). A file that can't be written is logged
   * and the in-memory totals still count the call, so the caps keep holding.
   */
  record(entry: Omit<SpendRow, 'ts'> & { ts?: number }): SpendRow {
    const usd = Number.isFinite(entry.usd) && entry.usd > 0 ? Math.round(entry.usd * 1e6) / 1e6 : 0;
    // A call made inside a TurnSpend scope (an eval replay) is that turn's: it
    // takes the scope's kind whatever the caller tagged it (the research
    // planner's `plan` inside an eval is eval spend), and joins the turn's tally.
    const scope = spendScope.getStore();
    const row: SpendRow = {
      ts: entry.ts ?? this.now(),
      vendor: entry.vendor,
      model: entry.model,
      kind: scope?.kind ?? entry.kind,
      usd,
      ...(entry.tokens ? { tokens: entry.tokens } : {}),
    };
    this.add(row);
    scope?.add(row);
    try {
      mkdirSync(this.dir, { recursive: true });
      appendFileSync(this.fileFor(this.period(row.ts).month), JSON.stringify(row) + '\n', 'utf8');
    } catch (err) {
      this.log(`[spend] could not append to the ledger (totals kept in memory): ${err instanceof Error ? err.message : String(err)}`);
    }
    for (const listener of this.listeners) {
      try {
        listener(row);
      } catch (err) {
        this.log(`[spend] listener failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return row;
  }

  /** Called after every recorded row. */
  onRecord(listener: (row: SpendRow) => void): void {
    this.listeners.push(listener);
  }

  /** A vendor's totals for the day and the month containing `at` (default now). */
  totals(vendor: PaidVendor, at: number = this.now()): { day: PeriodTotals; month: PeriodTotals } {
    const { day, month } = this.period(at);
    return { day: { ...this.bucket(`${vendor}|d|${day}`) }, month: { ...this.bucket(`${vendor}|m|${month}`) } };
  }

  /** Price a model call, logging once per model the table has no price for (priced high). */
  priceTokens(vendor: 'anthropic' | 'openai' | 'perplexity', model: string, usage: TokenUsage): number {
    if (!isListedModel(model) && !this.unpriced.has(model)) {
      this.unpriced.add(model);
      this.log(`[spend] no list price for ${vendor}:${model} — counting it at the deliberately high unlisted rate`);
    }
    return costOf(vendor, model, usage);
  }

  private bucket(key: string): Bucket {
    return this.buckets.get(key) ?? { usd: 0, evalUsd: 0, calls: 0 };
  }

  private add(row: SpendRow): void {
    const { day, month } = this.period(row.ts);
    for (const key of [`${row.vendor}|d|${day}`, `${row.vendor}|m|${month}`]) {
      const b = this.buckets.get(key) ?? { usd: 0, evalUsd: 0, calls: 0 };
      if (row.kind === 'eval') b.evalUsd += row.usd;
      else b.usd += row.usd;
      b.calls++;
      this.buckets.set(key, b);
    }
  }

  private restore(): void {
    const { month } = this.period();
    const path = this.fileFor(month);
    if (!existsSync(path)) return;
    let rows = 0;
    let bad = 0;
    try {
      for (const line of readFileSync(path, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const row = JSON.parse(line) as SpendRow;
          if (isRow(row)) {
            this.add(row);
            rows++;
          } else bad++;
        } catch {
          bad++; // a torn last line from a crash: the call is lost, the rest stands
        }
      }
      this.log(`[spend] restored ${rows} paid call(s) for ${month}${bad ? ` (${bad} unreadable line(s) skipped)` : ''}`);
    } catch (err) {
      this.log(`[spend] could not read ${path} (starting the month at $0): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

function isRow(r: unknown): r is SpendRow {
  const row = r as Partial<SpendRow> | null;
  return (
    !!row &&
    typeof row.ts === 'number' &&
    typeof row.usd === 'number' &&
    Number.isFinite(row.usd) &&
    typeof row.model === 'string' &&
    (PAID_VENDORS as readonly string[]).includes(row.vendor as string) &&
    KINDS.has(row.kind as string)
  );
}

// ---------------------------------------------------------------------------
// caps

export interface VendorCaps {
  dailyUsd?: number;
  monthlyUsd?: number;
}

export type Caps = Record<PaidVendor, VendorCaps>;

/**
 * FLINT_BUDGET_<VENDOR>_DAILY_USD / _MONTHLY_USD for ANTHROPIC, OPENAI,
 * PERPLEXITY and TAVILY. Unset (or blank) = no cap for that period. 0 is a
 * real cap (spend nothing: a kill switch). Anything else unparseable is
 * reported through `warn` and ignored, never guessed at.
 */
export function readCaps(env: Record<string, string | undefined>, warn: (msg: string) => void = () => {}): Caps {
  const caps = {} as Caps;
  for (const vendor of PAID_VENDORS) {
    const c: VendorCaps = {};
    for (const [period, field] of [
      ['DAILY', 'dailyUsd'],
      ['MONTHLY', 'monthlyUsd'],
    ] as const) {
      const key = `FLINT_BUDGET_${vendor.toUpperCase()}_${period}_USD`;
      const raw = env[key]?.trim();
      if (!raw) continue;
      const n = Number(raw.replace(/^\$/, ''));
      if (Number.isFinite(n) && n >= 0) c[field] = n;
      else warn(`${key}=${JSON.stringify(raw)} is not a dollar amount — ignored (no cap)`);
    }
    caps[vendor] = c;
  }
  return caps;
}

// ---------------------------------------------------------------------------
// levels and the guard

/** Fractions of a cap where behaviour changes. */
export const NOTICE_AT = 0.5;
export const DEGRADE_AT = 0.8;
export const EXHAUSTED_AT = 1;

export type BudgetLevel = 'ok' | 'notice' | 'degrade' | 'exhausted';
const RANK: Record<BudgetLevel, number> = { ok: 0, notice: 1, degrade: 2, exhausted: 3 };

export function levelOf(fraction: number): BudgetLevel {
  if (fraction >= EXHAUSTED_AT) return 'exhausted';
  if (fraction >= DEGRADE_AT) return 'degrade';
  if (fraction >= NOTICE_AT) return 'notice';
  return 'ok';
}

/** Whether `level` is at or past `atLeast`. */
export function atLeast(level: BudgetLevel, floor: BudgetLevel): boolean {
  return RANK[level] >= RANK[floor];
}

export interface PeriodStatus {
  usd: number;
  capUsd?: number;
  /** Percent of the cap used (one decimal); absent when there is no cap. */
  pct?: number;
  evalUsd: number;
  calls: number;
}

export interface VendorStatus {
  vendor: PaidVendor;
  name: string;
  today: PeriodStatus;
  month: PeriodStatus;
  /** The larger of the two cap fractions (0 when uncapped). */
  fraction: number;
  level: BudgetLevel;
  /** Which cap `fraction` comes from; absent when uncapped. */
  binding?: 'daily' | 'monthly';
  /** What the level means for Flint right now, in a sentence. */
  effect: string;
}

export interface SpendSnapshot {
  timeZone: string;
  day: string;
  month: string;
  thresholds: { notice: number; degrade: number; exhausted: number };
  vendors: Record<PaidVendor, VendorStatus>;
}

/** The slice of Notifications the guard uses (a stub in tests). */
export interface Notifier {
  push(title: string, body: string, kind: string, dedupe?: string): unknown;
}

const usd = (n: number): string => `$${n.toFixed(2)}`;

/** used / cap, where a $0 cap (the kill switch) counts as already spent. */
function fractionOf(used: number, cap: number | undefined): number {
  if (cap === undefined) return 0;
  if (cap <= 0) return 1;
  return used / cap;
}

function periodStatus(t: PeriodTotals, cap: number | undefined): PeriodStatus {
  return {
    usd: Math.round(t.usd * 1e4) / 1e4,
    ...(cap !== undefined ? { capUsd: cap, pct: Math.round(fractionOf(t.usd, cap) * 1000) / 10 } : {}),
    evalUsd: Math.round(t.evalUsd * 1e4) / 1e4,
    calls: t.calls,
  };
}

/** What a level means for one vendor, for /spend, spend_status and notifications. */
export function effectOf(vendor: PaidVendor, level: BudgetLevel): string {
  if (level === 'ok' || level === 'notice') return 'Normal: nothing is limited.';
  const spent = level === 'exhausted';
  switch (vendor) {
    case 'anthropic':
      return spent
        ? 'Claude is not called; Flint answers on the next brain with budget (the local brain at the end) and says so.'
        : 'Standard, hard and code questions answer on the routine (cheaper) tier; memory extraction and research planning wait.';
    case 'openai':
      return spent
        ? 'OpenAI is not called: voice uses the browser, and any OpenAI brain tier is skipped.'
        : 'Any OpenAI brain tier drops to the routine tier; background work on OpenAI waits. Voice is unchanged.';
    case 'perplexity':
      return spent ? 'perplexity_search is off; web search covers it.' : 'Normal until the cap: searches still run.';
    case 'tavily':
      return spent ? 'web_search is off; Perplexity or a keyless page fetch covers it.' : 'Normal until the cap: searches still run.';
  }
}

/**
 * Caps + ledger → decisions. Everything that must not spend past a cap asks
 * this guard first; the ledger tells it (through onRecord) when a threshold is
 * crossed, and it raises a notification once per vendor, cap, period and
 * threshold.
 */
export class SpendGuard {
  private readonly notified = new Set<string>();

  constructor(
    readonly ledger: SpendLedger,
    readonly caps: Caps,
    private readonly notifier?: Notifier,
  ) {
    ledger.onRecord((row) => this.checkThresholds(row.vendor));
  }

  status(vendor: PaidVendor, at?: number): VendorStatus {
    const caps = this.caps[vendor] ?? {};
    const t = this.ledger.totals(vendor, at);
    const daily = fractionOf(t.day.usd, caps.dailyUsd);
    const monthly = fractionOf(t.month.usd, caps.monthlyUsd);
    const fraction = Math.max(daily, monthly);
    const level = levelOf(fraction);
    const capped = caps.dailyUsd !== undefined || caps.monthlyUsd !== undefined;
    return {
      vendor,
      name: VENDOR_NAMES[vendor],
      today: periodStatus(t.day, caps.dailyUsd),
      month: periodStatus(t.month, caps.monthlyUsd),
      fraction,
      level,
      ...(capped ? { binding: monthly > daily ? ('monthly' as const) : ('daily' as const) } : {}),
      effect: effectOf(vendor, level),
    };
  }

  level(vendor: PaidVendor): BudgetLevel {
    return this.status(vendor).level;
  }

  /** Why a paid call to `vendor` must not be made now (a cap is spent), or undefined when it may. */
  blocked(vendor: PaidVendor): string | undefined {
    const s = this.status(vendor);
    if (s.level !== 'exhausted') return undefined;
    return `${s.name} budget reached: ${capPhrase(s)} is spent.`;
  }

  /**
   * Why OPTIONAL background work on `vendor` (memory extraction, research
   * planning) must wait: it stops at 80% of a cap, leaving the rest for Will's
   * own questions. Undefined when it may run.
   */
  backgroundBlocked(vendor: PaidVendor): string | undefined {
    const s = this.status(vendor);
    if (!atLeast(s.level, 'degrade')) return undefined;
    return `${s.name} at ${Math.round(s.fraction * 100)}% of ${capPhrase(s)}; background work waits`;
  }

  snapshot(at?: number): SpendSnapshot {
    const { day, month } = this.ledger.period(at);
    const vendors = {} as Record<PaidVendor, VendorStatus>;
    for (const v of PAID_VENDORS) vendors[v] = this.status(v, at);
    return {
      timeZone: this.ledger.timeZone,
      day,
      month,
      thresholds: { notice: NOTICE_AT, degrade: DEGRADE_AT, exhausted: EXHAUSTED_AT },
      vendors,
    };
  }

  /** Raise any threshold notification not yet raised (on boot: a restored ledger may already be past one). */
  checkAll(): void {
    for (const v of PAID_VENDORS) this.checkThresholds(v);
  }

  /**
   * 50 / 80 / 100% of each cap, once each per period. Jumping straight past
   * two thresholds raises only the highest. Deduped here and again by the
   * notifications feed (whose dedupe keys survive a restart).
   */
  checkThresholds(vendor: PaidVendor): void {
    if (!this.notifier) return;
    const caps = this.caps[vendor] ?? {};
    const t = this.ledger.totals(vendor);
    const { day, month } = this.ledger.period();
    for (const [period, used, cap, when] of [
      ['daily', t.day.usd, caps.dailyUsd, day],
      ['monthly', t.month.usd, caps.monthlyUsd, month],
    ] as const) {
      if (cap === undefined || cap <= 0) continue; // no cap, or the $0 kill switch: nothing to warn about
      const f = fractionOf(used, cap);
      const hit = [EXHAUSTED_AT, DEGRADE_AT, NOTICE_AT].find((th) => f >= th);
      if (hit === undefined) continue;
      const key = (th: number) => `spend:${vendor}:${period}:${when}:${Math.round(th * 100)}`;
      if (this.notified.has(key(hit))) continue;
      for (const th of [NOTICE_AT, DEGRADE_AT, EXHAUSTED_AT]) if (th <= hit) this.notified.add(key(th));
      const pct = Math.round(hit * 100);
      const scope = period === 'daily' ? "today's" : "this month's";
      this.notifier.push(
        `${VENDOR_NAMES[vendor]} budget: ${pct}% of ${scope} cap`,
        // The effect of the vendor's CURRENT level: the other period's cap may be further along.
        `${usd(used)} of ${usd(cap)} ${period === 'daily' ? 'today' : 'this month'}. ${this.status(vendor).effect}`,
        'budget',
        key(hit),
      );
    }
  }
}

function capPhrase(s: VendorStatus): string {
  const monthly = s.binding === 'monthly';
  const cap = monthly ? s.month.capUsd : s.today.capUsd;
  return `${monthly ? "this month's" : "today's"} ${usd(cap ?? 0)} cap`;
}

// ---------------------------------------------------------------------------
// frontier routing

/** The slice of BrainSet planning needs (./brains). */
export interface BrainChooser<P> {
  readonly primary: BrainTier<P>;
  get(tier: Tier): BrainTier<P>;
  chain(tier: Tier): BrainTier<P>[];
}

/** The slice of SpendGuard planning needs. */
export interface BudgetView {
  status(vendor: PaidVendor): VendorStatus;
}

export interface FrontierPlan<P> {
  /** Brains to try, in order. Empty only when `exhausted` is set. */
  chain: BrainTier<P>[];
  /** The tier whose chain this is (after any budget downgrade). */
  tier: Tier;
  /** Set when a budget moved the turn to the cheaper routine tier. */
  degradedFrom?: Tier;
  /** Labels skipped because their vendor's budget is spent. */
  dropped: string[];
  /** Set when every frontier brain's budget is spent: the local brain answers. */
  exhausted?: { vendor: PaidVendor; binding: 'daily' | 'monthly' };
}

export interface PlanOptions<P> {
  /** Parity replays: routed exactly as they would be without caps (the eval budget covers them). */
  exempt?: boolean | undefined;
  /** For turns carrying an image / PDF: which brains can read it (undefined: a text turn). */
  canRead?: ((brain: BrainTier<P>) => boolean) | undefined;
}

function vendorOfBrain<P>(b: BrainTier<P>): PaidVendor | undefined {
  return vendorOfProvider(b.provider.name);
}

/**
 * Which brains may answer this turn, decided BEFORE any call:
 *  1. under 80% of every cap: exactly `brains.chain(tier)`, as without caps;
 *  2. the tier's vendor at >= 80%: a standard / hard / code turn uses the
 *     routine tier's chain instead (only when that is a different brain);
 *  3. brains whose vendor is at >= 100% are dropped from the chain (the rest,
 *     e.g. an OpenAI last resort with budget left, still answer);
 *  4. nothing left: `exhausted`, and the caller answers on the local brain.
 * A turn with an image or PDF keeps only brains that can read it; when the
 * cheaper tier can't read it, the turn is not downgraded (it would only fall
 * back up the ladder anyway) rather than answered blind.
 */
export function planFrontier<P>(
  brains: BrainChooser<P>,
  tier: Tier,
  budget: BudgetView | undefined,
  opts: PlanOptions<P> = {},
): FrontierPlan<P> {
  const readable = (chain: BrainTier<P>[]): BrainTier<P>[] => (opts.canRead ? chain.filter(opts.canRead) : chain);
  if (!budget || opts.exempt) {
    const chain = readable(brains.chain(tier));
    return { chain: chain.length > 0 || !opts.canRead ? chain : [brains.primary], tier, dropped: [] };
  }
  const levelOfBrain = (b: BrainTier<P>): BudgetLevel => {
    const v = vendorOfBrain(b);
    return v === undefined ? 'ok' : budget.status(v).level;
  };
  const spent = (b: BrainTier<P>): boolean => levelOfBrain(b) === 'exhausted';

  const own = brains.get(tier);
  const cheaper = brains.get('routine');
  let eff: Tier = tier;
  if (
    tier !== 'routine' &&
    atLeast(levelOfBrain(own), 'degrade') &&
    cheaper.label !== own.label &&
    // A cheaper tier that can't read this turn's file is no saving: it would only fall back up.
    (!opts.canRead || opts.canRead(cheaper))
  ) {
    eff = 'routine';
  }
  const full = brains.chain(eff);
  const dropped = full.filter(spent).map((b) => b.label);
  let chain = full.filter((b) => !spent(b));
  if (opts.canRead) {
    let able = readable(chain);
    // The floor routeTurn already vetted (as mediaChain has it), unless its budget is spent.
    if (able.length === 0 && !spent(brains.primary)) able = [brains.primary];
    chain = able;
  }
  const plan: FrontierPlan<P> = { chain, tier: eff, dropped, ...(eff !== tier ? { degradedFrom: tier } : {}) };
  if (chain.length === 0) {
    const vendor = vendorOfBrain(brains.get(tier)) ?? 'anthropic';
    plan.exhausted = { vendor, binding: budget.status(vendor).binding ?? 'daily' };
  }
  return plan;
}

/** A log line for a plan the budget changed; undefined when it changed nothing. */
export function describePlan<P>(plan: FrontierPlan<P>): string | undefined {
  const parts: string[] = [];
  if (plan.exhausted) parts.push(`${plan.exhausted.vendor} ${plan.exhausted.binding} budget spent — the local brain answers`);
  else if (plan.degradedFrom) parts.push(`${plan.degradedFrom} turn answers on the ${plan.tier} tier (budget at >= ${Math.round(DEGRADE_AT * 100)}%)`);
  if (plan.dropped.length > 0) parts.push(`skipped (budget spent): ${plan.dropped.join(', ')}`);
  return parts.length > 0 ? parts.join('; ') : undefined;
}

/**
 * The one line appended to a local answer when budgets moved the turn off the
 * frontier. `answeredBy` names a local brain that is itself a paid model (the
 * server without OLLAMA_MODEL runs its "local" persona on Claude), so the note
 * never calls a paid model's answer "my local brain".
 */
export function budgetNote(exhausted: { vendor: PaidVendor; binding: 'daily' | 'monthly' }, answeredBy?: string): string {
  const when = exhausted.binding === 'monthly' ? "this month's" : "today's";
  const on = answeredBy ? `my fallback brain (${answeredBy})` : 'my local brain';
  return `(Running on ${on} — ${when} ${SHORT_NAMES[exhausted.vendor]} budget is spent.)`;
}

/** The refusal for an image / PDF turn when no frontier brain that can read it has budget left. */
export function budgetMediaError(exhausted: { vendor: PaidVendor; binding: 'daily' | 'monthly' }): string {
  const when = exhausted.binding === 'monthly' ? "This month's" : "Today's";
  return `${when} ${SHORT_NAMES[exhausted.vendor]} budget is spent, and the local brain can't read images or PDFs. Send it as text, or raise the cap (FLINT_BUDGET_${exhausted.vendor.toUpperCase()}_*).`;
}

/**
 * Hands out the honest note once per conversation per day: the first local
 * answer in a conversation says why, the rest just answer.
 */
export class NoteOnce {
  private day = '';
  private readonly seen = new Set<string>();

  constructor(private readonly today: () => string) {}

  take(conversationId: string): boolean {
    const d = this.today();
    if (d !== this.day) {
      this.day = d;
      this.seen.clear();
    }
    if (this.seen.has(conversationId)) return false;
    this.seen.add(conversationId);
    return true;
  }
}

// ---------------------------------------------------------------------------
// one turn's budget decision (what /generate and /chat apply)

export interface TurnBudgetInput<P> {
  /** The frontier tiers, or undefined when there is no frontier. */
  brains: BrainChooser<P> | undefined;
  tier: Tier;
  guard: BudgetView & { blocked(vendor: PaidVendor): string | undefined };
  /** routeTurn's decision. */
  route: { brain: Brain; localFallback: boolean };
  /** The local brain's provider name: `ollama` (free), or `anthropic` when OLLAMA_MODEL is unset. */
  localProvider: string;
  /** The local brain's model, for the note when it is a paid one. */
  localModel: string;
  /** A parity replay (`/generate` with `eval: true`). */
  evalMode?: boolean;
  /** For turns carrying an image / PDF: which brains can read it (undefined: a text turn). */
  canRead?: ((brain: BrainTier<P>) => boolean) | undefined;
  /** /chat: the note once per conversation per day. /generate omits it: every answer says why. */
  once?: { notes: NoteOnce; conversationId: string };
}

export type TurnBudget<P> =
  | { ok: false; status: 422 | 503; error: string }
  | {
      ok: true;
      /** The brain that answers: routeTurn's, or `local` when every frontier budget is spent. */
      brain: Brain;
      /** The frontier brains that may answer, in order; undefined for a local turn. */
      plan?: FrontierPlan<P>;
      /** The honest line to show with the answer (never stored as the answer). */
      note?: string;
      /** CallOptions for the turn's model calls: an eval replay's are tagged `eval`. */
      callOpts?: { context: { spendKind: SpendKind } };
      /** What the response says about the guard's effect on the turn. */
      fields: { budget?: 'degraded' | 'exhausted'; degradedFrom?: Tier };
      /**
       * Why the local brain must not answer this turn (it is a paid model whose
       * vendor is spent); undefined when it may. A frontier failure that would
       * fall back to it refuses with this instead.
       */
      localRefusal?: string;
    };

/** The refusal when the only brain left to answer is a paid one whose budget is spent. */
export function budgetSpentError(vendor: PaidVendor, guard: { blocked(vendor: PaidVendor): string | undefined }): string {
  const why = guard.blocked(vendor) ?? `${VENDOR_NAMES[vendor]} budget reached.`;
  return `${why} No brain with budget left can answer, so none was called. Ask again after the budget resets, or raise the cap (FLINT_BUDGET_${vendor.toUpperCase()}_*).`;
}

/**
 * Everything the spend caps decide about one turn, BEFORE any call: which
 * brains may answer (planFrontier), whether the turn moves to the local brain
 * because every frontier budget is spent (and the honest note it gets), the
 * 422 for an image / PDF turn with no frontier budget left, the eval tag, and
 * the refusal when the local brain is itself a paid model whose budget is
 * spent (no spending past a cap, and no silent failure either).
 *
 * Eval replays are exempt from the caps (the parity harness budgets them) and
 * their model calls are tagged `eval`, so they never count toward Flint's own
 * caps. index.ts only applies the result.
 */
export function budgetTurn<P>(input: TurnBudgetInput<P>): TurnBudget<P> {
  const { brains, tier, guard, route, evalMode } = input;
  const plan =
    route.brain === 'frontier' && brains ? planFrontier(brains, tier, guard, { exempt: evalMode, canRead: input.canRead }) : undefined;
  // The local brain costs money only when it isn't Ollama; eval replays are exempt.
  const localVendor = vendorOfProvider(input.localProvider);
  const localRefusal =
    !evalMode && localVendor !== undefined && guard.status(localVendor).level === 'exhausted' ? budgetSpentError(localVendor, guard) : undefined;
  let brain: Brain = route.brain;
  let note: string | undefined;
  if (plan?.exhausted) {
    if (!route.localFallback) return { ok: false, status: 422, error: budgetMediaError(plan.exhausted) };
    brain = 'local';
    if (!localRefusal && (!input.once || input.once.notes.take(input.once.conversationId))) {
      note = budgetNote(plan.exhausted, localVendor ? `${input.localProvider}:${input.localModel}` : undefined);
    }
  }
  if (brain === 'local' && localRefusal) return { ok: false, status: 503, error: localRefusal };
  return {
    ok: true,
    brain,
    ...(plan ? { plan } : {}),
    ...(note ? { note } : {}),
    ...(evalMode ? { callOpts: { context: spendContext('eval') } } : {}),
    fields: budgetFields(plan),
    ...(localRefusal ? { localRefusal } : {}),
  };
}

/** What a response says about the spend guard's effect on its turn (nothing when there was none). */
export function budgetFields<P>(plan: FrontierPlan<P> | undefined): { budget?: 'degraded' | 'exhausted'; degradedFrom?: Tier } {
  if (plan?.exhausted) return { budget: 'exhausted' };
  if (plan?.degradedFrom) return { budget: 'degraded', degradedFrom: plan.degradedFrom };
  return {};
}

// ---------------------------------------------------------------------------
// one turn's spend (an eval replay's cost, reported back to apps/parity)

const spendScope = new AsyncLocalStorage<TurnSpend>();

/**
 * The paid calls made inside one turn. `run()` opens an AsyncLocalStorage
 * scope (as TurnLog does for grounding): every ledger row recorded inside it,
 * however deep (each tool-loop pass, each fallback tier's attempt, the answer-
 * only call, the research planner, each Perplexity / Tavily search), joins this
 * tally and takes this turn's kind. /generate runs each eval replay in one, so
 * the eval response says what the replay really cost, answered or not, and
 * apps/parity charges exactly that to its daily eval budget.
 */
export class TurnSpend {
  private usd = 0;
  private calls = 0;
  private readonly byVendor: Partial<Record<PaidVendor, number>> = {};
  private readonly blockedTools = new Set<string>();

  constructor(readonly kind: SpendKind) {}

  run<T>(fn: () => Promise<T>): Promise<T> {
    return spendScope.run(this, fn);
  }

  /** Called by the ledger for each row recorded inside the scope. */
  add(row: SpendRow): void {
    this.usd += row.usd;
    this.calls++;
    this.byVendor[row.vendor] = (this.byVendor[row.vendor] ?? 0) + row.usd;
  }

  /** Called by meterPaidTools when it refused a paid tool inside the scope (its vendor's cap is spent). */
  noteBlocked(tool: string): void {
    this.blockedTools.add(tool);
  }

  /**
   * What an eval response carries: `costUsd` (every paid call of the turn,
   * priced as the ledger prices it), `costByVendor`, `paidCalls`, and
   * `budgetBlocked` (the paid tools refused for budget) when there were any.
   */
  fields(): { costUsd: number; costByVendor: Partial<Record<PaidVendor, number>>; paidCalls: number; budgetBlocked?: string[] } {
    const round = (n: number) => Math.round(n * 1e6) / 1e6;
    const byVendor: Partial<Record<PaidVendor, number>> = {};
    for (const [v, n] of Object.entries(this.byVendor) as Array<[PaidVendor, number]>) byVendor[v] = round(n);
    return {
      costUsd: round(this.usd),
      costByVendor: byVendor,
      paidCalls: this.calls,
      ...(this.blockedTools.size > 0 ? { budgetBlocked: [...this.blockedTools] } : {}),
    };
  }
}

/** The turn whose scope the caller is running in, if any. */
export function currentTurnSpend(): TurnSpend | undefined {
  return spendScope.getStore();
}

// ---------------------------------------------------------------------------
// recording model calls

/** CallOptions.context that tags a model call's ledger row with its kind. */
export function spendContext(kind: SpendKind): { spendKind: SpendKind } {
  return { spendKind: kind };
}

export function kindFromContext(context: unknown): SpendKind | undefined {
  const k = (context as { spendKind?: unknown } | null | undefined)?.spendKind;
  return typeof k === 'string' && KINDS.has(k) ? (k as SpendKind) : undefined;
}

/**
 * The observer every Flint client in the server shares. Core emits one
 * `onResponse` per provider pass, so each tool-loop iteration, each retry, the
 * answer-only call and each fallback tier's attempt is its own ledger row. The
 * local brain (Ollama) is free and not recorded. A stream cut off part way (a
 * closed tab, a timeout, an error mid-answer) is billed by the vendor for its
 * full input and the output generated so far; the Anthropic adapter reports
 * that on its error event and core passes it here (reason `aborted` / `error`),
 * so it is counted too. A request that failed before reaching the model was not
 * billed and reports nothing. (The OpenAI adapter reports no partial usage, so
 * a cut-off OpenAI stream is not counted: an under-count, rare on a last resort.)
 */
export function spendObserver(ledger: SpendLedger): AiObserver {
  return {
    onResponse(e) {
      const vendor = vendorOfProvider(e.provider);
      if (!vendor) return;
      ledger.record({
        vendor,
        model: e.model,
        kind: kindFromContext(e.context) ?? 'chat',
        usd: ledger.priceTokens(vendor, e.model, e.usage),
        tokens: e.usage,
      });
    },
  };
}

/**
 * Wrap an OPTIONAL frontier completion (the research planner) so it refuses
 * while `paused()` gives a reason. It throws rather than returning nothing, so
 * the caller's own fallback takes over (deep_research plans heuristically).
 * Inside an eval replay it never pauses: the replay is exempt from Flint's caps
 * like the rest of its turn, and its planner call is eval spend, not Will's.
 */
export function pausable(complete: (prompt: string) => Promise<string>, paused: () => string | undefined): (prompt: string) => Promise<string> {
  return async (prompt) => {
    const why = currentTurnSpend()?.kind === 'eval' ? undefined : paused();
    if (why) throw new Error(why);
    return complete(prompt);
  };
}

// ---------------------------------------------------------------------------
// paid MCP tools (they run in other processes; metered per successful call)

export interface PaidToolSpec {
  /** Registry name, e.g. `web.web_search`. */
  name: string;
  vendor: PaidVendor;
  kind: SpendKind;
  /** What the ledger row names as the model. */
  model: string;
  usdPerCall: (args: unknown) => number;
  /**
   * Where the model should go instead once this vendor's budget is spent, best
   * first. The refusal names only those that are wired and whose own vendor
   * still has budget (refusalText), so a spent search never sends the model to
   * another spent one.
   */
  instead: PaidToolAlternative[];
}

export interface PaidToolAlternative {
  /** The tool to suggest; named only when it is wired. */
  tool: string;
  /** The paid vendor it spends; named only while that vendor has budget. */
  vendor: PaidVendor;
  /** How to name it (default: the tool name). */
  say?: string;
}

function positive(raw: string | undefined): number | undefined {
  const n = Number(raw?.trim());
  return raw?.trim() && Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** A keyless search the model can still reach through web.fetch_url. */
export const KEYLESS_SEARCH = 'https://html.duckduckgo.com/html/?q=<url-encoded query>';
/** The free page fetcher (packages/mcp web server) that reaches KEYLESS_SEARCH. */
export const KEYLESS_FETCH_TOOL = 'web.fetch_url';

/**
 * The MCP tools that cost money per call, priced per SUCCESSFUL call (their
 * token usage never reaches this process). Estimates, overridable:
 * FLINT_PERPLEXITY_USD_PER_CALL (default $0.008), FLINT_TAVILY_USD_PER_CALL
 * (one basic search = one credit, default $0.008; an advanced search is two).
 */
export function paidToolSpecs(env: Record<string, string | undefined>): PaidToolSpec[] {
  const perplexity = positive(env.FLINT_PERPLEXITY_USD_PER_CALL) ?? PERPLEXITY_SEARCH_CALL_USD;
  const tavily = positive(env.FLINT_TAVILY_USD_PER_CALL) ?? TAVILY_USD_PER_CREDIT;
  const insteadOfTavily: PaidToolAlternative[] = [{ tool: 'trident.perplexity_search', vendor: 'perplexity' }];
  return [
    {
      name: 'trident.perplexity_search',
      vendor: 'perplexity',
      kind: 'tool-perplexity',
      model: 'sonar',
      usdPerCall: () => perplexity,
      instead: [
        { tool: 'web.web_search', vendor: 'tavily', say: 'web.web_search (or deep_research)' },
        { tool: 'trident.web_search', vendor: 'tavily' },
      ],
    },
    { name: 'web.web_search', vendor: 'tavily', kind: 'tool-search', model: 'search-basic', usdPerCall: () => tavily, instead: insteadOfTavily },
    // trident's web_search is Tavily too, and takes a search_depth.
    {
      name: 'trident.web_search',
      vendor: 'tavily',
      kind: 'tool-search',
      model: 'search',
      usdPerCall: (args) => tavilySearchCredits((args as { search_depth?: unknown } | null)?.search_depth) * tavily,
      instead: insteadOfTavily,
    },
  ];
}

/**
 * The refusal a spent paid tool returns, built at call time: it names only
 * alternatives that are wired and whose vendor still has budget (one per
 * vendor), plus the keyless page fetch when web.fetch_url is wired. With every
 * paid search spent it says so plainly and points at the keyless fetch, or,
 * without one, tells the model to answer from what it knows and say live search
 * is unavailable, so it stops hopping between spent tools (each hop is another
 * paid model pass).
 */
export function refusalText(
  spec: PaidToolSpec,
  blocked: string,
  opts: { wired: ReadonlySet<string>; guard: { blocked(vendor: PaidVendor): string | undefined } },
): string {
  const keyless = opts.wired.has(KEYLESS_FETCH_TOOL) ? `${KEYLESS_FETCH_TOOL} on a keyless search page (${KEYLESS_SEARCH})` : undefined;
  const seen = new Set<PaidVendor>();
  const paid: string[] = [];
  const spent = new Set<PaidVendor>([spec.vendor]);
  for (const alt of spec.instead) {
    if (!opts.wired.has(alt.tool)) continue;
    if (opts.guard.blocked(alt.vendor)) {
      spent.add(alt.vendor);
      continue;
    }
    if (seen.has(alt.vendor)) continue;
    seen.add(alt.vendor);
    paid.push(alt.say ?? alt.tool);
  }
  if (paid.length > 0) return `${blocked} Use ${[...paid, ...(keyless ? [keyless] : [])].join(', or ')} for this instead.`;
  const names = [...spent].map((v) => SHORT_NAMES[v]).join(' and ');
  const off = `Paid web search is off for now (the ${names} ${spent.size > 1 ? 'budgets are' : 'budget is'} spent).`;
  if (keyless) return `${blocked} ${off} Use ${keyless} instead.`;
  return `${blocked} ${off} Answer from what you already know, and tell Will that live search is unavailable until the budget resets.`;
}

/**
 * Whether a tool result is a success worth paying for. MCP errors come back as
 * `{ isError: true }`; the trident server instead returns its failures as a
 * JSON string with an `error` field; an unapproved call never ran.
 */
export function toolSucceeded(result: unknown): boolean {
  if (result === null || result === undefined) return false;
  if (typeof result === 'object') {
    const r = result as { isError?: unknown; approved?: unknown; error?: unknown };
    return r.isError !== true && r.approved !== false && r.error === undefined;
  }
  if (typeof result === 'string') {
    const t = result.trim();
    if (!t) return false;
    if (t.startsWith('{')) {
      try {
        const parsed = JSON.parse(t) as { error?: unknown };
        if (parsed && typeof parsed === 'object' && parsed.error !== undefined && parsed.error !== null) return false;
      } catch {
        /* not JSON: an answer */
      }
    }
  }
  return true;
}

/**
 * Wrap the paid tools: refused with a clear, routable error once their
 * vendor's budget is spent (never a silent failure), and recorded per
 * successful call. Every other tool passes through untouched. deep_research
 * calls these same wrapped handlers, so its searches are metered and gated too.
 *
 * Inside an eval replay (a TurnSpend scope) a successful call is recorded as
 * `eval` spend (the ledger takes the scope's kind), so parity's searches never
 * use up Will's own Tavily / Perplexity caps; the replay's cost reports them to
 * parity instead. A refusal there is noted on the turn (`budgetBlocked`), so
 * parity doesn't judge an answer Flint had to give without search.
 */
export function meterPaidTools(tools: Tool[], deps: { guard: SpendGuard; specs: PaidToolSpec[] }): Tool[] {
  const byName = new Map(deps.specs.map((s) => [s.name, s] as const));
  const wired = new Set(tools.map((t) => t.definition.name));
  return tools.map((tool) => {
    const spec = byName.get(tool.definition.name);
    if (!spec) return tool;
    return {
      definition: tool.definition,
      handler: async (call) => {
        const blocked = deps.guard.blocked(spec.vendor);
        if (blocked) {
          currentTurnSpend()?.noteBlocked(spec.name);
          return { isError: true, content: refusalText(spec, blocked, { wired, guard: deps.guard }) };
        }
        const result = await tool.handler(call);
        if (toolSucceeded(result)) {
          deps.guard.ledger.record({ vendor: spec.vendor, model: spec.model, kind: spec.kind, usd: spec.usdPerCall(call.args) });
        }
        return result;
      },
    };
  });
}

// ---------------------------------------------------------------------------
// text-to-speech

export type SpeechResult =
  | { status: 'ok'; audio: Buffer }
  | { status: 'no-key' }
  | { status: 'budget'; message: string };

/**
 * /speak under the OpenAI budget: refused (the console then speaks with the
 * browser's own voice) once OpenAI's cap is spent, and charged per character
 * sent when it succeeds.
 */
export async function speakWithinBudget(
  text: string,
  deps: { guard: SpendGuard; model: string; maxChars: number; synth: (text: string) => Promise<Buffer | null> },
): Promise<SpeechResult> {
  const blocked = deps.guard.blocked('openai');
  if (blocked) return { status: 'budget', message: `${blocked} Using the browser's voice.` };
  const audio = await deps.synth(text);
  if (!audio) return { status: 'no-key' };
  deps.guard.ledger.record({ vendor: 'openai', model: deps.model, kind: 'tts', usd: ttsCostOf(deps.model, Math.min(text.length, deps.maxChars)) });
  return { status: 'ok', audio };
}

// ---------------------------------------------------------------------------
// asking Flint

/** The snapshot as a few readable lines (what spend_status returns). */
export function formatSpend(s: SpendSnapshot): string {
  const lines = [`Flint's paid API spend (${s.day}, ${s.timeZone}):`];
  for (const v of PAID_VENDORS) {
    const st = s.vendors[v];
    const part = (p: PeriodStatus, label: string) =>
      p.capUsd !== undefined ? `${usd(p.usd)} ${label} of a ${usd(p.capUsd)} cap (${Math.round(p.pct ?? 0)}%)` : `${usd(p.usd)} ${label} (no cap)`;
    const evalPart = st.month.evalUsd > 0 ? `; parity evals ${usd(st.today.evalUsd)} today, ${usd(st.month.evalUsd)} this month (not counted against the cap)` : '';
    lines.push(`- ${st.name}: ${part(st.today, 'today')}; ${part(st.month, 'this month')}${evalPart}. ${st.effect}`);
  }
  lines.push(`Behaviour changes at ${Math.round(s.thresholds.degrade * 100)}% of a cap (cheaper tier, background work waits) and ${Math.round(s.thresholds.exhausted * 100)}% (that vendor is not called).`);
  return lines.join('\n');
}

/**
 * spend_status: a read-only built-in so Will can just ask Flint what he has
 * spent. Not in the core tool list (the local brain's prompt budget is already
 * past its ~12-tool comfort line); the router appends it when a question is
 * about spend, credits or budgets.
 */
export function spendStatusTool(guard: SpendGuard): Tool {
  return {
    definition: {
      name: 'spend_status',
      description:
        "Flint's own paid API spend today and this month (Claude/Anthropic, OpenAI, Perplexity, Tavily) against its budget caps, and what is limited. Use when Will asks about spend, costs, credits or budgets.",
      inputSchema: { type: 'object', properties: {} },
      idempotent: true,
    },
    handler: async () => formatSpend(guard.snapshot()),
  };
}

/** One boot-log line: the caps in force. */
export function describeCaps(caps: Caps): string {
  const parts = PAID_VENDORS.map((v) => {
    const c = caps[v] ?? {};
    const d = c.dailyUsd !== undefined ? `${usd(c.dailyUsd)}/day` : 'no daily cap';
    const m = c.monthlyUsd !== undefined ? `${usd(c.monthlyUsd)}/month` : 'no monthly cap';
    return `${v} ${d}, ${m}`;
  });
  return parts.join('; ');
}
