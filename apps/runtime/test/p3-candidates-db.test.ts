/**
 * Goals and commitments from chat on flint_test (P3 part 5), through buildApp
 * and Fastify's inject, the way the server's extractor calls the runtime, with
 * cards signed by a test key and run by runInternal, as the server's approval
 * routes do.
 *
 *  - The route takes the server's token only (scope proposals); the runtime
 *    connector's scopes, the ones a model's tools hold, are refused.
 *  - The runtime checks the request again, whatever the server checked: ids,
 *    the quote's length and form, the day, the turn's time. The database
 *    refuses a raw insert with a short or missing quote (as flint_app).
 *  - Nothing but the intake files these two actions: the general proposals
 *    route and a direct createProposal are refused, however the card is made.
 *  - At APPROVAL (how it ships): a goal.propose card (kind goal) or a
 *    world.commitment.from_chat card (kind tool_call), from a chat origin,
 *    personal, Will's quote as its provenance, asking on its own. The same
 *    conversation, turn and quote is never filed twice, even once the card is
 *    dismissed and cleared; once one is turned down, nothing more of that kind
 *    is taken from that turn. Identical or racing posts make one card and use
 *    one of the day's slots.
 *  - Nothing from chat runs without a card yet: even under a signed rule the
 *    intake files a card, until the database holds what it adds to one.
 *  - An approved goal.propose adds only a proposed goal; an approved
 *    from_chat adds an unconfirmed commitment with no source row, Will's quote
 *    in EntityText, and nothing a world:read route serves or PersonGuard reads.
 *  - 3 goals and 10 commitments a day, while cards wait and (with the floor
 *    switched on for the test) after a promotion, whatever cap its row carries.
 *  - A row the panel's contract does not take is left out of the tab and
 *    counted: the Suggested and Finished tabs never answer 500 for one.
 *  - The report counts a suggestion Will made a goal himself as a yes.
 *  - Make It a Goal takes one signature through the real signed path and sets
 *    the waiting card aside; a card that already ran is started as the goal it
 *    made, never as a second goal with the same source. Dismiss sets it aside.
 *  - A suggestion about an active goal asks for that goal's review.
 *  - No word of a suggestion in a log line, an audit entry, a refusal, a
 *    card's reason, error or result.
 * Synthetic text only.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { GoalTitle, digestOf, localWallTime, suggestionGoalId, suggestionSourceRef, suggestionTurnRef, type GoalsPage } from '@flint/policy';
import { NO_DB, freshDb, withClient, withoutChatGoalFloor, id, type TestUrls } from './db';
import { enrollTestKey } from './sign';
import { buildApp } from '../src/app';
import { createDb, type Db } from '../src/db';
import type { RuntimeScope } from '../src/config';
import { approveProposal, createProposal, rejectProposal } from '../src/governance/proposals';
import { runInternal } from '../src/governance/internal';
import { CANDIDATES_ACTOR, RELATED_WORDS, askReviews, chatFloorInDatabase, filedCounter, suggestionCardProblem, takeCandidate } from '../src/goals/candidates';
import { chatSuggestions } from '../src/goals/measures';
import { REVIEW_QUEUE, runReview } from '../src/goals/review';
import { personAllowed } from '../src/world/person-create';
import { CHAT_COMMITMENT } from '../src/world/kinds';
import { p3Report } from '../src/report/p3';
import { FakeBus } from './goals/fixture';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const SERVER = 'server-token-0123456789abcdef';
const CONNECTOR = 'connector-token-0123456789abcdef';
const CANARY = 'Synthetic CANARY-p3chat';
const DAY = 86_400_000;

describe.skipIf(NO_DB)('goals and commitments from chat on flint_test', () => {
  let urls: TestUrls;
  let db: Db;
  let key: Awaited<ReturnType<typeof enrollTestKey>>;
  let app: ReturnType<typeof buildApp>;
  const bus = new FakeBus();
  const lines: string[] = [];
  const owner = (sql: string, params: unknown[] = []) => withClient(urls.owner, (c) => c.query(sql, params));
  const call = async (method: 'GET' | 'POST', url: string, body?: unknown, token = SERVER) => {
    const r = await app.inject({ method, url, ...(body !== undefined ? { payload: body as object } : {}), headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { status: r.statusCode, body: r.body ? (JSON.parse(r.body) as Record<string, unknown>) : {}, raw: r.body };
  };
  let n = 0;
  /** A candidate as the server hands one over. Each has its own turn unless told otherwise. */
  const candidate = (over: Record<string, unknown> = {}) => {
    n += 1;
    return {
      kind: 'goal', text: `${CANARY} run a half marathon ${n}`, quote: `${CANARY} I want to run a half marathon by spring ${n}`,
      conversationId: 'console-1', turnId: `turn_${n}`, sourceAt: new Date(Date.now() - 60_000).toISOString(), ...over,
    };
  };
  const post = (c: Record<string, unknown>) => call('POST', '/v1/goals/candidates', c);
  const refOf = (c: { conversationId?: unknown; turnId?: unknown; quote?: unknown }) => suggestionSourceRef(String(c.conversationId), String(c.turnId), String(c.quote));
  const cardOf = async (c: Record<string, unknown>) => {
    const [row] = await db.$queryRaw<Array<{ id: string }>>`SELECT id FROM "Proposal" WHERE args->>'sourceRef' = ${refOf(c)}`;
    return row ? db.proposal.findUniqueOrThrow({ where: { id: row.id } }) : null;
  };
  async function sign(pid: string) {
    const p = await db.proposal.findUniqueOrThrow({ where: { id: pid } });
    await approveProposal(db, pid, await key.approve({ subjectId: pid, action: p.action, argsDigest: p.argsDigest }), undefined, 'test');
  }
  const run = (pid: string) => runInternal(db, pid, undefined, 'UTC', 'test');
  const page = async () => (await call('GET', '/v1/goals?tab=suggested')).body as unknown as GoalsPage;
  /** Another local day, far from every other test's: its counters are its own. */
  let day = 0;
  const anotherDay = () => new Date(Date.now() - (++day) * DAY);
  /** The intake at a time of the test's choosing (the route's own clock is now). */
  const take = (c: Record<string, unknown>, now: Date, over: Record<string, unknown> = {}) => takeCandidate({ db, tz: 'UTC', now: () => now, ...over }, c);
  const at = (now: Date) => ({ sourceAt: new Date(now.getTime() - 60_000).toISOString() });

  beforeAll(async () => {
    urls = await freshDb();
    db = createDb(urls.app);
    key = await enrollTestKey(urls);
    app = buildApp({
      db, logger: true, logStream: { write: (l: string) => void lines.push(l) }, status: { problems: new Set(), busStartedAt: new Date(), bus },
      config: {
        tz: 'UTC', planner: true,
        tokens: [
          { name: 'server', sha256: sha(SERVER), scopes: new Set<RuntimeScope>(['events', 'audit', 'proposals', 'world:read', 'ledger', 'counters']) },
          // What the runtime connector holds: the token a model's tools call the runtime with.
          { name: 'connector', sha256: sha(CONNECTOR), scopes: new Set<RuntimeScope>(['world:read', 'ledger']) },
        ],
      },
    });
  });
  afterAll(async () => {
    await app?.close();
    await db?.$disconnect();
  });
  afterEach(async () => {
    // Nothing logged, and nothing in the audit trail, carries a suggestion's words.
    expect(lines.join('\n')).not.toContain('CANARY');
    const audit = await db.auditEntry.findMany({ select: { inputs: true, reasoning: true, outcomeDetail: true, correlationId: true } });
    expect(JSON.stringify(audit)).not.toContain('CANARY');
    bus.clear();
  });

  it('takes the server’s token only: the runtime connector’s scopes, the ones a model’s tools hold, never reach it', async () => {
    const c = candidate();
    expect((await call('POST', '/v1/goals/candidates', c, '')).status).toBe(401);
    const r = await call('POST', '/v1/goals/candidates', c, CONNECTOR);
    expect(r).toMatchObject({ status: 403, body: { error: 'this token does not have the proposals scope' } });
    // Nor the Suggested tab, nor the cards, nor the route that makes one a goal.
    expect((await call('GET', '/v1/goals?tab=suggested', undefined, CONNECTOR)).status).toBe(403);
    expect((await call('GET', '/v1/proposals', undefined, CONNECTOR)).status).toBe(403);
    expect((await call('POST', `/v1/goals/${suggestionGoalId(refOf(c))}/start`, { args: {} }, CONNECTOR)).status).toBe(403);
    expect(await db.proposal.count()).toBe(0);
  });

  it('checks the request again, whatever the server checked: a quote of the wrong length or form, a bad id, day or time is refused, and nothing is filed', async () => {
    const future = new Date(Date.now() + 3 * DAY).toISOString().slice(0, 10);
    const refused: Array<[string, Record<string, unknown>, string?]> = [
      ['a quote of 11 characters', { quote: 'I will do x' }],
      ['a quote of 301 characters', { quote: `${'I will finish it '.repeat(18)}`.slice(0, 301).trim().padEnd(301, 'x') }],
      ['a quote with no words in it', { quote: '1234 5678 9012 3456' }],
      ['two spaces the check would have made one', { quote: 'I will finish  the synthetic report' }],
      ['a control character in the quote', { quote: 'I will finish the synthetic\u0007 report' }],
      // The short text could be a goal's title: its length as a title's is counted, and nothing hidden in it.
      ['a text of 84 characters that is 154 units long', { text: `half marathon ${'\u{1F3C3}'.repeat(70)}` }],
      ['a direction override in the text', { text: 'run a half marathon \u202Egnirps yb\u202C' }],
      ['zero-width marks in the text', { text: 'run a half\u200B\u2060 marathon\u200D' }],
      ['a line break', { quote: 'I will finish\nthe synthetic report' }],
      ['a leading space', { quote: ' I will finish the synthetic report' }],
      ['text that is not NFC', { quote: 'I will finish the café report' }],
      ['a text of two characters', { text: 'ab' }],
      ['a text of 121 characters', { text: 'a'.repeat(121) }],
      ['a conversation id that is not one', { conversationId: 'console 1' }],
      ['a conversation id with a colon', { conversationId: 'chat:c1' }],
      ['no turn', { turnId: undefined }],
      ['a turn id that is not one', { turnId: 't/1' }],
      ['a kind it does not take', { kind: 'task' }],
      ['a field it does not take', { verified: true }],
      ['a day that is not real', { dueOn: '2027-02-30' }],
      ['a day that has passed', { dueOn: '2020-01-01' }],
      ['a day decades away', { dueOn: '2099-01-01' }],
      ['a turn from the future', { sourceAt: new Date(Date.now() + DAY).toISOString() }],
      ['a time that is not to the millisecond', { sourceAt: '2026-10-12T10:00:00Z' }],
      ['a turn from too long ago', { sourceAt: new Date(Date.now() - 31 * DAY).toISOString() }, 'suggestionStale'],
    ];
    for (const [what, over, code] of refused) {
      const body = candidate(over);
      if (over.turnId === undefined && 'turnId' in over) delete (body as Record<string, unknown>).turnId;
      const r = await post(body);
      expect(r.status, what).toBe(400);
      expect(r.body.code, what).toBe(code ?? 'suggestionInvalid');
      // The refusal is a fixed sentence: never the words it refused.
      expect(r.raw, what).not.toContain('CANARY');
    }
    expect(await db.proposal.count()).toBe(0);
    expect(await db.goal.count()).toBe(0);
    // A good one, with a day ahead, is taken: his own characters (a curly apostrophe is his) and all.
    expect(await post(candidate({ dueOn: future, quote: `${CANARY} I’ll run a half marathon by spring ${n + 1}` }))).toMatchObject({ status: 201, body: { outcome: 'filed' } });
  });

  it('the database refuses a raw insert with a short or missing quote, as flint_app, under the intake’s own origin and template', async () => {
    const insert = (action: string, args: Record<string, unknown>, prov: Record<string, unknown>) => withClient(urls.app, (c) => c.query(
      `INSERT INTO "Proposal" (id, kind, origin, action, "templateId", args, "argsDigest", "argsProvenance", tainted, sensitivity, "expiresAt")
       VALUES ($1, $2, 'chat:console-1', $3, $4, $5::jsonb, $6, $7::jsonb, false, 'personal', now() + interval '1 day')`,
      [id('prraw'), action === 'goal.propose' ? 'goal' : 'tool_call', action, action === 'goal.propose' ? 'chat.goal' : 'chat.commitment', JSON.stringify(args), digestOf(args), JSON.stringify(prov)],
    )).then(() => 'ok', (e: { code?: string }) => e.code);
    const will = { quote: { source: 'will', ref: 'turn:t1', tainted: false } };
    for (const action of ['goal.propose', 'world.commitment.from_chat']) {
      expect(await insert(action, { text: 'Synthetic' }, will), action).toBe('23514');
      expect(await insert(action, { text: 'Synthetic', quote: 'I will do x' }, will), action).toBe('23514');
      expect(await insert(action, { text: 'Synthetic', quote: 'x'.repeat(301) }, will), action).toBe('23514');
      expect(await insert(action, { text: 'Synthetic', quote: 'I will finish the synthetic thing' }, { quote: { source: 'model', ref: 'turn:t1', tainted: false } }), action).toBe('23514');
      expect(await insert(action, { text: 'Synthetic', quote: 'I will finish the synthetic thing' }, {}), action).toBe('23514');
    }
  });

  it('nothing but the intake files one: the proposals route and createProposal refuse both actions, however the card is made up', async () => {
    const before = await db.proposal.count();
    for (const kind of ['goal', 'commitment'] as const) {
      const c = candidate({ kind });
      const sourceRef = refOf(c);
      const action = kind === 'goal' ? 'goal.propose' : 'world.commitment.from_chat';
      // Exactly the card the intake would file: its origin, template, args and provenance.
      const args = { ...(kind === 'goal' ? { goalId: suggestionGoalId(sourceRef), title: c.text } : { text: c.text }), quote: c.quote, saidAt: c.sourceAt, sourceRef };
      const card = {
        kind: kind === 'goal' ? 'goal' : 'tool_call', origin: 'chat:console-1', action, templateId: kind === 'goal' ? 'chat.goal' : 'chat.commitment', args,
        argsProvenance: { quote: { source: 'will', ref: `turn:${c.turnId}`, tainted: false } }, tainted: false, sensitivity: 'personal',
      };
      const r = await call('POST', '/v1/proposals', card);
      expect(r, action).toMatchObject({ status: 409, body: { error: 'Only Flint’s own check of your chats files a suggestion.' } });
      expect(r.raw).not.toContain('CANARY');
      await expect(createProposal(db, { ...card, destructive: false, consequential: false, ttlMinutes: 60 } as Parameters<typeof createProposal>[1], 'client:server')).rejects.toMatchObject({ status: 409 });
      // A tool call's proposal (what the server files for a model): the same.
      const tool = await call('POST', '/v1/proposals', { kind: 'tool_call', origin: 'chat:turn_9', action, args: { title: 'Synthetic', quote: 'Synthetic words a model wrote' }, argsProvenance: { title: { source: 'model', tainted: false } } });
      expect(tool.status, action).toBe(409);
      const denied = await db.auditEntry.findMany({ where: { action, decision: 'deny', kind: 'decision' }, select: { inputs: true, reasoning: true } });
      expect(denied.length).toBeGreaterThanOrEqual(3);
      expect(denied[0]).toMatchObject({ reasoning: 'only the candidates intake files a suggestion from chat', inputs: { rule: 'candidates-intake' } });
    }
    expect(await db.proposal.count()).toBe(before);
  });

  it('at approval: a goal card and a commitment card, from a chat origin, personal, with Will’s quote as provenance, kept 7 days', async () => {
    const when = anotherDay();
    const g = candidate({ dueOn: '2030-03-01', ...at(when) });
    const c = candidate({ kind: 'commitment', text: `${CANARY} send Dana the draft`, quote: `${CANARY} I'll send Dana the draft by Friday`, ...at(when) });
    expect(await take(g, when)).toEqual({ outcome: 'filed' });
    expect(await take(c, when)).toEqual({ outcome: 'filed' });
    const goalCard = (await cardOf(g))!;
    const sourceRef = refOf(g);
    expect(goalCard).toMatchObject({
      // It asks on its own: never in Approve All, a fresh touch each.
      kind: 'goal', origin: 'chat:console-1', action: 'goal.propose', templateId: 'chat.goal', status: 'pending', tainted: false, sensitivity: 'personal', destructive: false, consequential: true,
      reason: 'Approving adds it to your suggested goals.',
      args: { goalId: suggestionGoalId(sourceRef), title: g.text, quote: g.quote, dueOn: '2030-03-01', saidAt: g.sourceAt, sourceRef },
      argsProvenance: { quote: { source: 'will', ref: `turn:${g.turnId}`, tainted: false }, title: { source: 'model', tainted: false }, dueOn: { source: 'model', tainted: false }, saidAt: { source: 'event', tainted: false } },
    });
    expect(Math.round((goalCard.expiresAt.getTime() - when.getTime()) / DAY)).toBe(7);
    const commitCard = (await cardOf(c))!;
    expect(commitCard).toMatchObject({
      kind: 'tool_call', origin: 'chat:console-1', action: 'world.commitment.from_chat', templateId: 'chat.commitment', status: 'pending', sensitivity: 'personal', consequential: true,
      reason: 'Approving adds it to the things Flint knows you said you’d do.',
      args: { text: c.text, quote: c.quote, saidAt: c.sourceAt, sourceRef: refOf(c) },
    });
    expect(commitCard.args).not.toHaveProperty('dueOn');
    // The intake's own entry: the source and the day, never a word.
    const entry = await db.auditEntry.findFirstOrThrow({ where: { correlationId: sourceRef, actor: CANDIDATES_ACTOR } });
    expect(entry).toMatchObject({ kind: 'decision', decision: 'log', outcome: 'ok', context: 'chat', action: 'goal.propose', inputs: { sourceRef, turnRef: suggestionTurnRef('console-1', String(g.turnId), 'goal'), proposalId: goalCard.id, saidAt: g.sourceAt, goalId: suggestionGoalId(sourceRef) } });
    // Neither has done anything yet.
    expect(await db.goal.count({ where: { sourceRef } })).toBe(0);
    expect(await db.entity.count({ where: { kind: 'commitment' } })).toBe(0);
  });

  it('the same conversation, turn and quote is never filed twice: not while it waits, not once dismissed and cleared, not once it ran', async () => {
    const when = anotherDay();
    const c = candidate(at(when));
    expect(await take(c, when)).toEqual({ outcome: 'filed' });
    expect(await take(c, when)).toEqual({ outcome: 'known' });
    // Through the route too: 200, not a second 201.
    expect(await post(c)).toMatchObject({ status: 200, body: { outcome: 'known' } });
    // Another short text for the same words is the same suggestion; the same words in another turn are another.
    expect(await take({ ...c, text: `${CANARY} another title` }, when)).toEqual({ outcome: 'known' });
    const card = (await cardOf(c))!;
    expect(await db.proposal.count({ where: { action: 'goal.propose', args: { path: ['sourceRef'], equals: refOf(c) } } })).toBe(1);
    // Dismissed, and its args cleared by retention: the audit trail still knows the source.
    await rejectProposal(db, card.id, {}, undefined, 'will:console');
    await db.$executeRaw`UPDATE "Proposal" SET args = NULL, "argsPurgedAt" = now() WHERE id = ${card.id}`;
    expect(await take(c, when)).toEqual({ outcome: 'known' });
    expect(await db.proposal.count({ where: { action: 'goal.propose', status: 'pending', createdAt: { gte: new Date(Date.now() - 5000) }, args: { path: ['quote'], equals: c.quote } } })).toBe(0);
    // One that ran: the goal it made knows its source.
    const ran = candidate(at(when));
    await take(ran, when);
    const ranCard = (await cardOf(ran))!;
    await sign(ranCard.id);
    await run(ranCard.id);
    expect(await take(ran, when)).toEqual({ outcome: 'known' });
    expect(await db.goal.count({ where: { sourceRef: refOf(ran) } })).toBe(1);
    const other = { ...ran, turnId: 'turn_other' };
    expect(await take(other, when)).toEqual({ outcome: 'filed' });
  });

  it('an approved goal.propose adds only a proposed goal: Flint’s suggestion, Will’s quote as its description, its source recorded', async () => {
    const when = anotherDay();
    const c = candidate({ dueOn: '2030-03-01', ...at(when) });
    await take(c, when);
    const card = (await cardOf(c))!;
    const goals = await db.goal.count();
    const plans = await db.plan.count();
    await sign(card.id);
    const result = await run(card.id);
    const gid = suggestionGoalId(refOf(c));
    expect(result).toEqual({ goalId: gid });
    const goal = await db.goal.findUniqueOrThrow({ where: { id: gid }, include: { links: true, plans: true } });
    expect(goal).toMatchObject({
      status: 'proposed', origin: 'flint', owner: 'will', title: c.text, description: c.quote, sourceRef: refOf(c), sensitivity: 'personal', tainted: false,
      approvalId: null, activatedAt: null, nextReviewAt: null, progress: 0, successCriteria: [], reviewCadence: 'P1W', links: [], plans: [],
    });
    // The day he named, to its end in his zone (UTC here).
    expect(goal.horizonAt?.toISOString()).toBe('2030-03-01T23:59:00.000Z');
    expect(await db.goal.count()).toBe(goals + 1);
    expect(await db.plan.count()).toBe(plans);
    const done = await db.proposal.findUniqueOrThrow({ where: { id: card.id } });
    expect(done).toMatchObject({ status: 'executed', error: null, result: { goalId: gid } });
    // Run again by hand (a retried request): it already ran.
    await expect(run(card.id)).rejects.toMatchObject({ status: 409 });
    // Its date has passed by the time it is approved: the goal is added without one.
    const late = candidate({ dueOn: new Date(when.getTime()).toISOString().slice(0, 10), ...at(when) });
    await take(late, when);
    const lateCard = (await cardOf(late))!;
    await sign(lateCard.id);
    await run(lateCard.id);
    expect((await db.goal.findUniqueOrThrow({ where: { id: suggestionGoalId(refOf(late)) } })).horizonAt).toBeNull();
  });

  it('an approved from_chat adds an unconfirmed commitment: no source row, Will’s quote in EntityText, and nothing a world:read route or PersonGuard reads', async () => {
    const when = anotherDay();
    const c = candidate({ kind: 'commitment', text: `${CANARY} send Dana the draft`, quote: `${CANARY} I will send Dana the draft by Friday`, dueOn: '2030-03-01', ...at(when) });
    await take(c, when);
    const card = (await cardOf(c))!;
    const counted = async () => ((await call('GET', '/v1/world/now')).body.counts as Array<{ kind: string; n: number }>).filter((x) => x.kind === 'commitment').reduce((a, x) => a + x.n, 0);
    const before = await counted();
    await sign(card.id);
    const result = (await run(card.id)) as { entityId: string };
    const e = await db.entity.findUniqueOrThrow({ where: { id: result.entityId }, include: { sources: true, texts: true, versions: true } });
    expect(e).toMatchObject({
      kind: 'commitment', key: refOf(c), name: 'chat commitment due 2030-03-01', status: 'active', sensitivity: 'personal', taintedPaths: [], version: 1,
      state: { source: 'chat', confirmation: 'unconfirmed', dueOn: '2030-03-01', quoteSha256: sha(c.quote) },
      sources: [],
    });
    expect(e.texts).toEqual([expect.objectContaining({ field: 'title', text: c.quote, source: 'chat', tainted: true })]);
    expect(e.versions).toEqual([expect.objectContaining({ version: 1, changeKind: 'created', tainted: false })]);
    // His words are in EntityText alone: never in the name, the key or the state.
    expect(JSON.stringify({ name: e.name, key: e.key, state: e.state, versions: e.versions })).not.toContain('CANARY');
    expect((await db.proposal.findUniqueOrThrow({ where: { id: card.id } }))).toMatchObject({ status: 'executed', result: { entityId: e.id } });
    // No world:read route serves it: not by id, with the server's token or the connector's, and not in a count.
    for (const token of [SERVER, CONNECTOR]) {
      const r = await call('GET', `/v1/world/entities/${e.id}`, undefined, token);
      expect(r).toMatchObject({ status: 404, body: { error: 'no such entity' } });
      expect(r.raw).not.toContain('CANARY');
    }
    expect(await counted()).toBe(before);
    // It can never stand behind a person: PersonGuard reads calendar commitments, and a chat one cannot hold an attendee.
    for (const source of ['google_calendar', 'apple_calendar'] as const) expect(await personAllowed(db, sha('someone@example.com'), source)).toBe(false);
    expect(CHAT_COMMITMENT.safeParse({ ...(e.state as object), attendeeHashes: [sha('someone@example.com')] }).success).toBe(false);
    expect(CHAT_COMMITMENT.safeParse({ ...(e.state as object), source: 'google_calendar' }).success).toBe(false);
    expect(await db.entity.count({ where: { kind: 'person' } })).toBe(0);
  });

  it('a card that is not what the intake files adds nothing when it runs: another origin, template, source or quote fails with a sentence', async () => {
    const when = anotherDay();
    const c = candidate(at(when));
    const sourceRef = refOf(c);
    const good = { goalId: suggestionGoalId(sourceRef), title: c.text, quote: c.quote, saidAt: c.sourceAt, sourceRef };
    /** A card the database's own floor lets through (a chat origin, Will's quote), planted by the owner. */
    const plant = async (o: { args?: Record<string, unknown>; template?: string | null; ref?: string; origin?: string } = {}) => {
      const pid = id('prforged');
      const args = o.args ?? good;
      await owner(
        `INSERT INTO "Proposal" (id, kind, origin, action, "templateId", args, "argsDigest", "argsProvenance", tainted, sensitivity, reason, "expiresAt")
         VALUES ($1, 'goal', $2, 'goal.propose', $3, $4::jsonb, $5, $6::jsonb, false, 'personal', 'x', now() + interval '1 day')`,
        [pid, o.origin ?? 'chat:console-1', o.template === undefined ? 'chat.goal' : o.template, JSON.stringify(args), digestOf(args), JSON.stringify({ quote: { source: 'will', ref: o.ref ?? `turn:${c.turnId}`, tainted: false } })],
      );
      return pid;
    };
    const forged = [
      await plant({ origin: 'chat:another-conversation' }),
      await plant({ ref: 'turn:another_turn' }),
      await plant({ template: null }),
      await plant({ args: { ...good, quote: `${CANARY} words Will never said in that turn` } }),
      await plant({ args: { ...good, goalId: 'goforgedgoal01' } }),
      await plant({ args: { ...good, extra: 'x' } }),
    ];
    const goals = await db.goal.count();
    for (const pid of forged) {
      await sign(pid);
      await expect(run(pid), pid).rejects.toMatchObject({ status: 409, message: 'This suggestion changed since it was filed.' });
      expect(await db.proposal.findUniqueOrThrow({ where: { id: pid } })).toMatchObject({ status: 'failed', error: 'This suggestion changed since it was filed.' });
    }
    expect(await db.goal.count()).toBe(goals);
    // The one that is what the intake files runs.
    const real = await plant();
    await sign(real);
    expect(await run(real)).toEqual({ goalId: good.goalId });
  });

  it('3 goals and 10 commitments a day while cards wait: the next one is refused, and files nothing', async () => {
    const when = anotherDay();
    for (let i = 0; i < 3; i++) expect(await take(candidate(at(when)), when)).toEqual({ outcome: 'filed' });
    const fourth = candidate(at(when));
    await expect(take(fourth, when)).rejects.toMatchObject({ status: 429, message: 'Flint reached today’s limit of suggestions from chat.' });
    expect(await cardOf(fourth)).toBeNull();
    for (let i = 0; i < 10; i++) expect(await take(candidate({ kind: 'commitment', ...at(when) }), when)).toEqual({ outcome: 'filed' });
    const eleventh = candidate({ kind: 'commitment', ...at(when) });
    await expect(take(eleventh, when)).rejects.toMatchObject({ status: 429 });
    expect(await cardOf(eleventh)).toBeNull();
    // A replay of one already filed is still just known, and the next day starts again.
    const next = new Date(when.getTime() + DAY);
    expect(await take(candidate(at(next)), next)).toEqual({ outcome: 'filed' });
    const day = when.toISOString().slice(0, 10);
    expect((await db.actionCounter.findUniqueOrThrow({ where: { action_day: { action: filedCounter('goal.propose'), day } } })).count).toBe(3);
    expect((await db.actionCounter.findUniqueOrThrow({ where: { action_day: { action: filedCounter('world.commitment.from_chat'), day } } })).count).toBe(10);
  });

  it('Make It a Goal takes one signature through the real signed path, and the waiting card is set aside', async () => {
    const when = new Date();
    const c = candidate({ dueOn: '2030-03-01', sourceAt: new Date(when.getTime() - 2 * DAY).toISOString() });
    await owner(`DELETE FROM "ActionCounter" WHERE action LIKE '%:filed'`);
    expect(await post(c)).toMatchObject({ status: 201, body: { outcome: 'filed' } });
    const sourceRef = refOf(c);
    const gid = suggestionGoalId(sourceRef);
    const card = (await cardOf(c))!;
    // The Suggested tab lists it: its title, his words, the day he said them and the day he named.
    const listed = (await page()).suggestions.find((s) => s.goalId === gid);
    expect(listed).toEqual({ goalId: gid, title: c.text, quote: c.quote, saidAt: c.sourceAt, dueOn: '2030-03-01', waiting: true });
    // The form's args: his own goal now, with a check and a first step, still one Flint suggested.
    const args = {
      goalId: gid, owner: 'will', origin: 'flint', sensitivity: 'personal', tainted: false, nexusProjectId: null,
      title: `${CANARY} run the spring half marathon`, description: c.quote, horizonAt: '2030-03-01T23:59:00.000Z', reviewCadence: 'P1W',
      successCriteria: [{ id: 'c1', text: `${CANARY} crossed the line`, check: { kind: 'steps', keys: ['s1'] } }],
      links: [], plan: { ops: [{ op: 'add', key: 's1', step: { ordinal: 100, title: `${CANARY} sign up`, kind: 'will_task', tier: 'approval', dueAt: null, dependsOn: [] } }] },
    };
    // It must be a suggestion's start: his own new goal is filed another way.
    expect((await call('POST', `/v1/goals/${gid}/start`, { args: { ...args, origin: 'will' } })).status).toBe(400);
    const approvals = async () => Number((await owner(`SELECT count(*)::int AS n FROM "Approval" WHERE "consumedAt" IS NOT NULL`)).rows[0].n);
    const before = await approvals();
    const filed = await call('POST', `/v1/goals/${gid}/start`, { args });
    expect(filed.status).toBe(200);
    const pid = filed.body.id as string;
    expect(await db.proposal.findUniqueOrThrow({ where: { id: pid } })).toMatchObject({ action: 'goal.activate', origin: 'console', kind: 'goal', consequential: true, argsDigest: digestOf(args) });
    await sign(pid);
    const result = await run(pid);
    expect(result).toMatchObject({ goalId: gid, steps: 1, fromSuggestion: true });
    // One signature: the goal is active, and nothing else was signed.
    expect(await approvals()).toBe(before + 1);
    const goal = await db.goal.findUniqueOrThrow({ where: { id: gid }, include: { plans: { include: { steps: true } } } });
    expect(goal).toMatchObject({ status: 'active', origin: 'flint', owner: 'will', sourceRef, title: args.title, description: c.quote });
    expect(goal.approvalId).toBeTruthy();
    expect(goal.plans[0]!.steps.map((s) => s.key)).toEqual(['s1']);
    // The suggestion's own card is replaced, unsigned, and can never run.
    expect(await db.proposal.findUniqueOrThrow({ where: { id: card.id } })).toMatchObject({ status: 'rejected', error: 'A newer version of this card replaced it.', approvalId: null });
    expect((await page()).suggestions.find((s) => s.goalId === gid)).toBeUndefined();
    // The same words are not suggested again.
    expect(await post(c)).toMatchObject({ status: 200, body: { outcome: 'known' } });
    expect(await db.goal.count({ where: { sourceRef } })).toBe(1);
  });

  it('a suggestion whose card already ran is started as the goal it made: never a second goal with the same source', async () => {
    const c = candidate();
    await owner(`DELETE FROM "ActionCounter" WHERE action LIKE '%:filed'`);
    await post(c);
    const sourceRef = refOf(c);
    const gid = suggestionGoalId(sourceRef);
    const card = (await cardOf(c))!;
    await sign(card.id);
    await run(card.id);
    // It is a proposed goal now, and still on the Suggested tab (no longer waiting on its card).
    expect((await page()).suggestions.find((s) => s.goalId === gid)).toEqual({ goalId: gid, title: c.text, quote: c.quote, saidAt: c.sourceAt, dueOn: null, waiting: false });
    const args = {
      goalId: gid, owner: 'will', origin: 'flint', sensitivity: 'personal', tainted: false, nexusProjectId: null, title: c.text, description: c.quote, horizonAt: null, reviewCadence: 'P2W',
      successCriteria: [{ id: 'c1', text: `${CANARY} done`, check: { kind: 'manual' } }], links: [], plan: null,
    };
    const pid = (await call('POST', `/v1/goals/${gid}/start`, { args })).body.id as string;
    await sign(pid);
    expect(await run(pid)).toMatchObject({ goalId: gid });
    expect(await db.goal.count({ where: { sourceRef } })).toBe(1);
    expect(await db.goal.findUniqueOrThrow({ where: { id: gid } })).toMatchObject({ status: 'active', origin: 'flint', reviewCadence: 'P2W' });
    // Started once: a second start says where it stands.
    expect(await call('POST', `/v1/goals/${gid}/start`, { args })).toMatchObject({ status: 409, body: { code: 'status.active' } });
  });

  it('Make It a Goal while the suggestion’s own card is approved first: the start card then starts the goal that card made', async () => {
    const c = candidate();
    await owner(`DELETE FROM "ActionCounter" WHERE action LIKE '%:filed'`);
    await post(c);
    const gid = suggestionGoalId(refOf(c));
    const card = (await cardOf(c))!;
    const args = {
      goalId: gid, owner: 'will', origin: 'flint', sensitivity: 'personal', tainted: false, nexusProjectId: null, title: c.text, description: c.quote, horizonAt: null, reviewCadence: 'P1W',
      successCriteria: [{ id: 'c1', text: `${CANARY} done`, check: { kind: 'manual' } }], links: [], plan: null,
    };
    // The start card is filed (the prompt was cancelled), then the suggestion's own card is approved in Approvals.
    const pid = (await call('POST', `/v1/goals/${gid}/start`, { args })).body.id as string;
    await sign(card.id);
    await run(card.id);
    await sign(pid);
    expect(await run(pid)).toMatchObject({ goalId: gid });
    expect(await db.goal.count({ where: { sourceRef: refOf(c) } })).toBe(1);
    expect((await db.goal.findUniqueOrThrow({ where: { id: gid } })).status).toBe('active');
  });

  it('only a suggestion starts this way: not Will’s own goal, not one with no card waiting, not one already dismissed', async () => {
    const c = candidate();
    await owner(`DELETE FROM "ActionCounter" WHERE action LIKE '%:filed'`);
    const gid = suggestionGoalId(refOf(c));
    const args = {
      goalId: gid, owner: 'will', origin: 'flint', sensitivity: 'personal', tainted: false, nexusProjectId: null, title: c.text, description: '', horizonAt: null, reviewCadence: 'P1W',
      successCriteria: [{ id: 'c1', text: `${CANARY} done`, check: { kind: 'manual' } }], links: [], plan: null,
    };
    // Nothing was suggested under this id.
    expect(await call('POST', `/v1/goals/${gid}/start`, { args })).toMatchObject({ status: 404, body: { code: 'suggestionGone' } });
    // The general card route cannot make a goal Flint's own either.
    await expect(createProposal(db, { kind: 'goal', origin: 'console', action: 'goal.activate', args, argsProvenance: { args: { source: 'will', tainted: false } }, tainted: false, sensitivity: 'personal', destructive: false, consequential: true, ttlMinutes: 60 }, 'test'))
      .rejects.toMatchObject({ status: 409, message: 'This suggestion is no longer waiting.' });
    await post(c);
    // Dismissed: the card is set aside, unsigned, with a sentence, and audited by ids.
    expect(await call('POST', `/v1/goals/${gid}/dismiss`, {})).toMatchObject({ status: 200, body: { ok: true } });
    const card = (await cardOf(c))!;
    expect(card).toMatchObject({ status: 'rejected', error: 'You dismissed it.', approvalId: null });
    expect(await db.auditEntry.findFirst({ where: { action: 'goal.dismiss', correlationId: `${gid}.dismiss` } })).toMatchObject({ actor: 'will:console', inputs: { goalId: gid, proposalId: card.id } });
    expect((await page()).suggestions.find((s) => s.goalId === gid)).toBeUndefined();
    expect(await call('POST', `/v1/goals/${gid}/start`, { args })).toMatchObject({ status: 404, body: { code: 'suggestionGone' } });
    expect(await call('POST', `/v1/goals/${gid}/dismiss`, {})).toMatchObject({ status: 404, body: { code: 'noGoal' } });
    expect(await post(c)).toMatchObject({ status: 200, body: { outcome: 'known' } });
    expect(await db.goal.count({ where: { id: gid } })).toBe(0);
    // A start card signed before the dismissal does nothing after it.
    const d = candidate();
    await post(d);
    const did = suggestionGoalId(refOf(d));
    const start = (await call('POST', `/v1/goals/${did}/start`, { args: { ...args, goalId: did } })).body.id as string;
    await sign(start);
    await call('POST', `/v1/goals/${did}/dismiss`, {});
    await expect(run(start)).rejects.toMatchObject({ status: 409, message: 'This suggestion is no longer waiting.' });
    expect(await db.goal.count({ where: { id: did } })).toBe(0);
  });

  it('a suggestion that shares two content words with an active goal’s title asks for that goal’s review, once, within its day’s limit', async () => {
    await owner(`DELETE FROM "ActionCounter" WHERE action LIKE '%:filed'`);
    /** An active goal of Will's own, filed, signed and run. */
    const goal = async (title: string) => {
      const gid = id('go').replace(/[^A-Za-z0-9]/g, '');
      const args = { goalId: gid, owner: 'will', origin: 'will', sensitivity: 'personal', tainted: false, nexusProjectId: null, title, description: '', horizonAt: null, reviewCadence: 'P1W', successCriteria: [{ id: 'c1', text: `${CANARY} done`, check: { kind: 'manual' } }], links: [], plan: null };
      const p = await createProposal(db, { kind: 'goal', origin: 'console', action: 'goal.activate', args, argsProvenance: { args: { source: 'will', tainted: false } }, tainted: false, sensitivity: 'personal', destructive: false, consequential: true, ttlMinutes: 60 }, 'will:console');
      await sign(p.id);
      await run(p.id);
      return gid;
    };
    const marathon = await goal('Finish the Dallas marathon training block');
    const kitchen = await goal('Renovate the kitchen cabinets');
    expect(RELATED_WORDS).toBe(2);
    bus.clear();
    // Two words of the marathon goal's title (marathon, training), in his quote; one of the kitchen's (kitchen).
    const c = candidate({ text: 'Book the race', quote: 'I will add a long run to my marathon training before the kitchen is done' });
    expect(await post(c)).toMatchObject({ status: 201 });
    const sourceRef = refOf(c);
    expect(bus.of(REVIEW_QUEUE)).toEqual([{ queue: REVIEW_QUEUE, data: { goalId: marathon, kind: 'triggered', triggerEventId: sourceRef }, options: { singletonKey: marathon, startAfter: 60 } }]);
    // The job carries ids only, and the review it sets off is recorded as set off by this chat.
    expect(JSON.stringify(bus.sent)).not.toContain('marathon training');
    const outcome = await runReview({ db, tz: 'UTC', bus }, bus.take(REVIEW_QUEUE)!.data as never);
    expect(outcome.outcome).toBe('reviewed');
    expect(await db.goalReview.findFirstOrThrow({ where: { goalId: marathon } })).toMatchObject({ kind: 'triggered', triggerEventId: sourceRef });
    expect(await db.goalReview.count({ where: { goalId: kitchen } })).toBe(0);
    // A replay asks for nothing; reviews off, or the bus not up, asks for nothing; a paused goal is not reviewed.
    bus.clear();
    await post(c);
    expect(bus.sent).toEqual([]);
    const again = { text: 'Stretch more', quote: 'I will stretch after every marathon training run this month' };
    expect(await askReviews({ db, tz: 'UTC', reviews: false, bus: () => bus }, again, sourceRef, new Date())).toBe(0);
    expect(await askReviews({ db, tz: 'UTC', reviews: true }, again, sourceRef, new Date())).toBe(0);
    expect(await askReviews({ db, tz: 'UTC', reviews: true, bus: () => bus }, again, suggestionSourceRef('c', 't', again.quote), new Date())).toBe(1);
    bus.clear();
    // Past the goal's 12 triggered reviews today: nothing is sent (the next scheduled review covers it).
    await owner(`UPDATE "ActionCounter" SET count = 12 WHERE action = $1`, [`goal.review:${marathon}`]);
    expect(await askReviews({ db, tz: 'UTC', reviews: true, bus: () => bus }, again, suggestionSourceRef('c', 't2', again.quote), new Date())).toBe(0);
    expect(bus.sent).toEqual([]);
  });

  it('identical or racing posts make one card and use one of the day’s slots', async () => {
    await owner(`DELETE FROM "ActionCounter" WHERE action LIKE '%:filed'`);
    const day = new Date().toISOString().slice(0, 10);
    const slots = async () => (await db.actionCounter.findUnique({ where: { action_day: { action: filedCounter('goal.propose'), day } } }))?.count ?? 0;
    // Eight of the same at once (the reviewer's case: it used to leave one card, three slots gone and five 429s).
    const c = candidate();
    const eight = await Promise.all(Array.from({ length: 8 }, () => post(c)));
    expect(eight.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 200, 200, 200, 201]);
    expect(eight.filter((r) => r.status === 200).every((r) => r.body.outcome === 'known')).toBe(true);
    expect(await db.proposal.count({ where: { action: 'goal.propose', args: { path: ['sourceRef'], equals: refOf(c) } } })).toBe(1);
    expect(await slots()).toBe(1);
    // The same source under three different short texts at once: one card, one goal id, one more slot.
    const d = candidate();
    const three = await Promise.all(['one', 'two', 'three'].map((t) => post({ ...d, text: `${CANARY} title ${t}` })));
    expect(three.map((r) => r.status).sort()).toEqual([200, 200, 201]);
    expect(await db.proposal.count({ where: { action: 'goal.propose', args: { path: ['sourceRef'], equals: refOf(d) } } })).toBe(1);
    expect(await slots()).toBe(2);
    // So the day's third distinct goal is still taken, and its fourth is not.
    expect((await post(candidate())).status).toBe(201);
    expect((await post(candidate())).status).toBe(429);
    expect(await slots()).toBe(3);
    // A card that could not be filed gives its slot back: the database refuses this one (its floor), inside the same transaction.
    await owner(`DELETE FROM "ActionCounter" WHERE action LIKE '%:filed'`);
    await owner(`ALTER TABLE "Proposal" ADD CONSTRAINT "zz_test_refuse" CHECK (args->>'title' IS DISTINCT FROM 'Synthetic refused title') NOT VALID`);
    try {
      const refused = await post(candidate({ text: 'Synthetic refused title' }));
      expect(refused.status).toBe(400);
      expect(await slots()).toBe(0);
    } finally {
      await owner(`ALTER TABLE "Proposal" DROP CONSTRAINT "zz_test_refuse"`);
    }
  });

  it('once a suggestion is turned down, nothing more of that kind is taken from that turn, however it is quoted; the same words in a later turn are a new suggestion', async () => {
    await owner(`DELETE FROM "ActionCounter" WHERE action LIKE '%:filed'`);
    const c = candidate({ quote: `${CANARY} I want to run a half marathon by spring and train every single week` });
    expect((await post(c)).status).toBe(201);
    const gid = suggestionGoalId(refOf(c));
    expect((await call('POST', `/v1/goals/${gid}/dismiss`, {})).status).toBe(200);
    // The reviewer's rows: the same turn quoted two words shorter, or trimmed by one, used to be filed again.
    for (const quote of [`${CANARY} I want to run a half marathon by spring and train every`, `${CANARY} I want to run a half marathon by spring`, `I want to run a half marathon`]) {
      expect(await post({ ...c, quote }), quote).toMatchObject({ status: 200, body: { outcome: 'known' } });
    }
    expect(await post({ ...c, text: `${CANARY} another title`, quote: `${CANARY} I want to run a half marathon by spring` })).toMatchObject({ status: 200, body: { outcome: 'known' } });
    expect((await page()).suggestions.filter((x) => x.title.includes('half marathon') && x.quote.includes('every single week'))).toEqual([]);
    // Another kind from that turn is not what he turned down; nor are the same words in a later turn.
    expect((await post({ ...c, kind: 'commitment', quote: `${CANARY} I want to run a half marathon by spring` })).status).toBe(201);
    expect((await post({ ...c, turnId: 'turn_later' })).status).toBe(201);
    // A card rejected in Approvals, with his signature, is turned down the same way.
    const d = candidate({ quote: `${CANARY} I want to learn to sail before the summer comes round` });
    await post(d);
    const card = (await cardOf(d))!;
    await rejectProposal(db, card.id, { approvalId: await key.approve({ subjectId: card.id, action: card.action, argsDigest: card.argsDigest, decision: 'reject' }) }, undefined, 'test');
    expect(await post({ ...d, quote: `${CANARY} I want to learn to sail` })).toMatchObject({ status: 200, body: { outcome: 'known' } });
    // And a suggestion that became a proposed goal and was dismissed there.
    await owner(`DELETE FROM "ActionCounter" WHERE action LIKE '%:filed'`);
    const e = candidate({ quote: `${CANARY} I want to restore the old boat in the yard this year` });
    await post(e);
    const ran = (await cardOf(e))!;
    await sign(ran.id);
    await run(ran.id);
    expect((await call('POST', `/v1/goals/${suggestionGoalId(refOf(e))}/dismiss`, {})).status).toBe(200);
    expect(await post({ ...e, quote: `${CANARY} I want to restore the old boat` })).toMatchObject({ status: 200, body: { outcome: 'known' } });
    // One he made a goal was not turned down: other words of that turn may still be suggested.
    const f = candidate({ quote: `${CANARY} I want to paint the fence and I want to fix the gate too` });
    await post(f);
    const fid = suggestionGoalId(refOf(f));
    const started = (await call('POST', `/v1/goals/${fid}/start`, { args: {
      goalId: fid, owner: 'will', origin: 'flint', sensitivity: 'personal', tainted: false, nexusProjectId: null, title: f.text, description: f.quote, horizonAt: null, reviewCadence: 'P1W',
      successCriteria: [{ id: 'c1', text: `${CANARY} done`, check: { kind: 'manual' } }], links: [], plan: null,
    } })).body.id as string;
    await sign(started);
    await run(started);
    expect((await post({ ...f, quote: `${CANARY} I want to fix the gate too` })).status).toBe(201);
  });

  it('a waiting card whose goal already exists is not shown as waiting, and Dismiss sets it aside', async () => {
    await owner(`DELETE FROM "ActionCounter" WHERE action LIKE '%:filed'`);
    const c = candidate();
    await post(c);
    const sourceRef = refOf(c);
    const gid = suggestionGoalId(sourceRef);
    const args = {
      goalId: gid, owner: 'will', origin: 'flint', sensitivity: 'personal', tainted: false, nexusProjectId: null, title: c.text, description: c.quote, horizonAt: null, reviewCadence: 'P1W',
      successCriteria: [{ id: 'c1', text: `${CANARY} done`, check: { kind: 'manual' } }], links: [], plan: null,
    };
    const start = (await call('POST', `/v1/goals/${gid}/start`, { args })).body.id as string;
    await sign(start);
    await run(start);
    // A second card of the same suggestion still waiting (what racing posts could leave before the intake locked its source).
    const left = { goalId: gid, title: `${CANARY} the same goal, worded again`, quote: c.quote, saidAt: c.sourceAt, sourceRef };
    await owner(
      `INSERT INTO "Proposal" (id, kind, origin, action, "templateId", args, "argsDigest", "argsProvenance", tainted, sensitivity, consequential, reason, "expiresAt")
       VALUES ('prleftwaiting1', 'goal', 'chat:console-1', 'goal.propose', 'chat.goal', $1::jsonb, $2, $3::jsonb, false, 'personal', true, 'x', now() + interval '1 day')`,
      [JSON.stringify(left), digestOf(left), JSON.stringify({ quote: { source: 'will', ref: `turn:${c.turnId}`, tainted: false } })],
    );
    // The goal is active: the tab does not show the card as a suggestion waiting, and it cannot be started twice.
    expect((await page()).suggestions.find((x) => x.goalId === gid)).toBeUndefined();
    expect(await call('POST', `/v1/goals/${gid}/start`, { args })).toMatchObject({ status: 409, body: { code: 'status.active' } });
    // Dismiss sets the leftover card aside (it used to answer "This goal is already active." and leave it waiting).
    expect(await call('POST', `/v1/goals/${gid}/dismiss`, {})).toMatchObject({ status: 200, body: { ok: true } });
    expect(await db.proposal.findUniqueOrThrow({ where: { id: 'prleftwaiting1' } })).toMatchObject({ status: 'rejected', error: 'You dismissed it.' });
    expect((await db.goal.findUniqueOrThrow({ where: { id: gid } })).status).toBe('active');
    // With nothing left waiting, Dismiss says where the goal stands.
    expect(await call('POST', `/v1/goals/${gid}/dismiss`, {})).toMatchObject({ status: 409, body: { code: 'status.active' } });
  });

  it('a row the panel’s contract does not take is left out and counted: the Suggested and Finished tabs still answer', async () => {
    await owner(`DELETE FROM "ActionCounter" WHERE action LIKE '%:filed'`);
    const errors: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void errors.push(a.map(String).join(' ')));
    try {
      // The reviewer's title: 84 characters as the database counts them, 154 as a goal's title is counted.
      const title = `half marathon ${'\u{1F3C3}'.repeat(70)}`;
      expect([[...title].length, title.length, GoalTitle.safeParse(title).success]).toEqual([84, 154, false]);
      // The intake no longer takes it...
      expect((await post(candidate({ text: title }))).status).toBe(400);
      // ...but a row stored in that state (by an intake from before the fix) must not take a tab down: a proposed goal,
      const stored = `go${'ab12'.repeat(8)}`;
      await owner(`INSERT INTO "Goal" (id, title, description, owner, origin, "sourceRef", "updatedAt") VALUES ($1, $2, $3, 'will', 'flint', $4, now())`, [stored, title, `${CANARY} words he said then`, `chat:${'ab12'.repeat(16)}`]);
      // and a waiting card.
      const cardSource = `chat:${'cd34'.repeat(16)}`;
      const waiting = { goalId: suggestionGoalId(cardSource), title, quote: `${CANARY} I want to run a half marathon`, saidAt: new Date().toISOString(), sourceRef: cardSource };
      await owner(
        `INSERT INTO "Proposal" (id, kind, origin, action, "templateId", args, "argsDigest", "argsProvenance", tainted, sensitivity, consequential, reason, "expiresAt")
         VALUES ('prastralcard01', 'goal', 'chat:console-1', 'goal.propose', 'chat.goal', $1::jsonb, $2, $3::jsonb, false, 'personal', true, 'x', now() + interval '1 day')`,
        [JSON.stringify(waiting), digestOf(waiting), JSON.stringify({ quote: { source: 'will', ref: 'turn:turn_astral', tainted: false } })],
      );
      const good = candidate();
      expect((await post(good)).status).toBe(201);
      const r = await call('GET', '/v1/goals?tab=suggested');
      expect(r.status).toBe(200);
      const tab = r.body as unknown as GoalsPage;
      const ids = tab.suggestions.map((x) => x.goalId);
      expect(ids).toContain(suggestionGoalId(refOf(good)));
      expect(ids).not.toContain(stored);
      expect(ids).not.toContain(waiting.goalId);
      expect(tab.goals.map((g) => g.id)).not.toContain(stored);
      // Counted, by number alone.
      expect(errors.filter((l) => /^\[goals\] left 1 row\(s\) out of the (suggested|Suggested) tab: not what the panel's contract takes$/.test(l)).length).toBeGreaterThanOrEqual(2);
      expect(errors).toContain("[goals] left 1 waiting card(s) out of the Suggested tab: not a suggestion's args");
      // Dismissed by its id (the tab cannot show it), it does not take the Finished tab down either.
      expect((await call('POST', `/v1/goals/${stored}/dismiss`, {})).status).toBe(200);
      const f = await call('GET', '/v1/goals?tab=finished');
      expect(f.status).toBe(200);
      expect((f.body as unknown as GoalsPage).goals.map((g) => g.id)).not.toContain(stored);
      expect(errors.some((l) => /left 1 row\(s\) out of the finished tab/.test(l))).toBe(true);
      expect((await call('GET', '/v1/goals?tab=active')).status).toBe(200);
      expect(errors.join('\n')).not.toContain('CANARY');
      expect(errors.join('\n')).not.toContain('marathon');
      await rejectProposal(db, 'prastralcard01', {}, undefined, 'will:console');
    } finally {
      spy.mockRestore();
    }
  });

  it('goals proposed before the database held them to a card stay as they were: listed, made into goals with one signature, and dismissed', async () => {
    const [a, b] = [candidate(), candidate()];
    const [ga, gb] = [suggestionGoalId(refOf(a)), suggestionGoalId(refOf(b))];
    // A database from before the floor (its own down.sql): the runtime's own role writes each row, with no card behind it.
    await withoutChatGoalFloor(urls.owner, async () => {
      for (const c of [a, b]) {
        await db.goal.create({ data: { id: suggestionGoalId(refOf(c)), title: c.text, description: c.quote, owner: 'will', origin: 'flint', sensitivity: 'personal', tainted: false, successCriteria: [], reviewCadence: 'P1W', sourceRef: refOf(c) } });
      }
    });
    expect(await chatFloorInDatabase(db)).toBe(true);
    // With the floor in place the same write is refused: it guards new rows, and leaves these alone.
    const c = candidate();
    await expect(db.goal.create({ data: { id: suggestionGoalId(refOf(c)), title: c.text, description: c.quote, owner: 'will', origin: 'flint', sensitivity: 'personal', tainted: false, successCriteria: [], reviewCadence: 'P1W', sourceRef: refOf(c) } })).rejects.toBeTruthy();
    expect(await db.goal.count({ where: { sourceRef: refOf(c) } })).toBe(0);
    const listed = (await page()).suggestions.filter((s) => s.goalId === ga || s.goalId === gb);
    expect(listed.map((s) => [s.goalId, s.title, s.quote, s.waiting]).sort()).toEqual([[ga, a.text, a.quote, false], [gb, b.text, b.quote, false]].sort());
    // Made a goal: one signature, through the real signed path.
    const args = {
      goalId: ga, owner: 'will', origin: 'flint', sensitivity: 'personal', tainted: false, nexusProjectId: null, title: a.text, description: a.quote, horizonAt: null, reviewCadence: 'P1W',
      successCriteria: [{ id: 'c1', text: `${CANARY} crossed the line`, check: { kind: 'manual' } }], links: [], plan: null,
    };
    const filed = await call('POST', `/v1/goals/${ga}/start`, { args });
    expect(filed.status).toBe(200);
    await sign(filed.body.id as string);
    expect(await run(filed.body.id as string)).toMatchObject({ goalId: ga });
    expect(await db.goal.findUniqueOrThrow({ where: { id: ga } })).toMatchObject({ status: 'active', origin: 'flint', sourceRef: refOf(a) });
    // Dismissed: unsigned, as before.
    expect((await call('POST', `/v1/goals/${gb}/dismiss`, {})).status).toBe(200);
    expect(await db.goal.findUniqueOrThrow({ where: { id: gb } })).toMatchObject({ status: 'rejected' });
    expect((await page()).suggestions.filter((s) => s.goalId === ga || s.goalId === gb)).toEqual([]);
  });

  it('a card’s quote must be Will’s by its provenance, checked in code as well as by the database', () => {
    const sourceRef = suggestionSourceRef('console-1', 'turn_1', `${CANARY} I want to run a half marathon`);
    const card = (quote: unknown) => ({
      kind: 'goal', origin: 'chat:console-1', templateId: 'chat.goal', tainted: false,
      args: { goalId: suggestionGoalId(sourceRef), title: 'Run a half marathon', quote: `${CANARY} I want to run a half marathon`, saidAt: '2026-10-08T15:00:00.000Z', sourceRef },
      argsProvenance: quote === undefined ? {} : { quote },
    });
    expect(suggestionCardProblem('goal.propose', card({ source: 'will', ref: 'turn:turn_1', tainted: false }))).toBeUndefined();
    for (const quote of [{ source: 'model', ref: 'turn:turn_1', tainted: false }, { source: 'will', ref: 'turn:turn_1', tainted: true }, { source: 'will', tainted: false }, { source: 'will', ref: 'turn_1', tainted: false }, undefined]) {
      expect(suggestionCardProblem('goal.propose', card(quote)), JSON.stringify(quote)).toBe('the quote is not Will’s, by a turn');
    }
    // And by the turn its provenance names: another turn's is another source.
    expect(suggestionCardProblem('goal.propose', card({ source: 'will', ref: 'turn:turn_2', tainted: false }))).toBe('the source is not this conversation, turn and quote');
  });

  it('what Will did with each suggestion is counted once: approving its card, making it a goal himself (a yes, not a no), or turning it down', async () => {
    await owner(`DELETE FROM "ActionCounter" WHERE action LIKE '%:filed'`);
    const before = await chatSuggestions(db, { actions: ['goal.propose'] });
    // The reviewer's three: one made a goal, one dismissed, one approved in Approvals.
    const [made, dismissed, approved] = [candidate(), candidate(), candidate()];
    for (const c of [made, dismissed, approved]) expect((await post(c)).status).toBe(201);
    const mid = suggestionGoalId(refOf(made));
    const start = (await call('POST', `/v1/goals/${mid}/start`, { args: {
      goalId: mid, owner: 'will', origin: 'flint', sensitivity: 'personal', tainted: false, nexusProjectId: null, title: made.text, description: made.quote, horizonAt: null, reviewCadence: 'P1W',
      successCriteria: [{ id: 'c1', text: `${CANARY} done`, check: { kind: 'manual' } }], links: [], plan: null,
    } })).body.id as string;
    await sign(start);
    await run(start);
    await call('POST', `/v1/goals/${suggestionGoalId(refOf(dismissed))}/dismiss`, {});
    const card = (await cardOf(approved))!;
    await sign(card.id);
    await run(card.id);
    const after = await chatSuggestions(db, { actions: ['goal.propose'] });
    const delta = Object.fromEntries((Object.keys(after) as Array<keyof typeof after>).map((k) => [k, after[k] - before[k]]));
    expect(delta).toEqual({ filed: 3, withoutQuote: 0, cleared: 0, executed: 1, made: 1, rejected: 1, expired: 0 });
  });

  it('the P3 report counts them: suggestions filed, each resting on Will’s quote, and what he did with them', async () => {
    const report = await p3Report(db, { tz: 'UTC', planner: true });
    const seven = report.criteria.find((x) => x.n === 7)!;
    const cards = await db.proposal.findMany({ where: { action: { in: ['goal.propose', 'world.commitment.from_chat'] } }, select: { status: true, error: true, action: true } });
    const of = (s: string) => cards.filter((c) => c.status === s).length;
    // Set aside by Make It a Goal: his yes, counted as that and not as a rejection.
    const made = cards.filter((c) => c.status === 'rejected' && c.action === 'goal.propose' && c.error === 'A newer version of this card replaced it.').length;
    expect(made).toBeGreaterThanOrEqual(3);
    // Six were planted with words Will never said in that turn, or another turn's: the database let them in (a quote, his, untainted),
    // and the runtime refused each when it ran. The criterion reads the quote floor, which every one of them meets.
    expect(seven).toMatchObject({
      n: 7, pass: true,
      values: { suggestions: cards.length, withoutQuote: 0, approved: of('executed'), madeGoals: made, rejected: of('rejected') - made, expired: of('expired'), addedAlone: 0 },
    });
    expect(seven.values.suggestions).toBeGreaterThan(20);
    expect(seven.detail).toMatch(/^\d+ suggestions from chat; 0 without your own quoted words; \d+ too old to read; you approved \d+, made \d+ into goals yourself and rejected \d+, and \d+ expired$/);
    expect(JSON.stringify(report)).not.toContain('CANARY');
  });
});

describe.skipIf(NO_DB)('suggestions from chat after a promotion Will signed (ALONE, on the database’s own floor)', () => {
  let urls: TestUrls;
  let db: Db;
  let key: Awaited<ReturnType<typeof enrollTestKey>>;
  let n = 0;
  const candidate = (now: Date, over: Record<string, unknown> = {}) => {
    n += 1;
    return {
      kind: 'goal', text: `${CANARY} learn to sail ${n}`, quote: `${CANARY} I want to learn to sail this summer ${n}`,
      conversationId: 'console-2', turnId: `turn_${n}`, sourceAt: new Date(now.getTime() - 60_000).toISOString(), ...over,
    };
  };
  /** The intake as the route calls it, at a time of the test's choosing. No seam: whether a goal may land without a card is the database's to say. */
  const take = (c: Record<string, unknown>, now: Date) => takeCandidate({ db, tz: 'UTC', now: () => now }, c);
  const refOf = (c: { conversationId?: unknown; turnId?: unknown; quote?: unknown }) => suggestionSourceRef(String(c.conversationId), String(c.turnId), String(c.quote));
  /** A policy change Will signs and the runtime applies: the promotion's rows, with the caps given. */
  async function promote(rows: Array<{ pattern: string; dailyCap: number }>) {
    const args = { rows: rows.map((r) => ({ ...r, tier: 'alone', reason: 'P3 chat promotion table, a test', expiresAt: new Date(Date.now() + 30 * DAY).toISOString() })) };
    const p = await createProposal(db, { kind: 'policy', origin: 'cli', action: 'policy.change', templateId: 'p3c.promotion', args, argsProvenance: { rows: { source: 'template', tainted: false } }, tainted: false, sensitivity: 'ops', destructive: false, consequential: true, ttlMinutes: 60 }, 'will:cli');
    await approveProposal(db, p.id, await key.approve({ subjectId: p.id, action: 'policy.change', argsDigest: p.argsDigest }), undefined, 'test');
    await runInternal(db, p.id, undefined, 'UTC', 'test');
  }
  const retire = () => withClient(urls.owner, (c) => c.query(`UPDATE "ActionPolicy" SET active = false`));
  /**
   * The database counts the goals from chat made in the last 24 hours by its own clock, and these tests live several
   * days in one run (the intake's clock is theirs to set). So each puts what it made into the past, as the owner.
   */
  const age = () => withClient(urls.owner, async (c) => {
    await c.query('ALTER TABLE "Goal" DISABLE TRIGGER "Goal_guard"');
    await c.query(`UPDATE "Goal" SET "createdAt" = "createdAt" - interval '3 days' WHERE "createdAt" > now() - interval '2 days'`);
    await c.query('ALTER TABLE "Goal" ENABLE TRIGGER "Goal_guard"');
  });

  beforeAll(async () => {
    urls = await freshDb();
    db = createDb(urls.app);
    key = await enrollTestKey(urls);
  });
  afterAll(async () => db?.$disconnect());
  afterEach(async () => {
    const audit = await db.auditEntry.findMany({ select: { inputs: true, reasoning: true, outcomeDetail: true } });
    expect(JSON.stringify(audit)).not.toContain('CANARY');
    await age();
  });

  it('before the promotion nothing is added on its own: every suggestion is a card', async () => {
    const now = new Date();
    expect(await take(candidate(now), now)).toEqual({ outcome: 'filed' });
    expect(await take(candidate(now, { kind: 'commitment' }), now)).toEqual({ outcome: 'filed' });
    expect(await db.goal.count()).toBe(0);
    expect(await db.entity.count({ where: { kind: 'commitment' } })).toBe(0);
  });

  it('after it: a goal is added directly, with no card, 3 a day at most; a commitment is still a card, 10 a day at most, whatever a rule says', async () => {
    expect(await chatFloorInDatabase(db)).toBe(true);
    await promote([{ pattern: 'goal.propose', dailyCap: 3 }, { pattern: 'world.commitment.from_chat', dailyCap: 10 }]);
    // Yesterday, as the intake's clock: a day whose counters are its own.
    const now = new Date(Date.now() - DAY);
    const goalCards = await db.proposal.count({ where: { action: 'goal.propose' } });
    const commitmentCards = await db.proposal.count({ where: { action: 'world.commitment.from_chat' } });
    const first = candidate(now, { dueOn: '2030-06-01' });
    expect(await take(first, now)).toEqual({ outcome: 'added' });
    const gid = suggestionGoalId(refOf(first));
    const goal = await db.goal.findUniqueOrThrow({ where: { id: gid } });
    expect(goal).toMatchObject({ status: 'proposed', origin: 'flint', owner: 'will', title: first.text, description: first.quote, sourceRef: refOf(first), approvalId: null, tainted: false, successCriteria: [] });
    expect(goal.horizonAt?.toISOString()).toBe('2030-06-01T23:59:00.000Z');
    // Its audit entry, written before the goal: an action Flint took on its own, by ids, the rule that let it, the day he
    // said it, the day read from it, and the digest of what was added (never the words).
    const entry = await db.auditEntry.findFirstOrThrow({ where: { correlationId: refOf(first), kind: 'action' } });
    expect(entry).toMatchObject({
      actor: CANDIDATES_ACTOR, context: 'chat', tier: 'alone', decision: 'act', outcome: 'ok', action: 'goal.propose',
      inputs: { sourceRef: refOf(first), goalId: gid, saidAt: first.sourceAt, dueOn: '2030-06-01', rule: 'policy', policy: 'goal.propose' },
    });
    expect((entry.inputs as { argsDigest: string }).argsDigest).toBe(digestOf({ goalId: gid, title: first.text, quote: first.quote, dueOn: '2030-06-01', saidAt: first.sourceAt, sourceRef: refOf(first) }));
    expect(await take(first, now)).toEqual({ outcome: 'known' });
    expect(await take(candidate(now), now)).toEqual({ outcome: 'added' });
    expect(await take(candidate(now), now)).toEqual({ outcome: 'added' });
    const fourth = candidate(now);
    await expect(take(fourth, now)).rejects.toMatchObject({ status: 429, message: 'Flint reached today’s limit of suggestions from chat.' });
    expect(await db.goal.count({ where: { sourceRef: refOf(fourth) } })).toBe(0);
    expect(await db.auditEntry.count({ where: { correlationId: refOf(fourth) } })).toBe(0);
    expect(await db.goal.count({ where: { origin: 'flint', status: 'proposed' } })).toBe(3);
    // No card was filed for any goal, and none is active: only Will starts a goal.
    expect(await db.proposal.count({ where: { action: 'goal.propose' } })).toBe(goalCards);
    expect(await db.goal.count({ where: { status: { not: 'proposed' } } })).toBe(0);
    // A commitment under the very rule he signed for it: a card each time, and nothing in the world model. The
    // database has no floor under a commitment, so nothing adds one without his signature on its card.
    for (let i = 0; i < 10; i++) expect(await take(candidate(now, { kind: 'commitment' }), now)).toEqual({ outcome: 'filed' });
    const eleventh = candidate(now, { kind: 'commitment' });
    await expect(take(eleventh, now)).rejects.toMatchObject({ status: 429 });
    expect(await db.entity.count({ where: { kind: 'commitment' } })).toBe(0);
    expect(await db.proposal.count({ where: { action: 'world.commitment.from_chat' } })).toBe(commitmentCards + 10);
    // Each is on record as a card filed, never as something Flint did on its own.
    expect(await db.auditEntry.count({ where: { action: 'world.commitment.from_chat', kind: 'action' } })).toBe(0);
    // The next day starts again.
    const next = new Date(now.getTime() + DAY);
    expect(await take(candidate(next), next)).toEqual({ outcome: 'added' });
  });

  it('without the database’s guard nothing from chat runs without a card: under the very same signed rule the intake files a card and adds nothing; with it back, it adds', async () => {
    const now = new Date(Date.now() - 2 * DAY);
    const goals = await db.goal.count();
    const g = candidate(now);
    // Rolled back by its own down.sql: what this runtime would meet after a rollback, or a restore of an older backup.
    await withoutChatGoalFloor(urls.owner, async () => {
      expect(await chatFloorInDatabase(db)).toBe(false);
      expect(await take(g, now)).toEqual({ outcome: 'filed' });
      expect(await take(candidate(now, { kind: 'commitment' }), now)).toEqual({ outcome: 'filed' });
    });
    expect(await db.goal.count()).toBe(goals);
    const [card] = await db.$queryRaw<Array<{ status: string; consequential: boolean }>>`SELECT status, consequential FROM "Proposal" WHERE args->>'sourceRef' = ${refOf(g)}`;
    expect(card).toEqual({ status: 'pending', consequential: true });
    expect(await db.auditEntry.count({ where: { correlationId: refOf(g), kind: 'action' } })).toBe(0);
    // The guard is back (a deploy re-applied it): the same rule adds the next one directly.
    expect(await chatFloorInDatabase(db)).toBe(true);
    expect(await take(candidate(now), now)).toEqual({ outcome: 'added' });
  });

  it('the database has the last word: a rule that ended between the decision and the write adds nothing, and the suggestion is filed as a card', async () => {
    await retire();
    // A rule that runs out in a moment. The intake's clock is days behind (as in the tests above), so its own reading
    // still finds the rule live; the database reads the wall clock, and by then the rule is over.
    const ends = new Date(Date.now() + 5_000);
    const args = { rows: [{ pattern: 'goal.propose', tier: 'alone', dailyCap: 3, reason: 'P3 chat promotion table, a test', expiresAt: ends.toISOString() }] };
    const p = await createProposal(db, { kind: 'policy', origin: 'cli', action: 'policy.change', templateId: 'p3c.promotion', args, argsProvenance: { rows: { source: 'template', tainted: false } }, tainted: false, sensitivity: 'ops', destructive: false, consequential: true, ttlMinutes: 60 }, 'will:cli');
    await approveProposal(db, p.id, await key.approve({ subjectId: p.id, action: 'policy.change', argsDigest: p.argsDigest }), undefined, 'test');
    await runInternal(db, p.id, undefined, 'UTC', 'test');
    await new Promise((r) => setTimeout(r, Math.max(0, ends.getTime() - Date.now()) + 300));
    const now = new Date(Date.now() - 4 * DAY);
    const c = candidate(now);
    const errors: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void errors.push(a.map(String).join(' ')));
    try {
      expect(await take(c, now)).toEqual({ outcome: 'filed' });
    } finally {
      spy.mockRestore();
    }
    expect(await db.goal.count({ where: { sourceRef: refOf(c) } })).toBe(0);
    // Nothing of the refused add is left: no audit entry says Flint acted on its own, and the day's rule cap was not used.
    expect(await db.auditEntry.count({ where: { correlationId: refOf(c), kind: 'action' } })).toBe(0);
    expect(await db.auditEntry.findFirstOrThrow({ where: { correlationId: refOf(c) } })).toMatchObject({ kind: 'decision', tier: 'approval', outcome: 'ok' });
    const [card] = await db.$queryRaw<Array<{ status: string; consequential: boolean }>>`SELECT status, consequential FROM "Proposal" WHERE args->>'sourceRef' = ${refOf(c)}`;
    expect(card).toEqual({ status: 'pending', consequential: true });
    // Said once, by the failure's class and SQLSTATE, never its words or the suggestion's.
    expect(errors.filter((l) => l.startsWith('[goals] the database let no suggestion in without a card (')).length).toBe(1);
    expect(errors.join('\n')).toContain('42501');
    expect(errors.join('\n')).not.toContain('CANARY');
    await retire();
  });

  it('a signed rule with a smaller cap stops sooner; one with an invented cap still stops at 3', async () => {
    await retire();
    await promote([{ pattern: 'goal.propose', dailyCap: 2 }]);
    const now = new Date(Date.now() - 5 * DAY);
    expect(await take(candidate(now), now)).toEqual({ outcome: 'added' });
    expect(await take(candidate(now), now)).toEqual({ outcome: 'added' });
    const third = candidate(now);
    await expect(take(third, now)).rejects.toMatchObject({ status: 429 });
    expect(await db.goal.count({ where: { sourceRef: refOf(third) } })).toBe(0);
    await retire();
    await promote([{ pattern: 'goal.propose', dailyCap: 2_147_483_647 }]);
    const later = new Date(Date.now() - 6 * DAY);
    for (let i = 0; i < 3; i++) expect(await take(candidate(later), later)).toEqual({ outcome: 'added' });
    await expect(take(candidate(later), later)).rejects.toMatchObject({ status: 429 });
  });

  it('the day he named is the end of that day wherever Will is, and the database takes it from the real intake: Chicago, Kiritimati (UTC+14) and Pago Pago (UTC-11), under the rule and by card', async () => {
    await retire();
    await promote([{ pattern: 'goal.propose', dailyCap: 3 }]);
    const now = new Date();
    const zones = ['America/Chicago', 'Pacific/Kiritimati', 'Pacific/Pago_Pago'];
    const day = '2030-06-01';
    const horizonOf = async (c: Record<string, unknown>) => (await db.goal.findUniqueOrThrow({ where: { id: suggestionGoalId(refOf(c)) } })).horizonAt?.toISOString();
    // Under the rule: the intake's own arithmetic, the entry's day, and the database's reading of both.
    for (const zone of zones) {
      const c = candidate(now, { dueOn: day });
      expect(await takeCandidate({ db, tz: zone, now: () => now }, c), zone).toEqual({ outcome: 'added' });
      expect(await horizonOf(c), zone).toBe(localWallTime(zone, day, 23, 59).toISOString());
    }
    // By card: filed with no rule in force, signed, and carried out in that zone.
    await retire();
    for (const zone of zones) {
      const c = candidate(now, { dueOn: day });
      expect(await takeCandidate({ db, tz: zone, now: () => now }, c), zone).toEqual({ outcome: 'filed' });
      const [card] = await db.$queryRaw<Array<{ id: string }>>`SELECT id FROM "Proposal" WHERE args->>'sourceRef' = ${refOf(c)}`;
      const waiting = await db.proposal.findUniqueOrThrow({ where: { id: card!.id } });
      await approveProposal(db, waiting.id, await key.approve({ subjectId: waiting.id, action: waiting.action, argsDigest: waiting.argsDigest }), undefined, 'test');
      expect(await runInternal(db, waiting.id, undefined, zone, 'test'), zone).toMatchObject({ goalId: suggestionGoalId(refOf(c)) });
      expect(await horizonOf(c), zone).toBe(localWallTime(zone, day, 23, 59).toISOString());
    }
    expect([localWallTime('Pacific/Kiritimati', day, 23, 59).toISOString(), localWallTime('Pacific/Pago_Pago', day, 23, 59).toISOString()]).toEqual(['2030-06-01T09:59:00.000Z', '2030-06-02T10:59:00.000Z']);
  });

  it('the database counts too: with the runtime’s own counters gone, the seventh goal in 24 hours is not added, and is filed as a card', async () => {
    await retire();
    await promote([{ pattern: 'goal.propose', dailyCap: 3 }]);
    const now = new Date();
    // A runtime whose counters fail it (a bug, a reset): every count it keeps is wiped as it goes.
    const forget = () => withClient(urls.owner, (c) => c.query(`DELETE FROM "ActionCounter" WHERE action LIKE 'goal.propose%'`));
    for (let i = 0; i < 6; i++) {
      await forget();
      expect(await take(candidate(now), now), `goal ${i + 1}`).toEqual({ outcome: 'added' });
    }
    await forget();
    const seventh = candidate(now);
    const errors: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void errors.push(a.map(String).join(' ')));
    try {
      expect(await take(seventh, now)).toEqual({ outcome: 'filed' });
    } finally {
      spy.mockRestore();
    }
    expect(await db.goal.count({ where: { sourceRef: refOf(seventh) } })).toBe(0);
    expect(await db.auditEntry.count({ where: { correlationId: refOf(seventh), kind: 'action' } })).toBe(0);
    expect(errors.filter((l) => l.startsWith('[goals] the database let no suggestion in without a card (')).length).toBe(1);
    // His signature on that card still adds it: the limit is on what lands without him.
    const [card] = await db.$queryRaw<Array<{ id: string }>>`SELECT id FROM "Proposal" WHERE args->>'sourceRef' = ${refOf(seventh)}`;
    const waiting = await db.proposal.findUniqueOrThrow({ where: { id: card!.id } });
    await approveProposal(db, waiting.id, await key.approve({ subjectId: waiting.id, action: waiting.action, argsDigest: waiting.argsDigest }), undefined, 'test');
    await forget();
    expect(await runInternal(db, waiting.id, undefined, 'UTC', 'test')).toMatchObject({ goalId: suggestionGoalId(refOf(seventh)) });
    expect(await db.goal.count({ where: { sourceRef: refOf(seventh), status: 'proposed' } })).toBe(1);
    await retire();
  });

  it('a card filed before the promotion and approved after runs under the rule’s cap, and a rule that forbids stops the intake', async () => {
    const waiting = await db.proposal.findFirstOrThrow({ where: { action: 'goal.propose', status: 'pending' } });
    await approveProposal(db, waiting.id, await key.approve({ subjectId: waiting.id, action: waiting.action, argsDigest: waiting.argsDigest }), undefined, 'test');
    expect(await runInternal(db, waiting.id, undefined, 'UTC', 'test')).toMatchObject({ goalId: (waiting.args as { goalId: string }).goalId });
    await retire();
    const args = { rows: [{ pattern: 'goal.propose', tier: 'forbidden', reason: 'a test', expiresAt: new Date(Date.now() + 30 * DAY).toISOString() }] };
    const p = await createProposal(db, { kind: 'policy', origin: 'cli', action: 'policy.change', args, argsProvenance: { rows: { source: 'will', tainted: false } }, tainted: false, sensitivity: 'ops', destructive: false, consequential: true, ttlMinutes: 60 }, 'will:cli');
    await approveProposal(db, p.id, await key.approve({ subjectId: p.id, action: 'policy.change', argsDigest: p.argsDigest }), undefined, 'test');
    await runInternal(db, p.id, undefined, 'UTC', 'test');
    const now = new Date(Date.now() - 3 * DAY);
    const c = candidate(now);
    await expect(take(c, now)).rejects.toMatchObject({ status: 409 });
    expect(await db.goal.count({ where: { sourceRef: refOf(c) } })).toBe(0);
    expect(await db.auditEntry.findFirstOrThrow({ where: { correlationId: refOf(c) } })).toMatchObject({ decision: 'deny', outcome: 'denied', tier: 'forbidden' });
    // Commitments are not forbidden: with no rule for them now, they are cards again.
    expect(await take(candidate(now, { kind: 'commitment' }), now)).toEqual({ outcome: 'filed' });
  });
});
