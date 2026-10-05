/**
 * freshDb (test/db.ts) on flint_test, which a feature branch's tests and the
 * deploy gate share: whatever another branch's migrations left behind (a
 * table, a routine, a type, a schema) is dropped and named before migrating
 * up, so main's gate never fails on a branch's leftovers (2026-10-04); and on a
 * database main left, down.sql leaves nothing for it to drop.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { NO_DB, URLS, dropLeftovers, freshDb, migrateDown, migrateUp, withClient } from './db';

const exists = (sql: string, args: unknown[] = []) =>
  withClient(URLS!.owner, async (c) => (await c.query(`SELECT EXISTS (${sql}) AS e`, args)).rows[0].e as boolean);

afterEach(() => vi.restoreAllMocks());

describe.skipIf(NO_DB)('freshDb', () => {
  it("drops another branch's leftovers, names them, and migrates up as usual", async () => {
    await freshDb();
    await withClient(URLS!.owner, async (c) => {
      await c.query(`CREATE TABLE "LeftoverFromBranch" (id text PRIMARY KEY)`);
      await c.query(`CREATE FUNCTION leftover_fn(x integer) RETURNS integer LANGUAGE sql AS 'SELECT x'`);
      await c.query(`CREATE TYPE leftover_kind AS ENUM ('a', 'b')`);
      await c.query(`CREATE SCHEMA leftover_schema`);
      await c.query(`CREATE TABLE leftover_schema.t (id integer)`);
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await freshDb();
    expect(warn).toHaveBeenCalledTimes(1);
    const said = String(warn.mock.calls[0]![0]);
    for (const name of ['schema leftover_schema', 'table LeftoverFromBranch', 'routine leftover_fn(integer)', 'type leftover_kind']) expect(said).toContain(name);
    expect(await exists(`SELECT 1 FROM pg_class WHERE relname = 'LeftoverFromBranch'`)).toBe(false);
    expect(await exists(`SELECT 1 FROM pg_proc WHERE proname = 'leftover_fn'`)).toBe(false);
    expect(await exists(`SELECT 1 FROM pg_type WHERE typname = 'leftover_kind'`)).toBe(false);
    expect(await exists(`SELECT 1 FROM pg_namespace WHERE nspname = 'leftover_schema'`)).toBe(false);
    // Migrated as usual: the runtime's own tables and schemas are back.
    expect(await exists(`SELECT 1 FROM pg_class WHERE relname = 'Proposal'`)).toBe(true);
    expect(await exists(`SELECT 1 FROM pg_namespace WHERE nspname = 'pgboss'`)).toBe(true);
  });

  it("finds nothing to drop after main's own down.sql", async () => {
    await freshDb();
    await migrateDown(URLS!.owner);
    expect(await dropLeftovers(URLS!.owner)).toEqual([]);
    await migrateUp(URLS!.owner);
  });
});
