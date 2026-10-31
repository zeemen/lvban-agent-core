import { ZodError } from 'zod'
import { ModelError } from '../models/errors.js'

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

  /*
   * 调用方交上来的输入用不了（读不到图、图超过上限）。
   *
   * 只认 invalid_input 这一种：ModelError 的 bad_request 多半是模型名或 Key
   * 配错，那是我们自己的毛病，回 400 会把小程序的排查方向指错。
   * message 是我们自己写的提示，不含内部路径或 SQL，所以可以回传。
   */
  if (error instanceof ModelError && error.kind === 'invalid_input') {
    return { status: 400, body: { error: 'bad_request', message: error.message } }
  }

  // 自家错误（鉴权、微信登录、配置缺失）自带状态码，message 是写给调用方看的
  const own = httpStatusOf(error)
  if (own !== undefined) {
    /*
     * 503 才是「依赖不可用」；500 是我们自己的问题（例如配置填错），
     * 贴成 dependency_unavailable 会把排查方向指向外部系统。
     * 400 和 zod 校验失败、图片读不到是同一类——负载写错了，统一标 bad_request，
     * 不然同样是「客户端传错了」，三条路由回三种标签。
     * 其余 4xx（401/403/404）是身份或资源问题，不是负载写错。
     */
    const label = own === 503 ? 'dependency_unavailable'
      : own >= 500 ? 'internal_error'
        : own === 400 ? 'bad_request' : 'error'
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
