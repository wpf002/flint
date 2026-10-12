/**
 * Turning predictions on (Machine plan P4): the one signed action this part
 * carries out, forecast.series.enable. Its card is:
 *  - checked when it is filed (checkForecastCard): from the console or the CLI
 *    only, never from chat; its args against the shared contract, normalized so
 *    what Will signs is what is stored; every number one of the registered
 *    series, none of them forgotten or stored under another label. Its reason is
 *    a fixed sentence, its lists are marked as Will's own, and it is marked for
 *    his fresh touch. A card that could not apply, or that would change nothing,
 *    is never filed.
 *  - carried out in ONE transaction at READ COMMITTED (runForecast): the claim
 *    (signature checked again, tier, intent), the writes under flint.actor
 *    `will:approval:<id>`, and the card's completion. A crash anywhere leaves
 *    nothing turned on and the card approved.
 * The database checks every write against the executing card it names
 * (migration p4_forecasts): a number turns on only as that card's signed list
 * says, in that approval's one transaction. The checks here come first so that
 * Will reads a sentence, not a refusal.
 *
 * There is no card that lets a series leave this Mac: Flint forecasts here and
 * sends no series anywhere, and the database keeps every series marked so.
 *
 * Results, audit entries, log lines and errors carry series keys and counts,
 * never a series' values.
 */
import { Prisma } from '@prisma/client';
import { FORECAST_REASONS, ForecastEnableArgs, digestOf, isForecastSignedAction, mostSensitive, type WebAuthnRelyingParty } from '@flint/policy';
import type { z } from 'zod';
import type { Db, Tx } from '../db.js';
import { Refused, claimIn, completeIn, contextOf, type CreateProposal } from '../governance/proposals.js';
import { dbRefused, failureOf, failureReport, schemaSkew, sqlState } from '../dbcodes.js';
import { GoalFailure, sanitize } from '../goals/errors.js';
import { failApproved } from '../goals/apply.js';
import { forecastSeries, freqOf, type ForecastSeriesDef } from './series.js';

/** What Will reads under a forecast card: fixed sentences, never a number. */
export const SAY = {
  invalid: 'This card isn’t valid.',
  kind: 'A predictions card is filed as kind tool_call.',
  fromConsole: 'Predictions are turned on from the console.',
  template: 'A predictions card carries no template.',
  provenance: 'The numbers on a predictions card are yours to choose.',
  unknown: 'That number can’t be forecast.',
  forgotten: 'One of these numbers was forgotten, so it can’t be forecast.',
  mislabeled: 'One of these numbers isn’t stored the way Flint expects, so nothing was turned on.',
  nothing: 'It changes nothing.',
  reshaped: 'Flint reads this card differently since you approved it. File it again.',
} as const;

/** A provenance ref on a card is an id: a proposal's provenance is kept for good. */
const PROVENANCE_REF = /^[A-Za-z0-9_.:@-]{1,120}$/;
const FORGOTTEN = '[forgotten]';

/** A zod error as paths and codes (a message of ours, never a value): it is logged under a ref, not shown. */
function issuesOf(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.join('.') || '<args>'}: ${i.code === 'custom' ? i.message : i.code}`).join('; ').slice(0, 500);
}

/** The registered series a card names, or the sentence that refuses it. */
function registered(keys: readonly string[]): ForecastSeriesDef[] | undefined {
  const defs = keys.map((k) => forecastSeries(k));
  return defs.every((d): d is ForecastSeriesDef => d !== undefined) ? defs : undefined;
}

/**
 * Why a series' stored row would stop it being forecast: it was forgotten, or
 * it is not what the registry says it is (a row made under another unit, step
 * or sensitivity is never forecast under the registry's name).
 */
async function storedProblem(db: Db | Tx, defs: readonly ForecastSeriesDef[]): Promise<string | undefined> {
  const rows = await db.metricSeries.findMany({ where: { key: { in: defs.map((d) => d.key) } }, select: { key: true, unit: true, freq: true, sensitivity: true, description: true } });
  for (const r of rows) {
    const d = forecastSeries(r.key)!;
    if (r.description === FORGOTTEN) return SAY.forgotten;
    if (r.unit !== d.unit || r.freq !== freqOf(d) || r.sensitivity !== d.sensitivity) return SAY.mislabeled;
  }
  return undefined;
}

/**
 * A forecast card as it may be filed, or a refusal (400 for what it says, 409
 * for where things stand). From an autonomous context it is returned as it is:
 * the tier engine refuses it (FORBIDDEN, autonomous) and audits that.
 */
export async function checkForecastCard(db: Db, input: CreateProposal): Promise<CreateProposal> {
  if (!isForecastSignedAction(input.action)) return input;
  const context = contextOf(input.origin);
  if (context === 'autonomous') return input;
  if (context === 'chat') throw new Refused(409, SAY.fromConsole);
  if (input.kind !== 'tool_call') throw new Refused(400, SAY.kind);
  if (input.templateId !== undefined) throw new Refused(400, SAY.template);
  if (input.tainted) throw new Refused(400, SAY.invalid, 'a predictions card is never tainted');
  // Both lists are Will's own choice: a card that says a model, an event or a template picked them is not this card.
  if (Object.values(input.argsProvenance).some((p) => p.source !== 'will' || p.tainted || (p.ref !== undefined && !PROVENANCE_REF.test(p.ref)))) throw new Refused(400, SAY.provenance);
  const parsed = ForecastEnableArgs.safeParse(input.args);
  if (!parsed.success) throw new Refused(400, SAY.invalid, issuesOf(parsed.error));
  const args = parsed.data;
  const defs = registered(args.series);
  if (!defs) throw new Refused(400, SAY.unknown);
  const why = await storedProblem(db, defs);
  if (why) throw new Refused(409, why);
  // Already exactly as the card says: there is nothing for Will to sign.
  const rows = await db.forecastSeries.findMany({ where: { seriesKey: { in: args.series } }, select: { seriesKey: true, on: true, reason: true } });
  const now = new Map(rows.map((r) => [r.seriesKey, r]));
  if (args.series.every((k) => now.get(k)?.on === true && now.get(k)?.reason === args.reason.includes(k))) throw new Refused(400, SAY.nothing);
  return {
    ...input,
    args,
    // Where each list came from, as the card shows it: Will.
    argsProvenance: { series: { source: 'will', tainted: false }, reason: { source: 'will', tainted: false } },
    reason: FORECAST_REASONS.enable,
    // Keys only, but the card is as sensitive as the most sensitive number it turns on.
    sensitivity: mostSensitive(defs.map((d) => d.sensitivity)),
    destructive: false,
    // Marked for Will's own fresh touch, never Approve All.
    consequential: true,
  };
}

interface ApplyContext {
  approvalId: string;
  /** What Will signed: the stored args' digest. */
  argsDigest: string;
}
type Applied = { result: { on: number; reason: number } } | { refusal: string };

/**
 * The signed card's change, inside the caller's transaction. A refusal is
 * returned before any switch is turned on (a series row already made as the
 * registry says may stay: it is what the registry says, and off). Each listed
 * number's MetricSeries row is made if it is missing (as the registry says it
 * is; on this Mac only), and its switch row is turned on under this card's
 * approval, with the local model's estimate on exactly where the card signed it.
 */
export async function applyEnable(tx: Tx, raw: unknown, ctx: ApplyContext): Promise<Applied> {
  // The args as signed, read again with the shared contract. Normalizing them again must change nothing.
  const parsed = ForecastEnableArgs.safeParse(raw);
  if (!parsed.success || digestOf(parsed.data) !== ctx.argsDigest) return { refusal: SAY.reshaped };
  const args = parsed.data;
  const defs = registered(args.series);
  if (!defs) return { refusal: SAY.unknown };
  const why = await storedProblem(tx, defs);
  if (why) return { refusal: why };
  for (const d of defs) {
    // createMany + skipDuplicates: one INSERT ... ON CONFLICT DO NOTHING, so a row that is there is never written.
    await tx.metricSeries.createMany({ data: [{ key: d.key, unit: d.unit, freq: freqOf(d), sensitivity: d.sensitivity, description: d.description }], skipDuplicates: true });
  }
  // A row made between the look above and here (a rogue writer's, under another label) still stops the card.
  const again = await storedProblem(tx, defs);
  if (again) return { refusal: again };
  for (const d of defs) {
    const reason = args.reason.includes(d.key);
    await tx.forecastSeries.upsert({
      where: { seriesKey: d.key },
      // The database stamps enabledAt and updatedAt from its own clock.
      create: { seriesKey: d.key, on: true, reason, approvalId: ctx.approvalId, enabledAt: new Date() },
      update: { on: true, reason, approvalId: ctx.approvalId },
    });
  }
  return { result: { on: args.series.length, reason: args.reason.length } };
}

/** Test seams: a fault injected after the writes, before the card completes. */
export interface ForecastHooks {
  afterWrites?: (tx: Tx) => Promise<void>;
}

/**
 * Claim, apply and complete one approved forecast.series.enable card, in one
 * transaction. A refusal fails the card with a sentence; any other error rolls
 * everything back, leaving the card approved, and is rethrown as its class and
 * SQLSTATE.
 */
export async function runForecast(db: Db, id: string, rp: WebAuthnRelyingParty | undefined, tz: string, actor: string, hooks: ForecastHooks = {}) {
  const now = new Date();
  let out: { refused: Refused } | { done: { on: number; reason: number } };
  try {
    out = await db.$transaction(
      async (tx) => {
        const c = await claimIn(tx, id, rp, tz, actor, now);
        if ('refused' in c) return c;
        const p = await tx.proposal.findUniqueOrThrow({ where: { id }, select: { approvalId: true, origin: true, templateId: true, kind: true, tainted: true } });
        // Only Will's own card, from the console or the CLI: one from chat never runs, however it was filed.
        const wills = contextOf(p.origin) === 'console' && p.templateId === null && p.kind === 'tool_call' && !p.tainted;
        // And only the on-switch itself: this executor runs no other action, whatever it is handed.
        const r: Applied = c.claimed.action !== 'forecast.series.enable'
          ? { refusal: SAY.invalid }
          : !wills
            ? { refusal: SAY.fromConsole }
            : await (async () => {
                await tx.$queryRaw`SELECT set_config('flint.actor', ${`will:approval:${p.approvalId}`}, true)`;
                return applyEnable(tx, c.claimed.args, { approvalId: p.approvalId!, argsDigest: c.claimed.argsDigest });
              })();
        if ('refusal' in r) {
          await completeIn(tx, id, { ok: false, error: r.refusal }, actor, now);
          return { refused: new Refused(409, r.refusal) };
        }
        await hooks.afterWrites?.(tx);
        await completeIn(tx, id, { ok: true, result: r.result }, actor, now);
        return { done: r.result };
      },
      // READ COMMITTED, said out loud: the database refuses a turn-on above it (its guard reads what is committed now).
      { maxWait: 10_000, timeout: 30_000, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
  } catch (err) {
    throw sanitize(err);
  }
  if ('refused' in out) throw out.refused;
  return out.done;
}

/**
 * runInternal's forecast branch: runForecast and, when it fails other than by
 * a refusal, a log line with a reference, the failure's class, SQLSTATE and
 * constraint, and its top frames (never its message). Nothing was turned on.
 * When the database refused the change itself, the card fails, saying so with
 * the reference only; after anything else (a lost connection, a crash, a
 * schema the code does not expect yet) it stays approved, to run again.
 */
export async function runForecastCard(db: Db, id: string, rp: WebAuthnRelyingParty | undefined, tz: string, actor: string, hooks: ForecastHooks = {}) {
  try {
    return await runForecast(db, id, rp, tz, actor, hooks);
  } catch (err) {
    if (err instanceof Refused) throw err;
    const ref = `err${Date.now().toString(36)}`;
    const failure = failureOf(err);
    console.error(`[runtime] ${ref} running proposal ${id} failed: ${failureReport(err)}`);
    const state = err instanceof GoalFailure ? err.code : sqlState(err);
    if (state && /^(22|23|42|P0)/.test(state) && !schemaSkew(state)) await failApproved(db, id, `could not carry it out (${ref})`, failure, actor).catch(() => {});
    if (dbRefused(err)) throw new Refused(400, 'The database refused this change.');
    throw new Refused(409, 'Flint couldn’t carry it out.');
  }
}
