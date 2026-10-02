/**
 * What the chat gate needs from the runtime (Machine plan 3.0.3): the live
 * ActionPolicy rows Will signed, and atomic cap claims.
 *
 *  - Policies are fetched every minute and kept on disk (0600), so a restart
 *    while the runtime is down still knows them. When the copy is older than
 *    ten minutes, only the rows that tighten are used: a promotion Will has
 *    since revoked must not outlive the runtime's silence, while a tightening
 *    is never dropped by it (fail closed both ways).
 *  - A promoted action's cap is claimed in the runtime before the call runs
 *    (`INSERT ... WHERE count < cap`); 429 is "used up"; anything else is "cannot
 *    say", and the gate then asks Will instead.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { PolicyRow, TierDecision } from '@flint/policy';
import type { Runtime } from './audit-sink';
import type { CapClaim } from './tier-gate';

const TIERS = new Set(['alone', 'approval', 'forbidden']);

/** Rows as the runtime sends them, checked field by field; anything malformed is dropped. */
export function parsePolicies(raw: unknown): PolicyRow[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((r) => {
    if (!r || typeof r !== 'object') return [];
    const o = r as Record<string, unknown>;
    if (typeof o.pattern !== 'string' || o.pattern.length > 200 || typeof o.tier !== 'string' || !TIERS.has(o.tier)) return [];
    if (typeof o.expiresAt !== 'string' || !Number.isFinite(Date.parse(o.expiresAt)) || o.active !== true) return [];
    const cap = o.dailyCap;
    if (cap != null && (typeof cap !== 'number' || !Number.isInteger(cap) || cap < 0)) return [];
    return [{ pattern: o.pattern, tier: o.tier as PolicyRow['tier'], dailyCap: (cap as number | null | undefined) ?? null, active: true, expiresAt: o.expiresAt, ...(o.scope != null ? { scope: o.scope } : {}) }];
  });
}

export interface RuntimePoliciesOptions {
  runtime: () => Runtime | undefined;
  file: string;
  fetchImpl?: typeof fetch;
  log?: (m: string) => void;
  staleMs?: number;
  now?: () => number;
}

export class RuntimePolicies {
  private rows: PolicyRow[] = [];
  private fetchedAt = 0;

  constructor(private readonly o: RuntimePoliciesOptions) {
    try {
      if (existsSync(o.file)) {
        const saved = JSON.parse(readFileSync(o.file, 'utf8')) as { rows?: unknown; fetchedAt?: unknown };
        this.rows = parsePolicies(saved.rows);
        this.fetchedAt = typeof saved.fetchedAt === 'number' ? saved.fetchedAt : 0;
      }
    } catch {
      this.rows = [];
    }
  }

  private now(): number {
    return this.o.now?.() ?? Date.now();
  }

  /** Fetch the live rows. Returns whether the copy is now fresh. */
  async refresh(): Promise<boolean> {
    const rt = this.o.runtime();
    if (!rt) return false;
    try {
      const r = await (this.o.fetchImpl ?? fetch)(`${rt.url}/v1/policies`, { headers: { authorization: `Bearer ${rt.token}` }, signal: AbortSignal.timeout(5000) });
      if (!r.ok) {
        await r.body?.cancel().catch(() => {});
        return false;
      }
      const body = (await r.json()) as { policies?: unknown };
      this.rows = parsePolicies(body.policies);
      this.fetchedAt = this.now();
      mkdirSync(dirname(this.o.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.o.file}.tmp`;
      writeFileSync(tmp, JSON.stringify({ rows: this.rows, fetchedAt: this.fetchedAt }), { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, this.o.file);
      return true;
    } catch (err) {
      this.o.log?.(`[policies] could not refresh from the runtime: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /** The rows the gate uses now: all of them while fresh, only the tightening ones once stale. */
  current(): PolicyRow[] {
    if (this.now() - this.fetchedAt <= (this.o.staleMs ?? 10 * 60_000)) return this.rows;
    return this.rows.filter((r) => r.tier !== 'alone');
  }

  start(ms = 60_000): () => void {
    void this.refresh();
    const t = setInterval(() => void this.refresh(), ms);
    t.unref();
    return () => clearInterval(t);
  }
}

/** Claim a capped decision's counter in the runtime. */
export function capClaimer(runtime: () => Runtime | undefined, fetchImpl: typeof fetch = fetch): CapClaim {
  return async (d: TierDecision) => {
    const rt = runtime();
    if (!rt || !d.cap) return 'unavailable';
    try {
      const r = await fetchImpl(`${rt.url}/v1/counters/claim`, {
        method: 'POST',
        headers: { authorization: `Bearer ${rt.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ action: d.key, limit: d.cap.limit, period: d.cap.period }),
        signal: AbortSignal.timeout(5000),
      });
      await r.body?.cancel().catch(() => {});
      if (r.ok) return 'ok';
      return r.status === 429 ? 'capped' : 'unavailable';
    } catch {
      return 'unavailable';
    }
  };
}
