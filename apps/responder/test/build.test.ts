import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/*
 * What a build leaves behind.
 *
 * The output of a command used to live in a map inside this process: invisible in the
 * console, lost on restart, and unreachable by a second runner. The same was true of any
 * file the build produced — a lockfile or a generated client existed only on whichever
 * machine happened to run it. Both now go into the thread, so what these cover is that
 * they actually arrive there rather than merely being collected.
 */

const remote = vi.hoisted(() => ({
  buildRemotely: vi.fn(async () => ({
    results: [{ command: 'npm install', ok: true, code: 0, output: 'added 1 package' }],
    files: {
      'package-lock.json': '{"lockfileVersion":3}',
      'dist/app.js': 'compiled',
      'src/index.ts': 'export const a = 1;',
    },
  })),
}));

vi.mock('../src/remote-sandbox.js', () => remote);

import type { Limits } from '../src/loop.js';

const { tick, keepsAsArtifact } = await import('../src/loop.js');

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nexus-build-'));
  remote.buildRemotely.mockClear();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function limitsFor(over: Record<string, unknown> = {}) {
  return {
    maxTurnsPerTick: 5,
    maxTurnsPerThread: 20,
    runBudget: Number.POSITIVE_INFINITY,
    turnTimeoutMs: 90_000,
    canRun: true,
    workspaceRoot: root,
    sandbox: { url: 'http://sandbox.invalid', token: 't' },
    ...over,
  } as unknown as Limits;
}

function builder(reply: unknown) {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const participant = {
    slug: 'gpt',
    cfg: { slug: 'gpt', model: 'm', role: 'building', maxOutputTokens: 500 },
    failing: false,
    reportFailing: async () => {},
    reportRecovered: async () => {},
    recheck: async () => {},
    provider: {
      name: 'fake',
      generate: async () => ({
        message: { id: 'x', role: 'assistant', content: JSON.stringify(reply), timestamp: 0 },
        usage: { input: 10, output: 5 },
        reason: 'complete',
      }),
    },
    call: async (tool: string, args: Record<string, unknown> = {}) => {
      calls.push({ tool, args });
      if (tool === 'thread_list') return { threads: [{ threadId: 't0', goal: 'build it', turns: 1, yourTurn: true }] };
      if (tool === 'thread_read') {
        return {
          threadId: 't0',
          goal: 'build it',
          status: 'OPEN',
          yourTurnIf: 'gpt',
          turnCount: 1,
          participants: [{ slug: 'gpt', label: 'gpt', good_at: 'building' }],
          turns: [],
        };
      }
      if (tool === 'thread_append') return { seq: 2, next: null };
      if (tool === 'check_inbox') return { handoffs: [] };
      if (tool === 'artifact_read') return args.name ? { name: args.name, content: 'x', version: 1 } : { artifacts: [] };
      if (tool === 'artifact_write') return { name: args.name, version: 1 };
      return {};
    },
  } as never;
  return { participant, calls };
}

const silent = (): void => {};

const REPLY = {
  content: 'Set the project up.',
  summary: 'set it up',
  artifact: { name: 'package.json', content: '{"name":"app"}' },
  run: [['npm', 'install']],
};

describe('a turn that ran something', () => {
  it('records what it ran on the turn itself', async () => {
    const f = builder(REPLY);
    await tick([f.participant], limitsFor(), silent);

    const append = f.calls.find((c) => c.tool === 'thread_append');
    expect(append?.args.runs).toEqual([
      { command: 'npm install', ok: true, output: 'added 1 package' },
    ]);
  });

  // The whole reason for the reorder: the command has to run before the turn is written,
  // or its output belongs to a turn nobody has taken yet.
  it('runs before it appends, not after', async () => {
    const f = builder(REPLY);
    await tick([f.participant], limitsFor(), silent);

    const appendAt = f.calls.findIndex((c) => c.tool === 'thread_append');
    expect(remote.buildRemotely).toHaveBeenCalledTimes(1);
    expect(appendAt).toBeGreaterThan(-1);
    // artifact_write happens before the append too: the document is the point, the turn
    // is the commentary on it.
    expect(f.calls.findIndex((c) => c.tool === 'artifact_write')).toBeLessThan(appendAt);
  });

  it('keeps source the build produced, and not compiled output', async () => {
    const f = builder(REPLY);
    await tick([f.participant], limitsFor(), silent);

    const written = f.calls.filter((c) => c.tool === 'artifact_write').map((c) => c.args.name);
    expect(written).toContain('package-lock.json');
    expect(written).toContain('src/index.ts');
    expect(written).not.toContain('dist/app.js');
  });

  it('does not rewrite an artifact the turn already wrote', async () => {
    remote.buildRemotely.mockResolvedValueOnce({
      results: [],
      files: { 'package.json': '{"name":"app"}' },
    } as never);
    const f = builder(REPLY);
    await tick([f.participant], limitsFor(), silent);

    const written = f.calls.filter((c) => c.tool === 'artifact_write' && c.args.name === 'package.json');
    expect(written).toHaveLength(1);
  });

  // Refused whole rather than truncated, if this is wrong: an oversized field costs the
  // turn its entire record. The tail is kept because a failure says why at the end.
  it('trims a build log too long for a turn to carry, keeping the end', async () => {
    remote.buildRemotely.mockResolvedValueOnce({
      results: [{ command: 'npm test', ok: false, code: 1, output: `${'x'.repeat(9_000)}the real error` }],
      files: {},
    } as never);
    const f = builder(REPLY);
    await tick([f.participant], limitsFor(), silent);

    const runs = f.calls.find((c) => c.tool === 'thread_append')?.args.runs as Array<{ output: string }>;
    expect(runs[0]!.output.length).toBeLessThanOrEqual(2_000);
    expect(runs[0]!.output).toContain('trimmed');
    expect(runs[0]!.output.endsWith('the real error')).toBe(true);
  });
});

describe('keepsAsArtifact', () => {
  it.each([
    ['src/index.ts', true],
    ['package-lock.json', true],
    ['README.md', true],
    ['dist/app.js', false],
    ['.next/server/page.js', false],
    ['coverage/lcov.info', false],
    ['app.js.map', false],
    ['tsconfig.tsbuildinfo', false],
  ])('%s → %s', (name, kept) => {
    expect(keepsAsArtifact(name)).toBe(kept);
  });
});

/*
 * The sandbox sits between the model call and the append, so anything that throws here
 * throws away a reply that has already been generated and billed — and because the turn
 * never lands, the floor stays put and the identical turn is paid for again next round.
 */
describe('when the build sandbox is unreachable', () => {
  it('still records the turn', async () => {
    remote.buildRemotely.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
    const f = builder(REPLY);

    await tick([f.participant], limitsFor(), silent);

    expect(f.calls.some((c) => c.tool === 'thread_append')).toBe(true);
  });

  it('tells the thread the commands did not run', async () => {
    remote.buildRemotely.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
    const f = builder(REPLY);

    await tick([f.participant], limitsFor(), silent);

    const runs = f.calls.find((c) => c.tool === 'thread_append')?.args.runs as Array<{
      command: string;
      ok: boolean;
      output: string;
    }>;
    expect(runs).toHaveLength(1);
    expect(runs[0]!.ok).toBe(false);
    expect(runs[0]!.output).toContain('could not be reached');
  });

  it('counts the turn, so what it cost is not lost', async () => {
    remote.buildRemotely.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
    const f = builder(REPLY);

    const result = await tick([f.participant], limitsFor(), silent);

    expect(result.turnsTaken).toBe(1);
    expect(result.tokensOut).toBe(5);
  });

  /* A response missing the fields the caller reads must not throw either. */
  it('survives a reply that is not the shape it claims', async () => {
    remote.buildRemotely.mockResolvedValueOnce({} as never);
    const f = builder(REPLY);

    const result = await tick([f.participant], limitsFor(), silent);

    expect(result.turnsTaken).toBe(1);
  });
});

/* A product is nested, and Nexus now accepts nested names. */
describe('nested build output', () => {
  it('keeps a file in a folder', async () => {
    remote.buildRemotely.mockResolvedValueOnce({
      results: [],
      files: { 'src/index.ts': 'export const a = 1;' },
    } as never);
    const f = builder(REPLY);

    await tick([f.participant], limitsFor(), silent);

    const written = f.calls.filter((c) => c.tool === 'artifact_write').map((c) => c.args.name);
    expect(written).toContain('src/index.ts');
  });
});
