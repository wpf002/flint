/**
 * The runtime's HTTP API (plan 3.0.1): loopback only, not in `tailscale serve`.
 * Every route but /health names the one scope it needs; a caller's token grants
 * scopes (config.ts). Bodies over 64 KB are refused with 413, invalid input with
 * 400 (zod), and errors never echo internals: the reply carries a reference, the
 * log the detail.
 */
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z, ZodError } from 'zod';
import { safeName, type WebAuthnRelyingParty } from '@flint/policy';
import type { Config, RuntimeScope } from './config.js';
import type { Db } from './db.js';
import { callerFor, type Caller } from './auth.js';
import { AuditIn, AuditQuery, AuditRefused, appendAudit, listAudit } from './governance/audit.js';
import { claim } from './governance/counters.js';
import {
  activePolicies,
  CompleteProposal,
  CreateProposal,
  Refused,
  approveProposal,
  claimProposal,
  completeProposal,
  createProposal,
  getProposal,
  listProposals,
  rejectProposal,
} from './governance/proposals.js';
import { EmitPrediction, Invalid, emitPrediction } from './ledger/emit.js';
import { INTERNAL_ACTIONS, runInternal } from './governance/internal.js';
import { hasNul } from './jsonsize.js';
import { registerP2Routes } from './routes/p2.js';
import type { Bus } from './bus.js';

declare module 'fastify' {
  interface FastifyRequest {
    caller?: Caller;
  }
}

export const BODY_LIMIT = 64 * 1024;

export { dbRefused } from './dbcodes.js';
import { dbRefused } from './dbcodes.js';
/** The trigger's own words (they name the rule, never a value). */
const dbMessage = (err: unknown) => {
  const m = String((err as { message?: unknown }).message ?? '').match(/message: "([^"]{1,200})"/);
  return m ? m[1] : 'a database rule';
};

/** What the process knows about itself that the database does not (index.ts keeps it). */
export interface RuntimeStatus {
  /** Parts not working: `bus` while pg-boss is not started. */
  problems: Set<string>;
  /** When the bus last started: the health job is overdue 10 minutes after it. */
  busStartedAt: Date | null;
  /** The bus while it runs (pushed events send their triage jobs through it). */
  bus?: Pick<Bus, 'boss'>;
}

/** The health job runs every 5 minutes; twice that without a run means the bus is wedged. */
export const HEALTH_RUN_STALE_MS = 10 * 60_000;

export interface AppDeps {
  db: Db;
  config: Pick<Config, 'tokens' | 'rp' | 'tz'> & Partial<Pick<Config, 'triage' | 'home'>>;
  logger?: boolean;
  status?: RuntimeStatus;
}

const Id = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/) }).strict();

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({
    bodyLimit: BODY_LIMIT,
    logger: deps.logger
      ? { level: 'info', redact: { paths: ['req.headers.authorization', 'req.headers.cookie'], censor: '[redacted]' } }
      : false,
  });
  const { db, config } = deps;
  const rp: WebAuthnRelyingParty | undefined = config.rp;
  // BigInt columns (AuditEntry.seq, BackupRun.bytes) have no JSON form of their own.
  app.setReplySerializer((payload) => JSON.stringify(payload, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)));

  /** Route guard: the caller must hold this scope. */
  const need = (scope: RuntimeScope) => async (req: FastifyRequest, reply: FastifyReply) => {
    const caller = callerFor(req.headers.authorization, config.tokens);
    if (!caller) return reply.code(401).send({ error: 'unauthorized' });
    if (!caller.scopes.has(scope)) return reply.code(403).send({ error: `this token does not have the ${scope} scope` });
    req.caller = caller;
  };
  const actor = (req: FastifyRequest) => `client:${req.caller?.name ?? 'unknown'}`;

  // Postgres refuses U+0000; refuse it here as bad input (400), not as a crash (500).
  app.addHook('preValidation', async (req, reply) => {
    if (req.body !== undefined && hasNul(req.body)) return reply.code(400).send({ error: 'invalid input: contains a NUL character' });
  });

  app.setErrorHandler((err: Error & { statusCode?: number; code?: string }, req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: 'invalid input', issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    if (err instanceof Refused) {
      // What Will reads is the message; why (a verifier's or the engine's words) is logged under a ref.
      if (!err.why) return reply.code(err.status).send({ error: err.message });
      const ref = `ref${Date.now().toString(36)}`;
      req.log.warn({ ref, status: err.status, why: err.why }, 'refused');
      return reply.code(err.status).send({ error: err.message, ref });
    }
    if (err instanceof Invalid || err instanceof AuditRefused) return reply.code(400).send({ error: err.message });
    if (err.statusCode === 413 || err.code === 'FST_ERR_CTP_BODY_TOO_LARGE') return reply.code(413).send({ error: 'body too large' });
    if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500) return reply.code(err.statusCode).send({ error: 'bad request' });
    const ref = `err${Date.now().toString(36)}`;
    req.log.error({ ref, err }, 'request failed');
    return reply.code(500).send({ error: 'internal error', ref });
  });

  // `ok` is the database alone (install-runtime.sh polls it); `degraded` names
  // the parts that are not working, never why.
  app.get('/health', async () => {
    let dbOk = false;
    try {
      await db.$queryRaw`SELECT 1`;
      dbOk = true;
    } catch {
      dbOk = false;
    }
    const degraded = [...(deps.status?.problems ?? [])].sort();
    const since = deps.status?.busStartedAt;
    if (dbOk && since && Date.now() - since.getTime() > HEALTH_RUN_STALE_MS) {
      const last = await db.healthCheck.findFirst({ orderBy: { at: 'desc' }, select: { at: true } }).catch(() => null);
      if (!last || Date.now() - last.at.getTime() > HEALTH_RUN_STALE_MS) degraded.push('health-overdue');
    }
    return { ok: dbOk, db: dbOk ? 'up' : 'down', degraded };
  });

  // ---- audit ------------------------------------------------------------------
  app.post('/v1/audit', { preHandler: need('audit') }, async (req) => {
    const entries = z.array(AuditIn).min(1).max(100).parse(req.body);
    try {
      return { written: await appendAudit(db, entries) };
    } catch (err) {
      // The audit trigger refusing an entry is the caller's input (400), so the
      // server sets that entry aside instead of resending the batch forever.
      if (dbRefused(err)) throw new AuditRefused(`the audit refused an entry: ${dbMessage(err)}`);
      throw err;
    }
  });
  // Read-only chat calls are counted, never rows (plan 3.0.7).
  app.post('/v1/audit/rollup', { preHandler: need('audit') }, async (req) => {
    const Rows = z
      .array(
        z
          .object({
            day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
            action: z.string().min(1).max(200),
            context: z.enum(['chat', 'autonomous', 'console', 'deploy']),
            n: z.number().int().min(1).max(1_000_000),
          })
          .strict(),
      )
      .min(1)
      .max(500);
    // A batch with an id is counted once, however often it is resent (its reply lost).
    const body = z.union([Rows, z.object({ batchId: z.string().regex(/^[0-9a-f]{32}$/), rows: Rows }).strict()]).parse(req.body);
    const rows = Array.isArray(body) ? body : body.rows;
    const batchId = Array.isArray(body) ? undefined : body.batchId;
    // All or nothing: a batch that fails partway is not half counted (and then counted again on retry).
    const counted = await db.$transaction(async (tx) => {
      if (batchId) {
        await tx.auditRollupBatch.deleteMany({ where: { at: { lt: new Date(Date.now() - 7 * 86_400_000) } } });
        const fresh = await tx.auditRollupBatch.createMany({ data: [{ id: batchId }], skipDuplicates: true });
        if (fresh.count === 0) return false;
      }
      for (const r of rows) {
        await tx.auditRollup.upsert({
          where: { day_action_context: { day: r.day, action: r.action, context: r.context } },
          create: { day: r.day, action: r.action, context: r.context, count: r.n },
          update: { count: { increment: r.n } },
        });
      }
      return true;
    });
    return counted ? { counted: rows.length } : { counted: 0, duplicate: true };
  });
  app.get('/v1/audit', { preHandler: need('audit') }, async (req) => {
    return { entries: await listAudit(db, AuditQuery.parse(req.query)) };
  });

  // ---- proposals ----------------------------------------------------------------
  app.post('/v1/proposals', { preHandler: need('proposals') }, async (req, reply) => {
    const created = await createProposal(db, CreateProposal.parse(req.body), actor(req));
    return reply.code(201).send(created);
  });
  app.get('/v1/proposals', { preHandler: need('proposals') }, async (req) => {
    const q = z
      .object({ status: z.enum(['pending', 'approved', 'executing', 'executed', 'failed', 'rejected', 'expired']).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) })
      .strict()
      .parse(req.query);
    return { proposals: await listProposals(db, q.status, q.limit) };
  });
  app.get('/v1/proposals/:id', { preHandler: need('proposals') }, async (req, reply) => {
    const { id } = Id.parse(req.params);
    const p = await getProposal(db, id);
    if (!p) return reply.code(404).send({ error: 'no such proposal' });
    return { proposal: p };
  });
  // The live ActionPolicy rows, for the server's chat gate (it cannot read the database).
  app.get('/v1/policies', { preHandler: need('proposals') }, async () => {
    return { policies: await activePolicies(db) };
  });
  app.post('/v1/proposals/:id/approve', { preHandler: need('proposals') }, async (req) => {
    const { id } = Id.parse(req.params);
    const { approvalId } = z.object({ approvalId: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/) }).strict().parse(req.body);
    await approveProposal(db, id, approvalId, rp, actor(req));
    return { ok: true };
  });
  app.post('/v1/proposals/:id/reject', { preHandler: need('proposals') }, async (req) => {
    const { id } = Id.parse(req.params);
    const body = z.object({ approvalId: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/).optional(), error: z.string().max(2000).optional() }).strict().parse(req.body ?? {});
    await rejectProposal(db, id, { ...(body.approvalId ? { approvalId: body.approvalId } : {}), ...(body.error ? { error: body.error } : {}) }, rp, actor(req));
    return { ok: true };
  });
  app.post('/v1/proposals/:id/claim', { preHandler: need('proposals') }, async (req) => {
    const { id } = Id.parse(req.params);
    const p = await db.proposal.findUnique({ where: { id }, select: { action: true } });
    if (p && INTERNAL_ACTIONS.has(p.action)) throw new Refused(409, `${p.action} is carried out by the runtime: use /run`);
    return claimProposal(db, id, rp, config.tz, actor(req));
  });
  // Approved actions the runtime carries out itself (turning a source on, a signed policy change).
  app.post('/v1/proposals/:id/run', { preHandler: need('proposals') }, async (req) => {
    const { id } = Id.parse(req.params);
    return runInternal(db, id, rp, config.tz, actor(req));
  });
  // A tool's result can be large (a fetched page): this route takes up to 1 MB and truncates what it stores.
  app.post('/v1/proposals/:id/complete', { preHandler: need('proposals'), bodyLimit: 1024 * 1024 }, async (req) => {
    const { id } = Id.parse(req.params);
    await completeProposal(db, id, CompleteProposal.parse(req.body), actor(req));
    return { ok: true };
  });

  // ---- caps -----------------------------------------------------------------------
  app.post('/v1/counters/claim', { preHandler: need('counters') }, async (req, reply) => {
    const b = z
      .object({ action: z.string().min(1).max(200), limit: z.number().int().min(0).max(100000), period: z.enum(['hour', 'day', 'week']) })
      .strict()
      .parse(req.body);
    const n = await claim(db, b.action, { limit: b.limit, period: b.period }, config.tz);
    if (n === null) return reply.code(429).send({ error: 'cap reached', limit: b.limit });
    return { count: n };
  });

  // ---- world (read) -------------------------------------------------------------------
  // "World now" never carries tainted text: a tainted name is rendered kind#id.
  app.get('/v1/world/now', { preHandler: need('world:read') }, async () => {
    const services = await db.entity.findMany({ where: { kind: 'service', status: 'active' }, orderBy: { key: 'asc' }, take: 100 });
    const counts = await db.entity.groupBy({ by: ['kind', 'status'], _count: { _all: true } });
    return {
      services: services.map((s) => ({ id: s.id, name: safeName(s), health: (s.state as { health?: string }).health ?? 'unknown', lastObservedAt: s.lastObservedAt })),
      counts: counts.map((c) => ({ kind: c.kind, status: c.status, n: c._count._all })),
      // P2: escalations still waiting on Will (an older server ignores the field).
      openEscalations: await db.escalation.count({ where: { status: 'open' } }),
    };
  });
  // Reading one entity returns its tainted fields too, marked, so the reader
  // (chat) can taint its turn (plan 3.0.3). That includes its untrusted text
  // kept outside the world model (P2.5: a calendar title), always tainted.
  app.get('/v1/world/entities/:id', { preHandler: need('world:read') }, async (req, reply) => {
    const { id } = Id.parse(req.params);
    const found = await db.entity.findUnique({ where: { id }, include: { sources: { select: { source: true, lastSyncedAt: true } }, texts: { select: { field: true, text: true } } } });
    if (!found || found.status === 'forgotten') return reply.code(404).send({ error: 'no such entity' });
    const { texts: rows, ...e } = found;
    const texts = Object.fromEntries(rows.map((t) => [t.field, t.text]));
    const taintedPaths = [...e.taintedPaths, ...rows.map((t) => `texts.${t.field}`)];
    return { entity: { ...e, ...(rows.length ? { texts } : {}), taintedPaths }, tainted: taintedPaths.length > 0 };
  });

  // ---- ledger -----------------------------------------------------------------------
  app.post('/v1/ledger/predictions', { preHandler: need('ledger') }, async (req, reply) => {
    const p = await emitPrediction(db, EmitPrediction.parse(req.body), actor(req));
    return reply.code(201).send({ id: p.id, claim: p.claim, resolveBy: p.resolveBy });
  });
  app.get('/v1/ledger/open', { preHandler: need('ledger') }, async (req) => {
    const q = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }).strict().parse(req.query);
    return { predictions: await db.prediction.findMany({ where: { status: 'open' }, orderBy: { resolveBy: 'asc' }, take: q.limit }) };
  });
  app.get('/v1/ledger/calibration', { preHandler: need('ledger') }, async () => {
    const latest = await db.calibrationSnapshot.findFirst({ orderBy: { windowEnd: 'desc' }, select: { windowEnd: true } });
    if (!latest) return { snapshots: [] };
    return { snapshots: await db.calibrationSnapshot.findMany({ where: { windowEnd: latest.windowEnd } }) };
  });

  registerP2Routes(app, { db, config: { triage: config.triage ?? false, tz: config.tz, ...(config.home ? { home: config.home } : {}) }, need, bus: () => deps.status?.bus });

  return app;
}
