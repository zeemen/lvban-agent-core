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
      // TTS 同理：测试不该因为 .env 改了供应商就去打收费接口
      TTS_PROVIDER: 'mock',
      TTS_VOICE_PEER: '',
      TTS_VOICE_CHILD: '',
      TTS_VOICE_LIGHT: '',
      MODEL_ID_INTENT: '',
      MODEL_ID_QA: '',
      MODEL_ID_PLANNER: '',
      MODEL_ID_COPY: '',
      MODEL_ID_VISION: '',
      MODEL_BASE_URL: '',
      /*
       * K3 同理，而且是 2026-11-08 真摔过一次才补上的：这三个键原先没钉，
       * 于是集成用例会照着开发者 .env 里的地址真打一次 WeKnora。
       * 它们之所以一直是绿的，只是因为那个地址恰好是死的——连接立刻被拒，
       * retrievePassages 迅速降级成空集。把端口改对的那一刻，
       * 活着但慢的后端（约 2 秒才回一个 500）立刻让两条用例超时。
       * 绿得靠环境里的一个意外，和这次要修的那个故障是同一种病。
       */
      WEKNORA_BASE_URL: '',
      WEKNORA_API_KEY: '',
      WEKNORA_KB_IDS: '',
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
        'src/tts/presynth.ts',
      ],
      thresholds: { lines: 80, functions: 80, branches: 75, statements: 80 },
    },
  },
})
