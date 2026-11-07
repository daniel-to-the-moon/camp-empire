import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: './',
  // css.include：tests/devgate.test.ts 以 ?raw 读 style.css，vitest 默认把 CSS 处理成空串
  test: { environment: 'node', include: ['tests/**/*.test.ts'], css: { include: [/style\.css/] } },
});
