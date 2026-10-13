/**
 * `predictions-on` on flint_test (P4 part 3): the command that files the Turn
 * On Predictions card for Will, until the console's own panel can. It files one
 * card, returns the waiting one when asked again, refuses what any filing
 * refuses, and says how to approve it in the console. Filing turns nothing on.
 * With predictions switched off on this Mac it files nothing and says so. The
 * command is also run as a real process: what it prints, and how it exits.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FORECAST_REASONS, noteProblems } from '@flint/policy';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NO_DB, RUNTIME, freshDb, type TestUrls } from '../db';
import { enrollTestKey } from '../sign';
import { createDb, type Db } from '../../src/db';
import { approveProposal } from '../../src/governance/proposals';
import { runInternal } from '../../src/governance/internal';
import { PREDICTIONS_OFF_SAYS, SAY, cardFiledSays, proposeForecasts } from '../../src/predict/enable';
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

  it('says what was filed and how to approve it in the console, with no series key, no id and nothing in parentheses', () => {
    const said = cardFiledSays({ deduped: false }, 12);
    expect(said.split('\n')).toEqual([
      'Filed: the Turn On Predictions card, for 12 numbers.',
      'To approve it: open Flint, click Approvals in the top bar, open Turn On Predictions, and approve it with Touch ID.',
      'It asks on its own, never in Approve All. It expires in 7 days. Nothing is forecast until it is approved.',
    ]);
    expect(cardFiledSays({ deduped: true }, 1).split('\n')[0]).toBe('Already filed: the Turn On Predictions card, for 1 number.');
    expect(PREDICTIONS_OFF_SAYS.split('\n')).toEqual([
      'Not filed: predictions are switched off on this Mac.',
      'Switch them on first, then run this again. The runtime’s README says how, under The Two Switches.',
    ]);
    // Everything the command says is held to the notes' rules (review finding 7: its first line had an id in parentheses).
    for (const line of [...said.split('\n'), ...cardFiledSays({ deduped: true }, 1).split('\n'), ...PREDICTIONS_OFF_SAYS.split('\n'), `Not filed: ${SAY.unknown}`, `Not filed: ${SAY.nothing}`]) {
      expect(noteProblems('Predictions', line), line).toEqual([]);
      expect(line, line).not.toMatch(/daily\.|weekly\.|usd|forecast\.series|[()]|\bpr[a-z]*\d[a-z0-9]{5,}|~\/|FLINT_/);
    }
    // The README has the section the command points to.
    expect(readFileSync(join(__dirname, '..', '..', 'README.md'), 'utf8')).toMatch(/^### The two switches$/m);
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['predictions-on']).toBe('tsx src/cli.ts predictions-on');
  });

  describe('the command itself, run as a process', () => {
    const TSX = join(RUNTIME, 'node_modules', '.bin', 'tsx');
    const home = mkdtempSync(join(tmpdir(), 'predictions-on-'));
    /** One run of `predictions-on`, with only the settings named: no file of Will's is read (HOME is an empty folder). */
    const command = (args: string[], env: Record<string, string>): Promise<{ status: number | null; stdout: string; stderr: string }> =>
      new Promise((done) => {
        const child = spawn(TSX, [join(RUNTIME, 'src', 'cli.ts'), 'predictions-on', ...args], { cwd: RUNTIME, env: { PATH: process.env.PATH ?? '', HOME: home, NODE_ENV: 'test', FLINT_TZ: 'UTC', ...env } });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (c) => (stdout += c));
        child.stderr.on('data', (c) => (stderr += c));
        const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
        child.on('close', (status) => {
          clearTimeout(timer);
          done({ status, stdout, stderr });
        });
      });
    const cards = () => db.proposal.count({ where: { action: 'forecast.series.enable' } });
    const lines = (out: string) => out.trimEnd().split('\n');

    it('with predictions switched off it says so, files nothing and fails; unset is off', async () => {
      const before = await cards();
      for (const env of [{ DATABASE_URL: urls.app }, { DATABASE_URL: urls.app, FLINT_PREDICT: 'off' }, { DATABASE_URL: urls.app, FLINT_PREDICT: 'yes' }] as Array<Record<string, string>>) {
        const r = await command([], env);
        expect(r.status, JSON.stringify(Object.keys(env))).toBe(1);
        expect(lines(r.stdout)).toEqual(PREDICTIONS_OFF_SAYS.split('\n'));
        expect(r.stderr).toBe('');
      }
      expect(await cards()).toBe(before);
      // Off, it does not even need the database: it says the same with one that is not there.
      const r = await command([], { DATABASE_URL: 'postgresql://nobody:SECRETPW@127.0.0.1:1/none' });
      expect(r.status).toBe(1);
      expect(lines(r.stdout)).toEqual(PREDICTIONS_OFF_SAYS.split('\n'));
    }, 120_000);

    it('switched on, it files the card, says how to approve it and succeeds; a second time it is the same card', async () => {
      await db.proposal.updateMany({ where: { action: 'forecast.series.enable', status: 'pending' }, data: { status: 'expired' } }).catch(() => undefined);
      const before = await cards();
      const on = { DATABASE_URL: urls.app, FLINT_PREDICT: 'on' };
      // One named number.
      const one = await command(['daily.deploys.count'], on);
      expect([one.status, one.stderr]).toEqual([0, '']);
      expect(lines(one.stdout)).toEqual(cardFiledSays({ deduped: false }, 1).split('\n'));
      expect(await cards()).toBe(before + 1);
      const again = await command(['daily.deploys.count'], on);
      expect([again.status, again.stderr]).toEqual([0, '']);
      expect(lines(again.stdout)).toEqual(cardFiledSays({ deduped: true }, 1).split('\n'));
      expect(await cards()).toBe(before + 1);
      // What it printed has no id of the card it filed, and nothing in parentheses.
      const filed = await db.proposal.findFirstOrThrow({ where: { action: 'forecast.series.enable' }, orderBy: { createdAt: 'desc' } });
      expect(filed).toMatchObject({ origin: 'cli', consequential: true, args: { series: ['daily.deploys.count'], reason: [] } });
      for (const out of [one.stdout, again.stdout]) {
        expect(out).not.toContain(filed.id);
        expect(out).not.toMatch(/[()]/);
      }
    }, 120_000);

    it('a refusal is said in Flint\'s own sentence, files nothing and fails; a database that is not there fails without its password', async () => {
      const before = await cards();
      const on = { DATABASE_URL: urls.app, FLINT_PREDICT: 'on' };
      const bad = await command(['daily.spend.acme.usd'], on);
      expect(bad.status).toBe(1);
      expect(lines(bad.stdout)).toEqual([`Not filed: ${SAY.unknown}`]);
      expect(bad.stderr).toBe('');
      expect(await cards()).toBe(before);
      const gone = await command([], { DATABASE_URL: 'postgresql://nobody:SECRETPW@127.0.0.1:1/none', FLINT_PREDICT: 'on' });
      expect(gone.status).toBe(1);
      expect(gone.stdout).toBe('');
      expect(gone.stderr.length).toBeGreaterThan(0);
      expect(gone.stdout + gone.stderr).not.toContain('SECRETPW');
    }, 120_000);
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
