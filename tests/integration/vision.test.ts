import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { redis } from '../../src/db/redis.js'
import { registerAdapter, visionAvailability } from '../../src/models/router.js'
import type { ModelAdapter } from '../../src/models/types.js'
import {
  decideVisionAnchor, recordVisionOutcome, visionHitRate,
} from '../../src/vision/anchor.js'
import { teardown } from '../helpers/db.js'

/**
 * 视觉锚点与命中率熔断 —— 规格 02 §4。
 * 企划书硬要求：命中率低于八成就把「拍一下」改成「问一句」为主。
 * 这里验证它是运行时开关，而不是一次性的开发期决策。
 */

afterAll(teardown)

const CANDIDATES = [
  { exhibitId: 'njm_cuojinyin_hu', name: '错金银重络铜壶' },
  { exhibitId: 'njm_zhulin_qixian', name: '竹林七贤与荣启期砖画' },
]

/** 覆盖同名的 mock 适配器，用来控制置信度 */
const withConfidence = (confidence: number): void => {
  const adapter: ModelAdapter = {
    name: 'mock',
    async complete() {
      return {
        text: '', provider: 'mock', task: 'qa' as const, latencyMs: 1,
        tokensIn: 0, tokensOut: 0, reasoningTokens: 0, costCny: 0, cached: false,
      }
    },
    async recognize(request) {
      const first = request.candidates[0]
      return {
        candidates: first === undefined
          ? []
          : [{ exhibitId: first.exhibitId, name: first.name, confidence }],
        provider: 'mock', latencyMs: 1, costCny: 0,
      }
    },
  }
  registerAdapter(adapter)
}

beforeEach(async () => {
  await redis.del('vision:outcomes')
})

describe('三档决策 —— 规格 02 §4.1', () => {
  test('置信度 ≥ 0.75 直接采纳，但仍提供纠正入口', async () => {
    withConfidence(0.9)

    const result = await decideVisionAnchor({ imageKey: 'k1', candidates: CANDIDATES })

    expect(result.decision).toBe('auto_accept')
    expect(result.correctionToken).toBe('k1')
  })

  test('置信度在 0.45–0.75 之间时让用户点选', async () => {
    withConfidence(0.6)

    const result = await decideVisionAnchor({ imageKey: 'k2', candidates: CANDIDATES })

    expect(result.decision).toBe('ask_user_pick')
  })

  test('置信度低于 0.45 降级为「问一句」', async () => {
    withConfidence(0.2)

    const result = await decideVisionAnchor({ imageKey: 'k3', candidates: CANDIDATES })

    expect(result.decision).toBe('fallback_ask')
  })

  test('候选集为空时直接降级，不做开放域识别', async () => {
    withConfidence(0.9)

    const result = await decideVisionAnchor({ imageKey: 'k4', candidates: [] })

    expect(result.decision).toBe('fallback_ask')
    expect(result.candidates).toEqual([])
  })
})

describe('命中率熔断 —— 规格 02 §4.3', () => {
  test('无样本时不报命中率，也不熔断', async () => {
    const report = await visionHitRate()

    expect(report.samples).toBe(0)
    expect(report.hitRate).toBeNull()
    expect(report.fallbackActive).toBe(false)
  })

  test('命中率按「1 − 用户纠正率」计算，不看模型自评分', async () => {
    // 10 次识别中 3 次被用户纠正
    for (let i = 0; i < 7; i += 1) await recordVisionOutcome(false)
    for (let i = 0; i < 3; i += 1) await recordVisionOutcome(true)

    const report = await visionHitRate()

    expect(report.samples).toBe(10)
    expect(report.hitRate).toBeCloseTo(0.7, 2)
  })

  test('样本不足 20 条时不熔断，避免冷启动误判', async () => {
    for (let i = 0; i < 10; i += 1) await recordVisionOutcome(true)

    const report = await visionHitRate()

    expect(report.hitRate).toBe(0)
    expect(report.fallbackActive).toBe(false)
  })

  test('样本足够且命中率跌破 0.8 时熔断生效', async () => {
    for (let i = 0; i < 15; i += 1) await recordVisionOutcome(false)
    for (let i = 0; i < 10; i += 1) await recordVisionOutcome(true)

    const report = await visionHitRate()

    expect(report.hitRate).toBeCloseTo(0.6, 2)
    expect(report.fallbackActive).toBe(true)
  })

  test('命中率达标时不熔断', async () => {
    for (let i = 0; i < 24; i += 1) await recordVisionOutcome(false)
    await recordVisionOutcome(true)

    const report = await visionHitRate()

    expect(report.hitRate).toBeCloseTo(0.96, 2)
    expect(report.fallbackActive).toBe(false)
  })

  test('熔断状态会随识别结果一起返回，供前端切换主入口', async () => {
    for (let i = 0; i < 25; i += 1) await recordVisionOutcome(true)
    withConfidence(0.9)

    const result = await decideVisionAnchor({ imageKey: 'k5', candidates: CANDIDATES })

    expect(result.fallbackActive).toBe(true)
  })

  test('滚动窗口只保留最近 200 条', async () => {
    for (let i = 0; i < 210; i += 1) await recordVisionOutcome(false)

    const report = await visionHitRate()

    expect(report.samples).toBe(200)
  })
})

describe('无可用 VLM 时的降级 —— 不能在用户按下快门后抛错', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  test('视觉模型配成 deepseek-v4-pro（不吃图片）时降级到「问一句」', async () => {
    vi.stubEnv('MODEL_PROVIDER', 'deepseek')
    vi.stubEnv('MODEL_ID_VISION', 'deepseek-v4-pro')
    // 给假 Key 以隔离变量：这里要测的是「模型不吃图片」，不是「缺 Key」
    vi.stubEnv('DEEPSEEK_API_KEY', 'sk-fake-for-availability-check')

    const result = await decideVisionAnchor({ imageKey: 'k', candidates: CANDIDATES })

    expect(result.decision).toBe('fallback_ask')
    expect(result.fallbackActive).toBe(true)
    expect(result.fallbackReason).toContain('deepseek-flash')
  })

  test('换成 deepseek-flash 后视觉链路判定为可用', () => {
    vi.stubEnv('MODEL_PROVIDER', 'deepseek')
    vi.stubEnv('MODEL_ID_VISION', 'deepseek-flash')
    vi.stubEnv('DEEPSEEK_API_KEY', 'sk-fake-for-availability-check')

    const verdict = visionAvailability()

    expect(verdict).toEqual({ available: true, modelId: 'deepseek-flash', certain: true })
  })

  test('文本走 DeepSeek、视觉单独走通义千问的混搭配置被认可', () => {
    vi.stubEnv('MODEL_PROVIDER', 'deepseek')
    vi.stubEnv('MODEL_PROVIDER_VISION', 'dashscope')
    vi.stubEnv('MODEL_ID_VISION', 'qwen-vl-max')
    vi.stubEnv('DASHSCOPE_API_KEY', 'sk-fake-for-availability-check')

    const verdict = visionAvailability()

    expect(verdict).toEqual({ available: true, modelId: 'qwen-vl-max', certain: true })
  })

  test('配了供应商但没有 Key 时也要提前降级，而不是调用时抛错', async () => {
    vi.stubEnv('MODEL_PROVIDER', 'dashscope')
    vi.stubEnv('MODEL_ID_VISION', 'qwen-vl-max')
    vi.stubEnv('DASHSCOPE_API_KEY', '')
    vi.stubEnv('MODEL_API_KEY', '')

    const result = await decideVisionAnchor({ imageKey: 'k', candidates: CANDIDATES })

    expect(result.decision).toBe('fallback_ask')
    expect(result.fallbackActive).toBe(true)
    expect(result.fallbackReason).toContain('DASHSCOPE_API_KEY')
  })

  test('降级原因会被带出来，供运营后台排查', async () => {
    vi.stubEnv('MODEL_PROVIDER', 'ark')
    vi.stubEnv('MODEL_ID_VISION', '')
    vi.stubEnv('ARK_API_KEY', 'sk-fake-for-availability-check')

    const result = await decideVisionAnchor({ imageKey: 'k', candidates: CANDIDATES })

    expect(result.decision).toBe('fallback_ask')
    expect(result.fallbackReason).toContain('MODEL_ID_VISION')
  })
})
