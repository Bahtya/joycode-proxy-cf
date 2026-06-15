import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';

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
