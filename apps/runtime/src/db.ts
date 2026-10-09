/**
 * The runtime's database client. Connects as flint_app: it cannot create
 * approvals, write history, or edit the audit trail (the grants and triggers in
 * prisma/migrations make sure of it, whatever this code does).
 *
 * When Postgres drops a connection (a restart, a killed backend), Prisma's
 * pool can keep the dead connection and fail every statement it has not
 * prepared before, for as long as the process lives. On the first such error
 * the pool is rebuilt (disconnect; the next query connects afresh). Nothing
 * is retried: the job or request that hit the dead connection fails, and is
 * retried by whoever owns it.
 */
import { PrismaClient } from '@prisma/client';
import { constraintOf, sqlState } from './dbcodes.js';

export type Db = PrismaClient;
/** The client inside a $transaction callback. */
export type Tx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

/** A connection Postgres closed under us. */
export const CONNECTION_LOST = /Server has closed the connection|terminating connection|Connection reset by peer|connection closed/i;

export function createDb(databaseUrl: string): Db {
  const client = new PrismaClient({ datasourceUrl: databaseUrl, log: [{ emit: 'stdout', level: 'warn' }, { emit: 'event', level: 'error' }] });
  let rebuilding: Promise<void> | undefined;
  client.$on('error', (e) => {
    // The SQLSTATE and the constraint's name, never the engine's message: a CHECK's
    // refusal carries the row it refused ("Failing row contains (...)") and a
    // validation error the call's arguments, and a goal's row holds Will's words.
    const state = sqlState(e.message);
    const constraint = constraintOf(e.message);
    const lost = CONNECTION_LOST.test(e.message);
    console.error(`prisma:error ${[state ? `sqlstate ${state}` : '', constraint ? `constraint ${constraint}` : '', lost ? 'connection lost' : ''].filter(Boolean).join(', ') || 'a query failed'}`);
    if (CONNECTION_LOST.test(e.message) && !rebuilding) {
      rebuilding = client
        .$disconnect()
        .catch(() => {})
        .finally(() => (rebuilding = undefined));
    }
  });
  return client;
}
