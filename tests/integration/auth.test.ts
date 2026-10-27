import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { registerRoutes } from '../../src/http/routes.js'
import { createUser, teardown } from '../helpers/db.js'

/** 微信登录与会话鉴权（PRD U01：仅取 openid，未授权可浏览不可开旅程） */

let app: FastifyInstance

beforeAll(async () => {
  app = Fastify()
  registerRoutes(app)
  await app.ready()
})

afterAll(async () => {
  await app.close()
  await teardown()
})

beforeEach(() => {
  process.env.WX_APPID = 'wx_test_appid'
  process.env.WX_APPSECRET = 'test-secret'
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.WX_APPID
  delete process.env.WX_APPSECRET
  delete process.env.AUTH_REQUIRED
})

const json = <T>(payload: string): T => JSON.parse(payload) as T

const stubWx = (body: unknown): void => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body),
  }))
}

const login = async (openid: string): Promise<{ userId: string; token: string; isNew: boolean }> => {
  stubWx({ openid, session_key: 'sk' })
  const res = await app.inject({ method: 'POST', url: '/v1/auth/wx-login', payload: { code: 'c' } })
  expect(res.statusCode).toBe(200)
  return json(res.payload)
}

describe('POST /v1/auth/wx-login', () => {
  test('用 code 换到 openid 后建账号，返回 userId 与会话令牌', async () => {
    const body = await login(`o_new_${Date.now()}`)

    expect(body.userId).toMatch(/^[0-9a-f-]{36}$/)
    expect(body.token.length).toBeGreaterThanOrEqual(32)
    expect(body.isNew).toBe(true)
  })

  test('同一 openid 再次登录复用账号，并换发新令牌', async () => {
    const openid = `o_repeat_${Date.now()}`

    const first = await login(openid)
    const second = await login(openid)

    expect(second.userId).toBe(first.userId)
    expect(second.isNew).toBe(false)
    expect(second.token).not.toBe(first.token)
  })

  test('不下发 session_key，响应里不含任何微信凭证', async () => {
    const body = await login(`o_nokey_${Date.now()}`)

    expect(JSON.stringify(body)).not.toContain('session_key')
    expect(JSON.stringify(body)).not.toContain('sk')
  })

  test('code 失效返回 401，客户端据此重新 wx.login', async () => {
    stubWx({ errcode: 40029, errmsg: 'invalid code' })

    const res = await app.inject({
      method: 'POST', url: '/v1/auth/wx-login', payload: { code: 'stale' },
    })

    expect(res.statusCode).toBe(401)
  })

  test('微信侧繁忙返回 503 而不是 500', async () => {
    stubWx({ errcode: -1, errmsg: 'system error' })

    const res = await app.inject({
      method: 'POST', url: '/v1/auth/wx-login', payload: { code: 'c' },
    })

    expect(res.statusCode).toBe(503)
  })

  test('没配 appsecret 时明确回 503 并说明缺什么，而不是拿空密钥去打微信', async () => {
    delete process.env.WX_APPSECRET

    const res = await app.inject({
      method: 'POST', url: '/v1/auth/wx-login', payload: { code: 'c' },
    })

    expect(res.statusCode).toBe(503)
    expect(res.payload).toContain('WX_APPSECRET')
  })

  test('缺 code 返回 400', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/auth/wx-login', payload: {} })

    expect(res.statusCode).toBe(400)
  })
})

describe('会话令牌的作用范围', () => {
  test('带令牌可以读自己的记忆', async () => {
    const me = await login(`o_self_${Date.now()}`)

    const res = await app.inject({
      method: 'GET', url: `/me/${me.userId}/memory`,
      headers: { authorization: `Bearer ${me.token}` },
    })

    expect(res.statusCode).toBe(200)
  })

  test('拿自己的令牌读别人的记忆被拒——这是本层存在的理由', async () => {
    const me = await login(`o_a_${Date.now()}`)
    const other = await createUser()

    const res = await app.inject({
      method: 'GET', url: `/me/${other}/memory`,
      headers: { authorization: `Bearer ${me.token}` },
    })

    expect(res.statusCode).toBe(403)
  })

  test('无效令牌返回 401', async () => {
    const res = await app.inject({
      method: 'GET', url: `/me/${await createUser()}/memory`,
      headers: { authorization: 'Bearer forged-token' },
    })

    expect(res.statusCode).toBe(401)
  })

  test('开旅程时身份以令牌为准，请求体里填别人的 userId 会被拒', async () => {
    const me = await login(`o_b_${Date.now()}`)
    const other = await createUser()

    const res = await app.inject({
      method: 'POST', url: '/v1/journeys',
      headers: { authorization: `Bearer ${me.token}` },
      payload: {
        userId: other, mode: 'companion', party: 'solo',
        sceneId: 'fuzimiao', trackConsent: 'visited_points_only',
      },
    })

    expect(res.statusCode).toBe(403)
  })

  test('别人的旅程不能被结束', async () => {
    const owner = await login(`o_owner_${Date.now()}`)
    const started = await app.inject({
      method: 'POST', url: '/v1/journeys',
      headers: { authorization: `Bearer ${owner.token}` },
      payload: {
        userId: owner.userId, mode: 'companion', party: 'solo',
        sceneId: 'fuzimiao', trackConsent: 'visited_points_only',
      },
    })
    const { journeyId } = json<{ journeyId: string }>(started.payload)
    const intruder = await login(`o_intruder_${Date.now()}`)

    const res = await app.inject({
      method: 'POST', url: `/v1/journeys/${journeyId}/end`,
      headers: { authorization: `Bearer ${intruder.token}` },
    })

    expect(res.statusCode).toBe(403)
  })
})

describe('AUTH_REQUIRED 开关', () => {
  test('显式设 false 可以压过「配了密钥就强制鉴权」的默认值', async () => {
    process.env.AUTH_REQUIRED = 'false'

    const res = await app.inject({
      method: 'POST', url: '/v1/journeys',
      payload: {
        userId: await createUser(), mode: 'companion', party: 'solo',
        sceneId: 'fuzimiao', trackConsent: 'visited_points_only',
      },
    })

    expect(res.statusCode).toBe(201)
  })

  test('开启后，未带令牌不能开旅程（PRD U01：未授权可浏览不可开旅程）', async () => {
    process.env.AUTH_REQUIRED = 'true'

    const res = await app.inject({
      method: 'POST', url: '/v1/journeys',
      payload: {
        userId: await createUser(), mode: 'companion', party: 'solo',
        sceneId: 'fuzimiao', trackConsent: 'visited_points_only',
      },
    })

    expect(res.statusCode).toBe(401)
  })

  test('开启后，开发建用户接口关闭——它是无鉴权造身份的后门', async () => {
    process.env.AUTH_REQUIRED = 'true'

    const res = await app.inject({
      method: 'POST', url: '/v1/dev/users', payload: { openid: 'backdoor' },
    })

    expect(res.statusCode).toBe(404)
  })

  test('没配 WX_APPSECRET 时默认关闭，不带令牌也能开旅程（本地联调）', async () => {
    delete process.env.WX_APPSECRET

    const res = await app.inject({
      method: 'POST', url: '/v1/journeys',
      payload: {
        userId: await createUser(), mode: 'companion', party: 'solo',
        sceneId: 'fuzimiao', trackConsent: 'visited_points_only',
      },
    })

    expect(res.statusCode).toBe(201)
  })
})
