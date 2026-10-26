import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // 排除的都是入口脚本（有顶层副作用，import 即执行），不是业务逻辑
      exclude: [
        'src/cli/**',
        'src/http/server.ts',
        'src/db/migrate.ts',
        'src/content/seed.ts',
        'src/content/lint.ts',
      ],
      thresholds: { lines: 80, functions: 80, branches: 75, statements: 80 },
    },
  },
})
