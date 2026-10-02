/**
 * The runtime connector's front door (Machine plan P2) as the server's gate
 * reads it: the result a tool call hands back (through @flint/mcp, exactly as
 * the gate's onResult sees it) taints the turn when a row says tainted, when
 * the runtime's answer broke the wire contract, or when it was too large to
 * show; a runtime error (a 404 from an older runtime) does not.
 */
import { describe, it, expect } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpRegistry } from '@flint/mcp';
import { runtimeResultTainted } from '../src/tier-gate';
import { RuntimeHttpError, buildServer } from '../../../packages/mcp/connectors/runtime-server';

const AT = '2026-10-02T12:00:00.000Z';
const row = (tainted: boolean) => ({
  id: 'd1', at: AT, lane: 'quiet', action: 'log', reasonCode: 'routine', source: 'github', eventType: 'pr.opened', entity: 'repo#24ehza', escalationId: null, tainted,
});
const explained = (tainted: boolean, fields: Record<string, string> = { repo: 'repo#24ehza' }) => ({
  id: 'd1', at: AT, decidedBy: 'model:ollama', ruleName: null, critical: false, action: 'escalate', lane: 'relevant', relevance: 0.8, reasonCode: 'needs_will',
  source: 'github', eventType: 'pr.opened', entity: 'repo#24ehza', escalation: { id: 'e1', templateId: 'pr_waiting', fields, predictionId: null }, tainted,
});

/** What runtime.<tool> hands back to the loop (and to the gate's onResult) when the runtime answers `answer`. */
async function result(tool: string, args: Record<string, unknown>, answer: () => unknown) {
  const server = buildServer(async () => answer());
  const [c, s] = InMemoryTransport.createLinkedPair();
  await server.connect(s);
  const registry = await McpRegistry.connect([{ name: 'runtime', transport: c }], {});
  try {
    const t = registry.tools().find((x) => x.definition.name === `runtime.${tool}`)!;
    return await t.handler({ id: tool, toolName: `runtime.${tool}`, args });
  } finally {
    await registry.close();
  }
}

describe('front door results, as the gate reads them', () => {
  it('clean rows leave the turn clean; one tainted row taints it', async () => {
    expect(runtimeResultTainted(await result('inbox_recent', {}, () => ({ decisions: [row(false), row(false)] })))).toBe(false);
    expect(runtimeResultTainted(await result('inbox_recent', {}, () => ({ decisions: [row(false), row(true)] })))).toBe(true);
    expect(runtimeResultTainted(await result('inbox_recent', {}, () => ({ decisions: [] })))).toBe(false);
    expect(runtimeResultTainted(await result('explain_decision', { id: 'd1' }, () => explained(false)))).toBe(false);
    expect(runtimeResultTainted(await result('explain_decision', { id: 'd1' }, () => explained(true)))).toBe(true);
  });

  it('an answer outside the wire contract taints (fail closed); so does one too large to show', async () => {
    const invalid = await result('escalations_open', {}, () => ({ escalations: [{ id: 'e1', title: 'no mark, no status' }] }));
    expect(invalid).toMatchObject({ isError: true });
    expect(runtimeResultTainted(invalid)).toBe(true);
    const big = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`f${i}`, 'x'.repeat(120)]));
    expect(runtimeResultTainted(await result('explain_decision', { id: 'd1' }, () => explained(false, big)))).toBe(true);
  });

  it('a runtime error is the connector\'s own words: it does not taint the turn', async () => {
    for (const status of [404, 403, 500]) {
      const r = await result('inbox_recent', {}, () => {
        throw new RuntimeHttpError(status, 'Route GET:/v1/triage/recent not found');
      });
      expect(r).toMatchObject({ isError: true });
      expect(runtimeResultTainted(r)).toBe(false);
    }
  });
});
