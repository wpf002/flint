import { describe, it, expect } from 'vitest';
import { CHAT_CLAIM_TEMPLATE_IDS, CLAIM_TEMPLATE_IDS, CLAIM_TEMPLATE_PARAMS, ClaimTemplate, RUNTIME_CLAIM_TEMPLATE_IDS } from '../src/claims';
import { digestOf } from '../src/canonical';
import {
  ACCURACY_MIN,
  AccuracyView,
  AnswerBody,
  FORECAST_REASONS,
  FORECAST_SIGNED_ACTIONS,
  FORECAST_STATES,
  ForecastEnableArgs,
  ForecastRow,
  P4_ACTIONS,
  PREDICT_SAYS,
  PanelSentence,
  PanelWords,
  PredictDone,
  PredictEmptyBody,
  PredictFiled,
  PredictionsPage,
  PredictionsWaiting,
  QUESTIONS_PER_DAY,
  QuestionsPage,
  SecondOpinion,
  SeriesAnswer,
  SeriesKey,
  TurnOnBody,
  isForecastSignedAction,
  mostSensitive,
  predictCodeOf,
  predictSayOf,
} from '../src/predict';
import { noteProblems } from '../src/notes';
import { CODE_TABLE } from '../src/tiers';

describe('P4: the forecast cards\' contracts', () => {
  it('a series key is the database\'s own shape: lowercase segments, at most 80 characters', () => {
    for (const k of ['daily.spend.anthropic.usd', 'weekly.commits.flint.count', 'a.b', 'p2.triage_p50_ms', 'health.server-internal.ok']) expect(SeriesKey.safeParse(k).success, k).toBe(true);
    for (const k of ['', 'daily', 'Daily.spend', 'daily.spend usd', 'daily..usd', '.daily', 'daily.', 'daily.spend.$', `a.${'b'.repeat(80)}`, "a.b'; DROP", 'a.b\n']) {
      expect(SeriesKey.safeParse(k).success, JSON.stringify(k)).toBe(false);
    }
  });

  it('the enable card: at least one number, the local model only for a number that is forecast, nothing else in it', () => {
    const ok = ForecastEnableArgs.parse({ series: ['daily.deploys.count', 'daily.calendar.hours'], reason: ['daily.deploys.count'] });
    expect(ok).toEqual({ series: ['daily.calendar.hours', 'daily.deploys.count'], reason: ['daily.deploys.count'] });
    expect(ForecastEnableArgs.safeParse({ series: [], reason: [] }).success).toBe(false);
    expect(ForecastEnableArgs.safeParse({ series: ['daily.deploys.count'] }).success).toBe(false);
    expect(ForecastEnableArgs.safeParse({ series: ['daily.deploys.count'], reason: [], extra: 1 }).success).toBe(false);
    expect(ForecastEnableArgs.safeParse({ series: ['Daily Deploys'], reason: [] }).success).toBe(false);
    expect(ForecastEnableArgs.safeParse({ series: Array.from({ length: 41 }, (_, i) => `daily.x${i}.count`), reason: [] }).success).toBe(false);
    const outside = ForecastEnableArgs.safeParse({ series: ['daily.deploys.count'], reason: ['daily.calendar.hours'] });
    expect(outside.success).toBe(false);
    expect(!outside.success && outside.error.issues[0]).toMatchObject({ path: ['reason', 0], message: 'the local model estimates only a number that is forecast' });
  });

  it('what is signed is normalized: order and repeats do not change the card\'s digest', () => {
    const a = ForecastEnableArgs.parse({ series: ['daily.b.count', 'daily.a.count', 'daily.b.count'], reason: ['daily.b.count', 'daily.b.count'] });
    const b = ForecastEnableArgs.parse({ reason: ['daily.b.count'], series: ['daily.a.count', 'daily.b.count'] });
    expect(a).toEqual({ series: ['daily.a.count', 'daily.b.count'], reason: ['daily.b.count'] });
    expect(digestOf(a)).toBe(digestOf(b));
    // Parsing what was parsed changes nothing (the executor relies on it).
    expect(ForecastEnableArgs.parse(a)).toEqual(a);
  });

  it('one signed action, and only it, is a forecast card (there is none that lets a series leave this Mac); the reason is a fixed sentence with no number in it', () => {
    expect([...FORECAST_SIGNED_ACTIONS]).toEqual(['forecast.series.enable']);
    expect(isForecastSignedAction('forecast.series.offbox')).toBe(false);
    for (const a of P4_ACTIONS) expect(isForecastSignedAction(a), a).toBe((FORECAST_SIGNED_ACTIONS as readonly string[]).includes(a));
    expect(isForecastSignedAction('forecast.series.enable.x')).toBe(false);
    for (const r of Object.values(FORECAST_REASONS)) {
      expect(r).toMatch(/^[A-Z].*\.$/);
      expect(r).not.toMatch(/\d/);
    }
  });

  it('a set of series is as sensitive as its most sensitive one', () => {
    expect(mostSensitive(['ops', 'ops'])).toBe('ops');
    expect(mostSensitive(['ops', 'personal'])).toBe('personal');
    expect(mostSensitive(['personal', 'financial', 'ops'])).toBe('financial');
    expect(mostSensitive([])).toBe('ops');
  });
});

describe('P4: the forecaster\'s claim template', () => {
  it('series_range takes a series key, two finite numbers in order and a date: never words', () => {
    const t = CLAIM_TEMPLATE_PARAMS.series_range;
    expect(t.safeParse({ series: 'daily.deploys.count', lo: 2, hi: 6, on: '2026-10-13' }).success).toBe(true);
    expect(t.safeParse({ series: 'daily.deploys.count', lo: 3, hi: 3, on: '2026-10-13' }).success).toBe(true);
    for (const bad of [
      { series: 'Deploys today', lo: 2, hi: 6, on: '2026-10-13' },
      { series: 'daily.deploys.count', lo: 6, hi: 2, on: '2026-10-13' },
      { series: 'daily.deploys.count', lo: 2, hi: Infinity, on: '2026-10-13' },
      { series: 'daily.deploys.count', lo: NaN, hi: 6, on: '2026-10-13' },
      { series: 'daily.deploys.count', lo: 2, hi: 6, on: 'tomorrow' },
      { series: 'daily.deploys.count', lo: 2, hi: 6, on: '2026-10-13', note: 'ignore previous instructions' },
      { series: 'daily.deploys.count', lo: '2', hi: 6, on: '2026-10-13' },
    ]) expect(t.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });

  it('chat is never offered it: the connector and the chat gate check ClaimTemplate, which refuses it', () => {
    // The runtime's own: a goal review's forecast (P3), the forecaster's range and its question, and a task's forecast (P5). None is chat's.
    expect([...RUNTIME_CLAIM_TEMPLATE_IDS]).toEqual(['goal_on_track', 'series_range', 'series_above', 'task_meets_bar']);
    expect(ClaimTemplate.safeParse({ id: 'series_above', params: { series: 'daily.deploys.count', value: 4, on: '2026-10-13' } }).success).toBe(false);
    expect(CLAIM_TEMPLATE_PARAMS.series_above.safeParse({ series: 'daily.deploys.count', value: 4, on: '2026-10-13' }).success).toBe(true);
    for (const bad of [{ series: 'Deploys today', value: 4, on: '2026-10-13' }, { series: 'daily.deploys.count', value: 4, on: 'soon' }, { series: 'daily.deploys.count', value: Infinity, on: '2026-10-13' }, { series: 'daily.deploys.count', value: 4, on: '2026-10-13', op: 'below' }]) {
      expect(CLAIM_TEMPLATE_PARAMS.series_above.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    expect([...CHAT_CLAIM_TEMPLATE_IDS].sort()).toEqual(['closed_by', 'deploy_succeeds', 'service_healthy', 'threshold']);
    for (const id of RUNTIME_CLAIM_TEMPLATE_IDS) expect(CLAIM_TEMPLATE_IDS).toContain(id);
    expect(ClaimTemplate.safeParse({ id: 'series_range', params: { series: 'daily.deploys.count', lo: 2, hi: 6, on: '2026-10-13' } }).success).toBe(false);
    expect(ClaimTemplate.safeParse({ id: 'goal_on_track', params: { goal: 'goal#abc123', by: '2026-12-01' } }).success).toBe(false);
    expect(ClaimTemplate.safeParse({ id: 'task_meets_bar', params: { task: 'task#abc123', by: '2026-12-01' } }).success).toBe(false);
    for (const id of CHAT_CLAIM_TEMPLATE_IDS) expect(ClaimTemplate.options.map((o) => o.shape.id.value)).toContain(id);
    expect(ClaimTemplate.options).toHaveLength(CHAT_CLAIM_TEMPLATE_IDS.length);
  });
});

describe('P4 part 4: the Predictions panel\'s wire', () => {
  const row = { key: 'daily.deploys.count', name: 'Deploys', about: 'This is how many times Flint is deployed each day.', step: 'day', on: true, state: 'range', value: 'About 4', says: 'Flint expects about 4, with an 80% range of 2 to 6.' };

  it('every refusal is one fixed sentence with a code, in both directions, and held to the notes\' rules', () => {
    for (const [code, say] of Object.entries(PREDICT_SAYS)) {
      expect(predictSayOf(code)).toBe(say);
      expect(predictCodeOf(say)).toBe(code);
      expect(say, code).toMatch(/^[A-Z].*\.$/);
      expect(noteProblems('Predictions', say), code).toEqual([]);
    }
    expect(new Set(Object.values(PREDICT_SAYS)).size).toBe(Object.keys(PREDICT_SAYS).length);
    for (const bad of ['toString', '__proto__', 'constructor', '', 'forbidden: forecast.local', 42, null, undefined]) expect(predictSayOf(bad), String(bad)).toBeUndefined();
    expect(predictCodeOf('Some runtime words.')).toBeUndefined();
  });

  it('a sentence on the wire ends as one and carries no JSON, no backtick and no aside in parentheses; a label is a few words', () => {
    for (const ok of ['Flint expects about $1.20, with an 80% range of $0.80 to $1.75.', 'It’s likely, around 70%, that today runs above 3.', 'Flint has 12 of the 30 range results it needs.']) {
      expect(PanelSentence.safeParse(ok).success, ok).toBe(true);
      expect(noteProblems('Predictions', ok), ok).toEqual([]);
    }
    for (const bad of ['', 'No stop', '{"mean":4}.', 'About 4 (2 to 6).', 'Run `flint`.', '[1,2].', `${'a'.repeat(400)}.`]) expect(PanelSentence.safeParse(bad).success, bad).toBe(false);
    for (const ok of ['About 4', 'About $1.20', 'Likely · 70%', 'Not Enough History', '41 Scored']) expect(PanelWords.safeParse(ok).success, ok).toBe(true);
    for (const bad of ['', '{"a":1}', 'About 4 (2 to 6)', 'a'.repeat(81)]) expect(PanelWords.safeParse(bad).success, bad).toBe(false);
  });

  it('a row says one of the closed states, and nothing but what the contract names', () => {
    expect(FORECAST_STATES).toEqual(['range', 'no_trend', 'early', 'steady', 'waiting', 'short', 'no_data', 'tonight', 'failed', 'off']);
    expect(ForecastRow.parse(row)).toEqual(row);
    for (const state of FORECAST_STATES) expect(ForecastRow.safeParse({ ...row, state }).success, state).toBe(true);
    expect(ForecastRow.safeParse({ ...row, state: 'sure' }).success).toBe(false);
    // No raw number travels beside the words: a field the contract does not name is refused, not ignored.
    for (const extra of [{ mean: 4 }, { lo: 2, hi: 6 }, { points: [] }, { values: [1, 2, 3] }]) expect(ForecastRow.safeParse({ ...row, ...extra }).success, JSON.stringify(extra)).toBe(false);
    expect(ForecastRow.safeParse({ ...row, key: 'Daily Deploys' }).success).toBe(false);
  });

  it('the page, one number, the questions and the scores are strict, and bounded', () => {
    const page = { state: 'on', numbers: [row], waiting: [{ id: 'prabc123', numbers: 12 }], questions: 2, announce: false, secondOpinion: true };
    expect(PredictionsPage.parse(page)).toEqual(page);
    // A runtime from before the second opinion does not say whether the sheet may offer it: its page is still a
    // page (the server reads it during a deploy), and unsaid is no. Said, it is a plain yes or no.
    const { secondOpinion: _s, ...older } = page;
    expect(PredictionsPage.parse(older)).toEqual(older);
    expect(PredictionsPage.parse(older).secondOpinion).toBeUndefined();
    for (const bad of ['yes', 1, null]) expect(PredictionsPage.safeParse({ ...page, secondOpinion: bad }).success, String(bad)).toBe(false);
    expect(PredictionsPage.safeParse({ ...page, state: 'maybe' }).success).toBe(false);
    expect(PredictionsPage.safeParse({ ...page, extra: 1 }).success).toBe(false);
    expect(PredictionsPage.safeParse({ ...page, numbers: Array.from({ length: 61 }, () => row) }).success).toBe(false);
    // What the console asks on load holds two facts and nothing else: no number of any series rides along.
    expect(PredictionsWaiting.parse({ questions: 2, announce: true })).toEqual({ questions: 2, announce: true });
    for (const bad of [{ questions: 2 }, { questions: -1, announce: false }, { questions: 2, announce: 'yes' }, { questions: 2, announce: false, numbers: [row] }, { questions: 2, announce: false, state: 'on' }]) {
      expect(PredictionsWaiting.safeParse(bad).success, JSON.stringify(bad).slice(0, 60)).toBe(false);
    }
    const fact = { label: 'Today', value: 'About 4', says: 'The 80% range is 2 to 6.' };
    const series = { number: row, forecast: [fact], chance: { label: 'Above 3', value: 'Likely · 70%', says: 'It’s likely, around 70%, that today runs above 3.' }, opinion: null, record: 'Flint has no results for this number yet.', waiting: false, offHere: false };
    expect(SeriesAnswer.parse({ series })).toEqual({ series });
    // The local model's second opinion is one sentence, its switch, and whether it can be turned on here: never a number beside the words.
    const opinion = { on: true, says: 'The local model said about 60%.', offer: false };
    expect(SeriesAnswer.parse({ series: { ...series, opinion } })).toEqual({ series: { ...series, opinion } });
    expect(SecondOpinion.safeParse({ on: false, says: 'The local model doesn’t estimate this number.', offer: true }).success).toBe(true);
    for (const bad of [{ ...opinion, probability: 0.6 }, { ...opinion, reasonCode: 'trend' }, { ...opinion, model: 'muse-glimmer:30b' }, { on: true, offer: false }, { ...opinion, says: 'about 60%' }, { ...opinion, says: '{"p":0.6}.' }]) {
      expect(SeriesAnswer.safeParse({ series: { ...series, opinion: bad } }).success, JSON.stringify(bad)).toBe(false);
    }
    // An older runtime's open number has no such key at all: still an answer, with nothing to show.
    const { opinion: _o, ...olderSeries } = series;
    expect(SeriesAnswer.parse({ series: olderSeries })).toEqual({ series: olderSeries });
    expect(SeriesAnswer.safeParse({ series: { ...series, chance: null } }).success).toBe(true);
    expect(SeriesAnswer.safeParse({ series: { ...series, forecast: Array.from({ length: 9 }, () => fact) } }).success).toBe(false);
    expect(SeriesAnswer.safeParse({ series: { ...series, points: [{ mean: 4 }] } }).success).toBe(false);
    const q = { id: 'pdabc123', title: 'The deploy lands by Friday', says: 'Flint said likely, around 70%, on Oct 3. It was due Oct 5 at 3:00 PM.', answer: null, answerable: true };
    const qs = { waiting: [q], answered: [{ ...q, answer: 'yes' }], offHere: false };
    expect(QuestionsPage.parse(qs)).toEqual(qs);
    expect(QuestionsPage.safeParse({ ...qs, waiting: [{ ...q, answer: 'maybe' }] }).success).toBe(false);
    expect(QuestionsPage.safeParse({ ...qs, waiting: [{ ...q, probability: 0.7 }] }).success).toBe(false);
    expect(QuestionsPage.safeParse({ ...qs, waiting: [{ ...q, id: 'pd abc' }] }).success).toBe(false);
    // Whether a question can be answered Yes or No is always said, and so is whether anything can be answered here at all.
    const { answerable: _a, ...unsaid } = q;
    expect(QuestionsPage.safeParse({ ...qs, waiting: [unsaid] }).success).toBe(false);
    expect(QuestionsPage.safeParse({ ...qs, waiting: [{ ...q, answerable: 'yes' }] }).success).toBe(false);
    expect(QuestionsPage.safeParse({ waiting: [q], answered: [] }).success).toBe(false);
    // A title is at most 300 characters: one over is refused, never cut.
    expect(QuestionsPage.safeParse({ ...qs, waiting: [{ ...q, title: 'x'.repeat(301) }] }).success).toBe(false);
    const acc = { scored: true, scoring: 'on', areas: [{ name: 'Deploys', value: '12 Scored', lines: ['Flint has 12 of the 30 range results it needs.'] }], unsettled: ['3 predictions ran out before they could be checked.'] };
    expect(AccuracyView.parse(acc)).toEqual(acc);
    for (const scoring of ['off_here', 'not_started', 'on']) expect(AccuracyView.safeParse({ ...acc, scoring }).success, scoring).toBe(true);
    for (const bad of [{ ...acc, scoring: 'maybe' }, { scored: true, areas: acc.areas, unsettled: acc.unsettled }]) expect(AccuracyView.safeParse(bad).success).toBe(false);
    expect(AccuracyView.safeParse({ ...acc, areas: [{ ...acc.areas[0], lines: [] }] }).success).toBe(false);
    expect(AccuracyView.safeParse({ ...acc, areas: [{ ...acc.areas[0], brier: 0.2 }] }).success).toBe(false);
  });

  it('the requests: an answer is yes, no or skip; turning on names numbers by key; turning off sends nothing', () => {
    for (const a of ['yes', 'no', 'skip']) expect(AnswerBody.parse({ answer: a })).toEqual({ answer: a });
    for (const bad of [{}, { answer: 'maybe' }, { answer: true }, { answer: 'yes', outcome: true }, { answer: 'yes', resolvedBy: 'will' }]) expect(AnswerBody.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    expect(TurnOnBody.parse({ series: ['daily.deploys.count'] })).toEqual({ series: ['daily.deploys.count'] });
    // The local model's second opinion is one switch for the numbers named: on, off, or unsaid (off).
    for (const opinion of [true, false]) expect(TurnOnBody.parse({ series: ['daily.deploys.count'], opinion })).toEqual({ series: ['daily.deploys.count'], opinion });
    for (const bad of [{ series: ['daily.deploys.count'], opinion: 'yes' }, { series: ['daily.deploys.count'], opinion: ['daily.deploys.count'] }, { series: ['daily.deploys.count'], opinion: true, model: 'gpt-oss:120b-cloud' }]) {
      expect(TurnOnBody.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    for (const bad of [{}, { series: [] }, { series: ['Deploys'] }, { series: ['daily.deploys.count'], reason: ['daily.deploys.count'] }, { series: Array.from({ length: 41 }, (_, i) => `daily.x${i}.count`) }]) {
      expect(TurnOnBody.safeParse(bad).success, JSON.stringify(bad).slice(0, 80)).toBe(false);
    }
    expect(PredictEmptyBody.safeParse({}).success).toBe(true);
    expect(PredictEmptyBody.safeParse({ on: false }).success).toBe(false);
    expect(PredictFiled.safeParse({ id: 'prabc123', deduped: false }).success).toBe(true);
    expect(PredictFiled.safeParse({ id: 'prabc123', deduped: false, args: {} }).success).toBe(false);
    expect(PredictDone.safeParse({ ok: true }).success).toBe(true);
    expect(PredictDone.safeParse({ ok: false }).success).toBe(false);
  });

  it('the day\'s questions are the action\'s own cap, and an area needs thirty results before Flint says how it did', () => {
    expect(CODE_TABLE['ledger.resolve.ask_will']!.cap).toEqual({ limit: QUESTIONS_PER_DAY, period: 'day' });
    expect(CODE_TABLE['ledger.resolve.ask_will']!.shadow).toBe(true);
    expect(ACCURACY_MIN).toBe(30);
  });
});
