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
 *    range, no reliable trend, too early to tell, steady (with the count of
 *    steps it really has), waiting, not enough history, no data, tonight,
 *    failed, off. A state with no number shows none.
 *  - One number, open: every step of its forecast, its yes/no chance, and how
 *    its ranges have held.
 *  - Turning a number off needs no signature, is audited by its key, and is
 *    said to be off afterwards; a second time is refused in a sentence.
 *  - A question says what Flint said, when, and when it was due. Will's answer
 *    records the result as his, once, with the prediction's own resolve time;
 *    Skip records none. The database refuses a result recorded as his without
 *    his answer. A prediction Flint cannot say plainly is Skip only, and one
 *    row that would break the page is replaced, never a failed page. A
 *    prediction settled, run out or set aside meanwhile is refused in a
 *    sentence. Switched off on this Mac, nothing is answered.
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
import { approveProposal, rejectProposal } from '../src/governance/proposals';
import { runInternal } from '../src/governance/internal';
import { sweep } from '../src/ledger/sweep';
import { TURN_OFF_ACTION, proposeForecasts } from '../src/predict/enable';
import { weekOf } from '../src/predict/metrics';
import { PANEL, aboutValue, dayWords, dueSays, earlySays, expectSays, noTrendSays, stepLabel, stepRangeSays } from '../src/predict/phrasing';
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
  /** One clock for the forecasts' day, read once (in beforeAll, once the day is safely under way). */
  let NOW = new Date();
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
    // The routes read the real clock, and this file's forecasts are of NOW's day. It never starts in the last
    // minute of a UTC day, so a midnight passing while it runs cannot move "today" under it.
    const toMidnight = 86_400_000 - (Date.now() % 86_400_000);
    if (toMidnight < 60_000) await new Promise((r) => setTimeout(r, toMidnight + 1000));
    NOW = new Date();
    urls = await freshDb();
    k = await ledgerKit(urls);
    key = await enrollTestKey(urls);
    const logStream = { write: (l: string) => void lines.push(l) };
    app = buildApp({ db: k.db, config: { tokens, tz: TZ, predict: true }, logger: true, logStream });
    offHere = buildApp({ db: k.db, config: { tokens, tz: TZ, predict: false }, logger: true, logStream });
  }, 120_000);
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
    // Nothing scores anything yet, and the page says which kind of "not yet" it is: never turned on, or switched off here.
    expect(AccuracyView.parse((await call('GET', '/v1/predictions/accuracy')).body)).toEqual({ scored: false, scoring: 'not_started', areas: [], unsettled: [] });
    expect(AccuracyView.parse((await call('GET', '/v1/predictions/accuracy', undefined, offHere)).body)).toEqual({ scored: false, scoring: 'off_here', areas: [], unsettled: [] });
    // What the console asks on load: two facts, whatever the Mac's switch says.
    for (const on of [app, offHere]) expect(PredictionsWaiting.parse((await call('GET', '/v1/predictions/waiting', undefined, on)).body)).toEqual({ questions: 0, announce: false });
    expect(QuestionsPage.parse((await call('GET', '/v1/predictions/questions')).body)).toEqual({ waiting: [], answered: [], offHere: false });
    expect(QuestionsPage.parse((await call('GET', '/v1/predictions/questions', undefined, offHere)).body)).toEqual({ waiting: [], answered: [], offHere: true });
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

  it('Turn On cards filed at the same moment never reject each other: the last one filed is the one left, and only earlier ones are replaced', async () => {
    const sets = [[NEXUS], [HELM], [NEXUS, HELM]];
    const filed = await Promise.all(sets.map((series) => call('POST', '/v1/predictions/turn-on', { series })));
    expect(filed.map((r) => r.status)).toEqual([200, 200, 200]);
    const ids = filed.map((r) => r.body.id as string);
    expect(new Set(ids).size).toBe(3);
    const mine = (await cards()).filter((c) => ids.includes(c.id as string));
    // Exactly one is still waiting; the other two were replaced by one filed after them, and say so.
    expect(mine.map((c) => c.status).sort()).toEqual(['pending', 'rejected', 'rejected']);
    for (const c of mine.filter((x) => x.status === 'rejected')) expect(c.error).toBe('A newer version of this card replaced it.');
    const left = mine.find((c) => c.status === 'pending')!;
    expect((await page()).waiting).toEqual([{ id: left.id, numbers: (left.args as { series: string[] }).series.length }]);
    // Each rejection is in the audit trail, once, with the card's id and nothing of its numbers' values.
    const rejections = (await k.owner(`SELECT "correlationId", actor, kind, outcome FROM "AuditEntry" WHERE kind = 'rejection' AND "correlationId" = ANY($1) ORDER BY seq`, [ids])).rows;
    expect(rejections.map((r) => [r.actor, r.kind, r.outcome])).toEqual([['will:console', 'rejection', 'denied'], ['will:console', 'rejection', 'denied']]);
    expect(rejections.map((r) => r.correlationId).sort()).toEqual(mine.filter((c) => c.status === 'rejected').map((c) => c.id as string).sort());
    // One filed later replaces the one left (or, asked for the same numbers, is that very card).
    const next = await call('POST', '/v1/predictions/turn-on', { series: [NEXUS] });
    expect(next.status).toBe(200);
    const now = await cards();
    expect(now.find((c) => c.id === left.id)!.status).toBe((left.args as { series: string[] }).series.join() === NEXUS ? 'pending' : 'rejected');
    expect(now.filter((c) => c.status === 'pending')).toHaveLength(1);
    // Nothing is left waiting for the tests below.
    expect(now.find((c) => c.status === 'pending')!.id).toBe(next.body.id);
    await rejectProposal(k.db, next.body.id as string, { error: 'a test put it away' }, undefined, 'test');
    expect((await page()).waiting).toEqual([]);
  });

  it('each number says where it stands, in a sentence made from its own run; a state with no number shows none', async () => {
    // A rising line, 60 days of it: a forecast that beats a plain guess.
    await days(DEPLOYS, line(60));
    // A pure weekly pattern: no model beats "the same day last week".
    await days(CALENDAR, Array.from({ length: 56 }, (_, i) => week[i % 7]!));
    // Thirty days of dollars: too short for a model to be believed.
    await days(ANTHROPIC, dollars);
    // A number that has not changed in the 24 days there are of it.
    await days(THREADS, Array.from({ length: 24 }, () => 7));
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
      [ANTHROPIC, 'early', 'Too Early'],
      [OPENAI, 'waiting', 'Waiting'],
      [PERPLEXITY, 'tonight', 'Tonight'],
      [TAVILY, 'no_data', 'No Data'],
      [DEPLOYS, 'range', 'About 130'],
      [FLINT, 'early', 'Too Early'],
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
    // Too early to tell (thirty days, twenty weeks: too short to believe a forecast over a plain guess) is said as
    // that, never as "no reliable trend": a plain guess's range, and no middle.
    const a = await firstStep(ANTHROPIC);
    expect(a.beatsNaive).toBeNull();
    expect(rowOf(p, ANTHROPIC).says).toBe(earlySays({ lower: a.points[0]!.lo, upper: a.points[0]!.hi, level: 0.8, unit: 'usd' }));
    expect(rowOf(p, ANTHROPIC).says).toMatch(/^It’s too early to tell a trend, and a plain guess gives an 80% range of \$\d+\.\d\d to \$\d+\.\d\d\.$/);
    expect(rowOf(p, FLINT).says).toMatch(/^It’s too early to tell a trend, and a plain guess gives an 80% range of \d+ to \d+\.$/);
    // No reliable trend: with history enough to judge (56 days), the forecast did not beat a plain guess.
    const h = (await k.owner(`SELECT "beatsNaive", points FROM "ForecastRun" WHERE "seriesKey" = $1 AND ok ORDER BY "createdAt" DESC LIMIT 1`, [CALENDAR])).rows[0] as { beatsNaive: boolean | null; points: Array<{ lo: number; hi: number }> };
    expect(h.beatsNaive).toBe(false);
    expect(rowOf(p, CALENDAR).says).toBe(noTrendSays({ lower: h.points[0]!.lo, upper: h.points[0]!.hi, level: 0.8, unit: 'hours' }));
    expect(rowOf(p, CALENDAR).says).toMatch(/^There’s no reliable trend, and a plain guess gives an 80% range of [\d.]+ to [\d.]+ hours\.$/);
    for (const seriesKey of [ANTHROPIC, CALENDAR, FLINT]) expect(rowOf(p, seriesKey).says).not.toMatch(/about|expects/);
    // The states with no number say why, and carry no value of the series.
    expect(rowOf(p, OPENAI).says).toBe('Yesterday’s number isn’t in yet, so there’s no forecast for today.');
    expect(rowOf(p, DOWNTIME).says).toBe('Flint needs 24 days of history. It has 10.');
    // It has 24 days, all the same: it says 24, never the 28 a longer history is judged over.
    expect(rowOf(p, THREADS).says).toBe('This number hasn’t changed in 24 days.');
    expect(rowOf(p, TAVILY).says).toBe('This number has no data yet.');
    expect(rowOf(p, PERPLEXITY).says).toBe('Flint makes its next forecast tonight.');
    expect(rowOf(p, TRIDENT).says).toBe('Flint couldn’t forecast this number last night.');
    for (const seriesKey of [OPENAI, THREADS, TAVILY, PERPLEXITY, TRIDENT]) expect(rowOf(p, seriesKey).says.replace('24 days', ''), seriesKey).not.toMatch(/\d|\$|%/);
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
    // Too early to tell: the same plain guess's range on each step, under its own value, and no middle either.
    const spend = await series(ANTHROPIC);
    expect(spend.forecast.length).toBeGreaterThan(0);
    for (const f of spend.forecast) {
      expect(f.value).toBe('Too Early');
      expect(f.says).toMatch(/^A plain guess gives an 80% range of \$\d+\.\d\d to \$\d+\.\d\d\.$/);
    }
    // A weekly number's first step is this week.
    expect((await series(FLINT)).forecast[0]!.label).toBe('This Week');
    // Switched off on this Mac, one number says so and shows nothing of the forecast it holds: no step, no chance.
    for (const seriesKey of [DEPLOYS, ANTHROPIC, CALENDAR]) {
      const here = await series(seriesKey, offHere);
      expect(here, seriesKey).toMatchObject({ offHere: true, forecast: [], chance: null, number: { on: false, state: 'off', value: 'Off', says: 'Forecasts for this number are off.' } });
      expect(JSON.stringify(here), seriesKey).not.toMatch(/\$\d|About|range of/);
    }
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
    // A number whose second opinion was on loses that with it: turning it on again starts from the card, for both.
    const nexus = FORECAST_SERIES.find((x) => x.key === NEXUS)!;
    await k.series({ key: nexus.key, unit: nexus.unit, freq: 'W', sensitivity: nexus.sensitivity, description: nexus.description });
    await k.turnOn([NEXUS], [NEXUS]);
    expect(await k.db.forecastSeries.findUniqueOrThrow({ where: { seriesKey: NEXUS } })).toMatchObject({ on: true, reason: true });
    expect((await call('POST', `/v1/predictions/series/${NEXUS}/turn-off`, {})).status).toBe(200);
    expect(await k.db.forecastSeries.findUniqueOrThrow({ where: { seriesKey: NEXUS } })).toMatchObject({ on: false, reason: false });
    // Switched off on this Mac, turning a number off is still allowed (it only narrows what Flint does), and audited.
    expect((await call('POST', `/v1/predictions/series/${CALENDAR}/turn-off`, {}, offHere)).status).toBe(200);
    expect(await k.db.forecastSeries.findUniqueOrThrow({ where: { seriesKey: CALENDAR } })).toMatchObject({ on: false });
    expect((await audits(TURN_OFF_ACTION)).map((e) => e.inputs)).toEqual([{ series: DEPLOYS }, { series: NEXUS }, { series: CALENDAR }]);
    // Turning it on again takes the card: nothing unsigned can.
    expect(await k.code(k.app(`UPDATE "ForecastSeries" SET "on" = true WHERE "seriesKey" = $1`, [DEPLOYS]))).toBe('42501');
    const back = await call('POST', '/v1/predictions/turn-on', { series: [DEPLOYS] });
    expect(back.body).toMatchObject({ deduped: false });
    expect(await sign(back.body.id as string)).toEqual({ on: 1, reason: 0 });
    expect(rowOf(await page(), DEPLOYS)).toMatchObject({ on: true, state: 'range' });
  });

  /** A prediction Flint made in a chat, which only Will resolves, due `dueAgo` ms ago. */
  const wills = (dueAgo: number, over: Record<string, unknown> = {}) =>
    k.prediction({ method: 'model_reasoning', resolver: 'will', createdBy: 'client:server', domain: 'projects', probability: 0.7, ...over }, { madeAgo: Math.max(dueAgo, 0) + 9 * DAY, dueAgo });
  const made = (pid: string) => k.db.prediction.findUniqueOrThrow({ where: { id: pid }, select: { createdAt: true, resolveBy: true } });
  const questions = async (on = app) => QuestionsPage.parse((await call('GET', '/v1/predictions/questions', undefined, on)).body);
  const answer = (pid: string, a: string, on = app) => call('POST', `/v1/predictions/questions/${pid}/answer`, { answer: a }, on);
  const stored = async (pid: string) => (await k.owner(`SELECT answer FROM "PredictionQuestion" WHERE "predictionId" = $1`, [pid])).rows[0]?.answer as string | null | undefined;
  /** What a waiting question says under its title: what Flint said and when, and when it was due. */
  const saysOf = async (pid: string, chance: string) => {
    const m = await made(pid);
    const now = new Date();
    return `Flint said ${chance}, on ${dayWords(m.createdAt, TZ, now)}. ${dueSays(m.resolveBy, TZ, now)}`;
  };
  const UNSAID = { title: 'Flint made this prediction in a chat.', says: 'Flint can’t show what this one was about, so it can only be skipped.', answer: null, answerable: false };
  const CANT = { error: 'Flint can’t show what this one was about, so it can only be skipped.', code: 'unanswerable' };
  const GONE = { error: 'That question no longer exists.', code: 'noQuestion' };
  /** The predictions of the first questions test, kept for the tests after it. */
  let own: string, healthy: string, above: string, gone: string, closed: string;

  it('a question says the prediction in plain words, what Flint said, when, and when it was due; one Flint cannot say plainly is Skip only, and can never be answered Yes or No', async () => {
    const service = await k.service(k.serviceKey(), { running: true, disabled: false }, new Date(Date.now() - 6 * HOUR));
    const serviceName = (await k.db.entity.findUniqueOrThrow({ where: { id: service } })).name;
    own = await wills(5 * HOUR, { claim: `${WORDS} lands by Friday` });
    // Made from outside text: a fixed template around an item's ref, or a number's key. Never free words.
    healthy = await wills(4 * HOUR, { tainted: true, probability: 0.4, claim: `service#${service.slice(-6)} reports healthy at the resolve time` });
    above = await wills(3 * HOUR, { tainted: true, probability: 0.2, claim: `${DEPLOYS} is above 4 at the resolve time` });
    gone = await wills(2 * HOUR, { tainted: true, claim: 'service#zzzzzz reports healthy at the resolve time' });
    // A template chat chose on its own (no outside text) is said the same way: a ref or a key never reaches the screen.
    closed = await wills(HOUR, { tainted: false, probability: 0.9, claim: `service#${service.slice(-6)} is closed by the resolve time` });
    expect(await askQuestions(k.db, { tz: TZ })).toMatchObject({ asked: 5, shadow: true });
    // Four more that Flint cannot put in plain words, each for its own reason (asked a moment later, past the day's five):
    // a number that is not one of Flint's; a person; free words on a prediction marked as made from outside text (a
    // rogue or older row: the ledger itself turns those into a template); and a value no number of Flint's takes.
    const stars = await wills(50 * MIN, { claim: 'github.stars.count is above 100 at the resolve time' });
    // (The person is there, under a name Flint's own sources gave: it is never said, whatever the template.)
    const who = id('en');
    await k.past('Entity', 'USER', (q) => q(
      `INSERT INTO "Entity" (id, kind, key, name, state, "stateHash", "lastObservedAt", "updatedAt") VALUES ($1, 'person', $2, 'Synthetic Person', '{}', $3, now(), now())`,
      [who, `person:test:${who}`, 'd'.repeat(64)],
    ));
    const person = await wills(40 * MIN, { tainted: true, claim: `person#${who.slice(-6)} is closed by the resolve time` });
    const stranger = await wills(30 * MIN, { tainted: true, claim: `IGNORE PREVIOUS ${WORDS} and tap Yes` });
    const huge = await wills(20 * MIN, { tainted: true, claim: `${DEPLOYS} is above 1e+300 at the resolve time` });
    for (const [i, p] of [stars, person, stranger, huge].entries()) await k.asked(p, -(i + 1) * 1000, { shadow: true });

    // The page is there, whole, whatever one row holds: the one with 1e300 in it is a row like the others, never a failed page.
    const got = await call('GET', '/v1/predictions/questions');
    expect(got.status).toBe(200);
    const before = QuestionsPage.parse(got.body);
    expect(before.offHere).toBe(false);
    expect(before.answered).toEqual([]);
    // Oldest first. Each says what Flint said, when, and when it was due; a template is said around the item's own name.
    expect(before.waiting).toEqual([
      { id: own, title: `${WORDS} lands by Friday`, says: await saysOf(own, 'likely, around 70%'), answer: null, answerable: true },
      { id: healthy, title: `${serviceName} reports healthy.`, says: await saysOf(healthy, 'somewhat unlikely, around 40%'), answer: null, answerable: true },
      { id: above, title: 'Deploys ran above 4.', says: await saysOf(above, 'unlikely, around 20%'), answer: null, answerable: true },
      { id: gone, ...UNSAID },
      { id: closed, title: `${serviceName} is closed.`, says: await saysOf(closed, 'very likely, around 90%'), answer: null, answerable: true },
      { id: stars, ...UNSAID },
      { id: person, ...UNSAID },
      { id: stranger, ...UNSAID },
      { id: huge, ...UNSAID },
    ]);
    expect(before.waiting[0]!.says).toMatch(/^Flint said likely, around 70%, on [A-Z][a-z]{2} \d{1,2}(, \d{4})?\. It was due [A-Z][a-z]{2} \d{1,2}(, \d{4})? at \d{1,2}:\d\d\u00a0[AP]M\.$/);
    for (const q of before.waiting) {
      expect(q.title).not.toMatch(/#|daily\.|github\.|at the resolve time|1e\+?300|IGNORE/);
      expect(q.title.length).toBeLessThanOrEqual(300);
      expect(noteProblems('Predictions', q.says), q.says).toEqual([]);
    }
    // A stranger's words are on no part of the page, and neither is a ref, a key or the number that would not fit.
    expect(JSON.stringify(got.body)).not.toMatch(/IGNORE|tap Yes|person#|service#|github\.stars|1e\+?300|0{20}|Synthetic Person/);
    // In shadow they wait in the panel, counted, and nothing announces them.
    expect(await page()).toMatchObject({ questions: 9, announce: false });
    // The console's own question says the same, and nothing else: no number of a series rides along.
    const waiting = await call('GET', '/v1/predictions/waiting');
    expect([waiting.status, waiting.body]).toEqual([200, { questions: 9, announce: false }]);

    // What he was not shown, he cannot answer: Yes and No are refused for each of them, by the runtime itself, and
    // nothing is recorded. Skip is all there is.
    for (const pid of [gone, stars, person, stranger, huge]) {
      for (const a of ['yes', 'no']) {
        const r = await answer(pid, a);
        expect([r.status, r.body], `${pid} ${a}`).toEqual([409, CANT]);
      }
      expect([await stored(pid), await k.resolution(pid), await k.status(pid)], pid).toEqual([null, undefined, 'open']);
    }
    expect(await audits(ANSWER_ACTION)).toEqual([]);
    for (const pid of [stars, person, stranger, huge]) expect((await answer(pid, 'skip')).status, pid).toBe(200);
    for (const pid of [stars, person, stranger, huge]) expect([await stored(pid), await k.resolution(pid)], pid).toEqual(['skip', undefined]);
  });

  it('an answer records the result as Will\'s, once, as of the prediction\'s own resolve time; Skip records none', async () => {
    // The database takes no result as Will's without his answer, whoever says it is his.
    const ownDue = (await made(own)).resolveBy;
    const forged = k.inTx((q) => q(`INSERT INTO "Resolution" (id, "predictionId", outcome, "eventAt", "resolvedBy") VALUES ($1, $2, true, $3, 'will')`, [id('rs'), own, ownDue]), { actor: 'will:console' });
    expect(await k.code(forged)).toBe('42501');
    const entriesBefore = (await audits(ANSWER_ACTION)).length;

    const yes = await answer(own, 'yes');
    expect([yes.status, yes.body]).toEqual([200, { ok: true }]);
    expect(await k.resolution(own)).toMatchObject({ outcome: true, outcomeValue: null, resolvedBy: 'will', eventAt: ownDue, evidence: { via: ANSWER_ACTION } });
    expect((await k.resolution(own))!.brier).toBeCloseTo(0.09, 10);
    expect(await k.status(own)).toBe('resolved');
    const no = await answer(above, 'no');
    expect([no.status, no.body]).toEqual([200, { ok: true }]);
    expect(await k.resolution(above)).toMatchObject({ outcome: false, resolvedBy: 'will', eventAt: (await made(above)).resolveBy });
    // Skip: his answer is on record, and no result is. The prediction stays open, to run out unscored.
    const skip = await answer(healthy, 'skip');
    expect([skip.status, skip.body]).toEqual([200, { ok: true }]);
    expect(await k.resolution(healthy)).toBeUndefined();
    expect(await k.status(healthy)).toBe('open');
    const rows = (await k.owner(`SELECT "predictionId", answer, "answeredAt" FROM "PredictionQuestion" WHERE "predictionId" = ANY($1)`, [[own, above, healthy, gone, closed]])).rows;
    expect(Object.fromEntries(rows.map((r) => [r.predictionId, r.answer]))).toEqual({ [own]: 'yes', [above]: 'no', [healthy]: 'skip', [gone]: null, [closed]: null });
    for (const r of rows.filter((x) => x.answer)) expect(Math.abs((r.answeredAt as Date).getTime() - Date.now())).toBeLessThan(MIN);

    // Once: a second answer, the same or another, is refused, and nothing changes.
    for (const [pid, a] of [[own, 'yes'], [own, 'no'], [healthy, 'yes'], [above, 'skip']] as const) {
      const r = await answer(pid, a);
      expect([r.status, r.body], `${pid} ${a}`).toEqual([409, { error: 'That question was already answered.', code: 'answered' }]);
    }
    expect(await k.resolution(own)).toMatchObject({ outcome: true });
    expect(await k.resolution(healthy)).toBeUndefined();
    // A question that was never asked is not there to answer.
    const never = await wills(HOUR);
    for (const pid of [never, 'pdnosuchprediction']) {
      const r = await answer(pid, 'yes');
      expect([r.status, r.body], pid).toEqual([404, GONE]);
    }
    expect(await k.resolution(never)).toBeUndefined();

    // One audit entry an answer: the prediction's id and the answer, never its words. That entry is how a wrong one is found.
    const entries = (await audits(ANSWER_ACTION)).slice(entriesBefore);
    expect(entries.map((e) => [e.actor, e.context, e.kind, e.outcome, e.inputs, e.correlationId, e.tainted])).toEqual([
      ['will:console', 'console', 'action', 'ok', { predictionId: own, answer: 'yes' }, `${own}.answer`, false],
      ['will:console', 'console', 'action', 'ok', { predictionId: above, answer: 'no' }, `${above}.answer`, false],
      ['will:console', 'console', 'action', 'ok', { predictionId: healthy, answer: 'skip' }, `${healthy}.answer`, false],
    ]);
    expect(JSON.stringify(await audits(ANSWER_ACTION))).not.toContain(WORDS);

    // The list now: two still wait, and the latest he answered say what he said, newest first.
    const after = await questions();
    expect(after.waiting.map((q) => [q.id, q.answerable])).toEqual([[gone, false], [closed, true]]);
    const today = dayWords(new Date(), TZ, new Date());
    expect(after.answered.slice(0, 3).map((q) => [q.id, q.answer, q.says])).toEqual([
      [healthy, 'skip', `You skipped it on ${today}.`], [above, 'no', `You said no on ${today}.`], [own, 'yes', `You said yes on ${today}.`],
    ]);
    expect(after.answered).toHaveLength(7);
    expect((await page()).questions).toBe(2);
  });

  it('two answers at the same moment (a double tap, two devices): one is taken and the other is told it was answered', async () => {
    // Really at the same moment: the question's row is held, both answers arrive and wait on it, and then it is let go.
    const holder = await k.client(urls.owner);
    const waitingOnLock = async () => Number((await k.owner(`SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted`)).rows[0].n);
    let both: Array<{ status: number; body: Record<string, unknown> }>;
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT 1 FROM "PredictionQuestion" WHERE "predictionId" = $1 FOR UPDATE`, [closed]);
      const racing = Promise.all([answer(closed, 'yes'), answer(closed, 'no')]);
      for (let i = 0; i < 100 && (await waitingOnLock()) < 2; i++) await new Promise((r) => setTimeout(r, 50));
      expect(await waitingOnLock()).toBe(2);
      await holder.query('COMMIT');
      both = await racing;
    } finally {
      await holder.query('ROLLBACK').catch(() => {});
      await holder.end();
    }
    expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
    // The one that lost is told plainly that it was answered: never an error, and never "no longer exists".
    expect(both.find((r) => r.status === 409)!.body).toEqual({ error: 'That question was already answered.', code: 'answered' });
    const took = both[0]!.status === 200 ? 'yes' : 'no';
    expect(await stored(closed)).toBe(took);
    expect((await k.owner(`SELECT outcome, "resolvedBy" FROM "Resolution" WHERE "predictionId" = $1`, [closed])).rows).toEqual([{ outcome: took === 'yes', resolvedBy: 'will' }]);
    // One audit entry, for the one that was taken.
    expect((await audits(ANSWER_ACTION)).filter((e) => e.correlationId === `${closed}.answer`).map((e) => e.inputs)).toEqual([{ predictionId: closed, answer: took }]);
  });

  it('a prediction settled, run out or set aside since the question was asked is refused in a sentence, with nothing recorded: never an error', async () => {
    const entries = (await audits(ANSWER_ACTION)).length;
    const lines500 = () => lines.filter((l) => l.includes('"statusCode":500') || l.includes('request failed')).length;
    const errorsBefore = lines500();
    // Run out (the sweep got there first): its status alone says so.
    const ranOut = await wills(3 * HOUR);
    await k.asked(ranOut, HOUR, { shadow: true });
    await k.app(`UPDATE "Prediction" SET status = 'expired' WHERE id = $1`, [ranOut]);
    // Set aside (void).
    const setAside = await wills(3 * HOUR);
    await k.asked(setAside, HOUR, { shadow: true });
    await k.past('Prediction', ['Prediction_guard', 'Prediction_valid_update'], (q) => q(`UPDATE "Prediction" SET status = 'void' WHERE id = $1`, [setAside]));
    // Settled another way while still open (as the card that finishes a goal settles its forecasts): a result is there.
    const settled = await wills(3 * HOUR);
    await k.asked(settled, HOUR, { shadow: true });
    const settledDue = (await made(settled)).resolveBy;
    await k.past('Resolution', 'USER', (q) => q(`INSERT INTO "Resolution" (id, "predictionId", outcome, "eventAt", "resolvedBy") VALUES ($1, $2, true, $3, 'will')`, [id('rs'), settled, settledDue]));
    expect(await k.status(settled)).toBe('open');
    // Not his to settle at all: a prediction that resolves by itself, with a question that should never have been asked.
    const notHis = await k.prediction({ method: 'rule', resolver: 'auto_world' }, { madeAgo: 2 * DAY, dueAgo: 3 * HOUR });
    await k.asked(notHis, HOUR, { shadow: true });
    for (const [what, pid] of [['run out', ranOut], ['set aside', setAside], ['settled', settled], ['not his', notHis]] as const) {
      for (const a of ['yes', 'no', 'skip']) {
        const r = await answer(pid, a);
        expect([r.status, r.body], `${what} ${a}`).toEqual([409, GONE]);
      }
      // Nothing was recorded: not even a Skip, which writes no result and so would have gone through unseen.
      expect(await stored(pid), what).toBeNull();
    }
    expect([await k.resolution(ranOut), await k.resolution(setAside), await k.resolution(notHis)]).toEqual([undefined, undefined, undefined]);
    // The database says no between the look and the write (here: a result as of a time still ahead): the same
    // sentence, and the answer written just before it is taken back with it.
    const ahead = await wills(-HOUR);
    await k.asked(ahead, MIN, { shadow: true });
    const refused = await answer(ahead, 'yes');
    expect([refused.status, refused.body]).toEqual([409, GONE]);
    expect([await stored(ahead), await k.resolution(ahead), await k.status(ahead)]).toEqual([null, undefined, 'open']);
    expect((await audits(ANSWER_ACTION)).length).toBe(entries);
    // None of it was a failed request.
    expect(lines500()).toBe(errorsBefore);
  });

  it('switched off on this Mac, nothing is answered: the page says so, an answer is refused with the off sentence, and nothing waits', async () => {
    const before = await questions();
    expect(before.waiting.map((q) => q.id)).toContain(gone);
    // The same questions are listed, marked as off here.
    const here = await questions(offHere);
    expect(here).toEqual({ ...before, offHere: true });
    const entries = (await audits(ANSWER_ACTION)).length;
    for (const a of ['yes', 'no', 'skip']) {
      const r = await answer(gone, a, offHere);
      expect([r.status, r.body], a).toEqual([409, { error: 'Predictions are switched off on this Mac.', code: 'offHere' }]);
    }
    expect([await stored(gone), await k.resolution(gone)]).toEqual([null, undefined]);
    expect((await audits(ANSWER_ACTION)).length).toBe(entries);
    // Nothing is said to wait where nothing can be answered: not to the console's own check, and not on the page.
    expect((await call('GET', '/v1/predictions/waiting', undefined, offHere)).body).toEqual({ questions: 0, announce: false });
    expect(await page(offHere)).toMatchObject({ state: 'off_here', questions: 0, announce: false });
    expect((await page()).questions).toBe(before.waiting.length);
    expect((await call('GET', '/v1/predictions/waiting')).body).toMatchObject({ questions: before.waiting.length });
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
      scoring: 'on',
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
