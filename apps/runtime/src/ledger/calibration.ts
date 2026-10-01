/**
 * Calibration snapshots: one row per (window, domain, type, method). Scored
 * means resolved, superseded ones included (a forecaster who revises does not
 * escape the score); open, expired, condition-unmet, void and late-superseded
 * predictions are counted beside it, and the unresolved rate is expired / (scored
 * + expired), so a ledger that quietly lets predictions lapse shows it.
 */
import { Prisma } from '@prisma/client';
import type { Db } from '../db.js';
import { score, type Scored } from './scoring.js';

export async function snapshotCalibration(db: Db, windowStart: Date, windowEnd: Date) {
  const preds = await db.prediction.findMany({
    where: { createdAt: { gte: windowStart, lt: windowEnd }, kind: 'binary' },
    include: { resolution: true },
  });
  const groups = new Map<string, typeof preds>();
  for (const p of preds) {
    const k = `${p.domain}\u0000${p.type}\u0000${p.method}`;
    groups.set(k, [...(groups.get(k) ?? []), p]);
  }
  const written = [];
  for (const [k, ps] of groups) {
    const [domain, type, method] = k.split('\u0000') as [string, string, string];
    const scored: Scored[] = ps
      .filter((p) => p.resolution && p.resolution.outcome !== null && p.probability !== null && p.status !== 'void')
      .map((p) => ({ p: p.probability!, o: p.resolution!.outcome! }));
    const s = score(scored);
    const nExpired = ps.filter((p) => p.status === 'expired').length;
    const data = {
      windowStart,
      windowEnd,
      domain,
      type,
      method,
      n: s.n,
      nOpen: ps.filter((p) => p.status === 'open').length,
      nExpired,
      nConditionUnmet: ps.filter((p) => p.status === 'condition_unmet').length,
      nVoid: ps.filter((p) => p.status === 'void').length,
      nLateSuperseded: ps.filter((p) => p.lateSupersession).length,
      brier: s.brier,
      baseRate: s.baseRate,
      brierSkill: s.brierSkill,
      reliability: s.reliability as unknown as Prisma.InputJsonArray,
      unresolvedRate: s.n + nExpired ? nExpired / (s.n + nExpired) : 0,
    };
    written.push(
      await db.calibrationSnapshot.upsert({
        where: { windowEnd_domain_type_method: { windowEnd, domain, type, method } },
        create: data,
        update: { ...data, computedAt: new Date() },
      }),
    );
  }
  return written;
}
