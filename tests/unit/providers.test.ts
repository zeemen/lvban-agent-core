import { describe, expect, test } from 'vitest'
import {
  PROVIDERS, estimateCostCny, resolveModelId, resolveProfile, resolveVision,
  type ProviderProfile,
} from '../../src/models/providers.js'

describe('resolveProfile', () => {
  test('三家供应商档案齐备', () => {
    expect(Object.keys(PROVIDERS).sort()).toEqual(['ark', 'dashscope', 'deepseek'])
  })

  test('每条档案都标注了 baseUrl 的核实时间与来源', () => {
    for (const profile of Object.values(PROVIDERS)) {
      expect(profile.baseUrlVerifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(profile.baseUrlSource).not.toBe('')
    }
  })

  test('未知供应商报错并列出可选项', () => {
    expect(() => resolveProfile('openai')).toThrow(/dashscope/)
  })
})

describe('resolveModelId —— 模型 ID 刻意不写死', () => {
  test('环境变量优先于档案默认值', () => {
    const profile = resolveProfile('dashscope')

    const id = resolveModelId(profile, 'qa', { MODEL_ID_QA: 'qwen3-custom' })

    expect(id).toBe('qwen3-custom')
  })

  test('没有环境变量时用档案默认值', () => {
    const profile = resolveProfile('dashscope')

    expect(resolveModelId(profile, 'vision', {})).toBe('qwen-vl-max')
  })

  test('空字符串的环境变量不算覆盖', () => {
    const profile = resolveProfile('dashscope')

    expect(resolveModelId(profile, 'qa', { MODEL_ID_QA: '' })).toBe('qwen-plus')
  })

  test('方舟没有预置默认值，报错时明确要求配环境变量并提示先探测', () => {
    const profile = resolveProfile('ark')

    expect(() => resolveModelId(profile, 'qa', {}))
      .toThrow(/MODEL_ID_QA[\s\S]*models:probe/)
  })

  test('DeepSeek 的 vision 默认值必须是 flash —— v4-pro 不吃图片', () => {
    const profile = resolveProfile('deepseek')

    expect(resolveModelId(profile, 'vision', {})).toBe('deepseek-flash')
  })
})

describe('resolveVision —— 视觉是模型的属性，不是供应商的属性', () => {
  test('同一个 DeepSeek 账号，flash 可以吃图片', () => {
    const verdict = resolveVision(resolveProfile('deepseek'), { MODEL_ID_VISION: 'deepseek-flash' })

    expect(verdict).toEqual({ available: true, modelId: 'deepseek-flash', certain: true })
  })

  test('同一个 DeepSeek 账号，v4-pro 不能吃图片，并给出该换成什么', () => {
    const verdict = resolveVision(resolveProfile('deepseek'), { MODEL_ID_VISION: 'deepseek-v4-pro' })

    expect(verdict.available).toBe(false)
    if (!verdict.available) {
      expect(verdict.reason).toContain('deepseek-flash')
      expect(verdict.reason).toContain('MODEL_ID_VISION')
    }
  })

  test('通义千问要用 qwen-vl 系列，普通 qwen-plus 被拒', () => {
    const profile = resolveProfile('dashscope')

    expect(resolveVision(profile, { MODEL_ID_VISION: 'qwen-vl-max' }).available).toBe(true)
    expect(resolveVision(profile, { MODEL_ID_VISION: 'qwen-plus' }).available).toBe(false)
  })

  test('方舟的接入点 ID 不透明：允许尝试但标记为不确定', () => {
    const verdict = resolveVision(resolveProfile('ark'), { MODEL_ID_VISION: 'ep-20261025-abcd' })

    expect(verdict).toEqual({ available: true, modelId: 'ep-20261025-abcd', certain: false })
  })

  test('方舟没配 MODEL_ID_VISION 时判为不可用，并说该设哪个变量', () => {
    const verdict = resolveVision(resolveProfile('ark'), {})

    expect(verdict.available).toBe(false)
    if (!verdict.available) expect(verdict.reason).toContain('MODEL_ID_VISION')
  })
})

describe('estimateCostCny —— 价格未核实时不编数字', () => {
  test('没有 pricing 的档案返回 null，而不是 0', () => {
    for (const profile of Object.values(PROVIDERS)) {
      if (profile.pricing === undefined) {
        expect(estimateCostCny(profile, 1000, 1000)).toBeNull()
      }
    }
  })

  test('有 pricing 时按百万 token 计价', () => {
    const priced: ProviderProfile = {
      ...resolveProfile('dashscope'),
      pricing: {
        inputCnyPerMillion: 2, outputCnyPerMillion: 8,
        verifiedAt: '2026-10-25', source: 'test',
      },
    }

    // 50 万输入 + 25 万输出 = 1 + 2 = 3 元
    expect(estimateCostCny(priced, 500_000, 250_000)).toBeCloseTo(3, 6)
  })
})
