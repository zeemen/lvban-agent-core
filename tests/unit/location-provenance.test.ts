import { describe, expect, test } from 'vitest'
import { resolveLocationProvenance } from '../../src/context/provenance.js'
import { hardVeto } from '../../src/context/proactivity.js'
import type { ContextState } from '../../src/domain/context-state.js'

/**
 * 位置来源与置信度 —— 规格 02 §30「室内不伪造精确位置」。
 *
 * 这组测试是冲着一个实测到的谎来的：南博问答里 Context State 报
 * `locationSource=geofence, locationConfidence=0.9`，而 content/geofences/
 * 根本没有 nanjing_museum 这个文件——室内一个围栏都没有，这 0.9 是凭空来的。
 *
 * 规格 02 §4.1 室内只有四件套：用户选展区（1.0）、视觉识别（VLM top-1 分）、
 * 展品编号（0.95）、已访问点位推断（≤0.6，且「不单独成立」）。围栏不在其中。
 */

const INDOOR = 'indoor' as const
const OUTDOOR = 'outdoor' as const

describe('没有位置就说没有', () => {
  test('poiId 为空时两种场景都是 none/0', () => {
    for (const scene of [INDOOR, OUTDOOR]) {
      expect(resolveLocationProvenance({ poiId: null, scene })).toEqual({
        source: 'none', confidence: 0,
      })
    }
  })
})

describe('室外：围栏仍是默认来源', () => {
  test('poiId 来自围栏引擎，保持 geofence/0.9 不变', () => {
    expect(resolveLocationProvenance({ poiId: 'fzm_wende_qiao', scene: OUTDOOR })).toEqual({
      source: 'geofence', confidence: 0.9,
    })
  })
})

describe('室内：不许冒充围栏', () => {
  test('没声明来源时，不能说是 geofence——室内没有围栏', () => {
    const got = resolveLocationProvenance({ poiId: 'njm_cuojinyin_hu', scene: INDOOR })
    expect(got.source).not.toBe('geofence')
    expect(got.source).toBe('inferred')
  })

  test('没声明来源时置信度不超过 0.6（规格 02 §4.1 ④）', () => {
    const got = resolveLocationProvenance({ poiId: 'njm_cuojinyin_hu', scene: INDOOR })
    expect(got.confidence).toBeLessThanOrEqual(0.6)
  })

  test('「不单独成立」要真的生效：主动开口被硬否决挡住', () => {
    const got = resolveLocationProvenance({ poiId: 'njm_cuojinyin_hu', scene: INDOOR })
    const ctx = {
      userIsSpeaking: false, activity: 'still', isDining: false,
      lastSpokeSecAgo: null, consecutiveIgnored: 0, activeTask: null,
      locationConfidence: got.confidence,
    } as unknown as ContextState
    expect(hardVeto(ctx, { kind: 'geofence_arrive' })).toBe('location_uncertain')
  })

  test('客户端硬说自己是 geofence 也不认，降回 inferred', () => {
    const got = resolveLocationProvenance({
      poiId: 'njm_cuojinyin_hu', scene: INDOOR, declaredSource: 'geofence', declaredConfidence: 0.99,
    })
    expect(got).toEqual({ source: 'inferred', confidence: 0.5 })
  })
})

describe('室内四件套：声明了就按规格给分', () => {
  test('用户自己选的展区，1.0（规格 02 §4.1 ①）', () => {
    expect(resolveLocationProvenance({
      poiId: 'njm_cuojinyin_hu', scene: INDOOR, declaredSource: 'user_confirmed',
    })).toEqual({ source: 'user_confirmed', confidence: 1 })
  })

  test('用户选的就是 1.0，客户端报多少都不作数', () => {
    expect(resolveLocationProvenance({
      poiId: 'njm_cuojinyin_hu', scene: INDOOR,
      declaredSource: 'user_confirmed', declaredConfidence: 0.3,
    }).confidence).toBe(1)
  })

  test('视觉识别用 VLM 自己的 top-1 分，原样带过来', () => {
    expect(resolveLocationProvenance({
      poiId: 'njm_cuojinyin_hu', scene: INDOOR,
      declaredSource: 'vision_anchor', declaredConfidence: 0.81,
    })).toEqual({ source: 'vision_anchor', confidence: 0.81 })
  })

  test('说是视觉识别却不给分数：当没认出来，降回 inferred', () => {
    expect(resolveLocationProvenance({
      poiId: 'njm_cuojinyin_hu', scene: INDOOR, declaredSource: 'vision_anchor',
    })).toEqual({ source: 'inferred', confidence: 0.5 })
  })

  test('推断类的分数封顶 0.6，报 0.95 也压回去', () => {
    expect(resolveLocationProvenance({
      poiId: 'njm_cuojinyin_hu', scene: INDOOR,
      declaredSource: 'inferred', declaredConfidence: 0.95,
    }).confidence).toBe(0.6)
  })

  test('推断类报得比默认还低时，按它报的来——它比我们更清楚自己有多不确定', () => {
    expect(resolveLocationProvenance({
      poiId: 'njm_cuojinyin_hu', scene: INDOOR,
      declaredSource: 'inferred', declaredConfidence: 0.2,
    }).confidence).toBe(0.2)
  })
})
