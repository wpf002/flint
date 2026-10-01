/**
 * The runtime's database client. Connects as flint_app: it cannot create
 * approvals, write history, or edit the audit trail (the grants and triggers in
 * prisma/migrations make sure of it, whatever this code does).
 */
import { PrismaClient } from '@prisma/client';

export type Db = PrismaClient;
/** The client inside a $transaction callback. */
export type Tx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

export function createDb(databaseUrl: string): Db {
  return new PrismaClient({ datasourceUrl: databaseUrl, log: ['warn', 'error'] });
}
