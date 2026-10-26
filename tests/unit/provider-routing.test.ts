import { describe, expect, test } from 'vitest'
import { resolveApiKey, resolveProviderFor } from '../../src/config/index.js'

/**
 * 按任务分供应商 —— 规格 03 §7「不绑定单一模型」。
 * 实际动因：DeepSeek 做文本很划算，但视觉只有 flash 支持；
 * 也可能想把视觉整个交给另一家的 qwen-vl-max。
 */

describe('resolveProviderFor', () => {
  test('没有任何配置时回落到 mock', () => {
    expect(resolveProviderFor('qa', {})).toBe('mock')
  })

  test('MODEL_PROVIDER 作为所有任务的默认', () => {
    const env = { MODEL_PROVIDER: 'deepseek' }

    expect(resolveProviderFor('qa', env)).toBe('deepseek')
    expect(resolveProviderFor('vision', env)).toBe('deepseek')
  })

  test('文本走 DeepSeek、视觉走通义千问的混搭配置', () => {
    const env = { MODEL_PROVIDER: 'deepseek', MODEL_PROVIDER_VISION: 'dashscope' }

    expect(resolveProviderFor('qa', env)).toBe('deepseek')
    expect(resolveProviderFor('planner', env)).toBe('deepseek')
    expect(resolveProviderFor('vision', env)).toBe('dashscope')
  })

  test('空字符串的覆盖不生效', () => {
    const env = { MODEL_PROVIDER: 'deepseek', MODEL_PROVIDER_VISION: '' }

    expect(resolveProviderFor('vision', env)).toBe('deepseek')
  })
})

describe('resolveApiKey', () => {
  test('供应商专属变量优先', () => {
    const env = { DEEPSEEK_API_KEY: 'sk-ds', MODEL_API_KEY: 'sk-generic' }

    expect(resolveApiKey('DEEPSEEK_API_KEY', env)).toBe('sk-ds')
  })

  test('没有专属变量时回落到 MODEL_API_KEY', () => {
    expect(resolveApiKey('DEEPSEEK_API_KEY', { MODEL_API_KEY: 'sk-generic' })).toBe('sk-generic')
  })

  test('同时配多家时互不冲突', () => {
    const env = { DEEPSEEK_API_KEY: 'sk-ds', DASHSCOPE_API_KEY: 'sk-qwen' }

    expect(resolveApiKey('DEEPSEEK_API_KEY', env)).toBe('sk-ds')
    expect(resolveApiKey('DASHSCOPE_API_KEY', env)).toBe('sk-qwen')
  })

  test('都没配时返回空串，由调用方报「缺 Key」', () => {
    expect(resolveApiKey('DEEPSEEK_API_KEY', {})).toBe('')
  })
})
