/**
 * Who may switch a policy row off (migration policy_off_guard): what a runtime
 * that breaks its own rules still cannot do, and why the rule is the right one.
 *
 * The rule, from how the tier engine reads the rows (@flint/policy resolveTier):
 * of the live rows that match an action the strictest wins, and an action is
 * promoted only when every matching row is at alone, under the lowest daily cap
 * among the rows that promote it. So the runtime's role (flint_app) switches a
 * row off on its own only when the row is at alone and is not what keeps a cap
 * down. Any other row goes off on a card Will signed, and no other way.
 *
 *  1. The proof (no database): over thousands of rule tables, switching off any
 *     row the rule allows never makes resolveTier's answer looser for any action
 *     in any context, at any time. Two weaker rules are shown to fail.
 *  2. The database is that rule: asked row by row as flint_app, it allows
 *     exactly the rows the rule allows, and none of them loosens anything.
 *  3. Raw SQL as flint_app: a row that lets an action run alone goes off; a row
 *     that holds one back does not, by any statement, at any isolation level;
 *     the signed card switches it off, and only a card that is all a card must
 *     be; the two floors that stand on a holding row (goals from chat, P5's
 *     acceptance) now stand; rows from before the migration behave the same.
 *  4. The runtime's own path: the card is filed, signed and carried out, and a
 *     refusal by the database is a sentence and an audit entry, never a retry.
 * Synthetic text only.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { actionKey, digestOf, patternMatches, resolveTier, suggestionGoalId, type McpFacts, type PolicyRow, type Tier, type TierContext, type TierDecision } from '@flint/policy';
import { NO_DB, freshDb, withClient, withoutPolicyOffGuard, pgConfig, pgError, id, HEX, type TestUrls } from './db';
import { p5Kit, sleep, type CardOptions, type P5Kit, type Q } from './p5';
import { enrollTestKey } from './sign';
import { createDb } from '../src/db';
import { approveProposal, createProposal } from '../src/governance/proposals';
import { POLICY_OFF_REFUSED, POLICY_OFF_SAYS, runInternal } from '../src/governance/internal';

// ---- The rule, and what "looser" means -------------------------------------------------------------------------

/** A policy row as the database holds it: what the guard and the tier engine both read. */
interface Row {
  id: string;
  pattern: string;
  tier: Tier;
  dailyCap: number | null;
  scope: Record<string, unknown> | null;
  active: boolean;
  expiresAt: Date;
}

/** Can two patterns match one action? The same pattern, or one is `prefix.*` and the other starts with that prefix. */
const overlap = (a: string, b: string): boolean => a === b || (b.endsWith('.*') && a.startsWith(b.slice(0, -1))) || (a.endsWith('.*') && b.startsWith(a.slice(0, -1)));

/**
 * The database's first rule, written again here: may the runtime's role switch this row off with no card? It is at
 * alone, and it is not what keeps a cap down: it has no cap, or no row that is on, at alone and able to match an
 * action it matches has a higher cap or none. (Expiry and scope are not read.)
 */
const mayGoOff = (r: Row, table: readonly Row[]): boolean =>
  r.tier === 'alone' && (r.dailyCap === null || !table.some((o) => o.active && o.tier === 'alone' && (o.dailyCap === null || o.dailyCap > r.dailyCap!) && overlap(o.pattern, r.pattern)));
/** Two rules that are not enough, to show what each part of the real one is for. */
const anyRow = (_r: Row, _table: readonly Row[]): boolean => true;
const aloneOnly = (r: Row, _table: readonly Row[]): boolean => r.tier === 'alone';

const RANK: Record<Tier, number> = { alone: 0, approval: 1, forbidden: 2 };
const capOf = (d: TierDecision): number => d.cap?.limit ?? Infinity;
/** Is `after` less restricted than `before`? Its tier is looser, or at the same tier more may run in a period. */
const looser = (before: TierDecision, after: TierDecision): 'tier' | 'cap' | null =>
  RANK[after.tier] < RANK[before.tier] ? 'tier' : after.tier === before.tier && capOf(after) > capOf(before) ? 'cap' : null;

const asPolicy = (r: Row): PolicyRow => ({ pattern: r.pattern, tier: r.tier, dailyCap: r.dailyCap, ...(r.scope ? { scope: r.scope } : {}), active: r.active, expiresAt: r.expiresAt });

// Times a row may end at, and the moments the engine is asked at: before any has ended (as a clock set back would
// read them), now, and after the short ones have ended.
const T0 = Date.UTC(2026, 9, 13, 12);
const ENDED = new Date(T0 - 86_400_000);
const SOON = new Date(T0 + 3_600_000);
const FAR = new Date(T0 + 90 * 86_400_000);
const NOWS = [new Date(T0 - 2 * 86_400_000), new Date(T0), new Date(T0 + 2 * 3_600_000)];
const SCOPE_A = { endpoints: ['a'] };
const SCOPE_B = { endpoints: ['b'] };
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Every way a call can be asked about: who asks, what the turn has read, what the data is, and what the caller can tell about a scope. */
const CONTEXTS: Array<Pick<TierContext, 'context' | 'tainted' | 'sensitivity' | 'scopeAllows'>> = [];
for (const context of ['chat', 'console', 'autonomous'] as const) {
  for (const tainted of [false, true]) {
    for (const sensitivity of [undefined, 'personal'] as const) {
      for (const scopeAllows of [undefined, () => true, () => false, (s: unknown) => same(s, SCOPE_A)]) {
        CONTEXTS.push({ context, tainted, ...(sensitivity ? { sensitivity } : {}), ...(scopeAllows ? { scopeAllows } : {}) });
      }
    }
  }
}

/** The calls asked about: every kind of entry the code table has, an action it does not know, and MCP tools of each kind. */
const CALLS: Array<{ action: string; mcp?: McpFacts }> = [
  { action: 'goal.propose' }, // promotable, no cap of its own
  { action: 'goal.review.local' }, // promotable, 20 a day in code
  { action: 'backup.prune' }, // promoted by name only, never from chat
  { action: 'backup.local' }, // promotable, 1 a day in code
  { action: 'notify.push' }, // promotable, leaves the box
  { action: 'world.sync.git' },
  { action: 'world_now' }, // a chat read
  { action: 'calculate' }, // alone in code: a row can only tighten it
  { action: 'deep_research' },
  { action: 'ledger.void' }, // never promoted
  { action: 'policy.change' },
  { action: 'restore.production' }, // the console's alone
  { action: 'task.check_bar' }, // not in the code table
  { action: 'unknown.thing' },
  { action: 'mcp:hive.do_thing', mcp: { server: 'hive', tool: 'do_thing' } },
  { action: 'mcp:hive.do_thing', mcp: { server: 'hive', tool: 'do_thing', destructiveHint: true } },
  { action: 'mcp:hive.open_position', mcp: { server: 'hive', tool: 'open_position' } },
  { action: 'mcp:nexus.recall', mcp: { server: 'nexus', tool: 'recall', readOnlyHint: true } },
  { action: 'mcp:runtime.world_now', mcp: { server: 'runtime', tool: 'world_now' } },
];
/** The key a call's rows are matched on (a runtime chat tool is matched as its own action). */
const keyOf = (c: { action: string; mcp?: McpFacts }): string => (c.mcp?.server === 'runtime' && !c.mcp.destructiveHint ? c.mcp.tool : actionKey(c.action, c.mcp));

const PATTERNS = [
  'goal.propose', 'goal.review.local', 'goal.*', 'goal.review.*', 'backup.prune', 'backup.local', 'backup.*', 'notify.push', 'notify.*', 'world.sync.git', 'world.sync.*', 'world.*',
  'world_now', 'calculate', 'deep_research', 'ledger.void', 'ledger.*', 'policy.change', 'restore.production', 'restore.*', 'task.check_bar', 'task.*', 'unknown.thing', 'unknown.*',
  'mcp:hive.do_thing', 'mcp:hive.open_position', 'mcp:hive.*', 'mcp:nexus.recall', 'mcp:nexus.*',
];

/** A small seeded generator, so a failure names a table that can be made again. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;

/** A rule table: a few rows, mostly about one family of actions so that they meet. */
function randomTable(r: () => number, n: number): Row[] {
  const family = pick(r, ['goal.', 'backup.', 'notify.', 'world', 'mcp:hive.', 'ledger.', 'task.', 'unknown.', '']);
  const pool = PATTERNS.filter((p) => p.startsWith(family));
  const rows: Row[] = [];
  const size = 1 + Math.floor(r() * 6);
  for (let i = 0; i < size; i++) {
    const tier = r() < 0.6 ? 'alone' : r() < 0.7 ? 'approval' : 'forbidden';
    rows.push({
      id: `t${n}r${i}`,
      pattern: pick(r, r() < 0.85 ? pool : PATTERNS),
      tier,
      dailyCap: r() < 0.45 ? null : pick(r, [0, 1, 3, 3, 20, 50]),
      scope: r() < 0.7 ? null : pick(r, [SCOPE_A, SCOPE_B]),
      active: r() < 0.88,
      expiresAt: r() < 0.75 ? FAR : r() < 0.6 ? SOON : ENDED,
    });
  }
  return rows;
}

interface Found {
  kind: 'tier' | 'cap';
  row: string;
  call: string;
  context: string;
  before: string;
  after: string;
}
const said = (d: TierDecision) => `${d.tier}${d.cap ? ` ${d.cap.limit}/${d.cap.period}` : ''}`;

/** Every call, context and moment where switching `off` off makes the engine's answer looser. None, for a row the rule allows. */
function loosenings(table: readonly Row[], off: Row, nows: readonly Date[] = NOWS, calls = CALLS): Found[] {
  const before = table.map(asPolicy);
  const after = table.map((r) => (r === off ? { ...asPolicy(r), active: false } : asPolicy(r)));
  const found: Found[] = [];
  for (const c of calls) {
    // A row that does not match the call's key is not read for it (patternMatches is the engine's own): nothing can change.
    if (!patternMatches(off.pattern, keyOf(c))) continue;
    for (const ctx of CONTEXTS) {
      for (const now of nows) {
        const b = resolveTier(c.action, { ...ctx, ...(c.mcp ? { mcp: c.mcp } : {}), policies: before, now });
        const a = resolveTier(c.action, { ...ctx, ...(c.mcp ? { mcp: c.mcp } : {}), policies: after, now });
        const kind = looser(b, a);
        if (kind) found.push({ kind, row: `${off.pattern} ${off.tier} cap ${off.dailyCap}`, call: keyOf(c), context: `${ctx.context}${ctx.tainted ? ' tainted' : ''}`, before: said(b), after: said(a) });
      }
    }
  }
  return found;
}

/** Every table of one, two or three rows drawn from `universe` (rows may repeat: Will can sign the same rule twice). */
function* smallTables(universe: readonly Omit<Row, 'id'>[]): Generator<Row[]> {
  const row = (i: number, n: number): Row => ({ ...universe[i]!, id: `s${n}` });
  for (let a = 0; a < universe.length; a++) {
    yield [row(a, 0)];
    for (let b = a; b < universe.length; b++) {
      yield [row(a, 0), row(b, 1)];
      for (let c = b; c < universe.length; c++) yield [row(a, 0), row(b, 1), row(c, 2)];
    }
  }
}
const universeOf = (patterns: string[], scopes: Array<Row['scope']>): Array<Omit<Row, 'id'>> =>
  patterns.flatMap((pattern) => (['alone', 'approval', 'forbidden'] as const).flatMap((tier) => [null, 1, 3].flatMap((dailyCap) => scopes.map((scope) => ({ pattern, tier, dailyCap, scope, active: true, expiresAt: FAR })))));

describe('the rule: a row the runtime may switch off on its own never loosens anything', () => {
  it('every table of up to three rules about one action and its family: no row the rule allows loosens any call, in any context', () => {
    let allowed = 0;
    let refused = 0;
    const bad: Found[] = [];
    // Goals from chat (promotable, no cap in code) and the rule that covers the family; then an action promoted by name only.
    for (const universe of [universeOf(['goal.propose', 'goal.*'], [null, SCOPE_A]), universeOf(['backup.prune', 'backup.*'], [null])]) {
      for (const table of smallTables(universe)) {
        for (const r of table) {
          if (!mayGoOff(r, table)) {
            refused++;
            continue;
          }
          allowed++;
          bad.push(...loosenings(table, r, [NOWS[1]!]));
        }
      }
    }
    expect(bad.slice(0, 5)).toEqual([]);
    // Both kinds of answer in number: the rule is neither "never" nor "always".
    expect(allowed).toBeGreaterThan(5_000);
    expect(refused).toBeGreaterThan(5_000);
  }, 120_000);

  it('4,000 random tables (rows on and off, ended and not, scoped and not, exact and wide, every tier and cap): none, whatever the clock says', () => {
    const r = rng(20261015);
    let allowed = 0;
    let holding = 0;
    let capKept = 0;
    const bad: Found[] = [];
    for (let n = 0; n < 4_000; n++) {
      const table = randomTable(r, n);
      for (const row of table.filter((x) => x.active)) {
        if (mayGoOff(row, table)) {
          allowed++;
          bad.push(...loosenings(table, row));
        } else if (row.tier === 'alone') capKept++;
        else holding++;
      }
    }
    expect(bad.slice(0, 5)).toEqual([]);
    expect(allowed).toBeGreaterThan(2_000);
    expect(holding).toBeGreaterThan(2_000);
    // The cap half of the rule is exercised too: rows at alone that are refused because they keep a cap down.
    expect(capKept).toBeGreaterThan(100);
  }, 120_000);

  it('one after another: switching off every row the rule allows, in any order, never passes through a looser answer', () => {
    const r = rng(7);
    const bad: Found[] = [];
    let steps = 0;
    for (let n = 0; n < 1_500; n++) {
      let table = randomTable(r, n);
      for (;;) {
        const can = table.filter((x) => x.active && mayGoOff(x, table));
        if (!can.length) break;
        const next = pick(r, can);
        bad.push(...loosenings(table, next));
        table = table.map((x) => (x === next ? { ...x, active: false } : x));
        steps++;
      }
    }
    expect(bad.slice(0, 5)).toEqual([]);
    expect(steps).toBeGreaterThan(1_500);
  }, 120_000);

  it('a weaker rule fails this proof: "any row" loosens a tier, and "any row at alone" loosens a cap (and only a cap)', () => {
    const found = (rule: (r: Row, t: readonly Row[]) => boolean): Found[] => {
      const r = rng(20261015);
      const out: Found[] = [];
      for (let n = 0; n < 1_500; n++) {
        const table = randomTable(r, n);
        for (const row of table.filter((x) => x.active)) if (rule(row, table)) out.push(...loosenings(table, row));
      }
      return out;
    };
    // What main allowed: any row. A brake Will set comes off, and the wider rule promotes the action again.
    const any = found(anyRow);
    expect(any.filter((f) => f.kind === 'tier').length).toBeGreaterThan(100);
    expect(any.some((f) => f.before === 'approval' && f.after.startsWith('alone'))).toBe(true);
    expect(any.some((f) => f.before === 'forbidden')).toBe(true);
    // Reading the tier alone: no tier ever loosens, but a row at alone with the lowest cap goes, and the cap with it.
    const alone = found(aloneOnly);
    expect(alone.filter((f) => f.kind === 'tier')).toEqual([]);
    expect(alone.filter((f) => f.kind === 'cap').length).toBeGreaterThan(10);
    // The real rule, over the same tables.
    expect(found(mayGoOff)).toEqual([]);
  }, 120_000);

  it('the reviewed cases, by name', () => {
    const row = (pattern: string, tier: Tier, dailyCap: number | null = null, more: Partial<Row> = {}): Row => ({ id: id('r'), pattern, tier, dailyCap, scope: null, active: true, expiresAt: FAR, ...more });
    const chat = (table: Row[], action = 'goal.propose') => said(resolveTier(action, { context: 'chat', tainted: false, policies: table.map(asPolicy), now: NOWS[1]! }));
    // Goals from chat: a wide rule promotes, a narrow one holds it at approval. The narrow one is the brake.
    const wide = row('goal.*', 'alone');
    const brake = row('goal.propose', 'approval');
    expect(chat([wide, brake])).toBe('approval');
    expect(chat([wide])).toBe('alone');
    expect(mayGoOff(brake, [wide, brake])).toBe(false);
    expect(mayGoOff(wide, [wide, brake])).toBe(true);
    expect(chat([brake])).toBe('approval');
    // A row at forbidden, and a scoped holding row (its scope is not read: any row may tighten).
    const never = row('goal.*', 'forbidden');
    expect(chat([wide, never])).toBe('forbidden');
    expect(mayGoOff(never, [wide, never])).toBe(false);
    const scopedBrake = row('goal.propose', 'approval', null, { scope: SCOPE_A });
    expect(chat([wide, scopedBrake])).toBe('approval');
    expect(mayGoOff(scopedBrake, [wide, scopedBrake])).toBe(false);
    // Two rows at alone: the lower cap is the one in force, so the row that carries it stays.
    const three = row('goal.propose', 'alone', 3);
    expect(chat([wide, three])).toBe('alone 3/day');
    expect(chat([wide])).toBe('alone');
    expect(mayGoOff(three, [wide, three])).toBe(false);
    expect(mayGoOff(wide, [wide, three])).toBe(true);
    expect(chat([three])).toBe('alone 3/day');
    // Alone, the capped row may go: the action is back to a card.
    expect(mayGoOff(three, [three])).toBe(true);
    expect(chat([])).toBe('approval');
    // Stricter than it has to be, by design: with a third row at alone under a lower cap the first could go safely, and is still refused.
    const one = row('goal.propose', 'alone', 1);
    expect(chat([wide, three, one])).toBe('alone 1/day');
    expect(chat([wide, one])).toBe('alone 1/day');
    expect(mayGoOff(three, [wide, three, one])).toBe(false);
  });
});

// ---- The database ----------------------------------------------------------------------------------------------

const REFUSED = (rid: string) => `policy row ${rid}: it holds something back, so only a card Will signed switches it off`;
const LEVEL = (rid: string) => `policy row ${rid}: a row is switched off at READ COMMITTED`;
const LEVELS = ['REPEATABLE READ', 'SERIALIZABLE'] as const;

interface RowSpec {
  pattern: string;
  tier: Tier;
  dailyCap?: number;
  scope?: Record<string, unknown>;
  /** When it ends (default: in 30 days). */
  expiresAt?: string;
}

describe.skipIf(NO_DB)('who may switch a policy row off (flint_test)', () => {
  let urls: TestUrls;
  let k: P5Kit;
  let app: Q;
  let owner: Q;
  let approver: Q;
  let family = 0;
  /** A family of action names no other test uses, so rows a test leaves on never meet another test's. */
  const fam = () => `pog${Date.now().toString(36)}${family++}`;
  const inDays = (n: number) => new Date(Math.floor(Date.now() / 1000) * 1000 + n * 86_400_000).toISOString();
  const failure = async (p: Promise<unknown>) => {
    const e = (await pgError(p)) as { code?: string; message: string; detail?: string };
    return [e.code, e.message, e.detail ?? null];
  };

  beforeAll(async () => {
    urls = await freshDb();
    k = await p5Kit(urls);
    ({ app, owner, approver } = k);
  });

  /** Rules Will signed: one policy.change card, approved and executing while the runtime's role writes the rows it lists. Their ids, in order. */
  async function rule(rows: RowSpec[], q: Q = app): Promise<string[]> {
    const listed = rows.map((r) => ({ ...r, expiresAt: r.expiresAt ?? inDays(30) }));
    const pc = await k.card('policy.change', { rows: listed }, { kind: 'policy' });
    const ids: string[] = [];
    for (const r of listed) {
      const rid = id('pol');
      ids.push(rid);
      await q(`INSERT INTO "ActionPolicy" (id, pattern, tier, "dailyCap", scope, reason, "approvalId", "expiresAt") VALUES ($1, $2, $3, $4, $5::jsonb, 'Synthetic rule', $6, $7)`, [
        rid, r.pattern, r.tier, r.dailyCap ?? null, r.scope ? JSON.stringify(r.scope) : null, pc.aid, r.expiresAt,
      ]);
    }
    await k.finish(pc.pid);
    return ids;
  }
  const switchOff = (rid: string, q: Q = app) => q(`UPDATE "ActionPolicy" SET active = false WHERE id = $1`, [rid]);
  const isOn = async (rid: string) => (await owner(`SELECT active FROM "ActionPolicy" WHERE id = $1`, [rid])).rows[0].active as boolean;
  const history = async (rid: string) => (await owner(`SELECT actor, changed FROM "RowChange" WHERE "tableName" = 'ActionPolicy' AND "rowId" = $1 ORDER BY at`, [rid])).rows as Array<{ actor: string; changed: unknown }>;
  /** How a card names a row to switch off. */
  const named = async (rid: string) => (await owner(`SELECT id, pattern, tier FROM "ActionPolicy" WHERE id = $1`, [rid])).rows[0] as { id: string; pattern: string; tier: string };
  /** The card that switches rows off, as the runtime files it for Will from the CLI, taken as far as `stage` (default: signed and executing). */
  const offCard = async (rids: string[], o: CardOptions = {}) => k.card('policy.change', { off: await Promise.all(rids.map(named)) }, { kind: 'policy', origin: 'cli', ...o });
  /** Everything a test left on goes off, as the owner: for the tests that use the real names (goal.propose, task.check_bar). */
  const clear = () => owner(`UPDATE "ActionPolicy" SET active = false WHERE active`);

  describe('a row that lets an action run alone', () => {
    it('goes off for the runtime’s role, and the action is back to a card; the row’s history says who', async () => {
      const f = fam();
      const [rid] = await rule([{ pattern: `${f}.sync`, tier: 'alone' }]);
      await k.inTx(async (q) => {
        await switchOff(rid!, q);
      }, { actor: 'runtime:test' });
      expect(await isOn(rid!)).toBe(false);
      expect(await history(rid!)).toEqual([{ actor: 'runtime:test', changed: { active: [true, false] } }]);
      // Off is for good, as before; switching it off again changes nothing and writes no history.
      expect(await failure(app(`UPDATE "ActionPolicy" SET active = true WHERE id = $1`, [rid]))).toEqual(['42501', `policy row ${rid}: it can only be switched off`, null]);
      await switchOff(rid!);
      expect((await history(rid!)).length).toBe(1);
    });

    it('with a cap, scoped, wide, ended or about to end: each goes off when no other row could run the same action under a higher cap', async () => {
      const f = fam();
      const ids = await rule([
        { pattern: `${f}.a`, tier: 'alone', dailyCap: 3 },
        { pattern: `${f}.b`, tier: 'alone', dailyCap: 0 },
        { pattern: `${f}.c`, tier: 'alone', scope: { endpoints: ['https://example.test'] } },
        { pattern: `${f}.wide.*`, tier: 'alone', dailyCap: 20 },
        { pattern: `${f}.d`, tier: 'alone', dailyCap: 5, expiresAt: new Date(Date.now() - 86_400_000).toISOString() },
        { pattern: `${f}.e`, tier: 'alone', expiresAt: new Date(Date.now() + 1_500).toISOString() },
      ]);
      for (const rid of ids) {
        await switchOff(rid);
        expect(await isOn(rid)).toBe(false);
      }
    });

    // The cap half of the rule, case by case. `F` is the test's own family of names.
    const cap = (pattern: string, dailyCap?: number, more: Partial<RowSpec> & { off?: boolean } = {}) => ({ pattern, tier: 'alone' as Tier, ...(dailyCap === undefined ? {} : { dailyCap }), ...more });
    const CASES: Array<[string, RowSpec, Array<RowSpec & { off?: boolean }>, 'goes off' | 'stays on']> = [
      ['the same rule signed again with no cap', cap('F.propose', 3), [cap('F.propose')], 'stays on'],
      ['the same rule under a higher cap', cap('F.propose', 3), [cap('F.propose', 5)], 'stays on'],
      ['the same rule under the same cap', cap('F.propose', 3), [cap('F.propose', 3)], 'goes off'],
      ['the same rule under a lower cap', cap('F.propose', 3), [cap('F.propose', 1)], 'goes off'],
      ['a cap of none at all against a cap of one', cap('F.propose', 0), [cap('F.propose', 1)], 'stays on'],
      ['a cap of one against a cap of none at all', cap('F.propose', 1), [cap('F.propose', 0)], 'goes off'],
      ['a wide rule with no cap over it', cap('F.propose', 3), [cap('F.*')], 'stays on'],
      ['a wide rule under a higher cap over it', cap('F.review.local', 3), [cap('F.review.*', 9)], 'stays on'],
      ['it is the wide rule, over a narrow one with no cap', cap('F.*', 3), [cap('F.propose')], 'stays on'],
      ['it is the wide rule, over a narrower wide one', cap('F.*', 3), [cap('F.review.*', 9)], 'stays on'],
      ['a neighbour with no cap that matches none of its actions', cap('F.propose', 3), [cap('F.review.local'), cap('F.review.*'), cap('F.prop'), cap('F.propose.more'), cap('Fx.*')], 'goes off'],
      ['a name is read letter by letter: `_` is no wildcard', cap('FxA.propose', 3), [cap('F_A.*')], 'goes off'],
      ['the looser rule is switched off', cap('F.propose', 3), [cap('F.propose', undefined, { off: true })], 'goes off'],
      ['the other rule holds the action back, cap or none', cap('F.propose', 3), [{ pattern: 'F.propose', tier: 'approval' }, { pattern: 'F.*', tier: 'forbidden', dailyCap: 9 }], 'goes off'],
      ['the looser rule has ended (its end is not read)', cap('F.propose', 3), [cap('F.propose', undefined, { expiresAt: new Date(Date.now() - 86_400_000).toISOString() })], 'stays on'],
      ['the looser rule is scoped (its scope is not read)', cap('F.propose', 3), [cap('F.propose', undefined, { scope: { endpoints: ['a'] } })], 'stays on'],
      ['it has no cap of its own, whatever else is there', cap('F.propose'), [cap('F.propose', 5), cap('F.*'), cap('F.propose', 1)], 'goes off'],
    ];
    it.each(CASES)('a capped row beside %s', async (_name, row, others, want) => {
      const f = fam();
      const mine = (r: RowSpec & { off?: boolean }): RowSpec => {
        const { off: _off, ...spec } = r;
        return { ...spec, pattern: r.pattern.replace(/^F/, f) };
      };
      const [rid, ...rest] = await rule([row, ...others].map(mine));
      for (const [i, o] of others.entries()) if (o.off) await switchOff(rest[i]!);
      if (want === 'goes off') {
        await switchOff(rid!);
        expect(await isOn(rid!)).toBe(false);
      } else {
        expect(await failure(switchOff(rid!))).toEqual(['42501', REFUSED(rid!), null]);
        expect(await isOn(rid!)).toBe(true);
        expect(await history(rid!)).toEqual([]);
        // The looser row may go first (the action then runs under this one's cap), and then this one (it is back to a card).
        for (const [i, o] of others.entries()) if (!o.off && o.tier === 'alone' && (o.dailyCap === undefined || o.dailyCap > (row.dailyCap ?? Infinity))) await switchOff(rest[i]!);
        await switchOff(rid!);
        expect(await isOn(rid!)).toBe(false);
      }
    });
  });

  describe('a row that holds an action back', () => {
    const past = () => new Date(Date.now() - 86_400_000).toISOString();
    const HOLDS: Array<[string, (f: string) => RowSpec]> = [
      ['an action at approval', (f) => ({ pattern: `${f}.propose`, tier: 'approval' })],
      ['an action at forbidden', (f) => ({ pattern: `${f}.propose`, tier: 'forbidden' })],
      ['a whole family at approval', (f) => ({ pattern: `${f}.*`, tier: 'approval' })],
      ['a whole family at forbidden', (f) => ({ pattern: `${f}.*`, tier: 'forbidden' })],
      ['the widest pattern there is, every tool of a server', (f) => ({ pattern: `mcp:${f}.*`, tier: 'forbidden' })],
      ['a scoped one', (f) => ({ pattern: `${f}.propose`, tier: 'approval', scope: { endpoints: ['https://example.test'] } })],
      ['one with a cap', (f) => ({ pattern: `${f}.propose`, tier: 'approval', dailyCap: 5 })],
      ['one with a cap of none', (f) => ({ pattern: `${f}.*`, tier: 'forbidden', dailyCap: 0 })],
      ['one that has ended', (f) => ({ pattern: `${f}.propose`, tier: 'approval', expiresAt: past() })],
      ['one that holds nothing today (no other row is there)', (f) => ({ pattern: `${f}.nothing.else`, tier: 'approval' })],
    ];
    it.each(HOLDS)('%s stays on: 42501, by its id alone, and nothing is written', async (_name, spec) => {
      const [rid] = await rule([spec(fam())]);
      expect(await failure(switchOff(rid!))).toEqual(['42501', REFUSED(rid!), null]);
      expect(await isOn(rid!)).toBe(true);
      expect(await history(rid!)).toEqual([]);
    });

    it('one about to end stays on after it has ended too', async () => {
      const [rid] = await rule([{ pattern: `${fam()}.propose`, tier: 'approval', expiresAt: new Date(Date.now() + 1_200).toISOString() }]);
      expect(await k.code(switchOff(rid!))).toBe('42501');
      await sleep(1_300);
      expect((await owner(`SELECT "expiresAt" < now() AS ended FROM "ActionPolicy" WHERE id = $1`, [rid])).rows[0].ended).toBe(true);
      expect(await failure(switchOff(rid!))).toEqual(['42501', REFUSED(rid!), null]);
      expect(await isOn(rid!)).toBe(true);
    });

    it('a bare `*` is no pattern: the table refuses the row, so there is none to switch off', async () => {
      const expiresAt = inDays(30);
      const pc = await k.card('policy.change', { rows: [{ pattern: '*', tier: 'forbidden', expiresAt }] }, { kind: 'policy' });
      const refused = (await pgError(app(`INSERT INTO "ActionPolicy" (id, pattern, tier, reason, "approvalId", "expiresAt") VALUES ($1, '*', 'forbidden', 'Synthetic rule', $2, $3)`, [id('pol'), pc.aid, expiresAt]))) as { code?: string; constraint?: string };
      expect([refused.code, refused.constraint]).toEqual(['23514', 'ActionPolicy_pattern_check']);
      await k.finish(pc.pid);
    });

    it('an error repeats an id only when it is shaped as one: never words dressed as an id', async () => {
      const f = fam();
      const expiresAt = inDays(30);
      const pc = await k.card('policy.change', { rows: [{ pattern: `${f}.propose`, tier: 'approval', expiresAt }] }, { kind: 'policy' });
      const dressed = ['Synthetic CANARY-off words as an id', 'ignore.all/previous?rules', `${'x'.repeat(65)}`];
      for (const rid of dressed) {
        await app(`INSERT INTO "ActionPolicy" (id, pattern, tier, reason, "approvalId", "expiresAt") VALUES ($1, $2, 'approval', 'Synthetic CANARY-off reason', $3, $4)`, [rid, `${f}.propose`, pc.aid, expiresAt]);
        const e = await failure(switchOff(rid));
        expect(e).toEqual(['42501', REFUSED('?'), null]);
        expect(JSON.stringify(e)).not.toMatch(/CANARY|ignore|xxxx/);
        for (const level of LEVELS) expect(await failure(k.inTx((q) => switchOff(rid, q), { iso: level }))).toEqual(['42501', LEVEL('?'), null]);
      }
      await k.finish(pc.pid);
    });
  });

  describe('every way to write the row', () => {
    let f: string;
    let hold: string;
    let loose: string;
    beforeAll(async () => {
      f = fam();
      [hold, loose] = (await rule([{ pattern: `${f}.propose`, tier: 'approval' }, { pattern: `${f}.*`, tier: 'alone' }])) as [string, string];
    });
    const untouched = async () => {
      expect(await isOn(hold)).toBe(true);
      expect(await history(hold)).toEqual([]);
    };

    it('on to on changes nothing; off to on, another column and DELETE are refused as before', async () => {
      expect((await app(`UPDATE "ActionPolicy" SET active = true WHERE id = $1`, [hold])).rowCount).toBe(1);
      await untouched();
      for (const set of [`tier = 'alone'`, `pattern = 'x.y'`, `"dailyCap" = 1`, `scope = '{}'`, `"expiresAt" = now()`, `"approvalId" = 'x'`, `reason = 'x'`, `id = 'x'`, `active = false, tier = 'alone'`]) {
        expect(await failure(app(`UPDATE "ActionPolicy" SET ${set} WHERE id = $1`, [hold])), set).toEqual(['42501', 'permission denied for table ActionPolicy', null]);
      }
      expect(await failure(app(`DELETE FROM "ActionPolicy" WHERE id = $1`, [hold]))).toEqual(['42501', 'permission denied for table ActionPolicy', null]);
      expect(await failure(app(`TRUNCATE "ActionPolicy"`))).toEqual(['42501', 'permission denied for table ActionPolicy', null]);
      // The owner is held to P1's own rules as before: nothing but `active` changes, and no row is deleted.
      expect((await pgError(owner(`UPDATE "ActionPolicy" SET tier = 'alone' WHERE id = $1`, [hold]))).message).toBe(`policy row ${hold}: it can only be switched off`);
      expect((await pgError(owner(`DELETE FROM "ActionPolicy" WHERE id = $1`, [hold]))).message).toBe('policy rows are switched off, never deleted');
      await untouched();
    });

    it('UPDATE ... FROM, a CTE, MERGE, a locked row and a statement over many rows are all the same switch-off', async () => {
      const statements: Array<[string, string, unknown[]]> = [
        ['UPDATE ... FROM', `UPDATE "ActionPolicy" t SET active = false FROM (VALUES ($1::text)) v(id) WHERE t.id = v.id`, [hold]],
        ['a CTE', `WITH x AS (UPDATE "ActionPolicy" SET active = false WHERE id = $1 RETURNING id) SELECT count(*) FROM x`, [hold]],
        ['MERGE', `MERGE INTO "ActionPolicy" t USING (SELECT $1::text AS id) s ON t.id = s.id WHEN MATCHED THEN UPDATE SET active = false`, [hold]],
        ['NOT active', `UPDATE "ActionPolicy" SET active = NOT active WHERE id = $1`, [hold]],
        ['a subselect', `UPDATE "ActionPolicy" SET active = (SELECT false) WHERE id IN (SELECT id FROM "ActionPolicy" WHERE pattern = $1 AND tier = 'approval')`, [`${f}.propose`]],
      ];
      for (const [name, sql, params] of statements) expect(await failure(app(sql, params)), name).toEqual(['42501', REFUSED(hold), null]);
      // Locked first, in one transaction.
      expect(await failure(k.inTx(async (q) => {
        await q(`SELECT 1 FROM "ActionPolicy" WHERE id = $1 FOR UPDATE`, [hold]);
        await switchOff(hold, q);
      }))).toEqual(['42501', REFUSED(hold), null]);
      // One statement over both rows: the holding row refuses it whole, and the row at alone stays on with it.
      expect(await k.code(app(`UPDATE "ActionPolicy" SET active = false WHERE id = ANY ($1)`, [[loose, hold]]))).toBe('42501');
      expect(await k.code(app(`UPDATE "ActionPolicy" SET active = false WHERE pattern LIKE $1`, [`${f}.%`]))).toBe('42501');
      expect(await isOn(loose)).toBe(true);
      await untouched();
    });

    it('an upsert onto its id: refused with no card, and refused as a switch-off under another card’s rows', async () => {
      const expiresAt = inDays(30);
      const upsert = (aid: string) => app(
        `INSERT INTO "ActionPolicy" (id, pattern, tier, reason, "approvalId", "expiresAt") VALUES ($1, $2, 'alone', 'Synthetic rule', $3, $4) ON CONFLICT (id) DO UPDATE SET active = false`,
        [hold, `${f}.other`, aid, expiresAt],
      );
      expect((await pgError(upsert('no-such-approval'))).code).toBe('42501');
      // A signed card that adds a row: its insert passes P1's check, meets the holding row's id, and is then a switch-off of that row.
      const pc = await k.card('policy.change', { rows: [{ pattern: `${f}.other`, tier: 'alone', expiresAt }] }, { kind: 'policy' });
      expect(await failure(upsert(pc.aid))).toEqual(['42501', REFUSED(hold), null]);
      await k.finish(pc.pid);
      await untouched();
    });

    it('the role cannot become the owner, set the guard aside, or reach the row through a function that runs as the owner', async () => {
      for (const sql of [
        'SET ROLE flint_owner', 'SET SESSION AUTHORIZATION flint_owner', `SET session_replication_role = 'replica'`,
        'ALTER TABLE "ActionPolicy" DISABLE TRIGGER "ActionPolicy_off_guard"', 'ALTER TABLE "ActionPolicy" DISABLE TRIGGER USER', 'DROP TRIGGER "ActionPolicy_off_guard" ON "ActionPolicy"',
        'DROP FUNCTION action_policy_off_guard() CASCADE', 'ALTER FUNCTION action_policy_off_guard() SECURITY DEFINER',
        `CREATE OR REPLACE FUNCTION action_policy_off_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END; $$`,
        `CREATE FUNCTION pog_as_owner() RETURNS void LANGUAGE sql SECURITY DEFINER AS $$ UPDATE "ActionPolicy" SET active = false $$`,
        'CREATE TEMP TABLE "Approval" (id text)', 'CREATE RULE pog_rule AS ON UPDATE TO "ActionPolicy" DO INSTEAD NOTHING',
        'SELECT action_policy_off_guard()',
      ]) {
        expect((await pgError(app(sql))).code, sql).toBe('42501');
      }
      // No function that runs as its owner writes or even names the policy table, so none can carry a switch-off for the
      // runtime's role. (There are such functions, and the role may run some: the check is not empty.)
      const definers = (await owner(
        `SELECT p.proname, p.prosrc ~ 'ActionPolicy' AS names_it, has_function_privilege('flint_app', p.oid, 'EXECUTE') AS runs FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname IN ('public', 'pgboss') AND p.prosecdef`)).rows as Array<{ proname: string; names_it: boolean; runs: boolean }>;
      expect(definers.filter((d) => d.names_it)).toEqual([]);
      expect(definers.filter((d) => d.runs).length).toBeGreaterThan(3);
      // The guard itself: the owner's, with its search path pinned, runs as whoever fires it, and nobody may call it.
      expect((await owner(
        `SELECT pg_get_userbyid(p.proowner) AS owner, p.prosecdef, array_to_string(p.proconfig, ';') AS config, coalesce(array_to_string(p.proacl, ','), '') AS acl
         FROM pg_proc p WHERE p.proname = 'action_policy_off_guard'`)).rows).toEqual([{ owner: 'flint_owner', prosecdef: false, config: 'search_path=public, pg_temp', acl: 'flint_owner=X/flint_owner' }]);
      expect((await owner(`SELECT tgenabled, tgtype FROM pg_trigger WHERE tgname = 'ActionPolicy_off_guard' AND NOT tgisinternal`)).rows).toEqual([{ tgenabled: 'O', tgtype: 19 }]);
      await untouched();
    });

    it('above READ COMMITTED nothing is switched off, a row at alone and a signed card’s row included', async () => {
      const [free] = await rule([{ pattern: `${fam()}.sync`, tier: 'alone' }]);
      const card = await offCard([hold]);
      for (const level of [...LEVELS, 'READ UNCOMMITTED']) {
        expect(await failure(k.inTx((q) => switchOff(free!, q), { iso: level })), level).toEqual(['42501', LEVEL(free!), null]);
        expect(await failure(k.inTx((q) => switchOff(hold, q), { iso: level })), level).toEqual(['42501', LEVEL(hold), null]);
        // Set for the session, not on BEGIN: the same.
        expect(await failure(withClient(urls.app, async (c) => {
          await c.query(`SET default_transaction_isolation = '${level.toLowerCase()}'`);
          await c.query(`UPDATE "ActionPolicy" SET active = false WHERE id = $1`, [free]);
        })), level).toEqual(['42501', LEVEL(free!), null]);
      }
      expect(await isOn(free!)).toBe(true);
      await untouched();
      // At READ COMMITTED, said outright: the row at alone goes, and the card's row goes.
      await k.inTx((q) => switchOff(free!, q), { iso: 'READ COMMITTED' });
      await k.inTx((q) => switchOff(hold, q), { iso: 'READ COMMITTED' });
      expect([await isOn(free!), await isOn(hold)]).toEqual([false, false]);
      await k.finish(card.pid);
    });
  });

  describe('a card Will signed', () => {
    it('switches off the row it names, and only that row; once its card has ended it switches off nothing more', async () => {
      const f = fam();
      const [hold, other, never] = (await rule([{ pattern: `${f}.propose`, tier: 'approval' }, { pattern: `${f}.propose`, tier: 'approval' }, { pattern: `${f}.*`, tier: 'forbidden' }])) as [string, string, string];
      const card = await offCard([hold, never]);
      // A row the card does not name, however alike.
      expect(await failure(switchOff(other))).toEqual(['42501', REFUSED(other), null]);
      await k.inTx(async (q) => {
        await switchOff(hold, q);
      }, { actor: `will:approval:${card.aid}` });
      expect(await isOn(hold)).toBe(false);
      expect(await history(hold)).toEqual([{ actor: `will:approval:${card.aid}`, changed: { active: [true, false] } }]);
      // The card ends with one of its rows still on: that row stays on.
      await k.finish(card.pid);
      expect(await failure(switchOff(never))).toEqual(['42501', REFUSED(never), null]);
      expect(await isOn(never)).toBe(true);
      // A new card for it, and it goes. A card may name a row at alone too.
      const [free] = await rule([{ pattern: `${f}.free`, tier: 'alone', dailyCap: 2 }, { pattern: `${f}.free`, tier: 'alone' }]);
      expect(await k.code(switchOff(free!))).toBe('42501');
      const again = await offCard([never, free!]);
      await switchOff(never);
      await switchOff(free!);
      expect([await isOn(never), await isOn(free!)]).toEqual([false, false]);
      await k.finish(again.pid);
    });

    it('names the row by its id, its pattern and its tier: a card that gets one of them wrong switches nothing off', async () => {
      const f = fam();
      const [hold, twin] = (await rule([{ pattern: `${f}.propose`, tier: 'approval' }, { pattern: `${f}.other`, tier: 'forbidden' }])) as [string, string];
      const me = await named(hold);
      const wrong: Array<[string, Record<string, unknown>]> = [
        ['another row’s id', { off: [{ ...me, id: twin }] }],
        ['an id that is no row', { off: [{ ...me, id: id('pol') }] }],
        ['another pattern', { off: [{ ...me, pattern: `${f}.*` }] }],
        ['another tier', { off: [{ ...me, tier: 'forbidden' }] }],
        ['no pattern', { off: [{ id: me.id, tier: me.tier }] }],
        ['no tier', { off: [{ id: me.id, pattern: me.pattern }] }],
        ['the id alone, as text', { off: [me.id] }],
        ['not a list', { off: me }],
        ['a list inside a list', { off: [[me]] }],
        ['under rows, not off', { rows: [me] }],
        ['under another name', { switchOff: [me] }],
        ['nothing', { off: [] }],
      ];
      for (const [name, args] of wrong) {
        const card = await k.card('policy.change', args, { kind: 'policy', origin: 'cli' });
        expect(await failure(switchOff(hold)), name).toEqual(['42501', REFUSED(hold), null]);
        await k.finish(card.pid);
      }
      expect(await isOn(hold)).toBe(true);
      // More said about the row than the three is still that row (the card's own check keeps such a card from being filed).
      const more = await k.card('policy.change', { off: [{ ...me, note: 'Synthetic note' }] }, { kind: 'policy', origin: 'cli' });
      await switchOff(hold);
      expect(await isOn(hold)).toBe(false);
      await k.finish(more.pid);
    });

    it('acts only while it is being carried out: not waiting, approved, run, failed, rejected or expired', async () => {
      const [hold] = (await rule([{ pattern: `${fam()}.propose`, tier: 'approval' }])) as [string];
      const refused = async (what: string) => expect(await failure(switchOff(hold)), what).toEqual(['42501', REFUSED(hold), null]);
      const waiting = await offCard([hold], { stage: 'pending' });
      await refused('waiting');
      await app(`UPDATE "Proposal" SET status = 'rejected', error = 'Synthetic end' WHERE id = $1`, [waiting.pid]);
      await refused('rejected');
      const approved = await offCard([hold], { stage: 'approved' });
      await refused('approved');
      await app(`UPDATE "Proposal" SET status = 'failed', error = 'Synthetic end', "executedAt" = now() WHERE id = $1`, [approved.pid]);
      await refused('failed');
      await offCard([hold], { stage: 'executed' });
      await refused('already run');
      const short = await offCard([hold], { stage: 'pending', life: '1 second' });
      await sleep(1_100);
      await app(`UPDATE "Proposal" SET status = 'expired' WHERE id = $1`, [short.pid]);
      await refused('expired');
      expect(await isOn(hold)).toBe(true);
    });

    // Each line is a card that is all a signed switch-off must be but for one thing.
    const NOT_CARDS: Array<[string, (hold: string) => Promise<{ pid: string }>]> = [
      ['of another action', async (hold) => k.card('world.source.enable', { off: [await named(hold)] }, { kind: 'policy', origin: 'cli', consequential: true })],
      ['of another kind', async (hold) => offCard([hold], { kind: 'tool_call' })],
      ['from a chat', async (hold) => offCard([hold], { origin: 'chat:console-1' })],
      ['from one of the runtime’s own jobs', async (hold) => offCard([hold], { origin: 'runtime:goals' })],
      ['with outside text in it', async (hold) => offCard([hold], { tainted: true })],
      ['that outlives Will’s approval by more than 7 days', async (hold) => offCard([hold], { life: '7 days 1 hour' })],
      ['filed under a digest that is not its args’ digest', async (hold) => offCard([hold], { digest: digestOf({ off: [{ id: 'another', pattern: 'x.y', tier: 'alone' }] }) })],
      ['whose args have no digest (a number that is not whole)', async (hold) => {
        const args = { off: [await named(hold)], weight: 0.5 };
        return k.card('policy.change', args, { kind: 'policy', origin: 'cli', digest: HEX('d') });
      }],
    ];
    it.each(NOT_CARDS)('a card %s switches nothing off', async (_name, make) => {
      const [hold] = (await rule([{ pattern: `${fam()}.propose`, tier: 'approval' }])) as [string];
      const card = await make(hold);
      expect(await failure(switchOff(hold))).toEqual(['42501', REFUSED(hold), null]);
      expect(await isOn(hold)).toBe(true);
      await k.finish(card.pid);
    });

    it('a card not marked for Will’s own touch (one from before that floor) switches nothing off', async () => {
      const [hold] = (await rule([{ pattern: `${fam()}.propose`, tier: 'approval' }])) as [string];
      const args = { off: [await named(hold)] };
      const filed = await k.without('Proposal_policy_floor', (q) => k.file('policy.change', args, { kind: 'policy', origin: 'cli', consequential: false }, q));
      const card = await k.sign(filed, 'policy.change');
      expect((await owner(`SELECT status, consequential FROM "Proposal" WHERE id = $1`, [card.pid])).rows).toEqual([{ status: 'executing', consequential: false }]);
      expect(await failure(switchOff(hold))).toEqual(['42501', REFUSED(hold), null]);
      await k.finish(card.pid);
    });

    it('a card signed under a key that has since been revoked switches nothing off', async () => {
      const [hold] = (await rule([{ pattern: `${fam()}.propose`, tier: 'approval' }])) as [string];
      const credential = id('cred');
      await approver(`INSERT INTO "ApprovalCredential" (id, "credentialId", factor, "publicKey", label, "enrolledVia") VALUES ($1, $2, 'webauthn', '\\x00', 'Synthetic old key', 'enroll_code')`, [id(), credential]);
      const card = await offCard([hold], { credential });
      await approver(`UPDATE "ApprovalCredential" SET "revokedAt" = now() WHERE "credentialId" = $1`, [credential]);
      expect(await failure(switchOff(hold))).toEqual(['42501', REFUSED(hold), null]);
      expect(await isOn(hold)).toBe(true);
      await k.finish(card.pid);
    });

    it('a card that has expired while it was being carried out switches nothing off', async () => {
      const [hold] = (await rule([{ pattern: `${fam()}.propose`, tier: 'approval' }])) as [string];
      const card = await offCard([hold], { life: '1 second' });
      await sleep(1_100);
      expect((await owner(`SELECT status, "expiresAt" < clock_timestamp() AS over FROM "Proposal" WHERE id = $1`, [card.pid])).rows).toEqual([{ status: 'executing', over: true }]);
      expect(await failure(switchOff(hold))).toEqual(['42501', REFUSED(hold), null]);
      expect(await isOn(hold)).toBe(true);
      await k.finish(card.pid);
    });

    // What P1's own rules already keep from happening, held here as well: a card whose approval is not Will's yes to
    // this very card, for this action and these args. Made as the owner, with P1's card rules set aside for the one
    // statement (the state a changed backup could bring; a restore checks for it too).
    const FORGED: Array<[string, (pid: string, digest: string) => Promise<string>]> = [
      ['his signed no', (pid, digest) => k.approval(pid, 'policy.change', digest, { decision: 'reject' })],
      ['a signature on something that is not a card', (pid, digest) => k.approval(pid, 'policy.change', digest, { subjectType: 'policy' })],
      ['his yes to another card', async (_pid, digest) => k.approval((await k.file('policy.change', { off: [{ id: 'another', pattern: 'x.y', tier: 'alone' }] }, { kind: 'policy', origin: 'cli' })).pid, 'policy.change', digest)],
      ['his yes to another action', (pid, digest) => k.approval(pid, 'world.source.enable', digest)],
      ['his yes to other args', (pid) => k.approval(pid, 'policy.change', digestOf({ off: [{ id: 'another', pattern: 'x.y', tier: 'alone' }] }))],
    ];
    it.each(FORGED)('a card carried out under %s switches nothing off', async (_name, approve) => {
      const [hold] = (await rule([{ pattern: `${fam()}.propose`, tier: 'approval' }])) as [string];
      const filed = await k.file('policy.change', { off: [await named(hold)] }, { kind: 'policy', origin: 'cli' });
      const aid = await approve(filed.pid, filed.digest);
      await k.without('Proposal_transition', (q) => q(`UPDATE "Proposal" SET status = 'executing', "approvalId" = $2 WHERE id = $1`, [filed.pid, aid]));
      expect((await owner(`SELECT status, "approvalId" FROM "Proposal" WHERE id = $1`, [filed.pid])).rows).toEqual([{ status: 'executing', approvalId: aid }]);
      expect(await failure(switchOff(hold))).toEqual(['42501', REFUSED(hold), null]);
      expect(await isOn(hold)).toBe(true);
      await k.finish(filed.pid);
    });

    it('the stored args changed after he signed (as the owner, past P1’s rule): the card he signed for one row does not switch off another', async () => {
      const f = fam();
      const [mine, target] = (await rule([{ pattern: `${f}.a`, tier: 'approval' }, { pattern: `${f}.b`, tier: 'forbidden' }])) as [string, string];
      const card = await offCard([mine]);
      await k.without('Proposal_transition', (q) => q(`UPDATE "Proposal" SET args = $2::jsonb WHERE id = $1`, [card.pid, JSON.stringify({ off: [{ id: target, pattern: `${f}.b`, tier: 'forbidden' }] })]));
      expect(await failure(switchOff(target))).toEqual(['42501', REFUSED(target), null]);
      // Nor the row it first named: the args are no longer what he signed.
      expect(await failure(switchOff(mine))).toEqual(['42501', REFUSED(mine), null]);
      await k.finish(card.pid);
    });
  });

  describe('the owner', () => {
    it('is not held to it (a restore, a repair by hand), at any isolation level; P1’s rules still hold it', async () => {
      const f = fam();
      const [a, b] = (await rule([{ pattern: `${f}.propose`, tier: 'approval' }, { pattern: `${f}.*`, tier: 'forbidden' }])) as [string, string];
      await switchOff(a, owner);
      await k.inTx((q) => switchOff(b, q), { url: urls.owner, iso: 'SERIALIZABLE' });
      expect([await isOn(a), await isOn(b)]).toEqual([false, false]);
      expect((await pgError(owner(`UPDATE "ActionPolicy" SET active = true WHERE id = $1`, [a]))).message).toBe(`policy row ${a}: it can only be switched off`);
    });
  });

  describe('the floors that stand on a row that holds back', () => {
    const TITLE = 'Synthetic CANARY-off run a half marathon';
    const QUOTE = 'Synthetic CANARY-off I want to run a half marathon by spring';
    const SAID = '2026-10-08T15:00:00.000Z';

    it('goals from chat: with goal.* at alone and goal.propose at approval, the runtime cannot open the way; Will’s card does', async () => {
      await clear();
      const [, brake] = (await rule([{ pattern: 'goal.*', tier: 'alone', dailyCap: 3 }, { pattern: 'goal.propose', tier: 'approval' }])) as [string, string];
      const source = () => `chat:${createHash('sha256').update(id()).digest('hex')}`;
      /** The intake's own audit entry and then the goal, as the runtime's role writes both under a rule. */
      const add = async (src: string) => {
        const gid = suggestionGoalId(src);
        const args = { goalId: gid, title: TITLE, quote: QUOTE, saidAt: SAID, sourceRef: src };
        await app(
          `INSERT INTO "AuditEntry" (id, actor, context, kind, action, tier, inputs, decision, outcome, "correlationId", tainted) VALUES ($1, 'runtime:goals.candidates', 'chat', 'action', 'goal.propose', 'alone', $2::jsonb, 'act', 'ok', $3, false)`,
          [id('au'), JSON.stringify({ sourceRef: src, goalId: gid, saidAt: SAID, argsDigest: digestOf(args), rule: 'policy' }), src],
        );
        return app(
          `INSERT INTO "Goal" (id, title, description, owner, origin, sensitivity, tainted, "sourceRef", "successCriteria", "reviewCadence", "updatedAt") VALUES ($1, $2, $3, 'will', 'flint', 'personal', false, $4, '[]'::jsonb, 'P1W', now())`,
          [gid, TITLE, QUOTE, src],
        );
      };
      const goals = async () => (await owner(`SELECT count(*)::int AS n FROM "Goal" WHERE origin = 'flint'`)).rows[0].n as number;
      // Held back: nothing lands.
      expect(await k.code(add(source()))).toBe('42501');
      // What the review found: the runtime's role switched the brake off and the same insert then landed. Not any more.
      expect(await failure(switchOff(brake))).toEqual(['42501', REFUSED(brake), null]);
      expect(await k.code(add(source()))).toBe('42501');
      expect(await goals()).toBe(0);
      // Will signs the brake off, and the rule that promotes goals from chat lets one in.
      const card = await offCard([brake]);
      await switchOff(brake);
      await k.finish(card.pid);
      await add(source());
      expect(await goals()).toBe(1);
      await clear();
    });

    it('P5: with task.check_bar at alone and task.* at approval, Flint accepts nothing on its own until Will’s card switches the brake off', async () => {
      await clear();
      const a = await k.onAsset();
      const [alone, brake] = (await rule([{ pattern: 'task.check_bar', tier: 'alone' }, { pattern: 'task.*', tier: 'approval' }])) as [string, string];
      const t = await k.taskAt('checked', a);
      const proof = await k.proof(t.id);
      const accept = () => k.setStatus(app, t.id, 'accepted', `, "acceptedAuditId" = $3`, [proof]);
      expect(await k.code(accept())).toBe('42501');
      // The limit P5 shipped with: the runtime switched the brake off and accepted under the row that promotes it.
      expect(await failure(switchOff(brake))).toEqual(['42501', REFUSED(brake), null]);
      expect(await k.code(accept())).toBe('42501');
      expect((await k.one(`SELECT status FROM "Task" WHERE id = $1`, [t.id])).status).toBe('checking');
      // Will's card switches it off; the promotion then stands, and Flint accepts what passed.
      const card = await offCard([brake]);
      await switchOff(brake);
      await k.finish(card.pid);
      await accept();
      expect((await k.one(`SELECT status FROM "Task" WHERE id = $1`, [t.id])).status).toBe('accepted');
      // The promotion itself is the runtime's to take back at any time: acceptance is then Will's card again.
      await switchOff(alone);
      const later = await k.taskAt('checked', a);
      expect(await k.code(k.setStatus(app, later.id, 'accepted', `, "acceptedAuditId" = $3`, [await k.proof(later.id)]))).toBe('42501');
      await clear();
    });
  });

  describe('rows from before the migration', () => {
    it('are held like new ones: what was on stays under the rule, and what was switched off stays off', async () => {
      const f = fam();
      const before = await withoutPolicyOffGuard(urls.owner, async () => {
        const ids = await rule([
          { pattern: `${f}.free`, tier: 'alone' },
          { pattern: `${f}.capped`, tier: 'alone', dailyCap: 3 },
          { pattern: `${f}.capped`, tier: 'alone' },
          { pattern: `${f}.propose`, tier: 'approval' },
          { pattern: `${f}.*`, tier: 'forbidden' },
          { pattern: `${f}.ended`, tier: 'approval', expiresAt: new Date(Date.now() - 86_400_000).toISOString() },
          { pattern: `${f}.gone`, tier: 'approval' },
          { pattern: `${f}.gone.too`, tier: 'alone' },
        ]);
        // Without the guard the runtime's role switches a holding row off: what this migration closes.
        await switchOff(ids[6]!);
        await switchOff(ids[7]!);
        expect((await owner(`SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = 'ActionPolicy_off_guard'`)).rows[0].n).toBe(0);
        return ids;
      });
      const [free, capped, uncapped, hold, never, ended, gone, goneToo] = before as [string, string, string, string, string, string, string, string];
      expect((await owner(`SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = 'ActionPolicy_off_guard' AND tgenabled = 'O'`)).rows[0].n).toBe(1);
      for (const rid of [hold, never, ended, capped]) {
        expect(await failure(switchOff(rid)), rid).toEqual(['42501', REFUSED(rid), null]);
        expect(await isOn(rid)).toBe(true);
      }
      // Off before, off now, and never on again.
      expect([await isOn(gone), await isOn(goneToo)]).toEqual([false, false]);
      await switchOff(gone);
      expect((await pgError(app(`UPDATE "ActionPolicy" SET active = true WHERE id = $1`, [gone]))).message).toBe(`policy row ${gone}: it can only be switched off`);
      // What may go, goes; and a card signed now covers a row made then.
      await switchOff(free);
      await switchOff(uncapped);
      await switchOff(capped);
      const card = await offCard([hold, never, ended]);
      for (const rid of [hold, never, ended]) await switchOff(rid);
      await k.finish(card.pid);
      for (const rid of [free, capped, uncapped, hold, never, ended]) expect(await isOn(rid), rid).toBe(false);
    });
  });

  describe('the database is the rule', () => {
    let ownerC: pg.Client;
    let appC: pg.Client;
    beforeAll(async () => {
      ownerC = new pg.Client(pgConfig(urls.owner));
      appC = new pg.Client(pgConfig(urls.app));
      await ownerC.connect();
      await appC.connect();
    });
    afterAll(async () => {
      await ownerC?.end();
      await appC?.end();
    });

    it('150 random tables, asked row by row as the runtime’s role: it allows exactly the rows the rule allows, and none of them loosens anything', async () => {
      const r = rng(424242);
      // The database's clock, for rows that have ended or are about to: the engine is then asked at these same moments.
      const now = Date.now();
      const at = { ended: new Date(now - 86_400_000), soon: new Date(now + 3_600_000), far: new Date(Math.floor(now / 1000) * 1000 + 90 * 86_400_000) };
      const nows = [new Date(now - 2 * 86_400_000), new Date(now), new Date(now + 2 * 3_600_000)];
      let allowed = 0;
      let refused = 0;
      const bad: Found[] = [];
      const differs: string[] = [];
      for (let n = 0; n < 150; n++) {
        const table = randomTable(r, n).map((row) => ({ ...row, id: id('pol'), expiresAt: row.expiresAt === FAR ? at.far : row.expiresAt === SOON ? at.soon : at.ended }));
        await ownerC.query(`UPDATE "ActionPolicy" SET active = false WHERE active`);
        // The table as Will would have signed it: one card, its rows written by the runtime's role while it runs.
        const pc = await k.card('policy.change', { rows: table.map((row) => ({ pattern: row.pattern, tier: row.tier, ...(row.dailyCap === null ? {} : { dailyCap: row.dailyCap }), ...(row.scope ? { scope: row.scope } : {}), expiresAt: row.expiresAt.toISOString() })) }, { kind: 'policy' });
        for (const row of table) {
          await appC.query(`INSERT INTO "ActionPolicy" (id, pattern, tier, "dailyCap", scope, reason, "approvalId", "expiresAt") VALUES ($1, $2, $3, $4, $5::jsonb, 'Synthetic rule', $6, $7)`, [
            row.id, row.pattern, row.tier, row.dailyCap, row.scope ? JSON.stringify(row.scope) : null, pc.aid, row.expiresAt.toISOString(),
          ]);
        }
        await appC.query(`UPDATE "Proposal" SET status = 'executed', "executedAt" = now() WHERE id = $1`, [pc.pid]);
        const off = table.filter((row) => !row.active).map((row) => row.id);
        if (off.length) await ownerC.query(`UPDATE "ActionPolicy" SET active = false WHERE id = ANY ($1)`, [off]);
        for (const row of table.filter((x) => x.active)) {
          await appC.query('BEGIN');
          const says = await appC.query(`UPDATE "ActionPolicy" SET active = false WHERE id = $1`, [row.id]).then(() => 'ok', (e: { code?: string }) => e.code ?? 'error');
          await appC.query('ROLLBACK');
          const rule = mayGoOff(row, table);
          if ((says === 'ok') !== rule || (says !== 'ok' && says !== '42501')) differs.push(`table ${n}: ${row.pattern} ${row.tier} cap ${row.dailyCap}: the database says ${says}, the rule says ${rule}`);
          if (says === 'ok') {
            allowed++;
            bad.push(...loosenings(table, row, nows));
          } else refused++;
        }
      }
      expect(differs).toEqual([]);
      expect(bad.slice(0, 5)).toEqual([]);
      expect(allowed).toBeGreaterThan(100);
      expect(refused).toBeGreaterThan(100);
      await ownerC.query(`UPDATE "ActionPolicy" SET active = false WHERE active`);
    }, 180_000);
  });
});

// ---- The runtime's own path ------------------------------------------------------------------------------------

describe.skipIf(NO_DB)('a signed switch-off, as the runtime files and carries it out', () => {
  let urls: TestUrls;
  let db: ReturnType<typeof createDb>;
  let key: Awaited<ReturnType<typeof enrollTestKey>>;
  let k: P5Kit;
  let n = 0;
  const fam = () => `run${Date.now().toString(36)}${n++}`;

  beforeAll(async () => {
    urls = await freshDb();
    db = createDb(urls.app);
    key = await enrollTestKey(urls);
    k = await p5Kit(urls);
  });
  afterAll(async () => db?.$disconnect());

  /** Rules Will signed, through the runtime itself: a policy change filed, approved with his key and run. */
  async function rules(rows: Array<{ pattern: string; tier: Tier; dailyCap?: number }>) {
    const expiresAt = new Date(Math.floor(Date.now() / 1000) * 1000 + 30 * 86_400_000).toISOString();
    const p = await createProposal(db, {
      kind: 'policy', origin: 'cli', action: 'policy.change', args: { rows: rows.map((r) => ({ ...r, expiresAt })) }, argsProvenance: {}, tainted: false, sensitivity: 'ops',
      destructive: false, consequential: false, ttlMinutes: 60,
    }, 'will:cli');
    await approveProposal(db, p.id, await key.approve({ subjectId: p.id, action: 'policy.change', argsDigest: p.argsDigest }), undefined, 'will:console');
    await runInternal(db, p.id, undefined, 'UTC', 'will:console');
    const made = await db.actionPolicy.findMany({ where: { approvalId: (await db.proposal.findUniqueOrThrow({ where: { id: p.id } })).approvalId! } });
    // In the order asked for (rows written in one transaction share their time).
    return rows.map((r) => made.find((m) => m.pattern === r.pattern && m.tier === r.tier)!);
  }
  const offArgs = (rows: Array<{ id: string; pattern: string; tier: string }>) => ({ off: rows.map((r) => ({ id: r.id, pattern: r.pattern, tier: r.tier })) });
  const file = (args: Record<string, unknown>, over: Record<string, unknown> = {}) => createProposal(db, {
    kind: 'policy', origin: 'cli', action: 'policy.change', args, argsProvenance: {}, tainted: false, sensitivity: 'ops', destructive: false, consequential: false, ttlMinutes: 60, ...over,
  } as Parameters<typeof createProposal>[1], 'will:cli');
  const entries = async (pid: string) => (await k.owner(`SELECT kind, outcome FROM "AuditEntry" WHERE "correlationId" = $1 ORDER BY seq`, [pid])).rows as Array<{ kind: string; outcome: string }>;

  it('filed, signed and run: the rows it names go off whole, the card says how many, and each row’s history names the approval', async () => {
    const f = fam();
    const [wide, brake, never] = await rules([{ pattern: `${f}.*`, tier: 'alone' }, { pattern: `${f}.propose`, tier: 'approval' }, { pattern: `${f}.void`, tier: 'forbidden' }]);
    const p = await file(offArgs([brake!, never!]));
    // It asks on its own, whatever the filer said.
    expect((await db.proposal.findUniqueOrThrow({ where: { id: p.id } })).consequential).toBe(true);
    // Filed is not switched off: both rows hold until it is signed and run.
    expect(await db.actionPolicy.count({ where: { id: { in: [brake!.id, never!.id] }, active: true } })).toBe(2);
    const approvalId = await key.approve({ subjectId: p.id, action: 'policy.change', argsDigest: p.argsDigest });
    await approveProposal(db, p.id, approvalId, undefined, 'will:console');
    expect(await db.actionPolicy.count({ where: { id: { in: [brake!.id, never!.id] }, active: true } })).toBe(2);
    expect(await runInternal(db, p.id, undefined, 'UTC', 'will:console')).toEqual({ off: 2 });
    expect(await db.actionPolicy.count({ where: { id: { in: [brake!.id, never!.id] }, active: true } })).toBe(0);
    expect((await db.actionPolicy.findUniqueOrThrow({ where: { id: wide!.id } })).active).toBe(true);
    const card = await db.proposal.findUniqueOrThrow({ where: { id: p.id } });
    expect([card.status, card.result]).toEqual(['executed', { off: 2 }]);
    expect((await entries(p.id)).map((e) => `${e.kind} ${e.outcome}`)).toEqual(['decision pending', 'approval ok', 'intent pending', 'action ok']);
    expect((await k.owner(`SELECT DISTINCT actor FROM "RowChange" WHERE "rowId" = ANY ($1)`, [[brake!.id, never!.id]])).rows).toEqual([{ actor: `will:approval:${approvalId}` }]);
    // Run once: asked again, the card has already run, and nothing more happens.
    await expect(runInternal(db, p.id, undefined, 'UTC', 'will:console')).rejects.toMatchObject({ status: 409, message: 'It already ran.' });
  });

  it('a card that could not apply is never filed: not Will’s own card, a row that is not there or not as written, one already off, or both kinds of change at once', async () => {
    const f = fam();
    const [brake, gone] = await rules([{ pattern: `${f}.propose`, tier: 'approval' }, { pattern: `${f}.gone`, tier: 'alone' }]);
    await k.app(`UPDATE "ActionPolicy" SET active = false WHERE id = $1`, [gone!.id]);
    const ok = offArgs([brake!]);
    await expect(file(ok, { kind: 'tool_call' })).rejects.toMatchObject({ status: 400, message: POLICY_OFF_SAYS.card });
    await expect(file(ok, { origin: 'chat:console-1' })).rejects.toMatchObject({ status: 400, message: POLICY_OFF_SAYS.card });
    await expect(file(ok, { origin: 'runtime:goals', templateId: 'x' })).rejects.toMatchObject({ status: 400, message: POLICY_OFF_SAYS.card });
    await expect(file(ok, { tainted: true })).rejects.toMatchObject({ status: 400, message: POLICY_OFF_SAYS.card });
    await expect(file({ off: [{ id: 'no-such-row', pattern: `${f}.propose`, tier: 'approval' }] })).rejects.toMatchObject({ status: 400, message: POLICY_OFF_SAYS.unknown });
    await expect(file({ off: [{ ...ok.off[0]!, tier: 'forbidden' }] })).rejects.toMatchObject({ status: 400, message: POLICY_OFF_SAYS.unknown });
    await expect(file({ off: [{ ...ok.off[0]!, pattern: `${f}.*` }] })).rejects.toMatchObject({ status: 400, message: POLICY_OFF_SAYS.unknown });
    await expect(file(offArgs([gone!]))).rejects.toMatchObject({ status: 409, message: POLICY_OFF_SAYS.alreadyOff });
    for (const bad of [{ off: [] }, { off: [ok.off[0], ok.off[0]] }, { off: [{ id: brake!.id }] }, { off: [{ ...ok.off[0]!, note: 'x' }] }, { ...ok, rows: [] }, { ...ok, also: 1 }, { off: 'all' }, { off: [{ ...ok.off[0]!, id: 'not an id' }] }]) {
      await expect(file(bad as Record<string, unknown>), JSON.stringify(bad)).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/^invalid policy change: /) });
    }
    expect(await db.proposal.count({ where: { action: 'policy.change', status: 'pending' } })).toBe(0);
    expect((await db.actionPolicy.findUniqueOrThrow({ where: { id: brake!.id } })).active).toBe(true);
  });

  it('a row that went off after the card was filed is left as it is, and the rest still go', async () => {
    const f = fam();
    const [a, b] = await rules([{ pattern: `${f}.a`, tier: 'alone' }, { pattern: `${f}.b`, tier: 'approval' }]);
    const p = await file(offArgs([a!, b!]));
    await k.app(`UPDATE "ActionPolicy" SET active = false WHERE id = $1`, [a!.id]);
    await approveProposal(db, p.id, await key.approve({ subjectId: p.id, action: 'policy.change', argsDigest: p.argsDigest }), undefined, 'will:console');
    expect(await runInternal(db, p.id, undefined, 'UTC', 'will:console')).toEqual({ off: 1 });
    expect(await db.actionPolicy.count({ where: { id: { in: [a!.id, b!.id] }, active: true } })).toBe(0);
  });

  it('refused by the database: one sentence, the card failed and on record as failed, the row still on, and no second try', async () => {
    const f = fam();
    const [brake, free] = await rules([{ pattern: `${f}.propose`, tier: 'approval' }, { pattern: `${f}.free`, tier: 'alone' }]);
    // A card the runtime would never file (from a chat), written straight into the table as a runtime gone wrong could,
    // and signed: the runtime's own checks pass it on, and the database is what refuses.
    const args = offArgs([free!, brake!]);
    const pid = id('prop');
    await k.app(
      `INSERT INTO "Proposal" (id, kind, origin, action, args, "argsDigest", "argsProvenance", sensitivity, consequential, "expiresAt") VALUES ($1, 'policy', 'chat:console-1', 'policy.change', $2::jsonb, $3, '{}', 'ops', true, now() + interval '1 hour')`,
      [pid, JSON.stringify(args), digestOf(args)],
    );
    await approveProposal(db, pid, await key.approve({ subjectId: pid, action: 'policy.change', argsDigest: digestOf(args) }), undefined, 'will:console');
    const logged: string[] = [];
    const error = console.error;
    console.error = (...a: unknown[]) => void logged.push(a.join(' '));
    try {
      await expect(runInternal(db, pid, undefined, 'UTC', 'will:console')).rejects.toMatchObject({ name: 'Refused', status: 409, message: POLICY_OFF_REFUSED });
    } finally {
      console.error = error;
    }
    // All rows or none: the row at alone named beside it stays on too.
    expect(await db.actionPolicy.count({ where: { id: { in: [brake!.id, free!.id] }, active: true } })).toBe(2);
    const card = await db.proposal.findUniqueOrThrow({ where: { id: pid } });
    expect(card.status).toBe('failed');
    expect(card.error).toMatch(/^could not carry it out \(err[a-z0-9]+\)$/);
    expect((await entries(pid)).map((e) => `${e.kind} ${e.outcome}`)).toEqual(['approval ok', 'intent pending', 'action failed']);
    // The log says what failed by its class and SQLSTATE, never the database's own words.
    expect(logged.join('\n')).toMatch(/running policy\.change failed: .*42501/);
    expect(logged.join('\n')).not.toMatch(/holds something back|policy row/);
    // Asked again, it has failed: nothing is retried.
    await expect(runInternal(db, pid, undefined, 'UTC', 'will:console')).rejects.toMatchObject({ status: 409, message: 'It already failed.' });
    expect((await entries(pid)).length).toBe(3);
  });
});
