/**
 * P2.6 on flint_test: Will's Apple Calendar in the world model, as Google's is.
 *
 *  - Turning the source on needs Will's signed world.source.enable; the
 *    database refuses it otherwise.
 *  - A pushed snapshot, synced through the real source: the title only in
 *    EntityText, everything PERSONAL, keys under apple_calendar, and a person
 *    card that names its calendar.
 *  - PersonGuard per calendar: an Apple person needs an Apple commitment Will
 *    accepted or organized, a Google one is not enough (and the reverse); the
 *    database still refuses a person from any other source.
 *  - Forget: an Apple event's heads-ups and its other kind go with it; a person
 *    forgotten from either calendar is suppressed under both, in the runtime
 *    and in the database, and their entity from the other calendar is
 *    forgotten with them.
 *  - A push job runs past an open circuit and the cadence job does not; a
 *    snapshot older than the one last applied is never applied, even after a
 *    restart; an idle run touches nothing; a stale snapshot is a counted
 *    failure; a revoked one archives everything and the status says
 *    Disconnected (Off when the source is not on at all).
 *  - The migration: up gives the three functions both calendars; its down.sql
 *    gives back P2.5's bodies exactly, and a deploy applies it again, suppressing
 *    under both calendars anyone forgotten in between.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { digestOf } from '@flint/policy';
import { MIGRATIONS, NO_DB, freshDb, migrateUp, withClient, type TestUrls } from './db';
import { enrollTestKey } from './sign';
import { createDb, type Db } from '../src/db';
import { loadConfig, type Config } from '../src/config';
import { IDLE, syncOnce } from '../src/sources/sync';
import { createProposal, approveProposal } from '../src/governance/proposals';
import { proposeEnable, runInternal } from '../src/governance/internal';
import { processEvent, type WorkerDeps } from '../src/triage/worker';
import { syncJobs, type JobContext } from '../src/jobs';
import { appleCalendarSource, restoreInbox } from '../src/sources/apple/calendar';
import { CalendarInbox } from '../src/sources/apple/inbox';
import { parseSnapshot } from '../src/sources/apple/wire';
import { appleCalendarStatus } from '../src/report/apple-calendar';
import { p25Report } from '../src/report/p25';
import { emailHash, personExternalId, personKey } from '../src/world/people';
import { createPeople, offerPeople, personAllowed } from '../src/world/person-create';
import type { RaisedEvent, Source, SourceObservation, SourceRun, SyncResult } from '../src/sources/types';
import type { Bus } from '../src/bus';

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const H = (s: string) => createHash('sha256').update(s).digest('hex');
const CANARY = 'Dinner with CANARY-6b1e at the secret place';
const T0 = Math.floor(Date.now() / 60_000) * 60_000;
const iso = (t: number) => new Date(t).toISOString();
const run = (now = new Date()): SourceRun => ({ now, signal: new AbortController().signal, fetch: async () => new Response(null, { status: 599 }) });
const P26 = join(MIGRATIONS, '20261006000000_p26_apple_calendar');
const P25 = join(MIGRATIONS, '20261001000400_p25_google');

type Ev = Record<string, unknown>;
const ev = (name: string, o: Ev = {}): Ev => ({
  id: H(name), recurring: false, status: 'confirmed', title: `Title ${name}`, start: { at: iso(T0 + 3 * DAY) }, end: { at: iso(T0 + 3 * DAY + HOUR) }, self: 'accepted', ...o,
});
/** A snapshot Flint Calendar read at `at`, held in a fresh inbox (as the route holds one), and the source reading it. */
function pushed(events: Ev[], o: Ev = {}, at = Date.now()) {
  const raw = {
    v: 1, generatedAt: iso(at), access: 'full', state: 'live', window: { start: iso(at), end: iso(at + 14 * DAY) }, tz: 'UTC', complete: true,
    calendars: { count: 1, hash: H('cal') }, events, ...o,
  };
  const p = parseSnapshot(raw);
  if (!p.ok) throw new Error(`refused: ${p.issues.join(', ')}`);
  const inbox = new CalendarInbox(at - HOUR);
  expect(inbox.offer(p.snapshot, at)).toBe('accepted');
  return { inbox, source: appleCalendarSource({ tz: 'UTC', inbox }) };
}

const commitment = (source: 'google_calendar' | 'apple_calendar', id: string, o: { startsIn?: number; attendees?: string[] } = {}): SourceObservation => {
  const start = T0 + (o.startsIn ?? 5 * DAY);
  return {
    kind: 'commitment', key: `commitment:${source}:${id}`, externalId: `event:${id}`, name: `event ${iso(start).slice(0, 16).replace('T', ' ')}`,
    state: {
      source, startsAt: iso(start), endsAt: iso(start + HOUR), allDay: false, response: 'accepted', eventStatus: 'confirmed', confirmation: 'confirmed',
      ...(o.attendees?.length ? { attendeeHashes: o.attendees.map(emailHash).sort() } : {}),
    },
    sensitivity: 'personal', taintedPaths: [], type: 'commitment.state', texts: { title: `Title ${id}` },
  };
};
const deadline = (id: string, dueOn: string): SourceObservation => ({
  kind: 'deadline', key: `deadline:apple_calendar:${id}`, externalId: `deadline:${id}`, name: `deadline ${dueOn}`, state: { dueOn, source: 'apple_calendar' },
  sensitivity: 'personal', taintedPaths: [], type: 'deadline.state', texts: { title: `Due ${id}` },
});
const person = (source: 'google_calendar' | 'apple_calendar', email: string, name = 'Someone'): SourceObservation => {
  const h = emailHash(email);
  return { kind: 'person', key: personKey(h, source), externalId: personExternalId(h), name, state: { source, email, emailHash: h }, sensitivity: 'personal', taintedPaths: ['name', 'state.email'], type: 'person.seen' };
};
const fake = (name: 'google_calendar' | 'apple_calendar', r: Partial<SyncResult>): Source => ({ name, cadenceMs: 300_000, run: async () => ({ observations: [], metrics: [], ...r }) });

/** The bodies of a migration's functions, as written between its $$ quotes. */
function bodies(file: string): Record<string, string> {
  const sql = readFileSync(file, 'utf8');
  const out: Record<string, string> = {};
  for (const m of sql.matchAll(/FUNCTION (person_source_guard|person_insert_guard|entity_forgotten_p25)\(\) RETURNS trigger\nLANGUAGE plpgsql SET search_path = public, pg_temp AS \$\$([\s\S]*?)\$\$;/g)) out[m[1]!] = m[2]!;
  return out;
}

describe.skipIf(NO_DB)('P2.6 on flint_test', () => {
  let urls: TestUrls;
  let db: Db;
  let config: Config;
  let key: Awaited<ReturnType<typeof enrollTestKey>>;
  const noBus = { boss: { send: async () => null } } as unknown as Bus;
  const deps = (): WorkerDeps => ({ db, config, bus: noBus, load: async () => 'proceed' });
  const owner = async (sql: string, params: unknown[] = []) => withClient(urls.owner, (c) => c.query(sql, params));
  async function sign(pid: string, action: string, args: Record<string, unknown>) {
    await approveProposal(db, pid, await key.approve({ subjectId: pid, action, argsDigest: digestOf(args) }), undefined, 'test');
    return runInternal(db, pid, undefined, 'UTC', 'test');
  }
  let approvals = 0;
  async function forget(entityId: string) {
    const n = ++approvals;
    const expires = new Date(Date.now() + 600_000).toISOString();
    await withClient(urls.approver, async (c) => {
      if (n === 1) await c.query(`INSERT INTO "ApprovalCredential" (id, "credentialId", factor, "publicKey", label, "enrolledVia") VALUES ('c26', 'cred26', 'webauthn', '\\x00', 'k', 'enroll_code')`);
      await c.query(`INSERT INTO "Approval" (id, "subjectType", "subjectId", decision, payload, challenge, "credentialId", signature, "expiresAt") VALUES ($1, 'forget', $2, 'approve', $3, $4, 'cred26', '\\x01', $5)`, [
        `ap26${n}`, entityId, JSON.stringify({ v: 1, subjectType: 'forget', subjectId: entityId, decision: 'approve', action: 'world.forget', argsDigest: 'a'.repeat(64), expiresAt: expires, nonce: `n26${n}` }), 'c'.repeat(64), expires,
      ]);
    });
    await withClient(urls.app, (c) => c.query(`SELECT forget_entity($1, $2)`, [entityId, `ap26${n}`]));
  }
  const entity = (kind: string, k: string) => db.entity.findUnique({ where: { kind_key: { kind, key: k } } });
  /** The `apple-calendar` line, with the source on (FLINT_SOURCE_APPLE_CALENDAR=on), as this test's config has it. */
  const status = () => appleCalendarStatus(db, { on: config.appleCalendar });
  const suppressed = (source: string, externalId: string) => db.suppressedKey.count({ where: { source, externalIdHash: H(externalId) } });

  beforeAll(async () => {
    urls = await freshDb();
    db = createDb(urls.app);
    config = loadConfig({ DATABASE_URL: urls.app, HOME: '/nonexistent', FLINT_TZ: 'UTC', FLINT_RUNTIME_TRIAGE: 'on', FLINT_SOURCE_APPLE_CALENDAR: 'on' });
    key = await enrollTestKey(urls);
  });
  afterAll(async () => {
    // flint_test is shared with other branches and the deploy gate: an Apple Calendar cursor left behind would stop an
    // older branch's P2.5 down.sql (its cursor list has no apple_calendar).
    if (urls) await owner(`DELETE FROM "SourceCursor" WHERE "source" = 'apple_calendar'`);
    await db?.$disconnect();
  });

  it('turning it on needs a world.source.enable Will signed; before that the database refuses it and nothing runs', async () => {
    expect(await status()).toBe('Not Turned On · Never Read · 0 Events');
    expect(await syncOnce(db, pushed([ev('e0')]).source, run(), 'UTC')).toMatchObject({ ran: false, reason: expect.stringMatching(/^not enabled/) });
    await expect(withClient(urls.app, (c) => c.query(`INSERT INTO "SourceCursor" (source, cursor, enabled, "updatedAt") VALUES ('apple_calendar', '', true, now())`)))
      .rejects.toThrow(/needs an approved world\.source\.enable/);
    const p = await proposeEnable(db, 'apple_calendar');
    expect(await sign(p.id, 'world.source.enable', { source: 'apple_calendar' })).toEqual({ source: 'apple_calendar', enabled: true });
    expect(await status()).toBe('Waiting for Flint Calendar · Never Read · 0 Events');
  });

  it('a pushed snapshot: the title in EntityText only, PERSONAL, keys under apple_calendar, and a card that names its calendar', async () => {
    const ada = 'ada@example.com';
    const now = Date.now();
    const s = await syncOnce(db, pushed([
      ev('e1', { title: CANARY, self: 'organizer', attendees: [{ name: 'Ada Lovelace', email: ada, kind: 'person' }, { name: 'Room CANARY', email: 'room@example.com', kind: 'room' }] }),
      ev('e2', { title: 'CANARY visa expires', self: 'organizer', start: { day: iso(now + 4 * DAY).slice(0, 10) }, end: { day: iso(now + 5 * DAY).slice(0, 10) } }),
    ], {}, now).source, run(new Date(now)), 'UTC');
    expect(s).toMatchObject({ ran: true, failed: 0 });
    const e = await db.entity.findUniqueOrThrow({ where: { kind_key: { kind: 'commitment', key: `commitment:apple_calendar:${H('e1')}` } }, include: { versions: true, texts: true, sources: true } });
    expect(e.sensitivity).toBe('personal');
    expect(e.texts).toEqual([expect.objectContaining({ field: 'title', text: CANARY, tainted: true, source: 'apple_calendar' })]);
    expect(e.sources).toEqual([expect.objectContaining({ source: 'apple_calendar', externalId: `event:${H('e1')}`, accountOwner: 'will' })]);
    expect(await entity('deadline', `deadline:apple_calendar:${H('e2')}`)).toMatchObject({ sensitivity: 'personal', status: 'active' });
    const everywhere = JSON.stringify({
      entities: await db.entity.findMany({ select: { key: true, name: true, state: true } }),
      versions: await db.entityVersion.findMany({ select: { state: true, patch: true } }),
      events: await db.sourceEvent.findMany({ where: { source: 'apple_calendar' }, select: { sourceRef: true, payload: true, sensitivity: true } }),
      cursor: await db.sourceCursor.findUnique({ where: { source: 'apple_calendar' } }),
      audit: await db.auditEntry.findMany({ select: { inputs: true, reasoning: true } }),
    });
    expect(everywhere).not.toMatch(/CANARY|ada@|Ada/);
    expect((await db.sourceEvent.findMany({ where: { source: 'apple_calendar' }, select: { sensitivity: true } })).every((x) => x.sensitivity === 'personal')).toBe(true);
    // The person: not applied by the sync; one card, naming Apple Calendar; signed, created under it.
    expect(await db.entity.count({ where: { kind: 'person' } })).toBe(0);
    const card = await db.proposal.findFirstOrThrow({ where: { action: 'world.person.create', status: 'pending' } });
    expect(card).toMatchObject({ templateId: 'person.from_calendar', origin: 'runtime:apple_calendar', tainted: true, sensitivity: 'personal' });
    expect(card.args).toEqual({ people: [{ name: 'Ada Lovelace', email: ada, emailHash: emailHash(ada) }], source: 'apple_calendar' });
    expect(card.reason).toBe('Approving saves the names and addresses of 1 person from Apple Calendar events you accepted or organized.');
    expect(await sign(card.id, 'world.person.create', card.args as Record<string, unknown>)).toEqual({ created: 1, skipped: 0 });
    const p = await db.entity.findFirstOrThrow({ where: { kind: 'person' }, include: { sources: true } });
    expect(p).toMatchObject({ key: personKey(emailHash(ada), 'apple_calendar'), name: 'Ada Lovelace', state: { source: 'apple_calendar', email: ada, emailHash: emailHash(ada) } });
    expect(p.sources).toEqual([expect.objectContaining({ source: 'apple_calendar', externalId: personExternalId(emailHash(ada)) })]);
    expect(await status()).toBe('Connected · Last Read Just Now · 2 Events');
    const report = await p25Report(db, { home: '/nonexistent', tz: 'UTC' }, new Date(), 'apple_calendar');
    expect(report.criteria.find((c) => c.n === 1)!.values).toMatchObject({ enabled: true, commitments: 1, deadlines: 1 });
    expect(report.criteria.find((c) => c.n === 2)).toMatchObject({ pass: true, values: { accessOff: false, fresh: true } });
    expect(report.criteria.find((c) => c.n === 5)).toMatchObject({ pass: true, values: { people: 1, outsideRule: 0 } });
    expect(JSON.stringify(report)).not.toMatch(/CANARY|example\.com/);
  });

  it('PersonGuard per calendar: a Google commitment never lets in an Apple person, nor the reverse; the database refuses any other source', async () => {
    const g = await proposeEnable(db, 'google_calendar');
    await sign(g.id, 'world.source.enable', { source: 'google_calendar' });
    const bo = 'bo@example.com';
    const cy = 'cy@example.com';
    await syncOnce(db, fake('google_calendar', { observations: [commitment('google_calendar', 'gx', { attendees: [bo] })] }), run(), 'UTC');
    await syncOnce(db, fake('apple_calendar', { observations: [commitment('apple_calendar', 'ax', { attendees: [cy] })] }), run(), 'UTC');
    expect(await personAllowed(db, emailHash(bo), 'google_calendar')).toBe(true);
    expect(await personAllowed(db, emailHash(bo), 'apple_calendar')).toBe(false);
    expect(await personAllowed(db, emailHash(cy), 'apple_calendar')).toBe(true);
    expect(await personAllowed(db, emailHash(cy), 'google_calendar')).toBe(false);
    // A signed card for the wrong calendar creates nobody.
    for (const [who, source] of [[bo, 'apple_calendar'], [cy, undefined]] as const) {
      const args = { people: [{ name: 'X', email: who, emailHash: emailHash(who) }], ...(source ? { source } : {}) };
      const forged = await createProposal(db, { kind: 'tool_call', origin: 'runtime:apple_calendar', action: 'world.person.create', templateId: 'person.from_calendar', args, argsProvenance: { people: { source: 'event', tainted: true } }, tainted: true, sensitivity: 'personal', destructive: false, consequential: false, ttlMinutes: 60 }, 'test');
      expect(await sign(forged.id, 'world.person.create', args), who).toEqual({ created: 0, skipped: 1 });
    }
    // A sync offers only its own calendar's people.
    expect(await offerPeople(db, [person('google_calendar', bo)], new Date(Date.now() + 2 * DAY), 'UTC', 'apple_calendar')).toMatchObject({ refused: 1, proposed: 0 });
    // The database: an Apple person's source row from anywhere but a calendar is refused, and so is a person with none.
    const ada = await db.entity.findFirstOrThrow({ where: { kind: 'person', key: personKey(emailHash('ada@example.com'), 'apple_calendar') } });
    await expect(owner(`INSERT INTO "EntitySource" (id, "entityId", source, "externalId", "accountOwner", "lastSyncedAt") VALUES ('es26git', $1, 'git', 'x', 'will', now())`, [ada.id])).rejects.toThrow(/only from the calendar/);
    await expect(withClient(urls.app, async (c) => {
      await c.query('BEGIN');
      await c.query(`INSERT INTO "Entity" (id, kind, key, name, state, "stateHash", sensitivity, "lastObservedAt", "updatedAt") VALUES ('en26x', 'person', 'person:x', 'X', '{}', $1, 'personal', now(), now())`, ['0'.repeat(64)]);
      await c.query(`INSERT INTO "EntitySource" (id, "entityId", source, "externalId", "accountOwner", "lastSyncedAt") VALUES ('es26x', 'en26x', 'nexus', 'x', 'will', now())`);
      await c.query('COMMIT');
    })).rejects.toThrow(/only from the calendar/);
    // ...and either calendar's row is a calendar source.
    await withClient(urls.app, async (c) => {
      await c.query('BEGIN');
      await c.query(`INSERT INTO "Entity" (id, kind, key, name, state, "stateHash", sensitivity, "lastObservedAt", "updatedAt") VALUES ('en26ok', 'person', 'person:apple_calendar:ok', 'Ok', '{}', $1, 'personal', now(), now())`, ['0'.repeat(64)]);
      await c.query(`INSERT INTO "EntitySource" (id, "entityId", source, "externalId", "accountOwner", "lastSyncedAt") VALUES ('es26ok', 'en26ok', 'apple_calendar', 'person:ok', 'will', now())`);
      await c.query('COMMIT');
    });
  });

  it("forgetting an Apple event forgets its heads-ups (both kinds) and its other kind, under Apple Calendar's name", async () => {
    const at = T0 + 4 * HOUR;
    const due = iso(T0 + DAY).slice(0, 10);
    const up = (id: string, when: string, type = 'commitment.upcoming', k = 'commitment'): RaisedEvent => ({
      sourceRef: `upcoming:${id}:${when}`, type, occurredAt: new Date(), sensitivity: 'personal', tainted: false, current: true,
      payload: { entityKind: k, entityKey: `${k}:apple_calendar:${id}`, at: when },
    });
    const decideAll = async () => {
      for (const e of await db.sourceEvent.findMany({ where: { sourceRef: { startsWith: 'upcoming:fa:' }, decision: null } })) await processEvent({ eventId: e.id }, deps());
    };
    await syncOnce(db, fake('apple_calendar', { observations: [commitment('apple_calendar', 'fa', { startsIn: 4 * HOUR })], events: [up('fa', iso(at))] }), run(), 'UTC');
    await decideAll();
    await syncOnce(db, fake('apple_calendar', { observations: [deadline('fa', due)], warnings: ['apple calendar: item 9 set aside'], events: [up('fa', due, 'deadline.upcoming', 'deadline')] }), run(), 'UTC');
    await decideAll();
    const heads = await db.sourceEvent.findMany({ where: { sourceRef: { startsWith: 'upcoming:fa:' } }, include: { decision: { include: { escalation: true } } } });
    expect(heads).toHaveLength(2);
    const escalations = heads.flatMap((h) => (h.decision?.escalation ? [h.decision.escalation.id] : []));
    expect(escalations).toHaveLength(2);
    const c = (await entity('commitment', 'commitment:apple_calendar:fa'))!;
    const d = (await entity('deadline', 'deadline:apple_calendar:fa'))!;
    await forget(c.id);
    expect(await db.sourceEvent.count({ where: { sourceRef: { startsWith: 'upcoming:fa:' } } })).toBe(0);
    for (const x of await db.escalation.findMany({ where: { id: { in: escalations } } })) expect(x).toMatchObject({ title: 'Something needs a look', body: null, fields: {} });
    expect((await db.entity.findUniqueOrThrow({ where: { id: d.id } })).status).toBe('forgotten');
    expect(await suppressed('apple_calendar', 'deadline:fa')).toBe(1);
    expect(await suppressed('google_calendar', 'deadline:fa')).toBe(0);
    // Neither kind comes back.
    const s = await syncOnce(db, fake('apple_calendar', { observations: [commitment('apple_calendar', 'fa'), deadline('fa', due)] }), run(), 'UTC');
    expect(s.skipped).toBe(2);
  });

  it('a person forgotten from either calendar is forgotten under both: their other entity too, and the runtime and the database refuse them', async () => {
    const ada = 'ada@example.com';
    const h = emailHash(ada);
    const p = await db.entity.findFirstOrThrow({ where: { kind: 'person', key: personKey(h, 'apple_calendar') } });
    // She is in Will's Google Calendar too (an event he accepted), and was added from there: two entities, one person.
    await syncOnce(db, fake('google_calendar', { observations: [commitment('google_calendar', 'g-ada', { attendees: [ada] })] }), run(), 'UTC');
    const gArgs = { people: [{ name: 'Ada Lovelace', email: ada, emailHash: h }] };
    const gCard = await createProposal(db, { kind: 'tool_call', origin: 'runtime:google_calendar', action: 'world.person.create', templateId: 'person.from_calendar', args: gArgs, argsProvenance: { people: { source: 'event', tainted: true } }, tainted: true, sensitivity: 'personal', destructive: false, consequential: false, ttlMinutes: 60 }, 'test');
    expect(await sign(gCard.id, 'world.person.create', gArgs)).toEqual({ created: 1, skipped: 0 });
    const g = await db.entity.findFirstOrThrow({ where: { kind: 'person', key: personKey(h, 'google_calendar') } });
    expect([g.status, p.status]).toEqual(['active', 'active']);

    // Forgetting her Apple entity forgets her Google one as well, the way forget_entity would, and audits it as part of this forget.
    await forget(p.id);
    for (const id of [p.id, g.id]) {
      const e = await db.entity.findUniqueOrThrow({ where: { id }, include: { sources: true, versions: true } });
      expect(e).toMatchObject({ status: 'forgotten', state: {}, taintedPaths: [] });
      expect(e.name).toMatch(/^forgotten:/);
      expect(e.key).toMatch(/^forgotten:/);
      expect(e.sources.every((x) => x.externalId.startsWith('forgotten:'))).toBe(true);
      expect(e.versions.every((v) => v.state === null && v.patch === null)).toBe(true);
    }
    const cascade = await db.auditEntry.findMany({ where: { action: 'world.forget', correlationId: `ap26${approvals}` } });
    expect(cascade.map((a) => a.inputs)).toEqual(expect.arrayContaining([expect.objectContaining({ entityId: g.id, cascadeOf: p.id })]));
    // Her name and address are nowhere in the world model, nor on the card that added her from Google.
    const everywhere = JSON.stringify({
      entities: await db.entity.findMany({ select: { key: true, name: true, state: true } }),
      versions: await db.entityVersion.findMany({ select: { state: true, patch: true } }),
      cards: await db.proposal.findMany({ where: { action: 'world.person.create' }, select: { args: true, reason: true } }),
    });
    expect(everywhere).not.toMatch(/ada@example|Ada Lovelace/);
    expect(await suppressed('apple_calendar', personExternalId(h))).toBe(1);
    expect(await suppressed('google_calendar', personExternalId(h))).toBe(1);
    // Google offers her again (she is still on a Google event Will accepted): refused, and nobody is created by a card either.
    expect(await offerPeople(db, [person('google_calendar', ada, 'Ada')], new Date(Date.now() + 3 * DAY), 'UTC', 'google_calendar')).toMatchObject({ refused: 1, proposed: 0 });
    expect(await createPeople(db, { people: [{ name: 'Ada', email: ada, emailHash: h }] }, new Date(), 'test')).toEqual({ created: 0, skipped: 1 });
    // The database: her Google record would be refused too.
    await expect(withClient(urls.app, async (c) => {
      await c.query('BEGIN');
      await c.query(`INSERT INTO "Entity" (id, kind, key, name, state, "stateHash", sensitivity, "lastObservedAt", "updatedAt") VALUES ('en26ada', 'person', $1, 'Ada', '{}', $2, 'personal', now(), now())`, [personKey(h), '0'.repeat(64)]);
      await c.query(`INSERT INTO "EntitySource" (id, "entityId", source, "externalId", "accountOwner", "lastSyncedAt") VALUES ('es26ada', 'en26ada', 'google_calendar', $1, 'will', now())`, [personExternalId(h)]);
      await c.query('COMMIT');
    })).rejects.toThrow(/stays forgotten/);
    // The reverse: someone forgotten from Google is refused from Apple.
    const eve = 'eve@example.com';
    await syncOnce(db, fake('google_calendar', { observations: [commitment('google_calendar', 'g-eve', { attendees: [eve] })] }), run(), 'UTC');
    const args = { people: [{ name: 'Eve', email: eve, emailHash: emailHash(eve) }] };
    const card = await createProposal(db, { kind: 'tool_call', origin: 'runtime:google_calendar', action: 'world.person.create', templateId: 'person.from_calendar', args, argsProvenance: { people: { source: 'event', tainted: true } }, tainted: true, sensitivity: 'personal', destructive: false, consequential: false, ttlMinutes: 60 }, 'test');
    expect(await sign(card.id, 'world.person.create', args)).toEqual({ created: 1, skipped: 0 });
    await forget((await entity('person', personKey(emailHash(eve))))!.id);
    await syncOnce(db, fake('apple_calendar', { observations: [commitment('apple_calendar', 'a-eve', { attendees: [eve] })] }), run(), 'UTC');
    expect(await offerPeople(db, [person('apple_calendar', eve, 'Eve')], new Date(Date.now() + 4 * DAY), 'UTC', 'apple_calendar')).toMatchObject({ refused: 1, proposed: 0 });
    expect(await suppressed('apple_calendar', personExternalId(emailHash(eve)))).toBe(1);
  });

  it('a push job runs past an open circuit; the cadence job waits for it', async () => {
    const { source } = pushed([ev('cj')]);
    const ctx = { db, config, bus: noBus, sources: [{ source, endpoints: [] }], log: () => {} } as unknown as JobContext;
    const [spec] = syncJobs(ctx);
    expect(spec!.queue).toBe('sync.apple_calendar');
    const open = async () => owner(`UPDATE "SourceCursor" SET "consecutiveFailures" = 5, "lastError" = 'apple calendar: x', "updatedAt" = now() WHERE "source" = 'apple_calendar'`);
    const failures = async () => (await db.sourceCursor.findUniqueOrThrow({ where: { source: 'apple_calendar' } })).consecutiveFailures;
    await open();
    await spec!.handler([{ data: null }] as never);
    expect(await failures()).toBe(5);
    await spec!.handler([{ data: { reason: 'cron' } }] as never);
    expect(await failures()).toBe(5);
    await spec!.handler([{ data: { reason: 'push' } }] as never);
    expect(await failures()).toBe(0);
    expect(await entity('commitment', `commitment:apple_calendar:${H('cj')}`)).not.toBeNull();
  });

  it('a snapshot older than the one last applied is never applied, even after a restart: the inbox turns it away, and the source would not apply it', async () => {
    const before = await db.sourceCursor.findUniqueOrThrow({ where: { source: 'apple_calendar' } });
    const applied = JSON.parse(before.cursor) as { generatedAt?: string };
    expect(applied.generatedAt).toBeDefined();
    const at = Date.parse(applied.generatedAt!);
    // A restart: a new inbox, restored from the cursor, as index.ts does. A replay of an older snapshot (still fresh) is turned away.
    const inbox = new CalendarInbox(Date.now() - HOUR);
    await restoreInbox(db, inbox);
    const older = parseSnapshot({
      v: 1, generatedAt: iso(at - MIN), access: 'full', state: 'revoked', window: { start: iso(at - MIN), end: iso(at + 13 * DAY) }, tz: 'UTC', complete: true,
      calendars: { count: 1, hash: H('cal') }, events: [],
    });
    if (!older.ok) throw new Error('refused');
    expect(inbox.offer(older.snapshot, at)).toBe('stale');
    // Had it got in (an inbox that did not know), the source applies nothing: a revoked replay would have archived every event.
    const unaware = new CalendarInbox(at - HOUR);
    expect(unaware.offer(older.snapshot, at)).toBe('accepted');
    const active = await db.entity.count({ where: { status: 'active', sources: { some: { source: 'apple_calendar' } }, kind: { in: ['commitment', 'deadline'] } } });
    expect(active).toBeGreaterThan(0);
    expect(await syncOnce(db, appleCalendarSource({ tz: 'UTC', inbox: unaware }), run(new Date(at)), 'UTC')).toMatchObject({ ran: false, reason: IDLE });
    expect(await db.entity.count({ where: { status: 'active', sources: { some: { source: 'apple_calendar' } }, kind: { in: ['commitment', 'deadline'] } } })).toBe(active);
    expect(await db.sourceCursor.findUniqueOrThrow({ where: { source: 'apple_calendar' } })).toEqual(before);
  });

  it('an idle run touches nothing; a stale snapshot is a counted failure that archives nothing; a revoked one archives everything', async () => {
    const before = await db.sourceCursor.findUniqueOrThrow({ where: { source: 'apple_calendar' } });
    const audits = await db.auditEntry.count({ where: { action: 'world.sync.apple_calendar' } });
    const rollups = await db.auditRollup.findMany({ where: { action: 'world.sync.apple_calendar' } });
    const idle = appleCalendarSource({ tz: 'UTC', inbox: new CalendarInbox(Date.now()) });
    expect(await syncOnce(db, idle, run(), 'UTC')).toMatchObject({ ran: false, reason: IDLE, created: 0, failed: 0 });
    expect(await db.sourceCursor.findUniqueOrThrow({ where: { source: 'apple_calendar' } })).toEqual(before);
    expect(await db.auditEntry.count({ where: { action: 'world.sync.apple_calendar' } })).toBe(audits);
    expect(await db.auditRollup.findMany({ where: { action: 'world.sync.apple_calendar' } })).toEqual(rollups);
    // Read 20 minutes ago and not since: a failure, said plainly, with nothing archived.
    const active = await db.entity.count({ where: { status: 'active', sources: { some: { source: 'apple_calendar' } }, kind: { in: ['commitment', 'deadline'] } } });
    expect(active).toBeGreaterThan(0);
    const stale = await syncOnce(db, pushed([], {}, Date.now() - 20 * MIN).source, run(), 'UTC');
    expect(stale).toMatchObject({ ran: true, failed: 1, reason: expect.stringMatching(/^apple calendar: Flint Calendar hasn't reported since (\d{4}-\d\d-\d\d )?\d\d:\d\d$/) });
    expect((await db.sourceCursor.findUniqueOrThrow({ where: { source: 'apple_calendar' } })).consecutiveFailures).toBe(before.consecutiveFailures + 1);
    expect(await db.entity.count({ where: { status: 'active', sources: { some: { source: 'apple_calendar' } }, kind: { in: ['commitment', 'deadline'] } } })).toBe(active);
    expect(await status()).toMatch(/^Not Reporting · Last Read (Just Now|\d+ Min Ago) · \d+ Events?$/);
    // Calendar access off: said so, and still nothing archived.
    await syncOnce(db, pushed([], { access: 'denied' }).source, run(), 'UTC');
    expect(await status()).toMatch(/^Calendar Access Is Off · /);
    const off = await p25Report(db, { home: '/nonexistent', tz: 'UTC' }, new Date(), 'apple_calendar');
    expect(off.criteria.find((c) => c.n === 2)).toMatchObject({ pass: false, values: { accessOff: true } });
    // Disconnected: every Apple event archived; nothing of Google's.
    const google = await db.entity.count({ where: { status: 'active', sources: { some: { source: 'google_calendar' } }, kind: 'commitment' } });
    const s = await syncOnce(db, pushed([], { state: 'revoked', access: 'denied' }).source, run(), 'UTC');
    expect(s).toMatchObject({ ran: true, failed: 0 });
    expect(await db.entity.count({ where: { status: 'active', sources: { some: { source: 'apple_calendar' } }, kind: { in: ['commitment', 'deadline'] } } })).toBe(0);
    expect(await db.entity.count({ where: { status: 'active', sources: { some: { source: 'google_calendar' } }, kind: 'commitment' } })).toBe(google);
    expect(await status()).toBe('Disconnected · Last Read Just Now · 0 Events');
    // Then the helper is quiet, as a disconnected one is: an hour on, the run is idle, not a failure, and it still says so.
    const quiet = appleCalendarSource({ tz: 'UTC', inbox: new CalendarInbox(Date.now() - 2 * HOUR) });
    expect(await syncOnce(db, quiet, run(new Date(Date.now() + HOUR)), 'UTC')).toMatchObject({ ran: false, reason: IDLE, failed: 0 });
    expect(await status()).toBe('Disconnected · Last Read Just Now · 0 Events');
    // With the source switched off (disconnect.sh removes FLINT_SOURCE_APPLE_CALENDAR), it is Off, whatever the cursor says.
    expect(await appleCalendarStatus(db, { on: false })).toBe('Off · Last Read Just Now · 0 Events');
  });

  it("the migration: both calendars up; down.sql gives back P2.5's bodies exactly and drops the cursor and queue; deploy applies it again", async () => {
    const fns = async () => Object.fromEntries((await owner(`SELECT proname, prosrc, proacl::text AS acl FROM pg_proc WHERE proname IN ('person_source_guard', 'person_insert_guard', 'entity_forgotten_p25') ORDER BY 1`)).rows.map((r) => [r.proname, r.prosrc]));
    const acls = async () => (await owner(`SELECT proname, proacl::text AS acl, pg_get_userbyid(proowner) AS owner FROM pg_proc WHERE proname IN ('person_source_guard', 'person_insert_guard', 'entity_forgotten_p25') ORDER BY 1`)).rows;
    const queue = async () => (await owner(`SELECT name FROM pgboss.queue WHERE name = 'sync.apple_calendar'`)).rows.length;
    const applied = async () => (await owner(`SELECT 1 FROM _prisma_migrations WHERE migration_name = '20261006000000_p26_apple_calendar' AND finished_at IS NOT NULL`)).rows.length;
    const up = bodies(join(P26, 'migration.sql'));
    const p25 = bodies(join(P25, 'migration.sql'));
    expect(Object.keys(up).sort()).toEqual(['entity_forgotten_p25', 'person_insert_guard', 'person_source_guard']);
    expect(Object.keys(p25).sort()).toEqual(Object.keys(up).sort());
    expect(bodies(join(P26, 'down.sql'))).toEqual(p25);
    const acl = await acls();
    expect(acl.every((r) => r.owner === 'flint_owner' && !/(^|[{,])=/.test(String(r.acl ?? '')))).toBe(true);
    expect(await fns()).toEqual(up);
    expect([await queue(), await applied()]).toEqual([1, 1]);
    const appleRows = await db.entitySource.count({ where: { source: 'apple_calendar' } });
    expect(appleRows).toBeGreaterThan(0);

    await owner(readFileSync(join(P26, 'down.sql'), 'utf8'));
    expect(await fns()).toEqual(p25);
    expect(await acls()).toEqual(acl);
    expect([await queue(), await applied()]).toEqual([0, 0]);
    expect(await db.sourceCursor.count({ where: { source: 'apple_calendar' } })).toBe(0);
    await expect(owner(`INSERT INTO "SourceCursor" (source, cursor, enabled, "updatedAt") VALUES ('apple_calendar', '', false, now())`)).rejects.toThrow(/SourceCursor_source_check/);
    // Its source rows stay (an entity is never deleted, and a forget made now must still suppress them).
    expect(await db.entitySource.count({ where: { source: 'apple_calendar' } })).toBe(appleRows);
    // Rolled back, a person is Google's alone again.
    await expect(withClient(urls.app, async (c) => {
      await c.query('BEGIN');
      await c.query(`INSERT INTO "Entity" (id, kind, key, name, state, "stateHash", sensitivity, "lastObservedAt", "updatedAt") VALUES ('en26rb', 'person', 'person:apple_calendar:rb', 'Rb', '{}', $1, 'personal', now(), now())`, ['0'.repeat(64)]);
      await c.query(`INSERT INTO "EntitySource" (id, "entityId", source, "externalId", "accountOwner", "lastSyncedAt") VALUES ('es26rb', 'en26rb', 'apple_calendar', 'person:rb', 'will', now())`);
      await c.query('COMMIT');
    })).rejects.toThrow(/only from the calendar \(google_calendar\)/);

    // Someone forgotten while rolled back (as under P2.5) is suppressed under Google alone...
    const old = emailHash('old@example.com');
    await withClient(urls.app, async (c) => {
      await c.query('BEGIN');
      await c.query(`INSERT INTO "Entity" (id, kind, key, name, state, "stateHash", sensitivity, "lastObservedAt", "updatedAt") VALUES ('en26old', 'person', $1, 'Old', $2, $3, 'personal', now(), now())`, [personKey(old), JSON.stringify({ source: 'google_calendar', email: 'old@example.com', emailHash: old }), '0'.repeat(64)]);
      await c.query(`INSERT INTO "EntitySource" (id, "entityId", source, "externalId", "accountOwner", "lastSyncedAt") VALUES ('es26old', 'en26old', 'google_calendar', $1, 'will', now())`, [personExternalId(old)]);
      await c.query('COMMIT');
    });
    await forget('en26old');
    expect([await suppressed('google_calendar', personExternalId(old)), await suppressed('apple_calendar', personExternalId(old))]).toEqual([1, 0]);

    await migrateUp(urls.owner);
    expect(await fns()).toEqual(up);
    expect(await acls()).toEqual(acl);
    expect([await queue(), await applied()]).toEqual([1, 1]);
    // ...and the migration suppresses them under Apple Calendar too: the database refuses their Apple record.
    expect(await suppressed('apple_calendar', personExternalId(old))).toBe(1);
    await expect(withClient(urls.app, async (c) => {
      await c.query('BEGIN');
      await c.query(`INSERT INTO "Entity" (id, kind, key, name, state, "stateHash", sensitivity, "lastObservedAt", "updatedAt") VALUES ('en26old2', 'person', $1, 'Old', '{}', $2, 'personal', now(), now())`, [personKey(old, 'apple_calendar'), '0'.repeat(64)]);
      await c.query(`INSERT INTO "EntitySource" (id, "entityId", source, "externalId", "accountOwner", "lastSyncedAt") VALUES ('es26old2', 'en26old2', 'apple_calendar', $1, 'will', now())`, [personExternalId(old)]);
      await c.query('COMMIT');
    })).rejects.toThrow(/stays forgotten/);
  });
});
