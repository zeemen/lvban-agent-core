import { describe, expect, test } from 'vitest'
import {
  decideProactivity, deriveActivity, deriveFatigue, deriveInterest,
  hardVeto, modeThresholds, scoreFactors, type Trigger,
} from '../../src/context/proactivity.js'
import type { ContextState } from '../../src/domain/context-state.js'

const baseContext: ContextState = {
  user: 'u1', mode: 'companion', party: 'solo', ageBand: '19_24',
  scene: 'outdoor', sceneId: 'fuzimiao', location: 'fzm_jiangnan_gongyuan',
  locationSource: 'geofence', locationConfidence: 0.92,
  activity: 'still', isMoving: false, isDining: false, accuracyM: 12,
  currentTopic: '科举', interest: 'high', fatigue: 'low',
  dwellHereSec: 120, elapsedMin: 40, timeLeft: 60, timeOfDay: 'evening',
  nextGoal: null, routeRemaining: [], activeTask: null,
  memoryHooks: [], identityTraits: [], preferences: {}, visitedAnchors: [],
  lastSpokeSecAgo: 600, lastProactiveSecAgo: null, proactiveCount: 0,
  consecutiveIgnored: 0, userIsSpeaking: false,
  journeyId: 'j1', stateVersion: 1, computedAt: '2026-10-25T10:00:00Z',
}

const arrive: Trigger = {
  kind: 'geofence_arrive', poiId: 'fzm_jiangnan_gongyuan',
  anchorIsTop30: true, isFirstVisit: true,
}

describe('hardVeto —— 规格 02 §7.2', () => {
  test.each([
    ['user_is_speaking', { userIsSpeaking: true }],
    ['fast_moving', { activity: 'fast_moving' as const }],
    ['is_dining', { isDining: true }],
    ['just_spoke', { lastSpokeSecAgo: 20 }],
    ['consecutive_ignored', { consecutiveIgnored: 2 }],
    ['location_uncertain', { locationConfidence: 0.4 }],
  ])('%s 否决开口', (expected, patch) => {
    expect(hardVeto({ ...baseContext, ...patch }, arrive)).toBe(expected)
  })

  test('安全场景优先于内容', () => {
    expect(hardVeto(baseContext, { ...arrive, safetySensitive: true })).toBe('safety_first')
  })

  test('孩子正在观察时不插嘴', () => {
    const ctx = { ...baseContext, activeTask: { taskId: 't1', stage: 'observing' } }

    expect(hardVeto(ctx, arrive)).toBe('task_in_progress')
  })

  test('正常状态不否决', () => {
    expect(hardVeto(baseContext, arrive)).toBeNull()
  })
})

describe('decideProactivity', () => {
  test('用户主动提问不走主动性引擎——问了就一定答', () => {
    const ctx = { ...baseContext, isDining: true, fatigue: 'high' as const }

    const result = decideProactivity(ctx, { kind: 'user_question' })

    expect(result.decision).toBe('SPEAK')
    expect(result.reason).toBe('user_initiated')
  })

  test('Top30 + 首访 + 高兴趣 → SPEAK，并返回可排查的 reason', () => {
    const result = decideProactivity(baseContext, arrive)

    expect(result.decision).toBe('SPEAK')
    expect(result.reason).toContain('top30_anchor')
    expect(result.reason).toContain('first_visit')
    expect(result.vetoedBy).toBeNull()
  })

  test('被否决时返回 SILENT 并说明否决者', () => {
    const result = decideProactivity({ ...baseContext, isDining: true }, arrive)

    expect(result.decision).toBe('SILENT')
    expect(result.vetoedBy).toBe('is_dining')
  })

  test('同一上下文在轻导览模式下更不容易开口', () => {
    const companion = decideProactivity(baseContext, arrive)
    const light = decideProactivity({ ...baseContext, mode: 'light_guide' }, arrive)

    expect(companion.decision).toBe('SPEAK')
    expect(light.score).toBeLessThan(companion.score)
    expect(modeThresholds('light_guide').speak)
      .toBeGreaterThan(modeThresholds('companion').speak)
  })

  test('高疲劳扣分，非 Top30 的普通点位因此降级', () => {
    const tired = { ...baseContext, fatigue: 'high' as const, interest: 'medium' as const }

    const result = decideProactivity(tired, { kind: 'geofence_arrive', isFirstVisit: true })

    expect(result.decision).not.toBe('SPEAK')
  })

  test('命中记忆线索会提高开口倾向', () => {
    const withMemory = { ...baseContext, memoryHooks: ['南京·江南贡院·科举'] }

    const without = decideProactivity(baseContext, arrive)
    const withHook = decideProactivity(withMemory, arrive)

    expect(withHook.score).toBeGreaterThan(without.score)
    expect(withHook.reason).toContain('memory_hook_match')
  })
})

describe('派生字段 —— 规格 02 §6.2', () => {
  test('提问两次即判为高兴趣', () => {
    expect(deriveInterest({
      questionCount: 2, dwellSec: 60, medianDwellSec: 300, skipped: false,
    })).toBe('high')
  })

  test('停留远低于中位数判为低兴趣', () => {
    expect(deriveInterest({
      questionCount: 0, dwellSec: 60, medianDwellSec: 300, skipped: false,
    })).toBe('low')
  })

  test('主动跳过直接判低兴趣', () => {
    expect(deriveInterest({
      questionCount: 5, dwellSec: 900, medianDwellSec: 300, skipped: true,
    })).toBe('low')
  })

  test('用户说累了直接判高疲劳，不等时长累积', () => {
    expect(deriveFatigue({
      elapsedMin: 10, saidTired: true, recentInteractions: 5, priorInteractions: 5,
    })).toBe('high')
  })

  test('交互密度骤降判中度疲劳', () => {
    expect(deriveFatigue({
      elapsedMin: 60, saidTired: false, recentInteractions: 1, priorInteractions: 10,
    })).toBe('medium')
  })

  test('速度超过 3 m/s 判为快速移动', () => {
    expect(deriveActivity(5)).toBe('fast_moving')
    expect(deriveActivity(1.2)).toBe('walking')
    expect(deriveActivity(0.1)).toBe('still')
    expect(deriveActivity(null)).toBe('still')
  })
})

describe('最大主动频次 —— 规格 02 §7.4', () => {
  /*
   * 这一档刻意不是硬否决。§7.2 的否决表里没有它，只有 §7.4 的
   * 「最大主动频次」；而 §7.1 给了三值决策。所以频次到了的正确行为是
   * **降一档**——不出声，但给个气泡，而不是整条沉默。
   *
   * 区别于 just_spoke：那条看的是「任何出声」（包括刚答完用户的提问），
   * 60 秒内别叠话，整条压下；这条只看上一次**主动开口**。
   */
  test('刚主动开口过 → 够开口的分数降级成气泡，而不是整条沉默', () => {
    const ctx = { ...baseContext, lastProactiveSecAgo: 120 }

    const result = decideProactivity(ctx, arrive)

    expect(result.decision).toBe('SOFT_HINT')
    expect(result.vetoedBy).toBeNull()
    expect(result.reason).toContain('speak_rate_limited')
  })

  test('过了间隔照常开口', () => {
    const ctx = { ...baseContext, lastProactiveSecAgo: 9 * 60 }

    expect(decideProactivity(ctx, arrive).decision).toBe('SPEAK')
  })

  test('这趟还没主动开口过就不受限', () => {
    expect(decideProactivity(baseContext, arrive).decision).toBe('SPEAK')
  })

  test('间隔按模式分：7 分钟前开过口，同游还要等，亲子已经可以了', () => {
    const ctx = { ...baseContext, lastProactiveSecAgo: 7 * 60 }

    expect(decideProactivity(ctx, arrive).decision).toBe('SOFT_HINT')
    expect(decideProactivity({ ...ctx, mode: 'family_study' }, arrive).decision).toBe('SPEAK')
    expect(modeThresholds('light_guide').minGapSec)
      .toBeGreaterThan(modeThresholds('companion').minGapSec)
  })

  test('气泡本身不受频次限制——它没出声，不该再被压成沉默', () => {
    // 已听过 → 分数落在 soft 区间
    const ctx = { ...baseContext, lastProactiveSecAgo: 10, interest: 'medium' as const }

    const result = decideProactivity(ctx, { kind: 'geofence_arrive', anchorIsTop30: true })

    expect(result.score).toBeLessThan(modeThresholds('companion').speak)
    expect(result.decision).toBe('SOFT_HINT')
  })

  test('60 秒内刚出过声仍然是硬否决，不降级成气泡', () => {
    const ctx = { ...baseContext, lastSpokeSecAgo: 20, lastProactiveSecAgo: null }

    const result = decideProactivity(ctx, arrive)

    expect(result.decision).toBe('SILENT')
    expect(result.vetoedBy).toBe('just_spoke')
  })

  test('用户主动提问不受频次限制', () => {
    const ctx = { ...baseContext, lastProactiveSecAgo: 1 }

    expect(decideProactivity(ctx, { kind: 'user_question' }).decision).toBe('SPEAK')
  })
})

describe('频次扣分数的是主动开口次数 —— 规格 02 §7.3 第 7 行', () => {
  const labels = (patch: Partial<ContextState>): readonly string[] =>
    scoreFactors({ ...baseContext, ...patch }, arrive).map((f) => f.label)

  // 规格原文：「本次旅程已开口次数 > 时长/10min」→ −0.20。
  // 以前比的是 visitedAnchors.length（去重的到访**点位**数），
  // 于是一个默默走过很多点位、系统一次都没开口的用户会被扣分，
  // 而且越是沉默地逛得多、越不可能再开口——方向正好反了。

  test('默默走过很多点位但一次没主动开口，不扣频次分', () => {
    const walked = Array.from({ length: 12 }, (_, i) => `poi_${i}`)
    expect(labels({ visitedAnchors: walked, proactiveCount: 0, elapsedMin: 40 }))
      .not.toContain('spoke_too_often')
  })

  test('主动开口次数超过「时长/10min」才扣', () => {
    // 40 分钟 → 预算 4 次
    expect(labels({ proactiveCount: 5, elapsedMin: 40 })).toContain('spoke_too_often')
  })

  test('刚好用满预算不扣 —— 规格写的是严格大于', () => {
    expect(labels({ proactiveCount: 4, elapsedMin: 40 })).not.toContain('spoke_too_often')
  })

  test('旅程头 10 分钟预算是 1 次，不是 0 次', () => {
    expect(labels({ proactiveCount: 1, elapsedMin: 5 })).not.toContain('spoke_too_often')
    expect(labels({ proactiveCount: 2, elapsedMin: 5 })).toContain('spoke_too_often')
  })

  test('到访点位数再多也不再影响这一项', () => {
    const many = Array.from({ length: 30 }, (_, i) => `poi_${i}`)
    const withPois = labels({ visitedAnchors: many, proactiveCount: 2, elapsedMin: 40 })
    const withoutPois = labels({ visitedAnchors: [], proactiveCount: 2, elapsedMin: 40 })
    expect(withPois).toEqual(withoutPois)
  })

  test('扣分真的落到分数上 —— 同样的触发，开口太多就从 SPEAK 掉到 SOFT_HINT', () => {
    // Top30 +0.30 首访 +0.20 高兴趣 +0.15 话题 +0.10 = 0.75，companion 阈值 0.50
    const calm = decideProactivity({ ...baseContext, proactiveCount: 0, elapsedMin: 40 }, arrive)
    expect(calm.decision).toBe('SPEAK')
    expect(calm.score).toBe(0.75)

    const chatty = decideProactivity({ ...baseContext, proactiveCount: 9, elapsedMin: 40 }, arrive)
    expect(chatty.score).toBe(0.55)
    expect(chatty.reason).toContain('spoke_too_often')
  })
})

describe('精度降权档只能到软提示 —— 规格 02 §2.2', () => {
  /** base 的分数足够 SPEAK（top30 0.30 + 首访 0.20 + interest 0.15 + 话题 0.10 = 0.75） */
  test('精度 35m 时把本该开口的压成气泡', () => {
    // Arrange
    const degraded = { ...baseContext, accuracyM: 35 }

    // Act
    const result = decideProactivity(degraded, arrive)

    // Assert：分数不变，只是档位降一级
    expect(result.score).toBe(0.75)
    expect(result.decision).toBe('SOFT_HINT')
    expect(result.reason).toContain('accuracy_degraded')
  })

  test('精度 12m 时照常开口 —— 对照组', () => {
    expect(decideProactivity(baseContext, arrive).decision).toBe('SPEAK')
  })

  test('降权不会把本来就该沉默的抬成气泡', () => {
    // 轻导览模式阈值 0.70/0.50，再叠疲劳 −0.25 → 0.30，低于 soft
    const ctx = {
      ...baseContext, mode: 'light_guide' as const, fatigue: 'high' as const,
      currentTopic: null, interest: 'low' as const, accuracyM: 35,
    }

    const result = decideProactivity(ctx, arrive)

    expect(result.decision).toBe('SILENT')
  })

  test('降权不绕过硬否决 —— 否决了就是沉默，不是气泡', () => {
    const ctx = { ...baseContext, accuracyM: 35, isDining: true }

    const result = decideProactivity(ctx, arrive)

    expect(result.decision).toBe('SILENT')
    expect(result.vetoedBy).toBe('is_dining')
  })

  test('没有精度信息时不降权 —— 室内本来就没有 GPS 精度这回事', () => {
    const ctx = { ...baseContext, accuracyM: null }

    expect(decideProactivity(ctx, arrive).decision).toBe('SPEAK')
  })

  test('用户主动提问不受降权影响 —— 问了就一定答', () => {
    const ctx = { ...baseContext, accuracyM: 45 }

    expect(decideProactivity(ctx, { kind: 'user_question' }).decision).toBe('SPEAK')
  })
})
