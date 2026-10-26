import { describe, expect, test } from 'vitest'
import {
  decideProactivity, deriveActivity, deriveFatigue, deriveInterest,
  hardVeto, modeThresholds, type Trigger,
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
  lastSpokeSecAgo: 600, consecutiveIgnored: 0, userIsSpeaking: false,
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
