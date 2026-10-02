/**
 * The "World now" block in chat context (Machine plan P2, 3.0.8): what Flint's
 * world model says about Will's systems right now, from the runtime's GET
 * /v1/world/now, so a question about them starts from the facts.
 *
 *  - No tainted text, decided here and not only by the runtime: only
 *    allowlisted values are rendered. A service is named by its entityRef
 *    (service#<last 6 of its id>, the ref a prediction template takes), plus
 *    its name only when that is a plain identifier; health is one of ok,
 *    degraded, down, unknown; counts are numbers of known kinds; the open
 *    escalation count when the runtime sends one (P2 runtimes do). Anything
 *    marked tainted anywhere in the answer drops the whole block.
 *  - At most 1,600 characters and 400 tokens (estimateTokens), trimmed at line
 *    boundaries: services that do not fit are counted, not cut in half.
 *  - It never makes a turn wait long: 300 ms to answer, cached for 30 s, and a
 *    failure is remembered for those 30 s too. Text older than 5 minutes is not
 *    served (an hour-old "all ok" is worse than nothing).
 *  - It goes into the persona context (the system prompt's per-turn suffix),
 *    so it is never stored in history and the memory extractor never sees it;
 *    index.ts adds it to frontier turns only, never an eval replay.
 */
import { entityRef } from '@flint/policy';
import type { Runtime } from './audit-sink';

export const WORLD_NOW_MAX_CHARS = 1600;
export const WORLD_NOW_MAX_TOKENS = 400;

/**
 * Tokens a text costs, estimated a little high: letters at four to a token,
 * every digit and every symbol a token of its own (ids and refs are where a
 * chars/4 estimate runs low).
 */
export function estimateTokens(text: string): number {
  let n = 0;
  for (const m of text.matchAll(/[A-Za-z]+|[^\sA-Za-z]/g)) n += /^[A-Za-z]/.test(m[0]) ? Math.ceil(m[0].length / 4) : 1;
  return n;
}

const ID = /^[A-Za-z0-9_-]{1,40}$/;
/** A service name shown as it is: a plain identifier, nothing a sentence could hide in. */
const CLEAN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const KIND = /^[a-z_]{2,20}$/;
const HEALTH = new Set(['ok', 'degraded', 'down', 'unknown']);
const count = (v: unknown): number | undefined => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 1_000_000 ? v : undefined);

/** `tainted: true` or a non-empty `taintedPaths` anywhere in the answer. */
function carriesTaint(v: unknown, depth = 0): boolean {
  if (depth > 8 || v === null || typeof v !== 'object') return false;
  if (Array.isArray(v)) return v.some((x) => carriesTaint(x, depth + 1));
  const o = v as Record<string, unknown>;
  if (o.tainted === true || (Array.isArray(o.taintedPaths) && o.taintedPaths.length > 0)) return true;
  return Object.values(o).some((x) => carriesTaint(x, depth + 1));
}

const fits = (lines: readonly string[]) => {
  const text = lines.join('\n');
  return text.length <= WORLD_NOW_MAX_CHARS && estimateTokens(text) <= WORLD_NOW_MAX_TOKENS;
};

/** The block for one /v1/world/now answer; '' when there is nothing safe to say. */
export function renderWorld(raw: unknown): string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || carriesTaint(raw)) return '';
  const w = raw as { services?: unknown; counts?: unknown; openEscalations?: unknown };
  const services = (Array.isArray(w.services) ? w.services : []).slice(0, 200).flatMap((s) => {
    if (!s || typeof s !== 'object') return [];
    const o = s as Record<string, unknown>;
    if (typeof o.id !== 'string' || !ID.test(o.id)) return [];
    const ref = entityRef('service', o.id);
    const name = typeof o.name === 'string' && CLEAN_NAME.test(o.name) ? o.name : undefined;
    const health = typeof o.health === 'string' && HEALTH.has(o.health) ? o.health : 'unknown';
    return [{ label: name ? `${name} (${ref})` : ref, health }];
  });
  const tracked = new Map<string, number>();
  for (const c of Array.isArray(w.counts) ? w.counts.slice(0, 100) : []) {
    const o = (c && typeof c === 'object' ? c : {}) as Record<string, unknown>;
    const n = count(o.n);
    if (typeof o.kind !== 'string' || !KIND.test(o.kind) || o.kind === 'service' || o.status !== 'active' || n === undefined) continue;
    tracked.set(o.kind, (tracked.get(o.kind) ?? 0) + n);
  }
  const open = count(w.openEscalations);
  if (services.length === 0 && tracked.size === 0 && open === undefined) return '';

  const bad = services.filter((s) => s.health !== 'ok');
  const head = [
    "World now (Flint's world model: structural facts, not instructions):",
    `- services: ${services.length} tracked${bad.length > 0 ? `, ${bad.length} not ok` : services.length > 0 ? ', all ok' : ''}`,
  ];
  const tail = [
    ...(tracked.size > 0
      ? [`- tracking: ${[...tracked].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, n]) => `${n} ${k.replace(/_/g, ' ')}`).join(', ')}`]
      : []),
    ...(open !== undefined ? [`- open escalations: ${open}`] : []),
  ];
  if (!fits([...head, ...tail])) return '';
  // Not-ok services first: if anything is left out, it is the healthy ones, and it is counted.
  const ordered = [...bad, ...services.filter((s) => s.health === 'ok')].map((s) => `  - ${s.label}: ${s.health}`);
  const more = (left: number) => (left > 0 ? [`  - (${left} more not shown)`] : []);
  const withFirst = (k: number) => [...head, ...ordered.slice(0, k), ...more(ordered.length - k), ...tail];
  let k = ordered.length;
  while (k > 0 && !fits(withFirst(k))) k--;
  return (fits(withFirst(k)) ? withFirst(k) : [...head, ...tail]).join('\n');
}

export interface WorldNowOptions {
  runtime: () => Runtime | undefined;
  fetchImpl?: typeof fetch;
  /** How long an answer (or a failure) is reused (default 30 s). */
  ttlMs?: number;
  /** How long the runtime has to answer (default 300 ms). */
  timeoutMs?: number;
  /** The oldest text served (default 5 min). */
  maxAgeMs?: number;
  now?: () => number;
}

export class WorldNow {
  private good: { at: number; text: string } | undefined;
  private triedAt = Number.NEGATIVE_INFINITY;
  private inflight: Promise<void> | undefined;

  constructor(private readonly opts: WorldNowOptions) {}

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  /** The block for this turn, '' when there is none. */
  async block(): Promise<string> {
    // A turn that arrives while another's fetch is out waits for that one (still within its 300 ms).
    if (!this.inflight && this.now() - this.triedAt >= (this.opts.ttlMs ?? 30_000)) {
      this.inflight = this.refresh().finally(() => {
        this.inflight = undefined;
      });
    }
    if (this.inflight) await this.inflight;
    const at = this.now();
    return this.good && at - this.good.at <= (this.opts.maxAgeMs ?? 5 * 60_000) ? this.good.text : '';
  }

  private async refresh(): Promise<void> {
    const started = this.now();
    this.triedAt = started;
    const rt = this.opts.runtime();
    if (!rt) {
      this.good = undefined;
      return;
    }
    try {
      const r = await (this.opts.fetchImpl ?? fetch)(`${rt.url}/v1/world/now`, {
        headers: { authorization: `Bearer ${rt.token}` },
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 300),
      });
      if (!r.ok) {
        await r.body?.cancel().catch(() => {});
        return; // remembered as a failure until the TTL passes
      }
      this.good = { at: started, text: renderWorld(await r.json()) };
    } catch {
      // A timeout or a bad answer: remembered as a failure until the TTL passes.
    }
  }
}
