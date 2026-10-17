/**
 * P5's exit report and its promotion table on flint_test.
 *
 *  - The report: seven criteria, numbers only. With nothing done, none says
 *    pass or fail. A task that went out on its signed card, run, checked and
 *    accepted on Will's card passes what it can.
 *  - The table (p5): task.check_bar alone, 20 a day. Refused before a week
 *    since Flint's checks first sent Will a passing result, and while he has
 *    rejected one that passed or overruled a check in that week. Its card says
 *    what the week measured. Signed, the next result that passes its checks is
 *    accepted on its own, with no card.
 *
 * Synthetic text only.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { CODE_TABLE, noteProblems } from '@flint/policy';
import { NO_DB, freshDb, type TestUrls } from './db';
import { createDb, type Db } from '../src/db';
import { P5_PROMOTIONS, PHASES_LIST, promotionTable } from '../src/governance/promotion';
import { rejectProposal } from '../src/governance/proposals';
import { P5_MIN_CARDS, p5Report } from '../src/report/p5';
import { checkTier } from '../src/tasks/check';
import { DAY, FakeBus, taskFixture, type TaskFixture } from './tasks/fixture';

describe('P5’s table, as written', () => {
  it('promotes task.check_bar alone, 20 a day: a row the code lets a signed rule promote, by its name', () => {
    expect(P5_PROMOTIONS).toEqual([{ pattern: 'task.check_bar', dailyCap: 20 }]);
    expect(PHASES_LIST).toContain('p5');
    expect(CODE_TABLE['task.check_bar']).toMatchObject({ tier: 'approval', promotable: true, byName: true });
  });
});

describe.skipIf(NO_DB)('P5’s report and table on flint_test', () => {
  let urls: TestUrls;
  let db: Db;
  let fx: TaskFixture;
  const bus = new FakeBus();
  const refusal = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e as { status?: number; message?: string });

  beforeAll(async () => {
    urls = await freshDb();
    db = createDb(urls.app);
    fx = await taskFixture(urls, db, bus, { source: true });
  });
  afterAll(async () => {
    await db.$disconnect();
  });

  it('with nothing done, no criterion passes or fails, and every line is numbers in words', async () => {
    const r = await p5Report(db);
    expect(r.criteria.map((c) => c.n)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(r.criteria.map((c) => c.pass)).toEqual([null, null, null, null, null, null, null]);
    for (const c of r.criteria) {
      expect(c.detail.length, c.name).toBeGreaterThan(0);
      for (const v of Object.values(c.values)) expect(['number', 'boolean'].includes(typeof v) || v === null, c.name).toBe(true);
    }
  });

  it('a task that went out on its signed card, ran, passed its checks and was accepted on your card passes what it can', async () => {
    await fx.watcherOn();
    const id = await fx.checked('wpf002/report-one');
    // Its result passed: Flint's checks sent you its accept card.
    const card = await fx.cardFor('task.check_bar', id);
    expect(card).toMatchObject({ status: 'pending' });
    await fx.signRunCard(card!.id);
    expect(await fx.task(id)).toMatchObject({ status: 'accepted' });
    const r = await p5Report(db);
    const by = (n: number) => r.criteria.find((c) => c.n === n)!;
    expect(by(1)).toMatchObject({ pass: true, values: { wentOut: 1, unsigned: 0 } });
    expect(by(2)).toMatchObject({ pass: true, values: { accepted: 1, unearned: 0 } });
    expect(by(3)).toMatchObject({ pass: true, values: { overLimit: 0 } });
    expect(by(4)).toMatchObject({ pass: true, values: { costUsd: 0, paidDispatchesRan: 0 } });
    // Reviews were never required, and Local Reviews was never on.
    expect(by(5).pass).toBeNull();
    expect(by(6)).toMatchObject({ pass: null, detail: 'Local Reviews has not been turned on yet' });
    // One call on a checked result is not enough to judge the checks by.
    expect(by(7)).toMatchObject({ pass: null, values: { calls: 1, acceptedPassing: 1 } });
    expect(by(7).detail).toContain(`needs ${P5_MIN_CARDS}`);
    // Never a task's words or its id.
    expect(JSON.stringify(r)).not.toContain('wpf002');
    expect(JSON.stringify(r)).not.toContain(id);
  });

  it('the table waits a week from the first passing result; its card says what the week measured; signed, results that pass are accepted alone', async () => {
    expect(await refusal(promotionTable(db, { phase: 'p5', tz: 'UTC' }))).toMatchObject({ status: 409, message: expect.stringMatching(/^the shadow week is not over: 0\.\d of 7 days of checked task results$/) });
    // A second passing result, left waiting. The first is dated a week back (the database dates cards itself and
    // nobody may change one, so only its owner, with the guard set aside for the one statement, can: a test's
    // stand-in for a week passing). Its week has been lived, with none rejected: the card is filed.
    const two = await fx.checked('wpf002/report-two');
    const second = (await fx.cardFor('task.check_bar', two))!.id;
    await fx.owner(`DO $$ BEGIN
      ALTER TABLE "Proposal" DISABLE TRIGGER USER;
      UPDATE "Proposal" SET "createdAt" = now() - interval '8 days' WHERE action = 'task.check_bar' AND id <> '${second}';
      ALTER TABLE "Proposal" ENABLE TRIGGER USER;
    END $$`);
    const filed = await promotionTable(db, { phase: 'p5', tz: 'UTC' });
    expect(filed.rows).toEqual([expect.objectContaining({ pattern: 'task.check_bar', tier: 'alone', dailyCap: 20, reason: 'P5 promotion table, after the shadow week' })]);
    const p = await db.proposal.findUniqueOrThrow({ where: { id: filed.proposalId } });
    expect(p).toMatchObject({ action: 'policy.change', templateId: 'p5.promotion', consequential: true, status: 'pending' });
    // Only the week's cards are counted: the one dated back is outside it.
    expect(p.reason).toMatch(/^This lets Flint accept a task’s result on its own when it passes its checks without asking until [A-Z][a-z]{2} \d{1,2}, \d{4}\. Since [A-Z][a-z]{2} \d{1,2}, Flint’s checks passed 1 result: you accepted 0, and 0 expired\.$/);
    for (const s of p.reason!.split(/(?<=\.) /)) expect(noteProblems('Promotion', s), s).toEqual([]);
    // Filed again, it is the same card.
    expect(await promotionTable(db, { phase: 'p5', tz: 'UTC' })).toMatchObject({ proposalId: filed.proposalId, deduped: true });
    // Signed: the check stands alone, under its cap, and the next result that passes is accepted with no card.
    expect((await checkTier(db, new Date())).standing).toBe('shadow');
    await fx.signRun(filed.proposalId);
    expect(await checkTier(db, new Date())).toMatchObject({ standing: 'alone', alone: { cap: { limit: 20, period: 'day' } } });
    const alone = await fx.checked('wpf002/report-three');
    expect(await fx.task(alone)).toMatchObject({ status: 'accepted', metBar: true });
    expect(await fx.cardFor('task.check_bar', alone)).toBeNull();
  });

  it('a week in which you rejected a result that passed its checks does not count', async () => {
    const u = await freshDb();
    const d = createDb(u.app);
    try {
      const f = await taskFixture(u, d, new FakeBus(), { source: true });
      await f.watcherOn();
      const id = await f.checked('wpf002/report-four');
      const card = (await f.cardFor('task.check_bar', id))!;
      await rejectProposal(d, card.id, {}, undefined, 'test');
      // A week and a second after that card: its week is over, and the card is inside the week counted.
      const now = new Date(card.createdAt.getTime() + 7 * DAY + 1000);
      expect(await refusal(promotionTable(d, { phase: 'p5', tz: 'UTC', now }))).toMatchObject({ status: 409, message: 'the shadow week does not count yet: you rejected 1 result that passed Flint’s checks' });
      // And the report counts it against the checks.
      expect((await p5Report(d)).criteria.find((c) => c.n === 7)).toMatchObject({ values: { calls: 1, rejectedPassing: 1 } });
    } finally {
      await d.$disconnect();
    }
  });
});
