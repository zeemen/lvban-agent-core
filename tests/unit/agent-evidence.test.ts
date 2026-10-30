import { describe, expect, test } from 'vitest'
import { evidenceTexts } from '../../src/agent/evidence.js'
import type { Anchor } from '../../src/content/loader.js'
import type { Passage } from '../../src/knowledge/weknora.js'

/**
 * 「这句话当时能看到的全部资料」——回查校验要拿它当底。
 * 漏掉一处合法来源，正确的回答就会被判成没依据，然后被打回重写。
 */

const passage = (text: string): Passage => ({
  chunkId: 'c', knowledgeId: 'k', title: 't', text, score: 1,
})

const anchor = (over: Partial<Anchor> = {}): Anchor => ({
  anchorId: 'a1', name: '号舍', sceneId: 'fuzimiao', isTop30: true, topics: ['科举'],
  review: { status: 'approved', reviewedBy: [], reviewedAt: null, factCheckRequired: [] },
  k1Sources: [{ title: '中国科举博物馆' }],
  elements: {
    openingHook: { companion: '这排格子是号舍', child: null, light: null },
    observation: { companion: null, child: null, light: null },
    question: { companion: null, child: null, light: null },
    explanation: { companion: '一间宽不到一米', child: null, light: null },
    story: '乡试要在里面待三天',
    connection: { curriculum: null, presentDay: null },
    memoryLink: { template: '' },
    nextAction: { suggest: null, reason: '' },
  },
  ...over,
} as Anchor)

describe('凑齐可回查的资料', () => {
  test('K3 片段的正文都算', () => {
    expect(evidenceTexts([passage('江南贡院始建于南宋乾道四年。')], null))
      .toEqual(['江南贡院始建于南宋乾道四年。'])
  })

  test('锚点里的成稿也算——它是 K1 背书过的精调内容', () => {
    const got = evidenceTexts([], anchor())
    expect(got.join('')).toContain('一间宽不到一米')
    expect(got.join('')).toContain('乡试要在里面待三天')
  })

  test('锚点没有 K1 来源时不算证据（规格 03 §5.1）', () => {
    expect(evidenceTexts([], anchor({ k1Sources: [] }))).toEqual([])
  })

  test('空的要素不会变成空字符串混进来', () => {
    expect(evidenceTexts([], anchor()).every((t) => t.trim() !== '')).toBe(true)
  })

  test('没有片段也没有锚点就是没有证据', () => {
    expect(evidenceTexts([], null)).toEqual([])
  })
})
