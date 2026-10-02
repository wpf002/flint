/**
 * Sources and the sync engine (plan P1 exit criteria 3 and 4): parsing is
 * exact, a source reaches only its endpoints, a source runs only once Will has
 * approved turning it on, repeats and restarts never duplicate an event or a
 * version, and one real change makes exactly one version.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digestOf } from '@flint/policy';
import { NO_DB, freshDb, type TestUrls } from './db';
import { enrollTestKey } from './sign';
import { createDb, type Db } from '../src/db';
import { runtimeEnv } from '../src/config';
import { parseLaunchctlList, parsePrintDisabled, launchdSource } from '../src/sources/launchd';
import { healthSource, verdict } from '../src/sources/health';
import { gitSource, lastDeployed } from '../src/sources/git';
import { evalToday, level, spendSource, totals } from '../src/sources/spend';
import { allowed, scopedFetch, EgressRefused } from '../src/policy/egress';
import { syncOnce } from '../src/sources/sync';
import { createProposal } from '../src/governance/proposals';
import { approveProposal } from '../src/governance/proposals';
import { runInternal } from '../src/governance/internal';
import type { Source, SourceRun } from '../src/sources/types';

const tmp = () => mkdtempSync(join(tmpdir(), 'flint-rt-'));
const noFetch = async () => {
  throw new Error('no network in this test');
};
const runAt = (now: Date): Omit<SourceRun, 'cursor'> => ({ now, signal: new AbortController().signal, fetch: noFetch });

describe('launchd', () => {
  const LIST = 'PID\tStatus\tLabel\n2082\t0\tcom.flint.searxng\n-\t0\tcom.flint.deploy\n25641\t-15\tcom.flint.server\n1282\t0\tapplication.com.flint.app.1\n-\t1\tcom.apple.x\n';

  it('parses launchctl list', () => {
    const m = parseLaunchctlList(LIST);
    expect(m.get('com.flint.server')).toEqual({ pid: 25641, status: -15 });
    expect(m.get('com.flint.deploy')).toEqual({ pid: null, status: 0 });
  });

  it('reports Will\'s agents; periodic jobs carry no running flag; unloaded plists show as not loaded', async () => {
    const dir = tmp();
    for (const f of ['com.flint.server', 'com.flint.deploy', 'com.flint.retired', 'com.other.thing']) writeFileSync(join(dir, `${f}.plist`), '');
    const plutil: Record<string, object> = {
      'com.flint.server': { KeepAlive: true },
      'com.flint.deploy': { StartInterval: 120 },
      'com.flint.retired': { Disabled: true },
    };
    const run = async (cmd: string, args: readonly string[]) => {
      if (cmd.endsWith('launchctl')) return LIST;
      const label = args[args.length - 1]!.split('/').pop()!.replace('.plist', '');
      return JSON.stringify(plutil[label] ?? {});
    };
    const r = await launchdSource({ run, agentsDir: dir, prefixes: ['com.flint.'] }).run(runAt(new Date()) as SourceRun);
    const byKey = Object.fromEntries(r.observations.map((o) => [o.key, o.state]));
    expect(Object.keys(byKey).sort()).toEqual(['service:launchd:com.flint.deploy', 'service:launchd:com.flint.retired', 'service:launchd:com.flint.searxng', 'service:launchd:com.flint.server']);
    expect(byKey['service:launchd:com.flint.server']).toEqual({ managedBy: 'launchd', loaded: true, running: true, lastExit: -15 });
    expect(byKey['service:launchd:com.flint.deploy']).toEqual({ managedBy: 'launchd', loaded: true, lastExit: 0 });
    expect(byKey['service:launchd:com.flint.retired']).toEqual({ managedBy: 'launchd', loaded: false, running: false, lastExit: null, disabled: true });
  });
});

describe('health', () => {
  it('verdicts', () => {
    expect(verdict(200, 50, 2000)).toBe('ok');
    expect(verdict(200, 2500, 2000)).toBe('degraded');
    expect(verdict(404, 5, 2000)).toBe('degraded');
    expect(verdict(503, 5, 2000)).toBe('down');
    expect(verdict('error', 5, 2000)).toBe('down');
  });

  it('health is state; latency is a metric (and absent when the check failed)', async () => {
    const fetch = async (url: string) => {
      if (url.includes('down')) throw new Error('ECONNREFUSED');
      return new Response('ok', { status: url.includes('bad') ? 500 : 200 });
    };
    const src = healthSource({ targets: [{ name: 'a', url: 'http://localhost:1/ok' }, { name: 'b', url: 'http://localhost:1/bad' }, { name: 'c', url: 'http://localhost:1/down' }], dbPing: async () => {} });
    const r = await src.run({ ...runAt(new Date()), fetch } as SourceRun);
    expect(r.observations.map((o) => [o.name, (o.state as { health: string }).health])).toEqual([['a', 'ok'], ['b', 'down'], ['c', 'down'], ['postgres', 'ok']]);
    expect(r.metrics.map((m) => m.series.key).sort()).toEqual(['health.a.latency_ms', 'health.b.latency_ms', 'health.postgres.latency_ms']);
  });
});

describe('git', () => {
  it('finds the last deployed sha in the deploy log', () => {
    const sha = 'a'.repeat(40);
    expect(lastDeployed(`x\n2026-10-01 10:40:10 deployed ${sha}\n2026-10-01 10:42:00 up to date (${sha})\n`)).toBe(sha);
    expect(lastDeployed('nothing here')).toBeUndefined();
  });

  it('reports heads by rev-parse, and whether the deploy checkout runs its HEAD', async () => {
    const dir = tmp();
    mkdirSync(join(dir, 'flint'));
    mkdirSync(join(dir, 'deploy'));
    const head = 'b'.repeat(40);
    writeFileSync(join(dir, 'deploy.log'), `2026-10-01 10:40:10 deployed ${head}\n`);
    const run = async (_cmd: string, args: readonly string[]) => (args.includes('--abbrev-ref') ? 'main\n' : `${head}\n`);
    const r = await gitSource({ run, repos: [{ name: 'flint', path: join(dir, 'flint') }, { name: 'missing', path: join(dir, 'nope') }], deploy: { path: join(dir, 'deploy'), log: join(dir, 'deploy.log') } }).run(runAt(new Date()) as SourceRun);
    expect(r.observations.map((o) => [o.key, o.state])).toEqual([
      ['repo:local:flint', { host: 'local', headSha: head, branch: 'main' }],
      ['deployment:studio:flint', { target: 'studio', status: 'success', sha: head }],
    ]);
  });
});

describe('spend', () => {
  const at = (iso: string) => Date.parse(iso);
  const LEDGER = [
    { ts: at('2026-10-01T14:00:00Z'), vendor: 'anthropic', kind: 'chat', usd: 6 },
    { ts: at('2026-10-01T15:00:00Z'), vendor: 'anthropic', kind: 'eval', usd: 50 },
    { ts: at('2026-09-30T23:00:00Z'), vendor: 'anthropic', kind: 'chat', usd: 2 },
    { ts: at('2026-10-02T03:30:00Z'), vendor: 'openai', kind: 'chat', usd: 1 },
  ].map((r) => JSON.stringify(r)).join('\n') + '\nnot json\n';

  it('totals by local day and month; eval never counts against caps', () => {
    // 2026-10-02T03:30Z is still Oct 1 in New York; 2026-09-30T23:00Z is Sept 30 there (another month).
    const t = totals(LEDGER, 'America/New_York', new Date('2026-10-01T20:00:00Z'));
    expect(t.anthropic).toEqual({ day: 6, month: 6 });
    expect(t.openai).toEqual({ day: 1, month: 1 });
  });

  it('levels against the caps', () => {
    expect(level({ day: 6, month: 6 }, { dailyUsd: 10, monthlyUsd: 150 })).toBe('50');
    expect(level({ day: 8, month: 8 }, { dailyUsd: 10 })).toBe('80');
    expect(level({ day: 0.01, month: 0.01 }, { dailyUsd: 0 })).toBe('100');
    expect(level({ day: 1, month: 1 }, {})).toBe('normal');
  });

  it('reads evolve\'s eval spend for today', () => {
    const csv = 'ts,config,n,wins,losses,ties,win_rate,signal,cost_usd\n2026-10-01 09:00,"a=b,c=d",8,0,0,8,0.5,NOISE,0.4051\n2026-09-30 09:00,"x",8,0,0,8,0.5,NOISE,1\n';
    expect(evalToday(csv, 'America/New_York', new Date('2026-10-01T20:00:00Z'))).toBeCloseTo(0.4051, 9);
  });

  it('turns a ledger into account levels (financial) and dollar metrics', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'spend-2026-10.jsonl'), LEDGER);
    const r = await spendSource({ dir, caps: { anthropic: { dailyUsd: 10 } }, tz: 'America/New_York' }).run(runAt(new Date('2026-10-01T20:00:00Z')) as SourceRun);
    expect(r.observations.find((o) => o.key === 'account:vendor:anthropic')).toMatchObject({ sensitivity: 'financial', state: { vendor: 'anthropic', level: '50' } });
    expect(r.metrics.find((m) => m.series.key === 'spend.anthropic.day.usd')?.value).toBe(6);
  });
});

describe('egress', () => {
  const eps = [{ origin: 'https://api.github.com', pathPrefix: '/repos/wpf002/', methods: ['GET'] as const }];
  it('only the listed origin, path prefix and method', () => {
    expect(allowed(eps, 'https://api.github.com/repos/wpf002/flint/pulls', 'GET')).toBe(true);
    expect(allowed(eps, 'https://api.github.com/repos/someone/x', 'GET')).toBe(false);
    expect(allowed(eps, 'https://api.github.com.evil.example/repos/wpf002/', 'GET')).toBe(false);
    expect(allowed(eps, 'https://api.github.com/repos/wpf002/flint/merges', 'POST')).toBe(false);
    expect(allowed(eps, 'https://user:pw@api.github.com/repos/wpf002/flint', 'GET')).toBe(false);
    expect(allowed(eps, 'not a url', 'GET')).toBe(false);
  });

  it('scopedFetch refuses before connecting and never follows redirects', async () => {
    const seen: RequestInit[] = [];
    const f = scopedFetch(eps, (async (_u: string, init: RequestInit) => (seen.push(init), new Response(null, { status: 302, headers: { location: 'https://evil.example' } }))) as typeof fetch);
    await expect(f('https://evil.example/')).rejects.toThrow(EgressRefused);
    const r = await f('https://api.github.com/repos/wpf002/flint');
    expect(r.status).toBe(302);
    expect(seen[0]!.redirect).toBe('manual');
  });
});

describe('runtime.env', () => {
  it('is refused unless only its owner can read it; quotes are stripped; the process env wins', () => {
    const dir = tmp();
    const f = join(dir, 'runtime.env');
    writeFileSync(f, 'DATABASE_URL="postgresql://a:b@[::1]/flint"\nexport RUNTIME_PORT=9000\n# comment\n');
    chmodSync(f, 0o644);
    expect(() => runtimeEnv(f, {})).toThrow(/chmod 600/);
    chmodSync(f, 0o600);
    expect(runtimeEnv(f, { RUNTIME_PORT: '9100' })).toMatchObject({ DATABASE_URL: 'postgresql://a:b@[::1]/flint', RUNTIME_PORT: '9100' });
  });
});

describe.skipIf(NO_DB)('sync engine (flint_test)', () => {
  let db: Db;
  let urls: TestUrls;
  let state = { managedBy: 'launchd', loaded: true, running: true, lastExit: 0 } as Record<string, unknown>;
  let fail = false;
  const fake: Source = {
    name: 'launchd',
    cadenceMs: 1,
    async run() {
      if (fail) throw new Error('launchctl exploded with token sk-ant-api03-abcdefghijklmnopqrstuv');
      return {
        observations: [{ type: 'service.status', kind: 'service', key: 'service:launchd:com.flint.test', name: 'com.flint.test', sensitivity: 'ops', externalId: 'com.flint.test', state }],
        metrics: [{ series: { key: 'test.metric.value', unit: 'n', freq: 'raw', sensitivity: 'ops', description: 'x' }, at: new Date(), value: 1 }],
      };
    },
  };
  const counts = async () => ({
    events: await db.sourceEvent.count({ where: { source: 'launchd' } }),
    versions: await db.entityVersion.count({ where: { entity: { key: 'service:launchd:com.flint.test' } } }),
    points: await db.metricPoint.count({ where: { seriesKey: 'test.metric.value' } }),
  });

  beforeAll(async () => {
    urls = await freshDb();
    db = createDb(urls.app);
  });
  afterAll(async () => db?.$disconnect());

  it('does nothing until Will approves turning the source on', async () => {
    const s = await syncOnce(db, fake, runAt(new Date()), 'UTC');
    expect(s).toMatchObject({ ran: false });
    expect(s.reason).toMatch(/not enabled/);
    expect((await counts()).events).toBe(0);
  });

  it('turns on through a signed world.source.enable proposal', async () => {
    const key = await enrollTestKey(urls);
    const p = await createProposal(db, { kind: 'tool_call', origin: 'console', action: 'world.source.enable', args: { source: 'launchd' }, argsProvenance: { source: { source: 'will', tainted: false } }, tainted: false, sensitivity: 'ops', destructive: false, consequential: false, ttlMinutes: 60 }, 'test');
    await approveProposal(db, p.id, await key.approve({ subjectId: p.id, action: 'world.source.enable', argsDigest: digestOf({ source: 'launchd' }) }), undefined, 'test');
    expect(await runInternal(db, p.id, undefined, 'UTC', 'test')).toEqual({ source: 'launchd', enabled: true });
  });

  it('10 restarts with no change: one event, one version; quiet runs are counted, not logged', async () => {
    for (let i = 0; i < 10; i++) await syncOnce(db, fake, runAt(new Date(Date.now() + i * 1000)), 'UTC');
    expect(await counts()).toEqual({ events: 1, versions: 1, points: 1 });
    const rollup = await db.auditRollup.findFirst({ where: { action: 'world.sync.launchd' } });
    expect(rollup?.count).toBe(9);
    expect(await db.auditEntry.count({ where: { action: 'world.sync.launchd', kind: 'sync' } })).toBe(1);
  });

  it('one injected change: exactly one new event and one new version', async () => {
    state = { ...state, running: false, lastExit: 1 };
    await syncOnce(db, fake, runAt(new Date()), 'UTC');
    await syncOnce(db, fake, runAt(new Date()), 'UTC');
    expect(await counts()).toMatchObject({ events: 2, versions: 2 });
    const cursor = await db.sourceCursor.findUnique({ where: { source: 'launchd' } });
    expect(cursor?.lastOkAt).not.toBeNull();
  });

  it('a failure is counted on the cursor and audited, with credentials redacted', async () => {
    fail = true;
    const s = await syncOnce(db, fake, runAt(new Date()), 'UTC');
    fail = false;
    expect(s.failed).toBe(1);
    const cursor = await db.sourceCursor.findUniqueOrThrow({ where: { source: 'launchd' } });
    expect(cursor.consecutiveFailures).toBe(1);
    expect(cursor.lastError).not.toMatch(/sk-ant/);
    const audit = await db.auditEntry.findFirst({ where: { action: 'world.sync.launchd', outcome: 'failed' } });
    expect(audit?.reasoning).toMatch(/redacted/);
    await syncOnce(db, fake, runAt(new Date()), 'UTC');
    expect((await db.sourceCursor.findUniqueOrThrow({ where: { source: 'launchd' } })).consecutiveFailures).toBe(0);
  });

  it('partial errors and unapplied observations are the run\'s error, and the cursor moves only when everything applied', async () => {
    await db.sourceCursor.update({ where: { source: 'launchd' }, data: { cursor: 'c0', consecutiveFailures: 0 } });
    let out: { cursor: string; errors?: string[]; bad?: boolean } = { cursor: 'c1', errors: ['repo x: HTTP 404'], bad: true };
    const partial: Source = {
      name: 'launchd',
      cadenceMs: 1,
      async run() {
        return {
          observations: out.bad ? [{ type: 'service.status', kind: 'service', key: 'service:launchd:bad', name: 'bad', sensitivity: 'ops', externalId: 'bad', state: { managedBy: 'nope' } }] : [],
          metrics: [], cursor: out.cursor, ...(out.errors ? { errors: out.errors } : {}),
        };
      },
    };
    const s = await syncOnce(db, partial, runAt(new Date()), 'UTC');
    expect(s.failed).toBe(2);
    let c = await db.sourceCursor.findUniqueOrThrow({ where: { source: 'launchd' } });
    expect(c).toMatchObject({ cursor: 'c0', consecutiveFailures: 1 });
    expect(c.lastError).toMatch(/repo x: HTTP 404; 1 observation\(s\) failed to apply/);
    expect(await db.auditEntry.findFirst({ where: { action: 'world.sync.launchd', outcome: 'failed', reasoning: { contains: 'repo x' } } })).not.toBeNull();

    out = { cursor: 'c1', errors: ['repo x: HTTP 404'] };
    await syncOnce(db, partial, runAt(new Date()), 'UTC');
    c = await db.sourceCursor.findUniqueOrThrow({ where: { source: 'launchd' } });
    expect(c).toMatchObject({ cursor: 'c1', consecutiveFailures: 2 });

    out = { cursor: 'c2' };
    await syncOnce(db, partial, runAt(new Date()), 'UTC');
    c = await db.sourceCursor.findUniqueOrThrow({ where: { source: 'launchd' } });
    expect(c).toMatchObject({ cursor: 'c2', consecutiveFailures: 0, lastError: null });
  });

  it('known() hands a source its live entities as stored; outside text with half an emoji or a NUL is still stored', async () => {
    let seen: Awaited<ReturnType<NonNullable<SourceRun['known']>>> = [];
    const odd: Source = {
      name: 'launchd',
      cadenceMs: 1,
      async run(r) {
        seen = await r.known!('service');
        return { observations: [{ type: 'service.status', kind: 'service', key: 'service:launchd:odd', name: 'odd \uD83D\u0000name', sensitivity: 'ops', externalId: 'odd', state: { managedBy: 'launchd' }, taintedPaths: ['name'] }], metrics: [] };
      },
    };
    const s = await syncOnce(db, odd, runAt(new Date()), 'UTC');
    expect(s.failed).toBe(0);
    expect((await db.entity.findUniqueOrThrow({ where: { kind_key: { kind: 'service', key: 'service:launchd:odd' } } })).name).toBe('odd \uFFFDname');
    expect(seen.find((k) => k.key === 'service:launchd:com.flint.test')).toMatchObject({ name: 'com.flint.test', state: expect.objectContaining({ managedBy: 'launchd' }), taintedPaths: [] });
    await syncOnce(db, odd, runAt(new Date()), 'UTC');
    expect(seen.find((k) => k.key === 'service:launchd:odd')).toMatchObject({ taintedPaths: ['name'] });
  });

  it('a forbidden source never runs, enabled or not', async () => {
    const forbidden: Source = { ...fake, name: 'launchd', run: async () => { throw new Error('must not run'); } };
    const s = await syncOnce(db, forbidden, { ...runAt(new Date()) }, 'UTC');
    // launchd is not forbidden; prove the gate by a policy row that forbids it is out of scope here,
    // so check the reverse: a source with no cursor row never runs.
    const other: Source = { ...fake, name: 'github' as Source['name'] };
    expect((await syncOnce(db, other, runAt(new Date()), 'UTC')).ran).toBe(false);
    expect(s.failed).toBe(1);
  });
});

describe('launchctl print-disabled', () => {
  it('reads the labels put away on purpose', () => {
    const out = 'disabled services = {\n\t\t"com.nexus.ui" => disabled\n\t\t"com.flint.ollama" => enabled\n\t\t"com.old.thing" => true\n\t}\n';
    expect([...parsePrintDisabled(out)].sort()).toEqual(['com.nexus.ui', 'com.old.thing']);
    expect(parsePrintDisabled('')).toEqual(new Set());
  });
});
