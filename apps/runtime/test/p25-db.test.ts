/**
 * P2.5 on flint_test: Will's calendar in the world model without its words.
 *
 *  - A calendar title goes to EntityText only: never the entity's name, its
 *    state, a version or the event payload; refreshed while seen, removed when
 *    the event loses it, deleted by retention a week after it was last seen,
 *    and at once by a forget.
 *  - People: an ordinary sync never applies one. New ones are offered on one
 *    card at a time (at most one a day, none for a week after a rejection);
 *    PersonGuard lets through only attendees of an event Will accepted or
 *    organized, when offered and again when the card runs; promoted, they are
 *    created under the cap with an audit entry of hashes only; the database
 *    refuses a person from any other source.
 *  - A heads-up names its event by kind and key, resolves to the entity, and is
 *    one escalation with a time and no title; a forgotten event raises none.
 *  - Entity reads mark the title tainted; the report and the promotion gate.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digestOf } from '@flint/policy';
import { NO_DB, freshDb, withClient, type TestUrls } from './db';
import { enrollTestKey } from './sign';
import { createDb, type Db } from '../src/db';
import { loadConfig, type Config } from '../src/config';
import { syncOnce } from '../src/sources/sync';
import { createProposal, approveProposal, rejectProposal } from '../src/governance/proposals';
import { runInternal } from '../src/governance/internal';
import { promotionTable } from '../src/governance/promotion';
import { processEvent, type WorkerDeps } from '../src/triage/worker';
import { runRetention } from '../src/retention';
import { appendAudit } from '../src/governance/audit';
import { p25Report } from '../src/report/p25';
import { buildApp } from '../src/app';
import { emailHash, personExternalId, personKey } from '../src/world/people';
import { offerPeople } from '../src/world/person-create';
import type { RaisedEvent, Source, SourceObservation, SourceRun } from '../src/sources/types';
import type { Bus } from '../src/bus';

const DAY = 86_400_000;
const CANARY = 'Dinner with CANARY-7f3a at the secret place';
const run = (now = new Date()): SourceRun => ({ now, signal: new AbortController().signal, fetch: async () => new Response(null, { status: 599 }) });

const iso = (t: number) => new Date(t).toISOString();
/** Events are placed from one fixed instant, so the same event read twice is the same state. */
const T0 = Math.floor(Date.now() / 60_000) * 60_000;
function event(id: string, opts: { title?: string; startsIn?: number; response?: string; attendees?: string[]; status?: 'active' | 'archived' } = {}, now = T0): SourceObservation {
  const start = now + (opts.startsIn ?? 3 * 3_600_000);
  return {
    kind: 'commitment', key: `commitment:google_calendar:${id}`, externalId: `event:${id}`, name: `event ${iso(start).slice(0, 16).replace('T', ' ')}`,
    state: {
      source: 'google_calendar', startsAt: iso(start), endsAt: iso(start + 3_600_000), allDay: false, response: opts.response ?? 'accepted',
      eventStatus: 'confirmed', confirmation: 'confirmed', ...(opts.attendees?.length ? { attendeeHashes: opts.attendees.map(emailHash).sort() } : {}),
    },
    ...(opts.status ? { status: opts.status } : {}),
    // The adapter "forgets" the sensitivity: the sync makes every calendar observation PERSONAL anyway.
    sensitivity: 'ops', taintedPaths: [], type: 'commitment.state', ...(opts.title !== undefined ? { texts: { title: opts.title } } : {}),
  };
}
const person = (email: string, name = 'Ada Lovelace'): SourceObservation => {
  const h = emailHash(email);
  return { kind: 'person', key: personKey(h), externalId: personExternalId(h), name, state: { source: 'google_calendar', email, emailHash: h }, sensitivity: 'personal', taintedPaths: ['name', 'state.email'], type: 'person.seen' };
};
const calendar = (observations: SourceObservation[], events: RaisedEvent[] = []): Source => ({ name: 'google_calendar', cadenceMs: 300_000, run: async () => ({ observations, metrics: [], events }) });

describe.skipIf(NO_DB)('P2.5 on flint_test', () => {
  let urls: TestUrls;
  let db: Db;
  let config: Config;
  let home: string;
  let key: Awaited<ReturnType<typeof enrollTestKey>>;
  const noBus = { boss: { send: async () => null } } as unknown as Bus;
  const deps = (): WorkerDeps => ({ db, config, bus: noBus, load: async () => 'proceed' });
  const owner = async (sql: string, params: unknown[] = []) => withClient(urls.owner, (c) => c.query(sql, params));
  async function sign(pid: string, action: string, args: Record<string, unknown>) {
    await approveProposal(db, pid, await key.approve({ subjectId: pid, action, argsDigest: digestOf(args) }), undefined, 'test');
    return runInternal(db, pid, undefined, 'UTC', 'test');
  }

  beforeAll(async () => {
    urls = await freshDb();
    db = createDb(urls.app);
    home = mkdtempSync(join(tmpdir(), 'p25-'));
    config = loadConfig({ DATABASE_URL: urls.app, HOME: home, FLINT_TZ: 'UTC', FLINT_RUNTIME_TRIAGE: 'on' });
    key = await enrollTestKey(urls);
    const args = { source: 'google_calendar' };
    const p = await createProposal(db, { kind: 'tool_call', origin: 'console', action: 'world.source.enable', args, argsProvenance: { source: { source: 'will', tainted: false } }, tainted: false, sensitivity: 'ops', destructive: false, consequential: false, ttlMinutes: 60 }, 'test');
    expect(await sign(p.id, 'world.source.enable', args)).toEqual({ source: 'google_calendar', enabled: true });
  });
  afterAll(async () => db?.$disconnect());

  it('a title lives in EntityText only: never the name, state, a version or the event, and the calendar is PERSONAL', async () => {
    const s = await syncOnce(db, calendar([event('e1', { title: CANARY })]), run(), 'UTC');
    expect(s).toMatchObject({ ran: true, created: 1, failed: 0 });
    const e = await db.entity.findUniqueOrThrow({ where: { kind_key: { kind: 'commitment', key: 'commitment:google_calendar:e1' } }, include: { versions: true, texts: true } });
    expect(e.sensitivity).toBe('personal');
    expect(e.texts).toEqual([expect.objectContaining({ field: 'title', text: CANARY, tainted: true, source: 'google_calendar' })]);
    const everywhere = JSON.stringify({ name: e.name, key: e.key, state: e.state, versions: e.versions, events: await db.sourceEvent.findMany({ where: { source: 'google_calendar' } }) });
    expect(everywhere).not.toContain('CANARY');
    expect((await db.sourceEvent.findFirstOrThrow({ where: { source: 'google_calendar' } })).sensitivity).toBe('personal');
    // A new title is not a world change (no version), only a refresh; a removed one is deleted.
    await syncOnce(db, calendar([event('e1', { title: 'Renamed CANARY' })]), run(), 'UTC');
    expect(await db.entityVersion.count({ where: { entityId: e.id } })).toBe(1);
    expect((await db.entityText.findFirstOrThrow({ where: { entityId: e.id } })).text).toBe('Renamed CANARY');
    await syncOnce(db, calendar([event('e1', { title: '' })]), run(), 'UTC');
    expect(await db.entityText.count({ where: { entityId: e.id } })).toBe(0);
    // An archive (the event passed) keeps its text until retention takes it.
    await syncOnce(db, calendar([event('e1', { title: CANARY })]), run(), 'UTC');
    await syncOnce(db, calendar([{ ...event('e1'), status: 'archived' }]), run(), 'UTC');
    expect(await db.entityText.count({ where: { entityId: e.id } })).toBe(1);
  });

  it('reading the entity returns its title marked tainted', async () => {
    const token = 'p25-world-reader-token';
    const app = buildApp({
      db, status: { problems: [], busStartedAt: null } as never,
      config: { tz: 'UTC', triage: true, tokens: [{ name: 'runtime-mcp', sha256: createHash('sha256').update(token).digest('hex'), scopes: new Set(['world:read'] as const) }] },
    });
    const e = await db.entity.findUniqueOrThrow({ where: { kind_key: { kind: 'commitment', key: 'commitment:google_calendar:e1' } } });
    const r = await app.inject({ method: 'GET', url: `/v1/world/entities/${e.id}`, headers: { authorization: `Bearer ${token}` } });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { entity: { texts?: { title?: string }; taintedPaths: string[] }; tainted: boolean };
    expect(body.entity.texts?.title).toBe(CANARY);
    expect(body.entity.taintedPaths).toContain('texts.title');
    expect(body.tainted).toBe(true);
    await app.close();
  });

  it('retention deletes a title a week after it was last seen; forget deletes it at once', async () => {
    const e = await db.entity.findUniqueOrThrow({ where: { kind_key: { kind: 'commitment', key: 'commitment:google_calendar:e1' } } });
    await owner(`UPDATE "EntityText" SET "observedAt" = $2 WHERE "entityId" = $1`, [e.id, new Date(Date.now() - 6 * DAY)]);
    expect((await runRetention(db, 'UTC')).entityTexts).toBe(0);
    await owner(`UPDATE "EntityText" SET "observedAt" = $2 WHERE "entityId" = $1`, [e.id, new Date(Date.now() - 8 * DAY)]);
    expect((await runRetention(db, 'UTC')).entityTexts).toBe(1);
    // Forget: the text goes with the entity, in the same transaction.
    await syncOnce(db, calendar([event('e9', { title: CANARY })]), run(), 'UTC');
    const f = await db.entity.findUniqueOrThrow({ where: { kind_key: { kind: 'commitment', key: 'commitment:google_calendar:e9' } } });
    expect(await db.entityText.count({ where: { entityId: f.id } })).toBe(1);
    const expires = new Date(Date.now() + 600_000).toISOString();
    await withClient(urls.approver, async (c) => {
      await c.query(`INSERT INTO "ApprovalCredential" (id, "credentialId", factor, "publicKey", label, "enrolledVia") VALUES ('cf1', 'credf1', 'webauthn', '\\x00', 'k', 'enroll_code')`);
      await c.query(`INSERT INTO "Approval" (id, "subjectType", "subjectId", decision, payload, challenge, "credentialId", signature, "expiresAt") VALUES ('apf1', 'forget', $1, 'approve', $2, $3, 'credf1', '\\x01', $4)`, [
        f.id, JSON.stringify({ v: 1, subjectType: 'forget', subjectId: f.id, decision: 'approve', action: 'world.forget', argsDigest: 'a'.repeat(64), expiresAt: expires, nonce: 'n' }), 'c'.repeat(64), expires,
      ]);
    });
    await withClient(urls.app, (c) => c.query(`SELECT forget_entity($1, 'apf1')`, [f.id]));
    expect(await db.entityText.count({ where: { entityId: f.id } })).toBe(0);
  });

  it('people: never applied by the sync; one card, PersonGuard twice, the database a third time', async () => {
    const ada = 'ada@example.com';
    const eve = 'eve@example.com';
    // Ada is on an accepted event; Eve only on one Will declined... which never reaches the world (so not on any).
    const s = await syncOnce(db, calendar([event('m1', { title: 'Sync', attendees: [ada] }), person(ada), person(eve, 'Eve')]), run(), 'UTC');
    expect(s.failed).toBe(0);
    expect(await db.entity.count({ where: { kind: 'person' } })).toBe(0);
    const cards = await db.proposal.findMany({ where: { action: 'world.person.create' } });
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ templateId: 'person.from_calendar', origin: 'runtime:google_calendar', tainted: true, sensitivity: 'personal', status: 'pending' });
    expect((cards[0]!.args as { people: Array<{ email: string }> }).people.map((p) => p.email)).toEqual([ada]);
    // The next sync files no second card while this one is open.
    await syncOnce(db, calendar([event('m1', { title: 'Sync', attendees: [ada] }), person(ada)]), run(), 'UTC');
    expect(await db.proposal.count({ where: { action: 'world.person.create' } })).toBe(1);
    // Signed: Ada is created (by the guard again). Hashes key her; the address is in her state only.
    expect(await sign(cards[0]!.id, 'world.person.create', cards[0]!.args as Record<string, unknown>)).toEqual({ created: 1, skipped: 0 });
    const p = await db.entity.findFirstOrThrow({ where: { kind: 'person' }, include: { sources: true } });
    expect(p).toMatchObject({ key: personKey(emailHash(ada)), name: 'Ada Lovelace', sensitivity: 'personal', taintedPaths: ['name', 'state.email'] });
    expect(p.sources).toEqual([expect.objectContaining({ source: 'google_calendar', accountOwner: 'will', externalId: personExternalId(emailHash(ada)) })]);
    expect(JSON.stringify(await db.sourceEvent.findMany({ where: { source: 'google_calendar' }, select: { sourceRef: true, payload: true } }))).not.toContain(ada);
    // A card for someone PersonGuard no longer allows (Will declined since): signed, nobody is created.
    const args = { people: [{ name: 'Eve', email: eve, emailHash: emailHash(eve) }] };
    const forged = await createProposal(db, { kind: 'tool_call', origin: 'runtime:google_calendar', action: 'world.person.create', templateId: 'person.from_calendar', args, argsProvenance: { people: { source: 'event', tainted: true } }, tainted: true, sensitivity: 'personal', destructive: false, consequential: false, ttlMinutes: 60 }, 'test');
    expect(await sign(forged.id, 'world.person.create', args)).toEqual({ created: 0, skipped: 1 });
    // Not the calendar's card: refused outright.
    const other = await createProposal(db, { kind: 'tool_call', origin: 'console', action: 'world.person.create', args, argsProvenance: { people: { source: 'will', tainted: false } }, tainted: false, sensitivity: 'personal', destructive: false, consequential: false, ttlMinutes: 60 }, 'test');
    await expect(sign(other.id, 'world.person.create', args)).rejects.toThrow(/person\.from_calendar/);
    // The database: a person from another source, or with no calendar source at all, is refused.
    await expect(owner(`INSERT INTO "EntitySource" (id, "entityId", source, "externalId", "accountOwner", "lastSyncedAt") VALUES ('esx', $1, 'nexus', 'x', 'will', now())`, [p.id])).rejects.toThrow(/only from the calendar/);
    await expect(withClient(urls.app, async (c) => {
      await c.query('BEGIN');
      await c.query(`INSERT INTO "Entity" (id, kind, key, name, state, "stateHash", sensitivity, "lastObservedAt", "updatedAt") VALUES ('enx', 'person', 'person:x', 'X', '{}', $1, 'personal', now(), now())`, ['0'.repeat(64)]);
      await c.query('COMMIT');
    })).rejects.toThrow(/needs its calendar source/);
  });

  it('people: a rejected card means a quiet week; promoted, they are created under the cap, audited by hash', async () => {
    const grace = 'grace@example.com';
    const now = Date.now();
    // An event far enough ahead that it is still on the calendar when the later offers are made.
    await syncOnce(db, calendar([event('m2', { attendees: [grace], startsIn: 20 * DAY }), person(grace, 'Grace')], []), run(new Date(now)), 'UTC');
    // Within a day of the last card: none yet. A day later: one; rejected; then a week of quiet.
    expect(await db.proposal.count({ where: { action: 'world.person.create', status: 'pending' } })).toBe(0);
    await offerPeople(db, [person(grace, 'Grace')], new Date(now + 1.1 * DAY), 'UTC');
    const card = await db.proposal.findFirstOrThrow({ where: { action: 'world.person.create', status: 'pending' } });
    await rejectProposal(db, card.id, {}, undefined, 'test');
    await offerPeople(db, [person(grace, 'Grace')], new Date(now + 3 * DAY), 'UTC');
    expect(await db.proposal.count({ where: { action: 'world.person.create', status: 'pending' } })).toBe(0);
    // Promoted (a signed policy row): created at once, counted, audited with a hash prefix only.
    const rows = { rows: [{ pattern: 'world.person.create', tier: 'alone', dailyCap: 20, reason: 'test', expiresAt: new Date(Date.now() + DAY).toISOString() }] };
    const pol = await createProposal(db, { kind: 'policy', origin: 'console', action: 'policy.change', args: rows, argsProvenance: { rows: { source: 'will', tainted: false } }, tainted: false, sensitivity: 'ops', destructive: false, consequential: true, ttlMinutes: 60 }, 'test');
    await sign(pol.id, 'policy.change', rows);
    expect(await offerPeople(db, [person(grace, 'Grace')], new Date(), 'UTC')).toMatchObject({ created: 1, proposed: 0 });
    const audit = await db.auditEntry.findFirstOrThrow({ where: { action: 'world.person.create', tier: 'alone' } });
    expect(JSON.stringify({ ...audit, seq: String(audit.seq) })).not.toMatch(/grace|Grace/);
    expect((audit.inputs as { emailHash: string }).emailHash).toBe(emailHash(grace).slice(0, 16));
    // Someone not on an event Will accepted is refused even when promoted.
    expect(await offerPeople(db, [person('mallory@example.com', 'Mallory')], new Date(), 'UTC')).toMatchObject({ created: 0, refused: 1 });
  });

  it('a heads-up resolves to its event and is one escalation with a time and no title; a forgotten or vanished event raises none', async () => {
    const now = new Date();
    const upcoming = (id: string, day: string, time: string): RaisedEvent => ({
      sourceRef: `upcoming:${id}:x`, type: 'commitment.upcoming', occurredAt: now, sensitivity: 'personal', tainted: false, current: true,
      payload: { entityKind: 'commitment', entityKey: `commitment:google_calendar:${id}`, day, time, allDay: false },
    });
    await syncOnce(db, calendar([event('u1', { title: CANARY, startsIn: 3_600_000 })], [upcoming('u1', 'today', '14:30'), upcoming('ghost', 'today', '09:00')]), run(now), 'UTC');
    const evs = await db.sourceEvent.findMany({ where: { source: 'google_calendar', type: 'commitment.upcoming' } });
    expect(evs).toHaveLength(1);
    const ent = await db.entity.findUniqueOrThrow({ where: { kind_key: { kind: 'commitment', key: 'commitment:google_calendar:u1' } } });
    expect(evs[0]!.payload).toEqual({ entityId: ent.id, day: 'today', time: '14:30', allDay: false });
    expect(await processEvent({ eventId: evs[0]!.id }, deps())).toBe('decided');
    const d = await db.triageDecision.findUniqueOrThrow({ where: { sourceEventId: evs[0]!.id }, include: { escalation: true } });
    expect(d).toMatchObject({ action: 'escalate', critical: false, decidedBy: 'code:calendar.upcoming' });
    // The date and time are the event's own, worked out when triage decided (in Flint's zone, UTC here), never the title.
    const start = new Date(T0 + 3_600_000);
    const day = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }).format(start).replace(',', '');
    expect(d.escalation).toMatchObject({ templateId: 'calendar_upcoming', title: `On your calendar ${day} at ${start.toISOString().slice(11, 16)}` });
    expect(d.escalation!.fields).toMatchObject({ date: start.toISOString().slice(0, 10), time: start.toISOString().slice(11, 16), until: start.toISOString() });
    expect(JSON.stringify(d.escalation)).not.toContain('CANARY');
    // Seen again (the next sync): the same occurrence, no second escalation.
    await syncOnce(db, calendar([event('u1', { title: CANARY, startsIn: 3_600_000 })], [upcoming('u1', 'today', '14:30')]), run(), 'UTC');
    expect(await db.sourceEvent.count({ where: { type: 'commitment.upcoming' } })).toBe(1);
  });

  it('the report: the calendar ahead, the token date, and people from nowhere else', async () => {
    mkdirSync(join(home, '.flint', 'google'), { recursive: true });
    writeFileSync(join(home, '.flint', 'google', 'token.json'), JSON.stringify({ refreshToken: 'SECRET-REFRESH', scopes: [], obtainedAt: new Date(Date.now() - 31 * DAY).toISOString(), clientId: 'x' }), { mode: 0o600 });
    const r = await p25Report(db, { home });
    const c = (n: number) => r.criteria.find((x) => x.n === n)!;
    expect(c(1).values).toMatchObject({ enabled: true });
    expect(c(1).values.commitments).toBeGreaterThan(0);
    expect(c(2)).toMatchObject({ pass: true, values: { tokenAgeDays: 31, grantLost: false } });
    expect(c(3).pass).toBeNull();
    expect(c(4).pass).toBeNull();
    expect(c(5)).toMatchObject({ pass: true, values: { people: 2, outsideRule: 0 } });
    expect(JSON.stringify(r)).not.toMatch(/SECRET|CANARY|example\.com/);
  });

  it('the P2.5 promotion table waits for a week of calendar syncs, and is its own card', async () => {
    await expect(promotionTable(db, { phase: 'p25' })).rejects.toThrow(/days of calendar syncs/);
    // A first sync eight days ago is not a week lived: every one of the last seven days needs a good sync.
    await appendAudit(db, [{ actor: 'sync:google_calendar', context: 'autonomous', kind: 'sync', action: 'world.sync.google_calendar', tier: 'approval', decision: 'act', outcome: 'ok', inputs: { created: 1 } }], new Date(Date.now() - 8 * DAY));
    await expect(promotionTable(db, { phase: 'p25' })).rejects.toThrow(/does not count yet: \d of the last 7 days/);
    // Quiet good runs, one each day (AuditRollup's days are the zone's: UTC here), and a sync in the last hour.
    const days = Array.from({ length: 7 }, (_, i) => new Date(Date.now() - i * DAY).toISOString().slice(0, 10));
    await db.auditRollup.createMany({ data: days.map((day) => ({ day, action: 'world.sync.google_calendar', context: 'autonomous', count: 1 })), skipDuplicates: true });
    await owner(`UPDATE "AuditRollup" SET count = count + 1 WHERE action = 'world.sync.google_calendar'`);
    await owner(`UPDATE "SourceCursor" SET "lastOkAt" = now() WHERE source = 'google_calendar'`);
    const t = await promotionTable(db, { phase: 'p25' });
    expect(t.rows.map((r) => [r.pattern, r.dailyCap ?? null])).toEqual([['world.sync.google_calendar', null], ['world.person.create', 20]]);
    expect((await db.proposal.findUniqueOrThrow({ where: { id: t.proposalId } })).templateId).toBe('p25.promotion');
  });
});
