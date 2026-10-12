/**
 * `predictions-on` on flint_test (P4 part 3): the command that files the Turn
 * On Predictions card for Will, until the console's own panel can. It files one
 * card, returns the waiting one when asked again, refuses what any filing
 * refuses, and says how to approve it in the console. Filing turns nothing on.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FORECAST_REASONS } from '@flint/policy';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NO_DB, freshDb, type TestUrls } from '../db';
import { enrollTestKey } from '../sign';
import { createDb, type Db } from '../../src/db';
import { approveProposal } from '../../src/governance/proposals';
import { runInternal } from '../../src/governance/internal';
import { SAY, cardFiledSays, proposeForecasts } from '../../src/predict/enable';
import { FORECAST_SERIES_KEYS } from '../../src/predict/series';

describe.skipIf(NO_DB)('predictions-on', () => {
  let urls: TestUrls;
  let db: Db;
  let key: Awaited<ReturnType<typeof enrollTestKey>>;

  beforeAll(async () => {
    urls = await freshDb();
    db = createDb(urls.app);
    key = await enrollTestKey(urls);
  });
  afterAll(async () => db?.$disconnect());

  it('files one card for every number Flint can forecast, from the command line, marked for Will\'s own touch; asked again, it is the same card', async () => {
    const filed = await proposeForecasts(db);
    expect(filed).toMatchObject({ deduped: false, tier: 'approval' });
    const p = await db.proposal.findUniqueOrThrow({ where: { id: filed.id } });
    expect(p).toMatchObject({
      kind: 'tool_call', origin: 'cli', action: 'forecast.series.enable', status: 'pending', tainted: false, consequential: true, sensitivity: 'financial', reason: FORECAST_REASONS.enable,
      args: { series: [...FORECAST_SERIES_KEYS].sort(), reason: [] },
    });
    // A week to decide, and no longer: the database acts on a signed card only within 7 days of its signature.
    const life = p.expiresAt.getTime() - p.createdAt.getTime();
    expect(life).toBeGreaterThan(7 * 86_400_000 - 60_000);
    expect(life).toBeLessThanOrEqual(7 * 86_400_000 + 1000);
    const again = await proposeForecasts(db);
    expect(again).toMatchObject({ id: filed.id, deduped: true });
    expect(await db.proposal.count({ where: { action: 'forecast.series.enable' } })).toBe(1);
    // Filing turns nothing on, and makes no series.
    expect(await db.forecastSeries.count()).toBe(0);
    expect(await db.metricSeries.count({ where: { key: { in: [...FORECAST_SERIES_KEYS] } } })).toBe(0);
  });

  it('says what was filed and how to approve it in the console, with no series key', () => {
    const said = cardFiledSays({ id: 'prtest0001', deduped: false }, 12);
    expect(said.split('\n')).toEqual([
      'Filed: the Turn On Predictions card, for 12 numbers (proposal prtest0001).',
      'To approve it: open Flint, click Approvals in the top bar, open Turn On Predictions, and approve it with Touch ID.',
      'It asks on its own, never in Approve All. It expires in 7 days. Nothing is forecast until it is approved.',
    ]);
    expect(cardFiledSays({ id: 'prtest0001', deduped: true }, 1).split('\n')[0]).toBe('Already filed: the Turn On Predictions card, for 1 number (proposal prtest0001).');
    expect(said).not.toMatch(/daily\.|weekly\.|usd|forecast\.series/);
    // The command itself: one script, one branch, and it prints a refusal as Flint's own sentence.
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['predictions-on']).toBe('tsx src/cli.ts predictions-on');
    const cli = readFileSync(join(__dirname, '..', '..', 'src', 'cli.ts'), 'utf8');
    expect(cli).toContain("if (process.argv[2] === 'predictions-on') {");
    expect(cli).toContain('console.log(`Not filed: ${err.message}`)');
  });

  it('named numbers file their own card; a key outside the registry is refused, and nothing is filed for it', async () => {
    const one = await proposeForecasts(db, ['daily.deploys.count', 'daily.deploys.count', 'daily.calendar.hours']);
    expect(one.deduped).toBe(false);
    expect((await db.proposal.findUniqueOrThrow({ where: { id: one.id } })).args).toEqual({ series: ['daily.calendar.hours', 'daily.deploys.count'], reason: [] });
    const before = await db.proposal.count();
    await expect(proposeForecasts(db, ['daily.spend.acme.usd'])).rejects.toMatchObject({ name: 'Refused', status: 400, message: SAY.unknown });
    await expect(proposeForecasts(db, [])).rejects.toMatchObject({ name: 'Refused', status: 400 });
    expect(await db.proposal.count()).toBe(before);
  });

  it('signed in the console, the card turns its numbers on; asked for again after that, there is nothing to sign', async () => {
    const all = await proposeForecasts(db);
    const p = await db.proposal.findUniqueOrThrow({ where: { id: all.id } });
    await approveProposal(db, p.id, await key.approve({ subjectId: p.id, action: p.action, argsDigest: p.argsDigest }), undefined, 'test');
    expect(await runInternal(db, p.id, undefined, 'UTC', 'test')).toEqual({ on: 12, reason: 0 });
    expect(await db.forecastSeries.count({ where: { on: true } })).toBe(12);
    await expect(proposeForecasts(db)).rejects.toMatchObject({ name: 'Refused', status: 400, message: SAY.nothing });
  });
});
