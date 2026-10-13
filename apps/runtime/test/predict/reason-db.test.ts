/**
 * The local model's second opinion on flint_test (P4 part 5), against a stub
 * Ollama: what is sent for, what is recorded, and everything that is not.
 *
 *  - Nothing is sent unless a signed card turned the second opinion on for a
 *    number, and then only for a run that has a question to ride on: a steady
 *    number, a number waiting for history or for yesterday's value, a failed
 *    run and a step already over get none.
 *  - The estimate is recorded beside the forecaster's answer: the same claim,
 *    rule and resolve time, as `model_reasoning`, written by runtime:reason,
 *    with the model's name and the prompt's version. One per run.
 *  - A probability outside 0.05 to 0.95 records nothing. A missing model, a
 *    model that is not on this Mac, a used-up cap and a rule that forbids it
 *    record nothing, and none of them touches the forecast already written.
 *  - While chat is busy it sends itself again, 15 seconds out, up to 40 times,
 *    then gives up and Settings > Health says so.
 *  - A number's estimate costs at most two requests and one slot of the day's
 *    cap a night, however many jobs run for it: the queue never runs a failed
 *    one again, and what it asked and claimed is counted in the database, by
 *    the number's key.
 *  - The second look, before the write, is at the time of writing: a step that
 *    ended, a switch turned off, a question settled or an estimate written
 *    while the model answered, and nothing is written.
 *  - The sweep settles it like any other. The night's scores for an area do
 *    not count it: it is scored only beside the forecaster's answer.
 *  - Job data, audit entries and log lines hold ids, keys and counts: never a
 *    series' value, a probability or a prompt.
 * Synthetic numbers; Flint's zone is UTC here. The clock is read once (NOW).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addLocalDays, localDay, localDayBounds } from '@flint/policy';
import { NO_DB, freshDb, type TestUrls } from '../db';
import { CANARY, DAY, HOUR, TZ, dayStart as kitDayStart, ledgerKit, type LedgerKit } from '../ledger/kit';
import { FakeBus, goalFixture, type GoalFixture } from '../goals/fixture';
import { startBus } from '../../src/bus';
import { claim } from '../../src/governance/counters';
import { checkComponents } from '../../src/health/checks';
import { snapshotCalibration } from '../../src/ledger/calibration';
import { sweep } from '../../src/ledger/sweep';
import { LocalModels } from '../../src/model/here';
import { weekOf } from '../../src/predict/metrics';
import { forecastSeries, freqOf } from '../../src/predict/series';
import { runForecasts } from '../../src/predict/run';
import {
  DEFERRAL_MARK, DEFERRAL_SAYS, DEFER_SECONDS, MAX_DEFERRALS, MISSED_SAYS, PROMPT_VERSION, REASON_ACTION, REASON_QUEUE, REASON_SEND, ReasonJob, claimedCounter, requestsCounter, runReason,
  sendReasons,
  type ReasonDeps,
} from '../../src/predict/reason';
import { listening, modelsHere, tags } from '../ollama-kit';

const OLLAMA = { url: 'http://127.0.0.1:11434', model: 'muse-glimmer:30b' };
const DEPLOYS = 'daily.deploys.count';
const ANTHROPIC = 'daily.spend.anthropic.usd';
const THREADS = 'daily.threads.open';
const DOWNTIME = 'daily.services.incident_minutes';
const CALENDAR = 'daily.calendar.hours';
const OPENAI = 'daily.spend.openai.usd';
const TAVILY = 'daily.spend.tavily.usd';
const FLINT = 'weekly.commits.flint.count';

// Ollama says the model is its own (what makes a model "not here" has its own test below, and model/here.test.ts).
modelsHere([OLLAMA.model]);

const chat = (content: unknown) => new Response(JSON.stringify({ model: 'm', message: { role: 'assistant', content: typeof content === 'string' ? content : JSON.stringify(content) }, done: true, done_reason: 'stop', prompt_eval_count: 10, eval_count: 5 }), { status: 200, headers: { 'content-type': 'application/json' } });

describe.skipIf(NO_DB)('the local model’s second opinion on flint_test', () => {
  let urls: TestUrls;
  let k: LedgerKit;
  let g: GoalFixture;
  const bus = new FakeBus();
  /** One clock for the whole file, read once. */
  const NOW = new Date();
  const dayStart = (daysAgo: number) => kitDayStart(daysAgo, NOW);
  const said: string[] = [];
  /** What the stand-in model was sent, as parsed bodies. */
  let sent: Array<{ model: string; messages: Array<{ role: string; content: string }> }> = [];
  const model = (replies: unknown[]) => {
    let n = 0;
    return (async (_url: string, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)));
      const r = replies[Math.min(n++, replies.length - 1)];
      if (r instanceof Error) throw r;
      return chat(r);
    }) as unknown as typeof fetch;
  };
  const deps = (over: Partial<ReasonDeps> = {}): ReasonDeps => ({ db: k.db, bus, config: { tz: TZ, ollama: OLLAMA }, load: async () => 'proceed', log: (m) => void said.push(m), now: () => NOW, ...over });
  const reason = (runId: string, over: Partial<ReasonDeps> = {}, job: Partial<ReasonJob> = {}) => runReason(deps(over), { runId, ...job });

  /** A registered number's row, turned on by a signed card: with the Second Opinion switch, unless told not to. */
  async function number(key: string, second = true): Promise<string> {
    const d = forecastSeries(key)!;
    await k.series({ key: d.key, unit: d.unit, freq: freqOf(d), sensitivity: d.sensitivity, description: d.description });
    await k.turnOn([key], second ? [key] : []);
    return key;
  }
  /** Daily values ending `endAgo` days ago (the last is that day's), oldest first. */
  const days = async (key: string, values: number[], endAgo = 1) => {
    for (const [i, v] of values.entries()) await k.point(key, dayStart(endAgo + values.length - 1 - i), v);
  };
  const line = (n: number) => Array.from({ length: n }, (_, i) => 10 + 2 * i);
  /** Weekly values for the weeks before this one (the last is last week's), oldest first. */
  const weeks = async (key: string, values: number[]) => {
    const monday = new Date(`${weekOf(localDay(TZ, NOW))}T00:00:00.000Z`);
    for (const [i, v] of values.entries()) await k.point(key, new Date(monday.getTime() - (values.length - i) * 7 * DAY), v);
  };
  /** Will signs numbers on again, with or without the Second Opinion: one card, one transaction, as the executor runs it. */
  async function signOn(keys: string[], second: string[]): Promise<void> {
    const c = await k.card('forecast.series.enable', { series: [...keys].sort(), reason: [...second].sort() });
    await k.inTx(async (q) => {
      for (const key of keys) await q(`UPDATE "ForecastSeries" SET "on" = true, reason = $2, "approvalId" = $3 WHERE "seriesKey" = $1`, [key, second.includes(key), c.aid]);
    });
    await k.finish(c.pid);
  }
  const latestRun = async (key: string) => (await k.owner(`SELECT id FROM "ForecastRun" WHERE "seriesKey" = $1 AND ok ORDER BY "createdAt" DESC, id DESC LIMIT 1`, [key])).rows[0]?.id as string | undefined;
  const question = async (runId: string) => (await k.owner(`SELECT * FROM "Prediction" WHERE "forecastRunId" = $1 AND kind = 'binary' AND "createdBy" = 'runtime:forecast'`, [runId])).rows[0];
  const estimates = async (runId: string) => (await k.owner(`SELECT * FROM "Prediction" WHERE "forecastRunId" = $1 AND "createdBy" = 'runtime:reason' ORDER BY "createdAt"`, [runId])).rows;
  /** A new night for a number: what was asked and claimed for it is counted by the night. */
  const newNight = (key: string) => k.owner(`DELETE FROM "ActionCounter" WHERE action = ANY($1)`, [[requestsCounter(key), claimedCounter(key)]]);
  const counter = async (action: string) => (await k.owner(`SELECT coalesce(sum(count), 0)::int AS n FROM "ActionCounter" WHERE action = $1`, [action])).rows[0].n as number;
  const audits = async () => (await k.owner(`SELECT actor, context, kind, action, tier, outcome, inputs, reasoning, "outcomeDetail" FROM "AuditEntry" WHERE action = $1 ORDER BY seq DESC`, [REASON_ACTION])).rows;
  /** Everything that must never hold a value, a probability or a prompt: job data, audit entries, health details, log lines. */
  const everywhere = async () => JSON.stringify([
    bus.sent.map((j) => [j.data, j.options]),
    (await k.owner(`SELECT inputs, reasoning, "outcomeDetail", "correlationId" FROM "AuditEntry" WHERE action = $1`, [REASON_ACTION])).rows,
    (await k.owner(`SELECT detail FROM "HealthCheck"`)).rows,
    said,
  ]);

  beforeAll(async () => {
    urls = await freshDb();
    k = await ledgerKit(urls);
    g = await goalFixture(urls, k.db);
    // Deploys: a rising line, 60 days of it (a forecast that beats a plain guess). Anthropic: thirty days of dollars
    // with a number no test writes anywhere else. Threads: steady. Downtime: ten days, not enough. OpenAI: on, with
    // a forecast, and no Second Opinion switch. Calendar: yesterday's number is not in.
    await number(DEPLOYS);
    await days(DEPLOYS, line(60));
    await number(ANTHROPIC);
    await days(ANTHROPIC, Array.from({ length: 30 }, (_, i) => Math.round((CANARY / 1000 + i * 0.37) * 100) / 100));
    await number(THREADS);
    await days(THREADS, Array.from({ length: 24 }, () => 7));
    await number(DOWNTIME);
    await days(DOWNTIME, line(10));
    await number(OPENAI, false);
    await days(OPENAI, line(40));
    await number(CALENDAR);
    await days(CALENDAR, line(30), 2);
    const c = await runForecasts({ db: k.db, tz: TZ, now: NOW });
    expect(c).toMatchObject({ on: 6, ran: 3, steady: 1, waiting: 1, late: 1, failed: 0, refused: 0 });
  });
  afterAll(async () => {
    await k?.db.$disconnect();
  });
  beforeEach(() => {
    sent = [];
  });

  it('a second opinion is asked for only where a signed card turned it on, and only for a run with a question', async () => {
    const n = await sendReasons({ db: k.db, bus, now: NOW });
    // Deploys and Anthropic have a question to ride on. Threads is steady (a run, nothing to ask), Downtime and
    // Calendar have no run, and OpenAI has a question but no Second Opinion switch.
    expect(n).toBe(2);
    const jobs = bus.of(REASON_QUEUE);
    expect(jobs.map((j) => j.options.singletonKey).sort()).toEqual([DEPLOYS, ANTHROPIC]);
    // A job is its run's id and nothing else.
    for (const j of jobs) {
      expect(Object.keys(j.data)).toEqual(['runId']);
      expect(ReasonJob.safeParse(j.data).success).toBe(true);
      // Sent to run once: the queue does not run a failed one again.
      expect(j.options).toEqual({ singletonKey: expect.any(String), retryLimit: 0 });
    }
    expect(REASON_SEND).toEqual({ retryLimit: 0 });
    expect(jobs.find((j) => j.options.singletonKey === DEPLOYS)!.data.runId).toBe(await latestRun(DEPLOYS));
    // Asked again while those wait: the same jobs, not more (stately on the series).
    expect(await sendReasons({ db: k.db, bus, now: NOW })).toBe(2);
    expect(bus.of(REASON_QUEUE)).toHaveLength(2);
    // With no number's switch on, nothing is read past the switches and nothing is sent.
    const none = new FakeBus();
    await k.inTx((q) => q(`UPDATE "ForecastSeries" SET reason = false WHERE "seriesKey" = ANY($1)`, [[DEPLOYS, ANTHROPIC, THREADS, DOWNTIME, CALENDAR]]), { actor: 'will:console' });
    expect(await sendReasons({ db: k.db, bus: none, now: NOW })).toBe(0);
    expect(none.sent).toEqual([]);
    // Flint cannot put one back: only a card Will signs turns it on.
    expect(await k.code(k.inTx((q) => q(`UPDATE "ForecastSeries" SET reason = true WHERE "seriesKey" = $1`, [DEPLOYS])))).toBe('42501');
    await signOn([DEPLOYS, ANTHROPIC, THREADS, DOWNTIME, CALENDAR], [DEPLOYS, ANTHROPIC, THREADS, DOWNTIME, CALENDAR]);
    expect(await sendReasons({ db: k.db, bus: none, now: NOW })).toBe(2);
  });

  it('the estimate is recorded beside the forecaster’s answer: the same claim, rule and resolve time, as the local model’s', async () => {
    const runId = (await latestRun(DEPLOYS))!;
    const q = await question(runId);
    const before = { record: await counter('ledger.prediction.record'), forecast: await counter('forecast.local') };
    const r = await reason(runId, { fetch: model([{ probability: 0.62, reasonCode: 'trend' }]) });
    expect(r).toEqual({ outcome: 'recorded' });
    const [e, ...more] = await estimates(runId);
    expect(more).toEqual([]);
    expect(e).toMatchObject({
      kind: 'binary', probability: 0.62, method: 'model_reasoning', model: 'ollama:muse-glimmer:30b', createdBy: 'runtime:reason', status: 'open', tainted: false,
      type: 'threshold_cross', resolver: 'auto_metric', domain: 'deploys', unit: 'count', seriesKey: DEPLOYS, forecastRunId: runId,
      modelConfig: { promptVersion: PROMPT_VERSION, schema: 'prediction_estimate', temperature: 0, numCtx: null },
      evidence: [{ kind: 'model', ref: 'ollama:muse-glimmer:30b', note: 'trend' }, { kind: 'forecast_run', ref: runId }],
      pointEstimate: null, lower: null, upper: null, level: null, goalId: null, subjectEntityId: null,
    });
    // The same question, word for word and rule for rule: only who answered, and what they said, differ.
    for (const same of ['claim', 'resolutionCriteria', 'resolverSpec', 'resolveBy', 'kind', 'type', 'resolver', 'domain', 'unit', 'seriesKey']) expect(e[same], same).toEqual(q[same]);
    expect(q.method).toBe('statistical');
    expect(q.probability).not.toBe(0.62);
    // One request, one claim of its own cap; the caps chat and the forecaster use are not touched.
    expect(sent).toHaveLength(1);
    expect(await counter(REASON_ACTION)).toBe(1);
    expect({ record: await counter('ledger.prediction.record'), forecast: await counter('forecast.local') }).toEqual(before);
    // What the model was sent: the number's name and its last 28 values, and never its key.
    const user = sent[0]!.messages.find((m) => m.role === 'user')!.content;
    expect(sent[0]!.model).toBe('muse-glimmer:30b');
    expect(user).toContain('Series: Deploys. Unit: a count. One value per day.');
    expect(user).toContain('The last 28 values, oldest first:');
    expect(user).toContain(`: ${10 + 2 * 59}\nQuestion: is the value for `);
    expect(user).toContain(`above ${(q.resolverSpec as { value: number }).value}?`);
    expect(user).toContain('In testing it beat a plain guess.');
    expect(user).toContain('There are no earlier answers to this question for this series yet.');
    expect(user).not.toMatch(/daily\.|deploys\.count|<data/);
    // One audit entry: the series, the run and counts. No probability, no value.
    const [a, ...rest] = await audits();
    expect(rest).toEqual([]);
    expect(a).toMatchObject({ actor: 'runtime:reason', context: 'autonomous', kind: 'action', action: REASON_ACTION, tier: 'approval', outcome: 'ok', reasoning: null, outcomeDetail: null });
    expect(a.inputs).toEqual({ series: DEPLOYS, run: runId, result: 'recorded', requests: 1, deferrals: 0, modelMs: expect.any(Number) });
    expect(JSON.stringify(a)).not.toContain('0.62');
  });

  it('one estimate per run: a second job finds it there, and none is asked for again', async () => {
    const runId = (await latestRun(DEPLOYS))!;
    expect(await reason(runId, { fetch: model([{ probability: 0.3, reasonCode: 'burst' }]) })).toEqual({ outcome: 'exists' });
    expect(sent).toEqual([]);
    expect(await estimates(runId)).toHaveLength(1);
    expect(await counter(REASON_ACTION)).toBe(1);
    const again = new FakeBus();
    await sendReasons({ db: k.db, bus: again, now: NOW });
    expect(again.of(REASON_QUEUE).map((j) => j.options.singletonKey)).toEqual([ANTHROPIC]);
  });

  it('a spend series’ values reach the local model and nothing else: not a job, an audit entry, a health line or a log line', async () => {
    const runB = (await latestRun(ANTHROPIC))!;
    // Two jobs for one run at once: one estimate.
    const both = await Promise.all([reason(runB, { fetch: model([{ probability: 0.41, reasonCode: 'too_noisy' }]) }), reason(runB, { fetch: model([{ probability: 0.41, reasonCode: 'too_noisy' }]) })]);
    expect(both.map((r) => r.outcome).sort()).toEqual(['exists', 'recorded']);
    const [e, ...more] = await estimates(runB);
    expect(more).toEqual([]);
    expect(e).toMatchObject({ method: 'model_reasoning', probability: 0.41, domain: 'spend', unit: 'usd', seriesKey: ANTHROPIC });
    // The prompt held the dollars (the model is on this Mac)...
    const prompts = sent.map((b) => b.messages.map((m) => m.content).join('\n')).join('\n');
    expect(prompts).toContain('Series: Anthropic Spend. Unit: US dollars. One value per day.');
    // (The last 28 of its 30 days: the third day's dollars lead, the thirtieth's close.)
    const dollars = (i: number) => Math.round((CANARY / 1000 + i * 0.37) * 100) / 100;
    expect(prompts).toContain(`The last 28 values, oldest first:\n${'Sun Mon Tue Wed Thu Fri Sat'.split(' ')[dayStart(28).getUTCDay()]} ${dayStart(28).toISOString().slice(0, 10)}: ${dollars(2)}\n`);
    expect(prompts).toContain(`: ${dollars(29)}\nQuestion: `);
    expect(prompts).toContain('It has too little history to test.');
    // ...and nothing else holds them, the prompt's words, or what the model said.
    const all = await everywhere();
    expect(all).not.toMatch(/\b(3[1-9]|4[0-2])\.\d{2}\b|\b0\.62\b|\b0\.41\b/);
    expect(all).not.toMatch(/Series:|oldest first|Question:|too_noisy|"trend"/);
    // The estimate's own record names the model and its reason code, and holds no value of the series.
    expect(JSON.stringify([e.evidence, e.modelConfig])).not.toMatch(/\b(3[1-9]|4[0-2])\.\d{2}\b/);
    // The cards Will signed name the numbers by key: no value there either.
    expect(JSON.stringify((await k.owner(`SELECT args, reason, error FROM "Proposal"`)).rows)).not.toMatch(/\b(3[1-9]|4[0-2])\.\d{2}\b/);
  });

  it('a probability outside 0.05 to 0.95 records nothing, and is not asked a third time', async () => {
    const key = await number(TAVILY);
    await days(key, line(40).map((v) => v / 10));
    await runForecasts({ db: k.db, tz: TZ, now: NOW });
    const runId = (await latestRun(key))!;
    const claims = await counter(REASON_ACTION);
    expect(await reason(runId, { fetch: model([{ probability: 0.99, reasonCode: 'trend' }, { probability: 0.01, reasonCode: 'trend' }]) })).toEqual({ outcome: 'invalid' });
    expect(sent).toHaveLength(2);
    expect(await estimates(runId)).toEqual([]);
    // One claim for the estimate, however many requests it made.
    expect(await counter(REASON_ACTION)).toBe(claims + 1);
    expect((await audits())[0]).toMatchObject({ outcome: 'failed', inputs: { series: key, run: runId, result: 'invalid', requests: 2 } });
    // The forecast it would have ridden on is as it was.
    expect(await question(runId)).toMatchObject({ status: 'open', createdBy: 'runtime:forecast' });
    // Those were the night's two requests. A job for the same run that night asks nothing, whatever the model would say.
    sent = [];
    expect(await reason(runId, { fetch: model([{ probability: 0.6, reasonCode: 'trend' }]) })).toEqual({ outcome: 'spent' });
    expect(sent).toEqual([]);
    expect(await estimates(runId)).toEqual([]);
    expect(await counter(REASON_ACTION)).toBe(claims + 1);
    expect((await audits())[0]).toMatchObject({ outcome: 'skipped', inputs: { series: key, run: runId, result: 'spent', requests: 0 } });
    // An extra key or a word of the model's own is the same: nothing recorded.
    await newNight(key);
    expect(await reason(runId, { fetch: model([{ probability: 0.6, reasonCode: 'trend', reasoning: 'because' }]) })).toEqual({ outcome: 'invalid' });
    expect(await estimates(runId)).toEqual([]);
    // A later, usable answer is recorded as it is.
    await newNight(key);
    expect(await reason(runId, { fetch: model(['not json', { probability: 0.95, reasonCode: 'recent_level' }]) })).toEqual({ outcome: 'recorded' });
    expect((await estimates(runId))[0]).toMatchObject({ probability: 0.95 });
  });

  it('the honest-forecast rules hold for it too: no run to ride on, no estimate', async () => {
    const asked = () => model([{ probability: 0.6, reasonCode: 'trend' }]);
    // A steady number: a run, a flat line, and no question.
    const steady = (await latestRun(THREADS))!;
    expect(await reason(steady, { fetch: asked() })).toEqual({ outcome: 'nothing' });
    // A failed run, and a run that is not there.
    const failed = await k.run(DEPLOYS, k.failedRun('forecast_failed'));
    expect(await reason(failed, { fetch: asked() })).toEqual({ outcome: 'nothing' });
    expect(await reason('fr0000nothere', { fetch: asked() })).toEqual({ outcome: 'nothing' });
    // A number with no Second Opinion switch, even when a job for its run is sent by hand.
    const plain = (await latestRun(OPENAI))!;
    expect(await question(plain)).toBeDefined();
    expect(await reason(plain, { fetch: asked() })).toEqual({ outcome: 'nothing' });
    expect(await estimates(plain)).toEqual([]);
    // Not enough history, and yesterday's number not in: no run at all, so nothing was ever sent for either.
    expect(await latestRun(DOWNTIME)).toBeUndefined();
    expect(await latestRun(CALENDAR)).toBeUndefined();
    expect(sent).toEqual([]);
    // None of these is an attempt: no claim, no audit entry.
    expect((await audits()).filter((a) => [THREADS, OPENAI, DOWNTIME, CALENDAR].includes(a.inputs.series))).toEqual([]);
  });

  describe('with a fresh forecast to ride on', () => {
    const KEY = 'daily.spend.perplexity.usd';
    let runId: string;
    beforeAll(async () => {
      await number(KEY);
      await days(KEY, line(45).map((v) => v / 4));
      await runForecasts({ db: k.db, tz: TZ, now: NOW });
      runId = (await latestRun(KEY))!;
    });
    // Each test is a night of its own.
    beforeEach(async () => {
      await newNight(KEY);
    });
    const nothingRecorded = async () => {
      expect(await estimates(runId)).toEqual([]);
      expect(await question(runId)).toMatchObject({ status: 'open' });
    };
    const answers = () => model([{ probability: 0.6, reasonCode: 'trend' }]);

    it('a step that is over gets no estimate: one made then would be no forecast', async () => {
      expect(await reason(runId, { now: () => new Date(dayStart(0).getTime() + DAY + 1), fetch: model([{ probability: 0.6, reasonCode: 'trend' }]) })).toEqual({ outcome: 'nothing' });
      expect(sent).toEqual([]);
      await nothingRecorded();
    });

    it('no local model set: nothing is asked and nothing recorded, and no other model is', async () => {
      const o = listening(() => tags([{ name: OLLAMA.model }]), model([{ probability: 0.6, reasonCode: 'trend' }]));
      expect(await runReason(deps({ config: { tz: TZ }, fetch: o.fetch }), { runId })).toEqual({ outcome: 'no_model' });
      expect(o.seen).toEqual([]);
      expect((await audits())[0]).toMatchObject({ outcome: 'skipped', inputs: { series: KEY, result: 'no_model', requests: 0 } });
      await nothingRecorded();
    });

    it('a model that is not on this Mac is never asked: a cloud tag, a plain name Ollama lists with a remote host, a listing that fails, an Ollama elsewhere', async () => {
      const claims = await counter(REASON_ACTION);
      const cases: Array<[{ url: string; model: string; proxied?: true }, () => Response | Promise<Response>, number]> = [
        [{ ...OLLAMA, model: 'gpt-oss:120b-cloud' }, () => tags([{ name: 'gpt-oss:120b-cloud' }]), 0],
        [{ ...OLLAMA, model: 'mine' }, () => tags([{ name: 'mine:latest', remote_host: 'https://ollama.com:443', remote_model: 'gpt-oss:120b' }]), 1],
        // (A listing that fails at once is asked once more; one that hangs is not.)
        [OLLAMA, () => new Response('', { status: 500 }), 2],
        [OLLAMA, () => new Promise<Response>(() => {}), 1],
        [OLLAMA, () => tags([{ name: 'llama3.1:latest' }]), 1],
        [{ ...OLLAMA, url: 'http://10.0.0.5:11434' }, () => tags([{ name: OLLAMA.model }]), 0],
        [{ ...OLLAMA, proxied: true }, () => tags([{ name: OLLAMA.model }]), 0],
      ];
      for (const [ollama, listing, listings] of cases) {
        const o = listening(listing, model([{ probability: 0.6, reasonCode: 'trend' }]));
        const r = await runReason(deps({ config: { tz: TZ, ollama }, fetch: o.fetch, models: new LocalModels({ timeoutMs: 40 }) }), { runId });
        expect(r, JSON.stringify(ollama)).toEqual({ outcome: 'unavailable' });
        // At most a look at the listing on loopback: no model request, anywhere.
        expect(o.sent(), JSON.stringify(ollama)).toBe(0);
        expect(o.seen.map((s) => `${s.method} ${s.url}`), JSON.stringify(ollama)).toEqual(Array(listings).fill('GET http://127.0.0.1:11434/api/tags'));
      }
      expect(sent).toEqual([]);
      expect(await counter(REASON_ACTION)).toBe(claims);
      expect((await audits())[0]).toMatchObject({ outcome: 'failed', inputs: { series: KEY, result: 'unavailable', requests: 0 } });
      await nothingRecorded();
    });

    it('a model that does not answer is unavailable: nothing recorded, the forecast untouched', async () => {
      expect(await reason(runId, { fetch: model([new TypeError('fetch failed')]) })).toEqual({ outcome: 'unavailable' });
      expect((await audits())[0]).toMatchObject({ outcome: 'failed', inputs: { result: 'unavailable', requests: 2 } });
      await nothingRecorded();
    });

    it('while chat is busy it sends itself again, 15 seconds out; after 40 times it gives up and Health says so', async () => {
      const waiting = new FakeBus();
      const claims = await counter(REASON_ACTION);
      const busy = (job: Partial<ReasonJob> = {}) => runReason(deps({ bus: waiting, load: async () => 'defer', fetch: model([{ probability: 0.6, reasonCode: 'trend' }]) }), { runId, ...job });
      expect(await busy()).toEqual({ outcome: 'deferred' });
      expect(waiting.of(REASON_QUEUE)).toEqual([{ queue: REASON_QUEUE, data: { runId, deferrals: 1 }, options: { singletonKey: KEY, startAfter: DEFER_SECONDS, retryLimit: 0 } }]);
      expect([DEFER_SECONDS, MAX_DEFERRALS]).toEqual([15, 40]);
      // Nothing was asked, nothing claimed, and a deferral is not an ending: no audit entry.
      expect(sent).toEqual([]);
      expect(await counter(REASON_ACTION)).toBe(claims);
      expect((await audits())[0]?.inputs.result).not.toBe('deferred');
      // One that yields after its first request sends its run and its count of waits, and nothing else: what it
      // asked and claimed is in the database, where the job it sent finds it.
      waiting.clear();
      let n = 0;
      const half = await runReason(deps({ bus: waiting, load: async () => (n++ ? 'defer' : 'proceed'), fetch: model(['not json']) }), { runId, deferrals: 3 });
      expect(half).toEqual({ outcome: 'deferred' });
      expect(sent).toHaveLength(1);
      expect(waiting.of(REASON_QUEUE)[0]!.data).toEqual({ runId, deferrals: 4 });
      expect(ReasonJob.safeParse(waiting.of(REASON_QUEUE)[0]!.data).success).toBe(true);
      expect(ReasonJob.safeParse({ runId, deferrals: 4, claimed: true, requests: 0 }).success).toBe(false);
      expect(await counter(REASON_ACTION)).toBe(claims + 1);
      // That job makes the night's second request and no third, and takes no second slot of the cap.
      const next = await runReason(deps({ bus: waiting, fetch: model(['not json']) }), ReasonJob.parse(waiting.of(REASON_QUEUE)[0]!.data));
      expect(next).toEqual({ outcome: 'invalid' });
      expect(sent).toHaveLength(2);
      expect(await counter(REASON_ACTION)).toBe(claims + 1);
      expect((await audits())[0]).toMatchObject({ outcome: 'failed', inputs: { series: KEY, run: runId, result: 'invalid', requests: 1, deferrals: 4 } });
      sent = [];
      // The fortieth wait is the last: it is sent once more, and then given up.
      waiting.clear();
      expect(await busy({ deferrals: MAX_DEFERRALS - 1 })).toEqual({ outcome: 'deferred' });
      expect(waiting.of(REASON_QUEUE)[0]!.data).toMatchObject({ deferrals: MAX_DEFERRALS });
      waiting.clear();
      expect(await busy({ deferrals: MAX_DEFERRALS })).toEqual({ outcome: 'gave_up' });
      expect(waiting.sent).toEqual([]);
      expect((await audits())[0]).toMatchObject({ outcome: 'skipped', inputs: { series: KEY, run: runId, result: 'gave_up', deferrals: MAX_DEFERRALS } });
      const mark = await k.db.healthCheck.findFirstOrThrow({ where: { component: DEFERRAL_MARK } });
      expect(mark).toMatchObject({ status: 'degraded', detail: DEFERRAL_SAYS });
      expect(DEFERRAL_SAYS).toBe('Chat was busy for 10 minutes, so a forecast went without the local model’s second opinion.');
      // Settings > Health: Forecasts needs a look for an hour, in that sentence; then it is last night's run again.
      const home = mkdtempSync(join(tmpdir(), 'reason-health-'));
      const forecasts = async (now: Date) => (await checkComponents({ db: k.db, config: { home, triage: false, tz: TZ, predict: true }, now, sources: [] })).find((c) => c.component === 'forecasts');
      expect(await forecasts(new Date(NOW.getTime() + 60_000))).toEqual({ component: 'forecasts', status: 'degraded', detail: DEFERRAL_SAYS });
      expect(await forecasts(new Date(NOW.getTime() + HOUR + 60_000))).toMatchObject({ status: 'ok' });
      await nothingRecorded();
    });

    it('a number turned off while the model answers: the database refuses the write, and a card signed again restores it', async () => {
      await number(FLINT);
      await weeks(FLINT, Array.from({ length: 22 }, (_, i) => 3 + (i % 4) * 2));
      expect(await runForecasts({ db: k.db, tz: TZ, now: NOW })).toMatchObject({ ran: 1 });
      const rid = (await latestRun(FLINT))!;
      expect(await question(rid)).toMatchObject({ method: 'base_rate', status: 'open' });
      said.length = 0;
      const off = async () => void (await k.inTx((q) => q(`UPDATE "ForecastSeries" SET "on" = false, reason = false WHERE "seriesKey" = $1`, [FLINT]), { actor: 'will:console' }));
      expect(await reason(rid, { fetch: model([{ probability: 0.7, reasonCode: 'trend' }]), hooks: { beforeRecord: off } })).toEqual({ outcome: 'refused' });
      expect(await estimates(rid)).toEqual([]);
      expect(said).toHaveLength(1);
      expect(said[0]).toMatch(/^forecast: weekly\.commits\.flint\.count's second opinion was not recorded: \S/);
      expect(said[0]).not.toMatch(/0\.7|Series:|trend/);
      expect((await audits())[0]).toMatchObject({ outcome: 'failed', inputs: { series: FLINT, run: rid, result: 'refused', requests: 1 } });
      // Off, a job for its run finds nothing to ride on, and asks nothing.
      sent = [];
      expect(await reason(rid, { fetch: model([{ probability: 0.7, reasonCode: 'trend' }]) })).toEqual({ outcome: 'nothing' });
      expect(sent).toEqual([]);
      // On again without the Second Opinion: still nothing. With it, signed: the estimate rides on the forecaster's base-rate answer.
      await signOn([FLINT], []);
      expect(await reason(rid, { fetch: model([{ probability: 0.7, reasonCode: 'trend' }]) })).toEqual({ outcome: 'nothing' });
      await signOn([FLINT], [FLINT]);
      expect(await reason(rid, { fetch: model([{ probability: 0.7, reasonCode: 'trend' }]) })).toEqual({ outcome: 'recorded' });
      expect((await estimates(rid))[0]).toMatchObject({ method: 'model_reasoning', probability: 0.7, domain: 'repos', unit: 'count' });
      const user = sent[0]!.messages.find((m) => m.role === 'user')!.content;
      expect(user).toContain('Series: Flint Commits. Unit: a count. One value per week.');
      expect(user).toMatch(/Week of \d{4}-\d{2}-\d{2}: \d+\nQuestion: is the value for the week of \d{4}-\d{2}-\d{2} above /);
    });

    it('a write that fails after the model answered is a missed second opinion, not a failed job; run again and again: two requests and one slot of the cap that night', async () => {
      const claims = await counter(REASON_ACTION);
      await k.owner(`DELETE FROM "HealthCheck" WHERE component = $1`, [DEFERRAL_MARK]);
      said.length = 0;
      // (What the failure says of itself must go nowhere: only what kind of failure it was.)
      const broke = async () => { throw new Error('the write failed: 31.34 for Series: Perplexity Spend'); };
      // The write throws once the model has answered. The job does not fail for it: a failed job of this queue is
      // never run again, so it would only be a dead letter, and Health's Job Queue row would call the queue failing.
      expect(await reason(runId, { fetch: answers(), hooks: { beforeRecord: broke } })).toEqual({ outcome: 'failed' });
      expect([sent.length, await counter(REASON_ACTION)]).toEqual([1, claims + 1]);
      // Said by its class and the number's key, and nothing else.
      expect(said).toEqual([`forecast: ${KEY}'s second opinion was not saved: Error`]);
      expect((await audits())[0]).toMatchObject({ actor: 'runtime:reason', outcome: 'failed', reasoning: null, outcomeDetail: null, inputs: { series: KEY, run: runId, result: 'failed', requests: 1 } });
      expect(JSON.stringify((await audits())[0])).not.toMatch(/write failed|31\.34|Perplexity/);
      // Settings > Health says a forecast went without its second opinion, on Forecasts, for an hour.
      expect(await k.db.healthCheck.findMany({ where: { component: DEFERRAL_MARK }, select: { status: true, detail: true } })).toEqual([{ status: 'degraded', detail: MISSED_SAYS }]);
      expect(MISSED_SAYS).toBe('The local model’s second opinion couldn’t be saved, so a forecast went without it.');
      const home = mkdtempSync(join(tmpdir(), 'reason-missed-'));
      const forecasts = async (now: Date) => (await checkComponents({ db: k.db, config: { home, triage: false, tz: TZ, predict: true }, now, sources: [] })).find((c) => c.component === 'forecasts');
      expect(await forecasts(new Date(NOW.getTime() + 60_000))).toEqual({ component: 'forecasts', status: 'degraded', detail: MISSED_SAYS });
      expect(await forecasts(new Date(NOW.getTime() + HOUR + 60_000))).toMatchObject({ status: 'ok' });
      // Run again (a deploy that sends it again), it asks once more, with the slot it already has.
      expect(await reason(runId, { fetch: answers(), hooks: { beforeRecord: broke } })).toEqual({ outcome: 'failed' });
      expect([sent.length, await counter(REASON_ACTION)]).toEqual([2, claims + 1]);
      // A write the database itself refuses is still said as that (the test above), and anything thrown before the
      // model is asked is not this: only the write is caught.
      // A third and a fourth, with a write that would work: nothing is asked and nothing is claimed.
      expect(await reason(runId, { fetch: answers() })).toEqual({ outcome: 'spent' });
      expect(await reason(runId, { fetch: answers() })).toEqual({ outcome: 'spent' });
      expect([sent.length, await counter(REASON_ACTION)]).toEqual([2, claims + 1]);
      expect([await counter(requestsCounter(KEY)), await counter(claimedCounter(KEY))]).toEqual([2, 1]);
      expect((await audits())[0]).toMatchObject({ outcome: 'skipped', inputs: { series: KEY, run: runId, result: 'spent', requests: 0 } });
      // The counts are kept by the number's key: a name and a count, nothing of its values.
      expect(requestsCounter(KEY)).toBe(`ledger.reason.requests:${KEY}`);
      expect(claimedCounter(KEY)).toBe(`ledger.reason.claimed:${KEY}`);
      expect((await k.owner(`SELECT action, count FROM "ActionCounter" WHERE action LIKE 'ledger.reason.%:%' AND action LIKE $1 ORDER BY action`, [`%:${KEY}`])).rows).toEqual([
        { action: `ledger.reason.claimed:${KEY}`, count: 1 }, { action: `ledger.reason.requests:${KEY}`, count: 2 },
      ]);
      // Another number's night is its own: Deploys' estimate that night is not held back by this one's.
      expect(await counter(requestsCounter(DEPLOYS))).toBe(1);
      await nothingRecorded();
    });

    it('the queue itself never runs a failed estimate again: a real job is sent with no retries', async () => {
      const real = await startBus(urls.app, () => {});
      try {
        await k.owner(`DELETE FROM pgboss.job WHERE name = $1`, [REASON_QUEUE]);
        expect(await sendReasons({ db: k.db, bus: real, now: NOW })).toBeGreaterThan(0);
        // One that waits for chat is sent the same way.
        await runReason(deps({ bus: real, load: async () => 'defer', fetch: answers() }), { runId });
        const rows = (await k.owner(`SELECT retry_limit, data::text AS data FROM pgboss.job WHERE name = $1`, [REASON_QUEUE])).rows as Array<{ retry_limit: number; data: string }>;
        expect(rows.length).toBeGreaterThan(0);
        for (const r of rows) expect(r.retry_limit, r.data).toBe(0);
        // (And what a job holds is its run and a count.)
        for (const r of rows) expect(Object.keys(JSON.parse(r.data)).sort().join()).toMatch(/^(deferrals,)?runId$/);
      } finally {
        await k.owner(`DELETE FROM pgboss.job WHERE name = $1`, [REASON_QUEUE]);
        await real.stop();
      }
    });

    it('a second opinion’s job that fails, or is killed mid-run, is not a failed job on Health’s Job Queue row; another queue’s still is', async () => {
      const real = await startBus(urls.app, () => {});
      const home = mkdtempSync(join(tmpdir(), 'reason-queue-'));
      const queueRow = async () => (await checkComponents({ db: k.db, config: { home, triage: false, tz: TZ, predict: true }, now: new Date(), sources: [] })).find((c) => c.component === 'bus');
      const dead = async () => (await k.owner(`SELECT source_name, data::text AS data FROM pgboss.job WHERE name = 'dead' ORDER BY created_on`)).rows as Array<{ source_name: string | null; data: string }>;
      const until = async (ok: () => Promise<boolean>, ms = 25_000) => {
        const end = Date.now() + ms;
        while (!(await ok())) {
          if (Date.now() > end) throw new Error('timed out');
          await new Promise((r) => setTimeout(r, 200));
        }
      };
      try {
        await k.owner(`DELETE FROM pgboss.job WHERE name IN ($1, 'dead')`, [REASON_QUEUE]);
        expect(await queueRow()).toEqual({ component: 'bus', status: 'ok' });
        // A job whose handler throws: sent with no retries, it is a dead letter the first time.
        let ran = 0;
        const worker = await real.boss.work(REASON_QUEUE, { pollingIntervalSeconds: 0.5 }, async () => {
          ran += 1;
          throw new Error('boom');
        });
        expect(await real.boss.send(REASON_QUEUE, { runId: 'frfailed0001' }, { singletonKey: 'n1.failed', ...REASON_SEND })).toBeTruthy();
        await until(async () => (await dead()).length === 1);
        expect(ran).toBe(1);
        expect((await dead()).map((d) => [d.source_name, JSON.parse(d.data)])).toEqual([[REASON_QUEUE, { runId: 'frfailed0001' }]]);
        expect((await k.owner(`SELECT state, retry_count, retry_limit FROM pgboss.job WHERE name = $1`, [REASON_QUEUE])).rows).toEqual([{ state: 'failed', retry_count: 0, retry_limit: 0 }]);
        // One missed second opinion is not a failing queue.
        expect(await queueRow()).toEqual({ component: 'bus', status: 'ok' });
        await real.boss.offWork(REASON_QUEUE, { id: worker });
        // A job a runtime took and was killed with (never settled): its time runs out, and it is a dead letter too.
        expect(await real.boss.send(REASON_QUEUE, { runId: 'frkilled0001' }, { singletonKey: 'n1.killed', expireInSeconds: 1, ...REASON_SEND })).toBeTruthy();
        const [taken] = await real.boss.fetch(REASON_QUEUE);
        expect(taken).toBeTruthy();
        await new Promise((r) => setTimeout(r, 1_500));
        await real.boss.supervise(REASON_QUEUE);
        await until(async () => (await dead()).length === 2);
        expect((await dead()).map((d) => d.source_name)).toEqual([REASON_QUEUE, REASON_QUEUE]);
        expect(await queueRow()).toEqual({ component: 'bus', status: 'ok' });
        // Another queue's dead letter still counts, and is the only one counted.
        await real.boss.send('dead', { eventId: 'x' });
        await k.owner(`INSERT INTO pgboss.job (name, data, source_name) VALUES ('dead', '{"eventId":"y"}', 'triage')`);
        expect(await queueRow()).toEqual({ component: 'bus', status: 'degraded', detail: 'The queue had 2 failed jobs in the last day.' });
      } finally {
        await k.owner(`DELETE FROM pgboss.job WHERE name IN ($1, 'dead')`, [REASON_QUEUE]);
        await real.stop();
      }
    }, 90_000);

    it('a step that ends while the model answers: the second look is at the time of writing, and nothing is written', async () => {
      const over = new Date(dayStart(0).getTime() + DAY + 1);
      let t = NOW;
      const r = await reason(runId, { now: () => t, fetch: answers(), hooks: { answered: async () => void (t = over) } });
      expect(r).toEqual({ outcome: 'nothing' });
      // The model was asked (the step was open then), and what it said went nowhere.
      expect(sent).toHaveLength(1);
      expect((await audits())[0]).toMatchObject({ outcome: 'skipped', inputs: { series: KEY, run: runId, result: 'nothing', requests: 1 } });
      await nothingRecorded();
    });

    it('the second look comes before the write: a switch turned off, a question settled or an estimate written while the model answered', async () => {
      // The Second Opinion turned off (the number stays on) once the model has answered: the second look finds
      // nothing to ride on. The write is not tried, so there is no refusal to log.
      said.length = 0;
      const off = async () => void (await k.inTx((q) => q(`UPDATE "ForecastSeries" SET reason = false WHERE "seriesKey" = $1`, [KEY]), { actor: 'will:console' }));
      expect(await reason(runId, { fetch: answers(), hooks: { answered: off } })).toEqual({ outcome: 'nothing' });
      expect(sent).toHaveLength(1);
      expect(said).toEqual([]);
      await nothingRecorded();
      await signOn([KEY], [KEY]);

      // The forecaster's question is no longer open (settled, expired, void): nothing rides on it, before the
      // model is asked or after it answered.
      const q = await question(runId);
      const status = (to: string) => k.past('Prediction', ['Prediction_guard', 'Prediction_valid_update'], (run) => run(`UPDATE "Prediction" SET status = $2 WHERE id = $1`, [q.id, to]));
      await newNight(KEY);
      sent = [];
      for (const closed of ['void', 'expired', 'resolved']) {
        await status(closed);
        expect(await reason(runId, { fetch: answers() }), closed).toEqual({ outcome: 'nothing' });
        expect(sent, closed).toEqual([]);
        await status('open');
      }
      expect(await reason(runId, { fetch: answers(), hooks: { answered: async () => void (await status('void')) } })).toEqual({ outcome: 'nothing' });
      expect(sent).toHaveLength(1);
      await status('open');
      expect(await sendReasons({ db: k.db, bus: new FakeBus(), now: NOW })).toBeGreaterThan(0);
      await nothingRecorded();

      // Another job wrote this run's estimate while this one's model answered: one estimate, the first.
      const NEXUS = 'weekly.commits.nexus.count';
      await number(NEXUS);
      await weeks(NEXUS, Array.from({ length: 22 }, (_, i) => 4 + (i % 3) * 3));
      expect(await runForecasts({ db: k.db, tz: TZ, now: NOW })).toMatchObject({ ran: 1 });
      const twin = (await latestRun(NEXUS))!;
      sent = [];
      const other = async () => void expect(await reason(twin, { fetch: model([{ probability: 0.3, reasonCode: 'burst' }]) })).toEqual({ outcome: 'recorded' });
      expect(await reason(twin, { fetch: model([{ probability: 0.8, reasonCode: 'trend' }]), hooks: { answered: other } })).toEqual({ outcome: 'exists' });
      expect(sent).toHaveLength(2);
      expect((await estimates(twin)).map((e) => e.probability)).toEqual([0.3]);
      expect((await audits())[0]).toMatchObject({ outcome: 'skipped', inputs: { series: NEXUS, run: twin, result: 'exists', requests: 1 } });
    });

    it('a used-up daily cap, and a rule that forbids it: nothing is asked', async () => {
      const cap = { limit: 30, period: 'day' as const };
      while ((await claim(k.db, REASON_ACTION, cap, TZ, NOW)) !== null);
      expect(await reason(runId, { fetch: model([{ probability: 0.6, reasonCode: 'trend' }]) })).toEqual({ outcome: 'capped' });
      expect(sent).toEqual([]);
      expect((await audits())[0]).toMatchObject({ outcome: 'skipped', inputs: { result: 'capped', requests: 0 } });
      // A run that got no slot holds no mark of having one, and has asked nothing.
      expect([await counter(claimedCounter(KEY)), await counter(requestsCounter(KEY))]).toEqual([0, 0]);
      await nothingRecorded();
      await g.policy(REASON_ACTION, 'forbidden');
      // (The rule is in force from now: the estimate is asked for a moment later.)
      const later = () => new Date(Date.now() + 1_000);
      expect(await reason(runId, { now: later, fetch: model([{ probability: 0.6, reasonCode: 'trend' }]) })).toEqual({ outcome: 'skipped' });
      expect(sent).toEqual([]);
      expect((await audits())[0]).toMatchObject({ tier: 'forbidden', outcome: 'skipped', inputs: { result: 'skipped' } });
      await nothingRecorded();
    });
  });
});

describe.skipIf(NO_DB)('the night’s two requests are counted by Flint’s own day, not the hour, the week or the UTC date', () => {
  const CHICAGO = 'America/Chicago';
  let k: LedgerKit;
  afterAll(async () => {
    await k?.db.$disconnect();
  });

  it('two jobs the same local day in different hours, across the UTC date change: the second asks nothing; the next local day it is asked again', async () => {
    k = await ledgerKit(await freshDb());
    const start = (day: string) => localDayBounds(CHICAGO, day).start;
    const at = (day: string, hours: number, minutes: number) => new Date(start(day).getTime() + (hours * 60 + minutes) * 60_000);
    // Two local days that are over (the audit trail takes no entry dated ahead of now), both in one week.
    let day = addLocalDays(localDay(CHICAGO, new Date()), -3);
    while ([0, 6].includes(new Date(`${day}T12:00:00Z`).getUTCDay())) day = addLocalDays(day, -1);
    const next = addLocalDays(day, 1);
    const d = forecastSeries(DEPLOYS)!;
    await k.series({ key: d.key, unit: d.unit, freq: freqOf(d), sensitivity: d.sensitivity, description: d.description });
    await k.turnOn([DEPLOYS], [DEPLOYS]);
    // Sixty local days of a rising line, up to the first of the two days.
    for (let i = 0; i <= 60; i++) await k.point(DEPLOYS, start(addLocalDays(day, -i)), 10 + 2 * (60 - i));
    /** A night's run for `on` and the forecaster's question about that local day, as the runner leaves them: open until the day is over. */
    const night = async (on: string): Promise<string> => {
      const [from, end] = [start(on), start(addLocalDays(on, 1))];
      const run = await k.run(DEPLOYS, { beatsNaive: true, points: [{ at: from.toISOString(), mean: 130, lo: 124, hi: 136 }] });
      await k.question(DEPLOYS, from, 'above', 128, { probability: 0.6, forecastRunId: run, resolverSpec: { seriesKey: DEPLOYS, at: from.toISOString(), end: end.toISOString(), op: 'above', value: 128 } },
        { madeAgo: Date.now() - at(on, 3, 50).getTime(), dueAgo: Date.now() - end.getTime() - HOUR });
      return run;
    };
    const first = await night(day);

    let sent = 0;
    const unusable = (async () => {
      sent += 1;
      return new Response(JSON.stringify({ model: 'm', message: { role: 'assistant', content: JSON.stringify({ probability: 0.99, reasonCode: 'trend' }) }, done: true, done_reason: 'stop', prompt_eval_count: 10, eval_count: 5 }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const job = (runId: string, now: Date) => runReason({ db: k.db, bus: new FakeBus(), config: { tz: CHICAGO, ollama: OLLAMA }, load: async () => 'proceed', now: () => now, fetch: unusable }, { runId });

    // 5:30 in the afternoon and 7:30 in the evening: one local day, two hours, and two UTC dates.
    const [early, late] = [at(day, 17, 30), at(day, 19, 30)];
    expect([localDay(CHICAGO, early), localDay(CHICAGO, late)]).toEqual([day, day]);
    expect(early.toISOString().slice(0, 10)).not.toBe(late.toISOString().slice(0, 10));
    expect(early.toISOString().slice(0, 13)).not.toBe(late.toISOString().slice(0, 13));
    // The first job makes the night's two requests (neither answer can be used).
    expect(await job(first, early)).toEqual({ outcome: 'invalid' });
    expect(sent).toBe(2);
    // The second, two hours and a UTC date later, the same local day: nothing is asked.
    expect(await job(first, late)).toEqual({ outcome: 'spent' });
    expect(sent).toBe(2);

    // The next local day (the same week): that night's forecast, and it is asked again. Twice, and then no more.
    const second = await night(next);
    expect(await job(second, at(next, 4, 0))).toEqual({ outcome: 'invalid' });
    expect(sent).toBe(4);
    expect(await job(second, at(next, 23, 0))).toEqual({ outcome: 'spent' });
    expect(sent).toBe(4);
    // What the database holds: two requests and one slot for the number on each of the two local days.
    const counted = (await k.owner(`SELECT action, day, count FROM "ActionCounter" WHERE action LIKE 'ledger.reason.%' ORDER BY action, day`)).rows;
    expect(counted).toEqual([
      { action: claimedCounter(DEPLOYS), day, count: 1 }, { action: claimedCounter(DEPLOYS), day: next, count: 1 },
      { action: REASON_ACTION, day, count: 1 }, { action: REASON_ACTION, day: next, count: 1 },
      { action: requestsCounter(DEPLOYS), day, count: 2 }, { action: requestsCounter(DEPLOYS), day: next, count: 2 },
    ]);
  }, 120_000);
});

describe.skipIf(NO_DB)('the second opinion is settled like any other prediction, and kept out of an area’s own scores', () => {
  let urls: TestUrls;
  let k: LedgerKit;
  const NOW = new Date();
  const dayStart = (daysAgo: number) => kitDayStart(daysAgo, NOW);

  beforeAll(async () => {
    urls = await freshDb();
    k = await ledgerKit(urls);
  });
  afterAll(async () => {
    await k?.db.$disconnect();
  });

  it('the sweep settles it by the same rule as the forecaster’s answer, and the night’s scores for the area do not count it', async () => {
    const d = forecastSeries(DEPLOYS)!;
    await k.series({ key: d.key, unit: d.unit, freq: freqOf(d), sensitivity: d.sensitivity, description: d.description });
    await k.turnOn([DEPLOYS], [DEPLOYS]);
    // Yesterday's question, as the runner and the estimate's job leave it: one run, the forecaster's answer and the
    // local model's beside it, the same rule on both. Made yesterday morning, due a minute ago.
    const at = dayStart(1);
    const rid = await k.run(DEPLOYS, { points: [{ at: at.toISOString(), mean: 104, lo: 96, hi: 112 }] });
    const made = { madeAgo: Date.now() - at.getTime() - 4 * HOUR, dueAgo: 60_000 };
    const mine = await k.question(DEPLOYS, at, 'above', 100, { probability: 0.55, forecastRunId: rid }, made);
    const models = await k.question(DEPLOYS, at, 'above', 100, { probability: 0.7, method: 'model_reasoning', createdBy: 'runtime:reason', model: 'ollama:muse-glimmer:30b', forecastRunId: rid }, made);
    // Yesterday's number comes in above the threshold.
    await k.point(DEPLOYS, at, 105);
    const swept = await sweep(k.db, { tz: TZ, resolve: true, expire: true });
    expect(swept).toMatchObject({ refused: 0, unknownSpec: 0 });
    for (const pid of [mine, models]) {
      expect(await k.status(pid), pid).toBe('resolved');
      expect(await k.resolution(pid), pid).toMatchObject({ outcome: true, resolvedBy: 'auto_metric' });
    }
    // Each has its own score, by the same sum.
    expect((await k.resolution(mine))!.brier).toBeCloseTo((0.55 - 1) ** 2, 10);
    expect((await k.resolution(models))!.brier).toBeCloseTo((0.7 - 1) ** 2, 10);
    // The night's scores for the area count the forecaster's answer and not the model's second answer to the same
    // question: one question, one row. (The two are compared question by question in the panel: p4-opinion-db.)
    const end = new Date(Date.now() + 60_000);
    await snapshotCalibration(k.db, new Date(end.getTime() - 90 * DAY), end, TZ);
    const scores = (await k.owner(`SELECT method, kind, n, brier FROM "CalibrationSnapshot" WHERE domain = 'deploys' AND type = 'threshold_cross' ORDER BY method`)).rows;
    expect(scores).toEqual([{ method: 'statistical', kind: 'binary', n: 1, brier: expect.closeTo((0.55 - 1) ** 2, 10) }]);
    expect((await k.owner(`SELECT count(*)::int AS n FROM "CalibrationSnapshot" WHERE method = 'model_reasoning'`)).rows[0].n).toBe(0);
    // Where the Second Opinion is not signed, the database takes no such row, whoever writes it.
    const plain = forecastSeries(OPENAI)!;
    await k.series({ key: plain.key, unit: plain.unit, freq: freqOf(plain), sensitivity: plain.sensitivity, description: plain.description });
    await k.turnOn([OPENAI]);
    const other = await k.run(OPENAI, { points: [{ at: at.toISOString(), mean: 4, lo: 2, hi: 6 }] });
    expect(await k.code(k.question(OPENAI, at, 'above', 3, { probability: 0.7, method: 'model_reasoning', createdBy: 'runtime:reason', forecastRunId: other }, made))).toBe('42501');
  });
});
