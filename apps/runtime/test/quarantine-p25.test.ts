/**
 * P2.5 exit criterion 3, the quarantine: no Google-sourced text reaches a
 * frontier (tool-holding) model, except when Will reads an entity in chat,
 * and then the read says tainted, so the turn is tainted.
 *
 * Canary strings go in everything the calendar can put in Flint: an event's
 * title, an attendee's name and address. Then every route the chat model's
 * runtime token (world:read, ledger) reaches is read, after the calendar has
 * synced, a heads-up has been escalated and a person card filed: only
 * /v1/world/entities/:id may carry a canary, and only marked tainted. The
 * local triage model is never asked about a calendar event at all.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digestOf } from '@flint/policy';
import { NO_DB, freshDb, type TestUrls } from './db';
import { enrollTestKey } from './sign';
import { createDb, type Db } from '../src/db';
import { loadConfig, type Config } from '../src/config';
import { syncOnce } from '../src/sources/sync';
import { createProposal, approveProposal } from '../src/governance/proposals';
import { runInternal } from '../src/governance/internal';
import { processEvent, type WorkerDeps } from '../src/triage/worker';
import { needsJudgement } from '../src/triage/judge';
import { loadFacts } from '../src/triage/facts';
import { buildDigest } from '../src/digest';
import { buildApp } from '../src/app';
import { emailHash, personExternalId, personKey } from '../src/world/people';
import type { Source, SourceRun } from '../src/sources/types';
import type { Bus } from '../src/bus';

const TITLE = 'CANARY-title Lunch at the safehouse';
const NAME = 'CANARY-name Ada';
const EMAIL = 'canary-mail@example.com';
const CANARY = /canary/i;
const TOKEN = 'quarantine-chat-model-token';
/** The server's token (scope events): the console's lanes, which Will reads. */
const CONSOLE = 'quarantine-console-token';

describe.skipIf(NO_DB)('P2.5 quarantine: no Google text in a frontier prompt', () => {
  let urls: TestUrls;
  let db: Db;
  let config: Config;
  let app: ReturnType<typeof buildApp>;
  const noBus = { boss: { send: async () => null } } as unknown as Bus;

  beforeAll(async () => {
    urls = await freshDb();
    db = createDb(urls.app);
    config = loadConfig({ DATABASE_URL: urls.app, HOME: mkdtempSync(join(tmpdir(), 'q25-')), FLINT_TZ: 'UTC', FLINT_RUNTIME_TRIAGE: 'on', FLINT_TRIAGE_MODEL: 'muse-glimmer:30b' });
    const key = await enrollTestKey(urls);
    const args = { source: 'google_calendar' };
    const p = await createProposal(db, { kind: 'tool_call', origin: 'console', action: 'world.source.enable', args, argsProvenance: { source: { source: 'will', tainted: false } }, tainted: false, sensitivity: 'ops', destructive: false, consequential: false, ttlMinutes: 60 }, 'test');
    await approveProposal(db, p.id, await key.approve({ subjectId: p.id, action: 'world.source.enable', argsDigest: digestOf(args) }), undefined, 'test');
    await runInternal(db, p.id, undefined, 'UTC', 'test');

    const now = new Date();
    const start = new Date(now.getTime() + 2 * 3_600_000).toISOString();
    const h = emailHash(EMAIL);
    const source: Source = {
      name: 'google_calendar', cadenceMs: 300_000,
      run: async () => ({
        observations: [
          {
            kind: 'commitment', key: 'commitment:google_calendar:q1', externalId: 'event:q1', name: `event ${start.slice(0, 16).replace('T', ' ')}`,
            state: { source: 'google_calendar', startsAt: start, endsAt: start, allDay: false, response: 'accepted', eventStatus: 'confirmed', confirmation: 'confirmed', attendeeHashes: [h] },
            sensitivity: 'personal', taintedPaths: [], type: 'commitment.state', texts: { title: TITLE },
          },
          { kind: 'person', key: personKey(h), externalId: personExternalId(h), name: NAME, state: { source: 'google_calendar', email: EMAIL, emailHash: h }, sensitivity: 'personal', taintedPaths: ['name', 'state.email'], type: 'person.seen' },
        ],
        metrics: [],
        events: [{ sourceRef: 'upcoming:q1:x', type: 'commitment.upcoming', occurredAt: now, sensitivity: 'personal', tainted: false, current: true, payload: { entityKind: 'commitment', entityKey: 'commitment:google_calendar:q1', day: 'today', time: '12:00', allDay: false } }],
      }),
    };
    const r: SourceRun = { now, signal: new AbortController().signal, fetch: async () => new Response(null, { status: 599 }) };
    expect(await syncOnce(db, source, r, 'UTC')).toMatchObject({ ran: true, failed: 0 });
    const deps: WorkerDeps = { db, config, bus: noBus, load: async () => 'proceed' };
    for (const e of await db.sourceEvent.findMany({ where: { source: 'google_calendar' } })) await processEvent({ eventId: e.id }, deps);

    app = buildApp({
      db, status: { problems: [], busStartedAt: null } as never,
      config: {
        tz: 'UTC', triage: true, home: config.home,
        tokens: [
          { name: 'runtime-mcp', sha256: createHash('sha256').update(TOKEN).digest('hex'), scopes: new Set(['world:read', 'ledger'] as const) },
          { name: 'server', sha256: createHash('sha256').update(CONSOLE).digest('hex'), scopes: new Set(['events'] as const) },
        ],
      },
    });
  });
  afterAll(async () => {
    await app?.close();
    await db?.$disconnect();
  });

  const get = async (url: string) => {
    const r = await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${TOKEN}` } });
    expect(r.statusCode, url).toBe(200);
    return r.body;
  };

  it('the seed reached every place the calendar writes (a heads-up escalated, a person card filed)', async () => {
    expect(await db.entityText.count()).toBe(1);
    expect(await db.escalation.count({ where: { templateId: 'calendar_upcoming' } })).toBe(1);
    expect(await db.proposal.count({ where: { action: 'world.person.create' } })).toBe(1);
  });

  it('every route the chat model reaches is free of Google text, but the entity read, which says tainted', async () => {
    const decisions = await db.triageDecision.findMany({ select: { id: true } });
    const clean = ['/v1/world/now', '/v1/ledger/open', '/v1/ledger/calibration', '/v1/p2/report', '/v1/p25/report', '/v1/triage/recent', '/v1/escalations/open', ...decisions.map((d) => `/v1/triage/decisions/${d.id}/explain`)];
    for (const url of clean) expect(await get(url), url).not.toMatch(CANARY);
    for (const e of await db.entity.findMany({ select: { id: true } })) {
      const body = await get(`/v1/world/entities/${e.id}`);
      if (CANARY.test(body)) expect(JSON.parse(body).tainted, `entity ${e.id}`).toBe(true);
    }
  });

  it("the console's lanes (scope events, Will's eyes only) show the title, and the chat model's token cannot reach them", async () => {
    const r = await app.inject({ method: 'GET', url: '/v1/inbox?lane=relevant', headers: { authorization: `Bearer ${CONSOLE}` } });
    expect(r.statusCode).toBe(200);
    const item = (r.json() as { items: Array<{ entity: { title?: string } | null; tainted: boolean }> }).items.find((i) => i.entity?.title);
    expect(item?.entity?.title).toBe(TITLE);
    expect((await app.inject({ method: 'GET', url: '/v1/inbox?lane=relevant', headers: { authorization: `Bearer ${TOKEN}` } })).statusCode).toBe(403);
  });

  it('the database keeps Google text out of everything that outlives a week', async () => {
    const lasting = {
      entities: await db.entity.findMany({ where: { kind: 'commitment' }, select: { key: true, name: true, state: true } }),
      versions: await db.entityVersion.findMany({ where: { entity: { kind: 'commitment' } }, select: { state: true, patch: true } }),
      sources: await db.entitySource.findMany({ select: { externalId: true } }),
      events: await db.sourceEvent.findMany({ select: { sourceRef: true, payload: true } }),
      escalations: await db.escalation.findMany({ select: { title: true, body: true, fields: true } }),
      decisions: await db.triageDecision.findMany({ select: { reasoning: true } }),
      audit: (await db.auditEntry.findMany({ select: { inputs: true, reasoning: true } })),
    };
    expect(JSON.stringify(lasting)).not.toMatch(CANARY);
  });

  it('the local triage model is never asked about a calendar event, and the digest carries counts only', async () => {
    for (const e of await db.sourceEvent.findMany({ where: { source: 'google_calendar' } })) {
      const f = await loadFacts(db, e.id, new Date());
      if (f) expect(needsJudgement(f), e.type).toBe(false);
    }
    const d = await buildDigest(db, 'UTC', new Date(Date.now() + 86_400_000));
    expect(JSON.stringify(d)).not.toMatch(CANARY);
  });
});
