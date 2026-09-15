import { describe, it, expect } from 'vitest';
import { parseMcpConfig } from '../src/mcp-config';

const config = (servers: unknown[]) => JSON.stringify({ servers });

describe('parseMcpConfig', () => {
  it('starts a local server from its command, as before', () => {
    const { specs, problems } = parseMcpConfig(
      config([{ name: 'web', command: '/usr/bin/node', args: ['web-server.mjs'], env: { A: 'b' } }]),
    );
    expect(problems).toEqual([]);
    expect(specs).toEqual([{ name: 'web', transport: 'stdio', command: '/usr/bin/node', args: ['web-server.mjs'], env: { A: 'b' } }]);
  });

  /* Nexus is remote; the old loader turned every entry into a command and could never reach it. */
  it('reaches a remote server at its URL with its headers', () => {
    const { specs } = parseMcpConfig(
      config([{ name: 'nexus', url: 'https://nexus-mcp.up.railway.app/mcp', headers: { Authorization: 'Bearer abc' } }]),
    );
    expect(specs).toEqual([
      { name: 'nexus', transport: 'http', url: 'https://nexus-mcp.up.railway.app/mcp', headers: { Authorization: 'Bearer abc' } },
    ]);
  });

  it('fills a header from the environment', () => {
    const { specs } = parseMcpConfig(
      config([{ name: 'nexus', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer ${NEXUS_TOKEN}' } }]),
      { NEXUS_TOKEN: 'from-env' },
    );
    expect(specs[0]).toMatchObject({ headers: { Authorization: 'Bearer from-env' } });
  });

  it('skips a remote server whose token is not set, naming the variable and never a value', () => {
    const { specs, problems } = parseMcpConfig(
      config([{ name: 'nexus', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer ${NEXUS_TOKEN}', 'X-Other': 'secret-literal' } }]),
      {},
    );
    expect(specs).toEqual([]);
    expect(problems).toEqual(['nexus: NEXUS_TOKEN not set in the environment, skipped']);
    expect(problems.join()).not.toContain('secret-literal');
  });

  it('skips entries it cannot use and keeps the rest', () => {
    const { specs, problems } = parseMcpConfig(
      config([
        { name: 'nothing' },
        { command: 'node' },
        { name: 'ftp', url: 'ftp://example.com' },
        { name: 'bad', url: 'not a url' },
        { name: 'ok', command: 'node' },
      ]),
    );
    expect(specs.map((s) => s.name)).toEqual(['ok']);
    expect(problems).toHaveLength(4);
  });

  it('reports a file that is not JSON instead of throwing', () => {
    expect(parseMcpConfig('{ nope').problems[0]).toMatch(/not valid JSON/);
  });
});
