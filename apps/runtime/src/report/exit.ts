/**
 * P2's exit report (Machine plan P2, the eight exit criteria), measured from
 * the database as it stands: GET /v1/p2/report and `pnpm --filter
 * @flint/runtime p2-report`. Each criterion says pass, fail, or null (not
 * enough data yet, or checked by hand), with the numbers behind it.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../config.js';
import type { Db } from '../db.js';
import { DEPLOY_WINDOW_MS } from '../health/checks.js';
import { uptime } from '../health/instance.js';
import { MEASUREMENTS } from '../triage/facts.js';
import { hasLoosePrediction, phrase } from '../templates/escalations.js';
import { percentile, POLLED } from '../rollup.js';

export interface Criterion {
  n: number;
  name: string;
  pass: boolean | null;
  detail: string;
  values: Record<string, number | string | boolean | null>;
}

const DAY = 86_400_000;

export async function p2Report(db: Db, config: Pick<Config, 'tz' | 'home'>, now = new Date()): Promise<{ at: string; criteria: Criterion[] }> {
  const since = new Date(now.getTime() - 14 * DAY);
  const out: Criterion[] = [];

  // 1. Uptime over 14 days, deploy windows excluded.
  const beats = await db.runtimeInstance.findMany({ where: { lastBeatAt: { gt: since } }, select: { startedAt: true, lastBeatAt: true } });
  const deploys = await db.sourceEvent.findMany({ where: { source: 'deploy', occurredAt: { gt: since } }, select: { occurredAt: true } });
  const first = beats.reduce<Date | null>((m, b) => (!m || b.startedAt < m ? b.startedAt : m), null);
  const from = first && first > since ? first : since;
  const up = beats.length ? uptime(beats, from, now, deploys.map((d) => ({ start: new Date(d.occurredAt.getTime() - DEPLOY_WINDOW_MS), end: d.occurredAt }))) : null;
  const days = (now.getTime() - from.getTime()) / DAY;
  out.push({ n: 1, name: 'uptime ≥ 99% over 14 days', pass: up === null ? null : up >= 0.99 && days >= 13.9 ? true : up < 0.99 ? false : null, detail: up === null ? 'no heartbeat yet' : `${(up * 100).toFixed(2)}% over ${days.toFixed(1)} days`, values: { uptime: up, days: Math.round(days * 10) / 10 } });

  // 2. Nothing lost: every eligible event decided, every event terminal.
  const [undecided] = await db.$queryRaw<Array<{ n: bigint }>>`
    SELECT count(*) AS n FROM "SourceEvent" e
    WHERE e.status = 'applied' AND e."receivedAt" > ${since} AND e."receivedAt" < ${new Date(now.getTime() - 10 * 60_000)}
      AND NOT (e.source || ':' || e.type = ANY (${MEASUREMENTS as string[]}::text[]))
      AND NOT EXISTS (SELECT 1 FROM "TriageDecision" d WHERE d."sourceEventId" = e.id)`;
  const open = await db.sourceEvent.count({ where: { status: { in: ['received', 'failed'] }, receivedAt: { gt: since, lt: new Date(now.getTime() - 3_600_000) } } });
  const lost = Number(undecided?.n ?? 0);
  out.push({ n: 2, name: 'nothing lost', pass: lost === 0 && open === 0, detail: `${lost} eligible event(s) with no decision, ${open} not terminal after an hour (one decision per event is a database key)`, values: { undecided: lost, notTerminal: open } });

  // 3. Latency: polled sources, change to world model.
  const lags = await db.$queryRaw<Array<{ s: number }>>`
    SELECT EXTRACT(EPOCH FROM (v."validFrom" - e."occurredAt"))::float8 AS s
    FROM "SourceEvent" e JOIN "EntityVersion" v ON v."sourceEventId" = e.id
    WHERE e.source = ANY (${POLLED}::text[]) AND e."receivedAt" > ${since}`;
  const median = percentile(lags.map((l) => Math.max(0, l.s)), 0.5);
  out.push({ n: 3, name: 'latency median < 5 min', pass: median === null ? null : median < 300, detail: median === null ? 'no polled changes yet' : `median ${Math.round(median)} s over ${lags.length} change(s)`, values: { medianS: median, n: lags.length } });

  // 4. Lanes: relevant ≤ 3/day; precision ≥ 70% over ≥ 20 marked escalations; "should have escalated" ≤ 1/week.
  const relevant = await db.triageDecision.count({ where: { lane: 'relevant', createdAt: { gt: since } } });
  const perDay = relevant / Math.max(1, Math.min(14, days));
  const marked = await db.escalation.findMany({ where: { useful: { not: null } }, select: { useful: true } });
  const precision = marked.length ? marked.filter((m) => m.useful).length / marked.length : null;
  const weeks = await db.$queryRaw<Array<{ week: string; n: bigint }>>`
    SELECT to_char(date_trunc('week', d."feedbackAt" AT TIME ZONE ${config.tz}), 'IYYY-"W"IW') AS week, count(*) AS n
    FROM "TriageDecision" d WHERE d.feedback = 'should_escalate' AND d.action <> 'escalate' GROUP BY 1`;
  const worstWeek = weeks.reduce((m, w) => Math.max(m, Number(w.n)), 0);
  out.push({
    n: 4, name: 'lanes: ≤ 3 relevant a day, precision ≥ 70% (≥ 20 marked), ≤ 1 missed a week',
    pass: perDay > 3 || worstWeek > 1 || (precision !== null && marked.length >= 20 && precision < 0.7) ? false : marked.length < 20 ? null : true,
    detail: `${perDay.toFixed(2)} relevant a day; precision ${precision === null ? 'n/a' : `${Math.round(precision * 100)}%`} over ${marked.length} marked${marked.length < 20 ? ' (needs 20)' : ''}; worst week ${worstWeek} missed`,
    values: { relevantPerDay: Math.round(perDay * 100) / 100, precision, marked: marked.length, worstWeekMissed: worstWeek },
  });

  // 5. Audit: every decision has its entry; no loose probability word in a delivered note.
  const [noAudit] = await db.$queryRaw<Array<{ n: bigint }>>`
    SELECT count(*) AS n FROM "TriageDecision" d
    WHERE NOT EXISTS (SELECT 1 FROM "AuditEntry" a WHERE a."correlationId" = d.id AND a.kind = 'decision')`;
  const delivered = await db.escalation.findMany({ where: { deliveries: { some: { status: 'sent' } }, contentPurgedAt: null }, select: { title: true, body: true, predictionId: true } });
  const predictions = new Map((await db.prediction.findMany({ where: { id: { in: delivered.flatMap((e) => (e.predictionId ? [e.predictionId] : [])) } }, select: { id: true, probability: true, resolveBy: true } })).map((p) => [p.id, p]));
  const loose = delivered.filter((e) => {
    const p = e.predictionId ? predictions.get(e.predictionId) : undefined;
    return hasLoosePrediction(`${e.title ?? ''}\n${e.body ?? ''}`, p?.probability != null ? [phrase(p.probability, p.resolveBy, config.tz)] : []);
  }).length;
  const missing = Number(noAudit?.n ?? 0);
  out.push({ n: 5, name: 'audit: every decision audited, pings content-free, no loose probability words', pass: missing === 0 && loose === 0, detail: `${missing} decision(s) without an audit entry; ${loose} delivered note(s) with a probability not from the ledger; pings carry no content by construction`, values: { unaudited: missing, looseNotes: loose } });

  // 6. Chat unaffected, against the baseline taken before P2.
  const file = join(config.home, '.flint', 'p2-baseline.json');
  const baseline = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as { p95Ms?: number; recallFallbackRate?: number }) : undefined;
  const recent = async (key: string) => {
    const pts = await db.metricPoint.findMany({ where: { seriesKey: key, at: { gt: new Date(now.getTime() - 7 * DAY) } }, select: { value: true } });
    return pts.length ? pts.reduce((a, p) => a + p.value, 0) / pts.length : null;
  };
  const p95 = await recent('p2.chat.p95_ms');
  const fallback = await recent('p2.chat.recall_fallback_rate');
  const ctxDays = await db.metricPoint.count({ where: { seriesKey: 'p2.ctx_tokens.world' } });
  const ok6 = baseline?.p95Ms && p95 !== null && baseline.recallFallbackRate !== undefined && fallback !== null ? p95 < baseline.p95Ms * 1.1 && fallback <= baseline.recallFallbackRate + 0.01 : null;
  out.push({
    n: 6, name: 'chat unaffected: p95 < baseline + 10%, recall fallback ≤ baseline + 1 pt, context tokens per day',
    pass: ok6, detail: baseline ? `p95 ${p95 === null ? 'n/a' : Math.round(p95)} ms (baseline ${baseline.p95Ms}); fallback ${fallback === null ? 'n/a' : `${(fallback * 100).toFixed(1)}%`} (baseline ${baseline.recallFallbackRate === undefined ? 'n/a' : `${(baseline.recallFallbackRate * 100).toFixed(1)}%`}); ${ctxDays} day(s) of World now size` : 'no baseline yet (~/.flint/p2-baseline.json)',
    values: { p95Ms: p95, recallFallbackRate: fallback, baselineP95Ms: baseline?.p95Ms ?? null, baselineFallback: baseline?.recallFallbackRate ?? null, ctxTokenDays: ctxDays },
  });

  // 7. Health: checked in the last 10 minutes; a green restore drill in each of the last 4 weeks.
  const last = await db.healthCheck.findFirst({ orderBy: { at: 'desc' }, select: { at: true } });
  const fresh = !!last && now.getTime() - last.at.getTime() <= 10 * 60_000;
  const drills: boolean[] = [];
  for (let w = 0; w < 4; w++) {
    const end = new Date(now.getTime() - w * 7 * DAY);
    drills.push((await db.backupRun.count({ where: { restoreOk: true, restoreTestedAt: { gt: new Date(end.getTime() - 7 * DAY), lte: end } } })) > 0);
  }
  out.push({ n: 7, name: 'health: checked within 10 min; a green drill in each of 4 weeks', pass: fresh && drills.every(Boolean), detail: `last check ${last ? `${Math.round((now.getTime() - last.at.getTime()) / 60_000)} min ago` : 'never'}; green drills by week (newest first): ${drills.map((d) => (d ? 'yes' : 'no')).join(', ')}`, values: { fresh, drillWeeks: drills.filter(Boolean).length } });

  // 8. The Watcher stays on for the calendar until P2.5: the server's, checked by hand.
  out.push({ n: 8, name: 'the Watcher stays enabled for the calendar', pass: null, detail: "the server's Watcher, outside the runtime: checked by hand", values: {} });

  return { at: now.toISOString(), criteria: out };
}
