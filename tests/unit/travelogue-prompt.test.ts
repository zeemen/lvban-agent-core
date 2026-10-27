import { describe, expect, test } from 'vitest'
import {
  buildTraveloguePrompt, type TravelogueMaterial,
} from '../../src/agent/travelogue.js'

/**
 * 规格 04 §7.1 的硬约束：
 * 游记里出现的每一条史实都来自已审校的锚点要素或 K1，不由模型自由发挥；
 * 用户自己说过的话可以原样引用（这正是「像自己写的」的来源）。
 */

const material = (patch: Partial<TravelogueMaterial> = {}): TravelogueMaterial => ({
  journeyId: 'j1',
  sceneId: 'fuzimiao',
  occurredOn: '2026-10-27',
  timeline: [
    { place: '江南贡院', dwellSec: 420, questionCount: 3, interestSignal: 'high', topics: ['科举'] },
  ],
  quotes: [{ text: '这格子也太小了吧', at: '2026-10-27T03:00:00Z' }],
  facts: [{ anchorId: 'a1', name: '江南贡院号舍', text: '号舍宽约一米', source: '南京中国科举博物馆' }],
  pendingPreferences: [],
  draftAnchorsExcluded: 0,
  ...patch,
})

describe('证据纪律', () => {
  test('把可用史实逐条列进 prompt，并点名只能用这些', () => {
    const prompt = buildTraveloguePrompt(material())

    expect(prompt).toContain('号舍宽约一米')
    expect(prompt).toMatch(/只能使用|不得使用以外|不要补充/)
  })

  test('没有已审校史实时，明确要求不写任何史实', () => {
    const prompt = buildTraveloguePrompt(material({ facts: [], draftAnchorsExcluded: 2 }))

    expect(prompt).toMatch(/不要写任何史实|没有可用的史实/)
  })

  test('用户原话标成可原样引用', () => {
    const prompt = buildTraveloguePrompt(material())

    expect(prompt).toContain('这格子也太小了吧')
    expect(prompt).toMatch(/原样引用/)
  })

  test('足迹时间线按地点带上停留与提问数', () => {
    const prompt = buildTraveloguePrompt(material())

    expect(prompt).toContain('江南贡院')
    expect(prompt).toContain('3')
  })
})

describe('输出形态', () => {
  test('游记是给人读的，允许分段——和语音讲解的单段约束不同', () => {
    const prompt = buildTraveloguePrompt(material())

    expect(prompt).not.toContain('不分段')
  })

  test('不出现分数、等级、与他人比较（企划书第 08 节红线）', () => {
    const prompt = buildTraveloguePrompt(material())

    expect(prompt).toMatch(/不要(出现|给出).*(分数|评分|等级|排名)/)
  })
})

describe('不许编造经历', () => {
  test('逐项禁止编造地点、动线、天气、同行人这类没发生的事', () => {
    const prompt = buildTraveloguePrompt(material())

    expect(prompt).toMatch(/不要(编|虚构|杜撰)/)
    for (const forbidden of ['地点', '天气', '同行']) {
      expect(prompt).toContain(forbidden)
    }
  })

  test('明确只能写列出的素材，没列到的一律不写', () => {
    const prompt = buildTraveloguePrompt(material())

    expect(prompt).toMatch(/没有列出|没列到|以外的/)
  })

  test('素材少时篇幅也要跟着短——一句原话撑不起一整天', () => {
    const thin = buildTraveloguePrompt(material({ timeline: [], facts: [] }))
    const rich = buildTraveloguePrompt(material({
      timeline: Array.from({ length: 5 }, (_, i) => ({
        place: `地点${i}`, dwellSec: 300, questionCount: 2,
        interestSignal: 'high', topics: ['科举'],
      })),
      quotes: Array.from({ length: 6 }, (_, i) => ({
        text: `第${i}句`, at: '2026-10-27T03:00:00Z',
      })),
    }))

    const limitOf = (p: string): number => Number(/(\d+) 字以内/.exec(p)?.[1] ?? 0)
    expect(limitOf(thin)).toBeGreaterThan(0)
    expect(limitOf(thin)).toBeLessThan(limitOf(rich))
  })

  test('完全没素材时直说写不了，而不是让模型自由发挥', () => {
    const prompt = buildTraveloguePrompt(material({ timeline: [], quotes: [], facts: [] }))

    expect(prompt).toMatch(/素材不足|写不了|不要凭空/)
  })
})

describe('素材为空时', () => {
  test('完全没素材也能产出 prompt，不抛错', () => {
    const empty = material({ timeline: [], quotes: [], facts: [] })

    expect(() => buildTraveloguePrompt(empty)).not.toThrow()
  })
})
