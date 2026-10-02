/**
 * P2's daily measures (03:20 local, for the previous local day), as daily
 * (`D`) metric series, computed before the events they come from lose their
 * payloads to retention:
 *
 *  - p2.chat.p95_ms: the 95th percentile of chat turn time;
 *  - p2.chat.recall_fallback_rate: the share of turns whose recall fell back
 *    (lexical, a timeout, an error) of the turns that recalled at all;
 *  - p2.ctx_tokens.world, p2.ctx_tokens.recall: the context blocks' mean size;
 *  - p2.lane.relevant, p2.lane.quiet: decisions per lane;
 *  - p2.latency.median_s: from a polled source's change to the world model
 *    knowing it (EntityVersion.validFrom minus SourceEvent.occurredAt).
 * A measure with nothing to measure that day is not written.
 */
import { Prisma } from '@prisma/client';
import { localDay, localDayBounds, previousDay } from '@flint/policy';
import type { Db } from './db.js';

/** Recall that did not run as designed: the embedder failed, it timed out, or it errored. */
export const RECALL_FALLBACKS: ReadonlySet<string> = new Set(['lexical', 'timeout', 'error']);

/** Sources Flint polls (the latency criterion is theirs). */
export const POLLED = ['launchd', 'health', 'git', 'spend', 'github', 'railway', 'nexus'];

export function percentile(values: readonly number[], p: number): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))]!;
}
const mean = (v: readonly number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null);

const SERIES: Record<string, { unit: string; description: string }> = {
  'p2.chat.p95_ms': { unit: 'ms', description: '95th percentile of chat turn time, per day' },
  'p2.chat.recall_fallback_rate': { unit: 'share', description: 'share of chat turns whose recall fell back to lexical or timed out, per day' },
  'p2.ctx_tokens.world': { unit: 'tokens', description: 'mean World now block size on the turns that had one, per day' },
  'p2.ctx_tokens.recall': { unit: 'tokens', description: 'mean recall block size on the turns that had one, per day' },
  'p2.lane.relevant': { unit: 'count', description: 'triage decisions in the relevant lane, per day' },
  'p2.lane.quiet': { unit: 'count', description: 'triage decisions in the quiet lane, per day' },
  'p2.latency.median_s': { unit: 's', description: "median seconds from a polled source's change to the world model, per day" },
};

export async function dayMeasures(db: Db, start: Date, end: Date): Promise<Record<keyof typeof SERIES, number | null>> {
  const turns = (await db.sourceEvent.findMany({ where: { source: 'server', type: 'chat.turn', occurredAt: { gte: start, lt: end }, payload: { not: Prisma.DbNull } }, select: { payload: true } }))
    .map((e) => (e.payload ?? {}) as { ms?: unknown; recall?: unknown; ctxTokens?: { world?: unknown; recall?: unknown } });
  const ms = turns.map((t) => t.ms).filter((x): x is number => typeof x === 'number');
  // Turns that recalled at all; of them, the ones that fell back (as the server's baseline counts them).
  const recalled = turns.map((t) => t.recall).filter((x): x is string => typeof x === 'string' && x !== 'none' && x !== 'skipped');
  const tokens = (k: 'world' | 'recall') => turns.map((t) => t.ctxTokens?.[k]).filter((x): x is number => typeof x === 'number');
  const lanes = await db.triageDecision.groupBy({ by: ['lane'], where: { createdAt: { gte: start, lt: end } }, _count: { _all: true } });
  const lane = (l: string) => lanes.find((x) => x.lane === l)?._count._all ?? 0;
  const lags = await db.$queryRaw<Array<{ s: number }>>`
    SELECT EXTRACT(EPOCH FROM (v."validFrom" - e."occurredAt"))::float8 AS s
    FROM "SourceEvent" e JOIN "EntityVersion" v ON v."sourceEventId" = e.id
    WHERE e.source = ANY (${POLLED}::text[]) AND e."receivedAt" >= ${start} AND e."receivedAt" < ${end}`;
  return {
    'p2.chat.p95_ms': percentile(ms, 0.95),
    'p2.chat.recall_fallback_rate': recalled.length ? recalled.filter((r) => RECALL_FALLBACKS.has(r)).length / recalled.length : null,
    'p2.ctx_tokens.world': mean(tokens('world')),
    'p2.ctx_tokens.recall': mean(tokens('recall')),
    'p2.lane.relevant': lane('relevant'),
    'p2.lane.quiet': lane('quiet'),
    'p2.latency.median_s': percentile(lags.map((l) => Math.max(0, l.s)), 0.5),
  };
}

export async function runRollups(db: Db, tz: string, now = new Date()): Promise<{ day: string; written: number }> {
  const day = previousDay(localDay(tz, now));
  const { start, end } = localDayBounds(tz, day);
  const m = await dayMeasures(db, start, end);
  let written = 0;
  for (const [key, value] of Object.entries(m)) {
    if (value === null) continue;
    const s = SERIES[key]!;
    await db.metricSeries.upsert({ where: { key }, create: { key, unit: s.unit, freq: 'D', sensitivity: 'ops', description: s.description }, update: {} });
    written += (await db.metricPoint.createMany({ data: [{ seriesKey: key, at: start, value }], skipDuplicates: true })).count;
  }
  return { day, written };
}
