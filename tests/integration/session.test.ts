import { afterAll, describe, expect, test } from 'vitest'
import { createSession, resolveSession, revokeSession } from '../../src/auth/session.js'
import { createUser, redis, teardown } from '../helpers/db.js'

/** 会话令牌 —— 跑真实 Redis，令牌存活与过期这类行为用假实现测不出可信度 */

afterAll(async () => { await teardown() })

describe('签发与解析', () => {
  test('签发的令牌能解回同一个 userId', async () => {
    const userId = await createUser()

    const { token } = await createSession(userId)

    expect(await resolveSession(token)).toBe(userId)
  })

  test('两次签发得到不同令牌', async () => {
    const userId = await createUser()

    const a = await createSession(userId)
    const b = await createSession(userId)

    expect(a.token).not.toBe(b.token)
  })

  test('令牌足够长，不可枚举', async () => {
    const { token } = await createSession(await createUser())

    expect(token.length).toBeGreaterThanOrEqual(32)
  })

  test('未知令牌解析为 null，而不是抛错', async () => {
    expect(await resolveSession('not-a-real-token')).toBeNull()
  })

  test('空令牌解析为 null', async () => {
    expect(await resolveSession('')).toBeNull()
  })
})

describe('存储形态', () => {
  test('Redis 里存的是令牌哈希而不是令牌本身——库被读走也不能直接冒用', async () => {
    const userId = await createUser()

    const { token } = await createSession(userId)

    const keys = await redis.keys('session:*')
    expect(keys.length).toBeGreaterThan(0)
    expect(keys.some((key) => key.includes(token))).toBe(false)
  })

  test('令牌带过期时间，不会永久有效', async () => {
    const { token } = await createSession(await createUser())

    const keys = await redis.keys('session:*')
    const ttls = await Promise.all(keys.map(async (key) => redis.ttl(key)))
    expect(ttls.some((ttl) => ttl > 0)).toBe(true)
    expect(await resolveSession(token)).not.toBeNull()
  })
})

describe('吊销', () => {
  test('吊销后立即失效', async () => {
    const { token } = await createSession(await createUser())

    await revokeSession(token)

    expect(await resolveSession(token)).toBeNull()
  })

  test('吊销不存在的令牌不报错', async () => {
    await expect(revokeSession('nope')).resolves.toBeUndefined()
  })
})
