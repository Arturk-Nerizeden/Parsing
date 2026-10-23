import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
export default defineConfig({
  base: './',
  build: {
    target: 'chrome120',
    rollupOptions: {
      input: { dashboard: resolve('dashboard.html'), background: resolve('src/background.ts') },
      output: { entryFileNames: '[name].js', chunkFileNames: 'assets/[name]-[hash].js', assetFileNames: 'assets/[name]-[hash][extname]' }
    }
  },
  test: { environment: 'node', include: ['tests/**/*.test.ts'] }
});
