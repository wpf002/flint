/**
 * Applying one observation from a source to the world model (plan P1).
 *
 *  - Idempotent: the same observation twice changes nothing but lastObservedAt
 *    (and the source's lastSyncedAt). No junk versions (exit criterion 3).
 *  - A change creates exactly one version, with a patch of what changed.
 *  - The state hash covers what the entity IS (name, status, state, taint), not
 *    when it was seen.
 *  - Forgotten entities stay forgotten, and a source key Will asked Flint to
 *    forget is never recreated (the database refuses it too).
 *  - People are never created in P1.
 */
import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { digestOf, mergeTaintedPaths } from '@flint/policy';
import type { Tx } from '../db.js';
import { STATE, FORBIDDEN_KINDS } from './kinds.js';

export interface Observation {
  kind: string;
  key: string;
  name: string;
  state: Record<string, unknown>;
  status?: 'active' | 'archived';
  sensitivity?: 'ops' | 'personal' | 'financial';
  /** JSON paths whose text came from someone other than Will or Flint (name, state.title, ...). */
  taintedPaths?: string[];
  source: string;
  externalId: string;
  namespace?: string;
  sourceEventId?: string;
  observedAt: Date;
  actor: string;
}

export type Applied = 'created' | 'updated' | 'unchanged' | 'skipped';

export class Rejected extends Error {}

export function stateHash(o: Pick<Observation, 'name' | 'state' | 'status' | 'taintedPaths'>): string {
  return digestOf({ name: o.name, state: o.state, status: o.status ?? 'active', taintedPaths: mergeTaintedPaths(o.taintedPaths ?? []) });
}

/** {field: [old, new]} for the top-level fields that changed. */
function patchOf(before: Record<string, unknown>, after: Record<string, unknown>): Record<string, [unknown, unknown]> {
  const out: Record<string, [unknown, unknown]> = {};
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (digestOf(before[k] ?? null) !== digestOf(after[k] ?? null)) out[k] = [before[k] ?? null, after[k] ?? null];
  }
  return out;
}

const vid = () => `ev${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;

export async function applyObservation(tx: Tx, o: Observation): Promise<Applied> {
  if (FORBIDDEN_KINDS.has(o.kind)) throw new Rejected(`world.person.create is forbidden`);
  const schema = STATE[o.kind];
  if (!schema) throw new Rejected(`unknown entity kind ${o.kind}`);
  const parsed = schema.safeParse(o.state);
  if (!parsed.success) throw new Rejected(`${o.kind} state: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  const state = parsed.data as Record<string, unknown>;
  const taintedPaths = mergeTaintedPaths(o.taintedPaths ?? []);
  const hash = stateHash({ name: o.name, state, status: o.status ?? 'active', taintedPaths });
  const status = o.status ?? 'active';
  const tainted = taintedPaths.length > 0;

  const existing = await tx.entity.findUnique({ where: { kind_key: { kind: o.kind, key: o.key } } });
  if (existing?.status === 'forgotten' || existing?.status === 'merged') return 'skipped';
  // A record Will asked Flint to forget is skipped quietly, every time (the
  // database would refuse to re-attach it anyway).
  const suppressed = await tx.suppressedKey.findUnique({
    where: { source_externalIdHash: { source: o.source, externalIdHash: createHash('sha256').update(o.externalId).digest('hex') } },
  });
  if (suppressed) return 'skipped';

  if (!existing) {
    const id = `en${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
    await tx.entity.create({
      data: {
        id, kind: o.kind, key: o.key, name: o.name, state: state as Prisma.InputJsonObject, stateHash: hash, status,
        sensitivity: o.sensitivity ?? 'ops', taintedPaths, lastObservedAt: o.observedAt,
      },
    });
    await tx.entityVersion.create({
      data: { id: vid(), entityId: id, version: 1, changeKind: 'created', state: state as Prisma.InputJsonObject, actor: o.actor, sourceEventId: o.sourceEventId ?? null, tainted, validFrom: o.observedAt },
    });
    // The database refuses this when Will asked Flint to forget the record.
    await tx.entitySource.create({
      data: { id: `es${id.slice(2)}`, entityId: id, source: o.source, externalId: o.externalId, namespace: o.namespace ?? null, accountOwner: 'will', lastSyncedAt: o.observedAt },
    });
    return 'created';
  }

  await tx.entitySource.upsert({
    where: { source_externalId: { source: o.source, externalId: o.externalId } },
    create: { id: `es${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`, entityId: existing.id, source: o.source, externalId: o.externalId, namespace: o.namespace ?? null, accountOwner: 'will', lastSyncedAt: o.observedAt },
    update: { lastSyncedAt: o.observedAt },
  });

  if (existing.stateHash === hash) {
    if (o.observedAt > existing.lastObservedAt) await tx.entity.update({ where: { id: existing.id }, data: { lastObservedAt: o.observedAt } });
    return 'unchanged';
  }

  const before = { name: existing.name, status: existing.status, ...((existing.state ?? {}) as Record<string, unknown>) };
  const after = { name: o.name, status, ...state };
  const version = existing.version + 1;
  const changeKind = existing.status !== status ? (status === 'archived' ? 'archived' : 'restored') : 'updated';
  await tx.entity.update({
    where: { id: existing.id },
    data: { name: o.name, state: state as Prisma.InputJsonObject, stateHash: hash, status, taintedPaths, version, lastObservedAt: o.observedAt },
  });
  await tx.entityVersion.create({
    data: {
      id: vid(), entityId: existing.id, version, changeKind, state: state as Prisma.InputJsonObject,
      patch: patchOf(before, after) as unknown as Prisma.InputJsonObject, actor: o.actor, sourceEventId: o.sourceEventId ?? null, tainted, validFrom: o.observedAt,
    },
  });
  return 'updated';
}
