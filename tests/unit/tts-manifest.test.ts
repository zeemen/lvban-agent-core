import { describe, expect, test } from 'vitest'
import { isFresh, stalenessReason, type ManifestEntry } from '../../src/tts/manifest.js'

/**
 * 预合成清单 —— 防的是一类**静默**错误：
 * 固定台词的路径里不含供应商和音色，只看「文件在不在」的话，
 * 用 mock 预合成过一轮再换真供应商，会全部跳过、线上播假音频且不报错。
 */

const want = {
  provider: 'volcengine', voice: 'voice_a', speedRatio: 1.05, text: '嗯，这个有意思。',
}

const entry = (patch: Partial<ManifestEntry> = {}): ManifestEntry => ({
  ...want, bytes: 1024, durationMs: 1600, createdAt: '2026-10-25T00:00:00Z', ...patch,
})

describe('isFresh', () => {
  test('四项全一致才算还能用', () => {
    expect(isFresh(entry(), want)).toBe(true)
  })

  test.each([
    ['供应商', { provider: 'mock' }],
    ['音色', { voice: 'voice_b' }],
    ['语速', { speedRatio: 1.2 }],
    ['文案', { text: '换了台词' }],
  ])('%s 变了就不新鲜', (_label, patch) => {
    expect(isFresh(entry(patch), want)).toBe(false)
  })

  test('清单里没有记录时不算新鲜', () => {
    expect(isFresh(undefined, want)).toBe(false)
  })
})

describe('stalenessReason', () => {
  test('mock 换真供应商时说得出是供应商变了 —— 这正是最危险的那种情况', () => {
    expect(stalenessReason(entry({ provider: 'mock' }), want))
      .toContain('mock → volcengine')
  })

  test('音色变更给出新旧对照', () => {
    expect(stalenessReason(entry({ voice: 'old' }), want)).toContain('old → voice_a')
  })

  test('没有记录时也给得出原因', () => {
    expect(stalenessReason(undefined, want)).not.toBe('')
  })

  test('新鲜时没有原因', () => {
    expect(stalenessReason(entry(), want)).toBe('')
  })
})
