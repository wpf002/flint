/**
 * The numbers Flint forecasts (Machine plan P4): a closed list in code, like
 * SOURCES. A card may turn on only a key listed here, and what a series is (its
 * step, unit and sensitivity) is said once, here; the database then never lets
 * a series' sensitivity change (metric_series_guard).
 *
 * This part holds what each number is. The functions that build its daily value
 * from the world model arrive with the forecaster. Nothing here is forecast
 * until Will signs the card that turns it on, and every forecast is computed
 * on this Mac: no series is sent anywhere.
 *
 * Spend is FINANCIAL and calendar hours are PERSONAL. A card, a log line and an
 * audit entry carry a series' key, never its values.
 */
import type { Sensitivity } from '@flint/policy';
import type { DOMAINS } from '../ledger/emit.js';

export type SeriesStep = 'day' | 'week';
export type SeriesUnit = 'usd' | 'count' | 'minutes' | 'hours';

export interface ForecastSeriesDef {
  /** The MetricSeries key (lowercase segments). */
  key: string;
  step: SeriesStep;
  unit: SeriesUnit;
  sensitivity: Sensitivity;
  /** The ledger domain its predictions are scored under. */
  domain: (typeof DOMAINS)[number];
  /** As the console names it: Title Case. */
  name: string;
  /** The MetricSeries row's description: a fixed sentence. */
  description: string;
}

const VENDORS = [
  ['anthropic', 'Anthropic'],
  ['openai', 'OpenAI'],
  ['perplexity', 'Perplexity'],
  ['tavily', 'Tavily'],
] as const;
const REPOS = [
  ['flint', 'Flint'],
  ['nexus', 'Nexus'],
  ['trident', 'Trident'],
  ['helm', 'Helm'],
] as const;

export const FORECAST_SERIES: readonly ForecastSeriesDef[] = [
  ...VENDORS.map(([v, name]): ForecastSeriesDef => ({
    key: `daily.spend.${v}.usd`, step: 'day', unit: 'usd', sensitivity: 'financial', domain: 'spend',
    name: `${name} Spend`, description: `What Flint spends with ${name} each day.`,
  })),
  { key: 'daily.deploys.count', step: 'day', unit: 'count', sensitivity: 'ops', domain: 'deploys', name: 'Deploys', description: 'How many times Flint is deployed each day.' },
  ...REPOS.map(([r, name]): ForecastSeriesDef => ({
    key: `weekly.commits.${r}.count`, step: 'week', unit: 'count', sensitivity: 'ops', domain: 'repos',
    name: `${name} Commits`, description: `How many commits land in ${name} each week.`,
  })),
  { key: 'daily.services.incident_minutes', step: 'day', unit: 'minutes', sensitivity: 'ops', domain: 'services', name: 'Service Downtime', description: 'How many minutes a service was down each day.' },
  { key: 'daily.threads.open', step: 'day', unit: 'count', sensitivity: 'ops', domain: 'projects', name: 'Open Threads', description: 'How many threads are open at the end of each day.' },
  { key: 'daily.calendar.hours', step: 'day', unit: 'hours', sensitivity: 'personal', domain: 'calendar', name: 'Calendar Hours', description: 'How many hours of events are on the calendar each day.' },
];

const BY_KEY: ReadonlyMap<string, ForecastSeriesDef> = new Map(FORECAST_SERIES.map((s) => [s.key, s]));

/** The closed set of keys a card may name. */
export const FORECAST_SERIES_KEYS: readonly string[] = FORECAST_SERIES.map((s) => s.key);

/** A registered series, or undefined: a key outside the list is never forecast. */
export function forecastSeries(key: string): ForecastSeriesDef | undefined {
  return BY_KEY.get(key);
}

/** The MetricSeries step for a series: `D` or `W`. */
export function freqOf(s: Pick<ForecastSeriesDef, 'step'>): 'D' | 'W' {
  return s.step === 'day' ? 'D' : 'W';
}
