import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'chrome120',
    rollupOptions: {
      input: { dashboard: resolve(process.cwd(), 'dashboard.html'), background: resolve(process.cwd(), 'src/background.ts') },
      output: { entryFileNames: '[name].js', chunkFileNames: 'assets/[name]-[hash].js', assetFileNames: 'assets/[name]-[hash][extname]' }
    }
  },
  test: { environment: 'node', include: ['tests/**/*.test.ts'] }
});
