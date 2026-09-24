import { describe, it, expect } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { safeHandler } from '../src/safe-handler';

async function serve(handler: Parameters<typeof safeHandler>[0]): Promise<{ url: string; server: Server; logged: string[] }> {
  const logged: string[] = [];
  const server = createServer(safeHandler(handler, (m) => logged.push(m)));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server, logged };
}

describe('safeHandler', () => {
  it('turns a thrown handler into a 500 and keeps serving', async () => {
    let calls = 0;
    const { url, server, logged } = await serve(async (_req, res) => {
      calls++;
      if (calls === 1) throw new Error('Tool loop exceeded 6 iterations without completing.');
      res.end('ok');
    });
    const r1 = await fetch(`${url}/generate`, { method: 'POST' });
    expect(r1.status).toBe(500);
    expect(((await r1.json()) as { error: string }).error).toMatch(/Tool loop exceeded/);
    const r2 = await fetch(`${url}/health`);
    expect(await r2.text()).toBe('ok');
    expect(logged[0]).toMatch(/POST \/generate failed/);
    server.close();
  });

  it('closes a stream that already started with an in-band error event', async () => {
    const { url, server } = await serve(async (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"type":"text","delta":"hi"}\n\n');
      throw new Error('boom');
    });
    const body = await (await fetch(`${url}/chat`)).text();
    expect(body).toContain('"delta":"hi"');
    expect(body).toContain('"type":"error"');
    expect(body).toContain('boom');
    server.close();
  });
});
