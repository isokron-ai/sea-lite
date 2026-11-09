import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts', cli: 'src/bin.ts' },
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  dts: { entry: { index: 'src/index.ts' } },
  sourcemap: true,
  clean: true,
  // Chunks: the CLI loads the MCP SDK, HTTP and doctor code only for serve / doctor / add-token.
  splitting: true,
  banner: ({ format }) => (format === 'esm' ? { js: '' } : {}),
});
