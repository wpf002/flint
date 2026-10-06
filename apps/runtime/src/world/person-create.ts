/**
 * world.person.create (Machine plan P2.5, Decision 17): how a person the
 * calendar source saw becomes a Person entity, and the only way one does.
 *
 *  - PersonGuard: the address's hash must be an attendee of an active
 *    commitment from the same calendar source that Will accepted or organized,
 *    checked when the person is offered and again when it is created, whatever
 *    a proposal says.
 *  - At APPROVAL (shipped): a card lists who would be created (name and
 *    address, tainted, PERSONAL); Will signs it or lets it expire. At most one
 *    a day, none while one is open, and none for a week after he rejects one.
 *  - Promoted: each new person claims a slot of the daily cap and is created
 *    with an audit entry (hashes only, never the name or address).
 *  - Someone already known is simply seen again (their name may change); a
 *    person Will asked Flint to forget is never recreated (the mapper and the
 *    database both refuse).
 *  - P2.6: the calendar is google_calendar or apple_calendar. A card names its
 *    source when it is not Google (so Will signs which calendar the people
 *    came from; a card without one is Google's, as every P2.5 card was), and
 *    someone forgotten under either calendar is forgotten under both.
 */
import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { resolveTier } from '@flint/policy';
import type { Db, Tx } from '../db.js';
import { appendAudit } from '../governance/audit.js';
import { claim } from '../governance/counters.js';
import { activePolicies, createProposal } from '../governance/proposals.js';
import { applyObservation, type Applied } from './mapper.js';
import { CALENDAR_SOURCES, MEETS, emailHash, isCalendarSource, personExternalId, personKey, type CalendarSource } from './people.js';
import type { SourceObservation } from '../sources/types.js';

export const ACTION = 'world.person.create';
export const TEMPLATE = 'person.from_calendar';
/** People on one card. */
export const PER_CARD = 20;
/** The source of a card that names none: every P2.5 card was Google's. */
const DEFAULT_SOURCE: CalendarSource = 'google_calendar';
const DAY = 86_400_000;

const Name = z.string().min(1).max(100).refine((s) => !/[\p{Cc}\p{Cf}]/u.test(s), 'a name has no control characters');
const Person = z
  .object({ name: Name, email: z.string().email().max(254), emailHash: z.string().regex(/^[0-9a-f]{64}$/) })
  .strict()
  .refine((p) => p.email === p.email.trim().toLowerCase() && emailHash(p.email) === p.emailHash, 'the hash is of the address');
/** A card's args: who would be created, and from which calendar (absent: Google's). */
export const PersonCreateArgs = z.object({ people: z.array(Person).min(1).max(PER_CARD), source: z.enum(CALENDAR_SOURCES).optional() }).strict();
export type PersonIn = z.infer<typeof Person>;
/** A person a calendar sync reported, with the calendar that reported them. */
export type Candidate = PersonIn & { source: CalendarSource };

/** From a calendar observation of kind person, the candidate; undefined when it is not one. */
export function candidateOf(o: SourceObservation): Candidate | undefined {
  if (o.kind !== 'person') return undefined;
  const s = o.state as { source?: unknown; email?: unknown; emailHash?: unknown };
  if (!isCalendarSource(s.source)) return undefined;
  const p = Person.safeParse({ name: o.name, email: s.email, emailHash: s.emailHash });
  return p.success && o.key === personKey(p.data.emailHash, s.source) && o.externalId === personExternalId(p.data.emailHash) ? { ...p.data, source: s.source } : undefined;
}

/** PersonGuard: on an event from this calendar that Will accepted or organized, still on it and not over. */
export async function personAllowed(db: Db | Tx, hash: string, source: CalendarSource, now = new Date()): Promise<boolean> {
  const rows = await db.$queryRaw<Array<{ ok: number }>>`
    SELECT 1 AS ok FROM "Entity" e
    WHERE e.kind = 'commitment' AND e.status = 'active'
      AND e.state->>'source' = ${source} AND e.state->>'response' IN (${Prisma.join([...MEETS])})
      AND e.state->>'endsAt' > ${now.toISOString()}
      AND jsonb_exists(coalesce(e.state->'attendeeHashes', '[]'::jsonb), ${hash})
      AND EXISTS (SELECT 1 FROM "EntitySource" s WHERE s."entityId" = e.id AND s.source = ${source})
    LIMIT 1`;
  return rows.length > 0;
}

async function create(tx: Tx, p: PersonIn, source: CalendarSource, now: Date, actor: string): Promise<Applied> {
  return applyObservation(tx, {
    kind: 'person', key: personKey(p.emailHash, source), name: p.name, state: { source, email: p.email, emailHash: p.emailHash },
    sensitivity: 'personal', taintedPaths: ['name', 'state.email'], source, externalId: personExternalId(p.emailHash),
    observedAt: now, actor, via: ACTION,
  });
}

export interface Offered {
  /** Known already and changed (a new name), or restored. */
  updated: number;
  /** Known already and the same. */
  unchanged: number;
  created: number;
  proposed: number;
  refused: number;
}

/** A person Will asked Flint to forget, under either calendar: never offered, never created again. */
export async function forgotten(db: Db | Tx, hash: string): Promise<boolean> {
  const externalIdHash = createHash('sha256').update(personExternalId(hash)).digest('hex');
  return !!(await db.suppressedKey.findFirst({ where: { source: { in: [...CALENDAR_SOURCES] }, externalIdHash }, select: { source: true } }));
}

/**
 * The people a calendar sync reported: the known ones seen again, the new
 * ones offered (a card at APPROVAL, created under the cap once promoted).
 * `from`: the source that synced them; a person another source claims is refused.
 */
export async function offerPeople(db: Db, people: SourceObservation[], now: Date, tz: string, from?: string): Promise<Offered> {
  const out: Offered = { updated: 0, unchanged: 0, created: 0, proposed: 0, refused: 0 };
  const fresh: Candidate[] = [];
  const seen = new Set<string>();
  for (const o of people) {
    const c = candidateOf(o);
    const p = c && (from === undefined || c.source === from) ? c : undefined;
    if (!p || seen.has(`${p.source}:${p.emailHash}`)) {
      out.refused += p ? 0 : 1;
      continue;
    }
    seen.add(`${p.source}:${p.emailHash}`);
    // Forgotten (its entity was rekeyed, so the key no longer finds it): never offered again.
    if (await forgotten(db, p.emailHash)) {
      out.refused += 1;
      continue;
    }
    const known = await db.entity.findUnique({ where: { kind_key: { kind: 'person', key: personKey(p.emailHash, p.source) } }, select: { status: true } });
    if (known) {
      // Known already: seen again, counted by what that changed.
      const a = await db.$transaction((tx) => create(tx, p, p.source, now, `sync:${p.source}`));
      if (a === 'updated' || a === 'created') out.updated += 1;
      else if (a === 'unchanged') out.unchanged += 1;
      else out.refused += 1;
      continue;
    }
    if (!(await personAllowed(db, p.emailHash, p.source, now))) {
      out.refused += 1;
      continue;
    }
    fresh.push(p);
  }
  if (!fresh.length) return out;

  const tier = resolveTier(ACTION, { context: 'autonomous', tainted: true, sensitivity: 'personal', policies: await activePolicies(db, now), now });
  if (tier.tier === 'forbidden') return { ...out, refused: out.refused + fresh.length };
  if (tier.tier === 'alone') {
    for (const p of fresh) {
      if (tier.cap && (await claim(db, ACTION, tier.cap, tz, now)) === null) break;
      const applied = await db.$transaction(async (tx) => {
        const a = await create(tx, p, p.source, now, `runtime:${p.source}`);
        if (a === 'created') {
          await appendAudit(tx, [{
            actor: `runtime:${p.source}`, context: 'autonomous', kind: 'action', action: ACTION, tier: 'alone', decision: 'act', outcome: 'ok',
            inputs: { emailHash: p.emailHash.slice(0, 16), rule: tier.rule }, tainted: true,
          }], now);
        }
        return a;
      });
      if (applied === 'created') out.created += 1;
    }
    return out;
  }
  // APPROVAL: at most one card a day, none while one is open, and a week's quiet after Will turns one down
  // (counted from when the card could last have been rejected: its expiry).
  const last = await db.proposal.findFirst({ where: { action: ACTION, templateId: TEMPLATE }, orderBy: { createdAt: 'desc' }, select: { status: true, createdAt: true, expiresAt: true } });
  if (last) {
    const age = now.getTime() - last.createdAt.getTime();
    if (['pending', 'approved', 'executing'].includes(last.status) || age < DAY || (last.status === 'rejected' && now.getTime() - last.expiresAt.getTime() < 7 * DAY)) return out;
  }
  // One calendar a card: the people a sync reports all come from its own.
  const source = fresh[0]!.source;
  const batch = fresh.filter((p) => p.source === source).slice(0, PER_CARD).sort((a, b) => a.emailHash.localeCompare(b.emailHash)).map(({ source: _s, ...p }) => p);
  await createProposal(db, {
    kind: 'tool_call', origin: `runtime:${source}`, action: ACTION, templateId: TEMPLATE, args: { people: batch, ...(source === DEFAULT_SOURCE ? {} : { source }) },
    argsProvenance: { people: { source: 'event', ref: source, tainted: true } },
    tainted: true, sensitivity: 'personal', destructive: false, consequential: false, ttlMinutes: 24 * 60,
    reason: `Approving saves the names and addresses of ${batch.length} ${batch.length === 1 ? 'person' : 'people'} from events you accepted or organized.`,
  }, `runtime:${source}`, now);
  return { ...out, proposed: batch.length };
}

/** Carrying out a signed card: each person is checked against PersonGuard again, now, on the card's calendar. */
export async function createPeople(db: Db, args: unknown, now: Date, actor: string): Promise<{ created: number; skipped: number }> {
  const { people, source = DEFAULT_SOURCE } = PersonCreateArgs.parse(args);
  let created = 0;
  let skipped = 0;
  for (const p of people) {
    if ((await forgotten(db, p.emailHash)) || !(await personAllowed(db, p.emailHash, source, now))) {
      skipped += 1;
      continue;
    }
    const a = await db.$transaction((tx) => create(tx, p, source, now, actor));
    if (a === 'created') created += 1;
    else skipped += 1;
  }
  return { created, skipped };
}
