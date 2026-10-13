/**
 * What a failure leaves in the logs (P3: goal text is personal, and a database
 * error's message can carry the row it refused; P5: so can a task's title and
 * spec, a model's output and a review's words). The 500 handler and the
 * runtime's own failure lines say what failed (class, SQLSTATE, constraint) and
 * where (stack frames, in a frame's exact shape only), never the error's words;
 * a refusal of Flint's own says its status and its sentence.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { buildApp } from '../src/app';
import { SCOPES } from '../src/config';
import type { Db } from '../src/db';
import { failureOf, failureReport, framesOf } from '../src/dbcodes';
import { Refused } from '../src/governance/proposals';
import { sanitize } from '../src/goals/errors';

const CANARY = 'Synthetic CANARY-logs';
const TOKEN = 'error-logs-token-0123456789abcdef';
const detail = `ERROR: new row for relation "Goal" violates check constraint "Goal_title_check"\nDETAIL: Failing row contains (go1, ${CANARY} title, will).`;
const refusedRow = () =>
  new Prisma.PrismaClientKnownRequestError(`Raw query failed. Code: \`23514\`. Message: \`${detail}\``, { code: 'P2010', clientVersion: '6', meta: { code: '23514', message: detail } });

describe('what a failure logs', () => {
  it('a 500 logs the class, SQLSTATE, constraint and frames, never the row the database refused', async () => {
    const db = { proposal: { findMany: async () => { throw refusedRow(); } } } as unknown as Db;
    const lines: string[] = [];
    const app = buildApp({
      db, logger: true, logStream: { write: (l: string) => void lines.push(l) },
      config: { tz: 'UTC', tokens: [{ name: 'server', sha256: createHash('sha256').update(TOKEN).digest('hex'), scopes: new Set(SCOPES) }] },
    });
    const r = await app.inject({ method: 'GET', url: '/v1/proposals', headers: { authorization: `Bearer ${TOKEN}` } });
    await app.close();
    expect(r.statusCode).toBe(500);
    expect(r.body).not.toContain('CANARY');
    expect(lines.join('')).not.toContain('CANARY');
    const entry = lines.map((l) => JSON.parse(l) as { msg?: string; failure?: string; frames?: string[] }).find((e) => e.msg === 'request failed');
    expect(entry?.failure).toBe('PrismaClientKnownRequestError P2010 23514 Goal_title_check');
    expect(entry?.frames?.length).toBeGreaterThan(0);
    for (const f of entry!.frames!) expect(f).toMatch(/^at .+:\d+:\d+\)?$/);
    expect(entry!.frames!.some((f) => f.includes('error-logs.test.ts'))).toBe(true);
  });

  // P5's own triggers name ids and the rule only (p5-guards-db checks every one). This is the layer above: whatever
  // the database says about a task, an output or a review, a log line holds the class, the SQLSTATE and at most a
  // constraint's name.
  it('a refused task, output or review logs its class and SQLSTATE, never a title, a spec or a model\'s words', async () => {
    const raw = (state: string, message: string) =>
      new Prisma.PrismaClientKnownRequestError(`Raw query failed. Code: \`${state}\`. Message: \`${message}\``, { code: 'P2010', clientVersion: '6', meta: { code: state, message } });
    const row = `(ta1, as1, null, null, ${CANARY} title, {"params": {"what": "${CANARY} spec"}, "template": "draft_note"}, [{"id": "a1", "text": "${CANARY} bar"}])`;
    const cases: Array<[string, string, string]> = [
      // What P5's triggers raise: ids and the rule.
      ['23514', 'ERROR: task ta1: its title is not valid', 'PrismaClientKnownRequestError P2010 23514'],
      ['42501', 'ERROR: task ta1: it is not the task approval appr1 signed', 'PrismaClientKnownRequestError P2010 42501'],
      ['40001', 'ERROR: task ta1: its status changes at read committed only', 'PrismaClientKnownRequestError P2010 40001'],
      ['42501', 'ERROR: proposal pr1: the approval does not name the review Will was shown', 'PrismaClientKnownRequestError P2010 42501'],
      // What a plain constraint would say if one ever refused such a row: the row itself, in its DETAIL.
      ['23514', `ERROR: new row for relation "Task" violates check constraint "Task_title_check"\nDETAIL: Failing row contains ${row}.`, 'PrismaClientKnownRequestError P2010 23514 Task_title_check'],
      ['23502', `ERROR: null value in column "sha256" of relation "TaskOutput" violates not-null constraint\nDETAIL: Failing row contains (ta1, {"headline": "${CANARY} output"}, null, t).`, 'PrismaClientKnownRequestError P2010 23502'],
      ['23514', `ERROR: new row for relation "Review" violates check constraint "Review_verdict_check"\nDETAIL: Failing row contains (rv1, proposal, pr1, ${CANARY} attack, ${CANARY} defense, fine, ${CANARY} reason).`, 'PrismaClientKnownRequestError P2010 23514 Review_verdict_check'],
      ['23505', `ERROR: duplicate key value violates unique constraint "Task_one_live_per_step_key"\nDETAIL: Key ("goalId", "stepKey")=(go1, s1) already exists.`, 'PrismaClientKnownRequestError P2010 23505 Task_one_live_per_step_key'],
    ];
    for (const [state, message, want] of cases) {
      const err = raw(state, message);
      expect(failureOf(err), message.slice(0, 60)).toBe(want);
      expect(failureReport(err)).not.toMatch(/CANARY|Failing row|ta1|appr1/);
      // The same error as pg itself throws it (a job's own connection): its message and detail stay out too.
      const own = Object.assign(new Error(message.replace(/^ERROR: /, '').split('\n')[0]), { code: state, detail: `Failing row contains ${row}.`, where: 'PL/pgSQL function task_guard() line 3 at RAISE' });
      expect(failureOf(own)).toBe(want.replace('PrismaClientKnownRequestError P2010', 'Error'));
      expect(failureReport(own)).not.toMatch(/CANARY|Failing row|ta1|appr1/);
    }
    // Through the 500 handler: the response and the log line.
    const db = { proposal: { findMany: async () => { throw raw('23514', cases[4]![1]); } } } as unknown as Db;
    const lines: string[] = [];
    const app = buildApp({
      db, logger: true, logStream: { write: (l: string) => void lines.push(l) },
      config: { tz: 'UTC', tokens: [{ name: 'server', sha256: createHash('sha256').update(TOKEN).digest('hex'), scopes: new Set(SCOPES) }] },
    });
    const r = await app.inject({ method: 'GET', url: '/v1/proposals', headers: { authorization: `Bearer ${TOKEN}` } });
    await app.close();
    expect(r.statusCode).toBe(500);
    expect(r.body + lines.join('')).not.toContain('CANARY');
    expect(lines.map((l) => JSON.parse(l) as { msg?: string; failure?: string }).find((e) => e.msg === 'request failed')?.failure).toBe('PrismaClientKnownRequestError P2010 23514 Task_title_check');
  });

  it('a message that spans lines, some shaped like frames, never reaches the log', () => {
    const err = new Error(`first line\n  at home I keep my ${CANARY} notes\n    at /Users/someone/${CANARY}.ts:1:2\n    at x (/abs/${CANARY}.ts:3:4)`);
    const frames = framesOf(err);
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.join('\n')).not.toContain('CANARY');
    expect(frames.join('\n')).not.toContain('home');
    // A message changed after the error was made no longer heads its stack: then only exact frames pass, and
    // the lines of the old message still do not (their words have spaces).
    err.message = 'changed';
    expect(framesOf(err).join('\n')).not.toMatch(/CANARY|home/);
    expect(failureReport(err)).not.toMatch(/CANARY|home|first line|changed/);
  });

  it('a refusal says its status and sentence; a reduced goal failure keeps its frames; a non-error says little', () => {
    const r = new Refused(409, 'The plan changed since Flint suggested this.');
    expect(failureReport(r)).toMatch(/^Refused 409: The plan changed since Flint suggested this\.\n {2}at /);
    const g = sanitize(refusedRow());
    expect(failureOf(g)).toBe('PrismaClientKnownRequestError P2010 23514 Goal_title_check');
    expect(failureReport(g)).toMatch(/^PrismaClientKnownRequestError P2010 23514 Goal_title_check\n {2}at .+error-logs\.test\.ts/);
    expect(failureReport(g)).not.toContain('CANARY');
    expect(failureReport('a string')).toBe('error');
    expect(failureOf(new Error(`no database here: constraint "${CANARY}"`))).toBe('Error');
  });
});
