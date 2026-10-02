/**
 * The triage worker (Machine plan P2): one applied event at a time.
 *
 *  - Every event ends with a recorded decision and its audit entry: when
 *    triage.rule is forbidden it is a `skipped` decision (critical rules still
 *    decide), never a silent drop.
 *  - The model runs only for the closed judgement list, while
 *    triage.local_model may run (promoted, or in shadow), under its hour cap.
 *  - It yields to chat: while a chat turn runs, the event comes back in 15 s,
 *    at most 40 times; past that it is decided by rules alone
 *    (`fallback:deferred`) and the health check says triage is degraded.
 *  - Job data is {eventId} (and the deferral count): nothing else.
 */
import { z } from 'zod';
import { CODE_TABLE, resolveTier, runsInShadow, type Tier } from '@flint/policy';
import type { Config } from '../config.js';
import type { Db } from '../db.js';
import { QUEUES, type Bus } from '../bus.js';
import { activePolicies } from '../governance/proposals.js';
import { claim } from '../governance/counters.js';
import { recordDecision } from '../surface/record.js';
import { fileAction } from '../surface/act.js';
import { loadFacts } from './facts.js';
import { judge } from './judge.js';
import { chatLoad, type Load } from './load.js';
import { decide } from './triage.js';
import type { CodeRuleContext } from './critical.js';
import type { DbRule } from './rules.js';
import { quietLog } from './verdict.js';

export const TriageJob = z.object({ eventId: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/), deferrals: z.number().int().min(1).max(1000).optional() }).strict();
export type TriageJob = z.infer<typeof TriageJob>;

export const DEFER_SECONDS = 15;
export const MAX_DEFERRALS = 40;

export interface WorkerDeps {
  db: Db;
  config: Pick<Config, 'tz' | 'server' | 'ollama'>;
  bus: Pick<Bus, 'boss'>;
  /** For the tests: the load check and the model's fetch. */
  load?: () => Promise<Load>;
  fetch?: typeof fetch;
  now?: () => Date;
}

export type Outcome = 'decided' | 'exists' | 'gone' | 'deferred';

/** May an autonomous action run: promoted, or in shadow. Shadow when not promoted. */
function standing(action: string, tainted: boolean, policies: Awaited<ReturnType<typeof activePolicies>>, now: Date): { may: boolean; shadow: boolean; tier: Tier } {
  const t = resolveTier(action, { context: 'autonomous', tainted, policies, now });
  return { may: t.tier === 'alone' || (t.tier === 'approval' && runsInShadow(action)), shadow: t.tier !== 'alone', tier: t.tier };
}

/** The non-critical code rules' reads. */
export function codeContext(db: Db): CodeRuleContext {
  return {
    async routeErrorsIn10m(at) {
      return db.sourceEvent.count({ where: { source: 'server', type: 'route.error', occurredAt: { gt: new Date(at.getTime() - 10 * 60_000), lte: at } } });
    },
    async burstEscalatedThisOutage(at) {
      // The outage began at the latest route error with none in the 30 minutes before it.
      const start = await db.$queryRaw<Array<{ t: Date | null }>>`
        SELECT max(e."occurredAt") AS t FROM "SourceEvent" e
        WHERE e.source = 'server' AND e.type = 'route.error' AND e."occurredAt" <= ${at}
          AND NOT EXISTS (SELECT 1 FROM "SourceEvent" p WHERE p.source = 'server' AND p.type = 'route.error'
                          AND p."occurredAt" < e."occurredAt" AND p."occurredAt" >= e."occurredAt" - interval '30 minutes')`;
      const since = start[0]?.t ?? at;
      const n = await db.$queryRaw<Array<{ n: bigint }>>`
        SELECT count(*) AS n FROM "TriageDecision" d JOIN "SourceEvent" e ON e.id = d."sourceEventId"
        WHERE d."decidedBy" = 'code:route.error_burst' AND d.action = 'escalate' AND e."occurredAt" >= ${since}`;
      return Number(n[0]?.n ?? 0) > 0;
    },
  };
}

export async function processEvent(job: TriageJob, d: WorkerDeps): Promise<Outcome> {
  const { db, config } = d;
  if (await db.triageDecision.findUnique({ where: { sourceEventId: job.eventId }, select: { id: true } })) return 'exists';
  const f = await loadFacts(db, job.eventId);
  if (!f) return 'gone';
  const now = d.now?.() ?? new Date();
  const policies = await activePolicies(db, now);
  const rules = standing('triage.rule', f.tainted, policies, now);
  const model = standing('triage.local_model', f.tainted, policies, now);
  const cap = CODE_TABLE['triage.local_model']?.cap ?? { limit: 120, period: 'hour' as const };
  const dbRules: DbRule[] = rules.may ? await db.triageRule.findMany({ where: { enabled: true } }) : [];
  const ollama = config.ollama;
  let decision = await decide(f, {
    rules: dbRules,
    code: codeContext(db),
    rulesAllowed: rules.may,
    ...(ollama && model.may
      ? {
          model: ollama.model,
          judge: (facts) =>
            judge(facts, {
              ollama,
              load: d.load ?? chatLoad(config.server),
              claim: async () => (await claim(db, 'triage.local_model', cap, config.tz)) !== null,
              ...(d.fetch ? { fetch: d.fetch } : {}),
            }),
        }
      : { noJudge: model.may ? ('unavailable' as const) : ('skipped' as const) }),
  });
  if ('defer' in decision) {
    const n = (job.deferrals ?? 0) + 1;
    if (n <= MAX_DEFERRALS) {
      // Stately on the event id: this one is running, so one more may wait.
      await d.bus.boss.send(QUEUES.triage, { eventId: job.eventId, deferrals: n }, { singletonKey: job.eventId, startAfter: DEFER_SECONDS });
      return 'deferred';
    }
    // Chat has been busy for ten minutes: decide without the model, and say so.
    await db.healthCheck.create({ data: { component: 'triage.deferral', status: 'degraded', detail: `an event waited ${MAX_DEFERRALS} times for chat to finish; decided by rules alone`, at: now } });
    decision = quietLog('fallback:deferred');
  }
  const byModel = decision.decidedBy.startsWith('model:') || /^fallback:(invalid|unavailable|capped|deferred)$/.test(decision.decidedBy);
  const filed = await fileAction(db, f, decision, { alone: rules.tier === 'alone', now });
  const recorded = await recordDecision(db, f, decision, { shadow: rules.shadow, tier: byModel ? model.tier : rules.tier, tz: config.tz, now, policies, bus: d.bus, ...filed });
  return recorded ? 'decided' : 'exists';
}
