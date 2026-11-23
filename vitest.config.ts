import { defineConfig } from 'vitest/config';
import path from 'path';
import brandedTestKey from './tests/fixtures/brandedTestKey.json' with { type: 'json' };

export default defineConfig({
  define: {
    __TKC_BRANDED_SIGNING_PUBLIC_KEY__: JSON.stringify(brandedTestKey.public_key),
    __TKC_BRANDED_SIGNING_KEY_ID__: JSON.stringify(brandedTestKey.key_id),
  },
  assetsInclude: ['**/*.gz'],
  test: {
    globals: true,
    environment: 'node',
    env: {
      USDA_BRANDED_SIGNING_PRIVATE_KEY: brandedTestKey.private_key_pkcs8_base64,
    },
    setupFiles: [
      './tests/brandedTrustTestSetup.ts',
      './tests/rateLimitIsolation.ts',
      './tests/localStorageJsdomRepair.ts',
    ],
    include: ['tests/**/*.{test,spec}.ts?(x)', 'src/**/*.{test,spec}.ts?(x)'],
    exclude: ['node_modules', 'dist', '.git'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
});
