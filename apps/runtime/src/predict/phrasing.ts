/**
 * The phrase table (P4 part 3; plan 3.0.9): the only way a probability or a
 * range reaches any text Flint writes. Every phrase carries its number, so a
 * note can never sound surer (or less sure) than the ledger's row says, and
 * every phrase is one the lint in templates/escalations.ts knows: words like
 * "likely" or a percentage anywhere else in a note make it fall back to its
 * field-free wording.
 *
 *  - A chance: "likely, around 70% by Oct 12, 5:30 PM".
 *  - A range from a forecast that beat a plain guess: "about 4, with an 80%
 *    range of 2 to 6".
 *  - A range from one that did not: "no reliable trend, and a plain guess
 *    gives an 80% range of 0 to 3". It never gives a middle, and it says what
 *    the range is: a plain guess (the last value, the same day last week, or
 *    the recent average) moved by how far such guesses have been off. It is
 *    not where recent days ran.
 *
 * Values are said in their unit's words ("$1.20", "12 minutes", "3.5 hours"),
 * never as a key or a raw float. No parentheses: a note has none.
 *
 * Pure. This file holds words and arithmetic only.
 */
import type { ForecastUnit } from './forecast.js';

/** The word for a chance, the percentage, and (when there is one) by when. */
export function chanceParts(p: number, by: Date | undefined, tz: string): { word: string; pct: number; when: string } {
  const word = p < 0.1 ? 'very unlikely' : p < 0.35 ? 'unlikely' : p < 0.45 ? 'somewhat unlikely' : p <= 0.55 ? 'about even' : p < 0.65 ? 'somewhat likely' : p < 0.9 ? 'likely' : 'very likely';
  const when = by ? ` by ${new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(by)}` : '';
  return { word, pct: Math.round(p * 100), when };
}

/** "somewhat unlikely, around 40% by Oct 2, 5:30 PM". */
export function chancePhrase(p: number, by: Date | undefined, tz: string): string {
  const x = chanceParts(p, by, tz);
  return `${x.word}, around ${x.pct}%${x.when}`;
}

/** A plain number: thousands separated, at most two decimals, no trailing zeros. */
const plain = (n: number): string => n.toLocaleString('en-US', { maximumFractionDigits: 2 });
/** Dollars: always to the cent. A negative amount carries its sign before the dollar sign: "-$5.00", never "$-5.00" (and never "-$0.00"). */
const dollars = (n: number): string => {
  const cents = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${n < 0 && cents !== '0.00' ? '-' : ''}$${cents}`;
};

/** One value in its unit's words: "$1.20", "4", "12 minutes", "1 minute", "3.5 hours". */
export function unitValue(value: number, unit: ForecastUnit): string {
  if (unit === 'usd') return dollars(value);
  if (unit === 'count') return plain(value);
  const word = unit === 'minutes' ? 'minute' : 'hour';
  return `${plain(value)} ${value === 1 ? word : `${word}s`}`;
}

/** Two values as a span: "2 to 6", "$0.80 to $1.75", "5 to 40 minutes". */
export function unitSpan(lower: number, upper: number, unit: ForecastUnit): string {
  if (unit === 'usd') return `${dollars(lower)} to ${dollars(upper)}`;
  if (unit === 'count') return `${plain(lower)} to ${plain(upper)}`;
  return `${plain(lower)} to ${plain(upper)} ${unit === 'minutes' ? 'minutes' : 'hours'}`;
}

const pct = (level: number): string => `${Math.round(level * 100)}%`;
/** "an 80% range", "an 85% range", "a 50% range". */
const leveled = (level: number): string => `${/^8|^11|^18/.test(String(Math.round(level * 100))) ? 'an' : 'a'} ${pct(level)} range`;

export interface RangeWords {
  point: number;
  lower: number;
  upper: number;
  level: number;
  unit: ForecastUnit;
}

/** A forecast that beat a plain guess: "about 4, with an 80% range of 2 to 6". */
export function rangePhrase(r: RangeWords): string {
  return `about ${unitValue(r.point, r.unit)}, with ${leveled(r.level)} of ${unitSpan(r.lower, r.upper, r.unit)}`;
}

/** One that did not: "no reliable trend, and a plain guess gives an 80% range of 0 to 3". The range is the plain guess's, from its own past errors. */
export function noTrendPhrase(r: Omit<RangeWords, 'point'>): string {
  return `no reliable trend, and a plain guess gives ${leveled(r.level)} of ${unitSpan(r.lower, r.upper, r.unit)}`;
}

/** A forecast's range in words, by what its run earned: a forecast only when it beat naive. */
export function forecastPhrase(r: RangeWords & { beatsNaive: boolean | null }): string {
  return r.beatsNaive === true ? rangePhrase(r) : noTrendPhrase(r);
}

// ---- The Predictions panel's words (P4 part 4) -------------------------------------------------------
// Every sentence and value the console's Predictions panel shows about a number,
// a question or Flint's record is made here, from the row's own numbers, and
// sent as words: the console writes none of them. A state that has no number
// (waiting, not enough history, no data) says so in a sentence, never with a
// number Flint does not have. No parentheses, no key, no id.

export type StepName = 'day' | 'week';

const title = (s: string): string => s.replace(/\b[a-z]/g, (c) => c.toUpperCase());
const steps = (n: number, step: StepName): string => `${n} ${step === 'day' ? 'day' : 'week'}${n === 1 ? '' : 's'}`;

/** A day in words: "Oct 3", with the year when it is not `now`'s. */
export function dayWords(at: Date, tz: string, now: Date): string {
  const year = (d: Date) => new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric' }).format(d);
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short', day: 'numeric', ...(year(at) === year(now) ? {} : { year: 'numeric' }) }).format(at);
}

/** A later step of a forecast, by when it starts: "Tue, Oct 13" for a day, "Week of Oct 19" for a week. */
export function stepLabel(at: Date, tz: string, step: StepName): string {
  if (step === 'week') return `Week of ${new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short', day: 'numeric' }).format(at)}`;
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' }).format(at);
}

/** The fixed sentences and values: a state with no number says so. */
export const PANEL = {
  noData: 'This number has no data yet.',
  off: 'Forecasts for this number are off.',
  failed: 'Flint couldn’t forecast this number last night.',
  tonight: 'Flint makes its next forecast tonight.',
  noRecord: 'Flint has no results for this number yet.',
  noResults: 'There are no results yet.',
  better: 'Flint did better than always guessing the usual rate.',
  noBetter: 'Flint did no better than guessing the usual rate.',
  outsideClaim: 'Flint made this prediction in a chat.',
  steady: 'This number hasn’t changed lately.',
  /** The local model's second opinion, when there is no estimate to say. */
  noOpinion: 'The local model has no estimate for this forecast.',
  opinionOff: 'The local model doesn’t estimate this number.',
  noLocalModel: 'No local model is set on this Mac.',
  values: { noTrend: 'No Trend', early: 'Too Early', steady: 'Steady', waiting: 'Waiting', short: 'Not Enough History', noData: 'No Data', tonight: 'Tonight', failed: 'Failed', off: 'Off' },
} as const;

/** "About 4", "About $1.20", "About 12 Minutes". */
export function aboutValue(point: number, unit: ForecastUnit): string {
  return `About ${title(unitValue(point, unit))}`;
}

/** A forecast that beat a plain guess: "Flint expects about 4, with an 80% range of 2 to 6." */
export function expectSays(r: RangeWords): string {
  return `Flint expects ${rangePhrase(r)}.`;
}

/** One that did not: "There’s no reliable trend, and a plain guess gives an 80% range of 0 to 3." It names no middle. */
export function noTrendSays(r: Omit<RangeWords, 'point'>): string {
  return `There’s ${noTrendPhrase(r)}.`;
}

/**
 * Too early to tell: the history is too short to believe any forecast over a plain guess (under 56 days, or 26
 * weeks). Said as that, never as "no reliable trend": nothing has been found wanting yet. Only the plain guess's range.
 */
export function earlySays(r: Omit<RangeWords, 'point'>): string {
  return `It’s too early to tell a trend, and a plain guess gives ${leveled(r.level)} of ${unitSpan(r.lower, r.upper, r.unit)}.`;
}

/**
 * The number has not changed. `unchanged`: how many of its latest steps are the same, as counted (at most the 28 a
 * steady number is judged over). It never claims more history than there is: 24 equal days are "24 days". Not
 * counted, it says so without a number.
 */
export function steadySays(step: StepName, unchanged?: number): string {
  if (unchanged === undefined || !Number.isInteger(unchanged) || unchanged < 2) return PANEL.steady;
  return `This number hasn’t changed in ${steps(Math.min(28, unchanged), step)}.`;
}

/** The number for the step just ended is not in: Flint never forecasts from a made-up one. */
export function waitingSays(step: StepName): string {
  return step === 'day' ? 'Yesterday’s number isn’t in yet, so there’s no forecast for today.' : 'Last week’s number isn’t in yet, so there’s no forecast for this week.';
}

/** Not enough history yet: how much a forecast needs, and how much there is. */
export function shortSays(step: StepName, need: number, have: number): string {
  return `Flint needs ${steps(need, step)} of history. It has ${have}.`;
}

/** One step's range under its value: the forecast's own, or (no reliable trend) a plain guess's. */
export function stepRangeSays(r: Omit<RangeWords, 'point'>, beatsNaive: boolean): string {
  const span = unitSpan(r.lower, r.upper, r.unit);
  return beatsNaive ? `The ${pct(r.level)} range is ${span}.` : `A plain guess gives ${leveled(r.level)} of ${span}.`;
}

/** The forecast's yes/no question as a label: "Above 3", "Above $1.20". */
export function aboveLabel(threshold: number, unit: ForecastUnit): string {
  return `Above ${title(unitValue(threshold, unit))}`;
}

/** Its chance as a value: "Likely · 70%". */
export function chanceValue(p: number): string {
  const x = chanceParts(p, undefined, 'UTC');
  return `${title(x.word)} · ${x.pct}%`;
}

/** And as a sentence: "It’s likely, around 70%, that today runs above 3." */
export function chanceSays(p: number, step: StepName, threshold: number, unit: ForecastUnit): string {
  const x = chanceParts(p, undefined, 'UTC');
  return `It’s ${x.word}, around ${x.pct}%, that ${step === 'day' ? 'today' : 'this week'} runs above ${unitValue(threshold, unit)}.`;
}

/**
 * The local model's second opinion on the same question, as one plain sentence: "The local model said about 60%."
 * The percentage and nothing else of its reply: no reason, no word of its own.
 */
export function opinionSays(p: number): string {
  return `The local model said about ${Math.round(p * 100)}%.`;
}

/** How a number's last ranges held: "22 of its last 27 ranges held." */
export function recordSays(held: number, of: number): string {
  if (of <= 0) return PANEL.noRecord;
  if (of === 1) return held ? 'Its last range held.' : 'Its last range didn’t hold.';
  return `${held} of its last ${of} ranges held.`;
}

/**
 * When a question's prediction was due: "It was due Oct 5 at 3:00 PM." His answer is recorded as of that moment, so
 * the question says it.
 */
export function dueSays(at: Date, tz: string, now: Date): string {
  // The time and its AM or PM are held together (a no-break space, whichever space this system's formatter writes), so a
  // narrow row never leaves "PM." on a line of its own.
  const clock = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(at).replace(/\s+(AM|PM)$/, '\u00a0$1');
  return `It was due ${dayWords(at, tz, now)} at ${clock}.`;
}

/** Under a question for Will: what Flint said, and when. "Flint said likely, around 70%, on Oct 3." */
export function saidSays(p: number, on: string): string {
  const x = chanceParts(p, undefined, 'UTC');
  return `Flint said ${x.word}, around ${x.pct}%, on ${on}.`;
}

/** Under one he answered. */
export function answeredSays(answer: 'yes' | 'no' | 'skip', on: string): string {
  return answer === 'skip' ? `You skipped it on ${on}.` : `You said ${answer} on ${on}.`;
}

/** A templated claim (one made from outside text) in plain words around an item's own label. */
export function templatedClaim(kind: 'healthy' | 'deploy' | 'closed', label: string): string {
  return kind === 'healthy' ? `${label} reports healthy.` : kind === 'deploy' ? `The next deploy of ${label} succeeds.` : `${label} is closed.`;
}

/**
 * A templated claim about one of Flint's own numbers: "Deploys ran above 4." "Ran" needs no agreement with the
 * name (Deploys, Flint Commits, Service Downtime all read right), and is the word the forecast's own chance uses.
 */
export function thresholdClaim(name: string, op: 'above' | 'below', value: number, unit: ForecastUnit): string {
  return `${name} ran ${op} ${unitValue(value, unit)}.`;
}

/** "41 Scored". */
export function scoredValue(n: number): string {
  return `${n} Scored`;
}

/** "When Flint said about 70%, it happened 64% of the time, over 41 predictions." */
export function calledSays(statedPct: number, happenedPct: number, n: number): string {
  return `When Flint said about ${statedPct}%, it happened ${happenedPct}% of the time, over ${n} ${n === 1 ? 'prediction' : 'predictions'}.`;
}

/** "Its 80% ranges held 79% of the time, over 120 forecasts." */
export function rangesHeldSays(level: number, heldPct: number, n: number): string {
  return `Its ${pct(level)} ranges held ${heldPct}% of the time, over ${n} ${n === 1 ? 'forecast' : 'forecasts'}.`;
}

/** Too few results of one kind to say how Flint did. */
export function tooFewSays(kind: 'binary' | 'range', have: number, need: number): string {
  return `Flint has ${have} of the ${need} results it needs for its ${kind === 'binary' ? 'yes or no predictions' : 'ranges'}.`;
}

/** The error score, from 100 scored on; its likely range when one was measured. */
export function errorScoreSays(score: number, low?: number, high?: number): string {
  const range = low !== undefined && high !== undefined ? ` The likely range is ${low.toFixed(2)} to ${high.toFixed(2)}.` : '';
  return `Its error score is ${score.toFixed(2)}, and lower is better.${range}`;
}

/** How far its stated chances sat from what happened, in points. */
export function gapSays(points: number): string {
  return `Its stated chances sat ${points} ${points === 1 ? 'point' : 'points'} from what happened, on average.`;
}

/**
 * How the local model's second opinions did against the other answer to the very same questions: the forecast's
 * (one that beat a plain guess), or the usual rate's (where none did). "Closer": its stated chances sat nearer to
 * what happened.
 */
export function opinionVersusSays(other: 'forecast' | 'usual', n: number, verdict: 'closer' | 'further' | 'same'): string {
  const them = other === 'forecast' ? 'the forecast' : 'the usual rate';
  const over = `Over ${n} ${n === 1 ? 'question' : 'questions'}, `;
  if (verdict === 'same') return `${over}the local model and ${them} did about as well.`;
  return verdict === 'closer' ? `${over}the local model was closer than ${them}.` : `${over}${them} was closer than the local model.`;
}

/** Too few questions both answered to compare them. */
export function opinionTooFewSays(have: number, need: number): string {
  return `The local model has ${have} of the ${need} results it needs to be compared.`;
}

/** What was left unsettled, a sentence a kind. */
export function unsettledSays(kind: 'expired' | 'late' | 'declined' | 'void', n: number): string {
  const one = n === 1;
  if (kind === 'expired') return one ? '1 prediction ran out before it could be checked.' : `${n} predictions ran out before they could be checked.`;
  if (kind === 'late') return one ? '1 was revised close to its date.' : `${n} were revised close to their date.`;
  if (kind === 'declined') return `${n} depended on advice you declined.`;
  return one ? '1 was set aside with your approval.' : `${n} were set aside with your approval.`;
}
