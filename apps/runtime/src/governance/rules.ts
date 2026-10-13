/**
 * Will's rules, and the card that switches some of them off (the `rules`
 * command).
 *
 * A rule is a policy row he signed: it lets an action run on its own, or it
 * holds one back (he approves it each time, or Flint may not run it at all).
 * The runtime's role can switch off only a row whose going loosens nothing;
 * the database refuses it any other (the policy_off_guard migration). So a
 * rule that holds an action back is switched off the way it was made: on a
 * card Will signs in the console. This lists the rules that are on and files
 * that card for the ones he names. Nothing here switches a rule off itself.
 */
import { ruleWords } from '@flint/policy';
import type { Db } from '../db.js';
import { POLICY_OFF_SAYS } from './internal.js';
import { Refused, createProposal } from './proposals.js';

export interface RuleRow {
  id: string;
  pattern: string;
  tier: string;
  dailyCap: number | null;
  /** It covers only part of what it names (a row that lets an action run alone does so only inside its scope). */
  scoped: boolean;
  expiresAt: Date;
}

/** Every rule that is switched on, the ones that have ended included (they stay listed until they are switched off), in a steady order. */
export async function rulesOn(db: Db): Promise<RuleRow[]> {
  const rows = await db.actionPolicy.findMany({ where: { active: true }, orderBy: [{ pattern: 'asc' }, { id: 'asc' }], select: { id: true, pattern: true, tier: true, dailyCap: true, scope: true, expiresAt: true } });
  return rows.map((r) => ({ id: r.id, pattern: r.pattern, tier: r.tier, dailyCap: r.dailyCap, scoped: r.scope !== null, expiresAt: r.expiresAt }));
}

const day = (d: Date, tz: string): string => d.toLocaleDateString('en-US', { timeZone: tz, year: 'numeric', month: 'long', day: 'numeric' });

/**
 * One rule as a sentence: what it does, its limit, and its last day. An action
 * is said by its plain name (@flint/policy ruleWords), never its internal one.
 */
export function ruleSays(r: RuleRow, tz: string, now = new Date()): string {
  const what = ruleWords(r.pattern);
  const until = r.expiresAt.getTime() > now.getTime() ? `until ${day(r.expiresAt, tz)}` : `and ended on ${day(r.expiresAt, tz)}`;
  if (r.tier === 'forbidden') return `Flint may not run ${what}, ${until}.`;
  if (r.tier === 'approval') return `Flint asks you each time before it runs ${what}, ${until}.`;
  return `Flint may run ${what} on its own${r.scoped ? ', within the limits you signed' : ''}${r.dailyCap !== null ? `, up to ${r.dailyCap} a day` : ''}, ${until}.`;
}

/** The command that lists the rules, and the one that files the card: said wherever Will is told to switch a rule off. */
export const RULES_COMMAND = 'cd ~/flint && pnpm --silent --filter @flint/runtime rules';
export const RULES_OFF_COMMAND = `${RULES_COMMAND} --off`;

/** What `rules` prints: each rule that is on, under its id, then how to switch one off. */
export function rulesLines(rows: readonly RuleRow[], tz: string, now = new Date()): string[] {
  if (!rows.length) return ['You have no rules switched on.'];
  return [
    rows.length === 1 ? 'You have 1 rule switched on.' : `You have ${rows.length} rules switched on.`,
    ...rows.map((r) => `  ${r.id}  ${ruleSays(r, tz, now)}`),
    'To switch one off, run this with its id, then sign the card in the console (Approvals):',
    `  ${RULES_OFF_COMMAND} <id>`,
  ];
}

export const RULES_SAY = {
  none: 'Name at least one rule by its id. Run the command without --off to list them.',
  unknown: 'No rule that is switched on has that id. Run the command without --off to list them.',
} as const;

/**
 * The card that switches these rules off, filed as Will at the terminal (origin
 * cli, as enable-source's is). It names each row by its id, its pattern and its
 * tier: what he reads on the card is what goes off. Filed again while it waits,
 * it is the same card. Nothing changes until he signs it.
 */
export async function proposeRulesOff(db: Db, ids: readonly string[], now = new Date()) {
  const wanted = [...new Set(ids)];
  if (!wanted.length || wanted.some((i) => !/^[A-Za-z0-9_-]{1,64}$/.test(i))) throw new Refused(400, wanted.length ? RULES_SAY.unknown : RULES_SAY.none);
  const rows = await db.actionPolicy.findMany({ where: { id: { in: wanted } }, orderBy: [{ pattern: 'asc' }, { id: 'asc' }], select: { id: true, pattern: true, tier: true, active: true } });
  if (rows.length !== wanted.length) throw new Refused(400, RULES_SAY.unknown);
  if (rows.some((r) => !r.active)) throw new Refused(409, POLICY_OFF_SAYS.alreadyOff);
  const off = rows.map((r) => ({ id: r.id, pattern: r.pattern, tier: r.tier }));
  const card = await createProposal(db, {
    kind: 'policy', origin: 'cli', action: 'policy.change', args: { off }, argsProvenance: { off: { source: 'will', tainted: false } },
    tainted: false, sensitivity: 'ops', destructive: false, consequential: true, ttlMinutes: 7 * 24 * 60,
    reason: off.length === 1 ? 'Approving switches this rule off.' : 'Approving switches these rules off.',
  }, 'will:cli', now);
  return { ...card, rules: off.length };
}

/** What the command says once the card is filed. */
export function rulesOffFiledSays(p: { id: string; deduped: boolean; rules: number }): string {
  const many = p.rules !== 1;
  return `${p.deduped ? 'already filed' : 'filed'}: proposal ${p.id}, to switch off ${many ? `${p.rules} rules` : '1 rule'}. Sign it in the console (Approvals) with your key; ${many ? 'they go' : 'it goes'} off once signed.`;
}
