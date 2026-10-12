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
/** Dollars: always to the cent. */
const dollars = (n: number): string => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

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
