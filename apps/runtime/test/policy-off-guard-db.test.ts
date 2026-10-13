/**
 * Who may switch a policy row off (migration policy_off_guard): what a runtime
 * that breaks its own rules still cannot do, and why the rule is the right one.
 *
 * The rule, from how the tier engine reads the rows (@flint/policy resolveTier):
 * of the live rows that match an action the strictest wins, and an action is
 * promoted only when every matching row is at alone, under the lowest daily cap
 * among the rows that promote it. So the runtime's role (flint_app) switches a
 * row off on its own only when the row is at alone AND has no cap. Any other
 * row goes off on a card Will signed, and no other way.
 *
 *  1. The proof (no database): over thousands of rule tables, switching off any
 *     row the rule allows never makes resolveTier's answer looser for any action
 *     in any context, at any time; and it stays so whatever signed rows arrive
 *     afterwards. Three weaker rules are shown to fail, the one this replaced
 *     among them.
 *  2. The database is that rule: asked row by row as flint_app, it allows
 *     exactly the rows the rule allows.
 *  3. Raw SQL as flint_app: a row at alone with no cap goes off; any other does
 *     not, by any statement, at any isolation level; the signed card switches
 *     it off, and only a card that is all a card must be; the row's history
 *     names that card's approval whatever the writer says; the two floors that
 *     stand on a holding row (goals from chat, P5's acceptance) now stand; rows
 *     from before the migration behave the same.
 * How a row is made is policy-rows-guard-db.test.ts; the runtime's own path and
 * the rules command are policy-rules-db.test.ts. Synthetic text only.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { actionKey, digestOf, patternMatches, resolveTier, suggestionGoalId, type McpFacts, type PolicyRow, type Tier, type TierContext, type TierDecision } from '@flint/policy';
import { NO_DB, freshDb, withClient, withoutPolicyOffGuard, pgConfig, pgError, id, HEX, type TestUrls } from './db';
import { sleep, type CardOptions, type Q } from './p5';
import { LEVEL, LEVELS, REFUSED, policyKit, type PolicyKit, type RowSpec } from './policy';

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
type Rule = (r: Row, table: readonly Row[]) => boolean;

/**
 * The database's rule, written again here: may the runtime's role switch this row off with no card? It is at alone
 * and it has no cap. Nothing else is read: not its end, not its scope, not what else is there.
 */
const mayGoOff: Rule = (r) => r.tier === 'alone' && r.dailyCap === null;
/** Can two patterns match one action? The same pattern, or one is `prefix.*` and the other starts with that prefix. */
const overlap = (a: string, b: string): boolean => a === b || (b.endsWith('.*') && a.startsWith(b.slice(0, -1))) || (a.endsWith('.*') && b.startsWith(a.slice(0, -1)));
/** Three rules that are not enough, to show what each part of the real one is for. */
const anyRow: Rule = () => true;
const aloneOnly: Rule = (r) => r.tier === 'alone';
/**
 * The rule this replaced: a capped row at alone may go while no other row that is on, at alone and able to match an
 * action it matches has a higher cap or none. Sound one step at a time; not against a wider row signed (or carried
 * out) afterwards, which then runs with the cap already gone.
 */
const capAware: Rule = (r, table) =>
  r.tier === 'alone' && (r.dailyCap === null || !table.some((o) => o.active && o.tier === 'alone' && (o.dailyCap === null || o.dailyCap > r.dailyCap!) && overlap(o.pattern, r.pattern)));

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
  { action: 'backup.nexus' }, // promoted by name only, never from chat (Nexus's own backup, P7)
  { action: 'backup.nexus.offsite' }, // by name only, and it leaves the box
  { action: 'restore.drill.nexus' }, // by name only, 1 a week in code
  { action: 'notify.push' }, // promotable, leaves the box
  { action: 'world.sync.git' },
  { action: 'world_now' }, // a chat read
  { action: 'calculate' }, // alone in code: a row can only tighten it
  { action: 'deep_research' },
  { action: 'ledger.void' }, // never promoted
  { action: 'policy.change' },
  { action: 'restore.production' }, // the console's alone
  { action: 'task.check_bar' }, // promoted by name only, and then under a cap of its own (ALONE_CAPS); never from chat
  { action: 'task.dispatch.local_worker' }, // promotable, 20 a day in code; never from chat
  { action: 'review.local' },
  { action: 'unknown.thing' }, // not in the code table
  { action: 'mcp:hive.do_thing', mcp: { server: 'hive', tool: 'do_thing' } },
  { action: 'mcp:hive.do_thing', mcp: { server: 'hive', tool: 'do_thing', destructiveHint: true } },
  { action: 'mcp:hive.open_position', mcp: { server: 'hive', tool: 'open_position' } },
  { action: 'mcp:nexus.recall', mcp: { server: 'nexus', tool: 'recall', readOnlyHint: true } },
  { action: 'mcp:runtime.world_now', mcp: { server: 'runtime', tool: 'world_now' } },
];
/** The key a call's rows are matched on (a runtime chat tool is matched as its own action). */
const keyOf = (c: { action: string; mcp?: McpFacts }): string => (c.mcp?.server === 'runtime' && !c.mcp.destructiveHint ? c.mcp.tool : actionKey(c.action, c.mcp));

// (No pattern covers a policy change: the database makes no such row.)
const PATTERNS = [
  'goal.propose', 'goal.review.local', 'goal.*', 'goal.review.*', 'backup.prune', 'backup.local', 'backup.nexus', 'backup.nexus.offsite', 'backup.nexus.*', 'backup.*', 'notify.push', 'notify.*',
  'world.sync.git', 'world.sync.*', 'world.*', 'world_now', 'calculate', 'deep_research', 'ledger.void', 'ledger.*', 'restore.production', 'restore.drill.nexus', 'restore.drill.*', 'restore.*',
  'task.check_bar', 'task.dispatch.local_worker', 'task.dispatch.*', 'task.*',
  'review.local', 'review.*', 'unknown.thing', 'unknown.*',
  'mcp:hive.do_thing', 'mcp:hive.open_position', 'mcp:hive.*', 'mcp:nexus.recall', 'mcp:nexus.*',
];
const FAMILIES = ['goal.', 'backup.', 'restore.', 'notify.', 'world', 'mcp:hive.', 'ledger.', 'task.', 'review.', 'unknown.', ''];

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

/** A few rows, mostly about one family of actions so that they meet. */
function randomRows(r: () => number, tag: string, family: string, size: number): Row[] {
  const pool = PATTERNS.filter((p) => p.startsWith(family));
  const rows: Row[] = [];
  for (let i = 0; i < size; i++) {
    const tier = r() < 0.6 ? 'alone' : r() < 0.7 ? 'approval' : 'forbidden';
    rows.push({
      id: `${tag}r${i}`,
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
/** A rule table. */
const randomTable = (r: () => number, n: number): Row[] => randomRows(r, `t${n}`, pick(r, FAMILIES), 1 + Math.floor(r() * 6));

interface Found {
  kind: 'tier' | 'cap';
  row: string;
  call: string;
  context: string;
  before: string;
  after: string;
}
const said = (d: TierDecision) => `${d.tier}${d.cap ? ` ${d.cap.limit}/${d.cap.period}` : ''}`;

/**
 * Every call, context and moment where the engine's answer over `actual` is looser than over `held`. Only the calls
 * a row in `changed` matches are asked: a row that does not match a call's key is not read for it (patternMatches
 * is the engine's own), so nothing else can differ.
 */
function looserThan(held: readonly Row[], actual: readonly Row[], changed: readonly Row[], nows: readonly Date[] = NOWS): Found[] {
  const before = held.map(asPolicy);
  const after = actual.map(asPolicy);
  const found: Found[] = [];
  for (const c of CALLS) {
    const by = changed.find((x) => patternMatches(x.pattern, keyOf(c)));
    if (!by) continue;
    for (const ctx of CONTEXTS) {
      for (const now of nows) {
        const b = resolveTier(c.action, { ...ctx, ...(c.mcp ? { mcp: c.mcp } : {}), policies: before, now });
        const a = resolveTier(c.action, { ...ctx, ...(c.mcp ? { mcp: c.mcp } : {}), policies: after, now });
        const kind = looser(b, a);
        if (kind) found.push({ kind, row: `${by.pattern} ${by.tier} cap ${by.dailyCap}`, call: keyOf(c), context: `${ctx.context}${ctx.tainted ? ' tainted' : ''}`, before: said(b), after: said(a) });
      }
    }
  }
  return found;
}
/** Every call, context and moment where switching `off` off makes the engine's answer looser. None, for a row the rule allows. */
const loosenings = (table: readonly Row[], off: Row, nows: readonly Date[] = NOWS): Found[] =>
  looserThan(table, table.map((r) => (r === off ? { ...r, active: false } : r)), [off], nows);

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

/**
 * The runtime's own moves over a table, in any order: switching off a row the rule allows, and carrying out a signed
 * row that waits (it chooses when). After each move the engine's answer is held against the same table with the same
 * rows added and nothing switched off: what Will's signatures alone would have in force.
 */
function interleaved(rule: Rule, seed: number, runs: number): { found: Found[]; offs: number; adds: number } {
  const r = rng(seed);
  const found: Found[] = [];
  let offs = 0;
  let adds = 0;
  for (let n = 0; n < runs; n++) {
    const family = pick(r, FAMILIES);
    let actual = randomRows(r, `i${n}`, family, 1 + Math.floor(r() * 5));
    let signed = actual;
    const waiting = randomRows(r, `w${n}`, family, Math.floor(r() * 4)).map((x) => ({ ...x, active: true }));
    const gone: Row[] = [];
    for (;;) {
      const can = actual.filter((x) => x.active && rule(x, actual));
      if (!can.length && !waiting.length) break;
      if (waiting.length && (!can.length || r() < 0.4)) {
        const add = waiting.shift()!;
        actual = [...actual, add];
        signed = [...signed, add];
        adds++;
      } else {
        const off = pick(r, can);
        actual = actual.map((x) => (x === off ? { ...x, active: false } : x));
        gone.push(off);
        offs++;
      }
      if (gone.length) found.push(...looserThan(signed, actual, gone, [NOWS[1]!]));
    }
  }
  return { found, offs, adds };
}

describe('the rule: a row the runtime may switch off on its own never loosens anything', () => {
  it('every table of up to three rules about one action and its family: no row the rule allows loosens any call, in any context', () => {
    let allowed = 0;
    let refused = 0;
    const bad: Found[] = [];
    // Goals from chat (promotable, no cap in code) and the rule that covers the family; an action promoted by name only;
    // one promoted by name only that then runs under a cap of its own (P5's acceptance, ALONE_CAPS); and one promoted
    // by name only that leaves the box, under a family inside a family (Nexus's offsite copy).
    for (const universe of [universeOf(['goal.propose', 'goal.*'], [null, SCOPE_A]), universeOf(['backup.prune', 'backup.*'], [null]), universeOf(['task.check_bar', 'task.*'], [null]),
      universeOf(['backup.nexus.offsite', 'backup.nexus.*'], [null])]) {
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
    expect(allowed).toBeGreaterThan(4_000);
    expect(refused).toBeGreaterThan(25_000);
  }, 120_000);

  it('4,000 random tables (rows on and off, ended and not, scoped and not, exact and wide, every tier and cap): none, whatever the clock says', () => {
    const r = rng(20261015);
    let allowed = 0;
    let holding = 0;
    let capped = 0;
    const bad: Found[] = [];
    for (let n = 0; n < 4_000; n++) {
      const table = randomTable(r, n);
      for (const row of table.filter((x) => x.active)) {
        if (mayGoOff(row, table)) {
          allowed++;
          bad.push(...loosenings(table, row));
        } else if (row.tier === 'alone') capped++;
        else holding++;
      }
    }
    expect(bad.slice(0, 5)).toEqual([]);
    expect(allowed).toBeGreaterThan(2_000);
    expect(holding).toBeGreaterThan(2_000);
    expect(capped).toBeGreaterThan(2_000);
  }, 120_000);

  it('in any order, with signed rows carried out in between: 3,000 runs never pass through an answer looser than Will’s signatures alone give', () => {
    const run = interleaved(mayGoOff, 7, 3_000);
    expect(run.found.slice(0, 5)).toEqual([]);
    // Both kinds of move, in number: rows switched off, and signed rows added between them.
    expect(run.offs).toBeGreaterThan(2_000);
    expect(run.adds).toBeGreaterThan(2_000);
  }, 120_000);

  it('a weaker rule fails this proof: "any row" loosens a tier, "any row at alone" loosens a cap, and the cap-aware rule this replaced is beaten by a row signed later', () => {
    const found = (rule: Rule): Found[] => {
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
    // The cap-aware rule: nothing loosens one step at a time...
    expect(found(capAware)).toEqual([]);
    // ...but the runtime chooses the order. It switches the capped row off while it stands alone, then carries out
    // the wider row Will signed, and the action runs with the cap gone. Only ever a cap; and found by the same search.
    const later = interleaved(capAware, 7, 3_000).found;
    expect(later.length).toBeGreaterThan(10);
    expect(later.filter((f) => f.kind === 'tier')).toEqual([]);
    // The real rule, over the same tables and the same runs.
    expect(found(mayGoOff)).toEqual([]);
    expect(interleaved(mayGoOff, 7, 3_000).found).toEqual([]);
  }, 180_000);

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
    // The capped row stays even while it stands alone. Switched off then, the action would only go back to a card:
    // but the wider row may already be signed and waiting, and the runtime would carry it out next.
    expect(mayGoOff(three, [three])).toBe(false);
    expect(capAware(three, [three])).toBe(true);
    expect(chat([{ ...three, active: false }, wide])).toBe('alone');
    // A cap of none at all is a cap too.
    expect(mayGoOff(row('goal.propose', 'alone', 0), [])).toBe(false);
  });
});

// ---- The database ----------------------------------------------------------------------------------------------

describe.skipIf(NO_DB)('who may switch a policy row off (flint_test)', () => {
  let urls: TestUrls;
  let pk: PolicyKit;
  let app: Q;
  let owner: Q;
  const kit = () => pk.k;
  const fam = () => pk.fam();
  const failure = (p: Promise<unknown>) => pk.failure(p);
  const rule = (rows: RowSpec[]) => pk.rule(rows);
  const switchOff = (rid: string, q?: Q) => pk.switchOff(rid, q);
  const isOn = (rid: string) => pk.isOn(rid);
  const history = (rid: string) => pk.history(rid);
  const named = (rid: string) => pk.named(rid);
  const offCard = (rids: string[], o: CardOptions = {}) => pk.offCard(rids, o);

  beforeAll(async () => {
    urls = await freshDb();
    pk = await policyKit(urls);
    ({ app, owner } = pk);
  });

  describe('a row at alone with no cap', () => {
    it('goes off for the runtime’s role, and the action is back to a card; the row’s history says who', async () => {
      const [rid] = await rule([{ pattern: `${fam()}.sync`, tier: 'alone' }]);
      await kit().inTx(async (q) => {
        await switchOff(rid!, q);
      }, { actor: 'runtime:test' });
      expect(await isOn(rid!)).toBe(false);
      expect(await history(rid!)).toEqual([{ actor: 'runtime:test', changed: { active: [true, false] } }]);
      // Off is for good, as before; switching it off again changes nothing and writes no history.
      expect(await failure(app(`UPDATE "ActionPolicy" SET active = true WHERE id = $1`, [rid]))).toEqual(['42501', `policy row ${rid}: it can only be switched off`, null]);
      await switchOff(rid!);
      expect((await history(rid!)).length).toBe(1);
    });

    it('scoped, wide, ended or about to end, and whatever else is on beside it: each goes off', async () => {
      const f = fam();
      const ids = await rule([
        { pattern: `${f}.a`, tier: 'alone' },
        { pattern: `${f}.b`, tier: 'alone', scope: { endpoints: ['https://example.test'] } },
        { pattern: `${f}.wide.*`, tier: 'alone' },
        { pattern: `${f}.c`, tier: 'alone', expiresAt: pk.past() },
        { pattern: `${f}.d`, tier: 'alone', expiresAt: new Date(Date.now() + 1_500).toISOString() },
        // Beside rows that are capped, hold it back, or cover it: nothing else is read.
        { pattern: `${f}.e`, tier: 'alone' },
        { pattern: `${f}.e`, tier: 'alone', dailyCap: 3 },
        { pattern: `${f}.e`, tier: 'approval' },
        { pattern: `${f}.*`, tier: 'forbidden' },
      ]);
      for (const rid of ids.slice(0, 6)) {
        await switchOff(rid);
        expect(await isOn(rid)).toBe(false);
      }
      for (const rid of ids.slice(6)) expect(await isOn(rid)).toBe(true);
    });
  });

  describe('a row that holds an action back, or a cap down', () => {
    const HOLDS: Array<[string, (f: string) => RowSpec[]]> = [
      ['an action at approval', (f) => [{ pattern: `${f}.propose`, tier: 'approval' }]],
      ['an action at forbidden', (f) => [{ pattern: `${f}.propose`, tier: 'forbidden' }]],
      ['a whole family at approval', (f) => [{ pattern: `${f}.*`, tier: 'approval' }]],
      ['a whole family at forbidden', (f) => [{ pattern: `${f}.*`, tier: 'forbidden' }]],
      ['the widest pattern there is, every tool of a server', (f) => [{ pattern: `mcp:${f}.*`, tier: 'forbidden' }]],
      ['a scoped one', (f) => [{ pattern: `${f}.propose`, tier: 'approval', scope: { endpoints: ['https://example.test'] } }]],
      ['one at approval with a cap', (f) => [{ pattern: `${f}.propose`, tier: 'approval', dailyCap: 5 }]],
      ['one at forbidden with a cap of none', (f) => [{ pattern: `${f}.*`, tier: 'forbidden', dailyCap: 0 }]],
      ['one that has ended', (f) => [{ pattern: `${f}.propose`, tier: 'approval', expiresAt: pk.past() }]],
      ['one that holds nothing today (no other row is there)', (f) => [{ pattern: `${f}.nothing.else`, tier: 'approval' }]],
      // A cap is a brake too, whatever else is there: it may be the lowest in force, now or once a wider row arrives.
      ['a row at alone with a cap, standing alone', (f) => [{ pattern: `${f}.propose`, tier: 'alone', dailyCap: 3 }]],
      ['a row at alone with a cap of none at all', (f) => [{ pattern: `${f}.propose`, tier: 'alone', dailyCap: 0 }]],
      ['a capped row at alone that has ended', (f) => [{ pattern: `${f}.propose`, tier: 'alone', dailyCap: 3, expiresAt: pk.past() }]],
      ['a capped row beside the same rule under a lower cap', (f) => [{ pattern: `${f}.propose`, tier: 'alone', dailyCap: 3 }, { pattern: `${f}.propose`, tier: 'alone', dailyCap: 1 }]],
      ['a capped row beside the same rule with no cap', (f) => [{ pattern: `${f}.propose`, tier: 'alone', dailyCap: 3 }, { pattern: `${f}.propose`, tier: 'alone' }]],
      ['a capped wide row over a narrow one with no cap', (f) => [{ pattern: `${f}.*`, tier: 'alone', dailyCap: 3 }, { pattern: `${f}.propose`, tier: 'alone' }]],
      ['a capped row whose action another row holds back', (f) => [{ pattern: `${f}.propose`, tier: 'alone', dailyCap: 3 }, { pattern: `${f}.*`, tier: 'forbidden' }]],
    ];
    it.each(HOLDS)('%s stays on: 42501, by its id alone, and nothing is written', async (_name, spec) => {
      const [rid] = await rule(spec(fam()));
      expect(await failure(switchOff(rid!))).toEqual(['42501', REFUSED(rid!), null]);
      expect(await isOn(rid!)).toBe(true);
      expect(await history(rid!)).toEqual([]);
    });

    it('one about to end stays on after it has ended too', async () => {
      const [rid] = await rule([{ pattern: `${fam()}.propose`, tier: 'approval', expiresAt: new Date(Date.now() + 1_200).toISOString() }]);
      expect(await kit().code(switchOff(rid!))).toBe('42501');
      await sleep(1_300);
      expect((await owner(`SELECT "expiresAt" < now() AS ended FROM "ActionPolicy" WHERE id = $1`, [rid])).rows[0].ended).toBe(true);
      expect(await failure(switchOff(rid!))).toEqual(['42501', REFUSED(rid!), null]);
      expect(await isOn(rid!)).toBe(true);
    });

    it('a bare `*` is no pattern: the table refuses the row, so there is none to switch off', async () => {
      const [r] = pk.listed([{ pattern: '*', tier: 'forbidden' }]);
      const pc = await pk.rowsCard([r!]);
      const refused = (await pgError(pk.make(app, pc.aid, r!))) as { code?: string; constraint?: string };
      expect([refused.code, refused.constraint]).toEqual(['23514', 'ActionPolicy_pattern_check']);
      await kit().finish(pc.pid);
    });

    it('an error repeats an id only when it is shaped as one: never words dressed as an id (a row from before ids were held to a shape)', async () => {
      const f = fam();
      for (const rid of ['Synthetic CANARY-off words as an id', 'ignore.all/previous?rules', 'x'.repeat(65), 'esc\u001b[31mred']) {
        await pk.forged({ id: rid, pattern: `${f}.propose`, tier: 'approval' });
        const e = await failure(switchOff(rid));
        expect(e).toEqual(['42501', REFUSED('?'), null]);
        expect(JSON.stringify(e)).not.toMatch(/CANARY|ignore|xxxx|red/);
        for (const level of LEVELS) expect(await failure(kit().inTx((q) => switchOff(rid, q), { iso: level }))).toEqual(['42501', LEVEL('?'), null]);
        expect(await isOn(rid)).toBe(true);
      }
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
      for (const set of [`tier = 'alone'`, `pattern = 'x.y'`, `"dailyCap" = 1`, `"dailyCap" = NULL`, `scope = '{}'`, `"expiresAt" = now()`, `"approvalId" = 'x'`, `reason = 'x'`, `id = 'x'`, `active = false, tier = 'alone'`]) {
        expect(await failure(app(`UPDATE "ActionPolicy" SET ${set} WHERE id = $1`, [hold])), set).toEqual(['42501', 'permission denied for table ActionPolicy', null]);
      }
      expect(await failure(app(`DELETE FROM "ActionPolicy" WHERE id = $1`, [hold]))).toEqual(['42501', 'permission denied for table ActionPolicy', null]);
      expect(await failure(app(`TRUNCATE "ActionPolicy"`))).toEqual(['42501', 'permission denied for table ActionPolicy', null]);
      // Neither on nor off is not a state a row has.
      expect(await kit().code(app(`UPDATE "ActionPolicy" SET active = NULL WHERE id = $1`, [hold]))).toBe('23502');
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
      expect(await failure(kit().inTx(async (q) => {
        await q(`SELECT 1 FROM "ActionPolicy" WHERE id = $1 FOR UPDATE`, [hold]);
        await switchOff(hold, q);
      }))).toEqual(['42501', REFUSED(hold), null]);
      // One statement over both rows: the holding row refuses it whole, and the row at alone stays on with it.
      expect(await kit().code(app(`UPDATE "ActionPolicy" SET active = false WHERE id = ANY ($1)`, [[loose, hold]]))).toBe('42501');
      expect(await kit().code(app(`UPDATE "ActionPolicy" SET active = false WHERE pattern LIKE $1`, [`${f}.%`]))).toBe('42501');
      expect(await isOn(loose)).toBe(true);
      await untouched();
    });

    it('an upsert onto its id: refused with no card, and refused as a switch-off under another card’s rows', async () => {
      const [other] = pk.listed([{ pattern: `${f}.other`, tier: 'alone' }]);
      const upsert = (aid: string) => app(
        `INSERT INTO "ActionPolicy" (id, pattern, tier, reason, "approvalId", "expiresAt") VALUES ($1, $2, 'alone', 'Synthetic rule', $3, $4) ON CONFLICT (id) DO UPDATE SET active = false`,
        [hold, other!.pattern, aid, other!.expiresAt],
      );
      expect((await pgError(upsert('no-such-approval'))).code).toBe('42501');
      // A signed card that adds a row: its insert passes the row guard, meets the holding row's id, and is then a switch-off of that row.
      const pc = await pk.rowsCard([other!]);
      expect(await failure(upsert(pc.aid))).toEqual(['42501', REFUSED(hold), null]);
      await kit().finish(pc.pid);
      await untouched();
    });

    it('the role cannot become the owner, set a guard aside, or reach the row through a function that runs as the owner', async () => {
      for (const sql of [
        'SET ROLE flint_owner', 'SET SESSION AUTHORIZATION flint_owner', `SET session_replication_role = 'replica'`,
        'ALTER TABLE "ActionPolicy" DISABLE TRIGGER "ActionPolicy_off_guard"', 'ALTER TABLE "ActionPolicy" DISABLE TRIGGER "ActionPolicy_card_actor"',
        'ALTER TABLE "ActionPolicy" DISABLE TRIGGER "ActionPolicy_whole_card"', 'ALTER TABLE "ActionPolicy" DISABLE TRIGGER USER', 'ALTER TABLE "Proposal" DISABLE TRIGGER "Proposal_policy_shape"',
        'DROP TRIGGER "ActionPolicy_off_guard" ON "ActionPolicy"', 'DROP TRIGGER "ActionPolicy_whole_card" ON "ActionPolicy"', 'DROP TRIGGER "Proposal_policy_shape" ON "Proposal"',
        'DROP FUNCTION action_policy_off_guard() CASCADE', 'ALTER FUNCTION action_policy_off_guard() SECURITY DEFINER',
        `CREATE OR REPLACE FUNCTION action_policy_off_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END; $$`,
        `CREATE OR REPLACE FUNCTION action_policy_matches_approval() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END; $$`,
        `CREATE FUNCTION pog_as_owner() RETURNS void LANGUAGE sql SECURITY DEFINER AS $$ UPDATE "ActionPolicy" SET active = false $$`,
        'CREATE TEMP TABLE "Approval" (id text)', 'CREATE RULE pog_rule AS ON UPDATE TO "ActionPolicy" DO INSTEAD NOTHING',
        'SELECT action_policy_off_guard()', 'SELECT action_policy_whole_card()', 'SELECT proposal_policy_shape()', 'SELECT action_policy_matches_approval()',
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
      // The guards themselves: the owner's, each with its search path pinned, each running as whoever fires it, and none anyone may call.
      expect((await owner(
        `SELECT p.proname, pg_get_userbyid(p.proowner) AS owner, p.prosecdef, array_to_string(p.proconfig, ';') AS config, coalesce(array_to_string(p.proacl, ','), '') AS acl
         FROM pg_proc p WHERE p.proname IN ('action_policy_off_guard', 'action_policy_whole_card', 'action_policy_matches_approval', 'proposal_policy_shape') ORDER BY 1`)).rows).toEqual(
        ['action_policy_matches_approval', 'action_policy_off_guard', 'action_policy_whole_card', 'proposal_policy_shape'].map((proname) => (
          { proname, owner: 'flint_owner', prosecdef: false, config: 'search_path=public, pg_temp', acl: 'flint_owner=X/flint_owner' })));
      // Each trigger, whole, as the catalog has it: switched on, on every UPDATE (never `UPDATE OF "active"` alone,
      // which a statement that names another column too would slip past), and the row check deferred to the commit.
      expect((await owner(
        `SELECT t.tgname, t.tgenabled, pg_get_triggerdef(t.oid) AS def FROM pg_trigger t
         WHERE NOT t.tgisinternal AND t.tgname IN ('ActionPolicy_off_guard', 'ActionPolicy_card_actor', 'ActionPolicy_whole_card', 'ActionPolicy_matches_approval', 'Proposal_policy_shape') ORDER BY 1`)).rows).toEqual([
        { tgname: 'ActionPolicy_card_actor', tgenabled: 'O', def: 'CREATE TRIGGER "ActionPolicy_card_actor" AFTER UPDATE ON public."ActionPolicy" FOR EACH ROW WHEN ((old.active AND (NOT new.active))) EXECUTE FUNCTION action_policy_off_guard()' },
        { tgname: 'ActionPolicy_matches_approval', tgenabled: 'O', def: 'CREATE TRIGGER "ActionPolicy_matches_approval" BEFORE INSERT ON public."ActionPolicy" FOR EACH ROW EXECUTE FUNCTION action_policy_matches_approval()' },
        { tgname: 'ActionPolicy_off_guard', tgenabled: 'O', def: 'CREATE TRIGGER "ActionPolicy_off_guard" BEFORE UPDATE ON public."ActionPolicy" FOR EACH ROW WHEN ((old.active AND (NOT new.active))) EXECUTE FUNCTION action_policy_off_guard()' },
        { tgname: 'ActionPolicy_whole_card', tgenabled: 'O', def: 'CREATE CONSTRAINT TRIGGER "ActionPolicy_whole_card" AFTER INSERT ON public."ActionPolicy" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION action_policy_whole_card()' },
        { tgname: 'Proposal_policy_shape', tgenabled: 'O', def: `CREATE TRIGGER "Proposal_policy_shape" BEFORE INSERT ON public."Proposal" FOR EACH ROW WHEN ((new.action = 'policy.change'::text)) EXECUTE FUNCTION proposal_policy_shape()` },
      ]);
      // The actor trigger fires before the history trigger, row by row (AFTER triggers fire in name order).
      expect('ActionPolicy_card_actor' < 'ActionPolicy_history').toBe(true);
      await untouched();
    });

    it('above READ COMMITTED nothing is switched off, a row at alone and a signed card’s row included', async () => {
      const [free] = await rule([{ pattern: `${fam()}.sync`, tier: 'alone' }]);
      const card = await offCard([hold]);
      for (const level of [...LEVELS, 'READ UNCOMMITTED']) {
        expect(await failure(kit().inTx((q) => switchOff(free!, q), { iso: level })), level).toEqual(['42501', LEVEL(free!), null]);
        expect(await failure(kit().inTx((q) => switchOff(hold, q), { iso: level })), level).toEqual(['42501', LEVEL(hold), null]);
        // Set for the session, not on BEGIN: the same.
        expect(await failure(withClient(urls.app, async (c) => {
          await c.query(`SET default_transaction_isolation = '${level.toLowerCase()}'`);
          await c.query(`UPDATE "ActionPolicy" SET active = false WHERE id = $1`, [free]);
        })), level).toEqual(['42501', LEVEL(free!), null]);
      }
      expect(await isOn(free!)).toBe(true);
      await untouched();
      // At READ COMMITTED, said outright: the row at alone goes, and the card's row goes.
      await kit().inTx((q) => switchOff(free!, q), { iso: 'READ COMMITTED' });
      await kit().inTx((q) => switchOff(hold, q), { iso: 'READ COMMITTED' });
      expect([await isOn(free!), await isOn(hold)]).toEqual([false, false]);
      await kit().finish(card.pid);
    });
  });

  describe('a card Will signed', () => {
    it('switches off the row it names, and only that row; once its card has ended it switches off nothing more', async () => {
      const f = fam();
      const [hold, other, never] = (await rule([{ pattern: `${f}.propose`, tier: 'approval' }, { pattern: `${f}.propose`, tier: 'approval' }, { pattern: `${f}.*`, tier: 'forbidden' }])) as [string, string, string];
      const card = await offCard([hold, never]);
      // A row the card does not name, however alike.
      expect(await failure(switchOff(other))).toEqual(['42501', REFUSED(other), null]);
      await switchOff(hold);
      expect(await isOn(hold)).toBe(false);
      // The card ends with one of its rows still on: that row stays on.
      await kit().finish(card.pid);
      expect(await failure(switchOff(never))).toEqual(['42501', REFUSED(never), null]);
      expect(await isOn(never)).toBe(true);
      // A new card for it, and it goes. A card may name a row at alone too, capped or not.
      const [capped, free] = await rule([{ pattern: `${f}.free`, tier: 'alone', dailyCap: 2 }, { pattern: `${f}.free`, tier: 'alone' }]);
      expect(await kit().code(switchOff(capped!))).toBe('42501');
      const again = await offCard([never, capped!, free!]);
      for (const rid of [never, capped!, free!]) await switchOff(rid);
      expect([await isOn(never), await isOn(capped!), await isOn(free!)]).toEqual([false, false, false]);
      await kit().finish(again.pid);
    });

    it('the row’s history names the approval of the card that let it through, whatever the writer says of itself', async () => {
      const f = fam();
      const [brake, capped, named1, free, later] = (await rule([
        { pattern: `${f}.propose`, tier: 'approval' }, { pattern: `${f}.capped`, tier: 'alone', dailyCap: 3 }, { pattern: `${f}.named`, tier: 'alone' },
        { pattern: `${f}.free`, tier: 'alone' }, { pattern: `${f}.later`, tier: 'alone' },
      ])) as [string, string, string, string, string];
      const card = await offCard([brake, capped, named1]);
      const says = `will:approval:${card.aid}`;
      // The writer says nothing; says it is the console; says it is another approval: the brake's history is the card's.
      await switchOff(brake);
      expect(await history(brake)).toEqual([{ actor: says, changed: { active: [true, false] } }]);
      await kit().inTx((q) => switchOff(capped, q), { actor: 'will:console' });
      expect((await history(capped))[0]!.actor).toBe(says);
      // One statement over a row the card names and one it does not, the writer setting its own name again for every
      // row as the statement runs: each row's history is its own. The named row is the card's; the other, which no
      // card names, is never an approval's.
      const spoof = (name: string) => kit().inTx((q) => q(`UPDATE "ActionPolicy" SET active = (set_config('flint.actor', $2, true) IS NULL) WHERE id = ANY ($1)`, [[named1, free], name]));
      await spoof('will:approval:made-up');
      expect((await history(named1))[0]!.actor).toBe(says);
      expect((await history(free))[0]!.actor).toBe('flint_app');
      await kit().finish(card.pid);
      // With no card at all: the writer's own word for itself stands, but never an approval's name.
      await kit().inTx((q) => switchOff(later, q), { actor: `will:approval:${card.aid}` });
      expect((await history(later))[0]!.actor).toBe('flint_app');
      const [plain] = await rule([{ pattern: `${f}.plain`, tier: 'alone' }]);
      await kit().inTx((q) => switchOff(plain!, q), { actor: 'runtime:step-down' });
      expect((await history(plain!))[0]!.actor).toBe('runtime:step-down');
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
        ['a list inside a list', { off: [[me]] }],
        ['under rows, not off', { rows: [me] }],
      ];
      for (const [name, args] of wrong) {
        const card = await kit().card('policy.change', args, { kind: 'policy', origin: 'cli' });
        expect(await failure(switchOff(hold)), name).toEqual(['42501', REFUSED(hold), null]);
        await kit().finish(card.pid);
      }
      // Shapes the database no longer files (a card from before it held the shape): each still switches nothing off.
      for (const [name, args] of [['not a list', { off: me }], ['under another name', { switchOff: [me] }], ['nothing', { off: [] }]] as Array<[string, Record<string, unknown>]>) {
        const filed = await kit().without('Proposal_policy_shape', (q) => kit().file('policy.change', args, { kind: 'policy', origin: 'cli' }, q));
        const card = await kit().sign(filed, 'policy.change');
        expect(await failure(switchOff(hold)), name).toEqual(['42501', REFUSED(hold), null]);
        await kit().finish(card.pid);
      }
      expect(await isOn(hold)).toBe(true);
      // More said about the row than the three is still that row (the runtime's own check keeps such a card from being filed).
      const more = await kit().card('policy.change', { off: [{ ...me, note: 'Synthetic note' }] }, { kind: 'policy', origin: 'cli' });
      await switchOff(hold);
      expect(await isOn(hold)).toBe(false);
      await kit().finish(more.pid);
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
      ['of another action', async (hold) => kit().card('world.source.enable', { off: [await named(hold)] }, { kind: 'policy', origin: 'cli', consequential: true })],
      ['of another kind', async (hold) => offCard([hold], { kind: 'tool_call' })],
      ['from a chat', async (hold) => offCard([hold], { origin: 'chat:console-1' })],
      ['from one of the runtime’s own jobs', async (hold) => offCard([hold], { origin: 'runtime:goals' })],
      // Only the two origins that are Will's own are taken: anything else is refused, not only the ones known to be someone else's.
      ['from an origin that is neither (`will`)', async (hold) => offCard([hold], { origin: 'will' })],
      ['from no origin at all', async (hold) => offCard([hold], { origin: '' })],
      ['from an origin that only looks like one (`CLI`)', async (hold) => offCard([hold], { origin: 'CLI' })],
      ['with outside text in it', async (hold) => offCard([hold], { tainted: true })],
      ['that outlives Will’s approval by more than 7 days', async (hold) => offCard([hold], { life: '7 days 1 hour' })],
      ['filed under a digest that is not its args’ digest', async (hold) => offCard([hold], { digest: digestOf({ off: [{ id: 'another', pattern: 'x.y', tier: 'alone' }] }) })],
      ['whose args have no digest (a number that is not whole)', async (hold) => kit().card('policy.change', { off: [{ ...(await named(hold)), weight: 0.5 }] }, { kind: 'policy', origin: 'cli', digest: HEX('d') })],
    ];
    it.each(NOT_CARDS)('a card %s switches nothing off', async (_name, make) => {
      const [hold] = (await rule([{ pattern: `${fam()}.propose`, tier: 'approval' }])) as [string];
      const card = await make(hold);
      expect(await failure(switchOff(hold))).toEqual(['42501', REFUSED(hold), null]);
      expect(await isOn(hold)).toBe(true);
      await kit().finish(card.pid);
    });

    it('a card that also adds rows (one from before the database held a card to one thing) switches nothing off', async () => {
      const f = fam();
      const [hold] = (await rule([{ pattern: `${f}.propose`, tier: 'approval' }])) as [string];
      const args = { off: [await named(hold)], rows: pk.listed([{ pattern: `${f}.*`, tier: 'alone' }]) };
      const filed = await kit().without('Proposal_policy_shape', (q) => kit().file('policy.change', args, { kind: 'policy', origin: 'cli' }, q));
      const card = await kit().sign(filed, 'policy.change');
      expect(await failure(switchOff(hold))).toEqual(['42501', REFUSED(hold), null]);
      // Empty lists beside the other key are the other key all the same.
      const me = await named(hold);
      const empty = await kit().without('Proposal_policy_shape', (q) => kit().file('policy.change', { off: [me], rows: [] }, { kind: 'policy', origin: 'cli' }, q));
      const emptied = await kit().sign(empty, 'policy.change');
      expect(await failure(switchOff(hold))).toEqual(['42501', REFUSED(hold), null]);
      expect(await isOn(hold)).toBe(true);
      await kit().finish(card.pid);
      await kit().finish(emptied.pid);
    });

    it('args nested past reading beside the row’s name switch nothing off (42501, not a fault), and never stand in a good card’s way', async () => {
      const [hold] = (await rule([{ pattern: `${fam()}.propose`, tier: 'approval' }])) as [string];
      let deep: unknown = 'bottom';
      for (let i = 0; i < 3_000; i++) deep = [deep];
      const bad = await kit().card('policy.change', { off: [{ ...(await named(hold)), deep }] }, { kind: 'policy', origin: 'cli', digest: HEX('e') });
      expect(await failure(switchOff(hold))).toEqual(['42501', REFUSED(hold), null]);
      expect(await isOn(hold)).toBe(true);
      // A good card for the same row, with the unreadable one still being carried out beside it.
      const good = await offCard([hold]);
      await switchOff(hold);
      expect(await isOn(hold)).toBe(false);
      expect((await history(hold))[0]!.actor).toBe(`will:approval:${good.aid}`);
      await kit().finish(bad.pid);
      await kit().finish(good.pid);
    });

    it('a card not marked for Will’s own touch (one from before that floor) switches nothing off', async () => {
      const [hold] = (await rule([{ pattern: `${fam()}.propose`, tier: 'approval' }])) as [string];
      const args = { off: [await named(hold)] };
      const filed = await kit().without('Proposal_policy_floor', (q) => kit().file('policy.change', args, { kind: 'policy', origin: 'cli', consequential: false }, q));
      const card = await kit().sign(filed, 'policy.change');
      expect((await owner(`SELECT status, consequential FROM "Proposal" WHERE id = $1`, [card.pid])).rows).toEqual([{ status: 'executing', consequential: false }]);
      expect(await failure(switchOff(hold))).toEqual(['42501', REFUSED(hold), null]);
      await kit().finish(card.pid);
    });

    it('a card signed under a key that has since been revoked switches nothing off', async () => {
      const [hold] = (await rule([{ pattern: `${fam()}.propose`, tier: 'approval' }])) as [string];
      const credential = await pk.spareKey();
      const card = await offCard([hold], { credential });
      await pk.revoke(credential);
      expect(await failure(switchOff(hold))).toEqual(['42501', REFUSED(hold), null]);
      expect(await isOn(hold)).toBe(true);
      await kit().finish(card.pid);
    });

    it('a card that has expired while it was being carried out switches nothing off, in a transaction begun before it expired too', async () => {
      const [hold] = (await rule([{ pattern: `${fam()}.propose`, tier: 'approval' }])) as [string];
      const card = await offCard([hold], { life: '2 seconds' });
      // A transaction opened while the card is still good, and kept open past its end: its own clock (now()) still
      // reads the moment it began. The guard reads the wall clock.
      const held = await kit().client();
      try {
        await held.query('BEGIN');
        expect((await held.query(`SELECT "expiresAt" > now() AS good FROM "Proposal" WHERE id = $1`, [card.pid])).rows[0].good).toBe(true);
        await sleep(2_100);
        expect((await held.query(`SELECT "expiresAt" > now() AS by_its_own_clock, "expiresAt" > clock_timestamp() AS by_the_wall FROM "Proposal" WHERE id = $1`, [card.pid])).rows[0]).toEqual({ by_its_own_clock: true, by_the_wall: false });
        expect(await failure(held.query(`UPDATE "ActionPolicy" SET active = false WHERE id = $1`, [hold]))).toEqual(['42501', REFUSED(hold), null]);
        await held.query('ROLLBACK');
      } finally {
        await held.end();
      }
      expect((await owner(`SELECT status, "expiresAt" < clock_timestamp() AS over FROM "Proposal" WHERE id = $1`, [card.pid])).rows).toEqual([{ status: 'executing', over: true }]);
      expect(await failure(switchOff(hold))).toEqual(['42501', REFUSED(hold), null]);
      expect(await isOn(hold)).toBe(true);
      await kit().finish(card.pid);
    });

    // What P1's own rules already keep from happening, held here as well: a card whose approval is not Will's yes to
    // this very card, for this action and these args. Made as the owner, with P1's card rules set aside for the one
    // statement (the state a changed backup could bring; a restore checks for it too).
    const FORGED: Array<[string, (pid: string, digest: string) => Promise<string>]> = [
      ['his signed no', (pid, digest) => kit().approval(pid, 'policy.change', digest, { decision: 'reject' })],
      ['a signature on something that is not a card', (pid, digest) => kit().approval(pid, 'policy.change', digest, { subjectType: 'policy' })],
      ['his yes to another card', async (_pid, digest) => kit().approval((await kit().file('policy.change', { off: [{ id: 'another', pattern: 'x.y', tier: 'alone' }] }, { kind: 'policy', origin: 'cli' })).pid, 'policy.change', digest)],
      ['his yes to another action', (pid, digest) => kit().approval(pid, 'world.source.enable', digest)],
      ['his yes to other args', (pid) => kit().approval(pid, 'policy.change', digestOf({ off: [{ id: 'another', pattern: 'x.y', tier: 'alone' }] }))],
    ];
    it.each(FORGED)('a card carried out under %s switches nothing off', async (_name, approve) => {
      const [hold] = (await rule([{ pattern: `${fam()}.propose`, tier: 'approval' }])) as [string];
      const filed = await kit().file('policy.change', { off: [await named(hold)] }, { kind: 'policy', origin: 'cli' });
      const aid = await approve(filed.pid, filed.digest);
      await kit().without('Proposal_transition', (q) => q(`UPDATE "Proposal" SET status = 'executing', "approvalId" = $2 WHERE id = $1`, [filed.pid, aid]));
      expect((await owner(`SELECT status, "approvalId" FROM "Proposal" WHERE id = $1`, [filed.pid])).rows).toEqual([{ status: 'executing', approvalId: aid }]);
      expect(await failure(switchOff(hold))).toEqual(['42501', REFUSED(hold), null]);
      expect(await isOn(hold)).toBe(true);
      await kit().finish(filed.pid);
    });

    it('a card of another action carried out under his yes to a policy change (the same forgery, the other way round) switches nothing off', async () => {
      const [hold] = (await rule([{ pattern: `${fam()}.propose`, tier: 'approval' }])) as [string];
      const filed = await kit().file('world.source.enable', { off: [await named(hold)] }, { kind: 'policy', origin: 'cli', consequential: true });
      const aid = await kit().approval(filed.pid, 'policy.change', filed.digest);
      await kit().without('Proposal_transition', (q) => q(`UPDATE "Proposal" SET status = 'executing', "approvalId" = $2 WHERE id = $1`, [filed.pid, aid]));
      expect((await owner(`SELECT status, action, "approvalId" FROM "Proposal" WHERE id = $1`, [filed.pid])).rows).toEqual([{ status: 'executing', action: 'world.source.enable', approvalId: aid }]);
      expect(await failure(switchOff(hold))).toEqual(['42501', REFUSED(hold), null]);
      expect(await isOn(hold)).toBe(true);
      await kit().finish(filed.pid);
    });

    it('the stored args changed after he signed (as the owner, past P1’s rule): the card he signed for one row does not switch off another', async () => {
      const f = fam();
      const [mine, target] = (await rule([{ pattern: `${f}.a`, tier: 'approval' }, { pattern: `${f}.b`, tier: 'forbidden' }])) as [string, string];
      const card = await offCard([mine]);
      await kit().without('Proposal_transition', (q) => q(`UPDATE "Proposal" SET args = $2::jsonb WHERE id = $1`, [card.pid, JSON.stringify({ off: [{ id: target, pattern: `${f}.b`, tier: 'forbidden' }] })]));
      expect(await failure(switchOff(target))).toEqual(['42501', REFUSED(target), null]);
      // Nor the row it first named: the args are no longer what he signed.
      expect(await failure(switchOff(mine))).toEqual(['42501', REFUSED(mine), null]);
      await kit().finish(card.pid);
    });
  });

  describe('the owner', () => {
    it('is not held to it (a restore, a repair by hand), at any isolation level; P1’s rules still hold it', async () => {
      const f = fam();
      const [a, b, c] = (await rule([{ pattern: `${f}.propose`, tier: 'approval' }, { pattern: `${f}.*`, tier: 'forbidden' }, { pattern: `${f}.capped`, tier: 'alone', dailyCap: 1 }])) as [string, string, string];
      await switchOff(a, owner);
      await kit().inTx((q) => switchOff(b, q), { url: urls.owner, iso: 'SERIALIZABLE' });
      await kit().inTx((q) => switchOff(c, q), { url: urls.owner, actor: 'restore' });
      expect([await isOn(a), await isOn(b), await isOn(c)]).toEqual([false, false, false]);
      // Its own word for itself is kept as it is.
      expect((await history(c))[0]!.actor).toBe('restore');
      expect((await pgError(owner(`UPDATE "ActionPolicy" SET active = true WHERE id = $1`, [a]))).message).toBe(`policy row ${a}: it can only be switched off`);
    });
  });

  describe('the floors that stand on a row that holds back', () => {
    const TITLE = 'Synthetic CANARY-off run a half marathon';
    const QUOTE = 'Synthetic CANARY-off I want to run a half marathon by spring';
    const SAID = '2026-10-08T15:00:00.000Z';

    it('goals from chat: with goal.* at alone and goal.propose at approval, the runtime cannot open the way; Will’s card does', async () => {
      await pk.clear();
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
      expect(await kit().code(add(source()))).toBe('42501');
      // What the review found: the runtime's role switched the brake off and the same insert then landed. Not any more.
      expect(await failure(switchOff(brake))).toEqual(['42501', REFUSED(brake), null]);
      expect(await kit().code(add(source()))).toBe('42501');
      expect(await goals()).toBe(0);
      // Will signs the brake off, and the rule that promotes goals from chat lets one in.
      const card = await offCard([brake]);
      await switchOff(brake);
      await kit().finish(card.pid);
      await add(source());
      expect(await goals()).toBe(1);
      await pk.clear();
    });

    it('P5: with task.check_bar at alone and task.* at approval, Flint accepts nothing on its own until Will’s card switches the brake off', async () => {
      await pk.clear();
      const k = kit();
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
      await pk.clear();
    });
  });

  describe('rows from before the migration', () => {
    it('are held like new ones: what was on stays under the rule, and what was switched off stays off', async () => {
      const f = fam();
      const before = await withoutPolicyOffGuard(urls.owner, async () => {
        // Without the guards a card's rows are written one at a time, as they always were.
        const all = pk.listed([
          { pattern: `${f}.free`, tier: 'alone' },
          { pattern: `${f}.capped`, tier: 'alone', dailyCap: 3 },
          { pattern: `${f}.propose`, tier: 'approval' },
          { pattern: `${f}.*`, tier: 'forbidden' },
          { pattern: `${f}.ended`, tier: 'approval', expiresAt: pk.past() },
          { pattern: `${f}.gone`, tier: 'approval' },
          { pattern: `${f}.gone.too`, tier: 'alone' },
        ]);
        const pc = await pk.rowsCard(all);
        const ids: string[] = [];
        for (const r of all) ids.push(await pk.make(app, pc.aid, r));
        await kit().finish(pc.pid);
        // Without the guard the runtime's role switches a holding row off: what this migration closes.
        await switchOff(ids[5]!);
        await switchOff(ids[6]!);
        expect((await owner(`SELECT count(*)::int AS n FROM pg_trigger WHERE tgname IN ('ActionPolicy_off_guard', 'ActionPolicy_whole_card', 'Proposal_policy_shape')`)).rows[0].n).toBe(0);
        return ids;
      });
      const [free, capped, hold, never, ended, gone, goneToo] = before as [string, string, string, string, string, string, string];
      expect((await owner(`SELECT count(*)::int AS n FROM pg_trigger WHERE tgname IN ('ActionPolicy_off_guard', 'ActionPolicy_whole_card', 'Proposal_policy_shape') AND tgenabled = 'O'`)).rows[0].n).toBe(3);
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
      const card = await offCard([hold, never, ended, capped]);
      for (const rid of [hold, never, ended, capped]) await switchOff(rid);
      await kit().finish(card.pid);
      for (const rid of [free, capped, hold, never, ended]) expect(await isOn(rid), rid).toBe(false);
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
        // The table as Will would have signed it: one card, its rows written together by the runtime's role while it runs.
        const pc = await pk.rowsCard(table.map((row) => ({ pattern: row.pattern, tier: row.tier, ...(row.dailyCap === null ? {} : { dailyCap: row.dailyCap }), ...(row.scope ? { scope: row.scope } : {}), expiresAt: row.expiresAt.toISOString() })));
        await appC.query('BEGIN');
        for (const row of table) {
          await appC.query(`INSERT INTO "ActionPolicy" (id, pattern, tier, "dailyCap", scope, reason, "approvalId", "expiresAt") VALUES ($1, $2, $3, $4, $5::jsonb, 'Synthetic rule', $6, $7)`, [
            row.id, row.pattern, row.tier, row.dailyCap, row.scope ? JSON.stringify(row.scope) : null, pc.aid, row.expiresAt.toISOString(),
          ]);
        }
        await appC.query(`UPDATE "Proposal" SET status = 'executed', "executedAt" = now() WHERE id = $1`, [pc.pid]);
        await appC.query('COMMIT');
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
