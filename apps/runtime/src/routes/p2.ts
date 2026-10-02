/**
 * The runtime's P2 routes (Machine plan P2). Two audiences:
 *
 *  - The server and its console (scope `events`, which the runtime-mcp token
 *    never holds): the events it pushes, the lanes in full (the model's
 *    reasoning included, rendered as text under its tainted banner), Will's
 *    labels, acknowledgements and dismissals (each written with its audit
 *    entry in one transaction), and the health report.
 *  - The model, through the runtime connector (scope `world:read`): read-only
 *    projections of ids, enums, numbers, entity refs and template titles, each
 *    row with its own taint mark. Never the model's reasoning, never an
 *    entity's name. Acknowledging is the console's alone.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { DecisionExplained, entityRef, EscalationsOpen, FEEDBACK, InboxPage, LANES, ServerEventBatch, TriageRecent, type ServerEvent } from '@flint/policy';
import type { Config, RuntimeScope } from '../config.js';
import type { Db } from '../db.js';
import type { Bus } from '../bus.js';
import { appendAudit } from '../governance/audit.js';
import { Refused } from '../governance/proposals.js';
import { markProcessed, recordEvent, triageEnqueue } from '../events/record.js';
import { triageEligible } from '../triage/facts.js';
import { fieldFreeTitle } from '../templates/escalations.js';
import { healthReport } from '../health/checks.js';

export interface P2Deps {
  db: Db;
  config: Pick<Config, 'triage'>;
  need: (scope: RuntimeScope) => (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
  /** The bus, once it has started: events pushed before it are triaged by reconcile. */
  bus: () => Pick<Bus, 'boss'> | undefined;
}

const Id = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/) }).strict();
const Empty = z.union([z.object({}).strict(), z.undefined(), z.null()]);

/** The entity a decision is about: its sync's version, or a raised event's payload.entityId. */
async function entitiesOf(db: Db, events: ReadonlyArray<{ id: string; payload: unknown }>) {
  const versions = await db.entityVersion.findMany({ where: { sourceEventId: { in: events.map((e) => e.id) } }, select: { sourceEventId: true, entity: { select: { id: true, kind: true, name: true, status: true } } } });
  const byEvent = new Map(versions.map((v) => [v.sourceEventId!, v.entity]));
  const raised = events.flatMap((e) => {
    const id = (e.payload as { entityId?: unknown } | null)?.entityId;
    return !byEvent.has(e.id) && typeof id === 'string' ? [[e.id, id] as const] : [];
  });
  if (raised.length) {
    const found = new Map((await db.entity.findMany({ where: { id: { in: raised.map(([, id]) => id) } }, select: { id: true, kind: true, name: true, status: true } })).map((e) => [e.id, e]));
    for (const [ev, id] of raised) if (found.has(id)) byEvent.set(ev, found.get(id)!);
  }
  // A forgotten entity is no entity.
  for (const [k, e] of byEvent) if (e.status === 'forgotten') byEvent.delete(k);
  return byEvent;
}

/** The answer, checked against the contract on the way out: a row that does not fit is a bug, never a leak. */
function out<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  return schema.parse(value);
}

export function registerP2Routes(app: FastifyInstance, d: P2Deps): void {
  const { db, need } = d;

  // ---- the server's events --------------------------------------------------------------
  app.post('/v1/events', { preHandler: need('events') }, async (req) => {
    const batch = ServerEventBatch.parse(req.body);
    const bus = d.config.triage ? d.bus() : undefined;
    const enqueue = bus ? triageEnqueue(bus as Bus) : undefined;
    let accepted = 0;
    let duplicates = 0;
    for (const e of batch.events) {
      const { id, type, at, ...rest } = e as ServerEvent & Record<string, unknown>;
      const now = new Date();
      // The server's id is the event's identity: a resent batch adds nothing.
      const added = await db.$transaction(async (tx) => {
        const eventId = await recordEvent(tx, {
          source: 'server', sourceRef: id, type, occurredAt: new Date(Math.min(Date.parse(at), now.getTime())),
          sensitivity: type === 'spend.threshold' ? 'financial' : 'ops', tainted: false, payload: rest,
        }, now);
        if (!eventId) return false;
        await markProcessed(tx, eventId, 'applied', now);
        if (enqueue && triageEligible('server', type, 'applied')) await enqueue(tx, eventId);
        return true;
      });
      if (added) accepted++;
      else duplicates++;
    }
    return { accepted, duplicates };
  });

  // ---- the console: the lanes, in full --------------------------------------------------
  app.get('/v1/inbox', { preHandler: need('events') }, async (req) => {
    const q = z.object({ lane: z.enum(LANES), before: z.string().datetime({ offset: true }).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }).strict().parse(req.query);
    const rows = await db.triageDecision.findMany({
      where: { lane: q.lane, ...(q.before ? { createdAt: { lt: new Date(q.before) } } : {}) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
      include: { escalation: true },
    });
    const page = rows.slice(0, q.limit);
    const events = new Map((await db.sourceEvent.findMany({ where: { id: { in: page.map((r) => r.sourceEventId) } }, select: { id: true, source: true, type: true, payload: true } })).map((e) => [e.id, e]));
    const entities = await entitiesOf(db, [...events.values()]);
    return out(InboxPage, {
      items: page.map((r) => {
        const ev = events.get(r.sourceEventId);
        const e = entities.get(r.sourceEventId);
        const x = r.escalation;
        return {
          id: r.id, at: r.createdAt.toISOString(), lane: r.lane, action: r.action, decidedBy: r.decidedBy, ruleName: r.ruleName, relevance: r.relevance, reasonCode: r.reasonCode,
          source: ev?.source ?? 'unknown', eventType: ev?.type ?? 'unknown',
          entity: e ? { ref: entityRef(e.kind, e.id), kind: e.kind, name: Array.from(e.name).slice(0, 300).join('') } : null,
          reasoning: r.reasoning, feedback: r.feedback, tainted: r.tainted, sensitivity: r.sensitivity,
          escalation: x
            ? { id: x.id, templateId: x.templateId, title: x.title ?? fieldFreeTitle(x.templateId), body: x.body, status: x.status, channels: x.channels, tainted: x.tainted, createdAt: x.createdAt.toISOString() }
            : null,
        };
      }),
      next: rows.length > q.limit ? page[page.length - 1]!.createdAt.toISOString() : null,
    });
  });

  // Will's label: on the decision, and (one label) whether its escalation was useful.
  app.post('/v1/inbox/:id/feedback', { preHandler: need('events') }, async (req) => {
    const { id } = Id.parse(req.params);
    const { feedback } = z.object({ feedback: z.enum(FEEDBACK) }).strict().parse(req.body);
    await db.$transaction(async (tx) => {
      const decision = await tx.triageDecision.findUnique({ where: { id }, include: { escalation: { select: { id: true } } } });
      if (!decision) throw new Refused(404, 'no such decision');
      const at = new Date();
      await tx.triageDecision.update({ where: { id }, data: { feedback, feedbackAt: at } });
      if (decision.escalation) await tx.escalation.update({ where: { id: decision.escalation.id }, data: { useful: feedback !== 'should_be_quiet' } });
      await appendAudit(tx, [{
        actor: 'will:console', context: 'console', kind: 'action', action: 'triage.feedback', outcome: 'ok', correlationId: `${id}.feedback`, tainted: false,
        inputs: { decisionId: id, feedback, ...(decision.escalation ? { escalationId: decision.escalation.id } : {}) },
      }], at);
    });
    return { ok: true };
  });

  for (const verb of ['ack', 'dismiss'] as const) {
    app.post(`/v1/escalations/:id/${verb}`, { preHandler: need('events') }, async (req) => {
      const { id } = Id.parse(req.params);
      Empty.parse(req.body);
      await db.$transaction(async (tx) => {
        const e = await tx.escalation.findUnique({ where: { id }, select: { status: true } });
        if (!e) throw new Refused(404, 'no such escalation');
        const from = verb === 'ack' ? ['open'] : ['open', 'acked'];
        if (!from.includes(e.status)) throw new Refused(409, `the escalation is ${e.status}`);
        const at = new Date();
        await tx.escalation.update({ where: { id }, data: verb === 'ack' ? { status: 'acked', ackedAt: at } : { status: 'dismissed' } });
        // Its own correlation id: an acknowledgement is never the proof that something was done ("acted").
        await appendAudit(tx, [{
          actor: 'will:console', context: 'console', kind: 'action', action: `escalation.${verb}`, outcome: 'ok', correlationId: `${id}.${verb}`, tainted: false,
          inputs: { escalationId: id, from: e.status },
        }], at);
      });
      return { ok: true };
    });
  }

  app.get('/v1/health/report', { preHandler: need('events') }, async () => healthReport(db, d.config));

  // ---- the model's projections (the runtime connector) ---------------------------------
  const Limit = z.object({ limit: z.coerce.number().int().min(1).max(20).default(10) }).strict();

  app.get('/v1/triage/recent', { preHandler: need('world:read') }, async (req) => {
    const { limit } = Limit.parse(req.query);
    const total = await db.triageDecision.count();
    const rows = await db.triageDecision.findMany({ orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit, include: { escalation: { select: { id: true } } } });
    const events = new Map((await db.sourceEvent.findMany({ where: { id: { in: rows.map((r) => r.sourceEventId) } }, select: { id: true, source: true, type: true, payload: true } })).map((e) => [e.id, e]));
    const entities = await entitiesOf(db, [...events.values()]);
    return out(TriageRecent, {
      decisions: rows.map((r) => {
        const e = entities.get(r.sourceEventId);
        return {
          id: r.id, at: r.createdAt.toISOString(), lane: r.lane, action: r.action, reasonCode: r.reasonCode,
          source: events.get(r.sourceEventId)?.source ?? 'unknown', eventType: events.get(r.sourceEventId)?.type ?? 'unknown',
          entity: e ? entityRef(e.kind, e.id) : null, escalationId: r.escalation?.id ?? null, tainted: r.tainted,
        };
      }),
      ...(total > rows.length ? { more: total - rows.length } : {}),
    });
  });

  app.get('/v1/escalations/open', { preHandler: need('world:read') }, async (req) => {
    const { limit } = Limit.parse(req.query);
    const where = { status: 'open' };
    const total = await db.escalation.count({ where });
    const rows = await db.escalation.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit });
    return out(EscalationsOpen, {
      escalations: rows.map((x) => ({
        id: x.id, at: x.createdAt.toISOString(), templateId: x.templateId,
        // A tainted escalation's title is its template's field-free one.
        title: !x.tainted && x.title ? x.title : fieldFreeTitle(x.templateId),
        status: x.status, decisionId: x.triageDecisionId, tainted: x.tainted,
      })),
      ...(total > rows.length ? { more: total - rows.length } : {}),
    });
  });

  app.get('/v1/triage/decisions/:id/explain', { preHandler: need('world:read') }, async (req, reply) => {
    const { id } = Id.parse(req.params);
    const r = await db.triageDecision.findUnique({ where: { id }, include: { escalation: true } });
    if (!r) return reply.code(404).send({ error: 'no such decision' });
    const ev = await db.sourceEvent.findUnique({ where: { id: r.sourceEventId }, select: { id: true, source: true, type: true, payload: true } });
    const e = ev ? (await entitiesOf(db, [ev])).get(ev.id) : undefined;
    const x = r.escalation;
    const fields = x && !x.contentPurgedAt ? Object.fromEntries(Object.entries((x.fields ?? {}) as Record<string, unknown>).filter(([, v]) => v === null || typeof v === 'number' || typeof v === 'boolean' || (typeof v === 'string' && v.length <= 120))) : {};
    return out(DecisionExplained, {
      id: r.id, at: r.createdAt.toISOString(), decidedBy: r.decidedBy, ruleName: r.ruleName, critical: r.critical, action: r.action, lane: r.lane, relevance: r.relevance, reasonCode: r.reasonCode,
      source: ev?.source ?? 'unknown', eventType: ev?.type ?? 'unknown', entity: e ? entityRef(e.kind, e.id) : null,
      escalation: x ? { id: x.id, templateId: x.templateId, fields, predictionId: x.predictionId } : null,
      tainted: r.tainted,
    });
  });
}
