/**
 * How a goal card's failure may be told: a database error becomes its class and
 * SQLSTATE (dbcodes.ts, goals/errors.ts), whatever its message carried; what Will
 * reads are fixed sentences.
 */
import { describe, it, expect } from 'vitest';
import { Prisma } from '@prisma/client';
import { GoalFailure, SAY, goalStatusWords, sanitize } from '../../src/goals/errors';
import { Refused } from '../../src/governance/proposals';
import { constraintOf, dbRefused, failureClass, failureOf, sqlState } from '../../src/dbcodes';

const DETAIL = 'ERROR: new row for relation "PlanStep" violates check constraint "PlanStep_title_check"\nDETAIL: Failing row contains (ps1, pl1, s1, 1, Synthetic words of a goal, will_task).';

describe('database errors without their words', () => {
  it('finds the SQLSTATE wherever Prisma put it, and never mistakes a Prisma code for one', () => {
    const raw = new Prisma.PrismaClientKnownRequestError(`Raw query failed. Code: \`23514\`. Message: \`${DETAIL}\``, { code: 'P2010', clientVersion: '6', meta: { code: '23514', message: DETAIL } });
    expect(sqlState(raw)).toBe('23514');
    expect(failureOf(raw)).toBe('PrismaClientKnownRequestError P2010 23514');
    const orm = new Prisma.PrismaClientUnknownRequestError(`ConnectorError(... PostgresError { code: "42501", message: "goal go1: a goal starts proposed" ...`, { clientVersion: '6' });
    expect(sqlState(orm)).toBe('42501');
    expect(failureOf(orm)).toBe('PrismaClientUnknownRequestError 42501');
    expect(sqlState(new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: '6' }))).toBeUndefined();
    const pgError = Object.assign(new Error('permission denied for table Goal'), { name: 'error', code: '42501' });
    expect(failureOf(pgError)).toBe('error 42501');
    expect(failureOf('a string')).toBe('error');
    expect(failureClass(new TypeError('x'))).toBe('TypeError');
    expect(constraintOf(DETAIL)).toBe('PlanStep_title_check');
    expect(constraintOf('violates check constraint \\"Goal_title_check\\"')).toBe('Goal_title_check');
    expect(constraintOf('no constraint here')).toBeUndefined();
  });

  it('sanitize keeps a refusal and turns anything else into its class and SQLSTATE', () => {
    const r = new Refused(409, SAY.staleFlint);
    expect(sanitize(r)).toBe(r);
    const raw = new Prisma.PrismaClientKnownRequestError(`Raw query failed. Code: \`23514\`. Message: \`${DETAIL}\``, { code: 'P2010', clientVersion: '6', meta: { code: '23514', message: DETAIL } });
    const s = sanitize(raw) as GoalFailure;
    expect(s).toBeInstanceOf(GoalFailure);
    expect(s.message).toBe('PrismaClientKnownRequestError P2010 23514');
    expect(s.code).toBe('23514');
    expect(JSON.stringify({ ...s, message: s.message, stack: s.stack })).not.toContain('Synthetic');
    expect(dbRefused(s)).toBe(true);
    expect(sanitize(s)).toBe(s);
    expect(sanitize(new Error('Synthetic words'))).toMatchObject({ failure: 'Error', code: undefined });
  });

  it('what Will reads: sentences, never a value', () => {
    for (const [k, v] of Object.entries(SAY)) expect(v, k).toMatch(/^[A-Z][^{}<>$]*\.$/);
    expect(goalStatusWords('done')).toBe('This goal is already done.');
    expect(goalStatusWords('nonsense')).toBe('This goal can’t change now.');
  });
});
