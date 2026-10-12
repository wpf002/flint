/**
 * The items a goal's check may watch (P3 part 2): the kinds CHECK_PATHS names
 * (pull requests, issues, CI runs, services, deployments, threads, projects),
 * never a person or a calendar event. Each is named by a label made from its key
 * (`wpf002/flint #57`) or from what it is, never from its title or EntityText, and
 * never by a raw id: the label is what is stored and signed. The title is offered
 * beside it only for Will's eyes in the picker, marked as outside text, and never
 * reaches a prompt.
 */
import type { z } from 'zod';
import { GOAL_CONDITIONS, type LinkableItem } from '@flint/policy';
import type { Db, Tx } from '../db.js';

type Item = z.infer<typeof LinkableItem>;

/** The kinds a check can look at: CHECK_PATHS's, and only those. */
export const LINKABLE_KINDS: readonly string[] = Object.keys(GOAL_CONDITIONS);

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
/** A label's longest form (ItemLabel, @flint/policy). */
const LABEL_MAX = 120;

const KIND_WORDS: Readonly<Record<string, string>> = { pull_request: 'Pull Request', issue: 'Issue', ci_run: 'CI Run', service: 'Service', deployment: 'Deploy', thread: 'Thread', project: 'Project' };
/** Where an item came from, by the second part of its key (`thread:nexus:<id>`). */
const SOURCE_WORDS: Readonly<Record<string, string>> = { nexus: 'Nexus', github: 'GitHub', railway: 'Railway' };

/** "Oct 3" in Will's time zone, with the year when it is not this one. */
function dayWords(at: Date, tz: string, now: Date): string {
  const year = (d: Date) => new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric' }).format(d);
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short', day: 'numeric', ...(year(at) === year(now) ? {} : { year: 'numeric' }) }).format(at);
}

export interface Labelled {
  id: string;
  kind: string;
  key: string;
  name: string;
  taintedPaths: readonly string[];
  firstSeenAt: Date;
}

/**
 * An item's label. GitHub's pull requests and issues by their repo and number, its
 * CI by the repo, from the key. Anything else by its name when Flint's own sources
 * wrote it (a launchd label, a Railway service). A name someone else wrote (a
 * Nexus thread's) is outside text and never the label: such an item is named by
 * what it is and when Flint first saw it ("Nexus Thread from Oct 3"), never by a
 * raw id. Always within ItemLabel's length.
 */
export function labelOf(e: Labelled, tz: string, now = new Date()): string {
  const gh = /^(?:pull_request|issue):github:([A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100})#(\d{1,9})$/.exec(e.key);
  if (gh) return `${clip(gh[1]!, LABEL_MAX - gh[2]!.length - 2)} #${gh[2]}`;
  const ci = /^ci_run:github:([A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}):latest$/.exec(e.key);
  if (ci) return `${clip(ci[1]!, LABEL_MAX - 3)} CI`;
  const name = e.name.trim();
  if (name && !e.taintedPaths.includes('name')) return clip(name, LABEL_MAX);
  const source = SOURCE_WORDS[e.key.split(':')[1] ?? ''];
  return `${source ? `${source} ` : ''}${KIND_WORDS[e.kind] ?? 'Item'} from ${dayWords(e.firstSeenAt, tz, now)}`;
}

/**
 * Items whose key or name has `q` in it (any case), the open ones first, then the
 * finished; with no `q`, the latest open ones. At most `limit`.
 */
export async function linkable(db: Db | Tx, q: string, tz: string, limit = 20): Promise<Item[]> {
  const words = q.trim();
  const rows = await db.entity.findMany({
    where: {
      kind: { in: [...LINKABLE_KINDS] },
      status: words ? { in: ['active', 'archived'] } : 'active',
      ...(words ? { OR: [{ key: { contains: words, mode: 'insensitive' as const } }, { name: { contains: words, mode: 'insensitive' as const } }] } : {}),
    },
    orderBy: [{ status: 'asc' }, { updatedAt: 'desc' }, { id: 'asc' }],
    take: limit,
    select: { id: true, kind: true, key: true, name: true, status: true, taintedPaths: true, firstSeenAt: true },
  });
  return rows.map((e) => ({
    entityId: e.id,
    kind: e.kind,
    label: labelOf(e, tz),
    status: e.status === 'archived' ? 'archived' : 'active',
    // Outside text, for the picker only: shown marked, never stored, signed or sent to a model.
    title: e.taintedPaths.includes('name') && e.name.trim() ? clip(e.name.trim(), 300) : null,
    conditions: conditionsOf(e.kind),
  }));
}

/** The conditions an item of this kind offers a check. */
export function conditionsOf(kind: string): Array<{ key: string; value: string }> {
  return (GOAL_CONDITIONS[kind] ?? []).map((c) => ({ key: c.key, value: c.value }));
}
