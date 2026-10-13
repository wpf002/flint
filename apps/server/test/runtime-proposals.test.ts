/**
 * Runtime mode (Machine plan P1 server change 1; exit criterion 11): with the
 * runtime down, chat keeps working and approval-tier calls queue in a local
 * spool ("pending, unsynced") instead of being denied; they reach the runtime
 * when it is back. Only a call Will approved runs, and only with its exact args.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Tool } from '@flint/core';
import { RuntimeProposals } from '../src/runtime-proposals';
import { ActionQueue, keyOf } from '../src/actions';
import { isSafeTool } from '../src/policy';
import { gateBuiltins } from '../src/tier-gate';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { approvalRoutes, cardCost, type ApprovalDeps } from '../src/approval-routes';
import { markTainted, withTurnTaint } from '../src/turn-taint';

function fakeRuntime() {
  const filed: Array<Record<string, unknown>> = [];
  let up = true;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    if (!up) throw new Error('ECONNREFUSED');
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    if (url.endsWith('/v1/proposals') && init.method === 'POST') {
      if (String(body.action).includes('execute_trade')) return new Response(JSON.stringify({ error: 'forbidden: NEVER_AUTO' }), { status: 409 });
      filed.push(body);
      return new Response(JSON.stringify({ id: `pr${filed.length}` }), { status: 201 });
    }
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  return { filed, fetchImpl, setUp: (v: boolean) => (up = v) };
}

describe('RuntimeProposals', () => {
  it('files a proposal, spools it when the runtime is down, and sends it when it is back', async () => {
    const rt = fakeRuntime();
    const dir = mkdtempSync(join(tmpdir(), 'flint-rp-'));
    const p = new RuntimeProposals({ runtime: () => ({ url: 'http://[::1]:8090', token: 't'.repeat(64) }), spoolDir: dir, fetchImpl: rt.fetchImpl });
    const base = { kind: 'tool_call' as const, origin: 'chat:abc', args: { a: 1 }, argsProvenance: { a: { source: 'model' as const, tainted: true } }, tainted: true };
    expect(await p.propose({ ...base, action: 'mcp:gcal.create_event' })).toEqual({ id: 'pr1' });
    rt.setUp(false);
    expect(await p.propose({ ...base, action: 'mcp:gcal.delete_event' })).toEqual({ spooled: true, spoolId: expect.stringMatching(/^[0-9a-f]{16}$/) });
    expect(p.unsynced()).toBe(1);
    expect(statSync(join(dir, 'proposals.jsonl')).mode & 0o777).toBe(0o600);
    expect(await p.replay()).toBe(0); // still down: kept
    expect(p.unsynced()).toBe(1);
    rt.setUp(true);
    expect(await p.replay()).toBe(1);
    expect(p.unsynced()).toBe(0);
    expect(rt.filed.map((f) => f.action)).toEqual(['mcp:gcal.create_event', 'mcp:gcal.delete_event']);
    expect(await p.propose({ ...base, action: 'mcp:broker.execute_trade' })).toEqual({ refused: 'forbidden: NEVER_AUTO' });
  });
});

describe('the gate in runtime mode', () => {
  const remember = (ran: unknown[]): Tool => ({
    definition: { name: 'remember', description: 'r', inputSchema: { type: 'object' } },
    handler: async (call) => (ran.push(call.args), 'ok'),
  });

  it('a tainted remember becomes a runtime proposal, not a run; chat goes on when the runtime is down', async () => {
    const rt = fakeRuntime();
    const ran: unknown[] = [];
    const queue = new ActionQueue(isSafeTool);
    const proposals = new RuntimeProposals({ runtime: () => ({ url: 'http://[::1]:8090', token: 't' }), spoolDir: mkdtempSync(join(tmpdir(), 'flint-rp-')), fetchImpl: rt.fetchImpl });
    const [r] = gateBuiltins([remember(ran)], { queue, proposals });
    const out = (await withTurnTaint(async () => {
      markTainted('mcp:web');
      return r!.handler({ id: '1', toolName: 'remember', args: { fact: 'x' } });
    })) as { approved: boolean; message: string };
    expect(out.message).toMatch(/proposal pr1/);
    expect(rt.filed[0]).toMatchObject({ action: 'remember', origin: expect.stringMatching(/^chat:[0-9a-f]{16}$/), tainted: true, args: { fact: 'x' } });
    rt.setUp(false);
    const down = (await withTurnTaint(async () => {
      markTainted('mcp:web');
      return r!.handler({ id: '2', toolName: 'remember', args: { fact: 'y' } });
    })) as { message: string };
    expect(down.message).toMatch(/pending, unsynced/);
    expect(ran).toEqual([]);
    expect(queue.list()).toEqual([]); // nothing in the RAM queue in runtime mode
  });

  it('an approved call runs once, with exactly the approved args', async () => {
    const rt = fakeRuntime();
    const ran: unknown[] = [];
    const queue = new ActionQueue(isSafeTool);
    const proposals = new RuntimeProposals({ runtime: () => ({ url: 'http://[::1]:8090', token: 't' }), spoolDir: mkdtempSync(join(tmpdir(), 'flint-rp-')), fetchImpl: rt.fetchImpl });
    const [r] = gateBuiltins([remember(ran)], { queue, proposals });
    // The allowance lives only in the scope that runs the approval.
    await withTurnTaint(
      async () => {
        await r!.handler({ id: '1', toolName: 'remember', args: { fact: 'other' } });
        await r!.handler({ id: '2', toolName: 'remember', args: { fact: 'approved' } });
        await r!.handler({ id: '3', toolName: 'remember', args: { fact: 'approved' } });
      },
      { sources: ['mcp:web'], allow: [keyOf('flint', 'remember', { fact: 'approved' })] },
    );
    // A concurrent turn cannot spend it.
    await withTurnTaint(async () => {
      markTainted('mcp:web');
      await r!.handler({ id: '4', toolName: 'remember', args: { fact: 'approved' } });
    });
    expect(ran).toEqual([{ fact: 'approved' }]);
  });
});

describe('the cards the console lists (P3)', () => {
  it('carry kind, templateId and consequential, so the console asks a fresh touch for every consequential card', async () => {
    const at = '2026-10-09T15:00:00.000Z';
    const card = (over: Record<string, unknown>) => ({
      id: 'pr1', origin: 'console', action: 'goal.activate', args: { goalId: 'gotest0001' }, argsDigest: 'd'.repeat(64), argsProvenance: {}, tainted: false, sensitivity: 'personal',
      destructive: false, status: 'pending', reason: 'Approving starts this goal.', createdAt: at, expiresAt: at, ...over,
    });
    const listed = [
      card({ kind: 'goal', consequential: true, templateId: null }),
      card({ id: 'pr2', origin: 'runtime:goals', action: 'plan.change', kind: 'plan', consequential: false, templateId: 'plan.diff.minor' }),
      card({ id: 'pr3', action: 'mcp:gcal.create_event', kind: 'tool_call', sensitivity: 'ops' }),
    ];
    const fetchImpl = (async (url: string) => Response.json({ proposals: new URL(url).searchParams.get('status') === 'pending' ? listed : [] })) as typeof fetch;
    const proposals = new RuntimeProposals({ runtime: () => ({ url: 'http://[::1]:8090', token: 't'.repeat(64) }), spoolDir: mkdtempSync(join(tmpdir(), 'flint-rp-')), fetchImpl });
    const deps = { actions: new ActionQueue(isSafeTool), tools: [], audit: { record: () => {} }, notes: { push: () => {} }, approvals: undefined, proposals, errorRef: () => 'ref' } as unknown as ApprovalDeps;
    const server = createServer((req, res) => void approvalRoutes(req, res, req.url ?? '/', deps));
    await new Promise<void>((r) => server.listen(0, '::1', r));
    try {
      const r = (await (await fetch(`http://[::1]:${(server.address() as AddressInfo).port}/proposals`)).json()) as { proposals: Array<Record<string, unknown>> };
      expect(r.proposals.map((p) => [p.id, p.kind, p.templateId ?? null, p.consequential])).toEqual([
        ['pr1', 'goal', null, true],
        ['pr2', 'plan', 'plan.diff.minor', false],
        ['pr3', 'tool_call', null, false],
      ]);
      expect(r.proposals[0]).toMatchObject({ fullName: 'goal.activate', reason: 'Approving starts this goal.', sensitivity: 'personal' });
    } finally {
      server.close();
    }
  });

  it('a task’s dispatch card carries its cost estimate, zero included, read from the args Will signs; no other card has one, and a number that is no estimate is not shown as one (P5)', async () => {
    const at = '2026-10-13T15:00:00.000Z';
    const card = (id: string, action: string, args: Record<string, unknown> | null, over: Record<string, unknown> = {}) => ({
      id, origin: 'console', action, args, argsDigest: 'd'.repeat(64), argsProvenance: {}, tainted: false, sensitivity: 'ops', destructive: false, kind: 'task', status: 'pending', reason: 'Approving runs this task.', createdAt: at, expiresAt: at, ...over,
    });
    const listed = [
      card('ci', 'task.dispatch.ci_runner', { taskId: 'tkabcdefgh12345678', estCostMicros: 0 }),
      card('paid', 'task.dispatch.nexus_participant', { taskId: 'tkabcdefgh12345679', estCostMicros: 250_000 }, { kind: 'spend', estCostUsd: '0.2500' }),
      card('most', 'task.dispatch.local_worker', { taskId: 'tkabcdefgh1234567a', estCostMicros: 1_000_000_000 }),
      // Not an estimate: negative, a fraction, text, past the card's own limit, missing, or args that were cleared.
      card('neg', 'task.dispatch.ci_runner', { estCostMicros: -100 }),
      card('part', 'task.dispatch.ci_runner', { estCostMicros: 0.5 }),
      card('text', 'task.dispatch.ci_runner', { estCostMicros: '0' }),
      card('over', 'task.dispatch.ci_runner', { estCostMicros: 1_000_000_100 }),
      card('none', 'task.dispatch.ci_runner', { taskId: 'tkabcdefgh1234567b' }),
      card('gone', 'task.dispatch.ci_runner', null),
      // Not a dispatch: whatever its args or its row say of money, it is given no Cost.
      card('accept', 'task.check_bar', { taskId: 'tkabcdefgh12345678', estCostMicros: 0 }),
      card('cancel', 'task.cancel', { taskId: 'tkabcdefgh12345678' }),
      card('asset', 'asset.enable', { assetId: 'as-ci-watcher-v1', spends: false, estCostMicros: 0 }, { kind: 'policy' }),
      card('tool', 'mcp:shop.buy', { estCostMicros: 0 }, { kind: 'tool_call', estCostUsd: '4.0000' }),
    ];
    expect(cardCost({ action: 'task.dispatch.ci_runner', args: { estCostMicros: 0 } })).toEqual({ micros: 0 });
    expect(cardCost({ action: 'task.dispatch', args: { estCostMicros: 0 } })).toBeUndefined();
    expect(cardCost({ action: 'mcp:task.dispatch.ci_runner', args: { estCostMicros: 0 } })).toBeUndefined();
    const fetchImpl = (async (url: string) => Response.json({ proposals: new URL(url).searchParams.get('status') === 'pending' ? listed : [] })) as typeof fetch;
    const proposals = new RuntimeProposals({ runtime: () => ({ url: 'http://[::1]:8090', token: 't'.repeat(64) }), spoolDir: mkdtempSync(join(tmpdir(), 'flint-rp-')), fetchImpl });
    const deps = { actions: new ActionQueue(isSafeTool), tools: [], audit: { record: () => {} }, notes: { push: () => {} }, approvals: undefined, proposals, errorRef: () => 'ref' } as unknown as ApprovalDeps;
    const server = createServer((req, res) => void approvalRoutes(req, res, req.url ?? '/', deps));
    await new Promise<void>((r) => server.listen(0, '::1', r));
    try {
      const r = (await (await fetch(`http://[::1]:${(server.address() as AddressInfo).port}/proposals`)).json()) as { proposals: Array<Record<string, unknown>> };
      expect(r.proposals.map((p) => [p.id, p.cost ?? null])).toEqual([
        ['ci', { micros: 0 }], ['paid', { micros: 250_000 }], ['most', { micros: 1_000_000_000 }],
        ['neg', null], ['part', null], ['text', null], ['over', null], ['none', null], ['gone', null],
        ['accept', null], ['cancel', null], ['asset', null], ['tool', null],
      ]);
      // The card is otherwise as it was: its args whole (what he signs is what the console shows), and nothing of the row's own estimate.
      expect(r.proposals[0]).toMatchObject({ fullName: 'task.dispatch.ci_runner', kind: 'task', args: { taskId: 'tkabcdefgh12345678', estCostMicros: 0 }, reason: 'Approving runs this task.' });
      expect(JSON.stringify(r.proposals)).not.toContain('estCostUsd');
    } finally {
      server.close();
    }
  });
});
