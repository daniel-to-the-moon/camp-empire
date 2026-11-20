import { defineConfig } from 'vitest/config';

/** 不引入 @types/node：只读一个环境变量 */
const env = (globalThis as unknown as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};

export default defineConfig({
  base: './',
  // T1 匿名统计里带的版本号：CI 构建取提交号前 12 位，本地为 local
  define: { __APP_VERSION__: JSON.stringify((env.GITHUB_SHA ?? 'local').slice(0, 12)) },
  // css.include：tests/devgate.test.ts 以 ?raw 读 style.css，vitest 默认把 CSS 处理成空串
  test: { environment: 'node', include: ['tests/**/*.test.ts'], css: { include: [/style\.css/] } },
});
