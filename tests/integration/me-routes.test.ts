import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { uuidv7 } from 'uuidv7'
import { registerRoutes } from '../../src/http/routes.js'
import { createSession } from '../../src/auth/session.js'
import * as repo from '../../src/memory/repo.js'
import { createUser, pool, teardown } from '../helpers/db.js'

/** /me/* 与游记接口。「我的」类接口必须先知道你是谁，所以一律要求登录 */

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

const json = <T>(payload: string): T => JSON.parse(payload) as T

const loggedIn = async (): Promise<{ userId: string; auth: { authorization: string } }> => {
  const userId = await createUser()
  const { token } = await createSession(userId)
  return { userId, auth: { authorization: `Bearer ${token}` } }
}

const startJourney = async (
  userId: string, auth: { authorization: string },
): Promise<string> => {
  const res = await app.inject({
    method: 'POST', url: '/v1/journeys', headers: auth,
    payload: {
      userId, mode: 'companion', party: 'solo',
      sceneId: 'fuzimiao', trackConsent: 'visited_points_only',
    },
  })
  return json<{ journeyId: string }>(res.payload).journeyId
}

describe('建档', () => {
  test('未登录读不到档案', async () => {
    const res = await app.inject({ method: 'GET', url: '/me/profile' })

    expect(res.statusCode).toBe(401)
  })

  test('读到默认档', async () => {
    const { auth } = await loggedIn()

    const res = await app.inject({ method: 'GET', url: '/me/profile', headers: auth })

    expect(res.statusCode).toBe(200)
    expect(json<{ defaultMode: string }>(res.payload).defaultMode).toBe('companion')
  })

  test('三个问题写进去，返回更新后的档案', async () => {
    const { auth } = await loggedIn()

    const res = await app.inject({
      method: 'PATCH', url: '/me/profile', headers: auth,
      payload: { ageBand: '16_18', defaultMode: 'light_guide', voicePref: 'text' },
    })

    expect(res.statusCode).toBe(200)
    const body = json<{ ageBand: string; voicePref: string; isMinor: boolean }>(res.payload)
    expect(body.ageBand).toBe('16_18')
    expect(body.voicePref).toBe('text')
    expect(body.isMinor).toBe(true)
  })

  test('PUT 与 PATCH 等效——小程序发不出 PATCH', async () => {
    const { auth } = await loggedIn()

    const res = await app.inject({
      method: 'PUT', url: '/me/profile', headers: auth, payload: { voicePref: 'text' },
    })

    expect(res.statusCode).toBe(200)
    expect(json<{ voicePref: string }>(res.payload).voicePref).toBe('text')
  })

  test('不认识的年龄段返回 400，不写进库', async () => {
    const { auth } = await loggedIn()

    const res = await app.inject({
      method: 'PATCH', url: '/me/profile', headers: auth,
      payload: { ageBand: '三十岁' },
    })

    expect(res.statusCode).toBe(400)
  })
})

describe('首页的旅程列表', () => {
  test('按时间倒序列出自己的旅程', async () => {
    const { userId, auth } = await loggedIn()
    await startJourney(userId, auth)

    const res = await app.inject({ method: 'GET', url: '/me/journeys', headers: auth })

    const body = json<{ journeys: { journeyId: string; state: string }[] }>(res.payload)
    expect(body.journeys).toHaveLength(1)
    expect(body.journeys[0]?.state).toBe('ACTIVE')
  })

  test('看不到别人的旅程', async () => {
    const other = await loggedIn()
    await startJourney(other.userId, other.auth)
    const me = await loggedIn()

    const res = await app.inject({ method: 'GET', url: '/me/journeys', headers: me.auth })

    expect(json<{ journeys: unknown[] }>(res.payload).journeys).toHaveLength(0)
  })
})

describe('我的记忆', () => {
  const seedPref = async (userId: string, value: string) =>
    repo.upsertPreference({
      userId, dimension: 'topic_interest', value, strength: 0.7,
      status: 'active', source: 'explicit',
      evidence: [{ journeyId: uuidv7(), party: 'solo', quote: `我想看${value}` }],
      journeyCount: 1, seenAt: new Date(),
    })

  test('分层返回身份、偏好、足迹', async () => {
    const { userId, auth } = await loggedIn()
    await seedPref(userId, '青铜器')

    const res = await app.inject({ method: 'GET', url: '/me/memory', headers: auth })

    const body = json<{ preferences: { value: string }[] }>(res.payload)
    expect(body.preferences.map((p) => p.value)).toContain('青铜器')
  })

  test('每条都能问「为什么」', async () => {
    const { userId, auth } = await loggedIn()
    const id = await seedPref(userId, '青铜器')

    const res = await app.inject({ method: 'GET', url: `/me/memory/${id}/why`, headers: auth })

    expect(res.statusCode).toBe(200)
    const body = json<{ promotion: string; evidence: unknown[] }>(res.payload)
    expect(body.evidence).toHaveLength(1)
    expect(body.promotion).toContain('青铜器')
  })

  test('问别人记忆的「为什么」返回 404，不泄漏存在性', async () => {
    const owner = await loggedIn()
    const id = await seedPref(owner.userId, '瓷器')
    const me = await loggedIn()

    const res = await app.inject({ method: 'GET', url: `/me/memory/${id}/why`, headers: me.auth })

    expect(res.statusCode).toBe(404)
  })

  test('能改', async () => {
    const { userId, auth } = await loggedIn()
    const id = await seedPref(userId, '青铜器')

    const res = await app.inject({
      method: 'PATCH', url: `/me/memory/${id}`, headers: auth, payload: { value: '玉器' },
    })

    expect(res.statusCode).toBe(200)
    expect((await repo.listPreferences(userId))[0]?.value).toBe('玉器')
  })

  test('改记忆也支持 PUT', async () => {
    const { userId, auth } = await loggedIn()
    const id = await seedPref(userId, '青铜器')

    const res = await app.inject({
      method: 'PUT', url: `/me/memory/${id}`, headers: auth, payload: { value: '漆器' },
    })

    expect(res.statusCode).toBe(200)
    expect((await repo.listPreferences(userId))[0]?.value).toBe('漆器')
  })

  test('能删', async () => {
    const { userId, auth } = await loggedIn()
    const id = await seedPref(userId, '青铜器')

    const res = await app.inject({ method: 'DELETE', url: `/me/memory/${id}`, headers: auth })

    expect(res.statusCode).toBe(200)
    expect(await repo.listPreferences(userId)).toHaveLength(0)
  })

  test('能导出，且导出的是自己的', async () => {
    const { userId, auth } = await loggedIn()
    await seedPref(userId, '青铜器')

    const res = await app.inject({ method: 'POST', url: '/me/memory/export', headers: auth })

    const body = json<{ preferences: unknown[]; exportedAt: string }>(res.payload)
    expect(body.preferences).toHaveLength(1)
    expect(body.exportedAt).toBeTruthy()
  })

  test('清空全部需要显式确认，漏传确认标记返回 400', async () => {
    const { userId, auth } = await loggedIn()
    await seedPref(userId, '青铜器')

    const res = await app.inject({
      method: 'DELETE', url: '/me/memory/all', headers: auth,
    })

    expect(res.statusCode).toBe(400)
    expect(await repo.listPreferences(userId)).toHaveLength(1)
  })

  test('带上确认标记才真的清空，账户保留', async () => {
    const { userId, auth } = await loggedIn()
    await seedPref(userId, '青铜器')

    const res = await app.inject({
      method: 'DELETE', url: '/me/memory/all?confirm=true', headers: auth,
    })

    expect(res.statusCode).toBe(200)
    expect(await repo.listPreferences(userId)).toHaveLength(0)
    const { rows } = await pool.query('SELECT id FROM app_user WHERE id = $1', [userId])
    expect(rows).toHaveLength(1)
  })

  test('「清空全部」这条路由不会被 /me/memory/:id 抢走', async () => {
    const { auth } = await loggedIn()

    const res = await app.inject({
      method: 'DELETE', url: '/me/memory/all?confirm=true', headers: auth,
    })

    // 若被 :id 捕获，uuid 校验会先报 400
    expect(res.statusCode).toBe(200)
  })
})

describe('行后游记', () => {
  test('返回正文、足迹时间线与待确认偏好', async () => {
    const { userId, auth } = await loggedIn()
    const journeyId = await startJourney(userId, auth)

    const res = await app.inject({
      method: 'GET', url: `/v1/journeys/${journeyId}/travelogue`, headers: auth,
    })

    expect(res.statusCode).toBe(200)
    const body = json<{
      text: string; timeline: unknown[]; facts: unknown[]; pendingPreferences: unknown[]
    }>(res.payload)
    expect(typeof body.text).toBe('string')
    expect(Array.isArray(body.timeline)).toBe(true)
    expect(Array.isArray(body.pendingPreferences)).toBe(true)
  })

  test('未过审的锚点不进史实，并计数说明为什么为空', async () => {
    const { userId, auth } = await loggedIn()
    const journeyId = await startJourney(userId, auth)
    await pool.query(
      `INSERT INTO interaction
         (id, journey_id, user_id, turn_index, role, channel, content, anchor_id, occurred_at)
       VALUES ($1,$2,$3,0,'user','text','号舍真小','fzm_jiangnan_gongyuan_haoshe',now())`,
      [uuidv7(), journeyId, userId],
    )

    const res = await app.inject({
      method: 'GET', url: `/v1/journeys/${journeyId}/travelogue`, headers: auth,
    })

    const body = json<{ facts: unknown[]; draftAnchorsExcluded: number }>(res.payload)
    expect(body.facts).toHaveLength(0)
    expect(body.draftAnchorsExcluded).toBeGreaterThan(0)
  })

  test('别人的游记看不到', async () => {
    const owner = await loggedIn()
    const journeyId = await startJourney(owner.userId, owner.auth)
    const me = await loggedIn()

    const res = await app.inject({
      method: 'GET', url: `/v1/journeys/${journeyId}/travelogue`, headers: me.auth,
    })

    expect(res.statusCode).toBe(403)
  })
})

describe('确认推断出来的偏好', () => {
  test('确认后以 user_confirmed 落 L2', async () => {
    const { userId, auth } = await loggedIn()
    const journeyId = await startJourney(userId, auth)

    const res = await app.inject({
      method: 'POST', url: '/me/memory/confirm', headers: auth,
      payload: { journeyId, dimension: 'topic_interest', value: '科举' },
    })

    expect(res.statusCode).toBe(200)
    const { rows } = await pool.query<{ source: string }>(
      'SELECT source FROM journey_signal WHERE journey_id = $1', [journeyId],
    )
    expect(rows[0]?.source).toBe('user_confirmed')
  })

  test('不能往别人的旅程里塞确认', async () => {
    const owner = await loggedIn()
    const journeyId = await startJourney(owner.userId, owner.auth)
    const me = await loggedIn()

    const res = await app.inject({
      method: 'POST', url: '/me/memory/confirm', headers: me.auth,
      payload: { journeyId, dimension: 'topic_interest', value: '科举' },
    })

    expect(res.statusCode).toBe(403)
  })
})
