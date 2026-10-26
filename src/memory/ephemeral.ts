import { redis } from '../db/redis.js'

/**
 * L0 瞬时层 —— 规格 01 §1。
 *
 * 这一层的全部意义在于：系统推断的信号可以在本次旅程里被使用，
 * 但随 TTL 过期而消失，永远不会落库、不会参与蒸馏。
 * 规格 01 §3.3 的红线「系统推断不进长期记忆」就靠这里和写入网关共同保证。
 */

const TTL_SEC = 24 * 60 * 60 // 旅程结束 + 24h

const signalKey = (journeyId: string): string => `l0:signal:${journeyId}`
const contextKey = (journeyId: string): string => `l0:ctx:${journeyId}`
const spokeKey = (journeyId: string): string => `l0:spoke:${journeyId}`
const ignoredKey = (journeyId: string, poiId: string): string => `l0:ign:${journeyId}:${poiId}`

export type InferredSignal = {
  readonly dimension: string
  readonly value: string
  readonly at: string
}

/** 推断信号：只进 L0，带 TTL */
export const pushInferredSignal = async (
  journeyId: string, signal: InferredSignal,
): Promise<void> => {
  const key = signalKey(journeyId)
  await redis.rpush(key, JSON.stringify(signal))
  await redis.expire(key, TTL_SEC)
}

export const readInferredSignals = async (
  journeyId: string,
): Promise<readonly InferredSignal[]> => {
  const raw = await redis.lrange(signalKey(journeyId), 0, -1)
  return raw.map((r) => JSON.parse(r) as InferredSignal)
}

/** Context State 缓存，TTL 30s（规格 02 §6） */
export const cacheContext = async (journeyId: string, state: unknown): Promise<void> => {
  await redis.set(contextKey(journeyId), JSON.stringify(state), 'EX', 30)
}

export const readCachedContext = async (journeyId: string): Promise<unknown | null> => {
  const raw = await redis.get(contextKey(journeyId))
  return raw === null ? null : JSON.parse(raw)
}

/** 最近一次主动开口的时间，供主动性引擎的 last_spoke_sec_ago 与硬否决使用 */
export const recordSpoke = async (journeyId: string, at: Date): Promise<void> => {
  await redis.set(spokeKey(journeyId), at.toISOString(), 'EX', TTL_SEC)
}

export const readLastSpoke = async (journeyId: string): Promise<Date | null> => {
  const raw = await redis.get(spokeKey(journeyId))
  return raw === null ? null : new Date(raw)
}

/** 连续被忽略计数（规格 02 §7.5），按旅程 × 点位，不跨旅程累计 */
export const bumpIgnored = async (journeyId: string, poiId: string): Promise<number> => {
  const key = ignoredKey(journeyId, poiId)
  const count = await redis.incr(key)
  await redis.expire(key, TTL_SEC)
  return count
}

export const readIgnored = async (journeyId: string, poiId: string): Promise<number> => {
  const raw = await redis.get(ignoredKey(journeyId, poiId))
  return raw === null ? 0 : Number(raw)
}

export const resetIgnored = async (journeyId: string, poiId: string): Promise<void> => {
  await redis.del(ignoredKey(journeyId, poiId))
}

export const purgeJourney = async (journeyId: string): Promise<void> => {
  const keys = await redis.keys(`l0:*:${journeyId}*`)
  if (keys.length > 0) await redis.del(...keys)
}
