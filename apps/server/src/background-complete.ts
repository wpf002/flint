/**
 * POST /internal/complete (Machine plan P2, 3.0.8): a frontier call the runtime
 * asks for, metered under a background spend kind (runtime, review, dispatch,
 * selfmod). The runtime holds no vendor keys; the server makes the call, so the
 * server is where the money is guarded.
 *
 * In order, before anything is spent:
 *  1. the kind's own caps (FLINT_BUDGET_KIND_<KIND>_DAILY_USD / _MONTHLY_USD,
 *     $0 until Will raises both): refused at $0, or when what the kind has
 *     spent plus this call's estimate (prompt plus maxTokens of answer, priced
 *     high) would pass either cap;
 *  2. the vendor's own cap: refused once Flint's ledger is at 80% of it (the
 *     point where background work waits) or spent;
 *  3. the unified view the runtime pushes (every account's spend on that
 *     vendor): refused when it is missing, older than 2 h, or at 70% of Flint's
 *     cap, and when Flint has no cap for that vendor at all (there is nothing
 *     to hold the 70% against: fail closed);
 *  4. a durable audit intent (fsynced; if it cannot be written, nothing runs);
 *  then the call (no tools, a timeout), metered into the spend ledger under its
 *  kind, and its outcome audited with the cost.
 *
 * One call at a time, so two calls cannot both pass a cap that has room for
 * one; a few may wait, more are refused (busy). Every refusal is audited, with
 * its reason. Nothing the runtime sent (the prompt) reaches the audit trail:
 * ids, enums and numbers only, and a failed call's error as its class.
 *
 * Refusals answer 402 {error, reason} (a budget), 503 (no frontier, busy, no
 * audit) or 502 (the provider failed); the runtime reads any of them as "no
 * text". With the default $0 caps every call is refused.
 */
import { randomBytes } from 'node:crypto';
import { estimateCost, type TokenUsage, type TokenVendor } from '@flint/core';
import { InternalCompleteRequest, type SpendKind as BackgroundKind } from '@flint/policy';
import type { AuditSink } from './audit-sink';
import { DEGRADE_AT, UNIFIED_BACKGROUND_STOP, atLeast, type KindCaps, type SpendGuard } from './spend';

export type CompleteReason =
  | 'bad_request'
  | 'kind_cap'
  | 'vendor_cap'
  | 'vendor_uncapped'
  | 'unified_missing'
  | 'unified_stale'
  | 'unified_70'
  | 'no_frontier'
  | 'busy'
  | 'audit_unavailable'
  | 'provider_failed';

/** The frontier brain background calls use. Its calls are metered by the server's spend observer under `kind`. */
export interface BackgroundFrontier {
  /** The paid vendor it bills, or undefined for a free (local) frontier. */
  vendor: TokenVendor | undefined;
  model: string;
  generate(input: { system: string; prompt: string }, opts: { kind: BackgroundKind; maxTokens: number; signal: AbortSignal }): Promise<{ text: string; usage: TokenUsage }>;
}

export interface CompleteGateDeps {
  guard: Pick<SpendGuard, 'ledger' | 'status' | 'unifiedView'>;
  kindCaps: KindCaps;
  audit: Pick<AuditSink, 'record'>;
  frontier: () => BackgroundFrontier | undefined;
  now?: () => number;
  /** How long the call may take (default 120 s). */
  timeoutMs?: number;
  /** Calls running or waiting before more are refused as busy (default 4). */
  maxWaiting?: number;
  log?: (msg: string) => void;
}

export type CompleteResult =
  | { status: 200; body: { text: string; usage: TokenUsage; costUsd: number } }
  | { status: 400 | 402 | 502 | 503; body: { error: string; reason: CompleteReason } };

const ACTION = 'runtime.frontier.complete';

/** An error's class for the audit trail, never its words. */
function errorClass(err: unknown): string {
  const kind = (err as { error?: { kind?: unknown } } | null)?.error?.kind;
  if (typeof kind === 'string' && /^[a-z_]{1,40}$/.test(kind)) return kind;
  if (err instanceof Error && err.name === 'TimeoutError') return 'timeout';
  return err instanceof Error && /^[A-Za-z]{1,40}$/.test(err.name) ? err.name : 'error';
}

export class CompleteGate {
  private queue: Promise<unknown> = Promise.resolve();
  private waiting = 0;

  constructor(private readonly deps: CompleteGateDeps) {}

  /** One /internal/complete request, from its parsed JSON body. */
  async handle(raw: unknown): Promise<CompleteResult> {
    const parsed = InternalCompleteRequest.safeParse(raw);
    if (!parsed.success) return { status: 400, body: { error: 'not a complete request (kind, ref, system, prompt, maxTokens)', reason: 'bad_request' } };
    const req = parsed.data;
    if (this.waiting >= (this.deps.maxWaiting ?? 4)) return this.refuse(req, 503, 'busy', 'other background calls are waiting; try later');
    this.waiting++;
    const run = this.queue.then(() => this.decideAndCall(req));
    this.queue = run.catch(() => {});
    try {
      return await run;
    } finally {
      this.waiting--;
    }
  }

  private refuse(req: InternalCompleteRequest, status: 402 | 502 | 503, reason: CompleteReason, error: string, extra: Record<string, string | number | null> = {}): CompleteResult {
    try {
      this.deps.audit.record({
        actor: 'runtime', context: 'autonomous', kind: 'decision', action: ACTION, decision: 'deny', outcome: 'denied',
        inputs: { kind: req.kind, ref: req.ref, reason, ...extra }, reasoning: error,
      });
    } catch {
      /* a refusal runs nothing: losing its row costs no safety */
    }
    return { status, body: { error, reason } };
  }

  private async decideAndCall(req: InternalCompleteRequest): Promise<CompleteResult> {
    const now = this.deps.now?.() ?? Date.now();
    const KIND = req.kind.toUpperCase();
    const caps = this.deps.kindCaps[req.kind];
    // 1. the kind's caps: at $0 (the default) nothing else matters.
    if (!(caps.dailyUsd > 0) || !(caps.monthlyUsd > 0)) {
      return this.refuse(req, 402, 'kind_cap', `the ${req.kind} spend kind is capped at $0 (FLINT_BUDGET_KIND_${KIND}_DAILY_USD and _MONTHLY_USD)`);
    }
    const f = this.deps.frontier();
    if (!f) return this.refuse(req, 503, 'no_frontier', 'no frontier brain is configured');
    const where = { vendor: f.vendor ?? 'free', model: f.model.slice(0, 120) };
    // ...and with room for this call's estimate (it errs high).
    const spent = this.deps.guard.ledger.kindTotals(req.kind, now);
    const estimate = f.vendor ? estimateCost(f.vendor, f.model, req.system.length + req.prompt.length, { expectedOutputTokens: req.maxTokens }) : 0;
    const round = (n: number) => Math.round(n * 1e4) / 1e4;
    if (spent.dayUsd + estimate > caps.dailyUsd || spent.monthUsd + estimate > caps.monthlyUsd) {
      const daily = spent.dayUsd + estimate > caps.dailyUsd;
      return this.refuse(
        req, 402, 'kind_cap',
        `the ${req.kind} kind's ${daily ? 'daily' : 'monthly'} cap ($${daily ? caps.dailyUsd : caps.monthlyUsd}) has no room for this call (spent $${round(daily ? spent.dayUsd : spent.monthUsd)}, estimate $${round(estimate)})`,
        { ...where, estimateUsd: round(estimate) },
      );
    }
    if (f.vendor) {
      // 2. the vendor's own cap: background work waits from 80%.
      const s = this.deps.guard.status(f.vendor);
      if (atLeast(s.level, 'degrade')) {
        return this.refuse(req, 402, 'vendor_cap', `${s.name} is at ${Math.round(s.fraction * 100)}% of Flint's cap; background calls stop at ${Math.round(DEGRADE_AT * 100)}%`, where);
      }
      // 3. the unified view: every account's spend on this vendor.
      const u = this.deps.guard.unifiedView(f.vendor, now);
      if (u.state !== 'fresh') {
        return u.state === 'missing'
          ? this.refuse(req, 402, 'unified_missing', `no unified spend view for ${f.vendor} from the runtime`, where)
          : this.refuse(req, 402, 'unified_stale', `the unified spend view for ${f.vendor} is older than 2 h`, where);
      }
      if (u.fraction === undefined) return this.refuse(req, 402, 'vendor_uncapped', `Flint has no cap for ${f.vendor} to hold the unified view against (FLINT_BUDGET_${f.vendor.toUpperCase()}_*)`, where);
      if (u.fraction >= UNIFIED_BACKGROUND_STOP) {
        return this.refuse(req, 402, 'unified_70', `${f.vendor} is at ${Math.round(u.fraction * 100)}% of Flint's cap across every account; background calls stop at ${Math.round(UNIFIED_BACKGROUND_STOP * 100)}%`, where);
      }
    }
    // 4. the intent, on disk before anything is spent.
    const correlationId = `complete:${req.ref}:${randomBytes(4).toString('hex')}`;
    const inputs = { kind: req.kind, ref: req.ref, ...where, maxTokens: req.maxTokens, promptChars: req.system.length + req.prompt.length, estimateUsd: round(estimate) };
    try {
      this.deps.audit.record({ actor: 'runtime', context: 'autonomous', kind: 'intent', action: ACTION, decision: 'act', outcome: 'pending', inputs, correlationId }, true);
    } catch {
      this.deps.log?.('[complete] the intent could not be recorded; the call was not made');
      return { status: 503, body: { error: 'the intent could not be recorded, so nothing was run', reason: 'audit_unavailable' } };
    }
    try {
      const out = await f.generate({ system: req.system, prompt: req.prompt }, { kind: req.kind, maxTokens: req.maxTokens, signal: AbortSignal.timeout(this.deps.timeoutMs ?? 120_000) });
      const costUsd = f.vendor ? Math.round(this.deps.guard.ledger.priceTokens(f.vendor, f.model, out.usage) * 1e6) / 1e6 : 0;
      this.deps.audit.record({
        actor: 'runtime', context: 'autonomous', kind: 'spend', action: ACTION, decision: 'act', outcome: 'ok',
        inputs: { ...inputs, usageIn: out.usage.input, usageOut: out.usage.output }, costUsd, correlationId,
      });
      return { status: 200, body: { text: out.text, usage: out.usage, costUsd } };
    } catch (err) {
      const cls = errorClass(err);
      this.deps.log?.(`[complete] the ${req.kind} call for ${req.ref} failed (${cls})`);
      this.deps.audit.record({
        actor: 'runtime', context: 'autonomous', kind: 'spend', action: ACTION, decision: 'act', outcome: 'failed',
        inputs: { ...inputs, error: cls }, reasoning: `the provider call failed (${cls})`, correlationId,
      });
      return { status: 502, body: { error: `the frontier call failed (${cls})`, reason: 'provider_failed' } };
    }
  }
}
