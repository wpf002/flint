/**
 * A prediction's rules as the code says them (the database says the same, by
 * id): P4's forecast fields, the method a forecast may claim, the forecaster's
 * claim template, and the one shape the HTTP route takes.
 */
import { describe, it, expect } from 'vitest';
import { CLAIM_TEMPLATES, ChatPrediction, EmitPrediction, EmitPredictionIn, FORECAST_WRITER, INTERNAL_TEMPLATES, METHODS, REASON_WRITER, renderClaim, validatePrediction } from '../../src/ledger/emit';

const soon = () => new Date(Date.now() + 86_400_000).toISOString();
const base = () => ({
  claim: 'a synthetic claim', kind: 'binary' as const, probability: 0.6, method: 'rule' as const, domain: 'services' as const, type: 'event_occurs' as const,
  evidence: [], resolutionCriteria: 'synthetic criteria', resolver: 'auto_world' as const, resolveBy: soon(), tainted: false,
});
const why = (over: Record<string, unknown>, createdBy?: string) => validatePrediction(EmitPrediction.parse({ ...base(), ...over }), new Date(), createdBy);
// A forecast's row says what its series is: the registry's unit and domain for daily.deploys.count.
const onRun = { seriesKey: 'daily.deploys.count', forecastRunId: 'frtest0001', resolver: 'auto_metric', method: 'statistical', unit: 'count', domain: 'deploys' };
const range = { kind: 'interval', probability: undefined, pointEstimate: 4, lower: 2, upper: 6, level: 0.8 };

describe('emit: P4\'s rules', () => {
  it('`statistical` is a method; an ordinary prediction is as it was', () => {
    expect([...METHODS]).toEqual(['model_reasoning', 'prophet', 'statistical', 'rule', 'base_rate', 'human']);
    expect(why({})).toEqual([]);
    expect(EmitPrediction.safeParse({ ...base(), method: 'oracle' }).success).toBe(false);
  });

  it('a range needs its middle, both ends and a level, in order; a yes/no carries none', () => {
    expect(why({ ...onRun, ...range }, FORECAST_WRITER)).toEqual([]);
    for (const missing of ['pointEstimate', 'lower', 'upper', 'level']) {
      expect(why({ ...onRun, ...range, [missing]: undefined }), missing).toEqual(['a range needs its middle, both ends and a level']);
    }
    expect(why({ ...onRun, ...range, lower: 5 })).toEqual(['a range runs from its lower end, through its middle, to its upper end']);
    expect(why({ ...onRun, ...range, upper: 3 })).toEqual(['a range runs from its lower end, through its middle, to its upper end']);
    expect(why({ ...onRun, ...range, lower: 4, upper: 4 })).toEqual([]);
    for (const extra of [{ pointEstimate: 4 }, { lower: 1 }, { upper: 9 }, { level: 0.8 }]) expect(why({ ...onRun, ...extra }), JSON.stringify(extra)).toEqual(['a yes/no prediction carries no range']);
    // The shapes zod refuses outright: not finite, a level outside (0, 1), a unit that is not a unit.
    for (const bad of [{ pointEstimate: Infinity }, { lower: NaN }, { level: 0 }, { level: 1 }, { unit: 'US Dollars' }, { seriesKey: 'Deploys Today' }, { forecastRunId: 'a run id with spaces' }]) {
      expect(EmitPrediction.safeParse({ ...base(), ...onRun, ...range, ...bad }).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('a forecast names its run and its series together, resolves by itself, is untainted, and is written by the forecaster', () => {
    expect(why(onRun, FORECAST_WRITER)).toEqual([]);
    expect(why({ ...onRun, forecastRunId: undefined })).toEqual(['a forecast names its run and its series together', 'a statistical prediction names its forecast run']);
    expect(why({ ...onRun, seriesKey: undefined })).toContain('a forecast names its run and its series together');
    expect(why({ method: 'statistical' })).toEqual(['a statistical prediction names its forecast run']);
    // Nothing is recorded as Prophet's, with a run or without: Flint calls no outside forecaster.
    expect(why({ method: 'prophet' })).toEqual(['no prediction is recorded as prophet: Flint forecasts on this Mac']);
    expect(why({ ...onRun, method: 'prophet' }, FORECAST_WRITER)).toEqual(['no prediction is recorded as prophet: Flint forecasts on this Mac']);
    expect(why({ ...onRun, resolver: 'will' })).toEqual(["a forecast's prediction resolves by itself, from its series"]);
    expect(why({ ...onRun, method: 'rule' })).toEqual(["a forecast's prediction is not made by rule"]);
    expect(why({ ...onRun, method: 'human', probability: 0.99 })).toEqual(["a forecast's prediction is not made by human"]);
    expect(why({ ...onRun, subjectEntityId: 'entest0001' })).toEqual(["a forecast's prediction is about a series, not an entity"]);
    expect(why({ ...onRun, tainted: true, claim: undefined, template: { id: 'threshold', params: { series: 'daily.deploys.count', op: 'above', value: 3 } } })).toEqual(["a forecast's prediction is never tainted"]);
    // The writer: the forecaster's methods are runtime:forecast's, the local model's estimate is runtime:reason's.
    expect(why(onRun, 'runtime:triage')).toEqual(["a forecast's statistical prediction is written by runtime:forecast"]);
    expect(why({ ...onRun, method: 'base_rate' }, REASON_WRITER)).toEqual(["a forecast's base_rate prediction is written by runtime:forecast"]);
    expect(why({ ...onRun, method: 'model_reasoning' }, FORECAST_WRITER)).toEqual(["a forecast's model_reasoning prediction is written by runtime:reason"]);
    expect(why({ ...onRun, method: 'model_reasoning' }, REASON_WRITER)).toEqual([]);
    // No reason carries a value the caller sent.
    const said = why({ ...onRun, ...range, lower: 31337.4242, pointEstimate: 4, upper: 3 }, 'server').join(' ');
    expect(said).not.toContain('31337');
  });

  it('a forecast says what its series is: the registry\'s unit and domain, never another\'s; and only a registered series is forecast', () => {
    const spend = { ...onRun, seriesKey: 'daily.spend.anthropic.usd', unit: 'usd', domain: 'spend' };
    expect(why(spend, FORECAST_WRITER)).toEqual([]);
    // Dollars are never on record as a count of deploys (where whatever reads forecasts would take them for ops data).
    expect(why({ ...spend, unit: 'count' }, FORECAST_WRITER)).toEqual(["a forecast carries its series' unit"]);
    expect(why({ ...spend, unit: undefined }, FORECAST_WRITER)).toEqual(["a forecast carries its series' unit"]);
    expect(why({ ...spend, domain: 'deploys' }, FORECAST_WRITER)).toEqual(["a forecast is filed under its series' domain"]);
    expect(why({ ...spend, unit: 'count', domain: 'deploys' }, FORECAST_WRITER)).toEqual(["a forecast carries its series' unit", "a forecast is filed under its series' domain"]);
    expect(why({ ...onRun, domain: 'spend' }, FORECAST_WRITER)).toEqual(["a forecast is filed under its series' domain"]);
    expect(why({ ...onRun, seriesKey: 'daily.calendar.hours', unit: 'hours', domain: 'calendar' }, FORECAST_WRITER)).toEqual([]);
    expect(why({ ...onRun, seriesKey: 'daily.spend.acme.usd', unit: 'usd', domain: 'spend' }, FORECAST_WRITER)).toEqual(['a forecast is of a registered series']);
  });

  it('a forecast writer records only a forecast\'s predictions: a row of its own with no run and series is refused', () => {
    for (const writer of [FORECAST_WRITER, REASON_WRITER]) {
      expect(why({}, writer), writer).toEqual([`${writer} records only a forecast's predictions, each with its run and series`]);
      expect(why({ method: 'base_rate', domain: 'spend', claim: 'a synthetic claim about spend' }, writer), writer).toEqual([`${writer} records only a forecast's predictions, each with its run and series`]);
    }
    // Every other writer's plain prediction is as it was.
    for (const writer of ['runtime:triage', 'runtime:goals', 'client:server', undefined]) expect(why({}, writer), String(writer)).toEqual([]);
  });

  it('the forecaster\'s claim is a template: a series key, two numbers and a date', () => {
    const p = EmitPrediction.parse({ ...base(), ...onRun, ...range, claim: undefined, template: { id: 'series_range', params: { series: 'daily.deploys.count', lo: 2, hi: 6, on: '2026-10-14' } } });
    expect(validatePrediction(p, new Date(), FORECAST_WRITER)).toEqual([]);
    expect(renderClaim(p)).toBe('daily.deploys.count is between 2 and 6 on 2026-10-14');
    const bad = EmitPrediction.parse({ ...base(), ...onRun, ...range, claim: undefined, template: { id: 'series_range', params: { series: 'Deploys today', lo: 6, hi: 2, on: 'soon' } } });
    expect(validatePrediction(bad).join(' ')).toMatch(/^template series_range: /);
    // Its yes/no question is about the same whole day (or week), so it says "on" that day, never "at the resolve time".
    const q = EmitPrediction.parse({ ...base(), ...onRun, claim: undefined, template: { id: 'series_above', params: { series: 'daily.deploys.count', value: 4, on: '2026-10-14' } } });
    expect(renderClaim(q)).toBe('daily.deploys.count is above 4 on 2026-10-14');
    // Chat's four, and the runtime's own four (a goal review's forecast, the forecaster's range and its question, a task's forecast).
    expect(Object.keys(CLAIM_TEMPLATES).sort()).toEqual(['closed_by', 'deploy_succeeds', 'goal_on_track', 'series_above', 'series_range', 'service_healthy', 'task_meets_bar', 'threshold']);
    expect([...INTERNAL_TEMPLATES].sort()).toEqual(['goal_on_track', 'series_above', 'series_range', 'task_meets_bar']);
    // The wider shape P3's review holds to: none of the runtime's templates, from any caller of the route.
    for (const template of [{ id: 'series_range', params: { series: 'daily.deploys.count', lo: 2, hi: 6, on: '2026-10-14' } }, { id: 'series_above', params: { series: 'daily.deploys.count', value: 4, on: '2026-10-14' } }, { id: 'goal_on_track', params: { goal: 'goal#abc123', by: '2026-12-01' } }]) {
      expect(EmitPredictionIn.safeParse({ ...base(), claim: undefined, template }).success, template.id).toBe(false);
    }
  });
});

describe('emit: a task\'s forecast (P5)', () => {
  const TASK = 'tkabcdefghij123456';
  const task = (over: Record<string, unknown> = {}) => ({
    claim: undefined, template: { id: 'task_meets_bar', params: { task: 'task#123456', by: '2026-12-01' } }, kind: 'binary', probability: 0.6, method: 'base_rate', domain: 'assets', type: 'task_meets_bar',
    resolver: 'auto_world', resolverSpec: { taskId: TASK, rule: 'task_meets_bar' }, ...over,
  });
  const WRITER = 'runtime:tasks';
  const SAYS = ['a task’s forecast is the tasks writer’s, under the task template with its task’s rule, and only it is'];

  it('is the tasks writer\'s, under the task template, by base rate, settled from the world under the rule that names its task', () => {
    expect(why(task(), WRITER)).toEqual([]);
    expect(renderClaim(EmitPrediction.parse({ ...base(), ...task() }))).toBe('task#123456 meets its bar by 2026-12-01');
    // That writer records nothing else: another template or a claim of its own, another domain, type, method or resolver, a tainted one, or one without its task's rule.
    for (const over of [
      { template: undefined, claim: 'the task goes well' }, { template: { id: 'goal_on_track', params: { goal: 'goal#abc123', by: '2026-12-01' } } },
      { domain: 'services' }, { type: 'event_occurs' }, { method: 'rule' }, { resolver: 'will' }, { tainted: true },
      { resolverSpec: undefined }, { resolverSpec: { taskId: TASK } }, { resolverSpec: { taskId: TASK, rule: 'goal_done_by' } }, { resolverSpec: { taskId: 'task1', rule: 'task_meets_bar' } },
      { resolverSpec: { taskId: TASK, rule: 'task_meets_bar', owner: 'someone' } },
    ]) expect(why(task(over), WRITER), JSON.stringify(over)).toEqual(expect.arrayContaining(SAYS));
    // And no other writer uses the template: the goals writer, the forecaster, chat's connector, or a caller that names none.
    for (const writer of ['runtime:goals', FORECAST_WRITER, REASON_WRITER, 'runtime-mcp', undefined]) expect(why(task(), writer), String(writer)).toEqual(expect.arrayContaining(SAYS));
    expect(why(task(), 'runtime:goals')).toEqual(SAYS);
    // Any other writer's ordinary prediction is as it was.
    expect(why({}, 'runtime:triage')).toEqual([]);
  });
});

describe('the HTTP route\'s shape: only what chat sends', () => {
  const chat = () => ({
    claim: 'the deploy finishes today', probability: 0.7, method: 'model_reasoning', resolver: 'will', domain: 'deploys', type: 'event_occurs',
    resolutionCriteria: 'Will says whether it did.', resolveBy: soon(), evidence: [], tainted: false,
  });
  const ok = (over: Record<string, unknown>) => ChatPrediction.safeParse({ ...chat(), ...over }).success;

  it('takes the connector\'s exact body, with a claim or one of chat\'s four templates', () => {
    expect(ok({})).toBe(true);
    expect(ok({ kind: 'binary' })).toBe(true);
    expect(ok({ claim: undefined, tainted: true, template: { id: 'closed_by', params: { entity: 'issue#abc123' } } })).toBe(true);
    expect(ChatPrediction.parse(chat())).toMatchObject({ kind: 'binary', method: 'model_reasoning', resolver: 'will' });
    expect(validatePrediction(ChatPrediction.parse(chat()), new Date(), 'runtime-mcp')).toEqual([]);
  });

  it('refuses every other method, resolver and kind, and every field chat does not send', () => {
    for (const method of ['human', 'statistical', 'prophet', 'rule', 'base_rate']) expect(ok({ method }), method).toBe(false);
    for (const resolver of ['auto_metric', 'auto_world', 'conditional']) expect(ok({ resolver }), resolver).toBe(false);
    expect(ok({ kind: 'interval' })).toBe(false);
    for (const extra of [
      { pointEstimate: 4 }, { lower: 2 }, { upper: 6 }, { level: 0.8 }, { unit: 'usd' }, { seriesKey: 'daily.deploys.count' }, { forecastRunId: 'frtest0001' },
      { subjectEntityId: 'entest0001' }, { supersedesId: 'pdtest0001' }, { conditionRecommendationId: 'rctest0001' }, { resolverSpec: { entityId: 'x' } },
      { model: 'some-model' }, { modelConfig: { temperature: 0 } }, { createdBy: 'will' }, { goalId: 'gotest0001' },
    ]) expect(ok(extra), JSON.stringify(extra)).toBe(false);
    // The runtime's own templates are not chat's to fill: the forecaster's range, a goal review's forecast.
    expect(ok({ claim: undefined, template: { id: 'series_range', params: { series: 'daily.deploys.count', lo: 2, hi: 6, on: '2026-10-14' } } })).toBe(false);
    expect(ok({ claim: undefined, template: { id: 'goal_on_track', params: { goal: 'goal#abc123', by: '2026-12-01' } } })).toBe(false);
    // What the body must say: whether the turn read outside text, and a probability.
    expect(ok({ tainted: undefined })).toBe(false);
    expect(ok({ probability: undefined })).toBe(false);
    expect(ok({ method: undefined })).toBe(false);
    expect(ok({ resolver: undefined })).toBe(false);
  });
});
