-- The floor under who may reach a Flint database at all: nobody by default.
--
-- Postgres gives "everyone" (PUBLIC) two things on a new database: the right to
-- connect to it, and the right to use its public schema. On the Mac Flint runs
-- on, both were taken away by hand when its database was first set up, and each
-- of Flint's own roles was given exactly what it needs instead. No migration
-- ever did the same, so a database built from this code was looser than the
-- real one, and a restore, which compares a backup with a database built from
-- this code, refused every backup of the real one.
--
-- This makes the code say what the real database already is:
--  - everyone loses every right on the public schema and on the database;
--  - the runtime's role, the approval role and the backup role may connect;
--  - the backup role may use the public schema by name (it could already read
--    everything through pg_read_all_data; this only writes it down).
-- Every statement is one that changes nothing where it is already so. It only
-- takes rights away, or grants a role one it already had another way: so a
-- backup of a database that had this done by hand is accepted as it is
-- (src/backup/catalog.ts, ALREADY_BY_HAND). No table, column or row changes.
-- Reversed by down.sql in this directory.

REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO flint_backup;

DO $$
BEGIN
  EXECUTE format('REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO flint_app, flint_approver, flint_backup', current_database());
END;
$$;
