import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * Public API surface snapshot (spec §9). The published surface is the entire
 * contract apps depend on; an ACCIDENTAL change to it must fail CI. This reads
 * the built `dist/index.d.ts` and snapshots the exact set of exported names
 * (value vs. type distinguished). Intentional changes update the snapshot in
 * the same PR — and, under 0.x, get a note in the release notes.
 *
 * (A heavier alternative is @microsoft/api-extractor; this lightweight guard
 * covers the same intent without the extra toolchain.)
 */

const here = dirname(fileURLToPath(import.meta.url));
const dts = resolve(here, '../dist/index.d.ts');

describe('public API surface', () => {
  it('matches the committed snapshot', () => {
    if (!existsSync(dts)) {
      throw new Error(
        `dist/index.d.ts not found — run \`pnpm build\` before the surface test.`,
      );
    }
    const source = readFileSync(dts, 'utf8');

    // The barrel emits a single terminal `export { ... };` block. Parse it.
    const match = source.match(/export\s*\{([\s\S]*?)\};?\s*$/m);
    expect(match, 'expected a terminal export block in index.d.ts').toBeTruthy();

    const names = match![1]!
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      // Normalize `X as Y` to the EXPORTED name (Y); keep the `type ` marker.
      .map((entry) => {
        const isType = entry.startsWith('type ');
        const body = isType ? entry.slice('type '.length) : entry;
        const exported = body.includes(' as ') ? body.split(' as ')[1]!.trim() : body.trim();
        return `${isType ? 'type ' : ''}${exported}`;
      })
      .sort();

    expect(names).toMatchSnapshot();
  });
});
