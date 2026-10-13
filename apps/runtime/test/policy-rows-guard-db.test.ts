/**
 * How a policy row is made (migration policy_off_guard): what a runtime that
 * breaks its own rules still cannot do with a card Will signed. Raw SQL as
 * flint_app on flint_test.
 *
 *  - A policy change says ONE thing. The database files a policy.change only
 *    with `rows` or `off`, one key holding a list that is not empty. A card
 *    that carried both would read "Switch Off 1 Rule" and add a rule that lets
 *    something run on its own: the reviewed attack, step by step, is here.
 *    Each guard refuses a card that carries the other key, so one filed before
 *    this serves neither.
 *  - A row is made once: a card makes one row for each time it lists one,
 *    ever. Left executing, past its expiry, under a revoked key, it makes
 *    nothing again, so a rule that was switched off stays off.
 *  - A row is made whole: a card's rows land together or not at all, checked
 *    when the transaction commits. The row that lets go never lands without
 *    the brake signed beside it.
 *  - Only under a card that still stands: Will's own, untainted, marked for his
 *    touch, under a live key, not expired, holding the args he signed.
 *  - A row's id is shaped as an id, and no row covers a policy change.
 *  - Rows and cards from before the migration keep working.
 * Who may switch a row off is policy-off-guard-db.test.ts. Synthetic text only.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { digestOf, resolveTier, type PolicyRow } from '@flint/policy';
import { NO_DB, freshDb, withoutPolicyOffGuard, pgError, id, HEX, type TestUrls } from './db';
import { sleep, type CardOptions, type Q } from './p5';
import { LEVELS, MADE_ALREADY, MADE_LEVEL, NOT_EXECUTING, NOT_LISTED, NOT_STANDING, NOT_WHOLE, REFUSED, policyKit, type Listed, type PolicyKit, type RowSpec } from './policy';

describe.skipIf(NO_DB)('how a policy row is made (flint_test)', () => {
  let urls: TestUrls;
  let pk: PolicyKit;
  let app: Q;
  let owner: Q;
  const kit = () => pk.k;
  const fam = () => pk.fam('row');
  const failure = (p: Promise<unknown>) => pk.failure(p);
  const SHAPE = (pid: string) => `proposal ${pid}: a policy change adds rules or switches rules off, and nothing else`;
  /** One row of a card, written alone in its own transaction (so the commit's check runs on it alone). */
  const makeAlone = (aid: string, r: Listed, rid = id('pol')) => pk.make(app, aid, r, rid);
  /** Rows of a card, written together. */
  const makeAll = (aid: string, rows: Listed[], ids = rows.map(() => id('pol'))) => kit().inTx(async (q) => {
    for (const [i, r] of rows.entries()) await pk.make(q, aid, r, ids[i]);
    return ids;
  });
  const rowsBy = async (aid: string) => (await owner(`SELECT pattern, tier, active FROM "ActionPolicy" WHERE "approvalId" = $1 ORDER BY pattern, tier`, [aid])).rows as Array<{ pattern: string; tier: string; active: boolean }>;

  beforeAll(async () => {
    urls = await freshDb();
    pk = await policyKit(urls);
    ({ app, owner } = pk);
  });

  describe('a policy change says one thing', () => {
    const row = () => pk.listed([{ pattern: `${fam()}.propose`, tier: 'alone' }])[0]!;
    const off = { id: 'ap1', pattern: 'x.y', tier: 'approval' };

    it('rows, or off, is filed; both, an empty list, another key beside one, or neither is refused by the database, whoever files it', async () => {
      const k = kit();
      await k.file('policy.change', { rows: [row()] }, { kind: 'policy' });
      await k.file('policy.change', { off: [off] }, { kind: 'policy', origin: 'cli' });
      await k.file('policy.change', { rows: [row(), row()] }, { kind: 'policy' });
      const bad: Array<[string, unknown]> = [
        ['both', { off: [off], rows: [row()] }],
        ['both, the switch-off list empty', { off: [], rows: [row()] }],
        ['both, the rows empty', { off: [off], rows: [] }],
        ['rows with nothing in them', { rows: [] }],
        ['off with nothing in it', { off: [] }],
        ['another key beside rows', { rows: [row()], note: 'Synthetic' }],
        ['another key beside off', { off: [off], also: 1 }],
        ['rows that are not a list', { rows: row() }],
        ['off that is not a list', { off: off }],
        ['off that is text', { off: 'all' }],
        ['rows that are null', { rows: null }],
        ['another key alone', { switchOff: [off] }],
        ['nothing', {}],
        ['a list, not an object', [{ off: [off] }]],
        ['text', 'off'],
        ['a number', 7],
      ];
      for (const [name, args] of bad) {
        const pid = id('prop');
        for (const q of [app, owner]) {
          expect(await failure(k.file('policy.change', args as Record<string, unknown>, { kind: 'policy', origin: 'cli', id: pid }, q)), name).toEqual(['23514', SHAPE(pid), null]);
        }
      }
      // Any other action's card says what it likes: the rule is the policy change's own.
      await k.file('world.source.enable', { source: 'git', rows: [], off: [] }, { kind: 'tool_call' });
      // An error repeats a card's id only when it is shaped as one.
      expect(await failure(k.file('policy.change', {}, { kind: 'policy', id: 'Synthetic CANARY words' }))).toEqual(['23514', SHAPE('?'), null]);
    });

    it('the reviewed attack: Will’s own switch-off card set aside for a look-alike that also adds a wide rule. The look-alike is never filed', async () => {
      const k = kit();
      const f = fam();
      // A rule Will wants to end, and his own card for it (what `rules --off <id>` files).
      const [reviews] = await pk.rule([{ pattern: `mcp:${f}.list_things`, tier: 'alone' }]);
      const n = await pk.named(reviews!);
      const own = await k.file('policy.change', { off: [n] }, { kind: 'policy', origin: 'cli' });
      // The runtime rejects his card with no signature (it may: a runtime's refusal), and files a look-alike that also
      // carries rows: every tool of that server, alone, uncapped, for 180 days.
      await app(`UPDATE "Proposal" SET status = 'rejected', error = 'Synthetic' WHERE id = $1`, [own.pid]);
      const wide = pk.listed([{ pattern: `mcp:${f}.*`, tier: 'alone', expiresAt: pk.inDays(180) }])[0]!;
      const twin = id('prop');
      expect(await failure(k.file('policy.change', { off: [n], rows: [wide] }, { kind: 'policy', origin: 'cli', id: twin }))).toEqual(['23514', SHAPE(twin), null]);
      expect((await owner(`SELECT count(*)::int AS n FROM "Proposal" WHERE id = $1`, [twin])).rows[0].n).toBe(0);
      // Had such a card been filed before the database held the shape, and signed as "Switch Off 1 Rule": it adds
      // nothing and switches nothing off.
      const before = await k.without('Proposal_policy_shape', (q) => k.file('policy.change', { off: [n], rows: [wide] }, { kind: 'policy', origin: 'cli' }, q));
      const signed = await k.sign(before, 'policy.change');
      const rid = id('pol');
      expect(await failure(makeAlone(signed.aid, wide, rid))).toEqual(['42501', NOT_STANDING(rid), null]);
      expect(await pk.exists(rid)).toBe(false);
      // (The rule he named is at alone with no cap, so it would go off with no card at all: a brake beside it shows the same card switches nothing off.)
      const [brake] = await pk.rule([{ pattern: `mcp:${f}.write_things`, tier: 'forbidden' }]);
      const mixed = await k.without('Proposal_policy_shape', async (q) => k.file('policy.change', { off: [await pk.named(brake!)], rows: [wide] }, { kind: 'policy', origin: 'cli' }, q));
      const mixedSigned = await k.sign(mixed, 'policy.change');
      expect(await failure(pk.switchOff(brake!))).toEqual(['42501', REFUSED(brake!), null]);
      expect(await failure(makeAlone(mixedSigned.aid, wide, rid))).toEqual(['42501', NOT_STANDING(rid), null]);
      // What the engine says of a write tool of that server from chat: still Will's to approve.
      const live = (await owner(`SELECT pattern, tier, "dailyCap", active, "expiresAt" FROM "ActionPolicy" WHERE active AND "expiresAt" > now()`)).rows as PolicyRow[];
      expect(resolveTier(`mcp:${f}.write_anything`, { context: 'chat', tainted: false, mcp: { server: f, tool: 'write_anything' }, policies: live }).tier).toBe('approval');
      await k.finish(signed.pid);
      await k.finish(mixedSigned.pid);
    });
  });

  describe('a row is made once', () => {
    it('a card left being carried out makes its row once: not again while it runs, after the row was switched off, after the card expired, or after its key was revoked', async () => {
      const k = kit();
      const [r] = pk.listed([{ pattern: `${fam()}.sync`, tier: 'alone' }]);
      const credential = await pk.spareKey();
      const pc = await pk.rowsCard([r!], { life: '3 seconds', credential });
      const first = await makeAlone(pc.aid, r!);
      expect(await pk.isOn(first)).toBe(true);
      const again = id('pol');
      expect(await failure(makeAlone(pc.aid, r!, again))).toEqual(['42501', MADE_ALREADY(again), null]);
      // The runtime switches it off (it may: at alone, no cap), and Will takes that as the end of it.
      await pk.switchOff(first);
      expect(await failure(makeAlone(pc.aid, r!, again))).toEqual(['42501', MADE_ALREADY(again), null]);
      // The card is never completed. Past its expiry, and with its key revoked, it still makes nothing.
      await sleep(3_100);
      expect((await owner(`SELECT status, "expiresAt" < clock_timestamp() AS over FROM "Proposal" WHERE id = $1`, [pc.pid])).rows).toEqual([{ status: 'executing', over: true }]);
      expect((await pgError(makeAlone(pc.aid, r!, again))).code).toBe('42501');
      await pk.revoke(credential);
      expect((await pgError(makeAlone(pc.aid, r!, again))).code).toBe('42501');
      expect(await rowsBy(pc.aid)).toEqual([{ pattern: r!.pattern, tier: 'alone', active: false }]);
      await k.finish(pc.pid);
    });

    it('a card that lists a row twice makes it twice, never a third time; rows alike under another card are that card’s own', async () => {
      const k = kit();
      const [r] = pk.listed([{ pattern: `${fam()}.sync`, tier: 'alone', dailyCap: 2, scope: { endpoints: ['a'] } }]);
      const pc = await pk.rowsCard([r!, r!]);
      await makeAll(pc.aid, [r!, r!]);
      const third = id('pol');
      expect(await failure(makeAlone(pc.aid, r!, third))).toEqual(['42501', MADE_ALREADY(third), null]);
      // The same rule signed again on a new card is made under that card, once.
      const other = await pk.rowsCard([r!]);
      await makeAlone(other.aid, r!);
      expect(await failure(makeAlone(other.aid, r!, third))).toEqual(['42501', MADE_ALREADY(third), null]);
      expect((await rowsBy(pc.aid)).length).toBe(2);
      expect((await rowsBy(other.aid)).length).toBe(1);
      await k.finish(pc.pid);
      await k.finish(other.pid);
    });

    it('two sessions writing the same row at once: one lands, and the other is refused once it has', async () => {
      const k = kit();
      const [r] = pk.listed([{ pattern: `${fam()}.sync`, tier: 'alone' }]);
      const pc = await pk.rowsCard([r!]);
      const one = await k.client();
      const two = await k.client();
      try {
        await one.query('BEGIN');
        await pk.make(k.on(one), pc.aid, r!);
        // The second waits for the first (one writer at a time for a card), and counts its row once it has landed.
        const second = pk.make(k.on(two), pc.aid, r!).then(() => 'ok', (e: { code?: string }) => e.code ?? 'error');
        await sleep(300);
        expect(await Promise.race([second, sleep(10).then(() => 'waiting')])).toBe('waiting');
        await one.query('COMMIT');
        expect(await second).toBe('42501');
      } finally {
        await one.end();
        await two.end();
      }
      expect((await rowsBy(pc.aid)).length).toBe(1);
      // Twelve at one starting line: one row.
      const [s] = pk.listed([{ pattern: `${fam()}.sync`, tier: 'alone' }]);
      const burst = await pk.rowsCard([s!]);
      const landed = await Promise.all(Array.from({ length: 12 }, () => makeAlone(burst.aid, s!).then(() => 'ok', (e: { code?: string }) => e.code ?? 'error')));
      expect(landed.filter((x) => x === 'ok').length).toBe(1);
      expect(landed.filter((x) => x === '42501').length).toBe(11);
      expect((await rowsBy(burst.aid)).length).toBe(1);
      await k.finish(pc.pid);
      await k.finish(burst.pid);
    });
  });

  describe('a row is made whole', () => {
    it('a signed table is in force whole or not at all: the row that lets go never lands without the brake signed beside it', async () => {
      const k = kit();
      const f = fam();
      const [wide, brake, capped] = pk.listed([{ pattern: `${f}.*`, tier: 'alone' }, { pattern: `${f}.propose`, tier: 'approval' }, { pattern: `${f}.send`, tier: 'alone', dailyCap: 3 }]) as [Listed, Listed, Listed];
      const pc = await pk.rowsCard([wide, brake, capped]);
      const rid = id('pol');
      // Alone, in its own transaction: refused when it commits, and nothing stays.
      for (const r of [wide, brake, capped]) {
        expect(await failure(makeAlone(pc.aid, r, rid)), r.pattern).toEqual(['42501', NOT_WHOLE(rid), null]);
      }
      // Two of the three; and the two that let go without the brake.
      expect((await pgError(makeAll(pc.aid, [wide, brake]))).code).toBe('42501');
      expect((await pgError(makeAll(pc.aid, [wide, capped]))).code).toBe('42501');
      expect(await rowsBy(pc.aid)).toEqual([]);
      // The reviewed case: the wide row, and the card completed in the same transaction as if it were done.
      expect(await failure(k.inTx(async (q) => {
        await pk.make(q, pc.aid, wide, rid);
        await q(`UPDATE "Proposal" SET status = 'executed', "executedAt" = now() WHERE id = $1`, [pc.pid]);
      }))).toEqual(['42501', NOT_WHOLE(rid), null]);
      expect((await owner(`SELECT status FROM "Proposal" WHERE id = $1`, [pc.pid])).rows).toEqual([{ status: 'executing' }]);
      // Asked to check now instead of at the commit: it checks now.
      expect(await failure(k.inTx(async (q) => {
        await pk.make(q, pc.aid, wide, rid);
        await q('SET CONSTRAINTS ALL IMMEDIATE');
      }))).toEqual(['42501', NOT_WHOLE(rid), null]);
      expect(await failure(k.inTx(async (q) => {
        await q('SET CONSTRAINTS ALL IMMEDIATE');
        await pk.make(q, pc.aid, wide, rid);
      }))).toEqual(['42501', NOT_WHOLE(rid), null]);
      // A savepoint that is rolled back takes its row with it: what is left at the commit is still not the table.
      expect(await failure(k.inTx(async (q) => {
        await pk.make(q, pc.aid, wide, rid);
        await q('SAVEPOINT s');
        await pk.make(q, pc.aid, brake);
        await pk.make(q, pc.aid, capped);
        await q('ROLLBACK TO SAVEPOINT s');
      }))).toEqual(['42501', NOT_WHOLE(rid), null]);
      expect(await rowsBy(pc.aid)).toEqual([]);
      // Together, in any order: the table.
      const ids = await makeAll(pc.aid, [capped, brake, wide]);
      for (const x of ids) expect(await pk.isOn(x)).toBe(true);
      expect((await rowsBy(pc.aid)).length).toBe(3);
      await k.finish(pc.pid);
      // In one statement too.
      const [a, b] = pk.listed([{ pattern: `${f}.a`, tier: 'alone' }, { pattern: `${f}.b`, tier: 'forbidden' }]) as [Listed, Listed];
      const two = await pk.rowsCard([a, b]);
      await app(
        `INSERT INTO "ActionPolicy" (id, pattern, tier, reason, "approvalId", "expiresAt") VALUES ($1, $2, 'alone', 'Synthetic rule', $5, $6), ($3, $4, 'forbidden', 'Synthetic rule', $5, $7)`,
        [id('pol'), a.pattern, id('pol'), b.pattern, two.aid, a.expiresAt, b.expiresAt],
      );
      expect((await rowsBy(two.aid)).length).toBe(2);
      await k.finish(two.pid);
    });

    it('a card whose rows cannot be read when the transaction commits makes none: its args cleared in the same transaction', async () => {
      const k = kit();
      const f = fam();
      const [wide, brake] = pk.listed([{ pattern: `${f}.*`, tier: 'alone' }, { pattern: `${f}.propose`, tier: 'approval' }]) as [Listed, Listed];
      const pc = await pk.rowsCard([wide, brake]);
      const rid = id('pol');
      // The row that lets go; then the card ended and its args cleared (retention's own move, once a card has ended),
      // so that nothing is left to say what else it listed.
      expect(await failure(k.inTx(async (q) => {
        await pk.make(q, pc.aid, wide, rid);
        await q(`UPDATE "Proposal" SET status = 'failed', error = 'Synthetic end', "executedAt" = now() WHERE id = $1`, [pc.pid]);
        await q(`UPDATE "Proposal" SET args = NULL, "argsPurgedAt" = now() WHERE id = $1`, [pc.pid]);
      }))).toEqual(['42501', `policy row ${rid}: its card's rows cannot be read, so none is made`, null]);
      expect(await rowsBy(pc.aid)).toEqual([]);
      expect((await owner(`SELECT status, args IS NOT NULL AS has_args FROM "Proposal" WHERE id = $1`, [pc.pid])).rows).toEqual([{ status: 'executing', has_args: true }]);
      await k.finish(pc.pid);
    });
  });

  describe('only under a card that still stands', () => {
    const one = () => pk.listed([{ pattern: `${fam()}.sync`, tier: 'alone' }]);
    // Each line is a card that is all a signed table must be but for one thing.
    const NOT_CARDS: Array<[string, (rows: Listed[]) => Promise<{ pid: string; aid: string }>]> = [
      ['from a chat', (rows) => pk.rowsCard(rows, { origin: 'chat:console-1' })],
      ['from one of the runtime’s own jobs', (rows) => pk.rowsCard(rows, { origin: 'runtime:goals' })],
      ['from an origin that is neither (`will`)', (rows) => pk.rowsCard(rows, { origin: 'will' })],
      ['from no origin at all', (rows) => pk.rowsCard(rows, { origin: '' })],
      ['with outside text in it', (rows) => pk.rowsCard(rows, { tainted: true })],
      ['that outlives Will’s approval by more than 7 days', (rows) => pk.rowsCard(rows, { life: '7 days 1 hour' })],
      ['filed under a digest that is not its args’ digest', (rows) => pk.rowsCard(rows, { digest: digestOf({ rows: [] }) })],
    ];
    it.each(NOT_CARDS)('a card %s makes no row', async (_name, make) => {
      const rows = one();
      const card = await make(rows);
      const rid = id('pol');
      expect(await failure(makeAlone(card.aid, rows[0]!, rid))).toEqual(['42501', NOT_STANDING(rid), null]);
      expect(await pk.exists(rid)).toBe(false);
      await kit().finish(card.pid);
    });

    it('a card whose args have no digest (a number that is not whole, a depth past reading) makes no row: 42501, never a fault', async () => {
      const k = kit();
      let deep: unknown = 'bottom';
      for (let i = 0; i < 3_000; i++) deep = [deep];
      for (const scope of [{ weight: 0.5 }, { deep }] as Array<Record<string, unknown>>) {
        const rows = pk.listed([{ pattern: `${fam()}.sync`, tier: 'alone', scope }]);
        const card = await pk.rowsCard(rows, { digest: HEX('d') });
        const rid = id('pol');
        expect(await failure(makeAlone(card.aid, rows[0]!, rid)), Object.keys(scope)[0]).toEqual(['42501', NOT_STANDING(rid), null]);
        await k.finish(card.pid);
      }
    });

    it('a card not marked for Will’s own touch, one signed under a key since revoked, and one that expired while it ran (in a transaction begun before, too) make no row', async () => {
      const k = kit();
      const rid = id('pol');
      // From before the floor that marks every policy change.
      const unmarked = one();
      const filed = await k.without('Proposal_policy_floor', (q) => k.file('policy.change', { rows: unmarked }, { kind: 'policy', consequential: false }, q));
      const card = await k.sign(filed, 'policy.change');
      expect(await failure(makeAlone(card.aid, unmarked[0]!, rid))).toEqual(['42501', NOT_STANDING(rid), null]);
      await k.finish(card.pid);
      // A revoked key.
      const revoked = one();
      const credential = await pk.spareKey();
      const under = await pk.rowsCard(revoked, { credential });
      await pk.revoke(credential);
      expect(await failure(makeAlone(under.aid, revoked[0]!, rid))).toEqual(['42501', NOT_STANDING(rid), null]);
      await k.finish(under.pid);
      // Expired while it ran: by the wall clock, whatever a transaction opened earlier reads on its own.
      const late = one();
      const short = await pk.rowsCard(late, { life: '2 seconds' });
      const held = await k.client();
      try {
        await held.query('BEGIN');
        await held.query('SELECT now()');
        await sleep(2_100);
        expect((await held.query(`SELECT "expiresAt" > now() AS by_its_own_clock, "expiresAt" > clock_timestamp() AS by_the_wall FROM "Proposal" WHERE id = $1`, [short.pid])).rows[0]).toEqual({ by_its_own_clock: true, by_the_wall: false });
        expect(await failure(pk.make(k.on(held), short.aid, late[0]!, rid))).toEqual(['42501', NOT_STANDING(rid), null]);
        await held.query('ROLLBACK');
      } finally {
        await held.end();
      }
      expect(await failure(makeAlone(short.aid, late[0]!, rid))).toEqual(['42501', NOT_STANDING(rid), null]);
      await k.finish(short.pid);
      expect(await pk.exists(rid)).toBe(false);
    });

    it('a card that is not being carried out, of another kind or action, or whose approval is not Will’s yes to it, makes no row (P1’s own rule, as before)', async () => {
      const k = kit();
      const rid = id('pol');
      const rows = one();
      for (const stage of ['pending', 'approved', 'executed'] as const) {
        const card = await pk.rowsCard(rows, { stage });
        expect((await pgError(makeAlone(card.aid, rows[0]!, rid))).code, stage).toBe('42501');
      }
      const kind = await pk.rowsCard(rows, { kind: 'tool_call' });
      expect(await failure(makeAlone(kind.aid, rows[0]!, rid))).toEqual(['42501', NOT_EXECUTING(rid), null]);
      const action = await k.card('world.source.enable', { rows }, { kind: 'policy', consequential: true });
      expect(await failure(makeAlone(action.aid, rows[0]!, rid))).toEqual(['42501', NOT_EXECUTING(rid), null]);
      expect(await failure(makeAlone('no-such-approval', rows[0]!, rid))).toEqual(['42501', 'policy row: approval no-such-approval is not an approved proposal', null]);
      expect(await failure(makeAlone('Synthetic CANARY words', rows[0]!, rid))).toEqual(['42501', 'policy row: approval ? is not an approved proposal', null]);
      // A row the card does not list as written: another cap, a wider pattern, another tier, another end.
      const listed = await pk.rowsCard(rows);
      for (const other of [{ ...rows[0]!, dailyCap: 5 }, { ...rows[0]!, pattern: rows[0]!.pattern.replace(/\.sync$/, '.*') }, { ...rows[0]!, tier: 'forbidden' as const }, { ...rows[0]!, expiresAt: pk.inDays(31) }, { ...rows[0]!, scope: { endpoints: ['a'] } }]) {
        expect(await failure(makeAlone(listed.aid, other, rid))).toEqual(['42501', NOT_LISTED(rid), null]);
      }
      // Forged past P1's rule, as the owner: his yes to another action, and to other args.
      for (const approve of [(pid: string, digest: string) => k.approval(pid, 'world.source.enable', digest), (pid: string) => k.approval(pid, 'policy.change', digestOf({ rows: [] }))]) {
        const filed = await k.file('policy.change', { rows }, { kind: 'policy' });
        const aid = await approve(filed.pid, filed.digest);
        await k.without('Proposal_transition', (q) => q(`UPDATE "Proposal" SET status = 'executing', "approvalId" = $2 WHERE id = $1`, [filed.pid, aid]));
        expect(await failure(makeAlone(aid, rows[0]!, rid))).toEqual(['42501', NOT_STANDING(rid), null]);
        await k.finish(filed.pid);
      }
      for (const c of [kind, action, listed]) await k.finish(c.pid);
      expect(await pk.exists(rid)).toBe(false);
    });

    it('above READ COMMITTED no row is made', async () => {
      const rows = one();
      const card = await pk.rowsCard(rows);
      const rid = id('pol');
      for (const level of [...LEVELS, 'READ UNCOMMITTED']) {
        expect(await failure(kit().inTx((q) => pk.make(q, card.aid, rows[0]!, rid), { iso: level })), level).toEqual(['42501', MADE_LEVEL(rid), null]);
      }
      await kit().inTx((q) => pk.make(q, card.aid, rows[0]!, rid), { iso: 'READ COMMITTED' });
      expect(await pk.isOn(rid)).toBe(true);
      await kit().finish(card.pid);
    });
  });

  describe('what a row is', () => {
    it('its id is shaped as an id, so a card can always name it to switch it off', async () => {
      const rows = pk.listed([{ pattern: `${fam()}.sync`, tier: 'approval' }]);
      const card = await pk.rowsCard(rows);
      for (const rid of ['Synthetic CANARY words as an id', 'esc\u001b[31mred', 'a.b', 'a/b', '', 'x'.repeat(65), 'ap 1', 'ap\n1']) {
        expect(await failure(makeAlone(card.aid, rows[0]!, rid)), JSON.stringify(rid)).toEqual(['23514', 'policy row: its id is not shaped as an id', null]);
      }
      const rid = await makeAlone(card.aid, rows[0]!, `AP_${id('pol')}-9`);
      expect(await pk.isOn(rid)).toBe(true);
      await kit().finish(card.pid);
    });

    it('no row covers a policy change: one that forbade it could never be signed away', async () => {
      const f = fam();
      for (const pattern of ['policy.change', 'policy.*']) {
        for (const tier of ['forbidden', 'approval', 'alone'] as const) {
          const rows = pk.listed([{ pattern, tier }]);
          const card = await pk.rowsCard(rows);
          const rid = id('pol');
          expect(await failure(makeAlone(card.aid, rows[0]!, rid)), `${pattern} ${tier}`).toEqual(['23514', `policy row ${rid}: no rule covers a policy change`, null]);
          await kit().finish(card.pid);
        }
      }
      // Names that only look like it are rules like any other.
      const near = pk.listed([{ pattern: 'policyx.change', tier: 'approval' }, { pattern: `${f}.policy.change`, tier: 'approval' }, { pattern: 'mcp:policy.change', tier: 'approval' }, { pattern: 'policy.change.*', tier: 'approval' }]);
      const card = await pk.rowsCard(near);
      await makeAll(card.aid, near);
      expect((await rowsBy(card.aid)).length).toBe(4);
      await kit().finish(card.pid);
      await pk.clear();
    });
  });

  describe('rows and cards from before the migration', () => {
    it('a table signed before it is carried out after it, whole; one carried out before it stays as it was and makes nothing more', async () => {
      const k = kit();
      const f = fam();
      const waiting = pk.listed([{ pattern: `${f}.a`, tier: 'alone', dailyCap: 2 }, { pattern: `${f}.b`, tier: 'approval' }]);
      const done = pk.listed([{ pattern: `${f}.c`, tier: 'alone' }, { pattern: `${f}.d`, tier: 'forbidden' }]);
      const half = pk.listed([{ pattern: `${f}.e`, tier: 'alone' }, { pattern: `${f}.f`, tier: 'forbidden' }]);
      const cards = await withoutPolicyOffGuard(urls.owner, async () => {
        const filed = await k.file('policy.change', { rows: waiting }, { kind: 'policy', origin: 'cli' });
        // Carried out before: its rows written one at a time, as P1 let them be.
        const ran = await pk.rowsCard(done);
        const ids = [await makeAlone(ran.aid, done[0]!), await makeAlone(ran.aid, done[1]!)];
        // Left being carried out with one row of two made (a runtime that stopped half way).
        const stopped = await pk.rowsCard(half, { life: '6 days' });
        const first = await makeAlone(stopped.aid, half[0]!);
        return { filed, ran, ids, stopped, first };
      });
      // The waiting card is signed and carried out under the new rules.
      const signed = await k.sign(cards.filed, 'policy.change');
      expect((await pgError(makeAlone(signed.aid, waiting[0]!))).code).toBe('42501');
      await makeAll(signed.aid, waiting);
      expect((await rowsBy(signed.aid)).length).toBe(2);
      await k.finish(signed.pid);
      // The table carried out before is as it was: both rows on, the brake held, and its card makes nothing more.
      for (const rid of cards.ids) expect(await pk.isOn(rid)).toBe(true);
      expect((await pgError(makeAlone(cards.ran.aid, done[0]!))).code).toBe('42501');
      expect(await failure(pk.switchOff(cards.ids[1]!))).toEqual(['42501', REFUSED(cards.ids[1]!), null]);
      // The half-made table: its one row stays (nothing is undone), it is not made twice, and its other row can still land.
      expect(await pk.isOn(cards.first)).toBe(true);
      const again = id('pol');
      expect(await failure(makeAlone(cards.stopped.aid, half[0]!, again))).toEqual(['42501', MADE_ALREADY(again), null]);
      await makeAlone(cards.stopped.aid, half[1]!);
      expect((await rowsBy(cards.stopped.aid)).length).toBe(2);
      await k.finish(cards.ran.pid);
      await k.finish(cards.stopped.pid);
    });
  });
});
