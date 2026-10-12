/**
 * The ledger's sweep (P4 part 2; queue ledger.sweep): Flint checks its own
 * predictions. Until now nothing resolved, expired or scored one. In order:
 *
 *  1. Triage's advice is decided from the escalation that showed it to Will:
 *     acknowledged before the resolve time is taken up, dismissed is declined,
 *     left until the resolve time is lapsed. Decided once (the database's
 *     rule). Declined or lapsed, the prediction of what the advice would do
 *     becomes `condition_unmet` with it. Advice of any other type is its own
 *     module's, and is not touched.
 *  2. Every prediction that is due, resolves by itself and is the sweep's to
 *     settle is given to its resolver (predict/resolvers.ts). Superseded ones
 *     too: a forecaster that revises does not escape its score. One that
 *     carries another module's rule is left alone and only counted.
 *  3. What could not be settled runs out, after a grace: 72 hours past its
 *     resolve time for one that resolves by itself (a weekend outage must not
 *     turn into "unresolved"). One only Will resolves runs out 14 days after
 *     Flint asked him about it, and never before he was asked.
 *
 * It never voids (that needs Will's signature) and never resolves as Will (the
 * database refuses it without his answer).
 *
 * One sweep is one transaction: every row it changes and the audit entry that
 * counts them commit together, or none does, so a run that dies leaves nothing
 * half-told and its retry starts from the same rows. Each prediction's writes
 * sit in a savepoint of their own: one the database refuses is taken back,
 * counted and left, and the sweep goes on. One sweep runs at a time (a
 * transaction lock): a second that starts meanwhile does nothing and writes
 * nothing. A second run over the same rows changes nothing.
 *
 * One audit entry per sweep, counts only. Log lines: counts and ids.
 */
import { randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { Db, Tx } from '../db.js';
import { appendAudit } from '../governance/audit.js';
import { failureOf } from '../dbcodes.js';
import { DUE_COLUMNS, ESCALATION_ACTION, decisionOf, ruleOwner, verdictFor, type DuePrediction, type WaitReason } from '../predict/resolvers.js';

const HOUR = 3_600_000;
/** How long past its resolve time a prediction that resolves by itself may still be settled before it runs out. */
export const AUTO_GRACE_MS = 72 * HOUR;
/** A prediction only Will resolves runs out this long after Flint asked him about it: two weeks to answer. Never asked, it never runs out. */
export const WILL_GRACE_MS = 14 * 24 * HOUR;
/** A superseded prediction cannot run out (the ledger keeps it superseded), so the sweep stops trying one after this long. */
export const SUPERSEDED_RETRY_MS = 14 * 24 * HOUR;
/** Predictions read per page, and the most one sweep takes on (the rest wait an hour). */
const PAGE = 200;
export const SWEEP_LIMIT = 5000;
/** The longest one sweep's transaction may take (the job itself is given 15 minutes). */
const SWEEP_TX_MS = 5 * 60_000;
/** The transaction lock one sweep holds (a stable 32-bit key, as the source runs take theirs). Exported for the tests. */
export const SWEEP_LOCK = [...'flint.ledger.sweep'].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) | 0, 7);

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
  /** Open, due predictions the sweep cannot check: no rule at all, or a rule that does not fit its own row. They run out. */
  unknownSpec: number;
  /** Due predictions that could not be settled yet. */
  waiting: number;
  /** Due predictions that carry another module's rule: left alone, never run out from here. */
  others: number;
  /** Writes the database refused: taken back, counted, left, never retried in this sweep. */
  refused: number;
  /** True when the sweep stopped at its limit with more of its own still due. */
  capped: boolean;
  /** Another sweep was running: this one did nothing and wrote nothing, not even an audit entry. */
  busy?: true;
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

type Cursor = { resolveBy: Date; id: string };
type Log = (msg: string) => void;

const newId = (prefix: string, now: Date) => `${prefix}${now.getTime().toString(36)}${randomBytes(6).toString('hex')}`;

/**
 * One row's writes, in a savepoint of their own. The database refused one: all of them are taken back, the refusal is
 * handed to the caller, and the sweep's transaction goes on. Only a failure to take them back (the connection is gone,
 * the transaction ran out of time) throws, and that ends the sweep with nothing written.
 */
async function row<T>(tx: Tx, write: () => Promise<T>): Promise<{ ok: true; did: T } | { ok: false; err: unknown }> {
  await tx.$executeRaw`SAVEPOINT ledger_row`;
  try {
    const did = await write();
    await tx.$executeRaw`RELEASE SAVEPOINT ledger_row`;
    return { ok: true, did };
  } catch (err) {
    await tx.$executeRaw`ROLLBACK TO SAVEPOINT ledger_row`;
    await tx.$executeRaw`RELEASE SAVEPOINT ledger_row`;
    return { ok: false, err };
  }
}

/** Step 1: decide each piece of triage's advice still open, from its escalation. */
async function settleRecommendations(tx: Tx, now: Date, counts: SweepCounts, log: Log): Promise<void> {
  const open = await tx.$queryRaw<Array<{ id: string; predictionId: string; resolveBy: Date }>>`
    SELECT r.id, r."predictionId", p."resolveBy" FROM "Recommendation" r JOIN "Prediction" p ON p.id = r."predictionId"
    WHERE r.status = 'proposed' AND r.type = ${ESCALATION_ACTION} AND p.resolver = 'conditional' AND p."conditionRecommendationId" = r.id
    ORDER BY p."resolveBy", r.id LIMIT ${SWEEP_LIMIT}`;
  for (const r of open) {
    const e = await tx.escalation.findFirst({ where: { recommendationId: r.id }, orderBy: { createdAt: 'desc' }, select: { status: true, ackedAt: true } });
    const d = decisionOf(e, r.resolveBy, now);
    if (!d) continue;
    const did = await row(tx, async () => {
      // Decided once: a row already decided is left as it is.
      const n = await tx.recommendation.updateMany({ where: { id: r.id, status: 'proposed' }, data: { status: d.status, decidedAt: d.decidedAt } });
      // Declined or lapsed: what it promised can never be checked now, whatever its date. The prediction says so at once.
      const unmet = n.count && d.status !== 'accepted' ? (await tx.prediction.updateMany({ where: { id: r.predictionId, status: 'open' }, data: { status: 'condition_unmet' } })).count : 0;
      return { settled: n.count, unmet };
    });
    // Counted only once its writes stand: a refusal takes both back, and counts neither.
    if (did.ok) {
      counts.settled += did.did.settled;
      counts.conditionUnmet += did.did.unmet;
    } else {
      counts.refused += 1;
      log(`ledger: recommendation ${r.id} was not decided: ${failureOf(did.err)}`);
    }
  }
}

/** One page of predictions that are due and resolve by themselves, oldest resolve time first, after a cursor. */
async function duePage(tx: Tx, now: Date, after: Cursor | undefined, size: number): Promise<DuePrediction[]> {
  const cursor = after ? Prisma.sql`AND (p."resolveBy", p.id) > (${after.resolveBy}, ${after.id})` : Prisma.empty;
  return tx.$queryRaw<DuePrediction[]>`
    SELECT ${DUE_COLUMNS}
    FROM "Prediction" p
    WHERE p."resolveBy" <= ${now} AND p.resolver IN (${Prisma.join([...AUTO])})
      AND (p.status = 'open' OR (p.status = 'superseded' AND p."resolveBy" > ${new Date(now.getTime() - SUPERSEDED_RETRY_MS)}))
      AND NOT EXISTS (SELECT 1 FROM "Resolution" r WHERE r."predictionId" = p.id)
      ${cursor}
    ORDER BY p."resolveBy", p.id LIMIT ${size}`;
}

/** Settle one prediction: its verdict, then its writes. Returns what happened. */
async function settleOne(tx: Tx, p: DuePrediction, o: { tz: string; now: Date }): Promise<'resolved' | 'condition_unmet' | 'unknown' | 'other' | WaitReason> {
  const v = await verdictFor(tx, p, o);
  if (v.verdict === 'unknown' || v.verdict === 'other') return v.verdict;
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
}

/** Step 2: everything due that is the sweep's to settle, oldest first, up to the limit. Returns the last prediction it took on. */
async function settleDue(tx: Tx, o: { tz: string; now: Date; limit: number }, counts: SweepCounts, log: Log): Promise<Cursor | undefined> {
  let after: Cursor | undefined;
  let last: Cursor | undefined;
  let tried = 0;
  for (;;) {
    const page = await duePage(tx, o.now, after, PAGE);
    for (const p of page) {
      // Another module's rule: its row is not this sweep's to settle, to count as a fault, or to run out.
      if (ruleOwner(p) === 'other') {
        counts.others += 1;
        continue;
      }
      // Capped only when one more of its own is still there: a sweep that took on exactly its limit and found no more is whole.
      if (tried >= o.limit) {
        counts.capped = true;
        return last;
      }
      tried += 1;
      last = { resolveBy: p.resolveBy, id: p.id };
      const did = await row(tx, () => settleOne(tx, p, o));
      if (!did.ok) {
        // The database refused it (a guard, a race with another writer): its class, its SQLSTATE and the id, never the row.
        counts.refused += 1;
        log(`ledger: prediction ${p.id} was not settled: ${failureOf(did.err)}`);
      } else if (did.did === 'resolved') counts.resolved += 1;
      else if (did.did === 'condition_unmet') counts.conditionUnmet += 1;
      else if (did.did === 'other') counts.others += 1;
      // Only an open one runs out, so only an open one is said to: a superseded one with no rule just stops being read.
      else if (did.did === 'unknown' && p.status === 'open') counts.unknownSpec += 1;
      else counts.waiting += 1;
    }
    const end = page[page.length - 1];
    if (page.length < PAGE || !end) return last;
    after = { resolveBy: end.resolveBy, id: end.id };
  }
}

/** One prediction runs out. The ledger's guard has the last word on each. */
async function expireOne(tx: Tx, id: string, counts: SweepCounts, log: Log): Promise<void> {
  const did = await row(tx, async () => (await tx.prediction.updateMany({ where: { id, status: 'open' }, data: { status: 'expired' } })).count);
  if (did.ok) counts.expired += did.did;
  else {
    counts.refused += 1;
    log(`ledger: prediction ${id} did not expire: ${failureOf(did.err)}`);
  }
}

/**
 * Step 3: predictions that ran out.
 *  - One only Will resolves: 14 days after Flint asked him about it (its question's time). Never asked, it stays open:
 *    Flint does not let a prediction of his lapse before it has put the question to him.
 *  - One that resolves by itself: 72 hours past its resolve time, if it is the sweep's own or nobody's. Another
 *    module's rule is left to that module. `auto` says which of them may run out this time: all (`all`), none
 *    (`none`), or, after a sweep that stopped at its limit, only those at or before the last one it took on. So a
 *    head of rows that can never be settled runs out and makes way, and nothing runs out that the sweep has not tried.
 */
async function expire(tx: Tx, now: Date, auto: 'all' | 'none' | Cursor, counts: SweepCounts, log: Log): Promise<void> {
  const asked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT p.id FROM "Prediction" p
    WHERE p.status = 'open' AND p.resolver = 'will' AND NOT EXISTS (SELECT 1 FROM "Resolution" r WHERE r."predictionId" = p.id)
      AND EXISTS (SELECT 1 FROM "PredictionQuestion" q WHERE q."predictionId" = p.id AND q."askedAt" < ${new Date(now.getTime() - WILL_GRACE_MS)})
    ORDER BY p."resolveBy", p.id LIMIT ${SWEEP_LIMIT}`;
  for (const p of asked) await expireOne(tx, p.id, counts, log);
  if (auto === 'none') return;
  const upTo = auto === 'all' ? Prisma.empty : Prisma.sql`AND (p."resolveBy", p.id) <= (${auto.resolveBy}, ${auto.id})`;
  let after: Cursor | undefined;
  for (let read = 0; read < 2 * SWEEP_LIMIT; ) {
    const cursor = after ? Prisma.sql`AND (p."resolveBy", p.id) > (${after.resolveBy}, ${after.id})` : Prisma.empty;
    const page = await tx.$queryRaw<DuePrediction[]>`
      SELECT ${DUE_COLUMNS} FROM "Prediction" p
      WHERE p.status = 'open' AND p.resolver IN (${Prisma.join([...AUTO])}) AND p."resolveBy" < ${new Date(now.getTime() - AUTO_GRACE_MS)}
        AND NOT EXISTS (SELECT 1 FROM "Resolution" r WHERE r."predictionId" = p.id)
        ${upTo} ${cursor}
      ORDER BY p."resolveBy", p.id LIMIT ${PAGE}`;
    for (const p of page) if (ruleOwner(p) !== 'other') await expireOne(tx, p.id, counts, log);
    const end = page[page.length - 1];
    if (page.length < PAGE || !end) return;
    read += page.length;
    after = { resolveBy: end.resolveBy, id: end.id };
  }
}

export async function sweep(db: Db, o: SweepOptions): Promise<SweepCounts> {
  const now = o.now ?? new Date();
  const log = o.log ?? (() => {});
  const limit = Math.max(1, o.limit ?? SWEEP_LIMIT);
  return db.$transaction(async (tx: Tx) => {
    const counts: SweepCounts = { settled: 0, resolved: 0, conditionUnmet: 0, expired: 0, unknownSpec: 0, waiting: 0, others: 0, refused: 0, capped: false };
    // One sweep at a time. The lock is the transaction's: it is let go when this commits or dies, whatever happens.
    const got = await tx.$queryRaw<Array<{ ok: boolean }>>`SELECT pg_try_advisory_xact_lock(${SWEEP_LOCK}::int) AS ok`;
    if (!got[0]?.ok) return { ...counts, busy: true as const };
    let last: Cursor | undefined;
    if (o.resolve) {
      await settleRecommendations(tx, now, counts, log);
      last = await settleDue(tx, { tz: o.tz, now, limit }, counts, log);
    }
    // What resolves by itself runs out only once the sweep has tried it (or when resolving is not allowed at all).
    if (o.expire) await expire(tx, now, !counts.capped ? 'all' : (last ?? 'none'), counts, log);
    await appendAudit(tx, [{
      // The sweep ran: `ok`. What the database refused is a count beside the others (Health says so when there is any).
      actor: LEDGER_ACTOR, context: 'autonomous', kind: 'action', action: SWEEP_ACTION, outcome: 'ok',
      inputs: {
        settled: counts.settled, resolved: counts.resolved, conditionUnmet: counts.conditionUnmet, expired: counts.expired, unknownSpec: counts.unknownSpec,
        waiting: counts.waiting, others: counts.others, refused: counts.refused, capped: counts.capped, resolveRan: o.resolve, expireRan: o.expire,
        ...(o.tiers ? { resolveTier: o.tiers.resolve, expireTier: o.tiers.expire } : {}),
      },
      // Stamped by the wall clock, whatever time this sweep was asked to judge by: the trail says when it ran. In
      // this transaction: the entry and the rows it counts are written together or not at all.
    }]);
    return counts;
  }, { timeout: SWEEP_TX_MS, maxWait: 10_000 });
}
