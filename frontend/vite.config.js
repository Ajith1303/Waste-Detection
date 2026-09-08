import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev server proxies /api -> Express backend so the browser app is same-origin.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:5000', changeOrigin: true },
    },
  },
  build: { outDir: 'dist' },
});