/**
 * A connected server can call its tools anything, and one may carry the name
 * of an action of Flint's own: a server called `backup` with a tool called
 * `local` is `backup.local`, the nightly backup's action.
 *
 * When Will approves one of Flint's own cards, that tool is never run in its
 * place: the card is not looked up among the wired tools, so the runtime is
 * never asked to hand it over, and the tool never sees its args. The card runs
 * as it always did: by the runtime (a goal, a task), or by its own nightly
 * job. The tool itself keeps working as what it is: its own card, filed as
 * `mcp:backup.local`, is claimed and run as a tool call. And at startup the
 * log names such a server, by the server's name only.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Tool } from '@flint/core';
import { AUTONOMOUS_ACTIONS, CODE_TABLE } from '@flint/policy';
import { ActionQueue } from '../src/actions';
import { executeApproved, nightlyRun, type ApprovalDeps } from '../src/approval-routes';
import { ownNameNotes, serversNamedLikeOwnActions } from '../src/own-names';
import { RuntimeProposals } from '../src/runtime-proposals';

const ROOT = mkdtempSync(join(tmpdir(), 'flint-own-names-'));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
const tmp = () => mkdtempSync(join(ROOT, 'd-'));
const RT = { url: 'http://[::1]:8090', token: 'a'.repeat(64) };
const CANARY = 'CANARY-card-args';

type Card = { id: string; origin: string; action: string; args: Record<string, unknown>; tainted: boolean; status: string; kind: string };
const card = (action: string, over: Partial<Card> = {}): Card => ({ id: 'pr1', origin: 'console', action, args: { day: '2026-10-13', note: CANARY }, tainted: false, status: 'approved', kind: 'tool_call', ...over });

/**
 * A stand-in runtime. `hands`: it would hand ANY approved card to a caller that asks to claim it (as a runtime from
 * before this change did for a nightly job's card), so a test that passes shows the server never asked. `runs`:
 * what its own /run answers for the card (a result), or that the runtime does not carry it out (a 409).
 */
function runtime(c: Card, how: { runs?: unknown } = {}) {
  const calls: string[] = [];
  const fetchImpl = (async (u: string, init: RequestInit = {}) => {
    const path = new URL(u).pathname;
    calls.push(`${init.method ?? 'GET'} ${path.replace(`/v1/proposals/${c.id}`, '')  || '/'}`);
    if (path.endsWith('/claim')) return Response.json({ id: c.id, action: c.action, args: c.args, argsDigest: 'd'.repeat(64) });
    if (path.endsWith('/complete')) return Response.json({ ok: true });
    if (path.endsWith('/run')) return how.runs !== undefined ? Response.json(how.runs) : Response.json({ error: `${c.action} is not carried out by the runtime` }, { status: 409 });
    if (path === `/v1/proposals/${c.id}`) return Response.json({ proposal: c });
    return Response.json({ error: 'not found' }, { status: 404 });
  }) as typeof fetch;
  return { calls, proposals: new RuntimeProposals({ runtime: () => RT, spoolDir: tmp(), fetchImpl }) };
}

/** A wired tool that records every call it gets. */
function wired(name: string) {
  const got: unknown[] = [];
  const tool: Tool = { definition: { name, description: name, inputSchema: { type: 'object' } }, handler: async (call) => (got.push(call.args), 'the connected server ran its tool') };
  return { tool, got };
}

const deps = (over: Partial<ApprovalDeps>): ApprovalDeps => ({
  actions: new ActionQueue(() => false), tools: [], audit: { record: () => ({}) } as unknown as ApprovalDeps['audit'],
  notes: { push: () => undefined } as unknown as ApprovalDeps['notes'], approvals: undefined, proposals: undefined, errorRef: () => 'ref', ...over,
});

/** Approve-and-run one card with a tool of the given name wired: what the tool got, what the runtime was asked, and how it ended. */
async function approved(c: Card, toolName: string, how: { runs?: unknown } = {}) {
  const rt = runtime(c, how);
  const w = wired(toolName);
  const out = await executeApproved(deps({ proposals: rt.proposals, tools: [w.tool] }), c.id);
  return { out, calls: rt.calls, got: w.got };
}

describe('an approved card of Flint’s own, with a connected tool of the same name wired', () => {
  /** Each nightly job's action, and the job that files its card. */
  const NIGHTLY: Array<[string, string]> = [
    ['backup.local', 'runtime:backup'], ['backup.offsite', 'runtime:offsite'], ['restore.drill', 'runtime:drill'], ['maintenance.retention', 'runtime:retention'],
    ['backup.prune', 'runtime:prune'], ['backup.nexus', 'runtime:nexus-backup'], ['backup.nexus.offsite', 'runtime:nexus-offsite'], ['restore.drill.nexus', 'runtime:nexus-drill'],
  ];

  it('a nightly job’s card is never handed to the tool: nothing is claimed, the tool is not called, and the card waits for its own job', async () => {
    for (const [action, origin] of NIGHTLY) {
      const { out, calls, got } = await approved(card(action, { origin }), action);
      // The server asked the runtime to run it, as it does for any card that is not a tool's; it never asked to claim it.
      expect(calls, action).toEqual(['GET /', 'POST /run']);
      expect(got, action).toEqual([]);
      // It stays approved, and says when its job runs (the sentence it had with no such tool connected).
      expect(out, action).toEqual({ id: 'pr1', fullName: action, status: 'approved', note: nightlyRun(origin) ?? 'Approved. Its nightly job runs it.' });
      expect(JSON.stringify(out), action).not.toContain(CANARY);
    }
    expect(nightlyRun('runtime:backup')).toBe('Approved. It runs tonight at 2:15 AM.');
  });

  it('a card the runtime carries out runs there as it always did: a goal, a task’s result, a rule, a source', async () => {
    for (const [action, kind, result] of [
      ['goal.activate', 'goal', { goalId: 'go1' }], ['task.check_bar', 'task', { taskId: 'tk1', status: 'accepted' }], ['policy.change', 'policy', { rows: 1 }], ['world.source.enable', 'tool_call', { source: 'github' }],
    ] as const) {
      const { out, calls, got } = await approved(card(action, { kind }), action, { runs: result });
      expect(calls, action).toEqual(['GET /', 'POST /run']);
      expect(got, action).toEqual([]);
      expect(out, action).toEqual({ id: 'pr1', fullName: action, status: 'done', result });
    }
  });

  it('no action of Flint’s own resolves to a tool, whichever one a connected server names its tool after', async () => {
    const own = Object.keys(CODE_TABLE).filter((name) => name.includes('.'));
    // Every action a job of Flint's runs on its own is one of them, and so is every one a card can carry.
    expect(own.length).toBeGreaterThan(70);
    for (const a of AUTONOMOUS_ACTIONS) expect(own, a).toContain(a);
    for (const action of own) {
      const { calls, got } = await approved(card(action), action);
      expect(got, action).toEqual([]);
      expect(calls, action).not.toContain('POST /claim');
      expect(calls, action).not.toContain('POST /complete');
    }
    // Nor does any other dotted name with no `mcp:` in front: it is no tool's card, whatever is wired.
    for (const action of ['gcal.create_event', 'backup.local.extra', 'runtime.world_now', 'Backup.Local', '.local', 'backup.']) {
      const { calls, got } = await approved(card(action), action);
      expect(got, action).toEqual([]);
      expect(calls, action).toEqual(['GET /', 'POST /run']);
    }
  });
});

describe('the tool itself still works, as a tool', () => {
  it('its own card, filed as mcp:backup.local, is claimed and run as a tool call when Will approves it', async () => {
    for (const [action, toolName] of [['mcp:backup.local', 'backup.local'], ['mcp:restore.drill', 'restore.drill'], ['mcp:maintenance.retention', 'maintenance.retention'], ['mcp:goal.activate', 'goal.activate'], ['mcp:task.check_bar', 'task.check_bar']] as const) {
      const c = card(action, { origin: 'chat:t', args: { path: '/tmp/x' } });
      const { out, calls, got } = await approved(c, toolName);
      expect(calls, action).toEqual(['GET /', 'POST /claim', 'POST /complete']);
      expect(got, action).toEqual([{ path: '/tmp/x' }]);
      expect(out, action).toMatchObject({ id: 'pr1', fullName: toolName, status: 'done', result: 'the connected server ran its tool' });
    }
  });

  it('a built-in tool’s card, under its bare name, runs through its wired tool as before', async () => {
    for (const name of ['remember', 'deep_research', 'ledger_record_prediction']) {
      const { out, calls, got } = await approved(card(name, { origin: 'chat:t', args: { q: 1 } }), name);
      expect(calls, name).toEqual(['GET /', 'POST /claim', 'POST /complete']);
      expect(got, name).toEqual([{ q: 1 }]);
      expect(out, name).toMatchObject({ status: 'done' });
    }
  });

  it('a tool’s card whose tool is not connected right now stays approved, to run later', async () => {
    const rt = runtime(card('mcp:backup.local', { origin: 'chat:t' }));
    const out = await executeApproved(deps({ proposals: rt.proposals, tools: [] }), 'pr1');
    expect(rt.calls).toEqual(['GET /', 'POST /run']);
    expect(out).toEqual({ id: 'pr1', fullName: 'backup.local', status: 'approved', note: 'Approved. Its tool isn’t connected, so run it later in Approvals.' });
  });
});

describe('what the log is told at startup', () => {
  it('a connected server with a tool named like one of Flint’s own actions is named once, by the server’s name only', () => {
    const names = ['backup.local', 'backup.prune', 'gmail.send_message', 'restore.drill', 'goal.activate', 'task.check_bar', 'notes.search'];
    expect(serversNamedLikeOwnActions(names)).toEqual(['backup', 'restore', 'goal', 'task']);
    const lines = ownNameNotes(names);
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe('the connected server "backup" names a tool like one of Flint\'s own actions. It runs only as that server\'s tool, never in the action\'s place.');
    // The tool's own name is not written, only its server's.
    for (const line of lines) expect(line).not.toMatch(/local|prune|drill|activate|check_bar/);
  });

  it('an honestly named connector is not mentioned, nor is a built-in, nor a server whose name is no plain name', () => {
    expect(ownNameNotes(['gmail.send_message', 'github.create_issue', 'backup.everything', 'backups.local', 'runtime.world_now'])).toEqual([]);
    // Flint's built-in tools have bare names, which are in the table too: they are not a connected server's.
    expect(ownNameNotes(['remember', 'deep_research', 'world_now'])).toEqual([]);
    expect(ownNameNotes([])).toEqual([]);
    // A name every object has is no action; and a server name that is not a plain one is never put in a log line.
    expect(ownNameNotes(['constructor.name', 'toString.call', '__proto__.x'])).toEqual([]);
    expect(serversNamedLikeOwnActions(['.local', 'backup.local\n[mcp] forged line'])).toEqual([]);
  });

  it('the server says it once its tools are listed', () => {
    const index = readFileSync(join(__dirname, '..', 'src', 'index.ts'), 'utf8');
    expect(index).toContain("for (const line of ownNameNotes(wiredMcp.map((t) => t.definition.name))) console.error(`[mcp] ${line}`);");
    expect(index.match(/ownNameNotes\(/g)).toHaveLength(1);
  });
});
