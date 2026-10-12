/**
 * What P4's database tests share: raw SQL as each role on flint_test, a card
 * Will signed (filed, approved and left executing, as the runtime's executor
 * would have it mid-run), and the rows a forecast needs. Synthetic series only.
 */
import pg from 'pg';
import { digestOf } from '@flint/policy';
import { withClient, pgConfig, pgError, id, HEX, type TestUrls } from './db';

export type Q = (sql: string, params?: unknown[]) => Promise<pg.QueryResult>;
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** A number no test writes anywhere but into a series' values: it must never come back in an error. */
export const CANARY = 31337.4242;

export interface CardOptions {
  /** How long the card lives (its expiresAt). */
  life?: string;
  origin?: string;
  kind?: string;
  tainted?: boolean;
  /** How far the card gets: Will's approval recorded and used, then claimed. Default executing. */
  stage?: 'pending' | 'approved' | 'executing';
  /** The credential that signs (default: the kit's live one). */
  credential?: string;
  /** The card's own-touch mark (default true, as the runtime files a forecast card). */
  consequential?: boolean;
  /** The card's sensitivity (default financial, the most a card can be). */
  sensitivity?: string;
}

export interface RunFields {
  id: string;
  provider: string;
  endpoint: string;
  requestDigest: string;
  horizon: number;
  level: number;
  beatsNaive: boolean | null;
  naiveMase: number | null;
  modelMase: number | null;
  scale: number | null;
  points: unknown;
  latencyMs: number;
  ok: boolean | null;
  error: string | null;
}

export async function p4Kit(urls: TestUrls) {
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
  async function inTx<T>(fn: (q: Q) => Promise<T>, o: { iso?: string; commit?: boolean; actor?: string } = {}): Promise<T> {
    return withClient(urls.app, async (c) => {
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
  const outcome = (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string; message?: string }) => e.code ?? e.message);

  /** Will's signed approval of a card, as the server records it after verifying his signature. */
  async function approval(pid: string, action: string, digest: string, credential = credentialId): Promise<string> {
    const aid = id('appr');
    const expires = (await owner(`SELECT to_char((now() + interval '10 minutes') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS t`)).rows[0].t as string;
    const payload = { v: 1, subjectType: 'proposal', subjectId: pid, decision: 'approve', action, argsDigest: digest, expiresAt: expires, nonce: HEX('0').slice(0, 32) };
    await approver(
      `INSERT INTO "Approval" (id, "subjectType", "subjectId", decision, payload, challenge, "credentialId", signature, "expiresAt") VALUES ($1, 'proposal', $2, 'approve', $3, $4, $5, '\\x01', $6)`,
      [aid, pid, JSON.stringify(payload), HEX('c'), credential, expires],
    );
    return aid;
  }

  /** A card as far as `stage` says (default: signed and executing, never completed). */
  async function card(action: string, args: Record<string, unknown>, o: CardOptions = {}): Promise<{ pid: string; aid: string }> {
    const pid = id('prop');
    const digest = digestOf(args);
    await app(
      `INSERT INTO "Proposal" (id, kind, origin, action, args, "argsDigest", "argsProvenance", tainted, sensitivity, consequential, "expiresAt")
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, '{}', $7, $8, $9, now() + $10::interval)`,
      [pid, o.kind ?? 'tool_call', o.origin ?? 'console', action, JSON.stringify(args), digest, o.tainted ?? false, o.sensitivity ?? 'financial', o.consequential ?? true, o.life ?? '1 hour'],
    );
    const aid = await approval(pid, action, digest, o.credential);
    if (o.stage === 'pending') return { pid, aid };
    await app(`UPDATE "Proposal" SET status = 'approved', "approvalId" = $2 WHERE id = $1`, [pid, aid]);
    if (o.stage === 'approved') return { pid, aid };
    await app(`UPDATE "Proposal" SET status = 'executing' WHERE id = $1`, [pid]);
    return { pid, aid };
  }
  const finish = (pid: string) => app(`UPDATE "Proposal" SET status = 'executed', "executedAt" = now() WHERE id = $1`, [pid]);

  /** A metric series (ops, counted per day, unless said otherwise). Returns its key. */
  async function series(o: { key?: string; unit?: string; freq?: string; sensitivity?: string; description?: string; entityId?: string | null } = {}, q: Q = app): Promise<string> {
    const key = o.key ?? `test.${id('k')}.count`;
    await q(`INSERT INTO "MetricSeries" (key, "entityId", unit, freq, sensitivity, description) VALUES ($1, $2, $3, $4, $5, $6)`,
      [key, o.entityId ?? null, o.unit ?? 'count', o.freq ?? 'D', o.sensitivity ?? 'ops', o.description ?? 'a synthetic series']);
    return key;
  }
  /** An entity a series can belong to (an account, unless said otherwise). Returns its id. */
  async function entity(kind = 'account'): Promise<string> {
    const eid = id('en');
    await app(`INSERT INTO "Entity" (id, kind, key, name, state, "stateHash", "lastObservedAt", "updatedAt") VALUES ($1, $2, $3, 'synthetic', '{}', $4, now(), now())`, [eid, kind, `${kind}:test:${eid}`, HEX('d')]);
    return eid;
  }
  /** Will forgets an entity (a signed forget): its series are marked forgotten by the database's own procedure. */
  async function forget(entityId: string): Promise<void> {
    const aid = id('appr');
    const expires = (await owner(`SELECT to_char((now() + interval '10 minutes') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS t`)).rows[0].t as string;
    const payload = { v: 1, subjectType: 'forget', subjectId: entityId, decision: 'approve', action: 'world.forget', argsDigest: HEX('a'), expiresAt: expires, nonce: HEX('0').slice(0, 32) };
    await approver(
      `INSERT INTO "Approval" (id, "subjectType", "subjectId", decision, payload, challenge, "credentialId", signature, "expiresAt") VALUES ($1, 'forget', $2, 'approve', $3, $4, $5, '\\x01', $6)`,
      [aid, entityId, JSON.stringify(payload), HEX('c'), credentialId, expires],
    );
    await app(`SELECT forget_entity($1, $2)`, [entityId, aid]);
  }
  const switchOn = (q: Q, key: string, aid: string, reason = false) =>
    q(`INSERT INTO "ForecastSeries" ("seriesKey", "on", reason, "approvalId") VALUES ($1, true, $2, $3)`, [key, reason, aid]);
  /** Turn numbers on under one signed card, in one transaction; the card then completes, as the executor's would. */
  async function turnOn(keys: string[], reason: string[] = []): Promise<{ pid: string; aid: string }> {
    const c = await card('forecast.series.enable', { series: [...keys].sort(), reason: [...reason].sort() });
    await inTx(async (q) => {
      for (const k of keys) await switchOn(q, k, c.aid, reason.includes(k));
    });
    await finish(c.pid);
    return c;
  }
  /** A series that is there and turned on (with the local model's estimate, when asked). */
  async function onSeries(o: Parameters<typeof series>[0] & { reason?: boolean } = {}): Promise<string> {
    const key = await series(o);
    await turnOn([key], o.reason ? [key] : []);
    return key;
  }

  /** A series whose entity Will then forgot (turned on first, when asked). Returns its key. */
  async function forgottenSeries(o: { on?: boolean } = {}): Promise<string> {
    const eid = await entity();
    const key = await series({ entityId: eid, description: 'a synthetic series of a synthetic account' });
    if (o.on) await turnOn([key]);
    await forget(eid);
    return key;
  }

  const point = (mean: number, lo = mean - 1, hi = mean + 1, at = '2026-10-14T04:00:00.000Z') => ({ at, mean, lo, hi });
  /** A run that failed: a short code, no points, no scores, no verdict. */
  const failedRun = (code = 'too_short'): Partial<RunFields> => ({ ok: false, error: code, points: [], beatsNaive: null, naiveMase: null, modelMase: null, scale: null });
  /** An ok local run that beat naive, unless said otherwise. */
  const runFields = (over: Partial<RunFields> = {}): RunFields => ({
    id: id('fr'), provider: 'local', endpoint: 'local:fc.v1', requestDigest: digestOf({ r: id() }), horizon: 1, level: 0.8,
    beatsNaive: true, naiveMase: 1.2, modelMase: 0.9, scale: 2, points: [point(4, 2, 6)], latencyMs: 4, ok: true, error: null, ...over,
  });
  async function run(seriesKey: string | null, over: Partial<RunFields> = {}, q: Q = app): Promise<string> {
    const r = runFields(over);
    await q(
      `INSERT INTO "ForecastRun" (id, "seriesKey", provider, endpoint, "requestDigest", horizon, level, "beatsNaive", "naiveMase", "modelMase", scale, points, "latencyMs", ok, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14, $15)`,
      [r.id, seriesKey, r.provider, r.endpoint, r.requestDigest, r.horizon, r.level, r.beatsNaive, r.naiveMase, r.modelMase, r.scale,
        r.points === null ? null : JSON.stringify(r.points), r.latencyMs, r.ok, r.error],
    );
    return r.id;
  }

  /** A prediction row, column by column. Defaults: a rule's yes/no prediction that resolves from the world. */
  async function prediction(over: Record<string, unknown> = {}, q: Q = app): Promise<string> {
    const v: Record<string, unknown> = {
      id: id('pd'), claim: 'a synthetic claim', kind: 'binary', probability: 0.6, method: 'rule', domain: 'services', type: 'event_occurs', evidence: '[]',
      resolutionCriteria: 'synthetic criteria', resolver: 'auto_world', resolveIn: '1 day', createdBy: 'test', tainted: false,
      pointEstimate: null, lower: null, upper: null, level: null, unit: null, seriesKey: null, forecastRunId: null, goalId: null, subjectEntityId: null, ...over,
    };
    await q(
      `INSERT INTO "Prediction" (id, claim, kind, probability, method, domain, type, evidence, "resolutionCriteria", resolver, "resolveBy", "createdBy", tainted,
                                 "pointEstimate", lower, upper, level, unit, "seriesKey", "forecastRunId", "goalId", "subjectEntityId")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, now() + $11::interval, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)`,
      [v.id, v.claim, v.kind, v.probability, v.method, v.domain, v.type, v.evidence, v.resolutionCriteria, v.resolver, v.resolveIn, v.createdBy, v.tainted,
        v.pointEstimate, v.lower, v.upper, v.level, v.unit, v.seriesKey, v.forecastRunId, v.goalId, v.subjectEntityId],
    );
    return v.id as string;
  }
  /**
   * What a forecast's row says of its series, as the forecaster will say it: the series' own unit, and the domain
   * the database can tell from it (spend for a financial series, calendar for a calendar one; deploys otherwise).
   */
  async function seriesSays(seriesKey: string | null): Promise<{ unit: string; domain: string }> {
    const s = (await owner(`SELECT unit, sensitivity, key ~ '(^|[.])calendar([.]|$)' AS calendar FROM "MetricSeries" WHERE key = $1`, [seriesKey])).rows[0] as { unit: string; sensitivity: string; calendar: boolean } | undefined;
    return { unit: s?.unit ?? 'count', domain: s?.sensitivity === 'financial' ? 'spend' : s?.calendar ? 'calendar' : 'deploys' };
  }
  /** The forecaster's yes/no question on a run. */
  const question = async (seriesKey: string, forecastRunId: string, over: Record<string, unknown> = {}, q: Q = app) =>
    prediction({ method: 'statistical', type: 'threshold_cross', resolver: 'auto_metric', createdBy: 'runtime:forecast', seriesKey, forecastRunId, ...(await seriesSays(seriesKey)), ...over }, q);
  /** The forecaster's range on a run. */
  const range = async (seriesKey: string, forecastRunId: string, over: Record<string, unknown> = {}, q: Q = app) =>
    prediction({
      kind: 'interval', probability: null, method: 'statistical', type: 'trend', resolver: 'auto_metric', createdBy: 'runtime:forecast',
      seriesKey, forecastRunId, ...(await seriesSays(seriesKey)), pointEstimate: 4, lower: 2, upper: 6, level: 0.8, ...over,
    }, q);

  return {
    urls, app, owner, approver, credentialId, client, on, inTx, code, outcome, approval, card, finish, series, entity, forget, forgottenSeries, switchOn, turnOn, onSeries,
    point, failedRun, runFields, run, prediction, question, range,
  };
}
export type P4Kit = Awaited<ReturnType<typeof p4Kit>>;

/** A refusal's code, message, detail, hint and context together (what a log line or Postgres's own log would hold). */
export async function refusal(p: Promise<unknown>): Promise<{ code: string | undefined; message: string; detail: string | undefined; text: string }> {
  const e = (await pgError(p)) as { code?: string; message: string; detail?: string; hint?: string; where?: string };
  return { code: e.code, message: e.message, detail: e.detail, text: `${e.message} ${e.detail ?? ''} ${e.hint ?? ''} ${e.where ?? ''}` };
}
