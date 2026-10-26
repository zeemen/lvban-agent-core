import { describe, expect, test } from 'vitest'
import {
  distanceMeters, evaluateGeofence, initialTracker, pickActiveFence,
  type Fix, type GeofenceDef, type TrackerState,
} from '../../src/context/geofence.js'

const GONGYUAN: GeofenceDef = {
  poiId: 'fzm_jiangnan_gongyuan',
  name: '江南贡院',
  center: { lat: 32.0211, lng: 118.7905 },
  radiusM: 25,
  priority: 1,
  sceneId: 'fuzimiao',
}

const fixAt = (
  offset: { lat?: number; lng?: number }, at: Date, extra: Partial<Fix> = {},
): Fix => ({
  lat: GONGYUAN.center.lat + (offset.lat ?? 0),
  lng: GONGYUAN.center.lng + (offset.lng ?? 0),
  accuracyM: 12,
  at,
  ...extra,
})

const T0 = new Date('2026-10-25T10:00:00Z')
const after = (sec: number): Date => new Date(T0.getTime() + sec * 1000)

describe('distanceMeters', () => {
  test('同一点距离为 0', () => {
    expect(distanceMeters(GONGYUAN.center, GONGYUAN.center)).toBeCloseTo(0, 5)
  })

  test('纬度差 0.001 度约为 111 米', () => {
    const north = { lat: GONGYUAN.center.lat + 0.001, lng: GONGYUAN.center.lng }
    expect(distanceMeters(GONGYUAN.center, north)).toBeGreaterThan(100)
    expect(distanceMeters(GONGYUAN.center, north)).toBeLessThan(120)
  })
})

describe('evaluateGeofence 六个触发条件', () => {
  test('精度低于阈值时拒绝判定，而不是猜', () => {
    // Arrange：人就在圆心，但 GPS 精度 60m
    const fix = fixAt({}, T0, { accuracyM: 60 })

    // Act
    const result = evaluateGeofence(GONGYUAN, initialTracker, fix)

    // Assert
    expect(result.event).toBeNull()
    expect(result.blockedBy).toBe('accuracy_too_low')
  })

  test('单次定位落入半径内不触发，需要连续两次去抖', () => {
    const result = evaluateGeofence(GONGYUAN, initialTracker, fixAt({}, T0))

    expect(result.event).toBeNull()
    expect(result.blockedBy).toBe('debounce')
    expect(result.state.consecutiveInside).toBe(1)
  })

  test('连续两次但停留不足 20 秒时不触发——路过不算到达', () => {
    const first = evaluateGeofence(GONGYUAN, initialTracker, fixAt({}, T0))
    const second = evaluateGeofence(GONGYUAN, first.state, fixAt({}, after(5)))

    expect(second.event).toBeNull()
    expect(second.blockedBy).toBe('dwell_too_short')
  })

  test('连续两次且停留满 20 秒后产生 arrive', () => {
    const first = evaluateGeofence(GONGYUAN, initialTracker, fixAt({}, T0))
    const second = evaluateGeofence(GONGYUAN, first.state, fixAt({}, after(25)))

    expect(second.event).toBe('arrive')
    expect(second.state.inside).toBe(true)
    expect(second.state.lastTriggeredMs).toBe(after(25).getTime())
  })

  test('快速移动时不触发——是路过不是在看', () => {
    const first = evaluateGeofence(GONGYUAN, initialTracker, fixAt({}, T0, { speedMps: 5 }))
    const second = evaluateGeofence(GONGYUAN, first.state, fixAt({}, after(25), { speedMps: 5 }))

    expect(second.event).toBeNull()
    expect(second.blockedBy).toBe('fast_moving')
  })

  test('冷却期内不重复触发同一点位', () => {
    const triggered: TrackerState = {
      inside: false,
      consecutiveInside: 1,
      insideSinceMs: T0.getTime(),
      lastTriggeredMs: T0.getTime(),
    }

    const result = evaluateGeofence(GONGYUAN, triggered, fixAt({}, after(30)))

    expect(result.event).toBeNull()
    expect(result.blockedBy).toBe('cooldown')
  })
})

describe('evaluateGeofence 迟滞', () => {
  const inside: TrackerState = {
    inside: true, consecutiveInside: 2,
    insideSinceMs: T0.getTime(), lastTriggeredMs: T0.getTime(),
  }

  test('已在内部且距离仍小于离开半径时不产生 leave', () => {
    // 约 33 米：超出 25m 进入半径，但在 40m 离开半径内
    const result = evaluateGeofence(GONGYUAN, inside, fixAt({ lat: 0.0003 }, after(60)))

    expect(result.event).toBeNull()
    expect(result.blockedBy).toBe('already_inside')
  })

  test('超出离开半径才产生 leave', () => {
    const result = evaluateGeofence(GONGYUAN, inside, fixAt({ lat: 0.001 }, after(60)))

    expect(result.event).toBe('leave')
    expect(result.state.inside).toBe(false)
  })
})

describe('pickActiveFence', () => {
  const mingyuan: GeofenceDef = {
    ...GONGYUAN, poiId: 'fzm_mingyuan_lou', name: '明远楼',
    center: { lat: 32.02112, lng: 118.79052 }, radiusM: 25, priority: 2,
  }

  test('重叠围栏按优先级取一个，保证同一时刻只有一个 active_poi', () => {
    const picked = pickActiveFence([mingyuan, GONGYUAN], fixAt({}, T0))

    expect(picked?.poiId).toBe('fzm_jiangnan_gongyuan')
  })

  test('都不在范围内时返回 null', () => {
    expect(pickActiveFence([GONGYUAN], fixAt({ lat: 0.01 }, T0))).toBeNull()
  })
})
