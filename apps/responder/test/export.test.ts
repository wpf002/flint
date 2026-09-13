import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportThread } from '../src/export.js';
import type { Participant } from '../src/participant.js';

/*
 * Export reads from Nexus, not from a workspace on disk. The workspace only exists on
 * whichever machine runs the responder, and that stopped being the laptop.
 */

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'export-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function thread(artifacts: Record<string, string>): Participant {
  return {
    call: async (_tool: string, args: Record<string, unknown>) =>
      args.name
        ? { name: args.name, content: artifacts[args.name as string], version: 1, lastBy: 'gpt-api' }
        : { artifacts: Object.keys(artifacts).map((name) => ({ name })) },
  } as unknown as Participant;
}

describe('exportThread', () => {
  it('writes every artifact, nested paths included', async () => {
    const dest = join(dir, 'app');
    const result = await exportThread(
      thread({ 'package.json': '{"name":"app"}', 'src/index.ts': 'export {};', 'pnpm-lock.yaml': 'lockfileVersion: 9' }),
      't1',
      dest,
    );

    expect(result.files).toBe(3);
    expect(readFileSync(join(dest, 'src', 'index.ts'), 'utf8')).toBe('export {};');
    expect(readFileSync(join(dest, 'pnpm-lock.yaml'), 'utf8')).toBe('lockfileVersion: 9');
  });

  /* Nexus refuses these names at write time. Export doesn't trust that it always did. */
  it('refuses a name that would land outside the destination', async () => {
    const dest = join(dir, 'app');
    const result = await exportThread(thread({ 'ok.md': 'fine', '../escaped.md': 'no' }), 't1', dest);

    expect(result.refused).toEqual(['../escaped.md']);
    expect(existsSync(join(dir, 'escaped.md'))).toBe(false);
  });

  it('will not write into a directory that already has files', async () => {
    writeFileSync(join(dir, 'mine.txt'), 'keep me');
    await expect(exportThread(thread({ 'mine.txt': 'overwritten' }), 't1', dir)).rejects.toThrow(/not empty/);
    expect(readFileSync(join(dir, 'mine.txt'), 'utf8')).toBe('keep me');
  });

  it('says so when the thread built nothing', async () => {
    await expect(exportThread(thread({}), 't1', join(dir, 'app'))).rejects.toThrow(/built nothing/);
  });
});
