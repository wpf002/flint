/**
 * The read-only check Nexus's backup makes of its login before every dump
 * (src/backup/backup.ts, writeRights), on a throwaway Postgres of this test's
 * own, where logins can be made: one login for each way of being able to
 * change a database, and each must be refused with nothing dumped.
 *
 *  - It is asked of every role the login is a member of: a membership it can
 *    use only through SET ROLE, or only hand on to itself, counts.
 *  - Any right on a table but reading counts (INSERT, UPDATE, DELETE,
 *    TRUNCATE, REFERENCES, TRIGGER, MAINTAIN), on one column too; so does
 *    moving a sequence on, owning anything, and leave to make things.
 *  - So does a right it may hand on to another login (any grant option),
 *    the use of a foreign server or a foreign data wrapper, and changing a
 *    large object.
 *  - A right the database gives to everyone is found too, and is said as the
 *    database's own to take back: no login could give it up.
 *  - A login that only reads (pg_read_all_data, as Flint's own backup login
 *    is) passes, and its dump is taken.
 *  - What no check of rights rules out is pinned here as well, so the README
 *    cannot claim more: a function its owner opened to everyone, temporary
 *    tables, and rights that do not exist yet.
 *
 * Nothing here touches the Mac's own Postgres, Flint's database or Nexus.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { NO_CLUSTER, startScratchCluster, type ScratchCluster } from './scratch-cluster';
import { EVERYONE_RIGHTS, NEXUS_SET, NotReadOnly, WRITE_RIGHTS, canWrite, client, dumpDatabase, needsSetup, openRights, targetOf, writeRights, type WriteRight } from '../src/backup/backup';
import { nexusHelp } from '../src/backup/nexus';

const ALL = Object.keys(WRITE_RIGHTS) as WriteRight[];
/** What the owner of a database with things in it holds: everything but an attribute and a role of Postgres's own. */
const OWNERS: WriteRight[] = ['ownsDatabase', 'createInDatabase', 'schema', 'table', 'column', 'sequence', 'routine', 'type', 'owner'];

/**
 * One login for each case: how it is made (after `CREATE ROLE <name> LOGIN`
 * and membership of pg_read_all_data, which every one has unless `bare`), and
 * the kinds of right the check must find. `[]`: it passes.
 */
interface Case {
  attrs?: string;
  bare?: boolean;
  /** Run as the superuser, connected to the stand-in database. `$me` is the login. */
  grant?: string[];
  rights: WriteRight[];
  database?: string;
}
const CASES: Record<string, Case> = {
  // ---- the one that passes: reading everything, and nothing else ----
  ro: { rights: [] },
  monitor: { grant: ['GRANT pg_monitor TO $me'], rights: [] },
  // ---- attributes ----
  bypass: { attrs: 'BYPASSRLS', rights: ['attribute'] },
  createrole: { attrs: 'CREATEROLE', rights: ['attribute'] },
  replication: { attrs: 'REPLICATION', rights: ['attribute'] },
  // A superuser is a member of every role and passes every check: everything is found.
  super: { attrs: 'SUPERUSER', rights: ALL },
  // ---- Postgres's own roles that are not read-only ----
  pgwrite: { grant: ['GRANT pg_write_all_data TO $me'], rights: ['role', 'table', 'column', 'sequence'] },
  pgwrite_set: { grant: ['GRANT pg_write_all_data TO $me WITH INHERIT FALSE, SET TRUE'], rights: ['role', 'table', 'column', 'sequence'] },
  pgmaintain: { grant: ['GRANT pg_maintain TO $me'], rights: ['role', 'table'] },
  pgsignal: { grant: ['GRANT pg_signal_backend TO $me'], rights: ['role'] },
  // ---- the database and its schemas ----
  dbcreate: { grant: ['GRANT CREATE ON DATABASE nx TO $me'], rights: ['createInDatabase'] },
  schemaowner: { grant: ['CREATE SCHEMA owned AUTHORIZATION $me'], rights: ['schema', 'owner'] },
  // An owner that took its own rights away is still the owner, and can give them back: owning is what is found.
  schemaowner_bare: { grant: ['CREATE SCHEMA owned_bare AUTHORIZATION $me', 'REVOKE ALL ON SCHEMA owned_bare FROM $me'], rights: ['schema', 'owner'] },
  schemacreate: { grant: ['GRANT CREATE ON SCHEMA other TO $me'], rights: ['schema'] },
  // ---- a right on a table, each on its own ----
  ins: { grant: ['GRANT INSERT ON public.t1 TO $me'], rights: ['table', 'column'] },
  upd: { grant: ['GRANT UPDATE ON public.t1 TO $me'], rights: ['table', 'column'] },
  del: { grant: ['GRANT DELETE ON public.t1 TO $me'], rights: ['table'] },
  trunc: { grant: ['GRANT TRUNCATE ON public.t3 TO $me'], rights: ['table'] },
  refs: { grant: ['GRANT REFERENCES ON public.t1 TO $me'], rights: ['table', 'column'] },
  trigger: { grant: ['GRANT TRIGGER ON public.t1 TO $me'], rights: ['table'] },
  maintain: { grant: ['GRANT MAINTAIN ON public.t1 TO $me'], rights: ['table'] },
  viewins: { grant: ['GRANT INSERT ON public.v1 TO $me'], rights: ['table', 'column'] },
  otherschema: { grant: ['GRANT INSERT ON other.t2 TO $me'], rights: ['table', 'column'] },
  tableowner: { grant: ['ALTER TABLE public.t4 OWNER TO $me'], rights: ['table', 'column', 'type', 'owner'] },
  tableowner_bare: { grant: ['ALTER TABLE public.t5 OWNER TO $me', 'REVOKE ALL ON public.t5 FROM $me'], rights: ['table', 'type', 'owner'] },
  // ---- one column ----
  colupd: { grant: ['GRANT UPDATE (title) ON public.t1 TO $me'], rights: ['column'] },
  colins: { grant: ['GRANT INSERT (id) ON public.t3 TO $me'], rights: ['column'] },
  colrefs: { grant: ['GRANT REFERENCES (id) ON public.t3 TO $me'], rights: ['column'] },
  // ---- sequences ----
  sequsage: { grant: ['GRANT USAGE ON SEQUENCE public.seq1 TO $me'], rights: ['sequence'] },
  sequpd: { grant: ['GRANT UPDATE ON SEQUENCE public.seq1 TO $me'], rights: ['sequence'] },
  seqowner: { grant: ['ALTER SEQUENCE public.seq2 OWNER TO $me'], rights: ['sequence', 'owner'] },
  seqowner_bare: { grant: ['ALTER SEQUENCE public.seq3 OWNER TO $me', 'REVOKE ALL ON SEQUENCE public.seq3 FROM $me'], rights: ['sequence', 'owner'] },
  // ---- owning something that is not a table ----
  funcowner: { grant: ['ALTER FUNCTION public.owned_fn() OWNER TO $me'], rights: ['routine', 'owner'] },
  typeowner: { grant: ['ALTER TYPE public.owned_type OWNER TO $me'], rights: ['type', 'owner'] },
  loowner: { grant: ['SET ROLE $me', 'SELECT lo_create(0)', 'RESET ROLE'], rights: ['largeObject', 'owner'] },
  // ---- a large object someone else owns: changing it counts, reading it does not ----
  // (Postgres asks for leave to read one as well before it lets it be written: the right to change it is what is found.)
  loupd: { grant: ['GRANT UPDATE ON LARGE OBJECT 424201 TO $me'], rights: ['largeObject'] },
  lowrite: { grant: ['GRANT SELECT, UPDATE ON LARGE OBJECT 424201 TO $me'], rights: ['largeObject'] },
  losel: { grant: ['GRANT SELECT ON LARGE OBJECT 424202 TO $me'], rights: [] },
  // ---- a foreign server or a foreign data wrapper: using one is leave to point the database somewhere else ----
  srvusage: { grant: ['GRANT USAGE ON FOREIGN SERVER nx_srv TO $me'], rights: ['foreign'] },
  fdwusage: { grant: ['GRANT USAGE ON FOREIGN DATA WRAPPER nx_fdw TO $me'], rights: ['foreign'] },
  srvowner: { grant: ['ALTER SERVER nx_srv2 OWNER TO $me'], rights: ['foreign', 'owner'] },
  // ---- a right it may hand on: whatever the right is, reading included, and on whatever it is held ----
  grantopt: { grant: ['GRANT SELECT ON public.t1 TO $me WITH GRANT OPTION'], rights: ['grantOption'] },
  grantopt_col: { grant: ['GRANT SELECT (title) ON public.t3 TO $me WITH GRANT OPTION'], rights: ['grantOption'] },
  grantopt_seq: { grant: ['GRANT SELECT ON SEQUENCE public.seq1 TO $me WITH GRANT OPTION'], rights: ['grantOption'] },
  grantopt_fn: { grant: ['GRANT EXECUTE ON FUNCTION public.owned_fn() TO $me WITH GRANT OPTION'], rights: ['grantOption'] },
  grantopt_type: { grant: ['GRANT USAGE ON TYPE public.owned_type TO $me WITH GRANT OPTION'], rights: ['grantOption'] },
  grantopt_schema: { grant: ['GRANT USAGE ON SCHEMA other TO $me WITH GRANT OPTION'], rights: ['grantOption'] },
  grantopt_db: { grant: ['GRANT CONNECT ON DATABASE nx TO $me WITH GRANT OPTION'], rights: ['grantOption'] },
  grantopt_lang: { grant: ['GRANT USAGE ON LANGUAGE plpgsql TO $me WITH GRANT OPTION'], rights: ['grantOption'] },
  grantopt_lo: { grant: ['GRANT SELECT ON LARGE OBJECT 424202 TO $me WITH GRANT OPTION'], rights: ['grantOption'] },
  grantopt_member: { grant: ['GRANT nx_grantor TO $me WITH INHERIT FALSE, SET TRUE'], rights: ['grantOption'] },
  // ---- through another role: whichever way the membership can be used ----
  member_inh: { grant: ['GRANT nx_writer TO $me'], rights: ['table', 'column'] },
  member_set: { grant: ['GRANT nx_writer TO $me WITH INHERIT FALSE, SET TRUE'], rights: ['table', 'column'] },
  member_admin: { grant: ['GRANT nx_writer TO $me WITH ADMIN TRUE, INHERIT FALSE, SET FALSE'], rights: ['table', 'column'] },
  noinherit: { attrs: 'NOINHERIT', grant: ['GRANT nx_writer TO $me'], rights: ['table', 'column'] },
  member_twice: { grant: ['GRANT nx_between TO $me WITH INHERIT FALSE, SET TRUE'], rights: ['table', 'column'] },
  ownermember_set: { grant: ['GRANT nx_owner TO $me WITH INHERIT FALSE, SET TRUE'], rights: OWNERS },
  // ---- the database's owner ----
  // (nx_owner itself is asked below.) One that owns the database and nothing in it, its own CREATE taken away, the
  // public schema another role's: owning the database is all that is found, and it is enough.
  dbowner2: { database: 'nx2', rights: ['ownsDatabase'] },
  // A plain new database: its owner may make things in it, and owns its public schema through Postgres's own role.
  dbowner3: { database: 'nx3', rights: ['ownsDatabase', 'createInDatabase', 'schema'] },
  // ---- what the check does not rule out (the README says so) ----
  definer: { rights: [] },
  // A login with nothing at all: only what every login has.
  plain: { bare: true, rights: [] },
  defpriv: { grant: ['ALTER DEFAULT PRIVILEGES FOR ROLE nx_owner IN SCHEMA public GRANT INSERT, UPDATE, DELETE ON TABLES TO $me'], rights: [] },
};

describe.skipIf(NO_CLUSTER)('the read-only check of Nexus’s backup login, one login for each way of changing a database', () => {
  let cluster: ScratchCluster;
  let dir: string;
  const password = 'pw-for-a-throwaway-cluster';
  const url = (name: string, database = 'nx'): string => `postgresql://nx_${name}:${password}@[::1]:${cluster.port}/${database}`;
  const admin = async <T>(fn: (c: pg.Client) => Promise<T>, database = 'postgres'): Promise<T> => {
    const c = new pg.Client({ ...cluster.admin, database });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  };
  const as = async <T>(login: string, fn: (c: pg.Client) => Promise<T>, database = 'nx'): Promise<T> => {
    const c = client(targetOf(url(login, database)));
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  };
  /** In a transaction that is rolled back: did it work? */
  const tried = (login: string, sql: string[]) => as(login, async (c) => {
    await c.query('BEGIN');
    try {
      for (const s of sql) await c.query(s);
      return 'done';
    } catch (err) {
      return String((err as Error).message);
    } finally {
      await c.query('ROLLBACK');
    }
  });

  beforeAll(async () => {
    cluster = await startScratchCluster();
    dir = mkdtempSync(join(tmpdir(), 'flint-nexus-ro-'));
    await admin(async (c) => {
      await c.query(`CREATE ROLE nx_owner LOGIN PASSWORD '${password}'`);
      await c.query('CREATE ROLE nx_writer NOLOGIN');
      await c.query('CREATE ROLE nx_between NOLOGIN');
      await c.query('CREATE ROLE nx_grantor NOLOGIN');
      await c.query('GRANT nx_writer TO nx_between WITH INHERIT FALSE, SET TRUE');
      for (const [name, k] of Object.entries(CASES)) {
        await c.query(`CREATE ROLE nx_${name} LOGIN ${k.attrs ?? ''} PASSWORD '${password}'`);
        if (!k.bare) await c.query(`GRANT pg_read_all_data TO nx_${name}`);
      }
      await c.query('CREATE DATABASE nx OWNER nx_owner');
      await c.query('CREATE DATABASE nx2 OWNER nx_dbowner2');
      await c.query('CREATE DATABASE nx3 OWNER nx_dbowner3');
    });
    await admin(async (c) => {
      // A stand-in for Nexus, made by its owner: tables, a view, sequences, a second schema, and a function that
      // runs with its owner's rights and is open to everyone (as any function is unless its owner closes it).
      await c.query('SET ROLE nx_owner');
      await c.query('CREATE TABLE public.t1 (id integer PRIMARY KEY, title text)');
      await c.query(`INSERT INTO public.t1 SELECT g, 't' || g FROM generate_series(1, 10) g`);
      await c.query('CREATE TABLE public.t3 (id integer PRIMARY KEY, title text)');
      await c.query('CREATE TABLE public.t4 (id integer PRIMARY KEY)');
      await c.query('CREATE TABLE public.t5 (id integer PRIMARY KEY)');
      await c.query('CREATE SEQUENCE public.seq1');
      await c.query('CREATE SEQUENCE public.seq2');
      await c.query('CREATE SEQUENCE public.seq3');
      await c.query('CREATE VIEW public.v1 AS SELECT * FROM public.t1');
      await c.query('CREATE SCHEMA other');
      await c.query('CREATE TABLE other.t2 (id integer)');
      await c.query(`CREATE FUNCTION public.definer_write() RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$ INSERT INTO public.t1 VALUES (9999, 'by definer') $$`);
      await c.query('CREATE FUNCTION public.owned_fn() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$');
      await c.query(`CREATE TYPE public.owned_type AS ENUM ('a')`);
      await c.query('RESET ROLE');
      await c.query('GRANT INSERT ON public.t1 TO nx_writer');
      await c.query('GRANT SELECT ON public.t3 TO nx_grantor WITH GRANT OPTION');
      // Two large objects, a foreign data wrapper and two servers, none of them the owner's.
      await c.query('SELECT lo_create(424201), lo_create(424202)');
      await c.query('CREATE FOREIGN DATA WRAPPER nx_fdw');
      await c.query('CREATE SERVER nx_srv FOREIGN DATA WRAPPER nx_fdw');
      await c.query('CREATE SERVER nx_srv2 FOREIGN DATA WRAPPER nx_fdw');
      for (const [name, k] of Object.entries(CASES)) {
        if (k.database) continue;
        for (const sql of k.grant ?? []) await c.query(sql.replaceAll('$me', `nx_${name}`));
      }
    }, 'nx');
    await admin(async (c) => {
      await c.query('ALTER SCHEMA public OWNER TO nx_owner');
      await c.query('SET ROLE nx_owner');
      await c.query('CREATE TABLE public.t1 (id integer PRIMARY KEY, title text)');
      await c.query('RESET ROLE');
      await c.query('REVOKE CREATE ON DATABASE nx2 FROM nx_dbowner2');
    }, 'nx2');
    await admin(async (c) => {
      await c.query('CREATE TABLE public.t1 (id integer PRIMARY KEY, title text)');
      await c.query('ALTER TABLE public.t1 OWNER TO nx_owner');
    }, 'nx3');
  }, 120_000);
  afterAll(() => {
    cluster?.stop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('every kind of right has its words, and none names a role or a thing', () => {
    expect(ALL).toEqual(['attribute', 'role', 'ownsDatabase', 'createInDatabase', 'schema', 'table', 'column', 'sequence', 'routine', 'type', 'foreign', 'largeObject', 'grantOption', 'owner']);
    // The kinds a database can give to everyone at once, each as what every login may then do.
    expect(Object.keys(EVERYONE_RIGHTS)).toEqual(['createInDatabase', 'schema', 'table', 'column', 'sequence', 'foreign', 'largeObject']);
    for (const words of Object.values(EVERYONE_RIGHTS)) expect(words, words).toMatch(/^(make|change|advance|use)[A-Za-z, -]+$/);
    for (const words of Object.values(WRITE_RIGHTS)) expect(words, words).toMatch(/^it (is|belongs|owns|may) [A-Za-z, ’-]+$/);
    const refused = new NotReadOnly(['table', 'sequence']);
    expect(refused.message).toBe('the login that reads this database holds a right to change it, so nothing was backed up (it owns a table or a view, or holds a right to change, lock or hang a trigger on one; it owns a sequence or may advance one)');
    expect(refused.rights).toEqual(['table', 'sequence']);
    expect(needsSetup(refused)).toBe(true);
  });

  it('a login that only reads passes, and its dump is taken', async () => {
    expect(await as('ro', writeRights)).toEqual([]);
    expect(await as('ro', canWrite)).toBe(false);
    const out = join(dir, 'ro');
    const d = await dumpDatabase(url('ro'), out, cluster.tools, new Date(), { ...NEXUS_SET, schemas: ['public', 'other'] });
    expect(d.counts).toMatchObject({ 'public.t1': 10, 'other.t2': 0 });
    // It may read every table, and no way of writing one works for it.
    expect(await tried('ro', ['SELECT count(*) FROM public.t1'])).toBe('done');
    for (const sql of [`INSERT INTO public.t1 VALUES (5000, 'x')`, `UPDATE public.t1 SET title = 'x' WHERE id = 1`, 'DELETE FROM public.t1 WHERE id = 1', 'TRUNCATE public.t3', 'CREATE TABLE public.made (id int)', 'CREATE SCHEMA made', `SELECT nextval('public.seq1')`, 'LOCK TABLE public.t1 IN ACCESS EXCLUSIVE MODE', 'DROP TABLE public.t3']) {
      expect(await tried('ro', [sql]), sql).toMatch(/permission denied|must be owner/);
    }
    // Postgres's own read-only roles do not count against a login.
    expect(await as('monitor', writeRights)).toEqual([]);
  });

  it('each login that could change the database is refused, for the kinds of right it holds, and nothing is dumped', async () => {
    const found: Record<string, WriteRight[]> = {};
    for (const [name, k] of Object.entries(CASES)) found[name] = await as(name, writeRights, k.database ?? 'nx');
    expect(found).toEqual(Object.fromEntries(Object.entries(CASES).map(([name, k]) => [name, k.rights])));
    // The owner itself.
    expect(await as('owner', writeRights)).toEqual(OWNERS);
    for (const [name, k] of Object.entries(CASES)) {
      if (!k.rights.length) continue;
      const out = join(dir, `refused-${name}`);
      const err = await dumpDatabase(url(name, k.database ?? 'nx'), out, cluster.tools, new Date(), NEXUS_SET).then(() => undefined, (e: unknown) => e);
      expect(err, name).toBeInstanceOf(NotReadOnly);
      expect((err as NotReadOnly).rights, name).toEqual(k.rights);
      // Every one of these is the login's own (or its roles'): nothing here is given to everyone.
      expect((err as NotReadOnly).everyone, name).toEqual([]);
      expect((err as NotReadOnly).own, name).toEqual(k.rights);
      expect(readdirSync(out), name).toEqual([]);
    }
  });

  it('what it finds is real: each of these logins changes something with the right found, in a transaction that is rolled back', async () => {
    const works: Record<string, string[]> = {
      pgwrite: [`INSERT INTO public.t1 VALUES (5000, 'x')`],
      pgwrite_set: ['SET ROLE pg_write_all_data', `INSERT INTO public.t1 VALUES (5004, 'x')`],
      pgmaintain: ['LOCK TABLE public.t1 IN ACCESS EXCLUSIVE MODE'],
      dbcreate: ['CREATE SCHEMA made'],
      schemaowner: ['CREATE TABLE owned.made (id int)'],
      schemacreate: ['CREATE TABLE other.made (id int)'],
      ins: [`INSERT INTO public.t1 VALUES (5000, 'x')`],
      upd: [`UPDATE public.t1 SET title = 'x' WHERE id = 1`],
      del: ['DELETE FROM public.t1 WHERE id = 1'],
      trunc: ['TRUNCATE public.t3'],
      trigger: ['CREATE TRIGGER made BEFORE UPDATE ON public.t1 FOR EACH ROW EXECUTE FUNCTION suppress_redundant_updates_trigger()'],
      maintain: ['LOCK TABLE public.t1 IN ACCESS EXCLUSIVE MODE'],
      viewins: [`INSERT INTO public.v1 VALUES (5005, 'through the view')`],
      otherschema: ['INSERT INTO other.t2 VALUES (1)'],
      tableowner: ['DROP TABLE public.t4'],
      colupd: [`UPDATE public.t1 SET title = 'changed by a column grant' WHERE id = 1`],
      colins: ['INSERT INTO public.t3 (id) VALUES (77)'],
      sequsage: [`SELECT nextval('public.seq1')`],
      sequpd: [`SELECT setval('public.seq1', 50)`],
      seqowner: ['DROP SEQUENCE public.seq2'],
      // Each of these took its own rights away, and gives them back to itself in one statement.
      schemaowner_bare: ['GRANT CREATE ON SCHEMA owned_bare TO nx_schemaowner_bare', 'CREATE TABLE owned_bare.made (id int)'],
      tableowner_bare: ['GRANT INSERT ON public.t5 TO nx_tableowner_bare', 'INSERT INTO public.t5 VALUES (1)'],
      seqowner_bare: ['GRANT USAGE ON SEQUENCE public.seq3 TO nx_seqowner_bare', `SELECT nextval('public.seq3')`],
      funcowner: ['DROP FUNCTION public.owned_fn()'],
      typeowner: ['DROP TYPE public.owned_type'],
      member_inh: [`INSERT INTO public.t1 VALUES (5000, 'x')`],
      member_set: ['SET ROLE nx_writer', `INSERT INTO public.t1 VALUES (5001, 'after SET ROLE')`],
      member_admin: ['GRANT nx_writer TO nx_member_admin WITH SET TRUE', 'SET ROLE nx_writer', `INSERT INTO public.t1 VALUES (5002, 'after granting itself the role')`],
      noinherit: ['SET ROLE nx_writer', `INSERT INTO public.t1 VALUES (5003, 'x')`],
      member_twice: ['SET ROLE nx_between', 'SET ROLE nx_writer', `INSERT INTO public.t1 VALUES (5008, 'two steps away')`],
      ownermember_set: ['SET ROLE nx_owner', 'DROP TABLE public.t3'],
      lowrite: [`SELECT lo_put(424201, 0, 'changed'::bytea)`],
      srvusage: ['CREATE USER MAPPING FOR CURRENT_USER SERVER nx_srv'],
      fdwusage: ['CREATE SERVER made FOREIGN DATA WRAPPER nx_fdw'],
      srvowner: ['DROP SERVER nx_srv2'],
    };
    for (const [name, sql] of Object.entries(works)) expect(await tried(name, sql), `${name}: ${sql.join('; ')}`).toBe('done');
    // Reading a large object is not changing it.
    expect(await tried('losel', [`SELECT lo_put(424202, 0, 'changed'::bytea)`])).toMatch(/permission denied/);
    // A right it may hand on: a login that could not read the table can, once it has been handed the right. (Postgres
    // answers a grant by a login that has nothing to hand on with a warning, and gives nothing.)
    const handsOn = (login: string, grant: string, check: string) => as(login, async (c) => {
      await c.query('BEGIN');
      try {
        await c.query(grant);
        return (await c.query<{ ok: boolean }>(`SELECT ${check} AS ok`)).rows[0]!.ok;
      } finally {
        await c.query('ROLLBACK');
      }
    });
    const reads = `has_table_privilege('nx_plain', 'public.t1', 'SELECT')`;
    expect(await handsOn('grantopt', 'GRANT SELECT ON public.t1 TO nx_plain', reads)).toBe(true);
    expect(await handsOn('ro', 'GRANT SELECT ON public.t1 TO nx_plain', reads)).toBe(false);
    expect(await handsOn('grantopt_col', 'GRANT SELECT (title) ON public.t3 TO nx_plain', `has_column_privilege('nx_plain', 'public.t3', 'title', 'SELECT')`)).toBe(true);
    expect(await handsOn('grantopt_schema', 'GRANT USAGE ON SCHEMA other TO nx_plain', `has_schema_privilege('nx_plain', 'other', 'USAGE')`)).toBe(true);
    expect(await as('grantopt_member', async (c) => {
      await c.query('BEGIN');
      try {
        await c.query('SET ROLE nx_grantor');
        await c.query('GRANT SELECT ON public.t3 TO nx_plain');
        return (await c.query<{ ok: boolean }>(`SELECT has_table_privilege('nx_plain', 'public.t3', 'SELECT') AS ok`)).rows[0]!.ok;
      } finally {
        await c.query('ROLLBACK');
      }
    })).toBe(true);
    // And the two that own a database, in theirs.
    expect(await as('dbowner2', async (c) => (await c.query(`ALTER DATABASE nx2 SET work_mem = '8MB'`).then(() => 'done', (e: Error) => e.message)), 'nx2')).toBe('done');
    await admin((c) => c.query('ALTER DATABASE nx2 RESET work_mem'));
    expect(await as('dbowner3', async (c) => {
      await c.query('BEGIN');
      try {
        await c.query('CREATE SCHEMA made');
        return 'done';
      } finally {
        await c.query('ROLLBACK');
      }
    }, 'nx3')).toBe('done');
  });

  it('a right given to everyone counts as the login’s own, is found the moment it is given, and is said as the database’s to take back', async () => {
    expect(await as('ro', writeRights)).toEqual([]);
    expect(await as('ro', openRights)).toEqual([]);
    // Each kind a database can give to everyone, given and taken back in turn. (The first is how a database
    // carried over from before Postgres 15 is: every login may make things in schema public.)
    const given: Array<[string, string, WriteRight]> = [
      ['GRANT CREATE ON SCHEMA public TO PUBLIC', 'REVOKE CREATE ON SCHEMA public FROM PUBLIC', 'schema'],
      ['GRANT CREATE ON DATABASE nx TO PUBLIC', 'REVOKE CREATE ON DATABASE nx FROM PUBLIC', 'createInDatabase'],
      ['GRANT DELETE ON other.t2 TO PUBLIC', 'REVOKE DELETE ON other.t2 FROM PUBLIC', 'table'],
      ['GRANT UPDATE (title) ON public.t3 TO PUBLIC', 'REVOKE UPDATE (title) ON public.t3 FROM PUBLIC', 'column'],
      ['GRANT USAGE ON SEQUENCE public.seq1 TO PUBLIC', 'REVOKE USAGE ON SEQUENCE public.seq1 FROM PUBLIC', 'sequence'],
      ['GRANT USAGE ON FOREIGN SERVER nx_srv TO PUBLIC', 'REVOKE USAGE ON FOREIGN SERVER nx_srv FROM PUBLIC', 'foreign'],
      ['GRANT USAGE ON FOREIGN DATA WRAPPER nx_fdw TO PUBLIC', 'REVOKE USAGE ON FOREIGN DATA WRAPPER nx_fdw FROM PUBLIC', 'foreign'],
      ['GRANT UPDATE ON LARGE OBJECT 424202 TO PUBLIC', 'REVOKE UPDATE ON LARGE OBJECT 424202 FROM PUBLIC', 'largeObject'],
    ];
    for (const [grant, revoke, kind] of given) {
      await admin((c) => c.query(grant), 'nx');
      try {
        expect(await as('ro', writeRights), grant).toEqual([kind]);
        expect(await as('ro', openRights), grant).toEqual([kind]);
        // A login with nothing of its own holds it too: it is everyone's.
        expect(await as('plain', writeRights), grant).toEqual([kind]);
        const err = await dumpDatabase(url('ro'), join(dir, 'public-grant'), cluster.tools, new Date(), NEXUS_SET).then(() => undefined, (e: unknown) => e);
        expect(err, grant).toBeInstanceOf(NotReadOnly);
        const refused = err as NotReadOnly;
        expect([refused.rights, refused.everyone, refused.own], grant).toEqual([[kind], [kind], []]);
        expect(refused.message, grant).toBe(`the login that reads this database holds a right to change it, so nothing was backed up (every login may ${EVERYONE_RIGHTS[kind as keyof typeof EVERYONE_RIGHTS]})`);
        expect(readdirSync(join(dir, 'public-grant')), grant).toEqual([]);
        // What Flint says of it: the right is one Nexus gives to everyone, and the change is on Nexus's side. It never
        // says to take it away from the login, or to set the address again: neither would change anything.
        const lines = nexusHelp(refused, { backupUrl: url('ro') });
        expect(lines, grant).toEqual([
          'Nexus gives every login a right to change it, so Flint backed nothing up.',
          `Every login there may ${EVERYONE_RIGHTS[kind as keyof typeof EVERYONE_RIGHTS]}.`,
          'Flint reads Nexus only through a login with no right to change it. The change is on Nexus’s side: once that right is taken back from everyone there, the backup runs again.',
        ]);
        expect(lines.join(' '), grant).not.toMatch(/nexus-setup|Take that away|Set the address/);
      } finally {
        await admin((c) => c.query(revoke), 'nx');
      }
      expect(await as('ro', writeRights), revoke).toEqual([]);
    }
    // A login with a right of its own as well: each is said for what it is.
    await admin((c) => c.query('GRANT CREATE ON SCHEMA public TO PUBLIC'), 'nx');
    try {
      expect(await as('ins', writeRights)).toEqual(['schema', 'table', 'column']);
      const mixed = await dumpDatabase(url('ins'), join(dir, 'public-grant'), cluster.tools, new Date(), NEXUS_SET).then(() => undefined, (e: unknown) => e) as NotReadOnly;
      expect([mixed.rights, mixed.everyone, mixed.own]).toEqual([['schema', 'table', 'column'], ['schema'], ['table', 'column']]);
      expect(mixed.message).toContain('(every login may make things in a schema; it owns a table or a view, or holds a right to change, lock or hang a trigger on one; it may change a column of a table)');
      // With something of the login's own to take away, the advice is still to look at the login: `nexus-setup` says both.
      expect(nexusHelp(mixed, { backupUrl: url('ins') })[0]).toBe('The login in the Nexus address holds a right to change Nexus, so Flint backed nothing up.');
    } finally {
      await admin((c) => c.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC'), 'nx');
    }
    // A kind held both ways is said as everyone's first; once Nexus has taken that back, the login's own is what is found.
    await admin((c) => c.query('GRANT DELETE ON other.t2 TO PUBLIC'), 'nx');
    try {
      const both = await dumpDatabase(url('del'), join(dir, 'public-grant'), cluster.tools, new Date(), NEXUS_SET).then(() => undefined, (e: unknown) => e) as NotReadOnly;
      expect([both.rights, both.everyone, both.own]).toEqual([['table'], ['table'], []]);
    } finally {
      await admin((c) => c.query('REVOKE DELETE ON other.t2 FROM PUBLIC'), 'nx');
    }
    expect(await as('del', async (c) => [await writeRights(c), await openRights(c)])).toEqual([['table'], []]);
    expect(await as('ro', writeRights)).toEqual([]);
    // A right that does not exist yet is not found: one set up for tables still to be made passes today, and is
    // refused on the night such a table is there.
    expect(await as('defpriv', writeRights)).toEqual([]);
    await admin(async (c) => {
      await c.query('SET ROLE nx_owner');
      await c.query('CREATE TABLE public.later (id integer)');
      await c.query('RESET ROLE');
    }, 'nx');
    try {
      expect(await as('defpriv', writeRights)).toEqual(['table', 'column']);
    } finally {
      await admin((c) => c.query('DROP TABLE public.later'), 'nx');
    }
  });

  it('what no check of rights rules out, so nothing says more: a function opened to everyone, temporary tables, and the read locks of a dump', async () => {
    // Its owner left a function that runs with the owner's rights open to everyone (Postgres's default): the
    // read-only login may call it, and it writes. Flint never calls a function of Nexus's; the check cannot see it.
    expect(await as('definer', writeRights)).toEqual([]);
    expect(await tried('definer', ['SELECT public.definer_write()'])).toBe('done');
    expect(await tried('ro', ['SELECT public.definer_write()'])).toBe('done');
    // Every login that can connect may make temporary tables, which are its own and gone when it leaves; a large
    // object of its own; and a notification.
    expect(await tried('ro', ['CREATE TEMP TABLE mine (id int)'])).toBe('done');
    expect(await tried('ro', ['SELECT lo_create(0)'])).toBe('done');
    expect(await tried('ro', [`NOTIFY some_channel, 'x'`])).toBe('done');
    expect(await tried('plain', ['SELECT lo_create(0)', `NOTIFY some_channel, 'x'`])).toBe('done');
    // And the README and the setup's own sentence claim no more than the check finds.
    const readme = (await import('node:fs')).readFileSync(join(__dirname, '..', 'README.md'), 'utf8');
    const section = readme.slice(readme.indexOf('## Nexus is backed up and tested (P7)'), readme.indexOf('## When a database update fails')).replace(/\s+/g, ' ');
    expect(section).toContain('call a function Nexus opened to everyone');
    expect(section).toContain('make temporary tables');
    expect(section).toContain('make a large object of its own');
    expect(section).toContain('send a notification with `NOTIFY`');
    expect(section).toContain('ordinary read locks');
    // And it names the three kinds found since: a foreign server, a large object, a right it may hand on.
    for (const kind of ['owns or may use a foreign server or a foreign data wrapper', 'owns a large object or may change one', 'may hand any right of its own on to another login, reading included']) expect(section, kind).toContain(kind);
    expect(section).toContain('Nexus gives every login that right, and the change is on Nexus\'s side');
    expect(section).not.toMatch(/can change nothing|cannot change it|changes nothing there|change nothing there/);
  });
});
