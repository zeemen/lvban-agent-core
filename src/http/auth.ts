import type { FastifyInstance, FastifyRequest } from 'fastify'
import { bearerToken, resolveSession } from '../auth/session.js'
import { isAuthRequired } from '../auth/policy.js'
import { pool } from '../db/pool.js'

/**
 * 请求级身份解析与越权拦截。
 *
 * 分成「解析」和「要求」两步：解析在钩子里对所有请求做一次，
 * 要不要强制由每条路由自己决定——PRD U01 允许未授权浏览，
 * 只是不能开旅程，所以不能一刀切地全局 401。
 */

declare module 'fastify' {
  interface FastifyRequest {
    /** 已登录时为会话对应的 userId；未带令牌或令牌无效时为 null */
    sessionUserId: string | null
    /** 带了令牌但解不出会话——和「压根没带令牌」要分开，前者回 401 */
    tokenRejected: boolean
  }
}

export class AuthError extends Error {
  readonly httpStatus: number
  constructor(httpStatus: number, message: string) {
    super(message)
    this.name = 'AuthError'
    this.httpStatus = httpStatus
  }
}

export const registerAuthHook = (app: FastifyInstance): void => {
  app.decorateRequest('sessionUserId', null)
  app.decorateRequest('tokenRejected', false)

  app.addHook('preHandler', async (request) => {
    const token = bearerToken(request.headers.authorization)
    if (token === '') return
    const userId = await resolveSession(token)
    if (userId === null) { request.tokenRejected = true; return }
    request.sessionUserId = userId
  })
}

/**
 * 取当前身份。带了无效令牌一律 401；没带令牌时按开关决定是放行还是 401。
 * 返回 null 表示「允许匿名且当前匿名」。
 */
export const currentUser = (request: FastifyRequest): string | null => {
  if (request.tokenRejected) {
    throw new AuthError(401, '登录态无效或已过期，请重新登录')
  }
  if (request.sessionUserId !== null) return request.sessionUserId
  if (isAuthRequired()) {
    throw new AuthError(401, '需要登录：请先调用 /v1/auth/wx-login')
  }
  return null
}

/**
 * 要求必须已登录。/me/* 这类「我的」接口用它：
 * 不知道你是谁就无从谈起「我的记忆」，匿名在这里没有合理语义。
 */
export const requireLogin = (request: FastifyRequest): string => {
  const session = currentUser(request)
  if (session === null) {
    throw new AuthError(401, '需要登录：请先调用 /v1/auth/wx-login')
  }
  return session
}

/** 要求必须是本人。claimed 为空时直接用会话身份 */
export const requireSelf = (request: FastifyRequest, claimed: string | null): string => {
  const session = currentUser(request)
  if (session === null) {
    if (claimed === null) {
      throw new AuthError(401, '需要登录：请先调用 /v1/auth/wx-login')
    }
    return claimed
  }
  if (claimed !== null && claimed !== session) {
    throw new AuthError(403, '身份不符：只能操作自己的数据')
  }
  return session
}

/**
 * 旅程归属校验。匿名放行是为了保住本地联调；一旦带了会话，
 * 就必须是自己的旅程——否则拿到一个 journeyId 就能驱动别人的行程。
 */
export const requireJourneyOwner = async (
  request: FastifyRequest, journeyId: string,
): Promise<void> => {
  const session = currentUser(request)
  if (session === null) return

  const { rows } = await pool.query<{ user_id: string }>(
    'SELECT user_id FROM journey WHERE id = $1', [journeyId],
  )
  const owner = rows[0]?.user_id
  if (owner === undefined) return      // 不存在交给业务层报，不在这里泄漏存在性
  if (owner !== session) {
    throw new AuthError(403, '这不是你的旅程')
  }
}
