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
 *  - of one of two kinds, fixed as it is filed and kept as its reason: a card
 *    that turns numbers on, or (every number on it already on, as the filing
 *    transaction read them) a card that changes second opinions only. The
 *    second kind never turns a number's forecasts back on: run after one of its
 *    numbers was turned off, it is refused.
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
import { FORECAST_REASONS, ForecastEnableArgs, PREDICT_SAYS, digestOf, isForecastSignedAction, mostSensitive, type WebAuthnRelyingParty } from '@flint/policy';
import type { z } from 'zod';
import type { Db, Tx } from '../db.js';
import { appendAudit } from '../governance/audit.js';
import { Refused, claimIn, completeIn, contextOf, createProposal, rejectPendingIn, type CreateProposal } from '../governance/proposals.js';
import { dbRefused, failureOf, failureReport, schemaSkew, sqlState } from '../dbcodes.js';
import { GoalFailure, sanitize } from '../goals/errors.js';
import { failApproved } from '../goals/apply.js';
import { FORECAST_SERIES_KEYS, forecastSeries, freqOf, type ForecastSeriesDef } from './series.js';

/** What Will reads under a forecast card: fixed sentences, never a number. */
export const SAY = {
  // The ones the console's panel can be told are the shared ones (@flint/policy PREDICT_SAYS): one source of each.
  invalid: PREDICT_SAYS.invalid,
  kind: 'A predictions card is filed as kind tool_call.',
  fromConsole: 'Predictions are turned on from the console.',
  template: 'A predictions card carries no template.',
  provenance: 'The numbers on a predictions card are yours to choose.',
  unknown: PREDICT_SAYS.unknown,
  forgotten: PREDICT_SAYS.forgotten,
  mislabeled: PREDICT_SAYS.mislabeled,
  nothing: PREDICT_SAYS.nothing,
  reshaped: 'Flint reads this card differently since you approved it. File it again.',
  replaced: 'A newer version of this card replaced it.',
  // A card that changes second opinions only, run after a number on it was turned off: it turns nothing back on.
  turnedOff: 'This number’s forecasts were turned off, so this card no longer applies. File it again.',
  someTurnedOff: 'Forecasts for one of these numbers were turned off, so this card no longer applies. File it again.',
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
 * or sensitivity is never forecast under the registry's name). Nor is one tied
 * to an item: a registered number is Flint's own, about no single item, and a
 * row made with a link (the database fixes it at birth) would stop for good
 * when that item is forgotten.
 */
async function storedProblem(db: Db | Tx, defs: readonly ForecastSeriesDef[]): Promise<string | undefined> {
  const rows = await db.metricSeries.findMany({ where: { key: { in: defs.map((d) => d.key) } }, select: { key: true, entityId: true, unit: true, freq: true, sensitivity: true, description: true } });
  for (const r of rows) {
    const d = forecastSeries(r.key)!;
    if (r.description === FORGOTTEN) return SAY.forgotten;
    if (r.unit !== d.unit || r.freq !== freqOf(d) || r.sensitivity !== d.sensitivity || r.entityId !== null) return SAY.mislabeled;
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
  /** The card was filed when every number on it was already on (its reason says so): it changes second opinions only. */
  onlyOpinion?: boolean;
}
type Applied = { result: { on: number; reason: number } } | { refusal: string };

/**
 * The signed card's change, inside the caller's transaction. A refusal is
 * returned before any switch is turned on (a series row already made as the
 * registry says may stay: it is what the registry says, and off). Each listed
 * number's MetricSeries row is made if it is missing (as the registry says it
 * is; on this Mac only), and its switch row is turned on under this card's
 * approval, with the local model's estimate on exactly where the card signed it.
 *
 * A card that changes second opinions only (`onlyOpinion`) turns no number
 * on: every number on it must still be on, and its rows are held from the
 * look to the write, so a number turned off meanwhile is not turned back on
 * by a card that said only its second opinion changes.
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
  if (ctx.onlyOpinion) {
    // FOR UPDATE: turning a number off (an unsigned UPDATE of its row) waits for this transaction, and this one
    // reads the row as that one left it.
    const rows = await tx.$queryRaw<Array<{ on: boolean }>>`SELECT "on" FROM "ForecastSeries" WHERE "seriesKey" IN (${Prisma.join(args.series)}) FOR UPDATE`;
    if (rows.length !== args.series.length || rows.some((r) => r.on !== true)) return { refusal: args.series.length === 1 ? SAY.turnedOff : SAY.someTurnedOff };
  }
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

/**
 * File the Turn On Predictions card, for Will to sign in the console: from the
 * console's Predictions panel (the numbers he ticked), or from the command
 * line. Every registered number unless some are named. The same card and the
 * same checks either way: a key outside the registry is refused, and a card
 * that would change nothing is never filed. A card already waiting with the
 * same numbers is the one returned.
 *
 * From the console the newer card wins: his other Turn On cards still waiting
 * (from the console or the command line) are rejected, unsigned, with a fixed
 * sentence, so the sheet always leaves exactly one card waiting, and a card
 * left waiting after a cancelled prompt can never be approved later in place
 * of the one that replaced it. One exception: a card that changes second
 * opinions only (every number on it is already on) replaces only the waiting
 * cards that name one of its numbers. Asking for a second opinion on one
 * number does not throw away the card still waiting for the numbers Will
 * ticked on the sheet. Only cards filed
 * before this one are rejected, and in the transaction that files it: Turn On
 * filings run one at a time (createProposal's `serial`), so each sees every
 * card filed before it and none filed after, and filings made at the same
 * moment can never reject each other. The last one filed is the one left.
 *
 * `opinion`: the local model also gives its second opinion on these numbers
 * (all of them: the card's `reason` list is its `series` list). Off unless
 * Will switched it on in the sheet; the command line never asks for it.
 *
 * The answer's `onlyOpinion`: every number on the card was already on, read in
 * the transaction that filed it. That is the card's kind, kept as its reason
 * (FORECAST_REASONS.opinion), and what the executor holds it to. A card still
 * waiting with the very same lists but of the other kind (the numbers were
 * turned on, or off, since it was filed) is replaced, never handed back: what
 * a card is said to do and what its signature would do are then one thing.
 */
export async function proposeForecasts(db: Db, keys: readonly string[] = FORECAST_SERIES_KEYS, now = new Date(), from: 'cli' | 'console' = 'cli', opinion = false) {
  const series = [...new Set(keys)].sort();
  const actor = `will:${from}`;
  const action = 'forecast.series.enable';
  const args = { series, reason: opinion ? [...series] : [] };
  const CARD = { id: true, action: true, argsDigest: true, tainted: true, origin: true } as const;
  /** Every number on the card is already on, as the filing transaction read them. */
  let onlyOpinion = false;
  const filed = await createProposal(db, {
    kind: 'tool_call', origin: from, action, args,
    argsProvenance: { series: { source: 'will', tainted: false }, reason: { source: 'will', tainted: false } },
    tainted: false, sensitivity: 'ops', destructive: false, consequential: true, ttlMinutes: 7 * 24 * 60,
  }, actor, now, undefined, undefined, {
    serial: action,
    before: async (tx: Tx) => {
      onlyOpinion = (await tx.forecastSeries.count({ where: { seriesKey: { in: series }, on: true } })) === series.length;
      const reason = onlyOpinion ? FORECAST_REASONS.opinion : FORECAST_REASONS.enable;
      // The same lists on a card of the other kind, still waiting: not this card. It is replaced, so the filing
      // below makes a new one instead of handing that one back.
      const other = await tx.proposal.findMany({
        where: { status: 'pending', action, argsDigest: digestOf(args), NOT: { origin: { startsWith: 'runtime:' } }, OR: [{ reason: null }, { reason: { not: reason } }] },
        select: CARD,
      });
      for (const o of other) await rejectPendingIn(tx, o, SAY.replaced, actor);
      return { reason };
    },
    ...(from === 'console' ? {
      filed: async (tx: Tx, id: string) => {
        const older = await tx.proposal.findMany({ where: { status: 'pending', action, origin: { in: ['console', 'cli'] }, id: { not: id } }, select: { ...CARD, args: true } });
        const mine = new Set(series);
        for (const { args: theirs, ...o } of older) {
          // A card that changes second opinions only leaves a waiting card for OTHER numbers waiting. (One this
          // cannot read names nothing it could turn on: it goes.) Every other new card replaces every waiting one.
          const named = onlyOpinion ? ForecastEnableArgs.safeParse(theirs) : undefined;
          if (named?.success && !named.data.series.some((k) => mine.has(k))) continue;
          await rejectPendingIn(tx, o, SAY.replaced, actor);
        }
      },
    } : {}),
  });
  return { ...filed, onlyOpinion };
}

/** Who the panel's writes are by. */
export const CONSOLE_ACTOR = 'will:console';
/** What turning a number off is recorded under in the audit trail. */
export const TURN_OFF_ACTION = 'forecast.series.disable';

/**
 * Turn one number's forecasts off, from the console. Unsigned: it only narrows
 * what Flint does (the database asks for a signed card to turn a number on,
 * and for nothing to turn one off), and it is audited, by the number's key.
 * The local model's estimate of it goes off with it. What Flint already
 * predicted about it keeps being checked. Turning it on again takes the card.
 */
export async function turnOffSeries(db: Db, key: string, now = new Date()): Promise<void> {
  if (!forecastSeries(key)) throw new Refused(404, SAY.unknown);
  await db.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT set_config('flint.actor', ${CONSOLE_ACTOR}, true)`;
      const n = await tx.$executeRaw`UPDATE "ForecastSeries" SET "on" = false, "reason" = false WHERE "seriesKey" = ${key} AND "on"`;
      if (!n) throw new Refused(409, PREDICT_SAYS.alreadyOff);
      await appendAudit(tx, [{ actor: CONSOLE_ACTOR, context: 'console', kind: 'action', action: TURN_OFF_ACTION, outcome: 'ok', correlationId: `${key}.off`, tainted: false, inputs: { series: key } }], now);
    },
    { maxWait: 10_000, timeout: 20_000, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
  );
}

/** What turning a number's second opinion off is recorded under in the audit trail. */
export const OPINION_OFF_ACTION = 'forecast.series.opinion_off';

/**
 * Turn the local model's second opinion off for one number, from the console,
 * and leave its forecasts on. Unsigned, as turning the number off is: it only
 * narrows what Flint does, and it is audited by the number's key. The
 * estimates it already made stay on the ledger and keep being checked.
 * Turning it on again takes the card.
 */
export async function turnOffOpinion(db: Db, key: string, now = new Date()): Promise<void> {
  if (!forecastSeries(key)) throw new Refused(404, SAY.unknown);
  await db.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT set_config('flint.actor', ${CONSOLE_ACTOR}, true)`;
      const n = await tx.$executeRaw`UPDATE "ForecastSeries" SET "reason" = false WHERE "seriesKey" = ${key} AND "reason"`;
      if (!n) throw new Refused(409, PREDICT_SAYS.opinionOff);
      await appendAudit(tx, [{ actor: CONSOLE_ACTOR, context: 'console', kind: 'action', action: OPINION_OFF_ACTION, outcome: 'ok', correlationId: `${key}.opinion_off`, tainted: false, inputs: { series: key } }], now);
    },
    { maxWait: 10_000, timeout: 20_000, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
  );
}

/**
 * What the command prints once the card is filed: what it is, and how Will approves it. Held to the notes' rules, as
 * everything Flint says to him is: no key, no id (the card's or a number's), nothing in parentheses.
 */
export function cardFiledSays(p: { deduped: boolean }, numbers: number): string {
  return [
    `${p.deduped ? 'Already filed' : 'Filed'}: the Turn On Predictions card, for ${numbers} ${numbers === 1 ? 'number' : 'numbers'}.`,
    'To approve it: open Flint, click Approvals in the top bar, open Turn On Predictions, and approve it with Touch ID.',
    'It asks on its own, never in Approve All. It expires in 7 days. Nothing is forecast until it is approved.',
  ].join('\n');
}

/**
 * What the command prints when predictions are switched off on this Mac. A card filed and signed then would turn
 * numbers on that nothing forecasts, and say "nothing is forecast until it is approved" of something approval would
 * not start either. So nothing is filed, and it says why and where the how-to is.
 */
export const PREDICTIONS_OFF_SAYS = [
  'Not filed: predictions are switched off on this Mac.',
  'Switch them on first, then run this again. The runtime’s README says how, under The Two Switches.',
].join('\n');

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
        const p = await tx.proposal.findUniqueOrThrow({ where: { id }, select: { approvalId: true, origin: true, templateId: true, kind: true, tainted: true, reason: true } });
        // Only Will's own card, from the console or the CLI: one from chat never runs, however it was filed.
        const wills = contextOf(p.origin) === 'console' && p.templateId === null && p.kind === 'tool_call' && !p.tainted;
        // And only the on-switch itself: this executor runs no other action, whatever it is handed.
        const r: Applied = c.claimed.action !== 'forecast.series.enable'
          ? { refusal: SAY.invalid }
          : !wills
            ? { refusal: SAY.fromConsole }
            : await (async () => {
                await tx.$queryRaw`SELECT set_config('flint.actor', ${`will:approval:${p.approvalId}`}, true)`;
                // The card's kind is its reason, fixed since it was filed.
                return applyEnable(tx, c.claimed.args, { approvalId: p.approvalId!, argsDigest: c.claimed.argsDigest, onlyOpinion: p.reason === FORECAST_REASONS.opinion });
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
