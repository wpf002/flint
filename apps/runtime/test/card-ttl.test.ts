/**
 * How long a card may wait for Will, everywhere one is filed.
 *
 * The database acts on a signed goal, plan, forecast, asset or task card only if
 * the card expires within 7 days of the approval that signed it
 * (p3_signed_proposal, p4_signed_proposal and p5_signed_proposal: a card cannot
 * be signed now and kept for months). A card
 * filed for 7 days or less always meets that bound, whenever Will signs it. So
 * every place that files a card is listed here with its life, and a new one, or
 * a longer life, fails this test until someone has looked at the bound.
 *
 * The bound covers fourteen actions (COVERED, below). One card lives longer than
 * a week: the weekly restore test's, at 7 days and 2 hours. Its action is not
 * one of them, and nothing in the database holds it to the bound.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { FORECAST_SIGNED_ACTIONS, GOAL_SIGNED_ACTIONS, TASK_SIGNED_ACTIONS } from '@flint/policy';
import { ACTION } from '../src/backup/nightly';
import { CreateProposal } from '../src/governance/proposals';

const REPO = join(__dirname, '..', '..', '..');
const WEEK = 7 * 24 * 60;

/** The actions whose signed card the database holds to the 7-day bound. */
const COVERED = [...GOAL_SIGNED_ACTIONS, ...FORECAST_SIGNED_ACTIONS, ...TASK_SIGNED_ACTIONS];

/**
 * Every source file that sets a card's life, the minutes it sets, and what it
 * files. A file that sets one and is not here fails the test.
 */
const FILERS: Record<string, { minutes: number[]; files: string }> = {
  'apps/runtime/src/governance/proposals.ts': { minutes: [WEEK, 24 * 60], files: 'the most and the default for a card filed over HTTP (the console files forecast.series.enable here)' },
  'apps/runtime/src/goals/service.ts': { minutes: [WEEK], files: 'every goal card and a plan change Will asks for' },
  'apps/runtime/src/goals/batch.ts': { minutes: [WEEK], files: 'a review\'s plan.change' },
  // P3 part 5: a suggestion from chat, set by the candidates intake and again where its card is checked (neither is one of the seven).
  'apps/runtime/src/goals/candidates.ts': { minutes: [WEEK, WEEK], files: 'goal.propose and world.commitment.from_chat' },
  'apps/runtime/src/governance/internal.ts': { minutes: [WEEK], files: 'world.source.enable' },
  'apps/runtime/src/governance/promotion.ts': { minutes: [WEEK], files: 'policy.change' },
  'apps/runtime/src/surface/act.ts': { minutes: [WEEK], files: 'a recommendation\'s action' },
  'apps/runtime/src/world/person-create.ts': { minutes: [24 * 60], files: 'world.person.create' },
  'apps/runtime/src/predict/enable.ts': { minutes: [WEEK], files: 'forecast.series.enable, from the command line (predictions-on)' },
  // P5: the seven asset and task cards.
  'apps/runtime/src/assets/service.ts': { minutes: [WEEK], files: 'asset.enable' },
  'apps/runtime/src/tasks/service.ts': { minutes: [WEEK, WEEK, WEEK], files: 'a task\'s dispatch card, task.cancel and task.bar_override' },
  'apps/runtime/src/tasks/check.ts': { minutes: [WEEK], files: 'task.check_bar (the accept card)' },
  // The exception: restore.drill's card, a week and two hours (the restore test runs on Sundays only).
  'apps/runtime/src/backup/nightly.ts': { minutes: [WEEK + 120, 26 * 60], files: 'backup.local, backup.offsite, restore.drill, maintenance.retention' },
};

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === 'test' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (/\.(ts|cjs|mjs|js)$/.test(name) && !name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

/** Minutes written as plain arithmetic: digits, `*`, `+`, `_` and spaces only. */
function minutes(expr: string, where: string): number {
  const e = expr.trim();
  if (!/^[0-9_ *+]+$/.test(e)) throw new Error(`${where}: a card's life this test can't read (${e}); write it as plain minutes, or teach this test`);
  return e.replace(/_/g, '').split('+').map((term) => term.split('*').map((n) => Number(n.trim())).reduce((a, b) => a * b, 1)).reduce((a, b) => a + b, 0);
}

/** Every life a file sets: `ttlMinutes: <minutes>`, through a constant, either side of a `?:`, or the schema's max and default. */
function lives(path: string): number[] {
  const text = readFileSync(path, 'utf8');
  const rel = relative(REPO, path);
  const constants = new Map([...text.matchAll(/^const ([A-Z_]*TTL[A-Z_]*) = ([^;]+);/gm)].map((m) => [m[1]!, minutes(m[2]!, rel)]));
  const value = (expr: string): number[] => {
    const e = expr.trim();
    if (constants.has(e)) return [constants.get(e)!];
    const either = /^[^?]+\?([^:]+):(.+)$/.exec(e);
    if (either) return [...value(either[1]!), ...value(either[2]!)];
    const schema = /^z\.number\(\)\.int\(\)\.min\(1\)\.max\(([^)]+)\)\.default\(([^)]+)\)$/.exec(e);
    if (schema) return [minutes(schema[1]!, rel), minutes(schema[2]!, rel)];
    return [minutes(e, rel)];
  };
  const out: number[] = [];
  for (const m of text.matchAll(/\bttlMinutes: ([^,\n]+),/g)) out.push(...value(m[1]!));
  return out;
}

describe('how long a card may wait', () => {
  const found = new Map<string, number[]>();
  for (const root of ['apps', 'packages']) {
    for (const path of sources(join(REPO, root))) {
      if (!/\bttlMinutes: /.test(readFileSync(path, 'utf8'))) continue;
      found.set(relative(REPO, path), lives(path));
    }
  }

  it('every place that files a card is listed, with the life it sets', () => {
    expect([...found.keys()].sort()).toEqual(Object.keys(FILERS).sort());
    for (const [file, f] of Object.entries(FILERS)) expect(found.get(file), `${file} (${f.files})`).toEqual(f.minutes);
  });

  it('no card lives longer than 7 days, so none can be refused by the 7-day bound; the one exception is the weekly restore test\'s, whose action the bound does not cover', () => {
    const over = [...found].flatMap(([file, all]) => all.filter((m) => m > WEEK).map((m) => [file, m] as const));
    expect(over).toEqual([['apps/runtime/src/backup/nightly.ts', WEEK + 120]]);
    // The actions that file's cards are for (nightly.ts ACTION, and the cleanup job's, jobs.ts): none is a covered one.
    const nightly = [...Object.values(ACTION), 'maintenance.retention'];
    expect(nightly.sort()).toEqual(['backup.local', 'backup.offsite', 'maintenance.retention', 'restore.drill']);
    for (const action of nightly) expect(COVERED as readonly string[], action).not.toContain(action);
  });

  it('the bound covers the six goal and plan actions, turning predictions on and the seven asset and task cards, and each of them is filed for a week at most', () => {
    expect([...COVERED].sort()).toEqual([
      'asset.enable', 'forecast.series.enable', 'goal.abandon', 'goal.activate', 'goal.criteria_change', 'goal.done', 'goal.horizon_change', 'plan.change',
      'review.enforce', 'task.bar_override', 'task.cancel', 'task.check_bar', 'task.dispatch.ci_runner', 'task.dispatch.local_worker',
    ]);
    // Asset and task cards: assets/service.ts, tasks/service.ts and tasks/check.ts (review.enforce has no filer yet: over HTTP, held to the schema).
    for (const file of ['apps/runtime/src/assets/service.ts', 'apps/runtime/src/tasks/service.ts', 'apps/runtime/src/tasks/check.ts']) expect(Math.max(...found.get(file)!), file).toBeLessThanOrEqual(WEEK);
    const p5 = readFileSync(join(__dirname, '..', 'prisma', 'migrations', '20261014000100_p5_assets', 'migration.sql'), 'utf8');
    expect(new RegExp(`FUNCTION p5_signed_proposal\\([^]*?\\n\\$\\$;`).exec(p5)?.[0] ?? '').toContain(`p."expiresAt" <= a."expiresAt" + interval '7 days'`);
    // Goal and plan cards: goals/service.ts and goals/batch.ts. The predictions card: from the command line
    // (predict/enable.ts), and over HTTP, held to the schema.
    for (const file of ['apps/runtime/src/goals/service.ts', 'apps/runtime/src/goals/batch.ts', 'apps/runtime/src/predict/enable.ts']) expect(Math.max(...found.get(file)!), file).toBeLessThanOrEqual(WEEK);
    const card = (ttlMinutes?: number) => CreateProposal.safeParse({
      kind: 'tool_call', origin: 'console', action: 'forecast.series.enable', args: { series: ['daily.deploys.count'], reason: [] },
      argsProvenance: { series: { source: 'will', tainted: false } }, ...(ttlMinutes === undefined ? {} : { ttlMinutes }),
    });
    expect(card(WEEK).success).toBe(true);
    expect(card(WEEK + 1).success).toBe(false);
    const byDefault = card();
    expect(byDefault.success && byDefault.data.ttlMinutes).toBe(24 * 60);
    // The bound itself, in both helpers as the migration leaves them: a card expires within 7 days of its approval.
    const sql = readFileSync(join(__dirname, '..', 'prisma', 'migrations', '20261013000000_p4_forecasts', 'migration.sql'), 'utf8');
    for (const fn of ['p3_signed_proposal', 'p4_signed_proposal']) {
      const body = new RegExp(`FUNCTION ${fn}\\([^]*?\\n\\$\\$;`).exec(sql)?.[0] ?? '';
      expect(body, fn).toContain(`p."expiresAt" <= a."expiresAt" + interval '7 days'`);
    }
  });
});
