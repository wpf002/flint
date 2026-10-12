/**
 * What Settings does with assets (P5), behind the runtime's asset routes.
 *
 * Signed: turning an asset on is a card filed here and signed by Will in the
 * console. Its args are exactly what the code registry says the asset is; the
 * database turns the asset on only as that card says.
 *
 * Unsigned: turning one off needs no signature (it only stops work going out),
 * and is written with its audit entry (actor will:console, ids only). The last
 * reviewer stays on while reviews are required: the database refuses, and Will
 * reads why.
 */
import { Prisma } from '@prisma/client';
import type { Db, Tx } from '../db.js';
import { appendAudit } from '../governance/audit.js';
import { Refused, createProposal } from '../governance/proposals.js';
import { sqlState } from '../dbcodes.js';
import { SAY } from '../tasks/errors.js';
import { ASSETS, assetDef, sameAsset, type AssetDef } from './registry.js';

/** Who the console's writes are by. */
export const CONSOLE_ACTOR = 'will:console';
/** How long an asset card waits for Will. */
const CARD_TTL_MINUTES = 7 * 24 * 60;

/** Add the registry's assets that have no row yet, off. A row that is there is never written. */
export async function syncAssets(db: Db | Tx, registry: readonly AssetDef[] = ASSETS): Promise<void> {
  await db.asset.createMany({
    data: registry.map((d) => ({ id: d.id, kind: d.kind, externalRef: d.externalRef, name: d.name, capabilities: [...d.capabilities], dispatchAction: d.dispatchAction, spends: d.spends })),
    skipDuplicates: true,
  });
}

/**
 * Why an asset cannot be turned on yet, as a sentence, or undefined. The CI
 * watcher reads the CI runs the GitHub source keeps, so that source comes first.
 */
export async function enableProblem(db: Db | Tx, def: AssetDef): Promise<string | undefined> {
  if (def.kind === 'ci_runner' && !(await db.sourceCursor.findUnique({ where: { source: 'github' }, select: { enabled: true } }))?.enabled) return SAY.needsGithub;
  return undefined;
}

/** The card that turns an asset on. One already waiting for the same asset is that card. */
export async function fileEnable(db: Db, assetId: string, now = new Date()): Promise<{ proposalId: string; deduped: boolean }> {
  await syncAssets(db);
  const def = assetDef(assetId);
  if (!def) throw new Refused(404, SAY.noAsset);
  const filed = await createProposal(db, {
    kind: 'policy', origin: 'console', action: 'asset.enable',
    args: { assetId: def.id, kind: def.kind, externalRef: def.externalRef, name: def.name, capabilities: [...def.capabilities], dispatchAction: def.dispatchAction, spends: def.spends },
    // checkTaskCard sets where the args came from (the registry), the fixed reason and the fresh-touch mark.
    argsProvenance: {}, tainted: false, sensitivity: 'ops', destructive: false, consequential: true, ttlMinutes: CARD_TTL_MINUTES,
  }, CONSOLE_ACTOR, now);
  return { proposalId: filed.id, deduped: filed.deduped };
}

/** Turn an asset off: nothing more is handed to it, and what is out on it fails as its asset being off. */
export async function turnOff(db: Db, assetId: string, now = new Date()): Promise<void> {
  try {
    await db.$transaction(
      async (tx) => {
        const [row] = await tx.$queryRaw<Array<{ enabled: boolean }>>`SELECT enabled FROM "Asset" WHERE id = ${assetId} FOR UPDATE`;
        if (!row) throw new Refused(404, SAY.noAsset);
        if (!row.enabled) throw new Refused(400, SAY.nothing);
        await tx.asset.update({ where: { id: assetId }, data: { enabled: false } });
        await appendAudit(tx, [{ actor: CONSOLE_ACTOR, context: 'console', kind: 'action', action: 'asset.disable', outcome: 'ok', correlationId: `asset:${assetId}`, tainted: false, inputs: { assetId } }], now);
      },
      { maxWait: 10_000, timeout: 20_000, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
  } catch (err) {
    if (err instanceof Refused) throw err;
    // The one rule that holds an asset on: the last reviewer, while reviews are required.
    if (sqlState(err) === '42501') throw new Refused(409, SAY.reviewerStays);
    throw err;
  }
}

/** Is the row what the registry says this asset is? (A row that is not is never turned on, and is shown as unknown.) */
export const known = (row: Parameters<typeof sameAsset>[1] & { id: string }, registry: readonly AssetDef[] = ASSETS): AssetDef | undefined => {
  const def = assetDef(row.id, registry);
  return def && sameAsset(def, row) ? def : undefined;
};
