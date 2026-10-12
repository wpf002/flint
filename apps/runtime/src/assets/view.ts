/**
 * Settings > Assets, as the console shows it (P5): each asset in the code
 * registry with whether it is on, whether its turn-on card is waiting, and one
 * sentence under its name. Names and sentences are the registry's and
 * @flint/policy's; a row holds no words of anyone else's.
 */
import type { z } from 'zod';
import type { AssetRow, AssetsPage } from '@flint/policy';
import type { Db } from '../db.js';
import { SAY } from '../tasks/errors.js';
import { ASSETS, sameAsset, type AssetDef } from './registry.js';
import { enableProblem, syncAssets } from './service.js';

/** What an asset's row says while its card waits for Will. */
export const WAITING = 'A card is waiting for your approval.';

/** The assets, in the registry's order. Rows the registry does not know are left out: nothing can run on them. */
export async function assetsPage(db: Db, o: { on: boolean }, registry: readonly AssetDef[] = ASSETS): Promise<z.infer<typeof AssetsPage>> {
  await syncAssets(db, registry);
  const rows = await db.asset.findMany({ where: { id: { in: registry.map((d) => d.id) } } });
  const pending = await db.proposal.findMany({ where: { action: 'asset.enable', status: 'pending', expiresAt: { gt: new Date() } }, select: { args: true } });
  const waiting = new Set(pending.map((p) => (p.args as { assetId?: unknown } | null)?.assetId).filter((x): x is string => typeof x === 'string'));
  const assets: Array<z.infer<typeof AssetRow>> = [];
  for (const def of registry) {
    const row = rows.find((r) => r.id === def.id);
    if (!row || !sameAsset(def, row)) continue;
    // Switched off for a rollback: said, and nothing can be turned on.
    const why = !o.on ? SAY.off : row.enabled ? undefined : await enableProblem(db, def);
    assets.push({
      id: def.id, name: def.name, kind: def.kind, on: row.enabled, waiting: waiting.has(def.id), costs: def.spends,
      line: why ?? (waiting.has(def.id) && !row.enabled ? WAITING : def.line),
      canTurnOn: !row.enabled && !why && !waiting.has(def.id),
    });
  }
  const gate = await db.reviewGate.findUnique({ where: { id: 'proposal' }, select: { enforced: true } });
  return { assets, reviewsRequired: gate?.enforced ?? false };
}
