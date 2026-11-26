import { defineConfig } from 'vitest/config';

/** 不引入 @types/node：只读一个环境变量 */
const env = (globalThis as unknown as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};

export default defineConfig({
  base: './',
  build: {
    rollupOptions: {
      input: {
        main: new URL('index.html', import.meta.url).pathname,
        perf: new URL('perf.html', import.meta.url).pathname,
      },
    },
  },
  // css.include：tests/devgate.test.ts 以 ?raw 读 style.css，vitest 默认把 CSS 处理成空串
  test: { environment: 'node', include: ['tests/**/*.test.ts'], css: { include: [/style\.css/] } },
});
