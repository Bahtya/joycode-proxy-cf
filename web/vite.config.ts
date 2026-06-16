import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

// Single source of truth for the displayed version is the root package.json
// "version" field; inject it at build time so the SPA can show it without a
// runtime fetch (package.json isn't bundled into the Pages Functions).
const pkgVersion = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf-8'),
).version as string;

function manualChunksPlugin(): Plugin {
  return {
    name: 'manual-chunks',
    config() {
      return {
        build: {
          rollupOptions: {
            output: {
              manualChunks(id) {
                if (id.includes('node_modules/recharts')) return 'recharts';
                if (
                  id.includes('node_modules/react') ||
                  id.includes('node_modules/react-dom') ||
                  id.includes('node_modules/react-router')
                )
                  return 'vendor';
              },
            },
          },
        },
      };
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), manualChunksPlugin()],
  define: {
    __APP_VERSION__: JSON.stringify(pkgVersion),
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 34892,
    proxy: {
      '/api': {
        target: 'http://localhost:8788',
        changeOrigin: true,
      },
      '/v1': {
        target: 'http://localhost:8788',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: '../web-build',
    emptyOutDir: true,
  },
});
