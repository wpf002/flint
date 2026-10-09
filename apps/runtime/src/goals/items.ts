/**
 * The items a goal's check may watch (P3 part 2): the kinds CHECK_PATHS names
 * (pull requests, issues, CI runs, services, deployments, threads, projects),
 * never a person or a calendar event. Each is named by a label made from its key
 * (`wpf002/flint #57`), never from its title or EntityText: the label is what is
 * stored and signed. The title is offered beside it only for Will's eyes in the
 * picker, marked as outside text, and never reaches a prompt.
 */
import type { z } from 'zod';
import { GOAL_CONDITIONS, safeName, type LinkableItem } from '@flint/policy';
import type { Db, Tx } from '../db.js';

type Item = z.infer<typeof LinkableItem>;

/** The kinds a check can look at: CHECK_PATHS's, and only those. */
export const LINKABLE_KINDS: readonly string[] = Object.keys(GOAL_CONDITIONS);

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** An item's label, from its key: a repo and number for GitHub's pull requests and issues, the repo for its CI. */
export function labelOf(e: { id: string; kind: string; key: string; name: string; taintedPaths: readonly string[] }): string {
  const gh = /^(?:pull_request|issue):github:([A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100})#(\d{1,9})$/.exec(e.key);
  if (gh) return `${gh[1]} #${gh[2]}`;
  const ci = /^ci_run:github:([A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}):latest$/.exec(e.key);
  if (ci) return `${ci[1]} CI`;
  // Anything else by its name when that is not outside text (a launchd label, a Railway service), else kind#id.
  return clip(safeName({ ...e, name: e.name.trim() || `${e.kind}#${e.id.slice(-6)}` }), 120);
}

/**
 * Items whose key or name has `q` in it (any case), the open ones first, then the
 * finished; with no `q`, the latest open ones. At most `limit`.
 */
export async function linkable(db: Db | Tx, q: string, limit = 20): Promise<Item[]> {
  const words = q.trim();
  const rows = await db.entity.findMany({
    where: {
      kind: { in: [...LINKABLE_KINDS] },
      status: words ? { in: ['active', 'archived'] } : 'active',
      ...(words ? { OR: [{ key: { contains: words, mode: 'insensitive' as const } }, { name: { contains: words, mode: 'insensitive' as const } }] } : {}),
    },
    orderBy: [{ status: 'asc' }, { updatedAt: 'desc' }, { id: 'asc' }],
    take: limit,
    select: { id: true, kind: true, key: true, name: true, status: true, taintedPaths: true },
  });
  return rows.map((e) => ({
    entityId: e.id,
    kind: e.kind,
    label: labelOf(e),
    status: e.status === 'archived' ? 'archived' : 'active',
    // Outside text, for the picker only: shown marked, never stored, signed or sent to a model.
    title: e.taintedPaths.includes('name') && e.name.trim() ? clip(e.name.trim(), 300) : null,
    conditions: (GOAL_CONDITIONS[e.kind] ?? []).map((c) => ({ key: c.key, value: c.value })),
  }));
}
