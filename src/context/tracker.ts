import { redis } from '../db/redis.js'
import { initialTracker, type TrackerState } from './geofence.js'

/** 围栏跟踪状态存 L0（Redis）：它是本次旅程的瞬时状态，不该落库 */

const TTL_SEC = 24 * 60 * 60
const key = (journeyId: string, poiId: string): string => `l0:fence:${journeyId}:${poiId}`

/**
 * 铺在 initialTracker 上面，而不是直接当 TrackerState 用：这些 JSON 有 24 小时
 * TTL，加字段那天 Redis 里还躺着没有该字段的旧状态。直接断言类型的话，
 * 新字段会是 undefined 而类型系统说它不是，排查起来是最难看的那种 bug。
 */
export const readTracker = async (
  journeyId: string, poiId: string,
): Promise<TrackerState> => {
  const raw = await redis.get(key(journeyId, poiId))
  if (raw === null) return initialTracker
  return { ...initialTracker, ...(JSON.parse(raw) as Partial<TrackerState>) }
}

export const writeTracker = async (
  journeyId: string, poiId: string, state: TrackerState,
): Promise<void> => {
  await redis.set(key(journeyId, poiId), JSON.stringify(state), 'EX', TTL_SEC)
}
