/**
 * Calibration snapshots: one row per (window, domain, type, method, kind),
 * written nightly (P4 part 2; queue ledger.snapshot) for the trailing 90 days.
 *
 * Scored means resolved, superseded ones included (a forecaster who revises
 * does not escape the score); open, expired, condition-unmet, void and
 * late-superseded predictions are counted beside it, and the unresolved rate
 * is expired / (scored + expired), so a ledger that quietly lets predictions
 * lapse shows it.
 *
 *  - A yes/no row (kind `binary`) has the Brier score, the base rate, the skill
 *    and the ten bins. At 100 scored or more it also has ECE and a 90%
 *    interval around the Brier score (the database refuses either below 100).
 *    The interval resamples clusters, not rows: a goal's forecasts are one
 *    cluster, and every other prediction is clustered by the local day its
 *    claim was about, so results that share a goal or a day do not fake a tight
 *    interval. Fewer than 10 clusters: no interval (bootstrap.ts).
 *  - A range row (kind `interval`) has the share of ranges that held and the
 *    scaled pinball loss. With nothing scored yet its coverage is 0 beside
 *    n = 0, as a yes/no row's Brier score is: read `n` first.
 *
 * The window is by when a prediction was made. Rows are rewritten, never
 * added, when the same window is scored again.
 */
import { Prisma } from '@prisma/client';
import { addLocalDays, localDay, localDayBounds } from '@flint/policy';
import type { Db } from '../db.js';
import { appendAudit } from '../governance/audit.js';
import { clusterBootstrapMean, seedFrom } from './bootstrap.js';
import { score, scoreRanges, type Scored, type ScoredRange } from './scoring.js';

/** The audit action a nightly snapshot is recorded under (its policy action). */
export const SNAPSHOT_ACTION = 'ledger.calibration.snapshot';

/** How far back a nightly snapshot looks. */
export const WINDOW_DAYS = 90;
/** ECE and the Brier interval are stored only from this many scored predictions (the database's rule too). */
export const MIN_SCORED = 100;

/** The nightly window: the 90 local days up to the start of today. Running it twice in a day rewrites the same rows. */
export function nightlyWindow(tz: string, now: Date): { windowStart: Date; windowEnd: Date } {
  const today = localDay(tz, now);
  return { windowStart: localDayBounds(tz, addLocalDays(today, -WINDOW_DAYS)).start, windowEnd: localDayBounds(tz, today).start };
}

export interface SnapshotCounts {
  groups: number;
  /** Yes/no predictions scored, and ranges scored. */
  scored: number;
  ranges: number;
  /** Ranges left out of the pinball loss (their run has no scale). */
  unscaled: number;
  /** Groups that reached 100 scored and got ECE. */
  withEce: number;
  /** Of those, the ones that also had clusters enough for an interval. */
  withInterval: number;
}

export async function snapshotCalibration(db: Db, windowStart: Date, windowEnd: Date, tz = 'UTC', counts?: SnapshotCounts) {
  const preds = await db.prediction.findMany({
    where: { createdAt: { gte: windowStart, lt: windowEnd } },
    // In a fixed order, so the same rows give the same sums and the same interval on every run.
    orderBy: { id: 'asc' },
    select: {
      domain: true, type: true, method: true, kind: true, status: true, probability: true, lateSupersession: true, goalId: true,
      lower: true, upper: true, level: true,
      resolution: { select: { outcome: true, outcomeValue: true, eventAt: true } },
      forecastRun: { select: { scale: true } },
    },
  });
  const groups = new Map<string, typeof preds>();
  for (const p of preds) {
    if (p.kind !== 'binary' && p.kind !== 'interval') continue;
    const k = [p.domain, p.type, p.method, p.kind].join('\u0000');
    groups.set(k, [...(groups.get(k) ?? []), p]);
  }
  const written = [];
  for (const [k, ps] of [...groups].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const [domain, type, method, kind] = k.split('\u0000') as [string, string, string, 'binary' | 'interval'];
    const nExpired = ps.filter((p) => p.status === 'expired').length;
    const beside = {
      nOpen: ps.filter((p) => p.status === 'open').length,
      nExpired,
      nConditionUnmet: ps.filter((p) => p.status === 'condition_unmet').length,
      nVoid: ps.filter((p) => p.status === 'void').length,
      nLateSuperseded: ps.filter((p) => p.lateSupersession).length,
    };
    let scores: {
      brier: number | null; baseRate: number | null; brierSkill: number | null; reliability: Prisma.InputJsonArray;
      ece: number | null; brierCiLow: number | null; brierCiHigh: number | null; intervalCoverage: number | null; pinball: number | null;
    };
    let n: number;
    if (kind === 'binary') {
      const resolved = ps.filter((p) => p.resolution && p.resolution.outcome !== null && p.probability !== null && p.status !== 'void');
      const scored: Scored[] = resolved.map((p) => ({ p: p.probability!, o: p.resolution!.outcome! }));
      const s = score(scored);
      n = s.n;
      // A goal is one cluster; everything else is clustered by the local day its claim was about.
      const clusters = resolved.map((p) => (p.goalId ? `goal:${p.goalId}` : `day:${localDay(tz, p.resolution!.eventAt)}`));
      const enough = s.n >= MIN_SCORED;
      const ci = enough ? clusterBootstrapMean(scored.map((r) => (r.p - (r.o ? 1 : 0)) ** 2), clusters, { seed: seedFrom([domain, type, method, kind].join('|')) }) : null;
      scores = {
        brier: s.brier, baseRate: s.baseRate, brierSkill: s.brierSkill, reliability: s.reliability as unknown as Prisma.InputJsonArray,
        ece: enough ? s.ece : null,
        // The percentile ends, kept inside what a Brier score can be.
        brierCiLow: ci ? Math.max(0, ci[0]) : null, brierCiHigh: ci ? Math.min(1, ci[1]) : null,
        intervalCoverage: null, pinball: null,
      };
      if (counts) {
        counts.scored += s.n;
        if (enough) counts.withEce += 1;
        if (ci) counts.withInterval += 1;
      }
    } else {
      const ranges: ScoredRange[] = ps
        .filter((p) => p.resolution && p.resolution.outcomeValue !== null && p.lower !== null && p.upper !== null && p.level !== null && p.status !== 'void')
        .map((p) => ({ lower: p.lower!, upper: p.upper!, level: p.level!, value: p.resolution!.outcomeValue!, scale: p.forecastRun?.scale ?? null }));
      const s = scoreRanges(ranges);
      n = s.n;
      scores = {
        brier: null, baseRate: null, brierSkill: null, reliability: [] as Prisma.InputJsonArray, ece: null, brierCiLow: null, brierCiHigh: null,
        intervalCoverage: s.coverage ?? 0, pinball: s.pinball,
      };
      if (counts) {
        counts.ranges += s.n;
        counts.unscaled += s.unscaled;
      }
    }
    const data = { windowStart, windowEnd, domain, type, method, kind, n, ...beside, ...scores, unresolvedRate: n + nExpired ? nExpired / (n + nExpired) : 0 };
    written.push(
      await db.calibrationSnapshot.upsert({
        where: { windowEnd_domain_type_method_kind: { windowEnd, domain, type, method, kind } },
        create: data,
        update: { ...data, computedAt: new Date() },
      }),
    );
    if (counts) counts.groups += 1;
  }
  return written;
}

/** The nightly run: score the trailing window, and say so in one audit entry (counts only). */
export async function runSnapshot(db: Db, o: { tz: string; now?: Date; tier?: 'alone' | 'approval' | 'forbidden' }): Promise<SnapshotCounts> {
  const now = o.now ?? new Date();
  const { windowStart, windowEnd } = nightlyWindow(o.tz, now);
  const counts: SnapshotCounts = { groups: 0, scored: 0, ranges: 0, unscaled: 0, withEce: 0, withInterval: 0 };
  await snapshotCalibration(db, windowStart, windowEnd, o.tz, counts);
  await appendAudit(db, [{
    actor: 'runtime:ledger', context: 'autonomous', kind: 'action', action: SNAPSHOT_ACTION, outcome: 'ok', ...(o.tier ? { tier: o.tier } : {}),
    inputs: { ...counts, windowDays: WINDOW_DAYS },
    // Stamped by the wall clock: the trail says when it ran.
  }]);
  return counts;
}
