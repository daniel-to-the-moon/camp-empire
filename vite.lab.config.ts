import { defineConfig } from 'vite';

/**
 * 泼溅共存点验的独立入口。不挂进 vite.config.ts，因此 `npm run build` 的游戏产物不含本页。
 * 开发：`npm run lab` → http://localhost:5174/lab/splat.html
 */
export default defineConfig({
  base: './',
  build: {
    outDir: 'dist-lab',
    emptyOutDir: true,
    rollupOptions: { input: 'lab/splat.html' },
  },
  server: { port: 5174, strictPort: true },
});
