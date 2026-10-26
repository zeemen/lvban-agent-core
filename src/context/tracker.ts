import { redis } from '../db/redis.js'
import { initialTracker, type TrackerState } from './geofence.js'

/** 围栏跟踪状态存 L0（Redis）：它是本次旅程的瞬时状态，不该落库 */

const TTL_SEC = 24 * 60 * 60
const key = (journeyId: string, poiId: string): string => `l0:fence:${journeyId}:${poiId}`

export const readTracker = async (
  journeyId: string, poiId: string,
): Promise<TrackerState> => {
  const raw = await redis.get(key(journeyId, poiId))
  return raw === null ? initialTracker : (JSON.parse(raw) as TrackerState)
}

export const writeTracker = async (
  journeyId: string, poiId: string, state: TrackerState,
): Promise<void> => {
  await redis.set(key(journeyId, poiId), JSON.stringify(state), 'EX', TTL_SEC)
}
