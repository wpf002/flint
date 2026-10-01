/**
 * spend: Flint's own spend ledger (~/.flint/spend/spend-YYYY-MM.jsonl), numbers
 * only, every minute. Each vendor's level against its daily and monthly cap
 * (normal, 50, 80, 100 %) is state; the dollar figures are metrics. The eval
 * ledger (evolve's daily.csv) is shown beside it, never added in: the two may
 * overlap until a run id links them (plan 3.0.8).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Source, SourceObservation, MetricObservation } from './types.js';

export const VENDORS = ['anthropic', 'openai', 'perplexity', 'tavily'] as const;
export type Vendor = (typeof VENDORS)[number];
export type Caps = Partial<Record<Vendor, { dailyUsd?: number; monthlyUsd?: number }>>;

export interface SpendOptions {
  dir: string;
  evalCsv?: string;
  caps: Caps;
  tz: string;
}

const local = (tz: string, at: Date) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, month: `${p.year}-${p.month}` };
};

export function level(spent: { day: number; month: number }, cap: { dailyUsd?: number; monthlyUsd?: number } = {}): 'normal' | '50' | '80' | '100' {
  const fr = Math.max(
    cap.dailyUsd !== undefined ? (cap.dailyUsd === 0 ? (spent.day > 0 ? Infinity : 0) : spent.day / cap.dailyUsd) : 0,
    cap.monthlyUsd !== undefined ? (cap.monthlyUsd === 0 ? (spent.month > 0 ? Infinity : 0) : spent.month / cap.monthlyUsd) : 0,
  );
  return fr >= 1 ? '100' : fr >= 0.8 ? '80' : fr >= 0.5 ? '50' : 'normal';
}

/** Totals per vendor for the local day and month of `now`; eval rows do not count against caps. */
export function totals(lines: string, tz: string, now: Date): Record<Vendor, { day: number; month: number }> {
  const want = local(tz, now);
  const out = Object.fromEntries(VENDORS.map((v) => [v, { day: 0, month: 0 }])) as Record<Vendor, { day: number; month: number }>;
  for (const line of lines.split('\n')) {
    if (!line.trim()) continue;
    let row: { ts?: unknown; vendor?: unknown; usd?: unknown; kind?: unknown };
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof row.ts !== 'number' || typeof row.usd !== 'number' || !Number.isFinite(row.usd) || row.kind === 'eval') continue;
    if (!(VENDORS as readonly unknown[]).includes(row.vendor)) continue;
    const at = local(tz, new Date(row.ts));
    if (at.month !== want.month) continue;
    const t = out[row.vendor as Vendor];
    t.month += row.usd;
    if (at.day === want.day) t.day += row.usd;
  }
  return out;
}

/** Today's eval spend from evolve's daily.csv (`ts` is local "YYYY-MM-DD HH:MM", cost in the last column). */
export function evalToday(csv: string, tz: string, now: Date): number {
  const { day } = local(tz, now);
  let sum = 0;
  for (const line of csv.split('\n').slice(1)) {
    if (!line.startsWith(day)) continue;
    const cost = Number(line.slice(line.lastIndexOf(',') + 1));
    if (Number.isFinite(cost) && cost >= 0) sum += cost;
  }
  return sum;
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;

export function spendSource(o: SpendOptions): Source {
  return {
    name: 'spend',
    cadenceMs: 60_000,
    async run({ now }) {
      const { month } = local(o.tz, now);
      const file = join(o.dir, `spend-${month}.jsonl`);
      const t = totals(existsSync(file) ? readFileSync(file, 'utf8') : '', o.tz, now);
      const observations: SourceObservation[] = [];
      const metrics: MetricObservation[] = [];
      for (const v of VENDORS) {
        const key = `account:vendor:${v}`;
        observations.push({ type: 'account.level', kind: 'account', key, name: v, sensitivity: 'financial', externalId: `vendor:${v}`, state: { vendor: v, level: level(t[v], o.caps[v]) } });
        for (const period of ['day', 'month'] as const) {
          metrics.push({
            series: { key: `spend.${v}.${period}.usd`, unit: 'usd', freq: 'raw', sensitivity: 'financial', description: `${v} spend so far this ${period} (Flint's ledger, eval excluded)`, entityKey: { kind: 'account', key } },
            at: now,
            value: round(t[v][period]),
          });
        }
      }
      if (o.evalCsv && existsSync(o.evalCsv)) {
        metrics.push({
          series: { key: 'spend.eval.day.usd', unit: 'usd', freq: 'raw', sensitivity: 'financial', description: "evolve's eval spend so far today (shown beside Flint's, not added in)" },
          at: now,
          value: round(evalToday(readFileSync(o.evalCsv, 'utf8'), o.tz, now)),
        });
      }
      return { observations, metrics };
    },
  };
}
