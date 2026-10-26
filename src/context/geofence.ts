import { location as cfg } from '../config/index.js'

/**
 * 电子围栏 —— 规格 02 §3。纯函数，状态由调用方持有（存 Redis）。
 *
 * 关键点：
 *   - 迟滞：进入半径 radiusM，离开半径 radiusM + 15m（规格 02 §3.2）
 *   - 六条件齐备才产生 arrive 事件（规格 02 §3.3）
 *   - 产生 arrive ≠ 开口。开口由 proactivity.ts 单独决定。
 */

export type GeofenceDef = {
  readonly poiId: string
  readonly name: string
  readonly center: { readonly lat: number; readonly lng: number }
  readonly radiusM: number
  readonly exitRadiusM?: number
  readonly minDwellSec?: number
  readonly cooldownSec?: number
  readonly priority: number
  readonly sceneId: string
}

export type Fix = {
  readonly lat: number
  readonly lng: number
  readonly accuracyM: number
  readonly at: Date
  readonly speedMps?: number
}

export type TrackerState = {
  readonly inside: boolean
  readonly consecutiveInside: number
  readonly insideSinceMs: number | null
  readonly lastTriggeredMs: number | null
}

export const initialTracker: TrackerState = {
  inside: false,
  consecutiveInside: 0,
  insideSinceMs: null,
  lastTriggeredMs: null,
}

export type GeofenceEvent = 'arrive' | 'leave' | null

export type GeofenceResult = {
  readonly state: TrackerState
  readonly event: GeofenceEvent
  readonly distanceM: number
  /** 没有产生事件时的原因，用于运营后台排查「为什么这里没触发」 */
  readonly blockedBy: string | null
}

const EARTH_RADIUS_M = 6_371_000
const DEDUPE_FIXES = 2

const toRad = (deg: number): number => (deg * Math.PI) / 180

/** gcj02 坐标直接算球面距离；首发只在南京，坐标系一致即可（规格 README 全局约定） */
export const distanceMeters = (
  a: { readonly lat: number; readonly lng: number },
  b: { readonly lat: number; readonly lng: number },
): number => {
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const lat1 = toRad(a.lat)
  const lat2 = toRad(b.lat)
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)))
}

export const isFastMoving = (fix: Fix): boolean =>
  (fix.speedMps ?? 0) > cfg.fastMovingSpeedMps

export const evaluateGeofence = (
  def: GeofenceDef,
  state: TrackerState,
  fix: Fix,
): GeofenceResult => {
  const distanceM = distanceMeters(fix, def.center)
  const exitRadius = def.exitRadiusM ?? def.radiusM + cfg.geofenceExitMarginM
  const minDwell = def.minDwellSec ?? cfg.geofenceMinDwellSec
  const cooldown = def.cooldownSec ?? cfg.geofenceCooldownSec
  const nowMs = fix.at.getTime()

  // 条件 2：精度不够时的正确行为是闭嘴，不是猜（规格 02 §2.2）
  if (fix.accuracyM > cfg.trustedAccuracyM) {
    return { state, event: null, distanceM, blockedBy: 'accuracy_too_low' }
  }

  // 迟滞：已在内部时用 exitRadius 判离开，未进入时用 radiusM 判进入
  const withinEnter = distanceM <= def.radiusM
  const withinExit = distanceM <= exitRadius

  if (state.inside) {
    if (withinExit) {
      return { state, event: null, distanceM, blockedBy: 'already_inside' }
    }
    return {
      state: { ...state, inside: false, consecutiveInside: 0, insideSinceMs: null },
      event: 'leave',
      distanceM,
      blockedBy: null,
    }
  }

  if (!withinEnter) {
    return {
      state: state.consecutiveInside === 0
        ? state
        : { ...state, consecutiveInside: 0, insideSinceMs: null },
      event: null,
      distanceM,
      blockedBy: 'outside',
    }
  }

  const consecutiveInside = state.consecutiveInside + 1
  const insideSinceMs = state.insideSinceMs ?? nowMs
  const pending: TrackerState = { ...state, consecutiveInside, insideSinceMs }

  // 条件 1：连续 2 次定位落在半径内（去抖）
  if (consecutiveInside < DEDUPE_FIXES) {
    return { state: pending, event: null, distanceM, blockedBy: 'debounce' }
  }

  // 条件 3：停留 ≥ minDwellSec —— 路过不算到达
  if ((nowMs - insideSinceMs) / 1000 < minDwell) {
    return { state: pending, event: null, distanceM, blockedBy: 'dwell_too_short' }
  }

  // 条件 4：冷却
  if (state.lastTriggeredMs !== null && (nowMs - state.lastTriggeredMs) / 1000 < cooldown) {
    return { state: pending, event: null, distanceM, blockedBy: 'cooldown' }
  }

  // 条件 6：不在快速移动状态
  if (isFastMoving(fix)) {
    return { state: pending, event: null, distanceM, blockedBy: 'fast_moving' }
  }

  return {
    state: { inside: true, consecutiveInside, insideSinceMs, lastTriggeredMs: nowMs },
    event: 'arrive',
    distanceM,
    blockedBy: null,
  }
}

/**
 * 围栏重叠时取一个：按 priority 升序，相同优先级取距中心最近的。
 * 同一时刻只有一个 active_poi，不允许并发触发两段讲解（规格 02 §3.4）。
 */
export const pickActiveFence = (
  defs: readonly GeofenceDef[],
  fix: Fix,
): GeofenceDef | null => {
  const containing = defs
    .map((def) => ({ def, distanceM: distanceMeters(fix, def.center) }))
    .filter(({ def, distanceM }) => distanceM <= def.radiusM)
  if (containing.length === 0) return null
  const sorted = [...containing].sort(
    (a, b) => a.def.priority - b.def.priority || a.distanceM - b.distanceM,
  )
  return sorted[0]?.def ?? null
}
