/**
 * What a restore must not undo, and what must not come back to life (P7).
 *
 * A backup is the database as it was. Restoring it would, left alone, also
 * restore things Will has since taken away, and things a changed backup never
 * had his signature for. Before a restored copy is put into use this:
 *
 *  1. carries forward what Will took away after the backup, when the database
 *     in use can still be read: an approval key he revoked (or replaced) stays
 *     revoked, and a promotion or triage rule he switched off stays off. Only
 *     ever in the direction that takes power away, and only by moves the
 *     governance triggers allow. A key enrolled after the backup is NOT copied
 *     in: the database being replaced is not trusted to add a key;
 *  2. checks every live promotion and triage rule against Will's signature:
 *     the approval's signature must verify under a key that is still live, the
 *     approval must be for the card that made the row, and the row must be in
 *     what that card said. One that fails is switched off;
 *  3. sets aside what was signed and not finished (an unused approval, an
 *     approved card), and what was queued: a delivery still waiting and every
 *     queued job are closed, so nothing queued before the backup runs again
 *     (the runtime queues what is still due by itself);
 *  4. carries the day's action counts forward, so a cap is not reset by a
 *     restore;
 *  5. lists what it cannot do for Will: things he told Flint to forget after the
 *     backup (they are back, and a forget needs his signature again), keys he
 *     enrolled after it, and cards he had already dealt with.
 *
 * Nothing else is changed. What it reports holds labels, names and counts,
 * never a key or a value.
 */
import { ApprovalPayload, canonicalJson, challengeOf, digestOf, ruleWords, verifySecureEnclave, verifyWebAuthnAssertion, type WebAuthnRelyingParty } from '@flint/policy';
import type pg from 'pg';

/** What Will reads on a card that was approved before the backup and so did not run. */
export const VOIDED_BY_RESTORE = 'This was approved before the database was restored from a backup, so it did not run. Approve it again.';

interface CredentialRow {
  credentialId: string;
  publicKey: Buffer;
  revokedAt: Date | null;
  signCount: number;
  label: string;
  factor: string;
  createdAt: Date;
}
interface PolicyRow {
  id: string;
  pattern: string;
  tier: string;
  dailyCap: number | null;
  scope: unknown;
  expiresAt: Date;
  approvalId: string;
  active: boolean;
}
interface RuleRow {
  id: string;
  name: string;
  source: string;
  eventType: string;
  predicate: unknown;
  action: string;
  lane: string;
  priority: number;
  perSenderDailyCap: number | null;
  createdBy: string;
  approvalId: string;
  enabled: boolean;
}

/** What the database in use says, read before it is replaced. */
export interface CurrentFacts {
  credentials: CredentialRow[];
  policies: PolicyRow[];
  rules: RuleRow[];
  /** Entities Will had Flint forget. */
  forgotten: Array<{ id: string; kind: string }>;
  counters: Array<{ action: string; day: string; count: number }>;
  /** Cards that were dealt with (approved, run, rejected, expired) after `takenAt`. */
  settled: Array<{ id: string; status: string }>;
}

const has = async (c: pg.Client, table: string): Promise<boolean> =>
  (await c.query<{ t: string | null }>('SELECT to_regclass($1)::text AS t', [table])).rows[0]!.t !== null;

const CREDENTIALS = `SELECT "credentialId", "publicKey", "revokedAt", "signCount", label, factor, "createdAt" FROM public."ApprovalCredential" ORDER BY "createdAt", "credentialId"`;
const POLICIES = `SELECT id, pattern, tier, "dailyCap", scope, "expiresAt", "approvalId", active FROM public."ActionPolicy" ORDER BY pattern, id`;
const RULES = `SELECT id, name, source, "eventType", predicate, action, lane, priority, "perSenderDailyCap", "createdBy", "approvalId", enabled FROM public."TriageRule" ORDER BY name`;

/**
 * Read the database in use, in one read-only snapshot. Throws when it cannot be
 * read (it is damaged, or older than these tables): the caller then says so in
 * the summary instead of carrying anything forward.
 */
export async function readCurrent(c: pg.Client, takenAt: Date): Promise<CurrentFacts> {
  await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    const credentials = (await c.query<CredentialRow>(CREDENTIALS)).rows;
    const policies = (await c.query<PolicyRow>(POLICIES)).rows;
    const rules = (await has(c, 'public."TriageRule"')) ? (await c.query<RuleRow>(RULES)).rows : [];
    const forgotten = (await has(c, 'public."Entity"')) ? (await c.query<{ id: string; kind: string }>(`SELECT id, kind FROM public."Entity" WHERE status = 'forgotten'`)).rows : [];
    const counters = (await c.query<{ action: string; day: string; count: number }>(`SELECT action, day, count FROM public."ActionCounter"`)).rows;
    const settled = (await c.query<{ id: string; status: string }>(
      `SELECT id, status FROM public."Proposal" WHERE "createdAt" <= $1 AND status <> 'pending' AND coalesce("executedAt", "expiresAt") > $1`,
      [takenAt],
    )).rows;
    return { credentials, policies, rules, forgotten, counters, settled };
  } finally {
    await c.query('ROLLBACK').catch(() => {});
  }
}

export interface KeyLine {
  label: string;
  /** `secure_enclave` (this Mac's key) or `webauthn` (a passkey). */
  factor: string;
  enrolledAt: Date;
  /** Whether the database in use holds this same key; undefined when it could not be read. */
  known?: boolean;
}
export interface PromotionLine {
  pattern: string;
  tier: string;
  dailyCap: number | null;
  expiresAt: Date;
}

export interface CarryReport {
  /** The database in use could be read, so what Will took away since the backup was carried forward. */
  currentRead: boolean;
  /** Approval keys revoked since the backup, revoked again in the restored copy. */
  revoked: number;
  /** Approval keys revoked because the backup's copy of the key is not the one in use. */
  mismatched: number;
  /** Approval keys in the backup that the database in use never held, revoked: a key is never deleted, so such a key was never Will's here. */
  keysNeverHeld: KeyLine[];
  /** Keys enrolled since the backup: not in the restored copy. */
  keysNotCarried: KeyLine[];
  /** Promotions and triage rules switched off since the backup, switched off again. */
  policiesOff: number;
  rulesOff: number;
  /** Switched off because Will's signature on them could not be checked. */
  unsignedPolicies: Array<{ pattern: string; why: string }>;
  unsignedRules: Array<{ name: string; why: string }>;
  /** Unused approvals marked used, and approved cards marked failed. */
  approvals: number;
  proposals: number;
  /** Deliveries still waiting, and queued jobs, that were closed. */
  deliveries: number;
  jobs: number;
  /** Action counts raised to what the database in use had. */
  counters: number;
  /** Things forgotten since the backup that are back, by kind and id. */
  forgets: Array<{ id: string; kind: string }>;
  /** Cards dealt with since the backup that are waiting again; `ran` of them had already run. */
  reappearing: { cards: number; ran: number };
  /** The keys that can approve after this restore. */
  liveKeys: KeyLine[];
  /** The promotions and rules in force after this restore. */
  promotions: PromotionLine[];
  rules: string[];
}

const same = (a: unknown, b: unknown): boolean => {
  try {
    return canonicalJson(a ?? null) === canonicalJson(b ?? null);
  } catch {
    return false;
  }
};

interface SignedRow {
  approvalId: string;
}
interface ApprovalRow {
  id: string;
  subjectType: string;
  subjectId: string;
  decision: string;
  payload: unknown;
  challenge: string;
  credentialId: string;
  authenticatorData: Buffer | null;
  clientDataJson: Buffer | null;
  signature: Buffer;
  publicKey: Buffer | null;
  factor: string | null;
  revokedAt: Date | null;
}
interface ProposalRow {
  id: string;
  kind: string;
  action: string;
  approvalId: string | null;
  argsDigest: string;
  status: string;
  args: unknown;
}

/**
 * Why Will's signature does not cover this row, or undefined when it does.
 * Mirrors the runtime's own re-verification (governance/approvals.ts) and the
 * insert triggers (action_policy_matches_approval, triage_rule_matches_approval),
 * neither of which runs when rows arrive from a dump.
 */
function unsigned(
  row: SignedRow,
  kind: 'policy' | 'rule',
  inCard: (args: unknown) => boolean,
  approvals: Map<string, ApprovalRow>,
  proposals: Map<string, ProposalRow>,
  rp: WebAuthnRelyingParty | undefined,
  anchored: boolean,
  /** Does the database in use hold the key that signed it? undefined when that database could not be read. */
  keyKnown: (a: ApprovalRow) => boolean | undefined,
): string | undefined {
  const a = approvals.get(row.approvalId);
  if (!a) return 'it names no approval';
  if (!a.publicKey || !a.factor) return 'the key that signed it is not there';
  if (a.revokedAt) return 'the key that signed it is revoked';
  // A key the database in use has never held cannot have signed anything there: a backup that brings its own key is not believed.
  if (keyKnown(a) === false) return 'the key that signed it is not in the database in use';
  const parsed = ApprovalPayload.safeParse(a.payload);
  if (!parsed.success) return 'its approval is not readable';
  const payload = parsed.data;
  const challenge = challengeOf(payload);
  if (challenge.toString('hex') !== a.challenge) return 'its approval does not match what was signed';
  if (a.subjectType !== 'proposal' || payload.subjectType !== 'proposal' || a.subjectId !== payload.subjectId || a.decision !== 'approve' || payload.decision !== 'approve') {
    return 'its approval is for something else';
  }
  if (a.factor === 'secure_enclave') {
    if (!verifySecureEnclave({ publicKeySpki: a.publicKey, challenge, signature: a.signature }).ok) return 'the signature on it does not verify';
  } else if (a.factor === 'webauthn') {
    if (!rp) return 'a passkey signed it, and this Mac has no passkey settings to check it with';
    if (!a.authenticatorData || !a.clientDataJson) return 'the signature on it is incomplete';
    if (!verifyWebAuthnAssertion({ publicKeySpki: a.publicKey, challenge, authenticatorData: a.authenticatorData, clientDataJson: a.clientDataJson, signature: a.signature, rp }).ok) {
      return 'the signature on it does not verify';
    }
  } else {
    return 'the key that signed it is of an unknown kind';
  }
  const p = proposals.get(a.subjectId);
  const [wantKind, wantAction] = kind === 'policy' ? ['policy', 'policy.change'] : ['rule', 'triage.rule.create'];
  if (!p || p.kind !== wantKind || p.action !== wantAction || payload.action !== wantAction || p.approvalId !== a.id || p.argsDigest !== payload.argsDigest) {
    return 'its approval is for something else';
  }
  if (!['executing', 'executed', 'failed'].includes(p.status)) return 'the card that made it was never carried out';
  if (p.args === null || p.args === undefined) {
    // The card's own words are kept for 30 days. After that the row cannot be compared with them:
    // it stands only when the database in use holds the very same row.
    return anchored ? undefined : 'it is older than 30 days, so it could not be compared with what you signed';
  }
  let digest: string;
  try {
    digest = digestOf(p.args);
  } catch {
    return 'the card that made it is not readable';
  }
  if (digest !== p.argsDigest) return 'the card that made it has changed since you signed it';
  return inCard(p.args) ? undefined : 'it is not in the card you signed';
}

const policyInCard = (r: PolicyRow) => (args: unknown): boolean => {
  const rows = (args as { rows?: unknown } | null)?.rows;
  if (!Array.isArray(rows)) return false;
  return rows.some((x: { pattern?: unknown; tier?: unknown; dailyCap?: unknown; scope?: unknown; expiresAt?: unknown }) =>
    x?.pattern === r.pattern && x.tier === r.tier && (x.dailyCap ?? null) === r.dailyCap && same(x.scope, r.scope)
    && typeof x.expiresAt === 'string' && Date.parse(x.expiresAt) === r.expiresAt.getTime());
};
const ruleInCard = (r: RuleRow) => (args: unknown): boolean => {
  const x = (args as { rule?: Record<string, unknown> } | null)?.rule;
  if (!x || typeof x !== 'object') return false;
  return x.name === r.name && x.source === r.source && x.eventType === r.eventType && same(x.predicate, r.predicate) && x.action === r.action && x.lane === r.lane
    && (typeof x.priority === 'number' ? x.priority : 100) === r.priority && (x.perSenderDailyCap ?? null) === r.perSenderDailyCap && x.createdBy === r.createdBy;
};
const samePolicy = (a: PolicyRow, b: PolicyRow): boolean =>
  a.pattern === b.pattern && a.tier === b.tier && a.dailyCap === b.dailyCap && same(a.scope, b.scope) && a.expiresAt.getTime() === b.expiresAt.getTime() && a.approvalId === b.approvalId;
const sameRule = (a: RuleRow, b: RuleRow): boolean => ruleInCard(a)({ rule: b }) && a.approvalId === b.approvalId;

const keyLine = (c: CredentialRow, known?: boolean): KeyLine => ({ label: c.label, factor: c.factor, enrolledAt: c.createdAt, ...(known === undefined ? {} : { known }) });

export interface CarryOptions {
  /** The database in use, as readCurrent gave it; undefined when it could not be read. */
  current?: CurrentFacts;
  /** The passkey settings approvals are verified against; absent, a passkey's signature cannot be checked. */
  rp?: WebAuthnRelyingParty;
  now: Date;
}

/**
 * Apply all of the above to the restored copy `c` is connected to (as the
 * migration owner), in one transaction, and say what was done. On any error
 * nothing is applied.
 */
export async function carryForward(c: pg.Client, o: CarryOptions): Promise<CarryReport> {
  const cur = o.current;
  await c.query('BEGIN');
  try {
    // Who made each change, for the history the triggers keep.
    await c.query(`SELECT set_config('flint.actor', 'restore', true)`);

    // 1. Keys: revoked since the backup stay revoked; a key that is not the one in use is revoked.
    const restoredKeys = (await c.query<CredentialRow>(CREDENTIALS)).rows;
    const curKeys = new Map((cur?.credentials ?? []).map((k) => [k.credentialId, k]));
    let revoked = 0;
    let mismatched = 0;
    const keysNeverHeld: KeyLine[] = [];
    for (const k of restoredKeys) {
      const now = curKeys.get(k.credentialId);
      if (!now) {
        // The database in use was read and has no such key. Keys are never deleted there, so this one was never
        // enrolled on this Flint: it is revoked, not left for Will to notice. (Unread, nothing can be told.)
        if (cur && !k.revokedAt) {
          await c.query(`UPDATE public."ApprovalCredential" SET "revokedAt" = $2 WHERE "credentialId" = $1 AND "revokedAt" IS NULL`, [k.credentialId, o.now]);
          keysNeverHeld.push(keyLine(k, false));
        }
        continue;
      }
      const sameKey = Buffer.compare(now.publicKey, k.publicKey) === 0;
      if (!k.revokedAt && (now.revokedAt || !sameKey)) {
        await c.query(`UPDATE public."ApprovalCredential" SET "revokedAt" = $2, "signCount" = GREATEST("signCount", $3) WHERE "credentialId" = $1 AND "revokedAt" IS NULL`, [
          k.credentialId, now.revokedAt ?? o.now, sameKey ? now.signCount : k.signCount,
        ]);
        if (sameKey) revoked += 1;
        else mismatched += 1;
      } else if (sameKey && now.signCount > k.signCount) {
        await c.query(`UPDATE public."ApprovalCredential" SET "signCount" = $2 WHERE "credentialId" = $1 AND "signCount" < $2`, [k.credentialId, now.signCount]);
      }
    }
    const restoredIds = new Set(restoredKeys.map((k) => k.credentialId));
    const keysNotCarried = (cur?.credentials ?? []).filter((k) => !k.revokedAt && !restoredIds.has(k.credentialId)).map((k) => keyLine(k));

    // 2. Promotions and rules switched off since the backup stay off.
    const offPolicies = (cur?.policies ?? []).filter((p) => !p.active).map((p) => p.id);
    const policiesOff = offPolicies.length ? (await c.query(`UPDATE public."ActionPolicy" SET active = false WHERE id = ANY($1) AND active`, [offPolicies])).rowCount ?? 0 : 0;
    const offRules = (cur?.rules ?? []).filter((r) => !r.enabled).map((r) => r.id);
    const rulesOff = offRules.length && (await has(c, 'public."TriageRule"')) ? (await c.query(`UPDATE public."TriageRule" SET enabled = false WHERE id = ANY($1) AND enabled`, [offRules])).rowCount ?? 0 : 0;

    // 3. Every promotion and rule still in force must carry Will's signature, under a key that is still live.
    const policies = (await c.query<PolicyRow>(`${POLICIES.replace(' ORDER BY', ' WHERE active AND "expiresAt" > $1 ORDER BY')}`, [o.now])).rows;
    const hasRules = await has(c, 'public."TriageRule"');
    const rules = hasRules ? (await c.query<RuleRow>(`${RULES.replace(' ORDER BY', ' WHERE enabled ORDER BY')}`)).rows : [];
    const approvalIds = [...new Set([...policies, ...rules].map((r) => r.approvalId))];
    const approvals = new Map(
      (await c.query<ApprovalRow>(
        `SELECT a.id, a."subjectType", a."subjectId", a.decision, a.payload, a.challenge, a."credentialId", a."authenticatorData", a."clientDataJson", a.signature,
                k."publicKey", k.factor, k."revokedAt"
         FROM public."Approval" a LEFT JOIN public."ApprovalCredential" k ON k."credentialId" = a."credentialId" WHERE a.id = ANY($1)`,
        [approvalIds],
      )).rows.map((a) => [a.id, a]),
    );
    const proposals = new Map(
      (await c.query<ProposalRow>(`SELECT id, kind, action, "approvalId", "argsDigest", status, args FROM public."Proposal" WHERE id = ANY($1)`, [[...approvals.values()].map((a) => a.subjectId)])).rows.map((p) => [p.id, p]),
    );
    const curPolicies = new Map((cur?.policies ?? []).map((p) => [p.id, p]));
    const curRules = new Map((cur?.rules ?? []).map((r) => [r.id, r]));
    const keyKnown = (a: ApprovalRow): boolean | undefined => {
      if (!cur) return undefined;
      const there = curKeys.get(a.credentialId);
      return there !== undefined && a.publicKey !== null && Buffer.compare(there.publicKey, a.publicKey) === 0;
    };
    const unsignedPolicies: CarryReport['unsignedPolicies'] = [];
    const unsignedRules: CarryReport['unsignedRules'] = [];
    for (const p of policies) {
      const there = curPolicies.get(p.id);
      const why = unsigned(p, 'policy', policyInCard(p), approvals, proposals, o.rp, there !== undefined && samePolicy(there, p), keyKnown);
      if (!why) continue;
      await c.query(`UPDATE public."ActionPolicy" SET active = false WHERE id = $1 AND active`, [p.id]);
      unsignedPolicies.push({ pattern: p.pattern, why });
    }
    for (const r of rules) {
      const there = curRules.get(r.id);
      const why = unsigned(r, 'rule', ruleInCard(r), approvals, proposals, o.rp, there !== undefined && sameRule(there, r), keyKnown);
      if (!why) continue;
      await c.query(`UPDATE public."TriageRule" SET enabled = false WHERE id = $1 AND enabled`, [r.id]);
      unsignedRules.push({ name: r.name, why });
    }

    // 4. Cards dealt with since the backup, before the next step changes any: they are waiting again in the restored copy.
    const settled = new Map((cur?.settled ?? []).map((s) => [s.id, s.status]));
    const waiting = settled.size ? (await c.query<{ id: string }>(`SELECT id FROM public."Proposal" WHERE status = 'pending' AND id = ANY($1)`, [[...settled.keys()]])).rows : [];
    const reappearing = { cards: waiting.length, ran: waiting.filter((w) => settled.get(w.id) === 'executed').length };

    // 5. Nothing signed before the backup may act after it.
    const a = await c.query(`UPDATE public."Approval" SET "consumedAt" = now() WHERE "consumedAt" IS NULL`);
    const p = await c.query(`UPDATE public."Proposal" SET status = 'failed', error = $1, "executedAt" = now() WHERE status IN ('approved', 'executing')`, [VOIDED_BY_RESTORE]);

    // 6. Nothing queued before the backup runs again. The runtime sends what is still due by itself.
    const deliveries = (await has(c, 'public."EscalationDelivery"'))
      ? (await c.query(`UPDATE public."EscalationDelivery" SET status = 'failed', "lastError" = 'closed by a restore' WHERE status = 'pending'`)).rowCount ?? 0
      : 0;
    const jobs = (await has(c, 'pgboss.job'))
      ? (await c.query(`UPDATE pgboss.job SET state = 'cancelled', completed_on = now() WHERE state IN ('created', 'retry', 'active')`)).rowCount ?? 0
      : 0;

    // 7. A cap already used today stays used.
    let counters = 0;
    for (const n of cur?.counters ?? []) {
      if (!/^\d{4}-(\d{2}-\d{2}(T\d{2})?|W\d{2})$/.test(n.day) || !Number.isInteger(n.count) || n.count < 0 || n.action.length > 200) continue;
      const r = await c.query(
        `INSERT INTO public."ActionCounter" (action, day, count) VALUES ($1, $2, $3)
         ON CONFLICT (action, day) DO UPDATE SET count = EXCLUDED.count WHERE public."ActionCounter".count < EXCLUDED.count`,
        [n.action, n.day, n.count],
      );
      counters += r.rowCount ?? 0;
    }

    // 8. What Will had Flint forget since the backup is back: a forget needs his signature again.
    const forgottenIds = (cur?.forgotten ?? []).map((f) => f.id);
    const forgets = forgottenIds.length && (await has(c, 'public."Entity"'))
      ? (await c.query<{ id: string; kind: string }>(`SELECT id, kind FROM public."Entity" WHERE id = ANY($1) AND status <> 'forgotten' ORDER BY kind, id`, [forgottenIds])).rows
      : [];

    // What is in force now.
    const liveKeys = (await c.query<CredentialRow>(CREDENTIALS)).rows.filter((k) => !k.revokedAt).map((k) => {
      const now = curKeys.get(k.credentialId);
      return keyLine(k, cur ? now !== undefined && Buffer.compare(now.publicKey, k.publicKey) === 0 : undefined);
    });
    const promotions = (await c.query<PromotionLine>(`SELECT pattern, tier, "dailyCap", "expiresAt" FROM public."ActionPolicy" WHERE active AND "expiresAt" > $1 ORDER BY pattern, id`, [o.now])).rows;
    const rulesOn = hasRules ? (await c.query<{ name: string }>(`SELECT name FROM public."TriageRule" WHERE enabled ORDER BY name`)).rows.map((r) => r.name) : [];

    await c.query('COMMIT');
    return {
      currentRead: cur !== undefined, revoked, mismatched, keysNeverHeld, keysNotCarried, policiesOff, rulesOff, unsignedPolicies, unsignedRules,
      approvals: a.rowCount ?? 0, proposals: p.rowCount ?? 0, deliveries, jobs, counters, forgets, reappearing, liveKeys, promotions, rules: rulesOn,
    };
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
const day = (d: Date, tz: string): string => d.toLocaleDateString('en-US', { timeZone: tz, year: 'numeric', month: 'long', day: 'numeric' });
const kindOfKey = (factor: string): string => (factor === 'secure_enclave' ? "this Mac's key" : factor === 'webauthn' ? 'a passkey' : 'a key');
/** A name from the database, cut to what a sentence can hold and to characters that are safe on a terminal. */
const plain = (s: string, max = 60): string => s.replace(/[^\w .,:*@()/-]/g, '?').slice(0, max);

/**
 * The report as sentences for Will: what was carried forward, what was set
 * aside, what he must do again, and what is in force. Keys by label, kind and
 * the day they were enrolled; promotions by what they allow. Never a key.
 */
export function carryLines(r: CarryReport, tz: string, mode: 'production' | 'rebuild'): string[] {
  const out: string[] = [];
  if (mode === 'rebuild') {
    out.push('The rebuilt Flint starts from the backup, so anything you revoked, switched off or told Flint to forget after it was made is back.');
    out.push("Check your approval keys and what Flint may do on its own in the console's Settings, and forget those things again.");
  } else if (!r.currentRead) {
    out.push('Flint could not read the database in use, so anything you revoked, switched off or told Flint to forget after this backup may be back.');
    out.push("Check your approval keys and what Flint may do on its own in the console's Settings, and forget those things again.");
  }
  if (r.revoked) out.push(r.revoked === 1 ? 'The approval key you revoked after this backup stays revoked.' : `The ${r.revoked} approval keys you revoked after this backup stay revoked.`);
  if (r.mismatched) out.push(`Flint revoked ${count(r.mismatched, 'approval key', 'approval keys')} from the backup, because ${r.mismatched === 1 ? 'it is' : 'they are'} not the same as in the database in use.`);
  for (const k of r.keysNeverHeld) out.push(`Flint revoked the approval key "${plain(k.label)}" from the backup, because the database in use never held it. Enrol it again if it is yours.`);
  for (const k of r.keysNotCarried) out.push(`The approval key "${plain(k.label)}" was enrolled after this backup, so it is not in it. Enrol it again.`);
  if (r.policiesOff + r.rulesOff) out.push(`What you switched off after this backup stays off: ${count(r.policiesOff + r.rulesOff, 'permission', 'permissions')}.`);
  // An action is said by its plain name (the console's own, @flint/policy ruleWords), never by its internal one.
  const unsigned = [...r.unsignedPolicies.map((p) => ({ what: `${ruleWords(p.pattern)} running on its own`, why: p.why })), ...r.unsignedRules.map((u) => ({ what: `the triage rule ${plain(u.name)}`, why: u.why }))];
  for (const u of unsigned.slice(0, 5)) out.push(`Flint switched off ${u.what}: ${u.why}. Sign it again if you want it.`);
  if (unsigned.length > 5) out.push(`Flint switched off ${unsigned.length - 5} more for the same kind of reason. Sign them again if you want them.`);
  if (r.proposals) out.push(`You had approved ${count(r.proposals, 'card', 'cards')} that did not run. Approve ${r.proposals === 1 ? 'it' : 'them'} again in Flint.`);
  if (r.reappearing.cards) {
    const n = r.reappearing.cards;
    out.push(
      `You dealt with ${count(n, 'card', 'cards')} after this backup, and ${n === 1 ? 'it is' : 'they are'} waiting again${r.reappearing.ran ? `; ${r.reappearing.ran} of them had already run` : ''}. Reject what you do not want done twice.`,
    );
  }
  if (r.forgets.length) {
    const kinds = [...new Set(r.forgets.map((f) => plain(f.kind, 30)))].join(', ');
    const n = r.forgets.length;
    out.push(`You told Flint to forget ${count(n, 'thing', 'things')} after this backup, and ${n === 1 ? 'it is' : 'they are'} back (${kinds}). Forget ${n === 1 ? 'it' : 'them'} again in the console.`);
  }
  if (r.deliveries + r.jobs) out.push('Notes and jobs that were waiting when the backup was made were closed, so nothing is sent twice.');
  if (r.liveKeys.length === 0) {
    out.push('No approval key is live after this restore. Enrol one with this command:');
    out.push('  cd ~/flint && pnpm --silent --filter @flint/runtime enroll --replace');
  }
  for (const k of r.liveKeys) {
    out.push(`This key can approve: "${plain(k.label)}", ${kindOfKey(k.factor)}, enrolled ${day(k.enrolledAt, tz)}.`);
  }
  const alone = r.promotions.filter((p) => p.tier === 'alone');
  const limits = r.promotions.filter((p) => p.tier !== 'alone');
  // "Backup, Offsite Backup and Restore Test"; with a daily cap on any of them, each stands apart: "Backup, up to 5 a day; Restore Test".
  const some = (rows: PromotionLine[]): string => {
    const shown = rows.slice(0, 12).map((p) => `${ruleWords(p.pattern)}${p.dailyCap !== null ? `, up to ${p.dailyCap} a day` : ''}`);
    const more = rows.length - shown.length;
    if (more > 0) return `${shown.join('; ')}; and ${more} more`;
    if (rows.some((p) => p.dailyCap !== null)) return shown.join('; ');
    return shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]!}` : shown.join('');
  };
  if (alone.length === 0) out.push('Flint may do nothing on its own after this restore: every action asks you first.');
  else out.push(`Flint may do ${count(alone.length, 'thing', 'things')} on its own: ${some(alone)}.`);
  if (limits.length) out.push(`You have ${count(limits.length, 'limit', 'limits')} in force: ${some(limits)}.`);
  if (r.rules.length) out.push(`You have ${count(r.rules.length, 'triage rule', 'triage rules')} in force: ${r.rules.slice(0, 12).map((n) => plain(n)).join(', ')}${r.rules.length > 12 ? ', and more' : ''}.`);
  return out;
}
