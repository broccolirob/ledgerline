import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Workspace packages export raw TS (`exports: './src/index.ts'`) and are symlinked into node_modules,
// which Vite would otherwise treat as external (un-transformed). Alias them to their source so vitest
// transforms them. (vite-tsconfig-paths is unnecessary — there are no tsconfig `paths`.)
const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@ledgerline/recognition': resolve(root, 'packages/recognition/src/index.ts'),
      '@ledgerline/seller-client': resolve(root, 'packages/seller-client/src/index.ts'),
      '@ledgerline/canonical': resolve(root, 'packages/canonical/src/index.ts'),
      '@ledgerline/anchor': resolve(root, 'packages/anchor/src/index.ts'),
      '@ledgerline/x402-receipts': resolve(root, 'packages/x402-receipts/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['packages/**/test/**/*.test.ts'],
  },
});
