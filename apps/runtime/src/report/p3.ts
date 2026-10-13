/**
 * P3's exit report (Machine plan P3, eight exit criteria), measured from the
 * database as it stands: GET /v1/p3/report and `pnpm --filter @flint/runtime
 * p3-report`. Each criterion says pass, fail, or null (not enough data yet, or
 * built in a later part), with the numbers behind it.
 *
 * Numbers only. The report is served on the `world:read` scope, like P2's and
 * P2.5's, so it never holds a goal's title, a check's text, a step's title or
 * an id: counts, days, seconds and token sizes (goals/measures.ts).
 */
import { GOALS_BLOCK_MAX_TOKENS, localDay, previousDay } from '@flint/policy';
import type { Config } from '../config.js';
import type { Db } from '../db.js';
import { DAY, activeGoals, addedAlone, chatSuggestions, daysNotRunning, firstReviewAt, goalsBlockSize, overdueNow, planChanges, reviewCounts, reviewForecasts, signedGoals, watchedLatency } from '../goals/measures.js';
import type { Criterion } from './exit.js';

/** Exit 2 looks back this far. */
const WINDOW_DAYS = 30;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export async function p3Report(db: Db, config: Pick<Config, 'tz'> & { planner?: boolean }, now = new Date()): Promise<{ at: string; criteria: Criterion[] }> {
  const out: Criterion[] = [];
  const first = await firstReviewAt(db);

  // 1. At least 3 active goals, with checks Flint reads itself where it can.
  const g = await activeGoals(db);
  out.push({
    n: 1, name: 'at least 3 active goals, with checks Flint reads itself where it can',
    pass: g.active >= 3,
    detail: `${plural(g.active, 'active goal')}; ${g.machine} of ${plural(g.checks, 'check')} read by Flint itself (a step or an item), the rest marked by hand`,
    values: { activeGoals: g.active, checks: g.checks, machineChecks: g.machine },
  });

  // 2. No review more than 24 h late over 30 days, counted from Flint's first review. Late is time waited while
  //    Flint was reviewing (goals/late.ts), so a review that was due while reviews were off was not late. That
  //    alone would pass a month in which reviews never ran: so reviews must also have been ON for each whole
  //    day counted (the health check's Goal Reviews rows, as the promotion table reads them).
  if (!first) {
    out.push({ n: 2, name: 'no review more than 24 h late over 30 days', pass: null, detail: config.planner ? 'no review yet' : 'no review yet: reviews are off (FLINT_PLANNER)', values: { reviews: 0, days: 0 } });
  } else {
    const since = new Date(Math.max(first.getTime() - 1, now.getTime() - WINDOW_DAYS * DAY));
    const c = await reviewCounts(db, since, now);
    const waiting = await overdueNow(db, now);
    const days = (now.getTime() - Math.max(first.getTime(), now.getTime() - WINDOW_DAYS * DAY)) / DAY;
    // The whole local days after the day of the first review and before today, 30 at most.
    let counted = 0;
    for (let d = previousDay(localDay(config.tz, now)); counted < WINDOW_DAYS && d > localDay(config.tz, first); d = previousDay(d)) counted++;
    const off = counted ? (await daysNotRunning(db, config.tz, now, counted)).missing.length : 0;
    out.push({
      n: 2, name: 'no review more than 24 h late over 30 days',
      pass: c.late > 0 || waiting > 0 || off > 0 ? false : days >= WINDOW_DAYS ? true : null,
      detail: `${plural(c.reviews, 'review')} over ${days.toFixed(1)} days (${c.scheduled} scheduled); ${c.lateHour} ran over an hour late, ${c.late} over 24 h; ${plural(waiting, 'goal')} over 24 h past due now; `
        + `reviews were on all day on ${counted - off} of the ${plural(counted, 'day')} before today${days < WINDOW_DAYS ? ` (needs ${WINDOW_DAYS} days)` : ''}`,
      values: { reviews: c.reviews, scheduled: c.scheduled, lateOverHour: c.lateHour, lateOver24h: c.late, overdueNow: waiting, days: Math.round(days * 10) / 10, daysCounted: counted, daysOn: counted - off },
    });
  }

  // 3. A watched item's change sets off a review within 10 minutes. Proven by test; measured here when it has happened.
  const w = await watchedLatency(db, new Date(now.getTime() - WINDOW_DAYS * DAY));
  out.push({
    n: 3, name: 'a watched item’s change sets off a review within 10 min',
    pass: w.n === 0 ? null : w.over10Min === 0,
    detail: w.n === 0
      ? 'no watched change has set off a review yet; checked by test/goals/tick-db.test.ts in every deploy gate'
      : `${plural(w.n, 'review')} set off by a watched change in 30 days; the slowest took ${Math.round(w.maxS ?? 0)} s; ${w.over10Min} took over 10 min`,
    values: { triggered: w.n, slowestS: w.maxS === null ? null : Math.round(w.maxS), over10Min: w.over10Min },
  });

  // 4. Every plan change is a card Will signed, and a review's small changes share one card.
  const p = await planChanges(db);
  out.push({
    n: 4, name: 'every plan change is a signed card, and a review’s small changes share one',
    pass: p.versions === 0 ? null : p.withoutCard === 0 && p.splitMinor === 0,
    detail: p.versions === 0
      ? 'no plan yet'
      : `${plural(p.versions, 'plan version')}, ${p.withoutCard} without a signed card behind it; ${plural(p.reviewsWithCards, 'review')} filed cards, ${p.splitMinor} with small changes on more than one`,
    values: { planVersions: p.versions, withoutCard: p.withoutCard, reviewsWithCards: p.reviewsWithCards, splitMinor: p.splitMinor },
  });

  // 5. No goal starts, finishes, is abandoned or changes what counts as done or its timing without Will's signature.
  const s = await signedGoals(db);
  out.push({
    n: 5, name: 'no goal starts, finishes or changes what counts as done or its timing without your signature',
    pass: s.started === 0 ? null : s.unsigned === 0,
    detail: `${plural(s.started, 'goal')} started; ${s.unsigned} without a signed approval behind its latest change (the database refuses one: test/p3-guards-db.test.ts in every deploy gate)`,
    values: { started: s.started, unsigned: s.unsigned },
  });

  // 6. Every review records an onTrack forecast.
  const f = await reviewForecasts(db);
  out.push({
    n: 6, name: 'every review records an onTrack forecast',
    pass: f.reviews === 0 ? null : f.without === 0,
    detail: `${plural(f.reviews, 'review')}; ${f.without} without its goal’s forecast in the ledger`,
    values: { reviews: f.reviews, withoutForecast: f.without },
  });

  // 7. Nothing is suggested from chat without Will's own quoted words: the cards part 5 files (goals and
  //    commitments), what he did with them, and what a signed rule added with no card. A card's quote is read from
  //    the card; what was added alone left no card to read, so it is counted, and the criterion rests on the cards.
  const q = await chatSuggestions(db);
  const alone = await addedAlone(db);
  out.push({
    n: 7, name: 'nothing is suggested from chat without your own quoted words',
    pass: q.filed === 0 ? null : q.withoutQuote === 0,
    detail: q.filed === 0 && alone === 0
      ? 'no suggestion from chat yet (the server files them once it is told to; the database refuses one without a quote)'
      : `${plural(q.filed, 'suggestion')} from chat; ${q.withoutQuote} without your own quoted words; ${q.cleared} too old to read; `
        + `you approved ${q.executed}, made ${q.made} into goals yourself and rejected ${q.rejected}, and ${q.expired} expired${alone ? `; ${alone} more added under a rule you signed` : ''}`,
    values: { suggestions: q.filed, withoutQuote: q.withoutQuote, cleared: q.cleared, approved: q.executed, madeGoals: q.made, rejected: q.rejected, expired: q.expired, addedAlone: alone },
  });

  // 8. The goals block in chat stays within 300 tokens, and its size is measured turn by turn.
  const b = await goalsBlockSize(db, config.tz, now);
  out.push({
    n: 8, name: `the goals block in chat stays within ${GOALS_BLOCK_MAX_TOKENS} tokens`,
    pass: b.max === null ? null : b.max <= GOALS_BLOCK_MAX_TOKENS,
    detail: b.max === null
      ? 'no chat turn has carried the goals block yet (FLINT_GOALS_NOW on the server; only turns a local model answers carry it)'
      : `${plural(b.days, 'day')} measured in 30; ${Math.round(b.mean ?? 0)} tokens on average, ${Math.round(b.max)} at most (the limit is ${GOALS_BLOCK_MAX_TOKENS})`,
    values: { days: b.days, meanTokens: b.mean === null ? null : Math.round(b.mean), maxTokens: b.max === null ? null : Math.round(b.max), limit: GOALS_BLOCK_MAX_TOKENS },
  });

  return { at: now.toISOString(), criteria: out };
}
