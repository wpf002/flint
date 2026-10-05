/**
 * pg-boss's schema ships inside migration p2_runtime (the app role runs no
 * DDL): the embedded SQL must be exactly what the pinned version generates,
 * and the version must be pinned exactly, or an upgrade would expect a schema
 * the database does not have.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getConstructionPlans } from 'pg-boss';
import { MIGRATIONS, RUNTIME } from './db';

const stripped = (sql: string) =>
  sql
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !(t === 'BEGIN;' || t === 'COMMIT;' || t.startsWith('SET LOCAL ') || t.startsWith('SELECT pg_advisory_xact_lock('));
    })
    .join('\n')
    .replace('CREATE SCHEMA IF NOT EXISTS pgboss;', 'CREATE SCHEMA pgboss;')
    .trim();

describe('pg-boss in the migration', () => {
  it('the embedded schema is what the pinned version generates', () => {
    const mig = readFileSync(join(MIGRATIONS, '20261001000300_p2_runtime', 'migration.sql'), 'utf8');
    const embedded = mig.slice(mig.indexOf('-- BEGIN pg-boss 12.35.1 schema 43') + '-- BEGIN pg-boss 12.35.1 schema 43'.length, mig.indexOf('-- END pg-boss 12.35.1 schema 43')).trim();
    expect(embedded).toBe(stripped(getConstructionPlans('pgboss', { createSchema: true })));
  });

  it('the version is pinned exactly', () => {
    const pkg = JSON.parse(readFileSync(join(RUNTIME, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
    expect(pkg.dependencies['pg-boss']).toBe('12.35.1');
  });
});
