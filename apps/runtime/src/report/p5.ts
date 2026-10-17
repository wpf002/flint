/**
 * P5's exit report (assets, tasks and reviews), measured from the database as
 * it stands: GET /v1/p5/report and `pnpm --filter @flint/runtime p5-report`.
 * Each criterion says pass, fail, or null (not enough data yet), with the
 * numbers behind it.
 *
 * These seven criteria were written for P5 from what it built, not copied from
 * the Machine plan (whose P5 section is not in this repository): each task goes
 * out only on a signed card; no result is accepted without passing its checks
 * or Will overruling them; every daily limit holds; nothing is spent; once
 * reviews are required, no card that needs one is approved before its review;
 * Local Reviews reviews the cards that need one; and Flint's checks agree with
 * Will's own calls, which is the evidence P5's promotion table rests on.
 *
 * Numbers only, served on the `world:read` scope like the other reports: never
 * a task's title, a result, a review's words or an id.
 */
import type { Db } from '../db.js';
import type { Criterion } from './exit.js';
import { acceptCards, acceptedTasks, capsKept, dispatchedTasks, reviewCoverage, reviewerEverOn, reviewsWritten, taskSpend } from '../tasks/measures.js';

const DAY = 86_400_000;
/** Criteria 5 to 7 look back this far. */
export const P5_WINDOW_DAYS = 30;
/** Local Reviews passes with at least this share of the cards that needed one reviewed, over at least P5_MIN_CARDS. */
export const P5_REVIEWED_SHARE = 0.9;
/** Flint's checks pass with at most this share of Will's calls going against them, over at least P5_MIN_CARDS. */
export const P5_DISAGREE_SHARE = 0.1;
export const P5_MIN_CARDS = 5;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const pct = (x: number) => `${Math.round(x * 100)}%`;

export async function p5Report(db: Db, now = new Date()): Promise<{ at: string; criteria: Criterion[] }> {
  const out: Criterion[] = [];
  const since = new Date(now.getTime() - P5_WINDOW_DAYS * DAY);

  // 1. Every task that went out did so on a card Will signed.
  const d = await dispatchedTasks(db);
  out.push({
    n: 1, name: 'every task goes out only on a card you signed',
    pass: d.went === 0 ? null : d.unsigned === 0,
    detail: d.went === 0 ? 'no task has gone out yet' : `${plural(d.went, 'task')} went out; ${d.unsigned} without a signed card behind it (the database refuses one: test/p5-guards-db.test.ts)`,
    values: { wentOut: d.went, unsigned: d.unsigned },
  });

  // 2. No result is accepted unless it passed its checks, or Will accepted it anyway on a signed card.
  const a = await acceptedTasks(db);
  out.push({
    n: 2, name: 'no result is accepted without passing its checks or your signed Accept Anyway',
    pass: a.accepted === 0 ? null : a.unearned === 0,
    detail: a.accepted === 0 ? 'no result has been accepted yet' : `${plural(a.accepted, 'result')} accepted; ${a.unearned} with neither a passing check nor your Accept Anyway`,
    values: { accepted: a.accepted, unearned: a.unearned },
  });

  // 3. Every daily limit held: local tasks, CI watches, reviews, and accepting alone.
  const c = await capsKept(db);
  out.push({
    n: 3, name: 'every daily limit holds: local tasks, CI watches, reviews and accepting alone',
    pass: c.days === 0 ? null : c.over === 0,
    detail: c.days === 0 ? 'nothing has been counted under a limit yet' : `${plural(c.days, 'day')} counted under a limit; ${c.over} went past it; the busiest day used ${pct(c.busiest)} of its limit`,
    values: { daysCounted: c.days, overLimit: c.over, busiestShare: Math.round(c.busiest * 100) / 100 },
  });

  // 4. Nothing was spent: no task cost money, and no paid dispatch ran (none is built).
  const s = await taskSpend(db);
  out.push({
    n: 4, name: 'nothing is spent',
    pass: s.tasks === 0 ? null : s.costUsd === 0 && s.paidRan === 0,
    detail: s.tasks === 0 ? 'no task yet' : `${plural(s.tasks, 'task')}, costing $${s.costUsd.toFixed(2)} in all; ${plural(s.paidRan, 'paid dispatch', 'paid dispatches')} ran`,
    values: { tasks: s.tasks, costUsd: s.costUsd, paidDispatchesRan: s.paidRan },
  });

  // 5. Once reviews are required, no card that needs one is approved before its review.
  const r = await reviewCoverage(db, since);
  out.push({
    n: 5, name: 'once reviews are required, no card that needs one is approved before its review',
    pass: r.violations > 0 ? false : r.required && r.approved > 0 ? true : null,
    detail: !r.required
      ? `reviews have not been required yet; ${r.reviewedFirst} of ${plural(r.approved, 'card')} approved in ${P5_WINDOW_DAYS} days that needed a review had one first`
      : `reviews are ${r.requiredNow ? '' : 'not '}required now; ${r.violations} approved without a review since they were last required; ${r.reviewedFirst} of ${plural(r.approved, 'card')} approved in ${P5_WINDOW_DAYS} days that needed a review had one first`,
    values: { required: r.requiredNow, everRequired: r.required, violations: r.violations, approved: r.approved, reviewedFirst: r.reviewedFirst },
  });

  // 6. Local Reviews reviews the cards that need one.
  const on = await reviewerEverOn(db);
  const w = await reviewsWritten(db, since);
  const share = w.needed ? w.reviewed / w.needed : 0;
  out.push({
    n: 6, name: `Local Reviews reviews at least ${pct(P5_REVIEWED_SHARE)} of the cards that need one`,
    pass: !on || w.needed < P5_MIN_CARDS ? null : share >= P5_REVIEWED_SHARE,
    detail: !on
      ? 'Local Reviews has not been turned on yet'
      : `${w.reviewed} of ${plural(w.needed, 'card')} filed in ${P5_WINDOW_DAYS} days that needed a review had one (${pct(share)})${w.needed < P5_MIN_CARDS ? `; needs ${P5_MIN_CARDS}` : ''}; `
        + `the verdicts were ${w.verdicts.proceed} Go Ahead, ${w.verdicts.proceed_with_changes} Go Ahead with Changes and ${w.verdicts.block} Hold Off; ${w.agreed} had both passes agree`,
    values: { needed: w.needed, reviewed: w.reviewed, proceed: w.verdicts.proceed ?? 0, proceedWithChanges: w.verdicts.proceed_with_changes ?? 0, block: w.verdicts.block ?? 0, agreed: w.agreed },
  });

  // 7. Flint's checks agree with Will: of his calls on results, few go against the check (a passing result he
  //    rejected, or one he accepted or rejected anyway). This is what the promotion table asks him to trust.
  const k = await acceptCards(db, since);
  const calls = k.accepted + k.rejected + k.acceptedAnyway + k.rejectedAnyway;
  const against = k.rejected + k.acceptedAnyway + k.rejectedAnyway;
  out.push({
    n: 7, name: 'Flint’s checks agree with your own calls on results',
    pass: calls < P5_MIN_CARDS ? null : against / calls <= P5_DISAGREE_SHARE,
    detail: calls === 0
      ? 'you have not decided a checked result yet'
      : `${plural(calls, 'call')} on checked results in ${P5_WINDOW_DAYS} days: you accepted ${k.accepted} that passed and rejected ${k.rejected}; you accepted ${k.acceptedAnyway} and rejected ${k.rejectedAnyway} against the check; ${k.expired} expired`
        + `${calls < P5_MIN_CARDS ? `; needs ${P5_MIN_CARDS}` : ''}`,
    values: { calls, acceptedPassing: k.accepted, rejectedPassing: k.rejected, acceptedAnyway: k.acceptedAnyway, rejectedAnyway: k.rejectedAnyway, expired: k.expired },
  });

  return { at: now.toISOString(), criteria: out };
}
