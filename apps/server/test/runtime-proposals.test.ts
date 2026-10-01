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
    expect(await p.propose({ ...base, action: 'mcp:gcal.delete_event' })).toEqual({ spooled: true });
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
