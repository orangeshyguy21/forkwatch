import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Forkwars frontend. Built bundle is served by the Rust backend at the same origin.
// In dev, proxy the API + WebSocket to the local backend on :8080.
export default defineConfig({
  base: '/',
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:8080',
        ws: true,
      },
    },
  },
});
