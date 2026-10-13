/**
 * Whose approved card it is to claim.
 *
 * A card whose action Flint's own code carries out is claimed by that code and
 * by nothing else: the runtime's own actions through /run, and a job's (a
 * nightly backup, the restore test, the cleanup) by the job, in its own
 * process. The claim route hands such a card to no caller, whoever asks, and
 * nobody but the job reports it done. What a caller may claim is a tool's
 * call: a connected server's (`mcp:server.tool`) or a built-in's. So a
 * connected server that names a tool like one of these actions is never
 * handed Flint's own card, and its own tool's card still runs.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { AUTONOMOUS_ACTIONS } from '@flint/policy';
import { NO_DB, freshDb, type TestUrls } from './db';
import { buildApp, notForCallers } from '../src/app';
import type { RuntimeScope } from '../src/config';
import { createDb, type Db } from '../src/db';
import { cardGate, offerCard } from '../src/backup/nightly';
import { INTERNAL_ACTIONS } from '../src/governance/internal';
import { completeProposal } from '../src/governance/proposals';
import { FakeBus, taskFixture, type TaskFixture } from './tasks/fixture';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const SERVER = 'server-token-0123456789abcdef';
const tokens = [{ name: 'server', sha256: sha(SERVER), scopes: new Set<RuntimeScope>(['events', 'audit', 'proposals', 'world:read', 'ledger', 'counters']) }];

/** Each nightly job's action, with the job that files and runs its card. */
const NIGHTLY: Array<[string, string]> = [
  ['backup.local', 'backup'], ['backup.offsite', 'offsite'], ['restore.drill', 'drill'], ['maintenance.retention', 'retention'],
  ['backup.prune', 'prune'], ['backup.nexus', 'nexus-backup'], ['backup.nexus.offsite', 'nexus-offsite'], ['restore.drill.nexus', 'nexus-drill'],
];

describe('whose card it is, by its action', () => {
  it('every action a job of Flint’s runs on its own, and every one the runtime carries out, is refused a caller: each with a sentence', () => {
    for (const action of AUTONOMOUS_ACTIONS) expect(notForCallers(action), action).toMatch(/^.+ is carried out by (the runtime: use \/run|Flint’s own job)$|^Flint can’t carry this out yet\.$/);
    for (const action of INTERNAL_ACTIONS) expect(notForCallers(action), action).toBe(`${action} is carried out by the runtime: use /run`);
    for (const [action] of NIGHTLY) expect(notForCallers(action), action).toBe(`${action} is carried out by Flint’s own job`);
    // The runtime's own first: what it carries out through /run says so, also when a job may ask for it.
    for (const action of ['world.person.create', 'world.relation.write', 'plan.change', 'task.check_bar']) {
      expect(AUTONOMOUS_ACTIONS.has(action) && INTERNAL_ACTIONS.has(action), action).toBe(true);
      expect(notForCallers(action), action).toBe(`${action} is carried out by the runtime: use /run`);
    }
    // Anything named as a task, an asset or a review, known or not.
    for (const action of ['task.dispatch.nexus_participant', 'review.local', 'asset.made_up', 'task.anything']) expect(notForCallers(action), action).toBe('Flint can’t carry this out yet.');
  });

  it('a tool’s call is a caller’s to claim, whatever the tool is called: a connected server’s, or a built-in’s', () => {
    for (const action of [
      'mcp:backup.local', 'mcp:restore.drill', 'mcp:maintenance.retention', 'mcp:goal.activate', 'mcp:task.check_bar', 'mcp:runtime.world_now', 'mcp:gmail.send_message',
      'remember', 'deep_research', 'ledger_record_prediction',
    ]) expect(notForCallers(action), action).toBeUndefined();
    // A name is one of Flint's own exactly, or it is not: nothing is matched by its beginning or its case.
    for (const action of ['backup.local.extra', 'Backup.Local', 'backup', 'backup.', ' backup.local', 'constructor', 'toString']) expect(notForCallers(action), action).toBeUndefined();
  });
});

describe.skipIf(NO_DB)('the claim route, for a card of Flint’s own', () => {
  let urls: TestUrls;
  let db: Db;
  let fx: TaskFixture;
  let app: ReturnType<typeof buildApp>;
  beforeAll(async () => {
    urls = await freshDb();
    db = createDb(urls.app);
    fx = await taskFixture(urls, db, new FakeBus());
    app = buildApp({ db, config: { tokens, tz: 'UTC', assets: true }, logger: false });
  }, 120_000);
  afterAll(async () => {
    await app?.close();
    await db?.$disconnect();
  });
  const call = (method: 'GET' | 'POST', url: string, body?: unknown) =>
    app.inject({ method, url, ...(body !== undefined ? { payload: JSON.stringify(body) } : {}), headers: { 'content-type': 'application/json', authorization: `Bearer ${SERVER}` } });
  const status = async (id: string) => (await db.proposal.findUniqueOrThrow({ where: { id }, select: { status: true } })).status;
  const trail = async (id: string) => (await db.auditEntry.findMany({ where: { correlationId: id }, select: { kind: true, outcome: true } })).map((e) => `${e.kind}:${e.outcome}`).sort();

  it('a nightly job’s approved card is handed to no caller: it stays approved, nothing is recorded as started, and its own job still claims it and reports it', async () => {
    const now = new Date();
    for (const [action, job] of NIGHTLY) {
      const card = { action, job, templateId: `nightly.${job}` };
      await offerCard(db, card, 'UTC', undefined, now);
      const filed = await db.proposal.findFirstOrThrow({ where: { action, origin: `runtime:${job}`, status: 'pending' } });
      await fx.approve(filed.id);
      const before = await trail(filed.id);

      // A caller with the server's own token asks to claim it, as a server does for a tool it has wired.
      const claim = await call('POST', `/v1/proposals/${filed.id}/claim`, {});
      expect([claim.statusCode, claim.json()], action).toEqual([409, { error: `${action} is carried out by Flint’s own job` }]);
      expect(await status(filed.id), action).toBe('approved');
      // No intent was written, no cap taken: as far as the record goes, nothing was asked.
      expect(await trail(filed.id), action).toEqual(before);
      // Nor can it be reported done from outside while it waits.
      const early = await call('POST', `/v1/proposals/${filed.id}/complete`, { ok: true, result: { anything: 'a caller says' } });
      expect([early.statusCode, early.json().error], action).toEqual([409, `${action} is carried out by Flint’s own job`]);
      expect(await status(filed.id), action).toBe('approved');

      // The job's own gate, in its own process, claims the card Will approved.
      expect(await cardGate(db, card, 'UTC', undefined, new Date()), action).toEqual({ go: true, proposalId: filed.id, why: 'approved by Will' });
      expect(await status(filed.id), action).toBe('executing');
      // While the job runs, a caller still cannot say how it ended.
      const during = await call('POST', `/v1/proposals/${filed.id}/complete`, { ok: true, result: { anything: 'a caller says' } });
      expect(during.statusCode, action).toBe(409);
      expect(await status(filed.id), action).toBe('executing');
      // The job reports its own.
      await completeProposal(db, filed.id, { ok: true, result: { ran: true } }, 'runtime');
      expect(await status(filed.id), action).toBe('executed');
      expect((await db.proposal.findUniqueOrThrow({ where: { id: filed.id }, select: { result: true } })).result, action).toEqual({ ran: true });
    }
  }, 120_000);

  it('a connected server’s tool that carries the same name has a card of its own, which a caller claims and reports as before', async () => {
    for (const action of ['mcp:backup.local', 'mcp:restore.drill', 'mcp:maintenance.retention']) {
      const args = { path: '/tmp/x', k: Math.random() };
      const filed = await fx.file(action, args, { kind: 'tool_call', origin: 'chat:t1', argsProvenance: { path: { source: 'model', tainted: false }, k: { source: 'model', tainted: false } } });
      await fx.approve(filed.id);
      const claim = await call('POST', `/v1/proposals/${filed.id}/claim`, {});
      expect(claim.statusCode, `${action} ${claim.body}`).toBe(200);
      expect(claim.json(), action).toMatchObject({ id: filed.id, action, args });
      expect(await status(filed.id), action).toBe('executing');
      expect((await call('POST', `/v1/proposals/${filed.id}/complete`, { ok: true, result: { value: 'the tool ran' } })).statusCode, action).toBe(200);
      expect(await status(filed.id), action).toBe('executed');
    }
  }, 120_000);
});
