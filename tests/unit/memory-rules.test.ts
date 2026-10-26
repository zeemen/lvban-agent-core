import { describe, expect, test } from 'vitest'
import { computeStrength } from '../../src/memory/distill.js'
import { placeAffinity, scoreHook, topicSimilarity } from '../../src/memory/retrieval.js'

describe('computeStrength —— 规格 01 §4.4', () => {
  test('首次成立的偏好强度在 0.5 附近', () => {
    const strength = computeStrength({
      journeyCount: 1, signalTotal: 2, source: 'explicit', daysSinceLastSeen: 0,
    })

    expect(strength).toBeGreaterThanOrEqual(0.5)
    expect(strength).toBeLessThan(0.65)
  })

  test('跨旅程重复出现提高强度', () => {
    const once = computeStrength({
      journeyCount: 1, signalTotal: 2, source: 'explicit', daysSinceLastSeen: 0,
    })
    const thrice = computeStrength({
      journeyCount: 3, signalTotal: 6, source: 'explicit', daysSinceLastSeen: 0,
    })

    expect(thrice).toBeGreaterThan(once)
  })

  test('用户亲口确认比系统从行为推出的同等信号更强', () => {
    const explicit = computeStrength({
      journeyCount: 2, signalTotal: 4, source: 'explicit', daysSinceLastSeen: 0,
    })
    const confirmed = computeStrength({
      journeyCount: 2, signalTotal: 4, source: 'user_confirmed', daysSinceLastSeen: 0,
    })

    expect(confirmed).toBeGreaterThan(explicit)
  })

  test('跨旅程加成在第 4 次之后封顶，避免老偏好无限变强', () => {
    const four = computeStrength({
      journeyCount: 4, signalTotal: 8, source: 'explicit', daysSinceLastSeen: 0,
    })
    const ten = computeStrength({
      journeyCount: 10, signalTotal: 8, source: 'explicit', daysSinceLastSeen: 0,
    })

    expect(ten).toBe(four)
  })

  test('久未出现的偏好按半衰期衰减', () => {
    const fresh = computeStrength({
      journeyCount: 2, signalTotal: 4, source: 'explicit', daysSinceLastSeen: 0,
    })
    const stale = computeStrength({
      journeyCount: 2, signalTotal: 4, source: 'explicit', daysSinceLastSeen: 365,
    })

    expect(stale).toBeLessThan(fresh)
  })

  test('强度始终落在 0..1', () => {
    const extreme = computeStrength({
      journeyCount: 99, signalTotal: 999, source: 'user_confirmed', daysSinceLastSeen: 0,
    })

    expect(extreme).toBeLessThanOrEqual(1)
    expect(extreme).toBeGreaterThanOrEqual(0)
  })
})

describe('placeAffinity —— 规格 01 §5.4 三级匹配', () => {
  test('同一地点权重最高', () => {
    expect(placeAffinity('江南贡院', '江南贡院', false)).toBe(1.0)
  })

  test('同类场景跨城市可连接：苏州园林 → 南京园林', () => {
    expect(placeAffinity('瞻园', '拙政园', false)).toBe(0.7)
  })

  test('博物馆之间同类匹配', () => {
    expect(placeAffinity('南京博物院', '上海博物馆', false)).toBe(0.7)
  })

  test('不同类但同主题时退到 0.5', () => {
    expect(placeAffinity('江南贡院', '南京博物院', true)).toBe(0.5)
  })

  test('既不同类也不同主题则为 0', () => {
    expect(placeAffinity('江南贡院', '某餐馆', false)).toBe(0)
  })

  test('当前地点未知时只靠主题匹配', () => {
    expect(placeAffinity(null, '拙政园', true)).toBe(0.5)
    expect(placeAffinity(null, '拙政园', false)).toBe(0)
  })
})

describe('topicSimilarity', () => {
  test('完全命中得 1', () => {
    expect(topicSimilarity('科举', ['科举', '制度'])).toBe(1)
  })

  test('部分包含得 0.6', () => {
    expect(topicSimilarity('科举', ['科举制度'])).toBe(0.6)
  })

  test('无主题或空列表得 0', () => {
    expect(topicSimilarity(null, ['科举'])).toBe(0)
    expect(topicSimilarity('科举', [])).toBe(0)
  })
})

describe('scoreHook —— 规格 01 §5.3', () => {
  const base = {
    similarity: 1, affinity: 1, layer: 'L2' as const,
    recency: 1, strength: 1, repeated: false,
  }

  test('身份层权重高于偏好层，偏好层高于旅程层', () => {
    const l3 = scoreHook({ ...base, layer: 'L3' })
    const l2 = scoreHook({ ...base, layer: 'L2' })
    const l1 = scoreHook({ ...base, layer: 'L1' })

    expect(l3).toBeGreaterThan(l2)
    expect(l2).toBeGreaterThan(l1)
  })

  test('24 小时内已念过的记忆被重罚——避免「它只记得这一件事」', () => {
    const fresh = scoreHook(base)
    const repeated = scoreHook({ ...base, repeated: true })

    expect(fresh - repeated).toBeCloseTo(0.25, 5)
  })

  test('全维度命中时分数最高', () => {
    const full = scoreHook(base)
    const partial = scoreHook({ ...base, similarity: 0, affinity: 0 })

    expect(full).toBeGreaterThan(partial)
  })
})
