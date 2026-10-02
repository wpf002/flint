import { defineConfig } from 'tsup';

const common = {
  format: ['esm', 'cjs'] as const,
  dts: true,
  sourcemap: true,
  treeshake: true,
  target: 'es2022',
  outExtension({ format }: { format: string }) {
    return { js: format === 'cjs' ? '.cjs' : '.js' };
  },
};

// Two separate builds, so each entry is whole on its own: index.d.ts is the
// public surface (test/api-surface.test.ts reads it), and `@flint/core/ollama`
// carries the local provider without the rest of the package. The two run at
// once, so neither cleans: the build script empties dist first.
export default defineConfig([
  { ...common, entry: ['src/index.ts'], clean: false },
  { ...common, entry: ['src/ollama.ts'], clean: false },
]);
