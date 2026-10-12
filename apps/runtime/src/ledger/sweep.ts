/**
 * The ledger's sweep (P4 part 2; queue ledger.sweep): Flint checks its own
 * predictions. Until now nothing resolved, expired or scored one. In order:
 *
 *  1. Recommendations are decided from the escalation that showed them to
 *     Will: acknowledged before the resolve time is taken up, dismissed is
 *     declined, left until the resolve time is lapsed. Decided once (the
 *     database's rule). Declined or lapsed, the prediction of what the advice
 *     would do becomes `condition_unmet` in the same transaction.
 *  2. Every prediction that is due and resolves by itself is given to its
 *     resolver (predict/resolvers.ts). Superseded ones too: a forecaster that
 *     revises does not escape its score.
 *  3. What could not be settled runs out, after a grace: 72 hours past its
 *     resolve time for one that resolves by itself (a weekend outage must not
 *     turn into "unresolved"), 14 days for one only Will resolves.
 *
 * It never voids (that needs Will's signature) and never resolves as Will (the
 * database refuses it without his answer). Each prediction is settled in its
 * own short transaction; one the database refuses is counted and left, and the
 * sweep goes on. A second run over the same rows changes nothing.
 *
 * One audit entry per sweep, counts only. Log lines: counts and ids.
 */
import { randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { Db, Tx } from '../db.js';
import { appendAudit } from '../governance/audit.js';
import { failureOf } from '../dbcodes.js';
import { decisionOf, verdictFor, type DuePrediction, type WaitReason } from '../predict/resolvers.js';

const HOUR = 3_600_000;
/** How long past its resolve time a prediction that resolves by itself may still be settled before it runs out. */
export const AUTO_GRACE_MS = 72 * HOUR;
/** The same for a prediction only Will resolves: two weeks for him to answer. */
export const WILL_GRACE_MS = 14 * 24 * HOUR;
/** A superseded prediction cannot run out (the ledger keeps it superseded), so the sweep stops trying one after this long. */
export const SUPERSEDED_RETRY_MS = 14 * 24 * HOUR;
/** Predictions read per page, and the most one sweep takes on (the rest wait an hour). */
const PAGE = 200;
export const SWEEP_LIMIT = 5000;

/** The actor on the sweep's audit entries. */
export const LEDGER_ACTOR = 'runtime:ledger';
/** The audit action one sweep is recorded under (Health reads it to say when predictions were last checked). */
export const SWEEP_ACTION = 'ledger.sweep';

const AUTO = ['auto_world', 'auto_metric', 'conditional'] as const;

/**
 * Has Will ever turned predictions on? Until the signed Turn On Predictions
 * card has made a ForecastSeries row (the database lets nothing else make
 * one), every prediction job does nothing: FLINT_PREDICT alone starts nothing.
 * A number turned off again still counts: what Flint already predicted keeps
 * being checked.
 */
export async function predictionsStarted(db: Db): Promise<boolean> {
  return (await db.forecastSeries.findFirst({ select: { seriesKey: true } })) !== null;
}

export interface SweepCounts {
  /** Recommendations decided (taken up, declined or lapsed). */
  settled: number;
  /** Resolutions written. */
  resolved: number;
  /** Predictions whose recommendation was declined or lapsed. */
  conditionUnmet: number;
  /** Predictions that ran out unresolved. */
  expired: number;
  /** Due predictions whose rule no resolver knows: left alone. */
  unknownSpec: number;
  /** Due predictions that could not be settled yet. */
  waiting: number;
  /** Writes the database refused: counted, left, never retried in this sweep. */
  refused: number;
  /** True when the sweep stopped at its limit with more still due. */
  capped: boolean;
}

export interface SweepOptions {
  tz: string;
  now?: Date;
  /** May ledger.resolve.auto run (steps 1 and 2)? */
  resolve: boolean;
  /** May ledger.expire run (step 3)? */
  expire: boolean;
  /** The tiers the two actions resolved to, for the audit entry. */
  tiers?: { resolve: string; expire: string };
  /** The most predictions this sweep takes on (SWEEP_LIMIT). */
  limit?: number;
  log?: (msg: string) => void;
}

const newId = (prefix: string, now: Date) => `${prefix}${now.getTime().toString(36)}${randomBytes(6).toString('hex')}`;

/** Step 1: decide each recommendation still open, from its escalation. */
async function settleRecommendations(db: Db, now: Date, counts: SweepCounts, log: (msg: string) => void): Promise<void> {
  const open = await db.$queryRaw<Array<{ id: string; predictionId: string; resolveBy: Date }>>`
    SELECT r.id, r."predictionId", p."resolveBy" FROM "Recommendation" r JOIN "Prediction" p ON p.id = r."predictionId"
    WHERE r.status = 'proposed' AND p.resolver = 'conditional' AND p."conditionRecommendationId" = r.id
    ORDER BY p."resolveBy", r.id LIMIT ${SWEEP_LIMIT}`;
  for (const r of open) {
    try {
      const e = await db.escalation.findFirst({ where: { recommendationId: r.id }, orderBy: { createdAt: 'desc' }, select: { status: true, ackedAt: true } });
      const d = decisionOf(e, r.resolveBy, now);
      if (!d) continue;
      await db.$transaction(async (tx: Tx) => {
        // Decided once: a row another sweep already decided is left as it is.
        const n = await tx.recommendation.updateMany({ where: { id: r.id, status: 'proposed' }, data: { status: d.status, decidedAt: d.decidedAt } });
        counts.settled += n.count;
        // Declined or lapsed: what it promised can never be checked now, whatever its date. The prediction says so at once.
        if (n.count && d.status !== 'accepted') {
          counts.conditionUnmet += (await tx.prediction.updateMany({ where: { id: r.predictionId, status: 'open' }, data: { status: 'condition_unmet' } })).count;
        }
      });
    } catch (err) {
      counts.refused += 1;
      log(`ledger: recommendation ${r.id} was not decided: ${failureOf(err)}`);
    }
  }
}

/** One page of predictions that are due and resolve by themselves, oldest resolve time first, after a cursor. */
async function duePage(db: Db, now: Date, after: { resolveBy: Date; id: string } | undefined, size: number): Promise<DuePrediction[]> {
  const cursor = after ? Prisma.sql`AND (p."resolveBy", p.id) > (${after.resolveBy}, ${after.id})` : Prisma.empty;
  return db.$queryRaw<DuePrediction[]>`
    SELECT p.id, p.kind, p.status, p.resolver, p."resolverSpec", p."resolveBy", p."createdAt", p."seriesKey", p."goalId", p."subjectEntityId", p."conditionRecommendationId"
    FROM "Prediction" p
    WHERE p."resolveBy" <= ${now} AND p.resolver IN (${Prisma.join([...AUTO])})
      AND (p.status = 'open' OR (p.status = 'superseded' AND p."resolveBy" > ${new Date(now.getTime() - SUPERSEDED_RETRY_MS)}))
      AND NOT EXISTS (SELECT 1 FROM "Resolution" r WHERE r."predictionId" = p.id)
      ${cursor}
    ORDER BY p."resolveBy", p.id LIMIT ${size}`;
}

/** Settle one prediction in its own transaction. Returns what happened. */
async function settleOne(db: Db, p: DuePrediction, o: { tz: string; now: Date }): Promise<'resolved' | 'condition_unmet' | 'unknown' | WaitReason> {
  return db.$transaction(async (tx: Tx) => {
    const v = await verdictFor(tx, p, o);
    if (v.verdict === 'unknown') return 'unknown';
    if (v.verdict === 'wait') return v.why;
    if (v.verdict === 'condition_unmet') {
      // Only an open prediction moves there (the ledger's rule); a superseded one stays superseded.
      const n = p.status === 'open' ? await tx.prediction.updateMany({ where: { id: p.id, status: 'open' }, data: { status: 'condition_unmet' } }) : { count: 0 };
      return n.count ? 'condition_unmet' : 'superseded';
    }
    await tx.resolution.create({
      data: {
        id: newId('rs', o.now), predictionId: p.id, outcome: v.outcome, outcomeValue: v.outcomeValue, eventAt: v.eventAt, resolvedBy: v.resolvedBy,
        evidence: { ...v.evidence, via: SWEEP_ACTION } as Prisma.InputJsonObject,
      },
    });
    // What the recommendation led to, on its own row, once.
    if (p.conditionRecommendationId && v.outcome !== null) {
      await tx.recommendation.updateMany({ where: { id: p.conditionRecommendationId, effectObserved: null }, data: { effectObserved: v.outcome, outcomeAt: v.eventAt } });
    }
    return 'resolved';
  });
}

/** Step 3: predictions that ran out. One row at a time: the ledger's guard has the last word on each. */
async function expire(db: Db, now: Date, auto: boolean, counts: SweepCounts, log: (msg: string) => void): Promise<void> {
  const autoBefore = new Date(now.getTime() - AUTO_GRACE_MS);
  const willBefore = new Date(now.getTime() - WILL_GRACE_MS);
  const due = await db.$queryRaw<Array<{ id: string }>>`
    SELECT p.id FROM "Prediction" p
    WHERE p.status = 'open' AND NOT EXISTS (SELECT 1 FROM "Resolution" r WHERE r."predictionId" = p.id)
      AND ((p.resolver = 'will' AND p."resolveBy" < ${willBefore})
           OR (${auto} AND p.resolver IN (${Prisma.join([...AUTO])}) AND p."resolveBy" < ${autoBefore}))
    ORDER BY p."resolveBy", p.id LIMIT ${SWEEP_LIMIT}`;
  for (const p of due) {
    try {
      counts.expired += (await db.prediction.updateMany({ where: { id: p.id, status: 'open' }, data: { status: 'expired' } })).count;
    } catch (err) {
      counts.refused += 1;
      log(`ledger: prediction ${p.id} did not expire: ${failureOf(err)}`);
    }
  }
}

export async function sweep(db: Db, o: SweepOptions): Promise<SweepCounts> {
  const now = o.now ?? new Date();
  const log = o.log ?? (() => {});
  const counts: SweepCounts = { settled: 0, resolved: 0, conditionUnmet: 0, expired: 0, unknownSpec: 0, waiting: 0, refused: 0, capped: false };
  const limit = Math.max(1, o.limit ?? SWEEP_LIMIT);
  const size = Math.min(PAGE, limit);
  if (o.resolve) {
    await settleRecommendations(db, now, counts, log);
    let after: { resolveBy: Date; id: string } | undefined;
    let seen = 0;
    for (;;) {
      const page = await duePage(db, now, after, size);
      for (const p of page) {
        try {
          const did = await settleOne(db, p, { tz: o.tz, now });
          if (did === 'resolved') counts.resolved += 1;
          else if (did === 'condition_unmet') counts.conditionUnmet += 1;
          else if (did === 'unknown') counts.unknownSpec += 1;
          else counts.waiting += 1;
        } catch (err) {
          // The database refused it (a guard, a race with another writer): its class, its SQLSTATE and the id, never the row.
          counts.refused += 1;
          log(`ledger: prediction ${p.id} was not settled: ${failureOf(err)}`);
        }
      }
      seen += page.length;
      const last = page[page.length - 1];
      if (page.length < size || !last) break;
      if (seen >= limit) {
        counts.capped = true;
        break;
      }
      after = { resolveBy: last.resolveBy, id: last.id };
    }
  }
  // What resolves by itself runs out only after a sweep that tried all of it (or when resolving is not allowed at all).
  if (o.expire) await expire(db, now, !counts.capped, counts, log);
  await appendAudit(db, [{
    // The sweep ran: `ok`. What the database refused is a count beside the others (Health says so when there is any).
    actor: LEDGER_ACTOR, context: 'autonomous', kind: 'action', action: SWEEP_ACTION, outcome: 'ok',
    inputs: {
      settled: counts.settled, resolved: counts.resolved, conditionUnmet: counts.conditionUnmet, expired: counts.expired, unknownSpec: counts.unknownSpec,
      waiting: counts.waiting, refused: counts.refused, capped: counts.capped, resolveRan: o.resolve, expireRan: o.expire,
      ...(o.tiers ? { resolveTier: o.tiers.resolve, expireTier: o.tiers.expire } : {}),
    },
    // Stamped by the wall clock, whatever time this sweep was asked to judge by: the trail says when it ran.
  }]);
  return counts;
}
