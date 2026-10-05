/**
 * P2.5 on flint_test, the review's cases:
 *
 *  - Forget holds: a forgotten person is never offered again (no card, no cap
 *    slot) and the cards that named them lose their name and address; a
 *    forgotten event stays forgotten when it is renamed into a deadline, and
 *    the other way.
 *  - A person seen again and unchanged is a quiet run (rolled up, no audit row).
 *  - A heads-up is worked out when triage decides: one whose event has passed,
 *    or left the calendar, is logged, not sent; an event moved away and back
 *    is told again; a heads-up expires once its event starts or a newer one
 *    replaces it.
 *  - Items a source sets aside are warnings: said, never a failure.
 *  - A week's quiet after a rejected card counts from when it could last have
 *    been rejected; enable-source files the card that turns a source on.
 *  - A title removed at Google (the adapter's own output) is removed here.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { digestOf } from '@flint/policy';
import { NO_DB, freshDb, withClient, type TestUrls } from './db';
import { enrollTestKey } from './sign';
import { createDb, type Db } from '../src/db';
import { loadConfig, type Config } from '../src/config';
import { syncOnce } from '../src/sources/sync';
import { createProposal, approveProposal, rejectProposal } from '../src/governance/proposals';
import { proposeEnable, runInternal } from '../src/governance/internal';
import { processEvent, type WorkerDeps } from '../src/triage/worker';
import { expireEscalations } from '../src/surface/expire';
import { emailHash, personExternalId, personKey } from '../src/world/people';
import { offerPeople } from '../src/world/person-create';
import { mapEvents } from '../src/sources/google/calendar';
import { promotionTable } from '../src/governance/promotion';
import { p25Report } from '../src/report/p25';
import { appendAudit } from '../src/governance/audit';
import type { RaisedEvent, Source, SourceObservation, SourceRun, SyncResult } from '../src/sources/types';
import type { Bus } from '../src/bus';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const T0 = Math.floor(Date.now() / 60_000) * 60_000;
const iso = (t: number) => new Date(t).toISOString();
const run = (now = new Date()): SourceRun => ({ now, signal: new AbortController().signal, fetch: async () => new Response(null, { status: 599 }) });

function commitment(id: string, o: { startsIn?: number; attendees?: string[]; status?: 'archived' } = {}): SourceObservation {
  const start = T0 + (o.startsIn ?? 5 * DAY);
  return {
    kind: 'commitment', key: `commitment:google_calendar:${id}`, externalId: `event:${id}`, name: `event ${iso(start).slice(0, 16).replace('T', ' ')}`,
    state: {
      source: 'google_calendar', startsAt: iso(start), endsAt: iso(start + HOUR), allDay: false, response: 'accepted', eventStatus: 'confirmed', confirmation: 'confirmed',
      ...(o.attendees?.length ? { attendeeHashes: o.attendees.map(emailHash).sort() } : {}),
    },
    ...(o.status ? { status: o.status } : {}),
    sensitivity: 'personal', taintedPaths: [], type: 'commitment.state', texts: { title: `Title ${id}` },
  };
}
const deadline = (id: string, dueOn: string): SourceObservation => ({
  kind: 'deadline', key: `deadline:google_calendar:${id}`, externalId: `deadline:${id}`, name: `deadline ${dueOn}`, state: { dueOn, source: 'google_calendar' },
  sensitivity: 'personal', taintedPaths: [], type: 'deadline.state', texts: { title: `Due ${id}` },
});
const person = (email: string, name = 'Someone'): SourceObservation => {
  const h = emailHash(email);
  return { kind: 'person', key: personKey(h), externalId: personExternalId(h), name, state: { source: 'google_calendar', email, emailHash: h }, sensitivity: 'personal', taintedPaths: ['name', 'state.email'], type: 'person.seen' };
};
const upcoming = (id: string, startsAt: string): RaisedEvent => ({
  sourceRef: `upcoming:${id}:${startsAt}`, type: 'commitment.upcoming', occurredAt: new Date(), sensitivity: 'personal', tainted: false, current: true,
  payload: { entityKind: 'commitment', entityKey: `commitment:google_calendar:${id}`, at: startsAt },
});
const calendar = (r: Partial<SyncResult>): Source => ({ name: 'google_calendar', cadenceMs: 300_000, run: async () => ({ observations: [], metrics: [], ...r }) });

describe.skipIf(NO_DB)('P2.5 review cases on flint_test', () => {
  let urls: TestUrls;
  let db: Db;
  let config: Config;
  let key: Awaited<ReturnType<typeof enrollTestKey>>;
  const noBus = { boss: { send: async () => null } } as unknown as Bus;
  const deps = (): WorkerDeps => ({ db, config, bus: noBus, load: async () => 'proceed' });
  async function sign(pid: string, action: string, args: Record<string, unknown>) {
    await approveProposal(db, pid, await key.approve({ subjectId: pid, action, argsDigest: digestOf(args) }), undefined, 'test');
    return runInternal(db, pid, undefined, 'UTC', 'test');
  }
  let approvals = 0;
  async function forget(entityId: string) {
    const n = ++approvals;
    const expires = new Date(Date.now() + 600_000).toISOString();
    await withClient(urls.approver, async (c) => {
      if (n === 1) await c.query(`INSERT INTO "ApprovalCredential" (id, "credentialId", factor, "publicKey", label, "enrolledVia") VALUES ('cr1', 'credr1', 'webauthn', '\\x00', 'k', 'enroll_code')`);
      await c.query(`INSERT INTO "Approval" (id, "subjectType", "subjectId", decision, payload, challenge, "credentialId", signature, "expiresAt") VALUES ($1, 'forget', $2, 'approve', $3, $4, 'credr1', '\\x01', $5)`, [
        `apr${n}`, entityId, JSON.stringify({ v: 1, subjectType: 'forget', subjectId: entityId, decision: 'approve', action: 'world.forget', argsDigest: 'a'.repeat(64), expiresAt: expires, nonce: `n${n}` }), 'c'.repeat(64), expires,
      ]);
    });
    await withClient(urls.app, (c) => c.query(`SELECT forget_entity($1, $2)`, [entityId, `apr${n}`]));
  }
  const entity = (kind: string, k: string) => db.entity.findUnique({ where: { kind_key: { kind, key: k } } });

  beforeAll(async () => {
    urls = await freshDb();
    db = createDb(urls.app);
    config = loadConfig({ DATABASE_URL: urls.app, HOME: '/nonexistent', FLINT_TZ: 'UTC', FLINT_RUNTIME_TRIAGE: 'on' });
    key = await enrollTestKey(urls);
    // enable-source files the card; signed, it turns the source on; filed again while it waits, the same card.
    const p = await proposeEnable(db, 'google_calendar');
    expect((await proposeEnable(db, 'google_calendar')).id).toBe(p.id);
    await expect(proposeEnable(db, 'not_a_source')).rejects.toThrow();
    expect(await sign(p.id, 'world.source.enable', { source: 'google_calendar' })).toEqual({ source: 'google_calendar', enabled: true });
    expect((await db.proposal.findUniqueOrThrow({ where: { id: p.id } })).origin).toBe('cli');
  });
  afterAll(async () => db?.$disconnect());

  it('a forgotten person is never offered again, and the cards that named them lose name and address', async () => {
    const ada = 'ada@example.com';
    await syncOnce(db, calendar({ observations: [commitment('f1', { attendees: [ada] }), person(ada, 'Ada')] }), run(), 'UTC');
    const card = await db.proposal.findFirstOrThrow({ where: { action: 'world.person.create', status: 'pending' } });
    await sign(card.id, 'world.person.create', card.args as Record<string, unknown>);
    const p = (await entity('person', personKey(emailHash(ada))))!;
    await forget(p.id);
    const after = await db.proposal.findUniqueOrThrow({ where: { id: card.id } });
    expect(after).toMatchObject({ args: null, reason: null, result: null });
    expect(after.argsPurgedAt).not.toBeNull();
    // A day later, still on an accepted event: no new card for her.
    expect(await offerPeople(db, [person(ada, 'Ada')], new Date(Date.now() + 1.5 * DAY), 'UTC')).toMatchObject({ refused: 1, proposed: 0 });
    expect(await db.proposal.count({ where: { action: 'world.person.create', status: 'pending' } })).toBe(0);
    // Promoted: no slot of the cap is taken for her, and nothing is created.
    const rows = { rows: [{ pattern: 'world.person.create', tier: 'alone', dailyCap: 20, reason: 'test', expiresAt: new Date(Date.now() + DAY).toISOString() }] };
    const pol = await createProposal(db, { kind: 'policy', origin: 'console', action: 'policy.change', args: rows, argsProvenance: { rows: { source: 'will', tainted: false } }, tainted: false, sensitivity: 'ops', destructive: false, consequential: true, ttlMinutes: 60 }, 'test');
    await sign(pol.id, 'policy.change', rows);
    const slots = async () => (await db.actionCounter.findMany({ where: { action: 'world.person.create' } })).reduce((n, c) => n + c.count, 0);
    const taken = await slots();
    expect(await offerPeople(db, [person(ada, 'Ada')], new Date(), 'UTC')).toMatchObject({ created: 0, refused: 1 });
    expect(await slots()).toBe(taken);
    await withClient(urls.owner, (c) => c.query(`UPDATE "ActionPolicy" SET active = false WHERE pattern = 'world.person.create'`));
  });

  it('a person seen again and unchanged is a quiet run: rolled up, no audit row', async () => {
    const bo = 'bo@example.com';
    await syncOnce(db, calendar({ observations: [commitment('q1', { attendees: [bo] }), person(bo, 'Bo')] }), run(), 'UTC');
    const args = { people: [{ name: 'Bo', email: bo, emailHash: emailHash(bo) }] };
    const card = await createProposal(db, { kind: 'tool_call', origin: 'runtime:google_calendar', action: 'world.person.create', templateId: 'person.from_calendar', args, argsProvenance: { people: { source: 'event', tainted: true } }, tainted: true, sensitivity: 'personal', destructive: false, consequential: false, ttlMinutes: 60 }, 'test');
    expect(await sign(card.id, 'world.person.create', args)).toEqual({ created: 1, skipped: 0 });
    const cal = calendar({ observations: [commitment('q1', { attendees: [bo] }), person(bo, 'Bo')] });
    await syncOnce(db, cal, run(), 'UTC');
    const audits = await db.auditEntry.count({ where: { action: 'world.sync.google_calendar', kind: 'sync' } });
    const s = await syncOnce(db, cal, run(), 'UTC');
    expect(s).toMatchObject({ updated: 0, created: 0 });
    expect(s.unchanged).toBeGreaterThanOrEqual(2);
    expect(await db.auditEntry.count({ where: { action: 'world.sync.google_calendar', kind: 'sync' } })).toBe(audits);
    // A new name is a change.
    expect((await syncOnce(db, calendar({ observations: [commitment('q1', { attendees: [bo] }), person(bo, 'Bo Renamed')] }), run(), 'UTC')).updated).toBe(1);
  });

  it('a forgotten event stays forgotten when renamed into a deadline, and a forgotten deadline when it becomes a meeting', async () => {
    await syncOnce(db, calendar({ observations: [commitment('k1')] }), run(), 'UTC');
    await forget((await entity('commitment', 'commitment:google_calendar:k1'))!.id);
    const s = await syncOnce(db, calendar({ observations: [deadline('k1', iso(T0 + 2 * DAY).slice(0, 10))] }), run(), 'UTC');
    expect(s.skipped).toBe(1);
    expect(await entity('deadline', 'deadline:google_calendar:k1')).toBeNull();
    expect(await db.entityText.count({ where: { text: 'Due k1' } })).toBe(0);
    await syncOnce(db, calendar({ observations: [deadline('k2', iso(T0 + 2 * DAY).slice(0, 10))] }), run(), 'UTC');
    await forget((await entity('deadline', 'deadline:google_calendar:k2'))!.id);
    await syncOnce(db, calendar({ observations: [commitment('k2')] }), run(), 'UTC');
    expect(await entity('commitment', 'commitment:google_calendar:k2')).toBeNull();
  });

  it('a heads-up is worked out when triage decides: logged when its event has passed or left the calendar', async () => {
    // Decided late (the bus was down): by the time triage runs, the event started an hour ago.
    const past = T0 - HOUR;
    await syncOnce(db, calendar({ observations: [commitment('h1', { startsIn: -HOUR })], events: [upcoming('h1', iso(past))] }), run(), 'UTC');
    const ev = await db.sourceEvent.findFirstOrThrow({ where: { sourceRef: `upcoming:h1:${iso(past)}` } });
    await processEvent({ eventId: ev.id }, deps());
    expect(await db.triageDecision.findUniqueOrThrow({ where: { sourceEventId: ev.id }, include: { escalation: true } })).toMatchObject({ action: 'log', ruleName: 'calendar.upcoming.stale', escalation: null });
    // Left the calendar (archived) before triage decided.
    await syncOnce(db, calendar({ observations: [commitment('h2', { startsIn: 2 * HOUR })], events: [upcoming('h2', iso(T0 + 2 * HOUR))] }), run(), 'UTC');
    const ev2 = await db.sourceEvent.findFirstOrThrow({ where: { sourceRef: `upcoming:h2:${iso(T0 + 2 * HOUR)}` } });
    await syncOnce(db, calendar({ observations: [commitment('h2', { startsIn: 2 * HOUR, status: 'archived' })] }), run(), 'UTC');
    await processEvent({ eventId: ev2.id }, deps());
    expect(await db.triageDecision.findUniqueOrThrow({ where: { sourceEventId: ev2.id } })).toMatchObject({ action: 'log', ruleName: 'calendar.upcoming.stale' });
  });

  it('an event moved away and back is told again; a heads-up expires once its event starts or a newer one replaces it', async () => {
    const at14 = T0 + 6 * HOUR;
    const at10 = T0 + 2 * HOUR;
    const sync = async (start: number) => {
      await syncOnce(db, calendar({ observations: [commitment('mv', { startsIn: start - T0 })], events: [upcoming('mv', iso(start))] }), run(), 'UTC');
      for (const e of await db.sourceEvent.findMany({ where: { type: 'commitment.upcoming', sourceRef: { startsWith: 'upcoming:mv:' }, decision: null } })) await processEvent({ eventId: e.id }, deps());
    };
    await sync(at14);
    await sync(at14); // read again: the same occurrence
    await sync(at10);
    await sync(at14); // moved back: told again
    await sync(at14);
    const refs = (await db.sourceEvent.findMany({ where: { sourceRef: { startsWith: 'upcoming:mv:' } }, orderBy: { receivedAt: 'asc' }, select: { sourceRef: true } })).map((e) => e.sourceRef);
    expect(refs).toEqual([`upcoming:mv:${iso(at14)}`, `upcoming:mv:${iso(at10)}`, `upcoming:mv:${iso(at14)}:r1`]);
    const ups = await db.escalation.findMany({ where: { templateId: 'calendar_upcoming' }, orderBy: { createdAt: 'asc' } });
    const mine = ups.filter((u) => [iso(at14), iso(at10)].includes((u.fields as { until: string }).until));
    expect(mine).toHaveLength(3);
    // The hourly expiry: the two the last one replaced go; the last stays until its event starts.
    await expireEscalations(db);
    const status = async () => (await db.escalation.findMany({ where: { id: { in: mine.map((m) => m.id) } }, orderBy: { createdAt: 'asc' }, select: { status: true } })).map((x) => x.status);
    expect(await status()).toEqual(['expired', 'expired', 'open']);
    await expireEscalations(db, new Date(at14 + 60_000));
    expect(await status()).toEqual(['expired', 'expired', 'expired']);
  });

  it('items set aside are warnings: said as the last error, never a failure that opens the circuit', async () => {
    for (let i = 0; i < 6; i++) await syncOnce(db, calendar({ observations: [commitment('w1')], warnings: ['google calendar: item 3 is not an event this source can read (id); set aside'] }), run(), 'UTC');
    const c = await db.sourceCursor.findUniqueOrThrow({ where: { source: 'google_calendar' } });
    expect(c.consecutiveFailures).toBe(0);
    expect(c.lastError).toMatch(/set aside/);
    // A real part failure still counts.
    await syncOnce(db, calendar({ observations: [], errors: ['google calendar: something failed'] }), run(), 'UTC');
    expect((await db.sourceCursor.findUniqueOrThrow({ where: { source: 'google_calendar' } })).consecutiveFailures).toBe(1);
    await syncOnce(db, calendar({ observations: [] }), run(), 'UTC');
  });

  it("a week's quiet after a rejection counts from when the card could last have been rejected", async () => {
    const cy = 'cy@example.com';
    await syncOnce(db, calendar({ observations: [commitment('r1', { attendees: [cy], startsIn: 30 * DAY })] }), run(), 'UTC');
    const t = Date.now() + 2 * DAY;
    await offerPeople(db, [person(cy, 'Cy')], new Date(t), 'UTC');
    const card = await db.proposal.findFirstOrThrow({ where: { action: 'world.person.create', status: 'pending', expiresAt: { gt: new Date(t) } }, orderBy: { createdAt: 'desc' } });
    // Rejected just before it expired (a day after it was filed): 6.5 days on is still within the week.
    await rejectProposal(db, card.id, {}, undefined, 'test');
    expect(await offerPeople(db, [person(cy, 'Cy')], new Date(t + 7.5 * DAY), 'UTC')).toMatchObject({ proposed: 0 });
    expect(await offerPeople(db, [person(cy, 'Cy')], new Date(t + 8.1 * DAY), 'UTC')).toMatchObject({ proposed: 1 });
  });

  it("a title removed at Google (the adapter's own output: an empty title) is removed here", async () => {
    const now = new Date();
    const item = (summary?: string) => ({ id: 'tt1', status: 'confirmed', ...(summary ? { summary } : {}), start: { dateTime: iso(T0 + 3 * DAY) }, end: { dateTime: iso(T0 + 3 * DAY + HOUR) } });
    const viaAdapter = (summary?: string): Source => ({ name: 'google_calendar', cadenceMs: 300_000, run: async () => ({ observations: mapEvents([item(summary)], { tz: 'UTC', now }).observations, metrics: [] }) });
    await syncOnce(db, viaAdapter('Interview at Acme'), run(now), 'UTC');
    const e = (await entity('commitment', 'commitment:google_calendar:tt1'))!;
    expect((await db.entityText.findFirstOrThrow({ where: { entityId: e.id } })).text).toBe('Interview at Acme');
    await syncOnce(db, viaAdapter(undefined), run(now), 'UTC');
    expect(await db.entityText.count({ where: { entityId: e.id } })).toBe(0);
  });

  it('heads-ups still waiting when the event moves, and moves back, give one note, for the time that holds', async () => {
    const at14 = T0 + 6 * HOUR;
    const at10 = T0 + 2 * HOUR;
    const raise = (start: number) => syncOnce(db, calendar({ observations: [commitment('pm', { startsIn: start - T0 })], events: [upcoming('pm', iso(start))] }), run(), 'UTC');
    // Triage is behind: three raises (14:00, 10:00, back to 14:00) before any is decided.
    await raise(at14);
    await raise(at10);
    await raise(at14);
    const evs = await db.sourceEvent.findMany({ where: { sourceRef: { startsWith: 'upcoming:pm:' } }, orderBy: { receivedAt: 'asc' } });
    expect(evs.map((e) => e.sourceRef)).toEqual([`upcoming:pm:${iso(at14)}`, `upcoming:pm:${iso(at10)}`, `upcoming:pm:${iso(at14)}:r1`]);
    for (const e of evs) await processEvent({ eventId: e.id }, deps());
    const ds = await db.triageDecision.findMany({ where: { sourceEventId: { in: evs.map((e) => e.id) } }, include: { escalation: true } });
    expect(ds.filter((d) => d.action === 'escalate')).toHaveLength(1);
    expect(ds.find((d) => d.action === 'escalate')!.sourceEventId).toBe(evs[2]!.id);
    expect(ds.filter((d) => d.ruleName === 'calendar.upcoming.moved')).toHaveLength(2);
    // Read again: the told occurrence stays the one; nothing more is raised.
    await raise(at14);
    expect(await db.sourceEvent.count({ where: { sourceRef: { startsWith: 'upcoming:pm:' } } })).toBe(3);
  });

  it('a heads-up passed over (decided late) is raised again for the same time, a bounded number of times', async () => {
    const at = T0 + 3 * HOUR;
    const shown = () => syncOnce(db, calendar({ observations: [commitment('lt', { startsIn: 3 * HOUR })], events: [upcoming('lt', iso(at))] }), run(), 'UTC');
    await shown();
    const first = await db.sourceEvent.findFirstOrThrow({ where: { sourceRef: `upcoming:lt:${iso(at)}` } });
    // Off the calendar when triage got to it (so: logged), then back at the same time: told after all.
    await syncOnce(db, calendar({ observations: [commitment('lt', { startsIn: 3 * HOUR, status: 'archived' })] }), run(), 'UTC');
    await processEvent({ eventId: first.id }, deps());
    expect((await db.triageDecision.findUniqueOrThrow({ where: { sourceEventId: first.id } })).action).toBe('log');
    await shown();
    const again = await db.sourceEvent.findFirstOrThrow({ where: { sourceRef: `upcoming:lt:${iso(at)}:r1` } });
    await processEvent({ eventId: again.id }, deps());
    expect((await db.triageDecision.findUniqueOrThrow({ where: { sourceEventId: again.id } })).action).toBe('escalate');
  });

  it('forgetting one kind of a renamed event forgets the other kind already made, and its title', async () => {
    const due = iso(T0 + 3 * DAY).slice(0, 10);
    await syncOnce(db, calendar({ observations: [commitment('sb')] }), run(), 'UTC');
    // Renamed into a deadline while another item was set aside: both kinds exist (the old kind is archived as renamed).
    await syncOnce(db, calendar({ observations: [deadline('sb', due)], warnings: ['google calendar: item 9 set aside'] }), run(), 'UTC');
    const c = (await entity('commitment', 'commitment:google_calendar:sb'))!;
    const d = (await entity('deadline', 'deadline:google_calendar:sb'))!;
    await forget(d.id);
    const after = await db.entity.findUniqueOrThrow({ where: { id: c.id }, include: { versions: true, sources: true } });
    expect(after.status).toBe('forgotten');
    expect(after.key).toMatch(/^forgotten:/);
    expect(after.versions.filter((v) => v.state !== null || v.patch !== null)).toEqual([]);
    expect(after.versions.some((v) => v.changeKind === 'forgotten')).toBe(true);
    expect(after.sources.every((x) => x.externalId.startsWith('forgotten:'))).toBe(true);
    expect(await db.entityText.count({ where: { entityId: { in: [c.id, d.id] } } })).toBe(0);
    // Neither kind comes back.
    await syncOnce(db, calendar({ observations: [commitment('sb'), deadline('sb', due)] }), run(), 'UTC');
    expect(await entity('commitment', 'commitment:google_calendar:sb')).toBeNull();
    expect(await entity('deadline', 'deadline:google_calendar:sb')).toBeNull();
  });

  it('a warning is audited when it starts and when it ends, not on every run', async () => {
    const count = () => db.auditEntry.count({ where: { action: 'world.sync.google_calendar', kind: 'sync' } });
    await syncOnce(db, calendar({ observations: [commitment('wa')] }), run(), 'UTC');
    await syncOnce(db, calendar({ observations: [commitment('wa')] }), run(), 'UTC');
    const before = await count();
    const w = calendar({ observations: [commitment('wa')], warnings: ['google calendar: item 2 set aside'] });
    await syncOnce(db, w, run(), 'UTC');
    await syncOnce(db, w, run(), 'UTC');
    await syncOnce(db, w, run(), 'UTC');
    expect(await count()).toBe(before + 1);
    await syncOnce(db, calendar({ observations: [commitment('wa')] }), run(), 'UTC');
    expect(await count()).toBe(before + 2);
  });

  it('the promotion gate counts calendar days, not 24-hour steps, in a DST week', async () => {
    // Thu 2026-11-04 00:30 CDT... CST (05:30Z the 4th is 23:30 CST on the 3rd): the 7 days before are Oct 27 to Nov 2.
    const now = new Date('2026-11-04T05:30:00Z');
    await appendAudit(db, [{ actor: 'sync:google_calendar', context: 'autonomous', kind: 'sync', action: 'world.sync.google_calendar', tier: 'approval', decision: 'act', outcome: 'ok', inputs: { created: 1 } }], new Date(Date.now() - 9 * DAY));
    const days = ['2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02'];
    await db.auditRollup.createMany({ data: days.map((day) => ({ day, action: 'world.sync.google_calendar', context: 'autonomous', count: 1 })), skipDuplicates: true });
    await expect(promotionTable(db, { phase: 'p25', now, tz: 'America/Chicago' })).rejects.toThrow(/6 of the 7 days before today .*none on 2026-10-27/);
    await db.auditRollup.createMany({ data: [{ day: '2026-10-27', action: 'world.sync.google_calendar', context: 'autonomous', count: 1 }], skipDuplicates: true });
    await expect(promotionTable(db, { phase: 'p25', now, tz: 'America/Chicago' })).rejects.toThrow(/not synced in the last hour/);
  });

  it("the report counts a deadline due on Will's day, whatever the UTC date", async () => {
    // 19:00 CST on Nov 30 is 01:00Z on Dec 1: a deadline due Nov 30 is due today, locally.
    await syncOnce(db, calendar({ observations: [deadline('rp', '2026-11-30')] }), run(), 'UTC');
    const r = await p25Report(db, { home: '/nonexistent', tz: 'America/Chicago' }, new Date('2026-12-01T01:00:00Z'));
    expect(r.criteria.find((c) => c.n === 1)!.values.deadlines).toBeGreaterThanOrEqual(1);
    const utc = await p25Report(db, { home: '/nonexistent', tz: 'UTC' }, new Date('2026-12-01T01:00:00Z'));
    expect((r.criteria.find((c) => c.n === 1)!.values.deadlines as number) - (utc.criteria.find((c) => c.n === 1)!.values.deadlines as number)).toBe(1);
  });
});
