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

// ---- The Predictions panel's wire (P4 part 4) ---------------------------------------------------------
// The console reaches the runtime's prediction routes through the server, which
// checks every request and every answer against these. A forecast's numbers
// (spend and calendar hours among them) travel only between the runtime and
// Will's console, behind the runtime's `proposals` scope: never to a model, a
// note, a log or an audit entry.
//
// The runtime writes every sentence the panel shows (apps/runtime/src/predict/
// phrasing.ts, the one source of these words), from the row's own numbers: a
// number the runtime does not have is never on the wire, so the panel cannot
// say one. The console holds only its own fixed words.

const Ref = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/);
const Count = z.number().int().min(0).max(100_000);
/** A sentence, shown as it is: it ends as one, and carries no JSON, no backtick and no aside in parentheses. */
export const PanelSentence = z.string().min(2).max(400).regex(/^[^{}[\]`()]+[.!?]$/);
/** A label or a value: a few words. */
export const PanelWords = z.string().min(1).max(80).regex(/^[^{}[\]`()]+$/);

/**
 * Where one number stands today (or this week):
 *  - `range`: a forecast that beat a plain guess, with its range;
 *  - `no_trend`: no reliable trend, so only a plain guess's range;
 *  - `early`: too early to tell a trend (not enough history to believe a forecast over a plain guess), so only a plain guess's range;
 *  - `steady`: the number has not changed, so there is nothing to forecast;
 *  - `waiting`: the number for the step just ended is not in, and Flint never forecasts from a made-up one;
 *  - `short`: not enough history yet;
 *  - `no_data`: nothing kept for it yet;
 *  - `tonight`: ready, and forecast on the next nightly run;
 *  - `failed`: last night's forecast failed;
 *  - `off`: its forecasts are off.
 */
export const FORECAST_STATES = ['range', 'no_trend', 'early', 'steady', 'waiting', 'short', 'no_data', 'tonight', 'failed', 'off'] as const;
export type ForecastState = (typeof FORECAST_STATES)[number];

/** One number in the list. `about`: what it is, for the Turn On sheet. */
export const ForecastRow = z
  .object({
    key: SeriesKey,
    name: PanelWords,
    about: PanelSentence,
    step: z.enum(['day', 'week']),
    on: z.boolean(),
    state: z.enum(FORECAST_STATES),
    value: PanelWords,
    says: PanelSentence,
  })
  .strict();
export type ForecastRow = z.infer<typeof ForecastRow>;

/**
 * The Forecasts tab. `state`: `off_here` when predictions are switched off on
 * this Mac (nothing can be turned on from the console), `off` when no number
 * is on, `on` otherwise. `waiting`: Turn On Predictions cards that wait for
 * Will's signature, each with how many numbers it names. `questions`: how many
 * wait for him; `announce`: whether the header may show a dot for them (only
 * once he has let Flint ask on its own). `secondOpinion`: the Turn On sheet
 * may offer the local model's own estimate (predictions run on this Mac and a
 * local model is set). A runtime from before the second opinion does not say:
 * absent is no, so the server reads an older runtime's page during a deploy.
 */
export const PredictionsPage = z
  .object({
    state: z.enum(['off_here', 'off', 'on']),
    numbers: z.array(ForecastRow).max(60),
    waiting: z.array(z.object({ id: Ref, numbers: Count }).strict()).max(20),
    questions: Count,
    announce: z.boolean(),
    secondOpinion: z.boolean().optional(),
  })
  .strict();
export type PredictionsPage = z.infer<typeof PredictionsPage>;

/**
 * What the console asks when it loads, and now and then after: is the panel there, and should its button show a
 * dot. Two facts and no number of any series, so that a forecast's numbers are read only when Will opens the panel.
 */
export const PredictionsWaiting = z.object({ questions: Count, announce: z.boolean() }).strict();
export type PredictionsWaiting = z.infer<typeof PredictionsWaiting>;

/** A labelled row with its sentence. */
export const PanelFact = z.object({ label: PanelWords, value: PanelWords, says: PanelSentence }).strict();
export type PanelFact = z.infer<typeof PanelFact>;

/**
 * The local model's second opinion on one number that is on. `on`: its switch.
 * `says`: the one sentence there is to say (what the model said of today's
 * question, that it has said nothing, that it is off, or why it cannot be
 * turned on). `offer`: it is off and can be turned on from here now. The
 * model's estimate is shown as this sentence and nowhere else.
 */
export const SecondOpinion = z.object({ on: z.boolean(), says: PanelSentence, offer: z.boolean() }).strict();
export type SecondOpinion = z.infer<typeof SecondOpinion>;

/** One number, open: where it stands, each step of its forecast, its yes/no chance, the local model's second opinion, and how its ranges have held. */
export const SeriesView = z
  .object({
    number: ForecastRow,
    forecast: z.array(PanelFact).max(8),
    chance: PanelFact.nullable(),
    /**
     * Null while the number is off: there is nothing to give a second opinion on. Absent from a runtime that is
     * older than the second opinion (read as null, so the server takes its answer during a deploy).
     */
    opinion: SecondOpinion.nullable().optional(),
    record: PanelSentence,
    /** A Turn On card that names it waits for Will. */
    waiting: z.boolean(),
    /** Predictions are switched off on this Mac: nothing here can be turned on. */
    offHere: z.boolean(),
  })
  .strict();
export type SeriesView = z.infer<typeof SeriesView>;
export const SeriesAnswer = z.object({ series: SeriesView }).strict();

export const QUESTION_ANSWERS = ['yes', 'no', 'skip'] as const;
export type QuestionAnswer = (typeof QUESTION_ANSWERS)[number];
/** A prediction's id, as the ledger makes them. */
export const PredictionRef = Ref;
/**
 * One question for Will. `title` is the prediction, as Flint made it in a chat:
 * its own words, or (for a templated one) fixed words around the item's own
 * label. Shown as text only. `says`: what Flint said, when, and when it was
 * due (his answer is recorded as of that moment).
 *
 * `answerable`: Flint can say plainly what the prediction was about. One it
 * cannot (its item is gone or is a person, its number is not one of Flint's,
 * or its words are from outside text) is never answered Yes or No, by anyone:
 * the console offers only Skip for it, and the runtime refuses the rest.
 */
export const QuestionView = z
  .object({
    id: PredictionRef,
    title: z.string().min(1).max(300),
    says: PanelSentence,
    answer: z.enum(QUESTION_ANSWERS).nullable(),
    answerable: z.boolean(),
  })
  .strict();
export type QuestionView = z.infer<typeof QuestionView>;
/** The Questions tab. `offHere`: predictions are switched off on this Mac, so nothing here can be answered. */
export const QuestionsPage = z.object({ waiting: z.array(QuestionView).max(50), answered: z.array(QuestionView).max(20), offHere: z.boolean() }).strict();
export type QuestionsPage = z.infer<typeof QuestionsPage>;
export const AnswerBody = z.object({ answer: z.enum(QUESTION_ANSWERS) }).strict();

/** One area's record: how many results it has, and what they say, a sentence each. */
export const AccuracyArea = z.object({ name: PanelWords, value: PanelWords, lines: z.array(PanelSentence).min(1).max(8) }).strict();
export type AccuracyArea = z.infer<typeof AccuracyArea>;
/**
 * The Accuracy tab: each area Flint has predicted in, and what was left
 * unsettled. `scored`: false until a night's scores exist. `scoring`: whether
 * anything scores them now: `off_here` (predictions are switched off on this
 * Mac), `not_started` (Will has never turned them on) or `on`.
 */
export const AccuracyView = z
  .object({ scored: z.boolean(), scoring: z.enum(['off_here', 'not_started', 'on']), areas: z.array(AccuracyArea).max(20), unsettled: z.array(PanelSentence).max(8) })
  .strict();
export type AccuracyView = z.infer<typeof AccuracyView>;

/**
 * Turn On Predictions from the console: the numbers Will ticked, and whether the local model gives its second
 * opinion on them (all of them, or none). The card is `{series, reason}`, sorted, as he signs it: `reason` is the
 * same list when `opinion` is on, and empty otherwise.
 */
export const TurnOnBody = z.object({ series: z.array(SeriesKey).min(1).max(40), opinion: z.boolean().optional() }).strict();
/** A card filed: its id, and whether it was one already waiting. */
export const PredictFiled = z.object({ id: Ref, deduped: z.boolean() }).strict();
export const PredictDone = z.object({ ok: z.literal(true) }).strict();
/** A body with nothing in it (Turn Off). */
export const PredictEmptyBody = z.object({}).strict();

/** How many scored results of one kind an area needs before Flint says how it did. */
export const ACCURACY_MIN = 30;
/** Questions asked of Will in a day, at most (the action's cap in the code table). */
export const QUESTIONS_PER_DAY = 5;

/**
 * What Will reads when a predictions route is refused: fixed sentences, never a
 * number's value, a prediction's words or a database's. The runtime refuses
 * with one of these and names it by its key (`code`); the server passes a
 * refusal through to the console only as one of these codes.
 */
export const PREDICT_SAYS = {
  invalid: 'This card isn’t valid.',
  request: 'That request isn’t valid.',
  unknown: 'That number can’t be forecast.',
  forgotten: 'One of these numbers was forgotten, so it can’t be forecast.',
  mislabeled: 'One of these numbers isn’t stored the way Flint expects, so nothing was turned on.',
  nothing: 'It changes nothing.',
  offHere: 'Predictions are switched off on this Mac.',
  alreadyOff: 'Forecasts for this number are already off.',
  noModel: 'No local model is set on this Mac, so there is no second opinion to turn on.',
  opinionOff: 'The second opinion for this number is already off.',
  answered: 'That question was already answered.',
  noQuestion: 'That question no longer exists.',
  unanswerable: 'Flint can’t show what this one was about, so it can only be skipped.',
  busy: 'Flint is busy with this. Try again shortly.',
} as const;
export type PredictSay = keyof typeof PREDICT_SAYS;

/** The sentence a code stands for, or undefined for a code outside the closed set. */
export function predictSayOf(code: unknown): string | undefined {
  return typeof code === 'string' && Object.prototype.hasOwnProperty.call(PREDICT_SAYS, code) ? PREDICT_SAYS[code as PredictSay] : undefined;
}

/** The code of one of these sentences, or undefined. */
export function predictCodeOf(sentence: string): string | undefined {
  for (const [k, v] of Object.entries(PREDICT_SAYS)) if (v === sentence) return k;
  return undefined;
}
