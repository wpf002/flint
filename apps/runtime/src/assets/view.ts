/**
 * Settings > Assets, as the console shows it (P5): each asset in the code
 * registry with whether it is on, whether its turn-on card is waiting, and one
 * sentence under its name. Names and sentences are the registry's and
 * @flint/policy's; a row holds no words of anyone else's.
 */
import type { z } from 'zod';
import { REVIEW_GATE_SAYS, TASK_SAYS, type AssetRow, type AssetsPage, type ReviewGateRow } from '@flint/policy';
import type { Db } from '../db.js';
import { ASSETS, sameAsset, type AssetDef } from './registry.js';
import { enableProblem, syncAssets } from './service.js';
import { WILL_ORIGINS } from '../tasks/card.js';

/** What an asset's row says while its card waits for Will. */
export const WAITING = 'A card is waiting for your approval.';

/** The assets, in the registry's order. Rows the registry does not know are left out: nothing can run on them. */
export async function assetsPage(db: Db, registry: readonly AssetDef[] = ASSETS): Promise<z.infer<typeof AssetsPage>> {
  await syncAssets(db, registry);
  const rows = await db.asset.findMany({ where: { id: { in: registry.map((d) => d.id) } } });
  // A card he can approve: one filed for him. (One written under another origin would say "waiting" and withhold Turn On for a card that never runs.)
  const pending = await db.proposal.findMany({ where: { action: 'asset.enable', origin: { in: [...WILL_ORIGINS] }, status: 'pending', expiresAt: { gt: new Date() } }, select: { args: true } });
  const waiting = new Set(pending.map((p) => (p.args as { assetId?: unknown } | null)?.assetId).filter((x): x is string => typeof x === 'string'));
  const assets: Array<z.infer<typeof AssetRow>> = [];
  for (const def of registry) {
    const row = rows.find((r) => r.id === def.id);
    if (!row || !sameAsset(def, row)) continue;
    const why = row.enabled ? undefined : await enableProblem(db, def);
    assets.push({
      id: def.id, name: def.name, kind: def.kind, on: row.enabled, waiting: waiting.has(def.id), costs: def.spends,
      line: why ?? (waiting.has(def.id) && !row.enabled ? WAITING : def.line),
      canTurnOn: !row.enabled && !why && !waiting.has(def.id),
    });
  }
  const gate = await db.reviewGate.findUnique({ where: { id: 'proposal' }, select: { enforced: true } });
  const required = gate?.enforced ?? false;
  return { assets, reviewsRequired: required, reviews: await reviewGateRow(db, required, rows.some((r) => r.kind === 'local_reviewer' && r.enabled)) };
}

/**
 * The Require Reviews row: required or not, its card waiting, and whether it can be asked for now. Requiring them
 * needs a reviewer that is on; stopping needs nothing more. A card he can approve is one filed for him (WILL_ORIGINS).
 */
async function reviewGateRow(db: Db, required: boolean, reviewerOn: boolean): Promise<ReviewGateRow> {
  const waiting = !!(await db.proposal.findFirst({ where: { action: 'review.enforce', origin: { in: [...WILL_ORIGINS] }, status: 'pending', expiresAt: { gt: new Date() } }, select: { id: true } }));
  const line = waiting ? WAITING : required ? REVIEW_GATE_SAYS.required : reviewerOn ? REVIEW_GATE_SAYS.notRequired : TASK_SAYS.reviewerFirst;
  return { required, waiting, line, canChange: !waiting && (required || reviewerOn) };
}
