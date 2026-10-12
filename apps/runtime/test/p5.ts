/**
 * What P5's database tests share: raw SQL as each role on flint_test, a card
 * Will signed (filed, approved and left executing, as the runtime's executor
 * would have it mid-run), and the rows an asset, a task and a review need.
 * Synthetic text only: every title, spec, output and review word made here
 * carries CANARY, which must never come back in an error or in history.
 */
import pg from 'pg';
import { digestOf } from '@flint/policy';
import { withClient, pgConfig, pgError, id, HEX, type TestUrls } from './db';

export type Q = (sql: string, params?: unknown[]) => Promise<pg.QueryResult>;
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const CANARY = 'Synthetic CANARY-p5';

export interface CardOptions {
  /** Default: policy for asset.enable and review.enforce, task for anything else. */
  kind?: string;
  origin?: string;
  templateId?: string | null;
  tainted?: boolean;
  sensitivity?: string;
  /** The card's own-touch mark (default: true for a policy card and for a policy change, as the runtime files them). */
  consequential?: boolean;
  destructive?: boolean;
  estCostUsd?: number | null;
  /** How long the card lives (its expiresAt). */
  life?: string;
  /** How far the card gets. Default executing: approved, then claimed, never completed. */
  stage?: 'pending' | 'approved' | 'executing' | 'executed';
  /** The credential that signs (default: the kit's live one). */
  credential?: string;
  /** The key fields the approval card showed (the signed payload's `fields`). */
  fields?: Record<string, unknown>;
  /** A digest to file the card under instead of its args' own. */
  digest?: string;
  /** The card's id (default: a new one). */
  id?: string;
}

export interface AssetRow {
  id: string;
  kind: string;
  externalRef: string;
  name: string;
  capabilities: string[];
  dispatchAction: string;
  spends: boolean;
  /** The world item it stands for, if any (part of what its card signs). */
  entityId?: string | null;
}

export interface TaskRow {
  id: string;
  assetId: string;
  goalId: string | null;
  stepKey: string | null;
  title: string;
  spec: unknown;
  acceptance: unknown;
  entityIds: string[];
  origin: string;
  sensitivity: string;
  tainted: boolean;
  estCostUsd: number;
  dueAt: string | null;
}

export interface ReviewFields {
  id: string;
  subjectType: string | null;
  subjectId: string | null;
  subjectDigest: string | null;
  engine: string | null;
  models: unknown;
  findings: unknown;
  reasonCodes: string[] | null;
  attack: string | null;
  defense: string | null;
  verdict: string | null;
  verdictReason: string | null;
  confidence: number | null;
  agreed: boolean | null;
  shadow: boolean | null;
  tainted: boolean | null;
  sensitivity: string | null;
  costUsd: number | null;
  modelMs: number | null;
}

const ACTION_OF: Record<string, string> = { local_reviewer: 'review.local', trident_panel: 'review.trident_panel', hive_bot: 'hive.dispatch_job' };
export const SPEC = { template: 'summarize_items', params: { items: ['en1', 'en2'], note: `${CANARY} spec` } };
export const BAR = [{ id: 'a1', text: `${CANARY} bar`, check: { type: 'deterministic', op: 'refs_known' } }];
export const OUTPUT = { headline: `${CANARY} output`, points: [] };

export async function p5Kit(urls: TestUrls) {
  const as = (url: string): Q => (sql, params) => withClient(url, (c) => c.query(sql, params));
  const app = as(urls.app);
  const owner = as(urls.owner);
  const approver = as(urls.approver);
  const credentialId = id('cred');
  await approver(`INSERT INTO "ApprovalCredential" (id, "credentialId", factor, "publicKey", label, "enrolledVia") VALUES ($1, $2, 'webauthn', '\\x00', 'test key', 'enroll_code')`, [id(), credentialId]);

  const client = async (url = urls.app) => {
    const c = new pg.Client(pgConfig(url));
    await c.connect();
    return c;
  };
  const on = (c: pg.Client): Q => (sql, params) => c.query(sql, params);
  /** One transaction as flint_app (READ COMMITTED unless `iso` says otherwise), optionally as an actor. */
  async function inTx<T>(fn: (q: Q) => Promise<T>, o: { iso?: string; commit?: boolean; actor?: string; url?: string } = {}): Promise<T> {
    return withClient(o.url ?? urls.app, async (c) => {
      await c.query(o.iso ? `BEGIN ISOLATION LEVEL ${o.iso}` : 'BEGIN');
      try {
        if (o.actor) await c.query(`SELECT set_config('flint.actor', $1, true)`, [o.actor]);
        const r = await fn(on(c));
        await c.query(o.commit === false ? 'ROLLBACK' : 'COMMIT');
        return r;
      } catch (e) {
        await c.query('ROLLBACK').catch(() => {});
        throw e;
      }
    });
  }
  const code = async (p: Promise<unknown>) => (await pgError(p)).code;
  /** 'ok', or the SQLSTATE it was refused with. */
  const outcome = (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string; message?: string }) => e.code ?? e.message);
  const one = async (sql: string, params?: unknown[], q: Q = app) => (await q(sql, params)).rows[0];

  /**
   * Will's signed approval of a card, as the server records it after verifying his signature. `set` sends more
   * columns than the server ever does (column -> SQL), `as` is the role that writes the row, and `id` its id.
   */
  async function approval(pid: string, action: string, digest: string, o: { credential?: string; fields?: Record<string, unknown>; decision?: 'approve' | 'reject'; subjectType?: string; set?: Record<string, string>; as?: Q; id?: string } = {}): Promise<string> {
    const aid = o.id ?? id('appr');
    const expires = (await owner(`SELECT to_char((now() + interval '10 minutes') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS t`)).rows[0].t as string;
    const payload = {
      v: 1, subjectType: o.subjectType ?? 'proposal', subjectId: pid, decision: o.decision ?? 'approve', action, argsDigest: digest,
      ...(o.fields ? { fields: o.fields } : {}), expiresAt: expires, nonce: HEX('0').slice(0, 32),
    };
    const more = Object.entries(o.set ?? {});
    await (o.as ?? approver)(
      `INSERT INTO "Approval" (id, "subjectType", "subjectId", decision, payload, challenge, "credentialId", signature, "expiresAt"${more.map(([c]) => `, "${c}"`).join('')})
       VALUES ($1, $2, $3, $4, $5, $6, $7, '\\x01', $8${more.map(([, v]) => `, ${v}`).join('')})`,
      [aid, payload.subjectType, pid, payload.decision, JSON.stringify(payload), HEX('c'), o.credential ?? credentialId, expires],
    );
    return aid;
  }

  /** File a card (pending). Its digest is its args' own, unless said otherwise. */
  async function file(action: string, args: Record<string, unknown>, o: CardOptions = {}, q: Q = app): Promise<{ pid: string; digest: string }> {
    const pid = o.id ?? id('prop');
    const digest = o.digest ?? digestOf(args);
    const policy = action === 'asset.enable' || action === 'review.enforce';
    const origin = o.origin ?? 'console';
    await q(
      `INSERT INTO "Proposal" (id, kind, origin, action, "templateId", args, "argsDigest", "argsProvenance", tainted, sensitivity, destructive, consequential, "estCostUsd", "expiresAt")
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, '{}', $8, $9, $10, $11, $12, now() + $13::interval)`,
      [pid, o.kind ?? (policy ? 'policy' : 'task'), origin, action, o.templateId === undefined ? (origin.startsWith('runtime:') ? 'p5.test' : null) : o.templateId,
        JSON.stringify(args), digest, o.tainted ?? false, o.sensitivity ?? 'ops', o.destructive ?? false, o.consequential ?? (policy || action === 'policy.change'), o.estCostUsd ?? null, o.life ?? '1 hour'],
    );
    return { pid, digest };
  }
  /** Will signs a filed card, and it goes as far as `stage` says (default: executing, never completed). */
  async function sign(filed: { pid: string; digest: string }, action: string, o: CardOptions = {}): Promise<{ pid: string; aid: string }> {
    const { pid, digest } = filed;
    const aid = await approval(pid, action, digest, { ...(o.credential ? { credential: o.credential } : {}), ...(o.fields ? { fields: o.fields } : {}) });
    if (o.stage === 'pending') return { pid, aid };
    await app(`UPDATE "Proposal" SET status = 'approved', "approvalId" = $2 WHERE id = $1`, [pid, aid]);
    if (o.stage === 'approved') return { pid, aid };
    await app(`UPDATE "Proposal" SET status = 'executing' WHERE id = $1`, [pid]);
    if (o.stage === 'executed') await finish(pid);
    return { pid, aid };
  }
  /** A card as far as `stage` says (default: signed and executing, never completed). */
  const card = async (action: string, args: Record<string, unknown>, o: CardOptions = {}) => sign(await file(action, args, o), action, o);
  /**
   * One transaction as the owner with one of Proposal's triggers set aside in it: what `fn` files there is as a
   * card could have been filed were that rule not there. One transaction, so a run that is killed half way
   * leaves the trigger on.
   */
  const without = <T>(trigger: string, fn: (q: Q) => Promise<T>): Promise<T> => inTx(async (q) => {
    const name = trigger.replace(/[^A-Za-z0-9_]/g, '');
    await q(`ALTER TABLE "Proposal" DISABLE TRIGGER "${name}"`);
    const r = await fn(q);
    await q(`ALTER TABLE "Proposal" ENABLE TRIGGER "${name}"`);
    return r;
  }, { url: urls.owner });
  const finish = (pid: string) => app(`UPDATE "Proposal" SET status = 'executed', "executedAt" = now() WHERE id = $1`, [pid]);
  const used = async (aid: string) => (await owner(`SELECT count(*)::int AS n FROM "TaskApprovalUse" WHERE "approvalId" = $1`, [aid])).rows[0].n as number;

  // ---- Assets ----
  /** An asset as the code registry would write it: off. A local worker unless said otherwise. Extra columns are sent as given. */
  async function asset(over: Partial<AssetRow> & Record<string, unknown> = {}, q: Q = app): Promise<AssetRow> {
    const kind = (over.kind as string | undefined) ?? 'local_worker';
    const a: Record<string, unknown> = {
      id: id('as'), kind, externalRef: `test:${id('ref')}`, name: 'Synthetic Asset', capabilities: ['sort_items', 'summarize_items'],
      dispatchAction: ACTION_OF[kind] ?? `task.dispatch.${kind}`, spends: kind === 'nexus_participant' || kind === 'trident_panel', ...over,
    };
    const cols = Object.keys(a);
    await q(`INSERT INTO "Asset" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, cols.map((c) => a[c]));
    return a as unknown as AssetRow;
  }
  /** What an asset.enable card signs: exactly what the asset is. */
  const enableArgs = (a: AssetRow, over: Record<string, unknown> = {}) => ({
    assetId: a.id, kind: a.kind, externalRef: a.externalRef, name: a.name, capabilities: a.capabilities, dispatchAction: a.dispatchAction, spends: a.spends,
    entityId: a.entityId ?? null, ...over,
  });
  const switchOn = (q: Q, assetId: string, aid: string | null) => q(`UPDATE "Asset" SET enabled = true, "approvalId" = $2 WHERE id = $1`, [assetId, aid]);
  const switchOff = (q: Q, assetId: string) => q(`UPDATE "Asset" SET enabled = false WHERE id = $1`, [assetId]);
  /** Turn an asset on under its own signed card, in one transaction; the card then completes, as the executor's would. */
  async function turnOn(a: AssetRow): Promise<{ pid: string; aid: string }> {
    const c = await card('asset.enable', enableArgs(a));
    await switchOn(app, a.id, c.aid);
    await finish(c.pid);
    return c;
  }
  /** An asset that is there and on. */
  async function onAsset(over: Partial<AssetRow> = {}): Promise<AssetRow> {
    const a = await asset(over);
    await turnOn(a);
    return a;
  }
  /** A local reviewer that is on: a review is taken only while one is. */
  const reviewer = () => onAsset({ kind: 'local_reviewer', capabilities: ['review'] });

  // ---- Tasks ----
  /** A task as the runtime would write it: proposed. Column by column, so a test can send what the runtime never would. */
  async function task(assetId: string, over: Record<string, unknown> = {}, q: Q = app): Promise<TaskRow> {
    const t: Record<string, unknown> = {
      id: id('ta'), assetId, goalId: null, stepKey: null, title: `${CANARY} title`, spec: SPEC, acceptance: BAR, entityIds: [], origin: 'will', sensitivity: 'ops',
      tainted: false, estCostUsd: 0, dueAt: null, ...over,
    };
    const cols = Object.keys(t);
    const json = new Set(['spec', 'acceptance', 'barEvidence']);
    await q(
      `INSERT INTO "Task" (${cols.map((c) => `"${c}"`).join(', ')}, "updatedAt") VALUES (${cols.map((c, i) => `$${i + 1}${json.has(c) ? '::jsonb' : ''}`).join(', ')}, now())`,
      cols.map((c) => (json.has(c) && t[c] !== null ? JSON.stringify(t[c]) : t[c])),
    );
    return t as unknown as TaskRow;
  }
  /** What a dispatch card signs: the whole task. Money as whole micro-dollars. */
  const dispatchArgs = (t: TaskRow, assetKind: string, over: Record<string, unknown> = {}) => ({
    taskId: t.id, assetId: t.assetId, assetKind, title: t.title, spec: t.spec, acceptance: t.acceptance, goalId: t.goalId, stepKey: t.stepKey, dueAt: t.dueAt,
    sensitivity: t.sensitivity, tainted: t.tainted, estCostMicros: Math.round(t.estCostUsd * 1_000_000), ...over,
  });
  /**
   * The forecast a dispatch records: an open assets prediction that the task meets its bar, from the tasks writer,
   * carrying the rule that says whose it is to settle (`taskId`: this task's). Without a task it carries no rule,
   * unless `resolverSpec` gives one.
   */
  async function forecast(over: Record<string, unknown> = {}, q: Q = app): Promise<string> {
    const v: Record<string, unknown> = {
      id: id('pd'), claim: 'task_meets_bar {task: task#000000}', probability: 0.5, method: 'base_rate', domain: 'assets', type: 'task_meets_bar',
      resolver: 'auto_world', resolveIn: '7 days', createdBy: 'runtime:tasks', ...over,
    };
    const spec = 'resolverSpec' in v ? v.resolverSpec : v.taskId ? { taskId: v.taskId, rule: 'task_meets_bar' } : null;
    await q(
      `INSERT INTO "Prediction" (id, claim, kind, probability, method, domain, type, evidence, "resolutionCriteria", resolver, "resolverSpec", "resolveBy", "createdBy")
       VALUES ($1, $2, 'binary', $3, $4, $5, $6, '[]', 'The task is accepted.', $7, $8::jsonb, now() + $9::interval, $10)`,
      [v.id, v.claim, v.probability, v.method, v.domain, v.type, v.resolver, spec === null ? null : JSON.stringify(spec), v.resolveIn, v.createdBy],
    );
    return v.id as string;
  }
  const queue = (q: Q, taskId: string, aid: string | null, predictionId: string | null) =>
    q(`UPDATE "Task" SET status = 'queued', "dispatchApprovalId" = $2, "predictionId" = $3 WHERE id = $1`, [taskId, aid, predictionId]);
  /** Dispatch a task under its own signed card, with its forecast, in one transaction; the card then completes. */
  async function dispatch(t: TaskRow, a: AssetRow, o: CardOptions = {}): Promise<{ pid: string; aid: string; predictionId: string }> {
    const c = await card(a.dispatchAction, dispatchArgs(t, a.kind), { sensitivity: t.sensitivity, tainted: t.tainted, ...(a.spends ? { kind: 'spend', estCostUsd: t.estCostUsd } : {}), ...o });
    const predictionId = await forecast({ taskId: t.id });
    await queue(app, t.id, c.aid, predictionId);
    await finish(c.pid);
    return { ...c, predictionId };
  }
  const setStatus = (q: Q, taskId: string, status: string, extra = '', params: unknown[] = []) =>
    q(`UPDATE "Task" SET status = $2${extra} WHERE id = $1`, [taskId, status, ...params]);
  /** The digest the database takes for an output: its own sha256 over the body as it stores it. `json` is the body's JSON text. */
  const digestIn = async (json: string | null) => (await owner(`SELECT encode(sha256(convert_to(($1::jsonb)::text, 'UTF8')), 'hex') AS d`, [json])).rows[0].d as string | null;
  const outputSha = (await digestIn(JSON.stringify(OUTPUT)))!;
  /** The digest of the kit's own OUTPUT (the body every taskAt hands in). */
  const outputDigest = () => outputSha;
  /** Write a task's output. Its digest is computed by the database in the same statement, as a writer's is, unless one is given. */
  const putOutput = (q: Q, taskId: string, body: unknown = OUTPUT, sha: string | null = null) =>
    q(`INSERT INTO "TaskOutput" ("taskId", body, sha256) VALUES ($1, $2::jsonb, coalesce($3, encode(sha256(convert_to(($2::jsonb)::text, 'UTF8')), 'hex')))`, [taskId, JSON.stringify(body), sha]);
  /** The successful check (or override) a task's acceptance names: an action entry, outcome ok, correlated with the task. */
  async function proof(taskId: string, over: { action?: string; outcome?: string; kind?: string; correlationId?: string } = {}): Promise<string> {
    const aid = id('au');
    await app(
      `INSERT INTO "AuditEntry" (id, actor, context, kind, action, inputs, outcome, "correlationId") VALUES ($1, 'runtime:tasks', 'autonomous', $2, $3, $4::jsonb, $5, $6)`,
      [aid, over.kind ?? 'action', over.action ?? 'task.check_bar', JSON.stringify({ taskId }), over.outcome ?? 'ok', over.correlationId ?? `task:${taskId}`],
    );
    return aid;
  }
  /**
   * A dispatched task taken as far as `to`: out (dispatched), with its output handed in (submitted), being checked
   * (checking), or checked (its bar set, by rule unless said otherwise).
   */
  async function taskAt(to: 'queued' | 'dispatched' | 'submitted' | 'checking' | 'checked', a: AssetRow, over: Record<string, unknown> = {}, bar: { met?: boolean; by?: string } = {}): Promise<TaskRow> {
    const t = await task(a.id, over);
    await dispatch(t, a);
    if (to === 'queued') return t;
    await setStatus(app, t.id, 'dispatched');
    if (to === 'dispatched') return t;
    await inTx(async (q) => {
      await putOutput(q, t.id);
      await setStatus(q, t.id, 'submitted', `, "outputRef" = $3, "outputSummary" = $4`, [`out:${outputDigest().slice(0, 12)}`, `${CANARY} summary`]);
    });
    if (to === 'submitted') return t;
    await setStatus(app, t.id, 'checking');
    if (to === 'checking') return t;
    await app(`UPDATE "Task" SET "metBar" = $2, "barCheckedBy" = $3, "barEvidence" = $4::jsonb WHERE id = $1`,
      [t.id, bar.met ?? true, bar.by ?? 'flint:rule', JSON.stringify([{ id: 'a1', met: bar.met ?? true, by: 'rule', note: `${CANARY} evidence` }])]);
    return t;
  }
  /** What an accept card signs: the task, the output it accepts, and that it met its bar. */
  async function acceptArgs(taskId: string, over: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const t = await one(`SELECT "outputRef" FROM "Task" WHERE id = $1`, [taskId]);
    return { taskId, outputRef: t?.outputRef ?? null, metBar: true, ...over };
  }
  /**
   * Say a task ended that long ago. The database stamps a task's end itself and nobody may change it, so
   * only its owner, with the guard set aside for the one statement, can: a test's stand-in for time passing.
   */
  const endedAgo = (taskId: string, interval = '25 hours') => owner(`DO $$ BEGIN
    ALTER TABLE "Task" DISABLE TRIGGER "Task_guard";
    UPDATE "Task" SET "completedAt" = now() - interval '${interval.replace(/[^a-z0-9 ]/gi, '')}' WHERE id = '${taskId.replace(/[^A-Za-z0-9_-]/g, '')}';
    ALTER TABLE "Task" ENABLE TRIGGER "Task_guard";
  END $$`);
  /** Accept a checked task on Will's signed accept card, with its proof. Returns the proof's id. */
  async function accept(taskId: string): Promise<string> {
    const c = await card('task.check_bar', await acceptArgs(taskId), { origin: 'runtime:tasks' });
    const au = await proof(taskId);
    await setStatus(app, taskId, 'accepted', `, "acceptedAuditId" = $3`, [au]);
    await finish(c.pid);
    return au;
  }

  // ---- Reviews ----
  const reviewFields = (over: Partial<ReviewFields> = {}): ReviewFields => ({
    id: id('rv'), subjectType: 'proposal', subjectId: null, subjectDigest: null, engine: 'local_adj', models: { attacker: 'ollama:test', defender: 'ollama:test', judge: 'ollama:test' },
    findings: [], reasonCodes: ['none'], attack: `${CANARY} attack`, defense: `${CANARY} defense`, verdict: 'proceed', verdictReason: `${CANARY} reason`, confidence: 0.6,
    agreed: true, shadow: true, tainted: false, sensitivity: 'ops', costUsd: null, modelMs: 1200, ...over,
  });
  /** A review, column by column (extra columns are sent as given). */
  async function review(over: Partial<ReviewFields> & Record<string, unknown> = {}, q: Q = app): Promise<string> {
    const r = { ...reviewFields(), ...over } as Record<string, unknown>;
    const cols = Object.keys(r);
    const json = new Set(['models', 'findings']);
    await q(
      `INSERT INTO "Review" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map((c, i) => `$${i + 1}${json.has(c) ? '::jsonb' : ''}`).join(', ')})`,
      cols.map((c) => (json.has(c) && r[c] !== null ? JSON.stringify(r[c]) : r[c])),
    );
    return r.id as string;
  }
  /** A review of a card as it waits (by its args' digest, as tainted and as sensitive as the card), attached to it. */
  async function reviewed(pid: string, over: Partial<ReviewFields> & Record<string, unknown> = {}, attach = true): Promise<string> {
    const p = await one(`SELECT "argsDigest", tainted, sensitivity FROM "Proposal" WHERE id = $1`, [pid]);
    const rid = await review({ subjectId: pid, subjectDigest: p.argsDigest, tainted: p.tainted, sensitivity: p.sensitivity, ...over });
    if (attach) await app(`UPDATE "Proposal" SET "reviewId" = $2 WHERE id = $1`, [pid, rid]);
    return rid;
  }
  const approve = (q: Q, pid: string, aid: string) => q(`UPDATE "Proposal" SET status = 'approved', "approvalId" = $2 WHERE id = $1`, [pid, aid]);
  const setGate = (q: Q, enforced: boolean, aid: string | null) => q(`UPDATE "ReviewGate" SET enforced = $1, "approvalId" = $2 WHERE id = 'proposal'`, [enforced, aid]);
  const gate = async () => (await one(`SELECT enforced, "approvalId" FROM "ReviewGate" WHERE id = 'proposal'`)) as { enforced: boolean; approvalId: string | null };
  /** Require reviews (or stop requiring them) under a signed review.enforce card; the card then completes. */
  async function enforce(enforced: boolean): Promise<{ pid: string; aid: string }> {
    const c = await card('review.enforce', { gate: 'proposal', enforced });
    await setGate(app, enforced, c.aid);
    await finish(c.pid);
    return c;
  }

  // ---- A goal with a plan (P3's own cards and guards) ----
  const planStep = (key: string, kind: string) => ({ op: 'add', key, step: { ordinal: Number(key.slice(1)), title: `Synthetic step ${key}`, kind, tier: 'approval', dueAt: null, dependsOn: [] as string[] } });
  /** An active goal whose first plan has these steps (key -> kind), under one signed goal.activate card. */
  async function goalWithPlan(steps: Record<string, string>): Promise<{ gid: string; plan: string; steps: Record<string, string> }> {
    const gid = id('go');
    const criteria = [{ id: 'c1', text: 'Synthetic check', check: { kind: 'manual' } }];
    await app(`INSERT INTO "Goal" (id, title, owner, origin, "successCriteria", "updatedAt") VALUES ($1, 'Synthetic goal', 'will', 'will', $2::jsonb, now())`, [gid, JSON.stringify(criteria)]);
    const go = await card('goal.activate', {
      goalId: gid, owner: 'will', origin: 'will', sensitivity: 'personal', tainted: false, nexusProjectId: null, title: 'Synthetic goal', description: '', successCriteria: criteria,
      horizonAt: null, reviewCadence: 'P1W', links: [], plan: { ops: Object.entries(steps).map(([key, kind]) => planStep(key, kind)) },
    }, { kind: 'goal', sensitivity: 'personal' });
    const plan = id('pl');
    const ids: Record<string, string> = {};
    await inTx(async (q) => {
      await q(`INSERT INTO "Plan" (id, "goalId", version, "createdBy") VALUES ($1, $2, 1, 'will')`, [plan, gid]);
      for (const [key, kind] of Object.entries(steps)) {
        ids[key] = id('ps');
        await q(`INSERT INTO "PlanStep" (id, "planId", key, ordinal, title, kind) VALUES ($1, $2, $3, $4, $5, $6)`, [ids[key], plan, key, Number(key.slice(1)), `Synthetic step ${key}`, kind]);
      }
      await q(`UPDATE "Plan" SET status = 'active', "approvalId" = $2 WHERE id = $1`, [plan, go.aid]);
      await q(`UPDATE "Goal" SET status = 'active', "approvalId" = $2, "nextReviewAt" = now() + interval '7 days' WHERE id = $1`, [gid, go.aid]);
    });
    await finish(go.pid);
    return { gid, plan, steps: ids };
  }

  // ---- The world, and a forget ----
  async function entity(kind = 'repo'): Promise<string> {
    const eid = id('en');
    await app(`INSERT INTO "Entity" (id, kind, key, name, state, "stateHash", "lastObservedAt", "updatedAt") VALUES ($1, $2, $3, 'synthetic', '{}', $4, now(), now())`, [eid, kind, `${kind}:test:${eid}`, HEX('d')]);
    return eid;
  }
  /** Will forgets an entity (a signed forget), through the database's own procedure. */
  async function forget(entityId: string): Promise<void> {
    const aid = await approval(entityId, 'world.forget', HEX('a'), { subjectType: 'forget' });
    await app(`SELECT forget_entity($1, $2)`, [entityId, aid]);
  }

  return {
    urls, app, owner, approver, credentialId, client, on, inTx, code, outcome, one, approval, file, sign, card, without, finish, used,
    asset, enableArgs, switchOn, switchOff, turnOn, onAsset, reviewer,
    task, dispatchArgs, forecast, queue, dispatch, setStatus, digestIn, outputDigest, putOutput, proof, taskAt, acceptArgs, endedAgo, accept,
    reviewFields, review, reviewed, approve, setGate, gate, enforce, planStep, goalWithPlan, entity, forget,
  };
}
export type P5Kit = Awaited<ReturnType<typeof p5Kit>>;

export interface Refusal {
  code: string | undefined;
  message: string;
  detail: string | undefined;
  /** Its message, detail, hint and context together: what a log line or Postgres's own log would hold. */
  text: string;
}
/** A refusal, which must never carry a task's or a review's words. */
export async function refusal(p: Promise<unknown>): Promise<Refusal> {
  const e = (await pgError(p)) as { code?: string; message: string; detail?: string; hint?: string; where?: string };
  const text = `${e.message} ${e.detail ?? ''} ${e.hint ?? ''} ${e.where ?? ''}`;
  if (text.includes('CANARY')) throw new Error(`a refusal carried the row's words: ${e.code} ${e.message.replace(/CANARY.*/s, 'CANARY…')}`);
  return { code: e.code, message: e.message, detail: e.detail, text };
}
