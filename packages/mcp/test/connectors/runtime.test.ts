import { describe, it, expect } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { buildServer } from '../../connectors/runtime-server.js';

describe('runtime connector', () => {
  it('serves the five tools; world reads are read-only, recording a prediction is not', async () => {
    const calls: Array<{ path: string; body?: unknown }> = [];
    const server = buildServer(async (path, init = {}) => {
      calls.push({ path, ...(init.body !== undefined ? { body: init.body } : {}) });
      if (path.startsWith('/v1/world/entities/')) return { entity: { id: 'e1', name: 'issue#1' }, tainted: true };
      return { ok: true };
    });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await server.connect(s);
    const client = new Client({ name: 't', version: '1' });
    await client.connect(c);
    const tools = (await client.listTools()).tools;
    expect(tools.map((t) => t.name).sort()).toEqual(['ledger_calibration', 'ledger_open', 'ledger_record_prediction', 'world_entity', 'world_now']);
    expect(tools.find((t) => t.name === 'world_now')?.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === 'ledger_record_prediction')?.annotations?.readOnlyHint).toBeUndefined();
    const ent = await client.callTool({ name: 'world_entity', arguments: { id: 'e1' } });
    expect(JSON.stringify(ent)).toContain('\\"tainted\\": true');
    await client.callTool({ name: 'ledger_record_prediction', arguments: { claim: 'c', probability: 0.7, domain: 'services', type: 'event_occurs', resolutionCriteria: 'r', resolveBy: '2026-10-08T00:00:00Z' } });
    expect(calls.at(-1)).toMatchObject({ path: '/v1/ledger/predictions', body: { method: 'model_reasoning', resolver: 'will', evidence: [] } });
    const bad = await client.callTool({ name: 'world_entity', arguments: { id: '../../admin' } });
    expect(bad.isError).toBe(true);
    await client.close();
  });
});
