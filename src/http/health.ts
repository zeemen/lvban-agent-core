import { pool } from '../db/pool.js'
import { redis } from '../db/redis.js'

/** 依赖探活 —— 容器停掉时 /health 必须跟着红，否则只能从业务接口的 500 倒推。 */

const PROBE_TIMEOUT_MS = 2000

export type DependencyStatus = { ok: true } | { ok: false; error: string }

export type HealthReport = {
  ok: boolean
  deps: { postgres: DependencyStatus; redis: DependencyStatus }
}

/** ioredis 连不上时会按重试策略挂着，不自己加超时的话 /health 会跟着卡住 */
export const probe = async (label: string, run: () => Promise<unknown>): Promise<DependencyStatus> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      run(),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => { reject(new Error(`${label} 探活超时 ${PROBE_TIMEOUT_MS}ms`)) }, PROBE_TIMEOUT_MS)
      }),
    ])
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export const checkDependencies = async (): Promise<HealthReport> => {
  const [postgres, redisStatus] = await Promise.all([
    probe('postgres', () => pool.query('SELECT 1')),
    probe('redis', () => redis.ping()),
  ])
  return { ok: postgres.ok && redisStatus.ok, deps: { postgres, redis: redisStatus } }
}
