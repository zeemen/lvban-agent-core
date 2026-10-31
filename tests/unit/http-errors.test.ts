import { describe, expect, test } from 'vitest'
import { z } from 'zod'
import { classifyError } from '../../src/http/errors.js'
import { ModelError } from '../../src/models/errors.js'

/** 错误分类 —— 客户端负载写错和依赖挂掉必须和「服务端自己崩了」区分开，
 *  否则小程序联调时只能看到一个没有上下文的 500（这是真踩过的坑）。 */

const zodError = (): z.ZodError => {
  const result = z.object({ openid: z.string() }).safeParse({})
  if (result.success) throw new Error('测试前提失效：这个负载本该校验失败')
  return result.error
}

describe('classifyError', () => {
  test('zod 校验失败是客户端问题，返回 400 并带上具体字段', () => {
    const { status, body } = classifyError(zodError())

    expect(status).toBe(400)
    expect(body.error).toBe('bad_request')
    expect(JSON.stringify(body.issues)).toContain('openid')
  })

  test('连接被拒说明依赖没起来，返回 503 而不是 500', () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:55432'), {
      code: 'ECONNREFUSED',
    })

    const { status, body } = classifyError(refused)

    expect(status).toBe(503)
    expect(body.error).toBe('dependency_unavailable')
  })

  test('ioredis 的 Connection is closed 同样算依赖不可用', () => {
    const { status } = classifyError(new Error('Connection is closed.'))

    expect(status).toBe(503)
  })

  test('Fastify 自带的 statusCode 要保留，不能被吞成 500', () => {
    const notFound = Object.assign(new Error('Route not found'), { statusCode: 404 })

    expect(classifyError(notFound).status).toBe(404)
  })

  test('自带 503 的错误标为 dependency_unavailable', () => {
    const down = Object.assign(new Error('微信登录未配置'), { httpStatus: 503 })

    const { status, body } = classifyError(down)

    expect(status).toBe(503)
    expect(body.error).toBe('dependency_unavailable')
    expect(body.message).toContain('微信登录未配置')
  })

  test('自带 500 的错误标为 internal_error，不冒充依赖故障', () => {
    const misconfigured = Object.assign(new Error('errcode 40013：检查 WX_APPID'), {
      httpStatus: 500,
    })

    const { status, body } = classifyError(misconfigured)

    expect(status).toBe(500)
    expect(body.error).toBe('internal_error')
    expect(body.message).toContain('WX_APPID')
  })

  test('调用方给的输入用不了时返回 400，并说清该改哪一边', () => {
    const unreadable = new ModelError({
      kind: 'invalid_input', provider: 'openai-compatible',
      message: '读不到图片：probe.jpg（imageKey 需为 http(s) URL、data URI 或本地文件路径）',
    })

    const { status, body } = classifyError(unreadable)

    expect(status).toBe(400)
    expect(body.error).toBe('bad_request')
    expect(body.message).toContain('imageKey')
  })

  test('模型/配置自己的毛病仍是 500，不冒充客户端错误', () => {
    const misconfigured = new ModelError({
      kind: 'bad_request', provider: 'deepseek',
      message: 'MODEL_ID_VISION 未配置。南博「拍一下」依赖视觉',
    })

    const { status, body } = classifyError(misconfigured)

    expect(status).toBe(500)
    expect(body.error).toBe('internal_error')
    expect(JSON.stringify(body)).not.toContain('MODEL_ID_VISION')
  })

  test('其余错误才是 500，且不把内部信息透给客户端', () => {
    const { status, body } = classifyError(new Error('某个内部断言炸了：/Users/zeemenzhou/secret'))

    expect(status).toBe(500)
    expect(body.error).toBe('internal_error')
    expect(JSON.stringify(body)).not.toContain('secret')
  })
})
