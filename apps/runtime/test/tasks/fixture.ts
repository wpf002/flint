/**
 * What the task tests share: Will's side (a test key that signs for real, so
 * every card goes through the same triggers a card of his does), the GitHub
 * source turned on and a CI run read the way a sync reads it, the CI watcher
 * turned on by its own signed card, and a stand-in for the job bus that keeps
 * what was sent. Synthetic text only: any free text a test plants carries
 * CANARY, so a test can search a log, a job or an audit entry for it.
 */
import { HEX, id, withClient, type TestUrls } from '../db';
import { enrollTestKey } from '../sign';
import { FakeBus } from '../goals/fixture';
import type { Db } from '../../src/db';
import { approveProposal, createProposal } from '../../src/governance/proposals';
import { runInternal } from '../../src/governance/internal';
import { syncOnce } from '../../src/sources/sync';
import type { Source, SourceObservation, SourceRun } from '../../src/sources/types';
import { CI_WATCHER } from '../../src/assets/registry';
import { fileEnable } from '../../src/assets/service';
import { runTaskCard, type TaskCardDeps } from '../../src/tasks/card';
import { createTask } from '../../src/tasks/service';
import { runTaskJob } from '../../src/tasks/run';
import { checkTaskJob } from '../../src/tasks/check';

export { FakeBus };
export const CANARY = 'Synthetic CANARY-p5tasks';
export const DAY = 86_400_000;
export const SHA = 'abc1234def5678900000000000000000000000aa';

const runAt = (now: Date): Omit<SourceRun, 'cursor'> => ({ now, signal: new AbortController().signal, fetch: async () => new Response(null, { status: 599 }) });
/** A New Task form's key. */
export const draft = (): string => id('d').replace(/[^A-Za-z0-9]/g, '').padEnd(16, '0').slice(0, 24);

export async function taskFixture(urls: TestUrls, db: Db, bus = new FakeBus(), o: { source?: boolean } = {}) {
  const key = await enrollTestKey(urls);
  const owner = (sql: string, params: unknown[] = []) => withClient(urls.owner, (c) => c.query(sql, params));

  async function sign(pid: string, decision: 'approve' | 'reject' = 'approve', fields?: Record<string, string | number | boolean | null>) {
    const p = await db.proposal.findUniqueOrThrow({ where: { id: pid } });
    return key.approve({ subjectId: pid, action: p.action, argsDigest: p.argsDigest, decision, ...(fields ? { fields } : {}) });
  }
  /** Will signs a card that is filed (with the key fields its card showed, when given). */
  const approve = async (pid: string, fields?: Record<string, string | number | boolean | null>) => approveProposal(db, pid, await sign(pid, 'approve', fields), undefined, 'test');
  /** Will signs it and the runtime carries it out, as the console's Approve does. */
  async function signRun(pid: string, deps: TaskCardDeps = { assets: true, bus }) {
    await approve(pid);
    return runInternal(db, pid, undefined, 'UTC', 'test', undefined, deps);
  }
  /** The same for a card runInternal does not take (a paid dispatch): straight to the task executor. */
  async function signRunCard(pid: string, deps: TaskCardDeps = { assets: true, bus }) {
    await approve(pid);
    return runTaskCard(db, pid, undefined, 'UTC', 'test', deps);
  }
  const file = (action: string, args: Record<string, unknown>, over: Record<string, unknown> = {}) =>
    createProposal(db, {
      kind: 'task', origin: 'console', action, args, argsProvenance: {}, tainted: false, sensitivity: 'ops', destructive: false, consequential: false, ttlMinutes: 60, ...over,
    } as Parameters<typeof createProposal>[1], 'test');

  /** The GitHub source, turned on by its own card: the CI watcher reads the runs it keeps. */
  async function sourceOn(): Promise<void> {
    const enable = await file('world.source.enable', { source: 'github' }, { kind: 'tool_call' });
    await signRun(enable.id);
  }
  if (o.source !== false) await sourceOn();
  const observed = new Map<string, SourceObservation>();
  const github: Source = { name: 'github', cadenceMs: 300_000, run: async () => ({ observations: [...observed.values()], metrics: [] }) };
  let clock = Date.now() - 3_600_000;
  /** A repo's latest CI run as the GitHub source reports it. Returns its entity id. */
  async function ciRun(repo: string, state: { status?: 'queued' | 'in_progress' | 'completed'; conclusion?: string | null; sha?: string } = {}): Promise<string> {
    const k = `ci_run:github:${repo}:latest`;
    observed.set(k, {
      type: 'ci_run.state', kind: 'ci_run', key: k, name: `${repo} CI`, sensitivity: 'ops', externalId: `ci_run:${repo}:latest`,
      state: { workflow: 'ci', status: state.status ?? 'in_progress', conclusion: state.conclusion ?? null, sha: state.sha ?? SHA },
    });
    clock += 1_000;
    const s = await syncOnce(db, github, runAt(new Date(clock)), 'UTC');
    if (s.failed) throw new Error(`the test sync failed: ${s.reason ?? ''}`);
    return (await db.entity.findFirstOrThrow({ where: { key: k } })).id;
  }

  /** An item written straight into the world model (a test's own: no source reads it). Returns its id. */
  async function entity(kind: string, state: Record<string, unknown> = {}, over: { name?: string; taintedPaths?: string[]; sensitivity?: string } = {}): Promise<string> {
    const eid = id('en');
    await db.entity.create({ data: { id: eid, kind, key: `${kind}:test:${eid}`, name: over.name ?? 'synthetic', state: state as object, stateHash: HEX('d'), taintedPaths: over.taintedPaths ?? [], sensitivity: over.sensitivity ?? 'ops', lastObservedAt: new Date() } });
    return eid;
  }
  /** Someone from Will's calendar (a person exists only with that source's row). Returns the item's id. */
  async function person(): Promise<string> {
    const eid = id('en');
    await withClient(urls.owner, async (c) => {
      await c.query('BEGIN');
      await c.query(`INSERT INTO "Entity" (id, kind, key, name, state, "stateHash", sensitivity, "lastObservedAt", "updatedAt") VALUES ($1, 'person', $2, 'Synthetic Person', '{}', $3, 'personal', now(), now())`, [eid, `person:test:${eid}`, HEX('d')]);
      await c.query(`INSERT INTO "EntitySource" (id, "entityId", source, "externalId", "accountOwner", "lastSyncedAt") VALUES ($1, $2, 'google_calendar', $3, 'will', now())`, [id('es'), eid, `person:${eid}`]);
      await c.query('COMMIT');
    });
    return eid;
  }
  /** Will forgets an item (a signed forget), through the database's own procedure. */
  async function forget(entityId: string): Promise<void> {
    const aid = await key.approve({ subjectType: 'forget', subjectId: entityId, action: 'world.forget', argsDigest: HEX('a') });
    await withClient(urls.app, (c) => c.query(`SELECT forget_entity($1, $2)`, [entityId, aid]));
  }

  /** An asset, turned on by Will's signed card (once). */
  async function assetOn(assetId: string): Promise<void> {
    if ((await db.asset.findUnique({ where: { id: assetId } }))?.enabled) return;
    await signRun((await fileEnable(db, assetId)).proposalId);
  }
  /** The CI watcher, turned on by Will's signed card (once). */
  const watcherOn = (): Promise<void> => assetOn(CI_WATCHER.id);
  /** A new watch task for a run, with its dispatch card filed. */
  async function newTask(item: string, over: Record<string, unknown> = {}) {
    return createTask(db, { draftKey: draft(), template: 'watch_ci', params: { item }, goalId: null, dueAt: null, ownCheck: null, ...over } as Parameters<typeof createTask>[1]);
  }
  /** A task Will dispatched: its card signed and run. */
  async function dispatched(item: string, over: Record<string, unknown> = {}) {
    const t = await newTask(item, over);
    await signRun(t.proposalId);
    return t;
  }
  /** A task run and checked: its run finished as `conclusion`, its bar checked. Returns the task's id. */
  async function checked(repo: string, conclusion: 'success' | 'failure' = 'success'): Promise<string> {
    const item = await ciRun(repo, { status: 'completed', conclusion });
    const t = await dispatched(item);
    await runTaskJob({ db, bus }, { taskId: t.id });
    await checkTaskJob({ db }, { taskId: t.id });
    return t.id;
  }
  const task = (taskId: string) => db.task.findUniqueOrThrow({ where: { id: taskId } });
  /**
   * Say a task ended that many hours ago. The database stamps a task's end itself and nobody may change it, so
   * only its owner, with the guard set aside in the same statement, can: a test's stand-in for time passing.
   */
  const endedAgo = (taskId: string, hours: number) => owner(`DO $$ BEGIN
    ALTER TABLE "Task" DISABLE TRIGGER "Task_guard";
    UPDATE "Task" SET "completedAt" = now() - interval '${Math.round(hours)} hours' WHERE id = '${taskId.replace(/[^A-Za-z0-9]/g, '')}';
    ALTER TABLE "Task" ENABLE TRIGGER "Task_guard";
  END $$`);
  /** The card of an action for a task, newest first. */
  const cardFor = (action: string, taskId: string) => db.proposal.findFirst({ where: { action, args: { path: ['taskId'], equals: taskId } }, orderBy: { createdAt: 'desc' } });
  /** A rule Will signed: promote an action, or forbid it. */
  async function policy(pattern: string, tier: 'alone' | 'forbidden', scope?: Record<string, unknown>) {
    const args = { rows: [{ pattern, tier, ...(scope ? { scope } : {}), expiresAt: new Date(Date.now() + 30 * DAY).toISOString() }] };
    const p = await file('policy.change', args, { kind: 'policy', consequential: true });
    return signRun(p.id);
  }
  /** Everything a test may search for a task's words: job data, audit entries, cards' reasons, errors and results, health details. */
  async function everythingButTasks(): Promise<string> {
    const audits = await db.auditEntry.findMany({ orderBy: { seq: 'desc' }, take: 3000 });
    const cards = await db.proposal.findMany({ select: { reason: true, error: true, result: true, argsProvenance: true, templateId: true } });
    const health = await db.healthCheck.findMany({ select: { detail: true } });
    const predictions = await db.prediction.findMany({ where: { domain: 'assets' }, select: { claim: true, resolutionCriteria: true, evidence: true, resolverSpec: true } });
    const resolutions = await db.resolution.findMany({ select: { evidence: true } });
    return JSON.stringify([bus.sent.map((j) => j.data), audits, cards, health, predictions, resolutions], (_k, v: unknown) => (typeof v === 'bigint' ? String(v) : v));
  }
  return { key, bus, owner, sign, approve, signRun, signRunCard, file, sourceOn, ciRun, entity, person, forget, assetOn, watcherOn, newTask, dispatched, checked, task, endedAgo, cardFor, policy, everythingButTasks };
}
export type TaskFixture = Awaited<ReturnType<typeof taskFixture>>;
