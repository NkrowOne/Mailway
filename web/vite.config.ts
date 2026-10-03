import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    // Con barra final (como expresión regular): «/api» a secas también
    // capturaría la vista «/api-envio» del panel y la mandaría al servidor.
    proxy: {
      '^/api/': 'http://localhost:4100',
      '^/v1/': 'http://localhost:4100',
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
