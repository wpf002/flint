/**
 * The local model's second opinion in the Predictions panel, on flint_test
 * (P4 part 5): how Will turns it on and off, and the only places it shows.
 *
 *  - The sheet may offer it only where predictions run on this Mac and a local
 *    model is set; asked for without one, the card is refused in a sentence
 *    and never filed.
 *  - Switched on in the sheet, the card names the same numbers twice: to
 *    forecast, and for the local model. Signed, each gets its switch. It can
 *    be added to a number that is already on, with a card of its own.
 *  - One number, open: one sentence. What the model said of today's question
 *    ("The local model said about 62%."), that it has said nothing, that it is
 *    off, or that there is no local model. Never its reason or its name.
 *  - Turning it off needs no signature, is audited by the number's key, and
 *    leaves the forecasts on and the estimates already made on the ledger.
 *  - A card is one of two kinds, fixed as it is filed: one that turns numbers
 *    on (it replaces every card still waiting, as the sheet's card always
 *    did), or, when every number on it is already on, one that changes second
 *    opinions only (it replaces only a waiting card that names one of its
 *    numbers, and signed after its number was turned off it is refused: it
 *    never turns forecasts back on). The runtime's answer says which.
 *  - Accuracy compares it with the forecaster's own answer to the very same
 *    questions, a sentence for each kind of answer once there are 30; before
 *    that it says how far along it is. An area's own lines, the night's
 *    scores and chat's calibration do not count it: one question, one answer.
 * Synthetic numbers; Flint's zone is UTC here.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { AccuracyView, FORECAST_REASONS, PredictionsPage, SeriesAnswer, digestOf, noteProblems } from '@flint/policy';
import { NO_DB, freshDb, type TestUrls } from './db';
import { DAY, HOUR, TZ, dayStart, ledgerKit, type LedgerKit } from './ledger/kit';
import { FakeBus } from './goals/fixture';
import { enrollTestKey } from './sign';
import { modelsHere } from './ollama-kit';
import { buildApp } from '../src/app';
import type { RuntimeScope } from '../src/config';
import { approveProposal, rejectProposal } from '../src/governance/proposals';
import { runInternal } from '../src/governance/internal';
import { snapshotCalibration } from '../src/ledger/calibration';
import { sweep } from '../src/ledger/sweep';
import { OPINION_OFF_ACTION, proposeForecasts } from '../src/predict/enable';
import { PANEL, opinionSays, opinionTooFewSays, opinionVersusSays } from '../src/predict/phrasing';
import { SAME_SCORE } from '../src/predict/view';
import { runReason } from '../src/predict/reason';
import { runForecasts } from '../src/predict/run';
import { forecastSeries, freqOf } from '../src/predict/series';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const SERVER = 'server-token-0123456789abcdef';
const tokens = [{ name: 'server', sha256: sha(SERVER), scopes: new Set<RuntimeScope>(['events', 'audit', 'proposals', 'world:read', 'ledger', 'counters']) }];
const OLLAMA = { url: 'http://127.0.0.1:11434', model: 'muse-glimmer:30b' };

// Ollama says the model is its own: what makes a model "not here" is model/here.test.ts's.
modelsHere([OLLAMA.model]);

const DEPLOYS = 'daily.deploys.count';
const THREADS = 'daily.threads.open';
const ANTHROPIC = 'daily.spend.anthropic.usd';
const CALENDAR = 'daily.calendar.hours';
const DOWNTIME = 'daily.services.incident_minutes';

describe.skipIf(NO_DB)('the second opinion in the Predictions panel, on flint_test', () => {
  let urls: TestUrls;
  let k: LedgerKit;
  let key: Awaited<ReturnType<typeof enrollTestKey>>;
  /** Predictions on and a local model set; on with no local model; and switched off on this Mac. */
  let app: ReturnType<typeof buildApp>;
  let noModel: ReturnType<typeof buildApp>;
  let offHere: ReturnType<typeof buildApp>;
  const lines: string[] = [];
  let NOW = new Date();
  const start = (daysAgo: number) => dayStart(daysAgo, NOW);

  const call = async (method: 'GET' | 'POST', url: string, body?: unknown, on = app) => {
    const r = await on.inject({ method, url, headers: { authorization: `Bearer ${SERVER}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { payload: JSON.stringify(body) } : {}) });
    return { status: r.statusCode, body: JSON.parse(r.body) as Record<string, unknown> };
  };
  const page = async (on = app) => PredictionsPage.parse((await call('GET', '/v1/predictions', undefined, on)).body);
  const series = async (seriesKey: string, on = app) => SeriesAnswer.parse((await call('GET', `/v1/predictions/series/${seriesKey}`, undefined, on)).body).series;
  const cards = async () => (await k.owner(`SELECT id, status, origin, args, "argsDigest", sensitivity, consequential, reason FROM "Proposal" WHERE action = 'forecast.series.enable' ORDER BY "createdAt", id`)).rows;
  const sign = async (pid: string) => {
    const p = await k.db.proposal.findUniqueOrThrow({ where: { id: pid } });
    await approveProposal(k.db, p.id, await key.approve({ subjectId: p.id, action: p.action, argsDigest: p.argsDigest }), undefined, 'test');
    return runInternal(k.db, p.id, undefined, TZ, 'test');
  };
  const switches = async (seriesKey: string) => k.db.forecastSeries.findUnique({ where: { seriesKey }, select: { on: true, reason: true } });
  const audits = async (action: string) => (await k.owner(`SELECT actor, context, kind, action, outcome, inputs, "correlationId", tainted FROM "AuditEntry" WHERE action = $1 ORDER BY seq`, [action])).rows;
  const days = async (seriesKey: string, values: number[], endAgo = 1) => {
    for (const [i, v] of values.entries()) await k.point(seriesKey, start(endAgo + values.length - 1 - i), v);
  };
  /** A sentence the panel shows is fit for Will, and names no key, model or reason code. */
  const plain = (s: string) => {
    expect(noteProblems('Predictions', s), s).toEqual([]);
    expect(s, s).not.toMatch(/daily\.|weekly\.|muse|ollama|glimmer|recent_level|weekday_pattern|trend|burst|too_noisy|no_signal|[()_]/);
  };

  beforeAll(async () => {
    // The routes read the real clock, and this file's forecasts are of NOW's day: never started in a UTC day's last minute.
    const toMidnight = 86_400_000 - (Date.now() % 86_400_000);
    if (toMidnight < 60_000) await new Promise((r) => setTimeout(r, toMidnight + 1000));
    NOW = new Date();
    urls = await freshDb();
    k = await ledgerKit(urls);
    key = await enrollTestKey(urls);
    const logStream = { write: (l: string) => void lines.push(l) };
    app = buildApp({ db: k.db, config: { tokens, tz: TZ, predict: true, ollama: OLLAMA }, logger: true, logStream });
    noModel = buildApp({ db: k.db, config: { tokens, tz: TZ, predict: true }, logger: true, logStream });
    offHere = buildApp({ db: k.db, config: { tokens, tz: TZ, predict: false, ollama: OLLAMA }, logger: true, logStream });
  }, 120_000);
  afterAll(async () => {
    await app?.close();
    await noModel?.close();
    await offHere?.close();
    await k?.db.$disconnect();
  });
  it('the sheet may offer it only where predictions run on this Mac and a local model is set', async () => {
    expect((await page()).secondOpinion).toBe(true);
    expect((await page(noModel)).secondOpinion).toBe(false);
    expect((await page(offHere)).secondOpinion).toBe(false);
  });

  it('asked for with no local model, the card is refused in a sentence and never filed; with one, it names the same numbers for the local model', async () => {
    const refused = await call('POST', '/v1/predictions/turn-on', { series: [DEPLOYS], opinion: true }, noModel);
    expect([refused.status, refused.body]).toEqual([409, { error: 'No local model is set on this Mac, so there is no second opinion to turn on.', code: 'noModel' }]);
    expect(await cards()).toEqual([]);
    // Without the switch, the same console files the plain card: a missing model stops only the second opinion.
    const plainCard = await call('POST', '/v1/predictions/turn-on', { series: [THREADS] }, noModel);
    expect(plainCard.status).toBe(200);
    expect((await cards())[0]).toMatchObject({ args: { series: [THREADS], reason: [] } });
    // Switched off on this Mac, nothing is filed either way.
    expect((await call('POST', '/v1/predictions/turn-on', { series: [DEPLOYS], opinion: true }, offHere)).body).toMatchObject({ code: 'offHere' });

    // With a local model: the card Will signs lists each number twice, to forecast and for the local model, sorted.
    const filed = await call('POST', '/v1/predictions/turn-on', { series: [DEPLOYS, ANTHROPIC, DEPLOYS], opinion: true });
    expect(filed.status).toBe(200);
    const args = { series: [DEPLOYS, ANTHROPIC].sort(), reason: [DEPLOYS, ANTHROPIC].sort() };
    const all = await cards();
    // The newer card replaced the one still waiting, as any Turn On card from the sheet does.
    expect(all.map((c) => c.status)).toEqual(['rejected', 'pending']);
    expect(all[1]).toMatchObject({ id: filed.body.id, origin: 'console', args, argsDigest: digestOf(args), sensitivity: 'financial', consequential: true, reason: FORECAST_REASONS.enable });
    // `opinion: false` is the plain card, and anything else in its place is not a request.
    for (const bad of [{ series: [DEPLOYS], opinion: 'yes' }, { series: [DEPLOYS], reason: [DEPLOYS] }, { series: [DEPLOYS], opinion: true, model: 'gpt-oss:120b-cloud' }]) {
      const r = await call('POST', '/v1/predictions/turn-on', bad);
      expect([r.status, r.body.code], JSON.stringify(bad)).toEqual([400, 'request']);
    }
    // Filing turns nothing on.
    expect(await k.db.forecastSeries.count()).toBe(0);

    // Signed: both numbers are on, each with its second opinion.
    expect(await sign(filed.body.id as string)).toEqual({ on: 2, reason: 2 });
    expect([await switches(DEPLOYS), await switches(ANTHROPIC)]).toEqual([{ on: true, reason: true }, { on: true, reason: true }]);
    // Exactly as the card says: asked for again, there is nothing to sign.
    expect((await call('POST', '/v1/predictions/turn-on', { series: [DEPLOYS, ANTHROPIC], opinion: true })).body).toMatchObject({ code: 'nothing' });
  });

  it('one number, open: one sentence for what the local model said, and nothing else of its reply', async () => {
    // A number that is off has no second opinion to speak of.
    expect((await series(CALENDAR)).opinion).toBeNull();
    // On with its second opinion, and no forecast yet: nothing was said.
    expect((await series(DEPLOYS)).opinion).toEqual({ on: true, says: 'The local model has no estimate for this forecast.', offer: false });
    // Tonight's forecast, and no estimate yet: the same sentence.
    await days(DEPLOYS, Array.from({ length: 60 }, (_, i) => 10 + 2 * i));
    expect(await runForecasts({ db: k.db, tz: TZ, now: NOW })).toMatchObject({ ran: 1 });
    const before = await series(DEPLOYS);
    expect(before.chance).not.toBeNull();
    expect(before.opinion).toEqual({ on: true, says: PANEL.noOpinion, offer: false });
    // The local model answers: 62%, because of the trend.
    const runId = (await k.owner(`SELECT id FROM "ForecastRun" WHERE "seriesKey" = $1 AND ok ORDER BY "createdAt" DESC LIMIT 1`, [DEPLOYS])).rows[0].id as string;
    const model = (async () => new Response(JSON.stringify({ model: 'm', message: { role: 'assistant', content: JSON.stringify({ probability: 0.62, reasonCode: 'trend' }) }, done: true, done_reason: 'stop', prompt_eval_count: 10, eval_count: 5 }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    expect(await runReason({ db: k.db, bus: new FakeBus(), config: { tz: TZ, ollama: OLLAMA }, load: async () => 'proceed', fetch: model, now: () => NOW }, { runId })).toEqual({ outcome: 'recorded' });
    const after = await series(DEPLOYS);
    expect(after.opinion).toEqual({ on: true, says: 'The local model said about 62%.', offer: false });
    expect(after.opinion!.says).toBe(opinionSays(0.62));
    plain(after.opinion!.says);
    // The forecaster's own answer is unchanged beside it, and the view holds nothing else the model said.
    expect(after.chance).toEqual(before.chance);
    expect(after.forecast).toEqual(before.forecast);
    expect(JSON.stringify(after)).not.toMatch(/trend"|muse-glimmer|ollama|0\.62|model_reasoning|reasonCode/);
    // The list of numbers says nothing of it at all.
    const p = await page();
    expect(JSON.stringify(p)).not.toMatch(/local model|62%|opinion":\{/i);
    // Switched off on this Mac the number reads as off, and so does its second opinion.
    expect((await series(DEPLOYS, offHere)).opinion).toBeNull();
    // A number on without it: it can be turned on from here where a local model is set, and the view says why not where none is.
    await sign((await call('POST', '/v1/predictions/turn-on', { series: [THREADS] })).body.id as string);
    expect((await series(THREADS)).opinion).toEqual({ on: false, says: 'The local model doesn’t estimate this number.', offer: true });
    expect((await series(THREADS, noModel)).opinion).toEqual({ on: false, says: 'No local model is set on this Mac.', offer: false });
    for (const s of [PANEL.noOpinion, PANEL.opinionOff, PANEL.noLocalModel]) plain(s);
  });

  it('it can be added to a number that is already on, with a card of its own; its forecasts are untouched', async () => {
    const was = await k.db.forecastSeries.findUniqueOrThrow({ where: { seriesKey: THREADS } });
    expect(was).toMatchObject({ on: true, reason: false });
    const filed = await call('POST', '/v1/predictions/turn-on', { series: [THREADS], opinion: true });
    expect(filed.status).toBe(200);
    expect((await cards()).at(-1)).toMatchObject({ id: filed.body.id, status: 'pending', args: { series: [THREADS], reason: [THREADS] }, sensitivity: 'ops', consequential: true });
    // Until Will signs, nothing changes.
    expect(await switches(THREADS)).toEqual({ on: true, reason: false });
    expect((await series(THREADS)).waiting).toBe(true);
    expect(await sign(filed.body.id as string)).toEqual({ on: 1, reason: 1 });
    expect(await switches(THREADS)).toEqual({ on: true, reason: true });
    expect((await series(THREADS)).opinion).toMatchObject({ on: true, offer: false });
  });

  it('turning it off needs no signature, is audited by the number’s key, and leaves the forecasts on', async () => {
    const before = await k.db.proposal.count();
    const estimates = async () => (await k.owner(`SELECT status, probability FROM "Prediction" WHERE "seriesKey" = $1 AND "createdBy" = 'runtime:reason'`, [DEPLOYS])).rows;
    expect(await estimates()).toEqual([{ status: 'open', probability: 0.62 }]);
    const off = await call('POST', `/v1/predictions/series/${DEPLOYS}/second-opinion-off`, {});
    expect([off.status, off.body]).toEqual([200, { ok: true }]);
    expect(await k.db.proposal.count()).toBe(before);
    expect(await switches(DEPLOYS)).toEqual({ on: true, reason: false });
    expect(await audits(OPINION_OFF_ACTION)).toEqual([
      { actor: 'will:console', context: 'console', kind: 'action', action: 'forecast.series.opinion_off', outcome: 'ok', inputs: { series: DEPLOYS }, correlationId: `${DEPLOYS}.opinion_off`, tainted: false },
    ]);
    const change = (await k.owner(`SELECT actor, changed FROM "RowChange" WHERE "tableName" = 'ForecastSeries' AND "rowId" = $1 ORDER BY at DESC LIMIT 1`, [DEPLOYS])).rows[0];
    expect(change).toMatchObject({ actor: 'will:console', changed: { reason: [true, false] } });
    // Its forecast is as it was, the estimate already made stays on the ledger, and the view offers it again.
    const s = await series(DEPLOYS);
    expect(s.number).toMatchObject({ on: true, state: 'range' });
    expect(s.opinion).toEqual({ on: false, says: PANEL.opinionOff, offer: true });
    expect(await estimates()).toEqual([{ status: 'open', probability: 0.62 }]);
    // A second time, a number that never had it, and a key outside the registry: each a sentence with its code.
    const again = await call('POST', `/v1/predictions/series/${DEPLOYS}/second-opinion-off`, {});
    expect([again.status, again.body]).toEqual([409, { error: 'The second opinion for this number is already off.', code: 'opinionOff' }]);
    expect((await call('POST', `/v1/predictions/series/${DOWNTIME}/second-opinion-off`, {})).body).toMatchObject({ code: 'opinionOff' });
    const unknown = await call('POST', '/v1/predictions/series/daily.spend.acme.usd/second-opinion-off', {});
    expect([unknown.status, unknown.body]).toEqual([404, { error: 'That number can’t be forecast.', code: 'unknown' }]);
    expect((await call('POST', `/v1/predictions/series/${DEPLOYS}/second-opinion-off`, { reason: false })).body).toMatchObject({ code: 'request' });
    expect(await audits(OPINION_OFF_ACTION)).toHaveLength(1);
    // It only narrows what Flint does, so it works with predictions switched off on this Mac too.
    const here = await call('POST', `/v1/predictions/series/${ANTHROPIC}/second-opinion-off`, {}, offHere);
    expect([here.status, here.body]).toEqual([200, { ok: true }]);
    expect(await switches(ANTHROPIC)).toEqual({ on: true, reason: false });
    // The runtime connector's token can no more turn it off than read a forecast.
    const r = await app.inject({ method: 'POST', url: `/v1/predictions/series/${THREADS}/second-opinion-off`, headers: { authorization: 'Bearer not-a-token', 'content-type': 'application/json' }, payload: '{}' });
    expect(r.statusCode).toBe(401);
    expect(await switches(THREADS)).toEqual({ on: true, reason: true });
  });

  it('a card that only changes second opinions leaves a waiting sheet card waiting; a card from the sheet replaces every waiting card, as it always did', async () => {
    const waiting = async () => (await cards()).filter((c) => c.status === 'pending').map((c) => c.id);
    const card = async (id: unknown) => (await cards()).find((c) => c.id === id)!;
    expect(await waiting()).toEqual([]);
    // Will ticked two more numbers in the sheet and has not signed yet. Both are off: a card that turns numbers on.
    const rest = await call('POST', '/v1/predictions/turn-on', { series: [DOWNTIME, CALENDAR] });
    expect([rest.status, rest.body]).toEqual([200, { id: rest.body.id, deduped: false }]);
    expect((await card(rest.body.id)).reason).toBe(FORECAST_REASONS.enable);
    // From one number's own view he asks for its second opinion again (Deploys is on, without it). The runtime says
    // what kind of card it filed: every number on it is already on. That is kept as the card's reason, for good.
    expect(await switches(DEPLOYS)).toEqual({ on: true, reason: false });
    const own = await call('POST', '/v1/predictions/turn-on', { series: [DEPLOYS], opinion: true });
    expect([own.status, own.body]).toEqual([200, { id: own.body.id, deduped: false, onlyOpinion: true }]);
    expect(await card(own.body.id)).toMatchObject({ status: 'pending', reason: FORECAST_REASONS.opinion, args: { series: [DEPLOYS], reason: [DEPLOYS] } });
    expect(FORECAST_REASONS.opinion).toBe('Approving changes only the local model’s second opinion on these numbers, which Flint already forecasts.');
    // Both wait: the card for the other two numbers is not thrown away, and can still be signed.
    expect((await waiting()).sort()).toEqual([rest.body.id, own.body.id].sort());
    expect((await page()).waiting.map((w) => [w.id, w.numbers]).sort()).toEqual([[rest.body.id, 2], [own.body.id, 1]].sort());
    expect([(await series(DOWNTIME)).waiting, (await series(DEPLOYS)).waiting, (await series(THREADS)).waiting]).toEqual([true, true, false]);
    // Asked for again, it is the card already waiting, and still said to be what it is.
    expect((await call('POST', '/v1/predictions/turn-on', { series: [DEPLOYS], opinion: true })).body).toEqual({ id: own.body.id, deduped: true, onlyOpinion: true });
    // Another card of the same kind that names Deploys replaces the Deploys card, and only that one.
    const wider = await call('POST', '/v1/predictions/turn-on', { series: [DEPLOYS, ANTHROPIC], opinion: true });
    expect(wider.body).toEqual({ id: wider.body.id, deduped: false, onlyOpinion: true });
    expect((await waiting()).sort()).toEqual([rest.body.id, wider.body.id].sort());
    expect(await card(own.body.id)).toMatchObject({ status: 'rejected' });
    expect((await k.db.proposal.findUniqueOrThrow({ where: { id: own.body.id as string } })).error).toBe('A newer version of this card replaced it.');
    // A card with even one number that is off is a card from the sheet: it turns a number on, it says nothing of
    // "only", and it replaces EVERY card still waiting, so exactly one is left (as before there were second opinions).
    const mixed = await call('POST', '/v1/predictions/turn-on', { series: [DEPLOYS, DOWNTIME], opinion: true });
    expect([mixed.status, mixed.body]).toEqual([200, { id: mixed.body.id, deduped: false }]);
    expect((await card(mixed.body.id)).reason).toBe(FORECAST_REASONS.enable);
    expect(await waiting()).toEqual([mixed.body.id]);
    for (const gone of [rest, wider]) expect((await k.db.proposal.findUniqueOrThrow({ where: { id: gone.body.id as string } })).error, String(gone.body.id)).toBe('A newer version of this card replaced it.');
    // And a second-opinion card for another number leaves that one waiting too.
    const other = await call('POST', '/v1/predictions/turn-on', { series: [ANTHROPIC], opinion: true });
    expect(other.body).toMatchObject({ onlyOpinion: true });
    expect((await waiting()).sort()).toEqual([mixed.body.id, other.body.id].sort());
    // It is signed, and does what it says: the second opinion, on a number that was on and stays on.
    expect(await sign(other.body.id as string)).toEqual({ on: 1, reason: 1 });
    expect(await switches(ANTHROPIC)).toEqual({ on: true, reason: true });
    await rejectProposal(k.db, mixed.body.id as string, { error: 'a test put it away' }, undefined, 'test');
    expect(await waiting()).toEqual([]);
  });

  it('a second-opinion card signed after its number was turned off is refused: it never turns forecasts back on', async () => {
    const card = async (id: unknown) => k.db.proposal.findUniqueOrThrow({ where: { id: id as string }, select: { status: true, reason: true, error: true } });
    expect(await switches(DEPLOYS)).toEqual({ on: true, reason: false });
    const own = await call('POST', '/v1/predictions/turn-on', { series: [DEPLOYS], opinion: true });
    expect(own.body).toEqual({ id: own.body.id, deduped: false, onlyOpinion: true });
    // The card on screen says only its second opinion changes. Before he signs, the number is turned off elsewhere.
    expect((await call('POST', `/v1/predictions/series/${DEPLOYS}/turn-off`, {})).status).toBe(200);
    expect(await switches(DEPLOYS)).toEqual({ on: false, reason: false });
    const said = 'This number’s forecasts were turned off, so this card no longer applies. File it again.';
    await expect(sign(own.body.id as string)).rejects.toMatchObject({ name: 'Refused', status: 409, message: said });
    // Nothing was turned on, and the card is over, saying why.
    expect(await switches(DEPLOYS)).toEqual({ on: false, reason: false });
    expect(await card(own.body.id)).toEqual({ status: 'failed', reason: FORECAST_REASONS.opinion, error: said });
    expect(noteProblems('Predictions', said)).toEqual([]);
    // Filed again, the number is off: this card turns it on, the runtime says nothing of "only", and signed, it does.
    const again = await call('POST', '/v1/predictions/turn-on', { series: [DEPLOYS], opinion: true });
    expect(again.body).toEqual({ id: again.body.id, deduped: false });
    expect(again.body.id).not.toBe(own.body.id);
    expect((await card(again.body.id)).reason).toBe(FORECAST_REASONS.enable);
    expect(await sign(again.body.id as string)).toEqual({ on: 1, reason: 1 });
    expect(await switches(DEPLOYS)).toEqual({ on: true, reason: true });
    // Several numbers on one such card (from the command line), one of them turned off since: the same, in its own words.
    await call('POST', `/v1/predictions/series/${DEPLOYS}/second-opinion-off`, {});
    await call('POST', `/v1/predictions/series/${ANTHROPIC}/second-opinion-off`, {});
    const two = await proposeForecasts(k.db, [DEPLOYS, ANTHROPIC], new Date(), 'console', true);
    expect(two).toMatchObject({ deduped: false, onlyOpinion: true });
    await call('POST', `/v1/predictions/series/${ANTHROPIC}/turn-off`, {});
    await expect(sign(two.id)).rejects.toMatchObject({ status: 409, message: 'Forecasts for one of these numbers were turned off, so this card no longer applies. File it again.' });
    // Not half of it either: Deploys' second opinion is as it was.
    expect([await switches(DEPLOYS), await switches(ANTHROPIC)]).toEqual([{ on: true, reason: false }, { on: false, reason: false }]);
    // (Anthropic back on for the tests below, by the card that turns it on.)
    await sign((await call('POST', '/v1/predictions/turn-on', { series: [ANTHROPIC] })).body.id as string);
    expect(await switches(ANTHROPIC)).toEqual({ on: true, reason: false });
  });

  it('a card still waiting with the same lists but of the other kind is replaced, never handed back as this one', async () => {
    const card = async (id: unknown) => k.db.proposal.findUniqueOrThrow({ where: { id: id as string }, select: { status: true, reason: true, error: true } });
    const waiting = async () => (await cards()).filter((c) => c.status === 'pending').map((c) => c.id);
    expect([await waiting(), await switches(CALENDAR)]).toEqual([[], null]);
    // The sheet: Calendar Hours with its second opinion. It is off, so this card turns it on. He does not sign yet.
    const first = await call('POST', '/v1/predictions/turn-on', { series: [CALENDAR], opinion: true });
    expect(first.body).toEqual({ id: first.body.id, deduped: false });
    // Meanwhile the number is turned on another way (the command line's card, signed).
    const cli = await proposeForecasts(k.db, [CALENDAR]);
    expect(cli).toMatchObject({ deduped: false, onlyOpinion: false });
    expect(await sign(cli.id)).toEqual({ on: 1, reason: 0 });
    expect(await switches(CALENDAR)).toEqual({ on: true, reason: false });
    expect((await card(first.body.id)).status).toBe('pending');
    // Now he asks for its second opinion from its own view: the very lists of the card still waiting. That card
    // would turn forecasts on if they were off by the time he signed; this one must not. So it is a new card.
    const second = await call('POST', '/v1/predictions/turn-on', { series: [CALENDAR], opinion: true });
    expect(second.body).toEqual({ id: second.body.id, deduped: false, onlyOpinion: true });
    expect(second.body.id).not.toBe(first.body.id);
    expect(await card(first.body.id)).toEqual({ status: 'rejected', reason: FORECAST_REASONS.enable, error: 'A newer version of this card replaced it.' });
    expect((await card(second.body.id)).reason).toBe(FORECAST_REASONS.opinion);
    expect(await waiting()).toEqual([second.body.id]);
    // And the other way round: the number is turned off, and he ticks it on the sheet with its second opinion.
    // The card still waiting says "only its second opinion changes" and would be refused; the sheet's card replaces it.
    expect((await call('POST', `/v1/predictions/series/${CALENDAR}/turn-off`, {})).status).toBe(200);
    const third = await call('POST', '/v1/predictions/turn-on', { series: [CALENDAR], opinion: true });
    expect(third.body).toEqual({ id: third.body.id, deduped: false });
    expect(await card(second.body.id)).toMatchObject({ status: 'rejected', error: 'A newer version of this card replaced it.' });
    expect((await card(third.body.id)).reason).toBe(FORECAST_REASONS.enable);
    expect(await waiting()).toEqual([third.body.id]);
    expect(await sign(third.body.id as string)).toEqual({ on: 1, reason: 1 });
    expect(await switches(CALENDAR)).toEqual({ on: true, reason: true });
  });

  it('no log line holds what the model said, a number’s value or a card’s numbers', async () => {
    // A request's line holds how long it took, in milliseconds with a fraction: a number like any other ("0.629" is
    // not what the model said). The timing is taken out, and what is looked for is the whole number.
    const untimed = (l: string) => l.replace(/"responseTime":-?[0-9.]+(e[+-]?[0-9]+)?,?/gi, '');
    expect(untimed('{"level":30,"responseTime":0.6291659995913506,"msg":"request completed"}')).toBe('{"level":30,"msg":"request completed"}');
    expect(untimed('{"res":{"statusCode":200},"responseTime":6.2e-1}')).toBe('{"res":{"statusCode":200},}');
    const said = lines.map(untimed).join('\n');
    // (They are the requests above: this is not an empty log.)
    expect(lines.length).toBeGreaterThan(20);
    expect(said).toMatch(/second-opinion-off/);
    expect(said).not.toMatch(/responseTime/);
    expect(said).not.toMatch(/(?<![0-9.])0\.62(?![0-9])|62%|The local model|muse-glimmer/);
    expect(said).not.toMatch(/"series":\s*\[/);
    // The check can see what it looks for.
    expect('{"msg":"said 0.62"}').toMatch(/(?<![0-9.])0\.62(?![0-9])/);
    expect('{"x":10.62,"y":0.629,"z":0.0625}').not.toMatch(/(?<![0-9.])0\.62(?![0-9])/);
  });
});

describe.skipIf(NO_DB)('Accuracy compares the local model with the other answers to the same questions', () => {
  let urls: TestUrls;
  let k: LedgerKit;
  let app: ReturnType<typeof buildApp>;
  const NOW = new Date();
  const start = (daysAgo: number) => dayStart(daysAgo, NOW);
  const accuracy = async () => AccuracyView.parse(JSON.parse((await app.inject({ method: 'GET', url: '/v1/predictions/accuracy', headers: { authorization: `Bearer ${SERVER}` } })).body));
  const area = async (name: string) => (await accuracy()).areas.find((a) => a.name === name);

  /** A number that is on with its second opinion. */
  async function number(seriesKey: string): Promise<void> {
    const d = forecastSeries(seriesKey)!;
    await k.series({ key: d.key, unit: d.unit, freq: freqOf(d), sensitivity: d.sensitivity, description: d.description });
    await k.turnOn([seriesKey], [seriesKey]);
  }
  /**
   * One past day's question, answered twice on one run: by the forecaster (as a forecast that beat a plain guess, or
   * as the usual rate) and by the local model. The day's number then comes in above the threshold: yes.
   */
  async function pair(seriesKey: string, daysAgo: number, o: { forecaster: number | null; model: number | null; beat: boolean; domain?: string }): Promise<{ run: string; forecaster?: string; model?: string }> {
    const at = start(daysAgo);
    const rid = await k.run(seriesKey, { beatsNaive: o.beat, points: [{ at: at.toISOString(), mean: 104, lo: 96, hi: 112 }] });
    const made = { madeAgo: Date.now() - at.getTime() - 4 * HOUR, dueAgo: 60_000 };
    const area = o.domain ? { domain: o.domain } : {};
    const forecaster = o.forecaster === null ? undefined : await k.question(seriesKey, at, 'above', 100, { probability: o.forecaster, method: o.beat ? 'statistical' : 'base_rate', forecastRunId: rid, ...area }, made);
    const model = o.model === null ? undefined : await k.question(seriesKey, at, 'above', 100, { probability: o.model, method: 'model_reasoning', createdBy: 'runtime:reason', model: 'ollama:muse-glimmer:30b', forecastRunId: rid, ...area }, made);
    await k.point(seriesKey, at, 105);
    return { run: rid, ...(forecaster ? { forecaster } : {}), ...(model ? { model } : {}) };
  }
  /** What chat's calibration tool reads, without each row's own id and time. */
  const calibration = async () => {
    const r = await app.inject({ method: 'GET', url: '/v1/ledger/calibration', headers: { authorization: `Bearer ${SERVER}` } });
    expect(r.statusCode).toBe(200);
    return (JSON.parse(r.body).snapshots as Array<Record<string, unknown>>)
      .map(({ id: _id, computedAt: _at, ...row }) => row)
      .sort((a, b) => (JSON.stringify([a.domain, a.type, a.method, a.kind]) < JSON.stringify([b.domain, b.type, b.method, b.kind]) ? -1 : 1));
  };
  const score = async () => {
    expect(await sweep(k.db, { tz: TZ, resolve: true, expire: true, limit: 5000 })).toMatchObject({ refused: 0, unknownSpec: 0 });
    const end = new Date(Date.now() + 60_000);
    await snapshotCalibration(k.db, new Date(end.getTime() - 90 * DAY), end, TZ);
  };

  beforeAll(async () => {
    urls = await freshDb();
    k = await ledgerKit(urls);
    app = buildApp({ db: k.db, config: { tokens, tz: TZ, predict: true, ollama: OLLAMA } });
  }, 120_000);
  afterAll(async () => {
    await app?.close();
    await k?.db.$disconnect();
  });

  it('before 30 questions both answered it says how far along it is; a number without a second opinion says nothing of one', async () => {
    await number(DEPLOYS);
    await number(CALENDAR);
    // Deploys: 12 forecasts the local model also answered, and 5 answered with the usual rate.
    for (let i = 0; i < 12; i++) await pair(DEPLOYS, 2 + i, { forecaster: 0.6, model: 0.8, beat: true });
    for (let i = 0; i < 5; i++) await pair(DEPLOYS, 20 + i, { forecaster: 0.7, model: 0.4, beat: false });
    // Calendar: forecasts only (its second opinion never answered).
    for (let i = 0; i < 6; i++) await pair(CALENDAR, 2 + i, { forecaster: 0.6, model: null, beat: true });
    await score();
    const deploys = (await area('Deploys'))!;
    // The area's own lines count each question once, by the forecaster's answer (17). The local model's 17 second
    // answers to the same questions are not pooled into them: the comparison is its last line, and its only one.
    expect(deploys.value).toBe('17 Scored');
    expect(deploys.lines.at(-1)).toBe('The local model has 12 of the 30 results it needs to be compared.');
    expect(deploys.lines.at(-1)).toBe(opinionTooFewSays(12, 30));
    expect(deploys.lines.filter((l) => /local model/.test(l))).toHaveLength(1);
    const calendar = (await area('Calendar'))!;
    expect(calendar.lines.join(' ')).not.toMatch(/local model/);
  });

  it('from 30 on: a sentence against the forecast, and one against the usual rate, each from the questions both answered', async () => {
    // 18 more forecasts (30 in all): the local model said 80% and the forecast 60%, and each time it happened.
    for (let i = 0; i < 18; i++) await pair(DEPLOYS, 30 + i, { forecaster: 0.6, model: 0.8, beat: true });
    await score();
    let deploys = (await area('Deploys'))!;
    expect(deploys.lines.filter((l) => /local model/.test(l))).toEqual(['Over 30 questions, the local model was closer than the forecast.']);
    // The usual rate's questions are still too few to say (5), and the sentence above already speaks for the model.
    // 25 more of those (30 in all): the usual rate said 70% and the local model 40%, and each time it happened.
    for (let i = 0; i < 25; i++) await pair(DEPLOYS, 50 + i, { forecaster: 0.7, model: 0.4, beat: false });
    await score();
    deploys = (await area('Deploys'))!;
    expect(deploys.lines.slice(-2)).toEqual([
      'Over 30 questions, the local model was closer than the forecast.',
      'Over 30 questions, the usual rate was closer than the local model.',
    ]);
    expect(deploys.lines.slice(-2)).toEqual([opinionVersusSays('forecast', 30, 'closer'), opinionVersusSays('usual', 30, 'further')]);
    for (const l of deploys.lines) expect(noteProblems('Predictions', l), l).toEqual([]);
    // Counts and fixed words only: no method's name, no score, no model's.
    expect(deploys.lines.slice(-2).join(' ')).not.toMatch(/statistical|base.rate|model_reasoning|0\.\d|muse|ollama/i);
  });

  it('about as well is said as that; and a question only one of them answered is not in the comparison', async () => {
    await number(ANTHROPIC);
    // 30 questions where the two said nearly the same, and 10 the local model never answered.
    for (let i = 0; i < 30; i++) await pair(ANTHROPIC, 2 + i, { forecaster: 0.6, model: 0.605, beat: true });
    for (let i = 0; i < 10; i++) await pair(ANTHROPIC, 40 + i, { forecaster: 0.6, model: null, beat: true });
    await score();
    const spend = (await area('Spend'))!;
    expect(spend.lines.at(-1)).toBe('Over 30 questions, the local model and the forecast did about as well.');
    // 40 questions, 40 scored: the model's 30 second answers are not counted again.
    expect(spend.value).toBe('40 Scored');
    // Deploys is as it was: each area's comparison is its own.
    expect((await area('Deploys'))!.lines.slice(-2)).toEqual([opinionVersusSays('forecast', 30, 'closer'), opinionVersusSays('usual', 30, 'further')]);
  });

  it('"about as well" is for scores within 0.01 of each other: a real difference smaller than 0.1 is said as one', async () => {
    expect(SAME_SCORE).toBe(0.01);
    await number(THREADS);
    await number(DOWNTIME);
    // It happened each time. The forecast said 60% (an error of 0.16) and the local model 70% (0.09): 0.07 apart.
    for (let i = 0; i < 30; i++) await pair(THREADS, 2 + i, { forecaster: 0.6, model: 0.7, beat: true, domain: 'projects' });
    // And the other way, by less: the forecast 62% (0.1444) and the local model 60% (0.16): 0.0156 apart.
    for (let i = 0; i < 30; i++) await pair(DOWNTIME, 2 + i, { forecaster: 0.62, model: 0.6, beat: true, domain: 'services' });
    await score();
    expect((await area('Projects'))!.lines.at(-1)).toBe('Over 30 questions, the local model was closer than the forecast.');
    expect((await area('Services'))!.lines.at(-1)).toBe('Over 30 questions, the forecast was closer than the local model.');
    // Spend's two were 0.004 apart: still "about as well".
    expect((await area('Spend'))!.lines.at(-1)).toBe(opinionVersusSays('forecast', 30, 'same'));
  });

  it('a question only the local model has a counted answer to is not in the comparison: nothing is paired across runs', async () => {
    const before = (await area('Spend'))!;
    // Two more of Anthropic's questions, the model badly wrong on both (5% for what happened). On the first the
    // forecaster's own answer was voided; the second run has no answer of the forecaster's at all.
    const voided = await pair(ANTHROPIC, 60, { forecaster: 0.6, model: 0.05, beat: true });
    await k.past('Prediction', ['Prediction_guard', 'Prediction_valid_update'], (q) => q(`UPDATE "Prediction" SET status = 'void' WHERE id = $1`, [voided.forecaster]));
    const alone = await pair(ANTHROPIC, 61, { forecaster: null, model: 0.05, beat: true });
    expect(alone.forecaster).toBeUndefined();
    await score();
    for (const pid of [voided.model!, alone.model!]) expect(await k.status(pid), pid).toBe('resolved');
    const after = (await area('Spend'))!;
    // Still 30 questions, and still about as well: paired with any other run's answer, those two would have tipped it.
    expect(after.lines.at(-1)).toBe('Over 30 questions, the local model and the forecast did about as well.');
    expect(after.lines.filter((l) => /local model/.test(l))).toEqual(before.lines.filter((l) => /local model/.test(l)));
  });

  it('chat’s calibration, and the night’s scores it reads, do not move with a number’s second opinions', async () => {
    // One window for both nights, so the rows are the same rows.
    const end = new Date(Date.now() + 60_000);
    const from = new Date(end.getTime() - 90 * DAY);
    const night = async () => {
      expect(await sweep(k.db, { tz: TZ, resolve: true, expire: true, limit: 5000 })).toMatchObject({ refused: 0, unknownSpec: 0 });
      await snapshotCalibration(k.db, from, end, TZ);
      return calibration();
    };
    const before = await night();
    // Calendar's six questions have the forecaster's answer only, so far.
    expect(before.find((r) => r.domain === 'calendar' && r.kind === 'binary')).toMatchObject({ method: 'statistical', n: 6 });
    // Its second opinion is on. The local model answers each of the six, confidently, and they settle.
    const runs = (await k.owner(`SELECT "forecastRunId" AS rid, "resolverSpec"->>'at' AS at FROM "Prediction" WHERE "seriesKey" = $1 AND "createdBy" = 'runtime:forecast' ORDER BY "resolveBy"`, [CALENDAR])).rows as Array<{ rid: string; at: string }>;
    expect(runs).toHaveLength(6);
    const added: string[] = [];
    for (const r of runs) {
      const at = new Date(r.at);
      added.push(await k.question(CALENDAR, at, 'above', 100, { probability: 0.9, method: 'model_reasoning', createdBy: 'runtime:reason', model: 'ollama:muse-glimmer:30b', forecastRunId: r.rid }, { madeAgo: Date.now() - at.getTime() - 4 * HOUR, dueAgo: 60_000 }));
    }
    const after = await night();
    for (const pid of added) expect(await k.status(pid), pid).toBe('resolved');
    // Not a row, not a count, not a score is different: what chat reads of Flint's accuracy is what it read before.
    expect(after).toEqual(before);
    expect(after.filter((r) => r.method === 'model_reasoning')).toEqual([]);
    expect(JSON.stringify(after)).not.toMatch(/runtime:reason|muse-glimmer/);
    // The panel does show them, where they belong: beside the forecaster's answers to the same six questions.
    const calendar = (await area('Calendar'))!;
    expect(calendar.value).toBe('6 Scored');
    expect(calendar.lines.at(-1)).toBe(opinionTooFewSays(6, 30));
  });
});
