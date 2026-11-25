import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig, loadEnv} from 'vite';

export default defineConfig(({mode}) => {
  const env = loadEnv(mode, process.cwd(), '');
  const brandedPublicKey = process.env.VITE_USDA_BRANDED_SIGNING_PUBLIC_KEY ?? env.VITE_USDA_BRANDED_SIGNING_PUBLIC_KEY ?? '';
  const brandedKeyId = process.env.VITE_USDA_BRANDED_SIGNING_KEY_ID ?? env.VITE_USDA_BRANDED_SIGNING_KEY_ID ?? '';
  return {
    define: {
      __TKC_BRANDED_SIGNING_PUBLIC_KEY__: JSON.stringify(brandedPublicKey),
      __TKC_BRANDED_SIGNING_KEY_ID__: JSON.stringify(brandedKeyId),
    },
    plugins: [react(), tailwindcss()],
    // `.gz` files are recognized by Vite and imported with `?url&no-inline`, so
    // the locked USDA shards are emitted as separate fixed static assets and
    // fetched only after explicit user action.
    assetsInclude: ['**/*.gz'],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
