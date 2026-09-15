import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  server: { port: 5173 },
  build: { outDir: 'dist', sourcemap: false, rollupOptions: { output: { manualChunks: { msal: ['@azure/msal-browser', '@azure/msal-react'], react: ['react', 'react-dom', 'react-router-dom', '@tanstack/react-query'] } } } },
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
});
