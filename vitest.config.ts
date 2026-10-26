import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    /*
     * 测试必须离线且确定：不能因为开发者在 .env 里切了供应商就行为不同，
     * 更不能在跑单测时真去打收费接口。
     * 唯一的例外是契约测试里显式用 PROBE_PROVIDER 开启的那一组。
     */
    env: {
      // 只钉住「用哪家、用哪个模型」。Key 不清空 ——
      // PROBE_PROVIDER 那组契约测试要靠真实 Key 才跑得起来；
      // 需要验证「缺 Key」行为的用例自己用 vi.stubEnv 显式清。
      MODEL_PROVIDER: 'mock',
      MODEL_PROVIDER_VISION: '',
      MODEL_ID_INTENT: '',
      MODEL_ID_QA: '',
      MODEL_ID_PLANNER: '',
      MODEL_ID_COPY: '',
      MODEL_ID_VISION: '',
      MODEL_BASE_URL: '',
    },
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
        'src/models/probe.ts',
      ],
      thresholds: { lines: 80, functions: 80, branches: 75, statements: 80 },
    },
  },
})
