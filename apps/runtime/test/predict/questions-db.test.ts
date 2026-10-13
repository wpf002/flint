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
 *  - A question waits two weeks; after that it is gone from the list.
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
import { ANSWER_ACTION, ASK_ACTION, answerQuestion, askQuestions, questionsPage, questionsWaiting } from '../../src/predict/questions';
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
});

describe.skipIf(NO_DB)('Will\'s questions on flint_test', () => {
  let urls: TestUrls;
  let k: LedgerKit;
  let key: Awaited<ReturnType<typeof enrollTestKey>>;
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
    const c = await askQuestions(k.db, { tz: TZ, now });
    expect(c).toMatchObject({ asked: left, shadow: false, allowed: true });
    expect((await questions()).filter((q) => !q.shadow)).toHaveLength(left);
    expect((await audits())[0]).toMatchObject({ tier: 'alone', decision: 'act', outcome: 'ok' });
    // The digest counts every question that waits, in one sentence, and says none of their words.
    const loud = await buildDigest(k.db, TZ);
    expect(loud.counts.questions).toBe(await questionsWaiting(k.db));
    expect(loud.body.split('\n')).toContain(questionsSentence(loud.counts.questions!));
    expect(loud.body).not.toContain(WORDS);
    expect(noteProblems(loud.title, loud.body)).toEqual([]);
  });

  it('a question waits two weeks from when it was asked; after that it is off the list and can no longer be answered', async () => {
    const fresh = await wills(3 * HOUR, { claim: `${WORDS} fresh` });
    const stale = await wills(20 * DAY, { claim: `${WORDS} stale` });
    await k.asked(fresh, 13 * DAY);
    await k.asked(stale, 15 * DAY);
    const before = await questionsWaiting(k.db);
    const page = await questionsPage(k.db, { tz: TZ });
    expect(page.waiting.map((q) => q.id)).toContain(fresh);
    expect(page.waiting.map((q) => q.id)).not.toContain(stale);
    expect(page.waiting).toHaveLength(Math.min(50, before));
    await expect(answerQuestion(k.db, stale, 'yes')).rejects.toMatchObject({ name: 'Refused', status: 409, message: 'That question no longer exists.' });
    expect(await k.resolution(stale)).toBeUndefined();
    // The one still inside its two weeks takes his answer.
    await answerQuestion(k.db, fresh, 'no');
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
