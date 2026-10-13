/**
 * The Predictions panel's routes on flint_test (P4 part 4), through buildApp
 * and Fastify's inject, as the server's proxy calls them.
 *
 *  - Before anything is turned on the page says so, lists every number with
 *    what it is, and reads none of them. Switched off on this Mac, it says
 *    that, and nothing can be turned on from the console.
 *  - Turn On Predictions files the same card the command files, once: Will's
 *    own, marked for his own touch, as sensitive as its most sensitive number.
 *    A newer one replaces an older one still waiting. Filing turns nothing on.
 *    Signed, it turns on exactly the numbers it lists.
 *  - Each number says where it stands in a sentence made from its own run: a
 *    range, no reliable trend, steady, waiting, not enough history, no data,
 *    tonight, failed, off. A state with no number shows none.
 *  - One number, open: every step of its forecast, its yes/no chance, and how
 *    its ranges have held.
 *  - Turning a number off needs no signature, is audited by its key, and is
 *    said to be off afterwards; a second time is refused in a sentence.
 *  - Will's answer to a question records the result as his, once, with the
 *    prediction's own resolve time; Skip records none. The database refuses a
 *    result recorded as his without his answer.
 *  - How Flint has done, from the night's scores: counts and shares in
 *    sentences, with "not enough results yet" below thirty.
 *  - No log line holds a number's value or a prediction's words.
 * Synthetic numbers and words; Flint's zone is UTC here.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { AccuracyView, FORECAST_REASONS, PredictionsPage, PredictionsWaiting, QuestionsPage, SeriesAnswer, digestOf, localDay, noteProblems, type ForecastRow } from '@flint/policy';
import { NO_DB, freshDb, id, type TestUrls } from './db';
import { CANARY, DAY, HOUR, MIN, TZ, dayStart, ledgerKit, type LedgerKit } from './ledger/kit';
import { enrollTestKey } from './sign';
import { buildApp } from '../src/app';
import type { RuntimeScope } from '../src/config';
import { approveProposal } from '../src/governance/proposals';
import { runInternal } from '../src/governance/internal';
import { sweep } from '../src/ledger/sweep';
import { TURN_OFF_ACTION, proposeForecasts } from '../src/predict/enable';
import { weekOf } from '../src/predict/metrics';
import { PANEL, aboutValue, dayWords, expectSays, noTrendSays, stepLabel, stepRangeSays } from '../src/predict/phrasing';
import { ANSWER_ACTION, askQuestions } from '../src/predict/questions';
import { runForecasts } from '../src/predict/run';
import { FORECAST_SERIES } from '../src/predict/series';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const SERVER = 'server-token-0123456789abcdef';
const tokens = [{ name: 'server', sha256: sha(SERVER), scopes: new Set<RuntimeScope>(['events', 'audit', 'proposals', 'world:read', 'ledger', 'counters']) }];
const WORDS = 'CANARY-claim-words';

const ANTHROPIC = 'daily.spend.anthropic.usd';
const OPENAI = 'daily.spend.openai.usd';
const PERPLEXITY = 'daily.spend.perplexity.usd';
const TAVILY = 'daily.spend.tavily.usd';
const DEPLOYS = 'daily.deploys.count';
const FLINT = 'weekly.commits.flint.count';
const NEXUS = 'weekly.commits.nexus.count';
const TRIDENT = 'weekly.commits.trident.count';
const HELM = 'weekly.commits.helm.count';
const DOWNTIME = 'daily.services.incident_minutes';
const THREADS = 'daily.threads.open';
const CALENDAR = 'daily.calendar.hours';
const ON = [ANTHROPIC, OPENAI, PERPLEXITY, TAVILY, DEPLOYS, FLINT, TRIDENT, DOWNTIME, THREADS, CALENDAR];

describe.skipIf(NO_DB)('the Predictions panel\'s routes on flint_test', () => {
  let urls: TestUrls;
  let k: LedgerKit;
  let key: Awaited<ReturnType<typeof enrollTestKey>>;
  let app: ReturnType<typeof buildApp>;
  let offHere: ReturnType<typeof buildApp>;
  const lines: string[] = [];
  /** One clock for the forecasts' day, read once. */
  const NOW = new Date();
  const start = (daysAgo: number) => dayStart(daysAgo, NOW);

  const call = async (method: 'GET' | 'POST', url: string, body?: unknown, on = app) => {
    const r = await on.inject({ method, url, headers: { authorization: `Bearer ${SERVER}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { payload: JSON.stringify(body) } : {}) });
    return { status: r.statusCode, body: JSON.parse(r.body) as Record<string, unknown> };
  };
  const page = async (on = app) => PredictionsPage.parse((await call('GET', '/v1/predictions', undefined, on)).body);
  const series = async (seriesKey: string, on = app) => SeriesAnswer.parse((await call('GET', `/v1/predictions/series/${seriesKey}`, undefined, on)).body).series;
  const rowOf = (p: { numbers: ForecastRow[] }, seriesKey: string) => p.numbers.find((n) => n.key === seriesKey)!;
  const cards = async () => (await k.owner(`SELECT id, status, origin, kind, args, "argsDigest", sensitivity, consequential, tainted, reason, error, "createdAt", "expiresAt" FROM "Proposal" WHERE action = 'forecast.series.enable' ORDER BY "createdAt", id`)).rows;
  const sign = async (pid: string) => {
    const p = await k.db.proposal.findUniqueOrThrow({ where: { id: pid } });
    await approveProposal(k.db, p.id, await key.approve({ subjectId: p.id, action: p.action, argsDigest: p.argsDigest }), undefined, 'test');
    return runInternal(k.db, p.id, undefined, TZ, 'test');
  };
  const audits = async (action: string) => (await k.owner(`SELECT actor, context, kind, action, outcome, inputs, reasoning, "outcomeDetail", "correlationId", tainted FROM "AuditEntry" WHERE action = $1 ORDER BY seq`, [action])).rows;
  /** Daily values ending `endAgo` days ago (1: yesterday), oldest first. */
  const days = async (seriesKey: string, values: number[], endAgo = 1) => {
    for (const [i, v] of values.entries()) await k.point(seriesKey, start(endAgo + values.length - 1 - i), v);
  };
  const monday = () => new Date(`${weekOf(localDay(TZ, NOW))}T00:00:00.000Z`);
  /** Weekly values for the weeks before this one (the last is last week's), oldest first. */
  const weeks = async (seriesKey: string, values: number[]) => {
    for (const [i, v] of values.entries()) await k.point(seriesKey, new Date(monday().getTime() - (values.length - i) * 7 * DAY), v);
  };
  const line = (n: number) => Array.from({ length: n }, (_, i) => 10 + 2 * i);
  const week = [5, 5, 5, 5, 5, 0, 0];
  const dollars = Array.from({ length: 30 }, (_, i) => Math.round((CANARY / 1000 + i * 0.37) * 100) / 100);
  const firstStep = async (seriesKey: string) => {
    const r = (await k.owner(`SELECT level, "beatsNaive", points FROM "ForecastRun" WHERE "seriesKey" = $1 AND ok AND points->0->>'at' = $2 ORDER BY "createdAt" DESC LIMIT 1`, [seriesKey, start(0).toISOString()])).rows[0] as
      { level: number; beatsNaive: boolean | null; points: Array<{ at: string; mean: number; lo: number; hi: number }> };
    return r;
  };
  /** Every sentence and value on a row is fit for Will. */
  const plain = (r: { name: string; value: string; says: string; about?: string }) => {
    for (const s of [r.says, ...(r.about ? [r.about] : [])]) {
      expect(noteProblems('Predictions', s), s).toEqual([]);
      expect(s, s).not.toMatch(/daily\.|weekly\.|\busd\b|incident_minutes|[()]|NaN|undefined|null/);
    }
    for (const w of [r.name, r.value]) expect(w, w).not.toMatch(/daily\.|weekly\.|_|[()]|NaN|undefined|null/);
  };

  beforeAll(async () => {
    urls = await freshDb();
    k = await ledgerKit(urls);
    key = await enrollTestKey(urls);
    const logStream = { write: (l: string) => void lines.push(l) };
    app = buildApp({ db: k.db, config: { tokens, tz: TZ, predict: true }, logger: true, logStream });
    offHere = buildApp({ db: k.db, config: { tokens, tz: TZ, predict: false }, logger: true, logStream });
  });
  afterAll(async () => {
    await app?.close();
    await offHere?.close();
    await k?.db.$disconnect();
  });

  it('before anything is turned on: the page says off, lists every number with what it is, and shows no value', async () => {
    const p = await page();
    expect(p).toMatchObject({ state: 'off', waiting: [], questions: 0, announce: false });
    expect(p.numbers.map((n) => [n.key, n.name, n.step])).toEqual(FORECAST_SERIES.map((d) => [d.key, d.name, d.step]));
    for (const n of p.numbers) {
      expect(n).toMatchObject({ on: false, state: 'off', value: 'Off', says: 'Forecasts for this number are off.' });
      plain(n);
    }
    expect(rowOf(p, ANTHROPIC).about).toBe('This is what Flint spends with Anthropic each day.');
    expect(rowOf(p, DEPLOYS).about).toBe('This is how many times Flint is deployed each day.');
    expect(rowOf(p, FLINT).about).toBe('This is how many commits land in Flint each week.');
    expect(rowOf(p, DOWNTIME).about).toBe('This is how many minutes a service was down each day.');
    expect(rowOf(p, CALENDAR).about).toBe('This is how many hours of events are on the calendar each day.');
    // Switched off on this Mac: the page says that instead.
    expect((await page(offHere)).state).toBe('off_here');
    expect(AccuracyView.parse((await call('GET', '/v1/predictions/accuracy')).body)).toEqual({ scored: false, areas: [], unsettled: [] });
    // What the console asks on load: two facts, whatever the Mac's switch says.
    for (const on of [app, offHere]) expect(PredictionsWaiting.parse((await call('GET', '/v1/predictions/waiting', undefined, on)).body)).toEqual({ questions: 0, announce: false });
    expect(QuestionsPage.parse((await call('GET', '/v1/predictions/questions')).body)).toEqual({ waiting: [], answered: [] });
  });

  it('Turn On Predictions files the same card the command files, once; a newer one replaces it; filing turns nothing on', async () => {
    const first = await call('POST', '/v1/predictions/turn-on', { series: [DEPLOYS, CALENDAR, DEPLOYS] });
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ id: expect.stringMatching(/^[A-Za-z0-9_-]{1,40}$/) as unknown, deduped: false });
    const args = { series: [CALENDAR, DEPLOYS], reason: [] };
    const [card] = await cards();
    // Will's own card, from the console: marked for his own touch, as sensitive as its most sensitive number, with the
    // fixed reason, and exactly the args the console signs (sorted, no repeats).
    expect(card).toMatchObject({
      id: first.body.id, status: 'pending', origin: 'console', kind: 'tool_call', args, argsDigest: digestOf(args), sensitivity: 'personal', consequential: true, tainted: false, reason: FORECAST_REASONS.enable,
    });
    const life = (card!.expiresAt as Date).getTime() - (card!.createdAt as Date).getTime();
    expect(life).toBeGreaterThan(7 * DAY - MIN);
    expect(life).toBeLessThanOrEqual(7 * DAY + 1000);
    // The command's card for the same numbers is the same card: the same args, the same digest.
    const fromCli = await proposeForecasts(k.db, [DEPLOYS, CALENDAR]);
    expect(fromCli).toMatchObject({ id: first.body.id, deduped: true });
    // Asked again from the console, it is the one already waiting.
    expect((await call('POST', '/v1/predictions/turn-on', { series: [CALENDAR, DEPLOYS] })).body).toEqual({ id: first.body.id, deduped: true });
    expect(await cards()).toHaveLength(1);
    // Filing turns nothing on and makes no series; the page says a card waits, with how many numbers it names.
    expect(await k.db.forecastSeries.count()).toBe(0);
    expect(await k.db.metricSeries.count({ where: { key: { in: [DEPLOYS, CALENDAR] } } })).toBe(0);
    expect(await page()).toMatchObject({ state: 'off', waiting: [{ id: first.body.id, numbers: 2 }] });
    expect((await series(DEPLOYS)).waiting).toBe(true);
    expect((await series(TAVILY)).waiting).toBe(false);

    // A newer card (other numbers) replaces the one still waiting: that one can no longer be approved.
    const second = await call('POST', '/v1/predictions/turn-on', { series: ON });
    expect(second.body).toMatchObject({ deduped: false });
    expect(second.body.id).not.toBe(first.body.id);
    const after = await cards();
    expect(after.map((c) => [c.id, c.status])).toEqual([[first.body.id, 'rejected'], [second.body.id, 'pending']]);
    expect(after[0]!.error).toBe('A newer version of this card replaced it.');
    // Spend is on it: a financial card.
    expect(after[1]).toMatchObject({ sensitivity: 'financial', consequential: true, origin: 'console', args: { series: [...ON].sort(), reason: [] } });
    expect((await page()).waiting).toEqual([{ id: second.body.id, numbers: ON.length }]);

    // What cannot be a card is refused in a sentence with its code, and files nothing.
    const unknown = await call('POST', '/v1/predictions/turn-on', { series: ['daily.spend.acme.usd'] });
    expect([unknown.status, unknown.body]).toEqual([400, { error: 'That number can’t be forecast.', code: 'unknown' }]);
    // And not at all while predictions are switched off on this Mac.
    const off = await call('POST', '/v1/predictions/turn-on', { series: [DEPLOYS] }, offHere);
    expect([off.status, off.body]).toEqual([409, { error: 'Predictions are switched off on this Mac.', code: 'offHere' }]);
    expect(await cards()).toHaveLength(2);
  });

  it('signed, the card turns on exactly the numbers it lists; asked for again, there is nothing to sign', async () => {
    const [, card] = await cards();
    expect(await sign(card!.id as string)).toEqual({ on: ON.length, reason: 0 });
    expect((await k.db.forecastSeries.findMany({ where: { on: true }, select: { seriesKey: true } })).map((s) => s.seriesKey).sort()).toEqual([...ON].sort());
    const p = await page();
    expect(p).toMatchObject({ state: 'on', waiting: [] });
    expect(p.numbers.filter((n) => n.on).map((n) => n.key).sort()).toEqual([...ON].sort());
    for (const off of [NEXUS, HELM]) expect(rowOf(p, off)).toMatchObject({ on: false, state: 'off', value: 'Off' });
    // Nothing kept for any of them yet: each says so, and shows no number.
    for (const on of ON) expect(rowOf(p, on)).toMatchObject({ on: true, state: 'no_data', value: 'No Data', says: 'This number has no data yet.' });
    const again = await call('POST', '/v1/predictions/turn-on', { series: ON });
    expect([again.status, again.body]).toEqual([400, { error: 'It changes nothing.', code: 'nothing' }]);
    // Switched off on this Mac, the same numbers read as off: nothing is forecast there.
    const here = await page(offHere);
    expect(here.state).toBe('off_here');
    for (const n of here.numbers) expect(n).toMatchObject({ on: false, state: 'off' });
  });

  it('each number says where it stands, in a sentence made from its own run; a state with no number shows none', async () => {
    // A rising line, 60 days of it: a forecast that beats a plain guess.
    await days(DEPLOYS, line(60));
    // A pure weekly pattern: no model beats "the same day last week".
    await days(CALENDAR, Array.from({ length: 56 }, (_, i) => week[i % 7]!));
    // Thirty days of dollars: too short for a model to be believed.
    await days(ANTHROPIC, dollars);
    // A number that has not changed in a month.
    await days(THREADS, Array.from({ length: 30 }, () => 7));
    // Ten days: not enough history.
    await days(DOWNTIME, line(10));
    // Thirty days, but yesterday's number is not in.
    await days(OPENAI, line(30), 2);
    // Twenty whole weeks before this one.
    await weeks(FLINT, Array.from({ length: 20 }, (_, i) => 3 + (i % 4)));
    const c = await runForecasts({ db: k.db, tz: TZ, now: NOW });
    expect(c).toMatchObject({ on: ON.length, ran: 4, steady: 1, failed: 0, refused: 0 });
    // After the night's run: thirty days of a number arrive (forecast tonight), and one number's forecast failed.
    await days(PERPLEXITY, dollars.map((d) => d + 1));
    await k.run(TRIDENT, k.failedRun('forecast_failed'));

    const p = await page();
    expect(p.state).toBe('on');
    for (const n of p.numbers) plain(n);
    expect(p.numbers.map((n) => [n.key, n.state, n.value])).toEqual([
      [ANTHROPIC, 'no_trend', 'No Trend'],
      [OPENAI, 'waiting', 'Waiting'],
      [PERPLEXITY, 'tonight', 'Tonight'],
      [TAVILY, 'no_data', 'No Data'],
      [DEPLOYS, 'range', 'About 130'],
      [FLINT, 'no_trend', 'No Trend'],
      [NEXUS, 'off', 'Off'],
      [TRIDENT, 'failed', 'Failed'],
      [HELM, 'off', 'Off'],
      [DOWNTIME, 'short', 'Not Enough History'],
      [THREADS, 'steady', 'Steady'],
      [CALENDAR, 'no_trend', 'No Trend'],
    ]);
    // A forecast says its own run's first step, in the number's unit.
    const d = await firstStep(DEPLOYS);
    expect(d.beatsNaive).toBe(true);
    expect(d.points[0]!.mean).toBe(130);
    expect(rowOf(p, DEPLOYS).says).toBe(expectSays({ point: 130, lower: d.points[0]!.lo, upper: d.points[0]!.hi, level: 0.8, unit: 'count' }));
    expect(rowOf(p, DEPLOYS).says).toMatch(/^Flint expects about 130, with an 80% range of \d+ to \d+\.$/);
    // No reliable trend: a plain guess's range in dollars or hours, and no middle.
    const a = await firstStep(ANTHROPIC);
    expect(a.beatsNaive).not.toBe(true);
    expect(rowOf(p, ANTHROPIC).says).toBe(noTrendSays({ lower: a.points[0]!.lo, upper: a.points[0]!.hi, level: 0.8, unit: 'usd' }));
    expect(rowOf(p, ANTHROPIC).says).toMatch(/^There’s no reliable trend, and a plain guess gives an 80% range of \$\d+\.\d\d to \$\d+\.\d\d\.$/);
    expect(rowOf(p, CALENDAR).says).toMatch(/^There’s no reliable trend, and a plain guess gives an 80% range of [\d.]+ to [\d.]+ hours\.$/);
    expect(rowOf(p, FLINT).says).toMatch(/^There’s no reliable trend, and a plain guess gives an 80% range of \d+ to \d+\.$/);
    for (const seriesKey of [ANTHROPIC, CALENDAR, FLINT]) expect(rowOf(p, seriesKey).says).not.toMatch(/about|expects/);
    // The states with no number say why, and carry no value of the series.
    expect(rowOf(p, OPENAI).says).toBe('Yesterday’s number isn’t in yet, so there’s no forecast for today.');
    expect(rowOf(p, DOWNTIME).says).toBe('Flint needs 24 days of history. It has 10.');
    expect(rowOf(p, THREADS).says).toBe('This number hasn’t changed in 28 days.');
    expect(rowOf(p, TAVILY).says).toBe('This number has no data yet.');
    expect(rowOf(p, PERPLEXITY).says).toBe('Flint makes its next forecast tonight.');
    expect(rowOf(p, TRIDENT).says).toBe('Flint couldn’t forecast this number last night.');
    for (const seriesKey of [OPENAI, THREADS, TAVILY, PERPLEXITY, TRIDENT]) expect(rowOf(p, seriesKey).says.replace('28', ''), seriesKey).not.toMatch(/\d|\$|%/);
  });

  it('one number, open: every step of its forecast, its yes/no chance, and how its ranges have held', async () => {
    const d = await firstStep(DEPLOYS);
    const open = await series(DEPLOYS);
    expect(open.number).toEqual(rowOf(await page(), DEPLOYS));
    expect(open).toMatchObject({ waiting: false, offHere: false, record: 'Flint has no results for this number yet.' });
    // Each step the run holds, the first named for today and the rest by their day.
    expect(open.forecast).toHaveLength(Math.min(8, d.points.length));
    expect(open.forecast.length).toBeGreaterThan(1);
    expect(open.forecast.map((f) => f.label)).toEqual(d.points.slice(0, 8).map((pt, i) => (i === 0 ? 'Today' : stepLabel(new Date(pt.at), TZ, 'day'))));
    open.forecast.forEach((f, i) => {
      const pt = d.points[i]!;
      expect(f.value).toBe(aboutValue(pt.mean, 'count'));
      expect(f.says).toBe(stepRangeSays({ lower: pt.lo, upper: pt.hi, level: 0.8, unit: 'count' }, true));
      plain({ name: f.label, value: f.value, says: f.says });
    });
    // The run's yes/no question, in the ledger's own words.
    const q = (await k.owner(`SELECT probability, "resolverSpec"->>'value' AS value FROM "Prediction" WHERE "seriesKey" = $1 AND kind = 'binary' AND "createdBy" = 'runtime:forecast' ORDER BY "createdAt" DESC LIMIT 1`, [DEPLOYS])).rows[0] as { probability: number; value: string };
    expect(open.chance).not.toBeNull();
    expect(open.chance!.label).toBe(`Above ${Number(q.value)}`);
    expect(open.chance!.value).toMatch(new RegExp(`^(Very Unlikely|Unlikely|Somewhat Unlikely|About Even|Somewhat Likely|Likely|Very Likely) · ${Math.round(q.probability * 100)}%$`));
    expect(open.chance!.says).toMatch(new RegExp(`^It’s (very unlikely|unlikely|somewhat unlikely|about even|somewhat likely|likely|very likely), around ${Math.round(q.probability * 100)}%, that today runs above ${Number(q.value)}\\.$`));
    plain({ name: open.chance!.label, value: open.chance!.value, says: open.chance!.says });

    // No reliable trend: each step is a plain guess's range, and the steps name no middle.
    const hours = await series(CALENDAR);
    expect(hours.forecast.length).toBeGreaterThan(0);
    for (const f of hours.forecast) {
      expect(f.value).toBe('No Trend');
      expect(f.says).toMatch(/^A plain guess gives an 80% range of [\d.]+ to [\d.]+ hours\.$/);
    }
    // A weekly number's first step is this week.
    expect((await series(FLINT)).forecast[0]!.label).toBe('This Week');
    // A state with no forecast has no steps and no chance.
    for (const seriesKey of [OPENAI, DOWNTIME, THREADS, TAVILY, PERPLEXITY, TRIDENT, NEXUS]) expect(await series(seriesKey), seriesKey).toMatchObject({ forecast: [], chance: null });

    // Three of its earlier ranges, settled by the sweep against the numbers kept: two held.
    const earlier = (daysAgo: number, mean: number, lo: number, hi: number) =>
      k.range(DEPLOYS, start(daysAgo), { pointEstimate: mean, lower: lo, upper: hi }, { madeAgo: (daysAgo + 1) * DAY, dueAgo: (daysAgo - 1) * DAY }, { points: [{ at: start(daysAgo).toISOString(), mean, lo, hi }] });
    await earlier(3, 125, 120, 130);
    await earlier(4, 1, 0, 2);
    await earlier(5, 150, 100, 200);
    const swept = await sweep(k.db, { tz: TZ, resolve: true, expire: true });
    expect(swept.resolved).toBeGreaterThanOrEqual(3);
    expect((await series(DEPLOYS)).record).toBe('2 of its last 3 ranges held.');
  });

  it('turning a number off needs no signature, is audited by its key, and says so afterwards; a second time is refused in a sentence', async () => {
    const before = await k.db.proposal.count();
    const off = await call('POST', `/v1/predictions/series/${DEPLOYS}/turn-off`, {});
    expect([off.status, off.body]).toEqual([200, { ok: true }]);
    expect(await k.db.proposal.count()).toBe(before);
    expect(await k.db.forecastSeries.findUniqueOrThrow({ where: { seriesKey: DEPLOYS } })).toMatchObject({ on: false, reason: false });
    // One audit entry, by the number's key and nothing else; and the row's own history says who.
    expect(await audits(TURN_OFF_ACTION)).toEqual([
      { actor: 'will:console', context: 'console', kind: 'action', action: TURN_OFF_ACTION, outcome: 'ok', inputs: { series: DEPLOYS }, reasoning: null, outcomeDetail: null, correlationId: `${DEPLOYS}.off`, tainted: false },
    ]);
    const change = (await k.owner(`SELECT actor, changed FROM "RowChange" WHERE "tableName" = 'ForecastSeries' AND "rowId" = $1 ORDER BY at DESC LIMIT 1`, [DEPLOYS])).rows[0];
    expect(change).toMatchObject({ actor: 'will:console', changed: { on: [true, false] } });
    // Off: its row and its open view say so, with no forecast; what it already predicted stays on record.
    expect(rowOf(await page(), DEPLOYS)).toMatchObject({ on: false, state: 'off', value: 'Off', says: 'Forecasts for this number are off.' });
    expect(await series(DEPLOYS)).toMatchObject({ forecast: [], chance: null, record: '2 of its last 3 ranges held.' });
    const again = await call('POST', `/v1/predictions/series/${DEPLOYS}/turn-off`, {});
    expect([again.status, again.body]).toEqual([409, { error: 'Forecasts for this number are already off.', code: 'alreadyOff' }]);
    const never = await call('POST', `/v1/predictions/series/${NEXUS}/turn-off`, {});
    expect([never.status, never.body]).toEqual([409, { error: 'Forecasts for this number are already off.', code: 'alreadyOff' }]);
    expect(await audits(TURN_OFF_ACTION)).toHaveLength(1);
    // Turning it on again takes the card: nothing unsigned can.
    expect(await k.code(k.app(`UPDATE "ForecastSeries" SET "on" = true WHERE "seriesKey" = $1`, [DEPLOYS]))).toBe('42501');
    const back = await call('POST', '/v1/predictions/turn-on', { series: [DEPLOYS] });
    expect(back.body).toMatchObject({ deduped: false });
    expect(await sign(back.body.id as string)).toEqual({ on: 1, reason: 0 });
    expect(rowOf(await page(), DEPLOYS)).toMatchObject({ on: true, state: 'range' });
  });

  it('an answer records the result as Will\'s, once, as of the prediction\'s own resolve time; Skip records none', async () => {
    const wills = (dueAgo: number, over: Record<string, unknown> = {}) =>
      k.prediction({ method: 'model_reasoning', resolver: 'will', createdBy: 'client:server', domain: 'projects', probability: 0.7, ...over }, { madeAgo: dueAgo + 9 * DAY, dueAgo });
    const service = await k.service(k.serviceKey(), { running: true, disabled: false }, new Date(Date.now() - 6 * HOUR));
    const serviceName = (await k.db.entity.findUniqueOrThrow({ where: { id: service } })).name;
    const own = await wills(5 * HOUR, { claim: `${WORDS} lands by Friday` });
    // Made from outside text: a fixed template around an item's ref, or a number's key. Never free words.
    const healthy = await wills(4 * HOUR, { tainted: true, probability: 0.4, claim: `service#${service.slice(-6)} reports healthy at the resolve time` });
    const above = await wills(3 * HOUR, { tainted: true, probability: 0.2, claim: `${DEPLOYS} is above 4 at the resolve time` });
    const gone = await wills(2 * HOUR, { tainted: true, claim: 'service#zzzzzz reports healthy at the resolve time' });
    // A template chat chose on its own (no outside text) is said the same way: a ref or a key never reaches the screen.
    const closed = await wills(HOUR, { tainted: false, probability: 0.9, claim: `service#${service.slice(-6)} is closed by the resolve time` });
    expect(await askQuestions(k.db, { tz: TZ })).toMatchObject({ asked: 5, shadow: true });

    const made = (pid: string) => k.db.prediction.findUniqueOrThrow({ where: { id: pid }, select: { createdAt: true, resolveBy: true } });
    const before = QuestionsPage.parse((await call('GET', '/v1/predictions/questions')).body);
    expect(before.answered).toEqual([]);
    const now = new Date();
    // Oldest first. Each says what Flint said and when; one made from outside text is said around the item's own name.
    expect(before.waiting).toEqual([
      { id: own, title: `${WORDS} lands by Friday`, says: `Flint said likely, around 70%, on ${dayWords((await made(own)).createdAt, TZ, now)}.`, answer: null },
      { id: healthy, title: `${serviceName} reports healthy.`, says: `Flint said somewhat unlikely, around 40%, on ${dayWords((await made(healthy)).createdAt, TZ, now)}.`, answer: null },
      { id: above, title: 'Deploys is above 4.', says: `Flint said unlikely, around 20%, on ${dayWords((await made(above)).createdAt, TZ, now)}.`, answer: null },
      { id: gone, title: 'Flint made this prediction in a chat.', says: `Flint said likely, around 70%, on ${dayWords((await made(gone)).createdAt, TZ, now)}.`, answer: null },
      { id: closed, title: `${serviceName} is closed.`, says: `Flint said very likely, around 90%, on ${dayWords((await made(closed)).createdAt, TZ, now)}.`, answer: null },
    ]);
    for (const q of before.waiting) {
      expect(q.title).not.toMatch(/#|daily\.|at the resolve time/);
      expect(noteProblems('Predictions', q.says), q.says).toEqual([]);
    }
    // In shadow they wait in the panel, counted, and nothing announces them.
    expect(await page()).toMatchObject({ questions: 5, announce: false });
    // The console's own question says the same, and nothing else: no number of a series rides along.
    const waiting = await call('GET', '/v1/predictions/waiting');
    expect([waiting.status, waiting.body]).toEqual([200, { questions: 5, announce: false }]);

    // The database takes no result as Will's without his answer, whoever says it is his.
    const ownDue = (await made(own)).resolveBy;
    const forged = k.inTx((q) => q(`INSERT INTO "Resolution" (id, "predictionId", outcome, "eventAt", "resolvedBy") VALUES ($1, $2, true, $3, 'will')`, [id('rs'), own, ownDue]), { actor: 'will:console' });
    expect(await k.code(forged)).toBe('42501');

    const yes = await call('POST', `/v1/predictions/questions/${own}/answer`, { answer: 'yes' });
    expect([yes.status, yes.body]).toEqual([200, { ok: true }]);
    expect(await k.resolution(own)).toMatchObject({ outcome: true, outcomeValue: null, resolvedBy: 'will', eventAt: (await made(own)).resolveBy, evidence: { via: ANSWER_ACTION } });
    expect((await k.resolution(own))!.brier).toBeCloseTo(0.09, 10);
    expect(await k.status(own)).toBe('resolved');
    const no = await call('POST', `/v1/predictions/questions/${above}/answer`, { answer: 'no' });
    expect([no.status, no.body]).toEqual([200, { ok: true }]);
    expect(await k.resolution(above)).toMatchObject({ outcome: false, resolvedBy: 'will', eventAt: (await made(above)).resolveBy });
    // Skip: his answer is on record, and no result is. The prediction stays open, to run out unscored.
    const skip = await call('POST', `/v1/predictions/questions/${healthy}/answer`, { answer: 'skip' });
    expect([skip.status, skip.body]).toEqual([200, { ok: true }]);
    expect(await k.resolution(healthy)).toBeUndefined();
    expect(await k.status(healthy)).toBe('open');
    const stored = (await k.owner(`SELECT "predictionId", answer, "answeredAt" FROM "PredictionQuestion" WHERE "predictionId" = ANY($1)`, [[own, above, healthy, gone, closed]])).rows;
    expect(Object.fromEntries(stored.map((r) => [r.predictionId, r.answer]))).toEqual({ [own]: 'yes', [above]: 'no', [healthy]: 'skip', [gone]: null, [closed]: null });
    for (const r of stored.filter((x) => x.answer)) expect(Math.abs((r.answeredAt as Date).getTime() - Date.now())).toBeLessThan(MIN);

    // Once: a second answer, the same or another, is refused, and nothing changes.
    for (const [pid, answer] of [[own, 'yes'], [own, 'no'], [healthy, 'yes'], [above, 'skip']] as const) {
      const r = await call('POST', `/v1/predictions/questions/${pid}/answer`, { answer });
      expect([r.status, r.body], `${pid} ${answer}`).toEqual([409, { error: 'That question was already answered.', code: 'answered' }]);
    }
    expect(await k.resolution(own)).toMatchObject({ outcome: true });
    expect(await k.resolution(healthy)).toBeUndefined();
    // Two answers at the same moment (a double tap, two devices): one is taken, the other is told it was answered,
    // and one result is on record, the taken one's.
    const both = await Promise.all([call('POST', `/v1/predictions/questions/${closed}/answer`, { answer: 'yes' }), call('POST', `/v1/predictions/questions/${closed}/answer`, { answer: 'no' })]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(both.find((r) => r.status === 409)!.body).toEqual({ error: 'That question was already answered.', code: 'answered' });
    const took = both[0]!.status === 200 ? 'yes' : 'no';
    expect((await k.owner(`SELECT answer FROM "PredictionQuestion" WHERE "predictionId" = $1`, [closed])).rows).toEqual([{ answer: took }]);
    expect((await k.owner(`SELECT outcome, "resolvedBy" FROM "Resolution" WHERE "predictionId" = $1`, [closed])).rows).toEqual([{ outcome: took === 'yes', resolvedBy: 'will' }]);

    // A question that was never asked is not there to answer.
    const never = await wills(HOUR);
    for (const pid of [never, 'pdnosuchprediction']) {
      const r = await call('POST', `/v1/predictions/questions/${pid}/answer`, { answer: 'yes' });
      expect([r.status, r.body], pid).toEqual([404, { error: 'That question no longer exists.', code: 'noQuestion' }]);
    }
    expect(await k.resolution(never)).toBeUndefined();

    // One audit entry an answer: the prediction's id and the answer, never its words.
    const entries = await audits(ANSWER_ACTION);
    expect(entries.map((e) => [e.actor, e.context, e.kind, e.outcome, e.inputs, e.correlationId, e.tainted])).toEqual([
      ['will:console', 'console', 'action', 'ok', { predictionId: own, answer: 'yes' }, `${own}.answer`, false],
      ['will:console', 'console', 'action', 'ok', { predictionId: above, answer: 'no' }, `${above}.answer`, false],
      ['will:console', 'console', 'action', 'ok', { predictionId: healthy, answer: 'skip' }, `${healthy}.answer`, false],
      // The two at once: one entry, for the one that was taken.
      ['will:console', 'console', 'action', 'ok', { predictionId: closed, answer: took }, `${closed}.answer`, false],
    ]);
    expect(JSON.stringify(entries)).not.toContain(WORDS);

    // The list now: one still waits, and the four he answered say what he said, newest first.
    const after = QuestionsPage.parse((await call('GET', '/v1/predictions/questions')).body);
    expect(after.waiting.map((q) => q.id)).toEqual([gone]);
    const today = dayWords(new Date(), TZ, new Date());
    expect(after.answered.map((q) => [q.id, q.answer, q.says])).toEqual([
      [closed, took, `You said ${took} on ${today}.`], [healthy, 'skip', `You skipped it on ${today}.`], [above, 'no', `You said no on ${today}.`], [own, 'yes', `You said yes on ${today}.`],
    ]);
    expect((await page()).questions).toBe(1);
  });

  it('how Flint has done: the night\'s scores by area, in sentences; "not enough" below thirty; what was left unsettled', async () => {
    const windowEnd = start(0);
    const base = { windowStart: start(90), windowEnd, nOpen: 0, nExpired: 0, nConditionUnmet: 0, nVoid: 0, nLateSuperseded: 0, unresolvedRate: 0 };
    const bins = (fill: Record<number, [number, number, number]>) => Array.from({ length: 10 }, (_, i) => ({ lo: i / 10, hi: (i + 1) / 10, n: fill[i]?.[0] ?? 0, meanP: fill[i]?.[1] ?? null, freq: fill[i]?.[2] ?? null }));
    const yesNo = { kind: 'binary', type: 'threshold_cross', intervalCoverage: null, pinball: null, ece: null, brierCiLow: null, brierCiHigh: null };
    const ranges = { kind: 'interval', type: 'trend', brier: null, baseRate: null, brierSkill: null, reliability: [], ece: null, brierCiLow: null, brierCiHigh: null };
    await k.db.calibrationSnapshot.createMany({ data: [
      // Spend: 41 yes/no results in two groups (most said about 70%), better than the usual rate; and 120 ranges.
      { ...base, ...yesNo, domain: 'spend', method: 'statistical', n: 30, brier: 0.2, baseRate: 0.6, brierSkill: 0.17, reliability: bins({ 7: [30, 0.72, 0.6] }), nExpired: 2 },
      { ...base, ...yesNo, domain: 'spend', method: 'base_rate', n: 11, brier: 0.22, baseRate: 0.7, brierSkill: 0, reliability: bins({ 7: [11, 0.7, 0.75] }) },
      { ...base, ...ranges, domain: 'spend', method: 'statistical', n: 100, intervalCoverage: 0.8, pinball: 0.3, nLateSuperseded: 2 },
      { ...base, ...ranges, domain: 'spend', method: 'base_rate', n: 20, intervalCoverage: 0.75, pinball: 0.4 },
      // Deploys: too few of either kind.
      { ...base, ...yesNo, domain: 'deploys', method: 'statistical', n: 12, brier: 0.3, baseRate: 0.5, brierSkill: -0.2, reliability: bins({ 5: [12, 0.55, 0.4] }) },
      { ...base, ...ranges, domain: 'deploys', method: 'statistical', n: 25, intervalCoverage: 0.9, pinball: 0.2 },
      // Goals: 120 yes/no results in one group: the error score with its likely range, and the average gap. No better than the usual rate.
      { ...base, ...yesNo, type: 'deadline_met', domain: 'goals', method: 'rule', n: 120, brier: 0.26, baseRate: 0.5, brierSkill: -0.04, reliability: bins({ 3: [40, 0.35, 0.5], 8: [80, 0.85, 0.8] }), ece: 0.083, brierCiLow: 0.22, brierCiHigh: 0.3, nConditionUnmet: 4, nVoid: 1 },
      // Services: predictions made, none scored yet (a group with nothing scored stores 0 for its scores).
      { ...base, ...yesNo, type: 'event_occurs', domain: 'services', method: 'base_rate', n: 0, brier: 0, baseRate: 0, brierSkill: null, reliability: bins({}), nOpen: 3, nExpired: 1 },
      // An older night's scores are not the latest: never read.
      { ...base, ...ranges, windowStart: start(91), windowEnd: start(1), domain: 'calendar', method: 'base_rate', n: 500, intervalCoverage: 0.1, pinball: 9 },
    ] });
    const got = AccuracyView.parse((await call('GET', '/v1/predictions/accuracy')).body);
    expect(got).toEqual({
      scored: true,
      areas: [
        { name: 'Spend', value: '161 Scored', lines: [
          'When Flint said about 71%, it happened 64% of the time, over 41 predictions.',
          'Flint did better than always guessing the usual rate.',
          'Its 80% ranges held 79% of the time, over 120 forecasts.',
        ] },
        { name: 'Deploys', value: '37 Scored', lines: ['Flint has 12 of the 30 results it needs for its yes or no predictions.', 'Flint has 25 of the 30 results it needs for its ranges.'] },
        { name: 'Services', value: '0 Scored', lines: ['There are no results yet.'] },
        { name: 'Goals', value: '120 Scored', lines: [
          'When Flint said about 85%, it happened 80% of the time, over 80 predictions.',
          'Flint did no better than guessing the usual rate.',
          'Its error score is 0.26, and lower is better. The likely range is 0.22 to 0.30.',
          'Its stated chances sat 8 points from what happened, on average.',
        ] },
      ],
      unsettled: ['3 predictions ran out before they could be checked.', '2 were revised close to their date.', '4 depended on advice you declined.', '1 was set aside with your approval.'],
    });
    for (const area of got.areas) for (const l of area.lines) expect(noteProblems('Predictions', l), l).toEqual([]);
    for (const l of got.unsettled) expect(noteProblems('Predictions', l), l).toEqual([]);
  });

  it('no log line holds a number\'s value, a sentence about one, or a prediction\'s words', async () => {
    const p = await page();
    await series(ANTHROPIC);
    await call('GET', '/v1/predictions/questions');
    const log = lines.join('\n');
    expect(lines.length).toBeGreaterThan(20);
    expect(log).not.toContain(WORDS);
    expect(log).not.toMatch(/\$\d/);
    for (const n of p.numbers.filter((x) => x.state === 'range' || x.state === 'no_trend')) expect(log).not.toContain(n.says);
    expect(log).not.toContain('reliable trend');
    expect(log).not.toContain('Flint expects');
    // A request line names the route; a number's key in a path is not its value.
    expect(log).toContain('/v1/predictions');
  });
});
