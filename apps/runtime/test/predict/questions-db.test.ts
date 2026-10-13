/**
 * Will's questions on flint_test (P4 part 4): what Flint asks him each morning
 * about the predictions only he can settle.
 *
 *  - Only a due, unresolved yes/no prediction that only Will resolves is asked
 *    about, once, oldest first.
 *  - At most five new questions a day: the slot and the question are written
 *    together, so three runs at once never ask a sixth, and a question the
 *    database refuses gives its slot back.
 *  - While the action is at APPROVAL a question is recorded in shadow: it waits
 *    in the panel, and neither the digest nor the header's dot announces it.
 *    Once Will lets Flint ask on its own, new ones are not shadow, and the
 *    digest gains one sentence with their count.
 *  - A question waits two weeks from when Will was told of it; after that it is
 *    gone from the list. One asked in shadow was announced to nobody: its two
 *    weeks start when he first lets Flint ask on its own, and until then it is
 *    never run out, stays on the list and stays answerable.
 *  - A rule that forbids asking stops it, and the audit says skipped.
 *  - The job exists only while FLINT_PREDICT is on, and does nothing until
 *    Will has turned predictions on.
 *  - The audit entry of a run holds counts and ids, never a prediction's words.
 * Synthetic predictions; Flint's zone is UTC here.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { digestOf, noteProblems, periodKey } from '@flint/policy';
import { NO_DB, freshDb, type TestUrls } from '../db';
import { DAY, HOUR, MIN, TZ, ledgerKit, type LedgerKit } from '../ledger/kit';
import { enrollTestKey } from '../sign';
import type { Config } from '../../src/config';
import type { Bus } from '../../src/bus';
import { buildDigest, digestBody, digestTitle, questionsSentence } from '../../src/digest';
import { approveProposal, createProposal } from '../../src/governance/proposals';
import { runInternal } from '../../src/governance/internal';
import { ASK_CRON, predictJobs } from '../../src/jobs';
import { WILL_GRACE_MS, announcedSince, questionLapsed, sweep } from '../../src/ledger/sweep';
import { ANSWER_ACTION, ASK_ACTION, MAX_SAID, answerQuestion, askQuestions, fitRow, questionsPage, questionsWaiting } from '../../src/predict/questions';
import { questionsAnnounced } from '../../src/predict/view';

const WORDS = 'CANARY-question-words';

describe('the questions sentence in the digest', () => {
  it('is a count in a sentence, held to the notes\' rules, and absent when none wait', () => {
    expect(questionsSentence(0)).toBe('');
    expect(questionsSentence(1)).toBe('Flint has 1 question for you in Predictions.');
    expect(questionsSentence(2)).toBe('Flint has 2 questions for you in Predictions.');
    for (const n of [1, 2, 5, 40]) expect(noteProblems(digestTitle('2026-10-11'), questionsSentence(n)), String(n)).toEqual([]);
    const zero = { relevant: 0, quiet: 0, escalated: 0, did: 0, queued: 0, open: 0, due: 0 };
    expect(digestBody({ ...zero, questions: 0 }, [])).toBe(digestBody(zero, []));
    const lines = digestBody({ ...zero, questions: 2 }, []).split('\n');
    expect(lines[lines.length - 1]).toBe('Flint has 2 questions for you in Predictions.');
    expect(noteProblems(digestTitle('2026-10-11'), lines.join('\n'))).toEqual([]);
    // With every count large and every line at its longest, the digest still fits the note's 500 characters.
    const big = { relevant: 99_999, quiet: 99_999, escalated: 99_999, did: 99_999, queued: 9_999, open: 9_999, due: 9_999, goalsReviewed: 200, goalsLate: 199, questions: 50 };
    const many = ['audit_intents', 'backup', 'bus', 'migrate_failed', 'ollama', 'restore_drill', 'retention', 'server', 'goals', 'source:google_calendar'];
    expect(digestBody(big, many).length).toBeLessThanOrEqual(500);
    expect(digestBody(big, many).endsWith('Flint has 50 questions for you in Predictions.')).toBe(true);
  });

  it('the job\'s time: 07:20, ten minutes before the digest that may count the questions', () => {
    expect(ASK_CRON).toBe('20 7 * * *');
  });

  it('a question\'s two weeks: from when it was asked if it was announced then; from when Will first let Flint ask, if it was asked in shadow; never, while nothing announces it', () => {
    const now = new Date('2026-10-20T12:00:00Z');
    const ago = (ms: number) => new Date(now.getTime() - ms);
    expect(WILL_GRACE_MS).toBe(14 * DAY);
    // Announced when asked: two weeks from then, whatever came later.
    expect(questionLapsed({ askedAt: ago(13 * DAY), shadow: false }, null, now)).toBe(false);
    expect(questionLapsed({ askedAt: ago(14 * DAY + MIN), shadow: false }, null, now)).toBe(true);
    expect(questionLapsed({ askedAt: ago(14 * DAY + MIN), shadow: false }, ago(DAY), now)).toBe(true);
    // Asked in shadow and never announced: it never runs out, however old.
    for (const days of [1, 15, 400]) expect(questionLapsed({ askedAt: ago(days * DAY), shadow: true }, null, now), String(days)).toBe(false);
    // Asked in shadow, then announced: two weeks from the later of the two.
    expect(questionLapsed({ askedAt: ago(40 * DAY), shadow: true }, ago(13 * DAY), now)).toBe(false);
    expect(questionLapsed({ askedAt: ago(40 * DAY), shadow: true }, ago(14 * DAY + MIN), now)).toBe(true);
    expect(questionLapsed({ askedAt: ago(3 * DAY), shadow: true }, ago(30 * DAY), now)).toBe(false);
    expect(questionLapsed({ askedAt: ago(15 * DAY), shadow: true }, ago(30 * DAY), now)).toBe(true);
  });
});

describe('a question\'s row, whatever it holds', () => {
  const plain = { id: 'pdabc123', title: 'Flint made this prediction in a chat.', says: 'Flint can’t show what this one was about, so it can only be skipped.', answer: null, answerable: false };
  const good = { ...plain, title: 'The deploy lands by Friday', says: 'Flint said likely, around 70%, on Oct 3. It was due Oct 5 at 3:00 PM.', answerable: true };

  it('a row that fits the panel\'s contract is passed on as it is', () => {
    expect(fitRow(good, plain)).toEqual(good);
    expect(fitRow(plain, plain)).toEqual(plain);
  });

  it('one that would break it is never passed on and never fails the page: the plain row stands in, Skip only', () => {
    for (const bad of [
      { ...good, title: 'x'.repeat(301) },
      { ...good, title: '' },
      { ...good, says: 'No stop' },
      { ...good, says: 'Flint said likely (around 70%).' },
      { ...good, says: `${'a'.repeat(400)}.` },
      { ...good, answer: 'maybe' },
      { ...good, answerable: 'yes' },
      { ...good, probability: 0.7 },
      { ...good, claim: 'the stored words' },
      null,
      'a row',
    ]) {
      const shown = fitRow(bad, plain);
      expect(shown, JSON.stringify(bad)?.slice(0, 60)).toEqual(plain);
      expect(shown!.answerable).toBe(false);
    }
    // A row whose own id is no id cannot be shown at all: it is left out, and the rest of the page stands.
    expect(fitRow({ ...good, id: 'pd abc' }, { ...plain, id: 'pd abc' })).toBeUndefined();
  });

  it('a value past what any number of Flint\'s takes is not said: the bound is far above any real one, and far below what would overflow a title', () => {
    expect(MAX_SAID).toBe(1e12);
    expect((1e12).toLocaleString('en-US').length).toBeLessThan(20);
  });
});

describe.skipIf(NO_DB)('Will\'s questions on flint_test', () => {
  let urls: TestUrls;
  let k: LedgerKit;
  let key: Awaited<ReturnType<typeof enrollTestKey>>;
  /** A question asked in shadow fifteen days ago and never answered: kept from one test to the next. */
  let quietKept: string;
  /** A prediction Flint made in a chat, which only Will resolves, due `dueAgo` ms ago. */
  const wills = (dueAgo: number, over: Record<string, unknown> = {}) =>
    k.prediction({ method: 'model_reasoning', resolver: 'will', createdBy: 'client:server', domain: 'projects', probability: 0.7, claim: `${WORDS} happens`, ...over }, { madeAgo: Math.max(dueAgo, 0) + 2 * DAY, dueAgo });
  const questions = async () => (await k.owner(`SELECT "predictionId", shadow, answer, "askedAt" FROM "PredictionQuestion" ORDER BY "askedAt", "predictionId"`)).rows as Array<{ predictionId: string; shadow: boolean; answer: string | null; askedAt: Date }>;
  const asked = async (ids: string[]) => (await questions()).filter((q) => ids.includes(q.predictionId)).map((q) => q.predictionId);
  const counter = async (day: string) => ((await k.owner(`SELECT count FROM "ActionCounter" WHERE action = $1 AND day = $2`, [ASK_ACTION, day])).rows[0]?.count as number | undefined) ?? 0;
  const audits = async () => (await k.owner(`SELECT actor, context, kind, action, tier, decision, outcome, inputs, reasoning, "outcomeDetail" FROM "AuditEntry" WHERE action = $1 ORDER BY seq DESC`, [ASK_ACTION])).rows;
  /**
   * A day of Flint's, `n` days back: its own cap. (A run's audit entry is stamped with the run's own clock, and the
   * database takes no entry from the future, so the days these tests need are past ones: a prediction here is made
   * due well before the day that asks about it.)
   */
  const daysBack = (n: number) => new Date(Date.now() - n * DAY);
  const dayKey = (at: Date) => periodKey({ period: 'day' }, TZ, at);
  /** Will signs a rule for an action: it runs on its own, or is forbidden. */
  async function rule(pattern: string, tier: 'alone' | 'forbidden') {
    const args = { rows: [{ pattern, tier, expiresAt: new Date(Date.now() + 30 * DAY).toISOString(), reason: 'test' }] };
    const p = await createProposal(k.db, { kind: 'policy', origin: 'console', action: 'policy.change', args, argsProvenance: { rows: { source: 'will', tainted: false } }, tainted: false, sensitivity: 'ops', destructive: false, consequential: false, ttlMinutes: 60 }, 'will:console');
    await approveProposal(k.db, p.id, await key.approve({ subjectId: p.id, action: 'policy.change', argsDigest: digestOf(args) }), undefined, 'test');
    await runInternal(k.db, p.id, undefined, TZ, 'test');
  }

  beforeAll(async () => {
    urls = await freshDb();
    k = await ledgerKit(urls);
    key = await enrollTestKey(urls);
  });
  afterAll(async () => k?.db.$disconnect());

  it('a question the database refuses gives its slot back: one not due yet by the database\'s own clock is not asked, and not counted', async () => {
    const due = [await wills(2 * HOUR), await wills(HOUR)];
    // Due in three minutes. A run whose clock is a little ahead reads it as due; the database, by its own clock, does not.
    const ahead = await wills(-3 * MIN);
    const now = new Date(Date.now() + 4.5 * MIN);
    const before = await counter(dayKey(now));
    expect(await askQuestions(k.db, { tz: TZ, now })).toEqual({ due: 3, asked: 2, capped: 0, refused: 1, shadow: true, allowed: true });
    expect((await asked([...due, ahead])).sort()).toEqual([...due].sort());
    expect(await counter(dayKey(now))).toBe(before + 2);
  });

  it('asks only about due, unresolved yes/no predictions only Will resolves, oldest first, and at most five in a day', async () => {
    // Eight of his, due twenty days and one to eight hours ago; and three that are never asked about.
    const due: string[] = [];
    for (let h = 8; h >= 1; h--) due.push(await wills(20 * DAY + h * HOUR));
    const notYet = await wills(DAY);
    const itself = await k.prediction({ method: 'rule', resolver: 'auto_world' }, { madeAgo: 30 * DAY, dueAgo: 21 * DAY });
    const alreadyAsked = await wills(22 * DAY);
    await k.asked(alreadyAsked, HOUR);
    // Ten days back: `notYet` was not due then.
    const now = daysBack(10);
    const c = await askQuestions(k.db, { tz: TZ, now });
    expect(c).toEqual({ due: 8, asked: 5, capped: 3, refused: 0, shadow: true, allowed: true });
    // The five oldest, and no other.
    expect((await asked(due)).sort()).toEqual(due.slice(0, 5).sort());
    expect(await asked([notYet, itself])).toEqual([]);
    expect((await questions()).filter((q) => q.predictionId === alreadyAsked)).toHaveLength(1);
    expect(await counter(dayKey(now))).toBe(5);
    // Recorded in shadow, each unanswered, asked now by the database's own clock.
    for (const q of (await questions()).filter((x) => due.includes(x.predictionId))) {
      expect(q).toMatchObject({ shadow: true, answer: null });
      expect(Math.abs(q.askedAt.getTime() - Date.now())).toBeLessThan(MIN);
    }
    // The same day again: the cap is reached, nothing more is asked, nothing is counted twice.
    expect(await askQuestions(k.db, { tz: TZ, now })).toEqual({ due: 3, asked: 0, capped: 3, refused: 0, shadow: true, allowed: true });
    expect(await counter(dayKey(now))).toBe(5);

    // One audit entry a run: counts and the ids asked, never a prediction's words.
    const [second, first] = await audits();
    expect(first).toMatchObject({ actor: 'runtime:ledger', context: 'autonomous', kind: 'action', tier: 'approval', decision: 'log', outcome: 'ok', reasoning: null, outcomeDetail: null });
    expect(first!.inputs).toEqual({ due: 8, asked: 5, capped: 3, refused: 0, shadow: true, predictionIds: expect.arrayContaining(due.slice(0, 5)) as unknown });
    expect(second!.inputs).toEqual({ due: 3, asked: 0, capped: 3, refused: 0, shadow: true });
    expect(JSON.stringify(await audits())).not.toContain(WORDS);

    // The next day takes the three left.
    const next = daysBack(9);
    expect(await askQuestions(k.db, { tz: TZ, now: next })).toEqual({ due: 3, asked: 3, capped: 0, refused: 0, shadow: true, allowed: true });
    expect((await asked(due)).sort()).toEqual([...due].sort());
    expect(await asked([notYet])).toEqual([]);
    expect(await counter(dayKey(next))).toBe(3);
  });

  it('three runs at once never ask a sixth, nor the same question twice', async () => {
    const due: string[] = [];
    for (let i = 0; i < 12; i++) due.push(await wills(15 * DAY + i * MIN));
    const day = daysBack(8);
    const before = (await questions()).length;
    const runs = await Promise.all([askQuestions(k.db, { tz: TZ, now: day }), askQuestions(k.db, { tz: TZ, now: day }), askQuestions(k.db, { tz: TZ, now: day })]);
    expect(runs.reduce((t, c) => t + c.asked, 0)).toBe(5);
    expect(await counter(dayKey(day))).toBe(5);
    const mine = await asked(due);
    expect(mine).toHaveLength(5);
    expect(new Set(mine).size).toBe(5);
    expect((await questions()).length).toBe(before + 5);
    // Oldest first, even so: the five asked are the five due longest.
    expect([...mine].sort()).toEqual(due.slice(-5).sort());
  });

  it('a question nobody announced does not start the two weeks: fifteen days on it is still open, still listed and still his to answer', async () => {
    expect(await announcedSince(k.db)).toBeNull();
    const [quiet, kept, skipped, announced] = [await wills(20 * DAY), await wills(21 * DAY), await wills(22 * DAY), await wills(23 * DAY)];
    // Three asked in shadow fifteen days ago (no dot, no line in the morning summary), and one that was announced then.
    for (const p of [quiet, kept, skipped]) await k.asked(p, 15 * DAY, { shadow: true });
    await k.asked(announced, 15 * DAY);
    // One of the quiet ones he saw and skipped: that one he was shown, so it runs out two weeks after it was asked.
    await answerQuestion(k.db, skipped, 'skip', { tz: TZ });
    const before = await questionsWaiting(k.db);
    // (The sweep also runs out what else in this file is past its time: only these four are looked at.)
    await sweep(k.db, { tz: TZ, resolve: true, expire: true });
    expect([await k.status(quiet), await k.status(kept), await k.status(skipped), await k.status(announced)]).toEqual(['open', 'open', 'expired', 'expired']);
    // Still listed, and counted, though older than two weeks.
    const listed = (await questionsPage(k.db, { tz: TZ })).waiting.map((q) => q.id);
    expect(listed).toEqual(expect.arrayContaining([quiet, kept]));
    expect(listed).not.toContain(announced);
    expect(listed).not.toContain(skipped);
    expect(await questionsWaiting(k.db)).toBe(before);
    // And still answerable: his answer is taken, and scored like any other.
    await answerQuestion(k.db, quiet, 'yes', { tz: TZ });
    expect(await k.resolution(quiet)).toMatchObject({ outcome: true, resolvedBy: 'will' });
    await expect(answerQuestion(k.db, announced, 'yes', { tz: TZ })).rejects.toMatchObject({ name: 'Refused', status: 409, message: 'That question no longer exists.' });
    // A second sweep changes nothing: the one left is as open as before.
    expect((await sweep(k.db, { tz: TZ, resolve: true, expire: true })).expired).toBe(0);
    expect(await k.status(kept)).toBe('open');
    quietKept = kept;
  });

  it('in shadow nothing announces them: no dot, no digest line; once Will lets Flint ask on its own, new ones are announced', async () => {
    const waiting = await questionsWaiting(k.db);
    expect(waiting).toBeGreaterThan(0);
    expect(await questionsAnnounced(k.db)).toBe(false);
    const quiet = await buildDigest(k.db, TZ);
    expect(quiet.counts.questions).toBe(0);
    expect(quiet.body).not.toContain('Predictions.');

    await rule(ASK_ACTION, 'alone');
    expect(await questionsAnnounced(k.db)).toBe(true);
    // Today, by the real clock: what is left of today's five.
    const now = new Date();
    const left = 5 - (await counter(dayKey(now)));
    expect(left).toBeGreaterThan(0);
    const loudBefore = (await questions()).filter((q) => !q.shadow).length;
    const c = await askQuestions(k.db, { tz: TZ, now });
    expect(c).toMatchObject({ asked: left, shadow: false, allowed: true });
    expect((await questions()).filter((q) => !q.shadow)).toHaveLength(loudBefore + left);
    expect((await audits())[0]).toMatchObject({ tier: 'alone', decision: 'act', outcome: 'ok' });
    // The digest counts every question that waits, in one sentence, and says none of their words.
    const loud = await buildDigest(k.db, TZ);
    expect(loud.counts.questions).toBe(await questionsWaiting(k.db));
    expect(loud.body.split('\n')).toContain(questionsSentence(loud.counts.questions!));
    expect(loud.body).not.toContain(WORDS);
    expect(noteProblems(loud.title, loud.body)).toEqual([]);
  });

  it('the two weeks of a question asked in shadow start when Will lets Flint ask on its own: listed and answerable for two weeks from then, and run out after', async () => {
    // Flint was let to ask a moment ago (the test above): the old quiet question's two weeks have only just begun.
    const since = await announcedSince(k.db);
    expect(since).not.toBeNull();
    expect(Date.now() - since!.getTime()).toBeLessThan(5 * MIN);
    expect((await questionsPage(k.db, { tz: TZ })).waiting.map((q) => q.id)).toContain(quietKept);
    expect((await sweep(k.db, { tz: TZ, resolve: true, expire: true })).expired).toBe(0);
    expect(await k.status(quietKept)).toBe('open');
    // The same question, with the rule signed thirteen days ago: still inside its two weeks.
    const signedAgo = (ms: number) => k.past('ActionPolicy', 'USER', (q) => q(`UPDATE "ActionPolicy" SET "createdAt" = $1 WHERE pattern = $2`, [new Date(Date.now() - ms), ASK_ACTION]));
    await signedAgo(13 * DAY);
    expect(Math.abs(Date.now() - 13 * DAY - (await announcedSince(k.db))!.getTime())).toBeLessThan(MIN);
    expect((await questionsPage(k.db, { tz: TZ })).waiting.map((q) => q.id)).toContain(quietKept);
    expect((await sweep(k.db, { tz: TZ, resolve: true, expire: true })).expired).toBe(0);
    // Signed fifteen days ago: he has had two weeks of the dot and the morning line. Now it runs out, like any other.
    await signedAgo(15 * DAY);
    const recent = await wills(2 * DAY);
    await k.asked(recent, DAY, { shadow: true });
    const waiting = (await questionsPage(k.db, { tz: TZ })).waiting.map((q) => q.id);
    expect(waiting).not.toContain(quietKept);
    // One asked in shadow only yesterday has its own two weeks, from when it was asked.
    expect(waiting).toContain(recent);
    await expect(answerQuestion(k.db, quietKept, 'no', { tz: TZ })).rejects.toMatchObject({ name: 'Refused', status: 409, message: 'That question no longer exists.' });
    expect(await k.resolution(quietKept)).toBeUndefined();
    expect((await sweep(k.db, { tz: TZ, resolve: true, expire: true })).expired).toBe(1);
    expect([await k.status(quietKept), await k.status(recent)]).toEqual(['expired', 'open']);
    // Back to a rule signed just now, for the tests below.
    await signedAgo(0);
  });

  it('a question announced when it was asked waits two weeks from then; after that it is off the list and can no longer be answered', async () => {
    const fresh = await wills(3 * HOUR, { claim: `${WORDS} fresh` });
    const stale = await wills(20 * DAY, { claim: `${WORDS} stale` });
    await k.asked(fresh, 13 * DAY);
    await k.asked(stale, 15 * DAY);
    const before = await questionsWaiting(k.db);
    const page = await questionsPage(k.db, { tz: TZ });
    expect(page.waiting.map((q) => q.id)).toContain(fresh);
    expect(page.waiting.map((q) => q.id)).not.toContain(stale);
    expect(page.waiting).toHaveLength(Math.min(50, before));
    await expect(answerQuestion(k.db, stale, 'yes', { tz: TZ })).rejects.toMatchObject({ name: 'Refused', status: 409, message: 'That question no longer exists.' });
    expect(await k.resolution(stale)).toBeUndefined();
    // The one still inside its two weeks takes his answer.
    await answerQuestion(k.db, fresh, 'no', { tz: TZ });
    expect(await k.resolution(fresh)).toMatchObject({ outcome: false, resolvedBy: 'will', evidence: { via: ANSWER_ACTION } });
    expect(await questionsWaiting(k.db)).toBe(before - 1);
  });

  it('the job exists only while FLINT_PREDICT is on, and asks nothing until Will has turned predictions on', async () => {
    const said: string[] = [];
    const ctx = (over: Partial<Config> = {}) => ({ db: k.db, bus: {} as Bus, sources: [], log: (m: string) => void said.push(m), config: { predict: true, triage: false, planner: false, tz: TZ, home: '/nonexistent-home-for-tests', ...over } as Config });
    expect(predictJobs(ctx({ predict: false })).map((s) => s.queue)).not.toContain('ledger.ask');
    const job = predictJobs(ctx()).find((s) => s.queue === 'ledger.ask')!;
    expect([job.cron, job.missed]).toEqual(['20 7 * * *', 'once']);
    // No number was ever turned on in this database: the job does nothing at all, and says nothing.
    expect(await k.db.forecastSeries.count()).toBe(0);
    const [entries, rows] = [(await audits()).length, (await questions()).length];
    await wills(2 * HOUR);
    await job.handler([]);
    expect((await audits()).length).toBe(entries);
    expect((await questions()).length).toBe(rows);
    expect(said).toEqual([]);
    // Turned on, it asks, and its log line holds counts only.
    await k.onSeries();
    await job.handler([]);
    expect((await audits()).length).toBe(entries + 1);
    for (const line of said) {
      expect(line).toMatch(/^ledger: asked \d+ question\(s\); \d+ left for another day, \d+ refused$/);
      expect(line).not.toContain(WORDS);
    }
  });

  it('a rule that forbids asking stops it: nothing is asked, and the audit says it was skipped', async () => {
    await rule(ASK_ACTION, 'forbidden');
    await wills(4 * HOUR);
    const rows = (await questions()).length;
    const c = await askQuestions(k.db, { tz: TZ, now: daysBack(3) });
    expect(c).toMatchObject({ asked: 0, allowed: false });
    expect((await questions()).length).toBe(rows);
    expect((await audits())[0]).toMatchObject({ tier: 'forbidden', outcome: 'skipped' });
    expect(await questionsAnnounced(k.db)).toBe(false);
  });
});
