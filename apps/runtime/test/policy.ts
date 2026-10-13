/**
 * What the policy guard's database tests share (migration policy_off_guard):
 * rules Will signed, made as the runtime's own role makes them; the card that
 * switches some off; and the questions each test asks of a row. Built on the
 * P5 kit's cards and roles. Synthetic text only.
 */
import { pgError, withClient, id, HEX, type TestUrls } from './db';
import { p5Kit, type CardOptions, type Q } from './p5';

export type Tier = 'alone' | 'approval' | 'forbidden';

export interface RowSpec {
  pattern: string;
  tier: Tier;
  dailyCap?: number;
  scope?: Record<string, unknown>;
  /** When it ends (default: in 30 days). */
  expiresAt?: string;
}
export type Listed = RowSpec & { expiresAt: string };

/** What each refusal says, by the row's id alone. */
export const REFUSED = (rid: string) => `policy row ${rid}: it holds something back, so only a card Will signed switches it off`;
export const LEVEL = (rid: string) => `policy row ${rid}: a row is switched off at READ COMMITTED`;
export const MADE_LEVEL = (rid: string) => `policy row ${rid}: a row is made at READ COMMITTED`;
export const NOT_STANDING = (rid: string) => `policy row ${rid}: its card is not one Will signed that still stands`;
export const NOT_EXECUTING = (rid: string) => `policy row ${rid}: its card is not an approved policy change being executed`;
export const NOT_LISTED = (rid: string) => `policy row ${rid}: not in the signed proposal`;
export const MADE_ALREADY = (rid: string) => `policy row ${rid}: its card has made this row already`;
export const NOT_WHOLE = (rid: string) => `policy row ${rid}: a card's rows are made together, all of them or none`;
export const NOT_READ = (rid: string) => `policy row ${rid}: its card's rows cannot be read, so none is made`;
export const NOT_TIMED = (pid: string) => `proposal ${pid}: each rule a policy change adds ends at a time written in full, with its zone`;
export const LEVELS = ['REPEATABLE READ', 'SERIALIZABLE'] as const;
/**
 * What a session may set for itself, and the runtime's role with it: the zone a time with none is read in (and days
 * are counted in), and which way round a date written as numbers is read. Eight zones: ahead of UTC and behind it,
 * on the half hour, across the date line, and where clocks change (north and south).
 */
export const ZONES = ['UTC', 'Etc/GMT+1', 'Etc/GMT+2', 'Etc/GMT-3', 'Asia/Kolkata', 'America/Chicago', 'Pacific/Kiritimati', 'Australia/Sydney'] as const;
export const DATE_STYLES = ['ISO, MDY', 'ISO, DMY'] as const;
export const SESSIONS: Array<{ TimeZone: string; DateStyle: string }> = ZONES.flatMap((TimeZone) => DATE_STYLES.map((DateStyle) => ({ TimeZone, DateStyle })));

const INSERT = `INSERT INTO "ActionPolicy" (id, pattern, tier, "dailyCap", scope, reason, "approvalId", "expiresAt") VALUES ($1, $2, $3, $4, $5::jsonb, 'Synthetic rule', $6, $7)`;

export async function policyKit(urls: TestUrls) {
  const k = await p5Kit(urls);
  const { app, owner, approver } = k;
  let family = 0;
  /** A family of action names no other test uses, so rows a test leaves on never meet another test's. */
  const fam = (prefix = 'pog') => `${prefix}${Date.now().toString(36)}${family++}`;
  /** A moment that many days from now, to the second (as the runtime keeps a row's end). */
  const inDays = (n: number) => new Date(Math.floor(Date.now() / 1000) * 1000 + n * 86_400_000).toISOString();
  const past = () => new Date(Date.now() - 86_400_000).toISOString();
  const failure = async (p: Promise<unknown>) => {
    const e = (await pgError(p)) as { code?: string; message: string; detail?: string };
    return [e.code, e.message, e.detail ?? null];
  };
  /** A card's rows as it lists them: each with its end. */
  const listed = (rows: RowSpec[]): Listed[] => rows.map((r) => ({ ...r, expiresAt: r.expiresAt ?? inDays(30) }));
  /** One row, written as whoever `q` is, under an approval. Returns its id. */
  const make = async (q: Q, aid: string, r: Listed, rid = id('pol')): Promise<string> => {
    await q(INSERT, [rid, r.pattern, r.tier, r.dailyCap ?? null, r.scope ? JSON.stringify(r.scope) : null, aid, r.expiresAt]);
    return rid;
  };
  /** The card that adds these rows, as far as `stage` (default: signed and executing, never completed). */
  const rowsCard = (rows: Listed[], o: CardOptions = {}) => k.card('policy.change', { rows }, { kind: 'policy', ...o });
  /**
   * Rules Will signed: one policy.change card, approved and executing while the runtime's role writes every row
   * it lists in one transaction (a card's rows are made together), then completed. Their ids, in order.
   */
  async function rule(rows: RowSpec[]): Promise<string[]> {
    const all = listed(rows);
    const pc = await rowsCard(all);
    const ids = all.map(() => id('pol'));
    await k.inTx(async (q) => {
      for (const [i, r] of all.entries()) await make(q, pc.aid, r, ids[i]);
    });
    await k.finish(pc.pid);
    return ids;
  }
  /**
   * A row as one from before the guards could be (an id that is no id, a pattern that covers policy changes): written
   * by the owner with the table's own rules set aside for the one transaction, under a real signed card.
   */
  async function forged(row: RowSpec & { id: string }): Promise<string> {
    const [r] = listed([row]);
    const signed = await rowsCard([r!]);
    await k.inTx(async (q) => {
      await q('ALTER TABLE "ActionPolicy" DISABLE TRIGGER USER');
      await make(q, signed.aid, r!, row.id);
      await q('ALTER TABLE "ActionPolicy" ENABLE TRIGGER USER');
    }, { url: urls.owner });
    await k.finish(signed.pid);
    return row.id;
  }
  const switchOff = (rid: string, q: Q = app) => q(`UPDATE "ActionPolicy" SET active = false WHERE id = $1`, [rid]);
  const isOn = async (rid: string) => (await owner(`SELECT active FROM "ActionPolicy" WHERE id = $1`, [rid])).rows[0].active as boolean;
  const exists = async (rid: string) => (await owner(`SELECT count(*)::int AS n FROM "ActionPolicy" WHERE id = $1`, [rid])).rows[0].n === 1;
  const history = async (rid: string) => (await owner(`SELECT actor, changed FROM "RowChange" WHERE "tableName" = 'ActionPolicy' AND "rowId" = $1 ORDER BY at`, [rid])).rows as Array<{ actor: string; changed: unknown }>;
  /** How a card names a row to switch off. */
  const named = async (rid: string) => (await owner(`SELECT id, pattern, tier FROM "ActionPolicy" WHERE id = $1`, [rid])).rows[0] as { id: string; pattern: string; tier: string };
  /** The card that switches rows off, as the runtime files it for Will from the CLI, as far as `stage` (default: signed and executing). */
  const offCard = async (rids: string[], o: CardOptions = {}) => k.card('policy.change', { off: await Promise.all(rids.map(named)) }, { kind: 'policy', origin: 'cli', ...o });
  /** Everything a test left on goes off, as the owner: for the tests that use the real names (goal.propose, task.check_bar). */
  const clear = () => owner(`UPDATE "ActionPolicy" SET active = false WHERE active`);
  /** A second approval key, to revoke without taking the kit's own away. */
  async function spareKey(): Promise<string> {
    const credential = id('cred');
    await approver(`INSERT INTO "ApprovalCredential" (id, "credentialId", factor, "publicKey", label, "enrolledVia") VALUES ($1, $2, 'webauthn', '\\x00', 'Synthetic old key', 'enroll_code')`, [id(), credential]);
    return credential;
  }
  const revoke = (credential: string) => approver(`UPDATE "ApprovalCredential" SET "revokedAt" = now() WHERE "credentialId" = $1`, [credential]);
  /** One session of its own (the runtime's role unless said otherwise) with these settings made for it, as any session may make them. */
  const session = <T>(settings: Record<string, string>, fn: (q: Q) => Promise<T>, url = urls.app): Promise<T> => withClient(url, async (c) => {
    for (const [name, value] of Object.entries(settings)) await c.query(`SELECT set_config($1, $2, false)`, [name, value]);
    return fn((sql, params) => c.query(sql, params));
  });
  /**
   * A card being carried out that outlives Will's approval by 7 days and `margin` more (or less), where the clocks of
   * `zone` go back an hour inside those 7 days: a session in that zone that counted 7 days by its own wall clock
   * would count 7 days and an hour. No signing can be dated at will, so this is written as the owner with the two
   * tables' own rules set aside for the one transaction: his approval ends 3.5 days before the clocks change.
   */
  async function acrossClocksBack(args: Record<string, unknown>, margin: string, zone = 'America/New_York', o: CardOptions = {}): Promise<{ pid: string; aid: string; zone: string }> {
    // The next hour, within 400 days, that the zone's wall clock shows twice.
    const back = (await owner(
      `SELECT t FROM generate_series(date_trunc('hour', now()), now() + interval '9600 hours', interval '1 hour') AS t
       WHERE (t AT TIME ZONE $1) = ((t - interval '1 hour') AT TIME ZONE $1) ORDER BY t LIMIT 1`, [zone])).rows[0]?.t as Date | undefined;
    if (!back) throw new Error(`no hour in the next 400 days in which the clocks of ${zone} go back`);
    const filed = await k.file('policy.change', args, { kind: 'policy', origin: 'cli', ...o });
    const aid = id('appr');
    const signedUntil = new Date(back.getTime() - 84 * 3_600_000).toISOString();
    const payload = { v: 1, subjectType: 'proposal', subjectId: filed.pid, decision: 'approve', action: 'policy.change', argsDigest: filed.digest, expiresAt: signedUntil, nonce: HEX('0').slice(0, 32) };
    await k.inTx(async (q) => {
      await q('ALTER TABLE "Approval" DISABLE TRIGGER USER');
      await q('ALTER TABLE "Proposal" DISABLE TRIGGER USER');
      await q(
        `INSERT INTO "Approval" (id, "subjectType", "subjectId", decision, payload, challenge, "credentialId", signature, "expiresAt") VALUES ($1, 'proposal', $2, 'approve', $3, $4, $5, '\\x01', $6)`,
        [aid, filed.pid, JSON.stringify(payload), HEX('c'), k.credentialId, signedUntil],
      );
      await q(`UPDATE "Proposal" SET status = 'executing', "approvalId" = $2, "expiresAt" = $3::timestamptz + interval '168 hours' + $4::interval WHERE id = $1`, [filed.pid, aid, signedUntil, margin]);
      await q('ALTER TABLE "Proposal" ENABLE TRIGGER USER');
      await q('ALTER TABLE "Approval" ENABLE TRIGGER USER');
    }, { url: urls.owner });
    return { pid: filed.pid, aid, zone };
  }
  return { k, urls, app, owner, approver, fam, inDays, past, failure, listed, make, rowsCard, rule, forged, switchOff, isOn, exists, history, named, offCard, clear, spareKey, revoke, session, acrossClocksBack };
}
export type PolicyKit = Awaited<ReturnType<typeof policyKit>>;
