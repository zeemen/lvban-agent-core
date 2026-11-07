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
const proactiveKey = (journeyId: string): string => `l0:proactive:${journeyId}`
const proactiveCountKey = (journeyId: string): string => `l0:pcount:${journeyId}`
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

/**
 * 最近一次**出声**的时间 —— 主动讲解和回答提问都算。
 * 供硬否决里的 last_spoke_sec_ago（60 秒内刚讲过，别叠话）使用。
 */
export const recordSpoke = async (journeyId: string, at: Date): Promise<void> => {
  await redis.set(spokeKey(journeyId), at.toISOString(), 'EX', TTL_SEC)
}

export const readLastSpoke = async (journeyId: string): Promise<Date | null> => {
  const raw = await redis.get(spokeKey(journeyId))
  return raw === null ? null : new Date(raw)
}

/**
 * 最近一次**主动开口**的时间 —— 规格 02 §7.4 的最大主动频次按它算
 * （同游 8 分钟 / 亲子 6 分钟 / 轻导览 15 分钟）。
 *
 * 为什么不和 recordSpoke 共用一个键：那一个的语义是「出过声」，
 * 包含用户问完之后我答的那一句。用它来算主动频次，会变成
 * 「用户刚问过，接下来 8 分钟我就不能主动说话」——那是两件事。
 * 静默卡片也不记这里：它没出声，§7.4 数的是开口。
 */
export const recordProactiveSpoke = async (journeyId: string, at: Date): Promise<void> => {
  const countKey = proactiveCountKey(journeyId)
  await redis.set(proactiveKey(journeyId), at.toISOString(), 'EX', TTL_SEC)
  await redis.incr(countKey)
  await redis.expire(countKey, TTL_SEC)
}

/**
 * 本次旅程主动开口了几次 —— 规格 02 §7.3 第 7 行的频次扣分按它算
 * （「已开口次数 > 时长/10min」→ −0.20）。
 *
 * 和上面那个时间戳同进同出，刻意分成两个键：时间戳要被覆盖（只关心最近一次），
 * 计数要累加，塞进一个键就得自己解析拼接。两个键都走 purgeJourney 的
 * `l0:*:<journeyId>*` 通配，旅程清理时一起消失。
 */
export const readProactiveCount = async (journeyId: string): Promise<number> => {
  const raw = await redis.get(proactiveCountKey(journeyId))
  return raw === null ? 0 : Number(raw)
}

export const readLastProactiveSpoke = async (journeyId: string): Promise<Date | null> => {
  const raw = await redis.get(proactiveKey(journeyId))
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

/** 上一条用过的垫音，用来避免同一句话连着出现两次 */
const fillerKey = (journeyId: string): string => `l0:filler:${journeyId}`

export const recordFiller = async (journeyId: string, fillerId: string): Promise<void> => {
  await redis.set(fillerKey(journeyId), fillerId, 'EX', TTL_SEC)
}

export const readLastFiller = async (journeyId: string): Promise<string | null> =>
  redis.get(fillerKey(journeyId))

export const purgeJourney = async (journeyId: string): Promise<void> => {
  const keys = await redis.keys(`l0:*:${journeyId}*`)
  if (keys.length > 0) await redis.del(...keys)
}
