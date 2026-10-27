import { ZodError } from 'zod'

/** 错误分类 —— 把「客户端发错了」「依赖没起来」「服务端自己崩了」分开，
 *  小程序联调时能直接从状态码判断该改哪一边。 */

export type ErrorBody = {
  error: 'bad_request' | 'dependency_unavailable' | 'internal_error' | 'error'
  message?: string
  issues?: unknown
}

export type Classified = { status: number; body: ErrorBody }

/** 连接类故障的判定依据。pg 与 ioredis 底层都是 node:net，拿得到这几个 errno；
 *  ioredis 在重试耗尽后另给一条文案，没有 code 可认。 */
const CONNECTION_ERRNOS = new Set(['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'EHOSTUNREACH'])
const CONNECTION_MESSAGES = ['Connection is closed', "Stream isn't writeable"]

const errnoOf = (error: unknown): string | undefined => {
  if (typeof error !== 'object' || error === null) return undefined
  const { code } = error as { code?: unknown }
  return typeof code === 'string' ? code : undefined
}

const statusCodeOf = (error: unknown): number | undefined => {
  if (typeof error !== 'object' || error === null) return undefined
  const { statusCode } = error as { statusCode?: unknown }
  return typeof statusCode === 'number' ? statusCode : undefined
}

const isDependencyDown = (error: unknown): boolean => {
  const errno = errnoOf(error)
  if (errno !== undefined && CONNECTION_ERRNOS.has(errno)) return true
  const message = error instanceof Error ? error.message : ''
  return CONNECTION_MESSAGES.some((hint) => message.includes(hint))
}

const httpStatusOf = (error: unknown): number | undefined => {
  if (typeof error !== 'object' || error === null) return undefined
  const { httpStatus } = error as { httpStatus?: unknown }
  return typeof httpStatus === 'number' ? httpStatus : undefined
}

export const classifyError = (error: unknown): Classified => {
  if (error instanceof ZodError) {
    return { status: 400, body: { error: 'bad_request', issues: error.issues } }
  }

  // 自家错误（鉴权、微信登录、配置缺失）自带状态码，message 是写给调用方看的
  const own = httpStatusOf(error)
  if (own !== undefined) {
    // 503 才是「依赖不可用」；500 是我们自己的问题（例如配置填错），
    // 贴成 dependency_unavailable 会把排查方向指向外部系统
    const label = own === 503 ? 'dependency_unavailable' : own >= 500 ? 'internal_error' : 'error'
    return { status: own, body: { error: label, message: (error as Error).message } }
  }

  if (isDependencyDown(error)) {
    // 这条 message 是连接目标，不含业务数据，留着能直接看出是哪个依赖
    const message = error instanceof Error ? error.message : '依赖不可用'
    return { status: 503, body: { error: 'dependency_unavailable', message } }
  }

  // Fastify 自己抛的错（404、415、负载过大等）已经带好了状态码
  const statusCode = statusCodeOf(error)
  if (statusCode !== undefined && statusCode >= 400 && statusCode < 500) {
    const message = error instanceof Error ? error.message : undefined
    return { status: statusCode, body: { error: 'error', message } }
  }

  // 兜底不回传 message：内部错误可能夹带路径、SQL 片段
  return { status: 500, body: { error: 'internal_error' } }
}
