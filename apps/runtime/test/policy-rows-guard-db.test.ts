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
 *  - A rule ends at a time written ONE way, in full and with its zone. A time
 *    with no zone, or a date that reads two ways, is another moment under each
 *    session's TimeZone or DateStyle, which the runtime's role sets for
 *    itself: one listed row was made eight times (the reviewed cards are
 *    here). Such a card is never filed, and one filed before makes no row.
 *    Days are counted in UTC whatever zone the session is in.
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
import { LEVELS, MADE_ALREADY, MADE_LEVEL, NOT_EXECUTING, NOT_LISTED, NOT_READ, NOT_STANDING, NOT_TIMED, NOT_WHOLE, REFUSED, SESSIONS, ZONES, policyKit, type Listed, type PolicyKit, type RowSpec } from './policy';

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

  describe('a rule ends at a time written one way', () => {
    const MS = 86_400_000;
    /** A time 30 days out as a card must write it, and the same moment written with no zone (as a session in UTC would read it). */
    const iso = () => pk.inDays(30);
    const bare = (t: string) => t.slice(0, 19).replace('T', ' ');
    /**
     * A date written as numbers that is a different day read month-first than read day-first, both within the 180
     * days a rule may last (so that a guard which read it at all would make a row either way): the first of a month.
     */
    const twoWays = (): string => {
      for (let d = 20; d < 150; d++) {
        const t = new Date(Date.now() + d * MS);
        const [mm, dd] = [t.getUTCMonth() + 1, t.getUTCDate()];
        if (dd === 1 && mm > 1) return `${String(mm).padStart(2, '0')}/01/${t.getUTCFullYear()} 00:00:00+00`;
      }
      throw new Error('no first of a month in the next 150 days');
    };
    const rowsBy2 = async (aid: string) => (await owner(`SELECT count(*)::int AS n, count(DISTINCT "expiresAt")::int AS ends FROM "ActionPolicy" WHERE "approvalId" = $1`, [aid])).rows[0] as { n: number; ends: number };
    /** A card filed before the database held a rule's end to its one shape (the shape trigger set aside), signed and being carried out. */
    const filedBefore = async (rows: unknown[]) => {
      const k = kit();
      return k.sign(await k.without('Proposal_policy_shape', (q) => k.file('policy.change', { rows }, { kind: 'policy', origin: 'cli' }, q)), 'policy.change');
    };

    it('in full, with its zone, is filed; no zone, a date that reads two ways, a zone by name, a word, or no moment at all is refused by the database, whoever files it', async () => {
      const k = kit();
      const f = fam();
      const row = (expiresAt: unknown) => ({ pattern: `${f}.sync`, tier: 'alone', ...(expiresAt === undefined ? {} : { expiresAt }) });
      for (const good of ['2027-01-02T03:04:05Z', '2027-01-02T03:04:05.6Z', '2027-01-02T03:04:05.678Z', '2027-01-02T03:04:05+05:30', '2027-01-02T03:04:05.000-06:00', '2027-01-02T24:00:00Z']) {
        await k.file('policy.change', { rows: [row(good)] }, { kind: 'policy', origin: 'cli' });
      }
      const bad: Array<[string, unknown]> = [
        ['no zone (the reviewed card)', bare(iso())],
        ['a date that reads two ways (the reviewed card)', twoWays()],
        ['no zone, with its T', '2027-01-02T03:04:05'],
        ['a space for the T', '2027-01-02 03:04:05Z'],
        ['a zone by name', '2027-01-02T03:04:05 America/Chicago'],
        ['a zone by its letters', '2027-01-02T03:04:05 CST'],
        ['a zone with no colon', '2027-01-02T03:04:05+0000'],
        ['a zone in hours alone', '2027-01-02T03:04:05+00'],
        ['a small z', '2027-01-02T03:04:05z'],
        ['no seconds', '2027-01-02T03:04Z'],
        ['finer than a millisecond', '2027-01-02T03:04:05.6789Z'],
        ['a comma for the point', '2027-01-02T03:04:05,6Z'],
        ['a date alone', '2027-01-02'],
        ['a year of two digits', '27-01-02T03:04:05Z'],
        ['words the database reads as a time', 'now'],
        ['tomorrow', 'tomorrow'],
        ['for ever', 'infinity'],
        ['the epoch', 'epoch'],
        ['seconds as text', '1798859045'],
        ['a space in front', ' 2027-01-02T03:04:05Z'],
        ['a line after', '2027-01-02T03:04:05Z\n'],
        ['two times', '2027-01-02T03:04:05Z 2027-01-02T03:04:05Z'],
        ['nothing', ''],
        ['null', null],
        ['no end at all', undefined],
        ['a number', 1798859045],
        ['a list', ['2027-01-02T03:04:05Z']],
        ['an object', { at: '2027-01-02T03:04:05Z' }],
        // Written the one way, and no moment: read as one only once it is written that way, and refused the same.
        ['a thirteenth month', '2027-13-02T03:04:05Z'],
        ['the 30th of February', '2027-02-30T03:04:05Z'],
        ['the 25th hour', '2027-01-02T25:04:05Z'],
        ['a zone 99 hours off', '2027-01-02T03:04:05+99:00'],
        ['the year nought', '0000-01-02T03:04:05Z'],
      ];
      for (const [name, end] of bad) {
        const pid = id('prop');
        for (const q of [app, owner]) {
          expect(await failure(k.file('policy.change', { rows: [row(end)] }, { kind: 'policy', origin: 'cli', id: pid }, q)), name).toEqual(['23514', NOT_TIMED(pid), null]);
        }
      }
      // One such end among good ones, a row that is no object, and the session's own settings make no difference.
      const pid = id('prop');
      expect(await failure(k.file('policy.change', { rows: [row(iso()), row(bare(iso())), row(iso())] }, { kind: 'policy', origin: 'cli', id: pid }))).toEqual(['23514', NOT_TIMED(pid), null]);
      expect(await failure(k.file('policy.change', { rows: [row(iso()), 'alone'] }, { kind: 'policy', origin: 'cli', id: pid }))).toEqual(['23514', NOT_TIMED(pid), null]);
      for (const settings of SESSIONS) {
        await pk.session(settings, async (q) => {
          for (const end of [bare(iso()), twoWays()]) expect(await failure(k.file('policy.change', { rows: [row(end)] }, { kind: 'policy', origin: 'cli', id: pid }, q)), JSON.stringify(settings)).toEqual(['23514', NOT_TIMED(pid), null]);
        });
      }
      // A card that switches rules off lists no ends, and is filed as before; an error repeats a card's id only when it is shaped as one.
      await k.file('policy.change', { off: [{ id: 'ap1', pattern: 'x.y', tier: 'approval' }] }, { kind: 'policy', origin: 'cli' });
      expect(await failure(k.file('policy.change', { rows: [row('now')] }, { kind: 'policy', id: 'Synthetic CANARY words' }))).toEqual(['23514', NOT_TIMED('?'), null]);
    });

    it('the reviewed cards, filed before the database held the shape: neither makes a row, under eight time zones and both ways of reading a date', async () => {
      const f = fam();
      // 1. One listed row whose end has no zone: read under the session's own zone it was a different moment in each,
      // and the card made its row once for every one of them (eight rows from a card listing one).
      const noZone = { pattern: `mcp:${f}.*`, tier: 'alone' as const, expiresAt: bare(iso()) };
      // 2. One whose end is a date that reads two ways: two rows, ending on different days.
      const twice = { pattern: `mcp:${f}two.*`, tier: 'alone' as const, expiresAt: twoWays() };
      for (const listed of [noZone, twice]) {
        const card = await filedBefore([listed]);
        for (const settings of SESSIONS) {
          const rid = id('pol');
          // The row's own end is sent as the card writes it, for the session to read as it will (as the reviewed runs did).
          expect(await failure(pk.session(settings, (q) => pk.make(q, card.aid, listed, rid))), `${listed.expiresAt} under ${JSON.stringify(settings)}`).toEqual(['42501', NOT_STANDING(rid), null]);
        }
        // ...nor sent as any one moment it could be read as.
        const rid = id('pol');
        expect(await failure(pk.make(app, card.aid, { ...listed, expiresAt: iso() }, rid))).toEqual(['42501', NOT_STANDING(rid), null]);
        expect(await rowsBy2(card.aid)).toEqual({ n: 0, ends: 0 });
        await kit().finish(card.pid);
      }
      // (That the two readings of the second card do differ, and would each have made a row within a rule's 180 days.)
      const [mdy, dmy] = await Promise.all(['ISO, MDY', 'ISO, DMY'].map(async (DateStyle) => (await pk.session({ DateStyle, TimeZone: 'UTC' }, (q) => q(`SELECT $1::timestamptz AS t`, [twice.expiresAt]))).rows[0].t as Date));
      expect(mdy!.getTime()).not.toBe(dmy!.getTime());
      for (const t of [mdy!, dmy!]) expect(t.getTime()).toBeLessThan(Date.now() + 180 * MS);
    });

    it('a card from before whose end is written any other way makes no row either: each way a looser reading would let through', async () => {
      const f = fam();
      const t0 = iso();
      const ends: Array<[string, unknown]> = [
        ['no zone, with its T', t0.slice(0, 23)],
        ['a space for the T', t0.replace('T', ' ')],
        ['a zone with no colon', t0.replace('Z', '+0000')],
        ['finer than a millisecond', t0.replace('.000Z', '.0000Z')],
        ['a space in front', ` ${t0}`],
        ['a line after', `${t0}\n`],
        ['a word the database reads as a time', 'tomorrow'],
        ['null', null],
        ['no end at all', undefined],
        ['a number', Date.parse(t0) / 1000],
      ];
      for (const [name, end] of ends) {
        const listed = { pattern: `${f}.sync`, tier: 'alone' as const, ...(end === undefined ? {} : { expiresAt: end }) };
        const card = await filedBefore([listed]);
        // The row sent ending at the moment the card meant, and ending as the card wrote it (where that is text at all).
        for (const expiresAt of [t0, ...(typeof end === 'string' ? [end] : [])]) {
          const rid = id('pol');
          expect(await failure(pk.make(app, card.aid, { pattern: listed.pattern, tier: 'alone', expiresAt }, rid)), `${name}, sent as ${JSON.stringify(expiresAt)}`).toEqual(['42501', NOT_STANDING(rid), null]);
        }
        expect(await rowsBy2(card.aid)).toEqual({ n: 0, ends: 0 });
        await kit().finish(card.pid);
      }
      // The same beside a good row: a card is read whole, so one such end and no row of the card is made.
      const good = pk.listed([{ pattern: `${f}.good`, tier: 'alone' }])[0]!;
      const mixed = await filedBefore([good, { pattern: `${f}.sync`, tier: 'alone' }]);
      const rid = id('pol');
      expect(await failure(pk.make(app, mixed.aid, good, rid))).toEqual(['42501', NOT_STANDING(rid), null]);
      await kit().finish(mixed.pid);
    });

    it('the honest card’s row lands once, whatever the session’s zone or way of reading a date: one moment, written one way', async () => {
      const f = fam();
      const [listed] = pk.listed([{ pattern: `${f}.sync`, tier: 'alone', expiresAt: iso() }]) as [Listed];
      const card = await pk.rowsCard([listed]);
      // The same moment as a session far from UTC would write it: still that one row.
      const elsewhere = `${new Date(Date.parse(listed.expiresAt) + 5.5 * 3_600_000).toISOString().slice(0, 23)}+05:30`;
      expect(Date.parse(elsewhere)).toBe(Date.parse(listed.expiresAt));
      await pk.session(SESSIONS[9]!, (q) => pk.make(q, card.aid, { ...listed, expiresAt: elsewhere }));
      for (const settings of SESSIONS) {
        for (const expiresAt of [listed.expiresAt, elsewhere]) {
          const rid = id('pol');
          expect(await failure(pk.session(settings, (q) => pk.make(q, card.aid, { ...listed, expiresAt }, rid))), JSON.stringify(settings)).toEqual(['42501', MADE_ALREADY(rid), null]);
        }
      }
      expect(await rowsBy2(card.aid)).toEqual({ n: 1, ends: 1 });
      await kit().finish(card.pid);
      // A card may write its ends in any zone, so long as it writes one: its row lands once too.
      const [abroad] = pk.listed([{ pattern: `${f}.abroad`, tier: 'alone', expiresAt: elsewhere }]) as [Listed];
      const second = await pk.rowsCard([abroad]);
      await pk.session(SESSIONS[4]!, (q) => pk.make(q, second.aid, { ...abroad, expiresAt: listed.expiresAt }));
      const rid = id('pol');
      expect(await failure(pk.session(SESSIONS[11]!, (q) => pk.make(q, second.aid, abroad, rid)))).toEqual(['42501', MADE_ALREADY(rid), null]);
      expect(await rowsBy2(second.aid)).toEqual({ n: 1, ends: 1 });
      await kit().finish(second.pid);
    });

    it('an end that is written the one way and is no moment (a card from before): no row, as a refusal by the row’s id and never a fault', async () => {
      const f = fam();
      for (const end of ['2027-13-02T03:04:05Z', '2027-02-30T03:04:05Z', '2027-01-02T03:04:05+99:00']) {
        const good = pk.listed([{ pattern: `${f}.sync`, tier: 'alone' }])[0]!;
        const card = await filedBefore([good, { pattern: `${f}.never`, tier: 'alone', expiresAt: end }]);
        const rid = id('pol');
        expect(await failure(pk.make(app, card.aid, good, rid)), end).toEqual(['42501', NOT_STANDING(rid), null]);
        expect(await rowsBy2(card.aid)).toEqual({ n: 0, ends: 0 });
        await kit().finish(card.pid);
      }
    });

    it('at the commit too: a card’s rows are read as moments only as a card writes them, so one rewritten with no zone in the same transaction makes none', async () => {
      const f = fam();
      // As the owner, who alone can rewrite a card (the card table's own rules set aside for the statement): the row
      // lands under the honest card, and the card is then made to list that end with no zone, or as no moment.
      for (const [name, rewrite] of [['no zone', (t: string) => t.slice(0, 23)], ['no moment', () => '2027-13-02T03:04:05Z']] as Array<[string, (t: string) => string]>) {
        const [listed] = pk.listed([{ pattern: `${f}.sync`, tier: 'alone' }]) as [Listed];
        const card = await pk.rowsCard([listed]);
        const rid = id('pol');
        expect(await failure(pk.session({ TimeZone: 'UTC' }, async (q) => {
          await q('BEGIN');
          await pk.make(q, card.aid, listed, rid);
          await q('ALTER TABLE "Proposal" DISABLE TRIGGER USER');
          await q(`UPDATE "Proposal" SET args = $2::jsonb WHERE id = $1`, [card.pid, JSON.stringify({ rows: [{ ...listed, expiresAt: rewrite(listed.expiresAt) }] })]);
          await q('ALTER TABLE "Proposal" ENABLE TRIGGER USER');
          await q('COMMIT');
        }, urls.owner)), name).toEqual(['42501', NOT_READ(rid), null]);
        expect(await rowsBy2(card.aid)).toEqual({ n: 0, ends: 0 });
        // Nothing of that transaction stayed: the card is as Will signed it, its rules on again, and its row is made.
        expect((await owner(`SELECT args->'rows'->0->>'expiresAt' AS t FROM "Proposal" WHERE id = $1`, [card.pid])).rows[0].t).toBe(listed.expiresAt);
        expect((await owner(`SELECT count(*)::int AS off FROM pg_trigger WHERE tgrelid = '"Proposal"'::regclass AND NOT tgisinternal AND tgenabled <> 'O'`)).rows[0].off).toBe(0);
        await makeAlone(card.aid, listed, rid);
        await kit().finish(card.pid);
      }
    });

    it('days are 24 hours whatever zone the session is in: a rule ends within 181 of them, and a card outlives Will’s approval by 7 of them, counted the same for every session', async () => {
      const k = kit();
      const f = fam();
      // 181 days from now is another moment by the wall clock of a zone whose clocks change in between (an hour
      // more or less). Half an hour inside 181 days of 24 hours is made in every zone; half an hour past is refused in every zone.
      const at = (ms: number) => new Date(Math.floor((Date.now() + ms) / 1000) * 1000).toISOString();
      for (const zone of [...ZONES, 'America/New_York', 'Europe/Berlin', 'America/Santiago', 'Pacific/Auckland']) {
        const [inside, past] = pk.listed([{ pattern: `${f}.in`, tier: 'alone', expiresAt: at(181 * MS - 1_800_000) }, { pattern: `${f}.past`, tier: 'alone', expiresAt: at(181 * MS + 1_800_000) }]) as [Listed, Listed];
        const [a, b] = [await pk.rowsCard([inside]), await pk.rowsCard([past])];
        const rid = id('pol');
        await pk.session({ TimeZone: zone }, (q) => pk.make(q, a.aid, inside));
        expect(await failure(pk.session({ TimeZone: zone }, (q) => pk.make(q, b.aid, past, rid))), zone).toEqual(['P0001', `policy row ${rid}: expires more than 180 days out`, null]);
        expect([(await rowsBy2(a.aid)).n, (await rowsBy2(b.aid)).n], zone).toEqual([1, 0]);
        await k.finish(a.pid);
        await k.finish(b.pid);
      }
      // A card that outlives his approval by 7 days and half an hour makes no row, even where the clocks go back
      // inside those days (7 days by that zone's wall clock are 7 days and an hour); half an hour inside, it does.
      const [listed] = pk.listed([{ pattern: `${f}.sync`, tier: 'alone' }]) as [Listed];
      const over = await pk.acrossClocksBack({ rows: [listed] }, '30 minutes');
      for (const zone of [over.zone, ...ZONES]) {
        const rid = id('pol');
        expect(await failure(pk.session({ TimeZone: zone }, (q) => pk.make(q, over.aid, listed, rid))), zone).toEqual(['42501', NOT_STANDING(rid), null]);
      }
      expect(await rowsBy2(over.aid)).toEqual({ n: 0, ends: 0 });
      await k.finish(over.pid);
      const within = await pk.acrossClocksBack({ rows: [listed] }, '-30 minutes');
      await pk.session({ TimeZone: within.zone }, (q) => pk.make(q, within.aid, listed));
      expect(await rowsBy2(within.aid)).toEqual({ n: 1, ends: 1 });
      await k.finish(within.pid);
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

    // Two rows of one card that differ in one thing only are two rows: each is counted, and made, as itself.
    const TWINS: Array<[string, (f: string) => [RowSpec, RowSpec]]> = [
      ['pattern', (f) => [{ pattern: `${f}.a`, tier: 'alone' }, { pattern: `${f}.b`, tier: 'alone' }]],
      ['tier', (f) => [{ pattern: `${f}.a`, tier: 'alone' }, { pattern: `${f}.a`, tier: 'approval' }]],
      ['cap', (f) => [{ pattern: `${f}.a`, tier: 'alone' }, { pattern: `${f}.a`, tier: 'alone', dailyCap: 2 }]],
      ['scope', (f) => [{ pattern: `${f}.a`, tier: 'alone' }, { pattern: `${f}.a`, tier: 'alone', scope: { endpoints: ['a'] } }]],
      ['end', (f) => [{ pattern: `${f}.a`, tier: 'alone', expiresAt: pk.inDays(30) }, { pattern: `${f}.a`, tier: 'alone', expiresAt: pk.inDays(31) }]],
    ];
    it.each(TWINS)('two rows of one card that differ only in their %s: neither lands without the other, both land together, and neither is made again', async (_what, make) => {
      const k = kit();
      const [a, b] = pk.listed(make(fam())) as [Listed, Listed];
      const pc = await pk.rowsCard([a, b]);
      const rid = id('pol');
      expect(await failure(makeAlone(pc.aid, a, rid))).toEqual(['42501', NOT_WHOLE(rid), null]);
      expect(await failure(makeAlone(pc.aid, b, rid))).toEqual(['42501', NOT_WHOLE(rid), null]);
      // The same one twice is not the two.
      expect((await pgError(makeAll(pc.aid, [a, a]))).code).toBe('42501');
      expect(await rowsBy(pc.aid)).toEqual([]);
      await makeAll(pc.aid, [a, b]);
      expect((await rowsBy(pc.aid)).length).toBe(2);
      expect(await failure(makeAlone(pc.aid, a, rid))).toEqual(['42501', MADE_ALREADY(rid), null]);
      expect(await failure(makeAlone(pc.aid, b, rid))).toEqual(['42501', MADE_ALREADY(rid), null]);
      await k.finish(pc.pid);
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

    it('a row alike made under another card does not stand in for this card’s own', async () => {
      const k = kit();
      const f = fam();
      const [wide, brake] = pk.listed([{ pattern: `${f}.*`, tier: 'alone' }, { pattern: `${f}.propose`, tier: 'approval' }]) as [Listed, Listed];
      // An earlier table made the very same brake (the same words, limit and end), and it is still on.
      const earlier = await pk.rowsCard([brake]);
      await makeAlone(earlier.aid, brake);
      await k.finish(earlier.pid);
      // A later table lists the wide row and that brake again. Its wide row alone is still a part of it.
      const later = await pk.rowsCard([wide, brake]);
      const rid = id('pol');
      expect(await failure(makeAlone(later.aid, wide, rid))).toEqual(['42501', NOT_WHOLE(rid), null]);
      await makeAll(later.aid, [wide, brake]);
      expect((await rowsBy(later.aid)).length).toBe(2);
      await k.finish(later.pid);
    });

    it('the check at the commit repeats an id only when it is shaped as one (the row guard set aside by the owner, as a repair by hand might)', async () => {
      const [wide, brake] = pk.listed([{ pattern: `${fam()}.*`, tier: 'alone' }, { pattern: `${fam()}.propose`, tier: 'approval' }]) as [Listed, Listed];
      const pc = await pk.rowsCard([wide, brake]);
      for (const [rid, shown] of [['Synthetic CANARY words as an id', '?'], [id('pol'), null]] as Array<[string, string | null]>) {
        expect(await failure(kit().inTx(async (q) => {
          await q('ALTER TABLE "ActionPolicy" DISABLE TRIGGER "ActionPolicy_matches_approval"');
          await pk.make(q, pc.aid, wide, rid);
          // The commit's check, asked for now: it refuses, and the transaction (the guard set aside with it) is undone.
          await q('SET CONSTRAINTS ALL IMMEDIATE');
          await q('ALTER TABLE "ActionPolicy" ENABLE TRIGGER "ActionPolicy_matches_approval"');
        }, { url: urls.owner }))).toEqual(['42501', NOT_WHOLE(shown ?? rid), null]);
      }
      expect(await rowsBy(pc.aid)).toEqual([]);
      // The row guard is on again, as it was.
      expect((await owner(`SELECT tgenabled FROM pg_trigger WHERE tgname = 'ActionPolicy_matches_approval' AND NOT tgisinternal`)).rows).toEqual([{ tgenabled: 'O' }]);
      await kit().finish(pc.pid);
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
      // Forged past P1's rule on cards, as the owner (the state a changed backup could bring): a card being carried out
      // under his signed no, under a signature on something that is not a card, under his yes to another card, to
      // another action, and to other args.
      const forgeries: Array<[string, (pid: string, digest: string) => Promise<string>, (aid: string) => string]> = [
        ['his signed no', (pid, digest) => k.approval(pid, 'policy.change', digest, { decision: 'reject' }), (aid) => `policy row: approval ${aid} is not an approved proposal`],
        ['a signature on something that is not a card', (pid, digest) => k.approval(pid, 'policy.change', digest, { subjectType: 'policy' }), (aid) => `policy row: approval ${aid} is not an approved proposal`],
        ['his yes to another card', async (_pid, digest) => k.approval((await k.file('policy.change', { rows: pk.listed([{ pattern: `${fam()}.x`, tier: 'alone' }]) }, { kind: 'policy' })).pid, 'policy.change', digest), () => NOT_EXECUTING(rid)],
        ['his yes to another action', (pid, digest) => k.approval(pid, 'world.source.enable', digest), () => NOT_STANDING(rid)],
        ['his yes to other args', (pid) => k.approval(pid, 'policy.change', digestOf({ rows: [] })), () => NOT_STANDING(rid)],
      ];
      for (const [what, approve, says] of forgeries) {
        const filed = await k.file('policy.change', { rows }, { kind: 'policy' });
        const aid = await approve(filed.pid, filed.digest);
        await k.without('Proposal_transition', (q) => q(`UPDATE "Proposal" SET status = 'executing', "approvalId" = $2 WHERE id = $1`, [filed.pid, aid]));
        expect(await failure(makeAlone(aid, rows[0]!, rid)), what).toEqual(['42501', says(aid), null]);
        await k.finish(filed.pid);
      }
      // A card from before the database held the shape, whose `rows` is not a list: refused as a card, never a fault.
      const odd = await k.without('Proposal_policy_shape', (q) => k.file('policy.change', { rows: rows[0]! }, { kind: 'policy' }, q));
      const oddSigned = await k.sign(odd, 'policy.change');
      expect(await failure(makeAlone(oddSigned.aid, rows[0]!, rid))).toEqual(['42501', NOT_EXECUTING(rid), null]);
      await k.finish(oddSigned.pid);
      for (const c of [kind, action, listed]) await k.finish(c.pid);
      expect(await pk.exists(rid)).toBe(false);
    });

    it('a second signature on the same card makes nothing: a row is made under the approval its card is carried out on, and no other', async () => {
      const k = kit();
      const rows = one();
      const card = await pk.rowsCard(rows);
      await makeAlone(card.aid, rows[0]!);
      // Will's yes to the same card and the same args, recorded a second time (the server's role can record one): were a
      // row counted under whichever approval names the card, each new signature would make the card's rows again.
      const second = await k.approval(card.pid, 'policy.change', digestOf({ rows }));
      const rid = id('pol');
      expect(await failure(makeAlone(second, rows[0]!, rid))).toEqual(['42501', NOT_EXECUTING(rid), null]);
      expect((await rowsBy(card.aid)).length).toBe(1);
      expect(await pk.exists(rid)).toBe(false);
      await k.finish(card.pid);
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
    it('for at most 180 days, and born on (P1’s own rules, as before)', async () => {
      const rid = id('pol');
      const [long] = pk.listed([{ pattern: `${fam()}.sync`, tier: 'alone', expiresAt: pk.inDays(182) }]);
      const card = await pk.rowsCard([long!]);
      expect(await failure(makeAlone(card.aid, long!, rid))).toEqual(['P0001', `policy row ${rid}: expires more than 180 days out`, null]);
      const [ok] = pk.listed([{ pattern: `${fam()}.sync`, tier: 'alone', expiresAt: pk.inDays(180) }]);
      const fine = await pk.rowsCard([ok!]);
      expect(await failure(app(
        `INSERT INTO "ActionPolicy" (id, pattern, tier, reason, "approvalId", "expiresAt", active) VALUES ($1, $2, 'alone', 'Synthetic rule', $3, $4, false)`, [rid, ok!.pattern, fine.aid, ok!.expiresAt],
      ))).toEqual(['P0001', `policy row ${rid}: inserted inactive`, null]);
      await makeAlone(fine.aid, ok!, rid);
      expect(await pk.isOn(rid)).toBe(true);
      await kit().finish(card.pid);
      await kit().finish(fine.pid);
    });

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
