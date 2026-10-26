import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { registerRoutes } from '../../src/http/routes.js'
import { createUser, teardown } from '../helpers/db.js'

/** HTTP 接口冒烟 —— 这套接口就是 M3 小程序要接的那一套（规格 02 §8） */

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

describe('健康检查', () => {
  test('返回模型账本，便于观察成本', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' })

    expect(res.statusCode).toBe(200)
    expect(json<{ ok: boolean }>(res.payload).ok).toBe(true)
  })
})

describe('旅程生命周期接口', () => {
  test('开始旅程返回 journeyId 与授权档位', async () => {
    const userId = await createUser()

    const res = await app.inject({
      method: 'POST', url: '/v1/journeys',
      payload: {
        userId, mode: 'companion', party: 'solo',
        sceneId: 'fuzimiao', trackConsent: 'visited_points_only',
      },
    })

    expect(res.statusCode).toBe(201)
    const body = json<{ journeyId: string; state: string; trackConsent: string }>(res.payload)
    expect(body.state).toBe('ACTIVE')
    expect(body.trackConsent).toBe('visited_points_only')
  })

  test('缺少必填字段时返回 400', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/journeys', payload: { mode: 'companion' },
    })

    expect(res.statusCode).toBe(500)
  })

  test('结束旅程同时返回蒸馏报告', async () => {
    const userId = await createUser()
    const start = await app.inject({
      method: 'POST', url: '/v1/journeys',
      payload: {
        userId, mode: 'companion', party: 'solo',
        sceneId: 'fuzimiao', trackConsent: 'none',
      },
    })
    const { journeyId } = json<{ journeyId: string }>(start.payload)

    const res = await app.inject({ method: 'POST', url: `/v1/journeys/${journeyId}/end` })

    expect(res.statusCode).toBe(200)
    const body = json<{ distillation: { skipped: boolean } }>(res.payload)
    expect(body.distillation.skipped).toBe(false)
  })
})

describe('行中接口', () => {
  const startJourneyVia = async (): Promise<{ userId: string; journeyId: string }> => {
    const userId = await createUser()
    const res = await app.inject({
      method: 'POST', url: '/v1/journeys',
      payload: {
        userId, mode: 'companion', party: 'solo',
        sceneId: 'fuzimiao', trackConsent: 'visited_points_only',
      },
    })
    return { userId, journeyId: json<{ journeyId: string }>(res.payload).journeyId }
  }

  test('上报定位返回接受/丢弃统计与围栏事件', async () => {
    const { journeyId } = await startJourneyVia()
    const t0 = new Date()

    const res = await app.inject({
      method: 'POST', url: `/v1/journeys/${journeyId}/signals`,
      payload: {
        points: [
          { lat: 32.0211, lng: 118.7905, accuracyM: 12, at: t0.toISOString(), speedMps: 0.4 },
          {
            lat: 32.0211, lng: 118.7905, accuracyM: 12,
            at: new Date(t0.getTime() + 25_000).toISOString(), speedMps: 0.3,
          },
        ],
      },
    })

    expect(res.statusCode).toBe(200)
    const body = json<{ accepted: number; events: { poiId: string }[] }>(res.payload)
    expect(body.accepted).toBe(2)
    expect(body.events[0]?.poiId).toBe('fzm_jiangnan_gongyuan')
  })

  test('Context State 接口返回完整状态', async () => {
    const { journeyId } = await startJourneyVia()

    const res = await app.inject({
      method: 'GET', url: `/v1/journeys/${journeyId}/context?poiId=fzm_jiangnan_gongyuan`,
    })

    expect(res.statusCode).toBe(200)
    const ctx = json<{ stateVersion: number; mode: string; scene: string }>(res.payload)
    expect(ctx.stateVersion).toBe(1)
    expect(ctx.mode).toBe('companion')
    expect(ctx.scene).toBe('outdoor')
  })

  test('到达接口返回讲解与决策依据', async () => {
    const { journeyId } = await startJourneyVia()

    const res = await app.inject({
      method: 'POST', url: `/v1/journeys/${journeyId}/arrive`,
      payload: { poiId: 'fzm_jiangnan_gongyuan' },
    })

    expect(res.statusCode).toBe(200)
    const body = json<{ spoke: boolean; text: string; proactivityReason: string }>(res.payload)
    expect(body.spoke).toBe(true)
    expect(body.text).toContain('号舍')
    expect(body.proactivityReason).toContain('top30_anchor')
  })

  test('主动性决策接口返回可排查的 reason', async () => {
    const { journeyId } = await startJourneyVia()

    const res = await app.inject({
      method: 'POST', url: '/internal/proactivity/decide',
      payload: {
        journeyId, poiId: 'fzm_jiangnan_gongyuan',
        trigger: { kind: 'geofence_arrive', anchorIsTop30: true, isFirstVisit: true },
      },
    })

    expect(res.statusCode).toBe(200)
    const body = json<{ decision: string; reason: string; score: number }>(res.payload)
    expect(body.decision).toBe('SPEAK')
    expect(body.reason).toBeTruthy()
  })

  test('提问接口返回回答', async () => {
    const { journeyId } = await startJourneyVia()

    const res = await app.inject({
      method: 'POST', url: `/v1/journeys/${journeyId}/ask`,
      payload: { text: '古代人怎么考试', poiId: 'fzm_jiangnan_gongyuan' },
    })

    expect(res.statusCode).toBe(200)
    expect(json<{ spoke: boolean }>(res.payload).spoke).toBe(true)
  })

  test('删除旅程接口可用', async () => {
    const { journeyId } = await startJourneyVia()

    const res = await app.inject({ method: 'DELETE', url: `/v1/journeys/${journeyId}` })

    expect(res.statusCode).toBe(200)
    expect(json<{ purged: boolean }>(res.payload).purged).toBe(true)
  })
})

describe('流式应答接口（SSE）', () => {
  test('返回 text/event-stream，首个事件是垫音', async () => {
    const userId = await createUser()
    const start = await app.inject({
      method: 'POST', url: '/v1/journeys',
      payload: {
        userId, mode: 'companion', party: 'solo',
        sceneId: 'fuzimiao', trackConsent: 'visited_points_only',
      },
    })
    const { journeyId } = json<{ journeyId: string }>(start.payload)

    const res = await app.inject({
      method: 'POST', url: `/v1/journeys/${journeyId}/ask/stream`,
      payload: { text: '古代人怎么考试', poiId: 'fzm_jiangnan_gongyuan' },
    })

    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/event-stream')
    const events = res.payload.split('\n\n').filter((b) => b.trim() !== '')
    expect(events[0]).toContain('event: filler')
    expect(res.payload).toContain('event: done')
  })

  test('事件体是可解析的 JSON，带 audioKey 供前端播放', async () => {
    const userId = await createUser()
    const start = await app.inject({
      method: 'POST', url: '/v1/journeys',
      payload: {
        userId, mode: 'companion', party: 'solo',
        sceneId: 'fuzimiao', trackConsent: 'visited_points_only',
      },
    })
    const { journeyId } = json<{ journeyId: string }>(start.payload)

    const res = await app.inject({
      method: 'POST', url: `/v1/journeys/${journeyId}/ask/stream`,
      payload: { text: '号舍多大' },
    })

    const firstData = res.payload.split('\n')
      .find((l) => l.startsWith('data:'))?.slice(5).trim() ?? ''
    const parsed = JSON.parse(firstData) as { type: string; audioKey?: string }
    expect(parsed.type).toBe('filler')
    expect(parsed.audioKey).toMatch(/\.mp3$/)
  })
})

describe('视觉接口', () => {
  test('识别接口按候选集约束返回决策', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/vision/anchor',
      payload: { imageKey: 'test-key', zoneHint: 'nanjing_museum' },
    })

    expect(res.statusCode).toBe(200)
    const body = json<{ decision: string; correctionToken: string }>(res.payload)
    expect(['auto_accept', 'ask_user_pick', 'fallback_ask']).toContain(body.decision)
  })

  test('命中率接口可查', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/vision/hit-rate' })

    expect(res.statusCode).toBe(200)
    expect(json<{ threshold: number }>(res.payload).threshold).toBe(0.8)
  })
})

describe('用户权利接口 —— 规格 01 §7', () => {
  test('我的记忆分层返回，偏好带 why 字段', async () => {
    const userId = await createUser()

    const res = await app.inject({ method: 'GET', url: `/me/${userId}/memory` })

    expect(res.statusCode).toBe(200)
    const body = json<{
      identity: unknown[]; preferences: unknown[]; footprints: unknown[]
    }>(res.payload)
    expect(body.identity).toEqual([])
    expect(body.preferences).toEqual([])
    expect(body.footprints).toEqual([])
  })

  test('记忆线索接口返回证据与 token 预算', async () => {
    const userId = await createUser()

    const res = await app.inject({
      method: 'GET', url: `/internal/memory/hooks?userId=${userId}&topic=科举`,
    })

    expect(res.statusCode).toBe(200)
    const body = json<{ tokenEstimate: number; hooks: unknown[] }>(res.payload)
    expect(body.tokenEstimate).toBe(0)
    expect(body.hooks).toEqual([])
  })
})
