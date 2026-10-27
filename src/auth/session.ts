import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { redis } from '../db/redis.js'

/**
 * 会话令牌。
 *
 * 为什么要这一层：登录之后客户端必须拿「不可伪造的凭证」说话。
 * 如果继续靠请求体里的 userId 表明身份，那任何人填别人的 UUID 就能
 * 读到别人的记忆——对一个主打青少年记忆与未成年人保护的产品，这是红线。
 *
 * 存的是令牌的 SHA-256 而不是令牌本身：Redis 被读走时，拿到哈希无法
 * 直接冒用（和密码不落明文是同一个道理，令牌本身熵足够，不需要加盐慢哈希）。
 */

const PREFIX = 'session:'
const TOKEN_BYTES = 32
/** 30 天。每次访问滑动续期，活跃用户不会被动退出 */
const TTL_SECONDS = 30 * 24 * 60 * 60

const keyOf = (token: string): string =>
  `${PREFIX}${createHash('sha256').update(token).digest('hex')}`

export type IssuedSession = {
  readonly token: string
  readonly expiresInSeconds: number
}

export const createSession = async (userId: string): Promise<IssuedSession> => {
  const token = randomBytes(TOKEN_BYTES).toString('base64url')
  await redis.set(keyOf(token), userId, 'EX', TTL_SECONDS)
  return { token, expiresInSeconds: TTL_SECONDS }
}

/** 解析并滑动续期。未知或过期令牌返回 null，由调用方决定回 401 还是放行 */
export const resolveSession = async (token: string): Promise<string | null> => {
  if (token === '') return null
  const key = keyOf(token)
  const userId = await redis.get(key)
  if (userId === null) return null
  await redis.expire(key, TTL_SECONDS)
  return userId
}

export const revokeSession = async (token: string): Promise<void> => {
  if (token === '') return
  await redis.del(keyOf(token))
}

/**
 * 从 Authorization 头里取 Bearer 令牌。用定长比较判断前缀，
 * 避免大小写与多余空格带来的解析分歧。
 */
export const bearerToken = (header: string | undefined): string => {
  if (header === undefined) return ''
  const [scheme, ...rest] = header.trim().split(/\s+/)
  if (scheme === undefined || rest.length === 0) return ''
  const expected = Buffer.from('bearer')
  const actual = Buffer.from(scheme.toLowerCase())
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return ''
  return rest.join('')
}
