/**
 * Predictions (P4): the shapes the forecast cards carry, shared by the runtime,
 * which checks a card when it is filed and again when it runs, and later by the
 * server and the console. Strict throughout: a field not named here is refused,
 * not ignored.
 *
 * The database proves the same things (migration p4_forecasts): a number is
 * forecast only once Will signs the card that turns it on, in that approval's
 * one transaction, and no series is ever marked as allowed to leave this Mac.
 * These contracts keep a card that could not apply from being filed, and
 * normalize what is signed (lists sorted, no repeats) so the same request is
 * the same card.
 *
 * A card carries series keys, never a series' values.
 */
import { z } from 'zod';

/** A metric series key, as the database's own rule has it (MetricSeries_key_check), at most 80 characters. */
export const SeriesKey = z.string().max(80).regex(/^[a-z0-9_]+(\.[a-z0-9_-]+)+$/);

/**
 * The forecast action only Will's passkey takes: forecast.series.enable turns
 * Flint's forecasts of some numbers on. Never promoted (fixed in the code table,
 * and in the runtime's NEVER_PROMOTED). There is no action that lets a series
 * leave this Mac: Flint forecasts here and sends no series anywhere.
 */
export const FORECAST_SIGNED_ACTIONS = ['forecast.series.enable'] as const;
export type ForecastSignedAction = (typeof FORECAST_SIGNED_ACTIONS)[number];
export function isForecastSignedAction(action: string): action is ForecastSignedAction {
  return (FORECAST_SIGNED_ACTIONS as readonly string[]).includes(action);
}

/**
 * Names for an outside forecasting service, kept so that they are FORBIDDEN by
 * name: Flint runs on its own, and no action of its own under `prophet.` is
 * ever run, whatever a policy row says (step 1 of the tier engine). Nothing
 * calls them.
 */
export const PROPHET_ACTIONS = ['prophet.forecast_adhoc', 'prophet.calibration', 'prophet.models'] as const;

/** What Flint's own prediction jobs will do (they run in shadow at APPROVAL until Will promotes them). */
export const PREDICT_JOB_ACTIONS = ['forecast.series.build', 'forecast.local', 'ledger.reason.local', 'ledger.resolve.ask_will', 'calibration.note'] as const;

/** Every action P4 adds to the code table. */
export const P4_ACTIONS = [...PREDICT_JOB_ACTIONS, ...FORECAST_SIGNED_ACTIONS, ...PROPHET_ACTIONS] as const;

/** Sorted and without repeats: a list's order means nothing here, and its digest must not depend on it. */
const sorted = (xs: readonly string[]): string[] => [...new Set(xs)].sort();

/**
 * forecast.series.enable: the numbers to forecast, and those among them the
 * local model also estimates. `reason` is within `series`.
 */
export const ForecastEnableArgs = z
  .object({
    series: z.array(SeriesKey).min(1).max(40).transform(sorted),
    reason: z.array(SeriesKey).max(40).transform(sorted),
  })
  .strict()
  .superRefine((a, ctx) => {
    const on = new Set(a.series);
    a.reason.forEach((k, i) => {
      if (!on.has(k)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['reason', i], message: 'the local model estimates only a number that is forecast' });
    });
  });
export type ForecastEnableArgs = z.infer<typeof ForecastEnableArgs>;

/** What a forecast card's reason says, for good: fixed sentences, never a number. */
export const FORECAST_REASONS = {
  enable: 'Approving turns on Flint’s forecasts of these numbers, on this Mac.',
} as const;

/** How sensitive a set of series is, taken together: the most sensitive of them. */
export function mostSensitive(levels: ReadonlyArray<'ops' | 'personal' | 'financial'>): 'ops' | 'personal' | 'financial' {
  return levels.includes('financial') ? 'financial' : levels.includes('personal') ? 'personal' : 'ops';
}
