/**
 * What the goal review tests share: goals made the way Will makes them (a card
 * filed from the console, signed with a test key, run by the runtime), items
 * that change the way a sync changes them, and a stand-in for the job bus that
 * keeps what was sent. Synthetic text only: every word a test goal holds
 * carries CANARY, so a test can search a log, a job or an audit entry for it.
 */
import { digestOf } from '@flint/policy';
import { id, withClient, type TestUrls } from '../db';
import { enrollTestKey } from '../sign';
import type { Db } from '../../src/db';
import type { Bus } from '../../src/bus';
import { approveProposal, createProposal } from '../../src/governance/proposals';
import { runInternal } from '../../src/governance/internal';
import { syncOnce } from '../../src/sources/sync';
import type { Source, SourceObservation, SourceRun } from '../../src/sources/types';

export const CANARY = 'Synthetic CANARY-p3review';
export const DAY = 86_400_000;
export const MIN = 60_000;

export interface Sent {
  queue: string;
  data: Record<string, unknown>;
  options: { singletonKey?: string; startAfter?: number; db?: unknown };
}

/**
 * The bus as the goal jobs use it: `send`, kept in order. Like the goal queues
 * (stately), one job may wait per queue and singleton key: a second send for the
 * same key while one waits is the same job (null). `take` is a worker picking
 * the next job up.
 */
export class FakeBus implements Pick<Bus, 'boss'> {
  sent: Sent[] = [];
  private waiting: Sent[] = [];
  boss = {
    send: async (queue: string, data: object | null, options: Sent['options'] = {}) => {
      if (options.singletonKey && this.waiting.some((j) => j.queue === queue && j.options.singletonKey === options.singletonKey)) return null;
      const job = { queue, data: (data ?? {}) as Record<string, unknown>, options };
      this.sent.push(job);
      this.waiting.push(job);
      return `job${this.sent.length}`;
    },
  } as unknown as Bus['boss'];
  /** The next waiting job of a queue, as a worker would take it. */
  take(queue: string): Sent | undefined {
    const i = this.waiting.findIndex((j) => j.queue === queue);
    return i < 0 ? undefined : this.waiting.splice(i, 1)[0];
  }
  of(queue: string): Sent[] {
    return this.sent.filter((j) => j.queue === queue);
  }
  clear(): void {
    this.sent = [];
    this.waiting = [];
  }
}

const runAt = (now: Date): Omit<SourceRun, 'cursor'> => ({ now, signal: new AbortController().signal, fetch: async () => new Response(null, { status: 599 }) });

export async function goalFixture(urls: TestUrls, db: Db) {
  const key = await enrollTestKey(urls);
  const owner = (sql: string, params: unknown[] = []) => withClient(urls.owner, (c) => c.query(sql, params));

  const file = (action: string, args: Record<string, unknown>, over: Record<string, unknown> = {}) =>
    createProposal(db, {
      kind: action === 'plan.change' ? 'plan' : action.startsWith('goal.') ? 'goal' : 'tool_call', origin: 'console', action, args, argsProvenance: { args: { source: 'will', tainted: false } },
      tainted: false, sensitivity: 'personal', destructive: false, consequential: false, ttlMinutes: 60, ...over,
    } as Parameters<typeof createProposal>[1], 'test');
  async function sign(pid: string, decision: 'approve' | 'reject' = 'approve') {
    const p = await db.proposal.findUniqueOrThrow({ where: { id: pid } });
    return key.approve({ subjectId: pid, action: p.action, argsDigest: p.argsDigest, decision });
  }
  async function fileSignRun(action: string, args: Record<string, unknown>, over: Record<string, unknown> = {}) {
    const p = await file(action, args, over);
    await approveProposal(db, p.id, await sign(p.id), undefined, 'test');
    return { id: p.id, result: await runInternal(db, p.id, undefined, 'UTC', 'test') };
  }
  /** Approve and run a card that is already filed (a review's plan card). */
  async function signRun(pid: string) {
    await approveProposal(db, pid, await sign(pid), undefined, 'test');
    return runInternal(db, pid, undefined, 'UTC', 'test');
  }

  // Items change the way a sync changes them: a source Will turned on, read again.
  await fileSignRun('world.source.enable', { source: 'github' }, { sensitivity: 'ops' });
  const observed = new Map<string, SourceObservation>();
  const github: Source = { name: 'github', cadenceMs: 300_000, run: async () => ({ observations: [...observed.values()], metrics: [] }) };
  let clock = Date.now() - 60 * MIN;
  /** A pull request as the GitHub source reports it: its title is a stranger's words (tainted). Returns its entity id. */
  async function pullRequest(n: number, state: 'open' | 'merged' | 'closed' = 'open', title = `${CANARY} PR title ${n}`, over: Record<string, unknown> = {}): Promise<string> {
    const k = `pull_request:github:wpf002/flint#${n}`;
    observed.set(k, {
      type: 'pull_request.state', kind: 'pull_request', key: k, name: title, sensitivity: 'ops', externalId: `pull_request:wpf002/flint#${n}`,
      taintedPaths: ['name', 'state.title'], state: { number: n, state, title, ...over }, ...(state === 'open' ? {} : { status: 'archived' as const }),
    });
    clock += 1_000;
    const s = await syncOnce(db, github, runAt(new Date(clock)), 'UTC');
    if (s.failed) throw new Error(`the test sync failed: ${s.reason ?? ''}`);
    return (await db.entity.findFirstOrThrow({ where: { key: k } })).id;
  }
  /** The latest version row of an item. */
  const latestVersion = (entityId: string) => db.entityVersion.findFirstOrThrow({ where: { entityId }, orderBy: { version: 'desc' } });

  const crit = (cid: string, check: Record<string, unknown> = { kind: 'manual' }) => ({ id: cid, text: `${CANARY} check ${cid}`, check });
  const step = (k: string, over: Record<string, unknown> = {}) => ({ op: 'add', key: k, step: { ordinal: 100 * Number(k.slice(1)), title: `${CANARY} step ${k}`, kind: 'will_task', tier: 'approval', dueAt: null, dependsOn: [], ...over } });
  /** An active goal, signed and run: by default one manual check, no links, no plan, a finish date 60 days out. */
  async function activeGoal(over: Record<string, unknown> = {}): Promise<{ id: string; title: string; args: Record<string, unknown> }> {
    const goalId = id('go').replace(/[^A-Za-z0-9]/g, '');
    const args = {
      goalId, title: `${CANARY} goal ${goalId.slice(-4)}`, description: `${CANARY} why`, horizonAt: new Date(Date.now() + 60 * DAY).toISOString(), reviewCadence: 'P1W',
      successCriteria: [crit('c1')], links: [], plan: null, ...over,
    };
    await fileSignRun('goal.activate', args);
    return { id: goalId, title: args.title as string, args };
  }
  /** A rule Will signed: promote goal.review.local (the trial week is over), or forbid it. */
  async function policy(pattern: string, tier: 'alone' | 'forbidden', dailyCap?: number) {
    const args = { rows: [{ pattern, tier, ...(dailyCap ? { dailyCap } : {}), expiresAt: new Date(Date.now() + 30 * DAY).toISOString() }] };
    return fileSignRun('policy.change', args, { kind: 'policy', sensitivity: 'ops' });
  }
  /** Everything a test may search for a goal's words: job data, audit entries, cards' reasons and errors, health details. */
  async function everythingButGoals(bus: FakeBus): Promise<string> {
    const audits = await db.auditEntry.findMany({ orderBy: { seq: 'desc' }, take: 2000 });
    const cards = await db.proposal.findMany({ select: { reason: true, error: true, argsProvenance: true, templateId: true } });
    const health = await db.healthCheck.findMany({ select: { detail: true } });
    const reviews = await db.goalReview.findMany({ select: { summary: true, diff: true, planner: true, criteria: true, triggerEventId: true } });
    const predictions = await db.prediction.findMany({ where: { domain: 'goals' }, select: { claim: true, resolutionCriteria: true, evidence: true, resolverSpec: true } });
    return JSON.stringify([bus.sent.map((j) => j.data), audits, cards, health, reviews, predictions], (_k, v: unknown) => (typeof v === 'bigint' ? String(v) : v));
  }

  return { key, owner, file, sign, signRun, fileSignRun, pullRequest, latestVersion, crit, step, activeGoal, policy, everythingButGoals, digestOf };
}
export type GoalFixture = Awaited<ReturnType<typeof goalFixture>>;
