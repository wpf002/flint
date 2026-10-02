import { describe, it, expect } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { MAX_RESULT_CHARS, buildServer, text } from '../../connectors/runtime-server.js';

describe('runtime connector', () => {
  it('serves the five tools; world reads are read-only, recording a prediction is not', async () => {
    const calls: Array<{ path: string; body?: unknown }> = [];
    const server = buildServer(async (path, init = {}) => {
      calls.push({ path, ...(init.body !== undefined ? { body: init.body } : {}) });
      if (path.startsWith('/v1/world/entities/')) return { entity: { id: 'enmuq2v0lqfymz24ehza', kind: 'issue', name: 'issue#1', sources: ['x'] }, tainted: true };
      if (path === '/v1/world/now') return { services: [{ id: 'enmuq2v0lqfymz24ehza', name: 'api', health: 'ok' }], counts: [] };
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
    // Each entity comes with the ref a template names it by (and no raw sources list).
    const entBody = JSON.parse((ent.content as Array<{ text: string }>)[0]!.text) as { entity: Record<string, unknown> };
    expect(entBody.entity).toMatchObject({ ref: 'issue#24ehza' });
    expect(entBody.entity.sources).toBeUndefined();
    const now = await client.callTool({ name: 'world_now', arguments: {} });
    expect(JSON.parse((now.content as Array<{ text: string }>)[0]!.text).services[0]).toMatchObject({ ref: 'service#24ehza' });
    await client.callTool({ name: 'ledger_record_prediction', arguments: { claim: 'c', probability: 0.7, domain: 'services', type: 'event_occurs', resolutionCriteria: 'r', resolveBy: '2026-10-08T00:00:00Z' } });
    expect(calls.at(-1)).toMatchObject({ path: '/v1/ledger/predictions', body: { method: 'model_reasoning', resolver: 'will', evidence: [] } });
    const bad = await client.callTool({ name: 'world_entity', arguments: { id: '../../admin' } });
    expect(bad.isError).toBe(true);
    // Taint comes from the server's _meta, never from the model; without it, tainted.
    const args = { claim: 'c', probability: 0.7, domain: 'services', type: 'event_occurs', resolutionCriteria: 'r', resolveBy: '2026-10-08T00:00:00Z' };
    await client.callTool({ name: 'ledger_record_prediction', arguments: { ...args, tainted: false } });
    expect(calls.at(-1)).toMatchObject({ body: { tainted: true } });
    await client.callTool({ name: 'ledger_record_prediction', arguments: args, _meta: { 'flint/tainted': false } });
    expect(calls.at(-1)).toMatchObject({ body: { tainted: false } });
    await client.callTool({ name: 'ledger_record_prediction', arguments: { ...args, claim: undefined, template: { id: 'service_healthy', params: { entity: 'service#abc123' } } }, _meta: { 'flint/tainted': true } });
    expect(calls.at(-1)).toMatchObject({ body: { tainted: true, template: { id: 'service_healthy' } } });
    // The model sees the real templates in the tool's schema and description.
    const pred = tools.find((t) => t.name === 'ledger_record_prediction')!;
    expect(JSON.stringify(pred.inputSchema)).toContain('deploy_succeeds');
    expect(pred.description).toContain('closed_by');
    // A guessed template is refused by the connector before any call.
    const n = calls.length;
    const guessed = await client.callTool({ name: 'ledger_record_prediction', arguments: { ...args, template: { id: 'deploy_success', params: { service: 'api' } } } });
    expect(guessed.isError).toBe(true);
    expect(calls).toHaveLength(n);
    await client.close();
  });

  it('open predictions: as many rows as fit, each keeping its own taint mark, and how many more', async () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({ id: `p${i}`, claim: 'c'.repeat(300), probability: 0.6, domain: 'services', type: 'event_occurs', resolveBy: '2026-11-01', status: 'open', tainted: i % 2 === 0, evidence: [{}, {}] }));
    const server = buildServer(async () => ({ predictions: rows }));
    const [c, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: 't', version: '1' });
    await client.connect(c);
    const r = await client.callTool({ name: 'ledger_open', arguments: { limit: 20 } });
    const body = JSON.parse((r.content as Array<{ text: string }>)[0]!.text) as { predictions: Array<{ tainted: boolean }>; more?: number; truncated?: boolean };
    expect(body.truncated).toBeUndefined();
    expect(body.predictions.length).toBeGreaterThan(0);
    expect(body.predictions.length + (body.more ?? 0)).toBe(20);
    expect(body.predictions[0]!.tainted).toBe(true);
    await client.close();
  });

  it('a result too large for chat becomes a marker, and the marker says tainted (what was cut is unknown)', () => {
    expect(MAX_RESULT_CHARS).toBeLessThanOrEqual(8000);
    const big = text({ rows: 'x'.repeat(MAX_RESULT_CHARS) });
    const parsed = JSON.parse(big.content[0]!.text) as Record<string, unknown>;
    expect(parsed).toMatchObject({ truncated: true, tainted: true });
    expect(JSON.parse(text({ a: 1 }).content[0]!.text)).toEqual({ a: 1 });
  });
});
