/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: true,
    proxy: {
      '/socket.io': { target: 'http://localhost:3000', ws: true },
      '/api': 'http://localhost:3000',
    },
  },
  build: { outDir: 'dist', chunkSizeWarningLimit: 900, target: ['es2019', 'safari13', 'chrome80'] }, // старые телефоны капитанов
  test: { environment: 'node', include: ['tests/**/*.test.js'], testTimeout: 15000 },
});
