import { uuidv7 } from 'uuidv7'
import { closePool, pool } from '../../src/db/pool.js'
import { closeRedis, redis } from '../../src/db/redis.js'

/** 集成测试辅助：每个用例用独立用户，避免互相污染记忆 */

export const createUser = async (patch: {
  readonly ageBand?: string
  readonly guardianUserId?: string | null
} = {}): Promise<string> => {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO app_user (id, wx_openid, nickname, age_band, guardian_user_id)
     VALUES ($1, $2, '测试', $3, $4) RETURNING id`,
    [uuidv7(), `test_${uuidv7()}`, patch.ageBand ?? '19_24', patch.guardianUserId ?? null],
  )
  const id = rows[0]?.id
  if (id === undefined) throw new Error('创建测试用户失败')
  return id
}

export const countRows = async (
  table: string, where: string, params: readonly unknown[],
): Promise<number> => {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM ${table} WHERE ${where}`, [...params],
  )
  return Number(rows[0]?.n ?? 0)
}

export const teardown = async (): Promise<void> => {
  await closePool()
  await closeRedis()
}

export { pool, redis }
