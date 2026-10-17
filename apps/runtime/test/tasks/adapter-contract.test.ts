/**
 * The contract every asset's adapter passes (P5), run against the CI watcher
 * and a stand-in for an asset that spends. No adapter that spends is built, and
 * none is called here: the stand-in is a function in this file.
 *
 *  - An adapter is pure: it is handed the signed spec and the items' clean
 *    facts, and gives back exactly one of a result (its template's shape, with
 *    a sentence about it), a wait, or a failure's class. It never throws, and
 *    never changes what it was given.
 *  - Its estimate is known before any card is filed: nothing for an asset on
 *    this Mac; whole hundreds of millionths of a dollar for one that spends.
 *  - Nothing under tasks/adapters reaches outside what it is handed: every
 *    file in the tree, in any sub-directory and under any extension, is read
 *    and held to that, and a table of ways around it shows each is caught.
 *  - The path money takes, on flint_test: the estimate on the task and on a
 *    spend card only Will files; refused while nothing sets the money aside
 *    ("Paid tasks are off."); money set aside under the card's id, once, and
 *    given back when the dispatch does not happen; and a task that went out
 *    ends with what it cost.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PAID_DISPATCH, TASK_FAILURES, TASK_OUTPUTS, TASK_REASONS, TASK_SAYS, TaskSpec, digestOf, noteProblems } from '@flint/policy';
import { NO_DB, freshDb, id, withClient, type TestUrls } from '../db';
import { createDb, type Db } from '../../src/db';
import { Refused, expireProposals, rejectProposal } from '../../src/governance/proposals';
import { runInternal } from '../../src/governance/internal';
import { jsonbBytes } from '../../src/jsonsize';
import { ASSETS, CI_WATCHER, assetOf, type AssetDef, enableArgsOf } from '../../src/assets/registry';
import { syncAssets, turnOff } from '../../src/assets/service';
import { ciWatch } from '../../src/tasks/adapters/ci-watch';
import type { AdapterInput, ItemFact, TaskAdapter } from '../../src/tasks/adapters/types';
import { runTaskCard, type Reserve } from '../../src/tasks/card';
import { checkTaskJob } from '../../src/tasks/check';
import { runTaskJob } from '../../src/tasks/run';
import { cancelTask, createTask } from '../../src/tasks/service';
import { taskTick } from '../../src/tasks/tick';
import { CANARY, FakeBus, SHA, draft, taskFixture, type TaskFixture } from './fixture';

/** A stand-in for an asset that spends: it "writes" a note and says what that cost. It calls nothing. */
const paid: TaskAdapter = {
  kind: 'nexus_participant',
  estimate: (spec) => (spec.template === 'draft_note' ? 250_000 : 0),
  run: async ({ spec }) => (spec.template === 'draft_note' ? { output: { title: 'A Note', body: 'Its text.' }, summary: 'It wrote a note.' } : { failure: 'invalid' }),
  meter: async () => ({ micros: 200_000, estimate: false }),
};

const ci = (state: ItemFact['state']): ItemFact => ({ id: 'en1', ref: 'ci_run#000en1', kind: 'ci_run', state });
const watch = TaskSpec.parse({ template: 'watch_ci', params: { item: 'en1' } });
const note = TaskSpec.parse({ template: 'draft_note', params: { about: 'What to write' } });

const CASES: Array<{ name: string; adapter: TaskAdapter; spends: boolean; inputs: Array<{ spec: TaskSpec; items: ItemFact[]; gives: 'output' | 'wait' | 'failure' }> }> = [
  {
    name: 'the CI watcher', adapter: ciWatch, spends: false,
    inputs: [
      { spec: watch, items: [ci({ status: 'completed', conclusion: 'success', sha: SHA })], gives: 'output' },
      { spec: watch, items: [ci({ status: 'completed', conclusion: 'made-up', sha: 'not a commit' })], gives: 'output' },
      { spec: watch, items: [ci({ status: 'in_progress', conclusion: null })], gives: 'wait' },
      { spec: watch, items: [ci({})], gives: 'wait' },
      { spec: watch, items: [], gives: 'failure' },
      { spec: watch, items: [{ ...ci({ status: 'completed' }), kind: 'issue' }], gives: 'failure' },
      { spec: watch, items: [{ ...ci({ status: 'completed' }), id: 'another' }], gives: 'failure' },
      { spec: note, items: [], gives: 'failure' },
    ],
  },
  { name: 'an asset that spends', adapter: paid, spends: true, inputs: [{ spec: note, items: [], gives: 'output' }, { spec: watch, items: [], gives: 'failure' }] },
];

function freeze<T>(v: T): T {
  if (v && typeof v === 'object') for (const x of Object.values(v)) freeze(x);
  return Object.freeze(v);
}

const ADAPTERS_DIR = join(__dirname, '..', '..', 'src', 'tasks', 'adapters');
/** The files there are, and no other: a new one is a reviewed change to this list. */
const ADAPTER_FILES = ['ci-watch.ts', 'types.ts'];

/** Every file under a directory, at any depth, by its path from there. */
function filesUnder(dir: string, from = dir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesUnder(join(dir, e.name), from) : [relative(from, join(dir, e.name)).split('\\').join('/')])).sort();
}

/**
 * Why a tree of adapter files is not allowed, one line a problem (none when it
 * is fine). Every file is read, whatever its extension and however deep, and
 * held to the same rules: its only imports are types, from the shared
 * contracts or a neighbour here, in any quote style; and it names nothing that
 * reaches outside what an adapter is handed (not even to keep it for later).
 */
function adapterTreeProblems(dir: string): string[] {
  const problems: string[] = [];
  for (const f of filesUnder(dir)) {
    if (!ADAPTER_FILES.includes(f)) problems.push(`${f}: not one of the adapters`);
    // The file without its comments: what it does, not what it says about itself.
    const src = readFileSync(join(dir, f), 'utf8').replace(/\/\*[\s\S]*?\*\/|(^|[^:'"`])\/\/.*$/gm, '$1');
    // Every module it names, however the statement is written: `import … from`, `export … from`, `import '…'`.
    const named = [...src.matchAll(/\b(import|export)\b(\s+type\b)?[^;'"`]*?\bfrom\s*(['"`])([^'"`]*)\3|\bimport\s*(['"`])([^'"`]*)\5/g)]
      .map((m) => ({ from: m[4] ?? m[6] ?? '', typeOnly: m[1] === 'import' && m[2] !== undefined }));
    if (ADAPTER_FILES.includes(f) && named.length === 0) problems.push(`${f}: imports nothing, so it is not an adapter of the shared contract`);
    for (const i of named) {
      const allowed = i.typeOnly && (i.from === '@flint/policy' || /^\.\/[a-z-]+\.js$/.test(i.from));
      if (!allowed) problems.push(`${f}: imports ${i.from}${i.typeOnly ? '' : ' (not as a type)'}`);
    }
    const reaches = (what: string, pattern: RegExp) => {
      if (pattern.test(src)) problems.push(`${f}: names ${what}`);
    };
    reaches('fetch', /\bfetch\b|scopedFetch|XMLHttpRequest|WebSocket|EventSource/);
    reaches('require or import(', /\brequire\b|\bimport\s*\(|\bimport\.meta\b/);
    reaches('a node module', /['"`]node:/);
    reaches('process, a global or eval', /\bprocess\b|\bglobalThis\b|\bglobal\b|\beval\b|\bFunction\s*\(|new\s+Function\b/);
    // A function's constructor makes code from text, and with it the global object, whatever the names are split into.
    reaches('constructor', /\bconstructor\b/);
    // An escape spells a name the rules above would not see (`f\u0065tch`): none is needed here, so none is allowed.
    reaches('an escape', /\\u|\\x/);
    // The log is a place too: an adapter hands back a result, and writes nowhere.
    reaches('console', /\bconsole\b/);
    reaches('the database', /Prisma|\$queryRaw|\$executeRaw|\$transaction/);
  }
  return problems;
}

/** A stand-in for what sets a paid task's money aside: what each card holds, and every call made, in order. */
function reserveBook(o: { answer?: boolean; releaseFails?: boolean } = {}) {
  const held = new Map<string, number>();
  const calls: string[] = [];
  const reserve: Reserve = {
    take: async (key, micros) => {
      calls.push(`take ${key} ${micros}`);
      if (o.answer === false) return false;
      held.set(key, micros);
      return true;
    },
    release: async (key) => {
      calls.push(`release ${key}`);
      if (o.releaseFails) throw new Error('the release did not go through');
      held.delete(key);
    },
  };
  return { reserve, held, calls };
}

describe('the adapter contract', () => {
  for (const c of CASES) {
    it(`${c.name}: one of a result, a wait or a failure's class; never a throw, never a change to what it was given`, async () => {
      for (const i of c.inputs) {
        const input: AdapterInput = freeze({ taskId: 'tkabcdefgh12345678', spec: i.spec, items: i.items, now: new Date('2026-10-12T10:00:00.000Z') });
        const before = JSON.stringify(input);
        const r = await c.adapter.run(input);
        expect(JSON.stringify(input)).toBe(before);
        expect(Object.keys(r).sort(), JSON.stringify(i)).toEqual(i.gives === 'output' ? ['output', 'summary'] : [i.gives]);
        if ('output' in r) {
          // Its template's shape, strictly, within the size the database takes; the sentence about it is fit to show.
          expect(TASK_OUTPUTS[i.spec.template].safeParse(r.output).success).toBe(true);
          expect(jsonbBytes(r.output)).toBeLessThanOrEqual(32_768);
          expect(r.summary.length).toBeGreaterThan(0);
          expect(r.summary.length).toBeLessThanOrEqual(1000);
          expect(noteProblems('A Title', r.summary)).toEqual([]);
        } else if ('failure' in r) expect(TASK_FAILURES).toContain(r.failure);
        else expect(r).toEqual({ wait: true });
      }
    });

    it(`${c.name}: its estimate is known before any card, as whole hundreds of millionths of a dollar${c.spends ? '' : ', and is nothing'}`, () => {
      for (const spec of [watch, note]) {
        const micros = c.adapter.estimate(spec);
        expect(Number.isInteger(micros) && micros >= 0 && micros % 100 === 0, `${spec.template}: ${micros}`).toBe(true);
        if (!c.spends) expect(micros).toBe(0);
      }
      // Only an asset that spends says what a run cost.
      expect(typeof c.adapter.meter).toBe(c.spends ? 'function' : 'undefined');
      expect(c.adapter.kind).toMatch(/^[a-z_]+$/);
    });
  }

  it('nothing under tasks/adapters reaches a file, a process, the network, the environment or the database: an adapter works only on what it is handed', () => {
    expect(adapterTreeProblems(ADAPTERS_DIR)).toEqual([]);
  });

  it('the check itself: each way around it is caught, in any quote style, any sub-directory and under any extension', () => {
    const real = { 'ci-watch.ts': readFileSync(join(ADAPTERS_DIR, 'ci-watch.ts'), 'utf8'), 'types.ts': readFileSync(join(ADAPTERS_DIR, 'types.ts'), 'utf8') };
    const tree = (files: Record<string, string>): string[] => {
      const dir = mkdtempSync(join(tmpdir(), 'flint-adapters-'));
      try {
        for (const [name, text] of Object.entries({ ...real, ...files })) {
          mkdirSync(join(dir, name, '..'), { recursive: true });
          writeFileSync(join(dir, name), text);
        }
        return adapterTreeProblems(dir);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };
    const added = (line: string) => ({ 'ci-watch.ts': `${real['ci-watch.ts']}\n${line}\n` });
    // The tree as it is, copied: nothing to say. (So what follows is the addition's doing.)
    expect(tree({})).toEqual([]);
    const cases: Array<[string, Record<string, string>, RegExp]> = [
      ['a node module, single quotes', added(`import { execSync } from 'node:child_process';`), /ci-watch\.ts: imports node:child_process/],
      ['a node module, double quotes', added(`import { execSync } from "node:child_process";`), /ci-watch\.ts: imports node:child_process/],
      ['a node module, in backticks, by require', added('const cp = require(`node:child_process`);'), /ci-watch\.ts: .*require/],
      ['a bare module name', added(`import { readFileSync } from "fs";`), /ci-watch\.ts: imports fs/],
      ['an import over several lines', added(`import {\n  connect,\n} from 'node:net';`), /ci-watch\.ts: imports node:net/],
      ['an import for its effects', added(`import 'node:dns';`), /ci-watch\.ts: imports node:dns/],
      ['a re-export', added(`export { readFileSync } from 'node:fs';`), /ci-watch\.ts: imports node:fs/],
      ['a dynamic import', added(`const os = await import('node:os');`), /ci-watch\.ts: .*import\(/],
      ['a call to fetch', added(`await fetch('https://example.com/');`), /ci-watch\.ts: .*fetch/],
      ['fetch under another name', added(`const f = fetch;\nawait f('https://example.com/');`), /ci-watch\.ts: .*fetch/],
      ['fetch through call', added(`await fetch.call(undefined, 'https://example.com/');`), /ci-watch\.ts: .*fetch/],
      ['the environment', added(`const home = process.env.HOME;`), /ci-watch\.ts: .*process/],
      ['a value import from a neighbour', added(`import { helper } from './helper.js';`), /ci-watch\.ts: imports \.\/helper\.js/],
      ['a new file beside it', { 'extra.ts': `export const x = 1;\n` }, /extra\.ts: not one of the adapters/],
      ['a helper in a sub-directory', { 'lib/helper.ts': `import { execSync } from 'node:child_process';\nexport const run = execSync;\n` }, /lib\/helper\.ts: not one of the adapters/],
      ['a file under another extension', { 'net.mts': `import { connect } from 'node:net';\nexport const c = connect;\n` }, /net\.mts: not one of the adapters/],
      ['a compiled file', { 'ci-watch.js': `require('node:child_process');\n` }, /ci-watch\.js: not one of the adapters/],
      // Ways around the names above: code made from text, a name spelled with an escape, and the log.
      ['the global object through a function’s constructor, its names split', added(`const G = (() => {}).constructor('return this')() as any;\nexport const a = () => G['fe' + 'tch']('http://127.0.0.1:9/', { method: 'POST', body: G['pro' + 'cess'].env.HOME });`), /ci-watch\.ts: names constructor/],
      ['a built-in module through the split global', added(`const G = (async () => {}).constructor('return this')() as any;\nexport const a = () => G['pro' + 'cess']['getBuiltin' + 'Module']('no' + 'de:child_' + 'pro' + 'cess');`), /ci-watch\.ts: names constructor/],
      ['constructor by bracket', added(`const F = (() => {})['constructor'];`), /ci-watch\.ts: names constructor/],
      ['fetch spelled with an escape in the name', added(`export const a = () => f\\u0065tch('http://127.0.0.1:9/');`), /ci-watch\.ts: names an escape/],
      ['a name spelled with an escape in a string', added(`const k = '\\x66etch';`), /ci-watch\.ts: names an escape/],
      ['the log', added(`export const a = (input: unknown) => console.log(JSON.stringify(input));`), /ci-watch\.ts: names console/],
    ];
    for (const [name, files, says] of cases) expect(tree(files).join('\n'), name).toMatch(says);
    // A file that is new is read too, not only named: what it reaches for is said as well.
    expect(tree({ 'lib/helper.ts': `import { execSync } from "node:child_process";\n` }).join('\n')).toMatch(/lib\/helper\.ts: imports node:child_process/);
    expect(tree({ 'net.mts': `const f = fetch;\n` }).join('\n')).toMatch(/net\.mts: .*fetch/);
    // Words in a comment are not code.
    expect(tree(added(`// It never calls fetch, and imports nothing from 'node:fs'.\n/* process.env is not read. */`))).toEqual([]);
  });

  it('the watcher hands in what it saw as structural fields only: an unknown ending is none, a commit that is not hex is none', async () => {
    const seen = await ciWatch.run({ taskId: 'tk1', spec: watch, items: [ci({ status: 'completed', conclusion: 'made-up', sha: 'not a commit' })], now: new Date() });
    expect(seen).toEqual({ output: { ref: 'ci_run#000en1', status: 'completed', conclusion: null, sha: null }, summary: 'The run ended without passing.' });
  });
});

describe.skipIf(NO_DB)('the path money takes, on flint_test', () => {
  let urls: TestUrls;
  let db: Db;
  let fx: TaskFixture;
  const bus = new FakeBus();
  const asset: AssetDef = assetOf({ id: 'as-test-paid-v1', kind: 'nexus_participant', externalRef: 'nexus:test-participant', name: 'Paid Tasks', capabilities: ['draft_note'], spends: true, line: 'It runs on a Nexus participant and costs money.' });
  // The paid asset is the one that drafts a note here: the real local worker, which would also draft one, is left out.
  const registry = [...ASSETS.filter((a) => a.kind !== 'local_worker'), asset];
  const adapters = { nexus_participant: paid };
  const refusal = async (p: Promise<unknown>): Promise<Refused> => {
    try {
      await p;
    } catch (e) {
      if (e instanceof Refused) return e;
      throw e;
    }
    throw new Error('expected a refusal, got success');
  };
  const newTask = () => createTask(db, { draftKey: draft(), template: 'draft_note', params: { about: 'What to write' }, goalId: null, dueAt: null, ownCheck: null }, { registry, adapters });
  /** The stand-in asset, turned on by its own signed card (again, after a test turned it off). It is not in the code registry: no such asset is built. */
  async function again(): Promise<void> {
    await syncAssets(db, registry);
    if ((await db.asset.findUnique({ where: { id: asset.id } }))?.enabled) return;
    const args = enableArgsOf(asset);
    const pid = id('pr');
    await withClient(urls.app, (c) => c.query(
      `INSERT INTO "Proposal" (id, kind, origin, action, args, "argsDigest", "argsProvenance", tainted, sensitivity, consequential, "expiresAt")
       VALUES ($1, 'policy', 'console', 'asset.enable', $2::jsonb, $3, '{}'::jsonb, false, 'ops', true, now() + interval '1 hour')`,
      [pid, JSON.stringify(args), digestOf(args)],
    ));
    await fx.approve(pid);
    await runTaskCard(db, pid, undefined, 'UTC', 'test', { assets: true, registry });
  }

  beforeAll(async () => {
    urls = await freshDb();
    db = createDb(urls.app);
    fx = await taskFixture(urls, db, bus);
    await again();
  });
  afterAll(async () => db?.$disconnect());

  it('estimate before: the task and its card carry it, and the card is a spend card only Will files, marked for his own touch and a review', async () => {
    const t = await newTask();
    expect(Number((await fx.task(t.id)).estCostUsd)).toBe(0.25);
    const card = await db.proposal.findUniqueOrThrow({ where: { id: t.proposalId } });
    expect(card).toMatchObject({ kind: 'spend', origin: 'console', action: PAID_DISPATCH, consequential: true, reason: TASK_REASONS.paid, reviewRequired: true, tainted: false });
    expect(Number(card.estCostUsd)).toBe(0.25);
    expect((card.args as { estCostMicros: number }).estCostMicros).toBe(250_000);
    // As a task card, or with another estimate, it is not filed.
    const args = card.args as Record<string, unknown>;
    expect(await refusal(fx.file(PAID_DISPATCH, args, { kind: 'task' }))).toMatchObject({ status: 400, message: TASK_SAYS.kind });
    expect(await refusal(fx.file(PAID_DISPATCH, { ...args, estCostMicros: 0 }, { kind: 'spend' }))).toMatchObject({ status: 409, message: TASK_SAYS.changed });
  });

  it('refused at $0: nothing carries a paid dispatch out, and with nothing to set the money aside the card fails saying paid tasks are off', async () => {
    const t = await newTask();
    await fx.approve(t.proposalId);
    // The runtime's own executor list does not hold it: it fails closed, and the card is left as it was.
    expect(await refusal(runInternal(db, t.proposalId, undefined, 'UTC', 'test'))).toMatchObject({ status: 409, message: `${PAID_DISPATCH} is not carried out by the runtime` });
    expect(await db.proposal.findUniqueOrThrow({ where: { id: t.proposalId } })).toMatchObject({ status: 'approved' });
    // Handed straight to the task executor, with no way to reserve: refused, in a sentence.
    expect(await refusal(runTaskCard(db, t.proposalId, undefined, 'UTC', 'test', { assets: true, registry, bus }))).toMatchObject({ status: 409, message: TASK_SAYS.paidOff });
    expect(await db.proposal.findUniqueOrThrow({ where: { id: t.proposalId } })).toMatchObject({ status: 'failed', error: TASK_SAYS.paidOff });
    expect(await fx.task(t.id)).toMatchObject({ status: 'proposed', predictionId: null, costUsd: null });
    // The same when the answer to the reservation is no.
    const u = await newTask();
    const no = reserveBook({ answer: false });
    await fx.approve(u.proposalId);
    expect(await refusal(runTaskCard(db, u.proposalId, undefined, 'UTC', 'test', { assets: true, registry, bus, reserve: no.reserve }))).toMatchObject({ status: 409, message: TASK_SAYS.paidOff });
    // Asked once, under the card's id, for the card's estimate; and what was asked for is given back.
    expect(no.calls).toEqual([`take ${u.proposalId} 250000`, `release ${u.proposalId}`]);
    expect(no.held.size).toBe(0);
    expect(await fx.task(u.id)).toMatchObject({ status: 'proposed' });
    expect(bus.of('tasks.run')).toEqual([]);
  });

  it('money is set aside under the card\'s id, once: a fault gives it back, a retry takes it again, and one dispatch holds one reservation', async () => {
    const errs = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const fault = { afterWrites: async () => { throw new Error('a fault after the writes'); } };
      const deps = (book: ReturnType<typeof reserveBook>) => ({ assets: true, registry, bus, reserve: book.reserve });
      // A fault after the writes: nothing went out, the card is still approved, and the money is given back.
      const book = reserveBook();
      const t = await newTask();
      await fx.approve(t.proposalId);
      expect(await refusal(runTaskCard(db, t.proposalId, undefined, 'UTC', 'test', deps(book), fault))).toMatchObject({ status: 409 });
      expect(await db.proposal.findUniqueOrThrow({ where: { id: t.proposalId } })).toMatchObject({ status: 'approved' });
      expect(await fx.task(t.id)).toMatchObject({ status: 'proposed', predictionId: null });
      expect(book.calls).toEqual([`take ${t.proposalId} 250000`, `release ${t.proposalId}`]);
      expect(book.held.size).toBe(0);
      // The same card again: it goes out, holding exactly one reservation, for its estimate.
      expect(await runTaskCard(db, t.proposalId, undefined, 'UTC', 'test', deps(book))).toMatchObject({ taskId: t.id });
      expect([...book.held]).toEqual([[t.proposalId, 250_000]]);
      expect(book.calls).toEqual([`take ${t.proposalId} 250000`, `release ${t.proposalId}`, `take ${t.proposalId} 250000`]);
      expect(await db.task.count({ where: { id: t.id, status: 'queued' } })).toBe(1);
      // Once more (it already ran): nothing more is asked for.
      expect(await refusal(runTaskCard(db, t.proposalId, undefined, 'UTC', 'test', deps(book)))).toMatchObject({ status: 409, message: 'It already ran.' });
      expect(book.calls).toHaveLength(3);

      // A release that does not go through leaves the card's one reservation in place, and the retry adds none.
      const stuck = reserveBook({ releaseFails: true });
      const u = await newTask();
      await fx.approve(u.proposalId);
      expect(await refusal(runTaskCard(db, u.proposalId, undefined, 'UTC', 'test', deps(stuck), fault))).toMatchObject({ status: 409 });
      expect([...stuck.held]).toEqual([[u.proposalId, 250_000]]);
      expect(await runTaskCard(db, u.proposalId, undefined, 'UTC', 'test', deps(stuck))).toMatchObject({ taskId: u.id });
      expect([...stuck.held]).toEqual([[u.proposalId, 250_000]]);

      // A failure that comes after the card ran (the commit went through, then the connection dropped) gives
      // nothing back: the task went out, and its reservation stays with it.
      const through = <T extends object>(target: T, over: (key: string | symbol) => unknown): T => new Proxy(target, {
        get: (t, key) => {
          const mine = over(key);
          if (mine !== undefined) return mine;
          const v = Reflect.get(t, key) as unknown;
          return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
        },
      });
      const transact = db.$transaction.bind(db) as (...a: unknown[]) => Promise<unknown>;
      const dropsAfterCommit = through(db, (key) => (key === '$transaction' ? async (...a: unknown[]) => { await transact(...a); throw new Error('the connection dropped after the commit'); } : undefined));
      const after = reserveBook();
      const w = await newTask();
      await fx.approve(w.proposalId);
      expect(await refusal(runTaskCard(dropsAfterCommit, w.proposalId, undefined, 'UTC', 'test', deps(after)))).toMatchObject({ status: 409 });
      expect(await db.proposal.findUniqueOrThrow({ where: { id: w.proposalId } })).toMatchObject({ status: 'executed' });
      expect(await fx.task(w.id)).toMatchObject({ status: 'queued' });
      expect(after.calls).toEqual([`take ${w.proposalId} 250000`]);
      expect([...after.held]).toEqual([[w.proposalId, 250_000]]);
      // And when it cannot be told whether the card ran (the card cannot be read either), nothing is given back:
      // the same card's next run takes nothing more, so there is still one reservation for one dispatch.
      const unreadable = through(db, (key) => (key === 'proposal' ? through(db.proposal, (k) => (k === 'findUnique' ? async () => { throw new Error('the connection is gone'); } : undefined)) : undefined));
      const untold = reserveBook();
      const x = await newTask();
      await fx.approve(x.proposalId);
      expect(await refusal(runTaskCard(unreadable, x.proposalId, undefined, 'UTC', 'test', deps(untold), fault))).toMatchObject({ status: 409 });
      expect(untold.calls).toEqual([`take ${x.proposalId} 250000`]);
      expect(await fx.task(x.id)).toMatchObject({ status: 'proposed' });
      expect(await runTaskCard(db, x.proposalId, undefined, 'UTC', 'test', deps(untold))).toMatchObject({ taskId: x.id });
      expect([...untold.held]).toEqual([[x.proposalId, 250_000]]);

      // A card refused before the money is asked for (its asset turned off) asks for none, and gives back
      // whatever it might hold: a refused card keeps nothing.
      const off = reserveBook();
      const v = await newTask();
      await fx.approve(v.proposalId);
      await turnOff(db, asset.id);
      expect(await refusal(runTaskCard(db, v.proposalId, undefined, 'UTC', 'test', deps(off)))).toMatchObject({ status: 409, message: TASK_SAYS.assetOff });
      expect(off.calls).toEqual([`release ${v.proposalId}`]);
      await again();

      // So a key kept because it could not be told is given back by the card's next run, when that run is refused
      // before it asks for anything.
      const kept = reserveBook();
      const y = await newTask();
      await fx.approve(y.proposalId);
      expect(await refusal(runTaskCard(unreadable, y.proposalId, undefined, 'UTC', 'test', deps(kept), fault))).toMatchObject({ status: 409 });
      expect([...kept.held]).toEqual([[y.proposalId, 250_000]]);
      await turnOff(db, asset.id);
      expect(await refusal(runTaskCard(db, y.proposalId, undefined, 'UTC', 'test', deps(kept)))).toMatchObject({ status: 409, message: TASK_SAYS.assetOff });
      expect(await db.proposal.findUniqueOrThrow({ where: { id: y.proposalId } })).toMatchObject({ status: 'failed', error: TASK_SAYS.assetOff });
      expect(kept.calls).toEqual([`take ${y.proposalId} 250000`, `release ${y.proposalId}`]);
      expect(kept.held.size).toBe(0);
      // Only a dispatch that spends holds anything: a card of another kind that is refused asks for no release.
      const none = reserveBook();
      await fx.watcherOn();
      const free = await fx.newTask(await fx.ciRun('wpf002/no-key'));
      await fx.approve(free.proposalId);
      await turnOff(db, CI_WATCHER.id);
      expect(await refusal(runTaskCard(db, free.proposalId, undefined, 'UTC', 'test', deps(none)))).toMatchObject({ status: 409, message: TASK_SAYS.assetOff });
      expect(none.calls).toEqual([]);
    } finally {
      errs.mockRestore();
      await again();
    }
  });

  it('a key whose card never runs again is given back when its task can no longer go out on it: the card lapsed, Will cancelled the task, or it went out on another card', async () => {
    const errs = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const fault = { afterWrites: async () => { throw new Error('a fault after the writes'); } };
      const deps = (book: ReturnType<typeof reserveBook>) => ({ assets: true, registry, bus, reserve: book.reserve });
      const unreadable = new Proxy(db, {
        get: (t, key) => {
          if (key === 'proposal') return new Proxy(t.proposal, { get: (pt, pk) => (pk === 'findUnique' ? async () => { throw new Error('the connection is gone'); } : Reflect.get(pt, pk)) });
          const v = Reflect.get(t, key) as unknown;
          return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
        },
      });
      /** A card whose run failed where it could not be told whether it ran: its key is kept. */
      const untold = async (pid: string, book: ReturnType<typeof reserveBook>) => {
        expect(await refusal(runTaskCard(unreadable, pid, undefined, 'UTC', 'test', deps(book), fault))).toMatchObject({ status: 409 });
        expect([...book.held.keys()]).toEqual([pid]);
      };
      /** The same dispatch card again, as the console files it, with a life of its own. */
      const spendCard = async (args: Record<string, unknown>, life: string): Promise<string> => {
        const pid = id('pr');
        await withClient(urls.app, (c) => c.query(
          `INSERT INTO "Proposal" (id, kind, origin, action, args, "argsDigest", "argsProvenance", tainted, sensitivity, consequential, "estCostUsd", "expiresAt")
           VALUES ($1, 'spend', 'console', $2, $3::jsonb, $4, '{}'::jsonb, false, $5, true, 0.25, now() + $6::interval)`,
          [pid, PAID_DISPATCH, JSON.stringify(args), digestOf(args), args.sensitivity, life],
        ));
        return pid;
      };
      const later = (ms: number) => new Date(Date.now() + ms);

      // The card lapses. Its task is still proposed, and no card of Will's is left that could send it out: the
      // tick withdraws the task, and gives back what its cards hold first.
      const lapses = reserveBook();
      const t = await newTask();
      const args = (await db.proposal.findUniqueOrThrow({ where: { id: t.proposalId } })).args as Record<string, unknown>;
      const brief = await spendCard(args, '2 seconds');
      await fx.approve(brief);
      await untold(brief, lapses);
      await rejectProposal(db, t.proposalId, { approvalId: await fx.sign(t.proposalId, 'reject') }, undefined, 'test');
      // While the card could still run, the tick leaves the task and the key alone.
      await taskTick({ db, bus, now: () => later(11 * 60_000), reserve: lapses.reserve });
      expect(await fx.task(t.id)).toMatchObject({ status: 'proposed' });
      expect([...lapses.held.keys()]).toEqual([brief]);
      await new Promise((r) => setTimeout(r, 2300));
      expect(await expireProposals(db)).toBeGreaterThanOrEqual(1);
      expect(await db.proposal.findUniqueOrThrow({ where: { id: brief } })).toMatchObject({ status: 'expired' });
      await taskTick({ db, bus, now: () => later(11 * 60_000), reserve: lapses.reserve });
      expect(await fx.task(t.id)).toMatchObject({ status: 'cancelled' });
      expect(lapses.held.size).toBe(0);
      expect(lapses.calls).toContain(`release ${brief}`);
      // A release that does not go through leaves the task for the next tick, so the key is tried again.
      const stuck = reserveBook({ releaseFails: true });
      const s2 = await newTask();
      await fx.approve(s2.proposalId);
      await untold(s2.proposalId, stuck);
      await db.$transaction(async (tx) => { await tx.proposal.update({ where: { id: s2.proposalId }, data: { status: 'failed', error: 'a test ends it' } }); });
      await taskTick({ db, bus, now: () => later(11 * 60_000), reserve: stuck.reserve });
      expect(await fx.task(s2.id)).toMatchObject({ status: 'proposed' });
      expect([...stuck.held.keys()]).toEqual([s2.proposalId]);
      const works = reserveBook();
      works.held.set(s2.proposalId, 250_000);
      await taskTick({ db, bus, now: () => later(11 * 60_000), reserve: works.reserve });
      expect(await fx.task(s2.id)).toMatchObject({ status: 'cancelled' });
      expect(works.held.size).toBe(0);

      // Will cancels the task before it went out: what its card holds is given back with it.
      const cancels = reserveBook();
      const u = await newTask();
      await fx.approve(u.proposalId);
      await untold(u.proposalId, cancels);
      expect(await cancelTask(db, u.id, new Date(), { reserve: cancels.reserve })).toEqual({ ok: true });
      expect(await fx.task(u.id)).toMatchObject({ status: 'cancelled' });
      expect(cancels.held.size).toBe(0);
      expect(cancels.calls).toEqual([`take ${u.proposalId} 250000`, `release ${u.proposalId}`]);

      // The task goes out on another card: that card keeps its reservation, and the first card's is given back.
      const two = reserveBook();
      const draftKey = draft();
      const form = { draftKey, template: 'draft_note' as const, params: { about: 'What to write' }, goalId: null, dueAt: null, ownCheck: null };
      const first = await createTask(db, form, { registry, adapters });
      await fx.approve(first.proposalId);
      await untold(first.proposalId, two);
      const second = await createTask(db, form, { registry, adapters });
      expect(second).toMatchObject({ id: first.id, deduped: false });
      expect(second.proposalId).not.toBe(first.proposalId);
      await fx.approve(second.proposalId);
      expect(await runTaskCard(db, second.proposalId, undefined, 'UTC', 'test', deps(two))).toMatchObject({ taskId: first.id });
      expect([...two.held]).toEqual([[second.proposalId, 250_000]]);
      expect(two.calls).toEqual([`take ${first.proposalId} 250000`, `take ${second.proposalId} 250000`, `release ${first.proposalId}`]);
    } finally {
      errs.mockRestore();
      await again();
    }
  });

  it('what a spending asset says a run cost is read strictly too: anything but a whole amount and a yes or no ends the task as unusable, at its estimate', async () => {
    const { reserve } = reserveBook();
    const meters: Array<[string, TaskAdapter['meter'], string]> = [
      ['a negative amount', async () => ({ micros: -1, estimate: false }), 'cost'],
      ['a fraction of a millionth', async () => ({ micros: 0.5, estimate: false }), 'cost'],
      ['an amount that is not a number', async () => ({ micros: `${CANARY}`, estimate: false }) as never, 'cost'],
      ['words', async () => `${CANARY} a lot` as never, 'cost'],
      ['nothing', async () => undefined as never, 'cost'],
      ['more beside it', async () => ({ micros: 100, estimate: true, note: `${CANARY}` }) as never, 'cost'],
      ['a throw', async () => { throw new TypeError(`${CANARY} secret words`); }, 'unreadable'],
      ['a throw under a name of its own', async () => { throw Object.assign(new Error('x'), { name: `${CANARY}Error` }); }, 'unreadable'],
    ];
    const logs: string[] = [];
    for (const [name, meter, says] of meters) {
      const t = await newTask();
      await fx.approve(t.proposalId);
      await runTaskCard(db, t.proposalId, undefined, 'UTC', 'test', { assets: true, registry, bus, reserve });
      const before = logs.length;
      await expect(runTaskJob({ db, bus, adapters: { nexus_participant: { ...paid, meter: meter! } }, log: (m) => logs.push(m) }, { taskId: t.id }), name).resolves.toBe('failed');
      const ended = await fx.task(t.id);
      expect(ended, name).toMatchObject({ status: 'failed', failure: 'invalid', outputRef: null, costIsEstimate: true });
      expect(Number(ended.costUsd), name).toBe(0.25);
      expect(await db.taskOutput.count({ where: { taskId: t.id } }), name).toBe(0);
      expect(logs.slice(before), name).toEqual([`task ${t.id}: result unusable (${says})`, `task ${t.id}: failed (invalid)`]);
    }
    expect(logs.join('\n')).not.toContain('CANARY');
  });

  it('cost after: a task that went out ends with what it cost, metered when the asset says so and its estimate otherwise', async () => {
    const { reserve } = reserveBook();
    const t = await newTask();
    await fx.approve(t.proposalId);
    expect(await runTaskCard(db, t.proposalId, undefined, 'UTC', 'test', { assets: true, registry, bus, reserve })).toMatchObject({ taskId: t.id });
    expect(await fx.task(t.id)).toMatchObject({ status: 'queued', costUsd: null, costIsEstimate: true });
    expect(await runTaskJob({ db, bus, adapters }, { taskId: t.id })).toBe('submitted');
    const submitted = await fx.task(t.id);
    expect(Number(submitted.costUsd)).toBe(0.2);
    expect(submitted.costIsEstimate).toBe(false);
    expect(await checkTaskJob({ db }, { taskId: t.id })).toBe('filed');
    await fx.signRun((await fx.cardFor('task.check_bar', t.id))!.id);
    const done = await fx.task(t.id);
    expect(done).toMatchObject({ status: 'accepted', costIsEstimate: false });
    expect(Number(done.costUsd)).toBe(0.2);
    // Cancelled after it went out, before the asset said anything: it ends with its estimate, marked as one.
    const u = await newTask();
    await fx.approve(u.proposalId);
    await runTaskCard(db, u.proposalId, undefined, 'UTC', 'test', { assets: true, registry, bus, reserve });
    await runTaskJob({ db, bus, adapters: { nexus_participant: { ...paid, run: async () => ({ wait: true }) } } }, { taskId: u.id });
    expect(await fx.task(u.id)).toMatchObject({ status: 'dispatched', costUsd: null });
    await fx.signRun((await fx.file('task.cancel', { taskId: u.id })).id);
    const cancelled = await fx.task(u.id);
    expect(cancelled).toMatchObject({ status: 'cancelled', costIsEstimate: true });
    expect(Number(cancelled.costUsd)).toBe(0.25);
    // One the asset failed: the same.
    const v = await newTask();
    await fx.approve(v.proposalId);
    await runTaskCard(db, v.proposalId, undefined, 'UTC', 'test', { assets: true, registry, bus, reserve });
    expect(await runTaskJob({ db, bus, adapters: { nexus_participant: { ...paid, run: async () => ({ failure: 'timeout' }) } } }, { taskId: v.id })).toBe('failed');
    const failed = await fx.task(v.id);
    expect(failed).toMatchObject({ status: 'failed', failure: 'timeout', costIsEstimate: true });
    expect(Number(failed.costUsd)).toBe(0.25);
  });
});
